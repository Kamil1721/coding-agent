/**
 * antislop-hook.test.ts — the anti-slop gate END TO END through the object the
 * SDK is actually handed.
 *
 * WHY EVERYTHING HERE GOES THROUGH `buildOptions` AND NOTHING BUILDS ITS OWN
 * MATCHER. `settings-plumbing.test.ts` is this repo's recorded example of the
 * alternative: it asserted that a literal it built itself round-tripped, so the
 * whole boundary could be disconnected from the SDK and the suite stayed green.
 * Every assertion below reads the callback off `buildOptions(...).hooks`, which
 * is the same object `query()` receives, so deleting the registration in
 * `claude-builder.ts` turns this file red.
 *
 * THE FAILURE THIS FILE EXISTS TO CATCH THAT A TEXT-LEVEL TEST CANNOT. The three
 * write tools carry their new text under THREE DIFFERENT KEYS —
 * `FileWriteInput.content`, `FileEditInput.new_string`,
 * `NotebookEditInput.new_source`. A rule set that is perfectly correct about
 * text, wired to the wrong key, scans the empty string forever: it never fires,
 * it never false-positives, and it reports a flawless record. That is the exact
 * shape of the nine false greens this project has already recorded, so every
 * rule is driven through all three payload shapes here.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  HookCallbackMatcher,
  Options,
  PreToolUseHookInput,
  StopHookInput,
  SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { makeAntiSlopHook, makeMotionStopHook, writeTargetOf } from "./antislop-hook.js";
import type { AntiSlopObservation } from "./antislop-hook.js";
import { buildOptions, MOTION_BAR_ENV } from "./claude-builder.js";
import type { BuildRequest } from "./types.js";

const WORKSPACE = "/tmp/dash/runs/r1/workspace";
const SEALED = ["/tmp/dash/acceptance", "/tmp/dash/results/scorer-out"];

function req(overrides: Partial<BuildRequest> = {}): BuildRequest {
  const base: BuildRequest = {
    runId: "r1",
    prompt: "build it",
    workspace: WORKSPACE,
    sealedRoots: SEALED,
    allowedAgents: [],
    modelId: "claude-opus-5",
    effort: null,
    resumeSessionId: null,
    signal: new AbortController().signal,
    sink: {
      log() {},
      tool() {},
      tokens() {},
      rateLimit() {},
      session() {},
      environment() {},
      graph() {},
      contextUsage() {},
      compaction() {},
      raw() {},
    },
    env: {},
  };
  return { ...base, ...overrides };
}

type HookAnswer = {
  continue?: boolean;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

function preToolUse(toolName: string, toolInput: unknown, agentId?: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s-1",
    transcript_path: "/tmp/dash/runs/r1/transcript.jsonl",
    cwd: WORKSPACE,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu-1",
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  };
}

/** Ask the SINGLE chained slot the SDK was handed. */
async function ask(options: Options, toolName: string, toolInput: unknown): Promise<HookAnswer> {
  const slots = options.hooks?.PreToolUse;
  assert.ok(slots, "the SDK was handed NO PreToolUse hook — nothing gates a write");
  assert.equal(slots.length, 1, "ONE slot: probe E never measured which of several carries the decision");
  const slot = slots[0];
  assert.ok(slot);
  assert.equal(slot.matcher, undefined, "the matcher must be OMITTED, not named");
  assert.equal(slot.hooks.length, 1, "ONE callback — the chain flattens, it does not stack");
  const callback = slot.hooks[0];
  assert.ok(callback);
  return (await callback(preToolUse(toolName, toolInput), "tu-1", {
    signal: new AbortController().signal,
  })) as HookAnswer;
}

const SLOP = `<img src="https://picsum.photos/seed/hero/1200/800" alt="">`;
const CLEAN = `<img src="/assets/ada.avif" alt="Ada Lovelace at her desk">`;

/* ─────────────────────────── WIRING: it is handed over ─────────────────────── */

test("WIRING: the anti-slop gate is in the slot the SDK is handed, for all three write tools", async () => {
  // DELETE THE `makeAntiSlopHook(...)` LINE IN `claude-builder.ts` AND THIS GOES
  // RED — which is the whole point of reading the callback off `buildOptions`
  // rather than constructing one here.
  for (const [tool, input] of [
    ["Write", { file_path: `${WORKSPACE}/index.html`, content: SLOP }],
    ["Edit", { file_path: `${WORKSPACE}/index.html`, old_string: "x", new_string: SLOP }],
    ["NotebookEdit", { notebook_path: `${WORKSPACE}/page.tsx`, new_source: SLOP }],
  ] as const) {
    // A FRESH `buildOptions` PER TOOL, because the retry cap is real: three
    // fires of the SAME rule against one options object escalate on the third
    // and ALLOW. Reusing one object here made this test fail for the right
    // reason and the wrong subject.
    const answer = await ask(buildOptions(req(), false), tool, input);
    assert.equal(
      answer.hookSpecificOutput?.permissionDecision,
      "deny",
      `${tool} carries its new text under a different key — a wrong one is a silent no-op`,
    );
    const reason = answer.hookSpecificOutput?.permissionDecisionReason ?? "";
    assert.match(reason, /AS-PLACEHOLDER-IMAGE/, `${tool}: the denial must name the rule`);
    assert.match(reason, /spec §8 Layer 1/, `${tool}: the denial must cite the source`);
    assert.match(reason, /picsum\.photos/, `${tool}: the denial must quote the evidence`);
  }
});

test("WIRING: the motion bar is OFF by default and ARMED by the env flag — both directions", () => {
  // OFF BY DEFAULT ON A MEASUREMENT, not out of timidity. `decideMotion` over
  // `dashboard/src` — this repo's own client, the surface spec decision #6
  // dogfoods — returns `unsatisfied`, so an always-on completion gate would
  // block a legitimate build of a working internal UI. Spec §8 Layer 2 scopes
  // itself to "a FRONTEND agent" and to motion "derived from the design
  // stills", and §6.5 carves out the internal admin CRUD screen explicitly.
  //
  // BOTH DIRECTIONS ARE ASSERTED. "Absent" alone would stay green if the flag
  // were never readable at all — which is exactly a gate that can never arm.
  const off = buildOptions(req(), false);
  assert.equal(off.hooks?.Stop, undefined, "the motion bar must not arm itself");
  assert.equal(off.hooks?.SubagentStop, undefined);

  const on = buildOptions(req({ env: { [MOTION_BAR_ENV]: "1" } }), false);
  assert.equal(on.hooks?.Stop?.length, 1, "the flag did not arm the Stop slot — the gate is unreachable");
  assert.equal(on.hooks?.SubagentStop?.length, 1, "subagents would be ungated");
  // ONE INSTANCE, TWO SLOTS: the escalate-after budget lives in the hook's
  // closure, so two instances would give Stop and SubagentStop independent
  // budgets and a run could be blocked twice as often as designed.
  assert.equal(
    on.hooks?.Stop?.[0],
    on.hooks?.SubagentStop?.[0],
    "the two slots must share ONE hook, or they share no budget",
  );
});

test("NEGATIVE CONTROL: a clean write is ALLOWED", async () => {
  // The half that stops this whole phase being "a builder that cannot work".
  const answer = await ask(buildOptions(req(), false), "Write", {
    file_path: `${WORKSPACE}/index.html`,
    content: CLEAN,
  });
  assert.equal(answer.continue, true);
  assert.equal(answer.hookSpecificOutput, undefined);
});

test("NEGATIVE CONTROL: the same text in a `.md` is ALLOWED", async () => {
  // Prose ABOUT pages is not a page. Without this the model could not write down
  // why it was denied, because the denial quotes the banned literal.
  const answer = await ask(buildOptions(req(), false), "Write", {
    file_path: `${WORKSPACE}/NOTES.md`,
    content: SLOP,
  });
  assert.equal(answer.continue, true);
});

test("NEGATIVE CONTROL: tools that are not writes fall straight through", async () => {
  // THE SLOT FIRES FOR EVERY TOOL, BASH INCLUDED (measured). Anything not judged
  // MUST come back `{continue:true}`, or the gate stops being a gate and becomes
  // a session that cannot do anything — a failure that reads as a broken builder
  // rather than as a regression, which is how it would be "fixed".
  const options = buildOptions(req(), false);
  for (const [tool, input] of [
    ["Bash", { command: "npm run build" }],
    ["Read", { file_path: `${WORKSPACE}/index.html` }],
    ["Grep", { pattern: "picsum", path: WORKSPACE }],
    ["TodoWrite", { todos: [{ content: SLOP, status: "pending" }] }],
    ["WebFetch", { url: "https://picsum.photos/200", prompt: "what is this" }],
  ] as const) {
    const answer = await ask(options, tool, input);
    assert.equal(answer.continue, true, `${tool} must not be gated by a craft rule`);
  }
});

test("NEGATIVE CONTROL: a malformed tool_input does not throw", async () => {
  // A hook that throws is an unhandled rejection on the SDK's own reader loop
  // and takes the whole run down.
  const options = buildOptions(req(), false);
  for (const input of [null, undefined, "a string", [1, 2, 3], 42]) {
    const answer = await ask(options, "Write", input);
    assert.equal(answer.continue, true, `tool_input=${JSON.stringify(input)}`);
  }
});

/* ─────────────────── the chain: delegation keeps its precedence ─────────────── */

test("the chain does not disturb delegation: an off-shortlist agent keeps ITS reason", async () => {
  // ORDER IS THE INTERFACE. If anti-slop ran first, or if the chain merged
  // reasons, the model would be told about a craft rule when what it actually
  // hit was the delegation boundary. Two of the delegation strings are pinned by
  // `delegation-hook.test.ts`; this asserts they still reach the model UNCHANGED
  // through the chain.
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const answer = await ask(options, "Agent", {
    subagent_type: "wordpress-master",
    run_in_background: false,
    prompt: "build it",
  });
  assert.equal(answer.hookSpecificOutput?.permissionDecision, "deny");
  const reason = answer.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.match(reason, /wordpress-master` is not available to this run/);
  assert.match(reason, /code-reviewer/);
  assert.doesNotMatch(reason, /craft floor/, "a delegation denial must not be reworded by a craft rule");
});

test("the chain does not disturb delegation: a shortlisted agent is still ALLOWED", async () => {
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const answer = await ask(options, "Agent", {
    subagent_type: "code-reviewer",
    run_in_background: false,
    prompt: "review src/",
  });
  assert.equal(answer.continue, true);
});

test("the chain does not disturb delegation: SendMessage is still denied outright", async () => {
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const answer = await ask(options, "SendMessage", { to: "a1", content: "keep going" });
  assert.equal(answer.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(answer.hookSpecificOutput?.permissionDecisionReason ?? "", /SendMessage` is not available/);
});

/* ───────────────────────── shape routing, not tool name ───────────────────── */

test("routing is by SHAPE: an unknown mcp writer is scanned, a message is not", () => {
  // The READ_TOOLS lesson, twice paid for here: a name allowlist is fail-open to
  // every tool nobody enumerated.
  assert.deepEqual(writeTargetOf({ path: "/ws/a.css", content: "x" }), { path: "/ws/a.css", text: "x" });
  // A body with no path is not a write. `SendMessage{to, content}` must not be
  // read as one — it is denied a link earlier, and a craft rule reading its body
  // would report the wrong thing if it ever were not.
  assert.equal(writeTargetOf({ to: "a1", content: "keep going" }), null);
  // `old_string` is the text being REMOVED and is never scanned.
  assert.equal(writeTargetOf({ file_path: "/ws/a.css", old_string: "x" }), null);
});

/* ──────────────────────────── the retry cap ──────────────────────────── */

/** Drive the anti-slop hook alone, so the counter under test is the only state. */
async function fire(
  hook: HookCallbackMatcher,
  input: PreToolUseHookInput,
): Promise<HookAnswer> {
  const callback = hook.hooks[0];
  assert.ok(callback);
  return (await callback(input, "tu-1", { signal: new AbortController().signal })) as HookAnswer;
}

test("the SAME rule firing 3x ESCALATES and ALLOWS — it does not loop", async () => {
  // SPEC §8: "the same rule firing 3x escalates to the orchestrator rather than
  // looping." ESCALATE-AND-ALLOW, and the direction is deliberate: a model told
  // the same thing twice that writes it a third time is either right about its
  // context or stuck, and another denial produces a loop that burns the run's
  // turns and surfaces as a build that mysteriously never finished. Layer 1 is a
  // craft gate, not a boundary — a security rule would never be written this way.
  const seen: AntiSlopObservation[] = [];
  const hook = makeAntiSlopHook({ observe: (o) => seen.push(o) });
  const input = preToolUse("Write", { file_path: "/ws/index.html", content: SLOP });

  assert.equal((await fire(hook, input)).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((await fire(hook, input)).hookSpecificOutput?.permissionDecision, "deny");
  const third = await fire(hook, input);
  assert.equal(third.continue, true, "the third fire must ALLOW, or the builder is wedged");
  assert.equal(third.hookSpecificOutput, undefined);

  assert.deepEqual(
    seen.map((o) => o.decision),
    ["deny", "deny", "escalated"],
  );
  // The escalation must still carry the evidence, or the orchestrator is told
  // "something happened" and can do nothing with it.
  assert.match(seen[2]?.evidence ?? "", /picsum\.photos/);
});

test("the budget is per (rule, agent): one stubborn lens does not disarm the rule", async () => {
  const hook = makeAntiSlopHook({});
  const write = (agent: string): PreToolUseHookInput =>
    preToolUse("Write", { file_path: "/ws/index.html", content: SLOP }, agent);
  await fire(hook, write("a1"));
  await fire(hook, write("a1"));
  // a1 has spent its budget; a2 must still be denied on ITS first fire.
  const other = await fire(hook, write("a2"));
  assert.equal(other.hookSpecificOutput?.permissionDecision, "deny");
  // …and a1's third is the escalation, so the two counters really are separate.
  assert.equal((await fire(hook, write("a1"))).continue, true);
});

test("the budget is per RULE: a different rule is denied on its own first fire", async () => {
  const hook = makeAntiSlopHook({});
  const placeholder = preToolUse("Write", { file_path: "/ws/index.html", content: SLOP });
  await fire(hook, placeholder);
  await fire(hook, placeholder);
  assert.equal((await fire(hook, placeholder)).continue, true, "placeholder budget spent");
  const lorem = preToolUse("Write", {
    file_path: "/ws/about.html",
    content: "<p>Lorem ipsum dolor sit amet.</p>",
  });
  assert.equal(
    (await fire(hook, lorem)).hookSpecificOutput?.permissionDecision,
    "deny",
    "one exhausted rule must not disarm the others",
  );
});

test("an observer that THROWS cannot change or break the decision", async () => {
  const hook = makeAntiSlopHook({
    observe: () => {
      throw new Error("instrumentation blew up");
    },
  });
  const answer = await fire(hook, preToolUse("Write", { file_path: "/ws/index.html", content: SLOP }));
  assert.equal(answer.hookSpecificOutput?.permissionDecision, "deny");
});

/* ───────────────────── Layer 2: the completion gate, wired ──────────────── */

function stopInput(active: boolean, agentId?: string): StopHookInput | SubagentStopHookInput {
  return {
    hook_event_name: "Stop",
    session_id: "s-1",
    transcript_path: "/tmp/dash/runs/r1/transcript.jsonl",
    cwd: WORKSPACE,
    stop_hook_active: active,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  } as StopHookInput;
}

const STOCK_WORKSPACE = [
  { path: "/ws/index.html", text: "<header class='hero'><h1>Ada</h1></header>" },
  { path: "/ws/style.css", text: ".card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);transition:box-shadow .3s}" },
  { path: "/ws/app.js", text: "document.querySelector('form').addEventListener('submit', e => e.preventDefault());" },
];

test("Layer 2 BLOCKS a stock-motion completion, with a reason that lists the ways out", async () => {
  const hook = makeMotionStopHook(async () => STOCK_WORKSPACE);
  const callback = hook.hooks[0];
  assert.ok(callback);
  const answer = (await callback(stopInput(false), undefined, {
    signal: new AbortController().signal,
  })) as HookAnswer;
  assert.equal(answer.decision, "block");
  assert.match(answer.reason ?? "", /scroll-scrubbed/i);
  assert.match(answer.reason ?? "", /rAF-driven/i);
});

test("Layer 2 ALLOWS a completion that carries authored motion", async () => {
  const hook = makeMotionStopHook(async () => [
    { path: "/ws/index.html", text: "<main></main>" },
    { path: "/ws/app.js", text: "requestAnimationFrame(() => el.style.transform = `translateY(${scrollY}px)`);" },
  ]);
  const callback = hook.hooks[0];
  assert.ok(callback);
  const answer = (await callback(stopInput(false), undefined, {
    signal: new AbortController().signal,
  })) as HookAnswer;
  assert.equal(answer.continue, true);
});

test("Layer 2 ABSTAINS when `stop_hook_active` says it already blocked once", async () => {
  // The SDK's own re-entrancy flag. Ignoring it is how a completion gate loops
  // forever on an artefact it will never accept.
  const hook = makeMotionStopHook(async () => STOCK_WORKSPACE);
  const callback = hook.hooks[0];
  assert.ok(callback);
  const answer = (await callback(stopInput(true), undefined, {
    signal: new AbortController().signal,
  })) as HookAnswer;
  assert.equal(answer.continue, true);
});

test("Layer 2 ESCALATES after two blocks rather than blocking forever", async () => {
  const seen: AntiSlopObservation[] = [];
  const hook = makeMotionStopHook(async () => STOCK_WORKSPACE, { observe: (o) => seen.push(o) });
  const callback = hook.hooks[0];
  assert.ok(callback);
  const call = async (): Promise<HookAnswer> =>
    (await callback(stopInput(false), undefined, { signal: new AbortController().signal })) as HookAnswer;
  assert.equal((await call()).decision, "block");
  assert.equal((await call()).decision, "block");
  assert.equal((await call()).continue, true, "the third must let the run finish");
  assert.deepEqual(
    seen.map((o) => o.decision),
    ["deny", "deny", "escalated"],
  );
});

test("Layer 2 ABSTAINS when the workspace cannot be read — absence is not evidence", async () => {
  const hook = makeMotionStopHook(async () => {
    throw new Error("ENOENT");
  });
  const callback = hook.hooks[0];
  assert.ok(callback);
  const answer = (await callback(stopInput(false), undefined, {
    signal: new AbortController().signal,
  })) as HookAnswer;
  assert.equal(answer.continue, true);
});
