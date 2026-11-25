"""Block, warning and checking pages carry hostile hostnames, URLs and reasons: they must stay inert text."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

GATEWAY = Path(__file__).resolve().parents[2] / "gateway"
HOSTILE_URL = 'http://x.example/{{data_json}}"><script>alert(1)</script><!--<script>{{reasons_html}}'


@pytest.fixture(scope="module")
def pages():
    spec = importlib.util.spec_from_file_location("gateway_addon_pages", GATEWAY / "addon.py")
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)
    return addon.Pages(GATEWAY / "pages")


@pytest.mark.parametrize("name", ["blocked", "warning", "checking"])
def test_hostile_values_are_rendered_as_text(pages, name):
    values = {"host": '<img src=x onerror=alert(1)>.example', "url": HOSTILE_URL, "risk": "99",
              "reference": "SS-1", "summary_en": "</script><script>alert(2)</script>", "summary_ar": "{{host}}",
              "reasons_html": "<li>ours</li>", "proceed_url": "/__scamshield__/proceed?to=x"}
    body = pages.render(name, values, {"url": HOSTILE_URL, "status_url": "/__scamshield__/status"}).decode()
    assert "<script>alert" not in body and "<img src=x" not in body
    assert ">{{host}}<" in body or name == "checking"  # placeholders inside values are never expanded again
    assert body.count("<li>ours</li>") <= 1
    for cfg in re.findall(r"var cfg = (.*?);\n", body):
        assert "<" not in cfg and "\\u003c/script>" in cfg
