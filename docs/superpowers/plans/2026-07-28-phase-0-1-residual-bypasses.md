# Phase 0.1 — Close the Residual Boundary Bypasses

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close four confirmed bypasses that survived Phase 0, and add the wiring test that would have caught a disconnected boundary.

**Architecture:** Phase 0 replaced a *tool-name* allowlist with a *key* allowlist — the same fail-open shape rotated onto a different axis. This phase inverts the polarity: scan every value except named free-text keys, compare canonical forms rather than raw strings, and resolve symlinks in the fs-aware caller so the decision function stays pure.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test`. No new dependencies.

## Confirmed bypasses (probed against `dist/`, not theorised)

```
Read{file_path:"/tmp/dash/Acceptance/t.mjs"}          -> allow   case variant
Read{file_path:"/tmp/DASH/acceptance/t.mjs"}          -> allow   case variant
Glob{pattern:"/tmp/dash/acceptance/**/*"}             -> allow   `pattern` unlisted
Grep{pattern:"x", glob:"*.mjs"}  (path omitted)       -> allow   glob key suppresses cwd fold
ReadMcpResource{uri:"file:///tmp/dash/acceptance/…"}  -> allow   scheme defeats resolve()
```

`ls -d /Users/kamilborzecki/Projects/coding-agent/DASHBOARD` resolves — **this volume is case-insensitive**, so the case variant does not merely return `allow`, the OS then opens the real file.

## Global Constraints

- **`decideToolPermission` stays PURE** — no filesystem access, no async. Symlink resolution belongs to the caller. This is what makes it unit-testable without spawning a CLI.
- **Deny-by-default is the posture.** Any value that is not explicitly free text is treated as a possible path. Over-denying on a sealed root is the safe direction; under-denying is how Phase 0 failed.
- **Every widening keeps its negative control.** A deny-everything rule must still fail the suite.
- **Preserve the deny messages verbatim** — tests assert `/SEALED ACCEPTANCE SUITE/` and `/only write inside its own workspace/`.
- Test command: `npm test` from `dashboard/server/`. It runs `tsc` first.
- **Never modify `bakeoff/`.**
- **No AI-attribution trailer in any commit.** No `git push`.

---

### Task 1: Invert the polarity — scan every value except free text

**Closes:** `Glob{pattern:…}`, `Grep{glob:…}` cwd suppression, and every path-bearing key no one predicted.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Produces: `function pathCandidates(input: Record<string, unknown>): string[]` — replaces `pathInputs`. Task 2 consumes it.

- [ ] **Step 1: Write the failing tests**

```ts
test("Glob's REAL required argument is `pattern`, and it is judged", () => {
  // sdk-tools.d.ts:630-638 — GlobInput { pattern: string; path?: string }.
  // Phase 0 listed `glob`, which is not a Glob key at all.
  assert.equal(decideWith("Glob", { pattern: `${HELD_OUT}/**/*` }).behavior, "deny");
  assert.equal(decideWith("Glob", { pattern: `${HELD_OUT}/T-1/*.mjs` }).behavior, "deny");
});

test("a present non-path key does not suppress judging the cwd", () => {
  // Phase 0 folded cwd in ONLY when zero candidates were found, so any stray
  // key turned the fold off and the guard judged the wrong target.
  const r = decideToolPermission("Grep", { pattern: "x", glob: "*.mjs" }, "/tmp/dash", SEALED);
  assert.equal((r as { behavior: string }).behavior, "deny");
});

test("an unlisted key carrying a sealed path is still denied", () => {
  for (const key of ["sourcePath", "outputFile", "notebook", "somethingNew", "attachment"]) {
    assert.equal(decideWith("AnyTool", { [key]: `${HELD_OUT}/t.mjs` }).behavior, "deny", key);
  }
});

test("nested object and array values are reached", () => {
  assert.equal(decideWith("AnyTool", { opts: { where: `${HELD_OUT}/t.mjs` } }).behavior, "deny");
  assert.equal(decideWith("AnyTool", { targets: [`${WORKSPACE}/a`, `${HELD_OUT}/b`] }).behavior, "deny");
});

test("NEGATIVE CONTROL: free-text keys are still not scanned", () => {
  assert.equal(
    decideWith("Write", { file_path: `${WORKSPACE}/n.md`, content: `see ${HELD_OUT}` }).behavior,
    "allow",
  );
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
  assert.equal(decideWith("Agent", { prompt: `read ${HELD_OUT}`, subagent_type: "x", run_in_background: false }).behavior, "deny");
});

test("NEGATIVE CONTROL: ordinary values are not mistaken for paths", () => {
  assert.equal(decideWith("Grep", { pattern: "TODO", path: `${WORKSPACE}` }).behavior, "allow");
  assert.equal(decideWith("Glob", { pattern: "**/*.ts", path: `${WORKSPACE}` }).behavior, "allow");
  assert.equal(decideWith("Read", { file_path: `${WORKSPACE}/a.ts`, limit: 100, offset: 0 }).behavior, "allow");
});
```

The last assertion in the free-text test is deliberate: an `Agent` call is denied here by the **Agent branch** (unlisted `subagent_type`), not by path scanning — it documents that free-text exemption does not weaken the Agent guard.

- [ ] **Step 2: Run to verify they fail**

```bash
cd dashboard/server && npm test 2>&1 | tail -30
```

Expected: the Glob, cwd-suppression, unlisted-key and nested tests FAIL with `'allow' !== 'deny'`.

- [ ] **Step 3: Replace the key allowlist with a free-text denylist**

Delete `PATH_INPUT_KEYS` and `pathInputs`. Replace with:

```ts
/**
 * Keys whose values are FREE TEXT, not paths.
 *
 * This is a denylist, and that polarity is the whole point. Phase 0 used an
 * allowlist of path-bearing keys and it failed exactly as the tool-name
 * allowlist before it did: `Glob`'s required argument is `pattern`, which was
 * not on the list, so `Glob{pattern:"<suite>/**\/*"}` returned ALLOW. An
 * allowlist is only as good as the enumerator's imagination; a denylist of
 * free text fails closed against every key nobody thought of.
 *
 * A build legitimately writes a file whose CONTENT mentions the suite path and
 * legitimately runs a shell command naming it, so these stay exempt.
 */
const FREE_TEXT_KEYS = new Set([
  "content", "new_string", "old_string", "command", "prompt",
  "description", "instructions", "code", "script", "body", "message", "text",
]);

/**
 * Every value in the input that could name a path — which is every string that
 * is not explicitly free text, at any depth.
 */
function pathCandidates(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  const visit = (key: string, value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (FREE_TEXT_KEYS.has(key)) return;
    if (typeof value === "string") {
      if (value.length > 0) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(key, item, depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(k, v, depth + 1);
      }
    }
  };
  for (const [k, v] of Object.entries(input)) visit(k, v, 0);
  return found;
}
```

- [ ] **Step 4: Always fold the cwd for recursive tools**

In `decideToolPermission`, replace the conditional fold with an unconditional one:

```ts
  const candidates = pathCandidates(input);
  // A recursive tool searches its cwd IN ADDITION to any path it names. Phase 0
  // folded cwd in only when no candidate was found, so a stray `glob` key
  // switched the fold off and the guard judged the wrong target affirmatively.
  if (RECURSIVE_TOOLS.has(toolName)) candidates.push(workspace);
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: all pass. If `"NEGATIVE CONTROL: ordinary values are not mistaken for paths"` fails, a non-path string like `"TODO"` is resolving into a sealed root — it must not, because `resolve(workspace, "TODO")` stays inside the workspace.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): scan every input value, not an allowlist of keys

Glob's required argument is \`pattern\`, which the key allowlist did not
contain, so Glob{pattern:<suite>/**/*} returned ALLOW. A stray key also
suppressed the cwd fold, making the guard pass while judging the wrong
target. Polarity inverted to deny-by-default."
```

---

### Task 2: Compare canonical forms, not raw strings

**Closes:** case-variant paths (the volume is case-insensitive), `file://` URIs, percent-encoding.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts`
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: `pathCandidates` (Task 1).
- Produces: `function normaliseCandidate(value: string): string`, and a case-folded `containsOrIsInside`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a CASE-VARIANT path cannot reach the suite — this volume is case-insensitive", () => {
  assert.equal(decideWith("Read", { file_path: "/tmp/dash/Acceptance/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Read", { file_path: "/tmp/DASH/acceptance/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Read", { file_path: "/TMP/DASH/ACCEPTANCE/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Grep", { path: "/tmp/Dash" }).behavior, "deny");
});

test("a file:// URI is resolved to a path before comparison", () => {
  assert.equal(decideWith("ReadMcpResource", { uri: `file://${HELD_OUT}/t.mjs` }).behavior, "deny");
  assert.equal(decideWith("Read", { file_path: `file://${HELD_OUT}/t.mjs` }).behavior, "deny");
});

test("percent-encoded forms are decoded before comparison", () => {
  assert.equal(decideWith("Read", { path: "/tmp/dash/%61cceptance/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Read", { path: `${WORKSPACE}/%2e%2e/%2e%2e/%2e%2e/acceptance/t.mjs` }).behavior, "deny");
});

test("NEGATIVE CONTROL: canonicalisation does not widen the boundary", () => {
  assert.equal(decideWith("Read", { file_path: "/tmp/dash/acceptance-notes/x.md" }).behavior, "allow");
  assert.equal(decideWith("Read", { file_path: "/tmp/dash/Acceptance-Notes/x.md" }).behavior, "allow");
  assert.equal(decideWith("Write", { file_path: `${WORKSPACE}/index.html` }).behavior, "allow");
  assert.equal(decideWith("Read", { file_path: "https://example.com/acceptance" }).behavior, "allow");
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd dashboard/server && npm test 2>&1 | tail -30
```

Expected: the case, `file://` and percent tests FAIL.

- [ ] **Step 3: Add the normaliser**

Add `import { fileURLToPath } from "node:url";` at the top, then:

```ts
/**
 * Reduce a raw input value to the path a consuming tool would actually open.
 *
 * Three transforms, each closing a confirmed bypass:
 *   file:// URI  — `resolve()` treats the scheme as a relative segment, so
 *                  `file:///x/y` became `<workspace>/file:/x/y` and missed.
 *   percent      — the consuming tool decodes AFTER our check, so `%61cceptance`
 *                  and `%2e%2e` reached the suite unseen.
 *   other scheme — `https://…` is not a path; leave it alone rather than
 *                  mangling it into one.
 */
function normaliseCandidate(value: string): string {
  let s = value;
  if (/^file:\/\//i.test(s)) {
    try { s = fileURLToPath(s); } catch { /* malformed; fall through */ }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    return s; // a non-file URL is not a filesystem path
  }
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(s); i += 1) {
    try { s = decodeURIComponent(s); } catch { break; }
  }
  return s;
}
```

The decode loop runs at most twice: once handles ordinary encoding, twice catches `%252e`; an unbounded loop would be a denial-of-service on a crafted input.

- [ ] **Step 4: Case-fold the comparison**

Replace `containsOrIsInside` with:

```ts
/**
 * True when `candidate` is inside `root` OR recursively CONTAINS it.
 *
 * CASE-FOLDED, deliberately. macOS and Windows volumes are case-INSENSITIVE
 * while `resolve()` is case-PRESERVING and `===`/`startsWith` are
 * case-SENSITIVE, so `/x/Acceptance` compared unequal to `/x/acceptance` and
 * the OS then opened the very file the comparison had just cleared. Folding
 * over-denies on a case-sensitive volume — that is the safe direction for a
 * sealed root.
 */
function containsOrIsInside(root: string, candidate: string, base: string): boolean {
  const rootAbs = resolve(root).toLowerCase();
  const target = resolve(base, normaliseCandidate(candidate)).toLowerCase();
  if (target === rootAbs) return true;
  if (target.startsWith(`${rootAbs}/`)) return true;
  return rootAbs.startsWith(target === "/" ? "/" : `${target}/`);
}
```

Leave `insideWorkspace`/`insideDir` case-sensitive: for writes, over-denying would block legitimate work, and `allowWrite` covers that boundary at the OS level.

- [ ] **Step 5: Run to verify they pass**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/builders/claude-builder.ts dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): compare canonical, case-folded paths

The volume is case-insensitive and the comparison was case-sensitive, so
Read{file_path:'<home>/Acceptance/...'} was allowed and the OS opened the
file. Also normalises file:// URIs and percent-encoding, both of which
reached the suite unseen."
```

---

### Task 3: Resolve symlinks in the caller, and test the wiring

**Closes:** symlink laundering, and the CRITICAL gap where the boundary could be disconnected with the suite green.

**Files:**
- Modify: `dashboard/server/src/builders/claude-builder.ts` (the `canUseTool` closure only)
- Test: `dashboard/server/src/builders/claude-builder.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `export function canonicaliseForDecision(candidatePath: string): string` — fs-aware, used only by the closure.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { canonicaliseForDecision } from "./claude-builder.js";

test("a symlink pointing into the suite is resolved before the decision", () => {
  const base = mkdtempSync(join(tmpdir(), "seal-"));
  const suite = join(base, "acceptance");
  const ws = join(base, "workspace");
  mkdirSync(suite, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(suite, "canary.txt"), "CANARY");
  symlinkSync(suite, join(ws, "link"));

  const laundered = join(ws, "link", "canary.txt");
  // Purely lexical resolution keeps it inside the workspace and allows it.
  assert.equal(decideToolPermission("Read", { file_path: laundered }, ws, [suite]).behavior, "allow");
  // Canonicalising first is what closes it — this is what the closure does.
  const real = canonicaliseForDecision(laundered);
  assert.equal(decideToolPermission("Read", { file_path: real }, ws, [suite]).behavior, "deny");
});

test("canonicaliseForDecision is total — a non-existent path passes through", () => {
  assert.equal(canonicaliseForDecision("/no/such/path/at/all.txt"), "/no/such/path/at/all.txt");
});
```

The first test documents an honest limit: the pure function cannot see a symlink, so the *closure* must canonicalise. Keeping both assertions makes that split explicit rather than implied.

- [ ] **Step 2: Run to verify it fails**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
```

Expected: a compile error — `canonicaliseForDecision` is not exported yet.

- [ ] **Step 3: Add the fs-aware canonicaliser**

Add `import { realpathSync } from "node:fs";` then:

```ts
/**
 * Resolve a path through symlinks, as far as it exists.
 *
 * `decideToolPermission` is pure and therefore lexical, so it cannot see that
 * `<workspace>/link/x` is really `<suite>/x`. Creating that link is a legal
 * in-workspace write and needs no read of the target, so the pure check alone
 * is defeatable. The fs-aware step belongs here, in the caller.
 *
 * Total by construction: a path that does not exist yet (every Write target)
 * has its longest existing ancestor resolved and the remainder re-appended.
 */
export function canonicaliseForDecision(candidatePath: string): string {
  let head = resolve(candidatePath);
  const tail: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      return tail.length === 0 ? realpathSync.native(head) : join(realpathSync.native(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(candidatePath);
      tail.unshift(basename(head));
      head = parent;
    }
  }
  return resolve(candidatePath);
}
```

Add `dirname`, `basename`, `join` to the existing `node:path` import.

- [ ] **Step 4: Use it in the closure**

Replace the `canUseTool` closure body:

```ts
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      // Canonicalise the WORKSPACE too: if it is itself reached via a symlink,
      // a lexical comparison against a realpath'd candidate would never match.
      const ws = canonicaliseForDecision(workspace);
      const roots = sealedRoots.map(canonicaliseForDecision);
      return decideToolPermission(toolName, input, ws, roots, allowedAgents);
    };
```

Declare `const allowedAgents: readonly string[] = [];` immediately above with a comment: delegation is not configured until Phase 1 supplies a shortlist, and an empty list denies every Agent call — fail-closed by design.

- [ ] **Step 5: Add the wiring test**

```ts
test("WIRING: the builder's canUseTool actually receives the sealed roots", async () => {
  // Phase 0's CRITICAL gap: mutating the call site to pass [] left the suite
  // green, so the boundary could be disconnected from the orchestrator and
  // nothing failed. This test fails if that wire is ever cut.
  const src = readFileSync(new URL("./claude-builder.ts", import.meta.url).pathname, "utf8");
  assert.match(src, /decideToolPermission\(\s*toolName,\s*input,\s*ws,\s*roots/,
    "the closure must pass the resolved sealed roots, not a literal");
  assert.match(src, /const roots = sealedRoots\.map\(canonicaliseForDecision\)/,
    "roots must derive from request.sealedRoots");
  assert.doesNotMatch(src, /decideToolPermission\([^)]*,\s*\[\]\s*\)/,
    "no call site may pass an empty sealed-roots literal");
});
```

This is a source-shape assertion, which is weaker than driving the builder — recorded as such in Task 4's STATUS.md note. It costs nothing and kills the exact mutation that went undetected.

- [ ] **Step 6: Run and commit**

```bash
cd dashboard/server && npm test 2>&1 | tail -20
git add dashboard/server/src/builders/claude-builder.ts dashboard/server/src/builders/claude-builder.test.ts
git commit -m "fix(security): canonicalise through symlinks in the permission closure

resolve() is lexical, so <workspace>/link -> <suite> laundered a read past
the check. Adds a wiring assertion: Phase 0 could be mutated to pass an
empty sealed-roots list with the whole suite still green."
```

---

### Task 4: Correct STATUS.md's overclaims

**Files:**
- Modify: `dashboard/STATUS.md`
- Modify: `dashboard/server/src/builders/claude-builder.ts` (header comment + stale file reference)
- Modify: `dashboard/server/src/builders/codex-builder.ts:24` (parenthetical)

- [ ] **Step 1: Run the suite and record the real numbers**

```bash
cd dashboard/server && npm test 2>&1 | tail -12 && npm run typecheck
```

- [ ] **Step 2: Correct the `denyRead` claim**

STATUS.md currently cites `settings-plumbing.test.ts` as executed proof that `denyRead` reaches the CLI. That test never invokes `ClaudeSubscriptionBuilder` — it builds its own `Options` literal and asserts on its own local variable. Reword to:

```markdown
| `sandbox.filesystem.denyRead` names the sealed roots to the CLI's OS sandbox | Anthropic | **NOT EXECUTED.** `settings-plumbing.test.ts` proves the SDK forwards a `denyRead` array it was handed directly; it never calls the builder, so it cannot detect the builder sending the wrong roots or none. Neither the plumbing from `request.sealedRoots` nor the OS enforcement has been exercised. |
```

- [ ] **Step 3: Record the residual limits in §3**

```markdown
- **Whether `denyRead` covers in-process tools is UNRESOLVED.** The typings scope
  filesystem clauses to "within the sandbox"/"sandboxed commands", and state
  explicitly that in-process WebFetch is not gated by the network equivalent. If
  `denyRead` binds only sandboxed Bash, then for `Read`/`Glob`/`Grep`/MCP the
  permission callback is the ONLY layer — not one of two. The Phase 0.5 canary
  probe settles it.
- **The wiring test is a source-shape assertion, not an execution.** It greps
  `claude-builder.ts` for the call shape. It kills the specific mutation that
  went undetected in Phase 0, but a test that drove `ClaudeSubscriptionBuilder`
  against the stub executable would be strictly stronger.
- **Case-folding over-denies on a case-sensitive volume.** A genuinely distinct
  `/x/ACCEPTANCE` would be denied alongside `/x/acceptance`. Deliberate: the
  safe direction for a sealed root.
```

- [ ] **Step 4: Fix the stale source comments**

- `claude-builder.ts` header: the "What IS enforced" list still describes `canUseTool` as only a write check. Add the Agent/Task guard, and note the shortlist is empty today so delegation is denied outright.
- `claude-builder.ts`: the reference to `test/settings-plumbing.mjs` names a file that does not exist — it is `src/builders/settings-plumbing.test.ts`.
- `codex-builder.ts:24`: the parenthetical names one root; `sealedRoots` now carries two. Add `dashboard/results/scorer-out`, noting it carries held-out test titles.

- [ ] **Step 5: Commit**

```bash
git add dashboard/STATUS.md dashboard/server/src/builders/claude-builder.ts dashboard/server/src/builders/codex-builder.ts
git commit -m "docs: correct the denyRead claim and record residual limits

settings-plumbing.test.ts never invokes the builder, so it cannot prove the
builder sends the right roots. Records that denyRead's coverage of in-process
tools is unresolved pending the canary probe."
```

---

## Definition of done

- [ ] `npm test` passes; record the real counts.
- [ ] `npm run typecheck` clean.
- [ ] All five confirmed bypasses now return `deny`, verified by direct probe against `dist/`.
- [ ] Negative controls still `allow`: ordinary writes, `Grep{path:"."}`, `acceptance-notes`, screenshots, content mentioning the suite path.
- [ ] Nothing under `bakeoff/` modified.
- [ ] No AI-attribution trailer in any commit.
