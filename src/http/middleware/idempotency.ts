/**
 * Idempotency-Key handling (design section 5): scoped to principal + scope, stored in the same
 * transaction as the effect. Same key and body replays; same key with another body is 422.
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { AppError } from '../../contract/errors.ts';
import type { Principal } from '../../ports/identity.ts';
import type { Tx } from '../../storage/db.ts';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface IdempotentResult extends IdempotentResponse {
  replayed: boolean;
}

/** JSON with object keys sorted, so equal bodies hash equally regardless of key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Reads and validates the Idempotency-Key header; missing or malformed is 400 idempotency_key_required. */
export function requireIdempotencyKey(c: Context): string {
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (key === undefined || !KEY_PATTERN.test(key)) {
    throw AppError.of('idempotency_key_required', 'An Idempotency-Key header of 1 to 200 visible characters is required.');
  }
  return key;
}

export function withIdempotency(
  tx: Tx,
  principal: Principal,
  scope: string,
  key: string,
  body: unknown,
  effect: () => IdempotentResponse,
): IdempotentResult {
  const requestSha256 = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  const stored = tx.get<{ request_sha256: string; status_code: number; response_body: string }>(
    `SELECT request_sha256, status_code, response_body FROM idempotency_keys
     WHERE principal_id = :principalId AND scope = :scope AND key = :key`,
    { principalId: principal.id, scope, key },
  );
  if (stored) {
    if (stored.status_code === 410) throw AppError.of('history_erased', 'The history for this operation was erased.');
    if (stored.request_sha256 !== requestSha256) {
      throw AppError.of('idempotency_key_reused', 'This Idempotency-Key was already used with a different request body.');
    }
    return { status: stored.status_code, body: JSON.parse(stored.response_body), replayed: true };
  }
  const response = effect();
  tx.run(
    `INSERT INTO idempotency_keys (principal_id, scope, key, request_sha256, status_code, response_body, created_at)
     VALUES (:principalId, :scope, :key, :requestSha256, :status, :body, :at)`,
    {
      principalId: principal.id,
      scope,
      key,
      requestSha256,
      status: response.status,
      body: JSON.stringify(response.body),
      at: tx.now(),
    },
  );
  return { ...response, replayed: false };
}
