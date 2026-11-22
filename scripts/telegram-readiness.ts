/**
 * `npm run telegram:readiness`: the eight local readiness checks of design section 13, run against a temporary Mirsad
 * instance (temporary data directory, demo seed, deterministic reviewer) with the synthetic fixtures, through HTTP.
 * Writes docs/telegram/readiness.json (IDs, results and counts only) and docs/telegram/readiness.md. The state is
 * `ready_for_controlled_test` only when every check passes; live capture and real reply delivery stay pending.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { replayFixture, type ReplayReport } from '../src/adapters/replay.ts';
import type { BotApi } from '../src/adapters/telegram/bot-api.ts';
import { createLiveConnector, LIVE_GATES, LiveConnectorGateError } from '../src/adapters/telegram/live-connector.ts';
import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { LABELS } from '../src/contract/labels.ts';
import { Timeline, type Capture } from '../src/contract/schemas.ts';
import { DEMO_ACCOUNTS, DEMO_CREDENTIALS_FILE } from '../src/identity/seed.ts';
import { createJsonLogger } from '../src/logging/json-logger.ts';
import { READINESS_CHECK_IDS, type ReadinessCheckId, type ReadinessRecord } from '../src/services/status.ts';
import { DATABASE_FILE, openDatabase } from '../src/storage/db.ts';

const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL('../docs/telegram/', import.meta.url));
const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../fixtures/telegram/', import.meta.url));
const FIXTURE_ACCOUNTS = { intake: DEMO_ACCOUNTS.intake.externalAccountId, officer: DEMO_ACCOUNTS.officer.externalAccountId };
/**
 * Settings for the gate check. The token is a well-formed placeholder, not a real token: no Bot API call is ever made,
 * and a malformed value would itself count as a missing gate.
 */
const GATE_SETTINGS: Record<string, string> = {
  TELEGRAM_LIVE_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '0000000000:READINESS_PLACEHOLDER_NOT_A_TOKEN',
  TELEGRAM_APPROVED_CONNECTION_ID: 'ReadinessBizConn-0000',
  TELEGRAM_APPROVED_CHAT_IDS: '6000000901',
  TELEGRAM_APPROVAL_REFERENCE: 'READINESS-LOCAL-CHECK',
};
const silentLogger = createJsonLogger({ write: () => undefined });

const credentialsSchema = z.object({ officers: z.array(z.object({ token: z.string() })).min(1), connector: z.object({ token: z.string() }) });
/** The few fixture facts the checks compare against (the replay itself validates the whole file). */
const fixtureFacts = z.looseObject({
  businessUserId: z.number(),
  updates: z.array(z.looseObject({ business_message: z.looseObject({ text: z.string().optional(), from: z.looseObject({ id: z.number() }).optional() }).optional() })),
});

interface RunContext {
  app: App;
  baseUrl: string;
  dataDir: string;
  fixturesDir: string;
  officerToken: string;
  connectorToken: string;
}

interface CheckResult {
  passed: boolean;
  detail: string;
}

class ReadinessHttpError extends Error {
  constructor(status: number, code: string) {
    super(`HTTP ${status} ${code}`);
    this.name = 'ReadinessHttpError';
  }
}

async function call(ctx: RunContext, method: 'GET' | 'POST', route: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(ctx.baseUrl + route, {
    method,
    headers: { authorization: `Bearer ${ctx.officerToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = (await response.json()) as { data?: unknown; error?: { code?: string } | null };
  if (!response.ok) throw new ReadinessHttpError(response.status, envelope.error?.code ?? 'unknown');
  return envelope.data;
}

const timelineOf = async (ctx: RunContext, chatId: string): Promise<Timeline> => Timeline.parse(await call(ctx, 'GET', `/v1/chats/${chatId}/timeline`));
const readFixture = (ctx: RunContext, name: string): unknown => JSON.parse(fs.readFileSync(path.join(ctx.fixturesDir, `${name}.json`), 'utf8'));

function replay(ctx: RunContext, name: string): Promise<ReplayReport> {
  return replayFixture(readFixture(ctx, name), { baseUrl: ctx.baseUrl, connectorToken: ctx.connectorToken, accounts: FIXTURE_ACCOUNTS });
}

const chatIdsOf = (report: ReplayReport): string[] => [...new Set(report.events.map((e) => e.chatId).filter((id): id is string => id !== null))];

function firstChat(report: ReplayReport): string {
  const [chatId] = chatIdsOf(report);
  if (!chatId) throw new Error('fixture_produced_no_chat');
  return chatId;
}

async function inboundFirst(ctx: RunContext): Promise<CheckResult> {
  const { chat } = await timelineOf(ctx, firstChat(await replay(ctx, 'inbound-first-greeting')));
  const passed = chat.inboxStatus === 'new_inbound' && chat.originLabel === LABELS.firstObservedIncoming;
  return { passed, detail: `inbox status ${chat.inboxStatus}; origin label ${chat.originLabel}` };
}

async function officerFirst(ctx: RunContext): Promise<CheckResult> {
  const timeline = await timelineOf(ctx, firstChat(await replay(ctx, 'officer-first')));
  const directions = timeline.messages.map((m) => m.direction ?? 'unknown');
  const passed = directions[0] === 'outgoing' && directions.includes('incoming') && timeline.chat.originLabel === LABELS.firstObservedOutgoing;
  return { passed, detail: `${directions.length} messages, directions ${directions.join(', ')}; origin label ${timeline.chat.originLabel}` };
}

/** Replays every fixture, lets the capture worker finish, then expects one ready capture per received message and edit. */
async function capturePerMessage(ctx: RunContext): Promise<CheckResult> {
  const names = fs.readdirSync(ctx.fixturesDir).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')).sort();
  const chatIds = new Set<string>();
  for (const name of names) chatIdsOf(await replay(ctx, name)).forEach((id) => chatIds.add(id));
  await ctx.app.drain();
  const captures: (Capture | null)[] = [];
  let edits = 0;
  for (const chatId of chatIds) {
    const timeline = await timelineOf(ctx, chatId);
    const received = timeline.messages.filter((m) => m.origin === 'source' && m.originalCaptured && ((m.text ?? '') !== '' || m.unsupportedContent.length > 0));
    const changed = timeline.messageEvents.filter((e) => e.type !== 'deleted' && (e.text ?? '') !== '');
    edits += changed.length;
    captures.push(...received.map((m) => m.capture), ...changed.map((e) => e.capture));
  }
  const ready = captures.filter((c): c is Capture => c?.status === 'ready' && c.artifactId !== null);
  const distinct = new Set(ready.map((c) => c.id)).size === ready.length && new Set(ready.map((c) => c.artifactId)).size === ready.length;
  const passed = captures.length > 0 && ready.length === captures.length && distinct;
  const editCount = `${edits} ${edits === 1 ? 'edit' : 'edits'}`;
  return { passed, detail: `${captures.length - edits} received messages and ${editCount} in ${chatIds.size} chats; ${ready.length} distinct ready captures` };
}

async function editAndDelete(ctx: RunContext): Promise<CheckResult> {
  const original = fixtureFacts.parse(readFixture(ctx, 'edit-and-delete')).updates[0]?.business_message?.text;
  const timeline = await timelineOf(ctx, firstChat(await replay(ctx, 'edit-and-delete')));
  const [message] = timeline.messages;
  const types = timeline.messageEvents.map((e) => e.type);
  const unchanged = message?.text === original;
  const passed = timeline.messages.length === 1 && unchanged && types.includes('edited') && types.includes('deleted');
  return { passed, detail: `${timeline.messages.length} message; separate events ${types.join(', ')}; original text ${unchanged ? 'unchanged' : 'changed'}` };
}

async function redelivery(ctx: RunContext): Promise<CheckResult> {
  const chatIds = chatIdsOf(await replay(ctx, 'takeover-pair'));
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(chatIds.map(async (id) => {
        const t = await timelineOf(ctx, id);
        return [t.messages.map((m) => [m.id, m.capture?.id ?? null]), t.messageEvents.map((e) => e.id)];
      })),
    );
  const before = await snapshot();
  const again = await replay(ctx, 'takeover-pair');
  const duplicates = again.events.filter((e) => e.status === 200 && e.result === 'duplicate_event').length;
  const unchanged = (await snapshot()) === before;
  const passed = again.events.length > 0 && duplicates === again.events.length && unchanged;
  return { passed, detail: `${duplicates} of ${again.events.length} redelivered updates answered duplicate_event; ${chatIds.length} chats ${unchanged ? 'unchanged' : 'changed'}` };
}

async function outgoingLabelled(ctx: RunContext): Promise<CheckResult> {
  const facts = fixtureFacts.parse(readFixture(ctx, 'payment-destination-change'));
  const sentByOwner = facts.updates.filter((u) => u.business_message?.from?.id === facts.businessUserId).length;
  const timeline = await timelineOf(ctx, firstChat(await replay(ctx, 'payment-destination-change')));
  const outgoing = timeline.messages.filter((m) => m.direction === 'outgoing');
  const passed = sentByOwner > 0 && outgoing.length === sentByOwner && outgoing.every((m) => m.capture !== null);
  return { passed, detail: `${outgoing.length} of ${sentByOwner} owner-sent messages arrived labelled outgoing, each with a capture; ${timeline.messages.length - outgoing.length} incoming` };
}

async function takeoverSimulatedSend(ctx: RunContext): Promise<CheckResult> {
  const chatId = firstChat(await replay(ctx, 'takeover-pair'));
  const { chat } = await timelineOf(ctx, chatId);
  const taken = z.object({ chat: z.object({ revision: z.number() }) }).parse(
    await call(ctx, 'POST', `/v1/chats/${chatId}/control`, { action: 'take_over', expectedRevision: chat.revision }),
  );
  const reply = { text: LABELS.acknowledgementTemplate, expectedRevision: taken.chat.revision };
  await call(ctx, 'POST', `/v1/chats/${chatId}/officer-messages`, reply, { 'Idempotency-Key': `readiness-${randomUUID()}` });
  const after = await timelineOf(ctx, chatId);
  const composed = after.messages.filter((m) => m.origin === 'officer_composer');
  const sent = composed[0];
  const passed = after.chat.aiMode === 'officer_control' && composed.length === 1 && sent?.sendStatus === 'simulated' && sent.sendStatusLabel === LABELS.simulatedSend;
  return { passed, detail: `AI mode ${after.chat.aiMode}; ${composed.length} composer message recorded as ${sent?.sendStatusLabel ?? 'nothing'}; nothing delivered to Telegram` };
}

/** A Bot API that records and refuses every call: the gate check must make none. */
function refusingBotApi(calls: string[]): BotApi {
  const refuse = <T>(method: string): Promise<T> => {
    calls.push(method);
    return Promise.reject(new Error('readiness_check_makes_no_bot_api_calls'));
  };
  return { getMe: () => refuse('getMe'), getWebhookInfo: () => refuse('getWebhookInfo'), getBusinessConnection: () => refuse('getBusinessConnection'), getUpdates: () => refuse('getUpdates') };
}

async function liveConnectorGated(ctx: RunContext): Promise<CheckResult> {
  const db = openDatabase(path.join(ctx.dataDir, DATABASE_FILE));
  const calls: string[] = [];
  const refusal = async (overrides: Record<string, string>): Promise<readonly string[]> => {
    const config = loadConfig({ MIRSAD_DATA_DIR: ctx.dataDir, MIRSAD_DEMO_SEED: 'false', MIRSAD_REVIEWER: 'deterministic', ...GATE_SETTINGS, ...overrides });
    const connector = createLiveConnector({ config, db, logger: silentLogger, botApi: refusingBotApi(calls) });
    try {
      connector.start();
    } catch (error) {
      if (error instanceof LiveConnectorGateError) return error.missing;
      throw error;
    }
    await connector.stop();
    return [];
  };
  // The temporary instance has no provisioned telegram_business_live connector, so every refusal also names it.
  const exactly = (missing: readonly string[], expected: readonly string[]): boolean =>
    missing.length === expected.length && expected.every((gate, i) => missing[i] === gate);
  try {
    const settings = Object.keys(GATE_SETTINGS);
    let eachRefused = true;
    for (const name of settings) {
      const missing = await refusal({ [name]: name === LIVE_GATES.enabled ? 'false' : '' });
      eachRefused = eachRefused && exactly(missing, [name, LIVE_GATES.principal]);
    }
    const unprovisioned = exactly(await refusal({}), [LIVE_GATES.principal]);
    const passed = eachRefused && unprovisioned && calls.length === 0;
    return { passed, detail: `each of ${settings.length} settings and the provisioned connector principal named when missing; ${calls.length} Bot API calls made` };
  } finally {
    db.close();
  }
}

const CHECKS: Record<ReadinessCheckId, { title: string; run: (ctx: RunContext) => Promise<CheckResult> }> = {
  inbound_first_new_inbound: { title: 'An inbound-first chat is flagged New inbound', run: inboundFirst },
  officer_first_both_directions: { title: 'An officer-first chat shows both directions', run: officerFirst },
  capture_per_message: { title: 'Every received message has its own capture', run: capturePerMessage },
  edit_delete_separate_events: { title: 'An edit and a deletion are separate events and the original stays', run: editAndDelete },
  redelivery_creates_nothing: { title: 'A redelivered update creates nothing new', run: redelivery },
  outgoing_labelled_outgoing: { title: 'Officer-sent fixture messages arrive and are labelled outgoing', run: outgoingLabelled },
  takeover_simulated_send: { title: 'A takeover followed by a composer reply is recorded as Simulated send', run: takeoverSimulatedSend },
  live_connector_gated: { title: 'The live connector refuses to start without its gates', run: liveConnectorGated },
};

async function runCheck(ctx: RunContext, id: ReadinessCheckId): Promise<ReadinessRecord['checks'][number]> {
  const { title, run } = CHECKS[id];
  try {
    return { id, title, ...(await run(ctx)) };
  } catch (error) {
    const reason = error instanceof ReadinessHttpError ? error.message : error instanceof Error ? error.name : 'unknown error';
    return { id, title, passed: false, detail: `the check could not complete: ${reason}` };
  }
}

function renderMarkdown(record: ReadinessRecord): string {
  const ready = record.state === 'ready_for_controlled_test';
  const reply = record.checks.find((c) => c.id === 'takeover_simulated_send');
  return [
    '# Telegram readiness',
    '',
    `State: ${ready ? `**${LABELS.readyForControlledTest}** (\`ready_for_controlled_test\`)` : '**Not ready** (`not_ready`): at least one local check failed.'}`,
    '',
    `Recorded at: ${record.recordedAt}`,
    '',
    'Written by `npm run telegram:readiness`. It runs the local checks of design section 13 against a temporary Mirsad instance (temporary data directory, demo seed, deterministic reviewer) using only the synthetic fixtures in `fixtures/telegram/`, through the HTTP API. This run can never report `Controlled test verified`: that needs a controlled-test record written after an approved live test (see `setup.md`).',
    '',
    '## Fixture replay',
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...record.checks.map((c) => `| ${c.title} | ${c.passed ? 'passed' : 'FAILED'} | ${c.detail} |`),
    '',
    '## Live capture',
    '',
    "Pending: needs the account owner's approval of explicitly scoped test chats and test credentials. Until then the live connector stays disabled (`TELEGRAM_LIVE_ENABLED=false`). Record what the approved test covers in `event-coverage-worksheet.md` and in the controlled-test record.",
    '',
    '## Manual officer reply',
    '',
    `Simulated send verified locally: check \`takeover_simulated_send\` ${reply?.passed ? 'passed' : 'did not pass'}. Real delivery from the composer is pending an approved host integration for the channel; Mirsad has no code path that sends to Telegram.`,
    '',
  ].join('\n');
}

export interface ReadinessOptions {
  /** Where readiness.json and readiness.md are written; defaults to docs/telegram. */
  outputDir?: string;
  /** Defaults to fixtures/telegram. */
  fixturesDir?: string;
  now?: () => Date;
}

export async function runReadiness(options: ReadinessOptions = {}): Promise<ReadinessRecord> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-readiness-'));
  const config = loadConfig({ MIRSAD_PORT: '0', MIRSAD_DATA_DIR: dataDir, MIRSAD_DEMO_SEED: 'true', MIRSAD_REVIEWER: 'deterministic' });
  const app = await createApp({ config, logger: silentLogger });
  try {
    const { url } = await app.listen();
    const credentials = credentialsSchema.parse(JSON.parse(fs.readFileSync(path.join(dataDir, DEMO_CREDENTIALS_FILE), 'utf8')));
    const ctx: RunContext = {
      app, baseUrl: url, dataDir,
      fixturesDir: options.fixturesDir ?? DEFAULT_FIXTURES_DIR,
      officerToken: credentials.officers[0]?.token ?? '',
      connectorToken: credentials.connector.token,
    };
    const checks: ReadinessRecord['checks'] = [];
    for (const id of READINESS_CHECK_IDS) checks.push(await runCheck(ctx, id));
    const state: ReadinessRecord['state'] = checks.every((c) => c.passed) ? 'ready_for_controlled_test' : 'not_ready';
    const record: ReadinessRecord = { state, recordedAt: (options.now ?? (() => new Date()))().toISOString(), checks };
    const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'readiness.json'), `${JSON.stringify(record, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'readiness.md'), renderMarkdown(record));
    return record;
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runReadiness().then(
    (record) => {
      const lines = record.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'}  ${c.id}  ${c.detail}`);
      const state = record.state === 'ready_for_controlled_test' ? `${LABELS.readyForControlledTest} (ready_for_controlled_test)` : 'not ready';
      process.stdout.write(`${lines.join('\n')}\nState: ${state}\nWrote docs/telegram/readiness.json and docs/telegram/readiness.md\n`);
      process.exitCode = record.state === 'ready_for_controlled_test' ? 0 : 1;
    },
    (error: unknown) => {
      process.stderr.write(`telegram:readiness failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
      process.exitCode = 1;
    },
  );
}
