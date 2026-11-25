"""Layer 3: background same-site crawl that hunts for the pages scammers hide behind the landing page."""

from __future__ import annotations

import asyncio
import heapq
import itertools
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import unquote, urldefrag, urljoin

from scamshield import config
from scamshield.engine.rules import parse_url
from scamshield.intel import lists
from scamshield.schemas import PageSnapshot

Fetch = Callable[[str], Awaitable[PageSnapshot]]
Inspect = Callable[[PageSnapshot], Awaitable[bool]]  # returns True to stop the crawl

PRIORITY_WORDS = lists.words("lexicon", "crawl_priority_words")
_SKIP = re.compile(r"\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|eot|pdf|zip|rar|7z|mp4|mp3|webm|avi|xml|json|txt)(?:$|\?)", re.I)
_LOGOUT = re.compile(r"log-?out|sign-?out|تسجيل-?الخروج", re.I)


@dataclass
class CrawlReport:
    pages: int = 0
    visited: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    stopped_early: bool = False
    elapsed_ms: float = 0.0


def link_priority(url: str) -> int:
    text = unquote(url).lower()
    return sum(word in text for word in PRIORITY_WORDS)


def _candidates(page: PageSnapshot, site: set[str]) -> list[str]:
    base = page.final_url or page.url
    out = []
    for href in page.links:
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "data:", "#", "sms:", "whatsapp:")):
            continue
        absolute = urldefrag(urljoin(base, href)).url
        if not absolute.startswith(("http://", "https://")) or _SKIP.search(absolute) or _LOGOUT.search(absolute):
            continue
        if parse_url(absolute).registered_domain in site:
            out.append(absolute)
    return out


async def crawl_site(start: PageSnapshot, fetch: Fetch, inspect: Inspect, *,
                     max_pages: int | None = None, budget_s: float | None = None) -> CrawlReport:
    """Breadth-first crawl of the site behind `start`, most promising links first.

    Redirects are followed wherever they lead and the page reached is inspected; only links back into
    the site itself are queued, so one redirect to a large portal cannot swallow the budget.
    `inspect` sees every fetched page and can stop the crawl (e.g. once a high-severity finding is made).
    """
    max_pages = config.DEEP_CRAWL_MAX_PAGES if max_pages is None else max_pages
    budget_s = config.DEEP_CRAWL_BUDGET_S if budget_s is None else budget_s
    started = time.perf_counter()
    deadline = started + budget_s
    report = CrawlReport()
    site = {parse_url(start.url).registered_domain, parse_url(start.final_url or start.url).registered_domain}
    seen = {parse_url(start.url).url, parse_url(start.final_url or start.url).url}
    order = itertools.count()
    queue: list[tuple[int, int, int, str]] = []

    def enqueue(page: PageSnapshot, depth: int) -> None:
        for link in _candidates(page, site):
            key = parse_url(link).url
            if key not in seen:
                seen.add(key)
                heapq.heappush(queue, (-link_priority(link), depth, next(order), link))

    enqueue(start, 1)
    while queue and report.pages < max_pages:
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            break
        _, depth, _, url = heapq.heappop(queue)
        try:
            page = await asyncio.wait_for(fetch(url), timeout=min(remaining, config.FETCH_TIMEOUT_S + 2))
        except Exception as exc:
            report.errors.append(f"{url}: {type(exc).__name__}: {exc}"[:300])
            continue
        report.pages += 1
        report.visited.append(page.final_url or url)
        if await inspect(page):
            report.stopped_early = True
            break
        if depth < 3:
            enqueue(page, depth + 1)
    report.elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    return report
