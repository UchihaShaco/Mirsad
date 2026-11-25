"""Shared pieces for watcher sources: the candidate type, the source interface and a polite HTTP client."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import AsyncIterator, Protocol

import httpx

from scamshield.schemas import utcnow
from scamshield.watch import settings


@dataclass
class Candidate:
    url: str
    source: str  # ct | nrd | sweep | search | listings
    brand_hint: str | None
    first_seen: datetime = field(default_factory=utcnow)  # earliest public sign of the site (cert / registration)
    host: str = ""
    technique: str = ""
    score: float = 0.0
    evidence: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.host:
            self.host = httpx.URL(self.url).host.lower()


class Source(Protocol):
    name: str

    def candidates(self, *, once: bool = False) -> AsyncIterator[Candidate]: ...


class RateLimiter:
    """At most one call per `interval` seconds per key."""

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self._next: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def wait(self, key: str = "") -> None:
        async with self._lock:
            now = time.monotonic()
            at = max(now, self._next.get(key, 0.0))
            self._next[key] = at + self.interval
        if at > now:
            await asyncio.sleep(at - now)


def client(*, timeout: float = 30.0, **kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, headers={"User-Agent": settings.USER_AGENT}, follow_redirects=True, **kw)


async def get_with_backoff(http: httpx.AsyncClient, url: str, *, tries: int = 4, **kw) -> httpx.Response:
    """GET that waits out 429 / 5xx responses (honouring Retry-After) before giving up."""
    delay = 2.0
    for attempt in range(tries):
        try:
            r = await http.get(url, **kw)
        except httpx.TransportError:
            if attempt == tries - 1:
                raise
        else:
            if r.status_code != 429 and r.status_code < 500:
                return r
            if attempt == tries - 1:
                return r
            retry_after = r.headers.get("retry-after", "")
            if retry_after.isdigit():
                delay = min(float(retry_after), 300.0)
        await asyncio.sleep(delay)
        delay *= 2
    raise RuntimeError("unreachable")
