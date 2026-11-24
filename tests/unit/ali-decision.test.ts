import { describe, expect, it } from 'vitest';
import { MODEL_SILENCE_REASONS, parseAliDecision, publicReplyFromDecision } from '../../src/replies/ali-decision.ts';
import { MINIMUM_DISTINCT_INDICATORS } from '../../src/replies/ali-prompt.ts';

const ordinary = { case_status: 'MONITORING', should_reply: true, external_reply: 'هلا والله', review_reasons: [], silence_reason: null };
const handoff = { case_status: 'READY_FOR_OFFICER_REVIEW', should_reply: false, external_reply: null, silence_reason: null,
  review_reasons: ['upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request'].slice(0, MINIMUM_DISTINCT_INDICATORS) };
const urgent = { ...handoff, case_status: 'HUMAN_INTERVENTION_REQUIRED', review_reasons: ['sensitive_request'] };
const parse = (value: unknown) => parseAliDecision(JSON.stringify(value));

describe('the shared live reply and handoff contract', () => {
  it('retains a suspicious assessment on both public and silent ordinary decisions', () => {
    expect(parse({ ...ordinary, case_status: 'SUSPICIOUS' })).toEqual({ kind: 'reply', text: ordinary.external_reply, higherConcern: true });
    expect(parse({ ...ordinary, case_status: 'SUSPICIOUS', should_reply: false, external_reply: null, silence_reason: 'other' }))
      .toEqual({ kind: 'silence', reason: 'other', higherConcern: true });
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
    if (reason !== 'other') expect(() => parse({ ...ordinary, external_reply: reason })).toThrow('invalid_response');
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
