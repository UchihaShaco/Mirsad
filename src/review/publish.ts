/**
 * publishReview (design section 10, "Publish"): one transaction that re-reads the chat, discards a result that
 * finished under an older control state, validates every item against the reviewed event's stored text, decides what
 * is new to the chat, applies the Suspected fraud rule and records quiet findings worded from fixed templates.
 */
import type { Concern, ExtractedKind, ReviewOutcome } from '../contract/enums.ts';
import { decideDetail, type DetailDecision, type KnownDetail } from '../domain/case-details.ts';
import { acceptValidatedItems, type AcceptedItem } from '../domain/finding-validation.ts';
import { findPaymentLinks, hostOfNormalizedLink } from '../domain/links.ts';
import { normalizePhone, phoneHintFor } from '../domain/phone.ts';
import type { ExtractedItem, PhoneMention } from '../ports/reviewer.ts';
import { findingLabel } from '../services/timeline.ts';
import * as watchlist from '../services/watchlist.ts';
import type { Tx } from '../storage/db.ts';
import { listCaseDetails, recordCaseDetail, type CaseDetailRow } from '../storage/repos/case-details.ts';
import { listCaseReferences, paymentHostsOf } from '../storage/repos/case-references.ts';
import { insertFinding } from '../storage/repos/findings.ts';
import {
  completeReviewAttempt,
  endReviewAttempt,
  loadReviewContext,
  publishReviewUpdated,
  type ReviewContext,
} from '../storage/repos/reviews.ts';
import type { FindingRow } from '../storage/rows.ts';
import { findingNote } from './notes.ts';

export type PublishOutcome =
  | { status: 'superseded' }
  | { status: 'stale_discarded' }
  | { status: 'requeued' }
  | { status: 'completed'; outcome: ReviewOutcome; findingIds: string[]; unsupported: number; suppressed: number };

/** A supported detail of the reviewed event, from the reviewer or found in code. */
interface Candidate {
  category: ExtractedKind;
  quote: string;
  extractedValue: string;
  normalizedValue: string;
  concern: Concern | null;
  countryHint: string | null;
  /** False for a link only the code-side payment link check found. */
  reported: boolean;
}

interface FraudContext {
  confirmedHosts: ReadonlySet<string>;
  latestReferenceId: string;
}

interface Recorded {
  candidate: Candidate;
  finding: FindingRow | null;
}

function endAttempt(tx: Tx, ctx: ReviewContext, status: 'stale_discarded' | 'pending'): void {
  const row = endReviewAttempt(tx, ctx.review.id, status);
  if (row) publishReviewUpdated(tx, ctx.chat.workspace_id, row);
}

/**
 * Rule 1: a result that finished under an older control state never becomes a finding. Outside ai_active it is
 * discarded (resume queues it again); if the officer paused or took over and resumed meanwhile, it goes back to pending.
 */
function settleStaleResult(tx: Tx, ctx: ReviewContext): PublishOutcome | null {
  if (ctx.chat.ai_mode !== 'ai_active') {
    endAttempt(tx, ctx, 'stale_discarded');
    return { status: 'stale_discarded' };
  }
  if (ctx.chat.revision !== ctx.review.requested_revision) {
    endAttempt(tx, ctx, 'pending');
    return { status: 'requeued' };
  }
  return null;
}

/**
 * Rule 2 is acceptValidatedItems: each item it accepts becomes a candidate the reviewer reported. Its value is the one
 * the message wrote, so the finding, the case detail and the watchlist never hold the reviewer's wording.
 */
function toCandidate({ item, normalizedValue, writtenValue }: AcceptedItem): Candidate {
  return {
    category: item.kind,
    quote: item.quote.trim(),
    extractedValue: writtenValue,
    normalizedValue,
    concern: item.concern,
    countryHint: item.countryHint,
    reported: true,
  };
}

/**
 * Rule 5 does not depend on what the reviewer chose to report: the links the code-side payment link check finds in
 * the stored text are considered too, quoted by the line they are on.
 */
function withCodeFoundLinks(candidates: readonly Candidate[], text: string): Candidate[] {
  const known = new Set(candidates.filter((c) => c.category === 'payment_link').map((c) => c.normalizedValue));
  const found = findPaymentLinks(text)
    .filter((link) => !known.has(link.normalizedValue))
    .map((link): Candidate => ({
      category: 'payment_link',
      quote: link.quote,
      extractedValue: link.url,
      normalizedValue: link.normalizedValue,
      concern: null,
      countryHint: null,
      reported: false,
    }));
  return [...candidates, ...found];
}

/** Rule 5 applies only once the chat has a merchant payment confirmation; the most recent one is cited. */
function fraudContextOf(tx: Tx, chatId: string): FraudContext | null {
  const references = listCaseReferences(tx, chatId);
  const latest = references.at(-1);
  if (!latest) return null;
  return { confirmedHosts: new Set(references.flatMap(paymentHostsOf)), latestReferenceId: latest.id };
}

const toKnown = (row: CaseDetailRow): KnownDetail => ({
  normalizedValue: row.normalized_value,
  displayValue: row.display_value,
  lastSeenPosition: row.last_seen_position,
});

/** One finding for the candidate; with a fraud context it is the Suspected fraud finding, citing the latest reference. */
function insertCandidateFinding(
  tx: Tx,
  ctx: ReviewContext,
  candidate: Candidate,
  decision: DetailDecision,
  fraud: FraudContext | null,
): FindingRow | null {
  const kind = fraud ? 'suspected_fraud' : candidate.category;
  const changedFrom = decision.kind === 'changed' ? decision.changedFrom : null;
  return insertFinding(tx, {
    chatId: ctx.chat.id,
    workspaceId: ctx.chat.workspace_id,
    reviewId: ctx.review.id,
    messageId: ctx.message.id,
    messageEventId: ctx.messageEvent.id,
    kind,
    quote: candidate.quote,
    extractedValue: candidate.extractedValue,
    normalizedValue: candidate.normalizedValue,
    concern: candidate.concern,
    changedFrom,
    caseReferenceId: fraud ? fraud.latestReferenceId : null,
    note: findingNote(findingLabel(kind, changedFrom), ctx.message.direction),
  });
}

/**
 * Rules 4 and 5: each candidate is compared with what earlier message events of the chat carried in its category.
 * A repeat is suppressed; anything else updates the detail and raises one finding, of kind suspected_fraud when the
 * link's host is not on the merchant confirmation. A link only the code-side check found raises nothing else.
 */
function recordCandidates(
  tx: Tx,
  ctx: ReviewContext,
  candidates: readonly Candidate[],
  fraud: FraudContext | null,
): { recorded: Recorded[]; suppressed: number } {
  const position = ctx.messageEvent.position;
  const earlier = listCaseDetails(tx, ctx.chat.id).filter((row) => row.last_seen_position < position);
  const recorded: Recorded[] = [];
  let suppressed = 0;
  for (const candidate of candidates) {
    const known = earlier.filter((row) => row.category === candidate.category).map(toKnown);
    const decision = decideDetail(candidate.category, candidate.normalizedValue, known);
    const conflict = fraud !== null && candidate.category === 'payment_link'
      && !fraud.confirmedHosts.has(hostOfNormalizedLink(candidate.normalizedValue));
    const detail = {
      chatId: ctx.chat.id,
      category: candidate.category,
      normalizedValue: candidate.normalizedValue,
      displayValue: candidate.extractedValue,
      messageId: ctx.message.id,
      position,
    };
    if (decision.kind === 'repeat') {
      recordCaseDetail(tx, detail);
      suppressed += 1;
      recorded.push({ candidate, finding: null });
    } else if (conflict || candidate.reported) {
      recordCaseDetail(tx, detail);
      recorded.push({ candidate, finding: insertCandidateFinding(tx, ctx, candidate, decision, conflict ? fraud : null) });
    }
  }
  return { recorded, suppressed };
}

/** Rule 7: phone numbers with a concern (repeats included) and Suspected fraud findings go to the watchlist. */
function notifyWatchlist(tx: Tx, ctx: ReviewContext, recorded: readonly Recorded[]): void {
  const phoneMentions: PhoneMention[] = recorded.flatMap(({ candidate, finding }) => {
    if (candidate.category !== 'phone_number' || candidate.concern === null) return [];
    const phone = normalizePhone(candidate.extractedValue, phoneHintFor(candidate.countryHint));
    return [{ ...phone, sourceRepresentation: candidate.extractedValue, concern: candidate.concern, findingId: finding?.id ?? null }];
  });
  const suspectedFraudFindingIds = recorded.flatMap(({ finding }) => (finding?.kind === 'suspected_fraud' ? [finding.id] : []));
  if (phoneMentions.length === 0 && suspectedFraudFindingIds.length === 0) return;
  watchlist.onEvidencePublished(tx, { chat: ctx.chat, message: ctx.message, messageEvent: ctx.messageEvent }, { phoneMentions, suspectedFraudFindingIds });
}

export function publishReview(tx: Tx, reviewId: string, items: readonly ExtractedItem[]): PublishOutcome {
  const ctx = loadReviewContext(tx, reviewId);
  if (!ctx || ctx.review.status !== 'running') return { status: 'superseded' };
  const stale = settleStaleResult(tx, ctx);
  if (stale) return stale;
  const text = ctx.messageEvent.text ?? '';
  const { accepted, unsupported } = acceptValidatedItems(items, { messageId: ctx.message.id, text });
  const candidates = accepted.map(toCandidate);
  const fraud = fraudContextOf(tx, ctx.chat.id);
  const considered = fraud ? withCodeFoundLinks(candidates, text) : candidates;
  const { recorded, suppressed } = recordCandidates(tx, ctx, considered, fraud);
  notifyWatchlist(tx, ctx, recorded);
  const findingIds = recorded.flatMap(({ finding }) => (finding ? [finding.id] : []));
  const outcome: ReviewOutcome = findingIds.length > 0 ? 'findings' : 'no_new_finding';
  const row = completeReviewAttempt(tx, reviewId, { outcome, unsupported, suppressed });
  if (row) publishReviewUpdated(tx, ctx.chat.workspace_id, row);
  return { status: 'completed', outcome, findingIds, unsupported, suppressed };
}
