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
  // This fixture's ticket is "Add a test suite to the dashboard client" — a run
  // with no DESIGN lane, which is exactly what `null` means. `{awaiting: false,
  // locked: null}` would say something different: that a lane ran and locked
  // nothing.
  designLock: null,
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
