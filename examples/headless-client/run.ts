/**
 * Headless reference client: registers a chat, dispatches it, submits one inbound event, reads the timeline and
 * takes over, using nothing but HTTP. It imports nothing from src/, so it shows exactly what another platform needs.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_DATA_DIR = './data';
const CREDENTIALS_FILE = 'demo-credentials.json';
const DEMO_OFFICER_ACCOUNT = 'tg-demo-officer';
const DEFAULT_EXTERNAL_CHAT_ID = 'host-conversation-1001';
const OFFICER_TOKEN_LABEL = '<officer token>';
const CONNECTOR_TOKEN_LABEL = '<connector token>';

export interface ExampleOptions {
  baseUrl: string;
  officerToken: string;
  connectorToken: string;
  fetch?: typeof fetch;
  /** The officer's channel account; defaults to the demo seed's. */
  externalAccountId?: string;
  /** The host's own conversation ID; defaults to a fixed example value. */
  externalChatId?: string;
}

export interface Exchange {
  name: string;
  method: 'GET' | 'POST';
  /** The route as documented, for example `/v1/chats/{chatId}/events`. */
  pathTemplate: string;
  /** The path actually requested. */
  path: string;
  /** Header names are lower-case; token values are replaced by a label. */
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  response: { status: number; body: unknown };
}

export interface ExampleTrace {
  exchanges: Exchange[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads `body.data.<key...>`; throws a message naming the step when the service answered something else. */
function dig(step: string, body: unknown, ...keys: string[]): unknown {
  let current: unknown = isRecord(body) ? body.data : undefined;
  for (const key of keys) {
    if (!isRecord(current)) throw new Error(`${step}: response has no data.${keys.join('.')}`);
    current = current[key];
  }
  if (current === undefined) throw new Error(`${step}: response has no data.${keys.join('.')}`);
  return current;
}

const text = (step: string, body: unknown, ...keys: string[]): string => {
  const value = dig(step, body, ...keys);
  if (typeof value !== 'string') throw new Error(`${step}: data.${keys.join('.')} is not a string`);
  return value;
};

const count = (step: string, body: unknown, ...keys: string[]): number => {
  const value = dig(step, body, ...keys);
  if (typeof value !== 'number') throw new Error(`${step}: data.${keys.join('.')} is not a number`);
  return value;
};

interface Call {
  name: string;
  method: 'GET' | 'POST';
  pathTemplate: string;
  path: string;
  token: string;
  tokenLabel: string;
  body?: unknown;
  headers?: Record<string, string>;
  expectStatus: number;
}

async function exchange(options: ExampleOptions, call: Call): Promise<Exchange> {
  const doFetch = options.fetch ?? fetch;
  const requestHeaders: Record<string, string> = { ...call.headers };
  if (call.body !== undefined) requestHeaders['content-type'] = 'application/json';
  const res = await doFetch(options.baseUrl + call.path, {
    method: call.method,
    headers: { ...requestHeaders, authorization: `Bearer ${call.token}` },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const raw = await res.text();
  const body: unknown = raw ? JSON.parse(raw) : null;
  if (res.status !== call.expectStatus) {
    const code = isRecord(body) && isRecord(body.error) ? String(body.error.code) : 'unknown';
    throw new Error(`${call.name}: expected ${call.expectStatus}, got ${res.status} (${code})`);
  }
  const recorded: Exchange = {
    name: call.name,
    method: call.method,
    pathTemplate: call.pathTemplate,
    path: call.path,
    requestHeaders: { ...requestHeaders, authorization: `Bearer ${call.tokenLabel}` },
    response: { status: res.status, body },
  };
  return call.body === undefined ? recorded : { ...recorded, requestBody: call.body };
}

type Credential = Pick<Call, 'token' | 'tokenLabel'>;

const officerOf = (options: ExampleOptions): Credential => ({ token: options.officerToken, tokenLabel: OFFICER_TOKEN_LABEL });
const connectorOf = (options: ExampleOptions): Credential => ({ token: options.connectorToken, tokenLabel: CONNECTOR_TOKEN_LABEL });

/** Step 1: register the host conversation; the answer carries the chat ID every later step uses. */
const registerChat = (options: ExampleOptions): Call => ({
  ...officerOf(options),
  name: 'register_chat',
  method: 'POST',
  pathTemplate: '/v1/chats',
  path: '/v1/chats',
  body: {
    source: 'telegram',
    externalAccountId: options.externalAccountId ?? DEMO_OFFICER_ACCOUNT,
    externalChatId: options.externalChatId ?? DEFAULT_EXTERNAL_CHAT_ID,
    displayLabel: 'Test Contact',
  },
  expectStatus: 201,
});

/** Step 2: start AI review; the Idempotency-Key makes a retry safe. */
const dispatch = (options: ExampleOptions, chatId: string): Call => ({
  ...officerOf(options),
  name: 'dispatch',
  method: 'POST',
  pathTemplate: '/v1/dispatches',
  path: '/v1/dispatches',
  headers: { 'idempotency-key': randomUUID() },
  body: { chatIds: [chatId] },
  expectStatus: 200,
});

/** Step 3: report one incoming message, with the connector's credential. */
const submitInboundEvent = (options: ExampleOptions, chatId: string): Call => ({
  ...connectorOf(options),
  name: 'submit_inbound_event',
  method: 'POST',
  pathTemplate: '/v1/chats/{chatId}/events',
  path: `/v1/chats/${chatId}/events`,
  body: {
    type: 'message.recorded',
    sourceEventId: 'host-event-1',
    sourceMessageId: 'host-message-1',
    direction: 'incoming',
    text: 'Hello, is this the right number for my order?',
  },
  expectStatus: 201,
});

/** Step 4: read the timeline; its chat revision is what step 5 expects. */
const fetchTimeline = (options: ExampleOptions, chatId: string): Call => ({
  ...officerOf(options),
  name: 'fetch_timeline',
  method: 'GET',
  pathTemplate: '/v1/chats/{chatId}/timeline',
  path: `/v1/chats/${chatId}/timeline`,
  expectStatus: 200,
});

/** Step 5: take over at the revision the timeline reported. */
const takeOver = (options: ExampleOptions, chatId: string, expectedRevision: number): Call => ({
  ...officerOf(options),
  name: 'take_over',
  method: 'POST',
  pathTemplate: '/v1/chats/{chatId}/control',
  path: `/v1/chats/${chatId}/control`,
  body: { action: 'take_over', expectedRevision },
  expectStatus: 200,
});

export async function runExample(options: ExampleOptions): Promise<ExampleTrace> {
  const exchanges: Exchange[] = [];
  const run = async (call: Call): Promise<Exchange> => {
    const done = await exchange(options, call);
    exchanges.push(done);
    return done;
  };
  const registered = await run(registerChat(options));
  const chatId = text('register_chat', registered.response.body, 'chat', 'id');
  await run(dispatch(options, chatId));
  await run(submitInboundEvent(options, chatId));
  const timeline = await run(fetchTimeline(options, chatId));
  await run(takeOver(options, chatId, count('fetch_timeline', timeline.response.body, 'chat', 'revision')));
  return { exchanges };
}

function credentialsFromFile(): { officer: string; connector: string } {
  const file = path.join(process.env.MIRSAD_DATA_DIR ?? DEFAULT_DATA_DIR, CREDENTIALS_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`no tokens: set MIRSAD_OFFICER_TOKEN and MIRSAD_CONNECTOR_TOKEN, or start Mirsad once so ${file} exists`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const officers = isRecord(parsed) && Array.isArray(parsed.officers) ? parsed.officers : [];
  const first: unknown = officers[0];
  const officer = isRecord(first) ? first.token : undefined;
  const connector = isRecord(parsed) && isRecord(parsed.connector) ? parsed.connector.token : undefined;
  if (typeof officer !== 'string' || typeof connector !== 'string') throw new Error(`${file} has no officer and connector tokens`);
  return { officer, connector };
}

function resolveCredentials(): { officer: string; connector: string } {
  const officer = process.env.MIRSAD_OFFICER_TOKEN;
  const connector = process.env.MIRSAD_CONNECTOR_TOKEN;
  if (officer && connector) return { officer, connector };
  const fromFile = credentialsFromFile();
  return { officer: officer ?? fromFile.officer, connector: connector ?? fromFile.connector };
}

/** One line per step: the status and IDs only, never message text. */
function describeStep(e: Exchange): string {
  const data = isRecord(e.response.body) && isRecord(e.response.body.data) ? e.response.body.data : {};
  const chat = isRecord(data.chat) ? data.chat : data;
  const ids = [
    ['chatId', chat.id ?? data.chatId],
    ['dispatchId', data.dispatchId],
    ['messageId', data.messageId],
    ['revision', chat.revision],
    ['aiMode', chat.aiMode],
  ]
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${String(k)}=${String(v)}`);
  return [`${e.name}`, `${e.method} ${e.pathTemplate}`, String(e.response.status), ...ids].join('  ');
}

async function main(): Promise<void> {
  const credentials = resolveCredentials();
  const trace = await runExample({
    baseUrl: process.env.MIRSAD_BASE_URL ?? DEFAULT_BASE_URL,
    officerToken: credentials.officer,
    connectorToken: credentials.connector,
    // A fresh conversation per run, so the example can be repeated against the same demo data.
    externalChatId: `host-conversation-${Date.now().toString(36)}`,
  });
  process.stdout.write(`${trace.exchanges.map(describeStep).join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`example failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
