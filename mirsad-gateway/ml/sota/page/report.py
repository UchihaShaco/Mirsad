"""Turn the raw outputs of visual_ref.py, llm_methods.py and ours.py into result files in the shared shape
(ml/bench/metrics.compute_metrics) and print the comparison tables.

    .venv/bin/python -m ml.sota.page.report

Writes ml/results/sota_page_<method>__<dataset>.json and ml/sota/page/cache/report.json.

Conventions
  * Every method in one table is scored on the same rows; a page a method could not answer (call or JSON
    failure, unreadable screenshot) counts as "not flagged" (score NaN), as in compute_metrics.
  * Threshold-free metrics come from each method's own score; the operating point is the method's own
    verdict (Phishpedia / PhishIntention: official threshold; LLM methods: their boolean or A/B answer;
    ours: thresholds fixed on validation).
  * `_1pct` datasets: precision and F1 at a 1% phishing prevalence computed from the measured recall and
    FPR, PR-AUC re-weighted to that prevalence. ROC-AUC and recall-at-FPR do not depend on prevalence.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_recall_curve

from ml.bench.metrics import compute_metrics
from ml.sota.page.common import (CACHE, RESULTS, ROOT, domain_consistent, kb_lookup, lang_bucket, llm_sample,
                                 meta, norm_brand, regdom, stage_score)

LLM_CALLS = {"knowphish_kpd_text": ("kpd_brand", "crp"), "phishllm_text": ("phishllm_brand", "crp"),
             "chatphishdetector_text": ("chatphish",), "phreshphish_llm": ("phreshphish_llm",)}
FORM = {
    "phishpedia": "official code + released weights (CC0), 277-brand reference list",
    "phishintention": "official code + released weights, static mode (live CRP locator disabled)",
    "knowphish_kpd_text": "re-implemented from the paper: local LLM brand + our KB + LLM CRP (text branch)",
    "knowphish_kpd_imgtext": "re-implemented: Phishpedia (official) logo brand OR LLM text brand, + KB + LLM CRP",
    "phishllm_text": "re-implemented from the paper: local LLM domain recall + LLM CRP, text only, no search",
    "chatphishdetector_text": "re-implemented from the paper's prompt on the local LLM, text only (no screenshot)",
    "phreshphish_llm": "PhreshPhish LLM baseline prompt (verbatim) on the local LLM instead of Gemini-2.5-Pro",
    "ours_page_combo": "ours (served CPU model)",
    "ours_page_gte_ft": "ours (fine-tuned gte-multilingual-base, GPU)",
}
OURS_THR = {"ours_page_combo": json.loads((ROOT / "ml/artifacts/page_model_meta.json").read_text())["threshold"],
            "ours_page_gte_ft": json.loads((ROOT / "ml/page/cache/hf_meta__page_gte_ft.json").read_text())["threshold"]}
PP = json.loads((Path(__file__).resolve().parent / "phreshphish_table4.json").read_text())
PP_PAPER = PP["published"]
RATE_COLS = PP["base_rates"]
PP_RATES = {float(k): v for k, v in PP["draws_per_rate"].items()}


def write(m: dict) -> dict:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"{m['model']}__{m['dataset']}.json").write_text(json.dumps(m, indent=2))
    return m


def metrics(y, score, pred, model, dataset, seconds, extra=None) -> dict:
    """compute_metrics on the score, with the confusion matrix taken from the method's own verdict."""
    y = np.asarray(y, int)
    s = np.asarray(score, float)
    p = np.asarray(pred, bool)
    m = compute_metrics(y, s, 0.5, model=f"sota_page_{model}", dataset=dataset,
                        latencies_ms=np.asarray(seconds, float) * 1000)
    tp, fp = int(np.sum(p & (y == 1))), int(np.sum(p & (y == 0)))
    tn, fn = int(np.sum(~p & (y == 0))), int(np.sum(~p & (y == 1)))
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    m.update(tp=tp, fp=fp, tn=tn, fn=fn, precision=prec, recall=rec, fpr=fp / (fp + tn) if fp + tn else 0.0,
             f1=2 * prec * rec / (prec + rec) if prec + rec else 0.0, threshold=None,
             accuracy=(tp + tn) / len(y) if len(y) else 0.0,
             operating_point="method's own verdict", form=FORM.get(model, ""))
    m.update(extra or {})
    return m


def at_prevalence(m: dict, y, score, rate: float = 0.01) -> dict:
    out = dict(m)
    r, f = m["recall"], m["fpr"]
    prec = r * rate / (r * rate + f * (1 - rate)) if r * rate + f * (1 - rate) else 0.0
    y = np.asarray(y, int)
    s = np.asarray(score, float)
    s = np.where(np.isfinite(s), s, np.nanmin(s) - 1 if np.isfinite(s).any() else 0)
    w = np.where(y == 1, rate / (1 - rate) * (y == 0).sum() / max((y == 1).sum(), 1), 1.0)
    out.update(dataset=m["dataset"] + "_1pct", precision=prec, f1=2 * prec * r / (prec + r) if prec + r else 0.0,
               pr_auc=float(average_precision_score(y, s, sample_weight=w)) if 0 < y.sum() < len(y) else None,
               prevalence=rate, prevalence_method="analytic from recall and FPR; PR-AUC re-weighted")
    return out


# --------------------------------------------------------------------------------------- visual


def load_visual(method: str) -> pd.DataFrame | None:
    p = CACHE / f"visual__{method}.parquet"
    return pd.read_parquet(p) if p.exists() else None


def brand_match(pred: str | None, truth: str | None) -> bool | None:
    if not truth or not isinstance(truth, str):
        return None
    a, b = norm_brand(pred or ""), norm_brand(truth)
    if not a:
        return False
    return a == b or (len(a) >= 4 and a in b) or (len(b) >= 4 and b in a)


def visual_tables(df: pd.DataFrame) -> list[dict]:
    out = []
    shared = set(llm_sample("llm_trop")["source_id"])
    for method in ("phishpedia", "phishintention"):
        v = load_visual(method)
        if v is None:
            continue
        d = df.merge(v, on="source_id")
        for ds, rows in (("trop_shared600", d[d.source_id.isin(shared)]),
                         ("trop", d[d.source == "knowphish_tr_op"]),
                         ("phishpedia30k_indist", d[d.source == "phishpedia_phish30k"])):
            if len(rows) < 20:
                continue
            flagged = rows[(rows.pred == 1) & rows.brand.notna()]
            bm = [brand_match(t, b) for t, b in zip(flagged.target, flagged.brand)]
            extra = {"rows_done_of_set": int(len(rows)), "hardware": "GPU (shared RTX-class, 1 page at a time)",
                     "brand_id_accuracy": float(np.mean(bm)) if bm else None, "brand_id_n": len(bm),
                     "error_rate": float(rows.error.notna().mean())}
            if ds == "phishpedia30k_indist":  # phishing only: recall is the only detection metric
                extra["note"] = "Phishpedia's own benchmark (all phishing): in-distribution for Phishpedia"
            m = metrics(rows.label, rows.score, rows.pred == 1, method, ds, rows.seconds, extra)
            out.append(write(m))
            if ds != "phishpedia30k_indist":
                out.append(write(at_prevalence(m, rows.label, rows.score)))
    return out


# --------------------------------------------------------------------------------------- LLM


def load_calls(sample: str) -> pd.DataFrame:
    p = CACHE / f"llm_calls__{sample}.jsonl"
    if not p.exists():
        return pd.DataFrame()
    recs = [json.loads(line) for line in p.read_text().splitlines() if line]
    # first attempt per (page, call) is the one scored, so the failure rate is the first-attempt rate
    return pd.DataFrame(recs).drop_duplicates(["source_id", "call"], keep="first")


def llm_predictions(sample: str, rows: pd.DataFrame, visual: pd.DataFrame | None) -> dict[str, pd.DataFrame]:
    calls = load_calls(sample)
    if calls.empty:
        return {}
    by = {(r.source_id, r.call): r for r in calls.itertuples(index=False)}
    out: dict[str, list[dict]] = {k: [] for k in LLM_CALLS}
    if visual is not None:
        out["knowphish_kpd_imgtext"] = []
        vis = visual.set_index("source_id")
    for r in rows.itertuples(index=False):
        got = {c: by.get((r.source_id, c)) for c in ("kpd_brand", "phishllm_brand", "crp", "chatphish",
                                                       "phreshphish_llm")}
        if any(v is None for v in got.values()):
            continue  # not run yet: leave the page out of every LLM method (same rows for all)
        ok = {c: v.parsed is not None for c, v in got.items()}
        sec = {c: v.seconds for c, v in got.items()}
        page_rd = r.registered_domain or regdom(r.url)
        crp = ok["crp"] and got["crp"].parsed.get("answer") == "A"
        # KnowPhish KPD (text branch)
        brand = got["kpd_brand"].parsed.get("brand") if ok["kpd_brand"] else None
        key, doms = kb_lookup(brand)
        incon_text = bool(key) and not domain_consistent(page_rd, doms)
        fail = not (ok["kpd_brand"] and ok["crp"])
        out["knowphish_kpd_text"].append(dict(
            source_id=r.source_id, score=np.nan if fail else stage_score(incon_text, crp),
            pred=(not fail) and incon_text and crp, fail=fail, seconds=sec["kpd_brand"] + sec["crp"],
            target=key, kb_hit=bool(key)))
        if visual is not None and r.source_id in vis.index:
            vv = vis.loc[r.source_id]
            incon = bool(vv.pred == 1) or incon_text
            out["knowphish_kpd_imgtext"].append(dict(
                source_id=r.source_id, score=np.nan if fail else stage_score(incon, crp),
                pred=(not fail) and incon and crp, fail=fail,
                seconds=sec["kpd_brand"] + sec["crp"] + float(vv.seconds),
                target=vv.target if vv.pred == 1 else key, kb_hit=bool(key) or vv.pred == 1))
        # PhishLLM (text only)
        dom = got["phishllm_brand"].parsed.get("domain") if ok["phishllm_brand"] else None
        d_rd = regdom(dom) if dom and "." in str(dom) else ""
        incon_d = bool(d_rd) and not domain_consistent(page_rd, {d_rd})
        fail = not (ok["phishllm_brand"] and ok["crp"])
        out["phishllm_text"].append(dict(
            source_id=r.source_id, score=np.nan if fail else stage_score(incon_d, crp),
            pred=(not fail) and incon_d and crp, fail=fail, seconds=sec["phishllm_brand"] + sec["crp"],
            target=d_rd or None, kb_hit=bool(d_rd)))
        # ChatPhishDetector
        cp = got["chatphish"].parsed if ok["chatphish"] else {}
        out["chatphishdetector_text"].append(dict(
            source_id=r.source_id, score=cp.get("phishing_score", np.nan) / 10 if cp else np.nan,
            pred=bool(cp.get("phishing")), fail=not ok["chatphish"], seconds=sec["chatphish"],
            target=cp.get("brands"), kb_hit=None))
        # PhreshPhish LLM baseline
        pp = got["phreshphish_llm"].parsed if ok["phreshphish_llm"] else {}
        out["phreshphish_llm"].append(dict(
            source_id=r.source_id, score=float(pp["score"]) if pp else np.nan, pred=bool(pp.get("phishing")),
            fail=not ok["phreshphish_llm"], seconds=sec["phreshphish_llm"], target=None, kb_hit=None))
    return {k: pd.DataFrame(v) for k, v in out.items() if v}


def c1_latency(sample: str) -> dict[str, float]:
    """Median seconds per page with one page and one call at a time (llm_methods.py --c1)."""
    p = CACHE / f"llm_latency_c1__{sample}.jsonl"
    if not p.exists():
        return {}
    d = pd.DataFrame([json.loads(line) for line in p.read_text().splitlines() if line])
    per = d.pivot_table(index="source_id", columns="call", values="seconds", aggfunc="first")
    return {name: float(per[list(calls)].sum(axis=1).median()) for name, calls in LLM_CALLS.items()
            if set(calls) <= set(per.columns)}


def ours_frame() -> pd.DataFrame | None:
    p = CACHE / "ours__pp_test.parquet"
    return pd.read_parquet(p) if p.exists() else None


def llm_tables(df: pd.DataFrame) -> tuple[list[dict], list[dict], dict]:
    results, slices, preds_all = [], [], {}
    ours = ours_frame()
    pp_vis = load_visual("phishpedia")
    for sample in ("llm_pp", "llm_arabic", "llm_trop"):
        rows = llm_sample(sample).merge(df[["source_id", "registered_domain"]], on="source_id", how="left",
                                        suffixes=("_s", ""))
        if "registered_domain_s" in rows:
            rows = rows.drop(columns=["registered_domain_s"])
        preds = llm_predictions(sample, rows, pp_vis if sample == "llm_trop" else None)
        if not preds:
            continue
        common = set.intersection(*(set(p.source_id) for p in preds.values()))
        c1 = c1_latency(sample)
        preds_all[sample] = preds
        for name, p in preds.items():
            d = rows.merge(p, on="source_id")
            d = d[d.source_id.isin(common)]
            extra = {"json_failure_rate": float(d.fail.mean()), "hardware": "GPU, vLLM Qwen3.5-9B, 12 parallel",
                     "seconds_per_page_note": "sum of this method's LLM call latencies under 12-way concurrency",
                     "kb_or_brand_hit_rate": float(d.kb_hit.mean()) if d.kb_hit.notna().any() else None,
                     "seconds_per_page_one_at_a_time_p50": c1.get(name)}
            fl = d[d.pred & d.brand.notna()]
            if len(fl) and name in ("knowphish_kpd_text", "knowphish_kpd_imgtext", "phishllm_text"):
                extra["brand_id_accuracy"] = float(np.mean([brand_match(t, b) for t, b in zip(fl.target, fl.brand)]))
                extra["brand_id_n"] = int(len(fl))
            m = write(metrics(d.label, d.score, d.pred, name, sample, d.seconds, extra))
            results.append(m)
            if sample != "llm_arabic":
                results.append(write(at_prevalence(m, d.label, d.score)))
            for lb, g in d.groupby(d.lang.map(lang_bucket)):
                mm = metrics(g.label, g.score, g.pred, name, sample, g.seconds)
                slices.append({"sample": sample, "method": name, "lang": lb, "n": len(g), "n_phish": int(g.label.sum()),
                               **{k: mm[k] for k in ("precision", "recall", "fpr", "roc_auc")}})
        if ours is not None and sample != "llm_trop":
            d = rows.merge(ours, on="source_id")
            d = d[d.source_id.isin(common)]
            for name, col in (("ours_page_combo", "page_combo"), ("ours_page_gte_ft", "page_gte_ft")):
                thr = OURS_THR[name]
                sec = d.page_combo_ms / 1000 if col == "page_combo" else np.full(len(d), np.nan)
                extra = {"hardware": "1 CPU thread" if col == "page_combo" else "GPU bf16 (latency: page benchmark)",
                         "threshold_fixed_on": "validation (<=0.5% legit flagged)"}
                m = metrics(d.label, d[col], d[col].fillna(-1) >= thr, name, sample, sec, extra)
                if col == "page_gte_ft":  # single-page GPU latency measured by the page benchmark
                    gpu = json.loads((ROOT / "ml/page/cache/encoder_serving.json").read_text())["gpu_torch_bf16_ms"]
                    m.update(latency_ms_p50=gpu["p50"], latency_ms_p95=gpu["p95"],
                             latency_note="ml/page/cache/encoder_serving.json, batch 1, bf16, shared GPU")
                results.append(write(m))
                if sample != "llm_arabic":
                    results.append(write(at_prevalence(m, d.label, d[col])))
                for lb, g in d.groupby(d.lang.map(lang_bucket)):
                    mm = metrics(g.label, g[col], g[col].fillna(-1) >= thr, name, sample, np.zeros(len(g)))
                    slices.append({"sample": sample, "method": name, "lang": lb, "n": len(g),
                                   "n_phish": int(g.label.sum()),
                                   **{k: mm[k] for k in ("precision", "recall", "fpr", "roc_auc")}})
    return results, slices, preds_all


# --------------------------------------------------------------------------------------- PhreshPhish protocol


def p_at_recall(y, s, target=0.90) -> float:
    prec, rec, _ = precision_recall_curve(y, s)
    ok = rec >= target
    return float(prec[ok].max()) if ok.any() else 0.0


def base_rate_protocol(y, s, seed=0) -> dict:
    """PhreshPhish (arXiv 2507.10854, Sec. 5): keep every benign page, draw phishing pages without
    replacement to the base rate, m draws per rate (586/296/59/29/5); 24% = one draw. AP and P@R=0.90."""
    y = np.asarray(y, int)
    s = np.asarray(s, float)
    s = np.where(np.isfinite(s), s, np.nanmin(s) - 1)
    rng = np.random.default_rng(seed)
    neg, pos = np.where(y == 0)[0], np.where(y == 1)[0]
    out = {}
    for rate in RATE_COLS:
        k = max(1, int(round(rate * len(neg) / (1 - rate))))
        draws = PP_RATES[rate]
        aps, prs = [], []
        for _ in range(draws):
            idx = np.concatenate([neg, rng.choice(pos, size=min(k, len(pos)), replace=False)])
            aps.append(average_precision_score(y[idx], s[idx]))
            prs.append(p_at_recall(y[idx], s[idx]))
        out[str(rate)] = {"n_phish_per_draw": int(k), "draws": draws, "ap": float(np.mean(aps)),
                          "ap_p2.5": float(np.percentile(aps, 2.5)), "ap_p97.5": float(np.percentile(aps, 97.5)),
                          "p@r90": float(np.mean(prs))}
    return out


def weighted_protocol(y, s) -> dict:
    """Same quantities for a small balanced sample: positives re-weighted to each base rate (expected AP),
    P@R=0.90 from the threshold that reaches 90% recall. Only for methods too slow to run on all rows."""
    y = np.asarray(y, int)
    s = np.asarray(s, float)
    s = np.where(np.isfinite(s), s, np.nanmin(s) - 1)
    out = {}
    for rate in RATE_COLS:
        w = np.where(y == 1, rate / (1 - rate) * (y == 0).sum() / y.sum(), 1.0)
        prec, rec, _ = precision_recall_curve(y, s, sample_weight=w)
        ok = rec >= 0.9
        out[str(rate)] = {"ap": float(average_precision_score(y, s, sample_weight=w)),
                          "p@r90": float(prec[ok].max()) if ok.any() else 0.0}
    return out


def phreshphish_check(df: pd.DataFrame, preds_all: dict) -> dict:
    ours = ours_frame()
    res: dict = {"paper": PP_PAPER, "rates": RATE_COLS}
    if ours is not None:
        d = df[(df.source == "phreshphish") & (df.source_split == "test") & (df.split == "test")].merge(ours,
                                                                                                      on="source_id")
        res["rows"] = {"n": int(len(d)), "n_phish": int(d.label.sum()), "n_benign": int((d.label == 0).sum())}
        for name, col in (("ours_page_combo", "page_combo"), ("ours_page_gte_ft", "page_gte_ft")):
            res[name] = base_rate_protocol(d.label, d[col])
            # with only 4,835 benign pages a 0.05% draw holds 2 phishing pages, so also give the expectation
            res[f"{name} (all rows, re-weighted)"] = weighted_protocol(d.label, d[col])
            m = compute_metrics(d.label, d[col], OURS_THR[name], model=f"sota_page_{name}", dataset="pp_official_test")
            m.update(form=FORM[name], phreshphish_protocol=res[name],
                     note="PhreshPhish official-test rows that are also in our leak-free test split")
            write(m)
    if "llm_pp" in preds_all:
        for name, p in preds_all["llm_pp"].items():
            d = llm_sample("llm_pp").merge(p, on="source_id")
            res[f"{name} (600-page sample, re-weighted)"] = weighted_protocol(d.label, d.score)
        if ours is not None:
            d = llm_sample("llm_pp").merge(ours, on="source_id")
            for name, col in (("ours_page_combo", "page_combo"), ("ours_page_gte_ft", "page_gte_ft")):
                res[f"{name} (600-page sample, re-weighted)"] = weighted_protocol(d.label, d[col])
    return res


# --------------------------------------------------------------------------------------- tables


def fmt(x, pct=False):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{100 * x:.1f}%" if pct else f"{x:.3f}"


def table(results: list[dict], dataset: str) -> str:
    rows = [m for m in results if m["dataset"] == dataset]
    if not rows:
        return ""
    head = ("| method | form | n | TP/FP/TN/FN | precision | recall | FPR | ROC-AUC | PR-AUC | R@1%FPR | "
            "s/page p50 | fail |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n")
    body = ""
    for m in rows:
        lat = m.get("latency_ms_p50")
        body += (f"| {m['model'].removeprefix('sota_page_')} | {m.get('form', '')} | {m['n']} | "
                 f"{m['tp']}/{m['fp']}/{m['tn']}/{m['fn']} | {fmt(m['precision'])} | {fmt(m['recall'])} | "
                 f"{fmt(m['fpr'], True)} | {fmt(m['roc_auc'])} | {fmt(m['pr_auc'])} | "
                 f"{fmt(m['recall_at_fpr_1pct'])} | {fmt(lat / 1000 if lat is not None else None)} | "
                 f"{fmt(m.get('json_failure_rate', m.get('error_rate')), True)} |\n")
    return f"\n#### {dataset}\n\n" + head + body


def main() -> None:
    df = meta()
    results = visual_tables(df)
    llm_res, slices, preds_all = llm_tables(df)
    results += llm_res
    pp = phreshphish_check(df, preds_all)
    loso = json.loads((ROOT / "ml/page/cache/loso.json").read_text())
    trop_loso = next((x for x in loso if x["test"] == "knowphish_tr_op"), None)
    (CACHE / "report.json").write_text(json.dumps({"results": results, "slices": slices, "phreshphish": pp,
                                                   "ours_trop_loso": trop_loso}, indent=2, default=float))
    for ds in ("llm_pp", "llm_pp_1pct", "llm_arabic", "llm_trop", "llm_trop_1pct", "trop_shared600",
               "trop_shared600_1pct", "trop", "trop_1pct", "phishpedia30k_indist"):
        print(table(results, ds))
    print("\n#### per-language slices\n\n| sample | method | lang | n (phish) | precision | recall | FPR | ROC-AUC |\n"
          "|---|---|---|---|---|---|---|---|")
    for s in slices:
        print(f"| {s['sample']} | {s['method']} | {s['lang']} | {s['n']} ({s['n_phish']}) | {fmt(s['precision'])} | "
              f"{fmt(s['recall'])} | {fmt(s['fpr'], True)} | {fmt(s['roc_auc'])} |")
    print("\n#### PhreshPhish protocol (AP / P@R=0.90 by base rate)\n")
    print("| system | " + " | ".join(f"{100 * r:g}%" for r in RATE_COLS) + " |\n|---|" + "---|" * len(RATE_COLS))
    for name, v in list(pp["paper"].items()) + [(k, v) for k, v in pp.items() if k not in ("paper", "rates", "rows")]:
        if isinstance(v, dict) and "ap" in v:
            cells = [f"{a:.3f} / {b:.3f}" for a, b in zip(v["ap"], v["p@r90"])]
        else:
            cells = [f"{v[str(r)]['ap']:.3f} / {v[str(r)]['p@r90']:.3f}" for r in RATE_COLS]
        print(f"| {name} | " + " | ".join(cells) + " |")
    print("\nrows:", pp.get("rows"), "\nours on TR-OP, leave-one-source-out:", trop_loso)


if __name__ == "__main__":
    main()
