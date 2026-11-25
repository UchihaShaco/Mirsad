/**
 * The signed phone blocklist: approved numbers the officer can see and the fingerprints of citizen reports from them,
 * signed with the deployment key; a phone verifies it with the published key. Fictional numbers only.
 */
import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKLIST_KEY_FILE, signedText, type BlocklistFile } from '../../src/services/blocklist-export.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const REPORT = JSON.parse(readFileSync(new URL('../../contracts/fixtures/citizen-report.v1.json', import.meta.url), 'utf8'));

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const officerA = () => h.http(h.tokens.officerA);
const exportList = async (token = h.tokens.officerA): Promise<BlocklistFile> => {
  const res = await h.http(token).get('/v1/watchlist/blocklist');
  expect(res.status, res.text).toBe(200);
  return res.body.data.file;
};
const verifies = (file: BlocklistFile, publicKey: string) => verify('sha256', Buffer.from(signedText(file), 'utf8'),
  { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'der' },
  Buffer.from(file.signature, 'base64'));
const report = (sender: string, reportId: string, fingerprint: string, synthetic = false) =>
  ({ ...REPORT, reportId, fingerprint, synthetic, artifacts: { ...REPORT.artifacts, sender, phones: [] } });
const entryFor = async (e164: string) =>
  (await officerA().get('/v1/watchlist')).body.data.entries.find((e: { number: { e164: string } }) => e.number.e164 === e164);

describe('phone blocklist export', () => {
  it('signs an empty list with a key kept in the data directory', async () => {
    const file = await exportList();
    expect(file).toMatchObject({ version: 1, numbers: [], domains: [], fingerprints: [] });
    expect(Date.parse(file.expiresAt) - Date.parse(file.issuedAt)).toBe(30 * 86_400_000);
    const key = (await officerA().get('/v1/watchlist/blocklist-key')).body.data;
    expect(key.keyId).toBe(file.keyId);
    expect(verifies(file, key.publicKey)).toBe(true);
    expect(fs.existsSync(path.join(h.dataDir, BLOCKLIST_KEY_FILE))).toBe(true);
    expect((await exportList()).keyId).toBe(file.keyId);
  });

  it('carries approved numbers and their reports’ fingerprints, and nothing else', async () => {
    // Reported and approved by a flag: in, with the report's fingerprint.
    const flagged = await officerA().post('/v1/citizen-reports', { report: report('+971500000401', 'mrs-b10c00000001', '1111111111111111') });
    expect(flagged.status, flagged.text).toBe(201);
    expect((await officerA().post(`/v1/chats/${flagged.body.data.chatId}/scammer-flags`, { phone: '+971500000401', reason: 'Confirmed by the officer.' })).status).toBe(201);
    // Reported but not decided: out. A demo report of an approved number adds no fingerprint.
    expect((await officerA().post('/v1/citizen-reports', { report: report('+971500000402', 'mrs-b10c00000002', '2222222222222222') })).status).toBe(201);
    expect((await officerA().post('/v1/citizen-reports', { report: report('+971500000401', 'mrs-b10c00000003', '3333333333333333', true), demo: true })).status).toBe(201);

    const file = await exportList();
    expect(file.numbers).toEqual(['+971500000401']);
    expect(file.fingerprints).toEqual(['1111111111111111']);
    expect(file.domains).toEqual([]);
    const key = (await officerA().get('/v1/watchlist/blocklist-key')).body.data;
    expect(verifies(file, key.publicKey)).toBe(true);
    // Any change to the content breaks the signature.
    expect(verifies({ ...file, numbers: ['+971500000402'] }, key.publicKey)).toBe(false);
    expect(verifies({ ...file, expiresAt: '2099-01-01T00:00:00.000Z' }, key.publicKey)).toBe(false);
    // Another workspace exports none of it.
    expect((await exportList(h.tokens.outsider)).numbers).toEqual([]);

    // Clearing the number takes it, and its fingerprint, off the next list.
    const entry = await entryFor('+971500000401');
    expect((await officerA().post(`/v1/watchlist/${entry.id}/review`, { decision: 'clear', reason: 'Wrong person.', expectedRevision: entry.revision })).status).toBe(200);
    expect(await exportList()).toMatchObject({ numbers: [], fingerprints: [] });
  });
});
