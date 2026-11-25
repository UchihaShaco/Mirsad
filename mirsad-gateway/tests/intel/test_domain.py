import asyncio
import os
import time
from datetime import datetime, timezone

import pytest

from scamshield.intel import domain
from scamshield.intel.domain import assess_domain, parse_date, parse_rdap, parse_whois, raw_registration

RDAP_SAMPLE = {
    "objectClassName": "domain",
    "ldhName": "ADCB-VERIFY.TOP",
    "status": ["client transfer prohibited"],
    "events": [
        {"eventAction": "registration", "eventDate": "2026-11-21T03:14:07Z"},
        {"eventAction": "expiration", "eventDate": "2027-11-21T03:14:07Z"},
    ],
    "nameservers": [{"ldhName": "NS1.EXAMPLE-DNS.COM"}, {"ldhName": "ns2.example-dns.com"}],
    "entities": [
        {
            "roles": ["registrar"],
            "publicIds": [{"type": "IANA Registrar ID", "identifier": "1897"}],
            "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar Ltd"]]],
            "entities": [
                {
                    "roles": ["abuse"],
                    "vcardArray": ["vcard", [["email", {}, "text", "abuse@registrar.example"],
                                             ["tel", {"type": "voice"}, "uri", "tel:+852.12345678"]]],
                }
            ],
        },
        {"roles": ["registrant"], "vcardArray": ["vcard", [["adr", {"cc": "HK"}, "text", ["", "", "", "", "", "", ""]]]]},
    ],
}

AE_WHOIS_SAMPLE = """Domain Name:                     dewa.gov.ae
Registrar ID:                    Etisalat
Registrar Name:                  Etisalat
Status:                          ok

Registrant:                      DUBAI ELECTRICITY & WATER AUTHORITY
Eligibility Type:                Government Approved
Eligibility Name:                DUBAI ELECTRICITY & WATER AUTHORITY

Registrant Contact ID:           R000227
Registrant Contact Name:         Dubai Electricity & Water Authority
Registrant Contact Organisation: DEWA

Name Server:                     ns.dewa.gov.ae
Name Server:                     a9-67.akam.net
"""


def test_parse_rdap():
    parsed = parse_rdap(RDAP_SAMPLE)
    assert parsed["created"] == "2026-11-21T03:14:07Z"
    assert parsed["registrar"] == "Example Registrar Ltd"
    assert parsed["registrar_iana_id"] == "1897"
    assert parsed["abuse_email"] == "abuse@registrar.example"
    assert parsed["abuse_phone"] == "+852.12345678"
    assert parsed["registrant_country"] == "HK"
    assert parsed["nameservers"] == ["ns1.example-dns.com", "ns2.example-dns.com"]


def test_parse_ae_whois():
    parsed = parse_whois(AE_WHOIS_SAMPLE)
    assert parsed["registrar"] == "Etisalat"
    assert parsed["registrant"] == "DUBAI ELECTRICITY & WATER AUTHORITY"
    assert parsed["eligibility"] == "Government Approved"
    assert parsed["nameservers"] == ["a9-67.akam.net", "ns.dewa.gov.ae"]
    assert "created" not in parsed  # .ae WHOIS publishes no dates


@pytest.mark.parametrize("raw,expected", [
    ("2026-11-21T03:14:07Z", datetime(2026, 11, 21, 3, 14, 7, tzinfo=timezone.utc)),
    ("2003-06-25", datetime(2003, 6, 25, tzinfo=timezone.utc)),
    ("25-Jun-2003", datetime(2003, 6, 25, tzinfo=timezone.utc)),
    ("2003.06.25 10:00:00", datetime(2003, 6, 25, tzinfo=timezone.utc)),
    ("not a date", None),
    (None, None),
])
def test_parse_date(raw, expected):
    assert parse_date(raw) == expected


def test_apply_computes_ages():
    intel, _ = domain._base_intel("https://adcb-verify.top/login")
    now = datetime.now(timezone.utc)
    reg = {"found": True, **parse_rdap(RDAP_SAMPLE)}
    tls = {"issuer": "R11", "not_before": now.replace(microsecond=0).isoformat(), "sans": ["adcb-verify.top"]}
    domain._apply(intel, {"a": ["203.0.113.7"], "aaaa": [], "ns": ["ns1.example-dns.com"]}, reg,
                  {"asn": 64500, "org": "EXAMPLE-HOSTING", "country": "NL"}, tls)
    assert intel.registrar == "Example Registrar Ltd" and intel.registrant_country == "HK"
    assert intel.age_days == (now - datetime(2026, 11, 21, 3, 14, 7, tzinfo=timezone.utc)).days
    assert intel.tls_age_days == 0 and intel.tls_issuer == "R11"
    assert (intel.asn, intel.asn_org, intel.hosting_country) == (64500, "EXAMPLE-HOSTING", "NL")
    assert intel.ips == ["203.0.113.7"] and intel.tld == "top"


async def test_fast_mode_uses_local_data_and_never_raises(monkeypatch):
    async def slow_dns(host, registered, timeout):
        await asyncio.sleep(5)

    monkeypatch.setattr(domain, "_dns", slow_dns)
    started = time.perf_counter()
    intel = await assess_domain("https://www.tamm.abudhabi/en", fast=True)
    assert (time.perf_counter() - started) < 0.35
    assert intel.allowlisted and intel.allowlist_owner == "TAMM"
    assert intel.registered_domain == "tamm.abudhabi" and intel.tld == "abudhabi"
    assert any(e.startswith("dns: timeout") for e in intel.errors)


async def test_fast_mode_serves_cached_components():
    domain._cache.set("dns:login.adcb-verify.top", {"a": ["203.0.113.7"], "aaaa": [], "ns": ["ns1.x.com"]}, 60)
    domain._cache.set("reg:adcb-verify.top", {"found": True, **parse_rdap(RDAP_SAMPLE)}, 60)
    domain._cache.set("asn:203.0.113.7", {"asn": 64500, "org": "EXAMPLE", "country": "NL"}, 60)
    intel = await assess_domain("http://login.adcb-verify.top/", fast=True)
    assert intel.errors == []
    assert intel.registrar == "Example Registrar Ltd" and intel.asn == 64500 and intel.ips == ["203.0.113.7"]
    assert intel.elapsed_ms < 50


async def test_full_mode_collects_errors_instead_of_raising(monkeypatch):
    async def broken(*args, **kwargs):
        raise OSError("network unreachable")

    monkeypatch.setattr(domain, "_dns", broken)
    monkeypatch.setattr(domain, "_registration", broken)
    monkeypatch.setattr(domain, "_tls", broken)
    intel = await assess_domain("https://salik-pay.icu/")
    assert intel.host == "salik-pay.icu" and not intel.allowlisted
    assert {e.split(":")[0] for e in intel.errors} == {"dns", "reg", "tls"}


async def test_garbage_input_never_raises():
    for value in ["", "http://", "not a url at all", "http://[::1", "https://xn--zz.com"]:
        intel = await assess_domain(value, fast=True)
        assert intel.errors or intel.host


async def test_cache_survives_restart(tmp_path):
    cache = domain._Cache(tmp_path / "c.db")
    cache.set("reg:example.com", {"found": True, "registrar": "X"}, 60)
    fresh = domain._Cache(tmp_path / "c.db")
    assert fresh.get("reg:example.com") == {"found": True, "registrar": "X"}
    fresh.set("reg:old.com", {"found": True}, -1)
    assert fresh.get("reg:old.com") is None


network = pytest.mark.skipif(os.environ.get("SCAMSHIELD_NETWORK_TESTS") != "1",
                             reason="set SCAMSHIELD_NETWORK_TESTS=1 to run live RDAP / DNS / TLS lookups")


@network
async def test_live_full_assessment():
    intel = await assess_domain("https://www.tamm.abudhabi/en")
    assert intel.ips and intel.nameservers and intel.tls_issuer
    assert intel.created is not None and intel.age_days > 1000
    assert intel.elapsed_ms < 7000


@network
async def test_live_raw_registration():
    record = await raw_registration("adcb.com")
    assert record["registration"]["source"] == "rdap"
    assert record["registrar_abuse"]["email"]
    assert record["hosting"]["ips"]
