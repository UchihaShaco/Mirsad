import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp, type App } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { createDefaultRenderer } from '../../src/capture/index.ts';
import { createDeterministicReviewer } from '../../src/review/deterministic-reviewer.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';
import { openDatabase, DATABASE_FILE } from '../../src/storage/db.ts';
import { FakeClock } from './fake-clock.ts';
import { ControllableRenderer } from './controllable-renderer.ts';
import { ScriptedReviewer } from './scripted-reviewer.ts';
import { seedTestData, TEST_ACCOUNTS, type TestTokens } from './test-seed.ts';

const TEST_KEEP_ALIVE_MS = 25;
/** How long a restarted server may take to answer, and how often it is asked. */
const RESTART_READY_TIMEOUT_MS = 10_000;
const RESTART_READY_POLL_MS = 20;

export interface ApiResponse {
  status: number;
  headers: Headers;
  // Parsed JSON body. Tests read nested envelope fields freely; the contract tests validate shapes.
  body: any;
  text: string;
}

export interface HttpClient {
  get(path: string, headers?: Record<string, string>): Promise<ApiResponse>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
}

export interface TestHarness {
  app: App;
  baseUrl: string;
  dataDir: string;
  clock: FakeClock;
  tokens: TestTokens;
  accounts: typeof TEST_ACCOUNTS;
  http(token: string | null): HttpClient;
  renderer: ControllableRenderer;
  reviewer: ScriptedReviewer;
  logs: string[];
  drain(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOverrides {
  config?: Partial<Config>;
  streamKeepAliveMs?: number;
  startAt?: string;
}

async function send(baseUrl: string, token: string | null, method: string, urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
  const allHeaders: Record<string, string> = { ...headers };
  if (token !== null) allHeaders.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (method === 'POST' && body !== undefined) {
    allHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + urlPath, { method, headers: allHeaders, body: payload });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, headers: res.headers, body: isJson && text ? JSON.parse(text) : null, text };
}

/**
 * Asks the restarted server for GET /healthz until it answers 200. The HTTP client may still hold a keep-alive socket
 * the old server closed, and a request sent on it fails once with ECONNRESET: this probe meets it instead of a test.
 */
async function waitUntilAnswering(baseUrl: string): Promise<void> {
  const deadline = Date.now() + RESTART_READY_TIMEOUT_MS;
  for (;;) {
    let problem: unknown;
    try {
      const res = await send(baseUrl, null, 'GET', '/healthz', undefined);
      if (res.status === 200) return;
      problem = `status ${res.status}`;
    } catch (error) {
      problem = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the restarted server did not answer /healthz within ${RESTART_READY_TIMEOUT_MS} ms`, { cause: problem });
    }
    await sleep(RESTART_READY_POLL_MS);
  }
}

/** Starts a real Mirsad instance in-process on 127.0.0.1 with its own temporary data directory. */
export async function startHarness(overrides: HarnessOverrides = {}): Promise<TestHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-test-'));
  const clock = new FakeClock(overrides.startAt);
  const baseConfig = loadConfig({
    MIRSAD_PORT: '0',
    MIRSAD_DATA_DIR: dataDir,
    MIRSAD_DEMO_SEED: 'false',
    MIRSAD_REVIEWER: 'deterministic',
  });
  let config: Config = { ...baseConfig, ...overrides.config, dataDir };

  const seedDb = openDatabase(path.join(dataDir, DATABASE_FILE), { clock });
  const tokens = seedTestData(seedDb);
  seedDb.close();

  const renderer = new ControllableRenderer(createDefaultRenderer());
  const reviewer = new ScriptedReviewer(createDeterministicReviewer());
  const logs: string[] = [];
  const logger = createJsonLogger({ write: (line) => logs.push(line), clock });

  const boot = async () => {
    const app = await createApp({
      config,
      clock,
      renderer,
      reviewer,
      logger,
      streamKeepAliveMs: overrides.streamKeepAliveMs ?? TEST_KEEP_ALIVE_MS,
    });
    const { url, port } = await app.listen();
    config = { ...config, port };
    return { app, url };
  };

  let current = await boot();
  return {
    get app() {
      return current.app;
    },
    get baseUrl() {
      return current.url;
    },
    dataDir,
    clock,
    tokens,
    accounts: TEST_ACCOUNTS,
    renderer,
    reviewer,
    logs,
    http: (token) => ({
      get: (p, headers) => send(current.url, token, 'GET', p, undefined, headers),
      post: (p, body, headers) => send(current.url, token, 'POST', p, body, headers),
    }),
    drain: () => current.app.drain(),
    restart: async () => {
      await current.app.close();
      current = await boot();
      await waitUntilAnswering(current.url);
    },
    close: async () => {
      await current.app.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
