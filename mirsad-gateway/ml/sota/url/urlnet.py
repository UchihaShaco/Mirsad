"""URLNet (Le et al., 2018, arXiv 1802.03162), re-implemented in PyTorch from the official TF1 code
(github.com/Antimalweb/URLNet, TextCNN.py / utils.py) and retrained on our training rows.

Architecture = official `emb_mode 5` (the paper's full model): a character CNN over the first 200 characters
plus a word CNN whose word vectors are the word embedding + the sum of the embeddings of the word's characters
(`<`, chars, `>`; at most 20), words split on special characters with each special character kept as a word
(`delimit_mode 1`). Both branches: 32-dim embeddings, filters 3/4/5/6 x 256, max-over-time pooling, dropout
0.5, a 512-unit projection each; then 1024-512-256-128-2 fully connected, Adam lr 1e-3, as in the code.
Deviations (for the time box, stated in the results): the string is cut to 200 characters before the words are
split (the official code cuts words to 200 words and characters to 200 separately), batch 256 instead of 128,
and training stops at `--epochs` / `--max-minutes` (official: 5 epochs). No pretrained weights were released.

    nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.urlnet [--paper-check]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter

import numpy as np

from ml.sota.url.common import (MODELS_DIR, TARGET_VAL_FPR, batched, calibrate, evaluate_all, gpu_guard,
                                grambeddings_dataset, limit_threads, load_train, load_val, measure_latency, train_loop,
                                write_paper_check)
from ml.url.train import log
from scamshield.models.url_features import normalize_for_text

limit_threads()
import torch  # noqa: E402
from torch import nn  # noqa: E402

NAME = "sota_url_urlnet"
MAX_CHARS, MAX_SUB, EMB, FILTERS = 200, 20, 32, (3, 4, 5, 6)
TOKEN = re.compile(r"[\w'\-]+|[^\w'\-]")  # TF VocabularyProcessor words + every special char as a word
PAD, UNK, BOW, EOW = 0, 1, 2, 3  # char ids; real characters start at 4


class Vocab:
    def __init__(self, texts: list[str], max_chars: int = 254):
        chars = Counter()
        words = Counter()
        for t in texts:
            t = t[:MAX_CHARS]
            chars.update(t)
            words.update(w for w in TOKEN.findall(t) if len(w) + 2 <= MAX_SUB)
        self.char = {c: i + 4 for i, (c, _) in enumerate(chars.most_common(max_chars - 4))}
        self.word = {w: i + 2 for i, w in enumerate(words)}  # 0 pad, 1 <UNKNOWN>; official min_word_freq = 1

    def encode(self, texts: list[str]) -> tuple[np.ndarray, ...]:
        n = len(texts)
        chars = np.zeros((n, MAX_CHARS), np.uint8)
        words = np.zeros((n, MAX_CHARS), np.int32)
        start = np.zeros((n, MAX_CHARS), np.uint8)
        length = np.zeros((n, MAX_CHARS), np.uint8)
        for i, t in enumerate(texts):
            t = t[:MAX_CHARS]
            chars[i, : len(t)] = [self.char.get(c, UNK) for c in t]
            pos = 0
            for j, w in enumerate(TOKEN.findall(t)):
                words[i, j] = self.word.get(w, UNK) if len(w) + 2 <= MAX_SUB else UNK
                start[i, j], length[i, j] = pos, len(w)
                pos += len(w)
        return chars, words, start, length


class URLNet(nn.Module):
    def __init__(self, n_chars: int, n_words: int):
        super().__init__()
        self.char_seq = nn.Embedding(n_chars, EMB, padding_idx=PAD)
        self.char_sub = nn.Embedding(n_chars, EMB, padding_idx=PAD)
        self.word = nn.Embedding(n_words, EMB, padding_idx=PAD)
        for e in (self.char_seq, self.char_sub, self.word):
            nn.init.uniform_(e.weight, -1.0, 1.0)
            e.weight.data[PAD] = 0
        self.conv_c = nn.ModuleList(nn.Conv1d(EMB, 256, k) for k in FILTERS)
        self.conv_w = nn.ModuleList(nn.Conv1d(EMB, 256, k) for k in FILTERS)
        self.drop = nn.Dropout(0.5)
        self.proj_c, self.proj_w = nn.Linear(1024, 512), nn.Linear(1024, 512)
        self.head = nn.Sequential(nn.Linear(1024, 512), nn.ReLU(), nn.Linear(512, 256), nn.ReLU(),
                                  nn.Linear(256, 128), nn.ReLU(), nn.Linear(128, 2))

    @staticmethod
    def _cnn(x: torch.Tensor, convs) -> torch.Tensor:
        x = x.transpose(1, 2)
        if x.shape[-1] < max(FILTERS):
            x = nn.functional.pad(x, (0, max(FILTERS) - x.shape[-1]))
        return torch.cat([torch.relu(c(x)).amax(-1) for c in convs], 1)

    def forward(self, chars, words, start, length):
        k = torch.arange(MAX_SUB, device=chars.device)
        pos = (start.long().unsqueeze(-1) + k - 1).clamp(0, chars.shape[1] - 1)
        sub = torch.gather(chars.long().unsqueeze(1).expand(-1, words.shape[1], -1), 2, pos)
        ln = length.long().unsqueeze(-1)
        sub = torch.where(k == 0, BOW, torch.where(k <= ln, sub, torch.where(k == ln + 1, EOW, PAD)))
        sub = torch.where((words > 0).unsqueeze(-1), sub, PAD)
        w = self.word(words.long()) + self.char_sub(sub).sum(2)
        hc = self.proj_c(self.drop(self._cnn(self.char_seq(chars.long()), self.conv_c)))
        hw = self.proj_w(self.drop(self._cnn(w, self.conv_w)))
        return self.head(torch.cat([hw, hc], 1))


def trim(arrays: tuple[np.ndarray, ...], dev) -> tuple[torch.Tensor, ...]:
    """Cut the padded columns that are empty in this batch, then move to the device."""
    c, w, s, l = arrays
    nc = max(int((c > 0).sum(1).max()), max(FILTERS))
    nw = max(int((w > 0).sum(1).max()), max(FILTERS))
    return (torch.from_numpy(c[:, :nc]).to(dev), torch.from_numpy(w[:, :nw]).to(dev),
            torch.from_numpy(s[:, :nw]).to(dev), torch.from_numpy(l[:, :nw]).to(dev))


class Scorer:
    def __init__(self, model: URLNet, vocab: Vocab, dev):
        self.model, self.vocab, self.dev = model, vocab, dev

    @torch.inference_mode()
    def __call__(self, texts: list[str]) -> np.ndarray:
        logits = self.model(*trim(self.vocab.encode(texts), self.dev))
        return torch.softmax(logits.float(), -1)[:, 1].cpu().numpy()

    def one(self, url: str) -> float:
        return float(self([normalize_for_text(url)])[0])


def train(texts: list[str], y: np.ndarray, a, dev) -> tuple[URLNet, Vocab, dict]:
    vocab = Vocab(texts)
    log(f"vocab: {len(vocab.char)} chars, {len(vocab.word):,} words")
    X = vocab.encode(texts)
    model = URLNet(len(vocab.char) + 4, len(vocab.word) + 2).to(dev)
    info = train_loop(model, lambda idx: trim(tuple(x[idx] for x in X), dev), y, dev,
                      epochs=a.epochs, batch=a.batch, lr=1e-3, max_minutes=a.max_minutes)
    return model, vocab, info


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--max-minutes", type=float, default=25.0)
    ap.add_argument("--paper-check", action="store_true", help="train / test on the GramBeddings dataset split")
    a = ap.parse_args()
    torch.manual_seed(0)
    dev = gpu_guard()
    tr = grambeddings_dataset("Train") if a.paper_check else load_train()
    model, vocab, info = train(tr.norm.tolist(), tr.label.to_numpy(), a, dev)
    n_train = len(tr)
    del tr
    score = batched(Scorer(model, vocab, dev), 2048)
    if a.paper_check:
        write_paper_check(f"{NAME}_gb_split", score(grambeddings_dataset("Test").norm.tolist()),
                          f"URLNet re-implementation trained on the GramBeddings train split ({n_train:,} raw URLs, "
                          f"{info['epochs_done']:.2f} epochs); harness check against published numbers.")
        return
    va = load_val()
    thr = calibrate(va, score(va.norm.tolist()))
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "char": vocab.char, "word": vocab.word, "threshold": thr},
               MODELS_DIR / f"{NAME}.pt")
    lat_gpu = measure_latency(Scorer(model, vocab, dev).one)
    model_cpu = URLNet(len(vocab.char) + 4, len(vocab.word) + 2)
    model_cpu.load_state_dict({k: v.cpu() for k, v in model.state_dict().items()})
    torch.set_num_threads(1)
    lat_cpu = measure_latency(Scorer(model_cpu.eval(), vocab, torch.device("cpu")).one)
    torch.set_num_threads(8)
    note = (f"URLNet (char + char-level word CNN, emb_mode 5), re-implemented in PyTorch from the official code, "
            f"retrained on our {n_train:,} training URLs for {info['epochs_done']:.2f} epochs "
            f"({info['train_minutes']:.0f} min, batch {a.batch}); threshold at {TARGET_VAL_FPR:.1%} val FPR. No released weights.")
    evaluate_all(NAME, score, thr, note, lat_cpu, lat_gpu)
    log(json.dumps({**info, "threshold": thr, "lat_cpu": lat_cpu, "lat_gpu": lat_gpu}))


if __name__ == "__main__":
    main()
