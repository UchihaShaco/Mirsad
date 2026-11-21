import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { appendStreamEvent, createStreamBus, type StreamBus } from '../../src/services/stream.ts';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-stream-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function seedWorkspaces(target: Db) {
  target.transaction((tx) => {
    for (const id of ['ws_a', 'ws_b']) {
      tx.run('INSERT INTO workspaces (id, name, created_at) VALUES (:id, :id, :at)', { id, at: tx.now() });
    }
  });
}

function recordingBus(): { bus: StreamBus; notified: string[] } {
  const inner = createStreamBus();
  const notified: string[] = [];
  const bus: StreamBus = {
    notify: (workspaceId) => {
      notified.push(workspaceId);
      inner.notify(workspaceId);
    },
    wait: (workspaceId, signal, timeoutMs) => inner.wait(workspaceId, signal, timeoutMs),
  };
  return { bus, notified };
}

describe('stream append', () => {
  it('appendStreamEvent issues increasing sequences per workspace and pruning raises the floor', () => {
    const { bus, notified } = recordingBus();
    db = openDatabase(path.join(dir, 'mirsad.sqlite'), { streamRetention: 3, streamBus: bus });
    seedWorkspaces(db);

    const seqs = db.transaction((tx) =>
      [1, 2, 3, 4, 5].map(() =>
        appendStreamEvent(tx, {
          workspaceId: 'ws_a',
          type: 'chat.created',
          chatId: 'chat_1',
          data: { inboxStatus: 'new_inbound' },
        }),
      ),
    );
    expect(notified).toEqual(['ws_a']);
    const other = db.transaction((tx) =>
      appendStreamEvent(tx, {
        workspaceId: 'ws_b',
        type: 'watchlist.match',
        watchlistEntryId: 'wle_1',
        data: { watchlistEntryId: 'wle_1' },
      }),
    );

    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(other).toBe(1);
    const ws = db.transaction((tx) =>
      tx.get<{ stream_seq: number; stream_floor: number }>(
        "SELECT stream_seq, stream_floor FROM workspaces WHERE id = 'ws_a'",
      ),
    );
    expect(ws).toEqual({ stream_seq: 5, stream_floor: 2 });
    const rows = db.transaction((tx) =>
      tx.all<{ seq: number; type: string; chat_id: string; data: string }>(
        "SELECT seq, type, chat_id, data FROM stream_events WHERE workspace_id = 'ws_a' ORDER BY seq",
      ),
    );
    expect(rows.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(rows[0]).toMatchObject({ type: 'chat.created', chat_id: 'chat_1' });
    expect(JSON.parse(rows[0]!.data)).toEqual({ inboxStatus: 'new_inbound' });
    expect(notified).toEqual(['ws_a', 'ws_b']);
  });

  it('StreamBus.wait resolves on notify, on timeout and on abort', async () => {
    db = openDatabase(path.join(dir, 'mirsad.sqlite'));
    const bus = createStreamBus();
    const controller = new AbortController();
    const woken = bus.wait('ws_a', controller.signal, 10_000);
    bus.notify('ws_b');
    bus.notify('ws_a');
    await expect(woken).resolves.toBeUndefined();
    await expect(bus.wait('ws_a', controller.signal, 1)).resolves.toBeUndefined();
    const aborted = bus.wait('ws_a', controller.signal, 10_000);
    controller.abort();
    await expect(aborted).resolves.toBeUndefined();
  });
});
