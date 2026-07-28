/**
 * builders/delegation-hook.ts — what makes a tool call a DELEGATION.
 *
 * ONE DEFINITION, TWO CALLERS, AND THAT IS WHY IT LIVES IN ITS OWN MODULE. The
 * predicate below is the backstop inside `decideToolPermission` today (Phase 1.1
 * Task 3) and is the gate of the `PreToolUse` delegation hook when Task 2 lands.
 * Two copies of a predicate this load-bearing would drift, and the copy that
 * drifted would be the one nothing exercised.
 *
 * TASK 3 SHIPS THIS FILE WITH THE PREDICATE ALONE. `decideDelegation` and
 * `makeDelegationHook` belong to Task 2, which is blocked on a probe that is
 * still running. An empty shell exported early would read as a boundary and be
 * none — the exact defect this phase exists to remove.
 */

/**
 * A tool call is DELEGATION-SHAPED when it carries a field that steps outside
 * this run's boundaries, WHATEVER THE TOOL IS CALLED.
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
 * ALL THREE FIELDS, NOT JUST `subagent_type`. Gating on the agent name alone
 * waves through a call carrying only `isolation` or only `run_in_background` —
 * the same fail-open shape as the deleted READ_TOOLS name allowlist and the
 * path-KEY allowlist that replaced it. PRESENT-BUT-MALFORMED MUST BE JUDGED, so
 * this is an `in` test and not a truthiness test: `{run_in_background: false}`
 * is the safe value and still has to reach the decision, and
 * `{subagent_type: null}` is malformed rather than absent.
 *
 * TOP LEVEL ONLY, which is where the Agent tool's own schema puts these three
 * (`AgentInput`, sdk-tools.d.ts). A `content` blob that mentions `subagent_type`
 * one level down is an ordinary write: denying it would cost legitimate work and
 * protect nothing, because the nested value is not what the engine acts on.
 *
 * THIS PREDICATE ANSWERS "SHOULD THIS BE JUDGED?", NEVER "IS THIS ALLOWED?".
 * Everything it returns true for goes on to a decision that can still deny; what
 * it returns false for is judged by the rest of the caller's rules, not waved
 * through. It is a router, and it is deliberately not a boundary on its own.
 */
export function isDelegationShaped(input: Record<string, unknown>): boolean {
  return "subagent_type" in input || "isolation" in input || "run_in_background" in input;
}
