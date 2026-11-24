import { describe, expect, it } from 'vitest';
import { sharedTelegramMaterial } from '../../src/services/telegram-reply-holds.ts';

describe('Telegram material supplied by a contact', () => {
  it('normalizes the payment destination and excludes an unrelated URL in the same sentence', () => {
    expect(sharedTelegramMaterial('Payment link: https://WWW.Synthetic.test/first and our catalogue: https://synthetic.test/second', [], 'm'))
      .toEqual([{ reason: 'payment_link', value: 'synthetic.test/first' }]);
  });

  it('treats venue and pin markers on a source as one location and keeps a map destination out of payment links', () => {
    const items = sharedTelegramMaterial('Payment link: https://maps.app.goo.gl/syntheticpin', ['venue', 'location'], 'm');
    expect(items.map(item => item.reason)).toEqual(['location']);
  });

  it('keeps bank wording in a URL or a quotation out of payment-recipient routing', () => {
    expect(sharedTelegramMaterial('Guide: https://synthetic.test/transfer-to-account-number-000000123456', [], 'm')).toEqual([]);
    expect(sharedTelegramMaterial('Someone showed me “للتحويل رقم حسابي هو ٠٠٠٠٠٠١٢٣٤٥٦”.', [], 'm')).toEqual([]);
  });
});
