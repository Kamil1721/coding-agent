/**
 * plan-seat-ceiling.test.ts — the plan seat's output ceiling, now that it is one.
 *
 * WHAT CHANGED UNDERNEATH THIS CONSTANT. `PLAN_SEAT_MAX_OUTPUT_TOKENS` was 4000
 * and was passed to `caller.call(...)` on both turns, and on the subscription
 * path it never reached the model: the Agent SDK's `Options` has no
 * output-token field, so every plan turn ever recorded ran under the CLI's
 * 64,000 default. As of 2026-08-04 `subscription-caller.ts` sends the declared
 * value as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, which turns the number from an
 * assertion made after the fact into a cut made before it.
 *
 * WHY THAT IS DANGEROUS RATHER THAN NEUTRAL. Seven plan turns are on record in
 * `dashboard/data/runs.db` and the largest spent 3763 output tokens — 94% of the
 * ceiling that was about to start being enforced. The parsed content cannot
 * account for that (six plan lines and at most three 140-character questions),
 * so it was adaptive thinking, which is billed as output and counts against the
 * budget and which nothing in this repository bounds.
 *
 * SO THIS FILE PINS TWO THINGS AND NEITHER OF THEM IS "THE CALL SUCCEEDED":
 *   1. the ceiling clears the largest turn ever observed by a real margin;
 *   2. BOTH turns declare it, from the constant rather than from a literal.
 *
 * NEGATIVE CONTROLS. Applied to `plan-seat.ts`, run, WATCHED RED, reverted
 * (2026-08-04):
 *
 *   mutation                                          test that went red
 *   `PLAN_SEAT_MAX_OUTPUT_TOKENS = 4000`              "clears the largest plan
 *     (the pre-2026-08-04 value)                        turn on record"
 *   `maxOutputTokens: PLAN_SEAT_MAX_OUTPUT_TOKENS`    "both turns declare the
 *     → `4000` on the follow-up turn only               ceiling"
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { SeatCallRequest, SeatCallResult } from "bakeoff/dist/anthropic-seat.js";

import {
  NO_PLAN_SEAT_IMAGES,
  PLAN_SEAT_MAX_OUTPUT_TOKENS,
  runPlanFollowUp,
  runPlanOpening,
} from "./plan-seat.js";
import type { PlanSeatCaller } from "./plan-seat.js";

/**
 * THE LARGEST PLAN TURN ON RECORD, READ OUT OF THE RUN DATABASE.
 *
 * `select payload from events where payload like '%plan seat — anthropic%'` over
 * `dashboard/data/runs.db` on 2026-08-04 returns seven rows: 273, 314, 324, 346,
 * 710, 1149 and 3763 output tokens. This is the maximum, and every one of those
 * turns was drawn with NO ceiling in force — which is what makes them an honest
 * picture of what this seat wants to spend rather than of what it was allowed to.
 */
const LARGEST_OBSERVED_PLAN_TURN_TOKENS = 3763;

/** A caller that records requests and answers with an empty, parseable proposal. */
function recording(): { caller: PlanSeatCaller; requests: SeatCallRequest[] } {
  const requests: SeatCallRequest[] = [];
  const caller: PlanSeatCaller = {
    async call(request: SeatCallRequest): Promise<SeatCallResult> {
      requests.push(request);
      return {
        text: '{"plan":["ship it"],"questions":[],"reply":"","resolved":[]}',
        stopReason: "end_turn",
        usage: { costUsd: 0 },
      } as unknown as SeatCallResult;
    },
  };
  return { caller, requests };
}

test("the plan ceiling clears the largest plan turn on record by a real margin", () => {
  assert.ok(
    PLAN_SEAT_MAX_OUTPUT_TOKENS >= 2 * LARGEST_OBSERVED_PLAN_TURN_TOKENS,
    `PLAN_SEAT_MAX_OUTPUT_TOKENS is ${String(PLAN_SEAT_MAX_OUTPUT_TOKENS)} and the largest plan turn ` +
      `ever recorded spent ${String(LARGEST_OBSERVED_PLAN_TURN_TOKENS)} output tokens. Since the ` +
      "caller began sending this value as CLAUDE_CODE_MAX_OUTPUT_TOKENS it CUTS the turn, and a " +
      "ceiling sitting within a factor of two of the largest thing ever measured is a coin flip, " +
      "not a boundary. The excess is adaptive thinking, which nothing here bounds.",
  );
});

test("both plan turns declare the ceiling, and both declare the same one", async () => {
  const { caller, requests } = recording();

  await runPlanOpening(caller, {
    brief: "Build a page that lists three projects.",
    images: NO_PLAN_SEAT_IMAGES,
    documentNotes: [],
    capturedUrl: null,
    cap: 3,
    firstOrdinal: 1,
  });
  await runPlanFollowUp(
    caller,
    {
      brief: "Build a page that lists three projects.",
      plan: ["ship it"],
      open: [],
      ownerText: "three is right",
      classified: {
        kind: "answer",
        targets: ["PQ-1"],
        attribution: "structural",
        why: "the client named PQ-1",
      },
      images: NO_PLAN_SEAT_IMAGES,
    },
    1,
  );

  assert.deepEqual(
    requests.map((request) => request.maxOutputTokens),
    [PLAN_SEAT_MAX_OUTPUT_TOKENS, PLAN_SEAT_MAX_OUTPUT_TOKENS],
    "a turn carrying a literal instead of the constant is a turn whose ceiling is not the one the " +
      "constant's docblock argues for — and the follow-up turn is the easy one to forget.",
  );
});
