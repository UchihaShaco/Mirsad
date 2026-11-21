import { createHash, randomBytes } from 'node:crypto';
import type { PrincipalKind } from '../contract/enums.ts';

const TOKEN_BYTES = 32;
const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** A random bearer token. Only its SHA-256 is ever stored. */
export function generateToken(kind: PrincipalKind): string {
  const prefix = kind === 'officer' ? 'mso' : 'msc';
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}
