-- Bug reports are documents too: widen the kind CHECK to include 'bug'.
-- SQLite cannot alter a constraint in place, so this is the documented
-- rebuild dance. It relies on migrate() running pending migrations with
-- foreign_keys OFF (and verifying with foreign_key_check afterwards) —
-- with FKs on, DROP TABLE would cascade-delete every child row.

-- First, sweep orphans: rows deleted via the sqlite3 CLI (which ships with
-- foreign_keys OFF) never cascaded, leaving children pointing at nothing.
-- The rebuild's integrity check would refuse to proceed over them.
DELETE FROM versions        WHERE decision_id NOT IN (SELECT id FROM decisions);
DELETE FROM comments        WHERE decision_id NOT IN (SELECT id FROM decisions);
DELETE FROM verdict_events  WHERE decision_id NOT IN (SELECT id FROM decisions);
DELETE FROM decision_provenance WHERE decision_id NOT IN (SELECT id FROM decisions);
DELETE FROM decisions_fts   WHERE decision_id NOT IN (SELECT id FROM decisions);

CREATE TABLE decisions_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  session_id    TEXT REFERENCES sessions(id),
  kind          TEXT NOT NULL CHECK (kind IN ('plan', 'adr', 'prd', 'arch', 'bug')),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'changes_requested', 'approved', 'rejected', 'superseded')),
  source        TEXT NOT NULL CHECK (source IN ('mcp', 'watcher')),
  content_hash  TEXT NOT NULL UNIQUE,
  pinned_commit TEXT,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);

INSERT INTO decisions_new SELECT * FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_new RENAME TO decisions;

CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at DESC);
