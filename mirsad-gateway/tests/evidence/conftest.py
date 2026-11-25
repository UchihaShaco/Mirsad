from __future__ import annotations

import pytest
from evidence_samples import BANK_TEXT, PNG_1PX, RDAP_DOMAIN, RDAP_IP

from scamshield.evidence import facts, screenshot
from scamshield.schemas import utcnow


@pytest.fixture
def offline(monkeypatch):
    """Replace every live lookup with canned answers; returns a dict to make individual ones fail."""
    state = {"screenshot": True, "lookups": True, "live_text": BANK_TEXT}

    async def capture(url, engine_html=None):
        if not state["screenshot"]:
            return screenshot.Capture(error="net::ERR_NAME_NOT_RESOLVED", engine_error="offline render failed")
        return screenshot.Capture(png=PNG_1PX, engine_png=PNG_1PX, dom="<html></html>", text=state["live_text"],
                                  title="Example Bank | Update your account", final_url=url, browser="chromium test",
                                  started_at=utcnow(), finished_at=utcnow())

    async def registration(domain):
        if not state["lookups"]:
            return facts.Registration(error="RDAP: timeout")
        reg = facts.parse_rdap_domain(RDAP_DOMAIN)
        reg.source = "rdap"
        return reg

    async def networks(ips):
        if not state["lookups"]:
            return [facts.Network(ip=ip, error="RDAP: timeout") for ip in ips]
        return [facts.parse_rdap_ip(ip, RDAP_IP) for ip in ips]

    async def certificate(host):
        if not state["lookups"]:
            return facts.Certificate(error="TLS: refused")
        return facts.Certificate(issuer="CN=Example CA", subject="CN=examp1e-bank-verify.com",
                                 sans=["examp1e-bank-verify.com"], sha256="ab" * 32,
                                 pem="-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n")

    async def resolve(host):
        return ["45.83.64.10"] if state["lookups"] else []

    monkeypatch.setattr(screenshot, "capture", capture)
    monkeypatch.setattr(facts, "registration", registration)
    monkeypatch.setattr(facts, "networks", networks)
    monkeypatch.setattr(facts, "certificate", certificate)
    monkeypatch.setattr(facts, "resolve", resolve)
    return state
