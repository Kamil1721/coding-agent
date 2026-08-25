/**
 * awaiting-input.unit.spec.ts — which of three parks the generic "Waiting on
 * input" notice is describing, read off the wire.
 *
 * WHY THIS FILE EXISTS — 2026-08-25, run `run-2026-08-25T10-30-39-122Z-d728ab79`.
 * That run parked `awaiting_input` after one creative-author call whose output
 * the compiler rejected; `#creativeContractPhase` wrote `failureReason:
 * "creative contract invalid: creative author output did not compile"` and
 * asked nothing, the plan dialogue being already settled (`plan.awaiting=false`,
 * `closed.reason="answered"`). The notice still read "Type your answer in the
 * Chat panel, then press Resume", the owner typed "what is your question?" into
 * Chat, and the message stayed "queued — not read yet" because a parked run has
 * no live session. `awaitingInputKind` (`lib/awaiting-input.ts`) is the
 * function that now decides which body the notice renders; this is its proof.
 *
 * EVERY CASE IS WRITTEN IN BOTH DIRECTIONS: the input that must produce the
 * kind, and a neighbouring input — one field away — that must not. A kind
 * function that returned one string for everything passes every positive below
 * and fails every negative; a test that can only observe success is the defect
 * class this repository keeps finding in itself.
 *
 * THE FIXTURES ARE THE SHARED ONES (`fixtures/run-fixture.ts`), not shapes
 * invented here: `STALE_PLAN_DETAIL` is the observed run's tuple with the
 * producer's `failureReason` bytes, `PLAN_DETAIL` is the legacy plan park (no
 * `plan` key), `RUN_DETAIL` is the healthy build run the prose guard patches to
 * `awaiting_input` — which is also `reconcileOnBoot`'s shape on the wire.
 *
 * ─── MUTATIONS RUN, WATCHED FAIL, AND RESTORED — 2026-08-25 ───
 *
 * M1  `lib/awaiting-input.ts` — the first two predicates swapped, so a recorded
 *     cause beats an open question. "a legacy plan park is a question, and an
 *     open question beats a stale reason" goes red: `PLAN_DETAIL` carrying
 *     `DESIGN LANE FAILED (too-few-images)` reads `"check"`; "the durable plan
 *     projection decides" goes red on its positive half for the same reason.
 *     2 failed, 3 passed. Restored.
 * M2  `lib/awaiting-input.ts` — the `failureReason` read dropped (`"check"`
 *     unreachable). "the observed run is a check park" goes red on its
 *     positive half, "a reasonless build park is unexplained" on its second
 *     half, "the durable plan projection decides" on the unreadable case, and
 *     the totality case on a two-member set. 4 failed, 1 passed. Restored.
 * M3  `lib/awaiting-input.ts` — `"question"` returned unconditionally, which is
 *     what the notice did before 2026-08-25. Every test in the file goes red —
 *     the plan-park test on its `phase: "build"` negative control. 5 failed.
 *     Restored.
 * M4  `lib/awaiting-input.ts` — `plan.awaiting === true` read directly instead
 *     of `planParkedFrom`. "a legacy plan park is a question" goes red:
 *     `PLAN_DETAIL` has no `plan` key, and the crash-window park in
 *     `plan-dialogue.browser.spec.ts` would be told there is nothing to type.
 *     "the durable plan projection decides" goes red on `foldedOpen` (the
 *     reader rejects `awaiting && folded`; a raw field read does not), and the
 *     totality case on a set with no `"question"` in it. 3 failed, 2 passed.
 *     Restored.
 */

import { expect, test } from "@playwright/test";

import type { RunDetail } from "@/lib/api-types";
import { awaitingInputKind } from "@/lib/awaiting-input";

import { PLAN_DETAIL, RUN_DETAIL, STALE_PLAN_DETAIL } from "./fixtures/run-fixture";

test("the observed run is a check park, and only because a cause was recorded", () => {
  // The tuple `run-2026-08-25T10-30-39-122Z-d728ab79` served: plan settled,
  // no design lock, the producer's reason on the row.
  expect(STALE_PLAN_DETAIL.status).toBe("awaiting_input");
  expect(STALE_PLAN_DETAIL.failureReason).toBe(
    "creative contract invalid: creative author output did not compile",
  );
  expect(awaitingInputKind(STALE_PLAN_DETAIL)).toBe("check");

  // NEGATIVE CONTROL: the reason is the discriminator. Same run, reason
  // cleared — nothing was asked and nothing was recorded.
  const reasonless: RunDetail = { ...STALE_PLAN_DETAIL, failureReason: null };
  expect(awaitingInputKind(reasonless)).toBe("unexplained");
  expect(awaitingInputKind(reasonless)).not.toBe("check");
});

test("a legacy plan park is a question, and an open question beats a stale reason", () => {
  // `PLAN_DETAIL` has NO `plan` key: `planParkedFrom` reads the legacy
  // `phase: plan` + `awaiting_input` tuple, which is also the crash-window park
  // `plan-dialogue.browser.spec.ts` routes `/messages` to `[]` for.
  expect("plan" in PLAN_DETAIL).toBe(false);
  expect(awaitingInputKind(PLAN_DETAIL)).toBe("question");

  // ORDER CONTROL. A plan park can inherit a design-lane reason and stay live
  // (`lib/api-types.ts`, the `failureReason` docblock). It must still read
  // "answer, then Resume" — the reason is stale, the question is not.
  const staleReason: RunDetail = {
    ...PLAN_DETAIL,
    failureReason: "DESIGN LANE FAILED (too-few-images)",
  };
  expect(awaitingInputKind(staleReason)).toBe("question");
  expect(awaitingInputKind(staleReason)).not.toBe("check");

  // NEGATIVE CONTROL for the legacy read: one phase over, the same row is not
  // a plan park at all.
  const builtPast: RunDetail = { ...PLAN_DETAIL, phase: "build" };
  expect(awaitingInputKind(builtPast)).not.toBe("question");
  expect(awaitingInputKind(builtPast)).toBe("unexplained");
});

test("a reasonless build park is unexplained, and a reason makes it a check", () => {
  // The prose guard's "stopped, waiting on the owner" patch, and the shape
  // `reconcileOnBoot` leaves on the wire: `awaiting_input`, phase `build`, no
  // `plan`, no reason. `recoveryClass` is not served, so there is nothing to
  // read but the absence.
  const crashed: RunDetail = { ...RUN_DETAIL, status: "awaiting_input" };
  expect(RUN_DETAIL.failureReason).toBeNull();
  expect(awaitingInputKind(crashed)).toBe("unexplained");
  expect(awaitingInputKind(crashed)).not.toBe("question");

  // The other direction: the same park with a cause on the row.
  const recorded: RunDetail = {
    ...crashed,
    failureReason: "[MOTION_FALLBACK_INVALID] /motion/1/trigger\nfix: re-author",
  };
  expect(awaitingInputKind(recorded)).toBe("check");
  expect(awaitingInputKind(recorded)).not.toBe("unexplained");
});

test("the durable plan projection decides, not the phase, when the projection is present", () => {
  /*
   * A PROJECTION THE READER ACCEPTS, NOT THE MINIMAL SHAPE. `readDurablePlan`
   * (`lib/plan-dialogue.ts`) reads an `awaiting: true` projection as `invalid`
   * unless it is unfolded, unclosed, has at least one `open` question AND a
   * `deadlineAt` that round-trips through `toISOString` byte for byte. The
   * first draft of this case used `deadlineAt: null, questions: []` and went
   * red on 2026-08-25 — as `invalid`, which falls through to the reason and
   * reads `"check"`. That is the reader's rule, not this function's, and it is
   * the right rule: a half-projection is unsafe to offer an answer control on.
   */
  const open: RunDetail = {
    ...PLAN_DETAIL,
    plan: {
      awaiting: true,
      folded: false,
      deadlineAt: "2026-08-25T10:50:39.122Z",
      closed: null,
      questions: [{ id: "PQ-1", status: "open", recorded: null }],
    },
    failureReason: "x",
  };
  expect(awaitingInputKind(open)).toBe("question");
  expect(awaitingInputKind(open)).not.toBe("check");

  // NEGATIVE CONTROLS, one field each. Unreadable: `planIsParked` returns
  // false for an invalid projection, so the reason is what is left to read.
  const unreadable: RunDetail = {
    ...open,
    plan: { kind: "unreadable", detail: "plan.json is not an object" },
  };
  expect(awaitingInputKind(unreadable)).not.toBe("question");
  expect(awaitingInputKind(unreadable)).toBe("check");

  // Folded while still `awaiting`: the reader rejects the contradiction as
  // `invalid`, so it is not a question by that route either.
  const foldedOpen: RunDetail = {
    ...open,
    plan: {
      awaiting: true,
      folded: true,
      deadlineAt: "2026-08-25T10:50:39.122Z",
      closed: null,
      questions: [{ id: "PQ-1", status: "open", recorded: null }],
    },
  };
  expect(awaitingInputKind(foldedOpen)).not.toBe("question");
  expect(awaitingInputKind(foldedOpen)).toBe("check");

  // Settled and folded, a projection the reader ACCEPTS: the same `phase: plan`
  // tuple is not an open question any more — the STALE run's whole point
  // (`fixtures/config.ts`, `STALE_PLAN_RUN_ID`).
  const settled: RunDetail = {
    ...open,
    plan: {
      awaiting: false,
      folded: true,
      deadlineAt: null,
      closed: { reason: "answered", detail: "PQ-1 was answered" },
      questions: [{ id: "PQ-1", status: "answered", recorded: "six" }],
    },
  };
  expect(awaitingInputKind(settled)).not.toBe("question");
  expect(awaitingInputKind(settled)).toBe("check");
});

test("the three kinds are the only three, over every fixture park", () => {
  // Totality over the states that reach the generic notice. Not a substitute
  // for the directional cases above: a function that maps the right three
  // kinds onto the WRONG inputs passes this — M1, the swapped predicates, did
  // (3 passed, this among them). A function returning one string does NOT
  // pass it: M3 went red here on a one-member set and M2 on a two-member one.
  // An earlier version of this comment said the opposite; corrected
  // 2026-08-25 after the ledger above was re-run and read.
  const kinds = new Set(
    [
      STALE_PLAN_DETAIL,
      PLAN_DETAIL,
      { ...RUN_DETAIL, status: "awaiting_input" } as RunDetail,
      { ...RUN_DETAIL, status: "awaiting_input", failureReason: "y" } as RunDetail,
    ].map(awaitingInputKind),
  );
  expect([...kinds].sort()).toEqual(["check", "question", "unexplained"]);
});
