/**
 * Read side of the event stream (design section 12), kept free of sockets so it can be tested directly. Before
 * every read it applies the floor and head checks; it delivers only events the caller may see, and it reports a
 * caller whose principal has been disabled.
 */
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { findChatById } from '../storage/repos/chats.ts';
import { findPrincipalById } from '../storage/repos/principals.ts';
import type { StreamEventRow } from '../storage/rows.ts';
import { canAccessChat } from './access.ts';
import * as watchlist from './watchlist.ts';

export interface StreamBatch {
  /** The events the caller may see, in sequence order. */
  events: StreamEventRow[];
  /** The position after this batch: the last sequence examined (delivered or skipped), or the head after a reset. */
  lastSeq: number;
  /** The position was below the retained floor or above the head: the reader continues from `resumeFrom`. */
  reset?: { resumeFrom: number };
  /** The principal is disabled or gone: the stream must end. */
  disabled?: true;
}

function streamBounds(tx: Tx, workspaceId: string): { head: number; floor: number } {
  const row = tx.get<{ stream_seq: number; stream_floor: number }>(
    'SELECT stream_seq, stream_floor FROM workspaces WHERE id = :workspaceId',
    { workspaceId },
  );
  return { head: row?.stream_seq ?? 0, floor: row?.stream_floor ?? 0 };
}

function isActive(tx: Tx, principalId: string): boolean {
  return findPrincipalById(tx, principalId)?.disabled === 0;
}

/** Delivery rule: chat events need canAccessChat; events carrying only a watchlist entry need canAccessEntry. */
function visibleTo(tx: Tx, principal: Principal): (row: StreamEventRow) => boolean {
  const chatAccess = new Map<string, boolean>();
  const canSeeChat = (chatId: string): boolean => {
    const known = chatAccess.get(chatId);
    if (known !== undefined) return known;
    const chat = findChatById(tx, chatId);
    const allowed = chat !== undefined && canAccessChat(tx, principal, chat);
    chatAccess.set(chatId, allowed);
    return allowed;
  };
  return (row) => {
    if (row.chat_id !== null) return canSeeChat(row.chat_id);
    if (row.watchlist_entry_id !== null) return watchlist.canAccessEntry(tx, principal, row.watchlist_entry_id);
    return false;
  };
}

/**
 * Up to `limit` events after `afterSeq` in the principal's workspace. A position below the retained floor (the
 * events after it were pruned) or above the head (a cursor from another data directory) is a reset to the head,
 * so a reader is told to reload instead of silently skipping events.
 */
export function readStreamBatch(tx: Tx, principal: Principal, afterSeq: number, limit: number): StreamBatch {
  if (!isActive(tx, principal.id)) return { events: [], lastSeq: afterSeq, disabled: true };
  const { head, floor } = streamBounds(tx, principal.workspaceId);
  if (afterSeq < floor || afterSeq > head) return { events: [], lastSeq: head, reset: { resumeFrom: head } };
  const rows = tx.all<StreamEventRow>(
    'SELECT * FROM stream_events WHERE workspace_id = :workspaceId AND seq > :afterSeq ORDER BY seq LIMIT :limit',
    { workspaceId: principal.workspaceId, afterSeq, limit },
  );
  return { events: rows.filter(visibleTo(tx, principal)), lastSeq: rows.at(-1)?.seq ?? afterSeq };
}
