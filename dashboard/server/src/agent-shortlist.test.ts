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
  const s = shortlistFor("web-ui");
  assert.ok(s.includes("taste-frontend-expert"));
  assert.ok(s.includes("nextjs-developer"));
  assert.ok(s.includes("ui-designer"), "the visual gate is a separate agent from the author");
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

test("effort is a real rung or null — null means the run's own effort stands", () => {
  const rungs = new Set([null, "low", "medium", "high", "xhigh", "max"]);
  for (const [, agents] of LANES) {
    for (const a of agents) {
      assert.ok(rungs.has(boundsFor(a).effort), `${a}: effort ${String(boundsFor(a).effort)}`);
    }
  }
});

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
