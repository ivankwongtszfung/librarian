-- Agent-generated project catchups (the "Catch me up" button).
-- A catchup is not a decision — it is a generated briefing snapshot — so it
-- lives in its own table, never polluting the decision queue, counts, search,
-- or constraints. One project has many rows: each generation is a new version,
-- and the newest by created_at is "the catchup".
CREATE TABLE IF NOT EXISTS catchups (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  body_md      TEXT NOT NULL,
  generated_by TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catchups_project ON catchups(project_id, created_at DESC);
