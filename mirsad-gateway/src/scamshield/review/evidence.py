"""Turn a blocked verdict into specific claims to test, and handle page content as hostile data."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Iterable, Optional

from scamshield.schemas import PageSnapshot, Verdict

from .sources import registered_domain

UNTRUSTED_OPEN = "<untrusted_page_content"
UNTRUSTED_CLOSE = "</untrusted_page_content>"


@dataclass
class Claim:
    id: str
    kind: str  # young_domain | impersonation | credential_form | obfuscation | cloaking | redirect | blocklist | model | other
    text: str
    tests: list[str] = field(default_factory=list)  # tools that can re-validate it
    code: str = ""  # the engine reason code, for claims without a dedicated test
    status: str = "untested"  # upheld | refuted | untested
    finding: str = ""  # why, once tested


_FORM_CODES = ("page.external_form_action", "page.password_form", "page.card_form", "page.otp_form",
               "page.national_id_form", "page.exfiltration", "page.form_relay", "page.credential_capture",
               "page.sensitive_form_off_brand")
_HARMFUL_CODES = {"page.gambling", "page.harmful_redirect", "rule.takeover_block"}
_UNRELATED_CODES = {"page.unrelated_redirect", "rule.unrelated_redirect_floor"}
_IMPERSONATION_CODES = {"domain.lookalike", "url.brand_in_path", "url.brand_in_subdomain", "page.brand_hosting_mismatch",
                        "rule.impersonation_block"}


def _hosts_in(value: object) -> list[str]:
    """Hostnames named in a reason's evidence (`hosts`, `actions`, or `kind:host` signals)."""
    out: list[str] = []
    items = value if isinstance(value, list) else [value]
    for item in items:
        text = str(item)
        host = text.split("://", 1)[1].split("/", 1)[0] if "://" in text else text.rsplit(":", 1)[-1]
        if "." in host and " " not in host:
            out.append(host.lower())
    return out


def form_targets(verdict: Verdict) -> list[str]:
    """Other hosts that receive data typed into the page, from the forms and from the engine's evidence."""
    page = verdict.page
    site = registered_domain(verdict.host or verdict.url)
    hosts = [f.action_host for f in (page.forms if page else []) if f.external_action and f.action_host]
    for reason in verdict.reasons:
        if reason.code in _FORM_CODES:
            for key in ("hosts", "actions", "signals"):
                hosts += _hosts_in(reason.evidence.get(key, []))
    return sorted({h for h in hosts if h and registered_domain(h) != site})


def build_claims(verdict: Verdict) -> list[Claim]:
    """One claim per distinct flag in the verdict, phrased as something a check can confirm or refute."""
    claims: list[Claim] = []
    seen: set[str] = set()

    def add(kind: str, text: str, tests: list[str], code: str = "") -> None:
        if kind in seen and kind not in ("other", "model"):
            return
        seen.add(kind)
        claims.append(Claim(id=f"c{len(claims) + 1}", kind=kind, text=text, tests=tests, code=code))

    domain = verdict.domain
    codes = {r.code for r in verdict.reasons if r.points > 0 or r.code.startswith("rule.")}
    harmful = [r for r in verdict.reasons if r.code in _HARMFUL_CODES]
    if harmful:
        add("harmful_content", "the site now serves, or sends visitors to, gambling, adult or pill content ("
            + "; ".join(r.title_en for r in harmful if r.code != "rule.takeover_block")[:200] + ")", ["refetch_page"])
    unrelated = [r for r in verdict.reasons if r.code in _UNRELATED_CODES]
    if unrelated:
        add("unrelated_redirect", "a recently registered business name now forwards visitors to an unrelated site",
            ["refetch_page", "registration_record"])
    if domain and domain.age_days is not None and domain.age_days < 365:
        add("young_domain", f"the domain {domain.registered_domain} was registered {domain.age_days} days ago",
            ["registration_record", "certificate_history", "archive_history"])
    elif codes & {"domain.newly_registered", "domain.young"}:
        add("young_domain", "the domain was registered recently",
            ["registration_record", "certificate_history", "archive_history"])
    if verdict.brand:
        real = ", ".join(verdict.brand.official_domains[:4]) or "unknown"
        add("impersonation", f"the site impersonates {verdict.brand.brand} whose real domain is {real} "
                             f"(technique: {verdict.brand.technique or 'unspecified'})",
            ["brand_lookup", "official_website", "domain_owner", "refetch_page"])
        if "helpline" in (verdict.brand.technique or ""):
            add("helpline", f"the phone numbers on the page are a fake {verdict.brand.brand} helpline",
                ["refetch_page", "site_page"])
    elif codes & _IMPERSONATION_CODES:
        add("impersonation", "the address or page imitates a known brand", ["brand_lookup", "official_website"])
    page = verdict.page
    targets = form_targets(verdict)
    sensitive = [f for f in (page.forms if page else []) if f.asks_password or f.asks_card or f.asks_otp
                 or f.asks_national_id]
    if targets and (sensitive or codes & set(_FORM_CODES)):
        add("credential_form", f"sensitive data typed into the page is sent to another host ({', '.join(targets[:3])})",
            ["refetch_page"])
    elif sensitive or codes & set(_FORM_CODES):
        add("credential_form", "the page collects passwords, card, OTP or ID numbers", ["refetch_page", "site_page"])
    if (page and any(s.obfuscated for s in page.scripts)) or "page.obfuscated_scripts" in codes:
        add("obfuscation", "a script on the page is deliberately scrambled", ["refetch_page"])
    if any("cloak" in c for c in codes) or "deep.revoked" in codes:
        add("cloaking", "the site serves different content to crawlers and to people", ["cloaking_check"])
    hops = verdict.redirect_chain or (page.redirect_chain if page else [])
    hop_sites = {registered_domain(h.url) for h in hops}
    if len(hop_sites) > 1 or codes & {"page.cross_domain_redirect", "page.client_side_redirect", "page.shortener_in_chain"}:
        add("redirect", f"the address redirects across sites ({' -> '.join(sorted(hop_sites)) or 'see chain'})",
            ["refetch_page"])
    if domain and domain.blocklisted or "rep.blocklisted" in codes:
        sources = ", ".join(domain.blocklist_sources) if domain else ""
        add("blocklist", f"the host is on a blocklist {sources}".strip(), ["blocklist_lookup", "web_search"])
    for reason in verdict.reasons:
        if reason.code in ("model.url", "model.page") and reason.points > 0:
            add("model", f"{reason.title_en} ({reason.detail})".strip(" ()"), ["refetch_page", "site_page"])
    covered = {"domain.newly_registered", "domain.young", "page.obfuscated_scripts", "deep.revoked",
               "page.cross_domain_redirect", "page.client_side_redirect", "page.shortener_in_chain",
               "rep.blocklisted", "model.url", "model.page", *_FORM_CODES, *_IMPERSONATION_CODES, *_HARMFUL_CODES,
               *_UNRELATED_CODES}
    for reason in sorted(verdict.reasons, key=lambda r: -r.points):
        if reason.points > 0 and reason.code not in covered and "cloak" not in reason.code:
            add("other", reason.title_en, ["refetch_page", "site_page", "web_search"], code=reason.code)
    return claims[:16]


def harmful_findings(page: PageSnapshot, entry_url: str) -> list[str]:
    """What a re-fetched page does now: a redirect to a gambling / adult / pill site, or such content on the page.

    Uses the engine's own tests and word lists (intel/data/lexicon.json), so both layers judge alike.
    """
    try:
        from scamshield.engine import rules
    except ImportError:
        return []
    entry = rules.parse_url(entry_url)
    final = rules.parse_url(page.final_url or page.url)
    hops = [rules.parse_url(h.url) for h in page.redirect_chain] + [final]
    elsewhere = [h for h in hops if h.registered_domain != entry.registered_domain and not rules.same_organisation(entry, h)]
    out = []
    harmful = next((h for h in elsewhere if rules.harmful_destination(h)), None)
    if harmful is None and elsewhere and rules.harmful_title(page.title or ""):
        harmful = elsewhere[-1]
    if harmful is not None:
        out.append(f"it still sends visitors to a gambling, adult or pill site ({harmful.host})")
    text = rules.fold(f"{page.title} {page.text[:20_000]}")
    words = [w for w in rules.GAMBLING_WORDS if re.search(rf"(?<![a-z0-9]){re.escape(rules.fold(w))}(?![a-z0-9])", text)]
    if len(words) >= 2:
        out.append(f"it serves online-gambling content ({', '.join(words[:3])})")
    return out


def unrelated_destination(page: PageSnapshot, entry_url: str) -> Optional[str]:
    """The unrelated site a re-fetched address now lands on, if it does."""
    try:
        from scamshield.engine import rules
    except ImportError:
        return None
    entry, final = rules.parse_url(entry_url), rules.parse_url(page.final_url or page.url)
    if final.registered_domain and final.registered_domain != entry.registered_domain and rules.unrelated(entry, final):
        return final.host
    return None


# --- the site's own identity -------------------------------------------------------------------------

_TITLE_SPLIT = re.compile(r"\s+[|\-\u2013\u2014:\u00b7\u2022]\s+")
_META_NAME = re.compile(r"<meta[^>]+(?:property|name)=[\"'](?:og:site_name|application-name)[\"'][^>]*content=[\"']"
                        r"([^\"']{2,80})[\"']|<meta[^>]+content=[\"']([^\"']{2,80})[\"'][^>]*(?:property|name)="
                        r"[\"'](?:og:site_name|application-name)[\"']", re.IGNORECASE)
_GENERATOR = re.compile(r"<meta[^>]+name=[\"']generator[\"'][^>]*content=[\"']([^\"']{2,60})", re.IGNORECASE)
# UAE numbers: +971 / 00971 / 0 followed by an area or mobile code, and 600 / 800 service numbers.
_UAE_PHONE = re.compile(r"(?:\+|00)971[\s\-]?\(?0?\)?[2-9]\d?(?:[\s\-]?\d){7}|\b0(?:[2-47-9]|5\d)(?:[\s\-]?\d){7}\b"
                        r"|\b[68]00[\s\-]?\d{3,5}\b")


@lru_cache(maxsize=1)
def _service_words() -> frozenset[str]:
    """Words that describe a service or a lure ("pay", "traffic", "fine", "parcel") rather than name a business."""
    try:
        from scamshield.intel import lists
    except ImportError:
        return frozenset()
    words: set[str] = set()
    for key in ("url_lure_words", "brand_lure_words", "payment_lure_phrases", "penalty_phrases", "generic_prefixes",
                "generic_suffixes"):
        try:
            for phrase in lists.words("lexicon", key):
                words.update(_words(phrase))
        except (KeyError, OSError, ValueError):
            continue
    return frozenset(words)


def distinctive(name: str) -> bool:
    """A name with at least one word that is not a service or lure word: a business name, not a page purpose."""
    return any(len(w) >= 3 and w not in _service_words() for w in _words(name))


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def _compact(text: str) -> str:
    return "".join(_words(text))


def host_labels(host: str) -> list[str]:
    """The meaningful labels of a host: registered label plus subdomains, without www and the suffix."""
    domain = registered_domain(host)
    label = domain.split(".", 1)[0]
    subs = host[: -len(domain)].strip(".").split(".") if host.endswith(domain) and host != domain else []
    return [x for x in subs if x and x != "www"] + [label]


def site_names(page: Optional[PageSnapshot]) -> list[str]:
    """Names the site gives itself: og:site_name / application-name, then the title's segments."""
    if page is None:
        return []
    names: list[str] = []
    for match in _META_NAME.finditer((page.html or "")[:400_000]):
        names.append((match.group(1) or match.group(2) or "").strip())
    names += [seg.strip() for seg in _TITLE_SPLIT.split(page.title or "")[:3]]
    return [n for n in dict.fromkeys(names) if n and len(n) <= 80]


def identity_match(names: Iterable[str], host: str) -> Optional[str]:
    """The site name that its own hostname spells out, if any (\"Oasis Roastery\" on oasisroastery.example)."""
    labels = [_compact(label) for label in host_labels(host)]
    host_compact = "".join(labels)
    main = labels[-1]
    for name in names:
        words = [w for w in _words(name) if len(w) >= 2]
        joined = "".join(words)
        if len(joined) < 4 or not distinctive(name):
            continue
        if (joined in host_compact and len(joined) >= max(5, len(host_compact) / 2)) or (len(main) >= 5 and main in joined):
            return name
        if sum(len(w) >= 4 and w in host_compact for w in words) >= 2:
            return name
        overlap = SequenceMatcher(None, joined, main).find_longest_match(0, len(joined), 0, len(main)).size
        if overlap >= 8 or (overlap >= 6 and overlap >= 0.7 * min(len(joined), len(main))):
            return name
    return None


def brand_in_identity(brand_terms: Iterable[str], names: Iterable[str], host: str) -> Optional[str]:
    """The brand term found in the site's own name or hostname: the site presents itself as the brand."""
    tokens = set(host_labels(host)) | {t for label in host_labels(host) for t in label.split("-")}
    compact_names = [_compact(n) for n in names]
    name_tokens = {w for n in names for w in _words(n)}
    host_compact = "".join(_compact(label) for label in host_labels(host))
    for term in brand_terms:
        compact = _compact(term)
        if len(compact) >= 5 and (compact in host_compact or any(compact in n for n in compact_names)):
            return term
        if 3 <= len(compact) < 5 and (compact in tokens or compact in name_tokens):
            return term
    return None


def local_contacts(text: str) -> list[str]:
    """UAE-format phone numbers on a page."""
    return list(dict.fromkeys(re.sub(r"[\s\-()]", "", m.group(0)) for m in _UAE_PHONE.finditer(text or "")))[:5]


def site_platform(page: Optional[PageSnapshot]) -> Optional[str]:
    """The CMS or site builder the page declares (meta generator), if any."""
    if page is None:
        return None
    match = _GENERATOR.search((page.html or "")[:400_000])
    return match.group(1).strip() if match else None


# Text that only makes sense when addressed to an automated reviewer or a language model.
_INJECTION_PATTERNS = [
    r"ignore (?:all |any |the )?(?:previous|prior|above|your|earlier) (?:instructions|prompts?|rules)",
    r"disregard (?:all |any |the )?(?:previous|prior|above|your) (?:instructions|rules)",
    r"(?:mark|classify|flag|report|label|treat) (?:this|the) (?:site|page|website|domain|url) as (?:safe|legit|legitimate|benign|trusted|clean)",
    r"this (?:site|page|website) (?:is|has been) (?:verified|certified|confirmed) (?:as )?(?:safe|legitimate|secure)",
    r"(?:you are|you're) (?:an? )?(?:ai|language model|assistant|llm|reviewer|security (?:agent|scanner))",
    r"(?:system|developer) (?:prompt|message|instructions?)\s*[:\]]",
    r"(?:note|message|instructions?) (?:to|for) (?:the )?(?:ai|llm|model|reviewer|crawler|scanner|bot|agent)",
    r"(?:do not|don't|never) (?:block|flag|report) (?:this|the) (?:site|page|domain)",
    r"(?:return|output|respond with) [\"']?(?:safe|allow|benign|overturned)[\"']?",
    r"<\s*/?\s*(?:system|instructions?|untrusted_page_content)\b",
    r"تجاهل (?:جميع |كل )?التعليمات",
    r"هذا الموقع (?:آمن|موثوق) ",
]
_INJECTION_RE = re.compile("|".join(f"(?:{p})" for p in _INJECTION_PATTERNS), re.IGNORECASE)
_COMMENT_RE = re.compile(r"<!--(.*?)-->", re.DOTALL)
_META_RE = re.compile(r"<meta[^>]+content=[\"']([^\"']{20,})[\"']", re.IGNORECASE)


def find_injection(text: str = "", html: str = "") -> list[str]:
    """Phrases aimed at an automated reviewer, from visible text, HTML comments and meta tags."""
    haystacks = [text or ""]
    if html:
        haystacks += _COMMENT_RE.findall(html[:500_000]) + _META_RE.findall(html[:200_000])
        haystacks.append(re.sub(r"<[^>]+>", " ", html[:500_000]))
    hits: list[str] = []
    for hay in haystacks:
        for match in _INJECTION_RE.finditer(hay):
            snippet = re.sub(r"\s+", " ", hay[max(0, match.start() - 40): match.end() + 40]).strip()
            if snippet not in hits:
                hits.append(snippet[:200])
            if len(hits) >= 5:
                return hits
    return hits


def untrusted(text: str, source: str, limit: int = 2500) -> str:
    """Wrap page content so the model sees it as data from the site, never as instructions."""
    body = re.sub(r"</?\s*untrusted_page_content[^>]*>", "[removed delimiter]", text or "", flags=re.IGNORECASE)
    body = body[:limit] + (" [...truncated]" if len(body) > limit else "")
    source = re.sub(r"[<>\"'\s]+", " ", source or "").strip()[:200]
    return f'{UNTRUSTED_OPEN} source="{source}">\n{body}\n{UNTRUSTED_CLOSE}'
