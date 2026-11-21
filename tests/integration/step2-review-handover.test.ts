/**
 * Brief step 2, review half: a result that finishes after the officer took over is discarded as stale, while other
 * chats keep receiving findings (design sections 8 and 10). In-flight reviews are held with the scripted reviewer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Timeline } from '../../src/contract/schemas.ts';
import { startHarness, type ApiResponse, type TestHarness } from '../helpers/harness.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';

const WAIT = { timeout: 5_000, interval: 5 };

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
afterEach(async () => {
  h.reviewer.release();
  await h.drain();
});

type ControlAction = 'pause' | 'take_over' | 'resume';

/** A new inbound chat on the intake account whose first message carries `text`. */
async function newChat(text: string): Promise<{ chatId: string; messageId: string }> {
  const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts.intake, uniqueId('rh-'), recorded({ messageId: 1, text })));
  expect(res.status).toBe(201);
  return { chatId: res.body.data.chatId, messageId: res.body.data.messageId };
}

async function dispatch(chatIds: string[]): Promise<ApiResponse> {
  return h.http(h.tokens.officerA).post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': uniqueId('dispatch-') });
}

async function control(chatId: string, action: ControlAction, expectedRevision: number): Promise<ApiResponse> {
  return h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/control`, { action, expectedRevision });
}

async function timeline(chatId: string): Promise<Timeline> {
  return (await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`)).body.data as Timeline;
}

/** Waits until exactly `count` reviews are blocked inside the held reviewer. */
async function reviewsInFlight(count: number): Promise<void> {
  await vi.waitFor(() => expect(h.reviewer.waiting).toBe(count), WAIT);
}

const callsFor = (chatId: string) => h.reviewer.calls.filter((call) => call.chatId === chatId);

describe('step 2: review handover', () => {
  it("takeover while a review is in flight: chat A's result is discarded as stale, its incoming messages still record, and chat B still receives findings", async () => {
    const a = await newChat('Please pay the deposit at https://pay.shop-a.test/invoice/1');
    const b = await newChat('Please pay the fee at https://pay.shop-b.test/invoice/2');
    h.reviewer.hold();
    expect((await dispatch([a.chatId, b.chatId])).status).toBe(200);
    await reviewsInFlight(2);

    expect((await control(a.chatId, 'take_over', 2)).status).toBe(200);
    const during = await h.http(h.tokens.connector).post(
      `/v1/chats/${a.chatId}/events`,
      recorded({ messageId: 2, text: 'Did you see my message? https://pay.shop-a.test/invoice/1' }),
    );
    expect(during.status).toBe(201);
    h.reviewer.release();
    await h.drain();

    const tlA = await timeline(a.chatId);
    expect(tlA.findings).toEqual([]);
    expect(tlA.messages.map((m) => m.review?.status)).toEqual(['stale_discarded', 'not_requested']);
    expect(tlA.messages[1]).toMatchObject({
      id: during.body.data.messageId,
      capture: { id: during.body.data.captureId, status: 'ready' },
    });
    expect(callsFor(a.chatId).map((call) => call.messageId)).toEqual([a.messageId]);

    const tlB = await timeline(b.chatId);
    expect(tlB.messages[0]?.review).toMatchObject({ status: 'completed', outcome: 'findings' });
    expect(tlB.findings).toEqual([
      expect.objectContaining({
        messageId: b.messageId,
        kind: 'payment_link',
        label: 'New payment link',
        quote: 'Please pay the fee at https://pay.shop-b.test/invoice/2',
        extractedValue: 'https://pay.shop-b.test/invoice/2',
      }),
    ]);
  });

  it('after resume the discarded review runs again and can publish', async () => {
    const a = await newChat('Please pay the deposit at https://pay.shop-c.test/invoice/3');
    h.reviewer.hold();
    await dispatch([a.chatId]);
    await reviewsInFlight(1);
    expect((await control(a.chatId, 'take_over', 2)).status).toBe(200);
    h.reviewer.release();
    await h.drain();
    expect((await timeline(a.chatId)).messages[0]?.review?.status).toBe('stale_discarded');

    expect((await control(a.chatId, 'resume', 3)).status).toBe(200);
    await h.drain();
    const tl = await timeline(a.chatId);
    expect(tl.messages[0]?.review).toMatchObject({ status: 'completed', outcome: 'findings' });
    expect(tl.findings).toEqual([
      expect.objectContaining({ messageId: a.messageId, kind: 'payment_link', label: 'New payment link', extractedValue: 'https://pay.shop-c.test/invoice/3' }),
    ]);
    expect(callsFor(a.chatId)).toHaveLength(2);
  });

  it("a paused chat's messages are not sent to the reviewer", async () => {
    const a = await newChat('Hello, is this the right number for bookings?');
    await dispatch([a.chatId]);
    await h.drain();
    expect((await control(a.chatId, 'pause', 2)).status).toBe(200);
    const later = await h.http(h.tokens.connector).post(
      `/v1/chats/${a.chatId}/events`,
      recorded({ messageId: 2, text: 'Please pay the fee at https://pay.shop-d.test/invoice/4' }),
    );
    expect(later.status).toBe(201);
    await h.drain();

    expect(callsFor(a.chatId).map((call) => call.messageId)).toEqual([a.messageId]);
    const tl = await timeline(a.chatId);
    expect(tl.messages.map((m) => m.review?.status)).toEqual(['completed', 'not_requested']);
    expect(tl.findings).toEqual([]);
  });
});
