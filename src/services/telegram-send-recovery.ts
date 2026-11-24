import type { Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';

/**
 * A crashed sender may have reached Telegram before the local acknowledgement was saved.
 * Close its expired lease and record the uncertainty together, so restart cannot replay it.
 */
export function recoverExpiredTelegramSends(tx: Tx, nowIso: string, chatId?: string): void {
  const expired = tx.all<{ chat_id: string; workspace_id: string; trigger_id: string; messageId: string | null; requestId: string | null }>(
    `SELECT p.chat_id, c.workspace_id, p.trigger_id, m.id AS messageId, r.id AS requestId
     FROM telegram_pending_sends p JOIN chats c ON c.id=p.chat_id
     LEFT JOIN case_actions r ON r.chat_id=p.chat_id AND r.id=p.trigger_id AND r.type='telegram_reply_requested'
     LEFT JOIN messages m ON m.chat_id=p.chat_id AND m.id=coalesce(r.message_id,p.trigger_id)
     WHERE p.expires_at<=? ${chatId ? 'AND p.chat_id=?' : ''}`, chatId ? [nowIso, chatId] : [nowIso]);
  for (const pending of expired) {
    const { requestId, messageId } = pending;
    const settled = messageId && tx.get(
      `SELECT 1 FROM case_actions WHERE chat_id=:chatId AND json_extract(detail,'$.requestId') IS :requestId AND (
       (type='ai_reply_sent' AND (:requestId IS NOT NULL OR json_extract(detail,'$.inReplyTo')=:messageId))
       OR (type='ai_reply_failed' AND (:requestId IS NOT NULL OR message_id=:messageId))) LIMIT 1`,
      { chatId: pending.chat_id, messageId, requestId });
    if (messageId && !settled) {
      record(tx, { chatId: pending.chat_id, workspaceId: pending.workspace_id, actorId: null,
        type: 'ai_reply_failed', messageId, detail: { code: 'delivery_unknown', status: null, ...(requestId && { requestId }) } });
    }
    tx.run('DELETE FROM telegram_pending_sends WHERE chat_id=? AND trigger_id=?', [pending.chat_id, pending.trigger_id]);
  }
}
