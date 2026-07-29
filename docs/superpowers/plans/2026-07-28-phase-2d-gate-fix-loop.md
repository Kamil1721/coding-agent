# Phase 2d — The GATE/FIX Loop

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make a failing build fix itself, bounded, and stop honestly when it cannot — so the owner can submit a ticket and walk away.

**Architecture:** `#gatePhase` runs exactly once today (`orchestrator.ts:350`). This phase wraps it in a bounded convergence loop: gate → triage the failures → route each to the right specialist → re-gate. It stops on green, on a retry cap, or on non-convergence, and writes a backlog either way.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test`. Reuses the bakeoff scorer unchanged. No new dependencies.

## THE TRAP — read this before writing any code

A naive fix loop **destroys the held-out boundary that Phases 0, 0.1 and 0.2 exist to protect.**

The gate produces a `ContainerResult`. It contains `criterionCoverage[].testRefs` — documented as
*"Test titles that asserted it"* — and `tier0[].detail`. **Phase 0 sealed `results/scorer-out/` precisely because those leak held-out test identities.** If the fix loop hands that report to a fixing agent, the agent learns the held-out tests by name and can target them. `heldOutPass` becomes meaningless, and nothing detects it.

**The rule, and it is not negotiable:**

```
VISIBLE to a fixing agent                     HELD OUT from a fixing agent
─────────────────────────────────             ─────────────────────────────────
tier0 gate failures, in full                  criterionCoverage[].testRefs
  build / boot / routes / screenshots           (test TITLES — never)
  stub markers / reward-hack markers          held-out suite assertion text
exploitFindings                               held-out failure detail
domFindings                                   
visible-acceptance/ results, in full          held-out suite: COUNT + TIER only
  (it is already in the workspace)              "2 FUNCTIONAL criteria unmet"
```

This is not a compromise — it is the existing architecture. The dashboard already copies **part**
of the suite into the workspace as `visible-acceptance/` as a feedback signal and holds the rest
out. The fix loop fixes against the visible half plus tier0; the held-out half stays an unseen
final verdict. **A fixing agent must never receive a `ContainerResult` directly.**

## Global Constraints

- **Never pass a raw `ContainerResult` to any agent.** It goes through a redactor first (Task 2). Assert this with a test that fails if `testRefs` ever reaches an agent prompt.
- **Infrastructure failures are not model outcomes.** `ContainerResult.harnessErrors` non-empty means a browser would not launch or a mount was unreadable. **Do not enter the fix loop** — abort and report infra failure, or the loop burns quota fixing a problem the artefact does not have.
- **Bounded, always.** An unattended system that retries forever is worse than one that stops and says why.
- **`decideToolPermission` stays PURE.** All Phase 0/0.1/0.2 protections hold; fixing agents are subject to the same guard.
- **Never modify `bakeoff/`.** No AI-attribution trailer. No `git push`.

---

### Task 1: Make the gate re-runnable

**Why first:** the loop re-gates. If a second gate run collides with the first's output the loop is unusable — and the failure would look like a scoring bug, not a plumbing bug.

**Files:**
- Modify: `dashboard/server/src/orchestrator.ts` (`#gatePhase`, `#readContainerResult`)
- Test: `dashboard/server/src/orchestrator.test.ts`

**Interfaces:**
- Produces: `#gatePhase(..., attempt: number)` writing to `results/scorer-out/<runId>/attempt-<n>/result.json`; `#readContainerResult(runId, attempt)`.

- [ ] **Step 1: Write the failing test**

```ts
test("two gate attempts do not collide", async () => {
  // The loop re-gates. If attempt 2 overwrites attempt 1, the run record loses
  // the history that explains WHY it took three rounds — and a partial write
  // could be read as a complete result.
  const paths = tmpPaths();
  writeAttempt(paths, "r1", 1, { tier0: [{ id: "build", outcome: "fail" }] });
  writeAttempt(paths, "r1", 2, { tier0: [{ id: "build", outcome: "pass" }] });
  assert.equal(readAttempt(paths, "r1", 1)?.tier0[0]?.outcome, "fail");
  assert.equal(readAttempt(paths, "r1", 2)?.tier0[0]?.outcome, "pass");
});

test("attempt paths stay inside the sealed root's deny", () => {
  // scorer-out is a sealed root (Phase 0). Sub-paths must inherit that, or the
  // loop quietly creates a readable copy of held-out test titles.
  const p = attemptPath(tmpPaths(), "r1", 2);
  assert.ok(p.includes("scorer-out"), "attempts live under the sealed root");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

- [ ] **Step 3: Implement** — thread `attempt` through `#gatePhase` and `#readContainerResult`, writing under `scorer-out/<runId>/attempt-<n>/`. Keep `scorer-out` as the sealed root so every attempt inherits the deny.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -m "refactor(gate): make the sealed gate re-runnable per attempt

The fix loop re-gates. Attempts write to scorer-out/<runId>/attempt-<n>/ so a
later attempt cannot overwrite the history that explains why a run took three
rounds. All attempts stay under the sealed root."
```

---

### Task 2: Redact the gate report before any agent sees it

**This is the task that protects `heldOutPass`.** Get it wrong and every later task inherits the leak.

**Files:**
- Create: `dashboard/server/src/gate-report.ts`, `dashboard/server/src/gate-report.test.ts`

**Interfaces:**
- Produces:
```ts
export type FailureClass = "install" | "build" | "boot" | "route" | "visual" | "test-infra" | "logic" | "structure";
export interface FixableFailure {
  readonly id: string;
  readonly klass: FailureClass;
  readonly summary: string;      // safe to put in a prompt
  readonly detail: string;       // tier0 detail, redacted; NEVER a held-out test title
  readonly command: string | null;
  readonly exitCode: number | null;
}
export interface AgentVisibleReport {
  readonly failures: readonly FixableFailure[];
  /** Held-out suite: counts by tier ONLY. Never titles, never assertions. */
  readonly heldOutUnmet: Readonly<Record<"BLOCKING" | "FUNCTIONAL" | "QUALITY", number>>;
  readonly infraFailure: string | null;
}
export function toAgentVisible(container: ContainerResult): AgentVisibleReport;
```

- [ ] **Step 1: Write the failing test — the leak test comes first**

```ts
test("HELD-OUT LEAK: no test title survives into the agent-visible report", () => {
  // criterionCoverage[].testRefs is documented as "Test titles that asserted it".
  // Phase 0 sealed results/scorer-out for exactly this. If a title reaches a
  // fixing agent, it can target the held-out tests and heldOutPass means nothing.
  const c = containerWith({
    criterionCoverage: [{
      criterionId: "C-1", tier: "FUNCTIONAL", outcome: "unmet",
      testRefs: ["renders the hero heading", "nav links resolve"],
      detail: "expected h1 to contain 'Kamil'",
    }],
  });
  const json = JSON.stringify(toAgentVisible(c));
  assert.doesNotMatch(json, /renders the hero heading/);
  assert.doesNotMatch(json, /nav links resolve/);
  assert.doesNotMatch(json, /expected h1 to contain/);
  assert.equal(toAgentVisible(c).heldOutUnmet.FUNCTIONAL, 1, "the COUNT survives — that is the signal");
});

test("tier0 failures survive in full — they are objective, not test-derived", () => {
  const c = containerWith({ tier0: [{
    id: "build", name: "npm run build", outcome: "fail",
    detail: "TS2345: Argument of type 'string' is not assignable",
    command: "npm run build", exitCode: 2, durationMs: 900,
  }]});
  const r = toAgentVisible(c);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].detail, /TS2345/, "the fixer needs the real compiler error");
  assert.equal(r.failures[0].command, "npm run build");
});

test("failures are classified so triage can route them", () => {
  assert.equal(classify({ id: "build" }), "build");
  assert.equal(classify({ id: "boot" }), "boot");
  assert.equal(classify({ id: "routes" }), "route");
  assert.equal(classify({ id: "screenshots" }), "visual");
  assert.equal(classify({ id: "something-new" }), "logic", "unknown class falls back to logic, never dropped");
});

test("an infra failure is surfaced, not turned into fix work", () => {
  // harnessErrors means the SCORER failed — a browser that would not launch.
  // Entering the loop here burns quota fixing a problem the artefact does not have.
  const r = toAgentVisible(containerWith({ harnessErrors: ["chromium failed to launch"] }));
  assert.match(String(r.infraFailure), /chromium/);
  assert.equal(r.failures.length, 0, "no fix work is proposed for an infra failure");
});
```

- [ ] **Step 2: Run to verify it fails** — module does not exist.

- [ ] **Step 3: Implement `gate-report.ts`.** Build the report from `tier0`, `exploitFindings` and `domFindings` only. Take **nothing** from `criterionCoverage` except a per-tier count of `outcome === "unmet"`. Put a comment at the top of the file naming the boundary and pointing at STATUS.md §0 — the next person to add a field must understand why the file exists.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -m "feat(gate): redact the gate report before any agent sees it

criterionCoverage[].testRefs carries held-out TEST TITLES. A fixing agent that
receives them can target the held-out suite, and heldOutPass stops meaning
anything. Only tier0/exploit/dom failures and per-tier unmet COUNTS cross."
```

---

### Task 3: Triage — route a failure to the right specialist

**Files:**
- Create: `dashboard/server/src/fix-triage.ts`, `dashboard/server/src/fix-triage.test.ts`

**Interfaces:**
- Consumes: `FixableFailure`, `FailureClass` (Task 2); `shortlistFor` (Phase 1).
- Produces: `export function agentFor(klass: FailureClass): string`, `export function planFixes(report: AgentVisibleReport): readonly FixTask[]` where `FixTask = { agent: string; failures: readonly FixableFailure[] }`.

- [ ] **Step 1: Write the failing test**

```ts
test("each failure class routes to the agent that can actually fix it", () => {
  assert.equal(agentFor("install"), "dependency-manager");
  assert.equal(agentFor("test-infra"), "test-automator");
  assert.equal(agentFor("logic"), "debugger");
  assert.equal(agentFor("structure"), "refactoring-specialist");
  assert.equal(agentFor("visual"), "taste-frontend-expert");
});

test("every routed agent is on the shortlist — an unlisted one is denied by canUseTool", () => {
  const allowed = new Set(shortlistFor("fullstack"));
  for (const k of ALL_FAILURE_CLASSES) {
    assert.ok(allowed.has(agentFor(k)), `${k} routes to ${agentFor(k)}, which is not shortlisted`);
  }
});

test("failures for one agent are batched into a single task", () => {
  // Three TS errors are one job for one debugger, not three sequential spawns.
  const tasks = planFixes(reportWith([f("logic"), f("logic"), f("install")]));
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((t) => t.agent === "debugger")?.failures.length, 2);
});

test("blocking classes are ordered before cosmetic ones", () => {
  // Fixing a visual nit while the build is broken wastes a round.
  const tasks = planFixes(reportWith([f("visual"), f("build")]));
  assert.equal(tasks[0].agent, agentFor("build"));
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** Order classes `install → build → boot → route → test-infra → logic → structure → visual`. Batch by agent, preserving that order.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 4: The bounded convergence loop

**Files:**
- Modify: `dashboard/server/src/orchestrator.ts`
- Test: `dashboard/server/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `#gateFixLoop(runId, ...): Promise<{ passed: boolean; attempts: number; reason: StopReason }>` where `StopReason = "green" | "retry-cap" | "not-converging" | "infra" | "cancelled"`.

- [ ] **Step 1: Write the failing test**

```ts
test("a run that goes green on the second attempt stops there", async () => {
  const gate = stubGate([failing("build"), green()]);
  const r = await runLoop({ gate, maxAttempts: 4 });
  assert.equal(r.passed, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.reason, "green");
});

test("the loop is BOUNDED — it stops at the cap and says so", async () => {
  // An unattended system that retries forever is worse than one that stops.
  const gate = stubGate([failing("logic"), failing("logic"), failing("logic"), failing("logic"), failing("logic")]);
  const r = await runLoop({ gate, maxAttempts: 3 });
  assert.equal(r.passed, false);
  assert.equal(r.attempts, 3);
  assert.equal(r.reason, "retry-cap");
});

test("identical failures twice in a row means NOT CONVERGING — stop early", async () => {
  // Same failure, same detail, after a fix attempt = the fix changed nothing.
  // Burning the remaining budget proves nothing.
  const same = failing("logic", "TS2345 at src/app.ts:12");
  const r = await runLoop({ gate: stubGate([same, same, same]), maxAttempts: 6 });
  assert.equal(r.reason, "not-converging");
  assert.ok(r.attempts <= 3, `stopped after ${r.attempts}, should not have used all 6`);
});

test("an infra failure aborts instead of entering the loop", async () => {
  const r = await runLoop({ gate: stubGate([infra("chromium failed to launch")]), maxAttempts: 4 });
  assert.equal(r.reason, "infra");
  assert.equal(r.attempts, 1, "no fix work is attempted");
});

test("no fixing agent ever receives a raw ContainerResult", async () => {
  // The Task 2 boundary, enforced at the seam it actually crosses.
  const seen: string[] = [];
  await runLoop({ gate: stubGate([failingWithTestRefs("renders the hero heading"), green()]),
                  maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  for (const p of seen) assert.doesNotMatch(p, /renders the hero heading/);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement the loop**

```
attempt = 1
loop:
  container = gate(attempt)
  if container.harnessErrors -> stop "infra"
  report = toAgentVisible(container)
  if no failures and heldOut all met -> stop "green"
  if report fingerprint == previous fingerprint -> stop "not-converging"
  if attempt >= maxAttempts -> stop "retry-cap"
  for task of planFixes(report): run task.agent with ONLY report data
  attempt += 1
```

The fingerprint is a stable hash of `(klass, id, detail)` across failures — identical twice means
the fix changed nothing.

Default `maxAttempts` = 3, configurable via `DASHBOARD_GATE_MAX_ATTEMPTS`.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 5: Write the backlog, always

Per CLAUDE.md rule 7: never drop deferred or blocked items. An unattended run that stops without
saying what is left is unactionable.

**Files:**
- Create: `dashboard/server/src/backlog.ts`, `dashboard/server/src/backlog.test.ts`
- Modify: `dashboard/server/src/orchestrator.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a stopped run writes what is still broken and why it stopped", () => {
  const md = renderBacklog({
    reason: "retry-cap", attempts: 3,
    remaining: [f("logic", "TS2345 at src/app.ts:12")],
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 2, QUALITY: 1 },
  });
  assert.match(md, /retry-cap/);
  assert.match(md, /3 attempts/);
  assert.match(md, /TS2345/);
  assert.match(md, /2 FUNCTIONAL/);
});

test("the backlog NEVER contains a held-out test title", () => {
  const md = renderBacklog({ reason: "retry-cap", attempts: 3,
    remaining: [], heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 1, QUALITY: 0 } });
  assert.doesNotMatch(md, /renders the hero/);
  assert.match(md, /1 FUNCTIONAL/, "counts only");
});

test("a green run still records that nothing was deferred", () => {
  assert.match(renderBacklog({ reason: "green", attempts: 1, remaining: [], heldOutUnmet: zero() }),
    /nothing deferred/i);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** Write to `runs/<runId>/results/backlog.md`. Include: stop reason, attempts used, each remaining failure with its class and detail, held-out unmet **counts**, and the next concrete action for each.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 6: The adversary phase — port `/debugfix --web --max`

`/debugfix` is a slash command with `disable-model-invocation: true`, so the model cannot invoke it.
Its *procedure* is ported. The owner asked for `--web` and `--max` explicitly.

**Files:**
- Modify: `dashboard/server/src/orchestrator.ts`
- Create: `dashboard/server/src/adversary.ts`, `dashboard/server/src/adversary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the adversary runs only against a running preview URL", () => {
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://127.0.0.1:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: null }), false, "no URL, no adversary");
  assert.equal(shouldRunAdversary({ surface: "cli", previewUrl: "http://127.0.0.1:4180" }), false);
});

test("the adversary is mechanically read-only", () => {
  // human-factors-adversary declares disallowedTools covering Write/Edit/Agent
  // and every credential-bearing MCP server. It reports; it never fixes.
  const opts = adversaryOptions({ previewUrl: "http://127.0.0.1:4180" });
  assert.equal(opts.agent, "human-factors-adversary");
  assert.ok(opts.disallowedTools.includes("Write"));
});

test("adversary findings become fix tasks, not gate failures", () => {
  // They are evidence, not a sealed verdict. They must not alter heldOutPass.
  const tasks = planFixes(reportWithAdversary([{ severity: "HIGH", klass: "logic", summary: "double-submit creates two bookings" }]));
  assert.ok(tasks.some((t) => t.agent === "debugger"));
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** After the gate goes green and `deploy: true` has produced a
`previewUrl` (`preview.ts` already serves the artefact on `127.0.0.1`), run
`human-factors-adversary` against that URL. Feed its findings back as fix tasks and re-gate.
**Adversary findings never change `heldOutPass`** — they are evidence, not the sealed verdict.

Guard the environment probe from `/debugfix` §0.5: money/destructive attacks stay gated to non-prod,
failing closed. A local preview has no real backend, so this is normally moot — assert it anyway.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 7: Wire the loop into the run, and surface the outcome

**Files:**
- Modify: `dashboard/server/src/orchestrator.ts` (replace the single `#gatePhase` call at ~line 350)
- Modify: `dashboard/server/src/api-types.ts`, `dashboard/src/lib/api-types.ts`, `dashboard/src/lib/use-run-stream.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the run record carries attempts and the stop reason", async () => {
  const d = await runDetail(runIdOf(await runTicket("broken thing")));
  assert.ok(typeof d.gateAttempts === "number");
  assert.ok(["green", "retry-cap", "not-converging", "infra", "cancelled"].includes(String(d.gateStopReason)));
});

test("heldOutPass is unchanged in meaning — it is still the sealed verdict", async () => {
  // The loop may re-gate several times; heldOutPass reflects the FINAL attempt only.
  const d = await runDetail(runIdOf(await runTicket("x")));
  assert.ok(d.heldOutPass === null || typeof d.heldOutPass === "boolean");
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** Replace the single call with `#gateFixLoop`. Widen `RunDetail` with
`gateAttempts: number` and `gateStopReason: string | null`. **Update all three declaration sites in
the same commit** — server `api-types.ts`, client `api-types.ts`, and `EVENT_TYPES` in
`use-run-stream.ts` — per the frozen-contract rule; widening one silently blanks the UI.

- [ ] **Step 4: Run the full suite. Step 5: Commit**

---

## Definition of done

- [ ] `npm test` passes; every Phase 0/0.1/0.2/1 test still green.
- [ ] **A held-out test title cannot reach an agent prompt or the backlog** — asserted at both seams.
- [ ] The loop stops on green, cap, non-convergence, and infra, each with a test.
- [ ] `backlog.md` is written on every terminal outcome, including green.
- [ ] Adversary runs only for a web surface with a live preview URL, and never mutates code.
- [ ] `bakeoff/` untouched. No attribution trailer.

## Explicitly NOT in Phase 2d

- **Cron.** That is Phase 4, and deliberately after this — cron plus an untrustworthy gate accumulates confidently-broken builds nobody reads.
- **The canvas.** Phase 3. The loop emits events; nothing renders them yet.
- **Self-rewriting prompts or shortlist.** Spec §16.4 rules this out for now.
