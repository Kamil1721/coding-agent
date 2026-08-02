/**
 * plan-question.test.ts — can a generic question get through?
 *
 * EVERY TEST HERE WOULD PASS AGAINST A FUNCTION THAT REFUSED EVERYTHING, except
 * the positive controls, and that is why every refusal test carries one in the
 * same assertion block. A worth rule that refuses all questions and a worth rule
 * that refuses the right ones produce the same `asked: []` on a bad seat's turn,
 * and only one of them is the feature.
 *
 * THE MUTATION WATCHED FOR EACH TEST, all applied to `plan-question.ts`, watched
 * failing, and restored:
 *
 *   generic vs specific   — `sameSet(ifDefault, ifAnswered)` -> raw string
 *                           inequality of the two criteria. The two generic
 *                           candidates ARE different strings ("site" vs "page"),
 *                           so the generic question is accepted. RED.
 *                         — and `questionEarnsItsPlace` -> `return {ok:false,…}`
 *                           at the top. The positive control goes RED, which is
 *                           what proves the test is not passing on a refuse-all.
 *   no-criterion-pair     — delete the empty-criterion branch. RED.
 *   criteria-do-not-differ— covered by the first mutation above.
 *   no-default            — delete the `ifUnanswered` branch. RED.
 *   not-one-sentence      — `isOneSentence` -> `return true`. RED.
 *   too-long              — `MAX_QUESTION_CHARS` 140 -> 1000. RED.
 *   answered-by-the-brief — delete the subset branch. RED.
 *   criterion-needs-an-   — empty `UNGRADEABLE_REFERENCES`. RED.
 *     attachment
 *   ranking               — drop the tier key from `rankQuestions`'s comparator.
 *                           RED (a QUALITY question with a wide separation leads
 *                           a BLOCKING one).
 *   the cap's record      — `capQuestions` -> `{asked: ranked.slice(0, limit),
 *                           dropped: []}`. RED.
 *   duplicate             — delete the dedup loop in `selectQuestions`. RED.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PlanQuestion, PlanQuestionTier } from "./plan-question.js";
import {
  MAX_QUESTIONS_ASKED,
  MAX_QUESTION_CHARS,
  capQuestions,
  isOneSentence,
  questionEarnsItsPlace,
  questionIdsIn,
  questionSeparation,
  rankQuestions,
  selectQuestions,
} from "./plan-question.js";

function q(over: Partial<PlanQuestion> = {}): PlanQuestion {
  return {
    id: "",
    text: "How many projects should the portfolio show?",
    ifUnanswered: "three project cards",
    criterionIfDefault: "The portfolio shows three project cards.",
    criterionIfAnswered: "The portfolio shows six project cards.",
    tier: "FUNCTIONAL",
    ...over,
  };
}

/** A brief with no content tokens of its own, so only the rule under test can fire. */
const THIN = "Build me a website.";

test("the generic question is refused and the specific one is asked — both directions", () => {
  // NEGATIVE. "site" and "page" are both in TICKET_BOILERPLATE, so after the
  // content filter these two candidates are the SAME criterion. Whatever he
  // answers, the same sentence gets written, and the interruption bought nothing.
  const generic = q({
    text: "What colour scheme would you like?",
    ifUnanswered: "a coherent palette chosen by the builder",
    criterionIfDefault: "The site has a coherent colour scheme.",
    criterionIfAnswered: "The page has a coherent colour scheme.",
  });
  const refused = questionEarnsItsPlace(generic, THIN);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.refusal : "", "criteria-do-not-differ");

  // POSITIVE CONTROL, in the same test on purpose: without it this file would
  // pass against a function that refused every question ever proposed.
  assert.equal(questionEarnsItsPlace(q(), THIN).ok, true);
});

test("a question that names no criterion pair is refused by the rule, not ranked low", () => {
  const half = q({ criterionIfAnswered: "" });
  const verdict = questionEarnsItsPlace(half, THIN);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.refusal : "", "no-criterion-pair");
  assert.equal(questionEarnsItsPlace(q(), THIN).ok, true);
});

test("a question with no stated default is refused — declining it could not be free", () => {
  const verdict = questionEarnsItsPlace(q({ ifUnanswered: "   " }), THIN);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.refusal : "", "no-default");
  assert.equal(questionEarnsItsPlace(q(), THIN).ok, true);
});

test("brevity is enforced: two sentences is refused, one sentence with a mark is not", () => {
  assert.equal(isOneSentence("How many projects should the portfolio show?"), true);
  assert.equal(isOneSentence("How many projects? Also, what colour?"), false);

  const verdict = questionEarnsItsPlace(q({ text: "How many projects? Also, what colour?" }), THIN);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.refusal : "", "not-one-sentence");
  assert.equal(questionEarnsItsPlace(q(), THIN).ok, true);
});

test("a question past the character bound is refused, and the refusal names the size", () => {
  const long = `How many ${"very ".repeat(40)}large project cards should the portfolio show?`;
  assert.ok(long.length > MAX_QUESTION_CHARS);
  const verdict = questionEarnsItsPlace(q({ text: long }), THIN);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.refusal : "", "too-long");
  assert.match(verdict.ok === false ? verdict.detail : "", /characters/);
  assert.equal(questionEarnsItsPlace(q(), THIN).ok, true);
});

test("a question the ticket already answers is refused; one it does not is asked", () => {
  const brief = "The portfolio must show projects.";
  const already = questionEarnsItsPlace(q(), brief);
  assert.equal(already.ok, false);
  assert.equal(already.ok === false ? already.refusal : "", "answered-by-the-brief");

  // POSITIVE CONTROL against the SAME brief — this is what separates "the rule
  // reads the brief" from "the rule refuses whenever a brief is passed".
  const fresh = q({
    text: "How many columns should the grid have?",
    ifUnanswered: "a single column",
    criterionIfDefault: "The grid renders one column.",
    criterionIfAnswered: "The grid renders three columns.",
  });
  assert.equal(questionEarnsItsPlace(fresh, brief).ok, true);
});

test("a criterion that could only be graded by opening an attachment is refused", () => {
  // The spec seat runs `tools: []` (subscription-caller.ts:851) and cannot open a
  // file. "matches the reference image" grades green or red for reasons nothing
  // can trace, which is the failure ticket-refs.ts's header names.
  const unseeable = q({
    text: "Which of the two references should the layout follow?",
    ifUnanswered: "the first one",
    criterionIfDefault: "The layout follows the first reference image.",
    criterionIfAnswered: "The layout follows the second reference image.",
  });
  const verdict = questionEarnsItsPlace(unseeable, THIN);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false ? verdict.refusal : "", "criterion-needs-an-attachment");

  // POSITIVE CONTROL: the SAME question converted into words he types. This is
  // the whole point of asking about a picture nobody downstream can see.
  const converted = q({
    text: "Should the layout be a single column or a two-column grid?",
    ifUnanswered: "a single column",
    criterionIfDefault: "The layout renders a single column.",
    criterionIfAnswered: "The layout renders a two-column grid.",
  });
  assert.equal(questionEarnsItsPlace(converted, THIN).ok, true);
});

test("ranking is by how much the answer changes the build, not by how wide the wording is", () => {
  const blocking = q({
    text: "Should the contact form send email or only validate?",
    tier: "BLOCKING",
    criterionIfDefault: "The form validates.",
    criterionIfAnswered: "The form delivers.",
  });
  const quality = q({
    text: "How many columns should the grid have?",
    tier: "QUALITY",
    criterionIfDefault: "The grid renders one narrow column of stacked cards.",
    criterionIfAnswered: "The grid renders four wide rows of tabular summaries.",
  });
  // The QUALITY question has the WIDER separation, deliberately: without the tier
  // key it would sort first, which is what the mutation demonstrates.
  assert.ok(questionSeparation(quality) > questionSeparation(blocking));
  assert.deepEqual(
    rankQuestions([quality, blocking]).map((entry) => entry.tier),
    ["BLOCKING", "QUALITY"],
  );

  // Within a tier, the wider separation leads.
  const narrow = q({ criterionIfDefault: "Three cards.", criterionIfAnswered: "Six cards." });
  const wide = q({
    text: "Should the hero carry a headline and a call to action?",
    criterionIfDefault: "The hero carries a headline.",
    criterionIfAnswered: "The hero omits every heading and renders a full-bleed photograph instead.",
  });
  assert.deepEqual(rankQuestions([narrow, wide]).map((entry) => entry.text), [wide.text, narrow.text]);
});

test("the cap says what it bounded — a dropped question is recorded, not discarded", () => {
  const tiers: readonly PlanQuestionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];
  const many = Array.from({ length: 7 }, (_, index) =>
    q({
      text: `Should section ${String(index)} of the portfolio carry a caption?`,
      ifUnanswered: `section ${String(index)} carries no caption`,
      criterionIfDefault: `Section ${String(index)} renders without a caption.`,
      criterionIfAnswered: `Section ${String(index)} renders a caption beneath its heading.`,
      tier: tiers[index % 3] ?? "QUALITY",
    }),
  );

  const capped = capQuestions(rankQuestions(many), MAX_QUESTIONS_ASKED);
  assert.equal(capped.asked.length, MAX_QUESTIONS_ASKED);
  assert.equal(capped.dropped.length, 7 - MAX_QUESTIONS_ASKED);
  for (const dropped of capped.dropped) {
    assert.equal(dropped.refusal, "over-cap");
    // The record has to be useful, not merely present: it names the rank it held
    // and the assumption the run is now making in its place.
    assert.match(dropped.detail, /ranked \d of 7/);
    assert.match(dropped.detail, /it assumes:/);
  }

  // A spent budget is not an error — everything is recorded and nothing is asked.
  const none = capQuestions(rankQuestions(many), 0);
  assert.equal(none.asked.length, 0);
  assert.equal(none.dropped.length, 7);
});

test("the same question asked twice is asked once, and the second is recorded as a duplicate", () => {
  const first = q({ text: "How many projects should the portfolio show?" });
  const second = q({ text: "The portfolio should show how many projects?" });
  const selected = selectQuestions([first, second], MAX_QUESTIONS_ASKED);

  assert.equal(selected.asked.length, 1);
  assert.equal(selected.dropped.length, 1);
  assert.equal(selected.dropped[0]?.refusal, "duplicate");

  // POSITIVE CONTROL: two genuinely different questions both survive, so this is
  // not passing against a selector that keeps one of anything.
  const different = q({
    text: "Should the grid be one column or three?",
    criterionIfDefault: "The grid renders one column.",
    criterionIfAnswered: "The grid renders three columns.",
  });
  assert.equal(selectQuestions([first, different], MAX_QUESTIONS_ASKED).asked.length, 2);
});

test("PQ ids are found in an owner's free text, in order and de-duplicated", () => {
  assert.deepEqual(questionIdsIn("PQ-2 three of them, and PQ-1 yes, PQ-2 again"), ["PQ-2", "PQ-1"]);
  assert.deepEqual(questionIdsIn("no ids here"), []);
});
