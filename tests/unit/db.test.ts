import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
      expect.arrayContaining(['workspaces', 'principals', 'chats', 'messages', 'stream_events', 'connector_state', 'telegram_evidence_sources', 'officer_passwords', 'officer_sessions', 'dispatch_briefs']),
    );
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(['telegram_dispatch_contacts', 'chat_erasure_fences', 'telegram_message_proofs', 'place_website_checks', 'contact_sync_numbers']));
    expect(tables.map(t => t.name).filter(name => name.startsWith('whatsapp'))).toEqual([]);
    expect(tables).toHaveLength(35);
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

  it('upgrades a populated v1 database and enforces foreign keys on evidence sources', () => {
    const old = new DatabaseSync(file());
    try {
      old.exec(fs.readFileSync(new URL('../../src/storage/schema.sql', import.meta.url), 'utf8'));
      old.exec("INSERT INTO workspaces (id,name,created_at) VALUES ('legacy-workspace','Legacy','2026-01-01'); PRAGMA user_version = 1");
    } finally { old.close(); }
    db = openDatabase(file());
    const snapshot = db.transaction(tx => ({
      workspace: tx.get('SELECT name FROM workspaces WHERE id=?', ['legacy-workspace']),
      version: tx.get('PRAGMA user_version'),
      references: tx.all<{table:string}>('PRAGMA foreign_key_list(telegram_evidence_sources)').map(row => row.table).sort(),
    }));
    expect(snapshot).toEqual({ workspace: { name: 'Legacy' }, version: { user_version: 19 }, references: ['case_actions','chats','messages'] });
    expect(() => db!.transaction(tx => tx.run("INSERT INTO telegram_evidence_sources VALUES ('c','m','document','opaque','a')"))).toThrow(/FOREIGN KEY/);
  });

  it('adds password accounts to a populated v2 database while preserving existing credentials and grants', () => {
    const old = new DatabaseSync(file());
    try {
      old.exec(fs.readFileSync(new URL('../../src/storage/schema.sql', import.meta.url), 'utf8'));
      old.exec(fs.readFileSync(new URL('../../src/storage/telegram-evidence-sources.sql', import.meta.url), 'utf8'));
      old.exec(`INSERT INTO workspaces(id,name,created_at) VALUES('ws','Migrated','2026-01-01');
        INSERT INTO principals(id,workspace_id,kind,display_name,token_sha256,created_at)
        VALUES('officer','ws','officer','Existing','previous-hash','2026-01-01');
        INSERT INTO channel_accounts(id,workspace_id,source,external_account_id,label,created_at)
        VALUES('account','ws','telegram','synthetic','Existing account','2026-01-01');
        INSERT INTO account_grants VALUES('officer','account'); PRAGMA user_version = 2;`);
    } finally { old.close(); }
    db = openDatabase(file());
    db.transaction(tx => {
      expect(tx.get('PRAGMA user_version')).toEqual({ user_version: 19 });
      expect(tx.get('SELECT token_sha256 FROM principals WHERE id=?', ['officer'])).toEqual({ token_sha256: 'previous-hash' });
      expect(tx.get('SELECT channel_account_id FROM account_grants WHERE principal_id=?', ['officer'])).toEqual({ channel_account_id: 'account' });
      expect(tx.all('SELECT * FROM officer_passwords')).toEqual([]);
      expect(tx.all('SELECT * FROM officer_sessions')).toEqual([]);
    });
  });

  it('drops the retired WhatsApp demo tables on upgrade only while they are empty', () => {
    db = openDatabase(file());
    db.close();
    db = null;
    const old = new DatabaseSync(file());
    try {
      old.exec(`CREATE TABLE whatsapp_demo_bindings (phone_number_id TEXT PRIMARY KEY);
        CREATE TABLE whatsapp_reply_attempts (message_id TEXT PRIMARY KEY);
        CREATE TABLE whatsapp_demo_opt_outs (chat_id TEXT PRIMARY KEY);
        INSERT INTO whatsapp_demo_opt_outs VALUES ('kept-because-it-has-a-row');
        PRAGMA user_version = 14;`);
    } finally { old.close(); }
    db = openDatabase(file());
    const remaining = db.transaction(tx => tx.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'whatsapp%' ORDER BY name").map(row => row.name));
    expect(remaining).toEqual(['whatsapp_demo_opt_outs']);
    expect(db.transaction(tx => tx.get('PRAGMA user_version'))).toEqual({ user_version: 19 });
  });

  it('v16 rebuilds the watchlist observations so an officer flag is accepted, keeping every existing row', () => {
    db = openDatabase(file());
    db.close();
    db = null;
    const columns = `id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, message_event_id TEXT NOT NULL, finding_id TEXT, origin TEXT NOT NULL,
      source_representation TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL, UNIQUE (entry_id, message_event_id, origin)`;
    const flag = "INSERT INTO watchlist_observations VALUES ('wob_2','wle_1','ws','chat','msg','mev_2',NULL,'officer_flag','+44 7700 900123','Flagged','2026-11-21T08:01:00.000Z')";
    const old = new DatabaseSync(file());
    try {
      old.exec(`PRAGMA foreign_keys = OFF; DROP TABLE watchlist_observations;
        CREATE TABLE watchlist_observations (${columns.replace("origin TEXT NOT NULL", "origin TEXT NOT NULL CHECK (origin IN ('sender_metadata','message_mention'))")});
        INSERT INTO watchlist_observations VALUES ('wob_1','wle_1','ws','chat','msg','mev_1',NULL,'message_mention','+44 7700 900123',
          'Mentioned with a payment request','2026-11-21T08:00:00.000Z');
        PRAGMA user_version = 15;`);
      expect(() => old.exec(flag)).toThrow(/CHECK/);
    } finally { old.close(); }
    db = openDatabase(file());
    expect(db.transaction(tx => tx.get('PRAGMA user_version'))).toEqual({ user_version: 19 });
    db.close();
    db = null;
    const after = new DatabaseSync(file());
    try {
      after.exec('PRAGMA foreign_keys = OFF');
      after.exec(flag);
      expect(after.prepare('SELECT id, origin FROM watchlist_observations ORDER BY id').all())
        .toEqual([{ id: 'wob_1', origin: 'message_mention' }, { id: 'wob_2', origin: 'officer_flag' }]);
      expect(() => after.exec(flag.replace("'wob_2'", "'wob_3'").replace("'officer_flag'", "'other'"))).toThrow(/CHECK/);
    } finally { after.close(); }
  });

  it('v17 accepts citizen report accounts and observations, keeps every account and refuses a retired source', () => {
    db = openDatabase(file());
    db.close();
    db = null;
    const old = new DatabaseSync(file());
    try {
      old.exec(`PRAGMA foreign_keys = OFF;
        INSERT INTO workspaces (id,name,created_at) VALUES ('ws','W','2026-01-01');
        INSERT INTO channel_accounts (id,workspace_id,source,external_account_id,label,is_intake,created_at)
          VALUES ('acct_tg','ws','telegram','1001','Telegram',1,'2026-01-01');
        PRAGMA user_version = 16;`);
    } finally { old.close(); }
    db = openDatabase(file());
    db.transaction(tx => {
      expect(tx.get('PRAGMA user_version')).toEqual({ user_version: 19 });
      expect(tx.all('SELECT id, source FROM channel_accounts')).toEqual([{ id: 'acct_tg', source: 'telegram' }]);
      tx.run(`INSERT INTO channel_accounts (id,workspace_id,source,external_account_id,label,is_intake,created_at)
        VALUES ('acct_cr','ws','citizen_report','mirsad-android','Citizen reports',0,'2026-01-02')`);
      expect(() => tx.run(`INSERT INTO channel_accounts (id,workspace_id,source,external_account_id,label,is_intake,created_at)
        VALUES ('acct_x','ws','whatsapp','x','x',0,'2026-01-02')`)).toThrow(/CHECK/);
    });
    db.close();
    db = null;
    const retired = new DatabaseSync(file());
    try {
      retired.exec(`PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;
        INSERT INTO channel_accounts (id,workspace_id,source,external_account_id,label,is_intake,created_at)
          VALUES ('acct_wa','ws','whatsapp','wa','WhatsApp',0,'2026-01-03');
        PRAGMA user_version = 16;`);
    } finally { retired.close(); }
    expect(() => openDatabase(file())).toThrow(/remove the whatsapp channel accounts/);
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

  it('runs in WAL mode with synchronous FULL, so a commit is on disk before it returns', () => {
    db = openDatabase(file());
    const settings = db.transaction((tx) => ({
      journalMode: tx.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode,
      synchronous: tx.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous,
    }));
    // 2 is FULL: NORMAL (1) lets a commit return before the WAL is flushed, so a power cut could lose acknowledged rows.
    expect(settings).toEqual({ journalMode: 'wal', synchronous: 2 });
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
