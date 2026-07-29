/**
 * fix-prompt.test.ts — what a fixing agent is told, and what it is bounded to.
 *
 * The leak property is asserted in `gate-fix-loop.test.ts`, at the seam where a
 * real container's report becomes a real prompt. These are the properties of the
 * text itself.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { WORKSPACE } from "bakeoff/dist/runner.js";
import { buildFixPrompt, fixAllowedAgents } from "./fix-prompt.js";
import type { AgentVisibleReport, FixableFailure } from "./gate-report.js";
import type { FixTask } from "./fix-triage.js";

const FAILURE: FixableFailure = {
  id: "GATE:build",
  klass: "build",
  summary: "npm run build",
  detail: "TS2345: Argument of type 'string' is not assignable",
  command: "npm run build",
  exitCode: 2,
};

const TASK: FixTask = { agent: "debugger", failures: [FAILURE] };

function report(patch: Partial<AgentVisibleReport> = {}): AgentVisibleReport {
  return { failures: [FAILURE], heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 }, infraFailure: null, ...patch };
}

test("a fix round may delegate to exactly one agent", () => {
  // The build's own shortlist is ~26 agents because the build is open-ended. A
  // fix round has one job triage already decided; the full shortlist would
  // invite a second exploratory build inside the loop that exists to be bounded.
  assert.deepEqual(fixAllowedAgents(TASK), ["debugger"]);
  assert.equal(fixAllowedAgents({ agent: "test-automator", failures: [] }).length, 1);
});

test("the prompt states the failure, the command and the exit code", () => {
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.match(p, /TS2345/);
  assert.match(p, /npm run build/);
  assert.match(p, /exit code: 2/);
  assert.match(p, /\/w/, "and where the workspace is, so it does not have to guess");
});

test("the prompt names the one agent this round permits", () => {
  // A boundary the fixer cannot see is one it discovers by hitting it, one
  // denied call and one turn at a time.
  assert.match(buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 }), /debugger/);
});

test("the prompt says the budget is finite, and which round this is", () => {
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 2, maxAttempts: 3 });
  assert.match(p, /round 2 of at most 3/);
});

test("the prompt states that editing the visible suite scores nothing", () => {
  // Not a scolding — a mechanical fact. Anthropic measured anti-cheating framing
  // producing HIGHER misalignment than neutral framing (doc 02 §5.6), and a
  // fixer that does not know this wastes its round discovering it.
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.match(p, new RegExp(`${WORKSPACE.visibleDir}/ changes nothing that is scored`));
  assert.doesNotMatch(p, /cheat|hack|misalign/i);
});

test("held-out counts appear as counts, and a satisfied suite says so", () => {
  const unmet = buildFixPrompt({
    task: TASK,
    report: report({ heldOutUnmet: { BLOCKING: 1, FUNCTIONAL: 2, QUALITY: 0 } }),
    workspace: "/w",
    attempt: 1,
    maxAttempts: 3,
  });
  assert.match(unmet, /1 BLOCKING, 2 FUNCTIONAL, 0 QUALITY/);
  assert.match(unmet, /not something I can tell you/);

  const met = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.match(met, /Every acceptance criterion is currently satisfied/);
  assert.doesNotMatch(met, /BLOCKING/, "no phantom counts when there is nothing to count");
});
