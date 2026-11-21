// Stub until Task 3: a worker that never claims work. The signature is final.
import type { AppDeps } from '../app.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

export function createCaptureWorker(_deps: AppDeps): JobLoop {
  return createJobLoop<never>({ name: 'capture', concurrency: 1, claim: () => null, work: async () => {} });
}
