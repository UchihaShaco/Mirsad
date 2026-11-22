/**
 * The reserved fictional phone ranges synthetic data may use (design section 13, fixtures/eval/README.md): Ofcom's
 * drama range +44 7700 900000-900999 and the North American +1 <area> 555 0100-0199. This is the one check that every
 * phone-like run in synthetic data is such a number. Fixture replay (validateFixture) and the held-out evaluation test
 * both use it, so neither can accept a number the other refuses.
 */
import { toAsciiDigits } from './phone.ts';

const MIN_PHONE_DIGITS = 7;
/** No-break and other Unicode spaces, and invisible direction marks, which can sit inside a written number. */
const SPACE_LIKE = /[\u00a0\u061c\u2000-\u200f\u202a-\u202f\u205f\u2066-\u2069\u3000\ufeff]/g;
/** Unicode hyphens and dashes, such as the non-breaking hyphen word processors put in phone numbers. */
const DASH_LIKE = /[\u2010-\u2015\u2212]/g;
/** IBANs such as GB33 TEST 4512 9876 5432 10: two letters, two check digits, then groups of four. */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
/** A run of digits joined by spaces, hyphens, dots or brackets, optionally led by + or (. */
const DIGIT_RUN = /(?<![\d+])(?:\+ *\(?|\()?\d[\d ().-]*\d/g;
const UK_INTERNATIONAL = /^447700900\d{3}$/;
const UK_NATIONAL = /^07700900\d{3}$/;
const NANP_INTERNATIONAL = /^1[2-9]\d{2}55501\d{2}$/;
/** A US number without + or 00: [1] area 555 01xx, or locally 555 01xx. The area code starts with 2-9. */
const NANP_WITHOUT_PREFIX = /^(?:1?[2-9]\d{2})?55501\d{2}$/;
/** Digit-group lengths of a US number without + or 00: (312) 555-0188, 1-312-555-0188, 3125550188, 555-0188. */
const NANP_LAYOUTS = ['3,3,4', '1,3,3,4', '10', '11', '3,4', '7'];

/**
 * Phone-like spans: every run of 7 or more digits outside an IBAN, whatever its prefix, layout or digit set, with ASCII
 * digits and plain spaces and hyphens. A longer run (two numbers joined by a space, say) is kept, so it fails rather
 * than hiding a number.
 */
export function phoneCandidates(text: string): string[] {
  const scanned = toAsciiDigits(text).replace(SPACE_LIKE, ' ').replace(DASH_LIKE, '-').replace(IBAN, ' ');
  return (scanned.match(DIGIT_RUN) ?? []).filter((span) => span.replace(/\D/g, '').length >= MIN_PHONE_DIGITS);
}

/** The digits after a + or 00 prefix, or null when the span has neither. */
function internationalDigits(span: string, digits: string): string | null {
  if (span.startsWith('+')) return digits;
  return digits.startsWith('00') ? digits.slice(2) : null;
}

/**
 * True when a phone-like span is a reserved number. A span starting with a single 0 can only be the UK range; a US
 * number without + or 00 must be laid out as one.
 */
export function isReservedPhone(span: string): boolean {
  const digits = span.replace(/\D/g, '');
  const international = internationalDigits(span, digits);
  if (international !== null) return UK_INTERNATIONAL.test(international) || NANP_INTERNATIONAL.test(international);
  if (digits.startsWith('0')) return UK_NATIONAL.test(digits);
  if (UK_INTERNATIONAL.test(digits)) return true;
  const layout = (span.match(/\d+/g) ?? []).map((group) => group.length).join(',');
  return NANP_LAYOUTS.includes(layout) && NANP_WITHOUT_PREFIX.test(digits);
}

/** The phone-like spans of `text` that are not reserved numbers. */
export function nonReservedPhones(text: string): string[] {
  return phoneCandidates(text).filter((span) => !isReservedPhone(span));
}
