import asyncio
import base64
import io
import json
import struct
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding
from cryptography.x509.oid import NameOID

from scamshield.watch import ct, nrd, search, store as store_mod, sweep
from scamshield.watch.base import Candidate
from scamshield.watch.brands import brand_by_name
from scamshield.watch.listings import parse_nominatim
from scamshield.watch.store import Store
from scamshield.watch.submit import Submitter

FIXTURES = Path(__file__).parent / "fixtures"

NOW = datetime(2026, 11, 24, 12, tzinfo=timezone.utc)


def make_cert(cn: str, sans: list[str]) -> bytes:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    issuer = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test CA")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(issuer).public_key(key.public_key())
            .serial_number(1).not_valid_before(NOW).not_valid_after(NOW + timedelta(days=90))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(s) for s in sans]), critical=False)
            .sign(key, hashes.SHA256()))
    return cert.public_bytes(Encoding.DER)


def u24(b: bytes) -> bytes:
    return len(b).to_bytes(3, "big") + b


def u16(b: bytes) -> bytes:
    return len(b).to_bytes(2, "big") + b


def tile_leaf_x509(der: bytes, ts: int) -> bytes:
    return struct.pack(">QH", ts, 0) + u24(der) + u16(b"") + u16(b"\x00" * 32)


def tile_leaf_precert(der: bytes, ts: int) -> bytes:
    return struct.pack(">QH", ts, 1) + b"\x11" * 32 + u24(b"tbs-bytes") + u16(b"") + u24(der) + u16(b"\x00" * 64)


# Certificate transparency


def test_tile_path_encoding():
    assert ct.tile_path(0) == "000"
    assert ct.tile_path(67) == "067"
    assert ct.tile_path(1234067) == "x001/x234/067"
    assert ct.tile_path(4378) == "x004/378"


def test_parse_static_ct_tile_with_x509_and_precert_entries():
    a, b = make_cert("uaepass-login.icu", ["uaepass-login.icu", "www.uaepass-login.icu"]), make_cert("x.org", ["x.org"])
    data = tile_leaf_x509(a, 1_795_000_000_000) + tile_leaf_precert(b, 1_795_000_000_500)
    entries = list(ct.parse_tile(data, 512))
    assert [e.index for e in entries] == [512, 513]
    assert entries[0].der == a and entries[1].der == b
    names, facts = ct.cert_names(entries[0].der)
    assert names == ["uaepass-login.icu", "www.uaepass-login.icu"] and facts["issuer"] == "Test CA"


def test_parse_rfc6962_entries():
    der = make_cert("tamm-pay.top", ["tamm-pay.top"])
    leaf = struct.pack(">BBQH", 0, 0, 1_795_000_000_000, 0) + u24(der) + u16(b"")
    e = ct.parse_rfc6962(base64.b64encode(leaf).decode(), "", 7)
    assert e.der == der and e.index == 7
    pre_leaf = struct.pack(">BBQH", 0, 0, 1_795_000_000_000, 1) + b"\x00" * 32 + u24(b"tbs") + u16(b"")
    extra = u24(der) + u24(b"")
    e = ct.parse_rfc6962(base64.b64encode(pre_leaf).decode(), base64.b64encode(extra).decode(), 8)
    assert e.der == der


def test_ct_candidates_from_entry_filters_and_dedupes():
    src = ct.CTSource(Store())
    der = make_cert("*.tamm-fines.icu", ["*.tamm-fines.icu", "tamm-fines.icu", "cdn.example.org"])
    seen: set[str] = set()
    out = list(src._candidates_from(ct.Entry(1, 1_795_000_000_000, der), "Test log", seen))
    assert [c.host for c in out] == ["tamm-fines.icu"]
    assert out[0].brand_hint == "TAMM" and out[0].first_seen.year == 2026
    assert list(src._candidates_from(ct.Entry(2, 1_795_000_000_000, der), "Test log", seen)) == []


def test_select_logs_uses_current_and_future_shards():
    log_list = {"operators": [{"name": "Let's Encrypt", "logs": [], "tiled_logs": [
        {"description": "old", "monitoring_url": "https://old/", "state": {"usable": {}},
         "temporal_interval": {"start_inclusive": "2026-01-01T00:00:00Z", "end_exclusive": "2026-07-01T00:00:00Z"}},
        {"description": "now", "monitoring_url": "https://now/", "state": {"usable": {}},
         "temporal_interval": {"start_inclusive": "2026-07-01T00:00:00Z", "end_exclusive": "2027-01-01T00:00:00Z"}},
        {"description": "next", "monitoring_url": "https://next/", "state": {"usable": {}},
         "temporal_interval": {"start_inclusive": "2027-01-01T00:00:00Z", "end_exclusive": "2027-07-01T00:00:00Z"}},
        {"description": "retired", "monitoring_url": "https://retired/", "state": {"retired": {}}},
    ]}, {"name": "Other", "logs": [{"description": "x", "url": "https://x/", "state": {"usable": {}}}]}]}
    got = ct.select_logs(log_list, ["Let's Encrypt"], NOW)
    assert [d for _, _, d in got] == ["now", "next"]


# Newly registered domains


def test_nrd_zip_parsing_and_filter():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("domain-names.txt", "uaepass-verify.com\nexample.org\nsalik-recharge.icu\n\nparkingfrog.com\n"
                                         "dubai-traffic-fines.top\n# comment\n")
    domains = nrd.domains_from_bytes(buf.getvalue())
    assert domains == ["uaepass-verify.com", "example.org", "salik-recharge.icu", "parkingfrog.com",
                       "dubai-traffic-fines.top"]
    found = nrd.filter_domains(domains, source="nrd", first_seen=NOW, evidence={"list": "test"})
    assert {c.host for c in found} == {"uaepass-verify.com", "salik-recharge.icu", "dubai-traffic-fines.top"}
    assert all(c.first_seen == NOW and c.evidence["list"] == "test" for c in found)


def test_whoisds_url():
    assert nrd.whoisds_url(datetime(2026, 11, 24).date()).endswith("/MjAyNi0xMS0yNC56aXA=/nrd")


# Look-alike sweep


def test_label_variants_cover_typo_classes():
    v = sweep.label_variants("salik")
    assert {"salk", "sallik", "slaik", "sa-lik", "sa1ik", "salik-pay", "mysalik"} <= v
    names = sweep.builtin_lookalikes("salik.ae")
    assert "salik.com" in names and "salik.ae" not in names and "salk.ae" in names


class FakeResolver:
    def __init__(self, answers: dict[str, list[str]]):
        self.answers, self.calls = answers, []

    async def a(self, name: str):
        self.calls.append(name)
        return self.answers.get(name, [])


async def test_sweep_queues_unowned_resolving_lookalikes_and_resumes():
    brand = brand_by_name("Salik")
    st = Store()
    src = sweep.SweepSource(st, brands=[brand])
    src.resolver = FakeResolver({"salik.ae": ["94.1.1.1"], "salk.ae": ["45.9.9.9"], "salik.com": ["94.1.1.1"],
                                 "salik-pay.top": ["104.21.3.3"], "salik.net": ["15.197.148.33"]})
    got = [c async for c in src.candidates(once=True)]
    hosts = {c.host for c in got}
    by_host = {c.host: c for c in got}
    assert by_host["salik.net"].evidence["parked"] and by_host["salik.net"].score < by_host["salk.ae"].score
    assert "salk.ae" in hosts  # resolves elsewhere: queued
    assert "salik.com" not in hosts  # shares the official site's dedicated IP: brand-owned
    assert "salik-pay.top" in hosts  # Cloudflare IP: proves nothing about ownership, still queued
    first_calls = len(src.resolver.calls)
    src2 = sweep.SweepSource(st, brands=[brand])
    src2.resolver = FakeResolver({})
    assert [c async for c in src2.candidates(once=True)] == []
    assert len(src2.resolver.calls) < first_calls / 10  # everything already swept is skipped


# Search and listings


def test_parse_duckduckgo_results_page():
    """A synthetic page in DuckDuckGo's HTML results markup: organic results unwrapped from /l/?uddg=, the ad from
    /y.js?ad_domain=."""
    html = (FIXTURES / "ddg_synthetic_customer_care.html").read_text(encoding="utf-8")
    results = search.parse_duckduckgo(html)
    assert len(results) == 9
    assert results[0].url == "https://www.examplebank.test/en/help-and-support/contact-us"
    assert results[0].title == "Contact Example Bank | Customer Support & Help Center"
    assert "customer care" in results[0].snippet.lower()
    assert [r.kind for r in results].count("ad") == 1 and results[-1].url == "https://shop.example/"


def test_assess_search_results():
    enbd = brand_by_name("Emirates NBD")
    official = search.Result(url="https://www.emiratesnbd.com/en/contact", title="Contact Emirates NBD")
    news = search.Result(url="https://www.khaleejtimes.com/x", title="Emirates NBD warns customers")
    fake = search.Result(url="https://enbd-helpdesk.online/", title="Emirates NBD Customer Care 24/7",
                         snippet="Call 800 000 0103 now")
    ad = search.Result(url="https://random-shop.example/", title="Best deals", is_ad=True, kind="ad")
    assert search.assess_result(official, enbd, "duckduckgo", "q") is None
    assert search.assess_result(news, enbd, "duckduckgo", "q") is None
    c = search.assess_result(fake, enbd, "duckduckgo", "q")
    assert c.host == "enbd-helpdesk.online" and c.evidence["phones_not_official"] == ["+9718000000103"]
    assert search.assess_result(ad, enbd, "duckduckgo", "q").technique == "ad"


def test_parse_nominatim_listing():
    rows = [{"osm_type": "node", "osm_id": 42, "name": "Emirates NBD", "display_name": "Emirates NBD, Dubai",
             "type": "bank", "extratags": {"contact:phone": "+971 4 316 0316", "website": "https://www.emiratesnbd.com"}}]
    [l] = parse_nominatim(rows)
    assert (l.id, l.phone, l.website) == ("node/42", "+971 4 316 0316", "https://www.emiratesnbd.com")


def test_search_source_backs_off_when_rate_limited():
    class Limited:
        name = "duckduckgo"

        def available(self):
            return True

        async def search(self, http, query, lang):
            raise search.RateLimited("challenge")

    src = search.SearchSource(Store(), queries=[("a", None, "en"), ("b", None, "en")])
    src.providers = [Limited()]
    src.limiter = search.RateLimiter(0)

    async def run():
        async with httpx.AsyncClient() as http:
            return [c async for c in src._round(http, once=True)]

    assert asyncio.run(run()) == [] and src.errors == ["challenge"]  # stopped after the first refusal


# Store, lead time and engine submission


@pytest.fixture
def no_intel(monkeypatch):
    listed: dict[str, list[str]] = {}
    monkeypatch.setattr(store_mod, "_reputation", lambda host: (host in listed, listed.get(host, [])))
    monkeypatch.setattr(store_mod, "_allowlisted", lambda host: host == "www.tamm.abudhabi")
    return listed


def test_store_dedupes_and_tracks_sources(no_intel):
    st = Store()
    reg = NOW - timedelta(hours=30)
    assert st.add(Candidate(url="http://tamm-pay.icu/", source="nrd", brand_hint="TAMM", first_seen=reg))
    assert not st.add(Candidate(url="https://tamm-pay.icu/", source="ct", brand_hint="TAMM", first_seen=NOW))
    [row] = st.rows()
    assert json.loads(row["sources"]) == ["ct", "nrd"]
    assert row["first_seen"] == reg.isoformat(timespec="seconds")
    assert st.add(Candidate(url="https://www.tamm.abudhabi/", source="search", brand_hint="TAMM"))
    assert st.rows("host=?", ("www.tamm.abudhabi",))[0]["status"] == "skipped"


async def test_submitter_queues_while_engine_down_then_records_verdicts(no_intel):
    st = Store()
    st.add(Candidate(url="http://tamm-pay.icu/", source="nrd", brand_hint="TAMM", first_seen=NOW - timedelta(hours=5)))

    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    down = Submitter(st, engine_url="http://engine.invalid", transport=httpx.MockTransport(refuse))
    assert await down.drain() == 1 and down.errors == 1
    row = st.rows()[0]
    assert row["status"] == "queued" and row["attempts"] == 1 and "ConnectError" in row["last_error"]

    with st.connect() as db:  # make it due again
        db.execute("UPDATE candidates SET next_attempt_at=?", (NOW.isoformat(),))
    posted = []

    def engine(request):
        posted.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "v1", "decision": "block", "risk_score": 91, "stage": "deep",
                                         "final": True, "campaign_id": "cmp-1"})

    up = Submitter(st, engine_url="http://engine.test", transport=httpx.MockTransport(engine))
    assert await up.drain() == 1
    assert posted == [{"url": "http://tamm-pay.icu/", "depth": "deep", "source": "watcher"}]
    row = st.rows()[0]
    assert (row["status"], row["decision"], row["campaign_id"], row["listed_at_verdict"]) == ("done", "block", "cmp-1", 0)
    stats = st.stats()
    assert stats["flagged"] == 1 and stats["flagged_before_any_blocklist"] == 1
    assert stats["median_hours_first_seen_to_verdict"] >= 5

    no_intel["tamm-pay.icu"] = ["openphish"]  # a public list catches up later
    assert st.recheck_blocklists() == 1
    [lead] = st.stats()["later_listed_with_lead_time"]
    assert lead["host"] == "tamm-pay.icu" and lead["lead_hours"] >= 0
