/**
 * The phone blocklist: what the portal's phone watchlist tells Mirsad Android to block, as a signed file the phone
 * imports offline (mirsad-android/docs/EVIDENCE_SCHEMA.md, section 6; contracts/README.md). Only approved numbers the
 * exporting officer can see go out, with the message fingerprints of citizen reports whose sender is approved.
 * Domains stay out: a scam often quotes a real company's site, and blocking it would hold that company's own messages.
 *
 * The signature is ECDSA P-256 with SHA-256 (DER, base64) over a fixed line-based text built from the file's fields
 * (signedText), so the Kotlin verifier rebuilds the same bytes without canonical JSON. Every Android version the app
 * supports verifies it with the platform's own crypto.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { listEntries } from './watchlist.ts';

export const BLOCKLIST_KEY_FILE = 'blocklist-signing-key.pem';
export const BLOCKLIST_VALIDITY_DAYS = 30;
const NO_TEXT_FINGERPRINT = '0000000000000000';

export interface BlocklistFile {
  version: 1;
  keyId: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  note: string;
  numbers: string[];
  domains: string[];
  fingerprints: string[];
  signature: string;
}

export interface BlocklistKey {
  keyId: string;
  issuer: string;
  /** SubjectPublicKeyInfo, DER, base64: what the app ships in assets/trusted_blocklist_keys.json. */
  publicKey: string;
}

/** The exact bytes that are signed. Both sides build it from the file's own field values, in this order. */
export function signedText(file: Omit<BlocklistFile, 'signature' | 'note'>): string {
  return [
    'mirsad-blocklist-v1',
    `keyId:${file.keyId}`,
    `issuer:${file.issuer}`,
    `issuedAt:${file.issuedAt}`,
    `expiresAt:${file.expiresAt}`,
    `numbers:${file.numbers.join(',')}`,
    `domains:${file.domains.join(',')}`,
    `fingerprints:${file.fingerprints.join(',')}`,
  ].join('\n');
}

export function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** The deployment's signing key, created once under the data directory. Its private half never leaves that file. */
export function loadSigningKey(dataDir: string): KeyObject {
  const file = path.join(dataDir, BLOCKLIST_KEY_FILE);
  if (!fs.existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }
  return createPrivateKey(fs.readFileSync(file));
}

function issuerOf(tx: Tx, workspaceId: string): string {
  const name = tx.get<{ name: string }>('SELECT name FROM workspaces WHERE id=?', [workspaceId])?.name ?? 'Mirsad';
  return `Mirsad portal · ${name}`;
}

export function blocklistKey(tx: Tx, officer: Principal, signingKey: KeyObject): BlocklistKey {
  const publicKey = createPublicKey(signingKey);
  return { keyId: keyIdOf(publicKey), issuer: issuerOf(tx, officer.workspaceId),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** Signs the payload with the deployment key. */
export function signBlocklist(payload: Omit<BlocklistFile, 'signature'>, signingKey: KeyObject): BlocklistFile {
  const signature = sign('sha256', Buffer.from(signedText(payload), 'utf8'), { key: signingKey, dsaEncoding: 'der' }).toString('base64');
  return { ...payload, signature };
}

/** The signed list as the officer may export it now. */
export function buildBlocklist(tx: Tx, officer: Principal, signingKey: KeyObject): BlocklistFile {
  const approved = listEntries(tx, officer).filter(entry => entry.status === 'approved' && entry.number.e164 !== null);
  const numbers = [...new Set(approved.map(entry => entry.number.e164!))].sort();
  const approvedNumbers = new Set(numbers);
  const fingerprints = new Set<string>();
  // A citizen report's message fingerprint, once an officer approved its sender: the same scam from a new number is caught too.
  for (const row of tx.all<{ report: string }>(`SELECT r.report FROM citizen_reports r
      WHERE r.workspace_id=? AND r.demo=0`, [officer.workspaceId])) {
    const report = JSON.parse(row.report) as { fingerprint: string; artifacts: { sender: string | null; senderType: string } };
    const sender = report.artifacts.senderType === 'NUMBER' ? report.artifacts.sender : null;
    if (sender && approvedNumbers.has(sender) && report.fingerprint !== NO_TEXT_FINGERPRINT) fingerprints.add(report.fingerprint);
  }
  const issuedAt = new Date(Date.parse(tx.now()));
  const expiresAt = new Date(issuedAt.getTime() + BLOCKLIST_VALIDITY_DAYS * 86_400_000);
  const key = blocklistKey(tx, officer, signingKey);
  return signBlocklist({
    version: 1,
    keyId: key.keyId,
    issuer: key.issuer,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    note: 'Signed list from the Mirsad portal. Importing it replaces the previous list from this issuer.',
    numbers,
    domains: [],
    fingerprints: [...fingerprints].sort(),
  }, signingKey);
}
