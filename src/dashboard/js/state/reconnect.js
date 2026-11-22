/**
 * Reconnect policy for the event stream (pure). It decides where a connection resumes (the snapshot cursor until an
 * event has been seen, then Last-Event-ID), how long to wait after a failure, and what a received message asks the
 * dashboard to do: stream.reset means reload the inbox and timeline; any other event is handed on.
 */

export const EVENTS_PATH = '/v1/events';
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 15_000;
const RELOAD_TARGETS = ['inbox', 'timeline'];

export function initialStreamState(cursor) {
  return { cursor: cursor ?? null, lastEventId: null, failures: 0 };
}

/** The path and headers of the next connection. The token is added by the client as a header, never to the path. */
export function nextConnection(state) {
  if (state.lastEventId !== null) return { path: EVENTS_PATH, headers: { 'Last-Event-ID': state.lastEventId } };
  if (state.cursor !== null) return { path: `${EVENTS_PATH}?cursor=${encodeURIComponent(state.cursor)}`, headers: {} };
  return { path: EVENTS_PATH, headers: {} };
}

export function connectionOpened(state) {
  return { ...state, failures: 0 };
}

export function connectionFailed(state) {
  return { ...state, failures: state.failures + 1 };
}

/** Doubles from the base delay after each consecutive failure, up to the maximum. */
export function reconnectDelay(state) {
  const exponent = Math.max(0, state.failures - 1);
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exponent);
}

function parseData(data) {
  try {
    const parsed = JSON.parse(data);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function reloadTargets(event) {
  const requested = event !== null && Array.isArray(event.reload) ? event.reload.filter((t) => RELOAD_TARGETS.includes(t)) : [];
  return requested.length > 0 ? requested : [...RELOAD_TARGETS];
}

/** Returns the next state and the effects of one SSE message: { type: 'reload', targets } or { type: 'event', event }. */
export function applyStreamMessage(state, message) {
  const next = message.id === null ? state : { ...state, lastEventId: message.id };
  const event = parseData(message.data);
  if (message.event === 'stream.reset') return { state: next, effects: [{ type: 'reload', targets: reloadTargets(event) }] };
  return { state: next, effects: event === null ? [] : [{ type: 'event', event }] };
}
