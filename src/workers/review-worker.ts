// Stub until Task 6: a worker that never claims work. The signature is final.
import type { AppDeps } from '../app.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

export function createReviewWorker(deps: AppDeps): JobLoop {
  return createJobLoop<never>({
    name: 'review',
    concurrency: deps.config.reviewConcurrency,
    claim: () => null,
    work: async () => {},
  });
}
