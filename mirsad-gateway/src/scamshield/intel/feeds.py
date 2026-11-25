"""Download free phishing / malware feeds and the Tranco top-sites list, and build `data/feeds/feeds.db`.

    python -m scamshield.intel.feeds update      # fetch everything, rebuild the lookup database
    python -m scamshield.intel.feeds status      # show entries and age per feed

Only the feed files are downloaded. The URLs they list are never fetched.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import ipaddress
import sqlite3
import sys
import time
import zipfile
from dataclasses import dataclass

import httpx

from scamshield.intel.hosts import parse
from scamshield.intel.reputation import (
    FEEDS_DB,
    FEEDS_DIR,
    _normalise_url,
    allowlist_owner,
    feed_status,
    is_shortener,
    official_owner,
    shared_platform,
)

USER_AGENT = "scamshield-feeds/0.1"


@dataclass(frozen=True)
class Feed:
    name: str
    url: str
    kind: str  # "urls" | "hosts"


FEEDS = [
    Feed("openphish", "https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt", "urls"),
    Feed(
        "phishing_database",
        "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt",
        "hosts",
    ),
    Feed("phishing_army", "https://phishing.army/download/phishing_army_blocklist.txt", "hosts"),
    Feed("phishing_filter", "https://malware-filter.gitlab.io/malware-filter/phishing-filter-domains.txt", "hosts"),
    Feed("urlhaus_filter", "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains-online.txt", "hosts"),
]
TRANCO_URL = "https://tranco-list.eu/top-1m.csv.zip"
IP2ASN_URL = "https://iptoasn.com/data/ip2asn-v4.tsv.gz"  # public domain (PDDL 1.0)


def _lines(text: str):
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "!", "//")):
            yield line


# Domain feeds sometimes list whole popular sites (bit.ly, gravatar.com, name.com). The bare domain of a
# site in the Tranco top this-many is never blocked host-wide; URL entries on it are still matched exactly.
POPULAR_RANK = 50_000


def _usable_host(host: str, ranks: dict[str, int]) -> bool:
    """Skip entries that would block an official site, a shortener, a whole publishing platform or a popular site."""
    if not host or "." not in host or official_owner(host) or is_shortener(host) or shared_platform(host) == host:
        return False
    parts = parse(host)
    popular = ranks.get(parts.registered_domain, POPULAR_RANK + 1) <= POPULAR_RANK
    return not (popular and host in (parts.registered_domain, f"www.{parts.registered_domain}"))


def parse_feed(feed: Feed, text: str, ranks: dict[str, int]) -> tuple[set[str], set[str]]:
    hosts: set[str] = set()
    urls: set[str] = set()
    for line in _lines(text):
        if feed.kind == "hosts":
            host = parse(line.split()[-1]).host
            if _usable_host(host, ranks):
                hosts.add(host)
            continue
        host = parse(line).host
        if not host or allowlist_owner(host):
            continue
        urls.add(_normalise_url(line))
        if _usable_host(host, ranks):
            hosts.add(host)
    return hosts, urls


def _load_tranco(client: httpx.Client) -> dict[str, int]:
    raw = _download(client, TRANCO_URL)
    (FEEDS_DIR / "tranco-top-1m.csv.zip").write_bytes(raw)
    ranks: dict[str, int] = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for rank, domain in csv.reader(io.TextIOWrapper(archive.open(archive.namelist()[0]), encoding="utf-8")):
            ranks.setdefault(domain.lower(), int(rank))
    return ranks


def _ip2asn_rows(data: bytes):
    for line in data.decode("utf-8", errors="replace").splitlines():
        fields = line.split("\t")
        if len(fields) == 5 and fields[2] != "0":
            start, end = int(ipaddress.IPv4Address(fields[0])), int(ipaddress.IPv4Address(fields[1]))
            yield start, end, int(fields[2]), fields[3], fields[4]


def _download(client: httpx.Client, url: str) -> bytes:
    response = client.get(url)
    response.raise_for_status()
    return response.content


def build(db_path=FEEDS_DB, *, include_tranco: bool = True, log=print) -> dict[str, int]:
    FEEDS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = db_path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp)
    conn.executescript(
        """
        CREATE TABLE hosts (host TEXT PRIMARY KEY, sources TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE urls (url TEXT PRIMARY KEY, sources TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE tranco (domain TEXT PRIMARY KEY, rank INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE ip2asn (start INTEGER PRIMARY KEY, end INTEGER, asn INTEGER, country TEXT, org TEXT);
        CREATE TABLE feeds (name TEXT PRIMARY KEY, url TEXT, fetched_at REAL, entries INTEGER, error TEXT);
        """
    )
    host_sources: dict[str, set[str]] = {}
    url_sources: dict[str, set[str]] = {}
    counts: dict[str, int] = {}
    ranks: dict[str, int] = {}
    with httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        if include_tranco:
            try:
                ranks = _load_tranco(client)
                conn.executemany("INSERT INTO tranco VALUES (?, ?)", ranks.items())
                counts["tranco"] = len(ranks)
                conn.execute("INSERT INTO feeds VALUES (?,?,?,?,?)", ("tranco", TRANCO_URL, time.time(), len(ranks), None))
                log(f"tranco: {len(ranks)} ranked domains")
            except (httpx.HTTPError, zipfile.BadZipFile, ValueError) as exc:
                log(f"tranco: failed ({exc})")
        for feed in FEEDS:
            try:
                text = _download(client, feed.url).decode("utf-8", errors="replace")
            except httpx.HTTPError as exc:
                log(f"{feed.name}: failed ({exc})")
                conn.execute("INSERT INTO feeds VALUES (?,?,?,?,?)", (feed.name, feed.url, time.time(), 0, str(exc)))
                continue
            (FEEDS_DIR / f"{feed.name}.txt").write_text(text, encoding="utf-8")
            hosts, urls = parse_feed(feed, text, ranks)
            for host in hosts:
                host_sources.setdefault(host, set()).add(feed.name)
            for url in urls:
                url_sources.setdefault(url, set()).add(feed.name)
            counts[feed.name] = len(hosts) + len(urls)
            conn.execute("INSERT INTO feeds VALUES (?,?,?,?,?)", (feed.name, feed.url, time.time(), counts[feed.name], None))
            log(f"{feed.name}: {len(hosts)} hosts, {len(urls)} urls")
        try:
            raw = _download(client, IP2ASN_URL)
            (FEEDS_DIR / "ip2asn-v4.tsv.gz").write_bytes(raw)
            conn.executemany("INSERT OR REPLACE INTO ip2asn VALUES (?,?,?,?,?)", _ip2asn_rows(gzip.decompress(raw)))
            counts["ip2asn"] = conn.execute("SELECT COUNT(*) FROM ip2asn").fetchone()[0]
            conn.execute("INSERT INTO feeds VALUES (?,?,?,?,?)", ("ip2asn", IP2ASN_URL, time.time(), counts["ip2asn"], None))
            log(f"ip2asn: {counts['ip2asn']} routed IPv4 ranges")
        except (httpx.HTTPError, OSError, ValueError) as exc:
            log(f"ip2asn: failed ({exc})")
    conn.executemany("INSERT INTO hosts VALUES (?, ?)", ((h, ",".join(sorted(s))) for h, s in host_sources.items()))
    conn.executemany("INSERT INTO urls VALUES (?, ?)", ((u, ",".join(sorted(s))) for u, s in url_sources.items()))
    conn.commit()
    conn.close()
    tmp.replace(db_path)
    counts["hosts_total"] = len(host_sources)
    counts["urls_total"] = len(url_sources)
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scamshield.intel.feeds")
    sub = parser.add_subparsers(dest="cmd", required=True)
    update = sub.add_parser("update", help="download feeds and rebuild the lookup database")
    update.add_argument("--no-tranco", action="store_true", help="skip the 10 MB Tranco download")
    sub.add_parser("status", help="show feed sizes and age")
    args = parser.parse_args(argv)
    if args.cmd == "update":
        counts = build(include_tranco=not args.no_tranco)
        print(f"blocklisted hosts: {counts['hosts_total']}, urls: {counts['urls_total']} -> {FEEDS_DB}")
        return 0
    status = feed_status()
    if not status:
        print(f"no feed database at {FEEDS_DB}; run: python -m scamshield.intel.feeds update")
        return 1
    for name, info in sorted(status.items()):
        print(f"{name:20} {info['entries']:>9} entries  {info['age_hours']:>6} h old")
    return 0


if __name__ == "__main__":
    sys.exit(main())
