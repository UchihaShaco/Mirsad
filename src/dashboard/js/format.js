/** Display labels and text for API values. The exact strings fixed by the brief come from the API where it sends them. */

export const AI_MODE_LABELS = {
  not_started: 'AI not started',
  ai_active: 'AI active',
  paused: 'AI paused',
  officer_control: 'Officer control',
};

export const DIRECTION_LABELS = { incoming: 'Incoming', outgoing: 'Outgoing', unknown: 'Direction not reported' };

export const TELEGRAM_EVIDENCE_LABELS = {
  link: 'link',
  payment_link: 'payment link',
  document: 'document',
  location: 'location',
  bank_details: 'bank transfer details',
  conversation_review: 'conversation',
};

export function reviewWarningLabel(reason) {
  if (reason === 'conversation_review') return 'Conversation warning';
  if (reason === 'link') return 'Link warning';
  if (reason === 'payment_link' || reason === 'model_payment_link') return 'Payment link warning';
  return null;
}

const INDICATOR_LABELS = {
  upfront_fee: 'an upfront fee', payment_pressure: 'pressure to pay', contradictory_terms: 'conflicting terms',
  unverified_payment_request: 'an unverified payment request', sensitive_request: 'a request for sensitive information',
  threat: 'a threat', uncertain: 'unclear circumstances',
};
const indicatorsList = new Intl.ListFormat('en');

/** Officer-facing assessment using only recognized decision and indicator codes. The source link supplies the evidence. */
export function conversationReviewSummary(detail) {
  const indicators = typeof detail?.indicators === 'string'
    ? detail.indicators.split(',').filter(code => Object.hasOwn(INDICATOR_LABELS, code)).map(code => INDICATOR_LABELS[code]) : [];
  return indicators.length ? `Ali flagged ${indicatorsList.format(indicators)}.` : 'Ali flagged this message for your attention.';
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
  whatsapp_business_live: 'WhatsApp Business (live demo)',
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
  telegram_dispatch_approved: 'Officer confirmed existing participant permission and approved Dispatch',
  telegram_reply_requested: 'Officer queued a Telegram reply',
  telegram_officer_review_requested: 'Officer review requested',
  telegram_officer_review_resolved: 'Officer marked evidence reviewed',
  ai_auto_started: 'Chat marked AI active automatically',
};

/** Why an AI reply failed, for the codes whose plain reason is not enough; others show as "Reason: code (status)". */
export const AI_REPLY_FAILURE_NOTES = {
  delivery_unknown: 'Telegram delivery could not be confirmed. Check the conversation before trying again',
  selected_source_unavailable: 'No reply sent. The selected message is no longer available to Ali',
  source_unavailable: 'No reply sent. The incoming message is no longer available to Ali',
  invalid_response: 'No reply sent. The model returned an unusable response',
  empty_reply: 'No reply sent. The model returned no message for the contact',
  blocked_reply: 'Not sent: the reply guard stopped it',
  store_failed: 'Mirsad could not save the reply. Check Telegram before retrying',
  telegram_chat_mismatch: 'Sent in Telegram, but Telegram reported a different chat',
};

const PROVIDER_FAILURES = {
  key_missing: 'The reply provider key is missing. Check the provider configuration.',
  auth_error: 'The reply provider rejected its credentials. Check the provider configuration.',
  insufficient_credits: 'The reply provider reported insufficient credits. Check the provider account.',
  rate_limited: 'The reply provider is rate-limiting requests. Wait before retrying.',
  timeout: 'The reply provider timed out. Try again when it is available.',
  unreachable: 'The reply provider could not be reached. Check the connection before retrying.',
  blocked: 'The reply provider declined this request. Review the conversation before retrying.',
  incomplete: 'The reply provider returned an incomplete response. Review the conversation before retrying.',
  http_error: 'The reply provider reported an error. Check provider availability before retrying.',
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
  awaiting_sender: 'The model is waiting for the sender to answer Ali’s question or to follow up as they said they would.',
  personal_details_request: 'The model stayed silent because answering would give out personal, contact, payment or delivery details.',
  unclear_message: 'The model could not understand the message well enough to answer it.',
  abusive_message: 'The model stayed silent because the message was abusive or hostile.',
  automated_message: 'The model judged the message to be automated or a broadcast, not written to Ali.',
  unsupported_language: 'The model stayed silent because the message was in a language Ali does not use.',
  // Recorded before the model had to choose a specific reason; the stored code carries none.
  other: 'The model gave no specific reason. This was recorded before a reason was required.',
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

/** The model's own one-sentence explanation of a silence, as stored: links and long numbers were masked before storage. */
export function silenceExplanation(detail) {
  const text = detail?.source === 'model' && typeof detail.explanation === 'string' ? detail.explanation.trim() : '';
  return text && text.length <= 400 ? text : null;
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

const COMPACT_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** 2026-11-21T08:05:00.000Z -> 21 Nov, 08:05 UTC: the short form beside a reason; the full time stays with the message. */
export function formatCompactTime(iso) {
  return formatTime(iso) === '' ? '' : `${COMPACT_TIME.format(new Date(iso))} UTC`;
}

/** 2026-11-21T08:05:00.000Z -> 08:05 UTC: a message's time under its day heading. */
export function formatClock(iso) {
  return formatTime(iso) === '' ? '' : `${iso.slice(11, 16)} UTC`;
}

/** 2026-11-21T08:05:00.000Z -> Sat 21 November 2026: the day heading of the timeline, in UTC like every other time. */
export function formatDay(iso) {
  return formatTime(iso) === '' ? '' : DAY.format(new Date(iso)).replace(',', '');
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

const DISPATCH_REASONS = {
  not_started: 'Dispatch this chat to start automatic replies.',
  paused: 'Ali is paused. Choose Resume AI to hand back control.',
  officer_control: 'An officer controls this chat. Resume AI to hand back control.',
  opted_out: 'The participant opted out of automatic replies.',
  needs_permission: 'Participant permission is needed. Once they have agreed, choose Dispatch to confirm it.',
  awaiting_permission: 'An invitation has already been sent. Waiting for the participant to accept.',
  review_hold: 'Review the bank details in this chat.',
  replies_off: 'Account-wide Telegram replies are off. Check Settings.',
  replies_offline: 'The Telegram reply worker is offline. Check the connection before dispatching again.',
  no_message: 'There is no eligible incoming text. Wait for a message from the contact.',
  latest_not_answerable: 'The latest message cannot be answered. Wait for an original text or caption from the contact.',
  outside_reply_window: 'The Telegram reply window has closed. Wait for a new incoming message.',
  before_reply_scope: 'This message is outside the recorded permission for AI replies.',
  bank_evidence: 'The bank details are kept for officer review. Ali can answer the next eligible message.',
  left_unanswered: 'An officer chose Leave unanswered. Open this chat to reverse that decision.',
  ai_skipped: 'Ali previously chose silence. Open this chat to request another reply.',
  ai_failed: 'The earlier attempt failed. Open this chat to retry.',
  reviewed: 'This message previously went to review. Open this chat to request a reply.',
  already_answered: 'The latest exchange was answered. Open this chat to request a follow-up.',
  send_in_progress: 'A send is already in progress. Check the conversation for delivery.',
  target_changed: 'The conversation changed. Check its latest message before dispatching again.',
};

export function dispatchReason(reason) {
  return DISPATCH_REASONS[reason] ?? 'Check the latest message and the controls in this chat.';
}

function queuedDispatch(kind) {
  if (kind === 'consent_notice') return 'Permission invitation queued for Telegram.';
  if (kind === 'ask_for_text') return 'Request for a text message queued for Telegram.';
  return 'Queued for Telegram.';
}

export function telegramDispatchReceipt(outcome) {
  if (outcome.reason === 'awaiting_permission') return dispatchReason(outcome.reason);
  const delivery = outcome.reply === 'queued' ? queuedDispatch(outcome.kind) : 'No reply queued. ' + dispatchReason(outcome.reason);
  return outcome.automaticReplies === 'active' ? delivery + ' Automatic replies are on for future messages.' : delivery;
}

/** Only the request matched by the service can report an actual delivery. */
export function telegramRequestReceipt(request, actions) {
  const outcome = actions.find(action => action.detail?.requestId === request.id &&
    ['ai_reply_sent', 'ai_reply_failed', 'ai_reply_skipped'].includes(action.type));
  switch (request.status) {
    case 'queued': return queuedDispatch(request.kind);
    case 'sent': {
      if (request.kind === 'consent_notice' || outcome?.detail?.source === 'consent_notice') return 'Permission invitation sent. Telegram confirmed delivery.';
      if (request.kind === 'ask_for_text') return 'Request for a text message sent. Telegram confirmed delivery.';
      return 'Sent. Telegram confirmed delivery.';
    }
    case 'held': return 'Waiting for an officer to review the bank details.';
    case 'expired': return 'Request expired. Check the latest incoming message before dispatching again.';
    case 'superseded': return 'Request superseded. Check the current conversation before dispatching again.';
    case 'skipped': {
      if (request.kind === 'consent_notice') return 'Permission invitation skipped. Check the chat’s current permission.';
      const why = silenceExplanation(outcome?.detail);
      return 'Ali skipped this reply. ' + silenceSummary(outcome?.detail) + (why ? ' Why: ' + why : '');
    }
    case 'failed': {
      const code = request.failureCode;
      const rule = outcome?.detail?.rule;
      if (code === 'store_failed' && outcome?.detail?.telegramMessageId != null) {
        return 'Telegram confirmed the send. Mirsad could not save the reply. Check Telegram before retrying.';
      }
      const note = AI_REPLY_FAILURE_NOTES[code];
      if (note) return note + (rule ? ' (' + rule + ').' : '.');
      const provider = /^(?:gemini|openrouter)_(.+)$/.exec(code ?? '');
      if (provider && Object.hasOwn(PROVIDER_FAILURES, provider[1])) return 'No reply sent. ' + PROVIDER_FAILURES[provider[1]];
      return 'Delivery unconfirmed' + (code ? ' (' + code + ').' : '.') + ' Check the conversation before retrying.';
    }
    default: return 'Delivery unconfirmed. Check the conversation.';
  }
}
