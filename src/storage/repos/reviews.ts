/** Review rows: one per incoming source message event with text (design section 10). */
import type { ReviewStatus } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { ReviewRow } from '../rows.ts';

export interface InsertReviewInput {
  chatId: string;
  messageId: string;
  messageEventId: string;
  status: ReviewStatus;
}

export function insertReview(tx: Tx, input: InsertReviewInput): ReviewRow {
  const at = tx.now();
  const row = tx.get<ReviewRow>(
    `INSERT INTO reviews (id, chat_id, message_id, message_event_id, status, created_at, updated_at)
     VALUES (:id, :chatId, :messageId, :messageEventId, :status, :at, :at) RETURNING *`,
    { id: newId('rev'), ...input, at },
  );
  if (!row) throw new Error('review_insert_failed');
  return row;
}

export function listReviewsForChat(tx: Tx, chatId: string): ReviewRow[] {
  return tx.all<ReviewRow>('SELECT * FROM reviews WHERE chat_id = :chatId', { chatId });
}

/** Number of reviews per status for one chat. */
export function reviewStatusCounts(tx: Tx, chatId: string): Partial<Record<ReviewStatus, number>> {
  const rows = tx.all<{ status: ReviewStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM reviews WHERE chat_id = :chatId GROUP BY status',
    { chatId },
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
