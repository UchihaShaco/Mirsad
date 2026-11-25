"""Shared protocol for the recreated URL methods: frozen rows, threshold rule, scoring, latency, result JSON.

Every method gets the same input string, `normalize_for_text(url)` (scheme and leading `www.` removed),
the same training rows (ml/sota/url/data.py), and its block threshold is set the same way as ours: the
lowest score whose FPR on the calibration half of the validation split is <= 0.2%.
Results are written by `ml.bench.runner.write_result` in the `compute_metrics` shape, as
ml/results/sota_url_<method>__<dataset>.json, so `ml.bench.report` lists them next to ours.
"""

from __future__ import annotations

import os
import random
import time
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from ml.bench.metrics import compute_metrics, threshold_for_fpr
from ml.bench.runner import write_result
from ml.sota.url.data import EVAL_DIR, PROTOCOL, WORK
from ml.url.train import log
from scamshield.models.url_features import normalize_for_text

TARGET_VAL_FPR = PROTOCOL["target_val_fpr"]
EVAL_SETS = ("urls_test", "urls_test_nohf", "urls_test_noshort", "urls_test_shorteners",
             "urls_test_deeplegit_vs_barephish", "urls_fresh_test", "urls_fresh_test_fullurl",
             "urls_fresh_test_domainonly", "uae_legit", "uae_legit_v3_new")
MODELS_DIR = WORK / "models"


def limit_threads(n: int = 8) -> None:
    for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ.setdefault(k, str(n))


def gpu_guard(max_gb: float = PROTOCOL["gpu_max_gb"]):
    """CUDA device capped at `max_gb` of the shared GPU."""
    import torch

    assert torch.cuda.is_available(), "needs a CUDA torch build"
    dev = torch.device("cuda", 0)
    free, total = torch.cuda.mem_get_info(dev)
    assert free / 2**30 > max_gb + 2, f"only {free / 2**30:.1f} GB free on the GPU; wait for it"
    torch.cuda.set_per_process_memory_fraction(max_gb / (total / 2**30), dev)
    return dev


def load_train() -> pd.DataFrame:
    return pd.read_parquet(WORK / "train.parquet")


def load_val() -> pd.DataFrame:
    return pd.read_parquet(WORK / "val.parquet")


def calibrate(val: pd.DataFrame, scores: np.ndarray) -> float:
    cal = val.calibration.to_numpy()
    return threshold_for_fpr(val.label.to_numpy()[cal], scores[cal], TARGET_VAL_FPR)


def precision_at_prevalence(recall: float, fpr: float, prevalence: float) -> float | None:
    tp, fp = recall * prevalence, fpr * (1 - prevalence)
    return tp / (tp + fp) if tp + fp else None


def measure_latency(score_one: Callable[[str], float], n: int = PROTOCOL["latency_urls"], seed: int = 0) -> dict:
    """p50 / p95 ms per URL, one URL at a time, on a random sample of urls_test (raw URLs, so the
    normalisation cost is included)."""
    urls = pd.read_parquet(EVAL_DIR / "urls_test.parquet", columns=["url"]).url.tolist()
    sample = random.Random(seed).sample(urls, n)
    for u in sample[:10]:
        score_one(u)  # warm-up
    t = []
    for u in sample:
        t0 = time.perf_counter()
        score_one(u)
        t.append((time.perf_counter() - t0) * 1000.0)
    return {"p50": float(np.percentile(t, 50)), "p95": float(np.percentile(t, 95)), "n": n}


def evaluate_all(model: str, score_norm: Callable[[list[str]], np.ndarray], threshold: float, note: str,
                 latency_cpu: dict | None, latency_gpu: dict | None = None, sets=EVAL_SETS) -> dict[str, dict]:
    """Score every frozen evaluation set (batch scoring of the normalised strings) and write the results."""
    out = {}
    for name in sets:
        d = pd.read_parquet(EVAL_DIR / f"{name}.parquet")
        s = np.asarray(score_norm(d.norm.tolist()), dtype=float)
        y = d.label.to_numpy()
        r = compute_metrics(y, s, threshold, model=model, dataset=name)
        r["no_answer"] = 0
        if latency_cpu:
            r["latency_ms_p50"], r["latency_ms_p95"] = latency_cpu["p50"], latency_cpu["p95"]
            r["latency_note"] = f"one CPU thread, one URL at a time, {latency_cpu['n']} urls_test URLs"
        if latency_gpu:
            r["latency_gpu_ms_p50"], r["latency_gpu_ms_p95"] = latency_gpu["p50"], latency_gpu["p95"]
        for prev, key in ((0.01, "1pct"), (0.0005, "0.05pct")):
            r[f"precision_at_prevalence_{key}"] = precision_at_prevalence(r["recall"], r["fpr"], prev)
        r["note"] = note
        if y.max() == 0:
            flagged = s >= threshold
            r["false_positives"] = [{"url": u, "score": round(float(v), 4)}
                                    for u, v in zip(d.url[flagged], s[flagged])][:200]
        write_result(r)
        out[name] = r
        log(f"{model} {name}: n={r['n']:,} R@0.1%={r['recall_at_fpr_0.1pct']} R@1%={r['recall_at_fpr_1pct']} "
            f"P={r['precision']:.4f} R={r['recall']:.4f} FP={r['fp']}")
    return out


GRAMBEDDINGS_DATA = Path(__file__).resolve().parent / "vendor" / "URLBERT" / "dataset" / "grambedding"
GRAMBEDDINGS_PAPER_ACCURACY = PROTOCOL["published"]["grambeddings_accuracy"]["GramBeddings"]


def grambeddings_dataset(part: str) -> pd.DataFrame:
    """The GramBeddings 800k dataset's official split (Train.csv 640k / Test.csv 160k, as redistributed in the
    URLBERT repository), raw URLs as in the paper: columns `norm` (the model input) and `label`."""
    d = pd.read_csv(GRAMBEDDINGS_DATA / f"{part}.csv").dropna()
    d = d[d.label.isin(["benign", "malicious"])]
    return pd.DataFrame({"norm": d.url.astype(str).to_numpy(), "label": (d.label == "malicious").astype(int).to_numpy()})


def write_paper_check(model: str, scores: np.ndarray, note: str) -> dict:
    """Score on the GramBeddings test split at the paper's 0.5 threshold, with accuracy as the paper reports it."""
    te = grambeddings_dataset("Test")
    r = compute_metrics(te.label.to_numpy(), scores, 0.5, model=model, dataset="grambeddings_test")
    r["no_answer"] = 0
    r["accuracy"] = (r["tp"] + r["tn"]) / r["n"]
    r["paper_reported_accuracy_grambeddings"] = GRAMBEDDINGS_PAPER_ACCURACY
    r["note"] = note
    write_result(r)
    log(f"{model} on grambeddings_test: accuracy {r['accuracy']:.4f} (GramBeddings paper: {GRAMBEDDINGS_PAPER_ACCURACY})")
    return r


def batched(fn: Callable[[list[str]], np.ndarray], batch: int) -> Callable[[list[str]], np.ndarray]:
    """Score a long list in length-sorted batches (less padding), restoring the input order."""
    def run(texts: list[str]) -> np.ndarray:
        order = np.argsort([len(t) for t in texts])
        out = np.empty(len(texts))
        for i in range(0, len(texts), batch):
            idx = order[i : i + batch]
            out[idx] = fn([texts[j] for j in idx])
        return out

    return run


def train_loop(model, batches: Callable[[np.ndarray], tuple], y: np.ndarray, dev, *, epochs: float, batch: int,
               lr: float, max_minutes: float, weight_decay: float = 0.0, loss: str = "ce") -> dict:
    """Plain Adam loop with class-balanced loss (as ours) and a wall-clock budget. `batches(idx)` returns the
    model inputs for those training rows, already on `dev`."""
    import torch

    yt = torch.tensor(y)
    pos = float(y.mean())
    w = torch.tensor([0.5 / (1 - pos), 0.5 / pos], device=dev)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=weight_decay)
    steps = int(np.ceil(len(y) / batch * epochs))
    rng = np.random.default_rng(0)
    perm = np.concatenate([rng.permutation(len(y)) for _ in range(int(np.ceil(epochs)))])
    model.train()
    t0, done = time.time(), 0
    for step in range(steps):
        idx = perm[step * batch : (step + 1) * batch]
        out = model(*batches(idx))
        yy = yt[idx].to(dev)
        if loss == "bce":  # single sigmoid output (GramBeddings)
            l = torch.nn.functional.binary_cross_entropy_with_logits(out.squeeze(-1).float(), yy.float(), weight=w[yy])
        else:
            l = torch.nn.functional.cross_entropy(out.float(), yy, weight=w)
        opt.zero_grad(set_to_none=True)
        l.backward()
        opt.step()
        done = step + 1
        if step % 500 == 0:
            log(f"step {step}/{steps} loss {l.item():.4f} {done * batch / (time.time() - t0):.0f} urls/s")
        if time.time() - t0 > max_minutes * 60:
            log(f"time budget reached at step {step}/{steps}")
            break
    model.eval()
    return {"steps_done": done, "steps_planned": steps, "epochs_done": done * batch / len(y),
            "train_minutes": (time.time() - t0) / 60}
