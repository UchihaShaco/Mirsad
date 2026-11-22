/**
 * The phone watchlist (design section 11): one per workspace. Review evidence and sender metadata add observations to
 * entries keyed by E.164 (or by an unnormalized per-chat key), officers approve, clear or reopen entries, and an approved
 * entry matches a new inbound chat whose sender's number is the same E.164 number.
 */
import type { Concern, ObservationOrigin, WatchlistDecision, WatchlistStatus } from '../contract/enums.ts';
import { AppError } from '../contract/errors.ts';
import { WATCHLIST_STATUS_LABELS } from '../contract/labels.ts';
import type { ChatSummary, EvidenceRef, WatchlistEntry, WatchlistReviewRequest } from '../contract/schemas.ts';
import { normalizePhone, watchlistMatchKey } from '../domain/phone.ts';
import type { Principal } from '../ports/identity.ts';
import type { PhoneMention } from '../ports/reviewer.ts';
import type { Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { setContactPhoneE164 } from '../storage/repos/chats.ts';
import * as repo from '../storage/repos/watchlist.ts';
import type { ChatRow, MessageEventRow, MessageRow } from '../storage/rows.ts';
import { canAccessChat } from './access.ts';
import { appendStreamEvent } from './stream.ts';

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

const MENTION_REASONS: Record<Concern, string> = {
  payment_request: 'Mentioned with a payment request',
  callback_request: 'Mentioned with a call-back request',
  credential_request: 'Mentioned with a credential request',
  other_concern: 'Mentioned with another concern',
};
const SENDER_OF_INBOUND_CHAT = 'Sender of an inbound chat';
const SENDER_OF_SUSPECTED_FRAUD = 'Sender of a message with a Suspected fraud finding';

/** Design section 11: approve from Needs review; clear from Needs review or Approved; reopen from Approved or Cleared. */
const TRANSITIONS: Record<WatchlistDecision, { from: readonly WatchlistStatus[]; to: WatchlistStatus }> = {
  approve: { from: ['needs_review'], to: 'approved' },
  clear: { from: ['needs_review', 'approved'], to: 'cleared' },
  reopen: { from: ['approved', 'cleared'], to: 'needs_review' },
};

type EntryUpdateReason = 'created' | 'observation_added' | 'reviewed';
type ChatAccess = (chat: { workspace_id: string; channel_account_id: string }) => boolean;

interface Observation {
  origin: ObservationOrigin;
  findingId: string | null;
  sourceRepresentation: string;
  reason: string;
}

interface NumberKey {
  matchKey: string;
  e164: string | null;
}

/** What one principal may see of one entry. */
interface EntryView {
  canAccess: boolean;
  evidence: repo.WatchlistObservationRow[];
  restrictedEvidence: boolean;
  matches: repo.WatchlistMatchRow[];
  canReview: boolean;
}

/** Event data carries the entry ID, status and reason code only: never the number. */
function publishEntryUpdated(tx: Tx, entry: repo.WatchlistEntryRow, reason: EntryUpdateReason): void {
  appendStreamEvent(tx, {
    workspaceId: entry.workspace_id,
    type: 'watchlist.entry_updated',
    watchlistEntryId: entry.id,
    data: { watchlistEntryId: entry.id, status: entry.status, reason },
  });
}

/** Inserts the observation at the evidence's exact source reference, or gives a sighting its finding; false on repeat delivery. */
function addObservation(tx: Tx, ctx: EvidenceContext, entry: repo.WatchlistEntryRow, observation: Observation): boolean {
  return repo.insertObservation(tx, {
    entryId: entry.id,
    workspaceId: ctx.chat.workspace_id,
    chatId: ctx.chat.id,
    messageId: ctx.message.id,
    messageEventId: ctx.messageEvent.id,
    ...observation,
    observedAt: ctx.messageEvent.received_at,
  });
}

/**
 * Appends an observation to an existing entry and moves its seen times (flagging a decided entry); a sighting that gains
 * a Suspected fraud finding is new evidence in the same way. Repeat delivery changes nothing.
 */
function appendObservation(tx: Tx, ctx: EvidenceContext, entry: repo.WatchlistEntryRow, observation: Observation): void {
  if (!addObservation(tx, ctx, entry, observation)) return;
  publishEntryUpdated(tx, repo.markObserved(tx, entry.id, ctx.messageEvent.received_at), 'observation_added');
}

/** Appends the observation to the entry for the number, creating that entry (Needs review) when the number is new. */
function recordObservation(tx: Tx, ctx: EvidenceContext, number: NumberKey, observation: Observation): void {
  const existing = repo.findEntryByKey(tx, ctx.chat.workspace_id, number.matchKey);
  if (existing) {
    appendObservation(tx, ctx, existing, observation);
    return;
  }
  const entry = repo.insertEntry(tx, {
    workspaceId: ctx.chat.workspace_id,
    matchKey: number.matchKey,
    e164: number.e164,
    display: observation.sourceRepresentation,
    seenAt: ctx.messageEvent.received_at,
  });
  addObservation(tx, ctx, entry, observation);
  publishEntryUpdated(tx, entry, 'created');
}

function recordMatch(tx: Tx, ctx: EvidenceContext, entry: repo.WatchlistEntryRow, e164: string, sourceRepresentation: string): void {
  const workspaceId = ctx.chat.workspace_id;
  repo.insertMatch(tx, { workspaceId, entryId: entry.id, chatId: ctx.chat.id, matchedE164: e164, sourceRepresentation });
  caseActions.record(tx, {
    chatId: ctx.chat.id, workspaceId, type: 'watchlist_match', actorId: null, messageId: ctx.message.id, detail: { watchlistEntryId: entry.id },
  });
  appendStreamEvent(tx, { workspaceId, type: 'watchlist.match', chatId: ctx.chat.id, watchlistEntryId: entry.id, data: { watchlistEntryId: entry.id } });
}

/** Called by intake the first time an incoming message supplies the sender's phone. */
export function onContactPhoneKnown(tx: Tx, ctx: EvidenceContext, phone: PhoneInput): void {
  const { e164 } = normalizePhone(phone.raw, { country: phone.country, internationalFormat: phone.internationalFormat });
  if (e164 === null) return;
  setContactPhoneE164(tx, ctx.chat.id, e164);
  const entry = repo.findEntryByKey(tx, ctx.chat.workspace_id, e164);
  if (!entry) return;
  appendObservation(tx, ctx, entry, { origin: 'sender_metadata', findingId: null, sourceRepresentation: phone.raw, reason: SENDER_OF_INBOUND_CHAT });
  if (entry.status === 'approved') recordMatch(tx, ctx, entry, e164, phone.raw);
}

/** The chat's stored sender number: its E.164 form when intake could normalize it, else the chat's unnormalized key. */
function senderNumberOf(chat: ChatRow): (NumberKey & { raw: string }) | null {
  if (chat.contact_phone_raw === null) return null;
  const { digits } = normalizePhone(chat.contact_phone_raw);
  const e164 = chat.contact_phone_e164;
  return { matchKey: watchlistMatchKey({ e164, digits }, chat.id), e164, raw: chat.contact_phone_raw };
}

/**
 * Called by review publishing and case references with the phone mentions and fraud findings they produced. A mention
 * stays a mention: it is never linked to the sender. A Suspected fraud finding links the sender's own number, which the
 * source supplied as sender metadata, when the chat has one.
 */
export function onEvidencePublished(tx: Tx, ctx: EvidenceContext, evidence: PublishedEvidence): void {
  for (const mention of evidence.phoneMentions) {
    recordObservation(tx, ctx, { matchKey: watchlistMatchKey(mention, ctx.chat.id), e164: mention.e164 }, {
      origin: 'message_mention',
      findingId: mention.findingId,
      sourceRepresentation: mention.sourceRepresentation,
      reason: MENTION_REASONS[mention.concern],
    });
  }
  const sender = senderNumberOf(ctx.chat);
  if (!sender) return;
  for (const findingId of evidence.suspectedFraudFindingIds) {
    recordObservation(tx, ctx, sender, { origin: 'sender_metadata', findingId, sourceRepresentation: sender.raw, reason: SENDER_OF_SUSPECTED_FRAUD });
  }
}

function groupByEntry<T extends { entry_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.entry_id, [...(groups.get(row.entry_id) ?? []), row]);
  return groups;
}

/** canAccessChat for one principal, asked once per channel account. */
function chatAccessFor(tx: Tx, principal: Principal): ChatAccess {
  const known = new Map<string, boolean>();
  return (chat) => {
    const key = `${chat.workspace_id}\u0000${chat.channel_account_id}`;
    let allowed = known.get(key);
    if (allowed === undefined) {
      allowed = canAccessChat(tx, principal, chat);
      known.set(key, allowed);
    }
    return allowed;
  };
}

/**
 * A sighting records that a number already on the watchlist reappeared as a chat's sender (onContactPhoneKnown). It
 * shows where the number was seen but supports nothing about it, so it does not let a caller review the entry or read
 * the decision reason: a caller who can open only the matching chat sees the entry "only through a match". A Suspected
 * fraud finding on the same message gives the row its finding (repo.insertObservation), and the row then supports the entry.
 */
const isSighting = (row: repo.WatchlistObservationRow): boolean => row.origin === 'sender_metadata' && row.finding_id === null;

/**
 * The one access rule for entries (design section 11), used by the list, the review route, chat-summary matches and
 * stream delivery. An entry is visible when one of its observations, or a current match (the entry is approved), lies in
 * a chat the principal can access; evidence lists only those observations; reviewing needs one that supports the entry.
 * (A match chat also holds the sender's sighting, so the match clause mirrors the design rather than widening access.)
 */
function viewOf(
  entry: repo.WatchlistEntryRow,
  observations: readonly repo.WatchlistObservationRow[],
  matches: readonly repo.WatchlistMatchRow[],
  canSeeChat: ChatAccess,
): EntryView {
  const evidence = observations.filter(canSeeChat);
  const currentMatches = entry.status === 'approved' ? matches.filter(canSeeChat) : [];
  return {
    canAccess: evidence.length > 0 || currentMatches.length > 0,
    evidence,
    restrictedEvidence: evidence.length < observations.length,
    matches: currentMatches,
    canReview: evidence.some((row) => !isSighting(row)),
  };
}

interface VisibleEntry {
  entry: repo.WatchlistEntryRow;
  view: EntryView;
}

/** The entry with the principal's view of it, or null when it is missing, in another workspace or not visible. */
function findVisibleEntry(tx: Tx, principal: Principal, entryId: string): VisibleEntry | null {
  const entry = repo.findEntryById(tx, entryId);
  if (!entry || entry.workspace_id !== principal.workspaceId) return null;
  const view = viewOf(entry, repo.listObservations(tx, [entry.id]), repo.listMatchesOfEntries(tx, [entry.id]), chatAccessFor(tx, principal));
  return view.canAccess ? { entry, view } : null;
}

/** An entry the caller cannot access is answered exactly like a missing one. */
function requireVisibleEntry(tx: Tx, principal: Principal, entryId: string): VisibleEntry {
  const visible = findVisibleEntry(tx, principal, entryId);
  if (!visible) throw AppError.of('watchlist_entry_not_found', 'Watchlist entry not found.');
  return visible;
}

function toEvidenceRef(row: repo.WatchlistObservationRow): EvidenceRef {
  return {
    observationId: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    messageEventId: row.message_event_id,
    findingId: row.finding_id,
    origin: row.origin,
    sourceRepresentation: row.source_representation,
    reason: row.reason,
    observedAt: row.observed_at,
  };
}

/** The reason is free text written from evidence: only callers who may review (and so open that evidence) read it. */
function toLastDecision(row: repo.WatchlistReviewRow | undefined, canReview: boolean): WatchlistEntry['lastDecision'] {
  if (!row) return null;
  return {
    decision: row.decision,
    reason: canReview ? row.reason : null,
    officer: { id: row.officer_id, displayName: row.officer_display_name },
    decidedAt: row.decided_at,
  };
}

function toWatchlistEntry(entry: repo.WatchlistEntryRow, view: EntryView, lastReview: repo.WatchlistReviewRow | undefined): WatchlistEntry {
  return {
    id: entry.id,
    number: { e164: entry.e164, display: entry.display, exactMatchEligible: entry.e164 !== null },
    status: entry.status,
    statusLabel: WATCHLIST_STATUS_LABELS[entry.status],
    revision: entry.revision,
    newEvidenceSinceReview: entry.new_evidence_since_review === 1,
    firstSeenAt: entry.first_seen_at,
    lastSeenAt: entry.last_seen_at,
    evidence: view.evidence.map(toEvidenceRef),
    restrictedEvidence: view.restrictedEvidence,
    matches: view.matches.map((match) => ({ chatId: match.chat_id, matchedAt: match.matched_at })),
    lastDecision: toLastDecision(lastReview, view.canReview),
    canReview: view.canReview,
  };
}

function toChatMatch(entry: repo.WatchlistEntryRow, match: repo.WatchlistMatchRow, view: EntryView): ChatWatchlistMatches[number] {
  return {
    entryId: entry.id,
    numberDisplay: entry.display,
    matchedAt: match.matched_at,
    evidence: view.evidence.map(toEvidenceRef),
    restrictedEvidence: view.restrictedEvidence,
  };
}

/** The given entries as the principal sees them; entries the principal cannot access are left out. */
function entriesAsSeenBy(tx: Tx, principal: Principal, entries: readonly repo.WatchlistEntryRow[]): WatchlistEntry[] {
  const ids = entries.map((entry) => entry.id);
  const observations = groupByEntry(repo.listObservations(tx, ids));
  const matches = groupByEntry(repo.listMatchesOfEntries(tx, ids));
  const decisions = repo.latestReviews(tx, ids);
  const canSeeChat = chatAccessFor(tx, principal);
  return entries.flatMap((entry) => {
    const view = viewOf(entry, observations.get(entry.id) ?? [], matches.get(entry.id) ?? [], canSeeChat);
    return view.canAccess ? [toWatchlistEntry(entry, view, decisions.get(entry.id))] : [];
  });
}

/**
 * Watchlist matches keyed by chat ID, filtered to evidence the principal may open; chats without matches have no key.
 * A match is listed only while its entry is approved: a match is a lead, and clearing or reopening withdraws it.
 */
export function matchesForChats(tx: Tx, principal: Principal, chatIds: string[]): Map<string, ChatWatchlistMatches> {
  const result = new Map<string, ChatWatchlistMatches>();
  const matches = chatIds.length === 0 ? [] : repo.listMatchesInChats(tx, chatIds);
  if (matches.length === 0) return result;
  const entryIds = [...new Set(matches.map((match) => match.entry_id))];
  const entries = new Map(repo.listEntriesByIds(tx, entryIds).map((entry) => [entry.id, entry]));
  const observations = groupByEntry(repo.listObservations(tx, entryIds));
  const canSeeChat = chatAccessFor(tx, principal);
  for (const match of matches) {
    const entry = entries.get(match.entry_id);
    if (!entry || entry.status !== 'approved' || !canSeeChat(match)) continue;
    const listed = toChatMatch(entry, match, viewOf(entry, observations.get(entry.id) ?? [], [match], canSeeChat));
    result.set(match.chat_id, [...(result.get(match.chat_id) ?? []), listed]);
  }
  return result;
}

/** Whether the principal may see the entry (decides who receives watchlist entry stream events). */
export function canAccessEntry(tx: Tx, principal: Principal, entryId: string): boolean {
  return findVisibleEntry(tx, principal, entryId) !== null;
}

/** The entries of the principal's workspace that the principal can access. */
export function listEntries(tx: Tx, principal: Principal): WatchlistEntry[] {
  return entriesAsSeenBy(tx, principal, repo.listWorkspaceEntries(tx, principal.workspaceId));
}

/** 404 watchlist_entry_not_found unless the principal can access the entry (the review route checks it before the body). */
export function requireEntryAccess(tx: Tx, principal: Principal, entryId: string): void {
  requireVisibleEntry(tx, principal, entryId);
}

function nextStatus(status: WatchlistStatus, decision: WatchlistDecision): WatchlistStatus | null {
  const rule = TRANSITIONS[decision];
  return rule.from.includes(status) ? rule.to : null;
}

/**
 * An officer's decision on an entry. Checked in order: access (404 watchlist_entry_not_found), evidence that supports
 * the entry (403 evidence_access_required), the expected revision (409 revision_conflict), then the transition
 * (409 invalid_transition). The decision is stored with officer, time and reason, and published.
 */
export function reviewEntry(tx: Tx, officer: Principal, entryId: string, request: WatchlistReviewRequest): WatchlistEntry {
  const { entry, view } = requireVisibleEntry(tx, officer, entryId);
  if (!view.canReview) {
    throw AppError.of('evidence_access_required', 'Reviewing this entry needs access to evidence that supports it.');
  }
  if (entry.revision !== request.expectedRevision) {
    throw AppError.of('revision_conflict', 'The entry has changed since it was read.', { currentRevision: entry.revision, status: entry.status });
  }
  const toStatus = nextStatus(entry.status, request.decision);
  if (toStatus === null) {
    throw AppError.of('invalid_transition', 'The entry cannot take this decision in its current status.', { status: entry.status, decision: request.decision });
  }
  const revision = entry.revision + 1;
  repo.insertReview(tx, {
    entryId: entry.id, decision: request.decision, reason: request.reason, officerId: officer.id, fromStatus: entry.status, toStatus, revision,
  });
  const decided = repo.updateEntryStatus(tx, entry.id, toStatus, revision);
  publishEntryUpdated(tx, decided, 'reviewed');
  const [updated] = entriesAsSeenBy(tx, officer, [decided]);
  if (!updated) throw new Error('watchlist_entry_missing');
  return updated;
}
