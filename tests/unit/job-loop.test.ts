import { describe, expect, it } from 'vitest';
import { createJobLoop } from '../../src/workers/job-loop.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('job loop', () => {
  it('claims work up to the concurrency limit and becomes idle when nothing is left', async () => {
    const queue = [1, 2, 3, 4, 5];
    const gates = new Map<number, ReturnType<typeof deferred>>();
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    const loop = createJobLoop<number>({
      name: 'test',
      concurrency: 2,
      claim: () => queue.shift() ?? null,
      work: async (job) => {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred();
        gates.set(job, gate);
        await gate.promise;
        active -= 1;
        done.push(job);
      },
    });

    expect(loop.isIdle()).toBe(true);
    loop.wake();
    expect(loop.isIdle()).toBe(false);
    const idle = loop.idle();
    await expect.poll(() => gates.size).toBe(2);
    for (let job = 1; job <= 5; job += 1) {
      await expect.poll(() => gates.has(job)).toBe(true);
      gates.get(job)!.resolve();
    }
    await idle;
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(loop.isIdle()).toBe(true);
    await loop.stop();
  });

  it('reports work and claim errors and keeps running', async () => {
    const errors: string[] = [];
    const queue = ['fail', 'ok'];
    const done: string[] = [];
    const loop = createJobLoop<string>({
      name: 'test',
      concurrency: 1,
      claim: () => queue.shift() ?? null,
      work: async (job) => {
        if (job === 'fail') throw new Error('work_failed');
        done.push(job);
      },
      onError: (error) => errors.push(error instanceof Error ? error.message : 'unknown'),
    });
    loop.wake();
    await loop.idle();
    expect(errors).toEqual(['work_failed']);
    expect(done).toEqual(['ok']);
  });

  it('stop waits for active work and claims nothing afterwards', async () => {
    let claims = 0;
    const gate = deferred();
    const loop = createJobLoop<number>({
      name: 'test',
      concurrency: 1,
      claim: () => (claims < 1 ? ++claims : null),
      work: () => gate.promise,
    });
    loop.wake();
    await expect.poll(() => claims).toBe(1);
    const stopped = loop.stop();
    gate.resolve();
    await stopped;
    loop.wake();
    await loop.idle();
    expect(claims).toBe(1);
  });

  it('a job whose work throws synchronously does not hang idle()', async () => {
    const errors: string[] = [];
    const queue = ['sync-throw', 'ok'];
    const done: string[] = [];
    const loop = createJobLoop<string>({
      name: 'test',
      concurrency: 1,
      claim: () => queue.shift() ?? null,
      work: (job) => {
        if (job === 'sync-throw') throw new Error('thrown_synchronously');
        done.push(job);
        return Promise.resolve();
      },
      onError: (error, phase) => errors.push(`${phase}:${error instanceof Error ? error.message : 'unknown'}`),
    });
    loop.wake();
    await loop.idle();
    expect(errors).toEqual(['work:thrown_synchronously']);
    expect(done).toEqual(['ok']);
    expect(loop.isIdle()).toBe(true);
  });
});
