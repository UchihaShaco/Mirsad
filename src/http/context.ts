/** Shared HTTP types: the Hono environment, the dependencies handed to route handlers, the handler type. */
import type { Context } from 'hono';
import type { Config } from '../config.ts';
import { AppError } from '../contract/errors.ts';
import type { CaptureRenderer } from '../ports/capture-renderer.ts';
import type { Clock } from '../ports/clock.ts';
import type { EvidenceStore } from '../ports/evidence-store.ts';
import type { IdentityProvider, Principal } from '../ports/identity.ts';
import type { Logger } from '../ports/logger.ts';
import type { Reviewer } from '../ports/reviewer.ts';
import type { StreamBus } from '../services/stream.ts';
import type { Db } from '../storage/db.ts';
import type { JobLoop } from '../workers/job-loop.ts';

export interface AppEnv {
  Variables: { principal: Principal | null };
}

export interface RouteDeps {
  config: Config;
  db: Db;
  clock: Clock;
  logger: Logger;
  bus: StreamBus;
  identity: IdentityProvider;
  evidenceStore: EvidenceStore;
  renderer: CaptureRenderer;
  reviewer: Reviewer;
  workers: { capture: JobLoop; review: JobLoop };
  streamKeepAliveMs: number;
  startedAt: string;
  /** True once close() has begun; long-lived handlers (the event stream) stop when it is. */
  isShuttingDown(): boolean;
}

export type HttpMethod = 'GET' | 'POST';
export type RouteKey = `${HttpMethod} ${string}`;
export type RouteHandler = (c: Context<AppEnv>, deps: RouteDeps) => Response | Promise<Response>;
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
