"""Ready-to-send takedown texts: an abuse report for the registrar / host / CDN and an Arabic report for UAE
authorities. Field set follows docs/research/industry.md section 4 (NetBeacon fields and the Registrar
Stakeholder Group guide: specific URLs, screenshots, date and time with time zone, reporter identity).
"""

from __future__ import annotations

from datetime import timezone

from . import labels
from .channels import CLOUDFLARE_ABUSE, NETBEACON, UAE_CHANNELS
from .facts import defang, to_gst
from .report import CaseFile

REPORTER_EN = """Reporter (to be completed by the filing officer):
  Name:
  Organisation / unit:
  Email:
  Phone:"""

REPORTER_AR = """بيانات مقدّم البلاغ (يستكملها الموظف المختص):
  الاسم:
  الجهة / الإدارة:
  البريد الإلكتروني:
  الهاتف:"""


def _abuse_type(case: CaseFile) -> tuple[str, str]:
    v = case.verdict
    page = v.page
    asks_credentials = any(f.asks_password or f.asks_card or f.asks_otp for f in page.forms) if page else False
    if v.brand or asks_credentials:
        return "Phishing", "تصيّد احتيالي (انتحال جهة موثوقة لسرقة البيانات)"
    return "Fraud / scam website", "موقع احتيالي"


def _behind_cloudflare(case: CaseFile) -> bool:
    d = case.verdict.domain
    owners = " ".join(filter(None, [case.network_owner, *(n.name or "" for n in case.networks)])).lower()
    nameservers = (d.nameservers if d else []) or case.registration.nameservers
    return "cloudflare" in owners or any(ns.endswith("cloudflare.com") for ns in nameservers)


def _when(case: CaseFile) -> tuple[str, str]:
    gst = to_gst(case.verdict.created_at)
    utc = gst.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%d %H:%M:%S} UTC", f"{gst:%Y-%m-%d %H:%M:%S} GST (UTC+4)"


def _urls(case: CaseFile) -> list[str]:
    v = case.verdict
    urls = [v.url]
    for hop in v.redirect_chain:
        if hop.url not in urls:
            urls.append(hop.url)
    if v.final_url and v.final_url not in urls:
        urls.append(v.final_url)
    return urls


def english(case: CaseFile) -> str:
    v = case.verdict
    abuse_type, _ = _abuse_type(case)
    utc, gst = _when(case)
    domain = case.domain or case.host
    to = []
    if case.registrar_abuse:
        to.append(f"{case.registrar or 'Registrar'} abuse desk <{', '.join(case.registrar_abuse)}>")
    if case.hosting_abuse:
        to.append(f"{case.network_owner or 'Hosting provider'} abuse desk <{', '.join(case.hosting_abuse)}>")
    if _behind_cloudflare(case):
        to.append(f"Cloudflare abuse form ({CLOUDFLARE_ABUSE}); quote the specific URLs below")
    if not case.registrar_abuse and not case.hosting_abuse:
        to.append("No abuse contact was published for the registrar or the hosting provider; "
                  f"file through NetBeacon ({NETBEACON}), which routes reports to the registrar, "
                  "and through the UAE reporting channels listed in the Arabic report")
    subject = f"{abuse_type} report: {defang(domain)}" + (f" impersonating {v.brand.brand}" if v.brand else "")
    subject += f" [case {case.case_ref}]"

    findings = [f"  - {r.title_en} ({labels.SEVERITY[r.severity.value][0].lower()}, {r.points:+.0f})"
                for r in sorted(v.reasons, key=lambda r: -r.points)]
    hosting = ", ".join(case.ips) or "not resolved"
    if v.domain and v.domain.asn:
        hosting += f" (AS{v.domain.asn} {case.network_owner or ''})".rstrip()
    elif case.network_owner:
        hosting += f" ({case.network_owner})"

    lines = [
        "To: " + "\n    ".join(to),
        f"Subject: {subject}",
        "",
        "Hello,",
        "",
        f"We report a website engaged in {abuse_type.lower()} and ask that you suspend the domain or remove the",
        "content under your abuse policy, and preserve related account and access logs for law enforcement.",
        "",
        f"Domain:               {defang(domain)}",
        f"Abuse type:           {abuse_type}",
        "Specific URLs (defanged; exact URLs are in verdict.json):",
        *[f"  - {defang(u)}" for u in _urls(case)],
        f"Date and time of abuse (first observed): {utc} / {gst}",
        f"Registrar:            {case.registrar or 'unknown'}"
        + (f" (IANA ID {case.registration.registrar_iana_id})" if case.registration.registrar_iana_id else ""),
        f"Hosting:              {hosting}",
        f"Automated risk score: {v.risk_score:.0f}/100, decision {v.decision.value}",
    ]
    if v.brand:
        lines.append(f"Impersonated brand:   {v.brand.brand}; its genuine domains are "
                     f"{', '.join(v.brand.official_domains) or 'not listed'}. The reported domain is not one of them.")
    if v.review:
        outcome_en, _ = labels.REVIEW_OUTCOME[v.review.outcome.value]
        lines.append(f"Independent re-check: {outcome_en} ({v.review.confidence * 100:.0f}% confidence)")
    lines += ["", "Description:", f"  {v.summary_en}" if v.summary_en else "  See findings below.", "", "Findings:"]
    lines += findings or ["  - see attached report"]
    lines += [
        "",
        "Supporting evidence (attached; SHA-256 of each file in manifest.json):",
        *[f"  - {name}: {labels.FILES[name][0]}" for name in case.attachments],
        "",
        REPORTER_EN,
        "",
        f"Case reference: {case.case_ref}",
        "",
        "Prepared with Mirsad (مرصاد) from an automated investigation; it has not been sent automatically.",
    ]
    return "\n".join(lines) + "\n"


def arabic(case: CaseFile) -> str:
    v = case.verdict
    _, abuse_type_ar = _abuse_type(case)
    utc, gst = _when(case)
    domain = case.domain or case.host
    decision_ar = labels.DECISION[v.decision.value][1]
    lines = [
        "إلى: الجهة المختصة بمكافحة الجرائم الإلكترونية",
        f"الموضوع: بلاغ عن موقع احتيالي — {defang(domain)} — رقم القضية {case.case_ref}",
        "",
        "السلام عليكم ورحمة الله وبركاته،",
        "",
        f"نرفع إليكم بلاغاً عن موقع إلكتروني يُشتبه في استخدامه لغرض: {abuse_type_ar}.",
        "ونرجو التكرّم باتخاذ الإجراءات اللازمة للتحقيق، وطلب حجب الموقع عبر هيئة تنظيم الاتصالات والحكومة الرقمية،",
        "ومخاطبة جهة التسجيل ومزوّد الاستضافة لإيقافه.",
        "",
        f"النطاق: {defang(domain)}",
        "الروابط (معطّلة لمنع فتحها؛ الروابط الكاملة في الملف verdict.json):",
        *[f"  - {defang(u)}" for u in _urls(case)],
        f"تاريخ ووقت الرصد الأول: {gst} / {utc}",
        f"القرار الآلي: {decision_ar} — درجة الخطورة {v.risk_score:.0f} من 100",
        f"جهة التسجيل: {case.registrar or 'غير معروفة'}",
        f"عناوين الاستضافة: {', '.join(case.ips) or 'لم تُحلّ'}"
        + (f" ({labels.PRIVATE_HOSTING[1]})" if case.hosting_private else f" ({case.network_owner})" if case.network_owner else ""),
    ]
    if case.age_days is not None:
        lines.append(f"عمر النطاق: {case.age_days} يوم")
    if v.brand:
        lines.append(f"الجهة المنتحَلة: {v.brand.brand_ar or v.brand.brand} — نطاقاتها الرسمية: "
                     f"{', '.join(v.brand.official_domains) or 'غير مدرجة'}، والنطاق المُبلَّغ عنه ليس منها.")
    if v.review:
        lines.append(f"المراجعة المستقلة: {labels.REVIEW_OUTCOME[v.review.outcome.value][1]} "
                     f"(درجة الثقة {v.review.confidence * 100:.0f}٪)")
    if v.summary_ar:
        lines += ["", "الملخص:", f"  {v.summary_ar}"]
    lines += ["", "المؤشرات:"]
    lines += [f"  - {r.title_ar or r.title_en} ({labels.SEVERITY[r.severity.value][1]}، {r.points:+.0f})"
              for r in sorted(v.reasons, key=lambda r: -r.points)] or ["  - انظر التقرير المرفق"]
    lines += [
        "",
        "الأدلة المرفقة (بصمة SHA-256 لكل ملف في manifest.json):",
        *[f"  - {name}: {labels.FILES[name][1]}" for name in case.attachments],
        "",
        "قنوات الإبلاغ المتاحة (للاستخدام من قبل الموظف المختص؛ لم يُرسَل هذا البلاغ آلياً):",
    ]
    for ch in UAE_CHANNELS:
        lines += [f"  - {ch['name_ar']}: {ch['contact_ar']}", f"    النطاق: {ch['scope_ar']}", f"    المصدر: {ch['source']}"]
    lines += ["", REPORTER_AR, "", f"رقم مرجع القضية: {case.case_ref}", "",
              "أُعدّ هذا البلاغ بواسطة مرصاد من فحص آلي، ولم يُرسَل آلياً."]
    return "\n".join(lines) + "\n"
