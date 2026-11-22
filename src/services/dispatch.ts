/**
 * Batch dispatch (design section 8): access to the whole selection is checked before any chat changes, then the
 * dispatch column of the control machine is applied to each chat in the caller's transaction. A chat that is already
 * AI active keeps its mode and revision, but its reviews that were never run or failed are queued again, as on resume.
 */
import { AppError } from '../contract/errors.ts';
import type { DispatchResponse } from '../contract/schemas.ts';
import { dispatchOutcome } from '../domain/control-machine.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { newId } from '../storage/ids.ts';
import { findChatById } from '../storage/repos/chats.ts';
import type { ChatRow } from '../storage/rows.ts';
import { canAccessChat } from './access.ts';
import { applyModeChange } from './mode-change.ts';
import { requeueReviewsForChat } from './review-queue.ts';

export type DispatchResult = DispatchResponse;

function resolveSelection(tx: Tx, officer: Principal, chatIds: readonly string[]): ChatRow[] {
  const found = chatIds.map((id) => {
    const chat = findChatById(tx, id);
    return chat && canAccessChat(tx, officer, chat) ? chat : null;
  });
  const missing = chatIds.filter((_, i) => found[i] === null);
  if (missing.length > 0) {
    throw AppError.of('chat_not_found', 'One or more chats were not found.', { chatIds: missing });
  }
  return found as ChatRow[];
}

/** The route wakes the review worker after the transaction commits. */
export function dispatchChats(tx: Tx, officer: Principal, chatIds: readonly string[]): DispatchResult {
  const chats = resolveSelection(tx, officer, chatIds);
  const results = chats.map((chat) => {
    const status = dispatchOutcome(chat.ai_mode);
    const after = status === 'started'
      ? applyModeChange(tx, chat, { aiMode: 'ai_active', controllerId: null }, officer, 'dispatch_started')
      : chat;
    if (status === 'already_active') requeueReviewsForChat(tx, chat.id);
    return { chatId: chat.id, status, aiMode: after.ai_mode, revision: after.revision };
  });
  return { dispatchId: newId('dsp'), results };
}
