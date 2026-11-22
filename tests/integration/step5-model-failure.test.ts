/**
 * Brief "Local model setup": on model failure, ingestion, screenshots and officer controls stay available and review
 * shows as unavailable. The reviewer is the one the factory builds for MIRSAD_REVIEWER=lmstudio, pointed at a loopback
 * port nothing listens on; the harness's scripted reviewer only passes each review through to it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Timeline } from '../../src/contract/schemas.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';
import type { Reviewer } from '../../src/ports/reviewer.ts';
import { createReviewer } from '../../src/review/reviewer-factory.ts';
import { queryRows } from '../helpers/db-read.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type ApiResponse, type TestHarness } from '../helpers/harness.ts';

/** Appears in every incoming message; it must never reach a log line. */
const CANARY = 'canary-5d1e-message-text';

let h: TestHarness;
let lmStudio: Reviewer;

/** A loopback URL on a port nothing listens on: the model endpoint is down. */
async function downEndpoint(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

beforeAll(async () => {
  const baseUrl = await downEndpoint();
  h = await startHarness({ config: { reviewer: 'lmstudio', lmStudio: { baseUrl, model: 'qwen3.5-9b', contextTokens: 4_096, timeoutMs: 5_000 } } });
  lmStudio = createReviewer(h.app.config, createJsonLogger({ write: () => {} }));
  h.reviewer.respond((request) => lmStudio.review(request, new AbortController().signal));
});
afterAll(async () => {
  await h.close();
});

async function timeline(chatId: string): Promise<Timeline> {
  return (await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`)).body.data as Timeline;
}

async function control(chatId: string, action: 'pause' | 'take_over' | 'resume', expectedRevision: number): Promise<ApiResponse> {
  return h.http(h.tokens.officerA).post(`/v1/chats/${chatId}/control`, { action, expectedRevision });
}

async function incoming(chatId: string, messageId: number, text: string): Promise<ApiResponse> {
  return h.http(h.tokens.connector).post(`/v1/chats/${chatId}/events`, recorded({ messageId, text: `${text} ${CANARY}` }));
}

function reviewRows(chatId: string): Array<{ status: string; last_error_code: string | null }> {
  return queryRows(h.dataDir, 'SELECT status, last_error_code FROM reviews WHERE chat_id = :chatId ORDER BY created_at, rowid', { chatId });
}

async function artifactStatus(artifactId: string): Promise<{ status: number; type: string | null }> {
  const res = await fetch(`${h.baseUrl}/v1/artifacts/${artifactId}`, { headers: { authorization: `Bearer ${h.tokens.officerA}` } });
  await res.arrayBuffer();
  return { status: res.status, type: res.headers.get('content-type') };
}

describe('step 5: model failure', () => {
  it('with the model endpoint down, reviews become unavailable while intake, captures, control and the composer keep working', async () => {
    // Intake: the first incoming message creates the chat and is captured at once.
    const first = await h.http(h.tokens.connector).post(
      '/v1/ingest',
      envelope(h.accounts.intake, uniqueId('down-'), recorded({ messageId: 1, text: `Please pay the deposit at https://pay.shop.test/deposit/1 ${CANARY}` })),
    );
    expect(first.status).toBe(201);
    const chatId: string = first.body.data.chatId;

    // Dispatch: the review goes to the model endpoint, which is down.
    const dispatched = await h.http(h.tokens.officerA).post('/v1/dispatches', { chatIds: [chatId] }, { 'Idempotency-Key': uniqueId('dispatch-') });
    expect(dispatched.body.data.results).toEqual([expect.objectContaining({ chatId, status: 'started' })]);
    await h.drain();
    const afterDispatch = await timeline(chatId);
    expect(afterDispatch.messages[0]).toMatchObject({ review: { status: 'unavailable', outcome: null }, capture: { status: 'ready' } });
    expect(reviewRows(chatId)).toEqual([{ status: 'unavailable', last_error_code: 'lmstudio_unreachable' }]);
    expect(await artifactStatus(afterDispatch.messages[0]?.capture?.artifactId ?? '')).toEqual({ status: 200, type: 'image/png' });

    // Intake and capture go on in the active chat.
    expect((await incoming(chatId, 2, 'Or pay by phone on +44 7700 900123.')).status).toBe(201);
    await h.drain();

    // Officer control and the composer work as usual.
    expect((await control(chatId, 'pause', 2)).status).toBe(200);
    expect((await control(chatId, 'take_over', 3)).status).toBe(200);
    const sent = await h.http(h.tokens.officerA).post(
      `/v1/chats/${chatId}/officer-messages`,
      { text: 'We are looking into it.', expectedRevision: 4 },
      { 'Idempotency-Key': uniqueId('compose-') },
    );
    expect(sent.status).toBe(201);
    expect(sent.body.data.message).toMatchObject({ direction: 'outgoing', sendStatusLabel: 'Simulated send' });
    expect((await incoming(chatId, 3, 'Hello? Did the payment go through?')).status).toBe(201);
    expect((await control(chatId, 'resume', 4)).status).toBe(200);
    await h.drain();

    // Every incoming message is stored and captured; every review, retried on resume, is unavailable.
    const final = await timeline(chatId);
    expect(final.chat).toMatchObject({ aiMode: 'ai_active', revision: 5 });
    expect(final.messages.map((m) => [m.direction, m.capture?.status ?? null, m.review?.status ?? null])).toEqual([
      ['incoming', 'ready', 'unavailable'],
      ['incoming', 'ready', 'unavailable'],
      ['outgoing', null, null],
      ['incoming', 'ready', 'unavailable'],
    ]);
    expect(final.findings).toEqual([]);
    for (const message of final.messages.filter((m) => m.direction === 'incoming')) {
      expect(await artifactStatus(message.capture?.artifactId ?? '')).toEqual({ status: 200, type: 'image/png' });
    }
    expect(reviewRows(chatId)).toEqual(Array.from({ length: 3 }, () => ({ status: 'unavailable', last_error_code: 'lmstudio_unreachable' })));

    // The failure is logged by code; the message text is not. Health reports the endpoint as unreachable.
    expect(h.logs.some((line) => line.includes('"event":"review_unavailable"') && line.includes('"code":"lmstudio_unreachable"'))).toBe(true);
    expect(h.logs.join('\n')).not.toContain(CANARY);
    expect(await lmStudio.health?.()).toEqual({ reachable: false, modelId: null });
  });
});
