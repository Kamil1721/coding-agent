/**
 * One run, built out of the REAL event union and folded by the REAL reducer.
 *
 * WHY THE SNAPSHOT IS FOLDED RATHER THAN WRITTEN DOWN. `GET /api/runs/:id/graph`
 * returns whatever `foldGraphAll` makes of the run's rows, so a hand-written
 * `GraphState` literal here would be a second implementation of the reducer —
 * the exact thing `src/lib/graph.ts` exists to refuse. Folding the fixture's own
 * events with the shipped function means the browser sees a snapshot the server
 * could actually have produced, and the dedup spec can replay the SAME rows the
 * snapshot was folded from, which is precisely what the SSE stream does.
 *
 * THE GRAPH IS SHAPED BY WHAT HAS TO BE OBSERVABLE, one edge per treatment:
 *
 *   root -> builder    child `running`, attribution `exact`     -> FLOWING
 *   root -> reviewer   child `completed`, attribution `exact`   -> SETTLED
 *   root -> guard      child `running`, attribution `inferred`  -> INFERRED
 *
 * The guard is running ON PURPOSE. An inferred edge must not flow even when its
 * child is live — that is the whole claim `flow-edge.tsx` makes about not
 * animating a guess — so the fixture puts the two categories in the state where
 * only the attribution can tell them apart.
 *
 * `root` calls `Read` TWICE and nothing else calls it. That count is the dedup
 * spec's discriminator: replaying the snapshot's own rows reads 2 with the
 * watermark and 4 without it.
 */

import type {
  CodeFileResponse,
  CodeTreeResponse,
  ModelOption,
  RunDetail,
  RunEvent,
  RunGraphResponse,
  RunSummary,
} from "../../src/lib/api-types";
import { foldGraphAll } from "../../src/lib/graph";
import { REPLAY_RUN_ID, RUN_ID } from "./config";

export const MODEL_ID = "claude-sonnet-4-6";

/**
 * The run's durable rows, in order. `seq` is the 1-based index — the same
 * relationship `bus.ts` writes onto the wire as `id:`.
 */
export const GRAPH_EVENTS: readonly RunEvent[] = [
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
    summary: "plan.md",
    attribution: "exact",
  },
  {
    type: "graph_agent",
    node: "builder",
    parent: "root",
    agent: "frontend-developer",
    lane: "build",
    description: "Build the orchestration canvas.",
    ambient: false,
    attribution: "exact",
    sdk: null,
  },
  {
    type: "graph_agent",
    node: "reviewer",
    parent: "root",
    agent: "code-reviewer",
    lane: "review",
    description: "Review the canvas diff.",
    ambient: false,
    attribution: "exact",
    sdk: null,
  },
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
    type: "graph_result",
    node: "reviewer",
    state: "completed",
    summary: "No blocking findings.",
    totalTokens: 12_400,
    toolUses: 9,
    durationMs: 41_000,
    attribution: "exact",
  },
  {
    type: "graph_agent_status",
    node: "builder",
    state: "running",
    attribution: "exact",
  },
  {
    type: "graph_agent_status",
    node: "guard",
    state: "running",
    attribution: "inferred",
  },
  {
    type: "graph_inventory",
    agents: 3,
    skills: 0,
    tools: 1,
    allowedAgents: ["frontend-developer", "code-reviewer"],
    mcpServers: [{ name: "context7", status: "connected" }],
    plugins: [],
    model: MODEL_ID,
    claudeCodeVersion: "2.0.0",
    environmentHash: "harness",
  },
];

/** The watermark the snapshot endpoint reports: the last row that went in. */
export const AT_SEQ = GRAPH_EVENTS.length;

export const GRAPH_SNAPSHOT: RunGraphResponse = {
  ...foldGraphAll(GRAPH_EVENTS),
  atSeq: AT_SEQ,
};

/**
 * ONE ROW PAST THE WATERMARK, and the whole reason the replay spec is not
 * vacuous.
 *
 * A stream replaying rows the snapshot already holds changes NOTHING on screen
 * when the client is correct, so "assert the pill still reads 2" would pass just
 * as well against a page where the socket never connected — a check that cannot
 * go red. This row arrives LAST and is genuinely new, so the browser drawing its
 * card is proof that every frame before it was delivered and folded. SSE is
 * ordered; that is what makes the marker mean what it says.
 */
export const TAIL_MARKER: RunEvent = {
  type: "graph_agent",
  node: "tail",
  parent: "root",
  agent: "tail-marker",
  lane: null,
  description: "Arrived on the tail, after the replay.",
  ambient: false,
  attribution: "exact",
  sdk: null,
};

export const TAIL_SEQ = AT_SEQ + 1;

const SUMMARY: RunSummary = {
  runId: RUN_ID,
  ticketTitle: "Give the client a test suite",
  modelId: MODEL_ID,
  // RUNNING, NOT TERMINAL. `useLiveRun` opens no EventSource on a finished run,
  // and a canvas with a live child is the state the flowing edge exists for.
  status: "running",
  startedAt: new Date("2026-07-29T09:00:00.000Z").toISOString(),
  endedAt: null,
  heldOutPass: null,
  falseFinish: null,
};

export const RUN_DETAIL: RunDetail = {
  ...SUMMARY,
  // The default fixture is a HEALTHY run, so it carries no failure reason. A
  // spec that wants the failure notice's detail line sets this explicitly
  // rather than inheriting one nobody asked for.
  failureReason: null,
  // Both are absences, and neither means "healthy". `silence: null` on a
  // `running` fixture means this fixture asserts NOTHING about silence — not
  // that the run is being watched and is fine. `publishedProject: null` means
  // no terminal publish has happened, which is true of a running run.
  silence: null,
  publishedProject: null,
  ticketText: "Add a test suite to the dashboard client.",
  phase: "build",
  criteria: [
    {
      id: "c1",
      statement: "npm test runs from cold.",
      tier: "BLOCKING",
      result: "pending",
    },
  ],
  tokens: null,
  costUsd: null,
  rateLimit: null,
  screenshots: [],
  artifactPath: null,
  previewUrl: null,
  inferredCriteria: 0,
  verdictPath: "",
  // The run is RUNNING, so the GATE/FIX loop has produced no outcome: 0 gate
  // runs and no reason. `gateStopReason: "green"` here would say this build had
  // been measured and passed, which is a different fixture entirely.
  gateAttempts: 0,
  gateStopReason: null,
  // This fixture's ticket is "Add a test suite to the dashboard client" — a run
  // with no DESIGN lane, which is exactly what `null` means. `{awaiting: false,
  // locked: null}` would say something different: that a lane ran and locked
  // nothing.
  designLock: null,
  // No human-factors pass on this fixture. `null` = the pass left no report;
  // `[]` would claim it ran and found nothing. The UI renders those differently.
  adversary: null,
};

/** The same run under a second id, served with a replaying stream. */
export const REPLAY_DETAIL: RunDetail = { ...RUN_DETAIL, runId: REPLAY_RUN_ID };

export const RUN_LIST: readonly RunSummary[] = [
  SUMMARY,
  { ...SUMMARY, runId: REPLAY_RUN_ID },
];

export const MODELS: readonly ModelOption[] = [
  {
    id: MODEL_ID,
    label: "Sonnet 4.6",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
];

/* -------------------------------------------------------------------------
 * `GET /api/runs/:id/files` — the code sidebar's two responses
 *
 * SHAPED BY WHAT MUST BE OBSERVABLE IN A BROWSER, and by nothing else. The
 * server's own refusals are proved over a real filesystem in
 * `server/src/code-files.test.ts`; there is nothing a fake API can say about a
 * path traversal. What only a browser can show is that the tree is reachable by
 * keyboard, that a nested file is one Tab-and-Enter away, and that a truncated
 * file SAYS SO on screen rather than silently rendering a prefix.
 *
 * So the tree carries a nested directory, and one of its files is over the
 * server's cap with `truncated: true`.
 * ---------------------------------------------------------------------- */

export const CODE_TREE: CodeTreeResponse = {
  kind: "tree",
  runId: RUN_ID,
  root: "/Users/o/dashboard/runs/harness-canvas-run/workspace",
  entries: [
    { path: "visible-acceptance", name: "visible-acceptance", type: "dir", bytes: null },
    {
      path: "visible-acceptance/coglane-page.spec.mjs",
      name: "coglane-page.spec.mjs",
      type: "file",
      bytes: 4_096,
    },
    { path: "index.html", name: "index.html", type: "file", bytes: 5_763 },
    { path: "build.log", name: "build.log", type: "file", bytes: 12_369_476 },
  ],
  exclusions: [
    {
      path: ".env",
      reason: ".env is a credential file by name and is never served",
    },
  ],
  truncated: false,
};

/** The 256 KB the server would send of a 12,369,476-byte transcript. */
const TRUNCATED_TEXT = `${"builder step\n".repeat(19_000)}`.slice(0, 262_144);

export const CODE_FILES: Readonly<Record<string, CodeFileResponse>> = {
  "index.html": {
    kind: "file",
    runId: RUN_ID,
    path: "index.html",
    bytes: 5_763,
    text: "<!doctype html>\n<html lang=\"en\">\n  <body>\n    <h1>Coglane</h1>\n  </body>\n</html>\n",
    binary: false,
    truncated: false,
    redactions: 0,
    withheld: null,
  },
  "visible-acceptance/coglane-page.spec.mjs": {
    kind: "file",
    runId: RUN_ID,
    path: "visible-acceptance/coglane-page.spec.mjs",
    bytes: 4_096,
    text: "// the visible subset\nexport default 1;\n",
    binary: false,
    truncated: false,
    redactions: 0,
    withheld: null,
  },
  "build.log": {
    kind: "file",
    runId: RUN_ID,
    path: "build.log",
    bytes: 12_369_476,
    text: TRUNCATED_TEXT,
    binary: false,
    truncated: true,
    redactions: 0,
    withheld: null,
  },
};
