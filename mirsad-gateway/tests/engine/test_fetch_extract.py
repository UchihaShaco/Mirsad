import json

import pytest

from scamshield.engine.extract import detect_language, parse_html

URL = "https://portal.example.ae/account/"


def form_of(markup: str):
    return parse_html(f"<html><body>{markup}</body></html>", URL).forms[0]


@pytest.mark.parametrize(
    "markup, flag",
    [
        ('<form><input type="password" name="x"></form>', "asks_password"),
        ('<form><label for="a">كلمة المرور</label><input id="a" name="f1"></form>', "asks_password"),
        ('<form><input name="cardNumber"></form>', "asks_card"),
        ('<form><input autocomplete="cc-csc" name="z"></form>', "asks_card"),
        ('<form><label>رقم البطاقة <input name="n"></label></form>', "asks_card"),
        ('<form><span>تاريخ الانتهاء</span><input name="q1"></form>', "asks_card"),
        ('<form><input autocomplete="one-time-code" name="c"></form>', "asks_otp"),
        ('<form><input placeholder="أدخل رمز التحقق" name="c"></form>', "asks_otp"),
        ('<form><input placeholder="784-XXXX-XXXXXXX-X" name="c"></form>', "asks_national_id"),
        ('<form><label for="e">Emirates ID</label><input id="e" name="c"></form>', "asks_national_id"),
        ('<form><input placeholder="رقم الهوية" name="c"></form>', "asks_national_id"),
        ('<form><input type="tel" name="c"></form>', "asks_phone"),
        ('<form><input placeholder="رقم الهاتف المتحرك" name="c"></form>', "asks_phone"),
    ],
)
def test_sensitive_fields_in_english_and_arabic(markup, flag):
    assert getattr(form_of(markup), flag)


def test_id_card_is_not_a_payment_card_and_passport_is_not_a_password():
    form = form_of('<form><label>بطاقة الهوية<input name="c"></label><input name="passport_no"></form>')
    assert form.asks_national_id and not form.asks_card and not form.asks_password


def test_search_form_is_harmless_and_same_site():
    form = form_of('<form action="/search"><input name="q" type="search" placeholder="Search"></form>')
    assert form.action == "https://portal.example.ae/search" and not form.external_action
    assert not (form.asks_password or form.asks_card or form.asks_otp or form.asks_national_id or form.asks_phone)


def test_form_actions_to_other_sites_and_mailto_are_external():
    assert form_of('<form action="https://grab.example.net/p.php"><input name="a"></form>').external_action
    assert form_of('<form action="mailto:x@example.net"><input name="a"></form>').external_action
    assert not form_of('<form action="https://login.example.ae/p"><input name="a"></form>').external_action


def test_inputs_outside_any_form_are_still_reported():
    page = parse_html('<div><input name="user"><input type="password" name="pw"><button>Go</button></div>', URL)
    assert len(page.forms) == 1 and page.forms[0].asks_password and page.forms[0].input_names == ["user", "pw"]


def test_links_iframes_scripts_and_external_hosts():
    page = parse_html(
        '<html><head><base href="https://portal.example.ae/app/"><script src="main.js"></script>'
        '<script src="https://cdn.other.example/x.js"></script><link rel="icon" href="/i.png"></head>'
        '<body><a href="page#top">p</a><a href="javascript:void(0)">j</a><a href="tel:800">t</a>'
        '<iframe src="https://frame.example.org/f"></iframe><img src="//img.example.org/a.png">'
        '<a href="https://static.example.ae/doc">same site</a></body></html>',
        URL,
    )
    assert page.links == ["https://portal.example.ae/app/page", "https://static.example.ae/doc"]
    assert page.script_srcs == ["https://portal.example.ae/app/main.js", "https://cdn.other.example/x.js"]
    assert page.iframes == ["https://frame.example.org/f"]
    assert page.external_hosts == ["cdn.other.example", "frame.example.org", "img.example.org"]
    assert page.favicon_url == "https://portal.example.ae/i.png"


def test_embedded_data_blobs_feed_the_text():
    next_data = {"props": {"pageProps": {"title": "Pay your traffic fine today", "id": "a1b2", "url": "/x"}}}
    apollo = json.dumps(json.dumps({"Article:1": {"headline": "مخالفة مرورية غير مدفوعة"}}))
    page = parse_html(
        '<html><head><meta name="description" content="Official looking portal">'
        f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(next_data)}</script>'
        '<script type="application/ld+json">{"@type": "Organization", "name": "Example Authority Portal"}</script>'
        f"<script>window.__APOLLO_STATE__ = JSON.parse({apollo});</script></head><body><div id=root></div></body></html>",
        URL,
    )
    for snippet in ("Pay your traffic fine today", "Example Authority Portal", "مخالفة مرورية غير مدفوعة", "Official looking portal"):
        assert snippet in page.text
    assert "a1b2" not in page.text and page.visible_chars == 0


def test_meta_refresh_and_handlers():
    page = parse_html(
        "<html><head><meta http-equiv=\"Refresh\" content=\"3; URL='/next'\"></head>"
        '<body oncontextmenu="return false"><a href="javascript:go()">x</a></body></html>',
        URL,
    )
    assert page.meta_refresh == (3.0, "https://portal.example.ae/next")
    assert "return false" in page.handler_code and "go()" in page.handler_code


@pytest.mark.parametrize(
    "text, declared, expected",
    [
        ("هذا موقع رسمي لدفع المخالفات المرورية في دولة الإمارات", None, "ar"),
        ("This is the official portal for paying traffic fines", "ar", "en"),
        ("Pay your fine ادفع المخالفة الآن قبل إيقاف الحساب today", None, "mixed"),
        ("Bienvenue sur le portail officiel de paiement des amendes", "fr-FR", "fr"),
        ("ok", "en", "en"),
    ],
)
def test_language_detection(text, declared, expected):
    assert detect_language(text, declared) == expected
