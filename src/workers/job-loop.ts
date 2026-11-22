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

/** What one loop tracks between wake-ups. */
interface LoopState<Job> {
  readonly options: JobLoopOptions<Job>;
  active: number;
  scheduled: boolean;
  stopped: boolean;
  idleWaiters: (() => void)[];
}

function isIdle<Job>(state: LoopState<Job>): boolean {
  return state.active === 0 && !state.scheduled;
}

/** Resolves every idle() and stop() waiter once nothing runs and nothing is scheduled. */
function settle<Job>(state: LoopState<Job>): void {
  if (!isIdle(state)) return;
  const waiting = state.idleWaiters;
  state.idleWaiters = [];
  for (const resolve of waiting) resolve();
}

function whenIdle<Job>(state: LoopState<Job>): Promise<void> {
  if (isIdle(state)) return Promise.resolve();
  return new Promise<void>((resolve) => state.idleWaiters.push(resolve));
}

function claimNext<Job>(state: LoopState<Job>): Job | null {
  try {
    return state.options.claim();
  } catch (error) {
    state.options.onError?.(error, 'claim');
    return null;
  }
}

/** Runs one job; when it ends, however it ends, the loop claims again. */
function run<Job>(state: LoopState<Job>, job: Job): void {
  state.active += 1;
  // Promise.resolve().then turns a synchronous throw in work() into a rejection, so `active` always settles.
  Promise.resolve()
    .then(() => state.options.work(job))
    .catch((error: unknown) => state.options.onError?.(error, 'work'))
    .finally(() => {
      state.active -= 1;
      pump(state);
    });
}

/** Claims and starts jobs up to the concurrency limit, then settles the idle waiters. */
function pump<Job>(state: LoopState<Job>): void {
  state.scheduled = false;
  while (!state.stopped && state.active < state.options.concurrency) {
    const job = claimNext(state);
    if (job === null) break;
    run(state, job);
  }
  settle(state);
}

export function createJobLoop<Job>(options: JobLoopOptions<Job>): JobLoop {
  const state: LoopState<Job> = { options, active: 0, scheduled: false, stopped: false, idleWaiters: [] };
  return {
    wake() {
      if (state.stopped || state.scheduled) return;
      state.scheduled = true;
      setImmediate(() => pump(state));
    },
    idle: () => whenIdle(state),
    isIdle: () => isIdle(state),
    async stop() {
      state.stopped = true;
      await whenIdle(state);
    },
  };
}
