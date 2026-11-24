CREATE TABLE principals_new (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('officer','connector')),
  display_name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE,
  capture_method TEXT CHECK (capture_method IN ('fixture_replay','telegram_business_live','whatsapp_business_live','approved_import','host_intake')),
  trusted_start_marker INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
INSERT INTO principals_new (id, workspace_id, kind, display_name, token_sha256, capture_method, trusted_start_marker, disabled, created_at)
  SELECT id, workspace_id, kind, display_name, token_sha256, capture_method, trusted_start_marker, disabled, created_at FROM principals;
DROP TABLE principals;
ALTER TABLE principals_new RENAME TO principals;

CREATE TABLE whatsapp_demo_bindings (
  phone_number_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES channel_accounts(id),
  connector_id TEXT NOT NULL UNIQUE REFERENCES principals(id), officer_id TEXT NOT NULL REFERENCES principals(id)
);
CREATE TABLE whatsapp_reply_attempts (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('sending','sent','skipped','failed','uncertain')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE whatsapp_demo_opt_outs (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id), opted_out_at TEXT NOT NULL
);
