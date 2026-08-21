/**
 * subscription-caller.overflow.test.ts — the seat's output ceiling: sending it,
 * and surviving it being hit.
 *
 * ─── THE RUN THIS FILE IS ABOUT ───
 *
 * `run-2026-08-04T11-08-10-487Z-162b186d` spent 51 minutes in the spec phase and
 * died with this in its event log, verbatim:
 *
 *   the spec seat (default) call "suite-authoring t-956f3bbea410c8c7 attempt 1"
 *   failed: Claude Code returned an error result: API Error: Claude's response
 *   exceeded the 64000 output token maximum. To configure this behavior, set the
 *   CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.
 *
 * Two separate defects are visible in that one line and both are watched here.
 *
 * 64,000 IS NOT A NUMBER THIS REPOSITORY CHOSE. It is the CLI's default. Every
 * seat declared its own ceiling — 4000, 16000, 128000 — and none of them reached
 * the model, because the SDK's `Options` has no output-token field and nothing
 * set the environment variable that does. Tests 4 and 5 watch the declared value
 * arrive in the subprocess environment.
 *
 * AND THE FAILURE ARRIVED AS AN EXCEPTION, WHICH IS WHY IT WAS FATAL. Three feet
 * away in `bakeoff/src/spec-agent.ts` there is a ladder that detects a
 * truncation, raises the budget and retries for free — reading a RETURNED
 * `SeatCallResult`. It never ran, and could not have: `call()` threw. Tests 1-3
 * watch the classified over-length failure come back as a result carrying
 * `stopReason: "max_tokens"` instead.
 *
 * ─── THE SHAPE IS REPLAYED, NOT INVENTED ───
 *
 * It would be easy and wrong to stub a `subtype: "error_during_execution"` frame
 * here. That is not what happened. Reading the CLI binary and the SDK's own
 * `Query.readMessages`, the observed sequence is:
 *
 *   1. the CLI emits a result frame with `subtype: "success"`, `is_error: true`
 *      and the API error prose sitting in `result`;
 *   2. the subprocess exits non-zero, and the SDK's reader REPLACES the exit
 *      error with `Error("Claude Code returned an error result: <that prose>")`
 *      and rejects the stream.
 *
 * By step 2 every structured field is gone; the only thing left is English. A
 * classifier that only understood the SDK's declared `max_output_tokens` marker
 * would pass its own test and miss the failure that actually happens, which is
 * this repository's signature defect. So both are matched and both are watched
 * SEPARATELY — test 1 carries no structured marker, test 2 carries no prose.
 *
 * ─── NEGATIVE CONTROLS ───
 *
 * Each mutation applied to production code, run, WATCHED RED, reverted
 * (2026-08-04):
 *
 *   mutation                                          test that went red
 *   `isOutputOverflowText` → `return false`           1 (the measured shape)
 *     (subscription-caller.ts)
 *   `isOutputOverflowFrame` → `return false`          2 (the structured marker)
 *     (subscription-caller.ts)
 *   `seatCallEnv` returns `{ ...base }` always        4 (the ceiling reaches the
 *     (subscription-caller.ts)                          subprocess) and 5
 *
 * Test 3 is the control for the controls: it proves the classifier is a
 * classifier and not a blanket catch. A mutation that makes `isOutputOverflowText`
 * return TRUE for everything turns test 3 red.
 *
 * NO MODEL IS CALLED. `startQuery` is replaced with a factory that replays fixed
 * frames, exactly as `subscription-caller.documents.test.ts` does.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { SeatCallError } from "bakeoff/dist/anthropic-seat.js";
import type { SeatCallRequest } from "bakeoff/dist/anthropic-seat.js";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";

import { DASHBOARD_BUDGET } from "./orchestrator.js";
import {
  MAX_OUTPUT_TOKENS_ENV,
  OVERFLOW_STOP_REASON,
  SubscriptionSeatCaller,
  seatCallEnv,
} from "./subscription-caller.js";
import type { SeatSessionFactory } from "./subscription-caller.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const SEAT: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };

/** The CLI's own sentence, copied out of the dead run's event log. */
const CLI_OVERFLOW_TEXT =
  "API Error: Claude's response exceeded the 64000 output token maximum. To configure this " +
  "behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";

/** What the SDK's reader re-throws once the subprocess exits. */
const SDK_RETHROW = `Claude Code returned an error result: ${CLI_OVERFLOW_TEXT}`;

/**
 * A message as the CLI delivers it. CAST NARROWLY for the reason the sibling
 * document test gives: `SDKMessage` is a large union carrying `uuid`,
 * `session_id` and full content blocks this loop never reads.
 */
function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

const USAGE = {
  input_tokens: 12,
  output_tokens: 64_000,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 0,
};

function assistantFrame(text: string, error?: string): SDKMessage {
  return envelope({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...(error === undefined ? {} : { error }),
  });
}

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

/**
 * A factory that replays frames and then, optionally, THROWS.
 *
 * The throw is the load-bearing half. A generator that merely yields an error
 * frame and returns cleanly is not the observed failure; `call()` already
 * survived that shape by throwing a `SeatCallError` from the `failure` branch.
 */
function replaying(
  frames: readonly SDKMessage[],
  throwAfter: Error | null = null,
): { factory: SeatSessionFactory; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      for (const frame of frames) yield frame;
      if (throwAfter !== null) throw throwAfter;
    })();
  };
  return { factory, dispatches };
}

function request(overrides: Partial<SeatCallRequest> = {}): SeatCallRequest {
  return {
    system: "author an acceptance suite",
    userTurns: ["TICKET: build a landing page"],
    maxOutputTokens: 64_000,
    jsonSchema: null,
    purpose: "suite-authoring t-ladder attempt 1",
    ...overrides,
  };
}

function callerWith(factory: SeatSessionFactory): SubscriptionSeatCaller {
  return new SubscriptionSeatCaller(SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    // No Anthropic key: the base class only ever sees the sentinel, and nothing
    // in this file reaches a network either way.
    env: {},
    startQuery: factory,
  });
}

/* -------------------------------------------------------------------------
 * 1. The shape that actually killed a run
 * ---------------------------------------------------------------------- */

/**
 * NO STRUCTURED MARKER ANYWHERE IN THIS FIXTURE. The assistant frame carries no
 * `error` field and the result frame's `stop_reason` is null — deliberately, so
 * that the only thing that can classify this is the prose. That is the honest
 * worst case: by the time the SDK re-throws, prose is all there is.
 */
test("the measured over-length failure returns a truncation result instead of throwing", async () => {
  const { factory } = replaying(
    [
      assistantFrame(CLI_OVERFLOW_TEXT),
      envelope({
        type: "result",
        subtype: "success",
        stop_reason: null,
        is_error: true,
        result: CLI_OVERFLOW_TEXT,
        usage: USAGE,
      }),
    ],
    new Error(SDK_RETHROW),
  );
  const caller = callerWith(factory);

  const result = await caller.call(request());

  assert.equal(
    result.stopReason,
    OVERFLOW_STOP_REASON,
    "spec-agent's wasTruncated() keys off exactly this string; anything else and the repair ladder " +
      "is jumped over and the run dies on a config default.",
  );
  // THE CLI'S OWN DIAGNOSIS SURVIVES. `plan-seat.ts` logs `raw` "for the run log
  // when the parse refused", and a blank string there would leave no trace of a
  // turn that hit its ceiling.
  assert.match(result.text, /output token maximum/);
});

/**
 * THE ACCOUNTING RUNS ANYWAY. A truncated attempt still spent the tokens it
 * emitted, and the ladder is about to make a second call. Returning from inside
 * the `catch` — before `#tokens`/`#calls` are updated — would understate the
 * run's cost by exactly the expensive half, invisibly.
 */
test("a truncated attempt is still counted and its tokens still recorded", async () => {
  const { factory } = replaying(
    [
      assistantFrame(CLI_OVERFLOW_TEXT),
      envelope({
        type: "result",
        subtype: "success",
        stop_reason: null,
        is_error: true,
        result: CLI_OVERFLOW_TEXT,
        usage: USAGE,
      }),
    ],
    new Error(SDK_RETHROW),
  );
  const caller = callerWith(factory);

  await caller.call(request());

  assert.equal(caller.callCount, 1, "the call was dispatched and must be counted");
  assert.equal(caller.tokens.outputTokens, USAGE.output_tokens);
  assert.equal(caller.tokens.inputTokens, USAGE.input_tokens);
});

/* -------------------------------------------------------------------------
 * 2. The SDK's declared marker, on its own
 * ---------------------------------------------------------------------- */

/**
 * NO PROSE ANYWHERE IN THIS FIXTURE. `max_output_tokens` is a declared member of
 * `SDKAssistantMessageError` (`sdk.d.ts:2901`) and the CLI sets it on the
 * synthetic frame it emits when the API stream stops on max_tokens. Matching it
 * is what keeps this classifier working if the CLI ever rewords its sentence —
 * and separating it from test 1 is what proves the two detectors are genuinely
 * independent rather than one detector asserted twice.
 */
test("the SDK's own max_output_tokens marker is enough on its own", async () => {
  const { factory } = replaying([
    assistantFrame("here is the first half of the suite", "max_output_tokens"),
    envelope({
      type: "result",
      subtype: "success",
      stop_reason: null,
      is_error: false,
      result: "here is the first half of the suite",
      usage: USAGE,
    }),
  ]);
  const caller = callerWith(factory);

  const result = await caller.call(request());

  assert.equal(result.stopReason, OVERFLOW_STOP_REASON);
  // The partial response is preserved verbatim: it is what the model produced,
  // and nothing here is entitled to replace it with an error string.
  assert.equal(result.text, "here is the first half of the suite");
});

test("a default caller accepts an explicitly resumed incomplete-thinking success", async () => {
  const { factory } = replaying([
    envelope({
      type: "assistant",
      error: "max_output_tokens",
      message: {
        role: "assistant",
        stop_reason: "max_tokens",
        content: [{ type: "thinking", thinking: "", signature: "encrypted" }],
        usage: USAGE,
      },
    }),
    envelope({
      type: "assistant",
      resumed_from_incomplete_thinking: true,
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "resumed and completed" }],
        usage: USAGE,
      },
    }),
    envelope({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
      result: "resumed and completed",
      usage: USAGE,
    }),
  ]);

  const result = await callerWith(factory).call(request());

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, "resumed and completed");
});

/* -------------------------------------------------------------------------
 * 3. Everything else still throws — the control for the controls
 * ---------------------------------------------------------------------- */

/**
 * THE CLASSIFIER MUST BE A CLASSIFIER. The existing failure messages on this
 * path are unusually good — they name the turn cap, the rate-limit window, the
 * auth state and the exact remediation for each — and swallowing every error to
 * make the truncation path work would trade a dead run for a silent one, which
 * is worse. A crashed subprocess is not a truncation and must still throw.
 */
test("an unrelated subprocess failure still throws with its remediation intact", async () => {
  const { factory } = replaying([], new Error("Claude Code process exited with code 1"));
  const caller = callerWith(factory);

  await assert.rejects(
    () => caller.call(request()),
    (error: unknown) => {
      assert.ok(error instanceof SeatCallError, `expected a SeatCallError, got ${String(error)}`);
      assert.match(error.message, /exited with code 1/);
      // THE REMEDIATION IS A FIELD, NOT PROSE IN THE MESSAGE, and it is the half
      // that tells the owner what to do. Asserted explicitly because a
      // classifier that swallowed this error would lose it silently.
      assert.match(error.remediation, /claude auth status/);
      return true;
    },
  );
});

/**
 * AN ERROR-SUBTYPE RESULT THAT IS NOT AN OVERFLOW STILL THROWS. `error_max_turns`
 * has its own carefully written remediation naming `DASHBOARD_SEAT_MAX_TURNS`;
 * a classifier that matched too broadly would replace it with a truncation the
 * ladder would then "repair" by retrying at a higher budget, forever.
 */
test("an error result that is not an overflow keeps the failure branch it had", async () => {
  const { factory } = replaying([
    envelope({
      type: "result",
      subtype: "error_max_turns",
      stop_reason: null,
      is_error: true,
      errors: ["Reached maximum number of turns (8)"],
      usage: USAGE,
    }),
  ]);
  const caller = callerWith(factory);

  await assert.rejects(
    () => caller.call(request()),
    (error: unknown) => {
      assert.ok(error instanceof SeatCallError, `expected a SeatCallError, got ${String(error)}`);
      assert.match(error.message, /Reached maximum number of turns/);
      assert.match(error.remediation, /DASHBOARD_SEAT_MAX_TURNS/);
      return true;
    },
  );
});

/* -------------------------------------------------------------------------
 * 4. The declared ceiling reaches the subprocess
 * ---------------------------------------------------------------------- */

/**
 * DRIVEN FROM TWO DIFFERENT VALUES ON PURPOSE. A single-value assertion is
 * satisfied by a hardcoded constant in the caller, which is the same class of
 * defect as the ceiling that never travelled: the assertion would be green and
 * `plan-seat.ts`'s 16,000 and `judge.ts`'s 32,000 would both arrive as whatever
 * number happened to be written down here.
 */
test("each call's own maxOutputTokens reaches the subprocess environment", async () => {
  for (const budget of [4_096, 128_000]) {
    const { factory, dispatches } = replaying([
      assistantFrame("done"),
      envelope({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "done",
        usage: USAGE,
      }),
    ]);
    await callerWith(factory).call(request({ maxOutputTokens: budget }));

    const dispatch = dispatches[0];
    assert.ok(dispatch !== undefined, "the call must have been dispatched");
    assert.equal(
      dispatch.options.env?.[MAX_OUTPUT_TOKENS_ENV],
      String(budget),
      `${MAX_OUTPUT_TOKENS_ENV} is the ONLY lever that governs output length on this path — the SDK's ` +
        "Options carries no output-token field. Without it every seat runs at the CLI's 64,000 " +
        "default while declaring something else.",
    );
  }
});

/**
 * THE SUBTRACTION STILL WINS, AND THE VARIABLE SURVIVES IT.
 * `subscriptionSubprocessEnv` is a subtraction rather than an allowlist, so an
 * added name passes through — but it is applied at construction and this value
 * at call time, and a future edit that re-ran the subtraction afterwards would
 * silently delete the ceiling again. Asserted on the function directly so the
 * failure names the seam.
 */
test("seatCallEnv adds the ceiling without disturbing the environment it was given", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x" };

  const withCeiling = seatCallEnv(base, 16_000);
  assert.equal(withCeiling[MAX_OUTPUT_TOKENS_ENV], "16000");
  assert.equal(withCeiling["PATH"], "/usr/bin");
  assert.equal(withCeiling["HOME"], "/home/x");
  assert.equal(base[MAX_OUTPUT_TOKENS_ENV as keyof typeof base], undefined, "the input is not mutated");

  // A VALUE THE CLI WOULD PARSE AS NaN IS NOT WRITTEN AT ALL. Leaving the
  // variable unset falls back to the CLI's default, which is a known state; a
  // garbage value is a silently ignored one.
  assert.equal(seatCallEnv(base, 0)[MAX_OUTPUT_TOKENS_ENV], undefined);
  assert.equal(seatCallEnv(base, -1)[MAX_OUTPUT_TOKENS_ENV], undefined);
  assert.equal(seatCallEnv(base, 1.5)[MAX_OUTPUT_TOKENS_ENV], undefined);
});
