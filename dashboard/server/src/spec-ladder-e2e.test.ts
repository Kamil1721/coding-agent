/**
 * spec-ladder-e2e.test.ts — the two halves of the repair, joined across the
 * package boundary they are split by.
 *
 * ─── THE SEAM THIS FILE EXISTS FOR ───
 *
 * The self-healing behaviour this lane restored is written in two packages that
 * do not share a test run:
 *
 *   - `dashboard/server/src/subscription-caller.ts` classifies the CLI's
 *     over-length failure and RETURNS a result carrying `OVERFLOW_STOP_REASON`;
 *   - `bakeoff/src/spec-agent.ts` detects a truncation with
 *     `call.stopReason === "max_tokens"`, raises the budget and retries.
 *
 * Each half has its own tests and each half's tests pass with the other half
 * broken. Change `OVERFLOW_STOP_REASON` to `"max_output_tokens"` — a plausible
 * edit, since that IS the SDK's own name for the event — and
 * `subscription-caller.overflow.test.ts` stays green (it asserts against the
 * constant) and `spec-agent-ladder.test.ts` stays green (its stub returns the
 * literal `"max_tokens"`). The ladder is dead again and nothing goes red.
 *
 * That is precisely the defect class this lane was opened to remove, and it
 * would have been reintroduced at the package seam. So this file drives the REAL
 * caller through the REAL ladder. `dashboard/server` already depends on
 * `bakeoff` and imports its compiled output, so this is the one place where both
 * sides resolve.
 *
 * ─── WHAT IS ASSERTED, AND WHY IT IS THE ENVIRONMENT ───
 *
 * The subject is the sequence of `CLAUDE_CODE_MAX_OUTPUT_TOKENS` values that
 * reach the subprocess. That single list proves three things at once:
 *
 *   1. the classifier's stop reason is the string `wasTruncated` keys on
 *      (otherwise there is no second dispatch at all);
 *   2. the escalated budget is higher than the one that failed;
 *   3. the escalated budget actually TRAVELS, rather than being raised in a
 *      variable nothing sends.
 *
 * Reading it off `options.env` rather than off the `SeatCallRequest` is
 * deliberate: the request is what the harness asked for, and the environment is
 * what the model was told. The measured failure was a fifty-minute gap between
 * exactly those two things.
 *
 * NEGATIVE CONTROLS. Applied to production code, run, WATCHED RED, reverted
 * (2026-08-04):
 *
 *   mutation                                          effect
 *   `OVERFLOW_STOP_REASON` = "max_output_tokens"      dispatch list becomes
 *     (subscription-caller.ts) — the seam itself        3 calls, all at 64000
 *   `isOutputOverflowText` → `return false`           the call throws and
 *     (subscription-caller.ts)                          authoring dies at once
 *
 * NO MODEL IS CALLED. `startQuery` replays frames copied from the run that died.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import type { Ticket } from "bakeoff/dist/contracts.js";
import { ticketDigest } from "bakeoff/dist/hash.js";
import { generateAuditedSuite } from "bakeoff/dist/spec-agent.js";
import {
  CLI_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_AUTHORING_ATTEMPTS,
  MAX_STREAMABLE_OUTPUT_TOKENS,
} from "bakeoff/dist/spec-types.js";

import { DASHBOARD_BUDGET } from "./orchestrator.js";
import { MAX_OUTPUT_TOKENS_ENV, SubscriptionSeatCaller } from "./subscription-caller.js";
import type { SeatSessionFactory } from "./subscription-caller.js";

const BRIEF = "Build a page that lists three projects, each with a title and a one-line summary.";

const TICKET: Ticket = Object.freeze({
  id: "t-ladder-e2e",
  brief: BRIEF,
  sha256: ticketDigest(BRIEF),
  tier: "hard",
  title: "ladder end-to-end fixture",
});

/** The CLI's own sentence, copied out of the dead run's event log. */
const CLI_OVERFLOW_TEXT =
  "API Error: Claude's response exceeded the 64000 output token maximum. To configure this " +
  "behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";

function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

const USAGE = {
  input_tokens: 8,
  output_tokens: 64_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

/**
 * The first dispatch overflows exactly as the dead run did; every dispatch after
 * it answers with prose that carries no JSON object.
 *
 * THE LATER ANSWERS MUST BE UNPARSEABLE RATHER THAN GOOD. A successful retry
 * would end the run after two calls and prove only that the retry happened; an
 * unparseable one lets the run play out to its attempt cap, so the assertion can
 * also see that the raised budget STAYS raised for attempts 2 and 3 — which is
 * where a ladder that reset to the default would truncate all over again.
 */
function overflowThenUnparseable(): { factory: SeatSessionFactory; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    const first = dispatches.length === 1;
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      if (first) {
        yield envelope({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: CLI_OVERFLOW_TEXT }] },
        });
        yield envelope({
          type: "result",
          subtype: "success",
          stop_reason: null,
          is_error: true,
          result: CLI_OVERFLOW_TEXT,
          usage: USAGE,
        });
        throw new Error(`Claude Code returned an error result: ${CLI_OVERFLOW_TEXT}`);
      }
      yield envelope({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "I would rather describe it." }] },
      });
      yield envelope({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "I would rather describe it.",
        usage: USAGE,
      });
    })();
  };
  return { factory, dispatches };
}

test("the real caller's truncation reaches the real ladder, and the raised budget travels", async () => {
  const { factory, dispatches } = overflowThenUnparseable();

  const specCaller = new SubscriptionSeatCaller(SPEC_SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    startQuery: factory,
  });
  const judgeCaller = new SubscriptionSeatCaller(JUDGE_SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    ceiling: specCaller.ceiling,
    startQuery: factory,
  });

  await assert.rejects(
    () =>
      generateAuditedSuite(TICKET, {
        specCaller,
        judgeCaller,
        ceiling: specCaller.ceiling,
      }),
    (error: unknown) => {
      // THE RUN ENDS ON THE AUTHORING CAP, NOT ON THE TRUNCATION. Before this
      // lane it ended on the truncation, in the spec phase, fifty-one minutes
      // in, with a SeatCallError naming an environment variable nothing set.
      assert.ok(error instanceof BakeoffError, `expected a BakeoffError, got ${String(error)}`);
      assert.equal(error.code, "suite_not_audited");
      return true;
    },
  );

  assert.deepEqual(
    dispatches.map((dispatch) => dispatch.options.env?.[MAX_OUTPUT_TOKENS_ENV]),
    [
      String(CLI_DEFAULT_MAX_OUTPUT_TOKENS),
      String(MAX_STREAMABLE_OUTPUT_TOKENS),
      String(MAX_STREAMABLE_OUTPUT_TOKENS),
      String(MAX_STREAMABLE_OUTPUT_TOKENS),
    ],
    "the subprocess must be told 64000, then — after the classified overflow — 128000 for the free " +
      "retry and for every attempt after it. A three-entry list means the caller's stop reason is " +
      "not the string spec-agent's wasTruncated() keys on, and the two halves of this repair are " +
      "wired to each other by nothing.",
  );
  assert.equal(
    dispatches.length,
    DEFAULT_MAX_AUTHORING_ATTEMPTS + 1,
    "three authoring attempts plus one free truncation retry",
  );
});
