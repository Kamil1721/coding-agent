/**
 * builders/delegation-hook.ts — the delegation guard, and the slot the engine
 * actually asks.
 *
 * WHY THIS FILE IS THE WHOLE GUARD AND `canUseTool` IS NONE OF IT. Probe A
 * measured the permission callback across `acceptEdits`, `default` AND
 * `dontAsk`. In every arm the callback returned `{behavior:"deny"}` for the
 * delegation, was consulted for NO TOOL AT ALL, and `wordpress-master` started
 * anyway. An apparatus control in the same option shape had `canUseTool` fire
 * normally for `Write`, so "the callback is not wired" is ruled out. There is no
 * permission mode that fixes it. The SDK points here itself: `sdk.mjs`'s
 * shadow-warning text reads "To gate every tool call, use a PreToolUse hook
 * instead."
 *
 * WHAT IS MEASURED ABOUT THE REPLACEMENT, so the next reader does not re-derive
 * it (probe E, four live sessions; probe F and its audit):
 *
 *   hook fires   `tool_name: "Agent"`, `tool_input.subagent_type` present
 *   deny works   no `task_started`, `SubagentStart` never fired, no agentId
 *                minted, no tokens billed (the allow control billed 20639), and
 *                NOT ONE `background_tasks_changed` envelope — the background
 *                task never came into existence
 *   every state  `run_in_background` false, true AND ABSENT (the production
 *                default) are all gated; absent was the untested dangerous one
 *   isolation    `worktree` gated against a real git-repo fixture, so a worktree
 *                failure could not be mistaken for a hook effect
 *   selectivity  ONE no-matcher slot allowed `code-reviewer` (it ran, 13842
 *                tokens) and denied `wordpress-master` in the SAME session
 *   under lock   survives `managedSettings.allowManagedHooksOnly: true`
 *
 * RESIDUAL, RECORDED RATHER THAN LAUNDERED: `isolation: "remote"` is
 * availability-gated and off-host, so it is denied by construction and not by
 * measurement; `allowManagedHooksOnly` composed with the background/absent arms
 * is an inference from the lock gating WHETHER programmatic hooks run at all,
 * not per-tool shape; permission modes other than `acceptEdits` are untested.
 */

import type {
  HookCallbackMatcher,
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * A tool call is DELEGATION-SHAPED when it carries a field that names a target
 * OUTSIDE this run, WHATEVER THE TOOL IS CALLED.
 *
 * NO TOOL NAME IS CONSULTED, and that is not stylistic:
 *
 *   - `toolName === "Agent"` was the whole gate until 2026-07-28, and
 *     `mcp__plugin_railway_railway__railway-agent` matched none of it while
 *     carrying `isolation: "remote"`, which runs the build off this machine
 *     entirely — outside every boundary protecting the sealed suite.
 *   - probe E measured the SAME call arriving as `tool_name: "Agent"` at the
 *     hook and reported as `"Task"` in `permission_denials`. A name test is
 *     wrong roughly half the time even for the built-in tool.
 *
 * `run_in_background` WAS A THIRD FIELD HERE AND WAS REMOVED IN TASK 2. The
 * provenance matters, because re-adding it looks like tightening and is not.
 * The predicate was written for `decideToolPermission`, where `Bash` NEVER
 * ARRIVES: `autoAllowBashIfSandboxed: true` means a sandboxed command is never
 * routed through `canUseTool`. The `PreToolUse` slot below fires for EVERY tool,
 * Bash included (measured), and `run_in_background` is not an Agent-only field —
 * `BashInput:548` carries it too, where it DEFAULTS TO FALSE and means nothing
 * about delegation. Keeping it here denied `Bash{command:"npm run dev",
 * run_in_background:true}` with a reason reading "It defaults to true", which is
 * FALSE for Bash and reaches the model verbatim. The field stays in the DECISION
 * — an Agent call must still set it to `false` — and leaves the ROUTER.
 *
 * Both measured fail-opens still close without it, which is what makes the
 * narrowing safe rather than convenient: `railway-agent{isolation:"remote"}` is
 * caught by the `isolation` half, and the bare schema-valid
 * `Agent{description, prompt}` is caught by the hook's NAME half and then denied
 * on `run_in_background !== false`.
 *
 * PRESENT-BUT-MALFORMED MUST BE JUDGED, so this is an `in` test and not a
 * truthiness test: `{subagent_type: null}` is malformed rather than absent, and
 * `{isolation: undefined}` still has to reach a decision.
 *
 * TOP LEVEL ONLY, which is where the Agent tool's own schema puts these fields
 * (`AgentInput`, sdk-tools.d.ts). A `content` blob that mentions `subagent_type`
 * one level down is an ordinary write: denying it would cost legitimate work and
 * protect nothing, because the nested value is not what the engine acts on.
 *
 * THIS PREDICATE ANSWERS "SHOULD THIS BE JUDGED?", NEVER "IS THIS ALLOWED?".
 * Everything it returns true for goes on to a decision that can still deny. It
 * is a router, and it is deliberately not a boundary on its own.
 */
export function isDelegationShaped(input: Record<string, unknown>): boolean {
  return "subagent_type" in input || "isolation" in input;
}

/** Allowed, or denied with a reason the MODEL reads verbatim. */
export type DelegationDecision = { allow: true } | { allow: false; reason: string };

/**
 * The three delegation guards, as a pure synchronous function — no filesystem,
 * no tool name, no `PermissionResult`.
 *
 * THESE THREE WERE CORRECT AND NEVER CONSULTED. They lived in the Agent branch
 * of `decideToolPermission` from Phase 0 until Task 2, and probe A measured that
 * `canUseTool` is asked for no tool at all when the model delegates. All three
 * were vacuous in production while `claude-builder.ts`'s header described them
 * as an enforced boundary. They are moved here UNCHANGED IN SUBSTANCE, including
 * their order and their exact wording: two of the three reasons are pinned by
 * tests that assert WHICH guard denied, and rewriting them would quietly turn
 * those assertions into assertions about nothing.
 *
 * NO TOOL NAME IS A PARAMETER, deliberately. The same denied call is "Agent" at
 * the hook and "Task" in `permission_denials`, so a name is wrong roughly half
 * the time; there is nowhere in this signature to put one.
 *
 * ABSENT `subagent_type` DENIES; IT DOES NOT ABSTAIN. It is OPTIONAL in the
 * SDK's own `AgentInput` (sdk-tools.d.ts:496), so a schema-valid call can omit
 * it — and `run_in_background` then defaults to BACKGROUND. Treating absence as
 * "not my business" is the READ_TOOLS fail-open on a third axis.
 *
 * THE REASON IS MODEL INPUT, not an internal code. A PreToolUse deny delivers
 * `permissionDecisionReason` verbatim as an `is_error` tool_result, so each of
 * these says what to do instead and the shortlist one names the agents that ARE
 * permitted.
 */
export function decideDelegation(
  toolInput: Record<string, unknown>,
  allowedAgents: readonly string[],
): DelegationDecision {
  if ("isolation" in toolInput && toolInput["isolation"] !== undefined) {
    return {
      allow: false,
      reason:
        "This run does not permit `isolation`. A worktree writes outside the run's workspace and " +
        "`remote` runs the build off this machine, outside every boundary protecting the sealed " +
        "acceptance suite. Delegate in-place instead.",
    };
  }
  if (toolInput["run_in_background"] !== false) {
    return {
      allow: false,
      reason:
        "Set `run_in_background: false`. It defaults to true, and a background subagent keeps " +
        "writing the workspace after this phase returns — the gate would then score a moving " +
        "artefact and the result would depend on timing.",
    };
  }
  const requested = toolInput["subagent_type"];
  if (typeof requested !== "string" || !allowedAgents.includes(requested)) {
    return {
      allow: false,
      reason:
        `\`${String(requested)}\` is not available to this run. Delegate to one of: ` +
        `${allowedAgents.join(", ") || "(none configured)"}.`,
    };
  }
  return { allow: true };
}

/** The built-in delegation tool, under both of the names it answers to. */
const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * The delegation guard, as the `PreToolUse` slot the engine actually asks.
 *
 * ONE SLOT, `matcher` OMITTED. Probe E registered three slots and all three
 * fired for the same `tool_use_id`, so which one carried the decision went
 * unmeasured — and a `matcher: "Task"` slot fired for a call whose `tool_name`
 * was "Agent", which plain name-matching does not explain. A no-matcher slot
 * needs no assumption about how names resolve, and probe F Gap 3 confirmed it
 * suffices alone.
 *
 * THIS SLOT FIRES FOR EVERY TOOL, BASH INCLUDED — measured. Anything that is not
 * a delegation MUST come back `{continue: true}`, or the guard stops being a
 * delegation boundary and becomes a session that cannot do anything. That
 * failure would not read as a security regression; it would read as a broken
 * builder, which is how it would be "fixed".
 *
 * NAME **OR** SHAPE, AND EACH ALONE IS FAIL-OPEN — measured in both directions
 * against dist:
 *
 *   NAME alone   `mcp__plugin_railway_railway__railway-agent{isolation:
 *                "remote"}` matches no name we gate on and returned ALLOW. That
 *                is the READ_TOOLS mistake: an allowlist is open to every tool
 *                nobody enumerated.
 *   SHAPE alone  `subagent_type` is OPTIONAL in `AgentInput`
 *                (sdk-tools.d.ts:496), so the schema-valid bare
 *                `Agent{description, prompt}` carries none of the routed fields
 *                — and `run_in_background` then defaults to BACKGROUND. Under a
 *                pure shape test it returned ALLOW.
 *
 * THE NAMES ROUTE; THEY NEVER DECIDE. `decideDelegation` takes no tool name at
 * all, because the SAME denied call arrives as `tool_name: "Agent"` at this hook
 * and is reported as `"Task"` in `permission_denials`. Either name alone is
 * wrong about half the time, so the decision reads `subagent_type` instead.
 *
 * NO `continue: false` ON THE DENY. What probe E measured is the bare
 * `hookSpecificOutput` shape; `continue: false` is a different instruction (stop
 * the turn, with a `stopReason`) and was not what was measured. Ship the
 * measured shape.
 */
export function makeDelegationHook(allowedAgents: readonly string[]): HookCallbackMatcher {
  return {
    hooks: [
      // ANNOTATED WITH THE SDK'S OWN `SyncHookJSONOutput`, not with a loose
      // record. `hookSpecificOutput` is a union of per-event shapes, so a
      // misspelt `permissionDecision` is a COMPILE error here rather than a hook
      // that returns cheerfully and denies nothing — which is precisely the
      // failure mode this task exists to remove, one layer down.
      async (input): Promise<SyncHookJSONOutput> => {
        const preToolUse = input as PreToolUseHookInput;
        const toolInput = preToolUse.tool_input;
        // A tool input that is not an object cannot be a delegation and must not
        // throw: a hook that throws is an unhandled rejection on the SDK's own
        // reader loop, which takes the whole run down.
        if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
          return { continue: true };
        }
        const shaped = toolInput as Record<string, unknown>;
        if (!DELEGATION_TOOL_NAMES.has(preToolUse.tool_name) && !isDelegationShaped(shaped)) {
          return { continue: true };
        }
        const decision = decideDelegation(shaped, allowedAgents);
        if (decision.allow) return { continue: true };
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
        };
      },
    ],
  };
}
