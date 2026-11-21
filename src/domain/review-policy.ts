/**
 * Which message events may be sent to a reviewer (design section 10, "Rows and policy"). Always called with the
 * reviewed event's own capture method, when the review row is created and again when the worker claims it.
 */
import type { CaptureMethod, Source } from '../contract/enums.ts';

export function isReviewPermitted(source: Source, captureMethod: CaptureMethod, allowed: readonly CaptureMethod[]): boolean {
  if (captureMethod === 'telegram_business_live') return false;
  if (source === 'telegram') return captureMethod === 'fixture_replay';
  return allowed.includes(captureMethod);
}
