"""Sample records shared by the evidence tests (fictional organisations only)."""

from __future__ import annotations

from datetime import datetime, timezone

from scamshield.schemas import (
    BrandMatch,
    Decision,
    DomainIntel,
    FormInfo,
    PageSnapshot,
    Reason,
    RedirectHop,
    ReviewOutcome,
    ReviewResult,
    ReviewStep,
    Severity,
    Stage,
    Verdict,
)

BANK_TEXT = ("Example Bank account verification. Your account will be suspended within 24 hours unless you "
             "verify your customer number, password and the one-time code we sent to your phone.")

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)

RDAP_DOMAIN = {
    "objectClassName": "domain",
    "ldhName": "examp1e-bank-verify.com",
    "events": [
        {"eventAction": "registration", "eventDate": "2026-11-21T09:12:00Z"},
        {"eventAction": "expiration", "eventDate": "2027-11-21T09:12:00Z"},
    ],
    "nameservers": [{"ldhName": "ADA.NS.CLOUDFLARE.COM"}, {"ldhName": "BOB.NS.CLOUDFLARE.COM"}],
    "status": ["client transfer prohibited"],
    "entities": [
        {
            "roles": ["registrar"],
            "publicIds": [{"type": "IANA Registrar ID", "identifier": "9999"}],
            "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar LLC"]]],
            "entities": [
                {
                    "roles": ["abuse"],
                    "vcardArray": ["vcard", [["email", {}, "text", "abuse@registrar.example"]]],
                }
            ],
        },
        {
            "roles": ["registrant"],
            "vcardArray": ["vcard", [["adr", {"cc": "IS"}, "text", ["", "", "", "", "", "", "Iceland"]]]],
        },
    ],
}

RDAP_IP = {
    "name": "EXAMPLE-HOSTING-NET",
    "handle": "NET-203-0-113-0-1",
    "country": "NL",
    "startAddress": "203.0.113.0",
    "endAddress": "203.0.113.255",
    "entities": [{"roles": ["abuse"], "vcardArray": ["vcard", [["email", {}, "text", "abuse@hosting.example"]]]}],
}


def full_verdict() -> Verdict:
    when = datetime(2026, 11, 24, 17, 5, 0, tzinfo=timezone.utc)
    page = PageSnapshot(
        url="https://examp1e-bank-verify.com/login",
        final_url="https://examp1e-bank-verify.com/secure/kyc",
        status=200,
        fetched_at=when,
        redirect_chain=[
            RedirectHop(url="https://examp1e-bank-verify.com/login", status=302, via="http", ip="45.83.64.10"),
            RedirectHop(url="https://examp1e-bank-verify.com/secure/kyc", status=200, via="js", ip="45.83.64.10"),
        ],
        headers={"server": "cloudflare", "content-type": "text/html"},
        html="<html><body><form><input type=password></form></body></html>",
        title="Example Bank | Update your account",
        text=BANK_TEXT,
        forms=[FormInfo(asks_password=True, asks_otp=True)],
    )
    return Verdict(
        id="0f3c9a1b2d4e4f60a1b2c3d4e5f60718",
        url="https://examp1e-bank-verify.com/login",
        final_url="https://examp1e-bank-verify.com/secure/kyc",
        host="examp1e-bank-verify.com",
        registered_domain="examp1e-bank-verify.com",
        decision=Decision.BLOCK,
        risk_score=92,
        stage=Stage.DEEP,
        final=True,
        summary_en="Look-alike of Example Bank registered 3 days ago, asking for password and OTP.",
        summary_ar="نطاق مشابه لبنك المثال سُجّل قبل 3 أيام، ويطلب كلمة المرور ورمز التحقق.",
        reasons=[
            Reason(code="brand.lookalike", severity=Severity.CRITICAL, points=35,
                   title_en="Imitates Example Bank", title_ar="ينتحل صفة بنك المثال"),
            Reason(code="domain.newly_registered", severity=Severity.HIGH, points=25,
                   title_en="Domain registered 3 days ago", title_ar="النطاق مسجّل منذ 3 أيام"),
            Reason(code="tls.long_lived", severity=Severity.INFO, points=-5,
                   title_en="Valid TLS certificate", title_ar="شهادة TLS صالحة"),
        ],
        url_model_score=0.97,
        page_model_score=0.91,
        brand=BrandMatch(brand="Example Bank", brand_ar="بنك المثال", category="bank",
                         official_domains=["examplebank.example"], technique="typosquat",
                         matched_on=["domain", "title"], score=0.94),
        domain=DomainIntel(host="examp1e-bank-verify.com", registered_domain="examp1e-bank-verify.com",
                           tld="com", age_days=3, registrar="Example Registrar LLC",
                           nameservers=["ada.ns.cloudflare.com"], ips=["45.83.64.10"], asn=64500,
                           asn_org="Example Hosting BV", hosting_country="NL", tls_issuer="Example CA"),
        page=page,
        redirect_chain=page.redirect_chain,
        campaign_id="camp-7f2a",
        review=ReviewResult(
            outcome=ReviewOutcome.CONFIRMED, decision=Decision.BLOCK, confidence=0.93,
            summary_en="Re-checked independently: the block stands.",
            summary_ar="تمت إعادة التحقق بشكل مستقل: يبقى الحظر.",
            steps=[ReviewStep(tool="rdap_lookup", input={"domain": "examp1e-bank-verify.com"},
                              finding="Registered 3 days ago", supports_block=True, elapsed_ms=420)],
            model="reviewer-test",
        ),
        created_at=when,
        updated_at=when,
    )
