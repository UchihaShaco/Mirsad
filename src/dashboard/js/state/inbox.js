/** Inbox grouping and the multi-select for Dispatch (pure; types in inbox.d.ts). Inputs are never changed. */

const compareIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Most recent activity first; ISO-8601 UTC timestamps of one format compare as strings. */
function byRecentActivity(a, b) {
  if (a.lastActivityAt === b.lastActivityAt) return compareIds(a, b);
  return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
}

/** A single captured item can be informational. The service exposes officerReview when a decision is actionable. */
export function needsOfficerReview(chat) {
  return chat.telegramReplyHold.officerReview !== null;
}

function visibleInFilter(chat, filter) {
  if (filter === 'review') return needsOfficerReview(chat);
  if (filter === 'lower_concern') return Boolean(chat.lowerConcern);
  return true;
}

/** Splits the visible chats into the New inbound queue and the open list. */
export function groupInbox(chats, filter = 'all') {
  const sorted = chats.filter(chat => visibleInFilter(chat, filter)).sort(byRecentActivity);
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

/** A resolved review must leave the visible batch selection when the queue refreshes. */
export function pruneSelection(selection, chats, filter = 'all') {
  const listed = new Set(chats.filter(chat => visibleInFilter(chat, filter)).map((chat) => chat.id));
  return new Set([...selection].filter((chatId) => listed.has(chatId)));
}

/** Resolve a conversation action against both the route and loaded timeline, even with unrelated batch selections. */
export function currentDispatchChatId(state, expectedChatId = state.selectedChatId) {
  const loadedId = state.timeline?.chat.id;
  return state.view === 'inbox' && loadedId && loadedId === state.selectedChatId && loadedId === expectedChatId ? loadedId : null;
}

/** A briefing belongs to one Telegram chat that can start or continue under AI control. */
export function briefingChatId(state) {
  if (state.selection.size !== 1) return null;
  const [chatId] = state.selection;
  const chat = state.chats.find(({ id }) => id === chatId);
  return chat?.source === 'telegram' && (chat.aiMode === 'not_started' || chat.aiMode === 'ai_active') ? chatId : null;
}
