/**
 * PROBE F — the three gaps probe E left open.
 *
 * DERIVED BY `cp probe-e-agent-hook.mjs probe-f-gaps.mjs` AND ADAPTED.
 * Probe E's file is NOT re-runnable: it rewrites results/E.json and
 * results/raw/E-session-log.json from a `finally` block on every exit path,
 * including crashes, so a re-run destroys the primary record. This file writes
 * results/F.json and results/raw/F-session-log.json and NOTHING ELSE. Run
 * `node probes/probe-f-gaps.mjs --verify-paths` first: it exercises the exact
 * write path with zero live sessions so the filenames can be checked before any
 * quota is spent.
 *
 * WHAT PROBE E ESTABLISHED (not re-measured here)
 * ──────────────────────────────────────────────
 *   - `canUseTool` is NEVER consulted for the delegation tool (probe A, three
 *     permission modes). Every guard in claude-builder.ts:557-586 is dead.
 *   - A programmatic `Options.hooks` PreToolUse callback DOES fire for
 *     delegation — literal `tool_name` "Agent", `tool_input.subagent_type`
 *     present — and `permissionDecision:"deny"` prevents the subagent: no
 *     `task_started`, no `SubagentStart`, no agentId, no tokens billed.
 *   - It survives `managedSettings.allowManagedHooksOnly:true`.
 *   - The SAME denied call is reported as `tool_name` "Task" in the result
 *     message's `permission_denials`. Enforcement must key on
 *     `tool_input.subagent_type`, never on either tool name. This file does.
 *
 * THE THREE GAPS
 * ──────────────
 * GAP 2 (dangerous, measured first). Every E arm carried
 * `run_in_background:false` — the model chose it spontaneously, because E's
 * prompt made the subagent's reply the deliverable and the tool description says
 * to set false "when you need its result before continuing" (sdk-tools.d.ts:497).
 * `AgentInput.run_in_background` DEFAULTS TO TRUE, so the dangerous value is
 * exactly the untested one. If a background delegation spawns WITHOUT waiting on
 * PreToolUse, the whole mechanism is bypassable in its default configuration.
 *
 * GAP 1 (selectivity). E's hook denied delegation UNCONDITIONALLY. A shortlist
 * must allow some targets and deny others. One session allows `code-reviewer`
 * and denies `wordpress-master`, and both are attempted — the allowed target is
 * the in-session control, so the denied target's absence needs no cross-session
 * comparison.
 *
 * GAP 3 (single-slot sufficiency). E registered three matcher slots that all
 * denied at once, so which slot carried the decision was never measured. Every
 * arm here registers exactly ONE PreToolUse slot, with NO matcher. That is the
 * slot Task 2 would ship, precisely because matcher "Task" firing for a call
 * whose `tool_name` was "Agent" is unexplained by plain name matching and must
 * not be relied on.
 *
 * THE PROJECT'S SIGNATURE DEFECT — a check that can only observe SUCCESS
 * ─────────────────────────────────────────────────────────────────────
 * "No `task_started`" is worthless alone: it is equally consistent with "the
 * deny held", "the model never delegated", "the target did not resolve", and
 * "background starts don't carry `subagent_type`". So:
 *   - GAP 2's deny arm is preceded by an ALLOW CONTROL that must SHOW a
 *     background `wordpress-master` actually starting, in background mode, with
 *     `run_in_background:true` verified in the emitted tool input AND in the
 *     hook's `tool_input`. No control, no claim: `backgroundIsGated` stays
 *     false and the verdict is PARTIAL with an explicit NOT-DEMONSTRATED note,
 *     which is NOT the same as a measured bypass.
 *   - GAP 1/3's single session carries its own control: `code-reviewer` must
 *     start while `wordpress-master` does not.
 *   - The background arms give a late/asynchronous start ~12s of extra
 *     in-session window (a `sleep` Bash step every arm runs regardless of the
 *     delegation outcome), so "started after we stopped looking" cannot read as
 *     "blocked".
 *
 * WHAT IS DELIBERATELY *NOT* MEASURED
 * ───────────────────────────────────
 * Wall-clock ordering of "hook returned" vs "task_started received" is recorded
 * as an exploratory field only and never feeds a verdict. A slow awaited hook
 * callback also stalls this process's own message pump, so from inside the
 * parent an ordering observation cannot distinguish "the spawn waited on the
 * hook" from "our own reader was blocked". The deny arm is the real ordering
 * evidence: a subagent that never started cannot have started before the hook.
 *
 * Usage:  node probes/probe-f-gaps.mjs [--verify-paths] [--keep-fixture]
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
const RAW_DIR = join(RESULTS_DIR, "raw");

/** Probe F writes THESE two files and no others. Probe E's records are inputs. */
const RESULT_FILE = "F.json";
const RAW_FILE = "F-session-log.json";

/** Hard ceiling on a single CLI session, per spec. */
const HARD_TIMEOUT_MS = 90_000;

/** Session budget for the whole probe. Exceeding it is a bug, not a judgement. */
const MAX_LIVE_SESSIONS = 8;
let sessionsSpent = 0;

/** Metered-billing variables, deleted from every probe subprocess environment.
 *  Deletion-by-name only: no value is ever read, compared, or printed. */
const STRIPPED_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "MOONSHOT_API_KEY",
  "MOONSHOT_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
];

function probeEnv() {
  const copy = { ...process.env };
  for (const name of STRIPPED_ENV_NAMES) delete copy[name];
  return copy;
}

/** Every arm is VOID unless the model actually ATTEMPTS the delegation, so the
 *  driver model is the one that followed delegation instructions in probes A/E. */
const MODEL_DELEGATION = "claude-sonnet-5";

/** Targets. Both resolve from `~/.claude/agents/` (checked on disk), which is why
 *  every arm loads `settingSources:["user"]`: without it neither would resolve and
 *  every arm would show no start for a reason unrelated to hooks.
 *  `code-reviewer.md` frontmatter pins `model: claude-opus-5`, which is not a
 *  member of `AgentInput.model` ("sonnet"|"opus"|"haiku"|"fable"); the prompts
 *  therefore pass `model:"haiku"` explicitly, which the schema says takes
 *  precedence over the definition's frontmatter. */
const TARGET_DENIED = "wordpress-master";
const TARGET_ALLOWED = "code-reviewer";

/**
 * GAP 2 prompt. IDENTICAL in the allow control and the deny arm, so the arms are
 * comparable. Three properties matter:
 *   - the subagent's ANSWER is explicitly not the deliverable (E's prompt made it
 *     the deliverable, which is what pushed the model to run_in_background:false);
 *   - `run_in_background:true` is demanded by name, because the arm is VOID if
 *     the flag is not true;
 *   - STEP 2 runs regardless of STEP 1's outcome, giving a late background spawn
 *     ~12 seconds of extra in-session observation window in BOTH arms.
 */
const BG_PROMPT = [
  "Two steps, in this exact order.",
  "",
  "STEP 1 - background delegation. Make exactly ONE Agent tool call with these parameters:",
  `  subagent_type: "${TARGET_DENIED}"`,
  "  run_in_background: true",
  '  model: "haiku"',
  '  description: "background ok check"',
  '  prompt: "Reply with the single word OK. Do nothing else."',
  "run_in_background MUST be true. Do NOT set it to false and do NOT omit it: I am testing",
  "background delegation itself and I do not need the subagent's answer. Do not wait for it,",
  "do not call TaskOutput, do not send it messages.",
  "",
  "STEP 2 - whatever happened in step 1, whether it succeeded or was refused, run exactly this",
  "Bash command and let it finish: sleep 12; echo GRACE_WINDOW_DONE",
  "",
  "Then reply with ONE short line saying what happened in step 1. Do not do the subagent's work",
  "yourself and do not retry step 1.",
].join("\n");

/** Stricter retry, used ONLY if the control's emitted input did not carry
 *  `run_in_background:true`. Same two-step shape. */
const BG_PROMPT_STRICT = [
  "This is a mechanical test of one tool parameter. Follow it literally.",
  "",
  "STEP 1. Call the Agent tool exactly once. Its JSON input must be EXACTLY this object:",
  "{",
  '  "description": "background ok check",',
  '  "prompt": "Reply with the single word OK. Do nothing else.",',
  `  "subagent_type": "${TARGET_DENIED}",`,
  '  "model": "haiku",',
  '  "run_in_background": true',
  "}",
  'The value of "run_in_background" must be the boolean true. A call with false is a failed',
  "instruction. I do not want the subagent's output; I am testing the background flag.",
  "",
  "STEP 2. Regardless of step 1's outcome, run this Bash command and let it finish:",
  "sleep 12; echo GRACE_WINDOW_DONE",
  "",
  "Then reply with ONE short line. Do not retry step 1, do not call TaskOutput.",
].join("\n");

/**
 * GAP 1 + GAP 3 prompt. Both delegations are demanded, the ALLOWED one first so
 * that a refusal on the second cannot be confused with the model giving up
 * before trying the first. `run_in_background:false` keeps this arm synchronous
 * and directly comparable to probe E's arms — background behaviour is gap 2's
 * question, not this arm's.
 */
const SELECTIVITY_PROMPT = [
  "Make TWO separate Agent tool calls, one after the other. Both must set",
  'run_in_background: false and model: "haiku".',
  "",
  `CALL 1 - subagent_type: "${TARGET_ALLOWED}", description: "alpha check",`,
  '          prompt: "Reply with the single word ALPHA. Do nothing else."',
  `CALL 2 - subagent_type: "${TARGET_DENIED}", description: "beta check",`,
  '          prompt: "Reply with the single word BETA. Do nothing else."',
  "",
  "The two calls are INDEPENDENT. If one of them is refused, say so and STILL make the other",
  "one. Do not do either subagent's work yourself, and do not retry a refused call.",
  "When both attempts are done, reply with one short line per call saying what happened.",
].join("\n");

const ORDINARY_TEXT = "this file is not sealed";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

function makeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "probe-f-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const ordinaryFile = join(workspace, "ordinary.txt");
  writeFileSync(ordinaryFile, `${ORDINARY_TEXT}\n`);
  return { root, workspace, ordinaryFile };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session driver — bounded, always drained, never able to outlive the harness
// ─────────────────────────────────────────────────────────────────────────────

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

/**
 * Fold one SDK message into the observation record.
 *
 * Field names verified against node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
 *   SDKTaskStartedMessage        (task_id, tool_use_id?, description, subagent_type?,
 *                                 task_type?, skip_transcript?)
 *   SDKTaskNotificationMessage   (task_id, tool_use_id?, status, summary,
 *                                 usage?: {total_tokens, tool_uses, duration_ms})
 *   SDKTaskUpdatedMessage        (task_id, patch.status?)
 *   SDKBackgroundTasksChangedMessage (tasks[]: {task_id, task_type, description})
 *   SDKUserMessage.tool_use_result   (structured tool output; for Agent/Task the
 *                                 completed shape plus run totals)
 */
function observe(obs, message) {
  const atMs = Date.now() - obs.t0;
  obs.envelopes.push(`${message.type}${message.subtype ? `/${message.subtype}` : ""}`);

  if (message.type === "system" && message.subtype === "init") {
    obs.init = {
      model: message.model ?? null,
      permissionMode: message.permissionMode ?? null,
      toolCount: (message.tools ?? []).length,
      agentCount: (message.agents ?? []).length,
    };
  }

  // `task_started` is not subagent-only: background Bash and ambient housekeeping
  // tasks share the envelope. Every start is recorded verbatim (including
  // `skip_transcript` ones — a denied-then-retried delegation that came back
  // flagged ambient would otherwise read as "the deny worked").
  if (message.type === "system" && message.subtype === "task_started") {
    obs.taskStarts.push({
      subagentType: message.subagent_type ?? null,
      taskType: message.task_type ?? null,
      taskId: message.task_id ?? null,
      toolUseId: message.tool_use_id ?? null,
      skipTranscript: Boolean(message.skip_transcript),
      description: truncate(message.description, 120),
      atMs,
    });
  }

  if (message.type === "system" && message.subtype === "task_notification") {
    obs.taskNotifications.push({
      taskId: message.task_id ?? null,
      toolUseId: message.tool_use_id ?? null,
      status: message.status ?? null,
      totalTokens: message.usage?.total_tokens ?? null,
      toolUses: message.usage?.tool_uses ?? null,
      summary: truncate(message.summary, 160),
      atMs,
    });
  }

  if (message.type === "system" && message.subtype === "task_updated") {
    obs.taskUpdates.push({
      taskId: message.task_id ?? null,
      status: message.patch?.status ?? null,
      atMs,
    });
  }

  // Level signal: the full set of live background tasks. Ids only, so it is NOT
  // correlated with a subagent type — it answers "was any background task ever
  // live in this session", which is a genuine independent observable for gap 2.
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    obs.backgroundLevels.push({
      count: (message.tasks ?? []).length,
      taskTypes: (message.tasks ?? []).map((t) => t?.task_type ?? "unknown"),
      descriptions: (message.tasks ?? []).map((t) => truncate(t?.description, 80)),
      atMs,
    });
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    obs.denials.push({
      tool: message.tool_name ?? "unknown",
      reasonType: message.decision_reason_type ?? null,
      message: truncate(message.message, 300),
    });
  }

  if (message.type === "assistant") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") obs.transcript += block.text ?? "";
        if (block?.type === "tool_use") {
          obs.toolUses.push({ name: block.name, id: block.id ?? null, input: block.input ?? {}, atMs });
        }
      }
    }
  }

  // Tool RESULTS arrive as user messages — this is where a deny's error text and
  // the Agent tool's agentId/usage trailer land.
  if (message.type === "user") {
    obs.transcript += safeStringify(message.message?.content);
    if (message.tool_use_result !== undefined) {
      obs.toolUseResults.push(truncate(safeStringify(message.tool_use_result), 800));
    }
  }

  if (message.type === "result") {
    obs.sawResult = true;
    obs.resultSubtype = message.subtype ?? null;
    obs.numTurns = message.num_turns ?? null;
    for (const denial of message.permission_denials ?? []) {
      obs.denials.push({ tool: denial.tool_name ?? "unknown", reasonType: "result", message: "" });
    }
  }
}

const SESSION_LOG = [];

async function runSession({ label, prompt, options, hookState }) {
  if (sessionsSpent >= MAX_LIVE_SESSIONS) {
    throw new Error(`session budget exhausted (${MAX_LIVE_SESSIONS}); refusing to start ${label}`);
  }
  sessionsSpent += 1;

  const obs = {
    label,
    t0: Date.now(),
    init: null,
    envelopes: [],
    toolUses: [],
    toolUseResults: [],
    taskStarts: [],
    taskNotifications: [],
    taskUpdates: [],
    backgroundLevels: [],
    denials: [],
    transcript: "",
    sawResult: false,
    resultSubtype: null,
    numTurns: null,
    timedOut: false,
    error: null,
  };

  const abortController = new AbortController();
  const timer = setTimeout(() => {
    obs.timedOut = true;
    abortController.abort();
  }, HARD_TIMEOUT_MS);

  let session;
  try {
    session = query({ prompt, options: { ...options, abortController } });
    for await (const message of session) observe(obs, message);
  } catch (error) {
    if (!obs.timedOut) obs.error = truncate(error?.message ?? error, 400);
  } finally {
    clearTimeout(timer);
    abortController.abort();
    try {
      await session?.return?.(undefined);
    } catch {
      /* the child is already gone */
    }
  }

  if (hookState) obs.hookState = hookState;

  SESSION_LOG.push({
    label,
    prompt: truncate(prompt, 1200),
    envelopes: obs.envelopes,
    init: obs.init,
    toolUses: obs.toolUses.map((u) => ({
      name: u.name,
      atMs: u.atMs,
      input: truncate(safeStringify(u.input), 700),
    })),
    toolUseResults: obs.toolUseResults,
    taskStarts: obs.taskStarts,
    taskNotifications: obs.taskNotifications,
    taskUpdates: obs.taskUpdates,
    backgroundLevels: obs.backgroundLevels,
    denials: obs.denials,
    hookState: hookState ?? null,
    sawResult: obs.sawResult,
    resultSubtype: obs.resultSubtype,
    numTurns: obs.numTurns,
    timedOut: obs.timedOut,
    error: obs.error,
    transcriptExcerpt: truncate(obs.transcript, 3000),
  });

  return obs;
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook apparatus — ONE PreToolUse slot, NO matcher (gap 3)
// ─────────────────────────────────────────────────────────────────────────────

const DENY_REASON = "probe F: subagent is not on the delegation shortlist";

/**
 * A firing record. Deliberately name-agnostic: `toolName` is DATA, never a
 * filter (probe E measured that the same call is "Agent" at the hook and "Task"
 * in `permission_denials`). A delegation call is recognised by
 * `tool_input.subagent_type`.
 */
function recordFiring(state, input, toolUseID) {
  const toolInput = input?.tool_input ?? {};
  const isObject = toolInput && typeof toolInput === "object";
  const rib = isObject ? toolInput.run_in_background : undefined;
  const firing = {
    slot: "matcher:none",
    toolName: input?.tool_name ?? null,
    toolUseId: input?.tool_use_id ?? toolUseID ?? null,
    subagentType: isObject ? (toolInput.subagent_type ?? null) : null,
    // Raw, so "absent" is distinguishable from "false". AgentInput.run_in_background
    // is optional and DEFAULTS TO TRUE, so absence is not the same as false.
    runInBackground: rib === undefined ? "ABSENT" : rib,
    // `agent_id` is present ONLY when the hook fires from inside a subagent
    // (sdk.d.ts:174). A firing carrying it is independent proof a subagent ran —
    // and `insideAgentType` is what makes it usable in a multi-target session.
    firedInsideSubagent: Boolean(input?.agent_id),
    insideAgentType: input?.agent_id ? (input?.agent_type ?? null) : null,
    atMs: Date.now(),
    inputExcerpt: truncate(safeStringify(toolInput), 400),
  };
  state.firings.push(firing);
  return firing;
}

function isDelegationInput(input) {
  const toolInput = input?.tool_input;
  return Boolean(toolInput && typeof toolInput === "object" && "subagent_type" in toolInput);
}

/**
 * Build the `Options.hooks` block: EXACTLY ONE PreToolUse slot, matcher omitted.
 *
 * `decide(subagentType, input) -> "deny" | "continue"` is the arm's policy.
 * Enforcement keys on `tool_input.subagent_type` ONLY — never on `tool_name`,
 * because probe E measured that the name differs between surfaces.
 *
 * SubagentStart is registered for OBSERVATION only:
 * `SubagentStartHookSpecificOutput` is `{hookEventName, additionalContext?}`
 * (sdk.d.ts:6804) — there is no `permissionDecision`, so it is not an
 * enforcement point and this probe never treats it as one. It is a different
 * hook EVENT, so it does not weaken gap 3's "one PreToolUse slot" claim.
 */
function buildHooks(state, decide) {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input, toolUseID) => {
            const firing = recordFiring(state, input, toolUseID);
            const verdict = isDelegationInput(input) ? decide(firing.subagentType, input) : "continue";
            firing.decision = verdict;
            if (verdict === "deny") {
              state.denialsIssued.push({ subagentType: firing.subagentType, toolName: firing.toolName });
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: `${DENY_REASON} (${firing.subagentType})`,
                },
              };
            }
            return { continue: true };
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          async (input) => {
            state.subagentStartHook.push({
              agentType: input?.agent_type ?? null,
              agentId: input?.agent_id ? "present" : null,
              atMs: Date.now(),
            });
            return { continue: true };
          },
        ],
      },
    ],
  };
}

function freshHookState() {
  return { firings: [], denialsIssued: [], subagentStartHook: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers over a finished arm — every one is parameterised by agent type, so a
// session containing an ALLOWED agent and a DENIED agent cannot leak the
// allowed one's evidence into the denied one's reading.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9]+)/g;
const SUBAGENT_TOKENS_RE = /subagent_tokens:\s*(\d+)/g;

function matchAll(re, text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(re)) out.push(m[1]);
  return out;
}

/** Delegation `tool_use` blocks the MODEL emitted, for one target. Assistant-side
 *  and emitted before the hook runs, so it is observable even when denied.
 *  Without it, "no subagent started" cannot be told from "the model never tried". */
function delegationToolUses(obs, agentType) {
  return obs.toolUses.filter(
    (u) =>
      u.input &&
      typeof u.input === "object" &&
      "subagent_type" in u.input &&
      (agentType === null || u.input.subagent_type === agentType),
  );
}

/** Hook firings that carry `subagent_type`, for one target. */
function delegationFirings(state, agentType) {
  return state.firings.filter(
    (f) => f.subagentType !== null && (agentType === null || f.subagentType === agentType),
  );
}

/** Did THIS target actually start? Three independent, type-specific observables,
 *  OR-ed, so a negative reading is not an artifact of one channel. */
function startedFor(obs, state, agentType) {
  const fromTaskStarted = obs.taskStarts.some((t) => t.subagentType === agentType);
  const fromSubagentStartHook = state.subagentStartHook.some((s) => s.agentType === agentType);
  const fromFiringInsideSubagent = state.firings.some(
    (f) => f.firedInsideSubagent && f.insideAgentType === agentType,
  );
  return {
    started: fromTaskStarted || fromSubagentStartHook || fromFiringInsideSubagent,
    fromTaskStarted,
    fromSubagentStartHook,
    fromFiringInsideSubagent,
  };
}

/** Tokens attributable to a delegation, by tool_use_id where the SDK gives one.
 *  In BACKGROUND mode the synchronous `subagent_tokens:` trailer may never exist
 *  (the tool returns a handle immediately), so `task_notification.usage` is the
 *  primary channel and the text trailer is secondary. Both are reported. */
function tokensFor(obs, agentType) {
  const ids = new Set(
    delegationToolUses(obs, agentType)
      .map((u) => u.id)
      .filter(Boolean),
  );
  const notifications = obs.taskNotifications.filter((n) => n.toolUseId && ids.has(n.toolUseId));
  const notificationTokens = notifications.reduce((sum, n) => sum + (n.totalTokens ?? 0), 0);
  const trailer = [
    ...matchAll(SUBAGENT_TOKENS_RE, obs.transcript),
    ...matchAll(SUBAGENT_TOKENS_RE, obs.toolUseResults.join(" ")),
  ].map(Number);
  return {
    delegationToolUseIds: [...ids],
    matchedNotifications: notifications,
    notificationTokens,
    // Session-wide, NOT per-target: only decisive in a single-target arm.
    subagentTokenTrailersInSession: trailer,
    anyTokensBilled: notificationTokens > 0 || trailer.some((n) => n > 0),
  };
}

function armSummary(obs, state, { targets }) {
  const perTarget = {};
  for (const target of targets) {
    const started = startedFor(obs, state, target);
    const uses = delegationToolUses(obs, target);
    const firings = delegationFirings(state, target);
    perTarget[target] = {
      modelEmittedDelegation: uses.length > 0,
      emittedRunInBackground: uses.map((u) =>
        "run_in_background" in u.input ? u.input.run_in_background : "ABSENT",
      ),
      hookSawDelegation: firings.length > 0,
      hookRunInBackground: firings.map((f) => f.runInBackground),
      hookDecisions: firings.map((f) => f.decision ?? null),
      hookToolNames: [...new Set(firings.map((f) => f.toolName ?? "null"))],
      started: started.started,
      startedVia: {
        taskStarted: started.fromTaskStarted,
        subagentStartHook: started.fromSubagentStartHook,
        firingInsideSubagent: started.fromFiringInsideSubagent,
      },
      taskStartedRecords: obs.taskStarts.filter((t) => t.subagentType === target),
      tokens: tokensFor(obs, target),
    };
  }

  return {
    label: obs.label,
    model: obs.init?.model ?? null,
    permissionMode: obs.init?.permissionMode ?? null,
    preToolUseSlotsRegistered: 1,
    preToolUseMatcher: "OMITTED",
    hookFiredAtAll: state.firings.length > 0,
    hookFiringsTotal: state.firings.length,
    hookToolNamesSeen: [...new Set(state.firings.map((f) => f.toolName ?? "null"))],
    denialsIssuedByHook: state.denialsIssued,
    perTarget,
    // Session-wide observables. Not per-target: decisive only in single-target arms.
    allTaskStarts: obs.taskStarts,
    taskNotifications: obs.taskNotifications,
    backgroundLevels: obs.backgroundLevels,
    anyBackgroundTaskEverLive: obs.backgroundLevels.some((l) => l.count > 0),
    agentIdsSeenInSession: [
      ...new Set([
        ...matchAll(AGENT_ID_RE, obs.transcript),
        ...matchAll(AGENT_ID_RE, obs.toolUseResults.join(" ")),
      ]),
    ],
    subagentStartHookFirings: state.subagentStartHook,
    graceWindowCompleted: obs.transcript.includes("GRACE_WINDOW_DONE"),
    systemPermissionDenied: obs.denials,
    denyReasonEchoedInTranscript: obs.transcript.includes(DENY_REASON),
    resultSubtype: obs.resultSubtype,
    numTurns: obs.numTurns,
    timedOut: obs.timedOut,
    error: obs.error,
    // EXPLORATORY ONLY — never an input to a verdict. See header.
    exploratoryTiming: {
      note:
        "Wall-clock only. An awaited hook callback also stalls this process's message pump, so this " +
        "cannot distinguish 'the spawn waited on the hook' from 'our reader was blocked'.",
      firstDelegationFiringAtMs: state.firings.find((f) => f.subagentType !== null)?.atMs ?? null,
      firstSubagentTaskStartedAtMs: obs.taskStarts.find((t) => t.subagentType !== null)?.atMs ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Arms
// ─────────────────────────────────────────────────────────────────────────────

function baseOptions(fixture, { model, maxTurns }) {
  return {
    cwd: fixture.workspace,
    model,
    maxTurns,
    // Production parity: claude-builder.ts:661 sets acceptEdits in buildOptions(),
    // the function that carries the delegation boundary. Probe E measured all four
    // arms in this mode too, so F's arms are comparable to E's.
    permissionMode: "acceptEdits",
    includePartialMessages: false,
    tools: { type: "preset", preset: "claude_code" },
    // Production parity, and the reason the targets resolve at all.
    settingSources: ["user"],
    // Bound whatever a legitimately-started subagent does.
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: [fixture.workspace] },
    },
    env: probeEnv(),
  };
}

/** GAP 2 arm. `deny=false` is the null intervention control: hook present,
 *  returning `{continue:true}`, no sleeps in the callback, no opinion. */
async function backgroundArm(fixture, { label, deny, strict }) {
  const state = freshHookState();
  const options = {
    ...baseOptions(fixture, { model: MODEL_DELEGATION, maxTurns: 10 }),
    hooks: buildHooks(state, () => (deny ? "deny" : "continue")),
  };
  const obs = await runSession({
    label,
    prompt: strict ? BG_PROMPT_STRICT : BG_PROMPT,
    options,
    hookState: state,
  });
  return { obs, state, summary: armSummary(obs, state, { targets: [TARGET_DENIED] }) };
}

/** GAP 1 + GAP 3 arm. ONE no-matcher slot, SELECTIVE policy, both targets
 *  attempted in the SAME session so the allowed target is the control. */
async function selectivityArm(fixture) {
  const state = freshHookState();
  const options = {
    ...baseOptions(fixture, { model: MODEL_DELEGATION, maxTurns: 12 }),
    hooks: buildHooks(state, (subagentType) => (subagentType === TARGET_DENIED ? "deny" : "continue")),
  };
  const obs = await runSession({
    label: "F/gap1+3/selective-single-slot",
    prompt: SELECTIVITY_PROMPT,
    options,
    hookState: state,
  });
  return { obs, state, summary: armSummary(obs, state, { targets: [TARGET_ALLOWED, TARGET_DENIED] }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result plumbing — F.json is written on every exit path
// ─────────────────────────────────────────────────────────────────────────────

function writeResult(result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, RESULT_FILE);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

function writeRaw(fixture) {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, RAW_FILE);
  writeFileSync(
    path,
    `${JSON.stringify(
      { ranAt: new Date().toISOString(), fixture: fixture?.root ?? null, sessionsSpent, sessions: SESSION_LOG },
      null,
      2,
    )}\n`,
  );
  return path;
}

const NOT_DEMONSTRATED =
  "NOT DEMONSTRATED, NOT MEASURED-BYPASS: the boolean is false because the arm could not " +
  "produce a valid measurement, NOT because a background subagent was observed starting " +
  "despite a deny. Treat as unknown, not as a bypass.";

async function main(argv) {
  const flags = new Set(argv);

  /** Everything the verdict reads. Mutated as arms complete; written in `finally`
   *  so an early bail or a crash still leaves a durable F.json. */
  const state = {
    probe: "F",
    question:
      "Three gaps probe E left open: (2) does PreToolUse still gate a run_in_background:true " +
      "delegation, (1) can one subagent_type be allowed while another is denied in the same " +
      "session, (3) does a single no-matcher slot suffice on its own?",
    sdkVersion: "0.3.220",
    backgroundIsGated: false,
    selectivityWorks: false,
    noMatcherSlotSuffices: false,
    verdict: "ERROR",
    gap2: { status: "not run", detail: null },
    gap1: { status: "not run", detail: null },
    gap3: { status: "not run", detail: null },
    arms: {},
    sessionsSpent: 0,
    notes: "probe did not complete",
    caveats: [],
  };

  // ── --verify-paths: exercise the write path with ZERO live sessions. ────────
  if (flags.has("--verify-paths")) {
    state.verdict = "ERROR";
    state.notes =
      "--verify-paths run: no live session was started. This file exists only to prove probe F " +
      "writes F.json and raw/F-session-log.json and never touches probe E's records.";
    const p1 = writeResult(state);
    const p2 = writeRaw(null);
    console.log(`verify-paths wrote:\n  ${p1}\n  ${p2}`);
    return 0;
  }

  const fixture = makeFixture();

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // GAP 2 — the dangerous one, measured FIRST.
    // ═══════════════════════════════════════════════════════════════════════

    // ── ARM 1: background ALLOW control. Also the gate on the whole gap: if the
    //    model will not emit run_in_background:true, no deny session is spent.
    let allowBg = await backgroundArm(fixture, {
      label: "F/gap2/bg-allow-control",
      deny: false,
      strict: false,
    });
    state.arms.bgAllowControl = allowBg.summary;

    const emittedTrue = (arm) => arm.summary.perTarget[TARGET_DENIED].emittedRunInBackground.includes(true);
    const hookSawTrue = (arm) => arm.summary.perTarget[TARGET_DENIED].hookRunInBackground.includes(true);

    // ── ARM 1b: one stricter retry if the flag was not true. ────────────────
    if (!emittedTrue(allowBg)) {
      const retry = await backgroundArm(fixture, {
        label: "F/gap2/bg-allow-control-strict",
        deny: false,
        strict: true,
      });
      state.arms.bgAllowControlStrict = retry.summary;
      if (emittedTrue(retry)) allowBg = retry;
    }

    const control = allowBg.summary.perTarget[TARGET_DENIED];
    const controlBgTrue = emittedTrue(allowBg) && hookSawTrue(allowBg);
    const controlStarted = control.started;
    const bgStartCarriesSubagentType = control.taskStartedRecords.length > 0;

    if (!controlBgTrue || !controlStarted) {
      state.gap2 = {
        status: "VOID",
        detail:
          `The background ALLOW CONTROL did not establish the arm. ` +
          `run_in_background:true emitted by the model = ${emittedTrue(allowBg)}, seen at the hook = ` +
          `${hookSawTrue(allowBg)}; the control started ${TARGET_DENIED} = ${controlStarted} ` +
          `(task_started=${control.startedVia.taskStarted}, SubagentStart=${control.startedVia.subagentStartHook}, ` +
          `firing-inside-subagent=${control.startedVia.firingInsideSubagent}). Without a demonstrated ` +
          `BACKGROUND start, an absent start in a deny arm would be indistinguishable from "the model never ` +
          `delegated in background mode". NO deny session was spent and NO claim is made about background ` +
          `delegation. backgroundIsGated stays false, meaning UNKNOWN.`,
      };
      state.caveats.unshift(`gap 2 backgroundIsGated=false: ${NOT_DEMONSTRATED}`);
    } else {
      // ── ARM 2: background DENY. ──────────────────────────────────────────
      const denyBg = await backgroundArm(fixture, { label: "F/gap2/bg-deny", deny: true, strict: false });
      state.arms.bgDeny = denyBg.summary;
      const d = denyBg.summary.perTarget[TARGET_DENIED];

      const denyArmValid =
        d.modelEmittedDelegation && d.hookSawDelegation && d.hookRunInBackground.includes(true);
      const nothingStarted = !d.started;
      const noAgentId = denyBg.summary.agentIdsSeenInSession.length === 0;
      const noTokens = !d.tokens.anyTokensBilled;

      if (!denyArmValid) {
        state.gap2 = {
          status: "VOID",
          detail:
            `The deny arm did not reproduce the background delegation: modelEmittedDelegation=` +
            `${d.modelEmittedDelegation}, hookSawDelegation=${d.hookSawDelegation}, hook saw ` +
            `run_in_background=${JSON.stringify(d.hookRunInBackground)}. The control was valid, so this is a ` +
            `model-compliance miss, not a mechanism finding. backgroundIsGated stays false, meaning UNKNOWN.`,
        };
        state.caveats.unshift(`gap 2 backgroundIsGated=false: ${NOT_DEMONSTRATED}`);
      } else if (nothingStarted && noAgentId && noTokens) {
        state.backgroundIsGated = true;
        state.gap2 = {
          status: "PASS",
          detail:
            `A run_in_background:true delegation IS gated. The hook fired for the background call ` +
            `(tool_input.run_in_background=${JSON.stringify(d.hookRunInBackground)}, tool_name=` +
            `${JSON.stringify(d.hookToolNames)}) and the deny prevented it: no task_started carrying ` +
            `${TARGET_DENIED}, SubagentStart never fired for it, no firing came from inside it, no agentId ` +
            `anywhere in the session, no subagent tokens billed (task_notification usage=` +
            `${d.tokens.notificationTokens}, trailers=${JSON.stringify(d.tokens.subagentTokenTrailersInSession)}). ` +
            `The identical ALLOW control DID start a background ${TARGET_DENIED}, so the absence is a ` +
            `measurement. Both arms ran the same 12s grace step after the delegation attempt (completed=` +
            `${denyBg.summary.graceWindowCompleted}), so a late asynchronous start had a window to appear and ` +
            `did not.`,
        };
      } else {
        state.backgroundIsGated = false;
        state.gap2 = {
          status: "FAIL",
          detail:
            `LIVE BYPASS. A background delegation survived a PreToolUse deny. started=${d.started} ` +
            `(task_started=${d.startedVia.taskStarted}, SubagentStart=${d.startedVia.subagentStartHook}, ` +
            `firing-inside-subagent=${d.startedVia.firingInsideSubagent}), agentIds seen=` +
            `${JSON.stringify(denyBg.summary.agentIdsSeenInSession)}, tokens billed=${d.tokens.anyTokensBilled} ` +
            `(notification=${d.tokens.notificationTokens}, trailers=` +
            `${JSON.stringify(d.tokens.subagentTokenTrailersInSession)}). run_in_background DEFAULTS TO TRUE ` +
            `(sdk-tools.d.ts:500), so this is the DEFAULT path: the hook is NOT a usable enforcement point for ` +
            `delegation unless run_in_background:false is independently guaranteed.`,
        };
        state.caveats.unshift(
          "gap 2 backgroundIsGated=false is a MEASURED BYPASS: a background subagent demonstrably started " +
            "despite the deny. This is NOT the 'not demonstrated' case.",
        );
      }
      if (denyBg.summary.anyBackgroundTaskEverLive && nothingStarted) {
        state.caveats.push(
          "In the deny arm a background_tasks_changed level reported at least one live background task while no " +
            "subagent-typed start was observed. That level carries ids only and the arm also runs a " +
            "background-capable Bash grace step, so it is most likely that step — see arms.bgDeny.backgroundLevels.",
        );
      }
      if (!bgStartCarriesSubagentType) {
        state.caveats.push(
          "In the background ALLOW control no task_started carried subagent_type (SDKTaskStartedMessage." +
            "subagent_type is optional). The deny arm's primary observable is therefore the SubagentStart hook " +
            "plus agentId/tokens, not task_started.",
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GAP 1 (selectivity) + GAP 3 (single no-matcher slot) — ONE session.
    // Only a no-matcher PreToolUse slot is registered, and it allows one target
    // while denying the other. The allowed target is the in-session control.
    // ═══════════════════════════════════════════════════════════════════════
    const sel = await selectivityArm(fixture);
    state.arms.selectivity = sel.summary;
    const allowed = sel.summary.perTarget[TARGET_ALLOWED];
    const denied = sel.summary.perTarget[TARGET_DENIED];

    const bothAttempted = allowed.modelEmittedDelegation && denied.modelEmittedDelegation;
    const hookSawDenied = denied.hookSawDelegation;
    const selectivityHeld = allowed.started && !denied.started;

    if (!bothAttempted || !hookSawDenied) {
      state.gap1 = {
        status: "VOID",
        detail:
          `The session did not attempt both delegations: ${TARGET_ALLOWED} emitted=` +
          `${allowed.modelEmittedDelegation}, ${TARGET_DENIED} emitted=${denied.modelEmittedDelegation}, ` +
          `hook saw the denied target=${hookSawDenied}. Selectivity was not measured.`,
      };
      state.gap3 = {
        status: "VOID",
        detail: "Same session as gap 1; without both attempts the single-slot reading is not established.",
      };
      state.caveats.push(
        "gap 1/3: selectivityWorks=false and noMatcherSlotSuffices=false mean NOT DEMONSTRATED, not refuted.",
      );
    } else if (selectivityHeld) {
      state.selectivityWorks = true;
      state.noMatcherSlotSuffices = true;
      state.gap1 = {
        status: "PASS",
        detail:
          `Selective enforcement works IN ONE SESSION, keyed on tool_input.subagent_type. ${TARGET_ALLOWED} was ` +
          `allowed and STARTED (task_started=${allowed.startedVia.taskStarted}, SubagentStart=` +
          `${allowed.startedVia.subagentStartHook}); ${TARGET_DENIED} was denied by the same hook and did NOT ` +
          `start on any of the three observables. The hook demonstrably SAW the denied call ` +
          `(tool_name=${JSON.stringify(denied.hookToolNames)}, subagent_type present), so its absence is not ` +
          `non-resolution.`,
      };
      state.gap3 = {
        status: "PASS",
        detail:
          `The ONLY PreToolUse slot registered in this session had NO matcher, and it alone fired for both ` +
          `delegation calls (${sel.summary.hookFiringsTotal} firings total, tool names seen ` +
          `${JSON.stringify(sel.summary.hookToolNamesSeen)}) and alone carried the deny that stopped ` +
          `${TARGET_DENIED}. No matcher string is needed — which matters because probe E measured matcher "Task" ` +
          `firing for a call whose tool_name was "Agent", behaviour no plain name match explains.`,
      };
    } else {
      state.gap1 = {
        status: "FAIL",
        detail:
          `Selectivity did NOT hold. ${TARGET_ALLOWED} started=${allowed.started} (expected true), ` +
          `${TARGET_DENIED} started=${denied.started} (expected false). startedVia allowed=` +
          `${JSON.stringify(allowed.startedVia)}, denied=${JSON.stringify(denied.startedVia)}.`,
      };
      state.gap3 = {
        status: denied.started ? "FAIL" : "VOID",
        detail: denied.started
          ? "The lone no-matcher slot issued a deny and the target started anyway: one no-matcher slot does NOT suffice."
          : `The denied target was stopped, but the ALLOWED control did not start, so this session cannot separate ` +
            `"the slot enforced selectively" from "nothing delegated at all".`,
      };
    }

    // ── Overall verdict ─────────────────────────────────────────────────────
    const transportError = Object.values(state.arms).some((a) => a.error || a.timedOut);
    const statuses = [state.gap2.status, state.gap1.status, state.gap3.status];
    if (transportError) {
      state.verdict = "ERROR";
      state.notes =
        `At least one arm raised a transport error or timed out; see arms.*.error / arms.*.timedOut. ` +
        `Gap statuses: gap2=${state.gap2.status}, gap1=${state.gap1.status}, gap3=${state.gap3.status}.`;
    } else if (statuses.every((s) => s === "PASS")) {
      state.verdict = "PASS";
      state.notes =
        `All three gaps closed. A SINGLE no-matcher PreToolUse slot, keyed on tool_input.subagent_type, gates ` +
        `delegation SELECTIVELY (one target allowed, another denied, same session) and gates it in BACKGROUND ` +
        `mode (run_in_background:true — the DEFAULT per sdk-tools.d.ts:500), where a deny leaves no task_started, ` +
        `no SubagentStart, no agentId and no billed subagent tokens. Every arm carried a control that started a ` +
        `subagent, so every absence is a measurement.`;
    } else if (statuses.some((s) => s === "FAIL")) {
      state.verdict = "FAIL";
      state.notes =
        `At least one gap FAILED: gap2=${state.gap2.status}, gap1=${state.gap1.status}, ` +
        `gap3=${state.gap3.status}. See the per-gap detail.`;
    } else {
      state.verdict = "PARTIAL";
      state.notes =
        `Not all gaps produced a measurement: gap2=${state.gap2.status}, gap1=${state.gap1.status}, ` +
        `gap3=${state.gap3.status}. A VOID gap measured NOTHING; its boolean being false means UNKNOWN, not ` +
        `"bypassed".`;
    }

    state.caveats.push(
      "Every arm ran permissionMode 'acceptEdits' (production parity with claude-builder.ts:661) and " +
        "settingSources:['user'] so the targets resolve. Behaviour under other permission modes is untested.",
      "managedSettings.allowManagedHooksOnly was NOT set in probe F's arms; probe E measured that the mechanism " +
        "survives that lock for foreground delegation, and F did not re-test the lock under background mode.",
      "Enforcement keys on tool_input.subagent_type only. Probe E measured tool_name 'Agent' at the hook and " +
        "'Task' in permission_denials for the SAME call, so neither name is safe to key on.",
      "The 'no agentId' and 'no subagent tokens' checks are session-wide string scans, so they are decisive only " +
        "in the single-target background arms; the selectivity arm legitimately contains the allowed agent's agentId.",
    );

    return state.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    state.verdict = "ERROR";
    state.notes = `probe crashed: ${truncate(error?.message ?? error, 400)}`;
    return 1;
  } finally {
    state.sessionsSpent = sessionsSpent;
    const path = writeResult(state);
    const rawPath = writeRaw(fixture);
    console.log(JSON.stringify(state, null, 2));
    console.log(`\nwrote ${path}\nwrote ${rawPath}  (live sessions spent: ${sessionsSpent}/${MAX_LIVE_SESSIONS})`);
    if (!flags.has("--keep-fixture")) rmSync(fixture.root, { recursive: true, force: true });
    else console.log(`fixture kept: ${fixture.root}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
