"""Static JavaScript analysis: obfuscation, endpoints, navigation targets and abusive behaviour.

Scripts are hostile input: they are scanned with regular expressions and a tiny constant folder
for string expressions. Nothing is ever executed.
"""

from __future__ import annotations

import base64
import binascii
import itertools
import math
import re
from collections import Counter
from urllib.parse import unquote, urlsplit

from scamshield.intel import lists
from scamshield.schemas import ScriptFinding

from .extract import absolute, host_of, same_site

MAX_SCRIPTS = 12
MAX_THIRD_PARTY_SCRIPTS = 6
MAX_SCRIPT_BYTES = 1_500_000
ANALYSIS_WINDOW = 512_000  # bytes of a script that structural analysis reads
CORPUS_LIMIT = 1_000_000  # bytes of script plus decoded blobs that signatures scan
MAX_SITES = 200  # call sites, navigations and timers examined per script
EXPRESSION_WINDOW = 1000  # characters of one expression handed to the constant folder
MAX_ENDPOINTS = 50
_BEHAVIOUR_SIZE_LIMIT = 250_000  # bundles larger than this bundle frameworks; behaviour heuristics get noisy

# Well-known libraries, analytics, and bot-protection / captcha vendors. Their code is either
# irrelevant or obfuscated on purpose, so analysing it would only add noise.
_SKIP_HOSTS = lists.words("services", "script_vendor_hosts")
_SKIP_PATHS = re.compile(
    r"/cdn-cgi/(?:challenge-platform|scripts|rum)|/_Incapsula_Resource|/akam/|/_sec/|/recaptcha/|/turnstile/|ruxitagent"
    r"|/(?:jquery|bootstrap|popper|lodash|underscore|moment|react(?:-dom)?|vue|angular|gsap|swiper|slick"
    r"|modernizr|polyfill|core-js|axios|chart|three|d3|select2|owl\.carousel|aos|wow|fontawesome)"
    r"(?:[.-][\w.-]{0,100})?\.js(?:$|\?)",
    re.IGNORECASE,
)

# Every pattern below runs on hostile input, so each is linear: quantifiers are bounded or possessive
# and never overlap. String literals are scanned in one left-to-right pass; an unterminated literal is
# consumed to the end of its line (or of the code, for template literals) instead of being retried
# from every later quote, which would be quadratic.
_STRING = re.compile(r"\"(?:[^\"\\\n]|\\.)*+(?:\"|\\?$)|'(?:[^'\\\n]|\\.)*+(?:'|\\?$)|`(?:[^`\\$]|\\.|\$(?!\{))*+(?:`|\\?\Z)", re.M)
_ESCAPE = re.compile(r"\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|.)", re.DOTALL)
_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
_URL = re.compile(r"(?:https?:)?//[a-z0-9.-]{1,253}\.[a-z]{2,24}(?::\d{1,5})?(?:/[^\s\"'`<>\\)]{0,2000})?", re.IGNORECASE)
_NOISE_URL = re.compile(r"//(?:www\.)?(?:w3\.org|schema\.org|reactjs\.org|fb\.me|github\.com/[\w-]+/[\w-]+/(?:issues|blob))", re.I)
_BASE64ISH = re.compile(r"^[A-Za-z0-9+/_-]{16,}={0,2}$")
_ENCODED_BLOB = re.compile(r"^[A-Za-z0-9+/=_%\\-]+$")

_NAVIGATION = re.compile(
    r"\blocation\s*+(?:\.\s*+href\s*+)?=(?!=)|\blocation\s*+\.\s*+(?:replace|assign)\s*+\(|\bwindow\s*+\.\s*+open\s*+\("
)
_CALL_SITES = [
    (re.compile(r"\bfetch\s*+\("), None),
    (re.compile(r"\.open\s*+\(\s*+[\"'](GET|POST|PUT|PATCH)[\"']\s*+,\s*+", re.I), None),
    (re.compile(r"\baxios\s*+\.\s*+(get|post|put|patch)\s*+\("), None),
    (re.compile(r"\$\s*+\.\s*+(post|get|getJSON)\s*+\("), None),
    (re.compile(r"\$\s*+\.\s*+ajax\s*+\(\s*+\{[^}]{0,400}?\burl\s*+:\s*+"), "ajax"),
    (re.compile(r"\bsendBeacon\s*+\("), "POST"),
    (re.compile(r"\bnew\s++WebSocket\s*+\("), "WS"),
    (re.compile(r"\.\s*+action\s*+=(?!=)\s*+"), "FORM"),
]

_STRONG_MARKERS = {
    "hex_identifiers", "string_array_rotation", "eval_packer", "encoded_eval", "jsfuck", "aaencode",
    "jjencode", "anti_debugging",
}


def should_skip(src: str) -> bool:
    host = host_of(src)
    if any(host == h or host.endswith("." + h) for h in _SKIP_HOSTS):
        return True
    return bool(_SKIP_PATHS.search(urlsplit(src).path + ("?" if urlsplit(src).query else "")))


def select_scripts(srcs: list[str], page_url: str) -> tuple[list[tuple[str, bool]], list[str]]:
    """Split script URLs into (to_fetch [(url, first_party)], skipped); first-party scripts first."""
    page_host = host_of(page_url)
    fetch, skipped = [], []
    for src in dict.fromkeys(srcs):
        (skipped if should_skip(src) else fetch).append(src)
    first = [(s, True) for s in fetch if same_site(host_of(s), page_host)]
    third = [(s, False) for s in fetch if not same_site(host_of(s), page_host)]
    chosen = (first + third[:MAX_THIRD_PARTY_SCRIPTS])[:MAX_SCRIPTS]
    picked = {s for s, _ in chosen}
    return chosen, skipped + [s for s in fetch if s not in picked]


def js_unescape(body: str) -> str:
    def repl(m: re.Match) -> str:
        esc = m.group(1)
        if esc.startswith("u{"):
            return chr(min(int(esc[2:-1], 16), 0x10FFFF))
        if esc[0] in "ux" and len(esc) > 1:
            return chr(int(esc[1:], 16))
        if esc[0] in "01234567" and esc != "0":
            return chr(int(esc, 8))
        return _SIMPLE_ESCAPES.get(esc, esc)

    return _ESCAPE.sub(repl, body)


def string_literals(code: str) -> list[str]:
    out = []
    for m in _STRING.finditer(code):
        text = m.group(0)
        if len(text) >= 2 and text[-1] == text[0]:
            out.append(js_unescape(text[1:-1]))
    return out


def entropy(s: str) -> float:
    counts = Counter(s)
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in counts.values())


def _b64decode(s: str) -> str | None:
    try:
        raw = base64.b64decode(s + "=" * (-len(s) % 4), altchars=b"-_" if ("-" in s or "_" in s) else None, validate=True)
    except (binascii.Error, ValueError):
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    printable = sum(ch.isprintable() or ch in "\r\n\t" for ch in text)
    return text if text and printable / len(text) > 0.95 else None


# --- constant folding of string expressions -------------------------------------------------

_TOKEN = re.compile(
    r"\s*+(?:(?P<str>\"(?:[^\"\\\n]|\\.)*+\"|'(?:[^'\\\n]|\\.)*+'|`(?:[^`\\$]|\\.|\$(?!\{))*+`)"
    r"|(?P<num>0x[0-9a-fA-F]+|\d+(?:\.\d+)?)"
    r"|(?P<name>[A-Za-z_$][\w$]*(?:\s*+\.\s*+[A-Za-z_$][\w$]*)*)"
    r"|(?P<punct>[()\[\],+.]))"
)
_DECODERS = {
    "atob": lambda s: _b64decode(s) if isinstance(s, str) else None,
    "window.atob": lambda s: _b64decode(s) if isinstance(s, str) else None,
    "decodeURIComponent": lambda s: unquote(s) if isinstance(s, str) else None,
    "decodeURI": lambda s: unquote(s) if isinstance(s, str) else None,
    "unescape": lambda s: unquote(s) if isinstance(s, str) else None,
    "String": lambda s: s if isinstance(s, str) else None,
}


class _Unresolvable(Exception):
    pass


class _Folder:
    """Evaluate a JS expression made of string literals, `+`, known decoders and simple string methods."""

    def __init__(self, expr: str, env: dict[str, str], page_url: str, depth: int = 0):
        self.tokens = []
        pos = 0
        while pos < len(expr):
            m = _TOKEN.match(expr, pos)
            if not m or m.end() == pos:
                break
            kind = m.lastgroup
            self.tokens.append((kind, m.group(kind)))
            pos = m.end()
        self.i = 0
        self.env = env
        self.page_url = page_url
        self.depth = depth

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def take(self, value: str | None = None):
        tok = self.peek()
        if tok[0] is None or (value is not None and tok[1] != value):
            raise _Unresolvable
        self.i += 1
        return tok

    def expr(self):
        value = self.term()
        while self.peek() == ("punct", "+"):
            self.take()
            right = self.term()
            if isinstance(value, list) or isinstance(right, list):
                raise _Unresolvable
            value = f"{value}{right}"
        return value

    def args(self) -> list:
        self.take("(")
        out = []
        while self.peek() != ("punct", ")"):
            out.append(self.expr())
            if self.peek() == ("punct", ","):
                self.take()
        self.take(")")
        return out

    def term(self):
        kind, tok = self.take()
        if kind == "str":
            value = js_unescape(tok[1:-1])
        elif kind == "num":
            value = int(tok, 16) if tok.startswith("0x") else float(tok) if "." in tok else int(tok)
        elif kind == "punct" and tok == "(":
            value = self.expr()
            self.take(")")
        elif kind == "punct" and tok == "[":
            value = []
            while self.peek() != ("punct", "]"):
                value.append(self.expr())
                if self.peek() == ("punct", ","):
                    self.take()
            self.take("]")
        elif kind == "name":
            value = self.name(re.sub(r"\s++", "", tok))
        else:
            raise _Unresolvable
        return self.postfix(value)

    def name(self, name: str):
        if name in ("String.fromCharCode", "window.String.fromCharCode"):
            return "".join(chr(int(c)) for c in self.args() if isinstance(c, (int, float)) and 0 <= c < 0x110000)
        if name in _DECODERS and self.peek() == ("punct", "("):
            args = self.args()
            result = _DECODERS[name](args[0]) if args else None
            if result is None:
                raise _Unresolvable
            return result
        parts = urlsplit(self.page_url)
        location = {
            "origin": f"{parts.scheme}://{parts.netloc}", "host": parts.netloc,
            "hostname": parts.hostname or "", "protocol": f"{parts.scheme}:", "pathname": parts.path or "/",
        }
        for prefix in ("window.location.", "document.location.", "location."):
            if name.startswith(prefix) and name[len(prefix) :] in location:
                return location[name[len(prefix) :]]
        if self.depth < 4 and (initialiser := self.env.get(name)) is not None:
            resolved = fold(initialiser, self.env, self.page_url, self.depth + 1)
            if resolved is not None:
                return resolved
        raise _Unresolvable

    def postfix(self, value):
        while self.peek() == ("punct", "."):
            self.take()
            kind, method = self.take()
            if kind != "name":
                raise _Unresolvable
            args = self.args() if self.peek() == ("punct", "(") else None
            if method == "split" and isinstance(value, str) and args == [""]:
                value = list(value)
            elif method == "reverse" and isinstance(value, list):
                value = value[::-1]
            elif method == "join" and isinstance(value, list):
                value = (args[0] if args else ",").join(str(v) for v in value)
            elif method in ("toString", "trim") and isinstance(value, str):
                value = value.strip() if method == "trim" else value
            elif method == "concat" and isinstance(value, str) and args is not None:
                value = value + "".join(str(a) for a in args)
            elif method == "replace" and isinstance(value, str) and args and len(args) == 2:
                value = value.replace(str(args[0]), str(args[1]), 1)
            else:
                raise _Unresolvable
        return value


def fold(expr: str, env: dict[str, str] | _Declarations | None = None, page_url: str = "", depth: int = 0) -> str | None:
    """Statically resolve a string expression, or None when it depends on runtime values."""
    folder = _Folder(expr, env or {}, page_url, depth)
    try:
        value = folder.expr()
    except (_Unresolvable, ValueError, OverflowError, RecursionError):
        return None
    if folder.i != len(folder.tokens) or not isinstance(value, str):
        return None
    return value


def _expression_at(code: str, start: int, closer: str | None = None) -> str:
    """Text of the expression starting at `start`, up to a top-level `;`, newline, `,`/`)` or `}`."""
    depth = 0
    i = start
    quote = None
    limit = min(len(code), start + EXPRESSION_WINDOW)
    while i < limit:
        ch = code[i]
        if quote:
            if ch == "\\":
                i += 1
            elif ch == quote:
                quote = None
        elif ch in "\"'`":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and (ch in ";\n" or (closer and ch == ",")):
            break
        i += 1
    return code[start:i].strip()


class _Declarations:
    """`var/let/const` initialisers, looked up only for names the folder actually meets (capped)."""

    def __init__(self, code: str):
        self.code = code
        self.found: dict[str, str | None] = {}

    def get(self, name: str) -> str | None:
        if name not in self.found:
            if len(self.found) >= MAX_SITES:
                return None
            m = re.search(r"\b(?:var|let|const)\s++" + re.escape(name) + r"\s*+=(?!=)\s*+", self.code)
            self.found[name] = _expression_at(self.code, m.end(), closer=",") if m else None
        return self.found[name]


def navigation_targets(code: str, page_url: str, env: _Declarations | None = None) -> list[str]:
    """Absolute URLs the script navigates to via `location = ...`, `location.replace(...)`, `window.open(...)`.

    Every branch counts: a target behind a user-agent or timer gate is still a target.
    """
    if "location" not in code and "open" not in code:
        return []
    env = _Declarations(code) if env is None else env
    targets = []
    for m in itertools.islice(_NAVIGATION.finditer(code), MAX_SITES):
        value = fold(_expression_at(code, m.end(), closer=","), env, page_url)
        url = absolute(page_url, value) if value else None
        if url and url not in targets:
            targets.append(url)
    return targets


# --- behaviour --------------------------------------------------------------------------------

# (label, cheap lowercase needles that must occur first, pattern). Needles keep big bundles fast.
# Checked in every script: these have no business in a legitimate page at any size.
_SIGNATURES: list[tuple[str, tuple[str, ...], re.Pattern]] = [
    ("telegram_bot_api", ("telegram",), re.compile(r"api\.telegram\.org/bot|\btelegram\.org/bot", re.I)),
    ("discord_webhook", ("webhooks",), re.compile(r"discord(?:app)?\.com/api/webhooks", re.I)),
    ("webhook_exfiltration", ("webhook", "hooks.slack", "macros", "formspree", "getform", "formsubmit", "submit-form", "web3forms", "pipedream", "requestbin", "ngrok"), re.compile(
        r"webhook\.site|hooks\.slack\.com|script\.google\.com/macros|formspree\.io|getform\.io|formsubmit\.co"
        r"|pipedream\.net|requestbin|\.ngrok(?:-free)?\.(?:io|app)|submit-form\.com|api\.web3forms\.com", re.I)),
    ("wallet_drainer", ("approval", "allowance", "signall", "signtyped", "permit2", "seaport", "0x095ea7b3", "0xa22cb465", "0x23b872dd", "transferfrom"), re.compile(
        r"setApprovalForAll|increaseAllowance|signAllTransactions|eth_signTypedData|\bpermit2\b|seaport"
        r"|0x095ea7b3|0xa22cb465|0x23b872dd|transferFrom\s*+\(", re.I)),
    ("disable_right_click", ("contextmenu",), re.compile(
        r"contextmenu[\"']?\s*+,\s*+(?:function\s*+\(\s*+\w*\s*+\)|\(?\w*\)?\s*+=>)\s*+\{?\s*+(?:\w{1,40}\.)?preventDefault"
        r"|oncontextmenu\s*+=\s*+[\"']?\s*+(?:return\s++false|function)", re.I)),
    ("devtools_block", ("123", "f12", "shiftkey", "innerwidth", "devtools"), re.compile(
        r"keyCode\s*+===?\s*+123|\.key\s*+===?\s*+[\"']F12[\"']|ctrlKey\s*+&&\s*+\w+\.shiftKey\s*+&&[^;]{0,60}(?:73|74|67)"
        r"|outerWidth\s*+-\s*+\w+\.innerWidth\s*+>|devtools-?detect|devtoolschange", re.I)),
    ("fullscreen_lock", ("keyboard.lock", "requestfullscreen"), re.compile(r"keyboard\.lock\s*+\(|requestFullscreen[\s\S]{0,400}?onkeydown", re.I)),
    ("clipboard_read", ("clipboard", "paste"), re.compile(r"clipboard\.readText|clipboard\.read\s*+\(|execCommand\s*+\(\s*+[\"']paste", re.I)),
    ("clipboard_hijack", ("clipboarddata",), re.compile(r"[\"']copy[\"'][\s\S]{0,200}?clipboardData\.setData", re.I)),
]

# Client-side cloaking gates (CrawlPhish's taxonomy): a check whose outcome redirects or swaps content.
# Navigation, except to app stores (the usual reason a legitimate site sniffs the user agent or runs a
# timed "open in app" banner), whether written as a literal or as a variable such as `storeUrl`.
_NAVIGATE = (
    r"(?:location\s*+(?:\.\s*+href\s*+)?=(?!=)|location\s*+\.\s*+(?:replace|assign)\s*+\()\s*+"
    r"(?![\"'`](?:market:|intent:|itms|https?://(?:apps\.apple\.com|play\.google\.com)))"
    r"(?![\w.$]*(?:[sS]tore|[mM]arket|[aA]pp(?:[A-Z_]|[lL]ink|[uU]rl))[\w.$]*\s*+[;)\n}])"
)
# What a cloaking gate guards: a redirect, or a swap to markup the script carries itself. Lazy loaders,
# banners and menus also run behind checks and timers, but inject fetched content or toggle visibility.
_SWAP = _NAVIGATE + r"|(?:innerHTML\s*+=|outerHTML\s*+=|document\.write\s*+\(|\.html\s*+\(|insertAdjacentHTML\s*+\([^,]{0,40},)\s*+[\"'`]"
_SWAP_RE = re.compile(_SWAP)


def _if_gate(condition: str) -> re.Pattern:
    """`if (<condition mentioning X>)` followed within 300 characters (either branch) by a redirect or swap."""
    return re.compile(
        r"\bif\s*+\((?=[^{};]{0,250}" + condition + r")[^{};]{0,250}\)[\s\S]{0,300}?(?:" + _SWAP + ")"
    )


# Checked only in scripts below _BEHAVIOUR_SIZE_LIMIT: framework bundles legitimately contain these.
_SMALL_SCRIPT_SIGNATURES: list[tuple[str, tuple[str, ...], re.Pattern]] = [
    ("cloak.user_agent_gate", ("navigator",), _if_gate(r"navigator\s*+\.\s*+(?:userAgent|platform|vendor|userAgentData|webdriver)")),
    ("cloak.referrer_gate", ("referrer",), _if_gate(r"document\s*+\.\s*+referrer")),
    ("cloak.cookie_gate", ("cookieenabled",), _if_gate(r"navigator\s*+\.\s*+cookieEnabled")),
    ("cloak.random_gate", ("math.random",), _if_gate(r"Math\.random\(\)\s*+[<>]")),
    ("cloak.mouse_gate", ("mouse", "touchstart"), re.compile(
        r"(?:document|window|body)\s*+\.\s*+(?:addEventListener\s*+\(\s*+[\"'](?:mousemove|mouseover|touchstart)[\"']|onmousemove\s*+=)"
        r"[\s\S]{0,300}?(?:" + _SWAP + ")")),
    ("cloak.popup_gate", ("alert", "notification"), re.compile(
        r"(?:Notification\.requestPermission[\s\S]{0,300}?|\balert\s*+\([^;]{0,200}\)\s*+;?\s*+)(?:" + _SWAP + ")")),
    # Automation detection on its own is common in analytics; only a gate it guards counts as cloaking.
    ("bot_detection", ("webdriver", "headless", "phantom", "nightmare", "automation", "$cdc_", "crawl", "spider", "googlebot"), re.compile(
        r"navigator\.webdriver|HeadlessChrome|callPhantom|_phantom|__nightmare|domAutomation|\$cdc_"
        r"|/bot\|crawl|crawler\|spider|googlebot", re.I)),
    ("ip_geolocation_lookup", ("ipapi", "ip-api", "ipinfo", "ipify", "geoplugin", "ipwho", "ipgeolocation", "ip-lookup"), re.compile(
        r"ipapi\.co|ip-api\.com|ipinfo\.io|api\.ipify\.org|geoplugin\.net|ipwho\.is|ipgeolocation\.io|extreme-ip-lookup", re.I)),
    ("back_button_trap", ("pushstate",), re.compile(r"history\.pushState[\s\S]{0,300}?(?:onpopstate|['\"]popstate)", re.I)),
]
_TIMER = re.compile(r"\bset(?:Timeout|Interval)\s*+\(")
_TIMER_GATE_MS = 3000
_KEY_LISTENER = re.compile(r"addEventListener\s*+\(\s*+[\"']key(?:down|up|press)[\"']|\bonkey(?:down|up|press)\s*+=", re.I)
# Keystrokes accumulated into a buffer, rather than merely inspected for shortcuts.
_KEY_BUFFER = re.compile(r"\+=\s*+\w+\.(?:key|char)\b|push\(\s*+\w+\.key\b|fromCharCode\(\s*+\w+\.(?:keyCode|which|charCode)")
_NETWORK_SEND = re.compile(r"\bfetch\s*+\(|XMLHttpRequest|sendBeacon|new\s++Image\s*+\(\s*+\)\s*+\.src|\$\.(?:post|ajax)", re.I)
_WALLET_CONNECT = re.compile(r"eth_requestAccounts|window\.ethereum|solana\.connect|tronWeb", re.I)
_POST_HINT = re.compile(r"(?:method|type)\s*+:\s*+[\"']post[\"']", re.I)
_FIELD_VALUE_READ = re.compile(
    r"(?:getElementById|querySelector|getElementsByName)\s*+\([^)]{0,80}(?:pass|pwd|card|cvv|otp|pin|كلمة)[^)]{0,40}\)"
    r"(?:\[0\])?\s*+\.value", re.I)


def _matches(table, code: str, lowered: str) -> list[str]:
    return [label for label, needles, pattern in table if any(n in lowered for n in needles) and pattern.search(code)]


def _timer_gate(code: str) -> bool:
    for m in itertools.islice(_TIMER.finditer(code), MAX_SITES):
        call = _expression_at(code, m.end())
        delay = re.search(r",\s*+(\d+)\s*+$", call)
        if delay and int(delay.group(1)) >= _TIMER_GATE_MS and _SWAP_RE.search(call):
            return True
    return False


def html_fragments(code: str) -> str:
    """HTML that a small script builds from string literals (including base64 blobs), when it injects a form."""
    if len(code) > _BEHAVIOUR_SIZE_LIMIT:
        return ""
    literals = string_literals(code)
    literals += [d for s in literals if _BASE64ISH.match(s) and (d := _b64decode(s))]
    pieces = [s for s in literals if "<" in s and ">" in s]
    joined = "".join(pieces)
    return joined if re.search(r"<(?:form|input)\b", joined, re.I) else ""


def _obfuscation(code: str, literals: list[str]) -> list[str]:
    markers = []
    if len(set(re.findall(r"\b_0x[0-9a-f]{4,6}\b", code))) >= 5:
        markers.append("hex_identifiers")
    if re.search(r"\[[\"']push[\"']\]\(\s*+\w+\[[\"']shift[\"']\]\(\)\s*+\)|\.push\(\s*+\w+\.shift\(\)\s*+\)", code) or re.search(
        r"parseInt\(\s*+\w+\(\s*+0x[0-9a-f]+\s*+\)\s*+\)\s*+/\s*+0x", code
    ):
        markers.append("string_array_rotation")
    if re.search(r"eval\s*+\(\s*+function\s*+\(\s*+p\s*+,\s*+a\s*+,\s*+c\s*+,\s*+k\s*+,\s*+e\s*+,\s*+[dr]\s*+\)", code):
        markers.append("eval_packer")
    if re.search(r"\b(?:eval|Function|setTimeout|setInterval)\s*+\(\s*+(?:window\.)?(?:atob|unescape|decodeURIComponent|String\.fromCharCode)\s*+\(", code):
        markers.append("encoded_eval")
    if code.count("![]") >= 40 and sum(code.count(c) for c in "[]()!+") / max(len(code), 1) > 0.6:
        markers.append("jsfuck")
    if "ﾟωﾟ" in code or "ﾟДﾟ" in code or "ﾟΘﾟ" in code:
        markers.append("aaencode")
    if re.search(r"\$=\{___:\+\+\$", code) or re.search(r"\$\.\$\$\$\$", code):
        markers.append("jjencode")
    if re.search(
        r"[\"']debu[\"']\s*+\+\s*+[\"']gger[\"']|constructor\s*+\(\s*+[\"']debugger[\"']\)"
        r"|setInterval\s*+\(\s*+(?:function\s*+\(\s*+\)|\(\s*+\)\s*+=>)\s*+\{[^}]{0,200}\bdebugger\b"
        r"|while\s*+\(\s*+(?:true|!!\[\]|1)\s*+\)\s*+\{[^}]{0,100}\bdebugger\b",
        code,
    ):
        markers.append("anti_debugging")
    if re.search(r"\b(?:new\s++Function|eval)\s*+\(", code):
        markers.append("dynamic_code")
    if len(re.findall(r"\batob\s*+\(", code)) >= 3 or re.search(r"atob\s*+\(\s*+atob\s*+\(", code):
        markers.append("atob_chain")
    if re.search(r"fromCharCode\s*+\(\s*+(?:(?:0x[0-9a-f]+|\d+)\s*+[,)]\s*+){8,}", code, re.I):
        markers.append("char_code_strings")
    if re.search(r"unescape\s*+\(\s*+[\"'](?:%[0-9a-f]{2}|%u[0-9a-f]{4}){8,}", code, re.I):
        markers.append("escaped_payload")
    hex_escapes = len(re.findall(r"\\x[0-9a-f]{2}", code, re.I))
    if hex_escapes >= 50 and hex_escapes * 4 / max(len(code), 1) > 0.05:
        markers.append("hex_escaped_strings")
    if any(len(s) >= 200 and _ENCODED_BLOB.match(s) and entropy(s) > 5.0 for s in literals):
        markers.append("high_entropy_literal")
    return markers


def _call_targets(code: str, env: dict[str, str], page_url: str) -> list[tuple[str, str]]:
    """(method, absolute url) for network calls whose target URL is statically known."""
    calls = []
    for pattern, fixed_method in _CALL_SITES:
        for m in itertools.islice(pattern.finditer(code), MAX_SITES):
            url = fold(_expression_at(code, m.end(), closer=","), env, page_url)
            url = absolute(page_url, url) if url else None
            if not url:
                continue
            if fixed_method in ("POST", "WS", "FORM"):
                method = fixed_method
            elif m.groups() and m.group(1):
                method = m.group(1).upper()
            else:
                method = "POST" if _POST_HINT.search(code, m.end(), m.end() + 400) else "GET"
            if fixed_method == "ajax":
                method = "POST" if _POST_HINT.search(code, m.start(), m.end() + 400) else "GET"
            calls.append((method, url))
    return calls


def analyse_script(code: str, *, src: str | None, page_url: str, first_party: bool = True, size: int | None = None) -> ScriptFinding:
    size = len(code) if size is None else size
    full = code
    # Structural analysis of huge bundles looks at their head only; exfiltration signatures scan all of it.
    code = code[:ANALYSIS_WINDOW]
    literals = string_literals(code)
    decoded = [d for s in literals if _BASE64ISH.match(s) and (d := _b64decode(s))]
    corpus = "\n".join([full, *decoded])[:CORPUS_LIMIT]
    env = _Declarations(code)
    page_host = host_of(page_url)

    markers = _obfuscation(code, literals)
    strong = [m for m in markers if m in _STRONG_MARKERS]
    finding = ScriptFinding(
        src=src,
        first_party=first_party,
        size=size,
        obfuscated=bool(strong) or len(markers) >= 2 + ("dynamic_code" in markers),
        obfuscation_markers=markers,
    )

    calls = _call_targets(code, env, page_url)
    endpoints = [url for _, url in calls]
    for text in [*literals, *decoded]:
        for m in _URL.finditer(text):
            if not _NOISE_URL.search(m.group(0)) and (url := absolute(page_url, m.group(0))):
                endpoints.append(url)
    finding.endpoints = list(dict.fromkeys(endpoints))[:MAX_ENDPOINTS]
    finding.redirects = navigation_targets(code, page_url, env)

    lowered = corpus.lower()
    suspicious = _matches(_SIGNATURES, corpus, lowered)
    for method, url in calls:
        host = host_of(url)
        if method in ("POST", "FORM") and host and not same_site(host, page_host):
            label = "form_action_rewrite" if method == "FORM" else "posts_to_external_host"
            suspicious.append(f"{label}:{host}")
    if finding.size <= _BEHAVIOUR_SIZE_LIMIT:
        suspicious += _matches(_SMALL_SCRIPT_SIGNATURES, corpus, lowered)
        if "settimeout" in lowered or "setinterval" in lowered:
            if _timer_gate(code):
                suspicious.append("cloak.timer_gate")
        sends = _NETWORK_SEND.search(code)
        if sends and _KEY_LISTENER.search(code) and _KEY_BUFFER.search(code):
            suspicious.append("keystroke_capture")
        if sends and _FIELD_VALUE_READ.search(code):
            suspicious.append("reads_credential_fields")
    if "wallet_drainer" not in suspicious and _WALLET_CONNECT.search(corpus):
        suspicious.append("wallet_connect")
    finding.suspicious_calls = list(dict.fromkeys(suspicious))
    return finding


def data_endpoints(findings: list[ScriptFinding], page_url: str, limit: int = 4) -> list[str]:
    """Same-site URLs named in first-party scripts that plausibly return page content as data."""
    page_host = host_of(page_url)
    candidates = []
    for finding in findings:
        if not finding.first_party:
            continue
        for url in finding.endpoints:
            path = urlsplit(url).path.lower()
            if not same_site(host_of(url), page_host) or url.split("#")[0] == page_url:
                continue
            if re.search(r"\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|mp4|mp3)$", path):
                continue
            score = bool(re.search(r"\.json$|/api/|/data|/content|/v\d+/|/wp-json/", path))
            candidates.append((not score, url))
    return [url for _, url in sorted(dict.fromkeys(candidates))][:limit]
