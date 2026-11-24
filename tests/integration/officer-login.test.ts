import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as passwords from '../../src/identity/officer-password.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { Gate } from '../helpers/gate.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import { openStream } from '../helpers/sse-client.ts';

const loginPath = '/v1/auth/login';
const logoutPath = '/v1/auth/logout';
const username = 'example-officer';
const password = 'synthetic-password-for-tests';
let h: TestHarness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

async function provisionOfficer(temporary = false) {
  const db = openDatabase(path.join(h.dataDir, DATABASE_FILE), { clock: h.clock });
  try {
    db.transaction(tx => tx.run('UPDATE channel_accounts SET external_account_id = :id WHERE external_account_id = :old', {
      id: '100000001', old: h.accounts.live.externalAccountId,
    }));
    return await passwords.provisionLiveOfficer(db, username, password, { temporary });
  } finally { db.close(); }
}

it('signs into the provisioned principal, invalidates just the current session and closes its open stream', async () => {
  const principal = await provisionOfficer();
  const officer = h.http(null);
  const unknown = await officer.post(loginPath, { username: 'missing-officer', password });
  const incorrect = await officer.post(loginPath, { username, password: 'incorrect-password' });
  expect(incorrect.body).toEqual(unknown.body);
  const login = await officer.post(loginPath, { username, password }, { origin: h.baseUrl });
  expect(login.status).toBe(200);
  expect(login.headers.get('cache-control')).toBe('no-store');
  expect(login.body.data).toEqual({ token: expect.stringMatching(/^session_/) });
  const token = login.body.data.token;
  const session = h.http(token);
  expect((await session.get('/v1/me')).body.data.principal.id).toBe(principal.id);
  const second = await officer.post(loginPath, { username, password });
  const stream = await openStream(h.baseUrl, token);
  try {
    expect((await session.post(logoutPath, undefined, { origin: 'https://other.example' })).status).toBe(403);
    const logout = await session.post(logoutPath);
    expect(logout.status).toBe(200);
    expect(logout.body.data).toEqual({ loggedOut: true });
    expect(logout.headers.get('cache-control')).toBe('no-store');
    await stream.ended;
    expect((await session.get('/v1/me')).status).toBe(401);
    expect((await h.http(second.body.data.token).get('/v1/me')).status).toBe(200);
    for (const secret of [username, password, token]) expect(h.logs.join('\n')).not.toContain(secret);
  } finally { stream.close(); }
});

it('ends an already-open event stream when its session expires without a logout', async () => {
  await provisionOfficer();
  const login = await h.http(null).post(loginPath, { username, password });
  const stream = await openStream(h.baseUrl, login.body.data.token);
  try {
    h.clock.advance(8 * 60 * 60 * 1000);
    await stream.ended;
    expect((await h.http(login.body.data.token).get('/v1/me')).status).toBe(401);
  } finally { stream.close(); }
});

it('withholds access until the officer replaces a temporary password and accepts exactly one concurrent change', async () => {
  const principal = await provisionOfficer(true);
  const officer = h.http(null);
  const challenge = await officer.post(loginPath, { username, password });
  expect(challenge.body.data).toEqual({ passwordChangeRequired: true });
  expect(challenge.headers.get('cache-control')).toBe('no-store');
  for (const newPassword of [password, 'too-short']) {
    const invalid = await officer.post(loginPath, { username, password, newPassword });
    expect(invalid.status).toBe(400);
    expect(invalid.text).not.toContain(newPassword);
  }
  const candidates = ['first synthetic replacement', 'second synthetic replacement'];
  const attempts = await Promise.all(candidates.map(newPassword => officer.post(loginPath, { username, password, newPassword })));
  expect(attempts.map(attempt => attempt.status).sort()).toEqual([200, 401]);
  const selected = attempts.findIndex(attempt => attempt.status === 200);
  const session = h.http(attempts[selected]!.body.data.token);
  expect((await session.get('/v1/me')).body.data.principal.id).toBe(principal.id);
  expect((await officer.post(loginPath, { username, password })).status).toBe(401);
  expect((await officer.post(loginPath, { username, password: candidates[selected] })).body.data.token).toMatch(/^session_/);
  for (const secret of [password, ...candidates]) expect(h.logs.join('\n')).not.toContain(secret);
});

it('an operator reset keeps the same officer and invalidates their old password and sessions', async () => {
  const principal = await provisionOfficer();
  const officer = h.http(null);
  const previous = await officer.post(loginPath, { username, password });
  const temporaryPassword = 'synthetic temporary password';
  const db = openDatabase(path.join(h.dataDir, DATABASE_FILE), { clock: h.clock });
  try {
    await passwords.resetLiveOfficerPassword(db, username.toUpperCase(), temporaryPassword);
  } finally { db.close(); }
  expect((await h.http(previous.body.data.token).get('/v1/me')).status).toBe(401);
  expect((await officer.post(loginPath, { username, password })).status).toBe(401);
  expect((await officer.post(loginPath, { username, password: temporaryPassword })).body.data).toEqual({ passwordChangeRequired: true });
  const changed = await officer.post(loginPath, { username, password: temporaryPassword, newPassword: 'synthetic chosen password' });
  expect((await h.http(changed.body.data.token).get('/v1/me')).body.data.principal.id).toBe(principal.id);
});

it('returns a generic 401 for unknown credentials and no-store on all credential responses', async () => {
  const response = await h.http(null).post(loginPath, { username, password });
  expect(response.status).toBe(401);
  expect(response.body.error.code).toBe('unauthenticated');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.text).not.toContain(username);
  expect(response.text).not.toContain(password);
  expect(h.logs.join('\n')).not.toContain(password);
});

it('rejects malformed credentials without reflecting their contents in errors or logs', async () => {
  const response = await h.http(null).post(loginPath, { username, password: { [password]: username } });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('validation_failed');
  expect(response.text + h.logs.join('\n')).not.toContain(username);
  expect(response.text + h.logs.join('\n')).not.toContain(password);
});

it('rejects a foreign origin, simple form submissions and connector logout', async () => {
  const foreign = { origin: 'https://other.example' };
  expect((await h.http(null).post(loginPath, { username, password }, foreign)).status).toBe(403);
  const plain = await fetch(h.baseUrl + loginPath, { method: 'POST', body: JSON.stringify({ username, password }) });
  expect(plain.status).toBe(400);
  expect((await h.http(h.tokens.connector).post(logoutPath)).status).toBe(403);
  expect((await h.http(null).post(logoutPath)).status).toBe(401);
});

it('shares the login limit across usernames and spoofed headers and reopens it after the clock advances', async () => {
  const verify = vi.spyOn(passwords, 'loginOfficer').mockResolvedValue(null);
  const attempt = (i: number) => h.http(`pretend-${i}`).post(loginPath, { username: `other-${i}`, password }, { 'x-forwarded-for': `192.0.2.${i}` });
  for (let i = 0; i < 10; i++) expect((await attempt(i)).status).toBe(401);
  expect((await attempt(10)).status).toBe(429);
  expect(verify).toHaveBeenCalledTimes(10);
  h.clock.advance(60_000);
  expect((await attempt(11)).status).toBe(401);
});

it('allows at most two simultaneous password checks and releases the slots after rejection', async () => {
  const gate = new Gate();
  gate.hold();
  vi.spyOn(passwords, 'loginOfficer').mockImplementation(async () => { await gate.pass(); return null; });
  const attempt = () => h.http(null).post(loginPath, { username, password });
  const pending = Promise.all([attempt(), attempt()]);
  try {
    await vi.waitFor(() => expect(gate.waiting).toBe(2));
    expect((await attempt()).status).toBe(429);
  } finally { gate.release(); await pending; }
  expect((await attempt()).status).toBe(401);
});
