/** Types for stream-client.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { StreamWireMessage } from '../../contract/stream-events.ts';

export type ReloadTarget = 'inbox' | 'timeline';
export type StreamStatus = 'live' | 'reconnecting';

export interface FetchInit {
  headers: Record<string, string>;
  signal: AbortSignal;
  cache: 'no-store';
}
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface EventStreamOptions {
  token: string;
  /** The snapshot cursor from GET /v1/chats; used until the first event arrives, then Last-Event-ID takes over. */
  cursor: string | null;
  onEvent(event: StreamWireMessage): void;
  onReload(targets: ReloadTarget[]): void;
  onUnauthorized?(): void;
  onStatus?(status: StreamStatus): void;
  fetch?: FetchLike;
  /** Waits before a reconnect; resolves early when the signal aborts. */
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface EventStream {
  start(): void;
  stop(): void;
}

export function createEventStream(options: EventStreamOptions): EventStream;
