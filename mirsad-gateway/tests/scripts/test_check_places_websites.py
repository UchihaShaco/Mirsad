"""scripts/check_places_websites.py on a synthetic places file in the portal's format, with a fake engine.

No network: the engine is a function that answers from a table, and urllib is made to fail if anything reaches it.
"""

from __future__ import annotations

import asyncio
import csv
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

import sqlite3

import pytest

from scamshield.watch import brands, match

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "places-synthetic.json"

_spec = importlib.util.spec_from_file_location("check_places_websites", ROOT / "scripts" / "check_places_websites.py")
audit_script = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = audit_script  # dataclasses look their module up here
_spec.loader.exec_module(audit_script)

SYNTHETIC_REGISTRY = {
    "_about": "Synthetic brand registry for the places audit tests.",
    "brands": [{"id": "examplebank", "name_en": "Example Bank", "name_ar": "بنك المثال", "category": "bank",
                "country": "AE", "aliases_en": ["Example Bank"], "aliases_ar": [], "tokens": ["examplebank"],
                "weak_tokens": [], "domains": ["examplebank.test"], "phones": []}],
}


def reason(code: str, points: float, severity: str = "medium") -> dict:
    return {"code": code, "severity": severity, "points": points, "title_en": f"{code} en", "title_ar": f"{code} ar"}


def verdict(url: str, decision: str, risk: float, *reasons: dict, final_url: str | None = None) -> dict:
    return {"id": "v-" + url, "url": url, "final_url": final_url or url, "decision": decision, "risk_score": risk,
            "reasons": list(reasons), "summary_en": "summary", "summary_ar": "ملخص",
            "evidence_ref": None if decision == "allow" else "MRS-TEST-0001",
            "created_at": "2026-11-25T00:00:00Z", "updated_at": "2026-11-25T00:00:01Z"}


ANSWERS = {
    "bakery-lapsed.test": lambda u: verdict(u, "warn", 41.0, reason("page.parked", 6, "low"),
                                            reason("rule.parked_floor", 0, "low"), reason("model.url", 0, "info")),
    "clinic.example.com": lambda u: verdict(u, "allow", 2.0, reason("domain.long_established", -16, "info")),
    "parked-clinic.test": lambda u: verdict(u, "allow", 30.0, reason("page.unreachable", 0, "info")),
    "examplebank-help.test": lambda u: verdict(u, "warn", 55.0, reason("domain.lookalike", 36, "high")),
    "examplebank.test": lambda u: verdict(u, "allow", 1.0),
    "garage-takeover.test": lambda u: verdict(
        u, "block", 92.0, reason("page.parked", 6, "low"), reason("page.harmful_redirect", 20, "high"),
        reason("rule.takeover_block", 0, "critical"), final_url="https://casino.example.net/"),
}


class FakeEngine:
    def __init__(self, fail: set[str] = frozenset()) -> None:
        self.calls: list[str] = []
        self.fail = fail

    async def __call__(self, url: str) -> dict:
        self.calls.append(url)
        host = audit_script.host_of(url)
        if host in self.fail:
            raise RuntimeError("engine answered 503")
        return ANSWERS[host](url)


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    def no_network(*_a, **_k):
        raise AssertionError("the places audit tests must not touch the network")

    monkeypatch.setattr(urllib.request, "urlopen", no_network)
    registry = tmp_path / "brands.json"
    registry.write_text(json.dumps(SYNTHETIC_REGISTRY), encoding="utf-8")
    monkeypatch.setattr(brands, "REGISTRY_PATH", registry)
    brands.load_brands.cache_clear()
    match._index.cache_clear()
    yield
    brands.load_brands.cache_clear()
    match._index.cache_clear()


@pytest.fixture
def places() -> list[dict]:
    return audit_script.load_places(FIXTURE)


RECORD_FIELDS = {"place_id", "name", "name_ar", "place_category", "lat", "lng", "website", "host", "decision",
                 "risk_score", "category", "finding_en", "finding_ar", "reasons_en", "reasons_ar", "reasons",
                 "summary_en", "summary_ar", "final_url", "evidence_ref", "verdict_id", "checked_at", "engine_version",
                 "portal_path", "websites", "helpline", "error"}


def by_id(records: list[dict]) -> dict[str, dict]:
    return {r["place_id"]: r for r in records}


# ---- Parsing -----------------------------------------------------------------------------------------------------

def test_reads_the_portal_places_format(places):
    assert len(places) == 8
    assert {"id", "name", "name_ar", "urls", "phones", "category", "lat", "lng"} <= set(places[0])


def test_rejects_a_file_that_is_not_a_places_array(tmp_path):
    (tmp_path / "obj.json").write_text('{"places": []}', encoding="utf-8")
    (tmp_path / "bad.json").write_text('[{"name": "no id"}]', encoding="utf-8")
    with pytest.raises(ValueError, match="places_file_not_array"):
        audit_script.load_places(tmp_path / "obj.json")
    with pytest.raises(ValueError, match="places_record_invalid"):
        audit_script.load_places(tmp_path / "bad.json")


def test_host_of_matches_the_portal_rule():
    assert audit_script.host_of("https://WWW.Bakery-Lapsed.test/menu") == "bakery-lapsed.test"
    assert audit_script.host_of("bakery-lapsed.test") == "bakery-lapsed.test"
    assert audit_script.host_of("not a url") is None
    assert audit_script.host_of("mailto:info@example.com") is None


# ---- De-duplication and skipping -------------------------------------------------------------------------------------

def test_each_host_is_checked_once_and_social_and_directory_links_are_skipped(places):
    plan = audit_script.plan_checks(places)
    assert sorted(plan.hosts) == sorted(["bakery-lapsed.test", "clinic.example.com", "parked-clinic.test",
                                         "examplebank-help.test", "examplebank.test", "garage-takeover.test"])
    assert plan.hosts["bakery-lapsed.test"] == "https://www.bakery-lapsed.test/"  # the first URL seen for the host
    assert plan.listing_hosts["synthetic-place-0002"] == [("bakery-lapsed.test", "bakery-lapsed.test")]
    assert plan.skipped_links == 3  # instagram, facebook, tripadvisor
    assert plan.only_skipped == 1 and plan.no_website == 1
    assert "synthetic-place-0004" not in plan.listing_hosts


def test_skip_list_comes_from_the_gateway_data():
    from scamshield.intel import lists

    for site in lists.words("services", "listing_neutral_sites") + lists.words("services", "search_ignore_sites"):
        assert audit_script.is_skipped(site) and audit_script.is_skipped("www." + site)
    assert not audit_script.is_skipped("bakery-lapsed.test")


def test_invalid_links_are_counted_not_checked():
    plan = audit_script.plan_checks([{"id": "x", "urls": ["not a url", "javascript:alert(1)"]}])
    assert plan.hosts == {} and plan.invalid_links == 2


def test_limit_caps_distinct_hosts(places):
    plan = audit_script.plan_checks(places, limit=2)
    assert list(plan.hosts) == ["bakery-lapsed.test", "clinic.example.com"]


# ---- Category mapping --------------------------------------------------------------------------------------------

@pytest.mark.parametrize("decision, codes, expected", [
    ("block", ["page.parked", "page.harmful_redirect", "rule.takeover_block"], "harmful_redirect"),
    ("block", ["page.gambling"], "harmful_redirect"),
    ("block", ["rep.blocklisted"], "feed_listed"),
    ("block", ["domain.newly_registered", "page.wallet_drainer"], "data_theft"),
    ("warn", ["page.exfiltration", "rep.blocklisted"], "data_theft"),
    ("warn", ["page.unrelated_redirect", "rule.unrelated_redirect_floor"], "unrelated_redirect"),
    ("warn", ["page.parked", "rule.parked_floor"], "parked"),
    ("warn", ["domain.lookalike"], "brand_mismatch"),
    ("warn", ["url.suspicious_tld", "model.url"], "other_warning"),
    ("allow", ["page.unreachable"], "none"),
    ("allow", ["page.parked"], "none"),
    ("allow", [], "none"),
])
def test_category_from_reason_codes(decision, codes, expected):
    v = verdict("https://x.test/", decision, 50.0, *(reason(c, 5) for c in codes))
    assert audit_script.categorise(v) == expected
    assert expected in audit_script.FINDINGS


def test_top_reasons_keep_order_and_both_languages():
    v = verdict("https://x.test/", "block", 90.0, reason("page.parked", 6, "low"), reason("page.harmful_redirect", 20),
                reason("rule.takeover_block", 0, "critical"), reason("domain.established", -10, "info"),
                reason("model.url", 3, "medium"))
    top = audit_script.top_reasons(v)
    assert [r["code"] for r in top] == ["page.harmful_redirect", "page.parked", "model.url"]
    assert top[0] == {"code": "page.harmful_redirect", "en": "page.harmful_redirect en", "ar": "page.harmful_redirect ar"}


def test_model_scores_are_not_reasons_on_an_allowed_site():
    v = verdict("https://x.test/", "allow", 7.0, reason("model.url", 0, "medium"))
    assert audit_script.top_reasons(v) == []


# ---- Audit and output shape --------------------------------------------------------------------------------------

def test_audit_records_one_per_listing_with_the_worst_website(places):
    engine = FakeEngine()
    records, plan = asyncio.run(audit_script.audit(places, engine, concurrency=3))
    assert sorted(engine.calls) == sorted(plan.hosts.values())  # one engine call per distinct host
    got = by_id(records)
    assert set(got) == {"synthetic-place-0001", "synthetic-place-0002", "synthetic-place-0003",
                        "synthetic-place-0006", "synthetic-place-0007", "synthetic-place-0008"}
    garage = got["synthetic-place-0008"]
    assert garage["category"] == "harmful_redirect" and garage["decision"] == "block"
    assert garage["finding_en"] == audit_script.FINDINGS["harmful_redirect"][0] and garage["finding_ar"]
    assert garage["reasons_en"][0] == "page.harmful_redirect en" and garage["reasons_ar"][0] == "page.harmful_redirect ar"
    assert garage["final_url"] == "https://casino.example.net/" and garage["evidence_ref"] == "MRS-TEST-0001"
    assert garage["portal_path"] == "#/places/search/garage-takeover.test"
    assert got["synthetic-place-0001"]["category"] == "parked"
    assert got["synthetic-place-0002"]["website"] == "bakery-lapsed.test"  # the listing's own spelling
    clinic = got["synthetic-place-0003"]
    assert clinic["host"] == "parked-clinic.test" and len(clinic["websites"]) == 2  # riskier of two websites leads
    assert clinic["category"] == "none"
    for record in records:
        assert set(record) == RECORD_FIELDS


def test_engine_errors_become_check_failed_records(places):
    records, _ = asyncio.run(audit_script.audit(places, FakeEngine(fail={"garage-takeover.test"})))
    garage = by_id(records)["synthetic-place-0008"]
    assert garage["category"] == "not_checked" and garage["decision"] is None and "503" in garage["error"]


def test_helpline_check_flags_a_brand_name_on_a_non_official_website(places):
    records, _ = asyncio.run(audit_script.audit(places, FakeEngine()))
    got = by_id(records)
    flag = got["synthetic-place-0006"]["helpline"]
    assert flag["brand"] == "Example Bank" and flag["reasons"] == ["website_not_official"]
    assert flag["website_hosts_not_official"] == ["examplebank-help.test"]
    assert got["synthetic-place-0007"]["helpline"] is None  # the brand's own domain
    assert got["synthetic-place-0001"]["helpline"] is None  # no brand in the name


def test_main_writes_json_and_csv_and_prints_counts_only(places, tmp_path, monkeypatch, capsys):
    engine = FakeEngine()
    monkeypatch.setattr(audit_script, "engine_reachable", lambda _url: None)
    monkeypatch.setattr(audit_script, "http_engine", lambda _url: engine)
    out, out_csv = tmp_path / "data" / "audit.json", tmp_path / "data" / "audit.csv"
    assert audit_script.main(["--places", str(FIXTURE), "--out", str(out), "--csv", str(out_csv)]) == 0
    report = json.loads(out.read_text(encoding="utf-8"))
    assert set(report) == {"format", "generator", "generated_at", "source", "engine_version", "counts", "summary",
                           "categories", "records"}
    assert report["format"] == "mirsad-places-website-checks/1" and report["source"]["mode"] == "engine"
    assert report["source"]["engine"] == audit_script.DEFAULT_ENGINE and report["engine_version"]
    assert report["counts"] == {"harmful_redirect": 1, "data_theft": 0, "feed_listed": 0, "brand_mismatch": 1,
                                "unrelated_redirect": 0, "parked": 2, "other_warning": 0, "none": 2, "not_checked": 0}
    assert report["summary"]["hosts_checked"] == 6 and report["summary"]["helpline_flags"] == 1
    with out_csv.open(encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    assert [r["place_id"] for r in rows] == [r["place_id"] for r in report["records"]]
    assert set(rows[0]) == set(audit_script.CSV_COLUMNS)
    printed = capsys.readouterr().out
    assert "harmful_redirect" in printed
    for place in places:  # names and phones go to the report files only
        assert place["name"] not in printed
        assert all(phone not in printed for phone in place["phones"])


def test_main_stops_when_the_engine_is_unreachable(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(audit_script, "engine_reachable", lambda _url: "ConnectionRefusedError")
    out = tmp_path / "audit.json"
    assert audit_script.main(["--places", str(FIXTURE), "--out", str(out)]) == 2
    assert not out.exists() and "not reachable" in capsys.readouterr().err


def test_dry_run_lists_hosts_and_writes_nothing(tmp_path, capsys):
    out = tmp_path / "audit.json"
    assert audit_script.main(["--places", str(FIXTURE), "--out", str(out), "--dry-run"]) == 0
    printed = capsys.readouterr().out
    assert "would check 6 distinct hosts" in printed and "bakery-lapsed.test" in printed
    assert "1 listing(s) name a registered brand" in printed
    assert not out.exists()


# ---- Stored verdicts --------------------------------------------------------------------------------------------

def make_verdict_db(path: Path) -> None:
    """A tiny database in the engine store's schema (src/scamshield/engine/store.py)."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE verdicts (id TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, decision TEXT,
            risk_score REAL, stage TEXT, final INTEGER, created_at REAL, updated_at REAL, json TEXT NOT NULL);
        CREATE TABLE verdict_versions (id TEXT PRIMARY KEY, version TEXT);
    """)
    rows = [
        # matched by normalised URL (the listing writes www. and a trailing slash differently)
        ("a1b2c3d4e5f6", "https://bakery-lapsed.test/", ANSWERS["bakery-lapsed.test"]("https://bakery-lapsed.test/"), 1.0),
        # an older verdict for the same host loses to the newer one
        ("00000000aaaa", "https://garage-takeover.test/", verdict("https://garage-takeover.test/", "allow", 3.0), 1.0),
        ("feedfacecafe", "https://garage-takeover.test/", ANSWERS["garage-takeover.test"]("https://garage-takeover.test/"), 2.0),
        # matched by host only: the stored URL is a different page of the same site
        ("bead00000001", "https://clinic.example.com/about", ANSWERS["clinic.example.com"]("https://clinic.example.com/about"), 1.0),
    ]
    for vid, url, data, updated in rows:
        data = {**data, "id": vid, "host": audit_script.urlsplit(url).hostname, "evidence_ref": None}
        db.execute("INSERT INTO verdicts VALUES (?,?,?,?,?,?,?,?,?,?)", (vid, url, data["host"], data["decision"],
                   data["risk_score"], "page", 1, updated, updated, json.dumps(data)))
        db.execute("INSERT INTO verdict_versions VALUES (?,?)", (vid, "v-test"))
    db.commit()
    db.close()


def test_report_from_stored_verdicts(places, tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "engine.db"
    make_verdict_db(db_path)
    before = sorted(p.name for p in tmp_path.iterdir())
    monkeypatch.setattr(audit_script, "engine_reachable", lambda _url: pytest.fail("no engine in --verdict-db mode"))
    out = tmp_path / "data" / "checks.json"
    assert audit_script.main(["--places", str(FIXTURE), "--verdict-db", str(db_path), "--out", str(out)]) == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(before + ["data"])  # nothing written beside the db
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["source"]["mode"] == "verdict-db" and report["source"]["verdict_db"] == "engine.db"
    assert report["engine_version"] == "v-test"
    got = by_id(report["records"])
    assert got["synthetic-place-0001"]["category"] == "parked" and got["synthetic-place-0002"]["category"] == "parked"
    garage = got["synthetic-place-0008"]
    assert garage["category"] == "harmful_redirect" and garage["verdict_id"] == "feedfacecafe"
    assert garage["evidence_ref"] == "SS-FEEDFACE"  # derived from the id, as the engine's serializer does
    assert got["synthetic-place-0003"]["websites"][0]["category"] == "none"  # clinic.example.com by host
    assert got["synthetic-place-0006"]["category"] == "not_checked"  # no stored verdict for examplebank-help.test
    assert got["synthetic-place-0006"]["error"] == "no stored verdict for this website"
    assert all(set(r) == RECORD_FIELDS for r in report["records"])


def test_verdict_db_must_exist(tmp_path, capsys):
    assert audit_script.main(["--places", str(FIXTURE), "--verdict-db", str(tmp_path / "absent.db"),
                              "--out", str(tmp_path / "x.json")]) == 2
    assert "verdict_db_missing" in capsys.readouterr().err
