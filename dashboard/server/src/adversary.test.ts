/**
 * adversary.test.ts — the ported `/debugfix --web --max` adversary pass.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { shortlistFor } from "./agent-shortlist.js";
import type { Surface } from "./agent-shortlist.js";
import {
  ADVERSARY_AGENT,
  adversaryOptions,
  shouldRunAdversary,
  withAdversaryFindings,
} from "./adversary.js";
import type { AdversaryFinding } from "./adversary.js";
import { planFixes } from "./fix-triage.js";
import type { AgentVisibleReport } from "./gate-report.js";

const EMPTY: AgentVisibleReport = {
  failures: [],
  heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
  infraFailure: null,
};

test("the adversary runs only against a running preview URL", () => {
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://127.0.0.1:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "fullstack", previewUrl: "http://127.0.0.1:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: null }), false, "no URL, no adversary");
  assert.equal(shouldRunAdversary({ surface: "cli", previewUrl: "http://127.0.0.1:4180" }), false);
});

test("a non-loopback URL is refused — the adversary is not pointed at somebody's server", () => {
  // preview.ts serves on 127.0.0.1 and nowhere else, so this can only be reached
  // by a future caller passing something else. It fails closed rather than
  // trusting that caller: the personas include rage-clicking "Pay" and racing
  // two accounts for one resource.
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://example.com" }), false);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://192.168.1.10:4180" }), false);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://localhost:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "not a url" }), false);
});

test("the adversary is mechanically read-only", () => {
  // human-factors-adversary declares disallowedTools covering Write/Edit/Agent
  // and every credential-bearing MCP server. It reports; it never fixes.
  const opts = adversaryOptions({ previewUrl: "http://127.0.0.1:4180" });
  assert.equal(opts.agent, "human-factors-adversary");
  assert.ok(opts.disallowedTools.includes("Write"));
  assert.ok(opts.disallowedTools.includes("Edit"));
  assert.ok(opts.disallowedTools.includes("Agent"), "it does not get to spawn something that can write");
});

test("every tool this module denies is denied by the agent on disk too", () => {
  // The frontmatter is the mechanism; this list is a copy of it, and a copy
  // drifts. If the agent file ever drops one of these, the claim "mechanically
  // read-only" stops being true and this test is what says so.
  const path = join(homedir(), ".claude", "agents", "human-factors-adversary.md");
  const frontmatter = readFileSync(path, "utf8").split("---")[1] ?? "";
  const line = frontmatter.split("\n").find((l) => l.startsWith("disallowedTools:")) ?? "";
  const onDisk = new Set(
    line
      .slice("disallowedTools:".length)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
  assert.ok(onDisk.size > 0, "the agent declares a denylist at all");
  for (const tool of adversaryOptions({ previewUrl: "http://127.0.0.1:4180" }).disallowedTools) {
    assert.ok(onDisk.has(tool), `${tool} is denied here and NOT by the agent on disk`);
  }
});

test("money and destructive attacks are gated to a proven test environment, failing closed", () => {
  // /debugfix section 0.5. The default is PROD-OR-UNKNOWN, which is the state
  // that forbids committing anything, and it is what a caller that says nothing
  // gets.
  const silent = adversaryOptions({ previewUrl: "http://127.0.0.1:4180" });
  assert.equal(silent.environment, "PROD_OR_UNKNOWN");
  assert.match(silent.prompt, /PROD-OR-UNKNOWN/);
  assert.doesNotMatch(silent.prompt, /environment=TEST/, "the unlock is not handed over by accident");

  const unlocked = adversaryOptions({ previewUrl: "http://127.0.0.1:4180", environment: "TEST" });
  assert.equal(unlocked.environment, "TEST");
  assert.match(unlocked.prompt, /environment=TEST/);
});

test("adversary findings become fix tasks, not gate failures", () => {
  // They are evidence, not a sealed verdict. They must not alter heldOutPass.
  const findings: readonly AdversaryFinding[] = [
    { severity: "HIGH", klass: "logic", summary: "double-submit creates two bookings", detail: "10/10 attempts" },
  ];
  const tasks = planFixes(withAdversaryFindings(EMPTY, findings));
  assert.ok(tasks.some((t) => t.agent === "debugger"));
});

test("an adversary finding never moves the held-out counts", () => {
  const before: AgentVisibleReport = {
    failures: [],
    heldOutUnmet: { BLOCKING: 1, FUNCTIONAL: 2, QUALITY: 0 },
    infraFailure: null,
  };
  const after = withAdversaryFindings(before, [
    { severity: "CRITICAL", klass: "logic", summary: "refund abuse nets money" },
  ]);
  assert.deepEqual({ ...after.heldOutUnmet }, { ...before.heldOutUnmet }, "heldOutPass is the sealed verdict");
  assert.equal(after.failures.length, 1);
  assert.match(String(after.failures[0]?.summary), /CRITICAL/, "severity survives so triage can order it");
});

test("no findings means no change at all", () => {
  assert.equal(withAdversaryFindings(EMPTY, []).failures.length, 0);
});

const SURFACES: readonly Surface[] = ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"];

test("the shortlist permits the adversary on exactly the surfaces it would run on", () => {
  // THIS TEST REPLACED ITS OWN NEGATION. It used to assert the adversary was on
  // NO shortlist, which was true and was the gap: a delegated call to an agent
  // off `allowedAgents` is denied by the PreToolUse hook, and a denied agent
  // produces nothing distinguishable from an agent with nothing to do. The name
  // is now in `DELIVERY_LANES.review`.
  //
  // THE ORACLE IS THE OTHER PREDICATE, NOT A SECOND LIST OF SURFACES. "Which
  // surfaces have a browsable UI" is spelled in two modules — `WEB_SURFACES`
  // here and `WEB_REVIEW` plus the switch in `agent-shortlist.ts` — because a
  // permission boundary must not import a feature module that already imports
  // it. Comparing the two spellings against EACH OTHER is what makes them one
  // decision: a permission wider than the intent (shortlisted where the pass
  // will never run) and a permission narrower than it (the pass runs and every
  // delegated call is denied) both fail, and neither could be caught by a list
  // of surfaces written a third time inside this test.
  for (const surface of SURFACES) {
    const permitted = shortlistFor(surface).includes(ADVERSARY_AGENT);
    const intended = shouldRunAdversary({ surface, previewUrl: "http://127.0.0.1:4180" });
    assert.equal(
      permitted,
      intended,
      `${surface}: the shortlist ${permitted ? "permits" : "denies"} ${ADVERSARY_AGENT} and ` +
        `shouldRunAdversary ${intended ? "would run it" : "refuses to"}`,
    );
  }
  // The oracle must not be vacuous: if `shouldRunAdversary` answered the same
  // way for every surface, the loop above would pass against a shortlist that
  // ignored the surface entirely.
  assert.ok(
    SURFACES.some((s) => shouldRunAdversary({ surface: s, previewUrl: "http://127.0.0.1:4180" })) &&
      SURFACES.some((s) => !shouldRunAdversary({ surface: s, previewUrl: "http://127.0.0.1:4180" })),
    "the oracle answers both ways across these surfaces, or the comparison above proves nothing",
  );
});

test("the design lane's mode does not decide whether the adversary may run", () => {
  // `shortlistFor` has a second argument and its DEFAULT is `off`. The adversary
  // sits in REVIEW, not DESIGN, so it must survive a shortlist built with no
  // design lane at all — a web-ui run whose caller has not classified the lane
  // still gets its human-factors pass. Asserted because the two conditionals now
  // live in the same function and one could easily be made to gate the other.
  for (const mode of ["off", "degraded", "full"] as const) {
    assert.ok(
      shortlistFor("web-ui", mode).includes(ADVERSARY_AGENT),
      `a web-ui run with the design lane ${mode} still gets the adversary`,
    );
  }
});
