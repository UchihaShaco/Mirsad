// Stub until Task 3: a worker that never claims work. The signature is final.
import type { CaptureRenderer } from '../ports/capture-renderer.ts';
import type { Clock } from '../ports/clock.ts';
import type { EvidenceStore } from '../ports/evidence-store.ts';
import type { Logger } from '../ports/logger.ts';
import type { Db } from '../storage/db.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

export interface CaptureWorkerDeps {
  db: Db;
  renderer: CaptureRenderer;
  evidenceStore: EvidenceStore;
  logger: Logger;
  clock: Clock;
}

export function createCaptureWorker(_deps: CaptureWorkerDeps): JobLoop {
  return createJobLoop<never>({ name: 'capture', concurrency: 1, claim: () => null, work: async () => {} });
}
