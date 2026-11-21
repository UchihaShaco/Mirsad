/**
 * Every route of design section 6 with its access rule. The table drives handler registration and the
 * OpenAPI coverage test; each route group file supplies the handlers for its keys.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import type { AppDeps } from '../../app.ts';
import type { AppEnv, HttpMethod, RouteHandler, RouteKey, RouteModule } from '../context.ts';
import { requireAnyPrincipal, requireConnector, requireOfficer } from '../middleware/auth.ts';
import { routes as artifacts } from './artifacts.ts';
import { routes as captures } from './captures.ts';
import { routes as caseReferences } from './case-references.ts';
import { routes as chatEvents } from './chat-events.ts';
import { routes as chats } from './chats.ts';
import { routes as control } from './control.ts';
import { routes as dashboardStatic } from './dashboard-static.ts';
import { routes as dispatches } from './dispatches.ts';
import { routes as eventsStream } from './events-stream.ts';
import { routes as health } from './health.ts';
import { routes as ingest } from './ingest.ts';
import { routes as me } from './me.ts';
import { routes as officer } from './officer.ts';
import { routes as status } from './status.ts';
import { routes as timeline } from './timeline.ts';
import { routes as watchlist } from './watchlist.ts';

export type RouteAuth = 'officer' | 'connector' | 'any' | 'none';

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  auth: RouteAuth;
  extension: boolean;
}

const route = (method: HttpMethod, path: string, auth: RouteAuth, extension = false): RouteSpec => ({
  method,
  path,
  auth,
  extension,
});

export const ROUTES: readonly RouteSpec[] = [
  route('POST', '/v1/chats', 'officer'),
  route('GET', '/v1/chats', 'officer'),
  route('POST', '/v1/ingest', 'connector'),
  route('POST', '/v1/chats/{chatId}/events', 'connector'),
  route('POST', '/v1/dispatches', 'officer'),
  route('POST', '/v1/chats/{chatId}/control', 'officer'),
  route('POST', '/v1/chats/{chatId}/officer-messages', 'officer'),
  route('POST', '/v1/chats/{chatId}/officer-decisions', 'officer'),
  route('GET', '/v1/chats/{chatId}/timeline', 'officer'),
  route('GET', '/v1/artifacts/{artifactId}', 'officer'),
  route('GET', '/v1/events', 'officer'),
  route('GET', '/v1/watchlist', 'officer'),
  route('POST', '/v1/watchlist/{entryId}/review', 'officer'),
  route('POST', '/v1/chats/{chatId}/case-references', 'officer', true),
  route('POST', '/v1/captures/{captureId}/retry', 'officer', true),
  route('GET', '/v1/me', 'any', true),
  route('GET', '/v1/status', 'officer', true),
  route('GET', '/healthz', 'none', true),
  route('GET', '/', 'none'),
  route('GET', '/assets/*', 'none'),
];

const MODULES: RouteModule[] = [
  chats, ingest, chatEvents, dispatches, timeline, artifacts, captures, control,
  officer, eventsStream, watchlist, caseReferences, status, health, me, dashboardStatic,
];

const GUARDS: Record<RouteAuth, MiddlewareHandler<AppEnv> | null> = {
  officer: requireOfficer,
  connector: requireConnector,
  any: requireAnyPrincipal,
  none: null,
};

/** `/v1/chats/{chatId}` -> `/v1/chats/:chatId` */
export function toHonoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

export const routeKey = (spec: RouteSpec): RouteKey => `${spec.method} ${spec.path}`;

function collectHandlers(): Map<RouteKey, RouteHandler> {
  const handlers = new Map<RouteKey, RouteHandler>();
  for (const module of MODULES) {
    for (const [key, handler] of Object.entries(module) as [RouteKey, RouteHandler | undefined][]) {
      if (!handler) continue;
      if (handlers.has(key)) throw new Error(`duplicate_route_handler: ${key}`);
      handlers.set(key, handler);
    }
  }
  return handlers;
}

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const handlers = collectHandlers();
  for (const spec of ROUTES) {
    const key = routeKey(spec);
    const handler = handlers.get(key);
    if (!handler) throw new Error(`missing_route_handler: ${key}`);
    handlers.delete(key);
    const guard = GUARDS[spec.auth];
    const run = (c: Parameters<RouteHandler>[0]) => handler(c, deps);
    const path = toHonoPath(spec.path);
    if (guard) app.on(spec.method, path, guard, run);
    else app.on(spec.method, path, run);
  }
  const extra = [...handlers.keys()];
  if (extra.length > 0) throw new Error(`handler_without_route: ${extra.join(', ')}`);
}
