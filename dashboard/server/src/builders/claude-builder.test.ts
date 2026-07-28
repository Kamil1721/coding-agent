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
import { REPORT_CONTRACT_REMINDER, boundsFor, shortlistFor } from "../agent-shortlist.js";
import type { CompactionRecord, ContextSample, ContextUsageEnvelope } from "../build-context.js";
import type { RunEnvironment } from "../build-environment.js";
import {
  announceEnvironment,
  buildOptions,
  canonicaliseForDecision,
  decideToolPermission,
  noteCompaction,
  sampleContextAt,
} from "./claude-builder.js";
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

test("a sealed path used as an object KEY is denied", () => {
  // The walker read VALUES only, so a map keyed BY path — the ordinary shape of
  // a multi-file write tool — carried the suite path in a position nothing
  // looked at. Probed against dist: ALLOW.
  assert.equal(
    decideWith("mcp__fs__write_files", {
      files: { [`${HELD_OUT}/FROZEN.json`]: "overwritten" },
    }).behavior,
    "deny",
  );
  // The same shape one level down, and with the sealed path as a key whose
  // value is itself an object rather than a string.
  assert.equal(
    decideWith("AnyTool", { edits: { batch: { [`${HELD_OUT}/T-1/x.mjs`]: { text: "x" } } } }).behavior,
    "deny",
  );
});

test("a free-text key shields only STRINGS, not a whole subtree", () => {
  // `if (FREE_TEXT_KEYS.has(key)) return;` sat ABOVE the type dispatch, so a
  // free-text name pruned the entire subtree beneath it, not just its own
  // string. Wrapping the path in an object under `content` or `command` walked
  // straight past the guard. Both probed against dist: ALLOW.
  assert.equal(decideWith("AnyTool", { content: { path: `${HELD_OUT}/t.mjs` } }).behavior, "deny");
  assert.equal(decideWith("AnyTool", { command: { file: `${HELD_OUT}/t.mjs` } }).behavior, "deny");
  // An ARRAY of objects under a free-text key is the same escape.
  assert.equal(
    decideWith("AnyTool", { prompt: [{ file_path: `${HELD_OUT}/t.mjs` }] }).behavior,
    "deny",
  );
});

test("deep nesting cannot outrun the walker", () => {
  // The cap was `depth > 6`, which is a number an attacker can simply exceed:
  // eight levels of `{nest:…}` returned ALLOW against dist. A total NODE BUDGET
  // bounds adversarial work without publishing a depth to step over.
  let nested: Record<string, unknown> = { file_path: `${HELD_OUT}/t.mjs` };
  for (let i = 0; i < 12; i += 1) nested = { nest: nested };
  assert.equal(decideWith("AnyTool", nested).behavior, "deny");

  let deeper: Record<string, unknown> = { file_path: `${HELD_OUT}/t.mjs` };
  for (let i = 0; i < 60; i += 1) deeper = { nest: deeper };
  assert.equal(decideWith("AnyTool", deeper).behavior, "deny", "sixty levels is still inside the budget");
});

test("NEGATIVE CONTROL: free-text STRINGS are still exempt", () => {
  // Scanning keys and subtrees must not start scanning free text itself: a
  // build legitimately writes a file whose CONTENT names the suite and
  // legitimately runs a shell command naming it.
  assert.equal(
    decideWith("Write", { file_path: `${WORKSPACE}/n.md`, content: `see ${HELD_OUT}` }).behavior,
    "allow",
  );
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
  // An array of free-text STRINGS inherits its key's exemption — the array
  // branch carries the parent key down, and must keep doing so.
  assert.equal(
    decideWith("Bash", { command: [`ls ${HELD_OUT}`, `cat ${HELD_OUT}/t.mjs`] }).behavior,
    "allow",
  );
  // And the ordinary keys of an ordinary call are not themselves paths.
  assert.equal(
    decideWith("Edit", {
      file_path: `${WORKSPACE}/a.ts`,
      old_string: `see ${HELD_OUT}`,
      new_string: "x",
      replace_all: false,
    }).behavior,
    "allow",
  );
});

test("NEGATIVE CONTROL: free-text keys are still not scanned", () => {
  assert.equal(
    decideWith("Write", { file_path: `${WORKSPACE}/n.md`, content: `see ${HELD_OUT}` }).behavior,
    "allow",
  );
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
  assert.equal(decideWith("Agent", { prompt: `read ${HELD_OUT}`, subagent_type: "x", run_in_background: false }).behavior, "deny");
});

test("free text is scoped PER TOOL — `command` is Bash's alone", () => {
  // The exemption for `command` is justified by ONE fact: with
  // `autoAllowBashIfSandboxed` a sandboxed Bash never reaches this function at
  // all, and the OS sandbox's denyRead is the layer that covers it. That
  // argument is about Bash. A key-name set handed the same exemption to every
  // tool that happens to name an argument `command` or `code` — including MCP
  // servers, which run OUTSIDE the CLI's sandbox and are covered by nothing else.
  assert.equal(decideWith("Bash", { command: `ls ${HELD_OUT}` }).behavior, "allow");
  assert.equal(
    decideWith("Monitor", {
      command: `${HELD_OUT}/t.mjs`,
      description: "watch",
      timeout_ms: 1000,
      persistent: false,
    }).behavior,
    "deny",
    "another tool's `command` is not Bash's",
  );
  assert.equal(decideWith("REPL", { code: `${HELD_OUT}/t.mjs` }).behavior, "deny");
});

test("an unknown tool inherits NO exemption — every globally-exempt name is judged", () => {
  // Each of these was exempt for EVERY tool name, so any MCP server could carry
  // a sealed path in one of them and be allowed. An unknown tool now gets no
  // exemptions at all: deny-by-default, the polarity the rest of this file uses.
  for (const key of [
    "content", "new_string", "old_string", "command", "prompt", "description",
    "instructions", "code", "script", "body", "message", "text", "new_source",
  ]) {
    assert.equal(
      decideWith("mcp__unknown__do", { [key]: `${HELD_OUT}/t.mjs` }).behavior,
      "deny",
      `key ${key} on an unknown tool`,
    );
  }
});

test("NEGATIVE CONTROL: each listed tool keeps its OWN free text", () => {
  // Scoping must not become "exempt nothing": these are the ordinary calls a
  // build makes, and each one names the suite in a field that is genuinely prose.
  assert.equal(
    decideWith("Write", { file_path: `${WORKSPACE}/n.md`, content: `see ${HELD_OUT}` }).behavior,
    "allow",
  );
  assert.equal(
    decideWith("Edit", {
      file_path: `${WORKSPACE}/a.ts`,
      old_string: `see ${HELD_OUT}`,
      new_string: `still ${HELD_OUT}`,
      replace_all: false,
    }).behavior,
    "allow",
  );
  assert.equal(
    decideWith("Bash", { command: `ls ${HELD_OUT}`, description: `list ${HELD_OUT}` }).behavior,
    "allow",
  );
  // MultiEdit's exemption is the one that depends on the walker carrying the
  // parent key DOWN through an array of objects: the free-text names sit on the
  // inner objects, not on `edits`. If that propagation is ever lost, ordinary
  // multi-edits start being denied as sealed reads.
  assert.equal(
    decideWith("MultiEdit", {
      file_path: `${WORKSPACE}/a.ts`,
      edits: [
        { old_string: `see ${HELD_OUT}`, new_string: "x", replace_all: false },
        { old_string: "y", new_string: `moved to ${HELD_OUT}`, replace_all: false },
      ],
    }).behavior,
    "allow",
  );
});

test("NEGATIVE CONTROL: a write PAYLOAD beginning with `/` is free text, not an escape", () => {
  // THIS IS WHAT PINS THE TABLE'S EXEMPTION SIDE, and it took a surviving mutant
  // to find. Deleting an entry mostly changes NOTHING observable, because a
  // non-exempt string is judged WHOLE: `content:"see <suite>"` resolves to
  // `<workspace>/see <suite>`, which is inside the workspace and not the suite,
  // so it is allowed with or without the exemption. Removing Bash's `command`
  // left the whole suite green.
  //
  // The observable class is a payload that RESOLVES OUTSIDE the workspace, which
  // for Write/Edit/MultiEdit/NotebookEdit — all PATH_TOOLS, where EVERY candidate
  // must be inside the workspace — means any string starting with `/`. That is
  // not a corner case: it is every file that opens with a `/* … */` banner and
  // every config value edited to an absolute path. Delete one of these four
  // entries and the corresponding line below goes red with the workspace message.
  assert.equal(
    decideWith("Write", {
      file_path: `${WORKSPACE}/src/generated.ts`,
      content: "/* generated — do not edit */\nexport const x = 1;\n",
    }).behavior,
    "allow",
    "a file whose first character is `/` is not a path out of the workspace",
  );
  assert.equal(
    decideWith("Edit", {
      file_path: `${WORKSPACE}/vite.config.ts`,
      old_string: "cacheDir: './node_modules/.vite'",
      new_string: "/usr/local/share/vite-cache",
      replace_all: false,
    }).behavior,
    "allow",
  );
  assert.equal(
    decideWith("MultiEdit", {
      file_path: `${WORKSPACE}/a.ts`,
      edits: [{ old_string: "x", new_string: "/* banner */", replace_all: false }],
    }).behavior,
    "allow",
  );
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

test("an Agent call carrying a sealed path is denied, shortlisted or not", () => {
  // The Agent branch RETURNED — allow or deny — before the sealed scan ever ran,
  // so a well-formed shortlisted call could carry a sealed path in any other
  // field and be allowed. That was unreachable while the shortlist was a module
  // constant fixed at `[]`; TASK 3 MADE IT REACHABLE by sourcing the shortlist
  // from `BuildRequest.allowedAgents`, and this test is no longer hypothetical.
  // The deny must come from the SEALED scan, not from the shortlist: every field
  // here is otherwise well-formed. The same assertion is made against the real
  // `Options.canUseTool` in "the Phase 0 guards survive delegation being
  // enabled" — this one keeps it on the pure predicate, where it is cheapest.
  for (const tool of ["Agent", "Task"]) {
    const result = decideToolPermission(
      tool,
      { subagent_type: "code-reviewer", run_in_background: false, file_path: `${HELD_OUT}/t.mjs` },
      WORKSPACE,
      SEALED,
      ["code-reviewer"],
    ) as { behavior: string; message?: string };
    assert.equal(result.behavior, "deny", tool);
    assert.match(String(result.message), /SEALED ACCEPTANCE SUITE/, `${tool}: the sealed scan must be what denies`);
  }
});

test("NEGATIVE CONTROL: a clean shortlisted Agent call still runs", () => {
  // Moving the sealed scan first must not deny delegation outright: `prompt` is
  // Agent's own free text and the shortlist still decides the rest.
  assert.equal(
    decideAgent({ subagent_type: "code-reviewer", run_in_background: false, prompt: "review src/" }).behavior,
    "allow",
  );
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
    // FAIL-CLOSED IS THE DEFAULT, here as in production. Every test that wants
    // delegation names its own shortlist, so no assertion below depends on a
    // permission it did not ask for.
    allowedAgents: [],
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
      environment() {},
      contextUsage() {},
      compaction() {},
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

/**
 * THE SEALED BOUNDARY AT THE POLICY TIER — Phase 1.1 Task 1.
 *
 * The rule string is spelled out HERE rather than imported from the builder. A
 * test that calls the production formatter to compute its own expectation is the
 * `settings-plumbing.test.ts` defect again: it asserts the implementation equals
 * itself and stays green when the syntax is wrong. The double slash is the
 * absolute-path prefix, so an already-absolute root yields THREE leading slashes
 * and that is correct — pinned literally in the second assertion, where the root
 * is a path that no canonicaliser will rewrite.
 */
test("WIRING: the sealed roots are denied at the POLICY tier, not only by the callback", () => {
  const managed = buildOptions(req(), false).managedSettings;
  assert.ok(managed, "managedSettings must be set — the callback is not a boundary on its own");
  assert.deepEqual(
    managed.permissions?.deny,
    // Canonicalised, exactly like denyRead: two layers that disagree about what a
    // path is are not two layers. Derived from SEALED rather than hardcoded,
    // because /tmp is a symlink to /private/tmp on macOS.
    SEALED.map(canonicaliseForDecision).map((root) => `Read(//${root}/**)`),
  );
  // The lock is what stops the owner's own settings widening it back open.
  assert.equal(managed.allowManagedPermissionRulesOnly, true);

  // THE THREE-SLASH FORM, PINNED. `/x/acceptance` does not exist, so
  // canonicalisation returns it unchanged and the expected string can be a
  // literal — the one place the syntax itself is asserted rather than derived.
  const literal = buildOptions(req({ sealedRoots: ["/x/acceptance"] }), false);
  assert.deepEqual(literal.managedSettings?.permissions?.deny, ["Read(///x/acceptance/**)"]);
});

test("WIRING: a run with no sealed roots denies nothing at the POLICY tier", () => {
  // THE NEGATIVE CONTROL. A boundary that denies everything would pass the test
  // above; this is what says the deny list is SCOPED to the roots it was given.
  const options = buildOptions(req({ sealedRoots: [] }), false);
  assert.deepEqual(options.managedSettings?.permissions?.deny, []);
  // The lock still ships: it is about whose rules count, not about how many.
  assert.equal(options.managedSettings?.allowManagedPermissionRulesOnly, true);
});

test("WIRING: no MCP server is available to a build", () => {
  const managed = buildOptions(req(), false).managedSettings;
  // An empty allowlist is documented as "no servers are allowed". The builder
  // writes code in a workspace; it has no business deploying, driving a browser
  // or spawning a remote agent, and REMOVING that surface is complete by
  // construction in a way that enumerating dangerous tool names never is.
  assert.deepEqual(managed?.allowedMcpServers, []);
  // The `Only` lock stops the owner's own settings re-adding any.
  assert.equal(managed?.allowManagedMcpServersOnly, true);
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

test("WIRING: the owner's environment is loaded", () => {
  // This REPLACES "settingSources stays empty — no uncontrolled input". The
  // reversal is deliberate, on probe evidence plus an owner decision, and the
  // full justification lives on the value in `buildOptions`.
  //
  // Probed 2026-07-28: settingSources [] yields 16 skills, ALL built-in, and
  // ZERO of the owner's 41; ["user"] yields 162 skills and 144+ agents.
  // AgentDefinition.skills can only name a DISCOVERED skill, so [] silently
  // preloads nothing.
  assert.deepEqual(buildOptions(req(), false).settingSources, ["user"]);
});

test("WIRING: loading user settings does NOT weaken the sealed boundary", async () => {
  // The claim this test makes EXECUTABLE rather than prose: `settingSources`
  // widens what a build can SEE, never what it may DO. denyRead, allowWrite,
  // `canUseTool` and the Agent guard are all set here in `buildOptions`, not in
  // ~/.claude/settings.json, so loading the owner's environment cannot move any
  // of them. Asserted against the SAME options object that carries ["user"].
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  assert.deepEqual(options.settingSources, ["user"], "the premise: user settings ARE loaded");

  assert.deepEqual(options.sandbox?.filesystem?.denyRead, SEALED.map(canonicaliseForDecision));
  assert.deepEqual(options.sandbox?.filesystem?.allowWrite, [canonicaliseForDecision(WORKSPACE)]);
  assert.equal(options.sandbox?.enabled, true);
  assert.equal(options.sandbox?.failIfUnavailable, true);
  assert.equal(typeof options.canUseTool, "function");

  const decideWithUserSettings = options.canUseTool;
  assert.equal(typeof decideWithUserSettings, "function", "no permission callback survived");

  // Structural equality above proves the arrays; these two calls prove the
  // predicate still behaves. The sealed suite is unreadable...
  const sealed = await decideWithUserSettings?.(
    "Read",
    { file_path: `${HELD_OUT}/t.mjs` },
    callContext(),
  );
  assert.equal(sealed?.behavior, "deny");
  assert.match(
    sealed && sealed.behavior === "deny" ? sealed.message : "",
    /SEALED ACCEPTANCE SUITE/,
  );

  // ...and the Agent guard is still the only thing that decides delegation.
  //
  // RE-POINTED IN TASK 3, NOT DELETED. This assertion used to read "delegation
  // must stay closed until Task 3 opens it", which was true while the shortlist
  // was a module constant fixed at `[]`. Task 3 moved the boundary onto
  // `request.allowedAgents`, so left alone this test would have stayed green off
  // the fail-closed default while its own comment described a mechanism that no
  // longer exists — passively green, and lying. It now makes the SAME claim
  // against the new mechanism, and it is still the strongest single proof that
  // user settings did not reach the boundary:
  //
  // `wordpress-master` is a REAL agent in ~/.claude/agents (verified on disk),
  // so under `settingSources: ["user"]` the CLI discovers it and would happily
  // run it. It is denied anyway, because the request did not name it. What the
  // owner's environment makes VISIBLE and what this run may USE are two
  // different sets, and only the second is a permission.
  const offShortlist = await decideWithUserSettings?.(
    "Agent",
    { subagent_type: "wordpress-master", run_in_background: false, prompt: "review" },
    callContext(),
  );
  assert.equal(
    offShortlist?.behavior,
    "deny",
    "a discoverable owner agent the request did not name must still be denied",
  );

  // ...while the agent the REQUEST named runs. Without this the assertion above
  // would pass against a guard that had simply stopped delegating at all.
  const delegated = await decideWithUserSettings?.(
    "Agent",
    { subagent_type: "code-reviewer", run_in_background: false, prompt: "review" },
    callContext(),
  );
  assert.equal(delegated?.behavior, "allow", "the request's own shortlist is what opens delegation");

  // NEGATIVE CONTROL: none of the above is a deny-everything stub.
  const allowed = await decideWithUserSettings?.(
    "Write",
    { file_path: `${WORKSPACE}/index.html` },
    callContext(),
  );
  assert.equal(allowed?.behavior, "allow");
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

/**
 * DELEGATION, THROUGH THE OPTIONS OBJECT THE SDK IS ACTUALLY HANDED.
 *
 * The `decideAgent` tests near the top of this file exercise the PURE predicate
 * with a shortlist passed by hand; they proved the branch was correct while
 * `buildOptions` still fed it a module constant of `[]`, so the whole branch was
 * dead code in production. These tests close that gap: they read the shortlist
 * off `BuildRequest` exactly as a run does, through the async `canUseTool` the
 * SDK calls, which is the only path that can be trusted to be live.
 *
 * Every call below is `await`ed. `makeCanUseTool` returns an async arrow, so
 * `o.canUseTool(...)` is a Promise and `.behavior` on it is `undefined` —
 * `assert.equal(undefined, "deny")` fails loudly but `assert.notEqual` style
 * checks would have passed silently.
 */
test("delegation is ON for shortlisted agents", async () => {
  const o = buildOptions(req({ allowedAgents: ["code-reviewer", "debugger"] }), false);
  for (const type of ["code-reviewer", "debugger"]) {
    const r = await o.canUseTool?.(
      "Agent",
      { subagent_type: type, run_in_background: false, prompt: "review" },
      callContext(),
    );
    assert.equal(r?.behavior, "allow", type);
  }
  // `Task` is the same tool under its other name; a shortlist that only opened
  // one of the two names would be half a boundary in the other direction.
  const asTask = await o.canUseTool?.(
    "Task",
    { subagent_type: "debugger", run_in_background: false },
    callContext(),
  );
  assert.equal(asTask?.behavior, "allow");
});

test("delegation stays CLOSED for anything off the shortlist", async () => {
  const o = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  // `general-purpose` is the SDK's own built-in and the name a model reaches for
  // first; `wordpress-master` is a real agent on disk, discoverable under
  // `settingSources: ["user"]`; `""` and `"Agent"` are the malformed shapes.
  for (const type of ["general-purpose", "wordpress-master", "", "Agent"]) {
    const r = await o.canUseTool?.(
      "Agent",
      { subagent_type: type, run_in_background: false },
      callContext(),
    );
    assert.equal(r?.behavior, "deny", type);
  }
  // A missing field is not an empty string: `allowedAgents.includes(undefined)`
  // would be false anyway, but the typeof check is what makes that a decision.
  const missing = await o.canUseTool?.("Agent", { run_in_background: false }, callContext());
  assert.equal(missing?.behavior, "deny", "no subagent_type at all");
});

test("the Phase 0 guards survive delegation being enabled", async () => {
  // The failure this is written against: turning delegation on by filling the
  // shortlist, and the isolation/background/sealed checks quietly becoming
  // unreachable because the allow now returns before them. Each call here is
  // WELL-FORMED apart from the one field under test, and names an agent that IS
  // on the shortlist, so nothing but the guard under test can produce the deny.
  const o = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const call = (input: Record<string, unknown>) => o.canUseTool?.("Agent", input, callContext());

  for (const isolation of ["remote", "worktree"]) {
    const r = await call({ subagent_type: "code-reviewer", run_in_background: false, isolation });
    assert.equal(r?.behavior, "deny", `isolation:${isolation}`);
    assert.match(r && r.behavior === "deny" ? r.message : "", /isolation/i);
  }

  // `run_in_background` DEFAULTS TO TRUE in the SDK, so an omitted field is the
  // dangerous case, not the safe one.
  const background = await call({ subagent_type: "code-reviewer" });
  assert.equal(background?.behavior, "deny", "omitted run_in_background");
  assert.match(
    background && background.behavior === "deny" ? background.message : "",
    /run_in_background/,
  );

  // THE ORDERING ASSERTION. The sealed scan runs BEFORE the Agent branch, so a
  // shortlisted, synchronous, isolation-free call carrying a sealed path in any
  // other field is still denied — and the message proves it was the SEALED scan
  // that denied it, not the shortlist.
  const sealed = await call({
    subagent_type: "code-reviewer",
    run_in_background: false,
    file_path: `${HELD_OUT}/t.mjs`,
  });
  assert.equal(sealed?.behavior, "deny", "a sealed path on a SHORTLISTED Agent call");
  assert.match(
    sealed && sealed.behavior === "deny" ? sealed.message : "",
    /SEALED ACCEPTANCE SUITE/,
    "the sealed scan must be what denies, not the shortlist",
  );
});

test("the PRODUCTION shortlist round-trips through the guard, name for name", async () => {
  // A REGRESSION GUARD, green on arrival — not a TDD red, and said plainly
  // rather than dressed up as one. It exists because every other test in this
  // file hands the guard a shortlist it wrote itself, so all 111 would stay
  // green if `shortlistFor` started returning nothing, or if a single one of
  // Task 2's 26 names were misspelled. A wrong name does not fail loudly: the
  // orchestrator asks for an agent, the guard denies it, and the lane produces
  // nothing, which looks exactly like a lane that had nothing to do.
  //
  // `fullstack` is what `orchestrator.ts` passes until the Task 5 classifier
  // lands, so this is the literal set a run is given today.
  const production = shortlistFor("fullstack");
  assert.ok(production.length > 0, "shortlistFor must never hand the guard an empty list");
  const o = buildOptions(req({ allowedAgents: production }), false);
  for (const type of production) {
    const r = await o.canUseTool?.(
      "Agent",
      { subagent_type: type, run_in_background: false, prompt: "go" },
      callContext(),
    );
    assert.equal(r?.behavior, "allow", type);
  }
});

test("an empty shortlist still denies everything — fail closed", async () => {
  // The default state of the system and the reason `allowedAgents` is required
  // rather than optional: a build that is handed no shortlist does the work
  // itself. It does not get the 144 agents the owner's settings made visible.
  const o = buildOptions(req({ allowedAgents: [] }), false);
  for (const tool of ["Agent", "Task"]) {
    const r = await o.canUseTool?.(
      tool,
      { subagent_type: "code-reviewer", run_in_background: false },
      callContext(),
    );
    assert.equal(r?.behavior, "deny", tool);
    assert.match(r && r.behavior === "deny" ? r.message : "", /none configured/);
  }

  // NEGATIVE CONTROL: an empty shortlist closes DELEGATION, not the build.
  const write = await o.canUseTool?.(
    "Write",
    { file_path: `${WORKSPACE}/index.html` },
    callContext(),
  );
  assert.equal(write?.behavior, "allow");
});

/**
 * THE SHAPE BACKSTOP — Phase 1.1 Task 3.
 *
 * The Agent branch was gated on the tool NAME, and
 * `mcp__plugin_railway_railway__railway-agent{isolation:"remote"}` matched none
 * of it while running the build off this machine entirely. Enumerating such
 * tools is the READ_TOOLS mistake on a third axis: the list is never complete.
 */
test("a delegation-shaped MCP tool is judged, not waved through on its name", () => {
  const result = decideToolPermission(
    "mcp__plugin_railway_railway__railway-agent",
    { isolation: "remote", run_in_background: true, prompt: "ship it" },
    "/w",
    [],
    ["code-reviewer"],
  ) as { behavior: string; message?: string };
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /isolation/i);
});

test("an ordinary tool carrying none of those fields is untouched — negative control", () => {
  // Without this, "judge everything" would pass the test above while breaking
  // every ordinary MCP read the build legitimately makes.
  const result = decideToolPermission("mcp__x__list_things", { limit: 10 }, "/w", [], []);
  assert.equal(result.behavior, "allow");
});

test("an Agent call carrying NONE of the three fields is still denied", () => {
  // THE REGRESSION THIS PINS, and why the branch condition is a DISJUNCTION
  // rather than the shape check alone. `subagent_type` is OPTIONAL in the SDK's
  // own `AgentInput` (sdk-tools.d.ts:496) and `run_in_background` documents
  // itself as defaulting to background — so `Agent{description, prompt}` is a
  // schema-valid call that carries none of the three delegation fields. Under a
  // pure `isDelegationShaped(input)` condition it leaves the branch unjudged,
  // is not a PATH_TOOL, and returns ALLOW: a background general-purpose
  // delegation waved through by the guard that exists to stop exactly that.
  const result = decideToolPermission(
    "Agent",
    { description: "review it", prompt: "go" },
    "/w",
    [],
    ["code-reviewer"],
  ) as { behavior: string; message?: string };
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /run_in_background/);
});

/**
 * THE PER-AGENT DEFINITIONS — Phase 1.1 Task 4.
 *
 * `boundsFor()` shipped through Phase 1 with ZERO production call sites: the
 * report contract was prose in a plan document and the turn budgets bound
 * nothing. An unused function that reads like a boundary is worse than no
 * function. These tests are what make the call site real.
 */
test("every shortlisted agent is DEFINED with its bounds, not just named", () => {
  const options = buildOptions(
    req({ allowedAgents: ["code-reviewer", "nextjs-developer"] }),
    false,
  );
  const agents = options.agents ?? {};
  assert.deepEqual(Object.keys(agents).sort(), ["code-reviewer", "nextjs-developer"]);

  const reviewer = agents["code-reviewer"];
  assert.ok(reviewer, "a shortlisted agent must be defined, not just permitted");
  // The report contract has to reach the subagent's own prompt, or it is prose
  // in a plan document that nothing enforces.
  assert.match(reviewer.prompt, /report/i);
  assert.match(reviewer.prompt, /code-reviewer/, "and the agent must know what it is");
  assert.equal(reviewer.criticalSystemReminder_EXPERIMENTAL, REPORT_CONTRACT_REMINDER);

  // `boundsFor()` finally binds to something the engine reads.
  const builder = agents["nextjs-developer"];
  assert.ok(builder);
  assert.equal(reviewer.maxTurns, boundsFor("code-reviewer").maxTurns);
  assert.equal(builder.maxTurns, boundsFor("nextjs-developer").maxTurns);
  // NOT ONE CONSTANT WEARING TWO HATS. Without this, `maxTurns: 15` everywhere
  // would satisfy both assertions above while binding nothing per agent.
  assert.notEqual(reviewer.maxTurns, builder.maxTurns);
});

test("a subagent gets no MCP tools and cannot detach", () => {
  const def = (buildOptions(req({ allowedAgents: ["code-reviewer"] }), false).agents ?? {})[
    "code-reviewer"
  ];
  assert.ok(def);
  // CRITICAL 5: a background child was measured at 625 tools against the
  // parent's 42. `mcp__*` is documented to remove ALL MCP tools.
  assert.deepEqual(def.disallowedTools, ["mcp__*"]);
  // CRITICAL 1, the half that does NOT depend on `canUseTool` being consulted:
  // a detached child keeps writing the workspace after the phase returns, and
  // the gate would then score a moving artefact.
  assert.equal(def.background, false);
});

test("an empty shortlist defines NO agents — the negative control", () => {
  // The fail-closed default, and the assertion that says these definitions are
  // built from the request rather than from a table in this module.
  assert.deepEqual(buildOptions(req({ allowedAgents: [] }), false).agents, {});
});

test("the environment the CLI reports is emitted on the sink AND logged", async () => {
  // `settingSources: ["user"]` is the largest unrecorded input this program has,
  // and the header of claude-builder.ts demands no UNRECORDED input. The record
  // is only made if this branch fires: capture without emission is the same as
  // no capture, because the orchestrator is what persists it.
  const emitted: RunEnvironment[] = [];
  const logs: string[] = [];
  const sink = {
    ...req().sink,
    environment: (env: RunEnvironment) => emitted.push(env),
    log: (_level: "info" | "warn" | "error", text: string) => logs.push(text),
  };

  const environment = announceEnvironment(
    {
      session_id: "sess-9",
      cwd: WORKSPACE,
      model: "claude-opus-5",
      claude_code_version: "2.0.0",
      agents: ["code-reviewer"],
      skills: ["postgres", "taste-skill"],
      tools: ["Read", "Agent"],
      mcp_servers: [{ name: "context7", status: "connected" }],
      plugins: [{ name: "railway" }],
    },
    sink,
  );

  assert.equal(emitted.length, 1, "the sink is the only route to the run directory");
  assert.deepEqual(emitted[0], environment);
  assert.deepEqual(environment.skills, ["postgres", "taste-skill"]);
  assert.equal(
    logs.filter((line) => /environment —/.test(line)).length,
    1,
    "and one line says what loaded, while the build is starting",
  );
  assert.match(logs.join("\n"), /context7/, "including which MCP servers appeared");
});

/**
 * PHASE 1 TASK 7 STEP 5 — CONTEXT SAMPLING, EXERCISED WITHOUT A CLI.
 *
 * Same argument as `announceEnvironment` above: the `for await` loop is reachable
 * only by spending subscription quota, so what a unit test can prove is that the
 * sampler emits, logs, and cannot take the build down. What it cannot prove is
 * that the loop calls it — that single call site is the residual, and it is
 * stated rather than implied.
 *
 * THE TIMEOUT IS INJECTED for the same reason `canonicalise` is: a 5-second
 * production default would otherwise make the "never answers" test take five
 * seconds, and a test slow enough to skip is a test that gets skipped.
 */
function collectingSink(): {
  sink: BuildRequest["sink"];
  samples: ContextSample[];
  compactions: CompactionRecord[];
  logs: string[];
} {
  const samples: ContextSample[] = [];
  const compactions: CompactionRecord[] = [];
  const logs: string[] = [];
  return {
    samples,
    compactions,
    logs,
    sink: {
      ...req().sink,
      contextUsage: (sample: ContextSample) => samples.push(sample),
      compaction: (record: CompactionRecord) => compactions.push(record),
      log: (_level: "info" | "warn" | "error", text: string) => logs.push(text),
    },
  };
}

const USAGE: ContextUsageEnvelope = {
  totalTokens: 150_000,
  maxTokens: 200_000,
  percentage: 75,
  model: "claude-opus-5",
  categories: [{ name: "Messages", tokens: 140_000 }],
};

const BOUNDARY = { taskId: "t1", agent: "code-reviewer", lane: "review", status: "completed" } as const;

test("a closed lane samples the context, emits it and logs it", async () => {
  const { sink, samples, logs } = collectingSink();
  const sample = await sampleContextAt(BOUNDARY, { getContextUsage: async () => USAGE }, sink);

  assert.equal(sample?.percentage, 75);
  assert.equal(samples.length, 1, "the sink is the only route to the run directory");
  assert.deepEqual(samples[0], sample);
  assert.equal(logs.filter((line) => /context/i.test(line)).length, 1);
});

test("a sample that never answers does not stall the build", async () => {
  // `getContextUsage()` is a control request over the CLI's stdio. A CLI that has
  // wedged would otherwise hold the message loop open forever, and the build
  // would hang on INSTRUMENTATION — the tail wagging the dog.
  const { sink, samples, logs } = collectingSink();
  const started = Date.now();
  const sample = await sampleContextAt(
    BOUNDARY,
    { getContextUsage: () => new Promise<ContextUsageEnvelope>(() => {}) },
    sink,
    20,
  );

  assert.equal(sample, null);
  assert.equal(samples.length, 0);
  assert.ok(Date.now() - started < 2_000, "it gave up rather than waiting");
  assert.equal(logs.length, 1, "and said so, because a missing sample must be explainable");
});

test("a sample that throws is recorded as a warning and the build carries on", async () => {
  const { sink, samples, logs } = collectingSink();
  const sample = await sampleContextAt(
    BOUNDARY,
    {
      getContextUsage: () => Promise.reject(new Error("transport closed")),
    },
    sink,
  );

  assert.equal(sample, null);
  assert.equal(samples.length, 0);
  assert.match(logs.join("\n"), /transport closed/, "the reason is kept, not swallowed");
});

test("a compaction is emitted on the sink and named in the log", () => {
  // The single best explanation for a run that produced mediocre output. If it is
  // not captured while it happens, it is not recoverable afterwards at all.
  const { sink, compactions, logs } = collectingSink();
  const record = noteCompaction(
    {
      compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 60_000, duration_ms: 900 },
    },
    sink,
  );

  assert.equal(record.preTokens, 180_000);
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0], record);
  assert.match(logs.join("\n"), /compact/i);
});
