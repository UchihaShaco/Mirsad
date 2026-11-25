import json
import sqlite3
import time

import pytest

from scamshield.intel import feeds, reputation
from scamshield.intel.brands import match_brand
from scamshield.intel.reputation import (
    PKG_DATA,
    allowlist_owner,
    is_shortener,
    popularity_rank,
    registry,
    shared_platform,
    tld_risk,
)

BRANDS = json.loads((PKG_DATA / "brands.json").read_text(encoding="utf-8"))["brands"]
EXTRA = json.loads((PKG_DATA / "allowlist.json").read_text(encoding="utf-8"))["domains"]
OFFICIAL = sorted({d for b in BRANDS for d in b["domains"]} | set(EXTRA))


def _publishing(domain: str) -> bool:
    return bool(shared_platform(domain) or is_shortener(domain))


@pytest.mark.parametrize("domain", OFFICIAL)
def test_official_domain_is_allowlisted_and_never_a_brand_match(domain):
    for url in (domain, f"https://www.{domain}/en/login", f"https://secure.{domain}/pay?ref=sms"):
        if _publishing(domain):
            assert reputation.reputation(url)[0] is False, "publishing platforms are never allowlisted"
        else:
            allowlisted, owner, blocklisted, _ = reputation.reputation(url)
            assert allowlisted and owner, url
            assert not blocklisted
        assert match_brand(url) is None, url


@pytest.mark.parametrize("host,owner", [
    ("www.dewa.gov.ae", "Dubai Electricity and Water Authority (DEWA)"),
    ("smartservices.icp.gov.ae", "ICP - Federal Authority for Identity, Citizenship, Customs & Port Security"),
    ("darb.itc.gov.ae", "Integrated Transport Centre (Darb / Mawaqif)"),
    ("anything.newentity.gov.ae", "UAE Government (.gov.ae)"),
    ("portal.army.mil.ae", "UAE Armed Forces (.mil.ae)"),
    ("www.tamm.abudhabi", "TAMM"),
    ("dubai.ae", "Government of Dubai"),
])
def test_owner_names(host, owner):
    assert allowlist_owner(host) == owner


@pytest.mark.parametrize("host", [
    "gov.ae", "tamm.abudhabi.gov-ae.com", "adcb.com.secure-login.top", "uaepass.ae.verify.icu", "adcbb.com", "sites.google.com",
    "contoso.sharepoint.com", "bit.ly", "t.co", "storage.googleapis.com", "evil.blogspot.com",
])
def test_not_allowlisted(host):
    assert allowlist_owner(host) is None


def test_platforms_and_shorteners():
    assert shared_platform("sites.google.com") == "sites.google.com"
    assert shared_platform("adcb-login.weebly.com") == "weebly.com"
    assert shared_platform("x.y.pages.dev") == "pages.dev"
    assert shared_platform("www.adcb.com") is None
    assert is_shortener("bit.ly") and is_shortener("www.tinyurl.com")
    assert not is_shortener("www.emiratesnbd.com")


def test_tld_risk():
    assert tld_risk("icu") >= 0.8 and tld_risk("top") >= 0.8
    assert tld_risk("com") == 0 and tld_risk("ae") == 0 and tld_risk("gov.ae") == 0


def test_registry_is_consistent():
    reg = registry()
    assert len(reg.official) >= 250
    overlap = reg.shorteners & reg.subdomain_platforms
    assert not overlap


def _feed_db(path, ranks=None):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE hosts (host TEXT PRIMARY KEY, sources TEXT NOT NULL);
        CREATE TABLE urls (url TEXT PRIMARY KEY, sources TEXT NOT NULL);
        CREATE TABLE tranco (domain TEXT PRIMARY KEY, rank INTEGER NOT NULL);
        CREATE TABLE ip2asn (start INTEGER PRIMARY KEY, end INTEGER, asn INTEGER, country TEXT, org TEXT);
        CREATE TABLE feeds (name TEXT PRIMARY KEY, url TEXT, fetched_at REAL, entries INTEGER, error TEXT);
    """)
    openphish = feeds.Feed("openphish", "", "urls")
    domains = feeds.Feed("phishing_database", "", "hosts")
    url_text = "\n".join([
        "https://sites.google.com/view/adcb-update/login",
        "http://login.adcb-verify.top/index.php",
        "https://www.adcb.com/en/fake",
        "https://popular-news.com/wp-content/x/",
    ])
    host_text = "\n".join(["dubai-police-fines.icu", "0.0.0.0 rta-pay.top", "www.dewa.gov.ae", "evil.weebly.com", "weebly.com",
                           "bit.ly", "popular-news.com"])
    ranks = ranks or {"popular-news.com": 500}
    hosts, urls = set(), set()
    for feed, text in ((openphish, url_text), (domains, host_text)):
        h, u = feeds.parse_feed(feed, text, ranks)
        hosts |= {(x, feed.name) for x in h}
        urls |= {(x, feed.name) for x in u}
    db.executemany("INSERT OR REPLACE INTO hosts VALUES (?, ?)", hosts)
    db.executemany("INSERT OR REPLACE INTO urls VALUES (?, ?)", urls)
    db.executemany("INSERT INTO tranco VALUES (?, ?)", list(ranks.items()) + [("google.com", 1)])
    db.execute("INSERT INTO ip2asn VALUES (?,?,?,?,?)", (16777216, 16777471, 13335, "US", "CLOUDFLARENET"))
    db.execute("INSERT INTO feeds VALUES ('openphish', 'x', ?, 4, NULL)", (time.time() - 7200,))
    db.commit()
    db.close()


@pytest.fixture
def feed_store(tmp_path, monkeypatch):
    path = tmp_path / "feeds.db"
    _feed_db(path)
    monkeypatch.setattr(reputation, "_store", reputation._FeedStore(path))
    return path


def test_blocklist_lookups(feed_store):
    assert reputation.reputation("dubai-police-fines.icu")[2:] == (True, ["phishing_database"])
    assert reputation.reputation("https://pay.dubai-police-fines.icu/x")[2] is True
    assert reputation.reputation("rta-pay.top")[2] is True
    assert reputation.reputation("login.adcb-verify.top")[2] is True
    assert reputation.reputation("evil.weebly.com")[2] is True
    assert reputation.reputation("other.weebly.com")[2] is False, "a platform itself is never blocklisted"
    assert reputation.reputation("weebly.com")[2] is False
    assert reputation.reputation("bit.ly")[2] is False, "shorteners are not blocklisted wholesale"
    assert reputation.reputation("sites.google.com")[2] is False
    assert reputation.reputation("https://sites.google.com/view/adcb-update/login")[2] is True
    assert reputation.reputation("popular-news.com")[2] is False, "popular sites are not blocked host-wide"
    assert reputation.reputation("https://popular-news.com/wp-content/x/")[2] is True
    official = reputation.reputation("https://www.adcb.com/en/fake")
    assert official[0] is True and official[2] is False
    assert reputation.reputation("www.dewa.gov.ae")[:3] == (True, "Dubai Electricity and Water Authority (DEWA)", False)


def test_url_and_host_level_lookups(feed_store):
    assert reputation.url_blocklist("http://sites.google.com/view/adcb-update/login/") == ["openphish"]
    assert reputation.url_blocklist("https://sites.google.com/view/other") == []
    assert reputation.host_blocklist("sites.google.com") == []
    assert reputation.host_blocklist("x.login.adcb-verify.top") == ["openphish"]
    assert reputation.host_blocklist("adcb-verify.top") == []
    assert reputation.url_blocklist("https://login.adcb-verify.top/index.php#frag") == ["openphish"]


async def test_blocklist_off_switch(feed_store, monkeypatch):
    from scamshield import config
    from scamshield.intel import domain

    monkeypatch.setattr(config, "USE_BLOCKLISTS", False)
    assert reputation.reputation("dubai-police-fines.icu") == (False, None, False, [])
    assert reputation.reputation("https://sites.google.com/view/adcb-update/login") == (False, None, False, [])
    assert reputation.url_blocklist("http://login.adcb-verify.top/index.php") == []
    assert reputation.host_blocklist("rta-pay.top") == []
    assert reputation.reputation("www.dewa.gov.ae")[0] is True, "the allowlist stays on"
    assert popularity_rank("google.com") == 1 and is_shortener("bit.ly")
    intel = await domain.assess_domain("https://dubai-police-fines.icu/", fast=True)
    assert intel.blocklisted is False and intel.blocklist_sources == []
    monkeypatch.setattr(config, "USE_BLOCKLISTS", True)
    assert reputation.reputation("dubai-police-fines.icu")[2] is True


def test_popularity_asn_and_status(feed_store):
    assert popularity_rank("https://mail.google.com/") == 1
    assert popularity_rank("unknown-site.example") is None
    assert reputation.ip_asn("1.0.0.1") == {"asn": 13335, "country": "US", "org": "CLOUDFLARENET", "source": "iptoasn"}
    assert reputation.ip_asn("1.0.1.1") is None
    status = reputation.feed_status()
    assert status["openphish"]["entries"] == 4 and 1.9 < status["openphish"]["age_hours"] < 2.1


def test_reputation_is_sub_millisecond(feed_store):
    hosts = ["www.adcb.com", "dubai-police-fines.icu", "a.b.c.example.org", "https://sites.google.com/view/x", "1.2.3.4"]
    reputation.reputation("warm.example")
    started = time.perf_counter()
    rounds = 2000
    for _ in range(rounds):
        for host in hosts:
            reputation.reputation(host)
    per_call_ms = (time.perf_counter() - started) * 1000 / (rounds * len(hosts))
    assert per_call_ms < 1.0
