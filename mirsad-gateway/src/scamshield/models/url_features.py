"""URL-string features shared by training (ml/url) and serving (url_model.py).

Everything here is computed from the URL text alone: no DNS, no HTTP, no clock.
The scheme and a leading "www." are deliberately ignored, because labelled URL feeds differ in
whether they include them (legitimate top-site lists are usually bare hostnames that someone
prefixed with "https://"), so a model that sees them learns the collection process, not scams.
"""

from __future__ import annotations

import ipaddress
import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import unquote, urlsplit

import numpy as np
import tldextract

_EXTRACT = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)

# Top-level domains with persistently high abuse rates (Spamhaus / Interisle phishing reports).
RISKY_TLDS = frozenset(
    """top xyz shop online site icu cfd sbs click buzz live vip cc tk ml ga cf gq rest lol bond cyou
    monster life store support info work loan win bid ltd fun space website club pw cn ru su today
    digital link best world email services center cloud host press quest bar beauty hair skin makeup
    autos boats homes motorcycles yachts mom bio tokyo asia ws me us ink pics wiki one app dev io
    zip mov foo""".split()
)
TRUSTED_SUFFIXES = ("gov.ae", "ae", "gov", "edu", "mil", "int", "gov.uk", "ac.uk", "edu.au", "gov.au", "gov.sa")

SHORTENERS = frozenset(
    """bit.ly bitly.com tinyurl.com t.co goo.gl is.gd cutt.ly rb.gy ow.ly buff.ly rebrand.ly s.id shorturl.at
    t.ly tiny.cc bitly.ws v.gd qrco.de lnkd.in shorte.st adf.ly bl.ink short.io urlz.fr u.to clck.ru
    t.me wa.me tr.ee linktr.ee x.gd 2u.pm surl.li inx.lv shorturl.asia gg.gg did.li tiny.one bit.do
    s.yam.com 4.gp zpr.io go2l.ink urlr.me l.ead.me q-r.to dub.sh dub.co lnk.to""".split()
)
# Platforms where anyone can publish under the platform's registrable domain.
SHARED_HOSTING = frozenset(
    """000webhostapp.com weebly.com weeblysite.com wixsite.com wix.com blogspot.com github.io netlify.app
    vercel.app pages.dev workers.dev firebaseapp.com web.app herokuapp.com glitch.me repl.co replit.dev
    replit.app ngrok.io ngrok-free.app ngrok.app duckdns.org godaddysites.com webflow.io square.site
    azurewebsites.net r2.dev myshopify.com carrd.co framer.website framer.app wordpress.com mystrikingly.com
    strikingly.com jimdosite.com yolasite.com webcindario.com typedream.app gitbook.io notion.site
    surge.sh render.com onrender.com fly.dev cprapid.com sites.google.com docs.google.com forms.gle
    storage.googleapis.com appspot.com s3.amazonaws.com amazonaws.com blob.core.windows.net
    web.core.windows.net cloudfront.net b-cdn.net ipfs.io dweb.link fleek.co on.fleek.co filesusr.com
    tilda.ws mozello.com site123.me webnode.page webnode.com wixstudio.io hostingersite.com
    yolasite.com ukit.me liveblog365.com rf.gd infinityfreeapp.com epizy.com 42web.io wuaze.com
    free.nf great-site.net lovable.app bolt.new glide.page softr.app zohosites.com""".split()
)

BRANDS = (
    # UAE banks, payments, government, telecom, utilities, couriers, transport
    "adcb fab bankfab enbd emiratesnbd mashreq adib dib rakbank cbd nbf ajmanbank sib alhilalbank wio liv "
    "uaepass adpolice dubaipolice moi icp ica mohre tamm dubainow mol rta salik nol darb dewa addc sewa "
    "fewa etihadwe etisalat eand du virginmobile emiratespost aramex smsa noon careem talabat "
    "emirates etihad flydubai airarabia dubaiholding emaar adnoc enoc mubadala hukoomi u.ae "
    "taqa ajman sharjah dubai abudhabi "
    # global brands most impersonated in phishing reports
    "paypal apple icloud microsoft office365 office outlook live hotmail onedrive sharepoint teams "
    "google gmail youtube facebook instagram whatsapp meta netflix amazon prime dhl fedex ups usps "
    "royalmail evri dpd aliexpress alibaba ebay binance coinbase metamask trustwallet blockchain "
    "visa mastercard amex americanexpress chase wellsfargo bankofamerica citi hsbc barclays santander "
    "telegram tiktok linkedin twitter adobe dropbox docusign steam roblox spotify booking airbnb "
    "stcpay alrajhi absher snb mada"
).split()
_BRAND_SET = frozenset(BRANDS)
_BRAND_RE = re.compile("|".join(sorted((re.escape(b) for b in BRANDS if len(b) >= 4), key=len, reverse=True)))

KEYWORDS_EN = (
    "login logon signin sign-in verify verification secure security account update banking confirm "
    "password passwd wallet support billing invoice suspend suspended unlock payment pay refund reward "
    "prize gift claim delivery parcel package track tracking customs fine fines toll kyc otp auth "
    "webscr cmd recover recovery restore validate validation authenticate unusual alert limited "
    "expire expired renew bonus free win winner lucky offer promo airdrop seed connect dapp "
    "invest crypto bitcoin usdt loan cashback voucher coupon redeem activate reactivate session token"
).split()
# Arabic (Gulf) words as they appear transliterated in scam domains and paths.
KEYWORDS_AR = (
    "khidma khidmat khadamat mukhalafat mukhalafa tasdeed sadad dirham dirhams baladiya baladiyah hukoomi "
    "hukumi hukoomat tawasul mawaid shurta shurtah muroor murur jawazat jawazaat masrafi masraf bank-al "
    "alahli jaiza jaizah jawaiz hadiya hadaya tasjeel taqreer tahdith tahdeeth tafeel taf3eel "
    "barid bareed tard ta3weed taawidh mukafaa mukafa2a raseed rasid fatoora fatora sharika "
    "ajel 3ajel ajil mustaajil emarat emirati imarat watani tamween zakat sadaqa ramadan eid "
    "hajj umrah naqd wazara wizara wizarat dawla"
).split()
KEYWORDS_AR_SCRIPT = ("تحديث", "بنك", "تسجيل", "دخول", "حساب", "دفع", "مخالفات", "جائزة", "تأكيد", "بطاقة", "شرطة", "بريد")
_KW_EN_RE = re.compile("|".join(sorted(map(re.escape, KEYWORDS_EN), key=len, reverse=True)))
_KW_AR_RE = re.compile("|".join(sorted(map(re.escape, KEYWORDS_AR), key=len, reverse=True)))

RISKY_EXTENSIONS = (".php", ".asp", ".aspx", ".cgi", ".exe", ".apk", ".zip", ".rar", ".scr", ".js", ".html", ".htm")
_HEX_RUN = re.compile(r"[0-9a-f]{16,}")
_B64_RUN = re.compile(r"[A-Za-z0-9_\-]{30,}")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_IPV4_LOOSE = re.compile(r"^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$")
_TOKEN_SPLIT = re.compile(r"[/\.\-_=&?~+:;,%@!]+")
_VOWELS = frozenset("aeiou")


@dataclass(frozen=True)
class ParsedURL:
    host: str  # lowercase, without port, "www." kept
    subdomain: str  # without leading "www."
    domain: str  # registrable label, e.g. "paypal" in paypal.co.uk
    suffix: str  # public suffix, e.g. "co.uk"
    registered_domain: str
    port: str
    userinfo: str
    path: str
    query: str
    fragment: str
    normalized: str  # host[/path][?query] without scheme / leading www. / bare trailing slash


def _strip_scheme(url: str) -> str:
    url = url.strip()
    m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]{0,15}://", url)
    if m:
        return url[m.end():]
    if url.startswith("//"):
        return url[2:]
    return url


@lru_cache(maxsize=65536)
def parse_url(url: str) -> ParsedURL:
    rest = _strip_scheme(url)
    try:
        sp = urlsplit("http://" + rest)
        netloc, path, query, fragment = sp.netloc, sp.path, sp.query, sp.fragment
    except ValueError:  # malformed (e.g. bad IPv6 bracket): fall back to a plain split
        netloc, _, tail = rest.partition("/")
        path, query, fragment = "/" + tail, "", ""
    userinfo, _, hostport = netloc.rpartition("@")
    host, port = hostport, ""
    if hostport.startswith("["):
        host, _, after = hostport[1:].partition("]")
        port = after.lstrip(":")
    elif hostport.count(":") == 1:
        host, port = hostport.split(":")
    host = host.lower().rstrip(".")
    ext = _EXTRACT(host)
    sub = ext.subdomain
    if sub == "www" or sub.startswith("www."):
        sub = sub[4:]
    reg = ext.top_domain_under_public_suffix or host
    bare_host = host[4:] if host.startswith("www.") else host
    norm_path = "" if path in ("", "/") and not query else path
    normalized = bare_host + norm_path + ("?" + query if query else "")
    return ParsedURL(host, sub, ext.domain, ext.suffix, reg, port, userinfo, path, query, fragment, normalized)


def normalize_for_text(url: str) -> str:
    """The string the character n-gram model sees."""
    return parse_url(url).normalized.lower()


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in Counter(s).values())


def _ratio(n: int, d: int) -> float:
    return n / d if d else 0.0


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return bool(_IPV4_LOOSE.match(host))  # decimal / hex / octal encoded IPv4


def _on_list(host: str, reg: str, names: frozenset) -> bool:
    if reg in names or host in names:
        return True
    parts = host.split(".")
    return any(".".join(parts[i:]) in names for i in range(1, len(parts) - 1))


def _brand_hits(text: str) -> set[str]:
    return set(_BRAND_RE.findall(text))


def _near_brand(label: str) -> float:
    """1 if the registrable label is one edit away from a brand (typosquat), else 0."""
    if len(label) < 4 or label in _BRAND_SET:
        return 0.0
    for b in BRANDS:
        if len(b) >= 5 and abs(len(b) - len(label)) <= 1 and _edit_distance_le1(label, b):
            return 1.0
    return 0.0


def _edit_distance_le1(a: str, b: str) -> bool:
    if a == b:
        return True
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


def _part_stats(s: str) -> list[float]:
    n = len(s)
    digits = sum(c.isdigit() for c in s)
    letters = sum(c.isalpha() for c in s)
    upper = sum(c.isupper() for c in s)
    return [float(n), _entropy(s), _ratio(digits, n), _ratio(letters, n), _ratio(n - digits - letters, n), _ratio(upper, n)]


_PART_STAT_NAMES = ("len", "entropy", "digit_ratio", "letter_ratio", "symbol_ratio", "upper_ratio")


def _feature_names() -> list[str]:
    names = [f"{part}_{s}" for part in ("url", "host", "path", "query") for s in _PART_STAT_NAMES]
    names += [
        "subdomain_depth", "subdomain_len", "domain_label_len", "domain_label_entropy", "domain_label_digits",
        "domain_label_hyphens", "domain_label_vowel_ratio", "domain_label_consonant_run", "suffix_levels",
        "tld_risky", "tld_trusted", "tld_len", "is_ip", "has_port", "has_userinfo", "punycode", "non_ascii",
        "host_hyphens", "host_dots", "host_digits",
        "is_shortener", "is_shared_hosting",
        "brand_in_domain_exact", "brand_in_domain_partial", "brand_in_subdomain", "brand_in_path", "brand_count",
        "near_brand_typosquat",
        "kw_en_host", "kw_en_path", "kw_ar_host", "kw_ar_path", "kw_ar_script",
        "path_depth", "path_tokens", "path_longest_token", "path_ends_slash", "path_double_slash",
        "path_risky_ext", "path_has_tilde", "path_pct_encoded", "query_params", "query_has_url",
        "has_email", "hex_run", "b64_run", "has_fragment", "at_in_path", "dots_in_path",
        "token_count", "token_mean_len",
    ]
    return names


FEATURE_NAMES: tuple[str, ...] = tuple(_feature_names())


def url_features(url: str) -> np.ndarray:
    """Fixed-length float32 vector, ordered as FEATURE_NAMES."""
    p = parse_url(url)
    host = p.host[4:] if p.host.startswith("www.") else p.host
    path_q = unquote(p.path)
    query = unquote(p.query)
    full = p.normalized
    low_path = (path_q + "?" + query).lower()
    label = p.domain.lower()
    f: list[float] = []
    for part in (full, host, path_q, query):
        f += _part_stats(part)

    sub_labels = [s for s in p.subdomain.split(".") if s]
    run = max((len(m) for m in re.findall(r"[bcdfghjklmnpqrstvwxyz]+", label)), default=0)
    letters = sum(c.isalpha() for c in label)
    tld = p.suffix.rsplit(".", 1)[-1] if p.suffix else ""
    is_ip = _is_ip(host)
    f += [
        float(len(sub_labels)), float(len(p.subdomain)), float(len(label)), _entropy(label),
        float(sum(c.isdigit() for c in label)), float(label.count("-")),
        _ratio(sum(c in _VOWELS for c in label), letters), float(run), float(p.suffix.count(".") + 1 if p.suffix else 0),
        float(tld in RISKY_TLDS), float(p.suffix in TRUSTED_SUFFIXES or p.suffix.endswith((".gov", ".gov.ae", ".edu", ".ac.ae"))),
        float(len(tld)), float(is_ip), float(bool(p.port)), float(bool(p.userinfo)),
        float("xn--" in host), float(any(ord(c) > 127 for c in p.host + path_q)),
        float(host.count("-")), float(host.count(".")), float(sum(c.isdigit() for c in host)),
    ]
    f += [float(_on_list(host, p.registered_domain, SHORTENERS)), float(_on_list(host, p.registered_domain, SHARED_HOSTING))]

    dom_hits = _brand_hits(label)
    sub_hits = _brand_hits(p.subdomain)
    path_hits = _brand_hits(low_path)
    exact = label in _BRAND_SET
    f += [
        float(exact), float(bool(dom_hits) and not exact), float(bool(sub_hits - {label})),
        float(bool(path_hits - {label})), float(len(dom_hits | sub_hits | path_hits)), _near_brand(label),
    ]
    f += [
        float(len(_KW_EN_RE.findall(host))), float(len(_KW_EN_RE.findall(low_path))),
        float(len(_KW_AR_RE.findall(host))), float(len(_KW_AR_RE.findall(low_path))),
        float(sum(k in path_q or k in query for k in KEYWORDS_AR_SCRIPT)),
    ]
    segs = [s for s in path_q.split("/") if s]
    ptoks = [t for t in _TOKEN_SPLIT.split(path_q) if t]
    toks = [t for t in _TOKEN_SPLIT.split(full) if t]
    f += [
        float(len(segs)), float(len(ptoks)), float(max((len(t) for t in ptoks), default=0)),
        float(len(path_q) > 1 and path_q.endswith("/")), float("//" in path_q),
        float(path_q.lower().endswith(RISKY_EXTENSIONS) or any(e + "/" in path_q.lower() for e in (".php", ".html"))),
        float("~" in path_q), float("%" in p.path), float(len([q for q in p.query.split("&") if q])),
        float("http" in query.lower() or "www." in query.lower()),
        float(bool(_EMAIL.search(path_q + "?" + query))), float(bool(_HEX_RUN.search(low_path))),
        float(bool(_B64_RUN.search(path_q + query))), float(bool(p.fragment)), float("@" in path_q),
        float(path_q.count(".")), float(len(toks)), _ratio(sum(len(t) for t in toks), len(toks)),
    ]
    return np.asarray(f, dtype=np.float32)


def url_features_matrix(urls) -> np.ndarray:
    return np.vstack([url_features(u) for u in urls]) if len(urls) else np.zeros((0, len(FEATURE_NAMES)), np.float32)


assert len(url_features("https://example.com/a")) == len(FEATURE_NAMES)
