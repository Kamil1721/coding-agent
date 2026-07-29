/**
 * builders/claude-builder.ts — the Anthropic build driver.
 *
 * AUTHENTICATION: `claude setup-token` / `claude auth login`. No API key is
 * read, passed or required. The SDK spawns the `claude` binary, which uses the
 * OAuth token it stores itself (on macOS, in the login keychain).
 *
 * ISOLATION, AND HOW IT DIFFERS FROM THE BAKE-OFF'S. The bake-off runs its
 * builder inside a pinned container with egress denied — that seal is a
 * measurement control, worth 14.1-20.7pp of apparent quality. The dashboard
 * builder runs ON THE HOST, because a personal tool that cannot `npm install`
 * cannot build anything. That is a real difference and it is recorded here
 * rather than glossed: a dashboard run is not a bake-off run and the two must
 * never be compared. What IS enforced:
 *
 *   - `cwd` is the run's own workspace, and the CLI's sandbox is enabled with
 *     `filesystem.allowWrite` scoped to that directory, so a build cannot
 *     write outside its workspace.
 *   - `failIfUnavailable: true` by default. If the sandbox cannot start, the
 *     run FAILS with a named remediation instead of silently continuing
 *     unsandboxed with write access to the whole home directory. The owner can
 *     opt out deliberately with DASHBOARD_ALLOW_UNSANDBOXED_BUILDER=1.
 *   - `canUseTool` answers every permission request IT IS ASKED, so nothing can
 *     park waiting for a human who is not there. It also denies writes whose
 *     resolved path escapes the workspace — a second, independent check, since
 *     a defence that exists in one layer only is a defence that has never been
 *     tested. IT IS NOT ASKED FOR EVERY TOOL: probe A measured it consulted for
 *     no tool at all when the model delegates, under `acceptEdits`, `default`
 *     AND `dontAsk` alike. Nothing that must hold may depend on it alone.
 *   - The MCP surface is REMOVED from a build outright:
 *     `managedSettings.allowedMcpServers: []` with `allowManagedMcpServersOnly`.
 *     Measured at zero servers against 13 unnarrowed. A delegation-shaped MCP
 *     tool cannot be enumerated reliably — `railway-agent{isolation:"remote"}`
 *     matched no name gate — so the surface is narrowed away rather than guarded.
 *   - A `PreToolUse` HOOK — not `canUseTool` — denies a DELEGATION: `Agent`/
 *     `Task` by name, or any tool of any name carrying `subagent_type` or
 *     `isolation` (see delegation-hook.ts), unless `isolation` is absent,
 *     `run_in_background` is explicitly `false`, and `subagent_type` is on the
 *     configured shortlist. Those three conditions are UNCHANGED; what changed
 *     on 2026-07-28 is that they now sit in a slot the engine consults. In
 *     `canUseTool` they were vacuous: probe A ran the delegation under
 *     `acceptEdits`, `default` and `dontAsk`, the callback returned deny, was
 *     asked about nothing at all, and `wordpress-master` started in every arm.
 *     The hook's deny was measured to prevent the spawn outright — no
 *     `task_started`, no `SubagentStart`, no tokens billed, and not one
 *     `background_tasks_changed` envelope.
 *     THE SAME HOOK DENIES `SendMessage` OUTRIGHT, and that is a second measured
 *     hole rather than tidiness (probe H): the hook fires for it with
 *     `subagent_type` ABSENT in every arm, so the delegation guard returned
 *     `{continue: true}` by construction, and in the SAME session that denied a
 *     `wordpress-master` spawn a `SendMessage` resumed `code-reviewer` with a
 *     second `task_started` and `SubagentStart` the guard never saw. The
 *     shortlist bounds WHICH AGENTS EXIST, not HOW MUCH WORK THEY RECEIVE. A
 *     hook cannot do better than outright denial here — validating a resume
 *     needs the agentId, which appears only in the Agent tool's RESULT, and
 *     PreToolUse never sees a result.
 *     THE SHORTLIST IS NO LONGER EMPTY: Phase 1 Task 3 supplied it, and it
 *     arrives on `BuildRequest.allowedAgents` — the orchestrator passes
 *     `shortlistFor(classifySurface(ticket))`, roughly two dozen names out of
 *     the 144 `settingSources: ["user"]` makes visible. An EMPTY array still
 *     denies every delegation, with a reason naming the permitted agents as
 *     "(none configured)", and that remains the fail-closed default rather than
 *     a regression: a subagent inherits none of these boundaries automatically,
 *     `subagent_type` is a free string in the SDK schema, and NOTHING ELSE IN
 *     THIS OBJECT NARROWS DELEGATION — `Options.agents` was measured (probe I)
 *     not to bind for any name that exists in ~/.claude/agents/, which is every
 *     name this run shortlists, so this hook is the only narrowing there is.
 *   - The owner's OWN hooks are suppressed for a build
 *     (`managedSettings.allowManagedHooksOnly`), because a PreToolUse hook
 *     returning "allow" pre-empts `canUseTool` outright. That also disables
 *     secret-guard.sh, which is a real cost and is recorded on the value in
 *     `buildOptions` rather than glossed.
 *   - The acceptance suite lives OUTSIDE the workspace (dashboard/acceptance),
 *     is never mounted into it, and the held-out half is never copied in.
 *
 * THE HELD-OUT SUITE IS ALSO DENIED FOR READING, added by the integrator on
 * 2026-07-27 after auditing this file. Until then the suite was protected
 * against being WRITTEN and not against being READ, and it sits on the host
 * filesystem two directories above the workspace. A builder that reads the
 * held-out tests can satisfy them without satisfying the ticket, which makes
 * `heldOutPass` and `falseFinish` meaningless for that run, and there is no
 * detector for it. Three MECHANISMS now, and the count of LAYERS DIFFERS PER
 * TOOL — measured on 2026-07-28 by emptying `permissions.deny` and re-running:
 * sandboxed `cat` is covered TWICE (independently), the in-process `Read` tool
 * ONCE. See mechanisms 2 and 3:
 *
 *   1. {@link decideToolPermission} denies ANY tool — built-in, `mcp__*`, or
 *      one that ships next year — carrying a path that resolves into the suite
 *      store. It was a tool-name allowlist until 2026-07-28, then briefly a
 *      KEY allowlist — the same fail-open shape on another axis, and it was
 *      defeated by `Glob`'s required `pattern` argument. Every value AND every
 *      object KEY is now scanned, at any depth up to NODE_BUDGET nodes, except
 *      a free-text key's own string ON THE ONE TOOL that key belongs to — the
 *      exemption is a (tool, key) pair, so an unknown tool inherits none of it;
 *      see FREE_TEXT, NODE_BUDGET and pathCandidates below. A string is
 *      also judged by the TREE it would walk, not only by its raw spelling —
 *      `Glob{pattern:"/tmp/**\/*.mjs"}` names no sealed path and matches every
 *      file under `/tmp`; see globPrefix below.
 *      EXECUTED: unit-tested directly, with a negative control.
 *   2. `sandbox.filesystem.denyRead` names the suite store to the CLI's own OS
 *      sandbox. EXECUTED FOR BASH, AND INDEPENDENTLY SO — measured 2026-07-28
 *      with `permissions.deny` EMPTIED: `cat <suite>/…` still came back
 *      "Operation not permitted" (seatbelt). That is the isolating control, and
 *      it is why this counts as a layer of its own rather than as plumbing for
 *      mechanism 3. It does NOT cover the in-process Read tool: Phase 1 measured
 *      `denyRead` alone leaving that tool free, which is the asymmetry this list
 *      exists to state. The PLUMBING on this side — that the roots this file
 *      sends are the canonicalised sealed roots — is asserted in
 *      claude-builder.test.ts; `src/builders/settings-plumbing.test.ts` proves
 *      nothing about it, because it builds its OWN `Options` literal and never
 *      calls this builder.
 *   3. `managedSettings.permissions.deny` names the suite store as a POLICY-TIER
 *      rule, with `allowManagedPermissionRulesOnly` so no user, project or local
 *      setting can widen it back open. THIS IS THE ONLY LAYER THE IN-PROCESS
 *      READ TOOL HAS: probe B measured it denying Read with "File is in a
 *      directory that is denied by your permission settings", three consecutive
 *      PASSes, and mechanism 2 does not bind that tool. It needs no callback and
 *      no hook — which is the point, since mechanism 1 depends on `canUseTool`
 *      being consulted and for the Agent tool it is not. See `buildOptions`.
 *
 *      WHAT WAS WITHDRAWN HERE ON 2026-07-28: this used to claim BOTH the Read
 *      denial and the sandboxed-`cat` denial came from this one rule, citing
 *      sdk.d.ts:6194's statement that `Read(...)` deny rules merge into the
 *      sandbox's `denyRead`. The isolating run above falsifies the attribution —
 *      `cat` is denied with this rule EMPTY — and probe B, which had both set,
 *      could never have distinguished "the rule merged" from "denyRead bound on
 *      its own". Two independent layers is the better outcome; claiming one rule
 *      did double duty was an untested inference dressed as a measurement.
 *
 * This is still weaker than the bake-off's boundary, which is a container the
 * held-out half is never mounted into. Said plainly in dashboard/STATUS.md.
 *
 * THE SDK'S `total_cost_usd` IS NOT READ. See claude-common.ts.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  NOT_RATE_LIMITED,
  assistantText,
  rateLimitFrom,
  resultErrorText,
  resultTokens,
  summariseToolInput,
  toolUses,
  truncate,
  usageDisagreement,
} from "../claude-common.js";
import type { RateLimitState, ResultUsageEnvelope } from "../claude-common.js";
import {
  LaneWatch,
  compactionFrom,
  contextSample,
  describeCompaction,
  describeContextSample,
} from "../build-context.js";
import type {
  CompactBoundaryEnvelope,
  CompactionRecord,
  ContextSample,
  ContextUsageEnvelope,
  LaneBoundary,
} from "../build-context.js";
import { describeEnvironment, environmentFromInit } from "../build-environment.js";
import type { InitEnvelope, RunEnvironment } from "../build-environment.js";
import { subscriptionSubprocessEnv } from "../subprocess-env.js";
import { chainPreToolUse, makeAntiSlopHook, makeMotionStopHook, makeWorkspaceReader } from "./antislop-hook.js";
import type { AntiSlopObserver } from "./antislop-hook.js";
import { makeDelegationHook } from "./delegation-hook.js";
import type { DelegationObserver } from "./delegation-hook.js";
import { GraphProjection } from "../graph-emit.js";
import { addTokens, zeroTokens } from "../tokens.js";
import type { TokenTotals } from "../tokens.js";
import type { BuildEventSink, BuildOutcome, BuildRequest, SubscriptionBuilder } from "./types.js";
import type { GraphSseEvent } from "../api-types.js";

/** Set to "1" to let a build run when the CLI sandbox cannot start. */
export const ALLOW_UNSANDBOXED_ENV = "DASHBOARD_ALLOW_UNSANDBOXED_BUILDER";

/**
 * Turn caps.
 *
 * NOT a stuck-detector. doc 03 section 7.8 is explicit: 79% of unresolved
 * long-horizon runs time out WHILE STILL MAKING PROGRESS, so heuristic
 * stuck-detection kills runs that were converging. This is a plain boundary,
 * like a wall clock, and when it is hit the run is recorded as incomplete
 * rather than failed-for-inability.
 */
export const DEFAULT_MAX_TURNS = 400;

/** Tools whose input names a path that must stay inside the workspace. */
const PATH_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Tools that walk a directory tree. When their path argument is omitted the CLI
 * searches the CURRENT WORKING DIRECTORY, so "no path" is not "no target" — it
 * is a target we have to name ourselves before we can judge it.
 */
const RECURSIVE_TOOLS = new Set(["Grep", "Glob"]);

// READ_TOOLS (a tool-name allowlist) was removed on 2026-07-28. It was
// structurally fail-open: `mcp__*` read tools and ReadMcpResource were never in
// it and returned ALLOW on a sealed path. Sealed roots are now denied for every
// tool name; only the WRITE confinement below is still name-gated.
//
// `Bash` remains uncovered by this function and cannot be covered here: with
// `autoAllowBashIfSandboxed: true` a sandboxed command never reaches
// `canUseTool` at all, and pattern-matching shell text for `cat`/`grep` would
// be a filter anyone could step around while reading as if it were a boundary.
// The OS-level `denyRead` below is the layer that covers Bash.

/**
 * Which (TOOL, KEY) pairs carry FREE TEXT rather than a path.
 *
 * SCOPED PER TOOL, because the justification is per tool. `command` was exempt
 * for every tool name on earth, and the argument for exempting it is about
 * exactly one: with `autoAllowBashIfSandboxed: true` a sandboxed `Bash` never
 * reaches this function, so scanning its command string buys nothing the OS
 * sandbox does not already provide, while denying ordinary work. Nothing in
 * that argument transfers to a tool that merely SPELLS its argument `command` —
 * `Monitor{command:…}`, `REPL{code:…}`, or any `mcp__*` server, which runs in
 * its own process OUTSIDE the CLI's sandbox and is therefore covered by no
 * other layer at all. Probed against dist before this table existed:
 * `Monitor{command:"<suite>/t.mjs"}` returned ALLOW.
 *
 * AN UNKNOWN TOOL GETS NOTHING. That is the same polarity as the rest of this
 * file: a tool-name allowlist (READ_TOOLS) and a path-key allowlist both failed
 * open, so what is enumerated here is the EXEMPTION, and everything unenumerated
 * is judged. The cost is bounded, because a non-exempt string is judged as a
 * whole path: ordinary prose (`TodoWrite{content:"ship the parser"}`) is not a
 * path and stays allowed. Only prose that IS a path is denied.
 *
 * WHAT THIS DOES NOT CLOSE, measured rather than assumed: because a non-exempt
 * string is judged WHOLE, a sealed path EMBEDDED in shell or code text under a
 * non-exempt key is still allowed. `Monitor{cmd:"cat <suite>/t.mjs"}` and
 * `REPL{src:"read('<suite>/t.mjs')"}` both returned ALLOW against dist, and
 * still do. Closing that needs path-like TOKENS pulled out of free-form text,
 * which is a text filter, not a boundary — `acc''eptance`, `$HOME/../dash/...`
 * and `cd <suite>; cat t.mjs` all step around it while it reads in a mutation
 * table as if it were a boundary. It is deliberately not done here; the layer
 * that actually covers text-executing tools is the OS sandbox's `denyRead`, and
 * for an out-of-process MCP server there is no such layer today. This comment is
 * the record until dashboard/STATUS.md carries it — the Phase 0.2 plan header
 * lists this bypass as closed by this change, and it is NOT.
 *
 * WHICH ENTRIES A TEST ACTUALLY PINS, since "it is in the table" is not the same
 * as "removing it breaks something". Deleting the Write/Edit/MultiEdit/
 * NotebookEdit entries each turns a negative control red, because those four are
 * PATH_TOOLS: every candidate must be inside the workspace, so a payload
 * beginning with `/` — a `/* … *\/` banner, a config value edited to an absolute
 * path — is denied the moment its key stops being free text. Deleting the Bash or
 * Agent/Task entries changes NOTHING any test can see: those tools are not
 * PATH_TOOLS, so the only observable effect of their exemption is to allow a
 * value that IS a sealed path (`Bash{command:"<suite>/run.sh"}`). Pinning them
 * would mean asserting that fail-open is desirable, which it is not, so it is
 * recorded here instead. Narrowing the table to drop them is a real improvement
 * and belongs in its own change, not smuggled in beside this one.
 *
 * The exemption reaches a STRING ONLY — see pathCandidates. Naming a key here
 * does not seal off whatever sits beneath it.
 *
 * `new_source` is NotebookEdit's write PAYLOAD — cell code, which routinely
 * contains `../` inside a string literal. `resolve()` collapses `..` anywhere
 * in a string, not only at its start, so scanning this key denied a legitimate
 * cell edit with the workspace-write message; that was demonstrated red before
 * it was added here. Being a write payload it cannot enable a sealed READ.
 *
 * `MultiEdit`'s pair sits on the objects INSIDE `edits[]`, not on `edits`
 * itself. It works only because the walker carries a parent key down through an
 * array and re-dispatches on the inner key; there is a negative control on that
 * propagation in claude-builder.test.ts.
 */
const FREE_TEXT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Bash", new Set(["command", "description"])],
  ["Write", new Set(["content"])],
  ["Edit", new Set(["old_string", "new_string"])],
  ["MultiEdit", new Set(["old_string", "new_string"])],
  ["NotebookEdit", new Set(["new_source"])],
  ["Agent", new Set(["prompt", "description"])],
  ["Task", new Set(["prompt", "description"])],
]);

/** No tool name matched, so no key is exempt. Deny-by-default, allocated once. */
const NO_FREE_TEXT: ReadonlySet<string> = new Set<string>();

/**
 * The literal prefix of a glob pattern — the directory the tool will actually
 * walk.
 *
 * A GLOB NAMES A TREE, NOT A FILE. `resolve()` treats `**` as an ordinary path
 * segment, so `/tmp/**\/*.mjs` came out as the literal string `/tmp/**\/*.mjs`,
 * which is neither inside the sealed root nor a lexical ancestor of it — ALLOW,
 * while the expanded pattern matches every file under `/tmp`, suite included.
 * Probed against dist: `Glob{pattern:"/tmp/**\/*.mjs"}` returned allow.
 *
 * Truncation goes back to the last SEPARATOR, not to the metacharacter. Cutting
 * at the metacharacter leaves `/tmp/dash/accept*` as `/tmp/dash/accept`, which
 * is not `/tmp/dash/acceptance` and not an ancestor of it — so the bypass simply
 * moves mid-segment. The containing directory IS the tree that gets walked.
 *
 * The whole class `*?[]{}` is cut on, not just `*`: `acceptanc?` and
 * `{acceptance,src}` expand into the suite exactly as `**` does.
 *
 * Deliberately NOT gated on tool name. A name gate is fail-open to every
 * `mcp__*` search tool, which is the mistake READ_TOOLS made. The cost is a
 * bounded over-deny — a LITERAL path containing a metacharacter is judged by its
 * parent directory too — which is the safe direction, and the raw value is kept
 * alongside so nothing that was denied becomes allowed.
 */
function globPrefix(value: string): string {
  const cut = value.search(/[*?[\]{}]/);
  if (cut === -1) return value;
  const head = value.slice(0, cut);
  const lastSep = head.lastIndexOf("/");
  return lastSep === -1 ? "." : head.slice(0, lastSep + 1);
}

/**
 * How many nodes the walker will look at before it stops.
 *
 * A TOTAL BUDGET, NOT A DEPTH CAP. The cap was `depth > 6`, and a depth cap is
 * cheap to step over: eight levels of `{nest:…}` around a sealed `file_path`
 * returned ALLOW against dist, at no cost to the attacker. A budget bounds the
 * adversarial work — which is the only thing the cap was ever for — and closes
 * the DEPTH escape outright, because nesting no longer buys anything that
 * breadth does not also cost.
 *
 * WHAT IT DOES NOT CLOSE, said plainly rather than implied: the budget is
 * spent, not restored, so once it runs out the walk stops and later siblings
 * are never scanned. `{pad:[…600 zeroes…], evil:{file_path:"<suite>/x"}}`
 * returns ALLOW — measured against dist, not reasoned about. Any finite bound
 * has this property; the choice is which shape of input pays for it, and
 * padding to 512 nodes is a great deal more conspicuous in a transcript than
 * adding a seventh `{nest:…}`. Removing it entirely is not the answer either —
 * an unbounded walk over attacker-shaped input is a denial of service, and a
 * cyclic object would not terminate. Narrowing it (charge only CONTAINER
 * nodes, or scan breadth-first so shallow keys are never starved by a deep
 * sibling) is a real improvement and is deliberately NOT done here: it is
 * outside this change and belongs with the per-tool work, not smuggled in
 * beside it. This comment is the record until STATUS.md carries it — an
 * unwritten limit is one the next reader has to rediscover by being bitten.
 *
 * 512 is far above any real tool input (the largest built-in schema has a
 * handful of keys) and far below anything that costs measurable time.
 */
const NODE_BUDGET = 512;

/**
 * Every value in the input that could name a path — which is every string that
 * is not explicitly free text, plus every object KEY, at any depth, for the
 * first NODE_BUDGET nodes (see its limits above).
 *
 * KEYS ARE CANDIDATES TOO. Only values were read, so a map keyed BY path —
 * `{files:{"<suite>/FROZEN.json": "…"}}`, the ordinary shape of a multi-file
 * write tool — put the sealed path in a position nothing looked at. Probed
 * against dist: ALLOW.
 *
 * The exemption is looked up by (TOOL, KEY), not by key alone — see FREE_TEXT.
 * `toolName` is threaded in for that one lookup and nothing else.
 *
 * A FREE-TEXT KEY EXEMPTS ITS OWN STRING, NOTHING ELSE. The exemption used to
 * sit above the type dispatch, so it pruned the whole SUBTREE: wrapping the
 * path one level down, as `{content:{path:"<suite>/t.mjs"}}`, walked straight
 * past the guard. Probed against dist: ALLOW. The exemption exists because a
 * build legitimately writes content and shell text that NAME the suite — that
 * argument covers a string and does not extend to an object beneath it, which
 * no tool schema puts there as prose.
 *
 * The array branch carries the PARENT key down on purpose: `{command:[…]}` is
 * still the same free text one level of container out.
 */
function pathCandidates(toolName: string, input: Record<string, unknown>): string[] {
  const found: string[] = [];
  const freeText = FREE_TEXT.get(toolName) ?? NO_FREE_TEXT;
  let budget = NODE_BUDGET;
  // BOTH spellings, for keys and values alike. The raw string keeps a literal
  // path judged literally; the prefix is the tree a pattern would expand into.
  // Any rewrite of this visitor MUST keep this pair — see the mid-segment glob
  // test. (The Task 3 plan snippet dropped it; that would have silently undone
  // the glob fix while every new test still passed.)
  const push = (value: string): void => {
    if (value.length === 0) return;
    found.push(value);
    const prefix = globPrefix(value);
    if (prefix !== value) found.push(prefix);
  };
  const visit = (key: string, value: unknown): void => {
    if (budget-- <= 0) return;
    if (typeof value === "string") {
      if (!freeText.has(key)) push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(key, item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        push(k);
        visit(k, v);
      }
    }
  };
  // The root object goes through the same branch, so its keys are scanned too.
  // The empty key name belongs to no exemption, which is the right default:
  // there is no tool whose whole input is free text.
  visit("", input);
  return found;
}

/**
 * Reduce a raw input value to the path a consuming tool would actually open.
 *
 * Three transforms, each closing a confirmed bypass:
 *   file: URI    — `resolve()` treats the scheme as a relative segment, so
 *                  `file:///x/y` became `<workspace>/file:/x/y` and missed.
 *                  Matched on `file:` and not on `file://`: RFC 8089 permits
 *                  the authority to be omitted, and `fileURLToPath` maps
 *                  `file:/x/y` to `/x/y` exactly as it maps `file:///x/y`, so
 *                  the narrower anchor left an openable form allowed.
 *   percent      — the consuming tool decodes AFTER our check, so `%61cceptance`
 *                  and `%2e%2e` reached the suite unseen.
 *   other scheme — `https://…` is not a path; leave it alone rather than
 *                  mangling it into one.
 */
function normaliseCandidate(value: string): string {
  let s = value;
  if (/^file:/i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      /* malformed; fall through */
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    return s; // a non-file URL is not a filesystem path
  }
  // At most twice: once handles ordinary encoding, twice catches `%252e`. An
  // unbounded loop would be a denial of service on a crafted input.
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(s); i += 1) {
    try {
      s = decodeURIComponent(s);
    } catch {
      break;
    }
  }
  return s;
}

/**
 * Resolve a path through symlinks, as far as it exists.
 *
 * {@link decideToolPermission} is pure and therefore lexical, so it cannot see
 * that `<workspace>/link/x` is really `<suite>/x`. Creating that link is a legal
 * in-workspace write and needs no read of the target, so the pure check alone is
 * defeatable. The fs-aware step belongs here, in the caller, and is handed to
 * the decision function as the `canonicalise` argument.
 *
 * Total by construction: a path that does not exist yet — which is EVERY Write
 * target — has its longest existing ancestor resolved and the remainder
 * re-appended. It never throws and never returns "".
 */
export function canonicaliseForDecision(candidatePath: string): string {
  let head = resolve(candidatePath);
  const tail: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      return tail.length === 0
        ? realpathSync.native(head)
        : join(realpathSync.native(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(candidatePath);
      tail.unshift(basename(head));
      head = parent;
    }
  }
  return resolve(candidatePath);
}

/**
 * The pure default for the `canonicalise` argument: no filesystem, no change.
 *
 * Every four- and five-argument call — which is every unit test that does not
 * build a fixture on disk — keeps exactly the lexical behaviour it had.
 */
const LEXICAL_ONLY = (path: string): string => path;

function insideDir(
  dir: string,
  candidate: string,
  base: string,
  canonicalise: (path: string) => string,
): boolean {
  const root = canonicalise(resolve(dir));
  const target = canonicalise(resolve(base, candidate));
  return target === root || target.startsWith(`${root}/`);
}

/**
 * True when `candidate` is inside `root` OR recursively CONTAINS it.
 *
 * The second half is the one that was missing. `Grep`/`Glob` take a DIRECTORY
 * and walk it recursively, so a candidate that is an ancestor of the sealed
 * store reaches every file in it without ever naming it. Asking only "is the
 * candidate inside the root?" answers the wrong question for a recursive tool.
 *
 * CASE-FOLDED, deliberately. macOS and Windows volumes are case-INSENSITIVE
 * while `resolve()` is case-PRESERVING and `===`/`startsWith` are
 * case-SENSITIVE, so `/x/Acceptance` compared unequal to `/x/acceptance` and
 * the OS then opened the very file the comparison had just cleared. Folding
 * over-denies on a case-sensitive volume — that is the safe direction for a
 * sealed root. `insideDir` above stays case-sensitive on purpose: it guards
 * WRITES, where over-denying blocks legitimate work, and `allowWrite` covers
 * that boundary at the OS level.
 */
function containsOrIsInside(
  root: string,
  candidate: string,
  base: string,
  canonicalise: (path: string) => string,
): boolean {
  // BOTH sides go through the same canonicaliser. Canonicalising only the
  // candidate would compare `/private/tmp/dash/acceptance` against a root still
  // spelled `/tmp/dash/acceptance` and return ALLOW for the suite itself.
  const rootAbs = canonicalise(resolve(root)).toLowerCase();
  const target = canonicalise(resolve(base, normaliseCandidate(candidate))).toLowerCase();
  if (target === rootAbs) return true;
  if (target.startsWith(`${rootAbs}/`)) return true;
  return rootAbs.startsWith(target === "/" ? "/" : `${target}/`);
}

/**
 * The write confinement, canonicalised on both sides for the same reason.
 *
 * `<workspace>/escape -> /etc` is lexically inside the workspace, so without
 * this the sealed check would pass the path (it is not the suite) and the
 * confinement would allow a write straight out of the workspace. Demonstrated
 * red before this argument was threaded through.
 */
function insideWorkspace(
  workspace: string,
  candidate: string,
  canonicalise: (path: string) => string,
): boolean {
  return insideDir(workspace, candidate, resolve(workspace), canonicalise);
}

/**
 * The permission decision, as a pure function, so it can be exercised without
 * spawning a CLI. `claude-builder.test.ts` calls it directly.
 *
 * WHAT IT DECIDES, AFTER TASK 2: sealed-root reads and workspace-confined
 * writes. It no longer decides DELEGATION, and it takes no `allowedAgents`
 * argument — the parameter went with the branch, because an argument nothing
 * reads is the same dead-boundary defect one level down. Delegation is decided
 * by the `PreToolUse` hook (delegation-hook.ts), which the engine actually asks.
 *
 * Relative paths are resolved against the workspace, which is the builder's
 * `cwd` — the same resolution the CLI performs.
 *
 * `canonicalise` is the one fs-aware step, INJECTED rather than performed here,
 * so this body still touches no filesystem and is still synchronous. It
 * defaults to the identity, which is what every unit call below relies on. The
 * closure passes {@link canonicaliseForDecision}; without it every comparison
 * is lexical and `<workspace>/link -> <suite>` launders a read straight past
 * the check. Pre-canonicalising `input` in the CALLER instead would not work:
 * `resolve()` mangles a `file:` scheme into a relative segment before
 * `normaliseCandidate` ever sees it, re-opening the URI bypass.
 */
export function decideToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
  sealedRoots: readonly string[],
  canonicalise: (path: string) => string = LEXICAL_ONLY,
): PermissionResult {
  const candidates = pathCandidates(toolName, input);
  // A recursive tool searches its cwd IN ADDITION to any path it names. Phase 0
  // folded cwd in only when no candidate was found, so a stray `glob` key
  // switched the fold off and the guard judged the wrong target affirmatively.
  if (RECURSIVE_TOOLS.has(toolName)) candidates.push(workspace);
  const base = resolve(workspace);

  // SEALED ROOTS: denied for EVERY tool, by any key, in either direction.
  // No tool-name gate — an allowlist is fail-open to every read-capable tool
  // the CLI adds and every MCP server the owner enables.
  //
  // THIS SCAN RUNS FIRST, BEFORE THE AGENT BRANCH BELOW. The branch used to
  // return — allow as well as deny — before any candidate was looked at, so a
  // well-formed shortlisted `Agent{subagent_type:ok, file_path:"<suite>/x"}` was
  // ALLOWED with the sealed path never judged.
  //
  // THAT PATH IS NOW LIVE. Phase 0 wrote "unreachable only while ALLOWED_AGENTS
  // is empty; it goes live the moment Phase 1 supplies a shortlist" — Task 3 is
  // that moment. `buildOptions` feeds this predicate `request.allowedAgents`,
  // so a shortlisted `subagent_type` reaches the code below on every real run.
  // A boundary whose reachability depends on a constant elsewhere is not a
  // boundary; the sealed scan is unconditional for every tool name, and the
  // ordering is covered end-to-end by "the Phase 0 guards survive delegation
  // being enabled" in claude-builder.test.ts, which asserts the denial message
  // is the SEALED one rather than the shortlist's.
  for (const candidate of candidates) {
    if (sealedRoots.some((root) => containsOrIsInside(root, candidate, base, canonicalise))) {
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
  //
  // IT STAYS ABOVE WHATEVER COMES NEXT, AND THAT ORDER IS LOAD-BEARING. It was
  // hoisted here in commit ea52322 to fix a MEASURED escape: the delegation
  // branch that used to sit below it RETURNED — allow as well as deny — so
  // `Write{file_path:"/etc/passwd", subagent_type:<shortlisted>,
  // run_in_background:false}` passed all three delegation checks and returned
  // ALLOW with the escaping path never judged. Task 2 deleted that branch, so
  // today nothing below can return early and the hoist looks redundant. IT IS
  // NOT: it is what makes the confinement independent of whatever the next
  // change adds underneath, and putting it back below a returning branch
  // re-opens a hole that was found by measurement rather than by review.
  for (const candidate of candidates) {
    if (PATH_TOOLS.has(toolName) && !insideWorkspace(workspace, candidate, canonicalise)) {
      return {
        behavior: "deny",
        message:
          `This run may only write inside its own workspace (${workspace}). Put the implementation there.`,
      };
    }
  }

  // THE AGENT BRANCH USED TO BE HERE, AND IT WAS DELETED IN PHASE 1.1 TASK 2
  // RATHER THAN FIXED. It gated delegation on three conditions — `isolation`
  // absent, `run_in_background === false`, `subagent_type` on the shortlist —
  // and probe A measured that ALL THREE were vacuous in production: across
  // `acceptEdits`, `default` AND `dontAsk`, this callback returned deny, was
  // consulted for NO TOOL AT ALL, and the subagent started anyway. Code that
  // reads like a boundary and enforces nothing is worse than no code, because
  // every reader after it believes the boundary exists.
  //
  // THE THREE CONDITIONS WERE NOT WRONG — THEY WERE NEVER ASKED. They live
  // unchanged in `decideDelegation` (delegation-hook.ts), behind the
  // `PreToolUse` slot `buildOptions` registers, which IS consulted and whose
  // deny was measured to prevent the spawn outright. Nothing here supplements
  // them; a second copy in a callback the engine skips would be the same lie in
  // a smaller font.
  //
  // Everything else is allowed WITHOUT asking, because there is nobody to ask:
  // an unanswered permission prompt has no park deadline and would hang the run
  // forever.
  return { behavior: "allow" };
}

/**
 * The permission callback the SDK is handed, as its own exported function.
 *
 * `workspace` and `sealedRoots` arrive ALREADY CANONICAL from
 * {@link buildOptions}; canonicalising again here would be harmless — the
 * transform is idempotent — but doing it once at the seam is what keeps the
 * predicate and the OS sandbox looking at the same spelling.
 *
 * `canonicaliseForDecision` is then INJECTED so the candidate inside `input` is
 * canonicalised too, at the point where `normaliseCandidate` and
 * base-resolution have already run. Pre-canonicalising `input` in this caller
 * instead would re-open the `file:` URI bypass, because `resolve()` mangles the
 * scheme before the normaliser ever sees it. Without the injection,
 * `<workspace>/link -> <suite>` launders a read straight past the check.
 */
export function makeCanUseTool(workspace: string, sealedRoots: readonly string[]): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> =>
    decideToolPermission(toolName, input, workspace, sealedRoots, canonicaliseForDecision);
}

/**
 * A sealed root as a permission rule.
 *
 * `Read(//abs/path/**)` — the double slash is the syntax for an ABSOLUTE path,
 * so an already-absolute root produces THREE leading slashes and that is
 * correct, not a bug. Pinned literally in claude-builder.test.ts against a root
 * no canonicaliser rewrites, because a wrong prefix here fails silently: the
 * rule matches nothing, the CLI reports no error, and the suite is open again
 * with every test still green.
 */
function denyReadRule(root: string): string {
  return `Read(//${root}/**)`;
}

/**
 * The `Options` object handed to the SDK, as a function so it can be ASSERTED.
 *
 * It used to be a literal inside `build()`, reachable only by spawning a CLI.
 * Deleting `canUseTool` from it, emptying `denyRead`, widening `allowWrite` to
 * `/` and disabling the sandbox all left the test suite green — the whole
 * boundary could be disconnected and nothing failed, because the only "wiring"
 * test matched regexes against this file's SOURCE TEXT. See
 * `claude-builder.test.ts`, which now asserts the returned object directly.
 *
 * CANONICALISATION HAPPENS HERE, ONCE. The predicate previously received
 * `canonicaliseForDecision` output while `denyRead`/`allowWrite`/`cwd` received
 * a lexical `resolve()`, so a workspace or a sealed root reached through a
 * symlink — which is every path under `/tmp` on macOS — was one directory to
 * the guard and a different one to the CLI's own sandbox. Two layers that
 * disagree about what a path is are not two layers.
 */
export function buildOptions(
  request: BuildRequest,
  allowUnsandboxed: boolean,
  /**
   * A bystander on the delegation hook, for the canvas. STRICTLY ADDITIVE and
   * defaulted to null, so every existing call site — and every assertion about
   * the object this returns — is unchanged. It cannot alter a decision: see
   * `DelegationObserver`, which is invoked after the decision is computed, has
   * its return value discarded, and is wrapped in a try/catch.
   */
  observeDelegation: DelegationObserver | null = null,
  /**
   * A bystander on the anti-slop gate (Phase 2a). ADDITIVE and defaulted to
   * null, on the same terms as `observeDelegation`: it is invoked after the
   * decision, its return value is discarded, and it is wrapped in a try/catch.
   */
  observeAntiSlop: AntiSlopObserver | null = null,
): Options {
  const workspace = canonicaliseForDecision(request.workspace);
  const sealedRoots = request.sealedRoots.map((root) => canonicaliseForDecision(root));

  return {
    cwd: workspace,
    model: request.modelId,
    maxTurns: DEFAULT_MAX_TURNS,
    permissionMode: "acceptEdits",
    // THE SEALED-PATH AND WORKSPACE-WRITE GUARD, AND NOTHING ELSE ANY MORE.
    //
    // IT NO LONGER CARRIES DELEGATION, and it no longer takes a shortlist. It
    // did until Task 2, and probe A measured that the engine asks this callback
    // for NO TOOL AT ALL when the model delegates — so that half was dead. What
    // it still does is real and still reached: it is the layer that denies a
    // sealed path to a tool the OS sandbox does not cover, and it never parks
    // waiting for a human who is not there.
    canUseTool: makeCanUseTool(workspace, sealedRoots),
    // THE DELEGATION BOUNDARY, IN THE ONLY SLOT THE ENGINE ASKS.
    //
    // THE SHORTLIST COMES FROM THE REQUEST, not from a constant in this module.
    // It was `const ALLOWED_AGENTS = []` through Phase 0; the orchestrator now
    // supplies `shortlistFor(surface)`. FAIL-CLOSED SURVIVES THE MOVE: the field
    // is REQUIRED on `BuildRequest`, so a caller cannot omit it, and `[]` still
    // denies every delegation.
    //
    // WHY NOT `canUseTool`, MEASURED RATHER THAN ASSERTED. Probe A ran the
    // delegation under `acceptEdits`, `default` AND `dontAsk`. In every arm the
    // callback returned `{behavior:"deny"}`, was consulted for NO TOOL AT ALL,
    // and `wordpress-master` started anyway. An apparatus control in the same
    // option shape had `canUseTool` fire normally for `Write`, so "the callback
    // is not wired" is ruled out. There is no permission mode that fixes it, and
    // the SDK says so itself: `sdk.mjs`'s shadow warning reads "To gate every
    // tool call, use a PreToolUse hook instead."
    //
    // ONE SLOT, NO MATCHER, and the deny genuinely prevents the spawn: no
    // `task_started`, no `SubagentStart`, no agentId minted, no tokens billed
    // (the allow control billed 20639), and not one `background_tasks_changed`
    // envelope. See delegation-hook.ts for the rest of what was measured and
    // what was not.
    //
    // PHASE 2a CHAINS THE ANTI-SLOP WRITE GATE INTO THE SAME SLOT rather than
    // registering a second matcher. Probe E registered three slots and ALL THREE
    // fired for the same `tool_use_id`, so which one carried the DECISION was
    // never measured — a second matcher would stack a new craft rule on top of
    // an unmeasured precedence question, and the failure mode is silent in both
    // directions. `chainPreToolUse` consults delegation FIRST and returns the
    // first stopping output, so every delegation denial keeps its exact string
    // and its exact precedence; two of those strings are pinned by tests and
    // reach the model verbatim.
    hooks: {
      PreToolUse: [
        chainPreToolUse(
          makeDelegationHook(request.allowedAgents, observeDelegation),
          makeAntiSlopHook({ observe: observeAntiSlop }),
        ),
      ],
      // LAYER 2, THE COMPLETION GATE (spec §8). It abstains on a workspace with
      // no web surface, abstains when `stop_hook_active` says it already blocked
      // once, and escalates after two blocks — a completion gate that can loop
      // is a build that never finishes for a reason nothing in the ticket
      // predicts.
      Stop: [makeMotionStopHook(makeWorkspaceReader(workspace), { observe: observeAntiSlop })],
      SubagentStop: [makeMotionStopHook(makeWorkspaceReader(workspace), { observe: observeAntiSlop })],
    },
    // NO `agents:` KEY, AND ITS ABSENCE IS THE MEASUREMENT — NOT AN OVERSIGHT.
    //
    // This object carried one `AgentDefinition` per shortlisted agent until
    // 2026-07-29: a `prompt` (the report contract), a
    // `criticalSystemReminder_EXPERIMENTAL`, a per-lane `maxTurns`,
    // `disallowedTools: ["mcp__*"]` and `background: false`. Every one of those
    // fields is measured NOT TO REACH the agents this run delegates to.
    //
    //   probe G2   session-level narrowing removed, the per-agent
    //              `disallowedTools` kept: the child enumerated 620 tools, 589 of
    //              them `mcp__*` — IDENTICAL to the unnarrowed control.
    //   probe I    identical definitions under a name that HAS a file in
    //              ~/.claude/agents/ and one that does not. The fresh name echoed
    //              its definition's nonce and ran its definition's model; the
    //              colliding name echoed nothing and ran the model from its disk
    //              frontmatter. `maxTurns: 1` cut the fresh child off after one
    //              round-trip and did not bind the colliding one; `background:
    //              false` bound neither. `Options.agents` DOES NOT BIND for a name
    //              that exists on disk.
    //
    // WHY THAT MAKES THE BLOCK UNREACHABLE RATHER THAN MERELY INERT. The only name
    // it could bind is one with NO file in ~/.claude/agents/. Two facts close that
    // door: "every shortlisted agent exists on disk" is a green test in
    // agent-shortlist.test.ts, so no shortlisted name is such a name — and the
    // PreToolUse hook above denies every `subagent_type` off the shortlist, so no
    // OTHER name gets to run either. There is no delegation this run can perform
    // for which a definition here would be consulted.
    //
    // WHY IT IS DELETED RATHER THAN KEPT WITH AN HONEST COMMENT. `AgentDefinition`
    // REQUIRES `prompt`, and `prompt` is precisely the field probe I measured
    // discarded, so there is no subset of it that says something true. And keeping
    // it is worse than useless: probe I found `supportedAgents()` advertising the
    // Options entry's own description and model, with `getContextUsage()` sourcing
    // it to "flagSettings", while the engine ran the disk definition. A reader who
    // checks the roster concludes the definition bound. It did not.
    //
    // WHAT REPLACED EACH FIELD, so nothing is silently dropped:
    //   prompt / reminder   the report contract, in the orchestrator's own build
    //                       prompt, which it is told to paste into each Agent
    //                       call's `prompt` — the one channel probe I measured
    //                       reaching a child. See build-prompt.ts.
    //   disallowedTools     the SESSION-level `managedSettings.allowedMcpServers:
    //                       []` below, measured at zero servers against 13.
    //   background: false   the PreToolUse hook above, which denies any delegation
    //                       whose `run_in_background` is not exactly false —
    //                       measured to prevent the spawn outright.
    //   maxTurns            NOTHING. `boundsFor()` still computes the per-lane
    //                       numbers and they are still the right numbers, but no
    //                       route applies them: `AgentInput` has no turn field, so
    //                       a bound cannot ride on the call either. Recorded as
    //                       open rather than papered over with wiring that does
    //                       not bind.
    includePartialMessages: false,
    // The builder gets the full Claude Code tool set: it is building software.
    tools: { type: "preset", preset: "claude_code" },
    // The owner's agents, skills and CLAUDE.md ARE loaded. This reverses the
    // original decision deliberately, on probe evidence and an owner decision.
    //
    // PROBED 2026-07-28: settingSources [] discovers 16 skills, ALL built-in, and
    // NONE of the owner's 41. AgentDefinition.skills can only name a DISCOVERED
    // skill, so under [] every preload silently resolves to nothing. And there is
    // no programmatic route to fall back on: `Options.agents` looks like one for
    // agents and probe I measured it not binding for any name that exists on
    // disk, so [] would cost the skills and buy nothing.
    //
    // The original justification was COMPARABILITY — an uncontrolled input that
    // changes what gets built without appearing in the ticket. Model comparison
    // has been dropped (it existed to pit Claude against Codex; Codex is out of
    // scope), so that cost is now close to zero while the benefit is the whole
    // skill system, which the DESIGN lane and the motion bar depend on.
    //
    // WHAT THIS DOES NOT WEAKEN: the sealed boundary. denyRead, allowWrite,
    // canUseTool and the Agent guard are all set here, not in user settings, and
    // are unaffected. `heldOutPass` still means "did this build deliver?".
    // That is asserted, not claimed: see "loading user settings does NOT weaken
    // the sealed boundary" in claude-builder.test.ts, which reads all four off
    // the same options object that carries ["user"].
    //
    // ALSO LOADED: the owner's hooks — guard.sh and secret-guard.sh (PreToolUse,
    // both protective), verify.sh (PostToolUse + Stop), migration-lint.sh,
    // session-summary.sh. `verify.sh full` on Stop is built for interactive
    // sessions and can block completion; if a build hangs there, exclude that one
    // hook rather than reverting this decision.
    settingSources: ["user"],
    // THE SEALED BOUNDARY, AT THE POLICY TIER.
    //
    // WHY NOT THE CALLBACK. `canUseTool` is not consulted for every tool under
    // every permissionMode — Phase 1 measured it never consulted for Agent — and
    // a PreToolUse hook returning "allow" pre-empts it outright (sdk.d.ts:4166,
    // verbatim: "PreToolUse hook denies bypass canUseTool and are not covered
    // here"). A boundary a hook can switch off is not a boundary. Settings
    // precedence is user < project < local < flag < policy (sdk.d.ts:5499) and
    // `Options.managedSettings` IS the policy tier — there is no admin tier on
    // this machine, so it applies as the sole policy source — which is why
    // nothing in the owner's settings can widen this.
    //
    // WHAT THIS RULE IS MEASURED TO DO, AND WHAT IT IS NOT. Probe B, three
    // consecutive PASSes, denied the in-process Read tool with "File is in a
    // directory that is denied by your permission settings", and sandboxed `cat`
    // with "Operation not permitted" (seatbelt). This comment used to read that
    // BOTH denials came from this ONE rule, citing sdk.d.ts:6194's claim that
    // `Read(...)` deny rules merge into the sandbox's own `denyRead`.
    //
    // THAT ATTRIBUTION IS FALSE, and it was measured false on 2026-07-28 by the
    // control probe B never ran: with `permissions.deny` EMPTIED, `cat` STILL
    // returned "Operation not permitted". The Bash denial is `denyRead`'s,
    // independently of this rule. Probe B set both together, so it could not have
    // told the two apart — the merge claim was an inference from the SDK's own
    // docs printed as a measurement.
    //
    // WHAT ACTUALLY HOLDS IS BETTER: TWO INDEPENDENT LAYERS over sandboxed Bash
    // (this rule and `sandbox.filesystem.denyRead`), rather than one rule doing
    // double duty. THE ASYMMETRY IS THE PART TO REMEMBER: the in-process Read
    // tool has only THIS one — Phase 1 measured `denyRead` alone leaving that
    // tool free — so deleting this line does not leave a second layer behind for
    // the tool most likely to read the suite.
    //
    // THE PAIR IS WHAT WAS MEASURED. `permissions.deny` and
    // `allowManagedPermissionRulesOnly` were always set together in the probe and
    // never separated, so credit belongs to both, not to the deny rule alone. The
    // lock costs the owner nothing today — their `permissions` block is empty,
    // checked rather than assumed — and it is set anyway, because the point is
    // that a rule added to user settings later cannot re-open this.
    managedSettings: {
      permissions: { deny: sealedRoots.map(denyReadRule) },
      allowManagedPermissionRulesOnly: true,
      // THE OWNER'S OWN HOOKS ARE SUPPRESSED FOR A BUILD. A PreToolUse hook
      // returning `permissionDecision: "allow"` pre-empts `canUseTool` outright
      // (sdk.d.ts:4166, verbatim) — proven live on a fixture hook, with the
      // sealed suite's contents coming back in the transcript. Today that bypass
      // is LATENT: every hook installed in ~/.claude/ emits only "deny", and one
      // installed plugin makes it live. Probe C measured that this lock
      // suppresses project- and flag-tier hooks while OUR programmatic
      // `Options.hooks` callback above still fires — which is the only reason
      // the lock is affordable at all.
      //
      // THE COST, RECORDED RATHER THAN GLOSSED: this also disables the owner's
      // secret-guard.sh, which is protective — it hard-blocks writing a live
      // secret key into a file or a command. A build writes only inside its own
      // workspace and is handed no secrets (`subscriptionSubprocessEnv` strips
      // the metered credentials), so the exposure is small. It is NOT zero, and
      // it belongs in dashboard/STATUS.md as well as here.
      allowManagedHooksOnly: true,
      // NO MCP SERVERS. `allowedMcpServers: []` is documented as "no servers are
      // allowed" (sdk.d.ts:5119); the `Only` lock stops user settings re-adding
      // any. MEASURED: zero servers reach a run under this pair, against 13
      // unnarrowed.
      //
      // THIS IS NARROWING, NOT GUARDING, and that is the whole point. The Agent
      // branch was gated on the tool NAME, so a delegation-shaped MCP tool —
      // `railway-agent{isolation:"remote"}` runs the build off this machine
      // entirely — sailed past it. Enumerating such tools is the READ_TOOLS
      // mistake again: the list is never complete. Removing the whole surface is
      // complete by construction. The shape backstop in `decideToolPermission`
      // stays, for a tool that reaches `canUseTool` from somewhere this does not
      // reach.
      //
      // TYPE, CHECKED RATHER THAN ASSUMED: `allowedMcpServers` is
      // `Array<{serverName?, serverCommand?, serverUrl?}>` (sdk.d.ts:5121), NOT
      // `string[]` as the plan's prose said. An empty array satisfies it, so no
      // `deniedMcpServers` fallback is needed here — but anything non-empty must
      // be written as objects, not names.
      //
      // A BUILD KEEPS NONE OF THIS. It writes code in a workspace; it has no
      // business deploying, driving a browser, or spawning a remote agent.
      allowedMcpServers: [],
      allowManagedMcpServersOnly: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: !allowUnsandboxed,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: allowUnsandboxed,
      // `denyRead` is the only layer `canUseTool` cannot substitute for over
      // Bash, because `autoAllowBashIfSandboxed` means a sandboxed command never
      // reaches the callback at all.
      //
      // ENFORCEMENT IS MEASURED, AND MEASURED IN ISOLATION (2026-07-28): with
      // `managedSettings.permissions.deny` EMPTIED, `cat <suite>/…` still came
      // back "Operation not permitted" (seatbelt). So this binds Bash on its own
      // — it is not plumbing for the policy rule, and the two are independent
      // layers over that tool. It does NOT bind the in-process Read tool: Phase 1
      // measured that directly, which is why the policy rule above is not
      // redundant with this one.
      //
      // The plumbing on this side is asserted too: `claude-builder.test.ts` reads
      // these two arrays off the object and requires the canonicalised workspace
      // and the canonicalised sealed roots.
      // `src/builders/settings-plumbing.test.ts` still proves only that an
      // `Options` literal it builds itself round-trips into the `--settings`
      // payload; it never invokes this builder. See dashboard/STATUS.md, "The
      // held-out boundary".
      filesystem: { allowWrite: [workspace], denyRead: sealedRoots },
    },
    // Metered credentials stripped: a build must be subscription traffic or
    // it silently becomes a bill the dashboard reports as costUsd: null.
    env: subscriptionSubprocessEnv(request.env),
    ...(request.effort === null ? {} : { effort: request.effort }),
    ...(request.resumeSessionId === null ? {} : { resume: request.resumeSessionId }),
  };
}

/**
 * Record what the CLI says it loaded, the moment it says it.
 *
 * ITS OWN FUNCTION SO IT CAN BE ASSERTED — and SINCE 2026-07-28 THE CALL SITE IS
 * ASSERTED TOO. This function is unit-tested directly (it captures every
 * category, emits and logs), and the `system/init` branch that calls it is
 * driven with synthetic envelopes through {@link SessionFactory}: see "THE LOOP"
 * tests in claude-builder.test.ts. The residual this docstring used to record —
 * "what it cannot prove is that the loop calls it" — is CLOSED, because deleting
 * this call now turns an assertion red rather than nothing at all. That residual
 * was not hypothetical: the identically-shaped one on `recordResultTokens` was
 * exploited by an auditor with the suite fully green.
 *
 * BOTH THE SINK AND THE LOG, deliberately. The sink is the only route to the run
 * directory, where the record has to survive for the next reader; the log line is
 * what tells the person watching a build that 144 agents and 3 MCP servers just
 * loaded, at the point where that is still actionable.
 */
export function announceEnvironment(init: InitEnvelope, sink: BuildEventSink): RunEnvironment {
  const environment = environmentFromInit(init);
  sink.environment(environment);
  sink.log("info", describeEnvironment(environment));
  return environment;
}

/**
 * The one method of `Query` this file needs to read context usage.
 *
 * A NARROW STRUCTURAL TYPE, not the `Query` interface, so a test can supply a
 * source that answers, throws, or never answers at all — the three behaviours
 * that matter here, none of which a real `Query` can be made to perform on
 * demand without spending subscription quota. A real `Query` satisfies it.
 */
export interface ContextUsageSource {
  getContextUsage(): Promise<ContextUsageEnvelope>;
}

/**
 * How long a context sample may take before it is abandoned.
 *
 * `getContextUsage()` is a CONTROL REQUEST over the CLI's stdio, not a local
 * computation: it is written to the child's stdin and answered by a
 * `control_response` demultiplexed on the SDK's own reader loop. Read from
 * `sdk.mjs` rather than assumed — that reader is independent of the message
 * iterator this builder drains, so awaiting a control response inside the
 * `for await` loop cannot deadlock against it. What it CAN do is never arrive,
 * if the child has wedged or is shutting down, and the message loop would then
 * wait forever on INSTRUMENTATION. Five seconds is far above a healthy
 * round-trip and far below anything a person watching a build would call a stall.
 */
export const CONTEXT_SAMPLE_TIMEOUT_MS = 5_000;

/**
 * Read the context window at a lane boundary, emit it, log it.
 *
 * NEVER THROWS, NEVER STALLS, NEVER FAILS THE BUILD. Same polarity as the
 * environment write: this is the record of the build, not the build, and losing a
 * sample of an otherwise healthy run to a transport error would be the tail
 * wagging the dog. A failure is logged — a missing sample has to be explainable
 * too — and null is returned.
 *
 * The timeout is INJECTED for the same reason `canonicalise` is in
 * {@link decideToolPermission}: the production default would otherwise make the
 * "never answers" test take five seconds, and a slow test is a skipped test.
 */
export async function sampleContextAt(
  boundary: LaneBoundary,
  source: ContextUsageSource,
  sink: BuildEventSink,
  timeoutMs: number = CONTEXT_SAMPLE_TIMEOUT_MS,
): Promise<ContextSample | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The loser of the race is settled but unobserved; `usage` is undefined only
    // on the timeout branch. Without the `catch` on the pending promise, a late
    // rejection after the timer wins is an unhandled rejection, which on Node
    // takes the process down — the build killed by its own instrumentation.
    const pending = source.getContextUsage();
    pending.catch(() => {
      /* observed so a late failure cannot crash the run */
    });
    const usage = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
    if (usage === undefined) {
      sink.log(
        "warn",
        `context usage was not read at ${boundary.agent}: the CLI did not answer within ` +
          `${String(timeoutMs)}ms`,
      );
      return null;
    }
    const sample = contextSample(boundary, usage);
    sink.contextUsage(sample);
    sink.log("info", describeContextSample(sample));
    return sample;
  } catch (error) {
    sink.log(
      "warn",
      `context usage was not read at ${boundary.agent}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Record that the context window was summarised.
 *
 * ITS OWN FUNCTION SO IT CAN BE ASSERTED, exactly like
 * {@link announceEnvironment} — and, since the stream became injectable, its
 * CALL SITE is asserted too: the `compact_boundary` branch is driven with a
 * synthetic envelope in claude-builder.test.ts, so deleting the call turns an
 * assertion red.
 *
 * LOGGED AS A WARNING, not as info. A compaction is not a statistic about a
 * healthy run — it is the single best explanation for a run that produced
 * mediocre output without failing, and the person watching should see it at the
 * level that means "the thing you get back may be worse from here".
 */
export function noteCompaction(
  message: CompactBoundaryEnvelope,
  sink: BuildEventSink,
): CompactionRecord {
  const record = compactionFrom(message);
  sink.compaction(record);
  sink.log("warn", describeCompaction(record));
  return record;
}

/**
 * Add a result frame's spend to the run's running total, emit it, and say so
 * when the CLI contradicts itself.
 *
 * WHICH MODEL SPENT IT IS HALF THE ANSWER, AND `usage` CANNOT GIVE IT. It is
 * four scalars with no model on them, and this build delegates most of its work:
 * a measured Phase 1 run put 76% of its spend on OPUS subagents while the run's
 * `modelId` said `haiku`, and every one of those tokens was reported under the
 * wrong model because the record had nowhere else to put them. `resultTokens`
 * reads the SAME frame's per-model breakdown — the one the CLI sums to produce
 * that scalar — so the total and the attribution come from one place.
 *
 * ITS OWN FUNCTION SO IT CAN BE ASSERTED, and here that is a fix rather than a
 * tidy-up. These five lines were inline in the `result` branch of the loop
 * below, and an audit of commit db015a9 reverted them to
 * `addTokens(tokens, extractTokens(message.usage, message.num_turns))` with the
 * disagreement check deleted: the suite stayed BYTE-IDENTICAL at 200/198/0/2,
 * and only tsc's unused-import check objected. Every assertion about
 * `resultTokens` called it directly in claude-common.test.ts; nothing said the
 * builder still did. The branch is reachable only by spawning a CLI, which costs
 * subscription quota — the same argument as {@link announceEnvironment} and
 * {@link noteCompaction} — so the accumulation moved to where a test can reach
 * it. See "THE RESULT BRANCH'S TOKEN ACCOUNTING" in claude-builder.test.ts,
 * which pins it with a SKEWED frame, the only fixture on which the row-sourced
 * and scalar-sourced answers differ.
 *
 * THE ONE CALL SITE WAS THE RESIDUAL, AND AN AUDITOR TOOK IT. The docstring here
 * used to read "a test can prove this accumulates per model, emits and warns; it
 * cannot prove the loop calls it" — and the mutation that reverted line 1187 to
 * the inlined `addTokens(tokens, extractTokens(message.usage, message.num_turns))`
 * left the suite fully green at 229/227/0/2 against a rebuilt dist, with this
 * function still exported and still tested. Lifting the arithmetic out of the
 * branch made the hole smaller, not absent.
 *
 * IT IS CLOSED NOW BY MAKING THE LOOP ITSELF TESTABLE, not by asserting harder
 * about this function: {@link SessionFactory} injects the message stream, and
 * "THE LOOP" tests in claude-builder.test.ts drive a SKEWED result envelope
 * through `build()` and read the per-model rows off the sink. Under that
 * mutation the sink reports 40,000 input tokens with NO model rows and no
 * disagreement warning, and three assertions go red.
 *
 * IT ADDS, IT DOES NOT REPLACE. A resumed build sees more than one result frame,
 * and `sink.tokens` is documented as CUMULATIVE.
 *
 * THE DISAGREEMENT IS A WARNING, NOT A SILENT CORRECTION: see
 * `usageDisagreement`. It fires only when the CLI's own scalar stops matching
 * its own rows, which on the shipped CLI is never — which is precisely why
 * deleting it was free until now.
 */
export function recordResultTokens(
  running: TokenTotals,
  result: ResultUsageEnvelope,
  sink: BuildEventSink,
): TokenTotals {
  const next = addTokens(running, resultTokens(result));
  sink.tokens(next);
  const disagreement = usageDisagreement(result);
  if (disagreement !== null) sink.log("warn", disagreement);
  return next;
}

/**
 * The message stream a build drains, plus the one control request it makes of
 * it.
 *
 * A NARROW STRUCTURAL TYPE, for the same reason {@link ContextUsageSource} is
 * one: the real `Query` can only be obtained by spawning a CLI, which costs
 * subscription quota, and a loop reachable only that way is a loop nothing
 * executes. `Query` satisfies this by construction — it IS an
 * `AsyncGenerator<SDKMessage, void>` and it does carry `getContextUsage` — so
 * the production path is unchanged and the type is not a parallel definition
 * of it.
 */
export type BuildSession = AsyncIterable<SDKMessage> & ContextUsageSource;

/** How a build obtains its session. `query` is the production value. */
export type SessionFactory = (params: { prompt: string; options: Options }) => BuildSession;

export class ClaudeSubscriptionBuilder implements SubscriptionBuilder {
  readonly provider = "anthropic" as const;

  /**
   * THE MESSAGE LOOP IS INJECTABLE, AND THAT IS A FIX RATHER THAN A TIDY-UP.
   *
   * WHAT WAS MEASURED. Commit b3dcb21 lifted the result branch's arithmetic into
   * {@link recordResultTokens} and tested that function well. An auditor then
   * reverted the CALL SITE — `tokens = recordResultTokens(tokens, message, sink)`
   * back to `addTokens(tokens, extractTokens(message.usage, message.num_turns))`
   * with `sink.tokens(tokens)` — left `recordResultTokens` itself intact and
   * exported, and the suite stayed FULLY GREEN at 229/227/0/2 against a rebuilt
   * dist. The seam had MOVED the hole, not closed it: every property was pinned
   * on a function, and nothing said the loop still called it. That mutation is
   * not academic — a live run carried three per-model rows, so it destroys the
   * per-model attribution of every real build while shipping green.
   *
   * WHY NOT A SOURCE-TEXT ASSERTION. This repo already shipped that: Phase 0.1's
   * "wiring test" matched regexes against this file's source and stayed green
   * while the code under test was DELETED. An AST canary is the same instrument
   * with better parsing — it can prove a call exists, never that the call is the
   * one the SDK's own messages reach. Injecting the stream makes the loop an
   * ORDINARY function of its input: synthetic envelopes go in, sink events come
   * out, and the mutation above turns those assertions red.
   *
   * THE ONE HOLE THIS SEAM CREATES IS PINNED. A default argument can be swapped
   * for a stub, so `claude-builder.test.ts` asserts this field is the SDK's own
   * `query` by IDENTITY on a default-constructed builder. `query` is assigned
   * directly rather than wrapped, precisely so that identity holds.
   */
  readonly startSession: SessionFactory;

  constructor(startSession: SessionFactory = query) {
    this.startSession = startSession;
  }

  async build(request: BuildRequest): Promise<BuildOutcome> {
    const { sink, workspace } = request;
    let tokens = zeroTokens("anthropic");
    let rateLimit: RateLimitState = NOT_RATE_LIMITED;
    let sessionId: string | null = request.resumeSessionId;
    let completed = false;
    let failure: string | null = null;

    const allowUnsandboxed = (request.env[ALLOW_UNSANDBOXED_ENV] ?? "").trim() === "1";
    // THE CANVAS (spec §9.1). Node ids are minted HERE, on the server, and are
    // short (`n1`, `n2`, …) because `redactForPersistence` collapses any 40+ char
    // mixed-case-and-digit token to one identical literal — a canvas keyed on raw
    // `task_id`s would merge two agents into one node with everything still
    // rendering. Every branch below gets ONE call; the transforms live in
    // graph-emit.ts so they are executed by tests rather than reviewed inside a
    // loop that needs a real CLI.
    const graph = new GraphProjection();
    const emitGraph = (events: readonly GraphSseEvent[]): void => {
      for (const event of events) sink.graph(event);
    };
    const options = buildOptions(request, allowUnsandboxed, (observation) => {
      // A HOOK DECISION IS ATTRIBUTED, NOT KNOWN. The hook input carries no task
      // identity at all, so `graph_hook` is always `attribution: "inferred"`.
      emitGraph(
        graph.hookDecision({
          event: "PreToolUse",
          tool: observation.tool,
          decision: observation.decision,
          reason: observation.reason,
        }),
      );
    },
    // PHASE 2a. Every anti-slop fire is logged with rule + agent, so the
    // false-positive rate is measured from real runs rather than guessed
    // (spec §8). An ESCALATION is logged at `warn`: it is the case where the
    // gate gave up and let the write through, and the orchestrator is the one
    // that has to know.
    (observation) => {
      sink.log(
        observation.decision === "escalated" ? "warn" : "info",
        `anti-slop ${observation.layer} gate ${observation.decision}: ${observation.ruleId} ` +
          `(${observation.agent}) — ${observation.evidence}`,
      );
      emitGraph(
        graph.hookDecision({
          event: observation.layer === "write" ? "PreToolUse" : "Stop",
          tool: observation.ruleId,
          decision: observation.decision === "deny" ? "deny" : "allow",
          reason: observation.decision === "deny" ? observation.evidence : "",
        }),
      );
    });
    // WHICH DELEGATED AGENTS ARE IN FLIGHT. Needed because `task_notification` —
    // the message saying an agent finished — does not carry `subagent_type`; only
    // `task_started` does. See build-context.ts.
    const lanes = new LaneWatch();

    const abortController = new AbortController();
    const onAbort = (): void => {
      abortController.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const session = this.startSession({
        prompt: request.prompt,
        options: { ...options, abortController },
      });

      for await (const message of session) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          sink.session(message.session_id);
          sink.log("info", `Claude session ${message.session_id} started in ${workspace}`);
          // THE ENVIRONMENT, RECORDED BEFORE THE FIRST TURN. This message is the
          // CLI's own statement of what `settingSources: ["user"]` discovered,
          // and it is the only statement of it: nothing later in the stream
          // repeats the inventory, so a capture missed here is a run whose
          // largest input is unrecoverable afterwards.
          // THE INVENTORY, AND THE RUN'S OWN NODE. One call, and it is the only
          // statement of the environment the stream ever makes.
          emitGraph(graph.session(announceEnvironment(message, sink), request.allowedAgents));
          continue;
        }

        // THE CONTEXT TIMELINE. Three branches, one call each. What they call is
        // unit-tested in build-context.test.ts and claude-builder.test.ts, and
        // THESE BRANCHES ARE DRIVEN with synthetic envelopes through
        // `startSession` — a real CLI costs subscription quota, an injected
        // stream costs nothing and reaches the same code.
        if (message.type === "system" && message.subtype === "task_started") {
          lanes.started(message);
          // A NODE IS MINTED EVEN WITHOUT `subagent_type`, where `LaneWatch`
          // above skips. The two answer different questions: a LANE would be a
          // guess, a NODE ID invents nothing.
          emitGraph(graph.taskStarted(message));
          continue;
        }

        if (message.type === "system" && message.subtype === "task_notification") {
          emitGraph(graph.taskFinished(message));
          // Null unless this completion left the agent's lane with nothing
          // running — see LaneWatch for what "a lane went quiet" can and cannot
          // mean when nothing says how many agents a lane will run.
          const boundary = lanes.closed(message);
          if (boundary !== null) await sampleContextAt(boundary, session, sink);
          continue;
        }

        if (message.type === "system" && message.subtype === "compact_boundary") {
          // SAID ONCE, IN THE STREAM. Miss it and the best explanation for a
          // mediocre run is gone; there is no later message that repeats it.
          noteCompaction(message, sink);
          continue;
        }

        if (message.type === "assistant") {
          const text = assistantText(message);
          if (text.trim().length > 0) {
            sink.raw(`\n[assistant]\n${text}\n`);
            sink.log("info", truncate(text, 500));
          }
          const uses = toolUses(message);
          for (const use of uses) {
            sink.tool(use.name, summariseToolInput(use.input));
          }
          // ATTRIBUTED THROUGH `parent_tool_use_id`, WHICH IS THE ONLY IDENTITY
          // AN ASSISTANT TURN CARRIES — there is no `task_id` on it. Null means
          // the orchestrator's own turn and is EXACT; an id we never saw is a
          // guess and says so.
          emitGraph(graph.assistant(message, uses));
          continue;
        }

        if (message.type === "rate_limit_event") {
          rateLimit = rateLimitFrom(message.rate_limit_info);
          sink.rateLimit(rateLimit);
          continue;
        }

        if (message.type === "result") {
          // ONE CALL, AND THIS LINE IS THE ONE AN AUDITOR REVERTED WITH THE SUITE
          // FULLY GREEN. Replacing it with
          // `addTokens(tokens, extractTokens(message.usage, message.num_turns))`
          // destroys per-model attribution on every real run — a live run carried
          // three model rows — and cost nothing until the stream became
          // injectable. It is now covered by "THE LOOP" tests, which drive a
          // skewed result envelope through `build()` and read the sink.
          tokens = recordResultTokens(tokens, message, sink);
          if (message.subtype === "success") {
            completed = true;
            sink.raw(`\n[result] success after ${String(message.num_turns)} turn(s)\n`);
          } else {
            failure = `${message.subtype}: ${resultErrorText(message)}`;
            sink.log("warn", `build ended: ${failure}`);
            sink.raw(`\n[result] ${failure}\n`);
          }
          continue;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request.signal.aborted) {
        return { sessionId, tokens, rateLimit, completed: false, cancelled: true, failure: null };
      }
      if (/rate.?limit|usage limit|429/i.test(message)) {
        rateLimit = { limited: true, retryAfterSec: null, kind: null, utilization: null };
        sink.rateLimit(rateLimit);
      }
      failure = describeFailure(message, allowUnsandboxed);
      sink.log("error", failure);
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }

    return {
      sessionId,
      tokens,
      rateLimit,
      completed,
      cancelled: request.signal.aborted,
      failure,
    };
  }
}

function describeFailure(message: string, allowUnsandboxed: boolean): string {
  if (!allowUnsandboxed && /sandbox/i.test(message)) {
    return (
      `the Claude CLI sandbox could not start: ${truncate(message, 400)}. ` +
      `The build was stopped rather than run unsandboxed with write access to the whole home ` +
      `directory. To accept that risk deliberately, set ${ALLOW_UNSANDBOXED_ENV}=1 and restart the ` +
      `dashboard.`
    );
  }
  return truncate(message, 600);
}

/** Tokens for a build that never started. Keeps the caller's arithmetic total. */
export function noBuildTokens(): TokenTotals {
  return zeroTokens("anthropic");
}
