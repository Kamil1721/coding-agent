/**
 * build-prompt.ts — what the builder is told.
 *
 * WHY THIS IS NOT `builderPrompt` FROM bakeoff/src/runner.ts. That prompt is
 * correct and is deliberately mirrored below, but it hardcodes the CONTAINER
 * paths — "Your workspace is /workspace", "The sandbox has no network access" —
 * because the bake-off builder runs inside a sealed image. The dashboard
 * builder runs on the host, in a real directory, with network access. Handing
 * it that prompt verbatim would send it to a path that does not exist and tell
 * it a fact about its environment that is false. So the WORDING that is
 * load-bearing is reproduced and the environment facts are corrected, with
 * `WORKSPACE` and `STATIC_SERVE_PORT` imported rather than retyped so the
 * self-report path and the static port cannot drift from the harness.
 *
 * THE THREE PROPERTIES THAT MUST SURVIVE THE REWRITE:
 *
 * 1. NO ANTI-CHEATING SCOLDING. Anthropic measured that the framing "only
 *    dangerously misaligned AIs would hack" produced HIGHER misalignment than
 *    neutral framing (doc 02 section 5.6). The defence against test tampering
 *    is that the suite is not in the workspace, not a sentence in a prompt.
 *
 * 2. NOTHING ABOUT THE HELD-OUT SUITE beyond "acceptance is judged elsewhere".
 *    Telling the builder what is being measured is the leak the sealed gate
 *    exists to prevent.
 *
 * 3. THE SELF-REPORT CONTRACT IS SPECIFIED, because a structured completion
 *    signal has to be specified to be produced, and because BLOCKED is a
 *    first-class outcome worth making easy to choose (doc 03 section 8.3).
 *    That file is RECORDED AND SCORES NOTHING: it exists so `falseFinish`
 *    (declared done AND the held-out suite failed) can be computed at all.
 *
 * PHASE 1 TASK 4 ADDS A FOURTH: THE PROMPT MUST DESCRIBE THE GUARD IT RUNS
 * BEHIND, AND NOTHING ELSE. Task 3 turned delegation on and bounded it by
 * `BuildRequest.allowedAgents`. The builder cannot see that array — it sees 144
 * agents loaded from the owner's settings, of which ~26 are reachable. Left
 * uninformed it discovers the boundary by hitting it, one denied call and one
 * turn at a time. So the shortlist is stated. Three rules keep the statement
 * honest, each enforced by a test in build-prompt.test.ts:
 *
 *   NEVER NAME AN AGENT THAT IS NOT IN `allowedAgents`. Every name rendered
 *   below is read out of the caller's array. Not one is a literal in this file
 *   — an illustrative "ask code-reviewer to…" reads as helpful prose and is a
 *   guaranteed denial for any run whose shortlist omits it.
 *
 *   NEVER PROMISE A FIELD THE GUARD REFUSES. The Agent tool takes a field that
 *   moves the work to a worktree or off the machine entirely; the guard denies
 *   it unconditionally, and this prompt does not name it. Naming a forbidden
 *   capability is how a model learns the capability exists — the denial does
 *   not need the prompt's help. (The plan's Task 4 prose said to state "never
 *   pass `isolation`"; the plan's own test for the same step asserts the word is
 *   absent. The test is the executable half and it is the one followed here.)
 *
 *   EXPLAIN A DENIAL. `run_in_background` defaults to TRUE and the guard denies
 *   that default, so a builder that never sets it delegates exactly zero times.
 *   And a model that reads "denied" as a transient fault retries the identical
 *   call — at roughly a turn apiece, against a boundary that will never move.
 *
 * PHASE 1 TASK 7 ADDS A FIFTH: THE REPORT CONTRACT, WHICH IS WHERE THE CONTEXT
 * BUDGET IS ACTUALLY SPENT OR SAVED. Delegation is not only how the work gets
 * split — it is the primary context-compression mechanism (spec 15.1). A
 * subagent runs in its OWN context window, so fifty tool calls inside it cost
 * the orchestrator only the size of the report that comes back. That is roughly
 * 50:1, and it inverts the moment a subagent answers with narration: the parent's
 * window is the one under pressure, it is what compaction destroys, and
 * compaction is silent. The run does not fail — it forgets its own earlier
 * decisions and quietly gets worse, which is harder to notice than a failure.
 *
 * WHY THE CONTRACT IS STATED TO THE ORCHESTRATOR RATHER THAN TO EACH SUBAGENT.
 * Spec 15.1 asks for it in "every `AgentDefinition.prompt`". THAT ROUTE WAS BUILT
 * AND IS MEASURED DEAD. Probe I registered one definition under a name that
 * exists in ~/.claude/agents/ and an identical one under a name that does not:
 * the fresh name echoed its definition's nonce and ran its definition's model,
 * while the colliding name echoed nothing and ran the model declared in its own
 * disk frontmatter. `Options.agents` does not bind for a name with a file on
 * disk — and "every shortlisted agent exists on disk" is a green test in
 * agent-shortlist.test.ts, so there is no shortlisted name it could bind. An
 * `AgentDefinition.prompt` would reach nobody this run delegates to.
 *
 * THE CHANNEL USED INSTEAD IS THE ONE MEASURED TO REACH A CHILD. The `prompt`
 * argument on each Agent call is authored by the model per call and is not an
 * `AgentDefinition` field, so probe I's finding does not touch it. The same probe
 * shows it landing: S2 delegated to the on-disk `code-reviewer` — the child whose
 * definition was measured discarded, running the disk model `claude-opus-5[1m]` —
 * with an instruction carried ONLY in that argument ("read this file, reply with
 * that token verbatim and nothing else"). It read the file and replied with
 * exactly the token and nothing else, a string the probe asserts appears in no
 * prompt and no path. The argument reaches the child, and it shapes what the child
 * sends back.
 *
 * WHAT THIS ROUTE DOES NOT GUARANTEE, SAID PLAINLY. It is an INSTRUCTION TO THE
 * ORCHESTRATOR, not a bound the engine applies. Nothing inspects an Agent call to
 * check the contract was pasted into it, nothing truncates a reply that ignores
 * it, and a failure at either step is silent — the build carries on with a fuller
 * parent window and says nothing. That makes it WEAKER than the AgentDefinition
 * route was believed to be, and stronger than that route actually is, which is
 * zero. It is stated WITH its reason for exactly that purpose: a bare format is
 * followed until the model judges that more detail would help, which is the
 * failure mode; a model that knows why complies when it matters.
 */

import { WORKSPACE } from "bakeoff/dist/runner.js";
import { STATIC_SERVE_PORT } from "bakeoff/dist/scorer-protocol.js";
import { DELIVERY_LANES, type Lane } from "./agent-shortlist.js";

/**
 * Everything the first turn of a build needs to be told.
 *
 * An OBJECT rather than three positional strings because two of the three are
 * paths-or-prose that read identically at a call site, and because
 * `allowedAgents` is REQUIRED: an optional `= []` would let the only caller
 * silently never pass it, and the orchestration section would then be dead code
 * that every test in this file still passed.
 */
export interface BuilderPromptRequest {
  /** The ticket, as the owner typed it. */
  readonly ticketText: string;
  /** The run's workspace. The build may not write outside it. */
  readonly workspaceDir: string;
  /**
   * The delegation shortlist — EXACTLY the array `canUseTool` allowlists.
   * It must be the same value, from the same expression, as
   * `BuildRequest.allowedAgents`: a prompt that names an agent the guard denies
   * spends turns on calls that cannot succeed, and a prompt that omits one the
   * guard permits loses that specialist silently.
   *
   * Empty means delegation is off (the fail-closed default). The section is
   * then omitted entirely rather than rendered empty — the builder does the
   * work itself, which is what the guard would force anyway.
   */
  readonly allowedAgents: readonly string[];
}

/**
 * The lanes in the order the work wants to happen in, with what each is FOR.
 *
 * Grouping is the whole value of handing over the list. Flat, 26 names carry no
 * sequence and the model picks by the resemblance of a name to the ticket.
 * Grouped, SPEC precedes BUILD precedes REVIEW, and a specialist's position says
 * when to reach for it.
 *
 * Advisory, not enforced (spec 6.1): lanes are server-side labels on
 * `subagent_type` in a single session, so nothing stops the model working out of
 * order. The prompt is the only place the intended order is expressed at all,
 * which is why the wording says what each lane is for rather than just naming it.
 */
const LANE_HEADINGS: Readonly<Record<Lane, string>> = {
  spec: "SPEC — settle what the ticket means before anything is built",
  design: "DESIGN — art direction, before the markup exists. One at a time, so the palette holds.",
  build: "BUILD — the implementation. Scaffold first; run two of these at once only when they cannot touch the same file.",
  review: "REVIEW — judge a tree you have stopped editing. Read-mostly, so they can run together.",
  gate: "GATE/FIX — close what REVIEW found, one at a time: parallel fixes race a failing tree.",
};

/**
 * Why a given specialist sits in a given lane, where the placement is not
 * self-evident from its name.
 *
 * Keyed `lane/agent` because `ui-designer` is deliberately in TWO lanes and the
 * two roles are opposites: it holds the tokens in DESIGN and it grades the built
 * page in REVIEW, while a different agent authors the mockups. Printed twice
 * with no explanation it reads as a duplicate to be ignored (spec 7.4).
 *
 * A note is emitted ONLY for an agent that survived the caller's shortlist, so
 * these keys never leak a name the guard would deny.
 */
const ROLE_NOTES: ReadonlyMap<string, string> = new Map([
  ["spec/context-manager", "run this one first; it owns the context the later lanes read"],
  ["spec/qa-expert", "last in this lane; it grades what the others produced"],
  ["design/taste-frontend-expert", "owns the art direction"],
  ["design/ui-designer", "tokens only; it must not author what it later grades"],
  ["review/ui-designer", "the visual gate: it grades the built page against the direction"],
]);

/**
 * The delegation section, or nothing at all when the shortlist is empty.
 *
 * Empty is the guard's fail-closed default, and a prompt that still described
 * delegation would be describing a capability every call to which is denied.
 *
 * THE REPORT CONTRACT IS AUTHORED HERE AND THIS IS ITS ONLY DELIVERY ROUTE.
 * `Options.agents` does not bind for a name that has a file in ~/.claude/agents/
 * (probe I) and every shortlisted name has one, so nothing carried on an
 * `AgentDefinition` — prompt, reminder, turn budget — reaches these agents. What
 * does reach them is the `prompt` argument the orchestrator writes on each Agent
 * call, measured in the same probe, and the block below is what the orchestrator
 * is told to put there.
 *
 * THAT IS AN INSTRUCTION, NOT AN ENFORCED BOUND. Nothing checks that the
 * orchestrator pasted it into a given call, and nothing truncates a subagent that
 * narrates anyway. Editing the wording below is editing the entire mechanism —
 * there is no second layer behind it.
 */
function delegationSection(allowedAgents: readonly string[]): readonly string[] {
  if (allowedAgents.length === 0) return [];

  const allowed = new Set(allowedAgents);
  const claimed = new Set<string>();
  const lanes: string[] = [];

  for (const lane of Object.keys(LANE_HEADINGS) as readonly Lane[]) {
    // Widened before filtering: `DELIVERY_LANES` is `as const`, so indexing it by
    // a union key yields a union of readonly tuples, and `.filter` on a union of
    // array types has no callable signature.
    const laneRoster: readonly string[] = DELIVERY_LANES[lane];
    const members = laneRoster.filter((agent) => allowed.has(agent));
    // A lane with nothing shortlisted is not advertised. An empty heading is an
    // invitation to fill it, and every name the model invents is a denial.
    if (members.length === 0) continue;
    lanes.push("", LANE_HEADINGS[lane]);
    for (const agent of members) {
      claimed.add(agent);
      const note = ROLE_NOTES.get(`${lane}/${agent}`);
      lanes.push(note === undefined ? `  - ${agent}` : `  - ${agent} — ${note}`);
    }
  }

  // The prompt must never UNDER-report the guard: a name the guard permits and
  // the prompt omits is a specialist nobody knows exists. Lane membership is the
  // ordinary source of these names, but `allowedAgents` is a plain array any
  // caller can fill, so anything unplaced is still listed.
  const unplaced = allowedAgents.filter((agent) => !claimed.has(agent));
  if (unplaced.length > 0) {
    lanes.push("", "ALSO AVAILABLE — no lane of their own");
    for (const agent of unplaced) lanes.push(`  - ${agent}`);
  }

  return [
    "",
    "DELEGATION — YOU ARE THE ORCHESTRATOR",
    "- Specialists are available to you. Delegate with the Agent tool: set `subagent_type` to one",
    "  of the exact names listed below, and always pass `run_in_background: false`. That field",
    "  defaults to true and a background helper would still be writing your workspace after you",
    "  finish, so the run refuses it — set it explicitly on every call.",
    "- Those names are the only ones available to this run. Any other value is refused, however",
    "  plausible it looks and however many agents your environment appears to offer.",
    "- If a call comes back DENIED, the name you asked for is not on this run's list. The tool is",
    "  not broken, nothing is temporarily unavailable, and the identical call will be refused every",
    "  time. Read what the refusal says, then pick a listed name or do the work yourself. Retrying",
    "  it spends a turn to learn nothing.",
    "- Delegate when the work is genuinely more than one specialty. A ticket that is one HTML file",
    "  does not need five lanes; a pipeline run for its own sake is not effort.",
    "- Several of these are read-only lenses with no file-writing tools. One that hands back",
    "  findings instead of edits is not refusing you — pass its findings to an agent that builds.",
    "",
    "WHAT THEY HAND BACK — ASK FOR IT IN EVERY `prompt` YOU SEND",
    "- A specialist works in its own context window, not in yours. It can open twenty files and",
    "  make fifty tool calls, and none of that reaches you: you get its report and nothing else.",
    "  That is what lets a build this size fit at all, and it holds only while the reports are",
    "  short. One that answers with pages of narration moves all of it into YOUR context, which",
    "  is the one that runs out.",
    "- When yours fills up it gets summarised to make room. Summarising drops detail, and what",
    "  it drops first is the decisions you made early on. The build carries on and quietly gets",
    "  worse, and nothing announces it. Short reports are how you stay out of that.",
    "- So end every prompt you send with this:",
    "",
    "    Reply with these four lines and nothing else:",
    "    DONE:       one line, what you accomplished",
    "    FILES:      the files changed or created, one path per line",
    '    NEXT:       what the next specialist needs to know, or "nothing"',
    '    UNRESOLVED: what you could not finish, or "none"',
    "    Do not narrate your process, do not paste file contents, do not restate the ticket.",
    "",
    "- Then read the paths they listed rather than asking anyone to quote a file back to you.",
    "  You share one workspace, so everything they wrote is already on disk under your own eyes.",
    "",
    "The lanes below are the order the work wants to happen in.",
    ...lanes,
  ];
}

export function dashboardBuilderPrompt(request: BuilderPromptRequest): string {
  const { ticketText, workspaceDir } = request;
  return [
    "You are building a complete, working implementation of the ticket below.",
    "",
    "WORKING AGREEMENT",
    `- Your workspace is ${workspaceDir}. Everything you build lives there, and you may not write`,
    "  outside it.",
    `- The ticket text is also at ${WORKSPACE.ticketFile}.`,
    `- If a directory named ${WORKSPACE.visibleDir}/ exists, it holds a SUBSET of the acceptance`,
    "  tests, provided so you have a real feedback signal. Run them as often as you like.",
    "  Passing them is necessary and not sufficient: acceptance is judged separately, by tests",
    "  you have not seen, executed elsewhere against your final workspace.",
    "- You have network access and may install dependencies.",
    "",
    "SHIP THE SIMPLEST THING THE TICKET ACTUALLY ASKS FOR",
    "- If the ticket needs no server-side behaviour, plain HTML and CSS is a COMPLETE answer.",
    "  You are not expected to add a server, a framework or a build step to prove effort, and",
    "  you are not penalised for leaving them out.",
    "- Put the entry document at the root of your workspace, named index.html, so the site is",
    "  openable as it stands. Reference assets by relative path.",
    `- If the ticket DOES need a server, start it on port ${String(STATIC_SERVE_PORT)} and bind`,
    '  127.0.0.1 or 0.0.0.0 — never "localhost" only.',
    // AFTER the simplicity clause on purpose. A list of 26 specialists is an
    // invitation to build a pipeline; the model should read "ship the simplest
    // thing" first and take delegation as a way to do that well, not as a bar to
    // clear.
    ...delegationSection(request.allowedAgents),
    "",
    "WHEN YOU FINISH, OR WHEN YOU CANNOT",
    `Write ${WORKSPACE.selfReport} with exactly this shape:`,
    '  {"status": "done" | "blocked" | "incomplete", "reason": "<one or two sentences>"}',
    "",
    '- "done"       you believe the ticket is fully implemented.',
    '- "blocked"    something outside your control stops you. Say what. Partial work with an',
    "               honest blocked status is a better outcome than a confident false finish,",
    "               and it is recorded as such.",
    '- "incomplete" you ran out of room but were still making progress.',
    "",
    "This file is your report about yourself. It is recorded. It does not grade your work.",
    "",
    "THE TICKET",
    "",
    ticketText,
  ].join("\n");
}

/**
 * The prompt for a RESUMED build.
 *
 * A resumed session already holds the whole conversation, so repeating the
 * ticket would spend quota re-reading what the model can already see. What it
 * cannot see is why it stopped.
 */
export function resumeBuilderPrompt(reason: string): string {
  return [
    `Your previous turn ended early: ${reason}`,
    "",
    "Continue from where you stopped. The workspace is unchanged and still yours.",
    `When you are finished, or if you cannot finish, write ${WORKSPACE.selfReport} as described earlier.`,
  ].join("\n");
}
