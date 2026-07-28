/**
 * build-environment.ts — what the CLI actually loaded for one build, as a record.
 *
 * WHY THIS EXISTS. `builders/claude-builder.ts` sets `settingSources: ["user"]`,
 * and the comment at its `FREE_TEXT` table (`claude-builder.ts:192-195`) demands
 * not "no external input" but no *UNRECORDED* input. User settings are the largest input this program has: the
 * owner's agents, skills, CLAUDE.md, hooks, and whatever MCP servers the CLI
 * registers from their enabled plugins — measured 2026-07-28 at 154 agents, 162
 * skills, 20 plugins and 22 MCP servers. All of it changes what gets
 * built and NONE of it appears in the ticket. Two runs of a byte-identical ticket
 * can therefore produce different work, and without this record the run directory
 * says nothing about why. Recording it is what keeps that promise; it is not a
 * nicety and it is not telemetry.
 *
 * WHAT IS RECORDED IS WHAT THE CLI REPORTS, NOT WHAT WE ASKED FOR. The inventory
 * comes from the `system/init` message — the CLI's own statement of what it
 * discovered — rather than from our `Options`. Asking our own configuration what
 * loaded would record an intention: `settingSources: ["user"]` says "load the
 * user's things" and says nothing about which things existed on disk at that
 * moment, whether an MCP server failed its handshake, or whether a plugin
 * registered anything at all.
 *
 * THE HASH IS THE PART THAT HAS TO BE RIGHT, AND IT FAILS IN TWO DIRECTIONS.
 * Its job is to make two runs of the same ticket comparable: same hash means the
 * same environment loaded, different hash means something moved. So it must NOT
 * cover anything that differs per run for reasons unrelated to the environment —
 * `session_id` is unique by construction and `cwd` contains the run id, and
 * folding in either gives every run a unique hash, which distinguishes nothing
 * while looking exactly like a hash that works.
 *
 * WHICH CATEGORIES ARE HASHED WAS MEASURED, NOT REASONED ABOUT. Five consecutive
 * probes on 2026-07-28, each starting a real `query()` through this repository's
 * own `buildOptions()` and aborting on the first `system/init`, with nothing on
 * the machine changed between them (CLI 2.1.220):
 *
 *     agents    154, byte-identical every run        STABLE  -> hashed
 *     skills    162, byte-identical every run        STABLE  -> hashed
 *     plugins    20, byte-identical every run        STABLE  -> hashed
 *     version    2.1.220 every run                   STABLE  -> hashed
 *     tools      42, 272, 33, 219, …                 NOT     -> recorded only
 *     mcp names  22, 22, 22, 22 — but 13 on one cold start   -> recorded only
 *     mcp status pending -> connected, differs every run     -> recorded only
 *
 * `tools[]` swinging between 33 and 272 is the same phenomenon as the statuses:
 * MCP servers connect LAZILY, each connection adds its `mcp__*` tools, and init
 * is emitted at whatever point that race happens to be at. Hashing either would
 * have given a different fingerprint on every run of an unchanged machine —
 * which is the exact failure this hash exists to avoid, and it would have looked
 * like a working hash while doing it. THE FIRST DRAFT OF THIS FILE HASHED BOTH,
 * and the probe is the only reason it does not still.
 *
 * They are RECORDED nonetheless, in the record and in the log line, because "the
 * environment differed" and "these three servers were up" are different
 * questions and the second one still has to be answerable after the fact.
 *
 * `model` is deliberately OUT of the hash too. It is a chosen input, not a
 * discovered one, and it is already recorded on the run row as `modelId`; hashing
 * it would conflate "the owner picked a different model" with "the machine
 * changed underneath us". It is kept on the record itself for correlation.
 *
 * WHAT THE PROBE ALSO SETTLED, since Task 1 flagged it as unknown: THE OWNER'S
 * ENABLED PLUGINS DO REGISTER MCP SERVERS INTO AN SDK `query()`. Eight of the 22
 * observed servers carry the `plugin:<plugin>:<server>` prefix — `plugin:sentry:
 * sentry` (connected), `plugin:context7:context7`, `plugin:expo:expo`
 * (needs-auth), `plugin:firebase:firebase`, `plugin:neon:neon`,
 * `plugin:playwright:playwright`, `plugin:railway:railway`, `plugin:vercel:
 * vercel`. The remainder are the owner's user-scope servers and the `claude.ai`
 * remote connectors. An `mcp__*` tool runs OUTSIDE the CLI's sandbox in its own
 * process, so this is also the answer to "which tools does `denyRead` not cover?"
 * — see the FREE_TEXT comment in claude-builder.ts, which says the same thing
 * from the other side. The owner's `SessionStart` hooks fired as well: five
 * `hook_started`/`hook_response` messages preceded init on every probe.
 *
 * PURE TRANSFORMS OF A MESSAGE THE DRIVER ALREADY HAS, which is what lets the
 * tests cover the hash invariants without spending a single token of
 * subscription quota. The one exception is {@link writeEnvironmentRecord}, the
 * last step, which touches the filesystem and says so.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";

/**
 * The shape of the SDK's `system/init` message, as far as this file cares.
 *
 * STRUCTURAL ON PURPOSE, rather than importing `SDKSystemMessage`. Every field is
 * optional except the two the CLI has always sent, so a future CLI that drops a
 * category, or an older one that never had `plugins`, degrades to an empty list
 * instead of taking the run down at the point where it is trying to RECORD the
 * environment. A real `SDKSystemMessage` satisfies this type (required fields are
 * assignable to optional ones), so the driver passes the message straight in.
 */
export interface InitEnvelope {
  readonly session_id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly claude_code_version?: string;
  readonly agents?: readonly string[];
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly mcp_servers?: readonly { readonly name: string; readonly status: string }[];
  readonly plugins?: readonly { readonly name: string; readonly version?: string }[];
}

export interface McpServerRecord {
  readonly name: string;
  /** The CLI's own word for the handshake result — `connected`, `failed`, … */
  readonly status: string;
}

export interface PluginRecord {
  readonly name: string;
  /** Plugin-author-controlled, and absent when the manifest declares none. */
  readonly version: string | null;
}

/**
 * One build's environment. Every field is REQUIRED and defaults to `[]`, so a
 * reader never has to distinguish "the CLI sent no agents" from "we forgot to
 * record them", and `exactOptionalPropertyTypes` never enters the picture.
 */
export interface RunEnvironment {
  /** Per-run identity. Recorded for correlation; NOT part of the hash. */
  readonly sessionId: string;
  /** The model the CLI reported. Recorded, not hashed — see the header. */
  readonly model: string;
  readonly claudeCodeVersion: string;
  /**
   * Subagent types the CLI discovered. VISIBILITY, NOT PERMISSION: what this
   * build may actually delegate to is `BuildRequest.allowedAgents`, and the two
   * differ by more than a hundred names.
   */
  readonly agents: readonly string[];
  readonly skills: readonly string[];
  /**
   * Tool names at the instant init was emitted. A SNAPSHOT OF A RACE, not a
   * property of the machine: measured at 33, 42, 219 and 272 on four consecutive
   * probes of an unchanged environment, because each MCP server that finishes
   * connecting adds its `mcp__*` tools. Recorded, never hashed.
   */
  readonly tools: readonly string[];
  /**
   * MCP servers the CLI registered, with the status it gave each.
   *
   * THE OPEN QUESTION THIS FIELD ANSWERS. Loading user settings also loads the
   * owner's enabled plugins, and whether those register MCP servers into an SDK
   * `query()` was unknown when `settingSources: ["user"]` landed. It is not
   * answerable by reading configuration — it is answerable by looking at what the
   * CLI reports here, per run, which is why this is captured rather than assumed.
   * Measured 2026-07-28: it does, eight of them. See the header.
   *
   * Also a snapshot: `pending` becomes `connected` as handshakes complete, and one
   * cold start reported 13 servers where the next four reported 22. Recorded so
   * "which servers were up on this run?" stays answerable; not hashed, because
   * the answer changes without the environment changing.
   */
  readonly mcpServers: readonly McpServerRecord[];
  readonly plugins: readonly PluginRecord[];
}

/** Sorted and de-duplicated: the CLI promises no order and order is not signal. */
function names(values: readonly string[] | undefined): readonly string[] {
  return [...new Set(values ?? [])].sort();
}

/** Capture the inventory the CLI reported. Total: no field can throw. */
export function environmentFromInit(init: InitEnvelope): RunEnvironment {
  return {
    sessionId: init.session_id,
    model: init.model ?? "",
    claudeCodeVersion: init.claude_code_version ?? "",
    agents: names(init.agents),
    skills: names(init.skills),
    tools: names(init.tools),
    mcpServers: [...(init.mcp_servers ?? [])]
      .map((server) => ({ name: server.name, status: server.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    plugins: [...(init.plugins ?? [])]
      .map((plugin) => ({ name: plugin.name, version: plugin.version ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * A stable fingerprint of the STABLE half of the discovered environment.
 *
 * Built from an explicitly enumerated tuple rather than from the whole object,
 * so that adding a field to {@link RunEnvironment} later cannot silently make
 * every hash unique — that failure is invisible (the hashes still look like
 * hashes) and it destroys the only property the field has.
 *
 * `tools` and `mcpServers` are excluded ON MEASUREMENT, not on taste. See the
 * table in this file's header: both move between runs of an unchanged machine
 * because MCP servers connect lazily and init is emitted mid-race. Adding either
 * back makes every run's hash unique and this function pointless.
 */
export function environmentHash(environment: RunEnvironment): string {
  const material = JSON.stringify([
    environment.claudeCodeVersion,
    environment.agents,
    environment.skills,
    environment.plugins.map((plugin) => [plugin.name, plugin.version]),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** The JSON written beside the run record. Names AND fingerprint, never one. */
export interface EnvironmentRecord extends RunEnvironment {
  /** sha256 over the discovered categories. See {@link environmentHash}. */
  readonly environmentHash: string;
}

/**
 * The persisted form.
 *
 * BOTH HALVES OR NEITHER. A file listing 162 skills with no fingerprint makes the
 * reader diff two runs by eye; a fingerprint with no names makes a difference
 * visible and unidentifiable. The hash answers "did anything move?" and the names
 * answer "what?", and neither question is the other.
 */
export function environmentRecord(environment: RunEnvironment): EnvironmentRecord {
  return { ...environment, environmentHash: environmentHash(environment) };
}

/** The file the record is written to, inside the run's own results directory. */
export const ENVIRONMENT_FILE = "environment.json";

/**
 * Persist the environment beside the run record, and return where it went.
 *
 * IT LIVES HERE, NOT IN THE ORCHESTRATOR, so it can be EXECUTED by a test. In
 * the orchestrator it would sit inside a private method reachable only by
 * starting a real build, which is the same "reviewed rather than executed"
 * defect this repository has already been bitten by twice (see the header of
 * claude-builder.ts on `settings-plumbing.test.ts`). This is the one impure
 * function in this file and it is the last step of the pipeline; everything
 * above it stays a pure transform.
 *
 * REDACTED, like every other persisted string in this program. An MCP server
 * name is CLI-reported rather than owner-typed, so nothing here is EXPECTED to
 * carry a credential — which is exactly the reasoning that puts a writer outside
 * the chokepoint and is why this one goes through it anyway.
 *
 * `RunRecord` would be the natural home for this and cannot be: it is a bake-off
 * contract type and `bakeoff/` is not ours to modify. A sibling file in the same
 * directory keeps the record rather than dropping it for want of a field.
 */
export function writeEnvironmentRecord(resultsDir: string, environment: RunEnvironment): string {
  const file = join(resultsDir, ENVIRONMENT_FILE);
  const record = redactForPersistence(environmentRecord(environment));
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/**
 * The one line a human sees while the build is starting.
 *
 * MCP servers are NAMED, not counted, while the other categories are counted:
 * there are a hundred-odd agents and skills and nobody reads those in a log, but
 * the MCP set is small, it is the answer to the plugin question above, and a bare
 * "3 MCP servers" cannot tell you WHICH three appeared. A count of zero is
 * printed rather than an empty clause — a missing clause and an empty one read
 * identically to someone who does not know the format.
 */
export function describeEnvironment(environment: RunEnvironment): string {
  const mcp =
    environment.mcpServers.length === 0
      ? "0 MCP servers"
      : `MCP: ${environment.mcpServers.map((s) => `${s.name}(${s.status})`).join(", ")}`;
  return (
    `environment — ${String(environment.agents.length)} agents, ` +
    `${String(environment.skills.length)} skills, ` +
    `${String(environment.tools.length)} tools, ` +
    `${String(environment.plugins.length)} plugins, ${mcp} ` +
    `[env ${environmentHash(environment).slice(0, 12)}]`
  );
}
