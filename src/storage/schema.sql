CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  stream_seq INTEGER NOT NULL DEFAULT 0,      -- last issued stream sequence
  stream_floor INTEGER NOT NULL DEFAULT 0,    -- sequences <= floor were pruned
  created_at TEXT NOT NULL
);
CREATE TABLE principals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('officer','connector')),
  display_name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE,
  capture_method TEXT CHECK (capture_method IN ('fixture_replay','telegram_business_live','approved_import','host_intake')),
  trusted_start_marker INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE channel_accounts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL CHECK (source IN ('telegram','whatsapp')),
  external_account_id TEXT NOT NULL, label TEXT NOT NULL,
  is_intake INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source, external_account_id)
);
CREATE TABLE account_grants (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id),
  PRIMARY KEY (principal_id, channel_account_id)
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_account_id TEXT NOT NULL REFERENCES channel_accounts(id),
  external_chat_id TEXT NOT NULL, display_label TEXT NOT NULL,
  created_via TEXT NOT NULL CHECK (created_via IN ('ingest','register')),
  created_by TEXT NOT NULL REFERENCES principals(id),
  inbox_status TEXT NOT NULL CHECK (inbox_status IN ('new_inbound','open')),
  ai_mode TEXT NOT NULL CHECK (ai_mode IN ('not_started','ai_active','paused','officer_control')),
  revision INTEGER NOT NULL DEFAULT 1,
  controller_id TEXT REFERENCES principals(id),
  first_observed_direction TEXT CHECK (first_observed_direction IN ('incoming','outgoing')),
  initiated_by TEXT NOT NULL DEFAULT 'unknown' CHECK (initiated_by IN ('contact','officer','unknown')),
  initiation_basis TEXT CHECK (initiation_basis IN ('source_start_marker','confirmed_complete_history')),
  contact_external_id TEXT, contact_display_name TEXT, contact_phone_raw TEXT, contact_phone_e164 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, channel_account_id, external_chat_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('incoming','outgoing')),          -- NULL only when original_captured = 0 and the source gave no direction
  origin TEXT NOT NULL CHECK (origin IN ('source','officer_composer')),
  source_message_id TEXT,                                               -- NULL for composer messages
  original_captured INTEGER NOT NULL DEFAULT 1,                         -- 0: first seen through an edit or deletion
  text TEXT, text_sha256 TEXT,                                          -- original text, never overwritten
  unsupported_content TEXT NOT NULL DEFAULT '[]',                       -- JSON array of content kinds not captured
  sent_at TEXT, received_at TEXT NOT NULL,
  capture_method TEXT NOT NULL,                                         -- connector's method, or 'officer_composer'
  sender_external_id TEXT, sender_display_name TEXT, sender_phone_raw TEXT,
  author_officer_id TEXT REFERENCES principals(id),
  send_status TEXT CHECK (send_status IN ('simulated')),
  edited_at_source INTEGER NOT NULL DEFAULT 0, deleted_at_source INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_source_message ON messages(chat_id, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE TABLE message_events (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  type TEXT NOT NULL CHECK (type IN ('recorded','edited','deleted')),
  source_event_id TEXT,                                                 -- NULL for composer messages
  text TEXT, text_sha256 TEXT,                                          -- text carried by a recorded or edited event
  source_occurred_at TEXT, received_at TEXT NOT NULL,
  capture_method TEXT NOT NULL, connector_id TEXT REFERENCES principals(id),
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX message_events_source_event ON message_events(chat_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mirsad_rendered_capture','officer_supplied_screenshot')),
  media_type TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE captures (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL UNIQUE REFERENCES message_events(id),
  status TEXT NOT NULL CHECK (status IN ('pending','rendering','ready','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
  artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL UNIQUE REFERENCES message_events(id),
  status TEXT NOT NULL CHECK (status IN ('not_requested','pending','running','completed','unavailable','stale_discarded','not_permitted')),
  outcome TEXT CHECK (outcome IN ('no_new_finding','findings')),
  requested_revision INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
  reviewer TEXT, unsupported_count INTEGER NOT NULL DEFAULT 0, suppressed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE case_references (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  kind TEXT NOT NULL CHECK (kind IN ('merchant_payment_confirmation')),
  payment_hosts TEXT NOT NULL,                                          -- JSON array of lower-case hostnames
  source_note TEXT NOT NULL, recorded_by TEXT NOT NULL REFERENCES principals(id),
  recorded_at TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE case_details (                                             -- what each chat has already surfaced
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
  category TEXT NOT NULL CHECK (category IN ('payment_link','payment_recipient','phone_number')),
  normalized_value TEXT NOT NULL, first_message_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (chat_id, category, normalized_value)
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  review_id TEXT REFERENCES reviews(id),                                -- NULL for a rule finding raised by a case reference
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL REFERENCES message_events(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment_link','payment_recipient','phone_number','suspected_fraud')),
  quote TEXT NOT NULL, extracted_value TEXT NOT NULL, normalized_value TEXT NOT NULL,
  concern TEXT, changed_from TEXT, case_reference_id TEXT REFERENCES case_references(id),
  note TEXT NOT NULL, created_at TEXT NOT NULL, position INTEGER NOT NULL,
  UNIQUE (message_event_id, kind, normalized_value)
);
CREATE TABLE case_actions (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), workspace_id TEXT NOT NULL,
  type TEXT NOT NULL, actor_id TEXT REFERENCES principals(id), message_id TEXT REFERENCES messages(id),
  from_mode TEXT, to_mode TEXT, revision INTEGER,
  detail TEXT,                                                          -- JSON of ids and codes, never message text
  occurred_at TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE stream_events (
  workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  chat_id TEXT, watchlist_entry_id TEXT,
  data TEXT NOT NULL,                                                   -- JSON of ids and statuses only
  occurred_at TEXT NOT NULL, PRIMARY KEY (workspace_id, seq)
);
CREATE TABLE idempotency_keys (
  principal_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL, status_code INTEGER NOT NULL, response_body TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (principal_id, scope, key)
);
CREATE TABLE watchlist_entries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  match_key TEXT NOT NULL,                                              -- E.164, or 'unnormalized:<digits>'
  e164 TEXT, display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('needs_review','approved','cleared')),
  revision INTEGER NOT NULL DEFAULT 1, new_evidence_since_review INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, match_key)
);
CREATE TABLE watchlist_observations (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES watchlist_entries(id), workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id), message_id TEXT NOT NULL REFERENCES messages(id),
  message_event_id TEXT NOT NULL REFERENCES message_events(id), finding_id TEXT REFERENCES findings(id),
  origin TEXT NOT NULL CHECK (origin IN ('sender_metadata','message_mention')),
  source_representation TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL,
  UNIQUE (entry_id, message_event_id, origin)
);
CREATE TABLE watchlist_reviews (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES watchlist_entries(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','clear','reopen')),
  reason TEXT NOT NULL, officer_id TEXT NOT NULL REFERENCES principals(id),
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, revision INTEGER NOT NULL, decided_at TEXT NOT NULL
);
CREATE TABLE watchlist_matches (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES watchlist_entries(id), chat_id TEXT NOT NULL REFERENCES chats(id),
  matched_e164 TEXT NOT NULL, source_representation TEXT NOT NULL, matched_at TEXT NOT NULL,
  UNIQUE (entry_id, chat_id)
);
CREATE TABLE connector_state (
  connector_id TEXT NOT NULL REFERENCES principals(id), key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (connector_id, key)
);
