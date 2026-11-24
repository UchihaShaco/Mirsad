import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from '../../contract/errors.ts';
import type { AppEnv } from '../context.ts';

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];
const DEFAULT_HTTP_PORT = 80;

/** For browser requests, compare Origin against the listener Host already checked by hostGuard. */
export function requireSameOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header('origin');
  if (origin !== undefined && origin !== new URL(`http://${c.req.header('host')}`).origin) {
    throw AppError.of('origin_not_allowed', 'Browser requests must use the dashboard origin.');
  }
}

/** Refuses requests whose Host header is not a loopback name with the bound port (DNS rebinding guard). */
export function hostGuard(boundPort: () => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    const port = boundPort();
    const allowed = LOOPBACK_NAMES.some(
      (name) => host === `${name}:${port}` || (port === DEFAULT_HTTP_PORT && host === name),
    );
    if (!allowed) throw AppError.of('host_not_allowed', 'Requests must address the service on a loopback host.');
    await next();
  };
}
