"""Fetch a page the way a person's phone or laptop browser would, and snapshot what it shows.

No automated browser: curl_cffi reproduces Chrome's TLS and HTTP/2 fingerprints, we send
Chrome's header set ourselves, follow HTTP / meta / JavaScript redirects by hand and analyse
everything statically. GET only; forms are never submitted.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import contextvars
import ipaddress
import json
import multiprocessing
import os
import re
import sys
import time
import types
import weakref
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit, urlunsplit

import dns.asyncresolver
import dns.exception
import idna
from curl_cffi import CurlHttpVersion, CurlOpt
from curl_cffi.requests import AsyncSession

from scamshield import config
from scamshield.intel import lists
from scamshield.schemas import FormInfo, PageSnapshot, RedirectHop, ScriptFinding

from . import hashing
from .extract import ParsedPage, clean_text, detect_language, host_of, json_text, parse_html, same_site, site_of
from .jsanalysis import MAX_SCRIPT_BYTES, analyse_script, data_endpoints, html_fragments, select_scripts

MAX_HTML_BYTES = 3_000_000
MAX_FAVICON_BYTES = 200_000
MAX_INLINE_SCRIPTS = 40
MAX_TEXT_CHARS = 200_000
MAX_INLINE_BYTES = 1_000_000  # inline script bytes analysed per page
ANALYSIS_BUDGET_S = 3.0  # wall-clock limit for one analysis job in a worker process
ANALYSIS_WORKERS = int(os.environ.get("SCAMSHIELD_ANALYSIS_WORKERS", str(min(4, os.cpu_count() or 2))))
LIGHT_PAGE_CHARS = 400  # pages this small may be pure redirectors, so their JS navigations are followed
REDIRECTOR_MAX_BYTES = 50_000
SHELL_WORDS = 25  # fewer visible words than this means the HTML is an empty client-side shell
META_REFRESH_MAX_DELAY_S = 15
ASSET_PHASE_S = 1.2  # hard cap on scripts + favicon after the document arrives
ASSET_PHASE_MIN_S = 0.5  # ...shrunk towards this when the document itself was slow
TARGET_PAGE_S = 2.0  # aim for a whole snapshot within this wall time
PROBE_BUDGET_S = 3.0  # per identity in cloaking_probe; a bot left hanging counts as refused
SNAPSHOT_BUDGET_S = 3.0  # hard ceiling for fetch_page; a body still downloading is kept as truncated
DNS_TIMEOUT_S = 1.5  # per name, A and AAAA in parallel; a dead domain must not cost more
DNS_TRY_TIMEOUT_S = 0.7  # per query to one nameserver before retrying the next
DNS_CACHE_TTL_S = 300
DNS_NEGATIVE_TTL_S = 60  # dead or unresolvable names, kept long enough to cover an investigation

ACCEPT_LANGUAGE = "en-US,en;q=0.9,ar-AE;q=0.8,ar;q=0.7"
PROBE_REFERER = "https://www.google.com/"
SHORTENERS = lists.wordset("platforms", "shorteners_followed")

_ACCEPT = {
    "document": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,"
    "application/signed-exchange;v=b3;q=0.7",
    "script": "*/*",
    "image": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "data": "application/json, text/plain, */*",
}
_FETCH_MODE = {"document": "navigate", "script": "no-cors", "image": "no-cors", "data": "cors"}
_FETCH_DEST = {"document": "document", "script": "script", "image": "image", "data": "empty"}
_PRIORITY = {"document": "u=0, i", "script": "u=1", "image": "u=1, i", "data": "u=1, i"}


@dataclass(frozen=True)
class Profile:
    impersonate: str | None
    user_agent: str
    ch_ua: str | None = None
    ch_mobile: str = "?0"
    ch_platform: str = ""


_CHROME_CH_UA = '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"'
PROFILES = {
    "mobile": Profile(
        "chrome152",
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
        _CHROME_CH_UA, "?1", '"Android"',
    ),
    "desktop": Profile(
        "chrome152",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
        _CHROME_CH_UA, "?0", '"Windows"',
    ),
    # Deliberately obvious automation: library user agent and curl's own TLS fingerprint.
    "crawler": Profile(None, "python-requests/2.32.3"),
}

_ABORT_TRANSFER = 0xFFFFFFFF  # CURL_WRITEFUNC_ERROR
_sessions: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_dns_cache: dict[str, tuple[float, list[str] | Exception]] = {}
_pinned_address: contextvars.ContextVar[str | None] = contextvars.ContextVar("pinned_address", default=None)


class _PinnedSession(AsyncSession):
    """Connects to the address `check_target` vetted (curl RESOLVE), read per task from a context var.

    This saves curl a second DNS lookup and stops a rebinding DNS answer from pointing it inside.
    """

    @property
    def curl_options(self) -> dict:
        pin = _pinned_address.get()
        return {CurlOpt.RESOLVE: [pin]} if pin else {}

    @curl_options.setter
    def curl_options(self, _value) -> None:
        pass


def _session(profile: str) -> AsyncSession:
    """One pooled session per profile and event loop (curl handles are bound to their loop)."""
    per_loop = _sessions.setdefault(asyncio.get_running_loop(), {})
    if profile not in per_loop:
        p = PROFILES[profile]
        per_loop[profile] = _PinnedSession(impersonate=p.impersonate, default_headers=False, max_clients=64)
    return per_loop[profile]


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def fetch_site(initiator: str | None, target: str) -> str:
    """Chrome's Sec-Fetch-Site value for a request to `target` started by `initiator`."""
    if not initiator:
        return "none"
    if _origin(initiator) == _origin(target):
        return "same-origin"
    if urlsplit(initiator).scheme == urlsplit(target).scheme and same_site(host_of(initiator), host_of(target)):
        return "same-site"
    return "cross-site"


def referrer_for(page: str | None, target: str) -> str | None:
    """Referer under Chrome's default strict-origin-when-cross-origin policy."""
    if not page:
        return None
    if urlsplit(page).scheme == "https" and urlsplit(target).scheme == "http":
        return None
    if _origin(page) == _origin(target):
        return page.split("#")[0]
    return _origin(page) + "/"


def build_headers(profile: str, kind: str, *, referer: str | None, site: str, user_activated: bool = True) -> dict[str, str]:
    p = PROFILES[profile]
    if p.ch_ua is None:
        headers = {"User-Agent": p.user_agent, "Accept": "*/*", "Connection": "keep-alive"}
        if referer:
            headers["Referer"] = referer
        return headers
    hints = {"sec-ch-ua": p.ch_ua, "sec-ch-ua-mobile": p.ch_mobile, "sec-ch-ua-platform": p.ch_platform}
    headers: dict[str, str] = {}
    if kind == "document":
        headers.update(hints)
        headers["upgrade-insecure-requests"] = "1"
        headers["user-agent"] = p.user_agent
    else:
        headers["sec-ch-ua-platform"] = p.ch_platform
        headers["user-agent"] = p.user_agent
        headers["sec-ch-ua"] = p.ch_ua
        headers["sec-ch-ua-mobile"] = p.ch_mobile
    headers["accept"] = _ACCEPT[kind]
    headers["sec-fetch-site"] = site
    headers["sec-fetch-mode"] = _FETCH_MODE[kind]
    if kind == "document" and user_activated:
        headers["sec-fetch-user"] = "?1"
    headers["sec-fetch-dest"] = _FETCH_DEST[kind]
    if referer:
        headers["referer"] = referer
    headers["accept-language"] = ACCEPT_LANGUAGE
    headers["priority"] = _PRIORITY[kind]
    return headers


def _allow_private() -> bool:
    return os.environ.get("SCAMSHIELD_ALLOW_PRIVATE") == "1"


def _allowed_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """Private subnets explicitly opened for fetching (e.g. the demo sites' compose network)."""
    raw = os.environ.get("SCAMSHIELD_ALLOW_NETWORKS", "")
    return [ipaddress.ip_network(n.strip(), strict=False) for n in raw.split(",") if n.strip()]


def _is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return False
    return addr.is_global or any(addr in net for net in _allowed_networks())


_NAMESERVERS = [ns.strip() for ns in os.environ.get("SCAMSHIELD_DNS", "").split(",") if ns.strip()]
_resolvers: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _resolver() -> dns.asyncresolver.Resolver:
    """Asynchronous stub resolver (no threads to hang), from SCAMSHIELD_DNS or the system config."""
    loop = asyncio.get_running_loop()
    if loop not in _resolvers:
        resolver = dns.asyncresolver.Resolver(configure=not _NAMESERVERS)
        if _NAMESERVERS:
            resolver.nameservers = _NAMESERVERS
        resolver.timeout = DNS_TRY_TIMEOUT_S
        _resolvers[loop] = resolver
    return _resolvers[loop]


async def _resolve(host: str, timeout: float = DNS_TIMEOUT_S) -> list[str]:
    """A and AAAA addresses within `timeout`. Answers and failures are both cached, so a dead phishing
    domain costs one short lookup however many times an investigation asks for it."""
    cached = _dns_cache.get(host)
    if cached and cached[0] > time.monotonic():
        if isinstance(cached[1], Exception):
            raise cached[1]
        return cached[1]
    if host == "localhost" or host.endswith(".localhost"):
        ips = ["127.0.0.1"]  # RFC 6761: never sent to a resolver
    else:
        resolver = _resolver()
        lifetime = max(0.1, min(timeout, DNS_TIMEOUT_S))
        answers = await asyncio.gather(
            *(resolver.resolve(host, rtype, lifetime=lifetime, search=False) for rtype in ("A", "AAAA")),
            return_exceptions=True,
        )
        ips = [r.address for a in answers if not isinstance(a, BaseException) for r in a]
        if not ips:
            error = next((a for a in answers if isinstance(a, dns.exception.Timeout)), None)
            failure = asyncio.TimeoutError() if error else OSError("no address records")
            _dns_cache[host] = (time.monotonic() + DNS_NEGATIVE_TTL_S, failure)
            raise failure
    _dns_cache[host] = (time.monotonic() + DNS_CACHE_TTL_S, ips)
    return ips


async def check_target(url: str, timeout: float = DNS_TIMEOUT_S) -> tuple[str | None, str | None]:
    """(error, address to connect to). Refuses non-web schemes and private, loopback or link-local targets."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return f"refused: unsupported URL {url[:200]}", None
    try:
        ips = [parts.hostname] if _is_ip(parts.hostname) else await _resolve(parts.hostname, timeout)
    except (OSError, asyncio.TimeoutError, UnicodeError) as exc:
        return f"dns: cannot resolve {parts.hostname} ({type(exc).__name__})", None
    if not ips:
        return f"dns: no address for {parts.hostname}", None
    if not _allow_private() and not all(_is_public(ip) for ip in ips):
        return f"refused: {parts.hostname} resolves to a non-public address", ips[0]
    return None, next((ip for ip in ips if ":" not in ip), ips[0])


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


def normalise_url(url: str) -> str:
    """Add a scheme when missing and IDNA-encode the host so curl receives plain ASCII."""
    url = url.strip()
    if not re.match(r"^[a-z][a-z0-9+.-]*://", url, re.I):
        url = "https://" + url.lstrip("/")
    parts = urlsplit(url)
    host = parts.hostname or ""
    if host and not host.isascii():
        try:
            ascii_host = idna.encode(host, uts46=True).decode()
        except idna.IDNAError:
            ascii_host = host.encode("idna").decode()
        netloc = parts.netloc.replace(parts.netloc.rsplit("@", 1)[-1].split(":")[0], ascii_host)
        parts = parts._replace(netloc=netloc)
    return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path or "/", parts.query, parts.fragment))


@dataclass
class RawResponse:
    url: str
    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    ip: str | None = None
    truncated: bool = False
    tls_error: str | None = None
    error: str | None = None
    dns_ms: float = 0.0

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").lower()


def _flatten_headers(headers) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers.multi_items():
        key = key.lower()
        out[key] = f"{out[key]}\n{value}" if key in out else value
    return out


async def http_get(
    url: str,
    profile: str,
    kind: str = "document",
    *,
    referer: str | None = None,
    site: str = "none",
    cookies: dict[str, str] | None = None,
    timeout: float = config.FETCH_TIMEOUT_S,
    max_bytes: int = MAX_HTML_BYTES,
    user_activated: bool = True,
) -> RawResponse:
    """One GET without following redirects. Never raises; failures come back in `error`."""
    result = RawResponse(url=url)
    started = time.perf_counter()
    error, result.ip = await check_target(url, min(DNS_TIMEOUT_S, timeout))
    result.dns_ms = (time.perf_counter() - started) * 1000
    if error:
        result.error = error
        return result
    timeout = max(0.2, timeout - result.dns_ms / 1000)  # the caller's budget covers the lookup too
    parts = urlsplit(url)
    if result.ip and not _is_ip(parts.hostname or ""):
        address = f"[{result.ip}]" if ":" in result.ip else result.ip
        _pinned_address.set(f"{parts.hostname}:{parts.port or (443 if parts.scheme == 'https' else 80)}:{address}")
    else:
        _pinned_address.set(None)
    headers = build_headers(profile, kind, referer=referer, site=site, user_activated=user_activated)
    options = dict(
        headers=headers,
        cookies=cookies or None,
        allow_redirects=False,
        timeout=timeout,
        discard_cookies=True,
        accept_encoding="gzip, deflate, br, zstd",
        # Chrome speaks HTTP/1.1 on cleartext; curl would otherwise offer an h2c upgrade no browser sends.
        http_version=CurlHttpVersion.V1_1 if url.startswith("http://") else None,
    )
    session = _session(profile)
    for verify in (True, False):
        chunks: list[bytes] = []

        def collect(chunk: bytes) -> int:
            chunks.append(chunk)
            # Returning curl's write-error code aborts the transfer once the size cap is reached.
            return _ABORT_TRANSFER if sum(map(len, chunks)) >= max_bytes else len(chunk)

        try:
            resp = await asyncio.wait_for(
                session.request("GET", url, verify=verify, content_callback=collect, **options), timeout + 1
            )
        except Exception as exc:
            resp = getattr(exc, "response", None)
            if resp is None or not resp.status_code or not chunks:
                message = f"{type(exc).__name__}: {exc}"[:300]
                if verify and re.search(r"certificate|SSL|curl: \(60\)", message, re.I):
                    result.tls_error = message
                    continue
                result.error = message
                return result
            result.truncated = True  # size cap or deadline hit mid-body: keep what arrived
        result.status = resp.status_code
        result.headers = _flatten_headers(resp.headers)
        result.ip = resp.primary_ip or result.ip
        if result.ip and not _allow_private() and not _is_public(result.ip):
            result.error = f"refused: connected to non-public address {result.ip}"
            return result
        result.body = b"".join(chunks)[:max_bytes]
        return result
    return result


_META_CHARSET = re.compile(rb"<meta[^>]{0,200}?charset\s*=\s*[\"']?\s*([\w.:-]+)", re.I)


def decode_body(body: bytes, content_type: str) -> str:
    if body.startswith(codecs.BOM_UTF8):
        return body[3:].decode("utf-8", errors="replace")
    match = re.search(r"charset\s*=\s*[\"']?([\w.:-]+)", content_type, re.I)
    charset = match.group(1) if match else None
    if not charset and (meta := _META_CHARSET.search(body[:4096])):
        charset = meta.group(1).decode("ascii", errors="ignore")
    try:
        return body.decode(codecs.lookup(charset or "utf-8").name, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def looks_like_html(raw: RawResponse) -> bool:
    ctype = raw.content_type
    if "html" in ctype:
        return True
    if ctype and not ctype.startswith(("text/plain", "application/octet-stream", "binary/octet-stream")):
        return False
    head = raw.body[:1024].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html")) or b"<head" in head or b"<body" in head


class _Navigation:
    """State of one page fetch: deadline, per-site cookies and the redirect chain so far."""

    def __init__(self, profile: str, referer: str | None, assets: bool, budget: float):
        self.profile = profile
        self.referer = referer
        self.assets = assets  # fetch scripts, favicon and data endpoints, not just documents
        self.started = time.monotonic()
        self.deadline = self.started + budget
        self.cookies: dict[str, dict[str, str]] = {}
        self.chain: list[RedirectHop] = []
        self.visited: set[str] = set()
        self.timings: dict[str, float] = {}

    @contextlib.contextmanager
    def phase(self, name: str):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.timings[name] = self.timings.get(name, 0.0) + (time.perf_counter() - started) * 1000

    def remaining(self, cap: float = config.FETCH_TIMEOUT_S) -> float:
        return max(0.2, min(cap, self.deadline - time.monotonic()))

    def asset_budget(self) -> float:
        """Time left for sub-resources: what remains of the page target, within fixed bounds."""
        spent = time.monotonic() - self.started
        budget = min(ASSET_PHASE_S, max(ASSET_PHASE_MIN_S, TARGET_PAGE_S - spent))
        return max(0.1, min(budget, self.deadline - time.monotonic()))

    def store_cookies(self, raw: RawResponse) -> None:
        jar = self.cookies.setdefault(site_of(host_of(raw.url)), {})
        for line in raw.headers.get("set-cookie", "").split("\n"):
            name, sep, value = line.split(";", 1)[0].partition("=")
            if sep and name.strip():
                jar[name.strip()] = value.strip()

    def cookies_for(self, url: str) -> dict[str, str]:
        return self.cookies.get(site_of(host_of(url)), {})

    async def get(self, url: str, kind: str, *, initiator: str | None, cap: float, max_bytes: int, user_activated: bool = True) -> RawResponse:
        raw = await http_get(
            url, self.profile, kind,
            referer=referrer_for(initiator, url) if initiator else (self.referer if kind == "document" else None),
            site=fetch_site(initiator or self.referer, url),
            cookies=self.cookies_for(url),
            timeout=self.remaining(cap),
            max_bytes=max_bytes,
            user_activated=user_activated,
        )
        self.store_cookies(raw)
        return raw

    def hop(self, raw: RawResponse, via: str) -> None:
        host = host_of(raw.url)
        if host in SHORTENERS or site_of(host) in SHORTENERS:
            via = "shortener"
        self.chain.append(RedirectHop(url=raw.url, status=raw.status, via=via, ip=raw.ip))


# --- analysis in worker processes ----------------------------------------------------------------
# Fetched content is hostile. Every pattern applied to it is linear and every input is capped, but the
# analysis still runs in separate processes: a long regex holds its process's GIL, and it must never
# stall the event loop that serves every other investigation. Document jobs and script jobs get their
# own pools so a page full of scripts cannot queue ahead of another page's HTML.

_pools: dict[str, ProcessPoolExecutor] = {}


def _warm() -> None:
    """Runs once per new worker so its imports happen before the first real job."""


def _pool(kind: str) -> ProcessPoolExecutor:
    if kind not in _pools:
        pool = ProcessPoolExecutor(ANALYSIS_WORKERS, mp_context=multiprocessing.get_context("spawn"))
        # Spawned workers re-import the caller's __main__; analysis needs nothing from it, and an
        # unguarded calling script would otherwise run again in every worker. Submitting one job per
        # worker starts them all now, while __main__ is swapped for an empty module.
        real_main = sys.modules["__main__"]
        sys.modules["__main__"] = types.ModuleType("__main__")
        try:
            for _ in range(ANALYSIS_WORKERS):
                pool.submit(_warm)
        finally:
            sys.modules["__main__"] = real_main
        _pools[kind] = pool
    return _pools[kind]


async def _offload(kind: str, fn, *args):
    """Run `fn(*args)` in a worker process; TimeoutError after ANALYSIS_BUDGET_S of wall-clock time.

    On timeout the investigation moves on and the abandoned job finishes (bounded) in its worker.
    """
    future = asyncio.get_running_loop().run_in_executor(_pool(kind), fn, *args)
    try:
        return await asyncio.wait_for(future, ANALYSIS_BUDGET_S)
    except BrokenProcessPool:
        _pools.pop(kind, None)
        raise


def _scan(code: str, src: str | None, url: str, first_party: bool, size: int | None = None) -> tuple[ScriptFinding, str]:
    """Analyse one script and return it with any HTML form markup it would inject."""
    return analyse_script(code, src=src, page_url=url, first_party=first_party, size=size), html_fragments(code)


def _inline_scripts(page: ParsedPage, url: str) -> tuple[list[ScriptFinding], list[str]]:
    """Analyse the page's inline scripts and event handlers, at most MAX_INLINE_BYTES in total."""
    sources, budget = [], MAX_INLINE_BYTES
    for code in page.inline_scripts[:MAX_INLINE_SCRIPTS] + ([page.handler_code] if page.handler_code else []):
        if budget <= 0:
            break
        sources.append(code[:budget])
        budget -= len(code)
    scans = [_scan(code, None, url, True) for code in sources]
    findings = [f for f, _ in scans if f.obfuscation_markers or f.endpoints or f.redirects or f.suspicious_calls]
    return findings, [html for _, html in scans if html]


def _injected_forms(fragments: list[str], url: str) -> tuple[list[FormInfo], str]:
    """Credential forms (and their text) in markup that scripts would inject."""
    forms, texts = [], []
    for fragment in fragments:
        hidden = parse_html(fragment, url)
        sensitive = [f for f in hidden.forms if _asks_secrets(f)]
        if sensitive:
            forms += sensitive
            texts.append(hidden.text)
    return forms, " ".join(texts)


def _endpoint_text(body: str, is_json: bool, is_html: bool, endpoint: str) -> str:
    if is_json:
        out: list[str] = []
        try:
            json_text(json.loads(body), out, [20_000])
        except (ValueError, RecursionError):
            return ""
        return " ".join(out)
    return parse_html(body, endpoint).text if is_html else body[:20_000]


def _client_redirect(page: ParsedPage, findings: list[ScriptFinding], url: str) -> tuple[str, str] | None:
    """(target, via) when the page itself navigates elsewhere without user action."""
    current = url.split("#")[0]
    if page.meta_refresh and page.meta_refresh[0] <= META_REFRESH_MAX_DELAY_S:
        if page.meta_refresh[1].split("#")[0] != current:
            return page.meta_refresh[1], "meta"
    if page.visible_chars < LIGHT_PAGE_CHARS:
        for finding in findings:
            # A redirector script is small and has one or two destinations; app bundles have many.
            if (finding.src and finding.size > REDIRECTOR_MAX_BYTES) or len(finding.redirects) > 3:
                continue
            for target in finding.redirects:
                if target.split("#")[0] != current:
                    return target, "js"
    return None


async def _assets(nav: _Navigation, page: ParsedPage, url: str) -> tuple[list[ScriptFinding], list[str], str | None]:
    """Fetch scripts and favicon concurrently under one hard deadline; keep whatever has arrived by then.

    Scripts that are skipped (known vendors) or still in flight at the deadline are listed unanalysed.
    """
    to_fetch, skipped = select_scripts(page.script_srcs, url)

    async def one(src: str, first_party: bool) -> tuple[ScriptFinding, str]:
        raw = await nav.get(src, "script", initiator=url, cap=ASSET_PHASE_S, max_bytes=MAX_SCRIPT_BYTES)
        if raw.error or raw.status != 200 or not raw.body:
            return ScriptFinding(src=src, first_party=first_party), ""
        code = decode_body(raw.body, raw.content_type)
        try:
            return await _offload("script", _scan, code, src, url, first_party, len(raw.body))
        except (asyncio.TimeoutError, BrokenProcessPool):
            return ScriptFinding(src=src, first_party=first_party, size=len(raw.body)), ""

    scripts = [asyncio.create_task(one(src, fp)) for src, fp in to_fetch]
    favicon = asyncio.create_task(_favicon(nav, page, url))
    _, pending = await asyncio.wait([*scripts, favicon], timeout=nav.asset_budget())
    for task in pending:
        task.cancel()
    page_host = host_of(url)
    findings, injected = [], []
    for task, (src, first_party) in zip(scripts, to_fetch):
        finding, html = task.result() if task.done() and not task.cancelled() else (ScriptFinding(src=src, first_party=first_party), "")
        findings.append(finding)
        if html:
            injected.append(html)
    findings += [ScriptFinding(src=s, first_party=same_site(host_of(s), page_host)) for s in skipped]
    icon = favicon.result() if favicon.done() and not favicon.cancelled() else None
    return findings, injected, icon


async def _favicon(nav: _Navigation, page: ParsedPage, url: str) -> str | None:
    if not page.favicon_url:
        return None
    raw = await nav.get(page.favicon_url, "image", initiator=url, cap=ASSET_PHASE_S, max_bytes=MAX_FAVICON_BYTES)
    if raw.error or raw.status != 200 or not raw.body or "html" in raw.content_type or raw.truncated:
        return None
    return hashing.favicon_hash(raw.body)


async def _recover_content(nav: _Navigation, findings: list[ScriptFinding], url: str) -> str:
    """Text from same-site data endpoints named in the page's scripts, for client-rendered shells."""

    async def one(endpoint: str) -> str:
        raw = await nav.get(endpoint, "data", initiator=url, cap=ASSET_PHASE_S, max_bytes=MAX_HTML_BYTES)
        if raw.error or raw.status != 200 or not raw.body:
            return ""
        body = decode_body(raw.body, raw.content_type)
        is_json = "json" in raw.content_type or body.lstrip()[:1] in ("{", "[")
        is_html = not is_json and looks_like_html(raw)
        if not (is_json or is_html or raw.content_type.startswith("text/plain")):
            return ""
        try:
            return await _offload("document", _endpoint_text, body, is_json, is_html, endpoint)
        except (asyncio.TimeoutError, BrokenProcessPool):
            return ""

    try:
        texts = await asyncio.wait_for(asyncio.gather(*(one(e) for e in data_endpoints(findings, url))), nav.asset_budget())
    except asyncio.TimeoutError:
        return ""
    return clean_text(" ".join(t for t in texts if t))


def _word_count(text: str) -> int:
    return len(re.findall(r"\w+", text))


async def _investigate(snap: PageSnapshot, nav: _Navigation) -> None:
    url = normalise_url(snap.url)
    initiator: str | None = None
    user_activated = True
    for _ in range(config.MAX_REDIRECTS + 1):
        nav.visited.add(url.split("#")[0])
        with nav.phase("document"):
            raw = await nav.get(url, "document", initiator=initiator, cap=config.FETCH_TIMEOUT_S,
                                max_bytes=MAX_HTML_BYTES, user_activated=user_activated)
        nav.timings["dns"] = nav.timings.get("dns", 0.0) + raw.dns_ms
        snap.final_url, snap.status, snap.headers = url, raw.status, raw.headers
        snap.tls_error = snap.tls_error or raw.tls_error
        if raw.error and raw.status is None and url.startswith("https://") and not snap.redirect_chain \
                and not snap.url.lower().startswith("https://") and not raw.error.startswith("refused"):
            url = "http://" + url[len("https://"):]
            continue
        if raw.error:
            snap.error = raw.error
            return
        location = raw.headers.get("location")
        if raw.status in (301, 302, 303, 307, 308) and location:
            nav.hop(raw, "http")
            url = normalise_url(urljoin(url, location.strip()))
            continue
        if not looks_like_html(raw):
            snap.error = f"not html: {raw.content_type or 'unknown content type'}"
            return

        with nav.phase("parse"):
            html = decode_body(raw.body, raw.content_type)
            try:
                page = await _offload("document", parse_html, html, url)
            except (asyncio.TimeoutError, BrokenProcessPool) as exc:
                snap.html = html
                snap.error = f"analysis: page could not be parsed within budget ({type(exc).__name__})"
                return
        inline = asyncio.create_task(_inline_analysis(page, url))
        target = None
        # Only a possible redirector needs its inline scripts read before deciding where to go;
        # on a content page they are analysed while the sub-resources download.
        if page.meta_refresh or page.visible_chars < LIGHT_PAGE_CHARS:
            with nav.phase("inline_js"):
                await inline
            target = _client_redirect(page, inline.result()[0], url)
        if target is None:
            external, external_injected = [], []
            if nav.assets:
                with nav.phase("assets"):
                    external, external_injected, snap.favicon_hash = await _assets(nav, page, url)
            with nav.phase("inline_js"):
                findings, injected = await inline
            findings, injected = findings + external, injected + external_injected
            target = _client_redirect(page, findings, url)
            if target is None:
                await _finish(snap, nav, page, html, findings, injected, url)
                return
        else:
            findings, injected = inline.result()
        next_url, via = target
        if next_url.split("#")[0] in nav.visited:
            await _finish(snap, nav, page, html, findings, injected, url)
            return
        nav.hop(raw, via)
        initiator, user_activated = url, False
        url = normalise_url(next_url)
    snap.error = f"too many redirects (>{config.MAX_REDIRECTS})"


def _asks_secrets(form: FormInfo) -> bool:
    return form.asks_password or form.asks_card or form.asks_otp or form.asks_national_id


_CHALLENGE = re.compile(
    r"<title>\s*(?:just a moment|attention required|checking your browser|ddos-guard|please wait while we verify)"
    r"|/cdn-cgi/challenge-platform/|captcha-delivery\.com|_Incapsula_Resource|sgcaptcha|/_sec/cp_challenge",
    re.I,
)


async def _inline_analysis(page: ParsedPage, url: str) -> tuple[list[ScriptFinding], list[str]]:
    try:
        return await _offload("document", _inline_scripts, page, url)
    except (asyncio.TimeoutError, BrokenProcessPool):
        return [], []


async def _finish(snap: PageSnapshot, nav: _Navigation, page: ParsedPage, html: str,
                  findings: list[ScriptFinding], injected: list[str], url: str) -> None:
    text = page.text
    forms = list(page.forms)
    # Forms a script would inject (often behind a cloaking gate) are what the victim ends up seeing.
    if injected:
        try:
            hidden_forms, hidden_text = await _offload("document", _injected_forms, injected, url)
        except (asyncio.TimeoutError, BrokenProcessPool):
            hidden_forms, hidden_text = [], ""
        forms += hidden_forms
        text = clean_text(f"{text} {hidden_text}")
    if _word_count(text) < SHELL_WORDS and (page.script_srcs or page.inline_scripts):
        if nav.assets:
            with nav.phase("recover"):
                text = clean_text(f"{text} {await _recover_content(nav, findings, url)}")
        snap.needs_js = _word_count(text) < SHELL_WORDS
    # A bot-protection interstitial is inconclusive, not benign: the real page needs a browser.
    snap.needs_js = snap.needs_js or bool(_CHALLENGE.search(html[:200_000]))
    page_host = host_of(url)
    flagged_hosts = {c.rsplit(":", 1)[1] for f in findings for c in f.suspicious_calls if ":" in c}
    script_hosts = sorted({h for h in map(host_of, page.script_srcs) if h and not same_site(h, page_host)})
    snap.html = html
    snap.title = page.title
    snap.text = text[:MAX_TEXT_CHARS]
    snap.lang = page.lang if text == page.text else detect_language(f"{page.title} {text}", page.declared_lang)
    snap.links = page.links
    snap.forms = forms
    snap.scripts = findings
    snap.iframes = page.iframes
    snap.external_hosts = sorted(set(page.external_hosts) | flagged_hosts)
    try:
        snap.content_hash = await _offload("document", hashing.content_hash, snap.text)
    except (asyncio.TimeoutError, BrokenProcessPool):
        snap.content_hash = None
    snap.structure_hash = page.structure_hash
    snap.kit_hash = hashing.kit_hash(
        [urlsplit(f.action).path for f in forms],
        [n for f in forms for n in f.input_names],
        script_hosts,
    )


async def fetch_page(url: str, *, profile: str = "mobile", referer: str | None = None) -> PageSnapshot:
    """Fetch `url` as a person's browser (`mobile` Android Chrome or `desktop` Windows Chrome) would.

    `redirect_chain` lists every URL that sent us onward, with how it did so (`http`, `meta`, `js`,
    or `shortener` for known shortener hosts); the page finally shown is `final_url`. Never raises.
    `timings_ms` breaks the wall time down by phase (dns is part of document).
    """
    return await _snapshot(url, profile, referer, assets=True, budget=SNAPSHOT_BUDGET_S)


async def _snapshot(url: str, profile: str, referer: str | None, *, assets: bool, budget: float) -> PageSnapshot:
    started = time.perf_counter()
    snap = PageSnapshot(url=url, final_url=url)
    if profile not in PROFILES:
        snap.error = f"unknown profile {profile!r}"
        return snap
    nav = _Navigation(profile, referer, assets, budget)
    try:
        await asyncio.wait_for(_investigate(snap, nav), budget + 1)
    except asyncio.TimeoutError:
        snap.error = f"timeout: page budget of {budget:.0f}s exceeded"
    except Exception as exc:
        snap.error = f"{type(exc).__name__}: {exc}"[:300]
    snap.redirect_chain = nav.chain
    snap.elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    snap.timings_ms = {k: round(v, 1) for k, v in nav.timings.items()} | {"total": snap.elapsed_ms}
    return snap


def _sensitive(snap: PageSnapshot) -> bool:
    return any(_asks_secrets(f) for f in snap.forms)


def _normal_page(snap: PageSnapshot) -> bool:
    """A real 2xx page (redirects followed), not an error, refusal or bot-protection challenge."""
    return (
        snap.error is None and snap.status is not None and 200 <= snap.status < 300
        and not _CHALLENGE.search(snap.html[:200_000])
    )


def _compare(a: PageSnapshot, b: PageSnapshot) -> dict:
    content = hashing.hamming(a.content_hash, b.content_hash)
    structure = hashing.hamming(a.structure_hash, b.structure_hash)
    limit = 3 * config.HASH_SAME_PAGE_DISTANCE
    comparable = _normal_page(a) and _normal_page(b)
    return {
        "comparable": comparable,
        "same_final_url": a.final_url == b.final_url,
        "same_final_site": site_of(host_of(a.final_url)) == site_of(host_of(b.final_url)),
        "same_status": a.status == b.status,
        "content_distance": content,
        "structure_distance": structure,
        "materially_different": comparable and content > limit and structure > limit // 2,
    }


def _differences(browser: PageSnapshot, other: PageSnapshot, comparison: dict, who: str) -> list[str]:
    """Signals that `other` was served a different page than the phone user; only between two real pages."""
    if not comparison["comparable"]:
        return []
    signals = []
    if not comparison["same_final_site"]:
        signals.append(f"different_final_site_for_{who}")
    if comparison["materially_different"]:
        signals.append(f"different_content_for_{who}")
    # Only when the HTML itself differs: the views may have been analysed to different depths.
    if _sensitive(browser) and not _sensitive(other) and comparison["structure_distance"] > config.HASH_SAME_PAGE_DISTANCE:
        signals.append(f"credential_form_hidden_from_{who}")
    return signals


def _view(snap: PageSnapshot) -> dict:
    return {
        "final_url": snap.final_url,
        "status": snap.status,
        "title": snap.title,
        "text_chars": len(snap.text),
        "redirects": [f"{h.via}:{h.url}" for h in snap.redirect_chain],
        "sensitive_form": _sensitive(snap),
        "content_hash": snap.content_hash,
        "structure_hash": snap.structure_hash,
        "error": snap.error,
        "elapsed_ms": snap.elapsed_ms,
    }


async def cloaking_probe(url: str, *, mobile: PageSnapshot | None = None) -> dict:
    """Fetch `url` as a referred phone user, a desktop user and an obvious bot, and compare the views.

    Pass the caller's existing mobile snapshot as `mobile` to skip refetching it. The other identities
    fetch documents only (redirects followed, inline scripts analysed), which keeps the probe fast.

    Cloaking means the bot and the phone user both got a real page (redirects followed) and the
    destination site, content or credential form differs materially. A bot that is merely refused,
    challenged or rate-limited is ordinary bot protection (`bot_protection`), which real banks use.
    `verdict` is one of `cloaking`, `bot_protection`, `device_specific`, `consistent`, `error`.
    """
    views = [_snapshot(url, profile, None, assets=False, budget=PROBE_BUDGET_S) for profile in ("desktop", "crawler")]
    if mobile is None:
        views.append(_snapshot(url, "mobile", PROBE_REFERER, assets=False, budget=PROBE_BUDGET_S))
    desktop, crawler, *fetched = await asyncio.gather(*views)
    browser = mobile or fetched[0]
    vs_crawler = _compare(browser, crawler)
    vs_desktop = _compare(browser, desktop)
    browser_ok = _normal_page(browser)
    bot_protection = browser_ok and not _normal_page(crawler)
    signals = ["crawler_refused_or_challenged"] if bot_protection else []
    signals += _differences(browser, crawler, vs_crawler, "crawler") if browser_ok else []
    signals += _differences(browser, desktop, vs_desktop, "desktop") if browser_ok else []
    if not browser_ok:
        verdict = "error"
    elif any(s.endswith("_crawler") for s in signals):
        verdict = "cloaking"
    elif bot_protection:
        verdict = "bot_protection"
    elif any(s.endswith("_desktop") for s in signals):
        verdict = "device_specific"
    else:
        verdict = "consistent"
    return {
        "url": url,
        "verdict": verdict,
        "cloaking": verdict == "cloaking",
        "bot_protection": bot_protection,
        "signals": signals,
        "views": {"mobile_referred": _view(browser), "desktop": _view(desktop), "crawler": _view(crawler)},
        "comparisons": {"mobile_vs_crawler": vs_crawler, "mobile_vs_desktop": vs_desktop},
    }
