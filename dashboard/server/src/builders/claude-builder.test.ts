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
import { test } from "node:test";
import { decideToolPermission } from "./claude-builder.js";

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
