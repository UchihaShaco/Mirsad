/**
 * Review worker (design section 10, "Worker"). A claim transaction takes the oldest pending review of a chat that has
 * none running; the reviewer is called outside any transaction with a signal that fires on the configured timeout and
 * on shutdown; a second transaction publishes. One review at a time per chat, up to MIRSAD_REVIEW_CONCURRENCY chats.
 */
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { CONCERNS, EXTRACTED_KINDS } from '../contract/enums.ts';
import { isReviewPermitted } from '../domain/review-policy.ts';
import { ReviewerUnavailableError, type ExtractedItem, type ReviewRequest } from '../ports/reviewer.ts';
import { publishReview, type PublishOutcome } from '../review/publish.ts';
import { requeueRetryableReviews } from '../services/review-queue.ts';
import type { Tx } from '../storage/db.ts';
import {
  endReviewAttempt,
  findNextPendingReview,
  markReviewRunning,
  publishReviewUpdated,
  setPendingReviewAside,
  type ReviewCandidate,
} from '../storage/repos/reviews.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

/** The reviewer's answer is untrusted input: it must match the item shape before anything reads it. */
const ReviewAnswer = z.object({
  items: z.array(
    z.object({
      sourceMessageId: z.string(),
      kind: z.enum(EXTRACTED_KINDS),
      quote: z.string(),
      extractedValue: z.string(),
      concern: z.enum(CONCERNS).nullable(),
      countryHint: z.string().nullable(),
    }),
  ),
});
/** Error codes are stored and logged, so only code-shaped values are kept. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

interface ReviewJob {
  reviewId: string;
  workspaceId: string;
  request: ReviewRequest;
}

type Answer = { kind: 'items'; items: ExtractedItem[] } | { kind: 'failed'; code: string } | { kind: 'interrupted' };

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

function failureCode(error: unknown): string {
  return error instanceof ReviewerUnavailableError && ERROR_CODE.test(error.code) ? error.code : 'reviewer_failed';
}

function toRequest(candidate: ReviewCandidate, text: string): ReviewRequest {
  return {
    reviewId: candidate.review_id,
    chatId: candidate.chat_id,
    messageId: candidate.message_id,
    messageEventId: candidate.message_event_id,
    source: candidate.source,
    text,
  };
}

/** Policy is checked again at claim time; a chat that is no longer ai_active keeps its review for a later resume. */
function claimCandidate(tx: Tx, deps: AppDeps, candidate: ReviewCandidate): ReviewJob | null {
  const setAside = (status: 'not_permitted' | 'not_requested', code: string | null = null): null => {
    const row = setPendingReviewAside(tx, candidate.review_id, status, code);
    if (row) publishReviewUpdated(tx, candidate.workspace_id, row);
    return null;
  };
  const permitted = isReviewPermitted(candidate.source, candidate.event_capture_method, deps.config.reviewAllowedCaptureMethods);
  if (!permitted) return setAside('not_permitted');
  const text = candidate.event_text;
  // Intake creates reviews only for events with text; a row without it can never be reviewed.
  if (text === null || text === '') return setAside('not_permitted', 'review_text_missing');
  if (candidate.ai_mode !== 'ai_active') return setAside('not_requested');
  const row = markReviewRunning(tx, candidate.review_id, candidate.revision, deps.reviewer.name);
  if (!row) throw new Error('review_claim_failed');
  publishReviewUpdated(tx, candidate.workspace_id, row);
  return { reviewId: candidate.review_id, workspaceId: candidate.workspace_id, request: toRequest(candidate, text) };
}

/** Every pending review the worker sets aside stops being pending, so the loop ends. */
function claimNextReview(tx: Tx, deps: AppDeps): ReviewJob | null {
  for (let candidate = findNextPendingReview(tx); candidate; candidate = findNextPendingReview(tx)) {
    const job = claimCandidate(tx, deps, candidate);
    if (job) return job;
  }
  return null;
}

/** Settles with the promise, or rejects as soon as the signal aborts, whether or not the reviewer honours it. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function askReviewer(deps: AppDeps, job: ReviewJob, shutdown: AbortSignal): Promise<Answer> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deps.config.lmStudio.timeoutMs);
  const signal = AbortSignal.any([shutdown, timeout.signal]);
  try {
    const answer = ReviewAnswer.safeParse(await untilAborted(deps.reviewer.review(job.request, signal), signal));
    return answer.success ? { kind: 'items', items: answer.data.items } : { kind: 'failed', code: 'reviewer_invalid_output' };
  } catch (error) {
    if (shutdown.aborted) return { kind: 'interrupted' };
    return { kind: 'failed', code: timeout.signal.aborted ? 'reviewer_timeout' : failureCode(error) };
  } finally {
    clearTimeout(timer);
  }
}

function recordUnavailable(deps: AppDeps, job: ReviewJob, code: string): void {
  deps.db.transaction((tx) => {
    const row = endReviewAttempt(tx, job.reviewId, 'unavailable', code);
    if (row) publishReviewUpdated(tx, job.workspaceId, row);
  });
  deps.logger.warn('review_unavailable', { reviewId: job.reviewId, code });
}

function logPublished(deps: AppDeps, job: ReviewJob, outcome: PublishOutcome): void {
  if (outcome.status !== 'completed') {
    deps.logger.info('review_not_published', { reviewId: job.reviewId, status: outcome.status });
    return;
  }
  const { outcome: result, findingIds, unsupported, suppressed } = outcome;
  deps.logger.info('review_published', { reviewId: job.reviewId, outcome: result, findings: findingIds.length, unsupported, suppressed });
}

function publishAnswer(deps: AppDeps, job: ReviewJob, items: readonly ExtractedItem[]): void {
  let outcome: PublishOutcome;
  try {
    outcome = deps.db.transaction((tx) => publishReview(tx, job.reviewId, items));
  } catch (error) {
    deps.logger.error('review_publish_failed', { reviewId: job.reviewId, errorClass: errorClassOf(error) });
    recordUnavailable(deps, job, 'review_publish_failed');
    return;
  }
  logPublished(deps, job, outcome);
  if (outcome.status === 'requeued') deps.workers.review.wake();
}

/** A review interrupted by shutdown stays running; the next start queues it again (requeueRetryableReviews). */
async function runReview(deps: AppDeps, job: ReviewJob, shutdown: AbortSignal): Promise<void> {
  const answer = await askReviewer(deps, job, shutdown);
  if (answer.kind === 'interrupted') {
    deps.logger.info('review_interrupted', { reviewId: job.reviewId });
    return;
  }
  if (answer.kind === 'failed') {
    recordUnavailable(deps, job, answer.code);
    return;
  }
  publishAnswer(deps, job, answer.items);
}

/**
 * Created once per start, before the first wake. Reviews a stopped process left running go back to pending, and
 * unavailable reviews of ai_active chats with attempts to spare are retried.
 */
export function createReviewWorker(deps: AppDeps): JobLoop {
  const requeued = deps.db.transaction((tx) => requeueRetryableReviews(tx));
  if (requeued > 0) deps.logger.info('reviews_requeued', { count: requeued });
  const shutdown = new AbortController();
  const loop = createJobLoop<ReviewJob>({
    name: 'review',
    concurrency: deps.config.reviewConcurrency,
    claim: () => (shutdown.signal.aborted ? null : deps.db.transaction((tx) => claimNextReview(tx, deps))),
    work: (job) => runReview(deps, job, shutdown.signal),
    onError: (error, phase) => deps.logger.error('review_worker_error', { phase, errorClass: errorClassOf(error) }),
  });
  return {
    ...loop,
    async stop() {
      shutdown.abort();
      await loop.stop();
    },
  };
}
