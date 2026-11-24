-- Different deliveries and edits can refer to one review item. Only a chat-scoped digest is kept here.
CREATE TABLE IF NOT EXISTS telegram_evidence_sources (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  reason TEXT NOT NULL,
  item_key TEXT NOT NULL,
  action_id TEXT NOT NULL REFERENCES case_actions(id),
  PRIMARY KEY (message_id, reason, item_key)
);
CREATE INDEX IF NOT EXISTS telegram_evidence_value ON telegram_evidence_sources(chat_id, reason, item_key);
