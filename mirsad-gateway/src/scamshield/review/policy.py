"""Evidence-based, asymmetric decision policy of the second-opinion review.

The review tests each accusation of the blocked verdict (`Claim`) against facts that tools gathered,
scores positive evidence of legitimacy, and decides:

* **confirmed** when an accusation is upheld by the facts (impersonation of a brand the site presents
  itself as, sensitive data sent to an unrecognised host, a young domain posing as someone else,
  cloaking, scam reports) or the page tries to manipulate the reviewer;
* **overturned** (allow) when every accusation fell and independent records outweigh the flags:
  at least `overturn.min_points` of evidence, `overturn.min_external_points` of it from records the
  site cannot write itself (ownership registries, registration / certificate / archive history,
  the public top-sites list);
* **downgraded** (warn) with less evidence (`downgrade`), or a blocklisted site with very strong
  evidence of a long-established genuine business (most likely a past compromise);
* **inconclusive** (block stands) otherwise. Absence of bad evidence is never enough to unblock.

Page-derived evidence (identity matching the domain, a coherent multi-page site, local contact
details, an ordinary CMS) is capped, so a copied site cannot clear itself; all weights and thresholds
live in `data/policy.json`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from scamshield.schemas import Decision, ReviewOutcome, Verdict

from .evidence import Claim, distinctive

POLICY_PATH = Path(os.environ.get("SCAMSHIELD_REVIEW_POLICY", Path(__file__).resolve().parent / "data" / "policy.json"))

# Accusations that keep a block while they stand; the rest (model scores, TLD, hosting type) are soft.
# Claims that are weak on their own; every other claim must be refuted before a block is lifted.
SOFT_KINDS = {"model", "obfuscation", "redirect"}
REGISTRATION_SOURCES = {"registration record", "domain record"}
BENIGN_TARGETS = {"own site", "known form / payment service", "popular provider", "the site's account on a provider"}


@lru_cache(maxsize=4)
def load_policy(path: Path = POLICY_PATH) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


@dataclass
class Signals:
    """Facts that tools established. Page text is never evidence about the page itself."""

    history: dict[str, int] = field(default_factory=dict)  # source -> days of recorded history of this site
    parent_history: dict[str, int] = field(default_factory=dict)  # same, for the platform / parent domain
    rank: Optional[int] = None  # public top-sites rank of the site's own registered domain
    shared_platform: bool = False  # the site is a subdomain on a platform where anyone can publish
    brand_owns_domain: Optional[str] = None  # registry brand that lists this domain as official
    allowlisted_owner: Optional[str] = None
    owner_sources: dict[str, str] = field(default_factory=dict)  # editable public source kind -> what it says
    official_elsewhere: list[str] = field(default_factory=list)  # claimed brand's real domains, not this one
    site_names: list[str] = field(default_factory=list)  # names the site gives itself
    identity_name: Optional[str] = None  # the site name that its own domain spells out
    brand_in_identity: Optional[str] = None  # the claimed brand appears in the site's name or host
    identity_brand: Optional[str] = None  # a registry brand the site names itself after, on a domain it does not own
    identity_brand_ar: str = ""
    coherent_site: Optional[bool] = None
    local_contact: list[str] = field(default_factory=list)
    platform: Optional[str] = None
    search_corroborated: list[str] = field(default_factory=list)
    blocklisted: list[str] = field(default_factory=list)
    injection: list[str] = field(default_factory=list)
    cloaking: Optional[bool] = None  # None until a cloaking check ran
    scam_reports: list[str] = field(default_factory=list)
    form_targets: dict[str, str] = field(default_factory=dict)  # host -> what it is (see BENIGN_TARGETS)
    sensitive_form: bool = False
    page_reachable: Optional[bool] = None
    content_checked: bool = False  # the address was re-fetched and its content (or destination) examined
    harmful_now: list[str] = field(default_factory=list)  # gambling / adult / pill content or destination, reproduced
    unrelated_now: Optional[str] = None  # the unrelated site the address forwards to now

    @property
    def history_days(self) -> Optional[int]:
        """Longest recorded history, but never longer than the current registration: archive captures and
        certificates from before a domain was dropped and re-registered belong to the previous owner."""
        if not self.history:
            return None
        registered = [d for k, d in self.history.items() if k in REGISTRATION_SOURCES]
        longest = max(self.history.values())
        return min(longest, min(registered)) if registered else longest

    @property
    def history_source(self) -> str:
        days = self.history_days
        return next((k for k, d in self.history.items() if d == days), "") if self.history else ""

    @property
    def young(self) -> bool:
        days = self.history_days
        return days is not None and days < load_policy()["history"]["young_days"]

    @property
    def ownership(self) -> list[str]:
        """Who runs the site, from sources that count as proof.

        The curated brand registry and allowlist count alone. Wikidata and the DuckDuckGo panel can be
        edited by anyone, so they count only when two kinds agree (the top-sites list may be the
        second), or when the Wikidata item is well established (has Wikipedia articles).
        """
        out = []
        if self.brand_owns_domain:
            out.append(f"brand registry: official domain of {self.brand_owns_domain}")
        if self.allowlisted_owner:
            out.append(f"allowlist: {self.allowlisted_owner}")
        kinds = {kind.split("_")[0] for kind in self.owner_sources}
        if self.rank is not None and not self.shared_platform:
            kinds.add("top_sites")
        if "wikidata_linked" in self.owner_sources or (self.owner_sources and len(kinds) >= 2):
            out += list(self.owner_sources.values())
        return out

    @property
    def unknown_targets(self) -> list[str]:
        return sorted(h for h, kind in self.form_targets.items() if kind not in BENIGN_TARGETS)

    @property
    def identity_mismatch(self) -> bool:
        """The site gives itself a business name that its domain does not spell out."""
        return self.identity_name is None and any(distinctive(n) for n in self.site_names)


def test_claims(claims: list[Claim], signals: Signals, verdict: Verdict) -> None:
    """Settle each accusation from the facts: upheld, refuted, or left untested."""
    brand = verdict.brand.brand if verdict.brand else ""
    impersonation_refuted = False
    for claim in claims:
        status, finding = "untested", ""
        if claim.kind == "young_domain" and signals.history_days is not None:
            if signals.young:
                status, finding = "upheld", f"records go back only {signals.history_days} days"
            elif signals.history_days >= 365:
                status, finding = "refuted", f"records go back {signals.history_days} days ({signals.history_source})"
        elif claim.kind == "impersonation":
            if signals.ownership:
                status, finding = "refuted", f"the host belongs to the organisation ({signals.ownership[0]})"
            elif signals.brand_in_identity:
                status, finding = "upheld", (f"the site presents itself as {signals.brand_in_identity} on a domain "
                                             f"{brand or 'the brand'} does not own")
            elif signals.identity_name:
                status, finding = "refuted", (f"the site presents itself as {signals.identity_name!r}, which its own "
                                              f"domain spells out; {brand or 'the brand'} is only mentioned or linked")
            elif signals.site_names and not signals.identity_brand:
                status, finding = "refuted", (f"the site does not present itself as {brand or 'the brand'} in its name "
                                              "or address; the brand is only mentioned or linked")
            impersonation_refuted = status == "refuted"
        elif claim.kind == "helpline":
            if impersonation_refuted or signals.ownership:
                status, finding = "refuted", "the numbers are the business's own contact numbers, not a brand helpline"
            elif signals.brand_in_identity:
                status, finding = "upheld", f"the page gives its own numbers while posing as {brand}"
        elif claim.kind == "credential_form":
            unknown = signals.unknown_targets
            if unknown:
                status, finding = "upheld", f"sensitive data goes to {', '.join(unknown)}, which is not a recognised service"
            elif signals.form_targets:
                described = "; ".join(f"{h} ({kind})" for h, kind in sorted(signals.form_targets.items()))
                status, finding = "refuted", f"forms post to {described}"
            elif signals.page_reachable:
                status, finding = "refuted", "the forms post to the site itself"
        elif claim.kind == "cloaking" and signals.cloaking is not None:
            status, finding = ("upheld", "crawler and browser get different content") if signals.cloaking else (
                "refuted", "crawler and browser get the same site")
        elif claim.kind == "blocklist" and signals.blocklisted:
            status, finding = "upheld", f"listed on {', '.join(signals.blocklisted)}"
        elif claim.kind == "harmful_content" and signals.content_checked:
            status, finding = ("upheld", "re-fetched: " + "; ".join(signals.harmful_now)) if signals.harmful_now else (
                "refuted", "re-fetched: the address serves no gambling, adult or pill content and sends visitors to none")
        elif claim.kind == "unrelated_redirect" and signals.content_checked:
            status, finding = (("upheld", f"re-fetched: it still forwards visitors to an unrelated site "
                                          f"({signals.unrelated_now})") if signals.unrelated_now else
                               ("refuted", "re-fetched: it no longer forwards visitors to an unrelated site"))
        claim.status, claim.finding = status, finding


@dataclass
class Evidence:
    external: float
    page: float
    items: list[str]

    @property
    def total(self) -> float:
        return self.external + self.page


def legitimacy(signals: Signals) -> Evidence:
    """Positive evidence, weighted by `data/policy.json`."""
    policy = load_policy()
    points = policy["points"]
    external, page, items = 0.0, 0.0, []
    if signals.ownership:
        external += points["ownership"]
        items.append(signals.ownership[0])
    days = signals.history_days
    if days is not None:
        for threshold, value in policy["history"]["steps"]:
            if days >= threshold:
                external += value
                items.append(f"{days} days of recorded history ({signals.history_source})")
                break
    if signals.rank is not None and not signals.shared_platform and signals.rank <= policy["top_sites_max_rank"]:
        external += points["top_sites"]
        items.append(f"in the public top-sites list (rank {signals.rank:,})")
    if signals.identity_name and not signals.brand_in_identity and not signals.identity_brand:
        page += points["identity_matches_domain"]
        items.append(f"its name {signals.identity_name!r} matches its domain")
    if signals.coherent_site:
        page += points["coherent_site"]
        items.append("further pages agree on one business")
    if signals.local_contact:
        page += points["local_contact"]
        items.append("UAE contact numbers")
    if signals.platform:
        page += points["site_platform"]
        items.append(f"built with {signals.platform}")
    return Evidence(external, min(page, policy["page_points_cap"]), items)


def hard_evidence(signals: Signals, claims: list[Claim]) -> list[str]:
    """Findings that keep a block regardless of positive evidence."""
    out = []
    if signals.injection:
        out.append("the page contains text aimed at manipulating an automated reviewer")
    if signals.scam_reports:
        out.append("independent scam reports name this domain")
    if signals.cloaking and not signals.ownership:
        out.append("serves different content to crawlers and to people")
    if signals.identity_brand and not signals.ownership:
        out.append(f"calls itself {signals.identity_brand} on a domain that brand does not own")
    for claim in claims:
        if claim.status == "upheld" and claim.kind in ("impersonation", "helpline", "credential_form", "harmful_content",
                                                       "unrelated_redirect"):
            out.append(claim.finding)
    if signals.young and (signals.sensitive_form or signals.identity_mismatch
                          or any(c.kind == "impersonation" and c.status != "refuted" for c in claims)):
        out.append(f"the domain is only {signals.history_days} days old and poses as someone else or collects "
                   "sensitive data")
    return list(dict.fromkeys(out))


@dataclass
class Decided:
    outcome: ReviewOutcome
    confidence: float
    basis: list[str]


DECISIONS = {
    ReviewOutcome.CONFIRMED: Decision.BLOCK,
    ReviewOutcome.INCONCLUSIVE: Decision.BLOCK,
    ReviewOutcome.OVERTURNED: Decision.ALLOW,
    ReviewOutcome.DOWNGRADED: Decision.WARN,
}


def decide(signals: Signals, verdict: Verdict, claims: list[Claim]) -> Decided:
    """The rule outcome. The fallback uses it as is; an LLM judge may only make it more cautious."""
    policy = load_policy()
    hard = hard_evidence(signals, claims)
    if hard:
        return Decided(ReviewOutcome.CONFIRMED, min(0.95, 0.75 + 0.07 * len(hard)), hard)
    evidence = legitimacy(signals)
    if signals.blocklisted:
        listed = f"listed on {', '.join(signals.blocklisted)}"
        rule = policy["blocklisted"]
        if evidence.total >= rule["downgrade_min_points"] and evidence.external >= rule["downgrade_min_external_points"]:
            return Decided(ReviewOutcome.DOWNGRADED, 0.6,
                           [f"{listed}, but a long-established genuine business: likely a past compromise",
                            *evidence.items])
        return Decided(ReviewOutcome.CONFIRMED, 0.8, [listed])
    soft_codes = tuple(policy["soft_reason_prefixes"])
    standing = [c for c in claims if c.status != "refuted" and c.kind not in SOFT_KINDS
                and not (c.kind == "other" and c.code.startswith(soft_codes))]
    if standing:
        # An accusation nobody could test or refute is not cleared: history and identity cannot outweigh what the
        # site may be doing now.
        return Decided(ReviewOutcome.INCONCLUSIVE, 0.5,
                       ["accusations not refuted: " + "; ".join(f"{c.kind} ({c.code or c.text[:60]})" for c in standing),
                        *evidence.items])
    for outcome, rule, confidence in ((ReviewOutcome.OVERTURNED, policy["overturn"], 0.85),
                                      (ReviewOutcome.DOWNGRADED, policy["downgrade"], 0.65)):
        if evidence.total >= rule["min_points"] and evidence.external >= rule["min_external_points"]:
            return Decided(outcome, min(0.95, confidence + 0.02 * (evidence.total - rule["min_points"])),
                           evidence.items)
    benign = policy["benign_downgrade"]
    if (not signals.sensitive_form and not signals.young and evidence.total >= benign["min_points"]
            and (signals.identity_name or not benign["requires_identity_match"])):
        return Decided(ReviewOutcome.DOWNGRADED, 0.55,
                       ["no accusation stands and the site collects no sensitive data", *evidence.items])
    return Decided(ReviewOutcome.INCONCLUSIVE, 0.5,
                   ["not enough independent evidence of legitimacy to lift the block", *evidence.items])


_RANK = {ReviewOutcome.CONFIRMED: 0, ReviewOutcome.INCONCLUSIVE: 0, ReviewOutcome.DOWNGRADED: 1,
         ReviewOutcome.OVERTURNED: 2}


def bound(proposed: ReviewOutcome, ruled: Decided) -> tuple[ReviewOutcome, Optional[str]]:
    """Keep a judge's proposal inside the band the facts allow.

    The judge cannot be more lenient than the rules. It may be more cautious, but once the facts have
    cleared a site it cannot put it back behind a block on its own word: a block needs hard evidence
    from the tools (which the rules would already have turned into `confirmed`), so the most cautious
    outcome left to the judge is `downgraded` (warn). Returns the outcome and, when it differs from the
    proposal, why.
    """
    ceiling, wanted = _RANK[ruled.outcome], _RANK[proposed]
    if wanted > ceiling:
        return ruled.outcome, "the facts do not support a more lenient outcome: " + "; ".join(ruled.basis[:3])
    if ceiling >= 1 and wanted < 1:
        return ReviewOutcome.DOWNGRADED, ("the facts clear the accusations and the judge cited no hard evidence from "
                                          "the tools, so its doubt can lower the site to a warning but not block it")
    if wanted == ceiling and proposed is not ruled.outcome and ruled.outcome is ReviewOutcome.CONFIRMED:
        return ruled.outcome, None
    return proposed, None
