/**
 * Checks an item a reviewer extracted against the stored text of the reviewed event (design section 10, step 2) and
 * returns its normalized value and the value as the message wrote it (step 3). Nothing a reviewer reports is shown
 * unless that text supports it, and what is stored and shown is always the message's own text, never the reviewer's.
 */
import type { ExtractedKind } from '../contract/enums.ts';
import type { ExtractedItem } from '../ports/reviewer.ts';
import { normalizeLink, tokenize, trimEdgePunctuation } from './links.ts';
import { findPhoneSpans, isPhoneText, normalizePhone, phoneHintFor, toAsciiDigits, type PhoneSpan } from './phone.ts';

export type RejectionReason = 'wrong_message' | 'quote_not_found' | 'value_not_in_quote' | 'empty';
export type ValidationResult =
  | { ok: true; normalizedValue: string; writtenValue: string }
  | { ok: false; reason: RejectionReason };

/** The reviewed event: the internal message ID the reviewer must echo and the event's own text. */
export interface ReviewedRecord {
  messageId: string;
  text: string;
}

/** A supported item, its normalized value and its value as written (design section 10, steps 2 and 3). */
export interface AcceptedItem {
  item: ExtractedItem;
  normalizedValue: string;
  /** The value as the message wrote it: what findings, case details and the watchlist store and show. */
  writtenValue: string;
}

export interface AcceptedItems {
  accepted: AcceptedItem[];
  unsupported: number;
}

/** A value the quote supports: normalized for comparison, and as the quote writes it. */
interface SupportedValue {
  normalized: string;
  written: string;
}

/** The digit groups first..last of a phone-like span. */
interface GroupRange {
  first: number;
  last: number;
}

/** E.164 allows at most 15 digits; shorter than 7 is no phone number. */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const NON_DIGIT = /\D/g;
const WHITESPACE = /\s/;
const WHITESPACE_RUN = /\s+/g;

export function normalizeRecipient(value: string): string {
  return value.trim().replace(WHITESPACE_RUN, ' ').toLowerCase();
}

/** A phone number's normalized value (design section 10, step 3): its E.164 form, or `unnormalized:<digits>`. */
export function normalizePhoneValue(value: string, countryHint: string | null): string {
  const phone = normalizePhone(value, phoneHintFor(countryHint));
  return phone.e164 ?? `unnormalized:${phone.digits}`;
}

/** The value must be a whole token of the quote (edge punctuation aside), so it is already written as in the message. */
function linkValue(value: string, quote: string): SupportedValue | null {
  const wholeToken = tokenize(quote).some((token) => token.text === value || trimEdgePunctuation(token.text) === value);
  const normalized = wholeToken ? normalizeLink(value) : null;
  return normalized === null ? null : { normalized, written: value };
}

const isNumberLength = (length: number): boolean => length >= PHONE_MIN_DIGITS && length <= PHONE_MAX_DIGITS;

/**
 * For each cut between digit groups (0 to lengths.length), whether the groups before it divide into consecutive runs
 * that are each a whole number of 7 to 15 digits. A run is at most 15 digits, so each cut looks back a few groups only.
 */
function cutsAfterWholeNumbers(lengths: readonly number[]): boolean[] {
  const cuts = [true];
  for (let end = 1; end <= lengths.length; end += 1) {
    let digits = 0;
    let reachable = false;
    for (let start = end - 1; start >= 0 && !reachable && digits <= PHONE_MAX_DIGITS; start -= 1) {
      digits += lengths[start] ?? 0;
      reachable = isNumberLength(digits) && cuts[start] === true;
    }
    cuts.push(reachable);
  }
  return cuts;
}

/** The last group when the groups from `first` on join to exactly the digits; -1 otherwise. */
function lastGroupOfNumber(groups: readonly string[], first: number, digits: string): number {
  let joined = '';
  for (let last = first; last < groups.length; last += 1) {
    joined += groups[last];
    if (joined.length >= digits.length) return joined === digits ? last : -1;
  }
  return -1;
}

/**
 * The groups whose digits are the number: the whole span, or one of several complete numbers written one after the
 * other in it, which holds only when the groups on both sides of it divide into whole numbers as well.
 */
function numberInSpan(groups: readonly string[], digits: string): GroupRange | null {
  const lengths = groups.map((group) => group.length);
  const before = cutsAfterWholeNumbers(lengths);
  const after = cutsAfterWholeNumbers([...lengths].reverse());
  for (let first = 0; first < groups.length; first += 1) {
    const last = before[first] === true ? lastGroupOfNumber(groups, first, digits) : -1;
    if (last >= 0 && after[groups.length - last - 1] === true) return { first, last };
  }
  return null;
}

/** Opening brackets minus closing brackets in a text. */
const bracketBalance = (text: string): number => text.split('(').length - text.split(')').length;

/**
 * The number as the quote writes it: from its first to its last digit, with the span's leading + or opening bracket when
 * the number starts the span. A closing bracket it holds keeps the opening bracket written just before it, as in
 * (+44) 7700 900123, and an opening bracket it holds keeps the closing bracket that follows it.
 */
function writtenNumber(quote: string, span: PhoneSpan, range: GroupRange): string {
  const first = range.first === 0 ? span.start : (span.groupRanges[range.first]?.start ?? span.start);
  const end = span.groupRanges[range.last]?.end ?? span.end;
  const start = bracketBalance(quote.slice(first, end)) < 0 && quote[first - 1] === '(' ? first - 1 : first;
  const written = quote.slice(start, end);
  return bracketBalance(written) > 0 && quote[end] === ')' ? `${written})` : written;
}

/**
 * The value may hold only what a phone number is written with, and its digits must be a number of a phone-like span of
 * the quote (a date never is one); Arabic-Indic digits count as their ASCII digits. The number is kept, and normalized,
 * as the quote writes it, whatever the reviewer added, dropped or reformatted.
 */
function phoneValue(value: string, quote: string, countryHint: string | null): SupportedValue | null {
  if (!isPhoneText(value)) return null;
  const digits = toAsciiDigits(value).replace(NON_DIGIT, '');
  if (!isNumberLength(digits.length)) return null;
  for (const span of findPhoneSpans(quote)) {
    const range = numberInSpan(span.digitGroups, digits);
    if (range === null) continue;
    const written = writtenNumber(quote, span, range);
    return { normalized: normalizePhoneValue(written, countryHint), written };
  }
  return null;
}

/**
 * Where the normalized recipient lies in the quote as written. The quote is folded the way normalizeRecipient folds a
 * value (whitespace runs to one space, letters to lower case), one character at a time, and each folded character keeps
 * the range of the quote character it came from. Null when the folded quote does not contain the value.
 */
function writtenRecipient(quote: string, normalized: string): string | null {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < quote.length;) {
    const char = String.fromCodePoint(quote.codePointAt(index) ?? 0);
    const next = index + char.length;
    const piece = WHITESPACE.test(char) ? (folded.endsWith(' ') ? '' : ' ') : char.toLowerCase();
    for (let unit = 0; unit < piece.length; unit += 1) {
      starts.push(index);
      ends.push(next);
    }
    folded += piece;
    index = next;
  }
  const at = folded.indexOf(normalized);
  const start = starts[at];
  const end = ends[at + normalized.length - 1];
  return at < 0 || start === undefined || end === undefined ? null : quote.slice(start, end);
}

/** The value must appear in the quote, ignoring case and repeated whitespace; it is kept as the quote writes it. */
function recipientValue(value: string, quote: string): SupportedValue | null {
  const normalized = normalizeRecipient(value);
  if (!normalizeRecipient(quote).includes(normalized)) return null;
  const written = writtenRecipient(quote, normalized);
  return written === null ? null : { normalized, written };
}

function supportedValueOf(kind: ExtractedKind, value: string, quote: string, countryHint: string | null): SupportedValue | null {
  switch (kind) {
    case 'payment_link':
      return linkValue(value, quote);
    case 'phone_number':
      return phoneValue(value, quote, countryHint);
    case 'payment_recipient':
      return recipientValue(value, quote);
  }
}

export function validateItem(item: ExtractedItem, record: ReviewedRecord): ValidationResult {
  if (item.sourceMessageId !== record.messageId) return { ok: false, reason: 'wrong_message' };
  const quote = item.quote.trim();
  const value = item.extractedValue.trim();
  if (quote === '' || value === '') return { ok: false, reason: 'empty' };
  if (!record.text.includes(quote)) return { ok: false, reason: 'quote_not_found' };
  const supported = supportedValueOf(item.kind, value, quote, item.countryHint);
  if (supported === null) return { ok: false, reason: 'value_not_in_quote' };
  return { ok: true, normalizedValue: supported.normalized, writtenValue: supported.written };
}

/**
 * What the review pipeline acts on (design section 10, step 2), and so what the evaluation scores: the supported
 * items, the first of each kind and normalized value, without phone numbers that carry no concern. Rejected items are
 * the unsupported findings.
 */
export function acceptValidatedItems(items: readonly ExtractedItem[], record: ReviewedRecord): AcceptedItems {
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
    accepted.set(key, { item, normalizedValue: result.normalizedValue, writtenValue: result.writtenValue });
  }
  return { accepted: [...accepted.values()], unsupported };
}
