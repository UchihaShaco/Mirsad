import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { findLiveBindings } from '../adapters/telegram/live-connector.ts';
import type { Principal } from '../ports/identity.ts';
import type { Db, Tx } from '../storage/db.ts';
import { grantAccount, toPrincipal } from '../storage/repos/principals.ts';
import type { PrincipalRow } from '../storage/rows.ts';
import { provisionPrincipal } from './provision.ts';
import { hashToken } from './tokens.ts';

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const HASH_BYTES = 32;
const SALT_BYTES = 16;
// Password hashes in schema version 3 use this fixed scrypt profile.
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const DUMMY_SALT = randomBytes(SALT_BYTES);
const DUMMY_HASH = Buffer.alloc(HASH_BYTES);
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;

type ProvisionErrorCode = 'invalid_username' | 'invalid_password' | 'live_binding_unavailable' | 'username_taken' | 'officer_not_found';
export class OfficerProvisionError extends Error {
  constructor(readonly code: ProvisionErrorCode) {
    super(code);
  }
}

function validPassword(password: string): boolean {
  if (password.length < 12 || password.length > 256) return false;
  const characters = [...password].length;
  return characters >= 12 && characters <= 128;
}

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, HASH_BYTES, SCRYPT_OPTIONS, (error, hash) => error ? reject(error) : resolve(hash));
  });
}

/** Trusted local provisioning only. The existing connector determines both workspace and account. */
export async function provisionLiveOfficer(
  db: Db, username: string, password: string, options: { temporary?: boolean } = {},
): Promise<Principal> {
  if (!USERNAME.test(username)) throw new OfficerProvisionError('invalid_username');
  if (!validPassword(password)) throw new OfficerProvisionError('invalid_password');
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);
  return db.transaction(tx => {
    const bindings = findLiveBindings(tx);
    if (bindings.length !== 1) throw new OfficerProvisionError('live_binding_unavailable');
    if (tx.get('SELECT 1 FROM officer_passwords WHERE username=?', [username])) {
      throw new OfficerProvisionError('username_taken');
    }
    const binding = bindings[0]!;
    const { principal } = provisionPrincipal(tx, {
      workspaceId: binding.principal.workspaceId, kind: 'officer', displayName: username,
    });
    tx.run('INSERT INTO officer_passwords (principal_id, username, salt, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?)',
      [principal.id, username, salt, hash, options.temporary ?? false]);
    grantAccount(tx, principal.id, binding.account.id);
    return principal;
  });
}

interface PasswordRecord {
  principal_id: string;
  salt: Uint8Array;
  password_hash: Uint8Array;
  must_change_password: number;
}

const ACTIVE_CREDENTIAL = `SELECT c.principal_id, c.salt, c.password_hash, c.must_change_password
  FROM officer_passwords c JOIN principals p ON c.principal_id=p.id
  WHERE c.username=? AND p.kind='officer' AND p.disabled=0`;

/** A local reset keeps the officer's grants and invalidates all their outstanding sessions. */
export async function resetLiveOfficerPassword(db: Db, username: string, temporaryPassword: string): Promise<void> {
  if (!USERNAME.test(username)) throw new OfficerProvisionError('invalid_username');
  if (!validPassword(temporaryPassword)) throw new OfficerProvisionError('invalid_password');
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(temporaryPassword, salt);
  db.transaction(tx => {
    const bindings = findLiveBindings(tx);
    if (bindings.length !== 1) throw new OfficerProvisionError('live_binding_unavailable');
    const officer = tx.get<PasswordRecord>(ACTIVE_CREDENTIAL, [username]);
    if (!officer || !tx.get('SELECT 1 FROM account_grants WHERE principal_id=? AND channel_account_id=?',
      [officer.principal_id, bindings[0]!.account.id])) throw new OfficerProvisionError('officer_not_found');
    tx.run('UPDATE officer_passwords SET salt=?, password_hash=?, must_change_password=1 WHERE principal_id=?',
      [salt, hash, officer.principal_id]);
    tx.run('DELETE FROM officer_sessions WHERE principal_id=?', [officer.principal_id]);
  });
}

type OfficerLogin = { token: string } | { passwordChangeRequired: true };

export async function loginOfficer(
  db: Db, username: string, password: string, newPassword?: string,
): Promise<OfficerLogin | null> {
  if (!USERNAME.test(username) || !validPassword(password)) return null;
  const record = db.transaction(tx => tx.get<PasswordRecord>(ACTIVE_CREDENTIAL, [username]));
  const hash = await derive(password, record?.salt ?? DUMMY_SALT);
  if (!timingSafeEqual(hash, record?.password_hash ?? DUMMY_HASH) || !record) return null;
  if (record.must_change_password && newPassword === undefined) return { passwordChangeRequired: true };
  let replacement: { salt: Buffer; hash: Buffer } | undefined;
  if (newPassword !== undefined) {
    if (!record.must_change_password) return null;
    if (!validPassword(newPassword) || newPassword === password) throw new OfficerProvisionError('invalid_password');
    const salt = randomBytes(SALT_BYTES);
    replacement = { salt, hash: await derive(newPassword, salt) };
  }
  return db.transaction(tx => {
    // An officer or their credential can change while scrypt runs outside the transaction.
    const current = tx.get<PasswordRecord>(ACTIVE_CREDENTIAL, [username]);
    if (!current || current.principal_id !== record.principal_id ||
      current.must_change_password !== record.must_change_password || !timingSafeEqual(hash, current.password_hash)) return null;
    if (replacement) {
      tx.run('UPDATE officer_passwords SET salt=?, password_hash=?, must_change_password=0 WHERE principal_id=?',
        [replacement.salt, replacement.hash, current.principal_id]);
      tx.run('DELETE FROM officer_sessions WHERE principal_id=?', [current.principal_id]);
    }
    const now = tx.now();
    const expiresAt = new Date(Date.parse(now) + SESSION_LIFETIME_MS).toISOString();
    const token = 'session_' + randomBytes(32).toString('base64url');
    tx.run('DELETE FROM officer_sessions WHERE expires_at <= ?', [now]);
    tx.run('INSERT INTO officer_sessions (token_sha256, principal_id, expires_at) VALUES (?, ?, ?)',
      [hashToken(token), record.principal_id, expiresAt]);
    return { token };
  });
}

export function lookupActiveOfficerSession(tx: Tx, token: string): Principal | null {
  const row = tx.get<PrincipalRow>(`SELECT p.* FROM officer_sessions s JOIN principals p ON p.id=s.principal_id
    WHERE s.token_sha256=? AND s.expires_at>? AND p.kind='officer' AND p.disabled=0`, [hashToken(token), tx.now()]);
  return row ? toPrincipal(row) : null;
}

export function logoutOfficer(db: Db, token: string): void {
  db.transaction(tx => tx.run('DELETE FROM officer_sessions WHERE token_sha256=?', [hashToken(token)]));
}
