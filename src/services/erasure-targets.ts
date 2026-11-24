import { createHash } from 'node:crypto';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { visibleInboxChatSql } from '../storage/repos/chats.ts';
import { requireChat } from './access.ts';

/** Bind the officer's confirmation to the visible chats, their control revisions and the evidence they contained. */
export function erasureTargets(tx: Tx, officer: Principal, chatId: string | null) {
  if (chatId !== null) requireChat(tx, officer, chatId);
  const rows = tx.all<{ id: string; revision: number; lastEvent: number; lastAction: number; lastFinding: number; lastReference: number; brief: string | null }>(
    `SELECT chats.id, chats.revision,
      COALESCE((SELECT MAX(position) FROM message_events WHERE chat_id=chats.id),0) AS lastEvent,
      COALESCE((SELECT MAX(position) FROM case_actions WHERE chat_id=chats.id),0) AS lastAction,
      COALESCE((SELECT MAX(position) FROM findings WHERE chat_id=chats.id),0) AS lastFinding,
      COALESCE((SELECT MAX(position) FROM case_references WHERE chat_id=chats.id),0) AS lastReference,
      (SELECT context FROM dispatch_briefs WHERE chat_id=chats.id) AS brief
     FROM chats JOIN account_grants g ON g.channel_account_id=chats.channel_account_id
     WHERE chats.workspace_id=:workspace AND g.principal_id=:officer AND
       ((:chatId IS NOT NULL AND chats.id=:chatId) OR (:chatId IS NULL AND
         (${visibleInboxChatSql} OR EXISTS (SELECT 1 FROM messages WHERE chat_id=chats.id)
          OR EXISTS (SELECT 1 FROM case_references WHERE chat_id=chats.id)
          OR EXISTS (SELECT 1 FROM dispatch_briefs WHERE chat_id=chats.id))))
     ORDER BY chats.id`, { workspace: officer.workspaceId, officer: officer.id, chatId });
  const snapshot = createHash('sha256').update(JSON.stringify([officer.id, chatId, rows])).digest('hex');
  return { targets: rows.map(({ id, revision }) => ({ id, revision })), snapshot };
}
