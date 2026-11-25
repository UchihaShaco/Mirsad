"""Public pretrained page / text classifiers as baselines, on the same test rows as our models (CPU).

  * ealvaradob/bert-finetuned-phishing                         - BERT-large, raw HTML input
                                                                 (its training set includes the Mendeley pages
                                                                 that are in our train split, not our test split)
  * huynq3Cyradar/bert-large-finetuned-phishing-webpage-version - multilingual BERT-base, page text input
  * Horizon-Labs/phishing-scam-detector-base                   - multilingual ModernBERT message classifier
                                                                 (Arabic-capable), page text input, P(not legitimate)

All inputs are truncated to 512 tokens. Rows: every `pages_test` page plus the SYNTHETIC UAE set.
Bulk scoring runs on the GPU when one is visible (run it from .venv-gpu), else on 6 CPU threads.
Per-page latency is recorded one page at a time on one CPU thread (the setting our page model is
measured in) and, when available, on the GPU.

    .venv/bin/python -m ml.page.baselines_hf
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "6")

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from selectolax.lexbor import LexborHTMLParser

from ml.page.corpus import PROCESSED

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "ml" / "page" / "cache"
SYNTHETIC = ROOT / "ml" / "data" / "synthetic_uae" / "pages.parquet"
MAXLEN = 512
LAT_N = 20


def visible_text(html: str) -> str:
    t = LexborHTMLParser((html or "")[:300_000])
    title = t.css_first("title")
    t.strip_tags(["script", "style", "noscript", "template", "svg", "head"])
    body = t.body.text(separator=" ", strip=True) if t.body is not None else ""
    return " ".join(((title.text(strip=True) if title else "") + " " + body).split())[:4000]


def load_rows() -> pd.DataFrame:
    """Every pages_test row plus the SYNTHETIC UAE set, with raw HTML."""
    t = pq.read_table(PROCESSED, columns=["source_id", "label", "split", "url", "html"],
                      filters=[("split", "==", "test")]).to_pandas()
    syn = pd.read_parquet(SYNTHETIC)[["source_id", "label", "url", "html"]]
    syn["split"] = "synthetic_uae"
    return pd.concat([t, syn], ignore_index=True)


class TorchClassifier:
    def __init__(self, model_id: str, pos: list[int], device: str):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.torch = torch
        self.device = device
        self.tok = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_id).eval().to(device)
        self.pos = pos

    def to(self, device: str) -> "TorchClassifier":
        self.device = device
        self.model.to(device)
        return self

    def __call__(self, texts: list[str]) -> np.ndarray:
        with self.torch.inference_mode():
            enc = self.tok(texts, truncation=True, max_length=MAXLEN, padding=True, return_tensors="pt").to(self.device)
            p = self.torch.softmax(self.model(**enc).logits.float(), -1).cpu().numpy()
        if self.device == "cuda":
            self.torch.cuda.synchronize()
        return p[:, self.pos].sum(1)


BASELINES = {
    "hf_ealvaradob_bert_large": dict(id="ealvaradob/bert-finetuned-phishing", pos=[1], input="html"),
    "hf_huynq3_mbert_webpage": dict(id="huynq3Cyradar/bert-large-finetuned-phishing-webpage-version",
                                    pos=[1], input="text"),
    # the int8 ONNX export has no fast GPU kernels, so the PyTorch weights are used
    "hf_horizon_mmbert_scam": dict(id="Horizon-Labs/phishing-scam-detector-base", pos=[1, 2],
                                   input="text"),
}


def _timed(clf, texts: list[str]) -> list[float]:
    out = []
    for txt in texts:
        t = time.perf_counter()
        clf([txt])
        out.append((time.perf_counter() - t) * 1000)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=list(BASELINES))
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--max-rows", type=int, default=0, help="stratified sample of pages_test (0 = all)")
    args = ap.parse_args()
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    rows = load_rows()
    if args.max_rows:
        test = rows[rows["split"] == "test"]
        test = pd.concat([g.sample(n=min(len(g), args.max_rows // 2), random_state=0) for _, g in test.groupby("label")])
        rows = pd.concat([test, rows[rows["split"] != "test"]], ignore_index=True)
    rows["text"] = [visible_text(h) for h in rows["html"]]
    rows["html"] = rows["html"].fillna("").str.slice(0, 20_000)  # 512 tokens never reach further
    print("rows", rows.groupby("split").size().to_dict(), "device", device, flush=True)
    for name in args.only:
        cfg = BASELINES[name]
        torch.set_num_threads(args.threads)
        clf = TorchClassifier(cfg["id"], cfg["pos"], device)
        inputs = rows[cfg["input"]].fillna("").tolist()
        t0 = time.time()
        scores = np.concatenate([clf(inputs[i : i + args.batch]) for i in range(0, len(inputs), args.batch)])
        bulk_s = time.time() - t0
        sample = rows[rows["split"] == "test"][cfg["input"]].sample(n=LAT_N, random_state=0).tolist()
        lat_dev = _timed(clf, sample) if device == "cuda" else []
        # one CPU core, batch 1 - the setting our page model is measured in
        torch.set_num_threads(1)
        clf.to("cpu")
        lat_cpu = _timed(clf, sample[:10])
        pd.DataFrame({"source_id": rows["source_id"], "score": scores}).to_parquet(
            CACHE / f"hf_scores__{name}.parquet", index=False)
        meta = {"model_id": cfg["id"], "input": cfg["input"], "threshold": 0.5, "max_tokens": MAXLEN,
                "latencies_ms": lat_cpu, "latency_note": "1 CPU thread, batch 1, 10 pages",
                "latencies_ms_gpu": lat_dev, "n_scored": int(len(rows)), "bulk_seconds": bulk_s,
                "bulk_device": device, "scored_splits": rows.groupby("split").size().to_dict()}
        (CACHE / f"hf_meta__{name}.json").write_text(json.dumps(meta, indent=2))
        print(name, f"{len(rows)} rows in {bulk_s:.0f}s on {device}; 1-core p50 {np.median(lat_cpu):.0f} ms; "
              f"GPU p50 {np.median(lat_dev) if lat_dev else float('nan'):.1f} ms", flush=True)
        del clf
        if device == "cuda":
            torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
