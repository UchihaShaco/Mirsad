"""GramBeddings (Bozkir et al., Computers & Security 2023), re-implemented in PyTorch from the official TF2 code
(github.com/fcdalgic/GramBeddings: Model.py, NGramSequenceTransformer.py, train.py defaults) and retrained on
our training rows.

Four parallel branches over the URL string: characters (fixed 95-symbol alphabet, 95-dim embedding) and
character 4-, 5- and 6-grams (the top 160,000 n-grams per n by chi-square over sublinear TF-IDF, 15-dim
embeddings, out-of-vocabulary id). Each sequence keeps its last 128 items (Keras `pad_sequences` default).
Each branch: Conv1D(64, 9) -> pooling -> Conv1D(128, 9) -> BatchNorm -> SpatialDropout(0.2) -> BiLSTM(128)
-> additive attention (width 10) on the final hidden state. Concatenate -> Dense(256, ReLU) -> Dropout(0.2)
-> sigmoid; binary cross-entropy, Adam lr 1e-3.
Deviations: the official code's first pooling is `GlobalMaxPooling1D(data_format="channels_first")` followed
by another Conv1D, which does not compose as written; we use max pooling over time (size 2), the usual CNN-LSTM
reading of the paper's figure. The n-gram ranking uses a 300k-row sample of the training rows (TF-IDF over all
2M rows does not fit the memory budget). Batch 512 instead of 128, epochs capped by `--max-minutes`.
The authors released no trained weights.

    nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.grambeddings --prep   # CPU
    nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.grambeddings          # GPU
Add `--paper-check` to both to train / test on the GramBeddings dataset's own split instead.
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from ml.sota.url.common import (MODELS_DIR, TARGET_VAL_FPR, WORK, batched, calibrate, evaluate_all, gpu_guard,
                                grambeddings_dataset, limit_threads, load_train, load_val, measure_latency, train_loop,
                                write_paper_check)
from ml.sota.url.data import PROTOCOL
from ml.url.train import log
from scamshield.models.url_features import normalize_for_text

limit_threads()
import torch  # noqa: E402
from torch import nn  # noqa: E402

NAME = "sota_url_grambeddings"
NGRAMS, TOP_K, SEQ, CHAR_DIM, NGRAM_DIM, RNN, ATTN = (4, 5, 6), 160_000, 128, 95, 15, 128, 10
ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789,;.!?:'\"/\\|_@#$%^&*~`+-=<>()[]{}"
CHAR_ID = {c: i + 1 for i, c in enumerate(ALPHABET)}
PREP = WORK / "grambeddings"


def select_ngrams(texts: list[str], labels: np.ndarray, n: int) -> list[str]:
    from sklearn.feature_selection import SelectKBest, chi2
    from sklearn.feature_extraction.text import TfidfVectorizer

    vec = TfidfVectorizer(analyzer="char", ngram_range=(n, n), sublinear_tf=True, lowercase=False, dtype=np.float32)
    X = vec.fit_transform(texts)
    sel = SelectKBest(chi2, k=min(TOP_K, X.shape[1])).fit(X, labels)
    names = vec.get_feature_names_out()
    keep = np.flatnonzero(sel.get_support())
    return [names[i] for i in keep[np.argsort(sel.scores_[keep], kind="stable")]]  # ascending score, as official


def encode_chars(texts: list[str]) -> np.ndarray:
    out = np.zeros((len(texts), SEQ), np.uint8)
    oov = len(ALPHABET) + 1
    for i, t in enumerate(texts):
        ids = [CHAR_ID.get(c, oov) for c in t][-SEQ:]
        out[i, : len(ids)] = ids
    return out


def encode_ngrams(texts: list[str], vocab: dict[str, int], n: int) -> np.ndarray:
    out = np.zeros((len(texts), SEQ), np.int32)
    oov = len(vocab) + 1
    for i, t in enumerate(texts):
        ids = [vocab.get(t[j : j + n], oov) for j in range(max(len(t) - n + 1, 0))][-SEQ:]
        out[i, : len(ids)] = ids
    return out


def _training_rows(paper_check: bool):
    return grambeddings_dataset("Train") if paper_check else load_train()


def _prep_dir(paper_check: bool):
    return PREP / ("gb_split" if paper_check else "ours")


def _prep_one(n: int, paper_check: bool) -> int:
    tr = _training_rows(paper_check)
    sample = tr.sample(min(PROTOCOL["grambeddings_ngram_selection_rows"], len(tr)), random_state=PROTOCOL["sample_seed"])
    grams = select_ngrams(sample.norm.tolist(), sample.label.to_numpy(), n)
    out = _prep_dir(paper_check)
    (out / f"ngrams_{n}.json").write_text(json.dumps(grams))
    np.save(out / f"train_{n}.npy", encode_ngrams(tr.norm.tolist(), {g: i + 1 for i, g in enumerate(grams)}, n))
    return n


def prep(paper_check: bool) -> None:
    out = _prep_dir(paper_check)
    out.mkdir(parents=True, exist_ok=True)
    tr = _training_rows(paper_check)
    np.save(out / "train_char.npy", encode_chars(tr.norm.tolist()))
    np.save(out / "train_y.npy", tr.label.to_numpy())
    del tr
    with ProcessPoolExecutor(3) as ex:
        for n in ex.map(_prep_one, NGRAMS, [paper_check] * len(NGRAMS)):
            log(f"n={n} encoded")


class Attention(nn.Module):
    """Bahdanau-style attention of the official `ZhangAttention` layer."""

    def __init__(self, dim: int):
        super().__init__()
        self.w1, self.w2, self.v = nn.Linear(dim, ATTN), nn.Linear(dim, ATTN), nn.Linear(ATTN, 1)

    def forward(self, feats, hidden):
        a = torch.softmax(self.v(torch.tanh(self.w1(feats) + self.w2(hidden).unsqueeze(1))), dim=1)
        return (a * feats).sum(1)


class Branch(nn.Module):
    def __init__(self, vocab: int, dim: int):
        super().__init__()
        self.emb = nn.Embedding(vocab, dim, padding_idx=0)
        self.conv1, self.conv2 = nn.Conv1d(dim, 64, 9), nn.Conv1d(64, 128, 9)
        self.bn, self.drop = nn.BatchNorm1d(128), nn.Dropout1d(0.2)
        self.lstm = nn.LSTM(128, RNN, batch_first=True, bidirectional=True)
        self.attn = Attention(2 * RNN)

    def forward(self, x):
        h = torch.relu(self.conv1(self.emb(x.long()).transpose(1, 2)))
        h = self.drop(self.bn(torch.relu(self.conv2(nn.functional.max_pool1d(h, 2)))))
        seq, (hn, _) = self.lstm(h.transpose(1, 2))
        return self.attn(seq, torch.cat([hn[0], hn[1]], 1))


class GramBeddings(nn.Module):
    def __init__(self):
        super().__init__()
        self.branches = nn.ModuleList([Branch(len(ALPHABET) + 2, CHAR_DIM)] +
                                      [Branch(TOP_K + 2, NGRAM_DIM) for _ in NGRAMS])
        self.head = nn.Sequential(nn.Linear(4 * 2 * RNN, 2 * RNN), nn.ReLU(), nn.Dropout(0.2), nn.Linear(2 * RNN, 1))

    def forward(self, *xs):
        return self.head(torch.cat([b(x) for b, x in zip(self.branches, xs)], 1))


class Scorer:
    def __init__(self, model: GramBeddings, vocabs: list[dict[str, int]], dev):
        self.model, self.vocabs, self.dev = model, vocabs, dev

    @torch.inference_mode()
    def __call__(self, texts: list[str]) -> np.ndarray:
        xs = [encode_chars(texts)] + [encode_ngrams(texts, v, n) for v, n in zip(self.vocabs, NGRAMS)]
        out = self.model(*(torch.from_numpy(x).to(self.dev) for x in xs))
        return torch.sigmoid(out.float().squeeze(-1)).cpu().numpy()

    def one(self, url: str) -> float:
        return float(self([normalize_for_text(url)])[0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prep", action="store_true", help="CPU stage: select n-grams and encode the training rows")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--max-minutes", type=float, default=25.0)
    ap.add_argument("--paper-check", action="store_true", help="train / test on the GramBeddings dataset split")
    a = ap.parse_args()
    if a.prep:
        prep(a.paper_check)
        return
    torch.manual_seed(0)
    dev = gpu_guard()
    d = _prep_dir(a.paper_check)
    X = [np.load(d / "train_char.npy")] + [np.load(d / f"train_{n}.npy") for n in NGRAMS]
    y = np.load(d / "train_y.npy")
    vocabs = [{g: i + 1 for i, g in enumerate(json.loads((d / f"ngrams_{n}.json").read_text()))} for n in NGRAMS]
    model = GramBeddings().to(dev)
    info = train_loop(model, lambda idx: tuple(torch.from_numpy(x[idx]).to(dev) for x in X), y, dev,
                      epochs=a.epochs, batch=a.batch, lr=1e-3, max_minutes=a.max_minutes, loss="bce")
    del X
    score = batched(Scorer(model, vocabs, dev), 2048)
    if a.paper_check:
        write_paper_check(f"{NAME}_gb_split", score(grambeddings_dataset("Test").norm.tolist()),
                          f"GramBeddings re-implementation trained on the GramBeddings train split ({len(y):,} raw "
                          f"URLs, {info['epochs_done']:.2f} epochs); harness check against the paper's 98.27% accuracy.")
        return
    va = load_val()
    thr = calibrate(va, score(va.norm.tolist()))
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "threshold": thr}, MODELS_DIR / f"{NAME}.pt")
    lat_gpu = measure_latency(Scorer(model, vocabs, dev).one)
    model_cpu = GramBeddings()
    model_cpu.load_state_dict({k: v.cpu() for k, v in model.state_dict().items()})
    torch.set_num_threads(1)
    lat_cpu = measure_latency(Scorer(model_cpu.eval(), vocabs, torch.device("cpu")).one)
    torch.set_num_threads(8)
    note = (f"GramBeddings (char + 4/5/6-gram CNN-BiLSTM-attention), re-implemented in PyTorch from the official "
            f"code, retrained on our {len(y):,} training URLs for {info['epochs_done']:.2f} epochs "
            f"({info['train_minutes']:.0f} min); threshold at {TARGET_VAL_FPR:.1%} val FPR. No released weights.")
    evaluate_all(NAME, score, thr, note, lat_cpu, lat_gpu)
    log(json.dumps({**info, "threshold": thr, "lat_cpu": lat_cpu, "lat_gpu": lat_gpu}))


if __name__ == "__main__":
    main()
