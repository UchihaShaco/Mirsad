"""Regenerate docs/BENCHMARKS.md from everything in ml/results/.

Any JSON in ml/results/*.json with the compute_metrics() shape is picked up (URL models, page models,
the full pipeline), grouped by dataset. Trap analyses come from ml/results/traps/*.json and the
leave-one-source-out run from ml/results/loso/*.json.

Run from the repo root:  .venv/bin/python -m ml.bench.report
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "ml" / "results"
OUT = ROOT / "docs" / "BENCHMARKS.md"
IMG = ROOT / "docs" / "img"

OURS_PREFIX = "url_"
# the model score_url serves: the stack + transformer ensemble when its artifacts exist, else the stack
SERVED = "url_ensemble_cpu" if (ROOT / "ml" / "artifacts" / "url_ensemble.json").exists() else "url_stack"
DATASET_ORDER = [
    ("urls_test", "Domain-split test set (all sources)",
     "Held-out registered domains (v2: 4,343,646 URLs, 51.8% phishing, 1.85M registered domains, split by domain, "
     "newest phishing in test); no registered domain in this set appears in training."),
    ("urls_test_noshort", "Domain-split test, URL-shortener links removed",
     "The engine expands shortener links before scoring, so this is the population the URL model sees live."),
    ("urls_test_nohf", "Domain-split test, without rows from Hugging Face datasets",
     "Same test set minus the sources the public HF models were trained on, so their numbers are not inflated by "
     "having seen these rows."),
    ("urls_fresh_test", "Fresh feed test (imitates the hidden test set): all rows",
     "Phishing pulled from live feeds in the last 48 h before the build and legitimate domains never in urls.parquet. "
     "87.6% of its phishing rows are bare domains (mostly CERT Polska) while most legitimate rows are deep pages, "
     "the reverse of the classic bias, so it is also reported split in two below."),
    ("urls_fresh_test_fullurl", "Fresh feed test: full URLs only (domain_only = false)", ""),
    ("urls_fresh_test_domainonly", "Fresh feed test: bare domains only (domain_only = true)", ""),
    ("urls_test_deeplegit_vs_barephish", "Bias trap: legitimate deep links vs phishing bare domains",
     "Test rows where the usual shortcut points the wrong way: legitimate URLs that have a path, phishing URLs that do not."),
    ("urls_test_shorteners", "Shortener links only (v2 test + v3 legitimate shortener add-on, test split)",
     "Shortener URLs are opaque; legitimate ones carry weak labels (links seen on crawled pages, feed matches removed)."),
    ("uae_legit", "Real UAE sites: official government / bank / utility URLs (clean false-positive test)",
     "The v2 rows of uae_legit_v3 (in_v2 = true). All legitimate, mostly deep links; every flag is a false positive. "
     "No UAE-legit row was used to train or tune the shipped model."),
    ("uae_legit_v3_new", "Real UAE sites added in v3 (airlines, retail, couriers, telcos)", "All legitimate."),
]
BASE_RATES = (0.01, 0.0005)


def load_results() -> list[dict]:
    out = []
    for p in sorted(RESULTS.glob("*.json")):
        try:
            r = json.loads(p.read_text())
        except json.JSONDecodeError:
            continue
        if isinstance(r, dict) and {"model", "dataset", "tp", "fp"} <= r.keys():
            r["_img"] = IMG / f"cm__{p.stem}.png"
            out.append(r)
    return out


def f(v, pct=False, nd=4):
    if v is None:
        return "–"
    if pct:
        return f"{100 * v:.2f}%"
    if isinstance(v, int):
        return f"{v:,}"
    return f"{v:.{nd}f}"


def prec_at(r: dict, base: float):
    """Precision this operating point would have at a given scam prevalence."""
    R, F = r["recall"], r["fpr"]
    if R is None or F is None or (R * base + F * (1 - base)) == 0:
        return None
    return R * base / (R * base + F * (1 - base))


def model_sort_key(r: dict):
    m = r["model"]
    return (0 if m == SERVED else 1 if m.startswith(OURS_PREFIX) else 2 if m.startswith("hf_") else 3, m)


def metrics_table(rows: list[dict], fp_only: bool = False) -> list[str]:
    if fp_only:
        lines = ["| system | n | flagged (FP) | FPR | threshold | p50 ms | p95 ms | note |", "|---|---:|---:|---:|---:|---:|---:|---|"]
        for r in sorted(rows, key=lambda r: (r["fp"], model_sort_key(r))):
            lines.append(f"| {name(r)} | {f(r['n'])} | **{f(r['fp'])}** | {f(r['fpr'], True)} | {f(r['threshold'], nd=3)} | "
                         f"{f(r['latency_ms_p50'], nd=3)} | {f(r['latency_ms_p95'], nd=3)} | {r.get('note', '')[:90]} |")
        return lines
    lines = ["| system | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC | recall @0.1% FPR | recall @1% FPR | "
             "precision @1% prev. | precision @0.05% prev. | TP / FP / TN / FN | p50 ms | p95 ms |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|"]
    for r in sorted(rows, key=model_sort_key):
        lines.append(
            f"| {name(r)} | {f(r['n'])} | {f(r['precision'])} | {f(r['recall'])} | {f(r['f1'])} | {f(r['fpr'], True)} | "
            f"{f(r['roc_auc'])} | {f(r['pr_auc'])} | {f(r['recall_at_fpr_0.1pct'])} | {f(r['recall_at_fpr_1pct'])} | "
            f"{f(prec_at(r, BASE_RATES[0]))} | {f(prec_at(r, BASE_RATES[1]))} | "
            f"{r['tp']:,} / {r['fp']:,} / {r['tn']:,} / {r['fn']:,} | {f(r['latency_ms_p50'], nd=3)} | {f(r['latency_ms_p95'], nd=3)} |")
    return lines


def name(r: dict) -> str:
    m = r["model"]
    s = f"**{m}** (ours, served)" if m == SERVED else f"{m} (ours)" if m.startswith(OURS_PREFIX) else m
    if "random sample" in r.get("note", ""):
        s += " †"
    return s


def notes_block(rows: list[dict]) -> list[str]:
    seen, out = set(), []
    for r in sorted(rows, key=model_sort_key):
        n = r.get("note")
        if n and r["model"] not in seen:
            seen.add(r["model"])
            out.append(f"- `{r['model']}`: {n}")
    return out


def cm_gallery(rows: list[dict]) -> list[str]:
    imgs = [r for r in sorted(rows, key=model_sort_key) if r["_img"].exists()]
    if not imgs:
        return []
    cells = [f"![{r['model']} on {r['dataset']}](img/{r['_img'].name})" for r in imgs]
    out = ["<details><summary>Confusion matrices</summary>", ""]
    for i in range(0, len(cells), 4):
        out.append(" ".join(cells[i : i + 4]))
        out.append("")
    out.append("</details>")
    return out


def trap_section() -> list[str]:
    p = RESULTS / "traps" / f"{SERVED}.json"
    if not p.exists():
        return []
    t = json.loads(p.read_text())
    meta = t["meta"]
    out = [f"## Trap analysis (served model `{SERVED}`)", ""]
    out += ["### (i) Path-length bias", "",
            "Share of test URLs flagged, split by whether the URL has a path/query. A shortcut model would flag "
            "almost every phishing URL with a path and almost no legitimate one, and fail on the other two rows.", "",
            "| slice | n | flagged at block threshold | flagged at triage threshold |", "|---|---:|---:|---:|"]
    for k, v in t.get("path_bias_slices", {}).items():
        out.append(f"| {k} | {f(v['n'])} | {f(v['flagged_rate'], True)} | {f(v['flagged_rate_triage'], True)} |")
    out += ["", "The `urls_test_deeplegit_vs_barephish` table above is the same check as a full benchmark.", ""]
    out += ["### (ii) Leakage", "",
            "`split` in urls.parquet is assigned per registered domain (no domain spans two splits); the "
            "out-of-fold TF-IDF logits that feed the stack use GroupKFold on registered domain; validation is cut "
            "by domain again into an early-stopping half and a calibration / threshold half; the scheme and a leading "
            "`www.` are removed before any feature, because the feeds differ in whether they include them "
            "(legitimate top lists are bare hostnames that were prefixed with https://).", ""]
    out += ["### (iii) Temporal drift", "", "See the fresh-feed table above: same threshold, data pulled after the training feeds.", ""]
    out += loso_section()
    for key in ("urls_test_by_source", "urls_fresh_test_by_source"):
        if key in t:
            out += [f"#### Per-source results at the block threshold ({key.replace('_by_source', '')})", "",
                    "| source | label | n | flagged | rate | meaning |", "|---|---:|---:|---:|---:|---|"]
            for r in sorted(t[key], key=lambda r: (r["label"], -r["n"])):
                out.append(f"| {r['source']} | {r['label']} | {f(r['n'])} | {f(r['flagged'])} | {f(r['rate'], True)} | {r['metric']} |")
            out.append("")
    u = t.get("uae_legit")
    if u:
        out += ["### (v) False positives on UAE official sites", "",
                f"{u['fp']} of {u['n']:,} official UAE URLs are flagged at the block threshold "
                f"({u['fp_triage']} at the triage threshold, where they would only be sent to the page check).", ""]
        # Individual URLs from the datasets are not published; the per-URL lists stay in local results only.
    out += ["### Operating threshold", "",
            f"Block-level threshold {t['threshold']:.4f}: chosen on the calibration half of validation for FPR ≤ "
            f"{100 * meta['target_val_fpr']:.2f}% (validation: recall {f(meta['val_metrics']['recall'])}, FPR "
            f"{f(meta['val_metrics']['fpr'], True)}). Triage threshold {t['triage_threshold']:.4f}: validation FPR 1%. "
            "In the live engine the URL model only escalates to the page check and never blocks alone, so the triage "
            "point is the one that matters for the gateway; the block-level point is the standalone classifier.", "",
            "All operating points stored in the artifact (validation FPR → threshold): "
            + ", ".join(f"{k}: {v:.4f}" for k, v in meta["thresholds_by_val_fpr"].items()), ""]
    return out


def loso_section() -> list[str]:
    p = RESULTS / "loso" / "url_stack_loso.json"
    if not p.exists():
        return ["### (iv) Source bias", "", "Leave-one-source-out run not finished yet.", ""]
    d = json.loads(p.read_text())
    out = ["### (iv) Source bias: leave-one-source-out (CPU stack component)", "",
           f"Each row retrains the stack (cap {d['cap_per_source']:,} rows per source and label) with that source removed "
           "from training, validation and threshold selection, then scores that source's test rows. The reference is "
           "the same-size model trained on all sources. This is the cross-dataset number the literature says collapses "
           "(51-59% for 97-99% in-distribution models).", "",
           "| held-out source | test rows (scam / legit) | recall held-out | recall in-dist | FPR held-out | FPR in-dist | "
           "ROC-AUC held-out | ROC-AUC in-dist |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for r in d["rows"]:
        h, i = r["held_out_model"], r["in_distribution_model"]
        out.append(f"| {r['held_out']} | {h['n_scam']:,} / {h['n_legit']:,} | {f(h['recall'])} | {f(i['recall'])} | "
                   f"{f(h['fpr'], True)} | {f(i['fpr'], True)} | {f(h['roc_auc'])} | {f(i['roc_auc'])} |")
    out.append("")
    return out


def latency_section(results: list[dict]) -> list[str]:
    best: dict[str, dict] = {}
    for r in results:
        if r.get("latency_ms_p50") is not None and "@" not in r["model"]:
            if r["model"] not in best or r["dataset"] == "urls_test":
                best[r["model"]] = r
    out = ["## Latency (single URL, one CPU thread, model already loaded)", "",
           "| system | p50 ms | p95 ms | measured on |", "|---|---:|---:|---|"]
    for m, r in sorted(best.items(), key=lambda kv: kv[1]["latency_ms_p50"]):
        out.append(f"| {name(r)} | {f(r['latency_ms_p50'], nd=3)} | {f(r['latency_ms_p95'], nd=3)} | {r['dataset']} |")
    return out + [""]


def speed_section() -> list[str]:
    p = RESULTS / "page_speed" / "page_speed.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text())
    s, hw = d["summary"], d["hardware"]
    out = ["## Speed per page", "",
           f"Measured {d['generated_at']} on {d['pages']} live legitimate pages ({', '.join(d['categories'])}), one page at "
           f"a time (concurrency {d['concurrency']}). Hardware: {hw['cpu']}, {hw['logical_cores']} logical cores, GPU "
           f"{hw['gpu'] or 'none'}; {hw['note']}. Regenerate with `.venv/bin/python -m ml.bench.page_speed`.", "",
           "![time per page](img/page_speed.png)", "",
           "| system / phase | n | p50 ms | p95 ms |", "|---|---:|---:|---:|"]
    from ml.bench.page_speed import ENGINE_PHASES

    for pas, title in (("engine_pass1", "ours, first visit"), ("engine_pass2", "ours, repeat visit")):
        e = s.get(pas)
        if not e:
            continue
        out.append(f"| **{title}: client wall time** (errors: {e['errors']}) | {e['client_wall']['n']} | "
                   f"{f(e['client_wall']['p50_ms'], nd=1)} | {f(e['client_wall']['p95_ms'], nd=1)} |")
        if pas == "engine_pass1":
            for lab, _ in ENGINE_PHASES:
                ph = e["phases"][lab]
                if ph["n"]:
                    out.append(f"| ours: {lab} | {ph['n']} | {f(ph['p50_ms'], nd=2)} | {f(ph['p95_ms'], nd=2)} |")
        if e.get("stage_counts"):
            out.append(f"| ours ({title}): deepest stage reached {e['stage_counts']}, decisions {e.get('decision_counts')} | | | |")
        for st, v in (e.get("by_stage") or {}).items():
            out.append(f"| ours ({title}): pages whose verdict was final at stage `{st}`, client wall | {v['n']} | "
                       f"{f(v['p50_ms'], nd=1)} | {f(v['p95_ms'], nd=1)} |")
        if e["cache_hit"]["n"]:
            out.append(f"| ours ({title}): served from cache / page-hash reuse | {e['cache_hit']['n']} | "
                       f"{f(e['cache_hit']['p50_ms'], nd=2)} | {f(e['cache_hit']['p95_ms'], nd=2)} |")
    b = s.get("browser")
    if b:
        out.append(f"| headless Chromium: `load` event (errors: {b['errors']}) | {b['load']['n']} | "
                   f"{f(b['load']['p50_ms'], nd=1)} | {f(b['load']['p95_ms'], nd=1)} |")
        out.append(f"| **headless Chromium: network idle** ({b['networkidle_timeouts']} pages never went idle and count as the {b.get('timeout_s') or 30:g} s timeout) | "
                   f"{b['networkidle']['n']} | {f(b['networkidle']['p50_ms'], nd=1)} | {f(b['networkidle']['p95_ms'], nd=1)} |")
        out.append(f"| HTML parse + DOM extraction (engine's parse_html, offline) | {b['parse_html']['n']} | "
                   f"{f(b['parse_html']['p50_ms'], nd=2)} | {f(b['parse_html']['p95_ms'], nd=2)} |")
    llm = d.get("llm")
    if llm and llm.get("n"):
        out.append(f"| zero-shot LLM judge `{llm['model']}` (URL + title + 1,200 chars of text) | {llm['n']} | "
                   f"{f(llm['p50_ms'], nd=1)} | {f(llm['p95_ms'], nd=1)} |")
    else:
        out.append("| zero-shot LLM judge | – | not measured: `SCAMSHIELD_LLM_BASE_URL` was not set when the benchmark ran | |")
    e1 = s.get("engine_pass1")
    if e1 and e1.get("all_keys"):
        out += ["", "<details><summary>Every engine timing key (first visit)</summary>", "",
                "| timings_ms key | n | p50 ms | p95 ms |", "|---|---:|---:|---:|"]
        out += [f"| `{k}` | {v['n']} | {f(v['p50_ms'], nd=2)} | {f(v['p95_ms'], nd=2)} |" for k, v in e1["all_keys"].items()]
        out += ["", "</details>"]
    if d.get("models"):
        out += ["", "Model inference per input (one URL or one page, already loaded, from the benchmark runs above):", "",
                "| model | p50 ms | p95 ms | measured on | note |", "|---|---:|---:|---|---|"]
        for m in sorted(d["models"], key=lambda m: m["p50_ms"]):
            out.append(f"| {m['model']} | {f(m['p50_ms'], nd=3)} | {f(m['p95_ms'], nd=3)} | {m['dataset']} | {m['note'][:80]} |")
    for pas in ("engine_pass1",):
        e = s.get(pas)
        if e and b:
            out += ["", "By category, p50 ms (ours first visit, client wall / headless Chromium to network idle):", "",
                    "| category | ours | Chromium |", "|---|---:|---:|"]
            for cat in sorted(set(e["by_category"]) | set(b["by_category"])):
                out.append(f"| {cat} | {f(e['by_category'].get(cat, {}).get('p50_ms'), nd=0)} | "
                           f"{f(b['by_category'].get(cat, {}).get('p50_ms'), nd=0)} |")
    out += ["", "### Reported by the authors, not measured by us", "",
            "| system | inputs | time per page | hardware / note | source |", "|---|---|---|---|---|"]
    out += [f"| {a} | {b_} | {c} | {dd} | {e_} |" for a, b_, c, dd, e_ in d["published"]]
    return out + [""]


STATIC_INTRO = """\
# Benchmarks of Mirsad's website shield (مرصاد)

_Generated by `ml/bench/report.py` from `ml/results/` on {now}. Do not edit by hand: re-run
`.venv/bin/python -m ml.bench.report`._

**How to read this.** Every system is scored on the same rows. `precision` / `recall` / `FPR` use each
system's own threshold (ours: the block-level threshold below; public models: their native 0.5).
The threshold-free columns (ROC-AUC, PR-AUC, recall at 0.1% / 1% FPR) compare ranking quality on equal
terms. The test sets are about 50% scam, which flatters precision, so the "precision @ prev."
columns recompute precision from recall and FPR at a realistic 1% and 0.05% scam prevalence (PhreshPhish
protocol). `ours@triage` is the same model at the escalation threshold (1% validation FPR).
† = scored on a random sample of the dataset (slow model); the sample size is in the notes.
"""

LIMITATIONS = """\
## Limitations

- **The labels are feed labels.** Phishing rows come from public feeds (PhishTank, OpenPhish, CERT.PL,
  phishing-database, URLhaus, ...) and contain some mislabelled legitimate URLs (e.g. Microsoft and
  Google domains reported by users); legitimate rows come from top lists and crawls and contain a few
  compromised or parked sites. Precision and FPR are measured against these noisy labels.
- **The fresh set is small** (a few thousand rows, a single day of feeds), so its confidence intervals
  are wide: ±1-2 points of recall.
- **A URL string cannot see everything.** Shortener links, free-hosting pages (`*.pages.dev`,
  `*.vercel.app`, `sites.google.com`), compromised legitimate sites and clean-looking new domains look
  benign by URL alone. The model is a triage stage in front of the page check, not a verdict.
- **Public models were scored on their documented label mapping at threshold 0.5**, on CPU, some on a
  sample; they were trained on other data with other conventions (some expect a scheme, some do not).
  Their threshold-free columns are the fairer comparison. Several were trained on HF datasets that also
  feed our benchmark; `urls_test_nohf` removes those rows.
- **Blocklist recall is inflated by construction**: the benchmark's phishing rows were taken from the
  same feeds. `blocklist_cross_feed` (ignoring the row's own feed) is the realistic number.
- **No page content, WHOIS or certificate age** is used by the URL models; those are separate layers of the engine.
- **Full-system (`pipeline_*`) rows** come from `ml/bench/run_pipeline.py` with an in-process engine (own SQLite DB,
  review off) on the **odd md5(url) half** of the fresh test set only (the even half is used to tune rule weights).
  `engine-alone` rows have the public blocklists switched off (`SCAMSHIELD_BLOCKLISTS=0`); rows with reputation
  pre-fill are reported separately. So far it has been run on legitimate rows only: the ML engineer's brief
  forbids fetching the benchmark's live phishing URLs, and the attempt to run the phishing half was blocked by the
  session's permission policy. The scam half is one command for whoever is cleared to run it:
  `SCAMSHIELD_PAGE_ENCODER_URL=http://localhost:8003 nice -n 19 .venv/bin/python -m ml.bench.run_pipeline
  ml/data/processed/urls_fresh_test.parquet --name fresh_test_oddhalf --per-label 300 --inprocess --no-blocklists
  --depth page --concurrency 8 --i-understand-fetching` (and again without `--no-blocklists`); it reports the
  retrievable and unreachable pages as separate rows.
- **Shipped model and UAE data**: `url_stack` was trained without any UAE-legit row; the UAE tables are a clean
  false-positive test. Training adds the 10,695 train-split legitimate shortener links from `urls_additions_v3`.
- **Speed numbers**: the per-page study records the machine's load average when it ran. The per-model
  latencies in the accuracy tables were measured earlier on a busy machine (load average ~15-20, our jobs at
  nice 19), so those absolute values are pessimistic; relative order is what matters.
"""


def main() -> None:
    results = load_results()
    by_ds: dict[str, list[dict]] = {}
    for r in results:
        by_ds.setdefault(r["dataset"], []).append(r)
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    lines = [STATIC_INTRO.format(now=now)]
    known = [d for d, *_ in DATASET_ORDER]
    for ds, title, desc in DATASET_ORDER:
        if ds not in by_ds:
            continue
        rows = by_ds[ds]
        lines += [f"## {title} (`{ds}`)", "", desc, ""]
        lines += metrics_table(rows, fp_only=(ds == "uae_legit"))
        lines += [""] + notes_block(rows) + [""] + cm_gallery(rows) + [""]
    for ds in sorted(set(by_ds) - set(known)):
        legit_only = all(r["tp"] + r["fn"] == 0 for r in by_ds[ds])
        lines += [f"## `{ds}`", ""] + metrics_table(by_ds[ds], fp_only=legit_only) + [""] + notes_block(by_ds[ds]) + [""] + cm_gallery(by_ds[ds]) + [""]
    lines += latency_section(results)
    lines += speed_section()
    lines += trap_section()
    gpu_meta = ROOT / "data" / "models" / "url_encoder" / "threshold.json"
    if gpu_meta.exists():
        g = json.loads(gpu_meta.read_text())
        lines += ["## GPU model", "",
                  f"`ml/url/train_gpu.py` fine-tuned `{g['base']}` on {g['train_rows']:,} URLs (same domain-split data and "
                  f"normalisation, {g.get('steps_done', '?')} optimizer steps, bf16, GPU memory capped at 20 GB). Its rows "
                  "appear as `url_mmbert_ft` in the tables above; its latency is single-URL on the GPU. "
                  + g.get("decision", ""), ""]
    elif (ROOT / "ml" / "url" / "train_gpu.py").exists():
        lines += ["## GPU model (written, not run)", "",
                  "`ml/url/train_gpu.py` fine-tunes a pretrained encoder on the same domain-split data; see its "
                  "docstring for the command, expected run time and memory.", ""]
    lines.append(LIMITATIONS)
    OUT.write_text("\n".join(lines))
    print(f"wrote {OUT} ({len(results)} results)")


if __name__ == "__main__":
    main()
