/**
 * Direct database access for assertions the API does not expose yet (stream events before Task 4's stream route,
 * raw rows). Opens a second connection on the harness data directory; WAL lets it run beside the live service.
 */
import path from 'node:path';
import { DATABASE_FILE, openDatabase, type SqlParams } from '../../src/storage/db.ts';

export interface StoredStreamEvent {
  seq: number;
  type: string;
  chatId: string | null;
  data: Record<string, unknown>;
}

function withDb<T>(dataDir: string, fn: (run: { all<R>(sql: string, params?: SqlParams): R[]; exec(sql: string, params?: SqlParams): number }) => T): T {
  const db = openDatabase(path.join(dataDir, DATABASE_FILE));
  try {
    return db.transaction((tx) =>
      fn({ all: (sql, params) => tx.all(sql, params), exec: (sql, params) => tx.run(sql, params).changes }),
    );
  } finally {
    db.close();
  }
}

export function queryRows<R>(dataDir: string, sql: string, params?: SqlParams): R[] {
  return withDb(dataDir, (db) => db.all<R>(sql, params));
}

export function execSql(dataDir: string, sql: string, params?: SqlParams): number {
  return withDb(dataDir, (db) => db.exec(sql, params));
}

export function countRows(dataDir: string, table: string, where = '1 = 1', params?: SqlParams): number {
  return queryRows<{ n: number }>(dataDir, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params)[0]?.n ?? 0;
}

/** Stream events published so far, optionally only those of one chat. */
export function streamEvents(dataDir: string, chatId?: string): StoredStreamEvent[] {
  const rows = queryRows<{ seq: number; type: string; chat_id: string | null; data: string }>(
    dataDir,
    chatId
      ? 'SELECT seq, type, chat_id, data FROM stream_events WHERE chat_id = :chatId ORDER BY seq'
      : 'SELECT seq, type, chat_id, data FROM stream_events ORDER BY seq',
    chatId ? { chatId } : undefined,
  );
  return rows.map((r) => ({ seq: r.seq, type: r.type, chatId: r.chat_id, data: JSON.parse(r.data) as Record<string, unknown> }));
}

/** Row counts of every table intake or dispatch writes, to prove a refused request stored nothing. */
export function storeSnapshot(dataDir: string): Record<string, number> {
  const tables = ['chats', 'messages', 'message_events', 'captures', 'reviews', 'case_actions', 'stream_events', 'idempotency_keys'];
  return Object.fromEntries(tables.map((t) => [t, countRows(dataDir, t)]));
}
