/**
 * subscription-caller.retry-after.test.ts — the reset instant on the leg that
 * threw it away.
 *
 * ─── THE LEG ───
 *
 * A refusal reaches this file two ways. The structured one is the SDK's
 * `rate_limit_info` frame, read by `rateLimitFrom`, carrying a real instant. The
 * other is a THROW: the CLI reports the refusal on a result frame with
 * `is_error`, the SDK's reader re-throws it as a plain `Error`, and by the time
 * `#asCallError` sees it there is nothing structured left — only the sentence.
 * That leg wrote `retryAfterSec: null` unconditionally until 2026-08-09, so a
 * refusal arriving this way could never arm a wait however clearly the sentence
 * said how long to wait: `recovery.ts` stopped on `no_retry_after` and the run
 * sat until a human pressed Resume.
 *
 * ─── WHY THE PATTERNS ARE NOT INVENTED, AND WHAT IS STILL UNMEASURED ───
 *
 * NO REFUSAL HAS EVER BEEN RECORDED ON THIS MACHINE. `rate_limited = 0` on all
 * four rows of `runs.db`; the `seven_day` horizons on those rows are routine
 * window telemetry, not refusal waits. So there is no observed sample to fit and
 * this file cannot claim one. The shapes below are the templates present in the
 * CLI the seat actually runs
 * (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, grepped
 * 2026-08-09): `Retry after {retry_after}s.`, `Retry-After: ${e.retryAfter}`,
 * the `retry_after` key an API error body carries, and `try again in a moment`,
 * which names no number at all.
 *
 * WHAT IS THEREFORE NOT PROVED HERE: that a real refusal from this provider uses
 * one of these shapes. What IS proved is that when a number is present it is
 * carried instead of discarded, that a sentence with no number still yields
 * `null`, and — the half that matters most — that the parser does not
 * hallucinate a number out of the numbers that are ALWAYS in these messages.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SPEC_SEAT } from "bakeoff/dist/config.js";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import type { RateLimitState } from "./claude-common.js";
import { DASHBOARD_BUDGET } from "./orchestrator.js";
import { SubscriptionSeatCaller, parseRetryAfterSeconds } from "./subscription-caller.js";
import type { SeatSessionFactory } from "./subscription-caller.js";

test("a header-style or JSON-style retry-after is read, in seconds", () => {
  assert.equal(parseRetryAfterSeconds("HTTP 429\r\nRetry-After: 60\r\n"), 60);
  assert.equal(parseRetryAfterSeconds('{"type":"error","retry_after":900}'), 900);
  assert.equal(parseRetryAfterSeconds("retry-after=45"), 45);
});

test("the CLI's own prose templates are read", () => {
  // `Retry after {retry_after}s.` and `try again in …`, both present in the
  // binary the seat runs.
  assert.equal(parseRetryAfterSeconds("Rate limited. Retry after 30s."), 30);
  assert.equal(parseRetryAfterSeconds("429: please try again in 90 seconds"), 90);
  assert.equal(parseRetryAfterSeconds("rate limit exceeded — try again in 5 minutes"), 300);
  assert.equal(parseRetryAfterSeconds("usage limit reached; try again in 2 hours"), 7200);
});

test("a fractional reading rounds UP, because a wait one second short re-enters the refusal", () => {
  assert.equal(parseRetryAfterSeconds("Retry-After: 0.5"), 1);
  assert.equal(parseRetryAfterSeconds("try again in 1.5 minutes"), 90);
});

test("THE NEGATIVE CONTROL: a refusal that names no wait yields null, not a number", () => {
  // This is the case the whole fallback in `recovery.ts` exists for, and a
  // parser that answered it with a number would silence that fallback and
  // present an invention as the provider's own word.
  assert.equal(parseRetryAfterSeconds("Rate limited. Please try again in a moment."), null);
  assert.equal(
    parseRetryAfterSeconds(
      "Claude Code returned an error result: API Error: 429 rate_limit_error: This request would exceed " +
        "your organization's rate limit.",
    ),
    null,
  );
  assert.equal(parseRetryAfterSeconds(""), null);
});

test("THE SECOND NEGATIVE CONTROL: the other numbers in a refusal are not mistaken for a wait", () => {
  // Every one of these messages is full of numbers — status codes, token
  // counts, timestamps, model ids. A loose `\d+` would pick one of them and
  // arm a timer off it, which is worse than parking: it looks like the
  // provider said something.
  assert.equal(parseRetryAfterSeconds("API Error: 429 rate_limit_error"), null);
  assert.equal(parseRetryAfterSeconds("exceeded 40000 input tokens per minute for claude-opus-5"), null);
  assert.equal(parseRetryAfterSeconds("rate limit resets 2026-08-09T14:17:37.958Z"), null);
  assert.equal(parseRetryAfterSeconds("Retry-After: 0"), null, "zero is not a wait; it is a refusal with none");
  assert.equal(parseRetryAfterSeconds("Retry-After: -30"), null);
});

/* -------------------------------------------------------------------------
 * THE WIRING — the parser is worth nothing if the throw path does not call it
 *
 * The tests above prove a pure function. `#asCallError` hardcoded
 * `retryAfterSec: null` at the ONE place that matters, so a parser sitting
 * beside it and never called would satisfy every assertion above. These two
 * drive the real `SubscriptionSeatCaller` through the observed failure shape —
 * the SDK re-throwing the CLI's prose after the subprocess exits — and read the
 * number back out of `onRateLimit`, which is the callback the orchestrator
 * actually installs.
 * ---------------------------------------------------------------------- */

const SEAT: AnthropicSeat = { ...SPEC_SEAT, modelId: "claude-opus-5[1m]", effort: "low" };

/** A factory that yields nothing and throws, which is the observed shape. */
function throwing(error: Error): SeatSessionFactory {
  return () =>
    (async function* replay(): AsyncGenerator<SDKMessage, void> {
      await Promise.resolve();
      throw error;
    })();
}

async function refuseWith(text: string): Promise<RateLimitState | null> {
  let seen: RateLimitState | null = null;
  const caller = new SubscriptionSeatCaller(SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    startQuery: throwing(new Error(text)),
    onRateLimit: (state) => {
      seen = state;
    },
  });
  await assert.rejects(
    caller.call({
      system: "author an acceptance suite",
      userTurns: ["TICKET: build a landing page"],
      maxOutputTokens: 64_000,
      jsonSchema: null,
      purpose: "suite-authoring t-refusal attempt 1",
    }),
  );
  return seen;
}

test("WIRING: a refusal that names a wait reaches onRateLimit carrying that wait", async () => {
  const state = await refuseWith(
    "Claude Code returned an error result: API Error: 429 rate_limit_error: rate limit exceeded. " +
      "Retry-After: 1800",
  );
  assert.notEqual(state, null, "the throw path must classify this as a refusal at all");
  assert.equal(state?.limited, true);
  assert.equal(
    state?.retryAfterSec,
    1800,
    "the reset instant the provider named was discarded — this is the leg that parked every unattended " +
      "run on `no_retry_after`",
  );
});

test("WIRING NEGATIVE CONTROL: a refusal that names no wait still reports null, not a guess", async () => {
  const state = await refuseWith(
    "Claude Code returned an error result: API Error: 429 rate_limit_error: rate limit exceeded. " +
      "Please try again in a moment.",
  );
  assert.equal(state?.limited, true, "still a refusal");
  assert.equal(state?.retryAfterSec, null, "nothing was reported, so nothing is reported — recovery.ts decides");
  assert.equal(state?.kind, null, "which window refused is not derivable from the sentence and is not guessed");
});
