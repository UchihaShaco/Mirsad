"""The PhreshPhish "Linear" baseline (arXiv 2507.10854 v2, §5 and Appendix C.1) restricted to the URL, which is
all our data has: binary character 2/3/4-grams of the URL plus hand-crafted URL features (lengths of the URL,
host, path and query; dots, subdomain levels, slashes, hyphens, digits, `@`, IP host, query parameters),
LinearSVC (squared hinge, L2, dual, tol 1e-3, class_weight="balanced"). Re-implemented from the paper's
description (the paper's code is not in its repo); n-grams are hashed (2^22) instead of a vocabulary.

Two runs:
  --setting paper   train on the official PhreshPhish train split (497,7xx full URLs, as published) and score the
                    official test split with the paper's 975-benchmark protocol, next to the paper's Table 4.
  --setting ours    train on a seeded 1M-row subsample (protocol.json) of our shared training rows (liblinear holds a
                    double copy of the sparse matrix; all 2M rows exceed the 8 GB budget) and score our test sets.

    nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.phreshphish_linear --setting paper
"""

from __future__ import annotations

import argparse
import json
import re
import time

import numpy as np
import pandas as pd
import scipy.sparse as sp
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.svm import LinearSVC

from ml.bench.metrics import compute_metrics
from ml.bench.runner import write_result
from ml.sota.url.common import (TARGET_VAL_FPR, WORK, calibrate, evaluate_all, limit_threads, load_train, load_val,
                                measure_latency)
from ml.sota.url.data import PROTOCOL
from ml.sota.url.phreshphish_bench import PAPER_TABLE4, benchmark, domain_overlap
from ml.url.train import log
from scamshield.models.url_features import normalize_for_text

limit_threads()
NAME = "sota_url_phreshphish_linear"
NGRAMS = HashingVectorizer(analyzer="char", ngram_range=(2, 4), n_features=2**22, binary=True, norm=None,
                           alternate_sign=False, lowercase=False, dtype=np.float32)
IP = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def handcrafted(urls: list[str]) -> np.ndarray:
    rows = []
    for u in urls:
        rest = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", "", u)
        host, _, tail = rest.partition("/")
        path, _, query = tail.partition("?")
        host = host.split("@")[-1].split(":")[0]
        rows.append([len(u), len(host), len(path), len(query), host.count("."), max(host.count(".") - 1, 0),
                     u.count("/"), u.count("-"), sum(c.isdigit() for c in u), "@" in u, bool(IP.match(host)),
                     query.count("&") + bool(query)])
    return np.log1p(np.asarray(rows, dtype=np.float32))


def features(urls: list[str]) -> sp.csr_matrix:
    return sp.hstack([NGRAMS.transform(urls), sp.csr_matrix(handcrafted(urls))], format="csr")


def fit(urls: list[str], y: np.ndarray) -> LinearSVC:
    t = time.time()
    clf = LinearSVC(loss="squared_hinge", penalty="l2", dual=True, tol=1e-3, class_weight="balanced",
                    max_iter=2000, random_state=0).fit(features(urls), y)
    log(f"LinearSVC fitted on {len(y):,} URLs in {(time.time() - t) / 60:.1f} min")
    return clf


def score_fn(clf: LinearSVC):
    """Decision value squashed to (0, 1) by a logistic, so thresholds and JSON look like the other systems."""
    return lambda texts: 1.0 / (1.0 + np.exp(-clf.decision_function(features(texts))))


def run_paper() -> None:
    tr = pd.read_parquet(WORK / "phreshphish_official_train.parquet")
    te = pd.read_parquet(WORK / "phreshphish_official_test.parquet")
    clf = fit(tr.url.tolist(), (tr.label == "phish").to_numpy().astype(int))
    s = score_fn(clf)(te.url.tolist())
    y = (te.label == "phish").to_numpy().astype(int)
    r = compute_metrics(y, s, 0.5, model=f"{NAME}_paper_split", dataset="phreshphish_test")
    r["no_answer"] = 0
    r["phreshphish_benchmark"] = benchmark(te, s)
    r["paper_table4_url_plus_html"] = PAPER_TABLE4
    r["test_registered_domain_seen_in_train"] = domain_overlap(tr.url, te)
    r["note"] = (f"PhreshPhish Linear baseline on the URL only, trained on the official train split ({len(tr):,} "
                 f"URLs), scored on the official test split ({len(te):,}) and its 975 benchmarks; the paper's "
                 f"Linear/FFN/GTE numbers (Table 4) use URL + HTML. Threshold 0.5 = SVM margin 0.")
    write_result(r)
    log(json.dumps(r["phreshphish_benchmark"], indent=1))


def run_ours() -> None:
    tr = load_train().sample(PROTOCOL["linear_svc_train_rows"], random_state=PROTOCOL["sample_seed"])
    clf = fit(tr.norm.tolist(), tr.label.to_numpy())
    score = score_fn(clf)
    va = load_val()
    thr = calibrate(va, score(va.norm.tolist()))
    lat = measure_latency(lambda u: float(score([normalize_for_text(u)])[0]))
    note = ("PhreshPhish Linear baseline (URL-only: char 2-4-grams + hand-crafted URL features, LinearSVC), "
            f"re-implemented from the paper, trained on a {len(tr):,}-row subsample of our training rows; threshold "
            f"at {TARGET_VAL_FPR:.1%} val FPR. Paper has no released weights.")
    evaluate_all(NAME, score, thr, note, lat)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setting", choices=["paper", "ours"], required=True)
    a = ap.parse_args()
    if a.setting == "paper":
        run_paper()
    else:
        run_ours()


if __name__ == "__main__":
    main()
