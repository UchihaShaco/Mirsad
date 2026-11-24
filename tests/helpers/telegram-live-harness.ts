/**
 * A whole Mirsad app with the Telegram live connector and the AI reply worker running against stand-ins: an in-memory
 * Bot API (a long poll fed by the test), a recording sender and a scripted reply writer. Shared by the integration
 * tests for local-model replies and for the all-private chat scope. Nothing here talks to Telegram or LM Studio. All
 * IDs, names and texts are synthetic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';
import {
  BotApiError,
  type BotApi,
  type BotSender,
  type BusinessReply,
  type GetUpdatesParams,
  type RawUpdate,
  type SentMessage,
  type TelegramEraser,
} from '../../src/adapters/telegram/bot-api.ts';
import { createApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';
import { ReplyGenerationError, type ReplyFailureCode, type ReplyGenerator, type ReplyTurn } from '../../src/replies/reply-generator.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { provisionLiveConnector } from '../../scripts/telegram-provision.ts';
import { FakeClock } from './fake-clock.ts';

export const BOT_TOKEN = '5000000999:TEST_token_not_real_0123456789abcd';
export const BOT_ID = 5000000999;
export const OWNER_ID = 5000000001;
export const CONNECTION_ID = 'TestBizConn-0101';
export const WAIT = { timeout: 10_000, interval: 20 };
/** The reply worker's polling interval in these tests: far longer than any test, so a missing wake fails the test. */
export const NO_POLL_MS = 60 * 60 * 1000;
const MS_PER_SECOND = 1_000;

export type Json = Record<string, any>;

/** The settings every live test shares; each test file adds its chat scope. */
export const LIVE_BASE_ENV: Record<string, string> = {
  TELEGRAM_LIVE_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_APPROVED_CONNECTION_ID: CONNECTION_ID,
  TELEGRAM_APPROVAL_REFERENCE: 'TEST-APPROVAL-0001',
  TELEGRAM_AI_REPLIES_ENABLED: 'true',
  TELEGRAM_AI_REPLY_CONSENT_REFERENCE: 'TEST-CONSENT-0001',
};

/** The live connector's Bot API, in memory: getUpdates waits until updates are queued, like a long poll. */
export class StubBotApi implements BotApi {
  private queued: RawUpdate[] = [];
  private waiters: (() => void)[] = [];

  async getMe() {
    return { id: BOT_ID, is_bot: true, first_name: 'Test Bot', username: 'mirsad_test_bot', can_connect_to_business: true };
  }

  async getWebhookInfo() {
    return { url: '', pending_update_count: 0 };
  }

  async getBusinessConnection() {
    return { id: CONNECTION_ID, user: { id: OWNER_ID, is_bot: false, first_name: 'Test' }, user_chat_id: OWNER_ID, date: 1790000000, is_enabled: true };
  }

  async getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<RawUpdate[]> {
    for (;;) {
      if (signal?.aborted) throw new BotApiError('getUpdates', 'aborted');
      const { offset } = params;
      if (offset !== undefined) this.queued = this.queued.filter((u) => u.update_id >= offset);
      if (this.queued.length > 0) return [...this.queued];
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }

  queue(...updates: RawUpdate[]): void {
    this.queued.push(...updates);
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}

/** Records every reply; can refuse the next one as Telegram would. */
export class RecordingSender implements BotSender {
  readonly sent: { reply: BusinessReply; message: SentMessage }[] = [];
  private refuseNext: number | null = null;

  constructor(private readonly clock: FakeClock) {}

  refuse(status: number): void {
    this.refuseNext = status;
  }

  async sendBusinessMessage(reply: BusinessReply): Promise<SentMessage> {
    if (this.refuseNext !== null) {
      const status = this.refuseNext;
      this.refuseNext = null;
      throw new BotApiError('sendMessage', 'api_error', status, 'Forbidden: test refusal');
    }
    const message: SentMessage = {
      message_id: nextMessageId++,
      date: Math.floor(this.clock.now().getTime() / MS_PER_SECOND),
      chat: { id: reply.chatId },
      from: { id: OWNER_ID, first_name: 'Test', last_name: 'Owner' },
      text: reply.text,
    };
    this.sent.push({ reply, message });
    return message;
  }

  to(chatId: number): { reply: BusinessReply; message: SentMessage }[] {
    return this.sent.filter((s) => s.reply.chatId === chatId);
  }
}

/** Stands in for the local model: scripted replies first, then numbered ones; an optional hold; scripted failures. */
export class ScriptedGenerator implements ReplyGenerator {
  readonly model = 'test-model';
  readonly histories: ReplyTurn[][] = [];
  readonly currentTurns: (readonly string[] | undefined)[] = [];
  /** The correction each call was given (undefined for a first draft). */
  readonly corrections: (string | undefined)[] = [];
  private count = 0;
  private scripted: (string | null)[] = [];
  private failures: ReplyFailureCode[] = [];
  private hold: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** The next generate() calls return these drafts, with null denoting deliberate silence. */
  replyNext(...texts: (string | null)[]): void {
    this.scripted.push(...texts);
  }

  failNext(code: ReplyFailureCode): void {
    this.failures.push(code);
  }

  /** The next generate() waits until releaseHeld() is called. */
  holdNext(): void {
    this.hold = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  releaseHeld(): void {
    this.release?.();
    this.release = null;
  }

  async generate(history: readonly ReplyTurn[], _signal?: AbortSignal, correction?: string, currentTurn?: readonly string[]): Promise<string | null> {
    this.histories.push([...history]);
    this.currentTurns.push(currentTurn);
    this.corrections.push(correction);
    const hold = this.hold;
    this.hold = null;
    if (hold) await hold;
    const failure = this.failures.shift();
    if (failure) throw new ReplyGenerationError(failure);
    const scripted = this.scripted.shift();
    if (scripted !== undefined) return scripted;
    this.count += 1;
    return `Thanks for your message (${this.count}).`;
  }
}

let nextUpdateId = 920_000_001;
let nextMessageId = 100;

export interface IncomingOptions {
  /** Telegram's chat type; business chats are `private`. */
  chatType?: string;
  /** The sender's user ID; the chat ID by default, as in a private chat. */
  fromId?: number;
  /** Whether the sender is a bot. */
  fromBot?: boolean;
}

/** A contact's business message, with Telegram's date (whole seconds) taken from `sentAtMs`. */
export function incoming(chatId: number, text: string, sentAtMs: number, options: IncomingOptions = {}): RawUpdate {
  const from = { id: options.fromId ?? chatId, is_bot: options.fromBot ?? false, first_name: 'Test', last_name: `Contact ${Math.abs(chatId) % 1000}` };
  return {
    update_id: nextUpdateId++,
    business_message: {
      message_id: nextMessageId++,
      date: Math.floor(sentAtMs / MS_PER_SECOND),
      chat: { id: chatId, type: options.chatType ?? 'private', first_name: 'Test', last_name: `Contact ${Math.abs(chatId) % 1000}` },
      from,
      business_connection_id: CONNECTION_ID,
      text,
    },
  };
}

/** The contact deleting messages, as Telegram reports it. */
export function deletion(chatId: number, messageIds: number[]): RawUpdate {
  return {
    update_id: nextUpdateId++,
    deleted_business_messages: {
      business_connection_id: CONNECTION_ID,
      chat: { id: chatId, type: 'private', first_name: 'Test', last_name: `Contact ${chatId % 1000}` },
      message_ids: messageIds,
    },
  };
}

/** Telegram's own copy of a reply the bot sent: from the owner, with sender_business_bot set. */
export function echoOf(sent: SentMessage): RawUpdate {
  return {
    update_id: nextUpdateId++,
    business_message: {
      message_id: sent.message_id,
      date: sent.date,
      chat: { id: sent.chat.id, type: 'private', first_name: 'Test', last_name: `Contact ${sent.chat.id % 1000}` },
      from: { id: OWNER_ID, is_bot: false, first_name: 'Test', last_name: 'Owner' },
      sender_business_bot: { id: BOT_ID, is_bot: true, first_name: 'Test Bot', username: 'mirsad_test_bot' },
      business_connection_id: CONNECTION_ID,
      text: sent.text,
    },
  };
}

export interface StandIns {
  eraser?: TelegramEraser;
  api: StubBotApi;
  sender: RecordingSender;
  generator: ScriptedGenerator;
  clock: FakeClock;
}

export const standIns = (clock: FakeClock = new FakeClock()): StandIns => ({
  api: new StubBotApi(),
  sender: new RecordingSender(clock),
  generator: new ScriptedGenerator(),
  clock,
});

export interface DataDir {
  dataDir: string;
  /** Officer A's API token. */
  token: string;
}

/** A data directory with one workspace, Officer A and the live connector provisioned. */
export function provisionDataDir(): DataDir {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-live-'));
  const seed = openDatabase(path.join(dataDir, DATABASE_FILE));
  try {
    const token = seed.transaction((tx) => {
      const workspace = provisionWorkspace(tx, { name: 'Test Workspace' });
      return provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'officer', displayName: 'Officer A' }).token;
    });
    provisionLiveConnector(seed, { ownerUserId: String(OWNER_ID), officers: ['Officer A'] });
    return { dataDir, token };
  } finally {
    seed.close();
  }
}

/** One running app with its stand-ins, and the API calls the tests make as Officer A. */
export class Harness {
  private dispatchKey = 0;
  private closed = false;

  private constructor(
    readonly app: App,
    readonly url: string,
    readonly data: DataDir,
    readonly stand: StandIns,
    readonly logs: string[],
  ) {}

  /** Starts an app on `data` (a new data directory unless given, so a test can restart on the same one). */
  static async start(env: Record<string, string>, stand: StandIns, data: DataDir = provisionDataDir(), useConfiguredModel = false): Promise<Harness> {
    const logs: string[] = [];
    const config = loadConfig({ MIRSAD_PORT: '0', MIRSAD_DATA_DIR: data.dataDir, MIRSAD_DEMO_SEED: 'false', MIRSAD_REVIEWER: 'deterministic', ...env });
    const app = await createApp({
      config,
      clock: stand.clock,
      logger: createJsonLogger({ write: (line) => logs.push(line), clock: stand.clock }),
      telegramBotApi: stand.api,
      telegramBotSender: stand.sender,
      ...(stand.eraser && { telegramEraser: stand.eraser }),
      ...(useConfiguredModel ? {} : { replyGenerator: stand.generator }),
      aiReplyPollIntervalMs: NO_POLL_MS,
    });
    const { url } = await app.listen();
    return new Harness(app, url, data, stand, logs);
  }

  /** Stops the app and keeps its data, for a restart. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.app.close();
  }

  /** Stops the app (if it still runs) and deletes its data. */
  async stop(): Promise<void> {
    await this.close();
    fs.rmSync(this.data.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  async call(method: 'GET' | 'POST', route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Json> {
    const res = await fetch(this.url + route, {
      method,
      headers: { authorization: `Bearer ${this.data.token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (await res.json()) as Json;
  }

  async chats(): Promise<Json[]> {
    return (await this.call('GET', '/v1/chats?limit=500')).data.chats as Json[];
  }

  async chatFor(externalChatId: number): Promise<Json | undefined> {
    return (await this.chats()).find((c) => c.externalChatId === String(externalChatId));
  }

  async timelineOf(externalChatId: number): Promise<Json> {
    const chat = await this.chatFor(externalChatId);
    if (!chat) throw new Error(`no chat ${externalChatId}`);
    return (await this.call('GET', `/v1/chats/${chat.id}/timeline`)).data as Json;
  }

  /**
   * Queues one incoming message, sent now on the test clock unless `sentAtMs` says otherwise, and waits until it is
   * stored, then advances the fake clock beyond the quiet period. Use deliver() to control timing explicitly.
   */
  async receive(externalChatId: number, text: string, sentAtMs: number = this.stand.clock.now().getTime()): Promise<Json> {
    const update = incoming(externalChatId, text, sentAtMs);
    this.stand.api.queue(update);
    let stored: Json | undefined;
    await vi.waitFor(async () => {
      expect(await this.chatFor(externalChatId)).toBeDefined();
      const messages = (await this.timelineOf(externalChatId)).messages as Json[];
      stored = messages.find((m) => m.direction === 'incoming' && m.text === text);
      expect(stored).toBeDefined();
    }, WAIT);
    this.stand.clock.advance(3_000);
    return { ...(stored as Json), telegramMessageId: (update.business_message as Json).message_id };
  }

  /** Queues updates and waits until the connector has logged a batch for them. */
  async deliver(...updates: RawUpdate[]): Promise<void> {
    const batches = this.logs.filter((l) => l.includes('"event":"telegram_live_batch"')).length;
    this.stand.api.queue(...updates);
    await vi.waitFor(() => expect(this.logs.filter((l) => l.includes('"event":"telegram_live_batch"')).length).toBeGreaterThan(batches), WAIT);
  }

  /** Queues the contact's deletion of one message and waits until the message is marked deleted at the source. */
  async deleteAtSource(externalChatId: number, message: Json): Promise<void> {
    this.stand.api.queue(deletion(externalChatId, [message.telegramMessageId as number]));
    await vi.waitFor(async () => {
      const messages = (await this.timelineOf(externalChatId)).messages as Json[];
      expect(messages.find((m) => m.id === message.id)?.deletedAtSource).toBe(true);
    }, WAIT);
  }

  async dispatch(externalChatId: number): Promise<void> {
    const chat = await this.chatFor(externalChatId);
    const answer = await this.call('POST', '/v1/dispatches', { chatIds: [chat?.id] }, { 'Idempotency-Key': `live-test-${this.dispatchKey++}` });
    expect(answer.data.results[0].status).toBe('started');
  }

  async control(externalChatId: number, action: 'pause' | 'take_over' | 'resume'): Promise<void> {
    const chat = await this.chatFor(externalChatId);
    const answer = await this.call('POST', `/v1/chats/${chat?.id}/control`, { action, expectedRevision: chat?.revision });
    expect(answer.success, JSON.stringify(answer.error)).toBe(true);
  }

  async caseActionsOf(externalChatId: number, type: string): Promise<Json[]> {
    return ((await this.timelineOf(externalChatId)).caseActions as Json[]).filter((a) => a.type === type);
  }

  /** Whether a log line has this event and every fragment. */
  logged(event: string, ...fragments: string[]): boolean {
    return this.logs.some((line) => line.includes(`"event":"${event}"`) && fragments.every((f) => line.includes(f)));
  }
}
