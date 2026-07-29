/**
 * fix-triage.test.ts — routing a gate failure to something that can fix it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { shortlistFor } from "./agent-shortlist.js";
import type { Surface } from "./agent-shortlist.js";
import { ALL_FAILURE_CLASSES } from "./gate-report.js";
import type { AgentVisibleReport, FailureClass, FixableFailure } from "./gate-report.js";
import { agentFor, partitionByPermission, planFixes } from "./fix-triage.js";

function f(klass: FailureClass, detail = "some detail"): FixableFailure {
  return { id: `id-${klass}-${detail.length}`, klass, summary: `${klass} failed`, detail, command: null, exitCode: null };
}

function reportWith(failures: readonly FixableFailure[]): AgentVisibleReport {
  return { failures, heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 }, infraFailure: null };
}

test("each failure class routes to the agent that can actually fix it", () => {
  assert.equal(agentFor("install"), "dependency-manager");
  assert.equal(agentFor("test-infra"), "test-automator");
  assert.equal(agentFor("logic"), "debugger");
  assert.equal(agentFor("structure"), "refactoring-specialist");
  assert.equal(agentFor("visual"), "taste-frontend-expert");
});

test("every routed agent is on the shortlist — an unlisted one is denied by the delegation hook", () => {
  // PHASE 2b TASK 4 ADAPTED THIS CALL, NOT ITS ASSERTION. `shortlistFor` gained a
  // `DesignLaneMode` second argument that DEFAULTS TO "off", so a bare call no
  // longer carries the DESIGN lane and `agentFor("visual")` — taste-frontend-expert
  // — would be denied. The claim under test is "the routing table is a subset of
  // the shortlist for a surface whose lanes are all running", so the lane mode is
  // now stated instead of inherited.
  //
  // THE CONSEQUENCE FOR PRODUCTION IS REAL AND IS NOT FIXED HERE: orchestrator.ts
  // :843 fills the fix loop's `allowedAgents` from a bare `shortlistFor(...)`, so
  // until Task 10 threads the lane mode through it, a `visual` gate failure is
  // partitioned out as unpermitted on EVERY surface, not only on `cli`.
  const allowed = new Set(shortlistFor("fullstack", "full"));
  for (const k of ALL_FAILURE_CLASSES) {
    assert.ok(allowed.has(agentFor(k)), `${k} routes to ${agentFor(k)}, which is not shortlisted`);
  }
});

test("on a surface with no DESIGN lane, the visual route is NOT reachable — and that is measured, not assumed", () => {
  // `taste-frontend-expert` is a DESIGN-lane agent and the DESIGN lane is
  // conditional (agent-shortlist.ts: web-ui and fullstack only). On an `api` or
  // `cli` ticket the delegation hook denies it, and a denied agent produces
  // nothing that looks any different from an agent that had nothing to do. The
  // partition below is what stops that from being silent.
  const cli = new Set(shortlistFor("cli"));
  assert.equal(cli.has(agentFor("visual")), false, "if this ever passes, drop the partition special case");
  for (const k of ALL_FAILURE_CLASSES) {
    if (k === "visual") continue;
    assert.ok(cli.has(agentFor(k)), `${k} routes to ${agentFor(k)}, denied on a cli ticket`);
  }
  // And on every surface, the non-visual routes hold.
  const surfaces: readonly Surface[] = ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"];
  for (const surface of surfaces) {
    const allowed = new Set(shortlistFor(surface));
    for (const k of ALL_FAILURE_CLASSES) {
      if (k === "visual") continue;
      assert.ok(allowed.has(agentFor(k)), `${surface}: ${k} routes to a denied agent`);
    }
  }
});

test("failures for one agent are batched into a single task", () => {
  // Three TS errors are one job for one debugger, not three sequential spawns.
  const tasks = planFixes(reportWith([f("logic"), f("logic", "other"), f("install")]));
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((t) => t.agent === "debugger")?.failures.length, 2);
  assert.equal(tasks.find((t) => t.agent === "dependency-manager")?.failures.length, 1);
});

test("blocking classes are ordered before cosmetic ones", () => {
  // Fixing a visual nit while the build is broken wastes a round.
  const tasks = planFixes(reportWith([f("visual"), f("build")]));
  assert.equal(tasks[0]?.agent, agentFor("build"));
  assert.equal(tasks[1]?.agent, agentFor("visual"));

  // install comes before everything: nothing else can succeed while the
  // dependency tree does not resolve.
  const withInstall = planFixes(reportWith([f("visual"), f("logic"), f("install")]));
  assert.equal(withInstall[0]?.agent, agentFor("install"));
});

test("an infra failure produces no fix work at all", () => {
  const tasks = planFixes({
    failures: [],
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 2, QUALITY: 0 },
    infraFailure: "chromium failed to launch",
  });
  assert.equal(tasks.length, 0);
});

test("held-out criteria alone still produce fix work — the counts are the signal", () => {
  // No tier0 failure and 2 FUNCTIONAL criteria unmet means the visible half
  // passes and the held-out half does not. There is work; it just cannot be
  // named. Producing no task here is how the loop declares victory on a build
  // that does not satisfy the ticket.
  const tasks = planFixes({
    failures: [],
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 2, QUALITY: 0 },
    infraFailure: null,
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.agent, "debugger");
  assert.equal(tasks[0]?.failures.length, 1);
  assert.match(String(tasks[0]?.failures[0]?.detail), /2 FUNCTIONAL/);
  assert.doesNotMatch(JSON.stringify(tasks), /renders the hero/, "counts only, never a title");
});

test("a task routed to an agent this run may not use is separated, not silently run", () => {
  const tasks = planFixes(reportWith([f("visual"), f("logic")]));
  const split = partitionByPermission(tasks, shortlistFor("cli"));
  assert.deepEqual(split.runnable.map((t) => t.agent), ["debugger"]);
  assert.deepEqual(split.denied.map((t) => t.agent), ["taste-frontend-expert"]);
  // The denied work is carried, not dropped — it is what the backlog reports.
  assert.equal(split.denied[0]?.failures.length, 1);
});
