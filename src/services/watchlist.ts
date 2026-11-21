// Stub until Task 7: hooks are no-ops, no chat has matches and no entry is accessible. Signatures are final
// (design section 11).
import type { ChatSummary } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import type { PhoneMention } from '../ports/reviewer.ts';
import type { Tx } from '../storage/db.ts';
import type { ChatRow, MessageEventRow, MessageRow } from '../storage/rows.ts';

export interface PhoneInput {
  raw: string;
  country?: string;
  internationalFormat?: boolean;
}

/** The exact source reference a watchlist observation points at. */
export interface EvidenceContext {
  chat: ChatRow;
  message: MessageRow;
  messageEvent: MessageEventRow;
}

export interface PublishedEvidence {
  phoneMentions: PhoneMention[];
  suspectedFraudFindingIds: string[];
}

export type ChatWatchlistMatches = ChatSummary['watchlistMatches'];

/** Called by intake the first time an incoming message supplies the sender's phone. */
export function onContactPhoneKnown(_tx: Tx, _ctx: EvidenceContext, _phone: PhoneInput): void {}

/** Called by review publishing and case references with the phone mentions and fraud findings they produced. */
export function onEvidencePublished(_tx: Tx, _ctx: EvidenceContext, _evidence: PublishedEvidence): void {}

/** Watchlist matches keyed by chat ID, filtered to evidence the principal may open; chats without matches have no key. */
export function matchesForChats(_tx: Tx, _principal: Principal, _chatIds: string[]): Map<string, ChatWatchlistMatches> {
  return new Map();
}

/** Whether the principal may see the entry (decides who receives watchlist entry stream events). */
export function canAccessEntry(_tx: Tx, _principal: Principal, _entryId: string): boolean {
  return false;
}
