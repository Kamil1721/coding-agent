/**
 * plan-dialogue.ts — the plan park, read off the wire the plan park actually has.
 *
 * =========================================================================
 * THERE IS NO `RunDetail.plan`, AND THIS FILE DOES NOT INVENT ONE
 * =========================================================================
 *
 * The server's plan phase keeps its whole state in `runs/<id>/results/plan.json`
 * — every question, its `ifUnanswered`, the two candidate criteria that earned it
 * its place, the park instant, the turn count. NONE of that is on the API.
 * `RunDetail` gained exactly one thing from the plan phase: `phase` can now read
 * `"plan"` (`server/src/api-types.ts`, `ApiPhase`). Checked, not assumed —
 * `grep -n plan server/src/api-types.ts` on 2026-08-02 returns the union and two
 * comments, and there is no `/api/runs/:id/plan` route in `http.ts`.
 *
 * Adding a `plan` field to this package's hand-copied mirror would have made the
 * panel render beautifully against a fixture and never once against the server.
 * `design-lock.tsx` already refused the same trade for the same reason, in
 * writing: "there is no countdown, because the deadline is not on the wire …
 * a clock invented in the browser would be a number the owner could plan around
 * and be wrong about."
 *
 * SO EVERYTHING HERE COMES OFF TWO CHANNELS THE PARK GENUINELY USES:
 *
 *   1. THE CHAT. `Orchestrator#planPhase` posts the seat's short plan as one
 *      `run` row and then `questionText(open)` as a second — literally
 *      `PQ-1: …\nPQ-2: …`, one line per question, IN RANK ORDER.
 *      `PlanDriver#reask` posts the same shape again after every owner turn,
 *      carrying exactly the questions that are STILL OPEN.
 *   2. THE EVENT LOG. The host may not compose a `run` chat row (db.ts's
 *      `ChatRole`), so everything it wants to say about the dialogue is a `log`
 *      event: the park announcement with the timeout in minutes, one
 *      `recorded against PQ-n (status, attribution): …` per accepted resolution,
 *      and one `PQ-n was never answered, so the run is assuming: …` per expiry.
 *
 * =========================================================================
 * THE OPEN SET IS THE NEWEST QUESTION BLOCK. IT IS A CONTRACT, NOT A SCRAPE
 * =========================================================================
 *
 * `#reask` re-posts the open set verbatim after every turn, so the newest block
 * IS the open set — the server's own answer to "what is still outstanding",
 * transmitted in the one channel it has. That is what makes the task's worst
 * outcome structurally impossible: an owner who asks a clarifying question gets a
 * reply AND the same questions re-posted, so they stay visibly open without this
 * file deciding anything.
 *
 * IT IS GATED ON THE RUN STILL BEING PARKED. When the last question is answered
 * the driver does NOT re-ask — there is nothing to re-ask — so the newest block
 * is then a list of questions that have all been settled. `phase === "plan" &&
 * status === "awaiting_input"` is the only thing that separates those two
 * readings, and it is why {@link planDialogueFrom} takes both.
 *
 * =========================================================================
 * WHAT THIS FILE STILL CANNOT SHOW, NAMED RATHER THAN FAKED
 * =========================================================================
 *
 * `ifUnanswered` and the two candidate criteria are the seat's argument for
 * interrupting the owner at all, and they never leave `plan.json` while a
 * question is open. So "why does this matter" cannot be a disclosure — there is
 * nothing to disclose. It is a QUESTION BACK, which the phase already supports
 * and the owner explicitly asked for: {@link composeAsk} sends it, the seat
 * replies in the chat, and the question stays open. The panel says that is what
 * the control does rather than pretending to a cached answer.
 */

import type { ChatMessage } from "./api";
import type { RunPhase, RunStatus } from "./api-types";
import type { TraceEntry } from "./use-run-stream";

/* -------------------------------------------------------------------------
 * READING THE WIRE
 * ---------------------------------------------------------------------- */

/**
 * One line of `questionText` — `PQ-1: How many projects should it show?`.
 *
 * ANCHORED, unlike the loose substring matches in `spec-pipeline.ts`, and the
 * difference is what each one is reading. Those match PROSE a person wrote and a
 * person may reword; this matches a string built by
 * `questions.map(q => `${q.id}: ${q.text}`).join("\n")`. A loose match here would
 * turn any sentence mentioning a question id into a question card.
 */
const QUESTION_LINE = /^(PQ-\d+):\s*(\S.*)$/;

/** `recorded against PQ-1 (answered, addressed): six` — `PlanDriver#report`. */
const RECORDED = /^recorded against (PQ-\d+) \((answered|declined)[^)]*\):\s*(.*)$/i;

/** `PQ-2 was never answered, so the run is assuming: three cards` — `#closePlanDialogue`. */
const ASSUMED = /^(PQ-\d+) was never answered, so the run is assuming:\s*(.*)$/i;

/**
 * The park announcement, and the ONLY honest source for the clock.
 *
 * `Orchestrator#planPhase` emits it once, immediately after `#plan.park`, and it
 * carries the configured window in minutes. The event's own `atMs` is the park
 * instant — `parkedAt` is minted on the line above and nothing between them
 * awaits — so deadline = that instant + that many minutes.
 *
 * TWO PARTS, MATCHED SEPARATELY AND BOTH REQUIRED. The sentence is long and a
 * server reword could move either half; requiring both means a partial match
 * yields NO clock rather than a clock computed from a default nobody configured.
 * `DASHBOARD_PLAN_TIMEOUT_MIN` is settable, so a hardcoded 20 here would be a
 * countdown that is silently wrong on any machine that set it.
 */
const PARK_ANNOUNCE = /waiting for an answer in the chat/i;
const PARK_WINDOW = /inside\s+(\d+(?:\.\d+)?)\s+minutes/i;

/** The window ran out while the dashboard was up, or while it was down. */
const WINDOW_CLOSED = /^no answer arrived within |^the plan window expired while the dashboard was down/i;

/** The dialogue ended and the brief was amended, or ended with nothing to fold. */
const DIALOGUE_OVER = /^the plan dialogue (is over|is folded into the brief|ended with nothing to fold)/i;

/** The phase ran and deliberately asked nothing. Both forms carry their reason. */
const ASKED_NOTHING = /^plan phase (skipped|asked nothing)[:—-]\s*(.*)$/i;

/**
 * Split a `run` chat row into question lines, or `null` if it is prose.
 *
 * EVERY NON-EMPTY LINE MUST MATCH. A seat reply that happens to mention `PQ-2:`
 * mid-paragraph is prose and must render as prose; only a row that is nothing but
 * question lines is the block `questionText` produced.
 */
export function questionLinesIn(text: string): readonly { id: string; text: string }[] | null {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const parsed: { id: string; text: string }[] = [];
  for (const line of lines) {
    const match = QUESTION_LINE.exec(line.trim());
    const id = match?.[1];
    const body = match?.[2];
    if (id === undefined || body === undefined) return null;
    parsed.push({ id, text: body.trim() });
  }
  return parsed;
}

/* -------------------------------------------------------------------------
 * THE SHAPE THE PANEL RENDERS
 * ---------------------------------------------------------------------- */

/**
 * What became of one question.
 *
 * `declined` IS NOT A WEAKER `answered` AND `assumed` IS NOT A FAILURE — both
 * distinctions are the server's, kept rather than flattened. A declined question
 * records the question's own `ifUnanswered`, byte for byte what an expiry
 * records, which is what "you decide without penalty" means mechanically
 * (`plan-state.ts`). Collapsing the three into "closed" would hide the one thing
 * the owner might want to revisit.
 *
 * `settled` IS THE HONEST UNKNOWN. The question is no longer open and no log line
 * said how it closed — the trace is capped at 3000 entries and a long run can
 * push the plan phase off the top. Saying "answered" there would be this display
 * asserting an outcome it did not read.
 */
export type PlanQuestionState = "open" | "answered" | "declined" | "assumed" | "settled";

export interface PlanQuestionView {
  readonly id: string;
  /** One sentence, as the seat wrote it. The server caps it; this does not clamp. */
  readonly text: string;
  readonly state: PlanQuestionState;
  /**
   * What the run wrote down: the answer for `answered`, the assumption it fell
   * back to for `declined` and `assumed`. Null when no log line said.
   */
  readonly recorded: string | null;
}

/**
 * The conversation, in order, with the questions rendered ONCE.
 *
 * A SUPERSEDED QUESTION BLOCK IS DROPPED, and that is the owner's "we dont want a
 * wall of text" made mechanical rather than promised. Three questions re-asked
 * across four turns is twelve identical sentences in a 360px dock; the questions
 * belong in one place, at the bottom, in their current state.
 */
export type PlanThreadItem =
  | { readonly kind: "said"; readonly who: "run" | "you"; readonly text: string; readonly at: string; readonly seq: number }
  | { readonly kind: "questions"; readonly seq: number };

export interface PlanDialogue {
  /**
   * The seat's short plan — the first `run` row, before any question block.
   *
   * Null when the seat wrote none: `#planPhase` only posts it `if
   * (opened.plan.length > 0)`, so an absent plan means the seat produced none,
   * not that this file failed to find one.
   */
  readonly plan: string | null;
  readonly items: readonly PlanThreadItem[];
  /** Every question ever asked, newest block last, in the rank order it was asked in. */
  readonly questions: readonly PlanQuestionView[];
  /** True while the run is stopped on these questions. */
  readonly parked: boolean;
  /** When the window runs out, or null when no park line was seen. */
  readonly deadlineMs: number | null;
  /** The configured window, for the sentence under the clock. Null with no park line. */
  readonly windowMin: number | null;
  /** The run's own sentence about how the dialogue ended, when it has written one. */
  readonly closedNote: string | null;
}

interface PlanTraceRead {
  readonly recorded: ReadonlyMap<string, { state: PlanQuestionState; recorded: string }>;
  readonly parkedAtMs: number | null;
  readonly windowMin: number | null;
  readonly closedNote: string | null;
}

/**
 * Everything the log said about this dialogue.
 *
 * LAST WRITE WINS on a per-question basis, deliberately: `reopen` exists in the
 * server's arbiter, so a question can go answered → open → answered again, and
 * the newest line is the current record.
 */
function readTrace(trace: readonly TraceEntry[]): PlanTraceRead {
  const recorded = new Map<string, { state: PlanQuestionState; recorded: string }>();
  let parkedAtMs: number | null = null;
  let windowMin: number | null = null;
  let closedNote: string | null = null;

  for (const entry of trace) {
    const text = entry.text;

    const accepted = RECORDED.exec(text);
    const acceptedId = accepted?.[1];
    const acceptedState = accepted?.[2];
    if (accepted !== null && acceptedId !== undefined && acceptedState !== undefined) {
      recorded.set(acceptedId, {
        state: acceptedState.toLowerCase() === "declined" ? "declined" : "answered",
        recorded: (accepted[3] ?? "").trim(),
      });
      continue;
    }

    const assumed = ASSUMED.exec(text);
    const assumedId = assumed?.[1];
    if (assumed !== null && assumedId !== undefined) {
      recorded.set(assumedId, { state: "assumed", recorded: (assumed[2] ?? "").trim() });
      continue;
    }

    if (PARK_ANNOUNCE.test(text)) {
      // THE FIRST PARK LINE, NOT THE LAST. The window is bounded from the
      // ORIGINAL park and every re-park carries that instant forward
      // (`PlanDriver#park`), so a later announcement — there is none today, but
      // the guard costs nothing — must not push the deadline out.
      const minutes = PARK_WINDOW.exec(text)?.[1];
      if (parkedAtMs === null && minutes !== undefined) {
        parkedAtMs = entry.atMs;
        windowMin = Number.parseFloat(minutes);
      }
      continue;
    }

    if (WINDOW_CLOSED.test(text) || DIALOGUE_OVER.test(text)) {
      closedNote = text;
      continue;
    }

    const nothing = ASKED_NOTHING.exec(text);
    if (nothing !== null) closedNote = text;
  }

  return { recorded, parkedAtMs, windowMin, closedNote };
}

/**
 * The dialogue, or `null` when this run never had one.
 *
 * `null` IS THE ANSWER FOR EVERY RUN RECORDED BEFORE THIS PHASE EXISTED, and it
 * falls out of the mechanism rather than out of a version check: no plan phase
 * means no `run` row whose every line is `PQ-n: …`, so there is nothing to draw
 * and the panel does not mount. Verified against the real run
 * `run-2026-07-30T20-16-40-242Z-052c6e02`, which predates the phase entirely.
 */
export function planDialogueFrom(input: {
  readonly messages: readonly ChatMessage[];
  readonly trace: readonly TraceEntry[];
  readonly phase: RunPhase;
  readonly status: RunStatus;
}): PlanDialogue | null {
  /*
   * A RUNTIME GUARD OVER A TYPE THAT SAYS IT CANNOT HAPPEN, and it is here
   * because it DID happen — caught by `design-lock.browser.spec.ts` going red on
   * "Uncaught TypeError: input.messages is not iterable", thrown from this line,
   * inside a `useMemo` during render, which takes the whole run page down.
   *
   * THE MECHANISM: `src/lib/api.ts` casts every response with `parsed as T` and
   * validates nothing, so a body with no `messages` key hands `undefined` to a
   * field typed `readonly ChatMessage[]`. That is not hypothetical — the run
   * fixture's own comment names it as the shape "every run in `dashboard/runs/`
   * today" answers with for fields added after it was recorded, and the sanctioned
   * pattern at the other such site is a `?? []` at the mount point.
   *
   * The caller guards too. Both, because a crash in a render path is a blank page
   * on the screen whose entire job is showing a reader what went wrong.
   */
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const trace = Array.isArray(input.trace) ? input.trace : [];

  const blocks: { seq: number; questions: readonly { id: string; text: string }[] }[] = [];
  for (const message of messages) {
    if (message.role !== "run") continue;
    const questions = questionLinesIn(message.text);
    if (questions !== null) blocks.push({ seq: message.seq, questions });
  }
  if (blocks.length === 0) return null;

  const newest = blocks[blocks.length - 1];
  if (newest === undefined) return null;
  const supersededBlocks = new Set(blocks.slice(0, -1).map((block) => block.seq));

  const parked = input.phase === "plan" && input.status === "awaiting_input";
  const openIds = new Set(parked ? newest.questions.map((question) => question.id) : []);
  const read = readTrace(trace);

  /*
   * ONE ENTRY PER ID, FIRST WORDING WINS. A re-asked question arrives with the
   * same id and the same text; taking the first keeps the list in the rank order
   * the seat originally ranked them in, which is the order that is supposed to
   * carry information.
   */
  const seen = new Map<string, PlanQuestionView>();
  for (const block of blocks) {
    for (const question of block.questions) {
      if (seen.has(question.id)) continue;
      const outcome = read.recorded.get(question.id);
      const state: PlanQuestionState = openIds.has(question.id)
        ? "open"
        : (outcome?.state ?? "settled");
      seen.set(question.id, {
        id: question.id,
        text: question.text,
        // A question that is open again has no current outcome to print, whatever
        // the log said about an earlier turn.
        state,
        recorded: state === "open" ? null : (outcome?.recorded ?? null),
      });
    }
  }

  /*
   * THE PLAN IS THE FIRST `run` PROSE ROW BEFORE THE FIRST QUESTION BLOCK, which
   * is exactly where `#planPhase` posts it. A seat REPLY is also a `run` prose row
   * and must not be mistaken for the plan, so the position is what identifies it,
   * not the content.
   */
  const firstBlockSeq = blocks[0]?.seq ?? Number.POSITIVE_INFINITY;
  let plan: string | null = null;
  const items: PlanThreadItem[] = [];
  for (const message of messages) {
    if (message.role === "run" && questionLinesIn(message.text) !== null) {
      if (supersededBlocks.has(message.seq)) continue;
      items.push({ kind: "questions", seq: message.seq });
      continue;
    }
    if (message.text.trim().length === 0) continue;
    if (message.role === "run" && message.seq < firstBlockSeq && plan === null) {
      plan = message.text.trim();
      continue;
    }
    items.push({
      kind: "said",
      who: message.role === "owner" ? "you" : "run",
      text: message.text,
      at: message.at,
      seq: message.seq,
    });
  }

  return {
    plan,
    items,
    questions: [...seen.values()],
    parked,
    deadlineMs:
      read.parkedAtMs === null || read.windowMin === null
        ? null
        : read.parkedAtMs + read.windowMin * 60_000,
    windowMin: read.windowMin,
    closedNote: read.closedNote,
  };
}

/* -------------------------------------------------------------------------
 * COMPOSING A REPLY — measured against the server's own classifier
 * ---------------------------------------------------------------------- */

/*
 * `POST /api/runs/:id/messages` CARRIES `text` AND `images` AND NOTHING ELSE.
 * The server's `classifyOwnerReply` has a STRUCTURAL rung that takes
 * `{questionId, intent}` from a client, and `plan-dialogue.ts:237-243` says in as
 * many words that "the UI agent adding a per-question reply control is what turns
 * this into `structural`" — but the wire has no field for it, and widening the
 * wire is a server change. So these three helpers aim at the ADDRESSED rung
 * instead, which reads the id out of the text.
 *
 * THE THREE FORMS BELOW WERE RUN AGAINST THE COMPILED CLASSIFIER, not reasoned
 * about. `node` against `server/dist/plan-state.js`, two open questions, seat
 * null:
 *
 *   "PQ-1: six"                       -> answer,  PQ-1, addressed, recorded "six"
 *   "PQ-1: what do you mean by that?" -> clarify, PQ-1, addressed, recorded none
 *   "you decide (PQ-1)"               -> decline, PQ-1, addressed, recorded the
 *                                        question's own ifUnanswered
 *   "you decide"                      -> decline, PQ-1 AND PQ-2, inferred
 *
 * AND ONE FORM THAT LOOKS RIGHT AND IS NOT, which is the whole reason this was
 * measured:
 *
 *   "PQ-1: you decide"  ->  ANSWER, recorded literally as "you decide"
 *
 * `declineIntent` requires the decline phrase at the START of the normalised
 * body and the id prefix displaces it, so the obvious composition marks the
 * question ANSWERED with the words "you decide" — which then counts as a traced
 * answer in `answeredPairs` and can credit a criterion to an owner who
 * explicitly declined to state one. That is exactly the failure the plan phase
 * exists to remove, one level down. Hence the id goes at the END for a decline
 * and at the FRONT for everything else, and neither is a style choice.
 */

/** `PQ-1: six`. */
export function composeAnswer(id: string, text: string): string {
  return `${id}: ${text.trim()}`;
}

/**
 * `PQ-1: which of the two images?`
 *
 * THE QUESTION MARK IS REQUIRED BY THE SERVER, NOT BY TASTE. `classifyOwnerReply`
 * routes on `endsWithQuestion` and that rung sits ABOVE the answer rung
 * deliberately — it is the single ordering that makes "the owner can ask back"
 * safe. A clarification typed without one is recorded as the ANSWER, and the
 * question the owner was trying to understand closes under his own words.
 *
 * So one is appended when the text does not already end in one, and the panel
 * shows the exact string it is about to send. Appending a character is a smaller
 * intrusion than silently consuming an answer slot.
 */
export function composeAsk(id: string, text: string): string {
  const body = text.trim();
  return `${id}: ${endsWithQuestionMark(body) ? body : `${body}?`}`;
}

/**
 * `you decide (PQ-1)` — the decline phrase FIRST. See the block above.
 *
 * IT IS NOT A NON-ANSWER. The server records the question's own `ifUnanswered`
 * against it, which is byte for byte what an expiry records and exactly where
 * the run would have landed had the question never been asked.
 */
export function composeDecline(id: string): string {
  return `you decide (${id})`;
}

/** Declines every open question at once — the server's inferred global rung. */
export const DECLINE_ALL = "you decide";

/**
 * Would the server read this as a question rather than an answer?
 *
 * `endsWithQuestion`'s rule, transcribed: trailing quotes and brackets are
 * stripped before the check, so `"is it three?"` counts.
 */
export function endsWithQuestionMark(text: string): boolean {
  return text.replace(/["'”’)\]]+$/, "").trimEnd().endsWith("?");
}

/* -------------------------------------------------------------------------
 * THE CLOCK
 * ---------------------------------------------------------------------- */

export interface PlanCountdown {
  readonly kind: "left" | "closing";
  /** Whole minutes remaining. 0 with under a minute left. */
  readonly minutes: number;
}

/**
 * How long he has, or `null` when the wire never said.
 *
 * `closing` RATHER THAN A NEGATIVE NUMBER. The window can lapse while the row is
 * still `awaiting_input`: the server's timer fires, logs, and calls `resume()`,
 * and the run is requeued rather than instantly moved on. A countdown that ran
 * negative there would look broken; the state is real and gets its own word.
 */
export function planCountdown(deadlineMs: number | null, nowMs: number): PlanCountdown | null {
  if (deadlineMs === null) return null;
  const left = deadlineMs - nowMs;
  if (left <= 0) return { kind: "closing", minutes: 0 };
  return { kind: "left", minutes: Math.floor(left / 60_000) };
}
