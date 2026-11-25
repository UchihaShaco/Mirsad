"""Print the URL-method comparison (ours / as released / recreated) from ml/results/*.json as a markdown table,
plus the PhreshPhish paper-comparable check.

    .venv-gpu/bin/python -m ml.sota.url.summary
"""

from __future__ import annotations

import json

from ml.bench.runner import RESULTS_DIR

SYSTEMS = [  # (result-file model name, form, short description)
    ("url_stack", "ours", "LightGBM stack (served, CPU)"),
    ("url_tfidf_lr", "ours", "char TF-IDF + LR (CPU)"),
    ("url_mmbert_ft", "ours", "mmBERT-small fine-tuned (URLTran recipe)"),
    ("sota_url_urlnet", "recreated (re-implemented from official code)", "URLNet"),
    ("sota_url_grambeddings", "recreated (re-implemented from official code)", "GramBeddings"),
    ("sota_url_urlbert_ft", "recreated (official pre-trained weights + recipe)", "URLBERT"),
    ("sota_url_phreshphish_linear", "recreated (re-implemented from paper)", "PhreshPhish Linear, URL-only"),
    ("hf_urlbert_tiny_v4", "as released", "CrabInHoney urlbert-tiny-v4"),
    ("hf_kmack_distilbert", "as released", "kmack DistilBERT"),
    ("hf_ealvaradob_bert_large", "as released", "ealvaradob BERT-large"),
    ("hf_pirocheto_tfidf_svm", "as released", "pirocheto TF-IDF SVM"),
]


def _load(model: str, dataset: str) -> dict | None:
    p = RESULTS_DIR / f"{model}__{dataset}.json"
    return json.loads(p.read_text()) if p.exists() else None


def _pct(v) -> str:
    return "–" if v is None else f"{100 * v:.1f}"


def _ms(v) -> str:
    return "–" if v is None else f"{v:.2f}"


def table() -> str:
    """Test columns fall back to urls_test_noshort (22 fewer rows) for models only scored there, marked *."""
    lines = ["| system | form | R@0.1% FPR test | R@1% FPR test | R@0.1% fresh | R@1% fresh | ROC-AUC fresh | "
             "FP on uae_legit (of 15,669) | CPU ms p50 | GPU ms p50 |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for model, form, desc in SYSTEMS:
        t, f, u = (_load(model, d) for d in ("urls_test", "urls_fresh_test", "uae_legit"))
        if t is None and (t := _load(model, "urls_test_noshort")):
            desc += " *"
        if not (t or f or u):
            continue
        ref = t or f or u
        cpu = ref.get("latency_ms_p50") if model.startswith(("sota_", "url_stack", "url_tfidf", "hf_")) else None
        gpu = ref.get("latency_gpu_ms_p50", ref.get("latency_ms_p50") if model == "url_mmbert_ft" else None)
        lines.append(f"| {desc} | {form} | {_pct(t and t['recall_at_fpr_0.1pct'])} | {_pct(t and t['recall_at_fpr_1pct'])} | "
                     f"{_pct(f and f['recall_at_fpr_0.1pct'])} | {_pct(f and f['recall_at_fpr_1pct'])} | "
                     f"{'–' if not f or f['roc_auc'] is None else f'{f['roc_auc']:.3f}'} | {u['fp'] if u else '–'} | "
                     f"{_ms(cpu)} | {_ms(gpu)} |")
    return "\n".join(lines)


def grambeddings_check() -> str:
    lines = ["| trained and tested on the GramBeddings dataset split | accuracy, our harness | GramBeddings paper |",
             "|---|---:|---:|"]
    for model in ("sota_url_grambeddings_gb_split", "sota_url_urlnet_gb_split"):
        if r := _load(model, "grambeddings_test"):
            lines.append(f"| {model} | {r['accuracy']:.4f} | {r['paper_reported_accuracy_grambeddings']:.4f} "
                         f"(GramBeddings) |")
    return "\n".join(lines)


def paper_check() -> str:
    r = _load("sota_url_phreshphish_linear_paper_split", "phreshphish_test")
    if not r:
        return ""
    b, paper = r["phreshphish_benchmark"], r["paper_table4_url_plus_html"]
    rates = ["0.05", "0.10", "0.50", "1.0", "5.0", "24.0"]
    lines = ["| PhreshPhish benchmark, mean AP at base rate (%) | " + " | ".join(rates) + " |",
             "|---|" + "---:|" * len(rates),
             "| Linear, URL only, our harness | " + " | ".join(f"{b[k]['ap']:.3f} ± {b[k]['ap_ci']:.3f}" for k in rates) + " |"]
    for m in ("Linear", "FFN", "GTE"):
        lines.append(f"| {m}, URL + HTML, paper Table 4 | " + " | ".join(f"{paper[m]['ap'][k]:.3f}" for k in rates) + " |")
    if seen := r.get("test_registered_domain_seen_in_train"):
        lines += ["", "Test rows whose registered domain also occurs in the official train split: "
                  + ", ".join(f"{k} {v:.1%}" for k, v in seen.items()) + "."]
    return "\n".join(lines)


if __name__ == "__main__":
    print(table())
    print()
    print(paper_check())
    print()
    print(grambeddings_check())
