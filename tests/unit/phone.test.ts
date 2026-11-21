import { describe, expect, it } from 'vitest';
import { findPhoneSpans, normalizePhone, toAsciiDigits, watchlistMatchKey } from '../../src/domain/phone.ts';

describe('normalizePhone', () => {
  it('normalizes an international number written with + to E.164 and keeps its digits', () => {
    expect(normalizePhone('+44 7700 900123')).toEqual({ e164: '+447700900123', digits: '447700900123' });
    expect(normalizePhone('+1 (202) 555-0123')).toEqual({ e164: '+12025550123', digits: '12025550123' });
  });

  it('accepts the reserved fictional UK range, which the phone metadata does not list as valid', () => {
    expect(normalizePhone('+44 7700 900000').e164).toBe('+447700900000');
    expect(normalizePhone('+44 7700 900999').e164).toBe('+447700900999');
  });

  it('rewrites a leading 00 to + before parsing', () => {
    expect(normalizePhone('0044 7700 900123')).toEqual({ e164: '+447700900123', digits: '00447700900123' });
    expect(normalizePhone('001 202 555 0199').e164).toBe('+12025550199');
  });

  it('parses a national number only with a country hint and never assumes a default country', () => {
    expect(normalizePhone('07700 900123')).toEqual({ e164: null, digits: '07700900123' });
    expect(normalizePhone('07700 900123', { country: 'GB' }).e164).toBe('+447700900123');
    expect(normalizePhone('(202) 555-0123', { country: 'US' }).e164).toBe('+12025550123');
    expect(normalizePhone('202 555 0123').e164).toBeNull();
  });

  it('parses a number the source marks as international as international, even without + and whatever the country hint', () => {
    expect(normalizePhone('447700900123', { internationalFormat: true }).e164).toBe('+447700900123');
    expect(normalizePhone('447700900123').e164).toBeNull();
    expect(normalizePhone('12025550123', { internationalFormat: true, country: 'GB' }).e164).toBe('+12025550123');
  });

  it('maps Arabic-Indic and Extended Arabic-Indic digits to ASCII', () => {
    expect(normalizePhone('+٤٤ ٧٧٠٠ ٩٠٠١٢٣')).toEqual({ e164: '+447700900123', digits: '447700900123' });
    expect(normalizePhone('۰۷۷۰۰ ۹۰۰۱۲۳', { country: 'GB' })).toEqual({ e164: '+447700900123', digits: '07700900123' });
  });

  it('keeps invalid, partial or unparsable input unnormalized', () => {
    expect(normalizePhone('+44 7700 9001')).toEqual({ e164: null, digits: '4477009001' });
    expect(normalizePhone('+1 555')).toEqual({ e164: null, digits: '1555' });
    expect(normalizePhone('call me later')).toEqual({ e164: null, digits: '' });
    expect(normalizePhone('07700 900123', { country: 'XX' }).e164).toBeNull();
    expect(normalizePhone('07700 900123', { country: 'gb' }).e164).toBeNull();
  });
});

describe('watchlistMatchKey', () => {
  it('is the E.164 form of a normalized number, whichever chat mentioned it', () => {
    const number = { e164: '+447700900123', digits: '447700900123' };
    expect(watchlistMatchKey(number, 'chat_a')).toBe('+447700900123');
    expect(watchlistMatchKey(number, 'chat_b')).toBe('+447700900123');
  });

  it('ties an unnormalized number to the chat that mentioned it', () => {
    const number = { e164: null, digits: '07700900123' };
    expect(watchlistMatchKey(number, 'chat_a')).toBe('unnormalized:chat_a:07700900123');
    expect(watchlistMatchKey(number, 'chat_b')).toBe('unnormalized:chat_b:07700900123');
  });
});

describe('phone-like spans', () => {
  it('maps Arabic-Indic digits one for one, so positions in the text stay the same', () => {
    expect(toAsciiDigits('رقم ٠٧٧٠٠ ۹۰۰۱۲۳')).toBe('رقم 07700 900123');
  });

  it('finds runs of digits joined by spaces, dots, hyphens and brackets, with an optional leading +', () => {
    const text = 'Call (+44) 7700-900123 or 07700 900456 on 21.11.';
    expect(findPhoneSpans(text).map((span) => [text.slice(span.start, span.end), span.digitGroups])).toEqual([
      ['+44) 7700-900123', ['44', '7700', '900123']],
      ['07700 900456', ['07700', '900456']],
      ['21.11', ['21', '11']],
    ]);
  });

  it('never reads a calendar date as phone-like, with the year first or last, so a number next to one stands alone', () => {
    const text = 'Due 2026-11-05, 05.11.2026 or ١١-٠٥-٢٠٢٦; from 2026-11-05 07700 900123';
    expect(findPhoneSpans(text).map((span) => [text.slice(span.start, span.end), span.digitGroups])).toEqual([
      ['07700 900123', ['07700', '900123']],
    ]);
  });
});
