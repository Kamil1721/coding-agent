/**
 * orchestrator.seat-progress.test.ts — the row that makes a silent seat audible,
 * and the reason it is not allowed to say whatever the model said.
 *
 * ─── THE HAZARD THIS FILE IS MOSTLY ABOUT ───
 *
 * `graph.ts` folds `log` rows into the pre-build lane BY MATCHING PROSE. Ten
 * patterns, seven anchored at the start of the row and three not:
 *
 *   /authoring the held-out acceptance suite/i   -> author  running
 *   /no reference capture/i                      -> capture skipped
 *   /waiting for an answer in the chat/i         -> plan    running
 *
 * A progress row carries an EXCERPT OF WHAT THE MODEL IS WRITING, and the spec
 * seat's own system prompt is about authoring a held-out acceptance suite. A seat
 * quoting its own brief back would move a stage the run has not reached — a
 * display reporting work it never observed, which is this repository's signature
 * defect, arriving through the one channel added to cure it. `capture` flipping to
 * `skipped` is the sharpest case: `settleStage` is first-mention-wins for any
 * non-`running` state, so that row would be permanent.
 *
 * `seatProgressLine` therefore folds its own candidate row through the REAL
 * `foldGraph` and drops the excerpt when the fold reacts. Not a copy of the ten
 * regexes — the fold itself, compared by reference.
 *
 * ─── WHAT THIS FILE CANNOT SEE ───
 *
 * The three `new SubscriptionSeatCaller(...)` sites are on branches that spawn the
 * real CLI, which is the hole `plan-seat.wiring.test.ts` names for attached
 * images. The last test here is structural for the same reason and says so: it
 * reads `orchestrator.ts` and requires every seat constructed in it to pass
 * `onProgress`, so a fourth seat added later is red until it reports too.
 *
 * IT READS ONE FILE, WHICH IS NOT "EVERY SEAT IN THE REPOSITORY". `judge.ts:282`
 * builds a fourth `SubscriptionSeatCaller` — the code-reading judge — and is
 * outside this lane's file list, so that seat is still silent. The test title says
 * "the orchestrator constructs" for that reason and not for style.
 *
 * ─── NEGATIVE CONTROLS ───
 *
 * Applied to production code, run, watched red, reverted — recorded at the tail.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { emptyGraph, foldGraph } from "./graph.js";
import { laneNeutralLogText, seatProgressLine } from "./orchestrator.js";
import type { SeatProgress } from "./subscription-caller.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const LABELS = ["the plan seat", "the spec seat", "the audit seat"] as const;

/**
 * This package's own source, from the COMPILED location of this file.
 *
 * `import.meta.dirname` is `dashboard/server/<outDir>` at run time, so the sources
 * sit one directory up — the same depth argument `contract-parity.test.ts` makes,
 * and every outDir this repo uses honours it. Missing means FAIL, never skip: a
 * source check that quietly stops finding its source is the purest can't-fail
 * check there is.
 */
const ORCHESTRATOR_SRC = join(import.meta.dirname, "..", "src", "orchestrator.ts");

function progress(text: string, overrides: Partial<SeatProgress> = {}): SeatProgress {
  return {
    purpose: "suite-authoring t-progress attempt 1",
    text,
    chars: 12_400,
    elapsedMs: 252_000,
    ...overrides,
  };
}

/** Fold a log row against an untouched canvas and report what it did. */
function foldsInto(text: string): ReturnType<typeof emptyGraph> {
  return foldGraph(emptyGraph(), { type: "log", level: "info", text });
}

/* -------------------------------------------------------------------------
 * 1. The row says how long, how much, and what
 * ---------------------------------------------------------------------- */

test("a progress row reports elapsed, volume and the newest words", () => {
  const line = seatProgressLine("the spec seat", progress("criterion C-014: the hero must render"));

  assert.equal(
    line,
    "the spec seat is still working — 4m12s in, 12,400 characters streamed: " +
      "“criterion C-014: the hero must render”",
  );
});

test("elapsed reads in seconds under a minute", () => {
  const line = seatProgressLine("the audit seat", progress("", { elapsedMs: 38_400, chars: 90 }));
  assert.equal(line, "the audit seat is still working — 38s in, 90 characters streamed");
});

/* -------------------------------------------------------------------------
 * 2. The row is inert against the pre-build lane
 * ---------------------------------------------------------------------- */

test("every seat's progress row leaves the pre-build lane exactly as it found it", () => {
  for (const label of LABELS) {
    const line = seatProgressLine(label, progress("writing the third criterion now"));
    const before = emptyGraph();
    assert.equal(
      foldGraph(before, { type: "log", level: "info", text: line }),
      before,
      `${label}: the progress row moved the lane`,
    );
  }
});

/**
 * THE CONTROL FOR THE CONTROL. If `laneNeutralLogText` were vacuously true — if
 * the fold ignored everything, or the comparison were on a fresh object — the
 * test above would pass over a broken guard. These are the sentences the fold DOES
 * react to, and it must react to them.
 */
test("the neutrality check is not vacuous: the lane's own sentences move it", () => {
  const moving = [
    "spec seat — anthropic: 14 input, 40187 cache read, 8124 cache write, 416111 output",
    "audit seat — anthropic: 3 input",
    "sealed suite 9f2a1c…",
    "captured https://example.com/",
    "reusing the sealed acceptance suite for this ticket text",
    "authoring the held-out acceptance suite from the ticket text alone",
    "the ticket named no page, so there is no reference capture for this run",
    "the plan seat is waiting for an answer in the chat",
  ];
  for (const text of moving) {
    const before = emptyGraph();
    assert.notEqual(foldGraph(before, { type: "log", level: "info", text }), before, text);
    assert.equal(laneNeutralLogText(text), false, text);
  }
});

/* -------------------------------------------------------------------------
 * 3. A dangerous excerpt is dropped, not sanitised and not shipped
 * ---------------------------------------------------------------------- */

/**
 * THE MODEL QUOTING ITS OWN BRIEF. Each of these is prose a spec or audit seat
 * could plausibly stream, and each contains one of the three UNANCHORED patterns,
 * so a prefix cannot defend against them. The row degrades to its measurements —
 * which still says the seat is alive and how far it has got.
 */
test("an excerpt that would move a stage is discarded, and the row survives without it", () => {
  const dangerous = [
    "I am authoring the held-out acceptance suite from the ticket text alone, so",
    "the ticket names no URL, so there is no reference capture to work from and",
    "criterion C-009: the run must show it is waiting for an answer in the chat",
  ];
  for (const text of dangerous) {
    const line = seatProgressLine("the spec seat", progress(text));
    assert.equal(
      line,
      "the spec seat is still working — 4m12s in, 12,400 characters streamed",
      `the excerpt survived: ${line}`,
    );
    const before = emptyGraph();
    assert.equal(foldGraph(before, { type: "log", level: "info", text: line }), before);
  }
});

/**
 * AND THE CONTROL FOR THAT: the very same excerpts, shipped, DO move the lane.
 * Without this, "the excerpt was dropped" could be true of a guard that dropped
 * every excerpt for no reason.
 */
test("those same excerpts, if they were shipped, would close a stage the run never reached", () => {
  const shipped =
    "the spec seat is still working — 4m12s in, 12,400 characters streamed: " +
    "“the ticket names no URL, so there is no reference capture to work from and”";
  const folded = foldsInto(shipped);
  const capture = folded.stages?.find((stage) => stage.id === "capture");
  assert.equal(capture?.state, "skipped");
});

/* -------------------------------------------------------------------------
 * 4. Host paths do not reach the durable row
 * ---------------------------------------------------------------------- */

/**
 * `db.ts`'s `redactForPersistence` recurses everything but carries only CREDENTIAL
 * rules; `/Users/<name>/…` matches none of them. `graph.ts` scrubs on the way to a
 * renderer, which covers the screen and not the `events` table. This is the emit
 * site, so it is the only place that can keep the stored row clean.
 */
test("a host path in the excerpt is rewritten before the row is emitted", () => {
  const line = seatProgressLine(
    "the spec seat",
    progress("reading /Users/kamilborzecki/Projects/coding-agent/ticket.md for context"),
  );
  assert.ok(!line.includes("/Users/"), line);
  assert.ok(line.includes("~/Projects/coding-agent/ticket.md"), line);
});

/* -------------------------------------------------------------------------
 * 5. The wiring, read off the source
 * ---------------------------------------------------------------------- */

/**
 * STRUCTURAL, AND THAT IS AN ADMISSION RATHER THAN A PREFERENCE. Constructing a
 * `SubscriptionSeatCaller` and calling it spawns the CLI and spends the owner's
 * subscription, so the three construction sites are on branches no unit test may
 * drive — the same hole `plan-seat.wiring.test.ts` records for the `images:`
 * argument. What this can still do is refuse a seat that does not report: it
 * counts the constructions and requires the same number of `onProgress:` options
 * among them, so deleting one, or adding a fourth silent seat, is red.
 */
test("every seat the orchestrator constructs is wired to report progress", () => {
  assert.ok(existsSync(ORCHESTRATOR_SRC), `this check reads ${ORCHESTRATOR_SRC} and it is not there`);
  const source = readFileSync(ORCHESTRATOR_SRC, "utf8");
  const constructions = source.match(/new SubscriptionSeatCaller\(/gu) ?? [];
  assert.equal(constructions.length, 3, "the number of seats changed; check each one reports");

  const wired = source.match(/onProgress: this\.#seatProgress\(runId, "[^"]+"\)/gu) ?? [];
  assert.equal(wired.length, constructions.length);
  assert.deepEqual(new Set(wired.map((line) => /"([^"]+)"/u.exec(line)?.[1])), new Set(LABELS));
});

/*
 * ─── MUTATIONS, EACH APPLIED ALONE, WATCHED RED, RESTORED (2026-08-04) ───
 *
 *  M1  orchestrator.ts `seatProgressLine` returns `full` unconditionally (the
 *      lane guard removed)                                    → "an excerpt that
 *      would move a stage is discarded" red. THE CONTROL FOR THE HAZARD THIS FILE
 *      EXISTS FOR.
 *  M2  orchestrator.ts `laneNeutralLogText` returns `true` always
 *                                                             → "the neutrality
 *      check is not vacuous" red and "an excerpt that would move a stage" red.
 *  M3  orchestrator.ts `seatProgressLine` skips `scrubHostPaths`
 *                                                             → "a host path in
 *      the excerpt is rewritten" red.
 *  M4  orchestrator.ts: the `onProgress:` option deleted from the spec seat's
 *      construction                                           → "every seat the
 *      orchestrator constructs is wired" red.
 *  M5  orchestrator.ts `describeElapsed` returns whole minutes only
 *                                                             → 3 red: both
 *      formatting tests, and "an excerpt that would move a stage is discarded",
 *      which compares the degraded row against the same literal head.
 *
 * The `subscription-caller.progress.test.ts` mutations were run against this file
 * too and left it green, which is what makes the two files separate checks rather
 * than one check written twice.
 */
