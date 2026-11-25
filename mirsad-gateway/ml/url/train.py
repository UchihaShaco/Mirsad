"""Train the URL models (CPU) and write ml/artifacts/url_*.joblib.

Models
  url_tfidf_lr     character 1-5-gram TF-IDF (hashed, 2^20) + logistic regression (SGD)
  url_lgbm_feats   engineered lexical / host features + LightGBM
  url_stack        LightGBM over engineered features + out-of-fold TF-IDF logit, isotonic-calibrated
                   (the one served by scamshield.models.url_model)

Leakage control: the `split` column of urls.parquet is domain-disjoint (registered domain); the
out-of-fold logits use GroupKFold on registered_domain; validation is split by domain again into an
early-stopping half and a calibration / threshold half.

Run from the repo root:  .venv/bin/python -m ml.url.train [--data ml/data/processed/urls.parquet]
"""

from __future__ import annotations

import argparse
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
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import SGDClassifier
from sklearn.model_selection import GroupKFold

from ml.bench.metrics import compute_metrics, threshold_for_fpr
from scamshield.models.url_features import FEATURE_NAMES, normalize_for_text, url_features_matrix
from scamshield.models.url_model import UrlScorer

ROOT = Path(__file__).resolve().parents[2]
ART_DIR = ROOT / "ml" / "artifacts"
THREADS = 8
HASHER = dict(analyzer="char", ngram_range=(1, 5), n_features=2**20, alternate_sign=False,
              norm=None, lowercase=False, dtype=np.float32)
LGB_PARAMS = dict(objective="binary", learning_rate=0.05, num_leaves=127, min_data_in_leaf=50,
                  feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                  num_threads=THREADS, verbose=-1, seed=0)


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def cap_per_source(df: pd.DataFrame, cap: int, caps: dict[str, int], seed: int = 0) -> pd.DataFrame:
    """Keep at most `cap` rows per (source, label) so no single feed's quirks dominate."""
    parts = []
    for (src, _), g in df.groupby(["source", "label"]):
        n = caps.get(src, cap)
        parts.append(g.sample(n, random_state=seed) if len(g) > n else g)
    return pd.concat(parts).sample(frac=1.0, random_state=seed).reset_index(drop=True)


def parallel_features(urls: list[str]) -> np.ndarray:
    """url_features_matrix over THREADS processes (same code as serving, just chunked)."""
    if len(urls) < 50_000:
        return url_features_matrix(urls)
    from joblib import Parallel, delayed

    step = -(-len(urls) // (THREADS * 4))
    parts = Parallel(n_jobs=THREADS)(delayed(url_features_matrix)(urls[i : i + step]) for i in range(0, len(urls), step))
    return np.vstack(parts)


def balanced_weights(y: np.ndarray) -> np.ndarray:
    pos = y.mean()
    return np.where(y == 1, 0.5 / pos, 0.5 / (1 - pos)).astype(np.float32)


class TextModel:
    """Hashed char n-gram TF-IDF + linear model, producing the arrays UrlScorer needs."""

    def __init__(self):
        self.hasher = HashingVectorizer(**HASHER)
        self.idf: np.ndarray | None = None

    def counts(self, urls) -> "sparse":
        return self.hasher.transform([normalize_for_text(u) for u in urls]).astype(np.float32)

    def fit_idf(self, X) -> None:
        df = np.bincount(X.indices, minlength=X.shape[1]).astype(np.float64)
        n = X.shape[0]
        self.idf = (np.log((1 + n) / (1 + df)) + 1.0).astype(np.float32)

    def tfidf(self, X):
        X = X.copy()
        X.data = (1.0 + np.log(X.data)) * self.idf[X.indices]
        norms = np.sqrt(np.asarray(X.multiply(X).sum(axis=1)).ravel())
        norms[norms == 0] = 1.0
        from scipy.sparse import diags

        return diags(1.0 / norms).astype(np.float32) @ X

    @staticmethod
    def fit_linear(X, y, w) -> SGDClassifier:
        clf = SGDClassifier(loss="log_loss", alpha=2e-7, max_iter=8, tol=None, random_state=0)
        clf.fit(X, y, sample_weight=w)
        return clf


def artifact(text: TextModel | None, clf, booster, calib, threshold, meta) -> dict:
    return {
        "feature_names": list(FEATURE_NAMES),
        "hasher": {k: (v if k != "dtype" else np.float32) for k, v in HASHER.items()},
        "idf": text.idf if text is not None else np.zeros(1, np.float32),
        "lr_coef": clf.coef_.ravel().astype(np.float32) if clf is not None else None,
        "lr_intercept": float(clf.intercept_[0]) if clf is not None else 0.0,
        "lgbm": booster.model_to_string() if booster is not None else None,
        "calib_x": calib[0] if calib is not None else None,
        "calib_y": calib[1] if calib is not None else None,
        "threshold": float(threshold),
        "meta": meta,
    }


def fit_isotonic(raw: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, y)
    return iso.X_thresholds_.astype(np.float64), iso.y_thresholds_.astype(np.float64)


def domain_halves(domains: pd.Series, seed: int = 1) -> np.ndarray:
    """Boolean mask: True for rows whose registered domain hashes into the first half."""
    h = pd.util.hash_pandas_object(domains.astype(str) + str(seed), index=False).to_numpy()
    return (h % 2) == 0


def load_training_frame(data: Path) -> pd.DataFrame:
    """urls.parquet plus the v3 add-on rows (legitimate shortener links) when present next to it."""
    cols = ["url", "label", "source", "registered_domain", "split"]
    frames = [pd.read_parquet(data, columns=cols)]
    extra = data.parent / "urls_additions_v3.parquet"
    if extra.exists():
        frames.append(pd.read_parquet(extra, columns=cols))
    df = pd.concat(frames, ignore_index=True).dropna(subset=["url"])
    df["url"] = df["url"].astype(str)
    df["registered_domain"] = df["registered_domain"].fillna("").astype(str)
    return df


def train_all(data: Path, cap: int, target_fpr: float, out_prefix: str = "url", exclude_source: tuple[str, ...] | None = None,
              save: bool = True) -> dict:
    t0 = time.time()
    df = load_training_frame(data)
    if exclude_source:
        df = df[~df["source"].str.startswith(tuple(exclude_source))]
    caps = {"phreshphish": int(cap * 2.5)}
    tr = cap_per_source(df[df.split == "train"], cap, caps)
    va = cap_per_source(df[df.split == "val"], max(cap // 4, 5000), {"phreshphish": cap})
    tr["norm"] = [normalize_for_text(u) for u in tr.url]
    tr = tr.drop_duplicates("norm").reset_index(drop=True)
    log(f"train rows {len(tr):,} (pos {tr.label.mean():.2%}), val rows {len(va):,}")

    y_tr = tr.label.to_numpy()
    w_tr = balanced_weights(y_tr)

    # --- text model + out-of-fold logits
    text = TextModel()
    C_tr = text.counts(tr.url)
    text.fit_idf(C_tr)
    X_tr = text.tfidf(C_tr)
    del C_tr
    oof = np.zeros(len(tr), dtype=np.float32)
    for k, (a, b) in enumerate(GroupKFold(n_splits=4).split(X_tr, y_tr, tr.registered_domain)):
        m = TextModel.fit_linear(X_tr[a], y_tr[a], w_tr[a])
        oof[b] = m.decision_function(X_tr[b])
        log(f"oof fold {k} done")
    clf = TextModel.fit_linear(X_tr, y_tr, w_tr)
    del X_tr
    log("text model fitted")

    def text_logit(urls):
        return clf.decision_function(text.tfidf(text.counts(urls))).astype(np.float32)

    F_tr = parallel_features(tr.url.tolist())
    F_va = parallel_features(va.url.tolist())
    L_va = text_logit(va.url)
    y_va = va.label.to_numpy()
    es = domain_halves(va.registered_domain)  # early-stopping half; ~es = calibration half
    log("features computed")

    # --- features-only LightGBM and the stack
    boosters = {}
    for name, Xtr, Xva in (("lgbm_feats", F_tr, F_va),
                           ("stack", np.column_stack([F_tr, oof]), np.column_stack([F_va, L_va]))):
        dtr = lgb.Dataset(Xtr, y_tr, weight=w_tr, free_raw_data=True)
        dva = lgb.Dataset(Xva[es], y_va[es], weight=balanced_weights(y_va[es]), reference=dtr)
        boosters[name] = lgb.train(LGB_PARAMS, dtr, num_boost_round=1500, valid_sets=[dva],
                                   callbacks=[lgb.early_stopping(50, verbose=False)])
        log(f"{name}: {boosters[name].best_iteration} trees")

    # --- calibration + thresholds on the held-out calibration half of val
    cal = ~es
    raw = {
        "tfidf_lr": 1 / (1 + np.exp(-L_va)),
        "lgbm_feats": boosters["lgbm_feats"].predict(F_va, num_threads=THREADS),
        "stack": boosters["stack"].predict(np.column_stack([F_va, L_va]), num_threads=THREADS),
    }
    trained_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = {}
    for name in ("tfidf_lr", "lgbm_feats", "stack"):
        calib = fit_isotonic(raw[name][cal], y_va[cal])
        p_cal = np.interp(raw[name][cal], *calib)
        thr = threshold_for_fpr(y_va[cal], p_cal, target_fpr)
        val_metrics = compute_metrics(y_va[cal], p_cal, thr, model=name, dataset="val_calibration_half")
        meta = {
            "model": f"{out_prefix}_{name}",
            "trained_at": trained_at,
            "train_rows": int(len(tr)),
            "train_pos_rate": float(y_tr.mean()),
            "val_rows": int(cal.sum()),
            "data_file": str(data.relative_to(ROOT) if data.is_absolute() else data),
            "excluded_sources": list(exclude_source or []),
            "target_val_fpr": target_fpr,
            "val_metrics": {k: val_metrics[k] for k in ("precision", "recall", "fpr", "roc_auc", "pr_auc",
                                                         "recall_at_fpr_0.1pct", "recall_at_fpr_1pct")},
            # operating points for the engine: block-level (threshold) and triage / escalation levels
            "thresholds_by_val_fpr": {f"{f:g}": threshold_for_fpr(y_va[cal], p_cal, f) for f in (0.001, 0.002, 0.005, 0.01, 0.05)},
            "lgbm_trees": int(boosters[name].best_iteration) if name in boosters else None,
            "features": len(FEATURE_NAMES),
        }
        art = artifact(text if name != "lgbm_feats" else None, clf if name != "lgbm_feats" else None,
                       boosters.get(name), calib, thr, meta)
        out[name] = art
        log(f"{name}: thr={thr:.4f} val recall={val_metrics['recall']:.4f} fpr={val_metrics['fpr']:.4%} "
            f"auc={val_metrics['roc_auc']:.4f}")
        if save:
            ART_DIR.mkdir(parents=True, exist_ok=True)
            path = ART_DIR / f"{out_prefix}_{name}.joblib"
            joblib.dump(art, path, compress=3)
            log(f"saved {path} ({path.stat().st_size / 1e6:.1f} MB)")
    log(f"total {time.time() - t0:.0f}s")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "ml/data/processed/urls.parquet"))
    ap.add_argument("--cap", type=int, default=100_000, help="max train rows per (source, label)")
    ap.add_argument("--target-fpr", type=float, default=0.002, help="validation FPR the threshold is set for")
    a = ap.parse_args()
    arts = train_all(Path(a.data), a.cap, a.target_fpr)
    # the served model: url_model.joblib == url_stack.joblib
    joblib.dump(arts["stack"], ART_DIR / "url_model.joblib", compress=3)
    UrlScorer(arts["stack"])  # load check
    print(json.dumps(arts["stack"]["meta"], indent=2))


if __name__ == "__main__":
    main()
