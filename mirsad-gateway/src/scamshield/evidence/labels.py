"""Bilingual labels shared by the case report and the takedown requests."""

from __future__ import annotations

DECISION = {
    "allow": ("Allow", "سماح"),
    "warn": ("Warn", "تحذير"),
    "block": ("Block", "حظر"),
}

SEVERITY = {
    "info": ("Info", "معلومة"),
    "low": ("Low", "منخفض"),
    "medium": ("Medium", "متوسط"),
    "high": ("High", "مرتفع"),
    "critical": ("Critical", "حرج"),
}

REVIEW_OUTCOME = {
    "confirmed": ("Block confirmed", "تم تأكيد الحظر"),
    "overturned": ("Block overturned", "تم إلغاء الحظر"),
    "downgraded": ("Downgraded to warning", "خُفّض إلى تحذير"),
    "inconclusive": ("Inconclusive, block stands", "غير حاسم، يبقى الحظر"),
}

STAGE = {
    "reputation": ("Reputation", "السمعة"),
    "url": ("URL analysis", "تحليل الرابط"),
    "page": ("Page analysis", "تحليل الصفحة"),
    "deep": ("Deep crawl", "الزحف العميق"),
}

FIELD = {
    "case_ref": ("Case reference", "رقم مرجع القضية"),
    "verdict_id": ("Verdict id", "معرّف الحكم"),
    "url": ("Reported URL", "الرابط المُبلَّغ عنه"),
    "final_url": ("Final URL", "الرابط النهائي"),
    "host": ("Host", "اسم المضيف"),
    "decision": ("Decision", "القرار"),
    "risk": ("Risk score", "درجة الخطورة"),
    "stage": ("Analysis depth", "عمق التحليل"),
    "first_seen": ("Investigation started", "بدء التحقيق"),
    "last_update": ("Verdict last updated", "آخر تحديث للحكم"),
    "page_fetched": ("Page fetched by engine", "جلب الصفحة بواسطة المحرك"),
    "screenshot_at": ("Screenshot captured", "التقاط لقطة الشاشة"),
    "pack_built": ("Evidence pack built", "إعداد حزمة الأدلة"),
    "registrar": ("Registrar", "جهة التسجيل"),
    "created": ("Domain created", "تاريخ إنشاء النطاق"),
    "age": ("Domain age", "عمر النطاق"),
    "expires": ("Registration expires", "انتهاء التسجيل"),
    "registrant": ("Registrant", "صاحب التسجيل"),
    "registrant_country": ("Registrant country", "بلد المسجِّل"),
    "nameservers": ("Name servers", "خوادم الأسماء"),
    "registrar_abuse": ("Registrar abuse contact", "جهة الإبلاغ لدى المسجِّل"),
    "ips": ("IP addresses", "عناوين IP"),
    "asn": ("Network (ASN)", "الشبكة (ASN)"),
    "network": ("Network owner", "مالك الشبكة"),
    "hosting_country": ("Hosting country", "بلد الاستضافة"),
    "hosting_abuse": ("Hosting abuse contact", "جهة الإبلاغ لدى الاستضافة"),
    "tls_issuer": ("Certificate issuer", "مُصدر الشهادة"),
    "tls_subject": ("Certificate subject", "صاحب الشهادة"),
    "tls_valid": ("Valid from / to", "صالحة من / إلى"),
    "tls_age": ("Certificate age", "عمر الشهادة"),
    "tls_sans": ("Names on certificate", "الأسماء في الشهادة"),
    "tls_sha256": ("Certificate SHA-256", "بصمة الشهادة SHA-256"),
    "url_model": ("URL model", "نموذج الرابط"),
    "page_model": ("Page model", "نموذج الصفحة"),
    "llm": ("Language-model judge", "تقييم النموذج اللغوي"),
    "campaign": ("Linked campaign", "الحملة المرتبطة"),
    "pages_crawled": ("Pages crawled", "الصفحات التي تم فحصها"),
    "brand": ("Impersonated brand", "العلامة المنتحَلة"),
    "official_domains": ("Official domains", "النطاقات الرسمية"),
    "technique": ("Technique", "الأسلوب"),
    "matched_on": ("Matched on", "مؤشرات المطابقة"),
    "confidence": ("Confidence", "درجة الثقة"),
    "page_title": ("Page title", "عنوان الصفحة"),
    "http_status": ("HTTP status", "رمز استجابة HTTP"),
    "forms": ("Data the page asks for", "البيانات التي تطلبها الصفحة"),
    "outcome": ("Outcome", "النتيجة"),
    "recommended": ("Recommended decision", "القرار الموصى به"),
    "reviewer": ("Reviewer", "جهة المراجعة"),
    "review_started": ("Review started", "بدء المراجعة"),
    "review_finished": ("Review finished", "انتهاء المراجعة"),
}

PRIVATE_HOSTING = ("Private or reserved address: hosting provider unknown",
                   "عنوان خاص أو محجوز: مزوّد الاستضافة غير معروف")

ASKS = {
    "asks_password": ("password", "كلمة المرور"),
    "asks_card": ("payment card", "بطاقة الدفع"),
    "asks_otp": ("one-time code (OTP)", "رمز التحقق لمرة واحدة"),
    "asks_national_id": ("national ID", "رقم الهوية"),
}

FILES = {
    "report.pdf": ("This case report (PDF)", "تقرير القضية (PDF)"),
    "report.html": ("This case report (HTML)", "تقرير القضية (HTML)"),
    "screenshot.png": ("Live capture: the site loaded by a headless browser posing as the engine's phone",
                       "لقطة مباشرة: الموقع كما حمّله متصفح آلي بهوية هاتف المحرك"),
    "screenshot_engine.png": ("As seen by the engine: the analysed HTML rendered offline",
                              "كما رآه المحرك: الشيفرة التي حُلّلت معروضة دون اتصال بالشبكة"),
    "summary.json": ("Key facts of the case (machine-readable)", "أهم وقائع القضية بصيغة قابلة للقراءة آلياً"),
    "rendered_dom.html": ("Page as rendered by the browser", "الصفحة كما عرضها المتصفح"),
    "capture.html": ("Page HTML as fetched by the engine", "شيفرة الصفحة كما جلبها المحرك"),
    "headers.json": ("HTTP response headers", "ترويسات استجابة HTTP"),
    "verdict.json": ("Full machine-readable verdict", "الحكم الكامل بصيغة قابلة للقراءة آلياً"),
    "registration_raw.json": ("Raw registration (RDAP) and network records", "سجلات التسجيل والشبكة الأصلية"),
    "tls_certificate.pem": ("TLS certificate presented by the site", "شهادة TLS التي قدّمها الموقع"),
    "takedown_request.txt": ("Abuse / takedown request (English)", "طلب الإزالة (بالإنجليزية)"),
    "takedown_request_ar.txt": ("Report for UAE authorities (Arabic)", "بلاغ للجهات المختصة في الدولة (بالعربية)"),
    "manifest.json": ("SHA-256 chain-of-custody manifest", "سجل سلسلة الحيازة مع بصمات SHA-256"),
}

# Preferred Arabic terms for the report (model-written Arabic sometimes uses looser words, e.g. «المجال» for a domain).
GLOSSARY = [
    ("domain (internet)", "نطاق", "not «مجال»"),
    ("domain registrar", "جهة تسجيل النطاقات", ""),
    ("hosting provider", "مزوّد الاستضافة", ""),
    ("phishing", "تصيّد احتيالي", ""),
    ("impersonation", "انتحال صفة", ""),
    ("cloaking", "تمويه (عرض محتوى مختلف لأدوات الفحص)", ""),
    ("takedown request", "طلب إزالة", ""),
    ("chain of custody", "سلسلة الحيازة", ""),
    ("TLS certificate", "شهادة أمان TLS", ""),
    ("Department of Municipalities and Transport (DMT)", "دائرة البلديات والنقل", "not «إدارة»"),
    ("Telecommunications and Digital Government Regulatory Authority (TDRA)", "هيئة تنظيم الاتصالات والحكومة الرقمية", ""),
]
