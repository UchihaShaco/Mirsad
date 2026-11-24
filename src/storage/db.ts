/**
 * SQLite through the built-in node:sqlite (design sections 4 and 19.2). Every write runs inside
 * Db.transaction: BEGIN IMMEDIATE outermost, SAVEPOINT when nested. Transaction bodies are synchronous.
 */
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createJsonLogger } from '../logging/json-logger.ts';
import { systemClock, type Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';

export const DATABASE_FILE = 'mirsad.sqlite';
const SCHEMA_VERSION = 10;
const BUSY_TIMEOUT_MS = 5000;
const DEFAULT_STREAM_RETENTION = 5000;

export type SqlValue = string | number | bigint | null | Uint8Array | boolean | undefined;
export type SqlParams = Record<string, SqlValue> | readonly SqlValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Wakes stream readers after a commit that appended stream events. */
export interface StreamNotifier {
  notify(workspaceId: string): void;
}

export interface Tx {
  run(sql: string, params?: SqlParams): RunResult;
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  /** The injected clock's current time as an ISO-8601 UTC string with milliseconds. */
  now(): string;
  /**
   * Runs after the outermost transaction commits; dropped when the work it belongs to rolls back.
   * Callbacks registered with the same key run once per commit.
   */
  afterCommit(callback: () => void, key?: string): void;
  readonly streamRetention: number;
  readonly streamNotifier: StreamNotifier | null;
}

export interface Db {
  transaction<T>(fn: (tx: Tx) => T): T;
  /** After committed erasures, truncate the WAL when current readers permit it. */
  checkpointAfterErasure?(): boolean;
  close(): void;
}

export interface OpenDatabaseOptions {
  clock?: Clock;
  streamRetention?: number;
  streamBus?: StreamNotifier;
  /** Receives after-commit callback failures; defaults to a JSON logger on stdout. */
  logger?: Logger;
}

const SCHEMA_SQL = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const EVIDENCE_SOURCES_SQL = fs.readFileSync(new URL('./telegram-evidence-sources.sql', import.meta.url), 'utf8');
const OFFICER_PASSWORDS_SQL = fs.readFileSync(new URL('./officer-passwords.sql', import.meta.url), 'utf8');

type Bindable = string | number | bigint | null | Uint8Array;

function bindValue(value: SqlValue): Bindable {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function bind(params: SqlParams | undefined): { named?: Record<string, Bindable>; positional: Bindable[] } {
  if (params === undefined) return { positional: [] };
  if (Array.isArray(params)) return { positional: (params as readonly SqlValue[]).map(bindValue) };
  const named: Record<string, Bindable> = {};
  for (const [key, val] of Object.entries(params)) named[key] = bindValue(val);
  return { named, positional: [] };
}

function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

function migrate(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version');
  if (Number(version.get()?.user_version) >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = Number(version.get()?.user_version);
    if (current === 0) db.exec(SCHEMA_SQL);
    if (current < 2) db.exec(EVIDENCE_SOURCES_SQL);
    if (current < 3) db.exec(OFFICER_PASSWORDS_SQL);
    if (current < 4) db.exec(`
      CREATE INDEX IF NOT EXISTS messages_chat_position ON messages(chat_id, position);
      CREATE INDEX IF NOT EXISTS message_edits_by_source ON message_events(message_id, position)
        WHERE type='edited' AND text IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chat_source_changes ON message_events(chat_id, position)
        WHERE type IN ('edited','deleted','conflicting_copy');
    `);
    if (current < 5) db.exec(`
      ALTER TABLE officer_passwords ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
        CHECK(must_change_password IN (0, 1));
    `);
    if (current < 6) db.exec(`
      CREATE TABLE dispatch_briefs (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        context TEXT NOT NULL,
        recorded_by TEXT NOT NULL REFERENCES principals(id),
        updated_at TEXT NOT NULL
      );
    `);
    if (current < 7) db.exec(`
      CREATE TABLE telegram_dispatch_contacts (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL REFERENCES principals(id),
        telegram_message_id INTEGER NOT NULL,
        verified_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
      );
    `);
    if (current < 8) db.exec(`
      CREATE TABLE chat_erasure_fences (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id),
        cutoff_second INTEGER NOT NULL, telegram_id INTEGER NOT NULL, hidden INTEGER NOT NULL CHECK(hidden IN (0,1))
      );
      CREATE TABLE erased_source_keys (
        chat_id TEXT NOT NULL REFERENCES chats(id), digest TEXT NOT NULL, PRIMARY KEY(chat_id,digest)
      );
      CREATE TABLE erased_evidence_files (
        storage_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id)
      );
      CREATE TABLE telegram_pending_sends (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id), trigger_id TEXT NOT NULL, expires_at TEXT NOT NULL
      );
    `);
    if (current < 9) db.exec(`
      CREATE TABLE telegram_message_proofs (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL REFERENCES principals(id), connection_hash TEXT NOT NULL,
        chat_number INTEGER NOT NULL, message_number INTEGER NOT NULL, sent_second INTEGER NOT NULL,
        own_send INTEGER NOT NULL, content_kind TEXT NOT NULL,
        removal TEXT CHECK(removal IN ('uncertain','removed','failed'))
      );
    `);
    if (current < 10) db.exec(`
      CREATE TABLE telegram_dispatch_permissions (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id), connector_id TEXT NOT NULL REFERENCES principals(id),
        policy_key TEXT NOT NULL, cutoff_position INTEGER NOT NULL, cutoff_second INTEGER NOT NULL,
        cutoff_telegram_id INTEGER NOT NULL, trigger_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        catchup_id TEXT REFERENCES messages(id) ON DELETE SET NULL, catchup_until INTEGER,
        suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1))
      );
      CREATE INDEX message_events_message_type_connector ON message_events(message_id,type,connector_id);
    `);
    if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

interface PendingCallback {
  callback: () => void;
  key: string | undefined;
}

/** Callbacks queued during a transaction; `mark`/`rollbackTo` scope them to savepoints. */
class CommitQueue {
  private pending: PendingCallback[] = [];

  add(callback: () => void, key: string | undefined): void {
    if (key !== undefined && this.pending.some((p) => p.key === key)) return;
    this.pending.push({ callback, key });
  }

  mark(): number {
    return this.pending.length;
  }

  rollbackTo(mark: number): void {
    this.pending = this.pending.slice(0, mark);
  }

  take(): PendingCallback[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }
}

function createTx(db: DatabaseSync, options: OpenDatabaseOptions, queue: CommitQueue): Tx {
  const clock = options.clock ?? systemClock;
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };
  return {
    run(sql, params) {
      const { named, positional } = bind(params);
      const out = named ? prepare(sql).run(named, ...positional) : prepare(sql).run(...positional);
      return { changes: Number(out.changes), lastInsertRowid: Number(out.lastInsertRowid) };
    },
    get<T>(sql: string, params?: SqlParams) {
      const { named, positional } = bind(params);
      const row = named ? prepare(sql).get(named, ...positional) : prepare(sql).get(...positional);
      return row === undefined ? undefined : plain<T>(row);
    },
    all<T>(sql: string, params?: SqlParams) {
      const { named, positional } = bind(params);
      const rows = named ? prepare(sql).all(named, ...positional) : prepare(sql).all(...positional);
      return rows.map((row) => plain<T>(row));
    },
    now: () => clock.now().toISOString(),
    afterCommit: (callback, key) => queue.add(callback, key),
    streamRetention: options.streamRetention ?? DEFAULT_STREAM_RETENTION,
    streamNotifier: options.streamBus ?? null,
  };
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Runs fn and refuses a thenable result: transaction bodies must be synchronous (design section 19.2). */
function runSync<T>(fn: (t: Tx) => T, tx: Tx): T {
  const out = fn(tx);
  if (isThenable(out)) throw new Error('transaction_function_must_be_synchronous');
  return out;
}

function runAfterCommit(callbacks: PendingCallback[], logger: Logger): void {
  for (const pending of callbacks) {
    try {
      pending.callback();
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : typeof error;
      logger.error('after_commit_failed', { errorClass, key: pending.key ?? null });
    }
  }
}

function createTransactionRunner(db: DatabaseSync, tx: Tx, queue: CommitQueue, logger: Logger): Db['transaction'] {
  let depth = 0;
  let savepointSeq = 0;
  const nested = <T>(fn: (t: Tx) => T): T => {
    const name = `sp_${++savepointSeq}`;
    const mark = queue.mark();
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = runSync(fn, tx);
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      queue.rollbackTo(mark);
      throw error;
    }
  };
  /** Commits and hands back the queued callbacks; the caller runs them once depth is back to 0. */
  const outermost = <T>(fn: (t: Tx) => T): { out: T; callbacks: PendingCallback[] } => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = runSync(fn, tx);
      db.exec('COMMIT');
      return { out, callbacks: queue.take() };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      queue.take();
      throw error;
    }
  };
  return (fn) => {
    if (depth > 0) {
      depth += 1;
      try {
        return nested(fn);
      } finally {
        depth -= 1;
      }
    }
    depth += 1;
    let committed: { out: ReturnType<typeof fn>; callbacks: PendingCallback[] };
    try {
      committed = outermost(fn);
    } finally {
      depth -= 1;
    }
    runAfterCommit(committed.callbacks, logger);
    return committed.out;
  };
}

export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Db {
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
  // FULL: a commit returns only once it is on disk, so evidence acknowledged with 201 survives a power cut (design 19.2).
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  migrate(db);
  const queue = new CommitQueue();
  const tx = createTx(db, options, queue);
  return {
    transaction: createTransactionRunner(db, tx, queue, options.logger ?? createJsonLogger({ clock: options.clock })),
    checkpointAfterErasure: () => db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy === 0,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
