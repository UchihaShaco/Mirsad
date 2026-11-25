"""Live sanity check on well-known LEGITIMATE sites, through the engine's own fetcher.

Fetches each site once with `scamshield.engine.fetch_page` (mobile Chrome identity, GET only) and
caches the snapshots in ml/page/cache/live_legit_snapshots.jsonl, so later runs score the same
HTML. Prints P(scam) and the top features of the installed page model for each site and writes
ml/page/cache/live_legit_scores_<tag>.json.

    .venv/bin/python -m ml.page.live_legit --tag before          # fetch (first run) + score
    .venv/bin/python -m ml.page.live_legit --tag after           # score the cached snapshots
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from scamshield.schemas import PageSnapshot

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "ml" / "page" / "cache"
SNAPS = CACHE / "live_legit_snapshots.jsonl"
SITES = [
    "https://example.com/", "https://www.khaleejtimes.com/", "https://www.adcb.com/", "https://www.bankfab.com/",
    "https://www.emiratesnbd.com/", "https://u.ae/", "https://www.tamm.abudhabi/", "https://www.dubaipolice.gov.ae/",
    "https://www.rta.ae/", "https://www.noon.com/", "https://www.amazon.ae/", "https://www.bbc.com/",
    "https://www.aljazeera.net/", "https://www.alkhaleej.ae/", "https://www.wikipedia.org/", "https://github.com/login",
    "https://www.paypal.com/signin", "https://login.microsoftonline.com/", "https://www.etisalat.ae/",
    "https://www.emiratespost.ae/",
]


async def fetch_all() -> list[PageSnapshot]:
    from scamshield.engine import fetch_page

    out = []
    for url in SITES:
        try:
            snap = await asyncio.wait_for(fetch_page(url), timeout=20)
            out.append(snap)
            print("fetched", url, snap.status, len(snap.html), flush=True)
        except Exception as exc:
            print("failed", url, type(exc).__name__, exc, flush=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="current")
    ap.add_argument("--refetch", action="store_true")
    args = ap.parse_args()
    if args.refetch or not SNAPS.exists():
        snaps = asyncio.run(fetch_all())
        SNAPS.write_text("\n".join(s.model_dump_json() for s in snaps))
    snaps = [PageSnapshot.model_validate_json(line) for line in SNAPS.read_text().splitlines() if line.strip()]
    from scamshield.models import page_model

    rows = []
    for s in snaps:
        score = page_model.score_page(s)
        top = page_model.top_features(s, 4)
        rows.append({"url": s.url, "final_url": s.final_url, "status": s.status, "html_chars": len(s.html),
                     "score": None if score is None else round(score, 3),
                     "top": [(n, round(v, 2)) for n, v in top]})
        print(f"{'abstain' if score is None else f'{score:.3f}':>8}  {s.final_url[:60]:<60} {rows[-1]['top']}")
    (CACHE / f"live_legit_scores_{args.tag}.json").write_text(json.dumps(
        {"threshold": page_model.info().get("threshold"), "rows": rows}, indent=2))


if __name__ == "__main__":
    main()
