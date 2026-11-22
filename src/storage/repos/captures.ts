/** Capture work rows: one per source message event with content, created pending in the intake transaction. */
import type { Direction, MessageEventType, Source } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { CaptureRow } from '../rows.ts';

export function insertPendingCapture(tx: Tx, input: { chatId: string; messageId: string; messageEventId: string }): CaptureRow {
  const at = tx.now();
  const row = tx.get<CaptureRow>(
    `INSERT INTO captures (id, chat_id, message_id, message_event_id, status, created_at, updated_at)
     VALUES (:id, :chatId, :messageId, :messageEventId, 'pending', :at, :at) RETURNING *`,
    { id: newId('cap'), ...input, at },
  );
  if (!row) throw new Error('capture_insert_failed');
  return row;
}

/** A capture with the checksum of its linked artifact (null until an image is stored). */
export interface CaptureWithArtifact extends CaptureRow {
  artifact_sha256: string | null;
}

export function listCapturesForChat(tx: Tx, chatId: string): CaptureWithArtifact[] {
  return tx.all<CaptureWithArtifact>(
    `SELECT c.*, a.sha256 AS artifact_sha256 FROM captures c LEFT JOIN artifacts a ON a.id = c.artifact_id
     WHERE c.chat_id = :chatId`,
    { chatId },
  );
}

export function findCaptureById(tx: Tx, captureId: string): CaptureRow | undefined {
  return tx.get<CaptureRow>('SELECT * FROM captures WHERE id = :captureId', { captureId });
}

/** Queues a failed capture again (status `pending`, error cleared); any other status is left alone. */
export function requeueFailedCapture(tx: Tx, captureId: string): CaptureRow | undefined {
  return tx.get<CaptureRow>(
    `UPDATE captures SET status = 'pending', last_error_code = NULL, updated_at = :at
     WHERE id = :captureId AND status = 'failed' RETURNING *`,
    { captureId, at: tx.now() },
  );
}

/** At startup: captures a stopped process left `rendering` go back to `pending`. Returns how many moved. */
export function requeueRenderingCaptures(tx: Tx): number {
  const result = tx.run("UPDATE captures SET status = 'pending', updated_at = :at WHERE status = 'rendering'", { at: tx.now() });
  return result.changes;
}

/** Claims the oldest pending capture for rendering: status `rendering`, attempts + 1. */
export function claimOldestPendingCapture(tx: Tx): CaptureRow | undefined {
  return tx.get<CaptureRow>(
    `UPDATE captures SET status = 'rendering', attempts = attempts + 1, updated_at = :at
     WHERE id = (SELECT id FROM captures WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1)
     RETURNING *`,
    { at: tx.now() },
  );
}

/** Links the stored image and ends the attempt as ready; a capture that is not rendering is left alone. */
export function markCaptureReady(tx: Tx, captureId: string, artifactId: string): CaptureRow | undefined {
  return tx.get<CaptureRow>(
    `UPDATE captures SET status = 'ready', artifact_id = :artifactId, last_error_code = NULL, updated_at = :at
     WHERE id = :captureId AND status = 'rendering' RETURNING *`,
    { captureId, artifactId, at: tx.now() },
  );
}

/** Ends a rendering attempt as failed; a capture that is not rendering is left alone (undefined). */
export function markCaptureFailed(tx: Tx, captureId: string, errorCode: string): CaptureRow | undefined {
  return tx.get<CaptureRow>(
    `UPDATE captures SET status = 'failed', last_error_code = :errorCode, updated_at = :at
     WHERE id = :captureId AND status = 'rendering' RETURNING *`,
    { captureId, errorCode, at: tx.now() },
  );
}

/** The saved record a capture shows: its own message event, the message, the chat and the channel. */
export interface CaptureSourceRow {
  capture_id: string;
  chat_id: string;
  workspace_id: string;
  chat_label: string;
  source: Source;
  message_id: string;
  direction: Direction | null;
  sender_display_name: string | null;
  sender_external_id: string | null;
  sender_phone_raw: string | null;
  unsupported_content: string;
  message_event_id: string;
  event_type: MessageEventType;
  event_text: string | null;
  event_text_sha256: string | null;
  event_capture_method: string;
  event_received_at: string;
  event_source_occurred_at: string | null;
}

export function findCaptureSource(tx: Tx, captureId: string): CaptureSourceRow | undefined {
  return tx.get<CaptureSourceRow>(
    `SELECT c.id AS capture_id, ch.id AS chat_id, ch.workspace_id, ch.display_label AS chat_label, a.source,
       m.id AS message_id, m.direction, m.sender_display_name, m.sender_external_id, m.sender_phone_raw, m.unsupported_content,
       e.id AS message_event_id, e.type AS event_type, e.text AS event_text, e.text_sha256 AS event_text_sha256,
       e.capture_method AS event_capture_method, e.received_at AS event_received_at,
       e.source_occurred_at AS event_source_occurred_at
     FROM captures c
     JOIN message_events e ON e.id = c.message_event_id
     JOIN messages m ON m.id = c.message_id
     JOIN chats ch ON ch.id = c.chat_id
     JOIN channel_accounts a ON a.id = ch.channel_account_id
     WHERE c.id = :captureId`,
    { captureId },
  );
}
