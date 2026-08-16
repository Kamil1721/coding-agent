/**
 * backlog.test.ts — what is still broken, why the loop stopped, and what to do
 * next. Per CLAUDE.md rule 7, a deferred item is never dropped.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import { renderBacklog, writeBacklog } from "./backlog.js";
import { containerFixture, coverageFixture, tier0Fixture } from "./container-fixture.js";
import { toAgentVisible } from "./gate-report.js";
import type { FailureClass, FixableFailure } from "./gate-report.js";
import { planFixes } from "./fix-triage.js";

function f(klass: FailureClass, detail: string): FixableFailure {
  return { id: `id-${klass}`, klass, summary: `${klass} failed`, detail, command: null, exitCode: null };
}

const ZERO = { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 } as const;

test("a stopped run writes what is still broken and why it stopped", () => {
  const md = renderBacklog({
    reason: "retry-cap",
    attempts: 3,
    remaining: [f("logic", "TS2345 at src/app.ts:12")],
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 2, QUALITY: 1 },
  });
  assert.match(md, /retry-cap/);
  assert.match(md, /3 attempts/);
  assert.match(md, /TS2345/);
  assert.match(md, /2 FUNCTIONAL/);
  assert.match(md, /1 QUALITY/);
});

test("every remaining item carries a next action, not just a complaint", () => {
  const md = renderBacklog({
    reason: "not-converging",
    attempts: 2,
    remaining: [f("install", "ERESOLVE"), f("visual", "blank screenshot")],
    heldOutUnmet: ZERO,
  });
  // One "next:" line per remaining item. A backlog entry with no action is a
  // complaint, and an unattended run produces nothing else anyone can act on.
  assert.equal(md.match(/^\s*next: /gm)?.length, 2);
  assert.match(md, /dependency-manager/, "and it names who would do it");
});

test("the backlog NEVER contains a held-out test title", () => {
  // NOT A HAND-BUILT INPUT. The title is planted in every carrier a real
  // ContainerResult has and driven through the REAL redactor and the REAL
  // triage, because a fixture that never contained the title cannot notice a
  // renderer that would have printed it.
  const container = containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.suiteGreen,
        name: "the frozen held-out suite goes green",
        outcome: "fail",
        detail: "output tail: [playwright] 1) held/hero.spec.mjs:12 › renders the hero heading — expected h1",
        command: "npx playwright test held/hero.spec.mjs",
        exitCode: 1,
      }),
    ],
    criterionCoverage: [
      coverageFixture({
        criterionId: "C-1",
        tier: "FUNCTIONAL",
        outcome: "failed",
        testRefs: ["renders the hero heading"],
        detail: "expected h1 to contain 'Kamil'",
      }),
    ],
    suiteExecution: {
      exitCode: 1,
      durationMs: 10,
      testsTotal: 2,
      testsPassed: 1,
      testsFailed: 1,
      timedOut: false,
      reportProblem: "1 failing: renders the hero heading",
      // No suite executed in this fixture, so no failure carried a reason.
      failures: [],
    },
  });
  const report = toAgentVisible(container);
  const md = renderBacklog({
    reason: "retry-cap",
    attempts: 3,
    remaining: report.failures,
    heldOutUnmet: report.heldOutUnmet,
  });

  assert.doesNotMatch(md, /renders the hero/);
  assert.doesNotMatch(md, /expected h1/);
  assert.doesNotMatch(md, /hero\.spec\.mjs/);
  // POSITIVE CONTROL: an empty renderer would satisfy all three above.
  assert.match(md, /1 FUNCTIONAL/, "counts only");
  assert.match(md, /held-out suite goes green/, "the failure itself is still reported");
});

test("a green run still records that nothing was deferred", () => {
  const md = renderBacklog({ reason: "green", attempts: 1, remaining: [], heldOutUnmet: ZERO });
  assert.match(md, /nothing deferred/i);
});

test("an infra stop says the artefact was not measured, rather than listing fixes", () => {
  const md = renderBacklog({
    reason: "infra",
    attempts: 1,
    remaining: [],
    heldOutUnmet: ZERO,
    infraFailure: "chromium failed to launch",
  });
  assert.match(md, /chromium/);
  assert.match(md, /Infrastructure failure/, "this one IS the machine, and says so");
  assert.match(md, /not a verdict|no verdict/i, "an infra stop is not a result about the build");
  assert.doesNotMatch(md, /nothing deferred/i, "an unmeasured build has not deferred nothing — it is unknown");
});

test("a run that stopped before the gate says UNKNOWN, and does not file itself as a machine fault", () => {
  // The run cancelled during spec or build is exactly the run whose "what
  // happened to my ticket?" is least answerable, and writing nothing for it
  // leaves a missing file — which cannot be told apart from a step that never
  // ran (CLAUDE.md rule 7).
  const md = renderBacklog({
    reason: "cancelled",
    attempts: 0,
    remaining: [],
    heldOutUnmet: ZERO,
    infraFailure: "the run was cancelled before the gate produced a result",
  });
  assert.match(md, /UNKNOWN/);
  assert.doesNotMatch(md, /nothing deferred/i, "nothing was measured, so nothing is known to be clean");
  assert.match(md, /Why nothing was measured/, "the owner's own cancel is not an infrastructure failure");
  assert.doesNotMatch(md, /Infrastructure failure/);
});

test("work nothing was allowed to run is in the backlog, with the reason", () => {
  const tasks = planFixes({
    failures: [f("visual", "blank screenshot")],
    heldOutUnmet: ZERO,
    infraFailure: null,
  });
  const md = renderBacklog({
    reason: "not-converging",
    attempts: 1,
    remaining: [f("visual", "blank screenshot")],
    heldOutUnmet: ZERO,
    denied: tasks,
  });
  assert.match(md, /taste-frontend-expert/);
  assert.match(md, /not permitted|denied|shortlist/i);
});

test("the backlog is written to the run's results directory and can be read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-backlog-"));
  try {
    const path = writeBacklog(dir, { reason: "green", attempts: 1, remaining: [], heldOutUnmet: ZERO });
    assert.equal(path, join(dir, "backlog.md"));
    assert.match(readFileSync(path, "utf8"), /nothing deferred/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
