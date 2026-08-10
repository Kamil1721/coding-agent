-- FIXTURE G — the persistence artefact's schema. Shared by BOTH sides of the
-- pair, so the only difference between hollow and restored is `insert.sql`.
--
-- The table exists and is empty in the hollow artefact on purpose: an artefact
-- with no database at all would fail the data expectation for the wrong reason
-- (file missing), and "fails for a different reason" is exactly what the
-- calibration suite's named-gate assertions exist to catch.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
