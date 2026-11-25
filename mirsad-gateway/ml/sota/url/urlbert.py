"""URLBERT (Li et al., 2024, arXiv 2402.11495): the authors' released pre-trained encoder (BERT-base pre-trained
on URLs with MLM + contrastive + virtual-adversarial objectives, URL-specific 5,000-token vocabulary), fine-tuned
on our training rows with the authors' phishing fine-tuning recipe (finetune/phishing/phshing.ipynb in
github.com/Davidup1/URLBERT): [CLS] of the last layer -> dropout 0.1 -> Linear(768, 2), cross-entropy,
AdamW lr 2e-5, weight decay 1e-4, inputs tokenised with their vocab (lower-cased), at most 200 tokens.
Deviations: bf16, class-balanced loss as for every other method, and one pass capped by
`--max-minutes` instead of 5 epochs. The authors released no fine-tuned phishing classifier, so there is no
"as released" row.

Weights: Google Drive folder linked from bert_model/README.md, downloaded with
`gdown --folder <link>` into ml/sota/url/vendor/urlbert_weights/URLBERT/ (urlBERT.pt + vocab.txt); loaded with
`torch.load(weights_only=True)`, which refuses pickled code.

    nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.urlbert
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from ml.sota.url.common import (MODELS_DIR, batched, calibrate, evaluate_all, gpu_guard, limit_threads, load_train,
                                load_val, measure_latency, train_loop)
from ml.sota.url.data import PROTOCOL
from ml.url.train import log
from scamshield.models.url_features import normalize_for_text

limit_threads()
import torch  # noqa: E402
from torch import nn  # noqa: E402

NAME = "sota_url_urlbert_ft"
VENDOR = Path(__file__).resolve().parent / "vendor"
WEIGHTS = VENDOR / "urlbert_weights" / "URLBERT"
CONFIG = VENDOR / "URLBERT" / "bert_config"
MAX_LEN = 200


def load_encoder():
    from transformers import AutoConfig, AutoModelForMaskedLM, BertTokenizerFast

    config = AutoConfig.from_pretrained(CONFIG, hidden_dropout_prob=0.1, vocab_size=5000)
    mlm = AutoModelForMaskedLM.from_config(config)
    missing = mlm.load_state_dict(torch.load(WEIGHTS / "urlBERT.pt", map_location="cpu", weights_only=True), strict=False)
    assert not [k for k in missing.missing_keys if k.startswith("bert.encoder")], missing
    return mlm.bert, BertTokenizerFast(str(WEIGHTS / "vocab.txt"), do_lower_case=True)


class URLBERTClassifier(nn.Module):
    def __init__(self, bert):
        super().__init__()
        self.bert, self.drop, self.cls = bert, nn.Dropout(0.1), nn.Linear(768, 2)

    def forward(self, ids, mask):
        with torch.autocast(ids.device.type, dtype=torch.bfloat16, enabled=ids.device.type == "cuda"):
            h = self.bert(input_ids=ids, attention_mask=mask).last_hidden_state[:, 0]
            return self.cls(self.drop(h))


class Scorer:
    def __init__(self, model, tok, dev):
        self.model, self.tok, self.dev = model, tok, dev

    def encode(self, texts: list[str]):
        enc = self.tok(texts, truncation=True, max_length=MAX_LEN, padding=True, return_tensors="pt")
        return enc["input_ids"].to(self.dev), enc["attention_mask"].to(self.dev)

    @torch.inference_mode()
    def __call__(self, texts: list[str]) -> np.ndarray:
        return torch.softmax(self.model(*self.encode(texts)).float(), -1)[:, 1].cpu().numpy()

    def one(self, url: str) -> float:
        return float(self([normalize_for_text(url)])[0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--max-minutes", type=float, default=25.0)
    a = ap.parse_args()
    torch.manual_seed(0)
    dev = gpu_guard()
    bert, tok = load_encoder()
    model = URLBERTClassifier(bert).to(dev)
    tr = load_train()
    texts, y = tr.norm.tolist(), tr.label.to_numpy()
    del tr
    enc = Scorer(model, tok, dev).encode
    info = train_loop(model, lambda idx: enc([texts[i] for i in idx]), y, dev, epochs=a.epochs, batch=a.batch,
                      lr=2e-5, max_minutes=a.max_minutes, weight_decay=1e-4)
    score = batched(Scorer(model, tok, dev), 256)
    va = load_val()
    thr = calibrate(va, score(va.norm.tolist()))
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "threshold": thr}, MODELS_DIR / f"{NAME}.pt")
    lat_gpu = measure_latency(Scorer(model, tok, dev).one)
    cpu_model = URLBERTClassifier(load_encoder()[0])
    cpu_model.load_state_dict({k: v.cpu() for k, v in model.state_dict().items()})
    torch.set_num_threads(1)
    lat_cpu = measure_latency(Scorer(cpu_model.eval(), tok, torch.device("cpu")).one, n=PROTOCOL["latency_urls_bert_cpu"])
    torch.set_num_threads(8)
    note = (f"URLBERT: authors' released URL-pre-trained BERT-base, fine-tuned with their phishing recipe on our "
            f"{len(y):,} training URLs for {info['epochs_done']:.2f} epochs ({info['train_minutes']:.0f} min, "
            f"bf16); threshold at {PROTOCOL['target_val_fpr']:.1%} val FPR. CPU latency on "
            f"{PROTOCOL['latency_urls_bert_cpu']} URLs (fp32).")
    evaluate_all(NAME, score, thr, note, lat_cpu, lat_gpu)
    log(json.dumps({**info, "threshold": thr, "lat_cpu": lat_cpu, "lat_gpu": lat_gpu}))


if __name__ == "__main__":
    main()
