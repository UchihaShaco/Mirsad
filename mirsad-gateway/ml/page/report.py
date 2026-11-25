"""Render the benchmark tables from ml/page/cache/eval_report.json into docs/BENCHMARKS_PAGE.md
(between the `<!-- tables:start -->` and `<!-- tables:end -->` markers; the narrative around them
is written by hand).

    .venv/bin/python -m ml.page.report
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "ml" / "page" / "cache" / "eval_report.json"
DOC = ROOT / "docs" / "BENCHMARKS_PAGE.md"
START, END = "<!-- tables:start -->", "<!-- tables:end -->"
ORDER = ["page_combo", "page_combo_no_abstain", "page_gte_ft", "page_text_lr", "page_struct_lgbm", "hf_ealvaradob_bert_large", "hf_huynq3_mbert_webpage",
         "hf_horizon_mmbert_scam", "rules_baseline", "keyword_baseline"]
DATASETS = ["pages_test", "pages_test_1pct", "synthetic_uae"]


def f(x, d=3):
    return "–" if x is None else f"{x:.{d}f}"


def headline(rep: dict) -> str:
    out = []
    for ds in DATASETS:
        rows = [m for m in rep["headline"] if m["dataset"] == ds]
        if not rows:
            continue
        rows.sort(key=lambda m: ORDER.index(m["model"]) if m["model"] in ORDER else 99)
        out.append(f"\n#### {ds}\n")
        out.append("| model | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC | R@FPR 0.1% | R@FPR 1% | "
                   "TP / FP / TN / FN | p50 / p95 ms |")
        out.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for m in rows:
            name = m["model"] + (" (sampled)" if m.get("sampled") else "")
            out.append(
                f"| {name} | {m['n']} | {f(m['precision'])} | {f(m['recall'])} | {f(m['f1'])} | {f(m['fpr'], 4)} | "
                f"{f(m['roc_auc'])} | {f(m['pr_auc'])} | {f(m['recall_at_fpr_0.1pct'])} | "
                f"{f(m['recall_at_fpr_1pct'])} | {m['tp']} / {m['fp']} / {m['tn']} / {m['fn']} | "
                f"{f(m['latency_ms_p50'], 1)} / {f(m['latency_ms_p95'], 1)} |")
    return "\n".join(out)


def slices(rep: dict) -> str:
    out = []
    for ds, rows in rep["slices"].items():
        out.append(f"\n#### page_combo by slice — {ds}\n")
        out.append("| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |")
        out.append("|---|---|---|---|---|---|---|---|---|---|")
        for r in rows:
            out.append(f"| {r['slice']} | {r['n']} | {r['n_scam']} | {f(r['precision'])} | {f(r['recall'])} | "
                       f"{f(r['f1'])} | {f(r['fpr'], 4)} | {r['fp']} | {r['fn']} | {f(r['roc_auc'])} |")
    return "\n".join(out)


def slices_other(rep: dict) -> str:
    out = []
    for ds, models in rep.get("slices_other", {}).items():
        for name, rows in models.items():
            out.append(f"\n#### {name} by slice — {ds}\n")
            out.append("| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |")
            out.append("|---|---|---|---|---|---|---|---|---|---|")
            for r in rows:
                out.append(f"| {r['slice']} | {r['n']} | {r['n_scam']} | {f(r['precision'])} | {f(r['recall'])} | "
                           f"{f(r['f1'])} | {f(r['fpr'], 4)} | {r['fp']} | {r['fn']} | {f(r['roc_auc'])} |")
    return "\n".join(out)


def fps(rep: dict) -> str:
    out = []
    for ds, d in rep["fp_legit_sensitive"].items():
        out.append(f"\n#### {ds}: legitimate login / payment / bank / government pages\n")
        out.append(f"{d['n_fp']} flagged out of {d['n_legit_sensitive']} (FPR {d['fpr']:.2%}).\n")
        if d["fps"]:
            out.append("| url | title | score |")
            out.append("|---|---|---|")
            for x in d["fps"]:
                t = (x["title"] or "").replace("|", "/")
                out.append(f"| `{x['url'][:90]}` | {t[:60]} | {x['score']:.3f} |")
        out.append(f"\nAll false positives in {ds}: {len(d['all_fps'])}.")
    return "\n".join(out)


def loso(rep: dict) -> str:
    out = ["\n| trained on | tested on | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC |",
           "|---|---|---|---|---|---|---|---|---|"]
    for r in rep["loso"]:
        out.append(f"| {r['train_source']} | {r['test']} | {r['n']} | {f(r['precision'])} | {f(r['recall'])} | "
                   f"{f(r['f1'])} | {f(r['fpr'], 4)} | {f(r['roc_auc'])} | {f(r['pr_auc'])} |")
    return "\n".join(out)


def main() -> None:
    rep = json.loads(REPORT.read_text())
    loso_file = REPORT.parent / "loso.json"
    if loso_file.exists():  # a leave-one-source-out run that finished after the last evaluation
        rep["loso"] = json.loads(loso_file.read_text())
    lat = rep["latency_ms"]
    body = "\n".join([
        "### Headline results (our thresholds fixed on validation: ≤0.5% of legitimate validation pages flagged; baselines at their native 0.5)",
        headline(rep),
        "\n### Per-language and other slices",
        slices(rep),
        slices_other(rep),
        "\n### Abstentions (page_combo returns no score: < 300 chars of text, no form, no active-content signal)\n",
        "| dataset | pages | abstained | of which scam | of which legit |", "|---|---|---|---|---|",
        *[f"| {ds} | {a['n']} | {a['abstained']} | {a['abstained_scam']} | {a['abstained_legit']} |"
          for ds, a in rep.get("abstain", {}).items()],
        "\n### Leave-one-source-out",
        loso(rep),
        "\n### False positives on legitimate sensitive pages",
        fps(rep),
        "\n### Latency (one thread, end to end: HTML parse + features + model, 300 pages)\n",
        "| model | p50 ms | p95 ms | max ms |", "|---|---|---|---|",
        *[f"| {k} | {v['p50']:.1f} | {v['p95']:.1f} | {v['max']:.1f} |" for k, v in lat.items()],
    ])
    text = DOC.read_text()
    a, b = text.index(START) + len(START), text.index(END)
    DOC.write_text(text[:a] + "\n" + body + "\n" + text[b:])
    print("updated", DOC)


if __name__ == "__main__":
    main()
