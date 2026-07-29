/**
 * PROBE E — can a PROGRAMMATIC `Options.hooks` PreToolUse hook enforce the
 * delegation shortlist, when `canUseTool` demonstrably cannot?
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Probe A measured, across three permission modes, that `canUseTool` is NEVER
 * consulted for the delegation tool in SDK 0.3.220: the callback returned
 * `{behavior:"deny"}` for `Agent` and `wordpress-master` STARTED ANYWAY, with
 * `denyConsulted=[]` in every arm. An apparatus control in the same option shape
 * had `canUseTool` fire normally for `Write`, so "the callback isn't wired" is
 * ruled out. The shortlist therefore cannot be enforced by `canUseTool`.
 *
 * Probe C established the candidate replacement: a programmatic `Options.hooks`
 * PreToolUse callback still fires under `managedSettings.allowManagedHooksOnly`,
 * which simultaneously suppresses project-tier AND flag-tier hooks. And
 * sdk.d.ts:4166 states verbatim: "PreToolUse hook denies bypass canUseTool".
 *
 * But probe C only ever exercised `Read`. Whether a PreToolUse hook fires for
 * the DELEGATION tool — and whether its deny actually STOPS the subagent — is
 * what this file measures. If it does not work, delegation discipline is
 * unenforceable in this SDK and the claim gets deleted rather than shipped as
 * dead code that reads like a boundary.
 *
 * THE ONE RULE: EVERY RUN MUST BE ABLE TO SHOW THE OPPOSITE OUTCOME
 * ─────────────────────────────────────────────────────────────────
 * "No `task_started`" is worthless on its own — it is equally consistent with
 * "the deny was honoured", "the model never tried to delegate", and
 * "`wordpress-master` did not resolve". So the ALLOW arms are load-bearing:
 * they must SHOW `task_started` carrying `subagent_type: "wordpress-master"`.
 * If they do not, this probe reports `negativeControlHeld=false`, verdict VOID,
 * and claims nothing.
 *
 * THE NAME OF THE DELEGATION TOOL IS AN UNKNOWN, NOT A FILTER
 * ────────────────────────────────────────────────────────────
 * The assistant-side `tool_use` block is named `Agent` (probe A raw log), but
 * the name the HOOK receives may differ (`Agent`, `Task`, or something else).
 * Filtering firings by name would report "never fired" when it did fire under a
 * name nobody grepped for. So every firing is recorded verbatim, and the
 * delegation call is identified by its INPUT SHAPE — `tool_input.subagent_type`
 * — which probe A's raw log confirms the payload carries. The literal
 * `tool_name` is then read OFF that firing and reported.
 *
 * MATCHER SEMANTICS
 * ─────────────────
 * Three matcher slots are registered in a single run to stay inside the session
 * budget: `"Agent"`, `"Task"`, and no matcher at all (which should match
 * everything). Firings are grouped by `tool_use_id`: if two slots fire for the
 * SAME call, the engine runs all matching matchers and a silent slot is real
 * evidence that its matcher did not match. If exactly one slot fires per call,
 * first-match-wins semantics cannot be excluded and the matcher reading is
 * reported as a CAVEAT rather than asserted.
 *
 * RUN ORDER IS ADAPTIVE, TO PROTECT THE OWNER'S QUOTA
 * ───────────────────────────────────────────────────
 * Hard cap: 6 live sessions for the whole probe; this plan uses at most 5.
 *
 *   1. allow / no lock   — answers Q1 (does it fire, under which matcher, what
 *                          literal name) AND Q3 (negative control) at once, and
 *                          doubles as its own apparatus proof.
 *      ↳ control did not start the subagent → VOID, stop. 1 session spent.
 *      ↳ fired for nothing at all → run the Read-based apparatus arm to tell
 *        "hook not wired in this option shape" (VOID) from "hook does not fire
 *        for delegation" (FAIL), then stop.
 *   2. deny  / no lock   — Q2.
 *   3. allow / lock      — the lock arm's own control.
 *   4. deny  / lock      — Q4.
 *
 * `results/E.json` is written on EVERY exit path, including the early bailouts.
 *
 * SubagentStart is registered in every run as an INDEPENDENT observable of "did
 * the subagent actually start", because `observe()`'s `task_started` bucketing
 * drops starts flagged `skip_transcript`. It is observation only:
 * `SubagentStartHookSpecificOutput` is `{ hookEventName, additionalContext? }`
 * (sdk.d.ts:6804) — there is NO `permissionDecision`, so SubagentStart is not a
 * fallback enforcement point and this probe does not treat it as one.
 *
 * Usage:  node probes/probe-e-agent-hook.mjs [--keep-fixture]
 *
 * RESULT OF THE 2026-07-28 RUN (4 live sessions, all four arms, verdict PASS —
 * full record in results/E.json, raw envelopes in results/raw/E-session-log.json):
 *
 *   - The hook FIRES for the delegation call. Literal `tool_name`: "Agent".
 *   - `permissionDecision:"deny"` STOPS the subagent: no `task_started`, no
 *     `SubagentStart`, and the reason comes back to the model as an is_error
 *     tool_result. Both allow controls DID start `wordpress-master`, so the
 *     absence in the deny arms is a measurement, not a silence.
 *   - It survives `managedSettings.allowManagedHooksOnly: true` — and the lock
 *     was verifiably active in those arms (the owner's user-tier session hooks,
 *     five `system/hook_started` envelopes in the unlocked arms, are absent).
 *   - All three matcher slots fired for the SAME `tool_use_id`, so the engine
 *     runs every matching matcher. Matcher "Task" matched a tool named "Agent".
 *   - NAMES DIFFER BY SURFACE: the hook input says "Agent" while the result
 *     message's `permission_denials` says "Task". Enforcement code should key on
 *     `tool_input.subagent_type`, not on either name.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
const RAW_DIR = join(RESULTS_DIR, "raw");

/**
 * Hard ceiling on a single CLI session, per spec. The owner's user-tier `Stop`
 * hook can block completion, and every run here loads user settings on purpose,
 * so a missing `result` is ambiguous between "the engine parked" and "a Stop
 * hook is still running". `timedOut` is therefore tracked separately and never
 * folded into a mechanism verdict.
 */
const HARD_TIMEOUT_MS = 90_000;

/** Session budget. Exceeding it is a bug, not a judgement call. */
const MAX_LIVE_SESSIONS = 6;
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

/** The delegation arms are VOID unless the model actually ATTEMPTS a delegation,
 *  so they get the model that reliably followed "use the Agent tool" in probe A.
 *  The apparatus arm only needs a file read and gets the cheap one. */
const MODEL_DELEGATION = "claude-sonnet-5";
const MODEL_CHEAP = "claude-haiku-4-5-20251001";

/** The delegation target. It exists in `~/.claude/agents/wordpress-master.md`
 *  (checked on disk), which is why every arm loads `settingSources: ["user"]`:
 *  without it the target would not resolve and BOTH arms would show no
 *  `task_started` for a reason that has nothing to do with hooks. */
const TARGET_AGENT = "wordpress-master";

const DELEGATION_PROMPT =
  "Use the Agent tool to delegate to the `wordpress-master` subagent: have it reply " +
  "with the single word OK. Do not do the work yourself.";

const ORDINARY_TEXT = "this file is not sealed";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

function makeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "probe-e-")));
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

/** Fold one SDK message into the observation record. */
function observe(obs, message) {
  obs.envelopes.push(`${message.type}${message.subtype ? `/${message.subtype}` : ""}`);

  if (message.type === "system" && message.subtype === "init") {
    obs.init = {
      model: message.model ?? null,
      permissionMode: message.permissionMode ?? null,
      toolCount: (message.tools ?? []).length,
      agentCount: (message.agents ?? []).length,
    };
  }

  // `task_started` is not subagent-only: background Bash and ambient
  // housekeeping tasks share the envelope. Only starts carrying a
  // `subagent_type` count as delegations. `skip_transcript` starts are kept
  // SEPARATELY rather than dropped — a denied-then-retried delegation that came
  // back flagged ambient would otherwise read as "the deny worked".
  if (message.type === "system" && message.subtype === "task_started") {
    if (message.subagent_type) {
      (message.skip_transcript ? obs.skipTranscriptSubagentStarts : obs.subagentStarts).push(
        message.subagent_type,
      );
    } else {
      obs.otherTaskStarts.push(message.task_type ?? "unknown");
    }
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
          obs.toolUses.push({ name: block.name, input: block.input ?? {} });
        }
      }
    }
  }

  // Tool RESULTS arrive as user messages — this is where a deny's error text
  // lands, whether or not the model repeats it back.
  if (message.type === "user") obs.transcript += safeStringify(message.message?.content);

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
    init: null,
    envelopes: [],
    toolUses: [],
    subagentStarts: [],
    skipTranscriptSubagentStarts: [],
    otherTaskStarts: [],
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
    envelopes: obs.envelopes,
    init: obs.init,
    toolUses: obs.toolUses.map((u) => ({ name: u.name, input: truncate(safeStringify(u.input), 500) })),
    subagentStarts: obs.subagentStarts,
    skipTranscriptSubagentStarts: obs.skipTranscriptSubagentStarts,
    otherTaskStarts: obs.otherTaskStarts,
    denials: obs.denials,
    hookState: hookState ?? null,
    sawResult: obs.sawResult,
    resultSubtype: obs.resultSubtype,
    numTurns: obs.numTurns,
    timedOut: obs.timedOut,
    error: obs.error,
    transcriptExcerpt: truncate(obs.transcript, 2000),
  });

  return obs;
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook apparatus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A firing record. Deliberately name-agnostic: `toolName` is DATA, never a
 * filter. `hasSubagentType` is how a delegation call is recognised.
 */
function recordFiring(state, slot, input, toolUseID) {
  const toolInput = input?.tool_input ?? {};
  const subagentType =
    toolInput && typeof toolInput === "object" ? (toolInput.subagent_type ?? null) : null;
  state.firings.push({
    slot,
    toolName: input?.tool_name ?? null,
    toolUseId: input?.tool_use_id ?? toolUseID ?? null,
    subagentType,
    // `agent_id` is present ONLY when the hook fires from inside a subagent
    // (sdk.d.ts:174). A firing carrying it is independent proof a subagent ran.
    firedInsideSubagent: Boolean(input?.agent_id),
    insideAgentType: input?.agent_id ? (input?.agent_type ?? null) : null,
    inputExcerpt: truncate(safeStringify(toolInput), 300),
  });
}

const DENY_REASON = "probe E: subagent is not on the delegation shortlist";

/**
 * Build the `Options.hooks` block.
 *
 * Slot order is specific-first (`"Agent"`, `"Task"`, then no matcher). Under
 * all-matchers-run semantics that ordering is irrelevant; under
 * first-match-wins it is what makes a specific matcher's firing informative.
 *
 * EVERY slot applies the same decision, so the arm's outcome does not depend on
 * WHICH slot the engine happens to route through — otherwise a null result would
 * be ambiguous between "deny is ignored" and "the denying slot never matched".
 *
 * ALLOW arms return `{ continue: true }` — hook present, no opinion. That is the
 * null intervention, which is what makes it a control rather than a second
 * experiment. The legacy `decision: 'approve'|'block'` field is not touched.
 */
function buildHooks(state, { deny }) {
  const decide = async (slot, input, toolUseID) => {
    recordFiring(state, slot, input, toolUseID);
    const toolInput = input?.tool_input ?? {};
    const isDelegation =
      (toolInput && typeof toolInput === "object" && "subagent_type" in toolInput) ||
      input?.tool_name === "Agent" ||
      input?.tool_name === "Task";
    if (deny && isDelegation) {
      state.denialsIssued.push({ slot, toolName: input?.tool_name ?? null });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DENY_REASON,
        },
      };
    }
    return { continue: true };
  };

  return {
    PreToolUse: [
      { matcher: "Agent", hooks: [async (i, id) => decide("matcher:Agent", i, id)] },
      { matcher: "Task", hooks: [async (i, id) => decide("matcher:Task", i, id)] },
      { hooks: [async (i, id) => decide("matcher:none", i, id)] },
    ],
    // Observation only — no permissionDecision exists on this event's output.
    SubagentStart: [
      {
        hooks: [
          async (input) => {
            state.subagentStartHook.push({
              agentType: input?.agent_type ?? null,
              agentId: input?.agent_id ? "present" : null,
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
// Readers over a finished arm
// ─────────────────────────────────────────────────────────────────────────────

/** Firings that carry a `subagent_type` input — the delegation call, whatever
 *  the engine calls it. */
function delegationFirings(state) {
  return state.firings.filter((f) => f.subagentType !== null);
}

/** The literal `tool_name` the hook received for the delegation call. */
function observedToolNames(state) {
  return [...new Set(delegationFirings(state).map((f) => f.toolName ?? "null"))];
}

/** Did the model EMIT a delegation tool_use? Assistant-side, emitted before the
 *  hook runs, so it is observable even when the call is denied. Without this,
 *  "no subagent started" cannot be told from "the model never tried". */
function agentAttempted(obs) {
  return obs.toolUses.some(
    (u) =>
      u.name === "Agent" ||
      u.name === "Task" ||
      (u.input && typeof u.input === "object" && "subagent_type" in u.input),
  );
}

/** Did the requested subagent ACTUALLY start? Three independent observables,
 *  OR-ed, so a negative reading is not an artifact of one channel. */
function subagentStarted(obs, state) {
  const fromTaskStarted =
    obs.subagentStarts.includes(TARGET_AGENT) ||
    obs.skipTranscriptSubagentStarts.includes(TARGET_AGENT);
  const fromHook = state.subagentStartHook.some((s) => s.agentType === TARGET_AGENT);
  const fromInsideFiring = state.firings.some((f) => f.firedInsideSubagent);
  return { started: fromTaskStarted || fromHook || fromInsideFiring, fromTaskStarted, fromHook, fromInsideFiring };
}

function armSummary(obs, state) {
  const started = subagentStarted(obs, state);
  return {
    label: obs.label,
    model: obs.init?.model ?? null,
    permissionMode: obs.init?.permissionMode ?? null,
    hookFiredAtAll: state.firings.length > 0,
    hookFiringSlots: [...new Set(state.firings.map((f) => f.slot))],
    hookToolNamesSeen: [...new Set(state.firings.map((f) => f.toolName ?? "null"))],
    delegationFiringCount: delegationFirings(state).length,
    delegationToolNames: observedToolNames(state),
    denialsIssuedByHook: state.denialsIssued.length,
    agentToolUseEmitted: agentAttempted(obs),
    subagentStarted: started.started,
    startedVia: {
      taskStarted: started.fromTaskStarted,
      subagentStartHook: started.fromHook,
      firingInsideSubagent: started.fromInsideFiring,
    },
    taskStartedSubagentTypes: obs.subagentStarts,
    skipTranscriptSubagentTypes: obs.skipTranscriptSubagentStarts,
    otherTaskStarts: obs.otherTaskStarts,
    systemPermissionDenied: obs.denials,
    resultSubtype: obs.resultSubtype,
    numTurns: obs.numTurns,
    timedOut: obs.timedOut,
    error: obs.error,
    denyReasonEchoedInTranscript: obs.transcript.includes(DENY_REASON),
  };
}

/**
 * Matcher semantics. If two slots fire for the SAME `tool_use_id`, the engine
 * runs every matching matcher and a silent slot really did not match. If not,
 * first-match-wins cannot be excluded and the reading is a caveat, not a claim.
 */
function matcherSemantics(state) {
  const byCall = new Map();
  for (const f of state.firings) {
    const key = f.toolUseId ?? "unknown";
    if (!byCall.has(key)) byCall.set(key, new Set());
    byCall.get(key).add(f.slot);
  }
  const maxSlotsPerCall = Math.max(0, ...[...byCall.values()].map((s) => s.size));
  return {
    allMatchersRun: maxSlotsPerCall > 1,
    maxSlotsPerCall,
    perCall: [...byCall.entries()].map(([id, slots]) => ({ toolUseId: id, slots: [...slots] })),
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
    permissionMode: "acceptEdits",
    includePartialMessages: false,
    tools: { type: "preset", preset: "claude_code" },
    // Production parity, and the reason `wordpress-master` resolves at all.
    settingSources: ["user"],
    // Bound whatever the subagent does when an allow arm actually starts one.
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: [fixture.workspace] },
    },
    env: probeEnv(),
  };
}

async function delegationArm(fixture, { label, deny, lock }) {
  const state = freshHookState();
  const options = {
    ...baseOptions(fixture, { model: MODEL_DELEGATION, maxTurns: deny ? 8 : 6 }),
    hooks: buildHooks(state, { deny }),
  };
  if (lock) options.managedSettings = { allowManagedHooksOnly: true };
  const obs = await runSession({ label, prompt: DELEGATION_PROMPT, options, hookState: state });
  return { obs, state, summary: armSummary(obs, state) };
}

/**
 * APPARATUS ARM — run ONLY if arm 1 recorded no firing whatsoever.
 *
 * It is what separates "the hook does not fire for delegation" (FAIL: a real,
 * shippable finding) from "hooks are not wired in this option shape at all"
 * (VOID: measured nothing). Same option shape, cheap model, one file read.
 */
async function apparatusArm(fixture) {
  const state = freshHookState();
  const options = {
    ...baseOptions(fixture, { model: MODEL_CHEAP, maxTurns: 4 }),
    hooks: buildHooks(state, { deny: false }),
  };
  const obs = await runSession({
    label: "E/apparatus-read",
    prompt: `Read the file ${fixture.ordinaryFile} and print its contents. Use no other tool.`,
    options,
    hookState: state,
  });
  return { obs, state, summary: armSummary(obs, state) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result plumbing — E.json is written on every exit path
// ─────────────────────────────────────────────────────────────────────────────

function writeResult(result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, "E.json");
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

function writeRaw(fixture) {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(
    join(RAW_DIR, "E-session-log.json"),
    `${JSON.stringify(
      { ranAt: new Date().toISOString(), fixture: fixture.root, sessionsSpent, sessions: SESSION_LOG },
      null,
      2,
    )}\n`,
  );
}

const NO_NAME = "NONE (no PreToolUse firing carried a subagent_type input)";

async function main(argv) {
  const flags = new Set(argv);
  const fixture = makeFixture();

  /** Everything the verdict reads. Mutated as arms complete; written out in
   *  `finally` so an early bail or a crash still leaves a durable E.json. */
  const state = {
    probe: "E",
    question: "Does a programmatic Options.hooks PreToolUse hook fire for the delegation tool, and does its deny stop the subagent?",
    sdkVersion: "0.3.220",
    hookFiresForAgent: false,
    denyStopsSubagent: false,
    negativeControlHeld: false,
    worksUnderHookLockdown: false,
    verdict: "ERROR",
    toolNameObserved: NO_NAME,
    matcherSemantics: null,
    matcherVerdict: null,
    arms: {},
    sessionsSpent: 0,
    notes: "probe did not complete",
    caveats: [],
  };

  try {
    // ── ARM 1: allow, no lock. Q1 + Q3 + apparatus, in one session. ─────────
    const allowOpen = await delegationArm(fixture, {
      label: "E/allow/no-lock",
      deny: false,
      lock: false,
    });
    state.arms.allowNoLock = allowOpen.summary;
    state.matcherSemantics = matcherSemantics(allowOpen.state);

    const openFirings = delegationFirings(allowOpen.state);
    state.hookFiresForAgent = openFirings.length > 0;
    if (openFirings.length > 0) state.toolNameObserved = observedToolNames(allowOpen.state).join(",");
    state.negativeControlHeld = allowOpen.summary.subagentStarted;

    // ── BAIL 1: the control could not start the subagent. Measured nothing. ──
    if (!state.negativeControlHeld) {
      state.verdict = "VOID";
      state.notes =
        `NEGATIVE CONTROL FAILED. The allow arm (hook present, returning {continue:true}, no lock) did NOT start ` +
        `${TARGET_AGENT}: no task_started carried it, the SubagentStart hook never fired for it, and no PreToolUse ` +
        `firing came from inside a subagent. agentToolUseEmitted=${allowOpen.summary.agentToolUseEmitted}. ` +
        `Without a demonstrated start, an absent start in a deny arm is indistinguishable from "the model never ` +
        `delegated", so NO claim about hook enforcement is made. This probe proves nothing; re-run before deciding.`;
      state.caveats.push("negativeControlHeld=false — the deny arms were never run, on purpose, to protect quota.");
      return 1;
    }

    // ── BAIL 2: the hook never fired at all. FAIL vs VOID needs apparatus. ──
    if (!allowOpen.summary.hookFiredAtAll) {
      const apparatus = await apparatusArm(fixture);
      state.arms.apparatusRead = apparatus.summary;
      if (apparatus.summary.hookFiredAtAll) {
        state.verdict = "FAIL";
        state.notes =
          `The programmatic PreToolUse hook DID fire in this exact option shape for ` +
          `[${apparatus.summary.hookToolNamesSeen.join(",")}], but fired for NOTHING in the delegation arm even ` +
          `though the subagent demonstrably started. PreToolUse does not see the delegation tool: the shortlist ` +
          `cannot be enforced this way either.`;
      } else {
        state.verdict = "VOID";
        state.notes =
          "The hook fired for no tool in EITHER arm, so the apparatus itself is not wired in this option shape. " +
          "Nothing was measured about the delegation tool.";
        state.caveats.push("Apparatus arm recorded zero firings — hooks may not be wired here at all.");
      }
      return 1;
    }

    // ── BAIL 3: fired, but never for the delegation call. Real finding. ─────
    if (!state.hookFiresForAgent) {
      state.verdict = "FAIL";
      state.notes =
        `The hook fired for [${allowOpen.summary.hookToolNamesSeen.join(",")}] but NEVER for the delegation call, ` +
        `even though ${TARGET_AGENT} demonstrably started in the same run. PreToolUse does not intercept ` +
        `delegation in SDK 0.3.220.`;
      return 1;
    }

    // ── ARM 2: deny, no lock. Q2. ───────────────────────────────────────────
    const denyOpen = await delegationArm(fixture, { label: "E/deny/no-lock", deny: true, lock: false });
    state.arms.denyNoLock = denyOpen.summary;
    state.denyStopsSubagent =
      denyOpen.summary.agentToolUseEmitted &&
      denyOpen.summary.denialsIssuedByHook > 0 &&
      !denyOpen.summary.subagentStarted;

    // ── ARM 3: allow, WITH the lock. The lock arm's own control. ────────────
    const allowLocked = await delegationArm(fixture, { label: "E/allow/locked", deny: false, lock: true });
    state.arms.allowLocked = allowLocked.summary;

    // ── ARM 4: deny, WITH the lock. Q4. ─────────────────────────────────────
    const denyLocked = await delegationArm(fixture, { label: "E/deny/locked", deny: true, lock: true });
    state.arms.denyLocked = denyLocked.summary;

    const lockControlHeld = allowLocked.summary.subagentStarted;
    state.worksUnderHookLockdown =
      lockControlHeld &&
      denyLocked.summary.delegationFiringCount > 0 &&
      denyLocked.summary.agentToolUseEmitted &&
      denyLocked.summary.denialsIssuedByHook > 0 &&
      !denyLocked.summary.subagentStarted;

    // ── Verdict ─────────────────────────────────────────────────────────────
    const transportError = Object.values(state.arms).some((a) => a.error);
    if (transportError) {
      state.verdict = "ERROR";
      state.notes = "At least one arm raised a transport error; the arms are not comparable.";
    } else if (!lockControlHeld) {
      state.verdict = "VOID";
      state.notes =
        "The LOCKED control arm did not start the subagent, so the locked deny arm's silence measures nothing " +
        "about the lock. The unlocked arms are still valid and are reported above.";
      state.caveats.push("worksUnderHookLockdown is not evidence: its control failed.");
    } else if (state.hookFiresForAgent && state.denyStopsSubagent && state.worksUnderHookLockdown) {
      state.verdict = "PASS";
      state.notes =
        `A programmatic Options.hooks PreToolUse hook FIRES for the delegation tool (literal tool_name: ` +
        `${state.toolNameObserved}) and permissionDecision:"deny" PREVENTS the subagent from starting — with and ` +
        `without managedSettings.allowManagedHooksOnly. Both allow controls started ${TARGET_AGENT}, so the ` +
        `absence in the deny arms is informative. This is a usable enforcement point where canUseTool is not.`;
    } else {
      state.verdict = "FAIL";
      state.notes =
        `Hook fires for the delegation tool (${state.toolNameObserved}) but the deny did not hold: ` +
        `denyStopsSubagent=${state.denyStopsSubagent}, worksUnderHookLockdown=${state.worksUnderHookLockdown}. ` +
        `Deny arm started=[${denyOpen.summary.taskStartedSubagentTypes.join(",")}], locked deny arm started=` +
        `[${denyLocked.summary.taskStartedSubagentTypes.join(",")}].`;
    }

    // Matcher reading — only ever a caveat when semantics are unresolved.
    const slots = new Set(
      [allowOpen, denyOpen, allowLocked, denyLocked].flatMap((arm) =>
        delegationFirings(arm.state).map((f) => f.slot),
      ),
    );
    state.matcherVerdict = {
      slotsThatFiredForDelegation: [...slots],
      allMatchersRunConfirmed: state.matcherSemantics?.allMatchersRun ?? false,
    };
    if (!state.matcherSemantics?.allMatchersRun) {
      state.caveats.push(
        "Only one matcher slot fired per tool_use_id, so first-match-wins semantics cannot be excluded: a silent " +
          "slot is NOT proof that its matcher fails to match. Slot order was Agent, Task, none.",
      );
    }

    return state.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    state.verdict = "ERROR";
    state.notes = `probe crashed: ${truncate(error?.message ?? error, 300)}`;
    return 1;
  } finally {
    state.sessionsSpent = sessionsSpent;
    const path = writeResult(state);
    writeRaw(fixture);
    console.log(JSON.stringify(state, null, 2));
    console.log(`\nwrote ${path}  (live sessions spent: ${sessionsSpent}/${MAX_LIVE_SESSIONS})`);
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
