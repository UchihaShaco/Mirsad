// Stub until Task 7: hooks are no-ops and no chat has matches. Signatures are final.
import type { ChatWatchlistMatch } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import type { ChatRow, FindingRow, MessageEventRow, MessageRow } from '../storage/rows.ts';

export interface PhoneInput {
  raw: string;
  country?: string;
  internationalFormat?: boolean;
}

export interface FindingContext {
  chat: ChatRow;
  message: MessageRow;
  messageEvent: MessageEventRow;
}

/** Called by intake when a chat's contact phone first becomes known from sender metadata. */
export function onContactPhoneKnown(_tx: Tx, _chat: ChatRow, _phone: PhoneInput): void {}

/** Called by review publishing with the findings it just inserted. */
export function onFindingsPublished(_tx: Tx, _ctx: FindingContext, _findings: readonly FindingRow[]): void {}

/** Watchlist matches per chat ID, filtered to evidence the principal may open. */
export function matchesForChats(_tx: Tx, _principal: Principal, _chatIds: readonly string[]): Map<string, ChatWatchlistMatch[]> {
  return new Map();
}
