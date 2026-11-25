# Mirsad Android — evidence schema

What leaves the phone, when, and in which shape. Hackathon prototype; nothing here is endorsed by any authority.

**Principle.** Nothing leaves the phone unless the user taps **Report** and then picks an app in the system share
sheet. The app holds no INTERNET permission (the build fails if one appears in the merged manifest), so there is no
background upload and no network code. A report is a small JSON document built by
`app.mirsad.core.report.DefaultReportBuilder` from one stored incident. The user sees a plain-language preview of
what is in it and what is never in it before sharing. A copy is also saved on the phone for `adb pull`.

Code: `core/src/main/kotlin/app/mirsad/core/report/` (builder, normaliser, blocklist parser, ingest mapper),
`app/src/main/kotlin/app/mirsad/shield/report/` (share sheet, Aman shortcuts, blocklist import),
`scripts/push_report_to_mirsad.sh` (laptop-side push to the root Mirsad product).

## 1. Scam report, version 1

Serialised with kotlinx.serialization (`prettyPrint`, defaults written out). A sample is in
`scripts/sample_report.json`.

| Field | Type | Example | Why it is there |
|---|---|---|---|
| `reportId` | string, `mrs-` + 12 hex | `mrs-5a1f3c9e7b2d` | Stable id of the report: the first 48 bits of SHA-256 over (incident id, incident time, fingerprint). The same incident always gets the same id, so a re-shared report is a duplicate, not a new case. Not derived from any device identifier. |
| `version` | int | `1` | Schema version of this document. |
| `createdAt` | ISO-8601 UTC | `2026-11-24T20:15:00Z` | When the report was built (not when the message arrived; see limits in section 7). |
| `channel` | `CALL` / `SMS` / `CHAT` | `SMS` | Which surface the event came from. `CHAT` covers WhatsApp, Telegram, Botim and shared text. |
| `level` | `ALLOW` / `WARN` / `HOLD` | `HOLD` | Mirsad's decision. HOLD requires at least one hard reason. |
| `score` | number, 3 decimals | `0.912` | Combined engine score in [0, 1]. |
| `reasonCodes` | string[] | `["LINK_LOOKALIKE_OFFICIAL", "CONTENT_SMALL_FEE_LINK"]` | Why. Only stable codes from `ReasonCodes` (Contracts.kt), deduplicated, in verdict order, so a receiver can translate them. No free text. |
| `fingerprint` | 16 lowercase hex | `0123456789abcdef` | SimHash of the normalised, masked text (section 5). Lets two reports of the same campaign be matched without the text. `0000000000000000` when there was no text (calls, hidden content). |
| `artifacts.sender` | string or null | `+440000000001`, `ADCB` | The suspected scammer's number (E.164) or alphanumeric sender ID. **null** when the sender is a saved contact or unknown: a contact's display name is personal data and stays on the phone. |
| `artifacts.senderType` | `NUMBER` / `ALPHANUMERIC` / `CONTACT` / `UNKNOWN` | `NUMBER` | How the sender was identified. `CONTACT` with a null sender says "a saved contact sent this" without naming them. |
| `artifacts.urls` | string[] | `["http://emiratespost-ae.delivery-fee.example/pay"]` | Links found in the text, as seen (the link itself is the evidence). |
| `artifacts.domains` | string[] | `["delivery-fee.example"]` | Registrable domains of those links, for blocklists. |
| `artifacts.ibans` | string[] | `["AE000000000000000000000"]` | Payment destinations named in the text. |
| `artifacts.emails` | string[] | `["refund@bank-update.example"]` | Email addresses named in the text. |
| `artifacts.wallets` | string[] | `["bc1q000…"]` | Crypto wallet addresses named in the text. |
| `artifacts.handles` | string[] | `["@support_help"]` | Social or messaging handles the message asks the victim to contact. |
| `artifacts.phones` | string[] | `["+971500000003"]` | Other phone numbers named in the text (call-back numbers), E.164. |
| `language` | `EN` / `AR` / `LATIN_ARABIC` / `UNKNOWN` | `EN` | Detected language of the text. |
| `appVersion` | string | `0.1.0` | Which Mirsad build produced the report. |
| `modelVersion` | string | `none`, `lr-ngram-v1` | Which stage-2 model (if any) contributed to the score. |
| `synthetic` | boolean | `true` | True for Demo and test incidents. Receivers must ignore synthetic reports; the Aman shortcuts are disabled for them in the app. |
| `text` | string or null | `null` | The message text, **only** when the user ticked "include the message text" on the preview screen. Otherwise `null`. |

Everything in the artifact lists is extracted by the engine from the message text; nothing is read from any other
source on the phone. Lists are deduplicated and trimmed; order follows the engine's extraction order.

## 2. False-positive report

Sent when the user marked an incident "Not a scam" and chose to tell Mirsad's developers. It carries no sender at all.

| Field | Type | Example | Why it is there |
|---|---|---|---|
| `reportId` | string, `mrs-` + 12 hex | `mrs-9c2e41d07f3a` | Same construction as the scam report with a different salt, so it never collides with the scam report of the same incident. |
| `version` | int | `1` | Schema version. |
| `createdAt` | ISO-8601 UTC | `2026-11-24T20:15:00Z` | When the report was built. |
| `fingerprint` | 16 lowercase hex | `0123456789abcdef` | To recognise the message family that was wrongly flagged, without the text. |
| `reasonCodes` | string[] | `["CONTENT_URGENCY"]` | Which rules fired, so the wrong rule can be found. |
| `senderType` | `NUMBER` / `ALPHANUMERIC` / `CONTACT` / `UNKNOWN` | `ALPHANUMERIC` | The *kind* of sender only. The number, ID or name is not included. |
| `modelVersion` | string | `none` | Which model was involved. |
| `userVerdict` | `NONE` / `FALSE_POSITIVE` / `CONFIRMED_SCAM` | `FALSE_POSITIVE` | The user's own verdict on the incident. |
| `appVersion` | string | `0.1.0` | Which build. |
| `synthetic` | boolean | `false` | Demo/test marker. |
| `text` | string or null | `null` | Only when ticked. Needed to turn a wrong verdict into a labelled training row; off by default. |

## 3. What is never included

The report builder only sees one `Incident` row, and that row does not carry any of the following, so none of it
can appear in either report (unit-tested in `core/src/test/kotlin/app/mirsad/core/report/`):

- **Your contacts.** Not read. A sender that is a saved contact appears as `senderType: CONTACT` with `sender: null`.
- **Other messages.** One incident, one report. No history, no conversation, no other notifications.
- **Your location.** Mirsad holds no location permission.
- **Device identifiers.** No IMEI, Android ID, advertising ID, serial, IP or account names. The report id is a hash of
  the incident, not of the device.
- **Your own phone number.** Never read.
- **The message text**, unless the user ticks the box on the preview screen for that one report.
- **Reason details.** `Reason.detail` (an offending host, for example) is dropped; only the stable codes are shared.

The preview screen lists these under "never included" every time (`ReportPreview.excluded`); English lines come from
`ReportBuilder.preview`, Arabic lines from `ReportPreviewText.ar(report)`.

## 4. Artifact normalisation rules

Implemented in `ArtifactNormaliser` and shared by the report builder and the blocklist import.

| Kind | Rule | Examples |
|---|---|---|
| Phone numbers | E.164: `+` then 8–15 digits, first digit 1–9. Separators (space, `-`, `(`, `)`, `.`, `/`, bidi marks) are removed; Arabic-Indic digits (`٠`–`٩`, `۰`–`۹`) become ASCII; `00…` becomes `+…`; a leading `0` is a UAE local number (`+971` + rest); 8–9 bare digits are a UAE number; 11+ bare digits are an international number missing its `+`. Anything with letters (alphanumeric IDs, short codes) is not a phone number. | `050 123 4567` → `+971501234567`; `0044 0000 000001` → `+440000000001`; `ADCB` → dropped |
| Sender | `NUMBER` senders go through the phone rule (the raw value is kept if it does not normalise); `ALPHANUMERIC` senders are trimmed and kept as seen; `CONTACT` and `UNKNOWN` become `null`. | `+971 50 000 0003` → `+971500000003`; `Khalid` (contact) → `null` |
| Domains | Lowercase registrable domain: scheme, user-info, port, path, query and fragment are stripped; a trailing dot is removed; non-ASCII hosts become punycode (`xn--`); labels must be valid DNS labels; IP literals and single labels are not domains. The registrable domain is the last two labels, or the last three under a short list of two-label public suffixes (`co.ae`, `gov.ae`, `co.uk`, `com.sa`, …; not the full public suffix list). | `HTTPS://Pay.Delivery-Fee.EXAMPLE/x` → `delivery-fee.example`; `login.bank-update.co.ae` → `bank-update.co.ae`; `192.168.0.1` → dropped |
| Fingerprints | Trimmed, lowercased, optional `0x` removed, must be exactly 16 hex chars. | `0123456789ABCDEF` → `0123456789abcdef` |
| URLs, IBANs, emails, wallets, handles | Kept as the engine extracted them (trimmed, deduplicated). The URL is the evidence; rewriting it would destroy it. | |

## 5. Fingerprint definition

`fingerprint` is a **64-bit SimHash** of the message text, written as 16 lowercase hex characters. The engine
(workstream A, `app.mirsad.core.engine`) computes it once per event; the incident and both reports copy it unchanged.
The contract (`Verdict.fingerprint` in Contracts.kt):

1. The text is normalised the same way the rules see it (lowercased, whitespace folded; the exact steps are the
   engine's and are shared with the classifier).
2. **Digits are masked** (every digit sequence becomes a placeholder) so amounts, OTPs and tracking numbers do not
   change the hash.
3. **URLs are masked** (every link becomes a placeholder) so rotating phishing hosts do not change the hash.
4. Tokens of the masked text are hashed to 64 bits; SimHash sums each bit position across tokens and keeps the
   sign, giving one 64-bit value.
5. `0000000000000000` when there is no text (a call, or content hidden by the system).

Properties: near-identical messages differ in a few bits (compare by Hamming distance); the text cannot be recovered
from the hash; a campaign that only rotates amounts, codes and links keeps the same fingerprint. The blocklist import
and the "Not a scam" known-good list both key on this value.

## 6. Blocklist import file

Settings → Import blocklist reads a JSON document (max 2 MB) chosen with the system file picker and adds its entries
to the local block lists. Example (`app/src/main/assets/blocklist_example.json`, synthetic):

```json
{
  "version": 1,
  "issuedAt": "2026-11-24T00:00:00Z",
  "issuer": "example (synthetic, not a police alert)",
  "note": "All values are fictional: zero-filled numbers and .example domains.",
  "numbers": ["+440000000001", "+920000000002"],
  "domains": ["delivery-fee.example", "bank-update.example"],
  "fingerprints": []
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | int | no (default 1) | File format version. |
| `issuedAt` | ISO-8601 | no | When the issuer produced the list. Informational. |
| `issuer` | string | no | Who produced it. Stored as the note on every imported entry. |
| `note` | string | no | Free text for humans. |
| `numbers` | string[] | no | Sender numbers to block. Normalised to E.164 (section 4). |
| `domains` | string[] | no | Domains to block. Normalised to registrable domains. |
| `fingerprints` | string[] | no | Message fingerprints to block (section 5). |

**Signed police lists.** The Mirsad portal exports its approved watchlist numbers (and the fingerprints of citizen
reports from them) as this format plus `keyId`, `expiresAt` and `signature` (ECDSA P-256 / SHA-256; the signed text is
defined in `contracts/README.md`). `BlocklistSignature` checks it before normalisation:

| The file | Import |
|---|---|
| Signed by a key in `assets/trusted_blocklist_keys.json`, untampered, not expired | A police list: entries get `origin = "police:<keyId>"`, and the previous list from that key is removed first, so a number the police cleared disappears from the phone |
| Signed, but by an unknown key, changed after signing, or expired | Refused with the reason; nothing changes |
| No `signature` | A personal list, imported as before |

`scripts/trust_portal_key.sh` adds a portal's public key to the trusted keys before a build.

Parsing (`BlocklistParser`) is lenient: unknown keys are ignored, missing or `null` lists are empty. Each value is
normalised; values that cannot be normalised are dropped and counted (`invalid`). Entries already on a list are
skipped (`skipped`), never duplicated. Imported entries get `origin = "import:<file name>"` and the list kinds
`BLOCK_SENDER`, `BLOCK_DOMAIN`, `BLOCK_FINGERPRINT`. The import is local only; nothing is sent anywhere.

## 7. Import into the Mirsad portal (`POST /v1/citizen-reports`)

The Mirsad portal (the officer service in the repository root, contract in `openapi.yaml`) imports a scam report
exactly as this app writes it. An officer either picks the file in the portal (**Import report** in the inbox) or a
laptop sends it with `scripts/push_report_to_mirsad.sh`. Body: `{ "report": <the report JSON>, "demo": true? }`.

What the portal does with it:

| Report | In the portal |
|---|---|
| The report as a whole | One incoming message in a **Citizen report** chat. Reports from the same sender (`artifacts.sender`, or the fingerprint when there is no shareable sender) share one chat. The full report is stored with the message and shown as report details: the phone's verdict, risk, channel, the reasons in plain words, and every artifact as text. |
| `text` | The message text when the citizen shared it; otherwise one line such as "Scam SMS held on a citizen's phone (risk 91%). The citizen did not share the message text." |
| `artifacts.sender` (a `NUMBER`) and `artifacts.phones` | Phone watchlist observations (origin `citizen_report`). A new number enters **Needs review**; an officer approves or clears it. A number already approved shows a watchlist match on the chat. |
| `reportId` | Idempotency: the same report again answers 200 and changes nothing. |
| `synthetic: true` | Refused (422 `report_not_accepted`) unless `demo` is true; then it is labelled Demo and never reaches the watchlist. |
| A false-positive report, or `version` other than 1 | Refused (422 `report_not_accepted`). |

A Citizen report chat has no conversation behind it: the portal never dispatches, takes over, answers or sends it to
a model (409 `citizen_report_only`). An officer can flag the reported sender as a scammer, which approves the number
on the watchlist and moves the chat to Suspects.

**Auth.** `Authorization: Bearer <officer token>`; the script reads it from `MIRSAD_OFFICER_TOKEN` and passes it to
curl through a config file in a process substitution, never on the command line or in output.

`MirsadIngestMapper` (core) maps a report to the older `POST /v1/ingest` body. The portal no longer accepts citizen
reports there; the mapper is kept only because its tests document the earlier contract.

## 8. Pulling a report over adb

Every share also saves a copy on the phone (`ReportActions.saveForAdb`), first under the app-specific external
files directory, falling back to the private files directory when external storage is unavailable:

```sh
# App-specific external storage (usual case; no root or run-as needed)
adb exec-out run-as app.mirsad.shield ls files/reports/   # reports are kept in app-private storage (debug build)

# Private files directory (fallback; debug builds only)
adb shell run-as app.mirsad.shield ls files/reports/
adb exec-out run-as app.mirsad.shield cat files/reports/<name>.json > report.json
```

File names are the UI's hint made safe (`[A-Za-z0-9._-]`, max 80 chars) with a `.json` suffix. The push script does
this for you and takes the newest file:

```sh
export MIRSAD_OFFICER_TOKEN=…            # never echoed
scripts/push_report_to_mirsad.sh emulator-5556            # pull newest report, POST to http://127.0.0.1:8787/v1/citizen-reports
scripts/push_report_to_mirsad.sh --dry-run                # print the body instead
scripts/push_report_to_mirsad.sh --dry-run --file scripts/sample_report.json
```

## 9. Aman shortcuts

The Report screen offers Abu Dhabi Police's Aman service as call, SMS and email shortcuts. The numbers and address
come from `app/src/main/assets/report_channels.json`, whose every entry carries `"status": "to_be_confirmed"`: they
must be confirmed with the police team before any real use, and the app shows them as such. The shortcuts only open
the dialer / SMS app / email app with a draft; the user sends. They are disabled for synthetic (Demo) incidents.

The SMS/email draft is `ReportBuilder.amanSummary`: one bilingual line under 300 characters with the report id,
channel, sender number or ID (or "unknown sender"), level and reason codes. It never contains the message text.
