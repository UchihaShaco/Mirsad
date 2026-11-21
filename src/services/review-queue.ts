/** Review row status at creation and the two requeue rules (design section 10, "Rows and policy" and "Queueing"). */
import type { CaptureMethod, ReviewStatus, Source } from '../contract/enums.ts';
import type { Config } from '../config.ts';
import { isReviewPermitted } from '../domain/review-policy.ts';
import type { Tx } from '../storage/db.ts';
import type { ChatRow } from '../storage/rows.ts';

/** Automatic retry stops after this many attempts; an officer's dispatch or resume still requeues. */
export const MAX_AUTOMATIC_REVIEW_ATTEMPTS = 3;

export function initialReviewStatus(
  chat: Pick<ChatRow, 'ai_mode'>,
  source: Source,
  captureMethod: CaptureMethod,
  config: Pick<Config, 'reviewAllowedCaptureMethods'>,
): ReviewStatus {
  if (!isReviewPermitted(source, captureMethod, config.reviewAllowedCaptureMethods)) return 'not_permitted';
  return chat.ai_mode === 'ai_active' ? 'pending' : 'not_requested';
}

/** On every entry into ai_active: not_requested, stale_discarded and unavailable reviews go back to pending. */
export function requeueReviewsForChat(tx: Tx, chatId: string): number {
  return tx.run(
    `UPDATE reviews SET status = 'pending', attempts = 0, last_error_code = NULL, updated_at = :at
     WHERE chat_id = :chatId AND status IN ('not_requested', 'stale_discarded', 'unavailable')`,
    { chatId, at: tx.now() },
  ).changes;
}

/**
 * Automatic retry of unavailable reviews with fewer than three attempts, for one ai_active chat (intake) or for
 * every ai_active chat (startup). At startup, reviews left running by a stopped process also return to pending.
 */
export function requeueRetryableReviews(tx: Tx, chatId?: string): number {
  const at = tx.now();
  const chatFilter = chatId === undefined ? '' : 'AND id = :chatId';
  const params = chatId === undefined ? { at, max: MAX_AUTOMATIC_REVIEW_ATTEMPTS } : { at, max: MAX_AUTOMATIC_REVIEW_ATTEMPTS, chatId };
  const retried = tx.run(
    `UPDATE reviews SET status = 'pending', updated_at = :at
     WHERE status = 'unavailable' AND attempts < :max
       AND chat_id IN (SELECT id FROM chats WHERE ai_mode = 'ai_active' ${chatFilter})`,
    params,
  ).changes;
  if (chatId !== undefined) return retried;
  const resumed = tx.run("UPDATE reviews SET status = 'pending', updated_at = :at WHERE status = 'running'", { at }).changes;
  return retried + resumed;
}
