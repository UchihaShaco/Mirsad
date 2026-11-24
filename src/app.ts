/** Composition root: wires storage, ports, workers and HTTP into one App. */
import fs from 'node:fs';
import path from 'node:path';
import { createBotSender, createTelegramEraser, isWellFormedBotToken, type BotApi, type BotSender, type TelegramEraser } from './adapters/telegram/bot-api.ts';
import { createLiveConnector, LiveConnectorGateError, type LiveConnector } from './adapters/telegram/live-connector.ts';
import { createDefaultRenderer } from './capture/index.ts';
import type { Config } from './config.ts';
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
import { createLmStudioReplyGenerator, type ReplyGenerator } from './replies/reply-generator.ts';
import { createOpenRouterReplyGenerator } from './replies/openrouter-reply-generator.ts';
import { createReviewer } from './review/reviewer-factory.ts';
import { createStreamBus, type StreamBus } from './services/stream.ts';
import { DATABASE_FILE, openDatabase, type Db } from './storage/db.ts';
import { createLocalEvidenceStore } from './storage/local-evidence-store.ts';
import { flushErasedEvidence } from './services/erased-evidence.ts';
import { AiRepliesGateError, clearReplyEnrollments, createAiReplyWorker, type AiReplyWorker } from './workers/ai-reply-worker.ts';
import { createCaptureWorker } from './workers/capture-worker.ts';
import type { JobLoop } from './workers/job-loop.ts';
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
  /** Bot API client for the Telegram live connector; defaults to the real Bot API. Tests pass a fake server's. */
  telegramBotApi?: BotApi;
  /** Sender for opt-in Telegram replies; defaults to the real Bot API with the configured token. */
  telegramBotSender?: BotSender;
  telegramEraser?: TelegramEraser;
  /** Overrides the default reply generator for tests. */
  replyGenerator?: ReplyGenerator;
  /** How often the reply worker looks for a message to answer besides being woken. Tests set it long, so a missing wake shows. */
  aiReplyPollIntervalMs?: number;
}

/**
 * The one dependency object handed to registerRoutes and to both worker factories (design section 17).
 * `streamKeepAliveMs` carries AppOptions.streamKeepAliveMs to the event stream; `startedAt` feeds GET /v1/status,
 * and so does `telegramLive`, whose connector exists only when TELEGRAM_LIVE_ENABLED=true (design section 13).
 */
export interface AppDeps {
  config: Config;
  db: Db;
  clock: Clock;
  logger: Logger;
  bus: StreamBus;
  identity: IdentityProvider;
  evidenceStore: EvidenceStore;
  renderer: CaptureRenderer;
  reviewer: Reviewer;
  workers: { capture: { wake(): void }; review: { wake(): void } };
  streamKeepAliveMs: number;
  startedAt: string;
  telegramLive: { running(): boolean; repliesRunning(): boolean; forgetChat?(chatId: string): void };
  telegramEraser?: TelegramEraser;
}

export interface App {
  readonly config: Config;
  fetch(request: Request): Promise<Response>;
  listen(): Promise<{ url: string; port: number }>;
  /** Resolves when both workers are idle and no woken work remains. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

interface Runtime {
  deps: AppDeps;
  workers: { capture: JobLoop; review: JobLoop };
  /** Created only when TELEGRAM_LIVE_ENABLED=true; it still refuses to start unless every other gate is set. */
  liveConnector: LiveConnector | null;
  /** Created only when TELEGRAM_AI_REPLIES_ENABLED=true; it refuses to start unless its gates and the live gates are set. */
  aiReplies: AiReplyWorker | null;
}

function senderFor(config: Config): BotSender | null {
  const token = config.telegram.botToken;
  return token && isWellFormedBotToken(token) ? createBotSender({ token }) : null;
}

function aiReplyWorkerFor(options: AppOptions, deps: AppDeps): AiReplyWorker | null {
  const { config } = deps;
  if (!config.telegram.aiReplies.enabled) return null;
  const { baseUrl, model, timeoutMs, contextTokens, arabicReply } = config.lmStudio;
  const provider = config.replyProvider;
  const generator = options.replyGenerator ?? (provider.kind === 'openrouter'
    ? createOpenRouterReplyGenerator({ model: provider.model, apiKey: provider.apiKey, timeoutMs: 60_000 })
    : createLmStudioReplyGenerator({ baseUrl, model, timeoutMs, contextTokens, requireModelMatch: Boolean(arabicReply) }));
  return createAiReplyWorker({
    config,
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    generator,
    ...(provider.kind === 'lmstudio' && arabicReply && { arabicGenerator: createLmStudioReplyGenerator({ ...arabicReply, timeoutMs, requireModelMatch: true }) }),
    sender: options.telegramBotSender ?? senderFor(config),
    onReplyStored: () => deps.workers.capture.wake(),
    ...(options.aiReplyPollIntervalMs === undefined ? {} : { pollIntervalMs: options.aiReplyPollIntervalMs }),
  });
}

function buildRuntime(options: AppOptions): Runtime {
  const { config } = options;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createJsonLogger({ clock });
  const bus = createStreamBus();
  const db = openDatabase(path.join(config.dataDir, DATABASE_FILE), {
    clock,
    logger,
    streamRetention: config.streamRetention,
    streamBus: bus,
  });
  if (config.demoSeed) {
    const seeded = seedDemo(db, { dataDir: config.dataDir });
    if (seeded.created) logger.info('demo_seed_created', { workspaceId: seeded.credentials.workspaceId });
  }
  // Workers are created from deps, and deps.workers wakes them: bind late so both see the same object.
  let loops: Runtime['workers'] | null = null;
  let live: LiveConnector | null = null;
  let aiReplies: AiReplyWorker | null = null;
  const deps: AppDeps = {
    config, db, clock, logger, bus,
    ...(options.telegramEraser ? { telegramEraser: options.telegramEraser } :
      config.telegram.liveEnabled && !options.telegramBotApi && config.telegram.botToken && isWellFormedBotToken(config.telegram.botToken)
        ? { telegramEraser: createTelegramEraser({ token: config.telegram.botToken }) } : {}),
    identity: options.identity ?? createDemoIdentity(db),
    evidenceStore: options.evidenceStore ?? createLocalEvidenceStore(path.join(config.dataDir, EVIDENCE_DIRECTORY)),
    renderer: options.renderer ?? createDefaultRenderer(),
    reviewer: options.reviewer ?? createReviewer(config, logger),
    workers: {
      capture: { wake: () => loops?.capture.wake() },
      // Dispatch and Resume AI wake the review worker when a chat becomes AI active; the AI reply worker wakes with it,
      // so a fresh message waiting in that chat is answered at once rather than at the next poll.
      review: {
        wake: () => {
          loops?.review.wake();
          aiReplies?.wake();
        },
      },
    },
    streamKeepAliveMs: options.streamKeepAliveMs ?? DEFAULT_STREAM_KEEP_ALIVE_MS,
    startedAt: clock.now().toISOString(),
    telegramLive: {
      running: () => live?.stats().running ?? false,
      repliesRunning: () => aiReplies?.running() ?? false,
      forgetChat: chatId => aiReplies?.forgetChat(chatId),
    },
  };
  loops = { capture: createCaptureWorker(deps), review: createReviewWorker(deps) };
  live = config.telegram.liveEnabled
    ? createLiveConnector({
        config, db, logger,
        ...(options.telegramBotApi ? { botApi: options.telegramBotApi } : {}),
        onStopped: () => aiReplies?.disable(),
        onEvidenceStored: () => {
          deps.workers.capture.wake();
          deps.workers.review.wake();
        },
      })
    : null;
  aiReplies = aiReplyWorkerFor(options, deps);
  return { deps, workers: loops, liveConnector: live, aiReplies };
}

/** Like the connector: a refusal leaves the service running with replies off; the log names the gates, never values. */
function startAiReplies(worker: AiReplyWorker | null, logger: Logger, db: Db): void {
  if (worker) {
    try {
      worker.start();
      return;
    } catch (error) {
      if (!(error instanceof AiRepliesGateError)) throw error;
      logger.warn('telegram_ai_replies_refused', { missing: error.missing.join(', ') });
    }
  }
  clearReplyEnrollments(db);
}

/** A refused connector leaves the service running with the connector off; the log names the gates, never values. */
function startLiveConnector(connector: LiveConnector | null, logger: Logger): void {
  if (!connector) return;
  try {
    connector.start();
  } catch (error) {
    if (!(error instanceof LiveConnectorGateError)) throw error;
    logger.warn('telegram_live_connector_refused', { missing: error.missing.join(', ') });
  }
}

export async function createApp(options: AppOptions): Promise<App> {
  const { deps, workers, liveConnector, aiReplies } = buildRuntime(options);
  const { config, logger } = deps;
  const filesPending = await flushErasedEvidence(deps.db, deps.evidenceStore);
  if (filesPending) logger.warn('erased_evidence_cleanup_pending', { count: filesPending });
  let server: RunningServer | null = null;
  const http = createHttpApp(deps, () => server?.port ?? config.port);
  // Work left over from a previous run (pending captures and reviews) starts at once.
  workers.capture.wake();
  workers.review.wake();
  startLiveConnector(liveConnector, logger);
  startAiReplies(aiReplies, logger, deps.db);
  const allIdle = (): boolean => workers.capture.isIdle() && workers.review.isIdle() && (aiReplies?.isIdle() ?? true);

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
      while (!allIdle()) {
        await Promise.all([workers.capture.idle(), workers.review.idle(), aiReplies?.idle()]);
      }
    },
    async close() {
      await liveConnector?.stop();
      await aiReplies?.stop();
      if (server) await server.close();
      server = null;
      await Promise.all([workers.capture.stop(), workers.review.stop()]);
      deps.db.close();
      logger.info('server_closed');
    },
  };
}
