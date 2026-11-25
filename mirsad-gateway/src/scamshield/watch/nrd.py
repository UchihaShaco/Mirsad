"""Newly registered domains: WhoisDS free daily list (plus any extra plain-text lists), filtered for UAE lures.

WhoisDS publishes one zip a day at
`https://www.whoisds.com/whois-database/newly-registered-domains/{base64("YYYY-MM-DD.zip")}/nrd`
(free, about 70k domains/day, reuse allowed). Files are cached under `data/watch_cache/nrd/` and each
day is processed once in continuous mode. Extra lists (one domain per line, gzip or plain) can be
added with `SCAMSHIELD_WATCH_NRD_URLS`.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import io
import logging
import os
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from typing import AsyncIterator, Iterable

import httpx

from scamshield.watch import settings
from scamshield.watch.base import Candidate, client, get_with_backoff
from scamshield.watch.match import match_host
from scamshield.watch.store import Store

log = logging.getLogger(__name__)

WHOISDS_URL = "https://www.whoisds.com/whois-database/newly-registered-domains/{token}/nrd"
EXTRA_URLS = [u.strip() for u in os.environ.get("SCAMSHIELD_WATCH_NRD_URLS", "").split(",") if u.strip()]


def whoisds_url(day: date) -> str:
    token = base64.b64encode(f"{day.isoformat()}.zip".encode()).decode()
    return WHOISDS_URL.format(token=token)


def domains_from_bytes(data: bytes) -> list[str]:
    """Domain names from a zip / gzip / plain-text list (one per line; comments and blanks skipped)."""
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            text = "\n".join(zf.read(n).decode("utf-8", "replace") for n in zf.namelist()
                             if not n.endswith("/") and zf.getinfo(n).file_size < 200_000_000)
    elif data[:2] == b"\x1f\x8b":
        text = gzip.decompress(data).decode("utf-8", "replace")
    else:
        text = data.decode("utf-8", "replace")
    out = []
    for line in text.splitlines():
        d = line.strip().split(",")[0].strip().lower().rstrip(".")
        if d and not d.startswith("#") and "." in d and " " not in d:
            out.append(d)
    return out


def filter_domains(domains: Iterable[str], *, source: str, first_seen: datetime, evidence: dict) -> list[Candidate]:
    out = []
    for d in domains:
        m = match_host(d)
        if m and m.score >= settings.MIN_SCORE:
            out.append(Candidate(url=f"http://{d}/", source=source, brand_hint=m.brand, first_seen=first_seen, host=d,
                                 technique=m.technique, score=m.score, evidence={"matched_on": m.matched_on, **evidence}))
    return out


class NRDSource:
    name = "nrd"

    def __init__(self, store: Store | None = None) -> None:
        self.store = store or Store()
        self.scanned = 0
        self.errors: list[str] = []
        self.cache = settings.CACHE_DIR / "nrd"

    async def _download(self, http: httpx.AsyncClient, url: str, cache_name: str, *, immutable: bool) -> bytes | None:
        path = self.cache / cache_name
        if immutable and path.exists() and path.stat().st_size > 0:
            return path.read_bytes()
        r = await get_with_backoff(http, url)
        if r.status_code != 200 or not r.content or r.content[:15].lower().startswith(b"<!doctype"):
            self.errors.append(f"{url}: HTTP {r.status_code}")
            return None
        self.cache.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
        return r.content

    async def _scan(self, http: httpx.AsyncClient, once: bool) -> list[Candidate]:
        found: list[Candidate] = []
        today = datetime.now(timezone.utc).date()
        for back in range(settings.NRD_DAYS):
            day = today - timedelta(days=back)
            key = f"nrd:whoisds:{day.isoformat()}"
            if not once and self.store.get_state(key):
                continue
            data = await self._download(http, whoisds_url(day), f"whoisds-{day.isoformat()}.zip", immutable=True)
            if data is None:
                continue
            domains = domains_from_bytes(data)
            self.scanned += len(domains)
            # The file for day D lists registrations seen on D-1 (UTC); use the start of D-1 as registration time.
            registered = datetime.combine(day - timedelta(days=1), time(0), tzinfo=timezone.utc)
            found += filter_domains(domains, source=self.name, first_seen=registered,
                                    evidence={"list": "whoisds", "list_date": day.isoformat()})
            self.store.set_state(key, len(domains))
        for i, url in enumerate(EXTRA_URLS):
            data = await self._download(http, url, f"extra-{i}.txt", immutable=False)
            if data:
                domains = domains_from_bytes(data)
                self.scanned += len(domains)
                found += filter_domains(domains, source=self.name, first_seen=datetime.now(timezone.utc),
                                        evidence={"list": url})
        return found

    async def candidates(self, *, once: bool = False) -> AsyncIterator[Candidate]:
        async with client(timeout=120) as http:
            while True:
                try:
                    for c in await self._scan(http, once):
                        yield c
                except (httpx.HTTPError, zipfile.BadZipFile, OSError) as e:
                    self.errors.append(f"{type(e).__name__}: {e}")
                    log.warning("nrd: %s", e)
                if once:
                    return
                await asyncio.sleep(settings.NRD_POLL_S)
