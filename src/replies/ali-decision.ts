import { z } from 'zod';
import { MINIMUM_DISTINCT_INDICATORS } from './ali-prompt.ts';
import { ReplyGenerationError } from './reply-errors.ts';

export const REVIEW_REASONS = [
  'upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request',
  'sensitive_request', 'threat', 'uncertain',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const MODEL_SILENCE_REASONS = [
  'no_actionable_question', 'already_answered', 'ordinary_terms_clear', 'conversation_closed', 'sender_withdrew',
  'wrong_contact', 'transaction_boundary', 'no_safe_follow_up', 'other',
] as const;
export type ModelSilenceReason = (typeof MODEL_SILENCE_REASONS)[number];
export const MODEL_PAYMENT_LINK_REASON = 'unverified_payment_request';
export interface ModelPaymentLinkReview {
  candidateId: number;
  reason: typeof MODEL_PAYMENT_LINK_REASON;
}
export const MAX_REPLY_CHARS = 1_000;
const statuses = ['MONITORING', 'SUSPICIOUS', 'INSUFFICIENT_FRAUD_INDICATORS', 'READY_FOR_OFFICER_REVIEW', 'HUMAN_INTERVENTION_REQUIRED'] as const;
const urgentReasons = new Set<ReviewReason>(['sensitive_request', 'threat', 'uncertain']);

type ConversationDecision =
  | { kind: 'reply'; text: string }
  | { kind: 'silence'; reason: ModelSilenceReason | 'reason_unavailable' }
  | { kind: 'review'; status: 'READY_FOR_OFFICER_REVIEW' | 'HUMAN_INTERVENTION_REQUIRED'; reasons: ReviewReason[] };

export type AliDecision = ConversationDecision & { paymentLinkReview?: ModelPaymentLinkReview; higherConcern?: true };

// The wire object can contain only public text and fixed codes. Attribution comes from the worker's actual job.
const wire = z.object({
  case_status: z.enum(statuses),
  should_reply: z.boolean(),
  external_reply: z.string().nullable(),
  review_reasons: z.array(z.enum(REVIEW_REASONS)).max(REVIEW_REASONS.length),
  silence_reason: z.enum(MODEL_SILENCE_REASONS).nullable(),
  payment_link_review: z.object({
    candidate_id: z.number().int().positive().safe(),
    reason: z.literal(MODEL_PAYMENT_LINK_REASON),
  }).strict().nullable().optional(),
}).strict();

export const ALI_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ali_decision', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: Object.keys(wire.shape),
      properties: {
        case_status: { type: 'string', enum: statuses },
        should_reply: { type: 'boolean' },
        external_reply: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        review_reasons: { type: 'array', items: { type: 'string', enum: REVIEW_REASONS } },
        silence_reason: { anyOf: [{ type: 'string', enum: MODEL_SILENCE_REASONS }, { type: 'null' }] },
        payment_link_review: { anyOf: [{
          type: 'object', additionalProperties: false, required: ['candidate_id', 'reason'],
          properties: {
            candidate_id: { type: 'integer', minimum: 1 },
            reason: { type: 'string', enum: [MODEL_PAYMENT_LINK_REASON] },
          },
        }, { type: 'null' }] },
      },
    },
  },
} as const;

// Most reason codes are unique identifiers. "Other" can also occur in an ordinary sentence.
const silenceMetadata = new RegExp(`\\b(?:silence_reason|reason_unavailable|repeated_identity_question|${MODEL_SILENCE_REASONS.filter(r => r !== 'other').join('|')})\\b`, 'iu');

export function hasInternalReplyContent(text: string): boolean {
  return /^\s*\{|\{\s*["'}]|`{3}|["“][\w-]+["”]\s*:|\b(?:case_status|should_reply|external_reply|review_reasons|previous_draft_blocked_by|officer_handover_report|extracted_payment_info|upfront_fee|payment_pressure|contradictory_terms|unverified_payment_request|sensitive_request)\b|\b(?:MONITORING|SUSPICIOUS|READY_FOR_OFFICER_REVIEW|HUMAN_INTERVENTION_REQUIRED|INSUFFICIENT_FRAUD_INDICATORS)\b/u.test(text)
    || silenceMetadata.test(text)
    || /\b(?:payment_link_review|payment_link_candidates|candidate_id|officer_brief|dispatch_brief|meeting_arranged|meeting_day_confirmed|repeated_meeting_question)\b/iu.test(text)
    || /<\/?think\b|\[\s*no[\s_-]*reply\b|\bno[_-]reply\b/iu.test(text);
}

function invalid(): never { throw new ReplyGenerationError('invalid_response'); }

export function parseAliDecision(raw: string, minimumDistinctIndicators = MINIMUM_DISTINCT_INDICATORS): AliDecision {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return invalid(); }
  const parsed = wire.safeParse(json);
  if (!parsed.success) return invalid();
  const { case_status: status, should_reply: send, external_reply: reply, review_reasons: reasons, silence_reason: silenceReason,
    payment_link_review: link } = parsed.data;
  const assessment = {
    ...(link && { paymentLinkReview: { candidateId: link.candidate_id, reason: link.reason } }),
    ...(status === 'SUSPICIOUS' && { higherConcern: true as const }),
  };
  if (send !== (reply !== null) || new Set(reasons).size !== reasons.length) return invalid();
  if (status === 'READY_FOR_OFFICER_REVIEW' || status === 'HUMAN_INTERVENTION_REQUIRED') {
    if (send || silenceReason !== null) return invalid();
    if (status === 'READY_FOR_OFFICER_REVIEW') {
      if (reasons.length < minimumDistinctIndicators || reasons.some(reason => urgentReasons.has(reason))) return invalid();
    } else if (!reasons.some(reason => urgentReasons.has(reason))) return invalid();
    return { kind: 'review', status, reasons, ...assessment };
  }
  if (reasons.length || (status === 'INSUFFICIENT_FRAUD_INDICATORS' && send)) return invalid();
  if (reply === null) return silenceReason === null ? invalid() : { kind: 'silence', reason: silenceReason, ...assessment };
  if (silenceReason !== null) return invalid();
  const text = reply.trim();
  if (!text || text.length > MAX_REPLY_CHARS || hasInternalReplyContent(text)) return invalid();
  return { kind: 'reply', text, ...assessment };
}

/** Plain-text callers cannot claim or deliver internal handoffs. The production worker consumes decide(). */
export function publicReplyFromDecision(decision: AliDecision): string | null {
  return decision.kind === 'reply' && !decision.paymentLinkReview ? decision.text : null;
}
