/**
 * plan-state.test.ts — can the run proceed as though a question were answered
 * when it was not?
 *
 * THAT IS THE ONLY QUESTION THIS FILE ASKS, in eight different shapes. Every
 * other property here is bookkeeping; this one is the feature. An owner who
 * types "why does that matter?" and finds his run graded against criteria
 * authored from a guess has been given a worse experience than no plan phase at
 * all, because he believes he was consulted.
 *
 * THE MUTATION WATCHED FOR EACH TEST, all in `plan-state.ts`, watched failing and
 * restored:
 *
 *   a question is not an answer — move the question-mark rung BELOW the
 *                                 single-open-question rung in
 *                                 `classifyOwnerReply`. RED.
 *   decline == never asked      — record the owner's text as the assumption
 *                                 instead of `ifUnanswered`. RED.
 *   fabricated span             — delete the `haystack.includes(...)` check. The
 *                                 seat's invented paraphrase is recorded. RED.
 *   not-addressed               — delete the `targets.includes(...)` check. RED.
 *   not-open                    — delete the `openNow.has(...)` check. RED.
 *   a clarifying turn resolves  — delete the `kind === "clarify"` branch in the
 *     nothing                     resolution loop. RED.
 *   turns are counted           — `turnsUsed + 1` -> `turnsUsed` on a
 *                                 clarification. RED.
 *   closePlan expires the rest  — leave open questions open. RED.
 *   answeredPairs              — include declined questions. RED (this is the
 *                                 one that would let "you decide" game the very
 *                                 number the phase is judged by).
 *   nothing-to-ask closes       — `openPlanState` leaves `closed: null`. RED.
 *   the prefix is addressing    — pass the un-stripped body to `declineIntent`.
 *                                 RED: "PQ-2 you decide" is recorded as an
 *                                 ANSWER whose words are "you decide".
 *   one message, three answers  — drop the `spans.get(...)` lookup in
 *                                 `applyOwnerTurn`. RED: all three questions
 *                                 record the whole message.
 *
 * TWO LINES LEFT THIS LIST WITH THE CODE THEY NAMED: the dialogue-wide cap
 * (`addQuestions` ignoring `questionBudget`) and the host-gated reopen. Both
 * functions had no production caller and were deleted; a mutation log that names
 * code nobody can run is the same defect as a docblock that claims more than the
 * code does.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PlanQuestion } from "./plan-question.js";
import { MAX_OWNER_TURNS } from "./plan-question.js";
import type { OwnerReplyInput, PlanState } from "./plan-state.js";
import {
  answeredPairs,
  applyOwnerTurn,
  classifyOwnerReply,
  closePlan,
  declinedQuestions,
  expiredQuestions,
  openPlanState,
  openQuestions,
  planAssumptions,
  planTurnsExhausted,
} from "./plan-state.js";
import type { PlanProposal, PlanSeatReply } from "./plan-turn.js";

const AT = "2026-08-02T10:00:00.000Z";

function question(id: string, over: Partial<PlanQuestion> = {}): PlanQuestion {
  return {
    id,
    text: "How many projects should the portfolio show?",
    ifUnanswered: "three project cards",
    criterionIfDefault: "The portfolio shows three project cards.",
    criterionIfAnswered: "The portfolio shows six project cards.",
    tier: "FUNCTIONAL",
    ...over,
  };
}

function proposalOf(questions: readonly PlanQuestion[], proposed = questions.length): PlanProposal {
  return { plan: ["A portfolio with a project list."], planNote: null, asked: questions, dropped: [], proposed };
}

function stateOf(...questions: readonly PlanQuestion[]): PlanState {
  return openPlanState(proposalOf(questions), AT);
}

function free(text: string): OwnerReplyInput {
  return { text, questionId: null, intent: null };
}

function seatSaying(over: Partial<PlanSeatReply> = {}): PlanSeatReply {
  return { reply: "", replyNote: null, resolutions: [], ...over };
}

/* -------------------------------------------------------------------------
 * THE FEATURE
 * ---------------------------------------------------------------------- */

test("AN OWNER'S QUESTION IS NOT AN ANSWER, even when only one question is open", () => {
  const before = stateOf(question("PQ-1"));
  assert.equal(openQuestions(before).length, 1);

  const classified = classifyOwnerReply(free("Why does that matter?"), before);
  assert.equal(classified.kind, "clarify");

  // Even with the seat insisting it was answered, and with a span that really IS
  // in his message, nothing resolves. The turn's KIND decides, not the seat.
  const outcome = applyOwnerTurn(before, {
    at: AT,
    ownerText: "Why does that matter?",
    classified,
    seat: seatSaying({
      reply: "Three cards and six cards are different pages.",
      resolutions: [{ id: "PQ-1", kind: "answer", answer: "three", quoted: "that matter" }],
    }),
  });

  assert.equal(openQuestions(outcome.state).length, 1, "the question must still be open");
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.rejected[0]?.reason, "clarifying-turn");
  // It still cost a turn, and it is recorded as its own kind of thing.
  assert.equal(outcome.state.turnsUsed, 1);
  assert.equal(outcome.state.clarifications.length, 1);
  assert.equal(outcome.state.clarifications[0]?.reply, "Three cards and six cards are different pages.");

  // POSITIVE CONTROL: the same one open question, answered rather than queried.
  const answered = applyOwnerTurn(before, {
    at: AT,
    ownerText: "Six of them.",
    classified: classifyOwnerReply(free("Six of them."), before),
    seat: seatSaying(),
  });
  assert.equal(openQuestions(answered.state).length, 0);
});

test("a clarification that NAMES a question still resolves nothing — the hardest case", () => {
  // This is where the clarify guard earns its keep. "PQ-1 what do you mean by a
  // project card?" is attributable — the owner named the question himself — so
  // every other rule in the arbiter is satisfied: the id is open, it is
  // addressed, and the seat can quote a real span out of it. Only the KIND stops
  // it, and if it did not, an owner asking what a question meant would have that
  // very question marked answered by his request for an explanation.
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const text = "PQ-1 what do you mean by a project card?";
  const classified = classifyOwnerReply(free(text), before);

  assert.equal(classified.kind, "clarify");
  assert.deepEqual(classified.targets, ["PQ-1"], "it IS attributable — that is what makes this the hard case");

  const outcome = applyOwnerTurn(before, {
    at: AT,
    ownerText: text,
    classified,
    seat: seatSaying({
      reply: "A card with a title, a thumbnail and a link.",
      resolutions: [{ id: "PQ-1", kind: "answer", answer: "a project card", quoted: "a project card" }],
    }),
  });

  assert.deepEqual(openQuestions(outcome.state).map((q) => q.id), ["PQ-1", "PQ-2"]);
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.rejected[0]?.reason, "clarifying-turn");
  assert.equal(outcome.state.clarifications[0]?.about[0], "PQ-1");
});

test("AN EMPTY ANSWER IS NOT AN ANSWER — including on the structural path", () => {
  // The structural rungs do not inspect the text, and the structural path is the
  // one the client is supposed to always take, so the hole was on the safest
  // route. Two inputs reach the recorder empty; both must leave it open.
  for (const [what, input] of [
    ["an empty box the client let through", { text: "", questionId: "PQ-1", intent: "answer" as const }],
    ["a bare id with nothing after it", { text: "PQ-1", questionId: null, intent: null }],
  ] as const) {
    const before = stateOf(question("PQ-1"));
    const outcome = applyOwnerTurn(before, {
      at: AT,
      ownerText: input.text,
      classified: classifyOwnerReply(input, before),
      seat: seatSaying(),
    });

    assert.equal(openQuestions(outcome.state).length, 1, what);
    assert.equal(outcome.accepted.length, 0, what);
    assert.equal(outcome.rejected[0]?.reason, "empty-answer", what);
    // It still cost a turn — the owner did send something.
    assert.equal(outcome.state.turnsUsed, 1, what);
    // AND THE PAIR THE TRACER WOULD HAVE SEEN NEVER EXISTS. With an empty answer
    // recorded, the question's own text carries enough content tokens to have a
    // criterion stamped `answered` on the strength of nothing.
    assert.deepEqual(answeredPairs(outcome.state), [], what);
  }

  // POSITIVE CONTROL: the same structural path with words in it resolves.
  const before = stateOf(question("PQ-1"));
  const good = applyOwnerTurn(before, {
    at: AT,
    ownerText: "Six.",
    classified: classifyOwnerReply({ text: "Six.", questionId: "PQ-1", intent: "answer" }, before),
    seat: seatSaying(),
  });
  assert.equal(openQuestions(good.state).length, 0);
});

test("a free-typed reply with several questions open resolves NOTHING it cannot attribute", () => {
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const classified = classifyOwnerReply(free("six"), before);
  assert.equal(classified.kind, "clarify");
  assert.deepEqual(classified.targets, []);
  assert.match(classified.why, /2 questions were open/);

  const outcome = applyOwnerTurn(before, { at: AT, ownerText: "six", classified, seat: seatSaying() });
  assert.equal(openQuestions(outcome.state).length, 2);
});

test("the structural path resolves exactly the question the client named", () => {
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const input: OwnerReplyInput = { text: "Six of them.", questionId: "PQ-2", intent: "answer" };
  const classified = classifyOwnerReply(input, before);

  assert.equal(classified.attribution, "structural");
  assert.deepEqual(classified.targets, ["PQ-2"]);

  const outcome = applyOwnerTurn(before, { at: AT, ownerText: input.text, classified, seat: seatSaying() });
  assert.deepEqual(openQuestions(outcome.state).map((q) => q.id), ["PQ-1"]);
  assert.equal(outcome.accepted[0]?.attribution, "structural");
});

/**
 * THE PREFIX IS ADDRESSING AND IT MUST COME OFF BEFORE THE INTENT IS READ.
 *
 * "PQ-2 you decide" reached `declineIntent` with the prefix still on it, so the
 * flattened form was `pq2 you decide`, no phrase matched, and the turn was
 * classified as an ANSWER. `applyOwnerTurn` then stripped the id and recorded the
 * words "you decide" as PQ-2's answer — which is the one outcome the design
 * forbids: `answeredPairs` hands the tracer a pair, and a criterion authored from
 * a refusal to state a preference reads as traced to words the owner wrote.
 * Declining everything would then MOVE the number this phase is judged by.
 *
 * MUTATION: in `classifyOwnerReply`'s addressed rung, pass `body` to
 * `declineIntent` instead of the stripped text. The first assertion goes red.
 */
test('"PQ-2 you decide" is a DECLINE of PQ-2, not an answer whose words are "you decide"', () => {
  const before = stateOf(
    question("PQ-1"),
    question("PQ-2", { text: "Should the contact form send email?", ifUnanswered: "a mailto link, no server" }),
    question("PQ-3", { text: "Should the header carry a logo?" }),
  );
  const text = "PQ-2 you decide";
  const classified = classifyOwnerReply(free(text), before);

  assert.equal(classified.kind, "decline", "the prefix is addressing; what follows it is the intent");
  assert.deepEqual(classified.targets, ["PQ-2"], "he named one question, so only that one is declined");
  assert.equal(classified.attribution, "addressed");

  const outcome = applyOwnerTurn(before, { at: AT, ownerText: text, classified, seat: seatSaying() });
  assert.equal(outcome.accepted[0]?.status, "declined");
  assert.equal(
    outcome.accepted[0]?.recorded,
    "a mailto link, no server",
    "a decline records the question's own default, byte for byte what an expiry records",
  );
  assert.deepEqual(
    answeredPairs(outcome.state),
    [],
    "THE NUMBER: a decline must hand the tracer nothing, or 'you decide' games the measurement",
  );
  assert.deepEqual(
    openQuestions(outcome.state).map((q) => q.id),
    ["PQ-1", "PQ-3"],
    "the two he did not name are still open",
  );

  // POSITIVE CONTROL: the same prefix over an actual answer is still an answer.
  const answering = classifyOwnerReply(free("PQ-2 yes, it should send email"), before);
  assert.equal(answering.kind, "answer");
});

/**
 * THE CLAIM ON `questionText`'S DOCBLOCK, TURNED INTO A CHECK.
 *
 * It says the `PQ-n` prefix "lets him answer three questions in one message and
 * have each land on the right one". Before this test, all three questions were
 * marked answered and each one recorded THE WHOLE MESSAGE — `stripQuestionIds`
 * takes off only the LEADING run of ids, so PQ-1's answer was
 * "six cards. PQ-2 no, a mailto link. PQ-3 yes, the wordmark", and PQ-2's and
 * PQ-3's were the same string. Three questions, one answer, repeated: the
 * criteria author is handed two answers that belong to other questions and
 * `answeredPairs` reports three pairs that are not three answers.
 *
 * MUTATION: delete the `spans.get(...)` lookup in `applyOwnerTurn` so every
 * target falls back to `stripQuestionIds(owner)`. The per-answer assertion goes
 * red on PQ-2 and PQ-3.
 */
test("three prefixed answers in ONE message land three different answers, not one repeated", () => {
  const before = stateOf(
    question("PQ-1"),
    question("PQ-2", { text: "Should the contact form send email?" }),
    question("PQ-3", { text: "Should the header carry a logo?" }),
  );
  const text = "PQ-1 six cards. PQ-2 no, a mailto link. PQ-3 yes, the wordmark";
  const classified = classifyOwnerReply(free(text), before);

  assert.equal(classified.attribution, "addressed");
  assert.deepEqual([...classified.targets].sort(), ["PQ-1", "PQ-2", "PQ-3"]);

  const outcome = applyOwnerTurn(before, { at: AT, ownerText: text, classified, seat: seatSaying() });
  assert.equal(openQuestions(outcome.state).length, 0, "one message settled all three");
  assert.deepEqual(
    outcome.state.questions.map((entry) => entry.answer?.text),
    ["six cards.", "no, a mailto link.", "yes, the wordmark"],
    "each question carries ITS OWN span of the message",
  );
  assert.deepEqual(
    answeredPairs(outcome.state).map((pair) => pair.answer),
    ["six cards.", "no, a mailto link.", "yes, the wordmark"],
    "the tracer sees three answers, not the same sentence three times",
  );

  // AND THE SPAN IS NOT ALLOWED TO INVENT ONE. "PQ-1 and PQ-2 yes" puts the
  // connector "and" between two ids, and a span rule that took it literally would
  // record the word "and" as PQ-1's answer — a guess wearing the owner's name,
  // which is worse than the whole-message fallback it replaces.
  const joined = "PQ-1 and PQ-2 yes";
  const both = applyOwnerTurn(before, {
    at: AT,
    ownerText: joined,
    classified: classifyOwnerReply(free(joined), before),
    seat: seatSaying(),
  });
  assert.equal(both.state.questions[0]?.answer?.text, "and PQ-2 yes", "a connector is not an answer");
  assert.equal(both.state.questions[1]?.answer?.text, "yes");
});

test("an owner who names PQ-n in free text is `addressed`, not `inferred`", () => {
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const classified = classifyOwnerReply(free("PQ-2 yes, it should send email"), before);

  assert.equal(classified.attribution, "addressed");
  assert.deepEqual(classified.targets, ["PQ-2"]);

  const outcome = applyOwnerTurn(before, {
    at: AT,
    ownerText: "PQ-2 yes, it should send email",
    classified,
    seat: seatSaying(),
  });
  // The id is addressing, not content — it must not end up inside the answer.
  assert.equal(outcome.accepted[0]?.recorded, "yes, it should send email");
});

test('"YOU DECIDE" LANDS EXACTLY WHERE NEVER ASKING WOULD HAVE — the same string', () => {
  const q = question("PQ-1");
  const outcome = applyOwnerTurn(stateOf(q), {
    at: AT,
    ownerText: "you decide",
    classified: classifyOwnerReply(free("you decide"), stateOf(q)),
    seat: seatSaying(),
  });
  const declined = outcome.state;
  const expired = closePlan(stateOf(q), "window expired", AT);

  // WHAT GETS ECHOED BACK INTO THE CHAT is the assumption, not his words. The
  // design's only mitigation for a wrong resolution is that he can see it, and
  // an echo reading "recorded: PQ-1 -> you decide" tells him nothing about what
  // the run is now going to do.
  assert.equal(outcome.accepted[0]?.status, "declined");
  assert.equal(outcome.accepted[0]?.recorded, q.ifUnanswered);

  assert.equal(declinedQuestions(declined).length, 1);
  assert.equal(expiredQuestions(expired).length, 1);
  // THE ASSERTION THAT MATTERS: declining costs the owner nothing, because the
  // recorded assumption is byte-for-byte what the run would have assumed anyway.
  assert.equal(declinedQuestions(declined)[0]?.assumed, q.ifUnanswered);
  assert.equal(expiredQuestions(expired)[0]?.assumed, q.ifUnanswered);
  assert.equal(declinedQuestions(declined)[0]?.assumed, expiredQuestions(expired)[0]?.assumed);

  // And a declined question contributes NO pair, so it cannot move the number.
  assert.deepEqual(answeredPairs(declined), []);
  assert.deepEqual(planAssumptions(declined), [{ id: "PQ-1", assumed: q.ifUnanswered }]);
});

test('"you decide the palette but there must be three cards" is an ANSWER, not a decline', () => {
  const before = stateOf(question("PQ-1"));
  const text = "you decide the palette but there must be three project cards";
  const classified = classifyOwnerReply(free(text), before);
  assert.equal(classified.kind, "answer");

  // POSITIVE CONTROL for the phrase list itself.
  assert.equal(classifyOwnerReply(free("up to you"), before).kind, "decline");
});

test("a fabricated quote resolves nothing — the owner's own words are kept instead", () => {
  const before = stateOf(question("PQ-1"));
  const ownerText = "Six of them.";
  const outcome = applyOwnerTurn(before, {
    at: AT,
    ownerText,
    classified: classifyOwnerReply(free(ownerText), before),
    seat: seatSaying({
      resolutions: [
        { id: "PQ-1", kind: "answer", answer: "twelve, in a carousel", quoted: "twelve in a carousel please" },
      ],
    }),
  });

  assert.equal(outcome.rejected[0]?.reason, "quote-not-in-turn");
  // The question IS answered — the owner did answer it — but with HIS wording.
  const answer = outcome.state.questions[0]?.answer;
  assert.equal(answer?.text, ownerText);
  assert.equal(answer?.paraphrased, false);

  // POSITIVE CONTROL: a paraphrase resting on a span he really typed is taken.
  const honest = applyOwnerTurn(before, {
    at: AT,
    ownerText,
    classified: classifyOwnerReply(free(ownerText), before),
    seat: seatSaying({ resolutions: [{ id: "PQ-1", kind: "answer", answer: "six project cards", quoted: "Six of" }] }),
  });
  assert.equal(honest.rejected.length, 0);
  assert.equal(honest.state.questions[0]?.answer?.text, "six project cards");
  assert.equal(honest.state.questions[0]?.answer?.paraphrased, true);
});

test("a seat cannot resolve a question the owner did not address in this turn", () => {
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const outcome = applyOwnerTurn(before, {
    at: AT,
    ownerText: "Six of them.",
    classified: classifyOwnerReply({ text: "Six of them.", questionId: "PQ-1", intent: "answer" }, before),
    seat: seatSaying({
      resolutions: [
        { id: "PQ-1", kind: "answer", answer: "six", quoted: "Six of them" },
        { id: "PQ-2", kind: "answer", answer: "yes, email", quoted: "Six of them" },
      ],
    }),
  });

  assert.equal(outcome.rejected.length, 1);
  assert.equal(outcome.rejected[0]?.id, "PQ-2");
  assert.equal(outcome.rejected[0]?.reason, "not-addressed");
  assert.deepEqual(openQuestions(outcome.state).map((q) => q.id), ["PQ-2"]);
});

test("a seat cannot resolve a question that is not open", () => {
  const before = stateOf(question("PQ-1"));
  const settled = closePlan(before, "window expired", AT);
  const outcome = applyOwnerTurn(settled, {
    at: AT,
    ownerText: "Six of them.",
    classified: { kind: "answer", targets: ["PQ-1"], attribution: "structural", why: "test" },
    seat: seatSaying({ resolutions: [{ id: "PQ-1", kind: "answer", answer: "six", quoted: "Six of them" }] }),
  });

  assert.equal(outcome.rejected[0]?.reason, "not-open");
  assert.equal(outcome.state.questions[0]?.status, "expired");
  assert.equal(outcome.accepted.length, 0);
});

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

test("every owner turn costs a turn — a clarification costs a turn and no answer slot", () => {
  let state = stateOf(question("PQ-1"));
  for (let turn = 0; turn < MAX_OWNER_TURNS; turn += 1) {
    const text = "What do you mean by that?";
    state = applyOwnerTurn(state, {
      at: AT,
      ownerText: text,
      classified: classifyOwnerReply(free(text), state),
      seat: seatSaying({ reply: "How many cards get built." }),
    }).state;
  }
  assert.equal(state.turnsUsed, MAX_OWNER_TURNS);
  assert.equal(planTurnsExhausted(state), true);
  // Six clarifications and the question is still open — which is exactly why the
  // turn cap exists and why reaching it must not be treated as a failure.
  assert.equal(openQuestions(state).length, 1);

  const closed = closePlan(state, "turn cap", AT);
  assert.equal(openQuestions(closed).length, 0);
  assert.equal(expiredQuestions(closed)[0]?.assumed, "three project cards");
  assert.match(String(closed.closed?.detail), /6-turn bound/);
});

test("closing is idempotent — a late turn cannot rewrite why the run proceeded", () => {
  const first = closePlan(stateOf(question("PQ-1")), "window expired", AT);
  const again = closePlan(first, "turn cap", "2026-08-02T11:00:00.000Z");
  assert.equal(again.closed?.reason, "window expired");
  assert.equal(again.closed?.at, AT);
});

/*
 * TWO TESTS WERE DELETED HERE WITH THE FUNCTION THEY DROVE — "the question cap
 * is across the whole dialogue, not per turn" and "a later turn cannot re-ask an
 * earlier turn's question in different words", both of `addQuestions`. They
 * exercised a cap and a cross-turn duplicate rule that no run could ever reach,
 * which made them two green tests over a feature the owner did not have. The
 * per-turn and per-proposal caps that DO run are covered in
 * `plan-question.test.ts` (`capQuestions`, `selectQuestions`).
 */

/**
 * THE VERBS THE RUN CANNOT REACH ARE NOT EXPORTED, AND THIS IS THE CHECK THAT
 * KEEPS IT THAT WAY.
 *
 * `reopenQuestion` and `addQuestions` were exported, documented as mechanisms
 * ("the mitigation for the residual", "the cap is across the dialogue"), and
 * tested — and nothing in the running program called either. Measured with
 * `grep -rn` across `src/`: the only references outside `plan-state.ts` were in
 * this file and in two docblocks that cited them as if they were live. A tested
 * export with no caller is how this repository grows a green suite over nothing,
 * so they were deleted rather than left as a claim. `questionBudget` went with
 * `addQuestions`, its only caller.
 *
 * WHAT WOULD BE NEEDED TO BRING EACH BACK, so this test is a gate and not a ban:
 *   `reopenQuestion` — a route and a control that let the owner say "that is not
 *                      what I meant about PQ-2" while the dialogue is open. The
 *                      wire (`POST /api/runs/:id/messages`) carries no question
 *                      id today, which is the same gap that keeps every plan
 *                      answer on the `inferred`/`addressed` rungs.
 *   `addQuestions`   — a follow-up turn that may propose questions. `PlanSeatReply`
 *                      (plan-turn.ts) carries `reply` and `resolutions` and no
 *                      questions at all, so the parser would have to admit them
 *                      first.
 * Wire one, and delete its name from the list below in the same commit.
 */
test("plan-state exports no dialogue verb the running program cannot reach", async () => {
  const surface: Record<string, unknown> = { ...(await import("./plan-state.js")) };
  for (const dead of ["reopenQuestion", "addQuestions", "questionBudget"]) {
    assert.equal(
      dead in surface,
      false,
      `${dead} is exported again — either a production caller exists (say which, here) or it is a claim with nothing behind it`,
    );
  }
  // POSITIVE CONTROL: the same check over a verb the run really does call, so a
  // test that could only ever pass is not mistaken for evidence.
  assert.equal("applyOwnerTurn" in surface, true, "plan-dialogue.ts calls this on every owner turn");
});

test("a turn with nothing worth asking closes at once, and says WHICH of the two happened", () => {
  const nothingProposed = openPlanState(proposalOf([], 0), AT);
  assert.equal(nothingProposed.closed?.reason, "nothing to ask");
  assert.match(String(nothingProposed.closed?.detail), /proposed no questions/);

  // The other way to arrive here is a defect and must read differently: the seat
  // spent a call, proposed five, and every one of them was generic.
  const allRefused = openPlanState(proposalOf([], 5), AT);
  assert.equal(allRefused.closed?.reason, "nothing to ask");
  assert.match(String(allRefused.closed?.detail), /proposed 5 question\(s\) and none earned a place/);

  // POSITIVE CONTROL: a turn WITH a question does not close.
  assert.equal(stateOf(question("PQ-1")).closed, null);
});

test("`you decide` with several open declines all of them, and says it did", () => {
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const classified = classifyOwnerReply(free("you decide"), before);
  assert.equal(classified.kind, "decline");
  assert.equal(classified.targets.length, 2);
  assert.equal(classified.attribution, "inferred");
  assert.match(classified.why, /declining every open question \(2\)/);

  const outcome = applyOwnerTurn(before, {
    at: AT,
    ownerText: "you decide",
    classified,
    seat: seatSaying(),
  });
  assert.equal(declinedQuestions(outcome.state).length, 2);
  assert.equal(openQuestions(outcome.state).length, 0);
});

test("only answered questions produce a pair for the tracer", () => {
  const before = stateOf(question("PQ-1"), question("PQ-2", { text: "Should the contact form send email?" }));
  const answered = applyOwnerTurn(before, {
    at: AT,
    ownerText: "Six of them.",
    classified: classifyOwnerReply({ text: "Six of them.", questionId: "PQ-1", intent: "answer" }, before),
    seat: seatSaying(),
  }).state;
  const settled = closePlan(answered, "window expired", AT);

  assert.deepEqual(answeredPairs(settled), [
    { question: "How many projects should the portfolio show?", answer: "Six of them." },
  ]);
  assert.deepEqual(planAssumptions(settled), [{ id: "PQ-2", assumed: "three project cards" }]);
});
