/**
 * The dashboard's Record merchant confirmation form (src/dashboard/js/state/case-reference.js). The form only shapes
 * the request for POST /v1/chats/{chatId}/case-references; the service normalizes and validates the hosts and decides
 * which payment links conflict with the confirmation.
 */
import { describe, expect, it } from 'vitest';
import { CaseReferenceRequest } from '../../src/contract/schemas.ts';
import { caseReferenceRequest, initialCaseReferenceDraft, parsePaymentHosts } from '../../src/dashboard/js/state/case-reference.js';

const NOTE = 'The merchant confirmed its payment page by phone.';

describe('merchant confirmation form', () => {
  it('payment hosts are separated by commas or line breaks, trimmed, without blanks or repeats', () => {
    const written = ' pay.merchant.test,shop.merchant.test\npay.merchant.test\r\n\n , https://checkout.merchant.test/pay ';
    expect(parsePaymentHosts(written)).toEqual(['pay.merchant.test', 'shop.merchant.test', 'https://checkout.merchant.test/pay']);
    expect(parsePaymentHosts(' , \n ')).toEqual([]);
  });

  it('a complete draft makes one request the contract accepts: one to twenty hosts and a source note of 3 to 500 characters', () => {
    expect(initialCaseReferenceDraft()).toEqual({ hosts: '', note: '' });
    const request = caseReferenceRequest({ hosts: 'pay.merchant.test,\nshop.merchant.test', note: `  ${NOTE}  ` });
    expect(request).toEqual({ kind: 'merchant_payment_confirmation', paymentHosts: ['pay.merchant.test', 'shop.merchant.test'], sourceNote: NOTE });
    expect(CaseReferenceRequest.safeParse(request).success).toBe(true);

    expect(caseReferenceRequest(initialCaseReferenceDraft())).toBeNull();
    expect(caseReferenceRequest({ hosts: ' , ', note: NOTE })).toBeNull();
    expect(caseReferenceRequest({ hosts: 'pay.merchant.test', note: ' ok ' })).toBeNull();
    expect(caseReferenceRequest({ hosts: 'pay.merchant.test', note: 'x'.repeat(501) })).toBeNull();
    const twentyOne = Array.from({ length: 21 }, (_, index) => `pay${index}.merchant.test`).join(',');
    expect(caseReferenceRequest({ hosts: twentyOne, note: NOTE })).toBeNull();
    const twenty = Array.from({ length: 20 }, (_, index) => `pay${index}.merchant.test`).join('\n');
    expect(caseReferenceRequest({ hosts: twenty, note: NOTE })?.paymentHosts).toHaveLength(20);
  });
});
