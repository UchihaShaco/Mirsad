import json

import pytest

from scamshield import config
from scamshield.engine.fetch import MAX_HTML_BYTES, cloaking_probe, fetch_page, http_get


async def test_benign_shop_english_and_arabic(sites):
    en = await fetch_page(f"{sites.site}/shop")
    ar = await fetch_page(f"{sites.site}/ar/shop")
    assert en.error is None and en.status == 200 and en.redirect_chain == []
    assert en.title == "Oasis Market - local products" and en.lang == "en"
    assert "Cash on delivery" in en.text and f"{sites.site}/about" in en.links
    assert ar.lang == "ar" and "الدفع عند الاستلام" in ar.text
    for snap in (en, ar):
        assert len(snap.forms) == 1 and not snap.forms[0].external_action
        form = snap.forms[0]
        assert not (form.asks_password or form.asks_card or form.asks_otp or form.asks_national_id)
        assert snap.favicon_hash and snap.content_hash and snap.structure_hash and not snap.needs_js


async def test_credential_harvester_posts_to_another_host(sites):
    snap = await fetch_page(f"{sites.site}/login")
    form = snap.forms[0]
    assert form.method == "post" and form.external_action
    assert form.action == f"{sites.collector}/collect" and form.action_host == "127.0.0.1"
    assert form.asks_password and form.asks_otp and not form.asks_card
    assert "127.0.0.1" in snap.external_hosts


async def test_arabic_harvester_fields_detected_from_labels(sites):
    form = (await fetch_page(f"{sites.site}/ar/login")).forms[0]
    assert form.asks_password and form.asks_national_id and form.asks_otp and form.asks_phone
    assert form.input_names == ["u", "p", "eid", "m", "c"]


async def test_card_fee_scam(sites):
    form = (await fetch_page(f"{sites.site}/card")).forms[0]
    assert form.asks_card and not form.asks_password


async def test_redirect_chain_http_meta_js(sites):
    snap = await fetch_page(f"{sites.site}/chain/start")
    assert [h.via for h in snap.redirect_chain] == ["http", "meta", "js"]
    assert [h.url for h in snap.redirect_chain] == [
        f"{sites.site}/chain/start", f"{sites.site}/chain/meta", f"{sites.collector}/chain/js",
    ]
    assert snap.redirect_chain[0].status == 302 and all(h.ip == "127.0.0.1" for h in snap.redirect_chain)
    assert snap.final_url == f"{sites.site}/login" and snap.forms[0].asks_password


async def test_redirect_loop_stops(sites):
    snap = await fetch_page(f"{sites.site}/loop")
    assert snap.error.startswith("too many redirects")
    assert len(snap.redirect_chain) == config.MAX_REDIRECTS + 1


async def test_empty_shell_with_scrambled_script_needs_js(sites):
    snap = await fetch_page(f"{sites.site}/shell")
    assert snap.needs_js
    script = next(s for s in snap.scripts if s.src and s.src.endswith("app.min.js"))
    assert script.first_party and script.obfuscated
    assert {"hex_identifiers", "string_array_rotation", "anti_debugging"} <= set(script.obfuscation_markers)


async def test_client_rendered_content_recovered_from_json_endpoint(sites):
    snap = await fetch_page(f"{sites.site}/spa")
    assert not snap.needs_js
    assert "Same day delivery is available in Abu Dhabi" in snap.text
    assert f"{sites.site}/api/page.json" in snap.scripts[0].endpoints


async def test_client_side_gate_reveals_injected_form(sites):
    snap = await fetch_page(f"{sites.site}/gate")
    calls = {c for s in snap.scripts for c in s.suspicious_calls}
    assert {"cloak.user_agent_gate", "bot_detection", "disable_right_click"} <= calls
    injected = [f for f in snap.forms if f.asks_password]
    assert injected and injected[0].external_action and injected[0].action_host == "127.0.0.1"


async def test_non_html_keeps_headers_and_reports_error(sites):
    snap = await fetch_page(f"{sites.site}/download.zip")
    assert snap.status == 200 and snap.html == ""
    assert snap.error.startswith("not html") and snap.headers["content-type"] == "application/zip"


async def test_response_size_is_capped(sites):
    snap = await fetch_page(f"{sites.site}/big")
    assert snap.error is None and len(snap.html.encode()) <= MAX_HTML_BYTES


@pytest.mark.parametrize(
    "profile, platform, mobile, ua_token",
    [("mobile", '"Android"', "?1", "Mobile Safari"), ("desktop", '"Windows"', "?0", "Windows NT 10.0")],
)
async def test_browser_headers_are_coherent(sites, profile, platform, mobile, ua_token):
    raw = await http_get(f"{sites.site}/echo", profile, referer="https://www.google.com/", site="cross-site")
    sent = {k.lower(): v for k, v in json.loads(raw.body).items()}
    assert ua_token in sent["user-agent"] and "Chrome/152" in sent["user-agent"]
    assert sent["sec-ch-ua-platform"] == platform and sent["sec-ch-ua-mobile"] == mobile
    assert "ar" in sent["accept-language"] and sent["sec-fetch-mode"] == "navigate"
    assert sent["referer"] == "https://www.google.com/" and sent["sec-fetch-site"] == "cross-site"
    assert "upgrade" not in sent  # no h2c upgrade offer, which no real browser sends


async def test_crawler_profile_is_obviously_a_bot(sites):
    raw = await http_get(f"{sites.site}/echo", "crawler")
    sent = {k.lower(): v for k, v in json.loads(raw.body).items()}
    assert sent["user-agent"].startswith("python-requests") and "sec-ch-ua" not in sent


async def test_private_targets_refused_without_opt_in(sites, monkeypatch):
    monkeypatch.delenv("SCAMSHIELD_ALLOW_PRIVATE")
    for url in (f"{sites.site}/shop", "http://127.0.0.1:9/", "http://169.254.169.254/latest/meta-data/"):
        snap = await fetch_page(url)
        assert snap.error.startswith("refused") and snap.html == ""


async def test_allowed_network_opens_only_that_subnet(sites, monkeypatch):
    monkeypatch.delenv("SCAMSHIELD_ALLOW_PRIVATE")
    monkeypatch.setenv("SCAMSHIELD_ALLOW_NETWORKS", "127.0.0.0/30")
    assert (await fetch_page(f"{sites.site}/shop")).error is None
    for url in ("http://10.0.0.1:9/", "http://169.254.169.254/latest/meta-data/"):
        assert (await fetch_page(url)).error.startswith("refused")


@pytest.mark.parametrize("url", ["http://no-such-host.invalid/", "ftp://example.com/x", "http://[not-an-ip/", ""])
async def test_bad_input_never_raises(url):
    snap = await fetch_page(url)
    assert snap.error


async def test_cloaking_probe_catches_server_side_cloaking(sites):
    report = await cloaking_probe(f"{sites.site}/cloak")
    assert report["verdict"] == "cloaking" and report["cloaking"] and not report["bot_protection"]
    assert "credential_form_hidden_from_crawler" in report["signals"]
    assert report["views"]["mobile_referred"]["sensitive_form"] and not report["views"]["crawler"]["sensitive_form"]
    assert report["comparisons"]["mobile_vs_crawler"]["content_distance"] > config.HASH_SAME_PAGE_DISTANCE


async def test_cloaking_probe_consistent_site(sites):
    report = await cloaking_probe(f"{sites.site}/shop")
    assert report["verdict"] == "consistent" and report["signals"] == []


@pytest.mark.parametrize("path", ["/botwall", "/challenge"])
async def test_bot_wall_is_bot_protection_not_cloaking(sites, path):
    report = await cloaking_probe(f"{sites.site}{path}")
    assert report["verdict"] == "bot_protection" and report["bot_protection"] and not report["cloaking"]
    assert report["signals"] == ["crawler_refused_or_challenged"]
    assert report["views"]["mobile_referred"]["sensitive_form"] and not report["comparisons"]["mobile_vs_crawler"]["comparable"]


async def test_cloaking_probe_reuses_the_callers_mobile_snapshot(sites):
    mobile = await fetch_page(f"{sites.site}/cloak")
    report = await cloaking_probe(f"{sites.site}/cloak", mobile=mobile)
    assert report["verdict"] == "cloaking"
    assert report["views"]["mobile_referred"]["elapsed_ms"] == mobile.elapsed_ms


async def test_timings_break_down_each_phase(sites):
    snap = await fetch_page(f"{sites.site}/chain/start")
    assert {"dns", "document", "parse", "inline_js", "assets", "total"} <= set(snap.timings_ms)
    assert snap.timings_ms["total"] == snap.elapsed_ms >= snap.timings_ms["document"] >= snap.timings_ms["dns"]
