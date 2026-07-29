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

test("the adversary is NOT on any delegation shortlist — wiring it needs agent-shortlist.ts", () => {
  // MEASURED, NOT ASSUMED. If the adversary were spawned through the Agent tool
  // it would be denied by the PreToolUse hook, and a denied agent produces
  // nothing that looks different from an agent with nothing to do. It has to be
  // a top-level call, or its name has to be added to DELIVERY_LANES — which is
  // not this lane's file.
  const surfaces: readonly Surface[] = ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"];
  for (const surface of surfaces) {
    assert.equal(
      shortlistFor(surface).includes(ADVERSARY_AGENT),
      false,
      `${surface} shortlists ${ADVERSARY_AGENT}; if that changed, this module's comment is now wrong`,
    );
  }
});
