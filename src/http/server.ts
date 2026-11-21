/**
 * The HTTP application. Middleware order (design section 5): security headers, host guard, rate limit,
 * body limit, auth, route, error handler. No CORS headers are ever sent.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { AppEnv } from './context.ts';
import { authenticate } from './middleware/auth.ts';
import { requestBodyLimit } from './middleware/body-limit.ts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts';
import { hostGuard } from './middleware/host-guard.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { securityHeaders } from './middleware/security-headers.ts';
import { registerRoutes } from './routes/index.ts';

export function createHttpApp(deps: AppDeps, boundPort: () => number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders());
  app.use('*', hostGuard(boundPort));
  app.use('*', rateLimit({ limitPerMinute: deps.config.rateLimitPerMinute, clock: deps.clock }));
  app.use('*', requestBodyLimit());
  app.use('*', authenticate(deps.identity));
  registerRoutes(app, deps);
  app.onError(errorHandler(deps.logger));
  app.notFound(notFoundHandler);
  return app;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

function urlHost(host: string): string {
  return host === '::1' ? '[::1]' : host;
}

/** Binds to the configured loopback host. close() also ends open connections such as event streams. */
export function startServer(app: Hono<AppEnv>, host: string, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info: AddressInfo) => {
      server.off('error', reject);
      resolve({
        port: info.port,
        url: `http://${urlHost(host)}:${info.port}`,
        close: () =>
          new Promise<void>((done, failed) => {
            server.close((error) => (error ? failed(error) : done()));
            server.closeAllConnections();
          }),
      });
    }) as Server;
    server.once('error', reject);
  });
}
