/**
 * build-environment.test.ts — the per-run environment record (Phase 1 Task 6).
 *
 * WHAT THIS PROTECTS. `claude-builder.ts` promises no *unrecorded* input, and
 * `settingSources: ["user"]` is the largest input the build has: 144 agents, 162
 * skills, the owner's hooks, and whatever MCP servers the CLI registers. Two runs
 * of the SAME ticket can therefore build different things, and without this record
 * nothing on disk says why.
 *
 * THE HASH IS THE WHOLE POINT, AND IT CUTS BOTH WAYS. It is useless if it changes
 * when the environment did not — a hash over `cwd` or `session_id` is unique per
 * run and distinguishes nothing — and equally useless if it stays put when a
 * category actually changed. Both directions are asserted below; neither is
 * implied by the other.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  describeEnvironment,
  environmentFromInit,
  environmentHash,
  environmentRecord,
  writeEnvironmentRecord,
} from "./build-environment.js";
import type { InitEnvelope } from "./build-environment.js";

/** An init payload shaped like the SDK's, with every field overridable. */
function init(overrides: Partial<InitEnvelope> = {}): InitEnvelope {
  return {
    session_id: "sess-1",
    cwd: "/tmp/dash/runs/r1/workspace",
    model: "claude-opus-5",
    claude_code_version: "2.0.0",
    agents: ["code-reviewer", "debugger"],
    skills: ["taste-skill", "postgres"],
    tools: ["Read", "Write", "Agent"],
    mcp_servers: [{ name: "context7", status: "connected" }],
    plugins: [{ name: "railway", version: "1.2.3" }],
    ...overrides,
  };
}

test("the init payload's inventory is captured, by category", () => {
  const env = environmentFromInit(init());
  assert.deepEqual(env.agents, ["code-reviewer", "debugger"]);
  assert.deepEqual(env.skills, ["postgres", "taste-skill"]); // sorted
  assert.deepEqual(env.tools, ["Agent", "Read", "Write"]);
  assert.deepEqual(env.mcpServers, [{ name: "context7", status: "connected" }]);
  assert.deepEqual(env.plugins, [{ name: "railway", version: "1.2.3" }]);
  assert.equal(env.claudeCodeVersion, "2.0.0");
});

test("a category the CLI omits is [] and not a crash", () => {
  // `agents` is OPTIONAL in the SDK's own typing, and a CLI that drops a field
  // must not take the run's environment record down with it.
  const env = environmentFromInit({
    session_id: "s",
    cwd: "/w",
    model: "m",
    claude_code_version: "v",
    tools: [],
  });
  assert.deepEqual(env.agents, []);
  assert.deepEqual(env.skills, []);
  assert.deepEqual(env.mcpServers, []);
  assert.deepEqual(env.plugins, []);
  assert.equal(typeof environmentHash(env), "string");
});

test("the hash is IDENTICAL for two runs whose environment is identical", () => {
  // This is the invariant that makes the hash worth recording. `cwd` carries the
  // run id and `session_id` is unique per run: folding either in would give every
  // run a different hash, which distinguishes nothing.
  const a = environmentFromInit(init());
  const b = environmentFromInit(
    init({ session_id: "sess-2", cwd: "/tmp/dash/runs/r2/workspace" }),
  );
  assert.equal(environmentHash(a), environmentHash(b));
});

test("the hash is STABLE against ordering — the CLI does not promise one", () => {
  const a = environmentFromInit(init());
  const b = environmentFromInit(
    init({ skills: ["postgres", "taste-skill"], tools: ["Write", "Agent", "Read"] }),
  );
  assert.equal(environmentHash(a), environmentHash(b));
});

test("the hash CHANGES when a STABLE category changes", () => {
  const base = environmentHash(environmentFromInit(init()));
  const changed: Array<[string, Partial<InitEnvelope>]> = [
    ["one skill more", { skills: ["taste-skill", "postgres", "impeccable"] }],
    ["one agent fewer", { agents: ["code-reviewer"] }],
    ["one plugin more", { plugins: [{ name: "railway", version: "1.2.3" }, { name: "expo" }] }],
    ["a plugin version bump", { plugins: [{ name: "railway", version: "1.3.0" }] }],
    ["a different CLI build", { claude_code_version: "2.0.1" }],
  ];
  for (const [label, patch] of changed) {
    assert.notEqual(environmentHash(environmentFromInit(init(patch))), base, label);
  }
});

test("the hash IGNORES the two categories MEASURED to move on their own", () => {
  // NOT A CONVENIENCE. Five probes on 2026-07-28, each a real `query()` through
  // this repo's own `buildOptions()`, aborted on the first `system/init`, with
  // nothing on the machine touched between them:
  //
  //   agents 154 / skills 162 / plugins 20 / CLI 2.1.220 — identical every run
  //   tools  42, 272, 33, 219 — MCP servers connect lazily and each connection
  //          adds its `mcp__*` tools, so init catches the race mid-flight
  //   mcp    `pending` -> `connected` between runs; 13 servers on one cold
  //          start against 22 on the next four
  //
  // The first draft of this file hashed both. That gives a DIFFERENT hash on
  // every run of an unchanged machine — which reads exactly like a working hash
  // and answers the opposite of the question asked of it.
  const base = environmentHash(environmentFromInit(init()));
  const timingNoise: Array<[string, Partial<InitEnvelope>]> = [
    ["272 tools instead of 3", { tools: Array.from({ length: 272 }, (_, i) => `mcp__t${String(i)}`) }],
    ["a server still pending", { mcp_servers: [{ name: "context7", status: "pending" }] }],
    ["a server that has not connected yet", { mcp_servers: [] }],
  ];
  for (const [label, patch] of timingNoise) {
    assert.equal(environmentHash(environmentFromInit(init(patch))), base, label);
  }
});

test("the one-line summary carries the counts, the MCP servers and the hash", () => {
  // The log line is the only part of this record a human sees while the build
  // runs, so it must answer "what loaded?" without opening a file. The MCP
  // servers are named rather than counted: the open question T1 left is whether
  // the owner's enabled plugins register any, and a bare count cannot answer it.
  const env = environmentFromInit(init());
  const line = describeEnvironment(env);
  assert.match(line, /2 agent/);
  assert.match(line, /2 skill/);
  assert.match(line, /3 tool/);
  assert.match(line, /context7/);
  assert.match(line, /1 plugin/);
  assert.match(line, new RegExp(environmentHash(env).slice(0, 12)));
  assert.equal(line.includes("\n"), false, "one line means one line");
});

test("the persisted record carries the hash beside the names", () => {
  // A file listing 162 skills with no fingerprint makes the reader diff two
  // directories by eye; a fingerprint with no names makes a difference visible
  // and unidentifiable. The record is only useful with both.
  const env = environmentFromInit(init());
  const record = environmentRecord(env);
  assert.equal(record.environmentHash, environmentHash(env));
  assert.deepEqual(record.agents, env.agents);
  assert.deepEqual(record.mcpServers, env.mcpServers);
  assert.equal(record.sessionId, "sess-1");
  // It goes to disk through JSON, so it must survive the trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test("the record lands on disk beside the run record, redacted", () => {
  // WHY THIS IS A FILE AND NOT A FIELD: `RunRecord` is a bake-off contract type
  // and `bakeoff/` is not ours to modify, so the inventory goes in its own file
  // in the same directory rather than being dropped for want of a field.
  //
  // REDACTED like every other persisted string in this program. An MCP server
  // name is CLI-reported, not owner-typed, but this file is written from a
  // message the run did not author, and the chokepoint exists precisely so no
  // writer has to be individually trusted.
  const dir = mkdtempSync(join(tmpdir(), "dash-env-"));
  try {
    const fakeKey = `sk-ant-api03-${"A1b2C3d4E5f6G7h8".repeat(6)}`;
    const environment = environmentFromInit(
      init({ mcp_servers: [{ name: `leaky ${fakeKey}`, status: "connected" }] }),
    );
    const file = writeEnvironmentRecord(dir, environment);
    assert.equal(file, join(dir, "environment.json"));

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      environmentHash: string;
      agents: string[];
      mcpServers: { name: string }[];
    };
    assert.equal(onDisk.environmentHash, environmentHash(environment));
    assert.deepEqual(onDisk.agents, ["code-reviewer", "debugger"]);
    assert.equal(
      onDisk.mcpServers[0]?.name.includes(fakeKey),
      false,
      "a key-shaped string must not reach disk verbatim",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no MCP server at all is stated, not left blank", () => {
  // "(none)" and a missing clause read identically to a reader who does not know
  // the format, and this is the field the plugin question is answered from.
  const line = describeEnvironment(environmentFromInit(init({ mcp_servers: [] })));
  assert.match(line, /0 MCP server|MCP: none|no MCP server/i);
});
