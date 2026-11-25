from datetime import datetime, timezone

from scamshield.schemas import BrandMatch, Decision, DomainIntel, FormInfo, PageSnapshot, ScriptFinding, Verdict
from scamshield.watch.campaigns import COMMON_MIN_NODES, features, link_campaign, list_campaigns, rebuild_edges

KIT_HASH = "f0e1d2c3b4a59687"
KIT_HASH_NEAR = "f0e1d2c3b4a59686"  # Hamming distance 1
OTHER_HASH = "0123456789abcdef"


KIT_TEXT = "Pay your outstanding traffic fine now to avoid additional penalties and black points. " * 2


def verdict(host: str, *, ips=(), ns=(), registrar=None, created=None, sans=(), favicon=None, structure=None,
            content=None, html="", text=KIT_TEXT, forms=(), scripts=(), brand="TAMM", decision=Decision.BLOCK,
            asn_org=None) -> Verdict:
    return Verdict(
        url=f"https://{host}/", host=host, registered_domain=host, decision=decision, risk_score=85.0,
        brand=BrandMatch(brand=brand) if brand else None,
        domain=DomainIntel(host=host, registered_domain=host, ips=list(ips), nameservers=list(ns), registrar=registrar,
                           created=created, tls_sans=list(sans), asn_org=asn_org),
        page=PageSnapshot(url=f"https://{host}/", final_url=f"https://{host}/", html=html, text=text, favicon_hash=favicon,
                          structure_hash=structure, content_hash=content, forms=list(forms), scripts=list(scripts)),
    )


def test_same_telegram_bot_links_domains():
    bot = "fetch('https://api.telegram.org/bot7012345678:AAHk3jsdf8sdf9sdf8sdf7sdf6sdf5sdf4s/sendMessage')"
    a = link_campaign(verdict("tamm-fines.icu", html=f"<script>{bot}</script>"))
    b = link_campaign(verdict("salik-pay.top", brand="Salik", scripts=[ScriptFinding(endpoints=[bot])]))
    assert a is None  # alone it is not a campaign yet
    assert b is not None
    [c] = list_campaigns()
    assert c["id"] == b and c["size"] == 2
    assert c["brands"] == ["Salik", "TAMM"]
    assert {d["host"] for d in c["domains"]} == {"tamm-fines.icu", "salik-pay.top"}
    assert set(c["domains"][0]) >= {"host", "decision", "risk_score", "verdict_id"}
    assert c["domains"][0]["decision"] == "block" and c["label"].startswith("Salik / TAMM: 2 domains")
    [link] = c["links"]
    assert {link["source"], link["target"]} == {"tamm-fines.icu", "salik-pay.top"}
    assert link["weight"] >= 1.0 and "same Telegram bot 7012345678" in link["shared"]
    assert any(s["kind"] == "exfil" for s in c["shared_attributes"])


def test_same_dedicated_ip_plus_kit_hash_links():
    link_campaign(verdict("tamm-pay.icu", ips=["45.12.34.56"], structure=KIT_HASH))
    cid = link_campaign(verdict("tamm-fine.top", ips=["45.12.34.56"], structure=KIT_HASH_NEAR))
    assert cid is not None
    kinds = {s["kind"] for s in list_campaigns()[0]["shared_attributes"]}
    assert kinds == {"ip", "structure_hash"}  # the /24 is not counted again on top of the same address


def test_cdn_ip_must_not_link():
    """Two unrelated scams on the same Cloudflare anycast address share nothing meaningful."""
    cloudflare = "104.21.32.1"
    assert link_campaign(verdict("tamm-pay.icu", ips=[cloudflare], structure=KIT_HASH, brand="TAMM")) is None
    assert link_campaign(verdict("enbd-login.top", ips=[cloudflare], structure=OTHER_HASH, brand="Emirates NBD")) is None
    assert list_campaigns() == []
    assert features(verdict("x.icu", ips=[cloudflare]))["ip"] == []


def test_cdn_by_asn_org_and_parking_must_not_link():
    link_campaign(verdict("tamm-a.icu", ips=["203.0.113.9"], asn_org="AKAMAI-AS"))
    link_campaign(verdict("tamm-b.icu", ips=["203.0.113.9"], asn_org="AKAMAI-AS"))
    link_campaign(verdict("tamm-c.icu", ips=["15.197.148.33"]))  # GoDaddy parking
    link_campaign(verdict("tamm-d.icu", ips=["15.197.148.33"]))
    assert list_campaigns() == []


def test_popular_registrar_alone_or_default_nameservers_do_not_link():
    day = datetime(2026, 11, 20, tzinfo=timezone.utc)
    ns = ["ns71.domaincontrol.com", "ns72.domaincontrol.com"]
    link_campaign(verdict("tamm-x.icu", registrar="GoDaddy.com, LLC", ns=ns, created=day))
    cid = link_campaign(verdict("enbd-y.top", registrar="GoDaddy.com, LLC", ns=ns, created=day, brand="Emirates NBD"))
    assert cid is None and list_campaigns() == []


def test_specific_nameserver_pair_registrar_and_date_window_link():
    ns = ["ns1.kit-dns-77.xyz", "ns2.kit-dns-77.xyz"]
    link_campaign(verdict("tamm-x.icu", registrar="Gname", ns=ns, created=datetime(2026, 11, 20, tzinfo=timezone.utc)))
    cid = link_campaign(verdict("uaepass-y.top", registrar="Gname", ns=ns, brand="UAE PASS",
                                created=datetime(2026, 11, 22, tzinfo=timezone.utc)))
    assert cid is not None
    shared = list_campaigns()[0]["links"][0]["shared"]
    assert "same nameservers ns1.kit-dns-77.xyz, ns2.kit-dns-77.xyz" in shared
    assert any(s.startswith("same nameservers + registrar") for s in shared)


def test_overlapping_certificate_sans_link():
    link_campaign(verdict("tamm-fines.icu", sans=["tamm-fines.icu", "salik-topup.icu"]))
    assert link_campaign(verdict("salik-topup.icu", brand="Salik")) is not None


def test_same_fake_phone_links_but_official_phone_does_not():
    link_campaign(verdict("enbd-help.top", brand="Emirates NBD", text="Call 600 54 0000"))
    assert link_campaign(verdict("enbd-care.top", brand="Emirates NBD", text="Call ٦٠٠ ٥٤ ٠٠٠٠")) is None
    link_campaign(verdict("enbd-desk.top", brand="Emirates NBD", text="WhatsApp +971 50 000 0105"))
    assert link_campaign(verdict("enbd-desk2.icu", brand="Emirates NBD", text="WhatsApp 050 000 0105")) is not None


def test_same_tracker_id_and_form_endpoint():
    gtm = "<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-AB12CD3');</script>"
    link_campaign(verdict("dewa-refund.icu", brand="DEWA", html=gtm))
    assert link_campaign(verdict("tamm-refund.icu", html=gtm)) is not None
    form = FormInfo(action="https://collect.kitpanel.xyz/save.php?x=1", action_host="collect.kitpanel.xyz",
                    external_action=True)
    link_campaign(verdict("uaepass-a.icu", brand="UAE PASS", forms=[form]))
    assert link_campaign(verdict("uaepass-b.top", brand="UAE PASS", forms=[form])) is not None


def test_weak_signals_alone_do_not_link_but_combine():
    # Same brand + same naming template + same favicon (copied from the official site) = 0.8 < 1.0.
    assert link_campaign(verdict("tamm-pay-11.icu", favicon="abc123")) is None
    assert link_campaign(verdict("tamm-pay-12.icu", favicon="abc123")) is None
    # Adding a near-identical page structure tips it over the threshold.
    link_campaign(verdict("tamm-pay-21.icu", favicon="fav2", structure=KIT_HASH))
    assert link_campaign(verdict("tamm-pay-22.icu", favicon="fav2", structure=KIT_HASH_NEAR)) is not None


def test_transitive_clusters_and_separate_campaigns():
    link_campaign(verdict("a-tamm.icu", ips=["45.1.1.1"], structure=KIT_HASH))
    link_campaign(verdict("b-tamm.icu", ips=["45.1.1.1"], structure=KIT_HASH, html="GTM-ZZ99ZZ9"))
    link_campaign(verdict("c-tamm.icu", html="GTM-ZZ99ZZ9"))  # linked to b only, so to a transitively
    link_campaign(verdict("x-enbd.top", brand="Emirates NBD", html="UA-1234567-1"))
    link_campaign(verdict("y-enbd.top", brand="Emirates NBD", html="UA-1234567-1"))
    camps = list_campaigns()
    assert [c["size"] for c in camps] == [3, 2]
    assert {d["host"] for d in camps[0]["domains"]} == {"a-tamm.icu", "b-tamm.icu", "c-tamm.icu"}
    assert len(camps[0]["links"]) == 2
    assert camps[0]["id"] != camps[1]["id"]


def test_value_common_to_many_nodes_stops_linking():
    """A tracker id (e.g. a hosting provider's default analytics) seen on many unrelated sites links nothing."""
    for i in range(COMMON_MIN_NODES + 1):
        link_campaign(verdict(f"site{i}-tamm.icu", html="G-SHAREDDEF1"))
    assert list_campaigns() == []


def test_allowed_verdicts_are_not_linked():
    bot = "api.telegram.org/bot7012345678:AAHk3jsdf8sdf9sdf8sdf7sdf6sdf5sdf4s"
    assert link_campaign(verdict("tamm.abudhabi", html=bot, decision=Decision.ALLOW)) is None
    assert link_campaign(verdict("tamm-x.icu", html=bot)) is None
    assert list_campaigns() == []


def test_relinking_same_domain_updates_instead_of_duplicating():
    link_campaign(verdict("tamm-a.icu", html="GTM-AAAA111"))
    link_campaign(verdict("tamm-b.icu", html="GTM-AAAA111"))
    link_campaign(verdict("tamm-b.icu", html="GTM-AAAA111"))
    [c] = list_campaigns()
    assert c["size"] == 2 and len(c["links"]) == 1


def test_for_sale_parking_landers_do_not_link():
    """Typo domains listed for sale all redirect to the same marketplace page (same favicon and DOM)."""
    for host in ("aepass.com", "ecrie.com", "mobre.com"):
        v = verdict(host, favicon="hd-fav", structure=KIT_HASH, content=KIT_HASH)
        v.final_url = f"https://www.hugedomains.com/domain_profile.cfm?d={host}"
        assert link_campaign(v) is None
    assert list_campaigns() == []


def test_same_offsite_redirect_target_plus_kit_links():
    for host in ("tamm-pay.icu", "tamm-fines.top"):
        v = verdict(host, favicon="f1")
        v.final_url = "https://pay-portal-uae.top/checkout"
        link_campaign(v)
    [c] = list_campaigns()
    assert "both redirect to pay-portal-uae.top" in c["links"][0]["shared"]


def test_registrar_placeholder_pages_do_not_link():
    """Default "domain parked" pages of a registrar share tracker, form endpoint and DOM across customers."""
    form = FormInfo(action="https://www.hostinger.com/domain-name-results", action_host="www.hostinger.com",
                    external_action=True)
    for host in ("ecrine.com", "aclcb.ae", "sewaportal.com"):
        link_campaign(verdict(host, html="UA-26575989-44", forms=[form], structure=KIT_HASH, content=KIT_HASH))
    assert list_campaigns() == []


def test_shared_certificates_and_platform_subdomains():
    many = [f"customer{i}.com" for i in range(30)] + ["tamm-a.icu", "tamm-b.icu"]
    link_campaign(verdict("tamm-a.icu", sans=many))
    assert link_campaign(verdict("tamm-b.icu", sans=many)) is None  # a 32-name CDN certificate links nothing
    a = verdict("kit-one.github.io", html="GTM-AAAA111")
    b = verdict("kit-two.github.io", html="GTM-AAAA111")
    link_campaign(a)
    link_campaign(b)
    [c] = list_campaigns()
    assert {d["host"] for d in c["domains"]} == {"kit-one.github.io", "kit-two.github.io"}


def test_rebuild_edges_reproduces_links():
    link_campaign(verdict("tamm-a.icu", html="GTM-AAAA111"))
    link_campaign(verdict("tamm-b.icu", html="GTM-AAAA111"))
    before = list_campaigns()
    assert rebuild_edges() == 1
    assert list_campaigns() == before


def test_platform_subdomains_do_not_link_on_platform_infrastructure():
    ns = ["adi.ns.cloudflare.com", "karl.ns.cloudflare.com"]
    day = datetime(2026, 11, 20, tzinfo=timezone.utc)
    for host in ("shop-one.pages.dev", "bank-two.pages.dev"):
        link_campaign(verdict(host, ns=ns, registrar="Cloudflare, Inc.", created=day, ips=["45.1.2.3"],
                              sans=["pages.dev", "*.pages.dev"]))
    assert list_campaigns() == []
    for host in ("kit-a.pages.dev", "kit-b.pages.dev"):  # the same kit on the platform still links
        link_campaign(verdict(host, ns=ns, structure=KIT_HASH, content=KIT_HASH))
    [c] = list_campaigns()
    assert {d["host"] for d in c["domains"]} == {"kit-a.pages.dev", "kit-b.pages.dev"}
    assert not any("nameservers" in s for s in c["links"][0]["shared"])


def test_empty_shell_pages_do_not_link_on_hashes():
    for host in ("loader-a.icu", "loader-b.top"):
        link_campaign(verdict(host, structure=KIT_HASH, content=KIT_HASH, text=""))
    assert list_campaigns() == []
