/**
 * Reads GET /v1/events with fetch() and the SSE parser (types in stream-client.d.ts). The browser's EventSource cannot
 * send an Authorization header, and the token never goes in a URL, so the stream is read by hand. After a disconnect it
 * reconnects with Last-Event-ID, waiting longer after each consecutive failure; a 401 ends it for good.
 */
import { createSseParser } from './state/sse-parser.js';
import {
  applyStreamMessage,
  connectionFailed,
  connectionOpened,
  initialStreamState,
  nextConnection,
  reconnectDelay,
} from './state/reconnect.js';

const UNAUTHORIZED = 401;
const ignore = () => undefined;

/** Resolves after `ms`, or at once when the signal aborts. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    return undefined;
  });
}

function requestInit(connection, token, signal) {
  return { headers: { ...connection.headers, Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal, cache: 'no-store' };
}

/** Feeds the response body to a parser until the server ends it. */
async function readEvents(response, onMessage) {
  const parser = createSseParser(onMessage);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
}

/** stream.reset asks for a reload; every other event is handed on. */
function dispatchEffects(effects, { onEvent, onReload }) {
  for (const effect of effects) {
    if (effect.type === 'reload') onReload(effect.targets);
    else onEvent(effect.event);
  }
}

export function createEventStream(options) {
  const { token, onUnauthorized = ignore, onStatus = ignore, wait = delay } = options;
  const fetchStream = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const stopping = new AbortController();
  let state = initialStreamState(options.cursor);
  let request = null;

  function handleMessage(message) {
    const result = applyStreamMessage(state, message);
    state = result.state;
    dispatchEffects(result.effects, options);
  }

  /** One connection, read until the server ends it; resolves false when the stream must not reconnect (401). */
  async function readOnce() {
    request = new AbortController();
    const connection = nextConnection(state);
    const response = await fetchStream(connection.path, requestInit(connection, token, request.signal));
    if (response.status === UNAUTHORIZED) return false;
    if (!response.ok || !response.body) throw new Error(`event_stream_http_${response.status}`);
    state = connectionOpened(state);
    onStatus('live');
    await readEvents(response, handleMessage);
    return true;
  }

  async function run() {
    while (!stopping.signal.aborted) {
      // A network error, a non-200 answer or an abort counts as a failed connection: reconnect unless stopped.
      const reconnect = await readOnce().catch(() => true);
      if (stopping.signal.aborted) return;
      if (!reconnect) return onUnauthorized();
      state = connectionFailed(state);
      onStatus('reconnecting');
      await wait(reconnectDelay(state), stopping.signal);
    }
    return undefined;
  }

  return {
    start: () => void run(),
    stop() {
      stopping.abort();
      if (request) request.abort();
    },
  };
}
