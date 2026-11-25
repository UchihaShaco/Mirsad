/**
 * Contact sync rules without a server: configuration, which numbers qualify, and the retry bookkeeping of the claim.
 * Reserved fictional numbers only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import {
  CONTACT_SYNC_MAX_ATTEMPTS, claimNextSync, flaggedNumbers, publishableNumber, reconcileContactSync, recordSyncOutcome, retryDelayMs,
} from '../../src/services/contact-sync.ts';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import * as watchlist from '../../src/storage/repos/watchlist.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { seedTestData } from '../helpers/test-seed.ts';

describe('contact sync configuration', () => {
  it('is off unless a loopback URL is set, and keeps the token out of the URL', () => {
    expect(loadConfig({}).contactSync).toBeNull();
    expect(loadConfig({ MIRSAD_CONTACT_SYNC_URL: 'http://127.0.0.1:8080/' }).contactSync).toEqual({
      url: 'http://127.0.0.1:8080', token: null, label: 'Flagged on the Mirsad portal', source: 'mirsad-portal',
    });
    expect(loadConfig({
      MIRSAD_CONTACT_SYNC_URL: 'http://localhost:8080', MIRSAD_CONTACT_SYNC_TOKEN: ' admin-token ',
      MIRSAD_CONTACT_SYNC_LABEL: 'Mirsad (Abu Dhabi)', MIRSAD_CONTACT_SYNC_SOURCE: 'mirsad-portal-ad',
    }).contactSync).toEqual({ url: 'http://localhost:8080', token: 'admin-token', label: 'Mirsad (Abu Dhabi)', source: 'mirsad-portal-ad' });
  });

  it('rejects a remote or malformed URL and a label or source that is not short plain text', () => {
    for (const url of ['https://sync.example.test', 'http://127.0.0.1.example.test:8080', 'ftp://127.0.0.1/', 'not a url']) {
      expect(() => loadConfig({ MIRSAD_CONTACT_SYNC_URL: url }), url).toThrow(/MIRSAD_CONTACT_SYNC_URL/);
    }
    const url = 'http://127.0.0.1:8080';
    expect(() => loadConfig({ MIRSAD_CONTACT_SYNC_URL: url, MIRSAD_CONTACT_SYNC_LABEL: 'x'.repeat(65) })).toThrow(/MIRSAD_CONTACT_SYNC_LABEL/);
    expect(() => loadConfig({ MIRSAD_CONTACT_SYNC_URL: url, MIRSAD_CONTACT_SYNC_SOURCE: '<script>' })).toThrow(/MIRSAD_CONTACT_SYNC_SOURCE/);
  });
});

describe('contact sync numbers', () => {
  let dir: string;
  let db: Db;
  let clock: FakeClock;
  let workspaceId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-sync-'));
    clock = new FakeClock();
    db = openDatabase(path.join(dir, 'mirsad.sqlite'), { clock });
    seedTestData(db);
    workspaceId = db.transaction(tx => tx.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1')!.id);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const entry = (matchKey: string, e164: string | null, status: 'needs_review' | 'approved' | 'cleared') => db.transaction((tx) => {
    const row = watchlist.insertEntry(tx, { workspaceId, matchKey, e164, display: matchKey, seenAt: tx.now() });
    return status === 'needs_review' ? row : watchlist.updateEntryStatus(tx, row.id, status, 2);
  });

  it('publishes only approved numbers the portal normalises to E.164, once each, and counts the rest as skipped', () => {
    expect(publishableNumber('+447700900321')).toBe('+447700900321');
    expect(publishableNumber('+44 7700 900321')).toBeNull();
    expect(publishableNumber('07700900321')).toBeNull();
    expect(publishableNumber(null)).toBeNull();
    const approved = entry('+447700900321', '+447700900321', 'approved');
    entry('+447700900322', '+447700900322', 'needs_review');
    entry('+447700900323', '+447700900323', 'cleared');
    entry('unnormalized:chat_x:07700900324', null, 'approved');
    const { numbers, skipped } = db.transaction(flaggedNumbers);
    expect([...numbers]).toEqual([['+447700900321', approved.id]]);
    expect(skipped).toBe(1);
  });

  it('claims a changed number once per attempt, backs off, stops after the last attempt and starts again on a new change', () => {
    const approved = entry('+12025550143', '+12025550143', 'approved');
    const job = db.transaction(claimNextSync);
    expect(job).toEqual({ e164: '+12025550143', active: true, reference: approved.id });
    expect(db.transaction(claimNextSync)).toBeNull();

    for (let attempt = 1; attempt < CONTACT_SYNC_MAX_ATTEMPTS; attempt += 1) {
      db.transaction((tx) => recordSyncOutcome(tx, job!, { ok: false, code: 'unreachable', retry: true }));
      clock.advance(retryDelayMs(attempt) - 1);
      expect(db.transaction(claimNextSync), `before retry ${attempt}`).toBeNull();
      clock.advance(1);
      expect(db.transaction(claimNextSync), `retry ${attempt}`).toEqual(job);
    }
    db.transaction((tx) => recordSyncOutcome(tx, job!, { ok: false, code: 'unreachable', retry: true }));
    clock.advance(retryDelayMs(CONTACT_SYNC_MAX_ATTEMPTS));
    expect(db.transaction(claimNextSync)).toBeNull();
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n))).toEqual([2000, 8000, 32_000, 128_000]);

    // Withdrawn: a new target with its own attempts, then delivered and quiet.
    db.transaction((tx) => watchlist.updateEntryStatus(tx, approved.id, 'cleared', 3));
    const withdraw = db.transaction(claimNextSync);
    expect(withdraw).toEqual({ e164: '+12025550143', active: false, reference: approved.id });
    db.transaction((tx) => recordSyncOutcome(tx, withdraw!, { ok: true }));
    expect(db.transaction(claimNextSync)).toBeNull();
    // A restart sends nothing for a number already withdrawn.
    expect(db.transaction(reconcileContactSync)).toEqual({ flagged: 0, requeued: 0, skipped: 0 });
    expect(db.transaction(claimNextSync)).toBeNull();
  });

  it('a refusal ends the attempts at once; a restart gives the flagged set one more round', () => {
    entry('+447700900325', '+447700900325', 'approved');
    const job = db.transaction(claimNextSync)!;
    db.transaction((tx) => recordSyncOutcome(tx, job, { ok: false, code: 'number_refused', retry: false }));
    clock.advance(retryDelayMs(1));
    expect(db.transaction(claimNextSync)).toBeNull();
    expect(db.transaction(reconcileContactSync)).toEqual({ flagged: 1, requeued: 1, skipped: 0 });
    expect(db.transaction(claimNextSync)).toEqual(job);
  });
});
