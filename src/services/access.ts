/**
 * The single access rule (design section 3): same workspace AND a grant on the chat's channel account.
 * An inaccessible chat is reported exactly like a missing one.
 */
import { AppError } from '../contract/errors.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { hasGrant } from '../storage/repos/principals.ts';
import type { ChatRow } from '../storage/rows.ts';

export function canAccessChat(
  tx: Tx,
  principal: Principal,
  chat: Pick<ChatRow, 'workspace_id' | 'channel_account_id'>,
): boolean {
  return chat.workspace_id === principal.workspaceId && hasGrant(tx, principal.id, chat.channel_account_id);
}

export function requireChat(tx: Tx, principal: Principal, chatId: string): ChatRow {
  const chat = tx.get<ChatRow>('SELECT * FROM chats WHERE id = :id', { id: chatId });
  if (!chat || !canAccessChat(tx, principal, chat)) {
    throw AppError.of('chat_not_found', 'Chat not found.');
  }
  return chat;
}
