/** The first message of a chat that is still New messages, as the inbox shows it (see FirstContact in the contract). */
import type { ChatSummary } from '../contract/schemas.ts';
import { maskSensitiveText, truncateText } from '../domain/masked-text.ts';
import type { Tx } from '../storage/db.ts';
import type { ChatRow } from '../storage/rows.ts';
import { currentTestMessageSql, readChatTestWindow } from './chat-test-session.ts';

export const FIRST_CONTACT_PREVIEW_CHARS = 120;

interface FirstRow {
  id: string;
  at: string;
  text: string | null;
  unsupported_content: string;
  deleted_at_source: number;
  incoming: number;
}

/** Null once the chat has left New messages, or while the current test has no message from the contact yet. */
export function readFirstContact(tx: Tx, chat: ChatRow): ChatSummary['firstContact'] {
  if (chat.inbox_status !== 'new_inbound') return null;
  const window = readChatTestWindow(tx, chat.id);
  // The current text: the latest recorded or edited version, as the timeline shows it.
  const row = tx.get<FirstRow>(
    `SELECT m.id, coalesce(m.sent_at, m.received_at) AS at, m.unsupported_content, m.deleted_at_source,
       coalesce((SELECT e.text FROM message_events e WHERE e.message_id=m.id AND e.type IN ('recorded','edited')
         AND e.text IS NOT NULL ORDER BY e.position DESC LIMIT 1), m.text) AS text,
       (SELECT count(*) FROM messages m WHERE m.chat_id=:chatId AND m.direction='incoming' AND ${currentTestMessageSql}) AS incoming
     FROM messages m WHERE m.chat_id=:chatId AND m.direction='incoming' AND ${currentTestMessageSql}
     ORDER BY m.position LIMIT 1`,
    { chatId: chat.id, ...window },
  );
  if (!row) return null;
  const deleted = row.deleted_at_source === 1;
  const masked = !deleted && row.text ? maskSensitiveText(row.text) : '';
  return {
    messageId: row.id,
    at: row.at,
    preview: masked ? truncateText(masked, FIRST_CONTACT_PREVIEW_CHARS) : null,
    notCaptured: deleted ? [] : (JSON.parse(row.unsupported_content) as string[]),
    deleted,
    incomingCount: row.incoming,
  };
}
