"""GPU fine-tune of a pretrained multilingual encoder on URL strings (URLTran recipe). Ran once on 2026-11-24:
25 min, 7,751 of 7,983 steps, ~1,100 URLs/s, under the 20 GB cap; results in docs/BENCHMARKS.md (`url_mmbert_ft`).

Why: URLTran (arXiv 2106.05256) showed a fine-tuned transformer beats character CNNs (URLNet) at very
low FPR (TPR 86.8% vs 71.2% at 0.01% FPR). We use `jhu-clsp/mmBERT-small` (MIT, ~140M params,
ModernBERT architecture, 1800+ languages incl. Arabic, so it reads Arabic IDNs and transliterated
Gulf keywords), with the same domain-split data, per-source caps and scheme/`www.` normalisation as the
CPU stack, so the results are directly comparable in docs/BENCHMARKS.md.

Command (repo root). It needs a CUDA torch build; to leave the shared CPU venv alone, use a separate one:
    .venv/bin/uv venv --python 3.12 .venv-gpu
    .venv/bin/uv pip install --python .venv-gpu/bin/python "torch==2.13.0" --index-url https://download.pytorch.org/whl/cu130
    .venv/bin/uv pip install --python .venv-gpu/bin/python transformers pandas pyarrow scikit-learn lightgbm tldextract joblib matplotlib scipy pydantic
    CUDA_VISIBLE_DEVICES=0 PYTHONPATH=src:. .venv-gpu/bin/python -m ml.url.train_gpu

Defaults: cap 100k rows per (source, label) -> ~1.67M training URLs, max 96 tokens, batch 256, bf16,
1 epoch, lr 5e-5 with linear decay. Expected on one RTX PRO 6000 (96 GB): ~12-18 GB of GPU memory,
~3-5k URLs/s training -> ~6-10 min per epoch, plus ~3 min scoring val/test/fresh/UAE; ~15-20 min total.
`--epochs 2` roughly doubles it. Outputs:
    data/models/url_encoder/           fine-tuned weights + tokenizer + threshold.json (~560 MB,
                                       under the git-ignored data/ directory)
    ml/results/url_mmbert_ft__*.json   benchmark results in the shared shape, picked up by ml.bench.report
Serving: on CPU it is ~10-20 ms per URL, too slow for the < 5 ms URL layer, so it is meant to run on the
GPU next to the page model, or as a second-opinion score for URLs the stack sends to the page check.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np

from ml.bench.datasets import standard_datasets
from ml.bench.metrics import compute_metrics, threshold_for_fpr
from ml.bench.runner import evaluate
from ml.url.train import cap_per_source, domain_halves, load_training_frame, log
from scamshield.models.url_features import normalize_for_text

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "models" / "url_encoder"  # git-ignored: ~560 MB
BASE = "jhu-clsp/mmBERT-small"
NAME = "url_mmbert_ft"


class EncoderScorer:
    def __init__(self, model, tok, device, max_len: int, batch: int = 1024):
        import torch

        self.torch, self.model, self.tok, self.device, self.max_len, self.batch = torch, model, tok, device, max_len, batch

    def _run(self, urls: list[str]) -> np.ndarray:
        enc = self.tok([normalize_for_text(u) for u in urls], truncation=True, max_length=self.max_len,
                       padding=True, return_tensors="pt").to(self.device)
        with self.torch.inference_mode(), self.torch.autocast("cuda", dtype=self.torch.bfloat16):
            return self.torch.softmax(self.model(**enc).logits.float(), -1)[:, 1].cpu().numpy()

    def score_batch(self, urls) -> np.ndarray:
        urls = list(urls)
        order = np.argsort([len(u) for u in urls])
        out = np.empty(len(urls))
        for i in range(0, len(urls), self.batch):
            idx = order[i : i + self.batch]
            out[idx] = self._run([urls[j] for j in idx])
        return out

    def __call__(self, url: str) -> float:
        return float(self._run([url])[0])


def main() -> None:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "ml/data/processed/urls.parquet"))
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--cap", type=int, default=100_000)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--max-len", type=int, default=96)
    ap.add_argument("--target-fpr", type=float, default=0.002)
    ap.add_argument("--max-train-minutes", type=float, default=25.0, help="stop the training loop after this long")
    ap.add_argument("--eval-only", action="store_true", help="re-score the saved model in data/models/url_encoder")
    ap.add_argument("--max-gpu-gb", type=float, default=20.0, help="cap on this process's share of GPU memory")
    a = ap.parse_args()
    assert torch.cuda.is_available(), "needs a CUDA torch build and a free GPU"
    dev = torch.device("cuda", 0)
    total = torch.cuda.get_device_properties(dev).total_memory / 2**30
    torch.cuda.set_per_process_memory_fraction(min(1.0, a.max_gpu_gb / total), dev)
    torch.manual_seed(0)
    if a.eval_only:
        meta = json.loads((OUT_DIR / "threshold.json").read_text())
        tok = AutoTokenizer.from_pretrained(OUT_DIR)
        model = AutoModelForSequenceClassification.from_pretrained(OUT_DIR).to(dev).eval()
        benchmark(EncoderScorer(model, tok, dev, meta["max_len"]), meta["threshold"], meta["base"])
        return

    df = load_training_frame(Path(a.data))
    tr = cap_per_source(df[df.split == "train"], a.cap, {"phreshphish": int(a.cap * 2.5)})
    tr["norm"] = [normalize_for_text(u) for u in tr.url]
    tr = tr.drop_duplicates("norm").reset_index(drop=True)
    va = cap_per_source(df[df.split == "val"], max(a.cap // 4, 5000), {"phreshphish": a.cap}).reset_index(drop=True)
    del df
    log(f"train {len(tr):,} val {len(va):,}")

    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForSequenceClassification.from_pretrained(a.base, num_labels=2).to(dev)
    y = torch.tensor(tr.label.to_numpy())
    pos = float(y.float().mean())
    loss_fn = torch.nn.CrossEntropyLoss(weight=torch.tensor([0.5 / (1 - pos), 0.5 / pos], device=dev))
    steps = int(math.ceil(len(tr) / a.batch * a.epochs))
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01, fused=True)
    sched = get_linear_schedule_with_warmup(opt, int(0.03 * steps), steps)
    texts = tr.norm.tolist()
    model.train()
    t0 = time.time()
    steps_done = 0
    rng = np.random.default_rng(0)
    perm = np.concatenate([rng.permutation(len(tr)) for _ in range(int(math.ceil(a.epochs)))])
    for step in range(steps):
        idx = perm[step * a.batch : (step + 1) * a.batch]
        enc = tok([texts[i] for i in idx], truncation=True, max_length=a.max_len, padding=True, return_tensors="pt").to(dev)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(**enc).logits
        loss = loss_fn(logits.float(), y[idx].to(dev))
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        steps_done = step + 1
        if time.time() - t0 > a.max_train_minutes * 60:
            log(f"time budget reached at step {step}/{steps}")
            break
        if step % 200 == 0:
            log(f"step {step}/{steps} loss {loss.item():.4f} {(step + 1) * a.batch / (time.time() - t0):.0f} urls/s")
    model.eval()

    scorer = EncoderScorer(model, tok, dev, a.max_len)
    cal = ~domain_halves(va.registered_domain)
    s_va = scorer.score_batch(va.url[cal].tolist())
    thr = threshold_for_fpr(va.label[cal].to_numpy(), s_va, a.target_fpr)
    val = compute_metrics(va.label[cal].to_numpy(), s_va, thr, model=NAME, dataset="val_calibration_half")
    log(f"threshold {thr:.4f} val recall {val['recall']:.4f} fpr {val['fpr']:.4%}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(OUT_DIR)
    tok.save_pretrained(OUT_DIR)
    (OUT_DIR / "threshold.json").write_text(json.dumps({"base": a.base, "threshold": thr, "max_len": a.max_len,
                                                        "val": val, "train_rows": len(tr), "epochs": a.epochs,
                                                        "steps_done": steps_done, "steps_planned": steps}, indent=2))
    benchmark(scorer, thr, a.base)


def benchmark(scorer: "EncoderScorer", thr: float, base: str) -> None:
    for dname, d in standard_datasets().items():
        r = evaluate(NAME, scorer, (dname, d.reset_index(drop=True)), thr, latency_n=500,
                     note=f"{base} fine-tuned on URLs, GPU (bf16); latency is single-URL on GPU")
        log(f"{dname}: P={r['precision']:.4f} R={r['recall']:.4f} FPR={r['fpr']:.4%}")


if __name__ == "__main__":
    main()
