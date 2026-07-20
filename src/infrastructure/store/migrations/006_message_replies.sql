-- The agent replies into the record (ADR-019).
--
-- Until now `messages` held only what the human said; the agent's answer went
-- to its own terminal and never reached librarian. The thread was one-sided by
-- construction, so the history panel had to *infer* from timing whether an
-- answer had happened — and could be wrong in both directions.
--
-- A reply is a message, not a second kind of thing: same durability, same
-- ordering, same table. `author` distinguishes them and `in_reply_to` says
-- which message is being answered.
--
-- `author` defaults to 'human' so every existing row keeps its meaning with no
-- backfill: everything written before this migration was, in fact, the human.
ALTER TABLE messages ADD COLUMN author TEXT NOT NULL DEFAULT 'human';
ALTER TABLE messages ADD COLUMN in_reply_to TEXT REFERENCES messages(id);

-- Carried as JSON: commits, PRs, files — the evidence that the thing was
-- actually done, so "fixed it" is checkable rather than merely claimed.
ALTER TABLE messages ADD COLUMN refs TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_in_reply_to ON messages(in_reply_to);
