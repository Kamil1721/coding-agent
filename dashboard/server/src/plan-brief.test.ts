/**
 * plan-brief.test.ts — is anything said in the dialogue lost before the criteria
 * are written?
 *
 * A DROPPED TURN IS KNOWLEDGE THE CRITERIA AUTHOR NEVER GETS, and it fails
 * silently: the run proceeds, the suite is authored, the badge is green, and the
 * only evidence is a sentence the owner typed that nothing downstream ever saw.
 * So the first test drives an exchange containing EVERY kind of turn and asserts
 * each one's words survive, rather than asserting the fold produced something.
 *
 * THE MUTATION WATCHED FOR EACH TEST, all in `plan-brief.ts`, watched failing and
 * restored:
 *
 *   nothing is dropped  — drop the clarifications block. RED.
 *                       — `questionLines` returns `[]` for `declined`. RED.
 *   the round trip      — `stripPlanBlock` returns its argument. RED.
 *   the identity case   — fold appends unconditionally. RED (the ticket id of a
 *                         run whose seat asked nothing must not move).
 *   no route to an image— `redactHostPaths` returns its argument. RED, and the
 *                         oracle is `visual-substance.ts`'s own boundary check
 *                         rather than a regex written twice.
 *   declined != answered— label a declined question `[ANSWERED BY THE OWNER]`.
 *                         RED.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PLAN_BLOCK_BEGIN, foldPlanIntoBrief, planBlockIndex, redactHostPaths, stripPlanBlock } from "./plan-brief.js";
import type { PlanQuestion } from "./plan-question.js";
import type { PlanState } from "./plan-state.js";
// THE ORACLE, DELIBERATELY BORROWED. `visual-substance.ts` already decided what
// "this string could locate a file" means and argued for a deliberately broad
// match; using its check here means the two cannot drift into disagreeing about
// what a leak is, and a regex written twice is a regex that will.
import { assertNoScreenshotReference } from "./visual-substance.js";

const BRIEF = "Build me a portfolio. Keep it calm and readable.";

function question(id: string, over: Partial<PlanQuestion> = {}): PlanQuestion {
  return {
    id,
    text: `Question ${id}?`,
    ifUnanswered: `assumption for ${id}`,
    criterionIfDefault: `Criterion default ${id}.`,
    criterionIfAnswered: `Criterion answered ${id}.`,
    tier: "FUNCTIONAL",
    ...over,
  };
}

/** An exchange with one of every kind of turn in it. */
function everyKindOfTurn(): PlanState {
  return {
    plan: ["A portfolio with a project list and a contact line."],
    questions: [
      {
        question: question("PQ-1", { text: "How many projects should the portfolio show?" }),
        status: "answered",
        answer: {
          text: "six project cards",
          quoted: "six of them please",
          at: "2026-08-02T10:00:00.000Z",
          attribution: "structural",
          paraphrased: true,
        },
        assumed: null,
      },
      {
        question: question("PQ-2", { text: "Should the contact form send email?", ifUnanswered: "it validates only" }),
        status: "declined",
        answer: null,
        assumed: "it validates only",
      },
      {
        question: question("PQ-3", { text: "Should the changelog be dated?", ifUnanswered: "no dates" }),
        status: "expired",
        answer: null,
        assumed: "no dates",
      },
      {
        question: question("PQ-4", { text: "Should the footer carry a licence?", ifUnanswered: "no licence line" }),
        status: "open",
        answer: null,
        assumed: null,
      },
    ],
    clarifications: [
      {
        at: "2026-08-02T10:05:00.000Z",
        about: ["PQ-1"],
        asked: "Why does the number of projects matter?",
        reply: "Three cards and six cards are different pages.",
      },
    ],
    dropped: [{ text: "What colour scheme would you like?", refusal: "criteria-do-not-differ", detail: "generic" }],
    proposed: 5,
    turnsUsed: 3,
    closed: { reason: "turn cap", at: "2026-08-02T10:10:00.000Z", detail: "the plan dialogue reached its bound" },
  };
}

test("NOTHING SAID IN THE DIALOGUE IS DROPPED — every kind of turn survives the fold", () => {
  const state = everyKindOfTurn();
  const folded = foldPlanIntoBrief(BRIEF, state);

  // The owner's original words are still there and still first.
  assert.ok(folded.startsWith(BRIEF));

  for (const entry of state.questions) {
    assert.ok(folded.includes(entry.question.id), `${entry.question.id} is missing`);
    assert.ok(folded.includes(entry.question.text), `${entry.question.id}'s text is missing`);
  }
  // The answer, in the owner's terms.
  assert.ok(folded.includes("six project cards"));
  // Every assumption the run is proceeding on — declined, expired AND still open.
  assert.ok(folded.includes("it validates only"));
  assert.ok(folded.includes("no dates"));
  assert.ok(folded.includes("no licence line"));
  // HIS OWN QUESTION AND THE ANSWER HE GOT. A clarifying exchange is where an
  // owner most often states a requirement without realising he has.
  assert.ok(folded.includes("Why does the number of projects matter?"));
  assert.ok(folded.includes("Three cards and six cards are different pages."));
  // And how it ended, so the criteria author knows the exchange was cut short.
  assert.ok(folded.includes("the plan dialogue reached its bound"));

  // WHAT IS DELIBERATELY ABSENT: a question the worth rule refused. It was never
  // put to him, so it is not part of any exchange — it is the seat's discarded
  // guess, and folding it in would dress it as part of the ticket.
  assert.ok(!folded.includes("What colour scheme would you like?"));
});

test("a declined question is labelled as the dashboard's guess, never as his answer", () => {
  const folded = foldPlanIntoBrief(BRIEF, everyKindOfTurn());
  const lines = folded.split("\n");
  const declined = lines.findIndex((line) => line.startsWith("PQ-2"));
  const answered = lines.findIndex((line) => line.startsWith("PQ-1"));

  assert.ok(answered >= 0 && declined >= 0);
  assert.match(String(lines[answered]), /\[ANSWERED BY THE OWNER\]/);
  assert.match(String(lines[declined]), /\[LEFT TO THE DASHBOARD BY THE OWNER\]/);
  assert.match(String(lines[declined + 1]), /the dashboard is assuming/);
  // The distinction is what stops a criterion he refused to state from being
  // traced to words he wrote — and what stops declining everything from moving
  // the number this whole phase is measured by.
  assert.ok(!String(lines[declined]).includes("ANSWERED BY THE OWNER"));
});

test("the owner's words are recoverable — fold then strip is the identity", () => {
  const folded = foldPlanIntoBrief(BRIEF, everyKindOfTurn());
  assert.notEqual(folded, BRIEF);
  assert.ok(planBlockIndex(folded) > 0);
  assert.equal(stripPlanBlock(folded), BRIEF);

  // A brief that was never folded is returned untouched.
  assert.equal(stripPlanBlock(BRIEF), BRIEF);
  assert.equal(planBlockIndex(BRIEF), -1);
});

test("a dialogue with nothing in it returns the brief UNCHANGED — the ticket id must not move", () => {
  const empty: PlanState = {
    plan: ["Nothing to ask."],
    questions: [],
    clarifications: [],
    dropped: [],
    proposed: 0,
    turnsUsed: 0,
    closed: { reason: "nothing to ask", at: "x", detail: "nothing worth asking" },
  };
  // Not merely equal-looking: a run whose seat asked nothing must derive exactly
  // the id it would have derived with no plan phase at all, or every suite
  // already frozen under that id is addressed by something nothing recomputes.
  assert.equal(foldPlanIntoBrief(BRIEF, empty), BRIEF);
  assert.ok(!foldPlanIntoBrief(BRIEF, empty).includes(PLAN_BLOCK_BEGIN));
});

test("NO ROUTE TO AN IMAGE CROSSES INTO THE BRIEF, even when the seat put one in a question", () => {
  // The plan seat is the first seat told that reference images exist. A seat that
  // writes a path into a question would carry it into the brief, and the brief is
  // read by the spec seat — which runs `tools: []` and could not open it — and by
  // the builder, which could. `ticket-refs.ts`'s header forbids exactly this.
  const leaky = everyKindOfTurn();
  const state: PlanState = {
    ...leaky,
    plan: ["Follow ~/refs/moodboard.jpeg for the palette."],
    questions: [
      {
        question: question("PQ-9", {
          text: "Should the layout follow /Users/kamil/refs/hero.png or the other one?",
          ifUnanswered: "the layout follows /Users/kamil/refs/hero.png",
        }),
        status: "declined",
        answer: null,
        assumed: "the layout follows /Users/kamil/refs/hero.png",
      },
    ],
    clarifications: [
      { at: "x", about: [], asked: "Which one is ./refs/b.webp?", reply: "The second attachment." },
    ],
  };

  const folded = foldPlanIntoBrief(BRIEF, state);
  // The oracle throws if anything in the string could locate a file.
  assertNoScreenshotReference(folded, "the folded plan block");
  assert.ok(!folded.includes("hero.png"));
  assert.ok(!folded.includes("/Users/kamil"));
  // The QUESTION still survives, minus the route — a redaction, not a drop.
  assert.ok(folded.includes("Should the layout follow"));
  assert.ok(folded.includes("or the other one?"));
});

test("redaction removes the route and keeps the sentence", () => {
  assert.equal(
    redactHostPaths("Follow /Users/kamil/refs/hero.png closely."),
    "Follow [a file path was removed here] closely.",
  );
  assert.equal(redactHostPaths("Use hero.png as the reference."), "Use [a filename was removed here] as the reference.");
  // POSITIVE CONTROL: ordinary prose is untouched, so this is not a function that
  // mangles every answer the owner gives.
  assert.equal(redactHostPaths("Six project cards, calm and readable."), "Six project cards, calm and readable.");
});

/**
 * MEASURED ON A REAL RUN, 2026-08-04, run `…162b186d`. The owner answered a
 * question about his own site's `/work` page and the brief the spec seat read
 * said:
 *
 *   "Does every project card on [a file path was removed here] get its own
 *    hand-drawn illustration"
 *
 * A WEB ROUTE IS NOT A HOST PATH. The redaction exists because the plan seat is
 * handed absolute paths to the owner's reference images and could quote one into
 * a question; it was never meant to reach route names. Route names are the
 * vocabulary of every web ticket this dashboard runs, and the plan phase exists
 * to turn the grader's guesses into the owner's own words — deleting the nouns
 * from his answers defeats the phase on the tickets it matters most for.
 */
test("a WEB ROUTE survives, because deleting it defeats the phase it belongs to", () => {
  assert.equal(
    redactHostPaths("Does every project card on /work get an illustration?"),
    "Does every project card on /work get an illustration?",
  );
  assert.equal(
    redactHostPaths("POST /api/contact returns 400, and /about lists the roles."),
    "POST /api/contact returns 400, and /about lists the roles.",
  );
});

/**
 * THE NEGATIVE CONTROL, and it is the one that matters. Every assertion above is
 * satisfied by a function that returns its argument unchanged — which is exactly
 * the leak this module exists to prevent. These cases are the ones that must
 * still be destroyed, and each is a shape a real leak takes.
 */
test("NEGATIVE CONTROL: every shape of host path is still destroyed", () => {
  const REDACTED = "[a file path was removed here]";
  for (const leak of [
    "/Users/kamil/refs/hero",          // capitalised root, the macOS shape
    "/home/kamil/refs/hero",           // the linux shape
    "/tmp/reference-1",                // a filesystem root with no extension
    "/private/var/folders/x/y",        // what a macOS temp dir looks like
    "~/refs/hero",                     // home-relative
    "./refs/hero",                     // cwd-relative
    "../refs/hero",                    // parent-relative
    "/Users/kamil/a/b/c/d/e",          // deep, no extension
    "/opt/app/config",                 // another root on the denylist
  ]) {
    assert.equal(
      redactHostPaths(`Follow ${leak} closely.`),
      `Follow ${REDACTED} closely.`,
      `${leak} leaked through the redaction`,
    );
  }
});

/**
 * A ROUTE THAT IS ACTUALLY A PATH still goes. The rule is not "starts with a
 * slash is safe" — anything carrying a file extension, an uppercase segment, or
 * more depth than a route plausibly has is treated as a path, because the cost of
 * the two mistakes is not symmetrical: an over-redacted route costs one mangled
 * sentence, and an under-redacted path hands the criteria author a route to an
 * image it must never see.
 */
test("route-shaped but path-like text is still redacted, because the costs are asymmetric", () => {
  const REDACTED = "[a file path was removed here]";
  assert.equal(redactHostPaths(`See /work/hero closely.`), `See /work/hero closely.`);
  // …but with an extension it is a file, not a page:
  assert.ok(redactHostPaths("See /work/hero.png closely.").includes(REDACTED)
    || redactHostPaths("See /work/hero.png closely.").includes("[a filename was removed here]"));
  // …and beyond three segments it is not a route anyone types in a brief:
  assert.equal(redactHostPaths("See /a/b/c/d/e now."), `See ${REDACTED} now.`);
});
