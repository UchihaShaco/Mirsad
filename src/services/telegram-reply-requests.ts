/**
 * Reply requests: what an officer's Dispatch asks of Ali in a chat on the linked live Telegram account.
 *
 * Permission and the automatic replies that follow each new message live elsewhere (telegram-dispatch-permission.ts,
 * the reply worker). This module answers the three questions a Dispatch raises on top of them:
 *
 * - Which message does the request refer to? The contact's latest message when it is the newest in the chat, otherwise
 *   the contact's last message before the account's own latest one (a follow-up).
 * - What should be sent? An explicit officer Dispatch may request a new reply, retry, follow-up, local permission
 *   invitation, or a local request for text when the contact sent only supported media.
 * - What became of the request? It is a `telegram_reply_requested` case action: durable, so a restart keeps it, and
 *   every outcome the worker records carries its ID. A second click while it is open returns the same request, and the
 *   worker never answers one request twice.
 *
 * Opt-outs, blocking evidence reviews, the account-wide switch and Telegram's 24-hour reply window all stay in force:
 * each is reported as the reason no reply was queued.
 */
import { approvedReplyChatIds, chatScopeOf, isChatInScope } from '../adapters/telegram/chat-scope.ts';
import { findLiveBindings } from '../adapters/telegram/live-connector.ts';
import { verifiedTelegramSourceSql } from '../adapters/telegram/message-proof.ts';
import { MEDIA_KINDS } from '../adapters/telegram/types.ts';
import type { Config } from '../config.ts';
import type {
  TelegramAiPermission, TelegramAutomaticState, TelegramNoReplyReason, TelegramReplyRequestKind, TelegramReplyRequestStatus,
  TelegramReplyTargetState,
} from '../contract/enums.ts';
import type { TelegramDispatchOutcome, TelegramReplies } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import { REPLY_FRESHNESS_MS } from '../replies/reply-timing.ts';
import type { Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';
import { directTelegramTextSql } from '../storage/repos/messages.ts';
import type { ChatRow } from '../storage/rows.ts';
import { currentTestMessageSql, readChatTestWindow } from './chat-test-session.ts';
import { permittedDispatchSourceSql, recordDispatchTargetEvidence, resumeDispatchPermissions, telegramAiPermission } from './telegram-dispatch-permission.ts';
import { dmConsentForTurn, hasOfficerDispatchApproval, officerDispatchScopeSql, recordedDmConsent } from './telegram-dm-consent.ts';
import { dmPolicyKey, dmPolicyMode, readDmPolicy } from './telegram-dm-policy.ts';
import {
  blockingReviewRequestSql, blockingReviewResolutionSql, getTelegramReplyHold, isTelegramContactOptOut,
  isTelegramReplyHeld, predatesTelegramOptIn, sharedTelegramMaterial,
} from './telegram-reply-holds.ts';
import { principalLookup } from './mappers.ts';
import { recoverExpiredTelegramSends } from './telegram-send-recovery.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MS_PER_SECOND = 1_000;
/** connector_state key of the approved-list enrollments the reply worker keeps: chat ID to position and second. */
export const REPLY_ENROLLMENTS = 'telegram_reply_enrollments_v2';
export const REPLY_REQUESTED = 'telegram_reply_requested';

type Telegram = Config['telegram'];

/** A chat on the one linked live Telegram account, inside its intake scope. */
export interface LiveChat {
  connector: string;
  policyKey: string;
  /** On TELEGRAM_APPROVED_CHAT_IDS: permission was recorded before the portal's Dispatch existed. */
  listed: boolean;
}

/** Undefined for every other chat (fixtures, imports, another account): those keep the plain dispatch. */
export function liveChatOf(tx: Tx, chat: ChatRow, telegram: Telegram): LiveChat | undefined {
  const bindings = findLiveBindings(tx);
  const binding = bindings[0];
  if (!binding || bindings.length !== 1 || binding.account.id !== chat.channel_account_id || !telegram.approvedConnectionId
    || !/^[1-9]\d*$/u.test(chat.external_chat_id) || Number(chat.external_chat_id) === binding.ownerUserId
    || !isChatInScope(chatScopeOf(telegram), chat.external_chat_id, binding.ownerUserId)) return undefined;
  const liveCapture = tx.get(`SELECT 1 FROM message_events WHERE chat_id=? AND connector_id=?
    AND capture_method='telegram_business_live' LIMIT 1`, [chat.id, binding.principal.id]);
  if (!liveCapture && (chat.created_via !== 'register' || tx.get('SELECT 1 FROM messages WHERE chat_id=? LIMIT 1', [chat.id]))) {
    return undefined;
  }
  return {
    connector: binding.principal.id,
    policyKey: dmPolicyKey(binding.account.id, telegram.approvedConnectionId),
    listed: approvedReplyChatIds(telegram).includes(chat.external_chat_id),
  };
}

/** The contact's message a request refers to, with the newest message of the chat when it was chosen. */
export interface ReplyTarget {
  id: string;
  position: number;
  eventId: string;
  text: string;
  media: string;
  /** An original attachment without a caption can receive a model-written request for text on manual Dispatch. */
  needText?: true;
  /** An officer's attestation is required to use this one source outside ordinary enrollment. */
  selectedSourceId?: string;
  /** The selected historical source is available for local evidence review only. */
  bankEvidenceOnly?: true;
  sentAt: string;
  receivedAt: string;
  state: TelegramReplyTargetState;
  headPosition: number;
  /** Optimistic confirmation boundary. Only reused if the chat has the same messages and decisions. */
  confirmationPosition: number;
}

type NoTarget = Extract<TelegramNoReplyReason, 'no_message' | 'latest_not_answerable' | 'outside_reply_window' | 'before_reply_scope'>;

/** Model replies require text. Manual Dispatch can also address an original attachment verified by the live connector. */
const eligibleContactMessageSql = `m.direction='incoming' AND m.origin='source' AND m.original_captured=1 AND m.deleted_at_source=0
  AND m.capture_method='telegram_business_live' AND m.sender_external_id=:contact AND m.source_message_id GLOB 'tg:[0-9]*'
  AND m.sent_at IS NOT NULL AND (
    (length(trim(m.text,char(9,10,11,12,13,32)))>0 AND length(trim(e.text,char(9,10,11,12,13,32)))>0)
    OR (:allowMedia=1 AND e.type='recorded' AND length(trim(coalesce(e.text,''),char(9,10,11,12,13,32)))=0
      AND EXISTS (SELECT 1 FROM json_each(m.unsupported_content) WHERE value IN (SELECT value FROM json_each(:mediaKinds)))
      AND EXISTS (SELECT 1 FROM telegram_message_proofs p WHERE p.message_id=m.id AND p.connector_id=:connector
        AND p.connection_hash=substr(:policyKey,-64) AND p.chat_number=CAST(:contact AS INTEGER)
        AND m.source_message_id='tg:'||p.message_number AND p.content_kind='normal' AND p.own_send=0 AND p.removal IS NULL)))
  AND e.type IN ('recorded','edited') AND e.connector_id=:connector
  AND NOT EXISTS (SELECT 1 FROM message_events change WHERE change.message_id=m.id AND
    (change.type='conflicting_copy' OR (change.type IN ('recorded','edited') AND change.connector_id IS NOT :connector)))
  AND NOT EXISTS (SELECT 1 FROM telegram_message_proofs proof WHERE proof.message_id=m.id
    AND (proof.connector_id<>:connector OR proof.connection_hash<>substr(:policyKey,-64)))
  AND ${directTelegramTextSql}`;

const OUTCOME_STATES: Record<string, TelegramReplyTargetState> = {
  leave_unanswered: 'left_unanswered',
  ai_reply_skipped: 'skipped',
  ai_reply_failed: 'failed',
  telegram_officer_review_requested: 'reviewed',
  ai_reply_sent: 'answered',
};

/** Where the newest message stands, from the latest decision or outcome recorded for it. */
function stateOf(tx: Tx, chatId: string, messageId: string): TelegramReplyTargetState {
  const outcome = tx.get<{ type: string }>(
    `SELECT type FROM case_actions a WHERE a.chat_id=:chatId AND (
       (message_id=:messageId AND type IN ('ai_reply_failed','ai_reply_skipped','leave_unanswered'))
       OR (${blockingReviewRequestSql('a')}
         AND (message_id=:messageId OR json_extract(detail,'$.triggerMessageId')=:messageId))
       OR (type='ai_reply_sent' AND json_extract(detail,'$.inReplyTo')=:messageId
         AND json_extract(detail,'$.source') IS NOT 'consent_notice'))
     ORDER BY position DESC LIMIT 1`, { chatId, messageId });
  return outcome ? OUTCOME_STATES[outcome.type] ?? 'unanswered' : 'unanswered';
}

/**
 * The positions before which Ali reads nothing: the account-wide switch's enable boundary, or for a chat on the
 * approved list the point where the reply worker enrolled it. A disabled switch admits nothing.
 */
function replyFloor(tx: Tx, live: LiveChat, chat: ChatRow): { position: number; second: number } | undefined {
  const policy = readDmPolicy(tx, live.connector, live.policyKey);
  if (policy) return policy.enabled === false ? undefined : policy;
  if (!live.listed) return { position: 0, second: 0 };
  const row = tx.get<{ value: string }>('SELECT value FROM connector_state WHERE connector_id=? AND key=?', [live.connector, REPLY_ENROLLMENTS]);
  const enrolled = row ? (JSON.parse(row.value) as Record<string, { position: number; second: number }>)[chat.external_chat_id] : undefined;
  return enrolled ?? { position: 0, second: 0 };
}

/**
 * The message a Dispatch refers to, or why there is none. Only the newest message of the chat can be answered when
 * the contact wrote it; when the account wrote it, the request is a follow-up to the contact's last message before it.
 */
export function replyTarget(tx: Tx, chat: ChatRow, live: LiveChat, nowMs: number,
  { allowMedia = false, selectOutsideEnrollment }: {
    allowMedia?: boolean;
    /** True when previewing or confirming a selection, or the exact approved ID when reopening it. */
    selectOutsideEnrollment?: true | string;
  } = {}): ReplyTarget | NoTarget {
  const window = readChatTestWindow(tx, chat.id);
  const head = tx.get<{ id: string; position: number; direction: string | null }>(
    `SELECT m.id, m.position, m.direction FROM messages m WHERE m.chat_id=:chatId AND ${currentTestMessageSql}
     ORDER BY m.position DESC LIMIT 1`, { chatId: chat.id, ...window });
  if (!head) return 'no_message';
  const row = tx.get<Omit<ReplyTarget, 'state' | 'headPosition' | 'confirmationPosition'>>(
    `SELECT m.id, m.position, e.id AS eventId, coalesce(e.text,'') AS text, m.unsupported_content AS media, m.sent_at AS sentAt, m.received_at AS receivedAt
     FROM messages m JOIN message_events e ON e.id=(SELECT id FROM message_events WHERE message_id=m.id ORDER BY position DESC LIMIT 1)
     WHERE m.chat_id=:chatId AND ${currentTestMessageSql} AND m.position<=:headPosition AND ${eligibleContactMessageSql}
     ORDER BY m.position DESC LIMIT 1`,
    { chatId: chat.id, ...window, headPosition: head.position, contact: chat.external_chat_id, connector: live.connector,
      policyKey: live.policyKey, allowMedia: Number(allowMedia), mediaKinds: JSON.stringify(MEDIA_KINDS) });
  if (head.direction !== 'outgoing' && row?.id !== head.id) return 'latest_not_answerable';
  if (!row) return 'no_message';
  // Telegram lets a business account reply only within 24 hours of the contact's message.
  const earliest = Math.min(Date.parse(row.sentAt), Date.parse(row.receivedAt));
  if (!(earliest > nowMs - DAY_MS) || Date.parse(row.sentAt) > nowMs) return 'outside_reply_window';
  const floor = replyFloor(tx, live, chat);
  if (!floor) return 'before_reply_scope';
  if (predatesTelegramOptIn(tx, chat.id, row.position)) return 'before_reply_scope';
  const consent = recordedDmConsent(tx, live.connector, chat.id, live.policyKey);
  if (consent?.status === 'accepted'
    && dmConsentForTurn(tx, live.connector, chat.id, row.id, row.position, row.text, live.policyKey).action !== 'reply') return 'before_reply_scope';
  const grant = tx.get('SELECT 1 FROM telegram_dispatch_permissions WHERE chat_id=? AND connector_id=? AND policy_key=?',
    [chat.id, live.connector, live.policyKey]);
  const outsideEnrollment = row.position <= floor.position || earliest < floor.second * MS_PER_SECOND ||
    (grant && !tx.get(`SELECT 1 FROM messages m WHERE m.id=? AND ${permittedDispatchSourceSql}`, [row.id]));
  // Recheck a pending selection even if the ordinary enrollment has changed since the click.
  const selectedSource = outsideEnrollment || selectOutsideEnrollment === row.id;
  let bankEvidenceOnly = false;
  if (selectedSource) {
    if ((selectOutsideEnrollment !== true && selectOutsideEnrollment !== row.id) || consent?.status === 'withdrawn' ||
      (consent?.status === 'accepted' && earliest < consent.second * MS_PER_SECOND) ||
      getTelegramReplyHold(tx, chat.id).contactOptedOut || isTelegramContactOptOut(row.text)) {
      return 'before_reply_scope';
    }
    // Stream order alone cannot tell whether a delayed Telegram message predates a contact's re-opt-in.
    const verified = tx.get<{ bank: number }>(`SELECT EXISTS (SELECT 1 FROM telegram_evidence_sources x
        WHERE x.message_id=m.id AND x.reason='bank_details') AS bank FROM messages m WHERE m.id=:id AND ${verifiedTelegramSourceSql}
      AND NOT EXISTS (SELECT 1 FROM case_actions a JOIN messages reopened ON reopened.id=a.message_id
        WHERE a.chat_id=m.chat_id AND a.type='telegram_contact_opted_in' AND reopened.id<>m.id AND
          (unixepoch(reopened.sent_at)>unixepoch(m.sent_at)
          OR CAST(substr(reopened.source_message_id,4) AS INTEGER)>=CAST(substr(m.source_message_id,4) AS INTEGER)))`,
      { id: row.id, connector: live.connector, policyKey: live.policyKey });
    if (!verified) return 'before_reply_scope';
    bankEvidenceOnly = !!verified.bank || sharedTelegramMaterial(row.text, JSON.parse(row.media) as string[], row.id)
      .some(item => item.reason === 'bank_details');
  }
  // A past permission invitation did not answer the participant's message.
  const answered = head.direction === 'outgoing' && tx.get(`SELECT 1 FROM messages m
    WHERE m.chat_id=:chatId AND m.position>:inbound AND m.direction='outgoing' AND ${currentTestMessageSql}
      AND NOT EXISTS (SELECT 1 FROM case_actions a WHERE a.message_id=m.id AND a.type='ai_reply_sent'
        AND json_extract(a.detail,'$.source')='consent_notice') LIMIT 1`, { chatId: chat.id, inbound: row.position, ...window });
  const state = answered ? 'answered' : stateOf(tx, chat.id, row.id);
  const confirmation = tx.get<{ position: number }>(`SELECT max(?, coalesce((SELECT max(position) FROM case_actions WHERE chat_id=?),0),
    coalesce((SELECT max(position) FROM message_events WHERE chat_id=?),0)) AS position`, [head.position, chat.id, chat.id]);
  return { ...row, ...(selectedSource && { selectedSourceId: row.id }), ...(bankEvidenceOnly && { bankEvidenceOnly: true as const }),
    ...(allowMedia && !row.text.trim() && { needText: true as const }),
    headPosition: head.position, confirmationPosition: confirmation?.position ?? head.position,
    state: state === 'unanswered' && isTelegramReplyHeld(tx, chat.id, row.position) ? 'reviewed' : state };
}

/** An officer's request that is still to be carried out. */
export interface ReplyRequest {
  id: string;
  /** The request's own place in the workspace stream: outcomes before it no longer close the message. */
  position: number;
  anchorId: string;
  kind: TelegramReplyRequestKind;
  /** The connection the officer selected for the request. Older requests lack this field. */
  policyKey?: string | null;
  explicit?: number;
  /** Only this proven incoming message may cross an enrollment cutoff for this request. */
  selectedSourceId?: string;
  /** The send already submitted when the officer approved this chat, if verified as a permission notice. */
  afterNoticeTrigger?: string | null;
  /** Epoch milliseconds after which the worker no longer acts on it. */
  until: number;
  /** The newest message included in this target. A manual request can follow verified incoming messages while pending. */
  headPosition: number;
}

interface RequestRow extends ReplyRequest {
  actorId: string | null;
  occurredAt: string;
  approvalDispatchId?: string;
}

function latestRequest(tx: Tx, chatId: string): RequestRow | undefined {
  const row = tx.get<RequestRow & { anchorId: string | null }>(
    `SELECT r.id, r.position, r.message_id AS anchorId, r.actor_id AS actorId, r.occurred_at AS occurredAt,
       json_extract(r.detail,'$.kind') AS kind, json_extract(r.detail,'$.until') AS until,
       json_extract(r.detail,'$.headPosition') AS headPosition, json_extract(r.detail,'$.policyKey') AS policyKey,
       coalesce(json_extract(r.detail,'$.explicit'),0) AS explicit, json_extract(r.detail,'$.afterNoticeTrigger') AS afterNoticeTrigger,
       json_extract(r.detail,'$.selectedSourceId') AS selectedSourceId, json_extract(r.detail,'$.approvalDispatchId') AS approvalDispatchId
     FROM case_actions r WHERE r.chat_id=:chatId AND r.type='${REPLY_REQUESTED}' ORDER BY r.position DESC LIMIT 1`, { chatId });
  // A request belongs to the test it was made in; a later fresh test starts with none.
  if (!row || row.anchorId === null || row.position <= readChatTestWindow(tx, chatId).position) return undefined;
  return row as RequestRow;
}

/** The latest outcome the worker recorded for a request: a sent reply, a deliberate silence or a failure. */
function outcomeOf(tx: Tx, chatId: string, request: Pick<ReplyRequest, 'id' | 'position'>) {
  return tx.get<{ type: string; messageId: string | null; code: string | null; anchorId: string | null; requestKind: TelegramReplyRequestKind | null }>(
    `SELECT type, message_id AS messageId, json_extract(detail,'$.code') AS code, json_extract(detail,'$.requestKind') AS requestKind,
       CASE WHEN type='ai_reply_sent' THEN json_extract(detail,'$.inReplyTo') ELSE message_id END AS anchorId FROM case_actions
     WHERE chat_id=:chatId AND position>:position AND json_extract(detail,'$.requestId')=:id
       AND type IN ('ai_reply_sent','ai_reply_skipped','ai_reply_failed') ORDER BY position DESC LIMIT 1`,
    { chatId, position: request.position, id: request.id });
}

/** A review the worker opened on the requested message after the request: the request waits behind it. */
function reviewAfter(tx: Tx, chatId: string, request: Pick<ReplyRequest, 'anchorId' | 'position' | 'explicit'>): boolean {
  return tx.get(
    `SELECT 1 FROM case_actions a WHERE a.chat_id=:chatId AND a.position>:position AND ${blockingReviewRequestSql('a')}
       AND NOT EXISTS (SELECT 1 FROM case_actions done WHERE done.chat_id=a.chat_id
         AND done.type='telegram_officer_review_resolved' AND json_extract(done.detail,'$.reviewActionId')=a.id)
       AND (:explicit=1 OR message_id=:anchorId OR json_extract(detail,'$.triggerMessageId')=:anchorId) LIMIT 1`,
    { chatId, position: request.position, anchorId: request.anchorId, explicit: request.explicit ?? 0 }) !== undefined;
}

/** Which changes cancel a queued send, even after the officer resumes Ali. */
function superseded(tx: Tx, chatId: string, request: ReplyRequest): boolean {
  // New direct DMs can move the target. A notice already in flight may also land without answering the contact.
  const mayRetarget = !!request.explicit && !!request.policyKey;
  const stopsRetarget = `AND NOT (m.direction IS 'incoming' AND m.origin='source' AND m.capture_method='telegram_business_live'
    AND m.original_captured=1 AND m.deleted_at_source=0 AND m.sender_external_id IS (SELECT external_chat_id FROM chats WHERE id=:chatId)
    AND NOT EXISTS (SELECT 1 FROM json_each(m.unsupported_content) WHERE value IN ('forwarded','blockquote'))
    AND EXISTS (SELECT 1 FROM telegram_message_proofs p WHERE p.message_id=m.id AND p.connection_hash=substr(:policyKey,-64)
      AND p.content_kind='normal' AND p.own_send=0 AND p.message_number>(SELECT coalesce(max(CAST(substr(prior.source_message_id,4) AS INTEGER)),0)
        FROM messages prior WHERE prior.chat_id=m.chat_id AND prior.position>=:head AND prior.position<m.position
          AND prior.source_message_id GLOB 'tg:[0-9]*')
      AND p.connector_id=(SELECT e.connector_id FROM message_events e
        WHERE e.message_id=:anchorId AND e.type='recorded' LIMIT 1))
    AND NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type IN ('edited','deleted','conflicting_copy')))`;
  return tx.get(`SELECT 1 FROM messages m WHERE m.chat_id=:chatId AND m.position>:head AND ${currentTestMessageSql}
      AND NOT (m.direction IS 'outgoing' AND EXISTS (SELECT 1 FROM case_actions a
        WHERE a.chat_id=m.chat_id AND a.message_id=m.id AND a.type='ai_reply_sent' AND json_extract(a.detail,'$.source')='consent_notice'
        AND coalesce(json_extract(a.detail,'$.requestId'),json_extract(a.detail,'$.inReplyTo'))=:afterNoticeTrigger))
      ${mayRetarget ? stopsRetarget : ''} LIMIT 1`,
    { chatId, head: request.headPosition, afterNoticeTrigger: request.afterNoticeTrigger ?? null, ...readChatTestWindow(tx, chatId),
      ...(mayRetarget && { policyKey: request.policyKey!, anchorId: request.anchorId }) }) !== undefined ||
    tx.get(`SELECT 1 FROM case_actions a WHERE a.chat_id=? AND a.position>? AND
      (type IN ('control_pause','control_take_over','telegram_contact_opted_out') OR ${blockingReviewResolutionSql('a')}
        OR (type='leave_unanswered' AND (message_id=? OR ?))) LIMIT 1`, [chatId, request.position, request.anchorId, Number(mayRetarget)]) !== undefined ||
    tx.get(`SELECT 1 FROM message_events WHERE message_id=? AND position>?
      AND type IN ('edited','deleted','conflicting_copy') LIMIT 1`, [request.anchorId, request.position]) !== undefined;
}

/** Keep one officer request across a burst of incoming messages, using the newest eligible content when drafting. */
function currentRequestTarget(tx: Tx, chat: ChatRow, live: LiveChat, request: RequestRow, nowMs: number): ReplyRequest | undefined {
  if ((request.policyKey && request.policyKey !== live.policyKey) || superseded(tx, chat.id, request)) return undefined;
  if (request.kind === 'consent_notice' && hasOfficerDispatchApproval(tx, chat.id, live.connector, live.policyKey)) return undefined;
  const { actorId, occurredAt: _occurredAt, selectedSourceId, approvalDispatchId, ...open } = request;
  if (selectedSourceId) {
    if (!request.explicit || request.policyKey !== live.policyKey || request.kind === 'consent_notice' ||
      selectedSourceId !== request.anchorId || !approvalDispatchId || !actorId) return undefined;
    const approved = tx.get(`SELECT 1 FROM case_actions a JOIN principals p ON p.id=a.actor_id AND p.kind='officer'
      WHERE a.chat_id=:chatId AND a.actor_id=:actorId AND a.position<:requestPosition AND ${officerDispatchScopeSql}
        AND json_extract(a.detail,'$.dispatchId')=:dispatchId
        AND NOT EXISTS (SELECT 1 FROM telegram_dispatch_permissions g WHERE g.chat_id=a.chat_id
          AND g.connector_id=:connector AND g.policy_key=:policyKey AND (g.suspended=1 OR g.cutoff_position>=:requestPosition))`,
      { chatId: chat.id, actorId, requestPosition: request.position, connector: live.connector, policyKey: live.policyKey, dispatchId: approvalDispatchId });
    const floor = replyFloor(tx, live, chat);
    if (!approved || !floor || floor.position >= request.position) return undefined;
  }
  if (!request.explicit) return open;
  const target = replyTarget(tx, chat, live, nowMs, { allowMedia: true, selectOutsideEnrollment: selectedSourceId });
  if (typeof target === 'string' || target.bankEvidenceOnly) return undefined;
  if (target.id === request.anchorId && (target.headPosition === request.headPosition || request.afterNoticeTrigger)) {
    return { ...open, headPosition: target.headPosition, ...(selectedSourceId && { selectedSourceId }) };
  }
  if (target.headPosition === request.headPosition) return undefined;
  if ((!request.afterNoticeTrigger && target.position !== target.headPosition) || target.position <= request.headPosition) return undefined;
  return { ...open, anchorId: target.id, headPosition: target.headPosition,
    kind: open.kind === 'consent_notice' ? 'consent_notice' : target.needText ? 'ask_for_text' : 'reply' };
}

export function openReplyRequest(tx: Tx, chat: ChatRow, live: LiveChat, nowMs: number): ReplyRequest | undefined {
  const request = latestRequest(tx, chat.id);
  if (!request || !(request.until > nowMs) || outcomeOf(tx, chat.id, request) || reviewAfter(tx, chat.id, request)) return undefined;
  return currentRequestTarget(tx, chat, live, request, nowMs);
}

function statusOf(tx: Tx, chat: ChatRow, live: LiveChat, request: RequestRow, nowMs: number): NonNullable<TelegramReplies['request']> {
  const outcome = outcomeOf(tx, chat.id, request);
  const current = outcome ? undefined : currentRequestTarget(tx, chat, live, request, nowMs);
  // Telegram can deliver a copy of the outgoing notice before acknowledging its send. Until then its
  // case-action attribution is missing. Keep the downstream receipt pending while that exact send settles.
  const awaitingNoticeReceipt = !current && !outcome && request.afterNoticeTrigger && chat.ai_mode === 'ai_active' &&
    request.policyKey === live.policyKey && !getTelegramReplyHold(tx, chat.id).contactOptedOut &&
    tx.get('SELECT 1 FROM telegram_pending_sends WHERE chat_id=? AND trigger_id=? AND expires_at>?',
      [chat.id, request.afterNoticeTrigger, new Date(nowMs).toISOString()]);
  let status: TelegramReplyRequestStatus = 'queued';
  if (outcome) status = outcome.type === 'ai_reply_sent' ? 'sent' : outcome.type === 'ai_reply_skipped' ? 'skipped' : 'failed';
  else if (reviewAfter(tx, chat.id, request)) status = 'held';
  else if (!(request.until > nowMs)) status = 'expired';
  else if (!current && !awaitingNoticeReceipt) status = 'superseded';
  else if (getTelegramReplyHold(tx, chat.id).officerReview) status = 'held';
  return {
    id: request.id, messageId: outcome?.anchorId ?? current?.anchorId ?? request.anchorId,
    kind: outcome?.requestKind ?? current?.kind ?? request.kind, status,
    requestedAt: request.occurredAt, requestedBy: principalLookup(tx)(request.actorId),
    replyMessageId: status === 'sent' ? outcome?.messageId ?? null : null,
    failureCode: status === 'failed' ? outcome?.code ?? null : null,
  };
}

/** Whether Ali answers this contact's future messages without another Dispatch, or the one thing that stops him. */
export function automaticState(tx: Tx, chat: ChatRow, live: LiveChat, telegram: Telegram, runtimeAvailable: boolean,
  permission: TelegramAiPermission): TelegramAutomaticState {
  if (chat.ai_mode === 'not_started') return 'not_started';
  if (chat.ai_mode === 'paused') return 'paused';
  if (chat.ai_mode === 'officer_control') return 'officer_control';
  if (permission === 'withdrawn') return 'opted_out';
  if (getTelegramReplyHold(tx, chat.id).officerReview) return 'review_hold';
  if (dmPolicyMode(readDmPolicy(tx, live.connector, live.policyKey), telegram) === 'off') return 'replies_off';
  const gates = runtimeAvailable && telegram.liveEnabled && telegram.aiReplies.enabled && Boolean(telegram.aiReplies.consentReference);
  const suspended = tx.get('SELECT 1 FROM telegram_dispatch_permissions WHERE chat_id=? AND connector_id=? AND policy_key=? AND suspended=1',
    [chat.id, live.connector, live.policyKey]) !== undefined;
  if (!gates || suspended) return 'replies_offline';
  return permission === 'needed' ? 'needs_permission' : 'active';
}

/** What stops a reply in this chat whatever the officer confirms: their own control, the contact, a review, the gates. */
const HARD_STOPS: readonly TelegramAutomaticState[] = ['paused', 'officer_control', 'opted_out', 'review_hold', 'replies_off', 'replies_offline'];
const CONFIRMABLE: Partial<Record<TelegramReplyTargetState, TelegramNoReplyReason>> = {
  left_unanswered: 'left_unanswered', skipped: 'ai_skipped', failed: 'ai_failed', reviewed: 'reviewed', answered: 'already_answered',
};

/** The officer's view of replies in this chat, for the timeline; undefined when the chat is not on the live account. */
export function telegramRepliesOf(tx: Tx, chat: ChatRow, telegram: Telegram, runtimeAvailable: boolean): TelegramReplies | undefined {
  const live = liveChatOf(tx, chat, telegram);
  const permission = live && telegramAiPermission(tx, chat, telegram, getTelegramReplyHold(tx, chat.id).contactOptedOut);
  if (!live || !permission) return undefined;
  const nowMs = Date.parse(tx.now());
  const automatic = automaticState(tx, chat, live, telegram, runtimeAvailable, permission);
  const target = replyTarget(tx, chat, live, nowMs, { allowMedia: true, selectOutsideEnrollment: true });
  const request = latestRequest(tx, chat.id);
  const stopped = HARD_STOPS.includes(automatic);
  return {
    permission, automatic,
    target: typeof target === 'string' ? null : { messageId: target.id, state: target.state, headPosition: target.confirmationPosition },
    blocked: stopped ? (automatic as TelegramNoReplyReason) : typeof target === 'string' ? target : target.bankEvidenceOnly ? 'bank_evidence' : null,
    request: request ? statusOf(tx, chat, live, request, nowMs) : null,
  };
}

/** The part of Dispatch that is on record already: who may be answered and through which permission. */
export interface TelegramDispatch {
  telegram: Telegram;
  /** Whether the live connector and the reply worker are running. */
  runtimeAvailable: boolean;
  /** The officer deliberately asks again about a message that already has a decision or an outcome. */
  again: boolean;
  replyToMessageId?: string;
  replyToHeadPosition?: number;
}

function none(permission: TelegramAiPermission, automatic: TelegramAutomaticState, reason: TelegramNoReplyReason,
  confirmable = false, messageId: string | null = null): TelegramDispatchOutcome {
  return { permission, automaticReplies: automatic, reply: 'none', reason, confirmable, requestId: null, messageId };
}

/**
 * The Telegram half of a Dispatch, after the chat's mode was settled and any permission the officer confirmed was
 * recorded: asks Ali for a reply to the contact's latest message, or says exactly why not. One open request per chat:
 * a second Dispatch for the same message returns the request already queued.
 */
export function requestTelegramReply(tx: Tx, officer: Principal, chat: ChatRow, live: LiveChat, options: TelegramDispatch,
  approvalDispatchId?: string): TelegramDispatchOutcome {
  const { telegram, runtimeAvailable } = options;
  const now = tx.now();
  recoverExpiredTelegramSends(tx, now, chat.id);
  const permission = telegramAiPermission(tx, chat, telegram, getTelegramReplyHold(tx, chat.id).contactOptedOut) ?? 'needed';
  if (permission === 'approved' && runtimeAvailable && telegram.liveEnabled && telegram.aiReplies.enabled && telegram.aiReplies.consentReference) {
    resumeDispatchPermissions(tx, live.connector, live.policyKey, chat.workspace_id, chat.id);
  }
  const automatic = automaticState(tx, chat, live, telegram, runtimeAvailable, permission);
  // The officer's own control, the contact's opt-out, an open review and the switches are never worked around.
  const explicit = options.again && officer.kind === 'officer';
  if (automatic === 'not_started' || automatic === 'needs_permission') return none(permission, automatic, automatic);
  if (HARD_STOPS.includes(automatic)) return none(permission, automatic, automatic as TelegramNoReplyReason);
  const nowMs = Date.parse(now);
  const target = replyTarget(tx, chat, live, nowMs, { allowMedia: explicit, selectOutsideEnrollment: explicit && approvalDispatchId ? true : undefined });
  if (options.replyToMessageId && (typeof target === 'string' || target.id !== options.replyToMessageId)) {
    return none(permission, automatic, 'target_changed');
  }
  if (typeof target === 'string') return none(permission, automatic, target);
  if (target.selectedSourceId) {
    recordDispatchTargetEvidence(tx, chat, target);
    if (getTelegramReplyHold(tx, chat.id).officerReview) return none(permission, 'review_hold', 'review_hold', false, target.id);
    if (target.bankEvidenceOnly) return none(permission, automatic, 'bank_evidence', false, target.id);
  }
  const windowEnd = Math.min(Date.parse(target.sentAt), Date.parse(target.receivedAt)) + DAY_MS;
  const until = explicit ? windowEnd : Math.min(nowMs + REPLY_FRESHNESS_MS, windowEnd);
  const open = openReplyRequest(tx, chat, live, nowMs);
  if (open && open.kind !== 'consent_notice' && open.anchorId === target.id && open.headPosition === target.headPosition) {
    return { permission, automaticReplies: automatic, reply: 'queued', kind: open.kind, reason: null, confirmable: false, requestId: open.id, messageId: open.anchorId };
  }
  // An in-flight invitation cannot answer the contact. Keep the requested reply queued behind its lease.
  // Previously stored explicit invitations have a typed request. Older untyped sends remain ambiguous.
  const pending = tx.get<{ triggerId: string; notice: number | null }>(`SELECT p.trigger_id AS triggerId,
    (coalesce(p.notice_policy_key, CASE WHEN json_extract(r.detail,'$.kind')='consent_notice' THEN json_extract(r.detail,'$.policyKey') END)=:policyKey
     AND EXISTS (SELECT 1 FROM message_events e WHERE e.chat_id=p.chat_id AND e.message_id=coalesce(r.message_id,p.trigger_id)
       AND e.type='recorded' AND e.connector_id=:connector AND e.capture_method='telegram_business_live')) AS notice
    FROM telegram_pending_sends p LEFT JOIN case_actions r ON r.chat_id=p.chat_id AND r.id=p.trigger_id AND r.type='telegram_reply_requested'
    WHERE p.chat_id=:chatId AND p.expires_at>:now`, { chatId: chat.id, connector: live.connector, policyKey: live.policyKey, now });
  if (pending && (!explicit || !pending.notice)) {
    return none(permission, automatic, 'send_in_progress', false, target.id);
  }
  const confirm = CONFIRMABLE[target.state];
  if (confirm && !options.again) return none(permission, automatic, confirm, true, target.id);
  tx.run(`UPDATE telegram_dispatch_permissions SET catchup_id=?, catchup_until=?
    WHERE chat_id=? AND connector_id=? AND policy_key=? AND suspended=0`, [target.id, until, chat.id, live.connector, live.policyKey]);
  const kind: TelegramReplyRequestKind = target.needText ? 'ask_for_text'
    : target.state === 'answered' ? 'follow_up' : target.state === 'unanswered' ? 'reply' : 'retry';
  const request = record(tx, {
    chatId: chat.id, workspaceId: chat.workspace_id, actorId: officer.id, type: REPLY_REQUESTED, messageId: target.id,
    detail: { kind, until, headPosition: target.headPosition, policyKey: live.policyKey, ...(explicit && { explicit: true }),
      ...(target.selectedSourceId && approvalDispatchId && { selectedSourceId: target.selectedSourceId, approvalDispatchId }),
      ...(pending && { afterNoticeTrigger: pending.triggerId }),
      ...(target.state === 'left_unanswered' && { reverses: 'leave_unanswered' }) },
  });
  return { permission, automaticReplies: automatic, reply: 'queued', kind, reason: null, confirmable: false, requestId: request.id, messageId: target.id };
}
