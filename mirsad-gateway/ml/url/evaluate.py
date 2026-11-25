"""Score our URL models on the standard benchmark datasets and write the trap analysis.

Writes ml/results/<model>__<dataset>.json for every model x dataset, plus
ml/results/traps/<model>.json (per-source breakdown, bias slices, UAE false-positive counts; the URLs themselves
under the git-ignored data/results_full/).

Run from the repo root:  .venv/bin/python -m ml.url.evaluate [--models url_stack url_tfidf_lr url_lgbm_feats]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np

from ml.bench.datasets import standard_datasets
from ml.bench.rowlevel import split
from ml.bench.runner import RESULTS_DIR, evaluate
from scamshield.models.url_model import ENSEMBLE_META, EnsembleScorer, UrlScorer, _load

ROOT = Path(__file__).resolve().parents[2]
ART_DIR = ROOT / "ml" / "artifacts"
SERVED_ENSEMBLE = "url_ensemble_cpu"


def per_source(df, scores, thr) -> list[dict]:
    rows = []
    for (src, lab), g in df.groupby(["source", "label"]):
        s = scores[g.index.to_numpy()]
        flagged = int((s >= thr).sum())
        rows.append({"source": src, "label": int(lab), "n": int(len(g)), "flagged": flagged,
                     "rate": flagged / len(g), "metric": "recall" if lab == 1 else "fpr"})
    return rows


def run(models: list[str], datasets: dict | None = None) -> None:
    datasets = datasets or standard_datasets()
    for name in models:
        if name == SERVED_ENSEMBLE:  # what score_url serves: stack + int8 ONNX transformer (ml/url/export_onnx.py)
            scorer, bulk = _load(ART_DIR, threads=1), _load(ART_DIR, threads=8)
            if not isinstance(scorer, EnsembleScorer):
                raise SystemExit("ensemble artifacts missing or not loadable")
            ens = json.loads((ART_DIR / ENSEMBLE_META).read_text())
            meta = {**scorer.meta, "target_val_fpr": ens["val_fpr_target"], "val_metrics": ens["val_metrics"],
                    "thresholds_by_val_fpr": ens["thresholds_by_val_fpr"]}
        else:
            art = joblib.load(ART_DIR / f"{name}.joblib")
            scorer = bulk = UrlScorer(art)
            meta = art["meta"]
        dsets = datasets
        if name == SERVED_ENSEMBLE:  # int8 transformer on CPU: score a fixed 10k sample of the big test slices
            keep = set(datasets["urls_test"].url.sample(10_000, random_state=0))
            dsets = {k: (v[v.url.isin(keep)] if len(v) > 60_000 else v) for k, v in datasets.items()}
        thr = scorer.threshold
        triage_thr = meta["thresholds_by_val_fpr"]["0.01"]
        traps: dict = {"model": name, "threshold": thr, "triage_threshold": triage_thr, "meta": meta}
        # the big slices overlap (they are subsets of urls_test): score every distinct URL once
        uniq = sorted({u for df in dsets.values() for u in df.url.astype(str)})
        lookup = dict(zip(uniq, bulk.score_batch(uniq)))
        for dname, df in dsets.items():
            sampled = len(df) < len(datasets[dname])
            df = df.reset_index(drop=True)
            scores = np.array([lookup[u] for u in df.url.astype(str)])
            note = f"random sample of {len(df)} rows (10k-row sample of urls_test)" if sampled else ""
            res = evaluate(name, scorer, (dname, df), thr, scores=scores, note=note)
            tri = evaluate(f"{name}@triage", scorer, (dname, df), triage_thr, scores=scores, latency_n=200,
                           note="triage operating point: threshold set for 1% FPR on validation; "
                                "URLs above it are escalated to the page check, not blocked" + (f"; {note}" if note else ""))
            print(f"{name:16s} {dname:34s} P={res['precision']:.4f} R={res['recall']:.4f} FPR={res['fpr']:.4%} "
                  f"| triage R={tri['recall']:.4f} FPR={tri['fpr']:.4%} | p50 {res['latency_ms_p50']:.3f} ms", flush=True)
            if dname in ("urls_test", "urls_fresh_test"):
                traps[f"{dname}_by_source"] = per_source(df, scores, thr)
            if dname == "urls_test":
                from ml.bench.datasets import _has_path

                hp = _has_path(df).to_numpy()
                y = df.label.to_numpy()
                slices = {}
                for sl, m in {"legit_with_path": (y == 0) & hp, "legit_bare": (y == 0) & ~hp,
                              "phish_with_path": (y == 1) & hp, "phish_bare": (y == 1) & ~hp}.items():
                    slices[sl] = {"n": int(m.sum()), "flagged_rate": float((scores[m] >= thr).mean()) if m.any() else None,
                                  "flagged_rate_triage": float((scores[m] >= triage_thr).mean()) if m.any() else None}
                traps["path_bias_slices"] = slices
            if dname == "uae_legit":
                fl = scores >= thr
                traps["uae_legit"] = {"n": int(len(df)), "fp": int(fl.sum()),
                                      "fp_triage": int((scores >= triage_thr).sum()),
                                      "false_positives": [{"url": u, "score": round(float(v), 4)}
                                                          for u, v in sorted(zip(df.url[fl], scores[fl]), key=lambda t: -t[1])],
                                      "top_scores": [{"url": u, "score": round(float(v), 4)} for u, v in
                                                     sorted(zip(df.url, scores), key=lambda t: -t[1])[:15]]}
        out = RESULTS_DIR / "traps" / f"{name}.json"
        split(traps, out)  # the UAE false-positive and top-score URLs go to data/results_full/ only


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=[SERVED_ENSEMBLE, "url_stack", "url_tfidf_lr", "url_lgbm_feats"])
    run(ap.parse_args().models)


if __name__ == "__main__":
    main()
