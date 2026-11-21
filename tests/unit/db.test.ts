import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';

let dir: string;
let db: Db | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-db-'));
});
afterEach(() => {
  db?.close();
  db = null;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const file = () => path.join(dir, 'mirsad.sqlite');
const insertWorkspace = (target: Db, id: string) =>
  target.transaction((tx) =>
    tx.run('INSERT INTO workspaces (id, name, created_at) VALUES (:id, :name, :at)', {
      id,
      name: 'Workspace',
      at: tx.now(),
    }),
  );

describe('storage/db', () => {
  it('migration is idempotent and foreign keys are enforced', () => {
    db = openDatabase(file());
    db.close();
    db = openDatabase(file());
    const tables = db.transaction((tx) =>
      tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['workspaces', 'principals', 'chats', 'messages', 'stream_events', 'connector_state']),
    );
    expect(tables).toHaveLength(21);
    expect(() =>
      db!.transaction((tx) =>
        tx.run(
          `INSERT INTO principals (id, workspace_id, kind, display_name, token_sha256, created_at)
           VALUES ('prn_1', 'ws_missing', 'officer', 'Demo Officer 1', 'hash', :at)`,
          { at: tx.now() },
        ),
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('a failed transaction leaves no rows', () => {
    db = openDatabase(file());
    expect(() =>
      db!.transaction((tx) => {
        tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_a', 'A', :at)", { at: tx.now() });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const count = db.transaction((tx) => tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces'));
    expect(count?.n).toBe(0);
  });

  it('a nested transaction joins the outer one and rolls back only its own work', () => {
    db = openDatabase(file());
    const committed: string[] = [];
    db.transaction((tx) => {
      tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_outer', 'A', :at)", { at: tx.now() });
      tx.afterCommit(() => committed.push('outer'));
      expect(() =>
        db!.transaction((inner) => {
          inner.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_inner', 'B', :at)", {
            at: inner.now(),
          });
          inner.afterCommit(() => committed.push('inner'));
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
      expect(committed).toEqual([]);
    });
    const ids = db.transaction((tx) => tx.all<{ id: string }>('SELECT id FROM workspaces'));
    expect(ids.map((r) => r.id)).toEqual(['ws_outer']);
    expect(committed).toEqual(['outer']);
  });

  it('rows survive closing and reopening the file', () => {
    db = openDatabase(file());
    insertWorkspace(db, 'ws_persisted');
    db.close();
    db = openDatabase(file());
    const row = db.transaction((tx) => tx.get<{ id: string }>('SELECT id FROM workspaces'));
    expect(row).toEqual({ id: 'ws_persisted' });
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  it('a transaction whose function returns a promise is refused and rolled back', () => {
    db = openDatabase(file());
    const outer = () =>
      db!.transaction((tx) => {
        tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_async', 'A', :at)", { at: tx.now() });
        return Promise.resolve('done');
      });
    expect(outer).toThrow(/synchronous/);
    db.transaction((tx) => {
      tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_kept', 'B', :at)", { at: tx.now() });
      expect(() =>
        db!.transaction((inner) => {
          inner.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_inner_async', 'C', :at)", {
            at: inner.now(),
          });
          return { then: () => undefined };
        }),
      ).toThrow(/synchronous/);
    });
    const ids = db.transaction((tx) => tx.all<{ id: string }>('SELECT id FROM workspaces ORDER BY id'));
    expect(ids.map((r) => r.id)).toEqual(['ws_kept']);
  });

  it('a throwing after-commit callback neither fails the committed transaction nor skips later callbacks', () => {
    const logs: string[] = [];
    db = openDatabase(file(), { logger: createJsonLogger({ write: (line) => logs.push(line) }) });
    const ran: string[] = [];
    const out = db.transaction((tx) => {
      tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_cb', 'A', :at)", { at: tx.now() });
      tx.afterCommit(() => {
        throw new Error('callback_failed');
      });
      tx.afterCommit(() => ran.push('second'));
      return 'committed';
    });
    expect(out).toBe('committed');
    expect(ran).toEqual(['second']);
    const row = db.transaction((tx) => tx.get<{ id: string }>('SELECT id FROM workspaces'));
    expect(row).toEqual({ id: 'ws_cb' });
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 'error', event: 'after_commit_failed', errorClass: 'Error' }),
    ]);
  });

  it('a transaction opened inside an after-commit callback commits on its own and runs its own callbacks', () => {
    db = openDatabase(file());
    const ran: string[] = [];
    db.transaction((tx) => {
      tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_first', 'A', :at)", { at: tx.now() });
      tx.afterCommit(() => {
        db!.transaction((inner) => {
          inner.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_second', 'B', :at)", {
            at: inner.now(),
          });
          inner.afterCommit(() => ran.push('inner'));
        });
        ran.push('outer');
      });
    });
    expect(ran).toEqual(['inner', 'outer']);
    const ids = db.transaction((tx) => tx.all<{ id: string }>('SELECT id FROM workspaces ORDER BY id'));
    expect(ids.map((r) => r.id)).toEqual(['ws_first', 'ws_second']);
  });

  it('the schema accepts a conflicting_copy event and requires display_value and last_seen_position on case details', () => {
    db = openDatabase(file());
    db.transaction((tx) => {
      const at = tx.now();
      tx.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_s', 'A', :at)", { at });
      tx.run(
        `INSERT INTO principals (id, workspace_id, kind, display_name, token_sha256, created_at)
         VALUES ('prn_s', 'ws_s', 'officer', 'Demo Officer 1', 'hash_s', :at)`,
        { at },
      );
      tx.run(
        `INSERT INTO channel_accounts (id, workspace_id, source, external_account_id, label, created_at)
         VALUES ('acct_s', 'ws_s', 'telegram', 'tg-1', 'Test account', :at)`,
        { at },
      );
      tx.run(
        `INSERT INTO chats (id, workspace_id, channel_account_id, external_chat_id, display_label, created_via, created_by,
           inbox_status, ai_mode, created_at, updated_at)
         VALUES ('chat_s', 'ws_s', 'acct_s', '100', 'Test Contact', 'register', 'prn_s', 'open', 'not_started', :at, :at)`,
        { at },
      );
      tx.run(
        `INSERT INTO messages (id, chat_id, workspace_id, direction, origin, source_message_id, text, received_at,
           capture_method, position)
         VALUES ('msg_s', 'chat_s', 'ws_s', 'incoming', 'source', 'm1', 'Hello', :at, 'fixture_replay', 1)`,
        { at },
      );
      tx.run(
        `INSERT INTO message_events (id, chat_id, message_id, type, source_event_id, text, received_at, capture_method, position)
         VALUES ('mev_s', 'chat_s', 'msg_s', 'conflicting_copy', 'e2', 'Hello again', :at, 'fixture_replay', 2)`,
        { at },
      );
    });
    const insertDetail = (columns: string, values: string) => () =>
      db!.transaction((tx) =>
        tx.run(`INSERT INTO case_details (id, chat_id, category, normalized_value, first_message_id, created_at${columns})
                VALUES ('det_s', 'chat_s', 'payment_link', 'pay.example.test/a', 'msg_s', :at${values})`, { at: tx.now() }),
      );
    expect(insertDetail(', last_seen_position', ', 2')).toThrow(/NOT NULL constraint failed: case_details.display_value/);
    expect(insertDetail(', display_value', ", 'pay.example.test/a'")).toThrow(
      /NOT NULL constraint failed: case_details.last_seen_position/,
    );
    expect(insertDetail(', display_value, last_seen_position', ", 'pay.example.test/a', 2")).not.toThrow();
  });
});
