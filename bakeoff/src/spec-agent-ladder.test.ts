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

/* -------------------------------------------------------------------------
 * 4. A LATER attempt gets the ladder too — and the flag that seemed to stop it
 * ---------------------------------------------------------------------- */

/**
 * THE POST-MORTEM'S CLAIM, AND WHY THE TEST BELOW IS NOT THE TEST IT ASKED FOR.
 *
 * `docs/RUN-a913c871-observations.md` files this as a limit of the fix: *"
 * `truncationRetried` is declared outside the attempt loop, so the free 128k
 * retry is once per RUN, not once per attempt. A suite that overflows on
 * attempts 2 and 3 gets no ladder at all."*
 *
 * THE SECOND SENTENCE IS FALSE, and the first is true but inert. Proof, from the
 * code rather than from a run: the flag is set immediately BEFORE the rung guard
 * `if (outputTokens < MAX_STREAMABLE_OUTPUT_TOKENS)`, and that branch assigns
 * `outputTokens = MAX_STREAMABLE_OUTPUT_TOKENS`. So `flag === true` implies
 * `outputTokens >= MAX` on both paths, and `outputTokens` never decreases.
 * Contrapositive: whenever the rung guard could pass, the flag is false. The
 * flag can never be the reason an escalation is skipped.
 *
 * THE MOVE IS STILL WORTH MAKING, AND THE REASON IS THE RECORD, NOT THE CALLS.
 * The flag is now written onto each `AuthoringAttempt`. Declared once per run it
 * is STICKY: after attempt 2 escalates, attempt 3 — never truncated, never
 * retried — reports `truncationRetried: true` too, and the failure message says
 * *"the free truncation retry fired on attempt(s) 2, 3"*. MEASURED, 2026-08-10:
 * restoring the outer declaration (the exact pre-fix code) leaves the four call
 * sequence tests above GREEN, exactly as the proof predicts, and turns the last
 * test in this file RED on that sentence. An observability channel that reports
 * an escalation which did not happen is worse than none: this run's whole
 * post-mortem turned on establishing that the ladder had NOT fired.
 *
 * WHAT THIS TEST DOES MEASURE, and it was uncovered until now: attempt 1 fails
 * WITHOUT truncating, attempt 2 truncates, and the ladder fires on attempt 2.
 * `end_turn` on an unparseable response is not a truncation, so attempt 1
 * consumes an attempt and leaves the rung where it was.
 */
test("an attempt that is NOT the first still gets the free retry", async () => {
  const { spec } = await runAuthoring(["end_turn", "max_tokens"]);

  assert.equal(
    spec.requests.length,
    DEFAULT_MAX_AUTHORING_ATTEMPTS + 1,
    "attempt 2's truncation must buy a free retry exactly as attempt 1's does",
  );
  assert.deepEqual(
    budgets(spec),
    [
      DEFAULT_MAX_OUTPUT_TOKENS, // attempt 1 — unparseable, not truncated
      DEFAULT_MAX_OUTPUT_TOKENS, // attempt 2 — truncated at the starting rung
      MAX_STREAMABLE_OUTPUT_TOKENS, // the free retry, still inside attempt 2
      MAX_STREAMABLE_OUTPUT_TOKENS, // attempt 3, on the raised rung
    ],
    "the rung must stay at the default until something is actually truncated, then climb once",
  );
});

/* -------------------------------------------------------------------------
 * 5. The rung is on the record, because nothing else records it
 * ---------------------------------------------------------------------- */

/**
 * WHAT THIS REPLACES: `ps eww -p <seat pid> | grep CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
 *
 * That was the only instrument that could see the ceiling during run
 * `a913c871`, it ran outside the product, and it covered two of the three seat
 * processes. The escalation emitted nothing. The failure message is a channel
 * with a proven reader — it lands verbatim in `runs.failure_reason`, and the
 * post-mortem quoted the whole of it — so the rung history goes there.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the negative one is the point. A run where
 * nothing was truncated must SAY that nothing was truncated: run `a913c871`
 * finished believing its 64k→128k repair might have run, and establishing that
 * it had not cost the post-mortem an argument from the shape of an unrelated
 * error message.
 */
test("the failure names the rung every attempt ran on, and says when the ladder did not fire", async () => {
  const quiet = await runAuthoring([]);

  assert.match(
    quiet.error.message,
    new RegExp(`Output-token ceiling by attempt: 1:${String(DEFAULT_MAX_OUTPUT_TOKENS)}`),
    "the failure does not say what budget the attempts ran on",
  );
  assert.match(
    quiet.error.message,
    /free truncation retry did NOT fire on any attempt/,
    "a run where the ladder never fired must say so, or a reader assumes it did and was fine",
  );

  const climbed = await runAuthoring(["end_turn", "max_tokens"]);
  assert.match(
    climbed.error.message,
    new RegExp(`2:${String(MAX_STREAMABLE_OUTPUT_TOKENS)}`),
    "the escalated attempt's raised rung is not on the record",
  );
  assert.match(
    climbed.error.message,
    /free truncation retry fired on attempt\(s\) 2, without consuming an attempt/,
    "the escalation is still invisible, which is the defect this replaces",
  );
  assert.doesNotMatch(
    climbed.error.message,
    /did NOT fire/,
    "a run whose ladder DID fire must not carry the sentence saying it did not",
  );
});
