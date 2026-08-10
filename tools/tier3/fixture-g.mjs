/**
 * FIXTURE G — the populated-`dataExpectations` artefact and its restored control.
 *
 * DESIGN §6.4 row G, and §2.3 point 2 states why it is the highest-value
 * missing control: NO FIXTURE IN THIS REPOSITORY HAS EVER POPULATED
 * `dataExpectations`. Four instances, all `[]` — so the persistence gate has
 * never executed with a real expectation, and a patch that quietly disabled it
 * would pass the entire §6 sequence. The gate's negative arm is vacuous in
 * exactly the area the first Tier-2 repair touches.
 *
 * ONE MUTATION, NOT TWO DIRECTORIES. `schema.sql` builds the hollow artefact;
 * `schema.sql` + `insert.sql` builds the restored one; `server.mjs.template`
 * carries one placeholder. Two checked-in artefact trees would be a control
 * only until the first time one of them was edited alone.
 *
 * The databases are GENERATED into scratch, never committed: a binary fixture
 * cannot be reviewed, and a `.db` in git is a fixture nobody can diff.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const FIXTURE_DIR_REL = "bakeoff/test/tier3-fixtures/persistence";

const HOLLOW_HUNK =
  "// HOLLOW: the handler answers 201 and writes nothing. This is the defect\n" +
  "      // `dataExpectations` exists to catch: a 201 is not evidence of a row.";

const RESTORED_HUNK =
  'db.prepare("INSERT INTO messages (name, email, body, created_at) VALUES (?, ?, ?, ?)")\n' +
  '        .run(String(parsed.name ?? ""), String(parsed.email ?? ""), String(parsed.body ?? ""), new Date().toISOString());';

/** Read the three source files that define the pair. */
export function readFixtureSources(repoRoot) {
  const dir = join(repoRoot, FIXTURE_DIR_REL);
  return {
    dir,
    schema: readFileSync(join(dir, "schema.sql"), "utf8"),
    insert: readFileSync(join(dir, "insert.sql"), "utf8"),
    template: readFileSync(join(dir, "server.mjs.template"), "utf8"),
    manifestRaw: JSON.parse(readFileSync(join(dir, "suite.manifest.json"), "utf8")),
  };
}

/**
 * The manifest as the sealed parser must see it. `__comment` is stripped here
 * and the strip is asserted by the test — a commentary key that survived into
 * the parsed document would make the accept arm test something other than the
 * manifest the container would read.
 */
export function fixtureManifest(repoRoot) {
  const { manifestRaw } = readFixtureSources(repoRoot);
  const copy = { ...manifestRaw };
  delete copy.__comment;
  return copy;
}

function buildOne(sources, root, withInsert) {
  mkdirSync(join(root, "data"), { recursive: true });
  const dbPath = join(root, "data", "app.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sources.schema);
    if (withInsert) db.exec(sources.insert);
  } finally {
    db.close();
  }
  writeFileSync(
    join(root, "server.mjs"),
    sources.template.replace("__PERSIST_HUNK__", withInsert ? RESTORED_HUNK : HOLLOW_HUNK),
  );
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture-g", private: true, type: "module" }, null, 2)}\n`);
  return root;
}

/**
 * Build both sides into `scratch`. Returns the two artefact roots plus the
 * single hunk that separates them, so the caller can assert the pair really is
 * one mutation and has not drifted into two artefacts.
 */
export function buildPersistenceArtefacts(repoRoot, scratch) {
  const sources = readFixtureSources(repoRoot);
  if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true });
  const hollow = buildOne(sources, join(scratch, "persistence-hollow"), false);
  const restored = buildOne(sources, join(scratch, "persistence-restored"), true);
  return {
    hollow,
    restored,
    hollowHunk: HOLLOW_HUNK,
    restoredHunk: RESTORED_HUNK,
    sources,
  };
}

/**
 * The pair's own integrity check. If the two server files differ anywhere
 * except the one hunk, the "paired control" has become two artefacts and the
 * comparison no longer isolates persistence.
 */
export function pairDiffersOnlyInHunk(hollowRoot, restoredRoot) {
  const a = readFileSync(join(hollowRoot, "server.mjs"), "utf8");
  const b = readFileSync(join(restoredRoot, "server.mjs"), "utf8");
  const normalisedA = a.replace(HOLLOW_HUNK, "__PERSIST_HUNK__");
  const normalisedB = b.replace(RESTORED_HUNK, "__PERSIST_HUNK__");
  return { ok: normalisedA === normalisedB && a !== b, normalisedA, normalisedB };
}
