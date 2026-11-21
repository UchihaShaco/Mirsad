import { describe, expect, it } from 'vitest';
import { validateItem } from '../../src/domain/finding-validation.ts';
import type { Config } from '../../src/config.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';
import { ReviewerUnavailableError, type ExtractedItem } from '../../src/ports/reviewer.ts';
import { createDeterministicReviewer } from '../../src/review/deterministic-reviewer.ts';
import { createReviewer } from '../../src/review/reviewer-factory.ts';

const MESSAGE_ID = 'msg_00000000000000000000000000000001';

async function review(text: string): Promise<ExtractedItem[]> {
  const request = { reviewId: 'rev_1', chatId: 'chat_1', messageId: MESSAGE_ID, messageEventId: 'mev_1', source: 'telegram' as const, text };
  return (await createDeterministicReviewer().review(request, new AbortController().signal)).items;
}

const found = (kind: ExtractedItem['kind'], quote: string, extractedValue: string, concern: ExtractedItem['concern'] = null): ExtractedItem => ({
  sourceMessageId: MESSAGE_ID,
  kind,
  quote,
  extractedValue,
  concern,
  countryHint: null,
});

describe('deterministic reviewer', () => {
  it('reports a payment link in an English message with a payment cue, quoting its line', async () => {
    const text = 'Hello again.\nPlease settle the invoice at https://shop.test/orders/5 today.';
    expect(await review(text)).toEqual([
      found('payment_link', 'Please settle the invoice at https://shop.test/orders/5 today.', 'https://shop.test/orders/5'),
    ]);
  });

  it('reports a payment link in an Arabic message with an Arabic payment cue', async () => {
    const text = 'يرجى تحويل المبلغ عبر الرابط https://shop.test/o/9';
    expect(await review(text)).toEqual([found('payment_link', text, 'https://shop.test/o/9')]);
  });

  it('reports nothing for a greeting or for a link that is not about paying', async () => {
    expect(await review('Hello, are you free on Thursday?')).toEqual([]);
    expect(await review('مرحبا، كيف حالك؟')).toEqual([]);
    expect(await review('Our menu is here: https://cafe.test/menu')).toEqual([]);
  });

  it('ties a phone number to a payment request or a call-back request from the cues, and reports none without a cue', async () => {
    expect(await review('Transfer the money to 07700 900123 please')).toEqual([
      found('phone_number', 'Transfer the money to 07700 900123 please', '07700 900123', 'payment_request'),
    ]);
    expect(await review('Please call me on +44 7700 900456')).toEqual([
      found('phone_number', 'Please call me on +44 7700 900456', '+44 7700 900456', 'callback_request'),
    ]);
    expect(await review('حول المبلغ إلى ٠٧٧٠٠ ٩٠٠١٢٣')).toEqual([
      found('phone_number', 'حول المبلغ إلى ٠٧٧٠٠ ٩٠٠١٢٣', '٠٧٧٠٠ ٩٠٠١٢٣', 'payment_request'),
    ]);
    expect(await review('اتصل بي على +44 7700 900789')).toEqual([
      found('phone_number', 'اتصل بي على +44 7700 900789', '+44 7700 900789', 'callback_request'),
    ]);
    expect(await review('My old number was 07700 900111.')).toEqual([]);
  });

  it('reports a recipient named after a recipient marker and an IBAN-like token', async () => {
    expect(await review('Beneficiary: Test Trading LLC')).toEqual([
      found('payment_recipient', 'Beneficiary: Test Trading LLC', 'Test Trading LLC'),
    ]);
    expect(await review('المستفيد: شركة الاختبار')).toEqual([found('payment_recipient', 'المستفيد: شركة الاختبار', 'شركة الاختبار')]);
    expect(await review('Use GB82 TEST 1234 5698 7654 32 for the deposit')).toEqual([
      found('payment_recipient', 'Use GB82 TEST 1234 5698 7654 32 for the deposit', 'GB82 TEST 1234 5698 7654 32'),
    ]);
  });

  it('reads neither recipients nor phone numbers inside a link', async () => {
    const text = 'Pay at https://pay.shop.test/GB82TEST12345698765432/07700900123';
    expect(await review(text)).toEqual([found('payment_link', text, 'https://pay.shop.test/GB82TEST12345698765432/07700900123')]);
  });

  it('echoes the message id and reports only items that pass validation against the message', async () => {
    const text = 'Please pay the fee at https://pay.shop.test/inv/7.\nAccount name: Test Contact\nCall +44 7700 900321 when done (رسوم).';
    const items = await review(text);
    expect(items.map((i) => i.kind).sort()).toEqual(['payment_link', 'payment_recipient', 'phone_number']);
    for (const extracted of items) {
      expect(validateItem(extracted, { messageId: MESSAGE_ID, text }), extracted.kind).toMatchObject({ ok: true });
    }
  });
});

describe('reviewer factory', () => {
  const config = (reviewer: Config['reviewer']) => ({ reviewer }) as Config;
  const logger = createJsonLogger({ write: () => {} });
  const request = { reviewId: 'rev_1', chatId: 'chat_1', messageId: MESSAGE_ID, messageEventId: 'mev_1', source: 'telegram' as const, text: 'Hello' };

  it('builds the deterministic reviewer', async () => {
    const reviewer = createReviewer(config('deterministic'), logger);
    expect(reviewer.name).toBe('deterministic');
    expect(await reviewer.review({ ...request, text: 'Pay at https://pay.shop.test/x' }, new AbortController().signal)).toMatchObject({
      items: [{ kind: 'payment_link' }],
    });
  });

  it('builds a disabled reviewer that is always unavailable', async () => {
    const reviewer = createReviewer(config('disabled'), logger);
    const failure = reviewer.review(request, new AbortController().signal);
    await expect(failure).rejects.toBeInstanceOf(ReviewerUnavailableError);
    await expect(failure).rejects.toMatchObject({ code: 'reviewer_disabled' });
  });

  it('reports the LM Studio reviewer as not installed until its module lands', async () => {
    const reviewer = createReviewer(config('lmstudio'), logger);
    await expect(reviewer.review(request, new AbortController().signal)).rejects.toMatchObject({ code: 'reviewer_not_installed' });
  });
});
