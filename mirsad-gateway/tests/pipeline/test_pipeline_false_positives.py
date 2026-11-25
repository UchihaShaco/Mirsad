"""False-positive regression: real legitimate sites (recorded snapshots, no network) must stay allowed.

The worst case is used on purpose: no reputation, domain intel or brand data at all, and one model
claiming 99% scam (two models agreeing is corroboration by design). Rule findings on the real pages
must not turn that into a warning or a block.

The snapshots are copies of real sites' pages, so they stay on the machine that recorded them and are not in the
repository (tests/pipeline/snapshots/ is git-ignored); without them these tests skip. To record or re-record one,
from mirsad-gateway/ (the file name is the snapshot's host):

    PYTHONPATH=src python -c "import asyncio, gzip, sys; from scamshield.engine.fetch import fetch_page; \
    s = asyncio.run(fetch_page(sys.argv[1])); \
    open(f'tests/pipeline/snapshots/{s.url.split(\"/\")[2]}.json.gz', 'wb').write(gzip.compress(s.model_dump_json().encode()))" \
    https://www.adcb.com/
"""

from __future__ import annotations

import gzip
from pathlib import Path

import pytest

from scamshield.engine.pipeline import Components, Engine
from scamshield.engine.rules import parse_url
from scamshield.engine.store import Store
from scamshield.schemas import Decision, PageSnapshot

SNAPSHOTS = Path(__file__).parent / "snapshots"
# host -> highest acceptable decision
CEILINGS = {
    "www.adcb.com": Decision.ALLOW, "www.emiratesnbd.com": Decision.ALLOW, "www.bankfab.com": Decision.ALLOW,
    "www.mashreq.com": Decision.ALLOW, "www.tamm.abudhabi": Decision.ALLOW, "u.ae": Decision.ALLOW,
    "www.adpolice.gov.ae": Decision.ALLOW, "www.rta.ae": Decision.ALLOW, "www.emiratespost.ae": Decision.ALLOW,
    "www.etisalat.ae": Decision.ALLOW, "www.khaleejtimes.com": Decision.ALLOW, "gulfnews.com": Decision.ALLOW,
    "www.thenationalnews.com": Decision.ALLOW, "www.bbc.com": Decision.ALLOW, "www.wikipedia.org": Decision.ALLOW,
    "example.com": Decision.ALLOW,
}
ORDER = [Decision.ALLOW, Decision.WARN, Decision.BLOCK]


def load(host: str) -> PageSnapshot:
    path = SNAPSHOTS / f"{host}.json.gz"
    if not path.exists():
        pytest.skip(f"recorded page {path.name} is not in this checkout (real sites' pages are kept out of the "
                    "repository); record it as the module docstring says")
    return PageSnapshot.model_validate_json(gzip.decompress(path.read_bytes()))


@pytest.mark.parametrize("confident", ["url", "page"])
@pytest.mark.parametrize("host", sorted(CEILINGS))
async def test_legitimate_site_stays_below_its_ceiling_without_intel(host, confident, tmp_path):
    snapshot = load(host)

    async def fetch_page(url: str, **kwargs) -> PageSnapshot:
        return snapshot if parse_url(url).url == parse_url(snapshot.url).url else PageSnapshot(url=url, final_url=url, error="offline")

    components = Components(fetch_page=fetch_page, score_url=lambda url: 0.99 if confident == "url" else 0.5,
                            score_page=lambda page: 0.99 if confident == "page" else 0.5,
                            reputation=None, assess_domain=None, match_brand=None, link_campaign=None,
                            list_campaigns=None, review_verdict=None, build_pack=None, cloaking_probe=None)
    engine = await Engine(Store(tmp_path / "fp.db"), components).start()
    try:
        verdict = await engine.investigate(snapshot.url, background=False)
    finally:
        await engine.close()
    assert ORDER.index(verdict.decision) <= ORDER.index(CEILINGS[host]), [(r.code, r.points) for r in verdict.reasons if r.points]
