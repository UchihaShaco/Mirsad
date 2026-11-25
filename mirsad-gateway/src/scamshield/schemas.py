"""Shared data contracts. Every component exchanges these types."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import uuid4

from pydantic import BaseModel, Field, field_serializer


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Decision(str, Enum):
    ALLOW = "allow"
    WARN = "warn"
    BLOCK = "block"


class Severity(str, Enum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Stage(str, Enum):
    """Deepest layer that has completed for a verdict."""

    REPUTATION = "reputation"  # allowlist / blocklist / cached verdict, sub-millisecond
    URL = "url"  # URL model + domain intel + look-alike check, no page fetch
    PAGE = "page"  # first page and its immediate redirects analysed
    DEEP = "deep"  # background crawl of further links finished


class Reason(BaseModel):
    """One human-readable finding. `points` is its signed contribution to the risk score."""

    code: str  # stable machine id, e.g. "domain.newly_registered"
    severity: Severity
    points: float = 0.0
    title_en: str
    title_ar: str = ""
    detail: str = ""
    evidence: dict[str, Any] = Field(default_factory=dict)


class RedirectHop(BaseModel):
    url: str
    status: Optional[int] = None
    via: str = "http"  # http | meta | js | shortener
    ip: Optional[str] = None


class FormInfo(BaseModel):
    action: str = ""
    method: str = "get"
    action_host: Optional[str] = None
    external_action: bool = False
    input_types: list[str] = Field(default_factory=list)
    input_names: list[str] = Field(default_factory=list)
    asks_password: bool = False
    asks_card: bool = False
    asks_otp: bool = False
    asks_national_id: bool = False
    asks_phone: bool = False


class ScriptFinding(BaseModel):
    src: Optional[str] = None  # None for inline scripts
    first_party: bool = True
    size: int = 0
    obfuscated: bool = False
    obfuscation_markers: list[str] = Field(default_factory=list)
    endpoints: list[str] = Field(default_factory=list)
    redirects: list[str] = Field(default_factory=list)
    suspicious_calls: list[str] = Field(default_factory=list)


class PageSnapshot(BaseModel):
    """What the engine saw when it fetched one URL as a person's browser would."""

    url: str
    final_url: str
    status: Optional[int] = None
    fetched_at: datetime = Field(default_factory=utcnow)
    redirect_chain: list[RedirectHop] = Field(default_factory=list)
    headers: dict[str, str] = Field(default_factory=dict)
    html: str = ""
    title: str = ""
    text: str = ""  # visible text, whitespace-normalised
    lang: Optional[str] = None
    links: list[str] = Field(default_factory=list)
    forms: list[FormInfo] = Field(default_factory=list)
    scripts: list[ScriptFinding] = Field(default_factory=list)
    external_hosts: list[str] = Field(default_factory=list)
    favicon_hash: Optional[str] = None
    content_hash: Optional[str] = None  # fuzzy hash (hex) robust to timestamps / nonces
    structure_hash: Optional[str] = None  # fuzzy hash of DOM structure only
    kit_hash: Optional[str] = None  # exact hash of form actions, input names and external script hosts
    iframes: list[str] = Field(default_factory=list)  # absolute iframe / frame sources
    needs_js: bool = False  # empty shell whose content could not be recovered statically
    tls_error: Optional[str] = None  # certificate problem a browser would warn about; page fetched anyway
    error: Optional[str] = None
    elapsed_ms: float = 0.0
    timings_ms: dict[str, float] = Field(default_factory=dict)  # wall time per fetch phase


class DomainIntel(BaseModel):
    host: str
    registered_domain: str
    tld: str = ""
    is_ip: bool = False
    is_idn: bool = False
    created: Optional[datetime] = None
    age_days: Optional[int] = None
    registrar: Optional[str] = None
    registrant_country: Optional[str] = None
    nameservers: list[str] = Field(default_factory=list)
    ips: list[str] = Field(default_factory=list)
    asn: Optional[int] = None
    asn_org: Optional[str] = None
    hosting_country: Optional[str] = None
    tls_issuer: Optional[str] = None
    tls_not_before: Optional[datetime] = None
    tls_age_days: Optional[int] = None
    tls_sans: list[str] = Field(default_factory=list)
    popularity_rank: Optional[int] = None  # e.g. Tranco rank, None if unranked
    allowlisted: bool = False  # verified official / trusted domain
    allowlist_owner: Optional[str] = None  # e.g. "Abu Dhabi Police"
    blocklisted: bool = False
    blocklist_sources: list[str] = Field(default_factory=list)
    is_shortener: bool = False
    is_shared_hosting: bool = False  # free hosting / site builder where anyone can publish
    errors: list[str] = Field(default_factory=list)
    elapsed_ms: float = 0.0


class BrandMatch(BaseModel):
    """A suspected impersonation of a known brand by a domain that the brand does not own."""

    brand: str  # e.g. "UAE PASS"
    brand_ar: str = ""
    category: str = ""  # bank | government | telecom | utility | courier | payments | ...
    official_domains: list[str] = Field(default_factory=list)
    technique: str = ""  # typosquat | homoglyph | combosquat | subdomain | content | favicon | ...
    matched_on: list[str] = Field(default_factory=list)  # which signals matched
    score: float = 0.0  # 0..1 confidence that this is impersonation


class ReviewOutcome(str, Enum):
    CONFIRMED = "confirmed"  # the block stands
    OVERTURNED = "overturned"  # false positive: the site is unblocked
    DOWNGRADED = "downgraded"  # not clearly a scam: block becomes a warning
    INCONCLUSIVE = "inconclusive"  # could not decide: the block stands


class ReviewStep(BaseModel):
    """One check the review agent ran while re-validating a block."""

    tool: str
    input: dict[str, Any] = Field(default_factory=dict)
    finding: str = ""
    supports_block: Optional[bool] = None  # None when the step was neutral
    elapsed_ms: float = 0.0


class ReviewResult(BaseModel):
    """Outcome of the heavy second-opinion review that runs after a site is blocked."""

    outcome: ReviewOutcome
    decision: Decision  # the decision the reviewer recommends
    confidence: float = 0.0  # 0..1
    summary_en: str = ""
    summary_ar: str = ""
    steps: list[ReviewStep] = Field(default_factory=list)
    model: str = ""
    started_at: datetime = Field(default_factory=utcnow)
    finished_at: Optional[datetime] = None


class Verdict(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    url: str
    final_url: Optional[str] = None
    host: str = ""
    registered_domain: str = ""
    decision: Decision = Decision.WARN
    risk_score: float = 50.0  # 0 (safe) .. 100 (certain scam)
    stage: Stage = Stage.REPUTATION
    final: bool = False  # True once no further layer is pending
    summary_en: str = ""
    summary_ar: str = ""
    reasons: list[Reason] = Field(default_factory=list)
    url_model_score: Optional[float] = None  # 0..1 probability of scam
    page_model_score: Optional[float] = None
    llm_score: Optional[float] = None
    brand: Optional[BrandMatch] = None
    domain: Optional[DomainIntel] = None
    page: Optional[PageSnapshot] = None
    redirect_chain: list[RedirectHop] = Field(default_factory=list)
    pages_crawled: int = 0
    campaign_id: Optional[str] = None  # cluster of related scam domains, if linked
    review: Optional[ReviewResult] = None  # second-opinion review of a block, once it has run
    source: str = "user"  # who asked for the check: user | gateway | watcher | batch
    evidence_ref: Optional[str] = None  # case reference; set for every warn / block, before the pack exists
    evidence_at: Optional[datetime] = None  # when that evidence was captured
    timings_ms: dict[str, float] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @field_serializer("evidence_ref")
    def _serialize_evidence_ref(self, value: Optional[str]) -> Optional[str]:
        """Every flagged verdict carries its case reference from the moment it is flagged."""
        if value or self.decision == Decision.ALLOW:
            return value
        from .evidence.reference import case_reference

        return case_reference(self.id)
