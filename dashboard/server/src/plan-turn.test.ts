/**
 * plan-turn.test.ts — what the parser lets through.
 *
 * NO TEST HERE ASSERTS THAT A PROMPT STRING EXISTS. Every one drives a response
 * the seat could actually return and checks what came out, because the defect
 * this repository keeps shipping is a claim in prose over a mechanism that does
 * not implement it.
 *
 * THE CASE MOST LIKELY TO BE GOT WRONG IS ZERO QUESTIONS, because it looks like
 * failure and is a success: a detailed ticket has nothing whose answer would
 * change a criterion, and run …3d4d1ccb (`inferredCriteria = 2`) is what that
 * owner's run looks like. A phase that treated an empty list as an error would
 * make his run worse to make a thin one better.
 *
 * THE MUTATION WATCHED FOR EACH TEST, all in `plan-turn.ts`, watched failing and
 * restored:
 *
 *   unparseable        — `extractJsonObject` returns `{}` instead of null on a
 *                        parse failure. Prose parses as a turn. RED.
 *   zero questions     — treat an empty `questions` array as unparseable
 *                        (`!hasQuestions` -> `questions.length === 0`). RED.
 *   trailing prose     — `raw.slice(start, end + 1)` -> `raw.slice(start)`,
 *                        i.e. `judge.ts#parseReport`'s own slice. The trailing
 *                        "Let me know…" breaks the parse. RED.
 *   plan truncation    — `trimPlan` returns `{lines: kept, note: null}`. RED.
 *   plan line bound    — `MAX_PLAN_LINE_CHARS` 160 -> 100000. RED.
 *   id minting         — mint before selection (`firstOrdinal + index` inside
 *                        `readQuestions`). The owner sees a gap. RED.
 *   tier default       — `?? "QUALITY"` -> `?? "BLOCKING"`. RED.
 *   reply: empty turn  — drop the "neither a reply nor a resolution" branch. RED.
 *   reply: quote req.  — drop the `quoted.length === 0` guard in `parsePlanReply`.
 *                        A resolution with no span survives to the arbiter. RED.
 *   reply truncation   — `truncate` returns `{value, note: null}`. RED.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_QUESTIONS_PER_TURN } from "./plan-question.js";
import { MAX_PLAN_LINES, MAX_REPLY_CHARS, parsePlanProposal, parsePlanReply } from "./plan-turn.js";

const OPTIONS = { brief: "Build me a website.", cap: 3, firstOrdinal: 1 } as const;

function proposal(text: string) {
  const parsed = parsePlanProposal(text, OPTIONS);
  assert.equal(parsed.ok, true, "expected the response to parse");
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.proposal;
}

const GOOD_QUESTION = {
  text: "How many projects should the portfolio show?",
  ifUnanswered: "three project cards",
  criterionIfDefault: "The portfolio shows three project cards.",
  criterionIfAnswered: "The portfolio shows six project cards.",
  tier: "FUNCTIONAL",
};

test("an unreadable response is a REFUSAL, never an empty turn", () => {
  // THREE WAYS TO BE UNREADABLE, and all three must land in the same place. An
  // unreadable response silently becoming `asked: []` is indistinguishable from a
  // detailed ticket with nothing to ask — one is a broken seat and the other is
  // the best outcome available, and the run log would say the same thing about
  // both.
  for (const [what, raw] of [
    ["no braces at all", "I had a look at the ticket and it seems fine to me."],
    ["an opening brace and no close", "Here you go: {plan: [oops"],
    ["braces around something that is not JSON", "{ plan: unquoted, questions: }"],
    ["JSON that is not an object", "[1, 2, 3]"],
  ] as const) {
    const parsed = parsePlanProposal(raw, OPTIONS);
    assert.equal(parsed.ok, false, what);
    assert.equal(parsed.ok === false ? parsed.refusal : "", "unparseable", what);
  }

  // A well-formed object of the WRONG shape is unreadable too.
  const wrong = parsePlanProposal(JSON.stringify({ thoughts: "hmm" }), OPTIONS);
  assert.equal(wrong.ok, false);

  // POSITIVE CONTROL: the same call shape on a real response.
  assert.equal(parsePlanProposal(JSON.stringify({ plan: ["a"], questions: [] }), OPTIONS).ok, true);
});

test("ZERO QUESTIONS IS A SUCCESS — a detailed ticket has nothing worth asking", () => {
  const result = proposal(
    JSON.stringify({ plan: ["The ticket already says what it wants.", "Building it as written."], questions: [] }),
  );
  assert.equal(result.asked.length, 0);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.proposed, 0);
  assert.equal(result.plan.length, 2);
  assert.equal(result.planNote, null);
});

test("a response wrapped in prose and a fence still parses — the trailing sentence is the common case", () => {
  const raw = [
    "Here's what I'd ask:",
    "```json",
    JSON.stringify({ plan: ["Portfolio, three sections."], questions: [GOOD_QUESTION] }),
    "```",
    "Let me know if you'd like me to adjust these.",
  ].join("\n");
  const result = proposal(raw);
  assert.equal(result.asked.length, 1);
  assert.equal(result.asked[0]?.id, "PQ-1");
});

test("the plan is truncated WITH A RECORD, never silently", () => {
  const overlong = Array.from({ length: MAX_PLAN_LINES + 4 }, (_, i) => `Line ${String(i)} of the plan.`);
  const result = proposal(JSON.stringify({ plan: overlong, questions: [] }));
  assert.equal(result.plan.length, MAX_PLAN_LINES);
  assert.match(String(result.planNote), /ran to 10 lines; the last 4 were cut/);

  const wide = [`${"a very long clause ".repeat(20)}end.`];
  const cut = proposal(JSON.stringify({ plan: wide, questions: [] }));
  assert.ok((cut.plan[0] ?? "").endsWith("…"));
  assert.match(String(cut.planNote), /longer than 160 characters/);

  // POSITIVE CONTROL: a plan within bounds records nothing, so `planNote` is not
  // a field that is always set.
  assert.equal(proposal(JSON.stringify({ plan: ["Short."], questions: [] })).planNote, null);
});

test("a refused question is recorded with its reason, and `proposed` counts what was tried", () => {
  const raw = JSON.stringify({
    plan: ["Portfolio."],
    questions: [
      GOOD_QUESTION,
      {
        text: "What colour scheme would you like?",
        ifUnanswered: "a coherent palette",
        criterionIfDefault: "The site has a coherent colour scheme.",
        criterionIfAnswered: "The page has a coherent colour scheme.",
        tier: "BLOCKING",
      },
      { text: "Anything else you want mentioned?", ifUnanswered: "nothing more", tier: "QUALITY" },
    ],
  });
  const result = proposal(raw);

  // THE NUMBER THAT MAKES A USELESS SEAT VISIBLE: three proposed, one asked.
  assert.equal(result.proposed, 3);
  assert.equal(result.asked.length, 1);
  assert.deepEqual(
    result.dropped.map((d) => d.refusal).sort(),
    ["criteria-do-not-differ", "no-criterion-pair"],
  );
  for (const dropped of result.dropped) assert.ok(dropped.detail.length > 10, "a refusal must say why");
});

test("ids are contiguous from the ordinal given — the owner never sees a gap", () => {
  const questions = [
    { ...GOOD_QUESTION, tier: "QUALITY" },
    {
      text: "Should the contact form send email or only validate?",
      ifUnanswered: "it validates only",
      criterionIfDefault: "The form validates its fields.",
      criterionIfAnswered: "The form delivers a message to the owner's inbox.",
      tier: "BLOCKING",
    },
  ];
  const result = proposal(JSON.stringify({ plan: ["p"], questions }));
  assert.deepEqual(result.asked.map((q) => q.id), ["PQ-1", "PQ-2"]);
  // Ranked, so the BLOCKING one is PQ-1 even though the seat listed it second.
  assert.equal(result.asked[0]?.tier, "BLOCKING");

  const later = parsePlanProposal(JSON.stringify({ plan: ["p"], questions }), { ...OPTIONS, firstOrdinal: 4 });
  assert.equal(later.ok, true);
  assert.deepEqual(later.ok ? later.proposal.asked.map((q) => q.id) : [], ["PQ-4", "PQ-5"]);
});

test("an unrecognised tier falls to the BACK of the queue, not the front", () => {
  const result = proposal(
    JSON.stringify({
      plan: ["p"],
      questions: [
        { ...GOOD_QUESTION, tier: "URGENT" },
        {
          text: "Should the contact form send email or only validate?",
          ifUnanswered: "it validates only",
          criterionIfDefault: "The form validates its fields.",
          criterionIfAnswered: "The form delivers a message to the owner's inbox.",
          tier: "FUNCTIONAL",
        },
      ],
    }),
  );
  // A typo'd tier must not buy the front of the owner's attention.
  assert.equal(result.asked[0]?.tier, "FUNCTIONAL");
  assert.equal(result.asked[1]?.tier, "QUALITY");
});

test("the per-turn cap binds and records, and `proposed` still counts everything", () => {
  // DISTINCT NOUNS, NOT "section 0..4": the digits are dropped by the content
  // filter, so numbered variants of one sentence are the SAME question and the
  // duplicate rule eats four of them before the cap ever sees them. That is the
  // rule working; it just makes a bad fixture for measuring the cap.
  const questions = ["hero", "gallery", "changelog", "contact", "footer"].map((part) => ({
    text: `Should the ${part} carry a caption?`,
    ifUnanswered: `the ${part} carries no caption`,
    criterionIfDefault: `The ${part} renders without a caption.`,
    criterionIfAnswered: `The ${part} renders a caption beneath its heading.`,
    tier: "FUNCTIONAL",
  }));
  const result = proposal(JSON.stringify({ plan: ["p"], questions }));
  assert.equal(result.asked.length, 3);
  assert.equal(result.proposed, 5);
  assert.equal(result.dropped.filter((d) => d.refusal === "over-cap").length, 2);

  // AND THE PER-TURN CAP IS APPLIED BY THE PARSER, NOT TRUSTED TO THE CALLER. The
  // opening turn is handed the dialogue's whole remaining budget (5); putting all
  // five in front of the owner at once is the wall of text the cap exists for.
  const wide = parsePlanProposal(JSON.stringify({ plan: ["p"], questions }), { ...OPTIONS, cap: 5 });
  assert.equal(wide.ok, true);
  assert.equal(wide.ok ? wide.proposal.asked.length : -1, MAX_QUESTIONS_PER_TURN);
});

test("an entry with no question text is dropped for THAT reason, not blamed on the ticket", () => {
  const result = proposal(
    JSON.stringify({
      plan: ["p"],
      questions: [{ text: "  ", ifUnanswered: "something", criterionIfDefault: "A.", criterionIfAnswered: "B." }],
    }),
  );
  // Without its own branch this falls through to `answered-by-the-brief` — an
  // empty token set is trivially a subset of anything — and the log would name
  // the owner's ticket as the reason a question the seat never wrote was dropped.
  assert.equal(result.dropped[0]?.refusal, "no-text");
});

/* -------------------------------------------------------------------------
 * The follow-up turn
 * ---------------------------------------------------------------------- */

test("a turn that only replies is ordinary; a turn that says nothing at all is not", () => {
  const replied = parsePlanReply(JSON.stringify({ reply: "It changes how many cards get built.", resolved: [] }));
  assert.equal(replied.ok, true);
  assert.equal(replied.ok ? replied.value.resolutions.length : -1, 0);

  const silent = parsePlanReply(JSON.stringify({ reply: "  ", resolved: [] }));
  assert.equal(silent.ok, false);
  assert.equal(silent.ok === false ? silent.refusal : "", "unparseable");
});

test("a resolution with no quoted span never reaches the arbiter", () => {
  const parsed = parsePlanReply(
    JSON.stringify({
      reply: "",
      resolved: [
        { id: "PQ-1", kind: "answer", answer: "six", quoted: "six of them" },
        { id: "PQ-2", kind: "answer", answer: "blue", quoted: "" },
        { id: "", kind: "answer", answer: "x", quoted: "y" },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  // Only the one carrying a span survives — the anti-fabrication check downstream
  // has nothing to check against without one.
  assert.deepEqual(parsed.ok ? parsed.value.resolutions.map((r) => r.id) : [], ["PQ-1"]);
});

test("the seat's clarifying reply is truncated WITH A RECORD", () => {
  const long = "x".repeat(MAX_REPLY_CHARS + 50);
  const parsed = parsePlanReply(JSON.stringify({ reply: long, resolved: [] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  assert.equal(parsed.value.reply.length, MAX_REPLY_CHARS);
  assert.match(String(parsed.value.replyNote), /was cut to 400/);

  // POSITIVE CONTROL: a short reply records nothing.
  const short = parsePlanReply(JSON.stringify({ reply: "Because three and six are different pages.", resolved: [] }));
  assert.equal(short.ok ? short.value.replyNote : "unset", null);
});

test("an unknown decline flag reads as an answer, not the other way round", () => {
  // Failing towards `answer` keeps a misread turn recoverable: the arbiter still
  // needs the host's own classification to agree before anything is recorded, and
  // an answer wrongly read as a decline would silently bank the house default.
  const parsed = parsePlanReply(
    JSON.stringify({ reply: "", resolved: [{ id: "PQ-1", kind: "maybe", answer: "six", quoted: "six" }] }),
  );
  assert.equal(parsed.ok ? parsed.value.resolutions[0]?.kind : "", "answer");
});
