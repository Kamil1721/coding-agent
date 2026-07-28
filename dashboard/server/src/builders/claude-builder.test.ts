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
import type {
  HookCallbackMatcher,
  Options,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { REPORT_CONTRACT_REMINDER, boundsFor, shortlistFor } from "../agent-shortlist.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CompactionRecord, ContextSample, ContextUsageEnvelope } from "../build-context.js";
import type { RunEnvironment } from "../build-environment.js";
import type { RateLimitState, ResultUsageEnvelope } from "../claude-common.js";
import { modelRows, zeroTokens } from "../tokens.js";
import type { TokenTotals } from "../tokens.js";
import {
  ClaudeSubscriptionBuilder,
  announceEnvironment,
  buildOptions,
  canonicaliseForDecision,
  decideToolPermission,
  noteCompaction,
  recordResultTokens,
  sampleContextAt,
} from "./claude-builder.js";
import type { BuildSession } from "./claude-builder.js";
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
  // Agent's `prompt` is its own free text and is exempt here too — a build
  // legitimately writes prompts that NAME the suite without reading it.
  //
  // THIS LINE USED TO ASSERT `deny`, AND THE DENY WAS A PIGGYBACK. It came from
  // the shortlist (`subagent_type: "x"` was on no list), not from anything this
  // test is about, so it read as free-text coverage while measuring the Agent
  // branch. That branch is gone; the shortlist deny is asserted where it now
  // happens, in the HOOK tests below.
  assert.equal(decideWith("Agent", { prompt: `read ${HELD_OUT}` }).behavior, "allow");
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

/**
 * WHAT USED TO BE HERE — SIX `decideAgent` TESTS, DELETED IN PHASE 1.1 TASK 2.
 *
 * They asserted that `decideToolPermission` denied `isolation`, denied a
 * background delegation and enforced the shortlist. Every one of them PASSED,
 * and every one of them was measuring a function the engine never calls: probe A
 * ran the delegation under `acceptEdits`, `default` AND `dontAsk`, and this
 * callback was consulted for no tool at all while `wordpress-master` started
 * anyway. Six green tests over a dead branch is this project's signature defect
 * — a check that can only observe success — so the branch went and they went
 * with it.
 *
 * WHERE THE COVERAGE WENT, rather than being quietly dropped: the three
 * conditions are pinned on `decideDelegation` in delegation-hook.test.ts, and
 * pinned again END TO END through `buildOptions(...).hooks.PreToolUse` in the
 * HOOK tests below — which is the object the SDK is actually handed. Deleting a
 * test whose subject is gone is honest; deleting one whose subject moved would
 * not be.
 *
 * The two tests kept below are the ones whose subject did NOT move: the sealed
 * scan still runs for a delegation-named tool, and it still runs FIRST.
 */
test("an Agent call carrying a sealed path is denied by the SEALED scan", () => {
  // THE ORDERING THIS PINS, and it survived the branch deletion because it was
  // never about delegation. The Agent branch used to RETURN — allow as well as
  // deny — before the sealed scan ran, so a well-formed shortlisted call could
  // carry a sealed path in any other field and be allowed. The scan now runs
  // first for every tool name, and nothing below it returns early at all.
  //
  // Every field here is otherwise well-formed, so only the sealed scan can
  // produce this deny — and the message is asserted to prove it did.
  for (const tool of ["Agent", "Task"]) {
    const result = decideToolPermission(
      tool,
      { subagent_type: "code-reviewer", run_in_background: false, file_path: `${HELD_OUT}/t.mjs` },
      WORKSPACE,
      SEALED,
    ) as { behavior: string; message?: string };
    assert.equal(result.behavior, "deny", tool);
    assert.match(String(result.message), /SEALED ACCEPTANCE SUITE/, `${tool}: the sealed scan must be what denies`);
  }
});

test("NEGATIVE CONTROL: a clean Agent call is not denied by the sealed scan", () => {
  // Moving the sealed scan first must not deny delegation outright: `prompt` is
  // Agent's own free text and must not be read as a path.
  //
  // THIS ASSERTS LESS THAN ITS ANCESTOR DID, AND SAYS SO. `decideToolPermission`
  // no longer decides delegation, so "allow" here means "the sealed scan and the
  // write confinement found nothing", NOT "this delegation is permitted". The
  // permission is the hook's, and it is asserted there.
  assert.equal(
    decideToolPermission(
      "Agent",
      { subagent_type: "code-reviewer", run_in_background: false, prompt: "review src/" },
      WORKSPACE,
      SEALED,
    ).behavior,
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
    (decideToolPermission(tool, input, ws, [suite], canonicaliseForDecision) as { behavior: string })
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
  // `canUseTool` and the delegation HOOK are all set here in `buildOptions`, not
  // in ~/.claude/settings.json, so loading the owner's environment cannot move
  // any of them. Asserted against the SAME options object that carries ["user"].
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

  // ...and the DELEGATION guard is unmoved by the owner's settings either.
  //
  // RE-POINTED TWICE, NEVER DELETED, AND THE SECOND MOVE IS THE INTERESTING ONE.
  // Task 3 pointed it from a module constant at `request.allowedAgents`. Task 2
  // points it from `canUseTool` at the HOOK, because probe A measured the
  // callback consulted for no tool at all when the model delegates — so this
  // assertion had been passing against a mechanism that never ran. Left on
  // `canUseTool` it would now return ALLOW by fallthrough and go red for the
  // right reason; left there and "fixed" by deleting it, the strongest single
  // proof that user settings do not reach the delegation boundary would be gone.
  //
  // `wordpress-master` is a REAL agent in ~/.claude/agents (verified on disk),
  // so under `settingSources: ["user"]` the CLI discovers it and would happily
  // run it. It is denied anyway, because the request did not name it. What the
  // owner's environment makes VISIBLE and what this run may USE are two
  // different sets, and only the second is a permission.
  const offShortlist = await ask(options, "Agent", {
    subagent_type: "wordpress-master",
    run_in_background: false,
    prompt: "review",
  });
  assert.equal(
    offShortlist.hookSpecificOutput?.permissionDecision,
    "deny",
    "a discoverable owner agent the request did not name must still be denied",
  );

  // ...while the agent the REQUEST named runs. Without this the assertion above
  // would pass against a guard that had simply stopped delegating at all.
  assert.deepEqual(
    await ask(options, "Agent", {
      subagent_type: "code-reviewer",
      run_in_background: false,
      prompt: "review",
    }),
    { continue: true },
    "the request's own shortlist is what opens delegation",
  );

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
 * DELEGATION, THROUGH THE HOOK SLOT THE SDK IS ACTUALLY HANDED — Phase 1.1 Task 2.
 *
 * THESE TESTS REPLACE A SUITE THAT COULD ONLY OBSERVE A FUNCTION, NEVER A
 * BOUNDARY. Every delegation test in this file used to call `canUseTool`, and
 * probe A measured that the engine asks `canUseTool` for NO TOOL AT ALL when the
 * model delegates: the callback returned deny across `acceptEdits`, `default`
 * and `dontAsk`, and `wordpress-master` started anyway, in every arm. So the
 * whole delegation half of this file was green against a mechanism that never
 * ran — the project's signature defect, a check that can only observe success.
 *
 * Everything below goes through `buildOptions(...).hooks.PreToolUse`, which is
 * the object the SDK is handed. Calling `makeDelegationHook` directly instead
 * would be `settings-plumbing.test.ts` again: a factory asserted against itself,
 * green while nothing wires it in.
 */
type HookAnswer = {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

function preToolUse(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s-1",
    transcript_path: "/tmp/dash/runs/r1/transcript.jsonl",
    cwd: WORKSPACE,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu-1",
  };
}

/**
 * The ONE slot, read off the options object rather than constructed here.
 *
 * `matcher` is asserted ABSENT. Probe E registered three slots and they all
 * fired for the same `tool_use_id`, so which one carried the decision was never
 * measured — and a `matcher: "Task"` slot fired for a call whose `tool_name` was
 * "Agent", which plain name-matching does not explain. A no-matcher slot assumes
 * nothing about name resolution, and probe F Gap 3 confirmed it suffices alone.
 */
function delegationSlot(options: Options): HookCallbackMatcher {
  const slots = options.hooks?.PreToolUse;
  assert.ok(slots, "the SDK was handed NO PreToolUse hook — the guard does not run");
  assert.equal(slots.length, 1, "ONE slot is what was measured");
  const slot = slots[0];
  assert.ok(slot);
  assert.equal(slot.matcher, undefined, "the matcher must be OMITTED, not named");
  assert.equal(slot.hooks.length, 1, "exactly one callback");
  return slot;
}

/** Ask the hook the SDK would ask, with the three arguments `HookCallback` takes. */
async function ask(options: Options, toolName: string, toolInput: unknown): Promise<HookAnswer> {
  const callback = delegationSlot(options).hooks[0];
  assert.ok(callback);
  const answer = await callback(preToolUse(toolName, toolInput), "tu-1", {
    signal: new AbortController().signal,
  });
  return answer as HookAnswer;
}

function denialReason(answer: HookAnswer): string {
  assert.equal(answer.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(answer.hookSpecificOutput?.permissionDecision, "deny");
  return answer.hookSpecificOutput?.permissionDecisionReason ?? "";
}

test("HOOK: an off-shortlist delegation is DENIED where the engine actually asks", async () => {
  // `wordpress-master` is a REAL agent in ~/.claude/agents, so under
  // `settingSources: ["user"]` the CLI discovers it and would happily run it. It
  // is denied because the REQUEST did not name it: what the owner's environment
  // makes VISIBLE and what this run may USE are two different sets.
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const reason = denialReason(
    await ask(options, "Agent", {
      subagent_type: "wordpress-master",
      run_in_background: false,
      prompt: "review",
    }),
  );
  assert.match(reason, /wordpress-master/);
  // The reason reaches the MODEL verbatim as an is_error tool_result, so it has
  // to name what IS permitted.
  assert.match(reason, /code-reviewer/);

  // `general-purpose` is the SDK's own built-in and the name a model reaches for
  // first; `""` and `"Agent"` are the malformed shapes; a MISSING field is not
  // an empty string, and a non-string is malformed rather than absent — the
  // `typeof` half of the check is what makes each of those a decision rather
  // than an accident of `includes()`.
  for (const subagent_type of ["general-purpose", "", "Agent", 42, null]) {
    denialReason(await ask(options, "Agent", { subagent_type, run_in_background: false }));
  }
  denialReason(await ask(options, "Agent", { run_in_background: false }));
});

test("HOOK: SELECTIVITY — the shortlisted agent runs in the same configuration", async () => {
  // Measured in ONE live session: a single no-matcher slot allowed
  // `code-reviewer` (it started and billed 13842 tokens) and denied
  // `wordpress-master` (it did not start). Without this the test above would
  // pass against a hook that had simply stopped delegating at all.
  const options = buildOptions(req({ allowedAgents: ["code-reviewer", "debugger"] }), false);
  for (const type of ["code-reviewer", "debugger"]) {
    const answer = await ask(options, "Agent", {
      subagent_type: type,
      run_in_background: false,
      prompt: "review",
    });
    assert.deepEqual(answer, { continue: true }, type);
  }
  // AND THE SAME CALL UNDER THE OTHER NAME. `Task` is `Agent` renamed, and the
  // name half of the entry condition ROUTES both — so both must also be able to
  // come back allowed. A hook that blanket-denied anything called `Task` would
  // pass every deny assertion in this file while being half a boundary in the
  // other direction, which is why this is asserted rather than inferred from
  // membership of the name set.
  assert.deepEqual(
    await ask(options, "Task", { subagent_type: "debugger", run_in_background: false }),
    { continue: true },
    "Task is Agent under its other name — guarded, not blanket-denied",
  );
});

test("HOOK: the slot fires for EVERY tool, so everything else must continue", async () => {
  // THE MEASURED BUILD RULE THIS PINS. This slot is consulted for every tool,
  // Bash included. A callback that denies — or even omits `continue` — for
  // anything without delegation shape gates the WHOLE SESSION, not just
  // delegation. That failure would not look like a security regression; it would
  // look like a builder that cannot do anything.
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  for (const [tool, input] of [
    ["Bash", { command: "npm ci" }],
    ["Read", { file_path: `${WORKSPACE}/src/app.ts` }],
    ["Write", { file_path: `${WORKSPACE}/index.html`, content: "<h1>hi</h1>" }],
    ["Grep", { pattern: "TODO" }],
    ["mcp__x__list_things", { limit: 10 }],
  ] as const) {
    assert.deepEqual(await ask(options, tool, input), { continue: true }, tool);
  }
  // Not an object at all — a malformed input must not throw inside the hook,
  // because a throwing hook is an unhandled rejection on the SDK's own loop.
  assert.deepEqual(await ask(options, "Bash", null), { continue: true });
  assert.deepEqual(await ask(options, "Bash", "not an object"), { continue: true });
});

test("HOOK: a BACKGROUNDED BASH is not a delegation — `run_in_background` is shared", async () => {
  // MEASURED AGAINST THE SDK's OWN SCHEMAS, not assumed: `run_in_background`
  // appears at exactly two sites, `AgentInput:504` and `BashInput:548`. Under
  // `canUseTool` this collision could not fire, because
  // `autoAllowBashIfSandboxed: true` means a sandboxed Bash never reaches the
  // callback. The hook slot DOES fire for Bash, so routing on
  // `run_in_background` would deny `npm run dev` with a reason reading "It
  // defaults to true" — which is FALSE for Bash and reaches the model verbatim.
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  assert.deepEqual(
    await ask(options, "Bash", { command: "npm run dev", run_in_background: true }),
    { continue: true },
  );
});

test("HOOK: the carve-out is keyed on SHAPE, not on the name `Bash`", async () => {
  // WITHOUT THIS, THE TEST ABOVE IS A NAME EXEMPTION — the READ_TOOLS defect for
  // the fourth time. A tool called `Bash` that carries a delegation TARGET is
  // still a delegation and is still judged.
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const named = denialReason(
    await ask(options, "Bash", { command: "x", subagent_type: "wordpress-master" }),
  );
  assert.match(named, /run_in_background/);
  const isolated = denialReason(
    await ask(options, "Bash", { command: "x", isolation: "remote" }),
  );
  assert.match(isolated, /isolation/i);
});

test("HOOK: the two guards that died with the shortlist hold through the hook", async () => {
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);

  // `worktree` was measured against a real git-repo fixture, so a worktree
  // failure could not be mistaken for a hook effect: the denied call came back
  // with the hook's verbatim reason, not a git error. `remote` is
  // availability-gated and off-host, so it is denied by construction.
  for (const isolation of ["remote", "worktree"]) {
    const reason = denialReason(
      await ask(options, "Agent", {
        subagent_type: "code-reviewer",
        run_in_background: false,
        isolation,
      }),
    );
    assert.match(reason, /isolation/i, isolation);
  }

  // ABSENT is the production default and was the untested dangerous state. It is
  // now measured in all three — false, true, absent — and under deny not one
  // `background_tasks_changed` envelope appeared: the background task never came
  // into existence.
  const absent = denialReason(await ask(options, "Agent", { subagent_type: "code-reviewer" }));
  assert.match(absent, /run_in_background/);
  const explicit = denialReason(
    await ask(options, "Agent", { subagent_type: "code-reviewer", run_in_background: true }),
  );
  assert.match(explicit, /run_in_background/);
});

test("HOOK: the entry condition is NAME **OR** SHAPE — each alone is fail-open", async () => {
  const options = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);

  // SHAPE ALONE MISSES THIS. `subagent_type` is OPTIONAL in `AgentInput`
  // (sdk-tools.d.ts:496), so `Agent{description, prompt}` is schema-valid,
  // carries NONE of the routed fields, and defaults to BACKGROUND. Measured
  // against dist: a pure shape test returned ALLOW for it.
  const bare = denialReason(
    await ask(options, "Agent", { description: "review it", prompt: "go" }),
  );
  assert.match(bare, /run_in_background/);
  // The same call under its other name. The hook input said "Agent" in every
  // probe arm while `permission_denials` said "Task" for the SAME call, so both
  // names are checked and NEITHER decides.
  assert.match(denialReason(await ask(options, "Task", { description: "d", prompt: "p" })), /run_in_background/);

  // NAME ALONE MISSES THIS. `mcp__plugin_railway_railway__railway-agent` matches
  // no name we gate on and carries `isolation: "remote"`, which runs the build
  // off this machine entirely — outside every boundary protecting the sealed
  // suite. Measured against dist: a pure name test returned ALLOW.
  const mcp = denialReason(
    await ask(options, "mcp__plugin_railway_railway__railway-agent", {
      isolation: "remote",
      run_in_background: true,
      prompt: "ship it",
    }),
  );
  assert.match(mcp, /isolation/i);
});

test("HOOK: an empty shortlist denies every delegation — fail closed", async () => {
  // The default state of the system and the reason `allowedAgents` is REQUIRED
  // rather than optional: a build handed no shortlist does the work itself. It
  // does not get the 144 agents the owner's settings made visible.
  const options = buildOptions(req({ allowedAgents: [] }), false);
  for (const tool of ["Agent", "Task"]) {
    const reason = denialReason(
      await ask(options, tool, { subagent_type: "code-reviewer", run_in_background: false }),
    );
    assert.match(reason, /none configured/, tool);
  }
  // NEGATIVE CONTROL: an empty shortlist closes DELEGATION, not the build.
  assert.deepEqual(
    await ask(buildOptions(req({ allowedAgents: [] }), false), "Write", {
      file_path: `${WORKSPACE}/index.html`,
    }),
    { continue: true },
  );
});

test("HOOK: the PRODUCTION shortlist round-trips through the hook, name for name", async () => {
  // A REGRESSION GUARD, green on arrival — said plainly rather than dressed up
  // as a TDD red. Every other delegation test here hands the guard a shortlist
  // it wrote itself, so all of them would stay green if `shortlistFor` started
  // returning nothing, or if a single one of its names were misspelled. A wrong
  // name does not fail loudly: the orchestrator asks for an agent, the hook
  // denies it, and the lane produces nothing — which looks exactly like a lane
  // that had nothing to do.
  //
  // RE-POINTED AT THE HOOK IN TASK 2. Left on `canUseTool` it would have stayed
  // green while asserting nothing, because with the Agent branch deleted every
  // one of those calls returns allow by fallthrough. That is the vacuous-green
  // this project keeps shipping.
  const production = shortlistFor("fullstack");
  assert.ok(production.length > 0, "shortlistFor must never hand the guard an empty list");
  const options = buildOptions(req({ allowedAgents: production }), false);
  for (const type of production) {
    assert.deepEqual(
      await ask(options, "Agent", { subagent_type: type, run_in_background: false, prompt: "go" }),
      { continue: true },
      type,
    );
  }
});

test("HOOK: the owner's own hooks are suppressed for a build", async () => {
  // A PreToolUse hook returning `permissionDecision: "allow"` PRE-EMPTS
  // `canUseTool` outright (sdk.d.ts:4166, verbatim: "PreToolUse hook denies
  // bypass canUseTool and are not covered here") — proven live on a fixture
  // hook, with the sealed suite's contents coming back in the transcript. Today
  // that bypass is LATENT: every hook in ~/.claude/ emits only "deny". One
  // installed plugin makes it live.
  const managed = buildOptions(req(), false).managedSettings;
  assert.equal(managed?.allowManagedHooksOnly, true);
  // AND OUR OWN CALLBACK STILL FIRES UNDER THE LOCK — probe C measured exactly
  // this pair, which is the only reason the lock is affordable. Structurally the
  // lock and the hook live on the same options object, so this asserts they ship
  // together rather than one silently replacing the other.
  assert.deepEqual(
    await ask(buildOptions(req({ allowedAgents: ["code-reviewer"] }), false), "Agent", {
      subagent_type: "code-reviewer",
      run_in_background: false,
    }),
    { continue: true },
  );
});

/**
 * WHAT USED TO BE HERE — FIVE `canUseTool` DELEGATION TESTS, RE-POINTED OR
 * DELETED IN PHASE 1.1 TASK 2.
 *
 * They were written to close a real gap: the `decideAgent` tests handed the
 * predicate a shortlist by hand, while `buildOptions` fed it a module constant
 * of `[]`, so the branch was dead in production and every one of those tests was
 * green anyway. These read the shortlist off `BuildRequest` exactly as a run
 * does — and were still green against a mechanism the engine never consults.
 *
 * ONE LAYER OF WIRING FURTHER IN, AND STILL NOT REACHING THE ENGINE. That is the
 * lesson worth keeping: "asserted through the object the SDK is handed" is
 * necessary and was not sufficient, because the SDK is handed several things and
 * only some of them are asked. The HOOK tests above assert through the slot that
 * was MEASURED to fire and to stop the spawn.
 *
 * Where each went:
 *   delegation is ON for shortlisted agents      -> HOOK: SELECTIVITY
 *   delegation stays CLOSED off the shortlist    -> HOOK: an off-shortlist delegation is DENIED
 *   the Phase 0 guards survive delegation        -> HOOK: the two guards ... ; sealed half kept below
 *   the PRODUCTION shortlist round-trips         -> HOOK: the PRODUCTION shortlist round-trips
 *   an empty shortlist still denies everything   -> HOOK: an empty shortlist denies every delegation
 *
 * Not one of them was dropped, and none was left pointing at `canUseTool`, where
 * it would now return ALLOW by fallthrough and pass while asserting nothing.
 */
test("the sealed scan still judges a DELEGATION-named call, through the real canUseTool", async () => {
  // THE HALF THAT DID NOT MOVE. The sealed scan runs for every tool name, and it
  // ran BEFORE the Agent branch precisely so a well-formed shortlisted call
  // could not carry a sealed path past it in some other field. The branch is
  // gone; the scan is not, and it is still reached through the callback the SDK
  // is handed rather than only through the pure function.
  const o = buildOptions(req({ allowedAgents: ["code-reviewer"] }), false);
  const sealed = await o.canUseTool?.(
    "Agent",
    {
      subagent_type: "code-reviewer",
      run_in_background: false,
      file_path: `${HELD_OUT}/t.mjs`,
    },
    callContext(),
  );
  assert.equal(sealed?.behavior, "deny", "a sealed path on a SHORTLISTED Agent call");
  assert.match(
    sealed && sealed.behavior === "deny" ? sealed.message : "",
    /SEALED ACCEPTANCE SUITE/,
    "the sealed scan must be what denies",
  );

  // NEGATIVE CONTROL: the callback is not a deny-everything stub, and it does
  // NOT decide delegation any more — a clean delegation reaches it and is waved
  // on, because the permission was already settled by the hook.
  const clean = await o.canUseTool?.(
    "Agent",
    { subagent_type: "wordpress-master", run_in_background: true, prompt: "review" },
    callContext(),
  );
  assert.equal(
    clean?.behavior,
    "allow",
    "canUseTool no longer judges delegation — asserting a deny here would be asserting a lie",
  );
});

/**
 * THE SHAPE JUDGEMENT — Phase 1.1 Task 3, RE-POINTED AT THE HOOK IN TASK 2.
 *
 * Task 3 put a NAME-or-SHAPE delegation branch in `decideToolPermission`,
 * because `mcp__plugin_railway_railway__railway-agent{isolation:"remote"}`
 * matched no name gate while running the build off this machine entirely.
 * That reasoning is intact and its tests live on — they moved to the HOOK
 * section above ("the entry condition is NAME **OR** SHAPE"), because probe A
 * then measured that `canUseTool` is asked about no tool at all when the model
 * delegates, so judging shape THERE decided nothing.
 *
 * Left here on the callback, those two assertions would have gone green by
 * FALLTHROUGH the moment the branch was deleted — the deny they asserted
 * replaced by an allow, with no test turning red. That is the exact vacuous
 * green this phase exists to stop, so they were moved rather than kept.
 *
 * The write confinement below did NOT move, because it never depended on the
 * branch.
 */
test("a WRITE carrying delegation fields is still confined to the workspace", () => {
  // THE ORDERING THIS PINS, AND WHY IT OUTLIVED THE BRANCH IT WAS WRITTEN
  // AGAINST. The delegation branch RETURNED — allow as well as deny — and once
  // its condition grew a SHAPE half it became reachable for a PATH_TOOL: a
  // `Write` carrying `subagent_type` and `run_in_background: false` passed all
  // three delegation checks and returned ALLOW with the escaping `file_path`
  // never judged. Measured against dist, then fixed in ea52322 by hoisting the
  // confinement above it.
  //
  // Task 2 deleted the branch, so today nothing below the confinement returns
  // early and this cannot regress the way it did. IT IS KEPT ANYWAY: it is the
  // only test that pins the confinement's POSITION rather than its logic, and
  // the next check added underneath is exactly when that matters again.
  //
  // The call is deliberately WELL-FORMED and SHORTLIST-SHAPED: nothing but the
  // write confinement can produce this deny, so it cannot pass for the wrong
  // reason.
  const result = decideToolPermission(
    "Write",
    { file_path: "/etc/passwd", subagent_type: "code-reviewer", run_in_background: false },
    WORKSPACE,
    [],
  ) as { behavior: string; message?: string };
  assert.equal(result.behavior, "deny");
  assert.match(String(result.message), /workspace/i);
});

test("an ordinary tool carrying none of those fields is untouched — negative control", () => {
  // Without this, "judge everything" would pass every assertion above while
  // breaking every ordinary read the build legitimately makes.
  assert.equal(
    decideToolPermission("mcp__x__list_things", { limit: 10 }, "/w", []).behavior,
    "allow",
  );
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
 * Same argument as `announceEnvironment` above: what these prove is that the
 * sampler emits, logs, and cannot take the build down — including the two
 * failure shapes (never answers, throws) that no real CLI can be made to perform
 * on demand.
 *
 * THE CALL SITE IS NO LONGER A RESIDUAL. This block used to end "what it cannot
 * prove is that the loop calls it", and that sentence was true of
 * `recordResultTokens` too until an auditor deleted ITS call site with the suite
 * green. The loop is now driven directly — see "THE LOOP" at the end of this
 * file — so the `task_notification` branch that calls this sampler is executed
 * by a test rather than described by a comment.
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

/**
 * THE RESULT BRANCH'S TOKEN ACCOUNTING — Phase 1.1 Task 5 follow-up.
 *
 * WHY THESE EXIST, and it is not a nicety. An audit of commit db015a9 reverted
 * the whole per-model fix at its SOLE production call site — back to
 * `addTokens(tokens, extractTokens(message.usage, message.num_turns))` with the
 * two `usageDisagreement` lines deleted — and the suite stayed byte-identical at
 * 200/198/0/2. Only tsc's unused-import check objected. Every assertion about
 * `resultTokens` lived in claude-common.test.ts, where the function was called
 * directly; NOTHING said the builder still called it. A guarantee whose call
 * site can be deleted with a green suite is not protected, and this repo has now
 * shipped that same defect six times.
 *
 * THE SEAM WAS NOT ENOUGH, AND THAT IS MEASURED TOO. The arithmetic was lifted
 * out of the branch into {@link recordResultTokens} and pinned by the five tests
 * below. An auditor then reverted the CALL SITE — line 1187, back to
 * `addTokens(tokens, extractTokens(message.usage, message.num_turns))` — left
 * this function intact and exported, and the suite stayed FULLY GREEN at
 * 229/227/0/2 against a rebuilt dist. The seam had MOVED the hole one line, not
 * closed it. These tests are still worth having: they are where the arithmetic's
 * properties are pinned, and they are far cheaper to read than the loop. What
 * they cannot do, and never could, is say that production still calls this.
 *
 * WHAT CLOSES IT IS "THE LOOP" AT THE END OF THIS FILE. The message stream is
 * injectable, so `build()` is driven with synthetic envelopes and the same skewed
 * frame is read back off the sink. Under the mutation above those assertions go
 * red: 40,000 input tokens, no model rows, no disagreement warning.
 *
 * A SOURCE-TEXT TEST WOULD BE WORSE THAN NOTHING, AND AN AST CANARY IS THE SAME
 * INSTRUMENT. `buildOptions` was once "wired" by regexes over this file's own
 * source; the whole boundary was disconnected and the regexes still matched. A
 * parser fixes the spelling of that check, not its category: it can prove a call
 * appears in a branch, never that the branch is what the SDK's messages reach.
 */

/** The SDK's own `ModelUsage` shape, cost field and all — see claude-common.test.ts. */
const DELEGATED_USAGE = {
  "claude-haiku-4-5-20251001": {
    inputTokens: 2_400,
    outputTokens: 960,
    cacheReadInputTokens: 480,
    cacheCreationInputTokens: 120,
    webSearchRequests: 0,
    costUSD: 0.42,
  },
  "claude-opus-5[1m]": {
    inputTokens: 7_600,
    outputTokens: 3_040,
    cacheReadInputTokens: 1_520,
    cacheCreationInputTokens: 380,
    webSearchRequests: 0,
    costUSD: 13.37,
  },
} as const;

/**
 * A result frame whose scalar `usage` DISAGREES with its own per-model rows.
 *
 * DELIBERATELY SKEWED, and that is the entire point of the fixture. The agreeing
 * frame (rows summing to exactly the scalar, as the shipped CLI produces) cannot
 * tell the two implementations apart: `extractTokens(usage)` and the sum over
 * `modelUsage` return the SAME four numbers, so a test built on it passes under
 * the mutation. 40,000 vs 10,000 input makes the row-sourced path and the
 * scalar-sourced path give different answers, so the assertion pins which one
 * production runs — and it is the only fixture under which the two
 * `usageDisagreement` lines are observable at all.
 */
function skewedResult(): ResultUsageEnvelope {
  return {
    usage: {
      input_tokens: 40_000,
      output_tokens: 4_000,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 500,
    },
    modelUsage: DELEGATED_USAGE,
    num_turns: 12,
  };
}

/** An agreeing frame, as the shipped CLI reports one: rows sum to the scalar. */
function agreeingResult(): ResultUsageEnvelope {
  return {
    usage: {
      input_tokens: 10_000,
      output_tokens: 4_000,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 500,
    },
    modelUsage: DELEGATED_USAGE,
    num_turns: 12,
  };
}

function tokenSink(): {
  sink: BuildRequest["sink"];
  emitted: TokenTotals[];
  warnings: string[];
} {
  const emitted: TokenTotals[] = [];
  const warnings: string[] = [];
  return {
    emitted,
    warnings,
    sink: {
      ...req().sink,
      tokens: (totals: TokenTotals) => emitted.push(totals),
      log: (level: "info" | "warn" | "error", text: string) => {
        if (level === "warn") warnings.push(text);
      },
    },
  };
}

test("the result frame's spend is recorded PER MODEL, not collapsed onto one name", () => {
  // The measured failure: 76% of a run's spend on OPUS subagents while the run's
  // `modelId` said `haiku`. `extractTokens(result.usage)` returns four scalars
  // and NO model, so under the reverted call site every row below is absent.
  const { sink, emitted } = tokenSink();
  const totals = recordResultTokens(zeroTokens("anthropic"), agreeingResult(), sink);

  assert.deepEqual(modelRows(totals), [
    {
      model: "claude-haiku-4-5-20251001",
      inputTokens: 2_400,
      outputTokens: 960,
      cacheReadTokens: 480,
      cacheWriteTokens: 120,
    },
    {
      model: "claude-opus-5[1m]",
      inputTokens: 7_600,
      outputTokens: 3_040,
      cacheReadTokens: 1_520,
      cacheWriteTokens: 380,
    },
  ]);
  assert.equal(emitted.length, 1, "the sink is the only route to the run record");
  assert.deepEqual(emitted[0], totals, "and what it is given is what the build returns");
  assert.equal(totals.callCount, 12);
  // The cost field is dropped at the boundary and must not ride along here.
  assert.equal(/cost|usd|13\.37/i.test(JSON.stringify(totals)), false);
});

test("the totals the run reports come from the ROWS, not from the frame's scalar", () => {
  // THE DISCRIMINATING ASSERTION. On the agreeing frame both paths say 10,000;
  // on this one the scalar says 40,000 and the rows say 10,000, so this is the
  // assertion that says WHICH path production takes.
  const { sink, emitted } = tokenSink();
  const totals = recordResultTokens(zeroTokens("anthropic"), skewedResult(), sink);

  assert.equal(totals.inputTokens, 10_000, "the scalar 40,000 was reported instead of the rows");
  assert.equal(emitted[0]?.inputTokens, 10_000);
  assert.equal(
    JSON.stringify(totals).includes("40000"),
    false,
    "no part of the scalar-sourced total may survive",
  );
});

test("a CLI that contradicts its own breakdown is WARNED about, at the call site", () => {
  // The two lines the audit deleted. They are unobservable on an agreeing frame,
  // which is exactly why deleting them cost nothing: only a skewed frame can
  // prove the check still runs in production.
  const { sink, warnings } = tokenSink();
  recordResultTokens(zeroTokens("anthropic"), skewedResult(), sink);

  assert.equal(warnings.length, 1, "the disagreement was not reported at all");
  assert.match(String(warnings[0]), /disagree/i);
  assert.match(String(warnings[0]), /40000/, "the CLI's own scalar is quoted");
  assert.match(String(warnings[0]), /10000/, "and so is what its rows actually sum to");
});

test("an agreeing CLI produces NO warning — the negative control", () => {
  // Without this, `sink.log("warn", …)` on every result frame would satisfy the
  // test above while making the warning meaningless.
  const { sink, warnings } = tokenSink();
  recordResultTokens(zeroTokens("anthropic"), agreeingResult(), sink);
  assert.deepEqual(warnings, []);
});

test("a second result frame ACCUMULATES onto the first — resume adds, it does not replace", () => {
  // A resumed build sees more than one result frame, and the running total is
  // the thing the outcome carries. Replacing rather than adding would leave every
  // assertion above green.
  const { sink, emitted } = tokenSink();
  const first = recordResultTokens(zeroTokens("anthropic"), agreeingResult(), sink);
  const second = recordResultTokens(first, agreeingResult(), sink);

  assert.equal(second.inputTokens, 20_000);
  assert.equal(second.callCount, 24);
  assert.deepEqual(
    modelRows(second).map((r) => [r.model, r.outputTokens]),
    [
      ["claude-haiku-4-5-20251001", 1_920],
      ["claude-opus-5[1m]", 6_080],
    ],
    "and the merge stays per model rather than folding the two into one row",
  );
  assert.equal(emitted.length, 2, "each frame is emitted as it arrives");
  assert.deepEqual(emitted[1], second);
});

/**
 * THE LOOP, DRIVEN — 2026-07-28. THE FIX FOR A MEASURED, SHIPPED HOLE.
 *
 * WHAT HAPPENED. Commit b3dcb21 lifted the result branch's token accounting into
 * `recordResultTokens` and pinned it with the five tests above. An auditor then
 * reverted the CALL SITE ONLY — `tokens = recordResultTokens(tokens, message,
 * sink)` back to the inlined `addTokens(tokens, extractTokens(message.usage,
 * message.num_turns))` plus `sink.tokens(tokens)` — while leaving
 * `recordResultTokens` intact, exported and green. THE SUITE STAYED FULLY GREEN
 * at 229/227/0/2 against a genuinely rebuilt dist. The mutation is not cosmetic:
 * a live run carried THREE per-model rows, so it silently destroys the
 * attribution of every real build, and per-model attribution is the whole point
 * of that commit (76% of one run's spend was OPUS subagents while `modelId` said
 * haiku).
 *
 * WHY NOT A SOURCE-TEXT OR AST "WIRING CANARY". Phase 0.1 shipped exactly that:
 * a wiring test that matched regexes against claude-builder.ts's own source and
 * stayed green while the code under test was DELETED. Swapping the regex for a
 * parser makes the check well-spelled, not well-founded — it would assert that a
 * call APPEARS in a branch, which is a claim about text, while the thing at risk
 * is what the SDK's own messages produce on the sink. The category of test is
 * what failed before, so the category is what changed here.
 *
 * WHAT CHANGED. `ClaudeSubscriptionBuilder` takes its session from a
 * `SessionFactory` that defaults to the SDK's `query`. A test supplies synthetic
 * envelopes — the same JSON the CLI writes down its stdout pipe — and the whole
 * `for await` loop runs with no subprocess, no quota and no network. Every
 * branch of it is now ordinary code under test.
 *
 * THE HOLE THE SEAM CREATES IS PINNED BELOW: a default argument can be swapped
 * for a stub, so the default is asserted to BE the SDK's `query`, by identity.
 */

/**
 * A message as the CLI delivers it: JSON off a subprocess pipe.
 *
 * CAST DELIBERATELY, AND NARROWLY. `SDKMessage` is a large discriminated union
 * whose members carry `uuid`, `parent_tool_use_id` and full Anthropic content
 * blocks that this loop never reads; writing them out would make the fixture
 * about the SDK's types rather than about the builder's behaviour. The fields
 * that MATTER are type-checked anyway — every token-bearing frame below is built
 * by spreading `skewedResult()` / `agreeingResult()`, which are typed
 * `ResultUsageEnvelope`, so the numbers this file asserts on cannot drift into a
 * shape the production code would not accept.
 */
function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

/** A session that replays fixed envelopes and answers one control request. */
function sessionOf(
  messages: readonly SDKMessage[],
  usage: ContextUsageEnvelope = USAGE,
): BuildSession {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
      for (const message of messages) yield message;
    },
    getContextUsage: async (): Promise<ContextUsageEnvelope> => usage,
  };
}

interface LoopRecord {
  readonly sink: BuildRequest["sink"];
  readonly sessions: string[];
  readonly environments: RunEnvironment[];
  readonly samples: ContextSample[];
  readonly compactions: CompactionRecord[];
  readonly emitted: TokenTotals[];
  readonly tools: string[];
  readonly rateLimits: RateLimitState[];
  readonly raw: string[];
  readonly warnings: string[];
}

/** Every sink method, recorded — the loop's only observable output. */
function loopSink(): LoopRecord {
  const record = {
    sessions: [] as string[],
    environments: [] as RunEnvironment[],
    samples: [] as ContextSample[],
    compactions: [] as CompactionRecord[],
    emitted: [] as TokenTotals[],
    tools: [] as string[],
    rateLimits: [] as RateLimitState[],
    raw: [] as string[],
    warnings: [] as string[],
  };
  return {
    ...record,
    sink: {
      log: (level: "info" | "warn" | "error", text: string) => {
        if (level === "warn") record.warnings.push(text);
      },
      tool: (name: string) => record.tools.push(name),
      tokens: (totals: TokenTotals) => record.emitted.push(totals),
      rateLimit: (state: RateLimitState) => record.rateLimits.push(state),
      session: (id: string) => record.sessions.push(id),
      environment: (env: RunEnvironment) => record.environments.push(env),
      contextUsage: (sample: ContextSample) => record.samples.push(sample),
      compaction: (compaction: CompactionRecord) => record.compactions.push(compaction),
      raw: (text: string) => record.raw.push(text),
    },
  };
}

/** Run a build over a fixed stream of envelopes. No CLI, no quota. */
async function runLoop(
  messages: readonly SDKMessage[],
  record: LoopRecord,
  overrides: Partial<BuildRequest> = {},
): Promise<Awaited<ReturnType<ClaudeSubscriptionBuilder["build"]>>> {
  const builder = new ClaudeSubscriptionBuilder(() => sessionOf(messages));
  return builder.build(req({ sink: record.sink, ...overrides }));
}

test("THE LOOP: the result branch reports PER MODEL — the mutation that shipped green", async () => {
  // THE ASSERTION THE AUDITOR'S REVERT BREAKS. `extractTokens(message.usage, …)`
  // returns four scalars and NO model, so under the inlined form `byModel` is
  // empty and `inputTokens` is the frame's 40,000 scalar rather than the 10,000
  // its own rows sum to. The skewed fixture is the only one on which the two
  // implementations differ at all — on an agreeing frame both say 10,000.
  const record = loopSink();
  const outcome = await runLoop(
    [envelope({ type: "result", subtype: "success", ...skewedResult() })],
    record,
  );

  assert.equal(record.emitted.length, 1, "the loop emitted no token total at all");
  const emitted = record.emitted[0];
  assert.ok(emitted);
  assert.deepEqual(
    modelRows(emitted).map((row) => row.model),
    ["claude-haiku-4-5-20251001", "claude-opus-5[1m]"],
    "the loop collapsed the run's spend onto no model — this is the shipped mutation",
  );
  assert.equal(emitted.inputTokens, 10_000, "the scalar 40,000 was reported instead of the rows");
  assert.equal(emitted.callCount, 12);

  // The disagreement warning is the other half the audit deleted, and it is
  // observable ONLY on a skewed frame.
  assert.equal(
    record.warnings.filter((line) => /disagree/i.test(line)).length,
    1,
    "the CLI contradicting its own breakdown went unreported",
  );

  // AND WHAT THE RUN RETURNS IS WHAT THE SINK SAW. An accumulation that emits
  // correctly but returns something else is the same lie one field over.
  assert.deepEqual(outcome.tokens, emitted);
  assert.equal(outcome.completed, true);
  assert.equal(outcome.failure, null);
});

test("THE LOOP: a second result frame ACCUMULATES inside build(), it does not replace", async () => {
  // The running total is threaded through the loop by hand, so "the branch calls
  // the right function" is not the same as "the branch keeps the total". A
  // resumed build sees more than one result frame.
  const record = loopSink();
  const outcome = await runLoop(
    [
      envelope({ type: "result", subtype: "success", ...agreeingResult() }),
      envelope({ type: "result", subtype: "success", ...agreeingResult() }),
    ],
    record,
  );

  assert.equal(record.emitted.length, 2, "each frame is emitted as it arrives");
  assert.equal(outcome.tokens.inputTokens, 20_000);
  assert.equal(outcome.tokens.callCount, 24);
  assert.deepEqual(
    modelRows(outcome.tokens).map((row) => [row.model, row.outputTokens]),
    [
      ["claude-haiku-4-5-20251001", 1_920],
      ["claude-opus-5[1m]", 6_080],
    ],
    "the merge stays per model rather than folding the two into one row",
  );
});

test("THE LOOP: a failed result still counts its spend and names the failure", async () => {
  // NEGATIVE CONTROL ON THE BRANCH ORDER: the accounting sits ABOVE the
  // success/failure split, so a run that ends in an error still reports what it
  // spent. Moving the call inside the `success` arm would leave the test above
  // green and lose the tokens of every failed run.
  const record = loopSink();
  const outcome = await runLoop(
    [
      envelope({
        type: "result",
        subtype: "error_max_turns",
        errors: ["turn limit reached"],
        ...agreeingResult(),
      }),
    ],
    record,
  );

  assert.equal(record.emitted.length, 1);
  assert.equal(outcome.tokens.inputTokens, 10_000);
  assert.equal(outcome.completed, false);
  assert.match(String(outcome.failure), /error_max_turns/);
  assert.match(String(outcome.failure), /turn limit reached/);
});

test("THE LOOP: init, a closed lane and a compaction all reach the sink", async () => {
  // THE SAME RESIDUAL, ON THREE MORE CALL SITES. `announceEnvironment`,
  // `sampleContextAt` and `noteCompaction` each carried "a test cannot prove the
  // loop calls it" in their own docstrings — the identical sentence that was true
  // of `recordResultTokens` right up until an auditor deleted its call site with
  // the suite green. One driven stream closes all three.
  const record = loopSink();
  const outcome = await runLoop(
    [
      envelope({
        type: "system",
        subtype: "init",
        session_id: "sess-77",
        cwd: WORKSPACE,
        model: "claude-opus-5",
        claude_code_version: "2.0.0",
        agents: ["code-reviewer"],
        skills: ["postgres"],
        tools: ["Read", "Agent"],
        mcp_servers: [],
        plugins: [],
      }),
      envelope({
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        subagent_type: "code-reviewer",
      }),
      envelope({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
      }),
      envelope({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 180_000,
          post_tokens: 60_000,
          duration_ms: 900,
        },
      }),
      envelope({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "reading the brief" },
            { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "brief.md" } },
          ],
        },
      }),
      envelope({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 97 },
      }),
      envelope({ type: "result", subtype: "success", ...agreeingResult() }),
    ],
    record,
  );

  // system/init: the session id and the environment inventory, said once.
  assert.deepEqual(record.sessions, ["sess-77"]);
  assert.equal(outcome.sessionId, "sess-77");
  assert.equal(record.environments.length, 1, "the loop recorded no environment");
  assert.deepEqual(record.environments[0]?.skills, ["postgres"]);

  // task_started + task_notification: the lane went quiet, so the context window
  // was sampled through the session's own control request.
  assert.equal(record.samples.length, 1, "a closed lane produced no context sample");
  assert.equal(record.samples[0]?.agent, "code-reviewer");
  assert.equal(record.samples[0]?.percentage, 75);

  // compact_boundary: said once in the stream, or lost.
  assert.equal(record.compactions.length, 1, "the loop dropped a compaction");
  assert.equal(record.compactions[0]?.preTokens, 180_000);

  // assistant: transcript text and the tool timeline.
  assert.deepEqual(record.tools, ["Read"]);
  assert.match(record.raw.join(""), /reading the brief/);

  // rate_limit_event: the state the orchestrator reports and resumes on.
  assert.equal(record.rateLimits.length, 1);
  assert.equal(record.rateLimits[0]?.limited, true);
  assert.equal(outcome.rateLimit.kind, "five_hour");
});

test("THE LOOP: NEGATIVE CONTROL — an empty stream builds nothing and claims nothing", async () => {
  // Without this, a loop that emitted a fabricated total on entry would satisfy
  // every assertion above. A run that produced no result frame reports no spend,
  // no completion and no failure.
  const record = loopSink();
  const outcome = await runLoop([], record);

  assert.deepEqual(record.emitted, []);
  assert.deepEqual(record.samples, []);
  assert.equal(outcome.completed, false);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.sessionId, null);
  assert.deepEqual(outcome.tokens, zeroTokens("anthropic"));
});

test("THE LOOP: the prompt and the built Options are what the session is started with", async () => {
  // THE SEAM'S OWN WIRING. A factory that ignored its arguments would let every
  // test above pass while production spawned a CLI with no `cwd`, no sandbox and
  // no hooks. What `buildOptions` returns is asserted exhaustively elsewhere in
  // this file; what THIS says is that the object handed to the SDK is that one,
  // for this request, with the abort controller attached.
  let seen: { prompt: string; options: Options } | null = null;
  const builder = new ClaudeSubscriptionBuilder((params) => {
    seen = params;
    return sessionOf([]);
  });
  const request = req({ prompt: "build the ticket", allowedAgents: ["code-reviewer"] });
  await builder.build(request);

  const params = seen as { prompt: string; options: Options } | null;
  assert.ok(params, "the session was never started");
  assert.equal(params.prompt, "build the ticket");
  assert.equal(params.options.cwd, canonicaliseForDecision(WORKSPACE));
  assert.equal(typeof params.options.canUseTool, "function");
  assert.equal(params.options.hooks?.PreToolUse?.length, 1);
  assert.deepEqual(params.options.sandbox?.filesystem?.denyRead, SEALED.map(canonicaliseForDecision));
  assert.deepEqual(Object.keys(params.options.agents ?? {}), ["code-reviewer"]);
  assert.ok(params.options.abortController, "an uncancellable build cannot be stopped");
});

test("THE LOOP: the DEFAULT session factory is the SDK's own `query`", async () => {
  // THE HOLE THE SEAM CREATES, PINNED. Injecting the stream is what makes the
  // loop testable; it also makes it possible to ship a builder wired to a stub,
  // which would leave every test above green and every real build inert. The
  // default is asserted BY IDENTITY, which is why `query` is assigned directly in
  // claude-builder.ts rather than wrapped in an arrow function.
  assert.equal(new ClaudeSubscriptionBuilder().startSession, query);
  // And the orchestrator's construction — `new ClaudeSubscriptionBuilder()` with
  // no argument — is the one that gets the default.
  assert.equal(new ClaudeSubscriptionBuilder().provider, "anthropic");
});
