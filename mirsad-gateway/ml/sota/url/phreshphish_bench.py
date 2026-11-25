"""Score a model the way the PhreshPhish paper does (arXiv 2507.10854 v2, Table 4): on each of the 975 official
benchmarks (all benign test samples + one file of phishing samples, base rates 0.05%-5%) and on the full
benchmark (24%), report mean average precision and mean precision at recall 0.90 with a 95% bootstrap CI
over the benchmarks of that base rate.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_recall_curve

from ml.sota.url.data import PROTOCOL
from ml.sota.url.phreshphish_fetch import BENCH_DIR

BASE_RATES = {"0.05": "benchmark-005", "0.10": "benchmark-010", "0.50": "benchmark-050", "1.0": "benchmark-100",
              "5.0": "benchmark-500"}
PAPER_TABLE4 = {k: v for k, v in PROTOCOL["published"]["phreshphish_table4"].items() if not k.startswith("_")}


def domain_overlap(train_urls: pd.Series, test: pd.DataFrame) -> dict[str, float]:
    """Share of test rows, per label, whose registered domain also occurs in train. The official split is
    temporal with HTML near-duplicate removal, not domain-disjoint, so a URL model can partly memorise domains."""
    from scamshield.models.url_features import parse_url

    seen = {parse_url(u).registered_domain for u in train_urls}
    hit = pd.Series([parse_url(u).registered_domain in seen for u in test.url], index=test.index)
    return {str(k): float(v) for k, v in hit.groupby(test.label).mean().items()}


def _hashes(path) -> list[str]:
    return path.read_text().split()


def precision_at_recall(y: np.ndarray, s: np.ndarray, recall: float = 0.90) -> float:
    p, r, _ = precision_recall_curve(y, s)
    return float(p[r >= recall].max())


def _ci(values: np.ndarray, seed: int = 0) -> float:
    """Half-width of the 95% bootstrap CI of the mean (max absolute deviation, as the paper reports)."""
    if len(values) < 2:
        return 0.0
    rng = np.random.default_rng(seed)
    means = rng.choice(values, (1000, len(values))).mean(1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return float(max(values.mean() - lo, hi - values.mean()))


def benchmark(test: pd.DataFrame, scores: np.ndarray) -> dict:
    """`test`: the official test split with `sha256`; `scores`: P(phish) for each row."""
    s = pd.Series(scores, index=test.sha256.to_numpy())
    s = s[~s.index.duplicated()]
    benign = s.reindex(_hashes(BENCH_DIR / "benchmark" / "benign.txt")).dropna().to_numpy()
    out = {}
    sets = {"24.0": [BENCH_DIR / "benchmark" / "phish.txt"]}
    sets |= {rate: sorted((BENCH_DIR / "benchmark" / d).glob("*.txt")) for rate, d in BASE_RATES.items()}
    for rate, files in sets.items():
        aps, pr90 = [], []
        for f in files:
            phish = s.reindex(_hashes(f)).dropna().to_numpy()
            y = np.r_[np.zeros(len(benign)), np.ones(len(phish))]
            sc = np.r_[benign, phish]
            aps.append(average_precision_score(y, sc))
            pr90.append(precision_at_recall(y, sc))
        aps, pr90 = np.array(aps), np.array(pr90)
        out[rate] = {"n_benchmarks": len(files), "ap": float(aps.mean()), "ap_ci": _ci(aps),
                     "p_at_r90": float(pr90.mean()), "p_at_r90_ci": _ci(pr90)}
    out["benign_rows_found"] = int(len(benign))
    return out
