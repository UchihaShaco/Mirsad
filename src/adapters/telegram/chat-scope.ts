/**
 * Telegram intake scope (design section 13). The live connector checks each update before storage.
 * The account's runtime reply switch and the contact's enrollment are checked separately by the worker.
 *
 * - `approved` (the default): only the chats on TELEGRAM_APPROVED_CHAT_IDS.
 * - `all_private`: every private chat of the connected account, by the owner's recorded decision, except the owner's
 *   own chat.
 *
 * In both, the chats on TELEGRAM_EXCLUDED_CHAT_IDS and Telegram's own service chat (login codes, account notices) are
 * never in scope.
 */
import type { Config } from '../../config.ts';

/** Telegram's service notifications chat, which carries login codes. */
export const TELEGRAM_SERVICE_CHAT_ID = '777000';
/** Match the exact decimal form used as the key after parsing an incoming numeric chat ID. */
export function isTelegramChatId(id: string): boolean {
  const number = Number(id);
  return Number.isSafeInteger(number) && number !== 0 && String(number) === id;
}

export type ChatScope =
  | { readonly mode: 'approved'; readonly chatIds: ReadonlySet<string>; readonly excluded: ReadonlySet<string> }
  | { readonly mode: 'all_private'; readonly excluded: ReadonlySet<string> };

type ScopeSettings = Pick<Config['telegram'], 'chatScope' | 'approvedChatIds' | 'excludedChatIds'>;

/** Contacts whose reply consent was recorded before enrollment through the portal's all-DM switch. */
export function approvedReplyChatIds(telegram: Pick<ScopeSettings, 'approvedChatIds' | 'excludedChatIds'>): string[] {
  if (!telegram.approvedChatIds.every(isTelegramChatId)) return [];
  const excluded = new Set([TELEGRAM_SERVICE_CHAT_ID, ...telegram.excludedChatIds]);
  return [...new Set(telegram.approvedChatIds)].filter((id) => Number(id) > 0 && !excluded.has(id));
}

export function chatScopeOf(telegram: ScopeSettings): ChatScope {
  const excluded = new Set(telegram.excludedChatIds);
  return telegram.chatScope === 'all_private'
    ? { mode: 'all_private', excluded }
    : { mode: 'approved', chatIds: new Set(telegram.approvedChatIds), excluded };
}

/** Whether intake covers this chat. `ownerUserId` is the connected account's Telegram user ID. */
export function isChatInScope(scope: ChatScope, chatId: string, ownerUserId: number): boolean {
  if (scope.excluded.has(chatId) || chatId === TELEGRAM_SERVICE_CHAT_ID) return false;
  if (scope.mode === 'approved') return scope.chatIds.has(chatId);
  return isTelegramChatId(chatId) && Number(chatId) > 0 && chatId !== String(ownerUserId);
}
