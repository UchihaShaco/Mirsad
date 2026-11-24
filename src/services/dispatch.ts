/**
 * Batch dispatch (design section 8): access to the whole selection is checked before any chat changes, then the
 * dispatch column of the control machine is applied to each chat in the caller's transaction. A chat that is already
 * AI active keeps its mode and revision, but its reviews that were never run or failed are queued again, as on resume.
 */
import { AppError } from '../contract/errors.ts';
import type { Config } from '../config.ts';
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
  permission?: { telegram: Config['telegram']; expectedTestMode: boolean; runtimeAvailable: boolean }): DispatchResult {
  const chats = resolveSelection(tx, officer, chatIds);
  if (permission) {
    const [chat] = chats;
    if (officer.kind !== 'officer' || !chat || chats.length !== 1) {
      throw AppError.of('validation_failed', 'An officer must select a single Telegram chat to record permission.');
    }
    recordDispatchPermission(tx, officer, chat, permission.telegram, permission.expectedTestMode, permission.runtimeAvailable);
  }
  if (officerContext !== undefined) {
    const [chat] = chats;
    if (!chat || chats.length !== 1) throw AppError.of('validation_failed', 'Select one chat for an officer briefing.');
    setDispatchBrief(tx, officer, chat, officerContext);
  }
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
