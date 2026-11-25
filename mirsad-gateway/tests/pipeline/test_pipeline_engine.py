"""Investigation pipeline: short-circuits, reuse, joining, deep-crawl revocation and review."""

from __future__ import annotations

import asyncio
import csv
import json

import pytest

from pipeline_fakes import CARD_FORM, FRESH, OLD_BANK, TELEGRAM, World, page
from scamshield import config
from scamshield.engine import pipeline
from scamshield.engine.pipeline import Components, Engine
from scamshield.engine.rules import parse_url
from scamshield.engine.store import Store
from scamshield.schemas import BrandMatch, Decision, DomainIntel, ReviewOutcome, Stage

ADCB_BRAND = BrandMatch(brand="ADCB", brand_ar="بنك أبوظبي التجاري", category="bank", official_domains=["adcb.com"],
                        technique="typosquat", score=0.6)


async def collect(engine: Engine, coro, *, types=None, settle: bool = True):
    """Run `coro` and return (result, events published meanwhile)."""
    events = []
    async with engine.store.bus.subscribe() as queue:
        result = await coro
        if settle:
            await engine.drain()
        while not queue.empty():
            event = queue.get_nowait()
            if types is None or event["type"] in types:
                events.append(event)
    return result, events


def scam_site(world: World, domain: str = "acbd-online.com") -> str:
    world.intel[domain] = FRESH.model_copy(update={"registered_domain": domain})
    world.brands[domain] = ADCB_BRAND
    url = f"https://{domain}/"
    world.pages[url] = page(url, text="Your card has been blocked. Verify your account within 24 hours.", forms=[CARD_FORM])
    return url


async def test_allowlisted_bank_short_circuits_and_is_never_blocked(engine, world):
    world.allow["adcb.com"] = "ADCB"
    world.pages["https://www.adcb.com/"] = page("https://www.adcb.com/", forms=[CARD_FORM], scripts=[TELEGRAM])
    world.url_scores["adcb.com"] = 0.99
    v = await engine.investigate("https://www.adcb.com/")
    assert v.decision == Decision.ALLOW and v.stage == Stage.REPUTATION and v.final
    assert world.calls["fetch"] == 0 and v.reasons[0].code == "rep.allowlisted"
    assert v.timings_ms["layer0_reputation"] < 50
    assert engine.store.host("www.adcb.com").decision == "allow"


async def test_blocklisted_host_is_blocked_without_fetch(engine, world):
    world.block.add("known-bad.xyz")
    v = await engine.investigate("http://login.known-bad.xyz/x")
    assert v.decision == Decision.BLOCK and v.stage == Stage.REPUTATION and v.final
    assert world.calls["fetch"] == 0


async def test_url_listed_in_a_feed_is_blocked(engine, world):
    world.block_urls.add("https://compromised.example/wp/pay.php")
    v = await engine.investigate("https://compromised.example/wp/pay.php?x=1".split("?")[0])
    assert v.decision == Decision.BLOCK and v.stage == Stage.REPUTATION
    assert v.reasons[0].evidence["sources"] == ["urlfeed"]


async def test_listed_shortener_blocks_only_the_listed_link(engine, world):
    world.block.add("bit.ly")
    world.block_urls.add("https://bit.ly/scam1")
    listed = await engine.investigate("https://bit.ly/scam1", background=False)
    assert listed.decision == Decision.BLOCK and listed.reasons[0].evidence["sources"] == ["urlfeed"]
    other = await engine.investigate("https://bit.ly/other", background=False)
    assert not any(r.code == "rep.blocklisted" for r in other.reasons)


async def test_depth_url_stops_before_the_page(engine, world):
    v = await engine.investigate("https://some-shop.example/", depth="url")
    assert v.stage == Stage.URL and world.calls["fetch"] == 0 and "layer1_url" in v.timings_ms


async def test_url_layer_blocks_obvious_lookalike_without_fetch(engine, world):
    domain = "uaepass-login-verify.top"
    world.intel[domain] = FRESH
    world.brands[domain] = BrandMatch(brand="UAE PASS", brand_ar="الهوية الرقمية", official_domains=["uaepass.ae"], score=1.0, technique="combosquat")
    v = await engine.investigate(f"http://{domain}/secure", background=False)
    assert v.decision == Decision.BLOCK and v.stage == Stage.URL and world.calls["fetch"] == 0
    assert v.reasons[0].code == "domain.lookalike"


async def test_top_ranked_domain_is_allowed_at_url_layer(engine, world):
    world.intel["bigportal.com"] = DomainIntel(host="bigportal.com", registered_domain="bigportal.com", popularity_rank=120, age_days=9000)
    v = await engine.investigate("https://www.bigportal.com/news")
    assert v.decision == Decision.ALLOW and v.stage == Stage.URL and world.calls["fetch"] == 0


async def test_url_model_alone_only_escalates(engine, world):
    world.url_scores["odd-but-fine.com"] = 0.99
    world.pages["https://odd-but-fine.com/"] = page("https://odd-but-fine.com/")
    v = await engine.investigate("https://odd-but-fine.com/", background=False)
    assert world.calls["fetch"] == 1 and v.stage == Stage.PAGE and v.decision != Decision.BLOCK


async def test_page_layer_blocks_brand_impersonation_with_card_form(engine, world):
    url = scam_site(world)
    v = await engine.investigate(url, background=False)
    assert v.decision == Decision.BLOCK and v.stage == Stage.PAGE and v.final
    codes = {r.code for r in v.reasons}
    assert {"page.sensitive_form_off_brand", "domain.lookalike", "domain.newly_registered"} <= codes
    assert v.summary_ar and v.summary_en.startswith("Blocked")
    assert all(k in v.timings_ms for k in ("layer0_reputation", "layer1_url", "layer2_page", "fetch_page", "total"))


async def test_shortener_is_expanded_and_never_scored_itself(engine, world):
    world.url_scores["bit.ly"] = 0.99
    target = scam_site(world)
    world.pages["https://bit.ly/abc"] = page("https://bit.ly/abc", final_url=target, forms=[CARD_FORM], text="pay now")
    v = await engine.investigate("https://bit.ly/abc", background=False)
    assert "models.score_url" not in v.timings_ms
    assert v.domain.registered_domain == "acbd-online.com" and v.decision == Decision.BLOCK


async def test_recent_verdict_is_reused(engine, world):
    world.pages["https://shop.example/"] = page("https://shop.example/")
    first = await engine.investigate("https://shop.example/", background=False)
    second = await engine.investigate("https://shop.example/", background=False)
    assert second.id == first.id and world.calls["fetch"] == 1 and "layer0_cache_hit" in second.timings_ms


async def test_unchanged_page_reuses_previous_analysis(engine, world, monkeypatch):
    monkeypatch.setattr(config, "VERDICT_TTL_S", 0)
    monkeypatch.setattr(pipeline, "FRESH_REUSE_S", 0)
    world.pages["https://shop.example/"] = page("https://shop.example/")
    first = await engine.investigate("https://shop.example/", background=False)
    world.pages["https://shop.example/"] = page("https://shop.example/", content_hash="0f0f0f0f0f0f0f0e")
    second = await engine.investigate("https://shop.example/", background=False)
    assert second.id != first.id and world.calls["fetch"] == 2
    assert world.calls["score_page"] == 1
    assert any(r.code == "page.unchanged" for r in second.reasons)


async def test_infrastructure_change_forces_reanalysis(engine, world, monkeypatch):
    monkeypatch.setattr(config, "VERDICT_TTL_S", 0)
    monkeypatch.setattr(pipeline, "FRESH_REUSE_S", 0)
    world.intel["shop.example"] = DomainIntel(host="shop.example", registered_domain="shop.example", asn=100, nameservers=["ns1.hostA.net"])
    world.pages["https://shop.example/"] = page("https://shop.example/")
    await engine.investigate("https://shop.example/", background=False)
    world.intel["shop.example"] = DomainIntel(host="shop.example", registered_domain="shop.example", asn=200, nameservers=["ns1.hostB.net"])
    second = await engine.investigate("https://shop.example/", background=False)
    assert world.calls["score_page"] == 2
    change = next(r for r in second.reasons if r.code == "host.infrastructure_changed")
    assert "AS100" in change.title_en
    kinds = {c["kind"] for c in await engine.store.host_changes("shop.example")}
    assert {"network", "nameservers"} <= kinds
    row = engine.store.host_row("shop.example")
    assert row["changes"] == 2 and row["last_change_kind"] in kinds and row["last_changed"]


async def test_concurrent_identical_checks_join_one_investigation(engine, world):
    world.fetch_delay = 0.2
    world.pages["https://slow.example/"] = page("https://slow.example/")
    results = await asyncio.gather(*(engine.investigate("https://slow.example/", background=False) for _ in range(5)))
    assert len({v.id for v in results}) == 1 and world.calls["fetch:https://slow.example/"] == 1


async def test_wait_ms_returns_partial_verdict(engine, world):
    world.fetch_delay = 0.5
    world.pages["https://slow.example/"] = page("https://slow.example/")
    partial = await engine.investigate("https://slow.example/", wait_ms=100, background=False)
    assert not partial.final and partial.stage in (Stage.REPUTATION, Stage.URL)
    full = await engine.investigate("https://slow.example/", background=False)
    assert full.stage == Stage.PAGE and full.id == partial.id


async def test_deep_crawl_finding_revokes_allow(engine, world):
    world.intel["quiet-shop.example"] = DomainIntel(host="quiet-shop.example", registered_domain="quiet-shop.example", age_days=40)
    home = "https://quiet-shop.example/"
    world.pages[home] = page(home, links=["/about", "/account/login", "https://other.example/x", "/logo.png"])
    world.pages[home + "about"] = page(home + "about")
    world.pages[home + "account/login"] = page(home + "account/login", forms=[CARD_FORM], scripts=[TELEGRAM])
    v, events = await collect(engine, engine.investigate(home), types={"verdict.revoked"})
    assert v.decision == Decision.ALLOW and not v.final
    stored = await engine.store.get_verdict(v.id)
    assert stored.decision == Decision.BLOCK and stored.stage == Stage.DEEP and stored.final
    codes = [r.code for r in stored.reasons]
    assert len(codes) == len(set(codes) - {"engine.component_error"}) + codes.count("engine.component_error")
    revoked = next(r for r in stored.reasons if r.code == "deep.revoked")
    assert revoked.evidence["page_url"].endswith("/account/login")
    assert world.calls["fetch:https://quiet-shop.example/account/login"] == 1
    assert world.calls["fetch:https://other.example/x"] == 0 and world.calls["fetch:https://quiet-shop.example/logo.png"] == 0
    host = engine.store.host("quiet-shop.example")
    assert host.decision == "block" and host.revoked
    assert [e["verdict_id"] for e in events] == [v.id]

    # After a scoring-code change the revocation still stands: a page-level check cannot clear it ...
    host.version, host.updated_at = "older-scoring-code", host.updated_at - config.VERDICT_TTL_S - 1
    assert not engine.store.is_stale(host) and host in engine.store.stale_hosts()
    later = await engine.investigate(home + "about", background=False)
    assert later.decision == Decision.ALLOW and engine.store.host("quiet-shop.example").revoked
    # ... only the deep re-check of stale hosts can; here the card form has been taken down meanwhile.
    world.pages[home + "account/login"] = page(home + "account/login")
    engine.start_stale_recheck()
    await engine.drain()
    host = engine.store.host("quiet-shop.example")
    assert host.stage == Stage.DEEP.value and host.decision == "allow" and not host.revoked
    assert host.gateway_view()["revoked"] is False


async def test_clean_deep_crawl_finalises_allow(engine, world):
    home = "https://plain.example/"
    world.pages[home] = page(home, links=["/a"])
    world.pages[home + "a"] = page(home + "a")
    v, events = await collect(engine, engine.investigate(home), types={"verdict.revoked", "verdict.updated"})
    stored = await engine.store.get_verdict(v.id)
    assert stored.decision == Decision.ALLOW and stored.stage == Stage.DEEP and stored.final and stored.pages_crawled == 1
    assert not any(e["type"] == "verdict.revoked" for e in events)


async def test_review_overturn_unblocks_host_and_publishes_event(engine, world):
    world.review_outcome = ReviewOutcome.OVERTURNED
    url = scam_site(world)
    v, events = await collect(engine, engine.investigate(url), types={"verdict.reviewed"})
    assert v.decision == Decision.BLOCK
    stored = await engine.store.get_verdict(v.id)
    assert stored.review.outcome == ReviewOutcome.OVERTURNED and stored.decision == Decision.ALLOW
    reason = next(r for r in stored.reasons if r.code == "review.overturned")
    assert reason.points < 0 and reason.detail == "reviewer: overturned"
    assert engine.store.host("acbd-online.com").decision == "allow"
    assert events == [{**events[0], "verdict_id": v.id, "host": "acbd-online.com", "outcome": "overturned", "decision": "allow"}]


async def test_overturned_host_is_not_reblocked_while_page_unchanged(engine, world, monkeypatch):
    world.review_outcome = ReviewOutcome.OVERTURNED
    url = scam_site(world)
    await collect(engine, engine.investigate(url))
    monkeypatch.setattr(config, "VERDICT_TTL_S", 0)
    monkeypatch.setattr(pipeline, "FRESH_REUSE_S", 0)
    again = await engine.investigate(url)
    await engine.drain()
    assert again.decision == Decision.ALLOW and world.calls["review"] == 1
    assert any(r.code == "page.unchanged" for r in again.reasons)


async def test_review_confirms_block(engine, world):
    world.review_outcome = ReviewOutcome.CONFIRMED
    v, events = await collect(engine, engine.investigate(scam_site(world)), types={"verdict.reviewed"})
    stored = await engine.store.get_verdict(v.id)
    assert stored.decision == Decision.BLOCK and stored.review.outcome == ReviewOutcome.CONFIRMED
    assert any(r.code == "review.confirmed" for r in stored.reasons)
    assert engine.store.host("acbd-online.com").decision == "block" and events[0]["outcome"] == "confirmed"


async def test_review_failure_leaves_block_in_place(engine, world):
    world.review_error = RuntimeError("reviewer offline")
    v, events = await collect(engine, engine.investigate(scam_site(world)), types={"verdict.reviewed"})
    stored = await engine.store.get_verdict(v.id)
    assert stored.decision == Decision.BLOCK and stored.review is None and events == []
    assert any(r.code == "engine.component_error" and r.evidence["component"] == "review_verdict" for r in stored.reasons)
    assert engine.store.host("acbd-online.com").decision == "block"


async def test_review_disabled_by_switch(world, tmp_path):
    eng = await Engine(Store(tmp_path / "db.sqlite"), world.components(), review_enabled=False).start()
    try:
        await eng.investigate(scam_site(world))
        await eng.drain()
        assert world.calls["review"] == 0
    finally:
        await eng.close()


async def test_every_component_failing_still_yields_a_verdict(tmp_path):
    def boom(*args, **kwargs):
        raise RuntimeError("down")

    async def aboom(*args, **kwargs):
        raise RuntimeError("down")

    components = Components(reputation=boom, assess_domain=aboom, match_brand=boom, score_url=boom, score_page=boom,
                            fetch_page=aboom, review_verdict=aboom, link_campaign=boom, list_campaigns=boom,
                            build_pack=None, cloaking_probe=None)
    eng = await Engine(Store(tmp_path / "db.sqlite"), components).start()
    try:
        v = await eng.investigate("https://anything.example/", background=False)
        assert v.stage == Stage.PAGE and v.decision == Decision.ALLOW
        failed = {r.evidence["component"] for r in v.reasons if r.code == "engine.component_error"}
        assert {"reputation", "assess_domain", "score_url", "fetch_page"} <= failed
    finally:
        await eng.close()


async def test_missing_modules_are_reported_not_raised():
    components = Components()
    with pytest.raises(LookupError):
        Components(fetch_page=None).get("fetch_page")
    assert set(components.status()) == set(Components.PACKAGES)


async def test_old_bank_with_login_and_otp_is_allowed(engine, world):
    world.intel["bigbank.ae"] = OLD_BANK
    world.url_scores["bigbank.ae"] = 0.9
    world.page_score = 0.7
    url = "https://www.bigbank.ae/login"
    world.pages[url] = page(url, forms=[CARD_FORM], text="Sign in to online banking. Enter OTP.")
    v = await engine.investigate(url, background=False)
    assert v.decision == Decision.ALLOW, [(r.code, r.points) for r in v.reasons]


async def test_visit_counter_survives_restart(tmp_path):
    store = Store(tmp_path / "visits.db")
    await store.open()
    for _ in range(5):
        store.record_visit("busy.example")
    assert store.visits("busy.example").total == 5
    await store.close()
    reopened = Store(tmp_path / "visits.db")
    await reopened.open()
    try:
        visits = reopened.visits("busy.example")
        assert visits.total == 5 and visits.last_24h(visits.last_seen)[-1] == 5 and visits.first_seen <= visits.last_seen
    finally:
        await reopened.close()


async def test_content_change_is_recorded(engine, world, monkeypatch):
    monkeypatch.setattr(config, "VERDICT_TTL_S", 0)
    monkeypatch.setattr(pipeline, "FRESH_REUSE_S", 0)
    world.pages["https://shop.example/"] = page("https://shop.example/", content_hash="0000000000000000")
    await engine.investigate("https://shop.example/", background=False)
    world.pages["https://shop.example/"] = page("https://shop.example/", content_hash="ffffffffffffffff")
    await engine.investigate("https://shop.example/", background=False)
    changes = await engine.store.host_changes("shop.example")
    assert {c["kind"] for c in changes} == {"content", "structure"}
    assert changes[0]["new"] == "ffffffffffffffff" or changes[1]["new"] == "ffffffffffffffff"
    assert engine.store.host_row("shop.example")["changes"] == 2


async def test_cached_verdicts_from_other_scoring_code_are_not_reused(world, tmp_path):
    world.pages["https://shop.example/"] = page("https://shop.example/")
    db = tmp_path / "shared.db"
    old = await Engine(Store(db, version="old"), world.components()).start()
    first = await old.investigate("https://shop.example/", background=False)
    await old.close()
    new = await Engine(Store(db, version="new"), world.components()).start()
    try:
        second = await new.investigate("https://shop.example/", background=False)
    finally:
        await new.close()
    assert second.id != first.id and world.calls["fetch"] == 2


async def test_hosts_judged_by_older_code_are_stale_until_rechecked(world, tmp_path):
    world.pages["https://shop.example/"] = page("https://shop.example/")
    db = tmp_path / "shared.db"
    old = await Engine(Store(db, version="old"), world.components()).start()
    await old.investigate("https://shop.example/", background=False)
    await old.close()
    new = await Engine(Store(db, version="new"), world.components()).start()
    try:
        record = new.store.host("shop.example")
        assert new.store.is_stale(record) and new.store.host_row("shop.example")["stale"]
        assert [r.host for r in new.store.stale_hosts()] == ["shop.example"]
        new.start_stale_recheck()
        await new.drain()
        assert not new.store.is_stale(new.store.host("shop.example")) and world.calls["fetch"] == 2
        assert new.store.stale_hosts() == []
    finally:
        await new.close()


async def test_reset_clears_matching_hosts_or_everything(engine, world):
    for host in ("a.example", "b.example", "keep.test"):
        world.pages[f"https://{host}/"] = page(f"https://{host}/")
        await engine.investigate(f"https://{host}/", background=False)
    assert await engine.store.reset("*.example") == 2
    assert engine.store.host("a.example") is None and engine.store.host("keep.test") is not None
    assert [v["host"] for v in await engine.store.recent_verdicts()] == ["keep.test"]
    await engine.store.reset()
    assert engine.store.host_rows() == [] and await engine.store.recent_verdicts() == []


def test_batch_command_writes_rows_in_input_order_and_scores_labels(monkeypatch, tmp_path, capsys, world):
    from scamshield.__main__ import main
    from scamshield.api.batch import DEFAULT_CONCURRENCY

    world.fetch_delay = 0.2  # the first URL needs a page fetch, so it finishes after the allowlisted second one
    world.allow["tamm.abudhabi"] = "Abu Dhabi Government"
    world.intel["tmam-pay.com"] = FRESH
    world.pages["https://slow.example/"] = page("https://slow.example/")
    world.pages["https://tmam-pay.com/"] = page("https://tmam-pay.com/", forms=[CARD_FORM], scripts=[TELEGRAM])
    slots = []

    def engine(**kw):
        slots.append(kw["background_slots"])
        return Engine(Store(tmp_path / "batch.db"), world.components(), **kw)

    monkeypatch.setattr("scamshield.engine.pipeline.Engine", engine)
    src, out = tmp_path / "in.csv", tmp_path / "out.csv"
    src.write_text("url,label\nhttps://slow.example/,legitimate\nhttps://www.tamm.abudhabi/,0\n,1\nhttps://tmam-pay.com/,phishing\n")
    assert main(["batch", str(src), "-o", str(out)]) == 0
    assert slots == [DEFAULT_CONCURRENCY]  # the documented default, not the engine's two background slots
    rows = list(csv.DictReader(out.open()))
    assert [r["url"] for r in rows] == ["https://slow.example/", "https://www.tamm.abudhabi/", "", "https://tmam-pay.com/"]
    assert [r["label_pred"] for r in rows] == ["0", "0", "", "1"] and rows[3]["label"] == "phishing"
    labels = json.loads(capsys.readouterr().out.split("  ", 1)[1])["labels"]
    assert (labels["tp"], labels["fp"], labels["tn"], labels["fn"], labels["unscored"]) == (1, 0, 2, 0, 1)
    assert main(["batch", str(tmp_path / "missing.csv"), "-o", str(out)]) == 2
    assert "No such file" in capsys.readouterr().err


def test_reset_command(monkeypatch, tmp_path, capsys):
    from scamshield.__main__ import main

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "cli.db")
    assert main(["reset", "--hosts", "*.example"]) == 0 and "0 host(s)" in capsys.readouterr().out
    assert main(["reset", "--all"]) == 0 and "everything" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        main(["reset"])


async def test_queued_watcher_checks_do_not_slow_a_user_check(world, tmp_path):
    world.fetch_delay = 0.15
    for i in range(201):
        world.pages[f"https://site{i}.example/"] = page(f"https://site{i}.example/")
    eng = await Engine(Store(tmp_path / "load.db"), world.components(), review_enabled=False).start()
    try:
        t0 = asyncio.get_running_loop().time()
        await eng.investigate("https://site200.example/", background=False)
        idle = asyncio.get_running_loop().time() - t0
        watcher = [asyncio.create_task(eng.investigate(f"https://site{i}.example/", "deep", source="watcher")) for i in range(200)]
        await asyncio.sleep(0.3)
        assert eng.load()["queued"]["watcher"] >= 190 and eng.load()["in_flight"]["watcher"] <= 2
        world.pages["https://user.example/"] = page("https://user.example/")
        t0 = asyncio.get_running_loop().time()
        v = await eng.investigate("https://user.example/", background=False)
        busy = asyncio.get_running_loop().time() - t0
        assert v.stage == Stage.PAGE and busy <= idle * 1.2 + 0.02, (idle, busy)
        for task in watcher:
            task.cancel()
        await asyncio.gather(*watcher, return_exceptions=True)
    finally:
        await eng.close()


async def test_blocks_made_before_a_restart_still_get_their_review(world, tmp_path):
    db = tmp_path / "restart.db"
    before = await Engine(Store(db), world.components(), review_enabled=False).start()
    blocked = await before.investigate(scam_site(world), background=False)
    await before.close()
    assert blocked.decision == Decision.BLOCK and world.calls["review"] == 0
    after = await Engine(Store(db), world.components(), review_enabled=True).start()
    try:
        after.start_stale_recheck()
        await after.drain()
        assert world.calls["review"] == 1 and (await after.store.get_verdict(blocked.id)).review is not None
    finally:
        await after.close()


async def test_arabic_script_domain_is_not_warned_on_the_url_model_alone(engine, world):
    world.url_scores["xn--ngbn6f.xn--mgbaam7a8h"] = 0.99
    url = "https://دبي.امارات/"
    ascii_url = parse_url(url).url
    world.pages[ascii_url] = page(ascii_url)
    v = await engine.investigate(url, background=False)
    assert v.decision == Decision.ALLOW and v.url_model_score is None
    assert not any(r.code == "url.punycode" for r in v.reasons)
