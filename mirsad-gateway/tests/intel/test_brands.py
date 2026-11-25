import json
import time

import idna
import pytest

from scamshield.intel import brands as brand_module
from scamshield.intel.brands import canonical_phone, extract_phones, match_brand, normalise_arabic, skeleton
from scamshield.intel.reputation import PKG_DATA
from scamshield.schemas import FormInfo, PageSnapshot

REGISTRY = json.loads((PKG_DATA / "brands.json").read_text(encoding="utf-8"))["brands"]
NAMES = {b["id"]: b["name_en"] for b in REGISTRY} | {b.id: b.name_en for b in brand_module.global_brands()}


def idn(host: str) -> str:
    return idna.encode(host, uts46=True).decode()


def test_registry_shape():
    uae = [b for b in REGISTRY if b["country"] == "AE"]
    world = [b for b in REGISTRY if b["country"] != "AE"]
    assert len(uae) >= 60 and len(world) >= 40
    assert len({b["id"] for b in REGISTRY}) == len(REGISTRY)
    for b in REGISTRY:
        assert b["name_en"] and b["name_ar"] and b["domains"] and b["category"], b["id"]
        assert b["aliases_en"] and b["aliases_ar"], b["id"]
        assert any("؀" <= ch <= "ۿ" for ch in b["name_ar"]), b["id"]
        for phone in b["phones"]:
            assert phone.isdigit() and canonical_phone(phone) == phone, (b["id"], phone)
    owners: dict[str, str] = {}
    for b in REGISTRY:
        for d in b["domains"]:
            assert owners.setdefault(d, b["id"]) == b["id"], f"{d} listed under two brands"
    prioritised = {"rta", "dubaipolice", "adpolice", "itc", "salik", "parkin", "emiratespost", "aramex", "dubaicustoms",
                   "adcustoms", "uaepass", "icp", "gdrfad", "dewa", "tamm", "dubaiopera", "platinumlist"}
    assert prioritised <= {b["id"] for b in REGISTRY}


LOOKALIKES = [
    # combosquats: brand token + lure words
    ("https://adcb-secure-login.com/", "adcb", "combosquat"),
    ("https://salik-pay.icu/recharge", "salik", "combosquat"),
    ("http://rta-fines.top/", "rta", "combosquat"),
    ("https://tammpay.com/", "tamm", "combosquat"),
    ("https://uaepass-verify.online/", "uaepass", "combosquat"),
    ("https://darb-toll.com/pay", "itc", "combosquat"),
    ("https://nolcard-recharge.com/", "rta", "combosquat"),
    ("https://dewa-refund.com/", "dewa", "combosquat"),
    ("https://emiratespost-delivery.top/track", "emiratespost", "combosquat"),
    ("https://aramex-parcel.info/", "aramex", "combosquat"),
    ("https://emiratesid-renew.com/", "icp", "combosquat"),
    ("https://icp-uae.com/visa", "icp", "combosquat"),
    ("https://mohre-visa.com/", "mohre", "combosquat"),
    ("https://etisalat-rewards.net/", "etisalat", "combosquat"),
    ("https://my-emiratesnbd-online.com/", "emiratesnbd", "combosquat"),
    # wrong TLD copies
    ("https://adcb.top/", "adcb", "wrong_tld"),
    ("https://salik.online/", "salik", "wrong_tld"),
    ("https://uaepass.com.co/", "uaepass", "wrong_tld"),
    # typosquats (including reported Smishing Triad domains and the Dubai Opera impostor)
    ("https://emiratesislamc.com/", "emiratesislamic", "typosquat"),
    ("https://mashreqq.com/", "mashreq", "typosquat"),
    ("https://aramexx.com/", "aramex", "typosquat"),
    ("https://dubaipoliauey.top/", "dubaipolice", "typosquat"),
    ("https://dubopera.com/tickets", "dubaiopera", "typosquat"),
    ("https://flydubaii.com/", "flydubai", "typosquat"),
    ("https://uaepasss.com/", "uaepass", "typosquat"),
    ("https://instargam.com/", "instagram", "typosquat"),
    ("https://insatgram.com/", "instagram", "typosquat"),
    ("https://instagr.in/", "instagram", "typosquat"),
    ("https://gogle.com/", "google", "typosquat"),
    ("https://www.inkedin-ae.com/", "linkedin", "typosquat"),
    ("https://alfardannexchange.com/", "alfardan", "typosquat"),
    # homoglyphs: ASCII look-alikes and IDN confusables (Cyrillic, Latin extensions)
    ("https://rnashreq.com/", "mashreq", "homoglyph"),
    ("https://paypa1.com/", "paypal", "homoglyph"),
    ("https://" + idn("аdcb.com") + "/", "adcb", "homoglyph"),
    ("https://" + idn("uaeраss.ae") + "/", "uaepass", "homoglyph"),
    ("https://" + idn("sálik.ae") + "/", "salik", "homoglyph"),
    ("https://xn--80ak6aa92e.com/", "apple", "homoglyph"),
    # brand in a subdomain of an unrelated domain or on a publishing platform
    ("https://emiratesnbd.com.verify-account.xyz/", "emiratesnbd", "subdomain"),
    ("https://adcb.com-secure.info/login", "adcb", "subdomain"),
    ("https://dubaipolice.gov.ae.fine-pay.top/", "dubaipolice", "subdomain"),
    ("https://adcb.weebly.com/", "adcb", "subdomain"),
    ("https://uaepass-login.web.app/", "uaepass", "subdomain"),
    ("https://tamm.services-update.com/", "tamm", "subdomain"),
    # brand in the path of a publishing platform
    ("https://sites.google.com/view/adcb-login", "adcb", "path"),
    # well-known foreign brands from the Phishpedia domain map
    ("https://wellsfargo-login.com/", "global:Wells Fargo & Company", "combosquat"),
    ("https://navyfederal-secure.net/", "global:Navy Federal Credit Union", "combosquat"),
    # Arabic brand name in an IDN
    ("https://" + idn("شرطة-دبي.com") + "/", "dubaipolice", "combosquat"),
]


# The global brand list (Phishpedia-derived) is optional and not in the repository; its cases skip without it.
NO_GLOBAL_BRANDS = pytest.mark.skipif(not brand_module.global_brands_loaded(),
                                      reason="optional global_brands.json is not in this checkout")


@pytest.mark.parametrize("url,brand_id,technique", [
    pytest.param(*case, marks=NO_GLOBAL_BRANDS) if case[1].startswith("global:") else case for case in LOOKALIKES])
def test_lookalike_domains(url, brand_id, technique):
    match = match_brand(url)
    assert match is not None, url
    assert match.brand == NAMES[brand_id], (url, match.brand)
    assert technique in match.technique.split("+"), (url, match.technique)
    assert 0.5 <= match.score <= 1 and match.matched_on


ORDINARY = [
    "https://www.google.com/search?q=adcb", "https://en.wikipedia.org/wiki/Dubai_Police", "https://github.com/",
    "https://www.khaleejtimes.com/uae/rta-fines", "https://gulfnews.com/business/adcb-results",
    "https://www.thenationalnews.com/", "https://www.bbc.com/news", "https://stackoverflow.com/",
    "https://apps.apple.com/ae/app/uae-pass/id1377158818", "https://play.google.com/store/apps/details?id=ae.adcb",
    "https://www.amazon.com/", "https://www.booking.com/", "https://career.com/", "https://more.com/",
    "https://parking.ae/", "https://emirates247.com/", "https://etihadrail.ae/", "https://emirateswoman.com/",
    "https://noon-time.com/", "https://fabhotels.com/", "https://cbdoil.com/", "https://duolingo.com/",
    "https://amazonia.org/", "https://outlookindia.com/", "https://dubaiport.com/", "https://microsoft.github.io/vscode",
    "https://www.zawya.com/", "https://www.arabianbusiness.com/", "https://www.yallacompare.com/uae/en/banks/",
    "https://www.dubizzle.com/", "https://sites.google.com/view/team-handbook", "https://evil.weebly.com/",
    "https://1.2.3.4/login", "https://www.bayt.com/", "https://www.emaratalyoum.com/",
    "https://customs.gov.bd/", "https://topica.com/", "https://applied.com/", "https://email.cz/", "https://xcloud.com/",
    "https://fabcloud.org/", "https://metawin.com/", "https://landbank.com/", "https://duapps.com/", "https://zoominfo.com/",
    "https://www.navyfederal.org/", "https://www.credit-agricole.com/", "https://www.wellsfargo.com/",
    "https://alltissus.com/", "https://www.westmeathindependent.ie/", "https://www.independent.ie/",
    "https://www.offalyindependent.ie/", "https://www.meathchronicle.ie/", "https://tissus-du-monde.fr/",
    "https://www.duboislaw.com/", "https://maison-du-monde.com/", "https://www.dupont.com/", "https://www.xing.com/",
    # real Abu Dhabi organisations that resemble a registry brand only in a generic word or an acronym
    "https://www.adnec.ae/", "https://www.adnic.ae/", "https://www.adnoc.com/", "https://www.etihadairways.com/",
    "https://www.standardchartered.ae/", "https://www.emiratessteel.com/", "https://www.emiratesrc.ae/",
    "https://www.emiratesfire.ae/", "https://emiratespodiatry.ae/", "https://www.emiratesnet.com/",
    "https://emiratesesports.ae/", "https://emiratesca.com/", "https://www.emiratespp.com/", "https://www.emiratesbando.com/",
    "https://www.emiratessetup.de/", "https://www.emiratesdates.com/", "https://salek.ae/", "https://www.mbiuae.com/",
    "https://app.qmobility.ae/", "https://www.unioncopper.ae/", "https://virginmobile.sa/", "https://adib.eg/",
    "https://www.alrostamanitravel.ae/", "https://emirates-care.chariotai.app/", "https://www.abudhabinational.ae/",
    "https://www.dubaiholding.com/", "https://www.uaeexchange.com/", "https://www.nationalbonds.ae/",
    "https://fancy-pastelito-5dcf26.netlify.app/?utm_source=chatgpt.com",
]


@pytest.mark.parametrize("url", ORDINARY)
def test_ordinary_domains_do_not_match(url):
    assert match_brand(url) is None


def page(url, title="", text="", forms=(), html=""):
    return PageSnapshot(url=url, final_url=url, title=title, text=text, forms=list(forms), html=html)


CONTENT_POSITIVE = [
    (page("https://ju.fhjre.icu/", "شرطة دبي - دفع المخالفات",
          "مخالفات في الإمارات.. ادفع اليوم واحصل على خصم 50% دفع المخالفات أدخل رقم البطاقة وتاريخ الانتهاء",
          [FormInfo(asks_card=True, input_names=["card", "cvv"])]), "dubaipolice", "content"),
    (page("https://pay-online-now.top/", "RTA - Traffic Fines Inquiry",
          "Your unpaid traffic fine (50 dirhams) is due soon. Pay immediately to avoid an automatic addition of 500 dirhams today.",
          [FormInfo(asks_card=True)]), "rta", "content"),
    (page("https://gov-services.top/", "منصة تم - خدمات حكومة أبوظبي",
          "سداد المخالفات المرورية عبر منصة تم. أدخل رقم البطاقة ورمز التحقق", [FormInfo(asks_otp=True)]), "tamm", "content"),
    (page("https://track-epost.cyou/", "Track your shipment",
          "We could not deliver your parcel. Pay AED 3 delivery fee to reschedule. © 2026 Emirates Post Group",
          [FormInfo(asks_card=True)]), "emiratespost", "content"),
    (page("https://verify-now.sbs/", "Account verification",
          "Your account will be suspended within 24 hours. Verify your Emirates ID and card details.",
          [FormInfo(asks_password=True, input_names=["username", "password"])],
          html='<img class="header-logo" src="/assets/logo.png" alt="Abu Dhabi Commercial Bank">'), "adcb", "content"),
    (page("https://bank-helpdesk-support.com/", "Emirates NBD Customer Care Number 24/7",
          "Emirates NBD customer care helpline. Card blocked? Call us now on +971 55 000 0104 or WhatsApp 0097155 0000104.",
          html='<a href="tel:+971550000104">Call</a>'), "emiratesnbd", "fake_helpline"),
    (page("https://salik-help.blogspot.com/", "سالك - خدمة العملاء",
          "خدمة العملاء لسالك على مدار الساعة. اتصل بنا على الرقم ‎+44 20 7946 0958 لاسترداد رصيدك"), "salik", "fake_helpline"),
]


CARD = FormInfo(asks_card=True, input_names=["ccnum", "exp", "cvv"])
CARD_OTP = FormInfo(asks_card=True, asks_otp=True, input_names=["ccnum", "cvv", "otp"])
ID_OTP = FormInfo(asks_otp=True, asks_national_id=True, input_names=["emirates_id", "otp"])

# The brand is named in a page banner or only once in the text, never in the title: the shape of the
# simulated demo pages and of real smishing kits.
CONTENT_BANNER_AND_TEXT = [
    # police traffic fines: English banner, Arabic banner, mixed
    (page("http://pay-fines-now.com/", "Pay traffic fine - 50% discount today",
          "Abu Dhabi Police · Traffic Fines Payment. Unpaid traffic fine: AED 1,500. Pay within 24 hours to avoid "
          "vehicle impoundment and black points.", [CARD_OTP, ID_OTP],
          html="<header>Abu Dhabi Police · Traffic Fines Payment</header><h1>Unpaid traffic fine</h1>"), "adpolice"),
    (page("http://mokhalafat-uae.com/", "دفع المخالفات",
          "شرطة أبوظبي · دفع المخالفات. مخالفة رادار مسجلة على رقم هويتك. ادفع خلال ٢٤ ساعة لتحصل على خصم ٥٠٪.",
          [CARD_OTP], html="<header>شرطة أبوظبي · دفع المخالفات</header>"), "adpolice"),
    (page("http://fines-portal.top/", "Traffic fines · المخالفات المرورية",
          "Dubai Police شرطة دبي. You have an unpaid fine. لديك مخالفة غير مدفوعة. Pay now to avoid black points.",
          [CARD], html="<div class='site-logo'>Dubai Police · شرطة دبي</div>"), "dubaipolice"),
    # Emirates Post: named once in running text, English, Arabic, mixed
    (page("http://parcel-help-center.com/", "Parcel redelivery",
          "Your parcel is on hold. Emirates Post could not deliver your parcel. Pay the AED 7.50 redelivery fee "
          "within 12 hours or it will be returned to the sender.", [CARD_OTP]), "emiratespost"),
    (page("http://tawseel-track.com/", "إعادة توصيل الشحنة",
          "لم نتمكن من توصيل الطرد الخاص بك من بريد الإمارات. ادفع رسوم التوصيل 7.50 درهم خلال 12 ساعة.", [CARD]),
     "emiratespost"),
    (page("http://track-my-parcel.info/", "Parcel on hold · الطرد معلق",
          "Emirates Post: your shipment is on hold. بريد الإمارات: الشحنة معلقة. Delivery fee AED 3.", [CARD_OTP]),
     "emiratespost"),
    # UAE PASS
    (page("http://digital-id-verify.com/", "Account verification",
          "UAE PASS | الهوية الرقمية. Your UAE PASS account will be suspended. أدخل رمز التحقق within 24 hours.",
          [ID_OTP], html="<header>UAE PASS | الهوية الرقمية</header>"), "uaepass"),
    (page("http://hawiya-login.com/", "تسجيل الدخول",
          "حسابك في الهوية الرقمية موقوف. أدخل رقم الهوية ورمز التحقق خلال 24 ساعة لتجنب الإيقاف.", [ID_OTP]), "uaepass"),
    # banks
    (page("http://card-unlock-service.com/", "تحديث البيانات",
          "بنك الإمارات دبي الوطني. تم إيقاف بطاقتك. حدث بياناتك وأدخل رقم البطاقة ورمز التحقق فورا.", [CARD_OTP],
          html="<header>بنك الإمارات دبي الوطني</header>"), "emiratesnbd"),
    (page("http://secure-card-check.com/", "Card verification",
          "Your Mashreq card has been blocked. Verify your card details within 24 hours to avoid suspension.",
          [CARD_OTP]), "mashreq"),
    # utilities
    (page("http://bill-refund-center.com/", "Refund · استرداد",
          "Dubai Electricity and Water Authority: you have an overpaid bill. لديك مبلغ مسترد. Claim your refund of "
          "AED 230 within 24 hours.", [CARD]), "dewa"),
    (page("http://kahraba-refund.com/", "استرداد فاتورة",
          "هيئة كهرباء ومياه وغاز الشارقة: لديك مبلغ مسترد 230 درهم من فاتورة الكهرباء. أدخل بيانات البطاقة خلال 24 ساعة.",
          [CARD]), "sewa"),
]


@pytest.mark.parametrize("snapshot,brand_id", CONTENT_BANNER_AND_TEXT, ids=lambda v: getattr(v, "url", v))
def test_content_banner_and_single_mention(snapshot, brand_id):
    match = match_brand(snapshot.url, snapshot)
    assert match is not None, snapshot.url
    assert match.brand == NAMES[brand_id], match.brand
    assert "content" in match.technique.split("+")
    assert match.official_domains and match.score >= 0.55


def test_checkout_naming_its_courier_is_not_impersonation():
    checkout = page("http://oasisroastery.com/checkout", "Checkout - Oasis Roastery",
                    "We ship with Aramex. Delivery fee AED 15. Enter your card number and CVV.", [CARD])
    assert match_brand(checkout.url, checkout) is None
    news = page("http://localnews.example/scam", "Beware of fake Emirates Post messages",
                "Emirates Post warns residents: messages saying your parcel is on hold are fake. Do not pay any fee "
                "within 12 hours. © 2026 Local News", [FormInfo(input_names=["email"])])
    assert match_brand(news.url, news) is None


@pytest.mark.parametrize("snapshot,brand_id,technique", CONTENT_POSITIVE)
def test_content_impersonation(snapshot, brand_id, technique):
    match = match_brand(snapshot.url, snapshot)
    assert match is not None
    assert match.brand == NAMES[brand_id], match.brand
    assert technique in match.technique.split("+"), match.technique
    assert match.score >= 0.6


CONTENT_NEGATIVE = [
    page("https://www.adcb.com/en/personal", "ADCB - Personal Banking", "Log in to ADCB internet banking. Card number. OTP.",
         [FormInfo(asks_password=True, asks_otp=True)]),
    page("https://www.dubaipolice.gov.ae/app/services/fine-payment", "Dubai Police - Fine Payment",
         "Pay traffic fines. Enter your card number.", [FormInfo(asks_card=True)]),
    page("https://smallnews.example/fake-fines", "Dubai Police warn of fake fine payment websites",
         "Dubai Police warned residents of fake websites asking to pay traffic fines. Report scams on 901. "
         "Copyright © 2026 Small News Network"),
    page("https://bankcompare.example/cards", "Best credit cards in the UAE: ADCB vs Emirates NBD vs FAB vs Mashreq",
         "Compare ADCB, Emirates NBD, First Abu Dhabi Bank, Mashreq and RAKBANK credit cards. Pay no annual fee. "
         "ADCB offers cashback, Emirates NBD offers miles, FAB offers rewards, Mashreq offers discounts of 10% off.",
         [FormInfo(input_names=["email"])]),
    page("https://bankhelplines.example/adcb", "ADCB customer care number",
         "ADCB customer care helpline: call 600 50 2030 from the UAE or +971 2 621 0090 from abroad."),
    page("https://apkmirror.example/adcb", "ADCB Mobile Banking APK download",
         "Download the ADCB app. Version 9.1. Released by Abu Dhabi Commercial Bank."),
    page("https://alltissus.com/", "Tissus au mètre pas cher | Alltissus",
         "Connexion à votre compte. Mot de passe oublié ? Tissus du monde, coton du Japon. © Promos du mois - All Tissus",
         [FormInfo(asks_password=True, input_names=["email", "password"])],
         html='<img class="logo" alt="All Tissus"><meta property="og:site_name" content="All Tissus">'),
    page("https://www.westmeathindependent.ie/", "Westmeath Independent",
         "Westmeath Independent. Sign in to your account to read the paper. Pay now for a subscription. "
         "© 2019 Westmeath Independent and Celtic Media Group. All rights reserved.",
         [FormInfo(asks_password=True, input_names=["username", "password"])],
         html='<img class="logo" alt="Westmeath Independent logo">'),
    page("https://www.khaleejtimes.com/uae/salik", "Salik raises toll", "Salik toll gates in Dubai. Pay toll fees via the app."),
]


@pytest.mark.parametrize("snapshot", CONTENT_NEGATIVE, ids=lambda p: p.url)
def test_content_third_parties_do_not_match(snapshot):
    assert match_brand(snapshot.url, snapshot) is None


def test_redirect_to_official_site_still_flags_the_lookalike():
    snapshot = PageSnapshot(url="https://adcb-verify.top/", final_url="https://www.adcb.com/", title="ADCB", text="ADCB")
    match = match_brand("https://adcb-verify.top/", snapshot)
    assert match is not None and match.brand == NAMES["adcb"]


def test_domain_and_content_evidence_combine():
    snapshot = page("https://salik-recharge.icu/", "Salik", "Recharge your Salik account now. Card number. CVV.",
                    [FormInfo(asks_card=True)])
    domain_only = match_brand(snapshot.url)
    combined = match_brand(snapshot.url, snapshot)
    assert combined.score > domain_only.score
    assert combined.technique == "combosquat+content"


def test_text_helpers():
    assert normalise_arabic("شُرطة أبوظبي") == "شرطه ابوظبي"
    assert skeleton("аdсb") == "adcb"
    assert canonical_phone("+971 2 621 0090") == "026210090"
    assert canonical_phone("00971 800 555") == "800555"
    assert canonical_phone("٦٠٠ ٥٢ ٥٥٠٠") == "600525500"
    assert extract_phones("Call +971 55 000 0104 or 600 52 5500 since 2019. Price 1,250.00") == ["0550000104", "600525500"]


def test_match_brand_latency():
    urls = [u for u, _, _ in LOOKALIKES] + ORDINARY
    match_brand("warm.example")
    started = time.perf_counter()
    for url in urls:
        match_brand(url)
    per_call_ms = (time.perf_counter() - started) * 1000 / len(urls)
    assert per_call_ms < 10


def test_brand_index_is_cached():
    assert brand_module.brands() is brand_module.brands()
