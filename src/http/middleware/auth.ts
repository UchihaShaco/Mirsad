import type { MiddlewareHandler } from 'hono';
import { AppError } from '../../contract/errors.ts';
import type { PrincipalKind } from '../../contract/enums.ts';
import type { IdentityProvider } from '../../ports/identity.ts';
import type { AppEnv } from '../context.ts';

/** Resolves the bearer token (if any) to a principal; route guards decide what is required. */
export function authenticate(identity: IdentityProvider): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('principal', identity.authenticate(c.req.header('authorization')));
    await next();
  };
}

function requireKinds(kinds: readonly PrincipalKind[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw AppError.of('unauthenticated', 'A valid bearer token is required.');
    if (!kinds.includes(principal.kind)) {
      throw AppError.of('forbidden_for_principal', 'This credential cannot use this route.');
    }
    await next();
  };
}

export const requireOfficer = requireKinds(['officer']);
export const requireConnector = requireKinds(['connector']);
export const requireAnyPrincipal = requireKinds(['officer', 'connector']);
