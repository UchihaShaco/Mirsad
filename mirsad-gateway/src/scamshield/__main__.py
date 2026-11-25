"""Mirsad (مرصاد) website shield command line: `python -m scamshield serve | check <url> | batch in.csv -o out.csv | reset`.

The command keeps the package name `scamshield`; only the words people read say Mirsad."""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
from pathlib import Path

from scamshield import config

COLOURS = {"allow": "\033[32m", "warn": "\033[33m", "block": "\033[31m"}
BOLD, DIM, RESET = "\033[1m", "\033[2m", "\033[0m"


def _paint(text: str, code: str, enabled: bool) -> str:
    return f"{code}{text}{RESET}" if enabled else text


def render(verdict, colour: bool) -> str:
    d = verdict.decision.value
    lines = [
        _paint(f"{d.upper():<6} {verdict.risk_score:5.1f}/100  {verdict.url}", BOLD + COLOURS[d], colour),
        f"  stage={verdict.stage.value} final={verdict.final}" + (f"  final_url={verdict.final_url}" if verdict.final_url and verdict.final_url != verdict.url else ""),
        f"  {verdict.summary_en}",
        f"  {verdict.summary_ar}",
        "",
    ]
    for r in verdict.reasons:
        sign = _paint(f"{r.points:+7.1f}", COLOURS["block"] if r.points > 0 else COLOURS["allow"] if r.points < 0 else DIM, colour)
        lines.append(f"  {sign}  [{r.severity.value:<8}] {r.code}")
        lines.append(f"            {r.title_en}")
        if r.title_ar:
            lines.append(f"            {r.title_ar}")
        if r.detail:
            lines.append(_paint(f"            {r.detail[:200]}", DIM, colour))
    if verdict.review:
        lines += ["", f"  review: {verdict.review.outcome.value} ({verdict.review.confidence:.0%}) {verdict.review.summary_en}"]
    timings = ", ".join(f"{k}={v:.0f}ms" for k, v in verdict.timings_ms.items())
    lines += ["", _paint(f"  timings: {timings}", DIM, colour)]
    return "\n".join(lines)


async def _check(args: argparse.Namespace) -> int:
    from scamshield.api.batch import clean_url, invalid_url
    from scamshield.engine.pipeline import Engine

    url = clean_url(args.url)
    why = invalid_url(url)
    if why:
        print(f"mirsad check: {why}: {args.url!r}", file=sys.stderr)
        return 2
    engine = await Engine(review_enabled=args.review).start()
    try:
        verdict = await engine.investigate(url, args.depth, background=args.review)
        if args.review:
            await engine.drain()
            verdict = await engine.store.get_verdict(verdict.id) or verdict
    finally:
        await engine.close()
    if args.json:
        print(verdict.model_dump_json(indent=2, exclude={"page": {"html"}}))
    else:
        print(render(verdict, sys.stdout.isatty()))
    return 0


async def _batch(args: argparse.Namespace) -> int:
    from scamshield.api.batch import (DEFAULT_CONCURRENCY, BatchError, merge_row, output_columns, read_input, score_rows,
                                      summarise)
    from scamshield.engine.pipeline import Engine

    try:
        batch = read_input(Path(args.input).read_text(encoding="utf-8-sig", errors="replace"))
    except (OSError, BatchError) as exc:
        print(f"mirsad batch: {exc}", file=sys.stderr)
        return 2
    # Nothing else runs in this process, so the batch may use as many slots as it asks for.
    concurrency = args.concurrency or DEFAULT_CONCURRENCY
    engine = await Engine(review_enabled=args.review, background_slots=concurrency).start()
    await engine.warm_up()
    with open(args.output, "w", newline="", encoding="utf-8") as out:
        writer = csv.DictWriter(out, fieldnames=output_columns(batch))
        writer.writeheader()
        done: dict[int, dict] = {}
        written = 0

        def write(index: int, row: dict) -> None:
            """Rows land in input order as soon as every earlier row is finished."""
            nonlocal written
            done[index] = row
            while written in done:
                writer.writerow(merge_row(batch, written, done.pop(written)))
                written += 1
            out.flush()

        try:
            rows = await score_rows(engine, [r.url for r in batch.rows], depth=args.depth, concurrency=concurrency,
                                    review=args.review, on_row=write)
        finally:
            await engine.close()
    print(f"{len(rows)} URLs -> {args.output}  " + json.dumps(summarise(batch, rows)))
    return 0


async def _reset(args: argparse.Namespace) -> int:
    from scamshield.engine.store import Store

    store = Store()
    await store.open()
    try:
        removed = await store.reset(None if args.all else args.hosts)
    finally:
        await store.close()
    print(f"cleared {'everything' if args.all else f'{removed} host(s) matching {args.hosts!r}'} in {store.path}"
          " (restart the engine so it drops its in-memory copy)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scamshield",
                                     description="Mirsad (مرصاد): website shield investigation engine")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the HTTP API")
    serve.add_argument("--host", default=config.API_HOST)
    serve.add_argument("--port", type=int, default=config.API_PORT)
    serve.add_argument("--reload", action="store_true")

    depths = ["reputation", "url", "page", "deep"]
    check = sub.add_parser("check", help="investigate one URL")
    check.add_argument("url")
    check.add_argument("--depth", choices=depths, default="page")
    check.add_argument("--json", action="store_true", help="print the verdict as JSON")
    check.add_argument("--review", action="store_true", help="wait for the crawl and the review of a block")

    batch = sub.add_parser("batch", help="investigate every URL in a CSV with a 'url' column")
    batch.add_argument("input")
    batch.add_argument("-o", "--output", required=True)
    batch.add_argument("--depth", choices=depths, default="page")
    batch.add_argument("--concurrency", type=int, default=None)
    batch.add_argument("--review", action="store_true", help="let the reviewer re-check every block")

    reset = sub.add_parser("reset", help="clear stored verdicts and host rows for a clean demo run")
    scope = reset.add_mutually_exclusive_group(required=True)
    scope.add_argument("--hosts", metavar="PATTERN", help="hosts matching this glob, e.g. '*.example.com'")
    scope.add_argument("--all", action="store_true", help="everything: verdicts, hosts, changes, visits, events")

    args = parser.parse_args(argv)
    if args.command == "serve":
        import uvicorn

        uvicorn.run("scamshield.api.app:app", host=args.host, port=args.port, reload=args.reload)
        return 0
    return asyncio.run({"check": _check, "batch": _batch, "reset": _reset}[args.command](args))


if __name__ == "__main__":
    sys.exit(main())
