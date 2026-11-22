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
  idempotencyKey?: boolean;
  success: SuccessDoc[];
  errors: ErrorCode[];
  kind?: 'json' | 'event-stream' | 'png' | 'static';
}

const ACCOUNT: ErrorCode[] = ['account_not_authorized'];
const REVISION: ErrorCode[] = ['revision_conflict', 'invalid_transition'];
const CHAT: ErrorCode[] = ['chat_not_found'];

export const ROUTE_DOCS: Record<RouteKey, RouteDoc> = {
  'POST /v1/chats': {
    summary: 'Register an existing conversation',
    description:
      'Returns a stable `chatId` for the workspace, source, account and conversation. `201` when new, `200` when it already existed.',
    request: 'RegisterChatRequest',
    success: [
      { status: 201, description: 'Chat registered.', schema: 'RegisterChatResponse' },
      { status: 200, description: 'The chat already existed.', schema: 'RegisterChatResponse' },
    ],
    errors: ['validation_failed', 'account_not_found', ...ACCOUNT, 'channel_not_enabled'],
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
    errors: ['validation_failed', 'payload_too_large', ...ACCOUNT, 'channel_not_enabled', 'direction_required', 'message_not_found'],
  },
  'POST /v1/chats/{chatId}/events': {
    summary: 'Submit an intake event to a registered chat',
    description: 'Same ingestion logic as `POST /v1/ingest`, addressed by `chatId`.',
    request: 'IntakeEvent',
    success: [
      { status: 201, description: 'Event recorded.', schema: 'IngestResult' },
      { status: 200, description: 'Duplicate event or message; nothing new stored.', schema: 'IngestResult' },
    ],
    errors: ['validation_failed', 'payload_too_large', ...CHAT, 'channel_not_enabled', 'direction_required', 'message_not_found'],
  },
  'POST /v1/dispatches': {
    summary: 'Start AI review on selected chats',
    description:
      'Access to the whole selection is validated before any chat changes. An officer-controlled chat needs an explicit resume. Requires `Idempotency-Key`.',
    request: 'DispatchRequest',
    idempotencyKey: true,
    success: [{ status: 200, description: 'Per-chat dispatch results.', schema: 'DispatchResponse', replayHeader: true }],
    errors: ['validation_failed', 'idempotency_key_required', 'idempotency_key_reused', ...CHAT],
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
    errors: ['validation_failed', 'idempotency_key_required', 'idempotency_key_reused', ...CHAT, 'not_in_takeover', 'not_controller', 'revision_conflict'],
  },
  'POST /v1/chats/{chatId}/officer-decisions': {
    summary: 'Record a decision on an incoming message',
    request: 'OfficerDecisionRequest',
    success: [
      { status: 201, description: 'Decision recorded.', schema: 'OfficerDecisionResponse' },
      { status: 200, description: 'The decision already existed.', schema: 'OfficerDecisionResponse' },
    ],
    errors: ['validation_failed', ...CHAT, 'message_not_found', 'not_in_takeover', 'not_controller', 'revision_conflict'],
  },
  'GET /v1/chats/{chatId}/timeline': {
    summary: 'Read a chat timeline',
    description: 'Messages, message events, case actions, findings, case references and the stream cursor, each ordered by `position`.',
    success: [{ status: 200, description: 'The timeline snapshot.', schema: 'Timeline' }],
    errors: [...CHAT],
  },
  'GET /v1/artifacts/{artifactId}': {
    summary: 'Download a rendered capture',
    description: 'PNG bytes. The checksum is verified on every read; a mismatch answers `500 artifact_integrity_error`.',
    kind: 'png',
    success: [{ status: 200, description: 'The capture image.' }],
    errors: ['artifact_not_found', 'artifact_integrity_error', 'evidence_access_required'],
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
    errors: ['not_implemented'],
  },
  'POST /v1/watchlist/{entryId}/review': {
    summary: 'Approve, clear or reopen a watchlist entry',
    request: 'WatchlistReviewRequest',
    success: [{ status: 200, description: 'The updated entry.', schema: 'WatchlistReviewResponse' }],
    errors: ['validation_failed', 'watchlist_entry_not_found', 'revision_conflict', 'invalid_transition', 'not_implemented'],
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
    errors: ['not_implemented'],
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
    errors: ['not_implemented'],
  },
  'GET /assets/*': {
    summary: 'Reference dashboard asset',
    kind: 'static',
    success: [{ status: 200, description: 'A static file.' }],
    errors: ['not_found', 'not_implemented'],
  },
};
