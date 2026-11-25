"""Analysis of hostile pages must stay fast: no pattern may go quadratic or worse on crafted input."""

import time
import weakref

import pytest

from scamshield.engine import fetch, hashing
from scamshield.engine.extract import parse_html
from scamshield.engine.fetch import _inline_scripts, _scan

PAGE = "https://victim.example/"


def analyse_document(html: str) -> None:
    _inline_scripts(parse_html(html, PAGE), PAGE)


MB = 1_000_000

HOSTILE_SCRIPTS = {
    "escaped_quotes": '"' + '\\"' * (MB // 2),
    "unterminated_quotes": "'a\"" * (MB // 3),
    "backslashes": "\\" * MB,
    "one_token": "a" * MB,
    "template_dollars": "`${" * (MB // 3),
    "nested_parens": "var a=" + "(" * MB,
    "if_navigator": "if(navigator.userAgent){x}" * (MB // 26),
    "location_assigns": "location.href=a+" * (MB // 16),
    "declarations": "var a=b;" * (MB // 8),
    "context_menu": ("contextmenu," + " " * 5000) * 200,
    "set_timeouts": "setTimeout(function(){" * (MB // 22),
    "hex_ids": " ".join(f"_0x{i:04x}" for i in range(MB // 8)),
    "long_host": "//" + "a." * (MB // 2),
}


@pytest.mark.parametrize("name", HOSTILE_SCRIPTS)
def test_script_analysis_is_bounded(name):
    started = time.perf_counter()
    _scan(HOSTILE_SCRIPTS[name], f"{PAGE}x.js", PAGE, True)
    assert time.perf_counter() - started < 3.0


@pytest.mark.parametrize("name", ["escaped_quotes", "if_navigator", "declarations", "location_assigns"])
def test_inline_script_page_analysis_is_bounded(name):
    html = f"<html><body><p>hi</p><script>{HOSTILE_SCRIPTS[name]}</script></body></html>"
    started = time.perf_counter()
    analyse_document(html)
    assert time.perf_counter() - started < 3.0


@pytest.mark.parametrize(
    "text",
    ["sid" * MB, "a-" * MB, "token" + "x" * MB, "1." * MB, "٣," * MB, "__" + "A" * MB + " = {"],
)
def test_text_hashing_and_extraction_are_bounded(text):
    started = time.perf_counter()
    hashing.content_hash(text)
    parse_html(f"<html><body><p>{text}</p><script>window.{text}</script></body></html>", PAGE)
    assert time.perf_counter() - started < 3.0


def test_deeply_nested_markup_and_json():
    html = (
        "<div>" * 50_000
        + '<script type="application/json">' + "[" * 100_000 + "]" * 100_000 + "</script>"
        + '<input placeholder="' + "card " * 100_000 + '">'
    )
    started = time.perf_counter()
    analyse_document(html)
    assert time.perf_counter() - started < 3.0


async def test_dead_domain_costs_one_short_lookup(monkeypatch):
    # A nameserver that never answers (TEST-NET-1): the lookup must give up on our timeout, not the OS's.
    monkeypatch.setattr(fetch, "_NAMESERVERS", ["192.0.2.1"])
    monkeypatch.setattr(fetch, "_resolvers", weakref.WeakKeyDictionary())
    monkeypatch.setattr(fetch, "_dns_cache", {})
    started = time.perf_counter()
    first = await fetch.fetch_page("https://dead-phish.example/")
    assert first.error.startswith("dns:") and time.perf_counter() - started < fetch.DNS_TIMEOUT_S + 0.5
    started = time.perf_counter()
    again = await fetch.fetch_page("https://dead-phish.example/login")
    assert again.error.startswith("dns:") and time.perf_counter() - started < 0.1
