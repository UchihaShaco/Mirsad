/** Types for inbox.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { ChatSummary, DispatchRequest, TelegramReplies } from '../../../contract/schemas.ts';

export type InboxChat = Pick<ChatSummary, 'id' | 'inboxStatus' | 'lastActivityAt' | 'telegramReplyHold' | 'lowerConcern' | 'suspect'>;
export type InboxFilter = 'all' | 'new_messages' | 'suspects' | 'review' | 'lower_concern';
type SelectableChat = Pick<ChatSummary, 'id' | 'inboxStatus' | 'telegramReplyHold' | 'lowerConcern' | 'suspect'>;

export const INBOX_FILTERS: readonly InboxFilter[];
export function isSuspect(chat: Pick<ChatSummary, 'suspect'>): boolean;
export function isNewMessage(chat: Pick<ChatSummary, 'inboxStatus' | 'suspect'>): boolean;

export const DISPATCH_LIMIT: 100;
export function telegramDispatchRequest(target?: TelegramReplies['target']): Pick<DispatchRequest,
  'participantPermissionRecorded' | 'replyAgain' | 'replyToMessageId' | 'replyToHeadPosition'>;

export interface InboxGroups<T extends InboxChat> {
  newInbound: T[];
  suspects: T[];
  open: T[];
}

export function needsOfficerReview(chat: Pick<ChatSummary, 'telegramReplyHold'>): boolean;
export function groupInbox<T extends InboxChat>(chats: readonly T[], filter?: InboxFilter): InboxGroups<T>;
export function toggleSelection(selection: ReadonlySet<string>, chatId: string, selected: boolean): Set<string>;
export function pruneSelection(selection: ReadonlySet<string>, chats: readonly SelectableChat[], filter?: InboxFilter): Set<string>;
export function selectableChatIds(chats: readonly SelectableChat[], filter?: InboxFilter): Set<string>;
export function currentDispatchChatId(state: {
  view: string;
  selectedChatId: string | null;
  timeline: { chat: Pick<ChatSummary, 'id'> } | null;
}, expectedChatId?: string | null): string | null;
export function briefingChatId(state: {
  selection: ReadonlySet<string>;
  chats: readonly Pick<ChatSummary, 'id' | 'source' | 'aiMode'>[];
}): string | null;
