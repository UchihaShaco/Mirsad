"""One metrics function shared by every URL / page / pipeline benchmark."""

from __future__ import annotations

import math

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score, roc_curve


def recall_at_fpr(labels: np.ndarray, scores: np.ndarray, max_fpr: float) -> float | None:
    """Best recall reachable with a threshold whose FPR does not exceed max_fpr."""
    if labels.min() == labels.max():
        return None
    fpr, tpr, _ = roc_curve(labels, scores)
    ok = fpr <= max_fpr
    return float(tpr[ok].max()) if ok.any() else 0.0


def compute_metrics(
    labels,
    scores,
    threshold: float,
    *,
    model: str = "",
    dataset: str = "",
    latencies_ms=None,
) -> dict:
    """labels: 1 = scam, 0 = legit. scores: P(scam); NaN means the system gave no answer and is
    counted as "not flagged". A URL is flagged when score >= threshold."""
    y = np.asarray(labels, dtype=int)
    s = np.asarray(scores, dtype=float)
    s_filled = np.where(np.isnan(s), -np.inf, s)
    pred = s_filled >= threshold
    tp = int(np.sum(pred & (y == 1)))
    fp = int(np.sum(pred & (y == 0)))
    tn = int(np.sum(~pred & (y == 0)))
    fn = int(np.sum(~pred & (y == 1)))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    fpr = fp / (fp + tn) if fp + tn else 0.0
    both = y.min() != y.max()
    floor = float(np.nanmin(s)) - 1.0 if np.isfinite(s).any() else 0.0
    ranked = np.where(np.isfinite(s), s, floor)  # unanswered URLs rank below every answered one
    lat = np.asarray(latencies_ms if latencies_ms is not None else [], dtype=float)
    return {
        "model": model,
        "dataset": dataset,
        "n": int(len(y)),
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "fpr": fpr,
        "roc_auc": float(roc_auc_score(y, ranked)) if both else None,
        "pr_auc": float(average_precision_score(y, ranked)) if both else None,
        "recall_at_fpr_0.1pct": recall_at_fpr(y, ranked, 0.001) if both else None,
        "recall_at_fpr_1pct": recall_at_fpr(y, ranked, 0.01) if both else None,
        "threshold": float(threshold),
        "latency_ms_p50": float(np.percentile(lat, 50)) if lat.size else None,
        "latency_ms_p95": float(np.percentile(lat, 95)) if lat.size else None,
    }


def threshold_for_fpr(labels, scores, max_fpr: float) -> float:
    """Lowest threshold whose FPR on these (validation) labels is <= max_fpr."""
    y = np.asarray(labels, dtype=int)
    s = np.asarray(scores, dtype=float)
    neg = np.sort(s[y == 0])[::-1]
    k = int(math.floor(max_fpr * len(neg)))  # number of negatives allowed above threshold
    if k >= len(neg):
        return float(neg[-1])
    return float(np.nextafter(neg[k], np.inf))
