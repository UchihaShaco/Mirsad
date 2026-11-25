"""UAE reporting channels, copied from docs/research/uae_threat_landscape.md section 3 with its sources.

These are listed in the case file for an officer to use. Nothing is ever sent automatically.
"""

from __future__ import annotations

UAE_CHANNELS = [
    {
        "name_en": 'Abu Dhabi Police "Aman" service',
        "name_ar": "خدمة «أمان» – شرطة أبوظبي",
        "scope_en": "Abu Dhabi; accepts cybercrime and fraud reports",
        "scope_ar": "إمارة أبوظبي؛ تستقبل بلاغات الجرائم الإلكترونية والاحتيال",
        "contact": "Toll-free 8002626 · SMS 2828 · aman@adpolice.gov.ae · ADP smart app",
        "contact_ar": "الرقم المجاني 8002626 · رسالة نصية 2828 · aman@adpolice.gov.ae · تطبيق شرطة أبوظبي الذكي",
        "source": "https://gulfnews.com/uae/crime/abu-dhabi-police-warn-public-about-fake-links-in-search-engines-1.500566188",
    },
    {
        "name_en": "Dubai Police eCrime platform",
        "name_ar": "منصة الجرائم الإلكترونية – شرطة دبي (eCrime)",
        "scope_en": "Dubai; online report needs mobile, email and Emirates ID or passport",
        "scope_ar": "إمارة دبي؛ يتطلب البلاغ رقم الهاتف والبريد الإلكتروني والهوية الإماراتية أو جواز السفر",
        "contact": "ecrime.ae / ecrimehub.gov.ae · Dubai Police app · 901 (non-emergency)",
        "contact_ar": "ecrime.ae / ecrimehub.gov.ae · تطبيق شرطة دبي · 901 (لغير الطوارئ)",
        "source": "https://www.emirates247.com/uae-guide/dubai-police-ecrime-hub-how-to-report-cybercrime-online-recover-from-scams-and-protect-yourself/6353",
    },
    {
        "name_en": "aeCERT / TDRA",
        "name_ar": "الفريق الوطني للاستجابة لطوارئ الحاسب الآلي (aeCERT) / هيئة تنظيم الاتصالات والحكومة الرقمية",
        "scope_en": "National CERT; TDRA can order ISP blocking through e& and du",
        "scope_ar": "الفريق الوطني للاستجابة للطوارئ؛ ويمكن للهيئة إلزام مزودي الخدمة (e& و du) بحجب الموقع",
        "contact": "Incident report to aeCERT (see u.ae cyber-safety page)",
        "contact_ar": "الإبلاغ عن الحادثة إلى aeCERT (انظر صفحة السلامة الرقمية على u.ae)",
        "source": "https://u.ae/en/information-and-services/justice-safety-and-the-law/cyber-safety-and-digital-security",
    },
    {
        "name_en": "Ministry of Interior cybercrime platform",
        "name_ar": "منصة الجرائم الإلكترونية – وزارة الداخلية",
        "scope_en": "Federal",
        "scope_ar": "اتحادي",
        "contact": '"MOIUAE" app',
        "contact_ar": "تطبيق MOIUAE",
        "source": "https://gulfnews.com/uae/crime/uae-ministry-of-interior-launches-cybercrime-platform-5-tips-to-avoid-online-fraud-1.500215172",
    },
]

NETBEACON = "https://netbeacon.org/"
CLOUDFLARE_ABUSE = "https://developers.cloudflare.com/fundamentals/reference/report-abuse/"
