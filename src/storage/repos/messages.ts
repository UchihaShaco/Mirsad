/**
 * Messages and their events (design sections 4 and 7). Original text is written once: at insert, or when the
 * original `recorded` event fills a placeholder's empty text. No function here overwrites stored text.
 */
import type { Direction, MessageEventType } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';
import type { MessageEventRow, MessageRow } from '../rows.ts';

export function findMessageById(tx: Tx, messageId: string): MessageRow | undefined {
  return tx.get<MessageRow>('SELECT * FROM messages WHERE id = :messageId', { messageId });
}

export function findMessageBySourceId(tx: Tx, chatId: string, sourceMessageId: string): MessageRow | undefined {
  return tx.get<MessageRow>(
    'SELECT * FROM messages WHERE chat_id = :chatId AND source_message_id = :sourceMessageId',
    { chatId, sourceMessageId },
  );
}

export interface SourceContent {
  direction: Direction;
  text: string;
  textSha256: string;
  unsupportedContent: string[];
  sentAt: string | null;
  senderExternalId: string | null;
  senderDisplayName: string | null;
  senderPhoneRaw: string | null;
}

export interface InsertSourceMessageInput {
  /** Pre-generated `msg_` ID, so the stream event that issues the position can name the message. */
  id: string;
  chatId: string;
  workspaceId: string;
  sourceMessageId: string;
  captureMethod: string;
  receivedAt: string;
  position: number;
  /** null for a placeholder first seen through an edit or deletion. */
  content: SourceContent | null;
  /** Direction of a placeholder, when the source gave one. */
  placeholderDirection?: Direction | null;
}

export function insertSourceMessage(tx: Tx, input: InsertSourceMessageInput): MessageRow {
  const c = input.content;
  const row = tx.get<MessageRow>(
    `INSERT INTO messages (id, chat_id, workspace_id, direction, origin, source_message_id, original_captured, text, text_sha256,
       unsupported_content, sent_at, received_at, capture_method, sender_external_id, sender_display_name, sender_phone_raw, position)
     VALUES (:id, :chatId, :workspaceId, :direction, 'source', :sourceMessageId, :captured, :text, :sha, :unsupported, :sentAt,
       :receivedAt, :captureMethod, :senderExternalId, :senderDisplayName, :senderPhoneRaw, :position)
     RETURNING *`,
    {
      id: input.id,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      direction: c ? c.direction : (input.placeholderDirection ?? null),
      sourceMessageId: input.sourceMessageId,
      captured: c !== null,
      text: c?.text ?? null,
      sha: c?.textSha256 ?? null,
      unsupported: JSON.stringify(c?.unsupportedContent ?? []),
      sentAt: c?.sentAt ?? null,
      receivedAt: input.receivedAt,
      captureMethod: input.captureMethod,
      senderExternalId: c?.senderExternalId ?? null,
      senderDisplayName: c?.senderDisplayName ?? null,
      senderPhoneRaw: c?.senderPhoneRaw ?? null,
      position: input.position,
    },
  );
  if (!row) throw new Error('message_insert_failed');
  return row;
}

/** Fills a placeholder with the original content; only rows with original_captured = 0 are touched. */
export function fillPlaceholder(tx: Tx, messageId: string, content: SourceContent): MessageRow {
  const row = tx.get<MessageRow>(
    `UPDATE messages SET direction = :direction, original_captured = 1, text = :text, text_sha256 = :sha,
       unsupported_content = :unsupported, sent_at = :sentAt, sender_external_id = :senderExternalId,
       sender_display_name = :senderDisplayName, sender_phone_raw = :senderPhoneRaw
     WHERE id = :messageId AND original_captured = 0 AND text IS NULL RETURNING *`,
    {
      messageId,
      direction: content.direction,
      text: content.text,
      sha: content.textSha256,
      unsupported: JSON.stringify(content.unsupportedContent),
      sentAt: content.sentAt,
      senderExternalId: content.senderExternalId,
      senderDisplayName: content.senderDisplayName,
      senderPhoneRaw: content.senderPhoneRaw,
    },
  );
  if (!row) throw new Error('placeholder_fill_failed');
  return row;
}

export function markEditedAtSource(tx: Tx, messageId: string): MessageRow {
  const row = tx.get<MessageRow>('UPDATE messages SET edited_at_source = 1 WHERE id = :messageId RETURNING *', { messageId });
  if (!row) throw new Error('message_update_failed');
  return row;
}

export function markDeletedAtSource(tx: Tx, messageId: string): MessageRow {
  const row = tx.get<MessageRow>('UPDATE messages SET deleted_at_source = 1 WHERE id = :messageId RETURNING *', { messageId });
  if (!row) throw new Error('message_update_failed');
  return row;
}

/** sent_at of every other source message of the chat (null where the source gave no time). */
export function otherSourceMessageTimes(tx: Tx, chatId: string, exceptMessageId: string): (string | null)[] {
  return tx
    .all<{ sent_at: string | null }>(
      "SELECT sent_at FROM messages WHERE chat_id = :chatId AND origin = 'source' AND id <> :exceptMessageId",
      { chatId, exceptMessageId },
    )
    .map((r) => r.sent_at);
}

export function findEventBySourceEventId(tx: Tx, chatId: string, sourceEventId: string): MessageEventRow | undefined {
  return tx.get<MessageEventRow>(
    'SELECT * FROM message_events WHERE chat_id = :chatId AND source_event_id = :sourceEventId',
    { chatId, sourceEventId },
  );
}

export interface InsertMessageEventInput {
  /** Pre-generated `mev_` ID (see InsertSourceMessageInput.id). */
  id: string;
  chatId: string;
  messageId: string;
  type: MessageEventType;
  sourceEventId: string | null;
  text: string | null;
  textSha256: string | null;
  sourceOccurredAt: string | null;
  receivedAt: string;
  captureMethod: string;
  connectorId: string | null;
  position: number;
}

export function insertMessageEvent(tx: Tx, input: InsertMessageEventInput): MessageEventRow {
  const row = tx.get<MessageEventRow>(
    `INSERT INTO message_events (id, chat_id, message_id, type, source_event_id, text, text_sha256, source_occurred_at,
       received_at, capture_method, connector_id, position)
     VALUES (:id, :chatId, :messageId, :type, :sourceEventId, :text, :textSha256, :sourceOccurredAt,
       :receivedAt, :captureMethod, :connectorId, :position)
     RETURNING *`,
    { ...input },
  );
  if (!row) throw new Error('message_event_insert_failed');
  return row;
}

export function listMessages(tx: Tx, chatId: string): MessageRow[] {
  return tx.all<MessageRow>('SELECT * FROM messages WHERE chat_id = :chatId ORDER BY position, id', { chatId });
}

export function listMessageEvents(tx: Tx, chatId: string): MessageEventRow[] {
  return tx.all<MessageEventRow>('SELECT * FROM message_events WHERE chat_id = :chatId ORDER BY position, id', { chatId });
}

export function countMessages(tx: Tx, chatId: string): number {
  return tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE chat_id = :chatId', { chatId })?.n ?? 0;
}
