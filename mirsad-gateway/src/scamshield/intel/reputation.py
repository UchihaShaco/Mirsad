"""Local reputation lookups: verified allowlist, phishing blocklists, popularity, publishing platforms.

Everything here is in-process and sub-millisecond. The curated lists ship with the package
(`intel/data/*.json`); downloaded feeds live in `data/feeds/feeds.db`, built by
`python -m scamshield.intel.feeds update`. A missing feed database simply means no blocklist
hits and no popularity ranks. `config.USE_BLOCKLISTS = False` (env SCAMSHIELD_BLOCKLISTS=0), read at
call time, turns off blocklist hits only, e.g. to benchmark detection on URLs the feeds already list.
"""

from __future__ import annotations

import ipaddress
import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from scamshield import config
from scamshield.config import DATA_DIR
from scamshield.intel import lists
from scamshield.intel.hosts import parents, parse

PKG_DATA = lists.DATA_DIR
FEEDS_DIR = DATA_DIR / "feeds"
FEEDS_DB = FEEDS_DIR / "feeds.db"


@dataclass(frozen=True)
class Registry:
    official: dict[str, str]  # domain or host -> owner
    official_brand: dict[str, str]  # domain or host -> brand id
    suffix_rules: dict[str, str]  # e.g. "gov.ae" -> owner
    subdomain_platforms: frozenset[str]
    path_platforms: frozenset[str]
    shorteners: frozenset[str]
    risky_tlds: dict[str, float]


@lru_cache(maxsize=1)
def registry() -> Registry:
    brands = json.loads((PKG_DATA / "brands.json").read_text(encoding="utf-8"))["brands"]
    extra = json.loads((PKG_DATA / "allowlist.json").read_text(encoding="utf-8"))
    platforms = json.loads((PKG_DATA / "platforms.json").read_text(encoding="utf-8"))
    official: dict[str, str] = dict(extra["domains"])
    official_brand: dict[str, str] = {}
    for brand in brands:
        for domain in brand["domains"]:
            official[domain] = brand["name_en"]
            official_brand[domain] = brand["id"]
    return Registry(
        official=official,
        official_brand=official_brand,
        suffix_rules=dict(extra["suffix_rules"]),
        subdomain_platforms=frozenset(platforms["subdomain"]),
        path_platforms=frozenset(platforms["path"]),
        shorteners=frozenset(platforms["shorteners"]),
        risky_tlds=lists.mapping("tlds", "risky_tlds"),
    )


def _first_parent_in(host: str, keys) -> str | None:
    for candidate in parents(host):
        if candidate in keys:
            return candidate
    return None


def shared_platform(host: str) -> str | None:
    """The publishing platform a host belongs to (e.g. "weebly.com", "sites.google.com"), if any."""
    reg = registry()
    if host in reg.path_platforms:
        return host
    for candidate in parents(host):
        if candidate in reg.subdomain_platforms or candidate in reg.path_platforms:
            return candidate
    return None


def is_shortener(host: str) -> bool:
    return _first_parent_in(host, registry().shorteners) is not None


def official_owner(host: str) -> str | None:
    """Owner of a verified official domain, ignoring platform rules (used for brand ownership)."""
    reg = registry()
    match = _first_parent_in(host, reg.official)
    if match:
        return reg.official[match]
    suffix = _first_parent_in(host, reg.suffix_rules)
    if suffix and host != suffix:
        return reg.suffix_rules[suffix]
    return None


def official_brand_id(host: str) -> str | None:
    reg = registry()
    match = _first_parent_in(host, reg.official_brand)
    return reg.official_brand[match] if match else None


def allowlist_owner(host: str) -> str | None:
    """Verified owner when the host is an official site. Platforms and shorteners never qualify,
    because anyone can publish under them (sites.google.com, contoso.sharepoint.com, bit.ly)."""
    if shared_platform(host) or is_shortener(host):
        return None
    return official_owner(host)


def tld_risk(tld: str) -> float:
    """0..1 weight for TLDs over-represented in phishing (".icu", ".top", ...); 0 when unremarkable."""
    return registry().risky_tlds.get(tld.rsplit(".", 1)[-1], 0.0)


class _FeedStore:
    """Read-only view of feeds.db, reopened when `feeds update` replaces the file."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._mtime = 0.0
        self._checked = 0.0

    def _connection(self) -> sqlite3.Connection | None:
        now = time.monotonic()
        if now - self._checked < 30 and (self._conn or self._checked):
            return self._conn
        self._checked = now
        try:
            mtime = os.stat(self.path).st_mtime
        except OSError:
            self._conn = None
            return None
        if self._conn is None or mtime != self._mtime:
            if self._conn is not None:
                self._conn.close()
            self._conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
            self._mtime = mtime
        return self._conn

    def query(self, sql: str, args: tuple) -> list[tuple]:
        with self._lock:
            conn = self._connection()
            if conn is None:
                return []
            try:
                return conn.execute(sql, args).fetchall()
            except sqlite3.Error:
                return []


_store = _FeedStore(FEEDS_DB)


def _normalise_url(url: str) -> str:
    url = url.split("#", 1)[0].strip()
    if "://" not in url:
        url = "http://" + url
    scheme, _, rest = url.partition("://")
    host, slash, path = rest.partition("/")
    return f"{host.lower()}{slash}{path}".rstrip("/")


def host_blocklist(host: str) -> list[str]:
    """Feeds that list this host or a parent of it (down to its registrable domain, or to the user's own
    label on a publishing platform). Shorteners and path-based platforms (bit.ly, sites.google.com) never
    match at host level: there only the exact URL can be listed, see `url_blocklist`."""
    parts = parse(host)
    if not config.USE_BLOCKLISTS or not parts.host or is_shortener(parts.host):
        return []
    platform = shared_platform(parts.host)
    if platform == parts.host:
        return []
    floor = platform or parts.registered_domain
    candidates = []
    for candidate in parents(parts.host):
        if candidate == platform:
            break
        candidates.append(candidate)
        if candidate == floor:
            break
    marks = ",".join("?" * len(candidates))
    sources: set[str] = set()
    for (src,) in _store.query(f"SELECT sources FROM hosts WHERE host IN ({marks})", tuple(candidates)):
        sources.update(src.split(","))
    return sorted(sources)


def url_blocklist(url: str) -> list[str]:
    """Feeds that list this exact URL (scheme and fragment ignored, trailing slash ignored)."""
    if not config.USE_BLOCKLISTS or not parse(url).host:
        return []
    sources: set[str] = set()
    for (src,) in _store.query("SELECT sources FROM urls WHERE url = ?", (_normalise_url(url),)):
        sources.update(src.split(","))
    return sorted(sources)


def blocklist_sources(value: str) -> list[str]:
    """Union of `host_blocklist` and, when a path is present, `url_blocklist`."""
    sources = set(host_blocklist(value))
    if parse(value).path:
        sources.update(url_blocklist(value))
    return sorted(sources)


def popularity_rank(value: str) -> int | None:
    """Tranco rank of the host's registrable domain (or the host itself), None if unranked or no list."""
    parts = parse(value)
    keys = tuple({parts.registered_domain, parts.host})
    rows = _store.query(f"SELECT MIN(rank) FROM tranco WHERE domain IN ({','.join('?' * len(keys))})", keys)
    return rows[0][0] if rows and rows[0][0] is not None else None


def ip_asn(ip: str) -> dict | None:
    """Offline IPv4 -> {asn, country, org} from the IPtoASN table; None when unknown or IPv6."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if addr.version != 4:
        return None
    value = int(addr)
    rows = _store.query("SELECT end, asn, country, org FROM ip2asn WHERE start <= ? ORDER BY start DESC LIMIT 1", (value,))
    if not rows or rows[0][0] < value:
        return None
    _, asn, country, org = rows[0]
    return {"asn": asn, "country": country, "org": org, "source": "iptoasn"}


def feed_status() -> dict[str, dict]:
    """Per feed: entries and fetch time (UTC epoch), for evidence packs and the dashboard."""
    now = time.time()
    return {
        name: {"entries": count, "fetched_at": fetched, "age_hours": round((now - fetched) / 3600, 1), "url": url}
        for name, fetched, count, url in _store.query("SELECT name, fetched_at, entries, url FROM feeds", ())
    }


def reputation(host: str) -> tuple[bool, str | None, bool, list[str]]:
    """(allowlisted, owner, blocklisted, sources) for a host. A full URL is accepted too, in which case
    the exact URL is also checked against URL feeds. A verified official host is never reported as
    blocklisted: community feeds occasionally list real bank or government hosts."""
    parts = parse(host)
    owner = allowlist_owner(parts.host) if parts.host else None
    if owner:
        return True, owner, False, []
    sources = blocklist_sources(host)
    return False, None, bool(sources), sources
