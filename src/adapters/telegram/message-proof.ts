import { createHash } from 'node:crypto';
import type { Tx } from '../../storage/db.ts';
import { MEDIA_KINDS, type TelegramMessage } from './types.ts';

export const connectionHash = (id: string): string => createHash('sha256').update(id).digest('hex');
const addressKey = (connection: string, number: number) => 'telegram_delete_address:' + connectionHash(JSON.stringify([connection, number]));
const chatKey = (connection: string, chat: number) => connectionHash(JSON.stringify([connection, 'chat', chat]));

export function addressBelongsToChat(tx: Tx, connector: string, connection: string, message: number, chat: number): boolean {
  return tx.get<{ value: string }>('SELECT value FROM connector_state WHERE connector_id=? AND key=?',
    [connector, addressKey(connection, message)])?.value === chatKey(connection, chat);
}

export function nativeContentKind(message: TelegramMessage): 'normal' | 'dice' | 'unsupported' {
  if ('is_paid_post' in message || !message.from || message.chat.type !== 'private') return 'unsupported';
  if ('dice' in message) return 'dice';
  return typeof message.text === 'string' || MEDIA_KINDS.some(kind => kind in message) ? 'normal' : 'unsupported';
}

/** A deletion takes no chat_id. Only a direct Telegram update or send receipt can vouch for this mapping. */
export function rememberMessageProof(tx: Tx, messageId: string, connector: string, connection: string, chat: number,
  message: number, sentSecond: number, ownSend: boolean, kind: string): void {
  if (![chat, message, sentSecond].every(n => Number.isSafeInteger(n) && n > 0)) return;
  // Keep only opaque, connection-specific digests. Erasing a local chat must never make an ambiguous
  // chat-less Telegram deletion address look safe when another chat is later selected.
  tx.run(`INSERT INTO connector_state(connector_id,key,value,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(connector_id,key) DO UPDATE SET value='ambiguous',updated_at=excluded.updated_at
    WHERE connector_state.value<>excluded.value`, [connector, addressKey(connection, message), chatKey(connection, chat), tx.now()]);
  tx.run(`INSERT INTO telegram_message_proofs(message_id,connector_id,connection_hash,chat_number,message_number,sent_second,own_send,content_kind)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages m JOIN chats c ON c.id=m.chat_id
      WHERE m.id=? AND m.source_message_id=? AND c.external_chat_id=?)
    ON CONFLICT(message_id) DO UPDATE SET own_send=MAX(own_send,excluded.own_send)
    WHERE connector_id=excluded.connector_id AND connection_hash=excluded.connection_hash AND chat_number=excluded.chat_number
      AND message_number=excluded.message_number`, [messageId, connector, connectionHash(connection), chat, message, sentSecond, ownSend, kind,
      messageId, `tg:${message}`, String(chat)]);
}
