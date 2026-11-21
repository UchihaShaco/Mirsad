/**
 * Row shapes of schema.sql as returned by `SELECT *` (snake_case, integers for flags).
 * Repositories map them to contract shapes; nothing outside storage and services should need them.
 */
import type {
  AiMode,
  CaptureStatus,
  Direction,
  InboxStatus,
  InitiatedBy,
  InitiationBasis,
  MessageEventType,
  PrincipalKind,
  ReviewOutcome,
  ReviewStatus,
  Source,
} from '../contract/enums.ts';

type Flag = 0 | 1;

export interface WorkspaceRow {
  id: string;
  name: string;
  stream_seq: number;
  stream_floor: number;
  created_at: string;
}

export interface PrincipalRow {
  id: string;
  workspace_id: string;
  kind: PrincipalKind;
  display_name: string;
  token_sha256: string;
  capture_method: string | null;
  trusted_start_marker: Flag;
  disabled: Flag;
  created_at: string;
}

export interface ChannelAccountRow {
  id: string;
  workspace_id: string;
  source: Source;
  external_account_id: string;
  label: string;
  is_intake: Flag;
  created_at: string;
}

export interface ChatRow {
  id: string;
  workspace_id: string;
  channel_account_id: string;
  external_chat_id: string;
  display_label: string;
  created_via: 'ingest' | 'register';
  created_by: string;
  inbox_status: InboxStatus;
  ai_mode: AiMode;
  revision: number;
  controller_id: string | null;
  first_observed_direction: Direction | null;
  initiated_by: InitiatedBy;
  initiation_basis: InitiationBasis | null;
  contact_external_id: string | null;
  contact_display_name: string | null;
  contact_phone_raw: string | null;
  contact_phone_e164: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  workspace_id: string;
  direction: Direction | null;
  origin: 'source' | 'officer_composer';
  source_message_id: string | null;
  original_captured: Flag;
  text: string | null;
  text_sha256: string | null;
  unsupported_content: string;
  sent_at: string | null;
  received_at: string;
  capture_method: string;
  sender_external_id: string | null;
  sender_display_name: string | null;
  sender_phone_raw: string | null;
  author_officer_id: string | null;
  send_status: 'simulated' | null;
  edited_at_source: Flag;
  deleted_at_source: Flag;
  position: number;
}

export interface MessageEventRow {
  id: string;
  chat_id: string;
  message_id: string;
  type: MessageEventType;
  source_event_id: string | null;
  text: string | null;
  text_sha256: string | null;
  source_occurred_at: string | null;
  received_at: string;
  capture_method: string;
  connector_id: string | null;
  position: number;
}

export interface CaptureRow {
  id: string;
  chat_id: string;
  message_id: string;
  message_event_id: string;
  status: CaptureStatus;
  attempts: number;
  last_error_code: string | null;
  artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRow {
  id: string;
  chat_id: string;
  message_id: string;
  message_event_id: string;
  status: ReviewStatus;
  outcome: ReviewOutcome | null;
  requested_revision: number | null;
  attempts: number;
  last_error_code: string | null;
  reviewer: string | null;
  unsupported_count: number;
  suppressed_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface FindingRow {
  id: string;
  chat_id: string;
  workspace_id: string;
  review_id: string | null;
  message_id: string;
  message_event_id: string;
  kind: 'payment_link' | 'payment_recipient' | 'phone_number' | 'suspected_fraud';
  quote: string;
  extracted_value: string;
  normalized_value: string;
  concern: string | null;
  changed_from: string | null;
  case_reference_id: string | null;
  note: string;
  created_at: string;
  position: number;
}

export interface StreamEventRow {
  workspace_id: string;
  seq: number;
  type: string;
  chat_id: string | null;
  watchlist_entry_id: string | null;
  data: string;
  occurred_at: string;
}
