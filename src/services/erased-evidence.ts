import type { EvidenceStore } from '../ports/evidence-store.ts';
import type { Db } from '../storage/db.ts';

// A reset may commit while the renderer is writing its PNG. Wait for the last write before unlinking it.
const writes = new WeakMap<EvidenceStore, Map<string, Promise<unknown>>>();

export function trackEvidenceWrite<T>(store: EvidenceStore, key: string, write: Promise<T>): Promise<T> {
  let active = writes.get(store);
  if (!active) {
    active = new Map();
    writes.set(store, active);
  }
  active.set(key, write);
  return write.finally(() => { if (active.get(key) === write) active.delete(key); });
}

/** The queue is committed with row erasure. Failed unlinks can be retried after restart or on receipt replay. */
export async function flushErasedEvidence(db: Db, store: EvidenceStore, chatIds?: ReadonlySet<string>): Promise<number> {
  const rows = db.transaction(tx => tx.all<{ storage_key: string; chat_id: string }>(
    'SELECT storage_key, chat_id FROM erased_evidence_files',
  ));
  let pending = 0;
  for (const { storage_key: key, chat_id: id } of rows) {
    if (chatIds && !chatIds.has(id)) continue;
    try {
      await writes.get(store)?.get(key)?.catch(() => undefined);
      await store.remove(key);
      db.transaction(tx => tx.run('DELETE FROM erased_evidence_files WHERE storage_key=?', [key]));
    } catch {
      pending++;
    }
  }
  return pending;
}
