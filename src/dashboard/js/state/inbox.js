/** Inbox grouping and the multi-select for Dispatch (pure; types in inbox.d.ts). Inputs are never changed. */

const compareIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Most recent activity first; ISO-8601 UTC timestamps of one format compare as strings. */
function byRecentActivity(a, b) {
  if (a.lastActivityAt === b.lastActivityAt) return compareIds(a, b);
  return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
}

/** Splits chats into the New inbound queue (inbox status new_inbound) and the open list. */
export function groupInbox(chats) {
  const sorted = [...chats].sort(byRecentActivity);
  return {
    newInbound: sorted.filter((chat) => chat.inboxStatus === 'new_inbound'),
    open: sorted.filter((chat) => chat.inboxStatus !== 'new_inbound'),
  };
}

export function toggleSelection(selection, chatId, selected) {
  const next = new Set(selection);
  if (selected) next.add(chatId);
  else next.delete(chatId);
  return next;
}

/** Keeps only selected chats that are still listed. */
export function pruneSelection(selection, chats) {
  const listed = new Set(chats.map((chat) => chat.id));
  return new Set([...selection].filter((chatId) => listed.has(chatId)));
}
