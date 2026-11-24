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
import { recordDispatchPermission } from './telegram-dispatch-permission.ts';
import { liveChatOf, replyTarget, requestTelegramReply, type TelegramDispatch } from './telegram-reply-requests.ts';

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

/** The officer's context is stored separately from conversation evidence and from the case log. */
export function readDispatchBrief(tx: Tx, chatId: string): string | null {
  return tx.get<{ context: string }>('SELECT context FROM dispatch_briefs WHERE chat_id = ?', [chatId])?.context ?? null;
}

function setDispatchBrief(tx: Tx, officer: Principal, chat: ChatRow, context: string | null): void {
  if (dispatchOutcome(chat.ai_mode) === 'requires_resume') {
    throw AppError.of('invalid_transition', 'Resume AI before dispatching this chat with an officer briefing.');
  }
  if (context === null) {
    tx.run('DELETE FROM dispatch_briefs WHERE chat_id = ?', [chat.id]);
    return;
  }
  tx.run(`INSERT INTO dispatch_briefs (chat_id, context, recorded_by, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            context = excluded.context, recorded_by = excluded.recorded_by, updated_at = excluded.updated_at`,
    [chat.id, context, officer.id, tx.now()]);
}

/** The route wakes the review and reply workers after the transaction commits. */
export function dispatchChats(tx: Tx, officer: Principal, chatIds: readonly string[], officerContext?: string | null,
  options?: TelegramDispatch & { recordPermission?: boolean; expectedTestMode?: boolean }): DispatchResult {
  const chats = resolveSelection(tx, officer, chatIds);
  if (options?.recordPermission && officer.kind !== 'officer') {
    throw AppError.of('validation_failed', 'Only an officer may confirm participant permission.');
  }
  if (options?.replyToMessageId && chats.length !== 1) {
    throw AppError.of('validation_failed', 'A specific reply target requires one chat.');
  }
  if (officerContext !== undefined) {
    const [chat] = chats;
    if (!chat || chats.length !== 1) throw AppError.of('validation_failed', 'Select one chat for an officer briefing.');
    setDispatchBrief(tx, officer, chat, officerContext);
  }
  const dispatchId = newId('dsp');
  const selectedApproval = officer.kind === 'officer' && options?.again && options.recordPermission;
  const results = chats.map((chat) => {
    const live = options && liveChatOf(tx, chat, options.telegram);
    const target = options && live && (options.recordPermission || options.replyToMessageId)
      ? replyTarget(tx, chat, live, Date.parse(tx.now()), {
        allowMedia: officer.kind === 'officer' && options.again, selectOutsideEnrollment: selectedApproval ? true : undefined,
      }) : undefined;
    if (options?.replyToMessageId && (typeof target !== 'object' || target.id !== options.replyToMessageId ||
      (options.replyToHeadPosition !== undefined && target.confirmationPosition !== options.replyToHeadPosition))) {
      throw AppError.of('revision_conflict', 'The conversation changed. Review the latest message before dispatching again.', { reason: 'target_changed' });
    }
    if (options?.recordPermission) {
      const legacySingle = chats.length === 1 && !options.again;
      if (live) {
        // A selection outside enrollment belongs only to this request. The standing grant still starts here.
        const grantTarget = typeof target === 'object' && !target.selectedSourceId ? target : undefined;
        recordDispatchPermission(tx, officer, chat, live, options, dispatchId, grantTarget, legacySingle);
      } else if (legacySingle) {
        throw AppError.of('invalid_transition', 'Select a private chat in the linked Telegram account’s intake scope.');
      }
    }
    const status = dispatchOutcome(chat.ai_mode);
    const after = status === 'started'
      ? applyModeChange(tx, chat, { aiMode: 'ai_active', controllerId: null }, officer, 'dispatch_started')
      : chat;
    if (status === 'already_active') requeueReviewsForChat(tx, chat.id);
    const telegram = live && options ? requestTelegramReply(tx, officer, after, live, options, selectedApproval ? dispatchId : undefined) : undefined;
    return { chatId: chat.id, status, aiMode: after.ai_mode, revision: after.revision, ...(telegram && { telegram }) };
  });
  return { dispatchId, results };
}
