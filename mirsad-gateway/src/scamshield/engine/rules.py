"""Explainable rules and score fusion.

Every finding is a `Reason` with signed `points`. The risk score is a logistic squash of their sum:

    total = BASE_POINTS + sum(reason.points)        # models contribute points = weight * logit(p)
    risk  = 100 / (1 + exp(-total / SCALE))         # 0..100, monotonic in every contribution
    decision from config.WARN_THRESHOLD / BLOCK_THRESHOLD, then the trust guards below

Hard rules (see `assess`) sit on top: a reviewer's overturn wins, confirmed impersonation blocks, the URL
model alone never blocks, an allowlisted domain never goes above warn, and an established domain is
blocked only on a critical finding or two independent high-severity ones.
A guard is itself a `Reason`, so the score always equals the sum of the listed contributions.

The weights below are defaults. A fitted stacker (logistic regression over model logits and rule flags)
can overwrite them by writing `fusion_weights.json` into `config.MODEL_DIR`:
    {"base_points": -20, "scale": 15, "model_weights": {"model.url": 3.0}, "points": {"page.card_form": 18}}
"""

from __future__ import annotations

import difflib
import ipaddress
import json
import logging
import math
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Optional
from urllib.parse import unquote, urlsplit

import tldextract

from scamshield import config
from scamshield.intel import lists
from scamshield.schemas import BrandMatch, Decision, DomainIntel, PageSnapshot, Reason, Severity, Verdict

S = Severity

# code: (severity, points, title_en, title_ar). Titles may carry {placeholders} filled per finding.
RULES: dict[str, tuple[Severity, float, str, str]] = {
    "rep.allowlisted": (S.INFO, -60, "Verified official domain", "نطاق رسمي موثّق"),
    "rep.blocklisted": (S.CRITICAL, 60, "Listed on threat-intelligence blocklists", "مدرج في قوائم حظر استخبارات التهديدات"),
    "url.ip_host": (S.HIGH, 16, "Address uses a raw IP instead of a domain name", "يستخدم العنوان رقم IP بدلاً من اسم نطاق"),
    "url.punycode": (S.MEDIUM, 10, "Internationalised domain name that can imitate another name", "اسم نطاق بأحرف دولية قد يقلّد اسماً آخر"),
    "url.many_subdomains": (S.MEDIUM, 7, "Unusually long chain of subdomains", "سلسلة طويلة غير معتادة من النطاقات الفرعية"),
    "url.brand_in_subdomain": (S.HIGH, 16, 'Brand name "{brand}" used in the subdomain of an unrelated site', 'استخدام اسم العلامة "{brand}" في نطاق فرعي لموقع غير تابع لها'),
    "url.machine_subdomain": (S.LOW, 5, "Machine-generated subdomain, typical of throwaway phishing hosts", "نطاق فرعي مولّد آلياً، شائع في مواقع التصيّد المؤقتة"),
    "url.cms_internal_path": (S.MEDIUM, 8, "Page hidden inside a website's internal software folders (compromised site)", "صفحة مخبأة داخل مجلدات برمجيات الموقع الداخلية (موقع مخترق)"),
    "url.brand_country_lookalike": (S.HIGH, 14, 'Brand name "{brand}" under a foreign ".com.xx" suffix', 'اسم العلامة "{brand}" تحت امتداد دولة غير تابع لها'),
    "url.brand_in_domain": (S.MEDIUM, 10, 'Brand name "{brand}" stitched into an unrelated domain name', 'اسم العلامة "{brand}" مدمج في اسم نطاق غير تابع لها'),
    "url.brand_in_path": (S.MEDIUM, 7, 'Brand name "{brand}" in the path of an unrelated site', 'ورود اسم العلامة "{brand}" في مسار موقع غير تابع لها'),
    "url.suspicious_tld": (S.LOW, 6, 'Domain ending ".{tld}" is heavily abused by scammers', 'امتداد النطاق ".{tld}" يكثر استغلاله في الاحتيال'),
    "url.userinfo_trick": (S.HIGH, 16, '"@" in the address hides the real destination', 'وجود "@" في العنوان يخفي الوجهة الحقيقية'),
    "url.shortener": (S.LOW, 5, "Link shortener hides the real destination", "رابط مختصر يخفي الوجهة الحقيقية"),
    "url.shared_hosting": (S.LOW, 6, "Hosted on a free site builder where anyone can publish", "مستضاف على منصة مجانية لإنشاء المواقع يمكن لأي شخص النشر عليها"),
    "url.lure_keywords": (S.LOW, 5, 'Address contains lure words: "{words}"', 'يحتوي العنوان على كلمات استدراج: "{words}"'),
    "url.many_hyphens": (S.LOW, 4, "Domain name stitched together with many hyphens", "اسم نطاق مركّب من كلمات كثيرة تفصلها شرطات"),
    "url.no_tls": (S.LOW, 4, "Connection is not encrypted (no HTTPS)", "الاتصال غير مشفّر (بدون HTTPS)"),
    "url.nonstandard_port": (S.LOW, 5, "Uses an unusual network port ({port})", "يستخدم منفذ شبكة غير معتاد ({port})"),
    "domain.newly_registered": (S.HIGH, 20, "Domain registered only {days_en} ago", "تم تسجيل النطاق قبل {days_ar} فقط"),
    "domain.young": (S.MEDIUM, 9, "Domain is less than six months old ({days_en})", "عمر النطاق أقل من ستة أشهر ({days_ar})"),
    "domain.established": (S.INFO, -10, "Domain has existed for over two years", "النطاق موجود منذ أكثر من عامين"),
    "domain.long_established": (S.INFO, -16, "Domain has existed for {years_en}", "النطاق مسجّل منذ {years_ar}"),
    "domain.popular_top": (S.INFO, -25, "Among the world's most visited sites (rank {rank})", "من أكثر المواقع زيارة في العالم (الترتيب {rank})"),
    "domain.popular": (S.INFO, -14, "Widely visited site (rank {rank})", "موقع واسع الانتشار (الترتيب {rank})"),
    "domain.known": (S.INFO, -6, "Appears in global popularity rankings (rank {rank})", "يظهر في تصنيفات الشعبية العالمية (الترتيب {rank})"),
    "domain.lookalike": (S.HIGH, 36, "Imitates {brand} ({technique})", "ينتحل صفة {brand_ar} ({technique_ar})"),
    "tls.new_certificate": (S.LOW, 4, "Security certificate issued {days_en} ago", "صدرت شهادة الأمان قبل {days_ar}"),
    "tls.organisation_validated": (S.INFO, -8, "Certificate verifies the organisation's identity", "الشهادة تتحقق من هوية الجهة المالكة"),
    "page.long_redirect_chain": (S.LOW, 5, "Passes through {hops} redirects before landing", "يمرّ عبر {hops} عمليات إعادة توجيه قبل الوصول"),
    "page.cross_domain_redirect": (S.LOW, 5, "Redirects to a different website ({final})", "يعيد التوجيه إلى موقع مختلف ({final})"),
    "page.client_side_redirect": (S.LOW, 5, "Uses script or meta-refresh redirects", "يستخدم إعادة توجيه عبر سكربت أو وسم meta"),
    "page.shortener_in_chain": (S.LOW, 6, "Redirect chain passes through a link shortener", "تمر سلسلة إعادة التوجيه عبر رابط مختصر"),
    "page.password_form": (S.MEDIUM, 8, "Asks for a password", "يطلب كلمة المرور"),
    "page.card_form": (S.HIGH, 18, "Asks for payment card details", "يطلب بيانات البطاقة المصرفية"),
    "page.otp_form": (S.HIGH, 12, "Asks for a one-time password (OTP)", "يطلب رمز التحقق لمرة واحدة (OTP)"),
    "page.national_id_form": (S.HIGH, 14, "Asks for an Emirates ID or national ID number", "يطلب رقم الهوية الإماراتية أو الهوية الوطنية"),
    "page.external_form_action": (S.HIGH, 14, "Sends the entered details to another server ({host})", "يرسل البيانات المدخلة إلى خادم آخر ({host})"),
    "page.obfuscated_scripts": (S.HIGH, 14, "Deliberately scrambled scripts on a low-reputation site", "سكربتات مموّهة عمداً على موقع منخفض السمعة"),
    "page.obfuscated_scripts_minor": (S.LOW, 2, "Scrambled scripts (common on large or unknown sites)", "سكربتات مموّهة (شائعة في المواقع الكبيرة أو غير المعروفة)"),
    "page.credential_capture": (S.HIGH, 14, "Script captures what you type and sends it to another server", "سكربت يلتقط ما تكتبه ويرسله إلى خادم آخر"),
    "page.wallet_drainer": (S.CRITICAL, 30, "Crypto wallet drainer code", "شيفرة لسرقة محافظ العملات الرقمية"),
    "page.clipboard_hijack": (S.HIGH, 12, "Tampers with the clipboard (e.g. swaps payment addresses)", "يعبث بالحافظة (مثل تبديل عناوين الدفع)"),
    "page.browser_lock": (S.HIGH, 14, "Traps the browser (blocks the back button or forces full screen)", "يحتجز المتصفح (يمنع زر الرجوع أو يفرض ملء الشاشة)"),
    "page.cloaking_code": (S.MEDIUM, 7, "Hides from security scanners ({markers})", "يتخفّى عن أدوات الفحص الأمني ({markers})"),
    "page.cloaking_divergence": (S.HIGH, 18, "Shows security scanners a different page than phone users ({signals})", "يعرض على أدوات الفحص صفحة مختلفة عما يراه مستخدمو الهاتف ({signals})"),
    "page.exfiltration": (S.CRITICAL, 30, "Sends data to a known data-theft channel ({channel})", "يرسل البيانات إلى قناة معروفة لسرقة البيانات ({channel})"),
    "page.form_relay": (S.MEDIUM, 8, "Submits form data through a third-party relay ({channel})", "يرسل بيانات النموذج عبر خدمة وسيطة خارجية ({channel})"),
    "page.visitor_profiling": (S.LOW, 4, "Looks up the visitor's IP and location, as phishing kits do", "يستعلم عن عنوان IP وموقع الزائر كما تفعل أدوات التصيّد"),
    "page.empty_shell": (S.LOW, 6, "Nearly empty page on a young or unknown domain", "صفحة شبه فارغة على نطاق حديث أو غير معروف"),
    "page.urgency": (S.MEDIUM, 8, "Pressure wording: {words}", "عبارات ضغط واستعجال: {words}"),
    "page.payment_lure": (S.MEDIUM, 10, "Payment or prize lure: {words}", "إغراء بالدفع أو الجوائز: {words}"),
    "page.brand_hosting_mismatch": (S.LOW, 5, "Claims to be {brand} but is hosted abroad ({country})", "يدّعي أنه {brand_ar} لكنه مستضاف خارج الدولة ({country})"),
    "page.fee_bait": (S.HIGH, 14, "Small fee of AED {amount} paired with a penalty or deadline threat", "رسوم صغيرة بقيمة {amount} درهم مقرونة بتهديد بغرامة أو مهلة"),
    "page.sensitive_form_off_brand": (S.HIGH, 16, "Asks for {fields} while posing as {brand} on a domain it does not own", "يطلب {fields_ar} منتحلاً صفة {brand_ar} على نطاق لا يملكه"),
    "page.cloaking_bounce": (S.HIGH, 16, "Brand-new domain bounces to a well-known site ({final}), a cloaking trick", "نطاق جديد يعيد التوجيه إلى موقع معروف ({final})، وهي حيلة تمويه"),
    "page.tld_campaign_combo": (S.HIGH, 12, 'Cheap ".{tld}" domain with fine, toll or parcel-fee wording', 'نطاق رخيص بامتداد ".{tld}" مع عبارات مخالفات أو رسوم طرق أو شحنات'),
    "page.provider_warning": (S.CRITICAL, 30, "The hosting network itself warns this site is {what}", "شبكة الاستضافة نفسها تحذّر من أن هذا الموقع {what_ar}"),
    "page.taken_down": (S.MEDIUM, 8, "The hosting platform has removed this site", "أزالت منصة الاستضافة هذا الموقع"),
    "page.addresses_reviewers": (S.HIGH, 14, 'Page text speaks to automated scanners or AI reviewers ("{words}")', 'نص الصفحة يخاطب أدوات الفحص الآلي أو المراجع الذكي ("{words}")'),
    "page.gambling": (S.HIGH, 14, "Serves online-gambling content ({words})", "يعرض محتوى قمار إلكتروني ({words})"),
    "page.sign_in_title": (S.MEDIUM, 6, 'Sign-in page on a low-reputation site ("{words}")', 'صفحة تسجيل دخول على موقع منخفض السمعة ("{words}")'),
    "page.brand_title_mismatch": (S.HIGH, 12, 'Page presents itself as "{brand}" on a site that is not theirs', 'تقدّم الصفحة نفسها على أنها "{brand}" على موقع لا يتبع لها'),
    "page.tls_error": (S.MEDIUM, 10, "Invalid security certificate: a browser would warn here ({error})", "شهادة أمان غير صالحة: سيُظهر المتصفح تحذيراً هنا ({error})"),
    "page.unreachable": (S.INFO, 0, "Page could not be fetched", "تعذّر جلب الصفحة"),
    "page.unchanged": (S.INFO, 0, "Page unchanged since the last check; previous analysis reused", "لم تتغير الصفحة منذ آخر فحص؛ أُعيد استخدام التحليل السابق"),
    "host.infrastructure_changed": (S.MEDIUM, 8, "Hosting or name servers changed since last seen ({what})", "تغيّرت الاستضافة أو خوادم الأسماء منذ آخر فحص ({what})"),
    "host.content_changed": (S.LOW, 3, "Page content changed substantially since the last check", "تغيّر محتوى الصفحة بشكل كبير منذ آخر فحص"),
    "model.url": (S.INFO, 0, "URL model: {pct}% likely a scam", "نموذج تحليل الرابط: احتمال الاحتيال {pct}٪"),
    "model.page": (S.INFO, 0, "Page model: {pct}% likely a scam", "نموذج تحليل الصفحة: احتمال الاحتيال {pct}٪"),
    "llm.judge": (S.INFO, 0, "AI judge: {pct}% likely a scam", "الحَكَم الذكي: احتمال الاحتيال {pct}٪"),
    "trust.block_guard": (S.INFO, 0, "Established domain: weak signals alone cannot block it", "نطاق راسخ: لا تكفي المؤشرات الضعيفة وحدها لحظره"),
    "trust.allowlist_guard": (S.INFO, 0, "Verified official domain is never blocked", "النطاق الرسمي الموثّق لا يُحظر أبداً"),
    "trust.llm_bounded": (S.INFO, 0, "The AI judge alone cannot move a site across a decision threshold", "لا يستطيع الحَكَم الذكي وحده نقل الموقع إلى قرار أشد"),
    "trust.needs_corroboration": (S.INFO, 0, "Only weak or generic signs, none corroborated: no warning", "مؤشرات ضعيفة أو عامة فقط ولا يؤكدها دليل آخر: لا تحذير"),
    "trust.needs_specific_finding": (S.INFO, 0, "No specific scam evidence yet, so at most a warning", "لا يوجد دليل احتيال محدد بعد، لذا يقتصر الأمر على تحذير"),
    "rule.models_agree_floor": (S.MEDIUM, 0, "Both independent models are confident this is a scam", "النموذجان المستقلان واثقان من أنه احتيال"),
    "page.parked": (S.LOW, 6, "Domain expired or parked for sale: no real site behind it", "النطاق منتهي الصلاحية أو معروض للبيع: لا يوجد موقع فعلي خلفه"),
    "page.unrelated_redirect": (S.MEDIUM, 8, "Recently registered name that forwards visitors to an unrelated site ({final})", "اسم سُجّل حديثاً ويحوّل الزوار إلى موقع لا علاقة له به ({final})"),
    "page.harmful_redirect": (S.HIGH, 20, "Sends visitors to a gambling, adult or pill site ({final}): a taken-over domain", "يحوّل الزوار إلى موقع قمار أو محتوى للبالغين أو أدوية ({final}): نطاق مستولى عليه"),
    "rule.takeover_block": (S.CRITICAL, 0, "A business domain taken over to send visitors to a harmful site", "نطاق تجاري مستولى عليه لتحويل الزوار إلى موقع ضار"),
    "rule.unrelated_redirect_floor": (S.MEDIUM, 0, "A recently registered name forwarding to an unrelated site: at least a warning", "اسم مسجّل حديثاً يحوّل إلى موقع غير ذي صلة: تحذير على الأقل"),
    "rule.parked_floor": (S.LOW, 0, "Expired or parked domain: shown as a warning, not a scam", "نطاق منتهي أو متوقف: يظهر كتحذير وليس احتيالاً"),
    "rule.compromised_site_floor": (S.MEDIUM, 0, "Phishing-style page hidden in a website's software folders: the site looks compromised", "صفحة تشبه التصيّد مخبأة في مجلدات برمجيات الموقع: يبدو أن الموقع مخترق"),
    "rule.lookalike_floor": (S.MEDIUM, 0, "Look-alike of a registered brand: at least a warning", "يشبه علامة تجارية مسجّلة: تحذير على الأقل"),
    "rule.impersonation_block": (S.CRITICAL, 0, "Confirmed impersonation: brand on a domain it does not own, collecting sensitive data", "انتحال مؤكد: علامة تجارية على نطاق لا تملكه تجمع بيانات حساسة"),
    "review.confirmed": (S.INFO, 0, "Second-opinion review confirmed the block", "أكّدت المراجعة الثانية قرار الحظر"),
    "review.overturned": (S.INFO, 0, "Second-opinion review found a false positive and unblocked the site", "وجدت المراجعة الثانية أن الحظر خاطئ فأُلغي حظر الموقع"),
    "review.downgraded": (S.INFO, 0, "Second-opinion review downgraded the block to a warning", "خفّضت المراجعة الثانية الحظر إلى تحذير"),
    "review.inconclusive": (S.INFO, 0, "Second-opinion review was inconclusive; the block stands", "لم تحسم المراجعة الثانية الأمر؛ يبقى الحظر قائماً"),
    "deep.revoked": (S.CRITICAL, 0, "Allowed earlier, blocked after deeper inspection of {url}", "سُمح به سابقاً ثم حُظر بعد فحص أعمق للصفحة {url}"),
    "engine.component_error": (S.INFO, 0, "Check skipped: {component} unavailable", "تم تخطي فحص: {component} غير متاح"),
}

BASE_POINTS = -20.0  # no evidence at all -> risk ~21 (allow)
SCALE = 15.0  # points per unit of log-odds
MODEL_WEIGHTS = {"model.url": 3.0, "model.page": 5.0, "llm.judge": 4.0}  # points per unit of logit(p)
NEGATIVE_MODEL_FACTOR = 0.5
LLM_MAX_POINTS = 6.0  # the LLM judge's largest contribution; it never decides a threshold on its own  # models are better at spotting scams than vouching for sites
LOOKALIKE_MAX_POINTS = 36.0
IMPERSONATION_RISK = 95.0
REREGISTERED_DAYS = 365
RELATED_NAME_CHARS = 6  # a shared run this long between two names means the same business  # a registration this recent on a forwarding business name suggests a lapsed-and-bought domain
UNCERTAIN_RISK = 25.0  # an allow at or above this risk, with nothing vouching for the site, is "new to us"
MODELS_AGREE_P = 0.9  # mean of the two models
MODELS_AGREE_MIN_P = 0.8  # and neither below this
URL_SURE_P = 0.9
FEE_WINDOW = 160  # characters either side of a small AED amount searched for a penalty threat
GUARD_PREFIXES = ("trust.", "rule.")
ESTABLISHED_AGE_DAYS = 365
ESTABLISHED_RANK = 100_000
# Domain and certificate age bands (days) and popularity bands (Tranco rank).
NEW_DOMAIN_DAYS = 30
RECENT_DOMAIN_DAYS = 60
YOUNG_DOMAIN_DAYS = 180
OLD_DOMAIN_DAYS = 2 * 365
VERY_OLD_DOMAIN_DAYS = 5 * 365
NEW_CERT_DAYS = 3
FRESH_CERT_DAYS = 14
TOP_RANK = 10_000
KNOWN_RANK = 1_000_000
FEE_MAX_AED = 50  # a payment this small next to a penalty threat is fee bait
SHORT_PAGE_CHARS = 80  # visible text below this is an empty shell

WEIGHTS_FILE = config.MODEL_DIR / "fusion_weights.json"


def _load_fitted_weights() -> None:
    """Overlay weights fitted on benchmark data, if present."""
    global BASE_POINTS, SCALE
    if not WEIGHTS_FILE.exists():
        return
    try:
        fitted = json.loads(WEIGHTS_FILE.read_text())
        BASE_POINTS = float(fitted.get("base_points", BASE_POINTS))
        SCALE = float(fitted.get("scale", SCALE))
        MODEL_WEIGHTS.update({k: float(v) for k, v in fitted.get("model_weights", {}).items() if k in MODEL_WEIGHTS})
        for code, points in fitted.get("points", {}).items():
            if code in RULES:
                sev, _, en, ar = RULES[code]
                RULES[code] = (sev, float(points), en, ar)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        logging.getLogger(__name__).warning("ignoring %s: %s", WEIGHTS_FILE, exc)


_load_fitted_weights()

SUSPICIOUS_TLDS = lists.wordset("tlds", "suspicious_tlds_scored")
SHORTENERS = lists.wordset("platforms", "shorteners_scored")
SHARED_HOSTING = lists.words("platforms", "shared_hosting_scored")
_MACHINE_LABEL = re.compile(r"^(?=[0-9a-f]*\d)[0-9a-f]{8,}$|^\d{1,3}(?:-\d{1,3}){3}$|\d{5,}")
_ERROR_TITLE = re.compile(r"\b(?:error|404|403|500|not found|forbidden|unavailable)\b", re.I)
_CMS_PATH = re.compile(r"/(?:wp-content|wp-includes|wp-admin|\.well-known|cgi-bin)/(?!uploads/)[^?#]*(?:\.(?:php|html?)\b|/(?:$|\?))", re.I)
# Word lists (intel/data/lexicon.json) are matched after fold(); service hosts in intel/data/services.json.
BRAND_KEYWORDS = lists.mapping("lexicon", "url_brand_keywords")
URL_LURE_WORDS = lists.words("lexicon", "url_lure_words")
SIGN_IN_TITLE_WORDS = lists.words("lexicon", "sign_in_title_words")
GAMBLING_WORDS = lists.words("lexicon", "gambling_words")
REVIEWER_ADDRESS_PHRASES = lists.words("lexicon", "reviewer_address_phrases")
HARMFUL_DESTINATION_WORDS = lists.wordset("lexicon", "harmful_destination_words")
HARMFUL_DESTINATION_TLDS = lists.wordset("lexicon", "harmful_destination_tlds")
URGENCY_WORDS = lists.words("lexicon", "urgency_phrases")
PAYMENT_LURE_WORDS = lists.words("lexicon", "payment_lure_phrases")
CAMPAIGN_WORDS = lists.words("lexicon", "campaign_phrases")
PENALTY_WORDS = lists.words("lexicon", "penalty_phrases")
EXFIL_CHANNELS = lists.mapping("services", "exfil_channels")
FORM_RELAYS = lists.mapping("services", "form_relays")
BUSINESS_FORM_HOSTS = lists.wordset("services", "business_form_hosts")
PROFILING_ENDPOINTS = lists.words("services", "profiling_endpoints")
# Labels from engine.jsanalysis ScriptFinding.suspicious_calls (prefix before ":" for host-tagged ones).
SCRIPT_SIGNALS = {
    "telegram_bot_api": "page.exfiltration", "discord_webhook": "page.exfiltration",
    "webhook_exfiltration": "page.exfiltration", "keystroke_capture": "page.credential_capture",
    "reads_credential_fields": "page.credential_capture", "form_action_rewrite": "page.credential_capture", "wallet_drainer": "page.wallet_drainer",
    "clipboard_hijack": "page.clipboard_hijack", "back_button_trap": "page.browser_lock",
    "fullscreen_lock": "page.browser_lock", "bot_detection": "page.cloaking_code",
    "devtools_block": "page.cloaking_code", "disable_right_click": "page.cloaking_code",
    "ip_geolocation_lookup": "page.visitor_profiling",
}
PROVIDER_WARNINGS = {title: tuple(v) for title, v in lists.mapping("lexicon", "provider_warnings").items()}
PARKING_HOSTS = lists.wordset("services", "parking_hosts")
PARKED_MARKERS = lists.words("lexicon", "parked_markers")
TAKEDOWN_MARKERS = lists.words("lexicon", "takedown_markers")
# Tricks that legitimate ad and anti-bot scripts also use; only first-party scripts count for these.
REPUTATION_GATED = frozenset({"page.browser_lock", "page.cloaking_code", "page.clipboard_hijack", "page.wallet_drainer",
                              "page.visitor_profiling"})
DATA_THEFT_SIGNALS = frozenset({"page.exfiltration", "page.credential_capture"})
BEHAVIOUR_SIGNALS = frozenset({"page.browser_lock", "page.cloaking_code", "page.clipboard_hijack", "page.visitor_profiling"})
# Client-side gates that show the scam only to real victims (matched on inline HTML/JS).
# A check only counts when it gates a redirect or a content swap; plain sniffing is everyday analytics.
_SWAP = r"[^<]{0,300}?(?:location(?:\.href)?\s*=[^=]|location\.(?:replace|assign)\(|document\.write|innerHTML\s*=[^=])"
_BOTS = r"(?:bot|crawl|spider|headless|lighthouse|phantom)"
CLOAKING_PATTERNS = {
    "user_agent_gate": re.compile(rf"(?:navigator\.userAgent[^;]{{0,160}}{_BOTS}|{_BOTS}[^;]{{0,160}}navigator\.userAgent){_SWAP}", re.I),
    "webdriver_gate": re.compile(rf"navigator\.webdriver{_SWAP}", re.I),
    "referrer_gate": re.compile(rf"document\.referrer[^;]{{0,100}}(?:indexOf|includes|match|search|===?|!==?){_SWAP}", re.I),
    "interaction_gate": re.compile(rf"addEventListener\(\s*['\"](?:mousemove|touchstart|pointermove)['\"]{_SWAP}", re.I),
}
TECHNIQUE_AR = {
    "typosquat": "تحريف إملائي للاسم", "homoglyph": "أحرف متشابهة الشكل", "combosquat": "دمج الاسم بكلمات أخرى",
    "subdomain": "استخدام نطاق فرعي", "content": "محتوى الصفحة", "favicon": "أيقونة الموقع",
}
ORG_CERT_MARKERS = (" OV ", "OV SSL", "Organization Validat", " EV ", "EV SSL", "Extended Validation")


_EXTRACT = tldextract.TLDExtract(suffix_list_urls=())
_AR_DIACRITICS = re.compile(r"[ً-ْـ]")
_AR_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ؤ": "و", "ئ": "ي", "ة": "ه",
                          **{chr(0x0660 + d): str(d) for d in range(10)}})
_AMOUNT = r"(?<![\d.,])(\d{1,2}(?:\.\d{1,2})?)(?![\d]|[.,]\d|\s*(?:k\b|m\b|million|billion|مليون|الف|ألف))"
_SMALL_AED = re.compile(rf"(?:\baed|\bdhs?|\bdirhams?|درهم|د\.ا)\s*{_AMOUNT}|{_AMOUNT}\s*(?:aed\b|dhs?\b|dirhams?\b|درهم|د\.ا)")


@dataclass(frozen=True)
class ParsedURL:
    url: str
    scheme: str
    host: str
    port: Optional[int]
    registered_domain: str
    subdomain: str
    suffix: str
    path: str
    userinfo: bool
    is_ip: bool
    is_idn: bool


@lru_cache(maxsize=8192)
def parse_url(raw: str) -> ParsedURL:
    """Normalise a user-supplied URL (default https, ASCII host) and split it into parts."""
    text = raw.strip()
    if "://" not in text[:12]:
        text = "https://" + text
    parts = urlsplit(text)
    host = (parts.hostname or "").rstrip(".").lower()
    is_idn = any(ord(c) > 127 for c in host)
    if is_idn:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            pass
    is_idn = is_idn or any(label.startswith("xn--") for label in host.split("."))
    try:
        ipaddress.ip_address(host.strip("[]"))
        is_ip = True
    except ValueError:
        is_ip = False
    try:
        port = parts.port
    except ValueError:
        port = None
    ext = _EXTRACT(host)
    registered = host if is_ip else (f"{ext.domain}.{ext.suffix}" if ext.domain and ext.suffix else host)
    shown = f"[{host}]" if is_ip and ":" in host else host  # IPv6 literals keep their brackets
    netloc = shown if port is None else f"{shown}:{port}"
    path = parts.path or "/"
    url = f"{parts.scheme.lower()}://{netloc}{path}" + (f"?{parts.query}" if parts.query else "")
    return ParsedURL(
        url=url, scheme=parts.scheme.lower(), host=host, port=port, registered_domain=registered,
        subdomain="" if is_ip else ext.subdomain, suffix="" if is_ip else ext.suffix,
        path=unquote(parts.path + ("?" + parts.query if parts.query else "")),
        userinfo="@" in parts.netloc, is_ip=is_ip, is_idn=is_idn,
    )


def fold(text: str) -> str:
    """Lower-case, strip accents and Arabic diacritics, unify letter variants so word lists match reliably."""
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    text = unicodedata.normalize("NFKC", text).lower()
    return _AR_DIACRITICS.sub("", text).translate(_AR_FOLD)


_FOLDED_URGENCY = tuple(fold(w) for w in URGENCY_WORDS)
_FOLDED_LURES = tuple(fold(w) for w in PAYMENT_LURE_WORDS)
_FOLDED_SIGN_IN = tuple(fold(w) for w in SIGN_IN_TITLE_WORDS)
_FOLDED_GAMBLING = tuple(fold(w) for w in GAMBLING_WORDS)
_FOLDED_REVIEWER = tuple(fold(w) for w in REVIEWER_ADDRESS_PHRASES)
_FOLDED_CAMPAIGN = tuple(fold(w) for w in CAMPAIGN_WORDS)
_FOLDED_PENALTY = tuple(fold(w) for w in PENALTY_WORDS)


class _Defaults(dict):
    def __missing__(self, key: str) -> str:
        return "?"


_UNITS_AR = {"days": ("يوم", "يومين", "أيام", "يوماً"), "years": ("سنة", "سنتين", "سنوات", "سنة")}


def count_words(n: int, unit: str) -> tuple[str, str]:
    """'1 day' / '3 days', and Arabic number agreement after a preposition (singular, dual, 3-10, 11+)."""
    if n < 1:
        return f"less than a {unit[:-1]}", f"أقل من {_UNITS_AR[unit][0]}"
    en = f"{n} {unit[:-1] if n == 1 else unit}"
    one, two, few, many = _UNITS_AR[unit]
    ar = one if n == 1 else two if n == 2 else f"{n} {few}" if 3 <= n <= 10 else f"{n} {many}"
    return en, ar


def reason(code: str, *, detail: str = "", evidence: Optional[dict[str, Any]] = None,
           points: Optional[float] = None, severity: Optional[Severity] = None, **fmt: Any) -> Reason:
    sev, base_points, title_en, title_ar = RULES[code]
    values = _Defaults(fmt)
    for unit in ("days", "years"):
        if unit in fmt:
            values[f"{unit}_en"], values[f"{unit}_ar"] = count_words(int(fmt[unit]), unit)
    return Reason(
        code=code, severity=severity or sev, points=round(base_points if points is None else points, 2),
        title_en=title_en.format_map(values), title_ar=title_ar.format_map(_Isolated(values)),
        detail=detail, evidence=evidence or {},
    )


class _Isolated(dict):
    """Inserted names, hosts and numbers inside Arabic text are bidi-isolated (FSI ... PDI), so a Latin brand
    or a domain cannot reorder the sentence around it."""

    def __missing__(self, key: str) -> str:
        return "?"

    def __getitem__(self, key: str) -> str:
        value = str(dict.__getitem__(self, key))
        if key.endswith("_ar") and not any(c.isascii() and c.isalpha() for c in value):
            return value  # already Arabic wording (counts, technique names)
        return f"\u2068{value}\u2069"


def is_shortener(host: str) -> bool:
    return host in SHORTENERS or host.removeprefix("www.") in SHORTENERS


def is_shared_hosting(host: str) -> bool:
    return any(host == s or host.endswith("." + s) for s in SHARED_HOSTING)


def user_site(host: str, intel: Optional[DomainIntel] = None) -> bool:
    """A user's site on a publishing platform (x.weebly.com, sites.google.com/...), not the platform's own home."""
    platform = is_shared_hosting(host) or bool(intel and intel.is_shared_hosting)
    return platform and host.removeprefix("www.") != parse_url(host).registered_domain


def is_established(intel: Optional[DomainIntel], host: str) -> bool:
    """A domain whose age or popularity means a single weak signal must not block it."""
    if intel is None:
        return False
    if intel.allowlisted:
        return True
    if user_site(host, intel) or intel.is_shortener or is_shortener(host):
        return False
    old = intel.age_days is not None and intel.age_days >= ESTABLISHED_AGE_DAYS
    popular = intel.popularity_rank is not None and intel.popularity_rank <= ESTABLISHED_RANK
    return old or popular


def _brand_token(tokens: Iterable[str]) -> Optional[str]:
    for token in tokens:
        if token in BRAND_KEYWORDS:
            return token
        for key in BRAND_KEYWORDS:
            if len(key) >= 5 and key in token:
                return key
    return None


def reputation_reasons(allowlisted: bool, owner: Optional[str], blocklisted: bool, sources: list[str]) -> list[Reason]:
    out = []
    if blocklisted:
        out.append(reason("rep.blocklisted", detail="Sources: " + ", ".join(sources), evidence={"sources": sources}))
    elif allowlisted:
        out.append(reason("rep.allowlisted", detail=f"Owner: {owner}" if owner else "", evidence={"owner": owner}))
    return out


def url_reasons(p: ParsedURL, intel: Optional[DomainIntel] = None) -> list[Reason]:
    """URL-shape rules that need nothing but the address itself (plus fast intel flags)."""
    out: list[Reason] = []
    if p.is_ip:
        out.append(reason("url.ip_host", evidence={"host": p.host}))
    if p.is_idn and mixed_script(p.host):
        out.append(reason("url.punycode", evidence={"host": p.host, "unicode": unicode_host(p.host)}))
    if p.userinfo:
        out.append(reason("url.userinfo_trick", detail="Everything before '@' is ignored by the browser."))
    if p.port not in (None, 80, 443):
        out.append(reason("url.nonstandard_port", port=p.port, evidence={"port": p.port}))
    sub_labels = [s for s in p.subdomain.split(".") if s and s != "www"]
    if len(sub_labels) >= 3:
        out.append(reason("url.many_subdomains", evidence={"subdomain": p.subdomain}))
    own_brand = None if p.is_ip else _brand_token(re.split(r"[.\-]", p.registered_domain))
    sub_brand = _brand_token(t for label in sub_labels for t in re.split(r"[\-]", label) + [label])
    label = p.registered_domain.split(".")[0]
    if own_brand and label == own_brand and p.suffix.split(".")[0] in ("com", "net", "org") and "." in p.suffix:
        # "roblox.com.ss", "coinbase.com.lc": the brand's .com name under someone else's country suffix
        out.append(reason("url.brand_country_lookalike", brand=BRAND_KEYWORDS[own_brand], evidence={"domain": p.registered_domain}))
    if own_brand and label != own_brand and not sub_brand:  # "google1208", "coinbasevip", "paypal-com-aspi"
        out.append(reason("url.brand_in_domain", brand=BRAND_KEYWORDS[own_brand], evidence={"keyword": own_brand, "domain": p.registered_domain}))
    if sub_brand and sub_brand != own_brand:
        out.append(reason("url.brand_in_subdomain", brand=BRAND_KEYWORDS[sub_brand], evidence={"keyword": sub_brand}))
    path_tokens = [t for t in re.split(r"[^a-z0-9]+", p.path.lower()) if t]
    path_brand = next((t for t in path_tokens if t in BRAND_KEYWORDS and len(t) >= 4), None)
    if path_brand and path_brand != own_brand and not sub_brand:
        out.append(reason("url.brand_in_path", brand=BRAND_KEYWORDS[path_brand], evidence={"keyword": path_brand}))
    if not p.is_ip:
        tld = p.suffix.rsplit(".", 1)[-1]
        popular = intel is not None and intel.popularity_rank is not None and intel.popularity_rank <= ESTABLISHED_RANK
        if tld in SUSPICIOUS_TLDS and not user_site(p.host, intel) and not popular:  # the operator's TLD, not a lure
            out.append(reason("url.suspicious_tld", tld=tld, evidence={"tld": tld}))
        host_tokens = set(re.split(r"[.\-]", ".".join(sub_labels + [p.registered_domain.split(".")[0]])))
        lures = [w for w in URL_LURE_WORDS if w in host_tokens]
        if lures:
            out.append(reason("url.lure_keywords", words=", ".join(lures[:3]), evidence={"words": lures}))
        if p.registered_domain.split(".")[0].removeprefix("xn--").count("-") >= 2:
            out.append(reason("url.many_hyphens", evidence={"domain": p.registered_domain}))
    if (intel and intel.is_shortener) or is_shortener(p.host):
        out.append(reason("url.shortener", evidence={"host": p.host}))
    elif user_site(p.host, intel):
        out.append(reason("url.shared_hosting", evidence={"host": p.host}))
    if p.scheme == "http":
        out.append(reason("url.no_tls"))
    if machine_subdomain(p):
        out.append(reason("url.machine_subdomain", evidence={"subdomain": p.subdomain}))
    if _CMS_PATH.search(p.path):
        out.append(reason("url.cms_internal_path", evidence={"path": p.path[:200]}))
    return out


def unicode_host(host: str) -> str:
    labels = []
    for label in host.split("."):
        try:
            labels.append(label.encode("ascii").decode("idna") if label.startswith("xn--") else label)
        except UnicodeError:
            labels.append(label)
    return ".".join(labels)


def _scripts(text: str) -> set[str]:
    out = set()
    for ch in text:
        if ch.isalpha():
            name = unicodedata.name(ch, "")
            out.add(name.split(" ")[0] if name else "?")
    return out


def mixed_script(host: str) -> bool:
    """An internationalised name mixing writing systems inside one label (e.g. Latin with Cyrillic look-alikes).

    A label written wholly in one script (دبي.امارات, bücher.de) is an ordinary local-language name."""
    return any(len(_scripts(label)) > 1 for label in unicode_host(host).split("."))


def non_latin_idn(p: ParsedURL) -> bool:
    """A host written in a non-Latin script: the URL model was not trained on these and abstains."""
    return p.is_idn and bool(_scripts(unicode_host(p.host)) - {"LATIN"})


def machine_subdomain(p: ParsedURL) -> bool:
    """A generated label (hex id, dashed IP, long digit run) under someone else's domain."""
    return any(_MACHINE_LABEL.search(label) for label in p.subdomain.split(".") if label and label != "www")


def domain_reasons(intel: Optional[DomainIntel], host: str) -> list[Reason]:
    """Age, popularity and certificate signals. Trust credits never apply to shared hosting."""
    if intel is None:
        return []
    out: list[Reason] = []
    shared = user_site(host, intel) or intel.is_shortener or is_shortener(host)
    # A generated subdomain does not inherit its parent domain's age or popularity.
    borrowed = machine_subdomain(parse_url(host))
    age = intel.age_days
    if age is not None and not shared:
        facts = {"age_days": age, "created": intel.created.isoformat() if intel.created else None, "registrar": intel.registrar}
        if age < NEW_DOMAIN_DAYS:
            out.append(reason("domain.newly_registered", days=age, evidence=facts))
        elif age < YOUNG_DOMAIN_DAYS:
            out.append(reason("domain.young", days=age, evidence=facts))
        elif age >= VERY_OLD_DOMAIN_DAYS and not borrowed:
            out.append(reason("domain.long_established", years=age // 365, evidence=facts))
        elif age >= OLD_DOMAIN_DAYS and not borrowed:
            out.append(reason("domain.established", evidence=facts))
    rank = intel.popularity_rank
    if rank is not None and not shared and not borrowed:
        code = "domain.popular_top" if rank <= TOP_RANK else "domain.popular" if rank <= ESTABLISHED_RANK else "domain.known" if rank <= KNOWN_RANK else None
        if code:
            out.append(reason(code, rank=f"{rank:,}", evidence={"rank": rank}))
    if intel.tls_age_days is not None and intel.tls_age_days <= NEW_CERT_DAYS and not is_established(intel, host):
        out.append(reason("tls.new_certificate", days=intel.tls_age_days, evidence={"issuer": intel.tls_issuer, "not_before": str(intel.tls_not_before)}))
    issuer = f" {intel.tls_issuer or ''} "
    if not shared and any(m in issuer for m in ORG_CERT_MARKERS):
        out.append(reason("tls.organisation_validated", evidence={"issuer": intel.tls_issuer}))
    return out


def merged_domain_reasons(entry: Optional[DomainIntel], entry_host: str,
                          final: Optional[DomainIntel], final_host: str) -> list[Reason]:
    """Domain signals when the page landed on another domain: risks from both, trust only from the weaker.

    A shortener's own reputation says nothing, so only the destination counts. Otherwise a new domain
    that bounces to a famous site must not inherit the famous site's trust.
    """
    if final is None or entry is None or entry.registered_domain == final.registered_domain:
        return domain_reasons(entry or final, entry_host if entry else final_host)
    if entry.is_shortener or is_shortener(entry_host):
        return domain_reasons(final, final_host)
    a, b = domain_reasons(entry, entry_host), domain_reasons(final, final_host)
    risks = {r.code: r for r in a + b if r.points > 0}
    trust_a, trust_b = [r for r in a if r.points <= 0], [r for r in b if r.points <= 0]
    weaker = trust_a if sum(r.points for r in trust_a) >= sum(r.points for r in trust_b) else trust_b
    return list(risks.values()) + weaker


def same_organisation(a: ParsedURL, b: ParsedURL) -> bool:
    """crowe.ae -> crowe.com, webnode.com -> webnode.page: the same name under another suffix."""
    return a.registered_domain.split(".")[0] == b.registered_domain.split(".")[0]


def harmful_destination(p: ParsedURL) -> bool:
    """A host whose name or TLD says gambling / betting, adult content or a pill shop."""
    host = unicode_host(p.host)  # punycode ("xn--m1bet8...") must not spell words by accident
    tokens = {t for t in re.split(r"[.\-\d]+", host) if t}
    labels = host.split(".")
    glued = any(w in host if len(w) >= 5 else any(label.endswith(w) and label != w for label in labels)
                for w in HARMFUL_DESTINATION_WORDS if len(w) >= 4)  # "gacorsupertogel", "kolongtoto"
    return bool(tokens & HARMFUL_DESTINATION_WORDS) or glued or p.suffix.rsplit(".", 1)[-1] in HARMFUL_DESTINATION_TLDS


def harmful_title(title: str) -> bool:
    """A page title whose own words name a gambling / betting brand ("KENZOTOTO", "1XBET", "Maleda Bet")."""
    words = [w for w in re.split(r"[^a-z0-9]+", fold(title)) if w][:12]
    long_words = [h for h in HARMFUL_DESTINATION_WORDS if len(h) >= 5]
    # Whole short words ("toto", "bet") are ordinary names in titles; glued ones ("sriwijayatoto") are not.
    return any(any(h in w for h in long_words) or any(w.endswith(h) and w != h for h in HARMFUL_DESTINATION_WORDS if len(h) >= 4)
               for w in words)


def unrelated(a: ParsedURL, b: ParsedURL) -> bool:
    """No name relation between two sites: neither name appears in the other's address."""
    if same_organisation(a, b):
        return False
    squash = lambda text: re.sub(r"[^a-z0-9]", "", text.lower())
    la, lb = squash(a.registered_domain.split(".")[0]), squash(b.registered_domain.split(".")[0])
    common = difflib.SequenceMatcher(None, la, squash(b.url)).find_longest_match(0, len(la), 0, len(squash(b.url)))
    # "spacebunburger" -> instagram.com/spacebun.burger, "centuryvillageuae" -> centuryvillage.esguae.com
    return common.size < RELATED_NAME_CHARS and lb not in squash(a.url)


def own_account(site: ParsedURL, host: str) -> bool:
    """The form posts to the business's own account on a service ("hotelname.bookingengine.example")."""
    label = site.registered_domain.split(".")[0]
    return len(label) >= 4 and label in parse_url(host).subdomain.split(".")


def has_low_reputation(intel: Optional[DomainIntel], host: str, brand: Optional[BrandMatch] = None) -> bool:
    """Positive evidence of low reputation. Missing data is unknown, never low."""
    p = parse_url(host)
    name_lookalike = brand is not None and bool(set(brand.technique.split("+")) - CONTENT_TECHNIQUES)
    if p.is_ip or name_lookalike or user_site(host) or p.suffix.rsplit(".", 1)[-1] in SUSPICIOUS_TLDS:
        return True
    if intel is None:
        return False
    if intel.blocklisted or user_site(host, intel) or (intel.age_days is not None and intel.age_days < YOUNG_DOMAIN_DAYS):
        return True
    return False


def brand_reasons(brand: Optional[BrandMatch]) -> list[Reason]:
    if brand is None or brand.score <= 0:
        return []
    severity = S.CRITICAL if brand.score >= 0.8 else S.HIGH if brand.score >= 0.5 else S.MEDIUM
    technique = brand.technique or "look-alike"
    points = LOOKALIKE_MAX_POINTS * min(brand.score, 1.0)
    # A page that only presents a brand, with an ordinary domain name and no request for data, is weak evidence.
    page_only = not (set(technique.split("+")) - CONTENT_TECHNIQUES)
    if page_only and not any(m.startswith("form asks") for m in brand.matched_on):
        points, severity = points / 2, S.MEDIUM
    return [reason(
        "domain.lookalike", points=points, severity=severity,
        brand=brand.brand, brand_ar=brand.brand_ar or brand.brand, technique=technique,
        technique_ar=TECHNIQUE_AR.get(technique, technique),
        detail=f"Official domains: {', '.join(brand.official_domains)}" if brand.official_domains else "",
        evidence=brand.model_dump(),
    )]


def model_reason(code: str, probability: Optional[float], **evidence: Any) -> Optional[Reason]:
    """Turn a model probability into a signed contribution: weight * logit(p), halved when negative."""
    if probability is None:
        return None
    p = min(max(float(probability), 0.02), 0.98)
    points = MODEL_WEIGHTS[code] * math.log(p / (1 - p))
    if points < 0:
        points *= NEGATIVE_MODEL_FACTOR
    if code == "llm.judge":  # the judge reads attacker text: it may add a little risk, never remove any
        points = min(max(points, 0.0), LLM_MAX_POINTS)
    severity = S.HIGH if points >= 15 else S.MEDIUM if points >= 7 else S.LOW if points > 0 else S.INFO
    return reason(code, points=points, severity=severity, pct=round(100 * float(probability)),
                  evidence={"probability": round(float(probability), 4), **evidence})


@lru_cache(maxsize=1024)
def _word_pattern(word: str) -> re.Pattern:
    # Latin phrases match whole words ("fine" must not match "define"); Arabic ones match inside words
    # because prefixes such as "ال" and "و" attach to them.
    return re.compile(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])" if word.isascii() else re.escape(word))


def _found_words(text: str, words: tuple[str, ...]) -> list[str]:
    return [w for w in words if w in text and _word_pattern(w).search(text)]


_FIELD_NAMES = {"asks_card": ("card details", "بيانات البطاقة"), "asks_otp": ("a one-time code", "رمز التحقق"),
                "asks_national_id": ("an Emirates ID", "رقم الهوية الإماراتية")}


def _is_new(intel: Optional[DomainIntel]) -> bool:
    if intel is None:
        return False
    return intel.age_days is not None and intel.age_days < RECENT_DOMAIN_DAYS  # unknown age is unknown, not new


def page_reasons(page: PageSnapshot, intel: Optional[DomainIntel], brand: Optional[BrandMatch],
                 entry_intel: Optional[DomainIntel] = None) -> list[Reason]:
    """Rules over one fetched page snapshot. `intel` describes the final domain, `entry_intel` the first one."""
    out: list[Reason] = []
    entry = parse_url(page.url)
    final = parse_url(page.final_url or page.url)
    established = is_established(intel, final.host)
    title = fold(page.title or "")
    shared = user_site(final.host, intel)
    warning = next((v for k, v in PROVIDER_WARNINGS.items() if k in title), None)
    if warning:
        out.append(reason("page.provider_warning", what=warning[0], what_ar=warning[1], evidence={"title": page.title, "status": page.status}))
    elif shared and (page.status or 0) >= 400 and any(m in title or m in fold(page.text[:400]) for m in TAKEDOWN_MARKERS):
        out.append(reason("page.taken_down", evidence={"title": page.title, "status": page.status, "host": final.host}))
    landing = parse_url(page.final_url or page.url).registered_domain
    # Where the visitor is sent, even when that page itself could not be loaded.
    hops = [parse_url(h.url) for h in page.redirect_chain] + [final]
    elsewhere = [h for h in hops if h.registered_domain != entry.registered_domain and not same_organisation(entry, h)]
    harmful = next((h for h in elsewhere if harmful_destination(h)), None)
    if harmful is None and elsewhere and harmful_title(page.title or ""):
        harmful = final if final in elsewhere else elsewhere[-1]  # the destination names itself, e.g. "SRIWIJAYATOTO"
    if harmful:
        out.append(reason("page.harmful_redirect", final=harmful.registered_domain,
                          evidence={"entry": entry.registered_domain, "destination": harmful.host}))
    # A for-sale lander names the domain itself as the thing for sale ("example.com is for sale").
    own_for_sale = re.search(rf"{re.escape(entry.registered_domain)}\W{{0,4}}(?:is )?for sale", fold(page.title or ""))
    if landing in PARKING_HOSTS or own_for_sale or any(m in fold(f"{page.title} {page.text[:2000]}") for m in PARKED_MARKERS):
        out.append(reason("page.parked", evidence={"final_url": page.final_url, "title": page.title}))
    if page.tls_error:
        out.append(reason("page.tls_error", error=page.tls_error[:80], evidence={"error": page.tls_error}))
    if page.error and not page.html:
        return out + [reason("page.unreachable", detail=page.error, evidence={"error": page.error, "status": page.status})]
    if warning:
        return out

    chain = page.redirect_chain
    if len(chain) >= 3:
        out.append(reason("page.long_redirect_chain", hops=len(chain), evidence={"chain": [h.url for h in chain]}))
    recent = entry_intel is not None and entry_intel.age_days is not None and entry_intel.age_days < REREGISTERED_DAYS
    if recent and final.registered_domain != entry.registered_domain and unrelated(entry, final) and not is_shortener(entry.host):
        # A business name registered (again) recently that forwards visitors to an unrelated site: the pattern of
        # lapsed domains bought to redirect their old traffic.
        out.append(reason("page.unrelated_redirect", final=final.registered_domain,
                          evidence={"entry": entry.registered_domain, "entry_age_days": entry_intel.age_days, "final": final.host}))
    if final.registered_domain != entry.registered_domain and not same_organisation(entry, final):
        out.append(reason("page.cross_domain_redirect", final=final.registered_domain,
                          evidence={"entry": entry.registered_domain, "final": final.registered_domain}))
    if any(h.via in ("js", "meta") for h in chain):
        out.append(reason("page.client_side_redirect", evidence={"hops": [h.model_dump() for h in chain if h.via in ("js", "meta")]}))
    if any(h.via == "shortener" or is_shortener(parse_url(h.url).host) for h in chain[1:]):
        out.append(reason("page.shortener_in_chain"))
    final_popular = intel is not None and intel.popularity_rank is not None and intel.popularity_rank <= ESTABLISHED_RANK
    if (final.registered_domain != entry.registered_domain and not same_organisation(entry, final) and final_popular
            and _is_new(entry_intel) and not is_shortener(entry.host)):
        out.append(reason("page.cloaking_bounce", final=final.registered_domain,
                          evidence={"entry_age_days": entry_intel.age_days, "final_rank": intel.popularity_rank}))

    forms = page.forms
    low_rep = has_low_reputation(intel, final.host, brand)
    platform_page = user_site(final.host, intel)  # the platform's own scripts run here too
    sensitive = [f for f in forms if f.asks_password or f.asks_card or f.asks_otp or f.asks_national_id]
    # A business posting its own form to its CRM, booking engine or payment provider is not credential theft.
    external = [f for f in sensitive if f.external_action and f.action_host
                and parse_url(f.action_host).registered_domain != final.registered_domain
                and (low_rep or not (parse_url(f.action_host).registered_domain in BUSINESS_FORM_HOSTS
                                     or own_account(final, f.action_host)))]
    if external:
        out.append(reason("page.external_form_action", host=external[0].action_host, evidence={"hosts": sorted({f.action_host for f in external})}))
    cloaking_seen = any(p.search(page.html[:400_000]) for p in CLOAKING_PATTERNS.values())
    # Every bank and news login asks for these: they only count next to a brand mismatch, an off-site
    # form, a low-reputation domain or cloaking.
    form_context = bool(brand or external or low_rep or cloaking_seen)
    for flag, code in (("asks_password", "page.password_form"), ("asks_card", "page.card_form"),
                       ("asks_otp", "page.otp_form"), ("asks_national_id", "page.national_id_form")):
        hits = [f for f in forms if getattr(f, flag)]
        if hits:
            out.append(reason(code, points=None if form_context else 0.0, severity=None if form_context else S.INFO,
                              evidence={"fields": sorted({n for f in hits for n in f.input_names})[:12],
                                        "actions": [f.action for f in hits][:5], "scored": form_context}))
    asked = [flag for flag in _FIELD_NAMES if any(getattr(f, flag) for f in forms)]
    page_claims_brand = bool(brand and (brand.technique in PAGE_TECHNIQUES or set(brand.matched_on) & PAGE_TECHNIQUES))
    young = intel is not None and intel.age_days is not None and intel.age_days < YOUNG_DOMAIN_DAYS
    # Without a look-alike domain name, a page naming a brand (a sponsor, a partner) and asking for data is
    # confirmed impersonation only with a lure or on a young domain, and never on a domain held for years.
    name_lookalike = brand is not None and bool(set(brand.technique.split("+")) - CONTENT_TECHNIQUES)
    long_held = intel is not None and intel.age_days is not None and intel.age_days >= 2 * 365
    lured = brand is not None and (sum(m.startswith("lure:") for m in brand.matched_on) >= 2
                                   or any(m.startswith("urgency:") for m in brand.matched_on))
    if (brand and brand.score >= 0.4 and asked and final.registered_domain not in brand.official_domains
            and (page_claims_brand or young) and (name_lookalike or (not long_held and (young or lured)))):
        out.append(reason("page.sensitive_form_off_brand", brand=brand.brand, brand_ar=brand.brand_ar or brand.brand,
                          fields=", ".join(_FIELD_NAMES[a][0] for a in asked), fields_ar="، ".join(_FIELD_NAMES[a][1] for a in asked),
                          evidence={"asks": asked, "official_domains": brand.official_domains}))

    scrambled = [s for s in page.scripts if s.obfuscated and s.first_party]
    if scrambled:
        code = "page.obfuscated_scripts" if low_rep and not established else "page.obfuscated_scripts_minor"
        out.append(reason(code, evidence={"scripts": [s.src or "inline" for s in scrambled][:8],
                                          "markers": sorted({m for s in scrambled for m in s.obfuscation_markers})[:10]}))

    html = page.html[:400_000]
    haystack = " ".join([html.lower()] + [e.lower() for s in page.scripts for e in s.endpoints]
                        + [(f.action or "").lower() for f in forms])
    signals: dict[str, set[str]] = {}
    for script in page.scripts:
        for label in script.suspicious_calls:
            code = SCRIPT_SIGNALS.get(label.split(":", 1)[0])
            # These signatures also match everyday shop, booking and anti-bot scripts: they only count on a
            # site with positive low-reputation evidence. Data-theft signatures also count next to a sensitive form.
            if code in REPUTATION_GATED and not low_rep:
                continue
            if code in DATA_THEFT_SIGNALS and not (sensitive or (low_rep and not platform_page)):
                continue
            host = label.split(":", 1)[1] if ":" in label else ""
            if code == "page.credential_capture" and host and not low_rep and parse_url(host).registered_domain in BUSINESS_FORM_HOSTS:
                continue
            if code and (script.first_party or code not in BEHAVIOUR_SIGNALS):
                signals.setdefault(code, set()).add(label)
    for name, pattern in CLOAKING_PATTERNS.items():
        if pattern.search(html):
            signals.setdefault("page.cloaking_code", set()).add(name)
    for sig, name in EXFIL_CHANNELS.items():
        if sig in haystack and (sensitive or (low_rep and not platform_page)):
            signals.setdefault("page.exfiltration", set()).add(name)
    channels = sorted({name for sig, name in FORM_RELAYS.items() if sig in haystack})
    if channels:
        out.append(reason("page.form_relay", channel=", ".join(channels), evidence={"channels": channels}))
    signals.setdefault("page.visitor_profiling", set()).update(e for e in PROFILING_ENDPOINTS if e in haystack)
    for code, found in sorted(signals.items()):
        found = sorted(found)
        if not found or (code == "page.visitor_profiling" and not low_rep):
            continue
        # Behaviour tricks on an established site are usually ad or anti-bot scripts: weak evidence there.
        damp = 0.25 if established and code in BEHAVIOUR_SIGNALS else 1.0
        if code == "page.cloaking_code":
            weight = 1.0 if len(found) == 1 else 1.8
            severity = S.LOW if damp < 1 else S.HIGH if len(found) > 1 else S.MEDIUM
            out.append(reason(code, markers=", ".join(found[:3]), points=RULES[code][1] * weight * damp,
                              severity=severity, evidence={"markers": found}))
        else:
            out.append(reason(code, channel=", ".join(found[:3]), points=RULES[code][1] * damp,
                              severity=S.LOW if damp < 1 else None, evidence={"signals": found}))

    if low_rep and not established and (page.needs_js or len(page.text) < SHORT_PAGE_CHARS) and not forms:
        out.append(reason("page.empty_shell", evidence={"text_chars": len(page.text), "needs_js": page.needs_js}))

    text = fold(f"{page.title} {page.text[:20_000]}")
    urgency = _found_words(text, _FOLDED_URGENCY)
    if urgency:
        out.append(reason("page.urgency", words=", ".join(urgency[:3]), points=RULES["page.urgency"][1] * (1.0 if len(urgency) > 1 else 0.6), evidence={"words": urgency}))
    lures = _found_words(text, _FOLDED_LURES)
    if lures:
        out.append(reason("page.payment_lure", words=", ".join(lures[:3]), points=RULES["page.payment_lure"][1] * (1.0 if len(lures) > 1 else 0.5), evidence={"words": lures}))

    error_page = (page.status or 0) >= 400 or bool(_ERROR_TITLE.search(page.title or ""))  # e.g. a host's own 404 page
    steering = _found_words(fold(f"{page.title} {page.text[:50_000]} {page.html[:200_000]}"), _FOLDED_REVIEWER)
    if steering:
        out.append(reason("page.addresses_reviewers", words=steering[0], evidence={"phrases": steering[:5]}))
    gambling = _found_words(text, _FOLDED_GAMBLING)
    if len(gambling) >= 2:  # typically an expired or hijacked domain resold to a gambling network
        out.append(reason("page.gambling", words=", ".join(gambling[:3]), evidence={"words": gambling}))
    sign_in = _found_words(fold(page.title or ""), _FOLDED_SIGN_IN)
    if sign_in and low_rep and not established and not error_page:
        out.append(reason("page.sign_in_title", words=", ".join(sign_in[:2]), evidence={"title": page.title}))
    if not established and (shared or _is_new(intel)) and not brand and not error_page:
        own = fold(final.registered_domain if not shared else final.host)
        claimed = next((name for key, name in BRAND_KEYWORDS.items()
                        if _word_pattern(fold(name)).search(title) and key not in own.replace("-", "")), None)
        if claimed:
            out.append(reason("page.brand_title_mismatch", brand=claimed, evidence={"title": page.title, "host": final.host}))

    small, penalties = [], []
    for m in _SMALL_AED.finditer(text):  # the threat must be next to the amount, not anywhere on the page
        amount = float((m.group(1) or m.group(2)).replace(",", "."))
        near = _found_words(text[max(0, m.start() - FEE_WINDOW):m.end() + FEE_WINDOW], _FOLDED_PENALTY)
        if 1 <= amount <= FEE_MAX_AED and near:
            small.append(amount)
            penalties += near
    small = sorted(set(small))
    if small:
        out.append(reason("page.fee_bait", amount=f"{small[0]:g}", evidence={"amounts_aed": small[:5], "threat_words": sorted(set(penalties))[:5]}))
    tld = final.suffix.rsplit(".", 1)[-1]
    campaign = _found_words(text + " " + fold(final.url), _FOLDED_CAMPAIGN)
    if tld in SUSPICIOUS_TLDS and campaign:
        out.append(reason("page.tld_campaign_combo", tld=tld, evidence={"tld": tld, "words": campaign[:5]}))

    if brand and brand.category in ("government", "bank", "police", "utility") and intel and intel.hosting_country and intel.hosting_country.upper() != "AE" and not established:
        out.append(reason("page.brand_hosting_mismatch", brand=brand.brand, brand_ar=brand.brand_ar or brand.brand,
                          country=intel.hosting_country, evidence={"hosting_country": intel.hosting_country, "asn_org": intel.asn_org}))
    return out


STRONG_PROBE_SIGNALS = {"different_final_site_for_crawler", "credential_form_hidden_from_crawler"}
WEAK_PROBE_SIGNALS = {"different_content_for_crawler"}


def cloaking_probe_reasons(probe: Optional[dict[str, Any]], established: bool = False) -> list[Reason]:
    """Phone-vs-scanner double fetch (engine.fetch.cloaking_probe).

    Sending scanners to another site or hiding the credential form from them is strong; merely different
    content is common on legitimate sites behind bot protection, so it counts less, and little on
    established domains.
    """
    if not probe or not probe.get("cloaking"):
        return []
    signals = set(probe.get("signals", []))
    found = sorted((STRONG_PROBE_SIGNALS | WEAK_PROBE_SIGNALS) & signals)
    strong = bool(STRONG_PROBE_SIGNALS & signals)
    points = RULES["page.cloaking_divergence"][1] * (1.0 if strong else 0.45) * (0.2 if established else 1.0)
    severity = S.HIGH if strong and not established else S.MEDIUM if not established else S.LOW
    return [reason("page.cloaking_divergence", signals=", ".join(s.replace("_", " ") for s in found), points=points,
                   severity=severity, evidence={"signals": sorted(signals), "comparisons": probe.get("comparisons", {})})]


@dataclass
class Assessment:
    risk_score: float
    decision: Decision
    guards: list[Reason]


def _risk(total: float) -> float:
    return 100.0 / (1.0 + math.exp(-total / SCALE))


def _points_for(risk: float) -> float:
    r = min(max(risk, 0.01), 99.99) / 100.0
    return SCALE * math.log(r / (1 - r))


def _decide(risk: float) -> Decision:
    if risk >= config.BLOCK_THRESHOLD:
        return Decision.BLOCK
    if risk >= config.WARN_THRESHOLD:
        return Decision.WARN
    return Decision.ALLOW


def _apply_review(reasons: list[Reason]) -> bool:
    """A review reason is an override: its points move the score into the band the reviewer chose."""
    review = next((r for r in reasons if r.code.startswith("review.")), None)
    if review is None:
        return False
    review.points = 0.0
    total = BASE_POINTS + sum(r.points for r in reasons)
    risk = _risk(total)
    if review.code == "review.overturned":
        target = min(risk, config.WARN_THRESHOLD - 5)
    elif review.code == "review.downgraded":
        target = min(max(risk, config.WARN_THRESHOLD), config.BLOCK_THRESHOLD - 1)
    else:
        return False
    review.points = round(_points_for(target) - total, 2)
    return True


SPECIFIC_FINDINGS = frozenset({
    "page.harmful_redirect", "page.gambling",
    "rep.blocklisted", "page.sensitive_form_off_brand", "page.exfiltration", "page.credential_capture",
    "page.external_form_action", "page.cloaking_bounce", "page.provider_warning", "page.wallet_drainer",
})
LOW_REPUTATION_CODES = frozenset({
    "page.tls_error",
    "domain.newly_registered", "domain.young", "url.suspicious_tld", "url.shared_hosting", "url.ip_host", "url.punycode",
    "tls.new_certificate", "domain.lookalike", "url.brand_in_subdomain", "rep.blocklisted",
})
CONTENT_TECHNIQUES = frozenset({"content", "fake_helpline", "favicon", ""})
PAGE_TECHNIQUES = frozenset({"content", "favicon", "title", "logo", "text"})
STRUCTURAL_CODES = frozenset({
    "url.shared_hosting", "url.brand_in_subdomain", "url.brand_in_domain", "url.brand_country_lookalike", "domain.lookalike", "url.suspicious_tld",
    "domain.newly_registered", "domain.young", "url.no_tls", "url.ip_host", "url.punycode", "url.userinfo_trick",
    "page.password_form", "page.card_form", "page.otp_form", "page.national_id_form",
})
WEAK_STRUCTURAL = frozenset({"url.no_tls"})
# Common among genuine small businesses: with model scores they reach warn, never block.
BLOCK_EXEMPT_STRUCTURAL = WEAK_STRUCTURAL | {"url.shared_hosting", "domain.young"}
FORM_CODES = frozenset({"page.password_form", "page.card_form", "page.otp_form", "page.national_id_form"})
PAGE_EVIDENCE_CODES = frozenset({
    "domain.lookalike", "page.sensitive_form_off_brand", "page.payment_lure", "page.urgency", "page.fee_bait",
    "page.brand_title_mismatch", "url.brand_in_subdomain", "url.brand_in_domain", "url.brand_in_path", "url.brand_country_lookalike",
    "page.external_form_action", "page.exfiltration", "page.credential_capture", "page.cloaking_divergence",
    "page.provider_warning", "page.taken_down", "page.tld_campaign_combo", "page.wallet_drainer", "page.sign_in_title",
}) | FORM_CODES
GENERIC_CODES = frozenset({
    "domain.young", "page.obfuscated_scripts", "page.obfuscated_scripts_minor", "page.cloaking_code", "page.empty_shell",
    "url.no_tls", "page.long_redirect_chain", "page.client_side_redirect",
    "page.cross_domain_redirect", "url.many_hyphens", "page.visitor_profiling",
})
PAGE_LURE_CODES = frozenset({"page.payment_lure", "page.urgency", "page.fee_bait", "page.tld_campaign_combo"})
LURE_CODES = frozenset({"page.payment_lure", "page.urgency", "page.fee_bait", "page.tld_campaign_combo", "url.lure_keywords"})
IMPERSONATION_CODES = frozenset({"domain.lookalike", "url.brand_in_subdomain", "page.brand_title_mismatch"})


def _models_agree(reasons: list[Reason]) -> bool:
    """Both independent models say scam, confidently on average: that is corroboration in its own right."""
    p = {r.code: r.evidence.get("probability", 0.0) for r in reasons if r.code in ("model.url", "model.page")}
    return len(p) == 2 and min(p.values()) >= MODELS_AGREE_MIN_P and sum(p.values()) / 2 >= MODELS_AGREE_P


def _has_specific_finding(reasons: list[Reason]) -> bool:
    """A block needs at least one strong, specific finding, not just model scores and generic signals."""
    codes = {r.code for r in reasons if r.points > 0 or r.code in FORM_CODES}
    if codes & SPECIFIC_FINDINGS:
        return True
    if any(r.code == "page.cloaking_divergence" and r.severity == S.HIGH for r in reasons):
        return True
    # A domain-name look-alike alone is specific only on a domain that is not long-lived or parked.
    old_or_parked = bool({r.code for r in reasons} & {"domain.established", "domain.long_established", "page.parked"})
    if not old_or_parked and any(r.code == "domain.lookalike" and r.severity in (S.HIGH, S.CRITICAL) and r.points >= 15
                                 and set(str(r.evidence.get("technique", "")).split("+")) - CONTENT_TECHNIQUES for r in reasons):
        return True
    if _models_agree(reasons) and codes & (STRUCTURAL_CODES - BLOCK_EXEMPT_STRUCTURAL):
        return True
    young = bool(codes & {"domain.newly_registered", "domain.young"})
    forms = bool(codes & FORM_CODES)
    name_impersonation = bool(codes & (IMPERSONATION_CODES - {"domain.lookalike"})) or any(
        r.code == "domain.lookalike" and set(str(r.evidence.get("technique", "")).split("+")) - CONTENT_TECHNIQUES for r in reasons)
    # A single generic lure word ("pay now") on a young site with a booking form is not enough.
    strong_lure = any(r.code in PAGE_LURE_CODES and r.points >= RULES[r.code][1] for r in reasons)
    return forms and ((young and strong_lure) or name_impersonation)


def dedupe(reasons: list[Reason]) -> list[Reason]:
    """One reason per code (per component for errors): the strongest is kept, the others' evidence merged."""
    kept: dict[tuple[str, Any], Reason] = {}
    for r in reasons:
        key = (r.code, r.evidence.get("component") if r.code == "engine.component_error" else None)
        first = kept.get(key)
        if first is None:
            kept[key] = r
            continue
        strong, weak = (r, first) if abs(r.points) > abs(first.points) else (first, r)
        strong.evidence = {**weak.evidence, **strong.evidence, "also_found": strong.evidence.get("also_found", []) + [weak.evidence.get("page_url") or weak.detail or weak.code]}
        kept[key] = strong
    return list(kept.values())


def assess(reasons: list[Reason], *, allowlisted: bool, established: bool) -> Assessment:
    """Fuse contributions into a 0-100 risk and decision, then apply the hard rules in order:

    1. a review that overturned or downgraded a block wins;
    2. confirmed impersonation (brand + domain not official + credential/payment form) blocks;
    3. a look-alike of a registered brand is at least a warning, even if its page cannot be fetched; both
       models confident (>= MODELS_AGREE_P) is at least a warning, and a block next to a structural signal;
    4. without a corroborated sign (a high finding, a medium one on a low-reputation domain, both models
       confident, or a near-certain URL model on a structurally risky URL) a site stays below a warning:
       generic signals and model scores alone only escalate;
    5. a block needs a strong, specific finding; generic signals and models reach warn at most;
    6. an allowlisted official domain never goes above warn;
    7. an established domain needs a critical finding or two independent high ones to be blocked.
    """
    reasons = dedupe([r for r in reasons if not r.code.startswith(GUARD_PREFIXES)])
    if _apply_review(reasons):
        risk = round(_risk(BASE_POINTS + sum(r.points for r in reasons)), 1)
        return Assessment(risk, _decide(risk), [])
    total = BASE_POINTS + sum(r.points for r in reasons)
    positive = [r for r in reasons if r.points > 0 and not r.code.startswith(("model.", "llm."))]
    blocklisted = any(r.code == "rep.blocklisted" for r in reasons)
    strong = any(r.severity == S.CRITICAL for r in positive) or sum(r.severity == S.HIGH for r in positive) >= 2
    impersonation = any(r.code == "page.sensitive_form_off_brand" for r in reasons)
    # The warning floor is for look-alike domain names; a page that only talks about a brand earns no floor.
    lookalike = any(r.code == "domain.lookalike" and r.points >= LOOKALIKE_MAX_POINTS / 2
                    and set(str(r.evidence.get("technique", "")).split("+")) - CONTENT_TECHNIQUES for r in reasons)
    # Models need a rule finding to stand on: a high one, or a medium one on a domain with low-reputation evidence.
    # A fresh certificate is routine renewal for most sites: it counts only next to another low-reputation fact.
    low_rep = any(r.code in LOW_REPUTATION_CODES - {"tls.new_certificate"} and r.points > 0 for r in reasons)
    agree = _models_agree(reasons)
    # A near-certain URL model next to a structural risk signal is enough for a warning (dead pages).
    url_sure = any(r.code == "model.url" and r.evidence.get("probability", 0) >= URL_SURE_P for r in reasons)
    # Models over-score small businesses on free site builders: on a live platform page they need page evidence.
    found = {r.code for r in reasons if r.points > 0 or r.code == "page.unreachable"}
    if "url.shared_hosting" in found and "page.unreachable" not in found and not found & PAGE_EVIDENCE_CODES:
        agree = url_sure = False
    url_structural = any(r.code in (STRUCTURAL_CODES | {"url.machine_subdomain", "url.cms_internal_path", "url.lure_keywords"})
                         - WEAK_STRUCTURAL and r.points > 0 for r in reasons)
    # Two independent low-reputation facts (young domain and a fresh certificate, ...) corroborate each other.
    low_rep_facts = len({r.code for r in reasons if r.code in LOW_REPUTATION_CODES and r.points > 0})
    corroborated = agree or (url_sure and url_structural) or low_rep_facts >= 2 or any(
        r.severity in (S.HIGH, S.CRITICAL) or (r.severity == S.MEDIUM and low_rep and r.code not in LOW_REPUTATION_CODES)
        for r in positive)
    guards: list[Reason] = []
    warn_at, block_at = config.WARN_THRESHOLD, config.BLOCK_THRESHOLD

    def move_to(code: str, target: float) -> None:
        nonlocal total
        guards.append(reason(code, points=_points_for(target) - total))
        total = _points_for(target)

    if impersonation and not allowlisted and round(_risk(total), 1) < IMPERSONATION_RISK:
        move_to("rule.impersonation_block", IMPERSONATION_RISK)
    codes = {r.code for r in reasons}
    vouched = bool(codes & {"domain.established", "domain.long_established"})  # registered for years: likely the business's own name
    if lookalike and not allowlisted and not vouched and round(_risk(total), 1) < warn_at:
        move_to("rule.lookalike_floor", warn_at)
    if agree and not allowlisted:
        # Free site builders and plain HTTP host countless small businesses: not enough to turn model scores into a block.
        structural = any(r.code in STRUCTURAL_CODES - BLOCK_EXEMPT_STRUCTURAL and r.points > 0 for r in reasons)
        target = block_at if structural and not vouched else warn_at  # years-old domains: warn at most
        if round(_risk(total), 1) < target:
            move_to("rule.models_agree_floor", target)
    # A near-certain URL model on a page hidden in a site's CMS folders: a compromised site, whatever its age.
    if url_sure and "url.cms_internal_path" in codes and not allowlisted and round(_risk(total), 1) < warn_at:
        move_to("rule.compromised_site_floor", warn_at)
    if "page.unrelated_redirect" in codes and not allowlisted and round(_risk(total), 1) < warn_at:
        move_to("rule.unrelated_redirect_floor", warn_at)
    if "page.parked" in codes and not allowlisted and round(_risk(total), 1) < warn_at:
        move_to("rule.parked_floor", warn_at)
    # A business domain now serving or forwarding to gambling (illegal in the UAE) or adult / pill sites.
    if codes & {"page.harmful_redirect", "page.gambling"} and not allowlisted and round(_risk(total), 1) < block_at:
        move_to("rule.takeover_block", block_at)
    floored = any(g.code.startswith("rule.") for g in guards) or bool(codes & {"page.parked", "page.unrelated_redirect"})
    # Minified or bot-checking scripts with only other generic findings (a young domain, a JS shell, redirects) and
    # the models not both confident: that is an ordinary new JavaScript-built site, not a warning.
    scripted = any(r.code in ("page.obfuscated_scripts", "page.cloaking_code") for r in positive)
    generic_only = scripted and all(r.code in GENERIC_CODES for r in positive)
    if generic_only and not agree:
        corroborated = False
    if not corroborated and not blocklisted and not floored and round(_risk(total), 1) >= warn_at:
        move_to("trust.needs_corroboration", warn_at - 1)
    takeover = bool(codes & {"page.harmful_redirect", "page.gambling"})
    if "page.parked" in codes and not (takeover or blocklisted) and round(_risk(total), 1) >= block_at:
        move_to("rule.parked_floor", block_at - 1)  # an expired, for-sale domain is not a scam in itself
    if round(_risk(total), 1) >= block_at and not _has_specific_finding(reasons):
        move_to("trust.needs_specific_finding", block_at - 1)
    if allowlisted and not blocklisted and round(_risk(total), 1) >= block_at:
        move_to("trust.allowlist_guard", block_at - 1)
    elif established and not (strong or impersonation or blocklisted or takeover) and round(_risk(total), 1) >= block_at:
        move_to("trust.block_guard", block_at - 1)
    llm = sum(r.points for r in reasons if r.code == "llm.judge" and r.points > 0)
    if llm and _decide(round(_risk(total), 1)) != _decide(round(_risk(total - llm), 1)):
        lower = _decide(round(_risk(total - llm), 1))
        move_to("trust.llm_bounded", (config.WARN_THRESHOLD if lower == Decision.ALLOW else block_at) - 1)
    risk = round(_risk(total), 1)
    return Assessment(risk, _decide(risk), guards)


_DECISION_WORDS = {
    Decision.ALLOW: ("Safe to open", "آمن للفتح"),
    Decision.WARN: ("Suspicious, proceed with caution", "مشبوه، تابع بحذر"),
    Decision.BLOCK: ("Blocked: likely scam", "محظور: احتيال محتمل"),
}


def summarize(reasons: list[Reason], risk: float, decision: Decision) -> tuple[str, str]:
    """Bilingual one-liner from the strongest contributions in the direction of the decision."""
    if decision == Decision.ALLOW:
        top = sorted((r for r in reasons if r.points < 0 and not r.code.startswith(GUARD_PREFIXES)), key=lambda r: r.points)[:3]
    else:
        top = sorted((r for r in reasons if r.points > 0), key=lambda r: -r.points)[:3]
    head_en, head_ar = _DECISION_WORDS[decision]
    en = f"{head_en} (risk {risk:.0f}/100)"
    ar = f"{head_ar} (درجة الخطورة {risk:.0f}/100)"
    if top:
        en += ": " + "; ".join(r.title_en for r in top) + "."
        ar += ": " + "؛ ".join(r.title_ar for r in top) + "."
    elif decision == Decision.ALLOW:
        en += ": no warning signs found."
        ar += ": لم يُعثر على مؤشرات خطر."
    if any(r.code == "page.parked" for r in reasons) and decision != Decision.BLOCK:
        en = f"Domain expired or parked for sale: not the business you are looking for (risk {risk:.0f}/100)."
        ar = f"النطاق منتهي الصلاحية أو معروض للبيع: ليس الموقع التجاري الذي تبحث عنه (درجة الخطورة {risk:.0f}/100)."
    elif decision == Decision.ALLOW and not top and (risk >= UNCERTAIN_RISK or any(r.code == "trust.needs_corroboration" for r in reasons)):
        # Allowed for lack of evidence, not vouched for: say so honestly.
        en = f"No evidence of a scam found; this site is new to us (risk {risk:.0f}/100)."
        ar = f"لم يُعثر على دليل احتيال؛ هذا الموقع جديد علينا (درجة الخطورة {risk:.0f}/100)."
    return en, ar


def score_verdict(verdict: Verdict, reasons: list[Reason]) -> Verdict:
    """Set reasons, risk, decision and summaries on a verdict from its findings."""
    allowlisted = any(r.code == "rep.allowlisted" for r in reasons) or bool(verdict.domain and verdict.domain.allowlisted)
    established = allowlisted or is_established(verdict.domain, verdict.host)
    result = assess(reasons, allowlisted=allowlisted, established=established)
    final_reasons = dedupe([r for r in reasons if not r.code.startswith(GUARD_PREFIXES)]) + result.guards
    final_reasons.sort(key=lambda r: -abs(r.points))
    verdict.reasons = final_reasons
    verdict.risk_score = result.risk_score
    verdict.decision = result.decision
    verdict.summary_en, verdict.summary_ar = summarize(final_reasons, result.risk_score, result.decision)
    return verdict


def hash_distance(a: Optional[str], b: Optional[str]) -> Optional[int]:
    """Hamming distance between two hex fuzzy hashes; None when either is missing."""
    if not a or not b:
        return None
    if len(a) == len(b):
        try:
            return bin(int(a, 16) ^ int(b, 16)).count("1")
        except ValueError:
            pass
    return 0 if a == b else 64


def is_high_finding(r: Reason) -> bool:
    return r.points > 0 and r.severity in (S.HIGH, S.CRITICAL) and not r.code.startswith(("model.", "llm."))
