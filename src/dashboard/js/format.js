/** Display labels and text for API values. The exact strings fixed by the brief come from the API where it sends them. */

export const AI_MODE_LABELS = {
  not_started: 'AI not started',
  ai_active: 'AI active',
  paused: 'AI paused',
  officer_control: 'Officer control',
};

export const DIRECTION_LABELS = { incoming: 'Incoming', outgoing: 'Outgoing', unknown: 'Direction not reported' };

export const TELEGRAM_EVIDENCE_LABELS = {
  payment_link: 'payment link',
  document: 'document',
  location: 'location',
  bank_details: 'bank transfer details',
  conversation_review: 'conversation',
};

const INDICATOR_LABELS = {
  upfront_fee: 'upfront fee', payment_pressure: 'pressure to pay', contradictory_terms: 'conflicting terms',
  unverified_payment_request: 'unverified payment request', sensitive_request: 'request for sensitive information',
  threat: 'threat', uncertain: 'unclear circumstances',
};

/** Officer-facing assessment using only recognized decision and indicator codes. The source link supplies the evidence. */
export function conversationReviewSummary(detail) {
  const status = detail?.reviewStatus === 'READY_FOR_OFFICER_REVIEW' ? 'Ready for officer review' : 'Human review required';
  const indicators = typeof detail?.indicators === 'string'
    ? detail.indicators.split(',').filter(code => Object.hasOwn(INDICATOR_LABELS, code)).map(code => INDICATOR_LABELS[code]) : [];
  return indicators.length ? `${status}. Check for ${indicators.join(', ')}.` : `${status}.`;
}

/** Older chat responses expose only their first held review. */
export function evidenceItemsFor(hold) {
  return hold.evidenceItems ?? (hold.officerReview ? [hold.officerReview] : []);
}

export function evidenceCountLabel(count) {
  return `${count} ${count === 1 ? 'item' : 'items'} for officer review`;
}

export const CAPTURE_METHOD_LABELS = {
  fixture_replay: 'Fixture replay',
  telegram_business_live: 'Telegram Business (live)',
  approved_import: 'Approved import',
  host_intake: 'Host intake',
  officer_composer: 'Mirsad composer',
};

const REVIEW_STATUS_LABELS = {
  not_requested: 'Review not requested',
  pending: 'Review pending',
  running: 'Review running',
  unavailable: 'Review unavailable',
  stale_discarded: 'Review result discarded after a control change',
  not_permitted: 'Not reviewed: review is not permitted for this source',
};

export const CASE_ACTION_LABELS = {
  chat_registered: 'Chat registered',
  chat_test_started: 'New test started',
  lower_concern_assessed: 'Lower concern assessment',
  dispatch_started: 'Dispatch: AI review started',
  control_pause: 'Pause AI',
  control_take_over: 'Take over',
  control_resume: 'Resume AI',
  leave_unanswered: 'Leave unanswered',
  officer_message_sent: 'Officer reply recorded (Simulated send)',
  case_reference_recorded: 'Merchant confirmation recorded',
  capture_retry_requested: 'Capture retry requested',
  watchlist_match: 'Watchlist match',
  text_conflict_recorded: 'Conflicting copy recorded',
  ai_reply_sent: 'Automated reply sent',
  ai_reply_failed: 'AI reply failed',
  ai_reply_skipped: 'Assistant left the message unanswered',
  telegram_contact_opted_out: 'Contact opted out of automated replies',
  telegram_contact_opted_in: 'Contact opted back in to automated replies',
  telegram_dispatch_permission_recorded: 'Officer recorded participant permission for replies and fraud screening',
  telegram_officer_review_requested: 'Officer review requested',
  telegram_officer_review_resolved: 'Officer marked evidence reviewed',
  ai_auto_started: 'Chat marked AI active automatically',
};

/** Why an AI reply failed, for the codes whose plain reason is not enough; others show as "Reason: code (status)". */
export const AI_REPLY_FAILURE_NOTES = {
  blocked_reply: 'Not sent: the reply guard stopped it',
  store_failed: 'Sent in Telegram, but it could not be stored here',
  telegram_chat_mismatch: 'Sent in Telegram, but Telegram reported a different chat',
};

const MODEL_SILENCE_NOTES = {
  no_actionable_question: 'The model found no question or request to answer.',
  already_answered: 'The model considered the question already answered.',
  ordinary_terms_clear: 'The model considered the terms of the offer clear.',
  conversation_closed: 'The model considered the conversation finished.',
  sender_withdrew: 'The model understood that the sender wanted to stop.',
  wrong_contact: 'The model understood the message as intended for someone else.',
  transaction_boundary: 'The model stopped because continuing would involve a transaction.',
  no_safe_follow_up: 'The model found no safe follow-up.',
  other: 'The model selected another reason without specifying it.',
  reason_unavailable: 'The model returned no reason for skipping this reply.',
};

/** Display only known reason and source pairs. Older skipped replies have no decision detail. */
export function silenceSummary(detail) {
  if (detail?.source === 'model' && typeof detail.reason === 'string' && Object.hasOwn(MODEL_SILENCE_NOTES, detail.reason)) {
    return MODEL_SILENCE_NOTES[detail.reason];
  }
  if (detail?.source === 'reply_guard' && detail.reason === 'repeated_identity_question') {
    return 'Mirsad suppressed a repeat answer to the same question about Ali’s identity.';
  }
  if (detail?.source === 'reply_guard' && detail.reason === 'repeated_meeting_question') {
    return 'Mirsad stopped a repeat question about meeting arrangements already discussed.';
  }
  return 'No reason was recorded.';
}

export const OBSERVATION_ORIGIN_LABELS = { sender_metadata: 'Sender metadata', message_mention: 'Mentioned in a message' };

const ERROR_TEXT = {
  revision_conflict: 'The chat changed since it was loaded. It has been refreshed; check it and try again.',
  not_controller: 'Another officer controls this chat.',
  not_in_takeover: 'The chat is no longer under takeover.',
  invalid_transition: "That action is not available in the chat's current mode.",
  chat_not_found: 'That chat is not available.',
  message_not_found: 'That message is not available.',
  capture_not_retryable: 'That capture is not waiting for a retry.',
  evidence_access_required: 'Reviewing this entry needs access to at least one chat with its evidence.',
  watchlist_entry_not_found: 'That watchlist entry is not available.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
};

export function reviewStatusLabel(review) {
  if (review.status === 'completed') return review.outcome === 'findings' ? 'Finding recorded' : 'No new finding';
  return REVIEW_STATUS_LABELS[review.status] ?? review.status;
}

/** 2026-11-21T08:00:00.000Z -> 2026-11-21 08:00:00 UTC */
export function formatTime(iso) {
  return typeof iso === 'string' && iso.length >= 19 ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : '';
}

export function describeError(error) {
  if (error !== null && typeof error === 'object' && error.name === 'ApiError') return ERROR_TEXT[error.code] ?? error.message;
  if (error instanceof TypeError) return 'The service could not be reached.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** One sentence for a recorded merchant confirmation and the payment links it marked Suspected fraud. */
export function describeCaseReference(findingsCreated) {
  if (findingsCreated === 0) return 'Merchant confirmation recorded.';
  return `Merchant confirmation recorded. ${plural(findingsCreated, 'payment link', 'payment links')} marked Suspected fraud.`;
}

/**
 * One sentence for a dispatch answer: how many chats started, were already active (Dispatch then queues their
 * unavailable reviews again), or need Resume AI.
 */
export function describeDispatch(results) {
  const count = (status) => results.filter((result) => result.status === status).length;
  const parts = [];
  if (count('started') > 0) parts.push(`AI review started for ${plural(count('started'), 'chat', 'chats')}`);
  if (count('already_active') > 0) {
    parts.push(`${plural(count('already_active'), 'chat was', 'chats were')} already active and any unavailable reviews were queued again`);
  }
  if (count('requires_resume') > 0) parts.push(`${plural(count('requires_resume'), 'chat needs', 'chats need')} Resume AI first`);
  return `Dispatch: ${parts.join('; ')}.`;
}
