"""Evidence sources for the review agent.

Every source is a thin adapter: it prefers the team's own component (engine fetch, intel lookups,
watch search) and degrades to a small keyless implementation, or to "unavailable", when that
component is missing or fails. Nothing here raises for a network problem; callers get `None`
or an empty list together with an error string.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import ipaddress
import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote, urlsplit

import httpx
import tldextract

from scamshield import config
from scamshield.schemas import BrandMatch, DomainIntel, FormInfo, PageSnapshot

USER_AGENT = "ScamShield-Review/0.1 (automated website safety review)"
BROWSER_PROFILES = {
    "mobile": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/131.0.0.0 Mobile Safari/537.36",
    "desktop": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
               "Chrome/131.0.0.0 Safari/537.36",
    "crawler": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
}
LOOKUP_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_REVIEW_LOOKUP_TIMEOUT", "5"))
# Optional history sources (crt.sh, the Internet Archive) are slow on a bad day; they get a shorter leash.
HISTORY_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_REVIEW_HISTORY_TIMEOUT", "5"))
LIGHT_FETCH_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_REVIEW_PAGE_TIMEOUT", "6"))
MAX_PAGE_BYTES = int(os.environ.get("SCAMSHIELD_REVIEW_PAGE_BYTES", str(2_000_000)))

_extract = tldextract.TLDExtract(suffix_list_urls=())


def registered_domain(host_or_url: str) -> str:
    host = urlsplit(host_or_url).hostname if "://" in host_or_url else host_or_url
    host = (host or "").lower().strip(".")
    parts = _extract(host)
    return parts.top_domain_under_public_suffix or host


def host_of(url: str) -> str:
    return (urlsplit(url if "://" in url else f"https://{url}").hostname or "").lower()


def _optional(module: str, name: str) -> Optional[Callable[..., Any]]:
    try:
        return getattr(importlib.import_module(module), name)
    except Exception:  # a component that is missing or broken must not stop the review
        return None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _client(timeout: float = LOOKUP_TIMEOUT_S, ua: str = USER_AGENT) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, headers={"User-Agent": ua}, follow_redirects=True)


# --- page fetching ----------------------------------------------------------------------------------


async def fetch_page(url: str, profile: str = "mobile") -> PageSnapshot:
    """Fetch one page under a browser identity with the engine's fetcher.

    If the engine fetcher fails, the failure is the result: no second, weaker fetch path. The local
    fetcher is only used when the engine module is not installed at all.
    """
    engine_fetch = _optional("scamshield.engine.fetch", "fetch_page")
    if engine_fetch is None:
        return await _local_fetch(url, profile)
    try:
        return await engine_fetch(url, profile=profile)
    except Exception as exc:
        return PageSnapshot(url=url, final_url=url, error=f"engine fetch failed: {exc.__class__.__name__}")


async def _public_target(url: str) -> Optional[str]:
    """Why `url` may not be fetched (not http(s), or resolving to a non-public address), else None."""
    check = _optional("scamshield.engine.fetch", "check_target")
    if check is not None:
        error, _address = await check(url)
        return error
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "refused: unsupported URL"
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parts.hostname, None)
    except (OSError, UnicodeError) as exc:
        return f"dns: cannot resolve {parts.hostname} ({exc.__class__.__name__})"
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addresses):
        return f"refused: {parts.hostname} resolves to a non-public address"
    return None


async def _capped_get(client: httpx.AsyncClient, url: str) -> tuple[httpx.Response, bytes]:
    async with client.stream("GET", url) as response:
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body += chunk
            if len(body) >= MAX_PAGE_BYTES:
                break
    return response, bytes(body[:MAX_PAGE_BYTES])


async def _local_fetch(url: str, profile: str) -> PageSnapshot:
    """A plain GET under a browser identity: every hop checked, redirects followed by hand, size capped."""
    started = datetime.now(timezone.utc)
    headers = {"User-Agent": BROWSER_PROFILES.get(profile, BROWSER_PROFILES["mobile"]), "Accept-Language": "en,ar;q=0.8"}
    current = url
    try:
        async with httpx.AsyncClient(timeout=LIGHT_FETCH_TIMEOUT_S, follow_redirects=False, headers=headers) as client:
            for _ in range(config.MAX_REDIRECTS):
                if error := await _public_target(current):
                    return PageSnapshot(url=url, final_url=current, error=error)
                response, body = await _capped_get(client, current)
                location = response.headers.get("location")
                if response.is_redirect and location:
                    current = str(response.url.join(location))
                    continue
                break
            else:
                return PageSnapshot(url=url, final_url=current, error="too many redirects")
    except httpx.HTTPError as exc:
        return PageSnapshot(url=url, final_url=current, error=f"{exc.__class__.__name__}"[:300])
    is_html = "html" in response.headers.get("content-type", "html")
    html = body.decode(response.encoding or "utf-8", errors="replace") if is_html else ""
    snapshot = PageSnapshot(url=url, final_url=str(response.url), status=response.status_code, html=html,
                            headers={k.lower(): v for k, v in response.headers.items()},
                            elapsed_ms=(datetime.now(timezone.utc) - started).total_seconds() * 1000)
    parse_html = _optional("scamshield.engine.extract", "parse_html")
    if parse_html is not None and html:
        try:
            parsed = parse_html(html, snapshot.final_url)
            snapshot.title, snapshot.text, snapshot.lang = parsed.title, parsed.text, parsed.lang
            snapshot.links, snapshot.forms = parsed.links, parsed.forms
            snapshot.external_hosts = parsed.external_hosts
            return snapshot
        except Exception:
            pass
    _minimal_parse(snapshot)
    return snapshot


async def fetch_light(url: str) -> PageSnapshot:
    """A quick GET of a further page of the site (text, title, links, forms; no script analysis)."""
    return await _local_fetch(url, "mobile")


def _minimal_parse(snapshot: PageSnapshot) -> None:
    from selectolax.lexbor import LexborHTMLParser

    tree = LexborHTMLParser(snapshot.html or "<html></html>")
    title = tree.css_first("title")
    snapshot.title = title.text(strip=True) if title else ""
    for node in tree.css("script, style, noscript"):
        node.decompose()
    body = tree.body
    snapshot.text = re.sub(r"\s+", " ", body.text(separator=" ") if body else "").strip()
    snapshot.links = [a.attributes.get("href") or "" for a in tree.css("a[href]")][:500]
    page_host = host_of(snapshot.final_url)
    for form in tree.css("form"):
        action = form.attributes.get("action") or ""
        action_host = host_of(action) if action.startswith("http") else page_host
        types = [(i.attributes.get("type") or "text").lower() for i in form.css("input")]
        snapshot.forms.append(FormInfo(action=action, method=(form.attributes.get("method") or "get").lower(),
                                       action_host=action_host, input_types=types,
                                       external_action=registered_domain(action_host) != registered_domain(page_host),
                                       asks_password="password" in types))


async def cloaking_probe(url: str) -> dict[str, Any]:
    """Compare what a person's browser and a crawler are served. Engine probe when available."""
    engine_probe = _optional("scamshield.engine.fetch", "cloaking_probe")
    if engine_probe is not None:
        try:
            result = await _maybe_await(engine_probe(url))
            data = result.model_dump() if hasattr(result, "model_dump") else result
            if isinstance(data, dict):
                return {"source": "engine", **data}
            return {"source": "engine", "result": data}
        except Exception as exc:
            local = await _local_cloaking(url)
            local["engine_error"] = exc.__class__.__name__
            return local
    return await _local_cloaking(url)


async def _local_cloaking(url: str) -> dict[str, Any]:
    person, crawler = await asyncio.gather(_local_fetch(url, "mobile"), _local_fetch(url, "crawler"))
    from rapidfuzz import fuzz

    similarity = fuzz.token_set_ratio(person.text[:5000], crawler.text[:5000]) / 100 if person.text or crawler.text else 1.0
    final_differs = registered_domain(person.final_url) != registered_domain(crawler.final_url)
    forms_differ = bool(person.forms) != bool(crawler.forms)
    return {
        "source": "local",
        "browser": {"status": person.status, "final_url": person.final_url, "title": person.title,
                    "forms": len(person.forms), "error": person.error},
        "crawler": {"status": crawler.status, "final_url": crawler.final_url, "title": crawler.title,
                    "forms": len(crawler.forms), "error": crawler.error},
        "text_similarity": round(similarity, 2),
        "cloaking": bool(not person.error and not crawler.error
                         and (final_differs or forms_differ or similarity < 0.5)),
    }


# --- domain intelligence ----------------------------------------------------------------------------


async def assess_domain(url: str) -> Optional[DomainIntel]:
    fn = _optional("scamshield.intel.domain", "assess_domain")
    if fn is None:
        return None
    try:
        return await fn(url)
    except Exception:
        return None


@dataclass
class Registration:
    domain: str
    created: Optional[datetime] = None
    registrar: Optional[str] = None
    statuses: list[str] = field(default_factory=list)
    source: str = ""
    raw_excerpt: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    @property
    def age_days(self) -> Optional[int]:
        if self.created is None:
            return None
        return (datetime.now(timezone.utc) - self.created).days


def _parse_time(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def raw_registration(domain: str) -> Registration:
    """Registration record: the intel component's raw lookup when present, else public RDAP."""
    fn = _optional("scamshield.intel.domain", "raw_registration")
    if fn is not None:
        try:
            raw = await _maybe_await(fn(domain))
            reg = raw.get("registration") if isinstance(raw, dict) else None
            if isinstance(reg, dict) and reg.get("found") and reg.get("created"):
                return Registration(domain=domain, created=_parse_time(reg.get("created")),
                                    registrar=reg.get("registrar"), statuses=list(reg.get("status") or []),
                                    source=f"intel {reg.get('source', '')}".strip(),
                                    raw_excerpt={k: reg.get(k) for k in ("created", "expires", "updated", "server")})
        except Exception:
            pass
    try:
        async with _client() as client:
            response = await client.get(f"https://rdap.org/domain/{quote(domain)}")
        if response.status_code != 200:
            return Registration(domain=domain, source="rdap", error=f"RDAP HTTP {response.status_code}")
        return _from_rdap(domain, response.json(), "rdap")
    except (httpx.HTTPError, ValueError) as exc:
        return Registration(domain=domain, source="rdap", error=exc.__class__.__name__)


def _from_rdap(domain: str, raw: dict[str, Any], source: str) -> Registration:
    events = {e.get("eventAction"): e.get("eventDate") for e in raw.get("events", []) if isinstance(e, dict)}
    registrar = None
    for entity in raw.get("entities", []) or []:
        if "registrar" in (entity.get("roles") or []):
            vcard = (entity.get("vcardArray") or [None, []])[1]
            registrar = next((v[3] for v in vcard if isinstance(v, list) and v and v[0] == "fn"), None)
    created = _parse_time(events.get("registration") or raw.get("created") or raw.get("creation_date"))
    return Registration(domain=domain, created=created, registrar=registrar or raw.get("registrar"),
                        statuses=list(raw.get("status", []) or []), source=source,
                        raw_excerpt={"events": events, "status": raw.get("status", [])})


async def certificate_history(host: str) -> dict[str, Any]:
    """Earliest certificate logged for the hostname in certificate transparency (crt.sh)."""
    if cached := _cached_first_seen("ct", host):
        return _first_seen_result(cached)
    try:
        async with _client(timeout=HISTORY_TIMEOUT_S) as client:
            response = await client.get("https://crt.sh/", params={"q": host, "output": "json"})
        if response.status_code != 200:
            return {"error": f"crt.sh HTTP {response.status_code}"}
        rows = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        return {"error": f"crt.sh {exc.__class__.__name__}"}
    dates = [d for d in (_parse_time(r.get("not_before")) for r in rows if isinstance(r, dict)) if d]
    if not dates:
        return {"certificates": 0}
    first = min(dates)
    _store_first_seen("ct", host, first.date().isoformat())
    return {"certificates": len(rows), "first_seen": first.date().isoformat(),
            "first_seen_days": (datetime.now(timezone.utc) - first).days,
            "issuers": sorted({str(r.get("issuer_name", ""))[:80] for r in rows[:50]})[:5]}


_HISTORY_CACHE = Path(os.environ.get("SCAMSHIELD_REVIEW_CACHE", config.DATA_DIR / "review_history.sqlite"))
_archive_gate: dict[int, asyncio.Semaphore] = {}


def _cached_first_seen(kind: str, key: str) -> Optional[str]:
    """A first-seen date found earlier. History only grows backwards, so a found date never goes stale."""
    try:
        with sqlite3.connect(_HISTORY_CACHE) as con:
            row = con.execute("SELECT first_seen FROM first_seen WHERE kind = ? AND key = ?", (kind, key)).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None


def _store_first_seen(kind: str, key: str, first_seen: str) -> None:
    try:
        _HISTORY_CACHE.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(_HISTORY_CACHE) as con:
            con.execute("CREATE TABLE IF NOT EXISTS first_seen (kind TEXT, key TEXT, first_seen TEXT, "
                        "PRIMARY KEY (kind, key))")
            con.execute("INSERT OR REPLACE INTO first_seen VALUES (?, ?, ?)", (kind, key, first_seen))
    except (sqlite3.Error, OSError):
        pass


def _first_seen_result(first_seen: str) -> dict[str, Any]:
    first = datetime.strptime(first_seen, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return {"captures": 1, "first_seen": first_seen, "first_seen_days": (datetime.now(timezone.utc) - first).days}


async def archive_history(host: str) -> dict[str, Any]:
    """First capture of the host's home page in the Internet Archive (Wayback CDX API). Keyless.

    The archive refuses bursts, so lookups go one at a time, a refused one is retried once, and a
    date once found is kept in a local cache.
    """
    if cached := _cached_first_seen("archive", host):
        return _first_seen_result(cached)
    gate = _archive_gate.setdefault(id(asyncio.get_running_loop()), asyncio.Semaphore(1))
    params = {"url": host, "limit": 1, "output": "json", "fl": "timestamp", "filter": "statuscode:200"}
    error = ""
    async with gate:
        for attempt in range(2):
            try:
                async with _client(timeout=HISTORY_TIMEOUT_S) as client:
                    response = await client.get("https://web.archive.org/cdx/search/cdx", params=params)
                if response.status_code == 200:
                    rows = response.json() if response.text.strip() else []
                    break
                error = f"archive HTTP {response.status_code}"
            except (httpx.HTTPError, ValueError) as exc:
                error = f"archive {exc.__class__.__name__}"
            await asyncio.sleep(1.0 + attempt)
        else:
            return {"error": error}
    if len(rows) < 2:
        return {"captures": 0}
    try:
        first_seen = datetime.strptime(str(rows[1][0])[:8], "%Y%m%d").date().isoformat()
    except (ValueError, IndexError):
        return {"error": "archive: unreadable timestamp"}
    _store_first_seen("archive", host, first_seen)
    return _first_seen_result(first_seen)


def popularity_rank(domain: str) -> Optional[int]:
    """Rank in the public top-sites list (offline Tranco table of the intel component), None if unranked."""
    fn = _optional("scamshield.intel.reputation", "popularity_rank")
    if fn is None:
        return None
    try:
        return fn(domain)
    except Exception:
        return None


def known_form_hosts() -> frozenset[str]:
    """Form, payment and booking services that ordinary businesses post their own forms to."""
    lists = _optional("scamshield.intel.lists", "wordset")
    if lists is None:
        return frozenset()
    try:
        return lists("services", "business_form_hosts") | lists("services", "common_form_hosts")
    except (KeyError, OSError, ValueError):
        return frozenset()


def is_shared_platform(host: str) -> bool:
    """Free hosting / site builder where anyone can publish under the platform's domain."""
    fn = _optional("scamshield.intel.reputation", "shared_platform")
    if fn is None:
        return False
    try:
        return bool(fn(host))
    except Exception:
        return False


# --- brand registry and reputation ------------------------------------------------------------------


@dataclass
class BrandRecord:
    name: str
    name_ar: str = ""
    category: str = ""
    official_domains: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    terms: list[str] = field(default_factory=list)  # names and distinctive tokens the brand goes by


def _intel_brands() -> list[Any]:
    out: list[Any] = []
    for name in ("brands", "global_brands"):
        fn = _optional("scamshield.intel.brands", name)
        if fn is None:
            continue
        try:
            out += list(fn())
        except Exception:
            continue
    return out


def _from_intel(brand: Any) -> BrandRecord:
    return BrandRecord(name=brand.name_en, name_ar=brand.name_ar, category=brand.category,
                       official_domains=list(brand.domains), phones=sorted(brand.phones),
                       terms=list(dict.fromkeys([brand.name_en, *brand.tokens])))


def registry_brand(name: str) -> Optional[BrandRecord]:
    """A curated (UAE) registry brand whose name is exactly `name`, in English or Arabic."""
    fn = _optional("scamshield.intel.brands", "brands")
    key = name.strip().lower()
    try:
        curated = list(fn()) if fn is not None else []
    except Exception:
        curated = []
    brand = next((b for b in curated if key in (b.name_en.lower(), b.name_ar)), None)
    return _from_intel(brand) if brand is not None else None


def brand_record(name: str) -> Optional[BrandRecord]:
    """Official domains, phone numbers and names of a brand, from the team's brand registry."""
    key = name.strip().lower()
    for brand in _intel_brands():
        if key in (brand.name_en.lower(), brand.id.lower()):
            return _from_intel(brand)
    for module in ("scamshield.watch.brands",):
        fn = _optional(module, "brand_by_name")
        if fn is None:
            continue
        try:
            brand = fn(name)
        except Exception:
            continue
        if brand is not None:
            return BrandRecord(name=brand.name, name_ar=getattr(brand, "name_ar", ""),
                               category=getattr(brand, "category", ""),
                               official_domains=list(getattr(brand, "official_domains", ())),
                               phones=list(getattr(brand, "phones", ())),
                               terms=[brand.name, *getattr(brand, "keywords", ())])
    return None


def brand_owning(host: str) -> Optional[BrandRecord]:
    """The registry brand that owns this host as one of its official domains, if any."""
    owned = _optional("scamshield.intel.brands", "owning_brand_domain")
    if owned is not None:
        try:
            domain = owned(host)
        except Exception:
            domain = None
        if domain:
            brand = next((b for b in _intel_brands() if domain in b.domains), None)
            if brand is not None:
                return _from_intel(brand)
    for module in ("scamshield.watch.brands",):
        fn = _optional(module, "is_official")
        if fn is None:
            continue
        try:
            brand = fn(host)
        except Exception:
            continue
        if brand is not None:
            return brand_record(brand.name) or BrandRecord(name=brand.name,
                                                           official_domains=list(brand.official_domains))
    return None


def match_brand(url: str, page: Optional[PageSnapshot] = None) -> Optional[BrandMatch]:
    fn = _optional("scamshield.intel.brands", "match_brand")
    if fn is None:
        return None
    try:
        return fn(url, page)
    except Exception:
        return None


def reputation(host: str) -> Optional[tuple[bool, Optional[str], bool, list[str]]]:
    fn = _optional("scamshield.intel.reputation", "reputation")
    if fn is None:
        return None
    try:
        return fn(host)
    except Exception:
        return None


# --- independent sources: who runs this domain? ----------------------------------------------------


async def domain_owner(domain: str) -> dict[str, Any]:
    """Organisations whose Wikidata "official website" (P856) is this domain. Keyless."""
    try:
        async with _client() as client:
            usage = await client.get("https://www.wikidata.org/w/api.php", params={
                "action": "query", "list": "exturlusage", "euquery": domain, "eunamespace": 0,
                "eulimit": 50, "format": "json"})
            ids = list(dict.fromkeys(row["title"] for row in usage.json().get("query", {}).get("exturlusage", [])
                                     if re.fullmatch(r"Q\d+", row.get("title", ""))))[:25]
            if not ids:
                return {"source": "wikidata", "organisations": []}
            entities = await client.get("https://www.wikidata.org/w/api.php", params={
                "action": "wbgetentities", "ids": "|".join(ids), "props": "labels|descriptions|claims|sitelinks",
                "languages": "en|ar", "format": "json"})
            data = entities.json().get("entities", {})
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        return {"source": "wikidata", "error": exc.__class__.__name__, "organisations": []}
    organisations = []
    for qid, entity in data.items():
        sites = [c.get("mainsnak", {}).get("datavalue", {}).get("value", "")
                 for c in entity.get("claims", {}).get("P856", [])]
        if any(registered_domain(s) == domain for s in sites if isinstance(s, str) and s):
            organisations.append({"id": qid, "name": _label(entity, "en"), "name_ar": _label(entity, "ar"),
                                  "sitelinks": len(entity.get("sitelinks") or {}),
                                  "description": entity.get("descriptions", {}).get("en", {}).get("value", ""),
                                  "official_websites": [s for s in sites if isinstance(s, str)][:5]})
    return {"source": "wikidata", "organisations": organisations[:10]}


def _label(entity: dict[str, Any], lang: str) -> str:
    return entity.get("labels", {}).get(lang, {}).get("value", "")


async def official_website(organisation: str) -> dict[str, Any]:
    """The organisation's real website according to Wikidata and DuckDuckGo's knowledge panel. Keyless."""
    found: dict[str, list[str]] = {}
    errors: list[str] = []
    async with _client() as client:
        try:
            search = await client.get("https://www.wikidata.org/w/api.php", params={
                "action": "wbsearchentities", "search": organisation, "language": "en", "type": "item",
                "limit": 3, "format": "json"})
            ids = [row["id"] for row in search.json().get("search", [])]
            if ids:
                entities = await client.get("https://www.wikidata.org/w/api.php", params={
                    "action": "wbgetentities", "ids": "|".join(ids), "props": "labels|claims",
                    "languages": "en", "format": "json"})
                for qid, entity in entities.json().get("entities", {}).items():
                    sites = [c.get("mainsnak", {}).get("datavalue", {}).get("value", "")
                             for c in entity.get("claims", {}).get("P856", [])]
                    sites = [s for s in sites if isinstance(s, str) and s]
                    if sites:
                        found[f"wikidata:{qid} {_label(entity, 'en')}"] = sites[:5]
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            errors.append(f"wikidata {exc.__class__.__name__}")
        try:
            panel = await client.get("https://api.duckduckgo.com/", params={
                "q": organisation, "format": "json", "no_html": 1, "skip_disambig": 1})
            body = panel.json()
            sites = [r.get("FirstURL", "") for r in body.get("Results", []) if "official" in r.get("Text", "").lower()]
            sites += [c.get("value", "") for c in (body.get("Infobox") or {}).get("content", [])
                      if c.get("data_type") == "official_website"]
            sites = list(dict.fromkeys(s for s in sites if isinstance(s, str) and s))
            if sites:
                found[f"duckduckgo:{body.get('Heading', organisation)}"] = sites[:5]
        except (httpx.HTTPError, ValueError) as exc:
            errors.append(f"duckduckgo {exc.__class__.__name__}")
    return {"query": organisation, "official_sites": found,
            "official_domains": sorted({registered_domain(s) for sites in found.values() for s in sites}),
            "errors": errors}


# --- web search -------------------------------------------------------------------------------------


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""
    source: str = ""


class SearchProvider:
    name = "none"
    finds_reports = True  # a full web index can surface scam reports about a small site

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        raise NotImplementedError


class WatchSearch(SearchProvider):
    """The watch component's search function, when the team has one."""

    name = "watch"

    def __init__(self, fn: Callable[..., Any]):
        self.fn = fn

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        rows = await _maybe_await(self.fn(query, limit))
        out = []
        for row in rows or []:
            get = row.get if isinstance(row, dict) else lambda k, d="", r=row: getattr(r, k, d)
            out.append(SearchResult(title=str(get("title", "")), url=str(get("url", "")),
                                    snippet=str(get("snippet", "") or get("description", "")), source=self.name))
        return out[:limit]


class BraveSearch(SearchProvider):
    name = "brave"

    def __init__(self, key: str):
        self.key = key

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        async with _client() as client:
            response = await client.get("https://api.search.brave.com/res/v1/web/search",
                                        params={"q": query, "count": limit},
                                        headers={"X-Subscription-Token": self.key, "Accept": "application/json"})
        response.raise_for_status()
        return [SearchResult(r.get("title", ""), r.get("url", ""), re.sub(r"<[^>]+>", "", r.get("description", "")),
                             self.name) for r in response.json().get("web", {}).get("results", [])][:limit]


class TavilySearch(SearchProvider):
    name = "tavily"

    def __init__(self, key: str):
        self.key = key

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        async with _client() as client:
            response = await client.post("https://api.tavily.com/search",
                                         json={"query": query, "max_results": limit},
                                         headers={"Authorization": f"Bearer {self.key}"})
        response.raise_for_status()
        return [SearchResult(r.get("title", ""), r.get("url", ""), r.get("content", "")[:400], self.name)
                for r in response.json().get("results", [])][:limit]


class SerpApiSearch(SearchProvider):
    name = "serpapi"

    def __init__(self, key: str):
        self.key = key

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        async with _client() as client:
            response = await client.get("https://serpapi.com/search.json",
                                        params={"q": query, "num": limit, "api_key": self.key, "engine": "google"})
        response.raise_for_status()
        return [SearchResult(r.get("title", ""), r.get("link", ""), r.get("snippet", ""), self.name)
                for r in response.json().get("organic_results", [])][:limit]


class KeylessSearch(SearchProvider):
    finds_reports = False
    """Public no-key APIs: DuckDuckGo Instant Answers plus Wikipedia full-text search.

    It answers "what is this organisation and what is its site" and "does an encyclopedia article
    mention this domain" well; it cannot find scam reports on forums the way a full web index can.
    """

    name = "keyless (duckduckgo-instant-answer + wikipedia)"

    async def search(self, query: str, limit: int = 8) -> list[SearchResult]:
        out: list[SearchResult] = []
        async with _client() as client:
            ddg, wiki = await asyncio.gather(
                client.get("https://api.duckduckgo.com/", params={"q": query, "format": "json", "no_html": 1,
                                                                  "skip_disambig": 1}),
                client.get("https://en.wikipedia.org/w/api.php", params={
                    "action": "query", "list": "search", "srsearch": query, "srlimit": limit, "format": "json"}),
                return_exceptions=True)
        if isinstance(ddg, httpx.Response) and ddg.status_code == 200:
            body = ddg.json()
            if body.get("AbstractURL"):
                out.append(SearchResult(body.get("Heading", ""), body["AbstractURL"], body.get("AbstractText", ""),
                                        "duckduckgo"))
            for row in body.get("Results", []):
                out.append(SearchResult(f"{body.get('Heading', '')} - {row.get('Text', '')}", row.get("FirstURL", ""),
                                        "", "duckduckgo"))
            for row in body.get("RelatedTopics", [])[:3]:
                if isinstance(row, dict) and row.get("FirstURL"):
                    out.append(SearchResult(row.get("Text", "")[:120], row["FirstURL"], row.get("Text", ""), "duckduckgo"))
        if isinstance(wiki, httpx.Response) and wiki.status_code == 200:
            for row in wiki.json().get("query", {}).get("search", []):
                title = row.get("title", "")
                out.append(SearchResult(title, f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}",
                                        re.sub(r"<[^>]+>", "", row.get("snippet", "")), "wikipedia"))
        if not out and isinstance(ddg, Exception) and isinstance(wiki, Exception):
            raise ddg
        return out[:limit]


def search_provider() -> SearchProvider:
    """Pick a search provider: team watch search, then API-key providers, then keyless."""
    choice = os.environ.get("SCAMSHIELD_SEARCH_PROVIDER", "auto").lower()
    watch = _optional("scamshield.watch.search", "search")
    if choice in ("auto", "watch") and watch is not None:
        return WatchSearch(watch)
    keyed = {"brave": ("BRAVE_SEARCH_API_KEY", BraveSearch), "tavily": ("TAVILY_API_KEY", TavilySearch),
             "serpapi": ("SERPAPI_API_KEY", SerpApiSearch)}
    for name, (env, cls) in keyed.items():
        if choice in ("auto", name) and os.environ.get(env):
            return cls(os.environ[env])
    return KeylessSearch()
