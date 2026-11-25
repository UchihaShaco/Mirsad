"""Watcher: reputation pre-fill and campaign linking.

External sources are not the detection method; they only decide which sites the engine should
investigate before any user visits them. New TLS certificates, newly registered domains and a look-alike
sweep of UAE brand domains produce candidates; each is checked by the engine ahead of time
(`POST /v1/check`, `source: "watcher"`) so the verdict is already in the reputation table when a user
arrives. Flagged verdicts are clustered into campaigns (`campaigns.py`).

    python -m scamshield.watch run [--sources ct,nrd,sweep] [--once] [--no-submit]
    python -m scamshield.watch ct --once            # any single source (ct, nrd, sweep; optional: search, listings)
    python -m scamshield.watch submit [--once]      # only feed queued candidates to the engine
    python -m scamshield.watch stats                # counts and lead-time figures
    python -m scamshield.watch campaigns            # linked campaigns as JSON
    python -m scamshield.watch relink               # recompute campaign links from stored features
    python -m scamshield.watch phones [FILE]        # fake-helpline check on any text (stdin if no FILE)
    python -m scamshield.watch match HOST [HOST...] # explain the brand / look-alike filter for hostnames
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from collections import Counter

from scamshield.watch import settings
from scamshield.watch.store import Store

log = logging.getLogger("scamshield.watch")

SOURCE_NAMES = ("ct", "nrd", "sweep", "search", "listings")


def make_source(name: str, store: Store):
    if name == "ct":
        from scamshield.watch.ct import CTSource
        return CTSource(store)
    if name == "nrd":
        from scamshield.watch.nrd import NRDSource
        return NRDSource(store)
    if name == "sweep":
        from scamshield.watch.sweep import SweepSource
        return SweepSource(store)
    if name == "search":
        from scamshield.watch.search import SearchSource
        return SearchSource(store)
    if name == "listings":
        from scamshield.watch.listings import ListingsSource
        return ListingsSource(store)
    raise ValueError(f"unknown source {name!r}")


async def _consume(source, store: Store, once: bool, report: dict) -> None:
    started = time.monotonic()
    new = Counter()
    examples: list[dict] = []
    async for c in source.candidates(once=once):
        if store.add(c):
            new[c.brand_hint or "?"] += 1
            if len(examples) < 25:
                examples.append({"host": c.host, "brand": c.brand_hint, "technique": c.technique, "score": c.score})
    report[source.name] = {
        "new_candidates": sum(new.values()), "by_brand": dict(new.most_common(15)), "examples": examples,
        "seconds": round(time.monotonic() - started, 1),
        **{k: getattr(source, k) for k in ("scanned", "checked", "resolved", "results", "listings") if hasattr(source, k)},
        "flagged_listings": len(getattr(source, "flagged", [])) if hasattr(source, "flagged") else None,
        "errors": getattr(source, "errors", [])[:10],
    }


async def _supervise(name: str, store: Store, once: bool, report: dict) -> None:
    """Run one source; in continuous mode a crash restarts it after a minute instead of stopping the service."""
    while True:
        try:
            await _consume(make_source(name, store), store, once, report)
            return
        except Exception as e:
            log.exception("source %s failed", name)
            report[name] = {"error": f"{type(e).__name__}: {e}"}
            if once:
                return
            await asyncio.sleep(60)


async def run(sources: list[str], once: bool, submit: bool) -> dict:
    from scamshield.watch.submit import Submitter

    store = Store()
    report: dict = {}
    tasks = [asyncio.create_task(_supervise(n, store, once, report)) for n in sources]
    submitter = Submitter(store)
    if once:
        await asyncio.gather(*tasks)
        if submit:
            while await submitter.drain() and submitter.errors == 0:
                pass
            report["submit"] = {"sent": submitter.sent, "verdicts": submitter.verdicts, "errors": submitter.errors}
        return report
    if submit:
        tasks.append(asyncio.create_task(submitter.run_forever()))
    await asyncio.gather(*tasks)
    return report


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m scamshield.watch")
    ap.add_argument("command", choices=("run", "submit", "stats", "campaigns", "relink", "phones", "match") + SOURCE_NAMES)
    ap.add_argument("args", nargs="*")
    ap.add_argument("--sources", default=",".join(settings.SOURCES))
    ap.add_argument("--once", action="store_true", help="one pass over each source, then exit")
    ap.add_argument("--no-submit", action="store_true", help="queue candidates without calling the engine")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING, format="%(asctime)s %(name)s %(message)s")

    if a.command in ("run",) + SOURCE_NAMES:
        names = [a.command] if a.command in SOURCE_NAMES else [s for s in a.sources.split(",") if s in SOURCE_NAMES]
        try:
            _print(asyncio.run(run(names, a.once, not a.no_submit)))
        except KeyboardInterrupt:
            return 130
    elif a.command == "submit":
        from scamshield.watch.submit import Submitter

        sub = Submitter(Store())
        if a.once:
            asyncio.run(sub.drain())
            _print({"sent": sub.sent, "verdicts": sub.verdicts, "errors": sub.errors})
        else:
            asyncio.run(sub.run_forever())
    elif a.command == "stats":
        _print(Store().stats())
    elif a.command == "campaigns":
        from scamshield.watch.campaigns import list_campaigns

        _print(list_campaigns())
    elif a.command == "relink":
        from scamshield.watch.campaigns import list_campaigns, rebuild_edges

        _print({"edges": rebuild_edges(), "campaigns": len(list_campaigns())})
    elif a.command == "phones":
        from scamshield.watch.listings import check_text

        text = open(a.args[0], encoding="utf-8").read() if a.args else sys.stdin.read()
        _print(check_text(text))
    elif a.command == "match":
        from scamshield.watch.match import match_host

        _print({h: (m.__dict__ if (m := match_host(h)) else None) for h in a.args})
    return 0


if __name__ == "__main__":
    sys.exit(main())
