"""Maps / business listings and fake helplines.

`check_text(text)` works on any text (a page, a listing, a search snippet, an SMS): it finds UAE phone
numbers (800 / 600 / +971 / 0X landlines / 05X mobiles, Arabic-Indic digits too), works out which brand the
text claims to be, and flags numbers that are not on that brand's official list.

Optional listings source through the `ListingProvider` interface; the keyless provider is OpenStreetMap
Nominatim (at most one request per second, their usage policy). A listing that names a brand but shows a non-official phone number or website is recorded; a non-official
website is also queued for the engine.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import AsyncIterator, Protocol
from urllib.parse import urlsplit

import httpx

from scamshield.intel import lists
from scamshield.watch import settings
from scamshield.watch.base import Candidate, RateLimiter, client, get_with_backoff
from scamshield.watch.brands import Brand, is_official, load_brands
from scamshield.watch.match import match_host
from scamshield.watch.phones import extract_phones
from scamshield.watch.store import Store

log = logging.getLogger(__name__)

_ARABIC_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ة": "ه", "ى": "ي", "ـ": None})
_HELPLINE_WORDS = lists.words("lexicon", "listing_helpline_words")


# Brand aliases that are also place names ("Emirates" is an airline and half of every UAE address), and
# sites a listing may point to that are not the brand's own.
_PLACE_WORDS = lists.wordset("lexicon", "listing_place_words")
_NEUTRAL_SITES = lists.words("services", "listing_neutral_sites")


def _fold(text: str) -> str:
    return " ".join(text.lower().translate(_ARABIC_FOLD).split())


def _contains(folded: str, name: str) -> bool:
    """Whole-word match for Latin names ("TAMM" must not hit "Tammam"); substring for Arabic."""
    if not name.isascii():
        return name in folded
    return re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", folded) is not None


def brands_in_text(text: str) -> list[Brand]:
    """Brands whose English or Arabic name / alias appears in `text` (longest names first)."""
    folded = _fold(text)
    hits: list[tuple[int, Brand]] = []
    for b in load_brands():
        names = [n for n in (b.name, b.name_ar, *b.aliases) if n and len(n) >= 3 and _fold(n) not in _PLACE_WORDS]
        best = max((len(n) for n in names if _contains(folded, _fold(n)) and (not n.isascii() or len(n) >= 4)), default=0)
        if best:
            hits.append((best, b))
    return [b for _, b in sorted(hits, key=lambda x: -x[0])]


def check_text(text: str, brand: Brand | None = None) -> dict:
    """Phone numbers in `text` and which of them are not official numbers of the brand the text claims."""
    phones = extract_phones(text)
    claimed = [brand] if brand else brands_in_text(text)
    target = next((b for b in claimed if b.phones), claimed[0] if claimed else None)
    official_any = {p for b in claimed for p in b.phones}
    mismatched = [p for p in phones if target and target.phones and p["number"] not in official_any]
    folded = _fold(text)
    return {
        "brand": target.name if target else None,
        "official": list(target.phones) if target else [],
        "phones": phones,
        "mismatched": mismatched,
        "helpline_claim": any(w in folded for w in _HELPLINE_WORDS),
        "suspicious": bool(mismatched),
    }


@dataclass
class Listing:
    provider: str
    id: str
    name: str
    phone: str = ""
    website: str = ""
    address: str = ""
    extra: dict = field(default_factory=dict)


class ListingProvider(Protocol):
    name: str

    def available(self) -> bool: ...

    async def search(self, http: httpx.AsyncClient, query: str) -> list[Listing]: ...


class Nominatim:
    name = "osm"
    _limit = RateLimiter(1.1)

    def available(self) -> bool:
        return True

    async def search(self, http: httpx.AsyncClient, query: str) -> list[Listing]:
        await self._limit.wait()
        r = await get_with_backoff(http, "https://nominatim.openstreetmap.org/search", params={
            "q": query, "format": "jsonv2", "extratags": 1, "countrycodes": "ae", "limit": 40})
        r.raise_for_status()
        return parse_nominatim(r.json())


def parse_nominatim(rows: list[dict]) -> list[Listing]:
    out = []
    for x in rows:
        tags = x.get("extratags") or {}
        out.append(Listing(
            provider="osm", id=f"{x.get('osm_type')}/{x.get('osm_id')}", name=x.get("name") or x.get("display_name", ""),
            phone=tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile") or "",
            website=tags.get("website") or tags.get("contact:website") or tags.get("url") or "",
            address=x.get("display_name", ""), extra={"brand_tag": tags.get("brand"), "type": x.get("type")}))
    return out


PROVIDERS: dict[str, type] = {"osm": Nominatim}


def assess_listing(listing: Listing, query_brand: Brand) -> dict | None:
    """Why a listing that claims `query_brand` looks fake: non-official phone and/or website. None if clean."""
    text = f"{listing.name} {listing.extra.get('brand_tag') or ''}"
    claimed = brands_in_text(text)
    if query_brand not in claimed:
        return None
    reasons = []
    host = (urlsplit(listing.website if "//" in listing.website else f"http://{listing.website}").hostname or "").lower() \
        if listing.website else ""
    if host and not is_official(host) and not any(host == n or host.endswith("." + n) for n in _NEUTRAL_SITES):
        reasons.append("website_not_official")
    check = check_text(listing.phone, brand=query_brand) if listing.phone else None
    # Branches legitimately list their own numbers; a number only matters on a listing that presents itself as
    # the brand's helpline, or on one that already points to a non-official website.
    helpline = check_text(text)["helpline_claim"]
    if check and check["mismatched"] and (helpline or reasons):
        reasons.append("phone_not_official")
    if not reasons:
        return None
    return {"listing": asdict(listing), "brand": query_brand.name, "reasons": reasons, "website_host": host,
            "phones": check["phones"] if check else [], "official_phones": list(query_brand.phones)}


class ListingsSource:
    name = "listings"

    def __init__(self, store: Store | None = None, brands: list[Brand] | None = None) -> None:
        self.store = store or Store()
        self.brands = brands if brands is not None else [b for b in load_brands() if b.country == "AE" and b.phones]
        self.providers = [PROVIDERS[p]() for p in settings.LISTINGS_PROVIDERS if p in PROVIDERS]
        self.providers = [p for p in self.providers if p.available()]
        self.listings = 0
        self.flagged: list[dict] = []
        self.errors: list[str] = []

    async def _round(self, http: httpx.AsyncClient) -> AsyncIterator[Candidate]:
        for provider in self.providers:
            for brand in self.brands:
                query = brand.name if provider.name == "osm" else f"{brand.name} customer service UAE"
                try:
                    found = await provider.search(http, query)
                except (httpx.HTTPError, ValueError, KeyError) as e:
                    self.errors.append(f"{provider.name} {query!r}: {type(e).__name__}: {e}")
                    continue
                self.listings += len(found)
                for listing in found:
                    flag = assess_listing(listing, brand)
                    if not flag:
                        continue
                    self.flagged.append(flag)
                    self.store.set_state(f"listing:{listing.provider}:{listing.id}", flag)
                    if "website_not_official" in flag["reasons"]:
                        m = match_host(flag["website_host"])
                        url = listing.website if "//" in listing.website else f"http://{listing.website}"
                        yield Candidate(url=url, source=self.name, brand_hint=brand.name, host=flag["website_host"],
                                        technique="listing", score=max(0.6, m.score if m else 0.0),
                                        evidence=json.loads(json.dumps(flag, default=str)))

    async def candidates(self, *, once: bool = False) -> AsyncIterator[Candidate]:
        if not self.providers:
            self.errors.append("no listings provider available")
            return
        async with client(timeout=30) as http:
            while True:
                async for c in self._round(http):
                    yield c
                if once:
                    return
                await asyncio.sleep(settings.LISTINGS_POLL_S)
