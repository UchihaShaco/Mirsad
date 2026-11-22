# Mirsad

Mirsad is an evidence capture and review service for officer-led investigations. It records chat messages as they reach
it, renders a timestamped Mirsad-rendered capture of each received message, runs a quiet AI review that an officer can
pause or take over at any time, and keeps a private phone watchlist. A host platform integrates through the same HTTP API
and event stream that the reference dashboard uses.

This first version is local and synthetic: Telegram-shaped fixtures replayed over HTTP, a local model, simulated replies.
What still needs a host integration, an approval or an approved environment is listed under
[What is simulated](#what-is-simulated-and-what-needs-a-host-integration).

## Quick start

Needs Node.js 24.18 or later. The commands are for PowerShell, which is this machine's shell. In PowerShell, set an
environment variable on its own line, with `$env:NAME = "value"`, before the command that reads it.

```powershell
npm install
# Optional: use the offline rules reviewer instead of the local model (see "Local model setup").
$env:MIRSAD_REVIEWER = "deterministic"
npm run demo
```

`npm run demo` starts Mirsad on `http://127.0.0.1:8787`. On the first start with an empty data directory (`./data`) it
seeds a demo workspace: two officers, an intake account and an officer account on Telegram, and a fixture connector. Their
tokens are written once to `data/demo-credentials.json`, which is git-ignored.

In a second terminal:

```powershell
npm run demo:credentials                                     # prints a sign-in link per demo officer
npm run replay -- fixtures/telegram/inbound-first-greeting.json
```

Open the `Demo Officer 1` link that `demo:credentials` printed (`http://127.0.0.1:8787/#token=...`). The new chat appears
in the **New inbound** queue. Replay any other file in `fixtures/telegram/`; [docs/telegram/fixtures.md](docs/telegram/fixtures.md)
says what each one exercises. Select chats and click **Dispatch** to start AI review. Use **Pause AI**, **Take over** and
**Resume AI** on a chat. Under takeover the composer opens blank; send a reply, or choose **Leave unanswered**. To enter
a merchant's payment confirmation, use **Record merchant confirmation** in the chat's case panel: a payment link whose
host it does not list is then marked **Suspected fraud**. Try it with `merchant-conflict.json` and the host
`pay.merchant.example`.

## Commands

| Command | What it does |
|---|---|
| `npm run demo` (or `npm start`) | Starts the service on loopback. Settings are read from `.env` (copy [.env.example](.env.example)) or the environment. |
| `npm run demo:credentials` | Prints the dashboard sign-in links for the configured data directory, plus the names of the variables the headless client and the replay script read. |
| `npm run replay -- fixtures/telegram/<file>.json` | Posts a synthetic fixture to a running instance through `POST /v1/ingest`. It refuses a file that is not marked synthetic, or that holds a domain or phone number outside the reserved ranges. |
| `npm test` | Unit, integration and contract tests (vitest). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test:e2e` | Dashboard end-to-end tests in the installed Microsoft Edge or Google Chrome (playwright-core; no browser download). |
| `npm run demo:walkthrough -- --reviewer deterministic` | The clean-start walkthrough (below) with the offline reviewer. `--reviewer lmstudio` uses the local model; without `--reviewer` it uses the configured one (`MIRSAD_REVIEWER`, default `lmstudio`). `--keep` keeps the temporary data directory and prints its sign-in links. |
| `npm run eval:model -- --set heldout --reviewer lmstudio` | Model evaluation on the held-out synthetic transcripts. Writes `docs/evaluation/heldout-lmstudio-latest.{md,json}`. Use `--set dev` for the tuning set and `--reviewer deterministic` for the rules baseline. |
| `npm run telegram:readiness` | The eight local Telegram readiness checks against a temporary instance. Writes `docs/telegram/readiness.{json,md}`. |
| `npm run telegram:verify`, `npm run telegram:provision` | Bot and connection verification, and local provisioning, for the controlled Telegram test. See [docs/telegram/setup.md](docs/telegram/setup.md). |
| `npm run openapi:generate` | Regenerates [openapi.yaml](openapi.yaml) from the zod contract. A test fails when the committed file is stale. |
| `npx tsx examples/headless-client/run.ts` | The HTTP-only integration example. Needs a running instance. |

## What was verified

These are the results of this build's final runs on 2026-11-22, on Windows 11 with Node 24.18.0. The first three ran at
commit `fa24c3f`; the commits after it change only documentation. The two walkthrough runs ran at commit `33cbefc`. The
last two rows are copied from their committed reports, which record when they ran:

| Run | Result |
|---|---|
| `npm test` | 47 test files: 417 tests passed and 4 skipped. The skipped block is the WhatsApp channel contract, which stays off while its gate is closed. The output has no warnings. |
| `npm run typecheck` | Clean. |
| `npm run test:e2e` | 10 of 10 dashboard flows passed in a headless installed browser (the suite tries Microsoft Edge first, then Chrome). |
| `npm run demo:walkthrough -- --reviewer deterministic` | 22 of 22 checks passed, in 2.3 s. |
| `npm run demo:walkthrough -- --reviewer lmstudio` | 22 of 22 checks passed with Qwen3.5 9B on LM Studio (`127.0.0.1:1234`, 4,096-token context), in 21.0 s. Both runs raised 5 findings and published 121 stream events with the same mix of types. |
| Telegram readiness ([readiness.md](docs/telegram/readiness.md)) | **Ready for controlled test**: all eight local checks passed, recorded 2026-11-22T01:34:09.511Z. The live test is pending (see [Telegram](#telegram)). |
| Held-out model evaluation (the latest run, recorded in [docs/evaluation](docs/evaluation/) at 2026-11-22T03:44:38.530Z) | Qwen3.5 9B: precision 87.0%, recall 95.2%, 1 unsupported finding (rejected, never shown), median review 242 ms (p95 5,785 ms) over 55 messages. The deterministic baseline: precision 68.4%, recall 61.9%. Details under [Evaluation results](#evaluation-results). |

### The walkthrough

`npm run demo:walkthrough` starts a fresh instance in-process, on an ephemeral loopback port. It uses a temporary data
directory and the demo seed, and replays the Telegram fixtures with the same replay function as `npm run replay`. It
then checks the officer workflow, in order, through the HTTP API and the event stream only. It prints one line per check,
with IDs and counts and never message text, and exits 1 if any check fails. With the local model it polls the timelines
until reviews settle, waiting up to ten minutes at a time. If the model does not answer, it reports review as unavailable
instead of waiting forever.

| # | Check | What it shows |
|---|---|---|
| 1 | `service_healthy` | `/healthz` answers. `GET /v1/status` reports the reviewer, Telegram readiness, the live connector state and the WhatsApp gate. |
| 2 | `inbound_first_new_inbound` | An inbound-first chat lands in **New inbound** with `First observed: incoming`. |
| 3 | `officer_first_both_directions` | An officer-first chat shows both directions with `First observed: outgoing`. |
| 4 | `start_marker_contact_started` | A fixture's start assertion, from the trusted fixture connector, gives `Contact started chat`. |
| 5 | `capture_per_message` | Every received message has a ready capture. The fetched bytes match its SHA-256 and the `X-Mirsad-SHA256` header. |
| 6 | `replay_creates_no_duplicates` | Replaying fixtures again answers `duplicate_event` and changes no counts. |
| 7 | `edit_delete_separate_events` | An edit and a deletion are separate events. The original text is still served, and the edit has its own capture. |
| 8 | `batch_dispatch_per_chat_status` | **Dispatch** of two chats returns a status for each chat. |
| 9 | `quiet_review_one_note` | The six-message payment fixture: six captures and exactly one finding, on the last message with its exact quote. The five routine messages raise nothing: three reviews end `No new finding`, and the two outgoing messages are not reviewed. |
| 10 | `pause_and_resume` | **Pause AI**, then **Resume AI**. Both appear in the case log with the officer. |
| 11 | `take_over` | **Take over** gives the officer control at the next revision. |
| 12 | `composer_blank_by_default` | No outgoing message exists before **Send**. The intake account offers the `Message received.` template, and nothing is sent until the officer sends. |
| 13 | `simulated_send` | One composer send appears once, as **Simulated send**, with the officer and the time. A retry with the same `Idempotency-Key` is replayed. |
| 14 | `leave_unanswered` | **Leave unanswered** adds one case-log entry and no message. The chat stays open under takeover. |
| 15 | `capture_during_takeover` | A message arriving under takeover is captured. Its review stays `not_requested`. |
| 16 | `watchlist_needs_review` | A number mentioned with a payment request becomes a **Needs review** entry with its source reference. |
| 17 | `watchlist_approval_sender_match` | After approval, a new inbound chat whose sender shares that number shows **Watchlist match** with links to the evidence. |
| 18 | `watchlist_cleared_new_evidence` | Clearing the entry removes the match. A new mention adds an observation and flags new evidence, and the entry stays cleared. |
| 19 | `merchant_conflict_suspected_fraud` | Recording a merchant's payment confirmation flags the conflicting link as **Suspected fraud**. |
| 20 | `stream_second_client` | A second officer, connected through the dashboard's own stream client from a snapshot cursor, receives every event to the head, with no gap. |
| 21 | `outsider_gets_404` | An officer of another workspace gets `404 chat_not_found` for a timeline and `404 artifact_not_found` for an artifact. |
| 22 | `restart_keeps_evidence` | After a restart on the same data directory, messages, events, captures and the case log are unchanged, and every capture re-reads with a matching SHA-256. |

The walkthrough does three things that no shipped fixture does. It copies the inbound-first fixture into a new chat with
a start assertion. It derives two later messages from fixture updates, with new message IDs. And it provisions the
outside officer straight into the temporary database, because no HTTP route provisions principals.

## What is simulated and what needs a host integration

Simulated or fixture-only in this version:

- **Composer sends.** A reply is stored once as an outgoing message labelled **Simulated send**, with officer
  attribution and time. Nothing is delivered to any channel, and no code path sends to Telegram or WhatsApp.
- **Telegram intake.** All Telegram-shaped data enters through the replay of synthetic fixtures. The live Business
  connector is built and tested only against a fake Bot API server, and it stays disabled.
- **Model review.** The model reviews only content that arrives through a connector whose capture method is
  `fixture_replay`, such as the demo fixture connector. `npm run replay` checks that a fixture is marked synthetic and
  holds only reserved domains and numbers; the API does not, so text posted straight to `POST /v1/ingest` with such a
  connector's token also reaches the model once its chat is dispatched. Live Telegram content is never sent to any
  model, local inference included.
- **Identity.** The demo identity adapter maps bearer tokens from the demo seed to officers and to a fixture connector.
- **Start of conversation.** `Contact started chat` and `Officer started chat` appear only when a fixture author asserts
  a start. Real Telegram updates carry no start marker, so live chats always show `First observed: …`.

Needs a host integration, an approval or an approved environment:

- **Real delivery** of composer replies, through an approved host adapter for that channel.
- **The host's login** in place of the demo identity adapter. `IdentityProvider` is the port to replace (design section 3).
- **An approved environment in the UAE** for case storage, screenshot processing, inference, logs and backups. See
  [docs/deployment-notes.md](docs/deployment-notes.md).
- **Encryption at rest**, with separate key custody. The local SQLite file and evidence directory are not encrypted.
- **A retention and deletion policy.** Original text and captures are never changed or deleted by Mirsad. Deleting
  evidence follows the approved case retention policy, which this version does not implement.
- **The controlled Telegram test**, which needs the account owner's approval and test credentials.

## HTTP contract

The contract is [openapi.yaml](openapi.yaml), generated from the zod schemas in `src/contract/` (OpenAPI 3.1, with request
and response schemas and one complete workflow under `x-workflow-example`).
[examples/headless-client](examples/headless-client/README.md) uses only HTTP to register a chat, dispatch review, submit
an incoming event, read the timeline and take over. A test runs it against a live service and validates every exchange
against `openapi.yaml`.

**Auth.** Every route except `/healthz` and the dashboard files needs `Authorization: Bearer <token>`. There are two
kinds of principal. Officers use every route except intake. A connector is the separate ingestion credential: it may call
only `POST /v1/ingest`, `POST /v1/chats/{chatId}/events` and `GET /v1/me`, and its capture method is fixed when it is
provisioned. A missing or unknown token gets `401 unauthenticated`; the wrong kind of principal gets
`403 forbidden_for_principal`. A chat the caller may not open is answered exactly like a missing one,
`404 chat_not_found`. Tokens are read only from the header; a token in a URL is ignored.

**Envelope.** Every JSON response is `{ "success": true, "data": …, "error": null }` or
`{ "success": false, "data": null, "error": { "code", "message", "details" } }`. The chat list adds
`meta: { total, limit, offset }`. The artifact route (PNG) and the event stream (SSE) are the two exceptions.

**Idempotency.** `POST /v1/dispatches` and `POST /v1/chats/{chatId}/officer-messages` need an `Idempotency-Key` header.
The same key with the same body replays the stored response, with `Idempotency-Replayed: true`. The same key with a
different body gets `422 idempotency_key_reused`.

**Revisions.** Control, composer and decision requests carry `expectedRevision`. A stale revision gets
`409 revision_conflict`, with the current revision and AI mode in `details`.

| Route | Caller | Purpose |
|---|---|---|
| `POST /v1/chats` | officer | Register an existing conversation. Returns a stable `chatId` (`201` new, `200` existing). |
| `GET /v1/chats` | officer | List authorized chats with channel, origin label, inbox status, AI mode and watchlist matches, plus the snapshot `cursor`. Query: `inboxStatus`, `limit`, `offset`. |
| `POST /v1/ingest` | connector | Submit an intake event. Creates or finds the chat and appends the event in one transaction. |
| `POST /v1/chats/{chatId}/events` | connector | The same intake for a registered chat: `message.recorded`, `message.edited`, `message.deleted`. |
| `POST /v1/dispatches` | officer | Start AI review on 1 to 100 chats; per-chat status. Access to the whole selection is checked first. A chat that is already active keeps its mode, and its unavailable reviews are retried. |
| `POST /v1/chats/{chatId}/control` | officer | `pause`, `take_over` or `resume`, with `expectedRevision`. |
| `POST /v1/chats/{chatId}/officer-messages` | officer | Composer send by the controlling officer: one **Simulated send**. |
| `POST /v1/chats/{chatId}/officer-decisions` | officer | `leave_unanswered` on an incoming message: an internal case action only. |
| `GET /v1/chats/{chatId}/timeline` | officer | Messages, message events, case actions, findings, case references and the cursor. |
| `GET /v1/artifacts/{artifactId}` | officer | A capture as PNG. Its SHA-256 is verified on every read. |
| `GET /v1/events` | officer | The event stream ([below](#event-stream)). |
| `GET /v1/watchlist` | officer | Phone watchlist entries the caller can access. |
| `POST /v1/watchlist/{entryId}/review` | officer | `approve`, `clear` or `reopen`, with a reason and `expectedRevision`. |
| `POST /v1/chats/{chatId}/case-references` *(extension)* | officer | Records a merchant's payment confirmation. **Suspected fraud** needs independent merchant confirmation, and this is where the officer enters it. The dashboard's case panel calls it from **Record merchant confirmation** and lists the chat's confirmations. |
| `POST /v1/captures/{captureId}/retry` *(extension)* | officer | Retries a failed capture: the brief's "retryable capture error". |
| `GET /v1/me` *(extension)* | officer or connector | Who the token belongs to. The dashboard needs it to know the signed-in officer. |
| `GET /v1/status` *(extension)* | officer | Service, workers, reviewer reachability, Telegram readiness and the WhatsApp gate: the brief's health and status checks. |
| `GET /healthz` *(extension)* | none | Liveness. |
| `GET /`, `GET /assets/*` | none | The reference dashboard. |

Routes marked *extension* are not in the brief's route table. Each exists because a brief requirement cannot be met
without it.

## Event stream

`GET /v1/events` is a server-sent events stream of everything the caller may see in their workspace. A chat event needs
access to that chat; a watchlist event needs access to that entry.

**Connecting.** Send the token in the `Authorization` header. The browser's `EventSource` cannot send headers, so read the
stream with `fetch()`, as the dashboard does, or with any SSE client that supports headers.

**Where it starts.** The stream starts after the position in the `Last-Event-ID` header when there is one, else after
`?cursor=`, else at the current head. Take the cursor from the snapshot you just read: `GET /v1/chats` and
`GET /v1/chats/{chatId}/timeline` return the `cursor` read in the same transaction as the data. An event committed between
your snapshot and your subscription is then still delivered. On reconnect, send `Last-Event-ID` with the last `id` you
received.

**Wire format.** One SSE message per event: `id` is the workspace sequence number, `event` is the type, and `data` is JSON
`{ "id", "type", "chatId", "occurredAt", … }` plus the fields below. Data carries IDs and statuses only, never message
text, names or numbers. Event IDs are workspace-wide, so gaps between your events show that other chats were active. A
`: keep-alive` comment arrives every 15 seconds.

| Type | Extra fields |
|---|---|
| `chat.created` | `inboxStatus` |
| `chat.control_changed` | `aiMode`, `revision` |
| `message.recorded` | `messageId`, `direction`, `origin` |
| `message.edited`, `message.deleted`, `message.conflicting_copy` | `messageId`, `messageEventId` |
| `capture.updated` | `messageId`, `messageEventId`, `captureId`, `status`, `artifactId` |
| `review.updated` | `messageId`, `messageEventId`, `status`, `outcome` |
| `finding.created` | `messageId`, `findingId`, `kind` |
| `case_action.recorded` | `caseActionId`, `actionType` |
| `case_reference.recorded` | `caseReferenceId` |
| `watchlist.entry_updated` | `watchlistEntryId`, `status`, `reason` (`created`, `observation_added` or `reviewed`); `chatId` is null |
| `watchlist.match` | `watchlistEntryId` |
| `stream.reset` | `reason: "cursor_out_of_range"`, `resumeFrom`, `reload: ["inbox", "timeline"]` |

**`stream.reset`.** If the starting position is below the retained history or above the head, for example a cursor from
another data directory, the server sends `stream.reset` and continues from the head. Reload the inbox and timelines when
you receive it. The newest 5,000 events per workspace are kept (`MIRSAD_STREAM_RETENTION`).

```js
// Minimal reader (Node 24 or a browser). The dashboard's full parser is src/dashboard/js/state/sse-parser.js.
const { cursor } = (await (await fetch(`${base}/v1/chats`, { headers: { Authorization: `Bearer ${token}` } })).json()).data;
const response = await fetch(`${base}/v1/events?cursor=${cursor}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
});
const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break; // reconnect with the header 'Last-Event-ID: <last id>'
  buffer += value;
  for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (data) console.log(JSON.parse(data)); // { id, type, chatId, occurredAt, ... }
  }
}
```

## Review pipeline and its safeguards

- **Capture first.** The original text, timestamps and pending capture work are saved in one transaction before any
  review. Capture never waits for review. If rendering fails, the message stays readable and the capture shows a
  retryable error.
- **The model extracts; code decides.** For each item the reviewer must return the source message ID, an exact quote and
  the extracted value (a payment link, a payment recipient, or a phone number with its concern). Code checks the ID and
  checks that the quote is an exact part of the stored text and supports the value. Items that fail are counted as
  unsupported and never shown. Labels and notes come from fixed templates, never from model text.
- **Quiet by default.** Every message is saved. A message that adds nothing ends `No new finding` internally, with no
  alert. Repeats of a detail the chat already carried are suppressed. A new detail raises one short note with the exact
  quote and its source message: `New payment link`, `New payment recipient`, `Payment destination changed` or
  `Phone number tied to a concern`.
- **No stale results.** Before a result is published, the chat's mode and revision are checked again. A result that
  finishes after a pause or takeover is discarded (`stale_discarded`) and never appears as an active finding.
- **Suspected fraud is a rule.** It is raised only when a payment link's host conflicts with a merchant confirmation the
  officer recorded. Code finds links on its own as well, so the rule does not depend on what the model reported. The
  model never labels fraud.
- **Policy.** Only content captured by `fixture_replay` is reviewed by default (`MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS`).
  `telegram_business_live` is never reviewable, whatever that setting says.
- **Failure.** When the model fails or times out, the review shows `unavailable`. Intake, captures and officer controls
  keep working. An unavailable review is retried automatically, up to three attempts, when new evidence arrives in the
  chat or the service starts. It is retried again, with its attempts reset, whenever an officer resumes or dispatches
  the chat. Dispatching a chat that is already active does this too, so **Dispatch** is the retry after a model outage.
- **Isolation.** The reviewer has no tools and no store access. LM Studio is reached only on a loopback URL, with
  redirects refused and a strict JSON schema for the answer. Text longer than 1,500 characters is reviewed in chunks, so
  each request fits the 4,096-token context. Each chat has one review at a time, and chats are reviewed in parallel
  (`MIRSAD_REVIEW_CONCURRENCY`, default 2).

## Phone watchlist

- There is one private watchlist per workspace. A number is normalized to E.164 only when it is written in international
  form, when the source gives its country (sender metadata), or when the reviewer reports the country from the text that
  mentions it. No default country is ever assumed. The reviewer's country is the model's judgement, and for a number in
  national format, such as `07700 900123`, it alone decides whether the number becomes an exact-match entry. A number
  that cannot be normalized stays a lead tied to the chat that mentioned it. It never merges with other chats and never
  matches.
- Each observation records whether the number came from **sender metadata** (a number the source gives for the sender,
  such as a Telegram contact card the sender shares about themselves) or was **mentioned** in a message. It also records
  the exact source reference, the number as written, and a reason. A mentioned number is never linked to the sender.
  The sender's number is also returned with its message (`sender.phone`, exactly as the source gave it), drawn on the
  message's capture as **Sender phone**, and shown on the message in the dashboard.
- Mirsad creates **Needs review** entries and appends new observations. Repeat delivery adds nothing. First and last seen
  follow the evidence, and earlier observations stay visible after a decision.
- Officers **approve**, **clear** or **reopen** an entry, giving a reason and the expected revision. The officer, the time
  and the decision are recorded. Status never changes automatically: new evidence for a cleared entry is recorded and
  flagged for review, without restoring approval.
- While an entry is approved, a new inbound chat whose sender metadata carries that number shows **Watchlist match**,
  with links to the evidence the officer may open. A match is a lead, not an identification, because numbers are shared
  and reassigned. A Telegram user ID, a username or a partial number is never used to match.
- An officer sees an entry when they can open at least one chat holding its evidence or a match. Evidence links are
  filtered per caller. Reviewing an entry, and reading the last decision's reason, needs accessible supporting evidence.

## Telegram

Status: **Ready for controlled test**. `docs/telegram/readiness.json` records `ready_for_controlled_test`, with all eight
local checks passed:

- inbound-first chats are flagged New inbound;
- officer-first chats show both directions;
- every received message has its own capture;
- edits and deletions are separate events;
- redelivered updates create nothing;
- officer-sent fixture messages are labelled outgoing;
- takeover with a composer reply is recorded as Simulated send;
- the live connector refuses to start without its gates.

The controlled test with a real account is **pending**. It needs the account owner's approval of explicitly scoped test
chats, and test credentials. Neither is available, so the live connector stays disabled (`TELEGRAM_LIVE_ENABLED=false`).
Nothing in this repository can mark the connector `Controlled test verified`. That state is reported only from a
controlled-test record written by hand after an approved test.

- Setup for the controlled test: [docs/telegram/setup.md](docs/telegram/setup.md), including the conditions Telegram's
  terms place on handling business messages.
- Rollback: [docs/telegram/rollback.md](docs/telegram/rollback.md).
- Observed event coverage worksheet: [docs/telegram/event-coverage-worksheet.md](docs/telegram/event-coverage-worksheet.md).
- Local readiness results: [docs/telegram/readiness.md](docs/telegram/readiness.md). Fixtures: [docs/telegram/fixtures.md](docs/telegram/fixtures.md).

## WhatsApp gate

Only preparation exists: the shared channel adapter interface, the [data mapping](docs/whatsapp/data-mapping.md), the
[import plan](docs/whatsapp/import-plan.md), and a skipped WhatsApp block in the shared channel contract tests.
WhatsApp-specific work starts only after the Telegram controlled test is verified. Intake refuses `source: "whatsapp"`
with `422 channel_not_enabled`. `MIRSAD_WHATSAPP_IMPORT_ENABLED=true` is itself rejected at startup unless a verified
controlled-test record exists. Meta's Business Messaging Policy excludes law-enforcement use of the WhatsApp Business
Platform, so the planned WhatsApp phase covers labelled fixtures and approved evidence imports through the common intake
API only.

## Local model setup

The default reviewer is **Qwen3.5 9B Q4_K_M**, served by LM Studio's OpenAI-compatible server on loopback. Its model ID
is `qwen3.5-9b`, and it is loaded with a 4,096-token context.

```powershell
lms server start --bind 127.0.0.1 --port 1234
lms load qwen3.5-9b -c 4096 --parallel 4 -y
# Undo:
lms unload qwen3.5-9b
lms server stop
```

| Setting | Default |
|---|---|
| `MIRSAD_REVIEWER` | `lmstudio`; or `deterministic` (offline rules), or `disabled` |
| `MIRSAD_LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` (the host must be `127.0.0.1`, `localhost` or `[::1]`) |
| `MIRSAD_LMSTUDIO_MODEL` | `qwen3.5-9b` |
| `MIRSAD_LMSTUDIO_CONTEXT_TOKENS` | `4096` |
| `MIRSAD_LMSTUDIO_TIMEOUT_MS` | `120000` |

`GET /v1/status` reports `reviewer.reachable`. That is true only when LM Studio lists the configured model as loaded,
because LM Studio answers a request for any model name with whichever model is loaded. To work offline, switch to the
deterministic reviewer:

```powershell
$env:MIRSAD_REVIEWER = "deterministic"
npm run demo
```

### Evaluation results

The held-out evaluation covers the 18 held-out synthetic transcripts (6 Arabic, 6 English, 6 mixed): 55 incoming
messages, reviewed one at a time. The prompt was never tuned on this set. The numbers below are copied from
[heldout-lmstudio-latest.md](docs/evaluation/heldout-lmstudio-latest.md) (generated 2026-11-22T03:44:38.530Z) and
[heldout-deterministic-latest.md](docs/evaluation/heldout-deterministic-latest.md) (2026-11-22T01:33:31.308Z).
[docs/evaluation/README.md](docs/evaluation/README.md) explains every column.

Qwen3.5 9B (`lmstudio`):

| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 55 | 0 | 20 | 3 | 1 | 87.0% | 95.2% | 1 | 5 of 5 | 198 / 242 / 5785 / 6211 |
| Arabic | 19 | 0 | 6 | 1 | 0 | 85.7% | 100.0% | 0 | 2 of 2 | 220 / 244 / 5048 / 5048 |
| English | 18 | 0 | 5 | 1 | 1 | 83.3% | 83.3% | 1 | 1 of 1 | 202 / 241 / 6211 / 6211 |
| Mixed | 18 | 0 | 9 | 1 | 0 | 90.0% | 100.0% | 0 | 2 of 2 | 198 / 234 / 5819 / 5819 |

Deterministic baseline (rules only, no model):

| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 55 | 0 | 13 | 6 | 8 | 68.4% | 61.9% | 0 | 0 of 4 | 0 / 0 / 1 / 3 |
| Arabic | 19 | 0 | 4 | 2 | 2 | 66.7% | 66.7% | 0 | 0 of 1 | 0 / 0 / 3 / 3 |
| English | 18 | 0 | 3 | 2 | 3 | 60.0% | 50.0% | 0 | 0 of 1 | 0 / 0 / 1 / 1 |
| Mixed | 18 | 0 | 6 | 2 | 3 | 75.0% | 66.7% | 0 | 0 of 2 | 0 / 0 / 0 / 0 |

How to read the model's results:

- **Extraction accuracy.** 20 of the 21 expected items were found (recall 95.2%), with 3 extra items (precision 87.0%).
  No review failed.
- **Unsupported findings: 1.** One item in en-05 m2, the callback number that the injected text in the English
  instruction-injection transcript invented, failed validation and was never shown. An unsupported item is not counted
  as an extra item.
- **Where the extra items came from.**
  - Two are quoted third-party numbers (ar-03 m1 and mixed-04 m3). One is a caller's number that a contact reported. The
    other is a neighbour's number, repeated inside an injected note that told the reviewer to report it.
  - The third is the recipient that the injected text in en-05 m2 invented.

  The quoted numbers and the injected recipient passed the exact-quote check because those words really are in the
  message; the injected callback number did not pass validation. The officer always sees the exact quote and its source
  message, so an item like this reads as what it is. The injected text did not stop the model from reporting the real
  payment link in the same message.
- **The one miss** is en-04 m3: a payment recipient the model did not report.
- **Response time.** The median review took 0.24 s. Reviews in which the model reported nothing took 0.2 to 0.3 s;
  reviews in which it reported an item took 2.0 to 6.2 s (p95 5.8 s, maximum 6.2 s).
- **Not evidence of accuracy: the dev-set figures.**
  [docs/evaluation/dev-lmstudio-latest.md](docs/evaluation/dev-lmstudio-latest.md) shows 100% on the 12 dev transcripts
  (37 messages), but the prompt was tuned on that set.
- **Known instability.** Temperature 0 is not fully stable in LM Studio: a borderline item can flip between runs.

## Assumptions

From design section 18:

1. Captures are rendered for every source message event with content, in both directions, and for edits. Composer
   messages get no capture.
2. A different officer may take over a chat another officer controls, with the current revision; the transfer is logged.
   Only the controlling officer can resume a chat from takeover.
3. Dispatch does not restart a paused or officer-controlled chat; those need an explicit resume.
4. `Suspected fraud` is produced only by a rule that compares a payment link's host with an officer-recorded merchant
   confirmation. The model never labels fraud.
5. Review looks at one incoming message at a time. Novelty and "changed destination" are decided in code from details
   already stored for the chat.
6. Phone numbers are normalized only with explicit international format, a country the source gives with sender
   metadata, or the country the reviewer reports from the text for a mentioned number. No default country.
7. Watchlist entries are visible to officers who can open at least one supporting or matching chat; evidence links are
   filtered per caller.
8. The service refuses to bind to anything other than loopback.
9. Git history uses a placeholder author identity because the machine had none configured.
10. Officer-supplied screenshots are not built in this version. The artifact kind is reserved, and every image Mirsad
    shows carries the label `Mirsad-rendered capture`.
11. One finding is raised per new detail. A link that conflicts with a recorded merchant confirmation raises a single
    `Suspected fraud` finding instead of a link note plus a fraud note.
12. A number that cannot be normalized is kept as a lead for the chat that mentioned it and is never merged across chats
    or matched.
13. Event IDs, positions and cursors are workspace-wide sequence numbers, so gaps show that other chats in the workspace
    had activity (not what it was).
14. The dashboard has a light theme and switches to dark with the operating system setting. It uses the system's fonts
    (Segoe UI Variable on Windows) and draws its marks in CSS, because its Content-Security-Policy allows no remote font
    and its stylesheet references no files. The design it follows is on a design canvas, outside the repository.

## Known limits

- **Rendering blocks the service.** Capture rendering runs on the service's main thread. A Telegram-sized message renders
  in about 0.1 s. A crafted 65,536-character host or import message can stall the local service for about 1 to 2 s.
  Before production, render in a worker thread or a separate process.
- **The model is not fully stable.** Temperature 0 is not fully stable in LM Studio.
- **The evaluation does not score country hints.** It normalizes each expected phone number with the country the model
  gave for it, so a number in national format counts as found even when the model gave no country or a wrong one. In
  the service such a number stays a lead that never matches, or, with a wrong country that still parses, becomes a
  different number.
- **Hidden Telegram links are not captured.** The text is stored exactly as shown. A formatted link, a button, a
  forward and content of an unknown kind are listed as unsupported content (`text_link`, `inline_keyboard`,
  `forwarded`, `other`), which the capture and the timeline show. The URL behind formatted text or a button is not
  stored, so neither the model nor the **Suspected fraud** rule sees it. An edit carries no such list: an edit that
  changes only a hidden URL looks unchanged, and an edit that removes all text gets no capture.
- **A retried review can say "New" instead of "changed".** This happens when a later message repeated the old
  destination before the earlier review was retried.
- **Fictional UK numbers count as valid.** `normalizePhone` treats the reserved fictional UK range `+44 7700 900000` to
  `900999` as valid, so that synthetic data can match. No real subscriber holds these numbers.
- **No officer-supplied screenshots.** Every image is a Mirsad-rendered capture.
- **Captures are reproducible per platform only.** The same input gives byte-identical captures on one platform and
  library version. The text SHA-256 on each capture is the integrity anchor. Characters outside the bundled Noto fonts
  fall back to system fonts.

## Security notes

- **Loopback only.** The service refuses to start on any host other than `127.0.0.1`, `localhost` or `::1`. A request
  whose `Host` header is not a loopback name with the bound port gets `403 host_not_allowed`, which guards against DNS
  rebinding. No CORS headers are sent. A real deployment puts an authenticated gateway in front (see
  [docs/deployment-notes.md](docs/deployment-notes.md)).
- **Tokens.**
  - Tokens are random, 32 bytes, and stored only as SHA-256 hashes.
  - They travel only in the `Authorization` header. A token in a query string is ignored.
  - The sign-in links from `npm run demo:credentials` carry the token in the URL fragment (`#token=`), which the browser
    never sends to the server. The dashboard reads it once, removes it from the address bar and history, and keeps it in
    `sessionStorage` for that tab.
  - `data/`, `.env`, `demo-credentials.json` and `telegram-live-credentials.json` are git-ignored, and `.env.example`
    holds names only.
- **Limits.** Requests are limited to 600 a minute per token. Bodies are limited to 256 KiB, or 1 MiB on the two intake
  routes. Message text is limited to 65,536 characters.
- **Logs.** Logs are JSON lines holding IDs, codes, counts and durations. Message text, quotes, extracted values, phone
  numbers, display names and tokens are never logged; a test checks this with a canary string. Stream event data
  likewise carries only IDs and statuses.
- **Dashboard.** It is served with `Content-Security-Policy: default-src 'self'; img-src 'self' blob:; style-src 'self';
  script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`. It has no inline script and no remote
  assets, and it renders all text with `textContent`. Every response also carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (`private, no-store` on
  artifacts).
- **Evidence integrity.**
  - Captures draw text as plain text. Markup is shown literally, and bidi and control characters appear as visible
    tokens such as `[U+202E]`.
  - Artifact files are written atomically, and their SHA-256 is checked on every read. A mismatch answers
    `500 artifact_integrity_error` and never the bytes.
  - SQLite runs in WAL mode with `synchronous = FULL`, so a commit is on disk before Mirsad answers. Each evidence file
    is flushed to disk before it is renamed into place and counts as stored; its directory is flushed after the rename
    where the platform allows it (Node cannot on Windows).
  - Original message text is never updated or deleted.
- **No sending.** No code path sends a message to Telegram or WhatsApp. The Telegram Bot API client has four read-only
  calls.
- **Not yet protected:** data at rest. Encryption and key custody belong to the approved environment.

## Repository layout

```
src/
  main.ts, app.ts, config.ts   process entry, composition root, configuration (loopback only)
  contract/      zod schemas, enums, exact labels, error codes, stream event types, OpenAPI builder
  ports/         small interfaces: clock, evidence store, capture renderer, reviewer, identity, channel adapter, logger
  domain/        pure rules: control machine, initiation, text safety, phones, links, cues, finding validation, review policy
  storage/       SQLite (node:sqlite) schema and repositories, local evidence store
  services/      use cases: intake, chats, dispatch, control, officer actions, timeline, artifacts, watchlist, status, stream
  workers/       job loop, capture worker, review worker
  capture/       Mirsad-rendered capture renderer (@napi-rs/canvas) and PNG provenance metadata
  review/        deterministic and LM Studio reviewers, prompt, publishing rules, evaluation metrics
  identity/      demo identity (bearer tokens), provisioning, demo seed
  http/          server, middleware, one route file per group
  adapters/      fixture replay; Telegram types, fixture schema, normalizer, read-only Bot API client, live connector
  dashboard/     reference dashboard: static HTML, CSS and ES modules, a client of the API and the event stream
scripts/         replay, demo walkthrough and credentials, OpenAPI generation, model evaluation, Telegram verify/readiness/provision
examples/headless-client/   HTTP-only integration example
fixtures/telegram/          synthetic Telegram-shaped updates
fixtures/eval/              labelled synthetic evaluation transcripts (dev and held-out)
assets/fonts/               Noto fonts for captures (SIL Open Font License 1.1)
docs/                       telegram/, whatsapp/, evaluation/, deployment-notes.md, superpowers/ (brief, design notes, plan)
tests/                      unit/, integration/, contract/, e2e/, helpers/
openapi.yaml                the generated HTTP contract
```

All data in fixtures, tests, examples and documents is synthetic. Domains end in `.test` or use `example.*`. Phone
numbers come only from the reserved fictional ranges `+44 7700 900000`–`900999` and `+1 <area> 555 0100`–`0199`.
