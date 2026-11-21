/**
 * The deterministic reviewer (design section 10): fixed rules over one message, for tests and the offline demo. It
 * reports payment links, named recipients and phone numbers tied to a concern, each quoting the line it was found on,
 * and uses the same cue list as the code-side payment link check.
 */
import type { Concern, ExtractedKind } from '../contract/enums.ts';
import { hasCallbackCue, hasPaymentCue, textAfterRecipientMarker } from '../domain/cues.ts';
import { detectPaymentLinks, lineAt, maskUrls, tokenize, trimEdgePunctuation } from '../domain/links.ts';
import { findPhoneSpans, toAsciiDigits } from '../domain/phone.ts';
import { ReviewerUnavailableError, type ExtractedItem, type Reviewer, type ReviewRequest } from '../ports/reviewer.ts';

/** Two letters, two check digits, then groups of four (a space between groups allowed). */
const IBAN_LIKE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
/** International (+ or 00), national (0) or bracketed numbers; bare digit runs are usually dates, prices or references. */
const PHONE_START = /^[+(0]/;
const NON_DIGIT = /\D/g;

interface Found {
  kind: ExtractedKind;
  offset: number;
  value: string;
  concern: Concern | null;
}

interface Line {
  text: string;
  start: number;
}

function linesOf(text: string): Line[] {
  let start = 0;
  return text.split('\n').map((line) => {
    const entry = { text: line, start };
    start += line.length + 1;
    return entry;
  });
}

const blank = (text: string, start: number, end: number): string => text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);

function paymentLinks(text: string): Found[] {
  const links = new Set(detectPaymentLinks(text));
  return tokenize(text)
    .map((token) => ({ value: trimEdgePunctuation(token.text), offset: token.start }))
    .filter((token) => links.has(token.value))
    .map((token): Found => ({ kind: 'payment_link', offset: token.offset, value: token.value, concern: null }));
}

/** Names after a recipient marker, and IBAN-like tokens outside links. */
function recipients(text: string, lines: readonly Line[]): Found[] {
  const named = lines.flatMap((line): Found[] => {
    const name = textAfterRecipientMarker(line.text);
    return name === null ? [] : [{ kind: 'payment_recipient', offset: line.start, value: name, concern: null }];
  });
  const ibans = [...maskUrls(text).matchAll(IBAN_LIKE)].map((match): Found => ({
    kind: 'payment_recipient', offset: match.index, value: match[0], concern: null,
  }));
  return [...named, ...ibans];
}

/** Phone numbers outside links and IBANs, reported only when the message ties them to paying or calling back. */
function phoneNumbers(text: string): Found[] {
  const prose = maskUrls(text);
  const concern: Concern | null = hasPaymentCue(prose) ? 'payment_request' : hasCallbackCue(prose) ? 'callback_request' : null;
  if (concern === null) return [];
  const masked = [...prose.matchAll(IBAN_LIKE)].reduce((current, m) => blank(current, m.index, m.index + m[0].length), prose);
  return findPhoneSpans(masked)
    .map((span) => ({ span, value: text.slice(span.start, span.end) }))
    .filter(({ value }) => {
      const ascii = toAsciiDigits(value);
      const digits = ascii.replace(NON_DIGIT, '').length;
      return PHONE_START.test(ascii) && digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
    })
    .map(({ span, value }): Found => ({ kind: 'phone_number', offset: span.start, value, concern }));
}

function extractItems(request: ReviewRequest): ExtractedItem[] {
  const { text } = request;
  const found = [...paymentLinks(text), ...recipients(text, linesOf(text)), ...phoneNumbers(text)];
  const seen = new Set<string>();
  return found.flatMap((entry) => {
    const key = `${entry.kind}\u0000${entry.value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      sourceMessageId: request.messageId,
      kind: entry.kind,
      quote: lineAt(text, entry.offset),
      extractedValue: entry.value,
      concern: entry.concern,
      countryHint: null,
    }];
  });
}

export function createDeterministicReviewer(): Reviewer {
  return {
    name: 'deterministic',
    async review(request, signal) {
      if (signal.aborted) throw new ReviewerUnavailableError('review_aborted');
      return { items: extractItems(request) };
    },
    async health() {
      return { reachable: true, modelId: null };
    },
  };
}
