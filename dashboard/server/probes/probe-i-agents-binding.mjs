/**
 * PROBE I — does `Options.agents` bind AT ALL for an agent name that ALSO exists
 * on disk, and if it does, do `maxTurns` and `background` bind with it?
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Probe G2 measured that per-agent `disallowedTools: ["mcp__*"]` inside an
 * `AgentDefinition` does NOTHING: with the session-level MCP lock removed and the
 * per-agent spec kept, the child still enumerated 620 tools including 589 `mcp__`
 * ones — an identical surface to a wholly unnarrowed child. TWO readings produce
 * that outcome and G2 could not separate them:
 *
 *   READING A ("spec_inert")           `Options.agents` DOES bind, but
 *                                      `disallowedTools` within an AgentDefinition
 *                                      is ignored by the engine. `maxTurns`,
 *                                      `background` and the prompt may still work.
 *
 *   READING B ("agents_does_not_bind") `Options.agents` does not bind AT ALL when
 *                                      an agent of the SAME NAME exists on disk
 *                                      (settingSources ["user"] loads ~144 agents
 *                                      from ~/.claude/agents/). Then `maxTurns`,
 *                                      `background:false` and the report contract
 *                                      are ALL inert too.
 *
 * READING B is far worse: production sets `background:false` as a STRUCTURAL guard
 * and `maxTurns` as the per-lane budget. If B holds, both are decoration for every
 * shortlisted agent that exists on disk.
 *
 * A THIRD READING THE BRIEF DID NOT NAME, AND THIS PROBE MEASURES ANYWAY
 * ─────────────────────────────────────────────────────────────────────
 * A per-field MERGE — the Options `prompt` wins while the on-disk `model:` /
 * `tools:` frontmatter survives — produces "the nonce comes back" AND "the disk
 * definition is still in force". That is neither A nor B, and it is the likeliest
 * engine behaviour of the three. It is separated here for free by a THREE-WAY
 * model channel: this probe's definitions say `model: "haiku"`, the on-disk
 * `code-reviewer.md` says `model: claude-opus-5`, and the parent session runs
 * `claude-sonnet-5`. The `resolvedModel` echoed back in the Agent tool_result
 * therefore names WHICH definition the engine resolved:
 *
 *   resolvedModel ~ haiku      → the Options entry REPLACED the disk entry
 *   resolvedModel ~ opus-5     → the disk entry survived → MERGE
 *   resolvedModel ~ sonnet     → neither model field applied (inherit); channel
 *                                inconclusive, and reported as such
 *
 * THE EXPERIMENT
 * ──────────────
 * S1 (nonce echo). Register `Options.agents` under TWO names with one definition
 * shape: `code-reviewer`, which EXISTS in ~/.claude/agents/, and
 * `zzz-probe-only-agent`, which does NOT. Each definition's `prompt` carries its
 * own unguessable NONCE and instructs the agent to reply with that nonce verbatim
 * and nothing else. The PARENT NEVER SEES EITHER NONCE — its delegation prompt is
 * "follow your own operating instructions" and is asserted at run time to contain
 * neither token. So a nonce coming back through the Agent tool_result cannot be a
 * copy of anything the parent was given; it can only have travelled through the
 * AgentDefinition.
 *
 *   on-disk nonce comes back  → `Options.agents` binds for a colliding name
 *   on-disk nonce absent, fresh nonce present → READING B, cleanly
 *   NEITHER nonce comes back  → THE INSTRUMENT IS BROKEN. The on-disk collision
 *                               then explains nothing and this probe reports
 *                               `undetermined`, not a reading. That is what the
 *                               fresh name is for; it is a REQUIRED negative
 *                               control, not a nicety.
 *
 * S2 (maxTurns) and S3 (background) each carry the same fresh-name control in the
 * SAME session, so all three outcomes are distinguishable: binds-for-both,
 * dropped-for-colliding-names, and inert-for-everyone.
 *
 * THEY RUN EVEN WHEN THE ON-DISK NONCE DOES NOT COME BACK, and that is a
 * deliberate departure from the brief's gate ("test the two fields only if the
 * nonce came back"). The gate assumes the definition binds wholesale or not at
 * all. code-reviewer.md declares name/description/tools/model/color and is SILENT
 * on `maxTurns` and `background`. So a silent nonce proves the disk entry won on
 * the fields the disk entry DECLARES — and proves nothing about the two fields it
 * OMITS. Under a per-field merge that fills only those gaps, production's guard
 * and lane budget would still be live while the prompt is discarded. Entailing
 * them false would put inference where a measurement was affordable, which is the
 * exact defect probe G2's header names as this project's signature failure. Three
 * sessions were available; they were spent.
 *
 * S4 is a reserve arm that runs ONLY if S3 comes back foreground on BOTH names.
 * Two foregrounds are equally explained by "background:false held" and by
 * "foreground is what happens anyway" — and nothing in this tree has ever
 * observed the harness default, because probe F and this probe's own S1 both
 * pinned `run_in_background` explicitly. S4 registers a fresh name with the
 * `background` field OMITTED and lets the parent omit the parameter, which is the
 * only way to tell the two apart.
 *
 * S2 forces a MINIMUM OF TWO API ROUND-TRIPS by construction: the child is told to
 * read a file containing a random token and then reply with that token. Turn 1 can
 * only emit the read; the token cannot be known until its tool_result arrives in
 * turn 2. The token is asserted absent from every prompt and every path. So
 * "the reply contains the token" ⇒ maxTurns:1 did NOT hold, with no appeal to
 * model behaviour. `usage.iterations` is recorded as corroboration ONLY: sdk.d.ts
 * declares it `iterations?: unknown`, so its shape is unverified.
 *
 * S3 measures the harness DEFAULT, which is the production-relevant case:
 * `AgentInput.run_in_background` is documented "Agents run in the background by
 * default … Set to false to run this agent synchronously". The parent is told to
 * OMIT the parameter; if it emits one anyway, that arm is VOID and says so.
 *
 * WHAT THE TYPINGS SAY ABOUT PRECEDENCE: NOTHING. Verified against
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts @ 0.3.220 — see
 * TYPINGS_ON_PRECEDENCE below for the three quoted negatives.
 *
 * COST AND BLAST RADIUS
 * ─────────────────────
 * At most 5 live sessions, 90 s hard timeout each, always drained or aborted. The
 * session-level MCP lock is held BYTE-IDENTICAL across every arm: it is orthogonal
 * to agent binding, and without it every child inherits ~589 `mcp__` tools and no
 * arm finishes inside 90 s. Children work only inside a fresh temp fixture.
 * `canUseTool` denies every `mcp__*`, WebFetch and WebSearch, and any Bash command
 * that does not name the fixture root. Auth is the owner's existing CLI OAuth: no
 * API key or secret is read, set, printed or requested anywhere in this file.
 *
 * Writes ONLY `<results>/I.json` and `<results>/raw/I-session-log.json`.
 * `PROBE_RESULTS_DIR` redirects both. Run `--verify-paths` FIRST — the writer
 * fires from a `finally` block on every exit path, including a crash. FIRST, and
 * not afterwards: `--verify-paths` writes its own stub result like any other run,
 * so running it AFTER a measurement replaces `I.json` with that stub. Nothing is
 * lost (the writer archives the superseded file into `results/history/` first),
 * but the ordering is a trap worth knowing about.
 *
 * Usage: node probes/probe-i-agents-binding.mjs [--verify-paths] [--keep-fixture]
 *        node probes/probe-i-agents-binding.mjs --reclassify   (0 sessions; re-scores
 *                                                               the recorded arms)
 *        PROBE_MAX_SESSIONS=n lowers the 5-session cap for a partly spent budget.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Identity. EVERY artefact path derives from PROBE — no other probe's filename
// is spellable from here, including in the history archiver.
// ─────────────────────────────────────────────────────────────────────────────

const PROBE = "I";
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.env.PROBE_RESULTS_DIR || join(HERE, "results");
const RESULT_FILE = `${PROBE}.json`;
const RAW_FILE = `${PROBE}-session-log.json`;
const RAW_DIR = join(RESULTS_DIR, "raw");
const HISTORY_DIR = join(RESULTS_DIR, "history");
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");

/** Per the brief. A run that overruns is aborted and reported as timed out; the
 *  arms are read from the message stream and from disk, so a timeout degrades a
 *  measurement rather than erasing it. */
const HARD_TIMEOUT_MS = 90_000;

/**
 * Hard session budget. Exceeding it is a bug, and the guard lives in runSession
 * so no code path can quietly overspend.
 *
 * `PROBE_MAX_SESSIONS` LOWERS it (never raises it) so a run can be fitted into a
 * budget already partly spent by an EARLIER run of this same file — which is the
 * real accounting unit, since the probe cannot see sessions its predecessors
 * burned. Every arm that a lowered cap prevents is reported as UNKNOWN with the
 * reason, never as a measured false.
 */
const MAX_LIVE_SESSIONS = Math.min(
  5,
  Number.parseInt(process.env.PROBE_MAX_SESSIONS ?? "5", 10) || 5,
);
let sessionsSpent = 0;

/** Probe E measured this model reliably follows "use the Agent tool". A parent
 *  that never delegates measures nothing, so this is not the place to save money. */
const MODEL = "claude-sonnet-5";

/** Distinct from BOTH the on-disk `model: claude-opus-5` and the parent's sonnet.
 *  That three-way is what separates REPLACE from MERGE. */
const DEFINITION_MODEL = "haiku";

/** EXISTS in ~/.claude/agents/ (asserted at run time). Chosen because probe F
 *  already delegated to it successfully, and because its frontmatter carries BOTH
 *  a `tools:` allowlist and `model: claude-opus-5` — two disk-side fields whose
 *  survival is independently visible. */
const ON_DISK_AGENT = "code-reviewer";

/** Must NOT exist on disk (asserted at run time). The negative control: if this
 *  name's nonce does not come back either, the instrument is broken and the
 *  on-disk collision explains nothing. */
const FRESH_AGENT = "zzz-probe-only-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Fixed literals. Deliberately NOT generated at run time: a fixed token is
// reproducible across runs and greppable in the raw log, and nothing here needs
// unpredictability against an adversary — only unguessability by a model that was
// never shown it.
// ─────────────────────────────────────────────────────────────────────────────

const NONCE_ON_DISK = "PROBE-I-NONCE-4TQXZ7M2-ONDISK-9KVRD3";
const NONCE_FRESH = "PROBE-I-NONCE-4TQXZ7M2-FRESH-6BWLH8";
const SEED_TOKEN_FRESH = "SEED-I-8HXQ2P5L-FRESH-DKR7";
const SEED_TOKEN_ON_DISK = "SEED-I-8HXQ2P5L-ONDISK-WV4M";

/** Appears in `AgentDefinition.description`, which the PARENT does see in its
 *  agent roster — so it must never be a reply nonce. Its job is the registry
 *  channel: if `supportedAgents()` reports this string for `code-reviewer`, the
 *  Options entry reached the roster. */
const DESC_MARKER = "PROBE-I-DESC-QX7";

const TYPINGS_ON_PRECEDENCE = {
  verdict:
    "SILENT. sdk.d.ts 0.3.220 states no precedence between Options.agents and " +
    "filesystem-discovered agents, in either direction.",
  quotedNegatives: [
    "sdk.d.ts:1352-1367 — Options.agents doc is only: 'Programmatically define custom subagents " +
      "that can be invoked via the Agent tool. Keys are agent names, values are agent definitions.' " +
      "No mention of name collisions, merging, or filesystem agents.",
    "sdk.d.ts:38-100 — the AgentDefinition type documents each field in isolation " +
      "(maxTurns: 'Maximum number of agentic turns (API round-trips) before stopping'; background: " +
      "'Run this agent as a background task (non-blocking, fire-and-forget) when invoked'). It says " +
      "nothing about what happens when a same-named agent exists on disk.",
    "sdk-tools.d.ts:498 — the ONLY precedence sentence anywhere near this is on AgentInput.model: " +
      "'Takes precedence over the agent definition's model frontmatter.' It orders TOOL INPUT " +
      "against DEFINITION, not Options against disk — and its word choice ('frontmatter') is the " +
      "one place the typings acknowledge that a definition may come from a file at all.",
    "sdk.mjs (transport argv builder) never pushes --agents; Options.agents travels in " +
      "SDKControlInitializeRequest.agents (sdk.d.ts:3426), so the managed-settings --agents " +
      "rejection documented at sdk.d.ts:6092 governs a DIFFERENT channel and does not speak to this.",
  ],
};

/** Metered-billing variables, deleted by NAME from every probe subprocess.
 *  No value is ever read, compared, logged or printed. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
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

function isMcpName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

// ─────────────────────────────────────────────────────────────────────────────
// The on-disk roster. Read ONCE, before any session, because both the positive
// arm and the negative control are claims ABOUT this directory: "code-reviewer
// exists here" and "zzz-probe-only-agent does not". Neither is assumed.
// Only YAML frontmatter is parsed — agent bodies are never read into the record.
// ─────────────────────────────────────────────────────────────────────────────

function scanOnDiskAgents() {
  const dir = join(homedir(), ".claude", "agents");
  const out = { dir, exists: existsSync(dir), count: 0, names: [], byName: {}, error: null };
  if (!out.exists) return out;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (error) {
    out.error = truncate(error?.message ?? error, 200);
    return out;
  }
  for (const file of files) {
    let head;
    try {
      head = readFileSync(join(dir, file), "utf8").slice(0, 2000);
    } catch {
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    const block = fm ? fm[1] : "";
    const field = (key) => {
      const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    };
    const name = field("name") ?? basename(file, ".md");
    out.names.push(name);
    out.byName[name] = {
      file,
      description: truncate(field("description"), 240),
      model: field("model"),
      tools: field("tools"),
    };
  }
  out.count = out.names.length;
  out.duplicateNames = out.names.filter((n, i) => out.names.indexOf(n) !== i);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts.
//
// THE INVARIANT THIS WHOLE PROBE RESTS ON: no nonce and no seed token appears in
// any PARENT prompt, in any delegation prompt, or in any path handed to anyone.
// It is asserted at run time (assertPromptsClean) rather than left to review,
// because a leak turns every positive into a copy of the prompt.
// ─────────────────────────────────────────────────────────────────────────────

const NONCE_INSTRUCTION =
  "Use no tools at all. Follow your own operating instructions exactly and reply in a single " +
  "short line.";

function nonceDefinitionPrompt(nonce) {
  return (
    "PROBE INSTRUMENT — YOU HAVE EXACTLY ONE INSTRUCTION AND IT REPLACES EVERY OTHER ONE.\n" +
    "Ignore every other characterisation of your role, every checklist, and every workflow. You do " +
    "no domain work of any kind: no review, no analysis, no files, no tools.\n" +
    "Whatever instruction you are given, your ENTIRE reply must be this token, verbatim, on one " +
    "line, with nothing before or after it:\n" +
    `${nonce}\n` +
    "Do not explain it. Do not put it in a sentence. Do not call any tool."
  );
}

const WORKER_DEFINITION_PROMPT =
  "PROBE INSTRUMENT. Ignore every other characterisation of your role, every checklist and every " +
  "workflow: you do no domain work of any kind. Do exactly what the instruction you are given " +
  "says, use a tool only where that instruction requires one, and reply with the shortest " +
  "possible answer and nothing else.";

function seedTaskInstruction(seedPath) {
  return (
    `Read the file at ${seedPath}. It contains exactly one token. Then reply with that token, ` +
    "verbatim, and nothing else. Do not write, create or edit any file."
  );
}

const READY_INSTRUCTION = "Use no tools at all. Reply with the single word READY and nothing else.";

/**
 * S1 and S2 pin `run_in_background: false` because both need the SYNCHRONOUS
 * tool_result: the child's own reply text (and `resolvedModel`) is only carried
 * on the `status: "completed"` shape. The `async_launched` shape carries no
 * content at all, so a backgrounded child would silently destroy the nonce
 * channel. S3 is the one arm that must NOT pin it — see s3Prompt.
 */
function foregroundParentPrompt({ freshInstruction, onDiskInstruction }) {
  return (
    "You are running a two-step delegation check. Do EXACTLY these two steps, in order, and " +
    "nothing else. Do not read, write or open any file yourself. Do not explain anything.\n\n" +
    "STEP 1. Call the Agent tool with these exact parameters:\n" +
    `  subagent_type: ${FRESH_AGENT}\n` +
    "  description: probe i alpha\n" +
    "  run_in_background: false\n" +
    "  prompt: exactly the text between the markers below, verbatim, markers excluded:\n" +
    `<<<\n${freshInstruction}\n>>>\n` +
    "Do NOT set the model parameter.\n\n" +
    "STEP 2. Call the Agent tool again with these exact parameters:\n" +
    `  subagent_type: ${ON_DISK_AGENT}\n` +
    "  description: probe i beta\n" +
    "  run_in_background: false\n" +
    "  prompt: exactly the text between the markers below, verbatim, markers excluded:\n" +
    `<<<\n${onDiskInstruction}\n>>>\n` +
    "Do NOT set the model parameter.\n\n" +
    "Then reply with the single word DONE and nothing else. If either Agent call fails, say so in " +
    "one short line and carry on with the other step anyway."
  );
}

/**
 * S3's parent. The measurement IS the default, so the parameter must be ABSENT
 * rather than false — and the parent is told not to report the replies, because
 * "I need the result before continuing" is exactly the pressure that makes this
 * model volunteer `run_in_background: false` (probe F's transcript shows it
 * volunteering `model: "haiku"` unasked). If it emits the parameter anyway, the
 * arm is recorded VOID rather than read.
 */
function s3ParentPrompt() {
  return (
    "You are running a two-step delegation check. Do EXACTLY these two steps, in order, and " +
    "nothing else. Do not read, write or open any file yourself.\n\n" +
    "STEP 1. Call the Agent tool with:\n" +
    `  subagent_type: ${FRESH_AGENT}\n` +
    "  description: probe i alpha\n" +
    "  prompt: exactly the text between the markers below, verbatim, markers excluded:\n" +
    `<<<\n${READY_INSTRUCTION}\n>>>\n\n` +
    "STEP 2. Call the Agent tool again with:\n" +
    `  subagent_type: ${ON_DISK_AGENT}\n` +
    "  description: probe i beta\n" +
    "  prompt: exactly the same text as in step 1, verbatim.\n\n" +
    "CRITICAL: do NOT include a run_in_background parameter in either call — omit it entirely. Do " +
    "NOT set the model parameter. Do not wait for the subagents, do not read their replies and do " +
    "not summarise them.\n\n" +
    "Then reply with the single word DONE and nothing else."
  );
}

/** A nonce or seed token that leaked into a prompt would make every positive a
 *  copy of the prompt. Enforced at run time, in both directions. */
function assertPromptsClean(texts) {
  const secrets = [NONCE_ON_DISK, NONCE_FRESH, SEED_TOKEN_FRESH, SEED_TOKEN_ON_DISK];
  for (const text of texts) {
    for (const secret of secrets) {
      if (String(text).includes(secret)) {
        throw new Error(
          `a probe token (${secret.slice(0, 16)}…) leaked into a parent/delegation prompt or path — ` +
            "any echo of it would then be a copy of the prompt rather than an observation",
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — a FRESH tree per arm. Distinct seed tokens per arm, so a token that
// travelled back through the PARENT from arm 1 can never be mistaken for arm 2's
// own read.
// ─────────────────────────────────────────────────────────────────────────────

function makeFixture(armTag) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `probe-i-${armTag}-`)));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const seedFresh = join(workspace, "seed-alpha.txt");
  const seedOnDisk = join(workspace, "seed-beta.txt");
  writeFileSync(seedFresh, `${SEED_TOKEN_FRESH}\n`);
  writeFileSync(seedOnDisk, `${SEED_TOKEN_ON_DISK}\n`);
  return { root, workspace, seedFresh, seedOnDisk };
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation
// ─────────────────────────────────────────────────────────────────────────────

function freshObs(label) {
  return {
    label,
    init: null,
    envelopes: [],
    toolUses: [],
    toolResults: [],
    taskStarts: [],
    taskNotifications: [],
    backgroundLevels: [],
    registry: null,
    contextUsageAgents: null,
    transcript: "",
    sawResult: false,
    resultSubtype: null,
    numTurns: null,
    timedOut: false,
    error: null,
  };
}

function observe(obs, message, startedAt) {
  const atMs = Date.now() - startedAt;
  obs.envelopes.push(`${message.type}${message.subtype ? `/${message.subtype}` : ""}`);

  if (message.type === "system" && message.subtype === "init") {
    const agentNames = message.agents ?? [];
    obs.init = {
      model: message.model ?? null,
      permissionMode: message.permissionMode ?? null,
      toolCount: (message.tools ?? []).length,
      mcpServerCount: (message.mcp_servers ?? []).length,
      mcpServers: (message.mcp_servers ?? []).map((s) => `${s.name}:${s.status ?? "?"}`),
      mcpToolNamesInInit: (message.tools ?? []).filter(isMcpName).length,
      agentCount: agentNames.length,
      // A DUPLICATE NAME WOULD ITSELF BE A FINDING: it would mean the roster
      // carries the disk entry and the Options entry side by side.
      onDiskAgentOccurrences: agentNames.filter((n) => n === ON_DISK_AGENT).length,
      freshAgentOccurrences: agentNames.filter((n) => n === FRESH_AGENT).length,
      sessionId: message.session_id ?? null,
    };
  }

  if (message.type === "system" && message.subtype === "task_started") {
    obs.taskStarts.push({
      subagentType: message.subagent_type ?? null,
      taskType: message.task_type ?? null,
      taskId: message.task_id ?? null,
      toolUseId: message.tool_use_id ?? null,
      skipTranscript: Boolean(message.skip_transcript),
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
      atMs,
    });
  }

  // The LEVEL signal for background work (sdk.d.ts:2912-2928). Corroboration for
  // the tool_result `status`, which is the primary and immediate channel.
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    obs.backgroundLevels.push({
      count: (message.tasks ?? []).length,
      taskTypes: (message.tasks ?? []).map((t) => t.task_type),
      taskIds: (message.tasks ?? []).map((t) => t.task_id),
      atMs,
    });
  }

  if (message.type === "assistant") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") obs.transcript += block.text ?? "";
        if (block?.type === "tool_use") {
          obs.toolUses.push({
            id: block.id ?? null,
            name: block.name,
            input: block.input ?? {},
            atMs,
          });
        }
      }
    }
  }

  // Tool RESULTS arrive as user messages (probe H's extractor, :395). `is_error`
  // is kept because "the roster rejected this agent name" and "the definition was
  // delivered but ignored" are different failures with different verdicts, and
  // only the error text separates them.
  if (message.type === "user") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          const text = Array.isArray(block.content)
            ? block.content.map((c) => (c?.type === "text" ? c.text : safeStringify(c))).join("\n")
            : typeof block.content === "string"
              ? block.content
              : safeStringify(block.content);
          obs.toolResults.push({
            toolUseId: block.tool_use_id ?? null,
            isError: Boolean(block.is_error),
            text,
            // MEASURED 2026-07-28, first run of this probe: in SDK 0.3.220 the
            // Agent tool_result BLOCK carries the model-facing FORMATTED text
            // ("<reply>\nagentId: …\n<usage>subagent_tokens: …</usage>"), NOT the
            // JSON `AgentOutput` of sdk-tools.d.ts:99. The structured object
            // arrives on the SAME user message's top-level `tool_use_result`
            // (the channel probe F read at probe-f-gaps.mjs:343). Both are kept:
            // the text is what the parent model actually saw, the structured
            // object is where `status` / `resolvedModel` live when present.
            structured: message.tool_use_result ?? null,
            atMs,
          });
        }
      }
    }
    obs.transcript += safeStringify(content);
  }

  if (message.type === "result") {
    obs.sawResult = true;
    obs.resultSubtype = message.subtype ?? null;
    obs.numTurns = message.num_turns ?? null;
  }
}

/**
 * Two ENGINE-SIDE registry channels, both read from the live session object.
 *
 * Safe to await from inside the message loop: sdk.mjs starts `readMessages()` as
 * an independent pump in the Query constructor and enqueues into its own
 * `inputStream`, so control responses are serviced while our consumer is between
 * `next()` calls. `supportedAgents()` in particular just returns the cached
 * initialize response (`(await this.initialization).agents`).
 *
 * Both are CORROBORATION, never the verdict: `getContextUsage().agents[].source`
 * is undocumented, and may list only agents whose definitions were loaded into
 * context rather than the full roster.
 */
async function captureRegistry(session, obs) {
  const withTimeout = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("registry read timed out")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const agents = await withTimeout(session.supportedAgents(), 8000);
    const pick = (name) => agents.filter((a) => a?.name === name).map((a) => ({
      name: a?.name ?? null,
      description: truncate(a?.description, 300),
      model: a?.model ?? null,
    }));
    obs.registry = {
      total: agents.length,
      onDiskAgentEntries: pick(ON_DISK_AGENT),
      freshAgentEntries: pick(FRESH_AGENT),
      // The registry-channel discriminator: did OUR description reach the roster?
      onDiskEntryCarriesProbeDescription: pick(ON_DISK_AGENT).some((a) =>
        String(a.description ?? "").includes(DESC_MARKER),
      ),
      freshEntryCarriesProbeDescription: pick(FRESH_AGENT).some((a) =>
        String(a.description ?? "").includes(DESC_MARKER),
      ),
    };
  } catch (error) {
    obs.registry = { error: truncate(error?.message ?? error, 200) };
  }

  try {
    const usage = await withTimeout(session.getContextUsage(), 8000);
    const rows = (usage?.agents ?? []).filter(
      (a) => a?.agentType === ON_DISK_AGENT || a?.agentType === FRESH_AGENT,
    );
    obs.contextUsageAgents = {
      totalAgentRows: (usage?.agents ?? []).length,
      rows,
      note:
        "getContextUsage().agents[] = {agentType, source, tokens} (sdk.d.ts:3107). `source` is " +
        "undocumented; recorded as corroboration only.",
    };
  } catch (error) {
    obs.contextUsageAgents = { error: truncate(error?.message ?? error, 200) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Apparatus: hooks (pure recorders) + canUseTool (the safety envelope).
//
// The split is deliberate: the hook must not deny anything, or a denial would
// consume a child turn and confound S2's turn accounting. Everything the probe
// refuses is refused in ONE place, and every refusal is recorded.
// ─────────────────────────────────────────────────────────────────────────────

function freshState() {
  return { firings: [], subagentStarts: [], subagentStops: [], consultations: [], denials: [] };
}

function buildHooks(state) {
  return {
    PreToolUse: [
      {
        // No matcher: probe F measured a matcher-less slot sees every tool, and
        // probe E measured matcher "Task" firing for a tool_name of "Agent".
        hooks: [
          async (input) => {
            state.firings.push({
              toolName: input?.tool_name ?? null,
              // `agent_id` is present ONLY from inside a subagent (sdk.d.ts:176).
              firedInsideSubagent: Boolean(input?.agent_id),
              insideAgentType: input?.agent_id ? (input?.agent_type ?? null) : null,
              subagentType: input?.tool_input?.subagent_type ?? null,
              runInBackground: input?.tool_input?.run_in_background ?? null,
              modelParam: input?.tool_input?.model ?? null,
            });
            return { continue: true };
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          async (input) => {
            state.subagentStarts.push({
              agentType: input?.agent_type ?? null,
              agentId: input?.agent_id ?? null,
            });
            return { continue: true };
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          async (input) => {
            // `agent_transcript_path` (sdk.d.ts:6813) is the child's OWN
            // engine-written transcript. Read afterwards for a TURN COUNT and
            // tool NAMES only — never for message contents.
            state.subagentStops.push({
              agentType: input?.agent_type ?? null,
              agentId: input?.agent_id ?? null,
              transcriptPath: input?.agent_transcript_path ?? null,
            });
            return { continue: true };
          },
        ],
      },
    ],
  };
}

const DENY_REASON = "probe I safety envelope: this tool is outside the probe's fixture";

function makeCanUseTool(state, fixture) {
  return async (toolName, input) => {
    state.consultations.push({ toolName, isMcp: isMcpName(toolName) });

    const deny = (why) => {
      state.denials.push({ toolName, why });
      return { behavior: "deny", message: `${DENY_REASON} (${why})` };
    };

    if (isMcpName(toolName)) return deny("mcp");
    if (toolName === "WebFetch" || toolName === "WebSearch") return deny("network");
    if (toolName === "Bash") {
      const command = String(input?.command ?? "");
      // A child that reaches for `cat` on the seed file is doing exactly what the
      // instruction asked; a child that wanders is not. The fixture root is the
      // whole test.
      if (!command.includes(fixture.root)) return deny("bash outside fixture");
    }
    return { behavior: "allow", updatedInput: input };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Options. Held byte-identical across arms except `agents`.
// ─────────────────────────────────────────────────────────────────────────────

function buildOptions(fixture, state, agents) {
  return {
    cwd: fixture.workspace,
    model: MODEL,
    maxTurns: 14,
    permissionMode: "acceptEdits", // production parity
    includePartialMessages: false,
    tools: { type: "preset", preset: "claude_code" },
    // Production parity, AND the reason ~144 agents exist on disk to collide with.
    settingSources: ["user"],
    agents,
    hooks: buildHooks(state),
    canUseTool: makeCanUseTool(state, fixture),
    managedSettings: {
      // Suppresses the owner's own hooks (probe C measured our programmatic hooks
      // still fire), so no user Stop/PreToolUse hook can block completion.
      allowManagedHooksOnly: true,
      // HELD CONSTANT IN EVERY ARM and orthogonal to agent binding: probe G
      // measured this pair takes the session from 619 tools to 28. Without it
      // every child inherits ~589 mcp__ tools and no arm finishes inside 90 s.
      allowedMcpServers: [],
      allowManagedMcpServersOnly: true,
    },
    env: probeEnv(),
  };
}

/** The one definition shape, spelled once. `tools` is deliberately OMITTED: this
 *  probe is not testing tool narrowing (G2 did), and an allowlist here would make
 *  "the child could not do the task" ambiguous. */
function definition({ description, prompt, maxTurns, background }) {
  return {
    description: `${DESC_MARKER} — ${description}`,
    prompt,
    model: DEFINITION_MODEL,
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(background === undefined ? {} : { background }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session driver
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_LOG = [];

async function runSession({ label, prompt, options, state, wantRegistry }) {
  if (sessionsSpent >= MAX_LIVE_SESSIONS) {
    throw new Error(`session budget exhausted (${MAX_LIVE_SESSIONS}); refusing to start ${label}`);
  }
  sessionsSpent += 1;

  const obs = freshObs(label);
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    obs.timedOut = true;
    abortController.abort();
  }, HARD_TIMEOUT_MS);

  let session;
  try {
    session = query({ prompt, options: { ...options, abortController } });
    let registryCaptured = false;
    for await (const message of session) {
      observe(obs, message, startedAt);
      if (wantRegistry && !registryCaptured && obs.init) {
        registryCaptured = true;
        await captureRegistry(session, obs);
      }
    }
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

  SESSION_LOG.push({
    label,
    envelopes: obs.envelopes,
    init: obs.init,
    registry: obs.registry,
    contextUsageAgents: obs.contextUsageAgents,
    toolUses: obs.toolUses.map((u) => ({
      id: u.id,
      name: u.name,
      atMs: u.atMs,
      input: truncate(safeStringify(u.input), 700),
    })),
    toolResults: obs.toolResults.map((r) => ({
      toolUseId: r.toolUseId,
      isError: r.isError,
      atMs: r.atMs,
      text: truncate(r.text, 2000),
    })),
    taskStarts: obs.taskStarts,
    taskNotifications: obs.taskNotifications,
    backgroundLevels: obs.backgroundLevels,
    hookState: {
      firings: state.firings,
      subagentStarts: state.subagentStarts,
      subagentStops: state.subagentStops.map((s) => ({
        agentType: s.agentType,
        agentId: s.agentId,
        transcriptPath: s.transcriptPath,
      })),
      consultationCount: state.consultations.length,
      denials: state.denials,
    },
    sawResult: obs.sawResult,
    resultSubtype: obs.resultSubtype,
    numTurns: obs.numTurns,
    timedOut: obs.timedOut,
    error: obs.error,
    transcriptExcerpt: truncate(obs.transcript, 2500),
  });

  return obs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a delegation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pair each `Agent` tool_use with its tool_result and decode BOTH shapes of
 * `AgentOutput` (sdk-tools.d.ts:99-170):
 *   status "completed"      → carries content[] (the child's own reply),
 *                             resolvedModel, totalToolUseCount  → FOREGROUND
 *   status "async_launched" → carries agentId + description only → BACKGROUND
 */
function readDelegations(obs) {
  const byId = new Map(obs.toolResults.map((r) => [r.toolUseId, r]));
  return obs.toolUses
    .filter((u) => u.name === "Agent" || u.name === "Task")
    .map((u, index) => {
      const result = byId.get(u.id) ?? null;
      // Three shapes, in falling order of structure: the top-level
      // `tool_use_result` object, a JSON-encoded result block, and — what this
      // build actually emits for Agent — a formatted text block.
      let parsed = null;
      if (result?.structured && typeof result.structured === "object") {
        parsed = result.structured;
      } else if (result) {
        try {
          parsed = JSON.parse(result.text);
        } catch {
          parsed = null;
        }
      }
      const text = String(result?.text ?? "");
      // Text-shape fallbacks. `<usage>subagent_tokens: …</usage>` is the
      // SYNCHRONOUS trailer (probes E and F measured it on foreground
      // delegations); an async launch instead announces itself in words and
      // carries no usage trailer.
      const textForeground = /subagent_tokens\s*:/i.test(text);
      const textBackground =
        /async_launched/i.test(text) || /running in the background/i.test(text);
      const iterations = parsed?.usage?.iterations;
      return {
        index,
        toolUseId: u.id,
        toolName: u.name,
        subagentType: u.input?.subagent_type ?? null,
        // Both are confounds if the model volunteers them, so both are recorded
        // and the arms that depend on them are voided when they appear.
        emittedRunInBackground:
          u.input?.run_in_background === undefined ? null : u.input.run_in_background,
        emittedModel: u.input?.model ?? null,
        promptExcerpt: truncate(u.input?.prompt ?? "", 400),
        resultPresent: Boolean(result),
        isError: result ? result.isError : null,
        parseOk: Boolean(parsed),
        structuredChannelPresent: Boolean(result?.structured),
        textForeground,
        textBackground,
        status: parsed?.status ?? null,
        agentId: parsed?.agentId ?? null,
        agentTypeEchoed: parsed?.agentType ?? null,
        resolvedModel: parsed?.resolvedModel ?? null,
        totalToolUseCount: parsed?.totalToolUseCount ?? null,
        // sdk.d.ts declares usage.iterations as `unknown`. Shape unverified —
        // recorded as corroboration only, never as the turn count.
        iterationsCount: Array.isArray(iterations) ? iterations.length : null,
        replyText: Array.isArray(parsed?.content)
          ? parsed.content.map((c) => (c?.type === "text" ? c.text : "")).join("\n")
          : null,
        rawExcerpt: result ? truncate(result.text, 900) : null,
      };
    });
}

function pickArm(delegations, subagentType) {
  return delegations.find((d) => d.subagentType === subagentType) ?? null;
}

/** "Roster rejected the name" vs "definition delivered but ignored" are different
 *  failures. Only the error text separates them. */
function looksLikeRosterRejection(arm) {
  if (!arm || !arm.isError) return false;
  const text = String(arm.rawExcerpt ?? "").toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("unknown agent") ||
    text.includes("no such agent") ||
    text.includes("invalid agent") ||
    text.includes("available agents")
  );
}

/** A token echoed anywhere in the delegation's result. Checked against the parsed
 *  reply first, then the raw envelope, so a parse failure cannot hide a positive. */
function armEchoes(arm, token) {
  if (!arm) return false;
  return (
    String(arm.replyText ?? "").includes(token) || String(arm.rawExcerpt ?? "").includes(token)
  );
}

function classifyModelProvenance(resolvedModel) {
  const m = String(resolvedModel ?? "");
  if (!m) return "unknown";
  if (m.includes("haiku")) return "options-definition";
  if (m.includes("opus")) return "on-disk-frontmatter";
  if (m.includes("sonnet")) return "inherited-from-parent";
  return `other:${m}`;
}

/**
 * The child's OWN engine-written transcript — the strongest channel in this
 * probe, because it is written per-agent by the engine and the parent cannot
 * author it.
 *
 * Two measurements come out of it:
 *   TURNS  — one assistant record per API round-trip (load-bearing for S2).
 *   MODEL  — `message.model` on each assistant record. This is the THREE-WAY
 *            provenance discriminator and it works even in this build, where the
 *            Agent tool_result carries no `resolvedModel` at all:
 *              claude-haiku-*  → the Options definition's `model: "haiku"` won
 *              claude-opus-5   → the on-disk `model:` frontmatter won
 *              claude-sonnet-* → neither; inherited from the parent
 *
 * Tool NAMES and the model string are kept. No message content is stored beyond
 * a short excerpt of the child's own reply, which is the measured observable.
 */
function readChildTurns(state) {
  return state.subagentStops.map((stop) => {
    const path = stop.transcriptPath;
    if (!path || !existsSync(path)) {
      return { agentType: stop.agentType, path: path ?? null, exists: false };
    }
    let assistantRecords = 0;
    const messageIds = new Set();
    const toolNames = new Set();
    const models = new Set();
    let replyText = "";
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record?.type !== "assistant") continue;
        assistantRecords += 1;
        if (record?.message?.id) messageIds.add(record.message.id);
        if (record?.message?.model) models.add(record.message.model);
        const content = record?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_use" && typeof block.name === "string") toolNames.add(block.name);
            if (block?.type === "text" && block.text) replyText += block.text;
          }
        }
      }
    } catch {
      return { agentType: stop.agentType, path, exists: true, unreadable: true };
    }
    return {
      agentType: stop.agentType,
      path,
      exists: true,
      assistantRecords,
      distinctAssistantMessages: messageIds.size,
      toolNames: [...toolNames],
      models: [...models],
      modelProvenance: classifyModelProvenance([...models][0]),
      replyExcerpt: truncate(replyText, 400),
    };
  });
}

/** Provenance for one arm, from the strongest channel that actually carried a
 *  model in this build. The tool_result channel is tried first and is usually
 *  empty; the child's own transcript is the one that answers. */
function armModelProvenance(arm, childTurns, agentType) {
  const fromResult = arm?.resolvedModel ?? null;
  if (fromResult) {
    return { model: fromResult, provenance: classifyModelProvenance(fromResult), via: "tool_result" };
  }
  const child = childTurns.find((t) => t.agentType === agentType && t.models?.length);
  if (child) {
    return {
      model: child.models[0],
      provenance: classifyModelProvenance(child.models[0]),
      via: "child-transcript",
    };
  }
  return { model: null, provenance: "unknown", via: "none" };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING — pure functions of recorded observations, and the SINGLE source of
// truth for both the live path and `--reclassify`. Nothing here starts a session
// or reads the network; every input is a field this probe already wrote down.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The harness's own marker for a child that ended without producing any
 * assistant text. Seen verbatim in the 2026-07-28 S2 run.
 */
function producedNoOutput(arm) {
  if (!arm) return false;
  const reply = String(arm.replyText ?? "");
  const raw = String(arm.rawExcerpt ?? "");
  return (
    /\(Subagent completed but returned no output\.\)/i.test(raw) ||
    (reply.trim() === "" && !/\S/.test(reply))
  );
}

/**
 * A child that CALLED A TOOL and then said NOTHING did not get the round-trip in
 * which to answer. That is the tool_result-side signature of a maxTurns:1
 * truncation, and it is the fallback channel when no child transcript exists —
 * which is itself expected for a truncated child, since a run cut off mid-flight
 * never reaches SubagentStop and so never reports a transcript path.
 */
function truncationSignature(arm) {
  return Boolean(arm) && (arm.totalToolUseCount ?? 0) >= 1 && producedNoOutput(arm);
}

/**
 * Tool names a SPECIFIC child issued, taken from `PreToolUse` firings that carry
 * `agent_id` (sdk.d.ts:176 — present only from inside a subagent). Engine-side,
 * per-agent, and — this is the point — it survives a child that never reaches
 * SubagentStop and so never writes a transcript, which is exactly the child a
 * maxTurns truncation produces.
 */
function hookToolNamesFor(firings, agentType) {
  return (firings ?? [])
    .filter((f) => f?.firedInsideSubagent && f?.insideAgentType === agentType)
    .map((f) => f.toolName)
    .filter(Boolean);
}

/**
 * Four outcomes, never two. `completedTask` alone would conflate "cut off at one
 * round-trip" with "declined the chore" — and this probe's own S1 measured the
 * on-disk code-reviewer persona declining twice, so that confusion is not
 * hypothetical.
 */
function classifyMaxTurnsArm(view) {
  const arm = view?.arm ?? null;
  if (!arm || view.rosterRejected) return "void-no-measurement";
  if (view.completedTask || (view.turnCount ?? 0) >= 2) return "not-bound";
  const hookSawATool = (view.hookToolNames ?? []).length > 0;
  if (view.turnCount === 1 && (view.usedATool || hookSawATool)) return "bound";
  if ((view.turnCount === null || view.turnCount === undefined) && truncationSignature(arm)) {
    // A truncated child writes no transcript, so the turn count is unavailable.
    // With a PreToolUse firing carrying this child's agent_id, the tool call is
    // still attested engine-side and the classification rests on two independent
    // channels rather than on the tool_result envelope alone.
    return hookSawATool ? "bound" : "bound-via-tool-result";
  }
  return "void-non-compliant";
}

const MAXTURNS_BOUND = new Set(["bound", "bound-via-tool-result"]);

/**
 * THE HEADLINE BOOLEAN IS THE ON-DISK ARM'S, not the pair's.
 *
 * The question production actually asks is "does maxTurns limit a shortlisted
 * agent that exists on disk?" — and the on-disk arm answers that by itself. The
 * fresh-name control answers a SECOND, different question: whether a failure is
 * specific to the collision or general to the SDK. Collapsing the two into one
 * boolean is what would let a broken control silently downgrade a real
 * measurement to "void".
 */
function decideMaxTurns(s2) {
  if (!s2) {
    return {
      binds: false,
      measured: false,
      caveats: ["maxTurns was NOT measured: no S2 arm ran. Read the boolean as UNKNOWN."],
    };
  }
  const f = s2.fresh.classification;
  const o = s2.onDisk.classification;
  const detail =
    `fresh: ${f} (turns=${s2.fresh.turnCount}, tools=${s2.fresh.totalToolUseCount}, hookSawTools=` +
    `${JSON.stringify(s2.fresh.hookToolNames ?? [])}, token=${s2.fresh.completedTask}); on-disk: ` +
    `${o} (turns=${s2.onDisk.turnCount}, tools=${s2.onDisk.totalToolUseCount}, hookSawTools=` +
    `${JSON.stringify(s2.onDisk.hookToolNames ?? [])}, token=${s2.onDisk.completedTask})`;
  const caveats = [];

  let binds;
  let measured = true;
  if (o === "not-bound") {
    binds = false;
    caveats.push(
      `maxTurns:1 DID NOT HOLD for the on-disk-colliding name — ${detail}. The child read a file and ` +
        "then reported its contents, which cannot be done in the single API round-trip the " +
        "definition allowed it.",
    );
  } else if (MAXTURNS_BOUND.has(o)) {
    binds = true;
    caveats.push(`maxTurns:1 HELD for the on-disk-colliding name — ${detail}.`);
  } else {
    binds = false;
    measured = false;
    caveats.push(
      `maxTurns UNKNOWN — ${detail}. The on-disk arm produced no usable measurement, so ` +
        "maxTurnsBinds=false is NOT a measurement.",
    );
  }

  // The control speaks only to the MECHANISM.
  if (MAXTURNS_BOUND.has(f) && o === "not-bound") {
    caveats.push(
      "MECHANISM: maxTurns:1 was DROPPED FOR THE COLLIDING NAME SPECIFICALLY — the fresh name, whose " +
        "definition is measured to bind, was cut off after one round-trip in the same session with " +
        "the same task. So the field works; it just does not reach an agent that also exists on disk.",
    );
  } else if (f === "not-bound" && o === "not-bound") {
    caveats.push(
      "MECHANISM: maxTurns looks INERT FOR EVERYONE in this build — even the fresh name, whose " +
        "definition binds, got the second round-trip. Broader than the collision question and worth " +
        "its own probe.",
    );
  } else if (f.startsWith("void")) {
    caveats.push(
      `MECHANISM UNRESOLVED: the fresh-name control produced no usable measurement (${f}), so ` +
        "'dropped for colliding names' cannot be separated from 'inert everywhere'. The on-disk " +
        "measurement above is unaffected.",
    );
  }
  if (f === "bound-via-tool-result" || o === "bound-via-tool-result") {
    caveats.push(
      "One maxTurns arm was scored from the TOOL_RESULT signature (a tool call followed by no " +
        "output, with no child transcript written) rather than from a transcript turn count. That is " +
        "the expected shape of a truncated run — a child cut off mid-flight never reaches " +
        "SubagentStop — but it is the weaker of the two channels and is flagged rather than hidden.",
    );
  }
  return { binds, measured, caveats };
}

/**
 * Same shape as decideMaxTurns: the on-disk arm carries the headline, the fresh
 * arm carries the mechanism, and a both-foreground result is explicitly NOT a
 * pass until the harness default has been observed.
 */
function decideBackground(s3) {
  if (!s3) {
    return {
      binds: false,
      measured: false,
      needsDefaultControl: false,
      caveats: ["background was NOT measured: no S3 arm ran. Read the boolean as UNKNOWN."],
    };
  }
  const f = s3.fresh;
  const o = s3.onDisk;
  const caveats = [];
  const detail =
    `fresh: status=${f.status}, paramEmitted=${f.emittedRunInBackground}; on-disk: status=` +
    `${o.status}, paramEmitted=${o.emittedRunInBackground}`;

  if (!o.delegated || o.rosterRejected || o.voidBecauseParentSetIt) {
    caveats.push(
      `background UNKNOWN — ${detail}. The measurement is the HARNESS DEFAULT, so a parent that ` +
        "volunteers run_in_background destroys it. backgroundBinds=false is NOT a measurement.",
    );
    return { binds: false, measured: false, needsDefaultControl: false, caveats };
  }

  if (o.ranInBackground) {
    caveats.push(
      `background:false DID NOT HOLD for the on-disk-colliding name — ${detail}. The delegation came ` +
        "back status=async_launched with an agentId, and background_tasks_changed reported it live.",
    );
    if (f.ranInBackground) {
      caveats.push(
        "MECHANISM: background:false is INERT EVEN WHERE THE DEFINITION BINDS. The fresh name was " +
          "backgrounded too — in the same delegation whose resolvedModel proves the SAME definition " +
          "object's `model` field WAS honoured. So this is a per-FIELD no-op, exactly like the " +
          "disallowedTools no-op probe G2 measured, and not a consequence of the on-disk collision.",
      );
    } else {
      caveats.push(
        "MECHANISM: dropped for the colliding name specifically — the fresh name, whose definition " +
          "binds, ran synchronously under the same field in the same session.",
      );
    }
    return { binds: false, measured: true, needsDefaultControl: false, caveats };
  }

  // Foreground on the on-disk name. Cannot be read as a pass on its own.
  return {
    binds: true,
    measured: true,
    needsDefaultControl: true,
    caveats: [
      `background:false LOOKS held for the on-disk-colliding name — ${detail} — but two foregrounds ` +
        "are equally explained by 'foreground is what happens anyway'. Nothing in this tree had ever " +
        "observed the harness default. The S4 reserve arm below is what settles it.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ARMS
// ─────────────────────────────────────────────────────────────────────────────

/** S1 — the nonce echo, with its required negative control in the same session. */
async function runS1(attempt) {
  const label = `I/S1-nonce${attempt > 1 ? `/retry${attempt - 1}` : ""}`;
  const fixture = makeFixture(`s1${attempt > 1 ? `-r${attempt - 1}` : ""}`);
  const state = freshState();

  const agents = {
    [FRESH_AGENT]: definition({
      description: "fresh-name nonce instrument (negative control for probe I)",
      prompt: nonceDefinitionPrompt(NONCE_FRESH),
      maxTurns: 3,
      background: false,
    }),
    [ON_DISK_AGENT]: definition({
      description: "on-disk-collision nonce instrument (probe I)",
      prompt: nonceDefinitionPrompt(NONCE_ON_DISK),
      maxTurns: 3,
      background: false,
    }),
  };

  const prompt = foregroundParentPrompt({
    freshInstruction: NONCE_INSTRUCTION,
    onDiskInstruction: NONCE_INSTRUCTION,
  });
  assertPromptsClean([prompt, fixture.root]);

  const obs = await runSession({
    label,
    prompt,
    options: buildOptions(fixture, state, agents),
    state,
    wantRegistry: true,
  });

  const delegations = readDelegations(obs);
  const fresh = pickArm(delegations, FRESH_AGENT);
  const onDisk = pickArm(delegations, ON_DISK_AGENT);
  const childTurns = readChildTurns(state);
  const freshModel = armModelProvenance(fresh, childTurns, FRESH_AGENT);
  const onDiskModel = armModelProvenance(onDisk, childTurns, ON_DISK_AGENT);

  return {
    label,
    attempt,
    fixtureRoot: fixture.root,
    fixture,
    init: obs.init,
    registry: obs.registry,
    contextUsageAgents: obs.contextUsageAgents,
    delegations,
    fresh: {
      delegated: Boolean(fresh),
      rosterRejected: looksLikeRosterRejection(fresh),
      nonceEchoed: armEchoes(fresh, NONCE_FRESH),
      crossNonce: armEchoes(fresh, NONCE_ON_DISK),
      resolvedModel: freshModel.model,
      modelProvenance: freshModel.provenance,
      modelVia: freshModel.via,
      arm: fresh,
    },
    onDisk: {
      delegated: Boolean(onDisk),
      rosterRejected: looksLikeRosterRejection(onDisk),
      nonceEchoed: armEchoes(onDisk, NONCE_ON_DISK),
      crossNonce: armEchoes(onDisk, NONCE_FRESH),
      resolvedModel: onDiskModel.model,
      modelProvenance: onDiskModel.provenance,
      modelVia: onDiskModel.via,
      arm: onDisk,
    },
    childTurns,
    session: {
      resultSubtype: obs.resultSubtype,
      numTurns: obs.numTurns,
      timedOut: obs.timedOut,
      error: obs.error,
      sessionId: obs.init?.sessionId ?? null,
    },
  };
}

/** S2 — maxTurns:1 on both names, with a task that CANNOT complete in one
 *  API round-trip. The task lives in the DELEGATION prompt, not the definition:
 *  a task carried only by the definition would never reach a child whose
 *  definition did not bind, and "did nothing" would be indistinguishable from
 *  "was cut off at one turn". */
async function runS2(attempt) {
  const label = `I/S2-maxTurns${attempt > 1 ? `/retry${attempt - 1}` : ""}`;
  const fixture = makeFixture(`s2${attempt > 1 ? `-r${attempt - 1}` : ""}`);
  const state = freshState();

  const agents = {
    [FRESH_AGENT]: definition({
      description: "fresh-name maxTurns instrument (control)",
      prompt: WORKER_DEFINITION_PROMPT,
      maxTurns: 1,
      background: false,
    }),
    [ON_DISK_AGENT]: definition({
      description: "on-disk-collision maxTurns instrument",
      prompt: WORKER_DEFINITION_PROMPT,
      maxTurns: 1,
      background: false,
    }),
  };

  const prompt = foregroundParentPrompt({
    freshInstruction: seedTaskInstruction(fixture.seedFresh),
    onDiskInstruction: seedTaskInstruction(fixture.seedOnDisk),
  });
  assertPromptsClean([prompt, fixture.root, fixture.seedFresh, fixture.seedOnDisk]);

  const obs = await runSession({
    label,
    prompt,
    options: buildOptions(fixture, state, agents),
    state,
    wantRegistry: false,
  });

  const delegations = readDelegations(obs);
  const fresh = pickArm(delegations, FRESH_AGENT);
  const onDisk = pickArm(delegations, ON_DISK_AGENT);
  const turns = readChildTurns(state);
  const turnsFor = (agentType) => turns.filter((t) => t.agentType === agentType);

  /**
   * THE THREE-WAY, and it is not optional. `completedTask` alone conflates
   * "cut off at one round-trip" with "declined the task": this probe's own S1
   * measured the on-disk code-reviewer persona replying "standing by for your
   * next instruction" TWICE without touching a tool, and an opus-5 reviewer
   * handed an unfamiliar chore may do exactly that again. Only the child's own
   * transcript separates them.
   *
   * TURNS ARE COUNTED AS DISTINCT ASSISTANT MESSAGE IDS, NOT RECORDS. Measured
   * in S1: the fresh child produced TWO assistant records carrying ONE message
   * id (the engine splits a streamed message across records), so a record count
   * would have reported two round-trips for a single API call and read a bound
   * maxTurns as unbound.
   */
  const armView = (arm, token, agentType) => {
    const child = turnsFor(agentType)[0] ?? null;
    const turnCount = child ? (child.distinctAssistantMessages ?? child.assistantRecords ?? 0) : null;
    const view = {
      delegated: Boolean(arm),
      rosterRejected: looksLikeRosterRejection(arm),
      // ≥2 API round-trips, by construction: the token is unguessable and lives
      // only inside the file the child had to read.
      completedTask: armEchoes(arm, token) || String(child?.replyExcerpt ?? "").includes(token),
      turnCount,
      usedATool: Boolean(child?.toolNames?.length),
      // Second, independent attestation that THIS child called a tool. Needed
      // because a child cut off at maxTurns leaves no transcript behind.
      hookToolNames: hookToolNamesFor(state.firings, agentType),
      resolvedModel: armModelProvenance(arm, turns, agentType).model,
      modelProvenance: armModelProvenance(arm, turns, agentType).provenance,
      totalToolUseCount: arm?.totalToolUseCount ?? null,
      iterationsCount: arm?.iterationsCount ?? null,
      transcriptTurns: turnsFor(agentType),
      arm,
    };
    return { ...view, classification: classifyMaxTurnsArm(view) };
  };

  return {
    label,
    attempt,
    fixtureRoot: fixture.root,
    fixture,
    init: obs.init,
    delegations,
    fresh: armView(fresh, SEED_TOKEN_FRESH, FRESH_AGENT),
    onDisk: armView(onDisk, SEED_TOKEN_ON_DISK, ON_DISK_AGENT),
    session: {
      resultSubtype: obs.resultSubtype,
      numTurns: obs.numTurns,
      timedOut: obs.timedOut,
      error: obs.error,
      sessionId: obs.init?.sessionId ?? null,
    },
  };
}

/** S3 — background:false on both names, invoked with the parameter OMITTED. */
async function runS3(attempt) {
  const label = `I/S3-background${attempt > 1 ? `/retry${attempt - 1}` : ""}`;
  const fixture = makeFixture(`s3${attempt > 1 ? `-r${attempt - 1}` : ""}`);
  const state = freshState();

  const agents = {
    [FRESH_AGENT]: definition({
      description: "fresh-name background instrument (control)",
      prompt: WORKER_DEFINITION_PROMPT,
      maxTurns: 3,
      background: false,
    }),
    [ON_DISK_AGENT]: definition({
      description: "on-disk-collision background instrument",
      prompt: WORKER_DEFINITION_PROMPT,
      maxTurns: 3,
      background: false,
    }),
  };

  const prompt = s3ParentPrompt();
  assertPromptsClean([prompt, fixture.root]);

  const obs = await runSession({
    label,
    prompt,
    options: buildOptions(fixture, state, agents),
    state,
    wantRegistry: false,
  });

  const delegations = readDelegations(obs);
  const fresh = pickArm(delegations, FRESH_AGENT);
  const onDisk = pickArm(delegations, ON_DISK_AGENT);
  const childTurns = readChildTurns(state);

  const armView = (arm, agentType) => ({
    delegated: Boolean(arm),
    rosterRejected: looksLikeRosterRejection(arm),
    // VOID if the model volunteered the parameter: the measurement is the DEFAULT.
    emittedRunInBackground: arm?.emittedRunInBackground ?? null,
    voidBecauseParentSetIt: arm ? arm.emittedRunInBackground !== null : false,
    status: arm?.status ?? null,
    // `status` comes from the structured channel, which this build leaves empty
    // for Agent. The text shape is therefore the working discriminator and the
    // structured one is the corroboration — the reverse of the usual order, and
    // stated here rather than hidden in a boolean.
    ranInBackground: arm?.status === "async_launched" || Boolean(arm?.textBackground),
    ranInForeground:
      arm?.status === "completed" || (Boolean(arm?.textForeground) && !arm?.textBackground),
    agentId: arm?.agentId ?? null,
    resolvedModel: armModelProvenance(arm, childTurns, agentType).model,
    modelProvenance: armModelProvenance(arm, childTurns, agentType).provenance,
    arm,
  });

  return {
    label,
    attempt,
    fixtureRoot: fixture.root,
    fixture,
    init: obs.init,
    delegations,
    fresh: armView(fresh, FRESH_AGENT),
    onDisk: armView(onDisk, ON_DISK_AGENT),
    childTurns,
    corroboration: {
      backgroundLevels: obs.backgroundLevels,
      anyBackgroundTaskEverLive: obs.backgroundLevels.some((l) => l.count > 0),
      taskStarts: obs.taskStarts,
      taskNotifications: obs.taskNotifications,
    },
    session: {
      resultSubtype: obs.resultSubtype,
      numTurns: obs.numTurns,
      timedOut: obs.timedOut,
      error: obs.error,
      sessionId: obs.init?.sessionId ?? null,
    },
  };
}

/**
 * S4 — THE RESERVE ARM, and it only earns a session under one condition: S3 came
 * back FOREGROUND ON BOTH NAMES.
 *
 * Why that is not already a pass. `AgentInput.run_in_background` is documented
 * "Agents run in the background by default … Set to false to run this agent
 * synchronously", but NOTHING IN THIS TREE HAS EVER OBSERVED THAT DEFAULT: probe
 * F's two arms both passed the parameter explicitly (true and false), and both of
 * this probe's own S1 runs pinned it false on purpose. So "both children ran in
 * the foreground" is equally explained by "background:false held" and by "the SDK
 * default is foreground and the field did nothing" — the same
 * mechanism-held-versus-mechanism-never-invoked trap that probe G walked into.
 *
 * This arm registers a FRESH name — the one shape already measured to bind — with
 * the `background` field OMITTED ENTIRELY, and lets the parent omit the parameter
 * too. Background here means the default is background, so S3's foregrounds were
 * real. Foreground here means S3 measured nothing at all.
 */
async function runBackgroundDefaultControl(attempt) {
  const label = `I/S4-background-default-control${attempt > 1 ? `/retry${attempt - 1}` : ""}`;
  const fixture = makeFixture(`s4${attempt > 1 ? `-r${attempt - 1}` : ""}`);
  const state = freshState();

  const agents = {
    [FRESH_AGENT]: definition({
      description: "fresh-name harness-default control (background field OMITTED)",
      prompt: WORKER_DEFINITION_PROMPT,
      maxTurns: 3,
      // `background` DELIBERATELY ABSENT. That absence is the whole arm.
    }),
  };

  const prompt =
    "Do EXACTLY one thing and nothing else. Call the Agent tool with:\n" +
    `  subagent_type: ${FRESH_AGENT}\n` +
    "  description: probe i default\n" +
    "  prompt: exactly the text between the markers below, verbatim, markers excluded:\n" +
    `<<<\n${READY_INSTRUCTION}\n>>>\n\n` +
    "CRITICAL: do NOT include a run_in_background parameter — omit it entirely. Do NOT set the " +
    "model parameter. Do not wait for the subagent, do not read its reply and do not summarise it.\n\n" +
    "Then reply with the single word DONE and nothing else.";
  assertPromptsClean([prompt, fixture.root]);

  const obs = await runSession({
    label,
    prompt,
    options: buildOptions(fixture, state, agents),
    state,
    wantRegistry: false,
  });

  const delegations = readDelegations(obs);
  const arm = pickArm(delegations, FRESH_AGENT);
  return {
    label,
    attempt,
    fixtureRoot: fixture.root,
    fixture,
    init: obs.init,
    delegated: Boolean(arm),
    emittedRunInBackground: arm?.emittedRunInBackground ?? null,
    voidBecauseParentSetIt: arm ? arm.emittedRunInBackground !== null : false,
    status: arm?.status ?? null,
    defaultIsBackground: arm?.status === "async_launched" || Boolean(arm?.textBackground),
    defaultIsForeground:
      arm?.status === "completed" || (Boolean(arm?.textForeground) && !arm?.textBackground),
    backgroundLevels: obs.backgroundLevels,
    anyBackgroundTaskEverLive: obs.backgroundLevels.some((l) => l.count > 0),
    taskStarts: obs.taskStarts,
    arm,
    session: {
      resultSubtype: obs.resultSubtype,
      numTurns: obs.numTurns,
      timedOut: obs.timedOut,
      error: obs.error,
      sessionId: obs.init?.sessionId ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result plumbing — probe I's OWN two filenames, and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SCORING PIPELINE — everything that turns recorded arms into an answer.
 *
 * Factored out of `main` for one reason: `--reclassify` must re-score a previous
 * run's arms through the IDENTICAL code path, with no live session. A second
 * implementation of the decision logic would be a second thing to get wrong, and
 * a re-scoring that disagreed with the live path would be worse than none.
 *
 * `runners` supplies the arms: real sessions in a live run, the arms recorded in
 * the previous `I.json` in a reclassify run.
 */
async function scoreRun(state, s1, runners) {
    state.modelProvenanceOnDisk = s1.onDisk.modelProvenance;
    state.modelProvenanceFresh = s1.fresh.modelProvenance;
    state.nonceEchoed = s1.onDisk.nonceEchoed;
    state.negativeControlHeld = s1.fresh.nonceEchoed;

    /**
     * THE REGISTRY AND THE RUNTIME CAN DISAGREE, AND ANYONE VERIFYING THIS THE
     * OBVIOUS WAY WILL BE MISLED. `supportedAgents()` is the natural place to
     * check "did my definition register?", and it answers about the ROSTER, not
     * about what the engine resolves when the Agent tool actually runs. This
     * block records both sides side by side so the disagreement is in the record
     * rather than in someone's head.
     */
    const advertisedEntry = s1.registry?.onDiskAgentEntries?.[0] ?? null;
    state.registryVsRuntime = {
      initRosterOccurrencesOfOnDiskName: s1.init?.onDiskAgentOccurrences ?? null,
      initRosterOccurrencesOfFreshName: s1.init?.freshAgentOccurrences ?? null,
      supportedAgentsAdvertisesProbeDescription:
        s1.registry?.onDiskEntryCarriesProbeDescription ?? null,
      supportedAgentsAdvertisedModel: advertisedEntry?.model ?? null,
      contextUsageSourceRows: s1.contextUsageAgents?.rows ?? null,
      runtimeModelForOnDiskName: s1.onDisk.resolvedModel,
      runtimeModelProvenance: s1.onDisk.modelProvenance,
      runtimeModelVia: s1.onDisk.modelVia,
      onDiskFrontmatterModel: state.onDiskRoster.onDiskAgentFrontmatter?.model ?? null,
      contradiction: Boolean(
        s1.registry?.onDiskEntryCarriesProbeDescription && !s1.onDisk.nonceEchoed,
      ),
    };
    if (state.registryVsRuntime.contradiction) {
      state.caveats.push(
        "REGISTRY/RUNTIME CONTRADICTION: supportedAgents() advertises THIS PROBE's description " +
          `(and model '${state.registryVsRuntime.supportedAgentsAdvertisedModel}') for ` +
          `'${ON_DISK_AGENT}', and getContextUsage() sources it to the SDK tier — yet the child the ` +
          "engine actually ran did not carry this probe's prompt. A verification that stops at the " +
          "roster will conclude the definition bound. It did not.",
      );
    }
    if ((s1.init?.onDiskAgentOccurrences ?? 0) > 1) {
      state.caveats.push(
        `The engine's own init roster lists '${ON_DISK_AGENT}' ` +
          `${s1.init.onDiskAgentOccurrences} times: the disk entry and the Options entry coexist ` +
          "under one name rather than one replacing the other. That duplicate is the mechanism " +
          "behind the split between what the roster advertises and what the runtime resolves.",
      );
    }

    if (s1.onDisk.crossNonce || s1.fresh.crossNonce) {
      state.caveats.push(
        "CROSS-CONTAMINATION: a nonce belonging to the other arm appeared in one arm's result. The " +
          "two nonces are distinct literals precisely so this is visible; treat the affected arm as " +
          "suspect.",
      );
    }

    if (!s1.onDisk.nonceEchoed && !s1.fresh.nonceEchoed) {
      // The negative control did its job: the instrument, not the collision,
      // explains the silence.
      state.whichReading = "undetermined";
      state.agentsBinds = false;
      state.verdict = "ERROR";
      state.notes =
        "UNDETERMINED — THE INSTRUMENT IS BROKEN, NOT THE MECHANISM. Neither nonce came back: not " +
        `the on-disk-collision name (${ON_DISK_AGENT}, delegated=${s1.onDisk.delegated}, ` +
        `rosterRejected=${s1.onDisk.rosterRejected}) and not the fresh name that exists ONLY in ` +
        `Options.agents (${FRESH_AGENT}, delegated=${s1.fresh.delegated}, rosterRejected=` +
        `${s1.fresh.rosterRejected}). The on-disk collision therefore explains nothing here, and no ` +
        "reading is claimed. maxTurns and background were NOT measured; they are reported false " +
        "because the schema has no null, not because they were observed inert.";
      state.caveats.push(
        "maxTurnsBinds=false and backgroundBinds=false are NOT MEASUREMENTS in this run — S2 and S3 " +
          "were never started. Read them as 'unknown'.",
      );
      return state;
    }

    /**
     * READING B does NOT end the probe, and the brief's gate ("test the two
     * fields only if the nonce came back") rests on a premise this run falsified.
     * The nonce and the model prove that the on-disk definition won on the two
     * fields code-reviewer.md DECLARES. It says nothing about the two fields
     * code-reviewer.md OMITS — and `maxTurns` and `background` are both absent
     * from its frontmatter (name/description/tools/model/color only). A per-field
     * merge in which the disk value wins wherever the disk declares one, and the
     * Options entry fills only the gaps, would leave production's guard and
     * budget BOUND while the prompt is discarded. Entailing them false would be
     * inference standing in for measurement — the exact defect probe G2's header
     * names as this project's signature failure. So S2 and S3 run either way.
     */
    let readingBNotes = null;
    if (!s1.onDisk.nonceEchoed) {
      // READING B, cleanly: the fresh name proves the instrument works.
      state.whichReading = "agents_does_not_bind";
      state.agentsBinds = false;
      state.verdict = "FAIL";
      readingBNotes =
        "MEASURED — READING B. Options.agents DOES NOT BIND for a name that also exists in " +
        `~/.claude/agents/. The fresh name ${FRESH_AGENT}, registered identically and existing ` +
        "ONLY in Options.agents, echoed its nonce (so the definition channel demonstrably works in " +
        `this very session), while ${ON_DISK_AGENT} — same shape, same session, same parent prompt ` +
        `— did not. The MODEL channel says the same thing independently of the prompt: the fresh ` +
        `child ran on ${s1.fresh.resolvedModel ?? "n/a"} (${s1.fresh.modelProvenance}) while the ` +
        `colliding-name child ran on ${s1.onDisk.resolvedModel ?? "n/a"} ` +
        `(${s1.onDisk.modelProvenance}, via ${s1.onDisk.modelVia}) — the model named in ` +
        "code-reviewer.md, not the one in Options.agents. The on-disk definition won on BOTH " +
        "fields the disk file DECLARES. The per-agent report contract, which lives in the prompt, " +
        "is therefore decoration for every shortlisted agent that exists on disk.";
      state.caveats.push(
        `The disk file declares only name/description/tools/model/color — it is SILENT on maxTurns ` +
          "and background. S2 and S3 were run anyway rather than entailed from the nonce, because a " +
          "per-field merge that fills only the gaps the disk leaves would bind them.",
      );
    } else {
      // The on-disk nonce came back. The definition (at least its prompt) BINDS.
      state.agentsBinds = true;
      state.whichReading =
        s1.onDisk.modelProvenance === "on-disk-frontmatter"
          ? "both_bind_disallowedtools_ignored"
          : "spec_inert";
    }

    if (!s1.fresh.nonceEchoed) {
      state.caveats.push(
        "The negative control did not echo its own nonce even though the on-disk-collision arm did. " +
          "The positive is still a positive (the nonce cannot have reached the child any other way), " +
          "but the control arm was degraded — treat the fresh-name comparisons in S2/S3 with care.",
      );
    }
    if (s1.onDisk.nonceEchoed && s1.onDisk.modelProvenance === "inherited-from-parent") {
      state.caveats.push(
        "The MODEL channel was inconclusive: resolvedModel came back as the parent's own model, so " +
          "neither the Options `model: haiku` nor the on-disk `model: claude-opus-5` was resolved. " +
          "REPLACE and MERGE cannot be separated on this channel in this run; the reading is " +
          "reported as spec_inert on the strength of the prompt channel alone.",
      );
    }
    if (s1.onDisk.emittedModel ?? s1.onDisk.arm?.emittedModel) {
      state.caveats.push(
        "VOID MODEL CHANNEL: the parent volunteered a `model` parameter on the Agent call, which " +
          "sdk-tools.d.ts:498 says takes precedence over the definition. resolvedModel says nothing " +
          "about provenance in that case.",
      );
    }

    // ── S2: maxTurns ────────────────────────────────────────────────────────
    const s2 = await runners.s2();
    if (s2) state.s2 = publicArm(s2);
    if (s2) {
      state.maxTurnsClassification = {
        fresh: s2.fresh.classification,
        onDisk: s2.onDisk.classification,
      };
    }
    const maxTurns = decideMaxTurns(s2);
    state.maxTurnsBinds = maxTurns.binds;
    state.maxTurnsMeasured = maxTurns.measured;
    state.caveats.push(...maxTurns.caveats);
    if (s2?.session.timedOut) {
      state.caveats.push("S2 hit the 90 s ceiling; a missing delegation may be a timeout, not a stop.");
    }

    // ── S3: background ──────────────────────────────────────────────────────
    const s3 = await runners.s3();
    if (s3) state.s3 = publicArm(s3);
    const background = decideBackground(s3);
    state.backgroundBinds = background.binds;
    state.backgroundMeasured = background.measured;
    state.backgroundNeedsDefaultControl = background.needsDefaultControl;
    state.caveats.push(...background.caveats);
    if (s3?.session.timedOut) {
      state.caveats.push("S3 hit the 90 s ceiling; a missing delegation may be a timeout, not a stop.");
    }

    // ── S4: the reserve arm. Spent ONLY to rescue an ambiguous S3. ───────────
    if (state.backgroundNeedsDefaultControl) {
      const s4 = await runners.s4();
      if (s4) {
        state.s4 = publicArm(s4);
        if (!s4.delegated || s4.voidBecauseParentSetIt) {
          state.backgroundBinds = false;
          state.caveats.push(
            `HARNESS-DEFAULT CONTROL VOID (delegated=${s4.delegated}, paramEmitted=` +
              `${s4.emittedRunInBackground}). S3's two foreground children therefore cannot be ` +
              "attributed to background:false rather than to the SDK simply not backgrounding. " +
              "backgroundBinds is reported false as UNKNOWN, not as measured-inert.",
          );
        } else if (s4.defaultIsBackground) {
          state.caveats.push(
            "HARNESS-DEFAULT CONTROL HELD: with the `background` field OMITTED and the parameter " +
              "omitted too, the fresh-name child was launched ASYNCHRONOUSLY. Background is the " +
              "default in this build, so S3's two foreground children are a real effect of " +
              "background:false and not the absence of any effect.",
          );
        } else {
          state.backgroundBinds = false;
          state.caveats.push(
            "HARNESS-DEFAULT CONTROL FAILED THE OTHER WAY: with `background` omitted entirely the " +
              "child STILL ran in the foreground, so foreground is what happens anyway in this SDK " +
              "build and S3 measured nothing about background:false. backgroundBinds is reported " +
              "false as UNKNOWN, not as measured-inert. AgentInput's documented " +
              "'agents run in the background by default' does not describe this transport.",
          );
        }
      } else {
        state.backgroundBinds = false;
        state.backgroundMeasured = false;
        state.caveats.push(
          "S3 came back foreground on both names but the harness-default control did not run (budget " +
            "exhausted, or this was a --reclassify pass), so 'background:false held' cannot be " +
            "separated from 'foreground happens anyway'. backgroundBinds is reported false as UNKNOWN.",
        );
      }
    }

    // ── Verdict ─────────────────────────────────────────────────────────────
    if (readingBNotes) {
      // The prompt and the model both resolved to the disk definition. PASS is
      // off the table whatever the two gap-fields did.
      const gapFieldBinds = state.maxTurnsBinds || state.backgroundBinds;
      if (gapFieldBinds) {
        state.whichReading = "both_bind_disallowedtools_ignored";
        state.verdict = "PARTIAL";
        state.notes =
          `${readingBNotes} BUT NOT NOTHING: the two fields code-reviewer.md leaves UNDECLARED were ` +
          `filled from Options.agents after all — maxTurnsBinds=${state.maxTurnsBinds}, ` +
          `backgroundBinds=${state.backgroundBinds}. That is a PER-FIELD MERGE: the disk entry wins ` +
          "wherever it declares a value (prompt, model, tools) and the Options entry survives only " +
          "in the gaps. Production's structural guard and lane budget are therefore NOT decoration, " +
          "while the prompt and the report contract are.";
      } else {
        state.verdict = "FAIL";
        state.notes =
          `${readingBNotes} AND THE TWO PRODUCTION FIELDS WERE MEASURED, NOT ENTAILED: ` +
          `maxTurnsBinds=${state.maxTurnsBinds}, backgroundBinds=${state.backgroundBinds}. Even the ` +
          "fields code-reviewer.md leaves undeclared did not survive, so nothing in the Options " +
          "entry reaches the child. background:false and maxTurns are decoration for every " +
          "shortlisted agent that exists on disk.";
      }
    } else {
      const bothBind = state.maxTurnsBinds && state.backgroundBinds;
      const neitherBinds = !state.maxTurnsBinds && !state.backgroundBinds;
      state.verdict = bothBind ? "PASS" : neitherBinds ? "FAIL" : "PARTIAL";

      const readingSentence =
        state.whichReading === "both_bind_disallowedtools_ignored"
          ? "A MERGE, not a replacement: the Options prompt reached the child while the on-disk " +
            `frontmatter model (${s1.onDisk.resolvedModel}) survived. Both definitions are in force; ` +
            "G2's disallowedTools is the field being dropped."
          : "The Options entry took effect for a colliding name (READING A: the definition binds, and " +
            "G2's disallowedTools is a per-field no-op rather than evidence of a dead channel).";

      state.notes =
        `MEASURED: Options.agents BINDS for '${ON_DISK_AGENT}' even though a same-named agent exists ` +
        `in ~/.claude/agents/. The nonce planted ONLY in AgentDefinition.prompt came back through ` +
        `the Agent tool_result, and the parent never held it. ${readingSentence} Per-field: ` +
        `maxTurnsBinds=${state.maxTurnsBinds}, backgroundBinds=${state.backgroundBinds} ` +
        `(resolvedModel on-disk arm=${s1.onDisk.resolvedModel ?? "n/a"} → ${s1.onDisk.modelProvenance}; ` +
        `fresh arm=${s1.fresh.resolvedModel ?? "n/a"} → ${s1.fresh.modelProvenance}).`;
    }

    state.caveats.push(
      `n=1 per arm. One model (${MODEL}), one on-disk agent (${ON_DISK_AGENT}), one fresh name, SDK ` +
        "0.3.220. Nothing here generalises to other agents on the shortlist without re-running.",
    );
    state.caveats.push(
      "The session-level MCP lock (managedSettings.allowedMcpServers:[] + " +
        "allowManagedMcpServersOnly) is ON in every arm, held byte-identical. It is orthogonal to " +
        "agent binding but it is not production-absent, and without it no arm finishes inside 90 s.",
    );


    return state;
}

function writeResult(result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, RESULT_FILE);
  if (existsSync(path)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const archive = join(HISTORY_DIR, `${PROBE}-superseded-at-${RUN_STAMP}.json`);
    if (!existsSync(archive)) cpSync(path, archive);
  }
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

function writeRaw(extra) {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, RAW_FILE);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        probe: PROBE,
        ranAt: new Date().toISOString(),
        runStamp: RUN_STAMP,
        sessionsSpent,
        maxLiveSessions: MAX_LIVE_SESSIONS,
        ...extra,
        sessions: SESSION_LOG,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function publicArm(arm) {
  if (!arm) return null;
  const { fixture: _fixture, ...rest } = arm;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const flags = new Set(argv);
  const fixtures = [];

  const state = {
    probe: PROBE,
    question:
      "Does Options.agents bind at all for an agent name that ALSO exists in ~/.claude/agents/? " +
      "And if it does, do AgentDefinition.maxTurns and AgentDefinition.background bind with it — " +
      "the two fields production relies on as a per-lane budget and a structural guard?",
    sdkVersion: "0.3.220",
    runStamp: RUN_STAMP,
    model: MODEL,
    definitionModel: DEFINITION_MODEL,
    onDiskAgent: ON_DISK_AGENT,
    freshAgent: FRESH_AGENT,
    resultsDir: RESULTS_DIR,
    whyThisExists:
      "Probe G2 measured per-agent disallowedTools:['mcp__*'] doing nothing (child at 620 tools, " +
      "589 mcp__, identical to an unnarrowed child). Two readings explain that and G2 could not " +
      "separate them: 'Options.agents binds but disallowedTools is ignored' (spec_inert) versus " +
      "'Options.agents does not bind at all when a same-named agent exists on disk' " +
      "(agents_does_not_bind). Under the second, background:false and maxTurns are decoration too.",
    typingsOnPrecedence: TYPINGS_ON_PRECEDENCE,
    onDiskRoster: null,

    // ── headline answers ──
    agentsBinds: false,
    whichReading: "undetermined",
    nonceEchoed: false,
    maxTurnsBinds: false,
    backgroundBinds: false,
    verdict: "ERROR",
    notes: "probe did not complete",
    caveats: [],

    // ── evidence ──
    negativeControlHeld: false,
    modelProvenanceOnDisk: null,
    modelProvenanceFresh: null,
    registryVsRuntime: null,
    // How many LIVE sessions the scored observations cost. Distinct from
    // `sessionsSpent`, which is what THIS process spent (0 for --reclassify).
    observationsFromLiveSessions: null,
    observationsFromRunStamp: null,
    observationsSessionLabels: null,
    maxTurnsClassification: null,
    backgroundNeedsDefaultControl: false,
    s1: null,
    s2: null,
    s3: null,
    s4: null,
    sessionsSpent: 0,
  };

  try {
    // ── Pre-flight: both arms are claims ABOUT ~/.claude/agents/. Verify them. ──
    const roster = scanOnDiskAgents();
    state.onDiskRoster = {
      dir: roster.dir,
      exists: roster.exists,
      count: roster.count,
      onDiskAgentPresent: roster.names.includes(ON_DISK_AGENT),
      freshAgentPresent: roster.names.includes(FRESH_AGENT),
      onDiskAgentFrontmatter: roster.byName?.[ON_DISK_AGENT] ?? null,
      duplicateNames: roster.duplicateNames ?? [],
      error: roster.error,
    };

    if (flags.has("--verify-paths")) {
      state.verdict = "ERROR";
      state.whichReading = "undetermined";
      state.notes =
        `INCONCLUSIVE BY DESIGN: --verify-paths run. sessionsSpent=${sessionsSpent} — NO live ` +
        "session was started and NOTHING was measured. This run exists only to prove that this " +
        `copy writes ${RESULT_FILE} and raw/${RAW_FILE} and touches no other probe's artefacts.`;
      state.caveats.push("path-verification run only; no measurement was performed");
      if (sessionsSpent !== 0) {
        throw new Error(`--verify-paths spent ${sessionsSpent} live sessions; that is a bug`);
      }
      return 0;
    }

    /**
     * `--reclassify` — RE-SCORE A PREVIOUS RUN, SPENDING NO SESSION.
     *
     * Probes write their observations down precisely so the reasoning applied to
     * them can be corrected without re-buying the data. This pass loads the arms
     * recorded in the previous `I.json` and pushes them through the SAME
     * `scoreRun` the live path uses — not a second implementation of the decision
     * logic, which would be a second thing to get wrong. Per-arm classifications
     * are recomputed from the recorded fields, so a fix to `classifyMaxTurnsArm`
     * lands on data already in hand.
     *
     * The raw session log is NOT rewritten: this pass observed nothing, and a
     * `sessions: []` log stamped over a real one would destroy the evidence the
     * re-scoring rests on.
     */
    if (flags.has("--reclassify")) {
      const priorPath = join(RESULTS_DIR, RESULT_FILE);
      if (!existsSync(priorPath)) {
        throw new Error(`--reclassify needs a previous ${RESULT_FILE} at ${priorPath}; none found`);
      }
      const prior = JSON.parse(readFileSync(priorPath, "utf8"));
      if (!prior.s1) {
        throw new Error("--reclassify: the previous record has no S1 arm, so there is nothing to score");
      }
      state.reclassifiedFrom = {
        runStamp: prior.runStamp ?? null,
        // Walk the chain: a prior that was ITSELF a reclassify recorded 0.
        sessionsSpentInThatRun:
          prior.sessionsSpent || prior.observationsFromLiveSessions ||
          prior.reclassifiedFrom?.sessionsSpentInThatRun || null,
        priorVerdict: prior.verdict ?? null,
        priorMaxTurnsBinds: prior.maxTurnsBinds ?? null,
        priorBackgroundBinds: prior.backgroundBinds ?? null,
      };
      state.caveats.push(
        `--reclassify pass: ZERO live sessions were started. Every observation scored below was ` +
          `recorded by the run stamped ${prior.runStamp ?? "unknown"}; only the SCORING was ` +
          "recomputed, through the same functions the live path uses. The raw session log from that " +
          "run is left untouched.",
      );
      /**
       * Re-score, and while we are here RECOVER a channel the original run
       * recorded but did not yet use: the `PreToolUse` firings carrying each
       * child's `agent_id`, which live in the raw session log rather than in the
       * result file. A correction pass that ignored evidence already on disk
       * would be a strange kind of correction.
       */
      const rawPath = join(RAW_DIR, RAW_FILE);
      let priorFirings = null;
      let rawRunStamp = null;
      let rawSessionCount = null;
      let rawSessionLabels = null;
      if (existsSync(rawPath)) {
        try {
          const rawLog = JSON.parse(readFileSync(rawPath, "utf8"));
          rawRunStamp = rawLog.runStamp ?? null;
          rawSessionCount = rawLog.sessionsSpent ?? (rawLog.sessions ?? []).length;
          rawSessionLabels = (rawLog.sessions ?? []).map((x) => x.label);
          const s2Session = (rawLog.sessions ?? []).find((x) => String(x.label).includes("S2"));
          if (s2Session) priorFirings = s2Session.hookState?.firings ?? null;
        } catch {
          priorFirings = null;
        }
      }

      /**
       * WHAT THE OBSERVATIONS COST, kept separate from what THIS pass cost.
       *
       * `sessionsSpent` is honest about the reclassify pass — it is 0 — and read
       * cold, next to a FAIL, that is exactly the shape of a result a reviewer
       * dismisses as never actually measured. The count lived only in the raw
       * log, and a chain of reclassifies lost it entirely (each one recording the
       * previous pass's 0). It is recovered here from the raw log and stated in
       * its own field, so the result file says both things at once.
       */
      state.observationsFromLiveSessions = rawSessionCount;
      state.observationsFromRunStamp = rawRunStamp;
      state.observationsSessionLabels = rawSessionLabels;
      // The raw log belongs to the last LIVE run; the result file may already be
      // a reclassify OF that run, so its own stamp will differ. Walk the chain,
      // and when the stamps cannot be reconciled, still use the firings but say
      // so in the record rather than silently scoring against another run.
      const stampChain = [prior.runStamp, prior.reclassifiedFrom?.runStamp].filter(Boolean);
      state.reclassifiedFrom.hookFiringsRecovered = Boolean(priorFirings);
      state.reclassifiedFrom.hookFiringsFromRunStamp = rawRunStamp;
      state.reclassifiedFrom.hookFiringsStampMatchesChain = stampChain.includes(rawRunStamp);
      if (priorFirings && !state.reclassifiedFrom.hookFiringsStampMatchesChain) {
        state.caveats.push(
          `The PreToolUse firings used to corroborate the maxTurns arms came from raw/${RAW_FILE} ` +
            `stamped ${rawRunStamp}, which does not appear in the result file's own stamp chain ` +
            `(${stampChain.join(" ← ") || "none"}). They are used anyway — the raw log is by ` +
            "construction the last live run's — but check the two stamps before leaning on them.",
        );
      }
      const rescore = (view, agentType) => {
        // An EMPTY recorded array is not an observation of "no tools" — it is
        // what an earlier scoring pass wrote before this channel existed. Recover
        // over it, and only keep a recorded list when it actually holds names.
        const recovered = priorFirings ? hookToolNamesFor(priorFirings, agentType) : [];
        const enriched = {
          ...view,
          hookToolNames: view.hookToolNames?.length ? view.hookToolNames : recovered,
        };
        return { ...enriched, classification: classifyMaxTurnsArm(enriched) };
      };
      const rescoreS2 = (s2) =>
        s2
          ? {
              ...s2,
              fresh: rescore(s2.fresh, FRESH_AGENT),
              onDisk: rescore(s2.onDisk, ON_DISK_AGENT),
            }
          : null;
      await scoreRun(state, prior.s1, {
        s2: async () => rescoreS2(prior.s2),
        s3: async () => prior.s3,
        // S4 is a live-only control; a reclassify pass can never supply one.
        s4: async () => null,
      });
      state.s1 = prior.s1;
      return state.verdict === "PASS" ? 0 : 1;
    }

    if (!state.onDiskRoster.onDiskAgentPresent || state.onDiskRoster.freshAgentPresent) {
      state.notes =
        `INCONCLUSIVE: the on-disk premise does not hold. '${ON_DISK_AGENT}' present=` +
        `${state.onDiskRoster.onDiskAgentPresent} (must be true), '${FRESH_AGENT}' present=` +
        `${state.onDiskRoster.freshAgentPresent} (must be false). Without the collision on one name ` +
        "and its absence on the other, neither arm measures what it claims to.";
      return 1;
    }

    // ── S1: the nonce echo ──────────────────────────────────────────────────
    let s1 = await runS1(1);
    fixtures.push(s1.fixture);
    const s1Usable = (a) => a.fresh.delegated || a.onDisk.delegated;
    if (!s1Usable(s1) && sessionsSpent < MAX_LIVE_SESSIONS) {
      state.s1FirstAttempt = publicArm(s1);
      s1 = await runS1(2);
      fixtures.push(s1.fixture);
    }
    state.s1 = publicArm(s1);
    await scoreRun(state, s1, {
      s2: async () => {
        if (sessionsSpent >= MAX_LIVE_SESSIONS) return null;
        const arm = await runS2(1);
        fixtures.push(arm.fixture);
        return arm;
      },
      s3: async () => {
        if (sessionsSpent >= MAX_LIVE_SESSIONS) return null;
        const arm = await runS3(1);
        fixtures.push(arm.fixture);
        return arm;
      },
      s4: async () => {
        if (sessionsSpent >= MAX_LIVE_SESSIONS) return null;
        const arm = await runBackgroundDefaultControl(1);
        fixtures.push(arm.fixture);
        return arm;
      },
    });

    return state.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    state.verdict = "ERROR";
    state.notes = `probe crashed: ${truncate(error?.stack ?? error?.message ?? error, 800)}`;
    return 1;
  } finally {
    state.sessionsSpent = sessionsSpent;
    if (state.observationsFromLiveSessions === null) {
      state.observationsFromLiveSessions = sessionsSpent;
      state.observationsFromRunStamp = RUN_STAMP;
      state.observationsSessionLabels = SESSION_LOG.map((x) => x.label);
    }
    const resultPath = writeResult(state);
    // A reclassify pass observed nothing; stamping `sessions: []` over a real log
    // would destroy the evidence its own re-scoring rests on.
    const rawPath = flags.has("--reclassify")
      ? null
      : writeRaw({ fixtures: fixtures.map((f) => f.root) });
    console.log(JSON.stringify(state, null, 2));
    console.log(
      `\nwrote ${resultPath}\n${
        rawPath ? `wrote ${rawPath}` : `raw/${RAW_FILE} left untouched (--reclassify observed nothing)`
      }  (live sessions spent: ${sessionsSpent}/${MAX_LIVE_SESSIONS})`,
    );
    if (!flags.has("--keep-fixture")) {
      for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
    } else {
      for (const fixture of fixtures) console.log(`fixture kept: ${fixture.root}`);
    }
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
