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

/**
 * TYPE-ONLY, AND IT HAS TO STAY THAT WAY. `design-lane.ts` imports `Surface`
 * from this file, so a value import in either direction would be a runtime
 * module cycle. `verbatimModuleSyntax` erases both, and `DesignLaneMode` keeps
 * its single declaration site next to the predicate that produces it.
 */
import type { DesignLaneMode } from "./design-lane.js";

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
 * DESIGN is the only conditional lane (spec 6.5). Phase 2b replaces the
 * surface-only stub with the real three-term predicate — but note which way it
 * degrades: `designLaneMode` returns "degraded" when no Gemini key resolves, and
 * a DEGRADED LANE STILL NEEDS ITS AGENTS. Spec 6.5: "taste-frontend-expert still
 * art-directs and produces written direction." Shortlisting on `mode === "full"`
 * would delete the art direction along with the images.
 *
 * It would also be invisible. An agent that is not shortlisted has its delegated
 * call DENIED by the `PreToolUse` hook, and a denied lane produces nothing —
 * which reads downstream exactly like a lane that had nothing to do. That is the
 * failure this file's own header warns about, and the failure the whole of Phase
 * 2b is designed against.
 */
function designLaneRuns(mode: DesignLaneMode): boolean {
  return mode !== "off";
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
 * boundary that can throw or await is a boundary with a failure mode. Widening
 * it with `designMode` does not change that: `designLaneMode` decides "off" from
 * `designSurfaceGate` alone, which is surface plus `visualIntent`, both pure and
 * both total. The capability half of that predicate (which spawns `npx` through
 * `designPreflight`) can only move the lane between "full" and "degraded", and
 * those two shortlist identically.
 *
 * THE DEFAULT IS "off", AND IT UNDER-DELEGATES ON PURPOSE. A caller that has not
 * yet been taught to classify the lane gets no DESIGN agents rather than a lane
 * it did not earn. `orchestrator.ts` is that caller until Phase 2b Task 10 wires
 * `shortlistFor(surface, laneMode)` through both of its call sites (the build
 * shortlist and the fix-loop's `allowedAgents`); until then a web-ui run has no
 * DESIGN lane, which is a REGRESSION from the surface-only stub this replaced and
 * is pinned by a test rather than left to be discovered.
 */
export function shortlistFor(surface: Surface, designMode: DesignLaneMode = "off"): readonly string[] {
  const design: readonly string[] = designLaneRuns(designMode) ? DELIVERY_LANES.design : [];
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

/*
 * WHAT WAS DELETED HERE ON 2026-07-29, AND WHERE IT WENT.
 *
 * `REPORT_CONTRACT_REMINDER` and `reportContract(agent)` lived here to fill
 * `AgentDefinition.prompt` and `criticalSystemReminder_EXPERIMENTAL` on the
 * per-agent entries `buildOptions` used to emit through `Options.agents`. Probe I
 * measured that channel: a definition registered under a name that also exists in
 * ~/.claude/agents/ is not consulted at all — the colliding name ran its disk
 * frontmatter's model and echoed none of the definition's prompt, while an
 * identical definition under a fresh name bound on both. Every name in
 * DELIVERY_LANES exists on disk ("every shortlisted agent exists on disk", the
 * first test in agent-shortlist.test.ts), so those two exports had no reader.
 *
 * THE CONTRACT ITSELF IS NOT DELETED — it moved to the only channel measured to
 * reach a child: the `prompt` argument the orchestrator writes on each Agent call.
 * It is stated to the orchestrator in build-prompt.ts's delegation section, with
 * the reason, and pinned by build-prompt.test.ts. Do not restore a second copy
 * here: two texts for one contract is how they drift, and only one of them is on a
 * channel that works.
 */

/**
 * How much room one delegated agent gets.
 *
 * ONE FIELD, NOT TWO. This carried `effort: AnthropicEffort | null` until
 * 2026-07-29 and every entry returned null, meaning "the run's own effort
 * stands". Its only consumer was a conditional spread into
 * `AgentDefinition.effort`, and that definition is gone — probe I measured it not
 * binding for any name this run can delegate to. A field that is null everywhere,
 * read by nobody, and typed against a route that no longer exists is decoration
 * with a type annotation, so it went with the route.
 *
 * THE DECISION IT RECORDED IS KEPT, in prose on {@link boundsFor}, because it was
 * a real decision: this program does not invent a per-agent effort rung.
 */
export interface AgentBounds {
  /** Agentic turns (API round-trips) this agent should be given. */
  readonly maxTurns: number;
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
 * NOT WIRED TO ANYTHING, AND THAT IS THE HONEST STATE AS OF 2026-07-29. This
 * function has no production caller. It is a table of numbers with no route that
 * applies them, said here rather than left for a reader to infer from an options
 * object that no longer carries them.
 *
 * BOTH ROUTES ARE CLOSED, MEASURED RATHER THAN ASSUMED:
 *
 *   THE CALL   `AgentInput` — the Agent/Task tool's schema (`sdk-tools.d.ts`) —
 *              has `description`, `prompt`, `subagent_type`, `model`,
 *              `run_in_background`, `name`, `team_name`, `mode` and `isolation`.
 *              There is NO turn field, so a bound cannot ride on an individual
 *              delegation call.
 *   THE        `AgentDefinition` does carry `maxTurns` and `effort`, and
 *   DEFINITION `buildOptions` emitted one per shortlisted agent until 2026-07-29.
 *              Probe I measured `maxTurns: 1` cutting off a child registered
 *              under a FRESH name after one round-trip, and NOT binding a child
 *              registered identically under a name that also exists in
 *              ~/.claude/agents/ — which is every name in DELIVERY_LANES. The
 *              field works; it does not reach these agents. The wiring was
 *              deleted rather than left reading like a budget.
 *
 * WHY THE TABLE STAYS. The numbers are still the right numbers and the failure
 * they describe is real — `DEFAULT_MAX_TURNS = 400` is session-level, so one
 * runaway lens can spend the whole run before GATE/FIX starts (spec 11 item 3).
 * When a route exists that applies a per-agent bound, this is what it applies.
 * Until then: a table, tested as a table, claiming nothing.
 *
 * AND THERE IS NO PER-AGENT EFFORT, WHICH IS A DECISION RATHER THAN AN OMISSION.
 * The run's own rung — the one the owner picked in the UI, which reaches the
 * session as `Options.effort` — stands for every agent. Nothing here has been run
 * at two efforts and compared, so any rung this file named would be invention
 * silently overriding an owner's choice, wearing the look of a policy somebody
 * decided. A `null` field said that too, and said it while pointing at a route
 * that has since been deleted; a sentence says it without a type annotation
 * implying a mechanism. If a rung is ever measured, it lands next to
 * {@link AgentBounds.maxTurns} and this paragraph is what it replaces.
 */
export function boundsFor(agent: string): AgentBounds {
  const override = AGENT_TURNS.get(agent);
  if (override !== undefined) return { maxTurns: override };
  const lane = laneOf(agent);
  return { maxTurns: lane === null ? UNKNOWN_AGENT_TURNS : LANE_TURNS[lane] };
}
