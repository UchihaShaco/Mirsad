import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context.ts';

const DEFAULT_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/** Adds baseline security headers; a route that sets one of them (e.g. Cache-Control) keeps its own value. */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}
