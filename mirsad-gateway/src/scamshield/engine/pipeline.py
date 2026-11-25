"""Layered investigation of one URL: reputation -> URL -> page -> deep crawl -> review of blocks.

Each layer can short-circuit and is timed into `Verdict.timings_ms`. Neighbouring components are reached
through `Components`, which imports them lazily and turns any failure into a recorded, non-fatal finding.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import importlib
import inspect
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

from scamshield import config
from scamshield.engine import llm, rules
from scamshield.engine.crawl import crawl_site
from scamshield.engine.store import HostRecord, Store
from scamshield.schemas import (
    BrandMatch, Decision, DomainIntel, PageSnapshot, Reason, ReviewOutcome, ReviewResult, Stage, Verdict, utcnow,
)

STAGE_RANK = {Stage.REPUTATION: 0, Stage.URL: 1, Stage.PAGE: 2, Stage.DEEP: 3}
DEPTHS = {"reputation": Stage.REPUTATION, "url": Stage.URL, "page": Stage.PAGE, "deep": Stage.DEEP}
URL_LAYER_BLOCK = 95.0  # layer 1 alone blocks only when this sure; otherwise the page is fetched for evidence
FAST_ALLOW_RANK = 5_000  # a top-ranked, non-shared domain with a clean URL is allowed without a fetch
FAST_INTEL_TIMEOUT_S = 1.0
SYNC_TIMEOUT_S = 2.0
FRESH_REUSE_S = float(os.environ.get("SCAMSHIELD_FRESH_REUSE", "30"))  # blind reuse window for a person's revisit
COMPONENT_THREADS = int(os.environ.get("SCAMSHIELD_COMPONENT_THREADS", "8"))
# Admission control: people (user / gateway) are never queued; watcher and batch checks share a small pool,
# step aside while any person's check is in its held phase (layers 0-2) and for a quiet period after it.
FOREGROUND_SOURCES = frozenset({"user", "gateway"})
BACKGROUND_SLOTS = int(os.environ.get("SCAMSHIELD_BACKGROUND_CONCURRENCY", "2"))
BACKGROUND_THREADS = int(os.environ.get("SCAMSHIELD_BACKGROUND_THREADS", "2"))
FOREGROUND_QUIET_S = float(os.environ.get("SCAMSHIELD_FOREGROUND_QUIET", "1.0"))
DEFAULT_EXECUTOR_THREADS = int(os.environ.get("SCAMSHIELD_DNS_THREADS", "64"))  # DNS lookups of fetch / intel
LLM_SLOTS = {"foreground": 4, "background": 1}
STALE_RECHECK_PARALLEL = 2  # re-checks of hosts judged by older code: a few at a time, after a pause each
STALE_RECHECK_PAUSE_S = 1.0  # local lookups and models run in a thread and may not hold the answer longer
PROBE_GRACE_S = 3.0  # the cloaking probe makes three fetches; it may finish in the background deep layer
PROBE_WAIT_S = 0.3  # how long the answer may wait for the cloaking probe after the page itself is in
CONTENT_CHANGED_DISTANCE = 16
REVIEW_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_REVIEW_TIMEOUT", "300"))
PAGE_LEVEL_PREFIXES = ("page.", "deep.", "model.page", "llm.", "host.")
OVERRIDING_REVIEWS = (ReviewOutcome.OVERTURNED, ReviewOutcome.DOWNGRADED)

def _scoring_version() -> str:
    """Identity of everything that decides a score: rules, pipeline, weights, brand logic and models."""
    intel_dir = Path(rules.__file__).resolve().parents[1] / "intel"
    digest = hashlib.sha1()
    for f in (rules.__file__, __file__, rules.WEIGHTS_FILE, intel_dir / "brands.py", *sorted((intel_dir / "data").glob("*.json"))):
        if Path(f).exists():
            digest.update(Path(f).read_bytes())
    for f in sorted(p for p in config.MODEL_DIR.glob("*") if p.is_file()):  # model files are large: stamp, do not read
        stat = f.stat()
        digest.update(f"{f.name}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    digest.update(os.environ.get("SCAMSHIELD_PAGE_ENCODER_URL", "").encode())
    return digest.hexdigest()[:12]


# Cached verdicts are only reused when scored by the same rules, weights, brand logic and models.
SCORING_VERSION = _scoring_version()

REVIEW_REASON = {
    ReviewOutcome.CONFIRMED: "review.confirmed", ReviewOutcome.OVERTURNED: "review.overturned",
    ReviewOutcome.DOWNGRADED: "review.downgraded", ReviewOutcome.INCONCLUSIVE: "review.inconclusive",
}


class Components:
    """Late-bound access to the other teams' functions through their packages' lazy exports.

    Overrides (used by tests) replace a component; `None` marks it as absent. A failed import is retried
    after a short pause so a module that lands while the server runs is picked up.
    """

    PACKAGES = {
        "fetch_page": "scamshield.engine", "assess_domain": "scamshield.intel", "match_brand": "scamshield.intel",
        "reputation": "scamshield.intel", "score_url": "scamshield.models", "score_page": "scamshield.models",
        "build_pack": "scamshield.evidence", "link_campaign": "scamshield.watch",
        "list_campaigns": "scamshield.watch", "review_verdict": "scamshield.review",
        "cloaking_probe": "scamshield.engine.fetch",
    }
    RETRY_AFTER_S = 15.0

    def __init__(self, **overrides: Optional[Callable]) -> None:
        unknown = set(overrides) - set(self.PACKAGES)
        if unknown:
            raise ValueError(f"unknown components: {sorted(unknown)}")
        self._overrides = overrides
        self._failed: dict[str, tuple[float, str]] = {}

    def get(self, name: str) -> Callable:
        if name in self._overrides:
            fn = self._overrides[name]
            if fn is None:
                raise LookupError(f"{name} is not installed")
            return fn
        failed = self._failed.get(name)
        if failed and time.monotonic() - failed[0] < self.RETRY_AFTER_S:
            raise LookupError(failed[1])
        try:
            package = importlib.import_module(self.PACKAGES[name])
            # Resolve through the package's export table: once a submodule of the same name has been
            # imported, plain attribute access returns that module instead of the function.
            module = getattr(package, "_EXPORTS", {}).get(name)
            fn = getattr(importlib.import_module(f"{package.__name__}.{module}") if module else package, name)
            if not callable(fn):
                raise TypeError(f"{self.PACKAGES[name]}.{name} is not callable")
        except Exception as exc:
            message = f"{name} unavailable: {type(exc).__name__}: {exc}"
            self._failed[name] = (time.monotonic(), message)
            raise LookupError(message) from exc
        self._failed.pop(name, None)
        return fn

    def status(self) -> dict[str, str]:
        out = {}
        for name in self.PACKAGES:
            try:
                self.get(name)
                out[name] = "ok"
            except LookupError as exc:
                out[name] = str(exc)
        return out


class Run:
    """State of one investigation: the verdict being built and its findings grouped by layer."""

    def __init__(self, engine: "Engine", verdict: Verdict) -> None:
        self.engine = engine
        self.verdict = verdict
        self.groups: dict[str, list[Reason]] = {}
        self.started = time.perf_counter()
        self.pending_probe: Optional[asyncio.Task] = None

    async def call(self, name: str, *args: Any, label: Optional[str] = None, timeout: Optional[float] = None,
                   thread: bool = False, fn: Optional[Callable] = None, **kwargs: Any) -> Any:
        """Call a component; on any failure record it and return None."""
        label = label or name
        t0 = time.perf_counter()
        try:
            target = fn or self.engine.components.get(name)
            if inspect.iscoroutinefunction(target):
                result = await asyncio.wait_for(target(*args, **kwargs), timeout)
            elif thread:
                call = functools.partial(target, *args, **kwargs)
                pool = self.engine.executor if self.engine.is_foreground(self.verdict.source) else self.engine.background_executor
                result = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(pool, call), timeout)
            else:
                result = target(*args, **kwargs)
        except Exception as exc:
            self.record_error(name, exc)
            result = None
        self.verdict.timings_ms[label] = round((time.perf_counter() - t0) * 1000, 2)
        return result

    def record_error(self, component: str, exc: BaseException) -> None:
        errors = self.groups.setdefault("errors", [])
        if not any(r.evidence.get("component") == component for r in errors):
            message = str(exc) or type(exc).__name__
            errors.append(rules.reason("engine.component_error", component=component, detail=message[:300],
                                       evidence={"component": component, "error": f"{type(exc).__name__}: {message}"[:500]}))

    def merged(self, reasons: list[Reason]) -> list[Reason]:
        """`reasons` plus this run's component errors that are not already recorded."""
        present = {(r.code, r.evidence.get("component")) for r in reasons}
        return reasons + [e for e in self.groups.get("errors", []) if (e.code, e.evidence.get("component")) not in present]

    def rescore(self) -> Verdict:
        return rules.score_verdict(self.verdict, [r for group in self.groups.values() for r in group])

    def time_layer(self, key: str, since: float) -> None:
        self.verdict.timings_ms[key] = round((time.perf_counter() - since) * 1000, 2)


def _infra(intel: Optional[DomainIntel]) -> dict[str, Any]:
    if intel is None:
        return {}
    return {"ips": sorted(intel.ips), "asn": intel.asn,
            "nameservers": sorted({rules.parse_url(ns.rstrip(".")).registered_domain for ns in intel.nameservers}),
            "tls": f"{intel.tls_issuer}|{intel.tls_not_before}" if intel.tls_issuer else None}


def _infra_changes(prev: HostRecord, now: dict[str, Any]) -> list[str]:
    changes = []
    if prev.asn and now.get("asn") and prev.asn != now["asn"]:
        changes.append(f"network AS{prev.asn} -> AS{now['asn']}")
    if prev.nameservers and now.get("nameservers") and set(prev.nameservers) != set(now["nameservers"]):
        changes.append(f"name servers {', '.join(prev.nameservers)} -> {', '.join(now['nameservers'])}")
    return changes


def _fingerprint_changes(prev: HostRecord, page: PageSnapshot, infra: dict[str, Any], url: str) -> list[tuple[str, Any, Any]]:
    """Every fingerprint that differs from what was stored for the host: (kind, old, new)."""
    changes: list[tuple[str, Any, Any]] = []
    if prev.url == url:
        for kind, old, new in (("content", prev.content_hash, page.content_hash), ("structure", prev.structure_hash, page.structure_hash)):
            distance = rules.hash_distance(old, new)
            if distance is not None and distance > config.HASH_SAME_PAGE_DISTANCE:
                changes.append((kind, old, new))
    for kind, old, new in (("ip", prev.ips, infra.get("ips")), ("network", prev.asn, infra.get("asn")),
                           ("nameservers", prev.nameservers, infra.get("nameservers")), ("certificate", prev.tls, infra.get("tls"))):
        if old and new and old != new:
            changes.append((kind, old, new))
    return changes


def _url_scoped(host: str) -> bool:
    """Shorteners and publishing platforms host everyone's links: judge their URLs, never the whole host."""
    return rules.is_shortener(host) or host.removeprefix("www.") in rules.SHARED_HOSTING


def _best_brand(*matches: Optional[BrandMatch]) -> Optional[BrandMatch]:
    found = [m for m in matches if m is not None and m.score > 0]
    return max(found, key=lambda m: m.score) if found else None


class Engine:
    def __init__(self, store: Optional[Store] = None, components: Optional[Components] = None, *,
                 review_enabled: Optional[bool] = None, background_slots: Optional[int] = None) -> None:
        self.store = store or Store(version=SCORING_VERSION)
        self.components = components or Components()
        self.review_enabled = config.REVIEW_ENABLED if review_enabled is None else review_enabled
        self._inflight: dict[tuple, asyncio.Task] = {}
        self._partial: dict[tuple, Verdict] = {}
        self._background: dict[str, asyncio.Task] = {}
        self._reviews: dict[str, asyncio.Task] = {}
        # Own threads for models and local lookups, so hung DNS lookups in the default pool cannot starve them.
        self.executor = ThreadPoolExecutor(max_workers=COMPONENT_THREADS, thread_name_prefix="scamshield-component")
        self.background_executor = ThreadPoolExecutor(max_workers=BACKGROUND_THREADS, thread_name_prefix="scamshield-background")
        self._slots = asyncio.Semaphore(background_slots or BACKGROUND_SLOTS)
        self._llm_slots = {k: asyncio.Semaphore(n) for k, n in LLM_SLOTS.items()}
        self._review_slot = asyncio.Semaphore(1)  # reviews of watcher / batch blocks: one at a time, lowest priority
        self._held = 0  # person-facing investigations in layers 0-2
        self._held_until = 0.0  # monotonic time until which background work keeps quiet
        self._queued: dict[str, int] = {}
        self._running: dict[str, int] = {}

    async def start(self) -> "Engine":
        # A larger default pool for the blocking DNS lookups of fetch / intel, so hung lookups cannot exhaust it.
        asyncio.get_running_loop().set_default_executor(
            ThreadPoolExecutor(max_workers=DEFAULT_EXECUTOR_THREADS, thread_name_prefix="scamshield-dns"))
        await self.store.open()
        return self

    @staticmethod
    def is_foreground(source: str) -> bool:
        return source in FOREGROUND_SOURCES

    async def yield_to_foreground(self, source: str) -> None:
        """Background work waits while a person's check is held, and for a quiet period after."""
        while not self.is_foreground(source) and (self._held or time.monotonic() < self._held_until):
            await asyncio.sleep(0.05)

    def load(self) -> dict[str, Any]:
        return {"held_foreground": self._held, "queued": dict(self._queued), "in_flight": dict(self._running),
                "background_slots": self._slots._value, "reviews_running": len(self._reviews)}

    async def _admitted(self, source: str, coro) -> Verdict:
        """Run an investigation under admission control for its source."""
        if self.is_foreground(source):
            self._held += 1
            self._running[source] = self._running.get(source, 0) + 1
            try:
                return await coro
            finally:
                self._held -= 1
                self._running[source] -= 1
                self._held_until = time.monotonic() + FOREGROUND_QUIET_S
        self._queued[source] = self._queued.get(source, 0) + 1
        admitted = False
        try:
            async with self._slots:
                self._queued[source] -= 1
                admitted = True
                self._running[source] = self._running.get(source, 0) + 1
                try:
                    await self.yield_to_foreground(source)
                    return await coro
                finally:
                    self._running[source] -= 1
        finally:
            if not admitted:
                self._queued[source] -= 1
                coro.close()

    def start_stale_recheck(self) -> None:
        """Low-priority background re-check of hosts whose decision came from older scoring code."""
        self._spawn("stale-recheck", self._recheck_stale())

    async def _recheck_stale(self) -> None:
        gate = asyncio.Semaphore(STALE_RECHECK_PARALLEL)

        async def one(record: HostRecord) -> None:
            async with gate:
                try:  # at the depth that produced the old verdict, so a deep-crawl revocation is re-tested
                    depth = "deep" if record.stage == Stage.DEEP.value or record.revoked else "page"
                    await self.investigate(record.url or f"https://{record.host}/", depth, background=False, source="recheck")
                except Exception:  # one failing host must not stop the sweep; it stays stale
                    pass
                await asyncio.sleep(STALE_RECHECK_PAUSE_S)

        for verdict_id, source in await self.store.unreviewed_blocks(self.store.version):
            if self.review_enabled:  # blocks made before a restart still get their second-opinion review
                self.start_review(verdict_id, source=source)
        await asyncio.gather(*(one(r) for r in self.store.stale_hosts()))

    async def close(self) -> None:
        tasks = [*self._background.values(), *self._reviews.values(), *self._inflight.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.store.close()
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.background_executor.shutdown(wait=False, cancel_futures=True)

    async def warm_up(self) -> None:
        """Load models and lists before the first request so it does not pay for them."""
        probe = PageSnapshot(url="https://example.com/", final_url="https://example.com/", html="<p>x</p>", text="x")
        run = Run(self, Verdict(url=probe.url))
        await asyncio.gather(
            run.call("reputation", "example.com", thread=True), run.call("score_url", probe.url, thread=True),
            run.call("match_brand", probe.url, probe, thread=True), run.call("score_page", probe, thread=True),
        )

    async def drain(self) -> None:
        """Wait for background crawls and reviews (CLI and tests)."""
        while self._background or self._reviews:
            await asyncio.gather(*self._background.values(), *self._reviews.values(), return_exceptions=True)

    # Entry point -------------------------------------------------------------------------------------

    async def investigate(self, url: str, depth: str = "page", *, wait_ms: Optional[float] = None,
                          background: bool = True, source: str = "user") -> Verdict:
        """Run or join an investigation and return once `depth` is done (or `wait_ms` elapses)."""
        if depth not in DEPTHS:
            raise ValueError(f"depth must be one of {sorted(DEPTHS)}")
        key = (rules.parse_url(url).url, depth, self.is_foreground(source))
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._admitted(source, self._investigate(url, DEPTHS[depth], key, background, source)))
            self._inflight[key] = task
            task.add_done_callback(lambda t, k=key: self._forget(k, t))
        if wait_ms is None:
            return (await asyncio.shield(task)).model_copy(deep=True)
        try:
            return (await asyncio.wait_for(asyncio.shield(task), wait_ms / 1000)).model_copy(deep=True)
        except asyncio.TimeoutError:
            partial = self._partial.get(key)
            if partial is not None:
                return partial.model_copy(deep=True)
            p = rules.parse_url(url)
            return Verdict(url=p.url, host=p.host, registered_domain=p.registered_domain,
                           summary_en="Investigation in progress", summary_ar="جارٍ الفحص")

    def _forget(self, key: tuple, task: asyncio.Task) -> None:
        if self._inflight.get(key) is task:
            del self._inflight[key]
            self._partial.pop(key, None)

    async def _investigate(self, url: str, target: Stage, key: tuple, background: bool, source: str) -> Verdict:
        p = rules.parse_url(url)
        verdict = Verdict(url=p.url, host=p.host, registered_domain=p.registered_domain, source=source)
        run = Run(self, verdict)

        reused = await self._reputation_layer(run, p, target)
        if reused is not None:
            return reused
        await self.store.save_verdict(verdict)  # persisted before any event names it
        await self.store.publish("investigation.started", {"verdict_id": verdict.id, "url": p.url, "host": p.host, "source": source})
        if verdict.final or target == Stage.REPUTATION:
            return await self._finish(run)

        await self.yield_to_foreground(source)
        await self._url_layer(run, p)
        self._partial[key] = verdict.model_copy(deep=True)
        host = self.store.host(p.host)
        overturned = bool(host and host.reviewed in {o.value for o in OVERRIDING_REVIEWS})
        if target == Stage.URL or self._url_layer_is_enough(verdict, overturned):
            verdict.final = verdict.decision == Decision.BLOCK or target != Stage.URL
            await self._finish(run)
            answer = verdict.model_copy(deep=True)  # snapshot before background layers touch it
            self._after_answer(run, background, crawl=False)
            return answer
        await self._checkpoint(verdict)

        await self.yield_to_foreground(source)
        deep_done = await self._page_layer(run, p, patient=not background or target == Stage.DEEP)
        self._partial[key] = verdict.model_copy(deep=True)
        crawl = verdict.decision != Decision.BLOCK and not deep_done and bool(p.host) and not verdict.review
        verdict.final = not crawl
        await self._finish(run)
        if crawl and target == Stage.DEEP:
            await self._deep_layer(run)
            if verdict.decision == Decision.BLOCK:
                self._schedule_review(verdict)
            return verdict
        answer = verdict.model_copy(deep=True)
        self._after_answer(run, background, crawl=crawl)
        return answer

    # Layer 0 ------------------------------------------------------------------------------------------

    async def _reputation_layer(self, run: Run, p: rules.ParsedURL, target: Stage) -> Optional[Verdict]:
        t0 = time.perf_counter()
        v = run.verdict
        rep = await run.call("reputation", p.url, label="intel.reputation", thread=True, timeout=SYNC_TIMEOUT_S)  # the URL form also matches URL feeds
        if rep:
            allowlisted, owner, blocklisted, sources = rep
            if blocklisted and _url_scoped(p.host):
                # Feeds list individual short links; on a shortener or platform only the exact URL counts.
                host_rep = await run.call("reputation", p.host, label="intel.reputation_host", thread=True, timeout=SYNC_TIMEOUT_S)
                host_sources = set(host_rep[3]) if host_rep and host_rep[2] else set()
                sources = [s for s in sources if s not in host_sources]
                blocklisted = bool(sources)
            run.groups["reputation"] = rules.reputation_reasons(allowlisted, owner, blocklisted, list(sources or []))
            if allowlisted or blocklisted:
                v.domain = DomainIntel(host=p.host, registered_domain=p.registered_domain, allowlisted=allowlisted,
                                       allowlist_owner=owner, blocklisted=blocklisted, blocklist_sources=list(sources or []))
                v.final = True
        if not v.final:
            cached = await self._reusable(p, target, v.source)
            if cached is not None:
                cached.timings_ms = {**cached.timings_ms, "layer0_cache_hit": round((time.perf_counter() - t0) * 1000, 2)}
                return cached
        run.rescore()
        run.time_layer("layer0_reputation", t0)
        return None

    async def _reusable(self, p: rules.ParsedURL, target: Stage, source: str) -> Optional[Verdict]:
        """A stored verdict that may answer this check without investigating again.

        A person's revisit reuses blindly only within a short freshness window, except on long-established
        hosts; after it the page is fetched again and its fuzzy hash decides whether the stored analysis
        still holds (layer 2). Background checks reuse for the whole verdict lifetime.
        """
        record = self.store.host(p.host)
        settled = record is not None and record.reputation in ("trusted", "established")
        max_age = config.VERDICT_TTL_S if settled or not self.is_foreground(source) else FRESH_REUSE_S
        cached = await self.store.latest_for_url(p.url, max_age)
        if cached is not None and target == Stage.DEEP and not cached.final and cached.id in self._background:
            await asyncio.shield(self._background[cached.id])
            cached = await self.store.get_verdict(cached.id)
        if cached is not None and (cached.final or STAGE_RANK[cached.stage] >= STAGE_RANK[target]):
            return cached
        host = record
        if (host and host.decision == Decision.BLOCK.value and time.time() - host.updated_at < config.VERDICT_TTL_S
                and source != "recheck" and not _url_scoped(p.host) and await self.store.is_current(host.verdict_id)):
            blocked = await self.store.get_verdict(host.verdict_id)
            seen = rules.parse_url(blocked.url) if blocked else None
            if seen and (seen.scheme, seen.port) == (p.scheme, p.port):  # the same site, not another port or scheme
                return blocked
        return None

    # Layer 1 ------------------------------------------------------------------------------------------

    async def _url_layer(self, run: Run, p: rules.ParsedURL) -> None:
        t0 = time.perf_counter()
        v = run.verdict
        intel_task = asyncio.create_task(run.call("assess_domain", p.url, fast=True, label="intel.assess_domain_fast",
                                                  timeout=FAST_INTEL_TIMEOUT_S))
        if not rules.is_shortener(p.host):  # a shortener is expanded by the page layer and scored there
            if not rules.non_latin_idn(p):  # the URL model was not trained on non-Latin hosts: it abstains
                v.url_model_score = await run.call("score_url", p.url, label="models.score_url", thread=True, timeout=SYNC_TIMEOUT_S)
            v.brand = await run.call("match_brand", p.url, None, label="intel.match_brand_url", thread=True, timeout=SYNC_TIMEOUT_S)
        v.domain = await intel_task or v.domain
        run.groups["url"] = rules.url_reasons(p, v.domain)
        run.groups["domain"] = rules.domain_reasons(v.domain, p.host)
        run.groups["brand"] = rules.brand_reasons(v.brand)
        run.groups["models"] = [r for r in [rules.model_reason("model.url", v.url_model_score)] if r]
        v.stage = Stage.URL
        run.rescore()
        run.time_layer("layer1_url", t0)

    @staticmethod
    def _url_layer_is_enough(v: Verdict, overturned: bool) -> bool:
        if v.risk_score >= URL_LAYER_BLOCK and not overturned:
            return True
        d = v.domain
        top = (d is not None and d.popularity_rank is not None and d.popularity_rank <= FAST_ALLOW_RANK
               and not (rules.user_site(v.host, d) or d.is_shortener or rules.is_shortener(v.host)))
        clean = not any(r.points >= 5 and not r.code.startswith("model.") for r in v.reasons)
        return top and clean and v.decision == Decision.ALLOW

    # Layer 2 ------------------------------------------------------------------------------------------

    async def _page_layer(self, run: Run, p: rules.ParsedURL, *, patient: bool) -> bool:
        """Fetch and analyse the page. Returns True when a previous deep analysis was reused."""
        t0 = time.perf_counter()
        v = run.verdict
        budget = config.PAGE_LAYER_BUDGET_S
        deadline = t0 + budget  # a real deadline for the whole layer, not per call

        def left() -> float:
            return max(0.05, deadline - time.perf_counter())

        fetch_task = asyncio.create_task(run.call("fetch_page", p.url, label="fetch_page", timeout=budget))
        intel_task = asyncio.create_task(run.call("assess_domain", p.url, fast=False, label="intel.assess_domain", timeout=budget))
        probe_task = None
        if not rules.is_established(v.domain, p.host):
            probe_task = asyncio.create_task(run.call("cloaking_probe", p.url, label="fetch.cloaking_probe",
                                                      timeout=budget + PROBE_GRACE_S))
        page: Optional[PageSnapshot] = await fetch_task
        entry_intel: Optional[DomainIntel] = await intel_task or v.domain
        if page is None:
            page = PageSnapshot(url=p.url, final_url=p.url, error=f"page could not be fetched within {budget:.0f}s")
        fp = rules.parse_url(page.final_url or p.url)
        final_intel = entry_intel
        if fp.registered_domain != p.registered_domain:
            final_intel = await run.call("assess_domain", fp.url, fast=False, label="intel.assess_domain_final",
                                         timeout=left()) or entry_intel
            run.groups["url"] = list({r.code: r for r in rules.url_reasons(p, entry_intel) + rules.url_reasons(fp, final_intel)}.values())
            final_url_score = await run.call("score_url", fp.url, label="models.score_url_final", thread=True, timeout=left())
            if final_url_score is not None:
                v.url_model_score = max(final_url_score, v.url_model_score or 0.0)
                run.groups["models"] = [rules.model_reason("model.url", v.url_model_score)]
        if page.html and fp.scheme == "https":  # the address upgraded itself to HTTPS: the connection is encrypted
            run.groups["url"] = [r for r in run.groups.get("url", []) if r.code != "url.no_tls"]
        page_brand = await run.call("match_brand", fp.url, page, label="intel.match_brand_page", thread=True, timeout=left()) if page.html else None
        v.brand = _best_brand(v.brand, page_brand)
        shortener_entry = rules.is_shortener(p.host) or bool(entry_intel and entry_intel.is_shortener)
        v.domain = final_intel if shortener_entry else entry_intel
        v.page, v.final_url, v.redirect_chain = page, page.final_url or p.url, page.redirect_chain
        run.groups["domain"] = rules.merged_domain_reasons(entry_intel, p.host, final_intel, fp.host)
        run.groups["brand"] = rules.brand_reasons(v.brand)

        infra = _infra(entry_intel)
        previous = self.store.host(p.host)
        reuse, deep_done = await self._reuse_page_analysis(run, previous, page, infra)
        if reuse and probe_task:
            probe_task.cancel()
        if not reuse:
            probe = None
            if probe_task:  # never hold the answer for the probe; a late result is scored by the deep layer
                done, _ = await asyncio.wait({probe_task}, timeout=left() if patient else min(PROBE_WAIT_S, left()))
                probe = probe_task.result() if done else None
                if not done:
                    run.pending_probe = probe_task
            established = rules.is_established(v.domain, fp.host)
            run.groups["page"] = (rules.page_reasons(page, final_intel, v.brand, entry_intel)
                                  + rules.cloaking_probe_reasons(probe, established) + self._change_reasons(previous, page, infra, p.url))
            if page.html:
                v.page_model_score = await run.call("score_page", page, label="models.score_page", thread=True, timeout=left())
                if v.page_model_score is not None:
                    run.groups["models"] = run.groups.get("models", []) + [rules.model_reason("model.page", v.page_model_score)]
            run.rescore()
            if patient:  # otherwise the judge runs in the background with the deep layer
                await self._llm_judge(run, page)
        v.stage = Stage.PAGE
        run.rescore()
        run.time_layer("layer2_page", t0)
        await self._remember_host(v, page, infra, previous)
        return deep_done

    def _change_reasons(self, prev: Optional[HostRecord], page: PageSnapshot, infra: dict[str, Any], url: str) -> list[Reason]:
        if prev is None:
            return []
        out = []
        changes = _infra_changes(prev, infra)
        if changes:
            out.append(rules.reason("host.infrastructure_changed", what="; ".join(changes), evidence={"changes": changes}))
        distance = rules.hash_distance(prev.content_hash, page.content_hash)
        if prev.url == url and distance is not None and distance > CONTENT_CHANGED_DISTANCE:
            out.append(rules.reason("host.content_changed", evidence={"hamming_distance": distance}))
        return out

    async def _reuse_page_analysis(self, run: Run, prev: Optional[HostRecord], page: PageSnapshot,
                                   infra: dict[str, Any]) -> tuple[bool, bool]:
        """Reuse the previous page analysis when the page and its hosting are unchanged."""
        v = run.verdict
        if prev is None or not prev.page_verdict_id or prev.url != v.url or _infra_changes(prev, infra):
            return False, False
        if prev.version != self.store.version:
            return False, False  # analysed by other rules or models: an unchanged page still needs a fresh look
        distance = rules.hash_distance(prev.content_hash or prev.structure_hash, page.content_hash or page.structure_hash)
        if distance is None or distance > config.HASH_SAME_PAGE_DISTANCE:
            return False, False
        old = await self.store.get_verdict(prev.page_verdict_id)
        if old is None:
            return False, False
        carried = [r for r in old.reasons if r.code.startswith(PAGE_LEVEL_PREFIXES) and r.code != "page.unchanged"]
        if old.review and old.review.outcome in OVERRIDING_REVIEWS:
            carried += [r for r in old.reasons if r.code.startswith("review.")]
            v.review = old.review
        run.groups["page"] = carried + [rules.reason("page.unchanged", evidence={"hamming_distance": distance, "previous_verdict": old.id})]
        run.groups["models"] = [r for r in run.groups.get("models", []) if r.code != "model.page"] + [r for r in old.reasons if r.code == "model.page"]
        v.page_model_score, v.llm_score, v.pages_crawled = old.page_model_score, old.llm_score, old.pages_crawled
        return True, old.stage == Stage.DEEP

    async def _llm_judge(self, run: Run, page: Optional[PageSnapshot]) -> None:
        v = run.verdict
        if not llm.enabled() or not llm.in_band(v.risk_score):
            return
        if page is None or page.error or not (page.text or page.forms):
            return  # nothing was retrieved: an empty page is not evidence for the judge to weigh
        facts = llm.distil(v.final_url or v.url, page, v.domain, v.brand)
        await self.yield_to_foreground(v.source)
        async with self._llm_slots["foreground" if self.is_foreground(v.source) else "background"]:
            judgement = await run.call("llm", facts, fn=llm.judge, timeout=llm.TIMEOUT_S + 1)
        if judgement is None:
            return
        v.llm_score = judgement.score
        r = rules.model_reason("llm.judge", judgement.score, verdict=judgement.verdict,
                               reasons_en=judgement.reasons_en, reasons_ar=judgement.reasons_ar)
        r.detail = "; ".join(judgement.reasons_en)
        run.groups["models"] = run.groups.get("models", []) + [r]
        run.rescore()

    async def _remember_host(self, v: Verdict, page: PageSnapshot, infra: dict[str, Any], prev: Optional[HostRecord]) -> None:
        record = prev or HostRecord(host=v.host)
        if prev:
            await self.store.record_changes(record, _fingerprint_changes(prev, page, infra, v.url))
        if page.content_hash or page.structure_hash:
            record.url, record.content_hash, record.structure_hash = v.url, page.content_hash, page.structure_hash
        record.ips = infra.get("ips") or record.ips
        record.asn = infra.get("asn") or record.asn
        record.nameservers = infra.get("nameservers") or record.nameservers
        record.tls = infra.get("tls") or record.tls
        if page.html:
            record.page_verdict_id = v.id
        await self.store.save_host(record)

    # Layer 3 ------------------------------------------------------------------------------------------

    def _after_answer(self, run: Run, background: bool, *, crawl: bool) -> None:
        v = run.verdict
        if crawl and background:
            self._spawn(v.id, self._background_deep(run))
            return
        if run.pending_probe:
            run.pending_probe.cancel()
        if v.decision == Decision.BLOCK and background:
            self._schedule_review(v)

    def _spawn(self, verdict_id: str, coro) -> None:
        task = asyncio.create_task(coro)
        self._background[verdict_id] = task
        task.add_done_callback(lambda t: self._background.pop(verdict_id, None) if self._background.get(verdict_id) is t else None)

    async def _background_deep(self, run: Run) -> None:
        v = run.verdict
        await self._deep_layer(run)
        if v.decision == Decision.BLOCK:
            self._schedule_review(v)

    async def _deep_layer(self, run: Run) -> None:
        """Crawl the site; a late high-severity finding that tips the score to block revokes the allow."""
        t0 = time.perf_counter()
        v = run.verdict
        before = v.decision
        if v.llm_score is None:
            await self._llm_judge(run, v.page)
        findings: list[Reason] = []
        known = {r.code for r in v.reasons}

        async def fetch(url: str) -> PageSnapshot:
            # A person is already on this site, so their crawl must not wait; only watcher and batch crawls step aside.
            await self.yield_to_foreground(v.source if self.is_foreground(v.source) else "deep-crawl")
            return await self.components.get("fetch_page")(url)

        async def inspect_page(page: PageSnapshot) -> bool:
            brand = await run.call("match_brand", page.final_url or page.url, page, label="intel.match_brand_deep", thread=True,
                                   timeout=SYNC_TIMEOUT_S)
            found = rules.page_reasons(page, v.domain, _best_brand(v.brand, brand)) + rules.brand_reasons(brand)
            for r in found:
                if r.code in known or r.code in ("page.unreachable", "page.empty_shell"):
                    continue
                known.add(r.code)
                r.evidence = {**r.evidence, "found_by": "deep_crawl", "page_url": page.final_url or page.url}
                r.detail = (r.detail + " " if r.detail else "") + f"Found on {page.final_url or page.url}"
                findings.append(r)
                if rules.is_high_finding(r):
                    trial = rules.score_verdict(v.model_copy(), v.reasons + findings)
                    if trial.decision == Decision.BLOCK:
                        return True
            return False

        if run.pending_probe:
            probe = await run.pending_probe
            for r in rules.cloaking_probe_reasons(probe, rules.is_established(v.domain, v.host)):
                r.evidence["found_by"] = "deep_layer"
                findings.append(r)
                known.add(r.code)
        if v.page is not None and v.page.html:
            try:
                report = await crawl_site(v.page, fetch, inspect_page)
                v.pages_crawled = report.pages
            except Exception as exc:
                run.record_error("crawl", exc)
        rules.score_verdict(v, run.merged(v.reasons + findings))
        if before != Decision.BLOCK and v.decision == Decision.BLOCK:
            trigger = next((r for r in findings if rules.is_high_finding(r)), None)
            page_url = trigger.evidence.get("page_url", v.url) if trigger else v.url
            rules.score_verdict(v, v.reasons + [rules.reason("deep.revoked", url=page_url, evidence={"page_url": page_url, "previous_decision": before.value})])
        v.stage, v.final = Stage.DEEP, True
        run.time_layer("layer3_deep", t0)
        await self._finish(run, revoked=before != Decision.BLOCK and v.decision == Decision.BLOCK)

    # Layer 4 ------------------------------------------------------------------------------------------

    def _schedule_review(self, v: Verdict) -> None:
        if self.review_enabled and v.review is None and v.decision == Decision.BLOCK:
            self.start_review(v.id, source=v.source)

    def start_review(self, verdict_id: str, *, source: str = "user") -> bool:
        """Run `review` in the background (once at a time per verdict); False if one is already running.

        Reviews of watcher / batch blocks run one at a time and step aside for people's checks.
        """
        if verdict_id in self._reviews:
            return False
        task = asyncio.create_task(self.review(verdict_id) if self.is_foreground(source) else self._low_priority_review(verdict_id))
        self._reviews[verdict_id] = task
        task.add_done_callback(lambda t: self._reviews.pop(verdict_id, None))
        return True

    async def _low_priority_review(self, verdict_id: str) -> Optional[Verdict]:
        async with self._review_slot:
            await self.yield_to_foreground("review")
            return await self.review(verdict_id)

    async def review(self, verdict_id: str) -> Optional[Verdict]:
        """Run the second-opinion review on a stored verdict and apply its outcome."""
        v = await self.store.get_verdict(verdict_id)
        if v is None:
            return None
        run = Run(self, v)
        kwargs = {}
        try:
            if "on_step" in inspect.signature(self.components.get("review_verdict")).parameters:
                kwargs["on_step"] = lambda step: self.store.bus.publish(
                    {"type": "review.step", "ts": time.time(), "verdict_id": v.id, "host": v.host, **step.model_dump(mode="json")})
        except (LookupError, TypeError, ValueError):
            pass
        result: Optional[ReviewResult] = await run.call("review_verdict", v.model_copy(deep=True), label="layer4_review",
                                                        timeout=REVIEW_TIMEOUT_S, **kwargs)
        if not isinstance(result, ReviewResult):
            if result is not None:
                run.record_error("review_verdict", TypeError(f"expected ReviewResult, got {type(result).__name__}"))
            rules.score_verdict(v, run.merged(v.reasons))
            await self._finish(run, event=False)
            return v
        v.review = result
        steps = [s.model_dump(mode="json") for s in result.steps][:20]
        r = rules.reason(REVIEW_REASON[result.outcome], detail=result.summary_en,
                         evidence={"confidence": result.confidence, "model": result.model, "summary_ar": result.summary_ar,
                                   "recommended": result.decision.value, "steps": steps})
        rules.score_verdict(v, [x for x in v.reasons if not x.code.startswith("review.")] + [r])
        await self._finish(run, event=False)
        await self.store.publish("verdict.reviewed", {"verdict_id": v.id, "host": v.host, "outcome": result.outcome.value,
                                                      "decision": v.decision.value})
        return v

    # Persistence --------------------------------------------------------------------------------------

    async def _checkpoint(self, v: Verdict) -> None:
        v.updated_at = utcnow()
        await self.store.save_verdict(v)
        await self.store.publish("layer.done", self._event(v))

    async def _finish(self, run: Run, *, revoked: bool = False, event: bool = True) -> Verdict:
        v = run.verdict
        # Campaign linking serves the dashboard and takedowns; scoring a batch does not need it.
        if (v.decision != Decision.ALLOW and v.campaign_id is None and v.source != "batch"
                and STAGE_RANK[v.stage] >= STAGE_RANK[Stage.URL]):
            v.campaign_id = await run.call("link_campaign", v, label="watch.link_campaign", thread=True, timeout=3.0)
            rules.score_verdict(v, run.merged(v.reasons))
        v.timings_ms.setdefault("total", round((time.perf_counter() - run.started) * 1000, 2))
        v.updated_at = utcnow()
        await self.store.save_verdict(v)
        await self._update_host(v, revoked)
        if revoked:
            await self.store.publish("verdict.revoked", self._event(v))
        elif event:
            await self.store.publish("verdict.updated", self._event(v))
        return v

    async def _update_host(self, v: Verdict, revoked: bool) -> None:
        if not v.host:
            return
        record = self.store.host(v.host) or HostRecord(host=v.host)
        retested = v.source == "recheck" and v.stage == Stage.DEEP  # a deep re-check may clear an older block
        fresh_block = (record.decision == Decision.BLOCK.value and record.verdict_id != v.id and not self.store.is_stale(record)
                       and time.time() - record.updated_at < config.VERDICT_TTL_S and not retested)
        if (fresh_block and v.decision != Decision.BLOCK) or (_url_scoped(v.host) and v.decision == Decision.BLOCK):
            return
        if record.revoked and record.verdict_id != v.id and v.decision != Decision.BLOCK and v.stage != Stage.DEEP:
            return  # a deep-crawl revocation stands until a deep re-check clears it
        record.revoked = revoked or (record.revoked and record.verdict_id == v.id)  # a newer verdict clears the flag
        record.decision, record.risk_score, record.stage = v.decision.value, v.risk_score, v.stage.value
        record.final, record.verdict_id = v.final, v.id
        record.reviewed = v.review.outcome.value if v.review else ""
        record.version = self.store.version
        d = v.domain
        record.registered_domain = v.registered_domain
        record.source = record.source if v.source == "recheck" else v.source
        record.campaign_id, record.last_checked = v.campaign_id, time.time()
        if d is not None:
            record.allowlisted, record.owner, record.blocklisted = d.allowlisted, d.allowlist_owner, d.blocklisted
            record.popularity_rank = d.popularity_rank if d.popularity_rank is not None else record.popularity_rank
            record.domain_age_days = d.age_days if d.age_days is not None else record.domain_age_days
        await self.store.save_host(record)
        self.store.bus.publish({"type": "host.updated", "ts": time.time(), "host": v.host, "decision": record.decision,
                                "reputation": record.reputation, "risk_score": record.risk_score, "verdict_id": v.id})

    @staticmethod
    def _event(v: Verdict) -> dict[str, Any]:
        return {"verdict_id": v.id, "url": v.url, "host": v.host, "source": v.source, "decision": v.decision.value,
                "risk_score": v.risk_score, "stage": v.stage.value, "final": v.final,
                "summary_en": v.summary_en, "summary_ar": v.summary_ar}


_engine: Optional[Engine] = None


async def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = await Engine().start()
    return _engine


async def investigate(url: str, *, depth: str = "page") -> Verdict:
    """Contract entry point: investigate `url` to `depth` with the process-wide engine."""
    return await (await get_engine()).investigate(url, depth)
