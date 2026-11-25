# Places website audit

`scripts/check_places_websites.py` checks the websites listed in the Mirsad portal's Places directory with Mirsad's
website shield. A business listing whose domain lapsed and was bought by someone else still sends people to that
domain: the map shows a pharmacy, the link opens a casino. The audit finds those listings, and the listings whose
domain has expired or is parked for sale, so an officer can have the listing corrected or the site taken down.

It does not change the directory. It reads the portal's places file and writes a report the officer chooses where to
keep.

## What it does

1. Reads a places JSON file in the portal's format (below). Each listing's `urls` are its websites.
2. Drops links that are not the business's own site: social and video platforms, messaging links, maps and government
   portals (`listing_neutral_sites` in `src/scamshield/intel/data/services.json`) and reference, news and review sites
   (`search_ignore_sites`, same file). The lists are the website shield's own; the script holds none.
3. Checks each distinct host once (host without `www.`, as the portal's `hostOf()` computes it), with the first URL
   listed for that host: `POST /v1/check` on a running engine with `source: "batch"`, so the checks queue behind
   people's own browsing, or the engine inside the script's own process with `--in-process`. With `--verdict-db` it
   runs no checks and reads the verdicts an engine already stored instead (below).
4. Turns each verdict into one plain finding category from the engine's reason codes (table below).
5. Runs the helpline check on every listing whose English or Arabic name matches a brand in the website shield's registry
   (`src/scamshield/intel/data/brands.json`): a website that is not one of the brand's official domains is flagged,
   and so is a phone number that is not one of its official numbers when the listing presents itself as a helpline or
   already has a non-official website. The rule is the watcher's own (`scamshield.watch.listings.assess_listing`).
6. Writes one record per listing that has a website to check or a helpline flag, and prints counts per category.

A listing with several websites gets the most serious of them as its headline; every website's result is kept under
`websites`.

## Running it

From `mirsad-gateway/`, with the website shield's Python environment (the one its tests use):

```bash
# What would be checked; no network, no engine, nothing written
python scripts/check_places_websites.py --places ../fixtures/places/abu-dhabi-sample.json --dry-run

# The portal's committed sample (5 listings, 4 hosts) against the running engine
python scripts/check_places_websites.py --places ../fixtures/places/abu-dhabi-sample.json \
    --engine http://localhost:8000 --limit 5

# A real export: the file the portal loads (MIRSAD_DATA_DIR, default ./data, file places-abu-dhabi.json)
nice -n 19 python scripts/check_places_websites.py --places ../data/places-abu-dhabi.json \
    --out data/places_audit/abu-dhabi.json --csv data/places_audit/abu-dhabi.csv --concurrency 6

# The same report from a finished scan, without checking anything again (the engine database, opened read-only)
python scripts/check_places_websites.py --places ../data/places-abu-dhabi.json \
    --verdict-db <engine database>.db --out ../data/places/website-checks.json
```

| Option | Meaning |
| --- | --- |
| `--places` | The portal's places JSON. Required. |
| `--out` | JSON report. Default `data/places_audit/places-websites-<UTC time>.json`, under the git-ignored `data/`. |
| `--csv` | Also write a CSV, one row per listing, UTF-8 with a byte-order mark so Excel shows the Arabic columns. |
| `--engine` | A running engine's base URL, default `http://localhost:8000`. The script stops with status 2 if `GET /v1/health` does not answer. |
| `--in-process` | Run the engine inside the script instead. It uses the same `data/` folder (database, feeds, evidence packs) as the containers, so do not use it while the compose stack is running. |
| `--verdict-db FILE` | Build the report from an engine database's stored verdicts (`verdicts` table; the `json` column is the full verdict, `verdict_versions` gives the scoring version). Opened read-only and immutable, so nothing is written beside it. Each host is matched by the engine's normalised URL first, then by host; the newest verdict wins. A host with no stored verdict is `not_checked`. |
| `--limit N` | Check only the first N distinct hosts; listings on the other hosts are left out of the report. |
| `--concurrency N` | Checks in flight at once, default 4. |
| `--dry-run` | Print the hosts that would be checked and how many listings use each, and the offline helpline count. |

The committed sample under `fixtures/places/` is five real Overture records (real shops, real domains), so running it
against the engine fetches four real websites; they answer `allow`, category `none`. A website that does not resolve
(for example a `.test` domain) comes back `allow`, category `none`, with the engine's summary saying it is new to it;
an engine error on one host is recorded as `not_checked` for its listings and the run continues.

The full directory holds about 14,000 listings with a website (`with_urls` in `fixtures/places/manifest.json`). At the
hackathon's pace (median 2.5 s per check, 6 at once) a full run takes well under two hours; run it at low priority so
the live website shield keeps its speed.

## Places file format

The portal's `PlaceRecord` (`src/contract/schemas.ts`), written by `scripts/build-places-json.py` from an Overture
Maps download and loaded by `src/places/store.ts`. The file is a JSON array of:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Overture id; the record's key. |
| `name` | string | Primary name. |
| `name_ar` | string or null | Arabic name; null in Overture data. |
| `location_link` | URL | Google Maps search link for `lat,lng`. |
| `urls` | array of URLs | Websites, absolute http(s) only, de-duplicated. The audit reads these. |
| `phones` | array of strings | As published, e.g. `+97126429176`. The helpline check reads these. |
| `description` | string | Built from category and address. |
| `category` | string | Overture taxonomy, e.g. `beauty_supply_store`. |
| `address` | string or null | |
| `lat`, `lng` | number | |
| `confidence` | number or null | Overture confidence, 0 to 1. |
| `source` | `overture`, `osm` or `google` | |
| `updated_at` | ISO date-time | When the file was built. |

The script needs only `id` and `urls` on every record; it refuses a file that is not an array or a record without them.

## Output

The report is the contract with the Mirsad portal's Places map, format `mirsad-places-website-checks/1`. A change to a
field name or a category is a new format version.

```json
{
  "format": "mirsad-places-website-checks/1",
  "generator": "mirsad-gateway/scripts/check_places_websites.py",
  "generated_at": "2026-11-25T02:00:00Z",
  "source": { "places_file": "places-abu-dhabi.json", "places_sha256": "...", "mode": "engine | in-process | verdict-db",
              "engine": "http://localhost:8000", "verdict_db": null, "limit": null },
  "engine_version": "49255c2bf69b",
  "counts": { "harmful_redirect": 0, "data_theft": 0, "feed_listed": 0, "brand_mismatch": 0, "unrelated_redirect": 0,
              "parked": 0, "other_warning": 0, "none": 0, "not_checked": 0 },
  "summary": { "listings": 0, "listings_reported": 0, "listings_without_website": 0, "hosts_checked": 0,
               "by_decision": {}, "helpline_flags": 0, "...": 0 },
  "categories": { "parked": { "en": "Domain expired or parked for sale: ...", "ar": "..." }, "...": {} },
  "records": [ { "place_id": "...", "...": "..." } ]
}
```

`counts` holds every category, zeros included, counted over listings. `engine_version` is the engine's scoring-code
version (the one its database stores in `verdict_versions`); with `--verdict-db` it is the version of the stored
verdicts, comma-separated if they differ.

One record per listing that has a website to check, or a helpline flag. Listings without a website are left out.

| Field | Meaning |
| --- | --- |
| `place_id` | The portal's place id (`PlaceRecord.id`). |
| `name`, `name_ar`, `place_category`, `lat`, `lng` | From the listing (`place_category` is the listing's `category`). |
| `website`, `host` | The listing's website with the most serious result, as the listing spells it, and its host without `www.`. |
| `decision`, `risk_score` | The engine's decision (`allow`, `warn`, `block`) and risk 0 to 100; null when `not_checked`. |
| `category` | The stable machine category below. |
| `finding_en`, `finding_ar` | The plain-language finding for that category, in English and Arabic. |
| `reasons_en`, `reasons_ar` | Up to three of the engine's findings, most weight first, as lists of strings. |
| `reasons` | The same, as `{code, en, ar}` with the engine's reason code. |
| `summary_en`, `summary_ar` | The engine's one-line explanation of its decision. |
| `final_url` | Where the website ends up after redirects. |
| `evidence_ref` | The evidence case reference (`SS-` and eight hex digits), present on every `warn` and `block`. |
| `verdict_id` | The engine's verdict id; `GET /v1/verdicts/{id}` on the engine returns the full verdict. |
| `checked_at` | When the engine checked the host (UTC). |
| `engine_version` | Scoring-code version of that verdict. |
| `portal_path` | `#/places/search/<host>`: appended to the portal's address, opens the Places map on the listing. |
| `websites` | Every website of the listing, each with the fields from `website` to `engine_version` and `error`. |
| `helpline` | null, or `{brand, brand_ar, reasons, official_domains, official_phones, website_hosts_not_official, phones_not_official}`. |
| `error` | Why the website was not checked, when it was not. |

Categories, first match wins, for `warn` and `block`:

| `category` | Finding | Engine reason codes |
| --- | --- | --- |
| `harmful_redirect` | Leads to gambling, adult or pill content: the business's domain was taken over or compromised | `page.harmful_redirect`, `rule.takeover_block`, `page.gambling` |
| `data_theft` | Data-theft or wallet-draining script on the website | `page.exfiltration`, `page.wallet_drainer`, `page.credential_capture`, `page.clipboard_hijack` |
| `feed_listed` | Listed on a public phishing feed | `rep.blocklisted` |
| `brand_mismatch` | Imitates a registered brand | `domain.lookalike`, `rule.lookalike_floor`, `rule.impersonation_block`, `page.sensitive_form_off_brand`, `page.brand_title_mismatch` |
| `unrelated_redirect` | Re-registered name redirecting to an unrelated site | `page.unrelated_redirect`, `rule.unrelated_redirect_floor` |
| `parked` | Domain expired or parked for sale: not the business's website any more | `page.parked`, `rule.parked_floor` |
| `other_warning` | Any other warning or block: model scores, a risky domain ending, a site builder or a young domain | |

An `allow` is `none`, including a website the engine could not fetch. No verdict (engine error, or none stored for
the host in `--verdict-db` mode) is `not_checked`.

The CSV has one row per listing: `place_id, name, name_ar, place_category, website, host, decision, risk_score,
category, finding_en, finding_ar, reasons_en, reasons_ar, final_url, evidence_ref, checked_at, engine_version,
portal_path, helpline_brand, helpline_flags, error`; reasons are joined with ` | `.

The report holds business names and phone numbers. They go only to `--out` and `--csv`. The printed summary holds
counts only, the dry run prints hosts and URLs only, and the engine stores URLs and verdicts, never names. The script
warns when `--out` or `--csv` is inside the repository and outside a `data/` folder.

The helpline flags depend on how complete the brand registry's official domains are: on the full directory most of
them are a brand's own subsidiaries or franchise sites missing from `brands.json`. Review them before showing them as
findings.

## How an officer uses it

1. Run the audit against the portal's current places file and open the CSV, sorted by `finding`.
2. For each `harmful_redirect`, `data_theft`, `feed_listed`, `brand_mismatch` and `unrelated_redirect` row, open
   the portal, append `portal_path` to its address (or type the host into the Places search), and the map opens on the
   listing. The details panel shows the business's name, phones and address; the verdict is not shown there yet.
3. Confirm by phone with the business that the website is no longer theirs, then ask the directory's source to
   correct the listing. For a takeover, the evidence pack under the `evidence_ref` holds the screenshot, the redirect
   chain and the registrar and hosting abuse contacts, with takedown letters in English and Arabic ready to file.
4. `parked` listings are a data-quality finding, not a crime: the business closed or let its domain go. They are the
   ones most likely to be taken over next, so they are worth correcting before that happens.
5. A `helpline` flag means a listing uses a registered brand's name with a website or number that is not the brand's.
   Check it in the portal's Places search by the phone number and treat it like a fake-helpline report.

All of this is manual today: the portal does not import the report, the details panel does not show a verdict, and no
listing is corrected or hidden automatically.

## Hackathon run

During the hackathon the engine checked the websites of a private export of the directory (8,883 sites). Aggregates
only, from `ml/results/listings_scan.json`:

| Scan | Allow | Warn | Block | Flagged |
| --- | --- | --- | --- | --- |
| First, before tuning | 7,696 | 982 | 205 | 13.4% |
| Final, engine frozen | 8,505 | 322 | 56 | 4.3% |

Final scan, blocks: 43 lead to or serve gambling or other harmful content (a taken-over or compromised business
domain), 8 are listed on a public phishing feed, 4 are young domains with a data-theft or wallet-draining script, and
1 is other. Warnings: 120 domains expired or parked for sale, 4 re-registered names redirecting to an unrelated site,
and 198 others, mostly model scores together with a risky domain ending, a site builder or a young domain.

Batch timing: median 2.5 s, 95th percentile 4.4 s per site, 6 checks at once at the lowest CPU priority, blocklists
on, page depth.

These are development numbers. The list was used to tune the rules after the first scan; the gambling group was
checked by page title and destination, the data-theft group was not checked by hand; the second scan ran about three
hours after the first, and some destinations changed or were unreachable in between. That run was done by hand; this
script is the repeatable version, and its categories follow the same reason codes.

The same final scan, read back with `--verdict-db` against the full directory (26,040 listings, 8,587 distinct hosts
after social and directory links are dropped), counted per host: 40 `harmful_redirect`, 9 `data_theft`, 7
`feed_listed`, 11 `brand_mismatch`, 5 `unrelated_redirect`, 122 `parked`, 178 `other_warning`; 6 hosts (link
shorteners, link-in-bio pages, delivery apps, messaging) were not scanned then and are `not_checked`. These differ from
the hand count above because the script also categorises warnings, not only blocks, separates brand look-alikes, and
takes the first matching category. Counted per listing the numbers are higher, as several listings share a domain.

## Portal side

Nothing on the portal was changed. The smallest step that would let the Places details panel show a website's verdict
is an import of this report, read once at startup like the places file:

- `src/contract/schemas.ts`: a `PlaceWebsiteCheck` schema over the record fields above (website, host, decision,
  risk_score, category, finding_en, finding_ar, reasons_en, reasons_ar, final_url, evidence_ref, checked_at,
  engine_version) and an optional `websiteCheck` on `PlacesDetailResponse`.
- `src/app.ts`: read `places/website-checks.json` from the data directory next to `places-abu-dhabi.json`, the same
  way `readPlaces` does (a missing file leaves the panel as it is), into a map by place id.
- `src/http/routes/places.ts`: `GET /v1/places/{placeId}` adds `websiteCheck` when the map has the place.
- `openapi.yaml` and `src/contract/openapi-routes.ts`: the new field.
- `src/dashboard/js/views/places-map.js`: one row in `showDetails` with the decision, the finding in the officer's
  language and the case reference.
- Tests beside the existing Places route and store tests, with a synthetic report.

The audit would then be run with `--out <portal data dir>/places/website-checks.json`, and an officer would see the
finding on the listing itself. The portal holds no engine client, so the report file, not a live call, is the link,
in the same way Mirsad Android's reports reach the portal as files.
