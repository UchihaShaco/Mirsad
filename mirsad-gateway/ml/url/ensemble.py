"""Ensemble of the served CPU stack and the fine-tuned URL transformer (GPU), compared at the stack's FPR.

score = w * logit(stack raw) + (1 - w) * logit(transformer); w is chosen on the calibration half of
validation and the threshold is set so the ensemble's validation FPR equals the stack's own validation
FPR, so the comparison is at the same false-positive rate. Writes ml/results/url_ensemble__*.json.

    CUDA_VISIBLE_DEVICES=0 PYTHONPATH=src:. nice -n 19 .venv-gpu/bin/python -m ml.url.ensemble
"""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np

from ml.bench.datasets import standard_datasets
from ml.bench.metrics import compute_metrics, threshold_for_fpr
from ml.bench.runner import evaluate
from ml.url.train import cap_per_source, domain_halves, load_training_frame, log
from ml.url.train_gpu import OUT_DIR, EncoderScorer
from scamshield.models.url_model import UrlScorer

ROOT = Path(__file__).resolve().parents[2]
NAME = "url_ensemble"


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


class Ensemble:
    def __init__(self, stack: UrlScorer, enc: EncoderScorer, w: float):
        self.stack, self.enc, self.w = stack, enc, w

    def combine(self, s_raw, s_enc):
        return 1 / (1 + np.exp(-(self.w * logit(s_raw) + (1 - self.w) * logit(s_enc))))

    def score_batch(self, urls):
        urls = list(urls)
        return self.combine(self.stack.raw_scores(urls), self.enc.score_batch(urls))

    def __call__(self, url: str) -> float:
        return float(self.combine(self.stack.raw_scores([url]), np.array([self.enc(url)]))[0])


def main() -> None:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    dev = torch.device("cuda", 0)
    meta = json.loads((OUT_DIR / "threshold.json").read_text())
    enc = EncoderScorer(AutoModelForSequenceClassification.from_pretrained(OUT_DIR).to(dev).eval(),
                        AutoTokenizer.from_pretrained(OUT_DIR), dev, meta["max_len"])
    stack = UrlScorer(joblib.load(ROOT / "ml" / "artifacts" / "url_stack.joblib"))

    df = load_training_frame(ROOT / "ml" / "data" / "processed" / "urls.parquet")
    va = cap_per_source(df[df.split == "val"], 25_000, {"phreshphish": 100_000})
    del df
    va = va[~domain_halves(va.registered_domain)].reset_index(drop=True)  # calibration half, as in training
    y = va.label.to_numpy()
    urls = va.url.tolist()
    s_stack_cal = stack.score_batch(urls)
    stack_fpr = compute_metrics(y, s_stack_cal, stack.threshold)["fpr"]
    raw, s_enc = stack.raw_scores(urls), enc.score_batch(urls)
    log(f"stack val FPR at its threshold: {stack_fpr:.4%}")
    best = None
    for w in (0.0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0):
        e = Ensemble(stack, enc, w)
        p = e.combine(raw, s_enc)
        thr = threshold_for_fpr(y, p, stack_fpr)
        m = compute_metrics(y, p, thr)
        log(f"w={w}: val recall {m['recall']:.4f} at FPR {m['fpr']:.4%} (thr {thr:.4f})")
        if best is None or m["recall"] > best[2]:
            best = (w, thr, m["recall"])
    w, thr, _ = best
    log(f"chosen w={w} thr={thr:.4f}")
    e = Ensemble(stack, enc, w)
    for dname, d in standard_datasets().items():
        r = evaluate(NAME, e, (dname, d.reset_index(drop=True)), thr, latency_n=300,
                     note=f"w={w} * stack + {1 - w:.2f} * transformer (logit average), threshold at the stack's "
                          f"validation FPR; transformer on GPU")
        log(f"{dname}: P={r['precision']:.4f} R={r['recall']:.4f} FPR={r['fpr']:.4%} FP={r['fp']}")


if __name__ == "__main__":
    main()
