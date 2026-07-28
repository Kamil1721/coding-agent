/**
 * delegation-hook.test.ts — the delegation SHAPE predicate, exercised directly.
 *
 * Phase 1.1 Task 3 lands `isDelegationShaped` alone. The decision it feeds
 * (`decideDelegation`) and the `PreToolUse` hook around it are Task 2, which is
 * blocked on a probe; this file grows when they land.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isDelegationShaped } from "./delegation-hook.js";

test("a call is delegation-shaped by its FIELDS, whatever the tool is called", () => {
  // NO TOOL NAME IS CONSULTED, and that is not stylistic. `toolName === "Agent"`
  // was the whole gate until 2026-07-28, and
  // `mcp__plugin_railway_railway__railway-agent` matched none of it while
  // carrying `isolation: "remote"`. Worse, probe E measured the SAME call
  // arriving as `tool_name: "Agent"` at the hook and as `"Task"` in
  // `permission_denials` — so a name test is wrong roughly half the time even
  // for the built-in tool.
  assert.equal(isDelegationShaped({ subagent_type: "wordpress-master" }), true);
  assert.equal(isDelegationShaped({ isolation: "remote" }), true);
  assert.equal(isDelegationShaped({ run_in_background: true }), true);
});

test("each of the three fields is load-bearing on its own", () => {
  // Deleting any one of them from the predicate turns exactly one of these red.
  // A single `subagent_type ||` test would stay green while the other two were
  // dropped — and dropping them is the fail-open this file exists against: a
  // call carrying only `isolation` or only `run_in_background` steps outside
  // this run's boundaries without ever naming an agent.
  assert.equal(isDelegationShaped({ subagent_type: "code-reviewer", prompt: "go" }), true);
  assert.equal(isDelegationShaped({ isolation: "worktree", prompt: "go" }), true);
  assert.equal(isDelegationShaped({ run_in_background: false, prompt: "go" }), true);
});

test("PRESENT-BUT-MALFORMED is still shaped — a null or wrong-typed field counts", () => {
  // `in` rather than a truthiness test, deliberately. `{run_in_background:
  // false}` is the SAFE value and must still be judged; `{subagent_type: null}`
  // is malformed, not absent, and must reach the decision rather than skip it.
  assert.equal(isDelegationShaped({ subagent_type: null }), true);
  assert.equal(isDelegationShaped({ subagent_type: 42 }), true);
  assert.equal(isDelegationShaped({ isolation: undefined }), true);
});

test("an ordinary tool input is NOT delegation-shaped — the negative control", () => {
  // Without this, "everything is delegation-shaped" would pass every test above
  // while denying every ordinary write the build makes.
  assert.equal(isDelegationShaped({ file_path: "/w/x.ts", content: "hello" }), false);
  assert.equal(isDelegationShaped({ limit: 10 }), false);
  assert.equal(isDelegationShaped({}), false);
});

test("a nested field does not make the call delegation-shaped", () => {
  // The predicate reads the TOP LEVEL, which is where the Agent tool's own
  // schema puts these three. A `content` blob that happens to mention
  // `subagent_type` one level down is an ordinary write, and treating it as a
  // delegation would deny legitimate work while protecting nothing: the nested
  // value is not what the engine would act on.
  assert.equal(isDelegationShaped({ content: { subagent_type: "code-reviewer" } }), false);
});
