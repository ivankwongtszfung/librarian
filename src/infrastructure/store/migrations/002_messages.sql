-- ADR-011: chat-bar messages become durable rows. "Sent" is only ever said
-- about a committed row; delivered_at is stamped when the batch flushes.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  context      TEXT,             -- JSON page context, as the UI sent it
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_undelivered
  ON messages (created_at) WHERE delivered_at IS NULL;
