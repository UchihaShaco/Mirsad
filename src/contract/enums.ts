/** Closed value sets of the Mirsad contract (design sections 4 and 6). */

export const SOURCES = ['telegram'] as const;
export type Source = (typeof SOURCES)[number];

/** Capture methods a connector can be provisioned with. */
export const CONNECTOR_CAPTURE_METHODS = [
  'fixture_replay',
  'telegram_business_live',
  'approved_import',
  'host_intake',
] as const;
export type ConnectorCaptureMethod = (typeof CONNECTOR_CAPTURE_METHODS)[number];

export const CAPTURE_METHODS = [...CONNECTOR_CAPTURE_METHODS, 'officer_composer'] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export const DIRECTIONS = ['incoming', 'outgoing'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const AI_MODES = ['not_started', 'ai_active', 'paused', 'officer_control'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const INBOX_STATUSES = ['new_inbound', 'open'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const PRINCIPAL_KINDS = ['officer', 'connector'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const INITIATED_BY = ['contact', 'officer', 'unknown'] as const;
export type InitiatedBy = (typeof INITIATED_BY)[number];

export const INITIATION_BASES = ['source_start_marker', 'confirmed_complete_history'] as const;
export type InitiationBasis = (typeof INITIATION_BASES)[number];

export const MESSAGE_ORIGINS = ['source', 'officer_composer'] as const;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

export const MESSAGE_EVENT_TYPES = ['recorded', 'edited', 'deleted', 'conflicting_copy'] as const;
export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

export const CAPTURE_STATUSES = ['pending', 'rendering', 'ready', 'failed'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export const ARTIFACT_KINDS = ['mirsad_rendered_capture', 'officer_supplied_screenshot'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const REVIEW_STATUSES = [
  'not_requested',
  'pending',
  'running',
  'completed',
  'unavailable',
  'stale_discarded',
  'not_permitted',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_OUTCOMES = ['no_new_finding', 'findings'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const EXTRACTED_KINDS = ['payment_link', 'payment_recipient', 'phone_number'] as const;
export type ExtractedKind = (typeof EXTRACTED_KINDS)[number];

export const FINDING_KINDS = [...EXTRACTED_KINDS, 'suspected_fraud'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const CONCERNS = ['payment_request', 'callback_request', 'credential_request', 'other_concern'] as const;
export type Concern = (typeof CONCERNS)[number];

export const CASE_ACTION_TYPES = [
  'chat_registered',
  'chat_test_started',
  'lower_concern_assessed',
  'telegram_dispatch_permission_recorded',
  'telegram_dispatch_approved',
  'telegram_reply_requested',
  'dispatch_started',
  'control_pause',
  'control_take_over',
  'control_resume',
  'leave_unanswered',
  'officer_message_sent',
  'case_reference_recorded',
  'capture_retry_requested',
  'watchlist_match',
  'text_conflict_recorded',
  'ai_reply_sent',
  'ai_reply_failed',
  'ai_auto_started',
  'ai_reply_skipped',
  'telegram_contact_opted_out',
  'telegram_contact_opted_in',
  'telegram_officer_review_requested',
  'telegram_officer_review_resolved',
] as const;
export type CaseActionType = (typeof CASE_ACTION_TYPES)[number];

export const CONTROL_ACTIONS = ['pause', 'take_over', 'resume'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const DISPATCH_OUTCOMES = ['started', 'already_active', 'requires_resume'] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

/** Whether the participant's permission for AI replies is on record for a live Telegram chat. */
export const TELEGRAM_AI_PERMISSIONS = ['approved', 'needed', 'withdrawn'] as const;
export type TelegramAiPermission = (typeof TELEGRAM_AI_PERMISSIONS)[number];

/**
 * Whether Ali answers the contact's future messages in a live Telegram chat without another Dispatch: `active`, or the
 * one thing that stops him. The officer's own control comes first, then the contact's, then evidence review, then the
 * account-wide switch and the reply worker.
 */
export const TELEGRAM_AUTOMATIC_STATES = [
  'active',
  'not_started',
  'paused',
  'officer_control',
  'opted_out',
  'needs_permission',
  'review_hold',
  'replies_off',
  'replies_offline',
] as const;
export type TelegramAutomaticState = (typeof TELEGRAM_AUTOMATIC_STATES)[number];

/**
 * Where the contact's latest message stands when an officer dispatches: still `unanswered`; set aside by an officer
 * (`left_unanswered`); passed over or failed by Ali (`skipped`, `failed`); held for evidence review and since released
 * (`reviewed`); or `answered`, when the account's own message is the newest in the chat.
 */
export const TELEGRAM_REPLY_TARGET_STATES = ['unanswered', 'left_unanswered', 'skipped', 'failed', 'reviewed', 'answered'] as const;
export type TelegramReplyTargetState = (typeof TELEGRAM_REPLY_TARGET_STATES)[number];

/** Why a Dispatch queued no reply: what stops automatic replies, or what is true of the contact's latest message. */
export const TELEGRAM_NO_REPLY_REASONS = [
  'not_started',
  'paused',
  'officer_control',
  'opted_out',
  'needs_permission',
  'awaiting_permission',
  'review_hold',
  'replies_off',
  'replies_offline',
  'no_message',
  'latest_not_answerable',
  'outside_reply_window',
  'before_reply_scope',
  'bank_evidence',
  'left_unanswered',
  'ai_skipped',
  'ai_failed',
  'reviewed',
  'already_answered',
  'send_in_progress',
  'target_changed',
] as const;
export type TelegramNoReplyReason = (typeof TELEGRAM_NO_REPLY_REASONS)[number];

/** The outbound message an officer requested for a live chat. */
export const TELEGRAM_REPLY_REQUEST_KINDS = ['reply', 'retry', 'follow_up', 'consent_notice', 'ask_for_text'] as const;
export type TelegramReplyRequestKind = (typeof TELEGRAM_REPLY_REQUEST_KINDS)[number];

/**
 * A reply request is `queued` once it is on record for the reply worker and `sent` only when Telegram confirmed the
 * message. Otherwise it ended without a message: Ali chose silence, the attempt failed, evidence review held it, or it
 * ran out of time.
 */
export const TELEGRAM_REPLY_REQUEST_STATUSES = ['queued', 'sent', 'skipped', 'failed', 'held', 'expired', 'superseded'] as const;
export type TelegramReplyRequestStatus = (typeof TELEGRAM_REPLY_REQUEST_STATUSES)[number];

export const CASE_REFERENCE_KINDS = ['merchant_payment_confirmation'] as const;

export const WATCHLIST_STATUSES = ['needs_review', 'approved', 'cleared'] as const;
export type WatchlistStatus = (typeof WATCHLIST_STATUSES)[number];

export const WATCHLIST_DECISIONS = ['approve', 'clear', 'reopen'] as const;
export type WatchlistDecision = (typeof WATCHLIST_DECISIONS)[number];

export const OBSERVATION_ORIGINS = ['sender_metadata', 'message_mention'] as const;
export type ObservationOrigin = (typeof OBSERVATION_ORIGINS)[number];

export const INGEST_RESULTS = ['recorded', 'duplicate_event', 'duplicate_message', 'conflicting_copy'] as const;

export const START_MARKER_RESULTS = ['accepted', 'ignored_untrusted', 'ignored_conflict', 'none'] as const;
export type StartMarkerResult = (typeof START_MARKER_RESULTS)[number];

export const REVIEWER_KINDS = ['lmstudio', 'deterministic', 'disabled'] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

export const READINESS_STATES = ['not_assessed', 'ready_for_controlled_test', 'controlled_test_verified'] as const;
