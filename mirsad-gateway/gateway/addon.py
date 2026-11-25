"""Mirsad (مرصاد) website shield addon for mitmproxy.

One instance serves every listener the gateway starts (transparent proxy for the tailnet, explicit
proxy for the no-phone simulation, DNS resolver hook), so they all share one decision cache.

Hostname mode (default): a TLS connection is held at its ClientHello until the engine has decided
on the server name, then passed through untouched (allow) or closed (block).
Intercept mode (SCAMSHIELD_INTERCEPT=1, the phone trusts our CA): full URLs are visible, so unknown
sites get a "checking" page, blocked sites a block page and risky sites a warning interstitial.
Plain HTTP is always handled like intercept mode because its requests are readable anyway.
"""

import asyncio
import contextlib
import html
import ipaddress
import json
import logging
import os
import re
import socket
import struct
import time
from collections import deque
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from mitmproxy import connection, ctx, dns, http, tls

log = logging.getLogger("scamshield.gateway")
logging.getLogger("httpx").setLevel(logging.WARNING)
# Per-connection "client connect" lines would drown the decision log on a busy phone.
logging.getLogger("mitmproxy.proxy.server").setLevel(logging.WARNING)

ALLOW, WARN, BLOCK, PENDING = "allow", "warn", "block", "pending"
INTERNAL_PREFIX = "/.well-known/scamshield/"
# mitm.it is answered with this address so a phone can fetch our CA through the tunnel.
ONBOARDING_IP = ipaddress.IPv4Address("198.18.0.80")
# The phone's own status page (plain HTTP) lives at this address; any port-80 traffic reaches the proxy.
STATUS_IP = ipaddress.IPv4Address("198.18.0.81")
MAX_CHECK_URL = 4096  # the engine refuses longer URLs (HTTP 422)
VISIT_WINDOW_S = 30.0  # one counted visit per host and window, however many connections or polls
HERE = Path(__file__).resolve().parent


def _env_bool(name: str, default: bool) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


def _load_patterns(path: Path, extra: str) -> tuple[str, ...]:
    lines = path.read_text().splitlines() if path.exists() else []
    lines += extra.split(",")
    patterns = (line.split("#", 1)[0].strip().lower().removeprefix("*.").rstrip(".") for line in lines)
    return tuple(sorted({p for p in patterns if p}))


@dataclass(frozen=True)
class Settings:
    engine_url: str
    hold_s: float
    page_grace_s: float
    intercept: bool
    cache_ttl_s: float
    block_ttl_s: float
    on_timeout: str
    warn_over_tls: str
    dns_prefetch: bool
    proceed_ttl_s: float
    passthrough: tuple[str, ...]
    pages_dir: Path
    status_host: str

    @classmethod
    def from_env(cls) -> "Settings":
        engine_url = os.environ.get("SCAMSHIELD_ENGINE_URL", "http://engine:8000").rstrip("/")
        engine_host = (urlsplit(engine_url).hostname or "").lower()
        passthrough_file = Path(os.environ.get("SCAMSHIELD_PASSTHROUGH_FILE", HERE / "passthrough.txt"))
        status_host = os.environ.get("SCAMSHIELD_STATUS_HOST", "shield.test").lower()
        extra = ",".join([os.environ.get("SCAMSHIELD_PASSTHROUGH", ""), engine_host, status_host])
        return cls(
            engine_url=engine_url,
            hold_s=float(os.environ.get("SCAMSHIELD_HOLD_S", "8")),
            page_grace_s=float(os.environ.get("SCAMSHIELD_PAGE_GRACE_S", "1")),
            intercept=_env_bool("SCAMSHIELD_INTERCEPT", False),
            cache_ttl_s=float(os.environ.get("SCAMSHIELD_CACHE_TTL", "10")),
            block_ttl_s=float(os.environ.get("SCAMSHIELD_BLOCK_CACHE_TTL", "5")),
            on_timeout=BLOCK if os.environ.get("SCAMSHIELD_ON_TIMEOUT", BLOCK) == BLOCK else ALLOW,
            warn_over_tls=BLOCK if os.environ.get("SCAMSHIELD_WARN_OVER_TLS", ALLOW) == BLOCK else ALLOW,
            dns_prefetch=_env_bool("SCAMSHIELD_DNS_PREFETCH", True),
            proceed_ttl_s=float(os.environ.get("SCAMSHIELD_PROCEED_TTL", "1800")),
            passthrough=_load_patterns(passthrough_file, extra),
            pages_dir=Path(os.environ.get("SCAMSHIELD_PAGES", HERE / "pages")),
            status_host=status_host,
        )


@dataclass
class Entry:
    """The gateway's current decision for one hostname."""

    state: str
    source: str
    risk: float | None = None
    verdict_id: str | None = None
    review_pending: bool = False
    summary_en: str = ""
    summary_ar: str = ""
    reasons: list[dict] = field(default_factory=list)
    brand_en: str = ""
    brand_ar: str = ""
    evidence_ref: str | None = None
    expires: float = 0.0

    def add_details(self, verdict: dict) -> None:
        """Fill reasons, summaries, brand and case reference from a full engine verdict."""
        self.reasons = top_reasons(verdict.get("reasons") or []) or self.reasons
        self.summary_en = verdict.get("summary_en") or self.summary_en
        self.summary_ar = verdict.get("summary_ar") or self.summary_ar
        brand = verdict.get("brand") or {}
        self.brand_en = brand.get("brand") or self.brand_en
        self.brand_ar = brand.get("brand_ar") or self.brand_ar
        self.evidence_ref = verdict.get("evidence_ref") or self.evidence_ref


def entry_from_engine(data: dict, source: str) -> tuple[Entry, bool]:
    """Map an engine verdict or host record to an Entry; the flag says whether it is safe to act on.

    A block is acted on at any stage, an allow only once the first page was analysed or when it came
    from reputation (allowlist / cached verdict); earlier allows are partial estimates.
    """
    decision = data.get("decision")
    stage = data.get("stage")
    final = bool(data.get("final"))
    state = decision if decision in (ALLOW, WARN, BLOCK) else WARN
    conclusive = state == BLOCK or final or stage in ("page", "deep") or (stage == "reputation" and state == ALLOW)
    entry = Entry(
        state=state,
        source=source,
        risk=data.get("risk_score"),
        verdict_id=data.get("verdict_id") or data.get("id"),
        review_pending=state == BLOCK and not (data.get("review") or data.get("reviewed")),
    )
    entry.add_details(data)
    return entry, conclusive


def top_reasons(reasons: list[dict], limit: int = 3) -> list[dict]:
    ranked = sorted((r for r in reasons if (r.get("points") or 0) > 0), key=lambda r: -(r.get("points") or 0))
    return ranked[:limit]


def hostname_of(url: str | None) -> str:
    return (urlsplit(url).hostname or "").lower() if url else ""


def bounded_url(url: str) -> str:
    """The URL the engine accepts: over the limit, keep scheme, host and as much of the path as fits."""
    if len(url) <= MAX_CHECK_URL:
        return url
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    return origin + (parts.path or "/")[: MAX_CHECK_URL - len(origin)]


# A run of left-to-right text (a host, an English word, a number), optionally in quotes or brackets.
_LTR_RUN = re.compile(r"[\"'“‘«(\[]?[A-Za-z0-9][A-Za-z0-9._:/@%&=?+#~-]*[\"'”’»)\]]?")


def isolate_ltr(text: str) -> str:
    """Wrap each left-to-right run of an Arabic string in Unicode isolates (FSI ... PDI), so words such as
    "fines", "payment" or a host name keep their order and their punctuation inside right-to-left text.
    Hyphens inside a run become non-breaking, so a host name never wraps in the middle."""
    if not text:
        return text

    def wrap(match: re.Match) -> str:
        run, before, after = match.group(0), "", ""
        if run[0] in "([" and run[-1] not in ")]":
            before, run = run[0], run[1:]  # a bracket that opens Arabic text stays with the Arabic text
        elif run[-1] in ")]" and run[0] not in "([":
            run, after = run[:-1], run[-1]
        return before + "\u2068" + run.replace("-", "\u2011") + "\u2069" + after

    return _LTR_RUN.sub(wrap, text)


class Engine:
    """Client for the investigation engine HTTP API."""

    def __init__(self, base_url: str) -> None:
        self.http = httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(5.0, connect=2.0), trust_env=False)

    async def host(self, host: str, *, visit: bool = False) -> dict | None:
        """The host's current decision. visit=False asks the engine not to count this lookup as traffic
        (the gateway polls while it holds a connection); real visits are reported once per window."""
        r = await self.http.get(f"/v1/host/{quote(host, safe='')}", params=None if visit else {"visit": "0"})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def check(self, url: str, wait_s: float) -> dict:
        body = {"url": bounded_url(url), "depth": "page", "wait_ms": int(wait_s * 1000), "source": "gateway"}
        r = await self.http.post("/v1/check", json=body, timeout=httpx.Timeout(wait_s + 0.25, connect=2.0))
        r.raise_for_status()
        return r.json()

    async def verdict(self, verdict_id: str) -> dict:
        r = await self.http.get(f"/v1/verdicts/{quote(verdict_id, safe='')}", timeout=1.5)
        r.raise_for_status()
        return r.json()

    async def events(self) -> AsyncIterator[tuple[str, dict]]:
        """Follow the engine's server-sent events stream."""
        timeout = httpx.Timeout(None, connect=3.0)
        async with self.http.stream("GET", "/v1/events", timeout=timeout) as r:
            r.raise_for_status()
            name, data_lines = "message", []
            async for line in r.aiter_lines():
                if line.startswith("event:"):
                    name = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                elif not line and data_lines:
                    try:
                        data = json.loads("\n".join(data_lines))
                    except ValueError:
                        data = None
                    if isinstance(data, dict):
                        if name == "message":
                            name = data.get("type") or data.get("event") or name
                        yield name, data
                    name, data_lines = "message", []

    async def aclose(self) -> None:
        await self.http.aclose()


class Gate:
    """Decision cache in front of the engine, with in-flight de-duplication and revocation."""

    def __init__(self, settings: Settings, engine: Engine) -> None:
        self.s = settings
        self.engine = engine
        self.cache: dict[str, Entry] = {}
        self.tasks: dict[str, asyncio.Task[Entry]] = {}
        self.overrides: dict[tuple[str, str], float] = {}
        self.conns: dict[str, set[str]] = {}
        self.client_hosts: dict[str, set[str]] = {}
        self.last_visit: dict[str, float] = {}
        self.visit_tasks: set[asyncio.Task] = set()

    def note_visit(self, host: str) -> None:
        """Report one visit per host and window to the engine's traffic counts (a check counts as one)."""
        now = time.monotonic()
        if now - self.last_visit.get(host, -VISIT_WINDOW_S) < VISIT_WINDOW_S:
            return
        self.last_visit[host] = now
        task = asyncio.create_task(self._report_visit(host))
        self.visit_tasks.add(task)
        task.add_done_callback(self.visit_tasks.discard)

    async def _report_visit(self, host: str) -> None:
        try:
            await self.engine.host(host, visit=True)
        except (httpx.HTTPError, ValueError):
            pass

    def is_passthrough(self, host: str) -> bool:
        if "." not in host:
            return True
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return any(host == p or host.endswith("." + p) for p in self.s.passthrough)
        return not ip.is_global

    def store(self, host: str, entry: Entry) -> Entry:
        entry.expires = time.monotonic() + (self.s.block_ttl_s if entry.state == BLOCK else self.s.cache_ttl_s)
        self.cache[host] = entry
        return entry

    def cached(self, host: str) -> Entry | None:
        entry = self.cache.get(host)
        return entry if entry and entry.expires > time.monotonic() else None

    def ensure(self, host: str, url: str) -> asyncio.Task[Entry]:
        task = self.tasks.get(host)
        if task is None:
            task = asyncio.create_task(self._resolve(host, url))
            self.tasks[host] = task
            task.add_done_callback(lambda _t: self.tasks.pop(host, None))
        return task

    async def _resolve(self, host: str, url: str) -> Entry:
        """Ask the engine until it has a conclusive decision or the hold time is spent."""
        deadline = time.monotonic() + self.s.hold_s
        partial: Entry | None = None
        checked = False
        engine_down = False
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                data = await self.engine.host(host)
                if not checked and (data is None or not entry_from_engine(data, "engine")[1]):
                    # One investigation per hold; after that only poll, never start a duplicate.
                    checked = True
                    self.last_visit[host] = time.monotonic()  # the engine counts a gateway check as a visit
                    data = await self._check(host, url, remaining)
                    if data is None:
                        return self.store(host, Entry(state=ALLOW, source="engine-rejected"))
                engine_down = False
                if data is not None:
                    entry, conclusive = entry_from_engine(data, "engine")
                    if conclusive:
                        return self.store(host, entry)
                    partial = entry
            except (httpx.ConnectError, httpx.ConnectTimeout):
                engine_down = True
            except (httpx.HTTPError, ValueError):
                engine_down = False
            await asyncio.sleep(min(0.4, max(deadline - time.monotonic(), 0)))
        if partial is not None:
            return self.store(host, replace(partial, source="partial"))
        stale = self.cache.get(host)
        if stale is not None:
            return self.store(host, replace(stale, source="stale"))
        source = "engine-down" if engine_down else "timeout"
        return self.store(host, Entry(state=self.s.on_timeout, source=source))

    async def _check(self, host: str, url: str, wait_s: float) -> dict | None:
        """POST /v1/check; a URL the engine refuses (4xx) is retried as the bare host, and a refusal of
        that too yields None: a request the engine cannot take is not evidence against the site."""
        for candidate in dict.fromkeys((url, f"{urlsplit(url).scheme or 'https'}://{host}/")):
            try:
                return await self.engine.check(candidate, wait_s)
            except httpx.HTTPStatusError as exc:
                if not 400 <= exc.response.status_code < 500:
                    raise
                log.warning(json.dumps({"event": "engine.rejected", "host": host,
                                        "status": exc.response.status_code, "url_length": len(candidate)}))
        return None

    async def decide(self, host: str, url: str, *, hold: bool, via: str, client: str = "",
                     grace_s: float = 0.0) -> Entry:
        """Decision for a host. hold=True waits for the engine (bounded by the hold time); otherwise
        the answer may be PENDING after at most grace_s while the investigation continues."""
        started = time.monotonic()
        if self.is_passthrough(host):
            entry = Entry(state=ALLOW, source="passthrough")
        elif cached := self.cached(host):
            entry = replace(cached, source="cache")
        else:
            task = self.ensure(host, url)
            if not hold and grace_s > 0:
                await asyncio.wait({task}, timeout=grace_s)
            if hold:
                entry = await asyncio.shield(task)
            elif task.done():
                entry = task.result()
            else:
                entry = Entry(state=PENDING, source="engine")
        if not (via == "status" and entry.state == PENDING):
            self.log_decision(host, entry, via=via, client=client, wait_ms=(time.monotonic() - started) * 1000)
        return entry

    def log_decision(self, host: str, entry: Entry, *, via: str, client: str = "", wait_ms: float = 0.0) -> None:
        record = {
            "event": "decision",
            "host": host,
            "decision": entry.state,
            "wait_ms": round(wait_ms),
            "source": entry.source,
            "via": via,
            "client": client,
            "risk": entry.risk,
            "verdict": entry.verdict_id,
        }
        log.info(json.dumps(record, ensure_ascii=False))

    def apply_event(self, name: str, data: dict) -> str | None:
        """Update the cache from an engine event. Returns the host whose connections must be cut."""
        if name not in ("verdict.revoked", "verdict.reviewed", "verdict.updated"):
            return None
        host = (data.get("host") or hostname_of(data.get("final_url")) or hostname_of(data.get("url"))).lower()
        verdict_id = data.get("verdict_id") or data.get("id")
        if not host and verdict_id:
            host = next((h for h, e in self.cache.items() if e.verdict_id == verdict_id), "")
        if not host:
            return None
        if name == "verdict.revoked":
            data = {**data, "decision": data.get("decision") or BLOCK}
        if data.get("decision") not in (ALLOW, WARN, BLOCK):
            self.cache.pop(host, None)
            return None
        entry, conclusive = entry_from_engine(data, f"event:{name}")
        if name == "verdict.reviewed":
            entry.review_pending = False
        elif name == "verdict.updated":
            if not conclusive:
                return None
            previous = self.cache.get(host)
            if previous and previous.state == BLOCK and entry.state != BLOCK and previous.verdict_id != entry.verdict_id:
                # Another URL on a blocked host came back clean; the host record decides, so re-ask it.
                self.cache.pop(host, None)
                return None
        previous = self.cache.get(host)
        self.store(host, entry)
        if previous is not None and previous.state == entry.state:
            return None
        self.log_decision(host, entry, via="event")
        # Only a host we had let through can have connections worth cutting; any others are still held.
        return host if entry.state == BLOCK and previous is not None else None

    def track(self, host: str, client_id: str) -> None:
        self.conns.setdefault(host, set()).add(client_id)
        self.client_hosts.setdefault(client_id, set()).add(host)

    def forget(self, client_id: str) -> None:
        for host in self.client_hosts.pop(client_id, ()):
            ids = self.conns.get(host)
            if ids is not None:
                ids.discard(client_id)
                if not ids:
                    del self.conns[host]

    def allow_override(self, client: str, host: str) -> None:
        self.overrides[(client, host)] = time.monotonic() + self.s.proceed_ttl_s

    def has_override(self, client: str, host: str) -> bool:
        return self.overrides.get((client, host), 0.0) > time.monotonic()


PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


class Pages:
    """Self-contained HTML pages with {{placeholder}} substitution."""

    def __init__(self, directory: Path) -> None:
        self.templates = {p.stem: p.read_text(encoding="utf-8") for p in directory.glob("*.html")}

    def render(self, name: str, values: dict[str, str], data: dict) -> bytes:
        """One pass over the template, so a hostile host or URL that contains "{{...}}" is never expanded."""
        filled = {key: value if key.endswith("_html") else html.escape(str(value)) for key, value in values.items()}
        # Inside <script>: no "<" at all, so no "</script>" or "<!--" in a hostile URL can end or bend the block.
        filled["data_json"] = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
        return PLACEHOLDER.sub(lambda m: filled.get(m.group(1), m.group(0)), self.templates[name]).encode("utf-8")


def reference_for(entry: Entry) -> str:
    """The evidence pack's case number when the engine has one, so the phone and the pack agree."""
    return entry.evidence_ref or "SS-" + (entry.verdict_id or uuid.uuid4().hex)[:8].upper()


def reasons_html(entry: Entry) -> str:
    items = "".join(
        '<li><span class="en">{}</span><span class="ar" lang="ar" dir="rtl">{}</span></li>'.format(
            html.escape(r.get("title_en") or r.get("code") or ""),
            html.escape(isolate_ltr(r.get("title_ar") or r.get("title_en") or "")))
        for r in entry.reasons
    )
    return items or ('<li><span class="en">This site matches patterns used by online scams.</span>'
                     '<span class="ar" lang="ar" dir="rtl">يطابق هذا الموقع أنماطًا تستخدمها عمليات الاحتيال الإلكتروني.</span></li>')


def brand_html(entry: Entry) -> str:
    """"Pretends to be <brand>" in both languages, with the brand's Arabic name in the Arabic half."""
    if not entry.brand_en:
        return ""
    brand_ar = entry.brand_ar or entry.brand_en
    return ('<p class="brand"><span>Pretends to be <b><bdi>{}</bdi></b></span>'
            '<span lang="ar" dir="rtl">ينتحل صفة <b><bdi>{}</bdi></b></span></p>').format(
        html.escape(entry.brand_en), html.escape(brand_ar))


def is_navigation(req: http.Request) -> bool:
    mode, dest = req.headers.get("sec-fetch-mode"), req.headers.get("sec-fetch-dest")
    if mode or dest:
        return mode == "navigate" or dest == "document"
    return req.method == "GET" and "text/html" in req.headers.get("accept", "")


def client_ip(conn: connection.Client) -> str:
    return str(conn.peername[0]) if conn.peername else ""


class ScamShield:
    def __init__(self) -> None:
        self.s = Settings.from_env()
        self.pages = Pages(self.s.pages_dir)
        self.engine = Engine(self.s.engine_url)
        self.gate = Gate(self.s, self.engine)
        self.events_task: asyncio.Task | None = None
        self.waiting: set[str] = set()  # client connections held for a decision right now
        # Per phone (client address): recent decisions and sites being checked, for the status page.
        self.history: dict[str, deque[tuple[float, str]]] = {}
        self.checking: dict[str, dict[str, float]] = {}

    async def decide(self, client_id: str, host: str, url: str, *, client: str, **kwargs) -> Entry:
        """Gate.decide for one client connection; a connection waiting here is answered, never cut."""
        self.waiting.add(client_id)
        checking = self.checking.setdefault(client, {})
        checking.setdefault(host, time.time())
        try:
            entry = await self.gate.decide(host, url, client=client, **kwargs)
        finally:
            self.waiting.discard(client_id)
            checking.pop(host, None)
        if entry.state != PENDING:
            self.gate.note_visit(host)
            seen = self.history.setdefault(client, deque(maxlen=40))
            if not seen or seen[-1][1] != host:
                seen.append((time.time(), host))
        return entry

    def running(self) -> None:
        if self.events_task is None:
            self.events_task = asyncio.create_task(self._follow_events())
        log.info(json.dumps({
            "event": "gateway.ready",
            "engine": self.s.engine_url,
            "intercept": self.s.intercept,
            "hold_s": self.s.hold_s,
            "on_timeout": self.s.on_timeout,
            "passthrough_patterns": len(self.s.passthrough),
        }))

    async def done(self) -> None:
        if self.events_task is not None:
            self.events_task.cancel()
        await self.engine.aclose()

    async def _follow_events(self) -> None:
        while True:
            try:
                async for name, data in self.engine.events():
                    if host := self.gate.apply_event(name, data):
                        self.cut(host)
            except httpx.HTTPError as exc:
                log.warning(json.dumps({"event": "events.disconnected", "error": f"{type(exc).__name__}: {exc}"}))
            except Exception as exc:  # a bad event must not stop revocations for good
                log.warning(json.dumps({"event": "events.error", "error": f"{type(exc).__name__}: {exc}"}))
            await asyncio.sleep(2)

    def cut(self, host: str) -> None:
        """Close every live client connection that has talked to this host."""
        proxyserver = ctx.master.addons.get("proxyserver")
        closed = 0
        for client_id in list(self.gate.conns.get(host, ())):
            if client_id not in self.waiting and self._close(proxyserver, client_id):
                closed += 1
        log.info(json.dumps({"event": "connections.cut", "host": host, "closed": closed}))

    @staticmethod
    def _close(proxyserver, client_id: str, *, reset: bool = False) -> bool:
        """Close a client connection; reset=True sends a TCP reset so the browser shows its error at once."""
        handler = proxyserver.connections.get(client_id)
        if handler is None or handler.client not in handler.transports:
            return False
        writer = handler.transports[handler.client].writer
        sock = writer.get_extra_info("socket") if reset and writer is not None else None
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        handler.close_connection(handler.client)
        return True

    def client_disconnected(self, client: connection.Client) -> None:
        self.gate.forget(client.id)

    # TLS: hostname-level decisions --------------------------------------------------------------

    async def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        client = data.context.client
        server = data.context.server.address
        host = (data.client_hello.sni or (str(server[0]) if server else "")).lower()
        if not host:
            return
        if self.gate.is_passthrough(host):
            await self.gate.decide(host, f"https://{host}/", hold=True, via="tls", client=client_ip(client))
            data.ignore_connection = True
            return
        self.gate.track(host, client.id)
        if self.s.intercept:
            self.gate.ensure(host, f"https://{host}/")
            return
        entry = await self.decide(client.id, host, f"https://{host}/", hold=True, via="tls", client=client_ip(client))
        if entry.state == BLOCK or (entry.state == WARN and self.s.warn_over_tls == BLOCK):
            self._close(ctx.master.addons.get("proxyserver"), client.id, reset=True)
        else:
            data.ignore_connection = True

    # HTTP: full-URL decisions and pages ---------------------------------------------------------

    async def requestheaders(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        if flow.response or req.method == "CONNECT":
            return
        host = req.pretty_host.lower()
        if req.path.startswith(INTERNAL_PREFIX):
            await self._internal(flow, host)
            return
        ip = client_ip(flow.client_conn)
        if host == self.s.status_host:
            await self._status_page(flow, ip)
            return
        if host == "mitm.it":
            return
        if self.gate.is_passthrough(host):
            await self.gate.decide(host, req.pretty_url, hold=True, via="http", client=ip)
            return
        self.gate.track(host, flow.client_conn.id)
        navigation = is_navigation(req)
        entry = await self.decide(flow.client_conn.id, host, req.pretty_url, hold=not navigation, via="http", client=ip,
                                 grace_s=self.s.page_grace_s)
        if entry.state == PENDING:
            flow.response = self._page(200, "checking", host, entry, req.pretty_url)
        elif entry.state == BLOCK:
            await self._with_reasons(entry)
            if navigation:
                flow.response = self._page(403, "blocked", host, entry, req.pretty_url)
            else:
                text = f"Blocked by Mirsad: {host} (reference {reference_for(entry)})\n"
                flow.response = http.Response.make(403, text, {"content-type": "text/plain; charset=utf-8"})
        elif entry.state == WARN and navigation and not self.gate.has_override(ip, host):
            await self._with_reasons(entry)
            flow.response = self._page(200, "warning", host, entry, req.pretty_url)

    async def _with_reasons(self, entry: Entry) -> None:
        """Complete an entry from the full verdict: reasons, brand, and the evidence case number, which
        the engine assigns after the decision, so it is looked up again until it exists."""
        if not entry.verdict_id or (entry.reasons and entry.evidence_ref):
            return
        try:
            verdict = await self.engine.verdict(entry.verdict_id)
        except (httpx.HTTPError, ValueError):
            return
        entry.add_details(verdict)
        cached = self.gate.cache.get(verdict.get("host") or "")
        if cached is not None and cached is not entry and cached.verdict_id == entry.verdict_id:
            cached.add_details(verdict)

    async def _status_page(self, flow: http.HTTPFlow, client: str) -> None:
        """The phone's own protection page (http://shield.test/): its recent decisions, newest block or
        warning first, keyed by the client address so a phone only ever sees its own history."""
        data = await self._status_data(client)
        headers = {"cache-control": "no-store"}
        if flow.request.path.split("?", 1)[0] == "/status.json":
            flow.response = http.Response.make(200, json.dumps(data, ensure_ascii=False),
                                               {**headers, "content-type": "application/json; charset=utf-8"})
        else:
            body = self.pages.render("shield", {}, data)
            flow.response = http.Response.make(200, body, {**headers, "content-type": "text/html; charset=utf-8"})

    async def _status_data(self, client: str) -> dict:
        latest: dict[str, float] = {}
        for at, host in self.history.get(client, ()):
            latest[host] = at
        rows = [(at, host, entry) for host, at in latest.items() if (entry := self.gate.cache.get(host)) is not None]
        risky = sorted((r for r in rows if r[2].state in (BLOCK, WARN)), key=lambda r: -r[0])[:6]
        await asyncio.gather(*(self._with_reasons(entry) for _, _, entry in risky))
        safe = sorted((r for r in rows if r[2].state == ALLOW), key=lambda r: -r[0])[:6]
        items = [{
            "host": host,
            "state": entry.state,
            "risk": None if entry.risk is None else round(entry.risk),
            "at": round(at),
            "reference": reference_for(entry) if entry.verdict_id else None,
            "brand_en": entry.brand_en,
            "brand_ar": entry.brand_ar or entry.brand_en,
            "review_pending": entry.review_pending,
            "reasons": [{"en": r.get("title_en") or r.get("code") or "",
                         "ar": isolate_ltr(r.get("title_ar") or r.get("title_en") or "")} for r in entry.reasons]
            if entry.state != ALLOW else [],
        } for at, host, entry in risky + safe]
        checking = [{"host": host, "since": round(since)} for host, since in self.checking.get(client, {}).items()]
        return {"client": client, "now": round(time.time()), "checking": checking, "items": items}

    async def _internal(self, flow: http.HTTPFlow, host: str) -> None:
        req = flow.request
        action = req.path[len(INTERNAL_PREFIX):].split("?", 1)[0]
        headers = {"cache-control": "no-store"}
        if action == "status":
            entry = await self.gate.decide(host, f"{req.scheme}://{host}/", hold=False, via="status",
                                           client=client_ip(flow.client_conn))
            body = {"host": host, "state": entry.state, "risk": entry.risk,
                    "reference": reference_for(entry) if entry.verdict_id else None,
                    "review_pending": entry.review_pending}
            flow.response = http.Response.make(200, json.dumps(body), {**headers, "content-type": "application/json"})
        elif action == "proceed":
            target = parse_qs(urlsplit(req.path).query).get("to", [""])[0]
            if hostname_of(target) != host:
                target = f"{req.scheme}://{host}/"
            self.gate.allow_override(client_ip(flow.client_conn), host)
            flow.response = http.Response.make(302, b"", {**headers, "location": target})
        else:
            flow.response = http.Response.make(404, b"not found", headers)

    def _page(self, status: int, name: str, host: str, entry: Entry, url: str) -> http.Response:
        risk = "" if entry.risk is None else f"{round(entry.risk)}"
        values = {
            "host": host,
            "url": url,
            "risk": risk or "—",
            "reference": reference_for(entry),
            "summary_en": entry.summary_en,
            "summary_ar": isolate_ltr(entry.summary_ar),
            "brand_html": brand_html(entry),
            "reasons_html": reasons_html(entry),
            "proceed_url": f"{INTERNAL_PREFIX}proceed?to={quote(url, safe='')}",
        }
        data = {"status_url": INTERNAL_PREFIX + "status", "url": url, "review_pending": entry.review_pending,
                "hold_s": self.s.hold_s}
        body = self.pages.render(name, values, data)
        return http.Response.make(status, body, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"})

    # DNS: resolver hook -------------------------------------------------------------------------

    def dns_request(self, flow: dns.DNSFlow) -> None:
        question = flow.request.question
        if question is None:
            return
        name = question.name.rstrip(".").lower()
        if question.type in (dns.types.AAAA, dns.types.HTTPS):
            # IPv4 only (the uplink has no IPv6), and no HTTPS records so browsers neither try QUIC
            # first nor hide the server name behind Encrypted Client Hello.
            flow.response = flow.request.succeed([])
        elif question.type == dns.types.A and name == "mitm.it":
            flow.response = flow.request.succeed([dns.ResourceRecord.A(question.name, ONBOARDING_IP, ttl=60)])
        elif question.type == dns.types.A and name == self.s.status_host:
            flow.response = flow.request.succeed([dns.ResourceRecord.A(question.name, STATUS_IP, ttl=60)])
        elif (question.type == dns.types.A and self.s.dns_prefetch and not self.gate.is_passthrough(name)
              and self.gate.cached(name) is None):
            self.gate.ensure(name, f"https://{name}/")


addons = [ScamShield()]
