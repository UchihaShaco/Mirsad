/** Builds the configured reviewer (design section 10, "Reviewer port"; MIRSAD_REVIEWER). */
import type { Config } from '../config.ts';
import type { Logger } from '../ports/logger.ts';
import { ReviewerUnavailableError, type Reviewer } from '../ports/reviewer.ts';
import { createDeterministicReviewer } from './deterministic-reviewer.ts';

/** Review switched off: every review is unavailable, while intake, captures and officer controls keep working. */
function createDisabledReviewer(): Reviewer {
  return {
    name: 'disabled',
    async review() {
      throw new ReviewerUnavailableError('reviewer_disabled');
    },
    async health() {
      return { reachable: false, modelId: null };
    },
  };
}

/** Stands in for the LM Studio reviewer until its module lands (Task 8 replaces this branch). */
function createNotInstalledReviewer(name: string): Reviewer {
  return {
    name,
    async review() {
      throw new ReviewerUnavailableError('reviewer_not_installed');
    },
  };
}

export function createReviewer(config: Config, _logger: Logger): Reviewer {
  switch (config.reviewer) {
    case 'deterministic':
      return createDeterministicReviewer();
    case 'disabled':
      return createDisabledReviewer();
    case 'lmstudio':
      return createNotInstalledReviewer('lmstudio');
  }
}
