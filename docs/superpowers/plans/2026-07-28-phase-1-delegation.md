# Phase 1 — Turn Delegation On

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make the build phase delegate across the owner's real agents and skills, instead of one agent doing everything.

**Architecture:** Phase 0 shipped a fail-closed Agent guard — `ALLOWED_AGENTS = []` denies every delegation today. Phase 1 loads the owner's environment (`settingSources: ["user"]`), fills that array with a curated shortlist, and gives the builder an orchestrator prompt. The guard built in Phase 0 becomes the delegation boundary rather than a blanket refusal.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test`, Claude Agent SDK 0.3.220. No new dependencies.

## What the probe established

```
settingSources: []        ->  16 skills (built-in only), 5 agents      OWNER SKILLS: NONE
settingSources: ["user"]  -> 162 skills, 144+ agents                   OWNER SKILLS: all
claude_code preset exposes Agent/Task                                  YES
sandbox.filesystem.denyRead blocks a SUBAGENT's `cat`                  YES — "Operation not permitted"
canary string leaked into any channel                                  NO
```

`denyRead` covering subagents is the load-bearing result: the sealed boundary survives delegation
even though `canUseTool` did not fire during the probe.

## Global Constraints

- **`ALLOWED_AGENTS` is the boundary.** `settingSources` decides what the orchestrator can *see*; the `canUseTool` Agent branch decides what it may *use*. Never widen one assuming the other compensates.
- **`run_in_background: false` stays forced.** A background subagent still writing while the gate runs makes the score depend on timing.
- **`isolation` stays denied.** `worktree` escapes `allowWrite`; `remote` leaves the machine.
- **Record the agent, skill and MCP set per run** — names plus a hash, alongside the ticket. `claude-builder.ts:192-195` demands no *unrecorded* input.
- **Do not weaken Phase 0/0.1/0.2.** All 96 tests must still pass. `heldOutPass` is no longer a comparison metric but is still the answer to "did this build deliver?".
- **Never modify `bakeoff/`.** No AI-attribution trailer. No `git push`.

---

### Task 1: Load the owner's environment

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts` (`buildOptions`)
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Produces: `buildOptions` now emits `settingSources: ["user"]`. Task 2 depends on the owner's agents being visible.

- [ ] **Step 1: Write the failing test**

```ts
test("WIRING: the owner's environment is loaded", () => {
  // Probed 2026-07-28: settingSources [] yields 16 built-in skills and ZERO of the
  // owner's; ["user"] yields 162 skills and 144+ agents. AgentDefinition.skills can
  // only name a DISCOVERED skill, so [] silently preloads nothing.
  assert.deepEqual(buildOptions(req(), false).settingSources, ["user"]);
});

test("WIRING: loading user settings does NOT weaken the sealed boundary", () => {
  const o = buildOptions(req(), false);
  assert.deepEqual(o.sandbox.filesystem.denyRead, req().sealedRoots.map(canonicaliseForDecision));
  assert.equal(o.sandbox.enabled, true);
  assert.equal(typeof o.canUseTool, "function");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | grep -A4 "owner's environment"
```

Expected: `AssertionError [] !== ["user"]`.

- [ ] **Step 3: Flip it, and rewrite the comment that justified the old value**

In `buildOptions`, replace `settingSources: []` with:

```ts
      // The owner's agents, skills and CLAUDE.md ARE loaded. This reverses the
      // original decision deliberately, on probe evidence and an owner decision.
      //
      // PROBED 2026-07-28: settingSources [] discovers 16 skills, ALL built-in, and
      // NONE of the owner's 41. AgentDefinition.skills can only name a DISCOVERED
      // skill, so under [] every preload silently resolves to nothing. There is no
      // programmatic equivalent for skills the way Options.agents is for agents.
      //
      // The original justification was COMPARABILITY — an uncontrolled input that
      // changes what gets built without appearing in the ticket. Model comparison
      // has been dropped (it existed to pit Claude against Codex; Codex is out of
      // scope), so that cost is now close to zero while the benefit is the whole
      // skill system, which the DESIGN lane and the motion bar depend on.
      //
      // WHAT THIS DOES NOT WEAKEN: the sealed boundary. denyRead, allowWrite,
      // canUseTool and the Agent guard are all set here, not in user settings, and
      // are unaffected. `heldOutPass` still means "did this build deliver?".
      //
      // ALSO LOADED: the owner's hooks — guard.sh and secret-guard.sh (PreToolUse,
      // both protective), verify.sh (PostToolUse + Stop), migration-lint.sh,
      // session-summary.sh. `verify.sh full` on Stop is built for interactive
      // sessions and can block completion; if a build hangs there, exclude that one
      // hook rather than reverting this decision.
      settingSources: ["user"],
```

- [ ] **Step 4: Run the full suite**

```bash
cd dashboard/server && npm test 2>&1 | tail -8
```

All previous tests must still pass. If a sealed-boundary test breaks, **stop** — user settings must not reach the boundary.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts dashboard/server/src/builders/claude-builder.test.ts
git commit -m "feat(build): load the owner's agents, skills and settings

Probed: settingSources [] discovers zero of the owner's 41 skills, so every
AgentDefinition.skills preload silently resolved to nothing. Comparability
was the reason for [] and model comparison has been dropped."
```

---

### Task 2: Compile the delegation shortlist

**Files:**
- Create: `dashboard/server/src/agent-shortlist.ts`
- Create: `dashboard/server/src/agent-shortlist.test.ts`

**Interfaces:**
- Produces: `export const DELIVERY_LANES: Readonly<Record<Lane, readonly string[]>>` and `export function shortlistFor(surface: Surface): readonly string[]`, plus `export type Lane = "spec" | "design" | "build" | "review" | "gate"` and `export type Surface = "web-ui" | "fullstack" | "api" | "cli" | "library" | "background-jobs"`.

- [ ] **Step 1: Write the failing test**

```ts
import { DELIVERY_LANES, shortlistFor } from "./agent-shortlist.js";

test("every shortlisted agent exists on disk", () => {
  // A typo here is a silent capability loss: the orchestrator asks for an agent
  // that does not exist, canUseTool denies it, and the lane quietly does nothing.
  const dir = join(homedir(), ".claude", "agents");
  const onDisk = new Set(
    readdirSync(dir).filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fm = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 12);
        const name = fm.find((l) => l.startsWith("name:"));
        return name ? name.slice(5).trim() : basename(f, ".md");
      }),
  );
  for (const [lane, agents] of Object.entries(DELIVERY_LANES)) {
    for (const a of agents) assert.ok(onDisk.has(a), `${lane}: "${a}" is not an agent on disk`);
  }
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

test("the shortlist is bounded — 144 agents is a noisy search space", () => {
  for (const surface of ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"] as const) {
    const n = shortlistFor(surface).length;
    assert.ok(n >= 8 && n <= 30, `${surface}: ${n} agents is outside 8..30`);
  }
});

test("context-manager runs in every lane set — it owns shared context", () => {
  for (const surface of ["web-ui", "api", "cli"] as const) {
    assert.ok(shortlistFor(surface).includes("context-manager"));
  }
});
```

- [ ] **Step 2: Run to verify it fails** — module does not exist.

- [ ] **Step 3: Write `agent-shortlist.ts`**

Lane membership, verified against `~/.claude/agents/` frontmatter:

```ts
export const DELIVERY_LANES = {
  spec:   ["context-manager", "product-manager", "qa-expert", "api-designer", "architect-reviewer"],
  design: ["taste-frontend-expert", "ui-designer"],
  build:  ["nextjs-developer", "react-specialist", "typescript-pro", "frontend-developer",
           "backend-developer", "fullstack-developer", "python-pro", "cli-developer",
           "postgres-pro", "trigger-dev-expert", "docker-expert"],
  review: ["code-reviewer", "accessibility-tester", "security-auditor", "ai-writing-auditor"],
  gate:   ["debugger", "test-automator", "refactoring-specialist", "dependency-manager"],
} as const satisfies Record<Lane, readonly string[]>;
```

`shortlistFor(surface)` returns spec + build-filtered + review + gate, adding `design` only for
`web-ui` and `fullstack`. Filter the build lane by surface: `cli` drops the frontend agents,
`api` drops them too, `web-ui` keeps them and drops `cli-developer`.

**Three facts to encode, each verified:**
- Key `trigger-dev-expert` by its **frontmatter name**, not its filename (`trigger-dev-task-writer.md`).
- `taste-frontend-expert` owns visual work over `ui-designer`/`frontend-developer` (CLAUDE.md:35).
- `ui-designer` is in the design lane for tokens **and** the review lane as the visual gate — it must not author the mockups it later grades.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 3: Fill `ALLOWED_AGENTS` and prove delegation is bounded

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`, `dashboard/server/src/builders/types.ts`
- Modify: `dashboard/server/src/orchestrator.ts`
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: `shortlistFor` (Task 2).
- Produces: `BuildRequest.allowedAgents: readonly string[]`, threaded into `makeCanUseTool`.

- [ ] **Step 1: Write the failing test**

> **Two defects that made the earlier drafts of these snippets un-runnable.** Task 1's implementer
> hit both and lost a cycle; do not repeat them.
> 1. **`canUseTool` is async.** `makeCanUseTool` returns an async arrow, so `o.canUseTool(...)`
>    yields a Promise and `.behavior` is `undefined`. Every test touching it must be `async` and
>    `await` the call.
> 2. **`exactOptionalPropertyTypes` is on**, and `sandbox`/`filesystem` are optional, so
>    `o.sandbox.filesystem.denyRead` is a **tsc error** — and `npm test` runs tsc first, so a type
>    error means **zero tests run**. Use `o.sandbox?.filesystem?.denyRead`, matching the existing
>    style around `claude-builder.test.ts:807`.
>
> `callContext()` (already in the test file) supplies the three fields `CanUseTool` requires — use
> it rather than `{}`.

```ts
test("delegation is ON for shortlisted agents", async () => {
  const o = buildOptions(req({ allowedAgents: ["code-reviewer", "debugger"] }), false);
  const r = await o.canUseTool?.("Agent",
    { subagent_type: "code-reviewer", run_in_background: false, prompt: "review" }, callContext());
  assert.equal(r?.behavior, "allow");
});

test("delegation stays CLOSED for anything off the shortlist", async () => {
  const o = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  for (const t of ["general-purpose", "wordpress-master", "", "Agent"]) {
    const r = await o.canUseTool?.("Agent",
      { subagent_type: t, run_in_background: false }, callContext());
    assert.equal(r?.behavior, "deny", t);
  }
});

test("the Phase 0 guards survive delegation being enabled", async () => {
  const o = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const call = (input: Record<string, unknown>) =>
    o.canUseTool?.("Agent", input, callContext());

  assert.equal((await call({ subagent_type: "code-reviewer", run_in_background: false, isolation: "remote" }))?.behavior, "deny");
  assert.equal((await call({ subagent_type: "code-reviewer" }))?.behavior, "deny");   // background default
  assert.equal((await call({ subagent_type: "code-reviewer", run_in_background: false, file_path: `${HELD_OUT}/t.mjs` }))?.behavior, "deny");
});

test("an empty shortlist still denies everything — fail closed", async () => {
  const o = buildOptions(req({ allowedAgents: [] }), false);
  const r = await o.canUseTool?.("Agent",
    { subagent_type: "code-reviewer", run_in_background: false }, callContext());
  assert.equal(r?.behavior, "deny");
});
```

- [ ] **Step 2: Run — expect the first to fail** (`ALLOWED_AGENTS` is the module constant `[]`).

- [ ] **Step 3: Thread the shortlist through**

Add `readonly allowedAgents: readonly string[];` to `BuildRequest` with a comment stating it is the
delegation boundary and that an empty array denies all delegation by design. Delete the module-level
`ALLOWED_AGENTS` constant; `buildOptions` reads `request.allowedAgents`. In `orchestrator.ts`, pass
`allowedAgents: shortlistFor(surface)`.

Until the surface classifier exists (Task 5), pass `shortlistFor("fullstack")` — the widest set —
and leave a `// TODO(Task 5)` naming the follow-up.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 4: Give the builder an orchestrator prompt

**Files:**
- Modify: `dashboard/server/src/build-prompt.ts`
- Test: `dashboard/server/src/build-prompt.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
test("the prompt names the available specialists and how to reach them", () => {
  const p = buildPrompt({ ticketText: "build a landing page", allowedAgents: ["taste-frontend-expert", "nextjs-developer"] });
  assert.match(p, /taste-frontend-expert/);
  assert.match(p, /nextjs-developer/);
  assert.match(p, /run_in_background:\s*false/, "the prompt must state the calling convention");
});

test("the prompt does not promise capabilities the guard denies", () => {
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["debugger"] });
  assert.doesNotMatch(p, /isolation/, "isolation is denied — do not invite it");
  assert.doesNotMatch(p, /general-purpose/, "not on the shortlist");
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Extend `build-prompt.ts`**

Add an orchestration section listing the shortlist grouped by lane, and stating plainly:
delegate with the Agent tool; **always** `run_in_background: false`; **never** pass `isolation`;
only these `subagent_type` values exist. Say that a denied call means the agent is off the
shortlist, not that the tool is broken — a model that misreads a denial burns turns retrying.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 5: Classify the ticket surface

**Files:**
- Create: `dashboard/server/src/surface.ts`, `dashboard/server/src/surface.test.ts`
- Modify: `dashboard/server/src/orchestrator.ts` (replace the Task 3 TODO)

**Interfaces:**
- Produces: `export function classifySurface(ticketText: string): Surface`

- [ ] **Step 1: Write the failing test**

```ts
test("worked cases from the spec", () => {
  assert.equal(classifySurface("Build me a CLI that renames files by EXIF date"), "cli");
  assert.equal(classifySurface("Portfolio site for a photographer, should feel expensive"), "web-ui");
  assert.equal(classifySurface("Add a webhook endpoint that writes to Postgres"), "api");
  assert.equal(classifySurface("A scheduled trigger.dev task that syncs hourly"), "background-jobs");
  assert.equal(classifySurface("Publish an npm package that parses ISO dates"), "library");
});

test("first match wins, most specific first", () => {
  // Names both a page and an endpoint -> fullstack, not web-ui.
  assert.equal(classifySurface("a dashboard page plus a REST endpoint for it"), "fullstack");
  // Names trigger.dev AND a page -> background-jobs is more specific.
  assert.equal(classifySurface("a trigger.dev cron that updates the landing page"), "background-jobs");
});

test("an unrecognisable ticket falls back to the widest lane set, never to nothing", () => {
  assert.equal(classifySurface("make it better"), "fullstack");
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**, ordering the checks `background-jobs → cli → library → api → web-ui → fullstack` per spec §6.5, and defaulting to `fullstack`.

- [ ] **Step 4: Wire it into `orchestrator.ts`**, replacing the Task 3 TODO with `shortlistFor(classifySurface(ticketText))`.

- [ ] **Step 5: Run, verify pass. Step 6: Commit**

---

### Task 6: Record the environment per run

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`, `dashboard/server/src/orchestrator.ts`

`claude-builder.ts:192-195` demands no *unrecorded* input. `settingSources: ["user"]` is a large
input; recording it is what keeps that promise.

- [ ] **Step 1: Capture the init inventory**

The `system/init` message carries `agents[]`, `skills[]`, `mcp_servers[]`, `tools[]`. Capture it in
the builder and emit it on the sink.

- [ ] **Step 2: Persist names plus a stable hash** alongside the run record, so two runs can be
      told apart by environment even when the ticket is identical.

- [ ] **Step 3: Log a one-line summary** — counts per category plus the hash — at build start.

- [ ] **Step 4: Commit**

---

### Task 7: Context discipline — stop the pipeline degrading on long builds

**Why this is in Phase 1 and not deferred:** a portfolio build touches design, frontend, backend
and database — more than one context window holds. When it fills, the SDK compacts, compaction is
lossy, and the orchestrator starts forgetting its own earlier decisions. **The run does not fail;
it quietly gets worse.** Delegation is the compression mechanism that makes long builds feasible,
and it only works if reports stay small. See spec §15.

**Files:**
- Modify: `dashboard/server/src/build-prompt.ts` (report-shape contract)
- Modify: `dashboard/server/src/agent-shortlist.ts` (per-agent bounds)
- Modify: `dashboard/server/src/builders/claude-builder.ts` (sample + persist context usage)
- Test: `dashboard/server/src/build-prompt.test.ts`, `dashboard/server/src/agent-shortlist.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("every delegated agent is told to return a COMPACT structured report", () => {
  // A subagent runs in its own context and the parent sees only its report.
  // That is the compression. A subagent that narrates 8k tokens hands the
  // problem straight back to the parent.
  const p = buildPrompt({ ticketText: "x", allowedAgents: ["backend-developer"] });
  assert.match(p, /report/i);
  assert.match(p, /files (changed|touched)/i, "the report contract must name what to include");
  assert.match(p, /do not (narrate|paste|include the full)/i, "and what to leave out");
});

test("every shortlisted agent carries an explicit turn bound", () => {
  // DEFAULT_MAX_TURNS is session-level. One unbounded lens can consume the whole
  // run's budget before GATE/FIX starts.
  for (const [lane, agents] of Object.entries(DELIVERY_LANES)) {
    for (const a of agents) {
      const b = boundsFor(a);
      assert.ok(b.maxTurns > 0 && b.maxTurns <= 60, `${lane}/${a}: maxTurns ${b.maxTurns}`);
    }
  }
});

test("the DESIGN lane gets a larger budget — 5 images with retries is turn-hungry", () => {
  assert.ok(boundsFor("taste-frontend-expert").maxTurns >= 25);
  assert.ok(boundsFor("security-auditor").maxTurns <= boundsFor("taste-frontend-expert").maxTurns);
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Add the report contract to `build-prompt.ts`**

Every delegated agent is instructed to return exactly:

```
DONE:      one line, what was accomplished
FILES:     paths changed or created, one per line
NEXT:      what the following lane needs to know, or "nothing"
UNRESOLVED: what you could not finish, or "none"
```

and told explicitly **not** to narrate its process, paste file contents, or restate the ticket.
State the reason in the prompt — a model that understands *why* complies better than one given a
bare format.

- [ ] **Step 4: Add `boundsFor(agent)` to `agent-shortlist.ts`**

```ts
export function boundsFor(agent: string): { maxTurns: number; effort: AnthropicEffort | null }
```

Rough shape: review/audit lenses are read-mostly and cheap (~15); build agents need room (~40);
`taste-frontend-expert` needs the most (~30) because §7.2's closed-loop critique is 5 images with
up to 2 retries each plus a Read-and-critique per image.

- [ ] **Step 5: Sample context usage at lane boundaries**

Call `Query.getContextUsage()` when a `task_notification` closes a lane's last agent, and persist
the breakdown with the run. Also capture `SDKCompactBoundaryMessage` — a compaction is the single
best explanation for a run that produced mediocre output, and it must be recoverable after the fact.

Emit both on the sink. The canvas renders them in Phase 3; **the data must be captured from Phase 1**
or the first long build is unexplainable.

- [ ] **Step 6: Run, verify pass. Step 7: Commit**

```bash
git commit -m "feat(build): context discipline for long builds

Delegation is the compression mechanism that makes a multi-lane build fit.
Adds a compact report contract, per-agent turn bounds, and context-usage
plus compaction capture so a degraded run is explainable rather than silent."
```

---

## Definition of done

- [ ] `npm test` passes; all 96 pre-existing tests still green.
- [ ] A shortlisted `Agent` call is ALLOWED; everything off-shortlist, every `isolation`, every background call, and every sealed path is DENIED — probed against `dist`.
- [ ] `shortlistFor` returns 8..30 agents for every surface, and every name exists on disk.
- [ ] The run record carries the agent/skill/MCP inventory and its hash.
- [ ] `bakeoff/` untouched. No attribution trailer.

## Explicitly NOT in Phase 1

- The DESIGN lane (2b), video (2c), anti-slop hooks (2a), and the canvas (3).
- Lane *sequencing*. Phase 1 makes delegation possible and bounded; the orchestrator prompt asks
  for lane order but nothing enforces it. Enforcement is a later decision, and spec §6.1 records
  that lane ordering is advisory by design in the single-session model.
