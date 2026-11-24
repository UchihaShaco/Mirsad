import { z } from 'zod';
import { maskUrls } from '../domain/links.ts';
import { MINIMUM_DISTINCT_INDICATORS } from './ali-prompt.ts';
import { InvalidReplyDraftError } from './reply-errors.ts';

export const REVIEW_REASONS = [
  'upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request',
  'sensitive_request', 'threat', 'uncertain',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
/**
 * Why Ali stays silent, as the model must state it: every code names one specific reason. There is no catch-all, so
 * the officer never sees a silence without its reason. Each silence also carries the model's own explanation.
 */
export const MODEL_SILENCE_REASONS = [
  'no_actionable_question', 'already_answered', 'ordinary_terms_clear', 'conversation_closed', 'sender_withdrew',
  'wrong_contact', 'transaction_boundary', 'no_safe_follow_up', 'awaiting_sender', 'personal_details_request',
  'unclear_message', 'abusive_message', 'automated_message', 'unsupported_language',
] as const;
export type ModelSilenceReason = (typeof MODEL_SILENCE_REASONS)[number];
/** The correction that asks the model again when it chose silence without explaining it. */
export const SILENCE_EXPLANATION_REQUEST = 'explain_silence';
/** The longest explanation of a silence the officer is shown. */
export const MAX_SILENCE_EXPLANATION_CHARS = 280;
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
  | { kind: 'silence'; reason: ModelSilenceReason | 'reason_unavailable'; explanation?: string }
  | { kind: 'review'; status: 'READY_FOR_OFFICER_REVIEW' | 'HUMAN_INTERVENTION_REQUIRED'; reasons: ReviewReason[] };

export type AliDecision = ConversationDecision & { paymentLinkReview?: ModelPaymentLinkReview; higherConcern?: true };

// The wire object can contain only public text and fixed codes. Attribution comes from the worker's actual job.
const wire = z.object({
  case_status: z.enum(statuses),
  should_reply: z.boolean(),
  external_reply: z.string().nullable(),
  review_reasons: z.array(z.enum(REVIEW_REASONS)).max(REVIEW_REASONS.length),
  silence_reason: z.enum(MODEL_SILENCE_REASONS).nullable(),
  // Required by the response schema; optional here so an older stored completion still parses.
  silence_explanation: z.string().max(4_000).nullable().optional(),
  payment_link_review: z.object({
    candidate_id: z.number().int().positive().safe(),
    reason: z.literal(MODEL_PAYMENT_LINK_REASON),
  }).strict().nullable().optional(),
}).strict();

const publicReplyWire = z.object({ external_reply: z.string() }).strict();

/** Used when the worker needs an outgoing message and has already handled the private assessment. */
export const ALI_PUBLIC_REPLY_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ali_public_reply', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['external_reply'],
      properties: { external_reply: { type: 'string' } },
    },
  },
} as const;

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
        silence_explanation: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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

// Reason codes are unique identifiers; none of them belongs in a public reply.
const silenceMetadata = new RegExp(`\\b(?:silence_reason|silence_explanation|reason_unavailable|repeated_identity_question|${MODEL_SILENCE_REASONS.join('|')})\\b`, 'iu');

export function hasInternalReplyContent(text: string): boolean {
  return /^\s*\{|\{\s*["'}]|`{3}|["“][\w-]+["”]\s*:|\b(?:case_status|should_reply|external_reply|review_reasons|previous_draft_blocked_by|officer_handover_report|extracted_payment_info|upfront_fee|payment_pressure|contradictory_terms|unverified_payment_request|sensitive_request)\b|\b(?:MONITORING|SUSPICIOUS|READY_FOR_OFFICER_REVIEW|HUMAN_INTERVENTION_REQUIRED|INSUFFICIENT_FRAUD_INDICATORS)\b/u.test(text)
    || silenceMetadata.test(text)
    || /\b(?:ali_public_reply|payment_link_review|payment_link_candidates|candidate_id|officer_brief|officer_dispatch_request|dispatch_brief|attachment_kinds|meeting_arranged|meeting_day_confirmed|repeated_meeting_question)\b/iu.test(text)
    || /<\/?think\b|\[\s*no[\s_-]*reply\b|\bno[_-]reply\b|\bno[\s_-]*reply\s*\]|^no\s+reply[.!]?$/iu.test(text);
}

function invalid(): never { throw new InvalidReplyDraftError('invalid_response'); }

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const HANDLE = /(^|[^\p{L}\p{N}_])@[A-Za-z0-9_]{3,32}/gu;
/** A host written without a scheme, such as pay.example.test/checkout. */
const BARE_HOST = /(?<![\p{L}\p{N}@._-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:[/?#][^\s]*)?/gu;
/** Six or more digits, in any script, with the separators people type: phone, account and card numbers, IBAN digits. */
const LONG_NUMBER = /\+?[0-9٠-٩۰-۹](?:[\s().\/-]*[0-9٠-٩۰-۹]){5,}/gu;
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const EDGE_QUOTES = /^["'“”‘’«»„]+|["'“”‘’«»„]+$/gu;

/** Each link in `text` becomes "[link]"; maskUrls blanks a link's characters in place, so positions line up. */
function withLinksMasked(text: string): string {
  const masked = maskUrls(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (masked[i] === text[i]) out += text[i];
    else if (masked[i - 1] === text[i - 1] || i === 0) out += '[link]';
  }
  return out;
}

/**
 * The model's explanation of a silence, as the officer may see it: one line, links (with or without a scheme), e-mail
 * addresses, handles and long numbers masked, so it never repeats a value that belongs only in its source message, and at most
 * MAX_SILENCE_EXPLANATION_CHARS long. Undefined when nothing explanatory remains.
 */
export function officerSilenceExplanation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = withLinksMasked(value.normalize('NFKC').replace(HIDDEN_CHARACTERS, ' '))
    .replace(EMAIL, '[email]')
    .replace(HANDLE, '$1[handle]')
    .replace(BARE_HOST, '[link]')
    .replace(LONG_NUMBER, '[number]')
    .replace(/[`{}]/gu, '')
    .replace(/_/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(EDGE_QUOTES, '')
    .trim();
  if ((text.match(/\p{L}/gu) ?? []).length < 8) return undefined;
  if (text.length > MAX_SILENCE_EXPLANATION_CHARS) {
    const cut = text.slice(0, MAX_SILENCE_EXPLANATION_CHARS - 1);
    const space = cut.lastIndexOf(' ');
    text = (space > MAX_SILENCE_EXPLANATION_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.،؛-]+$/u, '') + '…';
  }
  return text;
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return invalid(); }
}

function checkedPublicText(reply: string): string {
  const text = reply.trim();
  if (!text || text.length > MAX_REPLY_CHARS || hasInternalReplyContent(text)) return invalid();
  return text;
}

export function parseAliPublicReply(raw: string): string {
  const parsed = publicReplyWire.safeParse(parseJson(raw));
  return parsed.success ? checkedPublicText(parsed.data.external_reply) : invalid();
}

export function parseAliDecision(raw: string, minimumDistinctIndicators = MINIMUM_DISTINCT_INDICATORS): AliDecision {
  const parsed = wire.safeParse(parseJson(raw));
  if (!parsed.success) return invalid();
  const { case_status: status, should_reply: send, external_reply: reply, review_reasons: reasons, silence_reason: silenceReason,
    silence_explanation: silenceExplanation, payment_link_review: link } = parsed.data;
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
  if (reply === null) {
    if (silenceReason === null) return invalid();
    // A silence the model did not explain is returned without one; the reply worker asks the model again.
    const explanation = officerSilenceExplanation(silenceExplanation);
    return { kind: 'silence', reason: silenceReason, ...(explanation ? { explanation } : {}), ...assessment };
  }
  if (silenceReason !== null) return invalid();
  return { kind: 'reply', text: checkedPublicText(reply), ...assessment };
}

/** Plain-text callers cannot claim or deliver internal handoffs. The production worker consumes decide(). */
export function publicReplyFromDecision(decision: AliDecision): string | null {
  return decision.kind === 'reply' && !decision.paymentLinkReview ? decision.text : null;
}
