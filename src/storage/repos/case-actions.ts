/** The internal case log. Recording an action also publishes `case_action.recorded` (design section 12). */
import type { AiMode, CaseActionType } from '../../contract/enums.ts';
import { appendStreamEvent } from '../../services/stream.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { CaseActionRow } from '../rows.ts';

/** Detail values are IDs and codes only, never message text. */
export type CaseActionDetail = Record<string, string | number | boolean | null>;

export interface RecordCaseActionInput {
  chatId: string;
  workspaceId: string;
  type: CaseActionType;
  actorId: string | null;
  messageId?: string | null;
  fromMode?: AiMode | null;
  toMode?: AiMode | null;
  revision?: number | null;
  detail?: CaseActionDetail | null;
}

export function record(tx: Tx, input: RecordCaseActionInput): CaseActionRow {
  const id = newId('act');
  const position = appendStreamEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'case_action.recorded',
    chatId: input.chatId,
    data: { caseActionId: id, actionType: input.type },
  });
  const row = tx.get<CaseActionRow>(
    `INSERT INTO case_actions (id, chat_id, workspace_id, type, actor_id, message_id, from_mode, to_mode, revision, detail,
       occurred_at, position)
     VALUES (:id, :chatId, :workspaceId, :type, :actorId, :messageId, :fromMode, :toMode, :revision, :detail, :at, :position)
     RETURNING *`,
    {
      id,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      type: input.type,
      actorId: input.actorId,
      messageId: input.messageId ?? null,
      fromMode: input.fromMode ?? null,
      toMode: input.toMode ?? null,
      revision: input.revision ?? null,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      at: tx.now(),
      position,
    },
  );
  if (!row) throw new Error('case_action_insert_failed');
  return row;
}

export function listCaseActionsForChat(tx: Tx, chatId: string): CaseActionRow[] {
  return tx.all<CaseActionRow>('SELECT * FROM case_actions WHERE chat_id = :chatId ORDER BY position, id', { chatId });
}
