/**
 * judge-ceiling.test.ts — the judge's output ceiling, and what it does when it
 * hits one.
 *
 * WHY THIS FILE EXISTS. Until 2026-08-04 `judgeArtifact` asked for 16,000 output
 * tokens and got the CLI's 64,000 default, because `subscription-caller.ts` had
 * no way to send the number. Now it does. That turns a decorative constant into
 * a real cut, and a real cut needs two things nobody had written: a number with
 * a derivation ({@link JUDGE_MAX_OUTPUT_TOKENS}'s docblock states it, including
 * the part where NO judge turn has ever been measured), and a branch that says
 * so when the cut lands.
 *
 * THE FAILURE THIS PREVENTS IS A MISATTRIBUTION, NOT A CRASH. `judgeArtifact`
 * never fails a run — it reports `verdict: "unavailable"` and says why — so a
 * truncated report was always going to be survivable. What it was NOT going to
 * be is honest: the truncated text falls out of `parseReport` as `null` and the
 * summary reads "the judge returned no parseable JSON object", which points at
 * the model when the cause is a ceiling this file sets.
 *
 * NEGATIVE CONTROLS. Applied to `judge.ts`, run, WATCHED RED, reverted
 * (2026-08-04):
 *
 *   mutation                                        test that went red
 *   delete the `call.stopReason === "max_tokens"`    "a truncated report is
 *     branch                                          named as truncated"
 *   `maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS`      "the judge's declared
 *     → `maxOutputTokens: 16_000`                     ceiling reaches the
 *                                                     subprocess"
 *
 * NO MODEL IS CALLED. `JudgeRequest.startQuery` replaces the SDK's `query` with
 * a factory that replays fixed frames.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AcceptanceCriterion, AnthropicSeat, Ticket } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT } from "bakeoff/dist/config.js";

import { JUDGE_MAX_OUTPUT_TOKENS, judgeArtifact } from "./judge.js";
import { DASHBOARD_BUDGET } from "./orchestrator.js";
import { MAX_OUTPUT_TOKENS_ENV } from "./subscription-caller.js";
import type { SeatSessionFactory } from "./subscription-caller.js";

const SEAT: AnthropicSeat = { ...JUDGE_SEAT, modelId: "default", effort: "low" };

const TICKET = {
  id: "t-judge",
  brief: "Build a page that lists three projects.",
  sha256: "0".repeat(64),
  tier: "trivial",
  title: "judge fixture",
} as unknown as Ticket;

/**
 * CAST NARROWLY, as the sibling caller tests do. `renderInputs` reads three
 * fields off a criterion; the real shape carries evidence bindings this path
 * never touches, and writing them out would make the fixture a test of
 * `contracts.ts`.
 */
const CRITERIA: readonly AcceptanceCriterion[] = [
  { id: "REQ-001", tier: "blocking", statement: "the page lists three projects" } as unknown as AcceptanceCriterion,
];

function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

const USAGE = {
  input_tokens: 40,
  output_tokens: 32_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

function replaying(frames: readonly SDKMessage[]): {
  factory: SeatSessionFactory;
  dispatches: Dispatch[];
} {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      for (const frame of frames) yield frame;
    })();
  };
  return { factory, dispatches };
}

function judgeRequest(startQuery: SeatSessionFactory): Parameters<typeof judgeArtifact>[0] {
  return {
    ticket: TICKET,
    criteria: CRITERIA,
    diff: "--- a/index.html\n+++ b/index.html\n+<h1>three projects</h1>",
    evidence: "GATE:boot passed",
    seat: SEAT,
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    signal: new AbortController().signal,
    startQuery,
  };
}

/* -------------------------------------------------------------------------
 * 1. A truncated report is named, not blamed on the model
 * ---------------------------------------------------------------------- */

/**
 * THE FIXTURE IS THE PARTIAL REPORT, NOT AN ERROR. A JSON object cut off
 * mid-object is what a real truncation produces — and it is important that the
 * text here would ALSO fail `parseReport`, because that is precisely the
 * ambiguity the new branch resolves. Without the stop-reason check this test
 * would still get `verdict: "unavailable"` and a summary blaming the model.
 */
test("a truncated report is named as truncated, not as unparseable JSON", async () => {
  const partial = '{"verdict":"concerns","findings":[{"criterionId":"REQ-001","kind":"stub","sev';
  const { factory } = replaying([
    envelope({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: partial }] },
      error: "max_output_tokens",
    }),
    envelope({
      type: "result",
      subtype: "success",
      stop_reason: null,
      is_error: false,
      result: partial,
      usage: USAGE,
    }),
  ]);

  const report = await judgeArtifact(judgeRequest(factory));

  assert.equal(report.ran, true, "the call was made; it is the RESULT that was cut off");
  assert.equal(report.verdict, "unavailable");
  assert.match(
    report.summary,
    /cut off/,
    "a truncated report must say it was truncated. Falling through to parseReport reports " +
      '"the judge returned no parseable JSON object", which is true and points at the wrong thing.',
  );
  assert.match(report.summary, new RegExp(String(JUDGE_MAX_OUTPUT_TOKENS)));
  assert.deepEqual(report.findings, [], "a partial reading is not a set of findings");
});

/**
 * THE OTHER SIDE OF THE SAME BRANCH. Unparseable output that was NOT truncated
 * must keep its own message — otherwise the new branch is a blanket that hides
 * a model returning prose, which is a different problem with a different fix.
 */
test("unparseable output that was not truncated keeps its own diagnosis", async () => {
  const { factory } = replaying([
    envelope({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "I had a look and it seems fine." }] },
    }),
    envelope({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
      result: "I had a look and it seems fine.",
      usage: USAGE,
    }),
  ]);

  const report = await judgeArtifact(judgeRequest(factory));

  assert.equal(report.verdict, "unavailable");
  assert.match(report.summary, /no parseable JSON object/);
});

/* -------------------------------------------------------------------------
 * 2. The declared ceiling travels
 * ---------------------------------------------------------------------- */

/**
 * ASSERTED AGAINST THE EXPORTED CONSTANT, NOT A LITERAL. The point of naming it
 * is that the number in the request and the number in the docblock that argues
 * for it cannot drift apart; a literal here would let them.
 */
test("the judge's declared ceiling reaches the subprocess environment", async () => {
  const { factory, dispatches } = replaying([
    envelope({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
      result: '{"verdict":"clean","findings":[],"summary":"honest work"}',
      usage: USAGE,
    }),
  ]);

  const report = await judgeArtifact(judgeRequest(factory));
  assert.equal(report.verdict, "clean");

  const dispatch = dispatches[0];
  assert.ok(dispatch !== undefined);
  assert.equal(dispatch.options.env?.[MAX_OUTPUT_TOKENS_ENV], String(JUDGE_MAX_OUTPUT_TOKENS));
});
