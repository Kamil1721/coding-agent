/**
 * assumptions-answered.test.ts — did answering the questions change the number?
 *
 * THE MEASUREMENT THIS FILE EXISTS FOR, AND IT IS THE PHASE'S SUCCESS CONDITION.
 * The plan phase's whole justification for interrupting the owner is that
 * `inferredCriteria` falls when he answers. Before this change it did not move:
 * measured 2026-08-02 at 16 -> 16 on the run that argued for the phase in the
 * first place. {@link FIXTURE_CRITERIA} and {@link FIXTURE_PROSE} are that run's
 * OWN ticket and its OWN sixteen criteria, lifted verbatim from
 * `dashboard/runs/run-2026-07-30T20-16-40-242Z-052c6e02/results/assumptions.md`,
 * so the number here is the number on disk rather than one a fixture was shaped
 * to produce.
 *
 * WHAT IS INVENTED AND WHAT IS NOT, SAID PLAINLY. The ticket and the criteria
 * are real. The three questions and answers are NOT — that run predates the plan
 * phase and never had a dialogue — so they are written here as the terse replies
 * an owner actually types, and the first test measures the same fixture with the
 * pairs withheld and with the pairs passed. Both numbers come out of the same
 * run of the same code, which is what makes the delta attributable to this
 * change and to nothing else.
 *
 * ─── THE CHEAT THIS FILE IS MOSTLY ABOUT ───
 *
 * Relabelling criteria because a plan block exists somewhere in the brief, or
 * because they match the QUESTION — the machine's own sentence — moves the
 * number without improving anything, and it moves it in the direction that HIDES
 * an inference from the one document written to expose it. Four tests below
 * exist only to fail if that is what happened: the bare-"yes" guard, the
 * specificity guard, the declined-question guard and the paraphrase guard. If
 * the rule is ever loosened to "a pair exists", all four go red.
 *
 * ─── EVERY MUTATION, APPLIED ALONE, COMPILED, WATCHED RED, RESTORED ───
 *
 * Run 2026-08-02. Each count is what ACTUALLY went red across this file and
 * `assumptions-wiring.test.ts` run together (13 tests), not what was expected to.
 *
 *  M1  `extractAssumptions` passes `answered.slice(0, 0)` — i.e. it never
 *      consults the pairs, which is the defect this change fixes → 5 red
 *      (the first is the measurement itself: the number stays at 16)
 *  M2  `answeredSupportFor` drops the `fromAnswer.length === 0` condition, so
 *      the QUESTION alone may carry a match                      → 2 red
 *      (a bare "yes" credits the owner with the machine's sentence)
 *  M3  `answeredSupportFor` uses `shared.length < 1`             → 1 red
 *      (one word in common is a coincidence of vocabulary: 16 -> 8, not 12)
 *  M4  `answeredInOwnerWords` keeps declined questions too, crediting their
 *      `ifUnanswered`                                            → 3 red
 *      ("you decide" comes back reported as "you specified it")
 *  M5  `answeredInOwnerWords` takes `answer.text` unconditionally — i.e. the
 *      seat's paraphrase, which is what `plan-state.ts:answeredPairs` returns
 *                                                                → 1 red
 *  M6  `isStatedByOwner` forgets its `answered` case, restoring the
 *      `source !== "ticket"` both consumers used to copy         → 3 red
 *      (the API count and the verdict page disagree by exactly the answered ones)
 *  M7  `renderAssumptions` drops the ANSWERED section            → 4 red
 *  M8  `renderAssumptions` drops the fourth figure from the count line → 3 red
 *  M9  `verdict.ts`'s provenance switch loses its `answered` arm → DOES NOT
 *      COMPILE ("function lacks ending return statement"), which is the stronger
 *      check and the whole reason that ternary chain became a switch
 *  M10 the `answered` block moves back ABOVE the house-rule block  → 1 red
 *      (this was the code's real state until it was measured: a house rule the
 *      owner was asked about came back `answered`, which drops it out of the
 *      number the phase is judged by. The guard test was written from that
 *      measurement, not from the mutation.)
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { ApiCriterion } from "./api-types.js";
import { answeredInOwnerWords, foldPlanIntoBrief, stripPlanBlock } from "./plan-brief.js";
import type { PlanQuestionState, PlanState } from "./plan-state.js";
import { assumptionsFor, countInferredAssumptions } from "./run-report.js";
import { renderAssumptions } from "./spec-assumptions.js";
import type { AnsweredQuestion, Assumption, AssumptionSource } from "./spec-assumptions.js";
import { ticketProse } from "./ticket-refs.js";
import { renderVerdict } from "./verdict.js";

/* -------------------------------------------------------------------------
 * The fixture: run-2026-07-30T20-16-40-242Z-052c6e02, as it is on disk
 * ---------------------------------------------------------------------- */

/** The owner's own words. Two typos included; they are his. */
const FIXTURE_PROSE =
  "I want you to make a copy of this website. Including the same visuall animations and the the " +
  "same background everything. https://kamilborzecki.dev";

/** The sixteen criteria that run was graded against, verbatim. */
const FIXTURE_STATEMENTS: readonly (readonly [string, string])[] = [
  ["REQ-001", "When a client requests the site root, the site shall answer with HTTP status 200, an HTML content type, and a body of more than 200 bytes containing an <html> element."],
  ["REQ-002", "The site shall serve a home document containing none of the unfinished-copy markers \"lorem ipsum\", \"coming soon\", \"under construction\", \"content goes here\" or \"replace this text\"."],
  ["REQ-003", "When the home page is loaded and scrolled from top to bottom, the site shall answer with a non-5xx navigation status and raise no uncaught JavaScript errors."],
  ["REQ-004", "The site shall present the document title \"Kamil Borzecki | Agentic Developer\"."],
  ["REQ-005", "The site shall render the headline \"Agentic Workflow That Ships\" as a level-1 heading on the home page."],
  ["REQ-006", "The site shall render the section headings \"From Orchestration to Production\", \"Selected Work\", \"Environment First\", \"Take the Toolkit\", \"Kamil Borzecki\" and \"Start a Project\" as level-2 headings in that document order."],
  ["REQ-007", "The site shall render the four Selected Work entries Teewise, Trade Assistant, JobSilver and Kori with each project name inside a link, with the taglines \"AI caddie for multiplayer golf\", \"AI research desk for one trader\", \"A job search that runs overnight\" and \"Offline Japanese, on your phone\" present as page text, in that document order."],
  ["REQ-008", "The site shall render \"Meet the Agents\" and \"The Troublemaker\" as headings and the six failure-mode labels \"Rage input\", \"Oscillation\", \"Race\", \"Hard kill\", \"Expiry and offline\" and \"Hostile context\" as headings."],
  ["REQ-009", "The site shall render at least five distinct entry headings between the \"Take the Toolkit\" heading and the following \"Kamil Borzecki\" heading, including entries labelled \"/debugfix\", \"db-scale-audit\", \"taste-frontend-expert\" and \"/trimpng\"."],
  ["REQ-010", "The site shall render \"Kamil Borzecki\" as a level-2 heading followed, within the next three headings, by a lower-level heading reading \"Agentic Developer\"."],
  ["REQ-011", "The site shall render links labelled \"See My Work\", \"Start a conversation\", \"GitHub\" and \"LinkedIn\", each with an href that is neither empty nor \"#\", where the GitHub link resolves to a github.com address and the LinkedIn link resolves to a linkedin.com address."],
  ["REQ-012", "When the home page has loaded, the site shall exhibit motion, evidenced by at least two elements carrying a running CSS animation, or at least 20 requestAnimationFrame callbacks scheduled by the page, or at least one active document animation while the page is scrolled."],
  ["REQ-013", "The site shall paint a deliberate page background, evidenced by a background colour on the html or body element that is neither transparent nor plain white, or a background image on the html or body element, or a fixed or absolutely positioned layer covering at least 80 percent of the viewport width and 50 percent of its height that is a canvas or carries its own painted background."],
  ["REQ-014", "While the viewport is 390 by 844 CSS pixels, the site shall keep the document scroll width within 2 pixels of the viewport width."],
  ["REQ-015", "The site shall provide a non-empty lang attribute on the html element, exactly one level-1 heading, an alt attribute on every img element, and a discernible label on every link."],
  ["REQ-016", "Where the user agent requests reduced motion, the site shall either declare a prefers-reduced-motion media query or run fewer CSS animations than under the default motion preference."],
];

const FIXTURE_CRITERIA: readonly ApiCriterion[] = FIXTURE_STATEMENTS.map(([id, statement]) => ({
  id,
  statement,
  tier: "FUNCTIONAL" as const,
  result: "pending" as const,
}));

/**
 * Three questions and three replies, in the register an owner actually types.
 *
 * NONE OF THEM RESTATES A CRITERION. Each is a sentence answering the question
 * put to it, and what it shares with a criterion is what he happened to name —
 * "four projects and taglines", "the toolkit entries and the failure modes".
 * That is the link the record claims and the only one it may claim.
 */
const FIXTURE_ANSWERS: readonly { readonly id: string; readonly question: string; readonly answer: string }[] = [
  {
    id: "PQ-1",
    question:
      "The page you named lists four projects — Teewise, Trade Assistant, JobSilver and Kori. Should the " +
      "copy carry those same ones, or your own selection?",
    answer: "Keep the same four projects and taglines, they are mine anyway.",
  },
  {
    id: "PQ-2",
    question:
      "The page you named animates its background. Should the copy reproduce that moving background, or " +
      "would a different animated one do?",
    answer: "It has to move like the original, that is the whole point.",
  },
  {
    id: "PQ-3",
    question:
      "Your ticket says everything. Does that include the toolkit list and the failure-mode labels further " +
      "down, or only the main sections?",
    answer: "Everything means everything — the toolkit entries and the failure modes too.",
  },
];

/* -------------------------------------------------------------------------
 * Plan-state builders. Shapes come from `plan-state.ts`; nothing is cast.
 * ---------------------------------------------------------------------- */

function question(id: string, text: string, ifUnanswered: string): PlanQuestionState["question"] {
  return {
    id,
    text,
    ifUnanswered,
    criterionIfDefault: `the run proceeds on: ${ifUnanswered}`,
    criterionIfAnswered: "the run proceeds on what he says instead",
    tier: "FUNCTIONAL",
  };
}

/**
 * `recorded` is `PlanAnswer.text` — the wording ON RECORD, which is the seat's
 * paraphrase when `paraphrased` is set. `quoted` is the span of his own turn and
 * defaults to the same string, which is the ordinary non-paraphrased case.
 */
function answered(
  id: string,
  questionText: string,
  recorded: string,
  options: { readonly paraphrased?: boolean; readonly quoted?: string } = {},
): PlanQuestionState {
  return {
    question: question(id, questionText, "the dashboard would have guessed"),
    status: "answered",
    answer: {
      text: recorded,
      quoted: options.quoted ?? recorded,
      at: "2026-07-30T20:05:00.000Z",
      attribution: "structural",
      paraphrased: options.paraphrased ?? false,
    },
    assumed: null,
  };
}

function declined(id: string, text: string, ifUnanswered: string): PlanQuestionState {
  return { question: question(id, text, ifUnanswered), status: "declined", answer: null, assumed: ifUnanswered };
}

function planState(questions: readonly PlanQuestionState[]): PlanState {
  return {
    plan: ["copy the page the ticket names"],
    questions,
    clarifications: [],
    dropped: [],
    proposed: questions.length,
    turnsUsed: 1,
    closed: { reason: "answered", at: "2026-07-30T20:06:00.000Z", detail: "every question was settled" },
  };
}

const FIXTURE_STATE = planState(
  FIXTURE_ANSWERS.map((entry) => answered(entry.id, entry.question, entry.answer)),
);

// `reference` IS ZERO HERE AND THE SUM BELOW STILL NAMES FOUR, DELIBERATELY.
// The record is exhaustive over the union because `Record<AssumptionSource, …>`
// makes it so — that is what put this fifth key here at all. Nothing in this
// file's fixtures can produce a `reference` criterion: it comes from a captured
// motion reading, and this file exercises the plan phase. If one ever does
// appear, the four-way sum below drops under `a.length` and goes red, which is
// the alarm worth having — `renderAssumptions` has no section for the fifth
// source, so such a criterion would be counted nowhere and printed nowhere.
function bySource(assumptions: readonly Assumption[]): Record<AssumptionSource, number> {
  const counts: Record<AssumptionSource, number> = {
    ticket: 0,
    inferred: 0,
    default: 0,
    answered: 0,
    reference: 0,
  };
  for (const entry of assumptions) counts[entry.source] += 1;
  return counts;
}

/* -------------------------------------------------------------------------
 * 1. The measurement
 * ---------------------------------------------------------------------- */

test("MEASURED: three answered questions take inferredCriteria from 16 to 12 on the run that argued for this phase", () => {
  const pairs = answeredInOwnerWords(FIXTURE_STATE);
  assert.equal(pairs.length, 3, "the fixture's three answers must survive into three pairs");

  // BEFORE: the identical call with the pairs withheld. This is not a
  // reconstruction of the old code — it IS the old code path, which is why
  // `answered` defaults to empty on `extractAssumptions`.
  const before = assumptionsFor(FIXTURE_PROSE, FIXTURE_CRITERIA);
  assert.equal(before.length, 16);
  assert.equal(countInferredAssumptions(before), 16, "the number on disk in that run's own record");
  // `reference: 0` IS AN ASSERTION, NOT BOOKKEEPING. The comparison is a strict
  // deep-equal, so naming the fifth bucket at zero is what says this run credits
  // the owner with nothing read off a page — the same claim the other zeros make.
  assert.deepEqual(bySource(before), { ticket: 0, inferred: 15, default: 1, answered: 0, reference: 0 });

  // AFTER: same prose, same criteria, his three replies passed alongside.
  const after = assumptionsFor(FIXTURE_PROSE, FIXTURE_CRITERIA, pairs);
  assert.equal(after.length, 16, "accounting: one record per criterion, before and after");
  assert.equal(
    countInferredAssumptions(after),
    12,
    "answering three questions must move the number the phase is judged by",
  );
  assert.deepEqual(bySource(after), { ticket: 0, inferred: 11, default: 1, answered: 4, reference: 0 });

  // AND THE OWNER IS TOLD IN HIS TERMS, in the sentence he already scans for.
  assert.match(
    renderAssumptions(after),
    /Of 16 criteria: 11 inferred by the grader, 1 house defaults, 0 traced to words you wrote, 4 answered by you when the dashboard asked\./,
  );
});

test("MEASURED: the ordering named as the cause is not the cause — the two cuts commute", () => {
  // The handover said `#recordAssumptions` runs `stripPlanBlock` before
  // `ticketProse` and that this was why the number did not move. It is not:
  // `foldPlanIntoBrief` APPENDS, so the plan block is always last and either
  // order recovers the same prose. Measured rather than argued, and the
  // assertion is what makes it a measurement.
  const folded = foldPlanIntoBrief(FIXTURE_PROSE, FIXTURE_STATE);
  assert.notEqual(folded, FIXTURE_PROSE, "the fixture must actually carry a plan block");
  assert.equal(ticketProse(stripPlanBlock(folded)), stripPlanBlock(ticketProse(folded)));
  assert.equal(ticketProse(stripPlanBlock(folded)), FIXTURE_PROSE, "and both recover his words exactly");
});

/* -------------------------------------------------------------------------
 * 2. The cheats, refused
 * ---------------------------------------------------------------------- */

test("CHEAT GUARD: a plan block in the brief credits the owner with nothing on its own", () => {
  // The named cheat, verbatim: "relabelling a criterion `answered` because a
  // plan block exists anywhere in the brief". The tracer takes PAIRS, not prose,
  // so passing the whole folded brief as the ticket text — the mistake a caller
  // could actually make — must still produce no `answered` record at all.
  const folded = foldPlanIntoBrief(FIXTURE_PROSE, FIXTURE_STATE);
  const a = assumptionsFor(folded, FIXTURE_CRITERIA);
  assert.equal(bySource(a).answered, 0, "prose can never mint an `answered` label");
});

test("CHEAT GUARD: a bare yes does not credit the owner with the machine's own question", () => {
  // The question names the requirement in full. If the QUESTION could carry a
  // match, this criterion would be stamped as his on the strength of a sentence
  // the dashboard wrote — and a "no" would stamp it exactly as firmly.
  const criteria: readonly ApiCriterion[] = [
    { id: "REQ-1", statement: "The site shall present a contact form that emails the studio.", tier: "FUNCTIONAL", result: "pending" },
  ];
  const pair: AnsweredQuestion = {
    question: "Should the contact form email the studio, or just link to an address?",
    answer: "yes",
  };
  const a = assumptionsFor("copy of this website", criteria, [pair]);
  assert.equal(a[0]?.source, "inferred", "his answer contributed no word, so it supports nothing");
});

test("CHEAT GUARD: an answer credits the criterion it names and not the one beside it", () => {
  // "A SPECIFIC answer to a SPECIFIC criterion" is the rule; a pair that moved
  // every criterion in the run would satisfy a naive count test while meaning
  // nothing.
  const criteria: readonly ApiCriterion[] = [
    { id: "REQ-1", statement: "The site shall list four projects with their taglines.", tier: "FUNCTIONAL", result: "pending" },
    { id: "REQ-2", statement: "The site shall expose a contact route that accepts a message.", tier: "FUNCTIONAL", result: "pending" },
  ];
  const pair: AnsweredQuestion = {
    question: "How many projects should the copy list, and with their taglines?",
    answer: "Four projects, with the taglines.",
  };
  const a = assumptionsFor("copy of this website", criteria, [pair]);
  assert.equal(a[0]?.source, "answered");
  assert.equal(a[1]?.source, "inferred", "a contact route is not something he answered anything about");
});

test("CHEAT GUARD: a DECLINED question yields no pair — 'you decide' must not read as 'you specified it'", () => {
  // `plan-state.ts` records a declined question's assumption as the question's
  // own `ifUnanswered`, which is the house's guess and is worded like a
  // requirement. If it reached the tracer, declining everything would be the
  // cheapest possible route to a clean report.
  const state = planState([
    declined("PQ-1", "How many projects should the copy list?", "the copy lists four projects with taglines"),
  ]);
  assert.deepEqual(answeredInOwnerWords(state), [], "a decline is not an answer");

  const criteria: readonly ApiCriterion[] = [
    { id: "REQ-1", statement: "The site shall list four projects with their taglines.", tier: "FUNCTIONAL", result: "pending" },
  ];
  const a = assumptionsFor("copy of this website", criteria, answeredInOwnerWords(state));
  assert.equal(a[0]?.source, "inferred");
});

test("CHEAT GUARD: answering about a house rule does not turn it into something he specified", () => {
  // MEASURED BEFORE IT WAS FIXED: with the `answered` block placed above the
  // house-rule block, this criterion came back `answered`. A house rule is
  // checked whatever he says, and `countInferredAssumptions` counts `default`
  // and excludes `answered` — so relabelling one lets the dashboard drop the
  // number it is judged by simply by choosing what to ask about.
  const criteria: readonly ApiCriterion[] = [
    { id: "REQ-1", statement: "Every route shall return a 200.", tier: "BLOCKING", result: "pending" },
  ];
  const pair: AnsweredQuestion = {
    question: "Should every route answer 200?",
    answer: "yes, every route must answer 200",
  };
  const a = assumptionsFor("copy of this website", criteria, [pair]);
  assert.equal(a[0]?.source, "default", "a house rule stays a house rule however he answers about it");
  assert.equal(countInferredAssumptions(a), 1, "and it stays inside the number the phase is judged by");
});

test("CHEAT GUARD: a paraphrased answer is traced on HIS words, not the seat's tidy-up", () => {
  // `PlanAnswer.text` is the RECORDED wording, which is the seat's paraphrase
  // when `paraphrased` is true. Crediting a criterion to it would quote a
  // sentence back to him that he never typed, and the one check the record
  // invites — read your reply, find the words — would fail on his own page.
  const state = planState([
    answered("PQ-1", "Which projects should the copy carry?", "the four Selected Work entries with taglines", {
      paraphrased: true,
      quoted: "just keep mine",
    }),
  ]);
  const pairs = answeredInOwnerWords(state);
  assert.equal(pairs[0]?.answer, "just keep mine", "the pair must carry the span of HIS turn");

  const criteria: readonly ApiCriterion[] = [
    { id: "REQ-1", statement: "The site shall render four Selected Work entries with their taglines.", tier: "FUNCTIONAL", result: "pending" },
  ];
  const a = assumptionsFor("copy of this website", criteria, pairs);
  assert.equal(
    a[0]?.source,
    "inferred",
    "the seat's paraphrase matched this criterion; his four words did not, so it is still the grader's",
  );
});

/* -------------------------------------------------------------------------
 * 3. The record, as the owner reads it
 * ---------------------------------------------------------------------- */

test("every word an `answered` record credits to him is in the reply it quotes", () => {
  // The same check the `ticket` branch is held to, and for the same reason: the
  // owner's only way to audit this label is to read his own sentence and find
  // the words. A record whose one invited check fails is worse than none.
  const a = assumptionsFor(FIXTURE_PROSE, FIXTURE_CRITERIA, answeredInOwnerWords(FIXTURE_STATE));
  const credited = a.filter((entry) => entry.source === "answered");
  assert.ok(credited.length > 0, "the fixture must produce at least one to check");
  for (const entry of credited) {
    const quoted = entry.because.match(/you answered: "([^"]+)"/)?.[1] ?? "";
    const words = (entry.because.match(/your own words in this criterion: ([^.]+)\./)?.[1] ?? "").split(", ");
    assert.ok(quoted.length > 0, `${String(entry.criterionId)} credits an answer it does not quote`);
    assert.ok(words.length > 0 && words[0] !== "", `${String(entry.criterionId)} names no matched word`);
    for (const word of words) {
      assert.ok(
        quoted.toLowerCase().includes(word),
        `"${word}" is credited to a reply that does not contain it: ${quoted}`,
      );
    }
    assert.match(entry.because, /The dashboard asked: "/, "and the question he answered is quoted too");
  }
});

test("the four counts account for every criterion, and the sections render all four", () => {
  const a = assumptionsFor(FIXTURE_PROSE, FIXTURE_CRITERIA, answeredInOwnerWords(FIXTURE_STATE));
  const counts = bySource(a);
  const summed = counts.inferred + counts.default + counts.ticket + counts.answered;
  assert.equal(summed, a.length, "a criterion in no bucket is an inference nobody can see");

  const md = renderAssumptions(a);
  assert.ok(md.indexOf("INFERRED") < md.indexOf("ANSWERED BY YOU"), "the guesses still lead the document");
  assert.ok(md.indexOf("INFERRED") < md.indexOf("FROM YOUR TICKET"));
  for (const entry of a) {
    assert.ok(md.includes(entry.statement), `${String(entry.criterionId)} is missing from the record`);
    assert.ok(md.includes(entry.because), `${String(entry.criterionId)} is rendered with no reason`);
  }
});

test("a run nobody was asked still renders the fourth heading and a zero, rather than dropping them", () => {
  // Same rule the other three sections are held to: a missing heading is
  // indistinguishable from a renderer that dropped it, and "0 answered" is a
  // true and readable statement about a run with no plan phase.
  const md = renderAssumptions(assumptionsFor(FIXTURE_PROSE, FIXTURE_CRITERIA));
  assert.match(md, /0 answered by you when the dashboard asked\./);
  assert.match(md, /## ANSWERED BY YOU/);
  assert.match(md, /## ANSWERED BY YOU[^#]*_none_/s);
});

test("the API's inferred count and the verdict page agree once a criterion is `answered`", () => {
  // `countInferredAssumptions` and `verdict.ts:renderAssumptionSummary` share
  // one predicate. Two copies of it — which is what this repo had — put two
  // different numbers under one name the moment a fourth source appeared.
  const criteria: readonly ApiCriterion[] = [
    { id: "REQ-1", statement: "The site shall list four projects with their taglines.", tier: "FUNCTIONAL", result: "pending" },
    { id: "REQ-2", statement: "The site shall expose a contact route that accepts a message.", tier: "FUNCTIONAL", result: "pending" },
  ];
  const pairs: readonly AnsweredQuestion[] = [
    { question: "How many projects should the copy list, and with their taglines?", answer: "Four projects, with the taglines." },
  ];
  const assumptions = assumptionsFor("copy of this website", criteria, pairs);
  const counted = countInferredAssumptions(assumptions);
  assert.equal(counted, 1, "one answered, one still the grader's");

  // THE ANSWERED CRITERION IS THE ONE THAT FAILS, so the page has to print its
  // provenance under "Why it did not pass". A verdict where everything passed
  // prints no criterion prose at all, and the assertion below would then be
  // checking a section that never renders — a check that can only observe
  // success, which is this repository's signature defect.
  const md = renderVerdict({
    ticket: "copy of this website",
    criteriaResults: criteria.map((entry) => ({
      criterionId: entry.id,
      tier: entry.tier,
      passed: entry.id !== "REQ-1",
      evidenceRef: null,
      detail: null,
    })),
    qualityFindings: [],
    assumptions,
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 1, QUALITY: 0 },
  });
  assert.match(
    md,
    new RegExp(`${String(counted)} of ${String(criteria.length)} criteria were inferred`),
    "the page and RunDetail.inferredCriteria must count the same set",
  );
  // AND THE PAGE MUST NOT ANNOUNCE HIS OWN REPLY AS A HOUSE DEFAULT, which is
  // where the provenance ternary sent `answered` before it became a switch.
  assert.doesNotMatch(md, /A HOUSE DEFAULT[^\n]*you settled this/);
  assert.match(md, /YOU ANSWERED THIS when the dashboard asked/);
});
