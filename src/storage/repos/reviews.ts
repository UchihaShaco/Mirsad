/** Review rows: one per incoming source message event with text (design section 10). */
import type { AiMode, CaptureMethod, ReviewOutcome, ReviewStatus, Source } from '../../contract/enums.ts';
import { appendStreamEvent } from '../../services/stream.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { ChatRow, MessageEventRow, MessageRow, ReviewRow } from '../rows.ts';

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

/** A pending review with what the claim step checks: the chat's mode and revision, the channel and the event. */
export interface ReviewCandidate {
  review_id: string;
  chat_id: string;
  workspace_id: string;
  message_id: string;
  message_event_id: string;
  ai_mode: AiMode;
  revision: number;
  source: Source;
  event_capture_method: CaptureMethod;
  event_text: string | null;
}

/** The pending review with the lowest event position among chats that have no review running. */
export function findNextPendingReview(tx: Tx): ReviewCandidate | undefined {
  return tx.get<ReviewCandidate>(
    `SELECT r.id AS review_id, r.chat_id, c.workspace_id, r.message_id, r.message_event_id, c.ai_mode, c.revision, a.source,
       e.capture_method AS event_capture_method, e.text AS event_text
     FROM reviews r
     JOIN message_events e ON e.id = r.message_event_id
     JOIN chats c ON c.id = r.chat_id
     JOIN channel_accounts a ON a.id = c.channel_account_id
     WHERE r.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM reviews running WHERE running.chat_id = r.chat_id AND running.status = 'running')
     ORDER BY e.position, r.id
     LIMIT 1`,
  );
}

/** Starts an attempt under the chat's current revision: running, attempts + 1. Only a pending review moves. */
export function markReviewRunning(tx: Tx, reviewId: string, revision: number, reviewer: string): ReviewRow | undefined {
  return tx.get<ReviewRow>(
    `UPDATE reviews SET status = 'running', requested_revision = :revision, attempts = attempts + 1, reviewer = :reviewer,
       last_error_code = NULL, updated_at = :at
     WHERE id = :reviewId AND status = 'pending' RETURNING *`,
    { reviewId, revision, reviewer, at: tx.now() },
  );
}

/** A pending review the worker will not run: refused by policy, or its chat is not ai_active. */
export function setPendingReviewAside(
  tx: Tx,
  reviewId: string,
  status: Extract<ReviewStatus, 'not_permitted' | 'not_requested'>,
  errorCode: string | null = null,
): ReviewRow | undefined {
  return tx.get<ReviewRow>(
    `UPDATE reviews SET status = :status, last_error_code = :errorCode, updated_at = :at
     WHERE id = :reviewId AND status = 'pending' RETURNING *`,
    { reviewId, status, errorCode, at: tx.now() },
  );
}

/** Ends a running attempt without a result: unavailable (with a code), stale_discarded, or back to pending. */
export function endReviewAttempt(
  tx: Tx,
  reviewId: string,
  status: Extract<ReviewStatus, 'unavailable' | 'stale_discarded' | 'pending'>,
  errorCode: string | null = null,
): ReviewRow | undefined {
  return tx.get<ReviewRow>(
    `UPDATE reviews SET status = :status, last_error_code = :errorCode, updated_at = :at
     WHERE id = :reviewId AND status = 'running' RETURNING *`,
    { reviewId, status, errorCode, at: tx.now() },
  );
}

export interface ReviewResultCounts {
  outcome: ReviewOutcome;
  unsupported: number;
  suppressed: number;
}

/** Ends a running attempt as completed with its outcome; rejected items and suppressed repeats are added to the counts. */
export function completeReviewAttempt(tx: Tx, reviewId: string, result: ReviewResultCounts): ReviewRow | undefined {
  const at = tx.now();
  return tx.get<ReviewRow>(
    `UPDATE reviews SET status = 'completed', outcome = :outcome, unsupported_count = unsupported_count + :unsupported,
       suppressed_count = suppressed_count + :suppressed, last_error_code = NULL, updated_at = :at, completed_at = :at
     WHERE id = :reviewId AND status = 'running' RETURNING *`,
    { reviewId, ...result, at },
  );
}

/** Publishes the review's current status as `review.updated` (ids and statuses only). */
export function publishReviewUpdated(tx: Tx, workspaceId: string, review: ReviewRow): void {
  appendStreamEvent(tx, {
    workspaceId,
    type: 'review.updated',
    chatId: review.chat_id,
    data: { messageId: review.message_id, messageEventId: review.message_event_id, status: review.status, outcome: review.outcome },
  });
}

/** The rows a running review is published against: the review, its chat, message and reviewed event. */
export interface ReviewContext {
  review: ReviewRow;
  chat: ChatRow;
  message: MessageRow;
  messageEvent: MessageEventRow;
}

export function loadReviewContext(tx: Tx, reviewId: string): ReviewContext | null {
  const review = tx.get<ReviewRow>('SELECT * FROM reviews WHERE id = :reviewId', { reviewId });
  if (!review) return null;
  const chat = tx.get<ChatRow>('SELECT * FROM chats WHERE id = :id', { id: review.chat_id });
  const message = tx.get<MessageRow>('SELECT * FROM messages WHERE id = :id', { id: review.message_id });
  const messageEvent = tx.get<MessageEventRow>('SELECT * FROM message_events WHERE id = :id', { id: review.message_event_id });
  if (!chat || !message || !messageEvent) throw new Error('review_context_missing');
  return { review, chat, message, messageEvent };
}
