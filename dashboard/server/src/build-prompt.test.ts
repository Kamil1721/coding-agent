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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSelfReport, WORKSPACE } from "bakeoff/dist/runner.js";
import { GEMINI_IMAGE_SCRIPT } from "./design-capability.js";
import { DELIVERY_LANES } from "./agent-shortlist.js";
import { dashboardBuilderPrompt, resumeBuilderPrompt, SELF_REPORT_STATUSES } from "./build-prompt.js";
import { designHandoffSection, visualGatePrompt } from "./design-prompt.js";
import { builderReferenceSection } from "./ticket-refs.js";
import { VISUAL_OBSERVATIONS } from "./visual-substance.js";
import { visualCriteriaFor } from "./visual-criteria.js";

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

/**
 * THE ENVIRONMENT SECTION — three facts, three tests, three mutations.
 *
 * WHY SEPARATELY. One test asserting a heading is green over a section that has
 * lost two of its three facts, and losing a fact is exactly the edit a future
 * shortening pass makes. Each fact below is pinned on its own so each can go red
 * on its own; the negative control for each was the deletion of that clause
 * alone, and only its own test failed.
 *
 * WHY THE ASSERTIONS RESTATE THE TEXT INSTEAD OF IMPORTING IT. An exported
 * constant asserted with `p.includes(CONST)` is satisfied by `CONST = ""`. The
 * phrases below are independent restatements, so emptying the section is red.
 */
test("the builder is told it cannot open a port, and what shape that forces", () => {
  // The 2026-07-30 run discovered this AFTER building — "this sandbox denies
  // `listen()` on every port, `EPERM`", its closing message. The consequence is
  // the load-bearing half: a server written but never executed boots for the
  // first time inside the sealed gate, where a failure is a verdict.
  const p = buildPrompt({ ticketText: "an API with a database", allowedAgents: ["backend-developer"] });
  assert.match(p, /cannot open a port/i, "the fact");
  assert.match(p, /EPERM/, "named, so the error message is recognisable when it appears");
  assert.match(p, /exported router function/i, "the shape that survives no-listen");
  assert.match(p, /node --test/, "and how the behaviour gets covered instead");
  assert.match(p, /no socket/i);
});

test("the builder is told the artefact is judged with NO NETWORK, and what needs no install", () => {
  // Its OWN network is unrestricted, so nothing stops it installing; the failure
  // lands later, in `docker run --network=none`, as a boot that cannot happen.
  const p = buildPrompt({ ticketText: "an API with a database", allowedAgents: ["backend-developer"] });
  assert.match(p, /NO NETWORK/, "the container the artefact is judged in");
  assert.match(p, /dependencies must be zero|zero, or\s+already vendored/i, "the requirement");
  assert.match(p, /node:sqlite/, "MEASURED available in the scorer image on v24.18.0");
  assert.match(p, /node:http/);
  assert.match(p, /standard library/i);
});

test("the builder is told to leave the project workable — README and .gitignore", () => {
  // The publish step writes these only when the builder shipped none
  // (project-handover.ts). A fallback is not the same artefact as one written by
  // the agent that knows what the thing reads.
  const p = buildPrompt({ ticketText: "an API with a database", allowedAgents: ["backend-developer"] });
  assert.match(p, /README\.md/);
  assert.match(p, /\.gitignore/);
  // `\s+` because the section is hard-wrapped: the phrase straddles a newline and
  // two spaces of indent, and a literal-space regex is red for the wrong reason.
  assert.match(p, /environment\s+variables it reads/i, "a README that says nothing about config is a stub");
  assert.match(p, /node_modules/);
});

test("the builder is told WHICH PORT to serve on, not merely that it cannot open one", () => {
  // THE GAP THIS CLOSES, MEASURED. The port contract used to live in
  // `dashboardBuilderPrompt` only, and a design-lane run never reaches that
  // function: segment 1 is `designSegmentPrompt` and segment 2 RESUMES it, so the
  // first BUILD turn takes the resume branch. On the real run,
  // `runs/run-2026-07-30T20-16-40-242Z-052c6e02/results/prompt.txt` matches "3000"
  // zero times and "listen" zero times. That build was told it could not open a
  // port and never told which one the gate would probe.
  const p = buildPrompt({ ticketText: "an API with a database", allowedAgents: ["backend-developer"] });
  assert.match(p, /listen on port 3000/i, "the port the scorer probes when the manifest declares no other");
  assert.match(p, /0\.0\.0\.0/, "binding loopback-only by name is the other way a boot gate fails");
  assert.match(p, /ticket names/i, "3000 is the DEFAULT, not the only legal port — spec-agent authors otherwise");
});

test("THE RESUMED BUILD IS TOLD THE PORT TOO — this is the half that was missing", () => {
  // The discriminating assertion of the pair. A copy of the contract inside
  // `dashboardBuilderPrompt` would leave this red, which is the whole point:
  // moving it into the shared section is what fixes the design-lane shape, and
  // duplicating it back would let the two spellings drift.
  const p = resumeBuilderPrompt("the design was locked and the build continues from there");
  assert.match(p, /listen on port 3000/i);
  assert.match(p, /0\.0\.0\.0/);
  assert.match(p, /cannot open a port/i, "and it still knows it cannot try");
});

test("the port default is the DECLARED port, not whatever PORT happens to hold", () => {
  // `scorer-container.ts` starts the artefact with `artifactEnv(null)` — no PORT
  // in the environment — while probing `execution.port`. A server that reads PORT
  // and falls back to something else boots on the wrong port and fails GATE:boot
  // for a reason unrelated to the work.
  const p = buildPrompt({ ticketText: "an API with a database", allowedAgents: ["backend-developer"] });
  assert.match(p, /PORT environment variable/i);
  assert.match(p, /no PORT set/i, "the judge's actual behaviour, stated rather than implied");
});

test("the environment section survives an EMPTY shortlist — it is not part of delegation", () => {
  // Everything else added to this prompt so far renders only when delegation is
  // on. The sandbox does not care how many specialists were shortlisted.
  const p = buildPrompt({ ticketText: "x", allowedAgents: [] });
  assert.match(p, /EPERM/);
  assert.match(p, /NO NETWORK/);
});

test("THE RESUMED BUILD IS TOLD TOO — a design-lane run never sees the first-turn prompt", () => {
  // MEASURED, and this is the arm that would otherwise be uncovered. With the
  // lane on, segment 1 is the design prompt and segment 2 RESUMES it, so
  // `#buildSegmentPrompt` takes its `builderSessionId !== null` branch on the
  // first build turn: `run-2026-07-30T20-16-40-242Z-052c6e02/results/prompt.txt`
  // opens with this function's first line and carries no working agreement. That
  // is the run that ended in the EPERM apology.
  const p = resumeBuilderPrompt("the design was locked and the build continues from there");
  assert.match(p, /EPERM/);
  assert.match(p, /NO NETWORK/);
  assert.match(p, /README\.md/);
});

/**
 * R1 — THE OWNER'S OWN MATERIAL IS THE AUTHORITY, AND THE FORWARD REFERENCE
 * RESOLVES.
 *
 * WHY THE COMPOSITION IS WHAT IS TESTED. `dashboardBuilderPrompt` is never sent
 * on its own: `orchestrator.ts` sends
 * `#buildSegmentPrompt(...) + builderReferenceSection(references)` — cited by the
 * expression rather than by a line, because that file is being edited by another
 * workflow this week and a number would be wrong by the time it is read — so the owner's
 * attached paths arrive from a module this one cannot call and is never handed.
 * A test that only asserted a sentence in this file's own output would be green
 * over a prompt whose forward reference points at a heading nobody writes — which
 * is the exact shape of an instruction that reads well and does nothing.
 *
 * SO THE ASSERTIONS COME IN PAIRS: the clause is in this file's output, and the
 * heading it names is in the other file's output, composed the way production
 * composes them. Deleting the clause is red; renaming either heading is red.
 */
const OWNER_IMAGE = "/runs/r1/refs/owner-hero.png";
const HERO = "/runs/r1/workspace/design-refs/01-hero.png";
const OWNER_REFS = {
  images: [{ path: OWNER_IMAGE, sha256: "a".repeat(64), bytes: 1024 }],
  capture: null,
};

/** Exactly the composition `orchestrator.ts` performs for a first-turn build. */
const composedFirstTurn = (): string =>
  buildPrompt({ ticketText: "rebuild this page", allowedAgents: ["backend-developer"] }) +
  builderReferenceSection(OWNER_REFS);

test("the owner's attached reference is NAMED in the composed build prompt", () => {
  const p = composedFirstTurn();
  assert.ok(p.includes(OWNER_IMAGE), "the absolute path he supplied must reach the builder");
  assert.match(p, /REFERENCES THE OWNER ATTACHED TO THIS TICKET/, "under the heading this file promises");
});

test("and the prompt says his material OUTRANKS the model's defaults", () => {
  // Without this the reference is a list of files at the bottom of a long prompt.
  // The clause is what makes it the authority rather than an input.
  const p = buildPrompt({ ticketText: "rebuild this page", allowedAgents: [] });
  assert.match(p, /WHAT THE WORK IS HELD TO/, "the section exists");
  assert.match(p, /is the authority on how this looks/i, "and says what the files ARE");
  assert.match(p, /outranks your own\s+taste/i, "against the model's own preference");
  assert.match(p, /defaults of any skill you load/i, "and against a loaded skill's recommendation");
  assert.match(p, /before you build anything/i, "read them first, not after");
});

test("THE FORWARD REFERENCE RESOLVES — the two spellings of the heading agree", () => {
  // THE DISCRIMINATING HALF. `build-prompt.ts` quotes a heading that
  // `ticket-refs.ts` owns and that this file cannot import, because exporting it
  // is a change to a module outside this lane. If either side is reworded, the
  // builder is sent to a section that does not exist — and every other assertion
  // in this block stays green while that happens.
  const emitted = builderReferenceSection(OWNER_REFS);
  const quoted = buildPrompt({ ticketText: "x", allowedAgents: [] });
  const heading = "REFERENCES THE OWNER ATTACHED TO THIS TICKET";
  assert.ok(emitted.includes(heading), "ticket-refs.ts no longer emits the heading build-prompt.ts quotes");
  assert.ok(quoted.includes(heading), "build-prompt.ts no longer quotes the heading ticket-refs.ts emits");
});

test("THE RESUMED BUILD IS HELD TO IT TOO — a visual run never sees the first turn", () => {
  // Same measured argument as the environment section: with the design lane on,
  // segment 1 is `designSegmentPrompt` and segment 2 RESUMES it, so
  // `dashboardBuilderPrompt` is never sent. And `builderReferenceSection` is
  // appended on BOTH branches, so a resumed build gets the owner's paths either
  // way. Omitting the clause here puts it exactly where visual runs cannot see it.
  const p = resumeBuilderPrompt("the design was locked and the build continues from there");
  assert.match(p, /WHAT THE WORK IS HELD TO/);
  assert.match(p, /is the authority on how this looks/i);
  assert.ok(p.includes("REFERENCES THE OWNER ATTACHED TO THIS TICKET"));
});

test("with nothing attached, the clause does not send the builder after a section that is absent", () => {
  // `hasReferences` returns "" on most runs, so an unconditional "read the files
  // he gave you" would name a heading nobody wrote — an instruction to open
  // nothing, which is the failure `builderReferenceSection`'s own guard exists to
  // avoid on the other side of the seam.
  assert.equal(builderReferenceSection({ images: [], capture: null }), "");
  const p = buildPrompt({ ticketText: "x", allowedAgents: [] });
  assert.match(p, /Where he attached files/i, "conditional in its wording");
  assert.doesNotMatch(p, /^- Read the files he gave you/im, "not asserted unconditionally");
});

/**
 * THE REDACTION DISCIPLINE, EXTENDED TO THE THING THIS LANE COULD MOST EASILY
 * LEAK.
 *
 * The build prompt's second load-bearing property is "NOTHING ABOUT THE HELD-OUT
 * SUITE beyond `acceptance is judged elsewhere`" (build-prompt.ts, property 2).
 * The obvious leak is the acceptance tests, and this function is never handed
 * them — there is no parameter through which they could arrive.
 *
 * THE REACHABLE LEAK IS THE GRADER'S RUBRIC, and this lane is the one that would
 * introduce it. `visualGatePrompt` legitimately enumerates the visual observation
 * ids and the visual criteria; a well-meaning edit that pasted the same ids into
 * the build prompt — "so the builder knows what it will be judged on" — is
 * teaching to the test, and it would look like an improvement. The two prompts
 * are asserted against each other so the difference is measured rather than
 * assumed: the gate's prompt carries the ids, the builder's must not.
 */
test("the build prompt leaks no grader rubric — not one observation id, not one criterion id", () => {
  const p =
    buildPrompt({ ticketText: "a landing page", allowedAgents: ["taste-frontend-expert"] }) +
    designHandoffSection({
      manifest: {
        version: 1,
        refs: [
          {
            path: HERO,
            section: "hero",
            aspect: "16:9",
            intent: "the hero",
            direction: null,
            origin: null,
          },
        ],
        directions: [],
        chosenDirection: null,
        directionChoice: null,
        lockedMockup: HERO,
        lockedBy: "owner",
        lockedReason: "chosen in the dashboard",
        lockedAt: "2026-07-29T10:00:00.000Z",
      },
      mode: "full",
      workspace: "/runs/r1/workspace",
      dials: "DESIGN_VARIANCE: 3",
    }) +
    builderReferenceSection(OWNER_REFS);

  for (const observation of VISUAL_OBSERVATIONS) {
    assert.ok(!p.includes(observation.id), `the builder is told the observation id ${observation.id}`);
  }
  for (const criterion of visualCriteriaFor({ lockedMockup: HERO })) {
    assert.ok(!p.includes(criterion.id), `the builder is told the criterion id ${criterion.id}`);
  }
  // AND THE POSITIVE CONTROL, so the loops above cannot be green for the wrong
  // reason. Empty id sets would make both loops vacuous, and ids that never
  // appear in ANY prompt would make the whole test unfalsifiable. The GATE's
  // prompt is where they legitimately live, so it is asserted to carry them.
  assert.ok(VISUAL_OBSERVATIONS.length > 0, "an empty observation set makes the assertion vacuous");
  assert.ok(visualCriteriaFor({ lockedMockup: null }).length > 0, "an empty criteria set is vacuous too");
  const gate = visualGatePrompt({ manifest: null, workspace: "/runs/r1/workspace", previewUrl: null });
  assert.ok(
    VISUAL_OBSERVATIONS.some((observation) => gate.includes(observation.id)),
    "the grader's own prompt must carry these ids, or this test is asserting the absence of a string " +
      "that appears nowhere",
  );
});

test("the parts of the prompt Phase 0 depends on are unchanged", () => {
  // Task 4 edits the builder's first turn. The self-report contract and the
  // sealed-suite framing are load-bearing elsewhere (`falseFinish` cannot be
  // computed without the first; the second is what the whole gate protects),
  // and adding a section is not licence to lose them.
  //
  // THE SHAPE ASSERTION THAT USED TO LIVE HERE HAS MOVED, AND THE MOVE IS THE
  // POINT. It ran against `dashboardBuilderPrompt` only, and its companion
  // `/self-report\.json/` would have passed against `resumeBuilderPrompt` too —
  // that prompt interpolated the same path while omitting the shape. So the one
  // check guarding the contract could not observe the failure that actually
  // shipped. It is now `PART N — the self-report contract` below, run against
  // every prompt that can end a build and against the real reader.
  const p = buildPrompt({ ticketText: "the ticket", allowedAgents: ["debugger"] });
  assert.match(p, /acceptance is judged separately/);
  assert.match(p, /the ticket$/, "the ticket text is still last");
});

/* ===========================================================================
 * PART N — the self-report contract, bound to the reader that consumes it
 *
 * WHAT THIS EXISTS TO CATCH, MEASURED. Run `54927ebc` (2026-08-10, 3 h 18 m)
 * ended with the builder writing a valid 14,740-byte `.bakeoff/self-report.json`
 * whose status was `"complete"`. `readSelfReport` accepts exactly
 * `done|blocked|incomplete` and returns `null` for anything else, so the
 * orchestrator recorded `agentDeclaredDone = false` and reported "absent status,
 * or not JSON" — wrong on both counts. `falseFinish = agentDeclaredDone &&
 * !heldOutPass` could not fire. A co-primary metric was disarmed, silently, in
 * the direction that reads as good news.
 *
 * WHY A STRING-MATCH TEST WOULD NOT HAVE CAUGHT IT. The literal was present in
 * `dashboardBuilderPrompt` the whole time. What failed is that a design-lane run
 * never sends that function: segment 1 is `designSegmentPrompt`, segment 2
 * resumes it, and `resumeBuilderPrompt` said "as described earlier" with no
 * earlier. Asserting the string exists somewhere is exactly the check that stayed
 * green through the run it was supposed to prevent.
 *
 * SO THE TEST IS A ROUND TRIP, NOT A MATCH: take the words OUT of the rendered
 * prompt, put each through the REAL reader, and require the reader to accept it.
 * Both ends can then fail. Weakening the prompt (dropping the section, renaming a
 * word) fails at extraction or acceptance; narrowing the reader fails at
 * acceptance. The negative controls below prove the arm is live rather than
 * vacuously green.
 * ======================================================================== */

/**
 * The status words as the BUILDER receives them — parsed back out of rendered
 * prompt text, never imported.
 *
 * IT THROWS RATHER THAN RETURNING `[]`, in three distinct places. An extractor
 * that yields an empty list when its anchor moves turns every assertion
 * downstream into a tautology over nothing, which is this tree's signature
 * defect and the exact way the previous check went blind.
 */
function statusVocabularyFrom(prompt: string, whose: string): readonly string[] {
  const line = prompt.split("\n").find((l) => l.includes('{"status":'));
  if (line === undefined) {
    throw new Error(
      `${whose}: the rendered prompt states no self-report shape at all. A builder reading this ` +
        "prompt has to guess the status vocabulary, and a guess is recorded as no report.",
    );
  }
  const vocabulary = /\{"status":\s*(.+?),\s*"reason"/.exec(line)?.[1];
  if (vocabulary === undefined) {
    throw new Error(`${whose}: the shape line names no status vocabulary: ${line}`);
  }
  const words = [...vocabulary.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  if (words.length === 0) {
    throw new Error(`${whose}: the shape line quotes no status words: ${line}`);
  }
  return words;
}

/**
 * A reason string unique to this probe, so acceptance can be shown to have come
 * from THIS file rather than from anything the reader found lying around.
 */
const PROBE_REASON = "a probe written by build-prompt.test.ts";

/**
 * Put one status through the REAL reader, via a real file, exactly as a run does.
 *
 * IT CHECKS THE REASON CAME BACK, NOT MERELY THAT THE RESULT WAS NON-NULL. A
 * non-null return proves the reader parsed *something*; it does not prove it
 * parsed the file this function wrote. If `WORKSPACE.selfReport` were ever a bare
 * filename, `join(path, "..")` would be the temp root and every assertion here
 * would still pass, for the wrong reason. Comparing the reason back closes that.
 */
function readerAccepts(status: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "self-report-contract-"));
  try {
    const path = join(dir, WORKSPACE.selfReport);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ status, reason: PROBE_REASON }), "utf8");
    const parsed = readSelfReport(dir);
    if (parsed === null) return false;
    assert.equal(
      parsed.reason,
      PROBE_REASON,
      "readSelfReport returned a report that is not the one this probe wrote — the round trip is " +
        "reading some other file, so every acceptance it reports is meaningless",
    );
    assert.equal(parsed.status, status, "the reader changed the status it was given");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ARM CHECK: the probe writes to the nested path the reader actually reads", () => {
  // The premise `readerAccepts` depends on. If the self-report ever stopped being
  // a nested path, the helper would still pass while testing the wrong file.
  assert.ok(
    WORKSPACE.selfReport.includes("/"),
    `WORKSPACE.selfReport is ${WORKSPACE.selfReport}, not a nested path — readerAccepts' mkdirSync is a no-op`,
  );
  assert.ok(readerAccepts("done"), "the happy path must work, or every negative below is vacuous");
});

/**
 * EVERY PROMPT THAT CAN END A BUILD. `#buildSegmentPrompt` (orchestrator.ts:4643)
 * has exactly two branches and these are they, so this list is the complete
 * cover. `buildFixPrompt` is excluded on an ordering fact, not an opinion: the
 * self-report is read at orchestrator.ts:2246 and latched at :2271, both before
 * `#gateFixLoop`'s single call site at :2425, so a fixer's report can change no
 * measurement. `designSegmentPrompt` is excluded because a `done` from a segment
 * that writes no application code would clear the :2378 guard and let the gate
 * score an unbuilt workspace.
 */
const PROMPTS_THAT_CAN_END_A_BUILD: readonly { readonly whose: string; readonly text: string }[] = [
  {
    whose: "dashboardBuilderPrompt (first build turn)",
    text: dashboardBuilderPrompt({
      workspaceDir: "/tmp/run-42/workspace",
      ticketText: "the ticket",
      allowedAgents: ["debugger"],
    }),
  },
  {
    whose: "resumeBuilderPrompt (every design-lane run's FIRST build turn)",
    text: resumeBuilderPrompt("the design was locked and the build continues from there"),
  },
];

test("every status word the builder is shown is one the real reader accepts", () => {
  assert.ok(PROMPTS_THAT_CAN_END_A_BUILD.length > 0, "an empty prompt list makes this vacuous");
  for (const { whose, text } of PROMPTS_THAT_CAN_END_A_BUILD) {
    const shown = statusVocabularyFrom(text, whose);
    assert.ok(shown.length > 0, `${whose}: no words extracted`);
    for (const status of shown) {
      assert.ok(
        readerAccepts(status),
        `${whose} offers "${status}", which readSelfReport rejects. A builder that obeys this ` +
          "prompt would be recorded as having declared nothing.",
      );
    }
  }
});

test("NEGATIVE CONTROL: the arm is live — the word the builder actually guessed is rejected", () => {
  // Not a hypothetical. `"complete"` is what run 54927ebc wrote, and `052c6e02`
  // before it. If this passes, the round trip above is checking nothing, because
  // the reader would accept anything handed to it.
  assert.equal(readerAccepts("complete"), false, "readSelfReport must reject 'complete'");
  assert.equal(readerAccepts("finished"), false, "readSelfReport must reject 'finished'");
  assert.equal(readerAccepts(""), false, "readSelfReport must reject an empty status");
  for (const { whose, text } of PROMPTS_THAT_CAN_END_A_BUILD) {
    assert.ok(
      !statusVocabularyFrom(text, whose).includes("complete"),
      `${whose} must not offer a word the reader rejects`,
    );
  }
});

test("NEGATIVE CONTROL: dropping the contract from a prompt fails loudly, not silently", () => {
  // The failure this whole part exists to prevent, simulated: a prompt that names
  // the FILE but not its SHAPE — which is precisely what `resumeBuilderPrompt`
  // shipped. The old assertion, `/self-report\.json/`, passes on this string.
  const forwardReference = [
    "Continue from where you stopped.",
    `When you are finished, or if you cannot finish, write ${WORKSPACE.selfReport} as described earlier.`,
  ].join("\n");
  assert.match(forwardReference, /self-report\.json/, "the old check would have passed this");
  assert.throws(
    () => statusVocabularyFrom(forwardReference, "a prompt that defers its shape"),
    /states no self-report shape at all/,
    "the extractor must refuse a prompt that only points at the file",
  );
});

test("the two prompts state ONE vocabulary, and it is the constant both are rendered from", () => {
  // Binds the third and fourth copies out of existence. The prompts are rendered
  // from `SELF_REPORT_STATUSES`, which `build-prompt.ts` proves at compile time to
  // be exactly the reader's accepted set; this asserts the rendering survived into
  // the text, on every path, in the same order.
  const [first, ...rest] = PROMPTS_THAT_CAN_END_A_BUILD.map((p) => statusVocabularyFrom(p.text, p.whose));
  for (const other of rest) {
    assert.deepEqual(other, first, "two builder prompts offer different status vocabularies");
  }
  assert.deepEqual(first, [...SELF_REPORT_STATUSES], "the rendered vocabulary drifted from the constant");
});

test("the resume prompt describes the contract instead of deferring it", () => {
  const resumed = resumeBuilderPrompt("the design was locked and the build continues from there");
  assert.doesNotMatch(
    resumed,
    /as described earlier/,
    "a design-lane run has no earlier turn that described it — that forward reference is what broke falseFinish",
  );
  assert.match(resumed, /exactly this shape/, "the resume prompt must state the shape itself");
});

/* ===========================================================================
 * THE SHORT LIST — slight guides, and nothing more
 *
 * The owner's instruction: "It should just have slight guides ... Rest should
 * just be judgement calls." So these tests hold two properties at once: the few
 * things a builder cannot infer ARE stated on every path, and the section does
 * not grow into a style manual or start naming agents the guard would deny.
 * ======================================================================== */

test("the asset rule reaches every prompt that can end a build", () => {
  // design-prompt.ts already said this; build-prompt.ts said none of it, so a UI
  // ticket that never triggered the design lane got no steer at all.
  for (const { whose, text } of PROMPTS_THAT_CAN_END_A_BUILD) {
    assert.match(text, /MADE for this build/, `${whose}: no asset rule`);
    assert.match(text, /No CDN link, no icon font/, `${whose}: the prohibition is not stated`);
    assert.match(text, /gemini-image\.sh/, `${whose}: told what NOT to do and not what to do instead`);
  }
});

test("the tool it names is the one the harness actually has", () => {
  // A prompt that names a tool the environment lacks is the fix-prompt defect
  // over again. Bound to the constant rather than retyped.
  for (const { text } of PROMPTS_THAT_CAN_END_A_BUILD) {
    assert.ok(text.includes(GEMINI_IMAGE_SCRIPT), "the rendered path drifted from GEMINI_IMAGE_SCRIPT");
  }
});

test("it hands the rest back rather than enumerating taste", () => {
  const p = buildPrompt({ ticketText: "the ticket", allowedAgents: ["debugger"] });
  assert.match(p, /That is the whole list/, "the section must close the list explicitly");
  assert.match(p, /your\s+judgement to exercise/, "and hand everything else back");
});

test("NEGATIVE CONTROL: a CLI ticket still sees no design lane and no denied agent", () => {
  // The rule that makes this section safe to add unconditionally: it names the
  // CONSTRAINT, never the agent. delegationSection owns the roster, and naming an
  // agent the guard would deny costs a turn per guess.
  const p = buildPrompt({ ticketText: "a CLI", allowedAgents: ["cli-developer", "debugger"] });
  assert.doesNotMatch(p, /DESIGN/, "a CLI ticket was advertised a design lane");
  assert.doesNotMatch(p, /taste-frontend-expert/, "an agent outside the shortlist was named");
  // ...while the asset rule, which is universal, still applies to it.
  assert.match(p, /MADE for this build/, "the asset rule is not design-lane-only");
});

test("the simplicity clause bounds MACHINERY, not craft", () => {
  /*
   * Run 54927ebc shipped a /work page whose six project cards linked nowhere. The
   * ticket had not said "make them clickable", and the prompt's heading — "SHIP
   * THE SIMPLEST THING THE TICKET ACTUALLY ASKS FOR" — reads as a rule about
   * scope. It was only ever meant as a rule about plumbing.
   *
   * Both halves are asserted, because dropping either one breaks something real:
   * remove the anti-over-engineering bullet and builds bolt on a framework to
   * look busy; remove the craft bullet and they ship the unfinished thing again.
   */
  const p = buildPrompt({ ticketText: "the ticket", allowedAgents: ["debugger"] });
  assert.match(p, /not expected to add a server, a framework or a build step/, "the machinery bound must survive");
  assert.match(p, /about MACHINERY, not about care/, "and must be distinguished from craft");
  assert.match(p, /a reader would notice was missing/, "with the test the builder can actually apply");
  assert.doesNotMatch(
    p,
    /SHIP THE SIMPLEST THING THE TICKET ACTUALLY ASKS FOR/,
    "the heading that was being read as a scope rule is gone",
  );
});

test("the builder is told to infer; the SPEC seat is told not to — and they are different seats", () => {
  // These two instructions look contradictory and are not. Grading someone
  // against a requirement they never wrote is the unfair-criterion class; BUILDING
  // the obvious thing is craft. This pins the split so a future edit cannot
  // "resolve" it by making the builder timid again.
  const p = buildPrompt({ ticketText: "the ticket", allowedAgents: ["debugger"] });
  assert.doesNotMatch(p, /do not invent/i, "the builder must not inherit the spec seat's restraint");
  assert.match(p, /your\s+judgement to exercise/, "the builder is handed the judgement call");
});
