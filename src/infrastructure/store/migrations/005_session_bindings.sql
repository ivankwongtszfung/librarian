-- Remembered session→project bindings (ADR-016).
--
-- Keyed by the session's launch directory, NOT its session key: a key is
-- regenerated every time a session starts, but the directory is the stable
-- identity of "where I do this work". So binding ~/Projects/all_state to
-- `librarian` once survives both daemon restarts and session restarts.
--
-- `cwd` is stored as an OPAQUE STRING — it is only ever compared, never
-- resolved, opened, or executed.
CREATE TABLE IF NOT EXISTS session_bindings (
  cwd        TEXT PRIMARY KEY,
  projects   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
