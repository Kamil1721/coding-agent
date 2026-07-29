/**
 * builders/antislop-hook.ts — Phase 2a, the anti-slop rules in the slots the
 * engine actually asks.
 *
 * WHY A HOOK AND NOT `canUseTool`, MEASURED RATHER THAN ASSUMED. Probe A ran a
 * delegation under `acceptEdits`, `default` AND `dontAsk`; in every arm the
 * permission callback returned deny, was consulted for NO TOOL AT ALL, and the
 * subagent started anyway. A programmatic `Options.hooks` `PreToolUse` callback
 * IS consulted — probes E and F, then live adversarial run 2, where the deny
 * produced no `task_started`, no `SubagentStart`, no agentId and no tokens
 * billed. The SDK points here itself: `sdk.mjs`'s shadow warning reads "To gate
 * every tool call, use a PreToolUse hook instead."
 *
 * ONE SLOT, CHAINED — NOT A SECOND MATCHER, and that is the load-bearing design
 * decision in this file. Probe E registered three slots and ALL THREE fired for
 * the same `tool_use_id`, so which one carried the decision went UNMEASURED.
 * Registering anti-slop as a second `HookCallbackMatcher` would stack a new
 * craft rule on top of an unmeasured precedence question, and the failure mode
 * would be silent: a `{continue:true}` from one slot possibly overriding a deny
 * from the other, with a green unit test either way. {@link chainPreToolUse}
 * flattens both into the single no-matcher slot that WAS measured to fire and to
 * deny, with delegation consulted first and its decision strings passing through
 * byte-identical (two of them are pinned by tests and reach the model verbatim).
 *
 * LAYER 1 IS A CRAFT GATE, NOT A SECURITY BOUNDARY. Nothing here is load-bearing
 * for `heldOutPass`; the sealed-suite boundary is `managedSettings.permissions.
 * deny` at the policy tier and the delegation branch of the same chain, and
 * neither is touched. That is what licenses the escalation below: after N fires
 * of the SAME rule the hook ALLOWS and reports, because a build that cannot
 * write is a mysterious failure while a build that wrote slop three times after
 * being told why is a reported finding. A security boundary would never be
 * written this way and this one must never be mistaken for it.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookInput,
  StopHookInput,
  SubagentStopHookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

import { decideMotion, scanForSlop, type SlopFinding, type WorkspaceFile } from "./antislop-rules.js";

/* ─────────────────────────────── observation ─────────────────────────────── */

export interface AntiSlopObservation {
  readonly layer: "write" | "completion";
  readonly ruleId: string;
  /** Which agent tripped it — `agent_id` when the SDK supplied one, else "main". */
  readonly agent: string;
  readonly decision: "deny" | "escalated";
  readonly evidence: string;
}

/**
 * A caller that wants to WATCH the gate. Strictly a bystander, on the same terms
 * as `DelegationObserver`: invoked after the decision is computed, return value
 * discarded, every call wrapped in a try/catch. A hook that throws is an
 * unhandled rejection on the SDK's own reader loop and takes the whole run down;
 * instrumentation must never be able to do that.
 */
export type AntiSlopObserver = (observation: AntiSlopObservation) => void;

function noteSafely(observe: AntiSlopObserver | null, observation: AntiSlopObservation): void {
  if (observe === null) return;
  try {
    observe(observation);
  } catch {
    /* the record of the gate is not the gate */
  }
}

/* ──────────────────────────── the chained slot ──────────────────────────── */

/**
 * Does this hook output STOP the call? Read broadly on purpose: a chain that
 * only recognised `permissionDecision: "deny"` would silently swallow a
 * `decision: "block"` or a `continue: false` from a link it did not write.
 */
function isStopping(out: HookJSONOutput | undefined): boolean {
  if (out === null || out === undefined || typeof out !== "object") return false;
  const sync = out as SyncHookJSONOutput;
  if (sync.continue === false) return true;
  if (sync.decision === "block") return true;
  const specific = sync.hookSpecificOutput;
  return (
    specific !== undefined &&
    "permissionDecision" in specific &&
    (specific as { permissionDecision?: string }).permissionDecision === "deny"
  );
}

/**
 * Several guards, ONE `PreToolUse` slot, first stop wins.
 *
 * ORDER IS THE INTERFACE. The first matcher is consulted first, so
 * `chainPreToolUse(delegation, antiSlop)` keeps delegation's denials exactly
 * where they were: same strings, same precedence, no craft rule able to
 * intercept a boundary decision. Anything that stops short-circuits, so a
 * denied call is never scanned twice and never reported twice.
 *
 * EVERYTHING ELSE RETURNS `{continue: true}`. This slot fires for EVERY tool,
 * Bash included (measured). A chain that fell through to anything else would
 * stop being a gate and become a session that cannot do anything — and that
 * failure does not read as a regression, it reads as a broken builder, which is
 * how it would be "fixed".
 */
export function chainPreToolUse(...matchers: readonly HookCallbackMatcher[]): HookCallbackMatcher {
  const callbacks: HookCallback[] = matchers.flatMap((m) => m.hooks);
  return {
    hooks: [
      async (input, toolUseId, options): Promise<HookJSONOutput> => {
        for (const callback of callbacks) {
          const out = await callback(input, toolUseId, options);
          if (isStopping(out)) return out;
        }
        return { continue: true };
      },
    ],
  };
}

/* ───────────────────────── Layer 1 — the write gate ───────────────────────── */

/**
 * The three keys a write's NEW TEXT arrives under, read out of the SDK's own
 * `sdk-tools.d.ts` for 0.3.220 rather than assumed:
 *
 *   `Write`        `FileWriteInput.content`
 *   `Edit`         `FileEditInput.new_string`   — never `old_string`, which is
 *                                                 the text being REMOVED
 *   `NotebookEdit` `NotebookEditInput.new_source`
 *
 * THERE IS NO `MultiEdit` IN THIS SDK — checked against `ToolInputSchemas`, not
 * remembered.
 */
const TEXT_KEYS: readonly string[] = ["content", "new_string", "new_source"];

/** The keys that carry the destination. Extension is the whole artefact gate. */
const PATH_KEYS: readonly string[] = ["file_path", "notebook_path", "filePath", "path"];

/**
 * SHAPE, NOT TOOL NAME — the READ_TOOLS lesson, twice paid for in this
 * codebase, and the `Agent`-at-the-hook / `Task`-in-the-transcript measurement.
 * A name allowlist is fail-open to every tool nobody enumerated, and an
 * `mcp__*` file writer that carries `{path, content}` is exactly such a tool.
 *
 * BOTH HALVES ARE REQUIRED, and the path half is what keeps this off everything
 * else that happens to carry a `content` key: `SendMessage{to, content}` has no
 * path, so it is not a write and is not scanned here (it is denied one link
 * earlier in the chain anyway). A write with no recognisable path key is NOT
 * scanned — a fail-open, recorded rather than hidden, because guessing that an
 * unknown tool's unknown key is a filename is how a craft gate denies a
 * legitimate write.
 */
export function writeTargetOf(input: unknown): { path: string; text: string } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const shaped = input as Record<string, unknown>;
  const textKey = TEXT_KEYS.find((k) => typeof shaped[k] === "string");
  if (textKey === undefined) return null;
  const pathKey = PATH_KEYS.find((k) => typeof shaped[k] === "string");
  if (pathKey === undefined) return null;
  return { path: shaped[pathKey] as string, text: shaped[textKey] as string };
}

/**
 * How a violation is put to the model.
 *
 * IT NAMES THE RULE, THE SOURCE, THE EVIDENCE AND THE REMEDY, in that order,
 * because `permissionDecisionReason` reaches the model verbatim as an `is_error`
 * tool_result and a reason a builder cannot act on is worse than no rule: it
 * surfaces as an unexplained failed write. The evidence is quoted so the model
 * can find the offending span in text it just composed rather than re-deriving
 * which of several candidates was meant.
 */
export function denialFor(finding: SlopFinding, filePath: string): string {
  return (
    `Blocked by the craft floor — ${finding.ruleId} (${finding.source}).\n` +
    `In ${filePath}: ${finding.evidence}\n` +
    `${finding.reason}\n` +
    "Rewrite the element and write the file again. This is a quality rule, not a permission " +
    "problem: the same write succeeds once the violation is gone."
  );
}

/** The spec's retry cap: "the same rule firing 3x escalates to the orchestrator". */
const DEFAULT_WRITE_ESCALATE_AFTER = 3;

export interface AntiSlopHookOptions {
  /**
   * How many times ONE rule may deny ONE agent before the gate escalates and
   * ALLOWS. Spec §8: "the same rule firing 3x escalates to the orchestrator
   * rather than looping."
   *
   * ESCALATE-AND-ALLOW, NOT ESCALATE-AND-KEEP-DENYING, and the choice is the
   * whole reason this is safe to ship before the DESIGN lane. A model that has
   * been told the same thing twice and writes it a third time is either right
   * about its context or stuck; in both cases another denial produces a loop
   * that burns the run's turns and surfaces as a build that mysteriously never
   * finished. The third fire is reported instead, with the evidence, and the
   * write goes through. Layer 1 is a craft gate, not a boundary — see the header.
   */
  readonly escalateAfter?: number;
  readonly observe?: AntiSlopObserver | null;
}

/**
 * Layer 1: `PreToolUse` on any tool whose input carries a path and new text.
 *
 * THE COUNTER IS PER (RULE, AGENT). `BaseHookInput.agent_id` is present only
 * when the hook fires from inside a subagent and absent on the main thread
 * (sdk.d.ts:173-176), so the main thread keys as "main". Keying per agent
 * matters because a shortlist of specialists writes many files: one agent
 * exhausting a rule's budget must not spend it for the others, which would
 * disable the rule for the rest of the run after one stubborn lens.
 */
export function makeAntiSlopHook(options: AntiSlopHookOptions = {}): HookCallbackMatcher {
  const escalateAfter = options.escalateAfter ?? DEFAULT_WRITE_ESCALATE_AFTER;
  const observe = options.observe ?? null;
  const fires = new Map<string, number>();
  return {
    hooks: [
      async (input): Promise<SyncHookJSONOutput> => {
        const preToolUse = input as PreToolUseHookInput;
        const target = writeTargetOf(preToolUse.tool_input);
        if (target === null) return { continue: true };
        const findings = scanForSlop(target.path, target.text);
        // THE FIRST FINDING IS THE ONE REPORTED, not all of them. A denial the
        // model can act on names ONE thing to fix; a wall of seven rules is a
        // reason a builder cannot act on, which is the failure mode this phase
        // was warned about. The rest surface on the next attempt if they survive.
        const finding = findings[0];
        if (finding === undefined) return { continue: true };
        const agent = preToolUse.agent_id ?? "main";
        const key = `${agent}::${finding.ruleId}`;
        const count = (fires.get(key) ?? 0) + 1;
        fires.set(key, count);
        if (count >= escalateAfter) {
          noteSafely(observe, {
            layer: "write",
            ruleId: finding.ruleId,
            agent,
            decision: "escalated",
            evidence: `${target.path}: ${finding.evidence}`,
          });
          return { continue: true };
        }
        noteSafely(observe, {
          layer: "write",
          ruleId: finding.ruleId,
          agent,
          decision: "deny",
          evidence: `${target.path}: ${finding.evidence}`,
        });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: denialFor(finding, target.path),
          },
        };
      },
    ],
  };
}

/* ────────────────────── Layer 2 — the completion gate ────────────────────── */

/** Reads the workspace's artefact files. Injected so the decision stays pure. */
export type WorkspaceReader = () => Promise<readonly WorkspaceFile[]>;

/** Never walked: vendored, generated or version-control trees. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  "design-refs",
]);

const MAX_WORKSPACE_FILES = 400;
const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;

/**
 * The real reader, kept OUT of {@link decideMotion} so the decision is a pure
 * function of text and can be exercised against `calibration/correct-portfolio`
 * and `calibration/stock-motion-only` without a workspace.
 *
 * Bounded on purpose: a Stop hook runs on the SDK's own reader loop, so an
 * unbounded walk of a workspace with `node_modules` in it would stall the run
 * at exactly the moment it is trying to finish.
 */
export function makeWorkspaceReader(root: string): WorkspaceReader {
  return async () => {
    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const files: WorkspaceFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (files.length >= MAX_WORKSPACE_FILES) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= MAX_WORKSPACE_FILES) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const size = await stat(full)
          .then((s) => s.size)
          .catch(() => Number.MAX_SAFE_INTEGER);
        if (size > MAX_WORKSPACE_FILE_BYTES) continue;
        const text = await readFile(full, "utf8").catch(() => null);
        if (text === null) continue;
        files.push({ path: full, text });
      }
    };
    await walk(root);
    return files;
  };
}

export interface MotionHookOptions {
  readonly escalateAfter?: number;
  readonly observe?: AntiSlopObserver | null;
}

const DEFAULT_MOTION_ESCALATE_AFTER = 2;

/**
 * Layer 2: `Stop` / `SubagentStop` — a frontend agent may not declare done
 * unless the output carries bespoke motion (spec §8 Layer 2).
 *
 * WHICH RETURN VALUE ACTUALLY GATES COMPLETION WAS UNKNOWN FROM THE TYPINGS AND
 * IS THEREFORE MEASURED, NOT GUESSED. `StopHookSpecificOutput` carries ONLY
 * `additionalContext`; `prevent_continuation` is a field on
 * `SDKInformationalMessage` — what the SDK EMITS when a Stop hook denied
 * continuation, not what a hook returns. STATUS's phrase "a Stop hook can set
 * `prevent_continuation`" describes the emitted message, so coding to it would
 * have produced a hook that returns cheerfully and gates nothing.
 *
 * MEASURED, `antislop-probe.mjs` arms 3 and 4 (paired, one live session each,
 * `antislop-probe-result.json`):
 *
 *   {continue:true}                 hook fired 1x, 1 assistant turn   BASELINE
 *   {decision:"block", reason}      hook fired 2x, 2 assistant turns, the second
 *                                   one responding to the reason text
 *
 * So `decision: "block"` makes the model KEEP WORKING with the reason in hand,
 * which is exactly what spec §8 Layer 2 asks for ("the agent keeps working").
 * The baseline arm is what makes the second number mean anything: without it,
 * "two turns" is equally consistent with a model that was going to say more
 * anyway. No `prevent_continuation` informational message appeared in either
 * arm, which is recorded because it is the claim the typings tempted us into.
 *
 * `stop_hook_active` IS CHECKED FIRST AND THAT IS NOT DEFENSIVE PROGRAMMING. It
 * is the SDK's own re-entrancy flag: true means this hook already blocked once
 * and the model is stopping again. Ignoring it is how a completion gate loops
 * forever on an artefact it will never accept.
 *
 * IT ABSTAINS ON A NON-WEB WORKSPACE, in `decideMotion`. A CLI or library build
 * has no page to animate; blocking one would surface as a build that never
 * finishes for a reason nothing in the ticket predicts.
 */
export function makeMotionStopHook(
  readWorkspace: WorkspaceReader,
  options: MotionHookOptions = {},
): HookCallbackMatcher {
  const escalateAfter = options.escalateAfter ?? DEFAULT_MOTION_ESCALATE_AFTER;
  const observe = options.observe ?? null;
  const blocks = new Map<string, number>();
  return {
    hooks: [
      async (input): Promise<SyncHookJSONOutput> => {
        const stop = input as StopHookInput | SubagentStopHookInput;
        if (stop.stop_hook_active) return { continue: true };
        let files: readonly WorkspaceFile[];
        try {
          files = await readWorkspace();
        } catch {
          // A workspace that cannot be read is not evidence of missing motion.
          return { continue: true };
        }
        const verdict = decideMotion(files);
        if (verdict.kind !== "unsatisfied") return { continue: true };
        const agent = stop.agent_id ?? "main";
        const count = (blocks.get(agent) ?? 0) + 1;
        blocks.set(agent, count);
        if (count > escalateAfter) {
          noteSafely(observe, {
            layer: "completion",
            ruleId: "AS-MOTION-BAR",
            agent,
            decision: "escalated",
            evidence: verdict.reason,
          });
          return { continue: true };
        }
        noteSafely(observe, {
          layer: "completion",
          ruleId: "AS-MOTION-BAR",
          agent,
          decision: "deny",
          evidence: verdict.reason,
        });
        return { decision: "block", reason: verdict.reason };
      },
    ],
  };
}
