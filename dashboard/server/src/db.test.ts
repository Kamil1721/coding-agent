/**
 * db.test.ts — the three columns Phase 2b added, the migration that puts them on
 * a database that predates them, and the seat-attributed spend record.
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
import type { ApiProvider, ApiSpendSeat } from "./api-types.js";
import { RunStore } from "./db.js";
import type { RunRow } from "./db.js";
import { zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";

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

/* -------------------------------------------------------------------------
 * Spend, attributed by seat
 *
 * THE MEASURED DEFECT, IN FOUR NUMBERS. On the live end-to-end run one ticket's
 * OUTPUT tokens were spec 416,111 · audit 17,603 · judge 3,228 · builder 88,529.
 * The run reported 88,529 — the builder's — because that was the only figure
 * anything accumulated; the other 436,942 went to a log line and nowhere else.
 * Every fixture below uses those figures rather than round numbers, so a test
 * that goes red says which seat was dropped.
 * ---------------------------------------------------------------------- */

/** The measured run, as OUTPUT tokens per seat. */
const MEASURED: readonly { readonly seat: ApiSpendSeat; readonly output: number }[] = [
  { seat: "spec", output: 416_111 },
  { seat: "audit", output: 17_603 },
  { seat: "judge", output: 3_228 },
  { seat: "builder", output: 88_529 },
];
const MEASURED_TOTAL = 525_471;
const BUILDER_ONLY = 88_529;

function totals(provider: ApiProvider, output: number, callCount = 1): TokenTotals {
  return { ...zeroTokens(provider), outputTokens: output, inputTokens: 10, callCount };
}

/** Records the measured run, one contribution per seat. Returns the store's dir. */
function seedMeasuredSpend(store: RunStore, runId: string, builderProvider: ApiProvider): void {
  seed(store, runId);
  for (const entry of MEASURED) {
    store.recordSeatSpend(runId, {
      seat: entry.seat,
      modelId: entry.seat === "builder" ? "builder-model" : "claude-opus-5",
      totals: totals(entry.seat === "builder" ? builderProvider : "anthropic", entry.output),
    });
  }
}

function withStore(label: string, body: (store: RunStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `dash-db-${label}-`));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    body(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("THE NEGATIVE CONTROL: a run whose other seats spent 436,942 cannot report the builder's 88,529", () => {
  withStore("spend-total", (store) => {
    seedMeasuredSpend(store, "run-measured", "anthropic");
    const spend = store.runSpend("run-measured");

    // ONE vendor here, so there is exactly one row and it is the run's total.
    assert.equal(spend.byVendor.length, 1, "four anthropic seats are one vendor row");
    const anthropic = spend.byVendor[0];
    assert.ok(anthropic !== undefined);

    // THE EXACT NUMBER, NOT MERELY A DIFFERENT ONE. `notEqual(…, 88_529)` alone
    // survives an accumulation that returns 0, or an empty list, or three seats
    // out of four — every one of which is the same bug wearing a different hat.
    assert.equal(
      anthropic.tokens.outputTokens,
      MEASURED_TOTAL,
      "the run's anthropic output is the sum of every seat that reported",
    );
    assert.notEqual(
      anthropic.tokens.outputTokens,
      BUILDER_ONLY,
      "the builder's own figure is being reported as the run's total — the 16.8% defect, exactly",
    );
    assert.equal(anthropic.callCount, 4, "four contributions, four calls");
    assert.deepEqual(
      [...anthropic.seats],
      ["spec", "audit", "judge", "builder"],
      "the vendor row names the seats folded into it, in the order the run acquired them",
    );
    assert.equal(spend.bySeat.length, 4);
    assert.equal(spend.pricing, "not-priced-subscription-seat");
  });
});

test("a seat that reports twice ADDS — assignment is what lost the design segment", () => {
  withStore("spend-add", (store) => {
    seed(store, "run-twice");
    // The build phase is two `builder.build()` calls against one session, and the
    // GATE/FIX loop adds one round per attempt. `mergeTokenTotals`'s docblock
    // records what assignment did to the run row: a segment that spent 1000
    // followed by one reporting 10 left the run claiming 10.
    store.recordSeatSpend("run-twice", {
      seat: "builder",
      modelId: "claude-opus-5[1m]",
      totals: totals("anthropic", 40_000, 3),
    });
    const second = store.recordSeatSpend("run-twice", {
      seat: "builder",
      modelId: "claude-opus-5[1m]",
      totals: totals("anthropic", 48_529, 2),
    });
    assert.equal(second.tokens.outputTokens, BUILDER_ONLY, "40,000 + 48,529, not 48,529");
    assert.equal(second.callCount, 5, "the call counts add too");
    assert.equal(second.tokens.inputTokens, 20, "every field adds, not just the one being read");
    assert.equal(store.listSeatSpend("run-twice").length, 1, "one seat, one row");
  });
});

test("the same seat on a DIFFERENT model is a second row, not an overwrite", () => {
  withStore("spend-model", (store) => {
    seed(store, "run-remodel");
    // A resumed run against a changed DASHBOARD_SPEC_MODEL spent on two models.
    // One row would label all of it with whichever was written last.
    store.recordSeatSpend("run-remodel", {
      seat: "spec",
      modelId: "claude-opus-5",
      totals: totals("anthropic", 416_111),
    });
    store.recordSeatSpend("run-remodel", {
      seat: "spec",
      modelId: "claude-haiku-4-5",
      totals: totals("anthropic", 1_000),
    });
    const rows = store.listSeatSpend("run-remodel");
    assert.equal(rows.length, 2, "two models, two rows");
    assert.deepEqual(
      rows.map((row) => row.modelId),
      ["claude-opus-5", "claude-haiku-4-5"],
    );
    const spend = store.runSpend("run-remodel");
    assert.equal(spend.byVendor[0]?.tokens.outputTokens, 417_111, "and both are in the total");
    assert.deepEqual([...(spend.byVendor[0]?.seats ?? [])], ["spec"], "one seat, listed once");
  });
});

test("a CODEX run reports two vendor rows and never one cross-vendor number", () => {
  withStore("spend-codex", (store) => {
    // THE CASE THAT MAKES A SINGLE SCALAR IMPOSSIBLE. The builder is OpenAI and
    // spec, audit and judge are Anthropic; tokenizers differ, so 525,471 is not a
    // quantity. `addTokens` THROWS on a vendor mismatch, so this also proves the
    // grouping happens BEFORE the addition — a reduce over the mixed list would
    // not produce a wrong number here, it would take the whole record down.
    seedMeasuredSpend(store, "run-codex", "openai");
    const spend = store.runSpend("run-codex");
    assert.equal(spend.byVendor.length, 2);
    const anthropic = spend.byVendor.find((row) => row.provider === "anthropic");
    const openai = spend.byVendor.find((row) => row.provider === "openai");
    assert.equal(anthropic?.tokens.outputTokens, 436_942, "the three Claude seats");
    assert.equal(openai?.tokens.outputTokens, BUILDER_ONLY, "the Codex builder, alone");
    for (const row of spend.byVendor) {
      assert.notEqual(
        row.tokens.outputTokens,
        MEASURED_TOTAL,
        "a vendor row holding the cross-vendor sum means the vendors were added together",
      );
    }
    assert.deepEqual([...(openai?.seats ?? [])], ["builder"]);
  });
});

test("NOTHING RECORDED is an empty record, not a measurement of zero", () => {
  withStore("spend-empty", (store) => {
    seed(store, "run-silent");
    const spend = store.runSpend("run-silent");
    assert.deepEqual(spend.bySeat, [], "no seat reported");
    assert.deepEqual(spend.byVendor, [], "and no vendor total is invented for one");
    assert.deepEqual(spend.metered, []);
    // The pricing basis is a property of the run, not of whether anything was
    // recorded: a run with no rows still has no dollar figure.
    assert.equal(spend.pricing, "not-priced-subscription-seat");
  });
});

test("metered image and video are counted in calls and seconds, and null is not zero", () => {
  withStore("spend-metered", (store) => {
    seed(store, "run-metered");
    store.recordMeteredSpend("run-metered", {
      kind: "image",
      model: "gemini-3.1-flash-image-preview",
      calls: 3,
      deliveredSecondsFloor: null,
    });
    const image = store.recordMeteredSpend("run-metered", {
      kind: "image",
      model: "gemini-3.1-flash-image-preview",
      calls: 2,
      deliveredSecondsFloor: null,
    });
    assert.equal(image.calls, 5, "attempts add, retries included");
    assert.equal(
      image.deliveredSecondsFloor,
      null,
      "an image call is not billed by time, and null must not become 0 seconds of video",
    );

    store.recordMeteredSpend("run-metered", {
      kind: "video",
      model: "veo-3.1",
      calls: 1,
      deliveredSecondsFloor: 8,
    });
    const video = store.recordMeteredSpend("run-metered", {
      kind: "video",
      model: "veo-3.1",
      calls: 1,
      deliveredSecondsFloor: 8,
    });
    assert.equal(video.calls, 2);
    assert.equal(video.deliveredSecondsFloor, 16, "the floor adds like the calls do");

    const rows = store.listMeteredSpend("run-metered");
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["image", "video"],
      "first-seen order, like the seats",
    );
    // The metered rows are on the spend record and are NOT folded into any token
    // total: they have no tokens, and no dollar figure exists for either.
    assert.equal(store.runSpend("run-metered").metered.length, 2);
    assert.equal(store.runSpend("run-metered").byVendor.length, 0);
  });
});

test("a model id that looks like a credential is redacted on the way in", () => {
  withStore("spend-redact", (store) => {
    seed(store, "run-secret");
    // Rule 1 of this file's header: every persisted string goes through
    // `redactForPersistence`. `createRun` redacts `modelId`; a second write path
    // for the same value that did not would be a hole in a rule the header states
    // as absolute. 44 chars of key alphabet with lower, upper and a digit is the
    // HIGH_ENTROPY_TOKEN rule's own shape.
    const looksLikeAKey = `sk${"Ab3".repeat(14)}xy`;
    assert.ok(looksLikeAKey.length >= 40, "the fixture must actually trip the entropy rule");
    const stored = store.recordSeatSpend("run-secret", {
      seat: "spec",
      modelId: looksLikeAKey,
      totals: totals("anthropic", 1),
    });
    assert.notEqual(stored.modelId, looksLikeAKey, "the raw token reached the database");
    assert.match(stored.modelId, /REDACTED/);

    // BOTH WRITE PATHS, NOT JUST THE ONE. `metered_spend.model` is the design
    // lane's model name and goes through the same chokepoint; a test that covered
    // only the seat table would leave the second path's redaction asserted nowhere.
    const metered = store.recordMeteredSpend("run-secret", {
      kind: "image",
      model: looksLikeAKey,
      calls: 1,
      deliveredSecondsFloor: null,
    });
    assert.notEqual(metered.model, looksLikeAKey);
    assert.match(metered.model, /REDACTED/);
    assert.match(store.listMeteredSpend("run-secret")[0]?.model ?? "", /REDACTED/);
  });
});

test("a database written before the spend tables existed gains them on open", () => {
  // The `CREATE TABLE IF NOT EXISTS` claim, tested the way `ADDED_RUN_COLUMNS` is:
  // by reproducing the older schema rather than by finding the table in a store
  // that was just created. A NEW TABLE needs no `ADDED_RUN_COLUMNS` entry — the
  // whole SCHEMA is exec'd on every `open`, which is exactly what `ADD COLUMN`
  // cannot rely on — and this is what makes that claim more than a comment.
  const dir = mkdtempSync(join(tmpdir(), "dash-db-spend-migrate-"));
  try {
    const databasePath = join(dir, "old.db");
    const old = RunStore.open(databasePath);
    seed(old, "run-old-spend");
    old.close();

    const stripper = new DatabaseSync(databasePath);
    stripper.exec("DROP TABLE seat_spend");
    stripper.exec("DROP TABLE metered_spend");
    const tables = stripper
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row["name"]));
    for (const table of ["seat_spend", "metered_spend"]) {
      assert.ok(!tables.includes(table), `the fixture did not reproduce the older schema: ${table} is still there`);
    }
    stripper.close();

    const reopened = RunStore.open(databasePath);
    try {
      // Present is not the same as writable, and readable is not the same as either.
      assert.deepEqual(reopened.listSeatSpend("run-old-spend"), [], "a run that predates the table recorded nothing");
      const row = reopened.recordSeatSpend("run-old-spend", {
        seat: "judge",
        modelId: "claude-opus-5",
        totals: totals("anthropic", 3_228),
      });
      assert.equal(row.tokens.outputTokens, 3_228);
      assert.equal(reopened.runSpend("run-old-spend").byVendor[0]?.tokens.outputTokens, 3_228);
    } finally {
      reopened.close();
    }
  } finally {
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
