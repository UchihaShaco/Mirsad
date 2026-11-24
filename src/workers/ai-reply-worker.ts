/**
 * AI reply worker (design section 20) for opt-in replies in explicitly approved Telegram chats.
 *
 * A claim transaction prioritizes an officer's queued request, then the oldest eligible incoming turn in an active
 * chat. A follow-up request identifies both the contact's message and the conversation head the officer saw.
 * The worker can send a local consent invitation before Dispatch. For approved-list installations it can also start
 * an enrolled chat when configured to do so. The configured model drafts the reply
 * and the reply guard checks it. A blocked draft is written once more. A second transaction checks that
 * nothing changed meanwhile (still AI active, same latest message);
 * only then is the reply sent through the bot's business connection. The sent message is stored through the same intake
 * function as the connector's own updates, so Telegram's copy of it, if one arrives later, is a duplicate; an
 * `ai_reply_sent` case action records the reply source. A failure is kept as an `ai_reply_failed` case action, so
 * that message is not tried again, not even after a restart; the contact's next message is. One reply at a time. Logs
 * carry IDs, codes and rule names only, never text.
 */
import { isDeepStrictEqual } from 'node:util';
import { openReplyRequest, REPLY_ENROLLMENTS, type ReplyRequest } from '../services/telegram-reply-requests.ts';
import { recoverExpiredTelegramSends } from '../services/telegram-send-recovery.ts';
import { BotApiError, type BotSender, type SentMessage } from '../adapters/telegram/bot-api.ts';
import { MEDIA_KINDS } from '../adapters/telegram/types.ts';
import { approvedReplyChatIds, chatScopeOf, isChatInScope, type ChatScope } from '../adapters/telegram/chat-scope.ts';
import { findLiveBindings, LIVE_GATES, missingLiveGates, type LiveBinding } from '../adapters/telegram/live-connector.ts';
import type { Config } from '../config.ts';
import { rememberMessageProof, verifiedTelegramSourceSql } from '../adapters/telegram/message-proof.ts';
import { hasTelegramQuote } from '../storage/repos/messages.ts';
import { maskUrls, normalizeTelegramLink } from '../domain/links.ts';
import { IngestRequest } from '../contract/schemas.ts';
import { systemClock, type Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';
import { currentAliPrompt } from '../replies/ali-prompt.ts';
import { InvalidReplyDraftError, isArabicReplyTurn, ReplyGenerationError, type ReplyGenerator, type ReplyInvestigationContext, type ReplyOfferMemory, type ReplyTurn } from '../replies/reply-generator.ts';
import { hasInternalReplyContent, MAX_REPLY_CHARS, MODEL_PAYMENT_LINK_REASON, SILENCE_EXPLANATION_REQUEST, type AliDecision } from '../replies/ali-decision.ts';
import { OpenRouterReplyError } from '../replies/openrouter-reply-generator.ts';
import { candidatePaymentLinks, type PaymentLinkCandidate } from '../replies/payment-link-candidates.ts';
import { hasAnsweredIdentityRepeat } from '../replies/reply-duplicates.ts';
import { blockedRuleForTurn, correctionFor, isSellerOrDisclosureClaim, ReplyBlockedError, type ReplyGuardRule } from '../replies/reply-guard.ts';
import { REPLY_FRESHNESS_MS, REPLY_QUIET_MS } from '../replies/reply-timing.ts';
import { readDispatchBrief } from '../services/dispatch.ts';
import { currentTestMessageSql, readChatTestWindow } from '../services/chat-test-session.ts';
import { rememberErasedSource } from '../services/chat-erasure-fence.ts';
import { assessMeeting, isRepeatedMeetingQuestion, recordLowerConcern } from '../services/lower-concern.ts';
import { ingest } from '../services/intake.ts';
import { applyModeChange } from '../services/mode-change.ts';
import { DM_CONSENT_NOTICE, dmConsentForTurn, hasOfficerDispatchApproval, isOfficerEnrolledConsent, markDmConsentNotice,
  officerDispatchScopeSql, recordedDmConsent } from '../services/telegram-dm-consent.ts';
import { dispatchPermissionForTurn, permittedDispatchSourceSql, resumeDispatchPermissions } from '../services/telegram-dispatch-permission.ts';
import { dmPolicyKey, dmPolicyMode, invitationsEnabled, readConsentPromptPolicy, readDmPolicy, reconcileDmPolicy, suspendDmPolicies, type DmPolicy } from '../services/telegram-dm-policy.ts';
import { backfillTelegramReplyHolds, isTelegramReplyHeld, recordConversationReview, recordModelPaymentLinkReview, reviewedModelPaymentLinkKeys } from '../services/telegram-reply-holds.ts';
import type { Db, Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { findChatById } from '../storage/repos/chats.ts';
import type { ChatRow, MessageRow } from '../storage/rows.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';
import { eligibleReplySources, latestEditText, OfferMemory } from './offer-memory.ts';

/** What each AI-reply gate is called in a refusal, beside the live connector's own gates. */
export const AI_REPLY_GATES = {
  enabled: 'TELEGRAM_AI_REPLIES_ENABLED',
  consent: 'TELEGRAM_AI_REPLY_CONSENT_REFERENCE',
} as const;

export { REPLY_FRESHNESS_MS };
/** Maximum model attempts per phase, including any correction of an unusable public draft. */
export const REPLY_ATTEMPTS = 2;
// Telegram delegates payment-instruction wording to Ali's prompt.
const PAYMENT_INSTRUCTIONS_POLICY = 'prompt';
/** Maximum eligible source messages to consider before applying the model's context budget. */
const HISTORY_MESSAGES = 32;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const MS_PER_SECOND = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * MS_PER_SECOND;
const LIVE_CAPTURE_METHOD = 'telegram_business_live';

/** start() refused: `missing` names every gate that is not set (or not valid), never a value. */
export class AiRepliesGateError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Telegram AI replies refused to start; not set or not valid: ${missing.join(', ')}`);
    this.name = 'AiRepliesGateError';
    this.missing = missing;
  }
}

export interface AiReplyWorkerDeps {
  config: Pick<Config, 'telegram' | 'reviewAllowedCaptureMethods'>;
  db: Db;
  clock: Clock;
  logger: Logger;
  generator: ReplyGenerator;
  arabicGenerator?: ReplyGenerator;
  /** Null when no well-formed bot token is configured; start() then refuses. */
  sender: BotSender | null;
  /** Called after a reply was stored, so the capture worker renders it. */
  onReplyStored?: () => void;
  /** How often the worker looks for a message to answer besides being woken. */
  pollIntervalMs?: number;
}

export interface AiReplyWorker {
  /** Throws AiRepliesGateError, and does nothing else, unless every gate is set. */
  start(): void;
  forgetChat(chatId: string): void;
  wake(): void;
  idle(): Promise<void>;
  isIdle(): boolean;
  running(): boolean;
  /** Blocks new work and aborts generation as soon as the live connector stops. */
  disable(): void;
  stop(): Promise<void>;
}

interface ReplyJob {
  chatId: string;
  request?: ReplyRequest;
  officerPermission: boolean;
  sourceProof?: { connector: string; policyKey: string };
  kind: 'reply' | 'notice';
  policyRevision: number;
  /** A Pause or takeover invalidates work claimed at an earlier control revision, even after Resume AI. */
  revision: number;
  workspaceId: string;
  externalChatId: string;
  /** The incoming message the reply answers. */
  messageId: string;
  activityPosition: number;
  enrolledAfter: number;
  enrolledSecond: number;
  afterTelegramId: number | null;
}

interface Session {
  binding: LiveBinding;
  scope: ChatScope;
  policyKey: string;
  approvedIds: Set<string>;
  sender: BotSender;
  connectionId: string;
  /** JSON object mapping each approved external chat ID to its enrollment position and Telegram second. */
  enrollments: string;
  /** Whether a chat that was never started is started on the contact's first answerable message. */
  autoStart: boolean;
}

/** A chat in scope and its latest message, which awaits a reply. */
interface Waiting {
  request?: ReplyRequest;
  officerPermission?: boolean;
  sourceProof?: ReplyJob['sourceProof'];
  dispatchRequested?: boolean;
  afterTelegramId?: number;
  kind: ReplyJob['kind'];
  chat: ChatRow & { enrolled_after: number; enrolled_second: number; has_dispatch_permission: number };
  message: StoredLatestMessage;
}

/** Whether a drafted reply may still be sent: `not_answerable` means the message was deleted or went stale meanwhile. */
type Currency = 'current' | 'chat_missing' | 'mode_changed' | 'newer_message' | 'not_answerable' | 'history_changed' | 'reply_held';

/** Why a message got no reply, as the `ai_reply_failed` case action keeps it: codes, numbers and names, never text. */
interface Failure {
  code: string;
  status: number | null;
  /** The reply guard's rule, for a blocked reply. */
  rule?: ReplyGuardRule;
  /** Telegram's ID for a reply that was sent but could not be kept as this chat's message. */
  telegramMessageId?: number;
}

type HistoryRow = Pick<MessageRow, 'id' | 'direction' | 'text' | 'position' | 'received_at' | 'edited_at_source' | 'unsupported_content'> & {
  edited_text: string | null;
  payment_source_event_id: string | null;
};
type LatestMessage = MessageRow & { edited_text?: string | null };
type StoredLatestMessage = LatestMessage & { activity_at: string; activity_position: number };
type ReplyAttribution = { source: 'model'; model: string } | { source: 'consent_notice' };
interface DraftWarnings {
  links: Set<PaymentLinkCandidate>;
  conversation?: Extract<AliDecision, { kind: 'review' }>;
}
type DraftDecision = Exclude<AliDecision, { kind: 'review' }> | {
  kind: 'guard_silence'; reason: 'repeated_identity_question' | 'repeated_meeting_question'; higherConcern?: true
};

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** While replies are disabled, a later approval must start on a new contact turn. */
export function clearReplyEnrollments(db: Db): void {
  db.transaction(tx => {
    tx.run('DELETE FROM connector_state WHERE key=:key', { key: REPLY_ENROLLMENTS });
    tx.run('UPDATE telegram_dispatch_permissions SET suspended=1 WHERE suspended=0');
    suspendDmPolicies(tx);
  });
}

function reconcileEnrollments(tx: Tx, binding: LiveBinding, approvedChatIds: string[]): string {
  const key = { principal: binding.principal.id, key: REPLY_ENROLLMENTS };
  const row = tx.get<{ value: string }>('SELECT value FROM connector_state WHERE connector_id=:principal AND key=:key', key);
  const previous = row ? JSON.parse(row.value) as Record<string, { position: number; second: number }> : {};
  const latest = tx.get<{ position: number }>(
    `SELECT COALESCE(MAX(m.position), 0) AS position FROM messages m JOIN chats c ON c.id=m.chat_id
     WHERE c.channel_account_id=:account`, { account: binding.account.id })!;
  // Telegram dates have whole-second precision. Two turns in the enrollment second are ordered by local position.
  const floor = { position: latest.position, second: Math.floor(Date.parse(tx.now()) / MS_PER_SECOND) };
  const value = JSON.stringify(Object.fromEntries(approvedChatIds.map(id => [id, previous[id] ?? floor])));
  if (value !== row?.value) {
    tx.run(`INSERT INTO connector_state (connector_id, key, value, updated_at) VALUES (:principal, :key, :value, :at)
      ON CONFLICT(connector_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      { ...key, value, at: tx.now() });
  }
  return value;
}

function openSession(deps: AiReplyWorkerDeps): Session {
  const { telegram } = deps.config;
  const bindings = deps.db.transaction((tx) => findLiveBindings(tx));
  const [binding] = bindings;
  const approvedChatIds = approvedReplyChatIds(telegram).filter((id) => id !== String(binding?.ownerUserId));
  const gates = [
    ...(telegram.aiReplies.enabled ? [] : [AI_REPLY_GATES.enabled]),
    ...(telegram.aiReplies.consentReference ? [] : [AI_REPLY_GATES.consent]),
    ...missingLiveGates(telegram),
  ];
  const missing = [
    ...gates,
    ...(deps.sender === null && !gates.includes(LIVE_GATES.token) ? [LIVE_GATES.token] : []),
    ...(bindings.length === 1 ? [] : [LIVE_GATES.principal]),
    ...(telegram.chatScope === 'approved' && approvedChatIds.length === 0 && !gates.includes(LIVE_GATES.chats) ? [LIVE_GATES.chats] : []),
  ];
  if (missing.length > 0 || !binding || !deps.sender || !telegram.approvedConnectionId) throw new AiRepliesGateError(missing);
  const policyKey = dmPolicyKey(binding.account.id, telegram.approvedConnectionId);
  const enrollments = deps.db.transaction((tx) => {
    reconcileDmPolicy(tx, binding.principal.id, policyKey, binding.account.workspace_id, telegram.chatScope === 'all_private');
    resumeDispatchPermissions(tx, binding.principal.id, policyKey, binding.account.workspace_id);
    backfillTelegramReplyHolds(tx, binding.account.id, approvedChatIds, REPLY_FRESHNESS_MS, binding.principal.id);
    return reconcileEnrollments(tx, binding, approvedChatIds);
  });
  return {
    binding,
    scope: chatScopeOf(telegram),
    policyKey,
    approvedIds: new Set(approvedChatIds),
    sender: deps.sender,
    connectionId: telegram.approvedConnectionId,
    enrollments,
    autoStart: telegram.aiReplies.autoStart,
  };
}

function latestMessage(tx: Tx, chatId: string, anchorId?: string): StoredLatestMessage | undefined {
  const window = readChatTestWindow(tx, chatId);
  return tx.get<StoredLatestMessage>(
    `SELECT m.*, CASE WHEN m.edited_at_source = 1 THEN ${latestEditText} END AS edited_text,
            COALESCE(last.received_at, m.received_at) AS activity_at,
            COALESCE(last.position, m.position) AS activity_position
     FROM (SELECT m.* FROM messages m WHERE m.chat_id = :chatId AND ${currentTestMessageSql}
       ${anchorId ? 'AND m.id=:anchorId' : ''} ORDER BY m.position DESC LIMIT 1) m
     LEFT JOIN (SELECT e.position, e.received_at FROM message_events e JOIN messages m ON m.id = e.message_id
       WHERE e.chat_id = :chatId AND m.direction = 'incoming' AND e.capture_method = 'telegram_business_live' AND ${currentTestMessageSql}
         AND e.type IN ('recorded','edited','conflicting_copy') ORDER BY e.position DESC LIMIT 1) last ON 1=1`,
    { chatId, ...window, ...(anchorId && { anchorId }) },
  );
}

/** The earlier of when the message was sent (Telegram's date) and when Mirsad received it; NaN if neither parses. */
function earliestMs(message: Pick<MessageRow, 'sent_at' | 'received_at'>): number {
  const times = [message.sent_at, message.received_at]
    .filter((time): time is string => time !== null)
    .map((time) => Date.parse(time))
    .filter((ms) => Number.isFinite(ms));
  return times.length > 0 ? Math.min(...times) : Number.NaN;
}

/** Re-enabling invitations applies to new turns, including when older Telegram deliveries arrive late. */
function canInvite(policy: ReturnType<typeof readConsentPromptPolicy>, message: MessageRow): boolean {
  return invitationsEnabled(policy) && message.position > policy.position && earliestMs(message) >= policy.second * MS_PER_SECOND;
}

function liveReplyChat(session: Session, chat: ChatRow) {
  return { connector: session.binding.principal.id, policyKey: session.policyKey, listed: session.approvedIds.has(chat.external_chat_id) };
}

/** Pure: whether a chat's latest message is one the local model should answer now. */
export function isAnswerable(chat: Pick<ChatRow, 'external_chat_id'>, message: LatestMessage | undefined, nowMs: number,
  catchUpUntil: number | null = null, allowLocalMedia = false): message is LatestMessage {
  if (!message) return false;
  return (
    message.direction === 'incoming' &&
    message.origin === 'source' &&
    message.capture_method === LIVE_CAPTURE_METHOD &&
    message.original_captured === 1 &&
    message.deleted_at_source === 0 &&
    (!message.edited_at_source || message.telegram_edit_is_direct === 1) &&
    !hasTelegramQuote(JSON.parse(message.unsupported_content) as string[]) &&
    message.sender_external_id === chat.external_chat_id &&
    (allowLocalMedia || ((message.text ?? '').trim() !== '' && message.edited_text?.trim() !== '')) &&
    (nowMs - earliestMs(message) <= REPLY_FRESHNESS_MS || (catchUpUntil !== null && nowMs < catchUpUntil))
  );
}

function hasFinalOutcome(tx: Tx, messageId: string): boolean {
  const row = tx.get<{ found: number }>(
    `SELECT 1 AS found FROM case_actions WHERE
      (message_id=:messageId AND type IN ('ai_reply_failed','ai_reply_skipped','leave_unanswered','telegram_reply_requested'))
      OR (type='ai_reply_sent' AND json_extract(detail,'$.inReplyTo')=:messageId) LIMIT 1`,
    { messageId },
  );
  return row !== undefined;
}

interface ReplyHistory {
  hasSource: boolean;
  /** Keep the conversation intact for send checks, including what a short “yes” refers to. */
  turns: ReplyTurn[];
  modelTurns: ReplyTurn[];
  currentTurn: string[];
  memory?: ReplyOfferMemory;
  paymentLinks: PaymentLinkCandidate[];
  meeting: ReturnType<typeof assessMeeting>;
  investigation: ReplyInvestigationContext;
}

/** Eligible Telegram messages, with their latest edits, starting at the contact's latest invitation if applicable. */
function historyFor(tx: Tx, job: ReplyJob, offers: OfferMemory): ReplyHistory {
  const selectedSourceId = job.request?.selectedSourceId;
  const reopened = tx.get<{ position: number }>(
    `SELECT opening.position FROM case_actions consent JOIN messages opening ON opening.id = consent.message_id
     WHERE consent.chat_id = :chatId AND consent.type = 'telegram_contact_opted_in'
       AND json_extract(consent.detail, '$.contactReopened')=1 ORDER BY consent.position DESC LIMIT 1`,
    { chatId: job.chatId });
  const window = readChatTestWindow(tx, job.chatId);
  const bounds = { chatId: job.chatId, firstPosition: Math.max(job.enrolledAfter + 1, reopened?.position ?? 0, window.position + 1),
    enrolledSecond: Math.max(job.enrolledSecond, window.second),
    afterTelegramId: Math.max(job.afterTelegramId ?? 0, window.telegramId) || null };
  const scope = { ...bounds, ...(job.officerPermission && { officerPermission: true }), ...(job.sourceProof && { sourceProof: job.sourceProof }) };
  const eligibleHistory = `SELECT m.id, m.position, m.direction, m.text, m.received_at, m.edited_at_source, m.unsupported_content,
       CASE WHEN m.edited_at_source=1 THEN ${latestEditText} END AS edited_text,
       CASE WHEN m.direction='incoming' AND m.capture_method='telegram_business_live' AND m.sender_external_id=:contactId
         THEN (SELECT CASE WHEN e.capture_method='telegram_business_live' THEN e.id END
           FROM message_events e WHERE e.message_id=m.id AND e.text IS NOT NULL
           AND e.type IN ('edited','recorded') ORDER BY (e.type='edited') DESC, e.position DESC LIMIT 1)
       END AS payment_source_event_id
     FROM messages m WHERE ${eligibleReplySources} ${job.officerPermission ? 'AND ' + permittedDispatchSourceSql : ''}
       ${selectedSourceId ? "AND m.id=:selectedSourceId AND m.direction='incoming'" : ''}
       ${job.sourceProof ? 'AND ' + verifiedTelegramSourceSql : ''}`;
  const sourceParams = { ...bounds, contactId: job.externalChatId, ...job.sourceProof, ...(selectedSourceId && { selectedSourceId }) };
  const rows = tx.all<HistoryRow>(`${eligibleHistory} ORDER BY m.position DESC LIMIT ${HISTORY_MESSAGES}`, sourceParams);
  let anchor = rows.find(row => row.id === job.messageId);
  if (!anchor && job.request && !selectedSourceId) {
    // Many outgoing follow-ups can push the approved inbound source outside the history window.
    anchor = tx.get<HistoryRow>(`${eligibleHistory} AND m.id=:anchorId`, { ...sourceParams, anchorId: job.messageId });
    if (anchor) rows.push(anchor);
  }
  const media = job.request?.kind === 'ask_for_text' && anchor ? JSON.parse(anchor.unsupported_content) as string[] : [];
  const attachmentKinds = MEDIA_KINDS.filter(kind => media.includes(kind));
  const memory = !selectedSourceId && rows[0] ? offers.read(tx, scope, job.externalChatId, rows[0].position) : undefined;
  const paymentSources = rows.flatMap(row => row.payment_source_event_id === null ? [] : [{
    messageId: row.id, messageEventId: row.payment_source_event_id, text: row.edited_text ?? row.text ?? '',
  }]);
  const paymentLinks = candidatePaymentLinks(job.chatId, paymentSources, reviewedModelPaymentLinkKeys(tx, job.chatId, window.position));
  const dispatchBrief = readDispatchBrief(tx, job.chatId);
  const meeting = selectedSourceId ? null : assessMeeting(tx, scope);
  const investigation: ReplyInvestigationContext = {
    paymentLinks: paymentLinks.map(({ id, host, excerpt }) => ({ id, host, excerpt })),
    ...(attachmentKinds.length > 0 && { attachmentKinds }),
    ...(job.request && job.request.kind !== 'consent_notice' && job.request.kind !== 'ask_for_text' && { dispatchIntent: job.request.kind }),
    ...(dispatchBrief !== null ? { dispatchBrief } : {}),
    ...(meeting && { meetingArranged: true, meetingDayConfirmed: !!meeting.sources.date }),
  };
  const turns: ReplyTurn[] = [];
  const modelTurns: ReplyTurn[] = [];
  const currentTurn: string[] = [];
  let previousReceipt = -Infinity;
  for (const row of rows.reverse()) {
    const text = (row.edited_text ?? row.text ?? '').trim();
    const received = Date.parse(row.received_at);
    if (row.direction !== 'incoming' || received - previousReceipt >= REPLY_QUIET_MS) currentTurn.length = 0;
    if (row.direction === 'incoming' && text) currentTurn.push(text);
    // A previous model's seller claim is evidence, but cannot establish Ali's role or details.
    // Leave human, edited and unattributed outgoing messages in the conversation.
    const oldBotClaim = row.direction === 'outgoing' && !row.edited_at_source && isSellerOrDisclosureClaim(text)
      && tx.get("SELECT 1 AS sent FROM case_actions WHERE message_id = :id AND type = 'ai_reply_sent' LIMIT 1", { id: row.id });
    if (row.direction && text) {
      const turn: ReplyTurn = { from: row.direction === 'incoming' ? 'contact' : 'owner', text };
      turns.push(turn);
      if (!oldBotClaim) modelTurns.push(turn);
    }
    previousReceipt = received;
  }
  const hasSource = Boolean((anchor?.edited_text ?? anchor?.text)?.trim()) || attachmentKinds.length > 0;
  return { hasSource, turns, modelTurns, currentTurn, memory, paymentLinks, investigation, meeting };
}

/** A draft stays valid only for the control revision and conversation the model received. */
function currencyOf(tx: Tx, session: Session, job: ReplyJob, history: ReplyHistory | null, nowMs: number, offers: OfferMemory): Currency {
  const policy = readDmPolicy(tx, session.binding.principal.id, session.policyKey);
  if (policy?.enabled === false || (policy?.revision ?? 0) !== job.policyRevision) return 'mode_changed';
  const chat = findChatById(tx, job.chatId);
  if (!chat) return 'chat_missing';
  const canSendInMode = chat.ai_mode === 'ai_active' || (job.kind === 'notice' && chat.ai_mode === 'not_started');
  if (!canSendInMode || chat.revision !== job.revision) return 'mode_changed';
  const head = latestMessage(tx, job.chatId);
  if (isTelegramReplyHeld(tx, job.chatId, job.request?.position ?? head?.position)) return 'reply_held';
  if (job.request) {
    if (job.request.policyKey && job.request.policyKey !== session.policyKey) return 'mode_changed';
    if (head?.position !== job.request.headPosition) return 'newer_message';
    const open = openReplyRequest(tx, chat, liveReplyChat(session, chat), nowMs);
    if (open?.id !== job.request.id || open.anchorId !== job.messageId || open.kind !== job.request.kind ||
      open.selectedSourceId !== job.request.selectedSourceId) return 'not_answerable';
  } else if (hasFinalOutcome(tx, job.messageId)) return 'not_answerable';
  const latest = job.request && head?.id !== job.messageId ? latestMessage(tx, job.chatId, job.messageId) : head;
  if (latest?.id !== job.messageId) return 'newer_message';
  const permission = dispatchPermissionForTurn(tx, session.binding.principal.id, session.policyKey, chat.id, latest.id);
  if (job.officerPermission && (!permission || permission.enrolledAfter > job.enrolledAfter ||
    permission.enrolledSecond > job.enrolledSecond || (permission.afterTelegramId ?? 0) > (job.afterTelegramId ?? 0))) return 'reply_held';
  if (job.kind === 'notice' && (permission || hasOfficerDispatchApproval(tx, chat.id, session.binding.principal.id, session.policyKey))) {
    return 'mode_changed';
  }
  const catchUpUntil = job.request?.until ?? (job.officerPermission ? permission?.catchUpUntil : null);
  const request = job.request;
  const explicitNotice = request?.kind === 'consent_notice';
  const localTarget = explicitNotice || request?.kind === 'ask_for_text';
  if (!isAnswerable(chat, latest, nowMs, catchUpUntil, localTarget)) return 'not_answerable';
  const consentState = recordedDmConsent(tx, session.binding.principal.id, chat.id, session.policyKey);
  if (consentState?.status === 'withdrawn') return 'reply_held';
  if (explicitNotice && consentState) return 'mode_changed';
  if (job.kind === 'notice' && !explicitNotice && !canInvite(readConsentPromptPolicy(tx, session.binding.principal.id, session.policyKey), latest)) {
    return 'mode_changed';
  }
  if (!explicitNotice && !job.officerPermission && !request?.selectedSourceId &&
    (consentState?.status === 'accepted' || !session.approvedIds.has(job.externalChatId))) {
    const consent = dmConsentForTurn(tx, session.binding.principal.id, chat.id, latest.id, latest.position, latest.text ?? '', session.policyKey);
    if (consent.action !== job.kind || (job.kind === 'reply' && consent.enrolledAfter > job.enrolledAfter)) return 'reply_held';
  }
  if (latest.activity_position !== job.activityPosition) return 'history_changed';
  if ((catchUpUntil ?? 0) <= nowMs && nowMs < Date.parse(latest.activity_at) + REPLY_QUIET_MS) return 'history_changed';
  return history === null || isDeepStrictEqual(historyFor(tx, job, offers), history) ? 'current' : 'history_changed';
}

/** A failure as stored: the generator's code, the guard's rule, or the Bot API's code and status. */
function failureOf(error: unknown): Failure {
  if (error instanceof ReplyGenerationError || error instanceof OpenRouterReplyError) return { code: error.code, status: null };
  if (error instanceof ReplyBlockedError) return { code: 'blocked_reply', status: null, rule: error.rule };
  if (error instanceof BotApiError) return { code: `telegram_${error.code}`, status: error.status };
  return { code: 'reply_failed', status: null };
}

function detailOf(failure: Failure): caseActions.CaseActionDetail {
  const { code, status, rule, telegramMessageId } = failure;
  return { code, status, ...(rule ? { rule } : {}), ...(telegramMessageId === undefined ? {} : { telegramMessageId }) };
}

/** The account's last explicit flood rejection survives a restart without retaining any conversation data. */
function telegramSendCooldown(tx: Tx, session: Session) {
  return tx.get<{ until: number; updatedAt: string }>(
    'SELECT CAST(value AS INTEGER) AS until, updated_at AS updatedAt FROM connector_state WHERE connector_id=? AND key=?',
    [session.binding.principal.id, `telegram_send_retry_after_v1:${session.policyKey}`]);
}

function rememberSendCooldown(tx: Tx, session: Session, retryAfterSeconds: number | null): number {
  const now = tx.now();
  const nowMs = Date.parse(now);
  const previous = telegramSendCooldown(tx, session);
  const backoff = previous && nowMs - previous.until < MAX_BACKOFF_MS
    ? Math.min(MAX_BACKOFF_MS, 2 * (previous.until - Date.parse(previous.updatedAt))) : 0;
  const delay = Math.max(5 * MS_PER_SECOND, backoff, (retryAfterSeconds ?? 30) * MS_PER_SECOND);
  const retryAt = Math.max(previous?.until ?? 0, Math.min(Number.MAX_SAFE_INTEGER, nowMs + delay));
  tx.run(`INSERT INTO connector_state(connector_id,key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(connector_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  [session.binding.principal.id, `telegram_send_retry_after_v1:${session.policyKey}`, String(retryAt), now]);
  return retryAt;
}

const senderName = (sent: SentMessage): string => [sent.from?.first_name, sent.from?.last_name].filter(Boolean).join(' ').trim();

class TelegramAiReplyWorker implements AiReplyWorker {
  private readonly deps: AiReplyWorkerDeps;
  private readonly loop: JobLoop;
  private readonly draftController = new AbortController();
  /** A submitted request may already have reached Telegram. Keep its outcome available until app shutdown. */
  private readonly sendController = new AbortController();
  /** Incoming messages taken in this process: answered, failed or in flight (a reply dropped after a takeover is not). */
  private readonly attempted = new Set<string>();
  private session: Session | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wakeAlarm: { at: number; cancel: () => void } | null = null;
  private readonly offers = new OfferMemory();
  private activeDraft: { job: ReplyJob; history: ReplyHistory; controller: AbortController } | null = null;

  constructor(deps: AiReplyWorkerDeps) {
    this.deps = deps;
    this.loop = createJobLoop<ReplyJob>({
      name: 'ai-reply',
      claim: () => this.claim(),
      work: (job) => this.work(job),
      concurrency: 1,
      onError: (error, phase) => deps.logger.error('telegram_ai_reply_worker_error', { phase, errorClass: errorClassOf(error) }),
    });
  }

  start(): void {
    if (this.session || this.draftController.signal.aborted) return;
    this.session = openSession(this.deps);
    this.deps.logger.info('telegram_ai_replies_started', {
      principalId: this.session.binding.principal.id, model: this.deps.generator.model,
    });
    this.timer = setInterval(() => this.loop.wake(), this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref();
    this.loop.wake();
  }

  forgetChat(chatId: string): void {
    this.offers.forget(chatId);
    if (this.activeDraft?.job.chatId === chatId) {
      this.activeDraft.controller.abort();
      this.activeDraft = null;
    }
  }

  wake(): void {
    if (!this.session || this.draftController.signal.aborted) return;
    const active = this.activeDraft;
    if (active && !active.controller.signal.aborted) {
      const current = this.currency(active.job, active.history);
      if (current !== 'current') {
        this.discard(active.job, current);
        active.controller.abort();
      }
    }
    this.loop.wake();
  }

  idle(): Promise<void> {
    return this.loop.idle();
  }

  isIdle(): boolean {
    return this.loop.isIdle();
  }

  running(): boolean {
    return this.session !== null && !this.draftController.signal.aborted;
  }

  disable(): void {
    this.offers.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wakeAlarm?.cancel();
    this.wakeAlarm = null;
    this.draftController.abort();
  }

  async stop(): Promise<void> {
    this.disable();
    this.sendController.abort();
    await this.loop.stop();
    this.session = null;
  }

  private claim(): ReplyJob | null {
    const session = this.session;
    if (!session || this.draftController.signal.aborted) return null;
    const nowMs = this.deps.clock.now().getTime();
    return this.deps.db.transaction((tx) => {
      recoverExpiredTelegramSends(tx, new Date(nowMs).toISOString());
      const cooldown = telegramSendCooldown(tx, session);
      if (cooldown && cooldown.until > nowMs) {
        this.scheduleWakeAt(cooldown.until, nowMs);
        return null;
      }
      const policy = readDmPolicy(tx, session.binding.principal.id, session.policyKey);
      const mode = dmPolicyMode(policy, this.deps.config.telegram);
      if (mode === 'off') return null;
      const waiting = this.waiting(tx, session, nowMs, mode === 'all_private' ? policy : null);
      // An officer selected this particular inbound message for a reply. Later messages still wait for the burst to end.
      const next = waiting.find(turn => turn.dispatchRequested)
        ?? waiting.find(({ message }) => Date.parse(message.activity_at) + REPLY_QUIET_MS <= nowMs);
      if (!next) {
        const firstQuiet = waiting.reduce((at, { message }) => Math.min(at, Date.parse(message.activity_at) + REPLY_QUIET_MS), Infinity);
        this.scheduleWakeAt(firstQuiet, nowMs);
        return null;
      }
      const chat = mode === 'approved' && next.chat.ai_mode === 'not_started' ? this.autoStart(tx, next.chat) : next.chat;
      this.attempted.add(next.request?.id ?? next.message.id);
      return {
        chatId: chat.id,
        ...(next.request && { request: next.request }),
        ...(next.sourceProof && { sourceProof: next.sourceProof }),
        officerPermission: next.officerPermission ?? false,
        kind: next.kind,
        policyRevision: policy?.revision ?? 0,
        revision: chat.revision,
        workspaceId: chat.workspace_id,
        externalChatId: chat.external_chat_id,
        messageId: next.message.id,
        activityPosition: next.message.activity_position,
        enrolledAfter: next.chat.enrolled_after,
        enrolledSecond: next.chat.enrolled_second,
        afterTelegramId: next.afterTelegramId ?? null,
      };
    });
  }

  private scheduleWakeAt(at: number, nowMs: number): void {
    if (at === this.wakeAlarm?.at) return;
    this.wakeAlarm?.cancel();
    this.wakeAlarm = null;
    if (!Number.isFinite(at)) return;
    const wake = () => {
      this.wakeAlarm = null;
      this.wake();
    };
    const clock = this.deps.clock;
    const delay = Math.min(at - nowMs, 2_147_483_647);
    const cancel = clock.after ? clock.after(delay, wake) : systemClock.after(delay, wake);
    this.wakeAlarm = { at, cancel };
  }

  /**
   * In an all-DM inbox an unstarted chat can receive a local invitation. Only active chats are eligible for model work.
   * Approved-list installations can additionally start enrolled chats on their first answerable message.
   */
  private waiting(tx: Tx, session: Session, nowMs: number, policy: DmPolicy | null): Waiting[] {
    const invitations = policy && readConsentPromptPolicy(tx, session.binding.principal.id, session.policyKey);
    const grantJoin = `LEFT JOIN telegram_dispatch_permissions g ON g.chat_id=c.id AND g.connector_id=:connector
      AND g.policy_key=:policyKey AND g.suspended=0`;
    const requested = `EXISTS (SELECT 1 FROM case_actions r WHERE r.chat_id=c.id
      AND r.type='telegram_reply_requested' AND json_extract(r.detail,'$.until')>:nowMs)`;
    const binding = { accountId: session.binding.account.id, connector: session.binding.principal.id, policyKey: session.policyKey };
    const chats = policy ? tx.all<Waiting['chat']>(
      `SELECT c.*, :position AS enrolled_after, :second AS enrolled_second, g.chat_id IS NOT NULL AS has_dispatch_permission
       FROM chats c ${grantJoin}
       WHERE c.channel_account_id=:accountId AND (c.ai_mode='ai_active' OR (:invitations=1 AND c.ai_mode='not_started'))
       AND (g.chat_id IS NOT NULL OR ${requested}
       OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.id
         AND m.position>:position AND m.direction='incoming' AND m.received_at>=:since)) ORDER BY c.id`,
      { ...binding, invitations: invitationsEnabled(invitations) ? 1 : 0, position: policy.position, second: policy.second,
        nowMs, since: new Date(nowMs - REPLY_FRESHNESS_MS).toISOString() },
    ) : tx.all<Waiting['chat']>(
      `SELECT c.*, coalesce(json_extract(e.value,'$.position'),0) AS enrolled_after,
         coalesce(json_extract(e.value,'$.second'),0) AS enrolled_second, g.chat_id IS NOT NULL AS has_dispatch_permission
       FROM chats c LEFT JOIN json_each(:enrollments) e ON e.key=c.external_chat_id ${grantJoin}
       WHERE c.channel_account_id=:accountId AND (e.key IS NOT NULL OR g.chat_id IS NOT NULL OR ${requested}
         OR EXISTS (SELECT 1 FROM connector_state s WHERE s.connector_id=:connector AND s.key='dm_ai_consent_v1:'||c.id
           AND json_extract(s.value,'$.status')='accepted' AND (
             (json_extract(s.value,'$.noticePolicyKey')=:policyKey AND json_extract(s.value,'$.officerInvited')=1)
             OR EXISTS (SELECT 1 FROM case_actions a WHERE a.chat_id=c.id AND ${officerDispatchScopeSql}))))
         AND (c.ai_mode='ai_active' OR (:autoStart=1 AND c.ai_mode='not_started')) ORDER BY c.id`,
      { ...binding, nowMs, enrollments: session.enrollments, autoStart: session.autoStart ? 1 : 0 },
    );
    return chats
      .filter(chat => isChatInScope(session.scope, chat.external_chat_id, session.binding.ownerUserId))
      .flatMap((chat): Waiting[] => {
        if (tx.get('SELECT 1 FROM telegram_pending_sends WHERE chat_id=?', [chat.id])) return [];
        const request = openReplyRequest(tx, chat, liveReplyChat(session, chat), nowMs);
        if (request?.policyKey && request.policyKey !== session.policyKey) return [];
        const head = latestMessage(tx, chat.id);
        if (request && head?.position !== request.headPosition) return [];
        const message = request && request.anchorId !== head?.id ? latestMessage(tx, chat.id, request.anchorId) : head;
        if (!message || this.attempted.has(request?.id ?? message.id) || (!request && hasFinalOutcome(tx, message.id)) ||
          isTelegramReplyHeld(tx, chat.id, request?.position ?? message.position)) return [];
        const selectedSource = request?.selectedSourceId === message.id;
        if (!selectedSource && (message.position <= chat.enrolled_after || earliestMs(message) < chat.enrolled_second * MS_PER_SECOND)) return [];
        const permission = dispatchPermissionForTurn(tx, binding.connector, binding.policyKey, chat.id, message.id);
        if (!selectedSource && chat.has_dispatch_permission && !permission) return [];
        const explicitNotice = request?.kind === 'consent_notice';
        const localTarget = explicitNotice || request?.kind === 'ask_for_text';
        if (!isAnswerable(chat, message, nowMs, request?.until ?? permission?.catchUpUntil, localTarget)) return [];
        const dispatch = request ? { request, dispatchRequested: true } : {};
        if (explicitNotice) {
          if (permission || session.approvedIds.has(chat.external_chat_id) || recordedDmConsent(tx, binding.connector, chat.id, session.policyKey)) return [];
          return [{ kind: 'notice', chat, message, ...dispatch }];
        }
        const consentState = recordedDmConsent(tx, binding.connector, chat.id, session.policyKey);
        if (consentState?.status === 'withdrawn') return [];
        if (selectedSource) {
          // The request authorizes just this source, even when the chat's normal enrollment starts later.
          // Use a job-local floor; historyFor also pins the query to its ID and verifies the live connection.
          return [{ kind: 'reply', ...dispatch, message, sourceProof: { connector: binding.connector, policyKey: binding.policyKey },
            chat: { ...chat, enrolled_after: message.position - 1, enrolled_second: 0 } }];
        }
        const officerEnrolled = isOfficerEnrolledConsent(tx, consentState, chat.id, binding.connector, session.policyKey);
        const proof = officerEnrolled ? { sourceProof: { connector: binding.connector, policyKey: session.policyKey } } : {};
        if (permission) {
          chat.enrolled_after = Math.max(chat.enrolled_after, permission.enrolledAfter);
          chat.enrolled_second = Math.max(chat.enrolled_second, permission.enrolledSecond);
          if (message.position <= chat.enrolled_after || earliestMs(message) < chat.enrolled_second * MS_PER_SECOND) return [];
          return [{ kind: 'reply', officerPermission: true, dispatchRequested: (permission.catchUpUntil ?? 0) > nowMs, ...dispatch, ...proof,
            chat, message, afterTelegramId: permission.afterTelegramId }];
        }
        if (session.approvedIds.has(chat.external_chat_id) && consentState?.status !== 'accepted') return [{ kind: 'reply', chat, message, ...dispatch, ...proof }];
        if (!policy && !officerEnrolled && !session.approvedIds.has(chat.external_chat_id)) return [];
        const consent = dmConsentForTurn(tx, binding.connector, chat.id, message.id, message.position, message.text ?? '', session.policyKey);
        if (consent.action === 'wait') return [];
        if (consent.action === 'notice' && (!invitations || !canInvite(invitations, message) ||
          hasOfficerDispatchApproval(tx, chat.id, binding.connector, binding.policyKey))) return [];
        if (consent.action === 'reply') {
          chat.enrolled_after = Math.max(chat.enrolled_after, consent.enrolledAfter);
          chat.enrolled_second = Math.max(chat.enrolled_second, consent.enrolledSecond);
          if (message.position <= chat.enrolled_after || earliestMs(message) < chat.enrolled_second * MS_PER_SECOND) return [];
        }
        if (request && consent.action !== 'reply') return [];
        return [{ kind: consent.action, chat, message, ...dispatch, ...proof, ...(consent.afterTelegramId !== undefined && { afterTelegramId: consent.afterTelegramId }) }];
      })
      .filter(({ chat, kind }) => !policy || chat.ai_mode === 'ai_active' || kind === 'notice')
      .sort((a, b) => a.message.position - b.message.position);
  }

  /** Starts a chat that was never started, as Dispatch would, recorded as `ai_auto_started` with no officer. */
  private autoStart(tx: Tx, chat: ChatRow): ChatRow {
    const started = applyModeChange(tx, chat, { aiMode: 'ai_active', controllerId: null }, null, 'ai_auto_started');
    tx.afterCommit(() => this.deps.logger.info('telegram_ai_chat_auto_started', { chatId: chat.id }));
    return started;
  }

  private async work(job: ReplyJob): Promise<void> {
    const session = this.session;
    if (!session || this.draftController.signal.aborted) return;
    if (job.kind === 'notice') {
      const state = this.deps.db.transaction(tx => currencyOf(tx, session, job, null, this.deps.clock.now().getTime(), this.offers));
      if (state !== 'current') return this.discard(job, state);
      return this.send(session, job, DM_CONSENT_NOTICE, { source: 'consent_notice' });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([this.draftController.signal, controller.signal]);
    const history = this.deps.db.transaction((tx) => {
      const current = currencyOf(tx, session, job, null, this.deps.clock.now().getTime(), this.offers);
      return current === 'current' ? historyFor(tx, job, this.offers) : current;
    });
    if (typeof history === 'string') return this.discard(job, history);
    if (!history.hasSource) {
      return this.recordFailure(job, { code: job.request?.selectedSourceId ? 'selected_source_unavailable' : 'source_unavailable', status: null });
    }
    const generator = this.deps.arabicGenerator && isArabicReplyTurn(history.turns, history.currentTurn)
      ? this.deps.arabicGenerator : this.deps.generator;
    this.activeDraft = { job, history, controller };
    const wordingTest = this.wordingTestActive(job);
    const trigger = { chatId: job.chatId, workspaceId: job.workspaceId, messageId: job.messageId, requestId: job.request?.id };
    const warnings: DraftWarnings = { links: new Set() };
    const recordWarnings = (tx: Tx) => {
      for (const citation of warnings.links) recordModelPaymentLinkReview(tx, trigger, citation, MODEL_PAYMENT_LINK_REASON, generator.model);
      if (warnings.conversation) recordConversationReview(tx, trigger, warnings.conversation, generator.model);
    };
    const finishFailedDraft = (tx: Tx) => {
      const state = currencyOf(tx, session, job, history, this.deps.clock.now().getTime(), this.offers);
      if (state === 'current') recordWarnings(tx);
      return state;
    };
    let decision: DraftDecision;
    try {
      decision = await this.draft(generator, job, history, signal, warnings);
    } catch (error) {
      if (signal.aborted) return;
      // A failure only counts while the message still awaits this reply; otherwise the job is simply dropped.
      return this.recordFailure(job, failureOf(error), finishFailedDraft);
    } finally {
      this.activeDraft = null;
    }
    if (signal.aborted) return;
    // Validate the exact draft context and publish any internal decision in the same write transaction.
    const currency = this.deps.db.transaction(tx => {
      const state = currencyOf(tx, session, job, history, this.deps.clock.now().getTime(), this.offers);
      if (state !== 'current') return state;
      if (decision.kind !== 'reply') recordWarnings(tx);
      if (decision.kind === 'silence' || decision.kind === 'guard_silence') {
        const { reason } = decision;
        const source = decision.kind === 'silence' ? 'model' : 'reply_guard';
        // The officer sees the model's own explanation beside the reason; it was masked when the decision was parsed.
        // Logs keep the codes only.
        const explanation = decision.kind === 'silence' ? decision.explanation : undefined;
        caseActions.record(tx, {
          chatId: job.chatId, workspaceId: job.workspaceId, type: 'ai_reply_skipped', actorId: null, messageId: job.messageId,
          detail: { source, reason, ...(source === 'model' && { model: generator.model }), ...(explanation ? { explanation } : {}),
            ...(job.request && { requestId: job.request.id }) },
        });
        tx.afterCommit(() => this.deps.logger.info('telegram_ai_reply_skipped', {
          chatId: job.chatId, messageId: job.messageId, source, reason,
        }));
      }
      if (history.meeting && !warnings.links.size && !warnings.conversation && !decision.higherConcern) {
        recordLowerConcern(tx, job.chatId, history.meeting);
      }
      return state;
    });
    if (currency !== 'current') return this.discard(job, currency);
    if (decision.kind !== 'reply') return;
    const text = decision.text;
    if (wordingTest && !this.wordingTestActive(job)) {
      const rule = blockedRuleForTurn(text, history.turns, history.currentTurn, history.memory, false, PAYMENT_INSTRUCTIONS_POLICY);
      if (rule) {
        return this.recordFailure(job, failureOf(new ReplyBlockedError(rule)), finishFailedDraft);
      }
    }
    return this.send(session, job, text, { source: 'model', model: generator.model }, history, recordWarnings);
  }

  private async send(session: Session, job: ReplyJob, text: string, attribution: ReplyAttribution, history: ReplyHistory | null = null,
    recordWarnings?: (tx: Tx) => void): Promise<void> {
    // Register before starting the irreversible network operation. Production sendMessage times out after 15 seconds;
    // the lease includes crash recovery time and never authorizes another send for the same unresolved trigger.
    const triggerId = job.request?.id ?? job.messageId;
    const acquired = this.deps.db.transaction(tx => {
      const nowMs = this.deps.clock.now().getTime();
      if ((telegramSendCooldown(tx, session)?.until ?? 0) > nowMs ||
        currencyOf(tx, session, job, history, nowMs, this.offers) !== 'current') return false;
      const expires = new Date(Date.parse(tx.now()) + 60_000).toISOString();
      const claimed = tx.run(`INSERT INTO telegram_pending_sends(chat_id,trigger_id,expires_at,notice_policy_key)
        VALUES (?,?,?,?) ON CONFLICT(chat_id) DO NOTHING`,
        [job.chatId, triggerId, expires, job.kind === 'notice' ? session.policyKey : null]).changes > 0;
      // A recorded warning removes this link from the next model input. Commit it with the send lease,
      // after validating the input this reply actually used.
      if (claimed) recordWarnings?.(tx);
      return claimed;
    });
    if (!acquired) {
      this.attempted.delete(triggerId);
      return;
    }
    let sent: SentMessage | undefined;
    try {
      sent = await session.sender.sendBusinessMessage(
        { businessConnectionId: session.connectionId, chatId: Number(job.externalChatId), text },
        this.sendController.signal,
      );
    } catch (error) {
      if (job.request && error instanceof BotApiError && error.method === 'sendMessage' && error.code === 'api_error' && error.status === 429) {
        // Only a confirmed rejection can release the send lease for another attempt.
        const until = this.deps.db.transaction(tx => {
          const retryAt = rememberSendCooldown(tx, session, error.retryAfterSeconds);
          tx.run('DELETE FROM telegram_pending_sends WHERE chat_id=? AND trigger_id=?', [job.chatId, triggerId]);
          return retryAt;
        });
        if (until < job.request.until) {
          this.attempted.delete(triggerId);
          this.deps.logger.info('telegram_dispatch_rate_limited', { chatId: job.chatId, requestId: triggerId, status: 429 });
        } else {
          this.recordFailure(job, failureOf(error));
        }
        return;
      }
      // A timeout, broken response or lost connection can follow a successful send.
      const rejected = error instanceof BotApiError && error.code === 'api_error'
        && error.status !== null && error.status >= 400 && error.status < 500;
      this.recordFailure(job, rejected ? failureOf(error) : {
        code: 'delivery_unknown', status: error instanceof BotApiError ? error.status : null,
      });
    }
    if (sent) this.keep(session, job, sent, text, attribution);
    // If even recording the outcome throws, retain the lease for recovery.
    this.deps.db.transaction(tx => tx.run('DELETE FROM telegram_pending_sends WHERE chat_id=? AND trigger_id=?', [job.chatId, triggerId]));
  }

  private wordingTestActive(job: ReplyJob): boolean {
    const { chatScope, approvedChatIds, aiReplies } = this.deps.config.telegram;
    return aiReplies.wordingUntilMs !== undefined && this.deps.clock.now().getTime() < aiReplies.wordingUntilMs
      && chatScope === 'approved' && approvedChatIds.length === 1 && approvedChatIds[0] === job.externalChatId;
  }

  private currency(job: ReplyJob, history: ReplyHistory): Currency {
    const nowMs = this.deps.clock.now().getTime();
    const session = this.session;
    return session ? this.deps.db.transaction((tx) => currencyOf(tx, session, job, history, nowMs, this.offers)) : 'mode_changed';
  }

  /** Keep private assessments separate from the model's public reply. Both phases have a bounded correction budget. */
  private async draft(generator: ReplyGenerator, job: ReplyJob, context: ReplyHistory, signal: AbortSignal,
    warnings: DraftWarnings): Promise<DraftDecision> {
    const { turns: history, modelTurns, currentTurn, memory, paymentLinks, investigation } = context;
    const prompt = currentAliPrompt();
    const turnText = currentTurn.join(' ');
    const prose = maskUrls(turnText, normalizeTelegramLink);
    const hasCurrentLink = prose !== turnText;
    const onlyLinks = hasCurrentLink && !/[\p{L}\p{N}]/u.test(prose);
    let publicOnly = job.request?.kind === 'ask_for_text';
    let correction: string | undefined;
    let higherConcern = false;
    let remaining = REPLY_ATTEMPTS;
    while (remaining > 0) {
      signal.throwIfAborted();
      if (this.currency(job, context) !== 'current') throw new Error('reply_superseded');
      remaining--;
      let decision: AliDecision;
      try {
        if (publicOnly && generator.composePublicReply) {
          const text = await generator.composePublicReply(modelTurns, signal, correction, currentTurn, memory, investigation, prompt);
          if (!text?.trim()) throw new InvalidReplyDraftError('empty_reply');
          decision = { kind: 'reply', text: text.trim() };
        } else if (generator.decide) {
          decision = await generator.decide(modelTurns, signal, correction, currentTurn, memory, investigation, prompt);
        } else {
          const text = await generator.generate(modelTurns, signal, correction, currentTurn, memory, investigation, prompt);
          decision = text === null ? { kind: 'silence', reason: 'reason_unavailable' } : { kind: 'reply', text };
        }
        if (decision.kind === 'reply' && (!decision.text.trim() || decision.text.length > MAX_REPLY_CHARS || hasInternalReplyContent(decision.text))) {
          throw new InvalidReplyDraftError('invalid_response');
        }
      } catch (error) {
        if (signal.aborted || !(error instanceof InvalidReplyDraftError)) throw error;
        if (!publicOnly && (hasCurrentLink || job.request)) {
          publicOnly = true;
          remaining = REPLY_ATTEMPTS;
          correction = hasCurrentLink ? 'continue_after_warning' : undefined;
        } else if (!publicOnly || remaining === 0) throw error;
        continue;
      }
      signal.throwIfAborted();
      // A wording correction can change the public draft without withdrawing a concern on this turn.
      higherConcern ||= decision.higherConcern === true;
      if (higherConcern && !decision.higherConcern) decision = { ...decision, higherConcern: true };
      const assessment = decision.paymentLinkReview;
      if (assessment?.reason === MODEL_PAYMENT_LINK_REASON) {
        const source = paymentLinks.find(candidate => candidate.id === assessment.candidateId);
        if (source) warnings.links.add(source);
        else this.deps.logger.info('telegram_payment_link_citation_unmatched', { chatId: job.chatId, messageId: job.messageId });
      }
      if (decision.kind === 'review') {
        // Intake already keeps a bare URL as a link warning.
        if (!onlyLinks && !investigation.attachmentKinds?.length) warnings.conversation ??= decision;
      }
      const advisory = hasCurrentLink || warnings.links.size > 0 || !!warnings.conversation;
      const needsPublic = publicOnly || !!job.request || advisory;
      let rule: ReplyGuardRule | null = null;
      if (decision.kind === 'reply') {
        const repeatedMeeting = context.meeting && isRepeatedMeetingQuestion(decision.text, !!context.meeting.sources.date);
        if (repeatedMeeting || (!publicOnly && hasAnsweredIdentityRepeat(history, currentTurn))) {
          if (!needsPublic) return { kind: 'guard_silence', reason: repeatedMeeting ? 'repeated_meeting_question' : 'repeated_identity_question',
            ...(higherConcern && { higherConcern: true }) };
          rule = 'repeat';
        } else {
          rule = blockedRuleForTurn(decision.text, history, currentTurn, memory, this.wordingTestActive(job), PAYMENT_INSTRUCTIONS_POLICY);
        }
        if (!rule) return decision;
        this.deps.logger.info('telegram_ai_reply_blocked', { chatId: job.chatId, attempt: REPLY_ATTEMPTS - remaining, rule });
      } else if (decision.kind === 'silence' && !needsPublic) {
        // A silence has to say why. Ask the same model once more when its decision left the explanation out; if it
        // still gives none, keep the specific reason it chose.
        if (decision.reason !== 'reason_unavailable' && !decision.explanation && remaining > 0
          && correction !== SILENCE_EXPLANATION_REQUEST) {
          correction = SILENCE_EXPLANATION_REQUEST;
          continue;
        }
        return decision;
      }
      // A private review or model silence is never itself public wording. Ask the same model and prompt
      // to compose just the message, with the exact eligible turn and the same guard and currency checks.
      if (!publicOnly && needsPublic) {
        publicOnly = true;
        remaining = REPLY_ATTEMPTS;
      }
      if (remaining === 0) {
        if (rule) throw new ReplyBlockedError(rule);
        throw new ReplyGenerationError('empty_reply');
      }
      correction = rule ? correctionFor(rule) : advisory ? 'continue_after_warning' : undefined;
    }
    throw new ReplyGenerationError('empty_reply');
  }

  /**
   * After a change to source history, abandon this attempt. A mode change releases the message for an officer's
   * explicit Resume AI while it is still fresh.
   */
  private discard(job: ReplyJob, reason: Exclude<Currency, 'current'>): void {
    this.attempted.delete(job.request?.id ?? job.messageId);
    this.deps.logger.info('telegram_ai_reply_discarded', { chatId: job.chatId, reason });
  }

  /** Stores the sent reply. If it cannot be kept as this chat's message, the failure is kept instead, so no second reply. */
  private keep(session: Session, job: ReplyJob, sent: SentMessage, text: string, attribution: ReplyAttribution): void {
    const telegramMessageId = sent.message_id;
    if (sent.chat.id !== Number(job.externalChatId)) {
      return this.recordFailure(job, { code: 'telegram_chat_mismatch', status: null, telegramMessageId });
    }
    let replyId: string | null;
    try {
      replyId = this.deps.db.transaction(tx => {
        if (!tx.get('SELECT 1 FROM messages WHERE id=? AND chat_id=?', [job.messageId, job.chatId])) {
          rememberErasedSource(tx, job.chatId, 'message', `tg:${sent.message_id}`);
          return null;
        }
        return this.storeReply(tx, session, job, sent, sent.text ?? text, attribution);
      });
    } catch (error) {
      this.deps.logger.error('telegram_ai_reply_store_failed', { chatId: job.chatId, errorClass: errorClassOf(error) });
      return this.recordFailure(job, { code: 'store_failed', status: null, telegramMessageId });
    }
    if (replyId === null) return;
    this.deps.logger.info('telegram_ai_reply_sent', { chatId: job.chatId, messageId: replyId, inReplyTo: job.messageId });
    this.deps.onReplyStored?.();
  }

  /** Stores the sent reply as the connector would store Telegram's own copy of it, and logs who wrote it. */
  private storeReply(tx: Tx, session: Session, job: ReplyJob, sent: SentMessage, text: string, attribution: ReplyAttribution): string {
    const name = senderName(sent);
    const parsed = IngestRequest.safeParse({
      source: 'telegram',
      externalAccountId: session.binding.account.external_account_id,
      externalChatId: job.externalChatId,
      event: {
        type: 'message.recorded',
        sourceEventId: `tg:ai:m${sent.message_id}`,
        sourceMessageId: `tg:${sent.message_id}`,
        direction: 'outgoing',
        text,
        sentAt: new Date(sent.date * MS_PER_SECOND).toISOString(),
        sender: { externalId: String(session.binding.ownerUserId), ...(name ? { displayName: name } : {}) },
      },
    });
    if (!parsed.success) throw new Error('ai_reply_event_invalid');
    const { event, ...target } = parsed.data;
    const result = ingest(tx, session.binding.principal, target, event, this.deps.config);
    rememberMessageProof(tx, result.messageId, session.binding.principal.id, session.connectionId, sent.chat.id,
      sent.message_id, sent.date, true, 'normal');
    if (job.kind === 'notice') {
      markDmConsentNotice(tx, session.binding.principal.id, job.chatId, job.messageId, result.messageId,
        session.policyKey, job.request?.kind === 'consent_notice');
    }
    caseActions.record(tx, {
      chatId: job.chatId,
      workspaceId: job.workspaceId,
      type: 'ai_reply_sent',
      actorId: null,
      messageId: result.messageId,
      detail: {
        inReplyTo: job.messageId,
        ...(job.request && { requestId: job.request.id, requestKind: job.request.kind }),
        ...attribution,
        telegramMessageId: sent.message_id,
      },
    });
    return result.messageId;
  }

  private recordFailure(job: ReplyJob, failure: Failure, finishDraft?: (tx: Tx) => Currency): void {
    const detail = { ...detailOf(failure), ...(job.request && { requestId: job.request.id }) };
    const state = this.deps.db.transaction((tx) => {
      const current = finishDraft?.(tx) ?? 'current';
      if (current !== 'current') return current;
      if (!tx.get('SELECT 1 FROM messages WHERE id=? AND chat_id=?', [job.messageId, job.chatId])) return 'chat_missing' as const;
      caseActions.record(tx, {
        chatId: job.chatId,
        workspaceId: job.workspaceId,
        type: 'ai_reply_failed',
        actorId: null,
        messageId: job.messageId,
        detail,
      });
      return 'current' as const;
    });
    if (state !== 'current') return this.discard(job, state);
    const { code, status, rule } = failure;
    this.deps.logger.warn('telegram_ai_reply_failed', { chatId: job.chatId, code, status, ...(rule ? { rule } : {}) });
  }
}

export function createAiReplyWorker(deps: AiReplyWorkerDeps): AiReplyWorker {
  return new TelegramAiReplyWorker(deps);
}
