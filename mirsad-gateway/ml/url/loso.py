"""Leave-one-source-out (cross-dataset) evaluation of the URL stack.

For each source group, retrain the stack without any row from that group (train, validation and
threshold selection all exclude it), then score that group's test rows. The same rows scored by a
model trained on all sources (same row cap) give the in-distribution reference.

Writes ml/results/loso/url_stack_loso.json.  Run:  .venv/bin/python -m ml.url.loso [--cap 30000]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from ml.bench.metrics import compute_metrics
from ml.bench.runner import RESULTS_DIR
from ml.url.train import log, train_all
from scamshield.models.url_model import UrlScorer

ROOT = Path(__file__).resolve().parents[2]
GROUPS = {
    "phreshphish": ("phreshphish",),
    "phishing_database": ("phishing_database",),
    "hf_ealvaradob": ("hf_ealvaradob",),
    "hf_kmack": ("hf_kmack",),
    "phiusiil": ("phiusiil",),
    "cert_pl": ("cert_pl",),
    "jarelllama_scam": ("jarelllama",),
    "top_lists (tranco/umbrella/majestic)": ("tranco", "umbrella", "majestic"),
    "urlhaus / malware_filter": ("urlhaus", "malware_filter"),
    "phishtank": ("phishtank",),
    "commoncrawl deep legit": ("commoncrawl",),
    "kaggle_hassaanmustafavi": ("kaggle_hassaan",),
    "mendeley_n96ncsr5g4": ("mendeley",),
}


def _summary(y, s, thr) -> dict:
    m = compute_metrics(y, s, thr)
    out = {"n": m["n"], "n_scam": int(y.sum()), "n_legit": int((y == 0).sum()), "threshold": thr,
           "recall": m["recall"] if y.sum() else None, "fpr": m["fpr"] if (y == 0).any() else None,
           "roc_auc": m["roc_auc"], "recall_at_fpr_1pct": m["recall_at_fpr_1pct"]}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "ml/data/processed/urls.parquet"))
    ap.add_argument("--cap", type=int, default=30_000)
    a = ap.parse_args()
    data = Path(a.data)
    test = pd.read_parquet(data, columns=["url", "label", "source", "split"])
    test = test[test.split == "test"].reset_index(drop=True)

    log("in-distribution reference model")
    ref = UrlScorer(train_all(data, a.cap, 0.002, save=False)["stack"])
    rows = []
    for gname, prefixes in GROUPS.items():
        g = test[test.source.str.startswith(prefixes)]
        if g.empty:
            continue
        g = g.sample(min(len(g), 50_000), random_state=0)
        log(f"held out: {gname} ({len(g):,} test rows)")
        held = UrlScorer(train_all(data, a.cap, 0.002, exclude_source=prefixes, save=False)["stack"])
        urls, y = g.url.astype(str).tolist(), g.label.to_numpy()
        row = {"held_out": gname, "sources": list(prefixes),
               "held_out_model": _summary(y, held.score_batch(urls), held.threshold),
               "in_distribution_model": _summary(y, ref.score_batch(urls), ref.threshold)}
        rows.append(row)
        log(json.dumps(row))
        out = RESULTS_DIR / "loso" / "url_stack_loso.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"cap_per_source": a.cap, "rows": rows}, indent=2))


if __name__ == "__main__":
    main()
