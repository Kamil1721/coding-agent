-- FIXTURE G — THE MUTATION, AND IT IS THE WHOLE FIXTURE.
--
-- DESIGN §6.4 row G asks for the paired control as ONE mutation, not a second
-- directory: two directories stop being a control the first time one of them
-- is edited alone. So the hollow artefact is `schema.sql` alone, the restored
-- artefact is `schema.sql` + this file, and nothing else differs.
--
-- Restored side: the POST /api/contact handler actually wrote the row.
-- Hollow side: it answered 201 and wrote nothing, which is the failure mode
-- `dataExpectations` exists to catch and which no fixture in this repository
-- has ever exercised (four instances of `dataExpectations`, all empty).
INSERT INTO messages (name, email, body, created_at)
VALUES ('Ada Lovelace', 'ada@example.test', 'Interested in the booking flow.', '2026-08-10T09:00:00.000Z');
