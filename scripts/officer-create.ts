/** Local operator command. Passwords are read from a hidden prompt or a single line on stdin. */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';
import { loadConfig } from '../src/config.ts';
import { OfficerProvisionError, provisionLiveOfficer, resetLiveOfficerPassword } from '../src/identity/officer-password.ts';
import { DATABASE_FILE, openDatabase } from '../src/storage/db.ts';
import { isEntryPoint, loadDotEnvIfPresent } from './entry-point.ts';

export async function passwordFromPipe(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 514) throw new Error('invalid_password');
    chunks.push(part);
  }
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!password || /[\r\n]/.test(password)) throw new Error('invalid_password');
  return password;
}

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY) return passwordFromPipe(process.stdin);
  const hidden = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input: process.stdin, output: hidden, terminal: true, historySize: 0 });
  const stop = new AbortController();
  prompt.once('SIGINT', () => stop.abort());
  prompt.once('close', () => stop.abort());
  try {
    process.stderr.write('Temporary password (12–128 characters): ');
    const password = await prompt.question('', { signal: stop.signal });
    process.stderr.write('\nConfirm password: ');
    const confirmation = await prompt.question('', { signal: stop.signal });
    if (password !== confirmation) throw new Error('password_mismatch');
    return password;
  } finally {
    prompt.close();
    process.stderr.write('\n');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args[0] === '--reset';
  const [username, ...extra] = reset ? args.slice(1) : args;
  if (!username || extra.length || username.startsWith('-')) {
    process.stderr.write('Usage: npm run officer:create -- [--reset] <username>\n');
    process.exitCode = 2;
    return;
  }
  loadDotEnvIfPresent();
  const file = path.join(loadConfig(process.env).dataDir, DATABASE_FILE);
  if (!fs.existsSync(file)) throw new Error('live_database_missing');
  const password = await promptPassword();
  const db = openDatabase(file);
  try {
    if (reset) await resetLiveOfficerPassword(db, username, password);
    else await provisionLiveOfficer(db, username, password, { temporary: true });
    process.stdout.write('Temporary password set. The officer will choose a new password at sign-in.\n');
  } finally {
    db.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => {
    const inputCodes = ['invalid_password', 'password_mismatch', 'live_database_missing'];
    const code = error instanceof OfficerProvisionError ? error.code
      : error instanceof Error && inputCodes.includes(error.message) ? error.message : 'provision_failed';
    process.stderr.write(`Officer login creation failed (${code}).\n`);
    process.exitCode = 1;
  });
}
