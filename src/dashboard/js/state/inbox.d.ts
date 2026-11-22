/** Types for inbox.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { ChatSummary } from '../../../contract/schemas.ts';

export type InboxChat = Pick<ChatSummary, 'id' | 'inboxStatus' | 'lastActivityAt'>;

export interface InboxGroups<T extends InboxChat> {
  newInbound: T[];
  open: T[];
}

export function groupInbox<T extends InboxChat>(chats: readonly T[]): InboxGroups<T>;
export function toggleSelection(selection: ReadonlySet<string>, chatId: string, selected: boolean): Set<string>;
export function pruneSelection(selection: ReadonlySet<string>, chats: readonly Pick<ChatSummary, 'id'>[]): Set<string>;
