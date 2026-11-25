"""Host parsing shared by the intel modules: URL or host in, normalised parts out."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlsplit

import idna
import tldextract

# The bundled public-suffix snapshot: never fetch the list at runtime.
_EXTRACT = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)


@dataclass(frozen=True)
class HostParts:
    host: str  # ASCII (punycode) lower-case host without port or trailing dot
    unicode_host: str  # IDN-decoded form for display and homoglyph checks
    registered_domain: str  # ICANN registrable domain, e.g. "adcb.com"; host itself for IPs
    label: str  # registrable label without suffix, e.g. "adcb"
    suffix: str  # public suffix, e.g. "com", "gov.ae"
    subdomain: str  # e.g. "www"
    is_ip: bool
    is_idn: bool
    path: str  # URL path and query, "" when a bare host was given


def split_url(value: str) -> tuple[str, str]:
    """Return (host, path+query) from a URL, a host or a host with a path."""
    value = value.strip()
    if "://" not in value:
        value = "http://" + value
    parts = urlsplit(value)
    host = (parts.hostname or "").rstrip(".").lower()
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    return host, "" if path == "/" else path


def to_ascii(host: str) -> str:
    if host.isascii():
        return host
    try:
        return idna.encode(host, uts46=True).decode()
    except idna.IDNAError:
        return host.encode("idna", errors="ignore").decode() if host else host


def to_unicode(host: str) -> str:
    if "xn--" not in host:
        return host
    try:
        return idna.decode(host)
    except idna.IDNAError:
        try:
            return host.encode().decode("idna")
        except UnicodeError:
            return host


@lru_cache(maxsize=65536)
def _parse_host(host: str) -> tuple[str, str, str, str, str, bool]:
    try:
        ipaddress.ip_address(host.strip("[]"))
        return host, host, host, "", "", True
    except ValueError:
        pass
    ext = _EXTRACT(host, include_psl_private_domains=False)
    registered = ext.top_domain_under_public_suffix or host
    return host, to_unicode(host), registered, ext.domain, ext.suffix, False


def parse(value: str) -> HostParts:
    host, path = split_url(value)
    host = to_ascii(host)
    host, uni, registered, label, suffix, is_ip = _parse_host(host)
    sub = host[: -len(registered)].rstrip(".") if not is_ip and host.endswith(registered) else ""
    return HostParts(
        host=host,
        unicode_host=uni,
        registered_domain=registered,
        label=label,
        suffix=suffix,
        subdomain=sub,
        is_ip=is_ip,
        is_idn="xn--" in host,
        path=path,
    )


def parents(host: str):
    """Yield the host and each parent domain: a.b.c -> a.b.c, b.c, c."""
    while host:
        yield host
        _, _, host = host.partition(".")
