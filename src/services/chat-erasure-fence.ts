import { createHash } from 'node:crypto';
import type { IntakeEvent } from '../contract/schemas.ts';
import type { Tx } from '../storage/db.ts';

function digest(chatId: string, kind: 'message' | 'event', value: string): string {
  return createHash('sha256').update(JSON.stringify([chatId, kind, value])).digest('hex');
}

/** Source IDs may contain PII. Keep only chat-scoped one-way digests for deduplication. */
export function rememberErasedSource(tx: Tx, chatId: string, kind: 'message' | 'event', sourceId: string): void {
  tx.run('INSERT OR IGNORE INTO erased_source_keys(chat_id,digest) VALUES (?,?)',
    [chatId, digest(chatId, kind, sourceId)]);
}

export function isErasedSource(tx: Tx, chatId: string, event: IntakeEvent, live: boolean): boolean {
  const fence = tx.get<{ cutoff_second: number; telegram_id: number }>(
    'SELECT cutoff_second,telegram_id FROM chat_erasure_fences WHERE chat_id=?', [chatId]);
  if (!fence) return false;
  if (tx.get('SELECT 1 FROM erased_source_keys WHERE chat_id=? AND digest IN (?,?)',
    [chatId, digest(chatId, 'message', event.sourceMessageId), digest(chatId, 'event', event.sourceEventId)])) return true;
  if (live && /^tg:\d+$/u.test(event.sourceMessageId) && Number(event.sourceMessageId.slice(3)) <= fence.telegram_id) return true;
  if (event.type !== 'message.recorded') {
    // Source edits and deletions need not carry the original send time.
    return !tx.get('SELECT 1 FROM messages WHERE chat_id=? AND source_message_id=?', [chatId, event.sourceMessageId]);
  }
  return event.sentAt !== undefined && Date.parse(event.sentAt) < fence.cutoff_second * 1000;
}
