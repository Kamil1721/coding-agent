/**
 * TWO RUNS, ONE EVENT LIST, ONE BIT OF DIFFERENCE — and that bit is the whole
 * reason this file exists.
 *
 * WHAT WAS MISSING BEFORE IT. Every run this harness served was NON-TERMINAL:
 * `run-fixture.ts`'s `SUMMARY` is `running` (its comment says so in as many
 * words) and `PLAN_SUMMARY` is `awaiting_input`. `use-run-stream.ts:819` derives
 *
 *     const streamClosed = status !== undefined && isTerminalStatus(status);
 *
 * and the EventSource effect below it early-returns on `streamClosed`, so a
 * FINISHED RUN NEVER OPENS THE SOCKET. Which means: with only non-terminal
 * fixtures in the tree, NO browser spec in this repository could observe a
 * feature that renders live and is blank on replay. The defect class is recorded
 * three times in the findings (`docs/superpowers/specs/2026-08-04-dashboard-
 * observability-findings.md` §5) and was, until this file, literally
 * unobservable in a test — a gap of exactly the shape this repo keeps recording.
 *
 * SO: `BUILD_EVENTS` is folded twice, under two run ids that differ in STATUS
 * and in nothing else that matters.
 *
 *   `BUILD_RUN_ID`    status `running` — the socket opens
 *   `FINISHED_RUN_ID` status `failed`  — the socket is never constructed
 *
 * A feature that reaches `GraphState` through `foldGraph` renders on both. A
 * feature that lives in the trace sink renders on the first and is blank on the
 * second. Two pages, one event list: the difference IS the bug class, and it
 * costs one extra route to have.
 *
 * THE SNAPSHOTS ARE FOLDED, NEVER WRITTEN DOWN, for the reason `run-fixture.ts`
 * gives at its own head: `GET /api/runs/:id/graph` answers with whatever
 * `foldGraphAll` makes of the run's rows, so a hand-written `GraphState` literal
 * would be a second implementation of the reducer — and worse than that HERE,
 * because a literal snapshot would keep answering after a replay-only fold arm
 * broke, silently degrading every assertion below into a live-only check. That
 * is precisely the failure this file was commissioned to make visible, so it is
 * refused structurally rather than by convention.
 *
 * WHAT THE GRAPH IS SHAPED BY. `run-fixture.ts`'s graph is three flat children
 * chosen to exercise edge TREATMENTS. This one is chosen to be a real BUILD
 * PHASE: a run that got past spec, delegated, delegated again, and produced
 * results.
 *
 *   root ── builder ── probe        a GRANDCHILD. Delegation here is two deep on
 *        │                          the real path and a flat fixture cannot tell
 *        │                          a broken parent lookup from a correct one.
 *        ├─ api                     a second build-lane child, still in flight
 *        ├─ reviewer                settled, with a result
 *        └─ guard                   ambient hook traffic, attribution inferred,
 *                                   and it NEVER REPORTS — see below
 *
 * `guard` and `api` carry no `graph_result`, so `foldGraph` leaves them at the
 * `running` its `graph_agent` arm seeds (`server/src/graph.ts:233`). On the
 * finished run the trailing terminal `status` row rewrites exactly those two to
 * `unresolved` (`server/src/graph.ts:367-383`). THAT IS A REPLAY-ONLY
 * COMPUTATION: nothing but the fold produces it, the live twin cannot show it,
 * and it is therefore the sharpest single thing a snapshot-backed spec can
 * assert.
 *
 * NO SIBLING GROUP FORMS. `groupSiblings` folds a run of `MIN_GROUP` = 3
 * identical siblings (`canvas/layout.ts:104`), keyed on parent + column + role +
 * state + attribution. `builder` has a child and is disqualified outright; `api`,
 * `reviewer` and `guard` differ in role AND in state, so every card below is
 * drawn as itself. If a later change makes three of them agree, the node testids
 * these specs use will vanish and the specs will say so loudly.
 */

import type {
  RunDetail,
  RunEvent,
  RunGraphResponse,
  RunSummary,
} from "../../src/lib/api-types";
import { foldGraphAll } from "../../src/lib/graph";
import { BUILD_RUN_ID, FINISHED_RUN_ID } from "./config";
import { MODEL_ID } from "./run-fixture";

/**
 * The run's durable rows up to the moment the build was live, in order. `seq` is
 * the 1-based index — the same relationship `bus.ts` writes onto the wire as
 * `id:`.
 *
 * NO TERMINAL `status` ROW. This list is what BOTH runs did; the finished one
 * appends the row that ended it (see `FINISHED_EVENTS`). Keeping the difference
 * to that single append is what makes the two pages comparable.
 */
export const BUILD_EVENTS: readonly RunEvent[] = [
  {
    type: "graph_agent",
    node: "root",
    parent: null,
    agent: null,
    lane: null,
    description: "The session that fielded the ticket.",
    ambient: false,
    attribution: "exact",
    sdk: null,
  },
  // The orchestrator reads the frozen artefacts before it delegates. Two
  // distinct files, ONE pill counted twice — which is what makes a doubled
  // fold visible as a number rather than as a missing card.
  {
    type: "graph_tool",
    node: "root",
    name: "Read",
    mcpServer: null,
    summary: "spec.md",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "root",
    name: "Read",
    mcpServer: null,
    summary: "acceptance/suite.mjs",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "root",
    name: "Task",
    mcpServer: null,
    summary: "frontend-developer",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "root",
    name: "Task",
    mcpServer: null,
    summary: "backend-developer",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "root",
    name: "Task",
    mcpServer: null,
    summary: "code-reviewer",
    attribution: "exact",
  },

  /* ---- the build lane ------------------------------------------------- */
  {
    type: "graph_agent",
    node: "builder",
    parent: "root",
    agent: "frontend-developer",
    lane: "build",
    description: "Draw the delegation graph as one continuous canvas.",
    ambient: false,
    attribution: "exact",
    sdk: { taskId: "task-builder", toolUseId: "toolu_builder" },
  },
  {
    type: "graph_skill",
    node: "builder",
    skill: "frontend-design",
    source: "invoked",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Edit",
    mcpServer: null,
    summary: "src/components/canvas/orchestration-canvas.tsx",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Edit",
    mcpServer: null,
    summary: "src/components/canvas/agent-node.tsx",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Edit",
    mcpServer: null,
    summary: "src/components/canvas/layout.ts",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Write",
    mcpServer: null,
    summary: "src/components/canvas/roles.ts",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Task",
    mcpServer: null,
    summary: "test-automator",
    attribution: "exact",
  },

  /*
   * THE GRANDCHILD. `probe`'s parent is `builder`, not `root` — the SDK reports
   * a subagent's own delegations and the canvas is supposed to draw them at the
   * depth they happened. A fixture with only first-generation children cannot
   * tell a correct parent lookup from one that pins everything to the root.
   */
  {
    type: "graph_agent",
    node: "probe",
    parent: "builder",
    agent: "test-automator",
    lane: "build",
    description: "Write the browser spec for the canvas the builder just drew.",
    ambient: false,
    attribution: "exact",
    sdk: { taskId: "task-probe", toolUseId: "toolu_probe" },
  },
  {
    type: "graph_tool",
    node: "probe",
    name: "Read",
    mcpServer: null,
    summary: "tests/fixtures/run-fixture.ts",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "probe",
    name: "Bash",
    mcpServer: null,
    summary: "npx playwright test tests/canvas-edges.browser.spec.ts",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "probe",
    name: "Bash",
    mcpServer: null,
    summary: "npx tsc --noEmit",
    attribution: "exact",
  },
  {
    type: "graph_result",
    node: "probe",
    state: "completed",
    summary: "Three specs added; the suite is green.",
    totalTokens: 38_200,
    toolUses: 3,
    durationMs: 214_000,
    attribution: "exact",
  },
  {
    type: "graph_result",
    node: "builder",
    state: "completed",
    summary: "The canvas draws root, its children and its grandchildren.",
    totalTokens: 91_600,
    toolUses: 6,
    durationMs: 612_000,
    attribution: "exact",
  },

  /*
   * STILL IN FLIGHT WHEN THE ROWS RUN OUT, and deliberately so. `api` gets no
   * `graph_result` and no closing `graph_agent_status`, which leaves it on the
   * `running` that `graph_agent` seeds. On the live run that is an agent
   * working; on the finished run the terminal `status` row resolves it to
   * `unresolved`, which is the one node state ONLY the fold can produce.
   */
  {
    type: "graph_agent",
    node: "api",
    parent: "root",
    agent: "backend-developer",
    lane: "build",
    description: "Serve the folded graph snapshot over REST.",
    ambient: false,
    attribution: "exact",
    sdk: { taskId: "task-api", toolUseId: "toolu_api" },
  },
  {
    type: "graph_tool",
    node: "api",
    name: "Edit",
    mcpServer: null,
    summary: "server/src/graph.ts",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "api",
    name: "Edit",
    mcpServer: null,
    summary: "server/src/http.ts",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "api",
    name: "Bash",
    mcpServer: null,
    summary: "npm run typecheck",
    attribution: "exact",
  },

  /* ---- the review lane ------------------------------------------------ */
  {
    type: "graph_agent",
    node: "reviewer",
    parent: "root",
    agent: "code-reviewer",
    lane: "review",
    description: "Review the canvas diff before the gate.",
    ambient: false,
    attribution: "exact",
    sdk: null,
  },
  {
    type: "graph_tool",
    node: "reviewer",
    name: "Read",
    mcpServer: null,
    summary: "src/components/canvas/orchestration-canvas.tsx",
    attribution: "exact",
  },
  {
    type: "graph_tool",
    node: "reviewer",
    name: "Grep",
    mcpServer: null,
    summary: "foldGraph",
    attribution: "exact",
  },
  {
    type: "graph_result",
    node: "reviewer",
    state: "completed",
    summary: "One blocking finding: the snapshot is never read on replay.",
    totalTokens: 21_050,
    toolUses: 2,
    durationMs: 88_000,
    attribution: "exact",
  },

  /*
   * AMBIENT HOOK TRAFFIC, ATTRIBUTED BY INFERENCE, AND IT NEVER REPORTS. Hook
   * input carries no task identity (`api-types.ts`'s `graph_hook` says so), so
   * the server attributes it and the edge must be drawn as a guess. A hook
   * session also never returns a `graph_result` — there is nothing to return —
   * so this node is the honest, permanent case of "still reads running when the
   * run ends", not a contrived one.
   *
   * `ambient: false`, AND THAT IS NOT AN OVERSIGHT. `ambient` mirrors the CLI's
   * `skip_transcript` — housekeeping agents — and `placeGraph` FILTERS THOSE OFF
   * THE CANVAS unless the `housekeeping N` button is pressed
   * (`canvas/layout.ts:493-495`). Hook traffic is not `skip_transcript`; it is
   * an attribution problem, not a housekeeping one, which is why
   * `run-fixture.ts`'s hook node is `false` too. Written this way round the card
   * is on screen by default, so a spec that asserts its state is measuring the
   * fold rather than the visibility toggle.
   */
  {
    type: "graph_agent",
    node: "guard",
    parent: "root",
    agent: "antislop-hook",
    lane: "gate",
    description: "Hook traffic, attributed by inference.",
    ambient: false,
    attribution: "inferred",
    sdk: null,
  },
  {
    type: "graph_hook",
    node: "guard",
    event: "PreToolUse",
    tool: "Bash",
    decision: "allow",
    reason: "",
    attribution: "inferred",
  },
  {
    type: "graph_hook",
    node: "guard",
    event: "PreToolUse",
    tool: "Write",
    decision: "deny",
    reason: "a secret literal was about to be written to a file",
    attribution: "inferred",
  },

  {
    type: "graph_inventory",
    agents: 5,
    skills: 1,
    tools: 6,
    allowedAgents: ["frontend-developer", "backend-developer", "code-reviewer", "test-automator"],
    mcpServers: [{ name: "context7", status: "connected" }],
    plugins: [],
    model: MODEL_ID,
    claudeCodeVersion: "2.0.0",
    environmentHash: "harness",
  },
];

/**
 * The row that ended the run, appended to the SAME list.
 *
 * IT IS A `status` EVENT AND NOT A `graph_*` ONE, which is the only reason the
 * fold sees it at all — `server/src/graph.ts:367` takes `status` precisely so a
 * run that stopped cannot leave agents reading `running` forever. Appending it
 * here rather than writing a second event list is what keeps the two fixtures
 * one bit apart.
 */
export const TERMINAL_STATUS: RunEvent = {
  type: "status",
  status: "failed",
  at: new Date("2026-08-03T10:41:02.000Z").toISOString(),
};

export const FINISHED_EVENTS: readonly RunEvent[] = [...BUILD_EVENTS, TERMINAL_STATUS];

/** The watermark each snapshot endpoint reports: the last row that went in. */
export const BUILD_AT_SEQ = BUILD_EVENTS.length;
export const FINISHED_AT_SEQ = FINISHED_EVENTS.length;

export const BUILD_GRAPH: RunGraphResponse = {
  ...foldGraphAll(BUILD_EVENTS),
  atSeq: BUILD_AT_SEQ,
};

export const FINISHED_GRAPH: RunGraphResponse = {
  ...foldGraphAll(FINISHED_EVENTS),
  atSeq: FINISHED_AT_SEQ,
};

/**
 * A ROW THAT EXISTS ONLY ON THE SOCKET, AND NEVER IN A SNAPSHOT.
 *
 * `run-fixture.ts`'s `TAIL_MARKER` proves a stream WAS consumed. This is the
 * same trick at the opposite polarity: it is served on `/events` for both runs
 * and folded into NEITHER snapshot, so its card on screen means exactly one
 * thing — an EventSource was opened and read.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS. "The finished run did not open a socket"
 * is an ABSENCE, and an absence asserted on its own passes against a page that
 * failed to load at all. Serving this identical frame to the live twin turns it
 * into a matched pair: the same bytes on the same route draw a card on the
 * running run and must draw nothing on the finished one. The positive half is
 * what makes the negative half mean something.
 *
 * THE IMPLICATION RUNS ONE WAY ONLY, and that limit is MEASURED rather than
 * assumed. This row is written last, after the finished run's terminal `status`
 * row. A client that opened the socket, folded that status and closed itself in
 * response would never receive this frame — so a missing echo card does NOT by
 * itself prove that no socket was opened. Observed exactly that while flipping
 * `FINISHED_SUMMARY.status` to `running` as a negative control: the stream was
 * live, the trace pane filled, and the echo card still never appeared.
 * Reordering the wire to close the gap would mean writing frames out of seq
 * order, which the real endpoint never does, so the limit is written down
 * instead — and `finished-run.browser.spec.ts` puts the load on the trace pane's
 * empty-state sentence and on the drawn edge count, both of which did go red.
 */
export const SOCKET_ECHO: RunEvent = {
  type: "graph_agent",
  node: "socket-echo",
  parent: "root",
  agent: "socket-echo",
  lane: null,
  description: "Only ever sent on /events. Never folded into a snapshot.",
  ambient: false,
  attribution: "exact",
  sdk: null,
};

export const BUILD_ECHO_SEQ = BUILD_AT_SEQ + 1;
export const FINISHED_ECHO_SEQ = FINISHED_AT_SEQ + 1;

/* -------------------------------------------------------------------------
 * The two runs
 * ---------------------------------------------------------------------- */

const BUILD_SUMMARY: RunSummary = {
  runId: BUILD_RUN_ID,
  ticketTitle: "Rebuild the run canvas as one continuous graph",
  modelId: MODEL_ID,
  // RUNNING, so `isTerminalStatus` is false and the socket is constructed. This
  // is the control for everything the finished twin asserts.
  status: "running",
  startedAt: new Date("2026-08-03T09:58:00.000Z").toISOString(),
  endedAt: null,
  // Not scored yet, which is NOT the same as scored and false.
  heldOutPass: null,
  falseFinish: null,
};

export const BUILD_DETAIL: RunDetail = {
  ...BUILD_SUMMARY,
  // A live run that has not gone wrong. `null` here is an absence, not a claim
  // of health — see `RUN_DETAIL`'s note on the same field.
  failureReason: null,
  silence: null,
  publishedProject: null,
  ticketText: "Rebuild the run canvas so the pre-build stages and the agent graph share one surface.",
  phase: "build",
  criteria: [
    {
      id: "c1",
      statement: "Opening a finished run draws its delegation graph.",
      tier: "BLOCKING",
      // PENDING, because the run is still going. `pass` on a live run would say
      // the suite had already answered.
      result: "pending",
    },
    {
      id: "c2",
      statement: "The pre-build stages stay on screen once the build starts.",
      tier: "FUNCTIONAL",
      result: "pending",
    },
  ],
  tokens: null,
  costUsd: null,
  rateLimit: null,
  screenshots: [],
  references: [],
  documents: [],
  artifactPath: null,
  previewUrl: null,
  inferredCriteria: 0,
  // EMPTY UNTIL TERMINAL — `api-types.ts` says "" is "not written yet" and never
  // "written but missing". A running run has no verdict.
  verdictPath: "",
  // 0 IS "NO LOOP OUTCOME YET", never "passed first time". The gate has not run.
  gateAttempts: 0,
  gateStopReason: null,
  designLock: null,
  adversary: null,
  motion: null,
};

const FINISHED_SUMMARY: RunSummary = {
  runId: FINISHED_RUN_ID,
  // The same ticket. Only the outcome differs.
  ticketTitle: "Rebuild the run canvas as one continuous graph",
  modelId: MODEL_ID,
  /*
   * TERMINAL, AND `failed` RATHER THAN `passed` ON PURPOSE.
   *
   * `isTerminalStatus` (`src/lib/api-types.ts:1383`) is `passed | failed |
   * cancelled`, so any of the three closes the socket and either would serve the
   * replay hole. `failed` is chosen because it is the only one that makes the
   * fixture's own graph honest: `api` and `guard` were still in flight when the
   * rows stopped, and a run that ends with agents mid-flight is what
   * `foldGraph`'s `status` arm exists for. A `passed` run carrying two
   * `unresolved` cards would be a shape the server does not produce.
   */
  status: "failed",
  startedAt: new Date("2026-08-03T09:58:00.000Z").toISOString(),
  endedAt: new Date("2026-08-03T10:41:02.000Z").toISOString(),
  // SCORED, AND FALSE. This is the ordinary gate-failure path, not the harness
  // fault: `null` would make `OutcomeNotice` print "the run ended without the
  // held-out suite returning a verdict", which is a different fixture.
  heldOutPass: false,
  falseFinish: false,
};

export const FINISHED_DETAIL: RunDetail = {
  ...FINISHED_SUMMARY,
  // The server's own words on this path, quoted rather than invented —
  // `notices.tsx` records that the gate-failure writer emits exactly this fixed
  // string, and that the near-duplication with the notice above it is deliberate.
  failureReason: "the frozen held-out suite did not go green in the sealed container",
  // NOT WATCHED. A terminal run is not quiet, it is over; `silence` is a fact
  // about a run someone is waiting on.
  silence: null,
  // NEVER ATTEMPTED. `{published: false, …}` would say the copy was tried and
  // refused, which is a claim with a reason attached and nothing here made it.
  publishedProject: null,
  ticketText: "Rebuild the run canvas so the pre-build stages and the agent graph share one surface.",
  // The run died at the gate, so that is the phase it stopped in. NOT `done` —
  // `done` would say the pipeline ran to the end.
  phase: "gate",
  criteria: [
    {
      id: "c1",
      statement: "Opening a finished run draws its delegation graph.",
      tier: "BLOCKING",
      result: "pass",
    },
    {
      id: "c2",
      statement: "The pre-build stages stay on screen once the build starts.",
      tier: "FUNCTIONAL",
      result: "fail",
    },
  ],
  tokens: {
    inputTokens: 41_200,
    outputTokens: 168_400,
    cacheReadTokens: 2_104_000,
    cacheWriteTokens: 96_300,
  },
  // NULL ON A SUBSCRIPTION SEAT, which is what this machine runs. `0` would
  // claim the run was free.
  costUsd: null,
  rateLimit: null,
  screenshots: [],
  references: [],
  documents: [],
  artifactPath: "/Users/o/dashboard/runs/harness-finished-run/workspace",
  // A DEAD ADDRESS ON EVERY RECORDED RUN — the process that served it exits with
  // the run — so this fixture reports the absence rather than a link nothing
  // answers.
  previewUrl: null,
  inferredCriteria: 0,
  // Written, because the run is terminal.
  verdictPath: "/Users/o/dashboard/runs/harness-finished-run/verdict.md",
  // TWO GATE RUNS, and the loop stopped because it stopped converging. Both
  // fields move together: a reason without attempts would be a stop nothing ran.
  gateAttempts: 2,
  gateStopReason: "not-converging",
  designLock: null,
  adversary: null,
  motion: null,
};

/** Both summaries, for `GET /api/runs`. */
export const BUILD_RUN_LIST: readonly RunSummary[] = [BUILD_SUMMARY, FINISHED_SUMMARY];
