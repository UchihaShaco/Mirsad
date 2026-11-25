import pytest

from scamshield.watch.brands import brand_by_name
from scamshield.watch.listings import Listing, assess_listing, brands_in_text, check_text
from scamshield.watch.phones import extract_phones, normalize_phone


@pytest.mark.parametrize("raw,expected,kind", [
    ("800 555", "+971800555", "tollfree"),
    ("800-72545", "+97180072545", "tollfree"),
    ("600 54 0000", "+971600540000", "sharedcost"),
    ("+971 4 601 9999", "+97146019999", "landline"),
    ("00971-2-000-0102", "+97120000102", "landline"),
    ("04 601 9999", "+97146019999", "landline"),
    ("02-0000102", "+97120000102", "landline"),
    ("050 000 0101", "+971500000101", "mobile"),
    ("+971 (0)55 000 0106", "+971550000106", "mobile"),
    ("٠٥٠٠٠٠٠١٠١", "+971500000101", "mobile"),  # Arabic-Indic digits
    ("۰۴ ۶۰۱ ۹۹۹۹", "+97146019999", "landline"),  # Extended Arabic-Indic (Persian) digits
    ("+971 800 4444", "+9718004444", "tollfree"),
])
def test_normalize_uae_formats(raw, expected, kind):
    assert normalize_phone(raw) == expected
    assert extract_phones(f"call {raw} now")[0]["kind"] == kind


@pytest.mark.parametrize("raw", ["12345678", "+44 20 7946 0958", "2024-11-24", "784-1990-1234567-1", "999"])
def test_non_uae_or_non_phone_numbers_rejected(raw):
    assert extract_phones(raw) == []


def test_extract_multiple_and_dedupe():
    text = "Hotline: 800 555 | Arabic: ٨٠٠٥٥٥ | WhatsApp +971 50 000 0101, card 4111 1111 1111 1111"
    numbers = [p["number"] for p in extract_phones(text)]
    assert numbers == ["+971800555", "+971500000101"]


def test_fake_helpline_on_english_page():
    r = check_text("Emirates NBD customer care - call 800 000 0103 or our official 600 54 0000 line")
    assert r["brand"] == "Emirates NBD"
    assert [p["number"] for p in r["mismatched"]] == ["+9718000000103"]
    assert r["helpline_claim"] and r["suspicious"]


def test_fake_helpline_in_arabic_with_arabic_indic_digits():
    r = check_text("رقم خدمة عملاء بنك الإمارات دبي الوطني: ٠٥٠٠٠٠٠١٠١")
    assert r["brand"] == "Emirates NBD"
    assert [p["number"] for p in r["mismatched"]] == ["+971500000101"]


def test_official_number_is_not_flagged():
    r = check_text("DEWA: call 04 601 9999")
    assert r["brand"] == "DEWA" and r["mismatched"] == [] and not r["suspicious"]


def test_no_brand_claim_no_flag():
    r = check_text("Tammam Restaurant, call +971 4 000 0107")  # "TAMM" must not match inside "Tammam"
    assert r["brand"] is None and not r["suspicious"]


def test_brands_in_text_arabic_folding():
    assert brand_by_name("Emirates Post") in brands_in_text("تتبع شحنة بريد الامارات")  # alef without hamza


def test_listing_with_fake_phone_and_website():
    enbd = brand_by_name("Emirates NBD")
    flag = assess_listing(Listing(provider="osm", id="node/1", name="Emirates NBD Customer Care",
                                  phone="+971 50 999 8888", website="https://enbd-support.help/"), enbd)
    assert flag and set(flag["reasons"]) == {"phone_not_official", "website_not_official"}
    assert flag["website_host"] == "enbd-support.help"


def test_genuine_listing_not_flagged():
    enbd = brand_by_name("Emirates NBD")
    assert assess_listing(Listing(provider="osm", id="node/2", name="Emirates NBD", phone="600 54 0000",
                                  website="https://www.emiratesnbd.com/en"), enbd) is None
    assert assess_listing(Listing(provider="osm", id="node/3", name="Some Cafe", phone="+971 50 999 8888"), enbd) is None
    # A branch with its own landline and the official website is normal.
    assert assess_listing(Listing(provider="osm", id="node/4", name="Emirates NBD Al Barsha", phone="+971 4 332 1669",
                                  website="https://www.emiratesnbd.com/"), enbd) is None


def test_helpline_listing_with_unofficial_number_is_flagged():
    enbd = brand_by_name("Emirates NBD")
    flag = assess_listing(Listing(provider="serpapi_maps", id="p1", name="Emirates NBD Customer Care Center",
                                  phone="+971 50 999 8888"), enbd)
    assert flag and flag["reasons"] == ["phone_not_official"]


def test_place_names_and_neutral_websites_are_not_brand_claims():
    emirates = brand_by_name("Emirates")
    assert assess_listing(Listing(provider="osm", id="way/1", name="United Arab Emirates Space Agency",
                                  website="https://space.gov.ae"), emirates) is None
    enbd = brand_by_name("Emirates NBD")
    assert assess_listing(Listing(provider="osm", id="way/2", name="Emirates NBD ATM",
                                  website="https://youtu.be/abc"), enbd) is None
