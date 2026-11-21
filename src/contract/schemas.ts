/** zod schemas and inferred types for every shape of design section 6. */
import { z } from 'zod';
import * as E from './enums.ts';
import { CHANNEL_LABELS, FINDING_LABELS, LABELS, ORIGIN_LABELS } from './labels.ts';

export const LIMITS = {
  messageTextMax: 65_536,
  labelMax: 200,
  reasonMin: 3,
  reasonMax: 500,
  sourceIdMax: 200,
  dispatchMin: 1,
  dispatchMax: 100,
  listLimitDefault: 100,
  listLimitMax: 500,
  paymentHostsMax: 20,
  hostnameMax: 253,
  unsupportedContentMax: 20,
} as const;

const id = z.string().min(1).max(LIMITS.sourceIdMax);
const label = z.string().trim().min(1).max(LIMITS.labelMax);
const timestampIn = z.iso.datetime({ offset: true });
const timestamp = z.iso.datetime();
const revision = z.number().int().min(1);

export const Source = z.enum(E.SOURCES);
export const CaptureMethod = z.enum(E.CAPTURE_METHODS);
export const Direction = z.enum(E.DIRECTIONS);
export const AiMode = z.enum(E.AI_MODES);
export const PrincipalRef = z.object({ id: z.string(), displayName: z.string() });
export type PrincipalRef = z.infer<typeof PrincipalRef>;

// ---- Intake ----

export const SenderPhone = z.object({
  raw: z.string().min(1).max(64),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  internationalFormat: z.boolean().optional(),
});
export const MessageRecordedEvent = z.object({
  type: z.literal('message.recorded'),
  sourceEventId: id,
  sourceMessageId: id,
  direction: Direction,
  text: z.string().max(LIMITS.messageTextMax),
  sentAt: timestampIn.optional(),
  sender: z
    .object({ externalId: id.optional(), displayName: label.optional(), phone: SenderPhone.optional() })
    .optional(),
  conversationStart: z.object({ basis: z.enum(E.INITIATION_BASES) }).optional(),
  unsupportedContent: z.array(z.string().min(1).max(40)).max(LIMITS.unsupportedContentMax).optional(),
});
export const MessageEditedEvent = z.object({
  type: z.literal('message.edited'),
  sourceEventId: id,
  sourceMessageId: id,
  text: z.string().max(LIMITS.messageTextMax),
  editedAt: timestampIn.optional(),
  direction: Direction.optional(),
});
export const MessageDeletedEvent = z.object({
  type: z.literal('message.deleted'),
  sourceEventId: id,
  sourceMessageId: id,
  deletedAt: timestampIn.optional(),
  direction: Direction.optional(),
});
export const IntakeEvent = z.discriminatedUnion('type', [MessageRecordedEvent, MessageEditedEvent, MessageDeletedEvent]);
export type IntakeEvent = z.infer<typeof IntakeEvent>;

export const IngestRequest = z.object({
  source: Source,
  externalAccountId: id,
  externalChatId: id,
  chat: z.object({ displayLabel: label.optional() }).optional(),
  event: IntakeEvent,
});
export type IngestRequest = z.infer<typeof IngestRequest>;
/** What a channel adapter produces: exactly one ingest request body. */
export type IntakeEnvelope = IngestRequest;

export const IngestResult = z.object({
  chatId: z.string(),
  chatCreated: z.boolean(),
  result: z.enum(E.INGEST_RESULTS),
  messageId: z.string(),
  messageEventId: z.string().nullable(),
  receivedAt: timestamp.nullable(),
  captureId: z.string().nullable(),
  startMarker: z.enum(E.START_MARKER_RESULTS),
  textConflict: z.boolean(),
});
export type IngestResult = z.infer<typeof IngestResult>;

// ---- Chats ----

export const EvidenceRef = z.object({
  observationId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  messageEventId: z.string(),
  findingId: z.string().nullable(),
  origin: z.enum(E.OBSERVATION_ORIGINS),
  sourceRepresentation: z.string(),
  reason: z.string(),
  observedAt: timestamp,
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const ChatWatchlistMatch = z.object({
  entryId: z.string(),
  numberDisplay: z.string(),
  matchedAt: timestamp,
  evidence: z.array(EvidenceRef),
  restrictedEvidenceCount: z.number().int().min(0),
});
export type ChatWatchlistMatch = z.infer<typeof ChatWatchlistMatch>;

export const ChatSummary = z.object({
  id: z.string(),
  source: Source,
  channelLabel: z.enum([CHANNEL_LABELS.telegram, CHANNEL_LABELS.whatsapp]),
  externalAccountId: z.string(),
  externalChatId: z.string(),
  displayLabel: z.string(),
  inboxStatus: z.enum(E.INBOX_STATUSES),
  aiMode: AiMode,
  revision,
  controller: PrincipalRef.nullable(),
  originLabel: z.enum(ORIGIN_LABELS),
  initiatedBy: z.enum(E.INITIATED_BY),
  initiationBasis: z.enum(E.INITIATION_BASES).nullable(),
  firstObservedDirection: Direction.nullable(),
  intakeAccount: z.boolean(),
  acknowledgementTemplate: z.literal(LABELS.acknowledgementTemplate).nullable(),
  review: z.object({
    state: z.enum(['idle', 'active', 'unavailable']),
    pending: z.number().int().min(0),
    unavailable: z.number().int().min(0),
  }),
  watchlistMatches: z.array(ChatWatchlistMatch),
  messageCount: z.number().int().min(0),
  lastActivityAt: timestamp,
  createdAt: timestamp,
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const RegisterChatRequest = z.object({
  source: Source,
  externalAccountId: id,
  externalChatId: id,
  displayLabel: label,
});
export type RegisterChatRequest = z.infer<typeof RegisterChatRequest>;
export const RegisterChatResponse = z.object({ chat: ChatSummary, created: z.boolean() });

export const ListChatsQuery = z.object({
  inboxStatus: z.enum(E.INBOX_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.listLimitMax).default(LIMITS.listLimitDefault),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListChatsQuery = z.infer<typeof ListChatsQuery>;
export const ListChatsResponse = z.object({ chats: z.array(ChatSummary), cursor: z.string() });

// ---- Dispatch, control, composer, decisions ----

export const DispatchRequest = z.object({
  chatIds: z
    .array(id)
    .min(LIMITS.dispatchMin)
    .max(LIMITS.dispatchMax)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'chatIds must be unique' }),
});
export type DispatchRequest = z.infer<typeof DispatchRequest>;
export const DispatchResponse = z.object({
  dispatchId: z.string(),
  results: z.array(
    z.object({ chatId: z.string(), status: z.enum(E.DISPATCH_OUTCOMES), aiMode: AiMode, revision }),
  ),
});
export type DispatchResponse = z.infer<typeof DispatchResponse>;

export const ControlRequest = z.object({ action: z.enum(E.CONTROL_ACTIONS), expectedRevision: revision });
export type ControlRequest = z.infer<typeof ControlRequest>;
export const ControlResponse = z.object({ chat: ChatSummary, changedAt: timestamp });

export const OfficerMessageRequest = z.object({
  text: z.string().min(1).max(LIMITS.messageTextMax),
  expectedRevision: revision,
});
export type OfficerMessageRequest = z.infer<typeof OfficerMessageRequest>;

export const OfficerDecisionRequest = z.object({
  decision: z.literal('leave_unanswered'),
  messageId: id,
  expectedRevision: revision,
});
export type OfficerDecisionRequest = z.infer<typeof OfficerDecisionRequest>;

// ---- Timeline ----

export const Capture = z.object({
  id: z.string(),
  status: z.enum(E.CAPTURE_STATUSES),
  kind: z.literal('mirsad_rendered_capture'),
  artifactId: z.string().nullable(),
  sha256: z.string().nullable(),
  attempts: z.number().int().min(0),
  errorCode: z.string().nullable(),
  retryable: z.boolean(),
  updatedAt: timestamp,
});
export type Capture = z.infer<typeof Capture>;

export const ReviewState = z.object({
  status: z.enum(E.REVIEW_STATUSES),
  outcome: z.enum(E.REVIEW_OUTCOMES).nullable(),
  updatedAt: timestamp,
});
export type ReviewState = z.infer<typeof ReviewState>;

export const Message = z.object({
  id: z.string(),
  chatId: z.string(),
  direction: Direction.nullable(),
  origin: z.enum(E.MESSAGE_ORIGINS),
  text: z.string().nullable(),
  originalCaptured: z.boolean(),
  unsupportedContent: z.array(z.string()),
  sentAt: timestamp.nullable(),
  receivedAt: timestamp,
  source: z.object({
    channel: Source,
    captureMethod: CaptureMethod,
    sourceEventId: z.string().nullable(),
    sourceMessageId: z.string().nullable(),
  }),
  sender: z.object({ externalId: z.string().nullable(), displayName: z.string().nullable() }).nullable(),
  author: PrincipalRef.nullable(),
  sendStatus: z.literal('simulated').nullable(),
  sendStatusLabel: z.literal(LABELS.simulatedSend).nullable(),
  capture: Capture.nullable(),
  review: ReviewState.nullable(),
  editedAtSource: z.boolean(),
  deletedAtSource: z.boolean(),
  position: z.number().int(),
});
export type Message = z.infer<typeof Message>;
export const OfficerMessageResponse = z.object({ message: Message });

export const MessageEvent = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  type: z.enum(['edited', 'deleted']),
  text: z.string().nullable(),
  sourceEventId: z.string(),
  sourceOccurredAt: timestamp.nullable(),
  receivedAt: timestamp,
  captureMethod: CaptureMethod,
  capture: Capture.nullable(),
  review: ReviewState.nullable(),
  position: z.number().int(),
});
export type MessageEvent = z.infer<typeof MessageEvent>;

const detailValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const CaseAction = z.object({
  id: z.string(),
  chatId: z.string(),
  type: z.enum(E.CASE_ACTION_TYPES),
  actor: PrincipalRef.nullable(),
  messageId: z.string().nullable(),
  fromMode: AiMode.nullable(),
  toMode: AiMode.nullable(),
  revision: z.number().int().nullable(),
  detail: z.record(z.string(), detailValue).nullable(),
  occurredAt: timestamp,
  position: z.number().int(),
});
export type CaseAction = z.infer<typeof CaseAction>;
export const OfficerDecisionResponse = z.object({ caseAction: CaseAction, created: z.boolean() });

export const Finding = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  messageEventId: z.string(),
  kind: z.enum(E.FINDING_KINDS),
  label: z.enum(FINDING_LABELS),
  quote: z.string(),
  extractedValue: z.string(),
  concern: z.enum(E.CONCERNS).nullable(),
  changedFrom: z.string().nullable(),
  caseReferenceId: z.string().nullable(),
  note: z.string(),
  createdAt: timestamp,
  position: z.number().int(),
});
export type Finding = z.infer<typeof Finding>;

export const CaseReference = z.object({
  id: z.string(),
  chatId: z.string(),
  kind: z.enum(E.CASE_REFERENCE_KINDS),
  paymentHosts: z.array(z.string()),
  sourceNote: z.string(),
  recordedBy: PrincipalRef,
  recordedAt: timestamp,
});
export type CaseReference = z.infer<typeof CaseReference>;

export const CaseReferenceRequest = z.object({
  kind: z.enum(E.CASE_REFERENCE_KINDS),
  paymentHosts: z.array(z.string().trim().toLowerCase().min(1).max(LIMITS.hostnameMax)).min(1).max(LIMITS.paymentHostsMax),
  sourceNote: z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax),
});
export type CaseReferenceRequest = z.infer<typeof CaseReferenceRequest>;
export const CaseReferenceResponse = z.object({ caseReference: CaseReference, findingsCreated: z.number().int().min(0) });

export const Timeline = z.object({
  chat: ChatSummary,
  messages: z.array(Message),
  messageEvents: z.array(MessageEvent),
  caseActions: z.array(CaseAction),
  findings: z.array(Finding),
  caseReferences: z.array(CaseReference),
  cursor: z.string(),
});
export type Timeline = z.infer<typeof Timeline>;

export const CaptureRetryResponse = z.object({ capture: Capture });

// ---- Watchlist ----

export const WatchlistEntry = z.object({
  id: z.string(),
  number: z.object({ e164: z.string().nullable(), display: z.string(), exactMatchEligible: z.boolean() }),
  status: z.enum(E.WATCHLIST_STATUSES),
  statusLabel: z.enum([LABELS.needsReview, LABELS.approved, LABELS.cleared]),
  revision,
  newEvidenceSinceReview: z.boolean(),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  evidence: z.array(EvidenceRef),
  restrictedEvidenceCount: z.number().int().min(0),
  matches: z.array(z.object({ chatId: z.string(), matchedAt: timestamp })),
  lastDecision: z
    .object({ decision: z.enum(E.WATCHLIST_DECISIONS), reason: z.string(), officer: PrincipalRef, decidedAt: timestamp })
    .nullable(),
  canReview: z.boolean(),
});
export type WatchlistEntry = z.infer<typeof WatchlistEntry>;
export const ListWatchlistResponse = z.object({ entries: z.array(WatchlistEntry), cursor: z.string() });

export const WatchlistReviewRequest = z.object({
  decision: z.enum(E.WATCHLIST_DECISIONS),
  reason: z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax),
  expectedRevision: revision,
});
export type WatchlistReviewRequest = z.infer<typeof WatchlistReviewRequest>;
export const WatchlistReviewResponse = z.object({ entry: WatchlistEntry });

// ---- Extensions: me, status, health ----

export const MeResponse = z.object({
  principal: z.object({
    id: z.string(),
    kind: z.enum(E.PRINCIPAL_KINDS),
    displayName: z.string(),
    workspaceId: z.string(),
  }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const HealthResponse = z.object({ status: z.literal('ok') });

export const Status = z.object({
  service: z.object({ version: z.string(), startedAt: timestamp }),
  storage: z.object({ database: z.string(), evidenceDirectory: z.string() }),
  workers: z.object({
    capture: z.object({ pending: z.number().int(), failed: z.number().int() }),
    review: z.object({ pending: z.number().int(), running: z.number().int(), unavailable: z.number().int() }),
  }),
  reviewer: z.object({ kind: z.enum(E.REVIEWER_KINDS), modelId: z.string().nullable(), reachable: z.boolean() }),
  channels: z.object({
    telegram: z.object({
      fixtureReplay: z.literal('available'),
      liveConnector: z.enum(['disabled', 'enabled']),
      readiness: z.enum(E.READINESS_STATES),
      readinessRecordedAt: timestamp.nullable(),
    }),
    whatsapp: z.object({ status: z.literal('not_started'), gate: z.string() }),
  }),
});
export type Status = z.infer<typeof Status>;

// ---- Envelopes ----

export const ErrorEnvelope = z.object({
  success: z.literal(false),
  data: z.null(),
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

/** Every named component schema, for the OpenAPI generator (Task 10). */
export const CONTRACT_SCHEMAS = {
  Source, CaptureMethod, Direction, AiMode, PrincipalRef, IntakeEvent, IngestRequest, IngestResult,
  EvidenceRef, ChatSummary, RegisterChatRequest, RegisterChatResponse, ListChatsResponse,
  DispatchRequest, DispatchResponse, ControlRequest, ControlResponse, OfficerMessageRequest, OfficerMessageResponse,
  OfficerDecisionRequest, OfficerDecisionResponse, Capture, ReviewState, Message, MessageEvent, CaseAction,
  Finding, CaseReference, CaseReferenceRequest, CaseReferenceResponse, Timeline, CaptureRetryResponse,
  WatchlistEntry, ListWatchlistResponse, WatchlistReviewRequest, WatchlistReviewResponse, MeResponse,
  HealthResponse, Status, ErrorEnvelope,
} as const;
