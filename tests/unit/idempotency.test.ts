import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { withIdempotency } from '../../src/http/middleware/idempotency.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { AppError } from '../../src/contract/errors.ts';
import type { Principal } from '../../src/ports/identity.ts';

let dir: string;
let db: Db;
let officer: Principal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-idem-'));
  db = openDatabase(path.join(dir, 'mirsad.sqlite'));
  officer = db.transaction((tx) => {
    const ws = provisionWorkspace(tx, { name: 'Workspace A' });
    return provisionPrincipal(tx, { workspaceId: ws.id, kind: 'officer', displayName: 'Demo Officer 1' }).principal;
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('withIdempotency', () => {
  it('withIdempotency replays the stored response and rejects a reused key with a different body', () => {
    let effects = 0;
    const effect = () => {
      effects += 1;
      return { status: 201, body: { success: true, data: { n: effects }, error: null } };
    };
    const run = (body: unknown, key = 'key-1') =>
      db.transaction((tx) => withIdempotency(tx, officer, 'POST /v1/dispatches', key, body, effect));

    const first = run({ chatIds: ['chat_1', 'chat_2'] });
    const replay = run({ chatIds: ['chat_1', 'chat_2'] });
    expect(first).toEqual({ status: 201, body: { success: true, data: { n: 1 }, error: null }, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);

    let reused: unknown;
    try {
      run({ chatIds: ['chat_3'] });
    } catch (error) {
      reused = error;
    }
    expect(reused).toBeInstanceOf(AppError);
    expect(reused).toMatchObject({ status: 422, code: 'idempotency_key_reused' });

    const otherKey = run({ chatIds: ['chat_3'] }, 'key-2');
    expect(otherKey.replayed).toBe(false);
    expect(effects).toBe(2);
  });

  it('a failed effect stores nothing, so the key can be used again', () => {
    const failing = () => {
      throw new AppError(404, 'chat_not_found', 'Chat not found.');
    };
    expect(() =>
      db.transaction((tx) => withIdempotency(tx, officer, 'scope', 'key-x', { a: 1 }, failing)),
    ).toThrow(AppError);
    const result = db.transaction((tx) =>
      withIdempotency(tx, officer, 'scope', 'key-x', { a: 1 }, () => ({ status: 200, body: { ok: 1 } })),
    );
    expect(result.replayed).toBe(false);
  });
});
