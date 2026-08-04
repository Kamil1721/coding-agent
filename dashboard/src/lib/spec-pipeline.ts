/**
 * spec-pipeline.ts — the things the canvas draws that are NOT agent events.
 *
 * TWO SECTIONS, ONE IDEA, AT THE TWO ENDS OF A RUN. The first is the spec
 * pipeline: the four things that happen before any agent exists. The second is
 * the TERMINAL PREVIEW: the site the run built, after the last agent is gone.
 * Neither is a `graph_agent`, neither may ever become one, and the reasoning
 * below for the first is the whole reasoning for the second — see
 * `previewNodeFrom` at the bottom of this file, which restates only what is
 * different about it.
 *
 * =========================================================================
 * SECTION ONE — THE SPEC PIPELINE. SUPERSEDED 2026-08-04. NOTHING RENDERS IT.
 * =========================================================================
 *
 * READ THIS BEFORE CHANGING ANYTHING BELOW, AND BEFORE ADDING A CALLER.
 *
 * The pre-build lane is now folded on the SERVER — `foldGraph` projects it from
 * the same `phase` and `log` rows this scanner reads, into `GraphState.stages` —
 * and the canvas draws it as real nodes (`components/canvas/stage-node.tsx`). The
 * run page no longer calls `specPipelineFrom` at all.
 *
 * THE REASONING IN THIS SECTION SURVIVED THE MOVE; THE LOCATION WAS THE DEFECT.
 * Two things could not be fixed here:
 *
 *   1. IT READ THE LIVE `trace` SINK. `use-run-stream.ts` never opens an
 *      EventSource for a terminal run, so every stage below was blank on every
 *      run opened after it finished — the case the owner is in most of the time.
 *   2. `specPipelineFrom` RETURNED `[]` FOR EVERY PHASE PAST `spec` (the guard
 *      still sitting there). The lane deleted itself at the build boundary, which
 *      is the opposite of "you're still on the actual same canvas".
 *
 * WHY IT IS STILL HERE. `tests/spec-pipeline.unit.spec.ts` is 175 lines of live
 * checks against these functions and belongs to another lane; deleting the
 * derivation without its spec would be a red suite for someone else. The
 * resolution is to delete BOTH, together, and this paragraph is the note that
 * says so. Do not port a fix into this section — port it into
 * `server/src/graph.ts`, which is what runs.
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

import { isTerminalStatus, type RunDetail, type RunPhase, type RunStatus } from "./api-types";
import type { TraceEntry } from "./use-run-stream";

export type SpecStageState = "done" | "running" | "pending" | "skipped";

export interface SpecStage {
  readonly id: "plan" | "capture" | "author" | "audit" | "freeze";
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

/*
 * THE PLAN PHASE'S THREE LINES. It runs BEFORE the capture and produces exactly
 * one stage, because that is all the server reports about it: the park
 * announcement, one of two "asked nothing" sentences, and one of three closing
 * sentences. There is no start line — `#planPhase` calls the seat and then
 * speaks — so this stage is `running` from the phase itself and never from a
 * timer, which is the same rule the four below it play by.
 */
const PLAN_PARKED = /waiting for an answer in the chat/i;
const PLAN_NOTHING = /^plan phase (?:skipped|asked nothing)\s*[:—-]\s*(.+)$/i;
const PLAN_OVER = /^the plan dialogue (?:is over|is folded into the brief|ended with nothing to fold)/i;

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
 * The plan phase as one stage, or `null` when this run never had one.
 *
 * `null` IS WHAT KEEPS AN OLD RUN RENDERING UNCHANGED, and it is derived rather
 * than version-checked: a run recorded before this phase existed emitted none of
 * the three lines and is not in the `plan` phase, so there is nothing to draw and
 * the four spec stages are exactly the list they were.
 *
 * NOTHING HERE IS A TIMER. `running` comes from the run being IN the phase or
 * from the park line; `done` and `skipped` come from a sentence the server wrote.
 */
export function planStageFrom(
  trace: readonly TraceEntry[],
  phase: RunPhase,
): SpecStage | null {
  let over: TraceEntry | null = null;
  let nothing: { entry: TraceEntry; reason: string } | null = null;
  let parked: TraceEntry | null = null;

  for (const entry of trace) {
    if (over === null && PLAN_OVER.test(entry.text)) over = entry;
    const asked = PLAN_NOTHING.exec(entry.text);
    if (nothing === null && asked !== null) {
      nothing = { entry, reason: asked[1] ?? entry.text };
    }
    if (parked === null && PLAN_PARKED.test(entry.text)) parked = entry;
  }

  if (over !== null) {
    return { id: "plan", label: "Plan", detail: over.text, state: "done", atMs: over.atMs };
  }
  if (nothing !== null) {
    return {
      id: "plan",
      label: "Plan",
      detail: nothing.reason,
      state: "skipped",
      atMs: nothing.entry.atMs,
    };
  }
  if (parked !== null) {
    return {
      id: "plan",
      label: "Plan",
      detail:
        "Waiting for an answer in the run panel. The window closes on its own, and the run then " +
        "proceeds on what it had to assume.",
      state: "running",
      atMs: parked.atMs,
    };
  }
  if (phase === "plan") {
    return {
      id: "plan",
      label: "Plan",
      detail:
        "Reading the ticket and anything attached to it, and working out what it cannot infer. " +
        "It reports when it has something to ask.",
      state: "running",
      atMs: null,
    };
  }
  return null;
}

/**
 * The pipeline, as far as the run has said.
 *
 * Returns an empty list when there is nothing honest to draw — before the plan
 * phase, and after the spec phase, where the real graph takes over.
 *
 * THE PLAN PHASE IS DRAWN TOO, AND THE ALTERNATIVE WAS A BLANK CANVAS AT THE ONE
 * MOMENT THE OWNER IS DEFINITELY WATCHING. This guard used to be `phase !==
 * "spec"`, which for the whole of a plan park would have handed the canvas its
 * empty-state copy — "The acceptance suite is being written and frozen first" —
 * about a run that is doing no such thing and is in fact waiting on him.
 *
 * DURING THE PLAN PHASE IT IS ONE STAGE AND NOT FIVE. Drawing `capture` as
 * `running` while the plan is still open would claim a page was being fetched
 * that nothing has started; `pending` for four stages that have not been reported
 * would be four grey rows saying nothing. One stage, in the phase the run is
 * actually in.
 */
export function specPipelineFrom(
  trace: readonly TraceEntry[],
  phase: RunPhase,
  ticketText: string,
  runIsActive: boolean,
): readonly SpecStage[] {
  const planStage = planStageFrom(trace, phase);
  if (phase === "plan") {
    if (planStage === null) return [];
    return runIsActive || planStage.state !== "running"
      ? [planStage]
      : [{ ...planStage, state: "pending" as const }];
  }
  if (phase !== "spec") return [];
  const seen = scan(trace, ticketText);

  // A REUSED SUITE IS NOT A PIPELINE. The ticket's text already had a sealed
  // suite, so nothing is authored and nothing is audited; drawing four stages
  // that never move would invent work that is not happening.
  if (seen.reused !== null) {
    return withPlan(planStage, [
      {
        id: "freeze",
        label: "Acceptance suite",
        detail: "Reused the suite already sealed for this ticket text — nothing to author.",
        state: "done",
        atMs: seen.reused.atMs,
      },
    ]);
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
  return withPlan(
    planStage,
    stages.map((stage) =>
      // A TERMINAL RUN HAS NO RUNNING STAGE. Whatever was in flight when it stopped
      // did not continue; leaving a pulsing "running" card on a dead run is the
      // same lie as the old empty state, relocated.
      runIsActive || stage.state !== "running" ? stage : { ...stage, state: "pending" as const },
    ),
  );
}

/**
 * Put the plan stage at the head of the spec list, when there was one.
 *
 * A RUN THAT NEVER PLANNED GETS THE LIST IT ALWAYS GOT — same length, same ids,
 * same order — which is the property `spec-pipeline.unit.spec.ts`'s existing
 * cases are written against.
 */
function withPlan(
  planStage: SpecStage | null,
  stages: readonly SpecStage[],
): readonly SpecStage[] {
  return planStage === null ? stages : [planStage, ...stages];
}

/* =========================================================================
 * SECTION TWO — THE TERMINAL PREVIEW
 *
 * The owner's ask, in his words: "the website should show as a preview in a node
 * on the canvas after it is done."
 *
 * IT IS A LAYOUT CONSTRUCT, NOT A `graph_agent`, for exactly the reason the spec
 * stages above are: no agent produced it, and every invariant in the server's
 * `graph.ts` is keyed on a real `graph_agent` arriving first for its node id. A
 * synthetic id in that graph would be a forged event. `FINDINGS §ITERATION 4`
 * recorded the same decision for the "result node" this is.
 *
 * TWO AXES, AND THEY MUST NOT COLLAPSE INTO ONE WORD.
 *
 *   1. IS THERE A SERVABLE SITE — answered by the dashboard's preview route, and
 *      only by it. See {@link previewSiteFrom}.
 *   2. WHAT DID THE GATE SAY — `heldOutPass`, three-valued. See
 *      {@link verdictOf}.
 *
 * They are independent facts and a run can be any combination of them: a
 * cancelled run with a perfectly servable site is real, and so is a run that
 * passed its suite from a `site/` subdirectory the preview route will not guess
 * at. One card, two sentences, neither derived from the other. A single state
 * word here would make a 409 read as a failed run, or a servable site read as a
 * passed gate — which is this repository's signature defect with a thumbnail on
 * it.
 *
 * NOTHING HERE TOUCHES `RunDetail.previewUrl`. Measured (FINDINGS §ITERATION 4):
 * the recorded run's is `http://127.0.0.1:4321` and nothing listens — the process
 * that served it exited with the run. It is a historical record, not an address.
 * {@link TerminalPreview.previewPath} is built from the run id ALONE, so linking
 * the dead field is not a thing this code has to remember not to do; it is
 * unreachable from here.
 * ====================================================================== */

/**
 * What the held-out gate said, as something drawable.
 *
 * `tone` is a subset of `Tone` in `src/lib/presentation.ts` — assignable to it,
 * so `<Badge tone={verdict.tone}>` typechecks — and deliberately NOT the whole
 * union: `warn`, `info` and `accent` would all be this display inventing a
 * degree of concern the gate did not express.
 */
export interface PreviewVerdict {
  readonly tone: "pass" | "fail" | "neutral";
  readonly label: string;
  /** One sentence saying what the label does and does not mean. Never empty. */
  readonly detail: string;
}

/**
 * `heldOutPass: null` IS NOT `false`, AND THIS IS WHERE THAT IS SPENT.
 *
 * The rule is load-bearing across the whole dashboard, and it is at its most
 * dangerous next to a picture of a working site: a card that renders "not scored"
 * with the same red as "failed" tells the owner his build was rejected by a gate
 * that never ran, and a card that renders it green tells him a suite passed that
 * nobody executed. Three inputs, three different values — the neutral one says
 * out loud that it is neither.
 */
function verdictOf(heldOutPass: boolean | null): PreviewVerdict {
  if (heldOutPass === true) {
    return {
      tone: "pass",
      label: "Held-out suite passed",
      detail: "The sealed suite the builder never saw scored this build green.",
    };
  }
  if (heldOutPass === false) {
    return {
      tone: "fail",
      label: "Held-out suite failed",
      detail: "The sealed suite scored this build red. What is below is what was built, not what passed.",
    };
  }
  return {
    tone: "neutral",
    label: "Not scored",
    detail:
      "No held-out result was recorded for this run. That is not a failure — nothing graded it either way.",
  };
}

/**
 * What the run's own ending says about how finished this artefact is, or `null`
 * when the status adds nothing the verdict has not already said.
 *
 * READ OFF `status`, WHICH IS A RECORDED FACT, and it claims nothing about WHY.
 * `RunDetail.failureReason` is the last write of five writers (see its docblock)
 * so it is not "the reason the site looks like this", and it is not consulted.
 */
function caveatOf(status: RunStatus): string | null {
  if (status === "cancelled") {
    return "Cancelled part-way, so this is whatever had been written when it stopped — not a finished build.";
  }
  if (status === "failed") {
    // NOT "the code is still on disk": whether anything is there is the preview
    // route's answer, above, and a workspace can be deleted. This says only what
    // `status` says.
    return "The run ended in failure, so this is as far as it got.";
  }
  return null;
}

/**
 * The terminal node's content, derived from `RunDetail` and nothing else.
 *
 * `previewPath` IS A PATH, NOT A URL, and it is the same spelling `KEY.*` in
 * `src/lib/api.ts` uses — the caller runs it through `apiUrl()` for both the
 * probe and the link, so a deployment that moves the API with
 * `NEXT_PUBLIC_API_BASE_URL` moves both together.
 *
 * THE TRAILING SLASH IS LOAD-BEARING. Without it the browser resolves the
 * document's own `styles.css` against `/api/runs/:id/`, one level too high, and
 * every relative asset 404s — so the page renders unstyled and reads as a broken
 * build. The server answers the no-slash form with a 302, so forgetting it is
 * slow rather than wrong; carrying it is neither.
 */
export interface TerminalPreview {
  readonly runId: string;
  readonly previewPath: string;
  /** The terminal status this was built from. `queued`/`running` never get here. */
  readonly status: RunStatus;
  readonly verdict: PreviewVerdict;
  /** An extra sentence about the artefact's completeness, or null. */
  readonly caveat: string | null;
}

/**
 * The terminal preview for a run, or `null` when the canvas must not draw one.
 *
 * `null` FOR EVERY NON-TERMINAL RUN, and that is the point rather than a
 * convenience: a preview of a half-written site is a lie about what was built.
 * The workspace is being written INTO while the run works, so a frame opened at
 * minute 40 shows a page mid-edit and the reader cannot tell that from a finished
 * one. `isTerminalStatus` — `passed`, `failed`, `cancelled` — is the same gate
 * the rest of the dashboard uses; `awaiting_input` and `rate_limited` are
 * STOPPED, not finished, and deliberately get nothing.
 *
 * IT DOES NOT ASK WHETHER THE SITE EXISTS. Nothing in `RunDetail` can answer
 * that — `publishedProject.fileCount` counts files without naming them, and a
 * `GET /api/runs/:id/files` tree is truncatable, so an absent `index.html` there
 * would not be proof. Only the preview route knows, and asking it is
 * {@link previewSiteFrom}'s job.
 */
export function previewNodeFrom(run: RunDetail): TerminalPreview | null {
  if (!isTerminalStatus(run.status)) return null;
  return {
    runId: run.runId,
    previewPath: `/api/runs/${encodeURIComponent(run.runId)}/preview/`,
    status: run.status,
    verdict: verdictOf(run.heldOutPass),
    caveat: caveatOf(run.status),
  };
}

/**
 * What the dashboard's preview route said when asked for the entry document.
 *
 * `no-index` IS ITS OWN MEMBER BECAUSE IT IS ITS OWN FACT, and it is not
 * hypothetical: of the two finished workspaces on this machine,
 * `run-2026-07-29…3d4d1ccb` has `index.html` at its root and
 * `run-2026-07-30…052c6e02` does not — its site is under `site/`, beside a
 * `server.mjs`. The second is a run with real, openable code and no entry
 * document at the path the preview serves, and a card that offered it a link
 * would be offering a 409.
 *
 * `refused` IS EVERYTHING ELSE THE SERVER MAY SAY, and it carries the server's
 * own sentence rather than one written here. The refusal vocabulary is
 * `code-files.ts`'s — `no_workspace`, `not_found`, `path_forbidden` and the rest
 * — typed `string` on the server, so this deliberately does not enumerate it.
 */
export type PreviewSite =
  | { readonly kind: "servable" }
  | {
      readonly kind: "no-index";
      readonly message: string;
      /** The server's sentence naming the `.html` files it DID find. */
      readonly remediation: string;
    }
  | {
      readonly kind: "refused";
      /** The machine code, kept so a reader can search for it. */
      readonly code: string;
      readonly message: string;
      readonly remediation: string | null;
    }
  | { readonly kind: "unreachable"; readonly message: string };

/** Read one string field off an unknown body without trusting its shape. */
function stringField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 600);
}

/**
 * HTTP outcome -> what the card says. Pure, so the branch that must NOT offer a
 * link is checkable without a browser.
 *
 * IT DOES NOT GO THROUGH `request<T>()` IN `api.ts`, and that is a mechanism
 * decision rather than a stylistic one: `messageFromBody` there returns
 * `message ?? error`, which DISCARDS the machine code whenever prose exists, and
 * it never reads `remediation` at all. The `no_index_html` remediation — the
 * sentence naming the `.html` files the server did find — is the entire content
 * of "say so rather than offering a link that 404s", so it cannot be thrown away
 * on the way in. The caller does its own `fetch` and hands the pieces here.
 *
 * KEYED ON THE CODE, NOT THE STATUS. 409 is `no_index_html` today at exactly one
 * construction site, but the code is what the server pins and what
 * `PreviewOwnRefusalCode` in `api-types.ts` names. Every other refusal falls to
 * `refused`, which has a default rendering — a code this build has never heard of
 * is a newer server, not a bug.
 *
 * A 2xx MEANS AN ENTRY DOCUMENT WAS SERVED. It does not mean the page renders,
 * and no copy built on this may say that it does.
 */
export function previewSiteFrom(httpStatus: number, body: unknown): PreviewSite {
  if (httpStatus >= 200 && httpStatus < 300) return { kind: "servable" };

  const code = stringField(body, "error");
  const message =
    stringField(body, "message") ?? `the preview route answered ${String(httpStatus)}`;
  const remediation = stringField(body, "remediation");

  if (code === "no_index_html") {
    return {
      kind: "no-index",
      message,
      remediation:
        remediation ??
        "The preview serves the run's workspace and opens index.html; the run sheet's Code tab lists what is actually there.",
    };
  }

  return { kind: "refused", code: code ?? String(httpStatus), message, remediation };
}

/**
 * The dashboard's own API did not answer at all.
 *
 * A SEPARATE MEMBER FROM `refused` because it is a different subject: `refused`
 * is the server declining to serve this run's site, this is nothing answering.
 * The wording matches `api.ts`'s connection-refused sentence, which is the same
 * failure — the local backend is not running — reached by a different route.
 */
export const PREVIEW_UNREACHABLE: PreviewSite = {
  kind: "unreachable",
  message:
    "Could not reach the dashboard API to ask whether this run left a servable site. Is the backend process running?",
};
