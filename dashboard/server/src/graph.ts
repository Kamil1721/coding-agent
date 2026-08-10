/**
 * graph.ts — `foldGraph`, the ONE reducer behind both the live canvas and the
 * replay of a finished run.
 *
 * WHY IT TAKES THE WHOLE `SseEvent` UNION AND NOT A `graph_*` SUB-UNION. Both
 * real inputs are full event streams — `store.eventsSince(runId, 0)` on the
 * server and the SSE tail in the browser — and the requirement that makes this
 * phase worth doing at all ("an agent must not show running inside a cancelled
 * run", spec §9.1) is only expressible if the fold SEES the `status` event. A
 * sub-union would have forced a filter at every call site and lost the one
 * ordering guarantee `seq` was giving away for free.
 *
 * FOUR RULES, AND EACH ONE IS A CHECK RATHER THAN A COMMENT — see graph.test.ts,
 * where each is proven by the mutation that turns it red.
 *
 * 1. IT KEYS ON `node` AND ON NOTHING ELSE. Never `sdk.taskId`, never
 *    `sdk.toolUseId`. `redactForPersistence` rewrites any 40+ character
 *    mixed-case-and-digit token to the IDENTICAL literal
 *    `[REDACTED:HIGH_ENTROPY_TOKEN]`, and `task_id` has no documented length
 *    bound — so two distinct agents come back from the events table carrying the
 *    same string, and a fold keyed on it MERGES THEM INTO ONE NODE while the
 *    canvas still renders and every test that uses short fixture ids stays green.
 *    That is why node ids are minted `n1`, `n2`, … on this side.
 *
 * 2. AN EVENT NAMING AN UNKNOWN NODE IS DROPPED. The invariant is that a node id
 *    is never referenced before its `graph_agent`; dropping is what makes the
 *    invariant CHECKED instead of assumed. Creating the node on demand would
 *    fabricate an agent out of a pill.
 *
 * 3. AN UNRECOGNISED EVENT RETURNS THE SAME STATE OBJECT. Every run before this
 *    phase is a stream of `log`/`tool`/`status` rows and nothing else, and it
 *    must fold to an empty canvas without a feature flag and without throwing.
 *    Returning the SAME object (not a copy) is also what keeps the client mirror
 *    from re-rendering on every log line, matching `applyRunEvent`'s contract.
 *
 * 4. A TERMINAL `status` RESOLVES A STILL-RUNNING NODE TO `unresolved`, NEVER TO
 *    `failed`. A cancelled run's in-flight agents did not fail. This codebase
 *    refuses that conflation everywhere else — `heldOutPass: null` is not
 *    `false` — and a canvas that renders a red X for "we stopped watching" is
 *    the same lie in pixels.
 *
 * PURE, TOTAL, AND IN ITS OWN FILE so it is EXECUTED by tests rather than
 * reviewed inside a route handler that only a live server reaches. That is the
 * lesson `build-environment.ts` and `build-context.ts` were written from.
 */

/*
 * `import type`, AND IT MUST STAY THAT WAY. The browser reaches this module through
 * `src/lib/graph.ts`, and a type-only import is erased before Turbopack resolves
 * anything. Import a VALUE from `./api-types.js` here and the run page 500s with
 * `Module not found: Can't resolve './api-types.js'` while `tsc` stays green —
 * observed on 2026-07-30, and the reason `ACTIVITY_CAP` is declared below rather
 * than beside the interface it caps.
 */
import type {
  ApiPhase,
  GraphActivityEntry,
  GraphDiff,
  GraphDiffHunk,
  GraphEdge,
  GraphHookPill,
  GraphNode,
  GraphSkillPill,
  GraphStage,
  GraphStageId,
  GraphStageState,
  GraphState,
  GraphToolPill,
  SseEvent,
  SseWireEvent,
} from "./api-types.js";

/**
 * How many DISTINCT pill names one node keeps.
 *
 * The call COUNTS are exact and unbounded (`toolCalls` on the node); only the
 * per-name breakdown is capped. A build that reaches 64 distinct tool names has
 * already told the reader everything the 65th would, and an uncapped map on a
 * node that ran for four hours is a memory leak in a browser tab.
 *
 * Chosen against the measured surface: a run with every MCP server connected
 * enumerated 620 tools, of which 589 were `mcp__*` — so the cap binds only on
 * exactly the runs where the list had stopped being readable anyway.
 */
export const PILL_KINDS_CAP = 64;

/**
 * How many ordered activity entries one node keeps.
 *
 * NOT A DISPLAY LIMIT — a wire-size one. `RunGraphResponse` is already 7.01 MB on a
 * 32,000-row run, and `activity` is the first field on `GraphNode` that grows with
 * the LENGTH of a run rather than with its number of distinct names. The busiest
 * node of the one real run recorded 109 calls, so this holds a run several times
 * that size whole; past it `activityDropped` says how much is missing rather than
 * the list quietly ending.
 *
 * Declared here beside `PILL_KINDS_CAP` and not in `api-types.ts` — see the import
 * note above; a runtime export from that file breaks the browser bundle.
 */
export const ACTIVITY_CAP = 400;

/** How much of a tool's summary one activity entry keeps. */
export const ACTIVITY_DETAIL_CHARS = 220;

/**
 * How much of ONE TURN of assistant prose an activity entry keeps.
 *
 * MEASURED, NOT PICKED. 1,539 assistant turns carrying visible prose in the local
 * transcript corpus: p50 143 characters, p75 368, p90 2,265, p95 2,961, max
 * 8,017. The distribution is bimodal — short "I'll do X next" lines and long
 * closing reports — so a cap chosen anywhere in the middle either keeps a turn
 * whole or keeps its opening paragraph. 1,200 keeps 82.6% of turns whole
 * (17.4% exceed it) and the rest keep their first paragraph or two.
 *
 * WHY NOT THE 500 THE BUILDER ALREADY USES. `claude-builder.ts:1455` truncates to
 * 500, and 22.2% of turns exceed that; five of the 217 `log` rows in the live
 * `runs.db` sit exactly at the boundary, i.e. cut. Going 500 -> 1,200 rescues
 * only ~5% more turns entirely, but it is the difference between a paragraph and
 * a fragment on the turns that carry the reasoning the owner asked to see.
 *
 * THE WIRE ARITHMETIC, BECAUSE THIS IS A WIRE BUDGET AND NOT A DISPLAY ONE.
 * `RunGraphResponse` is already 7.01 MB on a 32,000-row run. {@link ACTIVITY_CAP}
 * bounds one node at 400 entries, so narration bounds a node at ~480 KB and only
 * if every one of those 400 entries is a maximal narration turn, which no
 * measured run comes near.
 */
export const NARRATION_CHARS = 1200;

/**
 * THE DIFF BUDGET — four numbers, because a diff can be too big in four ways.
 *
 * THE CASE THAT FORCES THEM: `Write` of a 3,000-line file produces ONE hunk whose
 * `lines` is the entire file. There is nothing pathological about it — it is what
 * creating a page looks like — and unbudgeted it puts the whole file on the event
 * stream, into the events table, and into every future replay of that run.
 *
 * WORST CASE PER DIFF is `DIFF_MAX_LINES × DIFF_LINE_CHARS` ≈ 12.8 KB, against a
 * typical `Edit` of one or two hunks and twenty-odd lines. `DIFF_BODIES_CAP` then
 * bounds a NODE: past 40 diffs with bodies, later edits keep their counts and
 * lose their lines, which holds a node at ~512 KB rather than at
 * `ACTIVITY_CAP × 12.8 KB` ≈ 5 MB. The counts stay exact throughout — see
 * {@link GraphDiff} — so a capped node still reports how much changed, and
 * `capped` says that what is drawn is not all of it.
 *
 * EVERY ONE OF THESE IS ENFORCED IN THE FOLD, not at the emitter. The fold is the
 * one place both a live socket frame and a row replayed out of SQLite pass
 * through, so a row written by an emitter that has no cap — an older build, a
 * future one, a bug — is capped on the way to the canvas anyway.
 */
export const DIFF_MAX_HUNKS = 12;
export const DIFF_MAX_LINES = 80;
export const DIFF_LINE_CHARS = 160;
export const DIFF_BODIES_CAP = 40;

/**
 * Absolute host paths, rewritten to `~`.
 *
 * THE ONE ITEM WHERE A WRONG ANSWER LEAKS THE OWNER'S HOME DIRECTORY, so it is
 * established by reading `bakeoff/src/redact.ts` rather than by trusting a name.
 * `db.ts:1011` runs every persisted event through `redactForPersistence`, which
 * is `redactDeep` -> `walk`: it DOES recurse arrays and nested objects, so diff
 * hunk lines are covered — but every rule in `CREDENTIAL_RULES` is a CREDENTIAL
 * rule. There is no path rule. `/Users/<name>/Projects/...` matches nothing and
 * is persisted, served and rendered verbatim.
 *
 * SO THE SCRUB LIVES HERE, IN THE FOLD, and that placement is the point: the fold
 * is the only code both the live tail and the durable snapshot pass through, so
 * one call covers a socket frame and a two-month-old row equally. It is EXPORTED
 * so the emitter (wave 3) can apply the same function at capture time and keep
 * the durable row clean as well — this side cannot reach the persistence
 * chokepoint, so until that lands the row in SQLite may still contain a host path
 * that the browser never sees.
 *
 * IT REWRITES THE HOME PREFIX AND NOTHING ELSE. `/Users/kamil/Projects/x` becomes
 * `~/Projects/x`, so the path stays readable and stays a path. A blanket
 * `[REDACTED]` would make every diff card unattributable, and a container's
 * `/root` or `/workspace` is not anybody's identity and is left alone.
 */
const HOST_HOME_RE =
  /(?:\/(?:Users|home)\/[^/\s"'`:;,)\]}]+|[A-Za-z]:\\Users\\[^\\\s"'`;,)\]}]+)/g;

export function scrubHostPaths(text: string): string {
  return text.replace(HOST_HOME_RE, "~");
}

/** An empty canvas. What every run before this phase folds to. */
export function emptyGraph(): GraphState {
  return { nodes: [], edges: [], inventory: null };
}

/**
 * Find a node's index.
 *
 * The last node is checked first because events arrive in bursts for whichever
 * agent is currently talking, which turns the common case into one comparison.
 * The fallback is a linear scan: `nodes` is ordered by FIRST SIGHTING, which is
 * also the sticky row order the layout depends on (spec §9.3), so it cannot be
 * replaced by a hash map without losing that ordering from the wire shape.
 */
function indexOfNode(nodes: readonly GraphNode[], id: string): number {
  const last = nodes.length - 1;
  if (last >= 0 && nodes[last]?.id === id) return last;
  for (let i = last - 1; i >= 0; i -= 1) {
    if (nodes[i]?.id === id) return i;
  }
  return -1;
}

/** Replace one node, leaving the array's order — the sticky rows — untouched. */
function withNode(
  state: GraphState,
  index: number,
  node: GraphNode,
): GraphState {
  const nodes = [...state.nodes];
  nodes[index] = node;
  return { ...state, nodes };
}

/**
 * Add one to a counted pill, or append it.
 *
 * Over the cap the COUNT of an existing pill still rises — only a NEW name is
 * refused. Dropping updates to known names as well would freeze the display of a
 * long run at whatever it looked like when the 64th name appeared.
 */
function bump<T extends { readonly count: number }>(
  pills: readonly T[],
  match: (pill: T) => boolean,
  make: () => T,
): readonly T[] {
  const index = pills.findIndex(match);
  if (index >= 0) {
    const existing = pills[index];
    if (existing === undefined) return pills;
    const next = [...pills];
    next[index] = { ...existing, count: existing.count + 1 };
    return next;
  }
  if (pills.length >= PILL_KINDS_CAP) return pills;
  return [...pills, make()];
}

/**
 * Append one ordered activity entry, respecting the cap.
 *
 * OVER THE CAP THE COUNTER RISES AND THE LIST DOES NOT — the same shape as
 * `toolCalls` vs `tools`, and for the same reason: a list that silently stops
 * growing reads as "this is everything it did".
 */
function record(
  node: GraphNode,
  entry: GraphActivityEntry,
): Pick<GraphNode, "activity" | "activityDropped"> {
  if (node.activity.length >= ACTIVITY_CAP) {
    return { activity: node.activity, activityDropped: node.activityDropped + 1 };
  }
  return {
    activity: [...node.activity, entry],
    activityDropped: node.activityDropped,
  };
}

/**
 * Cut a summary to the wire budget, and say so when it was cut.
 *
 * THE BUDGET IS A PARAMETER BECAUSE NARRATION IS NOT A TOOL SUMMARY. This was
 * hardcoded to {@link ACTIVITY_DETAIL_CHARS}, and 220 characters of prose is a
 * sentence fragment — a narration entry routed through the shared `record` path
 * would have been silently cut to a fifth of {@link NARRATION_CHARS} with the
 * measurement behind that number never reaching the wire.
 */
function clip(
  detail: string,
  budget: number = ACTIVITY_DETAIL_CHARS,
): { detail: string; truncated: boolean } {
  if (detail.length <= budget) {
    return { detail, truncated: false };
  }
  return { detail: detail.slice(0, budget), truncated: true };
}

/** A count off an unvalidated row: finite, non-negative, whole. Never throws. */
function count(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : Math.floor(value);
}

/**
 * The hunks of an event, as a list this fold can walk.
 *
 * THE SERVER'S ROWS ARE NOT VALIDATED ON THE WAY IN. `http.ts` reads them as
 * `JSON.parse(payload) as SseEvent` — an unchecked assertion over rows written by
 * every previous version of this program — so `hunks` may be absent, null, or a
 * string. The browser's `parseRunEvent` rebuilds each field and would have
 * refused it; the snapshot path has no such gate, and this fold must not throw on
 * either. See the file header: pure, total, and never throwing is the contract.
 */
function hunksOf(value: unknown): readonly GraphDiffHunk[] {
  return Array.isArray(value) ? (value as readonly GraphDiffHunk[]) : [];
}

/**
 * Apply the diff budget, and report exactly what was withheld.
 *
 * THE CAPS ARE ADDED TO WHAT THE EMITTER ALREADY DROPPED, never replaced by it.
 * An emitter that has already cut a 3,000-line patch reports its own
 * `droppedLines`; this pass may cut more, and a reader must be able to read one
 * number for "how much of this change is not on screen". Two independent counters
 * would make the sum a thing the UI has to remember to do.
 *
 * `bodies` IS THE NODE'S RUNNING TOTAL of diffs that still have lines. Past
 * {@link DIFF_BODIES_CAP} the counts survive and the body does not, which is the
 * same shape as `toolCalls` vs `tools`: the tally stays exact while the detail
 * stops growing.
 */
function capDiff(
  event: Extract<SseEvent, { readonly type: "graph_diff" }>,
  bodies: number,
): GraphDiff {
  const source = hunksOf(event.hunks);
  const hunks: GraphDiffHunk[] = [];
  let droppedHunks = 0;
  let droppedLines = 0;
  let shortened = false;
  let budget = bodies >= DIFF_BODIES_CAP ? 0 : DIFF_MAX_LINES;

  for (const hunk of source) {
    // A NULL ENTRY IS SKIPPED BEFORE ANYTHING IS READ OFF IT. `hunksOf` proves
    // the LIST is a list and stops there; `hunk?.lines` alone was optional
    // chaining on the read and a bare `hunk.oldStart` two lines later, so a row
    // carrying `hunks: [null]` threw a TypeError inside a function whose file
    // header promises total and never-throwing. The snapshot route reads rows as
    // an unchecked `JSON.parse(...) as SseEvent`, so the only thing between a
    // malformed row and a 500 on `GET /api/runs/:id/graph` is this line.
    if (hunk === null || typeof hunk !== "object") continue;
    const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
    if (hunks.length >= DIFF_MAX_HUNKS || budget <= 0) {
      droppedHunks += 1;
      droppedLines += lines.length;
      continue;
    }
    const kept = lines.slice(0, budget);
    droppedLines += lines.length - kept.length;
    budget -= kept.length;
    hunks.push({
      oldStart: count(hunk.oldStart),
      oldLines: count(hunk.oldLines),
      newStart: count(hunk.newStart),
      newLines: count(hunk.newLines),
      lines: kept.map((line) => {
        const safe = scrubHostPaths(typeof line === "string" ? line : "");
        if (safe.length <= DIFF_LINE_CHARS) return safe;
        shortened = true;
        return safe.slice(0, DIFF_LINE_CHARS);
      }),
    });
  }

  return {
    path: scrubHostPaths(event.path),
    change: event.change === "added" ? "added" : "modified",
    additions: count(event.additions),
    deletions: count(event.deletions),
    hunks,
    // `capped` is not `droppedLines > 0`: one 40,000-character minified line is a
    // whole diff cut in half with nothing missing from the line COUNT.
    capped:
      event.capped === true ||
      shortened ||
      droppedHunks + count(event.droppedHunks) > 0 ||
      droppedLines + count(event.droppedLines) > 0,
    droppedHunks: droppedHunks + count(event.droppedHunks),
    droppedLines: droppedLines + count(event.droppedLines),
  };
}

/** How many of this node's diffs still carry lines — the {@link DIFF_BODIES_CAP} tally. */
function diffBodies(node: GraphNode): number {
  let bodies = 0;
  for (const entry of node.activity) {
    if (entry.diff !== undefined && entry.diff.hunks.length > 0) bodies += 1;
  }
  return bodies;
}

/**
 * The instant an event was recorded, or null when it carries none.
 *
 * WHY IT IS SNIFFED RATHER THAN A REQUIRED PARAMETER. Both real callers hand this
 * a {@link SseWireEvent} — the browser gets `at` from the SSE frame, the server's
 * snapshot route gets it from the `events` row — while the tests fold bare
 * `SseEvent` literals. A required third argument would have meant editing forty
 * fixtures to pass a value none of them assert on, and an OPTIONAL one is this
 * repository's best-documented defect shape: a parameter the production path
 * forgets to pass while every test still passes (`auditSuite` never passing its
 * own `ticketBrief`).
 *
 * So the type carries it instead of the signature, and the guard against the
 * production path losing it is an executed check on the REAL fold, not a comment:
 * `graph.test.ts` asserts a wire event folds to a non-null `at`, and
 * `http.ts`'s snapshot is asserted to produce timed entries for the recorded run.
 */
function instantOf(event: SseEvent | SseWireEvent): string | null {
  return "at" in event && typeof event.at === "string" ? event.at : null;
}

/* =========================================================================
 * THE PRE-BUILD LANE
 *
 * WHAT MOVED, AND WHAT DELIBERATELY DID NOT. `dashboard/src/lib/spec-pipeline.ts`
 * has computed these stages since they existed, from the live `trace` sink. Its
 * reasoning is right and is reproduced below; its LOCATION was the defect. The
 * trace comes from the SSE socket, `use-run-stream.ts:820-822` never opens one for
 * a terminal run, and `spec-pipeline.ts:246` returns `[]` the moment the phase
 * leaves `spec` — so the lane was blank on every finished run and deleted itself
 * at the build boundary. Computing it here makes it a property of the fold, which
 * both the durable snapshot and the live tail already share.
 *
 * NOTHING HERE IS A TIMER, AND THAT IS THE RULE THE WHOLE DISPLAY RESTS ON. A
 * stage is `running` only once the run has SAID it started and `done` only once
 * the run has SAID it finished. The tempting version — start a stage after N
 * seconds, advance it on a clock — is this repository's signature defect with a
 * progress bar on it: a display reporting work it never observed.
 *
 * THE PHRASES ARE MATCHED LOOSELY, ON PURPOSE. They are prose log lines, not a
 * contract. An anchored parse would stop recognising a stage the day somebody
 * rewords a sentence, and a stage stuck on `pending` forever is exactly the "looks
 * hung" defect this exists to remove. The cost is a false positive if wording ever
 * collides, which is the cheaper direction.
 *
 * ONE THING IS LOST BY MOVING IT, AND IT IS LOST HONESTLY. `specPipelineFrom`
 * takes the TICKET TEXT and lights `capture` as `running` when the ticket contains
 * a URL. The fold is given one event at a time and never sees the ticket, and
 * widening `foldGraph`'s signature would change both call sites in two packages.
 * So `capture` stays `pending` until the server says `captured …` or
 * `no reference capture` — strictly less claim than before, and the direction the
 * rule above requires when in doubt.
 *
 * THE COPY IS DUPLICATED IN `spec-pipeline.ts` UNTIL THE RENDERER MOVES. Two live
 * copies of these regexes is a real cost and it is temporary by design: this one
 * feeds the canvas, that one still feeds the old overlay. Deduplicating across the
 * package boundary is impossible (`dashboard/src` cannot import
 * `dashboard/server`'s runtime values without the Turbopack failure documented at
 * the top of this file), so the resolution is deletion, not extraction.
 * ====================================================================== */

const CAPTURED = /^captured https?:\/\//i;
const AUTHORING = /authoring the held-out acceptance suite/i;
const SPEC_TOKENS = /^spec seat —/i;
const AUDIT_TOKENS = /^audit seat —/i;
const SEALED = /^sealed suite /i;
const REUSED = /^reusing the sealed acceptance suite/i;
/** The ticket named no URL, so nothing was captured and nothing is pending. */
const NO_CAPTURE = /no reference capture/i;
const PLAN_PARKED = /waiting for an answer in the chat/i;
const PLAN_NOTHING = /^plan phase (?:skipped|asked nothing)\s*[:—-]\s*(.+)$/i;
const PLAN_OVER =
  /^the plan dialogue (?:is over|is folded into the brief|ended with nothing to fold)/i;

/** Left to right on the canvas. The orchestrator is always last. */
const STAGE_ORDER: readonly GraphStageId[] = [
  "plan",
  "capture",
  "author",
  "audit",
  "freeze",
  "orchestrator",
];

/** The four the spec phase runs. `plan` precedes them; `orchestrator` follows. */
const SPEC_STAGES: readonly GraphStageId[] = ["capture", "author", "audit", "freeze"];

/*
 * THE STRINGS THE OWNER ACTUALLY READS. Renamed 2026-08-04 on his instruction:
 * "spec seat audit seat freeze. These dont really mean anything to me. For
 * example PLan means something, orchestrator means something, ui agent etc."
 *
 * So `plan` and `orchestrator` keep their words — they were never the problem —
 * and the four seat names become what the seat DOES. "Seat" is this system's own
 * word for a structurally separate model call with its own prompt and no shared
 * history; it is load-bearing in the code and meaningless on a canvas.
 *
 * `audit` is "Attacking the tests" rather than the softer "Checking": the seat
 * exists to find untestable and gameable criteria, and a label that undersells
 * that would misdescribe the one step whose whole value is adversarial.
 *
 * `spec-pipeline.ts` carries an identical vocabulary and renders none of it —
 * see the note there. Two vocabularies for one pipeline is how the dead one gets
 * copied forward, so change both together or neither.
 */
const STAGE_LABEL: Readonly<Record<GraphStageId, string>> = {
  plan: "Plan",
  capture: "Reading the reference page",
  author: "Writing the tests",
  audit: "Attacking the tests",
  freeze: "Sealing the tests",
  orchestrator: "Orchestrator",
};

const PLAN_RUNNING =
  "Reading the ticket and anything attached to it, and working out what it cannot infer. " +
  "It reports when it has something to ask.";
const PLAN_PARKED_DETAIL =
  "Waiting for an answer in the run panel. The window closes on its own, and the run then " +
  "proceeds on what it had to assume.";
// "the sealed suite" was the last piece of vocabulary the rename missed, and the
// copy test caught it rather than the owner. It says the same thing in his words.
const ORCHESTRATOR_PENDING =
  "Waits until the tests are locked, then spawns the agents that do the work.";
const ORCHESTRATOR_RUNNING = "Running the build. Every agent it spawned is on this canvas.";
const ORCHESTRATOR_DONE = "The build phase is over.";

/** The forward-looking sentence a stage shows before it has said anything. */
const STAGE_PENDING: Readonly<Record<GraphStageId, string>> = {
  plan: PLAN_RUNNING,
  // NOT "loading the page": the fold cannot see the ticket, so it does not know
  // whether there is a page. See the header note on what moving this cost.
  //
  // SHORTENED 2026-08-04 ("reduce the amount of text"). "Suite" and "digest"
  // are gone as words, not as guarantees — the freeze line still states the
  // property that matters, which is that the builder cannot read the tests.
  capture: "Waiting to see whether your ticket named a page.",
  author: "Starts once the reference is done.",
  audit: "Tries to break the tests, and reports only at the end.",
  freeze: "Locks the tests so the builder can never read them.",
  orchestrator: ORCHESTRATOR_PENDING,
};

function stageOf(state: GraphState, id: GraphStageId): GraphStage | undefined {
  return state.stages?.find((stage) => stage.id === id);
}

/** True once this stream has said anything at all about a pre-build lane. */
function hasPipeline(state: GraphState): boolean {
  return state.stages !== undefined && state.stages.length > 0;
}

/**
 * Insert or replace one stage, keeping {@link STAGE_ORDER}.
 *
 * RETURNS THE SAME STATE OBJECT WHEN NOTHING CHANGED, like every other path in
 * this file — a `log` row that re-states a stage the fold already knows must not
 * re-render the client canvas.
 */
function putStage(state: GraphState, stage: GraphStage): GraphState {
  const stages = state.stages ?? [];
  const index = stages.findIndex((entry) => entry.id === stage.id);
  if (index >= 0) {
    const existing = stages[index];
    if (
      existing !== undefined &&
      existing.state === stage.state &&
      existing.detail === stage.detail &&
      existing.label === stage.label &&
      existing.at === stage.at
    ) {
      return state;
    }
    const next = [...stages];
    next[index] = stage;
    return { ...state, stages: next };
  }
  const rank = STAGE_ORDER.indexOf(stage.id);
  const next = [...stages];
  const before = next.findIndex((entry) => STAGE_ORDER.indexOf(entry.id) > rank);
  next.splice(before < 0 ? next.length : before, 0, stage);
  return { ...state, stages: next };
}

/** A stage in its untouched, forward-looking form. */
function pendingStage(id: GraphStageId): GraphStage {
  return {
    id,
    label: STAGE_LABEL[id],
    detail: STAGE_PENDING[id],
    state: "pending",
    at: null,
  };
}

function settleStage(
  state: GraphState,
  id: GraphStageId,
  next: GraphStageState,
  detail: string,
  at: string | null,
  label: string = STAGE_LABEL[id],
): GraphState {
  // FIRST MENTION WINS, which is what `specPipelineFrom` did by scanning for the
  // FIRST matching line. A stage that has already reported an outcome is not
  // re-dated by a later line that says the same thing.
  const existing = stageOf(state, id);
  if (existing !== undefined && existing.state === next && next !== "running") return state;
  return putStage(state, { id, label, detail, state: next, at });
}

/** Add the stage if this stream has never mentioned it; never overwrite. */
function ensureStage(state: GraphState, id: GraphStageId): GraphState {
  return stageOf(state, id) === undefined ? putStage(state, pendingStage(id)) : state;
}

/**
 * A stage the run has moved past while it still read `running`.
 *
 * `unresolved`, NEVER `failed` AND NEVER `pending`. It is rule 4 of this file,
 * applied to the lane instead of to a node: the run stopped telling us about this
 * stage, which is not the same as the stage failing, and on a run that is over
 * `pending` would read as "still to come".
 */
function unresolveStages(state: GraphState, ids: readonly GraphStageId[], detail?: string): GraphState {
  let next = state;
  for (const id of ids) {
    const stage = stageOf(next, id);
    if (stage === undefined || stage.state !== "running") continue;
    next = putStage(next, {
      ...stage,
      state: "unresolved",
      ...(detail === undefined ? {} : { detail }),
    });
  }
  return next;
}

/**
 * What a stage still reading `running` says after the run FAILED.
 *
 * ─── THE COPY WAS FALSE ON EXACTLY THE RUNS THAT NEEDED IT ───
 *
 * `unresolved` keeps its name, because `failed` would be a claim no message made:
 * nothing said THIS stage broke, only that the run stopped. But the detail line
 * was the stage's last `running` sentence, and the client's static tooltip for
 * `unresolved` reads *"The run moved on while this was still working, and never
 * said how it ended. Not a failure. Nobody was watching by then."*
 *
 * On `run-2026-08-09T21-04-00-713Z-a913c871` the stage still reading `running`
 * when the run died was AUTHOR — "Writing the tests" — and the run died BECAUSE
 * authoring could not produce a suite the audit would accept. So the display told
 * the owner "not a failure, nobody was watching" about the precise thing that had
 * just failed, with the reason recorded three rows later on the same stream.
 *
 * WHAT THIS SENTENCE MAY AND MAY NOT SAY. It may say the run ended in failure
 * while this stage was open, and where the reason is — both are facts the
 * terminal event itself carries. It may NOT say this stage caused it: a run can
 * fail elsewhere while a stage is legitimately mid-flight, and naming a culprit
 * the stream never named is the same defect in the other direction.
 *
 * ONLY `failed` GETS IT. A cancel is the owner's own doing and the old wording is
 * true of it; a pass with a stage left open is a genuine "nobody was watching".
 */
const STAGE_STOPPED_BY_FAILURE =
  "The run failed while this was still working. Nothing said this step was the cause — the failure " +
  "and its reason are on the run's own log, at the end.";

/**
 * The spec phase's four stages, unless the suite was reused.
 *
 * A REUSED SUITE IS NOT A PIPELINE. The ticket's text already had a sealed suite,
 * so nothing is authored and nothing is audited; three stages that could never
 * move would invent work that is not happening. `freeze` already reading `done`
 * before the skeleton is built can only mean the reuse line landed first, which is
 * the one thing that closes the lane before it opens.
 */
function ensureSpecStages(state: GraphState): GraphState {
  if (stageOf(state, "freeze")?.state === "done") return state;
  let next = state;
  for (const id of SPEC_STAGES) next = ensureStage(next, id);
  return next;
}

function dropStages(state: GraphState, ids: readonly GraphStageId[]): GraphState {
  const stages = state.stages;
  if (stages === undefined) return state;
  const next = stages.filter((stage) => !ids.includes(stage.id));
  return next.length === stages.length ? state : { ...state, stages: next };
}

/**
 * The lane, as far as one PHASE row moves it.
 *
 * A STREAM THAT OPENS AT `build` GETS NO LANE AT ALL, and that is deliberate
 * rather than incidental. Every run recorded before the phases existed is a stream
 * of `log`/`tool`/`status` rows plus, at most, `phase: build` — the same runs rule
 * 3 of this file requires to fold to an empty canvas with no feature flag. A lane
 * drawn for them would be five stages asserting a pre-build pipeline that nothing
 * in the stream ever mentioned.
 */
function foldPhaseStages(state: GraphState, phase: ApiPhase, at: string | null): GraphState {
  if (phase === "plan") {
    const plan = stageOf(state, "plan");
    const next =
      plan === undefined
        ? putStage(state, {
            id: "plan",
            label: STAGE_LABEL.plan,
            detail: PLAN_RUNNING,
            state: "running",
            at,
          })
        : state;
    return ensureStage(next, "orchestrator");
  }
  if (phase === "spec") {
    // The plan phase is over. If its own closing line never landed, nothing said
    // how it ended — which is precisely what `unresolved` is for.
    const next = ensureSpecStages(unresolveStages(state, ["plan"]));
    return ensureStage(next, "orchestrator");
  }
  if (!hasPipeline(state)) return state;
  const settled = unresolveStages(state, SPEC_STAGES);
  const orchestrator = stageOf(settled, "orchestrator");
  if (orchestrator === undefined) return settled;
  if (phase === "build") {
    return orchestrator.state === "running"
      ? settled
      : putStage(settled, {
          ...orchestrator,
          state: "running",
          detail: ORCHESTRATOR_RUNNING,
          at,
        });
  }
  // `gate`, `judge`, `done`: the run SAID it left the build, which is a recorded
  // fact about the orchestrator. A terminal `status` is not — it is a statement
  // about the run — so the orchestrator is never closed from one.
  return orchestrator.state === "done"
    ? settled
    : putStage(settled, { ...orchestrator, state: "done", detail: ORCHESTRATOR_DONE, at });
}

/**
 * The lane, as far as one LOG row moves it.
 *
 * ONLY A RECOGNISED SENTENCE STARTS THE LANE. An unmatched line returns the same
 * state object, so a 32,000-row build is 32,000 regex tests against a state that
 * never changes and a client that never re-renders.
 */
function foldLogStages(state: GraphState, text: string, at: string | null): GraphState {
  let next = state;
  if (REUSED.test(text)) {
    // The three stages that will now never happen are REMOVED rather than left
    // grey. Pending rows for work nobody is doing are the same lie as a running
    // one, drawn in a quieter colour.
    next = dropStages(next, ["capture", "author", "audit"]);
    next = settleStage(next, "freeze", "done", text, at, "Tests reused");
  } else if (CAPTURED.test(text)) {
    next = settleStage(next, "capture", "done", text, at);
  } else if (NO_CAPTURE.test(text)) {
    next = settleStage(next, "capture", "skipped", "No URL in the ticket, so nothing was captured.", at);
  } else if (SPEC_TOKENS.test(text)) {
    next = settleStage(next, "author", "done", text, at);
  } else if (AUDIT_TOKENS.test(text)) {
    next = settleStage(next, "audit", "done", text, at);
  } else if (SEALED.test(text)) {
    next = settleStage(next, "freeze", "done", text, at);
  } else if (AUTHORING.test(text)) {
    // `running` only while nothing has closed it: the seat's token line is the
    // close, and on a replay both lines are already in the stream.
    next =
      stageOf(next, "author")?.state === "done"
        ? next
        : settleStage(
            next,
            "author",
            "running",
            "Writing the tests from your ticket, before any code exists.",
            at,
          );
  } else if (PLAN_OVER.test(text)) {
    next = settleStage(next, "plan", "done", text, at);
  } else if (PLAN_PARKED.test(text)) {
    next =
      stageOf(next, "plan")?.state === "done"
        ? next
        : settleStage(next, "plan", "running", PLAN_PARKED_DETAIL, at);
  } else {
    const asked = PLAN_NOTHING.exec(text);
    if (asked === null) return state;
    /*
     * `PLAN_OVER` WINS OVER `PLAN_NOTHING`, WHICH IS WHAT `specPipelineFrom` DID
     * BY CHECKING `over` FIRST REGARDLESS OF ARRIVAL ORDER. A fold is last-writer-
     * wins by default, so without this a run emitting both would render `skipped`
     * where the old panel rendered `done`.
     *
     * READING THE MECHANISM: it cannot happen today. Both `plan phase skipped:`
     * sites (`orchestrator.ts:2037`, `:2059`) and `plan phase asked nothing —`
     * (`:2079`) `return { kind: "proceed" }` immediately and never reach
     * `#foldPlan`, which is the only writer of the three `the plan dialogue …`
     * sentences. The guard is here anyway because the exclusivity lives in a
     * control-flow argument in another file, and this one would go on rendering.
     */
    next =
      stageOf(next, "plan")?.state === "done"
        ? next
        : settleStage(next, "plan", "skipped", asked[1] ?? text, at);
  }
  return next === state ? state : ensureStage(next, "orchestrator");
}

/**
 * Fold one event into the canvas.
 *
 * Returns the SAME object when nothing changed. Never throws: this runs over
 * rows written by every previous version of this program.
 *
 * Accepts a bare `SseEvent` or an {@link SseWireEvent}; the latter is what both
 * production callers pass, and is what puts a time on the ordered activity.
 */
export function foldGraph(
  state: GraphState,
  event: SseEvent | SseWireEvent,
): GraphState {
  switch (event.type) {
    case "graph_agent": {
      // A repeat of a node id is IGNORED rather than merged. Two `graph_agent`
      // events for one id can only mean the emitter's counter was reset (a
      // resumed session mints from 1 again), and overwriting would hand the
      // second agent the first one's pills.
      if (indexOfNode(state.nodes, event.node) >= 0) return state;
      const node: GraphNode = {
        id: event.node,
        parent: event.parent,
        agent: event.agent,
        lane: event.lane,
        description: event.description,
        ambient: event.ambient,
        state: "running",
        attribution: event.attribution,
        sdk: event.sdk,
        tools: [],
        skills: [],
        hooks: [],
        toolCalls: 0,
        result: null,
        activity: [],
        activityDropped: 0,
      };
      // The edge is drawn only when the parent is already a node — same
      // invariant, other end. An edge to nothing is not a lighter-weight edge,
      // it is a dangling reference the renderer has to guess about.
      const edges: readonly GraphEdge[] =
        event.parent !== null && indexOfNode(state.nodes, event.parent) >= 0
          ? [
              ...state.edges,
              { from: event.parent, to: event.node, attribution: event.attribution },
            ]
          : state.edges;
      return { ...state, nodes: [...state.nodes, node], edges };
    }

    case "graph_agent_status": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      if (node.state === event.state) return state;
      return withNode(state, index, { ...node, state: event.state });
    }

    case "graph_tool": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const tools = bump<GraphToolPill>(
        node.tools,
        (pill) => pill.name === event.name,
        () => ({ name: event.name, mcpServer: event.mcpServer, count: 1 }),
      );
      // `toolCalls` rises even when the pill did not fit, so a capped node is
      // visibly capped rather than quietly under-reported.
      const clipped = clip(event.summary);
      return withNode(state, index, {
        ...node,
        tools,
        toolCalls: node.toolCalls + 1,
        ...record(node, {
          at: instantOf(event),
          kind: "tool",
          name: event.name,
          detail: clipped.detail,
          truncated: clipped.truncated,
        }),
      });
    }

    case "graph_skill": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const skills = bump<GraphSkillPill>(
        node.skills,
        (pill) => pill.skill === event.skill && pill.source === event.source,
        () => ({ skill: event.skill, source: event.source, count: 1 }),
      );
      return withNode(state, index, {
        ...node,
        skills,
        /*
         * A SKILL LOADING IS A TIMELINE EVENT, not just a pill. On the one real run
         * `imagegen-frontend-web` loading is the moment the design work starts —
         * the thing the owner wants to read first — and a counted pill cannot say
         * when it happened.
         */
        ...record(node, {
          at: instantOf(event),
          kind: "skill",
          name: event.skill,
          detail: event.source,
          truncated: false,
        }),
      });
    }

    case "graph_hook": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const hooks = bump<GraphHookPill>(
        node.hooks,
        (pill) =>
          pill.event === event.event &&
          pill.tool === event.tool &&
          pill.decision === event.decision,
        () => ({ event: event.event, tool: event.tool, decision: event.decision, count: 1 }),
      );
      return withNode(state, index, { ...node, hooks });
    }

    case "graph_result": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      return withNode(state, index, {
        ...node,
        state: event.state,
        result: {
          state: event.state,
          summary: event.summary,
          totalTokens: event.totalTokens,
          toolUses: event.toolUses,
          durationMs: event.durationMs,
        },
      });
    }

    case "graph_narration": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      /*
       * A TURN OF WHITESPACE IS NOT NARRATION. `assistantText` joins the `text`
       * blocks of a turn, and a turn whose only block is a tool call joins to the
       * empty string — folding that in would put a blank row on the timeline for
       * every tool call, next to the row the tool call already has.
       */
      const text = scrubHostPaths(event.text).trim();
      if (text === "") return state;
      const clipped = clip(text, NARRATION_CHARS);
      return withNode(state, index, {
        ...node,
        ...record(node, {
          at: instantOf(event),
          kind: "narration",
          // Deliberately nameless — see `GraphActivityEntry.name`.
          name: "",
          detail: clipped.detail,
          // EITHER CUT COUNTS. The emitter may already have trimmed the turn, and
          // a reader must not have to know which end did it.
          truncated: event.truncated === true || clipped.truncated,
        }),
      });
    }

    case "graph_diff": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const diff = capDiff(event, diffBodies(node));
      // The one-line form, so a renderer that only reads `detail` still says what
      // changed and by how much. The lines are on `diff`.
      const clipped = clip(`+${String(diff.additions)} -${String(diff.deletions)} ${diff.path}`);
      return withNode(state, index, {
        ...node,
        ...record(node, {
          at: instantOf(event),
          kind: "diff",
          name: event.tool,
          detail: clipped.detail,
          truncated: clipped.truncated,
          diff,
        }),
      });
    }

    case "graph_inventory":
      return {
        ...state,
        inventory: {
          agents: event.agents,
          skills: event.skills,
          tools: event.tools,
          allowedAgents: event.allowedAgents,
          mcpServers: event.mcpServers,
          plugins: event.plugins,
          model: event.model,
          claudeCodeVersion: event.claudeCodeVersion,
          environmentHash: event.environmentHash,
        },
      };

    /*
     * THE TWO NON-GRAPH ROWS THE PRE-BUILD LANE IS BUILT FROM.
     *
     * They need no new emission, which is the whole reason the lane works on runs
     * that finished weeks ago: `log` and `phase` rows are already in `events` for
     * every run this program has ever recorded. A new `graph_stage` event would
     * have projected nothing until the first run after it shipped.
     */
    case "phase":
      return foldPhaseStages(state, event.phase, instantOf(event));

    case "log":
      return foldLogStages(state, event.text, instantOf(event));

    case "status": {
      // THE REASON THIS FOLD SEES NON-GRAPH EVENTS AT ALL. A run that was
      // cancelled or that failed leaves agents mid-flight, and their last
      // `graph_agent_status` said `running`. Rendering that forever is the
      // "agent running inside a cancelled run" the total ordering exists to
      // prevent — and calling it `failed` would be a claim no message made.
      if (event.status !== "passed" && event.status !== "failed" && event.status !== "cancelled") {
        return state;
      }
      let touched = false;
      const nodes = state.nodes.map((node) => {
        if (node.state !== "running") return node;
        touched = true;
        return { ...node, state: "unresolved" as const };
      });
      // THE SAME RULE FOR THE LANE. A stage still reading `running` on a run that
      // has stopped did not continue; leaving a pulsing card on a dead run is the
      // lie this display exists to remove, and `failed` is a claim nothing made.
      // The STATE is the same on all three terminals; only the sentence differs,
      // and only for `failed` — see {@link STAGE_STOPPED_BY_FAILURE}.
      const settled = unresolveStages(
        touched ? { ...state, nodes } : state,
        STAGE_ORDER,
        ...(event.status === "failed" ? ([STAGE_STOPPED_BY_FAILURE] as const) : ([] as const)),
      );
      return touched || settled !== state ? settled : state;
    }

    default:
      // Every other member, INCLUDING ONES THAT DO NOT EXIST YET. A run recorded
      // by an older build of this program is a stream of `log` and `tool` rows;
      // throwing here would take the snapshot endpoint down on every historical
      // run, which is precisely the "old runs render an empty canvas with no
      // feature flag" requirement, inverted.
      return state;
  }
}

/**
 * Fold a whole stream. The snapshot's own body, and the fixture's.
 *
 * Takes wire events too, so the snapshot route can pass `{...row.event, at:
 * row.at}` and get a timed activity list out.
 */
export function foldGraphAll(
  events: Iterable<SseEvent | SseWireEvent>,
): GraphState {
  let state = emptyGraph();
  for (const event of events) state = foldGraph(state, event);
  return state;
}
