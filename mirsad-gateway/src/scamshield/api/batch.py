"""Score a CSV of URLs concurrently (used by POST /v1/batch and the `batch` CLI command)."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from scamshield.engine.pipeline import Engine
from scamshield.engine.rules import parse_url
from scamshield.schemas import Decision

DEFAULT_CONCURRENCY = int(os.environ.get("SCAMSHIELD_BATCH_CONCURRENCY", "8"))
URL_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_BATCH_URL_TIMEOUT", "30"))  # hard wall-clock limit per URL
COLUMNS = ["url", "decision", "risk_score", "label_pred", "top_reasons", "elapsed_ms", "timings_ms"]
URL_COLUMNS = ("url", "urls", "link", "uri", "domain", "website", "address")  # accepted names, in order of preference
LABEL_COLUMNS = ("label", "is_scam", "is_phishing", "is_fraud", "target", "class", "type")
LABEL_VALUES = {
    "1": 1, "true": 1, "yes": 1, "phishing": 1, "phish": 1, "scam": 1, "fraud": 1, "malicious": 1, "bad": 1, "spam": 1,
    "0": 0, "false": 0, "no": 0, "legitimate": 0, "legit": 0, "benign": 0, "good": 0, "safe": 0,
}

_NON_WEB_SCHEME = re.compile(r"^\s*([a-z][a-z0-9+.-]*):(?!//)(?!\d)", re.I)  # javascript:, mailto:, data:; not host:port
_HOST = re.compile(r"^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$")
_DEFANGED = ((re.compile(r"^hxxp", re.I), "http"), (re.compile(r"\[\.\]|\(\.\)|\{\.\}"), "."), (re.compile(r"\[:\]"), ":"))


class BatchError(ValueError):
    pass


@dataclass
class InputRow:
    url: str
    extra: dict[str, str] = field(default_factory=dict)  # the row's other input columns, passed through to the output


@dataclass
class BatchInput:
    rows: list[InputRow]
    extra_columns: list[str]
    label_column: Optional[str] = None


def clean_url(text: str) -> str:
    """The URL as a person or an incident report writes it, made checkable: surrounding quotes or angle
    brackets, a protocol-relative `//host/...` and defanged forms (`hxxps://`, `example[.]com`) are undone."""
    url = text.strip().strip("<>\"'").strip()
    for pattern, plain in _DEFANGED:
        url = pattern.sub(plain, url)
    return "https:" + url if url.startswith("//") else url


def invalid_url(url: str) -> Optional[str]:
    """Why `url` cannot be investigated as a web address, or None when it can."""
    if not url.strip():
        return "empty URL"
    scheme = _NON_WEB_SCHEME.match(url)
    if scheme:
        return f"not a web address ({scheme.group(1).lower()}:)"
    p = parse_url(url)
    if not p.host:
        return "URL has no host"
    if p.scheme not in ("http", "https"):
        return f"unsupported scheme ({p.scheme}:)"
    if not (p.is_ip or _HOST.match(p.host)):
        return "malformed host name"
    return None


def _looks_like_url(text: str) -> bool:
    text = clean_url(text)
    return "://" in text or ("." in text and " " not in text and invalid_url(text) is None)


def read_input(text: str) -> BatchInput:
    """Parse a CSV with a URL column, or a plain list with one URL per line (no header).

    Every data line becomes a row, blank and malformed ones included, so the output lines up with the input.
    """
    text = text.lstrip("\ufeff")
    lines = list(csv.reader(io.StringIO(text)))
    while lines and not any(cell.strip() for cell in lines[-1]):
        lines.pop()  # trailing empty lines are not rows
    if not lines:
        raise BatchError("the input is empty")
    header = [h.strip() for h in lines[0]]
    lowered = [h.lower() for h in header]
    column = next((lowered.index(name) for name in URL_COLUMNS if name in lowered), None)
    if column is None:
        if header and _looks_like_url(header[0]):  # no header: the URL is the first cell of every line
            extra = [f"column{i + 1}" for i in range(1, max(map(len, lines)))]
            return BatchInput([InputRow(line[0].strip() if line else "", dict(zip(extra, (c.strip() for c in line[1:]))))
                               for line in lines], extra)
        raise BatchError(f"CSV needs a URL column (one of: {', '.join(URL_COLUMNS)}), "
                         "or a plain list with one URL per line")
    extra = [h for i, h in enumerate(header) if i != column]
    rows = []
    for line in lines[1:]:
        cells = [c.strip() for c in line] + [""] * (len(header) - len(line))
        rows.append(InputRow(cells[column], {h: cells[i] for i, h in enumerate(header) if i != column}))
    label = next((header[lowered.index(name)] for name in LABEL_COLUMNS if name in lowered), None)
    return BatchInput(rows, extra, label if label in extra else None)


async def score_rows(engine: Engine, urls: list[str], *, depth: str = "page", concurrency: Optional[int] = None,
                     review: bool = False, on_row: Optional[Callable[[int, dict], None]] = None) -> list[dict]:
    """One row per URL, in input order; `on_row` also receives (index, row) as soon as each row is finished.

    `label_pred` is the binary prediction for a labelled list: 1 (fraud) for warn or block, 0 for allow, and
    empty when the input is not a web address (`decision` = "invalid") or the check failed ("error").
    Background crawls are skipped; with `review` a block waits for the second-opinion review. Each URL
    has a hard wall-clock limit, so one hung site cannot stall the batch.
    """
    gate = asyncio.Semaphore(max(1, concurrency or DEFAULT_CONCURRENCY))

    async def investigate(url: str):
        verdict = await engine.investigate(url, depth, background=False, source="batch")
        if review and verdict.decision == Decision.BLOCK and verdict.review is None:
            verdict = await engine.review(verdict.id) or verdict
        return verdict

    async def one(index: int, url: str) -> dict:
        async with gate:
            row = await scored(url)
        if on_row:
            on_row(index, row)
        return row

    def failed(url: str, decision: str, why: str, t0: float) -> dict:
        return {"url": url, "decision": decision, "risk_score": "", "label_pred": "", "top_reasons": why[:300],
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1), "timings_ms": "{}"}

    async def scored(url: str) -> dict:
        t0 = time.perf_counter()
        target = clean_url(url)
        why = invalid_url(target)
        if why:
            return failed(url, "invalid", why, t0)
        try:
            verdict = await asyncio.wait_for(investigate(target), URL_TIMEOUT_S * (4 if review else 1))
        except Exception as exc:
            return failed(url, "error", f"{type(exc).__name__}: {exc}", t0)
        top = [r.code for r in sorted(verdict.reasons, key=lambda r: -r.points) if r.points > 0][:3]
        return {"url": url, "decision": verdict.decision.value, "risk_score": verdict.risk_score,
                "label_pred": int(verdict.decision != Decision.ALLOW), "top_reasons": ";".join(top),
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1), "timings_ms": json.dumps(verdict.timings_ms)}

    return await asyncio.gather(*(one(i, u) for i, u in enumerate(urls)))


def output_columns(batch: BatchInput) -> list[str]:
    """Our columns first, then the input's other columns (an id or label), renamed if a name clashes."""
    return COLUMNS + [f"input_{c}" if c in COLUMNS else c for c in batch.extra_columns]


def merge_row(batch: BatchInput, index: int, row: dict) -> dict:
    extra = batch.rows[index].extra
    return {**row, **{f"input_{c}" if c in COLUMNS else c: extra.get(c, "") for c in batch.extra_columns}}


def write_csv(rows: list[dict], columns: list[str] = COLUMNS) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns)
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def summarise(batch: BatchInput, rows: list[dict]) -> dict:
    """Decision counts and, when the input has a label column, the confusion matrix of `label_pred`."""
    summary: dict = {"rows": len(rows), "decisions": {}}
    for row in rows:
        summary["decisions"][row["decision"]] = summary["decisions"].get(row["decision"], 0) + 1
    if batch.label_column is None:
        return summary
    tp = fp = tn = fn = unscored = unlabelled = 0
    for source, row in zip(batch.rows, rows):
        truth = LABEL_VALUES.get(source.extra.get(batch.label_column, "").strip().lower())
        if truth is None:
            unlabelled += 1
        elif row["label_pred"] == "":
            unscored += 1
        elif truth and row["label_pred"]:
            tp += 1
        elif truth:
            fn += 1
        elif row["label_pred"]:
            fp += 1
        else:
            tn += 1
    summary["labels"] = {
        "column": batch.label_column, "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "precision": round(tp / (tp + fp), 4) if tp + fp else None,
        "recall": round(tp / (tp + fn), 4) if tp + fn else None,
        "fpr": round(fp / (fp + tn), 4) if fp + tn else None,
        "unscored": unscored, "unlabelled": unlabelled,
    }
    return summary
