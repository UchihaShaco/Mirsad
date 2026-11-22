/**
 * Phone numbers (design sections 10, 11 and 19.5): Arabic-Indic digit mapping, phone-like spans in text, E.164
 * normalization and the watchlist match key. This is the only place in the code base that normalizes a number.
 */
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;
const ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/g;
const NON_DIGIT = /\D/g;
const DIGIT_GROUP = /\d+/g;
/**
 * Format characters that only set text direction (LRM, RLM, ALM and the isolates), which bidirectional text puts
 * around and inside numbers. They carry no digit, so they are deleted before a number is parsed.
 */
const DIRECTION_MARKS = /[؜‎‏⁦-⁩]/g;
/** Every Unicode space separator, such as the no-break, thin and narrow no-break spaces: read as a plain space. */
const SPACE_SEPARATOR = /\p{Zs}/gu;
const INTERNATIONAL_PREFIX = '00';
/** An opening bracket before an international prefix, as in (+44) 7700 900123: it does not make the number national. */
const BRACKET_BEFORE_PREFIX = /^\((?=\+|00)/;
/**
 * Ofcom's drama range +44 7700 900000-900999. The phone metadata rejects it because it is fictional, yet it is the only
 * UK range synthetic data may use, so it is accepted as a complete number. No real subscriber can hold one.
 */
const RESERVED_FICTIONAL_E164 = /^\+447700900\d{3}$/;
const DATE_YEAR = '(?:19|20)\\d{2}';
const DATE_MONTH = '(?:0?[1-9]|1[0-2])';
const DATE_DAY = '(?:0?[1-9]|[12]\\d|3[01])';
/**
 * A calendar date with the same - or . between its parts: year, month, day (2026-11-05), or day and month in either
 * order before the year (05.11.2026, 11-05-2026). A date is never phone-like: it is blanked out, with a character that
 * is neither digit nor separator, before spans are looked for, so a number written next to a date stands alone.
 */
const CALENDAR_DATE = new RegExp(
  `(?<!\\d)(?:${DATE_YEAR}([-.])${DATE_MONTH}\\1${DATE_DAY}|${DATE_DAY}([-.])${DATE_DAY}\\2${DATE_YEAR})(?!\\d)`,
  'g',
);
const DATE_BLANK = '_';
/**
 * What may separate the digits of a phone number: spaces (also no-break, thin and narrow no-break), direction marks,
 * dots, brackets and hyphens.
 */
const SEPARATORS = ' \u00a0\u2009\u202f\u200e\u200f.()\\-';
/** A run of digits joined by at most two separators in a row, with an optional leading + or opening bracket. */
const PHONE_SPAN = new RegExp(`\\+?\\(?\\d(?:[${SEPARATORS}]{0,2}\\d)*`, 'g');
/** Text made only of what a phone number is written with: digits, separators and plus signs. */
const PHONE_TEXT = new RegExp(`^[+\\d${SEPARATORS}]+$`);

export interface PhoneHint {
  country?: string;
  internationalFormat?: boolean;
}

export interface NormalizedPhone {
  /** The E.164 form, or null when the number cannot be normalized with the context given. */
  e164: string | null;
  /** The ASCII digits of the number as written. */
  digits: string;
}

/** Where a piece of a text lies: offsets refer to the text as given (digit mapping keeps lengths). */
export interface TextRange {
  start: number;
  end: number;
}

/** A phone-like run of a text, with the ASCII digits of each digit group and where each group lies. */
export interface PhoneSpan extends TextRange {
  digitGroups: string[];
  groupRanges: TextRange[];
}

/** Maps Arabic-Indic and Extended Arabic-Indic digits to ASCII, one character for one. */
export function toAsciiDigits(text: string): string {
  return text.replace(ARABIC_INDIC_DIGIT, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO);
  });
}

export function findPhoneSpans(text: string): PhoneSpan[] {
  const withoutDates = toAsciiDigits(text).replace(CALENDAR_DATE, (date) => DATE_BLANK.repeat(date.length));
  return [...withoutDates.matchAll(PHONE_SPAN)].map((match) => {
    const groups = [...match[0].matchAll(DIGIT_GROUP)];
    return {
      start: match.index,
      end: match.index + match[0].length,
      digitGroups: groups.map((group) => group[0]),
      groupRanges: groups.map((group) => ({ start: match.index + group.index, end: match.index + group.index + group[0].length })),
    };
  });
}

/** Whether the text holds nothing but what a phone number is written with (Arabic-Indic digits count as digits). */
export function isPhoneText(text: string): boolean {
  return PHONE_TEXT.test(toAsciiDigits(text));
}

/** The E.164 form of a complete number; partial and invalid numbers give null. */
function completeNumber(text: string, country?: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(text, country);
  if (!parsed) return null;
  return parsed.isValid() || RESERVED_FICTIONAL_E164.test(parsed.number) ? parsed.number : null;
}

/** The number with ASCII digits, without direction marks and with plain spaces, as the phone metadata can parse it. */
function parseableText(raw: string): string {
  return toAsciiDigits(raw).replace(DIRECTION_MARKS, '').replace(SPACE_SEPARATOR, ' ').trim();
}

/**
 * International when written with + (or 00) or when the source marks it so; otherwise national with the given
 * country. No default country is ever assumed.
 */
export function normalizePhone(raw: string, hint: PhoneHint = {}): NormalizedPhone {
  const ascii = parseableText(raw);
  const digits = ascii.replace(NON_DIGIT, '');
  const unbracketed = ascii.replace(BRACKET_BEFORE_PREFIX, '');
  const written = unbracketed.startsWith(INTERNATIONAL_PREFIX) ? `+${unbracketed.slice(INTERNATIONAL_PREFIX.length)}` : unbracketed;
  if (written.startsWith('+')) return { e164: completeNumber(written), digits };
  if (hint.internationalFormat) return { e164: completeNumber(`+${digits}`), digits };
  if (hint.country !== undefined && isSupportedCountry(hint.country)) return { e164: completeNumber(written, hint.country), digits };
  return { e164: null, digits };
}

/** The hint for a reviewer's country hint (ISO alpha-2 in any case, or null when unknown). */
export function phoneHintFor(countryHint: string | null): PhoneHint {
  return countryHint === null ? {} : { country: countryHint.toUpperCase() };
}

/** E.164 when known; otherwise a lead tied to the chat that mentioned the number, so it never merges across chats. */
export function watchlistMatchKey(number: NormalizedPhone, chatId: string): string {
  return number.e164 ?? `unnormalized:${chatId}:${number.digits}`;
}
