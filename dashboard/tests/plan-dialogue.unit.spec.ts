/**
 * plan-dialogue.unit.spec.ts — the two things this surface can get wrong in a way
 * nobody would notice.
 *
 * THE FIRST IS THE ONE THE OWNER NAMED: "The single worst outcome on this screen
 * is an owner who asks for clarification and cannot tell whether he has now
 * answered." The panel's open/answered split is not styled, it is DERIVED — from
 * the newest question block the server posted — so the test that matters is the
 * derivation over a transcript in which a question was asked back rather than
 * answered.
 *
 * THE SECOND IS INVISIBLE AND WORSE: the string a control posts. The wire carries
 * `text` and nothing else, so `you decide` on PQ-1 is a composed sentence that
 * the server's classifier either reads as a DECLINE or reads as an ANSWER whose
 * words are "you decide". Both look identical on this screen. Only the second
 * one puts a criterion in `answeredPairs` credited to an owner who declined to
 * state one — the exact defect the plan phase exists to remove, one level down.
 *
 * ─── MUTATIONS RUN, WATCHED FAIL, AND RESTORED ───
 *
 * M1  `lib/plan-dialogue.ts` — `openIds` built from `blocks[0]` (the FIRST block)
 *     instead of `newest`. The clarifying-turn test goes red: PQ-2, answered two
 *     turns ago, comes back as `open`, and PQ-1 — the one actually still open —
 *     is reported settled. 2 assertions failed. Restored.
 * M2  `lib/plan-dialogue.ts` — the `parked` gate dropped, so `openIds` is always
 *     the newest block. "a closed dialogue has nothing open" goes red: every
 *     question on a run that has moved to the build phase reads `open` and the
 *     panel would offer an input on a run that cannot take one. Restored.
 * M3  `lib/plan-dialogue.ts` — `composeDecline` returns `${id}: you decide`, the
 *     obvious form. Its test goes red on the id's POSITION, which is the whole
 *     mechanism: measured against the compiled `plan-state.js`, that string
 *     classifies as `answer` with the recorded text "you decide". Restored.
 * M4  `lib/plan-dialogue.ts` — `composeAsk` stops appending the question mark.
 *     Goes red. Without it `classifyOwnerReply` routes a clarification to the
 *     ANSWER rung and closes the question under the owner's own confusion.
 * M5  `lib/plan-dialogue.ts` — `questionLinesIn` accepts a row when SOME line
 *     matches instead of all. Goes red: the seat's prose reply "The grid is the
 *     row of project cards…" is not a question block, and treating it as one
 *     would put a card on the screen with a sentence fragment in it.
 * M6  `lib/spec-pipeline.ts` — `planStageFrom` returns a stage instead of `null`
 *     when nothing in the trace mentions the plan phase. "an old run's pipeline
 *     is unchanged" goes red on the stage count and on the first id, AND so does
 *     `spec-pipeline.unit.spec.ts`'s own reused-suite case, which is the better
 *     witness because nobody wrote it for this change.
 * M12 `lib/plan-dialogue.ts` — the two `Array.isArray` guards removed. "a
 *     response body with no `messages` key does not take the page down" goes red
 *     on the throw. This is the mutation that reproduces a defect that actually
 *     shipped into the working tree for an hour.
 */

import { expect, test } from "@playwright/test";

import type { ChatMessage } from "@/lib/api";
import {
  DECLINE_ALL,
  composeAnswer,
  composeAsk,
  composeDecline,
  planCountdown,
  planDialogueFrom,
  questionLinesIn,
} from "@/lib/plan-dialogue";
import { specPipelineFrom } from "@/lib/spec-pipeline";
import type { TraceEntry } from "@/lib/use-run-stream";

const T0 = Date.parse("2026-08-02T09:00:00.000Z");

function line(text: string, offsetMs = 0): TraceEntry {
  return { seq: offsetMs, atMs: T0 + offsetMs, kind: "log", level: "info", text, name: null, result: null };
}

function say(seq: number, role: "owner" | "run", text: string): ChatMessage {
  return {
    seq,
    at: new Date(T0 + seq * 1_000).toISOString(),
    role,
    text,
    images: [],
    deliveredAt: null,
  };
}

/**
 * The transcript of a park in which the owner ANSWERED one question and ASKED
 * ABOUT another. Written in the server's own shapes: `questionText` blocks,
 * `PlanDriver#reask` re-posting only what is still open.
 */
const ASKED_BACK: readonly ChatMessage[] = [
  say(1, "run", "A single-page portfolio: intro, project grid, contact line."),
  say(
    2,
    "run",
    "PQ-1: How many projects should the grid show?\nPQ-2: Should each project have its own page?",
  ),
  say(3, "owner", "PQ-2: one page is enough. PQ-1: what do you mean by the grid?"),
  say(4, "run", "The grid is the row of project cards under the intro."),
  say(5, "run", "PQ-1: How many projects should the grid show?"),
];

const PARK_LINE =
  "the planning seat proposed 3 question(s) and 2 earned a place. The run is waiting for an " +
  "answer in the chat; POST /api/runs/x/messages carries one. With no answer inside 20 minutes " +
  "the run proceeds on what it assumed, and the assumptions are recorded.";

const RECORDED_LINE = "recorded against PQ-2 (answered, addressed): one page is enough";

test("a question asked back stays OPEN, and the one he answered does not", () => {
  const dialogue = planDialogueFrom({
    messages: ASKED_BACK,
    trace: [line(PARK_LINE), line(RECORDED_LINE, 60_000)],
    phase: "plan",
    status: "awaiting_input",
  });

  const byId = Object.fromEntries((dialogue?.questions ?? []).map((q) => [q.id, q]));

  // THE ASSERTION THE WHOLE SURFACE TURNS ON. He typed a question about PQ-1 in
  // the same message that answered PQ-2. PQ-1 must still be open.
  expect(byId["PQ-1"]?.state).toBe("open");
  // AND THE POSITIVE CONTROL BESIDE IT — without this a derivation that reports
  // everything open passes the line above. PQ-2 is settled and carries what the
  // run wrote down, not what he typed.
  expect(byId["PQ-2"]?.state).toBe("answered");
  expect(byId["PQ-2"]?.recorded).toBe("one page is enough");
});

test("the seat's prose reply is a message, not a question card", () => {
  const dialogue = planDialogueFrom({
    messages: ASKED_BACK,
    trace: [line(PARK_LINE)],
    phase: "plan",
    status: "awaiting_input",
  });

  // Two questions were ever asked and the seat spoke three times. A prose row
  // read as a question block would show up as a third question.
  expect(dialogue?.questions).toHaveLength(2);
  expect(questionLinesIn("The grid is the row of project cards under the intro.")).toBeNull();
  // POSITIVE CONTROL: the real block still parses, so the null above is not a
  // function that rejects everything.
  expect(questionLinesIn("PQ-1: How many?\nPQ-2: Which one?")).toHaveLength(2);
});

test("the plan is the first prose row, and it is not mistaken for a reply", () => {
  const dialogue = planDialogueFrom({
    messages: ASKED_BACK,
    trace: [],
    phase: "plan",
    status: "awaiting_input",
  });
  expect(dialogue?.plan).toBe("A single-page portfolio: intro, project grid, contact line.");
  // The seat's LATER prose row is a turn in the thread, not a second plan.
  expect(
    dialogue?.items.some(
      (item) => item.kind === "said" && item.text.startsWith("The grid is the row"),
    ),
  ).toBe(true);
});

test("a closed dialogue has nothing open, however the last block reads", () => {
  const dialogue = planDialogueFrom({
    messages: ASKED_BACK,
    trace: [line(PARK_LINE), line(RECORDED_LINE, 60_000)],
    // THE RUN HAS MOVED ON. The newest block still lists PQ-1 — the server does
    // not retract a question, it just stops re-asking — so the only thing that
    // can say the dialogue is over is the run's own state.
    phase: "build",
    status: "running",
  });
  expect(dialogue?.parked).toBe(false);
  expect(dialogue?.questions.some((question) => question.state === "open")).toBe(false);
});

test("a run that never planned has no dialogue at all", () => {
  const dialogue = planDialogueFrom({
    messages: [say(1, "owner", "Give me the link to the website"), say(2, "run", "Here it is.")],
    trace: [line("captured https://example.com/ at 3 width(s)")],
    phase: "build",
    status: "running",
  });
  expect(dialogue).toBeNull();
});

/* ------------------------------------------------------------------ */

test("a response body with no `messages` key does not take the page down", () => {
  /*
   * NOT A HYPOTHETICAL, AND NOT A CAST FOR CONVENIENCE. `src/lib/api.ts` returns
   * `parsed as T` and validates nothing, so a route that answers `{}` — a run
   * recorded before a field existed, a fixture that stubs the endpoint loosely —
   * puts `undefined` behind a type that says `readonly ChatMessage[]`. The double
   * assertion here reproduces exactly that, no more.
   *
   * IT WAS A REAL CRASH: "Uncaught TypeError: input.messages is not iterable",
   * thrown inside a `useMemo` during render, which blanks the run page. Six
   * `design-lock.browser.spec.ts` tests went red on it before this guard existed.
   */
  const noMessages = undefined as unknown as readonly ChatMessage[];
  const noTrace = undefined as unknown as readonly TraceEntry[];
  expect(() =>
    planDialogueFrom({
      messages: noMessages,
      trace: noTrace,
      phase: "plan",
      status: "awaiting_input",
    }),
  ).not.toThrow();
  expect(
    planDialogueFrom({ messages: noMessages, trace: [], phase: "plan", status: "awaiting_input" }),
  ).toBeNull();
  // AND THE TRACE ALONE, because a park whose questions arrived and whose log did
  // not must still draw the questions rather than throwing on the clock.
  expect(
    planDialogueFrom({ messages: ASKED_BACK, trace: noTrace, phase: "plan", status: "awaiting_input" })
      ?.questions,
  ).toHaveLength(2);
});

test("the composed strings are the ones the server's classifier reads correctly", () => {
  /*
   * MEASURED, NOT REASONED. These four expectations were taken by running the
   * compiled `server/dist/plan-state.js` against these exact strings with two
   * open questions and a null seat:
   *
   *   "PQ-1: six"                       -> answer,  PQ-1, addressed
   *   "PQ-1: what do you mean by that?" -> clarify, PQ-1, addressed
   *   "you decide (PQ-1)"               -> decline, PQ-1, addressed, recorded as
   *                                        the question's own ifUnanswered
   *   "you decide"                      -> decline, EVERY open question
   *
   * The one that fails is the obvious one — `PQ-1: you decide` comes back as an
   * ANSWER whose recorded text is "you decide", because `declineIntent` requires
   * the phrase at the START of the normalised body and the id displaces it.
   */
  expect(composeAnswer("PQ-1", " six ")).toBe("PQ-1: six");
  expect(composeAsk("PQ-1", "what do you mean by that")).toBe("PQ-1: what do you mean by that?");
  expect(composeAsk("PQ-1", "which image?")).toBe("PQ-1: which image?");

  const decline = composeDecline("PQ-1");
  expect(decline).toBe("you decide (PQ-1)");
  // THE PROPERTY, NOT JUST THE STRING: the decline phrase has to come first or
  // the server records an answer. Asserted separately so a reword that keeps the
  // meaning still has to keep the order.
  expect(decline.startsWith("you decide")).toBe(true);
  expect(decline.indexOf("PQ-1")).toBeGreaterThan(decline.indexOf("you decide"));
  expect(DECLINE_ALL).toBe("you decide");
});

test("the countdown says `closing` rather than going negative", () => {
  const deadline = T0 + 20 * 60_000;
  expect(planCountdown(deadline, T0)).toEqual({ kind: "left", minutes: 20 });
  expect(planCountdown(deadline, deadline - 30_000)).toEqual({ kind: "left", minutes: 0 });
  // The server's timer fires and the run is REQUEUED, so the row can still read
  // `awaiting_input` for a moment after the window closes.
  expect(planCountdown(deadline, deadline + 60_000)).toEqual({ kind: "closing", minutes: 0 });
  // NO PARK LINE ON THE TRACE MEANS NO CLOCK — never a clock from a default.
  expect(planCountdown(null, T0)).toBeNull();
});

test("the clock is read off the park line's own instant and minute count", () => {
  const dialogue = planDialogueFrom({
    messages: ASKED_BACK,
    trace: [line(PARK_LINE, 5_000)],
    phase: "plan",
    status: "awaiting_input",
  });
  expect(dialogue?.windowMin).toBe(20);
  expect(dialogue?.deadlineMs).toBe(T0 + 5_000 + 20 * 60_000);

  // POSITIVE CONTROL FOR THE ABSENCE: the same transcript with the park line
  // gone yields no deadline, so the assertion above is measuring the line rather
  // than a constant.
  const noLine = planDialogueFrom({
    messages: ASKED_BACK,
    trace: [],
    phase: "plan",
    status: "awaiting_input",
  });
  expect(noLine?.deadlineMs).toBeNull();
});

/* ------------------------------------------------------------------ */

test("an old run's spec pipeline is byte-identical to what it was", () => {
  const trace = [
    line("captured https://kamilborzecki.dev/ at 3 width(s) and read 21 heading(s) off it."),
    line("authoring the held-out acceptance suite from the ticket text alone", 2_000),
  ];
  const stages = specPipelineFrom(trace, "spec", "copy https://kamilborzecki.dev", true);
  // FOUR, AND THE FIRST IS STILL `capture`. A run recorded before the plan phase
  // existed emitted none of its lines, so there is nothing to put in front.
  expect(stages).toHaveLength(4);
  expect(stages[0]?.id).toBe("capture");
});

test("a planned run carries the plan stage at the head of the pipeline", () => {
  const trace = [
    line(PARK_LINE),
    line(
      "the plan dialogue is folded into the brief and this run's ticket is now t-abc (was t-old).",
      60_000,
    ),
    line("captured https://kamilborzecki.dev/ at 3 width(s).", 61_000),
  ];
  const stages = specPipelineFrom(trace, "spec", "copy https://kamilborzecki.dev", true);
  expect(stages[0]?.id).toBe("plan");
  expect(stages[0]?.state).toBe("done");
  expect(stages[1]?.id).toBe("capture");
});

test("during the plan phase the canvas draws the plan and nothing it has not been told", () => {
  const stages = specPipelineFrom([line(PARK_LINE)], "plan", "build me a portfolio", true);
  // ONE STAGE. Four more, all pending, would be four grey rows claiming a shape
  // the run has not reported; `capture` in particular would light as `running`
  // and say a page was being fetched that nothing has started.
  expect(stages).toHaveLength(1);
  expect(stages[0]?.id).toBe("plan");
  expect(stages[0]?.state).toBe("running");
});
