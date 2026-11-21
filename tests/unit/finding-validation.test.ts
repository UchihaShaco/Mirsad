import { describe, expect, it } from 'vitest';
import { validateItem } from '../../src/domain/finding-validation.ts';
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
    const link = item({ quote: 'pay at HTTPS://WWW.Pay.Shop.TEST:8443/Inv/AbC9?Ref=X', extractedValue: 'HTTPS://WWW.Pay.Shop.TEST:8443/Inv/AbC9?Ref=X' });
    expect(validateItem(link, record(text))).toEqual({ ok: true, normalizedValue: 'pay.shop.test/Inv/AbC9?Ref=X' });
  });

  it('accepts a link followed by trailing punctuation in the quote, with or without that punctuation', () => {
    const text = 'Pay here: https://pay.shop.test/inv/7. Thanks';
    for (const extractedValue of ['https://pay.shop.test/inv/7', 'https://pay.shop.test/inv/7.']) {
      const link = item({ quote: 'Pay here: https://pay.shop.test/inv/7.', extractedValue });
      expect(validateItem(link, record(text)), extractedValue).toEqual({ ok: true, normalizedValue: 'pay.shop.test/inv/7' });
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
  it('accepts a phone whose digits equal a phone-like span of the quote, with Arabic-Indic digits on either side', () => {
    const arabic = 'حول المبلغ إلى ٠٧٧٠٠ ٩٠٠١٢٣ اليوم';
    const phone = (extractedValue: string, countryHint: string | null = 'GB') =>
      item({ kind: 'phone_number', quote: arabic, extractedValue, concern: 'payment_request', countryHint });
    expect(validateItem(phone('07700 900123'), record(arabic))).toEqual({ ok: true, normalizedValue: '+447700900123' });
    expect(validateItem(phone('٠٧٧٠٠ ٩٠٠١٢٣'), record(arabic))).toEqual({ ok: true, normalizedValue: '+447700900123' });
    const ascii = 'Call +44 7700 900123 now';
    const international = item({ kind: 'phone_number', quote: ascii, extractedValue: '+447700900123', concern: 'callback_request' });
    expect(validateItem(international, record(ascii))).toEqual({ ok: true, normalizedValue: '+447700900123' });
  });

  it('keeps a number that cannot be normalized as unnormalized digits', () => {
    const text = 'Call 07700 900123 now';
    const phone = item({ kind: 'phone_number', quote: text, extractedValue: '07700 900123', concern: 'callback_request' });
    expect(validateItem(phone, record(text))).toEqual({ ok: true, normalizedValue: 'unnormalized:07700900123' });
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
      expect(validateItem(phone, record(text)), extractedValue).toEqual({ ok: true, normalizedValue });
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

  it('accepts a recipient that appears in the quote ignoring case and repeated spaces, normalized to lower case and single spaces', () => {
    const recipient = item({ kind: 'payment_recipient', quote: 'Beneficiary:  Test   Trading LLC', extractedValue: ' test trading  LLC ' });
    expect(validateItem(recipient, record(text))).toEqual({ ok: true, normalizedValue: 'test trading llc' });
  });

  it('rejects a recipient the quote does not contain', () => {
    const recipient = item({ kind: 'payment_recipient', quote: 'Beneficiary:  Test   Trading LLC', extractedValue: 'Other Holdings' });
    expect(validateItem(recipient, record(text))).toEqual({ ok: false, reason: 'value_not_in_quote' });
  });
});
