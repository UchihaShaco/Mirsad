/**
 * Per-route documentation for the OpenAPI document: summary, request and success schemas (component names of
 * `CONTRACT_SCHEMAS`) and the error codes a caller can meet. The route list itself comes from `ROUTES`; a route
 * without an entry here makes the generator throw, so the two cannot drift apart silently.
 */
import type { ErrorCode } from './errors.ts';
import type { RouteKey } from '../http/context.ts';

export interface SuccessDoc {
  status: number;
  description: string;
  /** Component schema name of `data`; omitted for non-JSON bodies. */
  schema?: string;
  /** Adds the `meta` pagination block to the envelope. */
  paginated?: boolean;
  /** Adds the `Idempotency-Replayed` header (set on replayed responses). */
  replayHeader?: boolean;
}

export interface RouteDoc {
  summary: string;
  description?: string;
  /** Component schema name of the JSON request body. */
  request?: string;
  /** The zod query schema is described through this marker; see `listChatsQuery` in openapi.ts. */
  listChatsQuery?: boolean;
  /** Same, for `GET /v1/places/search` (`placesSearchQuery` in openapi.ts). */
  placesSearchQuery?: boolean;
  idempotencyKey?: boolean;
  success: SuccessDoc[];
  errors: ErrorCode[];
  kind?: 'json' | 'event-stream' | 'png' | 'static';
}

const ACCOUNT: ErrorCode[] = ['account_not_authorized'];
const REVISION: ErrorCode[] = ['revision_conflict', 'invalid_transition'];
const CHAT: ErrorCode[] = ['chat_not_found'];
const erasePreview = (summary: string): RouteDoc => ({
  summary, success: [{ status: 200, description: 'Number of conversations and a snapshot for confirmation.', schema: 'ErasePreview' }],
  errors: CHAT,
});
const erase = (summary: string): RouteDoc => ({
  summary, request: 'EraseRequest', idempotencyKey: true,
  success: [{ status: 200, description: 'Local erasure receipt with count of capture files still awaiting cleanup.', schema: 'EraseResponse', replayHeader: true }],
  errors: [...CHAT, ...REVISION, 'not_controller', 'validation_failed', 'idempotency_key_required', 'idempotency_key_reused'],
});

export const ROUTE_DOCS: Record<RouteKey, RouteDoc> = {
  'POST /v1/chats/{chatId}/erase-telegram': { ...erase('Delete eligible captured messages on Telegram for both participants'),
    success: [{ status: 200, description: 'Telegram deletion counts for the confirmed chat.', schema: 'TelegramEraseResponse', replayHeader: true }] },
  'POST /v1/inbox/erase-telegram': { ...erase('Delete eligible captured Telegram messages for both participants across this inbox'),
    success: [{ status: 200, description: 'Telegram deletion counts for the confirmed inbox.', schema: 'TelegramEraseResponse', replayHeader: true }] },
  'GET /v1/chats/{chatId}/erase-preview': erasePreview('Preview erasure of one local conversation'),
  'POST /v1/chats/{chatId}/erase': erase('Erase the selected local conversation and all its previous tests'),
  'GET /v1/inbox/erase-preview': erasePreview('Preview erasure across the officer’s local inbox'),
  'POST /v1/inbox/erase': erase('Erase the confirmed conversations in the officer’s local inbox'),
  'POST /v1/auth/login': {
    summary: 'Sign in to the officer dashboard',
    description: 'A temporary password returns passwordChangeRequired. Submit the username and temporary password again with a different newPassword (12–128 characters) to receive a session. Pass the returned session token in the Authorization bearer header. Responses use Cache-Control: no-store. Browser requests must use the same origin and send JSON.',
    request: 'OfficerLoginRequest',
    success: [{ status: 200, description: 'Officer session issued or first-login password change required.', schema: 'OfficerLoginResponse' }],
    errors: ['unauthenticated', 'validation_failed', 'origin_not_allowed', 'payload_too_large'],
  },
  'POST /v1/auth/logout': {
    summary: 'Revoke the current officer session',
    description: 'Requires the password session to revoke. Browser requests must use the same origin.',
    success: [{ status: 200, description: 'Officer session revoked.', schema: 'OfficerLogoutResponse' }],
    errors: ['origin_not_allowed', 'payload_too_large'],
  },
  'POST /v1/chats': {
    summary: 'Register an existing conversation',
    description:
      'Returns a stable `chatId` for the workspace, source, account and conversation. `201` when new, `200` when it already existed.',
    request: 'RegisterChatRequest',
    success: [
      { status: 201, description: 'Chat registered.', schema: 'RegisterChatResponse' },
      { status: 200, description: 'The chat already existed.', schema: 'RegisterChatResponse' },
    ],
    errors: ['validation_failed', 'account_not_found', ...ACCOUNT],
  },
  'GET /v1/chats': {
    summary: 'List authorized conversations',
    listChatsQuery: true,
    success: [{ status: 200, description: 'A page of chats.', schema: 'ListChatsResponse', paginated: true }],
    errors: ['validation_failed'],
  },
  'POST /v1/ingest': {
    summary: 'Submit an intake event',
    description:
      'Creates or finds the chat and appends the event in one transaction. An inbound message for a new chat enters `New inbound`. `201` when something new was stored, `200` for a duplicate.',
    request: 'IngestRequest',
    success: [
      { status: 201, description: 'Event recorded.', schema: 'IngestResult' },
      { status: 200, description: 'Duplicate event or message; nothing new stored.', schema: 'IngestResult' },
    ],
    errors: ['validation_failed', 'payload_too_large', ...ACCOUNT, 'direction_required', 'message_not_found', 'history_erased'],
  },
  'POST /v1/chats/{chatId}/events': {
    summary: 'Submit an intake event to a registered chat',
    description: 'Same ingestion logic as `POST /v1/ingest`, addressed by `chatId`.',
    request: 'IntakeEvent',
    success: [
      { status: 201, description: 'Event recorded.', schema: 'IngestResult' },
      { status: 200, description: 'Duplicate event or message; nothing new stored.', schema: 'IngestResult' },
    ],
    errors: ['validation_failed', 'payload_too_large', ...CHAT, 'direction_required', 'message_not_found', 'history_erased'],
  },
  'POST /v1/dispatches': {
    summary: 'Dispatch selected chats and request eligible Telegram replies',
    description:
      'Start eligible chats and return one receipt per chat. On live Telegram, participantPermissionRecorded=true is the officer’s attestation that every selected Telegram participant has already agreed to AI replies and screening through the configured provider for that chat. Each eligible chat records the attestation. replyAgain=true requests an immediate reply, retry or follow-up. Missing permission is reported to the officer. Approved chats continue answering eligible DMs. expectedTestMode=true also checks the invitation setting. To pin a particular message and timeline revision, use replyToMessageId and replyToHeadPosition with one chat. Telegram’s reply window, officer controls, opt-outs and review holds apply. A queued request has a requestId. Consult the timeline for delivery. An optional officer briefing applies to one chat. Send null to clear the briefing. Reuse the same Idempotency-Key for transport retries.',
    request: 'DispatchRequest',
    idempotencyKey: true,
    success: [{ status: 200, description: 'Per-chat dispatch results.', schema: 'DispatchResponse', replayHeader: true }],
    errors: ['validation_failed', 'idempotency_key_required', 'idempotency_key_reused', 'revision_conflict', 'invalid_transition', 'history_erased', ...CHAT],
  },
  'POST /v1/dispatches/by-phone': {
    summary: 'Dispatch an existing Telegram private chat by verified phone number',
    description: 'Matches the latest self-shared contact card on an authorized live account. A unique match uses normal Dispatch controls. An officer may record existing participant permission for that chat by setting participantPermissionRecorded to true. Missing or ambiguous matches return only an outcome. Enter a complete international number with + or 00 and the exact international dialling digits.',
    request: 'DispatchByPhoneRequest',
    idempotencyKey: true,
    success: [{ status: 200, description: 'Dispatch result or an unresolved match.', schema: 'DispatchByPhoneResponse', replayHeader: true }],
    errors: ['validation_failed', 'idempotency_key_required', 'idempotency_key_reused', 'invalid_transition', 'history_erased', ...CHAT],
  },
  'POST /v1/investigation-opener': {
    summary: 'Draft an opening question for officer review',
    description: 'Returns a local suggested question in the selected language. The officer can review and copy it.',
    request: 'InvestigationOpenerRequest',
    success: [{ status: 200, description: 'A draft for the officer.', schema: 'InvestigationOpenerResponse' }],
    errors: ['validation_failed'],
  },
  'POST /v1/chats/{chatId}/control': {
    summary: 'Pause, take over or resume a chat',
    request: 'ControlRequest',
    success: [{ status: 200, description: 'The chat after the transition.', schema: 'ControlResponse' }],
    errors: ['validation_failed', ...CHAT, ...REVISION, 'not_controller'],
  },
  'POST /v1/chats/{chatId}/officer-messages': {
    summary: 'Send a message from the composer',
    description: 'The officer must control the chat at `expectedRevision`. The prototype stores a message labelled `Simulated send`. Requires `Idempotency-Key`.',
    request: 'OfficerMessageRequest',
    idempotencyKey: true,
    success: [{ status: 201, description: 'The stored message.', schema: 'OfficerMessageResponse', replayHeader: true }],
    errors: ['validation_failed', 'idempotency_key_required', 'idempotency_key_reused', ...CHAT, 'not_in_takeover', 'not_controller', 'revision_conflict', 'history_erased'],
  },
  'POST /v1/chats/{chatId}/officer-decisions': {
    summary: 'Leave an incoming message unanswered or mark one Telegram evidence item reviewed',
    request: 'OfficerDecisionRequest',
    success: [
      { status: 201, description: 'Decision recorded.', schema: 'OfficerDecisionResponse' },
      { status: 200, description: 'The decision already existed.', schema: 'OfficerDecisionResponse' },
    ],
    errors: ['validation_failed', ...CHAT, 'message_not_found', 'not_found', 'not_in_takeover', 'not_controller', 'revision_conflict'],
  },
  'GET /v1/chats/{chatId}/timeline': {
    summary: 'Read a chat timeline',
    description: 'Messages, message events, case actions, findings, case references and the stream cursor. Live Telegram chats also report permission, ongoing automatic replies and the most recent Dispatch delivery outcome.',
    success: [{ status: 200, description: 'The timeline snapshot.', schema: 'Timeline' }],
    errors: [...CHAT],
  },
  'GET /v1/artifacts/{artifactId}': {
    summary: 'Download a rendered capture',
    description: 'PNG bytes. The checksum is verified on every read; a mismatch answers `500 artifact_integrity_error`.',
    kind: 'png',
    success: [{ status: 200, description: 'The capture image.' }],
    errors: ['artifact_not_found', 'artifact_integrity_error'],
  },
  'GET /v1/events': {
    summary: 'Subscribe to workspace events',
    description:
      'Server-sent events. The start position is the `Last-Event-ID` header, else `cursor`, else the current head. A position outside retained history yields a `stream.reset` event telling the client to reload the inbox and timeline. Event data carries ids and statuses only.',
    kind: 'event-stream',
    success: [{ status: 200, description: 'An open `text/event-stream`.' }],
    errors: ['validation_failed'],
  },
  'GET /v1/watchlist': {
    summary: 'List phone watchlist entries',
    success: [{ status: 200, description: 'Entries the caller can access.', schema: 'ListWatchlistResponse' }],
    errors: [],
  },
  'POST /v1/watchlist/{entryId}/review': {
    summary: 'Approve, clear or reopen a watchlist entry',
    request: 'WatchlistReviewRequest',
    success: [{ status: 200, description: 'The updated entry.', schema: 'WatchlistReviewResponse' }],
    errors: ['validation_failed', 'watchlist_entry_not_found', 'evidence_access_required', 'revision_conflict', 'invalid_transition'],
  },
  'POST /v1/chats/{chatId}/scammer-flags': {
    summary: 'Flag the chat’s contact as a scammer',
    description: 'Puts the contact’s number on the phone watchlist as Approved, with the officer’s reason, and matches every chat from that number. The chat lists under Suspects while the number stays approved; clearing the number on the watchlist withdraws it. Flagging the same message with the same number again returns 200 and changes nothing.',
    request: 'ScammerFlagRequest',
    success: [{ status: 201, description: 'Flag recorded.', schema: 'ScammerFlagResponse' },
      { status: 200, description: 'Already flagged with this number.', schema: 'ScammerFlagResponse' }],
    errors: ['validation_failed', ...CHAT, 'phone_invalid', 'message_not_found'],
  },
  'POST /v1/chats/{chatId}/case-references': {
    summary: 'Record a case reference',
    request: 'CaseReferenceRequest',
    success: [{ status: 201, description: 'Reference recorded.', schema: 'CaseReferenceResponse' }],
    errors: ['validation_failed', ...CHAT],
  },
  'POST /v1/captures/{captureId}/retry': {
    summary: 'Retry a failed capture',
    success: [{ status: 200, description: 'The capture, queued again.', schema: 'CaptureRetryResponse' }],
    errors: ['capture_not_found', 'capture_not_retryable'],
  },
  'GET /v1/me': {
    summary: 'Identify the calling principal',
    success: [{ status: 200, description: 'The authenticated principal.', schema: 'MeResponse' }],
    errors: [],
  },
  'GET /v1/status': {
    summary: 'Service, worker, reviewer and channel status',
    success: [{ status: 200, description: 'Current status.', schema: 'Status' }],
    errors: [],
  },
  'GET /v1/telegram/dm-replies': {
    summary: 'Read the connected account’s automatic DM reply setting',
    success: [{ status: 200, description: 'Reply mode and whether this officer can switch it.', schema: 'DmRepliesResponse' }],
    errors: [],
  },
  'POST /v1/telegram/dm-replies': {
    summary: 'Enable or stop automatic replies for eligible private Telegram chats',
    description: 'Requires a grant on the linked account. Enabling starts with fresh incoming messages. When consent prompts are enabled, new contacts can opt in directly in Telegram. Disabling automated replies stops new automated sends and leaves intake active.',
    request: 'DmRepliesRequest',
    success: [{ status: 200, description: 'Current account reply setting.', schema: 'DmRepliesResponse' }],
    errors: ['account_not_found', 'invalid_transition', 'validation_failed'],
  },
  'GET /v1/telegram/consent-prompt': {
    summary: 'Read the private-chat consent invitation setting',
    success: [{ status: 200, description: 'Saved invitation setting and whether the officer can change it.', schema: 'ConsentPromptResponse' }],
    errors: [],
  },
  'POST /v1/telegram/reply-prompt/reload': {
    summary: 'Reload the saved Ali reply prompt',
    description: 'An officer with access to the linked Telegram account can reload prompts/ali.md for subsequent replies. Send an empty POST. If the file cannot be read or validated, the previous prompt stays active.',
    success: [{ status: 200, description: 'Active content version and whether it changed.', schema: 'ReplyPromptReloadResponse' }],
    errors: ['origin_not_allowed', 'account_not_found', 'validation_failed', 'reply_prompt_unavailable'],
  },
  'POST /v1/telegram/consent-prompt': {
    summary: 'Choose how new private Telegram chats start',
    description: 'Requires officer access to the linked account. With all-DM replies enabled, enabled=false turns on Test mode and fresh private messages can activate chats locally. For manual Dispatch, send enabled=true and manualDispatchOnly=true. New chats stay silent until dispatched and previously approved active chats continue. Sending enabled=true alone enables local consent invitations. The selection persists across restarts.',
    request: 'ConsentPromptRequest',
    success: [{ status: 200, description: 'Saved invitation setting.', schema: 'ConsentPromptResponse' }],
    errors: ['account_not_found', 'validation_failed'],
  },
  'GET /v1/places/search': {
    summary: 'Search the Abu Dhabi places directory',
    description: 'Officer lookup for the places map: matches name, category and description text, filters by exact category and the visible map area (bbox as minLng,minLat,maxLng,maxLat), up to 200 per page with an opaque cursor.',
    success: [{ status: 200, description: 'Matching places, the distinct categories of all matches, and the next page cursor.', schema: 'PlacesSearchResponse', paginated: true }],
    errors: ['validation_failed'],
    placesSearchQuery: true,
  },
  'GET /v1/places/{placeId}': {
    summary: 'Read one place from the directory',
    success: [{ status: 200, description: 'The place for the map details panel.', schema: 'PlacesDetailResponse' }],
    errors: ['not_found'],
  },
  'GET /v1/map/tiles/{z}/{x}/{y}': {
    summary: 'Proxied map tile for the places map',
    description: 'Raster tiles are served from our own origin with a disk cache, so the dashboard Content-Security-Policy stays same-origin. Map data: OpenStreetMap contributors.',
    kind: 'png',
    success: [{ status: 200, description: 'PNG tile bytes.' }],
    errors: ['validation_failed'],
  },
  'GET /healthz': {
    summary: 'Liveness check',
    success: [{ status: 200, description: 'The service is up.', schema: 'HealthResponse' }],
    errors: [],
  },
  'GET /': {
    summary: 'Reference dashboard',
    description: 'The dashboard page, served without authentication.',
    kind: 'static',
    success: [{ status: 200, description: 'HTML.' }],
    errors: [],
  },
  'GET /assets/*': {
    summary: 'Reference dashboard asset',
    kind: 'static',
    success: [{ status: 200, description: 'A static file.' }],
    errors: ['not_found'],
  },
};
