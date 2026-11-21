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
const INTERNATIONAL_PREFIX = '00';
/**
 * Ofcom's drama range +44 7700 900000-900999. The phone metadata rejects it because it is fictional, yet it is the only
 * UK range synthetic data may use, so it is accepted as a complete number. No real subscriber can hold one.
 */
const RESERVED_FICTIONAL_E164 = /^\+447700900\d{3}$/;
/**
 * A run of digits joined by at most two separators in a row: spaces (also no-break, thin and direction marks), dots,
 * hyphens and brackets, with an optional leading + or opening bracket.
 */
const PHONE_SPAN = /\+?\(?\d(?:[    ‎‏.()-]{0,2}\d)*/g;

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

/** A phone-like run of a text; offsets refer to the text as given (digit mapping keeps lengths). */
export interface PhoneSpan {
  start: number;
  end: number;
  digitGroups: string[];
}

/** Maps Arabic-Indic and Extended Arabic-Indic digits to ASCII, one character for one. */
export function toAsciiDigits(text: string): string {
  return text.replace(ARABIC_INDIC_DIGIT, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO);
  });
}

export function findPhoneSpans(text: string): PhoneSpan[] {
  return [...toAsciiDigits(text).matchAll(PHONE_SPAN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    digitGroups: match[0].match(DIGIT_GROUP) ?? [],
  }));
}

/** The E.164 form of a complete number; partial and invalid numbers give null. */
function completeNumber(text: string, country?: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(text, country);
  if (!parsed) return null;
  return parsed.isValid() || RESERVED_FICTIONAL_E164.test(parsed.number) ? parsed.number : null;
}

/**
 * International when written with + (or 00) or when the source marks it so; otherwise national with the given
 * country. No default country is ever assumed.
 */
export function normalizePhone(raw: string, hint: PhoneHint = {}): NormalizedPhone {
  const ascii = toAsciiDigits(raw).trim();
  const digits = ascii.replace(NON_DIGIT, '');
  const written = ascii.startsWith(INTERNATIONAL_PREFIX) ? `+${ascii.slice(INTERNATIONAL_PREFIX.length)}` : ascii;
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
