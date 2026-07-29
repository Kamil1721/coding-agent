# Phase 0 — Held-Out Boundary Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the executed read-bypass in the dashboard's sealed-acceptance-suite boundary, and harden it against the subagent delegation that Phase 1 introduces.

**Architecture:** `decideToolPermission` in `builders/claude-builder.ts` is a pure function guarding every tool call the Claude builder makes. It currently denies only paths *inside* the sealed suite, only for a hardcoded list of tool names, only when a known path key is present, and it does not inspect the Agent tool at all. This plan widens it along all four axes and generalises `heldOutRoot` into a list of sealed roots so the scorer's own output — which leaks held-out test titles — is covered by the same guard.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test` + `node:assert/strict`. No new dependencies.

## Global Constraints

- **`decideToolPermission` stays a pure function.** It is unit-tested without spawning a CLI or consuming quota. Do not make it async, do not give it filesystem access.
- **Every deny must keep its instructive message.** The existing denials explain *what* the path is and *what to do instead*; tests assert on `/SEALED ACCEPTANCE SUITE/` and `/only write inside its own workspace/`. Preserve both strings verbatim.
- **Every widening needs a negative control.** A deny-everything rule passes every positive test while breaking all builds. Each task adds at least one assertion that ordinary work is still allowed.
- **Node ≥24.0.0**, `"type": "module"` — all imports use `.js` extensions on relative paths.
- **Test command is `npm test` from `dashboard/server/`**, which runs `tsc` first then `node --test "dist/**/*.test.js"`. A test cannot run without a clean typecheck.
- **Do not modify `bakeoff/`.** It is the measurement harness for a separate campaign. All changes are dashboard-local.
- **No commit is made unless the owner asks.** Steps below stage and commit because this is a tracked plan; confirm with the owner before the first `git commit`, and note `coding-agent/` is **not currently a git repository** — see Task 0.
- **No AI-attribution trailer in any commit message.** No `Co-Authored-By`, no `Generated with`.

---

### Task 0: Establish version control (owner-gated)

**Files:**
- Create: `.gitignore` (repo root)

`coding-agent/` is not a git repository. Every later task ends in a commit, so this must be resolved first — but initialising a repo is the owner's call, not the implementer's.

- [ ] **Step 1: Ask the owner**

Ask: "Phase 0 modifies live security code across ~6 commits. `coding-agent/` isn't a git repo. Do you want me to `git init` so each task is independently revertable, or should I make the changes without version control?"

**STOP. Do not proceed until answered.** If the owner declines, skip every `git commit` step in this plan and record that decision at the top of the file.

- [ ] **Step 2: If approved, initialise**

```bash
cd /Users/kamilborzecki/Projects/coding-agent
git init
```

- [ ] **Step 3: If approved, add .gitignore**

```gitignore
node_modules/
dist/
.next/
*.tsbuildinfo
dashboard/data/
dashboard/runs/
dashboard/results/
dashboard/acceptance/
bakeoff/dist/
bakeoff/results/
.debugfix-active
.debugfix-blocks
.env
```

`dashboard/acceptance/` is gitignored deliberately — the sealed suite must not enter version control.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: initialise repository with gitignore"
```

---

### Task 1: Generalise `heldOutRoot` into a list of sealed roots

**Why first:** Tasks 2-5 all change `decideToolPermission`'s body. Doing the signature change once, up front, keeps their diffs to logic only.

**What this closes:** `results/scorer-out/<runId>/result.json` persists `criterionCoverage[].testRefs` — *"Test titles that asserted it"* — outside the sealed store. Any later run of the same frozen ticket can read them.

**Files:**
- Modify: `dashboard/server/src/builders/types.ts:58`
- Modify: `dashboard/server/src/builders/claude-builder.ts:130-160,175,181,209`
- Modify: `dashboard/server/src/orchestrator.ts:580`
- Modify: `dashboard/server/src/builders/codex-builder.ts:24` (comment only)
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `decideToolPermission(toolName: string, input: Record<string, unknown>, workspace: string, sealedRoots: readonly string[]): PermissionResult` — Tasks 2-5 all extend this same signature. `BuildRequest.sealedRoots: readonly string[]` replaces `BuildRequest.heldOutRoot: string`.

- [ ] **Step 1: Write the failing test**

Add to `claude-builder.test.ts`. Replace the existing `HELD_OUT` constant and `decide` helper with these:

```ts
const WORKSPACE = "/tmp/dash/runs/r1/workspace";
const HELD_OUT = "/tmp/dash/acceptance";
const SCORER_OUT = "/tmp/dash/results/scorer-out";
const SEALED = [HELD_OUT, SCORER_OUT];

function decide(tool: string, path: string): { behavior: string; message?: string } {
  const result = decideToolPermission(tool, { file_path: path }, WORKSPACE, SEALED);
  return result as { behavior: string; message?: string };
}

test("the scorer's own output is sealed — it leaks held-out test titles", () => {
  // result.json carries criterionCoverage[].testRefs, documented as "Test titles
  // that asserted it". Reading it defeats the gate exactly as reading the suite does.
  const result = decide("Read", `${SCORER_OUT}/r1/result.json`);
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /SEALED ACCEPTANCE SUITE/);
});

test("NEGATIVE CONTROL: other results are still readable", () => {
  // Screenshots and logs under results/ are served to the UI and are not sealed.
  assert.equal(decide("Read", "/tmp/dash/results/screenshots/r1/home.png").behavior, "allow");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | tail -30
```

Expected: a TypeScript compile error — `Argument of type 'string[]' is not assignable to parameter of type 'string'`. That failure is the point; it proves the signature has not changed yet.

- [ ] **Step 3: Change the signature in `claude-builder.ts`**

Replace the `decideToolPermission` signature and its held-out branch (currently lines 130-148):

```ts
export function decideToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
  sealedRoots: readonly string[],
): PermissionResult {
  const raw = pathInput(input);
  if (raw !== null && (PATH_TOOLS.has(toolName) || READ_TOOLS.has(toolName))) {
    if (sealedRoots.some((root) => insideDir(root, raw, resolve(workspace)))) {
      return {
        behavior: "deny",
        message:
          "That path is the SEALED ACCEPTANCE SUITE. It is held out on purpose: it is the " +
          "independent check on whether this ticket was actually delivered, and a build that reads " +
          "it can satisfy it without satisfying the ticket. Build from the brief and from " +
          "`visible-acceptance/` in the workspace.",
      };
    }
  }
  if (raw !== null && PATH_TOOLS.has(toolName) && !insideWorkspace(workspace, raw)) {
    return {
      behavior: "deny",
      message:
        `This run may only write inside its own workspace (${workspace}). Put the implementation there.`,
    };
  }
  return { behavior: "allow" };
}
```

- [ ] **Step 4: Update the builder's call sites in `claude-builder.ts`**

Replace lines 175-181:

```ts
    const sealedRoots = request.sealedRoots.map((root) => resolve(root));

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> =>
      decideToolPermission(toolName, input, workspace, sealedRoots);
```

And line 209:

```ts
        filesystem: { allowWrite: [workspace], denyRead: sealedRoots },
```

- [ ] **Step 5: Update `builders/types.ts`**

Replace the `heldOutRoot` field (line 58) and its doc comment:

```ts
  /**
   * Paths this build MUST NOT READ OR WRITE. Currently two:
   *
   *   1. the sealed suite store (`dashboard/acceptance`)
   *   2. the scorer's own output (`dashboard/results/scorer-out`), which
   *      persists `criterionCoverage[].testRefs` — held-out TEST TITLES —
   *      outside the sealed store, readable by any later run of the same
   *      frozen ticket.
   *
   * They are passed in so each driver can deny them explicitly rather than
   * relying on the builder not going looking. Read {@link SubscriptionBuilder}
   * and `dashboard/STATUS.md` "The held-out boundary" before trusting this: the
   * bake-off keeps the held-out half out of a container the builder cannot
   * escape; the dashboard builder runs on the HOST as the same user, so what is
   * here is a policy inside each CLI, not a filesystem boundary. The Anthropic
   * driver enforces it in two layers; the Codex driver has no mechanism for it
   * at all.
   */
  readonly sealedRoots: readonly string[];
```

- [ ] **Step 6: Update `orchestrator.ts:580`**

Replace `heldOutRoot: this.#deps.paths.acceptance,` with:

```ts
      sealedRoots: [
        this.#deps.paths.acceptance,
        join(this.#deps.paths.results, "scorer-out"),
      ],
```

`join` is already imported in `orchestrator.ts` (used at line 774).

- [ ] **Step 7: Update the stale comment in `codex-builder.ts:24`**

Change `request.heldOutRoot` to `request.sealedRoots` in the comment text. No behaviour change — the Codex driver has no enforcement mechanism, which the comment already states.

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: all tests pass, including the two new ones and all 9 pre-existing ones.

- [ ] **Step 9: Commit**

```bash
git add dashboard/server/src/builders/types.ts \
        dashboard/server/src/builders/claude-builder.ts \
        dashboard/server/src/builders/claude-builder.test.ts \
        dashboard/server/src/builders/codex-builder.ts \
        dashboard/server/src/orchestrator.ts
git commit -m "fix(security): seal the scorer's output alongside the acceptance suite

result.json persists criterionCoverage[].testRefs — held-out test titles —
outside the sealed store, readable by any later run of the same frozen ticket.
Generalises heldOutRoot into a sealedRoots list covering both."
```

---

### Task 2: Deny the ancestor case — the live bypass

**What this closes:** `Grep{path: "/tmp/dash", pattern: "assert", output_mode: "content"}` currently returns ALLOW. `/tmp/dash` *contains* the sealed store; ripgrep walks down into it and returns held-out test source. This is executed, not theoretical.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts` (`insideDir` region, ~lines 113-117, and the sealed branch)
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: `decideToolPermission(..., sealedRoots: readonly string[])` from Task 1.
- Produces: `function containsOrIsInside(root: string, candidate: string, base: string): boolean` — used by Tasks 3 and 5.

- [ ] **Step 1: Write the failing test**

```ts
test("a recursive search from an ANCESTOR of the suite is denied", () => {
  // THE LIVE BYPASS. insideDir only asked "is the candidate inside the suite?".
  // A recursive tool given a parent directory walks down INTO the suite.
  for (const tool of ["Grep", "Glob"]) {
    assert.equal(decide(tool, "/tmp/dash").behavior, "deny", `${tool} from an ancestor`);
    assert.equal(decide(tool, "/tmp").behavior, "deny", `${tool} from a distant ancestor`);
    assert.equal(decide(tool, "/").behavior, "deny", `${tool} from the filesystem root`);
  }
});

test("the ancestor rule also covers relative climbs", () => {
  assert.equal(decide("Grep", "../../..").behavior, "deny");
});

test("NEGATIVE CONTROL: a sibling of the suite is not an ancestor", () => {
  assert.equal(decide("Grep", "/tmp/dash/runs").behavior, "allow");
  assert.equal(decide("Grep", "/tmp/dash/acceptance-notes").behavior, "allow");
  assert.equal(decide("Read", `${WORKSPACE}/src`).behavior, "allow");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | grep -A5 "ANCESTOR"
```

Expected: FAIL — `Expected values to be strictly equal: 'allow' !== 'deny'`.

- [ ] **Step 3: Add the containment helper**

Add immediately after the existing `insideDir` function:

```ts
/**
 * True when `candidate` is inside `root` OR recursively CONTAINS it.
 *
 * The second half is the one that was missing. `Grep`/`Glob` take a DIRECTORY
 * and walk it recursively, so a candidate that is an ancestor of the sealed
 * store reaches every file in it without ever naming it. Asking only "is the
 * candidate inside the root?" answers the wrong question for a recursive tool.
 */
function containsOrIsInside(root: string, candidate: string, base: string): boolean {
  const rootAbs = resolve(root);
  const target = resolve(base, candidate);
  if (target === rootAbs) return true;
  if (target.startsWith(`${rootAbs}/`)) return true;
  return rootAbs.startsWith(target === "/" ? "/" : `${target}/`);
}
```

The `target === "/" ? "/" : ...` branch matters: `resolve()` returns `/` for the filesystem root, and `"/" + "/"` would be `"//"`, which no absolute path starts with — so `/` would escape the check without it.

- [ ] **Step 4: Use it in the sealed branch**

In `decideToolPermission`, replace `insideDir` with `containsOrIsInside` in the sealed-roots check only:

```ts
    if (sealedRoots.some((root) => containsOrIsInside(root, raw, resolve(workspace)))) {
```

Leave the workspace-write check on `insideWorkspace` — that one genuinely means "inside".

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: all pass. If `"a path that merely starts with the suite root's characters is NOT the suite"` fails, the `startsWith` guard is missing its trailing separator.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts \
        dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): deny recursive reads from an ancestor of the sealed suite

Grep{path:<ancestor>} returned ALLOW and ripgrep walked down into the sealed
store, returning held-out test source. Executed bypass, now closed."
```

---

### Task 3: Deny by default on any path-bearing input, regardless of tool name

**What this closes:** `READ_TOOLS` is a tool-name allowlist — structurally fail-open. `mcp__*` file-read tools and `ReadMcpResource` return ALLOW on a sealed path today. With all user-scope MCP servers enabled (spec decision #7), that is the widest hole.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts` (`PATH_INPUT_KEYS`, `pathInput`, `decideToolPermission`)
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: `containsOrIsInside` from Task 2.
- Produces: `function pathInputs(input: Record<string, unknown>): string[]` — replaces the single-value `pathInput`. Task 5 does not use it; Task 4 does.

- [ ] **Step 1: Write the failing test**

```ts
function decideWith(tool: string, input: Record<string, unknown>): { behavior: string; message?: string } {
  return decideToolPermission(tool, input, WORKSPACE, SEALED) as { behavior: string; message?: string };
}

test("an MCP read tool cannot reach the suite — the guard is not a name allowlist", () => {
  const holdout = `${HELD_OUT}/T-1/holdout/greeting.test.mjs`;
  assert.equal(decideWith("mcp__filesystem__read_file", { path: holdout }).behavior, "deny");
  assert.equal(decideWith("ReadMcpResource", { uri: holdout }).behavior, "deny");
  assert.equal(decideWith("SomeToolShippingNextYear", { file: holdout }).behavior, "deny");
});

test("every path-bearing key is inspected, not just file_path", () => {
  const holdout = `${HELD_OUT}/T-1`;
  for (const key of ["path", "notebook_path", "dir", "directory", "cwd", "uri", "file", "filename", "target", "root", "glob"]) {
    assert.equal(decideWith("Read", { [key]: holdout }).behavior, "deny", `key ${key}`);
  }
});

test("array-valued path inputs are inspected element by element", () => {
  assert.equal(
    decideWith("Read", { paths: [`${WORKSPACE}/a.ts`, `${HELD_OUT}/T-1/holdout/x.mjs`] }).behavior,
    "deny",
  );
});

test("NEGATIVE CONTROL: free-text keys are NOT scanned as paths", () => {
  // A build legitimately writes a file whose CONTENT mentions the suite path,
  // and legitimately runs a Bash command string. Scanning free text would deny
  // ordinary work and teach the model to obfuscate rather than comply.
  assert.equal(decideWith("Write", { file_path: `${WORKSPACE}/notes.md`, content: `see ${HELD_OUT}` }).behavior, "allow");
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
});
```

The Bash negative control encodes an existing, deliberate design decision: `autoAllowBashIfSandboxed: true` means a sandboxed Bash call never reaches this function at all. OS-level `denyRead` is the only layer that covers Bash. Do not "fix" this here.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | grep -A5 "name allowlist"
```

Expected: FAIL — `'allow' !== 'deny'`.

- [ ] **Step 3: Replace `PATH_INPUT_KEYS` and `pathInput`**

Replace the existing constants and function (lines ~100-111):

```ts
/**
 * Keys under which any tool — built-in, MCP, or one that ships next year —
 * carries a path it will act on.
 *
 * DELIBERATELY EXCLUDED: `content`, `new_string`, `old_string`, `command`,
 * `prompt`, `description`, `instructions`. Those carry free text. A build
 * legitimately writes a file whose content mentions the suite path, and denying
 * that would block ordinary work while teaching the model to obfuscate rather
 * than comply.
 */
const PATH_INPUT_KEYS = [
  "file_path", "path", "notebook_path", "dir", "directory", "cwd",
  "uri", "resource", "file", "filename", "target", "root", "glob",
  "paths", "files",
] as const;

/** Every path-shaped value in the input, flattened. */
function pathInputs(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) found.push(item);
      }
    }
  }
  return found;
}
```

- [ ] **Step 4: Rewrite the sealed branch to drop the tool-name gate**

Replace the body of `decideToolPermission` up to the workspace-write check:

```ts
  const candidates = pathInputs(input);
  const base = resolve(workspace);

  // SEALED ROOTS: denied for EVERY tool, by any key, in either direction.
  // No tool-name gate — an allowlist is fail-open to every read-capable tool
  // the CLI adds and every MCP server the owner enables.
  for (const candidate of candidates) {
    if (sealedRoots.some((root) => containsOrIsInside(root, candidate, base))) {
      return {
        behavior: "deny",
        message:
          "That path is the SEALED ACCEPTANCE SUITE. It is held out on purpose: it is the " +
          "independent check on whether this ticket was actually delivered, and a build that reads " +
          "it can satisfy it without satisfying the ticket. Build from the brief and from " +
          "`visible-acceptance/` in the workspace.",
      };
    }
  }

  // WRITES stay confined to the workspace. Still tool-name-gated: this is about
  // where the build may put files, not about what it may look at.
  for (const candidate of candidates) {
    if (PATH_TOOLS.has(toolName) && !insideWorkspace(workspace, candidate)) {
      return {
        behavior: "deny",
        message:
          `This run may only write inside its own workspace (${workspace}). Put the implementation there.`,
      };
    }
  }
```

- [ ] **Step 5: Delete the now-unused `READ_TOOLS` constant**

Remove the `READ_TOOLS` set and its doc comment (lines ~89-100). Replace with a comment recording why it went:

```ts
// READ_TOOLS (a tool-name allowlist) was removed on 2026-07-28. It was
// structurally fail-open: `mcp__*` read tools and ReadMcpResource were never in
// it and returned ALLOW on a sealed path. Sealed roots are now denied for every
// tool name; only the WRITE confinement below is still name-gated.
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: all pass, including the original `"the held-out suite cannot be READ, by any read-family tool"`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts \
        dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): seal roots against every tool, not an allowlist

READ_TOOLS was a tool-name allowlist and therefore fail-open: mcp__* read
tools and ReadMcpResource returned ALLOW on a sealed path. Path-bearing
inputs are now denied by key, for any tool name, in either direction."
```

---

### Task 4: Treat a missing path on a recursive tool as cwd

**What this closes:** `Grep`/`Glob` with `path` omitted produce no candidate, so the guard returns ALLOW. The CLI then defaults to the current working directory. Harmless while cwd is the workspace; a hole the moment a subagent runs elsewhere.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: `pathInputs` (Task 3), `containsOrIsInside` (Task 2).
- Produces: `const RECURSIVE_TOOLS: Set<string>`.

- [ ] **Step 1: Write the failing test**

```ts
test("a recursive tool with NO path defaults to cwd and is judged on that", () => {
  // pathInputs() returns nothing, so the guard saw no candidate at all.
  // The CLI still runs the search — against cwd.
  const sealedCwd = decideToolPermission("Grep", { pattern: "assert" }, HELD_OUT, SEALED);
  assert.equal(sealedCwd.behavior, "deny", "cwd inside the suite must be denied");

  const ancestorCwd = decideToolPermission("Grep", { pattern: "assert" }, "/tmp/dash", SEALED);
  assert.equal(ancestorCwd.behavior, "deny", "cwd containing the suite must be denied");
});

test("NEGATIVE CONTROL: a recursive tool with no path in a clean workspace is allowed", () => {
  assert.equal(decideToolPermission("Grep", { pattern: "TODO" }, WORKSPACE, SEALED).behavior, "allow");
  assert.equal(decideToolPermission("Glob", { pattern: "**/*.ts" }, WORKSPACE, SEALED).behavior, "allow");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | grep -A5 "defaults to cwd"
```

Expected: FAIL — `'allow' !== 'deny'`.

- [ ] **Step 3: Add the recursive-tool set**

Add next to `PATH_TOOLS`:

```ts
/**
 * Tools that walk a directory tree. When their path argument is omitted the CLI
 * searches the CURRENT WORKING DIRECTORY, so "no path" is not "no target" — it
 * is a target we have to name ourselves before we can judge it.
 */
const RECURSIVE_TOOLS = new Set(["Grep", "Glob"]);
```

- [ ] **Step 4: Fold cwd into the candidate list**

In `decideToolPermission`, immediately after `const candidates = pathInputs(input);`:

```ts
  if (candidates.length === 0 && RECURSIVE_TOOLS.has(toolName)) {
    candidates.push(workspace);
  }
```

`workspace` is this call's cwd, so a sealed or ancestor cwd is now judged by the same loop.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: all pass, including `"a tool with no path input is allowed — there is nobody to ask"` (that test uses `Bash` and `WebFetch`, neither of which is recursive).

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts \
        dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): judge a recursive tool's implicit cwd target

Grep/Glob with no path search the cwd. The guard saw no candidate and
allowed it. Missing path now resolves to the call's workspace."
```

---

### Task 5: Guard the Agent tool

**What this closes:** `decideToolPermission` never inspects the Agent tool, so it falls through to ALLOW. Under Phase 1's delegation that permits `isolation: "remote"` — the build runs **off-host**, outside the sandbox, `denyRead`, `allowWrite` and every path check, with the workspace and ticket text leaving the machine. `run_in_background` also defaults to `true`, so lanes do not sequence and the gate scores a moving artefact.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: `decideToolPermission`'s optional 5th parameter `allowedAgents: readonly string[] = []`. Phase 1 passes the compiled shortlist; an empty list means "no delegation configured", which denies every Agent call.

- [ ] **Step 1: Write the failing test**

```ts
const AGENTS = ["code-reviewer", "debugger"];

function decideAgent(input: Record<string, unknown>): { behavior: string; message?: string } {
  return decideToolPermission("Agent", input, WORKSPACE, SEALED, AGENTS) as {
    behavior: string;
    message?: string;
  };
}

test("an Agent call escaping the host is denied", () => {
  for (const isolation of ["remote", "worktree"]) {
    const result = decideAgent({
      subagent_type: "code-reviewer",
      run_in_background: false,
      isolation,
    });
    assert.equal(result.behavior, "deny", `isolation:${isolation}`);
    assert.match(String(result.message), /isolation/i);
  }
});

test("an Agent call must be synchronous — background is the SDK default", () => {
  const omitted = decideAgent({ subagent_type: "code-reviewer" });
  assert.equal(omitted.behavior, "deny", "omitted run_in_background defaults to true");
  assert.match(String(omitted.message), /run_in_background/);

  const explicit = decideAgent({ subagent_type: "code-reviewer", run_in_background: true });
  assert.equal(explicit.behavior, "deny");
});

test("subagent_type is an allowlist, not a suggestion", () => {
  const result = decideAgent({ subagent_type: "general-purpose", run_in_background: false });
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /code-reviewer/, "the denial must name what IS allowed");
});

test("no configured shortlist means no delegation", () => {
  const result = decideToolPermission(
    "Agent",
    { subagent_type: "code-reviewer", run_in_background: false },
    WORKSPACE,
    SEALED,
  ) as { behavior: string };
  assert.equal(result.behavior, "deny");
});

test("NEGATIVE CONTROL: a well-formed Agent call on the shortlist is allowed", () => {
  assert.equal(
    decideAgent({ subagent_type: "code-reviewer", run_in_background: false, prompt: "review src/" }).behavior,
    "allow",
  );
  assert.equal(
    decideAgent({ subagent_type: "debugger", run_in_background: false }).behavior,
    "allow",
  );
});

test("NEGATIVE CONTROL: the Agent guard does not affect other tools", () => {
  assert.equal(decide("Read", `${WORKSPACE}/index.html`).behavior, "allow");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | grep -A5 "escaping the host"
```

Expected: FAIL — `'allow' !== 'deny'`.

- [ ] **Step 3: Add the Agent branch**

Add the 5th parameter to the signature:

```ts
export function decideToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
  sealedRoots: readonly string[],
  allowedAgents: readonly string[] = [],
): PermissionResult {
```

Then insert this block **before** the `candidates` logic, so an Agent call is judged on its own terms:

```ts
  // THE AGENT TOOL. Delegation is the point of this builder, but the Agent
  // tool's own fields can step outside every boundary the run has:
  //   - isolation:"worktree" writes outside sandbox.filesystem.allowWrite
  //   - isolation:"remote" runs the build OFF-HOST entirely
  //   - run_in_background DEFAULTS TO TRUE, so children keep writing the
  //     workspace after the parent returns and the gate scores a moving tree
  if (toolName === "Agent" || toolName === "Task") {
    if ("isolation" in input && input["isolation"] !== undefined) {
      return {
        behavior: "deny",
        message:
          "This run does not permit `isolation`. A worktree writes outside the run's workspace and " +
          "`remote` runs the build off this machine, outside every boundary protecting the sealed " +
          "acceptance suite. Delegate in-place instead.",
      };
    }
    if (input["run_in_background"] !== false) {
      return {
        behavior: "deny",
        message:
          "Set `run_in_background: false`. It defaults to true, and a background subagent keeps " +
          "writing the workspace after this phase returns — the gate would then score a moving " +
          "artefact and the result would depend on timing.",
      };
    }
    const requested = input["subagent_type"];
    if (typeof requested !== "string" || !allowedAgents.includes(requested)) {
      return {
        behavior: "deny",
        message:
          `\`${String(requested)}\` is not available to this run. Delegate to one of: ` +
          `${allowedAgents.join(", ") || "(none configured)"}.`,
      };
    }
    return { behavior: "allow" };
  }
```

`subagent_type` is a free string in the SDK's schema, so `Options.agents` limits only what the orchestrator can *see*. This branch is what makes the shortlist a boundary.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts \
        dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): guard the Agent tool before delegation exists

The Agent tool fell through to allow. isolation:'remote' would run the build
off-host outside every boundary; run_in_background defaults to true, which
would let children write the workspace while the gate scored it."
```

---

### Task 6: Correct STATUS.md and run the full suite

**Files:**
- Modify: `dashboard/STATUS.md` (§0 "The held-out boundary", §2 defect list, §3 untested list)

**Interfaces:**
- Consumes: the completed behaviour of Tasks 1-5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Run the full suite and capture the real number**

```bash
cd dashboard/server && npm test 2>&1 | tail -15
```

Record the actual pass/fail counts. Do not write a number into STATUS.md that you did not observe.

- [ ] **Step 2: Rewrite the §0 framing**

STATUS.md §0 currently describes `heldOutPass` as a strong signal that is not proof. That was written without knowledge of the ancestor bypass. Replace the section's opening with:

```markdown
### The held-out boundary

**Corrected 2026-07-28.** Until this date the boundary had an EXECUTED bypass:
`Grep{path:<ancestor-of-suite>, output_mode:"content"}` returned ALLOW, and
ripgrep walked down into the sealed store and returned held-out test source.
`decideToolPermission` asked only whether a candidate was INSIDE the suite,
never whether it CONTAINED it.

Three holes of the same class were open alongside it:

- `READ_TOOLS` was a tool-name allowlist, so `mcp__*` read tools and
  `ReadMcpResource` returned ALLOW on a sealed path.
- `Grep`/`Glob` with `path` omitted produced no candidate and were allowed; the
  CLI then searched the cwd.
- `results/scorer-out/<runId>/result.json` persisted
  `criterionCoverage[].testRefs` — held-out TEST TITLES — outside the sealed
  store, readable by any later run of the same frozen ticket.

**Every `heldOutPass` recorded before 2026-07-28 was produced under that
boundary, and there is no tripwire, so it cannot be determined retrospectively
whether any given run walked through it. Treat pre-2026-07-28 results as
unverified.**

All four are closed and unit-tested with negative controls. What has NOT
changed: the dashboard builder still runs on the HOST as the same user, so this
is a policy inside the CLI, not a filesystem boundary — still weaker than the
bake-off's container, which never mounts the held-out half at all.
```

- [ ] **Step 3: Add the Agent-tool guard to the defect list in §2**

```markdown
### 2.4 The Agent tool was unguarded

`decideToolPermission` inspected only path-bearing tools, so an Agent call fell
through to `{behavior:"allow"}`. That permitted `isolation:"remote"` — running
the build off-host, outside the sandbox, `denyRead`, `allowWrite` and every path
check, with the workspace and ticket text leaving the machine — and left
`run_in_background` at its default of `true`, under which children keep writing
the workspace after the phase returns and the gate scores a moving artefact.

Closed before any delegation was built. `subagent_type` is now an allowlist
enforced at the permission layer, because `Options.agents` limits only what the
orchestrator can see and `subagent_type` is a free string in the SDK schema.
```

- [ ] **Step 4: Record what is still unexercised in §3**

Append:

```markdown
- **`sandbox.filesystem.denyRead` has still never been exercised.** The value
  reaches the CLI (`test/settings-plumbing.mjs` asserts it appears in the
  `--settings` payload) but no run has proven the OS sandbox refuses a read.
  It is the ONLY layer covering Bash, because `autoAllowBashIfSandboxed: true`
  means a sandboxed Bash call never reaches `canUseTool`.
- **Whether `canUseTool` fires for subagent-originated calls is UNVERIFIED.**
  Inferred from the SDK's `agentID` plumbing and corroborated by
  `SDKPermissionDeniedMessage.agent_id`, but never observed. The Phase 0.5
  canary probe settles both this and the item above in one cheap run. Until it
  does, the Task 5 guard is proven only as a pure function, not as wiring.
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/STATUS.md
git commit -m "docs: correct STATUS.md on the held-out boundary

Records the executed ancestor bypass, the three same-class holes closed
alongside it, and that pre-2026-07-28 heldOutPass results are unverified."
```

---

## Definition of done

- [ ] `cd dashboard/server && npm test` passes: the 9 pre-existing tests plus 17 new ones (2 + 3 + 4 + 2 + 6 across Tasks 1-5).
- [ ] `cd dashboard/server && npm run typecheck` is clean.
- [ ] `grep -rn "heldOutRoot" dashboard/server/src` returns nothing.
- [ ] `grep -rn "READ_TOOLS" dashboard/server/src` returns only the comment recording its removal.
- [ ] STATUS.md no longer describes the boundary as merely "not proof".
- [ ] **Nothing in `bakeoff/` was modified.** Verify with `git status`.

## What Phase 0 deliberately does NOT do

- **It does not prove the fixes work against a real subagent.** Every test here exercises a pure function. Phase 0.5's canary probe is what tests the wiring, and it is a separate plan.
- **It does not touch `sandbox.network`, `strictMcpConfig`, or the MCP posture.** Spec decision #7 enables all user-scope MCP servers; this plan makes that safe on the *read* boundary, which is the part that decides whether `heldOutPass` means anything.
- **It does not add the engine-level `settings.permissions.deny` layer.** That depends on an unresolved question about whether `Read(<glob>)` rules are filesystem-scoped or tool-name-scoped (spec §10 item 5).
