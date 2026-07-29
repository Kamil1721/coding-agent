/**
 * cron-policy.test.ts — every decision about spending the owner's quota while
 * they are asleep, made where it can be observed without spending anything.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ApiRunStatus, RunSummary } from "../api-types.js";
import { IN_FLIGHT, decideTick } from "./cron-policy.js";

const run = (status: ApiRunStatus, startedAt = "2026-07-30T01:00:00.000Z"): RunSummary => ({
  runId: `run-${status}`,
  ticketTitle: "t",
  modelId: "opus[1m]",
  status,
  startedAt,
  endedAt: null,
  heldOutPass: null,
  falseFinish: null,
});

const input = (over: Partial<Parameters<typeof decideTick>[0]> = {}): Parameters<typeof decideTick>[0] => ({
  now: "2026-07-30T02:00:00.000Z",
  runs: [],
  intentsInWindow: 0,
  queue: ["/q/a.md"],
  maxRunsPerWindow: 4,
  windowHours: 24,
  ...over,
});

test("a run still in flight means SKIP — a second one is not a queue we want", () => {
  // MEASURED, AND IT IS NOT WHAT THE PLAN PREDICTED. This loop iterates
  // `IN_FLIGHT` itself, so it CANNOT see a status missing from that list — with
  // `"awaiting_input"` deleted from `IN_FLIGHT`, this test stayed GREEN (the
  // deleted status simply left the iteration) and only the complement test at
  // the bottom of this file went red. The plan's Task 4 Step 5 expected two red
  // tests here and got one. Recorded rather than repaired: what this test
  // checks is that each listed status yields a skip whose reason NAMES it; what
  // catches an omission is pinning the terminal set, which is the other test's
  // job and is why it pins the complement rather than the list.
  for (const status of IN_FLIGHT) {
    const plan = decideTick(input({ runs: [run(status)] }));
    assert.equal(plan.kind, "skip", `${status} should not be submitted over`);
    assert.match(plan.reason, new RegExp(status));
  }
});

test("every terminal status is submittable — a finished run blocks nothing", () => {
  for (const status of ["passed", "failed", "cancelled"] as const) {
    assert.equal(decideTick(input({ runs: [run(status)] })).kind, "submit", status);
  }
});

test("a rate-limited run defers explicitly, and says which window", () => {
  const plan = decideTick(input({ runs: [run("rate_limited")] }));
  assert.equal(plan.kind, "skip");
  assert.match(plan.reason, /rate.?limit/i);
  assert.match(plan.reason, /5.?hour|window/i, "the reason is the shared window, not a policy preference");
});

test("the CEILING refuses, and the refusal carries the numbers", () => {
  const plan = decideTick(input({ intentsInWindow: 4, maxRunsPerWindow: 4 }));
  assert.equal(plan.kind, "refuse");
  assert.match(plan.reason, /4/);
  assert.match(plan.reason, /24/);
  assert.equal(decideTick(input({ intentsInWindow: 3, maxRunsPerWindow: 4 })).kind, "submit");
});

test("OVERLAP IS CHECKED BEFORE THE CEILING", () => {
  // Otherwise a night spent building burns ceiling slots on refusals, and the
  // report says "the ceiling is spent" about a window in which nothing ran.
  const plan = decideTick(input({ runs: [run("running")], intentsInWindow: 9, maxRunsPerWindow: 4 }));
  assert.equal(plan.kind, "skip");
  assert.match(plan.reason, /running/);
});

test("an empty queue is a SKIP with a reason, never an error and never silence", () => {
  const plan = decideTick(input({ queue: [] }));
  assert.equal(plan.kind, "skip");
  assert.match(plan.reason, /queue/i);
});

test("AN EMPTY QUEUE IS CHECKED BEFORE THE CEILING TOO — a deviation from the plan", () => {
  // THE PLAN'S TABLE PUTS THE CEILING FIRST. It is second here, and the reason is
  // the exit code: `refuse` exits non-zero, and a window whose ceiling was spent
  // once would then make every subsequent tick exit non-zero for the rest of the
  // window even on nights when there was nothing to submit at all. That is a
  // false alarm in `launchd`'s error log, and a scheduler that cries wolf is a
  // scheduler whose real alarms are ignored. A spent ceiling only matters when
  // there is work it is holding back.
  const plan = decideTick(input({ queue: [], intentsInWindow: 4, maxRunsPerWindow: 4 }));
  assert.equal(plan.kind, "skip", "nothing was going to happen, so nothing was refused");
  assert.match(plan.reason, /queue/i);
});

test("exactly one ticket is planned, and it is the first in order", () => {
  const plan = decideTick(input({ queue: ["/q/a.md", "/q/b.md", "/q/c.md"] }));
  assert.equal(plan.kind, "submit");
  assert.equal(plan.kind === "submit" && plan.ticketFile, "/q/a.md");
});

test("IN_FLIGHT names every non-terminal status the wire can carry", () => {
  // A status added to ApiRunStatus and forgotten here would be treated as
  // terminal, and cron would submit over a live run.
  const all: readonly ApiRunStatus[] = [
    "queued",
    "running",
    "awaiting_input",
    "rate_limited",
    "passed",
    "failed",
    "cancelled",
  ];
  const terminal = all.filter((s) => !IN_FLIGHT.includes(s));
  assert.deepEqual([...terminal].sort(), ["cancelled", "failed", "passed"]);
});
