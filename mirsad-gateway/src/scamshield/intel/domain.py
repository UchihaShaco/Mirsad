"""Domain intelligence: DNS, registration (RDAP / WHOIS), IP -> ASN, TLS certificate, plus local reputation.

Every lookup runs concurrently under its own timeout and never raises: failures land in
`DomainIntel.errors`. Results are cached per component (memory + SQLite at data/intel_cache.db).
`fast=True` uses only local data, cached components and a DNS lookup, all within ~270 ms.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import sqlite3
import ssl
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import dns.asyncresolver
import dns.exception
import dns.resolver
import dns.reversename
import httpx
from cryptography import x509
from cryptography.x509.oid import ExtensionOID, NameOID

from scamshield.config import DATA_DIR
from scamshield.intel import reputation as rep
from scamshield.intel.hosts import parse
from scamshield.schemas import DomainIntel

CACHE_DB = DATA_DIR / "intel_cache.db"
RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
RDAP_BOOTSTRAP_FILE = rep.FEEDS_DIR / "rdap_dns.json"
USER_AGENT = "scamshield-intel/0.1"

TTL = {"dns": 3600, "reg": 86400, "asn": 86400, "tls": 6 * 3600, "whois_server": 7 * 86400}
ERROR_TTL = 600
TIMEOUT = {"dns": 1.5, "reg": 4.0, "asn": 2.5, "tls": 3.0, "total": 6.0}
FAST_BUDGET = 0.27  # seconds for the whole fast assessment; DNS gets whatever is left

# ccTLD registries without RDAP, queried over WHOIS port 43. Others are discovered via whois.iana.org.
WHOIS_SERVERS = {"ae": "whois.aeda.net.ae"}
# aeDA blacklists clients that query too fast: one query at a time, at least this many seconds apart.
WHOIS_MIN_INTERVAL = {"whois.aeda.net.ae": 2.0}


# --- cache ------------------------------------------------------------------------------------

class _Cache:
    def __init__(self, path: Path):
        self.path = path
        self.memory: dict[str, tuple[float, Any]] = {}
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()
        self._failed = False

    def _db(self) -> sqlite3.Connection | None:
        if self._conn is None and not self._failed:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._conn = sqlite3.connect(self.path, check_same_thread=False, timeout=1)
                self._conn.execute("PRAGMA journal_mode=WAL")
                self._conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, expires REAL, value TEXT)")
            except sqlite3.Error:
                self._failed = True
        return self._conn

    def get(self, key: str) -> Any | None:
        now = time.time()
        hit = self.memory.get(key)
        if hit and hit[0] > now:
            return hit[1]
        with self._lock:
            db = self._db()
            if db is None:
                return None
            try:
                row = db.execute("SELECT expires, value FROM kv WHERE key = ?", (key,)).fetchone()
            except sqlite3.Error:
                return None
        if not row or row[0] <= now:
            return None
        value = json.loads(row[1])
        self.memory[key] = (row[0], value)
        return value

    def set(self, key: str, value: Any, ttl: float) -> None:
        expires = time.time() + ttl
        self.memory[key] = (expires, value)
        with self._lock:
            db = self._db()
            if db is None:
                return
            try:
                db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)", (key, expires, json.dumps(value, default=str)))
                db.commit()
            except sqlite3.Error:
                pass


_cache = _Cache(CACHE_DB)


async def _cached(kind: str, key: str, producer, timeout: float) -> tuple[Any | None, str | None]:
    """Return (value, error). Errors are cached briefly so a dead server is not hammered."""
    cache_key = f"{kind}:{key}"
    hit = _cache.get(cache_key)
    if hit is not None:
        return (None, hit["error"]) if isinstance(hit, dict) and "error" in hit and len(hit) == 1 else (hit, None)
    try:
        value = await asyncio.wait_for(producer(), timeout)
    except asyncio.TimeoutError:
        return None, f"{kind}: timeout after {timeout:.1f}s"
    except Exception as exc:  # network code: any failure becomes an error string, never an exception
        error = f"{kind}: {type(exc).__name__}: {exc}"[:300]
        if not isinstance(exc, (dns.exception.Timeout, httpx.TimeoutException, TimeoutError)):
            _cache.set(cache_key, {"error": error}, ERROR_TTL)  # definitive failures only; timeouts are retried
        return None, error
    _cache.set(cache_key, value, TTL[kind])
    return value, None


# --- DNS --------------------------------------------------------------------------------------

def _resolver(timeout: float) -> dns.asyncresolver.Resolver:
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = timeout
    resolver.timeout = timeout
    return resolver


async def _query(resolver, name: str, rtype: str) -> list[str]:
    try:
        answer = await resolver.resolve(name, rtype)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        return []
    return sorted(r.to_text().rstrip(".").lower() for r in answer)


async def _dns(host: str, registered: str, timeout: float) -> dict:
    resolver = _resolver(timeout)
    a, aaaa, ns = await asyncio.gather(
        _query(resolver, host, "A"), _query(resolver, host, "AAAA"), _query(resolver, registered, "NS")
    )
    return {"a": a, "aaaa": aaaa, "ns": ns}


# --- IP -> ASN (Team Cymru DNS interface) -----------------------------------------------------

async def _asn(ip: str) -> dict:
    local = rep.ip_asn(ip)
    if local:
        return local
    addr = ipaddress.ip_address(ip)
    rev = dns.reversename.from_address(ip).to_text().rstrip(".")
    zone = "origin.asn.cymru.com" if addr.version == 4 else "origin6.asn.cymru.com"
    rev = rev.replace(".in-addr.arpa", "").replace(".ip6.arpa", "")
    resolver = _resolver(TIMEOUT["asn"])
    origin = await _query(resolver, f"{rev}.{zone}", "TXT")
    if not origin:
        return {"asn": None}
    fields = [f.strip() for f in origin[0].strip('"').split("|")]
    asn = int(fields[0].split()[0])
    info = {"asn": asn, "prefix": fields[1], "country": fields[2] or None, "registry": fields[3], "org": None,
            "source": "team-cymru"}
    detail = await _query(resolver, f"AS{asn}.asn.cymru.com", "TXT")
    if detail:
        info["org"] = detail[0].strip('"').split("|")[-1].strip()
    return info


# --- TLS certificate --------------------------------------------------------------------------

def _name(name: x509.Name) -> str | None:
    for oid in (NameOID.ORGANIZATION_NAME, NameOID.COMMON_NAME):
        attrs = name.get_attributes_for_oid(oid)
        if attrs:
            return str(attrs[0].value)
    return None


async def _tls(host: str) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # we want the certificate even when it is invalid
    reader, writer = await asyncio.open_connection(host, 443, ssl=ctx, server_hostname=None if _is_ip(host) else host)
    try:
        der = writer.get_extra_info("ssl_object").getpeercert(binary_form=True)
    finally:
        writer.close()
    cert = x509.load_der_x509_certificate(der)
    try:
        sans = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        sans = []
    return {
        "issuer": _name(cert.issuer),
        "subject": _name(cert.subject),
        "not_before": cert.not_valid_before_utc.isoformat(),
        "not_after": cert.not_valid_after_utc.isoformat(),
        "sans": sans[:100],
        "self_signed": cert.issuer == cert.subject,
    }


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


# --- registration: RDAP with WHOIS fallback ---------------------------------------------------

_bootstrap: dict[str, str] = {}
_whois_locks: dict[str, asyncio.Lock] = {}
_whois_last: dict[str, float] = {}


async def _rdap_base(tld: str, client: httpx.AsyncClient) -> str | None:
    if not _bootstrap:
        data = None
        if RDAP_BOOTSTRAP_FILE.exists() and time.time() - RDAP_BOOTSTRAP_FILE.stat().st_mtime < 7 * 86400:
            data = json.loads(RDAP_BOOTSTRAP_FILE.read_text())
        else:
            response = await client.get(RDAP_BOOTSTRAP_URL, timeout=3)
            response.raise_for_status()
            data = response.json()
            RDAP_BOOTSTRAP_FILE.parent.mkdir(parents=True, exist_ok=True)
            RDAP_BOOTSTRAP_FILE.write_text(json.dumps(data))
        for tlds, urls in data["services"]:
            for t in tlds:
                _bootstrap[t] = urls[0].rstrip("/") + "/"
    return _bootstrap.get(tld)


def _vcard(entity: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    card = entity.get("vcardArray") or [None, []]
    for item in card[1] if len(card) > 1 else []:
        key, params, _, value = (item + [None] * 4)[:4]
        if key == "fn":
            out["name"] = value
        elif key == "email":
            out.setdefault("email", value)
        elif key == "tel":
            out.setdefault("phone", str(value).removeprefix("tel:"))
        elif key == "adr":
            country = (params or {}).get("cc") or (value[-1] if isinstance(value, list) and value else None)
            if country:
                out["country"] = country
    return out


def _walk_entities(entities: list[dict], found: dict[str, dict]) -> None:
    for entity in entities or []:
        card = _vcard(entity)
        for role in entity.get("roles", []):
            found.setdefault(role, {**card, "handle": entity.get("handle")})
            if role == "registrar":
                ids = [p.get("identifier") for p in entity.get("publicIds", []) if "IANA" in str(p.get("type"))]
                if ids:
                    found["registrar"]["iana_id"] = ids[0]
                for sub in entity.get("entities", []):
                    if "abuse" in sub.get("roles", []):
                        found["registrar_abuse"] = _vcard(sub)
        _walk_entities(entity.get("entities", []), found)


def parse_rdap(data: dict) -> dict:
    events = {e.get("eventAction"): e.get("eventDate") for e in data.get("events", [])}
    roles: dict[str, dict] = {}
    _walk_entities(data.get("entities", []), roles)
    abuse = roles.get("registrar_abuse") or roles.get("abuse") or {}
    return {
        "created": events.get("registration"),
        "expires": events.get("expiration"),
        "updated": events.get("last changed"),
        "registrar": (roles.get("registrar") or {}).get("name"),
        "registrar_iana_id": (roles.get("registrar") or {}).get("iana_id"),
        "registrant_country": (roles.get("registrant") or {}).get("country"),
        "registrant": (roles.get("registrant") or {}).get("name"),
        "nameservers": sorted(ns.get("ldhName", "").lower() for ns in data.get("nameservers", []) if ns.get("ldhName")),
        "status": data.get("status", []),
        "abuse_email": abuse.get("email"),
        "abuse_phone": abuse.get("phone"),
    }


_WHOIS_FIELDS = {
    "created": r"(?:creation date|created(?: on)?|registered(?: on)?|registration time|domain registration date|commencement date)",
    "expires": r"(?:registry expiry date|expir(?:y|ation) date|expires(?: on)?|paid-till)",
    "registrar": r"(?:registrar(?: name)?|sponsoring registrar)",
    "registrant": r"(?:registrant(?: contact)? organi[sz]ation|registrant(?: name)?|registrant contact name)",
    "registrant_country": r"(?:registrant country|registrant contact country)",
    "abuse_email": r"registrar abuse contact email",
    "abuse_phone": r"registrar abuse contact phone",
}
_DATE_FORMATS = ("%Y-%m-%d", "%d-%b-%Y", "%Y.%m.%d", "%d/%m/%Y", "%Y/%m/%d", "%d.%m.%Y", "%Y%m%d")


def parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip().split(" (")[0]
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for fmt in _DATE_FORMATS:
            try:
                parsed = datetime.strptime(value.split()[0].split("T")[0], fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_whois(text: str) -> dict:
    out: dict[str, Any] = {}
    for field, label in _WHOIS_FIELDS.items():
        m = re.search(rf"^\s*{label}\s*:\s*(.+?)\s*$", text, re.IGNORECASE | re.MULTILINE)
        if m and m.group(1).strip():
            out[field] = m.group(1).strip()
    out["nameservers"] = sorted({
        m.group(1).lower().rstrip(".")
        for m in re.finditer(r"^\s*(?:name server|nserver|nameserver)s?\s*:\s*(\S+)", text, re.IGNORECASE | re.MULTILINE)
    })
    eligibility = re.search(r"^\s*Eligibility Type\s*:\s*(.+?)\s*$", text, re.IGNORECASE | re.MULTILINE)
    if eligibility:
        out["eligibility"] = eligibility.group(1)
    return out


async def _whois_query(server: str, query: str, timeout: float = 4.0) -> str:
    lock = _whois_locks.setdefault(server, asyncio.Lock())
    async with lock:
        wait = WHOIS_MIN_INTERVAL.get(server, 0) - (time.monotonic() - _whois_last.get(server, 0))
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(server, 43), timeout)
            writer.write(f"{query}\r\n".encode())
            await writer.drain()
            data = await asyncio.wait_for(reader.read(65536), timeout)
            writer.close()
        finally:
            _whois_last[server] = time.monotonic()
    text = data.decode("utf-8", errors="replace")
    if "BLACKLISTED" in text or "exceeded the query limit" in text:
        raise RuntimeError(f"{server} rate-limited this client")
    return text


async def _whois_server(tld: str) -> str | None:
    if tld in WHOIS_SERVERS:
        return WHOIS_SERVERS[tld]
    cached = _cache.get(f"whois_server:{tld}")
    if cached is not None:
        return cached or None
    text = await _whois_query("whois.iana.org", tld)
    m = re.search(r"^whois:\s*(\S+)", text, re.MULTILINE)
    server = m.group(1) if m else ""
    _cache.set(f"whois_server:{tld}", server, TTL["whois_server"])
    return server or None


async def _registration(domain: str) -> dict:
    tld = domain.rsplit(".", 1)[-1]
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT, "Accept": "application/rdap+json"},
                                 follow_redirects=True, timeout=3.5) as client:
        base = None
        if tld not in WHOIS_SERVERS:
            try:
                base = await _rdap_base(tld, client)
            except (httpx.HTTPError, ValueError, OSError):
                base = "https://rdap.org/"
        if base:
            response = await client.get(f"{base}domain/{domain}")
            if response.status_code == 404:
                return {"source": "rdap", "server": base, "found": False}
            response.raise_for_status()
            raw = response.json()
            return {"source": "rdap", "server": base, "found": True, **parse_rdap(raw), "raw": raw}
    server = await _whois_server(tld)
    if not server:
        return {"source": "none", "server": None, "found": False}
    text = await _whois_query(server, domain)
    found = not re.search(r"no data found|no match|not found|no entries found|status:\s*free", text, re.IGNORECASE)
    return {"source": "whois", "server": server, "found": found, **parse_whois(text), "raw": text[:20000]}


# --- public API -------------------------------------------------------------------------------

def _days_since(value: datetime | None, now: datetime) -> int | None:
    return None if value is None else max((now - value).days, 0)


def _apply(intel: DomainIntel, dns_info: dict | None, reg: dict | None, asn: dict | None, tls: dict | None) -> None:
    now = datetime.now(timezone.utc)
    if dns_info:
        intel.ips = (dns_info.get("a") or []) + (dns_info.get("aaaa") or [])
        intel.nameservers = dns_info.get("ns") or []
    if reg and reg.get("found"):
        intel.created = parse_date(reg.get("created"))
        intel.age_days = _days_since(intel.created, now)
        intel.registrar = reg.get("registrar")
        intel.registrant_country = reg.get("registrant_country")
        if not intel.nameservers:
            intel.nameservers = reg.get("nameservers") or []
    if asn and asn.get("asn"):
        intel.asn = asn["asn"]
        intel.asn_org = asn.get("org")
        intel.hosting_country = asn.get("country")
    if tls:
        intel.tls_issuer = tls.get("issuer")
        intel.tls_not_before = parse_date(tls.get("not_before"))
        intel.tls_age_days = _days_since(intel.tls_not_before, now)
        intel.tls_sans = tls.get("sans") or []


def _base_intel(url: str) -> tuple[DomainIntel, Any]:
    parts = parse(url)
    allowlisted, owner, blocklisted, sources = rep.reputation(url)
    intel = DomainIntel(
        host=parts.host,
        registered_domain=parts.registered_domain,
        tld=parts.suffix,
        is_ip=parts.is_ip,
        is_idn=parts.is_idn,
        allowlisted=allowlisted,
        allowlist_owner=owner,
        blocklisted=blocklisted,
        blocklist_sources=sources,
        popularity_rank=None if parts.is_ip else rep.popularity_rank(parts.registered_domain),
        is_shortener=rep.is_shortener(parts.host),
        is_shared_hosting=rep.shared_platform(parts.host) is not None,
    )
    return intel, parts


async def assess_domain(url: str, *, fast: bool = False) -> DomainIntel:
    """Everything known about the URL's host. Never raises."""
    started = time.perf_counter()
    try:
        intel, parts = _base_intel(url)
    except Exception as exc:  # malformed input must not break the caller
        return DomainIntel(host=str(url)[:253], registered_domain="", errors=[f"parse: {exc}"])
    if not parts.host:
        intel.errors.append("parse: no host in URL")
        return intel
    errors: list[str] = []
    host, domain = parts.host, parts.registered_domain

    if fast:
        dns_info = None if parts.is_ip else _cache.get(f"dns:{host}")
        if dns_info is None and not parts.is_ip:
            budget = max(0.05, FAST_BUDGET - (time.perf_counter() - started))
            dns_info, err = await _cached("dns", host, lambda: _dns(host, domain, budget), budget)
            if err:
                errors.append(err)
        reg = None if parts.is_ip else _cache.get(f"reg:{domain}")
        ip = host if parts.is_ip else ((dns_info or {}).get("a") or (dns_info or {}).get("aaaa") or [None])[0]
        asn = (_cache.get(f"asn:{ip}") or rep.ip_asn(ip)) if ip else None
        tls = _cache.get(f"tls:{host}")
        _apply(intel, dns_info, _ok(reg), _ok(asn), _ok(tls))
    else:
        async def dns_then_asn():
            if parts.is_ip:
                return None, None, await _cached("asn", host, lambda: _asn(host), TIMEOUT["asn"])
            dns_result = await _cached("dns", host, lambda: _dns(host, domain, TIMEOUT["dns"]), TIMEOUT["dns"] + 0.2)
            info = dns_result[0] or {}
            ip = (info.get("a") or info.get("aaaa") or [None])[0]
            asn_result = await _cached("asn", ip, lambda: _asn(ip), TIMEOUT["asn"]) if ip else (None, None)
            return dns_result, ip, asn_result

        reg_task = None if parts.is_ip else _cached("reg", domain, lambda: _registration(domain), TIMEOUT["reg"])
        tls_task = _cached("tls", host, lambda: _tls(host), TIMEOUT["tls"])
        jobs = [dns_then_asn(), tls_task] + ([reg_task] if reg_task else [])
        try:
            results = await asyncio.wait_for(asyncio.gather(*jobs, return_exceptions=True), TIMEOUT["total"])
        except asyncio.TimeoutError:
            results = []
            errors.append(f"total: exceeded {TIMEOUT['total']}s")
        dns_info = reg = asn = tls = None
        if results:
            chain, tls_result = results[0], results[1]
            if isinstance(chain, tuple):
                dns_result, _, asn_result = chain
                if dns_result:
                    dns_info = dns_result[0]
                    errors += [dns_result[1]] if dns_result[1] else []
                asn = asn_result[0]
                errors += [asn_result[1]] if asn_result[1] else []
            if isinstance(tls_result, tuple):
                tls = tls_result[0]
                errors += [tls_result[1]] if tls_result[1] else []
            if reg_task is not None and isinstance(results[2], tuple):
                reg = results[2][0]
                errors += [results[2][1]] if results[2][1] else []
                if reg and reg.get("source") == "whois" and reg.get("found") and not reg.get("created"):
                    errors.append(f"registration: {reg['server']} does not publish creation dates")
            for result in results:
                if isinstance(result, BaseException):
                    errors.append(f"internal: {type(result).__name__}: {result}"[:300])
        _apply(intel, dns_info, reg, asn, tls)
    intel.errors = errors
    intel.elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    return intel


def _ok(value: Any) -> Any:
    """Cached values may be error markers; treat those as missing."""
    return None if isinstance(value, dict) and set(value) == {"error"} else value


async def raw_registration(domain: str) -> dict:
    """Raw RDAP / WHOIS record plus registrar and hosting abuse contacts, for evidence packs."""
    parts = parse(domain)
    target = parts.registered_domain or parts.host
    out: dict[str, Any] = {"domain": target, "queried_at": datetime.now(timezone.utc).isoformat()}
    reg, err = await _cached("reg", target, lambda: _registration(target), TIMEOUT["reg"] + 2)
    if err:
        out["error"] = err
    reg = _ok(reg) or {}
    out["registration"] = {k: v for k, v in reg.items() if k != "raw"}
    out["raw"] = reg.get("raw")
    out["registrar_abuse"] = {"email": reg.get("abuse_email"), "phone": reg.get("abuse_phone")}
    dns_info, _ = await _cached("dns", parts.host, lambda: _dns(parts.host, target, TIMEOUT["dns"]), TIMEOUT["dns"] + 0.2)
    ips = ((dns_info or {}).get("a") or []) + ((dns_info or {}).get("aaaa") or [])
    hosting: dict[str, Any] = {"ips": ips}
    if ips:
        asn, _ = await _cached("asn", ips[0], lambda: _asn(ips[0]), TIMEOUT["asn"])
        hosting.update({k: v for k, v in (_ok(asn) or {}).items()})
        try:
            async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=4) as client:
                response = await client.get("https://stat.ripe.net/data/abuse-contact-finder/data.json",
                                            params={"resource": ips[0]})
                hosting["abuse_emails"] = response.json().get("data", {}).get("abuse_contacts", [])
        except (httpx.HTTPError, ValueError) as exc:
            hosting["abuse_error"] = f"{type(exc).__name__}: {exc}"[:200]
    out["hosting"] = hosting
    return out
