"""Bilingual (English / Arabic) police case report, rendered to HTML and PDF from one template."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..schemas import Verdict
from . import labels
from .channels import UAE_CHANNELS
from .facts import Certificate, Network, Registration, defang, is_placeholder_network, is_public_ip, to_gst, usable_abuse
from .screenshot import Capture

HERE = Path(__file__).resolve().parent
FONT_DIR = HERE / "fonts"
FONT_FACES = [
    ("Noto Sans", "NotoSans-Regular.ttf", 400),
    ("Noto Sans", "NotoSans-Bold.ttf", 700),
    ("Noto Sans Arabic", "NotoSansArabic-Regular.ttf", 400),
    ("Noto Sans Arabic", "NotoSansArabic-Bold.ttf", 700),
    ("Noto Sans Mono", "NotoSansMono-Regular.ttf", 400),
]

_env = Environment(
    loader=FileSystemLoader(HERE / "templates"),
    autoescape=select_autoescape(["html", "j2"]),
    trim_blocks=True,
    lstrip_blocks=True,
)


@dataclass
class CaseFile:
    """Everything the report and takedown texts are written from."""

    verdict: Verdict
    case_ref: str
    built_at: datetime
    host: str
    domain: str
    ips: list[str]
    capture: Capture
    registration: Registration
    networks: list[Network]
    certificate: Certificate
    tool_version: str
    views: dict[str, Any] = field(default_factory=dict)  # live capture vs engine view comparison
    reused_from: dict[str, Any] | None = None  # earlier capture whose artefacts this report reuses
    attachments: list[str] = field(default_factory=list)

    @property
    def registrar_abuse(self) -> list[str]:
        return usable_abuse(self.registration.registrar_abuse_emails)

    @property
    def public_networks(self) -> list[Network]:
        return [n for n in self.networks if not is_placeholder_network(n)]

    @property
    def hosting_private(self) -> bool:
        """The site resolves only to private or reserved addresses: no hosting provider can be named."""
        return bool(self.ips) and not any(is_public_ip(ip) for ip in self.ips)

    @property
    def hosting_abuse(self) -> list[str]:
        emails: list[str] = []
        for net in self.public_networks:
            emails += [e for e in usable_abuse(net.abuse_emails) if e not in emails]
        return emails

    @property
    def registrar(self) -> str | None:
        d = self.verdict.domain
        return (d.registrar if d else None) or self.registration.registrar

    @property
    def created(self) -> datetime | None:
        d = self.verdict.domain
        return (d.created if d else None) or self.registration.created

    @property
    def age_days(self) -> int | None:
        d = self.verdict.domain
        if d and d.age_days is not None:
            return d.age_days
        return (self.built_at - self.created).days if self.created else None

    @property
    def network_owner(self) -> str | None:
        d = self.verdict.domain
        if d and d.asn_org:
            return d.asn_org
        if self.hosting_private:
            return labels.PRIVATE_HOSTING[0]
        return next((n.name for n in self.public_networks if n.name), None)

    @property
    def hosting_country(self) -> str | None:
        d = self.verdict.domain
        return (d.hosting_country if d else None) or next((n.country for n in self.public_networks if n.country), None)


def fmt_dt(dt: datetime | None) -> dict[str, str] | None:
    if dt is None:
        return None
    gst = to_gst(dt)
    utc = gst.astimezone(timezone.utc)
    return {"utc": utc.strftime("%Y-%m-%d %H:%M:%S UTC"), "gst": gst.strftime("%Y-%m-%d %H:%M:%S GST (UTC+4)")}


def _pct(value: float | None) -> str | None:
    return None if value is None else f"{value * 100:.0f}%"


def _row(key: str, value: Any, *, mono: bool = False) -> dict[str, Any] | None:
    if value is None or value == "" or value == []:
        return None
    en, ar = labels.FIELD[key]
    return {"en": en, "ar": ar, "value": value, "mono": mono}


def _rows(*rows: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [r for r in rows if r]


def _days(n: int | None) -> str | None:
    if n is None:
        return None
    return f"{n} day{'s' if n != 1 else ''} / {n} يوم"


def context(case: CaseFile) -> dict[str, Any]:
    v = case.verdict
    d = v.domain
    page = v.page
    cert = case.certificate
    decision_en, decision_ar = labels.DECISION[v.decision.value]
    stage_en, stage_ar = labels.STAGE[v.stage.value]

    max_points = max((abs(r.points) for r in v.reasons), default=0) or 1
    reasons = [
        {
            "severity": r.severity.value,
            "severity_en": labels.SEVERITY[r.severity.value][0],
            "severity_ar": labels.SEVERITY[r.severity.value][1],
            "points": r.points,
            "bar": round(abs(r.points) / max_points * 100),
            "title_en": r.title_en,
            "title_ar": r.title_ar,
            "detail": r.detail,
            "code": r.code,
        }
        for r in sorted(v.reasons, key=lambda r: -r.points)
    ]

    chain = v.redirect_chain or (page.redirect_chain if page else [])
    redirects = [{"url": defang(h.url), "status": h.status, "via": h.via, "ip": h.ip} for h in chain]

    times = _rows(
        _row("first_seen", fmt_dt(v.created_at)),
        _row("page_fetched", fmt_dt(page.fetched_at) if page else None),
        _row("last_update", fmt_dt(v.updated_at)),
        _row("screenshot_at", fmt_dt(case.capture.finished_at) if case.capture.png else None),
        _row("pack_built", fmt_dt(case.built_at)),
    )

    asks = []
    for form in page.forms if page else []:
        for attr, names in labels.ASKS.items():
            if getattr(form, attr) and names not in asks:
                asks.append(names)

    registration = _rows(
        _row("registrar", (case.registrar or "") + (f" (IANA ID {case.registration.registrar_iana_id})" if case.registration.registrar_iana_id else "") or None),
        _row("registrant", case.registration.registrant),
        _row("created", fmt_dt(case.created)),
        _row("age", _days(case.age_days)),
        _row("expires", fmt_dt(case.registration.expires)),
        _row("registrant_country", (d.registrant_country if d else None) or case.registration.registrant_country),
        _row("nameservers", ", ".join((d.nameservers if d and d.nameservers else case.registration.nameservers)), mono=True),
        _row("registrar_abuse", ", ".join(case.registrar_abuse), mono=True),
    )
    asn = f"AS{d.asn}" if d and d.asn else None
    hosting = _rows(
        _row("ips", ", ".join(case.ips), mono=True),
        _row("asn", asn, mono=True),
        _row("network", case.network_owner),
        _row("hosting_country", case.hosting_country),
        _row("hosting_abuse", ", ".join(case.hosting_abuse), mono=True),
    )
    not_before = (d.tls_not_before if d else None) or cert.not_before
    tls_age = d.tls_age_days if d and d.tls_age_days is not None else (
        (case.built_at - not_before).days if not_before else None
    )
    valid = None
    if not_before:
        valid = f"{not_before:%Y-%m-%d}" + (f" → {cert.not_after:%Y-%m-%d}" if cert.not_after else "")
    tls = _rows(
        _row("tls_issuer", (d.tls_issuer if d else None) or cert.issuer),
        _row("tls_subject", cert.subject),
        _row("tls_valid", valid, mono=True),
        _row("tls_age", _days(tls_age)),
        _row("tls_sans", ", ".join(((d.tls_sans if d and d.tls_sans else cert.sans))[:12]), mono=True),
        _row("tls_sha256", cert.sha256, mono=True),
    )
    models = _rows(
        _row("url_model", _pct(v.url_model_score)),
        _row("page_model", _pct(v.page_model_score)),
        _row("llm", _pct(v.llm_score)),
        _row("pages_crawled", v.pages_crawled or None),
        _row("campaign", v.campaign_id, mono=True),
    )
    brand = None
    if v.brand:
        brand = {
            "name": v.brand.brand,
            "name_ar": v.brand.brand_ar,
            "category": v.brand.category,
            "rows": _rows(
                _row("official_domains", ", ".join(v.brand.official_domains), mono=True),
                _row("technique", v.brand.technique),
                _row("matched_on", ", ".join(v.brand.matched_on)),
                _row("confidence", _pct(v.brand.score)),
            ),
        }

    review = None
    if v.review:
        r = v.review
        outcome_en, outcome_ar = labels.REVIEW_OUTCOME[r.outcome.value]
        review = {
            "outcome": r.outcome.value,
            "outcome_en": outcome_en,
            "outcome_ar": outcome_ar,
            "summary_en": r.summary_en,
            "summary_ar": r.summary_ar,
            "headline_ar": next((x.title_ar for x in v.reasons if x.code.startswith("review.") and x.title_ar), None),
            "rows": _rows(
                _row("recommended", " / ".join(labels.DECISION[r.decision.value])),
                _row("confidence", _pct(r.confidence)),
                _row("reviewer", r.model),
                _row("review_started", fmt_dt(r.started_at)),
                _row("review_finished", fmt_dt(r.finished_at)),
            ),
            "steps": [
                {
                    "n": i + 1,
                    "tool": s.tool,
                    "input": ", ".join(f"{k}={defang(str(val)) if 'url' in k else val}" for k, val in s.input.items()),
                    "finding": s.finding,
                    "supports": s.supports_block,
                    "ms": round(s.elapsed_ms),
                }
                for i, s in enumerate(r.steps)
            ],
        }

    shot = case.capture
    return {
        "case_ref": case.case_ref,
        "verdict_id": v.id,
        "built": fmt_dt(case.built_at),
        "tool_version": case.tool_version,
        "url": defang(v.url),
        "final_url": defang(v.final_url or (page.final_url if page else None)),
        "host": defang(case.host),
        "decision": v.decision.value,
        "decision_en": decision_en,
        "decision_ar": decision_ar,
        "risk": round(v.risk_score),
        "stage_en": stage_en,
        "stage_ar": stage_ar,
        "summary_en": v.summary_en,
        "summary_ar": v.summary_ar,
        "times": times,
        "reasons": reasons,
        "redirects": redirects,
        "page_rows": _rows(
            _row("page_title", page.title if page else None),
            _row("http_status", page.status if page else None),
            _row("forms", " · ".join(f"{en} / {ar}" for en, ar in asks) or None),
        ),
        "brand": brand,
        "registration": registration,
        "registration_error": case.registration.error if not registration else None,
        "hosting": hosting,
        "tls": tls,
        "tls_error": cert.error if not tls else None,
        "models": models,
        "review": review,
        "reused": {"case_ref": case.reused_from.get("case_ref"), "captured": fmt_dt(datetime.fromisoformat(case.reused_from["captured_at"]))
                   if case.reused_from.get("captured_at") else None} if case.reused_from else None,
        "screenshot": base64.b64encode(shot.png).decode() if shot.png else None,
        "screenshot_engine": base64.b64encode(shot.engine_png).decode() if shot.engine_png else None,
        "engine_error": shot.engine_error if not shot.engine_png else None,
        "views": case.views,
        "screenshot_error": shot.error if not shot.png else None,
        "screenshot_url": defang(shot.final_url),
        "browser": shot.browser,
        "channels": UAE_CHANNELS,
        "glossary": labels.GLOSSARY,
        "attachments": [{"name": n, "en": labels.FILES[n][0], "ar": labels.FILES[n][1]} for n in case.attachments],
    }


def _font_css() -> str:
    faces = []
    for family, file, weight in FONT_FACES:
        uri = (FONT_DIR / file).as_uri()
        faces.append(f'@font-face {{ font-family: "{family}"; src: url("{uri}"); font-weight: {weight}; }}')
    return "\n".join(faces)


def render_html(case: CaseFile, *, for_pdf: bool) -> str:
    ctx = context(case)
    ctx["font_css"] = _font_css() if for_pdf else ""
    ctx["for_pdf"] = for_pdf
    return _env.get_template("report.html.j2").render(**ctx)


def render_pdf(html: str) -> bytes:
    """The PDF of our own template. Only embedded data and this package's fonts may be loaded: a hostile string
    that slipped past escaping still could not make the renderer fetch a URL or read a local file."""
    from weasyprint import HTML
    from weasyprint.urls import URLFetcher, URLFetchingError

    class LocalOnly(URLFetcher):
        def fetch(self, url, headers=None):
            if url.startswith("file:") and not Path(unquote(urlsplit(url).path)).resolve().is_relative_to(HERE):
                raise URLFetchingError(f"refused: {url[:100]}")
            return super().fetch(url, headers)

    fetcher = LocalOnly(allowed_protocols={"file", "data"}, allow_redirects=False)
    return HTML(string=html, base_url=str(HERE), url_fetcher=fetcher).write_pdf()
