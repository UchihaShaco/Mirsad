"""Fit the served page score (CPU page_combo + GPU page encoder) on validation and benchmark it.

Served combination = logistic regression over [CPU logit (0 when the CPU model abstains), encoder
logit, abstain flag], fitted on the validation split (which includes engine-fetched live legitimate
pages); threshold = ≤0.5% FPR on validation legitimate pages. Written to
`ml/artifacts/page_served.json` (atomic rename), read by `scamshield.models.page_model`.

Benchmarks the served score and each model alone on the same rows: pages_test, its 1% prevalence
variant, Arabic and Arabic / Gulf slices, the SYNTHETIC UAE set and the live-legitimate test set,
into ml/results/page_served__*.json (and page_combo / <encoder> on the new slices).

    nice -n 19 .venv/bin/python -m ml.page.fit_served --encoder page_gte_ft_v2
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from ml.bench.metrics import compute_metrics, threshold_for_fpr
from ml.page.evaluate import base_rate_metrics, score_models, synthetic_frame, write_result
from ml.page.train import assign_roles, load_cache

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "ml" / "page" / "cache"
ARTIFACTS = ROOT / "ml" / "artifacts"
MAX_FPR = 0.005


def _logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def design(p_cpu, p_enc, abstain) -> np.ndarray:
    ab = np.asarray(abstain, dtype=float)
    return np.column_stack([_logit(p_cpu) * (1 - ab), _logit(p_enc), ab])


def served(params: dict, p_cpu, p_enc, abstain) -> np.ndarray:
    X = design(p_cpu, p_enc, abstain)
    z = X @ np.array([params["w_cpu"], params["w_enc"], params["w_abstain"]]) + params["b"]
    return 1 / (1 + np.exp(-z))


def cpu_scores(frame: pd.DataFrame, bundle: dict, side: dict) -> tuple[np.ndarray, np.ndarray]:
    s = score_models(frame, bundle, side)
    return s["page_combo_no_abstain"], np.isnan(s["page_combo"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoder", default="page_gte_ft_v2", help="name used by train_gpu --name")
    ap.add_argument("--latency", nargs="*", default=[], help="per-page latency JSON(s) from ml.page.served_latency")
    args = ap.parse_args()
    bundle = joblib.load(ARTIFACTS / "page_model.joblib")
    side = joblib.load(CACHE / "page_side_models.joblib")
    enc_meta = json.loads((CACHE / f"hf_meta__{args.encoder}.json").read_text())
    enc_val = pd.read_parquet(CACHE / f"val_scores__{args.encoder}.parquet")
    enc_test = pd.read_parquet(CACHE / f"hf_scores__{args.encoder}.parquet").drop_duplicates("source_id")

    df = load_cache()
    role = assign_roles(df)
    va = df[role == "val"].reset_index(drop=True)
    va = va.merge(enc_val[["source_id", "score"]].drop_duplicates("source_id"), on="source_id", how="inner")
    pc, ab = cpu_scores(va, bundle, side)
    y = va["label"].to_numpy()
    lr = LogisticRegression(C=1e3).fit(design(pc, va["score"], ab), y)
    params = {"w_cpu": float(lr.coef_[0, 0]), "w_enc": float(lr.coef_[0, 1]), "w_abstain": float(lr.coef_[0, 2]),
              "b": float(lr.intercept_[0]), "encoder": args.encoder, "encoder_checkpoint": enc_meta.get("checkpoint"),
              "n_val": int(len(va)), "n_val_live_legit": int((va["split"] == "live_val").sum())}
    s_va = served(params, pc, va["score"], ab)
    params["threshold"] = threshold_for_fpr(y, s_va, MAX_FPR)
    params["threshold_rule"] = f"<= {MAX_FPR:.1%} of legitimate validation pages (incl. engine-fetched live pages)"
    print("combination", params, flush=True)
    tmp = ARTIFACTS / "page_served.json.tmp"
    tmp.write_text(json.dumps(params, indent=2))
    os.replace(tmp, ARTIFACTS / "page_served.json")

    lat = {}
    for f in args.latency:
        lat.update(json.loads(Path(f).read_text()))
    frames = {"pages_test": df[df["split"] == "test"].reset_index(drop=True),
              "synthetic_uae": synthetic_frame().reset_index(drop=True),
              "live_legit_test": df[df["split"] == "live_test"].reset_index(drop=True)}
    report = {"params": params, "rows": []}
    for ds, t in frames.items():
        t = t.merge(enc_test[["source_id", "score"]], on="source_id", how="inner")
        pc, ab = cpu_scores(t, bundle, side)
        y = t["label"].to_numpy()
        cols = {"page_served": (served(params, pc, t["score"], ab), params["threshold"]),
                "page_combo": (np.where(ab, np.nan, pc), bundle["threshold"]),
                args.encoder: (t["score"].to_numpy(), enc_meta["threshold"])}
        subsets = {ds: np.ones(len(t), bool)}
        if ds == "pages_test":
            lang = t["lang"].fillna("")
            subsets[ds + "_arabic"] = ((lang == "ar") | (t["lang_ours"] == "ar")).to_numpy()
            subsets[ds + "_arabic_gulf"] = (subsets[ds + "_arabic"] | t["gulf_relevant"].fillna(False).to_numpy()
                                            | t["has_arabic"].fillna(False).to_numpy())
        for name, (s, thr) in cols.items():
            for sub, m in subsets.items():
                r = compute_metrics(y[m], s[m], thr, model=name, dataset=sub,
                                    latencies_ms=lat.get(name) if name in lat else None)
                if name in lat:
                    r["latency_note"] = lat.get(f"{name}_note", "")
                write_result(r)
                report["rows"].append(r)
            if ds == "pages_test":
                r = base_rate_metrics(y, s, thr, name, "pages_test_1pct", lat.get(name))
                write_result(r)
                report["rows"].append(r)
    (CACHE / "served_report.json").write_text(json.dumps(report, indent=2, default=str))
    for r in report["rows"]:
        print(f"{r['model']:<18} {r['dataset']:<26} n={r['n']:<6} P={r['precision']:.3f} R={r['recall']:.3f} "
              f"FPR={r['fpr']:.4f} FP={r['fp']} AUC={r['roc_auc'] or 0:.3f} R@0.1%={r['recall_at_fpr_0.1pct'] or 0:.3f} "
              f"R@1%={r['recall_at_fpr_1pct'] or 0:.3f}")


if __name__ == "__main__":
    main()
