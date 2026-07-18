-- Librarian core schema.
-- Verdicts are append-only events; decisions.status is a denormalized cache of
-- the latest event, so a rejection later revised into an approval keeps its
-- full red-light history.

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  root_path  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  agent        TEXT,
  external_ref TEXT UNIQUE,
  started_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

CREATE TABLE IF NOT EXISTS participants (
  id   TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent', 'reviewer')),
  name TEXT NOT NULL,
  UNIQUE (type, name)
);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  session_id    TEXT REFERENCES sessions(id),
  kind          TEXT NOT NULL CHECK (kind IN ('plan', 'adr', 'prd', 'arch')),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'changes_requested', 'approved', 'rejected', 'superseded')),
  source        TEXT NOT NULL CHECK (source IN ('mcp', 'watcher')),
  content_hash  TEXT NOT NULL UNIQUE,
  pinned_commit TEXT,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at DESC);

-- Provenance is many-to-one: the same decision can arrive via MCP and be
-- re-observed by the watcher. Dedupe merges them, keeping both origins.
CREATE TABLE IF NOT EXISTS decision_provenance (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('mcp', 'watcher')),
  detail      TEXT,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (decision_id, source)
);

CREATE TABLE IF NOT EXISTS versions (
  id                TEXT PRIMARY KEY,
  decision_id       TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  num               INTEGER NOT NULL,
  body_md           TEXT NOT NULL,
  parent_version_id TEXT REFERENCES versions(id),
  context_refs      TEXT,
  submitted_at      INTEGER NOT NULL,
  UNIQUE (decision_id, num)
);

CREATE INDEX IF NOT EXISTS idx_versions_decision ON versions(decision_id);

CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  decision_id    TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  version_id     TEXT REFERENCES versions(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  anchor_quote   TEXT,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  delivered_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_comments_decision ON comments(decision_id);

-- Append-only. A rejection must carry a reason: the red light is a record.
CREATE TABLE IF NOT EXISTS verdict_events (
  id             TEXT PRIMARY KEY,
  decision_id    TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  from_state     TEXT NOT NULL,
  to_state       TEXT NOT NULL
                 CHECK (to_state IN ('pending', 'changes_requested', 'approved', 'rejected', 'superseded')),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  reason         TEXT,
  at             INTEGER NOT NULL,
  CHECK (to_state != 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_verdict_decision ON verdict_events(decision_id, at);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title,
  body,
  reason,
  decision_id UNINDEXED,
  tokenize = 'porter unicode61'
);
