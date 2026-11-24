export const REPLY_GUARD_RULES = ['link', 'unsafe_link_advice', 'long_number', 'human_claim', 'external_action', 'secret_request', 'payment_instructions', 'request_material', 'location_request', 'code_block', 'shopping_claim', 'seller_disclosure', 'unsolicited_brand', 'unverified_location', 'lookup_request', 'too_verbose', 'identity_language', 'repeat', 'unneeded_offer_question', 'unstated_currency', 'fee_purpose_question'] as const;
export type ReplyGuardRule = (typeof REPLY_GUARD_RULES)[number];

export function isReplyGuardRule(value: string | undefined): value is ReplyGuardRule {
  return REPLY_GUARD_RULES.some(rule => rule === value);
}
