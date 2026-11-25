"""Train the CPU page models from the feature cache and save the best one for serving.

Models (all from `scamshield.models.page_features.extract`):
  * text_lr     - TF-IDF word 1-2-grams + character 2-5-grams (Arabic-normalised) -> logistic regression
  * struct_lgbm - LightGBM over the structural / behavioural features
  * combo       - LightGBM over the structural features + the text model's out-of-fold margin
                  (stacking), Platt-calibrated on validation  <- served by default

Splits (leak-free): train = processed `train` + `extra_train`; validation = processed `val` plus a
domain-grouped slice of `extra_train`; nothing in validation shares a registered domain with
training. The test sets (processed `test`, `fresh_test`, `ealvaradob`) are never touched here.

    .venv/bin/python -m ml.page.train            # writes ml/artifacts/page_model.joblib
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "8")

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from joblib import Parallel, delayed
from scipy.sparse import vstack

from ml.bench.metrics import threshold_for_fpr
from scamshield.models.page_features import STRUCT_NAMES
from scamshield.models.page_model import combo_input, text_matrix

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "ml" / "page" / "cache"
ARTIFACTS = ROOT / "ml" / "artifacts"
THREADS = 8
CHAR_CHARS = 3000
VERSION = "page-combo-3"  # 3 = with engine-fetched live legitimate pages
MAX_FPR = 0.005  # operating point on validation

LGB_PARAMS = dict(
    objective="binary", learning_rate=0.05, num_leaves=63, min_data_in_leaf=20, feature_fraction=0.8,
    bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, num_threads=THREADS, verbose=-1, seed=0,
)


def load_cache() -> pd.DataFrame:
    df = pd.read_parquet(CACHE / "features.parquet")
    names = json.loads((CACHE / "struct_names.json").read_text())
    if names != list(STRUCT_NAMES):
        raise SystemExit("feature cache is stale (STRUCT_NAMES changed): rebuild with ml.page.corpus")
    live = CACHE / "features_live.parquet"  # legitimate pages fetched by our own engine (ml.page.crawl_legit)
    if live.exists():
        df = pd.concat([df, pd.read_parquet(live)], ignore_index=True)
    return df


def _bucket(domain: str) -> float:
    return int(hashlib.md5(domain.encode()).hexdigest()[:8], 16) / 2**32


def assign_roles(df: pd.DataFrame, val_frac: float = 0.15) -> pd.Series:
    """train / val / test / other role per row (see module docstring)."""
    role = pd.Series("other", index=df.index)
    role[df["split"].isin(["train", "extra_train", "live_train"])] = "train"
    role[df["split"].isin(["val", "live_val"])] = "val"
    ex = df["split"] == "extra_train"
    role[ex & (df["registered_domain"].map(_bucket) < val_frac)] = "val"
    role[df["split"].isin(["test", "fresh_test", "ealvaradob", "live_test"])] = "test"
    # domain-disjointness between train and val
    val_domains = set(df.loc[role == "val", "registered_domain"]) - {""}
    role[(role == "train") & df["registered_domain"].isin(val_domains)] = "val"
    return role


VOCAB_DOCS = 15_000  # vocabulary / idf are fitted on a random subsample of this many training pages


def _fit_vec(vec: TfidfVectorizer, docs: list[str]) -> TfidfVectorizer:
    return vec.fit(docs)


def par_text_matrix(b: dict, docs: list[str], n_jobs: int = THREADS):
    """`text_matrix` over chunks in worker processes (the n-gram analyzers are pure Python)."""
    if len(docs) < 2000:
        return text_matrix(b, docs)
    step = int(np.ceil(len(docs) / n_jobs))
    parts = Parallel(n_jobs=n_jobs)(delayed(text_matrix)(b, docs[i : i + step]) for i in range(0, len(docs), step))
    return vstack(parts, format="csr")


def fit_text(docs_tr: list[str], max_word: int, max_char: int) -> dict:
    word = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), token_pattern=r"(?u)\b\w\w+\b", min_df=3,
                           max_df=0.9, max_features=max_word, sublinear_tf=True, dtype=np.float32)
    char = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=5, max_features=max_char,
                           sublinear_tf=True, dtype=np.float32)
    rng = np.random.default_rng(0)
    sub = [docs_tr[i] for i in rng.permutation(len(docs_tr))[:VOCAB_DOCS]]
    word, char = Parallel(n_jobs=2)([delayed(_fit_vec)(word, sub),
                                     delayed(_fit_vec)(char, [d[:CHAR_CHARS] for d in sub])])
    return {"word_vec": word, "char_vec": char, "char_chars": CHAR_CHARS}


def _lr_only(X, y, C: float) -> LogisticRegression:
    lr = LogisticRegression(C=C, solver="liblinear", max_iter=200, class_weight="balanced")
    return lr.fit(X, y)


def _oof_fold(X, y, a, b, C):
    return b, _lr_only(X[a], y[a], C).decision_function(X[b])


def platt(raw: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    lr = LogisticRegression(C=1e4, solver="lbfgs").fit(raw.reshape(-1, 1), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def summarise(name: str, y: np.ndarray, s: np.ndarray) -> dict:
    return {"model": name, "roc_auc": float(roc_auc_score(y, s)), "pr_auc": float(average_precision_score(y, s))}


def _cal(p: tuple[float, float], raw: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-(p[0] * raw + p[1])))


def fit_all(tr: pd.DataFrame, va: pd.DataFrame, Cs=(1.0, 4.0, 16.0), max_word: int = 150_000,
            max_char: int = 150_000, rounds: int = 2000) -> tuple[dict, dict]:
    """Fit text_lr, struct_lgbm and combo on `tr`, select / calibrate / set thresholds on `va`.
    Returns (served bundle for the combo model, side models for benchmarking)."""
    ytr, yva = tr["label"].to_numpy(), va["label"].to_numpy()
    Str, Sva = np.vstack(tr["struct"].to_numpy()), np.vstack(va["struct"].to_numpy())
    docs_tr, docs_va = tr["doc"].tolist(), va["doc"].tolist()

    # ---- text model: vocabulary on train, C chosen on val
    t0 = time.time()
    base = fit_text(docs_tr, max_word, max_char)
    Xtr, Xva = par_text_matrix(base, docs_tr), par_text_matrix(base, docs_va)
    print(f"tf-idf {Xtr.shape} in {time.time() - t0:.0f}s", flush=True)
    lrs = Parallel(n_jobs=len(Cs))(delayed(_lr_only)(Xtr, ytr, C) for C in Cs)
    best_C, best_ap, report = Cs[0], -1.0, {}
    for C, lr in zip(Cs, lrs):
        ap_ = average_precision_score(yva, lr.decision_function(Xva))
        print(f"text_lr C={C} val PR-AUC {ap_:.4f}", flush=True)
        if ap_ > best_ap:
            best_C, best_ap, base["text_lr"] = C, ap_, lr
    m_va = base["text_lr"].decision_function(Xva)
    report["text_lr"] = summarise("text_lr", yva, m_va) | {"C": best_C}

    # ---- out-of-fold text margins on train (grouped by registered domain) for stacking
    oof = np.zeros(len(tr), dtype=np.float32)
    groups = tr["registered_domain"].where(tr["registered_domain"] != "", tr["source_id"]).to_numpy()
    folds = list(GroupKFold(n_splits=5).split(Xtr, ytr, groups))
    for b, m in Parallel(n_jobs=5)(delayed(_oof_fold)(Xtr, ytr, a, b, best_C) for a, b in folds):
        oof[b] = m
    print(f"text model + out-of-fold margins done in {time.time() - t0:.0f}s", flush=True)

    # ---- structural LightGBM
    dtr = lgb.Dataset(Str, ytr, feature_name=list(STRUCT_NAMES), free_raw_data=False)
    dva = lgb.Dataset(Sva, yva, reference=dtr)
    struct = lgb.train(LGB_PARAMS, dtr, rounds, valid_sets=[dva], callbacks=[lgb.early_stopping(100, verbose=False)])
    s_va = struct.predict(Sva, raw_score=True, num_iteration=struct.best_iteration)
    report["struct_lgbm"] = summarise("struct_lgbm", yva, s_va) | {"rounds": struct.best_iteration}

    # ---- combo LightGBM over struct + text margin
    names = list(STRUCT_NAMES) + ["text_model"]
    ctr = lgb.Dataset(combo_input(Str, oof), ytr, feature_name=names, free_raw_data=False)
    cva = lgb.Dataset(combo_input(Sva, m_va), yva, reference=ctr)
    combo = lgb.train(LGB_PARAMS, ctr, rounds, valid_sets=[cva], callbacks=[lgb.early_stopping(100, verbose=False)])
    c_va = combo.predict(combo_input(Sva, m_va), raw_score=True, num_iteration=combo.best_iteration)
    report["combo"] = summarise("combo", yva, c_va) | {"rounds": combo.best_iteration}
    for k, v in report.items():
        print(k, v, flush=True)

    # refit boosters to their best iteration so the saved model needs no num_iteration argument
    struct = lgb.train(LGB_PARAMS, dtr, max(1, struct.best_iteration))
    combo = lgb.train(LGB_PARAMS, ctr, max(1, combo.best_iteration))
    text_names = np.array(list(base["word_vec"].get_feature_names_out()) +
                          [f"[{c}]" for c in base["char_vec"].get_feature_names_out()], dtype=object)
    p_text, p_struct, p_combo = platt(m_va, yva), platt(s_va, yva), platt(c_va, yva)
    bundle = {
        "name": "page_combo", "version": VERSION, "word_vec": base["word_vec"], "char_vec": base["char_vec"],
        "char_chars": CHAR_CHARS, "text_lr": base["text_lr"], "text_feature_names": text_names,
        "struct_names": list(STRUCT_NAMES), "lgbm": combo, "calib": p_combo,
        # operating point: at most 0.5% of legitimate validation pages flagged
        "threshold": threshold_for_fpr(yva, _cal(p_combo, c_va), MAX_FPR),
        "threshold_rule": f"calibrated P(scam) at which <= {MAX_FPR:.1%} of legitimate validation pages are flagged",
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_train": int(len(tr)), "n_val": int(len(va)), "metrics": {"val": report},
    }
    side = {"struct_lgbm": struct, "struct_calib": p_struct, "text_calib": p_text,
            "text_threshold": threshold_for_fpr(yva, _cal(p_text, m_va), MAX_FPR),
            "struct_threshold": threshold_for_fpr(yva, _cal(p_struct, s_va), MAX_FPR)}
    return bundle, side


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-word", type=int, default=150_000)
    ap.add_argument("--max-char", type=int, default=150_000)
    ap.add_argument("--C", type=float, nargs="*", default=[1.0, 4.0, 16.0])
    ap.add_argument("--rounds", type=int, default=2000)
    ap.add_argument("--tag", default="", help="write page_model<tag>.joblib / page_side_models<tag>.joblib instead "
                                               "(to compare before replacing the served artifact)")
    args = ap.parse_args()
    t0 = time.time()
    df = load_cache()
    role = assign_roles(df)
    tr, va = df[role == "train"].reset_index(drop=True), df[role == "val"].reset_index(drop=True)
    print(f"train {len(tr)} ({tr.label.mean():.2f} scam)  val {len(va)} ({va.label.mean():.2f} scam)", flush=True)
    bundle, side = fit_all(tr, va, args.C, args.max_word, args.max_char, args.rounds)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # the running engine may be loading this file: write to a temp name, then rename atomically
    tmp = ARTIFACTS / f"page_model{args.tag}.joblib.tmp"
    joblib.dump(bundle, tmp, compress=3)
    os.replace(tmp, ARTIFACTS / f"page_model{args.tag}.joblib")
    joblib.dump(side, CACHE / f"page_side_models{args.tag}.joblib", compress=3)  # benchmarking only
    (ARTIFACTS / f"page_model{args.tag}_meta.json").write_text(json.dumps(
        {k: bundle[k] for k in ("name", "version", "trained_at", "threshold", "n_train", "n_val", "metrics")},
        indent=2))
    size = (ARTIFACTS / f"page_model{args.tag}.joblib").stat().st_size / 1e6
    print(f"saved page_model{args.tag}.joblib ({size:.1f} MB), threshold {bundle['threshold']:.3f}, "
          f"{time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
