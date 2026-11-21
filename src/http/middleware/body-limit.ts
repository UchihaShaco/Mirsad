import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { fail } from '../../contract/errors.ts';
import type { AppEnv } from '../context.ts';

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_INTAKE_BODY_BYTES = 1024 * 1024;
/** An unread body is discarded up to this size; a larger or slower one ends with the connection closed. */
const MAX_DISCARD_BYTES = 16 * 1024 * 1024;
const DISCARD_TIMEOUT_MS = 2000;

/** The two intake routes (design section 5) accept larger bodies. */
const INTAKE_PATH = /^\/v1\/(ingest|chats\/[^/]+\/events)$/;

/**
 * Reads and discards whatever request body the route left unread (an early refusal, a 413, a stub). Left
 * unread, the Node server later destroys the keep-alive socket and the client's next request on it is reset;
 * closing instead while the client is still uploading resets this request, and on Windows that reset also
 * discards the response the client already received. Returns false when the body was cut off.
 */
async function discardUnreadBody(c: Context<AppEnv>): Promise<boolean> {
  const body = c.req.raw.body;
  if (!body || body.locked) return true;
  const reader = body.getReader();
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), DISCARD_TIMEOUT_MS);
  try {
    let discarded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      discarded += value.byteLength;
      if (discarded > MAX_DISCARD_BYTES) {
        await reader.cancel();
        return false;
      }
    }
  } catch {
    // The client went away or the read was cancelled.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function limit(maxSize: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(
        fail({ code: 'payload_too_large', message: `Request bodies are limited to ${maxSize} bytes.` }),
        413,
      ),
  });
}

/**
 * Rejects request bodies over the limit with 413 payload_too_large (by Content-Length or while streaming):
 * 1 MiB on POST /v1/ingest and POST /v1/chats/{chatId}/events, 256 KiB elsewhere. After the response is
 * ready, any body the route did not read is discarded so the connection stays usable.
 */
export function requestBodyLimit(): MiddlewareHandler<AppEnv> {
  const intake = limit(MAX_INTAKE_BODY_BYTES);
  const standard = limit(MAX_BODY_BYTES);
  return async (c, next) => {
    const isIntake = c.req.method === 'POST' && INTAKE_PATH.test(c.req.path);
    // bodyLimit returns its 413 instead of calling next(); adopt it so headers below apply to it.
    const outcome: unknown = await (isIntake ? intake : standard)(c, next);
    if (outcome instanceof Response) c.res = outcome;
    if (!(await discardUnreadBody(c))) c.header('Connection', 'close');
  };
}
