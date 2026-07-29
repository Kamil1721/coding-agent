# Phase 0.2 — Test the Wiring, Close the Residuals

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make the boundary's *wiring* testable and tested, then close six residual bypasses found by adversarial mutation testing.

**Architecture:** Phase 0/0.1 built a correct pure predicate with a real test suite (8/8 mutations died). But nothing tests that the predicate is *connected*. Extracting an exported `buildOptions(request)` seam turns five untestable wiring mutations into ordinary assertions.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test`. No new dependencies.

## The evidence

Each mutation below was applied to source, `dist` rebuilt, mutation grep-confirmed present, `npm test` run. **All left the suite green at `tests 76, pass 74, fail 0, skipped 2`:**

```
delete `canUseTool,` from the Options literal        0 failures
denyRead: sealedRoots      -> denyRead: []           0 failures
allowWrite: [workspace]    -> [workspace, "/"]       0 failures
sandbox.enabled: true      -> false                  0 failures
sealedRoots.map(resolve)   -> .slice(0, 0)           0 failures
```

Confirmed-open bypasses, probed against shipping `dist`:

```
Glob{pattern:"/tmp/**/*.mjs"}                 allow   wildcard above sealed root
{a:{b:{c:{d:{e:{f:{g:{h:"<suite>/x"}}}}}}}}    allow   depth cap is 6
{files:{"<suite>/x": "..."}}                   allow   object KEYS never scanned
{content:{path:"<suite>/x"}}                   allow   free-text key prunes whole subtree
Monitor{command:"cat <suite>/x"}               allow   `command` exempt for ALL tools
Agent{subagent_type:ok, file_path:"<suite>"}   allow   branch returns before sealed scan
```

## Global Constraints

- **`decideToolPermission` stays PURE.** fs work stays in the caller.
- **Every fix needs a mutation that dies.** After implementing, re-apply the named mutation, rebuild, and confirm a test now fails. A fix whose mutation still survives is not done.
- Preserve deny messages verbatim: `/SEALED ACCEPTANCE SUITE/`, `/only write inside its own workspace/`.
- Test command: `npm test` from `dashboard/server/`.
- **Never modify `bakeoff/`.** No AI-attribution trailer. No `git push`.

---

### Task 1: Extract `buildOptions` and test the wiring behaviourally

**Kills 5 findings at once.** This is the highest-value task in the plan.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Produces: `export function buildOptions(request: BuildRequest, allowUnsandboxed: boolean): Options` and `export function makeCanUseTool(workspace: string, sealedRoots: readonly string[], allowedAgents: readonly string[]): CanUseTool`

- [ ] **Step 1: Delete the fake wiring test**

Remove the `test("WIRING: the builder's canUseTool actually receives the sealed roots", …)` block that greps source text. It passes while the behaviour is absent — worse than no test, because it reads as coverage.

- [ ] **Step 2: Write the real failing tests**

```ts
import { buildOptions, makeCanUseTool } from "./claude-builder.js";

function req(overrides = {}) {
  return {
    runId: "r1", prompt: "build it", workspace: "/tmp/dash/runs/r1/workspace",
    sealedRoots: ["/tmp/dash/acceptance", "/tmp/dash/results/scorer-out"],
    modelId: "claude-opus-5", effort: null, resumeSessionId: null,
    signal: new AbortController().signal,
    sink: { log(){}, tool(){}, tokens(){}, rateLimit(){}, session(){}, raw(){} },
    env: {}, ...overrides,
  };
}

test("WIRING: canUseTool is actually handed to the SDK", () => {
  assert.equal(typeof buildOptions(req(), false).canUseTool, "function");
});

test("WIRING: denyRead carries every sealed root, canonicalised", () => {
  const o = buildOptions(req(), false);
  assert.deepEqual(
    o.sandbox.filesystem.denyRead,
    req().sealedRoots.map(canonicaliseForDecision),
  );
});

test("WIRING: allowWrite is the workspace and nothing else", () => {
  assert.deepEqual(buildOptions(req(), false).sandbox.filesystem.allowWrite,
    [canonicaliseForDecision(req().workspace)]);
});

test("WIRING: the sandbox is enabled, and fails closed unless opted out", () => {
  assert.equal(buildOptions(req(), false).sandbox.enabled, true);
  assert.equal(buildOptions(req(), false).sandbox.failIfUnavailable, true);
  assert.equal(buildOptions(req(), true).sandbox.failIfUnavailable, false);
});

test("WIRING: the handed-in canUseTool actually denies a sealed path", async () => {
  // Behavioural, not structural: call the function the SDK would call.
  const o = buildOptions(req(), false);
  const r = await o.canUseTool("Read", { file_path: "/tmp/dash/acceptance/t.mjs" }, {});
  assert.equal(r.behavior, "deny");
  assert.match(String(r.message), /SEALED ACCEPTANCE SUITE/);
});

test("WIRING: settingSources stays empty — no uncontrolled input", () => {
  assert.deepEqual(buildOptions(req(), false).settingSources, []);
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd dashboard/server && npm test 2>&1 | tail -25
```

Expected: compile error — `buildOptions` / `makeCanUseTool` not exported.

- [ ] **Step 4: Extract the seam**

Move the entire `options: Options` literal out of `build()` into an exported `buildOptions(request, allowUnsandboxed)`. Move the `canUseTool` closure into an exported `makeCanUseTool(workspace, sealedRoots, allowedAgents)`. `build()` then reads:

```ts
    const allowUnsandboxed = (request.env[ALLOW_UNSANDBOXED_ENV] ?? "").trim() === "1";
    const options = buildOptions(request, allowUnsandboxed);
```

Canonicalise once inside `buildOptions` so `denyRead`/`allowWrite` and the predicate see the **same** spelling — today the predicate gets `canonicaliseForDecision` output while the sandbox gets lexical `resolve`, so a symlinked workspace disagrees between layers.

- [ ] **Step 5: Verify each named mutation now dies**

For each of the five, apply it, rebuild, run, confirm ≥1 failure, then revert:

```bash
cd dashboard/server && npm run build --silent && npm test 2>&1 | grep -E "^. (fail|pass) "
```

Record which test caught each. **A mutation that still survives means this task is not done.**

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts dashboard/server/src/builders/claude-builder.test.ts
git commit -m "test(security): make the permission wiring behaviourally testable

Deleting canUseTool, emptying denyRead, widening allowWrite to /, and
disabling the sandbox all left the suite green — the Phase 0.1 wiring test
asserted on source text, not behaviour. Extracts buildOptions/makeCanUseTool
so the Options object can be asserted directly."
```

---

### Task 2: Truncate candidates at the first glob metacharacter

**Closes:** `Glob{pattern:"/tmp/**/*.mjs"}` — matches sealed files while the un-expanded string is neither inside nor a literal ancestor of the sealed root.

**Files:** `claude-builder.ts`, `claude-builder.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("a glob pattern is judged by its literal prefix, not the raw string", () => {
  assert.equal(decideWith("Glob", { pattern: `${HELD_OUT}/../**/*.mjs` }).behavior, "deny");
  assert.equal(decideWith("Glob", { pattern: "/tmp/dash/**/*.mjs" }).behavior, "deny");
  assert.equal(decideWith("Glob", { pattern: "/tmp/**/*.test.mjs" }).behavior, "deny");
  assert.equal(decideWith("Glob", { pattern: "../../../**/*.mjs" }).behavior, "deny");
  assert.equal(decideWith("Grep", { path: "/tmp/dash", glob: "**/*.mjs" }).behavior, "deny");
});

test("NEGATIVE CONTROL: workspace-scoped globs still work", () => {
  assert.equal(decideWith("Glob", { pattern: "**/*.ts" }).behavior, "allow");
  assert.equal(decideWith("Glob", { pattern: "src/**/*.tsx" }).behavior, "allow");
  assert.equal(decideWith("Glob", { pattern: `${WORKSPACE}/**/*.ts` }).behavior, "allow");
});
```

- [ ] **Step 2: Run — expect the deny cases to fail**

- [ ] **Step 3: Implement**

```ts
/**
 * A glob pattern names a TREE, not a file. `/x/**\/*.mjs` is neither inside the
 * sealed root nor a literal ancestor of it, yet it matches every file beneath
 * `/x` — including the suite. Judge the literal prefix up to the first
 * metacharacter, which IS the tree the tool will walk.
 */
function globPrefix(value: string): string {
  const cut = value.search(/[*?[\]{}]/);
  if (cut === -1) return value;
  const head = value.slice(0, cut);
  const lastSep = head.lastIndexOf("/");
  return lastSep === -1 ? "." : head.slice(0, lastSep + 1);
}
```

Apply inside `pathCandidates`: push **both** the raw value and its `globPrefix` when they differ, so a literal path is still judged literally.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -m "fix(security): judge a glob by its literal prefix

Glob{pattern:'/tmp/**/*.mjs'} matched sealed files while the un-expanded
string was neither inside nor an ancestor of the sealed root."
```

---

### Task 3: Fix the candidate walker — keys, subtrees, depth

**Closes three:** object keys never scanned; free-text keys pruning whole subtrees; depth-8 escape.

**Files:** `claude-builder.ts`, `claude-builder.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("a sealed path used as an object KEY is denied", () => {
  assert.equal(decideWith("mcp__fs__write_files",
    { files: { [`${HELD_OUT}/FROZEN.json`]: "overwritten" } }).behavior, "deny");
});

test("a free-text key shields only STRINGS, not a whole subtree", () => {
  assert.equal(decideWith("AnyTool", { content: { path: `${HELD_OUT}/t.mjs` } }).behavior, "deny");
  assert.equal(decideWith("AnyTool", { command: { file: `${HELD_OUT}/t.mjs` } }).behavior, "deny");
});

test("deep nesting cannot outrun the walker", () => {
  let o = { file_path: `${HELD_OUT}/t.mjs` };
  for (let i = 0; i < 12; i += 1) o = { nest: o };
  assert.equal(decideWith("AnyTool", o).behavior, "deny");
});

test("NEGATIVE CONTROL: free-text STRINGS are still exempt", () => {
  assert.equal(decideWith("Write",
    { file_path: `${WORKSPACE}/n.md`, content: `see ${HELD_OUT}` }).behavior, "allow");
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
});
```

- [ ] **Step 2: Run — expect first three to fail**

- [ ] **Step 3: Rewrite the visitor**

```ts
function pathCandidates(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  let budget = 512; // bound total work, not depth — depth is a schema detail
  const visit = (key: string, value: unknown): void => {
    if (budget-- <= 0) return;
    if (typeof value === "string") {
      // A free-text key exempts its own STRING only. Objects beneath it still walk.
      if (!FREE_TEXT_KEYS.has(key) && value.length > 0) found.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(key, item); return; }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k.length > 0) found.push(k); // KEYS can be paths: {files:{"<path>": ...}}
        visit(k, v);
      }
    }
  };
  for (const [k, v] of Object.entries(input)) { found.push(k); visit(k, v); }
  return found;
}
```

A node **budget** replaces the depth cap: it bounds adversarial work without giving an attacker a depth to exceed.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 4: Scope free-text exemptions per tool, and move the sealed scan first

**Closes two:** `Monitor{command:…}` inheriting Bash's exemption; the Agent branch returning before the sealed scan.

**Files:** `claude-builder.ts`, `claude-builder.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("only Bash's `command` is free text — other tools' is not", () => {
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
  assert.equal(decideWith("Monitor",
    { command: `cat ${HELD_OUT}/t.mjs`, description: "w", timeout_ms: 1000, persistent: false }).behavior, "deny");
  assert.equal(decideWith("REPL", { code: `read('${HELD_OUT}/t.mjs')` }).behavior, "deny");
});

test("an Agent call carrying a sealed path is denied, shortlisted or not", () => {
  const r = decideToolPermission("Agent",
    { subagent_type: "code-reviewer", run_in_background: false, file_path: `${HELD_OUT}/t.mjs` },
    WORKSPACE, SEALED, ["code-reviewer"]);
  assert.equal((r as { behavior: string }).behavior, "deny");
});

test("NEGATIVE CONTROL: a clean shortlisted Agent call still runs", () => {
  const r = decideToolPermission("Agent",
    { subagent_type: "code-reviewer", run_in_background: false, prompt: "review src/" },
    WORKSPACE, SEALED, ["code-reviewer"]);
  assert.equal((r as { behavior: string }).behavior, "allow");
});
```

- [ ] **Step 2: Run — expect Monitor, REPL and Agent-with-path to fail**

- [ ] **Step 3: Implement**

Replace the bare `FREE_TEXT_KEYS` set with a `(tool, key)` table. `command` is free text **only** for `Bash`, justified by `autoAllowBashIfSandboxed`; every other tool's `command` is a candidate:

```ts
const FREE_TEXT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Bash", new Set(["command", "description"])],
  ["Write", new Set(["content"])],
  ["Edit", new Set(["old_string", "new_string"])],
  ["MultiEdit", new Set(["old_string", "new_string"])],
  ["NotebookEdit", new Set(["new_source"])],
  ["Agent", new Set(["prompt", "description"])],
  ["Task", new Set(["prompt", "description"])],
]);
```

Thread `toolName` into the walker. An unknown tool gets **no** exemptions — deny-by-default, the polarity Phase 0.1 established.

Then move the `candidates` construction and the sealed-root loop **above** the Agent/Task branch, so the sealed scan is unconditional for every tool.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

---

### Task 5: Re-attack, then correct STATUS.md

- [ ] **Step 1: Re-run every attack from the plan header**

Write a scratch `.mjs` against `dist` covering all six confirmed bypasses plus every Phase 0/0.1 attack. All must deny; all negative controls must allow. Not committed.

- [ ] **Step 2: Re-apply all five wiring mutations, confirm each dies**

- [ ] **Step 3: Record real counts, update STATUS.md**

Replace the Phase 0.1 wiring note with the truth:

```markdown
- **The wiring is now behaviourally tested.** `buildOptions(request)` is asserted
  directly: canUseTool present, denyRead carries every sealed root, allowWrite is
  the workspace alone, sandbox enabled and failing closed. Phase 0.1's wiring test
  asserted on SOURCE TEXT and survived deletion of `canUseTool` entirely.
- **Still not exercised:** whether `denyRead` is enforced by the OS sandbox, and
  whether `canUseTool` fires for subagent-originated calls. Both need the Phase 0.5
  canary probe. Unit tests prove the predicate and its wiring, not the CLI's honouring.
```

- [ ] **Step 4: Commit**

---

## Definition of done

- [ ] All 5 wiring mutations kill ≥1 test each — **recorded, per mutation**.
- [ ] All 6 residual bypasses deny, probed against `dist`.
- [ ] Negative controls allow: `Glob{pattern:"**/*.ts"}`, `Bash{command:"ls <suite>"}`, `Write{content:"see <suite>"}`, `Grep{pattern:"TODO"}`, clean Agent call.
- [ ] `npm run typecheck` clean. `bakeoff/` untouched. No attribution trailer.
