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
import type { RunRow } from "./db.js";

const PHASE_2B_COLUMNS = ["design_segment_done", "design_lock", "interactive"] as const;

/**
 * Phase 2d's pair, migrated on the same terms and tested on the same terms.
 *
 * They are stripped in the SAME fixture as the 2b columns rather than in a
 * second one: `migrateRuns` walks one list, and a test that dropped only the 2d
 * columns could not tell "the 2d entries were added" from "the loop over
 * ADDED_RUN_COLUMNS still works at all".
 */
const PHASE_2D_COLUMNS = ["gate_attempts", "gate_stop_reason"] as const;

/** Returns the created row so a caller can assert on the INSERT's own defaults. */
function seed(
  store: RunStore,
  runId: string,
  extra: { designLock?: "auto" | "ask"; interactive?: boolean } = {},
): RunRow {
  return store.createRun({
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

test("a fresh run has NO gate outcome, and no-outcome is not a green gate", () => {
  // The distinction the whole pair exists for. A run that has not reached the
  // gate must not be readable as one that passed it: `heldOutPass: null` makes
  // the same refusal one field over, and a `gate_stop_reason` column defaulted
  // to 'green' — or a `gateAttempts` that started at 1 — would quietly undo it.
  const dir = mkdtempSync(join(tmpdir(), "dash-db-gate-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    const created = seed(store, "run-fresh");
    assert.equal(created.gateAttempts, 0, "nothing has gated yet, and 0 is the true count");
    assert.equal(created.gateStopReason, null, "no reason has been recorded — NOT `green`");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop's outcome survives the round-trip, both halves of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-db-gate-rt-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-gated");
    const updated = store.updateRun("run-gated", { gateAttempts: 3, gateStopReason: "not-converging" });
    assert.equal(updated.gateAttempts, 3, "three gate runs, not three of anything else");
    assert.equal(updated.gateStopReason, "not-converging");

    // Read back through a SECOND statement, not just the one `updateRun`
    // returns: the return value is `getRun` already, but a column missing from
    // RUN_COLUMNS would fail identically in both, so this pins the persisted
    // row rather than the write path's echo of it.
    const reread = store.getRun("run-gated");
    assert.equal(reread?.gateAttempts, 3);
    assert.equal(reread?.gateStopReason, "not-converging");

    // A green run is a RECORDED outcome and must not read like an absent one.
    const green = store.updateRun("run-gated", { gateAttempts: 1, gateStopReason: "green" });
    assert.equal(green.gateStopReason, "green");
    assert.notEqual(green.gateStopReason, null);
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
    for (const column of [...PHASE_2B_COLUMNS, ...PHASE_2D_COLUMNS]) {
      stripper.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    }
    const columns = stripper
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((row) => String(row["name"]));
    for (const column of [...PHASE_2B_COLUMNS, ...PHASE_2D_COLUMNS]) {
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
      assert.equal(row.gateAttempts, 0, "a run that predates the GATE/FIX loop gated zero times under it");
      assert.equal(row.gateStopReason, null, "and it stopped for no reason this column knows — NOT for `green`");
      // Present is not the same as writable.
      assert.equal(migrated.updateRun("run-old", { designSegmentDone: true }).designSegmentDone, true);
      const patched = migrated.updateRun("run-old", { gateAttempts: 2, gateStopReason: "retry-cap" });
      assert.equal(patched.gateAttempts, 2);
      assert.equal(patched.gateStopReason, "retry-cap");
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
