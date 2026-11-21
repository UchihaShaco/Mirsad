import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../src/storage/db.ts';

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
});
