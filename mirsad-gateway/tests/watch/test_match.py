import pytest

from scamshield.watch.match import match_host, registered_domain, skeleton


@pytest.mark.parametrize("host,brand,technique", [
    ("uaepass-verify.com", "UAE PASS", "combosquat"),
    ("secureuaepass.net", "UAE PASS", "combosquat"),
    ("uaepa55.com", "UAE PASS", "homoglyph"),
    ("tamm-pay.online", "TAMM", "combosquat"),
    ("dewa-bill.net", "DEWA", "combosquat"),
    ("dewatopup.com", "DEWA", "combosquat"),
    ("salik-toll.icu", "Salik", "combosquat"),
    ("emiratesbnd.com", "Emirates NBD", "typosquat"),
    ("emiratesnbd-secure.xyz", "Emirates NBD", "combosquat"),
    ("emiratespost.top", "Emirates Post", "tld-swap"),
    ("dubaipolicefines.icu", "Dubai Police", "combosquat"),
    ("dubaipoliauey.top", "Dubai Police", "combosquat"),  # reported Smishing Triad pattern (truncated brand)
    ("login.tamm.ae-verify.top", "TAMM", "combosquat"),  # brand in a subdomain of an unrelated domain
    ("microsoft-uae-refund.com", "Microsoft", "combosquat"),  # global brand only with a UAE geo word
])
def test_lookalikes_and_keywords_are_caught(host, brand, technique):
    m = match_host(host)
    assert m is not None, host
    assert (m.brand, m.technique) == (brand, technique)
    assert m.score >= 0.5


@pytest.mark.parametrize("host", [
    "uae-traffic-fines.top", "dubai-parking-fine.top", "mukhalafat-dubai.com", "gov-uae-fines.icu",
])
def test_generic_uae_lure_patterns(host):
    m = match_host(host)
    assert m is not None and m.technique == "lure-pattern" and m.brand == "UAE government services"


@pytest.mark.parametrize("host", [
    "www.uaepass.ae", "selfcare.uaepass.ae", "tamm.abudhabi", "www.emiratesnbd.com",  # official
    "tammy.com", "dewalt.com", "salikhov.ru",  # short brand names inside ordinary words
    "parkingfrog.com", "wnparking.com",  # weak token "parkin" inside the word "parking"
    "parkin-cars.com",  # weak token without a lure word
    "z1e.w.api.fabric.microsoft-int.com",  # global brand without a UAE geo word
    "finestdubai.com", "governorsislandtickets.com",  # lure words only as accidental substrings
    "womenloveandmoney.club", "google.com", "example.org",
])
def test_benign_or_official_hosts_are_not_flagged(host):
    assert match_host(host) is None


def test_weak_token_needs_lure_word():
    m = match_host("parkin-fine-pay.icu")
    assert m is not None and m.brand == "Parkin"


def test_risky_tld_raises_score():
    assert match_host("tamm-pay.icu").score > match_host("tamm-pay.com").score


def test_wildcard_prefix_and_case_are_normalised():
    assert match_host("*.UAEPASS-Login.com").host == "uaepass-login.com"


def test_idn_homograph_decoded():
    # "uaеpass" with a Cyrillic "е", in punycode.
    host = "uaеpass.com".encode("idna").decode()
    m = match_host(host)
    assert m is not None and m.brand == "UAE PASS" and m.technique == "homoglyph"


def test_arabic_idn_lure():
    m = match_host("دفع-مخالفات-دبي.com".encode("idna").decode())
    assert m is not None and m.technique == "idn"


def test_helpers():
    assert skeleton("uaepa55") == "uaepass"
    assert skeleton("rnashreq") == "mashreq"
    assert registered_domain("a.b.example.co.uk") == "example.co.uk"
    assert registered_domain("www.tamm.abudhabi") == "tamm.abudhabi"
