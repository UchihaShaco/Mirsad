import { describe, expect, it } from 'vitest';
import { acceptValidatedItems, normalizePhoneValue, validateItem } from '../../src/domain/finding-validation.ts';
import type { ExtractedItem } from '../../src/ports/reviewer.ts';

const MESSAGE_ID = 'msg_00000000000000000000000000000001';

function item(over: Partial<ExtractedItem>): ExtractedItem {
  return { sourceMessageId: MESSAGE_ID, kind: 'payment_link', quote: '', extractedValue: '', concern: null, countryHint: null, ...over };
}

const record = (text: string) => ({ messageId: MESSAGE_ID, text });

describe('validateItem: every kind', () => {
  const text = 'Please pay at https://pay.shop.test/inv/7 today.';

  it('rejects an item that names another message', () => {
    const other = item({ sourceMessageId: 'msg_00000000000000000000000000000002', quote: text, extractedValue: 'https://pay.shop.test/inv/7' });
    expect(validateItem(other, record(text))).toEqual({ ok: false, reason: 'wrong_message' });
  });

  it('rejects an empty or blank quote or value', () => {
    expect(validateItem(item({ quote: '', extractedValue: 'https://pay.shop.test/inv/7' }), record(text))).toEqual({ ok: false, reason: 'empty' });
    expect(validateItem(item({ quote: text, extractedValue: '   ' }), record(text))).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a quote that is not an exact substring of the text', () => {
    const changedCase = item({ quote: 'please pay at https://pay.shop.test/inv/7', extractedValue: 'https://pay.shop.test/inv/7' });
    expect(validateItem(changedCase, record(text))).toEqual({ ok: false, reason: 'quote_not_found' });
    const invented = item({ quote: 'Pay at https://pay.shop.test/inv/8', extractedValue: 'https://pay.shop.test/inv/8' });
    expect(validateItem(invented, record(text))).toEqual({ ok: false, reason: 'quote_not_found' });
  });

  it('checks the quote against the text it is given, such as an edit, and not the original message', () => {
    const fromOriginal = item({ quote: 'Pay at https://pay.old.test/a', extractedValue: 'https://pay.old.test/a' });
    expect(validateItem(fromOriginal, record('Sorry, use https://pay.new.test/b instead.'))).toEqual({ ok: false, reason: 'quote_not_found' });
  });
});

describe('validateItem: payment links', () => {
  it('accepts a link that is a whole token of the quote and normalizes host, path and query', () => {
    const text = 'Please pay at HTTPS://WWW.Pay.Shop.TEST:8443/Inv/AbC9?Ref=X today.';
    const value = 'HTTPS://WWW.Pay.Shop.TEST:8443/Inv/AbC9?Ref=X';
    const link = item({ quote: `pay at ${value}`, extractedValue: value });
    expect(validateItem(link, record(text))).toEqual({ ok: true, normalizedValue: 'pay.shop.test/Inv/AbC9?Ref=X', writtenValue: value });
  });

  it('accepts a link followed by trailing punctuation in the quote, with or without that punctuation', () => {
    const text = 'Pay here: https://pay.shop.test/inv/7. Thanks';
    for (const extractedValue of ['https://pay.shop.test/inv/7', 'https://pay.shop.test/inv/7.']) {
      const link = item({ quote: 'Pay here: https://pay.shop.test/inv/7.', extractedValue });
      expect(validateItem(link, record(text)), extractedValue).toEqual({ ok: true, normalizedValue: 'pay.shop.test/inv/7', writtenValue: extractedValue });
    }
    const bracketed = item({ quote: '(https://pay.shop.test/inv/7)', extractedValue: 'https://pay.shop.test/inv/7' });
    expect(validateItem(bracketed, record('Link (https://pay.shop.test/inv/7) here'))).toMatchObject({ ok: true });
  });

  it('rejects a value that is only a fragment of a URL in the quote', () => {
    const text = 'Pay here https://pay.evil.test/p?ref=pay.merchant.test now';
    for (const extractedValue of ['pay.merchant.test', 'https://pay.evil.test/p', 'https://pay.evil.test', 'evil.test']) {
      const fragment = item({ quote: text, extractedValue });
      expect(validateItem(fragment, record(text)), extractedValue).toEqual({ ok: false, reason: 'value_not_in_quote' });
    }
  });

  it('rejects a whole token that does not parse to a dotted host', () => {
    const text = 'Open https://localhost/pay or Test now';
    expect(validateItem(item({ quote: text, extractedValue: 'https://localhost/pay' }), record(text))).toEqual({ ok: false, reason: 'value_not_in_quote' });
    expect(validateItem(item({ quote: text, extractedValue: 'Test' }), record(text))).toEqual({ ok: false, reason: 'value_not_in_quote' });
  });
});

describe('validateItem: phone numbers', () => {
  it('accepts a phone whose digits equal a phone-like span of the quote, with Arabic-Indic digits on either side, and keeps the digits the message wrote', () => {
    const arabic = 'حول المبلغ إلى ٠٧٧٠٠ ٩٠٠١٢٣ اليوم';
    const phone = (extractedValue: string, countryHint: string | null = 'GB') =>
      item({ kind: 'phone_number', quote: arabic, extractedValue, concern: 'payment_request', countryHint });
    const asWritten = { ok: true, normalizedValue: '+447700900123', writtenValue: '٠٧٧٠٠ ٩٠٠١٢٣' };
    expect(validateItem(phone('07700 900123'), record(arabic))).toEqual(asWritten);
    expect(validateItem(phone('٠٧٧٠٠ ٩٠٠١٢٣'), record(arabic))).toEqual(asWritten);
    const ascii = 'Call +44 7700 900123 now';
    const international = item({ kind: 'phone_number', quote: ascii, extractedValue: '+447700900123', concern: 'callback_request' });
    expect(validateItem(international, record(ascii))).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '+44 7700 900123' });
  });

  it('normalizes a number the message writes with a direction mark or a thin space between its groups, from a clean reviewer value', () => {
    const phone = (text: string) =>
      validateItem(item({ kind: 'phone_number', quote: text, extractedValue: '07700 900123', concern: 'payment_request', countryHint: 'GB' }), record(text));
    // A right-to-left mark after a number is common in Arabic text.
    expect(phone('حول المبلغ إلى ٠٧٧٠٠‏ ٩٠٠١٢٣ اليوم')).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '٠٧٧٠٠‏ ٩٠٠١٢٣' });
    expect(phone('Call 07700‏ 900123 now')).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '07700‏ 900123' });
    expect(phone('Call 07700 900123 now')).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '07700 900123' });
  });

  it('keeps a number that cannot be normalized as unnormalized digits', () => {
    const text = 'Call 07700 900123 now';
    const phone = item({ kind: 'phone_number', quote: text, extractedValue: '07700 900123', concern: 'callback_request' });
    expect(validateItem(phone, record(text))).toEqual({ ok: true, normalizedValue: 'unnormalized:07700900123', writtenValue: '07700 900123' });
  });

  it('rejects a phone value that carries anything besides digits, spaces, a plus sign, brackets, dots and hyphens', () => {
    const text = 'Call 07700 900123 now';
    for (const extractedValue of ['Officer Smith informant 07700 900123 CALL NOW', '07700 900123 (WhatsApp)', 'https://evil.example/x?u=07700900123', 'tel:07700900123']) {
      const phone = item({ kind: 'phone_number', quote: text, extractedValue, concern: 'callback_request', countryHint: 'GB' });
      expect(validateItem(phone, record(text)), extractedValue).toEqual({ ok: false, reason: 'value_not_in_quote' });
    }
  });

  it('stores and normalizes a phone as the message wrote it, whatever the reviewer added, dropped or reformatted', () => {
    const phone = (text: string, extractedValue: string, countryHint: string | null) =>
      validateItem(item({ kind: 'phone_number', quote: text, extractedValue, concern: 'callback_request', countryHint }), record(text));
    // A plus sign the reviewer added does not turn a national number into an unparseable international one.
    expect(phone('Call 07700 900123 now', '+07700 900123', 'GB')).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '07700 900123' });
    // A plus sign the reviewer dropped is still read from the message.
    expect(phone('Call +44 7700 900123 now', '44 7700 900123', null)).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '+44 7700 900123' });
    expect(phone('Ring (07700) 900123 today', '07700900123', 'GB')).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '(07700) 900123' });
    expect(phone('Ring (07700 900123) today', '07700 900123', 'GB')).toEqual({ ok: true, normalizedValue: '+447700900123', writtenValue: '(07700 900123)' });
    expect(phone('Call 07700 900123 07700 900456 now', '07700-900456', 'GB')).toEqual({ ok: true, normalizedValue: '+447700900456', writtenValue: '07700 900456' });
  });

  it('rejects a phone whose digits are neither a whole phone-like span of the quote nor one of several complete numbers it divides into', () => {
    const text = 'Call +44 7700 900123 now';
    // 7700 900123 is whole digit groups of the span, but the 44 left over is no number of its own.
    for (const extractedValue of ['+44 7700 900124', '7700 900123', '7700 9001', '0123', 'no digits']) {
      const phone = item({ kind: 'phone_number', quote: text, extractedValue, concern: 'callback_request' });
      expect(validateItem(phone, record(text)), extractedValue).toEqual({ ok: false, reason: 'value_not_in_quote' });
    }
  });

  it('accepts one of several complete numbers written one after the other in a single phone-like span', () => {
    const text = 'Call 07700 900123 07700 900456 now';
    for (const [extractedValue, normalizedValue] of [['07700 900123', '+447700900123'], ['07700 900456', '+447700900456']] as const) {
      const phone = item({ kind: 'phone_number', quote: text, extractedValue, concern: 'callback_request', countryHint: 'GB' });
      expect(validateItem(phone, record(text)), extractedValue).toEqual({ ok: true, normalizedValue, writtenValue: extractedValue });
    }
  });

  it('never reads a date as a phone number', () => {
    const text = 'Please pay by 2026-11-05 or 05.11.2026 at the latest';
    for (const extractedValue of ['2026-11-05', '05.11.2026', '20261105']) {
      const phone = item({ kind: 'phone_number', quote: text, extractedValue, concern: 'payment_request' });
      expect(validateItem(phone, record(text)), extractedValue).toEqual({ ok: false, reason: 'value_not_in_quote' });
    }
  });
});

describe('validateItem: payment recipients', () => {
  const text = 'Beneficiary:  Test   Trading LLC\nThanks';

  it('accepts a recipient that appears in the quote ignoring case and repeated spaces, normalized to lower case and single spaces, and keeps it as the message wrote it', () => {
    const recipient = item({ kind: 'payment_recipient', quote: 'Beneficiary:  Test   Trading LLC', extractedValue: ' test trading  LLC ' });
    expect(validateItem(recipient, record(text))).toEqual({ ok: true, normalizedValue: 'test trading llc', writtenValue: 'Test   Trading LLC' });
    const arabic = 'المستفيد: شركة الاختبار للتجارة';
    const name = item({ kind: 'payment_recipient', quote: arabic, extractedValue: 'شركة  الاختبار للتجارة' });
    expect(validateItem(name, record(arabic))).toEqual({ ok: true, normalizedValue: 'شركة الاختبار للتجارة', writtenValue: 'شركة الاختبار للتجارة' });
  });

  it('rejects a recipient the quote does not contain', () => {
    const recipient = item({ kind: 'payment_recipient', quote: 'Beneficiary:  Test   Trading LLC', extractedValue: 'Other Holdings' });
    expect(validateItem(recipient, record(text))).toEqual({ ok: false, reason: 'value_not_in_quote' });
  });
});

describe('acceptValidatedItems: what the review pipeline and the evaluation act on', () => {
  it('keeps the first supported item per kind and normalized value, drops a phone number without a concern and counts rejected items as unsupported', () => {
    const text = 'Pay at https://pay.shop.test/inv/7. Call 07700 900123 to confirm, not the old desk on 07700 900456.';
    const sentence = 'Pay at https://pay.shop.test/inv/7.';
    const link = item({ quote: sentence, extractedValue: 'https://pay.shop.test/inv/7' });
    const sameLink = item({ quote: sentence, extractedValue: 'https://pay.shop.test/inv/7.' });
    // The same normalized value under another kind is another detail.
    const linkAsRecipient = item({ kind: 'payment_recipient', quote: sentence, extractedValue: 'pay.shop.test/inv/7' });
    const phone = item({ kind: 'phone_number', quote: 'Call 07700 900123 to confirm', extractedValue: '07700 900123', concern: 'callback_request', countryHint: 'GB' });
    const noConcern = item({ kind: 'phone_number', quote: 'the old desk on 07700 900456', extractedValue: '07700 900456', countryHint: 'GB' });
    const invented = item({ quote: 'Pay at https://pay.other.test/x', extractedValue: 'https://pay.other.test/x' });
    const otherMessage = { ...link, sourceMessageId: 'msg_00000000000000000000000000000002' };

    const result = acceptValidatedItems([link, invented, sameLink, phone, noConcern, otherMessage, linkAsRecipient], record(text));

    expect(result).toEqual({
      accepted: [
        { item: link, normalizedValue: 'pay.shop.test/inv/7', writtenValue: 'https://pay.shop.test/inv/7' },
        { item: phone, normalizedValue: '+447700900123', writtenValue: '07700 900123' },
        { item: linkAsRecipient, normalizedValue: 'pay.shop.test/inv/7', writtenValue: 'pay.shop.test/inv/7' },
      ],
      unsupported: 2,
    });
  });

  it('normalizes a phone number as validation does: E.164 with the country hint, else its digits marked unnormalized', () => {
    expect(normalizePhoneValue('07700 900123', 'GB')).toBe('+447700900123');
    expect(normalizePhoneValue('+44 7700 900123', null)).toBe('+447700900123');
    expect(normalizePhoneValue('07700 900123', null)).toBe('unnormalized:07700900123');
  });
});
