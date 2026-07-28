/**
 * agent-shortlist.test.ts — the curated delegation shortlist, checked against disk.
 *
 * WHY THIS FILE EXISTS. Phase 1 Task 1 set `settingSources: ["user"]`, which makes
 * 144 of the owner's agents visible to the orchestrator. Visibility is not
 * permission: the `canUseTool` Agent branch shipped in Phase 0 is the boundary,
 * and this module is what will fill it (Task 3). 144 agents is a noisy search
 * space; the shortlist is the curation.
 *
 * The FIRST test is the load-bearing one. A misspelled agent name is a SILENT
 * capability loss — the orchestrator asks for an agent that does not exist,
 * `canUseTool` denies it, and the lane quietly does nothing. Nothing downstream
 * notices, because a lane that produced no output is indistinguishable from a
 * lane that had nothing to do. So the names are asserted against the frontmatter
 * on disk rather than reviewed by eye.
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
import { DELIVERY_LANES, shortlistFor } from "./agent-shortlist.js";

const SURFACES = ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"] as const;

/** `Object.entries` over a const-asserted object widens badly; the cast keeps this readable. */
const LANES = Object.entries(DELIVERY_LANES) as ReadonlyArray<[string, readonly string[]]>;

test("every shortlisted agent exists on disk", () => {
  // A typo here is a silent capability loss: the orchestrator asks for an agent
  // that does not exist, canUseTool denies it, and the lane quietly does nothing.
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
