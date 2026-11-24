import { approvedReplyChatIds, chatScopeOf, isChatInScope } from '../adapters/telegram/chat-scope.ts';
import { findLiveBindings } from '../adapters/telegram/live-connector.ts';
import type { Config } from '../config.ts';
import { AppError } from '../contract/errors.ts';
import type { Principal } from '../ports/identity.ts';
import { REPLY_FRESHNESS_MS } from '../replies/reply-timing.ts';
import type { Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';
import type { ChatRow } from '../storage/rows.ts';
import { currentTestMessageSql, readChatTestWindow } from './chat-test-session.ts';
import { dmConsentForTurn, recordedDmConsent } from './telegram-dm-consent.ts';
import { dmPolicyKey, readConsentPromptPolicy, readDmPolicy } from './telegram-dm-policy.ts';
import { getTelegramReplyHold, isTelegramReplyHeld, recordTelegramReplyHolds } from './telegram-reply-holds.ts';

/** Reports the contact's permission independently of worker availability or the officer's AI controls. */
export function telegramAiPermission(tx: Tx, chat: ChatRow, telegram: Config['telegram'], optedOut: boolean) {
  const bindings = findLiveBindings(tx);
  const binding = bindings[0];
  if (!binding || bindings.length !== 1 || binding.account.id !== chat.channel_account_id ||
    !telegram.approvedConnectionId || !isChatInScope(chatScopeOf(telegram), chat.external_chat_id, binding.ownerUserId)) return undefined;
  if (optedOut) return 'withdrawn';
  if (approvedReplyChatIds(telegram).includes(chat.external_chat_id)) return 'approved';
  const connector = binding.principal.id;
  const consent = recordedDmConsent(tx, connector, chat.id);
  if (consent?.status === 'withdrawn') return 'withdrawn';
  if (consent?.status === 'accepted') return 'approved';
  const grant = tx.get('SELECT 1 FROM telegram_dispatch_permissions WHERE chat_id=? AND connector_id=? AND policy_key=?',
    [chat.id, connector, dmPolicyKey(binding.account.id, telegram.approvedConnectionId)]);
  return grant ? 'approved' : 'needed';
}

/** The one selected fresh message is an exception to the dispatch-time floor. All other sources must be newer. */
export const permittedDispatchSourceSql = `EXISTS (
  SELECT 1 FROM telegram_dispatch_permissions g JOIN chats c ON c.id=g.chat_id
  WHERE g.chat_id=m.chat_id AND g.suspended=0 AND m.origin='source' AND m.capture_method='telegram_business_live'
    AND m.original_captured=1 AND m.deleted_at_source=0
    AND NOT EXISTS (SELECT 1 FROM telegram_message_proofs proof WHERE proof.message_id=m.id
      AND (proof.connector_id<>g.connector_id OR proof.connection_hash<>substr(g.policy_key,-64)))
    AND (m.direction='outgoing' OR (m.direction='incoming' AND m.sender_external_id=c.external_chat_id))
    AND NOT EXISTS (SELECT 1 FROM json_each(m.unsupported_content) WHERE value IN ('forwarded','blockquote'))
    AND EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type='recorded' AND e.connector_id=g.connector_id)
    AND NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type IN ('edited','conflicting_copy')
      AND (e.connector_id IS NOT g.connector_id OR e.type='conflicting_copy'))
    AND (m.id=g.trigger_id OR (m.position>g.cutoff_position AND unixepoch(m.sent_at)>=g.cutoff_second
      AND m.source_message_id GLOB 'tg:[0-9]*' AND CAST(substr(m.source_message_id,4) AS INTEGER)>g.cutoff_telegram_id)))`;

export function dispatchPermissionForTurn(tx: Tx, connector: string, policyKey: string, chatId: string, messageId: string) {
  const found = tx.get<{ enrolledAfter: number; catchUpUntil: number | null; position: number; text: string }>(
    `SELECT coalesce(trigger.position-1,g.cutoff_position) AS enrolledAfter,
      CASE WHEN m.id=g.catchup_id THEN g.catchup_until END AS catchUpUntil,m.position,m.text
    FROM telegram_dispatch_permissions g LEFT JOIN messages trigger ON trigger.id=g.trigger_id
    JOIN messages m ON m.chat_id=g.chat_id AND m.id=? WHERE g.chat_id=? AND g.connector_id=? AND g.policy_key=?
    AND ${permittedDispatchSourceSql}`, [messageId, chatId, connector, policyKey]);
  if (!found) return undefined;
  const consent = recordedDmConsent(tx, connector, chatId);
  if (consent?.status === 'withdrawn') return undefined;
  if (consent?.status === 'accepted') {
    const turn = dmConsentForTurn(tx, connector, chatId, messageId, found.position, found.text);
    if (turn.action !== 'reply') return undefined;
    return { enrolledAfter: Math.max(found.enrolledAfter, turn.enrolledAfter), enrolledSecond: turn.enrolledSecond,
      afterTelegramId: turn.afterTelegramId, catchUpUntil: found.catchUpUntil };
  }
  return { enrolledAfter: found.enrolledAfter, enrolledSecond: 0, afterTelegramId: undefined, catchUpUntil: found.catchUpUntil };
}

export function recordDispatchPermission(tx: Tx, officer: Principal, chat: ChatRow,
  telegram: Config['telegram'], expectedTestMode: boolean, runtimeAvailable: boolean): void {
  const bindings = findLiveBindings(tx);
  const binding = bindings[0];
  if (!binding || bindings.length !== 1 || binding.account.id !== chat.channel_account_id ||
    !telegram.approvedConnectionId || !isChatInScope(chatScopeOf(telegram), chat.external_chat_id, binding.ownerUserId) ||
    !/^[1-9]\d*$/u.test(chat.external_chat_id) || Number(chat.external_chat_id) === binding.ownerUserId) {
    throw AppError.of('invalid_transition', 'Select a private chat in the linked Telegram account’s intake scope.');
  }
  if (chat.ai_mode === 'paused' || chat.ai_mode === 'officer_control') {
    throw AppError.of('invalid_transition', 'Resume AI before dispatching this chat.');
  }
  const connector = binding.principal.id;
  const policyKey = dmPolicyKey(binding.account.id, telegram.approvedConnectionId);
  if (expectedTestMode && readConsentPromptPolicy(tx, connector, policyKey).enabled) {
    throw AppError.of('revision_conflict', 'Test mode changed. Reopen Dispatch to review the current setting.');
  }
  const consent = recordedDmConsent(tx, connector, chat.id);
  if (consent?.status === 'withdrawn' || getTelegramReplyHold(tx, chat.id).contactOptedOut) {
    throw AppError.of('invalid_transition', 'The participant has withdrawn permission for automated replies.');
  }
  const existing = tx.get('SELECT 1 FROM telegram_dispatch_permissions WHERE chat_id=? AND connector_id=? AND policy_key=?',
    [chat.id, connector, policyKey]);
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = Date.parse(tx.now());
  const policy = readDmPolicy(tx, connector, policyKey);
  const candidate = tx.get<{ id: string; position: number; eventId: string; text: string; media: string; sentAt: string }>(
    `SELECT m.id,m.position,e.id AS eventId,e.text,m.unsupported_content AS media,m.sent_at AS sentAt
     FROM (SELECT m.* FROM messages m WHERE m.chat_id=:chatId AND ${currentTestMessageSql} ORDER BY m.position DESC LIMIT 1) m
     JOIN message_events e ON e.id=(SELECT id FROM message_events WHERE message_id=m.id ORDER BY position DESC LIMIT 1)
     WHERE m.direction='incoming' AND m.origin='source' AND m.original_captured=1 AND m.deleted_at_source=0
       AND m.capture_method='telegram_business_live' AND m.sender_external_id=:contact AND m.source_message_id GLOB 'tg:[0-9]*'
       AND min(m.sent_at,m.received_at)>:since AND m.sent_at<=:now AND length(trim(m.text))>0 AND length(trim(e.text))>0
       AND NOT EXISTS (SELECT 1 FROM telegram_message_proofs proof WHERE proof.message_id=m.id
         AND (proof.connector_id<>:connector OR proof.connection_hash<>substr(:policyKey,-64)))
       AND m.position>:policyPosition AND unixepoch(min(m.sent_at,m.received_at))>=:policySecond
       AND e.type IN ('recorded','edited') AND e.connector_id=:connector
       AND NOT EXISTS (SELECT 1 FROM case_actions outcome WHERE outcome.chat_id=m.chat_id AND (
         (outcome.message_id=m.id AND outcome.type IN ('ai_reply_failed','ai_reply_skipped','leave_unanswered')) OR
         (outcome.type='ai_reply_sent' AND json_extract(outcome.detail,'$.inReplyTo')=m.id) OR
         (outcome.type='telegram_officer_review_requested' AND (outcome.message_id=m.id OR json_extract(outcome.detail,'$.triggerMessageId')=m.id))))
       ${existing ? 'AND ' + permittedDispatchSourceSql : ''}
       AND NOT EXISTS (SELECT 1 FROM json_each(m.unsupported_content) WHERE value IN ('forwarded','blockquote'))`,
    { chatId: chat.id, ...readChatTestWindow(tx, chat.id), contact: chat.external_chat_id, connector, policyKey,
      since: new Date(nowMs - dayMs).toISOString(), now: tx.now(),
      policyPosition: policy?.enabled === false ? Number.MAX_SAFE_INTEGER : policy?.position ?? 0, policySecond: policy?.second ?? 0 });
  const seed = candidate && !isTelegramReplyHeld(tx, chat.id, candidate.position) &&
    (consent?.status !== 'accepted' || dmConsentForTurn(tx, connector, chat.id, candidate.id, candidate.position, candidate.text).action === 'reply')
    ? candidate : undefined;
  const suspended = !runtimeAvailable || !telegram.liveEnabled || !telegram.aiReplies.enabled || !telegram.aiReplies.consentReference;
  const until = seed && !suspended ? Math.min(nowMs + REPLY_FRESHNESS_MS, Date.parse(seed.sentAt) + dayMs) : null;
  if (existing) {
    tx.run('UPDATE telegram_dispatch_permissions SET catchup_id=?,catchup_until=?,suspended=max(suspended,?) WHERE chat_id=?',
      [suspended ? null : seed?.id ?? null, until, suspended, chat.id]);
    return;
  }
  tx.run(`INSERT INTO telegram_dispatch_permissions(chat_id,connector_id,policy_key,cutoff_position,cutoff_second,
    cutoff_telegram_id,trigger_id,suspended,catchup_id,catchup_until) SELECT ?,?,?,stream_seq,?,
      coalesce((SELECT max(CAST(substr(source_message_id,4) AS INTEGER)) FROM messages WHERE chat_id=?
        AND capture_method='telegram_business_live' AND source_message_id GLOB 'tg:[0-9]*'),0),?,?,?,?
      FROM workspaces WHERE id=? ON CONFLICT(chat_id) DO UPDATE SET connector_id=excluded.connector_id,policy_key=excluded.policy_key,
        cutoff_position=excluded.cutoff_position,cutoff_second=excluded.cutoff_second,cutoff_telegram_id=excluded.cutoff_telegram_id,
        trigger_id=excluded.trigger_id,suspended=excluded.suspended,catchup_id=excluded.catchup_id,catchup_until=excluded.catchup_until`,
    [chat.id, connector, policyKey, Math.ceil(nowMs / 1000), chat.id, suspended ? null : seed?.id ?? null, suspended,
      suspended ? null : seed?.id ?? null, until, officer.workspaceId]);
  record(tx, { chatId: chat.id, workspaceId: officer.workspaceId, actorId: officer.id, type: 'telegram_dispatch_permission_recorded' });
  if (seed && !suspended) {
    recordTelegramReplyHolds(tx, { chatId: chat.id, workspaceId: officer.workspaceId, messageId: seed.id,
      messageEventId: seed.eventId, text: seed.text, media: JSON.parse(seed.media) as string[], allowOptIn: false }, true, false);
  }
}

/** Installation gates may have been off while intake continued. Reopening them only permits future sources. */
export function resumeDispatchPermissions(tx: Tx, connector: string, policyKey: string, workspace: string): void {
  tx.run(`UPDATE telegram_dispatch_permissions SET suspended=0,trigger_id=NULL,catchup_id=NULL,catchup_until=NULL,
    cutoff_position=(SELECT stream_seq FROM workspaces WHERE id=?),cutoff_second=?,
    cutoff_telegram_id=max(cutoff_telegram_id,coalesce((SELECT max(CAST(substr(m.source_message_id,4) AS INTEGER))
      FROM messages m WHERE m.chat_id=telegram_dispatch_permissions.chat_id AND m.capture_method='telegram_business_live'
      AND m.source_message_id GLOB 'tg:[0-9]*'),0)) WHERE connector_id=? AND policy_key=? AND suspended=1`,
    [workspace, Math.ceil(Date.parse(tx.now())/1000), connector, policyKey]);
}
