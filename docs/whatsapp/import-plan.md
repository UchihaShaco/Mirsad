# WhatsApp import plan

## Policy limit

Meta's published Business Messaging Policy (Government and Political Use) prohibits law-enforcement agencies from
using the WhatsApp Business Platform. Mirsad therefore has no WhatsApp Business Platform or Cloud API connector, no live
WhatsApp intake and no way to send WhatsApp messages. The WhatsApp phase covers two inputs only: labeled synthetic
fixtures, and approved evidence imports through the common intake API.

## Gate

WhatsApp-specific work starts only after the Telegram controlled test is verified (design section 14).

- Intake refuses `source: "whatsapp"` with `422 channel_not_enabled` unless `MIRSAD_WHATSAPP_IMPORT_ENABLED=true`.
- That setting is rejected at startup unless `MIRSAD_CONTROLLED_TEST_RECORD` names a record that validates and
  documents a verified test (manual reply passed, at least one event captured live, nothing failed), carrying the same
  approval reference as `TELEGRAM_APPROVAL_REFERENCE` when that is set.
- `GET /v1/status` reports the gate under `channels.whatsapp.gate`: `closed_until_telegram_controlled_test_verified`,
  then `closed_until_import_enabled` once a verified record exists, then `open`.
- Until then the repository holds only the shared adapter interface (`src/ports/channel-adapter.ts`), the
  [data mapping](data-mapping.md), this plan and the skipped WhatsApp block in `tests/contract/channel-contract.test.ts`.

## Steps once the gate opens

1. **Fixtures first.** Write labeled synthetic WhatsApp fixtures (`synthetic: true`, reserved phone numbers and
   domains only, generic names), a WhatsApp adapter implementing `ChannelAdapter` per the data mapping, and replay them
   through `POST /v1/ingest` with a `fixture_replay` connector. No WhatsApp credentials are involved.
2. **Shared contract.** Point the WhatsApp block in `tests/contract/channel-contract.test.ts` at those fixtures and
   remove the skip. The same inbox, evidence, watchlist hook and takeover checks that Telegram passes must pass.
3. **Approved imports.** For each approved source account, provision an `approved_import` connector granted on that
   account only. The import tool takes the export file, the conversation reference, the export's time zone and date
   format, and which sender label is the account itself; it posts the normalized events one by one through the same
   intake API and reports IDs and result codes only. Re-running an import creates nothing new.
4. **Review policy.** Imported content is reviewed by the local model only if `approved_import` is added to
   `MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS` (the default allows `fixture_replay` only). That is a decision for the
   approving authority, not a default.

## Not planned

- Any connection to the WhatsApp Business Platform or Cloud API.
- Sending messages, reading receipts or presence.
- Treating fixture content as real evidence: a WhatsApp fixture keeps `fixture_replay` provenance.
