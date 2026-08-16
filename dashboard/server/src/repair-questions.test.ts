/**
 * THE QUESTION LAYER, TESTED IN THE DIRECTION THAT CAN GO RED.
 *
 * Every test below names the mutation that breaks the mechanism it covers, and
 * every one of those mutations WAS APPLIED to `repair-questions.ts`, run, and
 * reverted — not asserted about in a docblock. This repository has shipped a
 * claimed-but-never-run mutation seventeen times (STATUS.md §6); the whole point
 * of the question layer is that a check which can only observe success is not a
 * check, and a test file for it that could only observe success would be the
 * joke telling itself.
 *
 * NO TEST HERE SPENDS QUOTA. The Codex call is an injected
 * {@link CodexClientFactory} that records the options it was constructed with
 * and answers from a fixture. That is also how the environment subtraction is
 * MEASURED rather than assumed: the fake sees exactly what the real `Codex`
 * constructor would have seen.
 *
 * THE DEFECT RECORD IS BUILT BY `buildDefectRecord`, NOT HAND-WRITTEN, so the
 * claim set is minted from the shape the production writer really emits. A
 * hand-typed record would let this file keep passing after `defect-record.ts`
 * changed underneath it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildDefectRecord } from "./defect-record.js";
import type { DefectRecord } from "./defect-record.js";
import {
  CITATION_SEPARATOR,
  CODEX_ASKER_THREAD_OPTIONS,
  EVIDENCE_SOURCES,
  MAX_ASKED_QUESTIONS,
  THE_ASK,
  askForQuestions,
  boundQuestions,
  buildAskPrompt,
  citationProblem,
  claimsFromDefect,
  createCodexAsk,
  extractJsonArray,
  groupQuestions,
  parseAskedQuestions,
  questionMetrics,
  resolveAnswer,
  resolveQuestions,
} from "./repair-questions.js";
import type {
  AnsweredQuestion,
  AskedQuestion,
  CodexClientFactory,
  CodexClientLike,
  CodexThreadLike,
  OwnerQuestion,
  RepairQuestion,
} from "./repair-questions.js";
import { STRIPPED_ENV_NAMES } from "./subprocess-env.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const FAILURE_REASON = "the frozen held-out suite did not go green in the sealed container";

function defect(): DefectRecord {
  return buildDefectRecord({
    runId: "run-2026-08-16T00-00-00-000Z-047f9872",
    at: "2026-08-16T00:00:00.000Z",
    phase: "gate",
    status: "failed",
    failureClass: "unclassified",
    bakeoffCode: "SPEC_INVALID",
    failureReason: FAILURE_REASON,
    site: "spec-validate#requireFields",
    violations: [{ path: "criteria[0].id", expected: "a REQ-nnn token", got: "null" }],
    attempts: null,
    artefacts: ["results/defect.json"],
    provider: "anthropic",
    modelId: "claude-opus-5[1m]",
    repairable: true,
  });
}

/** A question that names a real claim and states its surprise. Survives the bound. */
function asked(over: Partial<AskedQuestion> = {}): AskedQuestion {
  return {
    question: "is `details.error` the thrown error?",
    refutes: "claim:site",
    surprisingAnswer: "no — node wraps it in ERR_TEST_FAILURE and the real error is on .cause",
    ...over,
  };
}

/** A Codex client that records what it was handed and replies from a script. */
function fakeCodex(reply: string | (() => Promise<{ readonly finalResponse: string }>)): {
  readonly factory: CodexClientFactory;
  readonly constructedWith: Record<string, string>[];
  readonly threadOptions: unknown[];
  readonly prompts: string[];
} {
  const constructedWith: Record<string, string>[] = [];
  const threadOptions: unknown[] = [];
  const prompts: string[] = [];
  const factory: CodexClientFactory = (options) => {
    constructedWith.push({ ...(options.env ?? {}) });
    if (options.apiKey !== undefined) throw new Error("the asker must never pass an apiKey");
    const client: CodexClientLike = {
      startThread(threadOpts) {
        threadOptions.push(threadOpts);
        const thread: CodexThreadLike = {
          id: "thread-abc123",
          async run(input, runOptions) {
            prompts.push(input);
            if (typeof reply === "string") return { finalResponse: reply };
            // The slow path: resolve only when the caller's signal fires, so the
            // timeout branch is exercised with no wall-clock guesswork.
            return await new Promise((_resolve, reject) => {
              runOptions?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); });
            });
          },
        };
        return thread;
      },
    };
    return client;
  };
  return { factory, constructedWith, threadOptions, prompts };
}

/* -------------------------------------------------------------------------
 * 1. The claim set — minted from structured fields, never from prose
 * ---------------------------------------------------------------------- */

/**
 * MUTATION RUN: in `claimsFromDefect`, before the evidence loop, push
 * `{ id: "claim:reason", statement: defect.failureReason ?? "" }`.
 * RED: `AssertionError: no claim may be minted from failureReason, and
 * claim:reason quotes it`. The prose field `defect-record.ts`'s header forbids
 * reading back is the one input a question must not be kept on the strength of.
 */
test("claims come from the record's structured fields and never from its prose", () => {
  const record = defect();
  const claims = claimsFromDefect(record);
  const ids = claims.map((claim) => claim.id);
  assert.ok(ids.includes("claim:site"), "the site is a claim");
  assert.ok(ids.includes("claim:class"), "the failure class is a claim");
  assert.ok(ids.includes("claim:code"), "the BakeoffError code is a claim");
  assert.ok(ids.includes("claim:field:criteria[0].id"), "each refused field path is a claim");
  assert.ok(
    ids.includes("claim:repro") || ids.includes("claim:repro-absent"),
    "the reproduction, present or named-absent, is always a claim",
  );
  assert.ok(
    ids.some((id) => id.startsWith("claim:gap:")),
    "a named absence is a claim: this record's attempts are unavailable, not zero",
  );
  for (const claim of claims) {
    assert.ok(
      !claim.statement.includes(FAILURE_REASON),
      `no claim may be minted from failureReason, and ${claim.id} quotes it`,
    );
  }
});

/**
 * MUTATION RUN: in `buildAskPrompt`, replace the bound sentence with
 * `"THE BOUND. Ask whatever you like."`.
 * RED: `AssertionError: the prompt states the bound`. An asker told nothing
 * about the filter loses most of its turn to questions discarded unread.
 */
test("the prompt asks the design's question, shows every claim id, and forbids answering", () => {
  const record = defect();
  const claims = claimsFromDefect(record);
  const prompt = buildAskPrompt({ defect: record, claims });
  assert.ok(prompt.includes(THE_ASK), "the prompt asks §10.5.3's question verbatim");
  for (const claim of claims) {
    assert.ok(prompt.includes(claim.id), `the asker can only name a claim it was shown: ${claim.id}`);
  }
  assert.ok(
    prompt.includes("Keep only questions whose SURPRISING answer would CHANGE the diagnosis."),
    "the prompt states the bound",
  );
  assert.ok(prompt.includes("Do not answer your own questions."), "the asker is not the answerer (§10.5)");
  assert.ok(prompt.includes(FAILURE_REASON), "the prose failure text travels as context");
  assert.ok(prompt.includes("CONTEXT, NOT A CLAIM"), "and it is labelled as something no question may rest on");
  assert.ok(prompt.includes(String(MAX_ASKED_QUESTIONS)), "the parse-level cap is stated");
});

/* -------------------------------------------------------------------------
 * 2. THE BOUND (§10.5.4)
 * ---------------------------------------------------------------------- */

/**
 * THE LANE'S FIRST REQUIRED MUTATION.
 *
 * MUTATION RUN: make `boundQuestions` keep everything — first statement becomes
 * `if (asked.length >= 0) return { kept: [...asked], dropped: [] };`.
 * RED: `AssertionError: a question that names no claim is dropped` — 3 kept
 * where 1 was expected, and `ℹ fail 5`: the dedup test, the OVER_CAP test, the
 * caller-cap test and `askForQuestions` went red with it. The filter is
 * load-bearing in five places, not one.
 *
 * The assertion is on the KEPT SET AND THE DROPPED SET, not on a count alone: a
 * filter that dropped the right number of the wrong questions would pass a
 * length check.
 */
test("the bound drops a question whose answer cannot change the diagnosis", () => {
  const claims = claimsFromDefect(defect());
  const keeper = asked();
  const namesNoClaim = asked({
    question: "what does line 400 of orchestrator.ts do?",
    refutes: "claim:there-is-no-such-claim",
  });
  const cannotSurprise = asked({
    question: "is the phase called gate?",
    refutes: "claim:class",
    surprisingAnswer: "   ",
  });

  const bounded = boundQuestions([keeper, namesNoClaim, cannotSurprise], claims);

  assert.equal(bounded.kept.length, 1, "a question that names no claim is dropped");
  assert.equal(bounded.kept[0]?.question, keeper.question);
  const keptText = bounded.kept.map((question) => question.question);
  assert.ok(!keptText.includes(namesNoClaim.question), "the claimless question is not kept");
  assert.ok(!keptText.includes(cannotSurprise.question), "the unsurprising question is not kept");
  assert.deepEqual(
    bounded.dropped.map((drop) => drop.reason),
    ["NAMES_NO_CLAIM", "NO_SURPRISE"],
    "each drop is recorded under its own reason, never collapsed into one count",
  );
});

/**
 * MUTATION RUN: replace the `if (seen.has(fingerprint)) { … }` block in
 * `boundQuestions` with `void seen;`.
 * RED: `AssertionError: the same question twice is one question` — 2 kept where
 * 1 was expected.
 */
test("the bound folds a question asked twice about the same claim", () => {
  const claims = claimsFromDefect(defect());
  const bounded = boundQuestions([asked(), asked({ question: "phrased differently, same probe" })], claims);
  assert.equal(bounded.kept.length, 1, "the same question twice is one question");
  assert.deepEqual(bounded.dropped.map((drop) => drop.reason), ["DUPLICATE"]);
});

/**
 * The cap is NOT the bound, and this test exists so the two can never be
 * conflated: a question dropped by the ceiling carries `OVER_CAP` and not
 * `NAMES_NO_CLAIM`, so the §11.3 metrics can tell "the asker drowned us" from
 * "the asker asked about nothing".
 */
test("a question dropped by the parse ceiling is recorded as OVER_CAP, not as a failed bound", () => {
  const claims = claimsFromDefect(defect());
  const many = Array.from({ length: MAX_ASKED_QUESTIONS + 3 }, (_unused, index) =>
    asked({ question: `question ${String(index)}`, surprisingAnswer: `surprise ${String(index)}` }),
  );
  const bounded = boundQuestions(many, claims);
  assert.equal(bounded.kept.length, MAX_ASKED_QUESTIONS);
  assert.equal(bounded.dropped.length, 3);
  assert.deepEqual(new Set(bounded.dropped.map((drop) => drop.reason)), new Set(["OVER_CAP"]));
});

/**
 * THE STATED BOUND AND THE ENFORCED BOUND ARE THE SAME NUMBER.
 *
 * `askForQuestions` prints its cap into the prompt. If `boundQuestions` read the
 * module constant instead of the caller's number, the asker would be told "at
 * most 2" and forty would be admitted — a bound visible in the transcript and
 * absent from the code, which is worse than no bound.
 *
 * MUTATION RUN: in `boundQuestions`, ignore the parameter —
 * `if (kept.length >= MAX_ASKED_QUESTIONS) {`.
 * RED: `AssertionError: the cap the prompt stated is the cap the filter
 * enforces` — 5 kept where 2 were expected.
 */
test("a caller's smaller cap is the one the filter enforces, not the module default", async () => {
  const record = defect();
  const claims = claimsFromDefect(record);
  const five = Array.from({ length: 5 }, (_unused, index) =>
    asked({ question: `q${String(index)}`, surprisingAnswer: `s${String(index)}` }),
  );
  assert.equal(boundQuestions(five, claims, 2).kept.length, 2, "the cap the prompt stated is the cap the filter enforces");

  const codex = fakeCodex(
    JSON.stringify(five.map((question) => ({ question: question.question, refutes: question.refutes, surprisingAnswer: question.surprisingAnswer }))),
  );
  const ask = createCodexAsk({ cwd: "/repo", env: { PATH: "/usr/bin" }, factory: codex.factory });
  const result = await askForQuestions({ ask, defect: record, claims, timeoutMs: 5_000, maxQuestions: 2 });
  assert.equal(result.bounded.kept.length, 2, "the cap the prompt stated is the cap the filter enforces");
  assert.deepEqual(result.bounded.dropped.map((drop) => drop.reason), ["OVER_CAP", "OVER_CAP", "OVER_CAP"]);
  assert.ok(codex.prompts[0]?.includes("AT MOST 2 questions"), "and it is the number the asker was shown");
});

/* -------------------------------------------------------------------------
 * 3. THE GUARD (§10.3) — unassignable IS owner
 * ---------------------------------------------------------------------- */

/**
 * THE LANE'S SECOND REQUIRED MUTATION.
 *
 * MUTATION RUN: in `resolveAnswer`, default the unassignable source to CODE —
 * `if (attempt.source === null) attempt = { ...attempt, source: "CODE" };`
 * inserted after the no-attempt park, so the `source === null` arm below never
 * fires.
 * RED: `AssertionError: a question with no assignable source is an OWNER
 * question :: 'CODE' !== 'OWNER'`.
 *
 * All four OWNER fields are asserted, not just the tag: a park that kept the
 * model's answer text in `answer` would be the priors surviving the routing,
 * which is the whole thing §10.3 forbids.
 *
 * THE ATTEMPT CARRIES A WELL-SHAPED CITATION ON PURPOSE. With `citation: null`
 * the citation check would park it too, and this test would stay green under the
 * default-to-CODE mutation — a check that can only observe success. The missing
 * SOURCE has to be the only thing here that can park it.
 */
test("a question that cannot be assigned an evidence source becomes an OWNER question", () => {
  const question = asked();
  const parked = resolveAnswer(
    question,
    {
      question: question.question,
      source: null,
      answer: "I think node wraps it, from memory",
      citation: "dashboard/server/src/scorer-container.ts:1218",
      changedDiagnosis: true,
    },
    "CODEX",
  );
  assert.equal(parked.source, "OWNER", "a question with no assignable source is an OWNER question");
  assert.equal(parked.answer, null, "the model's priors do not survive the park as an answer");
  assert.equal(parked.citation, null);
  assert.equal(parked.outcome, "UNANSWERED", "a parked question confirmed nothing and changed nothing");
  assert.equal(parked.asker, "CODEX");
  assert.equal(parked.claimId, question.refutes);
  assert.ok(
    parked.source === "OWNER" && parked.why.includes("§10.3"),
    "the park says WHICH rule refused it, because that text is the owner's email",
  );
});

/** No attempt at all is the same fact as an unassignable one, and lands identically. */
test("a kept question nobody answered is an OWNER question, not a missing row", () => {
  const question = asked();
  const parked = resolveAnswer(question, null, "CODEX");
  assert.equal(parked.source, "OWNER");
  assert.equal(parked.outcome, "UNANSWERED");
  assert.ok(parked.source === "OWNER" && parked.why.includes("no answer was produced"));
});

/**
 * THE LANE'S THIRD REQUIRED MUTATION.
 *
 * MUTATION RUN: in `citationProblem`, replace the null/empty guard with
 * `if (citation === null) return null;`.
 * RED: `AssertionError: an uncited CODE answer is not an answer` — the first of
 * the four sources this test walks.
 */
test("an answer with no citation is refused for every evidenced source", () => {
  for (const source of EVIDENCE_SOURCES) {
    assert.notEqual(citationProblem(source, null), null, `an uncited ${source} answer is not an answer`);
    assert.notEqual(citationProblem(source, "   "), null, `a whitespace ${source} citation is not a citation`);
  }
  const question = asked();
  for (const source of EVIDENCE_SOURCES) {
    const resolved = resolveAnswer(
      question,
      { question: question.question, source, answer: "yes, it is wrapped", citation: null, changedDiagnosis: false },
      "CODEX",
    );
    assert.equal(resolved.source, "OWNER", `an uncited ${source} answer must park, not land`);
    assert.equal(resolved.answer, null);
    assert.equal(resolved.citation, null);
  }
});

/**
 * MUTATION RUN: in `citationProblem`, short-circuit every arm with
 * `const nonEmptyIsEnough: boolean = true; if (nonEmptyIsEnough) { void source;
 * return value.length === 0 ? "empty" : null; }` before the switch.
 * RED: `AssertionError: a CODE citation must be a file:line`, plus the CODEX
 * test and "a citation valid for one source does not satisfy another"
 * (`'CODE' !== 'OWNER'`) — three tests, because the shape rule is what all three
 * rest on.
 *
 * This is the test that stops the guard being decorative. §10.3's table names a
 * SHAPE per source; a validator that only checked emptiness would observe
 * nothing, which is the same defect as a test that cannot go red.
 */
test("each source's citation must be the shape §10.3 names for it", () => {
  // CODE — a file:line, and nothing else.
  assert.equal(citationProblem("CODE", "dashboard/server/src/defect-record.ts:186"), null);
  assert.equal(citationProblem("CODE", "scorer-container.ts:1218-1240"), null);
  assert.notEqual(citationProblem("CODE", "yes"), null, "a CODE citation must be a file:line");
  assert.notEqual(citationProblem("CODE", "defect-record.ts"), null, "a file with no line is not a file:line");
  assert.notEqual(citationProblem("CODE", "it is on line 186"), null);

  // DATA — a named store plus the query that was run against it.
  assert.equal(citationProblem("DATA", `dashboard/data/runs.db${CITATION_SEPARATOR}SELECT failure_reason FROM runs`), null);
  assert.equal(citationProblem("DATA", `dashboard/results/scorer-out/result.json${CITATION_SEPARATOR}.criterionCoverage[].testRefs`), null);
  assert.notEqual(citationProblem("DATA", "runs.db"), null, "a store with no query is not a query");
  assert.notEqual(citationProblem("DATA", `somewhere.txt${CITATION_SEPARATOR}SELECT 1`), null, "the store must be runs.db or results/");
  assert.notEqual(citationProblem("DATA", `runs.db${CITATION_SEPARATOR}   `), null);

  // EXPERIMENT — §10.3's "an exit code from something actually run".
  assert.equal(citationProblem("EXPERIMENT", `node --test dist/repair-questions.test.js${CITATION_SEPARATOR}exit 1`), null);
  assert.notEqual(
    citationProblem("EXPERIMENT", "node --test dist/repair-questions.test.js"),
    null,
    "a command with no exit code is not an experiment: nothing says it was ever run",
  );
  assert.notEqual(citationProblem("EXPERIMENT", `${CITATION_SEPARATOR}exit 0`), null, "an exit code with no command cites nothing");
});

/**
 * MUTATION RUN: in `citationProblem`'s CODEX arm, accept the thread id alone —
 * `const twoModelsAgreeingIsEvidence: boolean = true; if
 * (twoModelsAgreeingIsEvidence) return null;` before the underlying-citation
 * checks.
 * RED: `AssertionError: two models agreeing is still two models agreeing
 * (§10.5.5)`.
 *
 * §10.5.5: "Two models agreeing is still two models agreeing — it is not
 * evidence, and it never reaches the gate as if it were." CODEX is a ROUTE to
 * evidence; the citation has to carry the thing Codex pointed AT.
 */
test("a CODEX citation carries the evidence Codex pointed at, not merely that Codex said so", () => {
  assert.equal(
    citationProblem("CODEX", `codex:thread-abc123${CITATION_SEPARATOR}dashboard/server/src/scorer-container.ts:1218`),
    null,
    "thread id plus the file:line it named is evidence",
  );
  assert.equal(
    citationProblem("CODEX", `codex:thread-abc123${CITATION_SEPARATOR}npm test${CITATION_SEPARATOR}exit 1`),
    null,
    "thread id plus a command it ran and the exit code is evidence",
  );
  assert.notEqual(
    citationProblem("CODEX", "codex:thread-abc123"),
    null,
    "a Codex thread id is provenance, not evidence",
  );
  assert.notEqual(
    citationProblem("CODEX", `codex:thread-abc123${CITATION_SEPARATOR}codex agreed with the diagnosis`),
    null,
    "two models agreeing is still two models agreeing (§10.5.5)",
  );
  assert.notEqual(
    citationProblem("CODEX", `dashboard/server/src/defect-record.ts:186`),
    null,
    "a CODEX answer with no thread id is not attributable",
  );
});

/** A citation of the right SHAPE but the wrong SOURCE is still refused. */
test("a citation valid for one source does not satisfy another", () => {
  const question = asked();
  const resolved = resolveAnswer(
    question,
    {
      question: question.question,
      source: "CODE",
      answer: "the runs table says so",
      citation: `dashboard/data/runs.db${CITATION_SEPARATOR}SELECT 1`,
      changedDiagnosis: false,
    },
    "CODEX",
  );
  assert.equal(resolved.source, "OWNER", "a DATA-shaped citation does not make a CODE answer");
});

/* -------------------------------------------------------------------------
 * 4. The guard, at the type level
 * ---------------------------------------------------------------------- */

/**
 * THE GUARD'S OTHER HALF, ENFORCED BY `tsc` RATHER THAN BY AN ASSERTION.
 *
 * `AnsweredQuestion.citation` is `string`, so an evidenced answer with no
 * citation is NOT CONSTRUCTIBLE. The two directives below are the test: if the
 * field is ever widened to `string | null`, the first directive becomes unused
 * and TypeScript raises TS2578, which fails `npm run build` and therefore fails
 * `npm test` before a single test executes.
 *
 * MUTATION RUN: widen `AnsweredQuestion.citation` to `string | null`.
 * RED at build: `src/repair-questions.test.ts: error TS2578: Unused
 * '@ts-expect-error' directive.` (on the first directive below — the error
 * IDENTITY is recorded and the line number deliberately is not, because a line
 * number in a docblock is stale the next time anyone edits above it.)
 *
 * MUTATION RUN: widen `OwnerQuestion.citation` to `string | null`.
 * RED at build: the same TS2578, on the second directive.
 */
test("the type system refuses an evidenced answer with no citation, and a park with one", () => {
  const uncitable: AnsweredQuestion = {
    question: "is `details.error` the thrown error?",
    source: "CODE",
    answer: "no",
    // @ts-expect-error an evidenced answer without a citation must not be constructible (§10.3)
    citation: null,
    outcome: "CHANGED_DIAGNOSIS",
    asker: "CODEX",
    claimId: "claim:site",
  };
  const parkedWithCitation: OwnerQuestion = {
    question: "should the lane widen its writable scope?",
    source: "OWNER",
    answer: null,
    // @ts-expect-error a parked question has no citation: an evidenced park is a contradiction
    citation: "dashboard/server/src/repair-questions.ts:1",
    outcome: "UNANSWERED",
    asker: "CODEX",
    claimId: "claim:site",
    why: "no evidence source applies",
  };
  assert.equal(uncitable.source, "CODE");
  assert.equal(parkedWithCitation.source, "OWNER");
});

/* -------------------------------------------------------------------------
 * 5. Resolution end to end
 * ---------------------------------------------------------------------- */

test("a properly cited answer lands with the outcome its answerer reported", () => {
  const question = asked();
  const landed = resolveAnswer(
    question,
    {
      question: question.question,
      source: "CODE",
      answer: "no. node wraps it in ERR_TEST_FAILURE; the real error is on .cause",
      citation: "dashboard/server/src/scorer-container.ts:1218",
      changedDiagnosis: true,
    },
    "CODEX",
  );
  assert.equal(landed.source, "CODE");
  assert.equal(landed.outcome, "CHANGED_DIAGNOSIS");
  assert.equal(landed.citation, "dashboard/server/src/scorer-container.ts:1218");
  assert.equal(landed.asker, "CODEX");
});

/**
 * MUTATION RUN: in `resolveQuestions`, `return { questions, ignoredAttempts: [] }`.
 * RED: `AssertionError: an answer to a question nobody asked is reported, not
 * swallowed`.
 */
test("an answer to a question nobody asked is reported rather than swallowed", () => {
  const question = asked();
  const resolved = resolveQuestions(
    [question],
    [
      {
        question: question.question,
        source: "CODE",
        answer: "no",
        citation: "a/b.ts:1",
        changedDiagnosis: false,
      },
      {
        question: "a question that was never asked",
        source: "CODE",
        answer: "42",
        citation: "a/b.ts:2",
        changedDiagnosis: true,
      },
    ],
    "CODEX",
  );
  assert.equal(resolved.questions.length, 1);
  assert.deepEqual(
    resolved.ignoredAttempts,
    ["a question that was never asked"],
    "an answer to a question nobody asked is reported, not swallowed",
  );
});

/**
 * TWO ANSWERS TO ONE QUESTION IS AN EVENT, NOT A LAST-WINS ASSIGNMENT.
 *
 * MUTATION RUN: in `resolveQuestions`, go back to last-wins with no record —
 * `for (const attempt of attempts) byQuestion.set(attempt.question, attempt);`.
 * RED: `AssertionError: first answer wins, deterministically` — the landed row
 * carried the SECOND answer's citation, and the panel would have shown one
 * answer with no sign the other existed.
 *
 * MUTATION RUN, the other half: keep first-wins but report only the unmatched —
 * `return { questions, ignoredAttempts: unmatched };`.
 * RED: `AssertionError: a contradicting second answer is surfaced, not silently
 * preferred`.
 */
test("a second, contradicting answer to the same question is surfaced rather than silently preferred", () => {
  const question = asked();
  const resolved = resolveQuestions(
    [question],
    [
      {
        question: question.question,
        source: "CODE",
        answer: "no — it is wrapped",
        citation: "dashboard/server/src/scorer-container.ts:1218",
        changedDiagnosis: true,
      },
      {
        question: question.question,
        source: "CODE",
        answer: "yes — it is the thrown error after all",
        citation: "dashboard/server/src/scorer-container.ts:9999",
        changedDiagnosis: false,
      },
    ],
    "CODEX",
  );
  assert.equal(resolved.questions.length, 1);
  const landedRow = resolved.questions[0];
  assert.equal(landedRow?.citation, "dashboard/server/src/scorer-container.ts:1218", "first answer wins, deterministically");
  assert.deepEqual(
    resolved.ignoredAttempts,
    [question.question],
    "a contradicting second answer is surfaced, not silently preferred",
  );
});

/* -------------------------------------------------------------------------
 * 6. Parsing
 * ---------------------------------------------------------------------- */

test("the array reader survives prose around it and brackets inside it", () => {
  const rows = extractJsonArray('Here you go:\n[{"question":"is [x] the thing?","refutes":"claim:site"}]\nHope that helps.');
  assert.equal(rows?.length, 1);
  assert.equal(extractJsonArray("no array here"), null);
  assert.equal(extractJsonArray("[not json"), null);
});

/**
 * MUTATION RUN: in `parseAskedQuestions`, `return { asked, problems: [] }`.
 * RED: `AssertionError: a malformed entry is named, never silently dropped`,
 * and `askForQuestions` went red with it — the loop reports the asker's junk
 * through this same field.
 */
test("a malformed entry from the asker is named rather than silently dropped", () => {
  const parsed = parseAskedQuestions('[{"question":"a real one","refutes":"claim:site","surprisingAnswer":"no"},7,{"refutes":"claim:site"}]');
  assert.equal(parsed.asked.length, 1);
  assert.equal(parsed.problems.length, 2, "a malformed entry is named, never silently dropped");
  assert.equal(parseAskedQuestions("I have no questions.").problems.length, 1);
});

/* -------------------------------------------------------------------------
 * 7. The Codex seam — no live call, and the billing control measured
 * ---------------------------------------------------------------------- */

/**
 * THE BILLING CONTROL, MEASURED THROUGH THE SEAM THE REAL SDK USES.
 *
 * MUTATION RUN: in `createCodexAsk`, construct with the raw environment —
 * `factory({ env: deps.env as unknown as Record<string, string> })`.
 * RED: `AssertionError: ANTHROPIC_API_KEY must never reach the Codex CLI: it
 * silently selects metered billing` — the first name in `STRIPPED_ENV_NAMES`
 * that this fixture sets, which is why the list is walked rather than sampled.
 *
 * The forbidden list is IMPORTED, never re-typed: `security.test.ts:175-187`
 * uses the same pattern, and a hand-copied list drifts the day a twelfth
 * credential is added to `subprocess-env.ts`.
 */
test("the asker's subprocess sees no metered credential, and keeps the variables the CLI needs", async () => {
  const codex = fakeCodex("[]");
  const ask = createCodexAsk({
    cwd: "/repo",
    env: {
      PATH: "/usr/bin",
      HOME: "/home/owner",
      CODEX_HOME: "/home/owner/.codex",
      OPENAI_API_KEY: "sk-live-should-never-travel",
      CODEX_API_KEY: "also-should-never-travel",
      ANTHROPIC_API_KEY: "nor-this-one",
    },
    factory: codex.factory,
  });
  const result = await ask({ prompt: "hello", timeoutMs: 5_000, purpose: "test" });

  assert.equal(result.failure, null);
  assert.equal(codex.constructedWith.length, 1);
  const sent = codex.constructedWith[0] ?? {};
  for (const name of STRIPPED_ENV_NAMES) {
    assert.ok(!(name in sent), `${name} must never reach the Codex CLI: it silently selects metered billing`);
  }
  assert.equal(sent["PATH"], "/usr/bin", "PATH survives: the subtraction is not an allowlist");
  assert.equal(sent["CODEX_HOME"], "/home/owner/.codex", "CODEX_HOME is how the CLI finds the owner's login");
});

/**
 * MUTATION RUN: set `sandboxMode: "workspace-write"` in
 * `CODEX_ASKER_THREAD_OPTIONS` — i.e. give the asker the builder's sandbox
 * (`codex-builder.ts:137`).
 * RED: `AssertionError: the asker asks; it does not write`.
 */
test("the asker's thread is read-only, unattended, and rooted at the repository it was given", async () => {
  const codex = fakeCodex("[]");
  const ask = createCodexAsk({ cwd: "/repo", env: { PATH: "/usr/bin" }, factory: codex.factory });
  await ask({ prompt: "hello", timeoutMs: 5_000, purpose: "test" });

  const options = codex.threadOptions[0] as Record<string, unknown>;
  assert.equal(options["sandboxMode"], "read-only", "the asker asks; it does not write");
  assert.equal(options["approvalPolicy"], "never", "there is no human in the room to approve anything");
  assert.equal(options["networkAccessEnabled"], false, "an asker installs nothing");
  assert.equal(options["workingDirectory"], "/repo");
  assert.equal(CODEX_ASKER_THREAD_OPTIONS.sandboxMode, "read-only");
});

/**
 * MUTATION RUN: let the rejection escape `createCodexAsk` — `const rethrow:
 * boolean = true; if (rethrow) throw error;` as the first statement of the
 * catch.
 * RED: both this test and "a failed ask yields no questions and a named
 * failure" rejected with `Error: aborted` instead of returning a failure.
 *
 * §10.5.2: questions can only ADD. An asker that cannot be reached degrades the
 * repair to no questions, never to no repair.
 */
test("an asker that never answers times out into a failure, and does not throw", async () => {
  const codex = fakeCodex(async () => await new Promise(() => { /* never settles */ }));
  const ask = createCodexAsk({ cwd: "/repo", env: { PATH: "/usr/bin" }, factory: codex.factory });
  const result = await ask({ prompt: "hello", timeoutMs: 5, purpose: "test" });
  assert.equal(result.text, "");
  assert.ok(result.failure?.includes("did not answer within"), "a dead asker must not kill the repair");
  assert.equal(result.threadId, "thread-abc123", "the thread is still named, so the turn is attributable");
});

/**
 * The front half of §10.5.3's loop, through the seam: ask, parse, bound.
 *
 * MUTATION RUN: in `askForQuestions`, return `parsed.asked` unfiltered as
 * `kept`.
 * RED on "the loop bounds what the asker returned" (kept 2, expected 1).
 */
test("askForQuestions bounds what came back, and reports what the asker sent that was not a question", async () => {
  const record = defect();
  const claims = claimsFromDefect(record);
  const codex = fakeCodex(
    JSON.stringify([
      { question: "is the site really the validator?", refutes: "claim:site", surprisingAnswer: "no, it is the freezer" },
      { question: "what colour is the dashboard?", refutes: "claim:nonexistent", surprisingAnswer: "blue" },
      { question: "" },
    ]),
  );
  const ask = createCodexAsk({ cwd: "/repo", env: { PATH: "/usr/bin" }, factory: codex.factory });
  const asked1 = await askForQuestions({ ask, defect: record, claims, timeoutMs: 5_000 });

  assert.equal(asked1.bounded.kept.length, 1, "the loop bounds what the asker returned");
  assert.deepEqual(asked1.bounded.dropped.map((drop) => drop.reason), ["NAMES_NO_CLAIM"]);
  assert.equal(asked1.problems.length, 1, "the empty entry is named");
  assert.equal(asked1.threadId, "thread-abc123");
  assert.ok(codex.prompts[0]?.includes(THE_ASK));
});

test("a failed ask yields no questions and a named failure, never an exception", async () => {
  const record = defect();
  const codex = fakeCodex(async () => await new Promise(() => { /* never settles */ }));
  const ask = createCodexAsk({ cwd: "/repo", env: { PATH: "/usr/bin" }, factory: codex.factory });
  const result = await askForQuestions({
    ask,
    defect: record,
    claims: claimsFromDefect(record),
    timeoutMs: 5,
  });
  assert.equal(result.bounded.kept.length, 0);
  assert.equal(result.failure !== null, true);
  assert.equal(result.problems.length, 1);
});

/* -------------------------------------------------------------------------
 * 8. §11 — the panel and the metric that can kill the feature
 * ---------------------------------------------------------------------- */

function landed(outcome: "CHANGED_DIAGNOSIS" | "CONFIRMED", question: string): AnsweredQuestion {
  return {
    question,
    source: "CODE",
    answer: "measured",
    citation: "dashboard/server/src/repair-questions.ts:1",
    outcome,
    asker: "CODEX",
    claimId: "claim:site",
  };
}

function parked(question: string): OwnerQuestion {
  return {
    question,
    source: "OWNER",
    answer: null,
    citation: null,
    outcome: "UNANSWERED",
    asker: "CODEX",
    claimId: "claim:site",
    why: "no evidence source applies",
  };
}

/**
 * MUTATION RUN: in `groupQuestions`, swap the outcome arms —
 * `else if (question.outcome === "CONFIRMED") changedDiagnosis.push(question);`.
 * RED: `AssertionError: 2 !== 1` on `panel.changedDiagnosis.length`.
 *
 * MUTATION RUN, AND IT DID NOT COMPILE, WHICH IS THE MORE INTERESTING RESULT:
 * routing OWNER rows away from `needsYou` —
 * `if (question.source === "OWNER" && question.why === "") needsYou.push(...)`.
 * RED at build: `src/repair-questions.ts: error TS2345: Argument of type
 * 'RepairQuestion' is not assignable to parameter of type 'AnsweredQuestion'`.
 * The discriminated union makes "an OWNER row in the CONFIRMED group"
 * unconstructible, so `needsYou` cannot silently stop being the OWNER set — the
 * same thing `citation: string` does for the guard, one level up.
 */
test("the panel groups by outcome, and NEEDS YOU is exactly the OWNER set", () => {
  const questions: readonly RepairQuestion[] = [
    landed("CONFIRMED", "did the freezer run?"),
    parked("should the lane be allowed to restructure this interface?"),
    landed("CHANGED_DIAGNOSIS", "is `details.error` the thrown error?"),
    landed("CONFIRMED", "is the phase gate?"),
  ];
  const panel = groupQuestions(questions);
  assert.equal(panel.needsYou.length, 1, "NEEDS YOU is the OWNER set, and it is what the email carries");
  assert.equal(panel.changedDiagnosis.length, 1);
  assert.equal(panel.confirmed.length, 2);
  assert.equal(panel.needsYou[0]?.source, "OWNER");
});

/**
 * §11.3's second metric is deliberately self-refuting, so it is asserted in the
 * direction that refutes the feature as well as the one that supports it.
 *
 * MUTATION RUN: `askerChangedNothing: panel.changedDiagnosis.length === 0`
 * (drop the `questions.length > 0` conjunct).
 * RED: `AssertionError: no questions asked is not the same statement as no
 * questions landed` — an empty panel would have reported the asker as ceremony.
 */
test("the metric that can kill the feature reports zero-changed, and does not confuse it with zero-asked", () => {
  const ceremony = questionMetrics([landed("CONFIRMED", "a"), landed("CONFIRMED", "b"), parked("c")]);
  assert.equal(ceremony.total, 3);
  assert.equal(ceremony.owner, 1);
  assert.equal(ceremony.confirmed, 2);
  assert.equal(ceremony.changedDiagnosis, 0);
  assert.equal(ceremony.askerChangedNothing, true, "an asker that changed nothing is ceremony, and the panel says so");

  const earning = questionMetrics([landed("CHANGED_DIAGNOSIS", "a"), landed("CONFIRMED", "b")]);
  assert.equal(earning.askerChangedNothing, false);

  const nothingAsked = questionMetrics([]);
  assert.equal(
    nothingAsked.askerChangedNothing,
    false,
    "no questions asked is not the same statement as no questions landed",
  );
});

/**
 * ONE STRAY BRACKET MUST NOT DISCARD THE WHOLE QUESTION SET.
 *
 * Found 2026-08-16. `extractJsonArray` locked onto `text.indexOf("[")`, so a
 * bracketed token anywhere in the asker's preamble — a footnote marker, a
 * markdown link — became the presumed start of the array. It closed
 * immediately, `JSON.parse` failed, the function returned null, and the caller
 * reported "the asker returned nothing". An independent model is paid to produce
 * those questions and one bracket in its prose threw all of them away.
 *
 * MUTATION: revert to a single `text.indexOf("[")` scan -> RED.
 */
test("a bracketed token in the asker's prose does not discard its questions", () => {
  const reply =
    'Here is what I would need to know [1], based on the record:\n' +
    '[{"refutes":"c-1","question":"is details.error the thrown error?","surprisingAnswer":"no, node wraps it"}]';
  const found = extractJsonArray(reply);
  assert.ok(found !== null, "the whole question set was discarded by a footnote marker");
  assert.equal(found.length, 1);
});

test("prose with no array at all is still null — the control", () => {
  assert.equal(extractJsonArray("I could not think of anything worth asking [see above]."), null);
});

/**
 * THE ASKER'S STARTUP IS THE PART MOST LIKELY TO FAIL ON A FRESH MACHINE, and it
 * sat outside the try. A missing Codex login rejected the promise, and
 * `askForQuestions` has no catch, so the repair died at the question step.
 *
 * MUTATION: move `factory(...)`/`startThread(...)` back above the `try` -> this
 * rejects instead of resolving and goes RED.
 */
test("an asker that cannot start returns a failure instead of throwing", async () => {
  const ask = createCodexAsk({
    env: {},
    cwd: "/tmp",
    factory: () => {
      throw new Error("codex: not logged in");
    },
  });
  const result = await ask({ prompt: "anything", timeoutMs: 1_000, purpose: "ask" });
  assert.equal(result.text, "");
  assert.match(result.failure ?? "", /could not be started/);
  assert.match(result.failure ?? "", /not logged in/, "and it names what actually went wrong");
});
