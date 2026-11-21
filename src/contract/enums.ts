/** Closed value sets of the Mirsad contract (design sections 4 and 6). */

export const SOURCES = ['telegram', 'whatsapp'] as const;
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

export const MESSAGE_EVENT_TYPES = ['recorded', 'edited', 'deleted'] as const;
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
  'dispatch_started',
  'control_pause',
  'control_take_over',
  'control_resume',
  'leave_unanswered',
  'officer_message_sent',
  'case_reference_recorded',
  'capture_retry_requested',
  'watchlist_match',
] as const;
export type CaseActionType = (typeof CASE_ACTION_TYPES)[number];

export const CONTROL_ACTIONS = ['pause', 'take_over', 'resume'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const DISPATCH_OUTCOMES = ['started', 'already_active', 'requires_resume'] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const CASE_REFERENCE_KINDS = ['merchant_payment_confirmation'] as const;
export type CaseReferenceKind = (typeof CASE_REFERENCE_KINDS)[number];

export const WATCHLIST_STATUSES = ['needs_review', 'approved', 'cleared'] as const;
export type WatchlistStatus = (typeof WATCHLIST_STATUSES)[number];

export const WATCHLIST_DECISIONS = ['approve', 'clear', 'reopen'] as const;
export type WatchlistDecision = (typeof WATCHLIST_DECISIONS)[number];

export const OBSERVATION_ORIGINS = ['sender_metadata', 'message_mention'] as const;
export type ObservationOrigin = (typeof OBSERVATION_ORIGINS)[number];

export const INGEST_RESULTS = ['recorded', 'duplicate_event', 'duplicate_message'] as const;
export type IngestResultKind = (typeof INGEST_RESULTS)[number];

export const START_MARKER_RESULTS = ['accepted', 'ignored_untrusted', 'ignored_conflict', 'none'] as const;
export type StartMarkerResult = (typeof START_MARKER_RESULTS)[number];

export const REVIEWER_KINDS = ['lmstudio', 'deterministic', 'disabled'] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

export const READINESS_STATES = ['not_assessed', 'ready_for_controlled_test', 'controlled_test_verified'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];
