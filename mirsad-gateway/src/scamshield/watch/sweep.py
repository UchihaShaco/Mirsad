"""Look-alike sweep: generate look-alikes of every official UAE brand domain and resolve them in bulk.

Anything that resolves and is not owned by the brand (not official, no shared IP with the official site)
is queued (a non-CDN address shared with the official site counts as brand-owned). Results are stored in `data/watch.db` (`sweep` table), so a restart skips names checked within
`SCAMSHIELD_WATCH_SWEEP_RECHECK` seconds. Uses `scamshield.intel.generate_lookalikes` when available.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import AsyncIterator, Iterable

import dns.asyncresolver
import dns.exception
import dns.resolver

from scamshield.intel import lists
from scamshield.watch import settings
from scamshield.watch.base import Candidate
from scamshield.watch.brands import Brand, is_official, load_brands
from scamshield.watch.infra import is_parking_ip, is_shared_ip
from scamshield.watch.match import match_host, split_host
from scamshield.watch.store import Store

log = logging.getLogger(__name__)

_KEYBOARD = {
    "q": "wa", "w": "qes", "e": "wrd", "r": "etf", "t": "ryg", "y": "tuh", "u": "yij", "i": "uok", "o": "ipl",
    "p": "ol", "a": "qsz", "s": "awdz", "d": "sefx", "f": "drgc", "g": "fthv", "h": "gyjb", "j": "hukn",
    "k": "jilm", "l": "kop", "z": "asx", "x": "zsdc", "c": "xdfv", "v": "cfgb", "b": "vghn", "n": "bhjm", "m": "njk",
}
_GLYPHS = {"o": "0", "l": "1i", "i": "1l", "e": "3", "a": "4", "s": "5", "m": "rn", "w": "vv", "d": "cl", "g": "q", "b": "8"}
_AFFIXES = lists.words("lexicon", "sweep_affixes")
_CORE_TLDS = lists.words("tlds", "sweep_core_tlds")
_EXTRA_TLDS = lists.words("tlds", "sweep_extra_tlds")


def label_variants(label: str) -> set[str]:
    """Typo, homoglyph and combosquat variants of one domain label (without suffix)."""
    out: set[str] = set()
    n = len(label)
    for i in range(n):
        out.add(label[:i] + label[i + 1:])  # omission
        out.add(label[:i] + label[i] + label[i:])  # repetition
        if i < n - 1:
            out.add(label[:i] + label[i + 1] + label[i] + label[i + 2:])  # transposition
            out.add(label[:i + 1] + "-" + label[i + 1:])  # hyphenation
        for k in _KEYBOARD.get(label[i], ""):
            out.add(label[:i] + k + label[i + 1:])  # adjacent-key replacement
        for g in _GLYPHS.get(label[i], ""):
            out.add(label[:i] + g + label[i + 1:])  # homoglyph
    if "rn" not in label:
        out.update(label.replace(c, g) for c, g in (("m", "rn"), ("w", "vv")) if c in label)
    for a in _AFFIXES:
        out.update({f"{label}-{a}", f"{a}-{label}", f"{label}{a}", f"{a}{label}"})
    return {v for v in out if v and v != label and len(v) >= 2 and not v.startswith("-") and not v.endswith("-")}


def builtin_lookalikes(domain: str) -> list[str]:
    _sub, label, suffix = split_host(domain)
    if not label:
        return []
    variants = sorted(label_variants(label))
    affixed = [v for v in variants if any(a in v and a not in label for a in _AFFIXES)]
    typos = [v for v in variants if v not in affixed]
    out = [f"{label}.{t}" for t in _CORE_TLDS + _EXTRA_TLDS if t != suffix]
    out += [f"{v}.{t}" for v in typos for t in dict.fromkeys((suffix,) + _CORE_TLDS[:8]) if t]
    out += [f"{v}.{t}" for v in affixed for t in ("com", "net", "online", "site", "xyz", "top", "icu")]
    return list(dict.fromkeys(out))


def lookalikes(domain: str) -> list[str]:
    try:
        from scamshield.intel import generate_lookalikes

        names = [x if isinstance(x, str) else (x.get("domain") if isinstance(x, dict) else x[0])
                 for x in generate_lookalikes(domain)]
        names = [n.lower() for n in names if n]
        if names:
            return list(dict.fromkeys(names + builtin_lookalikes(domain)))
    except Exception:  # intel absent or failing: fall back to our generator
        pass
    return builtin_lookalikes(domain)


class Resolver:
    def __init__(self, nameservers: list[str], concurrency: int) -> None:
        self.r = dns.asyncresolver.Resolver(configure=False)
        self.r.nameservers = nameservers
        self.r.timeout, self.r.lifetime = 2.0, 4.0
        self.sem = asyncio.Semaphore(concurrency)

    async def a(self, name: str) -> list[str] | None:
        """IPv4 addresses, [] if the name does not exist, None if the lookup failed (retry later)."""
        async with self.sem:
            try:
                ans = await self.r.resolve(name, "A")
                return sorted({rr.address for rr in ans})
            except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
                return []
            except (dns.exception.Timeout, dns.exception.DNSException):
                return None


class SweepSource:
    name = "sweep"

    def __init__(self, store: Store | None = None, brands: Iterable[Brand] | None = None) -> None:
        self.store = store or Store()
        self.brands = list(brands) if brands is not None else [b for b in load_brands() if b.country == "AE"]
        self.resolver = Resolver(settings.SWEEP_RESOLVERS, settings.SWEEP_CONCURRENCY)
        self.checked = 0
        self.resolved = 0
        self.errors: list[str] = []
        self._wildcard: dict[str, bool] = {}

    async def _wildcard_suffix(self, suffix: str) -> bool:
        """Some registries answer every name; look-alikes under them prove nothing."""
        if suffix not in self._wildcard:
            ips = await self.resolver.a(f"{secrets.token_hex(8)}.{suffix}")
            self._wildcard[suffix] = bool(ips)
        return self._wildcard[suffix]

    async def _sweep_brand(self, brand: Brand) -> list[Candidate]:
        found: list[Candidate] = []
        official_ips: set[str] = set()
        for d in brand.official_domains:
            official_ips.update(await self.resolver.a(d) or [])
            official_ips.update(await self.resolver.a("www." + d) or [])
        for domain in brand.official_domains:
            names = [n for n in lookalikes(domain) if not is_official(n)][: settings.SWEEP_MAX_PER_BRAND]
            recent = self.store.swept_recently(names, settings.SWEEP_RECHECK_S)
            todo = [n for n in names if n not in recent]
            for i in range(0, len(todo), 500):
                chunk = todo[i:i + 500]
                results = await asyncio.gather(*(self.resolver.a(n) for n in chunk))
                rows = []
                for name, ips in zip(chunk, results):
                    if ips is None:
                        continue
                    self.checked += 1
                    rows.append((name, brand.name, bool(ips), ips))
                    if not ips or any(ip in official_ips and not is_shared_ip(ip) for ip in ips):
                        continue
                    if await self._wildcard_suffix(split_host(name)[2]):
                        continue
                    self.resolved += 1
                    m = match_host(name)
                    parked = all(is_parking_ip(ip) for ip in ips)  # still queued: parked names get armed later
                    score = max(m.score if m else 0.5, 0.5) - (0.3 if parked else 0.0)
                    found.append(Candidate(
                        url=f"http://{name}/", source=self.name, brand_hint=brand.name, host=name,
                        technique=m.technique if m else "lookalike", score=round(score, 2),
                        evidence={"lookalike_of": domain, "ips": ips, "parked": parked,
                                  "matched_on": m.matched_on if m else []}))
                self.store.record_sweep(rows)
        return found

    async def candidates(self, *, once: bool = False) -> AsyncIterator[Candidate]:
        while True:
            started = time.monotonic()
            for brand in self.brands:
                try:
                    for c in await self._sweep_brand(brand):
                        yield c
                except Exception as e:  # one brand failing must not stop the sweep
                    self.errors.append(f"{brand.name}: {type(e).__name__}: {e}")
                    log.warning("sweep %s: %s", brand.name, e)
            log.info("sweep: %d names checked, %d resolving in %.0fs", self.checked, self.resolved,
                     time.monotonic() - started)
            if once:
                return
            await asyncio.sleep(max(60.0, settings.SWEEP_RECHECK_S / 4))
