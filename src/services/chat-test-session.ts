import { AppError } from '../contract/errors.ts';
import type { Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';
import { findPrincipalById, toPrincipal } from '../storage/repos/principals.ts';
import { requireChat } from './access.ts';
import { activeLowerConcernActionId } from './lower-concern.ts';

export interface ChatTestWindow {
  position: number;
  second: number;
  telegramId: number;
}

export function readChatTestWindow(tx: Tx, chatId: string): ChatTestWindow {
  // Telegram supplies whole seconds. A message from a partially elapsed reset second can predate the reset.
  return tx.get<ChatTestWindow>(`SELECT position,
    unixepoch(occurred_at) + (substr(occurred_at,21,3) != '000') AS second,
    coalesce(json_extract(detail,'$.telegramId'),0) AS telegramId FROM case_actions
    WHERE chat_id=? AND type='chat_test_started' ORDER BY position DESC LIMIT 1`, [chatId])
    ?? { position: 0, second: 0, telegramId: 0 };
}

export function readChatTestBoundary(tx: Tx, chatId: string): number {
  return readChatTestWindow(tx, chatId).position;
}

/** The active episode uses new source messages. A late result of a send in the old episode stays with its trigger. */
export const currentTestMessageSql = `m.position > :position AND (:position = 0 OR (
  (m.capture_method != 'telegram_business_live' OR (
    unixepoch(coalesce(m.sent_at,m.received_at)) >= :second AND m.source_message_id GLOB 'tg:[0-9]*'
    AND CAST(substr(m.source_message_id,4) AS INTEGER) > :telegramId))
  AND (m.direction IS NOT 'outgoing' OR NOT EXISTS (
    SELECT 1 FROM case_actions sent JOIN messages trigger ON trigger.id=json_extract(sent.detail,'$.inReplyTo')
    WHERE sent.message_id=m.id AND sent.type='ai_reply_sent' AND trigger.position <= :position))
))`;

export function currentTestMessageIds(tx: Tx, chatId: string, window: ChatTestWindow): Set<string> {
  return new Set(tx.all<{ id: string }>(`SELECT m.id FROM messages m WHERE m.chat_id=:chatId AND ${currentTestMessageSql}`,
    { chatId, ...window }).map(row => row.id));
}

/** Called inside the officer's transaction. Evidence, control ownership and contact permissions survive. */
export function startFreshChatTest(tx: Tx, chatId: string, officerId: string): number {
  const officer = findPrincipalById(tx, officerId);
  if (!officer || officer.kind !== 'officer') throw AppError.of('forbidden_for_principal', 'An officer is required.');
  const chat = requireChat(tx, toPrincipal(officer), chatId);
  const archivedLowerConcernActionId = activeLowerConcernActionId(tx, chatId);
  const { telegramId } = tx.get<{ telegramId: number }>(`SELECT coalesce(max(CAST(substr(source_message_id,4) AS INTEGER)),0) AS telegramId
    FROM messages WHERE chat_id=? AND capture_method='telegram_business_live' AND source_message_id GLOB 'tg:[0-9]*'`, [chatId])!;
  tx.run('DELETE FROM dispatch_briefs WHERE chat_id=?', [chatId]);
  tx.run('UPDATE chats SET revision=revision+1, updated_at=? WHERE id=?', [tx.now(), chatId]);
  return record(tx, { chatId, workspaceId: chat.workspace_id, actorId: officerId, type: 'chat_test_started',
    revision: chat.revision + 1, detail: { telegramId, archivedLowerConcernActionId } }).position;
}
