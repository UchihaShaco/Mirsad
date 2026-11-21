import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { fail } from '../../contract/errors.ts';
import type { AppEnv } from '../context.ts';

export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Rejects request bodies over 256 KiB with 413 payload_too_large (by Content-Length or while streaming).
 * The connection is closed because the rest of the oversized body is never read.
 */
export function requestBodyLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        fail({ code: 'payload_too_large', message: `Request bodies are limited to ${MAX_BODY_BYTES} bytes.` }),
        413,
        { Connection: 'close' },
      ),
  });
}
