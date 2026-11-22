/** The phone watchlist tables (design sections 4 and 11): entries, observations, officer decisions and inbox matches. */
import type { ObservationOrigin, WatchlistDecision, WatchlistStatus } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';

type Flag = 0 | 1;

export interface WatchlistEntryRow {
  id: string;
  workspace_id: string;
  match_key: string;
  e164: string | null;
  display: string;
  status: WatchlistStatus;
  revision: number;
  new_evidence_since_review: Flag;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

/** An observation with the channel account of its chat, which decides who may open it. */
export interface WatchlistObservationRow {
  id: string;
  entry_id: string;
  workspace_id: string;
  chat_id: string;
  message_id: string;
  message_event_id: string;
  finding_id: string | null;
  origin: ObservationOrigin;
  source_representation: string;
  reason: string;
  observed_at: string;
  channel_account_id: string;
}

/** A match with the channel account of its chat. */
export interface WatchlistMatchRow {
  id: string;
  workspace_id: string;
  entry_id: string;
  chat_id: string;
  matched_e164: string;
  source_representation: string;
  matched_at: string;
  channel_account_id: string;
}

/** A decision with the display name of the officer who made it. */
export interface WatchlistReviewRow {
  id: string;
  entry_id: string;
  decision: WatchlistDecision;
  reason: string;
  officer_id: string;
  officer_display_name: string;
  from_status: WatchlistStatus;
  to_status: WatchlistStatus;
  revision: number;
  decided_at: string;
}

/** Binds a list of IDs as one JSON parameter, so every statement keeps a fixed text. */
const IN_IDS = 'SELECT value FROM json_each(:ids)';
const idsParam = (ids: readonly string[]): { ids: string } => ({ ids: JSON.stringify(ids) });

export function findEntryById(tx: Tx, entryId: string): WatchlistEntryRow | undefined {
  return tx.get<WatchlistEntryRow>('SELECT * FROM watchlist_entries WHERE id = :entryId', { entryId });
}

export function findEntryByKey(tx: Tx, workspaceId: string, matchKey: string): WatchlistEntryRow | undefined {
  return tx.get<WatchlistEntryRow>(
    'SELECT * FROM watchlist_entries WHERE workspace_id = :workspaceId AND match_key = :matchKey',
    { workspaceId, matchKey },
  );
}

/** The workspace's entries, most recently seen first. */
export function listWorkspaceEntries(tx: Tx, workspaceId: string): WatchlistEntryRow[] {
  return tx.all<WatchlistEntryRow>(
    'SELECT * FROM watchlist_entries WHERE workspace_id = :workspaceId ORDER BY last_seen_at DESC, rowid DESC',
    { workspaceId },
  );
}

export function listEntriesByIds(tx: Tx, entryIds: readonly string[]): WatchlistEntryRow[] {
  return tx.all<WatchlistEntryRow>(`SELECT * FROM watchlist_entries WHERE id IN (${IN_IDS})`, idsParam(entryIds));
}

export interface InsertEntryInput {
  workspaceId: string;
  matchKey: string;
  e164: string | null;
  display: string;
  seenAt: string;
}

/** A new entry: Needs review, first and last seen when its first observation was. */
export function insertEntry(tx: Tx, input: InsertEntryInput): WatchlistEntryRow {
  const row = tx.get<WatchlistEntryRow>(
    `INSERT INTO watchlist_entries (id, workspace_id, match_key, e164, display, status, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (:id, :workspaceId, :matchKey, :e164, :display, 'needs_review', :seenAt, :seenAt, :at, :at)
     RETURNING *`,
    { id: newId('wle'), ...input, at: tx.now() },
  );
  if (!row) throw new Error('watchlist_entry_insert_failed');
  return row;
}

export interface InsertObservationInput {
  entryId: string;
  workspaceId: string;
  chatId: string;
  messageId: string;
  messageEventId: string;
  findingId: string | null;
  origin: ObservationOrigin;
  sourceRepresentation: string;
  reason: string;
  observedAt: string;
}

/** Inserts the observation; false, writing nothing, when the entry already has one for this message event and origin. */
export function insertObservation(tx: Tx, input: InsertObservationInput): boolean {
  const { changes } = tx.run(
    `INSERT INTO watchlist_observations (id, entry_id, workspace_id, chat_id, message_id, message_event_id, finding_id, origin,
       source_representation, reason, observed_at)
     VALUES (:id, :entryId, :workspaceId, :chatId, :messageId, :messageEventId, :findingId, :origin,
       :sourceRepresentation, :reason, :observedAt)
     ON CONFLICT (entry_id, message_event_id, origin) DO NOTHING`,
    { id: newId('wob'), ...input },
  );
  return changes > 0;
}

/**
 * A new observation's effect on its entry: first and last seen widen to include its time, whatever order observations
 * arrive in, and an entry an officer has decided on (approved or cleared) is flagged as having new evidence. The status
 * itself never changes here.
 */
export function markObserved(tx: Tx, entryId: string, seenAt: string): WatchlistEntryRow {
  const row = tx.get<WatchlistEntryRow>(
    `UPDATE watchlist_entries
     SET first_seen_at = MIN(first_seen_at, :seenAt), last_seen_at = MAX(last_seen_at, :seenAt),
       new_evidence_since_review = CASE WHEN status IN ('approved', 'cleared') THEN 1 ELSE new_evidence_since_review END,
       updated_at = :at
     WHERE id = :entryId RETURNING *`,
    { entryId, seenAt, at: tx.now() },
  );
  if (!row) throw new Error('watchlist_entry_update_failed');
  return row;
}

/** Observations of the given entries, oldest first. */
export function listObservations(tx: Tx, entryIds: readonly string[]): WatchlistObservationRow[] {
  return tx.all<WatchlistObservationRow>(
    `SELECT o.*, c.channel_account_id FROM watchlist_observations o JOIN chats c ON c.id = o.chat_id
     WHERE o.entry_id IN (${IN_IDS}) ORDER BY o.observed_at, o.rowid`,
    idsParam(entryIds),
  );
}

export interface InsertMatchInput {
  workspaceId: string;
  entryId: string;
  chatId: string;
  matchedE164: string;
  sourceRepresentation: string;
}

export function insertMatch(tx: Tx, input: InsertMatchInput): void {
  tx.run(
    `INSERT INTO watchlist_matches (id, workspace_id, entry_id, chat_id, matched_e164, source_representation, matched_at)
     VALUES (:id, :workspaceId, :entryId, :chatId, :matchedE164, :sourceRepresentation, :at)`,
    { id: newId('wmt'), ...input, at: tx.now() },
  );
}

const MATCH_SELECT = 'SELECT m.*, c.channel_account_id FROM watchlist_matches m JOIN chats c ON c.id = m.chat_id';

export function listMatchesOfEntries(tx: Tx, entryIds: readonly string[]): WatchlistMatchRow[] {
  return tx.all<WatchlistMatchRow>(`${MATCH_SELECT} WHERE m.entry_id IN (${IN_IDS}) ORDER BY m.matched_at, m.rowid`, idsParam(entryIds));
}

export function listMatchesInChats(tx: Tx, chatIds: readonly string[]): WatchlistMatchRow[] {
  return tx.all<WatchlistMatchRow>(`${MATCH_SELECT} WHERE m.chat_id IN (${IN_IDS}) ORDER BY m.matched_at, m.rowid`, idsParam(chatIds));
}

export interface InsertReviewInput {
  entryId: string;
  decision: WatchlistDecision;
  reason: string;
  officerId: string;
  fromStatus: WatchlistStatus;
  toStatus: WatchlistStatus;
  revision: number;
}

export function insertReview(tx: Tx, input: InsertReviewInput): void {
  tx.run(
    `INSERT INTO watchlist_reviews (id, entry_id, decision, reason, officer_id, from_status, to_status, revision, decided_at)
     VALUES (:id, :entryId, :decision, :reason, :officerId, :fromStatus, :toStatus, :revision, :at)`,
    { id: newId('wrv'), ...input, at: tx.now() },
  );
}

/** The latest decision on each of the given entries that has one. */
export function latestReviews(tx: Tx, entryIds: readonly string[]): Map<string, WatchlistReviewRow> {
  const rows = tx.all<WatchlistReviewRow>(
    `SELECT r.*, p.display_name AS officer_display_name FROM watchlist_reviews r JOIN principals p ON p.id = r.officer_id
     WHERE r.entry_id IN (${IN_IDS}) ORDER BY r.revision`,
    idsParam(entryIds),
  );
  return new Map(rows.map((row) => [row.entry_id, row]));
}

/** Writes a decision's outcome: the new status and revision; the officer has now seen the evidence, so the flag clears. */
export function updateEntryStatus(tx: Tx, entryId: string, status: WatchlistStatus, revision: number): WatchlistEntryRow {
  const row = tx.get<WatchlistEntryRow>(
    `UPDATE watchlist_entries SET status = :status, revision = :revision, new_evidence_since_review = 0, updated_at = :at
     WHERE id = :entryId RETURNING *`,
    { entryId, status, revision, at: tx.now() },
  );
  if (!row) throw new Error('watchlist_entry_update_failed');
  return row;
}
