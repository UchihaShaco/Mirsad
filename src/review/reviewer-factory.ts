// Stub until Tasks 6 and 8: every reviewer is unavailable. The signature is final.
import type { Config } from '../config.ts';
import type { Logger } from '../ports/logger.ts';
import { ReviewerUnavailableError, type Reviewer } from '../ports/reviewer.ts';

export function createReviewer(config: Config, _logger: Logger): Reviewer {
  return {
    name: config.reviewer,
    async review() {
      throw new ReviewerUnavailableError('reviewer_not_installed');
    },
  };
}
