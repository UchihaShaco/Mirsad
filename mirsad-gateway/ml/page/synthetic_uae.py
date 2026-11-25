"""SYNTHETIC "UAE scenario" evaluation set (never used for training, never served).

Public phishing corpora have almost no UAE pages (no TAMM / UAE PASS / traffic-fine phishing at
all), so this set checks behaviour on the lures UAE residents actually receive. Pages are plain,
generic HTML built from templates; brand names appear in text only (no logos, markup or styling
copied from any real site). Lure wording follows docs/research/uae_threat_landscape.md section 2.

  * scam (label 1): traffic fine, toll / parking, parcel fee, UAE PASS / Emirates ID OTP, bank
    account suspended - on look-alike / unrelated domains, English, Arabic and mixed.
  * legit-style (label 0): the same services described neutrally on the organisations' official
    domains (including real-looking login and payment forms), plus ordinary UAE businesses
    (restaurants, clinics, schools, shops) in English and Arabic on their own domains.

Caveat: official domains of these brands are in the page model's brand table, so legit pages on
official domains are easier for it than an unseen brand would be; the generic-business pages are
the harder legitimate cases.

    .venv/bin/python -m ml.page.synthetic_uae      # writes ml/data/synthetic_uae/pages.parquet
"""

from __future__ import annotations

import hashlib
import random
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml" / "data" / "synthetic_uae" / "pages.parquet"

SCENARIOS = {
    "traffic_fine": dict(
        brands=[("Dubai Police", "شرطة دبي", "dubaipolice.gov.ae"), ("Abu Dhabi Police", "شرطة أبوظبي", "adpolice.gov.ae"),
                ("Ministry of Interior", "وزارة الداخلية", "moi.gov.ae")],
        scam_domains=["{s}-fines-pay.com", "uae-traffic-{s}.top", "{s}-violations.online", "pay-{s}-fine.info",
                      "{s}.gov-ae.site"],
        en=["You have an unpaid traffic fine of AED {amt}. Pending Status.", "Pay today and get 50% discount.",
            "Avoid the issuance of a further fine and black points.", "Enter your plate number to see your fines.",
            "Automatic addition of 500 dirhams if not paid within 24 hours."],
        ar=["لديك مخالفة مرورية غير مدفوعة بقيمة {amt} درهم.", "ادفع اليوم واحصل على خصم 50%.",
            "تجنب الغرامة والنقاط السوداء، سداد المخالفات فوراً.", "الاستعلام عن المخالفات برقم اللوحة.",
            "رسوم متأخرة خلال 24 ساعة."],
        legit_en=["Traffic fines inquiry and payment services.", "You can view fines by plate number or traffic file.",
                  "Payments are processed through the official government payment gateway."],
        legit_ar=["خدمة الاستعلام عن المخالفات المرورية ودفعها.", "يمكنك عرض المخالفات برقم اللوحة أو الملف المروري."]),
    "toll_parking": dict(
        brands=[("Salik", "سالك", "salik.ae"), ("RTA", "هيئة الطرق والمواصلات", "rta.ae"),
                ("Darb", "درب", "itc.gov.ae")],
        scam_domains=["{s}-toll-pay.com", "{s}-ae.top", "{s}uae-recharge.xyz", "{s}-balance-due.online"],
        en=["Your {b} account has overdue toll fees of AED {amt}.", "Reply Y to open the secure payment portal.",
            "Your account will be suspended within 24 hours.", "Pay now to avoid a late fee."],
        ar=["رسوم بوابات التعرفة المرورية متأخرة على حسابك بقيمة {amt} درهم.", "سيتم إيقاف الحساب خلال 24 ساعة.",
            "ادفع الآن لتجنب الرسوم المتأخرة."],
        legit_en=["Recharge your toll account and view trip history.", "Register a vehicle and manage tags."],
        legit_ar=["اشحن رصيد حسابك واطلع على سجل الرحلات.", "تسجيل المركبات وإدارة الملصقات."]),
    "parcel_fee": dict(
        brands=[("Emirates Post", "بريد الإمارات", "emiratespost.ae"), ("Aramex", "أرامكس", "aramex.com")],
        scam_domains=["{s}-delivery.info", "{s}-redelivery.com", "track-{s}-uae.top", "{s}-customs-fee.online"],
        en=["We could not deliver your parcel: address incomplete.", "Pay a small delivery charge of AED {amt} to "
            "re-schedule delivery.", "Your package is on hold. Customs clearance fee required.",
            "Update your details or the shipment will be returned."],
        ar=["لا نستطيع توصيل شحنتك بسبب عنوان غير مكتمل.", "يرجى دفع رسوم التوصيل {amt} درهم لإعادة جدولة التوصيل.",
            "إشعار رسمي بحجز جمركي، رسوم جمركية مستحقة.", "يرجى تأكيد بياناتك وإلا سيتم إرجاع الشحنة."],
        legit_en=["Track your shipment with your tracking number.", "Find a branch, rates and delivery times."],
        legit_ar=["تتبع شحنتك برقم التتبع.", "ابحث عن أقرب فرع والأسعار ومواعيد التوصيل."]),
    "uaepass_eid": dict(
        brands=[("UAE PASS", "الهوية الرقمية", "uaepass.ae"), ("ICP", "الهيئة الاتحادية للهوية والجنسية", "icp.gov.ae"),
                ("TAMM", "تم", "tamm.abudhabi")],
        scam_domains=["{s}-verify.top", "{s}-update-id.com", "{s}-login.online", "secure-{s}.site"],
        en=["UAE PASS verification required.", "Your Emirates ID expired. Update Emirates ID now.",
            "Enter the OTP sent to your mobile to verify your identity.", "Residency renewal: fast-track visa."],
        ar=["مطلوب التحقق من الهوية الرقمية.", "الهوية الإماراتية منتهية، تحديث بيانات الهوية فوراً.",
            "أدخل رمز التحقق المرسل إلى هاتفك.", "كلمة المرور لمرة واحدة.", "تجديد الإقامة وتأشيرة سريعة."],
        legit_en=["Sign in to government services with your digital identity.", "Apply for and renew Emirates ID."],
        legit_ar=["سجل الدخول إلى الخدمات الحكومية بهويتك الرقمية.", "طلب وتجديد بطاقة الهوية."]),
    "bank_suspended": dict(
        brands=[("ADCB", "بنك أبوظبي التجاري", "adcb.com"), ("Emirates NBD", "الإمارات دبي الوطني", "emiratesnbd.com"),
                ("FAB", "بنك أبوظبي الأول", "bankfab.com"), ("Mashreq", "بنك المشرق", "mashreq.com"),
                ("Dubai Islamic Bank", "بنك دبي الإسلامي", "dib.ae")],
        scam_domains=["{s}-secure-update.online", "{s}-kyc.top", "{s}online-verify.com", "{s}-unblock.site"],
        en=["Your card has been blocked. Account suspended.", "KYC update required to unfreeze your account.",
            "Verify your bank account to avoid suspension.", "You are entitled to a refund of AED {amt}.",
            "Enter OTP and CVV to confirm."],
        ar=["تم إيقاف بطاقتك وتم تجميد حسابك.", "تحديث البيانات المصرفية مطلوب فوراً.", "أدخل رمز OTP لتأكيد العملية.",
            "يحق لك استرداد مبلغ {amt} درهم.", "تجنب الإيقاف خلال 24 ساعة."],
        legit_en=["Online banking login.", "Personal loans, cards and accounts.",
                  "We will never ask for your OTP or password by phone or SMS."],
        legit_ar=["تسجيل الدخول إلى الخدمات المصرفية عبر الإنترنت.", "لن نطلب منك أبداً رمز التحقق أو كلمة المرور."]),
}

SCAM_FORMS = {
    "card": ("<label>Card number / رقم البطاقة</label><input name='cardnumber' inputmode='numeric' maxlength='19'>"
             "<label>Expiry / تاريخ الانتهاء</label><input name='exp' placeholder='MM/YY'>"
             "<label>CVV</label><input name='cvv' maxlength='4'>"),
    "otp": "<label>OTP / رمز التحقق</label><input name='otp' maxlength='6'>",
    "eid": "<label>Emirates ID / رقم الهوية</label><input name='eid' placeholder='784-XXXX-XXXXXXX-X'>",
    "login": "<label>Username</label><input name='user'><label>Password</label><input type='password' name='pass'>",
    "plate": "<label>Plate number / رقم اللوحة</label><input name='plate'>",
    "phone": "<label>Mobile / رقم الهاتف</label><input type='tel' name='mobile'>",
}

BUSINESSES_EN = [("Al Noor Family Clinic", "Book an appointment with our doctors. Call us or leave your mobile number."),
                 ("Marina Bites Restaurant", "Order online, see our menu and opening hours. Free delivery in Dubai Marina."),
                 ("Sunrise Nursery Abu Dhabi", "Admissions open for 2027. Contact us to arrange a visit."),
                 ("Desert Gear Outdoor Shop", "Camping and hiking equipment. Pay by card at checkout. Free returns."),
                 ("Gulf Tutors Centre", "Maths and science tutoring. Sign in to the parent portal to see progress.")]
BUSINESSES_AR = [("عيادة النور العائلية", "احجز موعداً مع أطبائنا. اتصل بنا أو اترك رقم هاتفك."),
                 ("مطعم مارينا", "اطلب أونلاين واطلع على قائمة الطعام وساعات العمل. توصيل مجاني."),
                 ("حضانة الشروق أبوظبي", "التسجيل مفتوح لعام 2027. تواصل معنا لترتيب زيارة."),
                 ("متجر معدات الرحلات", "معدات التخييم والرحلات. الدفع بالبطاقة عند الشراء. إرجاع مجاني."),
                 ("مركز الخليج للدروس", "دروس الرياضيات والعلوم. سجل الدخول إلى بوابة أولياء الأمور.")]


def page(title: str, paras: list[str], form: str, action: str, lang: str, footer: str) -> str:
    dir_ = ' dir="rtl"' if lang == "ar" else ""
    body = "".join(f"<p>{p}</p>" for p in paras)
    form_html = f"<form method='post' action='{action}'>{form}<button type='submit'>Continue / متابعة</button></form>" \
        if form else ""
    return (f"<!doctype html><html lang='{lang}'{dir_}><head><meta charset='utf-8'><title>{title}</title></head>"
            f"<body><h1>{title}</h1>{body}{form_html}<footer>{footer}</footer></body></html>")


def build(n_per_class: int = 150, seed: int = 0) -> pd.DataFrame:
    rng = random.Random(seed)
    rows = []
    names = list(SCENARIOS)
    for i in range(n_per_class):
        sc = SCENARIOS[names[i % len(names)]]
        b_en, b_ar, official = rng.choice(sc["brands"])
        lang = ["en", "ar", "mixed"][i % 3]
        stem = official.split(".")[0]
        domain = rng.choice(sc["scam_domains"]).format(s=stem)
        amt = rng.choice([3, 4, 9, 12, 25, 50, 150, 400])
        en = [p.format(amt=amt, b=b_en) for p in rng.sample(sc["en"], min(3, len(sc["en"])))]
        ar = [p.format(amt=amt, b=b_ar) for p in rng.sample(sc["ar"], min(3, len(sc["ar"])))]
        paras = en if lang == "en" else ar if lang == "ar" else en[:2] + ar[:2]
        title = {"en": f"{b_en} - Payment", "ar": f"{b_ar} - الدفع", "mixed": f"{b_en} | {b_ar}"}[lang]
        kinds = rng.sample(list(SCAM_FORMS), 2)
        if names[i % len(names)] in ("parcel_fee", "traffic_fine", "toll_parking", "bank_suspended"):
            kinds = ["card"] + [k for k in kinds if k != "card"][:1]
        form = "".join(SCAM_FORMS[k] for k in kinds)
        action = rng.choice(["pay.php", "/submit", f"https://api-{rng.randint(100, 999)}.xyz/collect.php", ""])
        footer = f"© 2026 {b_en} {b_ar}"
        url = f"https://{rng.choice(['', 'www.', 'portal.'])}{domain}/{rng.choice(['', 'pay', 'verify', 'ae/login'])}"
        rows.append(dict(url=url, label=1, scenario=names[i % len(names)], lang=lang, brand=b_en,
                         html=page(title, paras, form, action, "ar" if lang == "ar" else "en", footer)))
    for i in range(n_per_class):
        lang = ["en", "ar", "mixed"][i % 3]
        if i % 4 == 3:  # ordinary UAE businesses on their own domains
            name_en, text_en = BUSINESSES_EN[i % len(BUSINESSES_EN)]
            name_ar, text_ar = BUSINESSES_AR[i % len(BUSINESSES_AR)]
            dom = rng.choice(["{}.ae", "{}-uae.com", "{}.com"]).format(
                ["alnoorclinic", "marinabites", "sunrisenursery", "desertgear", "gulftutors"][i % 5])
            title = name_en if lang == "en" else name_ar if lang == "ar" else f"{name_en} | {name_ar}"
            paras = [text_en] if lang == "en" else [text_ar] if lang == "ar" else [text_en, text_ar]
            form = rng.choice(["", SCAM_FORMS["phone"], SCAM_FORMS["login"], SCAM_FORMS["card"]])
            rows.append(dict(url=f"https://www.{dom}/{i}", label=0, scenario="business", lang=lang, brand="",
                             html=page(title, paras, form, "/contact", "ar" if lang == "ar" else "en",
                                       f"© 2026 {name_en}")))
            continue
        name = names[(i // 3) % len(names)]
        sc = SCENARIOS[name]
        b_en, b_ar, official = rng.choice(sc["brands"])
        paras = sc["legit_en"] if lang == "en" else sc["legit_ar"] if lang == "ar" else sc["legit_en"][:1] + sc["legit_ar"][:1]
        title = {"en": f"{b_en} - Services", "ar": f"{b_ar} - الخدمات", "mixed": f"{b_en} | {b_ar}"}[lang]
        form = rng.choice([SCAM_FORMS["login"], SCAM_FORMS["plate"], SCAM_FORMS["otp"] + SCAM_FORMS["login"], ""])
        url = f"https://{rng.choice(['www.', 'services.', ''])}{official}/{rng.choice(['', 'en/login', 'ar/services'])}"
        rows.append(dict(url=url, label=0, scenario=name, lang=lang, brand=b_en,
                         html=page(title, paras, form, "/auth/login", "ar" if lang == "ar" else "en",
                                   f"© 2026 {b_en} {b_ar}")))
    df = pd.DataFrame(rows)
    df["source"] = "synthetic_uae"
    df["source_id"] = [hashlib.sha256((u + h).encode()).hexdigest() for u, h in zip(df["url"], df["html"])]
    return df.drop_duplicates("source_id")


if __name__ == "__main__":
    d = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    d.to_parquet(OUT, index=False)
    print(d.groupby(["label", "scenario", "lang"]).size())
