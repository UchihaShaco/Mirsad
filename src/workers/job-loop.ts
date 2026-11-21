/**
 * A small in-process work loop: claim() takes the next job (synchronously, in its own transaction),
 * work() runs it outside any transaction. wake() schedules claiming; idle() resolves when nothing runs
 * and nothing is left to claim.
 */

export interface JobLoopOptions<Job> {
  name: string;
  claim: () => Job | null;
  work: (job: Job) => Promise<void>;
  concurrency: number;
  onError?: (error: unknown, phase: 'claim' | 'work') => void;
}

export interface JobLoop {
  wake(): void;
  idle(): Promise<void>;
  isIdle(): boolean;
  stop(): Promise<void>;
}

export function createJobLoop<Job>(options: JobLoopOptions<Job>): JobLoop {
  let active = 0;
  let scheduled = false;
  let stopped = false;
  let idleWaiters: (() => void)[] = [];

  const isIdle = () => active === 0 && !scheduled;

  const settle = () => {
    if (!isIdle()) return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
  };

  const report = (error: unknown, phase: 'claim' | 'work') => options.onError?.(error, phase);

  const claimNext = (): Job | null => {
    try {
      return options.claim();
    } catch (error) {
      report(error, 'claim');
      return null;
    }
  };

  const run = (job: Job) => {
    active += 1;
    options
      .work(job)
      .catch((error: unknown) => report(error, 'work'))
      .finally(() => {
        active -= 1;
        pump();
      });
  };

  function pump() {
    scheduled = false;
    while (!stopped && active < options.concurrency) {
      const job = claimNext();
      if (job === null) break;
      run(job);
    }
    settle();
  }

  return {
    wake() {
      if (stopped || scheduled) return;
      scheduled = true;
      setImmediate(pump);
    },
    idle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    isIdle,
    async stop() {
      stopped = true;
      if (isIdle()) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
