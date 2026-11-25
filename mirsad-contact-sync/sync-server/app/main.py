"""Mirsad contact sync server (internal working name: ScamShield sync).

Single source of truth for "which phone numbers are flagged as scammers".

* The Mirsad portal / demo dashboard WRITE here (admin token).
* Android devices READ here (device token) - either by polling
  GET /api/v1/snapshot or, preferably, by holding open the WebSocket
  /api/v1/ws which pushes a full snapshot every time anything changes.

Storage is a single SQLite file so it can live on the same box / container
as the bot with zero extra infrastructure.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import phonenumbers
from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

log = logging.getLogger("scamshield")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DB_PATH = Path(os.environ.get("SCAMSHIELD_DB", "/data/scamshield.db"))
ADMIN_TOKEN = os.environ.get("SCAMSHIELD_ADMIN_TOKEN", "")
DEVICE_TOKEN = os.environ.get("SCAMSHIELD_DEVICE_TOKEN", "")
# ISO region used to interpret numbers written without a +country prefix (e.g. "SG", "IN", "US").
DEFAULT_REGION = os.environ.get("SCAMSHIELD_DEFAULT_REGION") or None
# Name shown on the phone. Devices pick this up from every snapshot.
CONTACT_NAME = os.environ.get("SCAMSHIELD_CONTACT_NAME", "⚠️ Known Scammer")
STATIC_DIR = Path(__file__).parent / "static"

# Demo mode: with no admin token set, the dashboard + write API are open to whoever has the URL,
# and (since the list is then public anyway) devices don't need a token either.
OPEN_MODE = not ADMIN_TOKEN


# --------------------------------------------------------------------------- db

def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS scammers (
            phone      TEXT PRIMARY KEY,          -- E.164, e.g. +6591234567
            active     INTEGER NOT NULL DEFAULT 1, -- 1 = pushed to phones, 0 = kept but not pushed
            label      TEXT,                      -- free text, e.g. telegram username
            note       TEXT,
            source     TEXT,                      -- 'telegram-bot', 'web', 'dashboard', ...
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        INSERT OR IGNORE INTO meta (k, v) VALUES ('version', '0');
        """
    )
    return conn


db = _connect()
db_lock = asyncio.Lock()


def _bump_version() -> int:
    db.execute("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'version'")
    return int(db.execute("SELECT v FROM meta WHERE k = 'version'").fetchone()[0])


def _version() -> int:
    return int(db.execute("SELECT v FROM meta WHERE k = 'version'").fetchone()[0])


def _snapshot() -> dict:
    rows = db.execute("SELECT phone FROM scammers WHERE active = 1 ORDER BY created_at, phone").fetchall()
    return {
        "type": "snapshot",
        "version": _version(),
        "contact_name": CONTACT_NAME,
        "numbers": [r["phone"] for r in rows],
    }


def normalize(raw: str) -> str:
    """Return E.164 or raise 422. Accepts '+65 9123 4567', '0065-91234567', '91234567' (with DEFAULT_REGION)."""
    s = (raw or "").strip()
    if s.startswith("00"):
        s = "+" + s[2:]
    try:
        num = phonenumbers.parse(s, None if s.startswith("+") else DEFAULT_REGION)
    except phonenumbers.NumberParseException as e:
        raise HTTPException(422, f"Cannot parse phone number {raw!r}: {e}. "
                                 "Use +<country code> format or set SCAMSHIELD_DEFAULT_REGION.")
    if not phonenumbers.is_possible_number(num):
        raise HTTPException(422, f"Not a possible phone number: {raw!r}")
    return phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164)


# ---------------------------------------------------------------- live clients

class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.dashboards: set[WebSocket] = set()   # subset of clients that are browser dashboards

    @property
    def phones(self) -> int:
        return len(self.clients - self.dashboards)

    async def broadcast(self, payload: dict) -> None:
        msg = json.dumps(payload)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)
            self.dashboards.discard(ws)


hub = Hub()


async def _changed() -> int:
    """Call after any write (inside db_lock). Bumps version + pushes to every device."""
    v = _bump_version()
    await hub.broadcast(_snapshot())
    return v


# ------------------------------------------------------------------------ auth

def _ok(token: Optional[str], allowed: tuple[str, ...]) -> bool:
    if OPEN_MODE:
        return True
    # compare_digest rejects non-ASCII str, so compare bytes: a stray character must give 401, not a 500.
    return bool(token) and any(a and secrets.compare_digest(token.encode(), a.encode()) for a in allowed)


def _check(token: Optional[str], allowed: tuple[str, ...]) -> None:
    if not _ok(token, allowed):
        raise HTTPException(401, "bad or missing token")


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def require_admin(authorization: Optional[str] = Header(None)) -> None:
    _check(_bearer(authorization), (ADMIN_TOKEN,))


def require_device(authorization: Optional[str] = Header(None)) -> None:
    _check(_bearer(authorization), (DEVICE_TOKEN, ADMIN_TOKEN))


# ------------------------------------------------------------------------- api

@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("DB %s, version %s, default region %s, %s", DB_PATH, _version(), DEFAULT_REGION,
             "OPEN MODE (no admin token)" if OPEN_MODE else "admin token required")
    yield


app = FastAPI(title="Mirsad contact sync", lifespan=lifespan)


class ScammerIn(BaseModel):
    phone: str
    active: bool = True
    label: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = None


class ScammerPatch(BaseModel):
    active: Optional[bool] = None
    label: Optional[str] = None
    note: Optional[str] = None


class BulkIn(BaseModel):
    """Replace-or-merge many at once (useful for the bot's initial import)."""
    phones: list[str] = Field(default_factory=list)
    source: Optional[str] = None


def _row(phone: str) -> dict:
    r = db.execute("SELECT * FROM scammers WHERE phone = ?", (phone,)).fetchone()
    if not r:
        raise HTTPException(404, "not found")
    return dict(r)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "version": _version(), "devices_connected": hub.phones}


@app.get("/api/v1/snapshot", dependencies=[Depends(require_device)])
async def snapshot():
    """What a phone needs: the active numbers. Polling fallback for the WebSocket."""
    return _snapshot()


@app.get("/api/v1/scammers", dependencies=[Depends(require_admin)])
async def list_scammers():
    rows = db.execute("SELECT * FROM scammers ORDER BY created_at DESC").fetchall()
    return {"version": _version(), "devices_connected": hub.phones, "scammers": [dict(r) for r in rows]}


@app.post("/api/v1/scammers", dependencies=[Depends(require_admin)])
async def upsert_scammer(body: ScammerIn):
    phone = normalize(body.phone)
    now = time.time()
    async with db_lock:
        db.execute(
            """INSERT INTO scammers (phone, active, label, note, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(phone) DO UPDATE SET
                 active = excluded.active,
                 label = COALESCE(excluded.label, scammers.label),
                 note = COALESCE(excluded.note, scammers.note),
                 source = COALESCE(excluded.source, scammers.source),
                 updated_at = excluded.updated_at""",
            (phone, int(body.active), body.label, body.note, body.source, now, now),
        )
        await _changed()
        return _row(phone)


@app.post("/api/v1/scammers/bulk", dependencies=[Depends(require_admin)])
async def bulk_add(body: BulkIn):
    phones = sorted({normalize(p) for p in body.phones})
    now = time.time()
    async with db_lock:
        for p in phones:
            db.execute(
                """INSERT INTO scammers (phone, active, source, created_at, updated_at) VALUES (?, 1, ?, ?, ?)
                   ON CONFLICT(phone) DO UPDATE SET active = 1, updated_at = excluded.updated_at""",
                (p, body.source, now, now),
            )
        v = await _changed()
    return {"added_or_activated": len(phones), "version": v}


@app.patch("/api/v1/scammers/{phone}", dependencies=[Depends(require_admin)])
async def patch_scammer(phone: str, body: ScammerPatch):
    phone = normalize(phone)
    async with db_lock:
        _row(phone)
        sets, args = [], []
        for col in ("active", "label", "note"):
            val = getattr(body, col)
            if val is not None:
                sets.append(f"{col} = ?")
                args.append(int(val) if col == "active" else val)
        sets.append("updated_at = ?")
        args.append(time.time())
        db.execute(f"UPDATE scammers SET {', '.join(sets)} WHERE phone = ?", (*args, phone))
        await _changed()
        return _row(phone)


@app.post("/api/v1/scammers/{phone}/toggle", dependencies=[Depends(require_admin)])
async def toggle_scammer(phone: str):
    """Flip active on/off. Unknown numbers are created as active (handy for a dashboard switch)."""
    phone = normalize(phone)
    async with db_lock:
        r = db.execute("SELECT active FROM scammers WHERE phone = ?", (phone,)).fetchone()
        now = time.time()
        if r is None:
            db.execute("INSERT INTO scammers (phone, active, source, created_at, updated_at) VALUES (?, 1, 'toggle', ?, ?)",
                       (phone, now, now))
        else:
            db.execute("UPDATE scammers SET active = ?, updated_at = ? WHERE phone = ?", (0 if r["active"] else 1, now, phone))
        await _changed()
        return _row(phone)


@app.delete("/api/v1/scammers/{phone}", dependencies=[Depends(require_admin)])
async def delete_scammer(phone: str):
    phone = normalize(phone)
    async with db_lock:
        cur = db.execute("DELETE FROM scammers WHERE phone = ?", (phone,))
        if cur.rowcount == 0:
            raise HTTPException(404, "not found")
        v = await _changed()
    return {"deleted": phone, "version": v}


@app.websocket("/api/v1/ws")
async def ws_endpoint(ws: WebSocket, token: Optional[str] = Query(None), role: Optional[str] = Query(None),
                      authorization: Optional[str] = Header(None)):
    if not _ok(token or _bearer(authorization), (DEVICE_TOKEN, ADMIN_TOKEN)):
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.clients.add(ws)
    if role == "dashboard":
        hub.dashboards.add(ws)
    else:
        log.info("device connected (%d phones online)", hub.phones)
    try:
        await ws.send_text(json.dumps(_snapshot()))
        while True:
            # Clients may send {"type":"hello", ...} or pings; we just keep the socket drained.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)
        if ws in hub.dashboards:
            hub.dashboards.discard(ws)
        else:
            log.info("device disconnected (%d phones online)", hub.phones)


# -------------------------------------------------------------- demo dashboard

@app.get("/")
async def root():
    return RedirectResponse("/dashboard")


@app.get("/dashboard")
async def dashboard():
    return FileResponse(STATIC_DIR / "dashboard.html")
