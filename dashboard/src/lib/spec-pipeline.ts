/**
 * spec-pipeline.ts — the four things that happen before any agent exists.
 *
 * WHY THIS FILE EXISTS. The canvas draws `graph_agent` events, and those come
 * from the BUILDER's SDK projection — which does not exist until the build
 * segment. Measured on the run that passed, that is 79 min 30 s into a
 * 105-minute run. For all of it the canvas was one static box, so a working run
 * and a hung one were pixel-identical.
 *
 * But the spec phase is NOT idle. Four real things happen in it: the site is
 * captured, the spec seat authors the held-out suite, the audit seat attacks it
 * adversarially, and the result is frozen by digest. They have identities and an
 * order. They are simply not agents the builder ever reported.
 *
 * =========================================================================
 * THESE ARE LAYOUT CONSTRUCTS. THEY MUST NEVER BECOME `graph_agent` EVENTS.
 * =========================================================================
 *
 * Every invariant in `graph.ts` is keyed on a `graph_agent` arriving first for
 * its node id, and minting a synthetic id would put a non-agent into a graph
 * whose reducer, edge rules and attribution model all assume otherwise. This is
 * the same decision the folded group already embodies, and the same one
 * `FINDINGS §ITERATION 4` recorded for the proposed result node: a thing the
 * LAYOUT adds from what it can see, never a forged event.
 *
 * =========================================================================
 * EVERY STATE IS READ OFF A REAL LOG LINE. NOTHING HERE IS A TIMER.
 * =========================================================================
 *
 * The temptation is to fake progress — start a stage "running" after N seconds,
 * or advance it on a clock. That would be this repository's signature defect
 * with a progress bar on it: a display that reports success it never observed.
 * A stage is `running` only once the run has SAID it started, and `done` only
 * once the run has SAID it finished. When the server says nothing, the stage
 * says nothing, and the gap is visible rather than papered over.
 *
 * THE HONEST COST, STATED: the server currently emits nothing between
 * "authoring the held-out acceptance suite…" and "sealed suite … frozen". So
 * `audit` cannot be distinguished from `author` today and both sit under the
 * spec seat until the freeze line lands. That is a SERVER gap — the fix is
 * per-stage events from `authorAndFreezeSuite` — and this file reports what it
 * can see rather than guessing the rest.
 */

import type { RunPhase } from "./api-types";
import type { TraceEntry } from "./use-run-stream";

export type SpecStageState = "done" | "running" | "pending" | "skipped";

export interface SpecStage {
  readonly id: "capture" | "author" | "audit" | "freeze";
  readonly label: string;
  /** One line the reader can act on. Empty when the stage has said nothing. */
  readonly detail: string;
  readonly state: SpecStageState;
  /** The server's instant for the line that set this state, or null. */
  readonly atMs: number | null;
}

/**
 * The phrases the server actually writes. Kept together so a wording change on
 * the server is a one-line change here rather than a hunt.
 *
 * MATCHED LOOSELY ON PURPOSE — a substring, not an anchored parse. These are
 * prose log lines, not a contract; a stricter match would silently stop
 * recognising a stage the day someone rewords a sentence, and a stage stuck on
 * `pending` forever is exactly the "looks hung" defect this display exists to
 * remove. The cost is a false positive if the wording ever collides, which is
 * the cheaper direction.
 */
const CAPTURED = /^captured https?:\/\//i;
const AUTHORING = /authoring the held-out acceptance suite/i;
const SPEC_TOKENS = /^spec seat —/i;
const AUDIT_TOKENS = /^audit seat —/i;
const SEALED = /^sealed suite /i;
const REUSED = /^reusing the sealed acceptance suite/i;
/** The ticket named no URL, so nothing was captured and nothing is pending. */
const NO_CAPTURE = /no reference capture/i;

interface Seen {
  readonly captured: TraceEntry | null;
  readonly authoring: TraceEntry | null;
  readonly specDone: TraceEntry | null;
  readonly auditDone: TraceEntry | null;
  readonly sealed: TraceEntry | null;
  readonly reused: TraceEntry | null;
  readonly noCapture: boolean;
  readonly urlInTicket: boolean;
}

function scan(trace: readonly TraceEntry[], ticketText: string): Seen {
  let captured: TraceEntry | null = null;
  let authoring: TraceEntry | null = null;
  let specDone: TraceEntry | null = null;
  let auditDone: TraceEntry | null = null;
  let sealed: TraceEntry | null = null;
  let reused: TraceEntry | null = null;
  let noCapture = false;

  for (const entry of trace) {
    const text = entry.text;
    if (captured === null && CAPTURED.test(text)) captured = entry;
    else if (authoring === null && AUTHORING.test(text)) authoring = entry;
    if (specDone === null && SPEC_TOKENS.test(text)) specDone = entry;
    if (auditDone === null && AUDIT_TOKENS.test(text)) auditDone = entry;
    if (sealed === null && SEALED.test(text)) sealed = entry;
    if (reused === null && REUSED.test(text)) reused = entry;
    if (NO_CAPTURE.test(text)) noCapture = true;
  }

  return {
    captured,
    authoring,
    specDone,
    auditDone,
    sealed,
    reused,
    noCapture,
    // The same rule the server applies (`site-capture.ts`'s URL_PATTERN): a bare
    // hostname is NOT a URL and is not captured. Kept in sync deliberately —
    // promising a capture the server declines is worse than promising none.
    urlInTicket: /https?:\/\/[^\s<>"'`]+/i.test(ticketText),
  };
}

/**
 * The pipeline, as far as the run has said.
 *
 * Returns an empty list when there is nothing honest to draw — before the spec
 * phase, and after it, where the real graph takes over.
 */
export function specPipelineFrom(
  trace: readonly TraceEntry[],
  phase: RunPhase,
  ticketText: string,
  runIsActive: boolean,
): readonly SpecStage[] {
  if (phase !== "spec") return [];
  const seen = scan(trace, ticketText);

  // A REUSED SUITE IS NOT A PIPELINE. The ticket's text already had a sealed
  // suite, so nothing is authored and nothing is audited; drawing four stages
  // that never move would invent work that is not happening.
  if (seen.reused !== null) {
    return [
      {
        id: "freeze",
        label: "Acceptance suite",
        detail: "Reused the suite already sealed for this ticket text — nothing to author.",
        state: "done",
        atMs: seen.reused.atMs,
      },
    ];
  }

  const captureState: SpecStageState =
    seen.captured !== null ? "done" : seen.noCapture || !seen.urlInTicket ? "skipped" : "running";

  const authorRunning = seen.authoring !== null && seen.specDone === null;
  const authorState: SpecStageState =
    seen.specDone !== null ? "done" : authorRunning ? "running" : "pending";

  /*
   * AUDIT IS `pending` UNTIL ITS OWN LINE LANDS, AND THAT IS THE HONEST SHAPE.
   * The audit runs interleaved with authoring inside `authorAndFreezeSuite`, and
   * the server reports only its token total at the end. So this cannot show the
   * audit starting, and it does not pretend to: it stays pending, which is true
   * ("we have not been told it finished"), rather than being lit on a guess.
   */
  const auditState: SpecStageState = seen.auditDone !== null ? "done" : "pending";
  const freezeState: SpecStageState = seen.sealed !== null ? "done" : "pending";

  const stages: readonly SpecStage[] = [
    {
      id: "capture",
      label: "Reference capture",
      detail:
        captureState === "done"
          ? (seen.captured?.text ?? "")
          : captureState === "skipped"
            ? "No URL in the ticket, so nothing was captured."
            : "Loading the page and reading its structure.",
      state: captureState,
      atMs: seen.captured?.atMs ?? null,
    },
    {
      id: "author",
      label: "Spec seat",
      detail:
        authorState === "done"
          ? (seen.specDone?.text ?? "")
          : authorState === "running"
            ? "Writing the held-out acceptance suite from the ticket and the capture."
            : "Waiting for the capture.",
      state: authorState,
      atMs: (seen.specDone ?? seen.authoring)?.atMs ?? null,
    },
    {
      id: "audit",
      label: "Audit seat",
      detail:
        auditState === "done"
          ? (seen.auditDone?.text ?? "")
          : "Attacks the suite for untestable and gameable criteria. Reports only when it finishes.",
      state: auditState,
      atMs: seen.auditDone?.atMs ?? null,
    },
    {
      id: "freeze",
      label: "Freeze",
      detail:
        freezeState === "done"
          ? (seen.sealed?.text ?? "")
          : "Seals the suite by digest, so the builder can never see it.",
      state: freezeState,
      atMs: seen.sealed?.atMs ?? null,
    },
  ];
  return stages.map((stage) =>
    // A TERMINAL RUN HAS NO RUNNING STAGE. Whatever was in flight when it stopped
    // did not continue; leaving a pulsing "running" card on a dead run is the
    // same lie as the old empty state, relocated.
    runIsActive || stage.state !== "running" ? stage : { ...stage, state: "pending" as const },
  );
}
