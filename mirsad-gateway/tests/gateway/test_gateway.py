"""End-to-end tests of the gateway addon through its explicit-proxy listener, against the mock engine."""

from __future__ import annotations

import json
import re
import socket
import ssl
import time

import dns.exception
import dns.message
import dns.query
import dns.rdatatype
import httpx
import pytest

BROWSER = {"Accept": "text/html,application/xhtml+xml", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}


def tunnel(gateway, host: str) -> ssl.SSLSocket:
    """CONNECT through the gateway and complete a TLS handshake with the far end, like a phone app would."""
    raw = socket.create_connection(("127.0.0.1", gateway.port), timeout=10)
    raw.sendall(f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode())
    reply = raw.recv(4096)
    assert reply.startswith(b"HTTP/1.1 200"), reply
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context.wrap_socket(raw, server_hostname=host)


def get_over(sock: ssl.SSLSocket, host: str) -> bytes:
    sock.sendall(f"GET / HTTP/1.1\r\nHost: {host}\r\n\r\n".encode())
    data = b""
    while b"</html>" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            break
        data += chunk
    return data


def refused(gateway, host: str) -> bool:
    try:
        tunnel(gateway, host).close()
    except (ssl.SSLError, ConnectionError, OSError):
        return True
    return False


def decisions(gateway, host: str) -> list[dict]:
    lines = [json.loads(m) for m in re.findall(r"(\{\"event\": \"decision\".*\})", gateway.log())]
    return [d for d in lines if d["host"] == host]


def status(gateway, host: str) -> dict:
    with gateway.client() as c:
        return c.get(f"http://{host}/.well-known/scamshield/status").json()


def test_allowed_site_loads_over_http(gateway):
    with gateway.client() as c:
        r = c.get("http://allow-shop.test/catalogue", headers=BROWSER)
    assert r.status_code == 200
    assert "real site allow-shop.test/catalogue" in r.text


def test_allowed_https_site_passes_through_untouched(gateway, sites):
    sock = tunnel(gateway, "allow-bank.test")
    assert sock.getpeercert(binary_form=True) == sites["cert_der"], "the gateway must not intercept allowed TLS"
    assert b"real site allow-bank.test/" in get_over(sock, "allow-bank.test")
    sock.close()
    assert decisions(gateway, "allow-bank.test")[0]["decision"] == "allow"


def test_blocked_site_shows_bilingual_block_page_over_http(gateway):
    with gateway.client() as c:
        r = c.get("http://block-fines.test/pay", headers=BROWSER)
    assert r.status_code == 403
    assert ">92<" in r.text
    assert "Pretends to be Abu Dhabi Police fines payment" in r.text
    assert "ينتحل صفة بوابة دفع مخالفات شرطة أبوظبي" in r.text
    assert 'dir="rtl"' in r.text
    assert re.search(r"SS-[0-9A-F]{8}", r.text)
    assert "Valid certificate" not in r.text, "only reasons that add risk are shown"


def test_blocked_subresource_gets_plain_refusal(gateway):
    with gateway.client() as c:
        r = c.get("http://block-cdn.test/app.js")
    assert r.status_code == 403
    assert r.text.startswith("Blocked by Mirsad: block-cdn.test")


def test_blocked_https_site_is_reset_at_once(gateway):
    started = time.monotonic()
    with pytest.raises(ConnectionResetError):
        tunnel(gateway, "block-wallet.test").close()
    assert time.monotonic() - started < 2, "the browser must get its error at once, not after a timeout"
    record = decisions(gateway, "block-wallet.test")[0]
    assert record["decision"] == "block" and record["via"] == "tls"


def test_unknown_https_site_is_held_then_released(gateway):
    started = time.monotonic()
    sock = tunnel(gateway, "slow-news.test")
    held = time.monotonic() - started
    assert b"real site slow-news.test/" in get_over(sock, "slow-news.test")
    sock.close()
    assert held >= 1.8, f"connection was not held ({held:.2f}s)"
    record = decisions(gateway, "slow-news.test")[0]
    assert record["source"] == "engine" and record["wait_ms"] >= 1800


def test_unknown_page_gets_checking_page_then_site(gateway):
    with gateway.client() as c:
        started = time.monotonic()
        r = c.get("http://slow-portal.test/login", headers=BROWSER)
        assert time.monotonic() - started < 1.6, "navigation is held only for the short grace period"
        assert r.status_code == 200 and "Checking this site for you" in r.text
        assert "نتحقق من هذا الموقع من أجلك" in r.text
        deadline = time.monotonic() + 6
        while status(gateway, "slow-portal.test")["state"] == "pending" and time.monotonic() < deadline:
            time.sleep(0.3)
        assert status(gateway, "slow-portal.test")["state"] == "allow"
        r = c.get("http://slow-portal.test/login", headers=BROWSER)
    assert "real site slow-portal.test/login" in r.text


def test_warning_interstitial_and_continue_anyway(gateway):
    with gateway.client() as c:
        r = c.get("http://warn-deals.test/offer", headers=BROWSER)
        assert r.status_code == 200 and "Continue anyway" in r.text and ">52<" in r.text
        proceed = re.search(r'href="(/\.well-known/scamshield/proceed\?to=[^"]+)"', r.text).group(1)
        r = c.get(f"http://warn-deals.test{proceed}")
        assert r.status_code == 302 and r.headers["location"] == "http://warn-deals.test/offer"
        r = c.get("http://warn-deals.test/offer", headers=BROWSER)
    assert "real site warn-deals.test/offer" in r.text


def test_revoked_site_is_cut_off(gateway):
    sock = tunnel(gateway, "revoke-shop.test")
    assert b"real site" in get_over(sock, "revoke-shop.test")
    sock.settimeout(5)
    try:
        data = sock.recv(1)
    except (ssl.SSLError, ConnectionError):
        data = b""
    assert data == b"", "the open connection must be closed when the engine revokes the allow"
    assert refused(gateway, "revoke-shop.test")
    assert any(d["source"] == "event:verdict.revoked" for d in decisions(gateway, "revoke-shop.test"))


def test_reviewed_block_is_lifted_again(gateway):
    sock = tunnel(gateway, "review-pay.test")
    assert b"real site" in get_over(sock, "review-pay.test")
    sock.close()
    time.sleep(1.8)
    assert refused(gateway, "review-pay.test"), "allow -> block after revocation"
    with gateway.client() as c:
        page = c.get("http://review-pay.test/", headers=BROWSER)
    assert page.status_code == 403
    assert '"review_pending": true' in page.text
    assert "This site has been re-checked and cleared." in page.text
    assert "تمت إعادة فحص هذا الموقع وتبيّن أنه آمن." in page.text
    deadline = time.monotonic() + 5
    while status(gateway, "review-pay.test")["state"] != "allow" and time.monotonic() < deadline:
        time.sleep(0.3)
    assert status(gateway, "review-pay.test")["state"] == "allow", "block -> allow after the review overturns it"
    sock = tunnel(gateway, "review-pay.test")
    assert b"real site" in get_over(sock, "review-pay.test")
    sock.close()
    assert any(d["source"] == "event:verdict.reviewed" for d in decisions(gateway, "review-pay.test"))


def test_noise_hosts_are_never_investigated(gateway, engine):
    with gateway.client() as c:
        assert c.get("http://pinned-app.test/sync").status_code == 200
    sock = tunnel(gateway, "pinned-app.test")
    sock.close()
    checked = {call["host"] for call in httpx.get(f"{engine}/mock/calls").json()}
    assert "pinned-app.test" not in checked
    assert decisions(gateway, "pinned-app.test")[0]["source"] == "passthrough"


def test_engine_that_never_answers_blocks_unknown_after_hold(gateway):
    started = time.monotonic()
    assert refused(gateway, "hang-site.test")
    assert 2.8 <= time.monotonic() - started < 5
    assert decisions(gateway, "hang-site.test")[0]["source"] == "timeout"


@pytest.fixture(scope="module")
def gateway_engine_down(start_gateway):
    return start_gateway("http://127.0.0.1:9", SCAMSHIELD_HOLD_S="1")


def test_engine_down_fails_closed_for_unknown_and_open_for_passthrough(gateway_engine_down):
    assert refused(gateway_engine_down, "fresh-site.test")
    assert decisions(gateway_engine_down, "fresh-site.test")[0]["source"] == "engine-down"
    sock = tunnel(gateway_engine_down, "pinned-app.test")
    assert b"real site" in get_over(sock, "pinned-app.test")
    sock.close()


@pytest.fixture(scope="module")
def gateway_fail_open(start_gateway):
    return start_gateway("http://127.0.0.1:9", SCAMSHIELD_HOLD_S="1", SCAMSHIELD_ON_TIMEOUT="allow")


def test_fail_open_policy_lets_unknown_through(gateway_fail_open):
    sock = tunnel(gateway_fail_open, "fresh-site.test")
    assert b"real site" in get_over(sock, "fresh-site.test")
    sock.close()


@pytest.fixture(scope="module")
def gateway_intercept(start_gateway, engine):
    return start_gateway(engine, SCAMSHIELD_INTERCEPT="1")


def test_intercept_mode_shows_pages_for_https(gateway_intercept):
    ca = str(gateway_intercept.confdir / "mitmproxy-ca-cert.pem")
    with gateway_intercept.client(verify=ca) as c:
        r = c.get("https://slow-checkout.test/cart", headers=BROWSER)
        assert r.status_code == 200 and "Checking this site for you" in r.text
        r = c.get("https://block-otp.test/verify", headers=BROWSER)
        assert r.status_code == 403 and "Mirsad blocked this site" in r.text
        r = c.get("https://allow-mail.test/inbox", headers=BROWSER)
        assert "real site allow-mail.test/inbox" in r.text


def test_dns_lookup_strips_ipv6_and_warms_the_engine(gateway, engine):
    aaaa = dns.query.udp(dns.message.make_query("allow-early.test", dns.rdatatype.AAAA), "127.0.0.1",
                         port=gateway.dns_port, timeout=5)
    assert aaaa.answer == []
    try:
        dns.query.udp(dns.message.make_query("allow-early.test", dns.rdatatype.A), "127.0.0.1",
                      port=gateway.dns_port, timeout=5)
    except dns.exception.Timeout:
        pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if "allow-early.test" in {call["host"] for call in httpx.get(f"{engine}/mock/calls").json()}:
            break
        time.sleep(0.2)
    else:
        pytest.fail("a DNS lookup should start the investigation before the connection arrives")


def test_block_page_shows_case_reference_brand_and_isolated_arabic(gateway):
    with gateway.client() as c:
        r = c.get("http://block-bidi.test/pay", headers=BROWSER)
    assert r.status_code == 403
    assert re.search(r"SS-20261125-[0-9A-F]{8}", r.text), "the evidence pack's case number is the reference"
    assert "ينتحل صفة <b><bdi>شرطة أبوظبي</bdi></b>" in r.text
    assert '\u2068&quot;fines&quot;\u2069, \u2068&quot;payment&quot;\u2069' in r.text


def test_long_url_is_checked_without_its_query_and_loads(gateway, engine):
    url = "http://allow-long.test/search?q=" + "x" * 5000
    with gateway.client() as c:
        r = c.get(url, headers=BROWSER)
    assert r.status_code == 200 and "real site allow-long.test/search" in r.text
    checked = [call["url"] for call in httpx.get(f"{engine}/mock/calls").json() if call["host"] == "allow-long.test"]
    assert checked and all(len(u) <= 4096 for u in checked)


def test_engine_refusal_is_not_a_block(gateway):
    sock = tunnel(gateway, "reject-site.test")
    assert b"real site" in get_over(sock, "reject-site.test")
    sock.close()
    assert decisions(gateway, "reject-site.test")[0]["source"] == "engine-rejected"


def test_holding_polls_do_not_count_as_visits(gateway, engine):
    sock = tunnel(gateway, "slow-visits.test")
    sock.close()
    time.sleep(0.5)
    calls = [c for c in httpx.get(f"{engine}/mock/host_calls").json() if c["host"] == "slow-visits.test"]
    assert calls, "the gateway asked the engine about the host while it held the connection"
    assert not any(c["counted"] for c in calls), "the check itself is the counted visit; polls are not"


def test_status_page_lists_only_this_phones_decisions(gateway):
    assert refused(gateway, "block-mine.test")
    with gateway.client() as phone:
        data = phone.get("http://shield.test/status.json").json()
        page = phone.get("http://shield.test/", headers=BROWSER)
    first = data["items"][0]
    assert first["host"] == "block-mine.test" and first["state"] == "block" and first["risk"] == 92
    assert first["reference"].startswith("SS-20261125-")
    assert first["reasons"][0]["en"] and first["reasons"][0]["ar"]
    assert page.status_code == 200 and "Your protection status" in page.text and "block-mine.test" in page.text
    other_phone = socket.socket()
    other_phone.bind(("127.0.0.2", 0))
    other_phone.connect(("127.0.0.1", gateway.port))
    other_phone.sendall(b"GET http://shield.test/status.json HTTP/1.1\r\nHost: shield.test\r\nConnection: close\r\n\r\n")
    raw = b""
    while chunk := other_phone.recv(65536):
        raw += chunk
    other = json.loads(raw.split(b"\r\n\r\n", 1)[1])
    assert other["client"] == "127.0.0.2"
    assert all(item["host"] != "block-mine.test" for item in other["items"])
