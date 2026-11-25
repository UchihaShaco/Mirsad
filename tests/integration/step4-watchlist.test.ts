/**
 * Step 4: the phone watchlist (design section 11). Numbers reach the watchlist only through review evidence and sender
 * metadata, officers review entries, and approved entries match new inbound chats by the sender's E.164 number. Every
 * read goes through the HTTP API and the event stream; the harness reviewer runs the deterministic rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { replayFixture, type ReplayReport } from '../../src/adapters/replay.ts';
import type { Timeline, WatchlistEntry } from '../../src/contract/schemas.ts';
import { onEvidencePublished, type EvidenceContext, type PhoneInput } from '../../src/services/watchlist.ts';
import { DATABASE_FILE, openDatabase, type Tx } from '../../src/storage/db.ts';
import type { ChatRow, MessageEventRow, MessageRow } from '../../src/storage/rows.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type ApiResponse, type TestHarness } from '../helpers/harness.ts';
import { openStream, type StreamMessage } from '../helpers/sse-client.ts';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/telegram');
const FIXTURE_ACCOUNTS = { intake: 'tg-intake-1', officer: 'tg-officer-1' } as const;
const DECISION_REASON = 'Checked against the cited evidence in the case file.';

type Decision = 'approve' | 'clear' | 'reopen';
type Fixture = { updates: unknown[] } & Record<string, unknown>;
type Account = { source: 'telegram'; externalAccountId: string };

/** What intake answers for a stored event. */
interface Posted {
  chatId: string;
  messageId: string;
  messageEventId: string;
  receivedAt: string;
}

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
afterEach(async () => {
  await h.drain();
});

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Fixture;
}

/** Replays updates [from, to) of a fixture through POST /v1/ingest, as `npm run replay` does. */
function replay(target: TestHarness, fixture: Fixture, from: number, to?: number): Promise<ReplayReport> {
  return replayFixture(
    { ...fixture, updates: fixture.updates.slice(from, to) },
    { baseUrl: target.baseUrl, connectorToken: target.tokens.connector, accounts: FIXTURE_ACCOUNTS },
  );
}

/** A harness of its own, for fixtures whose fixed chat IDs and numbers would collide in the shared one. */
async function withHarness(fn: (target: TestHarness) => Promise<void>): Promise<void> {
  const target = await startHarness();
  try {
    await fn(target);
  } finally {
    await target.close();
  }
}

async function dispatch(target: TestHarness, chatIds: string[]): Promise<void> {
  const res = await target.http(target.tokens.officerA).post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': uniqueId('wl-d-') });
  expect(res.status, res.text).toBe(200);
}

function postReview(target: TestHarness, token: string, entryId: string, decision: Decision, expectedRevision: number): Promise<ApiResponse> {
  return target.http(token).post(`/v1/watchlist/${entryId}/review`, { decision, reason: DECISION_REASON, expectedRevision });
}

async function watchlistOf(target: TestHarness, token: string): Promise<{ entries: WatchlistEntry[]; cursor: string }> {
  const res = await target.http(token).get('/v1/watchlist');
  expect(res.status, res.text).toBe(200);
  return res.body.data as { entries: WatchlistEntry[]; cursor: string };
}

async function timelineOf(target: TestHarness, chatId: string, token = target.tokens.officerA): Promise<Timeline> {
  const res = await target.http(token).get(`/v1/chats/${chatId}/timeline`);
  expect(res.status, res.text).toBe(200);
  return res.body.data as Timeline;
}

// ---- Shared-harness helpers: every test there uses its own numbers from the reserved +44 7700 900xxx range ----

async function ingest(account: Account, externalChatId: string, event: Record<string, unknown>): Promise<Posted> {
  const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(account, externalChatId, event));
  expect(res.status, res.text).toBe(201);
  return res.body.data as Posted;
}

async function postEvent(chatId: string, event: Record<string, unknown>): Promise<Posted> {
  const res = await h.http(h.tokens.connector).post(`/v1/chats/${chatId}/events`, event);
  expect(res.status, res.text).toBe(201);
  return res.body.data as Posted;
}

/** A new chat whose first incoming message has been reviewed (the chat is dispatched, so later messages are too). */
async function reviewedChat(text: string, account: Account = h.accounts.intake): Promise<Posted> {
  const first = await ingest(account, uniqueId('wl-chat-'), recorded({ messageId: 1, text }));
  await dispatch(h, [first.chatId]);
  await h.drain();
  return first;
}

async function reviewedMessage(chatId: string, messageId: number, text: string): Promise<Posted> {
  const posted = await postEvent(chatId, recorded({ messageId, text }));
  await h.drain();
  return posted;
}

/** A new inbound chat whose sender shares their own contact card, as the Telegram adapter maps one. */
function senderChat(phone: PhoneInput, account: Account = h.accounts.intake): Promise<Posted> {
  return ingest(account, uniqueId('wl-sender-'), recorded({
    messageId: 1, text: '', unsupportedContent: ['contact'], sender: { externalId: uniqueId('u'), displayName: 'Test Contact', phone },
  }));
}

function review(entryId: string, decision: Decision, expectedRevision: number, token = h.tokens.officerA): Promise<ApiResponse> {
  return postReview(h, token, entryId, decision, expectedRevision);
}

async function entryFor(e164: string, token = h.tokens.officerA): Promise<WatchlistEntry> {
  const found = (await watchlistOf(h, token)).entries.filter((entry) => entry.number.e164 === e164);
  expect(found, e164).toHaveLength(1);
  return at(found, 0);
}

async function principalId(token: string): Promise<string> {
  return (await h.http(token).get('/v1/me')).body.data.principal.id as string;
}

function fieldsOf(res: ApiResponse): string[] {
  return (res.body.error.details.fields as { path: string }[]).map((field) => field.path);
}

/** Runs fn on a second connection to the shared harness's database. */
function inTransaction<T>(fn: (tx: Tx) => T): T {
  const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
  try {
    return db.transaction(fn);
  } finally {
    db.close();
  }
}

/** The stored rows an observation of this message points at. */
function evidenceContext(tx: Tx, posted: Posted): EvidenceContext {
  const chat = tx.get<ChatRow>('SELECT * FROM chats WHERE id = :id', { id: posted.chatId });
  const message = tx.get<MessageRow>('SELECT * FROM messages WHERE id = :id', { id: posted.messageId });
  const messageEvent = tx.get<MessageEventRow>('SELECT * FROM message_events WHERE id = :id', { id: posted.messageEventId });
  if (!chat || !message || !messageEvent) throw new Error('evidence_rows_missing');
  return { chat, message, messageEvent };
}

const entryEvent = (entryId: string) => (m: StreamMessage) => m.event === 'watchlist.entry_updated' && m.data.watchlistEntryId === entryId;

async function matchesShownIn(chatId: string, token = h.tokens.officerA): Promise<Timeline['chat']['watchlistMatches']> {
  return (await timelineOf(h, chatId, token)).chat.watchlistMatches;
}

/** The sender number intake stored for the chat, normalized by the watchlist hook (not exposed by the API). */
function contactPhoneE164(chatId: string): string | null {
  return inTransaction((tx) => tx.get<{ e164: string | null }>('SELECT contact_phone_e164 AS e164 FROM chats WHERE id = :chatId', { chatId })?.e164 ?? null);
}

/** Entries supported by evidence in the chat, as officer A sees them. */
async function entriesSupportedBy(chatId: string): Promise<WatchlistEntry[]> {
  return (await watchlistOf(h, h.tokens.officerA)).entries.filter((entry) => entry.evidence.some((e) => e.chatId === chatId));
}

async function expectNoMatchIn(chatId: string, label: string): Promise<void> {
  expect(await matchesShownIn(chatId), label).toEqual([]);
  expect((await timelineOf(h, chatId)).caseActions.map((a) => a.type), label).not.toContain('watchlist_match');
}

/** A reviewed mention of the number with a payment request, then an officer's approval. */
async function approvedEntryFor(e164: string, spaced: string, account: Account = h.accounts.intake): Promise<{ entry: WatchlistEntry; mention: Posted }> {
  const mention = await reviewedChat(`Please pay the deposit to ${spaced} today.`, account);
  const entry = await entryFor(e164);
  const approved = await review(entry.id, 'approve', entry.revision);
  expect(approved.status, approved.text).toBe(200);
  return { entry: approved.body.data.entry as WatchlistEntry, mention };
}

describe('step 4: from a source-backed phone candidate to an inbox match', () => {
  it('a number mentioned with a payment request becomes a Needs review entry with an exact source reference and reason', async () => {
    await withHarness(async (t) => {
      const chatA = at((await replay(t, loadFixture('watchlist-sequence'), 0, 1)).events, 0);
      await dispatch(t, [chatA.chatId ?? '']);
      await t.drain();
      const tl = await timelineOf(t, chatA.chatId ?? '');
      const finding = at(tl.findings, 0);
      expect(finding).toMatchObject({ kind: 'phone_number', concern: 'payment_request', messageId: chatA.messageId });
      const { receivedAt } = at(tl.messages, 0);
      expect((await watchlistOf(t, t.tokens.officerA)).entries).toEqual([{
        id: expect.stringMatching(/^wle_[0-9a-f]{32}$/),
        number: { e164: '+447700900123', display: '+44 7700 900123', exactMatchEligible: true },
        status: 'needs_review',
        statusLabel: 'Needs review',
        revision: 1,
        newEvidenceSinceReview: false,
        firstSeenAt: receivedAt,
        lastSeenAt: receivedAt,
        evidence: [{
          observationId: expect.stringMatching(/^wob_[0-9a-f]{32}$/),
          chatId: chatA.chatId,
          messageId: chatA.messageId,
          messageEventId: finding.messageEventId,
          findingId: finding.id,
          origin: 'message_mention',
          sourceRepresentation: '+44 7700 900123',
          reason: 'Mentioned with a payment request',
          observedAt: receivedAt,
        }],
        restrictedEvidence: false,
        matches: [],
        lastDecision: null,
        canReview: true,
        contactSync: null,
      }]);
    });
  });

  it('after approval a new inbound chat from that sender number shows Watchlist match with linked evidence and publishes watchlist.match', async () => {
    await withHarness(async (t) => {
      const fixture = loadFixture('watchlist-sequence');
      const chatA = at((await replay(t, fixture, 0, 1)).events, 0);
      await dispatch(t, [chatA.chatId ?? '']);
      await t.drain();
      const before = await watchlistOf(t, t.tokens.officerA);
      const entry = at(before.entries, 0);
      expect(entry).toMatchObject({ number: { e164: '+447700900123' }, status: 'needs_review' });
      const approved = await postReview(t, t.tokens.officerA, entry.id, 'approve', entry.revision);
      expect(approved.status, approved.text).toBe(200);
      expect(approved.body.data.entry).toMatchObject({ id: entry.id, status: 'approved', statusLabel: 'Approved', revision: entry.revision + 1 });

      const stream = await openStream(t.baseUrl, t.tokens.officerA, { cursor: before.cursor });
      try {
        // Chat B: a greeting, then the sender shares their own contact card carrying the same number.
        const chatB = await replay(t, fixture, 1);
        const chatBId = at(chatB.events, 0).chatId ?? '';
        const card = at(chatB.events, 1);
        const match = await stream.next((m) => m.event === 'watchlist.match');
        expect(match.data).toEqual({ id: expect.any(String), type: 'watchlist.match', chatId: chatBId, occurredAt: expect.any(String), watchlistEntryId: entry.id });

        const inbox = await t.http(t.tokens.officerA).get('/v1/chats');
        const summary = inbox.body.data.chats.find((c: { id: string }) => c.id === chatBId);
        expect(summary.watchlistMatches).toEqual([{
          entryId: entry.id,
          // The match shows the number as the matched chat's sender metadata wrote it.
          numberDisplay: '+447700900123',
          matchedAt: expect.any(String),
          restrictedEvidence: false,
          evidence: [
            expect.objectContaining({ chatId: chatA.chatId, messageId: chatA.messageId, origin: 'message_mention', reason: 'Mentioned with a payment request' }),
            expect.objectContaining({ chatId: chatBId, messageId: card.messageId, origin: 'sender_metadata', reason: 'Sender of an inbound chat', sourceRepresentation: '+447700900123' }),
          ],
        }]);
        const actions = (await timelineOf(t, chatBId)).caseActions.filter((a) => a.type === 'watchlist_match');
        expect(actions).toEqual([expect.objectContaining({ actor: null, messageId: card.messageId, detail: { watchlistEntryId: entry.id } })]);
      } finally {
        stream.close();
      }
    });
  });

  it('the review decision is published as watchlist.entry_updated on the same stream', async () => {
    const start = (await watchlistOf(h, h.tokens.officerA)).cursor;
    const a = await openStream(h.baseUrl, h.tokens.officerA, { cursor: start });
    const c = await openStream(h.baseUrl, h.tokens.officerC, { cursor: start });
    try {
      // The supporting chat is on the officer account, which officer C has no grant on.
      await reviewedChat('Please pay the deposit to +44 7700 900311 today.', h.accounts.officer);
      const entry = await entryFor('+447700900311');
      const envelopeOf = (status: string, reason: string) => ({
        id: expect.any(String), type: 'watchlist.entry_updated', chatId: null, occurredAt: expect.any(String), watchlistEntryId: entry.id, status, reason,
      });
      expect((await a.next(entryEvent(entry.id))).data).toEqual(envelopeOf('needs_review', 'created'));
      expect((await review(entry.id, 'approve', entry.revision)).status).toBe(200);
      expect((await a.next(entryEvent(entry.id))).data).toEqual(envelopeOf('approved', 'reviewed'));

      // Delivery follows sequence order, so a sentinel published afterwards bounds what C could have received.
      const sentinel = await ingest(h.accounts.intake, uniqueId('wl-sentinel-'), recorded({ messageId: 1 }));
      await c.next((m) => m.event === 'chat.created' && m.data.chatId === sentinel.chatId);
      expect(c.received.filter((m) => m.data.watchlistEntryId === entry.id)).toEqual([]);
    } finally {
      a.close();
      c.close();
    }
  });
});

describe('step 4: observations', () => {
  it('repeat delivery and the same number written differently create one logical entry', async () => {
    const text = 'Please pay the deposit to +44 7700 900314 today.';
    const first = await reviewedChat(text);
    // Telegram redelivers the same update: intake reports a duplicate and nothing new reaches the watchlist.
    const redelivered = await h.http(h.tokens.connector).post(`/v1/chats/${first.chatId}/events`, recorded({ messageId: 1, text }));
    expect(redelivered.body.data.result).toBe('duplicate_event');
    await h.drain();
    const written00 = await reviewedMessage(first.chatId, 2, 'Transfer the fee to 0044 7700 900314.');
    const unspaced = await reviewedChat('Pay the invoice via +447700900314 please.');

    const entry = await entryFor('+447700900314');
    const references = entry.evidence.map((e) => [e.chatId, e.messageId, e.messageEventId, e.sourceRepresentation]);
    expect(references).toEqual([
      [first.chatId, first.messageId, first.messageEventId, '+44 7700 900314'],
      [first.chatId, written00.messageId, written00.messageEventId, '0044 7700 900314'],
      [unspaced.chatId, unspaced.messageId, unspaced.messageEventId, '+447700900314'],
    ]);

    // The same evidence delivered to the watchlist again (as a re-run publish would) is a no-op.
    const mention = { e164: '+447700900314', digits: '447700900314', sourceRepresentation: '+44 7700 900314', concern: 'payment_request' as const, findingId: entry.evidence[0]?.findingId ?? null };
    const entryEvents = () => inTransaction((tx) => tx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM stream_events WHERE watchlist_entry_id = :entryId', { entryId: entry.id },
    )?.n);
    const eventsBefore = entryEvents();
    inTransaction((tx) => onEvidencePublished(tx, evidenceContext(tx, first), { phoneMentions: [mention], suspectedFraudFindingIds: [] }));
    expect(entryEvents()).toBe(eventsBefore);
    expect(await entryFor('+447700900314')).toEqual(entry);
  });

  it('a later observation is appended and moves last seen forward; earlier observations stay visible after a decision', async () => {
    const first = await reviewedChat('Please pay the deposit to +44 7700 900313.');
    const entry = await entryFor('+447700900313');
    expect([entry.firstSeenAt, entry.lastSeenAt]).toEqual([first.receivedAt, first.receivedAt]);
    expect((await review(entry.id, 'approve', entry.revision)).status).toBe(200);

    h.clock.advance(60_000);
    const later = await reviewedChat('Settle the invoice through +44 7700 900313 as well.');
    const updated = await entryFor('+447700900313');
    expect(Date.parse(later.receivedAt)).toBeGreaterThan(Date.parse(first.receivedAt));
    expect(updated).toMatchObject({ status: 'approved', firstSeenAt: first.receivedAt, lastSeenAt: later.receivedAt });
    expect(updated.evidence.map((e) => [e.chatId, e.observedAt])).toEqual([[first.chatId, first.receivedAt], [later.chatId, later.receivedAt]]);

    const cleared = await review(entry.id, 'clear', updated.revision);
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data.entry.status).toBe('cleared');
    expect(cleared.body.data.entry.evidence).toEqual(updated.evidence);
  });

  it('a number mentioned in a message stays a mention and is not linked to the sender; the sender\'s own number is recorded as sender metadata', async () => {
    const earlier = await reviewedChat('Please pay the deposit to +44 7700 900331.');
    // Chat Q: the contact shares their own card, then mentions a colleague's number with a payment request.
    const card = await senderChat({ raw: '+447700900331', internationalFormat: true });
    await dispatch(h, [card.chatId]);
    const mention = await reviewedMessage(card.chatId, 2, 'Pay the deposit and call my colleague on +44 7700 900332.');

    const senderEntry = await entryFor('+447700900331');
    expect(senderEntry.evidence.map((e) => [e.chatId, e.messageId, e.origin])).toEqual([
      [earlier.chatId, earlier.messageId, 'message_mention'], [card.chatId, card.messageId, 'sender_metadata'],
    ]);
    const mentioned = await entryFor('+447700900332');
    expect(mentioned.evidence.map((e) => [e.chatId, e.messageId, e.origin, e.reason])).toEqual([
      [card.chatId, mention.messageId, 'message_mention', 'Mentioned with a payment request'],
    ]);
    expect(contactPhoneE164(card.chatId)).toBe('+447700900331');

    // A number written in the body is never taken as the sender's own: approving it matches no chat it was written in.
    const body = await reviewedChat('My number is +44 7700 900333, pay the deposit there.');
    const written = await entryFor('+447700900333');
    expect((await review(written.id, 'approve', written.revision)).status).toBe(200);
    expect(contactPhoneE164(body.chatId)).toBeNull();
    await expectNoMatchIn(body.chatId, 'chat that mentioned the number');
    const owner = await senderChat({ raw: '+447700900333', internationalFormat: true });
    expect((await matchesShownIn(owner.chatId)).map((m) => m.entryId)).toEqual([written.id]);
  });

  it('a mention received earlier but reviewed later moves first seen back and leaves last seen alone', async () => {
    // Chat E receives the number first; it is dispatched only after chat L, which received it a minute later.
    const early = await ingest(h.accounts.intake, uniqueId('wl-early-'), recorded({ messageId: 1, text: 'Please pay the deposit to +44 7700 900315.' }));
    h.clock.advance(60_000);
    const later = await reviewedChat('Transfer the fee to +44 7700 900315 today.');
    expect(await entryFor('+447700900315')).toMatchObject({ firstSeenAt: later.receivedAt, lastSeenAt: later.receivedAt });

    await dispatch(h, [early.chatId]);
    await h.drain();
    const entry = await entryFor('+447700900315');
    expect(entry).toMatchObject({ firstSeenAt: early.receivedAt, lastSeenAt: later.receivedAt });
    expect(entry.evidence.map((e) => e.chatId)).toEqual([early.chatId, later.chatId]);
  });
});

describe('step 4: officer review', () => {
  it('review needs a reason and the expected revision; a stale revision conflicts; forbidden transitions are rejected; officer, time and decision are recorded', async () => {
    await reviewedChat('Please transfer the fee to +44 7700 900312 now.');
    const entry = await entryFor('+447700900312');
    const reviewPath = `/v1/watchlist/${entry.id}/review`;
    const officerA = h.http(h.tokens.officerA);
    const refused = async (res: Promise<ApiResponse>, status: number, code: string): Promise<ApiResponse> => {
      const answer = await res;
      expect(answer.status, answer.text).toBe(status);
      expect(answer.body.error.code).toBe(code);
      return answer;
    };

    expect(fieldsOf(await refused(officerA.post(reviewPath, { decision: 'approve', expectedRevision: 1 }), 400, 'validation_failed'))).toEqual(['reason']);
    expect(fieldsOf(await refused(officerA.post(reviewPath, { decision: 'approve', reason: 'ok', expectedRevision: 1 }), 400, 'validation_failed'))).toEqual(['reason']);
    expect(fieldsOf(await refused(officerA.post(reviewPath, { decision: 'approve', reason: DECISION_REASON }), 400, 'validation_failed'))).toEqual(['expectedRevision']);
    await refused(review(entry.id, 'reopen', 1), 409, 'invalid_transition');

    h.clock.advance(1_000);
    const approvedAt = h.clock.now().toISOString();
    const approved = await review(entry.id, 'approve', 1);
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.data.entry).toMatchObject({
      status: 'approved', revision: 2,
      lastDecision: { decision: 'approve', reason: DECISION_REASON, officer: { id: await principalId(h.tokens.officerA), displayName: 'Officer A' }, decidedAt: approvedAt },
    });

    const stale = await refused(review(entry.id, 'clear', 1, h.tokens.officerB), 409, 'revision_conflict');
    expect(stale.body.error.details).toEqual({ currentRevision: 2, status: 'approved' });
    await refused(review(entry.id, 'approve', 2), 409, 'invalid_transition');

    h.clock.advance(1_000);
    const cleared = await review(entry.id, 'clear', 2, h.tokens.officerB);
    expect(cleared.body.data.entry).toMatchObject({
      status: 'cleared', statusLabel: 'Cleared', revision: 3,
      lastDecision: { decision: 'clear', officer: { displayName: 'Officer B' }, decidedAt: h.clock.now().toISOString() },
    });
    await refused(review(entry.id, 'approve', 3), 409, 'invalid_transition');
    await refused(review(entry.id, 'clear', 3), 409, 'invalid_transition');
    const reopened = await review(entry.id, 'reopen', 3);
    expect(reopened.body.data.entry).toMatchObject({ status: 'needs_review', statusLabel: 'Needs review', revision: 4, lastDecision: { decision: 'reopen' } });
    // Refused requests changed nothing: every successful decision moved the revision by exactly one.
    expect((await entryFor('+447700900312')).revision).toBe(4);
  });

  it('a cleared entry stays cleared when new evidence arrives and is flagged for review; a cleared number produces no match', async () => {
    await reviewedChat('Please pay the deposit to +44 7700 900326.');
    const entry = await entryFor('+447700900326');
    const cleared = (await review(entry.id, 'clear', entry.revision)).body.data.entry as WatchlistEntry;
    expect(cleared).toMatchObject({ status: 'cleared', newEvidenceSinceReview: false });

    h.clock.advance(60_000);
    const mention = await reviewedChat('Transfer the fee to +44 7700 900326 again.');
    const sender = await senderChat({ raw: '+447700900326', internationalFormat: true });
    const after = await entryFor('+447700900326');
    expect(after).toMatchObject({ status: 'cleared', revision: cleared.revision, newEvidenceSinceReview: true, lastSeenAt: sender.receivedAt });
    expect(after.evidence.map((e) => [e.chatId, e.origin])).toEqual([
      [cleared.evidence[0]?.chatId, 'message_mention'], [mention.chatId, 'message_mention'], [sender.chatId, 'sender_metadata'],
    ]);
    expect(after.matches).toEqual([]);
    expect(await matchesShownIn(sender.chatId)).toEqual([]);
    expect((await timelineOf(h, sender.chatId)).caseActions.map((a) => a.type)).not.toContain('watchlist_match');

    // Surfacing the evidence never restores approval; the officer decides, and the decision clears the flag.
    const reopened = await review(entry.id, 'reopen', after.revision);
    expect(reopened.body.data.entry).toMatchObject({ status: 'needs_review', newEvidenceSinceReview: false });
  });

  it('a match disappears from the chat summary once its entry is cleared or reopened', async () => {
    for (const [e164, spaced, decision] of [['+447700900324', '+44 7700 900324', 'clear'], ['+447700900325', '+44 7700 900325', 'reopen']] as const) {
      const { entry } = await approvedEntryFor(e164, spaced);
      const sender = await senderChat({ raw: e164, internationalFormat: true });
      expect((await matchesShownIn(sender.chatId)).map((m) => m.entryId), decision).toEqual([entry.id]);

      const decided = await review(entry.id, decision, entry.revision);
      expect(decided.status, decided.text).toBe(200);
      expect(decided.body.data.entry.matches, decision).toEqual([]);
      expect(await matchesShownIn(sender.chatId), decision).toEqual([]);
      const inbox = await h.http(h.tokens.officerA).get('/v1/chats');
      expect(inbox.body.data.chats.find((c: { id: string }) => c.id === sender.chatId).watchlistMatches, decision).toEqual([]);
    }
  });
});

describe('step 4: exact matching on sender metadata', () => {
  it('a sender whose number already has an entry adds a sender_metadata observation whatever the entry\'s status, and only an approved entry produces a match', async () => {
    const numbers = { needs_review: '+447700900327', approved: '+447700900328', cleared: '+447700900329' } as const;
    for (const e164 of Object.values(numbers)) await reviewedChat(`Please pay the deposit to ${e164}.`);
    const approved = await entryFor(numbers.approved);
    expect((await review(approved.id, 'approve', approved.revision)).status).toBe(200);
    const cleared = await entryFor(numbers.cleared);
    expect((await review(cleared.id, 'clear', cleared.revision)).status).toBe(200);

    for (const [status, e164] of Object.entries(numbers)) {
      const written = `${e164.slice(0, 3)} ${e164.slice(3, 7)} ${e164.slice(7)}`;
      const sender = await senderChat({ raw: written, internationalFormat: true });
      const entry = await entryFor(e164);
      expect(entry.status, status).toBe(status);
      expect(entry.newEvidenceSinceReview, status).toBe(status !== 'needs_review');
      expect(entry.evidence.at(-1), status).toEqual({
        observationId: expect.any(String),
        chatId: sender.chatId,
        messageId: sender.messageId,
        messageEventId: sender.messageEventId,
        findingId: null,
        origin: 'sender_metadata',
        sourceRepresentation: written,
        reason: 'Sender of an inbound chat',
        observedAt: sender.receivedAt,
      });
      const shown = (await matchesShownIn(sender.chatId)).map((m) => m.entryId);
      const actions = (await timelineOf(h, sender.chatId)).caseActions.filter((a) => a.type === 'watchlist_match');
      expect([shown, actions.length], status).toEqual(status === 'approved' ? [[entry.id], 1] : [[], 0]);
    }
  });

  it('a Telegram user id, a username or a partial number never matches', async () => {
    const { entry } = await approvedEntryFor('+447700900341', '+44 7700 900341');
    // User IDs and usernames reach Mirsad only as the sender's ID and display name; neither is ever used to match.
    const userId = await ingest(h.accounts.intake, uniqueId('wl-uid-'), recorded({ messageId: 1, sender: { externalId: '447700900341', displayName: 'Test Contact' } }));
    const username = await ingest(h.accounts.intake, uniqueId('wl-user-'), recorded({ messageId: 1, sender: { externalId: uniqueId('u'), displayName: '@447700900341' } }));
    const truncated = await senderChat({ raw: '+44 7700 900', internationalFormat: true });
    const tail = await senderChat({ raw: '900341', internationalFormat: true });

    for (const [label, chat] of Object.entries({ userId, username, truncated, tail })) {
      await expectNoMatchIn(chat.chatId, label);
      expect(contactPhoneE164(chat.chatId), label).toBeNull();
    }
    expect(await entryFor('+447700900341')).toMatchObject({ evidence: entry.evidence, matches: [] });
  });

  it('a number without country context is kept unnormalized and never matches', async () => {
    const chat = await reviewedChat('Please pay the deposit to 07700 900351 today.');
    const [entry, ...others] = await entriesSupportedBy(chat.chatId);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ number: { e164: null, display: '07700 900351', exactMatchEligible: false }, status: 'needs_review' });
    const approved = await review(entry?.id ?? '', 'approve', entry?.revision ?? 0);
    expect(approved.status, approved.text).toBe(200);

    // The same digits as the sender's own number, in the same chat, a new chat, and the normalized form: no match.
    await postEvent(chat.chatId, recorded({ messageId: 2, text: '', unsupportedContent: ['contact'], sender: { phone: { raw: '07700 900351' } } }));
    const national = await senderChat({ raw: '07700 900351' });
    const international = await senderChat({ raw: '+447700900351', internationalFormat: true });
    for (const [label, chatId] of Object.entries({ sameChat: chat.chatId, national: national.chatId, international: international.chatId })) {
      await expectNoMatchIn(chatId, label);
    }
    expect((await watchlistOf(h, h.tokens.officerA)).entries.filter((e) => e.number.e164 === '+447700900351')).toEqual([]);
    expect(await entriesSupportedBy(chat.chatId)).toEqual([approved.body.data.entry]);
  });

  it('unnormalized numbers mentioned in different chats stay separate entries', async () => {
    const first = await reviewedChat('Please pay the deposit to 07700 900361.');
    const second = await reviewedChat('Transfer the fee to 07700 900361 today.');
    const [inFirst] = await entriesSupportedBy(first.chatId);
    const [inSecond] = await entriesSupportedBy(second.chatId);
    expect(inFirst?.id).not.toBe(inSecond?.id);
    for (const [entry, chat] of [[inFirst, first], [inSecond, second]] as const) {
      expect(entry).toMatchObject({ number: { e164: null, display: '07700 900361', exactMatchEligible: false } });
      expect(entry?.evidence.map((e) => e.chatId)).toEqual([chat.chatId]);
    }
  });

  it('a contact card that arrives after the first message still sets the sender phone and can match', async () => {
    const { entry } = await approvedEntryFor('+447700900371', '+44 7700 900371');
    const greeting = await ingest(h.accounts.intake, uniqueId('wl-late-card-'), recorded({
      messageId: 1, text: 'Hello, I am sharing my contact details.', sender: { externalId: '6000000371', displayName: 'Test Contact' },
    }));
    expect(contactPhoneE164(greeting.chatId)).toBeNull();
    await expectNoMatchIn(greeting.chatId, 'before the card');

    const card = await postEvent(greeting.chatId, recorded({
      messageId: 2, text: '', unsupportedContent: ['contact'], sender: { externalId: '6000000371', displayName: 'Test Contact', phone: { raw: '+447700900371', internationalFormat: true } },
    }));
    expect(contactPhoneE164(greeting.chatId)).toBe('+447700900371');
    const [match] = await matchesShownIn(greeting.chatId);
    expect(match).toMatchObject({ entryId: entry.id });
    expect(match?.evidence.at(-1)).toMatchObject({ chatId: greeting.chatId, messageId: card.messageId, messageEventId: card.messageEventId, origin: 'sender_metadata' });
  });
});

describe('step 4: Suspected fraud', () => {
  it('recording a merchant confirmation after the link arrived adds the sender observation for the Suspected fraud finding', async () => {
    const report = await replay(h, loadFixture('merchant-conflict'), 0);
    const chatId = at(report.events, 0).chatId ?? '';
    const link = at(report.events, 1);
    await dispatch(h, [chatId]);
    await h.drain();
    expect((await timelineOf(h, chatId)).findings.map((f) => f.kind)).toEqual(['payment_link']);
    expect((await watchlistOf(h, h.tokens.officerA)).entries.filter((e) => e.number.e164 === '+447700900456')).toEqual([]);

    const confirmation = await h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/case-references`, {
      kind: 'merchant_payment_confirmation', paymentHosts: ['pay.merchant.example'], sourceNote: 'The merchant confirmed its payment host by phone.',
    });
    expect(confirmation.status, confirmation.text).toBe(201);
    const tl = await timelineOf(h, chatId);
    const fraud = tl.findings.find((f) => f.kind === 'suspected_fraud');
    expect(fraud?.messageId).toBe(link.messageId);
    const entry = await entryFor('+447700900456');
    expect(entry).toMatchObject({ number: { e164: '+447700900456', display: '+447700900456', exactMatchEligible: true }, status: 'needs_review', canReview: true });
    expect(entry.evidence).toEqual([{
      observationId: expect.any(String),
      chatId,
      messageId: link.messageId,
      messageEventId: fraud?.messageEventId,
      findingId: fraud?.id,
      origin: 'sender_metadata',
      sourceRepresentation: '+447700900456',
      reason: 'Sender of a message with a Suspected fraud finding',
      observedAt: tl.messages.find((m) => m.id === link.messageId)?.receivedAt,
    }]);
  });

  it('a sender number without country context is recorded under the chat\'s unnormalized key', async () => {
    const card = await senderChat({ raw: '07700 900457' });
    await dispatch(h, [card.chatId]);
    const link = await reviewedMessage(card.chatId, 2, 'Please settle the invoice here: https://pay.other-host.test/invoice/10');
    const confirmation = await h.http(h.tokens.officerA).post(`/v1/chats/${card.chatId}/case-references`, {
      kind: 'merchant_payment_confirmation', paymentHosts: ['pay.merchant.example'], sourceNote: 'The merchant confirmed its payment host by phone.',
    });
    expect(confirmation.body.data.findingsCreated).toBe(1);
    const [entry, ...others] = await entriesSupportedBy(card.chatId);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ number: { e164: null, display: '07700 900457', exactMatchEligible: false } });
    expect(entry?.evidence).toEqual([expect.objectContaining({ messageId: link.messageId, origin: 'sender_metadata', sourceRepresentation: '07700 900457' })]);
  });

  it('a Suspected fraud finding on the message that first supplied the sender\'s number is recorded, flags a decided entry and lets an officer who can open that chat review', async () => {
    // The message gets its finding either way: the confirmation is recorded after the link was found, or it is already on
    // file when the message arrives (the host registered the chat first) and its review publishes.
    const cases = [
      { e164: '+447700900458', spaced: '+44 7700 900458', confirmationFirst: false },
      { e164: '+447700900459', spaced: '+44 7700 900459', confirmationFirst: true },
    ];
    const recordConfirmation = (chatId: string): Promise<ApiResponse> => h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/case-references`, {
      kind: 'merchant_payment_confirmation', paymentHosts: ['pay.merchant.example'], sourceNote: 'The merchant confirmed its payment host by phone.',
    });
    for (const { e164, spaced, confirmationFirst } of cases) {
      const label = confirmationFirst ? 'confirmation on file when the review publishes' : 'confirmation recorded after the link';
      // The entry is supported by a chat on the officer account, which officer C has no grant on.
      const { entry } = await approvedEntryFor(e164, spaced, h.accounts.officer);
      const externalChatId = uniqueId('wl-fraud-sender-');
      if (confirmationFirst) {
        const registered = await h.http(h.tokens.officerA).post('/v1/chats', { ...h.accounts.intake, externalChatId, displayLabel: 'Test Contact' });
        expect(registered.status, registered.text).toBe(201);
        expect((await recordConfirmation(registered.body.data.chat.id)).body.data.findingsCreated, label).toBe(0);
      }
      // A host connector supplies the sender's number on a first message that carries an unconfirmed payment link.
      const first = await ingest(h.accounts.intake, externalChatId, recorded({
        messageId: 1, text: 'Please settle the invoice here: https://pay.other-host.test/invoice/12',
        sender: { externalId: uniqueId('u'), displayName: 'Test Contact', phone: { raw: e164, internationalFormat: true } },
      }));
      if (!confirmationFirst) {
        await dispatch(h, [first.chatId]);
        await h.drain();
      }
      const sighted = await entryFor(e164);
      const sightings = sighted.evidence.filter((e) => e.messageEventId === first.messageEventId);
      expect(sightings.map((e) => [e.origin, e.findingId, e.reason]), label).toEqual([['sender_metadata', null, 'Sender of an inbound chat']]);

      // An officer decides on the entry before the finding exists; officer C sees the entry only through the sighting.
      const cleared = await review(entry.id, 'clear', sighted.revision);
      expect(cleared.status, cleared.text).toBe(200);
      const before = await watchlistOf(h, h.tokens.officerC);
      expect(before.entries.find((e) => e.id === entry.id), label).toMatchObject({ canReview: false, lastDecision: { reason: null } });

      const stream = await openStream(h.baseUrl, h.tokens.officerC, { cursor: before.cursor });
      try {
        if (confirmationFirst) {
          await dispatch(h, [first.chatId]);
          await h.drain();
        } else {
          expect((await recordConfirmation(first.chatId)).body.data.findingsCreated, label).toBe(1);
        }
        const fraud = (await timelineOf(h, first.chatId)).findings.find((f) => f.kind === 'suspected_fraud');
        expect(fraud?.messageEventId, label).toBe(first.messageEventId);

        // The sender observation of that message now carries the finding, and the decided entry is flagged.
        const after = await entryFor(e164);
        expect(after.evidence.filter((e) => e.messageEventId === first.messageEventId), label).toEqual([{
          ...at(sightings, 0), findingId: fraud?.id, reason: 'Sender of a message with a Suspected fraud finding',
        }]);
        expect(after, label).toMatchObject({ status: 'cleared', revision: cleared.body.data.entry.revision, newEvidenceSinceReview: true });
        expect((await stream.next(entryEvent(entry.id))).data, label).toMatchObject({ watchlistEntryId: entry.id, status: 'cleared', reason: 'observation_added' });

        // That evidence lies in a chat officer C can open, so C may now read the decision reason and review the entry.
        const asC = await entryFor(e164, h.tokens.officerC);
        expect(asC, label).toMatchObject({ canReview: true, lastDecision: { decision: 'clear', reason: DECISION_REASON } });
        const reopened = await review(entry.id, 'reopen', asC.revision, h.tokens.officerC);
        expect(reopened.status, reopened.text).toBe(200);
      } finally {
        stream.close();
      }
    }
  });
});

describe('step 4: scope', () => {
  it('entries, matches and evidence links stay within the caller\'s scope', async () => {
    // E1 is supported by a chat on the officer account; officer C has a grant on the intake account only.
    const { entry: e1, mention } = await approvedEntryFor('+447700900321', '+44 7700 900321', h.accounts.officer);
    await reviewedChat('Transfer the fee to +44 7700 900322.', h.accounts.officer);
    const e2 = await entryFor('+447700900322');
    const intakeSender = await senderChat({ raw: '+447700900321', internationalFormat: true });
    const officerSender = await senderChat({ raw: '+447700900321', internationalFormat: true }, h.accounts.officer);

    const asA = await entryFor('+447700900321');
    expect(asA.evidence.map((e) => e.chatId)).toEqual([mention.chatId, intakeSender.chatId, officerSender.chatId]);
    expect(asA).toMatchObject({ restrictedEvidence: false, canReview: true, number: { display: '+44 7700 900321' } });
    expect(asA.matches.map((m) => m.chatId)).toEqual([intakeSender.chatId, officerSender.chatId]);

    // Officer C sees E1 only through the intake chat, never E2, and the hidden evidence is flagged. The number is shown
    // as that chat wrote it: how the officer-account chat wrote it is evidence C cannot open.
    const asC = (await watchlistOf(h, h.tokens.officerC)).entries;
    expect(asC.map((entry) => entry.id)).toContain(e1.id);
    expect(asC.map((entry) => entry.id)).not.toContain(e2.id);
    const e1AsC = asC.find((entry) => entry.id === e1.id);
    expect(e1AsC?.evidence.map((e) => e.chatId)).toEqual([intakeSender.chatId]);
    expect(e1AsC).toMatchObject({
      restrictedEvidence: true, canReview: false, matches: [{ chatId: intakeSender.chatId, matchedAt: expect.any(String) }], number: { display: '+447700900321' },
    });
    expect(await matchesShownIn(intakeSender.chatId, h.tokens.officerC)).toEqual([expect.objectContaining({
      entryId: e1.id, numberDisplay: '+447700900321', restrictedEvidence: true,
      evidence: [expect.objectContaining({ chatId: intakeSender.chatId, origin: 'sender_metadata' })],
    })]);
    const refusedC = await review(e1.id, 'clear', asA.revision, h.tokens.officerC);
    expect([refusedC.status, refusedC.body.error.code]).toEqual([403, 'evidence_access_required']);
    const hiddenC = await review(e2.id, 'clear', e2.revision, h.tokens.officerC);
    expect([hiddenC.status, hiddenC.body.error.code]).toEqual([404, 'watchlist_entry_not_found']);
    // An inaccessible entry is reported before the body is looked at.
    const unread = await h.http(h.tokens.officerC).post(`/v1/watchlist/${e2.id}/review`, {});
    expect([unread.status, unread.body.error.code]).toEqual([404, 'watchlist_entry_not_found']);

    // The outsider's workspace has no entries and cannot reach this one.
    expect((await watchlistOf(h, h.tokens.outsider)).entries).toEqual([]);
    const outsider = await review(e1.id, 'clear', asA.revision, h.tokens.outsider);
    expect([outsider.status, outsider.body.error.code]).toEqual([404, 'watchlist_entry_not_found']);
    expect((await entryFor('+447700900321')).revision).toBe(asA.revision);
  });

  it('the decision reason is hidden from a caller who can see the entry only through a match', async () => {
    const { entry } = await approvedEntryFor('+447700900323', '+44 7700 900323', h.accounts.officer);
    await senderChat({ raw: '+447700900323', internationalFormat: true });
    const decision = { decision: 'approve', officer: { id: await principalId(h.tokens.officerA), displayName: 'Officer A' }, decidedAt: entry.lastDecision?.decidedAt };

    expect((await entryFor('+447700900323')).lastDecision).toEqual({ ...decision, reason: DECISION_REASON });
    expect(await entryFor('+447700900323', h.tokens.officerC)).toMatchObject({ lastDecision: { ...decision, reason: null }, canReview: false });

    // Once officer C can open supporting evidence (a mention in an intake chat), C may review and read the reason.
    await reviewedChat('Please pay the deposit to +44 7700 900323 as well.');
    expect(await entryFor('+447700900323', h.tokens.officerC)).toMatchObject({ lastDecision: { ...decision, reason: DECISION_REASON }, canReview: true });
  });
});
