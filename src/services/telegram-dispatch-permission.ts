import { approvedReplyChatIds, chatScopeOf, isChatInScope } from '../adapters/telegram/chat-scope.ts';
import { findLiveBindings } from '../adapters/telegram/live-connector.ts';
import type { Config } from '../config.ts';
import { AppError } from '../contract/errors.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';
import { directTelegramTextSql } from '../storage/repos/messages.ts';
import type { ChatRow } from '../storage/rows.ts';
import { dmConsentForTurn, recordedDmConsent } from './telegram-dm-consent.ts';
import { dmPolicyKey, readConsentPromptPolicy } from './telegram-dm-policy.ts';
import { getTelegramReplyHold, recordTelegramReplyHolds } from './telegram-reply-holds.ts';
import type { LiveChat, ReplyTarget } from './telegram-reply-requests.ts';

/** Reports the contact's permission independently of worker availability or the officer's AI controls. */
export function telegramAiPermission(tx: Tx, chat: ChatRow, telegram: Config['telegram'], optedOut: boolean) {
  const bindings = findLiveBindings(tx);
  const binding = bindings[0];
  if (!binding || bindings.length !== 1 || binding.account.id !== chat.channel_account_id ||
    !telegram.approvedConnectionId || !isChatInScope(chatScopeOf(telegram), chat.external_chat_id, binding.ownerUserId)) return undefined;
  if (optedOut) return 'withdrawn';
  const connector = binding.principal.id;
  const policyKey = dmPolicyKey(binding.account.id, telegram.approvedConnectionId);
  const consent = recordedDmConsent(tx, connector, chat.id, policyKey);
  if (consent?.status === 'withdrawn') return 'withdrawn';
  if (consent?.status === 'accepted' || approvedReplyChatIds(telegram).includes(chat.external_chat_id)) return 'approved';
  const grant = tx.get('SELECT 1 FROM telegram_dispatch_permissions WHERE chat_id=? AND connector_id=? AND policy_key=?',
    [chat.id, connector, policyKey]);
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
    AND ${directTelegramTextSql}
    AND EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type='recorded' AND e.connector_id=g.connector_id)
    AND NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id=m.id AND e.type IN ('edited','conflicting_copy')
      AND (e.connector_id IS NOT g.connector_id OR e.type='conflicting_copy'))
    AND (m.id=g.trigger_id OR (m.position>g.cutoff_position AND unixepoch(m.sent_at)>=g.cutoff_second
      AND m.source_message_id GLOB 'tg:[0-9]*' AND CAST(substr(m.source_message_id,4) AS INTEGER)>g.cutoff_telegram_id)))`;

export function dispatchPermissionForTurn(tx: Tx, connector: string, policyKey: string, chatId: string, messageId: string) {
  const found = tx.get<{ enrolledAfter: number; catchUpUntil: number | null; position: number; text: string }>(
    `SELECT coalesce(trigger.position-1,g.cutoff_position) AS enrolledAfter,
      CASE WHEN m.id=g.catchup_id THEN g.catchup_until END AS catchUpUntil,m.position,coalesce(m.text,'') AS text
    FROM telegram_dispatch_permissions g LEFT JOIN messages trigger ON trigger.id=g.trigger_id
    JOIN messages m ON m.chat_id=g.chat_id AND m.id=? WHERE g.chat_id=? AND g.connector_id=? AND g.policy_key=?
    AND ${permittedDispatchSourceSql}`, [messageId, chatId, connector, policyKey]);
  if (!found) return undefined;
  const consent = recordedDmConsent(tx, connector, chatId, policyKey);
  if (consent?.status === 'withdrawn') return undefined;
  if (consent?.status === 'accepted') {
    const turn = dmConsentForTurn(tx, connector, chatId, messageId, found.position, found.text, policyKey);
    if (turn.action !== 'reply') return undefined;
    return { enrolledAfter: Math.max(found.enrolledAfter, turn.enrolledAfter), enrolledSecond: turn.enrolledSecond,
      afterTelegramId: turn.afterTelegramId, catchUpUntil: found.catchUpUntil };
  }
  return { enrolledAfter: found.enrolledAfter, enrolledSecond: 0, afterTelegramId: undefined, catchUpUntil: found.catchUpUntil };
}

/** A live chat resolved in this transaction. The officer attests to agreement obtained from this participant. */
export function recordDispatchPermission(tx: Tx, officer: Principal, chat: ChatRow, live: LiveChat,
  options: { telegram: Config['telegram']; expectedTestMode?: boolean; runtimeAvailable: boolean },
  dispatchId: string, target: ReplyTarget | undefined, legacySingle: boolean): void {
  const { connector, policyKey } = live;
  if (options.expectedTestMode && readConsentPromptPolicy(tx, connector, policyKey).enabled) {
    throw AppError.of('revision_conflict', 'Test mode changed. Reopen Dispatch to review the current setting.');
  }
  if (chat.ai_mode === 'paused' || chat.ai_mode === 'officer_control') {
    if (legacySingle) throw AppError.of('invalid_transition', 'Resume AI before dispatching this chat.');
    return;
  }
  const consent = recordedDmConsent(tx, connector, chat.id, policyKey);
  const hold = getTelegramReplyHold(tx, chat.id);
  if (consent?.status === 'withdrawn' || hold.contactOptedOut) {
    if (legacySingle) throw AppError.of('invalid_transition', 'The participant has withdrawn permission for automated replies.');
    return;
  }
  const active = options.runtimeAvailable && options.telegram.liveEnabled && options.telegram.aiReplies.enabled && !!options.telegram.aiReplies.consentReference;
  const newlyRecorded = !live.listed && consent?.status !== 'accepted' &&
    saveNewGrant(tx, officer, chat, live, active, target);
  record(tx, { chatId: chat.id, workspaceId: officer.workspaceId, actorId: officer.id, type: 'telegram_dispatch_approved',
    detail: { dispatchId, connectorId: connector, policyKey, permission: newlyRecorded ? 'newly_recorded' : 'already_recorded' } });
}

function saveNewGrant(tx: Tx, officer: Principal, chat: ChatRow, live: LiveChat, active: boolean, target?: ReplyTarget): boolean {
  // Only this first grant may admit one selected message from before its cutoff.
  // A subsequent Dispatch never moves the cutoff or adds another historical source.
  const grant = tx.run(`INSERT INTO telegram_dispatch_permissions(chat_id,connector_id,policy_key,cutoff_position,cutoff_second,
    cutoff_telegram_id,suspended,trigger_id) SELECT ?,?,?,stream_seq,?,coalesce((SELECT max(CAST(substr(source_message_id,4) AS INTEGER))
      FROM messages WHERE chat_id=? AND capture_method='telegram_business_live' AND source_message_id GLOB 'tg:[0-9]*'),0),?,?
      FROM workspaces WHERE id=? ON CONFLICT(chat_id) DO UPDATE SET connector_id=excluded.connector_id,policy_key=excluded.policy_key,
        cutoff_position=excluded.cutoff_position,cutoff_second=excluded.cutoff_second,cutoff_telegram_id=excluded.cutoff_telegram_id,
        suspended=excluded.suspended,trigger_id=excluded.trigger_id,catchup_id=NULL,catchup_until=NULL
      WHERE connector_id<>excluded.connector_id OR policy_key<>excluded.policy_key`,
    [chat.id, live.connector, live.policyKey, Math.ceil(Date.parse(tx.now()) / 1000), chat.id, !active,
      active ? target?.id : null, officer.workspaceId]);
  if (grant.changes) {
    record(tx, { chatId: chat.id, workspaceId: officer.workspaceId, actorId: officer.id, type: 'telegram_dispatch_permission_recorded' });
    if (target && active) recordDispatchTargetEvidence(tx, chat, target);
  }
  return grant.changes > 0;
}

/** A selected message may have arrived before intake could screen it under this participant's permission. */
export function recordDispatchTargetEvidence(tx: Tx, chat: ChatRow, target: ReplyTarget): void {
  recordTelegramReplyHolds(tx, { chatId: chat.id, workspaceId: chat.workspace_id, messageId: target.id,
    messageEventId: target.eventId, text: target.text, media: JSON.parse(target.media) as string[], allowOptIn: false }, true, false);
}

/** Installation gates may have been off while intake continued. Reopening them only permits future sources. */
export function resumeDispatchPermissions(tx: Tx, connector: string, policyKey: string, workspace: string, chatId?: string): void {
  tx.run(`UPDATE telegram_dispatch_permissions SET suspended=0,trigger_id=NULL,catchup_id=NULL,catchup_until=NULL,
    cutoff_position=(SELECT stream_seq FROM workspaces WHERE id=?),cutoff_second=?,
    cutoff_telegram_id=max(cutoff_telegram_id,coalesce((SELECT max(CAST(substr(m.source_message_id,4) AS INTEGER))
      FROM messages m WHERE m.chat_id=telegram_dispatch_permissions.chat_id AND m.capture_method='telegram_business_live'
        AND m.source_message_id GLOB 'tg:[0-9]*'),0)) WHERE connector_id=? AND policy_key=? AND suspended=1
      AND (? IS NULL OR chat_id=?)`,
    [workspace, Math.ceil(Date.parse(tx.now())/1000), connector, policyKey, chatId, chatId]);
}
