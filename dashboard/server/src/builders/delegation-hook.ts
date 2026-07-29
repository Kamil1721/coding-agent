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
 * WHAT THE SHORTLIST NEVER BOUNDED, AND NOW DOES NOT HAVE TO (probe H,
 * 2026-07-28). The hook fires for `SendMessage` too — `tool_name:
 * "SendMessage"`, `tool_input` keys `to, summary, message, type, recipient,
 * content`, `subagent_type` ABSENT in all four arms — so the guard waved it
 * through by construction, and in the SAME session that denied a
 * `wordpress-master` spawn it resumed `code-reviewer` with a second
 * `task_started` and a `SubagentStart` the guard never saw. The shortlist bounds
 * WHICH AGENTS EXIST, not HOW MUCH WORK THEY RECEIVE. `isAgentMessage` denies
 * that call outright; see it for why outright is the best a PreToolUse hook can
 * do.
 *
 * RESIDUAL, RECORDED RATHER THAN LAUNDERED. Two of the three are still open and
 * both need a live session with a real model, which is a different thing from
 * "untestable" — say which:
 *
 *   `isolation: "remote"`   availability-gated and off-host, so it is denied by
 *                           construction and not by measurement. There is no
 *                           apparatus on this machine to observe it with, so this
 *                           one is genuinely not runnable here. `worktree` IS
 *                           measured, against a real git-repo fixture.
 *   `allowManagedHooksOnly` composed with the background / absent-flag /
 *                           selective-policy arms. Probe E measured the lock for
 *                           FOREGROUND delegation only; composing them is an
 *                           inference from the lock gating WHETHER programmatic
 *                           hooks run at all rather than per-tool shape. THIS ONE
 *                           IS RUNNABLE — it wants a live metered session and
 *                           nobody has been authorised to spend one on it.
 *
 * THE THIRD IS CLOSED, 2026-07-30, and closed by removing its reach rather than
 * by measuring it. It used to read "permission modes other than `acceptEdits` are
 * untested". `buildOptions` sets `permissionMode: "acceptEdits"` as a literal that
 * takes nothing from `BuildRequest` and nothing from the environment, and
 * `build()` hands the SDK `{ ...options, abortController }` — so no build under
 * any other mode is reachable from this program. Pinned, with both mutations run,
 * by "WIRING: permissionMode is acceptEdits and nothing parameterises it" in
 * `claude-builder.test.ts`; read that test's docblock for the one channel it does
 * NOT close (`Settings.permissions.defaultMode`, under the `settingSources:
 * ["user"]` this builder sets) and for the free measurement that would.
 *
 * SEPARATELY, AND NOT A RESIDUAL OF THIS FILE: read every deny above as TWO
 * demonstrated channels going silent, not three. `startedFor()` watches three
 * start-observables and the third never went positive for ANY subagent in ANY arm,
 * because every one of them ran with `tool_uses: 0` — so it never fired even for
 * children that demonstrably started. That is a how-to-read qualifier on the
 * evidence, not an unmeasured mechanism.
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

/**
 * A tool call RESUMES AN AGENT when it names a target and carries a body for it.
 *
 * WHY THIS EXISTS, MEASURED (probe H, four arms of one live session). The
 * PreToolUse slot DOES fire for `SendMessage`, with `tool_name: "SendMessage"`
 * and `tool_input` keys `to`, `summary`, `message`, `type`, `recipient`,
 * `content` — all strings, and `subagent_type` ABSENT in every firing. The guard
 * above routes on the Agent/Task names or on delegation SHAPE, so `SendMessage`
 * came back `{continue: true}` BY CONSTRUCTION: nothing in it looked like a
 * delegation, because starting an agent and feeding one are different calls.
 *
 * WHAT IT COST, with the guard armed: in the SAME session that denied a
 * `wordpress-master` spawn, `SendMessage` resumed `code-reviewer` and produced a
 * SECOND `task_started` plus a `SubagentStart` carrying orchestrator instructions
 * the guard never saw. THE SHORTLIST BOUNDS WHICH AGENTS EXIST, NOT HOW MUCH WORK
 * THEY RECEIVE — and the work is where the tokens, the turns and the workspace
 * writes are.
 *
 * NAME **OR** SHAPE, and the name half is usable HERE in a way it is not for
 * delegation: `SendMessage` reported the SAME literal name on both surfaces (the
 * hook input and the transcript), whereas the same delegation is `Agent` at the
 * hook and `Task` in `permission_denials`. The shape half exists because a name
 * allowlist is fail-open to every tool nobody enumerated — the READ_TOOLS mistake
 * this codebase has already paid for twice.
 *
 * THE SHAPE IS A SUBSET TEST, NOT A KEY-SET EQUALITY, and that is measured
 * rather than stylistic: `tool_input` arrives with CLI-ADDED keys —
 * `type`/`recipient`/`content` come from `backfillObservableInput`, which mutates
 * the input in place — so "exactly the three schema keys" would have been green
 * in a test and open in production. `to` is required in the conjunction because
 * a body alone is every `Write` the build makes.
 *
 * AN UNMEASURED OVER-DENY RIDES ON THAT, AND IT IS RECORDED RATHER THAN LEFT TO
 * BE REDISCOVERED BY A BROKEN BUILD. `backfillObservableInput` was observed
 * adding `content` for THIS tool; WHICH OTHER TOOLS IT BACKFILLS IS UNMEASURED.
 * If it attaches `content` more widely, a tool whose real schema is just
 * `{from, to}` — a move or copy — would arrive carrying a body and be denied
 * here. The unit tests pass RAW inputs, so they cannot see it. It fails in the
 * safe direction and the denial text names itself in the transcript, so it is
 * left as is; if a build is ever denied a move, this paragraph is the reason and
 * the fix is to require a body key the backfill does not add.
 *
 * A DELEGATION IS NOT A MESSAGE. `Agent{subagent_type, prompt}` carries no `to`,
 * so it falls through to `decideDelegation`, which can still ALLOW a shortlisted
 * agent. Swallowing it here would close delegation outright.
 *
 * `input` IS `unknown`, AND THE NARROWING HAPPENS HERE. It took `Record<string,
 * unknown>` for one commit, which forced the call below the hook's "not an
 * object" early return — and that return is `{continue: true}`, so `SendMessage`
 * with a null, string or array `tool_input` was WAVED THROUGH while three
 * comments and a test title said "denied outright". Measured against dist. The
 * NAME half needs no input at all; making the parameter `unknown` is what lets it
 * be judged before the input is, while keeping the `in` operator from throwing —
 * a hook that throws is an unhandled rejection on the SDK's own reader loop and
 * takes the whole run down.
 */
export function isAgentMessage(toolName: string, input: unknown): boolean {
  if (AGENT_MESSAGE_TOOL_NAMES.has(toolName)) return true;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const shaped = input as Record<string, unknown>;
  if (!("to" in shaped)) return false;
  return "message" in shaped || "content" in shaped || "summary" in shaped;
}

/** The agent-messaging tool, under the one name it was MEASURED to report. */
const AGENT_MESSAGE_TOOL_NAMES: ReadonlySet<string> = new Set(["SendMessage"]);

/**
 * Why a resume is denied, in the words the model reads.
 *
 * FAIL-CLOSED BEATS A GUARD THAT CANNOT SEE WHAT IT IS GUARDING. There is no
 * narrower rule available to a PreToolUse hook: validating a resume means
 * checking the target agentId against the ones this run started, and the agentId
 * appears ONLY in the Agent tool's RESULT, which PreToolUse never sees. A hook
 * that inspected `to` would be judging a display name against nothing — the
 * shape of check this phase exists to delete, not to add.
 *
 * The cost is real and small: the orchestrator delegates with Agent and never
 * needs to resume, because everything a subagent needs belongs in that call's own
 * prompt. A build that wants more from an agent starts another one.
 *
 * THE BUILDER PROMPT DELIBERATELY DOES NOT MENTION THIS TOOL, and that is a
 * decision rather than an omission. build-prompt.ts's own test-enforced rule is
 * NEVER NAME A FORBIDDEN CAPABILITY — naming one is how a model learns it exists
 * (the same argument that keeps `isolation` out of the prompt, with a test
 * asserting the word is absent). The remediation rides on THIS string instead: a
 * PreToolUse deny delivers `permissionDecisionReason` verbatim as an `is_error`
 * tool_result, so a model that reaches for the tool anyway — as one did in probe
 * H — is told what to do instead at the moment it matters, and the prompt already
 * says a denial is permanent and not worth retrying.
 */
export const AGENT_MESSAGE_DENIAL =
  "`SendMessage` is not available to this run: it resumes an agent that is already " +
  "running and hands it work no boundary here can see. Start a fresh delegation with the " +
  "Agent tool instead, and put everything the agent needs in that call's own prompt.";

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
/**
 * What the canvas is told about a decision this hook made.
 *
 * DECISIONS, NOT FIRINGS, and the difference is the whole design. The slot fires
 * for EVERY tool call, Bash included (measured) — reporting each
 * `{continue:true}` pass-through would double the run's event volume to say
 * nothing, so the observer is called only where this hook actually decided
 * something.
 */
export interface DelegationObservation {
  readonly tool: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

/**
 * A caller that wants to WATCH the guard. Optional, and strictly a bystander.
 *
 * IT NEVER PARTICIPATES IN THE DECISION. It is invoked AFTER the decision is
 * computed and its return value is discarded, so no observer can widen, narrow
 * or reword a denial — the exact denial strings are pinned by tests and reach
 * the model verbatim as an `is_error` tool_result. Every call is wrapped in a
 * try/catch by {@link makeDelegationHook}, because a hook that throws is an
 * unhandled rejection on the SDK's own reader loop and takes the whole run down;
 * instrumentation must never be able to do that.
 */
export type DelegationObserver = (observation: DelegationObservation) => void;

export function makeDelegationHook(
  allowedAgents: readonly string[],
  observe: DelegationObserver | null = null,
): HookCallbackMatcher {
  /** Never throws, never returns a value the decision depends on. */
  const note = (observation: DelegationObservation): void => {
    if (observe === null) return;
    try {
      observe(observation);
    } catch {
      /* the record of the guard is not the guard */
    }
  };
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
        // RESUMING AN AGENT IS JUDGED FIRST, AND ABOVE THE MALFORMED-INPUT
        // RETURN. That return is `{continue: true}`, and it sat above this call
        // for one commit: `SendMessage` with a null, string or array `tool_input`
        // was waved through while the title said "denied outright". The NAME half
        // of this predicate needs no input at all, so nothing is gained by
        // waiting for the input to be well formed — and `isAgentMessage` takes
        // `unknown` precisely so it can be asked here without throwing.
        //
        // IT IS ALSO ABOVE THE DELEGATION DECISION, and that order is
        // load-bearing too: `SendMessage` carries no `run_in_background`, so
        // falling through to `decideDelegation` would deny it with "Set
        // `run_in_background: false`. It defaults to true" — false for this tool,
        // and delivered to the model verbatim.
        if (isAgentMessage(preToolUse.tool_name, toolInput)) {
          note({
            tool: preToolUse.tool_name,
            decision: "deny",
            reason: AGENT_MESSAGE_DENIAL,
          });
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: AGENT_MESSAGE_DENIAL,
            },
          };
        }
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
        // OBSERVED AFTER THE DECISION, IN BOTH DIRECTIONS. An allowed delegation
        // is the interesting half for the canvas — it is the moment an agent was
        // permitted to exist — and it is the half a deny-only observer would
        // have made invisible.
        note({
          tool: preToolUse.tool_name,
          decision: decision.allow ? "allow" : "deny",
          reason: decision.allow ? "" : decision.reason,
        });
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
