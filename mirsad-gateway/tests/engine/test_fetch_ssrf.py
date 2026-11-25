"""SSRF guard of the fetcher: alternative address spellings, redirects and sub-resources to private hosts.

The hostile site is served on 127.0.0.1, opened through SCAMSHIELD_ALLOW_NETWORKS exactly as the demo network
is; a canary on 127.0.0.2 stands for every private service (engine API, model servers, Docker networks) and
must never receive a request.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from scamshield.engine.fetch import check_target, fetch_page


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/",
    "http://0.0.0.0/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://100.100.100.100/",
    "http://100.64.0.1/", "http://[fd7a:115c:a1e0::1]/", "http://10.0.0.1/", "http://172.17.0.1:8001/v1/models",
    "http://192.168.1.1/", "http://localhost:8000/v1/hosts", "http://engine.localhost/",
    "file:///etc/passwd", "gopher://127.0.0.1:6379/_INFO", "ftp://example.com/", "http:///nohost",
])
async def test_private_and_non_web_targets_are_refused(url, monkeypatch):
    monkeypatch.delenv("SCAMSHIELD_ALLOW_PRIVATE", raising=False)
    monkeypatch.setenv("SCAMSHIELD_ALLOW_NETWORKS", "172.30.77.10/32")
    error, _ = await check_target(url, timeout=2)
    assert error is not None and (error.startswith("refused") or error.startswith("dns"))
    snap = await fetch_page(url)
    assert snap.error and not snap.html


class _Canary(BaseHTTPRequestHandler):
    hits: list[str] = []

    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        if self.path.startswith("/leak"):  # other local tools probe new listeners at "/"; only the page's requests count
            _Canary.hits.append(self.path)
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html><title>internal</title><form><input type=password></form></html>")


def _site(canary: str) -> type[BaseHTTPRequestHandler]:
    page = (f'<html><head><title>Pay</title><link rel="icon" href="{canary}/leak/favicon.ico">'
            f'<script src="{canary}/leak/app.js"></script></head><body><p>Pay your fine</p>'
            f'<script>fetch("{canary}/leak/api/data.json");location.href="{canary}/leak/js-redirect"</script>'
            f'<meta http-equiv="refresh" content="0;url={canary}/leak/meta"></body></html>').encode()

    class Site(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def do_GET(self) -> None:
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("location", f"{canary}/leak/after-redirect")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

    return Site


@pytest.fixture
def hostile_site(monkeypatch):
    canary = ThreadingHTTPServer(("127.0.0.2", 0), _Canary)
    canary_url = f"http://127.0.0.2:{canary.server_port}"
    site = ThreadingHTTPServer(("127.0.0.1", 0), _site(canary_url))
    for server in (canary, site):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.delenv("SCAMSHIELD_ALLOW_PRIVATE", raising=False)
    monkeypatch.setenv("SCAMSHIELD_ALLOW_NETWORKS", "127.0.0.1/32")
    _Canary.hits.clear()
    yield f"http://127.0.0.1:{site.server_port}"
    for server in (canary, site):
        server.shutdown()


async def test_redirect_to_private_address_is_refused(hostile_site):
    snap = await fetch_page(f"{hostile_site}/redirect")
    assert _Canary.hits == []
    assert snap.error and "refused" in snap.error


async def test_sub_resources_and_client_redirects_never_reach_private_hosts(hostile_site):
    snap = await fetch_page(f"{hostile_site}/")
    assert _Canary.hits == []
    assert snap.error and "refused" in snap.error  # the client-side redirect ends on the private host
