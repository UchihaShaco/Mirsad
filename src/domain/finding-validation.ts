/**
 * Checks an item a reviewer extracted against the stored text of the reviewed event (design section 10, step 2) and
 * returns its normalized value (step 3). Nothing a reviewer reports is shown unless that text supports it.
 */
import type { ExtractedKind } from '../contract/enums.ts';
import type { ExtractedItem } from '../ports/reviewer.ts';
import { normalizeLink, tokenize, trimEdgePunctuation } from './links.ts';
import { findPhoneSpans, normalizePhone, phoneHintFor, toAsciiDigits } from './phone.ts';

export type RejectionReason = 'wrong_message' | 'quote_not_found' | 'value_not_in_quote' | 'empty';
export type ValidationResult = { ok: true; normalizedValue: string } | { ok: false; reason: RejectionReason };

/** The reviewed event: the internal message ID the reviewer must echo and the event's own text. */
export interface ReviewedRecord {
  messageId: string;
  text: string;
}

/** E.164 allows at most 15 digits; shorter than 7 is no phone number. */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const NON_DIGIT = /\D/g;
const WHITESPACE_RUN = /\s+/g;

export function normalizeRecipient(value: string): string {
  return value.trim().replace(WHITESPACE_RUN, ' ').toLowerCase();
}

/** The value must be a whole token of the quote (edge punctuation aside) and a web link with a dotted host. */
function linkValue(value: string, quote: string): string | null {
  const wholeToken = tokenize(quote).some((token) => token.text === value || trimEdgePunctuation(token.text) === value);
  return wholeToken ? normalizeLink(value) : null;
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

/**
 * Whether the digits are a number of the span: the whole span, or one of several complete numbers written one after
 * the other in it, which holds only when the groups on both sides of it divide into whole numbers as well.
 */
function isNumberOfSpan(groups: readonly string[], digits: string): boolean {
  const lengths = groups.map((group) => group.length);
  const before = cutsAfterWholeNumbers(lengths);
  const after = cutsAfterWholeNumbers([...lengths].reverse());
  return groups.some((_, first) => {
    if (before[first] !== true) return false;
    let joined = '';
    for (const [offset, group] of groups.slice(first).entries()) {
      joined += group;
      if (joined.length >= digits.length) return joined === digits && after[groups.length - first - offset - 1] === true;
    }
    return false;
  });
}

/**
 * The value's digits must be a number of a phone-like span of the quote (a date never is one); Arabic-Indic digits
 * count as their ASCII digits.
 */
function phoneValue(value: string, quote: string, countryHint: string | null): string | null {
  const digits = toAsciiDigits(value).replace(NON_DIGIT, '');
  if (!isNumberLength(digits.length)) return null;
  if (!findPhoneSpans(quote).some((span) => isNumberOfSpan(span.digitGroups, digits))) return null;
  const phone = normalizePhone(value, phoneHintFor(countryHint));
  return phone.e164 ?? `unnormalized:${phone.digits}`;
}

/** The value must appear in the quote, ignoring case and repeated whitespace. */
function recipientValue(value: string, quote: string): string | null {
  const normalized = normalizeRecipient(value);
  return normalizeRecipient(quote).includes(normalized) ? normalized : null;
}

function normalizedValueOf(kind: ExtractedKind, value: string, quote: string, countryHint: string | null): string | null {
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
  const normalizedValue = normalizedValueOf(item.kind, value, quote, item.countryHint);
  return normalizedValue === null ? { ok: false, reason: 'value_not_in_quote' } : { ok: true, normalizedValue };
}
