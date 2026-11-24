import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoIdentity } from '../../src/identity/demo-identity.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { hashToken } from '../../src/identity/tokens.ts';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { grantAccount, grantedAccountIds, insertChannelAccount } from '../../src/storage/repos/principals.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

const syntheticPassword = 'synthetic officer test password';
const clock = new FakeClock();
let db: Db;
beforeEach(() => { db = openDatabase(':memory:', { clock }); });
afterEach(() => db.close());

function addBinding(id = '10001') {
  return db.transaction(tx => {
    const workspace = provisionWorkspace(tx, { name: 'Synthetic test workspace' });
    const account = insertChannelAccount(tx, { workspaceId: workspace.id, source: 'telegram', externalAccountId: id, label: 'Synthetic live account', isIntake: true });
    const connector = provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'connector', displayName: 'Synthetic connector', captureMethod: 'telegram_business_live' });
    grantAccount(tx, connector.principal.id, account.id);
    insertChannelAccount(tx, { workspaceId: workspace.id, source: 'telegram', externalAccountId: 'fixture', label: 'Fixture', isIntake: true });
    return { workspace, account, connector };
  });
}

describe('officer password accounts', () => {
  it('creates a named officer with only the live account, salted password hashes and no duplicate account', async () => {
    const { provisionLiveOfficer } = await import('../../src/identity/officer-password.ts');
    const { workspace, account, connector } = addBinding();
    const officer = await provisionLiveOfficer(db, 'Investigator', syntheticPassword);
    expect(officer).toMatchObject({ kind: 'officer', displayName: 'Investigator', workspaceId: workspace.id });
    expect(db.transaction(tx => grantedAccountIds(tx, officer.id))).toEqual([account.id]);
    const results = await Promise.allSettled([
      provisionLiveOfficer(db, 'Second', syntheticPassword),
      provisionLiveOfficer(db, 'SECOND', syntheticPassword),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'username_taken' } });
    const rows = db.transaction(tx => tx.all<{ salt: Uint8Array; password_hash: Uint8Array }>('SELECT salt,password_hash FROM officer_passwords'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.salt).not.toEqual(rows[1]?.salt);
    expect(rows[0]?.password_hash).not.toEqual(rows[1]?.password_hash);
    expect(createDemoIdentity(db).authenticate('Bearer ' + connector.token)?.kind).toBe('connector');
    expect(db.transaction(tx => tx.get('SELECT count(*) AS n FROM principals'))).toEqual({ n: 3 });
  });

  it('returns a short-lived session, isolates logout to that session and honors disabled officers', async () => {
    const { loginOfficer, logoutOfficer, provisionLiveOfficer } = await import('../../src/identity/officer-password.ts');
    const login = async (username: string, password: string) => {
      const result = await loginOfficer(db, username, password);
      return result && 'token' in result ? result.token : null;
    };
    addBinding();
    const officer = await provisionLiveOfficer(db, 'Analyst', syntheticPassword);
    expect(await login('absent', syntheticPassword)).toBeNull();
    expect(await login('analyst', 'a different password')).toBeNull();
    const first = await login('ANALYST', syntheticPassword);
    const second = await login('analyst', syntheticPassword);
    expect(first?.startsWith('session_')).toBe(true);
    expect(second).not.toBe(first);
    expect(db.transaction(tx => tx.get('SELECT 1 AS found FROM officer_sessions WHERE token_sha256=?', [hashToken(first!)]))).toEqual({ found: 1 });
    const identity = createDemoIdentity(db);
    const resolve = (token: string | null) => identity.authenticate('Bearer ' + token);
    expect(resolve(first)?.id).toBe(officer.id);
    logoutOfficer(db, first!);
    logoutOfficer(db, first!);
    expect(resolve(first)).toBeNull();
    expect(resolve(second)?.id).toBe(officer.id);
    clock.advance(8 * 60 * 60 * 1000);
    expect(resolve(second)).toBeNull();
    const session = await login('analyst', syntheticPassword);
    db.transaction(tx => tx.run('UPDATE principals SET disabled=1 WHERE id=?', [officer.id]));
    expect(resolve(session)).toBeNull();
    expect(await login('analyst', syntheticPassword)).toBeNull();
  });

  it('fails closed with missing or ambiguous bindings and invalid credentials', async () => {
    const { provisionLiveOfficer } = await import('../../src/identity/officer-password.ts');
    const provision = (username: string, password: string) => provisionLiveOfficer(db, username, password);
    await expect(provision('analyst', syntheticPassword)).rejects.toMatchObject({ code: 'live_binding_unavailable' });
    addBinding();
    await expect(provision('x', syntheticPassword)).rejects.toMatchObject({ code: 'invalid_username' });
    await expect(provision('analyst', 'too-short')).rejects.toMatchObject({ code: 'invalid_password' });
    await expect(provision('analyst', 'x'.repeat(129))).rejects.toMatchObject({ code: 'invalid_password' });
    addBinding('10002');
    await expect(provision('analyst', syntheticPassword)).rejects.toMatchObject({ code: 'live_binding_unavailable' });
    expect(db.transaction(tx => tx.all("SELECT id FROM principals WHERE kind='officer'"))).toEqual([]);
  });
});
