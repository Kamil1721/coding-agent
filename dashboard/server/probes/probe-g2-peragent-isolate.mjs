/**
 * PROBE G2 — is the PER-AGENT half of the MCP narrowing a real boundary, or a
 * no-op that probe G could not tell apart from one?
 *
 * WHY THIS FILE EXISTS, AND IT IS PROBE G'S OWN BLIND SPOT
 * ───────────────────────────────────────────────────────
 * Probe G measured the production PAIR — session-level
 * `managedSettings.allowedMcpServers: []` + `allowManagedMcpServersOnly`, AND
 * per-agent `AgentDefinition.disallowedTools: ["mcp__*"]` — applied together, and
 * got a child at 28 tools with zero MCP against an unnarrowed child at 619 with
 * 588 `mcp__` names. PASS, and the number is real.
 *
 * But read probe G's own narrowed arm back: `initMcpServerCount: 0`,
 * `initMcpToolNames: []`. THE SESSION HAD NO MCP TOOLS FOR ANYONE. So the
 * per-agent spec removed tools that were already gone, and production's second
 * layer — the one `claude-builder.ts` calls "defence in depth" — could be a
 * complete no-op with probe G's run looking byte-identical either way. A
 * mechanism that held and a mechanism that was never invoked are indistinguishable
 * in that transcript. That is this project's signature defect, sitting inside the
 * probe written to avoid it.
 *
 * THE ONE ARM THAT SEPARATES THEM
 * ───────────────────────────────
 * Session-level lock REMOVED (the session keeps all 13 MCP servers), per-agent
 * `disallowedTools: ["mcp__*"]` KEPT. Everything else is byte-identical to probe
 * G, including the prompt, the target agent, the hooks, the `mcp__*` deny and
 * `allowManagedHooksOnly`.
 *
 *   child ≈ 28–31 names, 0 mcp   → the per-agent spec BINDS. Defence in depth is real.
 *   child ≈ 619 names, 588 mcp   → the per-agent spec is a NO-OP in SDK 0.3.220,
 *                                  and production's second layer is decoration.
 *
 * Both outcomes are findings. Only the first is a PASS.
 *
 * THE CONTROL IS IN THIS RUN, NOT IN PROBE G'S
 * ────────────────────────────────────────────
 * A child with no MCP tools proves nothing unless the SAME SESSION is shown to
 * have MCP tools in it. Two same-run controls, and BOTH must hold:
 *   - the engine's own `system/init` reports a NON-ZERO MCP server count (and any
 *     `connected` server's tools appear in `init.tools`); and
 *   - the PARENT, asked in the same run, reports a NON-ZERO count of its own
 *     `mcp__` tools.
 * If either fails, the arm is VOID and the child's zero measures nothing. The
 * parent is asked for a COUNT and five names — not a full census — because probe
 * G's unnarrowed arm hit the ceiling writing hundreds of names and never got to
 * its parent step.
 *
 * NO MCP TOOL IS EXECUTED: the `PreToolUse` hook denies every `mcp__*` name, and
 * probe G measured that deny holding for a subagent-originated call (is_error
 * tool_result carrying the probe's own reason).
 *
 * Writes ONLY `<results>/G-PERAGENT.json` and
 * `<results>/raw/G-PERAGENT-session-log.json`. `PROBE_RESULTS_DIR` redirects both.
 * Run `--verify-paths` FIRST: the writer fires from `finally` on every exit path.
 *
 * Usage: node probes/probe-g2-peragent-isolate.mjs [--verify-paths] [--keep-fixture]
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
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.env.PROBE_RESULTS_DIR || join(HERE, "results");
const RESULT_FILE = "G-PERAGENT.json";
const RAW_FILE = "G-PERAGENT-session-log.json";
const RAW_DIR = join(RESULTS_DIR, "raw");
const HISTORY_DIR = join(RESULTS_DIR, "history");
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");

/**
 * 5 minutes, not the 90 s the other probes use, and the reason is specific: an
 * UNNARROWED child may have hundreds of tool names to write out, and a timeout
 * mid-census would destroy the very number this probe exists to obtain. The
 * census is read off DISK afterwards regardless of how the session ended, so a
 * timeout degrades the measurement rather than erasing it.
 */
const HARD_TIMEOUT_MS = 300_000;

/** Hard session budget for the whole probe. Exceeding it is a bug. */
const MAX_LIVE_SESSIONS = 2;
let sessionsSpent = 0;

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

/** Probe E measured this model reliably follows "use the Agent tool". A child
 *  that never starts measures nothing, so this is not the place to save money. */
const MODEL = "claude-sonnet-5";

/** See the header: on the production shortlist AND carrying no `tools:`
 *  frontmatter allowlist, which 141 of the owner's 144 agents do carry. */
const TARGET_AGENT = "trigger-dev-expert";

const CHILD_FILE_BASENAME = "child-tool-census.txt";
const PARENT_FILE_BASENAME = "parent-tool-census.txt";

// ─────────────────────────────────────────────────────────────────────────────
// Prompts. Byte-identical between arms except for the absolute paths, which
// differ only because each arm gets its own fresh temp tree.
// ─────────────────────────────────────────────────────────────────────────────

function childInstruction(childFile) {
  return (
    "Do NOT do any Trigger.dev work and do not write any code. This is a tool-surface census, and " +
    "you are the instrument. Do exactly these three steps, in order.\n" +
    `(1) Write a file at the absolute path ${childFile}. Its contents must be the exact name of ` +
    "EVERY tool you have available, ONE NAME PER LINE, spelled exactly as the tool is named to you, " +
    "with no bullets, no numbering, no commentary and no markdown. Do not summarise, do not " +
    "abbreviate, do not truncate: if the list is long, write all of it anyway. After the last name, " +
    "write these two lines and nothing after them:\n" +
    "TOTAL=<the number of tool names you listed above>\n" +
    "MCP_TOTAL=<how many of those names begin with mcp__>\n" +
    "(2) THEN, if and only if you actually have a tool whose name begins with mcp__, call exactly ONE " +
    "of them, exactly once. Choose one whose name contains resolve or search or list or get. NEVER " +
    "call one that creates, updates, deletes, deploys, writes, uploads, sends, or drives a browser. " +
    "If the call is refused, that is expected: do not retry it, do not try a different tool, and do " +
    "not work around it.\n" +
    "(3) Reply with ONE line, and nothing else: either `MCP_PRESENT=yes <the exact name you called>` " +
    "or `MCP_PRESENT=no` if you have no tool whose name begins with mcp__."
  );
}

function parentPrompt(childFile, parentFile) {
  return (
    "You are running a tool-surface census. Do exactly these two steps, in order, and nothing else.\n\n" +
    `STEP 1. Use the Agent tool to delegate to the \`${TARGET_AGENT}\` subagent. Give it EXACTLY this ` +
    "instruction, verbatim, as its prompt:\n\n" +
    `<<<\n${childInstruction(childFile)}\n>>>\n\n` +
    "STEP 2. After the subagent returns, write a SHORT file at the absolute path " +
    `${parentFile}: the exact names of the first FIVE tools YOU have whose name begins with mcp__, ` +
    "one per line (write no names at all if you have none), and then a final line reading " +
    "MCP_TOTAL=<the total number of tools you have whose name begins with mcp__>. Do NOT list your " +
    "other tools — this file is a control, not a census, and it must be quick to write.\n\n" +
    "Then reply with the single word DONE."
  );
}

/**
 * A census entry naming an MCP tool is evidence ONLY if the name could not have
 * been copied out of the prompt. Enforced at run time rather than left to a
 * comment: any `mcp__…__…` token in the prompt text and the probe refuses to run.
 */
function assertPromptNamesNoMcpTool(...texts) {
  for (const text of texts) {
    const match = /mcp__[A-Za-z0-9_:.\-]+__[A-Za-z0-9_:.\-]+/.exec(text);
    if (match) {
      throw new Error(
        `prompt names a concrete MCP tool (${match[0]}) — a census entry could then be a copy of the ` +
          "prompt rather than an observation of the child's surface",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — a FRESH tree per arm, and a DISTINCT filename per arm. Both, not
// either: a stale census file read as this arm's result is a silent false green.
// ─────────────────────────────────────────────────────────────────────────────

function makeFixture(armTag) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `probe-g-${armTag}-`)));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return {
    root,
    workspace,
    childFile: join(workspace, `${armTag}-${CHILD_FILE_BASENAME}`),
    parentFile: join(workspace, `${armTag}-${PARENT_FILE_BASENAME}`),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session driver
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

function observe(obs, message) {
  obs.envelopes.push(`${message.type}${message.subtype ? `/${message.subtype}` : ""}`);

  if (message.type === "system" && message.subtype === "init") {
    obs.init = {
      model: message.model ?? null,
      permissionMode: message.permissionMode ?? null,
      // THE PARENT'S ENGINE-SIDE COUNT. Note the time-point: `init` is emitted
      // before MCP servers finish connecting (they report status "pending"), so
      // this number structurally EXCLUDES MCP tools. See G.json's parent block.
      toolCount: (message.tools ?? []).length,
      toolNames: message.tools ?? [],
      mcpServers: (message.mcp_servers ?? []).map((s) => `${s.name}:${s.status ?? "?"}`),
      mcpServerCount: (message.mcp_servers ?? []).length,
      agentCount: (message.agents ?? []).length,
      sessionId: message.session_id ?? null,
    };
  }

  if (message.type === "system" && message.subtype === "task_started") {
    if (message.subagent_type) {
      (message.skip_transcript ? obs.skipTranscriptSubagentStarts : obs.subagentStarts).push(
        message.subagent_type,
      );
    } else {
      obs.otherTaskStarts.push(message.task_type ?? "unknown");
    }
  }

  if (message.type === "assistant") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") obs.transcript += block.text ?? "";
        if (block?.type === "tool_use") {
          // PARENT-side only: probe E measured that a subagent's own tool calls
          // do not appear in the parent's assistant stream. That asymmetry is
          // exactly what makes this list usable for AUTHORSHIP attribution.
          obs.parentToolUses.push({ name: block.name, input: block.input ?? {} });
        }
      }
    }
  }

  if (message.type === "user") obs.transcript += safeStringify(message.message?.content);

  if (message.type === "result") {
    obs.sawResult = true;
    obs.resultSubtype = message.subtype ?? null;
    obs.numTurns = message.num_turns ?? null;
  }
}

const SESSION_LOG = [];

async function runSession({ label, prompt, options, state }) {
  if (sessionsSpent >= MAX_LIVE_SESSIONS) {
    throw new Error(`session budget exhausted (${MAX_LIVE_SESSIONS}); refusing to start ${label}`);
  }
  sessionsSpent += 1;

  const obs = {
    label,
    init: null,
    envelopes: [],
    parentToolUses: [],
    subagentStarts: [],
    skipTranscriptSubagentStarts: [],
    otherTaskStarts: [],
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

  obs.hookState = state;

  SESSION_LOG.push({
    label,
    envelopes: obs.envelopes,
    init: obs.init,
    parentToolUses: obs.parentToolUses.map((u) => ({
      name: u.name,
      input: truncate(safeStringify(u.input), 400),
    })),
    subagentStarts: obs.subagentStarts,
    skipTranscriptSubagentStarts: obs.skipTranscriptSubagentStarts,
    otherTaskStarts: obs.otherTaskStarts,
    hookState: state,
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
// Apparatus: hooks + canUseTool. Identical in both arms.
// ─────────────────────────────────────────────────────────────────────────────

function freshState() {
  return {
    firings: [],
    subagentStarts: [],
    subagentStops: [],
    canUseToolConsultations: [],
    mcpDeniedByHook: [],
    mcpDeniedByCanUseTool: [],
  };
}

const MCP_DENY_REASON = "probe G: MCP calls are recorded and blocked in BOTH arms (held constant)";

function isMcpName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

function buildHooks(state) {
  return {
    PreToolUse: [
      {
        // No matcher: probe E measured that a matcher-less slot sees every tool,
        // and a name-filtered slot would report "never fired" for a tool named
        // something nobody grepped for.
        hooks: [
          async (input) => {
            const toolName = input?.tool_name ?? null;
            const firing = {
              toolName,
              // `agent_id` is present ONLY from inside a subagent (sdk.d.ts:174).
              // This is the whole attribution mechanism for channel (4).
              firedInsideSubagent: Boolean(input?.agent_id),
              insideAgentType: input?.agent_id ? (input?.agent_type ?? null) : null,
              isMcp: isMcpName(toolName),
              atMs: Date.now(),
            };
            state.firings.push(firing);
            if (firing.isMcp) {
              state.mcpDeniedByHook.push(firing);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: MCP_DENY_REASON,
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
            state.subagentStarts.push({
              agentType: input?.agent_type ?? null,
              agentId: input?.agent_id ? "present" : null,
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
            // `agent_transcript_path` (sdk.d.ts:6809) is the child's own
            // engine-written transcript. Read afterwards for tool_use NAMES
            // only — never contents.
            state.subagentStops.push({
              agentType: input?.agent_type ?? null,
              transcriptPath: input?.agent_transcript_path ?? null,
            });
            return { continue: true };
          },
        ],
      },
    ],
  };
}

/**
 * A second, independent deny of `mcp__*`, and a second record of the attempt.
 *
 * Not redundancy for its own sake: whether a `PreToolUse` hook fires at all for a
 * SUBAGENT-originated call is UNVERIFIED in this tree (STATUS.md §3; probe E's
 * four arms recorded `firedInsideSubagent=false` everywhere, but its children
 * only ever replied with a word and called no tool). If the hook turns out not to
 * fire inside a subagent, this callback is the surviving in-process record of the
 * attempt — and it also stops an MCP call parking on a permission prompt that no
 * human is there to answer.
 */
function makeCanUseTool(state) {
  return async (toolName, input) => {
    state.canUseToolConsultations.push({
      toolName,
      isMcp: isMcpName(toolName),
      inputExcerpt: truncate(safeStringify(input), 200),
      atMs: Date.now(),
    });
    if (isMcpName(toolName)) {
      state.mcpDeniedByCanUseTool.push({ toolName, atMs: Date.now() });
      return { behavior: "deny", message: MCP_DENY_REASON };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Options. The ONLY difference between arms is `narrowed`.
// ─────────────────────────────────────────────────────────────────────────────

function buildOptions(fixture, state, { narrowed }) {
  /** Mirrors `claude-builder.ts` ~765–781 (2026-07-28). `disallowedTools` is the
   *  per-agent half of the narrowing and is the arm variable. */
  const agentDefinition = {
    description: `Tool-surface census instrument for probe G2 (${narrowed ? "per-agent disallowedTools" : "no narrowing"} arm).`,
    prompt:
      `You are the \`${TARGET_AGENT}\` subagent, delegated a single measurement step. Follow the ` +
      "instruction you are given EXACTLY and literally. Do not substitute your own judgement about " +
      "what would be more useful, and do not do domain work of any kind.",
    maxTurns: 10,
    background: false,
    // THE ARM VARIABLE IN G2, and the only narrowing anywhere in this run.
    ...(narrowed ? { disallowedTools: ["mcp__*"] } : {}),
  };

  return {
    cwd: fixture.workspace,
    model: MODEL,
    maxTurns: 12,
    permissionMode: "acceptEdits",
    includePartialMessages: false,
    tools: { type: "preset", preset: "claude_code" },
    // Production parity, AND the reason MCP servers exist to be narrowed at all:
    // `results/mcp.json` measured 13 of them under this setting.
    settingSources: ["user"],
    agents: { [TARGET_AGENT]: agentDefinition },
    hooks: buildHooks(state),
    canUseTool: makeCanUseTool(state),
    managedSettings: {
      // HELD CONSTANT IN BOTH ARMS — see header. Suppresses the owner's own
      // hooks (including the Stop hook that can block completion) while probe C
      // showed our programmatic hooks still fire.
      allowManagedHooksOnly: true,
      // THE SESSION-LEVEL LOCK IS DELIBERATELY ABSENT. That absence IS probe G2:
      // the session keeps every MCP server, so the per-agent spec has something
      // real to remove and its failure to remove it would be visible.
    },
    env: probeEnv(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a census off disk
// ─────────────────────────────────────────────────────────────────────────────

/** Find a file by basename anywhere under `root`. A child that resolved the path
 *  against its own cwd must not cost a session. */
function findFile(root, wantedBasename, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name === wantedBasename) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, wantedBasename, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Parse a census file into counts.
 *
 * BOTH counts are kept and BOTH are reported: the DERIVED count (lines that look
 * like tool names) and the model's own STATED `TOTAL=`. Picking one silently
 * would hide the instrument degrading — a model that writes 40 names and claims
 * `TOTAL=600` is telling you something, and so is the reverse.
 */
function parseCensus(text) {
  const names = [];
  const nonNameLines = [];
  let statedTotal = null;
  let statedMcpTotal = null;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line === "```" || line.startsWith("```")) continue;
    // Tolerate bullets/numbering the instruction forbade, rather than discarding
    // a real name over formatting.
    line = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (!line) continue;

    const total = /^TOTAL\s*=\s*(\d+)/i.exec(line);
    if (total) {
      statedTotal = Number(total[1]);
      continue;
    }
    const mcpTotal = /^MCP_TOTAL\s*=\s*(\d+)/i.exec(line);
    if (mcpTotal) {
      statedMcpTotal = Number(mcpTotal[1]);
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_:.\-/]*$/.test(line)) names.push(line);
    else nonNameLines.push(line);
  }

  const unique = [...new Set(names)];
  const mcpNames = unique.filter((n) => n.startsWith("mcp__"));
  return {
    derivedCount: unique.length,
    duplicateLines: names.length - unique.length,
    statedTotal,
    statedMcpTotal,
    derivedMcpCount: mcpNames.length,
    mcpNamesSample: mcpNames.slice(0, 40),
    nameSample: unique.slice(0, 25),
    nonNameLineCount: nonNameLines.length,
    nonNameLineSample: nonNameLines.slice(0, 5).map((l) => truncate(l, 120)),
    countsAgree: statedTotal === null ? null : statedTotal === unique.length,
    // Instrument sanity: a census with none of these is not a tool list.
    hasBuiltins: ["Read", "Write", "Bash", "Edit", "Glob", "Grep"].filter((t) => unique.includes(t)),
  };
}

/** Read a census, attribute its authorship, and say plainly when it is absent. */
function readCensus(fixture, wantedPath, { writtenByParent }) {
  const wanted = basename(wantedPath);
  const found = existsSync(wantedPath) ? wantedPath : findFile(fixture.root, wanted);
  if (!found) {
    return {
      present: false,
      path: null,
      expectedPath: wantedPath,
      bytes: 0,
      writtenByParent,
      note: "NO CENSUS FILE. Nothing was measured through this channel.",
    };
  }
  const text = readFileSync(found, "utf8");
  return {
    present: true,
    path: found,
    expectedPath: wantedPath,
    foundAtExpectedPath: found === wantedPath,
    bytes: statSync(found).size,
    writtenByParent,
    ...parseCensus(text),
  };
}

/**
 * NOT AN AUTHORSHIP DISCRIMINATOR — see header note (a). It was designed as one
 * ("if the file exists and no parent tool_use targeted it, the child wrote it"),
 * and the 2026-07-28 run measured the premise false: in SDK 0.3.220 a SUBAGENT's
 * tool_use blocks surface in the PARENT's assistant stream, so this returns true
 * for a file the child wrote. Kept, unchanged, because it is what was recorded
 * and because the record must describe the run that produced it; read it as
 * "this file's name appears somewhere in the session's tool_use stream".
 *
 * Authorship is carried instead by the child's own `…/subagents/agent-*.jsonl`
 * transcript and by `PreToolUse` firings carrying `agent_id` — both engine-
 * written, both per-agent, neither producible by the parent.
 */
function parentWroteFile(obs, wantedPath) {
  const wanted = basename(wantedPath);
  return obs.parentToolUses.some((u) => {
    const blob = safeStringify(u.input);
    return (
      (u.name === "Write" || u.name === "Edit" || u.name === "NotebookEdit" || u.name === "Bash") &&
      blob.includes(wanted)
    );
  });
}

/**
 * Tool NAMES the child actually invoked, read out of the engine-written child
 * transcript. Names only — no message content is read, extracted or stored.
 */
function readChildTranscript(state) {
  const out = [];
  for (const stop of state.subagentStops) {
    const path = stop.transcriptPath;
    if (!path || !existsSync(path)) {
      out.push({ agentType: stop.agentType, path: path ?? null, exists: false, toolUseNames: [] });
      continue;
    }
    const names = new Set();
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const content = record?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_use" && typeof block.name === "string") names.add(block.name);
          }
        }
      }
    } catch {
      /* unreadable transcript is reported as such, never as "no tools" */
    }
    const list = [...names];
    out.push({
      agentType: stop.agentType,
      path,
      exists: true,
      toolUseNames: list,
      mcpToolUseNames: list.filter(isMcpName),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one arm
// ─────────────────────────────────────────────────────────────────────────────

async function runArm({ attempt }) {
  const label = `G2/per-agent-only${attempt > 1 ? `/retry${attempt - 1}` : ""}`;
  const fixture = makeFixture(`peragent${attempt > 1 ? `-retry${attempt - 1}` : ""}`);
  const state = freshState();

  const prompt = parentPrompt(fixture.childFile, fixture.parentFile);
  assertPromptNamesNoMcpTool(prompt);

  const obs = await runSession({
    label,
    prompt,
    // `narrowed: true` here means ONLY the per-agent spec — see buildOptions.
    options: buildOptions(fixture, state, { narrowed: true }),
    state,
  });

  const childCensus = readCensus(fixture, fixture.childFile, {
    writtenByParent: parentWroteFile(obs, fixture.childFile),
  });
  const parentControl = readCensus(fixture, fixture.parentFile, {
    writtenByParent: parentWroteFile(obs, fixture.parentFile),
  });
  const childTranscripts = readChildTranscript(state);

  const childStarted =
    obs.subagentStarts.includes(TARGET_AGENT) ||
    obs.skipTranscriptSubagentStarts.includes(TARGET_AGENT) ||
    state.subagentStarts.some((s) => s.agentType === TARGET_AGENT) ||
    state.firings.some((f) => f.firedInsideSubagent);

  // Attribution: probe G measured that a subagent's tool_use blocks surface in
  // the PARENT's stream, so only these two channels attribute anything to the
  // child — both engine-written, both per-agent.
  const hookMcpFromChild = state.mcpDeniedByHook.filter((f) => f.firedInsideSubagent);
  const transcriptMcp = childTranscripts.flatMap((t) => t.mcpToolUseNames ?? []);
  const childMcpAttemptObserved = hookMcpFromChild.length > 0 || transcriptMcp.length > 0;
  const childReportsMcpTools =
    (childCensus.derivedMcpCount ?? 0) > 0 || (childCensus.statedMcpTotal ?? 0) > 0;

  return {
    label,
    attempt,
    fixtureRoot: fixture.root,
    parent: {
      initToolCount: obs.init?.toolCount ?? null,
      initMcpServerCount: obs.init?.mcpServerCount ?? null,
      initMcpServers: obs.init?.mcpServers ?? null,
      initMcpToolNames: (obs.init?.toolNames ?? []).filter(isMcpName),
      mcpControlFile: parentControl,
    },
    child: {
      started: childStarted,
      census: childCensus,
      transcripts: childTranscripts,
      reportsMcpTools: childReportsMcpTools,
      mcpAttemptObserved: childMcpAttemptObserved,
      mcpEvidence: {
        preToolUseFiringsInsideSubagentForMcp: hookMcpFromChild.map((f) => f.toolName),
        mcpNamesInChildTranscript: transcriptMcp,
      },
      mcpSurface: childReportsMcpTools || childMcpAttemptObserved,
    },
    apparatus: {
      preToolUseFiringCount: state.firings.length,
      preToolUseFiredInsideSubagent: state.firings.some((f) => f.firedInsideSubagent),
      preToolUseToolNames: [...new Set(state.firings.map((f) => f.toolName ?? "null"))],
      canUseToolConsultationCount: state.canUseToolConsultations.length,
      subagentStopSeen: state.subagentStops.length > 0,
    },
    session: {
      resultSubtype: obs.resultSubtype,
      numTurns: obs.numTurns,
      timedOut: obs.timedOut,
      error: obs.error,
      sawResult: obs.sawResult,
      sessionId: obs.init?.sessionId ?? null,
    },
    fixture,
  };
}

function armUsable(arm) {
  return Boolean(
    arm.child.started &&
      arm.child.census.present &&
      (arm.child.census.derivedCount ?? 0) > 0 &&
      (arm.child.census.hasBuiltins ?? []).length > 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Result plumbing — G2's OWN two filenames, and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

function writeResult(result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, RESULT_FILE);
  if (existsSync(path)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const archive = join(HISTORY_DIR, `G-PERAGENT-superseded-at-${RUN_STAMP}.json`);
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
      { ranAt: new Date().toISOString(), runStamp: RUN_STAMP, sessionsSpent, ...extra, sessions: SESSION_LOG },
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

async function main(argv) {
  const flags = new Set(argv);

  const state = {
    probe: "G2",
    question:
      "With the SESSION-LEVEL MCP lock removed, does per-agent AgentDefinition.disallowedTools: " +
      "['mcp__*'] remove the child's MCP tools on its own — or is production's second layer a no-op " +
      "that probe G could not distinguish from a boundary?",
    sdkVersion: "0.3.220",
    runStamp: RUN_STAMP,
    targetAgent: TARGET_AGENT,
    model: MODEL,
    resultsDir: RESULTS_DIR,
    whyThisExists:
      "Probe G's narrowed arm ran with initMcpServerCount=0 and initMcpToolNames=[], so the " +
      "per-agent spec removed tools that were ALREADY ABSENT. Its PASS is fully explained by the " +
      "session-level lock alone. This probe is the arm that separates 'the mechanism held' from " +
      "'the mechanism was never invoked'.",
    comparisonBaseline:
      "Probe G's UNNARROWED arm, same prompt, same target agent, same instrument, 2026-07-28: " +
      "child = 619 names of which 588 mcp__, with a child-originated mcp__github__get_me observed. " +
      "That is what a child looks like when nothing removes MCP.",
    perAgentSpecBinds: null,
    childToolCount: null,
    childMcpCount: null,
    parentMcpTotalReported: null,
    positive: false,
    negativeControl: false,
    verdict: "ERROR",
    arm: null,
    sessionsSpent: 0,
    notes: "probe did not complete",
    caveats: [],
  };

  const fixtures = [];

  try {
    if (flags.has("--verify-paths")) {
      state.verdict = "VOID";
      state.notes =
        "INCONCLUSIVE: --verify-paths run. NO live session was started and nothing was measured. " +
        `Proves this copy writes ${RESULT_FILE} and raw/${RAW_FILE} and touches no other probe's ` +
        "artefacts — probe G's record in particular.";
      return 0;
    }

    let arm = await runArm({ attempt: 1 });
    fixtures.push(arm.fixture);
    if (!armUsable(arm) && sessionsSpent < MAX_LIVE_SESSIONS) {
      const retry = await runArm({ attempt: 2 });
      fixtures.push(retry.fixture);
      state.firstAttempt = publicArm(arm);
      arm = retry;
    }
    state.arm = publicArm(arm);
    state.childToolCount = arm.child.census.derivedCount ?? null;
    state.childMcpCount = arm.child.census.derivedMcpCount ?? null;
    state.parentMcpTotalReported =
      arm.parent.mcpControlFile.statedMcpTotal ?? arm.parent.mcpControlFile.derivedMcpCount ?? null;

    // ── THE TWO SAME-RUN CONTROLS. Both must hold or the child's zero is silence. ──
    const sessionHasMcpServers = (arm.parent.initMcpServerCount ?? 0) > 0;
    const parentHasMcpTools =
      (arm.parent.initMcpToolNames ?? []).length > 0 || (state.parentMcpTotalReported ?? 0) > 0;
    state.negativeControl = Boolean(sessionHasMcpServers && parentHasMcpTools);

    if (!armUsable(arm)) {
      state.verdict = "VOID";
      state.notes =
        `INCONCLUSIVE: no usable child census (started=${arm.child.started}, ` +
        `present=${arm.child.census.present}, count=${arm.child.census.derivedCount ?? "n/a"}). A ` +
        "missing census is not a narrow surface — it is a measurement that did not happen.";
    } else if (!state.negativeControl) {
      state.verdict = "VOID";
      state.notes =
        "INCONCLUSIVE: THE SAME-RUN CONTROL DID NOT HOLD. The session must be shown to HAVE an MCP " +
        `surface before a child without one means anything: initMcpServerCount=${arm.parent.initMcpServerCount}, ` +
        `initMcpToolNames=${(arm.parent.initMcpToolNames ?? []).length}, ` +
        `parent-reported MCP_TOTAL=${state.parentMcpTotalReported ?? "n/a"}. Without it, a child at ` +
        `${state.childToolCount} tools is indistinguishable from probe G's already-narrowed session. ` +
        "No claim is made about the per-agent spec.";
    } else if (!arm.child.mcpSurface) {
      state.perAgentSpecBinds = true;
      state.positive = true;
      state.verdict = "PASS";
      state.notes =
        `MEASURED: AgentDefinition.disallowedTools:["mcp__*"] BINDS ON ITS OWN. With every MCP ` +
        `server still loaded in the session (${arm.parent.initMcpServerCount} of them) and the ` +
        `parent still holding ${state.parentMcpTotalReported ?? "?"} mcp__ tools of its own IN THE ` +
        `SAME RUN, the child saw ${state.childToolCount} tools and ZERO mcp__ — no mcp__ name in its ` +
        "census, no mcp__ call in its own transcript, no PreToolUse firing carrying agent_id for an " +
        "mcp__ tool. Against probe G's unnarrowed child (619 names, 588 mcp__, same prompt and " +
        "instrument), production's second layer is a real boundary and not decoration.";
    } else {
      state.perAgentSpecBinds = false;
      state.verdict = "FAIL";
      state.notes =
        `MEASURED: AgentDefinition.disallowedTools:["mcp__*"] DOES NOT bind on its own in SDK ` +
        `0.3.220. The child still shows an MCP surface: census mcp__ names=${state.childMcpCount}, ` +
        `stated MCP_TOTAL=${arm.child.census.statedMcpTotal ?? "n/a"}, ` +
        `mcpAttemptObserved=${arm.child.mcpAttemptObserved}, evidence=` +
        `${safeStringify(arm.child.mcpEvidence)}. Probe G's PASS therefore rests ENTIRELY on the ` +
        "session-level lock, and the per-agent spec that claude-builder.ts calls defence in depth " +
        "is decoration. This is a finding, not an apparatus failure: the control held.";
    }

    if (arm.session.timedOut) {
      state.caveats.push(
        `The session hit the ${HARD_TIMEOUT_MS / 1000}s ceiling. The child writes before the parent, ` +
          "so the census survives; the parent's MCP control file may not, and the control gate reads " +
          "the engine-side init channel as well for exactly that reason.",
      );
    }
    state.caveats.push(
      "n=1. One live session, one model, one target agent (trigger-dev-expert, chosen because it " +
        "carries no `tools:` frontmatter allowlist).",
    );

    return state.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    state.verdict = "ERROR";
    state.notes = `probe crashed: ${truncate(error?.stack ?? error?.message ?? error, 600)}`;
    return 1;
  } finally {
    state.sessionsSpent = sessionsSpent;
    const resultPath = writeResult(state);
    const rawPath = writeRaw({ fixtures: fixtures.map((f) => f.root) });
    console.log(JSON.stringify(state, null, 2));
    console.log(`\nwrote ${resultPath}\nwrote ${rawPath}  (live sessions spent: ${sessionsSpent}/${MAX_LIVE_SESSIONS})`);
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
