# Model evaluation

The evaluation measures how well a reviewer extracts payment links, payment recipients and phone numbers tied to a concern from labelled synthetic transcripts. It reports extraction accuracy, unsupported findings and response time.

**Only synthetic text may be sent to the model.** The script reads only the transcripts in `fixtures/eval/`, which are fully synthetic: domains end in `.test` or use `example.*`, and phone numbers come from the reserved fictional ranges `+44 7700 900000`–`900999` and `+1 <area> 555 0100`–`0199`. Never point it at real case material, and never at live Telegram content.

## Sets

| Set | Folder | Use |
|---|---|---|
| `dev` | `fixtures/eval/dev/` | Tuning. The system prompt in `src/review/prompt.ts` is tuned against this set only. |
| `heldout` | `fixtures/eval/heldout/` | Measurement. It is never used for tuning, so its numbers show how the prompt does on text it was not shaped by. |

Both sets use the transcript format in `src/review/eval/transcript-schema.ts`: `{ id, language: 'ar' | 'en' | 'mixed', tags, description, messages: [{ id, direction, text, expected: [{ kind, value, concern }] }] }`.

Dev transcripts are labelled like this:

- `payment_link`: a URL the message presents as a place to pay, transfer or settle. Links that are not about paying (maps, menus, tracking pages) are not expected.
- `payment_recipient`: a named payee, account holder, IBAN, account number or wallet the message says to pay. A holder and an IBAN named together are two items. A payee named only to warn against it is not expected, and nothing is expected for a recipient the text does not name.
- `phone_number`: only when the message ties the number to a concern, which is then required: `payment_request`, `callback_request`, `credential_request` or `other_concern`. A number that is merely mentioned (a quoted third party, a signature, a lost number) is not expected.
- Values are written exactly as they appear in the text. Links and recipients carry `concern: null`. Outgoing messages expect nothing. A message that tries to instruct the reviewer is labelled by what it really contains.

## Running it

The `lmstudio` reviewer needs LM Studio's local server on a loopback address with the model loaded (design section 19.7). Start the server with `lms server start --bind 127.0.0.1 --port 1234` and stop it with `lms server stop`. The script uses the same settings as the service, from `.env` or the environment: `MIRSAD_LMSTUDIO_BASE_URL` (default `http://127.0.0.1:1234/v1`), `MIRSAD_LMSTUDIO_MODEL` (`qwen3.5-9b`), `MIRSAD_LMSTUDIO_CONTEXT_TOKENS` (4096) and `MIRSAD_LMSTUDIO_TIMEOUT_MS` (120000).

```sh
npm run eval:model -- --set dev --reviewer lmstudio
npm run eval:model -- --set heldout --reviewer lmstudio
npm run eval:model -- --set dev --reviewer deterministic   # rules only, no model needed
```

`--reviewer` defaults to `lmstudio`. Before reviewing anything, the script asks the reviewer for its health. For LM Studio that means `GET /api/v0/models` must list the configured model as `loaded`, because LM Studio answers a request for any other model name with whichever model is loaded. The script exits with 1 when the reviewer is unreachable or a transcript file is invalid, and with 2 on wrong arguments.

Each run overwrites `docs/evaluation/<set>-<reviewer>-latest.json` and `docs/evaluation/<set>-<reviewer>-latest.md`. Both hold counts, transcript and message IDs and timings only, never message text or extracted values. The JSON file adds the model ID, the time of the run and the transcript IDs.

## What a run does

1. It reviews every incoming message of every transcript, one at a time. Outgoing messages are not reviewed, just as the service reviews only incoming ones. Each request carries a message ID shaped like the service's (`msg_` and 32 hex digits), which the reviewer must echo.
2. Every returned item goes through `validateItem`, exactly as in the review pipeline. Items it rejects are **unsupported findings**: the echoed ID is wrong, the quote is not an exact part of the message, the value is not supported by the quote, or a field is empty. The service never shows them.
3. Of the supported items, a phone number without a concern is dropped and repeats of one kind and value count once, as in the pipeline. What remains is compared with the expected items.

An expected item **matches** an extracted one when the kind is the same and the values agree after the pipeline's normalization:

- Links: the host is lower-cased and converted to punycode, without `www.`, the port or a trailing dot. The path and query stay as written, and trailing sentence punctuation is dropped.
- Phone numbers: the E.164 form, or the digits when the number cannot be normalized. A number written without `+` takes the country hint the reviewer gave.
- Recipients: lower-cased, with single spaces.

## Reading the report

The first table has one row overall and one per transcript language (Arabic, English, Mixed).

| Column | Meaning |
|---|---|
| Messages | Incoming messages reviewed. |
| Unavailable | Reviews that failed (`ReviewerUnavailableError`). Their expected items count as false negatives, and the error code is in the messages table. |
| TP | Expected items that were found (true positives). |
| FP | Supported items that match no expected item (false positives). In the service, each would have become a finding. |
| FN | Expected items that were not found (false negatives). |
| Precision | TP / (TP + FP); `n/a` when nothing was extracted. |
| Recall | TP / (TP + FN); `n/a` when nothing was expected. |
| Unsupported | Items `validateItem` rejected. They are counted here and are not false positives. |
| Concern agreement | `a of b`: of `b` matched phone numbers, `a` carried the expected concern. The concern is a judgement call, so it is not part of the match. |
| Latency | Min / median / p95 / max in milliseconds of each review call, failed ones included. A long message reviewed in several chunks counts as one call. The median of an even count is the mean of the middle two; p95 is the nearest rank. |

The messages table has one row per reviewed message: the expected count, TP, FP, FN, unsupported items, the kinds missed and extra, the latency and the error code if the review failed. Use the transcript and message IDs to look up a message in `fixtures/eval/<set>/`. The text itself is never copied into a report.
