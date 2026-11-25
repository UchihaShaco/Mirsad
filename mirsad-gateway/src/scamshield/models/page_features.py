"""Page-content features computed from (url, html) only.

The same function runs at training time (over dataset rows) and at serving time (over a
`PageSnapshot`), so the model never sees features computed two different ways. The HTML is
parsed as data with selectolax; nothing is rendered, executed or fetched.

`extract(url, html)` returns a `PageFeatures` with:
  * `doc`    - normalised text for the TF-IDF models (title, visible text, form field words),
  * `struct` - a fixed-order float vector, names in `STRUCT_NAMES`,
  * `lang`   - "ar" | "en" | "other" | "none" (script / stop-word based, no external detector).
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
from selectolax.lexbor import LexborHTMLParser

MAX_HTML_CHARS = 300_000  # longer pages are truncated before parsing (the processed set stores 300 KiB)
MAX_TEXT_CHARS = 12_000  # visible text kept for the text model
MAX_SCRIPT_CHARS = 400_000  # script text scanned for scrambling markers

# --------------------------------------------------------------------------------------------
# Normalisation


_AR_DIACRITICS = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭ]")
_AR_MAP = str.maketrans(
    {
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه",
        "ـ": "", "ک": "ك", "ی": "ي",
        "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
        "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    }
)
_WS = re.compile(r"\s+")


def normalize_text(s: str) -> str:
    """NFKC, lower-case, Arabic letter-form / diacritic / digit normalisation, collapsed spaces."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s).lower()
    s = _AR_DIACRITICS.sub("", s).translate(_AR_MAP)
    return _WS.sub(" ", s).strip()


def _n(s: str) -> str:
    return normalize_text(s)


# --------------------------------------------------------------------------------------------
# Lexicons (patterns are matched against normalised text, so Arabic is written in normalised form)


def _rx(*alts: str) -> re.Pattern:
    return re.compile("|".join(f"(?:{_n(a) if not a.startswith('(?') else a})" for a in alts))


# what a form field asks for: matched on name / id / placeholder / aria-label / label text
FIELD_PATTERNS: dict[str, re.Pattern] = {
    "password": _rx(r"pass(?:word|wd|code)?\b", r"\bpwd\b", r"\bpin\b", "كلمة المرور", "كلمة السر",
                    "الرقم السري", "رمز المرور", "mot de passe", "contraseña", "passwort", "senha"),
    "card": _rx(r"card.?(?:number|no|num|holder)", r"\bcc.?(?:num|number|no)\b", r"\bcvv2?\b", r"\bcvc\b",
                r"\bccv\b", r"exp(?:iry|iration)?.?(?:date|month|year|mm|yy)", r"\bmm\s*/\s*yy", "debit card",
                "credit card", "رقم البطاقة", "البطاقة الائتمانية", "بطاقة الائتمان", "تاريخ الانتهاء",
                "تاريخ انتهاء", "رمز الامان", "حامل البطاقة", "الرقم الموجود خلف البطاقة"),
    "otp": _rx(r"\botp\b", "one.?time", r"sms.?code", r"verification.?code", r"security.?code", r"auth.?code",
               r"\btan\b", "رمز التحقق", "رمز التفعيل", "كود التحقق", "كود التفعيل", "رمز لمره واحده",
               "الرمز المرسل", "رمز ال otp", "كلمه المرور لمره واحده"),
    "national_id": _rx(r"emirates.?id", r"\beid\b", r"national.?id", r"id.?number", r"civil.?id", r"\bssn\b",
                       "social security", "passport", r"\biqama\b", "identity number", "رقم الهويه",
                       "الهويه الاماراتيه", "بطاقه الهويه", "الرقم الوطني", "رقم الاقامه", "جواز السفر",
                       "الهويه الوطنيه", "السجل المدني"),
    "email": _rx(r"e.?mail", r"\buser(?:name|id)?\b", r"\blogin\b", "البريد الالكتروني", "اسم المستخدم"),
    "phone": _rx(r"phone", r"mobile", r"\btel\b", r"\bmsisdn\b", "رقم الهاتف", "رقم الجوال", "رقم الموبايل",
                 "الهاتف المتحرك"),
    "personal": _rx(r"\bdob\b", "date of birth", "birth.?date", r"first.?name", r"last.?name", r"full.?name",
                    "mother", "address", r"\bzip\b", "postal", "تاريخ الميلاد", "الاسم الكامل", "العنوان",
                    "اسم الام"),
    "bank": _rx(r"\biban\b", "account.?number", "routing", "sort.?code", r"\bswift\b", "رقم الحساب",
                "الايبان", "رقم الايبان"),
}

# page-text lexicons (counts are normalised per 1k words and also kept as presence flags)
LEXICONS: dict[str, re.Pattern] = {
    "urgency": _rx(r"\burgent", r"immediately", r"within 24 ?hours", r"within \d+ (?:hours|days)", "expire",
                   "suspend", "deactivat", "locked", "limited time", "last chance", "final notice", "act now",
                   "عاجل", "فورا", "خلال 24 ساعه", "سيتم ايقاف", "تعليق", "ايقاف حسابك", "انتهاء الصلاحيه",
                   "اخر فرصه", "تنبيه نهائي", "قبل فوات", "محظور", "تجميد"),
    "payment": _rx("pay now", "payment", r"\bfee\b", r"\bfine\b", "outstanding", "invoice", "billing",
                   r"\bdue\b", "refund", "transaction", r"\baed\b", r"\bdhs?\b", "درهم", "دفع", "سداد", "رسوم",
                   "مخالفه", "مخالفات", "غرامه", "فاتوره", "استرداد", "المبلغ", "تحويل"),
    "prize": _rx("congratulations", "winner", r"\bwon\b", "prize", "reward", "gift", "free ", "lottery",
                 "jackpot", "claim your", "selected", "bonus", "مبروك", "تهانينا", "فزت", "جائزه", "جوائز",
                 "هديه", "مكافاه", "سحب", "مجانا", "ربحت"),
    "verify": _rx("verify", "verification", "confirm your", "validate", "update your", "re-?activate",
                  "unusual activity", "suspicious activity", "security check", "authenticate", "تحقق", "تاكيد",
                  "تحديث بيانات", "تحديث البيانات", "تفعيل", "نشاط غير عادي", "التحقق من"),
    "login": _rx("sign in", "log ?in", "password", "forgot", "remember me", "تسجيل الدخول", "دخول",
                 "كلمه المرور", "نسيت"),
    "delivery": _rx("parcel", "package", "shipment", "delivery", "tracking", "courier", "customs", "redeliver",
                    "شحنه", "طرد", "توصيل", "تتبع", "الجمارك", "اعاده التوصيل", "البريد"),
    "crypto": _rx("wallet", "seed phrase", "recovery phrase", "private key", "bitcoin", r"\bbtc\b", r"\busdt\b",
                  "crypto", "airdrop", "metamask", "محفظه", "عملات رقميه", "بيتكوين"),
    "government": _rx("ministry", "police", "government", "federal", "authority", "emirates id", "visa",
                      "traffic", "وزاره", "شرطه", "حكومه", "اتحادي", "هيئه", "مرور", "تاشيره", "اقامه"),
    "investment": _rx("invest", "profit", "returns", "trading", "forex", "guaranteed", "استثمار", "ارباح",
                      "تداول", "مضمون"),
}

# Lists frozen with the trained page model (models/data/page_features.json).
_LISTS = json.loads((Path(__file__).with_name("data") / "page_features.json").read_text(encoding="utf-8"))
_EN_STOP = frozenset("the and to of you your for is in on with this that are be we our please".split())
_FREE_HOSTS = tuple(_LISTS["free_hosts"])

# brand -> (tokens EN/AR, official registered-domain labels). A page that names a brand in its title,
# copyright line or login form while its own registered-domain label is not one of the brand's labels
# is a classic impersonation signal.
BRANDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    brand: (tuple(tokens), tuple(labels)) for brand, (tokens, labels) in _LISTS["brands"].items()
}


_BRAND_TOKEN = re.compile(r"\w+(?:[&.]\w+)*")


@lru_cache(maxsize=1)
def _brand_ngrams() -> dict[str, str]:
    """Normalised brand token sequence (space-joined words) -> brand."""
    out: dict[str, str] = {}
    for b, (toks, _) in BRANDS.items():
        for t in toks:
            out.setdefault(" ".join(_BRAND_TOKEN.findall(_n(t))), b)
    return out


_COPYRIGHT = re.compile(r"(?:©|&copy;|copyright|\(c\)|حقوق)[^<\n]{0,120}")

# scrambling / behaviour markers, matched on lower-cased script text (patterns start with a literal
# where possible so the regex engine can skip ahead quickly)
_JS_MARKERS: dict[str, re.Pattern] = {
    "eval": re.compile(r"eval\s*\("),
    "atob": re.compile(r"atob\s*\("),
    "fromcharcode": re.compile(r"fromcharcode"),
    "unescape": re.compile(r"(?:unescape|decodeuricomponent)\s*\("),
    "hex_ids": re.compile(r"_0x[0-9a-f]{3,}"),
    "hex_escapes": re.compile(r"\\(?:x[0-9a-f]{2}|u[0-9a-f]{4})"),
    "doc_write": re.compile(r"document\.write\s*\("),
    "redirect": re.compile(r"location(?:\.href)?\s*=[^=]|location\.(?:replace|assign)\s*\("),
    "telegram_api": re.compile(r"api\.telegram\.org|/bot\d{6,}:"),
    "discord_hook": re.compile(r"discord(?:app)?\.com/api/webhooks"),
    "ajax_php": re.compile(r"\.php['\"?]"),
    "no_rightclick": re.compile(r"contextmenu|event\.button\s*==\s*2|keycode\s*==\s*123"),
    "ip_lookup": re.compile(r"ipapi|ipinfo\.io|ip-api\.com|geoplugin|ipify"),
    "anti_bot": re.compile(r"navigator\.webdriver|headless|phantom|isbot|captcha"),
    "long_b64": re.compile(r"[a-z0-9+/]{400,}={0,2}"),
    # client-side cloaking gates (CrawlPhish): content shown only to some visitors / after interaction
    "cloak_useragent": re.compile(r"navigator\.(?:useragent|platform|language|vendor)"),
    "cloak_mouse": re.compile(r"mousemove|onmousemove|mouseover|touchstart"),
    "cloak_timer": re.compile(r"settimeout\s*\([\s\S]{0,200}?location|setinterval\s*\("),
    "cloak_cookie": re.compile(r"document\.cookie"),
    "cloak_referrer": re.compile(r"document\.referrer"),
    "cloak_debugger": re.compile(r"debugger\s*;|devtools"),
}

# --------------------------------------------------------------------------------------------
# Feature names (fixed order)

STRUCT_NAMES: tuple[str, ...] = (
    "html_len_log", "text_len_log", "n_words_log", "title_len", "has_title", "low_text",
    "arabic_ratio", "latin_ratio", "cjk_ratio", "lang_ar", "lang_en", "lang_other", "bilingual",
    "n_forms", "n_inputs", "n_hidden_inputs", "n_password_inputs", "n_text_inputs", "n_email_inputs",
    "n_tel_inputs", "n_buttons", "n_selects",
    "asks_password", "asks_card", "asks_otp", "asks_national_id", "asks_email", "asks_phone",
    "asks_personal", "asks_bank", "n_sensitive_kinds",
    "form_action_external", "form_action_empty", "form_action_php", "form_action_mailto",
    "form_action_js", "form_method_post", "inputs_outside_form", "autocomplete_off",
    "n_links_log", "link_external_ratio", "link_null_ratio", "n_link_hosts", "links_to_brand_domain",
    "wa_me_links", "tel_links", "mailto_links",
    "n_iframes", "iframe_hidden", "iframe_external",
    "n_scripts", "n_ext_scripts", "ext_script_ratio", "inline_script_kb_log", "max_inline_script_kb_log",
    "js_eval", "js_atob", "js_fromcharcode", "js_unescape", "js_hex_ids", "js_hex_escapes_log",
    "js_doc_write", "js_redirect", "js_telegram_api", "js_discord_hook", "js_ajax_php", "js_no_rightclick",
    "js_ip_lookup", "js_anti_bot", "js_long_b64", "js_scramble_score",
    "js_cloak_useragent", "js_cloak_mouse", "js_cloak_timer", "js_cloak_cookie", "js_cloak_referrer",
    "js_cloak_debugger", "js_cloak_score",
    "meta_refresh", "meta_refresh_external", "meta_noindex", "has_base_tag",
    "n_imgs", "img_external_ratio", "data_uri_imgs", "n_css", "css_external_ratio", "resource_external_ratio",
    "favicon_present", "favicon_external", "favicon_data_uri",
    "n_brands_text", "brand_title_mismatch", "brand_copyright_mismatch", "brand_form_mismatch",
    "brand_text_mismatch", "brand_uae_mismatch", "domain_brand_known", "copyright_present",
    "lex_urgency", "lex_payment", "lex_prize", "lex_verify", "lex_login", "lex_delivery", "lex_crypto",
    "lex_government", "lex_investment",
    "lexp_urgency", "lexp_payment", "lexp_prize", "lexp_verify", "lexp_login", "lexp_delivery",
    "lexp_crypto", "lexp_government", "lexp_investment",
    "url_https", "url_host_is_ip", "url_subdomain_depth", "url_free_host",
    "url_has_at", "url_punycode", "noscript_present", "title_is_brand_only",
)
_IDX = {n: i for i, n in enumerate(STRUCT_NAMES)}
# UAE and Gulf brands come first in BRANDS, global ones start at "paypal"
_GULF_BRANDS = frozenset(list(BRANDS)[: list(BRANDS).index("paypal")])


@dataclass
class PageFeatures:
    doc: str
    struct: np.ndarray
    lang: str
    n_text_chars: int
    title: str = ""
    brands: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------------------------
# Helpers

_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$")
_WORD_RE = re.compile(r"\w+")


@lru_cache(maxsize=1)
def _tld():
    import tldextract

    return tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)


@lru_cache(maxsize=4096)
def split_host(host: str) -> tuple[str, str, str]:
    """(registered_domain, domain_label, subdomain) for a host name, offline."""
    if not host or _IP_RE.match(host):
        return host, host, ""
    r = _tld()(host)
    reg = r.top_domain_under_public_suffix or host
    return reg, r.domain or host, r.subdomain or ""


def _host_of(link: str, base: str) -> str | None:
    """Host of an absolute or relative link; None for null/script links."""
    link = link.strip()
    if not link or link.startswith("#") or link.lower().startswith(("javascript:", "data:", "about:")):
        return None
    try:
        if link.startswith("//") or "://" in link[:12]:
            return (urlsplit(link if "://" in link[:12] else "http:" + link).hostname or "").lower()
        return base
    except ValueError:
        return None


def _is_external(host: str | None, reg: str) -> bool:
    return bool(host) and split_host(host)[0] != reg


def _script_ratios(text: str) -> tuple[float, float, float]:
    ar = lat = cjk = 0
    for ch in text[:5000]:
        o = ord(ch)
        if 0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or 0xFB50 <= o <= 0xFEFF:
            ar += 1
        elif (0x41 <= o <= 0x5A) or (0x61 <= o <= 0x7A) or 0xC0 <= o <= 0x24F:
            lat += 1
        elif 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF:
            cjk += 1
    tot = ar + lat + cjk
    if not tot:
        return 0.0, 0.0, 0.0
    return ar / tot, lat / tot, cjk / tot


def detect_lang(text: str) -> str:
    """Coarse page language from visible text: ar | en | other | none."""
    if len(text.strip()) < 3:
        return "none"
    ar, lat, cjk = _script_ratios(text)
    if ar >= 0.3:
        return "ar"
    if lat >= 0.5:
        words = _WORD_RE.findall(text[:4000].lower())
        if words and sum(w in _EN_STOP for w in words) / len(words) >= 0.04:
            return "en"
        return "en" if len(words) < 15 and all(w.isascii() for w in words) else "other"
    return "other" if ar + lat + cjk else "none"


def _log1p(x: float) -> float:
    return math.log1p(max(0.0, x))


def _brand_hits(text: str) -> set[str]:
    if not text:
        return set()
    grams = _brand_ngrams()
    words = _BRAND_TOKEN.findall(text)
    hits = set()
    for n in (1, 2, 3, 4, 5):
        for i in range(len(words) - n + 1):
            b = grams.get(" ".join(words[i : i + n]))
            if b:
                hits.add(b)
    return hits


def _brand_owns(brand: str, domain_label: str, reg: str) -> bool:
    labels = BRANDS[brand][1]
    return domain_label in labels or any(reg.startswith(lbl + ".") for lbl in labels)


# --------------------------------------------------------------------------------------------
# Main extraction


def extract(url: str, html: str, *, title: str | None = None, text: str | None = None) -> PageFeatures:
    """Features from a page URL and its raw HTML. `title` / `text` are used only if the HTML yields none."""
    html = (html or "")[:MAX_HTML_CHARS]
    v = np.zeros(len(STRUCT_NAMES), dtype=np.float32)

    def put(name: str, value: float) -> None:
        v[_IDX[name]] = value

    try:
        parts = urlsplit(url if "://" in url[:12] else "http://" + url)
        host = (parts.hostname or "").lower()
    except ValueError:
        host, parts = "", None
    reg, dlabel, sub = split_host(host)

    tree = LexborHTMLParser(html) if html else LexborHTMLParser("<html></html>")

    # ---- title, metas, favicon, base
    t_node = tree.css_first("title")
    page_title = (t_node.text(strip=True) if t_node else "") or (title or "")
    ntitle = _n(page_title)[:300]
    put("title_len", min(len(ntitle), 300) / 100)
    put("has_title", float(bool(ntitle)))

    for m in tree.css("meta"):
        a = m.attributes
        he = (a.get("http-equiv") or "").lower()
        if he == "refresh":
            put("meta_refresh", 1.0)
            content = a.get("content") or ""
            mm = re.search(r"url\s*=\s*['\"]?([^'\";]+)", content, re.I)
            if mm and _is_external(_host_of(mm.group(1), host), reg):
                put("meta_refresh_external", 1.0)
        if (a.get("name") or "").lower() == "robots" and "noindex" in (a.get("content") or "").lower():
            put("meta_noindex", 1.0)
    put("has_base_tag", float(tree.css_first("base") is not None))

    fav_ext = fav_data = fav = 0
    for lk in tree.css("link"):
        rel = (lk.attributes.get("rel") or "").lower()
        if "icon" in rel:
            fav = 1
            href = lk.attributes.get("href") or ""
            if href.startswith("data:"):
                fav_data = 1
            elif _is_external(_host_of(href, host), reg):
                fav_ext = 1
    put("favicon_present", fav)
    put("favicon_external", fav_ext)
    put("favicon_data_uri", fav_data)

    # ---- scripts
    n_scripts = n_ext = 0
    inline_total = 0
    inline_max = 0
    script_buf: list[str] = []
    budget = MAX_SCRIPT_CHARS
    for s in tree.css("script"):
        n_scripts += 1
        src = s.attributes.get("src")
        if src:
            n_ext += _is_external(_host_of(src, host), reg)
            continue
        body = s.text() or ""
        inline_total += len(body)
        inline_max = max(inline_max, len(body))
        if budget > 0:
            script_buf.append(body[:budget])
            budget -= len(body)
    # inline handlers often carry the redirect / exfiltration code too
    for node in tree.css("[onload],[onclick],[onsubmit]"):
        for k in ("onload", "onclick", "onsubmit"):
            val = node.attributes.get(k)
            if val and budget > 0:
                script_buf.append(val)
                budget -= len(val)
    js = "\n".join(script_buf).lower()
    put("n_scripts", min(n_scripts, 100))
    put("n_ext_scripts", min(n_ext, 100))
    put("ext_script_ratio", n_ext / n_scripts if n_scripts else 0.0)
    put("inline_script_kb_log", _log1p(inline_total / 1024))
    put("max_inline_script_kb_log", _log1p(inline_max / 1024))
    scramble = 0.0
    for name, rx in _JS_MARKERS.items():
        c = len(rx.findall(js)) if js else 0
        if name == "hex_escapes":
            put("js_hex_escapes_log", _log1p(c))
            scramble += min(c, 200) / 50
        else:
            put(f"js_{name}", min(c, 50))
            if name in ("eval", "atob", "fromcharcode", "unescape", "hex_ids", "long_b64"):
                scramble += min(c, 20) / 5
    put("js_scramble_score", scramble)
    put("js_cloak_score", float(sum(v[_IDX[f"js_cloak_{k}"]] > 0 for k in
                                    ("useragent", "mouse", "timer", "cookie", "referrer", "debugger"))))
    put("noscript_present", float(tree.css_first("noscript") is not None))

    # ---- iframes, images, css
    iframes = tree.css("iframe")
    put("n_iframes", min(len(iframes), 20))
    ifr_h = ifr_e = 0
    for f in iframes:
        a = f.attributes
        style = (a.get("style") or "").replace(" ", "").lower()
        if a.get("width") in ("0", "1") or a.get("height") in ("0", "1") or "display:none" in style or "hidden" in a:
            ifr_h += 1
        if _is_external(_host_of(a.get("src") or "", host), reg):
            ifr_e += 1
    put("iframe_hidden", min(ifr_h, 10))
    put("iframe_external", min(ifr_e, 10))

    imgs = tree.css("img")
    img_ext = img_data = 0
    for im in imgs:
        src = im.attributes.get("src") or ""
        if src.startswith("data:"):
            img_data += 1
        elif _is_external(_host_of(src, host), reg):
            img_ext += 1
    put("n_imgs", min(len(imgs), 200) / 10)
    put("img_external_ratio", img_ext / len(imgs) if imgs else 0.0)
    put("data_uri_imgs", min(img_data, 50))
    css = [lk for lk in tree.css("link") if "stylesheet" in (lk.attributes.get("rel") or "").lower()]
    css_ext = sum(_is_external(_host_of(lk.attributes.get("href") or "", host), reg) for lk in css)
    put("n_css", min(len(css), 50))
    put("css_external_ratio", css_ext / len(css) if css else 0.0)
    n_res = len(imgs) + len(css) + n_scripts
    put("resource_external_ratio", (img_ext + css_ext + n_ext) / n_res if n_res else 0.0)

    # ---- links
    anchors = tree.css("a")
    n_null = n_extl = wa = tel = mailto = 0
    link_hosts: set[str] = set()
    link_regs: set[str] = set()
    for a in anchors:
        href = (a.attributes.get("href") or "").strip()
        low = href.lower()
        if not href or href == "#" or low.startswith("#") or low.startswith("javascript"):
            n_null += 1
            continue
        if low.startswith("tel:"):
            tel += 1
            continue
        if low.startswith("mailto:"):
            mailto += 1
            continue
        h = _host_of(href, host)
        if h:
            link_hosts.add(h)
            if "wa.me" in h or "whatsapp" in h:
                wa += 1
            if _is_external(h, reg):
                n_extl += 1
                link_regs.add(split_host(h)[0])
    n_a = len(anchors)
    put("n_links_log", _log1p(n_a))
    put("link_external_ratio", n_extl / n_a if n_a else 0.0)
    put("link_null_ratio", n_null / n_a if n_a else 0.0)
    put("n_link_hosts", min(len(link_hosts), 100) / 10)
    put("wa_me_links", min(wa, 10))
    put("tel_links", min(tel, 10))
    put("mailto_links", min(mailto, 10))

    # ---- forms
    forms = tree.css("form")
    put("n_forms", min(len(forms), 20))
    all_inputs = tree.css("input")
    types = [(i.attributes.get("type") or "text").lower() for i in all_inputs]
    put("n_inputs", min(len(all_inputs), 100))
    put("n_hidden_inputs", min(types.count("hidden"), 50))
    put("n_password_inputs", min(types.count("password"), 10))
    put("n_text_inputs", min(types.count("text"), 50))
    put("n_email_inputs", min(types.count("email"), 10))
    put("n_tel_inputs", min(types.count("tel") + types.count("number"), 20))
    put("n_buttons", min(len(tree.css("button")) + types.count("submit"), 50))
    put("n_selects", min(len(tree.css("select")), 20))
    put("autocomplete_off", float(any((i.attributes.get("autocomplete") or "").lower() in ("off", "one-time-code")
                                      for i in all_inputs)))
    in_form = sum(len(f.css("input")) for f in forms)
    put("inputs_outside_form", min(max(0, len(all_inputs) - in_form), 50))

    field_words: list[str] = []
    for i in all_inputs + tree.css("select,textarea"):
        a = i.attributes
        if (a.get("type") or "").lower() in ("hidden", "submit", "button", "image", "reset", "checkbox", "radio"):
            continue
        for k in ("name", "id", "placeholder", "aria-label", "autocomplete", "title", "type"):
            val = a.get(k)
            if val:
                field_words.append(val)
    for lab in tree.css("label"):
        field_words.append(lab.text(strip=True)[:80])
    field_text = _n(" ".join(field_words))[:4000]
    field_text_sep = re.sub(r"[_\-\.\[\]]", " ", field_text)
    asks = {k: bool(p.search(field_text) or p.search(field_text_sep)) for k, p in FIELD_PATTERNS.items()}
    if types.count("password"):
        asks["password"] = True
    if not (all_inputs or tree.css("select,textarea")):
        asks = dict.fromkeys(asks, False)
    for k, val in asks.items():
        put(f"asks_{k}", float(val))
    put("n_sensitive_kinds", float(sum(asks[k] for k in ("password", "card", "otp", "national_id", "bank"))))

    ext = empty = php = mail = jsact = post = 0
    for f in forms:
        a = f.attributes
        act = (a.get("action") or "").strip()
        low = act.lower()
        if (a.get("method") or "").lower() == "post":
            post = 1
        if not act or act == "#" or low.startswith("about:"):
            empty = 1
        elif low.startswith("mailto:"):
            mail = 1
        elif low.startswith("javascript"):
            jsact = 1
        else:
            if ".php" in low:
                php = 1
            if _is_external(_host_of(act, host), reg):
                ext = 1
    put("form_action_external", ext)
    put("form_action_empty", empty)
    put("form_action_php", php)
    put("form_action_mailto", mail)
    put("form_action_js", jsact)
    put("form_method_post", post)

    # ---- visible text
    footer_raw = ""
    m_copy = _COPYRIGHT.findall(html[-60_000:]) if html else []
    if m_copy:
        footer_raw = m_copy[-1]
    tree.strip_tags(["script", "style", "noscript", "template", "svg", "head"])
    body = tree.body
    vis = body.text(separator=" ", strip=True) if body is not None else ""
    if not vis.strip() and text:
        vis = text
    vis = _WS.sub(" ", vis)[: MAX_TEXT_CHARS * 2]
    ntext = _n(vis)[:MAX_TEXT_CHARS]
    words = _WORD_RE.findall(ntext)
    put("html_len_log", _log1p(len(html)))
    put("text_len_log", _log1p(len(ntext)))
    put("n_words_log", _log1p(len(words)))
    put("low_text", float(len(words) < 30))
    ar, lat, cjk = _script_ratios(ntitle + " " + ntext)
    put("arabic_ratio", ar)
    put("latin_ratio", lat)
    put("cjk_ratio", cjk)
    lang = detect_lang(page_title + " " + vis[:5000])
    put("lang_ar", float(lang == "ar"))
    put("lang_en", float(lang == "en"))
    put("lang_other", float(lang == "other"))
    put("bilingual", float(0.1 <= ar <= 0.9 and lat >= 0.1))

    # ---- lexicons
    lex_text = ntitle + " " + ntext
    nw = max(len(words), 1)
    for k, p in LEXICONS.items():
        c = len(p.findall(lex_text))
        put(f"lex_{k}", min(1000.0 * c / max(nw, 50), 200.0) / 10)
        put(f"lexp_{k}", float(c > 0))

    # ---- brands vs domain
    ncopy = _n(footer_raw)
    title_b = _brand_hits(ntitle)
    copy_b = _brand_hits(ncopy)
    form_b = _brand_hits(field_text + " " + _n(" ".join(f.text(separator=" ")[:600] for f in forms)))
    text_b = _brand_hits(ntext[:6000])
    mentioned = title_b | copy_b | text_b | form_b
    own = {b for b in BRANDS if BRANDS[b][1] and _brand_owns(b, dlabel, reg)}
    put("domain_brand_known", float(bool(own)))

    def mismatch(bs: set[str]) -> float:
        return float(len({b for b in bs if b not in own and b != "webmail"}))

    put("n_brands_text", min(len(mentioned), 20))
    put("brand_title_mismatch", mismatch(title_b) + ("webmail" in title_b))
    put("brand_copyright_mismatch", mismatch(copy_b))
    put("brand_form_mismatch", mismatch(form_b) + ("webmail" in form_b))
    put("brand_text_mismatch", min(mismatch(text_b), 10))
    put("brand_uae_mismatch", float(len({b for b in mentioned & _GULF_BRANDS if b not in own})))
    put("copyright_present", float(bool(footer_raw)))
    put("links_to_brand_domain", float(any(
        any(split_host(r)[1] in BRANDS[b][1] for b in mentioned if b not in own) for r in link_regs)))
    tb = ntitle.strip(" -|:·")
    put("title_is_brand_only", float(bool(title_b) and len(tb.split()) <= 3))

    # ---- light URL context (the URL model covers the URL itself in depth; path depth and URL length
    #      are left out on purpose: in the public sets legitimate pages are mostly deep links and phishing
    #      pages mostly roots, a shortcut that would flag real bank / government home pages)
    if parts is not None:
        put("url_https", float(parts.scheme == "https"))
        put("url_host_is_ip", float(bool(_IP_RE.match(host)) and bool(host)))
        put("url_subdomain_depth", min(len([x for x in sub.split(".") if x and x != "www"]), 10))
        put("url_free_host", float(any(host == fh or host.endswith("." + fh) for fh in _FREE_HOSTS)))
        put("url_has_at", float("@" in (parts.netloc or "")))
        put("url_punycode", float("xn--" in host))

    # ---- document for the text models
    form_tokens = " ".join(f"field_{k}" for k, val in asks.items() if val)
    doc = " ".join(x for x in (ntitle, ntitle, field_text[:1500], form_tokens, ntext) if x)
    return PageFeatures(doc=doc, struct=v, lang=lang, n_text_chars=len(ntext), title=page_title,
                        brands=sorted(mentioned - own))


_ENCODER_SIGNALS = ("brand_title_mismatch", "brand_form_mismatch", "brand_copyright_mismatch", "brand_uae_mismatch",
                    "form_action_external", "form_action_php", "js_cloak_score", "js_scramble_score",
                    "js_telegram_api", "meta_refresh_external", "url_free_host", "low_text")


def encoder_input(url: str, title: str, doc: str, struct: np.ndarray, max_chars: int = 3000) -> str:
    """Text the fine-tuned page encoder reads: URL, title, a form / signal summary, then page text."""
    asks = [k for k in ("password", "card", "otp", "national_id", "bank", "email", "phone", "personal")
            if struct[_IDX[f"asks_{k}"]] > 0]
    sig = [s for s in _ENCODER_SIGNALS if struct[_IDX[s]] > 0]
    form = f"form asks: {', '.join(asks) or 'nothing'}"
    return f"{url} [SEP] {title} [SEP] {form}; signals: {', '.join(sig) or 'none'} [SEP] {doc[:max_chars]}"


def extract_snapshot(page) -> PageFeatures | None:
    """Features from a `PageSnapshot`; None when the page has no usable HTML."""
    html = page.html or ""
    if len(html.strip()) < 20:
        return None
    return extract(page.final_url or page.url, html, title=page.title, text=page.text)


# human-readable labels for explanations
FEATURE_LABELS: dict[str, str] = {
    "asks_password": "form asks for a password",
    "asks_card": "form asks for card details",
    "asks_otp": "form asks for a one-time code",
    "asks_national_id": "form asks for a national / Emirates ID",
    "asks_bank": "form asks for bank account details",
    "form_action_external": "form submits to another site",
    "form_action_php": "form posts to a PHP script",
    "brand_title_mismatch": "title names a brand this domain does not belong to",
    "brand_copyright_mismatch": "copyright line names a brand this domain does not belong to",
    "brand_form_mismatch": "login form names a brand this domain does not belong to",
    "brand_uae_mismatch": "page names a UAE brand / authority this domain does not belong to",
    "js_scramble_score": "scripts are deliberately scrambled",
    "js_telegram_api": "page sends data to a Telegram bot",
    "js_cloak_score": "scripts hide content from some visitors (cloaking)",
    "js_anti_bot": "scripts check for automated browsers",
    "meta_refresh_external": "page redirects to another site",
    "link_null_ratio": "many links lead nowhere",
    "favicon_external": "icon loaded from another site",
    "resource_external_ratio": "most resources loaded from other sites",
    "url_free_host": "hosted on a free site builder",
    "low_text": "page has almost no text",
}
