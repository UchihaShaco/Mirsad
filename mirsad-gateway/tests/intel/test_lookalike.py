import idna

from scamshield.intel.brands import match_brand
from scamshield.intel.lookalike import generate_lookalikes
from scamshield.intel.reputation import official_owner


def test_covers_every_technique():
    candidates = set(generate_lookalikes("adcb.com", limit=5000))
    expected = {
        "adcb.top",  # TLD swap
        "adcb-pay.com", "secure-adcb.com", "adcblogin.com",  # keyword combos
        "adb.com",  # omission
        "dacb.com",  # transposition
        "addcb.com",  # repetition
        "ad-cb.com",  # hyphenation
        "adcv.com",  # keyboard replacement
        "adcbv.com",  # keyboard insertion
        "4dcb.com",  # ASCII homoglyph
        idna.encode("аdcb.com", uts46=True).decode(),  # Cyrillic homoglyph
    }
    assert expected <= candidates


def test_limit_order_and_validity():
    small = generate_lookalikes("uaepass.ae", limit=40)
    assert len(small) == 40 and len(set(small)) == 40
    assert small[0] == "uaepass.com"
    techniques = {"uaepass-pay.ae", "aepass.ae"}
    assert techniques <= set(small), "interleaving keeps several techniques within a small limit"
    for candidate in generate_lookalikes("emiratesnbd.com", limit=2000):
        assert candidate.isascii() and all(0 < len(label) <= 63 for label in candidate.split("."))
        assert not candidate.startswith("-") and ".-" not in candidate and "-." not in candidate


def test_never_returns_official_or_unregistrable_domains():
    for domain in ("adcb.com", "dewa.gov.ae", "tamm.abudhabi", "emiratesnbd.com"):
        candidates = generate_lookalikes(domain, limit=3000)
        assert all(official_owner(c) is None for c in candidates), domain
    assert not any(c.endswith(".gov.ae") for c in generate_lookalikes("dewa.gov.ae", limit=3000))


def test_most_candidates_are_recognised_by_match_brand():
    candidates = generate_lookalikes("aramex.com", limit=300)
    recognised = sum(1 for c in candidates if (m := match_brand(c)) and m.brand == "Aramex")
    assert recognised / len(candidates) > 0.9


def test_bad_input():
    assert generate_lookalikes("") == []
    assert generate_lookalikes("localhost") == []
