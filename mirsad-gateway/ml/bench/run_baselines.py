"""Score the reference systems and public pretrained models on the standard datasets.

Run from the repo root:  .venv/bin/python -m ml.bench.run_baselines [--only hf_urlbert_tiny_v4 blocklist ...]

Slow transformer models are scored on a fixed random sample of each dataset (the sample size is
recorded in the result's `note`). Their native decision threshold (0.5) is used; the threshold-free
columns (ROC-AUC, PR-AUC, recall at 0.1% / 1% FPR) compare them with ours on equal terms.
"""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("OMP_NUM_THREADS", "8")

import pandas as pd

from ml.bench.baselines import HF_BASELINES, BlocklistScorer, ConstantScorer
from ml.bench.datasets import PROCESSED, standard_datasets
from ml.bench.runner import RESULTS_DIR, evaluate, write_result


def _show(r: dict) -> None:
    print(f"{r['model']:26s} {r['dataset']:34s} n={r['n']:7d} P={r['precision']:.4f} R={r['recall']:.4f} "
          f"FPR={r['fpr']:.4%} AUC={r['roc_auc'] if r['roc_auc'] is None else round(r['roc_auc'], 4)} "
          f"p50={r['latency_ms_p50']}", flush=True)


URL_DATASETS = ("urls_test", "urls_test_noshort", "urls_test_nohf", "urls_test_deeplegit_vs_barephish", "urls_fresh_test",
                "urls_fresh_test_fullurl", "urls_fresh_test_domainonly", "uae_legit", "uae_legit_v3_new", "urls_test_shorteners")


def _keep_cpu_latency(r: dict) -> None:
    """Move the GPU latency to its own fields and keep the CPU single-URL latency of the earlier run."""
    r["latency_gpu_ms_p50"], r["latency_gpu_ms_p95"] = r["latency_ms_p50"], r["latency_ms_p95"]
    # any CPU run of the same model on a URL dataset (page-model results share model names but take HTML input)
    candidates = [RESULTS_DIR / f"{r['model']}__{r['dataset']}.json"]
    candidates += [RESULTS_DIR / f"{r['model']}__{d}.json" for d in URL_DATASETS]
    r["latency_ms_p50"] = r["latency_ms_p95"] = None
    for p in candidates:
        cpu = json.loads(p.read_text()) if p.exists() else {}
        measured_on_cpu = "latency_gpu_ms_p50" not in cpu or cpu.get("latency_source") == "cpu"
        if cpu.get("latency_ms_p50") is not None and measured_on_cpu:
            r["latency_ms_p50"], r["latency_ms_p95"] = cpu["latency_ms_p50"], cpu["latency_ms_p95"]
            r["latency_source"] = "cpu"
            break
    r["note"] += "; latency columns = CPU single URL, one thread (GPU single-URL latency in latency_gpu_ms_*)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="subset of: majority, blocklist, " + ", ".join(HF_BASELINES))
    ap.add_argument("--sample-scale", type=float, default=1.0, help="multiply the per-model sample sizes")
    ap.add_argument("--datasets", nargs="*", help="subset of the standard dataset names")
    ap.add_argument("--device", default="cpu", help="cuda: score transformer baselines on the GPU over the full "
                    "datasets; the reported per-URL latency stays the earlier CPU measurement (GPU latency is added)")
    a = ap.parse_args()
    want = set(a.only) if a.only else None
    datasets = standard_datasets()
    if a.datasets:
        datasets = {k: v for k, v in datasets.items() if k in a.datasets}

    if want is None or "majority" in want:
        train_pos = pd.read_parquet(PROCESSED / "urls.parquet", columns=["label", "split"])
        majority = float(train_pos[train_pos.split == "train"].label.mean() >= 0.5)
        for name, df in datasets.items():
            _show(evaluate("majority_class", ConstantScorer(majority), (name, df), 0.5,
                           note=f"always predicts the training-set majority class ({'scam' if majority else 'legit'})"))

    if want is None or "blocklist" in want:
        bl = BlocklistScorer.from_raw()
        for name, df in datasets.items():
            urls = df.url.astype(str).tolist()
            _show(evaluate("blocklist_same_day", bl, (name, df), 0.5,
                           note="exact-URL / domain lookup in all public feeds pulled today (benchmark phishing rows "
                                "were taken from these feeds, so recall here is inflated by construction)"))
            if "source" in df.columns:
                _show(evaluate("blocklist_cross_feed", bl, (name, df), 0.5,
                               scores=bl.score_rows(urls, df.source.tolist()),
                               note="same lookup, but ignoring the feed each row was taken from"))

    for key, (factory, sample, note) in HF_BASELINES.items():
        if want is not None and key not in want:
            continue
        scorer = factory()
        if a.device != "cpu":
            if not hasattr(scorer, "to"):
                continue
            scorer.to(a.device)
            for name, df in datasets.items():
                r = evaluate(key, scorer, (name, df), 0.5, latency_n=300, write=False,
                             note=note + f"; scored on all rows on {a.device}")
                _keep_cpu_latency(r)
                write_result(r)
                _show(r)
            del scorer
            continue
        n = int(sample * a.sample_scale) if sample else None
        for name, df in datasets.items():
            latency_n = 300 if sample else 1000
            _show(evaluate(key, scorer, (name, df), 0.5, sample=n, latency_n=latency_n, note=note))
        del scorer


if __name__ == "__main__":
    main()
