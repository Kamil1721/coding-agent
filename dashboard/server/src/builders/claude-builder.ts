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
 *   - `canUseTool` answers every permission request itself, so nothing can
 *     park waiting for a human who is not there. It also denies writes whose
 *     resolved path escapes the workspace — a second, independent check, since
 *     a defence that exists in one layer only is a defence that has never been
 *     tested.
 *   - The acceptance suite lives OUTSIDE the workspace (dashboard/acceptance),
 *     is never mounted into it, and the held-out half is never copied in.
 *
 * THE HELD-OUT SUITE IS ALSO DENIED FOR READING, added by the integrator on
 * 2026-07-27 after auditing this file. Until then the suite was protected
 * against being WRITTEN and not against being READ, and it sits on the host
 * filesystem two directories above the workspace. A builder that reads the
 * held-out tests can satisfy them without satisfying the ticket, which makes
 * `heldOutPass` and `falseFinish` meaningless for that run, and there is no
 * detector for it. Two layers now:
 *
 *   1. {@link decideToolPermission} denies ANY tool — built-in, `mcp__*`, or
 *      one that ships next year — carrying a path that resolves into the suite
 *      store. It was a tool-name allowlist until 2026-07-28, then briefly a
 *      KEY allowlist — the same fail-open shape on another axis, and it was
 *      defeated by `Glob`'s required `pattern` argument. Every value is now
 *      scanned except named free text; see FREE_TEXT_KEYS below.
 *      EXECUTED: unit-tested directly, with a negative control.
 *   2. `sandbox.filesystem.denyRead` names the suite store to the CLI's own OS
 *      sandbox, which is the only layer that can cover Bash. PLUMBING EXECUTED
 *      (the value reaches the CLI's `--settings`); ENFORCEMENT NOT EXERCISED —
 *      proving it needs a real build, which costs quota.
 *
 * This is still weaker than the bake-off's boundary, which is a container the
 * held-out half is never mounted into. Said plainly in dashboard/STATUS.md.
 *
 * THE SDK'S `total_cost_usd` IS NOT READ. See claude-common.ts.
 */

import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  NOT_RATE_LIMITED,
  assistantText,
  extractTokens,
  rateLimitFrom,
  resultErrorText,
  summariseToolInput,
  toolUses,
  truncate,
} from "../claude-common.js";
import type { RateLimitState } from "../claude-common.js";
import { subscriptionSubprocessEnv } from "../subprocess-env.js";
import { addTokens, zeroTokens } from "../tokens.js";
import type { TokenTotals } from "../tokens.js";
import type { BuildOutcome, BuildRequest, SubscriptionBuilder } from "./types.js";

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
 *
 * `new_source` is NotebookEdit's write PAYLOAD — cell code, which routinely
 * contains `../` inside a string literal. `resolve()` collapses `..` anywhere
 * in a string, not only at its start, so scanning this key denied a legitimate
 * cell edit with the workspace-write message; that was demonstrated red before
 * it was added here. Being a write payload it cannot enable a sealed READ.
 */
const FREE_TEXT_KEYS = new Set([
  "content", "new_string", "old_string", "command", "prompt",
  "description", "instructions", "code", "script", "body", "message", "text",
  "new_source",
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

function insideDir(dir: string, candidate: string, base: string): boolean {
  const root = resolve(dir);
  const target = resolve(base, candidate);
  return target === root || target.startsWith(`${root}/`);
}

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

function insideWorkspace(workspace: string, candidate: string): boolean {
  return insideDir(workspace, candidate, resolve(workspace));
}

/**
 * The permission decision, as a pure function, so it can be exercised without
 * spawning a CLI. `claude-builder.test.ts` calls it directly.
 *
 * Relative paths are resolved against the workspace, which is the builder's
 * `cwd` — the same resolution the CLI performs.
 */
export function decideToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
  sealedRoots: readonly string[],
  allowedAgents: readonly string[] = [],
): PermissionResult {
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

  const candidates = pathCandidates(input);
  // A recursive tool searches its cwd IN ADDITION to any path it names. Phase 0
  // folded cwd in only when no candidate was found, so a stray `glob` key
  // switched the fold off and the guard judged the wrong target affirmatively.
  if (RECURSIVE_TOOLS.has(toolName)) candidates.push(workspace);
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
  // Everything else is allowed WITHOUT asking, because there is nobody to ask:
  // an unanswered permission prompt has no park deadline and would hang the run
  // forever.
  return { behavior: "allow" };
}

export class ClaudeSubscriptionBuilder implements SubscriptionBuilder {
  readonly provider = "anthropic" as const;

  async build(request: BuildRequest): Promise<BuildOutcome> {
    const { sink, workspace } = request;
    let tokens = zeroTokens("anthropic");
    let rateLimit: RateLimitState = NOT_RATE_LIMITED;
    let sessionId: string | null = request.resumeSessionId;
    let completed = false;
    let failure: string | null = null;

    const allowUnsandboxed = (request.env[ALLOW_UNSANDBOXED_ENV] ?? "").trim() === "1";

    const sealedRoots = request.sealedRoots.map((root) => resolve(root));

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> =>
      decideToolPermission(toolName, input, workspace, sealedRoots);

    const options: Options = {
      cwd: workspace,
      model: request.modelId,
      maxTurns: DEFAULT_MAX_TURNS,
      permissionMode: "acceptEdits",
      canUseTool,
      includePartialMessages: false,
      // The builder gets the full Claude Code tool set: it is building software.
      tools: { type: "preset", preset: "claude_code" },
      // The owner's global CLAUDE.md, settings and plugins are NOT loaded. The
      // ticket brief is the specification; anything else is an uncontrolled
      // input that changes what was built without appearing in the ticket.
      settingSources: [],
      sandbox: {
        enabled: true,
        failIfUnavailable: !allowUnsandboxed,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: allowUnsandboxed,
        // `denyRead` is the ONLY layer that covers Bash, because
        // `autoAllowBashIfSandboxed` means a sandboxed command never reaches
        // `canUseTool`. It is enforced by the CLI's own OS sandbox, and THAT
        // ENFORCEMENT HAS NOT BEEN EXERCISED HERE — running a build to prove it
        // costs subscription quota. What has been executed is that this value
        // reaches the CLI: `test/settings-plumbing.mjs` runs the SDK against a
        // stub executable and asserts the acceptance root appears in the
        // `--settings` payload. See dashboard/STATUS.md, "The held-out boundary".
        filesystem: { allowWrite: [workspace], denyRead: sealedRoots },
      },
      // Metered credentials stripped: a build must be subscription traffic or
      // it silently becomes a bill the dashboard reports as costUsd: null.
      env: subscriptionSubprocessEnv(request.env),
      ...(request.effort === null ? {} : { effort: request.effort }),
      ...(request.resumeSessionId === null ? {} : { resume: request.resumeSessionId }),
    };

    const abortController = new AbortController();
    const onAbort = (): void => {
      abortController.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const session = query({
        prompt: request.prompt,
        options: { ...options, abortController },
      });

      for await (const message of session as AsyncIterable<SDKMessage>) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          sink.session(message.session_id);
          sink.log("info", `Claude session ${message.session_id} started in ${workspace}`);
          continue;
        }

        if (message.type === "assistant") {
          const text = assistantText(message);
          if (text.trim().length > 0) {
            sink.raw(`\n[assistant]\n${text}\n`);
            sink.log("info", truncate(text, 500));
          }
          for (const use of toolUses(message)) {
            sink.tool(use.name, summariseToolInput(use.input));
          }
          continue;
        }

        if (message.type === "rate_limit_event") {
          rateLimit = rateLimitFrom(message.rate_limit_info);
          sink.rateLimit(rateLimit);
          continue;
        }

        if (message.type === "result") {
          tokens = addTokens(tokens, extractTokens(message.usage, message.num_turns));
          sink.tokens(tokens);
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
