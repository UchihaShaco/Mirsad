/** Minimal SSE client for tests: parses frames into messages and counts keep-alive comments. */

export interface StreamMessage {
  id: string | null;
  event: string;
  // Parsed JSON data of the frame.
  data: any;
}

export interface OpenStreamOptions {
  cursor?: string | number;
  lastEventId?: string | number;
}

export interface StreamClient {
  status: number;
  received: StreamMessage[];
  /** Comment lines received so far (the server's keep-alives). */
  readonly comments: number;
  next(predicate?: (message: StreamMessage) => boolean, timeoutMs?: number): Promise<StreamMessage>;
  close(): void;
  /** Resolves when the server ends the stream or close() is called. */
  ended: Promise<void>;
}

const DEFAULT_NEXT_TIMEOUT_MS = 5_000;

function parseFrame(frame: string): StreamMessage | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { id, event, data: parsed };
}

export async function openStream(baseUrl: string, token: string, options: OpenStreamOptions = {}): Promise<StreamClient> {
  const controller = new AbortController();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
  const query = options.cursor !== undefined ? `?cursor=${encodeURIComponent(String(options.cursor))}` : '';
  const res = await fetch(`${baseUrl}/v1/events${query}`, { headers, signal: controller.signal });
  if (res.status !== 200 || !res.body) {
    const text = await res.text();
    throw new Error(`stream_open_failed:${res.status}:${text}`);
  }

  const received: StreamMessage[] = [];
  const listeners = new Set<() => void>();
  let readIndex = 0;
  let finished = false;
  let comments = 0;

  const pump = async () => {
    const decoder = new TextDecoder();
    const reader = res.body!.getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          comments += frame.split('\n').filter((line) => line.startsWith(':')).length;
          const message = parseFrame(frame);
          buffer = buffer.slice(boundary + 2);
          if (message) received.push(message);
          boundary = buffer.indexOf('\n\n');
        }
        for (const notify of listeners) notify();
      }
    } catch {
      // Aborted by close() or the server going away: the stream simply ends.
    } finally {
      finished = true;
      for (const notify of listeners) notify();
    }
  };
  const ended = pump();

  const next = (predicate: (m: StreamMessage) => boolean = () => true, timeoutMs = DEFAULT_NEXT_TIMEOUT_MS) =>
    new Promise<StreamMessage>((resolve, reject) => {
      const check = () => {
        while (readIndex < received.length) {
          const candidate = received[readIndex]!;
          readIndex += 1;
          if (predicate(candidate)) {
            cleanup();
            resolve(candidate);
            return;
          }
        }
        if (finished) {
          cleanup();
          reject(new Error('stream_ended'));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`stream_next_timeout after ${timeoutMs} ms; received ${received.length} messages`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });

  return {
    status: res.status,
    received,
    get comments() {
      return comments;
    },
    next,
    close: () => controller.abort(),
    ended,
  };
}
