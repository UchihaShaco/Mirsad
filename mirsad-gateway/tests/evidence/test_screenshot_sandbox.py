"""The evidence browser is the only place a hostile page runs: it must not reach private addresses or files."""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from scamshield.evidence import screenshot


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "ftp://example.com/",
    "http://127.0.0.1:8000/v1/hosts", "http://localhost:8001/v1/models", "http://host.docker.internal:8003/",
    "http://169.254.169.254/latest/meta-data/", "http://100.100.100.100/", "http://[::1]/", "http://2130706433/",
])
async def test_private_and_local_targets_are_refused(url, monkeypatch):
    monkeypatch.delenv("SCAMSHIELD_ALLOW_PRIVATE", raising=False)
    monkeypatch.setenv("SCAMSHIELD_ALLOW_NETWORKS", "172.30.77.10/32")
    assert await screenshot.refusal(url)


@pytest.mark.parametrize("url", ["data:image/png;base64,AAAA", "about:blank", "blob:https://example.com/1"])
async def test_in_memory_urls_are_allowed(url):
    assert await screenshot.refusal(url) is None


class _Canary(BaseHTTPRequestHandler):
    hits: list[str] = []

    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        if self.path.startswith("/leak"):  # other local tools probe new listeners at "/"; only the page's requests count
            _Canary.hits.append(self.path)
        self.send_response(200)
        self.end_headers()

    do_POST = do_GET


def _hostile(canary: str) -> type[BaseHTTPRequestHandler]:
    page = (f'<html><head><title>Pay</title><link rel="icon" href="{canary}/leak/icon"></head><body><h1>Pay your fine</h1>'
            f'<img src="{canary}/leak/img"><iframe src="{canary}/leak/frame"></iframe><iframe src="file:///etc/passwd"></iframe>'
            f'<script>fetch("{canary}/leak/fetch", {{method: "POST", mode: "no-cors", body: "url\\nhttp://x"}});'
            f'navigator.sendBeacon("{canary}/leak/beacon", "x"); new WebSocket("{canary.replace("http", "ws")}/leak/ws");'
            f'new Image().src = "{canary}/leak/js-img";</script></body></html>').encode()

    class Site(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

    return Site


async def test_hostile_page_cannot_reach_private_services(monkeypatch):
    pytest.importorskip("playwright")
    canary = ThreadingHTTPServer(("127.0.0.2", 0), _Canary)
    site = ThreadingHTTPServer(("127.0.0.1", 0), _hostile(f"http://127.0.0.2:{canary.server_port}"))
    for server in (canary, site):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.delenv("SCAMSHIELD_ALLOW_PRIVATE", raising=False)
    monkeypatch.setenv("SCAMSHIELD_ALLOW_NETWORKS", "127.0.0.1/32")
    _Canary.hits.clear()
    try:
        result = await screenshot.capture(f"http://127.0.0.1:{site.server_port}/")
    finally:
        for server in (canary, site):
            server.shutdown()
    if result.png is None and result.error and "Executable doesn't exist" in result.error:
        pytest.skip("headless Chromium is not installed")
    assert result.png and result.title == "Pay", result.error
    assert _Canary.hits == []
