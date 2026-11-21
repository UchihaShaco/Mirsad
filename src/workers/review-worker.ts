// Stub until Task 6: a worker that never claims work. The signature is final.
import type { Config } from '../config.ts';
import type { Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';
import type { Reviewer } from '../ports/reviewer.ts';
import type { Db } from '../storage/db.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

export interface ReviewWorkerDeps {
  db: Db;
  reviewer: Reviewer;
  config: Config;
  logger: Logger;
  clock: Clock;
}

export function createReviewWorker(deps: ReviewWorkerDeps): JobLoop {
  return createJobLoop<never>({
    name: 'review',
    concurrency: deps.config.reviewConcurrency,
    claim: () => null,
    work: async () => {},
  });
}
