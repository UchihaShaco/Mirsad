/**
 * Per-chat control (design section 8): pause, take over and resume through the control machine and the same
 * applyModeChange helper dispatch uses, so every change bumps the revision and records operator and time.
 */
import type { CaseActionType, ControlAction } from '../contract/enums.ts';
import { AppError } from '../contract/errors.ts';
import type { ChatSummary } from '../contract/schemas.ts';
import { transition } from '../domain/control-machine.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import type { ChatRow } from '../storage/rows.ts';
import { requireChat } from './access.ts';
import { summaryOf } from './chats.ts';
import { refuseCitizenReport } from './citizen-reports.ts';
import { applyModeChange } from './mode-change.ts';

const CASE_ACTION_FOR: Record<ControlAction, CaseActionType> = {
  pause: 'control_pause',
  take_over: 'control_take_over',
  resume: 'control_resume',
};

export interface ControlResult {
  chat: ChatSummary;
  changedAt: string;
}

/** The optimistic-concurrency check: `expectedRevision` must equal the chat's current revision. */
export function assertRevision(chat: Pick<ChatRow, 'revision' | 'ai_mode'>, expectedRevision: number): void {
  if (chat.revision !== expectedRevision) {
    throw AppError.of('revision_conflict', 'The chat has changed since it was read; reload it and try again.', {
      currentRevision: chat.revision,
      aiMode: chat.ai_mode,
    });
  }
}

/**
 * The revision is checked first, as a precondition on the state the caller saw; then the control machine
 * decides (409 invalid_transition, or 403 not_controller for a resume by another officer).
 */
export function applyControl(
  tx: Tx,
  officer: Principal,
  chatId: string,
  action: ControlAction,
  expectedRevision: number,
): ControlResult {
  const chat = requireChat(tx, officer, chatId);
  refuseCitizenReport(tx, chat);
  assertRevision(chat, expectedRevision);
  const next = transition({ aiMode: chat.ai_mode, controllerId: chat.controller_id }, action, officer.id);
  if (!next.ok) {
    throw new AppError(next.status, next.code, 'This control action is not allowed in the chat\'s current state.');
  }
  const updated = applyModeChange(tx, chat, { aiMode: next.aiMode, controllerId: next.controllerId }, officer, CASE_ACTION_FOR[action]);
  return { chat: summaryOf(tx, officer, updated), changedAt: updated.updated_at };
}
