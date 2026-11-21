/**
 * Append side of the event stream (design section 12). appendStreamEvent runs inside the caller's
 * transaction; the bus only wakes readers after commit, the database stays the source of truth.
 */
import type { Tx } from '../storage/db.ts';
import type { StoredStreamEventType, StreamEventDataMap } from '../contract/stream-events.ts';

export interface AppendStreamEventInput<T extends StoredStreamEventType> {
  workspaceId: string;
  type: T;
  chatId?: string | null;
  watchlistEntryId?: string | null;
  data: StreamEventDataMap[T];
}

export interface StreamBus {
  notify(workspaceId: string): void;
  /** Resolves on the next notify for the workspace, after timeoutMs, or when the signal aborts. */
  wait(workspaceId: string, signal: AbortSignal, timeoutMs: number): Promise<void>;
}

/** Issues the workspace's next sequence number, stores the event and prunes beyond retention. */
export function appendStreamEvent<T extends StoredStreamEventType>(tx: Tx, input: AppendStreamEventInput<T>): number {
  const ws = tx.get<{ stream_seq: number; stream_floor: number }>(
    'UPDATE workspaces SET stream_seq = stream_seq + 1 WHERE id = :id RETURNING stream_seq, stream_floor',
    { id: input.workspaceId },
  );
  if (!ws) throw new Error('stream_workspace_not_found');
  const seq = ws.stream_seq;
  tx.run(
    `INSERT INTO stream_events (workspace_id, seq, type, chat_id, watchlist_entry_id, data, occurred_at)
     VALUES (:workspaceId, :seq, :type, :chatId, :watchlistEntryId, :data, :occurredAt)`,
    {
      workspaceId: input.workspaceId,
      seq,
      type: input.type,
      chatId: input.chatId ?? null,
      watchlistEntryId: input.watchlistEntryId ?? null,
      data: JSON.stringify(input.data),
      occurredAt: tx.now(),
    },
  );
  const newFloor = seq - tx.streamRetention;
  if (newFloor > ws.stream_floor) {
    tx.run('DELETE FROM stream_events WHERE workspace_id = :id AND seq <= :floor', {
      id: input.workspaceId,
      floor: newFloor,
    });
    tx.run('UPDATE workspaces SET stream_floor = :floor WHERE id = :id', { id: input.workspaceId, floor: newFloor });
  }
  const notifier = tx.streamNotifier;
  if (notifier) tx.afterCommit(() => notifier.notify(input.workspaceId), `stream:${input.workspaceId}`);
  return seq;
}

export function createStreamBus(): StreamBus {
  const waiters = new Map<string, Set<() => void>>();

  return {
    notify(workspaceId) {
      const set = waiters.get(workspaceId);
      if (!set) return;
      waiters.delete(workspaceId);
      for (const wake of set) wake();
    },
    wait(workspaceId, signal, timeoutMs) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          waiters.get(workspaceId)?.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        signal.addEventListener('abort', finish, { once: true });
        let set = waiters.get(workspaceId);
        if (!set) {
          set = new Set();
          waiters.set(workspaceId, set);
        }
        set.add(finish);
      });
    },
  };
}
