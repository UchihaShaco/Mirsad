/**
 * Scores an evaluation run (brief "Local model setup"). Every item a reviewer returned goes through validateItem as
 * in the review pipeline; an expected item matches an extracted one when kind and value agree after the pipeline's
 * normalization. The phone concern is a judgement call, so it is reported as agreement, not part of the match. The
 * report holds counts, IDs and timings only, never message text or extracted values.
 */
import type { Concern, ExtractedKind } from '../../contract/enums.ts';
import { normalizeRecipient, validateItem, type ReviewedRecord } from '../../domain/finding-validation.ts';
import { normalizeLink } from '../../domain/links.ts';
import { normalizePhone, phoneHintFor } from '../../domain/phone.ts';
import type { ExtractedItem } from '../../ports/reviewer.ts';
import type { ExpectedItem, Transcript, TranscriptMessage } from './transcript-schema.ts';

export type Language = Transcript['language'];
export const LANGUAGES: readonly Language[] = ['ar', 'en', 'mixed'];

/** What the reviewer answered for one message: its items, or the code it failed with. */
export type ReviewAnswer = { items: ExtractedItem[] } | { errorCode: string };

export interface ReviewedMessage {
  /** The transcript's ID of the incoming message. */
  messageId: string;
  /** The ID the reviewer was given and had to echo as sourceMessageId. */
  reviewedMessageId: string;
  answer: ReviewAnswer;
  latencyMs: number;
}

export interface TranscriptResult {
  transcript: Transcript;
  reviews: ReviewedMessage[];
}

/** How many matched phone numbers there were, and how many of them carried the expected concern. */
export interface ConcernAgreement {
  matchedPhones: number;
  agreeing: number;
}

export interface MessageScore {
  transcriptId: string;
  messageId: string;
  language: Language;
  expected: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  unsupported: number;
  missedKinds: ExtractedKind[];
  extraKinds: ExtractedKind[];
  concernAgreement: ConcernAgreement;
  latencyMs: number;
  errorCode: string | null;
}

export interface LatencySummary {
  count: number;
  minMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface GroupScore {
  messages: number;
  unavailable: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Null when there is nothing to divide by (no extracted or no expected items). */
  precision: number | null;
  recall: number | null;
  unsupported: number;
  concernAgreement: ConcernAgreement;
  latency: LatencySummary;
}

export interface EvalReport {
  overall: GroupScore;
  byLanguage: Record<Language, GroupScore>;
  messages: MessageScore[];
}

interface AcceptedItem {
  kind: ExtractedKind;
  normalizedValue: string;
  concern: Concern | null;
  countryHint: string | null;
}

interface Matching {
  matched: Array<{ expected: ExpectedItem; item: AcceptedItem }>;
  missed: ExpectedItem[];
  extra: AcceptedItem[];
}

const P95_PERCENT = 95;
const NO_PHONES: ConcernAgreement = { matchedPhones: 0, agreeing: 0 };

/**
 * The items the pipeline would act on (publishReview, design section 10 step 2): supported ones only, one per kind and
 * value, without phone numbers that carry no concern. Rejected items are the unsupported findings.
 */
function acceptItems(items: readonly ExtractedItem[], record: ReviewedRecord): { accepted: AcceptedItem[]; unsupported: number } {
  const accepted = new Map<string, AcceptedItem>();
  let unsupported = 0;
  for (const item of items) {
    const result = validateItem(item, record);
    if (!result.ok) {
      unsupported += 1;
      continue;
    }
    const key = `${item.kind}\u0000${result.normalizedValue}`;
    if ((item.kind === 'phone_number' && item.concern === null) || accepted.has(key)) continue;
    accepted.set(key, { kind: item.kind, normalizedValue: result.normalizedValue, concern: item.concern, countryHint: item.countryHint });
  }
  return { accepted: [...accepted.values()], unsupported };
}

/** The expected value as validateItem normalizes an extracted one; a phone number takes the extracted item's country hint. */
function normalizedExpected(expected: ExpectedItem, countryHint: string | null): string | null {
  switch (expected.kind) {
    case 'payment_link':
      return normalizeLink(expected.value);
    case 'payment_recipient':
      return normalizeRecipient(expected.value);
    case 'phone_number': {
      const phone = normalizePhone(expected.value, phoneHintFor(countryHint));
      return phone.e164 ?? `unnormalized:${phone.digits}`;
    }
  }
}

function matchItems(expected: readonly ExpectedItem[], accepted: readonly AcceptedItem[]): Matching {
  const remaining = [...accepted];
  const matched: Matching['matched'] = [];
  const missed: ExpectedItem[] = [];
  for (const want of expected) {
    const index = remaining.findIndex((item) => item.kind === want.kind && normalizedExpected(want, item.countryHint) === item.normalizedValue);
    const [item] = index < 0 ? [] : remaining.splice(index, 1);
    if (item) matched.push({ expected: want, item });
    else missed.push(want);
  }
  return { matched, missed, extra: remaining };
}

function scoreMessage(transcript: Transcript, message: TranscriptMessage, review: ReviewedMessage): MessageScore {
  const base = { transcriptId: transcript.id, messageId: message.id, language: transcript.language, expected: message.expected.length };
  const timing = { latencyMs: review.latencyMs };
  if ('errorCode' in review.answer) {
    const missedKinds = message.expected.map((want) => want.kind);
    const counts = { truePositives: 0, falsePositives: 0, falseNegatives: missedKinds.length, unsupported: 0 };
    return { ...base, ...counts, missedKinds, extraKinds: [], concernAgreement: NO_PHONES, ...timing, errorCode: review.answer.errorCode };
  }
  const { accepted, unsupported } = acceptItems(review.answer.items, { messageId: review.reviewedMessageId, text: message.text });
  const { matched, missed, extra } = matchItems(message.expected, accepted);
  const phones = matched.filter(({ expected }) => expected.kind === 'phone_number');
  return {
    ...base,
    truePositives: matched.length,
    falsePositives: extra.length,
    falseNegatives: missed.length,
    unsupported,
    missedKinds: missed.map((want) => want.kind),
    extraKinds: extra.map((item) => item.kind),
    concernAgreement: { matchedPhones: phones.length, agreeing: phones.filter(({ expected, item }) => item.concern === expected.concern).length },
    ...timing,
    errorCode: null,
  };
}

/** Nearest-rank percentiles over every review call; the median of an even count is the mean of the middle two. */
function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (position: number): number => sorted[position - 1] ?? 0;
  const half = sorted.length / 2;
  const medianMs = sorted.length % 2 === 1 ? rank(Math.ceil(half)) : (rank(half) + rank(half + 1)) / 2;
  const p95Ms = rank(Math.ceil((P95_PERCENT * sorted.length) / 100));
  return { count: sorted.length, minMs: rank(1), medianMs, p95Ms, maxMs: rank(sorted.length) };
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

function groupScore(scores: readonly MessageScore[]): GroupScore {
  const sum = (pick: (score: MessageScore) => number): number => scores.reduce((total, score) => total + pick(score), 0);
  const truePositives = sum((s) => s.truePositives);
  const falsePositives = sum((s) => s.falsePositives);
  const falseNegatives = sum((s) => s.falseNegatives);
  return {
    messages: scores.length,
    unavailable: scores.filter((s) => s.errorCode !== null).length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    unsupported: sum((s) => s.unsupported),
    concernAgreement: { matchedPhones: sum((s) => s.concernAgreement.matchedPhones), agreeing: sum((s) => s.concernAgreement.agreeing) },
    latency: summarizeLatency(scores.map((s) => s.latencyMs)),
  };
}

function messageOf(transcript: Transcript, messageId: string): TranscriptMessage {
  const message = transcript.messages.find((m) => m.id === messageId);
  if (!message) throw new Error(`transcript ${transcript.id} has no message ${messageId}`);
  return message;
}

export function scoreTranscripts(results: readonly TranscriptResult[]): EvalReport {
  const messages = results.flatMap(({ transcript, reviews }) =>
    reviews.map((review) => scoreMessage(transcript, messageOf(transcript, review.messageId), review)),
  );
  const ofLanguage = (language: Language): GroupScore => groupScore(messages.filter((s) => s.language === language));
  return { overall: groupScore(messages), byLanguage: { ar: ofLanguage('ar'), en: ofLanguage('en'), mixed: ofLanguage('mixed') }, messages };
}
