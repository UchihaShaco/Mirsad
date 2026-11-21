# Mirsad design notes

Technical decisions for the first working version. The brief (`2026-11-21-mirsad-brief.md`) is the binding scope; this file records the calls made on top of it so every implementer builds the same system. Section numbers are stable: task briefs refer to them. Where this file abbreviates a function name or signature, the plan's task sections are authoritative.

Contents: 1 Stack · 2 Layout · 3 Identity and access · 4 Data model · 5 API conventions · 6 Routes and payloads · 7 Intake rules · 8 Control state machine · 9 Captures · 10 Review pipeline · 11 Watchlist · 12 Event stream · 13 Telegram · 14 WhatsApp gate · 15 Config · 16 Logging · 17 Test harness · 18 Assumptions for the README

## 1. Stack

- Node.js 24 (developed on 24.18), TypeScript strict, ESM (`"type": "module"`). Source runs through `tsx`; there is no build step. `npm run typecheck` runs `tsc --noEmit`.
- HTTP: Hono with `@hono/node-server`. Validation and the API contract: zod v4. `openapi.yaml` is generated from the zod schemas and committed; a test fails when it is stale.
- Storage: SQLite in one file under the data directory, plus a private evidence directory for image files. Driver choice is recorded in section 19.
- Tests: vitest. Integration tests start the real service in-process on `127.0.0.1` with an ephemeral port and call it through `fetch`.
- Capture renderer and phone library: see section 19.
- Dashboard: static HTML, CSS and ES modules served by the service. No framework, no CDN, no inline script.

## 2. Layout

```
src/
  main.ts                 process entry: load config, create app, listen, handle signals
  config.ts               loadConfig(env) -> Config; rejects non-loopback hosts
  app.ts                  createApp(options) -> App (composition root)
  contract/               zod schemas, enums, error codes, stream event types, OpenAPI builder
  ports/                  small interfaces: clock, evidence-store, capture-renderer, reviewer, identity, channel-adapter, logger
  domain/                 pure rules, no IO: control machine, initiation, text safety, phone, finding validation, case details, review policy
  storage/                db.ts (open, migrate, transaction helper), schema.sql, repos/, local-evidence-store.ts
  services/               use cases, one transaction each: intake, chats, dispatch, control, officer, timeline, artifacts, case-references, watchlist, status, stream
  workers/                job loop, capture-worker, review-worker
  capture/                renderer implementation, png-metadata
  review/                 deterministic-reviewer, lmstudio-reviewer, prompt, publish, reviewer-factory
  identity/               demo-identity (bearer tokens), demo seed
  http/                   server.ts, middleware/, routes/ (one file per route group)
  adapters/telegram/      types, normalize, live-connector, verify
  dashboard/              static assets
fixtures/telegram/        Telegram-shaped synthetic updates          fixtures/eval/      model evaluation transcripts
scripts/                  seed, replay, walkthrough, openapi, eval, telegram verify/readiness
examples/headless-client/ HTTP-only integration example
tests/                    helpers/, unit/, integration/, contract/, e2e/
docs/                     telegram/, whatsapp/, evaluation/, superpowers/
```

Files stay focused (aim for under 300 lines; 800 is the ceiling). Functions stay under 50 lines. Domain functions return new values instead of mutating their inputs.

## 3. Identity and access

- `IdentityProvider.authenticate(authorizationHeader) -> Principal | null`. The demo adapter maps `Authorization: Bearer <token>` to a row in `principals` by SHA-256 of the token. A host platform replaces this adapter with its own login.
- Two kinds of principal. **Officer**: uses every route except intake. **Connector**: the separate ingestion credential; it may call only `POST /v1/ingest` and `POST /v1/chats/{chatId}/events`. A connector carries a fixed `captureMethod` and a `trustedStartMarker` flag set at provisioning. Callers cannot override provenance in the payload.
- A `channel_account` is one authorized channel account (`source` + `externalAccountId`) inside a workspace. `account_grants` lists which principals may use it. This is the single access rule:
  - `canAccessChat(principal, chat)`: same workspace AND the principal has a grant on the chat's channel account.
  - Timeline, artifacts, control, composer, decisions, captures, case references, the chat list and chat-scoped stream events all use `canAccessChat`. A chat the caller cannot access is answered exactly like a chat that does not exist: `404 chat_not_found`.
  - A connector may ingest only for accounts it has a grant on; otherwise `403 account_not_authorized`.
  - Registering a chat (`POST /v1/chats`) requires the officer's grant on the named account; otherwise `404 account_not_found`.
  - A disabled principal is refused at authentication, and an open event stream ends at its next batch.
- Watchlist access (section 11) derives from chat access.
- Internal IDs (`chat_…`, `msg_…`) are used for authorization. The host's conversation ID is stored only as the `externalChatId` mapping.

## 4. Data model

All timestamps are ISO-8601 UTC with milliseconds (`2026-11-21T08:00:00.000Z`). IDs are `<prefix>_<32 hex>` from `crypto.randomUUID()`. Prefixes: `ws`, `prn`, `acct`, `chat`, `msg`, `mev`, `cap`, `art`, `rev`, `fnd`, `det`, `cref`, `act`, `dsp`, `wle`, `wob`, `wrv`, `wmt`.

`position` columns hold the workspace stream sequence number issued when the row was created (section 12); they give one stable order across tables.

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  stream_seq INTEGER NOT NULL DEFAULT 0,      -- last issued stream sequence
  stream_floor INTEGER NOT NULL DEFAULT 0,    -- sequences <= floor were pruned
  created_at TEXT NOT NULL
);
CREATE TABLE principals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('officer','connector')),
  display_name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE,
  capture_method TEXT CHECK (capture_method IN ('fixture_replay','telegram_business_live','approved_import','host_intake')),
  trusted_start_marker INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE channel_accounts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL CHECK (source IN ('telegram','whatsapp')),
  external_account_id TEXT NOT NULL, label TEXT NOT NULL,
  is_intake INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source, external_account_id)
);
CREATE TABLE account_grants (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id),
  PRIMARY KEY (principal_id, channel_account_id)
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id),
  external_chat_id TEXT NOT NULL, display_label TEXT NOT NULL,
  created_via TEXT NOT NULL CHECK (created_via IN ('ingest','register')),
  created_by TEXT NOT NULL REFERENCES principals(id),
  inbox_status TEXT NOT NULL CHECK (inbox_status IN ('new_inbound','open')),
  ai_mode TEXT NOT NULL CHECK (ai_mode IN ('not_started','ai_active','paused','officer_control')),
  revision INTEGER NOT NULL DEFAULT 1,
  controller_id TEXT REFERENCES principals(id),
  first_observed_direction TEXT CHECK (first_observed_direction IN ('incoming','outgoing')),
  initiated_by TEXT NOT NULL DEFAULT 'unknown' CHECK (initiated_by IN ('contact','officer','unknown')),
  initiation_basis TEXT CHECK (initiation_basis IN ('source_start_marker','confirmed_complete_history')),
  contact_external_id TEXT, contact_display_name TEXT, contact_phone_raw TEXT, contact_phone_e164 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, channel_account_id, external_chat_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('incoming','outgoing')),          -- NULL only when original_captured = 0 and the source gave no direction
  origin TEXT NOT NULL CHECK (origin IN ('source','officer_composer')),
  source_message_id TEXT,                                               -- NULL for composer messages
  original_captured INTEGER NOT NULL DEFAULT 1,                         -- 0: first seen through an edit or deletion
  text TEXT, text_sha256 TEXT,                                          -- original text, never overwritten
  unsupported_content TEXT NOT NULL DEFAULT '[]',                       -- JSON array of content kinds not captured
  sent_at TEXT, received_at TEXT NOT NULL,
  capture_method TEXT NOT NULL,                                         -- connector's method, or 'officer_composer'
  sender_external_id TEXT, sender_display_name TEXT, sender_phone_raw TEXT,
  author_officer_id TEXT REFERENCES principals(id),
  send_status TEXT CHECK (send_status IN ('simulated')),
  edited_at_source INTEGER NOT NULL DEFAULT 0, deleted_at_source INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_source_message ON messages(chat_id, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE TABLE message_events (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  type TEXT NOT NULL CHECK (type IN ('recorded','edited','deleted','conflicting_copy')),
  source_event_id TEXT,                                                 -- NULL for composer messages
  text TEXT, text_sha256 TEXT,                                          -- text carried by a recorded or edited event
  source_occurred_at TEXT, received_at TEXT NOT NULL,
  capture_method TEXT NOT NULL, connector_id TEXT REFERENCES principals(id),
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX message_events_source_event ON message_events(chat_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mirsad_rendered_capture','officer_supplied_screenshot')),
  media_type TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE captures (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL UNIQUE REFERENCES message_events(id),
  status TEXT NOT NULL CHECK (status IN ('pending','rendering','ready','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
  artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL UNIQUE REFERENCES message_events(id),
  status TEXT NOT NULL CHECK (status IN ('not_requested','pending','running','completed','unavailable','stale_discarded','not_permitted')),
  outcome TEXT CHECK (outcome IN ('no_new_finding','findings')),
  requested_revision INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
  reviewer TEXT, unsupported_count INTEGER NOT NULL DEFAULT 0, suppressed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE case_references (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  kind TEXT NOT NULL CHECK (kind IN ('merchant_payment_confirmation')),
  payment_hosts TEXT NOT NULL,                                          -- JSON array of lower-case hostnames
  source_note TEXT NOT NULL, recorded_by TEXT NOT NULL REFERENCES principals(id),
  recorded_at TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE case_details (                                             -- what each chat has already surfaced
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  category TEXT NOT NULL CHECK (category IN ('payment_link','payment_recipient','phone_number')),
  normalized_value TEXT NOT NULL, display_value TEXT NOT NULL,          -- display_value: the value as first written
  first_message_id TEXT NOT NULL, last_seen_position INTEGER NOT NULL,  -- position of the latest message event that carried it
  created_at TEXT NOT NULL,
  UNIQUE (chat_id, category, normalized_value)
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  review_id TEXT REFERENCES reviews(id),                                -- NULL for a rule finding raised by a case reference
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL REFERENCES message_events(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment_link','payment_recipient','phone_number','suspected_fraud')),
  quote TEXT NOT NULL, extracted_value TEXT NOT NULL, normalized_value TEXT NOT NULL,
  concern TEXT, changed_from TEXT, case_reference_id TEXT REFERENCES case_references(id),
  note TEXT NOT NULL, created_at TEXT NOT NULL, position INTEGER NOT NULL,
  UNIQUE (message_event_id, kind, normalized_value)
);
CREATE TABLE case_actions (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  type TEXT NOT NULL, actor_id TEXT REFERENCES principals(id), message_id TEXT REFERENCES messages(id),
  from_mode TEXT, to_mode TEXT, revision INTEGER,
  detail TEXT,                                                          -- JSON of ids and codes, never message text
  occurred_at TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE stream_events (
  workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  chat_id TEXT, watchlist_entry_id TEXT,
  data TEXT NOT NULL,                                                   -- JSON of ids and statuses only
  occurred_at TEXT NOT NULL, PRIMARY KEY (workspace_id, seq)
);
CREATE TABLE idempotency_keys (
  principal_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL, status_code INTEGER NOT NULL, response_body TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (principal_id, scope, key)
);
CREATE TABLE watchlist_entries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  match_key TEXT NOT NULL,                                              -- E.164, or 'unnormalized:<chatId>:<digits>'
  e164 TEXT, display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('needs_review','approved','cleared')),
  revision INTEGER NOT NULL DEFAULT 1, new_evidence_since_review INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, match_key)
);
CREATE TABLE watchlist_observations (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES watchlist_entries(id), workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id), message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL REFERENCES message_events(id), finding_id TEXT REFERENCES findings(id),
  origin TEXT NOT NULL CHECK (origin IN ('sender_metadata','message_mention')),
  source_representation TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL,
  UNIQUE (entry_id, message_event_id, origin)
);
CREATE TABLE watchlist_reviews (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES watchlist_entries(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','clear','reopen')),
  reason TEXT NOT NULL, officer_id TEXT NOT NULL REFERENCES principals(id),
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, revision INTEGER NOT NULL, decided_at TEXT NOT NULL
);
CREATE TABLE watchlist_matches (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES watchlist_entries(id), chat_id TEXT NOT NULL REFERENCES chats(id),
  matched_e164 TEXT NOT NULL, source_representation TEXT NOT NULL, matched_at TEXT NOT NULL,
  UNIQUE (entry_id, chat_id)
);
CREATE TABLE connector_state (
  connector_id TEXT NOT NULL REFERENCES principals(id), key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (connector_id, key)
);
```

The database runs with `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`. Every use case that writes runs in one `BEGIN IMMEDIATE` transaction. Message text, once set, is never changed or deleted by any code path; the only write to an existing message's text is filling a placeholder's empty text once, from the original `recorded` event.

## 5. API conventions

- JSON, camelCase. Every JSON response uses one envelope:
  - success: `{ "success": true, "data": { … }, "error": null }` (lists add `"meta": { "total", "limit", "offset" }`)
  - failure: `{ "success": false, "data": null, "error": { "code": "…", "message": "…", "details": { … } } }`
  - The artifact route (binary) and the event stream (SSE) are the two exceptions.
- Auth: `Authorization: Bearer <token>`. Missing or unknown token: `401 unauthenticated`. Wrong kind of principal for a route: `403 forbidden_for_principal`.
- Error codes and statuses: `400 validation_failed` (details list the fields), `400 idempotency_key_required`, `401 unauthenticated`, `403 forbidden_for_principal`, `403 account_not_authorized`, `403 not_controller`, `403 evidence_access_required`, `403 host_not_allowed`, `404 chat_not_found`, `404 account_not_found`, `404 message_not_found`, `404 artifact_not_found`, `404 capture_not_found`, `404 watchlist_entry_not_found`, `404 not_found`, `409 revision_conflict` (details: `currentRevision`, `aiMode`), `409 invalid_transition`, `409 not_in_takeover`, `409 capture_not_retryable`, `413 payload_too_large`, `422 idempotency_key_reused`, `422 channel_not_enabled`, `422 direction_required`, `429 rate_limited`, `500 internal_error`, `500 artifact_integrity_error`, `501 not_implemented` (only while a route is still a stub).
- `Idempotency-Key` (required on `POST /v1/dispatches` and `POST /v1/chats/{chatId}/officer-messages`): scoped to principal + route (+ chat). Same key and same body replays the stored response with header `Idempotency-Replayed: true`. Same key with a different body: `422 idempotency_key_reused`. The key is stored in the same transaction as the effect.
- Middleware order: security headers (outermost, so rejections carry them too) → host guard (the `Host` header must be `127.0.0.1`, `localhost` or `[::1]` with the bound port, else `403 host_not_allowed`) → rate limit (in-memory, per token, default 600 requests a minute) → body limit (256 KiB; 1 MiB on the two intake routes) → auth → route → error handler. No CORS headers are sent. Tokens are read only from the `Authorization` header; a token in the query string is ignored.
- Text limits: message text up to 65,536 characters; labels up to 200; reasons 3 to 500.

## 6. Routes and payloads

`O` = officer token, `C` = connector token. Routes marked *extension* are not in the brief's table; each exists because a brief requirement cannot be met without it, and the README says so.

| Route | Who | Request | Success `data` |
|---|---|---|---|
| `POST /v1/chats` | O | `{ source, externalAccountId, externalChatId, displayLabel }` | `201` new or `200` existing: `{ chat: ChatSummary, created }` |
| `GET /v1/chats` | O | query `inboxStatus?`, `limit?` (default 100, max 500), `offset?` | `{ chats: ChatSummary[], cursor }` + `meta` |
| `POST /v1/ingest` | C | `{ source, externalAccountId, externalChatId, chat?: { displayLabel? }, event: IntakeEvent }` | `201` recorded or `200` duplicate: `IngestResult` |
| `POST /v1/chats/{chatId}/events` | C | `IntakeEvent` | same as ingest |
| `POST /v1/dispatches` | O + `Idempotency-Key` | `{ chatIds: string[] }` (1 to 100, unique) | `{ dispatchId, results: [{ chatId, status, aiMode, revision }] }` |
| `POST /v1/chats/{chatId}/control` | O | `{ action: 'pause'|'take_over'|'resume', expectedRevision }` | `{ chat: ChatSummary, changedAt }` |
| `POST /v1/chats/{chatId}/officer-messages` | O + `Idempotency-Key` | `{ text, expectedRevision }` | `201 { message: Message }` |
| `POST /v1/chats/{chatId}/officer-decisions` | O | `{ decision: 'leave_unanswered', messageId, expectedRevision }` | `201` new or `200` existing: `{ caseAction: CaseAction, created }` |
| `GET /v1/chats/{chatId}/timeline` | O | | `Timeline` |
| `GET /v1/artifacts/{artifactId}` | O | | PNG bytes |
| `GET /v1/events` | O | query `cursor?`, header `Last-Event-ID?` | SSE (section 12) |
| `GET /v1/watchlist` | O | | `{ entries: WatchlistEntry[], cursor }` |
| `POST /v1/watchlist/{entryId}/review` | O | `{ decision: 'approve'|'clear'|'reopen', reason, expectedRevision }` | `{ entry: WatchlistEntry }` |
| `POST /v1/chats/{chatId}/case-references` *(extension)* | O | `{ kind: 'merchant_payment_confirmation', paymentHosts: string[], sourceNote }` | `201 { caseReference, findingsCreated }` |
| `POST /v1/captures/{captureId}/retry` *(extension)* | O | none | `{ capture: Capture }` |
| `GET /v1/me` *(extension)* | O or C | | `{ principal: { id, kind, displayName, workspaceId } }` |
| `GET /v1/status` *(extension)* | O | | `Status` (section 13) |
| `GET /healthz` *(extension)* | none | | `{ status: 'ok' }` |
| `GET /`, `GET /assets/*` | none | | dashboard static files |

Shared shapes (TypeScript notation; all fields required unless marked `?`; `| null` means the key is always present):

```ts
type Source = 'telegram' | 'whatsapp';
type CaptureMethod = 'fixture_replay' | 'telegram_business_live' | 'approved_import' | 'host_intake' | 'officer_composer';
type Direction = 'incoming' | 'outgoing';
type AiMode = 'not_started' | 'ai_active' | 'paused' | 'officer_control';
type PrincipalRef = { id: string; displayName: string };

type IntakeEvent =
  | { type: 'message.recorded'; sourceEventId: string; sourceMessageId: string; direction: Direction; text: string;
      sentAt?: string; sender?: { externalId?: string; displayName?: string; phone?: { raw: string; country?: string; internationalFormat?: boolean } };
      conversationStart?: { basis: 'source_start_marker' | 'confirmed_complete_history' }; unsupportedContent?: string[] }
  | { type: 'message.edited'; sourceEventId: string; sourceMessageId: string; text: string; editedAt?: string; direction?: Direction }
  | { type: 'message.deleted'; sourceEventId: string; sourceMessageId: string; deletedAt?: string; direction?: Direction };

type IngestResult = { chatId: string; chatCreated: boolean; result: 'recorded' | 'duplicate_event' | 'duplicate_message' | 'conflicting_copy';
  messageId: string; messageEventId: string | null; receivedAt: string | null; captureId: string | null;
  startMarker: 'accepted' | 'ignored_untrusted' | 'ignored_conflict' | 'none'; textConflict: boolean };

type ChatSummary = { id: string; source: Source; channelLabel: 'Telegram' | 'WhatsApp'; externalAccountId: string; externalChatId: string;
  displayLabel: string; inboxStatus: 'new_inbound' | 'open'; aiMode: AiMode; revision: number; controller: PrincipalRef | null;
  originLabel: 'Contact started chat' | 'Officer started chat' | 'First observed: incoming' | 'First observed: outgoing' | 'No messages observed';
  initiatedBy: 'contact' | 'officer' | 'unknown'; initiationBasis: 'source_start_marker' | 'confirmed_complete_history' | null;
  firstObservedDirection: Direction | null; intakeAccount: boolean; acknowledgementTemplate: string | null;   // 'Message received.' on intake accounts
  review: { state: 'idle' | 'active' | 'unavailable'; pending: number; unavailable: number };
  watchlistMatches: { entryId: string; numberDisplay: string; matchedAt: string; evidence: EvidenceRef[]; restrictedEvidence: boolean }[];
  messageCount: number; lastActivityAt: string; createdAt: string };

type Capture = { id: string; status: 'pending' | 'rendering' | 'ready' | 'failed'; kind: 'mirsad_rendered_capture';
  artifactId: string | null; sha256: string | null; attempts: number; errorCode: string | null; retryable: boolean; updatedAt: string };
type ReviewState = { status: 'not_requested' | 'pending' | 'running' | 'completed' | 'unavailable' | 'stale_discarded' | 'not_permitted';
  outcome: 'no_new_finding' | 'findings' | null; updatedAt: string };

type Message = { id: string; chatId: string; direction: Direction | null; origin: 'source' | 'officer_composer';
  text: string | null; originalCaptured: boolean; unsupportedContent: string[]; sentAt: string | null; receivedAt: string;
  source: { channel: Source; captureMethod: CaptureMethod; sourceEventId: string | null; sourceMessageId: string | null };
  sender: { externalId: string | null; displayName: string | null } | null;
  author: PrincipalRef | null; sendStatus: 'simulated' | null; sendStatusLabel: 'Simulated send' | null;
  capture: Capture | null;        // null: not applicable (composer message, or placeholder without text)
  review: ReviewState | null;     // null: not applicable (outgoing or composer message)
  editedAtSource: boolean; deletedAtSource: boolean; position: number };
type MessageEvent = { id: string; chatId: string; messageId: string; type: 'edited' | 'deleted' | 'conflicting_copy'; text: string | null;
  sourceEventId: string; sourceOccurredAt: string | null; receivedAt: string; captureMethod: CaptureMethod;
  capture: Capture | null; review: ReviewState | null; position: number };
type CaseAction = { id: string; chatId: string; type: 'chat_registered' | 'dispatch_started' | 'control_pause' | 'control_take_over' | 'control_resume'
  | 'leave_unanswered' | 'officer_message_sent' | 'case_reference_recorded' | 'capture_retry_requested' | 'watchlist_match' | 'text_conflict_recorded';
  actor: PrincipalRef | null; messageId: string | null; fromMode: AiMode | null; toMode: AiMode | null; revision: number | null;
  detail: Record<string, string | number | boolean | null> | null; occurredAt: string; position: number };
type Finding = { id: string; chatId: string; messageId: string; messageEventId: string;
  kind: 'payment_link' | 'payment_recipient' | 'phone_number' | 'suspected_fraud';
  label: 'New payment link' | 'New payment recipient' | 'Payment destination changed' | 'Phone number tied to a concern' | 'Suspected fraud';
  quote: string; extractedValue: string; concern: 'payment_request' | 'callback_request' | 'credential_request' | 'other_concern' | null;
  changedFrom: string | null; caseReferenceId: string | null; note: string; createdAt: string; position: number };
type CaseReference = { id: string; chatId: string; kind: 'merchant_payment_confirmation'; paymentHosts: string[]; sourceNote: string;
  recordedBy: PrincipalRef; recordedAt: string };
type Timeline = { chat: ChatSummary; messages: Message[]; messageEvents: MessageEvent[]; caseActions: CaseAction[];
  findings: Finding[]; caseReferences: CaseReference[]; cursor: string };

type EvidenceRef = { observationId: string; chatId: string; messageId: string; messageEventId: string; findingId: string | null;
  origin: 'sender_metadata' | 'message_mention'; sourceRepresentation: string; reason: string; observedAt: string };
type WatchlistEntry = { id: string; number: { e164: string | null; display: string; exactMatchEligible: boolean };
  status: 'needs_review' | 'approved' | 'cleared'; statusLabel: 'Needs review' | 'Approved' | 'Cleared'; revision: number;
  newEvidenceSinceReview: boolean; firstSeenAt: string; lastSeenAt: string;
  evidence: EvidenceRef[]; restrictedEvidence: boolean; matches: { chatId: string; matchedAt: string }[];
  lastDecision: { decision: 'approve' | 'clear' | 'reopen'; reason: string | null; officer: PrincipalRef; decidedAt: string } | null; canReview: boolean };
```

Arrays in `Timeline` are ordered by `position`. `cursor` is the workspace's latest stream sequence, read in the same transaction as the snapshot; it is an opaque decimal string.

Artifact responses carry `Content-Type: image/png`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<artifactId>.png"` and `X-Mirsad-SHA256`. The file's checksum is verified on every read; a mismatch returns `500 artifact_integrity_error` and never the bytes.

## 7. Intake rules

`POST /v1/ingest` and `POST /v1/chats/{chatId}/events` call one function, `intake.ingest(connector, target, event)`, inside one transaction:

1. Resolve the channel account in the connector's workspace and check the grant (section 3). `source: 'whatsapp'` is refused with `422 channel_not_enabled` unless the gate in section 14 is open.
2. Find or create the chat. A new chat gets `ai_mode = 'not_started'`, `created_via = 'ingest'`, label from `chat.displayLabel`, else the sender's display name, else `"<Channel> chat <externalChatId>"`. It enters `new_inbound` exactly when the event's direction is `incoming`; otherwise `open`. A `chat.created` stream event is published.
3. If an event with the same `sourceEventId` already exists in the chat: return `duplicate_event` and change nothing.
4. `message.recorded`:
   - no message with this `sourceMessageId`: insert the message and its `recorded` event, a `captures` row with status `pending` (same transaction: text and pending screenshot work are saved together), and for incoming messages a `reviews` row (section 10).
   - a placeholder exists (`original_captured = 0`): fill in the original text and direction, set `original_captured = 1`, then proceed as above.
   - a captured message exists with the same text hash: return `duplicate_message` and change nothing.
   - a captured message exists with a different text hash: the differing text is evidence too. Insert a `conflicting_copy` event carrying it (with its own `captures` row and, for incoming messages, `reviews` row), record a `text_conflict_recorded` case action, publish `message.conflicting_copy`, leave the original text untouched, and return `conflicting_copy` with `textConflict: true`.
5. `message.edited`: find the message, or create a placeholder (`original_captured = 0`, `text = NULL`; `direction` from the event is required for a placeholder, else `422 direction_required`). Insert an `edited` event carrying the new text, set `edited_at_source = 1`, add a `captures` row for the edit and, for incoming messages, a `reviews` row. The original text is untouched.
6. `message.deleted`: find the message or create a placeholder (direction may stay NULL). Insert a `deleted` event and set `deleted_at_source = 1`. Text, captures and findings already stored remain.
7. `receivedAt` is always the server clock. `sentAt`, `editedAt` and `deletedAt` come from the source and are stored as given (normalized to UTC).
8. Chat bookkeeping: `first_observed_direction` is set once, from the first event that carries a direction. Each contact field (`contact_external_id`, `contact_display_name`, `contact_phone_raw`) is filled independently, the first time an incoming message carries it while that field is still empty. When the phone is first stored, intake calls `watchlist.onContactPhoneKnown` (section 11), which normalizes it and stores `contact_phone_e164`.
9. Initiation: `conversationStart` is honoured only on `message.recorded` from a connector with `trustedStartMarker`, only while `initiated_by = 'unknown'`, and only when the marked message is the first source message stored for the chat, or it has a `sentAt` and every other stored source message has a later one. Then `initiated_by` becomes `contact` (incoming) or `officer` (outgoing) with the given basis. Otherwise the marker is ignored and the response says why. Nothing else ever sets `initiated_by`.
10. When an incoming message is stored in an `ai_active` chat, intake calls `requeueRetryableReviews` (section 10). After commit the capture and review workers are woken.
11. Registering a new chat through `POST /v1/chats` publishes `chat.created` (inbox status `open`) and records a `chat_registered` case action. Registering an existing chat changes nothing and returns it.

`originLabel`: `Contact started chat` / `Officer started chat` when `initiatedBy` is known; else `First observed: incoming` / `First observed: outgoing`; `No messages observed` for a registered chat with no events.

## 8. Control state machine

A pure function `transition(state, action, actorId)` in `src/domain/control-machine.ts`:

| From | `pause` | `take_over` | `resume` | dispatch |
|---|---|---|---|---|
| `not_started` | `invalid_transition` | → `officer_control` (actor) | `invalid_transition` | → `ai_active` (`started`) |
| `ai_active` | → `paused` | → `officer_control` (actor) | `invalid_transition` | no change (`already_active`) |
| `paused` | `invalid_transition` | → `officer_control` (actor) | → `ai_active` | no change (`requires_resume`) |
| `officer_control` by actor | `invalid_transition` | `invalid_transition` | → `ai_active` | no change (`requires_resume`) |
| `officer_control` by another officer | `invalid_transition` | → `officer_control` (actor) | `403 not_controller` | no change (`requires_resume`) |

Every change, including a dispatch that starts a chat: `revision + 1`, `inbox_status = 'open'`, a `case_actions` row with operator and time, a `chat.control_changed` stream event. Entering `ai_active` queues reviews (section 10). One helper, `applyModeChange` in `src/services/mode-change.ts`, performs these steps for dispatch and for control actions. `expectedRevision` must equal the current revision, else `409 revision_conflict`.

Dispatch (`POST /v1/dispatches`): first resolve every `chatId` with `canAccessChat`; if any is missing or inaccessible return `404 chat_not_found` with `details.chatIds` and change nothing. Then apply the dispatch column to each chat in one transaction and record `dispatch_started` for the chats that started.

Composer (`POST …/officer-messages`), checked in this order: chat access (404) → body (400) → idempotent replay → `ai_mode = 'officer_control'` else `409 not_in_takeover` → caller is the controller else `403 not_controller` → revision else `409 revision_conflict`. It inserts one outgoing message (`origin = 'officer_composer'`, `capture_method = 'officer_composer'`, `send_status = 'simulated'`, author set), a `recorded` event without capture or review, an `officer_message_sent` case action and a `message.recorded` stream event. Nothing is delivered to any channel; there is no code path that sends to Telegram or WhatsApp.

Decision (`POST …/officer-decisions`): same takeover checks; `messageId` must be an incoming message of this chat (`404 message_not_found`). Inserts only a `leave_unanswered` case action. A repeat for the same message returns the existing action with `200` and `created: false`. The chat stays open and capture continues.

## 9. Captures

- A capture is a PNG rendered by Mirsad from the saved record. Every source message event that carries text or unsupported content (`recorded`, `edited`, `conflicting_copy`; both directions) gets one. Composer messages do not: they are Mirsad's own record, not source evidence.
- `CaptureRenderer.render(input) -> Promise<Uint8Array>` is a pure function of its input (no clock, no network). The image shows: the label "Mirsad-rendered capture", channel, capture method, chat label and chat ID, message ID, event type, direction, sender label, received time, sent time, the text, and the text's SHA-256. Text is drawn as plain text. Markup is shown literally. Bidi control characters (U+202A–U+202E, U+2066–U+2069) and other control characters except newline and tab are drawn as visible tokens such as `[U+202E]`. Only local font files are used. Every string drawn on a capture (chat label, sender label and IDs as well as the text) passes through the same `toDisplayText` step.
- PNG `tEXt` chunks carry provenance: `Mirsad-Capture-Kind`, `Mirsad-Chat-Id`, `Mirsad-Message-Id`, `Mirsad-Message-Event-Id`, `Mirsad-Received-At`, `Mirsad-Text-SHA256`.
- Capture worker: claim the oldest `pending` capture (`status = 'rendering'`, `attempts + 1`), load its own message event from the database by capture ID, render, `EvidenceStore.put('captures/<workspaceId>/<chatId>/<captureId>.png', bytes)`, then in one transaction insert the artifact (kind `mirsad_rendered_capture`, SHA-256, size) and set the capture `ready`. On any error set `failed` with an error code (`render_failed`, `storage_failed`); the message is untouched. Publish `capture.updated` either way.
- Retry: `POST /v1/captures/{captureId}/retry` moves `failed` → `pending` (else `409 capture_not_retryable`), records `capture_retry_requested`, wakes the worker. Rendering twice writes the same storage key, so a retry yields exactly one linked image.
- On startup, captures left in `rendering` go back to `pending`.
- `EvidenceStore` writes atomically (temp file then rename) under `<dataDir>/evidence/`. Keys are built only from server-generated IDs.

## 10. Review pipeline

Evidence capture never waits for review. The reviewer extracts; code decides.

**Rows and policy**

- A `reviews` row is created at intake for every incoming source event with text (`recorded`, `edited`, `conflicting_copy`). Initial status: `not_permitted` when policy forbids review; else `pending` when the chat is `ai_active`; else `not_requested`.
- Policy (`src/domain/review-policy.ts`): `isReviewPermitted(source, captureMethod, allowed)`, always called with the reviewed event's own capture method. `telegram_business_live` is never reviewable. Content whose source is `telegram` is reviewable only when it arrived by `fixture_replay`. Any other combination is reviewable only when the capture method is listed in `MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS` (default `fixture_replay`). The rule is applied when the row is created and again when the worker claims it; a row that fails then becomes `not_permitted`.

**Queueing** (`src/services/review-queue.ts`)

- `requeueReviewsForChat(tx, chatId)`: called on every entry into `ai_active` (dispatch or resume). Sets every `not_requested`, `stale_discarded` and `unavailable` review of the chat to `pending` and resets `attempts` to 0.
- `requeueRetryableReviews(tx, chatId?)`: automatic retry. Sets `unavailable` reviews with fewer than 3 attempts to `pending`, for one `ai_active` chat (called by intake when a new incoming message is stored) or for all `ai_active` chats (startup). At startup reviews left `running` also go back to `pending`.

**Reviewer port**

- `ReviewRequest = { reviewId; chatId; messageId; messageEventId; source; text }`. `messageId` is the internal `msg_…` ID and is the value the reviewer must echo as `sourceMessageId`. `text` is the text of the reviewed event (`message_events.text`): the original for `recorded`, the new text for `edited` and `conflicting_copy`.
- `ExtractedItem = { sourceMessageId: string; kind: 'payment_link' | 'payment_recipient' | 'phone_number'; quote: string; extractedValue: string; concern: 'payment_request' | 'callback_request' | 'credential_request' | 'other_concern' | null; countryHint: string | null }`.
- `Reviewer.review(request, signal) -> Promise<{ items: ExtractedItem[] }>`; it throws `ReviewerUnavailableError(code)` on failure. The reviewer has no tools and no access to the store. Implementations: `deterministic` (rules; tests and offline demo), `lmstudio` (default), `disabled` (always unavailable).

**Worker**

- Per chat one review at a time, in `position` order; several chats in parallel (`MIRSAD_REVIEW_CONCURRENCY`, default 2).
- Claim, in one transaction: re-check policy; unless the chat is `ai_active` put the review back to `not_requested`; else store `requested_revision`, `attempts + 1`, status `running`. The reviewer is then called outside any transaction.
- Reviewer failure or timeout: status `unavailable` with an error code. Intake, captures and officer controls are unaffected.

**Publish** (`publishReview`, one transaction, re-reading the chat first)

1. Chat not `ai_active`: set `stale_discarded` and publish nothing else. Chat `ai_active` but `revision != requested_revision` (the officer paused or took over and resumed while the model was working): put the review back to `pending` and wake the worker. Either way a result that finished under an older control state never appears as a finding.
2. Validate each item (`src/domain/finding-validation.ts`) against the reviewed event's text: `sourceMessageId` equals the request's `messageId`; `quote` is a non-empty exact substring of the text; `extractedValue` is supported by the quote:
   - link: the value is a whole token of the quote (bounded by whitespace, brackets, quotes or the ends) and parses with the WHATWG `URL` parser (after prepending `https://` when it has no scheme) to a hostname that contains a dot;
   - phone: its digits equal the digits of a phone-like span in the quote, after mapping Arabic-Indic digits to ASCII;
   - recipient: it appears in the quote, ignoring case and repeated whitespace.
   Rejected items increase `unsupported_count` and are never shown. A phone item without a concern is dropped.
3. Normalize. Link: `normalizeHost(hostname)` + path + query, where `normalizeHost` lower-cases, converts to punycode, and drops a leading `www.`, the port and a trailing dot; path and query stay exactly as written. Phone: `normalizePhone(extractedValue, { country: countryHint })` giving the E.164 form, or `unnormalized:<digits>` (section 11). Recipient: lower-cased, single-spaced.
4. Decide per item, comparing only inside its own category and only against details that earlier message events of the chat carried. "Current" means the detail of that category with the highest `last_seen_position` below this event's position.
   - The value is the current detail: a repeat. Update `last_seen_position`, increase `suppressed_count`, raise nothing.
   - Phone numbers: any value already stored for the chat is a repeat.
   - Otherwise insert or update the detail and insert one finding. For `payment_link` and `payment_recipient` the label is `Payment destination changed` with `changed_from` = the current detail's `display_value` when a current detail exists (this covers a switch back to an older destination), else `New payment link` / `New payment recipient`. For phones the label is `Phone number tied to a concern`.
5. Suspected fraud rule. It applies only when the chat has at least one `merchant_payment_confirmation`. The links considered are the valid `payment_link` items plus the links `detectPaymentLinks(text)` finds in code (http, https or `www.` URLs in a message that matches the deterministic payment cues), so the rule does not depend on what the model chose to report. For a considered link whose normalized host is not one of the confirmed hosts and that is not a repeat, the one finding raised for it has kind `suspected_fraud` (label `Suspected fraud`, citing the quote and the most recent case reference) instead of `payment_link`. Without a confirmation on file no fraud finding is ever created.
6. `label` and `note` come from fixed templates, never from model text. The note is one short sentence, for example `Payment destination changed in a message from the contact.`
7. Call `watchlist.onEvidencePublished(tx, { chat, message, messageEvent }, { phoneMentions, suspectedFraudFindingIds })` when either list is non-empty. `phoneMentions` holds every valid phone item with a concern, repeats included: `{ e164: string | null; digits: string; sourceRepresentation: string; concern; findingId: string | null }`.
8. Set `completed` with `outcome = 'findings'` when at least one finding was inserted, else `no_new_finding`. Publish `finding.created` per finding and `review.updated`.

**Case references**

- `POST …/case-references` stores the confirmation with hosts normalized by `normalizeHost` (a URL or `host:port` is accepted as input; a value that does not parse is `400`). It then inserts a `suspected_fraud` finding (with `review_id` NULL) for every existing `payment_link` finding of the chat whose host is not among the chat's confirmed hosts, publishes `finding.created` for each, calls `watchlist.onEvidencePublished` once per affected message event, and reports how many it created. This is a rule over stored evidence and an officer-entered fact, so it runs in any AI mode.

**Model request**

- LM Studio, OpenAI-compatible `POST /chat/completions` on a loopback URL (validated by parsing: the hostname must be exactly `127.0.0.1`, `localhost` or `[::1]`; requests use `redirect: 'error'`): system prompt, then the message as JSON data with its ID; `response_format` JSON schema. Output fields per item: `sourceMessageId`, `kind`, `quote`, `extractedValue`, `concern` (the four values or `none`), `countryHint` (ISO alpha-2 or `unknown`); `none` and `unknown` map to null. Text longer than 1,500 characters is reviewed in chunks so each request fits a 4,096-token context.

## 11. Watchlist

- One watchlist per workspace. An entry is keyed by `match_key`: the E.164 form when the number can be normalized, else `unnormalized:<chatId>:<digits>`, so an unnormalized number is a lead tied to the chat that mentioned it and never merges with another chat's.
- `normalizePhone(raw, hint?: { country?: string; internationalFormat?: boolean }) -> { e164: string | null; digits: string }` in `src/domain/phone.ts`: map Arabic-Indic and Extended Arabic-Indic digits to ASCII; rewrite a leading `00` to `+`; parse as international when the text starts with `+` or when the source marks the number as international; else parse with `country` when one is given; accept only a valid number. No default country is ever assumed. Unnormalized entries are kept with `exactMatchEligible: false` and never match.
- Observations record `origin`: `message_mention` (a number written in a message) or `sender_metadata` (a number the source supplied for the sender). They always carry the exact source reference (chat, message, message event), the source representation as written, and a reason. A mentioned number is never linked to the sender.
- `onEvidencePublished` (called by the review pipeline, section 10):
  - each phone mention adds a `message_mention` observation; the reason comes from the concern, for example `Mentioned with a payment request`;
  - each suspected-fraud finding, when the chat has a stored contact phone, adds a `sender_metadata` observation for that number, keyed by `contact_phone_e164` when set (else the unnormalized key of `contact_phone_raw`), with reason `Sender of a message with a Suspected fraud finding`.
- `onContactPhoneKnown(tx, { chat, message, messageEvent }, phone)` (called by intake the first time an incoming message supplies the sender's phone): normalize with the hint and store `contact_phone_e164`. If the workspace already has an entry for that E.164 in any status, add a `sender_metadata` observation with reason `Sender of an inbound chat`. If that entry is `approved`, also insert `watchlist_matches`, a `watchlist_match` case action and a `watchlist.match` stream event.
- New key: create the entry as `needs_review`. Existing key: append the observation, move `last_seen_at` to the later time, and when the entry is `approved` or `cleared` set `new_evidence_since_review`. Status never changes automatically. `UNIQUE (entry_id, message_event_id, origin)` makes repeat delivery a no-op.
- Review (`POST /v1/watchlist/{entryId}/review`): `approve` from `needs_review`; `clear` from `needs_review` or `approved`; `reopen` from `approved` or `cleared` back to `needs_review`. Anything else is `409 invalid_transition`. Each decision needs a reason and the expected revision, increments the revision, clears `new_evidence_since_review`, and stores officer, time and decision. Observations are never removed.
- A chat summary lists a match only while its entry is `approved`. A match is a lead, not an identification: numbers are shared and reassigned. A Telegram user ID, a username or a partial number is never used for matching.
- Access: `canAccessEntry` = same workspace AND (an observation or a current match of the entry lies in a chat the caller can access). `evidence` lists only observations in accessible chats; `restrictedEvidence` is true when others exist. `canReview` (and the review route) additionally requires at least one accessible observation, else `403 evidence_access_required`; `lastDecision.reason` is returned only to callers who can review, and is null otherwise. An entry the caller cannot access is `404 watchlist_entry_not_found`.

## 12. Event stream

- `appendStreamEvent(tx, { workspaceId, type, chatId?, watchlistEntryId?, data })` runs inside the caller's transaction, takes the next `stream_seq` and returns it (callers store it as `position`). After commit an in-process bus wakes subscribers. The database is the source of truth; the bus only wakes readers.
- Retention: the newest `MIRSAD_STREAM_RETENTION` events per workspace (default 5000). Pruning raises `stream_floor`.
- `GET /v1/events`: the start position is the `Last-Event-ID` header when present, else `?cursor=`, else the current head. Then loop. Before each read, if the position is below `stream_floor` or above the head (a cursor from an older data directory, or a client that fell behind pruning), send `stream.reset` and continue from the head. Read events after the position, send those the caller may see, advance past the rest. Then wait for a wake-up, sending a `: keep-alive` comment every 15 seconds. Each batch re-checks that the principal is not disabled and ends the stream if it is. Because reads start from the snapshot cursor, an event committed between a snapshot and the subscription is delivered.
- Wire format: one SSE message per event with `id` = the sequence, `event` = the type and `data` = JSON `{ "id": "<seq>", "type", "chatId", "occurredAt", … }`.
- The token travels only in the `Authorization` header. The browser's `EventSource` cannot send one, so the dashboard reads the stream with `fetch()` and a small parser and sends `Last-Event-ID` itself when it reconnects. A host can do the same or use any SSE client that supports headers.
- Delivery rule: chat-scoped events need `canAccessChat`; watchlist entry events need `canAccessEntry`.
- Types and extra fields (ids and statuses only, never message text): `chat.created` (inboxStatus) · `chat.control_changed` (aiMode, revision) · `message.recorded` (messageId, direction, origin) · `message.edited` / `message.deleted` / `message.conflicting_copy` (messageId, messageEventId) · `capture.updated` (messageId, messageEventId, captureId, status, artifactId) · `review.updated` (messageId, messageEventId, status, outcome) · `finding.created` (messageId, findingId, kind) · `case_action.recorded` (caseActionId, actionType) · `case_reference.recorded` (caseReferenceId) · `watchlist.entry_updated` (watchlistEntryId, status, reason: created | observation_added | reviewed; chatId null) · `watchlist.match` (watchlistEntryId) · `stream.reset` (reason: cursor_out_of_range, resumeFrom, reload: ['inbox','timeline']).

## 13. Telegram

- `ChannelAdapter<Raw>.normalize(raw) -> IntakeEnvelope[]` is the shared adapter interface. The Telegram adapter is a pure mapping from one Bot API `Update` to intake envelopes; exact field mapping is in section 19.
- Fixtures in `fixtures/telegram/*.json` hold Telegram-shaped, fully synthetic updates: `{ description, synthetic: true, account: 'intake' | 'officer', businessUserId, businessConnectionId, updates: Update[], conversationStarts?: [{ chatId, messageId }] }`. `account` is symbolic: the replay caller maps it to a real `externalAccountId`, because the test harness and the demo seed use different account IDs. The adapter drops updates whose `business_connection_id` differs from `businessConnectionId`. `conversationStarts` is the fixture author's assertion about a synthetic conversation; real Telegram updates carry no start marker, so live intake always yields `First observed: …`.
- `npm run replay -- <fixture>` normalizes a fixture and posts each envelope to `POST /v1/ingest` with the fixture connector's token. Replay is the only way Telegram-shaped data enters the prototype. It refuses a file that is not marked `synthetic: true` or that contains a domain or phone number outside the reserved ranges, because fixture-replay content is the only Telegram-shaped content the model may review.
- Live connector (`src/adapters/telegram/live-connector.ts`): long polling for business updates only. It stays off unless `TELEGRAM_LIVE_ENABLED=true` and the bot token, approved connection ID, approved chat IDs and approval reference are all set. Updates for other connections or chats are dropped before storage and only counted. It ingests through the same intake function with a `telegram_business_live` connector, so its content is never reviewed by any model (section 10). It has no send capability.
- Readiness: `npm run telegram:readiness` runs these local checks against a temporary instance and writes each result to `docs/telegram/readiness.json` and `docs/telegram/readiness.md`: an inbound-first chat is flagged New inbound; an officer-first chat shows both directions; every received message has its own capture; an edit and a deletion are separate events and the original stays; a redelivered update creates nothing new; outgoing (officer-sent) fixture messages arrive and are labelled outgoing; a takeover followed by a composer reply is recorded as Simulated send; the live connector refuses to start without its gates. The state is `ready_for_controlled_test` only when every check passes. `controlled_test_verified` is reported only when the file named by `MIRSAD_CONTROLLED_TEST_RECORD` exists and validates against the schema in `src/contract/controlled-test-record.ts` (approval reference, date, tester, approved scope, per-event coverage, manual reply result). Nothing in the code can produce that record without an approved test.
- `GET /v1/status` returns `{ service: { version, startedAt }, storage: { database, evidenceDirectory }, workers: { capture: { pending, failed }, review: { pending, running, unavailable } }, reviewer: { kind, modelId, reachable }, channels: { telegram: { fixtureReplay: 'available', liveConnector: 'disabled' | 'enabled', readiness: 'not_assessed' | 'ready_for_controlled_test' | 'controlled_test_verified', readinessRecordedAt }, whatsapp: { status: 'not_started', gate: string } } }`.

## 14. WhatsApp gate

WhatsApp-specific implementation starts only after the Telegram controlled test is verified. Until then the repository holds only the shared adapter interface, `docs/whatsapp/data-mapping.md`, `docs/whatsapp/import-plan.md` and skipped slots in the shared contract tests. Intake refuses `source: 'whatsapp'` unless `MIRSAD_WHATSAPP_IMPORT_ENABLED=true`, and that setting is itself rejected at startup while no valid controlled-test record exists.

## 15. Config

Environment variables (all in `.env.example`; `.env` is git-ignored): `MIRSAD_HOST` (default `127.0.0.1`; only `127.0.0.1`, `localhost` or `::1` are accepted), `MIRSAD_PORT` (8787), `MIRSAD_DATA_DIR` (`./data`), `MIRSAD_DEMO_SEED` (`true`), `MIRSAD_REVIEWER` (`lmstudio`; or `deterministic`, `disabled`), `MIRSAD_LMSTUDIO_BASE_URL` (`http://127.0.0.1:1234/v1`; the parsed hostname must be exactly `127.0.0.1`, `localhost` or `[::1]`), `MIRSAD_LMSTUDIO_MODEL` (`qwen3.5-9b`), `MIRSAD_LMSTUDIO_CONTEXT_TOKENS` (4096), `MIRSAD_LMSTUDIO_TIMEOUT_MS` (120000), `MIRSAD_REVIEW_CONCURRENCY` (2), `MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS` (`fixture_replay`), `MIRSAD_STREAM_RETENTION` (5000), `MIRSAD_RATE_LIMIT_PER_MINUTE` (600), `MIRSAD_WHATSAPP_IMPORT_ENABLED` (`false`), `MIRSAD_CONTROLLED_TEST_RECORD` (`docs/telegram/controlled-test-record.json`), `TELEGRAM_LIVE_ENABLED` (`false`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_APPROVED_CONNECTION_ID`, `TELEGRAM_APPROVED_CHAT_IDS`, `TELEGRAM_APPROVAL_REFERENCE`.

Demo seed (first start with an empty database and `MIRSAD_DEMO_SEED=true`): one workspace, two demo officers, two Telegram fixture accounts (`tg-demo-intake`, marked as an intake account, and `tg-demo-officer`), one fixture connector (`fixture_replay`, trusted start marker) granted on both. Tokens are random, stored hashed, and written once to `<dataDir>/demo-credentials.json` (git-ignored) for the local scripts and the dashboard sign-in.

## 16. Logging

`Logger` writes JSON lines. Log fields are IDs, codes, counts, lengths and durations. Message text, quotes, extracted values, phone numbers, display names and tokens are never logged; errors are logged by code and class. A test ingests a canary string and asserts it never appears in captured log output.

## 17. Test harness

`src/app.ts` builds one dependency object and passes it to `registerRoutes` and to both worker factories: `AppDeps { config; db; clock; logger; bus; identity; evidenceStore; renderer; reviewer; workers: { capture: { wake(): void }; review: { wake(): void } } }`. A worker factory has the shape `(deps: AppDeps) => { wake(): void; idle(): Promise<void>; stop(): Promise<void> }`.

`tests/helpers/harness.ts` exports `startHarness(overrides?) -> Promise<TestHarness>`:

```ts
interface TestHarness {
  app: App; baseUrl: string; dataDir: string; clock: FakeClock;       // FakeClock.advance(ms)
  tokens: { officerA: string; officerB: string; officerC: string; outsider: string; connector: string; liveConnector: string };
  accounts: { intake: { source: 'telegram'; externalAccountId: 'tg-intake-1' }; officer: { source: 'telegram'; externalAccountId: 'tg-officer-1' };
              live: { source: 'telegram'; externalAccountId: 'tg-live-1' } };
  http(token: string | null): { get(path, headers?): Promise<ApiResponse>; post(path, body?, headers?): Promise<ApiResponse> };
  renderer: ControllableRenderer;   // wraps the real renderer: hold(), release(), failNext(count = 1), inputs: CaptureRenderInput[]
  reviewer: ScriptedReviewer;       // hold(), release(), respond(fn), failNext(code), calls: ReviewRequest[]; default: deterministic rules
  logs: string[];                   // every log line written by the app, captured in memory
  drain(): Promise<void>;           // waits until both workers are idle
  restart(): Promise<void>;         // close the app and reopen it on the same data directory
  close(): Promise<void>;           // closes the app and removes the temp directory
}
```

Seeded for tests: workspace A with officers A and B (grants on `tg-intake-1`, `tg-officer-1`, `tg-live-1`), officer C (grant on `tg-intake-1` only), a fixture connector (`fixture_replay`, trusted start marker, grants on the first two accounts) and a live-type connector (`telegram_business_live`, grant on `tg-live-1`); workspace B with one officer (`outsider`). `tg-intake-1` is an intake account. Each test file gets its own temp data directory. Tests never sleep for fixed times: they `drain()` or wait on a condition.

## 18. Assumptions for the README

1. Captures are rendered for every source message event with content, in both directions, and for edits. Composer messages get no capture.
2. A different officer may take over a chat another officer controls, with the current revision; the transfer is logged. Resume from takeover is limited to the controlling officer.
3. Dispatch does not restart a paused or officer-controlled chat; those need an explicit resume.
4. `Suspected fraud` is produced only by a rule that compares a payment link's host with an officer-recorded merchant confirmation. The model never labels fraud.
5. Review looks at one incoming message at a time. Novelty and "changed destination" are decided in code from details already stored for the chat.
6. Phone numbers are normalized only with explicit international format or a country hint from the source. No default country.
7. Watchlist entries are visible to officers who can open at least one supporting or matching chat; evidence links are filtered per caller.
8. The service refuses to bind to anything other than loopback.
9. Git history uses a placeholder author identity because the machine had none configured.
10. Officer-supplied screenshots are not built in this version. The artifact kind is reserved, and every image Mirsad shows carries the label `Mirsad-rendered capture`.
11. One finding is raised per new detail. A link that conflicts with a recorded merchant confirmation raises a single `Suspected fraud` finding instead of a link note plus a fraud note.
12. A number that cannot be normalized is kept as a lead for the chat that mentioned it and is never merged across chats or matched.
13. Event IDs, positions and cursors are workspace-wide sequence numbers, so gaps show that other chats in the workspace had activity (not what it was).

## 19. Research-settled choices

Verified on this machine (Windows 11, Node 24.18.0, npm 11.16) by spikes run on 2026-11-21. The full findings, with working snippets, are in `.superpowers/sdd/2026-11-21-mirsad/research.json` (git-ignored working file) while the build is in progress.

### 19.1 Versions

Runtime dependencies: `hono` 4.13.19, `@hono/node-server` 2.1.11, `zod` 4.6.7, `yaml` 2.9.1, `libphonenumber-js` 1.13.17, `@napi-rs/canvas` 1.2.0 (pin exactly: image bytes depend on it), `tsx` 4.23.15 (the service runs through it). Dev dependencies: `typescript` 7.0.2, `vitest` 5.1.1, `@vitest/coverage-v8` 5.1.1 (must equal the vitest version), `@types/node` 24.19.2, `ajv` 8.20.0, `ajv-formats` 3.0.1, `@apidevtools/json-schema-ref-parser` 16.0.8, `playwright-core` (latest; drives the installed Edge or Chrome, no browser download).

`tsconfig`: `target` and `lib` ES2023, `module` and `moduleResolution` NodeNext, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`, `skipLibCheck`, `isolatedModules`, `types: ["node"]`. Relative imports carry the `.ts` extension. vitest: `pool: 'forks'`, `fileParallelism: true`, 15 s test and hook timeouts, v8 coverage over `src/**/*.ts`.

### 19.2 SQLite: built-in `node:sqlite`

- `new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true })`, then `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`. No flag and no warning on this Node version.
- There is no transaction helper. `Db.transaction(fn)` is: outermost call `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`; nested call `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` (use `db.isTransaction`). `fn` is synchronous: never `await` inside a transaction. The helper enforces this: it tracks nesting with its own depth counter and throws, rolling back, when `fn` returns a thenable. Rendering, file writes and model calls happen outside transactions.
- Binding `undefined` or a boolean throws: repositories map `undefined` to `null` and booleans to `0`/`1`. Rows are null-prototype objects: repositories return plain objects. Integers above 2^53 throw; nothing here needs them.
- `INSERT … RETURNING`, upsert with a partial-index conflict target, partial unique indexes and JSON functions all work.

### 19.3 HTTP and SSE (Hono)

- `serve({ fetch: app.fetch, port, hostname })` reports the bound port in its callback; cast the result to `http.Server`. Shutdown must call `server.close()` and then `server.closeAllConnections()`, or an open stream keeps it alive. On Windows a signalled child process dies without running handlers, so tests always stop the app in-process.
- `streamSSE`: the first event flushes at once; Hono writes the fields in the order `event`, `data`, `id`; keep-alive is `stream.write(': keep-alive\n\n')`; `stream.onAbort` fires on client disconnect. The keep-alive interval is injectable (`AppOptions.streamKeepAliveMs`, default 15000; tests use 25).
- `hono/body-limit` is per route and needs an `onError` that returns the 413 envelope.
- Tests do not use vitest fake timers (they freeze the in-process server); time is controlled through the `Clock` port.

### 19.4 Contract tooling

- Put every component schema in a zod registry and call `z.toJSONSchema(registry, { target: 'draft-2020-12', io, uri: (id) => '#/components/schemas/' + id })`; strip `$schema` and `$id` from each result. Use `io: 'input'` for request bodies and `io: 'output'` for responses. Do not use the `openapi-3.1` target.
- Validation in tests: parse the YAML, dereference with `@apidevtools/json-schema-ref-parser`, compile with `import { Ajv2020 } from 'ajv/dist/2020.js'` and `import formatsPlugin from 'ajv-formats'` (call `formatsPlugin.default`).

### 19.5 Phone numbers

`libphonenumber-js/min`. Map Arabic-Indic and Extended Arabic-Indic digits to ASCII, rewrite a leading `00` to `+`, parse, and accept only `isValid()` results (a partial number parses to an object that is not valid). A number without `+`/`00` is parsed only with a country hint, or as international when the source marks it so: `sender.phone` in the intake event is `{ raw: string; country?: string; internationalFormat?: boolean }`. No default country.

### 19.6 Capture renderer

- `@napi-rs/canvas` (prebuilt, in-process). `fillText` draws plain text, so markup can never be interpreted. Skia shapes Arabic and applies the bidi algorithm per drawn line; Mirsad's code does paragraph splitting, base direction from the first strong character, greedy word wrapping with `measureText`, grapheme-safe breaking of over-long tokens, and replaces bidi controls, zero-width joiners and control characters with visible `[U+XXXX]` tokens.
- Fonts are vendored in `assets/fonts/` with their licence file (SIL OFL 1.1): Noto Sans Regular and Bold, Noto Sans Arabic Regular and Bold, Noto Sans Mono Regular. Register each weight under its own alias (one alias for two weights makes everything bold). Characters outside these fonts fall back to system fonts.
- The proven module is `spike-renderer/renderCapture.ts` in the session scratchpad (path in `research.json`); Task 3 adapts it. Keep the renderer source ASCII-only (numeric code points, no literal invisible characters) and test for that.
- Cards are capped at 30,000 px; beyond that a visible `[TRUNCATED …]` line is drawn and the footer hash still covers the full text. Measured: about 11 ms for a short card, about 100 ms for 3,000 characters.
- The same input gives byte-identical PNGs on one platform and library version, not across platforms. The text SHA-256 (over the stored string as UTF-8) is the integrity anchor; the artifact SHA-256 covers the stored file.

### 19.7 Local model (LM Studio)

- Server: `http://127.0.0.1:1234/v1`, bound to loopback. Model ID: **`qwen3.5-9b`** (Qwen3.5 9B, GGUF Q4_K_M, loaded with a 4,096-token context, parallel 4). It was already loaded that way; only the local server was started (`lms server start --bind 127.0.0.1 --port 1234`; undo with `lms server stop`).
- Requests must send `"reasoning_effort": "none"`. With thinking left on, the reasoning consumes the token budget and `content` comes back empty. Use `temperature: 0`, `max_tokens: 512`, and `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }` with `additionalProperties: false` and every key required.
- Treat a response as usable only when `finish_reason === 'stop'`, `content` is non-empty and parses, and it passes zod validation. Retry once on an HTTP 400 that is not a context overflow (seen once at warm-up). Overflow is HTTP 400 whose error text contains `exceed_context_size_error`.
- LM Studio answers an unknown model name with whichever model is loaded, so `health()` reads `GET <origin>/api/v0/models` and requires an entry with the configured ID and `state: 'loaded'`; it reports `loaded_context_length`.
- Observed latency with reasoning off: 0.3 to 2.7 s per message.

### 19.8 Telegram Business intake (Bot API)

Source: the official Bot API reference and Telegram's terms, read on 2026-11-21. Field mapping used by fixtures, the adapter and the disabled live connector:

| Normalized field | Telegram source |
|---|---|
| `externalAccountId` | `String(BusinessConnection.user.id)`, the owner account. The connection ID can change, so it is stored as state and never used as identity. |
| `externalChatId` | `String(message.chat.id)` |
| `sourceMessageId` | `tg:<message_id>` (unique per chat). `message_id` 0 cannot be deduplicated: skip and count it. |
| `sourceEventId` | `tg:u<update_id>:m<message_id>` for `business_message`; `tg:u<update_id>:m<message_id>:e<edit_date>` for `edited_business_message`; `tg:u<update_id>:m<message_id>:del` for each ID in `deleted_business_messages`. Telegram may restart `update_id` at a random value after a quiet week, so the update ID alone is not a safe key. |
| `direction` | `outgoing` when `from.id` equals the owner's user ID or `sender_business_bot` is present; otherwise `incoming` |
| `text` | `text`, else `caption`, else `''`; media kinds present (`photo`, `document`, `video`, `audio`, `voice`, `video_note`, `sticker`, `animation`, `location`, `venue`, `poll`, `contact`) go to `unsupportedContent` |
| `sentAt` / `editedAt` | `date` / `edit_date` (Unix seconds). Deletions carry no time. |
| `sender` | `externalId = String(from.id)`, `displayName` from first and last name |
| `sender.phone` | only from `message.contact` when `contact.user_id === from.id` on an incoming message: `{ raw: contact.phone_number, internationalFormat: true }`. `User` and `Chat` never carry a phone number. |

- Update types: `business_connection` (`BusinessConnection { id, user, user_chat_id, date, rights?, is_enabled }`; `rights` replaced the old `can_reply` flag in Bot API 9.0), `business_message` and `edited_business_message` (a full `Message` with `business_connection_id`; an edit carries the whole new version and no previous text), `deleted_business_messages` (`{ business_connection_id, chat, message_ids }`, nothing else).
- Not available from this intake: earlier history, any start-of-conversation marker, read receipts, who deleted a message, edit history. Undelivered updates are kept for at most 24 hours.
- Connector mechanics: long polling with `getUpdates` and an explicit `allowed_updates` list of the four business types; persist the offset only after the update is committed. Verification without reading content: `getMe` (`can_connect_to_business`), `getWebhookInfo` (empty `url` for polling), `getBusinessConnection`. Read-only intake needs no rights; Mirsad never calls a send or read-marking method.
- To be observed in the controlled test (the docs are silent): whether messages the owner types in their own app arrive, whether bot-sent replies echo back, whether delivery works with no rights granted, how offline edits and "delete for me" behave, whether the connection ID changes when the owner edits the scope, and the format of `contact.phone_number`.
- Preconditions the terms place on a live test, all outside this prototype: data encrypted at rest with the key stored separately, a published privacy notice, a retention limit and deletion-on-request path, business message content used only to provide the service and never shared with third parties, bot activity never hidden from the account owner. AI analysis of Telegram content is a legal-review item and stays off.
- WhatsApp: Meta's Business Messaging Policy (Government and Political Use) prohibits law-enforcement agencies from using the WhatsApp Business Platform, so the later WhatsApp phase is fixture replay and approved import only.
