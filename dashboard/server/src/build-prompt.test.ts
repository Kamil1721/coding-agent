/**
 * build-prompt.test.ts — the orchestrator prompt tells the truth about the guard.
 *
 * WHY THIS FILE EXISTS. Phase 1 Task 3 turned delegation on and bounded it by
 * `BuildRequest.allowedAgents`. A boundary the builder is never told about is a
 * boundary it discovers by hitting it, one denied call at a time, at ~1 turn per
 * guess out of a search space of 144 visible agents. Task 4 gives it the list up
 * front. That only helps if the list in the prompt IS the list in the guard, so
 * these tests hold the prompt to the guard's actual behaviour:
 *
 *   NAMED  — every shortlisted agent appears, so none is silently unusable.
 *   BOUNDED — nothing else appears, so no turn is spent on a call that must be
 *             denied. This is the test that catches an illustrative agent name
 *             hardcoded into the prose, which the plan's `general-purpose` check
 *             cannot: it discriminates against the WHOLE registry.
 *   CONVENTION — `run_in_background: false` is stated, because the guard denies
 *             the field's own default and a build that never sets it delegates
 *             exactly zero times.
 *   DENIAL  — a denial is explained as "off this run's list", so the model does
 *             not read it as a broken tool and retry.
 *
 * ON THE ABSENCE OF THE WORD "isolation". The guard denies `isolation` outright
 * (claude-builder.ts, the Agent branch). The prompt still must not mention it:
 * naming a forbidden capability is how a model learns the capability exists, and
 * the guard does not need the prompt's help to deny it. The plan's Task 4 Step 3
 * prose says to state "never pass `isolation`" while the plan's own test for the
 * same step forbids the word — the test is the executable half, and it agrees
 * with the brief this task was given. Recorded as a divergence rather than
 * silently resolved.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DELIVERY_LANES } from "./agent-shortlist.js";
import { dashboardBuilderPrompt } from "./build-prompt.js";

/**
 * The plan's snippets call `buildPrompt({ ticketText, allowedAgents })`. The real
 * signature also carries the workspace, which is not optional in production and
 * is not what these tests are about — so it is supplied here rather than made
 * defaultable in the module, where a default would be a wrong path shipped to a
 * real run.
 */
const buildPrompt = (o: { ticketText: string; allowedAgents: readonly string[] }): string =>
  dashboardBuilderPrompt({ workspaceDir: "/tmp/run-42/workspace", ...o });

/** Every agent in the registry, de-duplicated (`ui-designer` sits in two lanes). */
const EVERY_SHORTLISTABLE_AGENT: readonly string[] = [
  ...new Set(Object.values(DELIVERY_LANES).flat()),
];

test("the prompt names the available specialists and how to reach them", () => {
  const p = buildPrompt({
    ticketText: "build a landing page",
    allowedAgents: ["taste-frontend-expert", "nextjs-developer"],
  });
  assert.match(p, /taste-frontend-expert/);
  assert.match(p, /nextjs-developer/);
  assert.match(p, /run_in_background:\s*false/, "the prompt must state the calling convention");
});

test("the prompt does not promise capabilities the guard denies", () => {
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["debugger"] });
  assert.doesNotMatch(p, /isolation/, "isolation is denied — do not invite it");
  assert.doesNotMatch(p, /general-purpose/, "not on the shortlist");
});

test("no agent outside the caller's list is named, whatever the source says", () => {
  // The sharp version of the test above. A hardcoded example name — "ask
  // code-reviewer to..." — reads as helpful prose and is a guaranteed denial for
  // any caller whose shortlist omits it. Assert against the entire registry, not
  // against one string.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["debugger"] });
  for (const agent of EVERY_SHORTLISTABLE_AGENT) {
    if (agent === "debugger") continue;
    assert.ok(!p.includes(agent), `"${agent}" is named but not on this run's shortlist`);
  }
});

test("every shortlisted agent is named — an omitted one is a specialist nobody knows exists", () => {
  const all = EVERY_SHORTLISTABLE_AGENT;
  const p = buildPrompt({ ticketText: "x", allowedAgents: all });
  for (const agent of all) {
    assert.ok(p.includes(agent), `"${agent}" is allowed by the guard but absent from the prompt`);
  }
});

test("the specialists are grouped by lane, so the order of work is legible", () => {
  // Flat, the list is 26 names and no sequence. Grouped, SPEC precedes BUILD
  // precedes REVIEW, which is the whole point of handing over a list at all.
  const p = buildPrompt({
    ticketText: "x",
    allowedAgents: [
      "context-manager",
      "taste-frontend-expert",
      "backend-developer",
      "code-reviewer",
      "debugger",
    ],
  });
  const at = (needle: string): number => p.indexOf(needle);
  assert.ok(at("SPEC") > 0 && at("DESIGN") > 0 && at("BUILD") > 0 && at("REVIEW") > 0 && at("GATE") > 0);
  assert.ok(at("SPEC") < at("DESIGN"), "SPEC comes before DESIGN");
  // DESIGN's position is the one that is semantically load-bearing and the one a
  // reorder could silently break: art direction that arrives after the markup is
  // a critique, not a direction.
  assert.ok(at("DESIGN") < at("BUILD"), "art direction precedes the markup");
  assert.ok(at("SPEC") < at("BUILD"), "SPEC comes before BUILD");
  assert.ok(at("BUILD") < at("REVIEW"), "REVIEW judges a built tree");
  assert.ok(at("REVIEW") < at("GATE"), "GATE/FIX acts on what REVIEW found");
  assert.ok(at("context-manager") < at("backend-developer"), "agents follow their lane");
});

test("a lane with no shortlisted agent is not advertised", () => {
  // A CLI ticket gets no DESIGN lane. Printing an empty heading invites the
  // model to fill it, and every name it invents is a denial.
  const p = buildPrompt({ ticketText: "a CLI", allowedAgents: ["cli-developer", "debugger"] });
  assert.doesNotMatch(p, /DESIGN/, "no design lane was shortlisted");
});

test("an allowed agent that belongs to no lane is still named", () => {
  // The prompt must never under-report the guard. Lane membership is where these
  // names normally come from, but `allowedAgents` is a plain array a future
  // caller can fill from anywhere; a name the guard permits and the prompt omits
  // is a specialist nobody knows exists.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["debugger", "some-future-agent"] });
  assert.match(p, /some-future-agent/);
});

test("a denial is explained as an off-list agent, not as a broken tool", () => {
  // A model that reads "denied" as a transient failure retries the same call.
  // At ~1 turn per retry that is the run's budget spent on a boundary that will
  // never move.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["debugger"] });
  assert.match(p, /denied/i, "the prompt must anticipate a denial");
  assert.match(
    p,
    /not (a )?(broken|failure|bug)|tool is not broken|retry(ing)? .* (will|cannot)/i,
    "and say retrying it is wasted",
  );
});

test("an empty shortlist advertises no delegation at all — the prompt fails closed too", () => {
  // `allowedAgents: []` is the fail-closed default the guard ships with. A
  // prompt that still described delegation would be describing a capability
  // every call to which is denied.
  const p = buildPrompt({ ticketText: "x", allowedAgents: [] });
  assert.doesNotMatch(p, /subagent_type/, "there is nothing to delegate to");
  for (const agent of EVERY_SHORTLISTABLE_AGENT) {
    assert.ok(!p.includes(agent), `"${agent}" is named with delegation switched off`);
  }
});

/**
 * PHASE 1 TASK 7 — THE REPORT CONTRACT.
 *
 * WHY A PROMPT CLAUSE IS THE LOAD-BEARING PART OF CONTEXT DISCIPLINE. Delegation
 * is not only how the canvas gets a graph; it is the primary context-compression
 * mechanism (spec 15.1). A subagent runs in its OWN context window — it may burn
 * fifty tool calls, read twenty files and write ten, and the parent sees only the
 * final report. That is roughly 50:1 for free, and it is the entire reason a
 * build that touches design, frontend, backend and database fits at all.
 *
 * IT HOLDS ONLY IF REPORTS STAY SMALL. A subagent that hands back 8k tokens of
 * narration puts the problem straight back into the one context that is under
 * pressure. And the failure is silent: the parent's window fills, the SDK
 * compacts, compaction is lossy, and the orchestrator starts forgetting decisions
 * it made an hour ago. The run does not fail — it quietly gets worse, which is
 * strictly worse than stopping, because nothing tells you the output stopped
 * being trustworthy.
 *
 * WHY IT LIVES IN THE ORCHESTRATOR'S PROMPT AND NOWHERE ELSE, MEASURED IN BOTH
 * DIRECTIONS. Spec 15.1 asks for this in "every `AgentDefinition.prompt`", and
 * that route is dead: probe I registered identical definitions under a name that
 * exists in ~/.claude/agents/ and a name that does not, and only the fresh name
 * echoed its definition's nonce and ran its definition's model. `Options.agents`
 * does not bind for a name with a file on disk, and the first test in
 * agent-shortlist.test.ts proves every shortlisted name has one.
 *
 * THE OTHER DIRECTION IS MEASURED TOO, which is what makes this a route rather
 * than a hope. Probe I's S2 delegated to the on-disk `code-reviewer` — the child
 * whose definition was discarded — with an instruction carried ONLY in the Agent
 * call's `prompt` argument, and the child obeyed it and replied with exactly what
 * it asked for and nothing else.
 *
 * AND IT IS AN INSTRUCTION, NOT A BOUND. Nothing checks that the orchestrator
 * pasted the contract into a given call and nothing truncates a subagent that
 * narrates anyway, so these tests pin the TEXT the orchestrator is given — which
 * is the whole of what this program controls — and not compliance with it.
 */
test("every delegated agent is told to return a COMPACT structured report", () => {
  // A subagent runs in its own context and the parent sees only its report.
  // That is the compression. A subagent that narrates 8k tokens hands the
  // problem straight back to the parent.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["backend-developer"] });
  assert.match(p, /report/i);
  assert.match(p, /files (changed|touched)/i, "the report contract must name what to include");
  assert.match(p, /do not (narrate|paste|include the full)/i, "and what to leave out");
});

test("the report contract names all four fields, not just the idea of a report", () => {
  // The plan's own assertions are satisfied by prose that gestures at brevity.
  // A format only compresses if it is a format: four labelled lines the
  // orchestrator can paste into a subagent's prompt verbatim.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["backend-developer"] });
  for (const field of ["DONE", "FILES", "NEXT", "UNRESOLVED"]) {
    assert.match(p, new RegExp(`${field}:`), `the report contract omits ${field}:`);
  }
});

test("the contract is attached to EVERY Agent call — the delivery instruction IS the route", () => {
  // WITHOUT THIS SENTENCE THERE IS NO MECHANISM AT ALL. The contract cannot ride
  // on an `AgentDefinition` (probe I: `Options.agents` does not bind for a name
  // with a file on disk, and every shortlisted name has one), so the only text of
  // ours that reaches a subagent is the `prompt` the orchestrator writes on each
  // Agent call — and that prompt is authored per call. A contract stated once, in
  // the abstract, is attached to no call: the orchestrator has to be told to put
  // it in every one.
  //
  // The other tests in this section pin the FORMAT. This pins the DELIVERY, which
  // is the half that would go missing without a word of the format changing.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["backend-developer"] });
  assert.match(p, /in every `?prompt`? you send/i, "the section must say where it goes");
  assert.match(
    p,
    /end every prompt you send with this/i,
    "and say it as an instruction to repeat per call, not as background",
  );
});

test("the report contract says WHY, because a model that understands complies better", () => {
  // A bare format is followed until the subagent judges that more detail would
  // help — which is exactly the failure. The reason is the part that generalises:
  // the parent's context is the scarce resource and narration spends it.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["backend-developer"] });
  assert.match(p, /context/i, "the reason is about context, and must be stated");
  assert.match(p, /own context (window|of its own)|its own context/i);
});

test("with delegation off, no report contract is advertised either", () => {
  // Same polarity as the rest of this section: `allowedAgents: []` is the guard's
  // fail-closed default, and a report contract for delegation that cannot happen
  // is text the builder pays for and can never use.
  const p = buildPrompt({ ticketText: "x", allowedAgents: [] });
  assert.doesNotMatch(p, /UNRESOLVED/, "nothing will be delegated, so nothing reports back");
});

test("the parts of the prompt Phase 0 depends on are unchanged", () => {
  // Task 4 edits the builder's first turn. The self-report contract and the
  // sealed-suite framing are load-bearing elsewhere (`falseFinish` cannot be
  // computed without the first; the second is what the whole gate protects),
  // and adding a section is not licence to lose them.
  const p = buildPrompt({ ticketText: "the ticket", allowedAgents: ["debugger"] });
  assert.match(p, /self-report\.json/, "the self-report contract survives");
  assert.match(p, /"done" \| "blocked" \| "incomplete"/);
  assert.match(p, /acceptance is judged separately/);
  assert.match(p, /the ticket$/, "the ticket text is still last");
});
