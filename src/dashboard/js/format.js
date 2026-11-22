/** Display labels and text for API values. The exact strings fixed by the brief come from the API where it sends them. */

export const AI_MODE_LABELS = {
  not_started: 'AI not started',
  ai_active: 'AI active',
  paused: 'AI paused',
  officer_control: 'Officer control',
};

export const DIRECTION_LABELS = { incoming: 'Incoming', outgoing: 'Outgoing', unknown: 'Direction not reported' };

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
};

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

/** One sentence for a dispatch answer: how many chats started, were already active, or need Resume AI. */
export function describeDispatch(results) {
  const count = (status) => results.filter((result) => result.status === status).length;
  const parts = [];
  if (count('started') > 0) parts.push(`AI review started for ${plural(count('started'), 'chat', 'chats')}`);
  if (count('already_active') > 0) parts.push(`${plural(count('already_active'), 'chat was', 'chats were')} already active`);
  if (count('requires_resume') > 0) parts.push(`${plural(count('requires_resume'), 'chat needs', 'chats need')} Resume AI first`);
  return `Dispatch: ${parts.join('; ')}.`;
}
