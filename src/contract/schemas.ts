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
  officerContextMax: 500,
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
  /** Present attachment kinds used to route a live edit for officer review. The file or pin payload is never imported. */
  reviewAttachments: z.array(z.enum(['document', 'location', 'venue', 'forwarded', 'blockquote'])).max(5).optional(),
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
  restrictedEvidence: z.boolean(),
});
export type ChatWatchlistMatch = z.infer<typeof ChatWatchlistMatch>;

const TelegramReviewReason = z.enum(['document', 'location', 'link', 'payment_link', 'bank_details', 'conversation_review', 'model_payment_link']);
const MeetingSource = z.object({ messageId: id, messageEventId: id });
const LowerConcern = z.object({
  kind: z.literal('meeting_arranged'), assessedAt: timestamp,
  sources: z.object({ agreement: MeetingSource, time: MeetingSource, place: MeetingSource, date: MeetingSource.optional() }),
});

/**
 * What a first-time contact wrote, for a chat still under New messages: the first message as a masked one-line preview,
 * so the officer can choose whom to dispatch without the inbox repeating a link, number or contact detail.
 */
const FirstContact = z.object({
  messageId: id,
  at: timestamp,
  preview: z.string().nullable(),
  notCaptured: z.array(z.string()),
  deleted: z.boolean(),
  incomingCount: z.number().int().min(1),
});

// ---- Citizen reports (Mirsad Android scam report, version 1; see mirsad-android/docs/EVIDENCE_SCHEMA.md) ----

const reportList = z.array(z.string().trim().min(1).max(2048)).max(50);
/** A scam report exactly as the phone app writes it. Unknown keys are ignored, so a newer app can add fields. */
export const CitizenReport = z.object({
  reportId: z.string().regex(/^mrs-[0-9a-f]{12}$/),
  version: z.literal(1),
  createdAt: timestampIn,
  channel: z.enum(['CALL', 'SMS', 'CHAT']),
  level: z.enum(['ALLOW', 'WARN', 'HOLD']),
  score: z.number().min(0).max(1),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)).max(64),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  artifacts: z.object({
    sender: z.string().trim().min(1).max(64).nullable(),
    senderType: z.enum(['NUMBER', 'ALPHANUMERIC', 'CONTACT', 'UNKNOWN']),
    urls: reportList, domains: reportList, ibans: reportList, emails: reportList,
    wallets: reportList, handles: reportList, phones: reportList,
  }),
  language: z.string().max(32),
  appVersion: z.string().max(64),
  modelVersion: z.string().max(64),
  synthetic: z.boolean(),
  text: z.string().max(LIMITS.messageTextMax).nullable(),
});
export type CitizenReport = z.infer<typeof CitizenReport>;

export const CitizenReportImportRequest = z.object({
  report: z.unknown().describe('The report JSON file as shared from Mirsad Android (scam report, version 1).'),
  demo: z.boolean().optional().describe('Import a Demo or test report from the app. It is labelled Demo and never reaches the watchlist.'),
});
export type CitizenReportImportRequest = z.infer<typeof CitizenReportImportRequest>;
export const CitizenReportImportResponse = z.object({
  chatId: id, messageId: id, created: z.boolean(), demo: z.boolean(),
  watchlistNumbers: z.number().int().min(0).describe('Numbers from the report added to the phone watchlist for review.'),
});

/** The reports in one citizen report chat, oldest first, as the officer reads them. */
export const CitizenReportView = z.object({
  messageId: id, reportId: z.string(), createdAt: timestamp, importedAt: timestamp, importedBy: PrincipalRef.nullable(),
  demo: z.boolean(), channel: z.enum(['CALL', 'SMS', 'CHAT']), level: z.enum(['ALLOW', 'WARN', 'HOLD']), score: z.number(),
  reasonCodes: z.array(z.string()), fingerprint: z.string(), textShared: z.boolean(),
  artifacts: CitizenReport.shape.artifacts,
});

/** A contact an officer flagged as a scammer, while the flagged number stays approved on the phone watchlist. */
const Suspect = z.object({
  watchlistEntryId: id,
  numberDisplay: z.string(),
  flaggedAt: timestamp,
  flaggedBy: PrincipalRef.nullable(),
});

export const ChatSummary = z.object({
  id: z.string(),
  source: Source,
  channelLabel: z.enum([CHANNEL_LABELS.telegram, CHANNEL_LABELS.citizen_report]),
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
  telegramReplyHold: z.object({
    contactOptedOut: z.boolean(),
    officerReview: z.object({ actionId: id, messageId: id, reason: TelegramReviewReason }).nullable(),
    evidenceItems: z.array(z.object({ actionId: id, messageId: id, messageEventId: id.nullable(), reason: TelegramReviewReason })),
  }),
  review: z.object({
    state: z.enum(['idle', 'active', 'unavailable']),
    pending: z.number().int().min(0),
    unavailable: z.number().int().min(0),
  }),
  watchlistMatches: z.array(ChatWatchlistMatch),
  lowerConcern: LowerConcern.nullable(),
  previousLowerConcern: LowerConcern.nullable(),
  firstContact: FirstContact.nullable(),
  suspect: Suspect.nullable(),
  /** For a Citizen report chat: how many reports it holds and the newest one's verdict on the phone. */
  citizenReport: z.object({ count: z.number().int().min(1), latestLevel: z.enum(['ALLOW', 'WARN', 'HOLD']),
    latestChannel: z.enum(['CALL', 'SMS', 'CHAT']), demo: z.boolean() }).nullable(),
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

const OfficerContext = z.string().trim().min(1).max(LIMITS.officerContextMax);

export const DispatchRequest = z.object({
  chatIds: z
    .array(id)
    .min(LIMITS.dispatchMin)
    .max(LIMITS.dispatchMax)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'chatIds must be unique' }),
  officerContext: OfficerContext.nullable().optional(),
  participantPermissionRecorded: z.literal(true).optional().describe('The officer confirms that each selected Telegram participant has already consented in that chat to AI replies, fraud screening and the configured AI provider.'),
  expectedTestMode: z.literal(true).optional(),
  replyAgain: z.literal(true).optional().describe('Explicitly request a message in each eligible selected chat, including a retry or follow-up if the conversation was already answered.'),
  replyToMessageId: id.optional().describe('The specific contact message the officer chose to retry or follow up on.'),
  replyToHeadPosition: z.number().int().positive().optional().describe('The timeline target’s headPosition when the officer chose it, including message changes and officer decisions.'),
}).refine(({ chatIds, officerContext }) => officerContext === undefined || chatIds.length === 1, {
  path: ['officerContext'], message: 'Select one chat to set or clear an officer briefing.',
}).refine(body => !body.expectedTestMode || body.participantPermissionRecorded, {
  path: ['expectedTestMode'], message: 'Test dispatch requires recorded participant permission.',
}).refine(body => !body.replyToMessageId || body.chatIds.length === 1, {
  path: ['replyToMessageId'], message: 'Select one chat when specifying a particular message.',
}).refine(body => !body.replyToMessageId || body.replyAgain, {
  path: ['replyToMessageId'], message: 'Select a specific message only when asking for another reply.',
}).refine(body => body.replyToHeadPosition === undefined || body.replyToMessageId !== undefined, {
  path: ['replyToHeadPosition'], message: 'A conversation position requires a specific reply target.',
});
export type DispatchRequest = z.infer<typeof DispatchRequest>;

/**
 * What a Dispatch did in a chat on the linked live Telegram account. `reply` is `queued` once a reply request is on
 * record for the reply worker; `sent` is reported later, by the timeline, when Telegram confirmed the message.
 */
export const TelegramDispatchOutcome = z.object({
  permission: z.enum(E.TELEGRAM_AI_PERMISSIONS),
  /** Whether Ali answers the contact's future messages without another Dispatch, or what stops him. */
  automaticReplies: z.enum(E.TELEGRAM_AUTOMATIC_STATES),
  reply: z.enum(['queued', 'none']),
  kind: z.enum(E.TELEGRAM_REPLY_REQUEST_KINDS).optional(),
  /** Why no reply was queued; null when one was. */
  reason: z.enum(E.TELEGRAM_NO_REPLY_REASONS).nullable(),
  /** True when the officer can still ask for a reply by confirming a deliberate Dispatch (`replyAgain`). */
  confirmable: z.boolean(),
  requestId: z.string().nullable(),
  /** The contact's message the request refers to. */
  messageId: z.string().nullable(),
});
export type TelegramDispatchOutcome = z.infer<typeof TelegramDispatchOutcome>;

export const DispatchResponse = z.object({
  dispatchId: z.string(),
  results: z.array(
    z.object({
      chatId: z.string(), status: z.enum(E.DISPATCH_OUTCOMES), aiMode: AiMode, revision,
      /** Present only for a chat on the linked live Telegram account. */
      telegram: TelegramDispatchOutcome.optional(),
    }),
  ),
});
export type DispatchResponse = z.infer<typeof DispatchResponse>;

export const DispatchByPhoneRequest = z.strictObject({
  phoneNumber: z.string().trim().min(1).max(64).describe('One complete international phone number starting with + or 00.'),
  officerContext: OfficerContext.nullable().optional(),
  participantPermissionRecorded: z.literal(true).optional().describe('The officer confirms permission for AI replies and screening in the uniquely verified conversation.'),
});
export type DispatchByPhoneRequest = z.infer<typeof DispatchByPhoneRequest>;
export const DispatchByPhoneResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('dispatched'), chatId: id, dispatch: DispatchResponse }),
  z.object({ outcome: z.literal('no_verified_chat') }),
  z.object({ outcome: z.literal('ambiguous') }),
]);
export type DispatchByPhoneResponse = z.infer<typeof DispatchByPhoneResponse>;

export const InvestigationOpenerRequest = z.strictObject({
  officerContext: OfficerContext,
  language: z.enum(['english', 'arabic']),
});
export type InvestigationOpenerRequest = z.infer<typeof InvestigationOpenerRequest>;
export const InvestigationOpenerResponse = z.object({ draft: z.string() });

export const ControlRequest = z.object({ action: z.enum(E.CONTROL_ACTIONS), expectedRevision: revision });
export type ControlRequest = z.infer<typeof ControlRequest>;
export const ControlResponse = z.object({ chat: ChatSummary, changedAt: timestamp });
export const ErasePreview = z.object({ chatCount: z.number().int().nonnegative(), snapshot: z.string() });
export const EraseRequest = z.strictObject({ expectedSnapshot: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) });
export const EraseResponse = z.object({ chatCount: z.number().int().nonnegative(), filesPending: z.number().int().nonnegative() });
const erasedCount = z.number().int().nonnegative();
export const TelegramEraseResponse = z.object({ status: z.enum(['completed', 'in_progress']), total: erasedCount,
  removed: erasedCount, skipped: erasedCount, failed: erasedCount, uncertain: erasedCount, pending: erasedCount,
  excluded: z.object({ unverified: erasedCount, expired: erasedCount, rights: erasedCount, unsupported: erasedCount }),
  remainingChats: z.array(z.object({chatId: id, removed: erasedCount, skipped: erasedCount, uncertain: erasedCount, failed: erasedCount, pending: erasedCount})),
  manualHistoryMayRemain: z.literal(true) });
export type TelegramEraseResponse = z.infer<typeof TelegramEraseResponse>;

export const OfficerMessageRequest = z.object({
  text: z.string().min(1).max(LIMITS.messageTextMax),
  expectedRevision: revision,
});
export type OfficerMessageRequest = z.infer<typeof OfficerMessageRequest>;

export const OfficerDecisionRequest = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('leave_unanswered'), messageId: id, expectedRevision: revision }),
  z.object({ decision: z.literal('mark_reviewed'), reviewActionId: id, expectedRevision: revision }),
]);
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
  /** phone: the sender's number exactly as the source supplied it as sender metadata (raw, not normalized). */
  sender: z.object({ externalId: z.string().nullable(), displayName: z.string().nullable(), phone: z.string().nullable() }).nullable(),
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
  type: z.enum(['edited', 'deleted', 'conflicting_copy']),
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

/**
 * Replies in a chat on the linked live Telegram account, as the officer needs them before and after Dispatch: the
 * permission on record, whether future messages are answered automatically, where the contact's latest message stands,
 * and the officer's latest reply request with its outcome.
 */
export const TelegramReplies = z.object({
  permission: z.enum(E.TELEGRAM_AI_PERMISSIONS),
  automatic: z.enum(E.TELEGRAM_AUTOMATIC_STATES),
  target: z.object({
    messageId: z.string(), state: z.enum(E.TELEGRAM_REPLY_TARGET_STATES), headPosition: z.number().int().positive(),
  }).nullable(),
  /** Why a Dispatch would queue nothing right now even if the officer confirmed it; null when it could. */
  blocked: z.enum(E.TELEGRAM_NO_REPLY_REASONS).nullable(),
  request: z.object({
    id: z.string(),
    messageId: z.string().nullable(),
    kind: z.enum(E.TELEGRAM_REPLY_REQUEST_KINDS),
    status: z.enum(E.TELEGRAM_REPLY_REQUEST_STATUSES),
    requestedAt: timestamp,
    requestedBy: PrincipalRef.nullable(),
    /** The message Telegram confirmed, once `status` is `sent`. */
    replyMessageId: z.string().nullable(),
    /** The failure's code, once `status` is `failed`; never message text. */
    failureCode: z.string().nullable(),
  }).nullable(),
});
export type TelegramReplies = z.infer<typeof TelegramReplies>;

export const Timeline = z.object({
  chat: ChatSummary,
  telegramAiPermission: z.enum(E.TELEGRAM_AI_PERMISSIONS).optional(),
  /** Present only for a chat on the linked live Telegram account. */
  telegramReplies: TelegramReplies.optional(),
  testSession: z.object({ position: z.number().int().positive(), previousMessageIds: z.array(id), previousReferenceIds: z.array(id) }).nullable(),
  messages: z.array(Message),
  messageEvents: z.array(MessageEvent),
  caseActions: z.array(CaseAction),
  findings: z.array(Finding),
  caseReferences: z.array(CaseReference),
  citizenReports: z.array(CitizenReportView),
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
  restrictedEvidence: z.boolean(),
  matches: z.array(z.object({ chatId: z.string(), matchedAt: timestamp })),
  lastDecision: z
    .object({ decision: z.enum(E.WATCHLIST_DECISIONS), reason: z.string().nullable(), officer: PrincipalRef, decidedAt: timestamp })
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

const e164List = z.array(z.string().regex(/^\+[1-9]\d{6,14}$/));
/** The signed phone blocklist (Mirsad Android blocklist import file, version 1, with keyId, expiresAt and signature). */
export const BlocklistFile = z.object({
  version: z.literal(1),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  issuer: z.string(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  note: z.string(),
  numbers: e164List,
  domains: z.array(z.string()),
  fingerprints: z.array(z.string().regex(/^[0-9a-f]{16}$/)),
  signature: z.string().describe('ECDSA P-256 with SHA-256, DER, base64, over the signed text described in contracts/README.md.'),
});
export const BlocklistResponse = z.object({ file: BlocklistFile });
export const BlocklistKeyResponse = z.object({
  keyId: z.string(), issuer: z.string(),
  publicKey: z.string().describe('SubjectPublicKeyInfo, DER, base64.'),
});

export const ScammerFlagRequest = z.object({
  phone: z.string().trim().min(1).max(40)
    .describe('The contact’s number in international format, starting with + or 00.'),
  reason: z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax)
    .describe('Why the officer judges the contact a scammer; kept with the watchlist decision.'),
});
export type ScammerFlagRequest = z.infer<typeof ScammerFlagRequest>;
export const ScammerFlagResponse = z.object({ entry: WatchlistEntry, created: z.boolean() });

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

export const OfficerLoginRequest = z.strictObject({
  username: z.string().min(1).max(64),
  // Two UTF-16 code units may encode one Unicode code point.
  password: z.string().min(1).max(256).meta({ writeOnly: true, format: 'password' }),
  newPassword: z.string().min(1).max(256).meta({ writeOnly: true, format: 'password' }).optional(),
});
export const OfficerLoginResponse = z.union([
  z.object({ token: z.string() }),
  z.object({ passwordChangeRequired: z.literal(true) }),
]);
export const OfficerLogoutResponse = z.object({ loggedOut: z.literal(true) });

export const HealthResponse = z.object({ status: z.literal('ok') });
export const DmRepliesRequest = z.strictObject({ enabled: z.boolean() });
export const ConsentPromptRequest = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), manualDispatchOnly: z.literal(true).optional() }),
]);
export const ConsentPromptResponse = z.object({ enabled: z.boolean(), available: z.boolean(), manualDispatchOnly: z.literal(true).optional() });
export const ReplyPromptReloadResponse = z.strictObject({ version: z.string().regex(/^[a-f0-9]{12}$/), changed: z.boolean() });
export const DmRepliesResponse = z.object({
  enabled: z.boolean(), available: z.boolean(), mode: z.enum(['approved', 'all_private', 'off']),
});

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
  }),
});
export type Status = z.infer<typeof Status>;

// ---- Places directory (Abu Dhabi) ----

/** Only http(s) URLs may enter the directory: rows land in clickable hrefs, so javascript:/data: schemes must fail closed. */
const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((url) => /^https?:\/\//i.test(url), { message: 'Only http and https URLs are accepted.' });

export const PlaceRecord = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  name_ar: z.string().max(300).nullable(),
  location_link: httpUrl,
  urls: z.array(httpUrl).max(50),
  phones: z.array(z.string().min(1).max(32)).max(20),
  description: z.string().min(1).max(1000),
  category: z.string().min(1).max(120),
  address: z.string().max(500).nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  confidence: z.number().min(0).max(1).nullable(),
  source: z.enum(['overture', 'osm', 'google']),
  updated_at: z.iso.datetime(),
});
export type PlaceRecord = z.infer<typeof PlaceRecord>;

/**
 * What Mirsad's website shield found on a listing's website, as the map shows it: `harmful` (leads to gambling or other
 * harmful content, a data-theft script, or a public phishing feed listing), `suspicious` (a re-registered name
 * redirecting to an unrelated site), `parked` (expired or parked for sale) and `unconfirmed` (a low-confidence warning:
 * model scores, a young domain, a possible brand imitation; shown in the details, kept off the default filter).
 */
export const WebsiteFlag = z.enum(['harmful', 'suspicious', 'parked', 'unconfirmed']);
export type WebsiteFlag = z.infer<typeof WebsiteFlag>;
/** The website shield's finding categories (format mirsad-places-website-checks/1, `category`). */
export const WebsiteFinding = z.enum([
  'harmful_redirect', 'data_theft', 'feed_listed', 'brand_mismatch', 'unrelated_redirect', 'parked', 'other_warning',
  'none', 'not_checked',
]);
export type WebsiteFinding = z.infer<typeof WebsiteFinding>;

/** The latest website check of one listing's website, imported from a Places website checks report. */
export const PlaceWebsiteCheck = z.object({
  website: z.string().min(1).max(2000),
  host: z.string().max(300).nullable(),
  decision: z.enum(['allow', 'warn', 'block']).nullable(),
  riskScore: z.number().min(0).max(100).nullable(),
  finding: WebsiteFinding,
  /** The website shield's own wording of the finding. */
  findingEn: z.string().max(500),
  findingAr: z.string().max(500),
  flag: WebsiteFlag.nullable(),
  reasons: z.array(z.object({ code: z.string(), en: z.string(), ar: z.string() })).max(10),
  /** Where the website ends up after redirects. Text only: never a link, it may be the harmful site. */
  finalUrl: z.string().max(2000).nullable(),
  /** The website shield's evidence case reference, e.g. SS-989EE731, on every warn and block. */
  evidenceRef: z.string().max(64).nullable(),
  checkedAt: z.string().nullable(),
  importedAt: z.iso.datetime(),
});
export type PlaceWebsiteCheck = z.infer<typeof PlaceWebsiteCheck>;
export const WebsiteFlagCounts = z.object({
  harmful: z.number().int().min(0),
  suspicious: z.number().int().min(0),
  parked: z.number().int().min(0),
  unconfirmed: z.number().int().min(0),
});
export type WebsiteFlagCounts = z.infer<typeof WebsiteFlagCounts>;

export const PlacesSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  /** Visible map area as minLng,minLat,maxLng,maxLat. */
  bbox: z.string().trim().max(120).optional(),
  /** Only listings whose website was flagged: harmful, suspicious or parked (`flagged`), or one kind. */
  websiteFlag: z.enum(['flagged', ...WebsiteFlag.options]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(200).optional(),
});
export type PlacesSearchQuery = z.infer<typeof PlacesSearchQuery>;
export const PlacesSearchResponse = z.object({
  places: z.array(PlaceRecord),
  nextCursor: z.string().nullable(),
  /** Distinct categories of the whole match set, so the filter dropdown never depends on the visible page. */
  categories: z.array(z.string()),
  /** The website flag of each place on this page that has one; places without a flag are left out. */
  websiteFlags: z.record(z.string(), WebsiteFlag),
  /** Flagged listings per kind for the text and category search, over the whole directory (not only the map view). */
  websiteFlagCounts: WebsiteFlagCounts,
});
export type PlacesSearchResponse = z.infer<typeof PlacesSearchResponse>;
export const PlacesDetailResponse = z.object({
  place: PlaceRecord,
  /** The listing's most serious website check, or null when no audit report covered it. */
  websiteCheck: PlaceWebsiteCheck.nullable(),
});
export type PlacesDetailResponse = z.infer<typeof PlacesDetailResponse>;

// ---- Envelopes ----

export const ErrorEnvelope = z.object({
  success: z.literal(false),
  data: z.null(),
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

/** Every named component schema, for the OpenAPI generator (Task 10). */
export const CONTRACT_SCHEMAS = {
  ErasePreview, EraseRequest, EraseResponse, TelegramEraseResponse,
  Source, CaptureMethod, Direction, AiMode, PrincipalRef, IntakeEvent, IngestRequest, IngestResult,
  EvidenceRef, ChatSummary, RegisterChatRequest, RegisterChatResponse, ListChatsResponse,
  DispatchRequest, DispatchResponse, DispatchByPhoneRequest, DispatchByPhoneResponse, ControlRequest, ControlResponse, OfficerMessageRequest, OfficerMessageResponse,
  InvestigationOpenerRequest, InvestigationOpenerResponse,
  OfficerDecisionRequest, OfficerDecisionResponse, Capture, ReviewState, Message, MessageEvent, CaseAction,
  Finding, CaseReference, CaseReferenceRequest, CaseReferenceResponse, Timeline, CaptureRetryResponse,
  WatchlistEntry, ListWatchlistResponse, WatchlistReviewRequest, WatchlistReviewResponse, ScammerFlagRequest, ScammerFlagResponse, CitizenReportImportRequest, CitizenReportImportResponse, BlocklistResponse, BlocklistKeyResponse, MeResponse,
  PlaceRecord, PlacesSearchResponse, PlacesDetailResponse, WebsiteFlag, WebsiteFinding, PlaceWebsiteCheck, WebsiteFlagCounts,
  OfficerLoginRequest, OfficerLoginResponse, OfficerLogoutResponse, HealthResponse, Status, ErrorEnvelope,
  DmRepliesRequest, DmRepliesResponse, ConsentPromptRequest, ConsentPromptResponse, ReplyPromptReloadResponse,
} as const;
