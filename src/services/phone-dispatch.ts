import { chatScopeOf, isChatInScope, isTelegramChatId } from '../adapters/telegram/chat-scope.ts';
import { findLiveBindings } from '../adapters/telegram/live-connector.ts';
import type { Config } from '../config.ts';
import type { DispatchByPhoneResponse } from '../contract/schemas.ts';
import { dispatchOutcome } from '../domain/control-machine.ts';
import { normalizePhone } from '../domain/phone.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import type { ChatRow } from '../storage/rows.ts';
import { canAccessChat } from './access.ts';
import { dispatchChats } from './dispatch.ts';

interface ContactCard { chat_id: string; external_chat_id: string; sender_phone_raw: string; ai_mode: ChatRow['ai_mode'] }

export function dispatchByPhone(tx: Tx, officer: Principal, telegram: Config['telegram'], e164: string,
  officerContext?: string | null, options?: { runtimeAvailable: boolean; recordPermission: boolean }): DispatchByPhoneResponse {
  const bindings = findLiveBindings(tx);
  const binding = bindings[0];
  if (!binding || bindings.length !== 1 || !canAccessChat(tx, officer, {
    workspace_id: binding.account.workspace_id, channel_account_id: binding.account.id,
  })) return { outcome: 'no_verified_chat' };

  const cards = tx.all<ContactCard>(`SELECT c.id AS chat_id, c.external_chat_id, m.sender_phone_raw, c.ai_mode
    FROM telegram_dispatch_contacts d JOIN chats c ON c.id = d.chat_id
    JOIN messages m ON m.id = d.verified_message_id AND m.chat_id = d.chat_id
    WHERE d.connector_id = :connectorId AND c.channel_account_id = :accountId AND c.workspace_id = :workspaceId
      AND m.edited_at_source = 0 AND m.deleted_at_source = 0 AND m.sender_phone_raw IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id = m.id AND e.type = 'conflicting_copy')`,
  { accountId: binding.account.id, workspaceId: officer.workspaceId, connectorId: binding.principal.id });

  const scope = chatScopeOf(telegram);
  const matches = cards.filter(card => isTelegramChatId(card.external_chat_id) && Number(card.external_chat_id) > 0
    && Number(card.external_chat_id) !== binding.ownerUserId && isChatInScope(scope, card.external_chat_id, binding.ownerUserId)
    && normalizePhone(card.sender_phone_raw, { internationalFormat: true }).e164 === e164);
  if (matches.length > 1) return { outcome: 'ambiguous' };
  const match = matches[0];
  if (!match) return { outcome: 'no_verified_chat' };
  const paused = options?.recordPermission && dispatchOutcome(match.ai_mode) === 'requires_resume';
  const dispatch = dispatchChats(tx, officer, [match.chat_id], paused ? undefined : officerContext,
    options && { telegram, runtimeAvailable: options.runtimeAvailable, recordPermission: options.recordPermission && !paused, again: true });
  return { outcome: 'dispatched', chatId: match.chat_id, dispatch };
}
