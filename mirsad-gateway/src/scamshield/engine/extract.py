"""Static extraction from one HTML document: text, links, forms, embedded data, language."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from urllib.parse import urljoin, urlsplit, urlunsplit

import tldextract
from selectolax.lexbor import LexborHTMLParser, LexborNode

from scamshield.schemas import FormInfo

from .hashing import structure_hash

_TLD = tldextract.TLDExtract(suffix_list_urls=())  # bundled suffix list, never fetched at runtime

MAX_LINKS = 1000
MAX_DATA_TEXT = 20_000
_JS_TYPES = {"", "text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"}
_JSON_TYPES = {"application/json", "application/ld+json"}
# Markup and scripts are hostile input: every pattern here is bounded or possessive, so each is linear.
_STATE_ASSIGN = re.compile(r"\b(__[A-Za-z_]{1,40}?__)\s*+=\s*+")
_STATE_NAME = re.compile(r"STATE|DATA|NUXT|APOLLO", re.IGNORECASE)
MAX_DESCRIPTOR = 600
_JSON_PARSE_ARG = re.compile(r'JSON\.parse\(\s*+"((?:[^"\\]|\\.)*+)"\s*+\)')
_NON_TEXT_KEYS = {
    "id", "_id", "key", "url", "href", "src", "srcset", "image", "img", "icon", "logo", "slug", "path",
    "classname", "class", "style", "type", "__typename", "locale", "lang", "hash", "token", "uuid",
    "buildid", "assetprefix", "page", "query", "sizes", "width", "height", "color", "format",
}
_ARABIC = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
_LATIN = re.compile(r"[A-Za-zÀ-ɏ]")
_SPACE = re.compile(r"\s++")
_CAMEL = re.compile(r"([a-z])([A-Z])")
_SEPARATORS = re.compile(r"[_\-.\[\]:/]+")

# Field classifiers over a descriptor built from type, name, id, placeholder, autocomplete,
# aria-label and nearby label text. English and Arabic (UAE wording) on purpose.
_FIELD_PATTERNS: dict[str, re.Pattern] = {
    "national_id": re.compile(
        r"emirates ?id|\beid\b|national ?id|\bnid\b|id ?(?:number|no)\b|identity|civil ?id|passport|\b784\b"
        r"|الهوية|رقم الهوية|الهوية الإماراتية|بطاقة الهوية|جواز السفر|الرقم الموحد"
    ),
    "card": re.compile(
        r"cc ?(?:number|num|no)\b|card ?(?:number|num|no|holder)|\bccnum|credit|debit|\bpan\b|\bcard\b"
        r"|رقم البطاقة|بطاقة الائتمان|بطاقة الخصم|البطاقة المصرفية|حامل البطاقة"
    ),
    "cvv": re.compile(r"\bcvv2?\b|\bcvc2?\b|\bcsc\b|security ?code|cc ?csc|رمز الأمان|رمز التحقق من البطاقة|الرقم الخلفي"),
    "expiry": re.compile(r"\bexp(?:iry|iration|ire)?\b|cc ?exp|mm ?yy|valid ?thru|تاريخ الانتهاء|تاريخ الصلاحية|صالحة حتى"),
    "otp": re.compile(
        r"\botp\b|one ?time|verification ?code|verify ?code|sms ?code|auth(?:entication)? ?code|passcode|\btan\b"
        r"|رمز التحقق|رمز التفعيل|كلمة المرور لمرة واحدة|الرمز المؤقت|رمز مرة واحدة|الرمز المرسل"
    ),
    "pin": re.compile(r"\bpin\b|atm ?pin|الرقم السري|رمز البطاقة السري"),
    "password": re.compile(r"pass(?:word|wd|code)?\b|\bpwd\b|كلمة المرور|كلمة السر"),
    "phone": re.compile(r"phone|mobile|\bmsisdn\b|\btel\b|whatsapp|\+971|رقم الهاتف|الهاتف|الجوال|رقم الموبايل|المتحرك"),
}
_AUTOCOMPLETE_KIND = {
    "cc-number": "card", "cc-csc": "cvv", "cc-exp": "expiry", "cc-exp-month": "expiry",
    "cc-exp-year": "expiry", "cc-name": "card", "one-time-code": "otp", "current-password": "password",
    "new-password": "password", "tel": "phone", "tel-national": "phone",
}
_IGNORED_INPUTS = {"hidden", "submit", "button", "image", "reset"}


@dataclass
class ParsedPage:
    url: str
    title: str = ""
    text: str = ""
    visible_chars: int = 0
    lang: str | None = None
    declared_lang: str | None = None
    links: list[str] = field(default_factory=list)
    forms: list[FormInfo] = field(default_factory=list)
    iframes: list[str] = field(default_factory=list)
    external_hosts: list[str] = field(default_factory=list)
    script_srcs: list[str] = field(default_factory=list)
    inline_scripts: list[str] = field(default_factory=list)
    handler_code: str = ""
    favicon_url: str = ""
    meta_refresh: tuple[float, str] | None = None
    structure_hash: str | None = None


@lru_cache(maxsize=4096)
def site_of(host: str) -> str:
    """Registrable domain (eTLD+1) of a host; the host itself for IPs and single-label names."""
    host = (host or "").lower().strip(".")
    return _TLD(host).top_domain_under_public_suffix or host


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def same_site(a: str, b: str) -> bool:
    return bool(a) and bool(b) and site_of(a) == site_of(b)


def absolute(base: str, ref: str | None) -> str | None:
    """Resolve `ref` against `base`; None for non-web schemes and malformed URLs."""
    if not ref:
        return None
    ref = ref.strip()
    try:
        url = urljoin(base, ref)
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


def clean_text(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def detect_language(text: str, declared: str | None = None) -> str | None:
    """'ar', 'en', 'mixed', or the declared primary subtag for other Latin-script pages."""
    arabic = len(_ARABIC.findall(text))
    latin = len(_LATIN.findall(text))
    declared = (declared or "").split("-")[0].lower() or None
    if arabic + latin < 20:
        return declared
    share = arabic / (arabic + latin)
    if share >= 0.8:
        return "ar"
    if share <= 0.2:
        return declared if declared and declared not in ("ar", "en") else "en"
    return "mixed"


def json_text(value, out: list[str], budget: list[int], key: str = "", depth: int = 0) -> None:
    """Collect human-readable strings from a decoded JSON value, skipping ids, URLs and markup keys."""
    if budget[0] <= 0 or depth > 64:
        return
    if isinstance(value, dict):
        for k, v in value.items():
            json_text(v, out, budget, str(k), depth + 1)
    elif isinstance(value, list):
        for v in value:
            json_text(v, out, budget, key, depth + 1)
    elif isinstance(value, str) and key.lower() not in _NON_TEXT_KEYS:
        s = value.strip()
        if len(s) < 3 or s.startswith(("http://", "https://", "/", "data:", "#")):
            return
        if "<" in s and ">" in s:
            s = clean_text(LexborHTMLParser(s).text(separator=" "))
        if (" " in s or _ARABIC.search(s)) and re.search(r"[^\W\d_]", s):
            out.append(s[:2000])
            budget[0] -= len(s)


def _embedded_state(code: str):
    """Parse the JSON object assigned to a framework state global, e.g. `window.__INITIAL_STATE__ = {...}`."""
    match = next((m for m in _STATE_ASSIGN.finditer(code) if _STATE_NAME.search(m.group(1))), None)
    if not match:
        return None
    rest = code[match.end() :].lstrip()
    try:
        if parsed := _JSON_PARSE_ARG.match(rest):
            return json.loads(json.loads(f'"{parsed.group(1)}"'))
        return json.JSONDecoder().raw_decode(rest)[0]
    except (ValueError, RecursionError):
        return None


def _descriptor(node: LexborNode, labels: dict[str, str]) -> str:
    attrs = node.attributes
    parts = [attrs.get(k) or "" for k in ("type", "name", "id", "placeholder", "autocomplete", "aria-label", "title")]
    if attrs.get("id") in labels:
        parts.append(labels[attrs["id"]])
    parent = node.parent
    for _ in range(3):
        if parent is None:
            break
        if parent.tag == "label":
            parts.append(parent.text(separator=" ")[:120])
            break
        parent = parent.parent
    prev = node.prev
    while prev is not None and not (prev.is_element_node or (prev.is_text_node and prev.text().strip())):
        prev = prev.prev
    if prev is not None and prev.tag not in ("input", "select", "textarea"):
        parts.append(prev.text(separator=" ")[:120])
    joined = " ".join(p[:MAX_DESCRIPTOR] for p in parts if p)[:MAX_DESCRIPTOR]
    return _SEPARATORS.sub(" ", _CAMEL.sub(r"\1 \2", joined)).lower()


def classify_field(node: LexborNode, labels: dict[str, str]) -> set[str]:
    """Kinds of sensitive data an input asks for: password, card, cvv, expiry, otp, pin, national_id, phone."""
    attrs = node.attributes
    itype = (attrs.get("type") or "text").lower()
    kinds = {k for k, p in _FIELD_PATTERNS.items() if p.search(_descriptor(node, labels))}
    autocomplete = (attrs.get("autocomplete") or "").lower().split()
    kinds |= {_AUTOCOMPLETE_KIND[t] for t in autocomplete if t in _AUTOCOMPLETE_KIND}
    if itype == "password":
        kinds.add("password")
    if itype == "tel":
        kinds.add("phone")
    if "national_id" in kinds and not kinds & {"cvv", "expiry"}:
        kinds.discard("card")
    if "otp" in kinds and itype != "password":
        kinds.discard("password")
    if "cvv" in kinds or "pin" in kinds:
        kinds.discard("password")
    return kinds


def _form_info(form: LexborNode | None, inputs: list[LexborNode], page_url: str, labels: dict[str, str]) -> FormInfo:
    attrs = form.attributes if form is not None else {}
    raw_action = (attrs.get("action") or "").strip()
    action = absolute(page_url, raw_action) or (raw_action if raw_action else page_url)
    action_host = host_of(action) or None
    info = FormInfo(
        action=action,
        method=(attrs.get("method") or "get").lower(),
        action_host=action_host,
        external_action=raw_action.lower().startswith("mailto:")
        or (action_host is not None and not same_site(action_host, host_of(page_url))),
    )
    kinds: set[str] = set()
    for node in inputs:
        itype = (node.attributes.get("type") or ("text" if node.tag == "input" else node.tag)).lower()
        info.input_types.append(itype)
        if name := node.attributes.get("name"):
            info.input_names.append(name)
        if itype not in _IGNORED_INPUTS:
            kinds |= classify_field(node, labels)
    info.asks_password = bool(kinds & {"password", "pin"})
    info.asks_card = bool(kinds & {"card", "cvv", "expiry"})
    info.asks_otp = "otp" in kinds
    info.asks_national_id = "national_id" in kinds
    info.asks_phone = "phone" in kinds
    return info


def _forms(tree: LexborHTMLParser, page_url: str) -> list[FormInfo]:
    labels = {
        node.attributes["for"]: node.text(separator=" ")[:120]
        for node in tree.css("label[for]")
        if node.attributes.get("for")
    }
    forms: list[FormInfo] = []
    in_form: set[int] = set()
    for form in tree.css("form"):
        inputs = form.css("input, select, textarea")
        in_form.update(n.mem_id for n in inputs)
        forms.append(_form_info(form, inputs, page_url, labels))
    # Phishing kits often post with JavaScript and skip the <form> element entirely.
    orphans = [
        n for n in tree.css("input, select, textarea")
        if n.mem_id not in in_form and (n.attributes.get("type") or "text").lower() not in _IGNORED_INPUTS
    ]
    if orphans:
        forms.append(_form_info(None, orphans, page_url, labels))
    return forms


def _meta_refresh(tree: LexborHTMLParser, page_url: str) -> tuple[float, str] | None:
    for meta in tree.css("meta[http-equiv]"):
        if (meta.attributes.get("http-equiv") or "").strip().lower() != "refresh":
            continue
        match = re.match(r"\s*+([\d.]*)\s*+[;,]?\s*+(?:url\s*+=\s*+)?['\"]?([^'\"]*)", (meta.attributes.get("content") or "")[:2000], re.I)
        if match and match.group(2).strip():
            target = absolute(page_url, match.group(2).strip())
            if target:
                try:
                    delay = float(match.group(1) or 0)
                except ValueError:
                    delay = 0.0
                return delay, target
    return None


_TAG = re.compile(r"<(/?)([a-zA-Z][\w-]{0,30})[^<>]{0,2000}+>")
# Elements without an end tag, or whose end tag is optional, so they do not deepen the tree reliably.
_SHALLOW_TAGS = frozenset(
    "area base br col embed hr img input link meta param source track wbr p li dt dd option optgroup "
    "tr td th tbody thead tfoot colgroup rb rt rtc rp html head body".split()
)
MAX_DEPTH = 2000


def limit_nesting(html: str) -> str:
    """Cut the document where elements nest deeper than MAX_DEPTH.

    The HTML parser is quadratic in nesting depth, so a page of 50,000 unclosed <div>s would take
    seconds; no real page nests anywhere near this deep.
    """
    depth = 0
    for m in _TAG.finditer(html):
        name = m.group(2).lower()
        if name in _SHALLOW_TAGS or m.group(0).endswith("/>"):
            continue
        depth = max(0, depth - 1) if m.group(1) else depth + 1
        if depth > MAX_DEPTH:
            return html[: m.start()]
    return html


def parse_html(html: str, page_url: str) -> ParsedPage:
    tree = LexborHTMLParser(limit_nesting(html))
    base_tag = tree.css_first("base[href]")
    base = absolute(page_url, base_tag.attributes.get("href")) if base_tag else None
    base = base or page_url
    page = ParsedPage(url=page_url, structure_hash=structure_hash(tree))
    page_host = host_of(page_url)

    title = tree.css_first("title")
    page.title = clean_text(title.text()) if title else ""
    html_tag = tree.css_first("html")
    page.declared_lang = html_tag.attributes.get("lang") if html_tag else None

    data_text: list[str] = []
    budget = [MAX_DATA_TEXT]
    for meta in tree.css("meta[content]"):
        key = (meta.attributes.get("name") or meta.attributes.get("property") or "").lower()
        if key in ("description", "og:title", "og:description", "twitter:title", "twitter:description"):
            data_text.append(clean_text(meta.attributes["content"] or ""))

    for script in tree.css("script"):
        stype = (script.attributes.get("type") or "").strip().lower()
        code = script.text() or ""
        if script.attributes.get("src") is not None and stype not in _JSON_TYPES:
            if src := absolute(base, script.attributes.get("src")):
                page.script_srcs.append(src)
        elif stype in _JSON_TYPES or script.attributes.get("id") == "__NEXT_DATA__":
            try:
                json_text(json.loads(code), data_text, budget)
            except (ValueError, RecursionError):
                pass
        elif stype in _JS_TYPES and code.strip():
            page.inline_scripts.append(code)
            if (state := _embedded_state(code)) is not None:
                json_text(state, data_text, budget)

    handlers = []
    for node in tree.css("*"):
        for name, value in node.attributes.items():
            if value and (name.startswith("on") or (name == "href" and value.lstrip().lower().startswith("javascript:"))):
                handlers.append(value)
    page.handler_code = ";\n".join(handlers)

    page.meta_refresh = _meta_refresh(tree, base)
    page.forms = _forms(tree, base)

    resources: list[str] = list(page.script_srcs)
    for selector, attr in (
        ("link[href]", "href"), ("img[src]", "src"), ("iframe[src]", "src"), ("frame[src]", "src"),
        ("source[src]", "src"), ("video[src]", "src"), ("audio[src]", "src"), ("embed[src]", "src"),
        ("object[data]", "data"),
    ):
        for node in tree.css(selector):
            rel = (node.attributes.get("rel") or "").lower()
            if node.tag == "link" and rel in ("canonical", "alternate", "next", "prev", "shortlink", "author"):
                continue
            if url := absolute(base, node.attributes.get(attr)):
                resources.append(url)
                if node.tag in ("iframe", "frame"):
                    page.iframes.append(url)
    resources += [f.action for f in page.forms if f.action_host]
    page.external_hosts = sorted({h for h in map(host_of, resources) if h and not same_site(h, page_host)})

    icon = next(
        (n for n in tree.css("link[rel][href]") if "icon" in (n.attributes.get("rel") or "").lower().split()),
        None,
    )
    page.favicon_url = (absolute(base, icon.attributes.get("href")) if icon else None) or absolute(base, "/favicon.ico") or ""

    seen: set[str] = set()
    for node in tree.css("a[href], area[href]"):
        url = absolute(base, node.attributes.get("href"))
        if url and url not in seen:
            seen.add(url)
            page.links.append(url)
            if len(page.links) >= MAX_LINKS:
                break

    for node in tree.css("script, style, noscript, template, svg, head"):
        node.decompose()
    visible = clean_text(tree.body.text(separator=" ")) if tree.body else ""
    page.visible_chars = len(visible)
    extra = [t for t in dict.fromkeys(data_text) if t and t not in visible]
    page.text = clean_text(" ".join([visible, *extra]))
    page.lang = detect_language(f"{page.title} {page.text}", page.declared_lang)
    return page
