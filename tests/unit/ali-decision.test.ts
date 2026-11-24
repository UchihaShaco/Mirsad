import { describe, expect, it } from 'vitest';
import {
  ALI_RESPONSE_FORMAT, MAX_SILENCE_EXPLANATION_CHARS, MODEL_SILENCE_REASONS, officerSilenceExplanation, parseAliDecision, parseAliPublicReply,
  publicReplyFromDecision,
} from '../../src/replies/ali-decision.ts';
import { MINIMUM_DISTINCT_INDICATORS } from '../../src/replies/ali-prompt.ts';

const ordinary = { case_status: 'MONITORING', should_reply: true, external_reply: 'هلا والله', review_reasons: [], silence_reason: null };
const handoff = { case_status: 'READY_FOR_OFFICER_REVIEW', should_reply: false, external_reply: null, silence_reason: null,
  review_reasons: ['upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request'].slice(0, MINIMUM_DISTINCT_INDICATORS) };
const urgent = { ...handoff, case_status: 'HUMAN_INTERVENTION_REQUIRED', review_reasons: ['sensitive_request'] };
const parse = (value: unknown) => parseAliDecision(JSON.stringify(value));

describe('the shared live reply and handoff contract', () => {
  it('accepts only public chat text when composition follows a private assessment', () => {
    expect(parseAliPublicReply(JSON.stringify({ external_reply: '  كم عرض الرف؟  ' }))).toBe('كم عرض الرف؟');
    for (const invalid of [
      ordinary, urgent, { external_reply: null }, { external_reply: ' ' },
      { external_reply: 'How tall is it?', case_status: 'MONITORING' }, { external_reply: 'HUMAN_INTERVENTION_REQUIRED' },
      { external_reply: '[NO_REPLY]' }, { external_reply: 'a'.repeat(1_001) },
    ]) {
      expect(() => parseAliPublicReply(JSON.stringify(invalid))).toThrow('invalid_response');
    }
  });

  it('retains a suspicious assessment on both public and silent ordinary decisions', () => {
    expect(parse({ ...ordinary, case_status: 'SUSPICIOUS' })).toEqual({ kind: 'reply', text: ordinary.external_reply, higherConcern: true });
    expect(parse({ ...ordinary, case_status: 'SUSPICIOUS', should_reply: false, external_reply: null, silence_reason: 'no_safe_follow_up',
      silence_explanation: 'Any question now would push the sender towards the deposit.' }))
      .toEqual({ kind: 'silence', reason: 'no_safe_follow_up', explanation: 'Any question now would push the sender towards the deposit.', higherConcern: true });
    expect(parse(ordinary)).toEqual({ kind: 'reply', text: ordinary.external_reply });
    for (const key of ['meeting_arranged', 'meeting_day_confirmed', 'repeated_meeting_question']) {
      expect(() => parse({ ...ordinary, external_reply: `Discuss ${key} please.` })).toThrow('invalid_response');
    }
  });
  it('returns only the validated public draft to a chat-text caller', () => {
    expect(publicReplyFromDecision(parse(ordinary))).toBe('هلا والله');
    for (const decision of [handoff, urgent]) {
      expect(parse(decision)).toEqual({ kind: 'review', status: decision.case_status, reasons: decision.review_reasons });
      expect(publicReplyFromDecision(parse(decision))).toBeNull();
    }
    expect(publicReplyFromDecision(parse({ ...ordinary, external_reply: 'What other sizes are there?' }))).toBe('What other sizes are there?');
    expect(publicReplyFromDecision(parse({ ...ordinary, external_reply: 'Other' }))).toBe('Other');
  });

  it.each(MODEL_SILENCE_REASONS)('keeps %s on internal silence decisions only', reason => {
    const silence = parse({ ...ordinary, should_reply: false, external_reply: null, silence_reason: reason });
    expect(silence).toEqual({ kind: 'silence', reason });
    expect(publicReplyFromDecision(silence)).toBeNull();
    expect(() => parse({ ...ordinary, external_reply: reason })).toThrow('invalid_response');
  });

  describe('why Ali stays silent', () => {
    const silent = { ...ordinary, should_reply: false, external_reply: null, silence_reason: 'already_answered' };

    it('offers the model only specific reasons and asks it for an explanation', () => {
      expect(MODEL_SILENCE_REASONS).not.toContain('other');
      expect(() => parse({ ...silent, silence_reason: 'other' })).toThrow('invalid_response');
      const { schema } = ALI_RESPONSE_FORMAT.json_schema;
      expect(schema.required).toContain('silence_explanation');
      expect(schema.properties.silence_explanation).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    });

    it('keeps the explanation with the silence and ignores one sent with a reply', () => {
      const explanation = 'Ali asked about the warranty and the sender only repeated the price.';
      expect(parse({ ...silent, silence_explanation: `  “${explanation}”  ` })).toEqual({ kind: 'silence', reason: 'already_answered', explanation });
      expect(parse({ ...ordinary, silence_explanation: explanation })).toEqual({ kind: 'reply', text: ordinary.external_reply });
      expect(parse({ ...silent, silence_explanation: null })).toEqual({ kind: 'silence', reason: 'already_answered' });
      expect(parse({ ...silent, silence_explanation: ' ok ' })).toEqual({ kind: 'silence', reason: 'already_answered' });
      expect(() => parse({ ...silent, silence_explanation: 42 })).toThrow('invalid_response');
    });

    it('masks links, addresses, handles and long numbers and keeps the explanation to one short line', () => {
      expect(officerSilenceExplanation('The sender gave account 0000 0001 2345 6 and https://pay.example.test/x to pay.'))
        .toBe('The sender gave account [number] and [link] to pay.');
      expect(officerSilenceExplanation('They asked Ali to call +44 7700 900123 or write to seller@example.test or @seller_test.'))
        .toBe('They asked Ali to call [number] or write to [email] or [handle].');
      expect(officerSilenceExplanation('The page pay.example.test/checkout?ref=7 asks for a deposit, e.g. today.'))
        .toBe('The page [link] asks for a deposit, e.g. today.');
      expect(officerSilenceExplanation('The price of 1,450 AED in 2019\nwas\u202e already answered_twice.'))
        .toBe('The price of 1,450 AED in 2019 was already answered twice.');
      const long = officerSilenceExplanation('The sender repeated the same offer again. '.repeat(20))!;
      expect(long.length).toBeLessThanOrEqual(MAX_SILENCE_EXPLANATION_CHARS);
      expect(long.endsWith('…')).toBe(true);
      expect(officerSilenceExplanation('[link] 👍')).toBeUndefined();
    });
  });

  it('accepts only the constrained payment-link citation and keeps it from text-only callers', () => {
    const candidate = { candidate_id: 1, reason: 'unverified_payment_request' };
    const decision = parse({ ...ordinary, payment_link_review: candidate });
    expect(decision).toMatchObject({ paymentLinkReview: { candidateId: 1, reason: candidate.reason } });
    expect(publicReplyFromDecision(decision)).toBeNull();
    expect(publicReplyFromDecision(parse({ ...ordinary, payment_link_review: null }))).toBe(ordinary.external_reply);
    for (const invalid of [{ ...candidate, candidate_id: 0 }, { ...candidate, reason: 'other' }, { ...candidate, url: 'https://example.test/' }]) {
      expect(() => parse({ ...ordinary, payment_link_review: invalid })).toThrow('invalid_response');
    }
    expect(() => parse({ ...ordinary, external_reply: 'The candidate_id in the officer_brief is 1.' })).toThrow('invalid_response');
  });

  it.each([
    { ...ordinary, should_reply: false },
    { ...ordinary, silence_reason: undefined },
    { ...ordinary, silence_reason: 'already_answered' },
    { ...ordinary, should_reply: false, external_reply: null },
    { ...ordinary, should_reply: false, external_reply: null, silence_reason: 'a private explanation' },
    { ...ordinary, should_reply: false, external_reply: null, silence_reason: 'reason_unavailable' },
    { ...ordinary, should_reply: false, external_reply: null, silence_reason: 'other' },
    { ...ordinary, external_reply: 'The silence_explanation is private.' },
    { ...handoff, silence_reason: 'conversation_closed' },
    { ...ordinary, external_reply: 'The silence_reason is other.' },
    { ...ordinary, external_reply: '   ' },
    { ...ordinary, case_status: 'INSUFFICIENT_FRAUD_INDICATORS' },
    { ...ordinary, officer_handover_report: 'private synthetic data' },
    { ...ordinary, external_reply: 'Hello! {"case_status":"MONITORING"}' },
    { ...ordinary, external_reply: 'HUMAN_INTERVENTION_REQUIRED' },
    { ...ordinary, external_reply: 'previous_draft_blocked_by' },
    { ...ordinary, external_reply: '<think>review first</think> Hello.' },
    { ...ordinary, external_reply: '[NO_REPLY]' },
    { ...ordinary, external_reply: 'a'.repeat(1001) },
    { ...ordinary, review_reasons: ['upfront_fee'] },
    { ...handoff, review_reasons: ['upfront_fee'] },
    { ...handoff, review_reasons: ['upfront_fee', 'upfront_fee'] },
    { ...handoff, review_reasons: ['unknown'] },
    { ...handoff, should_reply: true, external_reply: 'One more question.' },
    { ...urgent, review_reasons: [] },
    { ...urgent, review_reasons: ['upfront_fee'] },
  ])('rejects inconsistent or private output %#', value => {
    expect(() => parse(value)).toThrow('invalid_response');
  });
});
