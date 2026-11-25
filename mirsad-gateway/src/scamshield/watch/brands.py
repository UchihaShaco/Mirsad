"""UAE brand registry for the watcher.

Reads `scamshield/intel/data/brands.json`, the registry the intel component maintains; there is no
second copy here. A missing or unreadable registry leaves the watcher with no brands rather than failing.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from scamshield.watch.phones import normalize_phone

REGISTRY_PATH = Path(os.environ.get(
    "SCAMSHIELD_BRANDS", Path(__file__).resolve().parents[1] / "intel" / "data" / "brands.json"))


@dataclass(frozen=True)
class Brand:
    name: str
    name_ar: str = ""
    category: str = ""
    country: str = "AE"  # "AE" for UAE brands; global brands only match together with a UAE geo token
    official_domains: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()  # distinctive strings for look-alike matching
    weak_keywords: tuple[str, ...] = ()  # generic words that only count together with a lure keyword
    phones: tuple[str, ...] = ()  # canonical +971… numbers
    aliases: tuple[str, ...] = ()  # names in English and Arabic, for search queries


def _phones(raw) -> tuple[str, ...]:
    return tuple(dict.fromkeys(p for p in (normalize_phone(str(x)) for x in raw or []) if p))


def _from_registry(raw: dict) -> list[Brand]:
    out = []
    for e in raw.get("brands", []):
        name = e.get("name_en") or e.get("id")
        if not name:
            continue
        out.append(Brand(
            name=name, name_ar=e.get("name_ar", ""), category=e.get("category", ""),
            country=(e.get("country") or "AE").upper(),
            official_domains=tuple(d.lower().strip(".") for d in e.get("domains", [])),
            keywords=tuple(t.lower() for t in e.get("tokens", []) if t.isascii()),
            weak_keywords=tuple(t.lower() for t in e.get("weak_tokens", []) if t.isascii()),
            phones=_phones(e.get("phones")),
            aliases=tuple(dict.fromkeys([name, e.get("name_ar", "")] + e.get("aliases_en", []) + e.get("aliases_ar", []))),
        ))
    return out


@lru_cache(maxsize=1)
def load_brands() -> tuple[Brand, ...]:
    try:
        return tuple(_from_registry(json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))))
    except (OSError, ValueError, TypeError, AttributeError):
        return ()


def brand_by_name(name: str | None) -> Brand | None:
    if not name:
        return None
    key = name.lower()
    brands = load_brands()
    return (next((b for b in brands if b.name.lower() == key), None)
            or next((b for b in brands if key in (a.lower() for a in b.aliases)), None))


def is_official(host: str) -> Brand | None:
    """The brand that owns `host` (exact domain or subdomain of an official domain), if any."""
    host = host.lower().strip(".")
    for b in load_brands():
        for d in b.official_domains:
            if host == d or host.endswith("." + d):
                return b
    return None
