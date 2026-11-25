"""New TLS certificates: tail the public Certificate Transparency logs directly.

No account and no third-party stream: we read the logs Chrome trusts (from Google's public log list),
both classic RFC 6962 logs (`get-sth` / `get-entries`) and the newer static "tiled" logs (Let's Encrypt,
Google, ...; `checkpoint` + `tile/data/...`). Every hostname in each new certificate is run through the
brand / look-alike filter. Cursors are saved so a restart resumes where it stopped.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
import logging
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Iterator

import httpx
from cryptography import x509
from cryptography.x509.oid import NameOID

from scamshield.watch import settings
from scamshield.watch.base import Candidate, client, get_with_backoff
from scamshield.watch.match import match_host
from scamshield.watch.store import Store

log = logging.getLogger(__name__)

TILE_WIDTH = 256


@dataclass
class Entry:
    index: int
    timestamp_ms: int
    der: bytes


def tile_path(n: int) -> str:
    """Static CT tile index encoding: 1234067 -> x001/x234/067."""
    s = str(n)
    s = s.zfill((len(s) + 2) // 3 * 3)
    groups = [s[i:i + 3] for i in range(0, len(s), 3)]
    return "/".join([f"x{g}" for g in groups[:-1]] + [groups[-1]])


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data, self.pos = data, 0

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            raise ValueError("truncated CT entry")
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def uint(self, n: int) -> int:
        return int.from_bytes(self.take(n), "big")

    def vec(self, len_bytes: int) -> bytes:
        return self.take(self.uint(len_bytes))


def parse_tile(data: bytes, first_index: int) -> Iterator[Entry]:
    """Leaves of a static-ct-api data tile (TileLeaf structs, back to back)."""
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    r = _Reader(data)
    index = first_index
    while r.pos < len(data):
        ts = r.uint(8)
        entry_type = r.uint(2)
        if entry_type == 0:
            der = r.vec(3)
            r.vec(2)  # extensions
            r.vec(2)  # chain fingerprints
        elif entry_type == 1:
            r.take(32)  # issuer key hash
            r.vec(3)  # TBSCertificate
            r.vec(2)  # extensions
            der = r.vec(3)  # pre-certificate
            r.vec(2)  # chain fingerprints
        else:
            raise ValueError(f"unknown CT entry type {entry_type}")
        yield Entry(index, ts, der)
        index += 1


def parse_rfc6962(leaf_input: str, extra_data: str, index: int) -> Entry:
    leaf = base64.b64decode(leaf_input)
    _version, _leaf_type, ts, entry_type = struct.unpack(">BBQH", leaf[:12])
    if entry_type == 0:
        der = _Reader(leaf[12:]).vec(3)
    else:
        der = _Reader(base64.b64decode(extra_data)).vec(3)  # PrecertChainEntry.pre_certificate
    return Entry(index, ts, der)


def cert_names(der: bytes) -> tuple[list[str], dict]:
    """DNS names (SANs + CN) and a few certificate facts."""
    cert = x509.load_der_x509_certificate(der)
    names: list[str] = []
    try:
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        pass
    for attr in cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME):
        if isinstance(attr.value, str) and attr.value not in names:
            names.append(attr.value)
    issuer = cert.issuer.get_attributes_for_oid(NameOID.ORGANIZATION_NAME)
    facts = {"issuer": issuer[0].value if issuer else None, "not_before": cert.not_valid_before_utc.isoformat()}
    return [n.lower() for n in names], facts


class RfcLog:
    def __init__(self, http: httpx.AsyncClient, url: str, name: str) -> None:
        self.http, self.url, self.name = http, url.rstrip("/") + "/", name
        self.batch = 256

    async def size(self) -> int:
        r = await get_with_backoff(self.http, self.url + "ct/v1/get-sth")
        r.raise_for_status()
        return int(r.json()["tree_size"])

    async def entries(self, start: int, end: int) -> AsyncIterator[Entry]:
        pos = start
        while pos < end:
            r = await get_with_backoff(self.http, self.url + "ct/v1/get-entries",
                                       params={"start": pos, "end": min(end, pos + self.batch) - 1})
            r.raise_for_status()
            got = r.json().get("entries", [])
            if not got:
                return
            self.batch = max(16, len(got))  # logs cap the page size; adapt to it
            for i, e in enumerate(got):
                yield parse_rfc6962(e["leaf_input"], e.get("extra_data", ""), pos + i)
            pos += len(got)


class TiledLog:
    def __init__(self, http: httpx.AsyncClient, url: str, name: str) -> None:
        self.http, self.url, self.name = http, url.rstrip("/") + "/", name

    async def size(self) -> int:
        r = await get_with_backoff(self.http, self.url + "checkpoint")
        r.raise_for_status()
        return int(r.text.splitlines()[1])

    async def _tile(self, n: int, width: int) -> bytes:
        path = f"tile/data/{tile_path(n)}" + ("" if width == TILE_WIDTH else f".p/{width}")
        r = await get_with_backoff(self.http, self.url + path)
        if r.status_code == 404 and width != TILE_WIDTH:  # partial tile already completed
            r = await get_with_backoff(self.http, self.url + f"tile/data/{tile_path(n)}")
        r.raise_for_status()
        return r.content

    async def entries(self, start: int, end: int) -> AsyncIterator[Entry]:
        first, last = start // TILE_WIDTH, (end - 1) // TILE_WIDTH
        sem = asyncio.Semaphore(4)

        async def fetch(n: int) -> list[Entry]:
            width = min(TILE_WIDTH, end - n * TILE_WIDTH)
            async with sem:
                data = await self._tile(n, width)
            return [e for e in parse_tile(data, n * TILE_WIDTH) if start <= e.index < end]

        for chunk in range(first, last + 1, 8):
            for batch in await asyncio.gather(*(fetch(n) for n in range(chunk, min(chunk + 8, last + 1)))):
                for e in batch:
                    yield e


async def _log_list(http: httpx.AsyncClient) -> dict:
    cache = settings.CACHE_DIR / "ct_log_list.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < 86400:
        return json.loads(cache.read_text())
    r = await get_with_backoff(http, settings.CT_LOG_LIST_URL)
    r.raise_for_status()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(r.text)
    return r.json()


def select_logs(log_list: dict, operators: list[str], now: datetime) -> list[tuple[str, str, str]]:
    """(kind, url, description) of usable logs that accept certificates issued now.

    Log shards are partitioned by certificate expiry, so a certificate issued today (valid 6 to 398 days)
    lands in the current or one of the next shards.
    """
    horizon = now + timedelta(days=400)
    wanted = {o.lower() for o in operators}
    out = []
    for op in log_list.get("operators", []):
        if wanted and op.get("name", "").lower() not in wanted:
            continue
        for kind, key, url_field in (("rfc", "logs", "url"), ("tiled", "tiled_logs", "monitoring_url")):
            for lg in op.get(key, []):
                if "usable" not in lg.get("state", {}):
                    continue
                ti = lg.get("temporal_interval", {})
                start = datetime.fromisoformat(ti.get("start_inclusive", "1970-01-01T00:00:00Z").replace("Z", "+00:00"))
                end = datetime.fromisoformat(ti.get("end_exclusive", "9999-01-01T00:00:00Z").replace("Z", "+00:00"))
                if start < horizon and end > now and lg.get(url_field):
                    out.append((kind, lg[url_field], lg.get("description", lg[url_field])))
    return out


class CTSource:
    name = "ct"

    def __init__(self, store: Store | None = None) -> None:
        self.store = store or Store()
        self.scanned = 0
        self.errors: list[str] = []

    def _candidates_from(self, entry: Entry, log_name: str, seen: set[str]) -> Iterator[Candidate]:
        try:
            names, facts = cert_names(entry.der)
        except Exception:  # certificates are hostile input; skip anything cryptography rejects
            return
        self.scanned += 1
        for name in names:
            host = name.removeprefix("*.")
            if host in seen:
                continue
            m = match_host(host)
            if m is None or m.score < settings.MIN_SCORE:
                continue
            seen.add(host)
            logged = datetime.fromtimestamp(entry.timestamp_ms / 1000, tz=timezone.utc)
            yield Candidate(url=f"https://{host}/", source=self.name, brand_hint=m.brand, first_seen=logged, host=host,
                            technique=m.technique, score=m.score,
                            evidence={"matched_on": m.matched_on, "log": log_name, "index": entry.index,
                                      "sans": names[:50], **facts})

    async def _poll(self, lg, once: bool, out: asyncio.Queue, seen: set[str]) -> None:
        key = f"ct:{lg.url}"
        size = await lg.size()
        cursor = self.store.get_state(key)
        if once or cursor is None:
            cursor = max(0, size - settings.CT_ONCE_ENTRIES)
        cursor = max(cursor, size - settings.CT_MAX_LAG)
        async for entry in lg.entries(cursor, size):
            for c in self._candidates_from(entry, lg.name, seen):
                await out.put(c)
            if entry.index % 1024 == 0:
                self.store.set_state(key, entry.index)
        self.store.set_state(key, size)

    async def _tail(self, lg, once: bool, out: asyncio.Queue) -> None:
        seen: set[str] = set()
        failures = 0
        while True:
            try:
                await asyncio.wait_for(self._poll(lg, once, out, seen), timeout=settings.CT_POLL_DEADLINE_S)
                failures = 0
            except (httpx.HTTPError, ValueError, KeyError, asyncio.TimeoutError) as e:
                failures += 1
                self.errors.append(f"{lg.name}: {type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}")
                log.warning("ct log %s (failure %d): %s", lg.name, failures, str(e).splitlines()[0] if str(e) else e)
            if once:
                return
            # Back off from a log that rate-limits or errors (10 s doubling up to 15 min).
            await asyncio.sleep(min(settings.CT_POLL_S * 2 ** failures, 900))

    async def candidates(self, *, once: bool = False) -> AsyncIterator[Candidate]:
        async with client(timeout=40) as http:
            logs = []
            for kind, url, desc in select_logs(await _log_list(http), settings.CT_OPERATORS, datetime.now(timezone.utc)):
                logs.append((TiledLog if kind == "tiled" else RfcLog)(http, url, desc))
            out: asyncio.Queue = asyncio.Queue(maxsize=1000)
            tasks = [asyncio.create_task(self._tail(lg, once, out)) for lg in logs]
            done = asyncio.gather(*tasks)
            try:
                while not (done.done() and out.empty()):
                    try:
                        yield await asyncio.wait_for(out.get(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
            finally:
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
