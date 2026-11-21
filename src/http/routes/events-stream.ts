/**
 * GET /v1/events (design section 12): server-sent events for the caller's workspace. The start position is the
 * Last-Event-ID header, else ?cursor=, else the head; nothing else in the query string is read, so a token there
 * never authenticates. The database is the source of truth: each batch comes from readStreamBatch, the bus only
 * wakes the loop, and a wait that times out reads again, so a disabled principal or a pruned position is noticed.
 */
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { AppDeps } from '../../app.ts';
import type { StreamWireMessage } from '../../contract/stream-events.ts';
import type { Principal } from '../../ports/identity.ts';
import { currentCursor } from '../../services/chats.ts';
import { readStreamBatch, type StreamBatch } from '../../services/stream-subscribe.ts';
import type { StreamEventRow } from '../../storage/rows.ts';
import { principalOf, type AppEnv, type RouteModule } from '../context.ts';
import { parseWith } from '../middleware/validate.ts';

const STREAM_BATCH_LIMIT = 500;
const KEEP_ALIVE_COMMENT = ': keep-alive\n\n';
/** Sequence numbers as decimal strings, short enough to stay below 2^53. */
const StreamPosition = z.string().regex(/^\d{1,15}$/).transform(Number);
const StartParams = z.object({ lastEventId: StreamPosition.optional(), cursor: StreamPosition.optional() });

type CloseReason = 'disconnected' | 'principal_disabled' | 'failed';

interface SseFrame {
  id: string;
  event: string;
  data: string;
}

/** Last-Event-ID, else ?cursor=, else the current head; a malformed value is 400 validation_failed. */
function startPosition(c: Context<AppEnv>, deps: AppDeps, principal: Principal): number {
  const header = c.req.header('last-event-id');
  const params = parseWith(StartParams, { lastEventId: header === '' ? undefined : header, cursor: c.req.query('cursor') });
  const requested = params.lastEventId ?? params.cursor;
  if (requested !== undefined) return requested;
  return Number(deps.db.transaction((tx) => currentCursor(tx, principal.workspaceId)));
}

/** One SSE message per event: id = the sequence, event = the type, data = ids and statuses only. */
function eventFrame(row: StreamEventRow): SseFrame {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const wire = { id: String(row.seq), type: row.type, chatId: row.chat_id, occurredAt: row.occurred_at, ...data };
  return { id: String(row.seq), event: row.type, data: JSON.stringify(wire) };
}

/** Carries the head as its id, so a reconnect after a reset resumes from there. */
function resetFrame(resumeFrom: number, occurredAt: string): SseFrame {
  const id = String(resumeFrom);
  const wire: StreamWireMessage<'stream.reset'> = {
    id, type: 'stream.reset', chatId: null, occurredAt, reason: 'cursor_out_of_range', resumeFrom: id, reload: ['inbox', 'timeline'],
  };
  return { id, event: 'stream.reset', data: JSON.stringify(wire) };
}

/** Writes the batch and returns how many events it delivered. */
async function writeBatch(stream: SSEStreamingApi, batch: StreamBatch, deps: AppDeps): Promise<number> {
  if (batch.reset) await stream.writeSSE(resetFrame(batch.reset.resumeFrom, deps.clock.now().toISOString()));
  for (const row of batch.events) await stream.writeSSE(eventFrame(row));
  return batch.events.length;
}

/**
 * Runs one subscription until the client disconnects, the server closes or the principal is disabled. It never
 * throws: Hono prints an error that escapes a stream callback to the console.
 */
async function subscribe(stream: SSEStreamingApi, deps: AppDeps, principal: Principal, start: number): Promise<void> {
  const aborted = new AbortController();
  stream.onAbort(() => aborted.abort());
  if (stream.aborted) aborted.abort();
  const keepAlive = setInterval(() => void stream.write(KEEP_ALIVE_COMMENT), deps.streamKeepAliveMs);
  keepAlive.unref();
  let position = start;
  let delivered = 0;
  let reason: CloseReason = 'disconnected';
  try {
    while (!aborted.signal.aborted) {
      const batch = deps.db.transaction((tx) => readStreamBatch(tx, principal, position, STREAM_BATCH_LIMIT));
      if (batch.disabled) {
        reason = 'principal_disabled';
        break;
      }
      if (batch.lastSeq === position) {
        // Nothing new: sleep until a commit, or re-check after the interval. Nothing may be awaited between the
        // read and registering the wait, or a commit landing in between would wake nobody.
        await deps.bus.wait(principal.workspaceId, aborted.signal, deps.streamKeepAliveMs);
        continue;
      }
      position = batch.lastSeq;
      // Read again at once afterwards: more may have been committed while writing.
      delivered += await writeBatch(stream, batch, deps);
    }
  } catch (error) {
    if (!aborted.signal.aborted) {
      reason = 'failed';
      deps.logger.error('stream_failed', { principalId: principal.id, errorClass: error instanceof Error ? error.name : typeof error });
    }
  } finally {
    clearInterval(keepAlive);
    deps.logger.info('stream_closed', { principalId: principal.id, reason, delivered });
  }
}

export const routes: RouteModule = {
  'GET /v1/events': (c, deps) => {
    const principal = principalOf(c);
    const start = startPosition(c, deps, principal);
    return streamSSE(c, (stream) => subscribe(stream, deps, principal, start));
  },
};
