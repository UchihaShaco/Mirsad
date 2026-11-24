/**
 * Who holds a conversation and what is waiting on the officer (pure; types in attention.d.ts). Every answer is read from
 * what the service already sends: the AI mode and controller, the Telegram reply hold with its evidence items and the
 * contact's opt-out, and the participant permission reported with an open timeline. No case rule lives here.
 */
import { evidenceItemsFor } from '../format.js';

const LIVE_CAPTURE_METHODS = new Set(['telegram_business_live']);

/**
 * The service reports the chat-level hold separately from its pending warnings and captured items.
 */
export function reviewQueue(hold) {
  return { items: evidenceItemsFor(hold), blocking: hold.officerReview !== null };
}

export function itemHoldsReplies(item, hold) {
  return hold.officerReview !== null && item.reason === 'bank_details';
}

/**
 * The effective control of a chat:
 *   not_started   nobody is replying; the chat was never dispatched
 *   ai_active     the AI holds the chat
 *   ai_waiting    AI active, but participant permission is not on record (known only with an open timeline)
 *   ai_held       AI active, replies held until the officer reviews evidence
 *   ai_opted_out  AI active, but the contact opted out of automated replies
 *   paused        an officer paused the AI
 *   officer_self  the signed-in officer controls the chat
 *   officer_other another officer controls it
 * `permission` is the timeline's telegramAiPermission. The inbox has none, so it never reports ai_waiting.
 */
export function controlState(chat, me, permission) {
  if (chat.aiMode === 'officer_control') {
    return Boolean(me) && chat.controller !== null && chat.controller.id === me.id ? 'officer_self' : 'officer_other';
  }
  if (chat.aiMode === 'paused') return 'paused';
  if (chat.aiMode !== 'ai_active') return 'not_started';
  if (chat.telegramReplyHold.officerReview !== null) return 'ai_held';
  if (chat.telegramReplyHold.contactOptedOut || permission === 'withdrawn') return 'ai_opted_out';
  return permission === 'needed' ? 'ai_waiting' : 'ai_active';
}

/** Whether messages reach Mirsad over a live connection, where Dispatch can lead to a real reply. */
export function isLiveChat(timeline) {
  return timeline.messages.some((message) => LIVE_CAPTURE_METHODS.has(message.source.captureMethod));
}

/**
 * The timeline entry that explains each open evidence item: the edit that carried it when that edit is its own entry,
 * otherwise the original message. Keyed by entry id; each value lists { actionId, reason, blocking } in review order.
 */
export function evidenceSources(timeline) {
  const eventIds = new Set(timeline.messageEvents.map(({ id }) => id));
  const hold = timeline.chat.telegramReplyHold;
  const { items } = reviewQueue(hold);
  const sources = new Map();
  for (const item of items) {
    const entryId = eventIds.has(item.messageEventId) ? item.messageEventId : item.messageId;
    const listed = sources.get(entryId) ?? [];
    listed.push({ actionId: item.actionId, reason: item.reason, blocking: itemHoldsReplies(item, hold) });
    sources.set(entryId, listed);
  }
  return sources;
}
