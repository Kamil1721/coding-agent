/**
 * delegation-hook.test.ts — the delegation SHAPE predicate and the decision it
 * feeds, exercised directly.
 *
 * Phase 1.1 Task 3 landed `isDelegationShaped` alone. Task 2 adds
 * `decideDelegation` — the three guards that `canUseTool` was never consulted
 * for — and `makeDelegationHook`, which is where the engine actually asks.
 *
 * THE HOOK ITSELF IS EXERCISED THROUGH `buildOptions`, in
 * claude-builder.test.ts, NOT here. A test that builds its own matcher and
 * invokes it is `settings-plumbing.test.ts` again: it asserts the
 * implementation equals itself and stays green when nothing hands the matcher
 * to the SDK. What lives here is the part that has no wiring — the pure
 * decision.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decideDelegation, isDelegationShaped } from "./delegation-hook.js";

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
});

test("`run_in_background` ALONE is not delegation — it collides with Bash", () => {
  // NARROWED IN TASK 2, AND THE PROVENANCE MATTERS SO NOBODY RE-ADDS IT.
  //
  // The predicate was written for `decideToolPermission`, where `Bash` NEVER
  // ARRIVES: `autoAllowBashIfSandboxed: true` means a sandboxed command is
  // never routed through `canUseTool`. Task 2 moves the decision into a
  // `PreToolUse` hook, and that slot fires for EVERY tool, Bash included
  // (measured). `run_in_background` is not an Agent-only field —
  // `BashInput:548` carries it too, and there it DEFAULTS TO FALSE and means
  // "run this shell command in the background", nothing about delegation.
  //
  // So `Bash{command:"npm run dev", run_in_background:true}` would have been
  // denied with a message that reads "It defaults to true" — false for Bash —
  // and a new production denial this task was never asked to introduce. The
  // field stays in the DECISION (an Agent call must still set it to false) and
  // leaves the ROUTER.
  //
  // Both measured fail-opens still close without it, which is the check that
  // makes this safe rather than convenient: `railway-agent{isolation:"remote"}`
  // is caught by the `isolation` half below, and the bare
  // `Agent{description, prompt}` is caught by the hook's NAME half and then
  // denied on `run_in_background !== false`.
  assert.equal(isDelegationShaped({ run_in_background: true }), false);
  assert.equal(isDelegationShaped({ command: "npm run dev", run_in_background: true }), false);
});

test("each of the two fields is load-bearing on its own", () => {
  // Deleting either one from the predicate turns exactly one of these red. A
  // single `subagent_type ||` test would stay green while `isolation` was
  // dropped — and dropping it is the fail-open this file exists against:
  // `railway-agent{isolation:"remote"}` runs the build off this machine
  // entirely without ever naming an agent or wearing a name we gate on.
  assert.equal(isDelegationShaped({ subagent_type: "code-reviewer", prompt: "go" }), true);
  assert.equal(isDelegationShaped({ isolation: "worktree", prompt: "go" }), true);
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
  // schema puts these fields. A `content` blob that happens to mention
  // `subagent_type` one level down is an ordinary write, and treating it as a
  // delegation would deny legitimate work while protecting nothing: the nested
  // value is not what the engine would act on.
  assert.equal(isDelegationShaped({ content: { subagent_type: "code-reviewer" } }), false);
});

/**
 * THE DECISION — Phase 1.1 Task 2.
 *
 * These three conditions were CORRECT and NEVER CONSULTED. They lived in the
 * Agent branch of `decideToolPermission`, and probe A measured `canUseTool`
 * across `acceptEdits`, `default` AND `dontAsk`: the callback returned deny,
 * was consulted for no tool at all, and `wordpress-master` started anyway. All
 * three were dead in production while the file header described them as an
 * enforced boundary. They move here unchanged in substance, and the hook around
 * them is a slot the engine does ask.
 */
test("a delegation is judged on subagent_type, not on any tool name", () => {
  // Probe E: the hook input says "Agent"; `permission_denials` says "Task" for
  // the SAME call. Neither name is load-bearing, so the decision never sees one
  // — there is no tool-name parameter to pass.
  const denied = decideDelegation(
    { subagent_type: "wordpress-master", run_in_background: false },
    ["code-reviewer"],
  );
  assert.equal(denied.allow, false);
  assert.match(denied.allow ? "" : denied.reason, /wordpress-master/);
  // THE REASON REACHES THE MODEL VERBATIM, as an `is_error` tool_result. It has
  // to name what IS permitted or the model has nothing to do with it.
  assert.match(denied.allow ? "" : denied.reason, /code-reviewer/);

  const allowed = decideDelegation({ subagent_type: "code-reviewer", run_in_background: false }, [
    "code-reviewer",
  ]);
  assert.equal(allowed.allow, true);
});

test("the two guards that died with the shortlist are alive again", () => {
  // All THREE conditions were vacuous, not just the shortlist — `canUseTool` is
  // never consulted for Agent, so nothing reached any of them.
  //
  // `worktree` is MEASURED (probe F, against a real git-repo fixture, so a
  // worktree failure could not be mistaken for a hook effect: the denied call
  // came back with the hook's verbatim reason, not a git error). `remote` is
  // availability-gated and off-host, so it was NOT measured — it is denied by
  // construction anyway, which costs nothing.
  for (const isolation of ["remote", "worktree"]) {
    const iso = decideDelegation(
      { subagent_type: "code-reviewer", isolation, run_in_background: false },
      ["code-reviewer"],
    );
    assert.equal(iso.allow, false, isolation);
    assert.match(iso.allow ? "" : iso.reason, /isolation/);
  }

  // `run_in_background` DEFAULTS TO TRUE for a delegation (AgentInput:504,
  // verbatim: "Agents run in the background by default"), so ABSENCE is the
  // dangerous case and must deny. Measured in all three states — explicit
  // false, explicit true and absent — and gated in each.
  const absent = decideDelegation({ subagent_type: "code-reviewer" }, ["code-reviewer"]);
  assert.equal(absent.allow, false);
  assert.match(absent.allow ? "" : absent.reason, /run_in_background/);

  const explicit = decideDelegation({ subagent_type: "code-reviewer", run_in_background: true }, [
    "code-reviewer",
  ]);
  assert.equal(explicit.allow, false);
});

test("an empty shortlist denies every delegation — the fail-closed default", () => {
  const r = decideDelegation({ subagent_type: "code-reviewer", run_in_background: false }, []);
  assert.equal(r.allow, false);
  assert.match(r.allow ? "" : r.reason, /none configured/);
});

test("a delegation WITHOUT subagent_type denies — it does not abstain", () => {
  // THE FAIL-OPEN THIS FILE HAS ALREADY SHIPPED TWICE. Treating a missing
  // `subagent_type` as "not my business" waves through anything carrying only
  // the other fields — the same shape as the deleted READ_TOOLS name allowlist
  // and the path-KEY allowlist that replaced it. PRESENT-BUT-MALFORMED AND
  // ABSENT BOTH DENY.
  assert.equal(decideDelegation({ isolation: "remote" }, ["code-reviewer"]).allow, false);
  assert.equal(decideDelegation({ run_in_background: false }, ["code-reviewer"]).allow, false);
  // A non-string subagent_type is malformed, not absent, and not a match.
  assert.equal(decideDelegation({ subagent_type: 42, run_in_background: false }, ["code-reviewer"]).allow, false);
  assert.equal(
    decideDelegation({ subagent_type: null, run_in_background: false }, ["code-reviewer"]).allow,
    false,
  );
  // The bare schema-valid Agent call: `subagent_type` is OPTIONAL
  // (sdk-tools.d.ts:496) so this carries NONE of the fields and defaults to
  // background. The hook's NAME half is what routes it here; the decision is
  // what denies it.
  const bare = decideDelegation({ description: "d", prompt: "p" }, ["code-reviewer"]);
  assert.equal(bare.allow, false);
  assert.match(bare.allow ? "" : bare.reason, /run_in_background/);
});

test("NEGATIVE CONTROL: the decision is not a deny-everything stub", () => {
  // Without this, returning `{allow:false}` unconditionally would pass every
  // test above while closing delegation — the whole point of this builder.
  for (const type of ["code-reviewer", "debugger"]) {
    assert.equal(
      decideDelegation({ subagent_type: type, run_in_background: false, prompt: "review src/" }, [
        "code-reviewer",
        "debugger",
      ]).allow,
      true,
      type,
    );
  }
});
