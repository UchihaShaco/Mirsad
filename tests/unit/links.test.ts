import { describe, expect, it } from 'vitest';
import {
  detectPaymentLinks,
  extractUrlTokens,
  hostOfNormalizedLink,
  lineAt,
  maskUrls,
  normalizeHost,
  normalizeLink,
  normalizeTelegramLink,
  urlTokenOffset,
} from '../../src/domain/links.ts';

describe('normalizeHost', () => {
  it('reduces a URL to its host', () => {
    expect(normalizeHost('https://pay.merchant.test/checkout?order=7')).toBe('pay.merchant.test');
    expect(normalizeHost('http://pay.merchant.test')).toBe('pay.merchant.test');
  });

  it('drops the port', () => {
    expect(normalizeHost('pay.merchant.test:8443')).toBe('pay.merchant.test');
    expect(normalizeHost('https://pay.merchant.test:443/pay')).toBe('pay.merchant.test');
  });

  it('drops a leading www.', () => {
    expect(normalizeHost('www.merchant.test')).toBe('merchant.test');
    expect(normalizeHost('https://www.merchant.test/pay')).toBe('merchant.test');
  });

  it('lower-cases and converts to punycode', () => {
    expect(normalizeHost('PAY.Merchant.TEST')).toBe('pay.merchant.test');
    expect(normalizeHost('BÜCHER.test')).toBe('xn--bcher-kva.test');
  });

  it('drops a trailing dot', () => {
    expect(normalizeHost('merchant.test.')).toBe('merchant.test');
    expect(normalizeHost('https://WWW.Merchant.Test.:8080/x')).toBe('merchant.test');
  });

  it('returns null for input that does not parse to a dotted host name', () => {
    for (const input of ['', '   ', 'not a host', 'https://', 'localhost', 'merchant', 'test.', 'mailto:billing@merchant.test', 'javascript:alert(1)', 'ftp://files.merchant.test']) {
      expect(normalizeHost(input), input).toBeNull();
    }
  });
});

describe('normalizeLink', () => {
  it('normalizes the host and keeps path and query exactly as written, without the fragment', () => {
    expect(normalizeLink('https://WWW.Pay.Shop.TEST:8443/Inv/AbC9?Ref=X#top')).toBe('pay.shop.test/Inv/AbC9?Ref=X');
    expect(normalizeLink('https://pay.shop.test/فاتورة/7')).toBe('pay.shop.test/فاتورة/7');
  });

  it('treats a missing path as /, and a scheme-less link like an https one', () => {
    expect(normalizeLink('https://pay.shop.test')).toBe('pay.shop.test/');
    expect(normalizeLink('pay.shop.test/')).toBe('pay.shop.test/');
    expect(normalizeLink('https://pay.shop.test?x=1')).toBe('pay.shop.test/?x=1');
  });

  it('ignores sentence punctuation at the end of a link', () => {
    expect(normalizeLink('https://pay.shop.test/inv/7.')).toBe('pay.shop.test/inv/7');
    expect(normalizeLink('https://pay.shop.test/inv/7،')).toBe('pay.shop.test/inv/7');
  });

  it('keeps links that differ only in the case of their path apart', () => {
    expect(normalizeLink('https://pay.shop.test/inv/AbC9')).not.toBe(normalizeLink('https://pay.shop.test/inv/aBc9'));
  });

  it('returns null for a value that is not a web link', () => {
    expect(normalizeLink('https://localhost/pay')).toBeNull();
    expect(normalizeLink('mailto:billing@shop.test')).toBeNull();
    expect(normalizeLink('Test Trading LLC')).toBeNull();
  });

  it('exposes the host of a normalized link', () => {
    expect(hostOfNormalizedLink('pay.shop.test/inv/7?x=1')).toBe('pay.shop.test');
  });
});

describe('extractUrlTokens', () => {
  it('finds http, https and www. URLs as whole tokens without surrounding punctuation', () => {
    expect(extractUrlTokens('Pay at https://pay.shop.test/inv/7. Or www.shop.test/pay, thanks!')).toEqual([
      'https://pay.shop.test/inv/7',
      'www.shop.test/pay',
    ]);
  });

  it('splits tokens at whitespace, brackets and quotes', () => {
    expect(extractUrlTokens('(see "https://pay.shop.test/a") and <HTTP://Shop.test/B>\nhttps://pay.shop.test/c')).toEqual([
      'https://pay.shop.test/a',
      'HTTP://Shop.test/B',
      'https://pay.shop.test/c',
    ]);
  });

  it('ignores host-like words without a scheme or www., hosts without a dot, and repeats', () => {
    expect(extractUrlTokens('Visit shop.test or https://localhost/pay')).toEqual([]);
    expect(extractUrlTokens('https://pay.shop.test/a then https://pay.shop.test/a again')).toEqual(['https://pay.shop.test/a']);
  });

  it('recognizes explicit single-label destinations in Telegram and masks them during assessment', () => {
    const url = 'https://TestShop/order/42';
    expect(extractUrlTokens('Visit ' + url + '.', normalizeTelegramLink)).toEqual([url]);
    expect(normalizeTelegramLink(url + '#top')).toBe('testshop/order/42');
    expect(maskUrls(url, normalizeTelegramLink).trim()).toBe('');
    expect(extractUrlTokens('TestShop/order/42', normalizeTelegramLink)).toEqual([]);
  });
});

describe('quoting a line', () => {
  const text = '  Hello.\nPay at (https://pay.shop.test/a), thanks.  \nBye';

  it('lineAt returns the trimmed line holding an offset', () => {
    expect(lineAt(text, 0)).toBe('Hello.');
    expect(lineAt(text, text.indexOf('https'))).toBe('Pay at (https://pay.shop.test/a), thanks.');
    expect(lineAt(text, text.length - 1)).toBe('Bye');
  });

  it('urlTokenOffset finds where an extracted URL is written', () => {
    const [url] = extractUrlTokens(text);
    expect(text.slice(urlTokenOffset(text, url ?? ''))).toMatch(/^https:\/\/pay\.shop\.test\/a\)/);
  });
});

describe('detectPaymentLinks', () => {
  it('reports every URL in a message with an English or Arabic payment cue', () => {
    expect(detectPaymentLinks('Please settle the bill at https://shop.test/orders/5 or https://shop.test/menu')).toEqual([
      'https://shop.test/orders/5',
      'https://shop.test/menu',
    ]);
    expect(detectPaymentLinks('يرجى الدفع عبر https://shop.test/o/5')).toEqual(['https://shop.test/o/5']);
  });

  it('reports a URL whose host or path names pay, checkout, invoice or billing even without a cue', () => {
    expect(
      detectPaymentLinks('Here: https://shop.test/checkout/5 https://billing.shop.test/x https://shop.test/Invoice/1 https://shop.test/menu'),
    ).toEqual(['https://shop.test/checkout/5', 'https://billing.shop.test/x', 'https://shop.test/Invoice/1']);
  });

  it('ignores other URLs when the message has no cue, and words that merely contain a cue', () => {
    expect(detectPaymentLinks('The menu is at https://shop.test/menu')).toEqual([]);
    expect(detectPaymentLinks('I feel the coffee at https://cafe.test/menu is great')).toEqual([]);
    expect(detectPaymentLinks('Our news feed is at https://cafe.test/news')).toEqual([]);
  });

  it('reads the -ed and -ing forms of the English payment cues as cues', () => {
    expect(detectPaymentLinks('Once paid, keep paying via https://secure.shop.test/p')).toEqual(['https://secure.shop.test/p']);
    for (const word of ['paid', 'paying', 'transferred', 'transferring', 'invoiced', 'invoicing', 'deposited', 'depositing', 'settled', 'settling', 'remitted', 'remitting']) {
      expect(detectPaymentLinks(`Amount ${word} at https://secure.shop.test/p`), word).toEqual(['https://secure.shop.test/p']);
    }
  });

  it('does not read the Arabic word for "about" as a payment cue', () => {
    expect(detectPaymentLinks('عندي سؤال حول الحجز https://maps.shop.test/place/1')).toEqual([]);
  });
});
