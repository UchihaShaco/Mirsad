/**
 * Contact-sync worker: created only when MIRSAD_CONTACT_SYNC_URL is set. It claims one number at a time whose state on
 * the contact-sync server differs from the portal's (services/contact-sync.ts), sends it outside any transaction, and
 * records the outcome. A failed request is retried on the clock, at most CONTACT_SYNC_MAX_ATTEMPTS times per change.
 */
import type { AppDeps } from '../app.ts';
import { systemClock } from '../ports/clock.ts';
import type { ContactSyncPublisher } from '../ports/contact-sync.ts';
import { claimNextSync, reconcileContactSync, recordSyncOutcome, retryWaitMs, type ContactSyncJob } from '../services/contact-sync.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

const CONTACT_SYNC_CONCURRENCY = 1;

export interface ContactSyncWorker extends JobLoop {
  /** Requeues the flagged set once (logged as counts only) and starts sending. */
  start(): void;
}

export function createContactSyncWorker(deps: AppDeps, publisher: ContactSyncPublisher): ContactSyncWorker {
  const { db, clock, logger } = deps;
  let cancelRetry: (() => void) | null = null;

  const loop = createJobLoop<ContactSyncJob>({
    name: 'contact-sync',
    concurrency: CONTACT_SYNC_CONCURRENCY,
    claim: () => db.transaction(claimNextSync),
    work: async (job) => {
      const outcome = job.active ? await publisher.publish(job.e164, job.reference) : await publisher.withdraw(job.e164);
      db.transaction((tx) => recordSyncOutcome(tx, job, outcome));
      if (outcome.ok) logger.info('contact_sync_delivered', { active: job.active, reference: job.reference });
      else logger.warn('contact_sync_failed', { active: job.active, reference: job.reference, code: outcome.code, retry: outcome.retry });
      scheduleRetry();
    },
    onError: (error, phase) => logger.error('contact_sync_worker_error', { phase, errorClass: error instanceof Error ? error.name : 'unknown' }),
  });

  /** One timer for the earliest waiting retry. */
  function scheduleRetry(): void {
    cancelRetry?.();
    const wait = db.transaction(retryWaitMs);
    if (wait === null) {
      cancelRetry = null;
      return;
    }
    const wake = () => loop.wake();
    cancelRetry = clock.after ? clock.after(wait, wake) : systemClock.after(wait, wake);
  }

  return {
    ...loop,
    start() {
      const counts = db.transaction(reconcileContactSync);
      logger.info('contact_sync_reconciled', { ...counts });
      loop.wake();
    },
    async stop() {
      cancelRetry?.();
      await loop.stop();
    },
  };
}
