import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../../contract/errors.ts';
import type { Clock } from '../../ports/clock.ts';
import type { AppEnv } from '../context.ts';

const WINDOW_MS = 60_000;
const ANONYMOUS_KEY = 'anonymous';

/**
 * In-memory fixed-window limit per token (design section 5). Keys are token hashes, never tokens;
 * requests without a token share one bucket. Time comes from the injected clock.
 */
export function rateLimit(options: { limitPerMinute: number; clock: Clock }): MiddlewareHandler<AppEnv> {
  let window = -1;
  let counts = new Map<string, number>();

  return async (c, next) => {
    const currentWindow = Math.floor(options.clock.now().getTime() / WINDOW_MS);
    if (currentWindow !== window) {
      window = currentWindow;
      counts = new Map();
    }
    const header = c.req.header('authorization');
    const key = header ? createHash('sha256').update(header, 'utf8').digest('hex') : ANONYMOUS_KEY;
    const used = (counts.get(key) ?? 0) + 1;
    counts.set(key, used);
    if (used > options.limitPerMinute) {
      throw AppError.of('rate_limited', 'Too many requests; try again in a minute.');
    }
    await next();
  };
}
