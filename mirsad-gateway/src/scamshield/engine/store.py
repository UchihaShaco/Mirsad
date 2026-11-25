"""SQLite persistence for verdicts, per-host state and events, plus in-process pub/sub for SSE."""

from __future__ import annotations

import asyncio
import fnmatch
import json
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import aiosqlite

from scamshield import config
from scamshield.schemas import Verdict

_SCHEMA = """
CREATE TABLE IF NOT EXISTS verdicts (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, decision TEXT, risk_score REAL,
    stage TEXT, final INTEGER, created_at REAL, updated_at REAL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_url ON verdicts(url, updated_at);
CREATE TABLE IF NOT EXISTS verdict_versions (id TEXT PRIMARY KEY, version TEXT);
CREATE INDEX IF NOT EXISTS verdicts_updated ON verdicts(updated_at);
CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, updated_at REAL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, type TEXT, verdict_id TEXT, host TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS host_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, at REAL, kind TEXT, old TEXT, new TEXT
);
CREATE INDEX IF NOT EXISTS host_changes_host ON host_changes(host, at);
CREATE TABLE IF NOT EXISTS visit_totals (host TEXT PRIMARY KEY, total INTEGER, first_seen REAL, last_seen REAL);
CREATE TABLE IF NOT EXISTS visits (host TEXT, hour INTEGER, count INTEGER, PRIMARY KEY (host, hour));
"""
VISIT_FLUSH_S = 5.0
HOUR = 3600


@dataclass
class HostRecord:
    """Current gateway decision for a host plus the fingerprints used for change detection."""

    host: str
    decision: str = "warn"
    risk_score: float = 50.0
    stage: str = "reputation"
    final: bool = False
    verdict_id: str = ""
    revoked: bool = False
    reviewed: str = ""  # outcome of the last review of this host's block, if any
    url: str = ""  # URL of the page the fingerprints below describe
    content_hash: Optional[str] = None
    structure_hash: Optional[str] = None
    ips: list[str] = field(default_factory=list)
    asn: Optional[int] = None
    nameservers: list[str] = field(default_factory=list)
    tls: Optional[str] = None
    page_verdict_id: str = ""  # last verdict whose page-level analysis can be reused
    registered_domain: str = ""
    allowlisted: bool = False
    owner: Optional[str] = None
    blocklisted: bool = False
    popularity_rank: Optional[int] = None
    domain_age_days: Optional[int] = None
    source: Optional[str] = None
    campaign_id: Optional[str] = None
    last_checked: Optional[float] = None
    last_changed: Optional[float] = None
    last_change_kind: Optional[str] = None
    changes: int = 0
    version: str = ""  # scoring-code version of the verdict behind `decision`
    updated_at: float = 0.0

    @property
    def reputation(self) -> str:
        if self.allowlisted:
            return "trusted"
        if self.decision == "block":
            return "blocked"
        if self.decision == "warn":
            return "suspicious"
        popular = self.popularity_rank is not None and self.popularity_rank <= 100_000
        old = self.domain_age_days is not None and self.domain_age_days >= 365
        return "established" if self.final and (popular or old) else "unknown"

    def gateway_view(self) -> dict[str, Any]:
        return {"decision": self.decision, "risk_score": self.risk_score, "stage": self.stage, "final": self.final,
                "verdict_id": self.verdict_id, "revoked": self.revoked, "reviewed": self.reviewed or None}


@dataclass
class Visits:
    total: int = 0
    first_seen: Optional[float] = None
    last_seen: Optional[float] = None
    hourly: dict[int, int] = field(default_factory=dict)  # hour (epoch // 3600) -> count, last 25 hours

    def add(self, now: float) -> None:
        self.total += 1
        self.first_seen = self.first_seen or now
        self.last_seen = now
        hour = int(now // HOUR)
        self.hourly[hour] = self.hourly.get(hour, 0) + 1
        for old in [h for h in self.hourly if h < hour - 24]:
            del self.hourly[old]

    def last_24h(self, now: float) -> list[int]:
        hour = int(now // HOUR)
        return [self.hourly.get(h, 0) for h in range(hour - 23, hour + 1)]


class EventBus:
    """Fan-out of events to live subscribers; a slow subscriber drops events instead of blocking."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    @asynccontextmanager
    async def subscribe(self, maxsize: int = 256) -> AsyncIterator[asyncio.Queue]:
        queue: asyncio.Queue = asyncio.Queue(maxsize)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)


def strip_html(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("page"):
        data["page"] = {**data["page"], "html": ""}
    return data


class Store:
    def __init__(self, path: Path | str | None = None, *, version: str = "") -> None:
        self.path = Path(path) if path else config.DB_PATH
        self.version = version  # scoring-code version; cached verdicts from other versions are not reused
        self.bus = EventBus()
        self._db: Optional[aiosqlite.Connection] = None
        self._hosts: dict[str, HostRecord] = {}
        self._visits: dict[str, Visits] = {}
        self._dirty_visits: set[str] = set()
        self._flusher: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def open(self) -> None:
        if self._db is not None:
            return
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self.path)
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA synchronous=NORMAL")
        await self._db.executescript(_SCHEMA)
        await self._db.commit()
        known = {f.name for f in fields(HostRecord)}
        async with self._db.execute("SELECT json FROM hosts") as cur:
            async for (raw,) in cur:
                record = HostRecord(**{k: v for k, v in json.loads(raw).items() if k in known})
                self._hosts[record.host] = record
        async with self._db.execute("SELECT host, total, first_seen, last_seen FROM visit_totals") as cur:
            async for host, total, first, last in cur:
                self._visits[host] = Visits(total, first, last)
        async with self._db.execute("SELECT host, hour, count FROM visits WHERE hour >= ?", (int(time.time() // HOUR) - 24,)) as cur:
            async for host, hour, count in cur:
                self._visits.setdefault(host, Visits()).hourly[hour] = count
        self._flusher = asyncio.create_task(self._flush_loop())

    async def close(self) -> None:
        if self._flusher is not None:
            self._flusher.cancel()
            await asyncio.gather(self._flusher, return_exceptions=True)
            self._flusher = None
        if self._db is not None:
            await self.flush_visits()
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("store is not open")
        return self._db

    async def save_verdict(self, verdict: Verdict) -> None:
        async with self._lock:
            await self.db.execute(
                "INSERT OR REPLACE INTO verdicts VALUES (?,?,?,?,?,?,?,?,?,?)",
                (verdict.id, verdict.url, verdict.host, verdict.decision.value, verdict.risk_score, verdict.stage.value,
                 int(verdict.final), verdict.created_at.timestamp(), verdict.updated_at.timestamp(),
                 verdict.model_dump_json()),
            )
            await self.db.execute("INSERT OR REPLACE INTO verdict_versions VALUES (?,?)", (verdict.id, self.version))
            await self.db.commit()

    async def is_current(self, verdict_id: str) -> bool:
        async with self.db.execute("SELECT version FROM verdict_versions WHERE id=?", (verdict_id,)) as cur:
            row = await cur.fetchone()
        return bool(row) and row[0] == self.version

    async def get_verdict(self, verdict_id: str) -> Optional[Verdict]:
        async with self.db.execute("SELECT json FROM verdicts WHERE id=?", (verdict_id,)) as cur:
            row = await cur.fetchone()
        return Verdict.model_validate_json(row[0]) if row else None

    async def latest_for_url(self, url: str, max_age_s: float) -> Optional[Verdict]:
        async with self.db.execute(
            "SELECT v.json FROM verdicts v JOIN verdict_versions s ON s.id = v.id"
            " WHERE v.url=? AND v.updated_at>=? AND s.version=? ORDER BY v.updated_at DESC LIMIT 1",
            (url, time.time() - max_age_s, self.version),
        ) as cur:
            row = await cur.fetchone()
        return Verdict.model_validate_json(row[0]) if row else None

    async def recent_verdicts(self, limit: int = 50) -> list[dict[str, Any]]:
        async with self.db.execute("SELECT json FROM verdicts ORDER BY updated_at DESC LIMIT ?", (limit,)) as cur:
            rows = await cur.fetchall()
        return [strip_html(json.loads(raw)) for (raw,) in rows]

    def is_stale(self, record: HostRecord) -> bool:
        """The host's current decision came from other scoring code: it is neither shown nor enforced as current.

        A host revoked by a deep crawl stays enforced until a deep re-check clears it."""
        return record.version != self.version and not record.revoked

    async def unreviewed_blocks(self, version: str, max_age_s: float = 86_400) -> list[tuple[str, str]]:
        """(verdict id, source) of recent blocks by this code version whose review never ran."""
        async with self.db.execute(
            "SELECT v.json FROM verdicts v JOIN verdict_versions s ON s.id = v.id"
            " WHERE v.decision = 'block' AND s.version = ? AND v.updated_at >= ?", (version, time.time() - max_age_s)) as cur:
            rows = await cur.fetchall()
        out = []
        for (raw,) in rows:
            data = json.loads(raw)
            if not data.get("review") and not any(r.get("code") == "rep.blocklisted" for r in data.get("reasons", [])):
                out.append((data["id"], data.get("source") or "user"))
        return out

    def stale_hosts(self) -> list[HostRecord]:
        """Stale hosts that real users reached (user / gateway checks or gateway lookups), most visited first."""
        stale = [r for r in self._hosts.values() if (self.is_stale(r) or (r.revoked and r.version != self.version))
                 and (r.source in ("user", "gateway") or self.visits(r.host).total)]
        return sorted(stale, key=lambda r: -self.visits(r.host).total)

    async def reset(self, pattern: Optional[str] = None) -> int:
        """Delete stored verdicts, host rows, change logs and visit counts (all, or hosts matching a glob)."""
        hosts = [h for h in set(self._hosts) | set(self._visits) if pattern is None or fnmatch.fnmatch(h, pattern)]
        async with self._lock:
            if pattern is None:
                for table in ("verdicts", "verdict_versions", "hosts", "host_changes", "visits", "visit_totals", "events"):
                    await self.db.execute(f"DELETE FROM {table}")
            else:
                for host in hosts:
                    await self.db.execute("DELETE FROM verdict_versions WHERE id IN (SELECT id FROM verdicts WHERE host=?)", (host,))
                    for table in ("verdicts", "hosts", "host_changes", "visits", "visit_totals"):
                        await self.db.execute(f"DELETE FROM {table} WHERE host=?", (host,))
            await self.db.commit()
        for host in hosts:
            self._hosts.pop(host, None)
            self._visits.pop(host, None)
            self._dirty_visits.discard(host)
        return len(hosts)

    def host(self, host: str) -> Optional[HostRecord]:
        """Memory-only lookup (the gateway calls this per connection)."""
        return self._hosts.get(host)

    async def save_host(self, record: HostRecord) -> None:
        record.updated_at = time.time()
        self._hosts[record.host] = record
        async with self._lock:
            await self.db.execute("INSERT OR REPLACE INTO hosts VALUES (?,?,?)",
                                  (record.host, record.updated_at, json.dumps(asdict(record), default=str)))
            await self.db.commit()

    # Traffic volume: counted in memory per gateway lookup, flushed to SQLite every few seconds.

    def record_visit(self, host: str) -> None:
        self._visits.setdefault(host, Visits()).add(time.time())
        self._dirty_visits.add(host)

    def visits(self, host: str) -> Visits:
        return self._visits.get(host, Visits())

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(VISIT_FLUSH_S)
            await self.flush_visits()

    async def flush_visits(self) -> None:
        dirty, self._dirty_visits = self._dirty_visits, set()
        if not dirty:
            return
        async with self._lock:
            for host in dirty:
                v = self._visits[host]
                await self.db.execute("INSERT OR REPLACE INTO visit_totals VALUES (?,?,?,?)", (host, v.total, v.first_seen, v.last_seen))
                await self.db.executemany("INSERT OR REPLACE INTO visits VALUES (?,?,?)", [(host, h, c) for h, c in v.hourly.items()])
            await self.db.commit()
        now = time.time()
        for host in dirty:
            v = self._visits[host]
            self.bus.publish({"type": "host.updated", "ts": now, "host": host, "visits": v.total,
                              "visits_24h": sum(v.last_24h(now)), "last_seen": v.last_seen})

    # Reputation table -------------------------------------------------------------------------------

    async def record_changes(self, record: HostRecord, changes: list[tuple[str, Any, Any]]) -> None:
        """Append `(kind, old, new)` rows to the host's change log and update its summary columns."""
        if not changes:
            return
        now = time.time()
        async with self._lock:
            await self.db.executemany(
                "INSERT INTO host_changes (host, at, kind, old, new) VALUES (?,?,?,?,?)",
                [(record.host, now, kind, json.dumps(old, default=str), json.dumps(new, default=str)) for kind, old, new in changes])
            await self.db.commit()
        record.last_changed, record.last_change_kind = now, changes[-1][0]
        record.changes += len(changes)

    async def host_changes(self, host: str, limit: int = 100) -> list[dict[str, Any]]:
        async with self.db.execute("SELECT at, kind, old, new FROM host_changes WHERE host=? ORDER BY id DESC LIMIT ?", (host, limit)) as cur:
            rows = await cur.fetchall()
        return [{"at": at, "kind": kind, "old": json.loads(old), "new": json.loads(new)} for at, kind, old, new in rows]

    def host_row(self, host: str) -> dict[str, Any]:
        record = self._hosts.get(host)
        visits = self.visits(host)
        now = time.time()
        row: dict[str, Any] = {
            "host": host, "registered_domain": None, "decision": None, "risk_score": None, "stage": None,
            "reputation": "unknown", "allowlisted": None, "owner": None, "blocklisted": None, "popularity_rank": None,
            "domain_age_days": None, "visits": visits.total, "visits_24h": sum(visits.last_24h(now)),
            "first_seen": visits.first_seen, "last_seen": visits.last_seen, "last_checked": None, "last_changed": None,
            "last_change_kind": None, "changes": 0, "verdict_id": None, "source": None, "campaign_id": None,
            "stale": False,
        }
        if record:
            row.update({k: getattr(record, k) for k in (
                "decision", "risk_score", "stage", "allowlisted", "owner", "blocklisted", "popularity_rank", "domain_age_days",
                "last_checked", "last_changed", "last_change_kind", "changes", "source", "campaign_id")})
            row.update(registered_domain=record.registered_domain or None, reputation=record.reputation,
                       verdict_id=record.verdict_id or None, stale=self.is_stale(record))
            row["first_seen"] = min(x for x in (visits.first_seen, record.last_checked) if x is not None) if (visits.first_seen or record.last_checked) else None
        return row

    def host_rows(self, *, q: str = "", sort: str = "last_seen", limit: int = 100) -> list[dict[str, Any]]:
        hosts = (set(self._hosts) | set(self._visits))
        rows = [self.host_row(h) for h in hosts if q.lower() in h]
        key = {"visits": "visits", "risk": "risk_score", "last_seen": "last_seen", "last_changed": "last_changed"}[sort]
        rows.sort(key=lambda r: (r[key] is not None, r[key] or 0), reverse=True)
        return rows[:limit]

    async def host_verdicts(self, host: str, limit: int = 20) -> list[dict[str, Any]]:
        async with self.db.execute(
            "SELECT id, url, decision, risk_score, stage, updated_at FROM verdicts WHERE host=? ORDER BY updated_at DESC LIMIT ?",
            (host, limit)) as cur:
            rows = await cur.fetchall()
        return [{"id": i, "url": u, "decision": d, "risk_score": r, "stage": st, "updated_at": t} for i, u, d, r, st, t in rows]

    async def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        event = {"type": event_type, "ts": time.time(), **payload}
        self.bus.publish(event)
        async with self._lock:
            await self.db.execute("INSERT INTO events (ts, type, verdict_id, host, payload) VALUES (?,?,?,?,?)",
                                  (event["ts"], event_type, payload.get("verdict_id"), payload.get("host"),
                                   json.dumps(payload, default=str)))
            await self.db.commit()

    async def recent_events(self, limit: int = 100) -> list[dict[str, Any]]:
        async with self.db.execute("SELECT ts, type, payload FROM events ORDER BY id DESC LIMIT ?", (limit,)) as cur:
            rows = await cur.fetchall()
        return [{"type": t, "ts": ts, **json.loads(p)} for ts, t, p in rows]
