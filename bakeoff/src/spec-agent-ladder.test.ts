/**
 * spec-agent-ladder.test.ts — the truncation ladder, watched executing.
 *
 * WHY THIS FILE EXISTS. `generateAuditedSuite` has carried a self-repair
 * mechanism since it was written: detect a response cut off at `max_tokens`,
 * raise the output budget, retry ONCE without consuming an authoring attempt.
 * On 2026-08-04 it was established that the mechanism had never executed, for
 * two reasons that compound:
 *
 *   1. `DEFAULT_MAX_OUTPUT_TOKENS` was DEFINED AS `MAX_STREAMABLE_OUTPUT_TOKENS`,
 *      so the ladder's own guard — `if (outputTokens < MAX_STREAMABLE...)` — was
 *      false on the first attempt and every attempt after it. The rung it climbs
 *      to was the rung it starts on.
 *   2. On the subscription path the truncation never arrived as a RESULT at all.
 *      It arrived as a thrown error, so `wasTruncated()` — which reads a
 *      returned `SeatCallResult` — was never called. That half is fixed in
 *      `dashboard/server/src/subscription-caller.ts` and watched by its own
 *      tests; this file is about the bakeoff half.
 *
 * WHAT MAKES THESE TESTS DIFFERENT FROM A TEST THAT WATCHES A SUCCESS. Nothing
 * here asserts that authoring worked. Every stubbed call fails to parse, so the
 * run always ends in `suite_not_audited` — and the assertions are entirely about
 * the SHAPE OF THE CALL SEQUENCE that led there: how many calls were dispatched,
 * and what budget each one asked for. A ladder that silently stopped climbing
 * would leave the same green "the suite could not be authored" outcome and a
 * different call sequence, which is exactly what is measured.
 *
 * NEGATIVE CONTROLS. Each mutation was applied to production code, run, WATCHED
 * RED, and reverted (2026-08-04):
 *
 *   mutation                                             test that went red
 *   `wasTruncated` → `return false`                      "an over-length first
 *     (spec-agent.ts)                                     attempt is retried"
 *                                                        + "the retry asks for
 *                                                          more than the first"
 *                                                        + "the ladder stops at
 *                                                          the ceiling"
 *   `outputTokens = MAX_STREAMABLE_OUTPUT_TOKENS`        "the retry asks for
 *     → `outputTokens = outputTokens` (spec-agent.ts)     more than the first"
 *   `DEFAULT_MAX_OUTPUT_TOKENS = MAX_STREAMABLE_...`     "the starting budget is
 *     (spec-types.ts — the pre-2026-08-04 definition)     below the ceiling"
 *                                                        + "an over-length first
 *                                                          attempt is retried"
 *
 * NO MODEL IS CALLED. The seat is a subclass of `AnthropicSeatCaller` whose
 * `call()` is overridden to record its request and replay a scripted stop
 * reason. The base constructor still runs — it resolves a credential BY NAME —
 * so the environment carries a sentinel that is not a key and cannot be one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicSeatCaller } from "./anthropic-seat.js";
import type { SeatCallRequest, SeatCallResult } from "./anthropic-seat.js";
import { JUDGE_SEAT, SPEC_SEAT } from "./config.js";
import { BakeoffError } from "./contracts.js";
import type { AnthropicSeat, Ticket } from "./contracts.js";
import { ticketDigest } from "./hash.js";
import { generateAuditedSuite } from "./spec-agent.js";
import {
  AUTHORING_BUDGET,
  CLI_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_AUTHORING_ATTEMPTS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_STREAMABLE_OUTPUT_TOKENS,
} from "./spec-types.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

/**
 * Not a credential and not shaped like one. The base caller resolves the seat's
 * key by name at construction and refuses to build without it; nothing in this
 * file reaches a network, and the value must not match `PLACEHOLDER_RE` in
 * `env.ts` or the constructor rejects it as an unfilled `.env.example`.
 */
const SENTINEL = ["BAKEOFF", "TEST", "NO", "API", "KEY"].join("-");

const BRIEF = "Build a page that lists three projects, each with a title and a one-line summary.";

const TICKET: Ticket = Object.freeze({
  id: "t-ladder",
  brief: BRIEF,
  sha256: ticketDigest(BRIEF),
  tier: "trivial",
  title: "ladder fixture",
});

/**
 * A `SeatCallResult` with only the fields the ladder reads populated.
 *
 * CAST DELIBERATELY AND NARROWLY. The real shape carries a full `VendorUsage`
 * row and a `PricingBasis` with per-field provenance, none of which any code
 * path under test touches: `generateSuite` reads `stopReason` and `text`, and
 * `generateAuditedSuite` reads `usage.costUsd` for the attempt ledger. Writing
 * the other forty fields out would make this fixture a test of `contracts.ts`
 * rather than of the ladder, and would go stale the first time a pricing field
 * is added.
 */
function stubResult(stopReason: string, text = ""): SeatCallResult {
  return {
    text,
    stopReason,
    usage: { costUsd: 0 },
  } as unknown as SeatCallResult;
}

/**
 * A seat that records every request and replays a scripted stop reason.
 *
 * The script is consumed positionally; once it runs out every further call
 * answers `end_turn`, so a test that expects N calls fails LOUDLY on N+1 rather
 * than hanging or throwing something unrelated.
 */
class RecordingCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];
  readonly #script: readonly string[];

  constructor(seat: AnthropicSeat, script: readonly string[]) {
    super(seat, { budget: AUTHORING_BUDGET, env: { [seat.envKeyName]: SENTINEL } });
    this.#script = script;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    return stubResult(this.#script[this.requests.length - 1] ?? "end_turn");
  }
}

/** Budgets asked for, in dispatch order. The whole subject of this file. */
function budgets(caller: RecordingCaller): readonly number[] {
  return caller.requests.map((request) => request.maxOutputTokens);
}

async function runAuthoring(script: readonly string[]): Promise<{
  spec: RecordingCaller;
  judge: RecordingCaller;
  error: BakeoffError;
}> {
  const spec = new RecordingCaller(SPEC_SEAT, script);
  const judge = new RecordingCaller(JUDGE_SEAT, []);
  try {
    await generateAuditedSuite(TICKET, { specCaller: spec, judgeCaller: judge });
  } catch (error) {
    assert.ok(error instanceof BakeoffError, `expected a BakeoffError, got ${String(error)}`);
    return { spec, judge, error };
  }
  throw new Error("authoring was expected to fail: every stubbed response is unparseable");
}

/* -------------------------------------------------------------------------
 * 1. The rung has to exist before anything can climb it
 * ---------------------------------------------------------------------- */

/**
 * THE STRUCTURAL PRECONDITION, ASSERTED SEPARATELY FROM THE BEHAVIOUR.
 *
 * The ladder's guard is a strict `<`. If the default is ever set back to the
 * ceiling — which is what it was until 2026-08-04, with a carefully argued
 * docblock explaining why — every behavioural test below goes red too, but they
 * go red saying "expected 4 calls, got 3", which points at the retry rather than
 * at the constant. This one names the actual cause.
 */
test("the starting budget is strictly below the ceiling, or the ladder has nowhere to climb", () => {
  assert.ok(
    DEFAULT_MAX_OUTPUT_TOKENS < MAX_STREAMABLE_OUTPUT_TOKENS,
    `DEFAULT_MAX_OUTPUT_TOKENS (${String(DEFAULT_MAX_OUTPUT_TOKENS)}) must be strictly below ` +
      `MAX_STREAMABLE_OUTPUT_TOKENS (${String(MAX_STREAMABLE_OUTPUT_TOKENS)}). Equal means the ` +
      "truncation retry in generateAuditedSuite can never fire — its guard is `outputTokens < " +
      "MAX_STREAMABLE_OUTPUT_TOKENS` — and a truncation kills the run instead of being repaired.",
  );
  // AND THE START IS THE NUMBER THAT ACTUALLY GOVERNED, not a number someone
  // liked: the CLI's own default is what ran while the harness believed 128,000.
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, CLI_DEFAULT_MAX_OUTPUT_TOKENS);
});

/* -------------------------------------------------------------------------
 * 2. The retry happens, and it is free
 * ---------------------------------------------------------------------- */

/**
 * FOUR CALLS, NOT THREE. `DEFAULT_MAX_AUTHORING_ATTEMPTS` is 3 and every stubbed
 * response is unparseable, so three calls is what an unrepaired run makes. The
 * fourth is the retry — and the fact that the total is attempts+1 rather than
 * attempts is the assertion that the retry did NOT consume an attempt, which is
 * the property the ladder's comment claims and the reason it exists.
 */
test("an over-length first attempt is retried, and the retry does not consume an attempt", async () => {
  const { spec, error } = await runAuthoring(["max_tokens"]);

  assert.equal(
    spec.requests.length,
    DEFAULT_MAX_AUTHORING_ATTEMPTS + 1,
    `expected ${String(DEFAULT_MAX_AUTHORING_ATTEMPTS)} authoring attempts plus one free truncation ` +
      `retry; got ${String(spec.requests.length)} call(s). Fewer means the ladder did not fire.`,
  );
  assert.equal(error.code, "suite_not_audited");
});

/**
 * THE RETRY ASKS FOR MORE. This is the assertion a "did it retry?" test cannot
 * make and the one that matters: a retry at the same budget reproduces the same
 * truncation and is worse than not retrying, because it spends a whole second
 * call to learn nothing.
 */
test("the retry asks for a strictly higher budget than the attempt it replaces", async () => {
  const { spec } = await runAuthoring(["max_tokens"]);
  const asked = budgets(spec);

  assert.equal(asked[0], DEFAULT_MAX_OUTPUT_TOKENS, "the first attempt starts at the declared default");
  assert.ok(
    (asked[1] ?? 0) > (asked[0] ?? 0),
    `the retry must raise the budget: attempt 1 asked for ${String(asked[0])} and the retry asked ` +
      `for ${String(asked[1])}. Equal means the escalation assigned the value it started with.`,
  );
  assert.equal(asked[1], MAX_STREAMABLE_OUTPUT_TOKENS, "the retry climbs to the streamable ceiling");

  // AND IT STAYS UP. The raised budget is carried into the remaining attempts —
  // a ladder that dropped back to the default would truncate attempt 2 exactly
  // as it truncated attempt 1, with the retry already spent.
  assert.deepEqual(asked.slice(1), [
    MAX_STREAMABLE_OUTPUT_TOKENS,
    MAX_STREAMABLE_OUTPUT_TOKENS,
    MAX_STREAMABLE_OUTPUT_TOKENS,
  ]);
});

/* -------------------------------------------------------------------------
 * 3. The top of the ladder is still an honest failure
 * ---------------------------------------------------------------------- */

/**
 * A SUITE THAT DOES NOT FIT AT THE CEILING IS A HARNESS LIMIT AND MUST SAY SO.
 * Two calls, not four: once the budget is at the streamable ceiling there is
 * nothing higher to retry at, so the run stops rather than spending its
 * remaining attempts reproducing a defect no regeneration addresses.
 */
test("the ladder stops at the ceiling and fails with the limit named, not with a parse error", async () => {
  const { spec, error } = await runAuthoring(["max_tokens", "max_tokens"]);

  assert.equal(spec.requests.length, 2, "there is nothing above the streamable ceiling to retry at");
  assert.deepEqual(budgets(spec), [DEFAULT_MAX_OUTPUT_TOKENS, MAX_STREAMABLE_OUTPUT_TOKENS]);
  assert.equal(error.code, "invalid_usage_shape");
  assert.match(error.message, new RegExp(String(MAX_STREAMABLE_OUTPUT_TOKENS)));
});
