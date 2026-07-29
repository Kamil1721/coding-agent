/**
 * db.test.ts — the three columns Phase 2b added, and the migration that puts
 * them on a database that predates them.
 *
 * WHY THIS FILE EXISTS AT ALL. Every other test in this repo opens a store under
 * `mkdtemp`, so `CREATE TABLE IF NOT EXISTS` always includes the newest columns
 * and the migration path is never taken. The owner's `dashboard/data/runs.db`
 * predates them: without the ALTER, a green suite would sit beside a server that
 * throws "column design_lock is absent" on the first `getRun` — and the throw
 * would be on the owner's machine only, which is the worst place to discover it.
 *
 * AND THE MIGRATION IS NOT PROVED BY A COLUMN EXISTING. `ADDED_RUN_COLUMNS` runs
 * `PRAGMA table_info` and skips a column it already sees, so a test that opened a
 * fresh store and found `design_lock` would be green with `migrateRuns` deleted.
 * The old schema is therefore REPRODUCED — `ALTER TABLE ... DROP COLUMN`, which
 * is a real statement in the SQLite that Node 24 ships — and the drop is asserted
 * before the reopen, so the fixture cannot silently stop reproducing anything.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RunStore } from "./db.js";

const PHASE_2B_COLUMNS = ["design_segment_done", "design_lock", "interactive"] as const;

function seed(store: RunStore, runId: string, extra: { designLock?: "auto" | "ask"; interactive?: boolean } = {}): void {
  store.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: runId,
    ticketText: "a portfolio page",
    ticketSha256: "c".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    ...extra,
  });
}

test("a run created with no lock policy records the ABSENCE, not a guess at one", () => {
  // `designLockPolicy("", interactive)` is what turns this into auto or ask. An
  // empty string that had been defaulted to "auto" on the way in would make an
  // interactive run park-or-not depending on a decision nobody wrote down.
  const dir = mkdtempSync(join(tmpdir(), "dash-db-default-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-bare");
    const row = store.getRun("run-bare");
    assert.ok(row !== null);
    assert.equal(row.designLock, "", "nothing was stated, and nothing may be invented");
    assert.equal(row.interactive, false);
    assert.equal(row.designSegmentDone, false, "no segment has run");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock policy and the interactive marker survive the round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-db-policy-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-ask", { designLock: "ask", interactive: true });
    const row = store.getRun("run-ask");
    assert.equal(row?.designLock, "ask");
    assert.equal(row?.interactive, true);

    // `designSegmentDone` is the only one of the three a patch may move: a run
    // whose lock policy changed halfway through is a park with no explanation.
    assert.equal(store.updateRun("run-ask", { designSegmentDone: true }).designSegmentDone, true);
    assert.equal(store.getRun("run-ask")?.designLock, "ask", "the policy did not move with it");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a database written before these columns existed gains them on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-db-migrate-"));
  try {
    const databasePath = join(dir, "old.db");
    const old = RunStore.open(databasePath);
    seed(old, "run-old", { designLock: "ask", interactive: true });
    old.close();

    const stripper = new DatabaseSync(databasePath);
    for (const column of PHASE_2B_COLUMNS) stripper.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    const columns = stripper
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((row) => String(row["name"]));
    for (const column of PHASE_2B_COLUMNS) {
      assert.ok(!columns.includes(column), `the fixture did not reproduce the pre-2b schema: ${column} is still there`);
    }
    stripper.close();

    const migrated = RunStore.open(databasePath);
    try {
      const row = migrated.getRun("run-old");
      assert.ok(row !== null, "the pre-existing run must still be readable");
      assert.equal(row.designSegmentDone, false, "a run that predates the DESIGN lane never ran a design segment");
      assert.equal(row.designLock, "", "and stated no lock policy");
      assert.equal(row.interactive, false);
      // Present is not the same as writable.
      assert.equal(migrated.updateRun("run-old", { designSegmentDone: true }).designSegmentDone, true);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
