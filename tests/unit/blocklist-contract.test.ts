/** The shared signed blocklist fixture (contracts/fixtures) verifies with its key; the Kotlin side tests the same file. */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlocklistFile } from '../../src/contract/schemas.ts';
import { signedText } from '../../src/services/blocklist-export.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${name}`, import.meta.url), 'utf8'));
const file = BlocklistFile.parse(read('blocklist.v1.signed.json'));
const key = read('blocklist-test-key.json');
const check = (candidate: typeof file) => verify('sha256', Buffer.from(signedText(candidate), 'utf8'),
  { key: createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'der' },
  Buffer.from(candidate.signature, 'base64'));

describe('signed blocklist contract', () => {
  it('verifies the shared fixture with its key, and the signed text has the documented shape', () => {
    expect(file.keyId).toBe(key.keyId);
    expect(check(file)).toBe(true);
    expect(signedText(file).split('\n')).toEqual([
      'mirsad-blocklist-v1', `keyId:${file.keyId}`, `issuer:${file.issuer}`, 'issuedAt:2026-11-25T00:00:00.000Z',
      'expiresAt:2099-12-31T00:00:00.000Z', 'numbers:+971500000401,+971500000403', 'domains:', 'fingerprints:1111111111111111',
    ]);
  });

  it('fails when any signed field changes; the note is not signed', () => {
    expect(check({ ...file, numbers: ['+971500000401'] })).toBe(false);
    expect(check({ ...file, issuer: 'Someone else' })).toBe(false);
    expect(check({ ...file, keyId: '0000000000000000' })).toBe(false);
    expect(check({ ...file, note: 'Edited note' })).toBe(true);
  });
});
