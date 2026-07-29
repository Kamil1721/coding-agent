/**
 * cron-journal.test.ts — THE TRAP's durable half.
 *
 * Six of the seven ways a tick can end produce the identical observable, "no new
 * run appeared", and only one of them is correct behaviour. These tests are
 * about the one artefact that can tell them apart.
 */

import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CRON_JOURNAL_FILE,
  appendIntent,
  appendOutcome,
  intentsInWindow,
  lastRow,
  orphanIntents,
  readJournal,
  windowRows,
} from "./cron-journal.js";

const URL_ = "http://127.0.0.1:4176";
const base = { dashboardUrl: URL_, modelId: "opus[1m]" };
const dirFor = (name: string): string => mkdtempSync(join(tmpdir(), name));

test("a tick that did NOTHING still leaves a row saying so", () => {
  // THE TRAP. "skipped: nothing queued" and a silent exit produce the same
  // number of runs. They must not produce the same record.
  const dir = dirFor("cron-journal-");
  appendOutcome(dir, {
    ...base,
    tickId: "t1",
    at: "2026-07-30T02:00:00.000Z",
    decision: "skipped",
    reason: "no ticket in the queue",
    ticketFile: null,
    runId: null,
    exitCode: 0,
  });
  const { rows, unreadableLines } = readJournal(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "skipped");
  assert.match(String(rows[0]?.reason), /no ticket/);
  assert.equal(unreadableLines, 0);
});

test("a submission writes an INTENT before the POST and an OUTCOME after", () => {
  const dir = dirFor("cron-journal-pair-");
  appendIntent(dir, {
    ...base,
    tickId: "t1",
    at: "2026-07-30T02:00:00.000Z",
    reason: "about to submit",
    ticketFile: "/q/a.md",
  });
  appendOutcome(dir, {
    ...base,
    tickId: "t1",
    at: "2026-07-30T02:00:01.000Z",
    decision: "submitted",
    reason: "201 Created",
    ticketFile: "/q/a.md",
    runId: "run-1",
    exitCode: 0,
  });
  const { rows } = readJournal(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.phase, "intent");
  assert.equal(rows[0]?.decision, null, "an intent claims no outcome");
  assert.equal(rows[1]?.runId, "run-1");
  assert.equal(orphanIntents(rows).length, 0);
});

test("THE CEILING COUNTS INTENTS, so a tick that died mid-submit still spent its slot", () => {
  // Counting outcomes would leak the ceiling: a tick killed between the rename
  // and the POST would leave no `submitted` row and the next tick would spend
  // again. Counting intents over-charges by at most one and never under-charges.
  const dir = dirFor("cron-journal-ceiling-");
  appendIntent(dir, { ...base, tickId: "t1", at: "2026-07-30T01:00:00.000Z", reason: "x", ticketFile: "/q/a.md" });
  appendIntent(dir, { ...base, tickId: "t2", at: "2026-07-30T02:00:00.000Z", reason: "x", ticketFile: "/q/b.md" });
  appendOutcome(dir, {
    ...base,
    tickId: "t2",
    at: "2026-07-30T02:00:01.000Z",
    decision: "submitted",
    reason: "201",
    ticketFile: "/q/b.md",
    runId: "run-2",
    exitCode: 0,
  });
  const { rows } = readJournal(dir);
  assert.equal(intentsInWindow(rows, "2026-07-30T03:00:00.000Z", 24).length, 2);
  assert.equal(orphanIntents(rows)[0]?.tickId, "t1", "the dead tick is NAMED, not merely counted");
});

test("the window excludes what is older than it, by the row's own timestamp", () => {
  const dir = dirFor("cron-journal-window-");
  for (const at of ["2026-07-28T02:00:00.000Z", "2026-07-30T01:00:00.000Z"]) {
    appendOutcome(dir, {
      ...base,
      tickId: at,
      at,
      decision: "skipped",
      reason: "x",
      ticketFile: null,
      runId: null,
      exitCode: 0,
    });
  }
  const { rows } = readJournal(dir);
  assert.equal(windowRows(rows, "2026-07-30T02:00:00.000Z", 24).length, 1);
  assert.equal(windowRows(rows, "2026-07-30T02:00:00.000Z", 24 * 7).length, 2);
});

test("a corrupt line is SKIPPED AND COUNTED, never treated as absent", () => {
  // A half-written line from a killed process must not make the journal
  // unreadable, and must not silently shrink the ceiling's count either.
  const dir = dirFor("cron-journal-corrupt-");
  appendOutcome(dir, {
    ...base,
    tickId: "t1",
    at: "2026-07-30T02:00:00.000Z",
    decision: "skipped",
    reason: "x",
    ticketFile: null,
    runId: null,
    exitCode: 0,
  });
  appendFileSync(join(dir, CRON_JOURNAL_FILE), '{"tickId":"t2","at":"2026-\n', "utf8");
  const { rows, unreadableLines } = readJournal(dir);
  assert.equal(rows.length, 1);
  assert.equal(unreadableLines, 1, "the report has to be able to say the journal is damaged");
});

test("a line that PARSES but is not a row is also counted, not silently dropped", () => {
  // JSON.parse succeeding is not the same as the row being usable: an `at` the
  // window cannot date would quietly leave the ceiling's count.
  const dir = dirFor("cron-journal-shape-");
  appendFileSync(join(dir, CRON_JOURNAL_FILE), '{"tickId":"t2","at":"whenever","phase":"intent"}\n', "utf8");
  appendFileSync(join(dir, CRON_JOURNAL_FILE), "[1,2,3]\n", "utf8");
  const { rows, unreadableLines } = readJournal(dir);
  assert.deepEqual(rows, []);
  assert.equal(unreadableLines, 2);
});

test("an absent journal reads EMPTY, and empty is a fact the report can state", () => {
  const { rows, unreadableLines } = readJournal(dirFor("cron-journal-none-"));
  assert.deepEqual(rows, []);
  assert.equal(unreadableLines, 0);
  assert.equal(lastRow(rows), null);
});

test("a reason carrying a server error body is redacted on the way to disk", () => {
  const dir = dirFor("cron-journal-redact-");
  appendOutcome(dir, {
    ...base,
    tickId: "t1",
    at: "2026-07-30T02:00:00.000Z",
    decision: "rejected",
    reason: `sk-ant-api03-${"A1b2C3d4E5f6G7h8".repeat(6)}`,
    ticketFile: null,
    runId: null,
    exitCode: 6,
  });
  assert.doesNotMatch(readFileSync(join(dir, CRON_JOURNAL_FILE), "utf8"), /sk-ant-api03-A1b2/);
  assert.match(String(readJournal(dir).rows[0]?.reason), /REDACTED/);
});
