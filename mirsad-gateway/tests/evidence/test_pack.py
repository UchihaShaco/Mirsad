from __future__ import annotations

import hashlib
import json
import re
import zipfile
import zlib

from scamshield.evidence import facts, takedown
from scamshield.evidence.pack import build_pack
from scamshield.schemas import Verdict

from evidence_samples import RDAP_DOMAIN, RDAP_IP, full_verdict


def _pdf_objects(pdf: bytes):
    yield pdf
    for stream in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        try:
            yield zlib.decompress(stream)
        except zlib.error:
            continue


def _open(path):
    zf = zipfile.ZipFile(path)
    prefix = zf.namelist()[0].split("/")[0]
    return zf, prefix, {n.split("/", 1)[1] for n in zf.namelist()}


async def test_full_pack_contains_every_artifact_with_matching_hashes(tmp_path, offline):
    path = await build_pack(full_verdict(), tmp_path)
    zf, prefix, names = _open(path)
    assert prefix == path.stem
    assert {
        "report.pdf", "report.html", "screenshot.png", "rendered_dom.html", "capture.html", "headers.json",
        "verdict.json", "registration_raw.json", "tls_certificate.pem", "takedown_request.txt",
        "takedown_request_ar.txt", "manifest.json",
    } <= names
    manifest = json.loads(zf.read(f"{prefix}/manifest.json"))
    assert manifest["case_ref"] == prefix
    assert manifest["unavailable"] == {}
    listed = {f["name"] for f in manifest["files"]}
    assert listed == names - {"manifest.json"}
    for entry in manifest["files"]:
        assert hashlib.sha256(zf.read(f"{prefix}/{entry['name']}")).hexdigest() == entry["sha256"]
    verdict = json.loads(zf.read(f"{prefix}/verdict.json"))
    assert "html" not in verdict["page"]


async def test_report_is_bilingual_defanged_and_embeds_arabic_font(tmp_path, offline):
    path = await build_pack(full_verdict(), tmp_path)
    zf, prefix, _ = _open(path)
    html = zf.read(f"{prefix}/report.html").decode()
    assert "hxxps://examp1e-bank-verify[.]com/login" in html
    assert "https://examp1e-bank-verify.com" not in html
    assert 'dir="rtl"' in html and "ملخص القضية" in html
    assert "GST (UTC+4)" in html and "2026-11-24 21:05:00" in html
    assert "Independent re-validation" in html and "rdap_lookup" in html
    assert "Example Registrar LLC (IANA ID 9999)" in html and "abuse@hosting.example" in html
    assert "Reporting channels" in html and "aman@adpolice.gov.ae" in html
    pdf = zf.read(f"{prefix}/report.pdf")
    assert pdf.startswith(b"%PDF")
    assert any(b"Noto-Sans-Arabic" in chunk for chunk in _pdf_objects(pdf))


async def test_minimal_verdict_with_every_lookup_failing_still_builds(tmp_path, offline):
    offline["screenshot"] = False
    offline["lookups"] = False
    path = await build_pack(Verdict(url="http://unreachable.invalid/pay"), tmp_path)
    zf, prefix, names = _open(path)
    assert "screenshot.png" not in names and "capture.html" not in names
    manifest = json.loads(zf.read(f"{prefix}/manifest.json"))
    assert "ERR_NAME_NOT_RESOLVED" in manifest["unavailable"]["screenshot.png"]
    html = zf.read(f"{prefix}/report.html").decode()
    assert "Screenshot could not be captured" in html
    assert "screenshot.png" not in html.split("Attached evidence")[1]
    assert "NetBeacon" in zf.read(f"{prefix}/takedown_request.txt").decode()
    assert json.loads(zf.read(f"{prefix}/headers.json")) == {
        "available": False, "reason": "the engine did not fetch the page for this verdict",
    }


def test_defang():
    assert facts.defang("https://a.example.com/x.php?q=1.2") == "hxxps://a[.]example[.]com/x.php?q=1.2"
    assert facts.defang("http://10.0.0.1:8080/") == "hxxp://10[.]0[.]0[.]1:8080/"
    assert facts.defang("example.com/path") == "example[.]com/path"
    assert facts.defang(None) == ""


def test_parse_rdap_records():
    reg = facts.parse_rdap_domain(RDAP_DOMAIN)
    assert reg.registrar == "Example Registrar LLC"
    assert reg.registrar_iana_id == "9999"
    assert reg.registrar_abuse_emails == ["abuse@registrar.example"]
    assert reg.created.isoformat() == "2026-11-21T09:12:00+00:00"
    assert reg.registrant_country == "IS"
    assert reg.nameservers == ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
    net = facts.parse_rdap_ip("203.0.113.10", RDAP_IP)
    assert (net.name, net.country, net.abuse_emails) == ("EXAMPLE-HOSTING-NET", "NL", ["abuse@hosting.example"])


def test_parse_ae_whois():
    text = "Domain Name: x.ae\nRegistrar Name:   Example Registrar\nStatus: ok\nName Server: NS1.EXAMPLE.AE\n"
    reg = facts.parse_whois_text(text, "whois.aeda.net.ae")
    assert reg.registrar == "Example Registrar"
    assert reg.nameservers == ["ns1.example.ae"]
    assert reg.raw["text"] == text


async def test_takedown_texts_address_the_right_desks(tmp_path, offline):
    path = await build_pack(full_verdict(), tmp_path)
    zf, prefix, _ = _open(path)
    en = zf.read(f"{prefix}/takedown_request.txt").decode()
    assert "abuse@registrar.example" in en and "abuse@hosting.example" in en
    assert "Cloudflare" in en and "IANA ID 9999" in en
    assert "Phishing" in en and "2026-11-24 17:05:00 UTC" in en
    ar = zf.read(f"{prefix}/takedown_request_ar.txt").decode()
    assert "8002626" in ar and "aman@adpolice.gov.ae" in ar and "ecrime.ae" in ar and "aeCERT" in ar
    assert "بنك المثال" in ar
    assert takedown.REPORTER_AR in ar


async def test_extracted_pack_has_both_views_and_a_summary(tmp_path, offline):
    path = await build_pack(full_verdict(), tmp_path, extract=True)
    folder = tmp_path / path.stem
    assert (folder / "screenshot.png").is_file() and (folder / "screenshot_engine.png").is_file()
    summary = json.loads((folder / "summary.json").read_text())
    assert summary["case_ref"] == path.stem
    assert summary["captured_at"]["gst"].endswith("+04:00")
    assert summary["abuse_contacts"] == {"registrar": ["abuse@registrar.example"], "hosting": ["abuse@hosting.example"]}
    assert summary["views"]["differs"] is False
    manifest = json.loads((folder / "manifest.json").read_text())
    assert {"summary.json", "screenshot_engine.png"} <= {f["name"] for f in manifest["files"]}
    html = (folder / "report.html").read_text()
    assert "Live capture" in html and "As seen by the engine" in html and "match" in html


async def test_report_flags_cloaking_when_live_page_differs(tmp_path, offline):
    offline["live_text"] = "Garden notes: five herbs that love the winter sun, composting in small spaces, watering early in the morning and keeping the soil loose"
    path = await build_pack(full_verdict(), tmp_path, extract=True)
    summary = json.loads((tmp_path / path.stem / "summary.json").read_text())
    assert summary["views"]["differs"] is True
    assert "differs materially" in (tmp_path / path.stem / "report.html").read_text()


def test_view_comparison_needs_enough_text_on_both_sides():
    from scamshield.evidence.screenshot import compare_views

    assert compare_views("Parked domain", "x", "Domain for sale", "y")["compared"] is False
    same = "one two three four five six seven eight nine ten eleven twelve thirteen"
    result = compare_views(same, "t", same, "t")
    assert result["compared"] is True and result["differs"] is False and result["similarity"] == 1.0


def test_pdf_renderer_loads_nothing_from_the_network_or_outside_the_package(tmp_path):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from scamshield.evidence.report import render_pdf

    hits = []

    class Canary(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            hits.append(self.path)
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Canary)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    secret = tmp_path / "secret.png"
    secret.write_bytes(b"not for the report")
    base = f"http://127.0.0.1:{server.server_port}"
    html = (f'<html><head><link rel="stylesheet" href="{base}/x.css"><style>@import url("{base}/i.css");'
            f'body {{ background: url("{base}/bg.png") }}</style></head><body><img src="{base}/img.png">'
            f'<img src="{secret.as_uri()}"><img src="file:///etc/passwd"><p>report</p></body></html>')
    try:
        pdf = render_pdf(html)
    finally:
        server.shutdown()
    assert pdf.startswith(b"%PDF") and hits == []


async def test_case_reference_is_the_same_everywhere(tmp_path, offline):
    from scamshield.evidence.reference import case_reference

    verdict = full_verdict()
    path = await build_pack(verdict, tmp_path, extract=True)
    ref = case_reference(verdict.id)
    assert ref == "SS-0F3C9A1B" and path.name == f"{ref}.zip"
    assert json.loads(verdict.model_dump_json())["evidence_ref"] == ref
    assert ref in (tmp_path / ref / "report.html").read_text()
    assert json.loads((tmp_path / ref / "summary.json").read_text())["case_ref"] == ref


async def test_newer_verdict_gets_its_own_report_but_reuses_the_capture(tmp_path, offline):
    from scamshield.evidence.pack import load_artefacts
    from scamshield.schemas import BrandMatch

    first = full_verdict()
    first.brand = None
    old = await build_pack(first, tmp_path, extract=True)
    offline["screenshot"] = False  # a second capture would fail: the reuse must not need one
    newer = full_verdict()
    newer.id = "989ee731cba140e986e6b35b6ff1ee1c"
    newer.brand = BrandMatch(brand="Example Police", brand_ar="شرطة المثال", official_domains=["police.example"])
    path = await build_pack(newer, tmp_path, extract=True, reuse=load_artefacts(tmp_path / old.stem))
    folder = tmp_path / path.stem
    summary = json.loads((folder / "summary.json").read_text())
    assert path.stem == "SS-989EE731" and summary["verdict_id"] == newer.id and summary["brand"] == "Example Police"
    assert summary["artefacts_from"]["case_ref"] == old.stem
    assert (folder / "screenshot.png").read_bytes() == (tmp_path / old.stem / "screenshot.png").read_bytes()
    assert summary["captured_at"]["utc"] != summary["report_at"]["utc"]
    assert json.loads((folder / "verdict.json").read_text())["id"] == newer.id
    assert "has not changed since case SS-0F3C9A1B" in (folder / "report.html").read_text()


async def test_private_addresses_get_no_placeholder_abuse_contact(tmp_path, offline, monkeypatch):
    from scamshield.evidence import facts as facts_module

    async def networks(ips):
        return [facts_module.parse_rdap_ip(ip, {"name": "PRIVATE-ADDRESS-BBLK-RFC1918-IANA-RESERVED", "entities": [
            {"roles": ["abuse"], "vcardArray": ["vcard", [["email", {}, "text", "abuse@iana.org"]]]}]}) for ip in ips]

    async def registration(domain):
        return facts_module.Registration(error="RDAP: not found")

    monkeypatch.setattr(facts_module, "networks", networks)
    monkeypatch.setattr(facts_module, "registration", registration)
    verdict = full_verdict()
    verdict.domain.ips = ["172.30.77.10"]
    verdict.domain.asn_org = None
    path = await build_pack(verdict, tmp_path, extract=True)
    folder = tmp_path / path.stem
    letter = (folder / "takedown_request.txt").read_text()
    assert "iana.org" not in letter and "No abuse contact was published" in letter
    assert "hosting provider unknown" in letter
    assert json.loads((folder / "summary.json").read_text())["abuse_contacts"]["hosting"] == []
