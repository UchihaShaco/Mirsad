/**
 * Brief step 5: the reviewer stays quiet. The synthetic fixture chat has five routine messages (three incoming, two
 * outgoing) and one message that introduces a payment destination. Every message is captured, the routine ones raise
 * nothing, the change raises one short note linked to its exact quote, and replays and repeats raise nothing new.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayFixture, type ReplayReport } from '../../src/adapters/replay.ts';
import type { Timeline } from '../../src/contract/schemas.ts';
import { countRows, queryRows, streamEvents } from '../helpers/db-read.ts';
import { recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/telegram/payment-destination-change.json');
const CHANGED_LINK = 'https://pay.alt-shop.test/invoice/77';
const NOTE_MAX_LENGTH = 120;
const MESSAGE_COUNT = 6;

let h: TestHarness;
let chatId: string;
let firstReport: ReplayReport;

async function replay(): Promise<ReplayReport> {
  const fixture: unknown = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  return replayFixture(fixture, {
    baseUrl: h.baseUrl,
    connectorToken: h.tokens.connector,
    accounts: { intake: 'tg-intake-1', officer: 'tg-officer-1' },
  });
}

async function timeline(): Promise<Timeline> {
  return (await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`)).body.data as Timeline;
}

/** Row counts of everything review and intake write for the chat, plus the findings published on the stream. */
function chatState(): Record<string, number> {
  const tables = ['messages', 'message_events', 'captures', 'reviews', 'findings', 'case_details'];
  const counts = Object.fromEntries(tables.map((table) => [table, countRows(h.dataDir, table, 'chat_id = :chatId', { chatId })]));
  return { ...counts, findingEvents: streamEvents(h.dataDir, chatId).filter((e) => e.type === 'finding.created').length };
}

beforeAll(async () => {
  h = await startHarness();
  firstReport = await replay();
  chatId = firstReport.events[0]?.chatId ?? '';
  const dispatched = await h.http(h.tokens.officerA).post('/v1/dispatches', { chatIds: [chatId] }, { 'Idempotency-Key': uniqueId('d-') });
  expect(dispatched.status).toBe(200);
  await h.drain();
});
afterAll(async () => {
  await h.close();
});

describe('step 5: a quiet reviewer', () => {
  it('five routine messages and one changed payment destination: all six are captured, the routine ones raise zero alerts, the change raises one short note linked to the exact quote', async () => {
    expect(firstReport.events.map((e) => [e.status, e.result])).toEqual(Array(MESSAGE_COUNT).fill([201, 'recorded']));
    const tl = await timeline();
    expect(tl.messages).toHaveLength(MESSAGE_COUNT);
    expect(tl.messages.map((m) => m.capture?.status)).toEqual(Array(MESSAGE_COUNT).fill('ready'));
    expect(tl.messages.map((m) => m.direction)).toEqual(['incoming', 'outgoing', 'incoming', 'outgoing', 'incoming', 'incoming']);
    // Incoming messages are reviewed one by one; outgoing ones are never sent to the reviewer.
    expect(tl.messages.map((m) => (m.review ? [m.review.status, m.review.outcome] : null))).toEqual([
      ['completed', 'no_new_finding'],
      null,
      ['completed', 'no_new_finding'],
      null,
      ['completed', 'no_new_finding'],
      ['completed', 'findings'],
    ]);

    const changed = tl.messages[MESSAGE_COUNT - 1];
    const [recordedEvent] = queryRows<{ id: string }>(h.dataDir, "SELECT id FROM message_events WHERE message_id = :id AND type = 'recorded'", {
      id: changed?.id ?? '',
    });
    expect(tl.findings).toHaveLength(1);
    const [note] = tl.findings;
    expect(note).toMatchObject({
      messageId: changed?.id,
      messageEventId: recordedEvent?.id,
      kind: 'payment_link',
      label: 'New payment link',
      extractedValue: CHANGED_LINK,
      changedFrom: null,
      caseReferenceId: null,
      note: 'New payment link in a message from the contact.',
    });
    expect(changed?.text).toContain(note?.quote);
    expect(note?.quote).toContain(CHANGED_LINK);
    expect(note?.note.length).toBeLessThanOrEqual(NOTE_MAX_LENGTH);
    expect(note?.note).not.toContain(CHANGED_LINK);
    expect(chatState()).toMatchObject({ messages: 6, captures: 6, reviews: 4, findings: 1, findingEvents: 1 });
  });

  it('replaying the changed-destination event creates no duplicate note', async () => {
    const before = chatState();
    const again = await replay();
    expect(again.events.map((e) => [e.status, e.result])).toEqual(Array(MESSAGE_COUNT).fill([200, 'duplicate_event']));
    await h.drain();
    expect(chatState()).toEqual(before);
    expect((await timeline()).findings).toHaveLength(1);
  });

  it('the same detail repeated in a later message is suppressed', async () => {
    const repeat = await h.http(h.tokens.connector).post(
      `/v1/chats/${chatId}/events`,
      recorded({ messageId: 4107, updateId: 900000007, text: `Reminder: please pay the fee at ${CHANGED_LINK} today.` }),
    );
    expect(repeat.status).toBe(201);
    await h.drain();

    const tl = await timeline();
    expect(tl.findings).toHaveLength(1);
    expect(tl.messages.at(-1)).toMatchObject({ id: repeat.body.data.messageId, review: { status: 'completed', outcome: 'no_new_finding' } });
    const [review] = queryRows<{ suppressed_count: number }>(h.dataDir, 'SELECT suppressed_count FROM reviews WHERE message_event_id = :id', {
      id: repeat.body.data.messageEventId,
    });
    expect(review?.suppressed_count).toBe(1);
  });
});
