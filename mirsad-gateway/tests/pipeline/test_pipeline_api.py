"""HTTP API contract (docs/ARCHITECTURE.md) against the engine with fake components."""

from __future__ import annotations

import csv
import io
import json
import time

import pytest
from fastapi.testclient import TestClient

from pipeline_fakes import CARD_FORM, FRESH, World, page
from scamshield.api.app import create_app
from scamshield.engine.pipeline import Engine
from scamshield.engine.store import Store
from scamshield.schemas import BrandMatch, ReviewOutcome


@pytest.fixture
def world() -> World:
    w = World()
    w.allow["tamm.abudhabi"] = "Abu Dhabi Government"
    w.intel["tmam-services.com"] = FRESH
    w.brands["tmam-services.com"] = BrandMatch(brand="TAMM", brand_ar="تم", category="government", official_domains=["tamm.abudhabi"], score=0.6)
    w.pages["https://tmam-services.com/"] = page("https://tmam-services.com/", forms=[CARD_FORM], text="Pay your traffic fine of AED 5 today to avoid black points")
    w.pages["https://plain.example/"] = page("https://plain.example/")
    return w


@pytest.fixture
def client(world, tmp_path):
    engine = Engine(Store(tmp_path / "api.db"), world.components(), review_enabled=False)
    with TestClient(create_app(engine)) as c:
        yield c


def test_check_returns_verdict_without_html(client):
    r = client.post("/v1/check", json={"url": "https://tmam-services.com/"})
    assert r.status_code == 200
    body = r.json()
    assert body["decision"] == "block" and body["stage"] == "page" and body["page"]["html"] == ""
    assert body["reasons"][0]["title_ar"] and body["summary_ar"]


def test_check_validates_input(client):
    assert client.post("/v1/check", json={"url": "https://x.example/", "depth": "nope"}).status_code == 422
    assert client.post("/v1/check", json={}).status_code == 422
    for bad in ("not a url", "javascript:alert(1)", "http://", "mailto:a@b.example", "ftp://files.example/x"):
        assert client.post("/v1/check", json={"url": bad}).status_code == 422, bad
    for good in ("plain.example", "HTTPS://PLAIN.EXAMPLE./", "plain.example:8080/x", "http://[2001:db8::1]/", "https://مثال.example/"):
        assert client.post("/v1/check", json={"url": good}).status_code == 200, good


def test_host_endpoint(client):
    assert client.get("/v1/host/never-seen.example").status_code == 404
    client.post("/v1/check", json={"url": "https://www.tamm.abudhabi/en", "depth": "reputation"})
    view = client.get("/v1/host/www.tamm.abudhabi").json()
    assert view["decision"] == "allow" and view["final"] is True
    assert {"decision", "risk_score", "stage", "final", "verdict_id"} <= set(view)


def test_verdict_listing_and_detail(client):
    vid = client.post("/v1/check", json={"url": "https://plain.example/"}).json()["id"]
    listing = client.get("/v1/verdicts?limit=5").json()
    assert listing[0]["id"] == vid and listing[0]["page"]["html"] == ""
    full = client.get(f"/v1/verdicts/{vid}").json()
    assert "<html>" in full["page"]["html"]
    assert client.get("/v1/verdicts/missing").status_code == 404


def test_manual_review_endpoint_answers_202_and_applies_outcome(client, world):
    world.review_outcome = ReviewOutcome.OVERTURNED
    vid = client.post("/v1/check", json={"url": "https://tmam-services.com/"}).json()["id"]
    r = client.post(f"/v1/verdicts/{vid}/review")
    assert r.status_code == 202 and r.json()["verdict_id"] == vid
    deadline = time.monotonic() + 5
    while client.get(f"/v1/verdicts/{vid}").json()["review"] is None and time.monotonic() < deadline:
        time.sleep(0.05)
    reviewed = client.get(f"/v1/verdicts/{vid}").json()
    assert reviewed["review"]["outcome"] == "overturned" and reviewed["decision"] == "allow"
    assert client.get("/v1/host/tmam-services.com").json()["decision"] == "allow"
    assert client.post("/v1/verdicts/missing/review").status_code == 404


def test_source_is_stored_and_batch_marks_its_own(client):
    vid = client.post("/v1/check", json={"url": "https://plain.example/", "source": "watcher"}).json()["id"]
    assert client.get(f"/v1/verdicts/{vid}").json()["source"] == "watcher"
    assert client.post("/v1/check", json={"url": "https://x.example/", "source": "nobody"}).status_code == 422
    client.post("/v1/batch", content="url\nhttps://tmam-services.com/\n")
    assert {v["url"]: v["source"] for v in client.get("/v1/verdicts").json()}["https://tmam-services.com/"] == "batch"


def test_benchmarks_endpoint(client):
    body = client.get("/v1/benchmarks").json()
    assert set(body) == {"results", "markdown"} and isinstance(body["results"], list)


def test_reputation_table_counts_gateway_lookups(client):
    client.post("/v1/check", json={"url": "https://plain.example/", "source": "gateway"})
    for _ in range(3):
        client.get("/v1/host/plain.example")
    client.get("/v1/host/unchecked.example")
    rows = {r["host"]: r for r in client.get("/v1/hosts?sort=visits").json()}
    assert rows["plain.example"]["visits"] == 4 and rows["plain.example"]["visits_24h"] == 4
    assert rows["plain.example"]["reputation"] in ("unknown", "established") and rows["plain.example"]["verdict_id"]
    assert rows["unchecked.example"]["visits"] == 1 and rows["unchecked.example"]["decision"] is None
    assert [r["host"] for r in client.get("/v1/hosts?q=unchecked").json()] == ["unchecked.example"]
    history = client.get("/v1/hosts/plain.example/history").json()
    assert history["visits_hourly"][-1] == 4 and len(history["visits_hourly"]) == 24 and history["verdicts"]
    assert client.get("/v1/hosts/nothing.example/history").status_code == 404
    assert client.get("/v1/hosts?sort=bogus").status_code == 422


def test_batch_csv_round_trip(client):
    data = "id,url\n1,https://tmam-services.com/\n2,https://plain.example/\n3,https://www.tamm.abudhabi/\n"
    r = client.post("/v1/batch?concurrency=2", content=data, headers={"content-type": "text/csv"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert [row["url"] for row in rows] == ["https://tmam-services.com/", "https://plain.example/", "https://www.tamm.abudhabi/"]
    assert {"url", "decision", "risk_score", "label_pred", "top_reasons", "elapsed_ms", "timings_ms", "id"} <= set(rows[0])
    assert "layer2_page" in json.loads(rows[0]["timings_ms"])
    assert [row["label_pred"] for row in rows] == ["1", "0", "0"]
    assert "domain.lookalike" in rows[0]["top_reasons"]


def test_batch_accepts_multipart_and_rejects_missing_column(client):
    files = {"file": ("in.csv", "url\nhttps://plain.example/\n", "text/csv")}
    assert client.post("/v1/batch", files=files).status_code == 200
    assert client.post("/v1/batch", content="").status_code == 400
    assert client.post("/v1/batch", content="name\nx\n").status_code == 400


def test_batch_keeps_every_row_in_order_with_its_input_columns(client):
    """A judge's list lines up row for row: blank, malformed and duplicate rows all come back, in order."""
    data = ("﻿ID,URL,label\r\n1,https://tmam-services.com/,1\r\n2,,1\r\n3,not a url,0\r\n"
            "4,https://plain.example/,0\r\n5,javascript:alert(1),1\r\n6,https://plain.example/,0\r\n"
            "7,hxxps://tmam-services[.]com/,1\r\n8,//plain.example/,0\r\n")
    rows = list(csv.DictReader(io.StringIO(client.post("/v1/batch", content=data).text)))
    assert [r["ID"] for r in rows] == ["1", "2", "3", "4", "5", "6", "7", "8"]
    assert [r["decision"] for r in rows] == ["block", "invalid", "invalid", "allow", "invalid", "allow", "block", "allow"]
    assert [r["label_pred"] for r in rows] == ["1", "", "", "0", "", "0", "1", "0"] and rows[0]["label"] == "1"
    assert rows[6]["url"] == "hxxps://tmam-services[.]com/"  # the input as given; the defanged form was checked
    assert rows[1]["top_reasons"] == "empty URL" and rows[4]["top_reasons"].startswith("not a web address")


def test_batch_reads_a_plain_list_without_header(client):
    rows = list(csv.DictReader(io.StringIO(client.post("/v1/batch", content="plain.example\n\nhttps://tmam-services.com/,1\n").text)))
    assert [(r["url"], r["decision"], r["column2"]) for r in rows] == [
        ("plain.example", "allow", ""), ("", "invalid", ""), ("https://tmam-services.com/", "block", "1")]


def test_campaigns_and_health(client):
    assert client.get("/v1/campaigns").json() == []
    health = client.get("/v1/health").json()
    assert health["ok"] and health["components"]["build_pack"] != "ok"
    assert {"queued", "in_flight", "held_foreground"} <= set(health["load"])


def test_cors_is_permissive(client):
    r = client.options("/v1/check", headers={"Origin": "http://demo.local", "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") in ("*", "http://demo.local")


def test_stale_host_is_not_enforced_by_the_gateway_endpoint(world, tmp_path):
    db = tmp_path / "versions.db"
    with TestClient(create_app(Engine(Store(db, version="old"), world.components(), review_enabled=False))) as old:
        old.post("/v1/check", json={"url": "https://tmam-services.com/"})
        assert old.get("/v1/host/tmam-services.com").json()["decision"] == "block"
    world.pages.clear()  # the background re-check must not settle it during this test
    world.fetch_delay = 5
    with TestClient(create_app(Engine(Store(db, version="new"), world.components(), review_enabled=False))) as new:
        assert new.get("/v1/host/tmam-services.com").status_code == 404
        row = next(r for r in new.get("/v1/hosts").json() if r["host"] == "tmam-services.com")
        assert row["stale"] is True and row["decision"] == "block"


def test_dashboard_and_api_send_protective_headers(client):
    page_ = client.get("/")
    assert "script-src 'self'" in page_.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in page_.headers["content-security-policy"]
    api = client.get("/v1/verdicts")
    assert api.headers["x-content-type-options"] == "nosniff" and "content-security-policy" not in api.headers


def test_batch_upload_size_and_count_are_limited(client, monkeypatch):
    from scamshield.api import app as app_module

    monkeypatch.setattr(app_module, "MAX_BATCH_BYTES", 64)
    assert client.post("/v1/batch", content="url\n" + "https://plain.example/\n" * 10).status_code == 413
    monkeypatch.setattr(app_module, "MAX_BATCH_BYTES", 10_000)
    monkeypatch.setattr(app_module, "MAX_BATCH_URLS", 2)
    urls = "".join(f"https://plain.example/{i}\n" for i in range(3))
    assert client.post("/v1/batch", content="url\n" + urls).status_code == 413
