CREATE TABLE officer_passwords (
  principal_id TEXT PRIMARY KEY NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  username TEXT COLLATE NOCASE NOT NULL UNIQUE,
  salt BLOB NOT NULL CHECK(length(salt) = 16),
  password_hash BLOB NOT NULL CHECK(length(password_hash) = 32)
);

CREATE TABLE officer_sessions (
  token_sha256 TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL REFERENCES officer_passwords(principal_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX officer_sessions_expiry ON officer_sessions(expires_at);
