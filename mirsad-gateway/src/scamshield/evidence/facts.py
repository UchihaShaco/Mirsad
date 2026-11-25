"""Live lookups that complete a verdict's facts for the case file: RDAP, DNS and the TLS certificate.

Every lookup is bounded in time and returns what it could find plus an error string; none raises.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import ipaddress
import re
import socket
import ssl
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

import httpx
import tldextract
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import ExtensionOID, NameOID

from ..schemas import Verdict

GST = timezone(timedelta(hours=4), "GST")  # the UAE observes no daylight saving
LOOKUP_TIMEOUT_S = 8.0
USER_AGENT = "ScamShield-Evidence/0.1"
RDAP_BOOTSTRAP = "https://rdap.org"
AE_WHOIS = "whois.aeda.net.ae"

_extract = tldextract.TLDExtract(suffix_list_urls=())
_URL_PARTS = re.compile(r"^(?:([A-Za-z][A-Za-z0-9+.-]*)://)?([^/?#]*)(.*)$", re.S)


def defang(url: str | None) -> str:
    """`https://a.example.com/x` -> `hxxps://a[.]example[.]com/x`, safe to paste into any document."""
    if not url:
        return ""
    match = _URL_PARTS.match(url)
    scheme, host, rest = match.group(1), match.group(2), match.group(3)
    host = host.replace(".", "[.]")
    if scheme is None:
        return host + rest
    if scheme.lower() in ("http", "https"):
        scheme = "hxxp" + scheme[4:]
    return f"{scheme}://{host}{rest}"


def to_gst(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(GST)


def target_host(verdict: Verdict) -> str:
    if verdict.host:
        return verdict.host.lower()
    for url in (verdict.final_url, verdict.url):
        if url:
            host = urlsplit(url if "://" in url else f"http://{url}").hostname
            if host:
                return host.lower()
    return ""


def registered_domain(verdict: Verdict, host: str) -> str:
    if verdict.registered_domain:
        return verdict.registered_domain.lower()
    if verdict.domain and verdict.domain.registered_domain:
        return verdict.domain.registered_domain.lower()
    parts = _extract(host)
    return parts.registered_domain or host


@dataclass
class Registration:
    raw: dict[str, Any] = field(default_factory=dict)
    source: str = ""
    registrar: str | None = None
    registrar_iana_id: str | None = None
    registrar_abuse_emails: list[str] = field(default_factory=list)
    created: datetime | None = None
    expires: datetime | None = None
    registrant: str | None = None
    registrant_country: str | None = None
    nameservers: list[str] = field(default_factory=list)
    status: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class Network:
    ip: str
    name: str | None = None
    handle: str | None = None
    country: str | None = None
    range: str | None = None
    abuse_emails: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass
class Certificate:
    subject: str | None = None
    issuer: str | None = None
    not_before: datetime | None = None
    not_after: datetime | None = None
    sans: list[str] = field(default_factory=list)
    serial: str | None = None
    sha256: str | None = None
    pem: str | None = None
    error: str | None = None


def _vcard(entity: dict, key: str) -> list[Any]:
    card = entity.get("vcardArray") or []
    if len(card) < 2 or not isinstance(card[1], list):
        return []
    return [item for item in card[1] if isinstance(item, list) and len(item) >= 4 and item[0] == key]


def _vcard_name(entity: dict) -> str | None:
    for item in _vcard(entity, "fn"):
        if isinstance(item[3], str) and item[3].strip():
            return item[3].strip()
    return None


def _vcard_country(entity: dict) -> str | None:
    for item in _vcard(entity, "adr"):
        params = item[1] if isinstance(item[1], dict) else {}
        if params.get("cc"):
            return str(params["cc"]).upper()
        value = item[3]
        if isinstance(value, list) and value and isinstance(value[-1], str) and value[-1].strip():
            return value[-1].strip()
    return None


def _abuse_emails(entities: list[dict]) -> list[str]:
    emails: list[str] = []
    for entity in entities or []:
        if "abuse" in (entity.get("roles") or []):
            for item in _vcard(entity, "email"):
                email = item[3].strip() if isinstance(item[3], str) else ""
                if email and email not in emails:
                    emails.append(email)
        for email in _abuse_emails(entity.get("entities") or []):
            if email not in emails:
                emails.append(email)
    return emails


def _parse_date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_rdap_domain(raw: dict[str, Any]) -> Registration:
    reg = Registration(raw=raw)
    for event in raw.get("events") or []:
        action = event.get("eventAction")
        if action == "registration":
            reg.created = _parse_date(event.get("eventDate"))
        elif action == "expiration":
            reg.expires = _parse_date(event.get("eventDate"))
    reg.nameservers = [ns["ldhName"].lower() for ns in raw.get("nameservers") or [] if ns.get("ldhName")]
    reg.status = [str(s) for s in raw.get("status") or []]
    for entity in raw.get("entities") or []:
        roles = entity.get("roles") or []
        if "registrar" in roles:
            reg.registrar = _vcard_name(entity) or entity.get("handle")
            reg.registrar_abuse_emails = _abuse_emails([entity])
            reg.registrar_iana_id = next(
                (str(p.get("identifier")) for p in entity.get("publicIds") or [] if "IANA" in str(p.get("type"))),
                None,
            )
        if "registrant" in roles and not reg.registrant_country:
            reg.registrant_country = _vcard_country(entity)
    if not reg.registrar_abuse_emails:
        reg.registrar_abuse_emails = _abuse_emails(raw.get("entities") or [])
    return reg


def parse_rdap_ip(ip: str, raw: dict[str, Any]) -> Network:
    start, end = raw.get("startAddress"), raw.get("endAddress")
    return Network(
        ip=ip,
        name=raw.get("name"),
        handle=raw.get("handle"),
        country=raw.get("country"),
        range=f"{start} - {end}" if start and end else None,
        abuse_emails=_abuse_emails(raw.get("entities") or []),
        raw=raw,
    )


async def _rdap(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    response = await client.get(f"{RDAP_BOOTSTRAP}/{path}", headers={"Accept": "application/rdap+json"})
    response.raise_for_status()
    return response.json()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=LOOKUP_TIMEOUT_S, follow_redirects=True, headers={"User-Agent": USER_AGENT}
    )


async def registration(domain: str) -> Registration:
    """Registration record from the intel component if it offers one, else a direct RDAP lookup."""
    if not domain:
        return Registration(error="no domain to look up")
    errors: list[str] = []
    try:
        from ..intel.domain import raw_registration  # type: ignore[attr-defined]
    except Exception:
        raw_registration = None
    if raw_registration is not None:
        try:
            raw = raw_registration(domain)
            if inspect.isawaitable(raw):
                raw = await asyncio.wait_for(raw, LOOKUP_TIMEOUT_S * 2)
            if isinstance(raw, dict) and raw:
                reg = parse_rdap_domain(raw)
                reg.source = "scamshield.intel.domain.raw_registration"
                return reg
            errors.append("intel registration lookup returned nothing")
        except Exception as exc:
            errors.append(f"intel registration lookup failed: {exc!r}")
    if domain.endswith(".ae"):  # .ae has no RDAP service; AEDA answers on port 43
        try:
            text = await _whois43(AE_WHOIS, domain)
        except Exception as exc:
            errors.append(f"WHOIS {AE_WHOIS}: {exc!r}")
            return Registration(source=f"whois:{AE_WHOIS}", error="; ".join(errors))
        return parse_whois_text(text, AE_WHOIS)
    try:
        async with _client() as client:
            raw = await _rdap(client, f"domain/{domain}")
    except Exception as exc:
        errors.append(f"RDAP: {exc!r}")
        return Registration(source="rdap", error="; ".join(errors))
    reg = parse_rdap_domain(raw)
    reg.source = "rdap"
    return reg


async def _whois43(server: str, query: str) -> str:
    async def ask() -> bytes:
        reader, writer = await asyncio.open_connection(server, 43)
        try:
            writer.write(query.encode("idna") + b"\r\n")
            await writer.drain()
            return await reader.read(256 * 1024)
        finally:
            writer.close()

    return (await asyncio.wait_for(ask(), LOOKUP_TIMEOUT_S)).decode("utf-8", errors="replace")


def parse_whois_text(text: str, server: str) -> Registration:
    fields: dict[str, list[str]] = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if sep and value.strip():
            fields.setdefault(key.strip().lower(), []).append(value.strip())

    def first(*keys: str) -> str | None:
        return next((fields[k][0] for k in keys if k in fields), None)

    return Registration(
        raw={"whois_server": server, "text": text},
        source=f"whois:{server}",
        registrar=first("registrar name", "registrar"),
        registrar_iana_id=first("registrar iana id"),
        registrar_abuse_emails=fields.get("registrar abuse contact email", []),
        created=_parse_date(first("creation date", "created")),
        expires=_parse_date(first("registry expiry date", "expiration date")),
        registrant_country=first("registrant country"),
        registrant=first("registrant", "registrant organization"),
        nameservers=[ns.lower() for ns in fields.get("name server", [])],
        status=fields.get("status", []) or fields.get("domain status", []),
    )


# Contacts that RDAP returns for address space nobody publicly operates: never a hosting provider to write to.
PLACEHOLDER_ABUSE = re.compile(r"@(iana\.org|arin\.net|ripe\.net|apnic\.net|lacnic\.net|afrinic\.net)$", re.I)
PLACEHOLDER_NETWORK = re.compile(r"PRIVATE|RFC1918|RFC6598|IANA-RESERVED|SPECIAL|LOOPBACK|LINKLOCAL|RESERVED|CGNAT", re.I)


def is_public_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def usable_abuse(emails: list[str]) -> list[str]:
    """Abuse addresses worth writing to: registries of last resort and placeholders are dropped."""
    return [e for e in emails if not PLACEHOLDER_ABUSE.search(e.strip())]


def is_placeholder_network(net: Network) -> bool:
    return not is_public_ip(net.ip) or bool(net.name and PLACEHOLDER_NETWORK.search(net.name))


async def networks(ips: list[str]) -> list[Network]:
    async def one(client: httpx.AsyncClient, ip: str) -> Network:
        if not is_public_ip(ip):
            return Network(ip=ip, error="private or reserved address: no public hosting record")
        try:
            return parse_rdap_ip(ip, await _rdap(client, f"ip/{ip}"))
        except Exception as exc:
            return Network(ip=ip, error=f"RDAP: {exc!r}")

    if not ips:
        return []
    async with _client() as client:
        return list(await asyncio.gather(*(one(client, ip) for ip in ips[:4])))


async def resolve(host: str) -> list[str]:
    if not host:
        return []
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM), 5)
    except Exception:
        return []
    ips: list[str] = []
    for info in infos:
        ip = info[4][0]
        if ip not in ips:
            ips.append(ip)
    return ips


def _name(name: x509.Name) -> str:
    parts = []
    for oid in (NameOID.COMMON_NAME, NameOID.ORGANIZATION_NAME, NameOID.COUNTRY_NAME):
        parts += [f"{attr.oid._name}={attr.value}" for attr in name.get_attributes_for_oid(oid)]
    return ", ".join(parts) or name.rfc4514_string()


def _fetch_certificate(host: str) -> Certificate:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # we record whatever the site presents, valid or not
    with socket.create_connection((host, 443), timeout=5) as sock:
        with context.wrap_socket(sock, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    return certificate_from_der(der)


def certificate_from_pem(pem: str) -> Certificate:
    """A certificate recorded in an earlier capture, read back for a rebuilt report."""
    cert = x509.load_pem_x509_certificate(pem.encode())
    return certificate_from_der(cert.public_bytes(serialization.Encoding.DER))


def registration_from_raw(raw: dict[str, Any]) -> tuple[Registration, list[Network]]:
    """Registration and network records from an earlier capture's `registration_raw.json`."""
    source = raw.get("source") or ""
    record = raw.get("record") or {}
    if source.startswith("whois:") and isinstance(record, dict) and "text" in record:
        reg = parse_whois_text(record["text"], record.get("whois_server", source[6:]))
    elif record:
        reg = parse_rdap_domain(record)
        reg.source = source
    else:
        reg = Registration(source=source)
    reg.error = raw.get("error")
    nets = [parse_rdap_ip(n["ip"], n["record"]) if n.get("record") else Network(ip=n["ip"], error=n.get("error"))
            for n in raw.get("networks") or []]
    return reg, nets


def certificate_from_der(der: bytes) -> Certificate:
    cert = x509.load_der_x509_certificate(der)
    try:
        sans = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        names = sans.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        names = []
    return Certificate(
        subject=_name(cert.subject),
        issuer=_name(cert.issuer),
        not_before=cert.not_valid_before_utc,
        not_after=cert.not_valid_after_utc,
        sans=list(names),
        serial=format(cert.serial_number, "x"),
        sha256=hashlib.sha256(der).hexdigest(),
        pem=cert.public_bytes(serialization.Encoding.PEM).decode(),
    )


async def certificate(host: str) -> Certificate:
    if not host:
        return Certificate(error="no host")
    try:
        return await asyncio.wait_for(asyncio.to_thread(_fetch_certificate, host), 7)
    except Exception as exc:
        return Certificate(error=f"TLS: {exc!r}")
