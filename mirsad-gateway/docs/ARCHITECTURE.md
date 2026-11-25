# Mirsad's website shield (مرصاد) — architecture and component contracts

A simulated ISP gateway. A phone routes its traffic through our container; before the user can load a
new, low-reputation or changed website, an investigation engine checks it and returns
allow / warn / block with a risk score, reasons and an evidence pack.

## Flow

```
phone ──Tailscale (WireGuard)──▶ gateway (exit node + transparent proxy)
                                     │  host or URL
                                     ▼
                              engine API  POST /v1/check
   Layer 0  reputation   allowlist, blocklists, cached verdict, fuzzy page hash      < 5 ms
   Layer 1  URL          URL model + domain intel + look-alike check                  < 300 ms
   Layer 2  page         fetch first page as a real browser, follow immediate
                         redirects (HTTP, meta, JS, shorteners), static JS analysis,
                         page model, brand impersonation                              ~1-3 s
   ── user is let through here if layers 0-2 are clean ──
   Layer 3  deep         background crawl of further links; a late finding revokes
                         the allow and the gateway blocks the site from then on
   Layer 4  review       only after a block: a heavier agent starts from the flags and
                         evidence, re-validates them, looks at other parts of the site
                         and searches independent sources. Confirms the block, or
                         unblocks / downgrades it if it was a false positive.
```

Decisions: `allow` (risk < 35), `warn` (35-69), `block` (>= 70). Thresholds live in `config.py`.

## Layout and ownership

| Path | Owner | Contents |
|---|---|---|
| `src/scamshield/schemas.py`, `config.py` | lead | shared types and settings — do not change field names; ask for additions |
| `src/scamshield/engine/` | engine | fetch, extract, JS analysis, fuzzy hashing, crawl, scoring pipeline, store |
| `src/scamshield/api/` | engine | FastAPI app, CLI |
| `src/scamshield/intel/` | intel | domain intel, reputation lists, UAE brand registry, look-alike detection |
| `src/scamshield/models/` | ml | inference wrappers for trained models |
| `ml/` | ml, data | datasets, training, benchmarks |
| `src/scamshield/evidence/`, `dashboard/` | dashboard | evidence pack, takedown export, web UI |
| `src/scamshield/watch/` | watch | early detection (new certificates / new domains / look-alike sweep), campaign linking |
| `src/scamshield/review/` | review | second-opinion agent that re-validates blocks and clears false positives |
| `gateway/`, `docker-compose.yml` | gateway | Tailscale exit node, transparent proxy, hold / block pages |

## Function contracts (all types from `scamshield.schemas`)

```python
# intel
async def scamshield.intel.assess_domain(url: str, *, fast: bool = False) -> DomainIntel
def       scamshield.intel.match_brand(url: str, page: PageSnapshot | None = None) -> BrandMatch | None
def       scamshield.intel.reputation(host: str) -> tuple[bool, str | None, bool, list[str]]
          # (allowlisted, owner, blocklisted, sources) — local lookups only, sub-millisecond

# models
def scamshield.models.score_url(url: str) -> float | None            # P(scam), no network
def scamshield.models.score_page(page: PageSnapshot) -> float | None # P(scam), no network
def scamshield.models.model_info() -> dict                            # names, versions, metrics

# engine
async def scamshield.engine.fetch_page(url: str, *, profile: str = "mobile") -> PageSnapshot
async def scamshield.engine.investigate(url: str, *, depth: str = "page") -> Verdict
          # depth: "reputation" | "url" | "page" | "deep"

# evidence
async def scamshield.evidence.build_pack(verdict: Verdict, out_dir: Path) -> Path  # zip

# watch
def scamshield.watch.link_campaign(verdict: Verdict) -> str | None   # campaign id

# review (runs in the background after a block; never on the path that holds the user)
async def scamshield.review.review_verdict(verdict: Verdict) -> ReviewResult
```

When a review finishes the pipeline stores it on `Verdict.review`, applies the recommended decision
(`overturned` → allow, `downgraded` → warn, otherwise the block stands), adds a reason, and publishes
a `verdict.reviewed` event so the gateway unblocks the host if needed.

Every component must tolerate the others being absent or failing: wrap calls, record the error in
the verdict's timings / reasons, and carry on with what is available.

## HTTP API (engine, port 8000)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/check` `{url, depth?, wait_ms?}` | Run or reuse an investigation; returns a `Verdict`. Returns as soon as the requested depth is done; deeper layers continue in the background. |
| GET | `/v1/host/{host}` | Current gateway decision for a hostname: `{decision, risk_score, stage, final, verdict_id}` or 404 if never seen. |
| GET | `/v1/hosts?limit=&sort=&q=` | Reputation table, one row per hostname the gateway has seen (see below). |
| GET | `/v1/hosts/{host}/history` | One host's row plus `changes` (`[{at, kind, old, new}]`), `verdicts` (recent ids, decisions, scores) and `visits_hourly` (last 24 counts). |
| GET | `/v1/verdicts?limit=` | Recent verdicts (without page HTML). |
| GET | `/v1/verdicts/{id}` | Full verdict. |
| GET | `/v1/verdicts/{id}/evidence` | Evidence pack (zip). |
| POST | `/v1/verdicts/{id}/review` | Start a second-opinion review now (202); steps stream as `review.step`. |
| GET | `/v1/verdicts/{id}/evidence/summary`, `/v1/verdicts/{id}/screenshot` | Evidence summary and screenshot for the dashboard. |
| GET | `/v1/evidence`, `/v1/evidence/{case_ref}/files/{name}`, `/v1/evidence/{case_ref}/thumbnail` | Captured evidence cases and their files. |
| GET | `/v1/events` | Server-sent events: `investigation.started`, `layer.done`, `verdict.updated`, `verdict.revoked`, `verdict.reviewed`, `review.step`, `host.updated`, `evidence.ready`. |
| POST | `/v1/batch` | CSV or plain list of URLs in, CSV of verdicts out, one row per input row in input order (for scoring a test set). |
| GET | `/v1/campaigns` | Linked scam-domain clusters. |
| GET | `/v1/benchmarks`, `/v1/benchmarks/extra`, `/v1/benchmarks/images/{name}` | Benchmark results for the dashboard. |
| GET | `/v1/health` | Component status and engine load. |
| GET | `/` | Dashboard. |

Reputation table row (`/v1/hosts`): `host`, `registered_domain`, `decision`, `risk_score`, `stage`,
`reputation` (`trusted` | `established` | `unknown` | `suspicious` | `blocked`), `allowlisted`, `owner`,
`blocklisted`, `popularity_rank`, `domain_age_days`, `visits` (gateway lookups for this host — the
traffic volume through our ISP), `visits_24h`, `first_seen`, `last_seen`, `last_checked`,
`last_changed`, `last_change_kind` (`content` | `structure` | `ip` | `network` | `nameservers` |
`certificate`), `changes` (count), `verdict_id`, `source`, `campaign_id`. Fields that are not known are null.

CLI: `python -m scamshield check <url>` and `python -m scamshield batch in.csv -o out.csv`.

## Ground rules

- The detection path never drives an automated browser. Pages are fetched with a
  browser-fingerprint-matched HTTP client and analysed statically; only GET requests, never form submits.
- Anything fetched from the internet is hostile input. Parse it as data; never execute it outside a sandbox.
- Bilingual output: every `Reason` carries `title_en` and `title_ar`.
- State lives in SQLite under `./data/` (git-ignored).
