/**
 * adversary.ts — `/debugfix --web --max`, ported to something the model can run.
 *
 * WHY A PORT AND NOT A CALL. `/debugfix` is a slash command declared with
 * `disable-model-invocation: true`, so this program cannot invoke it. What is
 * reproduced here is its PROCEDURE: attack the running artefact through its UI
 * the way a careless or hostile user would, collect evidence-backed findings,
 * and feed them back as fix work.
 *
 * THREE PROPERTIES, EACH ENFORCED RATHER THAN DESCRIBED:
 *
 *   IT NEEDS A RUNNING URL. A static read of the source is not this pass. No
 *   `previewUrl` means no adversary — not a degraded adversary.
 *
 *   IT IS READ-ONLY. `human-factors-adversary` declares `disallowedTools`
 *   covering Write/Edit/MultiEdit/NotebookEdit, the Agent tool (which could
 *   spawn something that writes) and every credential-bearing MCP server. That
 *   list is mirrored in {@link ADVERSARY_DISALLOWED_TOOLS} and a test asserts
 *   the mirror against the agent file on disk, because a copy drifts.
 *
 *   ITS FINDINGS ARE EVIDENCE, NOT A VERDICT. {@link withAdversaryFindings}
 *   appends to `failures` and does not touch `heldOutUnmet`. `heldOutPass` is
 *   computed by the sealed scorer from the frozen suite and nothing here may
 *   move it — an adversary that could change the verdict would be a second,
 *   unsealed grader.
 *
 * THE SAFETY GATE FAILS CLOSED (/debugfix §0.5). The default environment is
 * PROD-OR-UNKNOWN, under which nothing that commits state may be clicked. The
 * dashboard's preview is a loopback static server with no backend, so this is
 * normally moot — which is exactly why it is asserted rather than assumed. The
 * unlock is an explicit argument no current caller passes.
 *
 * WIRED, AS OF THIS COMMIT — and the paragraph this replaces said the opposite,
 * so the change is spelled out rather than left to be inferred.
 *
 *   THE SHORTLIST PERMITS IT. {@link ADVERSARY_AGENT} is in
 *   `DELIVERY_LANES.review` (agent-shortlist.ts) and `shortlistFor` returns it
 *   for `web-ui` and `fullstack` and for no other surface. A delegated Agent call
 *   to this name is therefore PERMITTED by the driver's PreToolUse hook rather
 *   than denied — and a denied agent produces nothing distinguishable from an
 *   agent with nothing to do, which is why that gap mattered. The test in
 *   adversary.test.ts is a JOIN: the shortlist permits this agent on exactly the
 *   surfaces {@link shouldRunAdversary} would run it on.
 *
 *   AND SOMETHING NOW CALLS IT. {@link runAdversaryLane} is the lane;
 *   `orchestrator.ts`'s `#adversaryPhase` is its one production call site, after
 *   `#maybePreview` (which is where a `previewUrl` first exists) and before the
 *   run goes terminal. `shouldRunAdversary`, {@link adversaryCall},
 *   {@link adversaryRefusal}, {@link parseAdversaryFindings},
 *   {@link adversaryRecord} and `withAdversaryFindings` are all on that path.
 *   Being on the shortlist made the pass POSSIBLE; this makes it happen.
 *
 * WHICH ROUTE, AND WHY — DELEGATED, NOT TOP-LEVEL. There are two ways to run this
 * agent and they carry the denylist differently (builders/types.ts:155-177 spells
 * out both). The lane takes the DELEGATED one: a `builder.build()` session with
 * `allowedAgents: [ADVERSARY_AGENT]`, whose prompt makes exactly one Agent call.
 * The child's denylist then comes from the `disallowedTools:` frontmatter of
 * ~/.claude/agents/human-factors-adversary.md — the channel probe I measured DOES
 * bind for a name that exists on disk. The TOP-LEVEL route would have had to rest
 * on `BuildRequest.disallowedTools`, of which its own docblock says "NO DRIVER
 * READS IT YET… whether it binds is UNMEASURED": a carrier with no reader sold as
 * a safety mechanism. The lane therefore does NOT set that field, and it would be
 * actively wrong to: {@link ADVERSARY_DISALLOWED_TOOLS} contains `Agent`, which
 * the delegated route needs at session level, so a driver that started reading
 * the field would turn this lane into one that spends turns and reports nothing.
 *
 * WHAT ACTUALLY STOPS IT TOUCHING THE ARTEFACT, and it is not this module's
 * denylist. The session runs with `cwd` set to a SCRATCH directory that is
 * neither the artefact nor a relative of it, so `buildOptions`' two already-tested
 * layers — the CLI sandbox's `filesystem.allowWrite` and `canUseTool`'s
 * workspace-write guard — deny every write outside that scratch dir, for the
 * session AND for the child. {@link adversaryRefusal} asserts the isolation at
 * the call site and refuses to spawn without it. It also serves /debugfix §5's
 * "run the adversary in its own context (must NOT read the implementation
 * first)": a blind pass cannot start by reading the source it is attacking.
 *
 * FOUR THINGS THIS LANE DOES NOT HAVE, STATED HERE SO NOTHING CLAIMS THEM:
 *
 *   NO HOOK ENFORCEMENT. /debugfix §0.1/§0.3 arm a `.debugfix-active` sentinel
 *   and check `~/.claude/hooks/{guard,verify}.sh`. This lane arms nothing and
 *   checks nothing of the sort: it is IN-WORKFLOW VERIFICATION ONLY, which is the
 *   wording §0.3 requires when the hooks are not armed.
 *
 *   NO PER-AGENT TURN BOUND. claude-builder.ts:886-891, measured: `maxTurns`
 *   "binds NOTHING… `AgentInput` has no turn field, so a bound cannot ride on the
 *   call either." What is in force is the session's own `maxTurns`
 *   (`DEFAULT_MAX_TURNS`) plus {@link ADVERSARY_WALL_CLOCK_MS}, which this lane
 *   enforces itself with a timer and an abort — the one bound it can prove.
 *
 *   NO FINDINGS FIELD ON THE WIRE. `BuildOutcome` is sessionId/tokens/rateLimit/
 *   completed/failure and carries no findings, and the adversary itself has no
 *   Write tool, so it cannot leave a file. The harvest channel is therefore the
 *   SESSION writing {@link ADVERSARY_FINDINGS_FILE} into its scratch dir, parsed
 *   by {@link parseAdversaryFindings}. Whether a live session complies is
 *   UNTESTED — no test here spends quota — so a run whose file is absent records
 *   zero findings and says which of the two happened.
 *
 *   NO BROWSER. No agent in the registry carries browser tools and the scratch cwd
 *   has no workspace-installed Playwright, so /debugfix §5's "No MCP: instruct
 *   Static mode (repros returned as text)" is the arm this lane is on.
 */

import type { Surface } from "./agent-shortlist.js";
import type { AgentVisibleReport, FailureClass, FixableFailure } from "./gate-report.js";

export const ADVERSARY_AGENT = "human-factors-adversary";

export type AdversarySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** What the caller asserts about the target. Default is the forbidding one. */
export type AdversaryEnvironment = "TEST" | "PROD_OR_UNKNOWN";

export interface AdversaryFinding {
  readonly severity: AdversarySeverity;
  readonly klass: FailureClass;
  readonly summary: string;
  readonly detail?: string;
}

export interface AdversaryOptions {
  readonly agent: string;
  readonly previewUrl: string;
  readonly environment: AdversaryEnvironment;
  readonly disallowedTools: readonly string[];
  readonly prompt: string;
}

/**
 * Mirror of the `disallowedTools:` frontmatter in
 * `~/.claude/agents/human-factors-adversary.md`, verified against that file by
 * `adversary.test.ts`. Write tools first, then every MCP server that carries a
 * credential — the agent's own note is that clicking "Pay" makes the APP call a
 * real backend, which a tool denylist cannot stop.
 */
export const ADVERSARY_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "mcp__stripe",
  "mcp__github",
  "mcp__supabase",
  "mcp__trigger",
  "mcp__skyvern",
]);

/** Surfaces that have a browsable UI at all. */
const WEB_SURFACES: ReadonlySet<Surface> = new Set<Surface>(["web-ui", "fullstack"]);

/** Loopback only. Anything else is somebody's server. */
function isLoopback(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
}

export function shouldRunAdversary(input: { readonly surface: Surface; readonly previewUrl: string | null }): boolean {
  if (!WEB_SURFACES.has(input.surface)) return false;
  if (input.previewUrl === null) return false;
  return isLoopback(input.previewUrl);
}

const PROD_RULES = [
  "Environment: PROD-OR-UNKNOWN. Commit NOTHING.",
  "- Allowed: viewport/zoom stress, read-only navigation, extreme input typed into fields you do NOT submit.",
  "- Forbidden: any click that writes a row; any form submission; signing in; anything that creates, " +
    "approves, rejects, books, cancels or deletes.",
  "- If you cannot tell whether an action commits state, treat it as committing and skip it.",
].join("\n");

const TEST_RULES = [
  "Environment: environment=TEST — a proven test backend with test keys. Committing attacks are unlocked.",
  "- Two-account attacks still require disposable credentials handed to you explicitly. Never sign in an " +
    "account you were not given.",
].join("\n");

/**
 * What the adversary is told, and what it is denied.
 *
 * The prompt states the environment because the agent's own safety section keys
 * off it and defaults to the forbidding branch when the caller says nothing —
 * so saying nothing here would be relying on the agent to guess right.
 */
export function adversaryOptions(input: {
  readonly previewUrl: string;
  readonly environment?: AdversaryEnvironment;
}): AdversaryOptions {
  const environment = input.environment ?? "PROD_OR_UNKNOWN";
  const prompt = [
    `Attack the running web app at ${input.previewUrl} the way a careless or hostile real user would.`,
    "",
    environment === "TEST" ? TEST_RULES : PROD_RULES,
    "",
    "Report evidence-backed findings only. Every finding needs a severity (CRITICAL / HIGH / MEDIUM / LOW), " +
      "a repro as text, and evidence matched to its class. 'Could not reproduce' is valid only with an " +
      "attempt count. Never invent file:line, error text or network calls.",
    "",
    "You change nothing. You have no Write or Edit tool; hand every repro back as text.",
  ].join("\n");

  return {
    agent: ADVERSARY_AGENT,
    previewUrl: input.previewUrl,
    environment,
    disallowedTools: ADVERSARY_DISALLOWED_TOOLS,
    prompt,
  };
}

/**
 * Fold adversary findings into a report as ordinary fix work.
 *
 * `heldOutUnmet` IS COPIED UNCHANGED. That is the whole point: these findings
 * are evidence produced by an unsealed pass against a live preview, and letting
 * them move the criterion counts would make `heldOutPass` partly a function of
 * something the frozen suite never asserted.
 *
 * ITS ONE PRODUCTION CALLER IS THE BACKLOG, NOT THE FIX LOOP, and that placement
 * is the "QUALITY tier, never blocks" decision in mechanism rather than in prose.
 * `runGateFixLoop` reads `report.failures` through `isGreen`, so a report folded
 * on the loop's side would turn a judgement pass into a gate: a MEDIUM
 * human-factors finding would make a green run non-green and spend the retry
 * budget on it. `#adversaryPhase` runs after the loop has stopped and the run has
 * been scored, and it folds only into the record `writeBacklog` renders.
 */
export function withAdversaryFindings(
  report: AgentVisibleReport,
  findings: readonly AdversaryFinding[],
): AgentVisibleReport {
  if (findings.length === 0) return report;
  const extra: FixableFailure[] = findings.map((finding, index) => ({
    id: `adversary:${String(index + 1)}`,
    klass: finding.klass,
    summary: `[${finding.severity}] ${finding.summary}`,
    detail: finding.detail ?? "",
    command: null,
    exitCode: null,
  }));
  return { ...report, failures: [...report.failures, ...extra] };
}

/* ---- the lane ---------------------------------------------------------- */

/**
 * The wall-clock bound, and the ONLY bound this lane can prove.
 *
 * Twelve minutes: the pass is one delegated agent poking a static loopback app
 * through Bash, and a session that has not produced its report in that long is
 * not about to. It matters more than the number: this is the bound that runs
 * AFTER the gate, on a run the owner has walked away from, against an agent whose
 * per-turn cost is a subscription's shared rate-limit window.
 */
export const ADVERSARY_WALL_CLOCK_MS = 12 * 60_000;

/**
 * The subset of {@link ADVERSARY_DISALLOWED_TOOLS} that is about the ARTEFACT.
 *
 * Kept separate because the two halves fail differently. Losing `mcp__stripe`
 * from the denylist is a money risk; losing `Write` means the pass can edit the
 * thing it is judging, and a judge that can edit the exhibit is not a judge.
 * {@link adversaryRefusal} refuses to spawn when any of these is missing from
 * either the call or the agent on disk.
 */
export const ADVERSARY_WRITE_TOOLS: readonly string[] = Object.freeze([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Where the session is told to leave its report, inside its scratch dir. */
export const ADVERSARY_FINDINGS_FILE = "adversary-findings.json";

/**
 * How many findings are carried out of one pass.
 *
 * Every one of these reaches `backlog.md` and the run's canvas summary. A pass
 * that returns 300 has stopped triaging, and an unbounded list is a run record
 * nobody reads.
 */
export const ADVERSARY_MAX_FINDINGS = 25;

/**
 * Why the lane stopped. Every member is reachable and each says something
 * different to the owner.
 *
 *   `ran`                     the session returned; findings may still be empty.
 *   `not-applicable`          no browsable surface, or no loopback preview URL.
 *   `agent-missing`           no agent file on disk (/debugfix §0.4: STOP, never
 *                             fall back to a generic agent).
 *   `agent-denylist-drift`    the file exists and no longer denies what this
 *                             module says it denies.
 *   `denylist-incomplete`     this module's own constant lost a write tool.
 *   `workspace-not-isolated`  the scratch cwd is the artefact, or a relative of
 *                             it, so the sandbox would permit writing the exhibit.
 *   `timeout`                 the wall clock tripped; the session was aborted.
 *   `failed`                  the session reported a failure.
 *   `cancelled`               the run was cancelled.
 */
export type AdversaryStop =
  | "ran"
  | "not-applicable"
  | "agent-missing"
  | "agent-denylist-drift"
  | "denylist-incomplete"
  | "workspace-not-isolated"
  | "timeout"
  | "failed"
  | "cancelled";

/** Everything the spawn boundary receives. Asserted on, not described. */
export interface AdversaryCall {
  readonly agent: string;
  readonly previewUrl: string;
  readonly environment: AdversaryEnvironment;
  /** {@link ADVERSARY_DISALLOWED_TOOLS}. Carried so a test can read it OFF the call. */
  readonly disallowedTools: readonly string[];
  /** What the ADVERSARY is told — pasted verbatim into the one Agent call. */
  readonly agentPrompt: string;
  /** What the SESSION is told: delegate once, harvest, write nothing else. */
  readonly sessionPrompt: string;
  /** Exactly `[ADVERSARY_AGENT]`. The driver's PreToolUse hook enforces it. */
  readonly allowedAgents: readonly string[];
  /** The session's cwd. NOT the artefact — see the module header. */
  readonly scratchDir: string;
  /** Where the session is told to write its report. */
  readonly findingsPath: string;
  readonly wallClockMs: number;
}

export interface AdversarySpawnResult {
  readonly findings: readonly AdversaryFinding[];
  /** Non-null when the session did not complete cleanly. */
  readonly failure: string | null;
  /**
   * Did the session actually leave its report file?
   *
   * IT IS NOT `findings.length > 0`. A session that wrote `[]` reported nothing;
   * a session that wrote no file reported nothing THAT THIS PROGRAM CAN SEE, and
   * the two get different sentences in the record. Only the spawn boundary knows
   * which happened, so it says so here rather than leaving the record to guess.
   */
  readonly reportWritten?: boolean;
}

export interface AdversaryLaneResult {
  /** The session was actually spawned. False for every refusal. */
  readonly ran: boolean;
  readonly stop: AdversaryStop;
  readonly detail: string;
  readonly findings: readonly AdversaryFinding[];
  /** See {@link AdversarySpawnResult.reportWritten}. False for every refusal. */
  readonly reportWritten: boolean;
  /** The call as it was made, or null when nothing was spawned. */
  readonly call: AdversaryCall | null;
}

/** Join without importing `node:path`, so this module stays free of the fs. */
function joinPath(dir: string, file: string): string {
  return dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`;
}

/**
 * The call, in one place, so the orchestrator cannot assemble a different one.
 *
 * The SESSION prompt is not the ADVERSARY prompt, and conflating them is the
 * mistake this shape prevents. The session is the ordinary builder model with an
 * Agent tool; the adversary is the child. /debugfix §5 requires the child's
 * prompt to come from a FIXED template whose only variables are the URL, the
 * description and the environment — that template is {@link adversaryOptions},
 * and it is embedded here verbatim rather than paraphrased.
 */
export function adversaryCall(input: {
  readonly previewUrl: string;
  readonly scratchDir: string;
  readonly environment?: AdversaryEnvironment;
  readonly wallClockMs?: number;
}): AdversaryCall {
  const options = adversaryOptions(
    // SPREAD RATHER THAN PASSED AS `undefined`. `exactOptionalPropertyTypes` is on,
    // and an explicit `environment: undefined` is not the same value as an absent
    // key — the absent one is what takes `adversaryOptions`' PROD-OR-UNKNOWN
    // default, which is the branch that forbids committing anything.
    input.environment === undefined
      ? { previewUrl: input.previewUrl }
      : { previewUrl: input.previewUrl, environment: input.environment },
  );
  const findingsPath = joinPath(input.scratchDir, ADVERSARY_FINDINGS_FILE);
  const sessionPrompt = [
    "You are running ONE read-only adversarial pass over an already-built artefact. You are not " +
      "fixing anything and you are not judging the code.",
    "",
    `Make exactly one Agent call to \`${options.agent}\`, passing the block between the markers below ` +
      "as its `prompt`, verbatim and unedited. Do not summarise it, do not add to it, and do not " +
      "delegate to any other agent — no other agent is permitted on this session.",
    "",
    "----- BEGIN ADVERSARY PROMPT -----",
    options.prompt,
    "----- END ADVERSARY PROMPT -----",
    "",
    `When it returns, write its findings to ${findingsPath} as JSON and then stop. Shape:`,
    '  [{"severity":"CRITICAL|HIGH|MEDIUM|LOW","klass":"logic|visual|route|boot|structure|build|' +
      'install|test-infra","summary":"one line","detail":"repro + evidence"}]',
    "Write `[]` if it reported nothing. That file is the only output of this pass; a missing file is " +
      "recorded as 'the session left no report', which is not the same statement as 'no findings'.",
    "",
    "DO NOT READ OR MODIFY THE ARTEFACT. This session's working directory is a scratch directory on " +
      "purpose: the pass is blind by design (/debugfix §5) and every write outside this directory is " +
      "denied by the sandbox. Report; change nothing.",
  ].join("\n");

  return {
    agent: options.agent,
    previewUrl: options.previewUrl,
    environment: options.environment,
    disallowedTools: options.disallowedTools,
    agentPrompt: options.prompt,
    sessionPrompt,
    allowedAgents: [options.agent],
    scratchDir: input.scratchDir,
    findingsPath,
    wallClockMs: input.wallClockMs ?? ADVERSARY_WALL_CLOCK_MS,
  };
}

/**
 * Is `inner` the same directory as `outer`, or inside it, or the other way round?
 *
 * Both are canonicalised by the CALLER's function — the orchestrator passes
 * `canonicaliseForDecision`, the same one `buildOptions` hands the write guard and
 * the sandbox, because two layers that disagree about what a path is are not two
 * layers. A lexical default would call `<workspace>/link/scratch` isolated while
 * the sandbox resolved it back inside the artefact.
 */
function pathsOverlap(a: string, b: string): boolean {
  const left = a.replace(/\/+$/u, "");
  const right = b.replace(/\/+$/u, "");
  if (left.length === 0 || right.length === 0) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Every reason NOT to spawn, checked BEFORE anything is spawned. Null means go.
 *
 * PURE, AND THAT IS THE POINT. This is the whole of requirement "it must not be
 * able to modify the artefact", expressed as a function a test can drive with a
 * weakened input and watch refuse — rather than as a sentence about a file on
 * disk that nothing re-reads.
 *
 * THE DISK LIST IS THE MECHANISM AND THIS IS ITS PREFLIGHT. `disallowedTools:`
 * frontmatter is what actually binds on the delegated route, so the lane reads it
 * at the call site and refuses when it no longer covers what this module claims.
 * /debugfix §0.4 takes the same posture for a missing agent file: STOP and say so,
 * never silently fall back to a generic agent.
 */
export function adversaryRefusal(input: {
  readonly call: AdversaryCall;
  readonly artefactDir: string;
  /** The agent file's own denylist, or null when there is no such file. */
  readonly agentDenylist: readonly string[] | null;
  readonly canonicalise: (path: string) => string;
}): { readonly stop: AdversaryStop; readonly detail: string } | null {
  const missingHere = ADVERSARY_WRITE_TOOLS.filter((tool) => !input.call.disallowedTools.includes(tool));
  if (missingHere.length > 0) {
    return {
      stop: "denylist-incomplete",
      detail:
        `this build's own adversary denylist no longer denies ${missingHere.join(", ")} — refusing to ` +
        "spawn a pass that could edit the artefact it is judging",
    };
  }

  if (input.agentDenylist === null) {
    return {
      stop: "agent-missing",
      detail:
        `no ~/.claude/agents/${input.call.agent}.md with a disallowedTools list was readable, so the ` +
        "denylist that binds a delegated agent is absent (/debugfix §0.4: stop rather than fall back " +
        "to a generic agent)",
    };
  }

  const onDisk = new Set(input.agentDenylist);
  const drifted = ADVERSARY_DISALLOWED_TOOLS.filter((tool) => !onDisk.has(tool));
  if (drifted.length > 0) {
    return {
      stop: "agent-denylist-drift",
      detail:
        `${input.call.agent} on disk no longer denies ${drifted.join(", ")}; its frontmatter is the ` +
        "list that actually binds a delegated agent, so the pass is refused rather than run unbound",
    };
  }

  const scratch = input.canonicalise(input.call.scratchDir);
  const artefact = input.canonicalise(input.artefactDir);
  if (pathsOverlap(scratch, artefact)) {
    return {
      stop: "workspace-not-isolated",
      detail:
        `the scratch directory (${scratch}) overlaps the artefact (${artefact}), so the sandbox's ` +
        "allowWrite would cover the artefact and the pass could edit what it is judging",
    };
  }

  return null;
}

/**
 * The session's report file, parsed defensively.
 *
 * IT IS MODEL-WRITTEN JSON, so every field is checked and anything unusable is
 * DROPPED rather than coerced: a finding with no summary carries no information,
 * and a severity this program does not recognise would sort wrong in the backlog.
 * `klass` defaults to `logic` — the class `fix-triage.ts` routes to `debugger` —
 * because a human-factors finding usually has no single file:line (/debugfix §5
 * says so explicitly) and guessing `visual` would route UI-shaped prose to a
 * design agent on no evidence.
 */
export function parseAdversaryFindings(text: string): readonly AdversaryFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const severities = new Set<AdversarySeverity>(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
  const classes = new Set<FailureClass>([
    "install",
    "build",
    "boot",
    "route",
    "visual",
    "test-infra",
    "logic",
    "structure",
  ]);
  const out: AdversaryFinding[] = [];
  for (const entry of parsed) {
    if (out.length >= ADVERSARY_MAX_FINDINGS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const severity = record["severity"];
    const summary = record["summary"];
    if (typeof severity !== "string" || !severities.has(severity as AdversarySeverity)) continue;
    if (typeof summary !== "string" || summary.trim().length === 0) continue;
    const klass = record["klass"];
    const detail = record["detail"];
    out.push({
      severity: severity as AdversarySeverity,
      klass: typeof klass === "string" && classes.has(klass as FailureClass) ? (klass as FailureClass) : "logic",
      summary: summary.trim().slice(0, 300),
      detail: typeof detail === "string" ? detail.slice(0, 2000) : "",
    });
  }
  return out;
}

/**
 * The `disallowedTools:` list out of an agent file's frontmatter, or null.
 *
 * PURE, TAKING TEXT AND NOT A PATH, so the disk read stays at the one impure call
 * site and this — the part that can be wrong — is executed by tests against both
 * a real file and a deliberately weakened one. Null means "this file states no
 * denylist at all", which {@link adversaryRefusal} treats exactly as harshly as a
 * missing file: an agent that denies nothing is not a read-only agent.
 */
export function parseAgentDenylist(fileText: string): readonly string[] | null {
  const frontmatter = fileText.split("---")[1];
  if (frontmatter === undefined) return null;
  const line = frontmatter.split("\n").find((l) => l.startsWith("disallowedTools:"));
  if (line === undefined) return null;
  const tools = line
    .slice("disallowedTools:".length)
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  return tools.length === 0 ? null : tools;
}

export interface AdversaryLaneDeps {
  readonly surface: Surface;
  readonly previewUrl: string | null;
  readonly scratchDir: string;
  /** The artefact the pass must not be able to touch. */
  readonly artefactDir: string;
  readonly environment?: AdversaryEnvironment;
  readonly wallClockMs?: number;
  /** The agent file's own `disallowedTools:`, or null. Injected: it reads disk. */
  readonly agentDenylist: () => readonly string[] | null;
  readonly canonicalise: (path: string) => string;
  /**
   * Spawn the session. INJECTED because the real one spends the owner's
   * subscription against a live app: a test that drove it would be a test nobody
   * runs twice, and the live arm is stated untested rather than pretended.
   */
  readonly spawn: (call: AdversaryCall, signal: AbortSignal) => Promise<AdversarySpawnResult>;
  readonly log?: (level: "info" | "warn", text: string) => void;
  readonly signal?: AbortSignal;
}

/**
 * Run the pass — or refuse, and say which.
 *
 * WHAT IS BOUNDED AND BY WHAT. The wall clock is enforced HERE, with a timer and
 * a child abort, because it is the only bound this program can enforce: the
 * per-agent turn bound does not exist (claude-builder.ts:886-891) and the session
 * bound is a constant in the driver. A pass that hangs would otherwise sit past
 * the run's own end holding a subscription seat, on a run nobody is watching.
 *
 * NOTHING IS SPAWNED ON A REFUSAL, and that is the property the negative control
 * watches: `spawn` is not called at all when {@link shouldRunAdversary} says no
 * or {@link adversaryRefusal} objects. A lane that spawned and then discarded the
 * result would look identical in every log line and cost the same quota.
 */
export async function runAdversaryLane(deps: AdversaryLaneDeps): Promise<AdversaryLaneResult> {
  const log = deps.log ?? ((): void => undefined);
  /**
   * READ AS A CALL, NOT AS A PROPERTY — the same TS2367 `gate-fix-loop.ts`
   * documents: two inlined `deps.signal?.aborted === true` checks compile to a
   * second comparison TypeScript narrows to `false | undefined`, because it treats
   * the field as immutable. It is precisely the one thing here that changes
   * underneath us.
   */
  const aborted = (): boolean => deps.signal?.aborted === true;
  const refuse = (stop: AdversaryStop, detail: string, call: AdversaryCall | null): AdversaryLaneResult => {
    log(stop === "not-applicable" ? "info" : "warn", `the human-factors adversary pass did not run: ${detail}`);
    return { ran: false, stop, detail, findings: [], reportWritten: false, call };
  };

  if (!shouldRunAdversary({ surface: deps.surface, previewUrl: deps.previewUrl })) {
    return refuse(
      "not-applicable",
      deps.previewUrl === null
        ? `no loopback preview URL for a ${deps.surface} run, and an adversary with no URL to attack is ` +
            "a lane that spends turns and reports nothing"
        : `surface ${deps.surface} with preview URL ${deps.previewUrl} is not a browsable loopback target`,
      null,
    );
  }
  if (aborted()) return refuse("cancelled", "the run was cancelled", null);

  // NON-NULL BY `shouldRunAdversary`, which returns false for null. Asserted
  // rather than assumed because the two calls are separated by the refusal above.
  const previewUrl = deps.previewUrl ?? "";
  const call = adversaryCall({
    previewUrl,
    scratchDir: deps.scratchDir,
    ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    ...(deps.wallClockMs === undefined ? {} : { wallClockMs: deps.wallClockMs }),
  });

  const refusal = adversaryRefusal({
    call,
    artefactDir: deps.artefactDir,
    agentDenylist: deps.agentDenylist(),
    canonicalise: deps.canonicalise,
  });
  if (refusal !== null) return refuse(refusal.stop, refusal.detail, call);

  log(
    "info",
    `human-factors adversary (${call.agent}, ${call.environment}, non-gating): attacking ${call.previewUrl} ` +
      `with a ${String(Math.round(call.wallClockMs / 1000))}s wall clock`,
  );

  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort();
  };
  deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.wallClockMs);

  try {
    const result = await deps.spawn(call, controller.signal);
    if (timedOut) {
      return {
        ran: true,
        stop: "timeout",
        detail: `the pass was aborted at its ${String(Math.round(call.wallClockMs / 1000))}s wall clock`,
        findings: result.findings.slice(0, ADVERSARY_MAX_FINDINGS),
        reportWritten: result.reportWritten ?? false,
        call,
      };
    }
    if (aborted()) {
      return { ran: true, stop: "cancelled", detail: "the run was cancelled", findings: [], reportWritten: false, call };
    }
    return {
      ran: true,
      stop: result.failure === null ? "ran" : "failed",
      detail: result.failure ?? "",
      findings: result.findings.slice(0, ADVERSARY_MAX_FINDINGS),
      reportWritten: result.reportWritten ?? false,
      call,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ran: true,
      stop: timedOut ? "timeout" : "failed",
      detail: timedOut ? `the pass was aborted at its wall clock: ${detail}` : detail,
      findings: [],
      reportWritten: false,
      call,
    };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * The run's record of the pass — written whether it ran or not.
 *
 * A MISSING FILE CANNOT BE TOLD APART FROM A STEP THAT NEVER RAN, which is why a
 * refusal produces a record too. `notes` carries what this lane does NOT have, in
 * the file rather than only in a docblock, because the file is what a cron report
 * or a morning-after reader actually opens.
 */
export interface AdversaryRecord {
  readonly agent: string;
  readonly ran: boolean;
  readonly stop: AdversaryStop;
  readonly detail: string;
  readonly surface: Surface;
  readonly previewUrl: string | null;
  readonly environment: AdversaryEnvironment | null;
  readonly gating: false;
  readonly wallClockMs: number | null;
  readonly findings: readonly AdversaryFinding[];
  readonly notes: readonly string[];
}

export function adversaryRecord(input: {
  readonly result: AdversaryLaneResult;
  readonly surface: Surface;
  readonly previewUrl: string | null;
}): AdversaryRecord {
  const notes = [
    "QUALITY tier: these findings never change heldOutPass, the run's status or its failure reason. " +
      "They are folded into backlog.md and summarised on the canvas.",
    "hooks: NOT ARMED — in-workflow verification only (/debugfix §0.3). No .debugfix-active sentinel " +
      "and no guard.sh/verify.sh enforcement is claimed by this lane.",
    "turn bound: a per-agent turn bound does not exist on this route (claude-builder.ts:886-891 — " +
      "AgentInput has no turn field). What bounds this pass is the session's own maxTurns plus the " +
      "wall clock recorded here.",
    "browser: no agent in the registry carries browser tools and the scratch cwd has no " +
      "workspace-installed Playwright, so this is /debugfix §5's Static mode — repros come back as text.",
  ];
  if (input.result.ran) {
    notes.push(
      input.result.reportWritten
        ? "findings channel: parsed from the session's report file in its scratch directory."
        : "findings channel: the session left no report file, so this run recorded zero findings. That " +
            "is not the same statement as 'the pass found nothing' — BuildOutcome carries no findings " +
            "field, and whether a live session writes the file is UNTESTED here.",
    );
  }
  return {
    agent: ADVERSARY_AGENT,
    ran: input.result.ran,
    stop: input.result.stop,
    detail: input.result.detail,
    surface: input.surface,
    previewUrl: input.previewUrl,
    environment: input.result.call?.environment ?? null,
    gating: false,
    wallClockMs: input.result.call?.wallClockMs ?? null,
    findings: input.result.findings,
    notes,
  };
}

/** One line per finding, severity-ordered, for the canvas node's summary. */
export function summariseAdversary(result: AdversaryLaneResult): string {
  if (!result.ran) return `did not run: ${result.stop}`;
  if (result.findings.length === 0) {
    return result.stop === "ran" ? "no findings reported" : `${result.stop}: ${result.detail}`.slice(0, 300);
  }
  const counts = new Map<AdversarySeverity, number>();
  for (const finding of result.findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const order: readonly AdversarySeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const parts = order
    .filter((severity) => counts.has(severity))
    .map((severity) => `${String(counts.get(severity))} ${severity}`);
  return `${String(result.findings.length)} finding(s) — ${parts.join(", ")} (non-gating)`;
}
