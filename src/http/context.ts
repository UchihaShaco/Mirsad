/** Shared HTTP types: the Hono environment and the route handler type (handlers receive AppDeps). */
import type { Context } from 'hono';
import type { AppDeps } from '../app.ts';
import { AppError } from '../contract/errors.ts';
import type { Principal } from '../ports/identity.ts';

export interface AppEnv {
  Variables: { principal: Principal | null };
}

export type HttpMethod = 'GET' | 'POST';
export type RouteKey = `${HttpMethod} ${string}`;
export type RouteHandler = (c: Context<AppEnv>, deps: AppDeps) => Response | Promise<Response>;
export type RouteModule = Partial<Record<RouteKey, RouteHandler>>;

/** Placeholder handler for routes whose owning task has not landed yet. */
export const notImplemented: RouteHandler = () => {
  throw AppError.of('not_implemented', 'This route is not implemented yet.');
};

/** The authenticated principal; only valid behind requireOfficer, requireConnector or requireAnyPrincipal. */
export function principalOf(c: Context<AppEnv>): Principal {
  const principal = c.get('principal');
  if (!principal) throw AppError.of('unauthenticated', 'A valid bearer token is required.');
  return principal;
}
