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

/** An officer flagged the contact as a scammer and the number stays approved on the phone watchlist. */
export function isSuspect(chat) {
  return Boolean(chat.suspect);
}

/** A report a citizen shared from Mirsad Android: there is no conversation, so nothing can dispatch or answer it. */
export function isCitizenReport(chat) {
  return chat.source === 'citizen_report';
}

/** A first-time contact: the contact wrote first and neither Ali nor an officer has acted on the chat yet. A suspect moves out. */
export function isNewMessage(chat) {
  return chat.inboxStatus === 'new_inbound' && !isSuspect(chat) && !isCitizenReport(chat);
}

/** The inbox filters, in the order the officer sees them. */
export const INBOX_FILTERS = ['all', 'new_messages', 'citizen_reports', 'suspects', 'review', 'lower_concern'];

function visibleInFilter(chat, filter) {
  if (filter === 'new_messages') return isNewMessage(chat);
  if (filter === 'citizen_reports') return isCitizenReport(chat) && !isSuspect(chat);
  if (filter === 'suspects') return isSuspect(chat);
  if (filter === 'review') return needsOfficerReview(chat);
  if (filter === 'lower_concern') return Boolean(chat.lowerConcern);
  return true;
}

/**
 * Splits the visible chats into the New messages, Citizen reports and Suspects queues and the open list; each chat is in
 * one. A flagged citizen report is a suspect like any other.
 */
export function groupInbox(chats, filter = 'all') {
  const sorted = chats.filter(chat => visibleInFilter(chat, filter)).sort(byRecentActivity);
  const reported = (chat) => isCitizenReport(chat) && !isSuspect(chat);
  return {
    newInbound: sorted.filter(isNewMessage),
    citizenReports: sorted.filter(reported),
    suspects: sorted.filter(isSuspect),
    open: sorted.filter((chat) => !isNewMessage(chat) && !isSuspect(chat) && !reported(chat)),
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

/** The listed conversations Dispatch can act on; citizen reports and historical test entries have no selection control. */
export function selectableChatIds(chats, filter = 'all') {
  return new Set(chats.filter(chat => visibleInFilter(chat, filter) && !isCitizenReport(chat)).map(chat => chat.id));
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
