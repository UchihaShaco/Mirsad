/** Types for sse-parser.js (the browser loads the JavaScript; tests and typecheck read this declaration). */

export interface SseMessage {
  /** The last event ID seen on the stream so far (it carries over between events), or null. */
  id: string | null;
  /** The event type; 'message' when the frame had no event field. */
  event: string;
  data: string;
}

export interface SseParser {
  /** Feeds bytes (decoded as UTF-8, split anywhere) or already decoded text. */
  push(chunk: Uint8Array | string): void;
  /** Ends the stream; an event without its closing blank line is discarded. */
  end(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser;
