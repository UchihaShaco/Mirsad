/** What the contact-sync server was last sent for each number, and the retries left for it (contact_sync_numbers). */
import type { Tx } from '../db.ts';

export interface ContactSyncRow {
  e164: string;
  active: 0 | 1;
  reference: string;
  delivered_at: string | null;
  attempts: number;
  last_error_code: string | null;
  next_attempt_at: string | null;
  updated_at: string;
}

export function listRows(tx: Tx): ContactSyncRow[] {
  return tx.all<ContactSyncRow>('SELECT * FROM contact_sync_numbers ORDER BY updated_at, e164');
}

export function rowsFor(tx: Tx, e164s: readonly string[]): Map<string, ContactSyncRow> {
  const rows = tx.all<ContactSyncRow>('SELECT * FROM contact_sync_numbers WHERE e164 IN (SELECT value FROM json_each(?))', [JSON.stringify(e164s)]);
  return new Map(rows.map((row) => [row.e164, row]));
}

export interface ClaimInput {
  e164: string;
  active: boolean;
  reference: string;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string;
}

/** Records an attempt about to be made: the target state, not yet delivered, and when the next try may follow. */
export function recordAttempt(tx: Tx, input: ClaimInput): void {
  tx.run(`INSERT INTO contact_sync_numbers (e164, active, reference, delivered_at, attempts, last_error_code, next_attempt_at, updated_at)
      VALUES (:e164, :active, :reference, NULL, :attempts, :lastErrorCode, :nextAttemptAt, :at)
    ON CONFLICT(e164) DO UPDATE SET active = excluded.active, reference = excluded.reference, delivered_at = NULL,
      attempts = excluded.attempts, last_error_code = excluded.last_error_code, next_attempt_at = excluded.next_attempt_at,
      updated_at = excluded.updated_at`, { ...input, at: tx.now() });
}

export function markDelivered(tx: Tx, e164: string): void {
  tx.run(`UPDATE contact_sync_numbers SET delivered_at = :at, last_error_code = NULL, next_attempt_at = NULL, updated_at = :at
    WHERE e164 = :e164`, { e164, at: tx.now() });
}

/** A failed attempt; with no retry left the number waits for a new decision or the next start. */
export function markFailed(tx: Tx, e164: string, code: string, attemptsLeft: boolean, maxAttempts: number): void {
  tx.run(`UPDATE contact_sync_numbers SET last_error_code = :code, updated_at = :at,
      attempts = CASE WHEN :attemptsLeft THEN attempts ELSE :maxAttempts END WHERE e164 = :e164`,
  { e164, code, attemptsLeft, maxAttempts, at: tx.now() });
}

/** At startup: every active number is sent once more, and every undelivered one gets its retries back. Returns how many. */
export function requeueForStartup(tx: Tx): number {
  return tx.run(`UPDATE contact_sync_numbers SET delivered_at = NULL, attempts = 0, last_error_code = NULL, next_attempt_at = NULL,
    updated_at = :at WHERE active = 1 OR delivered_at IS NULL`, { at: tx.now() }).changes;
}

/** The earliest time a waiting retry may run, or null when none waits. */
export function nextRetryAt(tx: Tx, maxAttempts: number): string | null {
  return tx.get<{ at: string | null }>(`SELECT min(next_attempt_at) AS at FROM contact_sync_numbers
    WHERE delivered_at IS NULL AND attempts < :maxAttempts`, { maxAttempts })?.at ?? null;
}
