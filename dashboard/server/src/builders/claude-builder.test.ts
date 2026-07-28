/**
 * claude-builder.test.ts — the permission decision, exercised directly.
 *
 * WHY THIS FILE EXISTS. Until 2026-07-27 the builder's `canUseTool` denied only
 * WRITES outside the workspace. The sealed acceptance suite sits on the same
 * host filesystem, two directories above the workspace, and nothing stopped a
 * build from READING it. A builder that reads the held-out tests can satisfy
 * them without satisfying the ticket, which makes `heldOutPass` and
 * `falseFinish` meaningless for that run — and nothing downstream detects it.
 *
 * `decideToolPermission` is a pure function precisely so this can be an
 * EXECUTED check rather than a reviewed one: no CLI is spawned, no quota is
 * consumed, and the negative controls below fail if the deny is ever widened
 * into "deny everything" (which would pass a naive test while breaking builds).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOptions, canonicaliseForDecision, decideToolPermission } from "./claude-builder.js";
import type { BuildRequest } from "./types.js";

const WORKSPACE = "/tmp/dash/runs/r1/workspace";
const HELD_OUT = "/tmp/dash/acceptance";
const SCORER_OUT = "/tmp/dash/results/scorer-out";
const SEALED = [HELD_OUT, SCORER_OUT];

function decide(tool: string, path: string): { behavior: string; message?: string } {
  const result = decideToolPermission(tool, { file_path: path }, WORKSPACE, SEALED);
  return result as { behavior: string; message?: string };
}

test("the held-out suite cannot be READ, by any read-family tool", () => {
  const holdout = `${HELD_OUT}/T-1/holdout/greeting.test.mjs`;
  for (const tool of ["Read", "Grep", "Glob", "NotebookRead"]) {
    const result = decide(tool, holdout);
    assert.equal(result.behavior, "deny", `${tool} must be denied on a held-out path`);
    assert.match(
      String(result.message),
      /SEALED ACCEPTANCE SUITE/,
      `${tool}'s denial must say what the path is, not just "no"`,
    );
  }
});

test("the held-out suite cannot be WRITTEN either", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    const result = decide(tool, `${HELD_OUT}/T-1/FROZEN.json`);
    assert.equal(result.behavior, "deny", `${tool} must be denied on a held-out path`);
    assert.match(String(result.message), /SEALED ACCEPTANCE SUITE/);
  }
});

test("a RELATIVE path that climbs out of the workspace into the suite is denied", () => {
  // The builder's cwd IS the workspace, so this is the form a build would
  // actually produce. An absolute-path-only check would miss it entirely.
  const result = decide("Read", "../../../acceptance/T-1/holdout/greeting.test.mjs");
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /SEALED ACCEPTANCE SUITE/);
});

test("the suite directory itself is denied, not only files under it", () => {
  assert.equal(decide("Glob", HELD_OUT).behavior, "deny");
  assert.equal(decide("Read", `${HELD_OUT}/`).behavior, "deny");
});

test("NEGATIVE CONTROL: ordinary work in the workspace is still allowed", () => {
  // A deny-everything rule would pass every test above. These are the ones
  // that fail if the boundary is drawn too wide.
  assert.equal(decide("Write", `${WORKSPACE}/index.html`).behavior, "allow");
  assert.equal(decide("Read", `${WORKSPACE}/index.html`).behavior, "allow");
  assert.equal(decide("Edit", "src/app.ts").behavior, "allow");
  assert.equal(decide("Read", `${WORKSPACE}/visible-acceptance/smoke.spec.mjs`).behavior, "allow");
});

test("NEGATIVE CONTROL: reading outside the workspace is allowed when it is not the suite", () => {
  // Reads are not restricted to the workspace — a build legitimately reads
  // node_modules, /usr/lib and its own toolchain. Only the suite is off limits.
  assert.equal(decide("Read", "/usr/share/doc/readme").behavior, "allow");
  assert.equal(decide("Grep", "/tmp/dash/runs/r1/results/build.log").behavior, "allow");
});

test("a path that merely starts with the suite root's characters is NOT the suite", () => {
  // `/tmp/dash/acceptance-notes` must not be caught by a prefix comparison.
  assert.equal(decide("Read", "/tmp/dash/acceptance-notes/x.md").behavior, "allow");
});

test("writes outside the workspace are still denied, with the workspace reason", () => {
  const result = decide("Write", "/tmp/dash/runs/r1/results/run.json");
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /only write inside its own workspace/);
});

test("a tool with no path input is allowed — there is nobody to ask", () => {
  assert.equal(decideToolPermission("Bash", { command: "npm ci" }, WORKSPACE, SEALED).behavior, "allow");
  assert.equal(decideToolPermission("WebFetch", {}, WORKSPACE, SEALED).behavior, "allow");
});

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
  // And dropping the tool-name allowlist must not become "deny every unknown
  // tool": an MCP read of a BENIGN path is ordinary work and stays allowed.
  assert.equal(decideWith("mcp__filesystem__read_file", { path: `${WORKSPACE}/src/a.ts` }).behavior, "allow");
});

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

test("Glob's REAL required argument is `pattern`, and it is judged", () => {
  // sdk-tools.d.ts:630-638 — GlobInput { pattern: string; path?: string }.
  // Phase 0 listed `glob`, which is not a Glob key at all.
  assert.equal(decideWith("Glob", { pattern: `${HELD_OUT}/**/*` }).behavior, "deny");
  assert.equal(decideWith("Glob", { pattern: `${HELD_OUT}/T-1/*.mjs` }).behavior, "deny");
});

test("a glob pattern is judged by its literal prefix, not the raw string", () => {
  // A glob names a TREE. `/tmp/**/*.mjs` is neither inside the sealed root nor a
  // literal ancestor of it — `resolve()` keeps the `**` as a path segment — yet
  // the tool walks every file under `/tmp`, suite included. All five ALLOWed
  // against dist before this test existed, except the last, which is here as a
  // regression guard because its `path` is already an ancestor.
  assert.equal(
    decideWith("Glob", { pattern: `${HELD_OUT}/../**/*.mjs` }).behavior, "deny",
    "climb out of the suite then wildcard back down",
  );
  assert.equal(
    decideWith("Glob", { pattern: "/tmp/dash/**/*.mjs" }).behavior, "deny",
    "wildcard from the suite's parent",
  );
  assert.equal(
    decideWith("Glob", { pattern: "/tmp/**/*.test.mjs" }).behavior, "deny",
    "wildcard from a distant ancestor",
  );
  assert.equal(
    decideWith("Glob", { pattern: "../../../**/*.mjs" }).behavior, "deny",
    "relative climb then wildcard",
  );
  assert.equal(
    decideWith("Grep", { path: "/tmp/dash", glob: "**/*.mjs" }).behavior, "deny",
    "Grep's separate glob argument over an ancestor path",
  );
});

test("truncation goes back to the last separator, and covers every metacharacter", () => {
  // MID-SEGMENT. Every assertion above puts the `*` straight after a `/`, so
  // cutting at the metacharacter and cutting at the preceding separator agree
  // and the difference is untested. `/tmp/dash/accept*` is NOT `/tmp/dash/`:
  // as a literal it is neither inside `/tmp/dash/acceptance` nor an ancestor of
  // it, so a prefix that stops at the metacharacter returns ALLOW while the
  // glob expands into the suite.
  assert.equal(
    decideWith("Glob", { pattern: "/tmp/dash/accept*/T-1/*.mjs" }).behavior, "deny",
    "mid-segment wildcard must truncate to its containing directory",
  );
  // `*` is not the only metacharacter a shell-style glob honours.
  assert.equal(
    decideWith("Glob", { pattern: "/tmp/dash/acceptanc?/t.mjs" }).behavior, "deny",
    "single-character wildcard",
  );
  assert.equal(
    decideWith("Glob", { pattern: "/tmp/dash/{acceptance,src}/**" }).behavior, "deny",
    "brace alternation",
  );
  assert.equal(
    decideWith("Glob", { pattern: "/tmp/dash/[a-z]cceptance/t.mjs" }).behavior, "deny",
    "character class",
  );
});

test("NEGATIVE CONTROL: workspace-scoped globs still work", () => {
  // Truncation must not become "deny every pattern". These are the ordinary
  // shape of a build's own search and they stay allowed.
  assert.equal(decideWith("Glob", { pattern: "**/*.ts" }).behavior, "allow", "bare recursive glob");
  assert.equal(decideWith("Glob", { pattern: "src/**/*.tsx" }).behavior, "allow", "relative subtree");
  assert.equal(
    decideWith("Glob", { pattern: `${WORKSPACE}/**/*.ts` }).behavior, "allow",
    "absolute workspace subtree",
  );
  assert.equal(
    decideWith("Glob", { pattern: `${WORKSPACE}/src/comp*/*.tsx` }).behavior, "allow",
    "mid-segment wildcard inside the workspace",
  );
  // A literal path is still judged literally — the raw value is kept alongside
  // its prefix, so truncation cannot LOSE a deny either.
  assert.equal(
    decideWith("Glob", { pattern: `${HELD_OUT}/T-1/*.mjs` }).behavior, "deny",
    "the raw value is still judged",
  );
  // Next.js dynamic-route filenames carry brackets and are not globs at all.
  assert.equal(
    decideWith("Read", { file_path: `${WORKSPACE}/src/app/[id]/page.tsx` }).behavior, "allow",
    "a bracketed filename inside the workspace",
  );
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

test("NEGATIVE CONTROL: a notebook cell's SOURCE is free text, not a path", () => {
  // `new_source` is NotebookEdit's write payload — cell code, which routinely
  // contains `../` inside string literals. `resolve()` collapses `..` anywhere
  // in a string, so scanning this key would deny a legitimate edit whose cell
  // happens to open a relative file. It is the same category as `content` and
  // `code`, and being a write payload it cannot enable a sealed READ.
  assert.equal(
    decideWith("NotebookEdit", {
      notebook_path: `${WORKSPACE}/n.ipynb`,
      new_source: "data = open('../../../../etc/hosts')",
      cell_type: "code",
      edit_mode: "replace",
    }).behavior,
    "allow",
  );
});

test("NEGATIVE CONTROL: ordinary values are not mistaken for paths", () => {
  assert.equal(decideWith("Grep", { pattern: "TODO", path: `${WORKSPACE}` }).behavior, "allow");
  assert.equal(decideWith("Glob", { pattern: "**/*.ts", path: `${WORKSPACE}` }).behavior, "allow");
  assert.equal(decideWith("Read", { file_path: `${WORKSPACE}/a.ts`, limit: 100, offset: 0 }).behavior, "allow");
});

test("a CASE-VARIANT path cannot reach the suite — this volume is case-insensitive", () => {
  assert.equal(decideWith("Read", { file_path: "/tmp/dash/Acceptance/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Read", { file_path: "/tmp/DASH/acceptance/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Read", { file_path: "/TMP/DASH/ACCEPTANCE/t.mjs" }).behavior, "deny");
  assert.equal(decideWith("Grep", { path: "/tmp/Dash" }).behavior, "deny");
});

test("a file:// URI is resolved to a path before comparison", () => {
  assert.equal(decideWith("ReadMcpResource", { uri: `file://${HELD_OUT}/t.mjs` }).behavior, "deny");
  assert.equal(decideWith("Read", { file_path: `file://${HELD_OUT}/t.mjs` }).behavior, "deny");
  // RFC 8089 allows the authority to be omitted entirely. `fileURLToPath` maps
  // `file:/tmp/x` to `/tmp/x` exactly as it maps `file:///tmp/x`, so a matcher
  // anchored on `file://` misses a form that opens the real file. Probed:
  // ALLOW before this assertion existed.
  assert.equal(decideWith("Read", { file_path: `file:${HELD_OUT}/t.mjs` }).behavior, "deny");
  assert.equal(decideWith("ReadMcpResource", { uri: `FILE://${HELD_OUT}/t.mjs` }).behavior, "deny");
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
  // The `file:` anchor is wider than `file://`, so it keeps its own control:
  // `fileURLToPath("file:notes.txt")` is "/notes.txt", which is not the suite
  // and must stay allowed. Probed, not assumed.
  assert.equal(decideWith("Read", { file_path: "file:notes.txt" }).behavior, "allow");
  assert.equal(decideWith("Read", { file_path: "file:./x" }).behavior, "allow");
});

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

  // `Task` is the same tool under its other name. Guarding only "Agent" would
  // leave the whole branch reachable by renaming the call.
  const asTask = decideToolPermission(
    "Task",
    { subagent_type: "code-reviewer", run_in_background: false },
    WORKSPACE,
    SEALED,
  ) as { behavior: string };
  assert.equal(asTask.behavior, "deny", "Task is Agent under another name");
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
  // The `Task` name must be guarded, not blanket-denied: the same well-formed
  // call is allowed under either name.
  assert.equal(
    decideToolPermission(
      "Task",
      { subagent_type: "debugger", run_in_background: false },
      WORKSPACE,
      SEALED,
      AGENTS,
    ).behavior,
    "allow",
  );
});

test("NEGATIVE CONTROL: the Agent guard does not affect other tools", () => {
  assert.equal(decide("Read", `${WORKSPACE}/index.html`).behavior, "allow");
});

/**
 * A real workspace on disk with a symlink laundering a path into the suite.
 *
 * The root is REALPATH'd on purpose. On macOS `os.tmpdir()` is
 * `/var/folders/...`, itself a symlink to `/private/var/folders/...`, so a
 * fixture rooted at the raw tmpdir would make every assertion below turn on
 * that incidental symlink rather than on the one under test — it would go red
 * whether or not the boundary works. Observed: `realpathSync.native` on a raw
 * `mkdtempSync(tmpdir())` path changes the `/var` prefix to `/private/var`.
 *
 * The module-level `WORKSPACE`/`HELD_OUT` constants are deliberately NOT used
 * here for the same reason: `/tmp` is a symlink to `/private/tmp` on this
 * volume, so feeding canonicalised output back alongside a raw `/tmp/...`
 * constant compares two spellings of the same directory and proves nothing.
 */
function symlinkFixture(): { base: string; suite: string; ws: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "seal-")));
  const suite = join(base, "acceptance");
  const ws = join(base, "workspace");
  mkdirSync(suite, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(suite, "canary.txt"), "CANARY");
  symlinkSync(suite, join(ws, "link"));
  return { base, suite, ws };
}

test("a symlink pointing into the suite is resolved before the decision", () => {
  const { suite, ws } = symlinkFixture();
  const laundered = join(ws, "link", "canary.txt");

  // Purely lexical resolution keeps it inside the workspace and allows it. This
  // is an honest limit of the PURE function, documented rather than implied:
  // `resolve()` cannot see a symlink, and creating one is a legal in-workspace
  // write that needs no read of the target.
  assert.equal(decideToolPermission("Read", { file_path: laundered }, ws, [suite]).behavior, "allow");

  // Canonicalising first is what closes it.
  const real = canonicaliseForDecision(laundered);
  assert.equal(decideToolPermission("Read", { file_path: real }, ws, [suite]).behavior, "deny");

  // THE ASSERTION THAT MATTERS: the RAW path a build would actually send,
  // judged the way the closure judges it. Canonicalising only the workspace and
  // the sealed roots — which is all the plan's closure did — leaves this ALLOW;
  // that was probed against dist/ before this line existed.
  for (const candidate of [laundered, "link/canary.txt", "./link/../link/canary.txt"]) {
    const result = decideToolPermission(
      "Read",
      { file_path: candidate },
      ws,
      [suite],
      [],
      canonicaliseForDecision,
    ) as { behavior: string; message?: string };
    assert.equal(result.behavior, "deny", `raw laundered candidate ${candidate}`);
    assert.match(String(result.message), /SEALED ACCEPTANCE SUITE/);
  }
});

test("a symlink escaping the workspace does not launder a WRITE past the confinement", () => {
  // The sealed-root check does not fire here: the destination is not the suite,
  // it is merely outside the workspace. Only the write confinement stands, and
  // lexically `<ws>/escape/evil.txt` looks like an in-workspace path.
  const { base, suite, ws } = symlinkFixture();
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(ws, "escape"));
  const target = join(ws, "escape", "evil.txt");

  assert.equal(decideToolPermission("Write", { file_path: target }, ws, [suite]).behavior, "allow");

  const result = decideToolPermission(
    "Write",
    { file_path: target },
    ws,
    [suite],
    [],
    canonicaliseForDecision,
  ) as { behavior: string; message?: string };
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /only write inside its own workspace/);
});

test("canonicaliseForDecision is total — a non-existent path passes through", () => {
  // Every Write names a path that does not exist yet, so a canonicaliser that
  // threw or returned "" on ENOENT would fail the run rather than the read.
  assert.equal(canonicaliseForDecision("/no/such/path/at/all.txt"), "/no/such/path/at/all.txt");
  const { ws } = symlinkFixture();
  assert.equal(canonicaliseForDecision(join(ws, "a", "b", "c.txt")), join(ws, "a", "b", "c.txt"));
});

test("NEGATIVE CONTROL: canonicalising does not block ordinary work", () => {
  const { suite, ws } = symlinkFixture();
  const allowed = (input: Record<string, unknown>, tool: string): string =>
    (decideToolPermission(tool, input, ws, [suite], [], canonicaliseForDecision) as { behavior: string })
      .behavior;

  assert.equal(allowed({ file_path: join(ws, "src", "index.html") }, "Write"), "allow");
  assert.equal(allowed({ file_path: join(ws, "src", "app.ts") }, "Read"), "allow");
  assert.equal(allowed({ file_path: "src/app.ts" }, "Edit"), "allow");
  // A non-file URL must not be mangled into a path by the fs-aware step either.
  assert.equal(allowed({ file_path: "https://example.com/acceptance" }, "Read"), "allow");
  // Reads outside the workspace that are not the suite stay allowed.
  assert.equal(allowed({ file_path: "/usr/share/doc/readme" }, "Read"), "allow");
});

/**
 * THE WIRING, ASSERTED AS AN OBJECT.
 *
 * Phase 0.1's wiring test read this file's SOURCE and matched regexes against
 * it. It passed while the behaviour was gone: deleting `canUseTool` from the
 * `Options` literal, emptying `denyRead`, widening `allowWrite` to `/` and
 * turning the sandbox off each left the suite green at 76/74/0. A test that
 * greps source is not a test of behaviour — it reads as coverage while covering
 * nothing, which is worse than no test at all. It is deleted.
 *
 * `buildOptions` exists so the object handed to the SDK can be asserted
 * DIRECTLY. Every assertion below fails if the corresponding wire is cut.
 */
function req(overrides: Partial<BuildRequest> = {}): BuildRequest {
  const base: BuildRequest = {
    runId: "r1",
    prompt: "build it",
    workspace: WORKSPACE,
    sealedRoots: SEALED,
    modelId: "claude-opus-5",
    effort: null,
    resumeSessionId: null,
    signal: new AbortController().signal,
    sink: {
      log() {},
      tool() {},
      tokens() {},
      rateLimit() {},
      session() {},
      raw() {},
    },
    env: {},
  };
  return { ...base, ...overrides };
}

/** The three fields the SDK requires of a `canUseTool` caller. */
function callContext(): { signal: AbortSignal; toolUseID: string; requestId: string } {
  return { signal: new AbortController().signal, toolUseID: "tu-1", requestId: "rq-1" };
}

test("WIRING: canUseTool is actually handed to the SDK", () => {
  assert.equal(typeof buildOptions(req(), false).canUseTool, "function");
});

test("WIRING: denyRead carries every sealed root, canonicalised", () => {
  const options = buildOptions(req(), false);
  assert.deepEqual(
    options.sandbox?.filesystem?.denyRead,
    SEALED.map(canonicaliseForDecision),
  );
});

test("WIRING: allowWrite is the workspace and nothing else", () => {
  const options = buildOptions(req(), false);
  assert.deepEqual(options.sandbox?.filesystem?.allowWrite, [canonicaliseForDecision(WORKSPACE)]);
  // cwd shares the spelling: a cwd of `/tmp/...` against an allowWrite of
  // `/private/tmp/...` is the same layer disagreement this seam exists to close.
  assert.equal(options.cwd, canonicaliseForDecision(WORKSPACE));
});

test("WIRING: the sandbox is enabled, and fails closed unless opted out", () => {
  assert.equal(buildOptions(req(), false).sandbox?.enabled, true);
  assert.equal(buildOptions(req(), false).sandbox?.failIfUnavailable, true);
  assert.equal(buildOptions(req(), true).sandbox?.failIfUnavailable, false);
});

test("WIRING: the handed-in canUseTool actually denies a sealed path", async () => {
  // Behavioural, not structural: call the function the SDK would call.
  const decide = buildOptions(req(), false).canUseTool;
  assert.equal(typeof decide, "function", "the SDK is handed no permission callback at all");
  const denied = await decide?.("Read", { file_path: `${HELD_OUT}/t.mjs` }, callContext());
  assert.equal(denied?.behavior, "deny");
  assert.match(
    denied && denied.behavior === "deny" ? denied.message : "",
    /SEALED ACCEPTANCE SUITE/,
  );

  // NEGATIVE CONTROL: the wire is connected to the real predicate, not to a
  // deny-everything stub — ordinary in-workspace work still runs.
  const allowed = await decide?.("Read", { file_path: `${WORKSPACE}/src/app.ts` }, callContext());
  assert.equal(allowed?.behavior, "allow");
});

test("WIRING: settingSources stays empty — no uncontrolled input", () => {
  assert.deepEqual(buildOptions(req(), false).settingSources, []);
});

test("WIRING: a symlinked workspace is spelled the same way in every layer", () => {
  // The reason canonicalisation happens ONCE, inside buildOptions. Previously
  // the predicate saw `canonicaliseForDecision` output while denyRead/allowWrite
  // saw a lexical `resolve()`, so a workspace or suite reached through a symlink
  // was one path to the sandbox and another to the guard.
  const { base, suite, ws } = symlinkFixture();
  const linkedWs = join(base, "ws-link");
  symlinkSync(ws, linkedWs);
  const options = buildOptions(req({ workspace: linkedWs, sealedRoots: [suite] }), false);

  assert.deepEqual(options.sandbox?.filesystem?.allowWrite, [realpathSync.native(ws)]);
  assert.deepEqual(options.sandbox?.filesystem?.denyRead, [realpathSync.native(suite)]);
  assert.equal(options.cwd, realpathSync.native(ws));
});

test("WIRING: the closure INJECTS the canonicaliser — a laundered path is denied", async () => {
  // The fourth thing the deleted source-grep asserted, now behavioural: without
  // `canonicaliseForDecision` threaded into `decideToolPermission`, the raw
  // candidate stays lexical and `<ws>/link/canary.txt` reads the suite while
  // looking like an in-workspace path.
  const { suite, ws } = symlinkFixture();
  const decide = buildOptions(req({ workspace: ws, sealedRoots: [suite] }), false).canUseTool;
  assert.equal(typeof decide, "function");

  for (const candidate of [join(ws, "link", "canary.txt"), "link/canary.txt"]) {
    const result = await decide?.("Read", { file_path: candidate }, callContext());
    assert.equal(result?.behavior, "deny", `laundered candidate ${candidate}`);
    assert.match(
      result && result.behavior === "deny" ? result.message : "",
      /SEALED ACCEPTANCE SUITE/,
    );
  }

  // NEGATIVE CONTROL: a real in-workspace file is still writable.
  const allowed = await decide?.("Write", { file_path: join(ws, "index.html") }, callContext());
  assert.equal(allowed?.behavior, "allow");
});
