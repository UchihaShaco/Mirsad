import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { seedDemo, DEMO_CREDENTIALS_FILE } from '../../src/identity/seed.ts';
import { createDemoIdentity } from '../../src/identity/demo-identity.ts';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-seed-'));
  db = openDatabase(path.join(dir, 'mirsad.sqlite'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('demo seed', () => {
  it('demo seed creates the workspace, officers, accounts and connector once, stores only token hashes and writes demo-credentials.json', () => {
    const first = seedDemo(db, { dataDir: dir });
    const second = seedDemo(db, { dataDir: dir });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const counts = db.transaction((tx) => ({
      workspaces: tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')?.n,
      officers: tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM principals WHERE kind = 'officer'")?.n,
      connectors: tx.all<{ capture_method: string; trusted_start_marker: number }>(
        "SELECT capture_method, trusted_start_marker FROM principals WHERE kind = 'connector'",
      ),
      accounts: tx.all<{ external_account_id: string; is_intake: number; source: string }>(
        'SELECT external_account_id, is_intake, source FROM channel_accounts ORDER BY external_account_id',
      ),
      grants: tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM account_grants')?.n,
      hashes: tx.all<{ token_sha256: string }>('SELECT token_sha256 FROM principals'),
    }));
    expect(counts.workspaces).toBe(1);
    expect(counts.officers).toBe(2);
    expect(counts.connectors).toEqual([{ capture_method: 'fixture_replay', trusted_start_marker: 1 }]);
    expect(counts.accounts).toEqual([
      { external_account_id: 'tg-demo-intake', is_intake: 1, source: 'telegram' },
      { external_account_id: 'tg-demo-officer', is_intake: 0, source: 'telegram' },
    ]);
    expect(counts.grants).toBe(6);

    const file = path.join(dir, DEMO_CREDENTIALS_FILE);
    const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(credentials.officers).toHaveLength(2);
    expect(credentials.officers[0].displayName).toBe('Demo Officer 1');
    const tokens: string[] = [...credentials.officers.map((o: { token: string }) => o.token), credentials.connector.token];
    const storedHashes = counts.hashes.map((h) => h.token_sha256).sort();
    expect(tokens.map(sha256).sort()).toEqual(storedHashes);
    const dump = db.transaction((tx) => JSON.stringify(tx.all('SELECT * FROM principals')));
    for (const token of tokens) expect(dump).not.toContain(token);

    const identity = createDemoIdentity(db);
    expect(identity.authenticate(`Bearer ${credentials.connector.token}`)).toMatchObject({
      kind: 'connector',
      captureMethod: 'fixture_replay',
      trustedStartMarker: true,
    });
    expect(identity.authenticate(`Bearer ${credentials.officers[1].token}`)).toMatchObject({
      kind: 'officer',
      displayName: 'Demo Officer 2',
    });
    expect(identity.authenticate('Bearer not-a-token')).toBeNull();
    expect(identity.authenticate(undefined)).toBeNull();
  });
});
