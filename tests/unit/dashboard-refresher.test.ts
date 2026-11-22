/**
 * The dashboard's reload pacing (src/dashboard/js/refresher.js). Stream events only ask for reloads; the refresher folds
 * them so a busy stream cannot spend the officer's request budget (design section 5: 600 requests a minute per token).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createRefresher, REFRESH_DELAY_MS } from '../../src/dashboard/js/refresher.js';

const ONE_MINUTE_MS = 60_000;
/** A busy stream: one event every 10 ms, each asking for a reload. */
const EVENT_INTERVAL_MS = 10;
/** The inbox, timeline and watchlist each have a refresher, and all three can run at once. */
const REFRESHERS = 3;
/** Stream-triggered reloads may use at most half the limit; the rest is for officer actions and capture images. */
const RELOAD_SHARE = 0.5;

afterEach(() => {
  vi.useRealTimers();
});

describe('stream-triggered reloads', () => {
  it('a sustained event stream reloads each resource at most once per refresh delay, so the three refreshers stay well under the rate limit', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let loads = 0;
    // An instant load is the worst case: the next run can start as soon as the delay allows.
    const refresher = createRefresher(async () => {
      loads += 1;
    }, REFRESH_DELAY_MS, (error) => errors.push(error));

    const stream = setInterval(() => refresher.request(), EVENT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
    clearInterval(stream);
    refresher.cancel();

    const limitPerMinute = loadConfig({}).rateLimitPerMinute;
    expect(errors).toEqual([]);
    expect(loads).toBeGreaterThan(0);
    expect(loads * REFRESHERS).toBeLessThanOrEqual(limitPerMinute * RELOAD_SHARE);
  });
});
