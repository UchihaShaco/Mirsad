"""Rebuild the dashboard's offline samples (dashboard/mock/*.json) from the real schema so they stay valid.

Fictional organisations only. Run: .venv/bin/python dashboard/mock/generate.py
"""
import asyncio
import hashlib
import json
import random
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scamshield.evidence.reference import case_reference
from scamshield.schemas import (BrandMatch, Decision, DomainIntel, FormInfo, PageSnapshot, Reason, RedirectHop,
                                ReviewOutcome, ReviewResult, ReviewStep, ScriptFinding, Severity as S, Stage, Verdict)

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
NOW = datetime(2026, 11, 24, 17, 30, tzinfo=timezone.utc)


def R(code, sev, pts, en, ar, detail=""):
    return Reason(code=code, severity=sev, points=pts, title_en=en, title_ar=ar, detail=detail)


def T(rep=2.1, url=180, page=None, deep=None, review=None, cache=None):
    t = {"intel.reputation": 0.4}
    if cache is not None:
        return {"layer0_cache_hit": cache, "total": cache}
    t["layer0_reputation"] = rep
    t["models.score_url"] = round(url * 0.12, 1)
    t["intel.assess_domain_fast"] = round(url * 0.7, 1)
    t["layer1_url"] = url
    total = rep + url
    if page:
        t["fetch_page"] = round(page * 0.62, 1)
        t["models.score_page"] = 41.0
        t["layer2_page"] = page
        total += page
    if deep:
        t["layer3_deep"] = deep
        total += deep
    if review:
        t["layer4_review"] = review
    t["total"] = round(total, 1)
    return t


def ago(minutes):
    return NOW - timedelta(minutes=minutes)


def chain(*hops):
    return [RedirectHop(url=u, status=s, via=v, ip=ip) for u, s, v, ip in hops]


verdicts = []

# 1. Bank look-alike, blocked, review confirmed, campaign A.
c1 = chain(("https://sho.rt.example/aB12", 301, "shortener", "198.51.100.7"),
           ("https://examp1e-bank-verify.com/login", 302, "http", "203.0.113.10"),
           ("https://examp1e-bank-verify.com/secure/kyc", 200, "js", "203.0.113.10"))
v1 = Verdict(
    id="a1f04c2e9b7d4e1f8a6b3c5d7e9f0a12", url="https://sho.rt.example/aB12", final_url="https://examp1e-bank-verify.com/secure/kyc",
    host="examp1e-bank-verify.com", registered_domain="examp1e-bank-verify.com", decision=Decision.BLOCK, risk_score=96,
    stage=Stage.DEEP, final=True,
    summary_en="Look-alike of Example Bank registered 3 days ago; the page asks for your password and OTP and sends them to another server.",
    summary_ar="موقع يقلّد بنك المثال سُجّل قبل 3 أيام؛ تطلب الصفحة كلمة المرور ورمز التحقق وترسلهما إلى خادم آخر.",
    reasons=[
        R("rule.impersonation_block", S.CRITICAL, 0, "Confirmed impersonation: brand on a domain it does not own, collecting sensitive data", "انتحال مؤكد: علامة تجارية على نطاق لا تملكه تجمع بيانات حساسة"),
        R("domain.lookalike", S.HIGH, 36, "Imitates Example Bank (typosquat: 1 → l)", "ينتحل صفة بنك المثال (تحريف إملائي)", "examp1e-bank vs examplebank"),
        R("domain.newly_registered", S.HIGH, 20, "Domain registered only 3 days ago", "تم تسجيل النطاق قبل 3 يوماً فقط"),
        R("page.external_form_action", S.HIGH, 14, "Sends the entered details to another server (collect.example-cdn.top)", "يرسل البيانات المدخلة إلى خادم آخر (collect.example-cdn.top)"),
        R("page.otp_form", S.HIGH, 12, "Asks for a one-time password (OTP)", "يطلب رمز التحقق لمرة واحدة (OTP)"),
        R("page.password_form", S.MEDIUM, 8, "Asks for a password", "يطلب كلمة المرور"),
        R("page.shortener_in_chain", S.LOW, 6, "Redirect chain passes through a link shortener", "تمر سلسلة إعادة التوجيه عبر رابط مختصر"),
        R("page.urgency", S.MEDIUM, 8, "Pressure wording: account suspended, within 24 hours", "عبارات ضغط واستعجال: تعليق الحساب، خلال 24 ساعة"),
        R("tls.new_certificate", S.LOW, 4, "Security certificate issued 2 days ago", "صدرت شهادة الأمان قبل 2 يوم"),
        R("model.page", S.INFO, 0, "Page model: 97% likely a scam", "نموذج تحليل الصفحة: احتمال الاحتيال 97٪"),
        R("review.confirmed", S.INFO, 0, "Second-opinion review confirmed the block", "أكّدت المراجعة الثانية قرار الحظر"),
    ],
    url_model_score=0.91, page_model_score=0.97, llm_score=0.95,
    brand=BrandMatch(brand="Example Bank", brand_ar="بنك المثال", category="bank", official_domains=["examplebank.example", "online.examplebank.example"],
                     technique="typosquat", matched_on=["domain", "title", "favicon"], score=0.96),
    domain=DomainIntel(host="examp1e-bank-verify.com", registered_domain="examp1e-bank-verify.com", tld="com", created=ago(60 * 24 * 3), age_days=3,
                       registrar="Example Registrar LLC", registrant_country="IS", nameservers=["ada.ns.example-dns.net", "bob.ns.example-dns.net"],
                       ips=["203.0.113.10"], asn=64500, asn_org="Example Hosting BV", hosting_country="NL", tls_issuer="Example Free CA R3",
                       tls_not_before=ago(60 * 24 * 2), tls_age_days=2, tls_sans=["examp1e-bank-verify.com", "www.examp1e-bank-verify.com"]),
    page=PageSnapshot(url="https://examp1e-bank-verify.com/login", final_url="https://examp1e-bank-verify.com/secure/kyc", status=200,
                      fetched_at=ago(12), redirect_chain=c1, title="Example Bank | Verify your account", lang="en",
                      forms=[FormInfo(action="https://collect.example-cdn.top/p.php", method="post", action_host="collect.example-cdn.top",
                                      external_action=True, input_types=["text", "password", "tel"], input_names=["user", "pass", "otp"],
                                      asks_password=True, asks_otp=True)],
                      scripts=[ScriptFinding(src=None, first_party=True, size=18234, obfuscated=True, obfuscation_markers=["eval(atob(", "hex-escaped strings"],
                                             endpoints=["https://collect.example-cdn.top/p.php"], suspicious_calls=["keydown listener", "navigator.sendBeacon"]),
                               ScriptFinding(src="https://examp1e-bank-verify.com/js/app.js", first_party=True, size=4410,
                                             redirects=["/secure/kyc"], suspicious_calls=["history.pushState loop"])],
                      external_hosts=["collect.example-cdn.top"]),
    redirect_chain=c1, pages_crawled=7, campaign_id="camp-7f2a",
    review=ReviewResult(outcome=ReviewOutcome.CONFIRMED, decision=Decision.BLOCK, confidence=0.94, model="reviewer-agent",
                        summary_en="Every key finding re-validated: the domain is 3 days old, not owned by Example Bank, and the login form posts credentials to an unrelated server.",
                        summary_ar="أُعيد التحقق من جميع المؤشرات الرئيسية: النطاق عمره 3 أيام ولا يملكه بنك المثال، ونموذج الدخول يرسل بيانات الاعتماد إلى خادم غير تابع له.",
                        steps=[ReviewStep(tool="rdap_lookup", input={"domain": "examp1e-bank-verify.com"}, finding="Registered 3 days ago at Example Registrar LLC; registrant country IS.", supports_block=True, elapsed_ms=640),
                               ReviewStep(tool="brand_registry", input={"brand": "Example Bank"}, finding="Official domains are examplebank.example and online.examplebank.example; this domain is not among them.", supports_block=True, elapsed_ms=12),
                               ReviewStep(tool="fetch_page", input={"url": "https://examp1e-bank-verify.com/secure/kyc"}, finding="Form still posts password and OTP to collect.example-cdn.top.", supports_block=True, elapsed_ms=1830),
                               ReviewStep(tool="web_search", input={"query": "examp1e-bank-verify.com"}, finding="No legitimate references; two community reports of SMS phishing.", supports_block=True, elapsed_ms=2210),
                               ReviewStep(tool="tls_check", input={"host": "examp1e-bank-verify.com"}, finding="Free domain-validated certificate issued 2 days ago; neutral on its own.", supports_block=None, elapsed_ms=310)],
                        started_at=ago(9), finished_at=ago(8.8)),
    timings_ms=T(rep=1.8, url=212, page=1840, deep=8420, review=6900), created_at=ago(12.2), updated_at=ago(8.8))
verdicts.append(dict(v1.model_dump(mode="json"), source="user"))

# 2/3. Watcher finds on cheap TLDs, campaign B (fine / parcel fee kit).
for i, (vid, host, brand, brand_ar, cat, amount, minutes, ip, score) in enumerate([
    ("b2c3d4e5f6a74b8c9d0e1f2a3b4c5d61", "roads-fine-payment-example.icu", "Example Roads Authority", "هيئة الطرق المثال", "government", 50, 31, "192.0.2.44", 92),
    ("c3d4e5f6a7b84c9d0e1f2a3b4c5d6e72", "example-post-parcel-fee.top", "Example Post", "بريد المثال", "courier", 12, 47, "192.0.2.44", 88),
    ("d4e5f6a7b8c94d0e1f2a3b4c5d6e7f83", "toll-topup-example.cfd", "Example Toll", "رسوم الطرق المثال", "government", 25, 63, "192.0.2.45", 85),
]):
    url = f"https://{host}/pay"
    v = Verdict(id=vid, url=url, final_url=url, host=host, registered_domain=host, decision=Decision.BLOCK, risk_score=score, stage=Stage.PAGE, final=True,
                summary_en=f"Newly registered .{host.rsplit('.', 1)[1]} domain posing as {brand}, asking for card details to pay a AED {amount} fee.",
                summary_ar=f"نطاق حديث التسجيل ينتحل صفة {brand_ar} ويطلب بيانات البطاقة لدفع رسوم قدرها {amount} درهم.",
                reasons=[R("page.fee_bait", S.HIGH, 14, f"Small fee of AED {amount} paired with a penalty or deadline threat", f"رسوم صغيرة بقيمة {amount} درهم مقرونة بتهديد بغرامة أو مهلة"),
                         R("page.card_form", S.HIGH, 18, "Asks for payment card details", "يطلب بيانات البطاقة المصرفية"),
                         R("page.tld_campaign_combo", S.HIGH, 12, f'Cheap ".{host.rsplit(".", 1)[1]}" domain with fine, toll or parcel-fee wording', f'نطاق رخيص بامتداد ".{host.rsplit(".", 1)[1]}" مع عبارات مخالفات أو رسوم طرق أو شحنات'),
                         R("domain.newly_registered", S.HIGH, 20, "Domain registered only 1 days ago", "تم تسجيل النطاق قبل 1 يوماً فقط"),
                         R("page.brand_hosting_mismatch", S.LOW, 5, f"Claims to be {brand} but is hosted abroad (SG)", f"يدّعي أنه {brand_ar} لكنه مستضاف خارج الدولة (SG)"),
                         R("page.cloaking_code", S.MEDIUM, 7, "Hides from security scanners (user-agent check)", "يتخفّى عن أدوات الفحص الأمني (فحص هوية المتصفح)")],
                url_model_score=0.88 - i * 0.03, page_model_score=0.93,
                brand=BrandMatch(brand=brand, brand_ar=brand_ar, category=cat, official_domains=[f"{brand.lower().replace(' ', '')}.example"], technique="combosquat",
                                 matched_on=["domain", "page text"], score=0.9),
                domain=DomainIntel(host=host, registered_domain=host, tld=host.rsplit(".", 1)[1], created=ago(60 * 24), age_days=1, registrar="Example Budget Registrar",
                                   registrant_country="CN", nameservers=["ns1.example-parking.net", "ns2.example-parking.net"], ips=[ip], asn=64511,
                                   asn_org="Example Cloud Pte Ltd", hosting_country="SG", tls_issuer="Example Free CA R3", tls_age_days=1),
                page=PageSnapshot(url=url, final_url=url, status=200, fetched_at=ago(minutes), title=f"{brand} - Pay now",
                                  forms=[FormInfo(action="/api/card", method="post", input_types=["text", "tel"], asks_card=True)]),
                campaign_id="camp-3c19", timings_ms=T(rep=2.4, url=160 + i * 20, page=1420 + i * 130), created_at=ago(minutes), updated_at=ago(minutes - 0.2))
    verdicts.append(dict(v.model_dump(mode="json"), source="watcher"))

# 4. Official bank domain, allowlisted, cache hit.
v4 = Verdict(id="e5f6a7b8c9d04e1f2a3b4c5d6e7f8a94", url="https://examplebank.example/", final_url="https://examplebank.example/", host="examplebank.example",
             registered_domain="examplebank.example", decision=Decision.ALLOW, risk_score=2, stage=Stage.REPUTATION, final=True,
             summary_en="Verified official domain of Example Bank.", summary_ar="النطاق الرسمي الموثّق لبنك المثال.",
             reasons=[R("rep.allowlisted", S.INFO, -60, "Verified official domain", "نطاق رسمي موثّق"),
                      R("trust.allowlist_guard", S.INFO, 0, "Verified official domain is never blocked", "النطاق الرسمي الموثّق لا يُحظر أبداً")],
             domain=DomainIntel(host="examplebank.example", registered_domain="examplebank.example", allowlisted=True, allowlist_owner="Example Bank", age_days=7300),
             timings_ms=T(cache=0.9), created_at=ago(2), updated_at=ago(2))
verdicts.append(dict(v4.model_dump(mode="json"), source="user"))

# 5. Ordinary news site, allowed.
v5 = Verdict(id="f6a7b8c9d0e14f2a3b4c5d6e7f8a9b05", url="https://news.example.org/uae/weather", final_url="https://news.example.org/uae/weather", host="news.example.org",
             registered_domain="example.org", decision=Decision.ALLOW, risk_score=9, stage=Stage.PAGE, final=True,
             summary_en="Long-established, widely visited site; nothing suspicious on the page.", summary_ar="موقع راسخ وواسع الانتشار؛ لا شيء مريب في الصفحة.",
             reasons=[R("domain.long_established", S.INFO, -16, "Domain has existed for 18 years", "النطاق مسجّل منذ 18 سنة"),
                      R("domain.popular", S.INFO, -14, "Widely visited site (rank 2140)", "موقع واسع الانتشار (الترتيب 2140)"),
                      R("tls.organisation_validated", S.INFO, -8, "Certificate verifies the organisation's identity", "الشهادة تتحقق من هوية الجهة المالكة")],
             url_model_score=0.04, page_model_score=0.03,
             domain=DomainIntel(host="news.example.org", registered_domain="example.org", tld="org", age_days=6600, registrar="Example Registrar LLC",
                                ips=["198.51.100.20"], asn=64496, asn_org="Example CDN Inc", hosting_country="AE", popularity_rank=2140, tls_issuer="Example OV CA"),
             timings_ms=T(rep=1.2, url=95, page=640), created_at=ago(5), updated_at=ago(4.9))
verdicts.append(dict(v5.model_dump(mode="json"), source="user"))

# 6. Promo shop, warned.
v6 = Verdict(id="0a1b2c3d4e5f40617283940a1b2c3d16", url="https://mega-deals-example.shop/white-friday", final_url="https://mega-deals-example.shop/white-friday",
             host="mega-deals-example.shop", registered_domain="mega-deals-example.shop", decision=Decision.WARN, risk_score=54, stage=Stage.PAGE, final=True,
             summary_en="Young shop domain with payment lures and countdown pressure; no brand impersonation found.",
             summary_ar="متجر بنطاق حديث مع إغراءات دفع وعدّاد تنازلي للضغط؛ لم يُعثر على انتحال علامة تجارية.",
             reasons=[R("domain.young", S.MEDIUM, 9, "Domain is less than six months old (41 days)", "عمر النطاق أقل من ستة أشهر (41 يوماً)"),
                      R("page.payment_lure", S.MEDIUM, 10, "Payment or prize lure: 90% off, today only", "إغراء بالدفع أو الجوائز: خصم 90٪، اليوم فقط"),
                      R("page.urgency", S.MEDIUM, 8, "Pressure wording: offer ends in 10 minutes", "عبارات ضغط واستعجال: ينتهي العرض خلال 10 دقائق"),
                      R("url.suspicious_tld", S.LOW, 6, 'Domain ending ".shop" is heavily abused by scammers', 'امتداد النطاق ".shop" يكثر استغلاله في الاحتيال'),
                      R("tls.organisation_validated", S.INFO, -4, "Certificate has existed for 40 days", "عمر الشهادة 40 يوماً")],
             url_model_score=0.47, page_model_score=0.58,
             domain=DomainIntel(host="mega-deals-example.shop", registered_domain="mega-deals-example.shop", tld="shop", age_days=41, registrar="Example Budget Registrar",
                                ips=["203.0.113.77"], asn=64500, asn_org="Example Hosting BV", hosting_country="NL"),
             timings_ms=T(rep=2.0, url=170, page=2210), created_at=ago(19), updated_at=ago(18.9))
verdicts.append(dict(v6.model_dump(mode="json"), source="user"))

# 7. Allowed after page layer, revoked by the deep crawl.
v7 = Verdict(id="1b2c3d4e5f6a41728394a5b6c7d8e927", url="https://example-telecom-rewards.xyz/", final_url="https://example-telecom-rewards.xyz/",
             host="example-telecom-rewards.xyz", registered_domain="example-telecom-rewards.xyz", decision=Decision.BLOCK, risk_score=83, stage=Stage.DEEP, final=True,
             summary_en="Landing page looked harmless; the deep crawl found a card-capture page posing as Example Telecom three links in.",
             summary_ar="بدت الصفحة الأولى غير ضارة؛ لكن الفحص العميق وجد صفحة لسرقة بيانات البطاقة تنتحل صفة شركة اتصالات المثال بعد ثلاث نقرات.",
             reasons=[R("deep.revoked", S.CRITICAL, 0, "Allowed earlier, blocked after deeper inspection of /claim/step3", "سُمح به سابقاً ثم حُظر بعد فحص أعمق للصفحة /claim/step3"),
                      R("page.sensitive_form_off_brand", S.HIGH, 16, "Asks for card details while posing as Example Telecom on a domain it does not own", "يطلب بيانات البطاقة منتحلاً صفة شركة اتصالات المثال على نطاق لا يملكه"),
                      R("page.card_form", S.HIGH, 18, "Asks for payment card details", "يطلب بيانات البطاقة المصرفية"),
                      R("page.exfiltration", S.CRITICAL, 30, "Sends data to a known data-theft channel (messaging bot API)", "يرسل البيانات إلى قناة معروفة لسرقة البيانات (واجهة روبوت مراسلة)"),
                      R("domain.young", S.MEDIUM, 9, "Domain is less than six months old (12 days)", "عمر النطاق أقل من ستة أشهر (12 يوماً)")],
             url_model_score=0.31, page_model_score=0.22, llm_score=0.9,
             brand=BrandMatch(brand="Example Telecom", brand_ar="شركة اتصالات المثال", category="telecom", official_domains=["exampletelecom.example"],
                              technique="content", matched_on=["page text", "logo colours"], score=0.82),
             domain=DomainIntel(host="example-telecom-rewards.xyz", registered_domain="example-telecom-rewards.xyz", tld="xyz", age_days=12, registrar="Example Budget Registrar",
                                ips=["203.0.113.10"], asn=64500, asn_org="Example Hosting BV", hosting_country="NL", nameservers=["ada.ns.example-dns.net", "bob.ns.example-dns.net"]),
             page=PageSnapshot(url="https://example-telecom-rewards.xyz/", final_url="https://example-telecom-rewards.xyz/", status=200, fetched_at=ago(26), title="Rewards"),
             pages_crawled=14, campaign_id="camp-7f2a", timings_ms=T(rep=2.2, url=150, page=1310, deep=12800), created_at=ago(26), updated_at=ago(25))
verdicts.append(dict(v7.model_dump(mode="json"), source="user", revoked=True))

# 8. Blocked, then the review overturned it.
v8 = Verdict(id="2c3d4e5f6a7b42839405b6c7d8e9fa38", url="https://community-iftar-example.org/donate", final_url="https://community-iftar-example.org/donate",
             host="community-iftar-example.org", registered_domain="community-iftar-example.org", decision=Decision.ALLOW, risk_score=24, stage=Stage.DEEP, final=True,
             summary_en="Initially blocked for a new domain collecting card payments; the review found a registered charity using a known payment provider.",
             summary_ar="حُظر في البداية لأنه نطاق جديد يجمع مدفوعات بالبطاقة؛ ووجدت المراجعة أنه جمعية خيرية مسجّلة تستخدم مزود دفع معروفاً.",
             reasons=[R("domain.newly_registered", S.HIGH, 20, "Domain registered only 9 days ago", "تم تسجيل النطاق قبل 9 يوماً فقط"),
                      R("page.card_form", S.HIGH, 18, "Asks for payment card details", "يطلب بيانات البطاقة المصرفية"),
                      R("page.payment_lure", S.MEDIUM, 10, "Payment or prize lure: donate now", "إغراء بالدفع أو الجوائز: تبرّع الآن"),
                      R("review.overturned", S.INFO, -40, "Second-opinion review found a false positive and unblocked the site", "وجدت المراجعة الثانية أن الحظر خاطئ فأُلغي حظر الموقع")],
             url_model_score=0.42, page_model_score=0.71,
             domain=DomainIntel(host="community-iftar-example.org", registered_domain="community-iftar-example.org", tld="org", age_days=9, registrar="Example Registrar LLC",
                                ips=["198.51.100.61"], asn=64496, asn_org="Example CDN Inc", hosting_country="AE", tls_issuer="Example OV CA"),
             review=ReviewResult(outcome=ReviewOutcome.OVERTURNED, decision=Decision.ALLOW, confidence=0.86, model="reviewer-agent",
                                 summary_en="False positive: the payment form is served by a well-known payment provider and the organisation is listed in the charity register.",
                                 summary_ar="حظر خاطئ: نموذج الدفع يقدّمه مزود دفع معروف، والجهة مدرجة في سجل الجمعيات الخيرية.",
                                 steps=[ReviewStep(tool="fetch_page", input={"url": "https://community-iftar-example.org/donate"}, finding="Card form is an iframe from pay.example-psp.com, a well-known provider.", supports_block=False, elapsed_ms=1620),
                                        ReviewStep(tool="web_search", input={"query": "community iftar example charity licence"}, finding="Organisation appears in the public charity register (fictional sample).", supports_block=False, elapsed_ms=2480),
                                        ReviewStep(tool="rdap_lookup", input={"domain": "community-iftar-example.org"}, finding="Registered 9 days ago; consistent with a seasonal campaign site.", supports_block=None, elapsed_ms=580),
                                        ReviewStep(tool="brand_registry", input={"host": "community-iftar-example.org"}, finding="No brand impersonation found.", supports_block=False, elapsed_ms=9)],
                                 started_at=ago(37), finished_at=ago(36.7)),
             timings_ms=T(rep=1.9, url=140, page=1520, deep=6100, review=7400), created_at=ago(39), updated_at=ago(36.7))
verdicts.append(dict(v8.model_dump(mode="json"), source="user", previous_decision="block"))

# 9. Cache hit on the bank look-alike from another subscriber.
v9 = v1.model_copy(deep=True)
v9.id = "3d4e5f6a7b8c43940516c7d8e9fa0b49"
v9.timings_ms = T(cache=1.3)
v9.created_at = v9.updated_at = ago(1)
verdicts.append(dict(v9.model_dump(mode="json"), source="user"))

# 10. Investment scam, warn after review downgrade.
v10 = Verdict(id="4e5f6a7b8c9d44a51627d8e9fa0b1c5a", url="https://gold-yield-example.com/invest", final_url="https://gold-yield-example.com/invest", host="gold-yield-example.com",
              registered_domain="gold-yield-example.com", decision=Decision.WARN, risk_score=62, stage=Stage.DEEP, final=True,
              summary_en="Promises guaranteed daily returns on gold trading; no licence found. Review downgraded the block to a warning.",
              summary_ar="يعد بعوائد يومية مضمونة من تداول الذهب دون ترخيص ظاهر. خفّضت المراجعة الحظر إلى تحذير.",
              reasons=[R("page.payment_lure", S.MEDIUM, 10, "Payment or prize lure: guaranteed 3% daily", "إغراء بالدفع أو الجوائز: عائد مضمون 3٪ يومياً"),
                       R("domain.young", S.MEDIUM, 9, "Domain is less than six months old (77 days)", "عمر النطاق أقل من ستة أشهر (77 يوماً)"),
                       R("page.visitor_profiling", S.LOW, 4, "Looks up the visitor's IP and location, as phishing kits do", "يستعلم عن عنوان IP وموقع الزائر كما تفعل أدوات التصيّد"),
                       R("review.downgraded", S.INFO, -8, "Second-opinion review downgraded the block to a warning", "خفّضت المراجعة الثانية الحظر إلى تحذير")],
              url_model_score=0.61, page_model_score=0.74,
              domain=DomainIntel(host="gold-yield-example.com", registered_domain="gold-yield-example.com", tld="com", age_days=77, ips=["192.0.2.80"], asn=64511, asn_org="Example Cloud Pte Ltd", hosting_country="SG"),
              review=ReviewResult(outcome=ReviewOutcome.DOWNGRADED, decision=Decision.WARN, confidence=0.6, model="reviewer-agent",
                                  summary_en="Likely high-risk investment marketing, but no credential or card capture found; warning is the proportionate response.",
                                  summary_ar="تسويق استثماري عالي الخطورة على الأرجح، لكن لم يُعثر على سرقة بيانات اعتماد أو بطاقات؛ التحذير هو الإجراء المناسب.",
                                  steps=[ReviewStep(tool="fetch_page", input={"url": "https://gold-yield-example.com/invest"}, finding="Sign-up form asks for name and phone only.", supports_block=False, elapsed_ms=1400),
                                         ReviewStep(tool="web_search", input={"query": "gold-yield-example.com licence"}, finding="No regulator licence found.", supports_block=True, elapsed_ms=2100)],
                                  started_at=ago(55), finished_at=ago(54.8)),
              timings_ms=T(rep=2.0, url=190, page=1700, deep=5200, review=5100), created_at=ago(57), updated_at=ago(54.8))
verdicts.append(dict(v10.model_dump(mode="json"), source="user", previous_decision="block"))

verdicts.sort(key=lambda v: v["updated_at"], reverse=True)
for v in verdicts:
    if v.get("page"):
        v["page"]["html"] = ""
(OUT / "verdicts.json").write_text(json.dumps(verdicts, ensure_ascii=False, indent=1))

campaigns = [
    {"id": "camp-3c19", "label": "Fine and parcel-fee kit on cheap TLDs", "label_ar": "حملة رسوم المخالفات والشحنات على نطاقات رخيصة",
     "first_seen": (ago(63)).isoformat(), "last_seen": (ago(31)).isoformat(),
     "domains": [{"host": v["host"], "decision": v["decision"], "risk_score": v["risk_score"], "verdict_id": v["id"]} for v in verdicts if v.get("campaign_id") == "camp-3c19"]
     + [{"host": "parking-fine-example.sbs", "decision": "block", "risk_score": 90, "verdict_id": None}],
     "links": [{"source": "roads-fine-payment-example.icu", "target": "example-post-parcel-fee.top", "shared": ["ip 192.0.2.44", "ns example-parking.net", "kit hash 9f3a…e1"]},
               {"source": "roads-fine-payment-example.icu", "target": "toll-topup-example.cfd", "shared": ["ns example-parking.net", "kit hash 9f3a…e1"]},
               {"source": "example-post-parcel-fee.top", "target": "toll-topup-example.cfd", "shared": ["AS64511"]},
               {"source": "toll-topup-example.cfd", "target": "parking-fine-example.sbs", "shared": ["ip 192.0.2.45", "favicon 6b1d…"]}]},
    {"id": "camp-7f2a", "label": "Example Bank / Example Telecom credential theft", "label_ar": "سرقة بيانات اعتماد بنك المثال واتصالات المثال",
     "first_seen": (ago(26)).isoformat(), "last_seen": (ago(12)).isoformat(),
     "domains": [{"host": "examp1e-bank-verify.com", "decision": "block", "risk_score": 96, "verdict_id": v1.id},
                 {"host": "example-telecom-rewards.xyz", "decision": "block", "risk_score": 83, "verdict_id": v7.id},
                 {"host": "examp1e-bank-secure.net", "decision": "block", "risk_score": 91, "verdict_id": None}],
     "links": [{"source": "examp1e-bank-verify.com", "target": "example-telecom-rewards.xyz", "shared": ["ip 203.0.113.10", "ns example-dns.net", "exfil endpoint"]},
               {"source": "examp1e-bank-verify.com", "target": "examp1e-bank-secure.net", "shared": ["TLS SAN", "page structure hash"]}]},
]
(OUT / "campaigns.json").write_text(json.dumps(campaigns, ensure_ascii=False, indent=1))

# Benchmarks: the team's metrics for the three headline datasets, plus the timing study and images. Only scalar
# fields (names, counts, metrics, timings, notes) are copied: per-URL lists such as false positives never are.
ROOT = OUT.parents[1]
METRIC_TYPES = (str, int, float, bool, type(None))
results = []
for path in sorted((ROOT / "ml" / "results").glob("*.json")):
    row = json.loads(path.read_text())
    if row.get("dataset") in ("urls_fresh_test", "uae_legit", "pages_test"):
        results.append({k: v for k, v in row.items() if isinstance(v, METRIC_TYPES)})
benchmarks = {"results": results, "markdown": "# Benchmarks\n\nSample of the team's benchmark results for offline demonstration.\n"}
(OUT / "benchmarks.json").write_text(json.dumps(benchmarks, ensure_ascii=False, indent=1))
sys.path.insert(0, str(ROOT / "src"))
from scamshield.evidence.api import benchmark_extra  # noqa: E402

extra = asyncio.run(benchmark_extra())
(OUT / "benchmarks_extra.json").write_text(json.dumps(extra, ensure_ascii=False, indent=1))
(OUT / "img").mkdir(exist_ok=True)
for name in extra["images"]:
    shutil.copy(ROOT / "docs" / "img" / name, OUT / "img" / name)
print(len(verdicts), "verdicts")

# Reputation table (/v1/hosts) and per-host history (/v1/hosts/{host}/history).
rng = random.Random(7)


def hourly(level, spike_at=None):
    out = []
    for h in range(24):
        local_hour = (NOW.hour + 4 - 23 + h) % 24  # GST hour of each bucket, oldest first
        day = 0.35 + 0.65 * max(0.0, 1 - abs(local_hour - 15) / 9)
        out.append(max(0, int(level * day * rng.uniform(0.7, 1.3))))
    if spike_at is not None:
        for h in range(spike_at, 24):
            out[h] = int(out[h] * 6 + level)
    return out


REPUTATION = {"block": "blocked", "warn": "suspicious"}
rows, history = [], {}
latest = {}
for v in sorted(verdicts, key=lambda v: v["created_at"]):
    latest[v["host"]] = v
for host, v in latest.items():
    d = v.get("domain") or {}
    age = d.get("age_days")
    rep = REPUTATION.get(v["decision"]) or ("trusted" if d.get("allowlisted") else "established" if (age or 0) > 365 else "unknown")
    if v.get("review") and v["review"]["outcome"] == "overturned":
        rep = "unknown"
    scam = v["decision"] == "block"
    visits_hourly = hourly(rng.choice([1, 2, 3]) if scam else rng.choice([4, 12, 40]), spike_at=19 if scam else None)
    changes = []
    if scam:
        changes.append({"at": (ago(80)).isoformat(), "kind": "ip", "old": "198.51.100.200", "new": (d.get("ips") or ["203.0.113.10"])[0]})
        changes.append({"at": (ago(30)).isoformat(), "kind": "content", "old": "parked page", "new": "login form"})
    if v.get("revoked"):
        changes.append({"at": (ago(27)).isoformat(), "kind": "structure", "old": "3 links", "new": "multi-step claim form"})
    if host == "news.example.org":
        changes.append({"at": (ago(60 * 24 * 6)).isoformat(), "kind": "certificate", "old": "Example OV CA (2025)", "new": "Example OV CA (2026)"})
    changes.sort(key=lambda c: c["at"])
    hv = [{"id": x["id"], "decision": x["decision"], "risk_score": x["risk_score"], "stage": x["stage"], "created_at": x["created_at"],
           "source": x.get("source")} for x in verdicts if x["host"] == host]
    rows.append({
        "host": host, "registered_domain": v["registered_domain"], "decision": v["decision"], "risk_score": v["risk_score"], "stage": v["stage"],
        "reputation": rep, "allowlisted": bool(d.get("allowlisted")), "owner": d.get("allowlist_owner"), "blocklisted": bool(d.get("blocklisted")),
        "popularity_rank": d.get("popularity_rank"), "domain_age_days": age, "visits": sum(visits_hourly) + rng.randint(0, 400) * (0 if scam else 1),
        "visits_24h": sum(visits_hourly), "first_seen": min(x["created_at"] for x in hv), "last_seen": v["updated_at"], "last_checked": v["updated_at"],
        "last_changed": changes[-1]["at"] if changes else None, "last_change_kind": changes[-1]["kind"] if changes else None, "changes": len(changes),
        "verdict_id": v["id"], "source": v.get("source"), "campaign_id": v.get("campaign_id"),
    })
    history[host] = {"changes": changes, "verdicts": hv, "visits_hourly": visits_hourly}

for host, rank, age, owner in [("portal.example.gov", 8400, 4100, "Example Government Portal"), ("mail.example.com", 310, 9800, None),
                               ("video.example.net", 45, 7200, None), ("telecom.example", 2900, 6100, "Example Telecom"),
                               ("cdn.example-static.net", None, 2300, None), ("shop.example-retail.ae", 52000, 900, None)]:
    visits_hourly = hourly(rng.choice([60, 140, 300]))
    changes = [{"at": (ago(60 * 24 * rng.randint(2, 40))).isoformat(), "kind": rng.choice(["certificate", "ip", "content"]), "old": None, "new": None}]
    rows.append({"host": host, "registered_domain": host, "decision": "allow", "risk_score": rng.choice([2, 4, 6, 9]), "stage": "page",
                 "reputation": "trusted" if owner else "established", "allowlisted": bool(owner), "owner": owner, "blocklisted": False,
                 "popularity_rank": rank, "domain_age_days": age, "visits": sum(visits_hourly) * rng.randint(20, 60), "visits_24h": sum(visits_hourly),
                 "first_seen": (ago(60 * 24 * 21)).isoformat(), "last_seen": (ago(rng.randint(0, 9))).isoformat(),
                 "last_checked": (ago(rng.randint(20, 200))).isoformat(), "last_changed": changes[0]["at"], "last_change_kind": changes[0]["kind"],
                 "changes": 1, "verdict_id": None, "source": "gateway", "campaign_id": None})
    history[host] = {"changes": changes, "verdicts": [], "visits_hourly": visits_hourly}

rows.append({"host": "unrated-newsite.example", "registered_domain": "unrated-newsite.example", "decision": None, "risk_score": None, "stage": None,
             "reputation": "unknown", "allowlisted": False, "owner": None, "blocklisted": False, "popularity_rank": None, "domain_age_days": None,
             "visits": 3, "visits_24h": 3, "first_seen": (ago(4)).isoformat(), "last_seen": (ago(4)).isoformat(), "last_checked": None,
             "last_changed": None, "last_change_kind": None, "changes": 0, "verdict_id": None, "source": "gateway", "campaign_id": None})
history["unrated-newsite.example"] = {"changes": [], "verdicts": [], "visits_hourly": [0] * 20 + [1, 0, 2, 0]}

rows.sort(key=lambda r: r["visits"], reverse=True)
(OUT / "hosts.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
(OUT / "hosts_history.json").write_text(json.dumps(history, ensure_ascii=False, indent=1))
print(len(rows), "hosts")

# Evidence cases (/v1/evidence, /v1/verdicts/{id}/evidence/summary, screenshots). Pages are fictional and are
# rendered offline, exactly as the evidence worker renders the engine's captured HTML.
BANK_PAGE = """<html><head><title>Example Bank | Verify your account</title><style>
body{margin:0;font-family:Arial,sans-serif;background:#f3f5f9;color:#14213d}
header{background:#123e7c;color:#fff;padding:18px 20px;font-size:20px;font-weight:700}
main{padding:22px}.card{background:#fff;border-radius:10px;padding:20px;box-shadow:0 2px 10px #0002}
h1{font-size:20px;margin:0 0 8px}p{color:#b3261e;font-weight:700}label{display:block;margin:14px 0 4px;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:6px;font-size:15px}
button{margin-top:18px;width:100%;padding:14px;border:0;border-radius:6px;background:#123e7c;color:#fff;font-size:16px}
</style></head><body><header>Example Bank &middot; بنك المثال</header><main><div class="card"><h1>Account verification</h1>
<p>Your account will be suspended within 24 hours unless you verify your details.</p>
<label>Customer ID</label><input value=""><label>Password</label><input type="password">
<label>One-time code (OTP)</label><input><button>Verify now</button></div></main></body></html>"""

FINE_PAGE = """<html><head><title>Example Roads Authority - Pay now</title><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff;color:#222}header{background:#0b6b4f;color:#fff;padding:16px 20px;font-weight:700;font-size:18px}
main{padding:20px}.fine{border:2px solid #c62828;border-radius:8px;padding:14px;margin-bottom:16px}.amt{font-size:30px;font-weight:700;color:#c62828}
input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border:1px solid #aaa;border-radius:6px}
button{width:100%;padding:14px;background:#0b6b4f;color:#fff;border:0;border-radius:6px;font-size:16px}
</style></head><body><header>Example Roads Authority &middot; هيئة الطرق المثال</header><main><div class="fine">
<div>Unpaid traffic fine &middot; مخالفة مرورية غير مدفوعة</div><div class="amt">AED 50</div>
<div>Pay today to avoid a AED 1,000 penalty and vehicle impound.</div></div>
<input placeholder="Card number"><input placeholder="MM/YY"><input placeholder="CVV"><button>Pay AED 50</button></main></body></html>"""

TELECOM_PAGE = """<html><head><title>Rewards</title><style>
body{margin:0;font-family:Arial,sans-serif;background:#4a148c;color:#fff}main{padding:24px}
h1{font-size:26px}.box{background:#fff;color:#222;border-radius:12px;padding:18px}
input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border:1px solid #aaa;border-radius:6px}
button{width:100%;padding:14px;background:#ff6f00;color:#fff;border:0;border-radius:6px;font-size:16px}
</style></head><body><main><h1>Example Telecom loyalty: claim 5,000 points</h1><div class="box">
<p>Confirm your card to receive your reward today.</p><input placeholder="Card number"><input placeholder="Expiry"><input placeholder="CVV">
<button>Claim reward</button></div></main></body></html>"""

BLOG_PAGE = """<html><head><title>Garden Notes</title><style>
body{margin:0;font-family:Georgia,serif;background:#fbf8f1;color:#333}header{padding:20px;font-size:24px;border-bottom:1px solid #ddd}
article{padding:20px;line-height:1.6}h2{font-size:20px}
</style></head><body><header>Garden Notes</header><article><h2>Five herbs that love the winter sun</h2>
<p>Mint, basil and coriander thrive on a shaded balcony from November to March. Water early in the morning and
keep the soil loose.</p><h2>Composting in small spaces</h2><p>A sealed bin under the sink is enough for a family of four.</p></article></body></html>"""


def render(html: str) -> bytes:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, java_script_enabled=False)
        page.set_content(html)
        png = page.screenshot(full_page=False, type="png")
        browser.close()
    return png


def thumb(png: bytes) -> bytes:
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("RGB")
    img = img.crop((0, 0, img.width, min(img.height, int(img.width * 1.6))))
    img.thumbnail((240, 480))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=78)
    return out.getvalue()


def stamp(dt):
    return {"utc": dt.isoformat(), "gst": dt.astimezone(timezone(timedelta(hours=4))).isoformat()}


EV = OUT / "evidence"
shutil.rmtree(EV, ignore_errors=True)
cases = []
for vid, live_html, engine_html, live_error in [
    (v1.id, BANK_PAGE, BANK_PAGE, None),
    ("b2c3d4e5f6a74b8c9d0e1f2a3b4c5d61", None, FINE_PAGE, "net::ERR_NAME_NOT_RESOLVED (site already taken down)"),
    (v7.id, BLOG_PAGE, TELECOM_PAGE, None),
]:
    v = next(x for x in verdicts if x["id"] == vid)
    captured = datetime.fromisoformat(v["created_at"]) + timedelta(seconds=40)
    ref = case_reference(vid)
    folder = EV / ref
    folder.mkdir(parents=True)
    files = {}
    if live_html:
        files["screenshot.png"] = render(live_html)
    files["screenshot_engine.png"] = render(engine_html)
    files["capture.html"] = engine_html.encode()
    d = v.get("domain") or {}
    files["takedown_request.txt"] = (f"Subject: Phishing report: {v['host'].replace('.', '[.]')} [case {ref}]\n\n"
                                     "Sample takedown request (demo data). See the real engine for a complete text.\n").encode()
    for name, data in files.items():
        (folder / name).write_bytes(data)
    (folder / "thumb.jpg").write_bytes(thumb(files.get("screenshot.png") or files["screenshot_engine.png"]))
    differs = live_html is not None and live_html != engine_html
    views = ({"compared": True, "differs": True, "similarity": 0.04, "notes": ["visible text overlaps only 4%", 'titles differ: live "Garden Notes" vs engine "Rewards"']}
             if differs else {"compared": live_html is not None, "differs": False if live_html else None, "similarity": 1.0 if live_html else None, "notes": []})
    brand = v.get("brand") or {}
    summary = {
        "case_ref": ref, "verdict_id": vid, "url": v["url"], "final_url": v["final_url"], "host": v["host"], "registered_domain": v["registered_domain"],
        "decision": v["decision"], "risk_score": v["risk_score"], "brand": brand.get("brand"), "brand_ar": brand.get("brand_ar"),
        "official_domains": brand.get("official_domains", []), "detected_at": stamp(datetime.fromisoformat(v["created_at"])),
        "captured_at": stamp(captured), "built_at": stamp(captured + timedelta(seconds=6)),
        "screenshots": {"live": {"file": "screenshot.png" if live_html else None, "error": live_error, "final_url": v["url"], "title": None, "user_agent": None},
                        "engine": {"file": "screenshot_engine.png", "error": None}},
        "views": views,
        "registration": {"registrar": d.get("registrar"), "registrar_iana_id": "9999", "created": d.get("created"), "age_days": d.get("age_days"),
                         "registrant": None, "registrant_country": d.get("registrant_country"), "nameservers": d.get("nameservers", []), "source": "rdap"},
        "hosting": {"ips": d.get("ips", []), "asn": d.get("asn"), "network": d.get("asn_org"), "country": d.get("hosting_country")},
        "tls": {"issuer": d.get("tls_issuer"), "not_before": None, "not_after": None, "sha256": None},
        "abuse_contacts": {"registrar": ["abuse@registrar.example"], "hosting": ["abuse@hosting.example"]},
        "files": [{"name": n, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for n, b in files.items()],
        "unavailable": {} if live_html else {"screenshot.png": live_error},
    }
    (folder / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    cases.append({"case_ref": ref, "verdict_ids": [vid], "host": v["host"], "url": v["url"], "decision": v["decision"], "risk_score": v["risk_score"],
                  "brand": brand.get("brand"), "brand_ar": brand.get("brand_ar"), "captured_at": captured.isoformat(), "built_at": captured.isoformat(),
                  "live": live_html is not None, "engine_view": True, "views_differ": views["differs"], "thumbnail": True})
cases.sort(key=lambda c: c["captured_at"], reverse=True)
(OUT / "evidence.json").write_text(json.dumps(cases, ensure_ascii=False, indent=1))
print(len(cases), "evidence cases")
