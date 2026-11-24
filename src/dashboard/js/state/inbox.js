/** Inbox grouping and the multi-select for Dispatch (pure; types in inbox.d.ts). Inputs are never changed. */
import { evidenceItemsFor, reviewWarningLabel } from '../format.js';

const compareIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The Dispatch API accepts at most this many chats in a single request. */
export const DISPATCH_LIMIT = 100;

/** Manual Dispatch confirms each selected Telegram participant's existing permission. */
export function telegramDispatchRequest(target) {
  const request = { participantPermissionRecorded: true, replyAgain: true };
  return target ? { ...request, replyToMessageId: target.messageId, replyToHeadPosition: target.headPosition } : request;
}

/** Most recent activity first; ISO-8601 UTC timestamps of one format compare as strings. */
function byRecentActivity(a, b) {
  if (a.lastActivityAt === b.lastActivityAt) return compareIds(a, b);
  return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
}

/** The review filter also includes unacknowledged warnings while automatic replies continue. */
export function needsOfficerReview(chat) {
  const hold = chat.telegramReplyHold;
  return hold.officerReview !== null || evidenceItemsFor(hold).some(item => reviewWarningLabel(item.reason));
}

/** A first-time contact: the contact wrote first and neither Ali nor an officer has acted on the chat yet. */
export function isNewMessage(chat) {
  return chat.inboxStatus === 'new_inbound';
}

/** The inbox filters, in the order the officer sees them. */
export const INBOX_FILTERS = ['all', 'new_messages', 'review', 'lower_concern'];

function visibleInFilter(chat, filter) {
  if (filter === 'new_messages') return isNewMessage(chat);
  if (filter === 'review') return needsOfficerReview(chat);
  if (filter === 'lower_concern') return Boolean(chat.lowerConcern);
  return true;
}

/** Splits the visible chats into the New messages queue and the open list. */
export function groupInbox(chats, filter = 'all') {
  const sorted = chats.filter(chat => visibleInFilter(chat, filter)).sort(byRecentActivity);
  return {
    newInbound: sorted.filter(isNewMessage),
    open: sorted.filter((chat) => !isNewMessage(chat)),
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
  const listed = selectableChatIds(chats, filter);
  return new Set([...selection].filter((chatId) => listed.has(chatId)));
}

/** The current listed conversations; historical test entries are separate links without selection controls. */
export function selectableChatIds(chats, filter = 'all') {
  return new Set(chats.filter(chat => visibleInFilter(chat, filter)).map(chat => chat.id));
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
