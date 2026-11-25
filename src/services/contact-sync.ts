/**
 * Contact sync (README, "Known Scammer contact on phones"): the contact-sync server holds a number as active while it
 * counts as flagged in any workspace (isFlaggedNumber, the signed blocklist's rule) and inactive once it stops. The
 * portal's own decisions are the outbox: the worker compares them with contact_sync_numbers, what the server was last
 * sent, and claims one number at a time. Nothing is written when a flag is made, so a missed wake loses nothing.
 */
import { CONTACT_SYNC_LABELS } from '../contract/labels.ts';
import type { WatchlistEntry } from '../contract/schemas.ts';
import { normalizePhone } from '../domain/phone.ts';
import type { ContactSyncOutcome } from '../ports/contact-sync.ts';
import type { Tx } from '../storage/db.ts';
import * as repo from '../storage/repos/contact-sync.ts';
import { listEntriesWithE164, listEntriesWithStatus } from '../storage/repos/watchlist.ts';
import { appendStreamEvent } from './stream.ts';
import { isFlaggedNumber } from './watchlist.ts';

export const CONTACT_SYNC_MAX_ATTEMPTS = 5;
const FIRST_RETRY_MS = 2000;
const RETRY_FACTOR = 4;

export interface ContactSyncJob {
  e164: string;
  active: boolean;
  reference: string;
}

export interface FlaggedNumbers {
  /** E.164 number → the ID of the earliest flagged entry with it, sent as the reference. */
  numbers: Map<string, string>;
  /** Approved entries left out because the portal's normaliser confirms no E.164 number for them. */
  skipped: number;
}

/** The number exactly as the portal's normaliser writes it, or null; the server parses it again and must agree. */
export function publishableNumber(e164: string | null): string | null {
  return e164 !== null && normalizePhone(e164).e164 === e164 ? e164 : null;
}

export function flaggedNumbers(tx: Tx): FlaggedNumbers {
  const numbers = new Map<string, string>();
  let skipped = 0;
  for (const entry of listEntriesWithStatus(tx, 'approved')) {
    const e164 = isFlaggedNumber(entry) ? publishableNumber(entry.e164) : null;
    if (e164 === null) skipped += 1;
    else if (!numbers.has(e164)) numbers.set(e164, entry.id);
  }
  return { numbers, skipped };
}

/** Delay before attempt n+1 after attempt n: 2 s, 8 s, 32 s, 128 s. */
export function retryDelayMs(attempts: number): number {
  return FIRST_RETRY_MS * RETRY_FACTOR ** (attempts - 1);
}

/** What the server should hold for each number that needs a request: flagged ones active, formerly sent ones inactive. */
function targets(tx: Tx, rows: readonly repo.ContactSyncRow[]): ContactSyncJob[] {
  const { numbers } = flaggedNumbers(tx);
  const wanted: ContactSyncJob[] = [...numbers].map(([e164, reference]) => ({ e164, active: true, reference }));
  for (const row of rows) if (!numbers.has(row.e164)) wanted.push({ e164: row.e164, active: false, reference: row.reference });
  return wanted;
}

/**
 * The next number whose server state differs from the portal's and may be tried now; the attempt is counted as it is
 * claimed. A changed target (flag, then unflag) starts its own count. Null when everything agrees or waits.
 */
export function claimNextSync(tx: Tx): ContactSyncJob | null {
  const rows = repo.listRows(tx);
  const byNumber = new Map(rows.map((row) => [row.e164, row]));
  const now = tx.now();
  for (const job of targets(tx, rows)) {
    const row = byNumber.get(job.e164);
    const sameTarget = row !== undefined && (row.active === 1) === job.active;
    if (!row && !job.active) continue;
    if (sameTarget && (row.delivered_at !== null || row.attempts >= CONTACT_SYNC_MAX_ATTEMPTS)) continue;
    if (sameTarget && row.next_attempt_at !== null && row.next_attempt_at > now) continue;
    const attempts = sameTarget ? row.attempts + 1 : 1;
    repo.recordAttempt(tx, {
      ...job, attempts, lastErrorCode: sameTarget ? row.last_error_code : null,
      nextAttemptAt: new Date(Date.parse(now) + retryDelayMs(attempts)).toISOString(),
    });
    return job;
  }
  return null;
}

/** Stores the outcome and tells every workspace holding the number that its entry's contact-sync state changed. */
export function recordSyncOutcome(tx: Tx, job: ContactSyncJob, outcome: ContactSyncOutcome): void {
  if (outcome.ok) repo.markDelivered(tx, job.e164);
  else repo.markFailed(tx, job.e164, outcome.code, outcome.retry, CONTACT_SYNC_MAX_ATTEMPTS);
  for (const entry of listEntriesWithE164(tx, job.e164)) {
    appendStreamEvent(tx, {
      workspaceId: entry.workspace_id, type: 'watchlist.entry_updated', watchlistEntryId: entry.id,
      data: { watchlistEntryId: entry.id, status: entry.status, reason: 'contact_sync' },
    });
  }
}

export interface ReconcileCounts {
  flagged: number;
  requeued: number;
  skipped: number;
}

/** At startup, so both sides agree after a restart: the flagged set is sent once more, with fresh retries. */
export function reconcileContactSync(tx: Tx): ReconcileCounts {
  const { numbers, skipped } = flaggedNumbers(tx);
  return { flagged: numbers.size, requeued: repo.requeueForStartup(tx), skipped };
}

export function retryWaitMs(tx: Tx): number | null {
  const at = repo.nextRetryAt(tx, CONTACT_SYNC_MAX_ATTEMPTS);
  return at === null ? null : Math.max(0, Date.parse(at) - Date.parse(tx.now()));
}

function stateOf(entry: WatchlistEntry, row: repo.ContactSyncRow | undefined): WatchlistEntry['contactSync'] {
  if (entry.status !== 'approved') return null;
  if (publishableNumber(entry.number.e164) === null) return { state: 'not_sent', label: CONTACT_SYNC_LABELS.no_international_number };
  if (row?.active === 1 && row.delivered_at !== null) return { state: 'on_phones', label: CONTACT_SYNC_LABELS.on_phones };
  if (row?.active === 1 && row.attempts >= CONTACT_SYNC_MAX_ATTEMPTS && row.last_error_code !== null) {
    return { state: 'not_sent', label: CONTACT_SYNC_LABELS[row.last_error_code as keyof typeof CONTACT_SYNC_LABELS] };
  }
  return { state: 'queued', label: CONTACT_SYNC_LABELS.queued };
}

/** The entries with their contact-sync state; called only when contact sync is on. */
export function withContactSync(tx: Tx, entries: WatchlistEntry[]): WatchlistEntry[] {
  const rows = repo.rowsFor(tx, entries.flatMap((entry) => entry.number.e164 ?? []));
  return entries.map((entry) => ({ ...entry, contactSync: stateOf(entry, entry.number.e164 === null ? undefined : rows.get(entry.number.e164)) }));
}
