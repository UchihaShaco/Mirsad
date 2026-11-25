"""Benchmark the page models and baselines on the held-out test sets.

Test sets:
  * pages_test        - the team's processed page set, `split == "test"` (registered domains first seen
                        last; no domain shared with train / val)
  * pages_test_1pct   - the same at a realistic 1% scam base rate (all legit pages, mean of 20 draws)
  * synthetic_uae     - SYNTHETIC UAE scenario pages (ml/page/synthetic_uae.py), reported separately

`--loso-only` runs leave-one-source-out instead (one refit per source, ~5 min each) into
cache/loso.json, which the next normal run folds into the report.

Writes ml/results/<model>__<dataset>.json, docs/img/page_*.png and ml/page/cache/eval_report.json.
Scores of the Hugging Face baselines (ml/page/baselines_hf.py) are merged in when present.

    .venv/bin/python -m ml.page.evaluate
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import joblib
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from ml.bench.metrics import compute_metrics
from ml.page.train import fit_all, load_cache, par_text_matrix
from scamshield.models import page_model
from scamshield.models.page_features import STRUCT_NAMES, extract
from scamshield.models.page_model import calibrated, combo_input, text_margin
from scamshield.schemas import PageSnapshot

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "ml" / "page" / "cache"
RESULTS = ROOT / "ml" / "results"
IMG = ROOT / "docs" / "img"
PROCESSED = ROOT / "ml" / "data" / "processed" / "pages.parquet"
SYNTHETIC = ROOT / "ml" / "data" / "synthetic_uae" / "pages.parquet"
IDX = {n: i for i, n in enumerate(STRUCT_NAMES)}
LEGIT_SENSITIVE_RX = re.compile(r"bank|\.gov|gov\.|police|ministry|tax|pay|wallet|secure|login|account|auth",
                                re.I)


def _sig(p, raw):
    return 1 / (1 + np.exp(-(p[0] * np.asarray(raw) + p[1])))


# ---------------------------------------------------------------------------------------------
# keyword / rule baseline (no learning): hand-written weights over the same extracted signals


def rule_score(s: np.ndarray) -> np.ndarray:
    s = np.atleast_2d(s)
    g = lambda n: s[:, IDX[n]]  # noqa: E731
    sensitive = (g("asks_password") + g("asks_card") + g("asks_otp") + g("asks_national_id") + g("asks_bank")) > 0
    brand = (g("brand_title_mismatch") + g("brand_form_mismatch") + g("brand_copyright_mismatch")) > 0
    r = (0.35 * sensitive + 0.25 * brand + 0.15 * ((g("form_action_external") + g("form_action_php")) > 0)
         + 0.10 * g("lexp_urgency") + 0.10 * g("lexp_verify") + 0.05 * g("lexp_payment") + 0.05 * g("lexp_prize")
         + 0.10 * ((g("js_scramble_score") > 1) | (g("js_telegram_api") > 0)) + 0.10 * g("url_free_host"))
    return np.clip(r, 0, 1)


KEYWORDS = re.compile(r"verify|suspend|locked|confirm your|update your|unusual activity|password|login|sign in|"
                      r"urgent|expire|winner|prize|refund|payment|تحقق|تحديث|تعليق|عاجل|مخالفه|جائزه|سداد|"
                      r"كلمه المرور|تسجيل الدخول")


def keyword_score(docs: list[str]) -> np.ndarray:
    return np.array([min(len(KEYWORDS.findall(d[:6000])) / 6.0, 1.0) for d in docs])


# ---------------------------------------------------------------------------------------------


def abstain_mask(df: pd.DataFrame) -> np.ndarray:
    return page_model.abstain_flags(np.vstack(df["struct"].to_numpy()), df["n_text_chars"].to_numpy())


def score_models(df: pd.DataFrame, bundle: dict, side: dict) -> dict[str, np.ndarray]:
    S = np.vstack(df["struct"].to_numpy())
    margin = bundle["text_lr"].decision_function(par_text_matrix(bundle, df["doc"].tolist()))
    raw = bundle["lgbm"].predict(combo_input(S, margin), raw_score=True, num_threads=8)
    combo = calibrated(bundle, raw)
    return {
        # served behaviour: no answer (NaN = not flagged) on pages with too little content
        "page_combo": np.where(abstain_mask(df), np.nan, combo),
        "page_combo_no_abstain": combo,
        "page_text_lr": _sig(side["text_calib"], margin),
        "page_struct_lgbm": _sig(side["struct_calib"], side["struct_lgbm"].predict(S, raw_score=True, num_threads=8)),
        "rules_baseline": rule_score(S),
        "keyword_baseline": keyword_score(df["doc"].tolist()),
    }


def latency_samples(bundle: dict, side: dict, n: int = 300) -> dict[str, list[float]]:
    """Single-thread, end-to-end (HTML parse + features + model) latency on processed test pages."""
    t = pq.read_table(PROCESSED, columns=["url", "html", "split"]).to_pandas()
    t = t[t["split"] == "test"].sample(n=min(n, (t["split"] == "test").sum()), random_state=0)
    pages = [PageSnapshot(url=u, final_url=u, html=h or "") for u, h in zip(t["url"], t["html"])]
    out: dict[str, list[float]] = {k: [] for k in ("page_combo", "page_text_lr", "page_struct_lgbm",
                                                    "rules_baseline", "keyword_baseline")}
    out["page_combo_no_abstain"] = out["page_combo"]
    page_model.score_page(pages[0])
    for p in pages:
        t0 = time.perf_counter()
        page_model.score_page(p)
        out["page_combo"].append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        f = extract(p.final_url, p.html)
        _sig(side["text_calib"], text_margin(bundle, [f.doc]))
        out["page_text_lr"].append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        f = extract(p.final_url, p.html)
        side["struct_lgbm"].predict(f.struct.reshape(1, -1), raw_score=True, num_threads=1)
        out["page_struct_lgbm"].append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        f = extract(p.final_url, p.html)
        rule_score(f.struct)
        out["rules_baseline"].append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        f = extract(p.final_url, p.html)
        keyword_score([f.doc])
        out["keyword_baseline"].append((time.perf_counter() - t0) * 1000)
    return out


def write_result(m: dict) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"{m['model']}__{m['dataset']}.json").write_text(json.dumps(m, indent=2))


def base_rate_metrics(y, s, thr, model, dataset, lat, rate=0.01, draws=20) -> dict:
    """Mean metrics over random draws that keep every legit page and enough scam pages for `rate`."""
    rng = np.random.default_rng(0)
    neg, pos = np.where(y == 0)[0], np.where(y == 1)[0]
    k = max(1, int(round(rate * len(neg) / (1 - rate))))
    ms = []
    for _ in range(draws):
        idx = np.concatenate([neg, rng.choice(pos, size=min(k, len(pos)), replace=False)])
        ms.append(compute_metrics(y[idx], s[idx], thr, model=model, dataset=dataset, latencies_ms=lat))
    out = dict(ms[0])
    for key, v in out.items():
        if isinstance(v, (int, float)) and key not in ("threshold",) and v is not None:
            vals = [m[key] for m in ms if m[key] is not None]
            out[key] = float(np.mean(vals)) if key not in ("n",) else int(np.mean(vals))
    out["base_rate"] = rate
    out["draws"] = draws
    return out


def slice_table(df: pd.DataFrame, s: np.ndarray, thr: float, masks: dict[str, np.ndarray]) -> list[dict]:
    rows = []
    y = df["label"].to_numpy()
    for name, m in masks.items():
        if m.sum() == 0:
            continue
        mm = compute_metrics(y[m], s[m], thr)
        rows.append({"slice": name, "n": int(m.sum()), "n_scam": int(y[m].sum()), "precision": mm["precision"],
                     "recall": mm["recall"], "f1": mm["f1"], "fpr": mm["fpr"], "fp": mm["fp"], "fn": mm["fn"],
                     "roc_auc": mm["roc_auc"]})
    return rows


def lang_bucket(lang) -> str:
    if lang == "en":
        return "en"
    if lang == "ar":
        return "ar"
    return "none/unknown" if lang is None or (isinstance(lang, float) and np.isnan(lang)) else "other"


def plot_confusions(entries: list[tuple[str, dict]], path: Path, title: str) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    n = len(entries)
    fig, axes = plt.subplots(1, n, figsize=(2.9 * n, 3.0))
    axes = np.atleast_1d(axes)
    for ax, (name, m) in zip(axes, entries):
        cm = np.array([[m["tn"], m["fp"]], [m["fn"], m["tp"]]])
        ax.imshow(cm, cmap="Blues")
        for (i, j), v in np.ndenumerate(cm):
            ax.text(j, i, str(v), ha="center", va="center", color="white" if v > cm.max() / 2 else "black")
        ax.set_xticks([0, 1], ["legit", "scam"])
        ax.set_yticks([0, 1], ["legit", "scam"])
        ax.set_xlabel("predicted")
        ax.set_title(name, fontsize=9)
    axes[0].set_ylabel("actual")
    fig.suptitle(title, fontsize=10)
    fig.tight_layout()
    IMG.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=110)
    plt.close(fig)


def loso(df: pd.DataFrame) -> list[dict]:
    """Leave-one-source-out: train on every other source, test on the held-out source (its test split if it
    has one, otherwise all its rows). Validation = a domain-hash 15% slice of the training rows."""
    from ml.page.train import _bucket

    rows = []
    usable = df[df["split"].isin(["train", "val", "test"])]
    for src in sorted(usable["source"].unique()):
        held = usable[usable["source"] == src]
        if (held["split"] == "test").any():
            held = held[held["split"] == "test"]
        rest = usable[(usable["source"] != src) & (usable["split"] != "test")]
        rest = rest[~rest["registered_domain"].isin(set(held["registered_domain"]))]
        is_val = rest["registered_domain"].map(_bucket) < 0.15
        print(f"LOSO {src}: train {int((~is_val).sum())} val {int(is_val.sum())} test {len(held)}", flush=True)
        bundle, side = fit_all(rest[~is_val].reset_index(drop=True), rest[is_val].reset_index(drop=True),
                               Cs=(16.0,), max_word=60_000, max_char=60_000)
        t = held.reset_index(drop=True)
        s = score_models(t, bundle, side)["page_combo"]
        m = compute_metrics(t["label"], s, bundle["threshold"])
        rows.append({"train_source": "all except " + src, "test": src,
                     **{k: m[k] for k in ("n", "tp", "fp", "tn", "fn", "precision", "recall", "f1", "fpr",
                                          "roc_auc", "pr_auc")}})
        print(rows[-1], flush=True)
    return rows


def synthetic_frame() -> pd.DataFrame:
    """The SYNTHETIC UAE scenario pages, featurised exactly like the corpus."""
    from ml.page.corpus import DOC_CHARS

    syn = pd.read_parquet(SYNTHETIC)
    feats = [extract(u, h) for u, h in zip(syn["url"], syn["html"])]
    syn["doc"] = [f.doc[:DOC_CHARS] for f in feats]
    syn["struct"] = [f.struct.tolist() for f in feats]
    syn["lang_ours"] = [f.lang for f in feats]
    syn["n_text_chars"] = [f.n_text_chars for f in feats]
    syn["page_title"] = [f.title for f in feats]
    syn["registered_domain"] = ""
    syn["gulf_relevant"] = True
    syn["has_arabic"] = syn["lang"] != "en"
    syn["split"] = "synthetic_uae"
    return syn.drop(columns=["html"])


def main() -> None:
    df = load_cache()
    bundle = joblib.load(ROOT / "ml" / "artifacts" / "page_model.joblib")
    side = joblib.load(CACHE / "page_side_models.joblib")
    thresholds = {"page_combo": bundle["threshold"], "page_combo_no_abstain": bundle["threshold"],
                  "page_text_lr": side["text_threshold"],
                  "page_struct_lgbm": side["struct_threshold"], "rules_baseline": 0.5, "keyword_baseline": 0.5}
    print("thresholds", thresholds, flush=True)
    lat = latency_samples(bundle, side)
    hf = {}
    for f in sorted(CACHE.glob("hf_scores__*.parquet")):
        name = f.stem.split("__", 1)[1]
        hf[name] = (pd.read_parquet(f), json.loads((CACHE / f"hf_meta__{name}.json").read_text()))

    frames = {"pages_test": df[df["split"] == "test"].reset_index(drop=True), "synthetic_uae": synthetic_frame()}
    report: dict = {"thresholds": thresholds, "headline": [], "slices": {}, "fp_legit_sensitive": {}, "loso": []}
    for ds, t in frames.items():
        y = t["label"].to_numpy()
        scores = score_models(t, bundle, side)
        entries = []
        for name, s in scores.items():
            m = compute_metrics(y, s, thresholds[name], model=name, dataset=ds, latencies_ms=lat[name])
            m["latency_note"] = "1 CPU thread, batch 1, end to end (HTML parse + features + model), 300 pages"
            write_result(m)
            report["headline"].append(m)
            entries.append((name, m))
            if ds == "pages_test":
                mb = base_rate_metrics(y, s, thresholds[name], name, ds + "_1pct", lat[name])
                write_result(mb)
                report["headline"].append(mb)
        for name, (sc, meta) in hf.items():
            j = t[["source_id", "label"]].merge(sc, on="source_id", how="inner")
            if j.empty:
                continue
            m = compute_metrics(j["label"], j["score"], meta["threshold"], model=name, dataset=ds,
                                latencies_ms=meta["latencies_ms"])
            m["sampled"] = bool(len(j) < len(t))
            m["latency_note"] = meta.get("latency_note", "")
            if meta.get("latencies_ms_gpu"):
                m["latency_ms_p50_gpu"] = float(np.percentile(meta["latencies_ms_gpu"], 50))
                m["latency_ms_p95_gpu"] = float(np.percentile(meta["latencies_ms_gpu"], 95))
            write_result(m)
            report["headline"].append(m)
            entries.append((name, m))
            if ds == "pages_test":
                mb = base_rate_metrics(j["label"].to_numpy(), j["score"].to_numpy(), meta["threshold"], name,
                                       ds + "_1pct", meta["latencies_ms"])
                write_result(mb)
                report["headline"].append(mb)
        plot_confusions(entries, IMG / f"page_confusion__{ds}.png", f"{ds} (n={len(t)})")

        ab = abstain_mask(t)
        report.setdefault("abstain", {})[ds] = {"n": int(len(t)), "abstained": int(ab.sum()),
                                                "abstained_scam": int((ab & (y == 1)).sum()),
                                                "abstained_legit": int((ab & (y == 0)).sum())}
        s = scores["page_combo"]
        S = np.vstack(t["struct"].to_numpy())
        sens = (S[:, IDX["asks_password"]] + S[:, IDX["asks_card"]] + S[:, IDX["asks_otp"]] +
                S[:, IDX["asks_national_id"]] + S[:, IDX["asks_bank"]]) > 0
        bankgov = t["registered_domain"].str.contains(LEGIT_SENSITIVE_RX, na=False).to_numpy() | \
            t["url"].str.contains(r"bank|\.gov|police|ministry", case=False, na=False).to_numpy()
        lb = t["lang"].map(lang_bucket).to_numpy()
        masks = {
            "all": np.ones(len(t), bool),
            "lang=en (dataset)": lb == "en", "lang=ar (dataset)": lb == "ar", "lang=other (dataset)": lb == "other",
            "lang unknown (dataset)": lb == "none/unknown",
            "lang=ar (detected)": (t["lang_ours"] == "ar").to_numpy(),
            "Arabic or Gulf-brand rows": (t["gulf_relevant"].fillna(False) | t["has_arabic"].fillna(False)
                                          | (t["lang"] == "ar")).to_numpy(),
            "very little text (<200 chars)": (t["n_text_chars"] < 200).to_numpy(),
            "page asks for password/card/OTP/ID": sens,
            "bank / government / payment-like domain": bankgov,
        }
        report["slices"][ds] = slice_table(t, s, thresholds["page_combo"], masks)
        for name, (sc, meta) in hf.items():  # same slices for the neural / pretrained models when they cover ds
            hs = t[["source_id"]].merge(sc, on="source_id", how="left")["score"].to_numpy()
            if np.isfinite(hs).mean() > 0.99:
                report.setdefault("slices_other", {}).setdefault(ds, {})[name] = slice_table(
                    t, hs, meta["threshold"], masks)
        legit = (y == 0) & (sens | bankgov)
        fp = legit & (s >= thresholds["page_combo"])
        report["fp_legit_sensitive"][ds] = {
            "n_legit_sensitive": int(legit.sum()), "n_fp": int(fp.sum()),
            "fpr": float(fp.sum() / max(1, legit.sum())),
            "fps": [{"url": t["url"][i], "title": t["page_title"][i][:80], "score": round(float(s[i]), 3),
                     "asks_password": bool(S[i, IDX["asks_password"]]), "lang": t["lang_ours"][i]}
                    for i in np.where(fp)[0]],
            "all_fps": [{"url": t["url"][i], "title": t["page_title"][i][:80], "score": round(float(s[i]), 3)}
                        for i in np.where((y == 0) & (s >= thresholds["page_combo"]))[0]],
        }
    if (CACHE / "loso.json").exists():  # written by `--loso-only`
        report["loso"] = json.loads((CACHE / "loso.json").read_text())
    report["latency_ms"] = {k: {"p50": float(np.percentile(v, 50)), "p95": float(np.percentile(v, 95)),
                                "max": float(np.max(v))} for k, v in lat.items()}
    (CACHE / "eval_report.json").write_text(json.dumps(report, indent=2, default=str))
    for m in report["headline"]:
        print(f"{m['model']:<28} {m['dataset']:<24} n={m['n']:<6} P={m['precision']:.3f} R={m['recall']:.3f} "
              f"F1={m['f1']:.3f} FPR={m['fpr']:.4f} AUC={m['roc_auc'] or 0:.3f} AP={m['pr_auc'] or 0:.3f} "
              f"R@1%={m['recall_at_fpr_1pct'] or 0:.3f} p50={m['latency_ms_p50'] or 0:.1f}ms", flush=True)


if __name__ == "__main__":
    random.seed(0)
    if "--loso-only" in sys.argv:
        (CACHE / "loso.json").write_text(json.dumps(loso(load_cache()), indent=2))
    else:
        main()
