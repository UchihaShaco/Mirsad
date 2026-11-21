/** Capture work rows: one per source message event with content, created pending in the intake transaction. */
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
