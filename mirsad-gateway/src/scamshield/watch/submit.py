"""Reputation pre-fill: have the engine investigate queued candidates before any user visits them.

`POST /v1/check {url, depth: "deep", source: "watcher"}` stores the verdict in the engine's reputation
table, so a later visit through the gateway is answered from it. We record when each verdict came back.

If the engine is down, candidates stay queued in `data/watch.db` and are retried with exponential backoff.
Verdicts that are not final yet (deep crawl still running) are polled through `GET /v1/verdicts/{id}`.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from scamshield import config
from scamshield.watch import settings
from scamshield.watch.store import Store

log = logging.getLogger(__name__)


class Submitter:
    def __init__(self, store: Store | None = None, engine_url: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.store = store or Store()
        self.transport = transport
        self.engine_url = (engine_url or config.ENGINE_URL).rstrip("/")
        self.sent = 0
        self.verdicts = 0
        self.errors = 0

    async def _one(self, http: httpx.AsyncClient, row) -> None:
        host = row["host"]
        try:
            if row["status"] == "pending" and row["verdict_id"]:
                r = await http.get(f"{self.engine_url}/v1/verdicts/{row['verdict_id']}")
            else:
                r = await http.post(f"{self.engine_url}/v1/check", json={"url": row["url"], "depth": "deep", "source": "watcher"})
                self.sent += 1
            r.raise_for_status()
            verdict = r.json()
        except (httpx.HTTPError, ValueError) as e:
            self.errors += 1
            self.store.retry_later(host, f"{type(e).__name__}: {e}")
            return
        self.verdicts += 1
        self.store.record_verdict(host, verdict)

    async def drain(self, limit: int = 50) -> int:
        """Submit up to `limit` due candidates; returns how many were attempted."""
        rows = self.store.due(limit)
        if not rows:
            return 0
        sem = asyncio.Semaphore(settings.SUBMIT_CONCURRENCY)
        async with httpx.AsyncClient(timeout=settings.SUBMIT_TIMEOUT_S, transport=self.transport) as http:
            async def run(row):
                async with sem:
                    await self._one(http, row)

            await asyncio.gather(*(run(r) for r in rows))
        return len(rows)

    async def run_forever(self) -> None:
        last_recheck = 0.0
        while True:
            attempted = await self.drain()
            loop_time = asyncio.get_running_loop().time()
            if loop_time - last_recheck > 300:
                self.store.recheck_blocklists()
                last_recheck = loop_time
            if attempted == 0:
                await asyncio.sleep(settings.SUBMIT_INTERVAL_S)
