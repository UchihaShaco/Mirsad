/** Types for inbox.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { ChatSummary } from '../../../contract/schemas.ts';

export type InboxChat = Pick<ChatSummary, 'id' | 'inboxStatus' | 'lastActivityAt' | 'telegramReplyHold' | 'lowerConcern'>;
type InboxFilter = 'all' | 'review' | 'lower_concern';

export interface InboxGroups<T extends InboxChat> {
  newInbound: T[];
  open: T[];
}

export function needsOfficerReview(chat: Pick<ChatSummary, 'telegramReplyHold'>): boolean;
export function groupInbox<T extends InboxChat>(chats: readonly T[], filter?: InboxFilter): InboxGroups<T>;
export function toggleSelection(selection: ReadonlySet<string>, chatId: string, selected: boolean): Set<string>;
export function pruneSelection(selection: ReadonlySet<string>, chats: readonly Pick<ChatSummary, 'id' | 'telegramReplyHold' | 'lowerConcern'>[], filter?: InboxFilter): Set<string>;
export function currentDispatchChatId(state: {
  view: string;
  selectedChatId: string | null;
  timeline: { chat: Pick<ChatSummary, 'id'> } | null;
}, expectedChatId?: string | null): string | null;
export function briefingChatId(state: {
  selection: ReadonlySet<string>;
  chats: readonly Pick<ChatSummary, 'id' | 'source' | 'aiMode'>[];
}): string | null;
