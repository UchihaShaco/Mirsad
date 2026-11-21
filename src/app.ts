/** Composition root: wires storage, ports, workers and HTTP into one App. */
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRenderer } from './capture/index.ts';
import type { Config } from './config.ts';
import type { RouteDeps } from './http/context.ts';
import { createHttpApp, startServer, type RunningServer } from './http/server.ts';
import { createDemoIdentity } from './identity/demo-identity.ts';
import { seedDemo } from './identity/seed.ts';
import { createJsonLogger } from './logging/json-logger.ts';
import type { CaptureRenderer } from './ports/capture-renderer.ts';
import { systemClock, type Clock } from './ports/clock.ts';
import type { EvidenceStore } from './ports/evidence-store.ts';
import type { IdentityProvider } from './ports/identity.ts';
import type { Logger } from './ports/logger.ts';
import type { Reviewer } from './ports/reviewer.ts';
import { createReviewer } from './review/reviewer-factory.ts';
import { createStreamBus } from './services/stream.ts';
import { DATABASE_FILE, openDatabase } from './storage/db.ts';
import { createLocalEvidenceStore } from './storage/local-evidence-store.ts';
import { createCaptureWorker } from './workers/capture-worker.ts';
import { createReviewWorker } from './workers/review-worker.ts';

export const EVIDENCE_DIRECTORY = 'evidence';
const DEFAULT_STREAM_KEEP_ALIVE_MS = 15_000;

export interface AppOptions {
  config: Config;
  clock?: Clock;
  renderer?: CaptureRenderer;
  reviewer?: Reviewer;
  evidenceStore?: EvidenceStore;
  logger?: Logger;
  identity?: IdentityProvider;
  streamKeepAliveMs?: number;
}

export interface App {
  readonly config: Config;
  fetch(request: Request): Promise<Response>;
  listen(): Promise<{ url: string; port: number }>;
  /** Resolves when both workers are idle and no woken work remains. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

function buildDeps(options: AppOptions): RouteDeps & { shutdown(): void } {
  const { config } = options;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createJsonLogger({ clock });
  const bus = createStreamBus();
  const db = openDatabase(path.join(config.dataDir, DATABASE_FILE), {
    clock,
    streamRetention: config.streamRetention,
    streamBus: bus,
  });
  if (config.demoSeed) {
    const seeded = seedDemo(db, { dataDir: config.dataDir });
    if (seeded.created) logger.info('demo_seed_created', { workspaceId: seeded.credentials.workspaceId });
  }
  const evidenceStore = options.evidenceStore ?? createLocalEvidenceStore(path.join(config.dataDir, EVIDENCE_DIRECTORY));
  const renderer = options.renderer ?? createDefaultRenderer();
  const reviewer = options.reviewer ?? createReviewer(config, logger);
  const workers = {
    capture: createCaptureWorker({ db, renderer, evidenceStore, logger, clock }),
    review: createReviewWorker({ db, reviewer, config, logger, clock }),
  };
  let shuttingDown = false;
  return {
    config, db, clock, logger, bus, evidenceStore, renderer, reviewer, workers,
    identity: options.identity ?? createDemoIdentity(db),
    streamKeepAliveMs: options.streamKeepAliveMs ?? DEFAULT_STREAM_KEEP_ALIVE_MS,
    startedAt: clock.now().toISOString(),
    isShuttingDown: () => shuttingDown,
    shutdown: () => {
      shuttingDown = true;
    },
  };
}

export async function createApp(options: AppOptions): Promise<App> {
  const deps = buildDeps(options);
  const { config, workers, logger } = deps;
  let server: RunningServer | null = null;
  const http = createHttpApp(deps, () => server?.port ?? config.port);
  // Work left over from a previous run (pending captures and reviews) starts at once.
  workers.capture.wake();
  workers.review.wake();

  return {
    config,
    fetch: async (request) => http.fetch(request),
    async listen() {
      if (server) return { url: server.url, port: server.port };
      server = await startServer(http, config.host, config.port);
      logger.info('server_listening', { host: config.host, port: server.port });
      return { url: server.url, port: server.port };
    },
    async drain() {
      while (!(workers.capture.isIdle() && workers.review.isIdle())) {
        await Promise.all([workers.capture.idle(), workers.review.idle()]);
      }
    },
    async close() {
      deps.shutdown();
      if (server) await server.close();
      server = null;
      await Promise.all([workers.capture.stop(), workers.review.stop()]);
      deps.db.close();
      logger.info('server_closed');
    },
  };
}
