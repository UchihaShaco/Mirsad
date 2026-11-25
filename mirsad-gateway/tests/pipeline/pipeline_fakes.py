"""Fake neighbouring components (fetch, intel, models, review) so the pipeline can be tested in isolation."""

from __future__ import annotations

import asyncio
from collections import Counter
from datetime import timedelta
from typing import Optional

from scamshield.engine.pipeline import Components
from scamshield.engine.rules import parse_url
from scamshield.schemas import (
    BrandMatch, Decision, DomainIntel, FormInfo, PageSnapshot, ReviewOutcome, ReviewResult, ScriptFinding, utcnow,
)

OLD_BANK = DomainIntel(host="www.bigbank.ae", registered_domain="bigbank.ae", tld="ae", age_days=7000,
                       popularity_rank=40_000, asn=5384, nameservers=["ns1.bigbank.ae"], tls_issuer="DigiCert EV RSA CA")
FRESH = DomainIntel(host="x", registered_domain="x", tld="xyz", age_days=3, asn=13335, nameservers=["a.ns.cloudflare.com"])


def page(url: str, *, text: str = "Welcome to our family shop in Sharjah. Browse handmade products, read our story and contact us any time.", forms=(), scripts=(),
         links=(), content_hash: str = "0f0f0f0f0f0f0f0f", final_url: Optional[str] = None, title: str = "Shop") -> PageSnapshot:
    return PageSnapshot(url=url, final_url=final_url or url, status=200, html=f"<html><body>{text}</body></html>",
                        title=title, text=text, forms=list(forms), scripts=list(scripts), links=list(links),
                        content_hash=content_hash, structure_hash=content_hash)


CARD_FORM = FormInfo(action="/pay", method="post", input_names=["card", "cvv", "otp"], asks_card=True, asks_otp=True)
TELEGRAM = ScriptFinding(src=None, suspicious_calls=["telegram_bot_api"], endpoints=["https://api.telegram.org/bot123/sendMessage"])


class World:
    """Configurable fake internet plus call counters."""

    def __init__(self) -> None:
        self.pages: dict[str, PageSnapshot] = {}
        self.intel: dict[str, DomainIntel] = {}
        self.brands: dict[str, BrandMatch] = {}
        self.allow: dict[str, str] = {}
        self.block: set[str] = set()
        self.block_urls: set[str] = set()
        self.url_scores: dict[str, float] = {}
        self.page_score: float = 0.1
        self.fetch_delay = 0.0
        self.review_outcome: Optional[ReviewOutcome] = None
        self.review_error: Optional[Exception] = None
        self.calls: Counter = Counter()

    def reputation(self, value: str):
        """Like intel.reputation: accepts a host or a full URL; URL feeds match the exact URL."""
        self.calls["reputation"] += 1
        p = parse_url(value)
        domain = p.registered_domain
        if domain in self.allow:
            return True, self.allow[domain], False, []
        sources = (["hostfeed"] if domain in self.block else []) + (["urlfeed"] if "/" in value.split("://")[-1] and p.url in self.block_urls else [])
        return False, None, bool(sources), sources

    async def assess_domain(self, url: str, *, fast: bool = False) -> DomainIntel:
        self.calls["assess_domain_fast" if fast else "assess_domain"] += 1
        p = parse_url(url)
        base = self.intel.get(p.registered_domain, DomainIntel(host=p.host, registered_domain=p.registered_domain))
        return base.model_copy(update={"host": p.host, "registered_domain": p.registered_domain})

    def match_brand(self, url: str, snapshot: Optional[PageSnapshot] = None) -> Optional[BrandMatch]:
        return self.brands.get(parse_url(url).registered_domain)

    def score_url(self, url: str) -> Optional[float]:
        return self.url_scores.get(parse_url(url).registered_domain)

    def score_page(self, snapshot: PageSnapshot) -> Optional[float]:
        self.calls["score_page"] += 1
        return self.page_score

    async def fetch_page(self, url: str, *, profile: str = "mobile") -> PageSnapshot:
        self.calls["fetch"] += 1
        self.calls[f"fetch:{url}"] += 1
        if self.fetch_delay:
            await asyncio.sleep(self.fetch_delay)
        key = parse_url(url).url
        if key not in self.pages:
            return PageSnapshot(url=url, final_url=url, status=404, error="not found")
        return self.pages[key].model_copy(deep=True)

    async def review_verdict(self, verdict) -> ReviewResult:
        self.calls["review"] += 1
        if self.review_error:
            raise self.review_error
        outcome = self.review_outcome or ReviewOutcome.CONFIRMED
        decision = {ReviewOutcome.OVERTURNED: Decision.ALLOW, ReviewOutcome.DOWNGRADED: Decision.WARN}.get(outcome, Decision.BLOCK)
        return ReviewResult(outcome=outcome, decision=decision, confidence=0.9, summary_en=f"reviewer: {outcome.value}",
                            summary_ar="المراجع", finished_at=utcnow() + timedelta(seconds=1))

    def components(self, **extra) -> Components:
        return Components(
            reputation=self.reputation, assess_domain=self.assess_domain, match_brand=self.match_brand,
            score_url=self.score_url, score_page=self.score_page, fetch_page=self.fetch_page,
            review_verdict=self.review_verdict, link_campaign=lambda v: None, list_campaigns=lambda: [],
            build_pack=None, cloaking_probe=None, **extra,
        )
