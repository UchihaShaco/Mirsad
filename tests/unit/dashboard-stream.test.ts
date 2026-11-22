/**
 * The dashboard's event stream reader: a small SSE parser (src/dashboard/js/state/sse-parser.js) and the fetch()-based
 * client (src/dashboard/js/stream-client.js) that sends the Authorization header, resumes with Last-Event-ID and asks
 * for a reload on stream.reset. The network is a fetch function returning real Response streams.
 */
import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from '../../src/dashboard/js/state/sse-parser.js';
import { createEventStream, type FetchInit } from '../../src/dashboard/js/stream-client.js';

const encoder = new TextEncoder();
const TOKEN = 'officer-token-for-tests';

/** A 200 event-stream response that sends `text`, then ends (`end`) or stays open until the request is aborted. */
function streamResponse(text: string, signal: AbortSignal, end: boolean): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      if (end) controller.close();
      else signal.addEventListener('abort', () => controller.error(new Error('aborted by the client')), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(id: string, type: string, data: Record<string, unknown>): string {
  const wire = { id, type, chatId: null, occurredAt: '2026-11-21T08:00:00.000Z', ...data };
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(wire)}\n\n`;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SSE parser', () => {
  it('the stream parser handles split chunks, comments and multi-line data', () => {
    const arabicHello = 'مرحبا';
    const lfPart = [': keep-alive', '', 'id: 41', 'event: chat.created', 'data: {"id":"41"}', '', ': keep-alive', ''].join('\n');
    const crlfPart = ['id: 42', 'event: message.recorded', 'data: first line', 'data:second line', 'data', '', ''].join('\r\n');
    const crPart = `data: ${arabicHello}\r\r`;
    const unfinished = 'id: 43\nevent: chat.created\ndata: never finished';
    const bytes = encoder.encode(lfPart + crlfPart + crPart + unfinished);
    const expected: SseMessage[] = [
      { id: '41', event: 'chat.created', data: '{"id":"41"}' },
      { id: '42', event: 'message.recorded', data: 'first line\nsecond line\n' },
      // The last event ID carries over; the event type does not.
      { id: '42', event: 'message', data: arabicHello },
    ];

    // Every chunk size splits frames, CRLF pairs and the two-byte Arabic letters at different places.
    for (let size = 1; size <= 9; size += 1) {
      const received: SseMessage[] = [];
      const parser = createSseParser((message) => received.push(message));
      for (let offset = 0; offset < bytes.length; offset += size) parser.push(bytes.subarray(offset, offset + size));
      parser.end();
      expect(received, `chunk size ${size}`).toEqual(expected);
    }
  });
});

describe('event stream client', () => {
  it('a stream.reset triggers a reload', async () => {
    const reset = frame('7', 'stream.reset', { reason: 'cursor_out_of_range', resumeFrom: '7', reload: ['inbox', 'timeline'] });
    const reloaded = deferred<string[]>();
    const events: unknown[] = [];
    const stream = createEventStream({
      token: TOKEN,
      cursor: '3',
      fetch: async (_url: string, init: FetchInit) => streamResponse(reset, init.signal, false),
      onEvent: (event) => events.push(event),
      onReload: (targets) => reloaded.resolve(targets),
    });

    stream.start();
    const targets = await reloaded.promise;
    stream.stop();

    expect(targets).toEqual(['inbox', 'timeline']);
    expect(events).toEqual([]);
  });

  it('reconnects after the stream ends with Last-Event-ID and the Authorization header, never a token in the URL', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const reconnected = deferred<void>();
    const events: unknown[] = [];
    const created = frame('9', 'chat.created', { chatId: 'chat_1', inboxStatus: 'new_inbound' });
    const stream = createEventStream({
      token: TOKEN,
      cursor: '5',
      fetch: async (url: string, init: FetchInit) => {
        calls.push({ url, headers: { ...init.headers } });
        const first = calls.length === 1;
        if (!first) reconnected.resolve();
        return streamResponse(first ? created : '', init.signal, first);
      },
      wait: async () => undefined,
      onEvent: (event) => events.push(event),
      onReload: () => undefined,
    });

    stream.start();
    await reconnected.promise;
    stream.stop();

    const auth = { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' };
    expect(calls[0]).toEqual({ url: '/v1/events?cursor=5', headers: auth });
    expect(calls[1]).toEqual({ url: '/v1/events', headers: { ...auth, 'Last-Event-ID': '9' } });
    expect(calls.some((call) => call.url.includes(TOKEN))).toBe(false);
    expect(events).toEqual([expect.objectContaining({ id: '9', type: 'chat.created', inboxStatus: 'new_inbound' })]);
  });
});
