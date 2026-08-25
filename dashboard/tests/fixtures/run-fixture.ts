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
import type { ChatMessage } from "../../src/lib/api";
import { foldGraphAll } from "../../src/lib/graph";
import { PLAN_RUN_ID, REPLAY_RUN_ID, RUN_ID, STALE_PLAN_RUN_ID } from "./config";

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
  // NULL, NOT `[]`. This run is still building, so the gate has produced no
  // score record — and `[]` would say it ran and reported none of the twelve
  // gates, a state the server cannot produce. The panel renders the difference.
  machineChecks: null,
  tokens: null,
  costUsd: null,
  rateLimit: null,
  screenshots: [],
  /*
   * NO ATTACHMENTS, WRITTEN OUT RATHER THAN OMITTED — and the difference costs
   * something, so it is named here.
   *
   * `[]` is what the server sends for a ticket nobody attached a file to, and
   * `TicketAttachmentsPanel` renders nothing for it, so every existing spec sees
   * the Ticket tab it saw before. What this fixture can therefore NO LONGER
   * reproduce is the other absence: a run recorded before these fields existed
   * answers with a body carrying neither KEY, and `lib/api.ts` casts responses
   * with `parsed as T` and no runtime validation. That case is real (it is every
   * run in `dashboard/runs/` today) and is guarded by `?? []` at the mount site
   * in `canvas/sheet.tsx`; it was verified against the live backend on
   * 2026-08-02, not here.
   */
  references: [],
  documents: [],
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
  // No motion reference — and `null` is ALSO what the server sends for a ticket
  // that named one, because `toDetail` hardcodes it until the intake wiring
  // lands. This fixture therefore asserts nothing about a captured reading; a
  // spec that wants one sets it explicitly rather than inheriting an absence
  // that currently means two different things.
  motion: null,
};

/** The same run under a second id, served with a replaying stream. */
export const REPLAY_DETAIL: RunDetail = { ...RUN_DETAIL, runId: REPLAY_RUN_ID };

/* -------------------------------------------------------------------------
 * THE PLAN PARK
 *
 * A run stopped in the `plan` phase with three questions outstanding, one of
 * them already settled, and one owner turn that was a QUESTION rather than an
 * answer — because that last one is the state the whole surface is judged on:
 * an owner who asks for clarification must be able to see that he has not
 * answered.
 *
 * EVERY STRING BELOW IS THE SHAPE ITS PRODUCER EMITS, quoted from the server
 * rather than invented, so that a client that renders this fixture renders the
 * real thing:
 *
 *   · the plan prose row  — `appendMessage(runId, {role:"run", text:
 *     opened.plan.join("\n")})`, `orchestrator.ts#planPhase`
 *   · the question block  — `questionText(questions)` =
 *     `questions.map(q => `${q.id}: ${q.text}`).join("\n")`,
 *     `server/src/plan-dialogue.ts`
 *   · the re-ask          — `PlanDriver#reask`, the SAME function over the
 *     still-open set, which is what makes the newest block the open set
 *   · the park log line   — `orchestrator.ts#planPhase`'s `#emitLog`, verbatim
 *     including the minute count the countdown is derived from
 *   · the `recorded against` line — `PlanDriver#report`
 * ---------------------------------------------------------------------- */

const PLAN_SUMMARY: RunSummary = {
  runId: PLAN_RUN_ID,
  ticketTitle: "Build me a portfolio site",
  modelId: MODEL_ID,
  // PARKED, NOT RUNNING. `phase: "plan"` and `awaiting_input` together are the
  // only thing that makes the newest question block the OPEN set rather than a
  // list of questions that have all been settled.
  status: "awaiting_input",
  startedAt: new Date("2026-08-02T09:00:00.000Z").toISOString(),
  endedAt: null,
  heldOutPass: null,
  falseFinish: null,
};

export const PLAN_DETAIL: RunDetail = {
  ...PLAN_SUMMARY,
  failureReason: null,
  silence: null,
  publishedProject: null,
  ticketText: "build me a portfolio site",
  phase: "plan",
  // NO CRITERIA, AND THAT IS THE POINT OF THE PHASE. The suite is authored after
  // the dialogue folds into the brief; a parked plan run has none yet.
  criteria: [],
  // And no machine checks either, for the same reason one phase further on: a
  // run parked in `plan` has not been built, let alone gated.
  machineChecks: null,
  tokens: null,
  costUsd: null,
  rateLimit: null,
  screenshots: [],
  references: [],
  documents: [],
  artifactPath: null,
  previewUrl: null,
  inferredCriteria: 0,
  verdictPath: "",
  gateAttempts: 0,
  gateStopReason: null,
  designLock: null,
  adversary: null,
  // As on `RUN_DETAIL`: `null` is what the server sends for every run today,
  // whether or not the ticket named a motion reference.
  motion: null,
};

/**
 * NO GRAPH, FOLDED BY THE REAL REDUCER RATHER THAN WRITTEN OUT.
 *
 * A run parked in the plan phase has no builder session, so there are no `graph_*`
 * events to fold and the canvas draws the plan STAGE instead. `foldGraphAll([])`
 * is what the server would answer with, and using it means an added field on
 * `GraphState` cannot leave this fixture serving a shape the app no longer reads.
 */
export const PLAN_GRAPH: RunGraphResponse = { ...foldGraphAll([]), atSeq: 0 };

/**
 * The park's log lines, replayed on the stream the way `/events` replays them.
 *
 * THE PARK LINE'S TIMESTAMP IS THE CLOCK. `at` is what the client turns into
 * `TraceEntry.atMs`, and the countdown is that instant plus the minutes named in
 * the sentence — so this fixture's `at` is written at RUN TIME (see
 * `planEvents`) rather than frozen, because a fixture with a 2026-08-02 park
 * instant would render "the window has closed" forever and prove nothing about
 * the countdown.
 */
export function planEvents(nowMs: number): readonly RunEvent[] {
  const parkedAt = new Date(nowMs - 4 * 60_000).toISOString();
  return [
    { type: "phase", phase: "plan", at: parkedAt },
    {
      type: "log",
      level: "info",
      at: parkedAt,
      text:
        "the planning seat proposed 4 question(s) and 3 earned a place. The run is waiting for an " +
        `answer in the chat; POST /api/runs/${PLAN_RUN_ID}/messages carries one. With no answer ` +
        "inside 20 minutes the run proceeds on what it assumed, and the assumptions are recorded.",
    },
    {
      type: "log",
      level: "info",
      at: new Date(nowMs - 90_000).toISOString(),
      /*
       * WHAT WAS RECORDED, WHICH IS NOT WORD-FOR-WORD WHAT HE TYPED. He wrote
       * "PQ-2: one page is enough. PQ-1: what do you mean by the grid?" in one
       * message; `stripQuestionIds` takes the addressing off and the seat's
       * refinement narrows it to the clause that answers PQ-2. The panel prints
       * this, not his sentence, because the arbiter's echo is the whole
       * mitigation for a seat that paraphrases wrongly.
       */
      text: "recorded against PQ-2 (answered, addressed): one page is enough",
    },
  ];
}

/**
 * The chat, oldest first, exactly as `GET /api/runs/:id/messages` returns it.
 *
 * FOUR TURNS AND THE LAST WORD IS THE RUN'S, which is the shape a park always
 * has: the seat asks, the owner says something, the seat responds and RE-ASKS
 * whatever is still open. Here the owner answered PQ-2 and then asked a question
 * of his own about PQ-1 — so PQ-1 and PQ-3 come back in the final block and PQ-2
 * does not.
 */
export const PLAN_MESSAGES: readonly ChatMessage[] = [
  {
    seq: 1,
    at: new Date("2026-08-02T09:00:12.000Z").toISOString(),
    role: "run",
    text:
      "A single-page portfolio: a short intro, a project grid, and a contact line.\n" +
      "Static HTML and CSS, no framework, no build step.",
    images: [],
    deliveredAt: null,
  },
  {
    seq: 2,
    at: new Date("2026-08-02T09:00:12.000Z").toISOString(),
    role: "run",
    text:
      "PQ-1: How many projects should the grid show?\n" +
      "PQ-2: Should each project have its own page, or is one page enough?\n" +
      "PQ-3: Which of the two images you attached is the one at the top?",
    images: [],
    deliveredAt: null,
  },
  {
    seq: 3,
    at: new Date("2026-08-02T09:01:40.000Z").toISOString(),
    role: "owner",
    text: "PQ-2: one page is enough. PQ-1: what do you mean by the grid?",
    images: [],
    deliveredAt: new Date("2026-08-02T09:01:41.000Z").toISOString(),
  },
  {
    seq: 4,
    at: new Date("2026-08-02T09:01:58.000Z").toISOString(),
    role: "run",
    text:
      "The grid is the row of project cards under the intro — how many you want decides whether it " +
      "is one row or two.",
    images: [],
    deliveredAt: null,
  },
  {
    // THE RE-ASK, AND IT IS THE WHOLE MECHANISM. `PlanDriver#reask` posts the
    // still-open set through the same `questionText`, so this block IS the answer
    // to "what is still outstanding" — PQ-2 is gone from it because it was
    // recorded, PQ-1 is still here because a question is never an answer.
    seq: 5,
    at: new Date("2026-08-02T09:01:58.000Z").toISOString(),
    role: "run",
    text:
      "PQ-1: How many projects should the grid show?\n" +
      "PQ-3: Which of the two images you attached is the one at the top?",
    images: [],
    deliveredAt: null,
  },
];

/**
 * One owner row, queued and unread, as `GET /api/runs/:id/messages` serves it
 * while nothing is stepping the run.
 *
 * THE BYTES ARE THE OBSERVED RUN'S — 2026-08-25,
 * `run-2026-08-25T10-30-39-122Z-d728ab79`: the owner typed "what is your
 * question?" into Chat on a park nothing had asked a question on, and the row
 * sat with `deliveredAt: null` for the length of the park.
 * `chat-reply.unit.spec.ts` proves the record line under it and
 * `chat-parked.browser.spec.ts` routes it onto five pages; both used to hold
 * their own copy of the row, and `orchestrator-steer.browser.spec.ts` still
 * does (its `message`, seq 17 — folding it in is a follow-up). A field added
 * to `ChatMessage` is one edit here rather than three.
 *
 * `seq` is a parameter because the row is appended to whatever transcript the
 * page already serves — `PLAN_MESSAGES` on the answerable plan park — and
 * `seq` is the 1-based index, the relationship every list in this file keeps.
 */
export function ownerMessage(
  text: string,
  seq = 1,
  at = "2026-08-25T10:41:00.000Z",
): ChatMessage {
  return { seq, at, role: "owner", text, images: [], deliveredAt: null };
}

/* -------------------------------------------------------------------------
 * A LATER PARK COLLIDING WITH THE HISTORICAL PLAN TUPLE
 *
 * The transcript still contains the original three-question block and its old
 * park line. The durable projection says all three were answered and folded;
 * the run then stopped for an unrelated creative-contract failure while its row
 * again read `phase: plan` + `awaiting_input`. This is the live screenshot's
 * contradiction, made deterministic for the browser.
 * ---------------------------------------------------------------------- */

export const STALE_PLAN_MESSAGES: readonly ChatMessage[] = [
  PLAN_MESSAGES[0]!,
  PLAN_MESSAGES[1]!,
  {
    seq: 3,
    at: new Date("2026-08-02T09:01:40.000Z").toISOString(),
    role: "owner",
    text: "PQ-1: six. PQ-2: one page. PQ-3: use the first image.",
    images: [],
    deliveredAt: new Date("2026-08-02T09:01:41.000Z").toISOString(),
  },
];

export const STALE_PLAN_EVENTS: readonly RunEvent[] = [
  { type: "phase", phase: "plan", at: "2026-08-02T09:00:10.000Z" },
  {
    type: "log",
    level: "info",
    at: "2026-08-02T09:00:12.000Z",
    text:
      "the planning seat proposed 3 question(s) and 3 earned a place. The run is waiting for an " +
      `answer in the chat; POST /api/runs/${STALE_PLAN_RUN_ID}/messages carries one. With no answer ` +
      "inside 20 minutes the run proceeds on what it assumed, and the assumptions are recorded.",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-02T09:01:42.000Z",
    text: "recorded against PQ-1 (answered, addressed): six",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-02T09:01:42.000Z",
    text: "recorded against PQ-2 (answered, addressed): one page",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-02T09:01:42.000Z",
    text: "recorded against PQ-3 (answered, addressed): use the first image",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-02T09:01:45.000Z",
    text: "the plan dialogue is folded into the brief and this run's ticket is now t-new (was t-old).",
  },
  {
    type: "log",
    level: "error",
    at: "2026-08-02T09:02:00.000Z",
    text: "creative contract author failed; the run is parked for a generic resume decision.",
  },
];

export const STALE_PLAN_DETAIL: RunDetail = {
  ...PLAN_DETAIL,
  runId: STALE_PLAN_RUN_ID,
  // THE BYTES THE RUN RECORDED, per this file's rule above — quoted from the
  // server, not invented. Run `run-2026-08-25T10-30-39-122Z-d728ab79` parked on
  // exactly this string: `orchestrator.ts#creativeContractPhase`, in the
  // one-call form it had that morning, wrote `creative contract
  // ${result.status}: ${result.detail}`, with `result.detail` the author's
  // "creative author output did not compile" (`creative-contract-author.ts`,
  // the `!compiled.ok` branch). Replaced 2026-08-25 from the invented
  // "creative contract author failed after the plan dialogue folded"; the
  // notice that renders the cause is measured against this constant
  // (`plan-dialogue.browser.spec.ts` reads it back rather than retyping it).
  //
  // HISTORIC, NOT LIVE — 2026-08-25, later the same day. The producer became a
  // three-attempt repair loop and no code path emits the one-call sentence any
  // more: a park now reads `creative contract ${status} on author attempt N of
  // 3 (attempt not consumed): ${detail}` or `creative contract invalid after N
  // author attempts; last findings: …`. The string stays because it is what the
  // run wrote and what the defect was measured on, and nothing keys on its
  // bytes: the notice branches on `failureReason !== null`
  // (`lib/awaiting-input.ts`), never on a prefix. Line numbers into the
  // server file are deliberately not cited here — it was under concurrent
  // edit, and the three numbers the lane's reviewer read from it (:3976,
  // :3985, :3997) had moved again (:4002, :4006, :4021) by the time this
  // comment was written.
  failureReason: "creative contract invalid: creative author output did not compile",
  plan: {
    awaiting: false,
    folded: true,
    deadlineAt: null,
    closed: { reason: "answered", detail: "all three plan questions were answered" },
    questions: [
      { id: "PQ-1", status: "answered", recorded: "six" },
      { id: "PQ-2", status: "answered", recorded: "one page" },
      { id: "PQ-3", status: "answered", recorded: "use the first image" },
    ],
  },
};

export const STALE_PLAN_GRAPH: RunGraphResponse = {
  ...foldGraphAll(STALE_PLAN_EVENTS),
  atSeq: STALE_PLAN_EVENTS.length,
};

export const RUN_LIST: readonly RunSummary[] = [
  SUMMARY,
  { ...SUMMARY, runId: REPLAY_RUN_ID },
  PLAN_SUMMARY,
  { ...PLAN_SUMMARY, runId: STALE_PLAN_RUN_ID },
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

/**
 * A prefix of a 12,369,476-byte transcript, standing in for what the server
 * sends when it hits its cap.
 *
 * IT IS 247,000 BYTES, NOT THE 256 KB THIS COMMENT USED TO CLAIM, and the
 * `.slice` is why the claim went unnoticed: `"builder step\n"` is 13 bytes and
 * 13 × 19,000 = 247,000, so slicing at 262,144 is a no-op on a string that never
 * reaches it. The number matters because `code-browser.tsx` reports the size of
 * what ARRIVED rather than a copy of the server's constant — measured on screen
 * as `Showing the first 241 KB of 11.8 MB` — so the sentence under test is a
 * fact about this string. `code-browser.browser.spec.ts` now derives its
 * expectation from this constant instead of naming a literal, which means the
 * repeat count above can change freely and only this comment has to keep up.
 */
const TRUNCATED_TEXT = "builder step\n".repeat(19_000);

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
