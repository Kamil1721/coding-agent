/**
 * agent-shortlist.test.ts — the curated delegation shortlist, checked against disk.
 *
 * WHY THIS FILE EXISTS. Phase 1 Task 1 set `settingSources: ["user"]`, which makes
 * 144 of the owner's agents visible to the orchestrator. Visibility is not
 * permission: the boundary is the `PreToolUse` hook in
 * `builders/delegation-hook.ts`, and this module compiles the list it is fed.
 * (It was written as the `canUseTool` Agent branch in Phase 0. Probe A then
 * measured that callback asked about NO TOOL AT ALL when the model delegates —
 * under `acceptEdits`, `default` and `dontAsk` alike — and the branch was deleted
 * in Phase 1.1 Task 2 rather than left reading like a guard.) 144 agents is a
 * noisy search space; the shortlist is the curation.
 *
 * The FIRST test is the load-bearing one. A misspelled agent name is a SILENT
 * capability loss — the orchestrator asks for an agent that does not exist, the
 * hook denies it, and the lane quietly does nothing. Nothing downstream notices,
 * because a lane that produced no output is indistinguishable from a lane that
 * had nothing to do. So the names are asserted against the frontmatter on disk
 * rather than reviewed by eye.
 *
 * THAT SAME TEST IS ALSO WHAT MAKES `Options.agents` UNREACHABLE, which is why
 * `buildOptions` no longer sends per-agent definitions: probe I measured them not
 * binding for a name that exists on disk, and every name below does.
 *
 * Note the key that trap is set on: `trigger-dev-expert` lives in a file called
 * `trigger-dev-task-writer.md`. `subagent_type` matches the frontmatter `name:`,
 * never the filename.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { DELIVERY_LANES, boundsFor, laneOf, shortlistFor } from "./agent-shortlist.js";

const SURFACES = ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"] as const;

/** `Object.entries` over a const-asserted object widens badly; the cast keeps this readable. */
const LANES = Object.entries(DELIVERY_LANES) as ReadonlyArray<[string, readonly string[]]>;

test("every shortlisted agent exists on disk", () => {
  // A typo here is a silent capability loss: the orchestrator asks for an agent
  // that does not exist, the PreToolUse hook denies it, and the lane quietly does
  // nothing.
  const dir = join(homedir(), ".claude", "agents");
  const onDisk = new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fm = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 12);
        const name = fm.find((l) => l.startsWith("name:"));
        return name ? name.slice(5).trim() : basename(f, ".md");
      }),
  );
  for (const [lane, agents] of LANES) {
    for (const a of agents) assert.ok(onDisk.has(a), `${lane}: "${a}" is not an agent on disk`);
  }
});

test("trigger-dev-expert is keyed by its frontmatter name, not its filename", () => {
  // trigger-dev-task-writer.md declares `name: trigger-dev-expert`. Keying it by
  // filename would compile, pass review, and be denied at runtime.
  const build: readonly string[] = DELIVERY_LANES.build;
  assert.ok(build.includes("trigger-dev-expert"));
  assert.ok(!build.includes("trigger-dev-task-writer"), "the filename is not a subagent_type");
});

test("a CLI ticket gets no design lane", () => {
  const s = shortlistFor("cli");
  assert.ok(!s.includes("taste-frontend-expert"), "no design agent for a CLI ticket");
  assert.ok(s.includes("cli-developer"));
});

test("a web-ui ticket gets the design lane and the frontend build agents", () => {
  // PHASE 2b TASK 4 ADAPTED THIS CALL, NOT ITS ASSERTIONS. `shortlistFor` gained
  // a second argument — the three-valued `DesignLaneMode` — because spec 6.5's
  // key term degrades the lane rather than turning it off. The mode is passed
  // explicitly here; what a BARE call returns is pinned by its own test below.
  const s = shortlistFor("web-ui", "full");
  assert.ok(s.includes("taste-frontend-expert"));
  assert.ok(s.includes("nextjs-developer"));
  assert.ok(s.includes("ui-designer"), "the visual gate is a separate agent from the author");
});

test("a DEGRADED design lane keeps taste-frontend-expert — the lane degrades, it does not vanish", () => {
  // Spec 6.5: with no Gemini key "taste-frontend-expert still art-directs and
  // produces written direction". Shortlisting on `mode === "full"` would delete
  // the art direction along with the images, and delete it INVISIBLY: an agent
  // that is not shortlisted has its delegated call denied by the PreToolUse hook,
  // which reads downstream as a lane with nothing to do.
  //
  // `taste-frontend-expert` IS THE ONLY LOAD-BEARING NAME IN THIS TEST.
  // `ui-designer` is also in DELIVERY_LANES.review, so it survives `shortlistFor`
  // with the design lane empty — an assertion on it alone could not go red no
  // matter what `designLaneRuns` did. It is asserted anyway, second, to say that
  // both DESIGN agents are expected; the discriminating one is first.
  const degraded = shortlistFor("web-ui", "degraded");
  assert.ok(degraded.includes("taste-frontend-expert"), "a degraded lane still needs its author");
  assert.ok(degraded.includes("ui-designer"));
  assert.deepEqual(
    [...degraded],
    [...shortlistFor("web-ui", "full")],
    "degraded and full shortlist IDENTICALLY — the difference is what the lane can produce, not who may run",
  );
});

test("an OFF design lane drops both DESIGN agents, and only those", () => {
  const off = shortlistFor("web-ui", "off");
  assert.ok(!off.includes("taste-frontend-expert"), "no author for a lane that is not running");
  assert.ok(off.includes("ui-designer"), "the REVIEW-lane role is not conditional on the DESIGN lane");
  assert.ok(off.includes("nextjs-developer"), "turning the design lane off must not touch the build lane");
});

test("the default mode is `off` — a caller that has not classified the lane under-delegates", () => {
  // PINNED BECAUSE IT IS A LIVE REGRESSION, not because it is desirable.
  // `orchestrator.ts:622` (the build shortlist) and `:843` (the fix loop's
  // allowedAgents) both still call this with one argument, so until Phase 2b
  // Task 10 passes `laneMode` through BOTH, a production web-ui run has no
  // DESIGN agents at all. The failure direction was chosen deliberately —
  // under-delegating beats handing an unclassified ticket a lane it did not
  // earn — but it is a behaviour change from the surface-only stub and it is
  // written down here rather than discovered from a run that generated nothing.
  const bare = shortlistFor("web-ui");
  assert.ok(!bare.includes("taste-frontend-expert"), "no mode means no design lane");
  assert.deepEqual([...bare], [...shortlistFor("web-ui", "off")], "the default IS `off`, not something else");
});

test("ui-designer is BOTH the token author and the visual gate — never the same role twice", () => {
  // Spec 7.4: the visual gate is deliberately not the mockup author. `ui-designer`
  // holds tokens in DESIGN and grades the built page in REVIEW; `taste-frontend-expert`
  // authors the mockups. If `ui-designer` were absent from the review lane, Task 4's
  // orchestrator prompt would never name a visual gate and the DESIGN->REVIEW link
  // in spec 7.4 would die silently.
  const design: readonly string[] = DELIVERY_LANES.design;
  const review: readonly string[] = DELIVERY_LANES.review;
  assert.ok(design.includes("ui-designer"));
  assert.ok(review.includes("ui-designer"));
  assert.ok(design.includes("taste-frontend-expert"), "the author owns the mockups");
  assert.ok(!review.includes("taste-frontend-expert"), "the author must not grade its own art");
});

test("the REVIEW lane really is filtered — a dead filter would pass every count bound", () => {
  // The mirror of "the build lane really is filtered", and it exists for the
  // same reason: `WEB_REVIEW` keys off a NAME. Rename the agent and the filter
  // silently matches nothing, every surface gets the whole review lane, and the
  // shortlist starts permitting a browser-driving lens on a run with no browser.
  // The count bounds and the widest-surface test both stay green through that.
  assert.ok(shortlistFor("web-ui").includes("human-factors-adversary"), "a web UI can be attacked");
  assert.ok(shortlistFor("fullstack").includes("human-factors-adversary"));
  assert.ok(!shortlistFor("cli").includes("human-factors-adversary"), "a CLI has no URL to attack");
  assert.ok(!shortlistFor("api").includes("human-factors-adversary"));
  assert.ok(!shortlistFor("library").includes("human-factors-adversary"));
  assert.ok(!shortlistFor("background-jobs").includes("human-factors-adversary"));
  // The four unconditional lenses must NOT have moved with it. A filter that
  // dropped the whole lane for a CLI would satisfy every negative above.
  for (const surface of SURFACES) {
    assert.ok(shortlistFor(surface).includes("code-reviewer"), `${surface} lost code-reviewer`);
    assert.ok(shortlistFor(surface).includes("security-auditor"), `${surface} lost security-auditor`);
  }
});

test("the shortlist is bounded — 144 agents is a noisy search space", () => {
  for (const surface of SURFACES) {
    const n = shortlistFor(surface).length;
    assert.ok(n >= 8 && n <= 30, `${surface}: ${n} agents is outside 8..30`);
  }
});

test("the shortlist never repeats an agent", () => {
  // `ui-designer` is in two lanes by design. A duplicate would inflate the count
  // and hand Task 3 a delegation boundary with the same name in it twice.
  for (const surface of SURFACES) {
    const s = shortlistFor(surface);
    assert.equal(new Set(s).size, s.length, `${surface} contains a duplicate`);
  }
});

test("fullstack is the widest surface — Task 3 passes it as the pre-classifier default", () => {
  // Task 3 wires `allowedAgents: shortlistFor("fullstack")` until the surface
  // classifier lands in Task 5, on the stated grounds that it is the widest set.
  // If that stops being true, the interim default silently under-provisions.
  const widest = shortlistFor("fullstack").length;
  for (const surface of SURFACES) {
    assert.ok(
      shortlistFor(surface).length <= widest,
      `${surface} is wider than fullstack (${shortlistFor(surface).length} > ${widest})`,
    );
  }
  // Strict, deliberately: `<=` alone would still pass if the build-lane filter
  // stopped filtering entirely (every surface returning the full lane).
  assert.ok(widest > shortlistFor("web-ui").length, "web-ui must drop cli-developer");
});

test("the build lane really is filtered — a dead filter would pass the count bounds", () => {
  // The filters key off agent names. Rename a build agent and the filter silently
  // matches nothing, every surface gets all 11, and only this assertion notices.
  assert.ok(!shortlistFor("api").includes("nextjs-developer"), "no frontend build agent on an API");
  assert.ok(!shortlistFor("cli").includes("frontend-developer"), "nor on a CLI");
  assert.ok(!shortlistFor("web-ui").includes("cli-developer"), "nor a CLI agent on a web UI");
});

test("context-manager runs in every lane set — it owns shared context", () => {
  for (const surface of ["web-ui", "api", "cli"] as const) {
    assert.ok(shortlistFor(surface).includes("context-manager"));
  }
});

/**
 * PHASE 1 TASK 7 — PER-AGENT BOUNDS.
 *
 * `DEFAULT_MAX_TURNS = 400` is SESSION-level: it bounds the whole build, not any
 * one lens inside it. Spec 11 item 3 records the consequence — one runaway lens
 * consumes the run's budget before GATE/FIX starts, and GATE/FIX is where the
 * defects found by REVIEW actually get closed. So each agent carries its own
 * number.
 *
 * WHAT THESE TESTS DO NOT PROVE, SAID HERE RATHER THAN IMPLIED: that the bound is
 * ENFORCED, or that anything reads it at all. `boundsFor` has NO production caller
 * as of 2026-07-29. Both routes it could have taken are measured shut — the Agent
 * tool's own `AgentInput` has no turn field, and `AgentDefinition.maxTurns` was
 * measured (probe I) binding a child registered under a FRESH name while not
 * binding one registered identically under a name that also exists in
 * ~/.claude/agents/, which is every name in DELIVERY_LANES. The wiring that used
 * to send it was deleted rather than left reading like a budget.
 *
 * These tests are therefore about a TABLE: that its numbers are present, ordered
 * sensibly relative to each other, and total for an unknown name. That is worth
 * keeping — the numbers are the reasoning, and they are what a future enforcement
 * route would apply — as long as no title here claims a bound that binds.
 */
test("every shortlisted agent carries an explicit turn bound", () => {
  // DEFAULT_MAX_TURNS is session-level. One unbounded lens can consume the whole
  // run's budget before GATE/FIX starts.
  for (const [lane, agents] of LANES) {
    for (const a of agents) {
      const b = boundsFor(a);
      assert.ok(b.maxTurns > 0 && b.maxTurns <= 60, `${lane}/${a}: maxTurns ${String(b.maxTurns)}`);
    }
  }
});

test("the DESIGN lane gets a larger budget — 5 images with retries is turn-hungry", () => {
  assert.ok(boundsFor("taste-frontend-expert").maxTurns >= 25);
  assert.ok(boundsFor("security-auditor").maxTurns <= boundsFor("taste-frontend-expert").maxTurns);
});

test("a read-mostly lens is cheaper than an agent that writes the implementation", () => {
  // The shape the plan asks for, asserted rather than left to the table's author:
  // review/audit lenses are read-mostly (~15) and build agents need room (~40).
  // Equal numbers everywhere would satisfy every bound above while bounding
  // nothing relative to anything.
  for (const lens of DELIVERY_LANES.review) {
    for (const builder of DELIVERY_LANES.build) {
      assert.ok(
        boundsFor(lens).maxTurns < boundsFor(builder).maxTurns,
        `${lens} (${String(boundsFor(lens).maxTurns)}) should be cheaper than ` +
          `${builder} (${String(boundsFor(builder).maxTurns)})`,
      );
    }
  }
});

test("bounds are total — an agent with no entry still gets a usable one", () => {
  // `allowedAgents` is a plain array and `BuildRequest` does not require its
  // members to be in DELIVERY_LANES. A lookup that returned undefined here would
  // be read as "no bound", which is the unbounded lens this whole table exists to
  // prevent.
  const b = boundsFor("some-future-agent");
  assert.ok(b.maxTurns > 0 && b.maxTurns <= 60, `unknown agent got maxTurns ${String(b.maxTurns)}`);
});

/*
 * "effort is a real rung or null" WAS HERE AND WENT WITH THE FIELD (2026-07-29).
 * `AgentBounds.effort` was null for every agent and its only consumer was a spread
 * into `AgentDefinition.effort`, which is deleted — so the test asserted that a
 * constant null was one of six permitted values. The decision it stood for (this
 * program does not invent a per-agent effort rung; the run's own rung stands) is
 * recorded in prose on `boundsFor`, where it costs no green test to say.
 */

/*
 * THE REPORT CONTRACT'S TESTS ARE NOT HERE ANY MORE — build-prompt.test.ts HAS
 * THEM (deleted 2026-07-29).
 *
 * Three tests stood here over `REPORT_CONTRACT_REMINDER` and
 * `reportContract(agent)`, which existed to fill `AgentDefinition.prompt` and
 * `criticalSystemReminder_EXPERIMENTAL` on the entries `buildOptions` sent through
 * `Options.agents`. Probe I measured that channel not binding for a name that
 * exists in ~/.claude/agents/, and the first test in this file proves every
 * shortlisted name does. The exports had no reader, so they went, and their tests
 * went with them rather than being re-pointed at a second copy of the same text.
 *
 * The contract itself is intact on the channel probe I measured reaching a child:
 * the `prompt` the orchestrator writes on each Agent call, stated in
 * build-prompt.ts and pinned by five tests in build-prompt.test.ts — the four
 * fields, the reason, the fail-closed empty case, and the instruction to attach it
 * to every call.
 */

/**
 * LANE ATTRIBUTION, for the context samples in Task 7 Step 5.
 *
 * A `task_notification` carries `task_id` and `status` and NOT `subagent_type`
 * (verified in the SDK typings: only `task_started` has it, and it is optional).
 * Turning a closing task into "which lane just finished" therefore needs the
 * agent name, which needs this lookup.
 */
test("laneOf answers with the lane an agent belongs to", () => {
  assert.equal(laneOf("code-reviewer"), "review");
  assert.equal(laneOf("backend-developer"), "build");
  assert.equal(laneOf("context-manager"), "spec");
  assert.equal(laneOf("debugger"), "gate");
});

test("laneOf is total — an unknown agent has no lane rather than a wrong one", () => {
  // Attribution has to degrade to "unknown", never to a plausible-looking lane:
  // a context sample labelled with the wrong lane is worse than one labelled with
  // none, because it reads as evidence.
  assert.equal(laneOf("some-future-agent"), null);
  assert.equal(laneOf(""), null);
});

test("a dual-lane agent resolves to its FIRST lane, and that is a known approximation", () => {
  // `ui-designer` is deliberately in DESIGN (tokens) and REVIEW (the visual
  // gate). Nothing in a task message says which role it was invoked in, so the
  // lookup answers with the earlier lane. The sample carries the AGENT name too,
  // so the ambiguity is recoverable rather than lost.
  assert.equal(laneOf("ui-designer"), "design");
});
