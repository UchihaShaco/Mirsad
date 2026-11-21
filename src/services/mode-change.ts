/**
 * The steps every control change takes (design section 8, "Every change"): revision + 1, inbox status open,
 * a case action with the operator, a `chat.control_changed` stream event, and review requeue on entering ai_active.
 * Used by dispatch now and by the control service (pause, take over, resume).
 */
import type { AiMode } from '../contract/enums.ts';
import type { CaseAction } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { updateChatMode } from '../storage/repos/chats.ts';
import type { ChatRow } from '../storage/rows.ts';
import { requeueReviewsForChat } from './review-queue.ts';
import { appendStreamEvent } from './stream.ts';

export function applyModeChange(
  tx: Tx,
  chat: ChatRow,
  next: { aiMode: AiMode; controllerId: string | null },
  actor: Principal,
  actionType: CaseAction['type'],
): ChatRow {
  const revision = chat.revision + 1;
  const updated = updateChatMode(tx, chat.id, { aiMode: next.aiMode, controllerId: next.controllerId, revision });
  caseActions.record(tx, {
    chatId: chat.id,
    workspaceId: chat.workspace_id,
    type: actionType,
    actorId: actor.id,
    fromMode: chat.ai_mode,
    toMode: next.aiMode,
    revision,
  });
  appendStreamEvent(tx, {
    workspaceId: chat.workspace_id,
    type: 'chat.control_changed',
    chatId: chat.id,
    data: { aiMode: next.aiMode, revision },
  });
  if (next.aiMode === 'ai_active') requeueReviewsForChat(tx, chat.id);
  return updated;
}
