"""Evidence pack: a zip with a bilingual case report, screenshot, raw records, takedown texts and a
SHA-256 chain-of-custody manifest, built from a `Verdict` plus live lookups made at build time."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import zipfile
from dataclasses import dataclass
from datetime import datetime
from importlib import metadata
from pathlib import Path
from typing import Any

from ..schemas import Verdict, utcnow
from . import facts, report, screenshot, takedown
from .reference import case_reference

PDF_NAME = "report.pdf"


def _version(package: str) -> str | None:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:
        return None


def _json(data: Any) -> bytes:
    return json.dumps(data, indent=2, ensure_ascii=False, default=str).encode()


def _headers(verdict: Verdict) -> dict[str, Any]:
    page = verdict.page
    if page is None:
        return {"available": False, "reason": "the engine did not fetch the page for this verdict"}
    return {
        "available": True,
        "url": page.url,
        "final_url": page.final_url,
        "status": page.status,
        "fetched_at": page.fetched_at.isoformat(),
        "headers": page.headers,
        "redirect_chain": [hop.model_dump() for hop in page.redirect_chain],
    }


def _registration_raw(case: report.CaseFile) -> dict[str, Any]:
    reg = case.registration
    return {
        "domain": case.domain,
        "retrieved_at": case.built_at.isoformat(),
        "source": reg.source,
        "error": reg.error,
        "record": reg.raw,
        "networks": [{"ip": n.ip, "error": n.error, "record": n.raw} for n in case.networks],
    }


def _target(verdict: Verdict) -> str:
    url = verdict.url
    return url if "://" in url else f"http://{url}"


def _facts_summary(case: report.CaseFile, manifest: dict[str, Any], views: dict[str, Any]) -> dict[str, Any]:
    """The key facts of the case in one small JSON document, for the dashboard and for triage."""
    v = case.verdict
    d = v.domain
    cert = case.certificate
    shot = case.capture

    def stamp(dt):
        return {"utc": dt.isoformat(), "gst": facts.to_gst(dt).isoformat()} if dt else None

    return {
        "case_ref": case.case_ref,
        "verdict_id": v.id,
        "url": v.url,
        "final_url": v.final_url,
        "host": case.host,
        "registered_domain": case.domain,
        "decision": v.decision.value,
        "risk_score": v.risk_score,
        "brand": v.brand.brand if v.brand else None,
        "brand_ar": v.brand.brand_ar if v.brand else None,
        "official_domains": v.brand.official_domains if v.brand else [],
        "detected_at": stamp(v.created_at),
        "captured_at": stamp(shot.finished_at),
        "built_at": stamp(case.built_at),
        "report_at": stamp(case.built_at),
        "artefacts_from": case.reused_from,
        "screenshots": {
            "live": {"file": "screenshot.png" if shot.png else None, "error": None if shot.png else shot.error,
                     "final_url": shot.final_url, "title": shot.title, "user_agent": shot.user_agent},
            "engine": {"file": "screenshot_engine.png" if shot.engine_png else None,
                       "error": None if shot.engine_png else shot.engine_error},
        },
        "views": views,
        "registration": {
            "registrar": case.registrar,
            "registrar_iana_id": case.registration.registrar_iana_id,
            "created": case.created.isoformat() if case.created else None,
            "age_days": case.age_days,
            "registrant": case.registration.registrant,
            "registrant_country": (d.registrant_country if d else None) or case.registration.registrant_country,
            "nameservers": (d.nameservers if d and d.nameservers else case.registration.nameservers),
            "source": case.registration.source,
        },
        "hosting": {
            "ips": case.ips,
            "asn": d.asn if d else None,
            "network": case.network_owner,
            "country": case.hosting_country,
        },
        "tls": {"issuer": (d.tls_issuer if d else None) or cert.issuer, "not_before": cert.not_before.isoformat() if cert.not_before else None,
                "not_after": cert.not_after.isoformat() if cert.not_after else None, "sha256": cert.sha256},
        "abuse_contacts": {"registrar": case.registrar_abuse, "hosting": case.hosting_abuse},
        "files": manifest["files"],
        "unavailable": manifest["unavailable"],
    }


@dataclass
class Artefacts:
    """What an earlier capture of the same, unchanged page recorded, reused for a report on a newer verdict."""

    capture: screenshot.Capture
    registration: facts.Registration
    networks: list[facts.Network]
    certificate: facts.Certificate
    ips: list[str]
    views: dict[str, Any]
    origin: dict[str, Any]  # case_ref, verdict_id and captured_at of the capture


def _when(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if isinstance(value, str) and value else None


def load_artefacts(folder: Path) -> Artefacts | None:
    """The captured artefacts in an earlier pack's folder, or None if they cannot be read back."""
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
        raw = json.loads((folder / "registration_raw.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    read = lambda name: (folder / name).read_bytes() if (folder / name).is_file() else None  # noqa: E731
    shot, live = manifest.get("screenshot", {}), summary.get("screenshots", {}).get("live", {})
    capture = screenshot.Capture(
        png=read("screenshot.png"), engine_png=read("screenshot_engine.png"),
        dom=(read("rendered_dom.html") or b"").decode("utf-8", "replace") or None,
        final_url=shot.get("final_url"), title=live.get("title"), user_agent=shot.get("user_agent"),
        browser=manifest.get("tool", {}).get("browser"), started_at=_when(shot.get("started_at")),
        finished_at=_when(shot.get("finished_at")), error=shot.get("error"), engine_error=shot.get("engine_view_error"),
    )
    registration, networks = facts.registration_from_raw(raw)
    pem = read("tls_certificate.pem")
    try:
        certificate = facts.certificate_from_pem(pem.decode()) if pem else facts.Certificate(
            error=manifest.get("lookups", {}).get("tls", {}).get("error") or "no certificate")
    except ValueError as exc:
        certificate = facts.Certificate(error=f"recorded certificate unreadable: {exc}")
    origin = manifest.get("artefacts_reused_from") or {
        "case_ref": manifest.get("case_ref"), "verdict_id": manifest.get("verdict_id"),
        "captured_at": shot.get("finished_at") or manifest.get("built_at_utc")}
    return Artefacts(capture, registration, networks, certificate, summary.get("hosting", {}).get("ips") or [],
                     summary.get("views") or {}, origin)


async def build_pack(verdict: Verdict, out_dir: Path, *, extract: bool = False, reuse: Artefacts | None = None) -> Path:
    """Build the evidence zip for `verdict` in `out_dir` and return its path; with `extract`, the files are
    also written unzipped to `out_dir/<case ref>/`. With `reuse`, the screenshots, rendered page and registration
    records of an earlier capture of the same unchanged page are reused, and only the report, summary and
    takedown texts are written afresh from this verdict. Tolerates missing fields and failed lookups: whatever
    could not be gathered is stated in the report and the manifest."""
    case_ref = case_reference(verdict.id)
    host = facts.target_host(verdict)
    domain = facts.registered_domain(verdict, host) if host else ""
    engine_html = verdict.page.html if verdict.page and verdict.page.html else None

    if reuse is not None:
        capture, registration, networks, certificate = reuse.capture, reuse.registration, reuse.networks, reuse.certificate
        ips, views = reuse.ips, reuse.views
    else:
        ips = list(verdict.domain.ips) if verdict.domain and verdict.domain.ips else await facts.resolve(host)
        capture, registration, networks, certificate = await asyncio.gather(
            screenshot.capture(_target(verdict), engine_html),
            facts.registration(domain),
            facts.networks(ips),
            facts.certificate(host),
        )
        views = screenshot.compare_views(capture.text if capture.png else None, capture.title,
                                         verdict.page.text if engine_html else None, verdict.page.title if verdict.page else None)

    built_at = utcnow()  # the report time; the capture time is the screenshot's own
    files: dict[str, bytes] = {}
    unavailable: dict[str, str] = {}
    if capture.png:
        files["screenshot.png"] = capture.png
        files["rendered_dom.html"] = (capture.dom or "").encode()
    else:
        unavailable["screenshot.png"] = capture.error or "not captured"
    if capture.engine_png:
        files["screenshot_engine.png"] = capture.engine_png
    else:
        unavailable["screenshot_engine.png"] = capture.engine_error or "not rendered"
    if engine_html:
        files["capture.html"] = engine_html.encode()
    else:
        unavailable["capture.html"] = "the engine recorded no page HTML for this verdict"
    files["headers.json"] = _json(_headers(verdict))
    files["verdict.json"] = _json(verdict.model_dump(mode="json", exclude={"page": {"html"}}))

    case = report.CaseFile(
        verdict=verdict,
        case_ref=case_ref,
        built_at=built_at,
        host=host,
        domain=domain,
        ips=ips,
        capture=capture,
        registration=registration,
        networks=networks,
        certificate=certificate,
        tool_version=f"Mirsad {_version('scamshield') or 'dev'}",
        views=views,
        reused_from=reuse.origin if reuse else None,
    )
    files["registration_raw.json"] = _json(_registration_raw(case))
    if certificate.pem:
        files["tls_certificate.pem"] = certificate.pem.encode()
    else:
        unavailable["tls_certificate.pem"] = certificate.error or "no certificate"

    later = ["takedown_request.txt", "takedown_request_ar.txt", "report.html", PDF_NAME, "summary.json", "manifest.json"]
    case.attachments = list(files) + later
    pdf_html = report.render_html(case, for_pdf=True)
    try:
        files[PDF_NAME] = await asyncio.to_thread(report.render_pdf, pdf_html)
    except Exception as exc:
        unavailable[PDF_NAME] = f"PDF rendering failed: {type(exc).__name__}: {exc}"
        case.attachments.remove(PDF_NAME)
    files["report.html"] = report.render_html(case, for_pdf=False).encode()
    files["takedown_request.txt"] = takedown.english(case).encode()
    files["takedown_request_ar.txt"] = takedown.arabic(case).encode()

    gst = facts.to_gst(built_at)
    manifest = {
        "case_ref": case_ref,
        "verdict_id": verdict.id,
        "subject_url": verdict.url,
        "built_at_utc": built_at.isoformat(),
        "built_at_gst": gst.isoformat(),
        "sensor_id": os.environ.get("SCAMSHIELD_SENSOR_ID") or "mirsad-gateway-01",
        "tool": {
            "name": "Mirsad",
            "package": "scamshield",
            "version": _version("scamshield"),
            "python": platform.python_version(),
            "weasyprint": _version("weasyprint"),
            "playwright": _version("playwright"),
            "browser": capture.browser,
        },
        "screenshot": {
            "url": _target(verdict),
            "final_url": capture.final_url,
            "user_agent": capture.user_agent,
            "started_at": capture.started_at.isoformat() if capture.started_at else None,
            "finished_at": capture.finished_at.isoformat() if capture.finished_at else None,
            "error": capture.error,
            "engine_view_error": capture.engine_error,
        },
        "views": views,
        "artefacts_reused_from": reuse.origin if reuse else None,
        "lookups": {
            "registration": {"source": registration.source, "error": registration.error},
            "networks": [{"ip": n.ip, "error": n.error} for n in networks],
            "tls": {"error": certificate.error, "sha256": certificate.sha256},
        },
        "files": [
            {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for name, data in files.items()
        ],
        "unavailable": unavailable,
    }
    files["summary.json"] = _json(_facts_summary(case, manifest, views))
    manifest["files"].append({"name": "summary.json", "sha256": hashlib.sha256(files["summary.json"]).hexdigest(),
                              "bytes": len(files["summary.json"])})
    files["manifest.json"] = _json(manifest)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{case_ref}.zip"
    tmp = path.with_suffix(".zip.part")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(f"{case_ref}/{name}", data)
    tmp.replace(path)
    if extract:
        folder = out_dir / case_ref
        folder.mkdir(exist_ok=True)
        for stale in folder.iterdir():
            if stale.is_file() and stale.name not in files:
                stale.unlink()
        for name, data in files.items():
            (folder / name).write_bytes(data)
    return path
