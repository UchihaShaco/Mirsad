#!/usr/bin/env python3
"""Check the websites listed in the Mirsad portal's Places directory with Mirsad's website shield.

Reads a places JSON file in the portal's format (scripts/build-places-json.py at the repository root writes it; the
portal validates it with PlaceRecord in src/contract/schemas.ts), checks each distinct website host once, and writes
one record per listing that has a website. Listings whose name matches a brand in the website shield's registry are
also checked against that brand's official websites and phone numbers.

Usage:
  python scripts/check_places_websites.py --places <places.json> [--out <report.json>] [--csv <report.csv>]
      [--engine http://localhost:8000 | --in-process | --verdict-db <engine.db>] [--limit N] [--concurrency N]
      [--dry-run]

  --places       the portal's places JSON (a JSON array of PlaceRecord objects)
  --out          JSON report; default data/places_audit/places-websites-<UTC time>.json (git-ignored)
  --csv          also write a CSV with one row per listing
  --engine       a running engine's base URL (default http://localhost:8000); checks go to POST /v1/check with
                 source "batch", so they queue behind people's own checks
  --in-process   run the engine inside this process instead (needs the website shield's dependencies and data/)
  --verdict-db   build the report from verdicts an engine already stored (its SQLite file, opened read-only); no
                 checks are run. Each host is matched by its normalised URL first, then by host name.
  --limit        check only the first N distinct hosts (listings on the other hosts are not reported)
  --concurrency  checks in flight at once (default 4)
  --dry-run      print what would be checked and exit; no network, no engine, nothing written

Report format "mirsad-places-website-checks/1" (the portal imports it; change it only with a new version):

  {
    "format": "mirsad-places-website-checks/1",
    "generator": "mirsad-gateway/scripts/check_places_websites.py",
    "generated_at": "<UTC ISO time>",
    "source": {"places_file", "places_sha256", "mode": "engine" | "in-process" | "verdict-db",
               "engine": "<base URL>" | null, "verdict_db": "<file name>" | null, "limit": N | null},
    "engine_version": "<scoring-code version>",
    "counts": {"<category>": N, ...},            # every category, zeros included, over the records below
    "summary": {...},                             # listings, hosts checked, skipped links, decisions, helpline flags
    "categories": {"<category>": {"en", "ar"}},   # the plain-language finding for each category
    "records": [ <record>, ... ]
  }

  record: place_id, name, name_ar, place_category, lat, lng, website, host, decision (allow | warn | block | null),
          risk_score (0-100 | null), category, finding_en, finding_ar, reasons_en [..], reasons_ar [..],
          reasons [{code, en, ar}], summary_en, summary_ar, final_url, evidence_ref, verdict_id, checked_at,
          engine_version, portal_path, websites [per-website results, same fields], helpline (null | {...}), error

  category, first match wins for warn and block (engine reason codes in CATEGORIES below):
    harmful_redirect    leads to or serves gambling, adult or pill content (a taken-over or compromised domain)
    data_theft          data-theft or wallet-draining script
    feed_listed         listed on a public phishing feed
    brand_mismatch      imitates a registered brand
    unrelated_redirect  re-registered name redirecting to an unrelated site
    parked              domain expired or parked for sale
    other_warning       any other warn or block
    none                allowed (including a website that could not be fetched)
    not_checked         no verdict: the engine failed, or the verdict database has none for the host

The report holds business names and phone numbers from the directory. They are written only to --out and --csv; the
summary printed at the end holds counts only. Exit status: 0 done, 2 bad input or the engine is unreachable.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import datetime
import hashlib
import json
import sqlite3
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Optional
from urllib.parse import quote, urlsplit

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GATEWAY_ROOT / "src"))

from scamshield.api.batch import clean_url, invalid_url  # noqa: E402
from scamshield.engine.rules import parse_url  # noqa: E402
from scamshield.evidence.reference import case_reference  # noqa: E402
from scamshield.intel import lists  # noqa: E402
from scamshield.watch.listings import Listing, assess_listing, brands_in_text  # noqa: E402

FORMAT = "mirsad-places-website-checks/1"
GENERATOR = "mirsad-gateway/scripts/check_places_websites.py"
DEFAULT_ENGINE = "http://localhost:8000"
DEFAULT_OUT_DIR = GATEWAY_ROOT / "data" / "places_audit"
REQUEST_TIMEOUT_S = 90.0
TOP_REASONS = 3

# Links that are not the business's own website: social and video platforms, messaging, maps, government portals
# (services.listing_neutral_sites) and reference, news and review sites (services.search_ignore_sites).
SKIP_SITES = tuple(dict.fromkeys(lists.words("services", "listing_neutral_sites")
                                 + lists.words("services", "search_ignore_sites")))

# Finding categories, most serious first. A flagged verdict (warn or block) takes the first category whose reason
# codes it carries; codes are the engine's own (src/scamshield/engine/rules.py, REASONS).
CATEGORIES: list[tuple[str, frozenset[str]]] = [
    ("harmful_redirect", frozenset({"page.harmful_redirect", "rule.takeover_block", "page.gambling"})),
    ("data_theft", frozenset({"page.exfiltration", "page.wallet_drainer", "page.credential_capture",
                              "page.clipboard_hijack"})),
    ("feed_listed", frozenset({"rep.blocklisted"})),
    ("brand_mismatch", frozenset({"domain.lookalike", "rule.lookalike_floor", "rule.impersonation_block",
                                  "page.sensitive_form_off_brand", "page.brand_title_mismatch"})),
    ("unrelated_redirect", frozenset({"page.unrelated_redirect", "rule.unrelated_redirect_floor"})),
    ("parked", frozenset({"page.parked", "rule.parked_floor"})),
]
FINDINGS: dict[str, tuple[str, str]] = {
    "harmful_redirect": ("Leads to gambling, adult or pill content: the business's domain was taken over or compromised",
                         "يقود إلى محتوى قمار أو محتوى إباحي أو أدوية مشبوهة: نطاق النشاط التجاري مُستولى عليه أو مخترق"),
    "data_theft": ("Data-theft or wallet-draining script on the website", "سكربت لسرقة البيانات أو المحافظ الرقمية على الموقع"),
    "feed_listed": ("Listed on a public phishing feed", "مدرج في قائمة عامة لمواقع التصيّد الاحتيالي"),
    "brand_mismatch": ("Imitates a registered brand", "ينتحل صفة علامة تجارية مسجّلة"),
    "unrelated_redirect": ("Re-registered name redirecting to an unrelated site",
                           "اسم نطاق أُعيد تسجيله ويحوّل إلى موقع لا علاقة له بالنشاط"),
    "parked": ("Domain expired or parked for sale: not the business's website any more",
               "النطاق منتهي الصلاحية أو معروض للبيع: لم يعد موقع النشاط التجاري"),
    "other_warning": ("Other warning: model scores, a risky domain ending, a site builder or a young domain",
                      "تحذير آخر: تقييم النماذج أو امتداد نطاق عالي الخطورة أو منصة إنشاء مواقع أو نطاق حديث"),
    "none": ("No finding", "لا توجد ملاحظات"),
    "not_checked": ("Not checked", "لم يُفحص"),
}
DECISION_RANK = {"block": 3, "warn": 2, "allow": 1, None: 0}

CSV_COLUMNS = ["place_id", "name", "name_ar", "place_category", "website", "host", "decision", "risk_score",
               "category", "finding_en", "finding_ar", "reasons_en", "reasons_ar", "final_url", "evidence_ref",
               "checked_at", "engine_version", "portal_path", "helpline_brand", "helpline_flags", "error"]

Check = Callable[[str], Awaitable[dict]]


def utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def scoring_version() -> str:
    """The scoring-code version of this checkout; a live engine on the same source reports the same one."""
    from scamshield.engine.pipeline import SCORING_VERSION

    return SCORING_VERSION


# ---- Reading the directory ------------------------------------------------------------------------------------------

def load_places(path: Path) -> list[dict]:
    """The portal's places file: a JSON array of records with at least id, name and urls."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"places_file_not_array:{path}")
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict) or not entry.get("id") or not isinstance(entry.get("urls", []), list):
            raise ValueError(f"places_record_invalid:{path}#{index}")
    return raw


def host_of(url: str) -> Optional[str]:
    """The website's host without www., as the portal's hostOf() in src/places/store.ts computes it."""
    text = clean_url(url or "")
    if not text or (invalid_url(text) or "").startswith("not a web address"):  # mailto:, tel:, javascript:
        return None
    if invalid_url(text if "://" in text else "https://" + text):
        return None
    host = (urlsplit(text if "://" in text else "https://" + text).hostname or "").lower().strip(".")
    return host[4:] if host.startswith("www.") else host or None


def is_skipped(host: str) -> bool:
    return any(host == site or host.endswith("." + site) for site in SKIP_SITES)


@dataclass
class Plan:
    """Which hosts to check (first URL seen for each) and which listings use them."""

    hosts: dict[str, str] = field(default_factory=dict)  # host -> URL to check
    listing_hosts: dict[str, list[tuple[str, str]]] = field(default_factory=dict)  # place id -> [(url, host)]
    places: dict[str, dict] = field(default_factory=dict)
    no_website: int = 0
    only_skipped: int = 0
    skipped_links: int = 0
    invalid_links: int = 0


def plan_checks(places: list[dict], limit: Optional[int] = None) -> Plan:
    plan = Plan()
    for place in places:
        pid = str(place["id"])
        plan.places[pid] = place
        urls = [u for u in place.get("urls") or [] if isinstance(u, str) and u.strip()]
        if not urls:
            plan.no_website += 1
            continue
        mine: list[tuple[str, str]] = []
        skipped_here = 0
        for url in urls:
            host = host_of(url)
            if host is None:
                plan.invalid_links += 1
                continue
            if is_skipped(host):
                skipped_here += 1
                continue
            if host not in plan.hosts:
                if limit is not None and len(plan.hosts) >= limit:
                    continue
                plan.hosts[host] = clean_url(url) if "://" in url else "https://" + clean_url(url)
            if all(h != host for _, h in mine):
                mine.append((url, host))
        plan.skipped_links += skipped_here
        if mine:
            plan.listing_hosts[pid] = mine
        elif skipped_here:
            plan.only_skipped += 1
    return plan


# ---- Helpline check -------------------------------------------------------------------------------------------------

def helpline_check(place: dict) -> Optional[dict]:
    """When the listing's name matches a brand in the registry: its websites or phones that are not the brand's.

    Uses the watcher's own rules (scamshield.watch.listings.assess_listing): a non-official website always counts; a
    non-official number counts on a listing that presents itself as a helpline or that already has such a website.
    """
    names = " ".join(n for n in (place.get("name"), place.get("name_ar")) if n)
    brands = brands_in_text(names)
    if not brands:
        return None
    brand = brands[0]
    phones = " ".join(p for p in place.get("phones") or [] if isinstance(p, str))
    reasons: list[str] = []
    hosts: list[str] = []
    mismatched: list[str] = []
    for url in (place.get("urls") or [""]):
        flag = assess_listing(Listing(provider="places", id=str(place["id"]), name=names, phone=phones,
                                      website=url or ""), brand)
        if not flag:
            continue
        reasons += [r for r in flag["reasons"] if r not in reasons]
        if flag["website_host"] and "website_not_official" in flag["reasons"] and flag["website_host"] not in hosts:
            hosts.append(flag["website_host"])
        if "phone_not_official" in flag["reasons"]:
            official = set(flag["official_phones"])
            mismatched += [p["number"] for p in flag["phones"] if p["number"] not in official and p["number"] not in mismatched]
    if not reasons:
        return None
    return {"brand": brand.name, "brand_ar": brand.name_ar, "reasons": reasons,
            "official_domains": list(brand.official_domains), "official_phones": list(brand.phones),
            "website_hosts_not_official": hosts, "phones_not_official": mismatched}


# ---- Reading a verdict ----------------------------------------------------------------------------------------------

def categorise(verdict: dict) -> str:
    """The stable category from the verdict's decision and reason codes."""
    codes = {r.get("code") for r in verdict.get("reasons") or []}
    if verdict.get("decision") in ("warn", "block"):
        for key, wanted in CATEGORIES:
            if codes & wanted:
                return key
        return "other_warning"
    return "none"


def top_reasons(verdict: dict, n: int = TOP_REASONS) -> list[dict]:
    """The findings that moved the score most, then the deciding rules; informational lines are left out, and so are
    model scores on an allowed site (the decision already weighed them)."""
    allowed = verdict.get("decision") == "allow"
    reasons = [r for r in verdict.get("reasons") or [] if r.get("severity") != "info"
               and not (allowed and str(r.get("code", "")).startswith(("model.", "llm.")))]
    reasons.sort(key=lambda r: -(r.get("points") or 0))
    return [{"code": r.get("code"), "en": r.get("title_en", ""), "ar": r.get("title_ar", "")} for r in reasons[:n]]


def summarise_verdict(url: str, host: str, verdict: Optional[dict], error: Optional[str],
                      engine_version: Optional[str]) -> dict:
    """One website's result in the report's field names."""
    if verdict is None:
        en, ar = FINDINGS["not_checked"]
        return {"website": url, "host": host, "decision": None, "risk_score": None, "category": "not_checked",
                "finding_en": en, "finding_ar": ar, "reasons_en": [], "reasons_ar": [], "reasons": [],
                "summary_en": "", "summary_ar": "", "final_url": None, "evidence_ref": None, "verdict_id": None,
                "checked_at": None, "engine_version": None, "error": error}
    key = categorise(verdict)
    en, ar = FINDINGS[key]
    reasons = top_reasons(verdict)
    evidence_ref = verdict.get("evidence_ref")
    if not evidence_ref and verdict.get("decision") in ("warn", "block") and verdict.get("id"):
        evidence_ref = case_reference(verdict["id"])  # stored verdicts carry it implicitly (Verdict serializer)
    return {"website": url, "host": host, "decision": verdict.get("decision"), "risk_score": verdict.get("risk_score"),
            "category": key, "finding_en": en, "finding_ar": ar,
            "reasons_en": [r["en"] for r in reasons], "reasons_ar": [r["ar"] for r in reasons], "reasons": reasons,
            "summary_en": verdict.get("summary_en", ""), "summary_ar": verdict.get("summary_ar", ""),
            "final_url": verdict.get("final_url") or verdict.get("url"), "evidence_ref": evidence_ref,
            "verdict_id": verdict.get("id"), "checked_at": verdict.get("updated_at") or verdict.get("created_at"),
            "engine_version": engine_version, "error": error}


def build_record(place: dict, checks: list[dict], helpline: Optional[dict], plan_host: Optional[str]) -> dict:
    """One record per listing. Its headline fields come from the most serious of the listing's websites."""
    worst = max(checks, key=lambda c: (DECISION_RANK.get(c["decision"], 0), c["risk_score"] or 0)) if checks else None
    head = worst or summarise_verdict("", "", None, None, None) | {
        "website": None, "host": plan_host, "category": "none", "finding_en": FINDINGS["none"][0],
        "finding_ar": FINDINGS["none"][1]}
    record = {
        "place_id": str(place["id"]),
        "name": place.get("name"),
        "name_ar": place.get("name_ar"),
        "place_category": place.get("category"),
        "lat": place.get("lat"),
        "lng": place.get("lng"),
    }
    record.update({k: head[k] for k in ("website", "host", "decision", "risk_score", "category", "finding_en",
                                        "finding_ar", "reasons_en", "reasons_ar", "reasons", "summary_en",
                                        "summary_ar", "final_url", "evidence_ref", "verdict_id", "checked_at",
                                        "engine_version")})
    # The portal's Places map opened on this website (src/dashboard/js/state/route.js, placesHref).
    record["portal_path"] = f"#/places/search/{quote(head['host'], safe='')}" if head["host"] else None
    record["websites"] = checks
    record["helpline"] = helpline
    record["error"] = head["error"]
    return record


def csv_row(record: dict) -> dict:
    helpline = record["helpline"] or {}
    row = {k: ("" if record.get(k) is None else record.get(k)) for k in CSV_COLUMNS}
    row["reasons_en"] = " | ".join(record["reasons_en"])
    row["reasons_ar"] = " | ".join(record["reasons_ar"])
    row["helpline_brand"] = helpline.get("brand", "")
    row["helpline_flags"] = " ".join(helpline.get("reasons", []))
    return row


# ---- Engines --------------------------------------------------------------------------------------------------------

def http_engine(base_url: str, timeout_s: float = REQUEST_TIMEOUT_S) -> Check:
    """POST /v1/check with source "batch" on a running engine."""
    endpoint = base_url.rstrip("/") + "/v1/check"

    def post(url: str) -> dict:
        body = json.dumps({"url": url, "depth": "page", "source": "batch"}).encode("utf-8")
        request = urllib.request.Request(endpoint, data=body, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(f"engine answered {exc.code}: {detail}") from None

    async def check(url: str) -> dict:
        return await asyncio.to_thread(post, url)

    return check


def engine_reachable(base_url: str) -> Optional[str]:
    """None when GET /v1/health answers, else why not."""
    try:
        with urllib.request.urlopen(base_url.rstrip("/") + "/v1/health", timeout=10) as response:
            return None if response.status == 200 else f"health answered {response.status}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return f"{type(exc).__name__}: {exc}"


def normalised(url: str) -> str:
    """The engine's own normalised form of a URL (the key its store and cache use)."""
    return parse_url(clean_url(url) if "://" in url else "https://" + clean_url(url)).url


class VerdictDb:
    """Stored verdicts of an engine database, opened read-only and immutable (nothing is written next to it)."""

    def __init__(self, path: Path) -> None:
        if not path.is_file():
            raise ValueError(f"verdict_db_missing:{path}")
        uri = f"file:{quote(str(path.resolve()))}?mode=ro&immutable=1"
        self.by_url: dict[str, tuple[dict, Optional[str]]] = {}
        self.by_host: dict[str, tuple[dict, Optional[str]]] = {}
        with sqlite3.connect(uri, uri=True) as db:
            has_versions = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='verdict_versions'").fetchone() is not None
            query = ("SELECT v.json, s.version FROM verdicts v LEFT JOIN verdict_versions s ON s.id = v.id"
                     if has_versions else "SELECT v.json, NULL FROM verdicts v") + " ORDER BY v.updated_at"
            for raw, version in db.execute(query):  # oldest first, so the newest verdict for a key wins
                verdict = json.loads(raw)
                entry = (verdict, version)
                if verdict.get("url"):
                    self.by_url[normalised(verdict["url"])] = entry
                host = host_of(verdict.get("host") or verdict.get("url") or "")
                if host:
                    self.by_host[host] = entry

    def lookup(self, url: str, host: str) -> Optional[tuple[dict, Optional[str]]]:
        return self.by_url.get(normalised(url)) or self.by_host.get(host)


async def run_checks(plan: Plan, check: Check, concurrency: int, version: Optional[str],
                     progress: bool = False) -> dict[str, dict]:
    """host -> summarised check; one engine call per distinct host."""
    gate = asyncio.Semaphore(max(1, concurrency))
    results: dict[str, dict] = {}
    total = len(plan.hosts)

    async def one(host: str, url: str) -> None:
        async with gate:
            try:
                verdict, error = await check(url), None
            except Exception as exc:  # one bad host must not stop the audit
                verdict, error = None, f"{type(exc).__name__}: {exc}"[:300]
        results[host] = summarise_verdict(url, host, verdict, error, version)
        if progress:
            print(f"  [{len(results)}/{total}] {results[host]['decision'] or 'error':<5} {host}", file=sys.stderr)

    await asyncio.gather(*(one(h, u) for h, u in plan.hosts.items()))
    return results


def stored_results(plan: Plan, db: VerdictDb) -> dict[str, dict]:
    results = {}
    for host, url in plan.hosts.items():
        found = db.lookup(url, host)
        results[host] = (summarise_verdict(url, host, found[0], None, found[1]) if found else
                         summarise_verdict(url, host, None, "no stored verdict for this website", None))
    return results


def assemble(plan: Plan, results: dict[str, dict]) -> list[dict]:
    records = []
    for pid, place in plan.places.items():
        checks = [{**results[host], "website": url} for url, host in plan.listing_hosts.get(pid, []) if host in results]
        helpline = helpline_check(place)
        if checks or helpline:
            records.append(build_record(place, checks, helpline, None))
    return records


async def audit(places: list[dict], check: Check, *, limit: Optional[int] = None, concurrency: int = 4,
                progress: bool = False, version: Optional[str] = None) -> tuple[list[dict], Plan]:
    plan = plan_checks(places, limit)
    results = await run_checks(plan, check, concurrency, version, progress)
    return assemble(plan, results), plan


def audit_stored(places: list[dict], db: VerdictDb, *, limit: Optional[int] = None) -> tuple[list[dict], Plan]:
    plan = plan_checks(places, limit)
    return assemble(plan, stored_results(plan, db)), plan


def summarise(records: list[dict], plan: Plan) -> dict:
    by_decision: dict[str, int] = {}
    for r in records:
        by_decision[r["decision"] or "none"] = by_decision.get(r["decision"] or "none", 0) + 1
    return {
        "listings": len(plan.places),
        "listings_reported": len(records),
        "listings_without_website": plan.no_website,
        "listings_with_only_social_or_directory_links": plan.only_skipped,
        "links_skipped_social_or_directory": plan.skipped_links,
        "links_invalid": plan.invalid_links,
        "hosts_checked": len(plan.hosts),
        "by_decision": by_decision,
        "helpline_flags": sum(1 for r in records if r["helpline"]),
    }


def counts(records: list[dict]) -> dict[str, int]:
    out = {key: 0 for key in FINDINGS}
    for r in records:
        out[r["category"]] += 1
    return out


# ---- Output ---------------------------------------------------------------------------------------------------------

def write_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:  # BOM so Excel shows the Arabic columns
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for record in records:
            writer.writerow(csv_row(record))


def warn_if_tracked(path: Path) -> None:
    """The report holds business names and phones: say so when it is going somewhere git could pick it up."""
    resolved = path.resolve()
    repo = GATEWAY_ROOT.parent
    if resolved.is_relative_to(repo) and "data" not in resolved.relative_to(repo).parts:
        print(f"warning: {path} is inside the repository and outside a git-ignored data/ folder; "
              "the report holds business names and phone numbers, do not commit it", file=sys.stderr)


def print_summary(report: dict, out: Optional[Path], csv_path: Optional[Path]) -> None:
    summary = report["summary"]
    print(f"listings {summary['listings']}, without website {summary['listings_without_website']}, "
          f"only social or directory links {summary['listings_with_only_social_or_directory_links']}, "
          f"hosts checked {summary['hosts_checked']}, listings reported {summary['listings_reported']}")
    print("decisions: " + ", ".join(f"{k} {v}" for k, v in sorted(summary["by_decision"].items())))
    print("categories (listings):")
    for key, count in report["counts"].items():
        print(f"  {count:6d}  {key:<20} {FINDINGS[key][0]}")
    print(f"helpline flags (name matches a registered brand, website or phone not official): {summary['helpline_flags']}")
    if out:
        print(f"report: {out}" + (f"\ncsv: {csv_path}" if csv_path else ""))


def dry_run(places: list[dict], limit: Optional[int]) -> int:
    plan = plan_checks(places, limit)
    print(f"dry run: {len(plan.places)} listings, {len(plan.listing_hosts)} with a website to check, "
          f"{plan.no_website} without website, {plan.only_skipped} with only social or directory links")
    print(f"would check {len(plan.hosts)} distinct hosts (POST /v1/check, source batch):")
    for host, url in plan.hosts.items():
        users = sum(1 for pairs in plan.listing_hosts.values() if any(h == host for _, h in pairs))
        print(f"  {host:<40} {users:3d} listing(s)  {url}")
    print(f"skipped {plan.skipped_links} social or directory links, {plan.invalid_links} invalid links")
    flagged = sum(1 for p in places if helpline_check(p))
    print(f"helpline check (offline): {flagged} listing(s) name a registered brand with a non-official website or phone")
    print("dry run: no network, no engine, nothing written")
    return 0


def make_report(args: argparse.Namespace, records: list[dict], plan: Plan, places_sha256: str, mode: str,
                version: Optional[str]) -> dict:
    return {
        "format": FORMAT,
        "generator": GENERATOR,
        "generated_at": utcnow(),
        "source": {"places_file": args.places.name, "places_sha256": places_sha256, "mode": mode,
                   "engine": args.engine if mode == "engine" else None,
                   "verdict_db": args.verdict_db.name if args.verdict_db else None, "limit": args.limit},
        "engine_version": version,
        "counts": counts(records),
        "summary": summarise(records, plan),
        "categories": {key: {"en": en, "ar": ar} for key, (en, ar) in FINDINGS.items()},
        "records": records,
    }


async def _run(args: argparse.Namespace, places: list[dict]) -> tuple[list[dict], Plan, str, Optional[str]]:
    if args.verdict_db:
        records, plan = audit_stored(places, VerdictDb(args.verdict_db), limit=args.limit)
        versions = {r["engine_version"] for r in records if r["engine_version"]}
        return records, plan, "verdict-db", ",".join(sorted(versions)) or None
    version = scoring_version()
    if args.in_process:
        from scamshield.engine.pipeline import Engine

        engine = await Engine(background_slots=args.concurrency).start()
        await engine.warm_up()

        async def check(url: str) -> dict:
            verdict = await asyncio.wait_for(engine.investigate(url, "page", background=False, source="batch"),
                                             REQUEST_TIMEOUT_S)
            return verdict.model_dump(mode="json", exclude={"page": {"html"}})

        try:
            records, plan = await audit(places, check, limit=args.limit, concurrency=args.concurrency, progress=True,
                                        version=version)
        finally:
            await engine.close()
        return records, plan, "in-process", version
    records, plan = await audit(places, http_engine(args.engine), limit=args.limit, concurrency=args.concurrency,
                                progress=True, version=version)
    return records, plan, "engine", version


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mirsad website shield: check the websites of the portal's Places listings.")
    parser.add_argument("--places", required=True, type=Path, help="the portal's places JSON")
    parser.add_argument("--out", type=Path, default=None, help="JSON report (default under the git-ignored data/)")
    parser.add_argument("--csv", type=Path, default=None, help="also write a CSV, one row per listing")
    where = parser.add_mutually_exclusive_group()
    where.add_argument("--engine", default=DEFAULT_ENGINE, help=f"running engine (default {DEFAULT_ENGINE})")
    where.add_argument("--in-process", action="store_true", help="run the engine inside this process")
    where.add_argument("--verdict-db", type=Path, default=None, help="build the report from an engine's stored verdicts")
    parser.add_argument("--limit", type=int, default=None, help="check only the first N distinct hosts")
    parser.add_argument("--concurrency", type=int, default=4, help="checks in flight at once (default 4)")
    parser.add_argument("--dry-run", action="store_true", help="print what would be checked; no network")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.concurrency < 1:
        parser.error("--concurrency must be at least 1")
    if args.out is None:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        args.out = DEFAULT_OUT_DIR / f"places-websites-{stamp}.json"
    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    try:
        data = args.places.read_bytes()
        places = load_places(args.places)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.dry_run:
        return dry_run(places, args.limit)
    if not args.verdict_db and not args.in_process:
        why = engine_reachable(args.engine)
        if why:
            print(f"error: engine not reachable at {args.engine} ({why}); start it or use --in-process", file=sys.stderr)
            return 2
    try:
        records, plan, mode, version = asyncio.run(_run(args, places))
    except (ValueError, sqlite3.Error) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    report = make_report(args, records, plan, hashlib.sha256(data).hexdigest(), mode, version)
    warn_if_tracked(args.out)
    write_report(args.out, report)
    if args.csv:
        warn_if_tracked(args.csv)
        write_csv(args.csv, records)
    print_summary(report, args.out, args.csv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
