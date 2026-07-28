/**
 * agent-shortlist.ts — which of the owner's agents a build may delegate to.
 *
 * WHY THIS MODULE EXISTS. `settingSources: ["user"]` (Phase 1 Task 1) makes 144
 * agents and 162 skills visible to the orchestrator. Visibility is not permission.
 * The `canUseTool` Agent branch built in Phase 0 is the boundary — it allowlists
 * `subagent_type` and denies everything else — and this module compiles the list
 * that boundary is fed (Task 3).
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
