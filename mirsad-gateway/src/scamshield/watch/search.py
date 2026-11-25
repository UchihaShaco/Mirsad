"""Optional source: search results for brand + intent queries (English and Arabic).

Non-official result URLs (look-alikes, ads, pages claiming the brand or quoting a non-official phone
number) become reputation pre-fill candidates. Not a core source: the only keyless provider
(`duckduckgo`, HTML endpoint at one query per `SCAMSHIELD_WATCH_SEARCH_DELAY` s) rate-limits with a
challenge, and we back off instead of trying to get around it. Further providers plug in through the
`Provider` interface.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import AsyncIterator, Protocol
from urllib.parse import parse_qs, urlsplit

import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from scamshield.intel import lists
from scamshield.schemas import utcnow
from scamshield.watch import settings
from scamshield.watch.base import Candidate, RateLimiter, client, get_with_backoff
from scamshield.watch.brands import Brand, brand_by_name, is_official
from scamshield.watch.match import match_host, registered_domain
from scamshield.watch.phones import extract_phones
from scamshield.watch.store import Store, iso, parse_iso

log = logging.getLogger(__name__)

# Curated UAE lure queries (docs/research/uae_threat_landscape.md): (query, brand name or None, language).
QUERIES: list[tuple[str, str | None, str]] = [
    ("pay traffic fine abu dhabi", "Abu Dhabi Police", "en"),
    ("dubai police fines payment online", "Dubai Police", "en"),
    ("salik recharge online", "Salik", "en"),
    ("nol card recharge online", "Roads and Transport Authority (RTA)", "en"),
    ("darb toll payment", "Integrated Transport Centre (Darb / Mawaqif)", "en"),
    ("tamm traffic fine payment", "TAMM", "en"),
    ("uae pass login", "UAE PASS", "en"),
    ("emirates id renewal online", None, "en"),
    ("emirates post parcel tracking fee", "Emirates Post", "en"),
    ("dewa bill payment", "Dubai Electricity and Water Authority (DEWA)", "en"),
    ("uae consumer protection complaint", None, "en"),
    ("dubai opera tickets", "Dubai Opera", "en"),
    ("emirates nbd customer care number", "Emirates NBD", "en"),
    ("adcb customer care number", "Abu Dhabi Commercial Bank (ADCB)", "en"),
    ("fab bank customer service number", "First Abu Dhabi Bank", "en"),
    ("mashreq customer care number", "Mashreq", "en"),
    ("etisalat customer care number", "e& (Etisalat)", "en"),
    ("تجديد الهوية الإماراتية", None, "ar"),
    ("دفع المخالفات المرورية أبوظبي", "Abu Dhabi Police", "ar"),
    ("سداد مخالفات شرطة دبي", "Dubai Police", "ar"),
    ("شحن سالك", "Salik", "ar"),
    ("تتبع شحنة بريد الإمارات", "Emirates Post", "ar"),
    ("دفع فاتورة ديوا", "Dubai Electricity and Water Authority (DEWA)", "ar"),
    ("رقم خدمة عملاء بنك الإمارات دبي الوطني", "Emirates NBD", "ar"),
    ("حماية المستهلك الإمارات شكوى", None, "ar"),
]

_IGNORE = lists.wordset("services", "search_ignore_sites")


@dataclass
class Result:
    url: str
    title: str = ""
    snippet: str = ""
    is_ad: bool = False
    kind: str = "organic"  # organic | ad | local
    phone: str = ""
    extra: dict = field(default_factory=dict)


class Provider(Protocol):
    name: str

    def available(self) -> bool: ...

    async def search(self, http: httpx.AsyncClient, query: str, lang: str) -> list[Result]: ...


class RateLimited(Exception):
    pass


def _uddg(href: str) -> str:
    """DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<url>; ads as /y.js?ad_domain=…"""
    if href.startswith("//"):
        href = "https:" + href
    parts = urlsplit(href)
    q = parse_qs(parts.query)
    if "uddg" in q:
        return q["uddg"][0]
    if "ad_domain" in q:
        return f"https://{q['ad_domain'][0]}/"
    return href


def _text(node) -> str:
    return " ".join(node.text(separator=" ").split())


def parse_duckduckgo(html: str) -> list[Result]:
    tree = HTMLParser(html)
    out = []
    for node in tree.css("div.result"):
        a = node.css_first("a.result__a")
        if a is None:
            continue
        url = _uddg(a.attributes.get("href") or "")
        if not url.startswith("http"):
            continue
        snippet = node.css_first(".result__snippet")
        is_ad = "result--ad" in (node.attributes.get("class") or "")
        out.append(Result(url=url, title=_text(a), snippet=_text(snippet) if snippet else "",
                          is_ad=is_ad, kind="ad" if is_ad else "organic"))
    return out


class DuckDuckGo:
    name = "duckduckgo"

    def available(self) -> bool:
        return True

    async def search(self, http: httpx.AsyncClient, query: str, lang: str) -> list[Result]:
        r = await get_with_backoff(http, "https://html.duckduckgo.com/html/",
                                   params={"q": query, "kl": "xa-ar" if lang == "ar" else "xa-en"})
        if r.status_code == 202 or "anomaly" in r.text[:5000]:
            raise RateLimited("duckduckgo asked for a challenge (rate limited)")
        r.raise_for_status()
        return parse_duckduckgo(r.text)


PROVIDERS: dict[str, type] = {"duckduckgo": DuckDuckGo}


def _mentions(brand: Brand, text: str) -> bool:
    low = text.lower()
    return any(a and a.lower() in low for a in brand.aliases + (brand.name,))


def assess_result(res: Result, query_brand: Brand | None, provider: str, query: str) -> Candidate | None:
    """Queue a result if it is an ad, a look-alike, or claims the brand / quotes a non-official number."""
    host = (urlsplit(res.url).hostname or "").lower() if res.url else ""
    if not host or is_official(host) or registered_domain(host) in _IGNORE:
        return None
    m = match_host(host)
    text = f"{res.title} {res.snippet} {res.phone}"
    phones = [p["number"] for p in extract_phones(text)]
    brand = brand_by_name(m.brand) if m else query_brand
    bad_phones = [p for p in phones if brand and brand.phones and p not in brand.phones]
    claims = bool(query_brand and _mentions(query_brand, text))
    if not (m or res.is_ad or claims or bad_phones or res.kind == "local"):
        return None
    score = max(m.score if m else 0.0, 0.6 if res.is_ad else 0.0, 0.55 if claims else 0.0, 0.7 if bad_phones else 0.0, 0.5)
    return Candidate(url=res.url, source="search", brand_hint=brand.name if brand else None, host=host,
                     technique=m.technique if m else ("ad" if res.is_ad else res.kind),
                     score=round(score, 2),
                     evidence={"provider": provider, "query": query, "kind": res.kind, "title": res.title[:200],
                               "snippet": res.snippet[:300], "phones": phones, "phones_not_official": bad_phones,
                               "matched_on": m.matched_on if m else []})


class SearchSource:
    name = "search"

    def __init__(self, store: Store | None = None, queries: list[tuple[str, str | None, str]] | None = None) -> None:
        self.store = store or Store()
        self.queries = queries or QUERIES
        self.providers = [PROVIDERS[p]() for p in settings.SEARCH_PROVIDERS if p in PROVIDERS]
        self.providers = [p for p in self.providers if p.available()]
        self.limiter = RateLimiter(settings.SEARCH_DELAY_S)
        self.results = 0
        self.errors: list[str] = []

    async def _round(self, http: httpx.AsyncClient, once: bool) -> AsyncIterator[Candidate]:
        for provider in self.providers:
            for query, brand_name, lang in self.queries:
                key = f"search:{provider.name}:{query}"
                last = parse_iso(self.store.get_state(key))
                if not once and last and utcnow() - last < timedelta(seconds=settings.SEARCH_POLL_S):
                    continue
                await self.limiter.wait(provider.name)
                try:
                    results = await provider.search(http, query, lang)
                except RateLimited as e:
                    self.errors.append(str(e))
                    break  # leave this provider alone until the next round
                except (httpx.HTTPError, ValueError, KeyError) as e:
                    self.errors.append(f"{provider.name} {query!r}: {type(e).__name__}: {e}")
                    continue
                self.store.set_state(key, iso(utcnow()))
                self.results += len(results)
                qb = brand_by_name(brand_name)
                for res in results:
                    c = assess_result(res, qb, provider.name, query)
                    if c:
                        yield c

    async def candidates(self, *, once: bool = False) -> AsyncIterator[Candidate]:
        if not self.providers:
            self.errors.append("no search provider available")
            return
        async with client(timeout=30) as http:
            while True:
                async for c in self._round(http, once):
                    yield c
                if once:
                    return
                await asyncio.sleep(min(settings.SEARCH_POLL_S, 3600))
