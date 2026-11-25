"""SQLite state for the watcher (`data/watch.db`): candidate queue, verdict timeline, source cursors."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from scamshield.schemas import utcnow
from scamshield.watch import settings
from scamshield.watch.base import Candidate
from scamshield.watch.match import registered_domain

SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates (
    host TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    registered_domain TEXT,
    source TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    brand_hint TEXT,
    technique TEXT,
    score REAL,
    evidence TEXT NOT NULL DEFAULT '{}',
    first_seen TEXT NOT NULL,        -- earliest public sign: certificate issued / domain registered
    detected_at TEXT NOT NULL,       -- when the watcher queued it
    status TEXT NOT NULL DEFAULT 'queued',  -- queued | pending | done | skipped
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    submitted_at TEXT,
    verdict_at TEXT,                 -- when the engine's (latest) verdict came back
    verdict_id TEXT,
    decision TEXT,
    risk_score REAL,
    stage TEXT,
    final INTEGER,
    campaign_id TEXT,
    listed_at_detection INTEGER,     -- on a local blocklist when we detected it
    listed_at_verdict INTEGER,
    listed_first_at TEXT,            -- first time a later blocklist recheck found it listed
    blocklist_sources TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS candidates_due ON candidates(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sweep (
    domain TEXT PRIMARY KEY,
    brand TEXT,
    checked_at TEXT NOT NULL,
    resolved INTEGER NOT NULL,
    ips TEXT NOT NULL DEFAULT '[]'
);
"""


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _reputation(host: str) -> tuple[bool, list[str]] | None:
    """(blocklisted, sources) from the intel component's local lists, or None when unavailable."""
    try:
        from scamshield.intel.reputation import reputation

        _allow, _owner, listed, sources = reputation(host)
        return bool(listed), list(sources or [])
    except Exception:  # intel absent or failing must never stop the watcher
        return None


def _allowlisted(host: str) -> bool:
    try:
        from scamshield.intel.reputation import reputation

        return bool(reputation(host)[0])
    except Exception:
        return False


class Store:
    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or settings.WATCH_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=DELETE")  # shared with root-owned container processes
        try:
            yield db
            db.commit()
        finally:
            db.close()

    # Candidates

    def add(self, c: Candidate) -> bool:
        """Queue a candidate. Returns True if the host is new; a repeat only records the extra source."""
        now = iso(utcnow())
        with self.connect() as db:
            row = db.execute("SELECT sources, first_seen FROM candidates WHERE host=?", (c.host,)).fetchone()
            if row:
                sources = sorted(set(json.loads(row["sources"])) | {c.source})
                first = min(row["first_seen"], iso(c.first_seen))
                db.execute("UPDATE candidates SET sources=?, first_seen=? WHERE host=?", (json.dumps(sources), first, c.host))
                return False
            status = "skipped" if _allowlisted(c.host) else "queued"
            rep = _reputation(c.host)
            db.execute(
                """INSERT INTO candidates (host, url, registered_domain, source, sources, brand_hint, technique, score,
                   evidence, first_seen, detected_at, status, next_attempt_at, listed_at_detection, blocklist_sources)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (c.host, c.url, registered_domain(c.host), c.source, json.dumps([c.source]), c.brand_hint, c.technique,
                 c.score, json.dumps(c.evidence, default=str), iso(c.first_seen), now, status, now,
                 None if rep is None else int(rep[0]), json.dumps(rep[1] if rep else [])),
            )
            return True

    def due(self, limit: int = 20) -> list[sqlite3.Row]:
        with self.connect() as db:
            return db.execute(
                """SELECT * FROM candidates WHERE status IN ('queued','pending') AND next_attempt_at <= ?
                   ORDER BY status='pending', score DESC, detected_at LIMIT ?""",
                (iso(utcnow()), limit),
            ).fetchall()

    def retry_later(self, host: str, error: str) -> None:
        with self.connect() as db:
            attempts = db.execute("SELECT attempts FROM candidates WHERE host=?", (host,)).fetchone()["attempts"] + 1
            delay = min(30 * 2 ** min(attempts, 7), 3600)
            db.execute("UPDATE candidates SET attempts=?, last_error=?, next_attempt_at=? WHERE host=?",
                       (attempts, error[:500], iso(utcnow() + timedelta(seconds=delay)), host))

    def record_verdict(self, host: str, verdict: dict, *, recheck_in_s: float = 60.0) -> None:
        """Store the engine's verdict. Non-final verdicts are polled again until the deep layer completes."""
        now = utcnow()
        final = bool(verdict.get("final"))
        rep = _reputation(host)
        with self.connect() as db:
            db.execute(
                """UPDATE candidates SET status=?, submitted_at=COALESCE(submitted_at, ?), verdict_at=?, verdict_id=?,
                   decision=?, risk_score=?, stage=?, final=?, campaign_id=COALESCE(?, campaign_id), last_error=NULL,
                   next_attempt_at=?, listed_at_verdict=?, blocklist_sources=COALESCE(?, blocklist_sources) WHERE host=?""",
                ("done" if final else "pending", iso(now), iso(now), verdict.get("id"), verdict.get("decision"),
                 verdict.get("risk_score"), verdict.get("stage"), int(final), verdict.get("campaign_id"),
                 iso(now + timedelta(seconds=recheck_in_s)), None if rep is None else int(rep[0]),
                 json.dumps(rep[1]) if rep else None, host),
            )

    def set_campaign(self, host: str, campaign_id: str | None) -> None:
        with self.connect() as db:
            db.execute("UPDATE candidates SET campaign_id=? WHERE host=?", (campaign_id, host))

    def recheck_blocklists(self) -> int:
        """Look up flagged candidates in the local blocklists again; record when each first became listed."""
        newly = 0
        with self.connect() as db:
            rows = db.execute("""SELECT host FROM candidates WHERE listed_first_at IS NULL
                                 AND decision IN ('warn','block')""").fetchall()
            for r in rows:
                rep = _reputation(r["host"])
                if rep and rep[0]:
                    newly += 1
                    db.execute("UPDATE candidates SET listed_first_at=?, blocklist_sources=? WHERE host=?",
                               (iso(utcnow()), json.dumps(rep[1]), r["host"]))
        return newly

    def rows(self, where: str = "1=1", params: tuple = ()) -> list[sqlite3.Row]:
        with self.connect() as db:
            return db.execute(f"SELECT * FROM candidates WHERE {where} ORDER BY detected_at DESC", params).fetchall()

    def stats(self) -> dict:
        """Counts per source / status and the lead-time figures for the dashboard."""
        rows = self.rows()
        by_source: dict[str, int] = {}
        by_status: dict[str, int] = {}
        detect_lag, verdict_lag, ahead = [], [], []
        lag_by_source: dict[str, list[float]] = {}
        flagged = 0
        for r in rows:
            by_source[r["source"]] = by_source.get(r["source"], 0) + 1
            by_status[r["status"]] = by_status.get(r["status"], 0) + 1
            first, detected, verdict_at = parse_iso(r["first_seen"]), parse_iso(r["detected_at"]), parse_iso(r["verdict_at"])
            detect_lag.append((detected - first).total_seconds() / 3600)
            lag_by_source.setdefault(r["source"], []).append(detect_lag[-1])
            if r["decision"] in ("warn", "block"):
                flagged += 1
                if verdict_at:
                    verdict_lag.append((verdict_at - first).total_seconds() / 3600)
                if r["listed_at_verdict"] == 0:
                    listed = parse_iso(r["listed_first_at"])
                    ahead.append({"host": r["host"], "lead_hours": round((listed - detected).total_seconds() / 3600, 1)
                                  if listed else None})

        def median(xs: list[float]) -> float | None:
            xs = sorted(xs)
            return round(xs[len(xs) // 2], 1) if xs else None

        return {
            "candidates": len(rows),
            "by_source": by_source,
            "by_status": by_status,
            "flagged": flagged,
            "median_hours_first_seen_to_detection": median(detect_lag),
            "median_hours_first_seen_to_detection_by_source": {k: median(v) for k, v in lag_by_source.items()},
            "median_hours_first_seen_to_verdict": median(verdict_lag),
            "flagged_before_any_blocklist": len(ahead),
            "later_listed_with_lead_time": [a for a in ahead if a["lead_hours"] is not None],
        }

    # Source cursors and sweep progress

    def get_state(self, key: str, default=None):
        with self.connect() as db:
            row = db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_state(self, key: str, value) -> None:
        with self.connect() as db:
            db.execute("INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, json.dumps(value)))

    def swept_recently(self, domains: list[str], max_age_s: float) -> set[str]:
        cutoff = iso(utcnow() - timedelta(seconds=max_age_s))
        out: set[str] = set()
        with self.connect() as db:
            for i in range(0, len(domains), 500):
                chunk = domains[i:i + 500]
                q = f"SELECT domain FROM sweep WHERE checked_at >= ? AND domain IN ({','.join('?' * len(chunk))})"
                out.update(r["domain"] for r in db.execute(q, (cutoff, *chunk)))
        return out

    def record_sweep(self, results: list[tuple[str, str, bool, list[str]]]) -> None:
        now = iso(utcnow())
        with self.connect() as db:
            db.executemany(
                """INSERT INTO sweep(domain, brand, checked_at, resolved, ips) VALUES (?,?,?,?,?)
                   ON CONFLICT(domain) DO UPDATE SET checked_at=excluded.checked_at, resolved=excluded.resolved,
                   ips=excluded.ips""",
                [(d, b, now, int(ok), json.dumps(ips)) for d, b, ok, ips in results],
            )
