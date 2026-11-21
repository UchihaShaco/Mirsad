import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Timeline } from '../../src/contract/schemas.ts';
import { startHarness, type ApiResponse, type TestHarness } from '../helpers/harness.ts';
import { countRows, streamEvents } from '../helpers/db-read.ts';
import { edited, envelope, recorded, uniqueId } from '../helpers/events.ts';
import { openStream } from '../helpers/sse-client.ts';

// Count wake-ups of the review worker while still calling the real loop.
const reviewWorker = vi.hoisted(() => ({ wakes: 0 }));
vi.mock('../../src/workers/review-worker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workers/review-worker.ts')>();
  return {
    ...actual,
    createReviewWorker: (...args: Parameters<typeof actual.createReviewWorker>) => {
      const loop = actual.createReviewWorker(...args);
      return {
        ...loop,
        wake: () => {
          reviewWorker.wakes += 1;
          loop.wake();
        },
      };
    },
  };
});

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Account = { source: 'telegram'; externalAccountId: string };
type ControlAction = 'pause' | 'take_over' | 'resume';

async function principalId(token: string): Promise<string> {
  return (await h.http(token).get('/v1/me')).body.data.principal.id;
}

/** A new chat created by its first incoming message (source message `tg:1`). */
async function newInboundChat(account: Account = h.accounts.intake): Promise<{ chatId: string; messageId: string }> {
  const res = await h.http(h.tokens.connector).post(
    '/v1/ingest',
    envelope(account, uniqueId('chat-'), recorded({ messageId: 1, text: 'Hello, I need some help.' })),
  );
  expect(res.status).toBe(201);
  return { chatId: res.body.data.chatId, messageId: res.body.data.messageId };
}

async function control(chatId: string, action: ControlAction, expectedRevision: number, token = h.tokens.officerA): Promise<ApiResponse> {
  return h.http(token).post(`/v1/chats/${chatId}/control`, { action, expectedRevision });
}

async function compose(
  chatId: string,
  text: string,
  expectedRevision: number,
  token = h.tokens.officerA,
  key = uniqueId('compose-'),
): Promise<ApiResponse> {
  return h.http(token).post(`/v1/chats/${chatId}/officer-messages`, { text, expectedRevision }, { 'Idempotency-Key': key });
}

async function timeline(chatId: string, token = h.tokens.officerA): Promise<Timeline> {
  return (await h.http(token).get(`/v1/chats/${chatId}/timeline`)).body.data as Timeline;
}

/** An inbound chat that officer A has taken over from not_started (revision 2). */
async function chatUnderTakeover(account: Account = h.accounts.intake) {
  const chat = await newInboundChat(account);
  const taken = await control(chat.chatId, 'take_over', 1);
  expect(taken.status).toBe(200);
  return { ...chat, revision: taken.body.data.chat.revision as number };
}

async function dispatch(chatIds: string[], token = h.tokens.officerA): Promise<ApiResponse> {
  return h.http(token).post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': uniqueId('dispatch-') });
}

async function decide(chatId: string, messageId: string, expectedRevision: number, token = h.tokens.officerA): Promise<ApiResponse> {
  return h.http(token).post(`/v1/chats/${chatId}/officer-decisions`, { decision: 'leave_unanswered', messageId, expectedRevision });
}

async function connectorEvent(chatId: string, event: Record<string, unknown>): Promise<ApiResponse> {
  return h.http(h.tokens.connector).post(`/v1/chats/${chatId}/events`, event);
}

async function officerRef(token: string, displayName: string) {
  return { id: await principalId(token), displayName };
}

function expectError(res: ApiResponse, status: number, code: string): void {
  expect(res.status, `${code}: ${res.text}`).toBe(status);
  expect(res.body).toEqual({ success: false, data: null, error: expect.objectContaining({ code, message: expect.any(String) }) });
}

/** Row counts per chat for every table a decision could write to; the capture worker only updates rows. */
const EVIDENCE_TABLES = ['messages', 'message_events', 'captures', 'reviews', 'case_actions'] as const;
function evidenceCounts(chatId: string): Record<(typeof EVIDENCE_TABLES)[number], number> {
  const entries = EVIDENCE_TABLES.map((table) => [table, countRows(h.dataDir, table, 'chat_id = :chatId', { chatId })] as const);
  return Object.fromEntries(entries) as Record<(typeof EVIDENCE_TABLES)[number], number>;
}

/** Stream events of a chat written by requests, leaving out what the capture and review workers publish. */
function requestEventTypes(chatId: string): string[] {
  const workerTypes = new Set(['capture.updated', 'review.updated', 'finding.created']);
  return streamEvents(h.dataDir, chatId).map((e) => e.type).filter((type) => !workerTypes.has(type));
}

/** A timeline without the parts the capture and review workers change in the background. */
function stableTimeline(tl: Timeline) {
  const strip = <T extends { capture: { id: string } | null; review: unknown }>({ capture, review: _review, ...rest }: T) => ({
    ...rest,
    captureId: capture?.id ?? null,
  });
  const { review: _review, lastActivityAt: _lastActivityAt, ...chat } = tl.chat;
  return { chat, messages: tl.messages.map(strip), messageEvents: tl.messageEvents.map(strip), caseActions: tl.caseActions };
}

describe('step 2: handover, composer and decisions', () => {
  it('pause, take over and resume change mode and revision and record operator and time', async () => {
    const officerA = await officerRef(h.tokens.officerA, 'Officer A');
    const { chatId } = await newInboundChat();
    expect((await dispatch([chatId])).status).toBe(200);

    h.clock.set('2026-11-21T09:00:00.000Z');
    const paused = await control(chatId, 'pause', 2);
    expect(paused.status).toBe(200);
    expect(paused.body.data).toEqual({
      chat: expect.objectContaining({ id: chatId, aiMode: 'paused', revision: 3, controller: null, inboxStatus: 'open' }),
      changedAt: '2026-11-21T09:00:00.000Z',
    });

    h.clock.set('2026-11-21T09:05:00.000Z');
    const taken = await control(chatId, 'take_over', 3);
    expect(taken.status).toBe(200);
    expect(taken.body.data).toEqual({
      chat: expect.objectContaining({ aiMode: 'officer_control', revision: 4, controller: officerA }),
      changedAt: '2026-11-21T09:05:00.000Z',
    });

    h.clock.set('2026-11-21T09:10:00.000Z');
    const resumed = await control(chatId, 'resume', 4);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toEqual({
      chat: expect.objectContaining({ aiMode: 'ai_active', revision: 5, controller: null }),
      changedAt: '2026-11-21T09:10:00.000Z',
    });

    const controls = (await timeline(chatId)).caseActions.filter((a) => a.type.startsWith('control_'));
    expect(controls).toEqual([
      expect.objectContaining({ type: 'control_pause', actor: officerA, fromMode: 'ai_active', toMode: 'paused', revision: 3, occurredAt: '2026-11-21T09:00:00.000Z' }),
      expect.objectContaining({ type: 'control_take_over', actor: officerA, fromMode: 'paused', toMode: 'officer_control', revision: 4, occurredAt: '2026-11-21T09:05:00.000Z' }),
      expect.objectContaining({ type: 'control_resume', actor: officerA, fromMode: 'officer_control', toMode: 'ai_active', revision: 5, occurredAt: '2026-11-21T09:10:00.000Z' }),
    ]);
    const changes = streamEvents(h.dataDir, chatId).filter((e) => e.type === 'chat.control_changed').map((e) => e.data);
    expect(changes).toEqual([
      { aiMode: 'ai_active', revision: 2 },
      { aiMode: 'paused', revision: 3 },
      { aiMode: 'officer_control', revision: 4 },
      { aiMode: 'ai_active', revision: 5 },
    ]);
  });

  it('a stale expectedRevision is 409 revision_conflict and reports the current revision', async () => {
    const { chatId } = await newInboundChat();
    await dispatch([chatId]);
    expect((await control(chatId, 'pause', 2)).status).toBe(200);

    const stale = await control(chatId, 'resume', 2);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      success: false,
      data: null,
      error: { code: 'revision_conflict', message: expect.any(String), details: { currentRevision: 3, aiMode: 'paused' } },
    });
    // The revision is a precondition: a stale request is a conflict even when its action would also be refused now.
    const staleAndInvalid = await control(chatId, 'pause', 2);
    expectError(staleAndInvalid, 409, 'revision_conflict');
    expect(staleAndInvalid.body.error.details).toEqual({ currentRevision: 3, aiMode: 'paused' });
    const ahead = await control(chatId, 'resume', 9);
    expectError(ahead, 409, 'revision_conflict');
    expect(ahead.body.error.details).toEqual({ currentRevision: 3, aiMode: 'paused' });

    const tl = await timeline(chatId);
    expect(tl.chat).toMatchObject({ aiMode: 'paused', revision: 3 });
    expect(tl.caseActions.map((a) => a.type)).toEqual(['dispatch_started', 'control_pause']);
  });

  it('two officers taking over at the same revision: one succeeds and the other conflicts', async () => {
    const tokens = [h.tokens.officerA, h.tokens.officerB];
    const ids = [await principalId(h.tokens.officerA), await principalId(h.tokens.officerB)];
    const { chatId } = await newInboundChat();

    const responses = await Promise.all(tokens.map((token) => control(chatId, 'take_over', 1, token)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((r) => r.status === 200);
    const loser = responses[1 - winner];
    expect(loser?.body.error).toMatchObject({ code: 'revision_conflict', details: { currentRevision: 2, aiMode: 'officer_control' } });

    const tl = await timeline(chatId);
    expect(tl.chat).toMatchObject({ aiMode: 'officer_control', revision: 2, controller: { id: ids[winner] } });
    expect(tl.caseActions.filter((a) => a.type === 'control_take_over')).toHaveLength(1);
  });

  it('another officer can take over with the current revision and the transfer is logged; resume by a non-controller is 403 not_controller', async () => {
    const officerA = await officerRef(h.tokens.officerA, 'Officer A');
    const officerB = await officerRef(h.tokens.officerB, 'Officer B');
    const { chatId, revision } = await chatUnderTakeover();

    const transfer = await control(chatId, 'take_over', revision, h.tokens.officerB);
    expect(transfer.status).toBe(200);
    expect(transfer.body.data.chat).toMatchObject({ aiMode: 'officer_control', revision: 3, controller: officerB });

    expectError(await control(chatId, 'resume', 3, h.tokens.officerA), 403, 'not_controller');
    const tl = await timeline(chatId);
    expect(tl.chat).toMatchObject({ aiMode: 'officer_control', revision: 3, controller: officerB });
    expect(tl.caseActions.filter((a) => a.type === 'control_take_over')).toEqual([
      expect.objectContaining({ actor: officerA, fromMode: 'not_started', toMode: 'officer_control', revision: 2 }),
      expect.objectContaining({ actor: officerB, fromMode: 'officer_control', toMode: 'officer_control', revision: 3 }),
    ]);

    const byController = await control(chatId, 'resume', 3, h.tokens.officerB);
    expect(byController.status).toBe(200);
    expect(byController.body.data.chat).toMatchObject({ aiMode: 'ai_active', revision: 4, controller: null });
  });

  it('transitions the state machine forbids are 409 invalid_transition', async () => {
    const { chatId } = await newInboundChat();
    const refused = async (action: ControlAction, revision: number) => {
      const res = await control(chatId, action, revision);
      expect(res.status, `${action} at revision ${revision}`).toBe(409);
      expect(res.body).toEqual({ success: false, data: null, error: { code: 'invalid_transition', message: expect.any(String) } });
    };
    await refused('pause', 1);
    await refused('resume', 1);
    await dispatch([chatId]);
    await refused('resume', 2);
    expect((await control(chatId, 'pause', 2)).status).toBe(200);
    await refused('pause', 3);
    expect((await control(chatId, 'take_over', 3)).status).toBe(200);
    await refused('pause', 4);
    await refused('take_over', 4);

    const tl = await timeline(chatId);
    expect(tl.chat).toMatchObject({ aiMode: 'officer_control', revision: 4 });
    expect(tl.caseActions.map((a) => a.type)).toEqual(['dispatch_started', 'control_pause', 'control_take_over']);
  });

  it('dispatch leaves paused and officer-controlled chats unchanged with requires_resume', async () => {
    const paused = await newInboundChat();
    await dispatch([paused.chatId]);
    expect((await control(paused.chatId, 'pause', 2)).status).toBe(200);
    const controlled = await chatUnderTakeover();

    const res = await dispatch([paused.chatId, controlled.chatId]);
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { chatId: paused.chatId, status: 'requires_resume', aiMode: 'paused', revision: 3 },
      { chatId: controlled.chatId, status: 'requires_resume', aiMode: 'officer_control', revision: 2 },
    ]);
    expect((await timeline(paused.chatId)).chat).toMatchObject({ aiMode: 'paused', revision: 3 });
    expect((await timeline(controlled.chatId)).chat).toMatchObject({
      aiMode: 'officer_control',
      revision: 2,
      controller: expect.objectContaining({ displayName: 'Officer A' }),
    });
  });

  it('incoming messages keep recording during pause and takeover', async () => {
    const { chatId } = await newInboundChat();
    await dispatch([chatId]);
    expect((await control(chatId, 'pause', 2)).status).toBe(200);
    const duringPause = await connectorEvent(chatId, recorded({ messageId: 2, text: 'Are you there?' }));
    expect(duringPause.status).toBe(201);
    expect(duringPause.body.data).toMatchObject({ result: 'recorded', captureId: expect.stringMatching(/^cap_/) });

    expect((await control(chatId, 'take_over', 3)).status).toBe(200);
    const duringTakeover = await connectorEvent(chatId, recorded({ messageId: 3, text: 'Hello again.' }));
    expect(duringTakeover.status).toBe(201);
    expect(duringTakeover.body.data).toMatchObject({ result: 'recorded', captureId: expect.stringMatching(/^cap_/) });

    let tl = await timeline(chatId);
    expect(tl.chat).toMatchObject({ aiMode: 'officer_control', revision: 4 });
    expect(tl.messages.map((m) => m.text)).toEqual(['Hello, I need some help.', 'Are you there?', 'Hello again.']);
    expect(tl.messages.slice(1).map((m) => m.capture?.id)).toEqual([duringPause.body.data.captureId, duringTakeover.body.data.captureId]);
    // Review waits while the AI is not active; resume queues it again and wakes the review worker.
    expect(tl.messages.slice(1).map((m) => m.review?.status)).toEqual(['not_requested', 'not_requested']);
    const wakesBefore = reviewWorker.wakes;
    expect((await control(chatId, 'resume', 4)).status).toBe(200);
    expect(reviewWorker.wakes).toBeGreaterThan(wakesBefore);
    tl = await timeline(chatId);
    // The woken worker may already have claimed or completed them, so any status from pending on proves the requeue.
    const requeued = expect.stringMatching(/^(pending|running|completed)$/);
    expect(tl.messages.slice(1).map((m) => m.review?.status)).toEqual([requeued, requeued]);
  });

  it('control of a chat the caller cannot access answers 404 chat_not_found like a missing chat, before the body is looked at', async () => {
    const hidden = await newInboundChat(h.accounts.officer);
    expectError(await control(hidden.chatId, 'take_over', 1, h.tokens.officerC), 404, 'chat_not_found');
    expectError(await control(hidden.chatId, 'take_over', 1, h.tokens.outsider), 404, 'chat_not_found');
    expectError(await control('chat_00000000000000000000000000000000', 'take_over', 1), 404, 'chat_not_found');
    const invalidBody = await h.http(h.tokens.officerC).post(`/v1/chats/${hidden.chatId}/control`, { action: 'sleep' });
    expectError(invalidBody, 404, 'chat_not_found');
    expectError(await h.http(h.tokens.officerA).post(`/v1/chats/${hidden.chatId}/control`, { action: 'sleep', expectedRevision: 1 }), 400, 'validation_failed');
    expect((await timeline(hidden.chatId)).chat).toMatchObject({ aiMode: 'not_started', revision: 1 });
  });

  it('the controlling officer submits a message and sees it exactly once in the live timeline as Simulated send, with officer attribution and no capture', async () => {
    const officerA = await officerRef(h.tokens.officerA, 'Officer A');
    const { chatId, revision } = await chatUnderTakeover();
    const stream = await openStream(h.baseUrl, h.tokens.officerA);
    try {
      const sent = await compose(chatId, 'We have received your message.', revision);
      expect(sent.status).toBe(201);
      const message = sent.body.data.message;
      expect(message).toEqual({
        id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
        chatId,
        direction: 'outgoing',
        origin: 'officer_composer',
        text: 'We have received your message.',
        originalCaptured: true,
        unsupportedContent: [],
        sentAt: null,
        receivedAt: h.clock.now().toISOString(),
        source: { channel: 'telegram', captureMethod: 'officer_composer', sourceEventId: null, sourceMessageId: null },
        sender: null,
        author: officerA,
        sendStatus: 'simulated',
        sendStatusLabel: 'Simulated send',
        capture: null,
        review: null,
        editedAtSource: false,
        deletedAtSource: false,
        position: expect.any(Number),
      });

      // A later incoming message is the sentinel: once it arrives, every earlier event has been delivered.
      const later = await connectorEvent(chatId, recorded({ messageId: 2, text: 'Thank you.' }));
      await stream.next((m) => m.event === 'message.recorded' && m.data.messageId === later.body.data.messageId);
      const live = stream.received.filter((m) => m.event === 'message.recorded' && m.data.messageId === message.id);
      expect(live).toHaveLength(1);
      expect(live[0]?.data).toMatchObject({ chatId, messageId: message.id, direction: 'outgoing', origin: 'officer_composer' });

      const tl = await timeline(chatId);
      expect(tl.messages.filter((m) => m.origin === 'officer_composer')).toEqual([message]);
      expect(tl.caseActions).toContainEqual(
        expect.objectContaining({ type: 'officer_message_sent', messageId: message.id, actor: officerA, revision }),
      );
      expect(tl.chat).toMatchObject({ aiMode: 'officer_control', revision, controller: officerA });
      expect(countRows(h.dataDir, 'captures', 'message_id = :id', { id: message.id })).toBe(0);
      expect(countRows(h.dataDir, 'reviews', 'message_id = :id', { id: message.id })).toBe(0);
    } finally {
      stream.close();
    }
  });

  it('repeating the composer request with the same Idempotency-Key creates no second message', async () => {
    const { chatId, revision } = await chatUnderTakeover();
    const key = uniqueId('compose-');
    const first = await compose(chatId, 'Thanks, noted.', revision, h.tokens.officerA, key);
    const again = await compose(chatId, 'Thanks, noted.', revision, h.tokens.officerA, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(again.body).toEqual(first.body);
    const composed = () => countRows(h.dataDir, 'messages', "chat_id = :chatId AND origin = 'officer_composer'", { chatId });
    expect(composed()).toBe(1);
    expect(countRows(h.dataDir, 'case_actions', "chat_id = :chatId AND type = 'officer_message_sent'", { chatId })).toBe(1);

    expectError(await compose(chatId, 'Something else.', revision, h.tokens.officerA, key), 422, 'idempotency_key_reused');
    const missingKey = await h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/officer-messages`, { text: 'Thanks, noted.', expectedRevision: revision });
    expectError(missingKey, 400, 'idempotency_key_required');
    expect(composed()).toBe(1);

    // The key is scoped to the chat: the same key and body in another chat send that chat's own message.
    const other = await chatUnderTakeover();
    const elsewhere = await compose(other.chatId, 'Thanks, noted.', other.revision, h.tokens.officerA, key);
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.headers.get('idempotency-replayed')).toBeNull();
    expect(elsewhere.body.data.message).toMatchObject({ chatId: other.chatId });
  });

  it('the composer rejects a stale revision (409), a different officer (403) and a chat that is not under takeover (409 not_in_takeover)', async () => {
    const { chatId } = await newInboundChat();
    expectError(await compose(chatId, 'Hello.', 1), 409, 'not_in_takeover');
    await dispatch([chatId]);
    expectError(await compose(chatId, 'Hello.', 2), 409, 'not_in_takeover');
    expect((await control(chatId, 'take_over', 2)).status).toBe(200);

    expectError(await compose(chatId, 'Hello.', 3, h.tokens.officerB), 403, 'not_controller');
    // The controller check comes before the revision check.
    expectError(await compose(chatId, 'Hello.', 2, h.tokens.officerB), 403, 'not_controller');
    const stale = await compose(chatId, 'Hello.', 2);
    expectError(stale, 409, 'revision_conflict');
    expect(stale.body.error.details).toEqual({ currentRevision: 3, aiMode: 'officer_control' });
    const blank = await h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/officer-messages`, { text: '', expectedRevision: 3 }, { 'Idempotency-Key': uniqueId('k-') });
    expectError(blank, 400, 'validation_failed');

    // A chat the caller cannot access answers like a missing one, before the body is looked at.
    const hidden = await chatUnderTakeover(h.accounts.officer);
    expectError(await compose(hidden.chatId, 'Hello.', hidden.revision, h.tokens.officerC), 404, 'chat_not_found');
    expectError(await compose(hidden.chatId, 'Hello.', hidden.revision, h.tokens.outsider), 404, 'chat_not_found');
    const invalidHidden = await h.http(h.tokens.officerC).post(`/v1/chats/${hidden.chatId}/officer-messages`, { text: '' }, { 'Idempotency-Key': uniqueId('k-') });
    expectError(invalidHidden, 404, 'chat_not_found');
    expect(countRows(h.dataDir, 'messages', "chat_id IN (:a, :b) AND origin = 'officer_composer'", { a: chatId, b: hidden.chatId })).toBe(0);
  });

  it('Leave unanswered adds only an internal case action and no outgoing message, and the next incoming message and its capture still appear', async () => {
    const officerA = await officerRef(h.tokens.officerA, 'Officer A');
    const { chatId, messageId, revision } = await chatUnderTakeover();
    const before = await timeline(chatId);
    const countsBefore = evidenceCounts(chatId);
    const eventsBefore = requestEventTypes(chatId);

    const res = await decide(chatId, messageId, revision);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      created: true,
      caseAction: {
        id: expect.stringMatching(/^act_[0-9a-f]{32}$/),
        chatId,
        type: 'leave_unanswered',
        actor: officerA,
        messageId,
        fromMode: null,
        toMode: null,
        revision,
        detail: null,
        occurredAt: h.clock.now().toISOString(),
        position: expect.any(Number),
      },
    });
    expect(evidenceCounts(chatId)).toEqual({ ...countsBefore, case_actions: countsBefore.case_actions + 1 });
    expect(requestEventTypes(chatId)).toEqual([...eventsBefore, 'case_action.recorded']);
    const after = await timeline(chatId);
    expect(stableTimeline(after).messages).toEqual(stableTimeline(before).messages);
    expect(after.caseActions).toEqual([...before.caseActions, res.body.data.caseAction]);
    expect(after.chat).toMatchObject({ inboxStatus: 'open', aiMode: 'officer_control', revision, controller: officerA });

    const next = await connectorEvent(chatId, recorded({ messageId: 2, text: 'Hello? Is anyone reading this?' }));
    expect(next.status).toBe(201);
    const latest = (await timeline(chatId)).messages.at(-1);
    expect(latest).toMatchObject({
      id: next.body.data.messageId,
      direction: 'incoming',
      text: 'Hello? Is anyone reading this?',
      capture: expect.objectContaining({ id: next.body.data.captureId, kind: 'mirsad_rendered_capture' }),
    });
  });

  it('Leave unanswered twice for one message returns the same case action', async () => {
    const { chatId, messageId, revision } = await chatUnderTakeover();
    const first = await decide(chatId, messageId, revision);
    const second = await decide(chatId, messageId, revision);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ caseAction: first.body.data.caseAction, created: false });
    const recordedActions = () => countRows(h.dataDir, 'case_actions', "chat_id = :chatId AND type = 'leave_unanswered'", { chatId });
    expect(recordedActions()).toBe(1);

    // A new controller asking again still gets the original action.
    expect((await control(chatId, 'take_over', revision, h.tokens.officerB)).status).toBe(200);
    const third = await decide(chatId, messageId, revision + 1, h.tokens.officerB);
    expect(third.status).toBe(200);
    expect(third.body.data).toEqual({ caseAction: first.body.data.caseAction, created: false });
    expect(recordedActions()).toBe(1);
  });

  it('a decision needs the takeover, the controlling officer, the current revision and an incoming message of the chat', async () => {
    const { chatId, messageId } = await newInboundChat();
    expectError(await decide(chatId, messageId, 1), 409, 'not_in_takeover');
    expect((await control(chatId, 'take_over', 1)).status).toBe(200);
    expectError(await decide(chatId, messageId, 2, h.tokens.officerB), 403, 'not_controller');
    const stale = await decide(chatId, messageId, 1);
    expectError(stale, 409, 'revision_conflict');
    expect(stale.body.error.details).toEqual({ currentRevision: 2, aiMode: 'officer_control' });

    const ownReply = await compose(chatId, 'An officer reply.', 2);
    expectError(await decide(chatId, ownReply.body.data.message.id, 2), 404, 'message_not_found');
    const elsewhere = await newInboundChat();
    expectError(await decide(chatId, elsewhere.messageId, 2), 404, 'message_not_found');
    expectError(await decide(chatId, 'msg_00000000000000000000000000000000', 2), 404, 'message_not_found');
    const wrongDecision = await h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/officer-decisions`, { decision: 'reply_later', messageId, expectedRevision: 2 });
    expectError(wrongDecision, 400, 'validation_failed');

    const hidden = await chatUnderTakeover(h.accounts.officer);
    expectError(await decide(hidden.chatId, hidden.messageId, hidden.revision, h.tokens.officerC), 404, 'chat_not_found');
    expect(countRows(h.dataDir, 'case_actions', "type = 'leave_unanswered' AND chat_id IN (:a, :b)", { a: chatId, b: hidden.chatId })).toBe(0);
  });

  it('intake-account chats expose the acknowledgement template "Message received." and other chats expose none; no message exists until the officer posts one', async () => {
    const intake = await newInboundChat(h.accounts.intake);
    const other = await newInboundChat(h.accounts.officer);
    const takenIntake = await control(intake.chatId, 'take_over', 1);
    const takenOther = await control(other.chatId, 'take_over', 1);
    expect(takenIntake.body.data.chat).toMatchObject({ intakeAccount: true, acknowledgementTemplate: 'Message received.' });
    expect(takenOther.body.data.chat).toMatchObject({ intakeAccount: false, acknowledgementTemplate: null });

    let tl = await timeline(intake.chatId);
    expect(tl.chat.acknowledgementTemplate).toBe('Message received.');
    expect(tl.messages.map((m) => m.direction)).toEqual(['incoming']);
    expect(tl.chat.messageCount).toBe(1);

    const sent = await compose(intake.chatId, tl.chat.acknowledgementTemplate ?? '', 2);
    expect(sent.status).toBe(201);
    expect(sent.body.data.message).toMatchObject({ direction: 'outgoing', text: 'Message received.', sendStatusLabel: 'Simulated send' });
    tl = await timeline(intake.chatId);
    expect(tl.messages.map((m) => m.text)).toEqual(['Hello, I need some help.', 'Message received.']);
    expect(tl.chat.messageCount).toBe(2);
  });

  it('messages, events, case actions and composer messages are still there after a restart', async () => {
    const { chatId, messageId, revision } = await chatUnderTakeover();
    const edit = await connectorEvent(chatId, edited({ messageId: 1, updateId: 4100, text: 'Hello, I need some help urgently.' }));
    expect(edit.status).toBe(201);
    expect((await compose(chatId, 'Recorded before the restart.', revision)).status).toBe(201);
    expect((await decide(chatId, messageId, revision)).status).toBe(201);
    const before = await timeline(chatId);
    expect(before.messageEvents.map((e) => e.type)).toEqual(['edited']);
    expect(before.messages.map((m) => m.origin)).toEqual(['source', 'officer_composer']);
    expect(before.caseActions.map((a) => a.type)).toEqual(['control_take_over', 'officer_message_sent', 'leave_unanswered']);
    const stored = streamEvents(h.dataDir, chatId);
    const openBeforeRestart = await openStream(h.baseUrl, h.tokens.officerA);

    await h.restart();
    // Closing the app ends the streams it had open.
    await openBeforeRestart.ended;
    // The client may still hold keep-alive sockets the old server closed; wait until the new one answers.
    await vi.waitFor(async () => expect((await h.http(null).get('/healthz')).status).toBe(200), { timeout: 5_000, interval: 20 });

    expect(stableTimeline(await timeline(chatId))).toEqual(stableTimeline(before));
    const replay = await openStream(h.baseUrl, h.tokens.officerA, { cursor: 0 });
    try {
      const last = stored.at(-1);
      await replay.next((m) => m.id === String(last?.seq));
      const replayed = replay.received.filter((m) => m.data.chatId === chatId && Number(m.id) <= (last?.seq ?? 0));
      expect(replayed.map((m) => ({ seq: Number(m.id), type: m.event }))).toEqual(stored.map((e) => ({ seq: e.seq, type: e.type })));
    } finally {
      replay.close();
    }
  });
});
