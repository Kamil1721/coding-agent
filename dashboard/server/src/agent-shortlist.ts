/**
 * agent-shortlist.ts — which of the owner's agents a build may delegate to.
 *
 * WHY THIS MODULE EXISTS. `settingSources: ["user"]` (Phase 1 Task 1) makes 144
 * agents and 162 skills visible to the orchestrator. Visibility is not permission.
 * The `PreToolUse` hook is the boundary — it allowlists `subagent_type` and
 * denies everything else — and this module compiles the list that boundary is
 * fed (Task 3). It was the `canUseTool` Agent branch through Phase 0, and probe A
 * measured that callback is asked about NO TOOL AT ALL when the model delegates;
 * the branch was deleted in Phase 1.1 Task 2 rather than left reading like a
 * guard. See `builders/delegation-hook.ts`.
 *
 * Two separate jobs, deliberately not merged:
 *   settingSources  decides what the orchestrator can SEE.
 *   allowedAgents   decides what it may USE.
 * Never widen one assuming the other compensates.
 *
 * EVERY NAME BELOW IS THE FRONTMATTER `name:` OF A FILE IN ~/.claude/agents/,
 * verified against disk 2026-07-28 and re-verified on every test run by
 * "every shortlisted agent exists on disk". `subagent_type` matches the
 * frontmatter name, never the filename — `trigger-dev-expert` is declared in
 * `trigger-dev-task-writer.md`, and keying it by filename would compile, read
 * fine, and be denied at runtime with nothing reporting why.
 *
 * A wrong name here does not fail loudly. The orchestrator asks for an agent that
 * does not exist, the guard denies it, and the lane produces nothing — which looks
 * exactly like a lane that had nothing to do.
 */

import type { AnthropicEffort } from "bakeoff/dist/contracts.js";

/** Pipeline stage. Lanes are server-side labels, and per spec 6.1 their ordering is advisory. */
export type Lane = "spec" | "design" | "build" | "review" | "gate";

/** What kind of thing the ticket asks for. Classified once, per spec 6.5 (Task 5). */
export type Surface = "web-ui" | "fullstack" | "api" | "cli" | "library" | "background-jobs";

/**
 * Lane membership. 26 agents shortlisted from 144.
 *
 * Dropped wholesale (spec 6.4): PowerShell/Windows/M365, vertical markets,
 * mobile/native, non-JS backends, infra/SRE, ML/data, business/GTM, and all seven
 * meta-orchestrators — the SDK's own Agent tool IS the delegation mechanism, so
 * those duplicate the orchestrator being authored here.
 *
 * `ui-designer` appears TWICE, in `design` and in `review`, and that is the point:
 * it holds design tokens in DESIGN and grades the built page against the mockups
 * in REVIEW, while `taste-frontend-expert` authors those mockups. An agent grading
 * its own art direction is not a gate (spec 7.4). `shortlistFor` de-duplicates.
 *
 * DIVERGENCE FROM THE PLAN, RECORDED: the plan's Task 2 Step 3 code literal lists
 * `review` without `ui-designer`, while the same task's prose ("three facts to
 * encode, each verified"), spec 6.4's REVIEW row and spec 7.4 all place it there.
 * The literal is an incomplete transcription, not a decision — Task 4 builds the
 * orchestrator prompt by grouping THIS record by lane, so omitting `ui-designer`
 * from `review` would mean the prompt never names a visual gate.
 */
export const DELIVERY_LANES = {
  spec: ["context-manager", "product-manager", "qa-expert", "api-designer", "architect-reviewer"],
  design: ["taste-frontend-expert", "ui-designer"],
  build: [
    "nextjs-developer",
    "react-specialist",
    "typescript-pro",
    "frontend-developer",
    "backend-developer",
    "fullstack-developer",
    "python-pro",
    "cli-developer",
    "postgres-pro",
    "trigger-dev-expert",
    "docker-expert",
  ],
  review: [
    "code-reviewer",
    "accessibility-tester",
    "security-auditor",
    "ai-writing-auditor",
    "ui-designer",
  ],
  gate: ["debugger", "test-automator", "refactoring-specialist", "dependency-manager"],
} as const satisfies Record<Lane, readonly string[]>;

/**
 * Build-lane agents that only make sense when there is a rendered surface.
 * Typed `readonly string[]` rather than `as const` on purpose: `.includes(x: string)`
 * does not compile against a literal-union tuple.
 */
const FRONTEND_BUILD: readonly string[] = ["nextjs-developer", "react-specialist", "frontend-developer"];

/** Build-lane agents that only make sense when the deliverable is a terminal program. */
const TERMINAL_BUILD: readonly string[] = ["cli-developer"];

/**
 * DESIGN is the only conditional lane (spec 6.5). Phase 1 gates it on surface
 * alone; the `visualIntent()` and `geminiKeyAvailable()` terms in spec 6.5 belong
 * to Phase 2b, when there is a DESIGN lane for them to degrade.
 */
function designLaneRuns(surface: Surface): boolean {
  return surface === "web-ui" || surface === "fullstack";
}

/**
 * The build lane, filtered by surface. `fullstack` keeps everything and is
 * therefore the widest set — Task 3 relies on that while the surface classifier
 * is still outstanding.
 */
function buildLaneFor(surface: Surface): readonly string[] {
  const all: readonly string[] = DELIVERY_LANES.build;
  switch (surface) {
    case "fullstack":
      return all;
    case "web-ui":
      // A web UI is not a terminal program; keep the frontend specialists.
      return all.filter((a) => !TERMINAL_BUILD.includes(a));
    case "api":
    case "cli":
    case "library":
    case "background-jobs":
      // No rendered surface, so the three frontend specialists are dead weight in
      // the search space. `cli-developer` stays: a library or a job runner can
      // still ship a command-line entry point.
      return all.filter((a) => !FRONTEND_BUILD.includes(a));
    default:
      return all;
  }
}

/**
 * The agents a build for `surface` may delegate to, in pipeline order.
 *
 * SPEC, BUILD, REVIEW and GATE always run; DESIGN is conditional. The result is
 * de-duplicated (`ui-designer` is in two lanes) with first-appearance order kept,
 * so the list reads in the order the lanes are meant to execute.
 *
 * Pure and synchronous — it is called to build a permission boundary, and a
 * boundary that can throw or await is a boundary with a failure mode.
 */
export function shortlistFor(surface: Surface): readonly string[] {
  const design: readonly string[] = designLaneRuns(surface) ? DELIVERY_LANES.design : [];
  const ordered: string[] = [
    ...DELIVERY_LANES.spec,
    ...design,
    ...buildLaneFor(surface),
    ...DELIVERY_LANES.review,
    ...DELIVERY_LANES.gate,
  ];
  return [...new Set(ordered)];
}

/**
 * The lane an agent belongs to, or null when it belongs to none.
 *
 * WHY THIS IS NEEDED AT RUNTIME AND NOT ONLY AT AUTHORING TIME. A
 * `task_notification` — the message that says a delegated agent has finished —
 * carries `task_id` and `status` and NOT `subagent_type`. Only `task_started`
 * carries the agent name, and even there it is OPTIONAL (verified in the SDK
 * typings, `SDKTaskStartedMessage`). So "which lane just closed?" is answered by
 * pairing the two messages and then looking the name up here.
 *
 * FIRST MEMBERSHIP WINS, AND THAT IS AN APPROXIMATION FOR EXACTLY ONE AGENT.
 * `ui-designer` is deliberately in DESIGN (tokens) and in REVIEW (the visual
 * gate), and nothing in a task message says which role it was invoked in. It
 * resolves to `design`. The context sample carries the AGENT name alongside the
 * lane, so the ambiguity is recoverable by a reader rather than lost.
 *
 * NULL RATHER THAN A GUESS for an unknown name. `allowedAgents` is a plain array
 * and a future caller can fill it from anywhere; a sample labelled with a
 * plausible-but-wrong lane is worse than one labelled with none, because it reads
 * as evidence.
 */
export function laneOf(agent: string): Lane | null {
  for (const [lane, members] of Object.entries(DELIVERY_LANES) as [Lane, readonly string[]][]) {
    if (members.includes(agent)) return lane;
  }
  return null;
}

/**
 * The report contract, as a CRITICAL SYSTEM REMINDER rather than prose in a
 * prompt body.
 *
 * §15.4 items 1-2 were authored and never applied: the contract sat in a plan
 * document while the subagents' own system prompts told them to narrate.
 * Whichever of the two the model followed, it was not this one. Delegation is
 * this system's context compression — a subagent that replays its 50 tool calls
 * into the parent's window is a subagent that made context WORSE. §15 measured
 * 110-190k tokens on a ticket where the contract holds against 260-500k+ on the
 * same ticket where it does not.
 *
 * IT NAMES WHAT NOT TO SEND, not merely "be brief". "Be concise" is advice; the
 * measured failure is a specific behaviour, and a rule that does not name the
 * behaviour it forbids is one the model can honour while still doing it.
 */
export const REPORT_CONTRACT_REMINDER =
  "Return ONLY your findings and what you changed — file paths, decisions, and what " +
  "is still open. Do NOT replay your tool calls, quote file contents you read, or " +
  "narrate your process. Your report enters a parent context that must survive the " +
  "whole build; everything you leave out is budget the next lane gets to spend.";

/**
 * One agent's system prompt, for the `AgentDefinition` this run supplies.
 *
 * MEASURED SINCE THIS WAS WRITTEN, AND IT IS NEITHER "REPLACES" NOR "MERGES" FOR
 * AN ON-DISK NAME: the DoD run had `system/init` list `code-reviewer` TWICE, and
 * `subagent_type: "code-reviewer"` resolved to the DISK definition — the disk
 * frontmatter's model, the disk `tools`, the disk body, and THIS PROMPT ABSENT.
 * The definition below did not replace anything and did not merge into anything;
 * it was not consulted.
 *
 * WHAT IS STILL UNMEASURED, IN BOTH DIRECTIONS: whether this `prompt` or
 * `criticalSystemReminder_EXPERIMENTAL` reaches ANY child. The reminder came back
 * null from a child that had NO disk file either, so "only on-disk agents ignore
 * it" is not established — nothing is. Probe I is measuring the no-disk-file case
 * now.
 *
 * IT STAYS SELF-SUFFICIENT ANYWAY — naming the role and the lane rather than
 * only "report tersely" — because the case where it DOES land is the case where a
 * child would otherwise not know what it is.
 *
 * WHY SUPPLY A DEFINITION AT ALL. `maxTurns`, `effort`, `background: false` and
 * `disallowedTools: ["mcp__*"]` exist ONLY on an `AgentDefinition`, and that type
 * REQUIRES `prompt`. This used to argue the last two were "boundaries that hold
 * whether or not `canUseTool` is consulted" — probe G2 measured them INERT for an
 * on-disk agent (620 tools, 589 `mcp__*`, identical to the unnarrowed control),
 * so that argument is withdrawn. What removes the MCP surface is the session-level
 * `managedSettings.allowedMcpServers: []`. The definition is still supplied for
 * the case probe I is measuring: a `subagent_type` with no file on disk.
 *
 * TOTAL FOR AN UNKNOWN NAME, like everything else in this module. An agent on no
 * lane must not receive a prompt reading "your undefined lane".
 */
export function reportContract(agent: string): string {
  const lane = laneOf(agent);
  const role =
    lane === null
      ? `You are the \`${agent}\` subagent, delegated one step of a larger build.`
      : `You are the \`${agent}\` subagent, running this build's ${lane.toUpperCase()} lane.`;
  return (
    `${role} Work only inside the run's workspace, from the ticket brief and the ` +
    "visible acceptance tests in it, and apply whatever expertise your own definition " +
    "gives you.\n\n" +
    `WHEN YOU FINISH, REPORT — do not narrate. ${REPORT_CONTRACT_REMINDER}`
  );
}

/**
 * How much room one delegated agent gets.
 *
 * `effort` is `AnthropicEffort | null` where NULL MEANS "the run's own effort
 * stands" — see {@link boundsFor} for why every entry is currently null.
 */
export interface AgentBounds {
  /** Agentic turns (API round-trips) this agent should be given. */
  readonly maxTurns: number;
  /** A rung to override the run's effort with, or null to inherit it. */
  readonly effort: AnthropicEffort | null;
}

/**
 * Turns per lane, and why each number is the size it is.
 *
 * `DEFAULT_MAX_TURNS = 400` (claude-builder.ts) is SESSION-level: it bounds the
 * whole build and nothing inside it. Spec 11 item 3 records the consequence — one
 * runaway lens spends the budget before GATE/FIX runs, and GATE/FIX is where what
 * REVIEW found actually gets closed.
 *
 *   spec    15  reads the ticket and the tree and writes a plan; no implementation.
 *   design  30  spec 7.2's closed loop is 5 images x up to 2 retries, each with a
 *               Read-and-critique afterwards. Spec 11 item 3 measures the lane at
 *               ~20-25 turns; 30 leaves room for the manifest and the direction.
 *   build   40  the agents that actually write the implementation, iterate against
 *               `visible-acceptance/`, and install dependencies.
 *   review  15  read-mostly lenses. Three of them (spec 6.4) have no Write or Edit
 *               tool at all and hand back prose.
 *   gate    30  NOT lenses — `debugger`, `test-automator` and
 *               `refactoring-specialist` change the tree to close what REVIEW
 *               found, so they need write-shaped room, if less than a lane that
 *               builds from nothing.
 *
 * DIVERGENCE FROM THE PLAN, RECORDED. Task 7 Step 4's prose says "build agents
 * need room (~40); `taste-frontend-expert` needs the most (~30)" — which is
 * self-contradictory in its own sentence, since 30 is not more than 40. The
 * executable half of the same step pins only `taste >= 25` and
 * `security-auditor <= taste`, and both hold here. The per-lane figures are
 * followed and "the most" is read as what it can consistently mean: the most of
 * any lane that is not writing the implementation.
 */
const LANE_TURNS: Readonly<Record<Lane, number>> = {
  spec: 15,
  design: 30,
  build: 40,
  review: 15,
  gate: 30,
};

/**
 * Per-agent departures from the lane number.
 *
 * `ui-designer` resolves to DESIGN (see {@link laneOf}) but does not do DESIGN's
 * expensive part: spec 6.4 scopes it to "tokens only" and the image loop that
 * makes the lane turn-hungry belongs to `taste-frontend-expert`. Left at the lane
 * default it would carry twice the budget of its work in either of its roles.
 */
const AGENT_TURNS: ReadonlyMap<string, number> = new Map([["ui-designer", 20]]);

/**
 * The bound for an agent that belongs to no lane.
 *
 * Deliberately at the cheap end. An unknown name is by definition an agent whose
 * work nothing here has reasoned about, and the failure this table exists to
 * prevent is an unbounded lens — so the default is a bound, not a blank cheque.
 */
const UNKNOWN_AGENT_TURNS = 15;

/**
 * The bounds for one agent. Total: an unknown name gets a real bound, never
 * `undefined`, because `undefined` reads downstream as "no bound" and that is the
 * unbounded lens this table exists to stop.
 *
 * APPLIED SINCE PHASE 1.1 TASK 4 — this paragraph used to say the opposite and
 * was true when it was written. Two facts, both read off the SDK's own typings
 * rather than assumed:
 *
 *   1. `AgentInput` — the Agent/Task tool's schema (`sdk-tools.d.ts`) — has
 *      `description`, `prompt`, `subagent_type`, `model`, `run_in_background`,
 *      `name`, `team_name`, `mode` and `isolation`. There is NO turn field, so a
 *      bound still cannot be attached to an individual delegation CALL.
 *   2. `AgentDefinition` DOES carry `maxTurns` and `effort`, and `buildOptions`
 *      now emits one per shortlisted agent through `Options.agents`. That type
 *      REQUIRES `prompt`, so this run supplies one ({@link reportContract}) —
 *      whether that REPLACES the body loaded from the owner's disk under
 *      `settingSources: ["user"]` is unmeasured, and the trade is argued on
 *      `reportContract` rather than glossed here.
 *
 * WHAT WAS "NOT PROVEN" IS NOW MEASURED, AND IT IS THE BAD ANSWER (2026-07-28).
 * This paragraph used to read "the enforcement needs a live run to observe, and
 * no such run has been made". Two runs have now been made. Probe G2 removed the
 * session-level narrowing and kept the per-agent `disallowedTools`: the child
 * enumerated 620 tools, 589 of them `mcp__*`, IDENTICAL to the unnarrowed
 * control. The DoD run found `subagent_type` resolving to the DISK definition —
 * disk model, disk tools, disk body, our prompt absent. So for a shortlisted
 * name that HAS a file in ~/.claude/agents/ — roughly 141 of them —
 * `maxTurns`, `disallowedTools` and `background: false` bind NOTHING.
 *
 * The bounds are still computed and still sent, because a `subagent_type` with
 * NO disk file has nothing to resolve to and this definition may be what binds
 * it; probe I is measuring exactly that. "It is in the options object" is not
 * "it bounded anything", and for on-disk agents it is now measured NOT to have.
 *
 * WHY EVERY `effort` IS NULL. Null means the run's own effort stands — the rung
 * the owner picked in the UI, which reaches the session as `Options.effort`.
 * There is no measurement behind any per-agent rung: nothing has been run at two
 * efforts and compared. Inventing rungs here would silently override an owner's
 * choice on evidence that does not exist, and would look exactly like a policy
 * that had been decided. The field is part of the signature this task specifies
 * because a bound and an effort are applied through the same
 * `AgentDefinition`, and it is the honest place for a measured value to land.
 */
export function boundsFor(agent: string): AgentBounds {
  const override = AGENT_TURNS.get(agent);
  if (override !== undefined) return { maxTurns: override, effort: null };
  const lane = laneOf(agent);
  return { maxTurns: lane === null ? UNKNOWN_AGENT_TURNS : LANE_TURNS[lane], effort: null };
}
