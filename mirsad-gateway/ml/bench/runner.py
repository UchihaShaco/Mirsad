"""Evaluate any URL scorer on any labelled dataset and write ml/results/<model>__<dataset>.json.

A scorer is a callable url -> P(scam) (or None when it has no answer). It may also expose
`score_batch(urls) -> sequence of probabilities` for fast bulk scoring; latency is always measured
with single-URL calls on one thread, as the live engine would call it.

Dataset specs: a parquet/csv path, optionally followed by ":<split>" to keep one value of the
`split` column, e.g. ml/data/processed/urls.parquet:test.
"""

from __future__ import annotations

import json
import os
import random
import re
import time
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
import pandas as pd

from ml.bench.metrics import compute_metrics
from ml.bench.rowlevel import split

ROOT = Path(__file__).resolve().parents[2]
RESULTS_DIR = ROOT / "ml" / "results"
IMG_DIR = ROOT / "docs" / "img"


def load_dataset(spec: str) -> tuple[str, pd.DataFrame]:
    path, _, split = spec.partition(":")
    p = Path(path)
    df = pd.read_parquet(p) if p.suffix == ".parquet" else pd.read_csv(p)
    if "label" not in df.columns:
        df["label"] = 0  # e.g. a list of official sites: all legitimate
    name = p.stem
    if split:
        df = df[df["split"] == split]
        name = f"{name}_{split}"
    return name, df.reset_index(drop=True)


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.\-]+", "-", s)


def score_all(scorer: Callable, urls: list[str]) -> np.ndarray:
    batch = getattr(scorer, "score_batch", None)
    raw = batch(urls) if batch else [scorer(u) for u in urls]
    return np.array([np.nan if v is None else float(v) for v in raw], dtype=float)


def measure_latency(scorer: Callable, urls: Iterable[str], n: int = 1000, seed: int = 0) -> list[float]:
    urls = list(urls)
    sample = random.Random(seed).sample(urls, min(n, len(urls)))
    scorer(sample[0])  # warm-up (lazy model load)
    out = []
    for u in sample:
        t = time.perf_counter()
        scorer(u)
        out.append((time.perf_counter() - t) * 1000.0)
    return out


def plot_confusion(result: dict, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    m = np.array([[result["tn"], result["fp"]], [result["fn"], result["tp"]]])
    fig, ax = plt.subplots(figsize=(3.4, 3.0), dpi=110)
    ax.imshow(m, cmap="Blues")
    for i in range(2):
        for j in range(2):
            ax.text(j, i, f"{m[i, j]:,}", ha="center", va="center",
                    color="white" if m[i, j] > m.max() / 2 else "black", fontsize=11)
    ax.set_xticks([0, 1], ["pred legit", "pred scam"])
    ax.set_yticks([0, 1], ["legit", "scam"])
    ax.set_title(f"{result['model']}\n{result['dataset']}  thr={result['threshold']:.3g}", fontsize=8)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path)
    plt.close(fig)


def evaluate(
    model: str,
    scorer: Callable,
    dataset: str | tuple[str, pd.DataFrame],
    threshold: float,
    *,
    sample: int | None = None,
    latency_n: int = 1000,
    note: str = "",
    write: bool = True,
    scores: np.ndarray | None = None,
) -> dict:
    """Score `dataset` with `scorer` and write the result JSON + confusion-matrix PNG.

    `scores` may be passed when they were already computed for exactly these rows."""
    name, df = load_dataset(dataset) if isinstance(dataset, str) else dataset
    if sample and len(df) > sample:
        df = df.sample(sample, random_state=0).reset_index(drop=True)
        note = (note + "; " if note else "") + f"random sample of {sample} rows"
    urls = df["url"].astype(str).tolist()
    s = score_all(scorer, urls) if scores is None else np.asarray(scores, dtype=float)
    lat = measure_latency(scorer, urls, n=latency_n) if latency_n else None
    res = compute_metrics(df["label"].to_numpy(), s, threshold, model=model, dataset=name, latencies_ms=lat)
    res["no_answer"] = int(np.isnan(s).sum())
    if note:
        res["note"] = note
    flagged_legit = (df["label"].to_numpy() == 0) & (np.nan_to_num(s, nan=-1) >= threshold)
    if df["label"].max() == 0 or name.startswith("uae"):
        res["false_positives"] = [
            {"url": u, "score": round(float(v), 4)} for u, v in zip(df.loc[flagged_legit, "url"], s[flagged_legit])
        ][:200]
    if write:
        write_result(res)
    return res


def write_result(res: dict) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{_slug(res['model'])}__{_slug(res['dataset'])}"
    out = RESULTS_DIR / f"{stem}.json"
    split(res, out)  # per-URL lists go to the git-ignored data/results_full/ only
    if res["fp"] + res["tn"] + res["tp"] + res["fn"]:
        plot_confusion(res, IMG_DIR / f"cm__{stem}.png")
    return out


def _cli() -> None:
    import argparse
    import importlib

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scorer", help="module:attribute of a callable url -> P(scam), e.g. scamshield.models.url_model:score_url")
    ap.add_argument("datasets", nargs="+")
    ap.add_argument("--name", required=True, help="model name used in the result file")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--sample", type=int)
    a = ap.parse_args()
    mod, _, attr = a.scorer.partition(":")
    fn = getattr(importlib.import_module(mod), attr)
    for d in a.datasets:
        r = evaluate(a.name, fn, d, a.threshold, sample=a.sample)
        print(json.dumps({k: r[k] for k in ("model", "dataset", "n", "precision", "recall", "fpr", "latency_ms_p50")}))


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "8")
    _cli()
