"""Fake evidence sources and a scripted judge for the review tests. No network."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional

from scamshield.review.llm import Judge, JudgeError, ToolCall, Turn
from scamshield.review.sources import BrandRecord, Registration, SearchProvider, SearchResult, registered_domain
from scamshield.review.tools import Sources
from scamshield.schemas import (BrandMatch, Decision, DomainIntel, FormInfo, PageSnapshot, Reason, ScriptFinding,
                                Severity, Verdict)

BANK = BrandRecord(name="Example Bank", name_ar="بنك المثال", category="bank",
                   official_domains=["examplebank.ae"], phones=["+97180000103"], terms=["Example Bank", "examplebank"])


def page(url: str, *, title: str = "Example Bank", text: str = "", forms: Optional[list[FormInfo]] = None,
         links: Optional[list[str]] = None, scripts: Optional[list[ScriptFinding]] = None) -> PageSnapshot:
    return PageSnapshot(url=url, final_url=url, status=200, title=title, text=text, html=f"<html>{text}</html>",
                        forms=forms or [], links=links or [], scripts=scripts or [])


def registration(domain: str, days: Optional[int]) -> Registration:
    if days is None:
        return Registration(domain=domain, source="fake", error="RDAP HTTP 404")
    return Registration(domain=domain, created=datetime.now(timezone.utc) - timedelta(days=days),
                        registrar="Fake Registrar", source="fake")


class FakeSearch(SearchProvider):
    name = "fake-search"

    def __init__(self, results: Optional[dict[str, list[SearchResult]]] = None, delay: float = 0.0):
        self.results = results or {}
        self.delay = delay
        self.queries: list[str] = []

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        self.queries.append(query)
        await asyncio.sleep(self.delay)
        for key, rows in self.results.items():
            if key in query:
                return rows[:limit]
        return []


def fake_sources(*, pages: dict[str, PageSnapshot], ages: dict[str, Optional[int]],
                 owners: Optional[dict[str, list[str]]] = None, official: Optional[dict[str, list[str]]] = None,
                 registry: Iterable[BrandRecord] = (BANK,), allowlist: Optional[dict[str, str]] = None,
                 cloaking: bool = False, search: Optional[FakeSearch] = None, delay: float = 0.0,
                 fetched: Optional[list[tuple[str, str]]] = None, archive: Optional[dict[str, int]] = None,
                 ranks: Optional[dict[str, int]] = None, shared: Iterable[str] = (),
                 form_hosts: Iterable[str] = ("salesforce.com",), blocklist: Optional[dict[str, list[str]]] = None) -> Sources:
    """A small world: `ages` are registration ages per registered domain, `archive` first captures per host."""
    owners, official, allowlist = owners or {}, official or {}, allowlist or {}
    archive, ranks, blocklist = archive or {}, ranks or {}, blocklist or {}
    registry, shared = list(registry), set(shared)

    async def fetch_page(url: str, profile: str = "mobile") -> PageSnapshot:
        if fetched is not None:
            fetched.append((url, profile))
        await asyncio.sleep(delay)
        found = pages.get(url) or pages.get(url.rstrip("/")) or next(
            (p for u, p in pages.items() if u.rstrip("/") == url.rstrip("/")), None)
        if found is None:
            return PageSnapshot(url=url, final_url=url, status=404, title="Not found", text="")
        return found.model_copy()

    async def fetch_light(url: str) -> PageSnapshot:
        return await fetch_page(url, "light")

    async def archive_history(host: str) -> dict[str, Any]:
        await asyncio.sleep(delay)
        days = archive.get(host)
        if days is None:
            return {"captures": 0}
        first = datetime.now(timezone.utc) - timedelta(days=days)
        return {"captures": 1, "first_seen": first.date().isoformat(), "first_seen_days": days}

    async def cloaking_probe(url: str) -> dict[str, Any]:
        await asyncio.sleep(delay)
        return {"verdict": "cloaking" if cloaking else "consistent", "cloaking": cloaking, "signals": []}

    async def assess_domain(url: str) -> DomainIntel:
        await asyncio.sleep(delay)
        domain = registered_domain(url)
        return DomainIntel(host=domain, registered_domain=domain, age_days=ages.get(domain),
                           allowlisted=domain in allowlist, allowlist_owner=allowlist.get(domain),
                           popularity_rank=ranks.get(domain))

    async def raw_registration(domain: str) -> Registration:
        await asyncio.sleep(delay)
        return registration(domain, ages.get(domain))

    async def certificate_history(host: str) -> dict[str, Any]:
        await asyncio.sleep(delay)
        domain = registered_domain(host)
        days = ages.get(host, ages.get(domain) if host in (domain, f"www.{domain}") else None)
        if days is None:
            return {"error": "no certificates"}
        first = datetime.now(timezone.utc) - timedelta(days=days)
        return {"certificates": 3, "first_seen": first.date().isoformat(), "first_seen_days": days}

    def brand_record(name: str) -> Optional[BrandRecord]:
        return next((b for b in registry if b.name.lower() == name.strip().lower()), None)

    def brand_owning(host: str) -> Optional[BrandRecord]:
        domain = registered_domain(host)
        return next((b for b in registry if domain in b.official_domains), None)

    def reputation(host: str):
        domain = registered_domain(host)
        return (domain in allowlist, allowlist.get(domain), domain in blocklist, blocklist.get(domain, []))

    async def domain_owner(domain: str) -> dict[str, Any]:
        await asyncio.sleep(delay)
        return {"source": "wikidata", "organisations": [
            {"id": "Q1", "name": name, "official_websites": [f"https://www.{domain}/"]}
            for name in owners.get(domain, [])]}

    async def official_website(organisation: str) -> dict[str, Any]:
        await asyncio.sleep(delay)
        domains = official.get(organisation, [])
        return {"query": organisation, "official_sites": {"wikidata:Q1": [f"https://{d}/" for d in domains]},
                "official_domains": domains, "errors": []}

    return Sources(fetch_page=fetch_page, cloaking_probe=cloaking_probe, assess_domain=assess_domain,
                   raw_registration=raw_registration, certificate_history=certificate_history,
                   brand_record=brand_record, brand_owning=brand_owning, reputation=reputation,
                   domain_owner=domain_owner, official_website=official_website, archive_history=archive_history,
                   fetch_light=fetch_light, popularity_rank=lambda d: ranks.get(d), registry_brand=brand_record,
                   known_form_hosts=lambda: frozenset(form_hosts),
                   shared_platform=lambda h: any(h == p or h.endswith("." + p) for p in shared),
                   search=search or FakeSearch())


def blocked(url: str, *, brand: Optional[BrandMatch] = None, age: Optional[int] = None,
            snapshot: Optional[PageSnapshot] = None, reasons: Optional[list[Reason]] = None) -> Verdict:
    from scamshield.review.sources import host_of

    host = host_of(url)
    return Verdict(url=url, final_url=url, host=host, registered_domain=registered_domain(host),
                   decision=Decision.BLOCK, risk_score=82, brand=brand, page=snapshot,
                   domain=DomainIntel(host=host, registered_domain=registered_domain(host), age_days=age),
                   reasons=reasons or [Reason(code="model.page", severity=Severity.HIGH, points=35,
                                              title_en="Page model flags phishing", detail="p=0.93")])


class ScriptedJudge(Judge):
    """Plays back a fixed list of turns; each turn is a list of (tool, arguments)."""

    def __init__(self, turns: Iterable[list[tuple[str, dict[str, Any]]]] = (), *,
                 forever: Optional[Callable[[int], list[tuple[str, dict[str, Any]]]]] = None,
                 tokens: int = 500, delay: float = 0.0, fail: bool = False):
        self.name = "scripted"
        self.turns = list(turns)
        self.forever = forever
        self.tokens = tokens
        self.delay = delay
        self.fail = fail
        self.system = self.user = ""
        self.tools: list[dict[str, Any]] = []
        self.results: list[tuple[ToolCall, str]] = []
        self.nudges: list[str] = []
        self.calls = 0

    def start(self, system: str, user: str, tools: list[dict[str, Any]]) -> None:
        self.system, self.user, self.tools = system, user, tools

    async def step(self, max_tokens: int, timeout: float) -> Turn:
        self.calls += 1
        await asyncio.sleep(self.delay)
        if self.fail:
            raise JudgeError("provider down")
        if self.turns:
            plan = self.turns.pop(0)
        elif self.forever is not None:
            plan = self.forever(self.calls)
        else:
            plan = []
        return Turn(tool_calls=[ToolCall(f"call{self.calls}_{i}", name, args) for i, (name, args) in enumerate(plan)],
                    tokens=self.tokens, stop="tool_use" if plan else "end_turn")

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        self.results.extend(results)

    def add_user(self, text: str) -> None:
        self.nudges.append(text)


def submit(outcome: str, *, en: str = "Summary.", ar: str = "ملخص المراجعة.", confidence: float = 0.9,
           manipulation: bool = False) -> tuple[str, dict[str, Any]]:
    return ("submit_decision", {"outcome": outcome, "confidence": confidence, "summary_en": en, "summary_ar": ar,
                                "key_evidence": [], "manipulation_attempt_seen": manipulation})
