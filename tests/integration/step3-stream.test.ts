import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../../src/identity/tokens.ts';
import type { Principal } from '../../src/ports/identity.ts';
import { appendStreamEvent } from '../../src/services/stream.ts';
import { readStreamBatch } from '../../src/services/stream-subscribe.ts';
import * as watchlist from '../../src/services/watchlist.ts';
import { DATABASE_FILE, openDatabase, type Tx } from '../../src/storage/db.ts';
import { findPrincipalByTokenHash, grantAccount, insertChannelAccount, toPrincipal } from '../../src/storage/repos/principals.ts';
import { startHarness, type ApiResponse, type TestHarness } from '../helpers/harness.ts';
import { edited, envelope, recorded, uniqueId } from '../helpers/events.ts';
import { openStream, type StreamClient, type StreamMessage } from '../helpers/sse-client.ts';

// Wrap the watchlist access check (a stub until Task 7) in a spy that still calls the real function.
vi.mock('../../src/services/watchlist.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/watchlist.ts')>();
  return { ...actual, canAccessEntry: vi.fn(actual.canAccessEntry) };
});

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Account = { source: 'telegram'; externalAccountId: string };

function inTransaction<T>(target: TestHarness, fn: (tx: Tx) => T): T {
  const db = openDatabase(path.join(target.dataDir, DATABASE_FILE));
  try {
    return db.transaction(fn);
  } finally {
    db.close();
  }
}

function principalFor(token: string, target: TestHarness = h): Principal {
  return inTransaction(target, (tx) => {
    const row = findPrincipalByTokenHash(tx, hashToken(token));
    if (!row) throw new Error('principal_missing');
    return toPrincipal(row);
  });
}

/** The workspace's last issued sequence and its pruning floor. */
function bounds(target: TestHarness, token = target.tokens.officerA): { head: number; floor: number } {
  const { workspaceId } = principalFor(token, target);
  return inTransaction(target, (tx) => {
    const row = tx.get<{ stream_seq: number; stream_floor: number }>(
      'SELECT stream_seq, stream_floor FROM workspaces WHERE id = :workspaceId',
      { workspaceId },
    );
    return { head: row?.stream_seq ?? 0, floor: row?.stream_floor ?? 0 };
  });
}

function setDisabled(token: string, disabled: boolean): void {
  inTransaction(h, (tx) =>
    tx.run('UPDATE principals SET disabled = :disabled WHERE token_sha256 = :hash', { disabled, hash: hashToken(token) }),
  );
}

/** A Telegram account in the outsider's workspace (B), granted to the outsider, so workspace B has activity too. */
function grantOutsiderAccount(): Account {
  const externalAccountId = uniqueId('tg-outside-');
  inTransaction(h, (tx) => {
    const outsider = findPrincipalByTokenHash(tx, hashToken(h.tokens.outsider));
    if (!outsider) throw new Error('outsider_missing');
    const account = insertChannelAccount(tx, {
      workspaceId: outsider.workspace_id, source: 'telegram', externalAccountId, label: 'Outside test account', isIntake: false,
    });
    grantAccount(tx, outsider.id, account.id);
  });
  return { source: 'telegram', externalAccountId };
}

async function ingestNewChat(account: Account, target: TestHarness = h): Promise<{ chatId: string; messageId: string }> {
  const res = await target.http(target.tokens.connector).post('/v1/ingest', envelope(account, uniqueId('chat-'), recorded({ messageId: 1, text: 'Hello there.' })));
  expect(res.status).toBe(201);
  return { chatId: res.body.data.chatId, messageId: res.body.data.messageId };
}

async function addMessage(chatId: string, messageId: number, text: string): Promise<{ messageId: string }> {
  const res = await h.http(h.tokens.connector).post(`/v1/chats/${chatId}/events`, recorded({ messageId, text }));
  expect(res.status).toBe(201);
  return { messageId: res.body.data.messageId };
}

async function post(token: string, urlPath: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse> {
  const res = await h.http(token).post(urlPath, body, headers);
  expect(res.status, res.text).toBeLessThan(300);
  return res;
}

const isEvent = (event: string, chatId: string) => (m: StreamMessage) => m.event === event && m.data.chatId === chatId;
const chatIdsOf = (client: StreamClient): Set<string | null> => new Set(client.received.map((m) => m.data.chatId as string | null));

/** Every stream message carries these keys plus the fields of its type (design section 12). */
const BASE_KEYS = ['id', 'type', 'chatId', 'occurredAt'];
const DATA_KEYS: Record<string, string[]> = {
  'chat.created': ['inboxStatus'],
  'chat.control_changed': ['aiMode', 'revision'],
  'message.recorded': ['messageId', 'direction', 'origin'],
  'message.edited': ['messageId', 'messageEventId'],
  'message.deleted': ['messageId', 'messageEventId'],
  'message.conflicting_copy': ['messageId', 'messageEventId'],
  'capture.updated': ['messageId', 'messageEventId', 'captureId', 'status', 'artifactId'],
  'review.updated': ['messageId', 'messageEventId', 'status', 'outcome'],
  'finding.created': ['messageId', 'findingId', 'kind'],
  'case_action.recorded': ['caseActionId', 'actionType'],
};

describe('step 3: the event stream', () => {
  it('chat.created reaches officers who can access the chat and nobody else', async () => {
    const outsideAccount = grantOutsiderAccount();
    const a = await openStream(h.baseUrl, h.tokens.officerA);
    const c = await openStream(h.baseUrl, h.tokens.officerC);
    const outsider = await openStream(h.baseUrl, h.tokens.outsider);
    try {
      const hidden = await ingestNewChat(h.accounts.officer); // officer C has no grant on this account
      const visible = await ingestNewChat(h.accounts.intake);
      const own = await post(h.tokens.outsider, '/v1/chats', { ...outsideAccount, externalChatId: uniqueId('ws-b-'), displayLabel: 'Test Contact' });
      const ownChatId: string = own.body.data.chat.id;
      // A later message in the visible chat is the sentinel for workspace A: delivery is in sequence order.
      const sentinel = await addMessage(visible.chatId, 2, 'Still here.');
      const isSentinel = (m: StreamMessage) => m.event === 'message.recorded' && m.data.messageId === sentinel.messageId;

      const createdForA = await a.next(isEvent('chat.created', hidden.chatId));
      expect(createdForA.data).toEqual({
        id: createdForA.id, type: 'chat.created', chatId: hidden.chatId, occurredAt: expect.any(String), inboxStatus: 'new_inbound',
      });
      await a.next(isEvent('chat.created', visible.chatId));
      await a.next(isSentinel);
      await c.next(isEvent('chat.created', visible.chatId));
      await c.next(isSentinel);
      await outsider.next(isEvent('chat.created', ownChatId));

      expect(chatIdsOf(a).has(ownChatId)).toBe(false);
      expect(chatIdsOf(c).has(hidden.chatId)).toBe(false);
      expect(chatIdsOf(c).has(ownChatId)).toBe(false);
      expect([...chatIdsOf(outsider)]).toEqual([ownChatId]);
    } finally {
      for (const client of [a, c, outsider]) client.close();
    }
  });

  it('an event committed between the snapshot and the subscription is delivered when subscribing with the snapshot cursor', async () => {
    const { chatId } = await ingestNewChat(h.accounts.intake);
    const snapshot = (await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`)).body.data;
    const between = await addMessage(chatId, 2, 'Sent while the dashboard was loading.');
    const stream = await openStream(h.baseUrl, h.tokens.officerA, { cursor: snapshot.cursor });
    try {
      const delivered = await stream.next((m) => m.event === 'message.recorded' && m.data.messageId === between.messageId);
      expect(Number(delivered.id)).toBeGreaterThan(Number(snapshot.cursor));
      expect(stream.received.every((m) => Number(m.id) > Number(snapshot.cursor))).toBe(true);
    } finally {
      stream.close();
    }

    // The inbox snapshot works the same way for a chat created after it.
    const inbox = (await h.http(h.tokens.officerA).get('/v1/chats')).body.data;
    const created = await ingestNewChat(h.accounts.intake);
    const fromInbox = await openStream(h.baseUrl, h.tokens.officerA, { cursor: inbox.cursor });
    try {
      await fromInbox.next(isEvent('chat.created', created.chatId));
    } finally {
      fromInbox.close();
    }
  });

  it('reconnecting with Last-Event-ID resumes after the last seen event without duplicates', async () => {
    const { chatId } = await ingestNewChat(h.accounts.intake);
    const first = await openStream(h.baseUrl, h.tokens.officerA);
    const seen = await addMessage(chatId, 2, 'Seen before the disconnect.');
    await first.next((m) => m.event === 'message.recorded' && m.data.messageId === seen.messageId);
    first.close();
    await first.ended;
    const lastEventId = first.received.at(-1)?.id ?? '';

    const missed = [await addMessage(chatId, 3, 'Missed while away.'), await addMessage(chatId, 4, 'Also missed.')];
    // Last-Event-ID wins over a cursor still present in the URL.
    const second = await openStream(h.baseUrl, h.tokens.officerA, { lastEventId, cursor: 0 });
    try {
      await second.next((m) => m.event === 'message.recorded' && m.data.messageId === missed[1]?.messageId);
      expect(second.received.every((m) => Number(m.id) > Number(lastEventId))).toBe(true);
      const ids = [...first.received, ...second.received].map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      const recordedAfter = second.received.filter((m) => m.event === 'message.recorded').map((m) => m.data.messageId);
      expect(recordedAfter).toEqual(missed.map((m) => m.messageId));
    } finally {
      second.close();
    }
  });

  it('a token in the query string does not open the stream', async () => {
    const token = encodeURIComponent(h.tokens.officerA);
    for (const query of [`token=${token}`, `access_token=${token}`, `cursor=0&token=${token}`]) {
      const res = await fetch(`${h.baseUrl}/v1/events?${query}`, { headers: { accept: 'text/event-stream' } });
      expect(res.status, query).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
    }
    // The same request with the token in the Authorization header opens the stream.
    const stream = await openStream(h.baseUrl, h.tokens.officerA, { cursor: 0 });
    expect(stream.status).toBe(200);
    stream.close();
  });

  it('a malformed cursor or Last-Event-ID is 400 validation_failed', async () => {
    const badCursor = await h.http(h.tokens.officerA).get('/v1/events?cursor=-1');
    const badHeader = await h.http(h.tokens.officerA).get('/v1/events', { 'Last-Event-ID': 'abc' });
    for (const res of [badCursor, badHeader]) {
      expect(res.status, res.text).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('the stream of a principal that becomes disabled ends', async () => {
    const stream = await openStream(h.baseUrl, h.tokens.officerC);
    try {
      setDisabled(h.tokens.officerC, true);
      await stream.ended;
      const closed = h.logs.map((line) => JSON.parse(line) as { event: string; reason?: string });
      expect(closed).toContainEqual(expect.objectContaining({ event: 'stream_closed', reason: 'principal_disabled' }));
      await expect(openStream(h.baseUrl, h.tokens.officerC)).rejects.toThrow(/stream_open_failed:401/);
    } finally {
      setDisabled(h.tokens.officerC, false);
      stream.close();
    }
  });

  it('events of chats the caller cannot access are never delivered', async () => {
    const start = bounds(h).head;
    const c = await openStream(h.baseUrl, h.tokens.officerC);
    try {
      // Officer C has no grant on the officer account: nothing that happens in this chat may reach C.
      const registered = await post(h.tokens.officerA, '/v1/chats', { ...h.accounts.officer, externalChatId: uniqueId('hidden-'), displayLabel: 'Test Contact' });
      const hiddenId: string = registered.body.data.chat.id;
      await addMessage(hiddenId, 1, 'Officer C must not learn of this message.');
      await post(h.tokens.officerA, '/v1/dispatches', { chatIds: [hiddenId] }, { 'Idempotency-Key': uniqueId('d-') });
      await post(h.tokens.officerA, `/v1/chats/${hiddenId}/control`, { action: 'take_over', expectedRevision: 2 });
      await post(h.tokens.officerA, `/v1/chats/${hiddenId}/officer-messages`, { text: 'A reply C must not see.', expectedRevision: 3 }, { 'Idempotency-Key': uniqueId('m-') });
      const sentinel = await ingestNewChat(h.accounts.intake);
      await c.next(isEvent('chat.created', sentinel.chatId));
      expect(c.received.filter((m) => m.data.chatId === hiddenId)).toEqual([]);

      // Read without a socket: the hidden chat's events exist and reach officer A, but not officer C.
      const officerA = principalFor(h.tokens.officerA);
      const officerC = principalFor(h.tokens.officerC);
      const typesFor = (principal: Principal) =>
        inTransaction(h, (tx) => readStreamBatch(tx, principal, start, 1000)).events.filter((e) => e.chat_id === hiddenId).map((e) => e.type);
      expect(typesFor(officerA)).toEqual(expect.arrayContaining(['chat.created', 'message.recorded', 'chat.control_changed', 'case_action.recorded']));
      expect(typesFor(officerC)).toEqual([]);
    } finally {
      c.close();
    }
  });

  it('events that carry only a watchlist entry ID reach only callers who can access the entry', async () => {
    const officerA = principalFor(h.tokens.officerA);
    const start = bounds(h).head;
    inTransaction(h, (tx) => {
      for (const entryId of ['wle_visible', 'wle_restricted']) {
        appendStreamEvent(tx, {
          workspaceId: officerA.workspaceId, type: 'watchlist.entry_updated', watchlistEntryId: entryId,
          data: { watchlistEntryId: entryId, status: 'needs_review', reason: 'created' },
        });
      }
    });
    const actual = await vi.importActual<typeof import('../../src/services/watchlist.ts')>('../../src/services/watchlist.ts');
    vi.mocked(watchlist.canAccessEntry).mockImplementation((_tx, principal, entryId) => entryId === 'wle_visible' && principal.id === officerA.id);
    const a = await openStream(h.baseUrl, h.tokens.officerA, { cursor: start });
    const c = await openStream(h.baseUrl, h.tokens.officerC, { cursor: start });
    try {
      const sentinel = await ingestNewChat(h.accounts.intake);
      await a.next(isEvent('chat.created', sentinel.chatId));
      await c.next(isEvent('chat.created', sentinel.chatId));
      const entryEvents = (client: StreamClient) => client.received.filter((m) => m.event === 'watchlist.entry_updated');
      expect(entryEvents(a).map((m) => m.data)).toEqual([
        { id: expect.any(String), type: 'watchlist.entry_updated', chatId: null, occurredAt: expect.any(String), watchlistEntryId: 'wle_visible', status: 'needs_review', reason: 'created' },
      ]);
      expect(entryEvents(c)).toEqual([]);
    } finally {
      a.close();
      c.close();
      vi.mocked(watchlist.canAccessEntry).mockImplementation(actual.canAccessEntry);
    }
  });

  it('stream data carries ids and statuses and never message text', async () => {
    const canary = `canary-${uniqueId()}`;
    const stream = await openStream(h.baseUrl, h.tokens.officerA);
    try {
      const sender = { externalId: '9001', displayName: `${canary} name`, phone: { raw: '+44 7700 900999', internationalFormat: true } };
      const first = await post(h.tokens.connector, '/v1/ingest', envelope(h.accounts.intake, uniqueId('canary-'), recorded({ messageId: 1, text: `${canary} incoming`, sender })));
      const chatId: string = first.body.data.chatId;
      await post(h.tokens.connector, `/v1/chats/${chatId}/events`, edited({ messageId: 1, updateId: 7100, text: `${canary} edited` }));
      await post(h.tokens.officerA, `/v1/chats/${chatId}/control`, { action: 'take_over', expectedRevision: 1 });
      await post(h.tokens.officerA, `/v1/chats/${chatId}/officer-messages`, { text: `${canary} reply`, expectedRevision: 2 }, { 'Idempotency-Key': uniqueId('m-') });
      const decision = await post(h.tokens.officerA, `/v1/chats/${chatId}/officer-decisions`, { decision: 'leave_unanswered', messageId: first.body.data.messageId, expectedRevision: 2 });
      await stream.next((m) => m.event === 'case_action.recorded' && m.data.caseActionId === decision.body.data.caseAction.id);

      const types = new Set(stream.received.filter((m) => m.data.chatId === chatId).map((m) => m.event));
      expect([...types]).toEqual(expect.arrayContaining(['chat.created', 'message.recorded', 'message.edited', 'chat.control_changed', 'case_action.recorded']));
      for (const message of stream.received) {
        const serialized = JSON.stringify(message.data);
        expect(serialized).not.toContain(canary);
        expect(serialized).not.toContain('900999');
        expect(message.data).toMatchObject({ id: message.id, type: message.event, occurredAt: expect.any(String) });
        expect(Object.keys(message.data).sort(), message.event).toEqual([...BASE_KEYS, ...(DATA_KEYS[message.event] ?? ['unexpected type'])].sort());
      }
    } finally {
      stream.close();
    }
  });

  it('a connector token cannot open the stream', async () => {
    await expect(openStream(h.baseUrl, h.tokens.connector)).rejects.toThrow(/stream_open_failed:403/);
    await expect(openStream(h.baseUrl, h.tokens.liveConnector)).rejects.toThrow(/stream_open_failed:403/);
    const officer = await openStream(h.baseUrl, h.tokens.officerA);
    expect(officer.status).toBe(200);
    officer.close();
  });

  it('an idle stream receives keep-alive comments at the configured interval', async () => {
    const stream = await openStream(h.baseUrl, h.tokens.officerA);
    try {
      await vi.waitFor(() => expect(stream.comments).toBeGreaterThanOrEqual(2), { timeout: 5_000, interval: 10 });
    } finally {
      stream.close();
    }
  });

  it('closing the client ends the server-side subscription', async () => {
    const officerBId = principalFor(h.tokens.officerB).id;
    const closedForB = () =>
      h.logs
        .map((line) => JSON.parse(line) as { event: string; principalId?: string; reason?: string })
        .filter((e) => e.event === 'stream_closed' && e.principalId === officerBId);
    expect(closedForB()).toEqual([]);
    const stream = await openStream(h.baseUrl, h.tokens.officerB);
    stream.close();
    await stream.ended;
    await vi.waitFor(() => expect(closedForB()).toEqual([expect.objectContaining({ reason: 'disconnected' })]), { timeout: 5_000, interval: 10 });
  });
});

describe('step 3: the event stream with a short retention window', () => {
  let r: TestHarness;
  beforeAll(async () => {
    r = await startHarness({ config: { streamRetention: 4 } });
  });
  afterAll(async () => {
    await r.close();
  });

  /** Captures rendered in the background append events too; settle them so sequence numbers are predictable. */
  async function ingestAndSettle(): Promise<string> {
    const { chatId } = await ingestNewChat(r.accounts.intake, r);
    await r.drain();
    return chatId;
  }

  it('a cursor below the retained floor or above the head yields stream.reset and then continues from the head', async () => {
    for (let i = 0; i < 3; i += 1) await ingestAndSettle();
    const initial = bounds(r);
    expect(initial.floor).toBeGreaterThan(0);

    for (const cursor of [initial.floor - 1, initial.head + 1000]) {
      const stream = await openStream(r.baseUrl, r.tokens.officerA, { cursor });
      try {
        const reset = await stream.next();
        const { head } = bounds(r);
        expect(reset).toEqual({
          id: String(head),
          event: 'stream.reset',
          data: {
            id: String(head), type: 'stream.reset', chatId: null, occurredAt: expect.any(String),
            reason: 'cursor_out_of_range', resumeFrom: String(head), reload: ['inbox', 'timeline'],
          },
        });
        const chatId = await ingestAndSettle();
        const next = await stream.next();
        expect(next).toMatchObject({ id: String(head + 1), event: 'chat.created', data: { chatId } });
      } finally {
        stream.close();
      }
    }

    // A cursor exactly at the floor is still inside retained history: no reset, the next retained event follows.
    const { floor } = bounds(r);
    const atFloor = await openStream(r.baseUrl, r.tokens.officerA, { cursor: floor });
    try {
      const first = await atFloor.next();
      expect(first.event).not.toBe('stream.reset');
      expect(first.id).toBe(String(floor + 1));
    } finally {
      atFloor.close();
    }
  });

  it('a connected reader that pruning overtakes gets stream.reset instead of silently skipping events', async () => {
    const chatIds = [await ingestAndSettle(), await ingestAndSettle(), await ingestAndSettle()];
    const before = bounds(r);
    const stream = await openStream(r.baseUrl, r.tokens.officerA);
    try {
      // One dispatch of three chats commits six events at once, more than the retention window of four.
      const dispatched = await r.http(r.tokens.officerA).post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': uniqueId('d-') });
      expect(dispatched.status).toBe(200);
      expect(bounds(r).floor).toBeGreaterThan(before.head);

      const reset = await stream.next();
      expect(reset).toMatchObject({ event: 'stream.reset', data: { reason: 'cursor_out_of_range', resumeFrom: reset.id } });
      expect(Number(reset.id)).toBeGreaterThanOrEqual(before.head + 6);
      const pausedChat = chatIds[0] ?? '';
      const paused = await r.http(r.tokens.officerA).post(`/v1/chats/${pausedChat}/control`, { action: 'pause', expectedRevision: 2 });
      expect(paused.status).toBe(200);
      await stream.next(isEvent('chat.control_changed', pausedChat));
      // Everything after the reset continues past its head; nothing from the pruned range slipped through.
      expect(stream.received[0]?.event).toBe('stream.reset');
      expect(stream.received.slice(1).every((m) => Number(m.id) > Number(reset.id))).toBe(true);
    } finally {
      stream.close();
    }
  });
});
