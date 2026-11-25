import os

import pytest
from selectolax.lexbor import LexborHTMLParser

from scamshield import config
from scamshield.engine import hashing
from scamshield.engine.fetch import fetch_page
from tests.fixtures.server import FAVICON

SAME = config.HASH_SAME_PAGE_DISTANCE


async def test_same_page_with_new_clock_nonce_and_tokens_stays_within_threshold(sites):
    first = await fetch_page(f"{sites.site}/news")
    second = await fetch_page(f"{sites.site}/news")
    assert first.html != second.html
    assert hashing.hamming(first.content_hash, second.content_hash) <= SAME
    assert hashing.hamming(first.structure_hash, second.structure_hash) <= SAME
    assert first.kit_hash == second.kit_hash


async def test_different_pages_are_far_apart(sites):
    news, shop, login = [await fetch_page(f"{sites.site}{p}") for p in ("/news", "/shop", "/login")]
    for a, b in ((news, shop), (shop, login), (news, login)):
        assert hashing.hamming(a.content_hash, b.content_hash) > SAME


async def test_kit_hash_links_same_kit_on_another_host(sites):
    here = await fetch_page(f"{sites.site}/login")
    elsewhere = await fetch_page(f"{sites.collector}/login")
    shop = await fetch_page(f"{sites.site}/shop")
    assert here.kit_hash == elsewhere.kit_hash != shop.kit_hash
    assert hashing.hamming(here.structure_hash, elsewhere.structure_hash) == 0


def test_volatile_tokens_are_stripped():
    text = "Updated 2026-11-24 21:05:33 UTC nonce=8f3a9c1d2e4b5a6f7c8d csrf_token: Zx81kq0Lm2Vb9 views 48213 ١٢٣"
    assert hashing.normalise_text(text).split() == ["updated", "utc", "views"]


def test_structure_hash_ignores_text_but_not_layout():
    a = LexborHTMLParser("<body><div><h1>Hello</h1><p>one</p><form><input></form></div></body>")
    b = LexborHTMLParser("<body><div><h1>Bonjour</h1><p>deux</p><form><input></form></div></body>")
    c = LexborHTMLParser("<body><table><tr><td>x</td></tr></table><ul><li>a</li><li>b</li></ul></body>")
    assert hashing.structure_hash(a) == hashing.structure_hash(b)
    assert hashing.hamming(hashing.structure_hash(a), hashing.structure_hash(c)) > SAME


def test_tag_paths_survive_pathological_nesting():
    tree = LexborHTMLParser("<div>" * 5000 + "x" + "</div>" * 5000)
    assert len(hashing.tag_paths(tree)) > 5000


def test_hamming_and_similarity():
    assert hashing.hamming("ffffffffffffffff", "0000000000000000") == 64
    assert hashing.hamming("00000000000000ff", "0000000000000000") == 8
    assert hashing.hamming(None, "00") == 64
    assert hashing.similarity("abc", "abc") == 1.0


async def test_favicon_hash_matches_served_icon(sites):
    snap = await fetch_page(f"{sites.site}/shop")
    assert snap.favicon_hash == hashing.favicon_hash(FAVICON)
    assert int(snap.favicon_hash) < 2**31  # Shodan's signed 32-bit MurmurHash3 form


@pytest.mark.skipif(os.environ.get("SCAMSHIELD_LIVE_TESTS") != "1", reason="set SCAMSHIELD_LIVE_TESTS=1 to hit real sites")
@pytest.mark.parametrize("url", ["https://www.bbc.com/news", "https://www.aljazeera.net/", "https://www.adcb.com/"])
async def test_live_page_refetch_is_stable(url):
    first = await fetch_page(url)
    second = await fetch_page(url)
    assert first.error is None and second.error is None
    assert hashing.hamming(first.content_hash, second.content_hash) <= SAME
    assert hashing.hamming(first.structure_hash, second.structure_hash) <= SAME
