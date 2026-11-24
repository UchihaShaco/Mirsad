/** Builds the configured reviewer (design section 10, "Reviewer port"; MIRSAD_REVIEWER). */
import type { Config } from '../config.ts';
import type { Logger } from '../ports/logger.ts';
import { ReviewerUnavailableError, type Reviewer } from '../ports/reviewer.ts';
import { createDeterministicReviewer } from './deterministic-reviewer.ts';
import { createLmStudioReviewer } from './lmstudio-reviewer.ts';

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

export function createReviewer(config: Config, _logger: Logger): Reviewer {
  switch (config.reviewer) {
    case 'deterministic':
      return createDeterministicReviewer();
    case 'disabled':
      return createDisabledReviewer();
    case 'lmstudio': {
      const { baseUrl, model, timeoutMs, contextTokens, arabicReply } = config.lmStudio;
      return createLmStudioReviewer({ baseUrl, model, timeoutMs, contextTokens, requireModelMatch: Boolean(arabicReply) });
    }
  }
}
