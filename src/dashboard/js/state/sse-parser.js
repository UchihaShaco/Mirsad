/**
 * A small server-sent events parser following the WHATWG "parsing an event stream" rules (types in sse-parser.d.ts).
 * It takes chunks of any size, as bytes or text: lines end with CRLF, LF or CR (a CRLF split across chunks is still one
 * line end), comment lines start with ':', several data lines join with LF, and the last event ID carries over between
 * events. The retry field and unknown fields are ignored: the dashboard has its own reconnect policy.
 */

const BYTE_ORDER_MARK = 0xfeff;
const NO_EVENT = { data: [], type: '', lastEventId: null };

/** Splits off every complete line; a CR at the very end waits for the next chunk unless the stream has ended. */
function takeLines(buffer, final) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char !== '\n' && char !== '\r') continue;
    if (char === '\r' && index === buffer.length - 1 && !final) break;
    lines.push(buffer.slice(start, index));
    if (char === '\r' && buffer[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

function fieldOf(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return { field: line, value: '' };
  const raw = line.slice(colon + 1);
  return { field: line.slice(0, colon), value: raw.startsWith(' ') ? raw.slice(1) : raw };
}

/** The event state after one line, and the message it completed (a blank line after data), if any. */
function applyLine(event, line) {
  if (line === '') {
    const message = event.data.length === 0 ? null : { id: event.lastEventId, event: event.type || 'message', data: event.data.join('\n') };
    return { event: { ...event, data: [], type: '' }, message };
  }
  if (line.startsWith(':')) return { event, message: null };
  const { field, value } = fieldOf(line);
  if (field === 'data') return { event: { ...event, data: [...event.data, value] }, message: null };
  if (field === 'event') return { event: { ...event, type: value }, message: null };
  if (field === 'id' && !value.includes('\u0000')) return { event: { ...event, lastEventId: value }, message: null };
  return { event, message: null };
}

export function createSseParser(onMessage) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let started = false;
  let event = NO_EVENT;

  function feed(text, final) {
    let next = text;
    if (!started && next !== '') {
      started = true;
      if (next.charCodeAt(0) === BYTE_ORDER_MARK) next = next.slice(1);
    }
    const { lines, rest } = takeLines(buffer + next, final);
    buffer = rest;
    for (const line of lines) {
      const result = applyLine(event, line);
      event = result.event;
      if (result.message !== null) onMessage(result.message);
    }
  }

  return {
    push(chunk) {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }), false);
    },
    end() {
      feed(decoder.decode(), true);
      // An event that never got its closing blank line is discarded.
      buffer = '';
      event = { ...event, data: [], type: '' };
    },
  };
}
