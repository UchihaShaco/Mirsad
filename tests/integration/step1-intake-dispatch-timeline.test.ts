import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectorCaptureMethod } from '../../src/contract/enums.ts';
import { provisionPrincipal } from '../../src/identity/provision.ts';
import { readDispatchBrief } from '../../src/services/dispatch.ts';
import * as watchlist from '../../src/services/watchlist.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { grantAccount } from '../../src/storage/repos/principals.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import { countRows, execSql, queryRows, storeSnapshot, streamEvents } from '../helpers/db-read.ts';
import { deleted, edited, envelope, recorded, uniqueId } from '../helpers/events.ts';

// Wrap the phone hook (a no-op stub until Task 7) in a spy that still calls the real function.
vi.mock('../../src/services/watchlist.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/watchlist.ts')>();
  return { ...actual, onContactPhoneKnown: vi.fn(actual.onContactPhoneKnown) };
});

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const connector = () => h.http(h.tokens.connector);
const officerA = () => h.http(h.tokens.officerA);

async function ingest(body: unknown, token = h.tokens.connector) {
  return h.http(token).post('/v1/ingest', body);
}

async function register(externalChatId: string, account: { source: 'telegram'; externalAccountId: string } = h.accounts.officer, token = h.tokens.officerA) {
  return h.http(token).post('/v1/chats', { ...account, externalChatId, displayLabel: 'Test Contact' });
}

async function dispatch(chatIds: string[], key = uniqueId('key-'), token = h.tokens.officerA) {
  return h.http(token).post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': key });
}

async function timeline(chatId: string, token = h.tokens.officerA) {
  return h.http(token).get(`/v1/chats/${chatId}/timeline`);
}

/** A further connector on the intake account with its own capture method; returns its token. */
function provisionConnector(captureMethod: ConnectorCaptureMethod): string {
  const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
  try {
    return db.transaction((tx) => {
      const account = tx.get<{ id: string; workspace_id: string }>(
        'SELECT id, workspace_id FROM channel_accounts WHERE external_account_id = :id',
        { id: h.accounts.intake.externalAccountId },
      );
      if (!account) throw new Error('intake_account_missing');
      const made = provisionPrincipal(tx, { workspaceId: account.workspace_id, kind: 'connector', displayName: `Test ${captureMethod} connector`, captureMethod });
      grantAccount(tx, made.principal.id, account.id);
      return made.token;
    });
  } finally {
    db.close();
  }
}

/** Row counts once the capture worker is idle, so its own writes cannot land between two snapshots. */
async function settledSnapshot() {
  await h.drain();
  return storeSnapshot(h.dataDir);
}

describe('step 1: intake, registry, dispatch and timeline', () => {
  it('creates a New inbound chat from its first incoming Telegram fixture message, registers an officer-first chat, dispatches both, and reads both timelines', async () => {
    const inboundChat = uniqueId('in-');
    const first = await ingest(
      envelope(h.accounts.intake, inboundChat, recorded({ messageId: 1, text: 'Good morning', sentAt: '2026-11-21T07:59:00.000Z', sender: { externalId: '9001', displayName: 'Test Contact' } })),
    );
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ chatCreated: true, result: 'recorded', startMarker: 'none', textConflict: false });
    const inboundId: string = first.body.data.chatId;
    expect(inboundId).toMatch(/^chat_[0-9a-f]{32}$/);
    expect(first.body.data.captureId).toMatch(/^cap_/);

    const registered = await register(uniqueId('out-'));
    expect(registered.status).toBe(201);
    expect(registered.body.data.created).toBe(true);
    const officerChatId: string = registered.body.data.chat.id;
    expect(registered.body.data.chat).toMatchObject({ inboxStatus: 'open', aiMode: 'not_started', originLabel: 'No messages observed' });
    const outgoing = await connector().post(
      `/v1/chats/${officerChatId}/events`,
      recorded({ messageId: 7, direction: 'outgoing', text: 'Hello from the officer account' }),
    );
    expect(outgoing.status).toBe(201);
    expect(outgoing.body.data).toMatchObject({ chatId: officerChatId, chatCreated: false, result: 'recorded' });

    const inbox = await officerA().get('/v1/chats?inboxStatus=new_inbound');
    expect(inbox.body.data.chats.map((c: { id: string }) => c.id)).toContain(inboundId);
    expect(inbox.body.data.chats.map((c: { id: string }) => c.id)).not.toContain(officerChatId);

    const dispatched = await dispatch([inboundId, officerChatId]);
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.data.dispatchId).toMatch(/^dsp_/);
    expect(dispatched.body.data.results).toEqual([
      { chatId: inboundId, status: 'started', aiMode: 'ai_active', revision: 2 },
      { chatId: officerChatId, status: 'started', aiMode: 'ai_active', revision: 2 },
    ]);

    // Dispatch queues the incoming message's review and the review worker runs it straight away; let it settle.
    await h.drain();
    const inTimeline = await timeline(inboundId);
    expect(inTimeline.status).toBe(200);
    expect(inTimeline.body.data.chat).toMatchObject({
      id: inboundId, channelLabel: 'Telegram', inboxStatus: 'open', aiMode: 'ai_active', originLabel: 'First observed: incoming',
      initiatedBy: 'unknown', firstObservedDirection: 'incoming', intakeAccount: true, acknowledgementTemplate: 'Message received.',
    });
    const [inMessage] = inTimeline.body.data.messages;
    expect(inMessage).toMatchObject({
      direction: 'incoming', origin: 'source', text: 'Good morning', sentAt: '2026-11-21T07:59:00.000Z', receivedAt: '2026-11-21T08:00:00.000Z',
      source: { channel: 'telegram', captureMethod: 'fixture_replay', sourceEventId: 'tg:u1001:m1', sourceMessageId: 'tg:1' },
      capture: { id: first.body.data.captureId, kind: 'mirsad_rendered_capture' },
      review: { status: 'completed', outcome: 'no_new_finding' },
    });
    expect(inTimeline.body.data).toMatchObject({ findings: [], caseReferences: [], messageEvents: [] });
    expect(inTimeline.body.data.caseActions.map((a: { type: string }) => a.type)).toEqual(['dispatch_started']);
    expect(Number(inTimeline.body.data.cursor)).toBeGreaterThan(0);

    const outTimeline = await timeline(officerChatId);
    expect(outTimeline.body.data.chat).toMatchObject({ originLabel: 'First observed: outgoing', intakeAccount: false, acknowledgementTemplate: null });
    const [outMessage] = outTimeline.body.data.messages;
    expect(outMessage).toMatchObject({ direction: 'outgoing', text: 'Hello from the officer account', capture: { id: outgoing.body.data.captureId }, review: null });
    expect(outTimeline.body.data.caseActions.map((a: { type: string }) => a.type)).toEqual(['chat_registered', 'dispatch_started']);
  });

  it('replaying the same inbound event leaves one chat and one message', async () => {
    const chat = uniqueId('dup-');
    const body = envelope(h.accounts.intake, chat, recorded({ messageId: 10 }));
    const first = await ingest(body);
    const replay = await ingest(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      chatId: first.body.data.chatId, chatCreated: false, result: 'duplicate_event', messageId: first.body.data.messageId,
      messageEventId: null, receivedAt: null, captureId: null,
    });
    expect(countRows(h.dataDir, 'chats', 'external_chat_id = :chat', { chat })).toBe(1);
    expect(countRows(h.dataDir, 'messages', 'chat_id = :id', { id: first.body.data.chatId })).toBe(1);
    expect(countRows(h.dataDir, 'message_events', 'chat_id = :id', { id: first.body.data.chatId })).toBe(1);
  });

  it('a new event id for an already stored source message creates no second message', async () => {
    const chat = uniqueId('dupmsg-');
    const first = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 11, updateId: 500 })));
    const again = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 11, updateId: 501 })));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ result: 'duplicate_message', messageId: first.body.data.messageId, messageEventId: null });
    const chatId = first.body.data.chatId;
    expect(countRows(h.dataDir, 'messages', 'chat_id = :chatId', { chatId })).toBe(1);
    expect(countRows(h.dataDir, 'message_events', 'chat_id = :chatId', { chatId })).toBe(1);
    expect(countRows(h.dataDir, 'captures', 'chat_id = :chatId', { chatId })).toBe(1);
  });

  it('a deletion event keeps the captured text and adds a separate deleted event', async () => {
    const chat = uniqueId('del-');
    const first = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 12, text: 'Original words' })));
    const chatId = first.body.data.chatId;
    const del = await connector().post(`/v1/chats/${chatId}/events`, deleted({ messageId: 12, updateId: 900 }));
    expect(del.status).toBe(201);
    expect(del.body.data).toMatchObject({ result: 'recorded', messageId: first.body.data.messageId, captureId: null });
    const tl = (await timeline(chatId)).body.data;
    expect(tl.messages).toHaveLength(1);
    expect(tl.messages[0]).toMatchObject({ text: 'Original words', deletedAtSource: true, capture: { id: first.body.data.captureId } });
    expect(tl.messageEvents).toEqual([
      expect.objectContaining({ type: 'deleted', messageId: first.body.data.messageId, text: null, sourceEventId: 'tg:u900:m12:del', capture: null, review: null }),
    ]);
    expect(streamEvents(h.dataDir, chatId).map((e) => e.type)).toContain('message.deleted');
  });

  it('an edit is stored as a separate event and the original text is unchanged', async () => {
    const chat = uniqueId('edit-');
    const first = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 13, text: 'First version' })));
    const chatId = first.body.data.chatId;
    const edit = await connector().post(`/v1/chats/${chatId}/events`, edited({ messageId: 13, updateId: 901, text: 'Second version', editedAt: '2026-11-21T07:58:00.000Z' }));
    expect(edit.status).toBe(201);
    expect(edit.body.data.captureId).toMatch(/^cap_/);
    const tl = (await timeline(chatId)).body.data;
    expect(tl.messages[0]).toMatchObject({ text: 'First version', editedAtSource: true });
    expect(tl.messageEvents).toEqual([
      expect.objectContaining({
        type: 'edited', text: 'Second version', sourceOccurredAt: '2026-11-21T07:58:00.000Z',
        capture: expect.objectContaining({ id: edit.body.data.captureId }), review: expect.objectContaining({ status: 'not_requested' }),
      }),
    ]);
    expect(streamEvents(h.dataDir, chatId).map((e) => e.type)).toContain('message.edited');
  });

  it('an edit for a message Mirsad never saw creates a placeholder, and the original arriving later fills it', async () => {
    const chat = uniqueId('ph-');
    const missingDirection = await ingest(envelope(h.accounts.intake, chat, edited({ messageId: 14, updateId: 902, text: 'Edited text' })));
    expect(missingDirection.status).toBe(422);
    expect(missingDirection.body.error.code).toBe('direction_required');
    expect(countRows(h.dataDir, 'chats', 'external_chat_id = :chat', { chat })).toBe(0);

    const edit = await ingest(envelope(h.accounts.intake, chat, edited({ messageId: 14, updateId: 902, text: 'Edited text', direction: 'incoming' })));
    expect(edit.status).toBe(201);
    const chatId = edit.body.data.chatId;
    let tl = (await timeline(chatId)).body.data;
    expect(tl.chat.inboxStatus).toBe('new_inbound');
    expect(tl.messages[0]).toMatchObject({ originalCaptured: false, text: null, direction: 'incoming', editedAtSource: true, capture: null });
    expect(tl.messageEvents[0]).toMatchObject({ type: 'edited', text: 'Edited text' });

    const original = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 14, updateId: 800, text: 'Original text' })));
    expect(original.status).toBe(201);
    expect(original.body.data).toMatchObject({ result: 'recorded', messageId: edit.body.data.messageId });
    tl = (await timeline(chatId)).body.data;
    expect(tl.messages).toHaveLength(1);
    expect(tl.messages[0]).toMatchObject({ originalCaptured: true, text: 'Original text', editedAtSource: true, capture: { id: original.body.data.captureId } });
    expect(tl.messageEvents[0]).toMatchObject({ type: 'edited', text: 'Edited text' });
  });

  it('a partial transcript shows First observed: incoming with initiatedBy unknown', async () => {
    const chat = uniqueId('partial-');
    const res = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 220 })));
    const summary = (await timeline(res.body.data.chatId)).body.data.chat;
    expect(summary).toMatchObject({ originLabel: 'First observed: incoming', initiatedBy: 'unknown', initiationBasis: null, firstObservedDirection: 'incoming' });
    const outChat = uniqueId('partial-out-');
    const out = await ingest(envelope(h.accounts.officer, outChat, recorded({ messageId: 221, direction: 'outgoing' })));
    const outSummary = (await timeline(out.body.data.chatId)).body.data.chat;
    expect(outSummary).toMatchObject({ originLabel: 'First observed: outgoing', initiatedBy: 'unknown', inboxStatus: 'open' });
  });

  it('a chat created by an outgoing first event is never labelled with that sender\'s name; an incoming one is', async () => {
    const outChat = uniqueId('label-out-');
    const out = await ingest(envelope(h.accounts.officer, outChat, recorded({
      messageId: 230, direction: 'outgoing', sender: { externalId: '5000', displayName: 'Demo Officer Account Owner' },
    })));
    expect(out.status).toBe(201);
    expect((await timeline(out.body.data.chatId)).body.data.chat.displayLabel).toBe(`Telegram chat ${outChat}`);

    const inChat = uniqueId('label-in-');
    const incoming = await ingest(envelope(h.accounts.intake, inChat, recorded({ messageId: 231, sender: { externalId: '5001', displayName: 'Test Contact' } })));
    expect((await timeline(incoming.body.data.chatId)).body.data.chat.displayLabel).toBe('Test Contact');
  });

  it('a trusted start marker yields Contact started chat, an outgoing one Officer started chat, and an untrusted or conflicting marker is ignored', async () => {
    const marker = { basis: 'source_start_marker' as const };
    const contact = await ingest(envelope(h.accounts.intake, uniqueId('m-in-'), recorded({ messageId: 30, conversationStart: marker })));
    expect(contact.body.data.startMarker).toBe('accepted');
    expect((await timeline(contact.body.data.chatId)).body.data.chat).toMatchObject({
      originLabel: 'Contact started chat', initiatedBy: 'contact', initiationBasis: 'source_start_marker', firstObservedDirection: 'incoming',
    });

    const officerFirst = await ingest(envelope(h.accounts.officer, uniqueId('m-out-'), recorded({ messageId: 31, direction: 'outgoing', conversationStart: { basis: 'confirmed_complete_history' } })));
    expect(officerFirst.body.data.startMarker).toBe('accepted');
    expect((await timeline(officerFirst.body.data.chatId)).body.data.chat).toMatchObject({ originLabel: 'Officer started chat', initiatedBy: 'officer', initiationBasis: 'confirmed_complete_history' });

    const untrusted = await ingest(envelope(h.accounts.live, uniqueId('m-live-'), recorded({ messageId: 32, conversationStart: marker })), h.tokens.liveConnector);
    expect(untrusted.body.data.startMarker).toBe('ignored_untrusted');
    expect((await timeline(untrusted.body.data.chatId)).body.data.chat).toMatchObject({ originLabel: 'First observed: incoming', initiatedBy: 'unknown' });

    const second = await connector().post(`/v1/chats/${contact.body.data.chatId}/events`, recorded({ messageId: 33, direction: 'outgoing', conversationStart: marker }));
    expect(second.body.data.startMarker).toBe('ignored_conflict');
    expect((await timeline(contact.body.data.chatId)).body.data.chat.initiatedBy).toBe('contact');
  });

  it('a benign inbound greeting lands in the New inbound list, publishes chat.created and, once dispatched, is reviewed with no finding', async () => {
    const res = await ingest(envelope(h.accounts.intake, uniqueId('greet-'), recorded({ messageId: 40, text: 'Hi, good evening!' })));
    const chatId = res.body.data.chatId;
    const inbox = await officerA().get('/v1/chats?inboxStatus=new_inbound');
    const listed = inbox.body.data.chats.find((c: { id: string }) => c.id === chatId);
    expect(listed).toMatchObject({ inboxStatus: 'new_inbound', messageCount: 1 });
    const created = streamEvents(h.dataDir, chatId).filter((e) => e.type === 'chat.created');
    expect(created).toEqual([expect.objectContaining({ chatId, data: { inboxStatus: 'new_inbound' } })]);
    // Without a dispatch the review stays not_requested, and no finding would prove nothing about the greeting.
    expect((await dispatch([chatId])).status).toBe(200);
    await h.drain();
    const tl = (await timeline(chatId)).body.data;
    expect(tl.messages[0].review).toMatchObject({ status: 'completed', outcome: 'no_new_finding' });
    expect(tl.findings).toEqual([]);
    expect(countRows(h.dataDir, 'findings', 'chat_id = :chatId', { chatId })).toBe(0);
  });

  it('every stored source message has a pending capture row created with it', async () => {
    const chat = uniqueId('cap-');
    const a = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 50, text: 'One' })));
    const chatId = a.body.data.chatId;
    await connector().post(`/v1/chats/${chatId}/events`, recorded({ messageId: 51, direction: 'outgoing', text: 'Two' }));
    await connector().post(`/v1/chats/${chatId}/events`, recorded({ messageId: 52, text: '', unsupportedContent: ['photo'] }));
    const rows = queryRows<{ message_event_id: string; status: string; created_at: string; received_at: string }>(
      h.dataDir,
      `SELECT c.message_event_id, c.status, c.created_at, e.received_at FROM message_events e
       LEFT JOIN captures c ON c.message_event_id = e.id WHERE e.chat_id = :chatId`,
      { chatId },
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // Created pending with the event; the capture worker may already have moved it on.
      expect(row.status).toMatch(/^(pending|rendering|ready)$/);
      expect(row.created_at).toBe(row.received_at);
    }
  });

  it('dispatch validates access to the whole selection before changing any chat', async () => {
    const intakeChat = (await ingest(envelope(h.accounts.intake, uniqueId('sel-'), recorded({ messageId: 60 })))).body.data.chatId;
    const officerChat = (await register(uniqueId('sel-out-'))).body.data.chat.id;
    const before = await settledSnapshot();
    const res = await dispatch([intakeChat, officerChat, 'chat_00000000000000000000000000000000'], uniqueId('k-'), h.tokens.officerC);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'chat_not_found', details: { chatIds: [officerChat, 'chat_00000000000000000000000000000000'] } });
    expect(storeSnapshot(h.dataDir)).toEqual(before);
    expect((await timeline(intakeChat)).body.data.chat).toMatchObject({ aiMode: 'not_started', revision: 1, inboxStatus: 'new_inbound' });
  });

  it('records one chat briefing privately, rejects saving on paused chats, and clears it explicitly', async () => {
    const first = (await register(uniqueId('brief-'))).body.data.chat.id;
    const other = (await register(uniqueId('brief-'))).body.data.chat.id;
    const note = 'The officer was told the offer involves an upfront charge.';
    const submit = (chatIds: string[], officerContext: string | null, token = h.tokens.officerA) =>
      h.http(token).post('/v1/dispatches', { chatIds, officerContext }, { 'Idempotency-Key': uniqueId('brief-key-') });
    const storedBrief = (chatId: string) => {
      const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
      try { return db.transaction((tx) => readDispatchBrief(tx, chatId)); }
      finally { db.close(); }
    };
    expect((await submit([first, other], note)).status).toBe(400);
    expect((await submit([first], note, h.tokens.outsider)).status).toBe(404);
    expect(storedBrief(first)).toBeNull();
    const assigned = await submit([first], '  ' + note + '  ');
    expect(assigned.status).toBe(200);
    expect(storedBrief(first)).toBe(note);
    expect(storedBrief(other)).toBeNull();
    expect(JSON.stringify(assigned.body)).not.toContain(note);
    expect(JSON.stringify((await timeline(first)).body)).not.toContain(note);
    expect((await dispatch([first])).status).toBe(200);
    expect(storedBrief(first)).toBe(note);
    expect((await submit([first], null)).status).toBe(200);
    expect(storedBrief(first)).toBeNull();
    expect((await officerA().post('/v1/chats/' + first + '/control', { action: 'pause', expectedRevision: 2 })).status).toBe(200);
    expect((await submit([first], note)).status).toBe(409);
    expect(storedBrief(first)).toBeNull();
  });

  it('creates a localized review-only opening draft and rejects an outbound destination', async () => {
    const route = '/v1/investigation-opener';
    const request = { officerContext: 'Example: a reported upfront fee with ref SYNTHETIC-MARKER.', language: 'english' };
    expect((await connector().post(route, request)).status).toBe(403);
    expect((await officerA().post(route, { ...request, recipient: 'synthetic-target' })).status).toBe(400);
    const before = await settledSnapshot();
    const english = await officerA().post(route, request);
    expect(english.status).toBe(200);
    expect(english.body.data.draft).toContain('upfront costs');
    expect(english.body.data.draft).not.toContain('SYNTHETIC-MARKER');
    const arabic = await officerA().post(route, { ...request, language: 'arabic' });
    expect(arabic.status).toBe(200);
    expect(arabic.body.data.draft).toContain('رسوم');
    expect(await settledSnapshot()).toEqual(before);
  });

  it('dispatch reports started and already_active per chat and records the operator', async () => {
    const a = (await ingest(envelope(h.accounts.intake, uniqueId('op-'), recorded({ messageId: 61 })))).body.data.chatId;
    const b = (await ingest(envelope(h.accounts.intake, uniqueId('op-'), recorded({ messageId: 62 })))).body.data.chatId;
    await dispatch([a]);
    const res = await dispatch([a, b], uniqueId('k-'), h.tokens.officerB);
    expect(res.body.data.results).toEqual([
      { chatId: a, status: 'already_active', aiMode: 'ai_active', revision: 2 },
      { chatId: b, status: 'started', aiMode: 'ai_active', revision: 2 },
    ]);
    const actionsA = (await timeline(a)).body.data.caseActions;
    expect(actionsA).toEqual([expect.objectContaining({ type: 'dispatch_started', actor: expect.objectContaining({ displayName: 'Officer A' }), fromMode: 'not_started', toMode: 'ai_active', revision: 2, occurredAt: '2026-11-21T08:00:00.000Z' })]);
    const actionsB = (await timeline(b)).body.data.caseActions;
    expect(actionsB).toEqual([expect.objectContaining({ type: 'dispatch_started', actor: expect.objectContaining({ displayName: 'Officer B' }) })]);
  });

  it('dispatch replays a repeated Idempotency-Key, rejects a reused key with another body, and requires the header', async () => {
    const a = (await ingest(envelope(h.accounts.intake, uniqueId('idem-'), recorded({ messageId: 63 })))).body.data.chatId;
    const b = (await ingest(envelope(h.accounts.intake, uniqueId('idem-'), recorded({ messageId: 64 })))).body.data.chatId;
    const key = uniqueId('key-');
    const first = await dispatch([a], key);
    const replay = await dispatch([a], key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    expect(countRows(h.dataDir, 'case_actions', "chat_id = :a AND type = 'dispatch_started'", { a })).toBe(1);

    const reused = await dispatch([b], key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
    expect((await timeline(b)).body.data.chat.aiMode).toBe('not_started');

    const missing = await officerA().post('/v1/dispatches', { chatIds: [b] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('idempotency_key_required');
    expect((await timeline(b)).body.data.chat.aiMode).toBe('not_started');
  });

  it('intake for an account outside the connector\'s grants is 403 and stores nothing', async () => {
    const before = await settledSnapshot();
    const live = await ingest(envelope(h.accounts.live, uniqueId('nogrant-'), recorded({ messageId: 70 })));
    expect(live.status).toBe(403);
    expect(live.body.error.code).toBe('account_not_authorized');
    const unknown = await ingest(envelope({ source: 'telegram', externalAccountId: 'tg-unknown-9' }, uniqueId('nogrant-'), recorded({ messageId: 71 })));
    expect(unknown.status).toBe(403);
    expect(unknown.body.error.code).toBe('account_not_authorized');
    const liveChat = (await ingest(envelope(h.accounts.live, uniqueId('livechat-'), recorded({ messageId: 72 })), h.tokens.liveConnector)).body.data.chatId;
    const snapshot = await settledSnapshot();
    const foreign = await connector().post(`/v1/chats/${liveChat}/events`, recorded({ messageId: 73 }));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('chat_not_found');
    expect(storeSnapshot(h.dataDir)).toEqual(snapshot);
    expect(snapshot.chats).toBe((before.chats ?? 0) + 1);
  });

  it('registering the same conversation twice returns the same chatId', async () => {
    const external = uniqueId('reg-');
    const first = await register(external);
    const second = await register(external);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ created: false, chat: { id: first.body.data.chat.id } });
    const third = await register(external, h.accounts.officer, h.tokens.officerB);
    expect(third.body.data.chat.id).toBe(first.body.data.chat.id);
    expect(countRows(h.dataDir, 'case_actions', "chat_id = :id AND type = 'chat_registered'", { id: first.body.data.chat.id })).toBe(1);
  });

  it('registering a chat needs a grant on the account, publishes chat.created and records chat_registered', async () => {
    const before = await settledSnapshot();
    const denied = await register(uniqueId('reg-'), h.accounts.officer, h.tokens.officerC);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe('account_not_found');
    const outsider = await register(uniqueId('reg-'), h.accounts.intake, h.tokens.outsider);
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe('account_not_found');
    expect(storeSnapshot(h.dataDir)).toEqual(before);

    const ok = await register(uniqueId('reg-'));
    const chatId = ok.body.data.chat.id;
    const events = streamEvents(h.dataDir, chatId);
    expect(events.map((e) => e.type)).toEqual(['chat.created', 'case_action.recorded']);
    expect(events[0]?.data).toEqual({ inboxStatus: 'open' });
    const actions = (await timeline(chatId)).body.data.caseActions;
    expect(actions).toEqual([expect.objectContaining({ type: 'chat_registered', actor: expect.objectContaining({ displayName: 'Officer A' }) })]);
    expect(events[1]?.data).toEqual({ caseActionId: actions[0].id, actionType: 'chat_registered' });
  });

  it('a redelivered message with different text is kept as a conflicting_copy event with its own capture row, and the original text is unchanged', async () => {
    const chat = uniqueId('conf-');
    const first = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 80, updateId: 600, text: 'Pay to account A' })));
    const chatId = first.body.data.chatId;
    const copy = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 80, updateId: 601, text: 'Pay to account B' })));
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({ result: 'conflicting_copy', textConflict: true, messageId: first.body.data.messageId });
    expect(copy.body.data.captureId).toMatch(/^cap_/);
    expect(copy.body.data.captureId).not.toBe(first.body.data.captureId);
    const tl = (await timeline(chatId)).body.data;
    expect(tl.messages).toHaveLength(1);
    expect(tl.messages[0].text).toBe('Pay to account A');
    expect(tl.messageEvents).toEqual([
      expect.objectContaining({ type: 'conflicting_copy', text: 'Pay to account B', capture: expect.objectContaining({ id: copy.body.data.captureId }), review: expect.objectContaining({ status: 'not_requested' }) }),
    ]);
    expect(tl.caseActions.map((a: { type: string }) => a.type)).toEqual(['text_conflict_recorded']);
    expect(streamEvents(h.dataDir, chatId).map((e) => e.type)).toContain('message.conflicting_copy');
  });

  it('the same differing copy delivered again under a new event id is a duplicate, while a further different copy is kept', async () => {
    const chat = uniqueId('conf-dup-');
    const first = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 81, updateId: 610, text: 'Pay to account A' })));
    const chatId = first.body.data.chatId;
    const copy = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 81, updateId: 611, text: 'Pay to account B' })));
    expect(copy.body.data.result).toBe('conflicting_copy');

    const again = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 81, updateId: 612, text: 'Pay to account B' })));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({
      result: 'duplicate_message', messageId: first.body.data.messageId, messageEventId: null, captureId: null, textConflict: false,
    });
    const other = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 81, updateId: 613, text: 'Pay to account C' })));
    expect(other.body.data.result).toBe('conflicting_copy');

    expect(countRows(h.dataDir, 'message_events', "chat_id = :chatId AND type = 'conflicting_copy'", { chatId })).toBe(2);
    expect(countRows(h.dataDir, 'case_actions', "chat_id = :chatId AND type = 'text_conflict_recorded'", { chatId })).toBe(2);
    expect(countRows(h.dataDir, 'captures', 'chat_id = :chatId', { chatId })).toBe(3);
    expect(countRows(h.dataDir, 'reviews', 'chat_id = :chatId', { chatId })).toBe(3);
  });

  it('a dispatch that starts a chat bumps its revision, moves it out of New inbound and publishes chat.control_changed', async () => {
    const chatId = (await ingest(envelope(h.accounts.intake, uniqueId('start-'), recorded({ messageId: 90 })))).body.data.chatId;
    await dispatch([chatId]);
    const summary = (await timeline(chatId)).body.data.chat;
    expect(summary).toMatchObject({ revision: 2, inboxStatus: 'open', aiMode: 'ai_active', controller: null });
    const inbox = await officerA().get('/v1/chats?inboxStatus=new_inbound');
    expect(inbox.body.data.chats.map((c: { id: string }) => c.id)).not.toContain(chatId);
    const changed = streamEvents(h.dataDir, chatId).filter((e) => e.type === 'chat.control_changed');
    expect(changed).toEqual([expect.objectContaining({ data: { aiMode: 'ai_active', revision: 2 } })]);
  });

  it('each contact field is filled the first time an incoming message carries it, and the phone hook runs once', async () => {
    const hook = vi.mocked(watchlist.onContactPhoneKnown);
    hook.mockClear();
    const chat = uniqueId('contact-');
    const chatId = (await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 100, sender: { externalId: '7001' } })))).body.data.chatId;
    const events = h.http(h.tokens.connector);
    await events.post(`/v1/chats/${chatId}/events`, recorded({ messageId: 101, direction: 'outgoing', sender: { displayName: 'Demo Officer 1', phone: { raw: '+44 7700 900111' } } }));
    await events.post(`/v1/chats/${chatId}/events`, recorded({ messageId: 102, sender: { externalId: '7999', displayName: 'Test Contact', phone: { raw: '+44 7700 900123', internationalFormat: true } } }));
    await events.post(`/v1/chats/${chatId}/events`, recorded({ messageId: 103, sender: { displayName: 'Other Name', phone: { raw: '+44 7700 900456' } } }));
    const [row] = queryRows<Record<string, string | null>>(h.dataDir, 'SELECT contact_external_id, contact_display_name, contact_phone_raw FROM chats WHERE id = :chatId', { chatId });
    expect(row).toEqual({ contact_external_id: '7001', contact_display_name: 'Test Contact', contact_phone_raw: '+44 7700 900123' });
    expect(hook).toHaveBeenCalledTimes(1);
    const [, ctx, phone] = hook.mock.calls[0] ?? [];
    expect(phone).toEqual({ raw: '+44 7700 900123', internationalFormat: true });
    expect(ctx?.chat.id).toBe(chatId);
    expect(ctx?.message.source_message_id).toBe('tg:102');
    expect(ctx?.messageEvent.type).toBe('recorded');
  });

  it('a start marker is ignored when an earlier or undated source message is already stored', async () => {
    const marker = { basis: 'source_start_marker' as const };
    const earlierChat = uniqueId('earlier-');
    await ingest(envelope(h.accounts.intake, earlierChat, recorded({ messageId: 110, sentAt: '2026-11-21T07:00:00.000Z' })));
    const late = await ingest(envelope(h.accounts.intake, earlierChat, recorded({ messageId: 111, sentAt: '2026-11-21T07:30:00.000Z', conversationStart: marker })));
    expect(late.body.data.startMarker).toBe('ignored_conflict');

    const undatedChat = uniqueId('undated-');
    await ingest(envelope(h.accounts.intake, undatedChat, recorded({ messageId: 112 })));
    const dated = await ingest(envelope(h.accounts.intake, undatedChat, recorded({ messageId: 113, sentAt: '2026-11-21T06:00:00.000Z', conversationStart: marker })));
    expect(dated.body.data.startMarker).toBe('ignored_conflict');
    expect((await timeline(dated.body.data.chatId)).body.data.chat.initiatedBy).toBe('unknown');

    const laterChat = uniqueId('later-');
    await ingest(envelope(h.accounts.intake, laterChat, recorded({ messageId: 114, sentAt: '2026-11-21T07:45:00.000Z' })));
    const earliest = await ingest(envelope(h.accounts.intake, laterChat, recorded({ messageId: 115, sentAt: '2026-11-21T07:40:00.000Z', conversationStart: marker })));
    expect(earliest.body.data.startMarker).toBe('accepted');
    expect((await timeline(earliest.body.data.chatId)).body.data.chat.originLabel).toBe('Contact started chat');
  });

  it('live-captured Telegram content gets review status not_permitted even in an ai_active chat', async () => {
    const chat = uniqueId('live-');
    const live = h.http(h.tokens.liveConnector);
    const first = await live.post('/v1/ingest', envelope(h.accounts.live, chat, recorded({ messageId: 120 })));
    const chatId = first.body.data.chatId;
    await dispatch([chatId]);
    await live.post(`/v1/chats/${chatId}/events`, recorded({ messageId: 121, text: 'Second live message' }));
    const tl = (await timeline(chatId)).body.data;
    expect(tl.chat.aiMode).toBe('ai_active');
    expect(tl.messages.map((m: { review: { status: string } }) => m.review.status)).toEqual(['not_permitted', 'not_permitted']);
    expect(tl.messages[0].source.captureMethod).toBe('telegram_business_live');
  });

  it('a new incoming message in an ai_active chat requeues unavailable reviews with fewer than three attempts', async () => {
    const chat = uniqueId('retry-');
    const chatId = (await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 130 })))).body.data.chatId;
    await connector().post(`/v1/chats/${chatId}/events`, recorded({ messageId: 131 }));
    await dispatch([chatId]);
    // Let the review worker finish both reviews before they are forced to unavailable.
    await h.drain();
    const reviews = queryRows<{ id: string }>(h.dataDir, 'SELECT id FROM reviews WHERE chat_id = :chatId ORDER BY created_at, id', { chatId });
    expect(reviews).toHaveLength(2);
    execSql(h.dataDir, "UPDATE reviews SET status = 'unavailable', attempts = 2 WHERE id = :id", { id: reviews[0]?.id ?? '' });
    execSql(h.dataDir, "UPDATE reviews SET status = 'unavailable', attempts = 3 WHERE id = :id", { id: reviews[1]?.id ?? '' });
    expect((await timeline(chatId)).body.data.chat.review).toEqual({ state: 'unavailable', pending: 0, unavailable: 2 });

    await connector().post(`/v1/chats/${chatId}/events`, recorded({ messageId: 132 }));
    await h.drain();
    const statuses = queryRows<{ id: string; status: string }>(h.dataDir, 'SELECT id, status FROM reviews WHERE chat_id = :chatId', { chatId });
    const byId = new Map(statuses.map((r) => [r.id, r.status]));
    // Requeued and run again by the worker; the review with three attempts is left alone.
    expect(byId.get(reviews[0]?.id ?? '')).toBe('completed');
    expect(byId.get(reviews[1]?.id ?? '')).toBe('unavailable');
    expect(statuses.filter((r) => r.status === 'completed')).toHaveLength(2);
  });

  it('the chat list shows only accessible chats with channel, origin label, inbox status and AI mode', async () => {
    const intakeChat = (await ingest(envelope(h.accounts.intake, uniqueId('list-'), recorded({ messageId: 140 })))).body.data.chatId;
    const officerChat = (await register(uniqueId('list-out-'))).body.data.chat.id;
    const asC = await h.http(h.tokens.officerC).get('/v1/chats?limit=500');
    expect(asC.status).toBe(200);
    const idsC = asC.body.data.chats.map((c: { id: string }) => c.id);
    expect(idsC).toContain(intakeChat);
    expect(idsC).not.toContain(officerChat);
    expect(asC.body.meta).toEqual({ total: idsC.length, limit: 500, offset: 0 });
    expect(asC.body.data.chats.find((c: { id: string }) => c.id === intakeChat)).toMatchObject({
      channelLabel: 'Telegram', source: 'telegram', originLabel: 'First observed: incoming', inboxStatus: 'new_inbound', aiMode: 'not_started', externalAccountId: 'tg-intake-1',
    });
    const asA = await officerA().get('/v1/chats?limit=500');
    expect(asA.body.data.chats.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([intakeChat, officerChat]));
    expect(Number(asA.body.data.cursor)).toBeGreaterThan(0);
    const outsider = await h.http(h.tokens.outsider).get('/v1/chats');
    expect(outsider.body.data.chats).toEqual([]);
    expect(outsider.body.meta.total).toBe(0);
    const paged = await officerA().get('/v1/chats?limit=1&offset=1');
    expect(paged.body.data.chats).toHaveLength(1);
    expect((await officerA().get('/v1/chats?limit=0')).status).toBe(400);
  });

  it('the timeline of an inaccessible chat is 404 for a same-workspace officer without a grant and for another workspace', async () => {
    const officerChat = (await register(uniqueId('hidden-'))).body.data.chat.id;
    for (const token of [h.tokens.officerC, h.tokens.outsider]) {
      const res = await timeline(officerChat, token);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, data: null, error: expect.objectContaining({ code: 'chat_not_found' }) });
    }
    const missing = await timeline('chat_00000000000000000000000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('chat_not_found');
  });

  it('whatsapp intake is refused while the gate is closed', async () => {
    const before = await settledSnapshot();
    const res = await ingest(envelope({ source: 'whatsapp', externalAccountId: 'wa-demo-1' }, uniqueId('wa-'), recorded({ messageId: 150 })));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('channel_not_enabled');
    expect(storeSnapshot(h.dataDir)).toEqual(before);
  });

  it('malformed intake payloads are rejected and store nothing', async () => {
    const chat = uniqueId('bad-');
    const chatId = (await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 160 })))).body.data.chatId;
    const before = await settledSnapshot();
    const good = recorded({ messageId: 161 });
    const bad: unknown[] = [
      {},
      { ...envelope(h.accounts.intake, chat, good), source: 'signal' },
      envelope(h.accounts.intake, chat, { ...good, type: 'message.reacted' }),
      envelope(h.accounts.intake, chat, { ...good, direction: 'sideways' }),
      envelope(h.accounts.intake, chat, { ...good, sourceEventId: '' }),
      envelope(h.accounts.intake, chat, { ...good, text: 'x'.repeat(65_537) }),
      envelope(h.accounts.intake, chat, { ...good, sentAt: 'yesterday' }),
      envelope(h.accounts.intake, chat, { ...good, text: undefined }),
      envelope(h.accounts.intake, '', good),
    ];
    for (const body of bad) {
      const res = await ingest(body);
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    const notJson = await fetch(`${h.baseUrl}/v1/ingest`, { method: 'POST', headers: { authorization: `Bearer ${h.tokens.connector}`, 'content-type': 'application/json' }, body: '{not json' });
    expect(notJson.status).toBe(400);
    const badEvent = await connector().post(`/v1/chats/${chatId}/events`, { ...good, direction: 'up' });
    expect(badEvent.status).toBe(400);
    expect(storeSnapshot(h.dataDir)).toEqual(before);
  });

  it('receivedAt comes from the server clock and sentAt is stored as supplied', async () => {
    h.clock.set('2026-11-21T09:15:30.250Z');
    const res = await ingest(envelope(h.accounts.intake, uniqueId('time-'), { ...recorded({ messageId: 170, sentAt: '2026-11-21T12:10:00+04:00' }), receivedAt: '2001-01-01T00:00:00.000Z' }));
    expect(res.body.data.receivedAt).toBe('2026-11-21T09:15:30.250Z');
    const [message] = (await timeline(res.body.data.chatId)).body.data.messages;
    expect(message).toMatchObject({ receivedAt: '2026-11-21T09:15:30.250Z', sentAt: '2026-11-21T08:10:00.000Z' });
  });

  it('a placeholder filled by its original takes the receipt time and capture method of the recorded event', async () => {
    const hostConnector = provisionConnector('host_intake');
    const chat = uniqueId('ph-receipt-');
    const deletion = await ingest(envelope(h.accounts.intake, chat, deleted({ messageId: 240, updateId: 2400, direction: 'incoming' })));
    expect(deletion.status).toBe(201);
    h.clock.advance(60 * 60 * 1000);
    const original = await ingest(envelope(h.accounts.intake, chat, recorded({ messageId: 240, updateId: 2401, text: 'Original words' })), hostConnector);
    expect(original.status).toBe(201);
    expect(original.body.data.receivedAt).not.toBe(deletion.body.data.receivedAt);

    const [message] = (await timeline(original.body.data.chatId)).body.data.messages;
    expect(message).toMatchObject({
      id: deletion.body.data.messageId, text: 'Original words', originalCaptured: true, deletedAtSource: true,
      receivedAt: original.body.data.receivedAt, source: { captureMethod: 'host_intake' },
    });
  });

  it('message text never appears in application logs', async () => {
    const canary = `canary-${uniqueId()}-text`;
    const chatId = (await ingest(envelope(h.accounts.intake, uniqueId('log-'), recorded({ messageId: 180, text: canary, sender: { displayName: `${canary}-name`, phone: { raw: '+44 7700 900999' } } })))).body.data.chatId;
    await connector().post(`/v1/chats/${chatId}/events`, edited({ messageId: 180, updateId: 1801, text: `${canary}-edit` }));
    await connector().post(`/v1/chats/${chatId}/events`, recorded({ messageId: 180, updateId: 1802, text: `${canary}-copy` }));
    await dispatch([chatId]);
    await timeline(chatId);
    await h.drain();
    const logs = h.logs.join('\n');
    expect(logs).not.toContain(canary);
    expect(logs).not.toContain('7700 900999');
    const streamData = JSON.stringify(streamEvents(h.dataDir));
    expect(streamData).not.toContain(canary);
  });
});
