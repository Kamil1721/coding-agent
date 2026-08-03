/**
 * build-segment.ts — the build phase is two calls against one session, and this
 * is the pure half of that.
 *
 * WHY TWO CALLS AND NOT ONE. Spec §17 wants the run to PARK between the design
 * and the build so an owner can pick a mockup, and `awaiting_input` +
 * `POST /api/runs/:id/resume` is the mechanism the spec names ("No new
 * machinery", §17.1). A parked run is a run whose query has ended.
 *
 * WHY IT IS NOT THE LANE-PER-QUERY MODEL §6.1 REJECTED. That was rejected because
 * separate sessions produce a null `parent_tool_use_id` at every top level ("zero
 * real edges") and N `session_id` values against a field the resume path depends
 * on. Segment 2 passes segment 1's `session_id` as `resumeSessionId`, so there is
 * ONE session, one id, and every edge inside it is real.
 *
 * WHY THE BOUNDARY IS DETERMINISTIC. Segment 1 runs with `allowedAgents` narrowed
 * to the SPEC and DESIGN lanes, so the `PreToolUse` delegation hook — the slot
 * probe A measured the engine actually asks — denies every BUILD-lane
 * `subagent_type`. Nothing depends on the model choosing to stop.
 *
 * NOTE: the dashboard's `spec` PHASE (freezing the suite) is not the SPEC LANE.
 * Segment 1 carries the lane because `context-manager` "runs this one first; it
 * owns the context the later lanes read". `ApiPhase` gains no `design` member:
 * both segments run inside `build`.
 *
 * PURE ON PURPOSE. Nothing here opens a file, spawns anything or needs a session,
 * which is what makes the node-id collision below testable at all — Task 10 wires
 * these three functions into `orchestrator.ts` and owns everything impure.
 */

import type { GraphSseEvent } from "./api-types.js";

/**
 * THREE SEGMENTS SINCE 2026-08-03, NOT TWO. `design` is stage A (the canvass);
 * `design-expand` is stage B, which runs only after a direction has been chosen.
 * Both still run on the ONE session — `design-expand-resume` passes the same
 * `resumeSessionId`, so the file header's "one session, one id" holds unchanged.
 */
export type BuildSegment =
  | "design"
  | "design-resume"
  | "design-expand"
  | "design-expand-resume"
  | "build"
  | "build-resume";

/**
 * WHICH SEGMENT RUNS NEXT — and the reason this is a function with a test rather
 * than an `if` in the orchestrator.
 *
 * `resuming = row.builderSessionId !== null` (orchestrator.ts:624) is TRUE in
 * four different situations that need three different prompts: a fresh run, a
 * design segment interrupted by a rate limit, a design segment finished and
 * waiting on the lock, and a build segment interrupted. Reading the session id
 * alone sends `resumeBuilderPrompt("the dashboard was interrupted")` — a prompt
 * that names no locked mockup — and §7.3's prompt-injection mechanism then fails
 * with nothing reporting it. The build still produces a page. It just ignores the
 * design.
 */
export function nextBuildSegment(input: {
  /**
   * `DesignLaneMode` from `design-lane.ts` (Task 4), INLINED rather than
   * imported-or-redeclared. That file belongs to another wave and does not exist
   * yet; exporting a second `DesignLaneMode` from here would be exactly the
   * "second declaration site for a type another task owns" that the manifest task
   * exists to prevent, and would hand the orchestrator two importable symbols of
   * the same name. The union is structurally identical, so the real type passes
   * in unchanged — and if `design-lane.ts` ever grows a fourth member, the call
   * site in `orchestrator.ts` stops compiling, which is where that should surface.
   */
  laneMode: "full" | "degraded" | "off";
  /**
   * Whether `<workspace>/design-refs/manifest.json` parsed.
   *
   * DELIBERATELY NOT READ BY THE BODY, and that is not an oversight: a manifest
   * with no lock is an UNFINISHED design segment, so its existence changes
   * nothing on its own — `manifestLocked` and `designSegmentDone` between them
   * decide. It stays in the signature because the decision "a manifest alone does
   * not mean the lane finished" is the one a future reader is most likely to get
   * wrong, and a test that passes both `true` and `false` and asserts the same
   * answer is how that stays written down.
   */
  manifestExists: boolean;
  manifestLocked: boolean;
  sessionId: string | null;
  /** The design segment returned of its own accord (not cancelled, not rate-limited). */
  designSegmentDone: boolean;
  /**
   * The manifest declares one or more DIRECTIONS — i.e. the lane canvassed.
   *
   * READ, UNLIKE `manifestExists`, and it is read for the opposite reason: a
   * manifest alone says nothing about whether the lane finished, but a manifest
   * with DIRECTIONS and no choice says exactly that the run is between the two
   * stages. `false` is every manifest written before 2026-08-03 and every lane
   * that ignored the canvass ask, and both of those take the pre-2026-08-03
   * branch below verbatim — an agent that does not canvass degrades to today's
   * behaviour rather than hanging.
   */
  directionsOffered: boolean;
  /** A direction has been chosen (owner, `ui-designer` or fallback). READ. */
  directionChosen: boolean;
  /**
   * The EXPAND segment already returned. READ, and it is a separate input rather
   * than `manifestLocked` on purpose.
   *
   * A DEGRADED RUN NEVER LOCKS A STILL — `refs` is empty, `heroRefFor` is null,
   * no lock is applied — so deriving "stage B is over" from `manifestLocked`
   * would send a degraded run back into the expand arm on every pass until the
   * loop bound ran out, and `#buildPhase` would return WITHOUT EVER RUNNING THE
   * BUILD SEGMENT. Degraded runs build fine today; that is the regression this
   * input exists to prevent.
   */
  expanded: boolean;
}): BuildSegment {
  if (input.laneMode === "off") return input.sessionId === null ? "build" : "build-resume";
  // STAGE B COMES FIRST, BEFORE `designFinished` IS EVEN ASKED. On the full path
  // `designSegmentDone` is already true when the choice lands, so a `designFinished`
  // test ahead of this one would answer "yes" and go straight to the build —
  // skipping the expansion entirely and building to two canvass stills.
  if (input.directionsOffered && input.directionChosen && !input.expanded) {
    return input.sessionId === null ? "design-expand" : "design-expand-resume";
  }
  // A CANVASS AWAITING A CHOICE IS NOT A FINISHED DESIGN. Without the second
  // clause a run whose canvass returned would fall through to the build arm the
  // moment anything requeued it, and the owner's choice would decide nothing.
  const designFinished =
    input.manifestLocked || (input.designSegmentDone && !(input.directionsOffered && !input.directionChosen));
  if (!designFinished) return input.sessionId === null ? "design" : "design-resume";
  return input.sessionId === null ? "build" : "build-resume";
}

export interface GraphResumeState {
  readonly rootNode: string | null;
  /** How many node ids the previous segment minted. */
  readonly minted: number;
}

const NODE_ID = /^n(\d+)$/u;

/**
 * What the next segment needs in order not to collide with this one.
 *
 * Derived from the events the orchestrator already sees on the `graph` sink, so
 * nothing new has to be persisted and `graph-emit.ts` is not touched — it belongs
 * to the canvas phase and is another agent's territory.
 *
 * THE HIGH-WATER MARK IS A MAX, NOT A COUNT. Reading `events.length` or counting
 * `graph_agent`s would both under-shoot the moment a stream is replayed with a
 * gap in it, and an under-shot mark is a collision by another name.
 */
export function graphResumeState(events: readonly GraphSseEvent[]): GraphResumeState {
  let rootNode: string | null = null;
  let minted = 0;
  for (const event of events) {
    if (event.type === "graph_inventory") continue;
    const match = NODE_ID.exec(event.node);
    if (match !== null) minted = Math.max(minted, Number.parseInt(match[1] ?? "0", 10));
    if (event.type === "graph_agent" && event.parent === null && rootNode === null) rootNode = event.node;
  }
  return { rootNode, minted };
}

/**
 * Rewrite a resumed segment's node ids so they extend the run's graph instead of
 * overwriting it.
 *
 * THE FAILURE THIS PREVENTS IS SILENT. `GraphProjection` mints from `n1` per
 * BUILD CALL (`graph-emit.ts:182-188`: "ONE INSTANCE PER BUILD. A resumed build
 * gets a fresh one and mints from `n1` again") and `foldGraph` "IGNORES a
 * repeated node id rather than overwriting" (`graph.ts:138-142`). So without
 * this, segment 2's `graph_agent` for `n2` (`nextjs-developer`) is DROPPED and
 * every later `graph_tool{node:"n2"}` from the build attaches to segment 1's `n2`
 * (`taste-frontend-expert`). The canvas renders cleanly and attributes the
 * build's work to the designer.
 *
 * THIS IS THE SAME MERGE `api-types.ts:194-202` FORBIDS, ARRIVING BY ANOTHER
 * ROAD. That docblock rules out keying identity on a raw SDK id because
 * `redactForPersistence` rewrites any 40+ character mixed-case-and-digit token to
 * the IDENTICAL literal `[REDACTED:HIGH_ENTROPY_TOKEN]`, so two agents would come
 * back as one node. Node identity is therefore a short server-assigned `n<k>` —
 * and a per-call counter reset makes `n<k>` collide for exactly the same reason,
 * with exactly the same observable. The fix has to live where the counter resets,
 * which is here, and it must never reach for `sdk.taskId` as a tie-break.
 *
 * The resumed session's ROOT is the exception: it is the same session, so it maps
 * onto the existing root rather than minting a second one.
 *
 * WHICH RESTS ON `parent === null` NAMING EXACTLY ONE NODE PER SEGMENT — read off
 * `graph-emit.ts`, not assumed, because if two parentless agents could arrive in
 * one segment they would BOTH map onto `base.rootNode` and merge, which is this
 * task's own failure by a third road. They cannot: `GraphProjection.rootNode()`
 * (`graph-emit.ts:207-224`) memoises `#root` and pushes the only `parent: null`
 * event once per projection, and every task's parent is `spawned ?? root`
 * (`:277`) — a task whose spawn origin is unknown is parented onto the root with
 * `attribution: "inferred"`, never left parentless. No guard is written here for
 * a second parentless agent because no branch could produce one, and a guard
 * whose branch cannot be reached is a claim with no check behind it. If that
 * emitter ever changes, this is the line that has to change with it.
 *
 * ONE REMAP PER SEGMENT. The mapping is closed over, so the same node id seen
 * twice inside one segment resolves to one id; a THIRD segment builds a fresh
 * remap from `graphResumeState` of the already-remapped stream.
 */
export function makeSegmentRemap(base: GraphResumeState): (event: GraphSseEvent) => GraphSseEvent {
  const mapping = new Map<string, string>();
  let next = base.minted;

  const resolve = (node: string, isRoot: boolean): string => {
    const known = mapping.get(node);
    if (known !== undefined) return known;
    if (isRoot && base.rootNode !== null) {
      mapping.set(node, base.rootNode);
      return base.rootNode;
    }
    next += 1;
    const minted = `n${String(next)}`;
    mapping.set(node, minted);
    return minted;
  };

  return (event: GraphSseEvent): GraphSseEvent => {
    if (event.type === "graph_inventory") return event;
    if (event.type === "graph_agent") {
      const node = resolve(event.node, event.parent === null);
      const parent = event.parent === null ? null : resolve(event.parent, false);
      return { ...event, node, parent };
    }
    return { ...event, node: resolve(event.node, false) };
  };
}
