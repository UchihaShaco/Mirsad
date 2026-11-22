/**
 * The Telegram live connector against a fake Bot API server (design sections 13 and 19.8). Nothing here talks to
 * Telegram. All IDs, names and texts are synthetic; the token is a made-up value in Telegram's token format.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBotApi, type BotApi } from '../../src/adapters/telegram/bot-api.ts';
import { createLiveConnector, findLiveBindings, LiveConnectorGateError, type LiveConnector } from '../../src/adapters/telegram/live-connector.ts';
import { discoverConnections, verifyConnection } from '../../src/adapters/telegram/verify.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { createDemoIdentity } from '../../src/identity/demo-identity.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';
import { DATABASE_FILE, openDatabase, type Db } from '../../src/storage/db.ts';
import { hasGrant } from '../../src/storage/repos/principals.ts';
import { LIVE_CREDENTIALS_FILE, provisionLiveConnector, runProvision } from '../../scripts/telegram-provision.ts';
import { runVerify } from '../../scripts/telegram-verify.ts';
import { queryRows, storeSnapshot } from '../helpers/db-read.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import { seedTestData } from '../helpers/test-seed.ts';

const BOT_TOKEN = '5000000999:TEST_token_not_real_0123456789abcd';
const OWNER_ID = 5000000001;
const CONNECTION_ID = 'TestBizConn-0101';
const APPROVED_CHATS = [6000000101, 6000000102];
const APPROVAL_REFERENCE = 'TEST-APPROVAL-0001';
const WAIT = { timeout: 5_000, interval: 5 };
const HOUR_MS = 60 * 60 * 1000;

const LIVE_ENV: Record<string, string> = {
  TELEGRAM_LIVE_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_APPROVED_CONNECTION_ID: CONNECTION_ID,
  TELEGRAM_APPROVED_CHAT_IDS: APPROVED_CHATS.join(','),
  TELEGRAM_APPROVAL_REFERENCE: APPROVAL_REFERENCE,
};

type Json = Record<string, unknown>;

function reply(res: http.ServerResponse, status: number, body: Json): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Json);
}

/**
 * A stand-in for api.telegram.org: answers the four read-only methods, records every call, and holds getUpdates
 * open until updates are queued (like a long poll), so tests wait on calls instead of sleeping.
 */
const DEFAULT_ME: Json = { id: 5000000999, is_bot: true, first_name: 'Test Bot', username: 'mirsad_test_bot', can_connect_to_business: true };
const DEFAULT_WEBHOOK: Json = { url: '', has_custom_certificate: false, pending_update_count: 0 };
const DEFAULT_CONNECTION: Json = {
  id: CONNECTION_ID,
  user: { id: OWNER_ID, is_bot: false, first_name: 'Test', last_name: 'Owner' },
  user_chat_id: OWNER_ID,
  date: 1790000000,
  is_enabled: true,
};

class FakeBotApi {
  readonly calls: { method: string; body: Json }[] = [];
  me: Json = DEFAULT_ME;
  webhook: Json = DEFAULT_WEBHOOK;
  connection: Json = DEFAULT_CONNECTION;
  private queued: Json[] = [];
  private forced: Json[] | null = null;
  private pollFailures: number[] = [];
  private held: { offset: number | undefined; res: http.ServerResponse }[] = [];
  private pollWaiters: { accepts: (offset: number | undefined) => boolean; resolve: () => void }[] = [];

  private constructor(private readonly server: http.Server, readonly url: string) {}

  static async start(): Promise<FakeBotApi> {
    const holder: { fake?: FakeBotApi } = {};
    const server = http.createServer((req, res) => void holder.fake?.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    holder.fake = new FakeBotApi(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return holder.fake;
  }

  /** Resolves at the next getUpdates call whose offset the predicate accepts. */
  nextPoll(accepts: (offset: number | undefined) => boolean = () => true): Promise<void> {
    return new Promise((resolve) => this.pollWaiters.push({ accepts, resolve }));
  }

  queue(...updates: Json[]): void {
    this.queued.push(...updates);
    this.flush();
  }

  /** Delivers these updates on the next poll whatever its offset, as Telegram does when a confirmation was lost. */
  redeliver(...updates: Json[]): void {
    this.forced = updates;
    this.flush();
  }

  /** The next getUpdates calls answer with these Telegram error codes, one per call. */
  failPolls(...errorCodes: number[]): void {
    this.pollFailures.push(...errorCodes);
  }

  methods(): string[] {
    return [...new Set(this.calls.map((c) => c.method))];
  }

  /** getUpdates calls currently held open (a connector that is still polling). */
  heldPolls(): number {
    return this.held.length;
  }

  /** Answers every held getUpdates call with no updates, as Telegram does when its long-poll timeout runs out. */
  expireHeldPolls(): void {
    const held = this.held;
    this.held = [];
    for (const poll of held) reply(poll.res, 200, { ok: true, result: [] });
  }

  reset(): void {
    this.calls.length = 0;
    this.queued = [];
    this.forced = null;
    this.pollFailures = [];
    this.pollWaiters = [];
    this.me = DEFAULT_ME;
    this.webhook = DEFAULT_WEBHOOK;
    this.connection = DEFAULT_CONNECTION;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private pending(offset: number | undefined): Json[] {
    if (this.forced) {
      const forced = this.forced;
      this.forced = null;
      return forced;
    }
    return this.queued.filter((u) => offset === undefined || (u.update_id as number) >= offset);
  }

  private flush(): void {
    const held = this.held;
    this.held = [];
    for (const poll of held) {
      const ready = this.pending(poll.offset);
      if (ready.length > 0) reply(poll.res, 200, { ok: true, result: ready });
      else this.held.push(poll);
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '');
    if (!match || match[1] !== BOT_TOKEN) return reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = match[2] ?? '';
    this.calls.push({ method, body });
    if (method === 'getMe') return reply(res, 200, { ok: true, result: this.me });
    if (method === 'getWebhookInfo') return reply(res, 200, { ok: true, result: this.webhook });
    if (method === 'getBusinessConnection') {
      if (body.business_connection_id === this.connection.id) return reply(res, 200, { ok: true, result: this.connection });
      return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: BUSINESS_CONNECTION_INVALID' });
    }
    if (method === 'getUpdates') return this.poll(body, res);
    return reply(res, 404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
  }

  private poll(body: Json, res: http.ServerResponse): void {
    const offset = typeof body.offset === 'number' ? body.offset : undefined;
    if (offset !== undefined) this.queued = this.queued.filter((u) => (u.update_id as number) >= offset);
    this.pollWaiters = this.pollWaiters.filter((w) => (w.accepts(offset) ? (w.resolve(), false) : true));
    const failure = this.pollFailures.shift();
    if (failure !== undefined) return reply(res, failure, { ok: false, error_code: failure, description: `Error ${failure} from the fake` });
    const ready = this.pending(offset);
    if (ready.length > 0 || body.timeout === 0) return reply(res, 200, { ok: true, result: ready });
    this.held.push({ offset, res });
    res.on('close', () => {
      this.held = this.held.filter((h) => h.res !== res);
    });
  }
}

// ---- Synthetic Telegram business updates (design section 19.8 shapes) ----

let nextUpdateId = 910_000_001;
const BASE_DATE = 1_790_000_100;

function person(id: number): Json {
  return id === OWNER_ID
    ? { id, is_bot: false, first_name: 'Test', last_name: 'Owner' }
    : { id, is_bot: false, first_name: 'Test', last_name: `Contact ${id % 1000}` };
}

function chatOf(chatId: number): Json {
  return { id: chatId, type: 'private', first_name: 'Test', last_name: `Contact ${chatId % 1000}` };
}

interface MessageOptions {
  chatId: number;
  messageId: number;
  fromId: number;
  text: string;
  connectionId?: string;
}

function messageBody(o: MessageOptions): Json {
  return {
    message_id: o.messageId,
    date: BASE_DATE + o.messageId,
    chat: chatOf(o.chatId),
    from: person(o.fromId),
    business_connection_id: o.connectionId ?? CONNECTION_ID,
    text: o.text,
  };
}

function message(o: MessageOptions): Json {
  return { update_id: nextUpdateId++, business_message: messageBody(o) };
}

function edit(o: MessageOptions): Json {
  return { update_id: nextUpdateId++, edited_business_message: { ...messageBody(o), edit_date: BASE_DATE + o.messageId + 60 } };
}

function deletion(chatId: number, messageIds: number[], connectionId = CONNECTION_ID): Json {
  return { update_id: nextUpdateId++, deleted_business_messages: { business_connection_id: connectionId, chat: chatOf(chatId), message_ids: messageIds } };
}

function updateIdOf(update: Json | undefined): number {
  return update?.update_id as number;
}

let fake: FakeBotApi;
let h: TestHarness;
let db: Db;
const logs: string[] = [];
const logger = createJsonLogger({ write: (line) => logs.push(line) });
const running: LiveConnector[] = [];

function liveConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    MIRSAD_PORT: '0',
    MIRSAD_DATA_DIR: h.dataDir,
    MIRSAD_DEMO_SEED: 'false',
    MIRSAD_REVIEWER: 'deterministic',
    ...LIVE_ENV,
    ...overrides,
  });
}

function fakeBotApi(): BotApi {
  return createBotApi({ token: BOT_TOKEN, baseUrl: fake.url });
}

function connectorFor(config: Config, onDb: Db = db): LiveConnector {
  const connector = createLiveConnector({ config, db: onDb, logger, botApi: fakeBotApi(), retryDelayMs: 5 });
  running.push(connector);
  return connector;
}

async function liveChatId(externalChatId: number): Promise<string> {
  const chats = (await h.http(h.tokens.officerA).get('/v1/chats?limit=500')).body.data.chats as Json[];
  const chat = chats.find((c) => c.externalAccountId === String(OWNER_ID) && c.externalChatId === String(externalChatId));
  if (!chat) throw new Error(`no live chat ${externalChatId}`);
  return chat.id as string;
}

/** A full app on its own data directory (one workspace, Officer A, a provisioned live connector) wired to the fake. */
async function startWiredApp(env: Record<string, string>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-live-app-'));
  const seed = openDatabase(path.join(dataDir, DATABASE_FILE));
  let officerToken = '';
  try {
    officerToken = seed.transaction((tx) => {
      const workspace = provisionWorkspace(tx, { name: 'Test Workspace' });
      return provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'officer', displayName: 'Officer A' }).token;
    });
    provisionLiveConnector(seed, { ownerUserId: String(OWNER_ID), officers: ['Officer A'] });
  } finally {
    seed.close();
  }
  const appLogs: string[] = [];
  const config = loadConfig({ MIRSAD_PORT: '0', MIRSAD_DATA_DIR: dataDir, MIRSAD_DEMO_SEED: 'false', MIRSAD_REVIEWER: 'deterministic', ...env });
  const app = await createApp({ config, logger: createJsonLogger({ write: (line) => appLogs.push(line) }), telegramBotApi: fakeBotApi() });
  const { url } = await app.listen();
  const get = async (route: string): Promise<Json> => {
    const res = await fetch(url + route, { headers: { authorization: `Bearer ${officerToken}` } });
    return ((await res.json()) as { data: Json }).data;
  };
  return {
    app,
    logs: appLogs,
    get,
    telegramStatus: async () => ((await get('/v1/status')).channels as Json).telegram as Json,
    close: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** Overwrites the live connector's stored update offset and the time it was committed. */
function storeOffset(offset: number, committedAt: Date): void {
  db.transaction((tx) => {
    const [binding] = findLiveBindings(tx);
    tx.run(
      `INSERT INTO connector_state (connector_id, key, value, updated_at) VALUES (:id, 'telegram_update_offset', :value, :at)
       ON CONFLICT (connector_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { id: binding?.principal.id ?? '', value: String(offset), at: committedAt.toISOString() },
    );
  });
}

function lastPollOffset(): unknown {
  return fake.calls.filter((c) => c.method === 'getUpdates').at(-1)?.body.offset;
}

function startError(connector: LiveConnector): LiveConnectorGateError {
  try {
    connector.start();
  } catch (error) {
    if (error instanceof LiveConnectorGateError) return error;
    throw error;
  }
  throw new Error('expected the connector to refuse to start');
}

beforeAll(async () => {
  fake = await FakeBotApi.start();
  h = await startHarness();
  db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
  const workspaceId: string = (await h.http(h.tokens.officerA).get('/v1/me')).body.data.principal.workspaceId;
  provisionLiveConnector(db, { ownerUserId: String(OWNER_ID), officers: ['Officer A'], workspaceId });
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.stop()));
  fake.reset();
});

afterAll(async () => {
  db.close();
  await h.close();
  await fake.close();
});

describe('step 5: telegram live connector', () => {
  it('the connector refuses to start unless enabled, token, approved connection, approved chats and approval reference are all set', async () => {
    const gates = {
      TELEGRAM_LIVE_ENABLED: 'false',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_APPROVED_CONNECTION_ID: '',
      TELEGRAM_APPROVED_CHAT_IDS: '',
      TELEGRAM_APPROVAL_REFERENCE: '',
    };
    for (const [name, off] of Object.entries(gates)) {
      const connector = connectorFor(liveConfig({ [name]: off }));
      const error = startError(connector);
      expect(error.missing).toEqual([name]);
      expect(error.message).toContain(name);
      expect(error.message).not.toContain(BOT_TOKEN);
      expect(connector.stats().running).toBe(false);
    }
    // A value that is set but malformed counts as missing, and the refusal never echoes it.
    const malformedToken = startError(connectorFor(liveConfig({ TELEGRAM_BOT_TOKEN: 'not-a-telegram-token' })));
    expect(malformedToken.missing).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(malformedToken.message).not.toContain('not-a-telegram-token');
    expect(startError(connectorFor(liveConfig({ TELEGRAM_APPROVED_CHAT_IDS: '6000000101,first-chat' }))).missing).toEqual(['TELEGRAM_APPROVED_CHAT_IDS']);

    // Every setting present, but no telegram_business_live connector provisioned for a live channel account.
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-live-bare-'));
    const bare = openDatabase(path.join(bareDir, DATABASE_FILE));
    try {
      seedTestData(bare);
      const unprovisioned = startError(connectorFor(liveConfig(), bare));
      expect(unprovisioned.missing).toEqual(['live connector principal']);
    } finally {
      bare.close();
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
    expect(fake.calls).toEqual([]);

    const connector = connectorFor(liveConfig());
    const polled = fake.nextPoll();
    connector.start();
    await polled;
    expect(connector.stats().running).toBe(true);
    await connector.stop();
    expect(connector.stats()).toMatchObject({ running: false, stoppedReason: 'stopped' });
  });

  it('only updates for the approved connection and chats are stored; others are dropped and counted', async () => {
    const [chatA, chatB] = APPROVED_CHATS as [number, number];
    const updates = [
      message({ chatId: chatA, messageId: 501, fromId: chatA, text: 'Hello, this is the first approved chat.' }),
      message({ chatId: 6000000103, messageId: 502, fromId: 6000000103, text: 'canary other connection', connectionId: 'OtherBizConn-0202' }),
      message({ chatId: 6000000104, messageId: 503, fromId: 6000000104, text: 'canary other chat' }),
      edit({ chatId: 6000000104, messageId: 503, fromId: 6000000104, text: 'canary other chat, edited' }),
      deletion(6000000103, [502], 'OtherBizConn-0202'),
      { update_id: nextUpdateId++, message: { message_id: 7, date: BASE_DATE, chat: chatOf(6000000105), from: person(6000000105), text: 'canary direct message' } },
      message({ chatId: chatB, messageId: 504, fromId: OWNER_ID, text: 'The owner writes in the second approved chat.' }),
    ];
    const connector = connectorFor(liveConfig());
    const processed = fake.nextPoll((offset) => offset === updateIdOf(updates.at(-1)) + 1);
    fake.queue(...updates);
    connector.start();
    await processed;

    const chats = (await h.http(h.tokens.officerA).get('/v1/chats?limit=500')).body.data.chats as Json[];
    const live = chats.filter((c) => c.externalAccountId === String(OWNER_ID));
    expect(live.map((c) => [c.externalChatId, c.firstObservedDirection]).sort()).toEqual([
      [String(chatA), 'incoming'],
      [String(chatB), 'outgoing'],
    ]);
    expect(connector.stats()).toMatchObject({ stored: 2, dropped: { otherConnection: 2, otherChat: 2, other: 1 } });

    const storedRows = ['chats', 'messages', 'message_events', 'connector_state', 'stream_events', 'case_actions']
      .map((table) => JSON.stringify(queryRows(h.dataDir, `SELECT * FROM ${table}`)))
      .join('\n');
    const logText = [...logs, ...h.logs].join('\n');
    for (const leaked of ['canary', '6000000103', '6000000104', '6000000105', 'Contact 103', 'Contact 104', 'Contact 105', 'OtherBizConn']) {
      expect(storedRows).not.toContain(leaked);
      expect(logText).not.toContain(leaked);
    }
  });

  it('the update offset is persisted and redelivered updates create nothing new', async () => {
    const [chatA] = APPROVED_CHATS as [number];
    const updates = [
      message({ chatId: chatA, messageId: 601, fromId: chatA, text: 'A message before the restart.' }),
      edit({ chatId: chatA, messageId: 601, fromId: chatA, text: 'A message before the restart, edited.' }),
      deletion(chatA, [601]),
    ];
    const next = updateIdOf(updates.at(-1)) + 1;
    const first = connectorFor(liveConfig());
    const processed = fake.nextPoll((offset) => offset === next);
    fake.queue(...updates);
    first.start();
    await processed;
    await first.stop();
    const state = queryRows<{ value: string }>(h.dataDir, 'SELECT value FROM connector_state');
    expect(state.map((row) => row.value)).toContain(String(next));

    // A new connector (as after a restart) resumes from the stored offset.
    const before = storeSnapshot(h.dataDir);
    const resumed = connectorFor(liveConfig());
    const resumedPoll = fake.nextPoll();
    resumed.start();
    await resumedPoll;
    expect(fake.calls.filter((c) => c.method === 'getUpdates').at(-1)?.body.offset).toBe(next);

    // Telegram redelivers older updates whose confirmation it never received: nothing new is stored, and the
    // offset does not move back to them.
    const redelivered = fake.nextPoll((offset) => offset === next);
    fake.redeliver(...updates.slice(0, 2));
    await redelivered;
    expect(storeSnapshot(h.dataDir)).toEqual(before);
    expect(resumed.stats()).toMatchObject({ stored: 0, duplicates: 2, offset: next });
  });

  it('a business_connection update that disables or changes the approved connection stops intake', async () => {
    const [chatA] = APPROVED_CHATS as [number];
    const otherOwner = { ...DEFAULT_CONNECTION, id: 'OtherBizConn-0303', user: person(5000000003) };
    const kept = connectorFor(liveConfig());
    const keptUpdates = [{ update_id: nextUpdateId++, business_connection: otherOwner }, message({ chatId: chatA, messageId: 1001, fromId: chatA, text: 'Still here.' })];
    const processed = fake.nextPoll((offset) => offset === updateIdOf(keptUpdates.at(-1)) + 1);
    fake.queue(...keptUpdates);
    kept.start();
    await processed;
    expect(kept.stats()).toMatchObject({ running: true, stored: 1, dropped: { otherConnection: 1 } });
    await kept.stop();

    const cases: [Json, string][] = [
      [{ ...DEFAULT_CONNECTION, is_enabled: false }, 'connection_disabled'],
      [{ ...DEFAULT_CONNECTION, id: 'TestBizConn-0199' }, 'connection_changed'],
      [{ ...DEFAULT_CONNECTION, user: person(5000000002) }, 'connection_owner_mismatch'],
    ];
    for (const [connection, reason] of cases) {
      fake.reset();
      const before = storeSnapshot(h.dataDir);
      const change = { update_id: nextUpdateId++, business_connection: connection };
      const after = message({ chatId: chatA, messageId: 1002, fromId: chatA, text: 'Sent after the connection changed.' });
      const connector = connectorFor(liveConfig());
      fake.queue(change, after);
      connector.start();
      await vi.waitFor(() => expect(connector.stats().running).toBe(false), WAIT);
      expect(connector.stats()).toMatchObject({ stoppedReason: reason, stored: 0 });
      expect(storeSnapshot(h.dataDir)).toEqual(before);
      // The update after the change is not confirmed, so Telegram keeps it until intake is approved again.
      expect(queryRows<{ value: string }>(h.dataDir, 'SELECT value FROM connector_state').map((r) => r.value)).toEqual([
        String(updateIdOf(change) + 1),
      ]);
      expect(logs.some((line) => line.includes('telegram_live_connector_stopped') && line.includes(reason))).toBe(true);
    }
  });

  it('a failed poll is logged and retried, and a token Telegram rejects stops the connector', async () => {
    const [chatA] = APPROVED_CHATS as [number];
    const update = message({ chatId: chatA, messageId: 1101, fromId: chatA, text: 'Sent while Telegram had a hiccup.' });
    const firstLine = logs.length;
    fake.failPolls(502, 429);
    const processed = fake.nextPoll((offset) => offset === updateIdOf(update) + 1);
    fake.queue(update);
    const retried = connectorFor(liveConfig());
    retried.start();
    await processed;
    expect(retried.stats()).toMatchObject({ running: true, stored: 1 });
    const failures = logs
      .slice(firstLine)
      .filter((line) => line.includes('telegram_live_poll_failed'))
      .map((line) => JSON.parse(line) as Json);
    expect(failures.map((f) => [f.code, f.status, f.attempt])).toEqual([
      ['api_error', 502, 1],
      ['api_error', 429, 2],
    ]);
    await retried.stop();

    const wrongToken = '5000000999:TEST_wrong_token_0123456789abcdef';
    const rejected = createLiveConnector({ config: liveConfig(), db, logger, botApi: createBotApi({ token: wrongToken, baseUrl: fake.url }), retryDelayMs: 5 });
    running.push(rejected);
    rejected.start();
    await vi.waitFor(() => expect(rejected.stats().running).toBe(false), WAIT);
    expect(rejected.stats().stoppedReason).toBe('token_rejected');
    expect(logs.join('\n')).not.toContain('TEST_wrong_token');
  });

  it('the connector never calls a send method', async () => {
    const readOnly = ['getBusinessConnection', 'getMe', 'getUpdates', 'getWebhookInfo'];
    expect(Object.keys(fakeBotApi()).sort()).toEqual(readOnly);

    const [chatA] = APPROVED_CHATS as [number];
    const updates = [
      message({ chatId: chatA, messageId: 901, fromId: chatA, text: 'Can someone reply to me?' }),
      message({ chatId: chatA, messageId: 902, fromId: OWNER_ID, text: 'Yes, an officer will reply soon.' }),
      edit({ chatId: chatA, messageId: 901, fromId: chatA, text: 'Can someone reply to me today?' }),
      deletion(chatA, [902]),
      message({ chatId: 6000000106, messageId: 903, fromId: 6000000106, text: 'Not an approved chat.' }),
    ];
    const connector = connectorFor(liveConfig());
    const processed = fake.nextPoll((offset) => offset === updateIdOf(updates.at(-1)) + 1);
    fake.queue(...updates);
    connector.start();
    await processed;
    await connector.stop();
    await verifyConnection(fakeBotApi(), liveConfig(), { provisionedOwnerUserId: String(OWNER_ID) });

    expect(connector.stats()).toMatchObject({ stored: 4, dropped: { otherChat: 1 } });
    expect(fake.methods().sort()).toEqual(readOnly);
  });

  it('messages captured live get review status not_permitted', async () => {
    const [, chatB] = APPROVED_CHATS as [number, number];
    const connector = connectorFor(liveConfig());
    const first = message({ chatId: chatB, messageId: 701, fromId: chatB, text: 'Please pay the deposit at https://pay.shop.test/live/1' });
    let processed = fake.nextPoll((offset) => offset === updateIdOf(first) + 1);
    fake.queue(first);
    connector.start();
    await processed;
    const chatId = await liveChatId(chatB);

    // The officer starts AI review for the chat; live content must still never reach the reviewer.
    const dispatched = await h.http(h.tokens.officerA).post('/v1/dispatches', { chatIds: [chatId] }, { 'Idempotency-Key': uniqueId('live-dispatch-') });
    expect(dispatched.body.data.results[0]).toMatchObject({ chatId, aiMode: 'ai_active' });
    const second = message({ chatId: chatB, messageId: 702, fromId: chatB, text: 'Or call me on +44 7700 900321 about the payment.' });
    processed = fake.nextPoll((offset) => offset === updateIdOf(second) + 1);
    fake.queue(second);
    await processed;
    // Wake the review worker with unrelated fixture intake, then let both workers settle.
    await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts.intake, uniqueId('wake-'), recorded({ messageId: 1 })));
    await h.drain();

    const timeline = (await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`)).body.data;
    const live = (timeline.messages as Json[]).filter((m) => ['tg:701', 'tg:702'].includes((m.source as Json).sourceMessageId as string));
    expect(live.map((m) => [(m.source as Json).captureMethod, (m.review as Json).status])).toEqual([
      ['telegram_business_live', 'not_permitted'],
      ['telegram_business_live', 'not_permitted'],
    ]);
    expect(h.reviewer.calls.filter((call) => call.chatId === chatId)).toEqual([]);
    expect(timeline.findings).toEqual([]);
  });

  it('verification reports bot and connection state without the token or any message content', async () => {
    // A business message is waiting on Telegram's side; verification must not pull it.
    fake.queue(message({ chatId: 6000000101, messageId: 801, fromId: 6000000101, text: 'canary waiting message' }));
    const report = await verifyConnection(fakeBotApi(), liveConfig(), { provisionedOwnerUserId: String(OWNER_ID) });
    expect(report).toMatchObject({
      ready: true,
      bot: { id: 5000000999, username: 'mirsad_test_bot', canConnectToBusiness: true },
      webhook: { set: false, pendingUpdateCount: 0 },
      connection: { id: CONNECTION_ID, ownerUserId: String(OWNER_ID), enabled: true, rightsGranted: [] },
    });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(fake.methods().sort()).toEqual(['getBusinessConnection', 'getMe', 'getWebhookInfo']);
    const secretParts = [BOT_TOKEN, BOT_TOKEN.split(':')[1] ?? BOT_TOKEN];
    const noLeaks = (text: string) => {
      for (const leaked of [...secretParts, 'canary', 'Owner', 'Test Bot']) expect(text).not.toContain(leaked);
    };
    noLeaks(JSON.stringify(report));

    // A bot without business mode, a webhook left set, a disabled connection with rights granted, and an owner other
    // than the provisioned account each fail their own check. The webhook URL is not echoed.
    fake.me = { ...DEFAULT_ME, can_connect_to_business: false };
    fake.webhook = { ...DEFAULT_WEBHOOK, url: 'https://hooks.example.test/telegram/path', pending_update_count: 3 };
    fake.connection = { ...DEFAULT_CONNECTION, is_enabled: false, rights: { can_reply: true, can_read_messages: false } };
    const failing = await verifyConnection(fakeBotApi(), liveConfig(), { provisionedOwnerUserId: '5000000002' });
    expect(failing.ready).toBe(false);
    expect(failing.checks.filter((c) => !c.passed).map((c) => c.id).sort()).toEqual([
      'bot_can_connect_to_business',
      'connection_enabled',
      'connection_owner_provisioned',
      'connection_rights_none',
      'polling_transport',
    ]);
    expect(failing.connection?.rightsGranted).toEqual(['can_reply']);
    expect(JSON.stringify(failing)).not.toContain('hooks.example.test');

    // A token Telegram rejects: reported, nothing else checked, and the rejected token is not echoed either.
    const wrongToken = '5000000999:TEST_wrong_token_0123456789abcdef';
    const rejected = await verifyConnection(createBotApi({ token: wrongToken, baseUrl: fake.url }), liveConfig(), {});
    expect(rejected.checks.find((c) => c.id === 'token_accepted')).toMatchObject({ passed: false });
    expect(rejected).toMatchObject({ ready: false, bot: null, webhook: null, connection: null });
    expect(JSON.stringify(rejected)).not.toContain('TEST_wrong_token');
  });

  it('createApp runs the live connector only when TELEGRAM_LIVE_ENABLED=true and every gate is set', async () => {
    // Without the flag, no connector exists at all.
    const off = await startWiredApp({ ...LIVE_ENV, TELEGRAM_LIVE_ENABLED: 'false' });
    try {
      expect((await off.telegramStatus()).liveConnector).toBe('disabled');
      expect(off.logs.some((line) => line.includes('telegram_live_connector'))).toBe(false);
    } finally {
      await off.close();
    }

    // With the flag but a missing gate, the service still starts and serves; the refusal is logged by name only.
    const refused = await startWiredApp({ ...LIVE_ENV, TELEGRAM_APPROVAL_REFERENCE: '' });
    try {
      expect((await refused.telegramStatus()).liveConnector).toBe('disabled');
      const refusal = refused.logs.find((line) => line.includes('telegram_live_connector_refused'));
      expect(refusal).toContain('TELEGRAM_APPROVAL_REFERENCE');
      expect(refused.logs.join('\n')).not.toContain(BOT_TOKEN.split(':')[1]);
    } finally {
      await refused.close();
    }
    expect(fake.calls).toEqual([]);

    // Every gate set: it polls for the four business update types with a 30-second timeout, status reports it
    // enabled, and evidence it stores is captured by the app's own workers.
    const wired = await startWiredApp(LIVE_ENV);
    try {
      expect((await wired.telegramStatus()).liveConnector).toBe('enabled');
      const update = message({ chatId: 6000000101, messageId: 1301, fromId: 6000000101, text: 'Hello from the wired app.' });
      const processed = fake.nextPoll((offset) => offset === updateIdOf(update) + 1);
      fake.queue(update);
      await processed;
      expect(fake.heldPolls()).toBe(1);
      await wired.app.drain();
      const [chat] = ((await wired.get('/v1/chats')).chats as Json[]) ?? [];
      const timeline = await wired.get(`/v1/chats/${String(chat?.id)}/timeline`);
      const [stored] = timeline.messages as Json[];
      expect((stored?.capture as Json).status).toBe('ready');
      expect((stored?.source as Json).captureMethod).toBe('telegram_business_live');
      const [firstPoll] = fake.calls.filter((c) => c.method === 'getUpdates');
      expect(firstPoll?.body).toMatchObject({
        timeout: 30,
        allowed_updates: ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'],
      });
    } finally {
      await wired.close();
    }
    // Closing the app stopped the connector: it logged the stop and abandoned its open long poll.
    expect(wired.logs.some((line) => line.includes('telegram_live_connector_stopped'))).toBe(true);
    await vi.waitFor(() => expect(fake.heldPolls()).toBe(0), WAIT);
  });

  it('telegram:provision creates the live account, connector and officer grants, writing the token only to the credentials file', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-provision-'));
    const env = { MIRSAD_DATA_DIR: dataDir };
    const seed = openDatabase(path.join(dataDir, DATABASE_FILE));
    const officer = seed.transaction((tx) => {
      const workspace = provisionWorkspace(tx, { name: 'Test Workspace' });
      return provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'officer', displayName: 'Demo Officer 1' }).principal;
    });
    seed.close();
    const out: string[] = [];
    const run = (...argv: string[]) => runProvision({ argv, env, write: (text) => out.push(text) });
    try {
      expect(run('--owner-user-id', String(OWNER_ID), '--officer', 'Demo Officer 1')).toBe(0);
      const credentialsFile = path.join(dataDir, LIVE_CREDENTIALS_FILE);
      const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')) as Record<string, string>;
      expect(credentials).toMatchObject({ externalAccountId: String(OWNER_ID), captureMethod: 'telegram_business_live' });
      const printed = out.join('');
      expect(printed).toContain(String(credentials.principalId));
      expect(printed).toContain(officer.id);
      expect(printed).not.toContain(String(credentials.token));

      const check = openDatabase(path.join(dataDir, DATABASE_FILE));
      try {
        expect(createDemoIdentity(check).authenticate(`Bearer ${credentials.token}`)).toMatchObject({
          id: credentials.principalId,
          kind: 'connector',
          captureMethod: 'telegram_business_live',
        });
        const bindings = check.transaction((tx) => findLiveBindings(tx));
        expect(bindings.map((b) => [b.principal.id, b.ownerUserId])).toEqual([[credentials.principalId, OWNER_ID]]);
        expect(check.transaction((tx) => hasGrant(tx, officer.id, bindings[0]?.account.id ?? ''))).toBe(true);
      } finally {
        check.close();
      }

      // Re-running keeps the connector and its token; an unknown officer or a second owner account is refused.
      expect(run('--owner-user-id', String(OWNER_ID), '--officer', officer.id)).toBe(0);
      expect(JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))).toEqual(credentials);
      expect(run('--owner-user-id', String(OWNER_ID), '--officer', 'Nobody Known')).toBe(1);
      expect(run('--owner-user-id', '5000000002')).toBe(1);
      expect(run('--owner-user-id', 'not-a-user-id')).toBe(1);
      expect(run('--owner')).toBe(2);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('telegram:verify prints what is missing without a token and reports the connection with one', async () => {
    const out: string[] = [];
    const write = (text: string) => out.push(text);
    expect(await runVerify({ env: { MIRSAD_DATA_DIR: h.dataDir }, argv: [], write })).toBe(1);
    expect(out.join('')).toContain('TELEGRAM_BOT_TOKEN');
    expect(fake.calls).toEqual([]);

    out.length = 0;
    const env = { MIRSAD_DATA_DIR: h.dataDir, ...LIVE_ENV };
    expect(await runVerify({ env, argv: [], write, botApi: fakeBotApi() })).toBe(0);
    const printed = out.join('');
    expect(printed).toMatch(/PASS\s+connection_owner_provisioned/);
    expect(printed).not.toContain(BOT_TOKEN.split(':')[1]);

    out.length = 0;
    fake.webhook = { ...DEFAULT_WEBHOOK, url: 'https://hooks.example.test/x' };
    expect(await runVerify({ env, argv: [], write, botApi: fakeBotApi() })).toBe(1);
    expect(out.join('')).toMatch(/FAIL\s+polling_transport/);

    out.length = 0;
    fake.queue({ update_id: nextUpdateId++, business_connection: DEFAULT_CONNECTION });
    expect(await runVerify({ env, argv: ['--discover-connections'], write, botApi: fakeBotApi() })).toBe(0);
    expect(out.join('')).toContain(CONNECTION_ID);
    expect(out.join('')).toContain(String(OWNER_ID));
  });

  it('connection discovery lists business connections without reading or confirming message updates', async () => {
    fake.queue(
      { update_id: nextUpdateId++, business_connection: { ...DEFAULT_CONNECTION, is_enabled: false } },
      message({ chatId: 6000000101, messageId: 1201, fromId: 6000000101, text: 'canary queued before approval' }),
      { update_id: nextUpdateId++, business_connection: DEFAULT_CONNECTION },
    );
    const discovery = await discoverConnections(fakeBotApi());
    expect(discovery).toEqual({
      connections: [{ id: CONNECTION_ID, ownerUserId: String(OWNER_ID), enabled: true, rightsGranted: [] }],
      otherUpdates: 1,
    });
    // A short poll with no offset confirms nothing, so the live connector still receives every update later.
    expect(fake.calls).toEqual([{ method: 'getUpdates', body: { timeout: 0, allowed_updates: ['business_connection'] } }]);
    expect(JSON.stringify(discovery)).not.toContain('canary');
  });

  it('a stored offset committed longer ago than Telegram keeps updates is not used, so updates after an update_id restart are stored', async () => {
    const [chatA] = APPROVED_CHATS as [number];
    const highOffset = nextUpdateId + 1_000_000;
    // Committed within Telegram's 24-hour retention: the first poll starts from it.
    storeOffset(highOffset, new Date(Date.now() - 23 * HOUR_MS));
    const fresh = connectorFor(liveConfig());
    const freshPoll = fake.nextPoll();
    fresh.start();
    await freshPoll;
    expect(lastPollOffset()).toBe(highOffset);
    await fresh.stop();

    // Committed earlier than that: after a week without updates Telegram numbers new updates from a random value, here
    // below the stored offset. The connector polls without an offset, so the new update is delivered and stored.
    storeOffset(highOffset, new Date(Date.now() - 25 * HOUR_MS));
    const restarted = {
      update_id: 100_000_001,
      business_message: messageBody({ chatId: chatA, messageId: 1401, fromId: chatA, text: 'Sent after a long quiet spell.' }),
    };
    fake.queue(restarted);
    const stale = connectorFor(liveConfig());
    const firstPoll = fake.nextPoll();
    stale.start();
    await firstPoll;
    expect(lastPollOffset()).toBeUndefined();
    await vi.waitFor(() => expect(stale.stats()).toMatchObject({ stored: 1, offset: 100_000_002 }), WAIT);
    expect(logs.some((line) => line.includes('telegram_live_offset_stale'))).toBe(true);
  });

  it('while running, an offset whose last commit is older than Telegram keeps updates is dropped before the next poll', async () => {
    const [chatA] = APPROVED_CHATS as [number];
    const clock = new FakeClock();
    const clocked = openDatabase(path.join(h.dataDir, DATABASE_FILE), { clock });
    let connector: LiveConnector | undefined;
    try {
      const first = message({ chatId: chatA, messageId: 1501, fromId: chatA, text: 'The last message before a quiet spell.' });
      storeOffset(updateIdOf(first), clock.now());
      connector = connectorFor(liveConfig(), clocked);
      const processed = fake.nextPoll((offset) => offset === updateIdOf(first) + 1);
      fake.queue(first);
      connector.start();
      await processed;

      // More than a day passes without updates; then Telegram numbers the next update below the committed offset.
      clock.advance(25 * HOUR_MS);
      const restarted = {
        update_id: 100_000_101,
        business_message: messageBody({ chatId: chatA, messageId: 1502, fromId: chatA, text: 'The first message after the quiet spell.' }),
      };
      fake.queue(restarted);
      fake.expireHeldPolls();
      const running = connector;
      await vi.waitFor(() => expect(running.stats()).toMatchObject({ stored: 2, offset: 100_000_102 }), WAIT);
    } finally {
      await connector?.stop();
      clocked.close();
    }
  });
});
