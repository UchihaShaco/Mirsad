"""Post-validation benchmark: what the second-opinion review does to verdicts the engine has flagged.

Reads flagged verdicts (warn or block) from an engine database produced by a batch run, or from a
JSON-lines file of verdicts, runs the review agent on each, and reports how many false positives it
clears and how many true positives it keeps. Labels come from a CSV with `url` and `label` columns
(1 = scam, 0 = legitimate); a run over a list that is one class throughout passes `--all-label`.

    python -m ml.bench.review_eval --db run.db --all-label 0 --out review.jsonl --tag qwen9b --dataset places
    python -m ml.bench.review_eval --verdicts scams.jsonl --all-label 1 --judge rules --no-site-fetch \
        --out scams.jsonl --tag rules --dataset demo_scams
    python -m ml.bench.review_eval --write-doc          # rebuild docs/BENCHMARKS_REVIEW.md from ml/results

Per-site rows (with hostnames and summaries) stay in `--out`, which belongs in a git-ignored place;
`ml/results/review_<tag>__<dataset>.json` keeps only aggregates and anonymous rows.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sqlite3
import statistics
import time
from collections import Counter
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from scamshield.review import review_verdict
from scamshield.review.agent import arabic_ok
from scamshield.review.tools import Sources
from scamshield.schemas import Decision, PageSnapshot, ReviewOutcome, Verdict

FLAGGED = (Decision.WARN, Decision.BLOCK)
CLEARED = (ReviewOutcome.OVERTURNED, ReviewOutcome.DOWNGRADED)
ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "ml" / "results"
DOC = ROOT / "docs" / "BENCHMARKS_REVIEW.md"


def flagged_verdicts(db: Path) -> list[Verdict]:
    """Latest stored verdict per URL, kept when the engine warned or blocked."""
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as con:
        rows = con.execute("SELECT url, json FROM verdicts ORDER BY updated_at").fetchall()
    latest = {url: Verdict.model_validate_json(blob) for url, blob in rows}
    return [v for v in latest.values() if v.decision in FLAGGED]


def file_verdicts(path: Path) -> list[Verdict]:
    rows = [Verdict.model_validate_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [v for v in rows if v.decision in FLAGGED]


def url_key(url: str) -> str:
    """Scheme, `www.`, case and trailing slash do not distinguish two listings of the same site."""
    parts = urlsplit(url.strip() if "://" in url else f"http://{url.strip()}")
    host = (parts.hostname or "").lower().removeprefix("www.")
    return f"{host}{parts.path.rstrip('/')}{'?' + parts.query if parts.query else ''}"


def read_labels(path: Optional[Path]) -> dict[str, int]:
    """Labels keyed by normalised URL and, as a fallback, by bare host."""
    if path is None:
        return {}
    with path.open(newline="", encoding="utf-8") as handle:
        rows = [(row["url"], int(row["label"])) for row in csv.DictReader(handle) if row.get("label") not in (None, "")]
    labels = {url_key(url).split("/", 1)[0]: label for url, label in rows}
    labels.update({url_key(url): label for url, label in rows})
    return labels


def label_for(verdict: Verdict, labels: dict[str, int], default: Optional[int]) -> Optional[int]:
    for candidate in (verdict.url, verdict.final_url or "", verdict.host):
        key = url_key(candidate) if candidate else ""
        for k in (key, key.split("/", 1)[0]):
            if k and k in labels:
                return labels[k]
    return default


def decision_after(before: Decision, outcome: ReviewOutcome, recommended: Decision) -> Decision:
    """A review only changes a verdict when it overturns or downgrades; otherwise the flag stands."""
    return recommended if outcome in CLEARED else before


async def _no_fetch(url: str, *_args) -> PageSnapshot:
    return PageSnapshot(url=url, final_url=url, error="site fetches disabled for this benchmark")


async def _no_probe(url: str) -> dict:
    return {"error": "site fetches disabled for this benchmark"}


def offline_sources() -> Sources:
    """Registry, history and search lookups as usual, but no request to the site itself."""
    return Sources(fetch_page=_no_fetch, fetch_light=_no_fetch, cloaking_probe=_no_probe)


async def run(verdicts: list[Verdict], labels: dict[str, int], default_label: Optional[int], out: Path,
              tag: str, concurrency: int, judge: str, site_fetch: bool) -> list[dict]:
    done = {json.loads(line)["url"] for line in out.read_text().splitlines()} if out.exists() else set()
    gate = asyncio.Semaphore(concurrency)
    rows: list[dict] = []
    kwargs = {} if judge == "env" else {"judge": None}
    if not site_fetch:
        kwargs["sources"] = offline_sources()

    async def one(v: Verdict) -> None:
        async with gate:
            started = time.perf_counter()
            try:
                result = await review_verdict(v, **kwargs)
                row = {"outcome": result.outcome.value, "after": decision_after(v.decision, result.outcome, result.decision).value,
                       "confidence": result.confidence, "steps": len(result.steps), "model": result.model,
                       "summary_en": result.summary_en, "summary_ar": result.summary_ar,
                       "arabic_ok": arabic_ok(result.summary_ar)}
            except Exception as exc:  # a failed review leaves the flag in place, as in the engine
                row = {"outcome": "error", "after": v.decision.value, "error": f"{type(exc).__name__}: {exc}"[:300]}
            row.update(url=v.url, host=v.host, label=label_for(v, labels, default_label), before=v.decision.value,
                       risk=round(v.risk_score, 1), tag=tag, seconds=round(time.perf_counter() - started, 1))
            rows.append(row)
            with out.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    await asyncio.gather(*(one(v) for v in verdicts if v.url not in done))
    return [json.loads(line) for line in out.read_text().splitlines()] if out.exists() else rows


def summarise(rows: list[dict]) -> dict:
    """Transitions per label and starting decision, the false / true positive tallies, and review time."""
    table: dict[str, Counter] = {}
    for row in rows:
        kind = {0: "legitimate (false positive)", 1: "scam (true positive)"}.get(row.get("label"), "unlabelled")
        table.setdefault(f"{kind} | {row['before']}", Counter())[f"{row['outcome']} -> {row['after']}"] += 1
    seconds = sorted(r["seconds"] for r in rows)
    legit = [r for r in rows if r.get("label") == 0]
    scams = [r for r in rows if r.get("label") == 1]
    return {
        "n": len(rows),
        "false_positives": {"n": len(legit), "cleared_to_allow": sum(r["after"] == "allow" for r in legit),
                            "downgraded_to_warn": sum(r["after"] == "warn" for r in legit),
                            "still_blocked": sum(r["after"] == "block" for r in legit)},
        "true_positives": {"n": len(scams), "kept_blocked": sum(r["after"] == "block" for r in scams),
                           "wrongly_warned": sum(r["after"] == "warn" for r in scams),
                           "wrongly_allowed": sum(r["after"] == "allow" for r in scams)},
        "transitions": {k: dict(v) for k, v in sorted(table.items())},
        "seconds_p50": round(statistics.median(seconds), 1) if seconds else None,
        "seconds_max": seconds[-1] if seconds else None,
        "arabic_ok_rate": round(sum(bool(r.get("arabic_ok")) for r in rows) / len(rows), 2) if rows else None,
        "errors": sum(r["outcome"] == "error" for r in rows),
        "models": dict(Counter(r.get("model", "") for r in rows)),
    }


def save_result(rows: list[dict], tag: str, dataset: str) -> Path:
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"review_{tag}__{dataset}.json"
    anonymous = [{k: r.get(k) for k in ("label", "before", "outcome", "after", "confidence", "seconds", "arabic_ok")}
                 for r in rows]
    path.write_text(json.dumps({"tag": tag, "dataset": dataset, "summary": summarise(rows), "rows": anonymous},
                               indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def write_doc() -> Path:
    """Render every review result in ml/results as the tables of docs/BENCHMARKS_REVIEW.md."""
    results = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(RESULTS.glob("review_*__*.json"))]
    lines = ["# Second-opinion review: benchmark", "",
             "What the Layer 4 review does to verdicts the engine flagged. Generated by "
             "`python -m ml.bench.review_eval --write-doc` from `ml/results/review_<judge>__<dataset>.json`.", "",
             "## Legitimate sites the engine blocked (false positives)", "",
             "| Judge | Dataset | Flagged | Cleared to allow | Downgraded to warn | Still blocked | Median s | Arabic OK |",
             "|---|---|---|---|---|---|---|---|"]
    for r in results:
        s = r["summary"]
        fp = s["false_positives"]
        if fp["n"]:
            lines.append(f"| {r['tag']} | {r['dataset']} | {fp['n']} | {fp['cleared_to_allow']} | {fp['downgraded_to_warn']} "
                         f"| {fp['still_blocked']} | {s['seconds_p50']} | {s['arabic_ok_rate']} |")
    lines += ["", "## Scam sites the engine blocked (true positives)", "",
              "| Judge | Dataset | Flagged | Kept blocked | Wrongly warned | Wrongly allowed | Median s | Arabic OK |",
              "|---|---|---|---|---|---|---|---|"]
    for r in results:
        s = r["summary"]
        tp = s["true_positives"]
        if tp["n"]:
            lines.append(f"| {r['tag']} | {r['dataset']} | {tp['n']} | {tp['kept_blocked']} | {tp['wrongly_warned']} "
                         f"| {tp['wrongly_allowed']} | {s['seconds_p50']} | {s['arabic_ok_rate']} |")
    notes = DOC.read_text(encoding="utf-8").split("<!-- notes -->", 1)[1] if DOC.exists() and "<!-- notes -->" in \
        DOC.read_text(encoding="utf-8") else "\n"
    DOC.write_text("\n".join(lines) + "\n\n<!-- notes -->" + notes, encoding="utf-8")
    return DOC


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--db", type=Path, help="engine SQLite database")
    source.add_argument("--verdicts", type=Path, help="JSON lines, one Verdict per line")
    parser.add_argument("--labels", type=Path)
    parser.add_argument("--all-label", type=int, choices=(0, 1))
    parser.add_argument("--out", type=Path)
    parser.add_argument("--tag", default="review")
    parser.add_argument("--dataset", default="flagged")
    parser.add_argument("--only", choices=("warn", "block"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--judge", choices=("env", "rules"), default="env",
                        help="env: the LLM the environment configures; rules: deterministic checks only")
    parser.add_argument("--no-site-fetch", action="store_true", help="never request the reviewed sites themselves")
    parser.add_argument("--write-doc", action="store_true", help="rebuild docs/BENCHMARKS_REVIEW.md and exit")
    args = parser.parse_args()
    if args.write_doc:
        print(write_doc())
        return
    if not (args.db or args.verdicts) or not args.out:
        parser.error("--db or --verdicts, and --out, are required")

    verdicts = flagged_verdicts(args.db) if args.db else file_verdicts(args.verdicts)
    if args.only:
        verdicts = [v for v in verdicts if v.decision.value == args.only]
    verdicts.sort(key=lambda v: -v.risk_score)
    rows = asyncio.run(run(verdicts[: args.limit], read_labels(args.labels), args.all_label, args.out, args.tag,
                           args.concurrency, args.judge, not args.no_site_fetch))
    print(json.dumps(summarise(rows), indent=1, ensure_ascii=False))
    print(save_result(rows, args.tag, args.dataset))


if __name__ == "__main__":
    main()
