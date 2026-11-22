/**
 * `npm run demo:walkthrough -- [--reviewer deterministic|lmstudio|disabled] [--keep]`: proves the demo flow on a clean
 * start. It starts a fresh Mirsad instance in-process on an ephemeral loopback port, with a temporary data directory and
 * the demo seed, replays the synthetic Telegram fixtures with `replayFixture`, and checks the officer workflow in order
 * through the HTTP API and the event stream only. It prints one line per check (PASS or FAIL with IDs and counts, never
 * message text) and exits 1 when any check fails. `--keep` leaves the data directory and prints its sign-in links.
 *
 * With the local model the timelines are polled until reviews settle, up to a generous limit; when the model does not
 * answer, review is reported unavailable instead of the walkthrough waiting forever.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { replayFixture, type ReplayReport } from '../src/adapters/replay.ts';
import { telegramFixtureSchema, type TelegramFixture } from '../src/adapters/telegram/fixture-schema.ts';
import { createApp, type App } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { REVIEWER_KINDS, type ReviewerKind } from '../src/contract/enums.ts';
import { LABELS } from '../src/contract/labels.ts';
import {
  CaseReferenceResponse, ControlResponse, DispatchResponse, HealthResponse, ListChatsResponse, ListWatchlistResponse,
  OfficerDecisionResponse, OfficerMessageResponse, Status, Timeline, WatchlistReviewResponse,
  type Capture, type ChatSummary, type WatchlistEntry,
} from '../src/contract/schemas.ts';
import type { StreamWireMessage } from '../src/contract/stream-events.ts';
import { createEventStream } from '../src/dashboard/js/stream-client.js';
import { provisionPrincipal, provisionWorkspace } from '../src/identity/provision.ts';
import { DEMO_ACCOUNTS } from '../src/identity/seed.ts';
import { createJsonLogger } from '../src/logging/json-logger.ts';
import { DATABASE_FILE, openDatabase } from '../src/storage/db.ts';
import { dashboardBaseUrl, readDemoCredentials, signInLines } from './demo-credentials.ts';
import { isEntryPoint } from './entry-point.ts';

export interface WalkthroughOptions {
  reviewer: ReviewerKind;
  /** Leave the temporary data directory in place (default: remove it). */
  keep?: boolean;
}

export interface WalkthroughStep {
  id: string;
  passed: boolean;
  /** IDs, counts, statuses and fixed labels only, never message text. */
  detail: string;
}

export interface WalkthroughReport {
  reviewer: ReviewerKind;
  passed: boolean;
  exitCode: 0 | 1;
  steps: WalkthroughStep[];
  /** The temporary data directory; it no longer exists unless `kept`. */
  dataDir: string;
  kept: boolean;
  durationMs: number;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'fixtures', 'telegram');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const USAGE = 'usage: npm run demo:walkthrough -- [--reviewer deterministic|lmstudio|disabled] [--keep]';
const EXIT_USAGE = 2;
const ACCOUNTS = { intake: DEMO_ACCOUNTS.intake.externalAccountId, officer: DEMO_ACCOUNTS.officer.externalAccountId };
/** Only the LM Studio settings come from the environment; every other setting is the walkthrough's own. */
const INHERITED_SETTINGS = ['MIRSAD_LMSTUDIO_BASE_URL', 'MIRSAD_LMSTUDIO_MODEL', 'MIRSAD_LMSTUDIO_CONTEXT_TOKENS', 'MIRSAD_LMSTUDIO_TIMEOUT_MS'];
/** How long captures and reviews may take to settle: generous for the local model, short for in-process review. */
const SETTLE_TIMEOUT_MS: Record<ReviewerKind, number> = { lmstudio: 600_000, deterministic: 60_000, disabled: 60_000 };
const POLL_FIRST_MS = 20;
const POLL_MAX_MS = 1_000;
const STREAM_CATCH_UP_MS = 15_000;
const LIST_LIMIT = 500;
const MS_PER_SECOND = 1_000;
/** A Telegram chat ID no shipped fixture uses, for the copy that asserts a conversation start. */
const START_MARKER_CHAT = 6000000010;
const START_MARKER_CONTACT = 'Contact 10';
/** A derived later message is dated this long after the message it copies. */
const LATER_MESSAGE_DELAY_S = 3_600;
/** watchlist-sequence.json: update 0 is chat A's mention; the updates after it are chat B, the sender. */
const MENTION_UPDATES = 1;
/** takeover-pair.json: update 2 is a routine message in the first chat, copied as the message that arrives under takeover. */
const TAKEOVER_ROUTINE_UPDATE = 2;
/** payment-destination-change.json: five routine messages (three incoming, two outgoing), then one introducing a payment link. */
const PAYMENT_FIXTURE_MESSAGES = 6;
const PAYMENT_ROUTINE_INCOMING = 3;
const PAYMENT_ROUTINE_OUTGOING = 2;
const MERCHANT_HOST = 'pay.merchant.example';
const REASONS = {
  approve: 'Walkthrough: the source message ties the number to a payment request.',
  clear: 'Walkthrough: cleared to show that new evidence does not restore approval.',
  merchant: 'Walkthrough: the merchant confirmed its only payment host.',
};
const silentLogger = createJsonLogger({ write: () => undefined });

type ChatName = 'inboundFirst' | 'officerFirst' | 'startMarker' | 'editDelete' | 'takeoverA' | 'takeoverB' | 'payment'
  | 'watchA' | 'watchB' | 'merchant';
type Method = 'GET' | 'POST';
type Outcome = Pick<WalkthroughStep, 'passed' | 'detail'>;
type StreamObserver = ReturnType<typeof observeStream>;

interface Run {
  config: Config;
  app: App;
  baseUrl: string;
  settleMs: number;
  tokens: { officer: string; connector: string; outsider: string };
  officerId: string;
  snapshotCursor: number;
  observer: StreamObserver;
  chats: Map<ChatName, string>;
  entryId: string | null;
}

/** A failure of the walkthrough itself (an HTTP status and code, or its own code); never content. */
class WalkthroughError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'WalkthroughError';
  }
}

/** A check result whose detail is the non-empty parts joined. */
const outcome = (passed: boolean, ...parts: string[]): Outcome => ({ passed, detail: parts.filter((p) => p !== '').join('; ') });

// ---- HTTP ----

const ErrorBody = z.object({ error: z.object({ code: z.string() }) });
const SuccessBody = z.object({ success: z.literal(true), data: z.unknown() });
const codeOf = (body: unknown): string => ErrorBody.safeParse(body).data?.error.code ?? 'unknown';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface RequestOptions {
  /** Defaults to the acting officer; null sends no Authorization header. */
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

/** `body` is the parsed JSON body, or null for any other content. */
type Reply = { status: number; headers: Headers; bytes: Uint8Array; body: unknown };
/** What a request needs: the instance's address and the acting officer's token. */
type Target = Pick<Run, 'baseUrl' | 'tokens'>;

function parseJson(bytes: Uint8Array, headers: Headers): unknown {
  if (!(headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function send(run: Target, method: Method, route: string, options: RequestOptions = {}): Promise<Reply> {
  const token = options.token === undefined ? run.tokens.officer : options.token;
  const json = options.body === undefined ? {} : { 'content-type': 'application/json' };
  const response = await fetch(run.baseUrl + route, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...json, ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, body: parseJson(bytes, response.headers) };
}

/** The validated `data` of a successful answer; any other answer throws with its status and error code only. */
async function call<T>(run: Target, schema: z.ZodType<T>, method: Method, route: string, options?: RequestOptions): Promise<T> {
  const reply = await send(run, method, route, options);
  if (reply.status >= 300) throw new WalkthroughError(`HTTP ${reply.status} ${codeOf(reply.body)}`);
  return schema.parse(SuccessBody.parse(reply.body).data);
}

const timelineOf = (run: Run, chatId: string): Promise<Timeline> => call(run, Timeline, 'GET', `/v1/chats/${chatId}/timeline`);
const chatsOf = (run: Target, token: string, query = ''): Promise<z.infer<typeof ListChatsResponse>> =>
  call(run, ListChatsResponse, 'GET', `/v1/chats?limit=${LIST_LIMIT}${query}`, { token });
const watchlistOf = async (run: Run): Promise<WatchlistEntry[]> => (await call(run, ListWatchlistResponse, 'GET', '/v1/watchlist')).entries;
const withKey = (body: unknown): RequestOptions => ({ body, headers: { 'Idempotency-Key': `walkthrough-${randomUUID()}` } });
const dispatch = (run: Run, chatIds: string[]): Promise<DispatchResponse> =>
  call(run, DispatchResponse, 'POST', '/v1/dispatches', withKey({ chatIds }));

async function control(run: Run, chatId: string, action: 'pause' | 'take_over' | 'resume', expectedRevision: number): Promise<ChatSummary> {
  return (await call(run, ControlResponse, 'POST', `/v1/chats/${chatId}/control`, { body: { action, expectedRevision } })).chat;
}

async function decide(run: Run, entry: WatchlistEntry, decision: 'approve' | 'clear', reason: string): Promise<WatchlistEntry> {
  const body = { decision, reason, expectedRevision: entry.revision };
  return (await call(run, WatchlistReviewResponse, 'POST', `/v1/watchlist/${entry.id}/review`, { body })).entry;
}

// ---- Fixtures and replay ----

function loadFixture(name: string): TelegramFixture {
  return telegramFixtureSchema.parse(JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8')));
}

/** Replays a fixture through POST /v1/ingest, as `npm run replay` does; a refused event stops the check. */
async function replay(run: Run, fixture: TelegramFixture): Promise<ReplayReport> {
  const report = await replayFixture(fixture, { baseUrl: run.baseUrl, connectorToken: run.tokens.connector, accounts: ACCOUNTS });
  const refused = report.events.find((e) => e.status !== 200 && e.status !== 201);
  if (refused) throw new WalkthroughError(`replay refused: HTTP ${refused.status} ${refused.result}`);
  return report;
}

const chatIdsOf = (report: ReplayReport): string[] => [...new Set(report.events.flatMap((e) => (e.chatId === null ? [] : [e.chatId])))];

function onlyChat(report: ReplayReport): string {
  const [chatId, ...others] = chatIdsOf(report);
  if (!chatId || others.length > 0) throw new WalkthroughError('fixture_chat_count_unexpected');
  return chatId;
}

function chatOf(run: Run, name: ChatName): string {
  const chatId = run.chats.get(name);
  if (!chatId) throw new WalkthroughError(`missing_chat_${name}`);
  return chatId;
}

/** The inbound-first fixture in a chat of its own, carrying the fixture author's start-of-conversation assertion. */
function withConversationStart(fixture: TelegramFixture): TelegramFixture {
  const contact = { id: START_MARKER_CHAT, last_name: START_MARKER_CONTACT };
  const updates = fixture.updates.map((update) => {
    const message = update.business_message;
    if (!message) return update;
    const from = message.from ? { from: { ...message.from, ...contact } } : {};
    return { ...update, business_message: { ...message, ...from, chat: { ...message.chat, ...contact } } };
  });
  const first = updates[0]?.business_message;
  if (!first) throw new WalkthroughError('fixture_has_no_message');
  return { ...fixture, updates, conversationStarts: [{ chatId: START_MARKER_CHAT, messageId: first.message_id }] };
}

/** A later message in the chat of update `index`: the same synthetic content under new update and message IDs. */
function laterMessage(fixture: TelegramFixture, index: number): TelegramFixture {
  const source = fixture.updates[index]?.business_message;
  if (!source) throw new WalkthroughError('fixture_has_no_message');
  const updateId = Math.max(...fixture.updates.map((u) => u.update_id)) + 1;
  const messageId = Math.max(...fixture.updates.flatMap((u) => (u.business_message ? [u.business_message.message_id] : []))) + 1;
  const message = { ...source, message_id: messageId, date: source.date + LATER_MESSAGE_DELAY_S };
  return { ...fixture, updates: [{ update_id: updateId, business_message: message }] };
}

// ---- Settling, reviews and captures ----

function isBusy(timeline: Timeline): boolean {
  return [...timeline.messages, ...timeline.messageEvents].some((item) =>
    item.capture?.status === 'pending' || item.capture?.status === 'rendering'
    || item.review?.status === 'pending' || item.review?.status === 'running');
}

/** Polls the timelines until no capture or review is waiting, or until the settle limit passes. */
async function settled(run: Run, chatIds: string[]): Promise<Timeline[]> {
  const deadline = Date.now() + run.settleMs;
  for (let wait = POLL_FIRST_MS; ; wait = Math.min(wait * 2, POLL_MAX_MS)) {
    const timelines = await Promise.all(chatIds.map((chatId) => timelineOf(run, chatId)));
    if (!timelines.some(isBusy) || Date.now() >= deadline) return timelines;
    await sleep(wait);
  }
}

async function settledOne(run: Run, chatId: string): Promise<Timeline> {
  const [timeline] = await settled(run, [chatId]);
  if (!timeline) throw new WalkthroughError('timeline_missing');
  return timeline;
}

/** Empty when every review settled; otherwise how many reviews were unavailable or still unfinished. */
function reviewProblem(timelines: readonly Pick<Timeline, 'messages' | 'messageEvents'>[]): string {
  const reviews = timelines.flatMap((t) => [...t.messages, ...t.messageEvents].flatMap((item) => (item.review ? [item.review] : [])));
  const unavailable = reviews.filter((r) => r.status === 'unavailable').length;
  const waiting = reviews.filter((r) => r.status === 'pending' || r.status === 'running').length;
  if (unavailable === 0 && waiting === 0) return '';
  return `review unavailable (${unavailable} of ${reviews.length} reviews unavailable, ${waiting} unfinished at the settle limit)`;
}

/** The captures of every received message, in both directions, and of every edit or conflicting copy. */
function capturesOf(timeline: Timeline): (Capture | null)[] {
  const received = timeline.messages.filter((m) =>
    m.origin === 'source' && m.originalCaptured && ((m.text ?? '') !== '' || m.unsupportedContent.length > 0));
  const changed = timeline.messageEvents.filter((e) => e.type !== 'deleted' && (e.text ?? '') !== '');
  return [...received.map((m) => m.capture), ...changed.map((e) => e.capture)];
}

/** Counts ready captures whose fetched bytes match both the stored SHA-256 and the X-Mirsad-SHA256 header. */
async function verifyCaptures(run: Run, captures: (Capture | null)[]): Promise<{ total: number; ready: number; matching: number }> {
  const ready = captures.filter((c): c is Capture => c?.status === 'ready' && c.artifactId !== null);
  let matching = 0;
  for (const capture of ready) {
    const read = await send(run, 'GET', `/v1/artifacts/${capture.artifactId ?? ''}`);
    const hash = sha256(read.bytes);
    if (read.status === 200 && hash === capture.sha256 && read.headers.get('x-mirsad-sha256') === hash) matching += 1;
  }
  return { total: captures.length, ready: ready.length, matching };
}

// ---- Checks 1-4: health, the New inbound queue and origin labels ----

async function serviceHealthy(run: Run): Promise<Outcome> {
  const health = await call(run, HealthResponse, 'GET', '/healthz', { token: null });
  const { reviewer, channels } = await call(run, Status, 'GET', '/v1/status');
  return outcome(health.status === 'ok', `healthz ${health.status}`, `reviewer ${reviewer.kind} ${reviewer.reachable ? 'reachable' : 'unreachable'}`,
    `Telegram ${channels.telegram.readiness}, live connector ${channels.telegram.liveConnector}, WhatsApp gate ${channels.whatsapp.gate}`);
}

async function inboundFirst(run: Run): Promise<Outcome> {
  const chatId = onlyChat(await replay(run, loadFixture('inbound-first-greeting')));
  run.chats.set('inboundFirst', chatId);
  const { chat } = await timelineOf(run, chatId);
  const queued = (await chatsOf(run, run.tokens.officer, '&inboxStatus=new_inbound')).chats.some((c) => c.id === chatId);
  const passed = queued && chat.inboxStatus === 'new_inbound' && chat.originLabel === LABELS.firstObservedIncoming && chat.initiatedBy === 'unknown';
  return outcome(passed, `chat ${chatId}: ${queued ? 'in' : 'missing from'} the ${LABELS.newInbound} queue`, `origin ${chat.originLabel}`);
}

async function officerFirst(run: Run): Promise<Outcome> {
  const chatId = onlyChat(await replay(run, loadFixture('officer-first')));
  run.chats.set('officerFirst', chatId);
  const { chat, messages } = await timelineOf(run, chatId);
  const directions = messages.map((m) => m.direction ?? 'none').join(', ');
  const passed = directions === 'outgoing, incoming' && chat.originLabel === LABELS.firstObservedOutgoing && chat.inboxStatus === 'open';
  return outcome(passed, `chat ${chatId}: ${messages.length} messages (${directions})`, `origin ${chat.originLabel}`, `inbox ${chat.inboxStatus}`);
}

async function startMarker(run: Run): Promise<Outcome> {
  const chatId = onlyChat(await replay(run, withConversationStart(loadFixture('inbound-first-greeting'))));
  run.chats.set('startMarker', chatId);
  const { chat } = await timelineOf(run, chatId);
  const passed = chat.originLabel === LABELS.contactStartedChat && chat.initiatedBy === 'contact' && chat.initiationBasis === 'source_start_marker';
  return outcome(passed, `chat ${chatId}: the fixture's start assertion gives origin ${chat.originLabel} (basis ${chat.initiationBasis ?? 'none'})`);
}

// ---- Checks 5-7: captures, deduplication, edits and deletions ----

async function capturePerMessage(run: Run): Promise<Outcome> {
  const chatIds = (['inboundFirst', 'officerFirst', 'startMarker'] as const).map((name) => chatOf(run, name));
  const c = await verifyCaptures(run, (await settled(run, chatIds)).flatMap(capturesOf));
  const passed = c.total > 0 && c.ready === c.total && c.matching === c.total;
  return outcome(passed, `${c.total} received messages in ${chatIds.length} chats: ${c.ready} ready captures, ${c.matching} with a matching SHA-256`);
}

async function noDuplicates(run: Run): Promise<Outcome> {
  const totals = async (): Promise<string> => {
    const { chats } = await chatsOf(run, run.tokens.officer);
    return `${chats.length} chats, ${chats.reduce((sum, c) => sum + c.messageCount, 0)} messages`;
  };
  const before = await totals();
  const first = await replay(run, loadFixture('inbound-first-greeting'));
  const events = [...first.events, ...(await replay(run, loadFixture('officer-first'))).events];
  const duplicates = events.filter((e) => e.status === 200 && e.result === 'duplicate_event').length;
  const after = await totals();
  const passed = events.length > 0 && duplicates === events.length && after === before;
  return outcome(passed, `${duplicates} of ${events.length} replayed events answered duplicate_event`, `${before} before, ${after} after`);
}

async function editAndDelete(run: Run): Promise<Outcome> {
  const fixture = loadFixture('edit-and-delete');
  const report = await replay(run, fixture);
  const chatId = onlyChat(report);
  run.chats.set('editDelete', chatId);
  const { messages, messageEvents } = await settledOne(run, chatId);
  const types = messageEvents.map((e) => e.type).join(', ');
  const editCapture = messageEvents.find((e) => e.type === 'edited')?.capture?.status ?? 'none';
  const originalKept = messages[0] !== undefined && messages[0].text === fixture.updates[0]?.business_message?.text;
  const redelivered = report.events.filter((e) => e.result === 'duplicate_event').length;
  const passed = messages.length === 1 && originalKept && types === 'edited, deleted' && editCapture === 'ready' && redelivered === 1;
  return outcome(passed, `chat ${chatId}: ${messages.length} message`, `separate events ${types}`, `original text ${originalKept ? 'still served' : 'not served'}`,
    `edit capture ${editCapture}`, `${redelivered} redelivered update answered duplicate_event`);
}

// ---- Checks 8-9: batch dispatch and quiet review ----

async function batchDispatch(run: Run): Promise<Outcome> {
  const [first, second] = chatIdsOf(await replay(run, loadFixture('takeover-pair')));
  if (!first || !second) throw new WalkthroughError('fixture_chat_count_unexpected');
  run.chats.set('takeoverA', first);
  run.chats.set('takeoverB', second);
  const answer = await dispatch(run, [first, second]);
  await settled(run, [first, second]);
  const started = answer.results.filter((r) => r.status === 'started' && r.aiMode === 'ai_active').length;
  const results = answer.results.map((r) => `${r.chatId} ${r.status} (${r.aiMode}, revision ${r.revision})`);
  return outcome(answer.results.length === 2 && started === 2, `${LABELS.dispatch} ${answer.dispatchId}`, ...results);
}

/** Check 9's verdict on the payment fixture's settled timeline (only its messages, message events and findings are read). */
export function quietReviewOutcome(chatId: string, timeline: Pick<Timeline, 'messages' | 'messageEvents' | 'findings'>): Outcome {
  const { messages, findings } = timeline;
  const [last, routine] = [messages.at(-1), messages.slice(0, -1)];
  const quiet = routine.filter((m) => m.review?.status === 'completed' && m.review.outcome === 'no_new_finding').length;
  const outgoing = routine.filter((m) => m.direction === 'outgoing' && m.review === null).length;
  const ready = messages.filter((m) => m.capture?.status === 'ready').length;
  const note = findings[0];
  const linked = findings.length === 1 && note !== undefined && note.messageId === last?.id && (last?.text ?? '').includes(note.quote);
  const passed = messages.length === PAYMENT_FIXTURE_MESSAGES && ready === messages.length && linked
    && quiet === PAYMENT_ROUTINE_INCOMING && outgoing === PAYMENT_ROUTINE_OUTGOING;
  const notes = `${findings.length} finding(s)${note ? ` (${note.label})` : ''}${linked ? ' on the last message, quoting it exactly' : ''}`;
  return outcome(passed, reviewProblem([timeline]), `chat ${chatId}: ${messages.length} messages, ${ready} ready captures`, notes,
    `${routine.length} routine messages raised nothing (${quiet} reviews ${LABELS.noNewFinding}, ${outgoing} outgoing, not reviewed)`);
}

async function quietReview(run: Run): Promise<Outcome> {
  const chatId = onlyChat(await replay(run, loadFixture('payment-destination-change')));
  run.chats.set('payment', chatId);
  await dispatch(run, [chatId]);
  return quietReviewOutcome(chatId, await settledOne(run, chatId));
}

// ---- Checks 10-15: officer control and the takeover composer ----

async function pauseAndResume(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverB');
  const start = (await timelineOf(run, chatId)).chat;
  const paused = await control(run, chatId, 'pause', start.revision);
  const resumed = await control(run, chatId, 'resume', paused.revision);
  const { caseActions } = await timelineOf(run, chatId);
  const logged = caseActions.filter((a) => ['control_pause', 'control_resume'].includes(a.type) && a.actor?.id === run.officerId).length;
  return outcome(paused.aiMode === 'paused' && resumed.aiMode === 'ai_active' && logged === 2,
    `chat ${chatId}: ${LABELS.pauseAi} -> ${paused.aiMode} (revision ${paused.revision})`,
    `${LABELS.resumeAi} -> ${resumed.aiMode} (revision ${resumed.revision})`, `${logged} case-log entries name the officer`);
}

async function takeOver(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverA');
  const start = (await timelineOf(run, chatId)).chat;
  const chat = await control(run, chatId, 'take_over', start.revision);
  const passed = chat.aiMode === 'officer_control' && chat.controller?.id === run.officerId && chat.revision === start.revision + 1;
  return outcome(passed, `chat ${chatId}: ${LABELS.takeOver} -> ${chat.aiMode} by ${chat.controller?.id ?? 'nobody'} (revision ${chat.revision})`);
}

async function composerBlank(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverA');
  const { chat, messages } = await timelineOf(run, chatId);
  const outgoing = messages.filter((m) => m.direction === 'outgoing').length;
  const offered = chat.intakeAccount && chat.acknowledgementTemplate === LABELS.acknowledgementTemplate;
  return outcome(outgoing === 0 && offered, `chat ${chatId}: ${outgoing} outgoing messages before ${LABELS.send}`,
    `the intake account ${offered ? 'offers' : 'lacks'} the acknowledgement template, unsent`);
}

async function simulatedSend(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverA');
  const { chat } = await timelineOf(run, chatId);
  const route = `/v1/chats/${chatId}/officer-messages`;
  const options = withKey({ text: LABELS.acknowledgementTemplate, expectedRevision: chat.revision });
  const { message } = await call(run, OfficerMessageResponse, 'POST', route, options);
  const retry = await send(run, 'POST', route, options);
  const replayedId = OfficerMessageResponse.safeParse(SuccessBody.safeParse(retry.body).data?.data).data?.message.id;
  const replayed = retry.headers.get('idempotency-replayed') === 'true' && replayedId === message.id;
  const composed = (await timelineOf(run, chatId)).messages.filter((m) => m.origin === 'officer_composer');
  const passed = composed.length === 1 && composed[0]?.id === message.id && message.direction === 'outgoing'
    && message.sendStatusLabel === LABELS.simulatedSend && message.author?.id === run.officerId && message.capture === null && replayed;
  return outcome(passed, `chat ${chatId}: message ${message.id} shown ${composed.length} time(s) as ${message.sendStatusLabel ?? 'unlabelled'}`,
    `by ${message.author?.id ?? 'nobody'} at ${message.receivedAt}`, `a retry with the same Idempotency-Key ${replayed ? 'was replayed' : 'was not replayed'}`);
}

async function leaveUnanswered(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverA');
  const before = await timelineOf(run, chatId);
  const target = before.messages.filter((m) => m.direction === 'incoming').at(-1);
  if (!target) throw new WalkthroughError('no_incoming_message');
  const body = { decision: 'leave_unanswered', messageId: target.id, expectedRevision: before.chat.revision };
  const { caseAction, created } = await call(run, OfficerDecisionResponse, 'POST', `/v1/chats/${chatId}/officer-decisions`, { body });
  const after = await timelineOf(run, chatId);
  const added = after.caseActions.filter((a) => !before.caseActions.some((b) => b.id === a.id));
  const passed = created && caseAction.type === 'leave_unanswered' && added.length === 1 && added[0]?.id === caseAction.id
    && after.messages.length === before.messages.length && after.chat.aiMode === 'officer_control' && after.chat.inboxStatus === 'open';
  return outcome(passed, `chat ${chatId}: ${LABELS.leaveUnanswered} on ${target.id} added ${added.length} case-log entry (${caseAction.id})`,
    `messages ${before.messages.length} -> ${after.messages.length}`, 'the chat stays open under takeover');
}

async function captureDuringTakeover(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverA');
  const posted = (await replay(run, laterMessage(loadFixture('takeover-pair'), TAKEOVER_ROUTINE_UPDATE))).events[0];
  const timeline = await settledOne(run, chatId);
  const message = timeline.messages.find((m) => m.id === posted?.messageId);
  const c = await verifyCaptures(run, [message?.capture ?? null]);
  const passed = posted?.result === 'recorded' && message?.direction === 'incoming' && c.matching === 1
    && message.review?.status === 'not_requested' && timeline.chat.aiMode === 'officer_control';
  return outcome(passed, `chat ${chatId}: message ${message?.id ?? 'missing'} arrived under takeover`,
    `capture ${message?.capture?.status ?? 'none'}${c.matching === 1 ? ' with a matching SHA-256' : ''}`,
    `review ${message?.review?.status ?? 'none'} while the officer controls the chat`);
}

// ---- Checks 16-19: phone watchlist and Suspected fraud ----

async function currentEntry(run: Run): Promise<WatchlistEntry> {
  const entry = (await watchlistOf(run)).find((e) => e.id === run.entryId);
  if (!entry) throw new WalkthroughError('watchlist_entry_missing');
  return entry;
}

async function watchlistNeedsReview(run: Run): Promise<Outcome> {
  const fixture = loadFixture('watchlist-sequence');
  const report = await replay(run, { ...fixture, updates: fixture.updates.slice(0, MENTION_UPDATES) });
  const chatId = onlyChat(report);
  run.chats.set('watchA', chatId);
  const messageId = report.events[0]?.messageId;
  await dispatch(run, [chatId]);
  const timelines = await settled(run, [chatId]);
  const entry = (await watchlistOf(run)).find((e) => e.evidence.some((ev) => ev.messageId === messageId && ev.origin === 'message_mention'));
  run.entryId = entry?.id ?? null;
  if (!entry) return outcome(false, reviewProblem(timelines), `no watchlist entry for the number mentioned in chat ${chatId}`);
  return outcome(entry.status === 'needs_review' && entry.statusLabel === LABELS.needsReview && entry.number.exactMatchEligible,
    `entry ${entry.id}: ${entry.statusLabel}`, `${entry.evidence.length} observation (message_mention, chat ${chatId}, message ${messageId})`,
    `exact-match eligible ${entry.number.exactMatchEligible}`);
}

async function watchlistApproval(run: Run): Promise<Outcome> {
  const approved = await decide(run, await currentEntry(run), 'approve', REASONS.approve);
  const fixture = loadFixture('watchlist-sequence');
  const chatId = onlyChat(await replay(run, { ...fixture, updates: fixture.updates.slice(MENTION_UPDATES) }));
  run.chats.set('watchB', chatId);
  const { chat, caseActions } = await timelineOf(run, chatId);
  const match = chat.watchlistMatches.find((m) => m.entryId === approved.id);
  const logged = caseActions.some((a) => a.type === 'watchlist_match');
  const origins = [...new Set(match?.evidence.map((e) => e.origin) ?? [])].join(', ') || 'none';
  const passed = approved.status === 'approved' && match !== undefined && match.evidence.length > 0 && chat.inboxStatus === 'new_inbound' && logged;
  return outcome(passed, `entry ${approved.id} ${approved.statusLabel} (revision ${approved.revision})`,
    `new inbound chat ${chatId} shows ${match ? LABELS.watchlistMatch : 'no match'} with ${match?.evidence.length ?? 0} evidence links (${origins})`,
    `case log ${logged ? 'records' : 'lacks'} the match`);
}

async function watchlistCleared(run: Run): Promise<Outcome> {
  const cleared = await decide(run, await currentEntry(run), 'clear', REASONS.clear);
  const sender = chatOf(run, 'watchB');
  const matched = async (): Promise<boolean> => (await timelineOf(run, sender)).chat.watchlistMatches.some((m) => m.entryId === cleared.id);
  const matchedAfterClear = await matched();
  const mention = (await replay(run, laterMessage(loadFixture('watchlist-sequence'), 0))).events[0]?.messageId ?? 'missing';
  await settled(run, [chatOf(run, 'watchA')]);
  const latest = await currentEntry(run);
  const matchedNow = await matched();
  const passed = cleared.status === 'cleared' && !matchedAfterClear && !matchedNow && latest.status === 'cleared'
    && latest.newEvidenceSinceReview && latest.evidence.length === cleared.evidence.length + 1;
  return outcome(passed, `entry ${cleared.id} ${cleared.statusLabel}: the match ${matchedAfterClear || matchedNow ? 'is still on' : 'left'} chat ${sender}`,
    `new mention ${mention} took the observations ${cleared.evidence.length} -> ${latest.evidence.length}`,
    `new evidence flagged ${latest.newEvidenceSinceReview}`, `status stays ${latest.statusLabel} without re-approval`);
}

async function merchantConflict(run: Run): Promise<Outcome> {
  const chatId = onlyChat(await replay(run, loadFixture('merchant-conflict')));
  run.chats.set('merchant', chatId);
  await dispatch(run, [chatId]);
  const timelines = await settled(run, [chatId]);
  const body = { kind: 'merchant_payment_confirmation', paymentHosts: [MERCHANT_HOST], sourceNote: REASONS.merchant };
  const recorded = await call(run, CaseReferenceResponse, 'POST', `/v1/chats/${chatId}/case-references`, { body });
  const fraud = (await timelineOf(run, chatId)).findings.filter((f) => f.kind === 'suspected_fraud');
  const passed = recorded.findingsCreated === 1 && fraud.length === 1 && fraud[0]?.label === LABELS.suspectedFraud
    && fraud[0].caseReferenceId === recorded.caseReference.id;
  return outcome(passed, reviewProblem(timelines), `chat ${chatId}: merchant confirmation ${recorded.caseReference.id} recorded`,
    `${recorded.findingsCreated} ${LABELS.suspectedFraud} finding (${fraud[0]?.id ?? 'none'}) cites it for the conflicting link`);
}

// ---- Checks 20-22: event stream, access and restart ----

/** The reference dashboard's own stream client, run for a second officer from that officer's snapshot cursor. */
function observeStream(baseUrl: string, token: string, cursor: string) {
  const events: StreamWireMessage[] = [];
  const resets = { count: 0 };
  const stream = createEventStream({
    token, cursor,
    fetch: (route, init) => fetch(baseUrl + route, init),
    onEvent: (event) => events.push(event),
    onReload: () => { resets.count += 1; },
  });
  stream.start();
  const latest = (): number => Number(events.at(-1)?.id ?? 0);
  /** True once an event with this sequence or a later one has arrived; false when the timeout passes first. */
  const waitFor = async (seq: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (latest() < seq && Date.now() < deadline) await sleep(POLL_FIRST_MS);
    return latest() >= seq;
  };
  return { events, resets, waitFor, stop: (): void => stream.stop() };
}

async function streamSecondClient(run: Run): Promise<Outcome> {
  const { observer, snapshotCursor } = run;
  const head = Number((await chatsOf(run, run.tokens.officer)).cursor);
  const caughtUp = await observer.waitFor(head, STREAM_CATCH_UP_MS);
  observer.stop();
  const ids = observer.events.map((e) => Number(e.id));
  const gapless = ids.length === head - snapshotCursor && ids.every((id, i) => id === snapshotCursor + i + 1);
  const count = (type: string): string => `${observer.events.filter((e) => e.type === type).length} ${type}`;
  const created = observer.events.filter((e) => e.type === 'chat.created').length;
  const types = ['chat.created', 'message.recorded', 'capture.updated', 'review.updated', 'finding.created', 'chat.control_changed', 'watchlist.match'];
  return outcome(caughtUp && gapless && created === run.chats.size && observer.resets.count === 0,
    `a second officer's client from snapshot cursor ${snapshotCursor} received events ${ids[0] ?? '-'}-${ids.at(-1) ?? '-'} `
      + `(${ids.length}, ${gapless ? 'no gap' : 'with gaps'}, head ${head})`,
    types.map(count).join(', '), `${observer.resets.count} stream.reset`);
}

async function outsiderGets404(run: Run): Promise<Outcome> {
  const chatId = chatOf(run, 'takeoverA');
  const artifactId = (await timelineOf(run, chatId)).messages.find((m) => m.capture?.artifactId)?.capture?.artifactId;
  if (!artifactId) throw new WalkthroughError('no_artifact');
  const token = run.tokens.outsider;
  const timeline = await send(run, 'GET', `/v1/chats/${chatId}/timeline`, { token });
  const artifact = await send(run, 'GET', `/v1/artifacts/${artifactId}`, { token });
  const inbox = (await chatsOf(run, token)).chats.length;
  const [t, a] = [`${timeline.status} ${codeOf(timeline.body)}`, `${artifact.status} ${codeOf(artifact.body)}`];
  return outcome(t === '404 chat_not_found' && a === '404 artifact_not_found' && inbox === 0,
    `an officer of another workspace: timeline of ${chatId} ${t}`, `artifact ${artifactId} ${a}`, `inbox lists ${inbox} chats`);
}

/** What a restart must not change: messages, message events, captures and the case log (reviews may resume). */
function evidenceOf(t: Timeline): unknown {
  const capture = (c: Capture | null): unknown => (c ? [c.id, c.status, c.artifactId, c.sha256] : null);
  return {
    messages: t.messages.map((m) => [m.id, m.direction, m.origin, m.text, m.receivedAt, m.sentAt, m.sendStatus, m.author?.id ?? null, capture(m.capture)]),
    events: t.messageEvents.map((e) => [e.id, e.type, e.text, e.receivedAt, capture(e.capture)]),
    caseLog: t.caseActions.map((a) => [a.id, a.type, a.actor?.id ?? null, a.messageId, a.occurredAt]),
  };
}

async function restartKeepsEvidence(run: Run): Promise<Outcome> {
  const chatIds = [...run.chats.values()];
  const before = await Promise.all(chatIds.map((chatId) => timelineOf(run, chatId)));
  run.observer.stop();
  await run.app.close();
  run.app = await createApp({ config: run.config, logger: silentLogger });
  run.baseUrl = (await run.app.listen()).url;
  const after = await Promise.all(chatIds.map((chatId) => timelineOf(run, chatId)));
  const unchanged = JSON.stringify(before.map(evidenceOf)) === JSON.stringify(after.map(evidenceOf));
  const findingsKept = before.every((t, i) => t.findings.every((f) => after[i]?.findings.some((g) => g.id === f.id)));
  const c = await verifyCaptures(run, after.flatMap(capturesOf));
  const sum = (pick: (t: Timeline) => unknown[]): number => after.reduce((total, t) => total + pick(t).length, 0);
  const counts = `${sum((t) => t.messages)} messages, ${sum((t) => t.messageEvents)} message events, ${sum((t) => t.caseActions)} case-log entries`;
  return outcome(unchanged && findingsKept && c.total > 0 && c.matching === c.total,
    `restarted on the same data directory: ${chatIds.length} chats with ${counts} ${unchanged ? 'unchanged' : 'CHANGED'}`,
    `findings ${findingsKept ? 'kept' : 'lost'}`, `${c.matching} of ${c.total} captures re-read with a matching SHA-256`);
}

// ---- Runner ----

/** The checks, in the order the walkthrough must run them. */
const STEPS: readonly [string, (run: Run) => Promise<Outcome>][] = [
  ['service_healthy', serviceHealthy],
  ['inbound_first_new_inbound', inboundFirst],
  ['officer_first_both_directions', officerFirst],
  ['start_marker_contact_started', startMarker],
  ['capture_per_message', capturePerMessage],
  ['replay_creates_no_duplicates', noDuplicates],
  ['edit_delete_separate_events', editAndDelete],
  ['batch_dispatch_per_chat_status', batchDispatch],
  ['quiet_review_one_note', quietReview],
  ['pause_and_resume', pauseAndResume],
  ['take_over', takeOver],
  ['composer_blank_by_default', composerBlank],
  ['simulated_send', simulatedSend],
  ['leave_unanswered', leaveUnanswered],
  ['capture_during_takeover', captureDuringTakeover],
  ['watchlist_needs_review', watchlistNeedsReview],
  ['watchlist_approval_sender_match', watchlistApproval],
  ['watchlist_cleared_new_evidence', watchlistCleared],
  ['merchant_conflict_suspected_fraud', merchantConflict],
  ['stream_second_client', streamSecondClient],
  ['outsider_gets_404', outsiderGets404],
  ['restart_keeps_evidence', restartKeepsEvidence],
];

function describeError(error: unknown): string {
  if (error instanceof WalkthroughError) return error.message;
  if (error instanceof z.ZodError) return 'unexpected response shape';
  // Other errors can quote their input, so only the class is reported.
  return error instanceof Error ? error.name : 'unknown error';
}

async function runStep(run: Run, [id, check]: (typeof STEPS)[number]): Promise<WalkthroughStep> {
  try {
    return { id, ...(await check(run)) };
  } catch (error) {
    return { id, passed: false, detail: `could not complete: ${describeError(error)}` };
  }
}

function walkthroughConfig(reviewer: ReviewerKind, dataDir: string): Config {
  const inherited = Object.fromEntries(INHERITED_SETTINGS.map((name) => [name, process.env[name]]));
  return loadConfig({ ...inherited, MIRSAD_PORT: '0', MIRSAD_DATA_DIR: dataDir, MIRSAD_DEMO_SEED: 'true', MIRSAD_REVIEWER: reviewer });
}

/** An officer of a second workspace: a valid token with no access to any demo chat. Provisioned before the checks. */
function provisionOutsider(dataDir: string): string {
  const db = openDatabase(path.join(dataDir, DATABASE_FILE), { logger: silentLogger });
  try {
    return db.transaction((tx) => {
      const workspace = provisionWorkspace(tx, { name: 'Walkthrough outside workspace' });
      return provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'officer', displayName: 'Outside Officer' }).token;
    });
  } finally {
    db.close();
  }
}

/** Starts the seeded instance, adds the outsider and opens the second officer's stream from its inbox snapshot cursor. */
async function startRun(reviewer: ReviewerKind, dataDir: string): Promise<Run> {
  const config = walkthroughConfig(reviewer, dataDir);
  const app = await createApp({ config, logger: silentLogger });
  try {
    const { url } = await app.listen();
    const credentials = readDemoCredentials(dataDir);
    const [officer, second] = credentials.officers;
    if (!officer || !second) throw new WalkthroughError('demo_seed_needs_two_officers');
    const tokens = { officer: officer.token, connector: credentials.connector.token, outsider: provisionOutsider(dataDir) };
    const { cursor } = await chatsOf({ baseUrl: url, tokens }, second.token);
    return {
      config, app, baseUrl: url, settleMs: SETTLE_TIMEOUT_MS[reviewer], tokens, officerId: officer.id, snapshotCursor: Number(cursor),
      observer: observeStream(url, second.token, cursor), chats: new Map(), entryId: null,
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function runWalkthrough(options: WalkthroughOptions): Promise<WalkthroughReport> {
  const startedAt = Date.now();
  const kept = options.keep ?? false;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-walkthrough-'));
  let run: Run | null = null;
  try {
    run = await startRun(options.reviewer, dataDir);
    const steps: WalkthroughStep[] = [];
    for (const step of STEPS) steps.push(await runStep(run, step));
    const passed = steps.every((s) => s.passed);
    return { reviewer: options.reviewer, passed, exitCode: passed ? 0 : 1, steps, dataDir, kept, durationMs: Date.now() - startedAt };
  } finally {
    run?.observer.stop();
    // The restart check replaces the app, so this closes whichever instance is running now.
    await run?.app.close();
    if (!kept) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** One line per check, then the tally. */
export function formatChecklist(report: WalkthroughReport): string {
  const failed = report.steps.filter((s) => !s.passed).length;
  return [
    `Mirsad walkthrough (reviewer: ${report.reviewer})`,
    ...report.steps.map((s) => `${s.passed ? 'PASS' : 'FAIL'}  ${s.id}  ${s.detail}`),
    `${failed} of ${report.steps.length} checks failed in ${(report.durationMs / MS_PER_SECOND).toFixed(1)} s`,
  ].join('\n');
}

// ---- Command line ----

const Args = z.object({ reviewer: z.enum(REVIEWER_KINDS), keep: z.boolean() });

function parseCommandLine(argv: string[]): z.infer<typeof Args> | null {
  try {
    const { values } = parseArgs({ args: argv, options: { reviewer: { type: 'string' }, keep: { type: 'boolean', default: false } } });
    // Without --reviewer the configured reviewer runs: MIRSAD_REVIEWER, default lmstudio (design section 15).
    const parsed = Args.safeParse({ reviewer: values.reviewer ?? process.env.MIRSAD_REVIEWER ?? 'lmstudio', keep: values.keep });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Where the kept data directory is and how to sign in to it once Mirsad runs on it. */
function keptLines(dataDir: string): string[] {
  const config = loadConfig({ MIRSAD_HOST: process.env.MIRSAD_HOST, MIRSAD_PORT: process.env.MIRSAD_PORT });
  return [
    '',
    `Kept the data directory: ${dataDir}`,
    'To browse it in the dashboard, start Mirsad on it (PowerShell):',
    `  $env:MIRSAD_DATA_DIR = "${dataDir}"`,
    '  npm run demo',
    '',
    ...signInLines(readDemoCredentials(dataDir), dashboardBaseUrl(config)),
  ];
}

async function main(argv: string[]): Promise<number> {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const args = parseCommandLine(argv);
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const report = await runWalkthrough(args);
  process.stdout.write(`${formatChecklist(report)}\n`);
  if (report.kept) process.stdout.write(`${keptLines(report.dataDir).join('\n')}\n`);
  return report.exitCode;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    process.stderr.write(`demo:walkthrough could not run: ${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
