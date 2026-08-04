/**
 * THE ROLLUP — five sections, one word, and the six branches that word has.
 *
 * WHY THIS IS A UNIT SPEC AND NOT SIX MORE BROWSER FIXTURES. The rollup is the
 * one computed claim on the collapsed Plan card: five states go in, one word comes
 * out, and that word is what a reader believes about the run. Proving it in a
 * browser means one seeded graph per combination, each one a page load. It is a
 * pure function in `layout.ts` for the reason that file's own head gives about
 * placement — "the part of the canvas that has a right answer, so it is a function
 * that can be called from a test rather than behaviour that only a browser can
 * observe" — and this file is that call, once per branch.
 *
 * THE ONE ARGUMENT EVERY TEST HERE IS REALLY ABOUT IS `runIsActive`.
 *
 * It is the parameter most likely to be deleted as unused, because five of the six
 * branches read fine without it. The sixth is the one the owner is looking at: his
 * run was CANCELLED with `plan:done capture:pending author:unresolved
 * audit:pending freeze:pending`. Hard-code the flag to `true` and the card says
 * `waiting` — a promise of future work about a run that will never continue, which
 * is exactly what `api-types.ts` warns `pending` reads as on a finished run, and
 * exactly the defect `spec-pipeline.ts`'s own terminal guard existed to prevent.
 * Two tests below fail on that single mutation and they say so in their names.
 *
 * THE FIXTURE IS THE OWNER'S ACTUAL RUN, not an invented shape:
 * `run-2026-08-04T11-08-10-487Z-162b186d`, folded state recorded in
 * `stage-node.tsx`'s header.
 */

import { expect, test } from "@playwright/test";

import type { GraphStage, GraphStageId, GraphStageState } from "../src/lib/api-types";
import {
  NOTHING_WAS_MENTIONED,
  rollupActivityOf,
  rollupAtOf,
  rollupDoneCount,
  rollupOf,
  type StageRollup,
} from "../src/components/canvas/layout";

const CHAIN: readonly GraphStageId[] = ["plan", "capture", "author", "audit", "freeze"];

/**
 * A lane, from five states and (optionally) five sentences.
 *
 * The labels and details are the SERVER'S, quoted rather than invented, so a test
 * asserting on a sentence is asserting on a string the run really writes.
 */
function lane(
  states: readonly GraphStageState[],
  details: Partial<Record<GraphStageId, string>> = {},
  ats: Partial<Record<GraphStageId, string | null>> = {},
): readonly GraphStage[] {
  return CHAIN.map((id, index) => ({
    id,
    label: id,
    detail: details[id] ?? `${id} sentence`,
    state: states[index] ?? "pending",
    at: ats[id] ?? null,
  }));
}

const AUTHOR_SENTENCE = "Writing the tests this build will be graded against.";
const PLAN_SENTENCE = "Reading your ticket and working out what it cannot guess.";

/** `plan:done capture:pending author:unresolved audit:pending freeze:pending`. */
const OWNERS_RUN = lane(["done", "pending", "unresolved", "pending", "pending"], {
  plan: "the plan dialogue is over: every question was settled",
  author: AUTHOR_SENTENCE,
});

test("the owner's own run reads `stopped`, not `waiting` and not `done`", () => {
  /*
   * RULE ORDER IS THE CLAIM. `unresolved` is checked before "nothing is pending",
   * so a lane carrying one stopped section can never report itself finished.
   *
   * MUTATION: move rule 3 (`if (!has("pending")) return "done"`) above rule 2.
   *
   * THE SECOND ASSERTION IS THE ONE THAT CATCHES IT, and the first one alone does
   * not — which was found by running the mutation rather than by reasoning about
   * it. The owner's run has a pending section, so with the rules reordered it
   * falls past `done` and still answers `stopped`; only a lane with NOTHING
   * pending and one section unresolved separates the two orderings. That lane is
   * a real run: everything settled except the seat nobody was watching.
   */
  expect(rollupOf(OWNERS_RUN, false)).toBe("stopped");
  expect(rollupOf(lane(["done", "skipped", "unresolved", "done", "done"]), false)).toBe(
    "stopped",
  );
});

test("`done` is unreachable while any section is still pending", () => {
  /*
   * MUTATION: change rule 3's condition from "no section is pending" to "at least
   * one is done". This four-of-five lane then reports `done`, which is the card
   * claiming the run finished work it has not mentioned.
   */
  expect(rollupOf(lane(["done", "done", "done", "done", "pending"]), true)).toBe("waiting");
  expect(rollupOf(lane(["done", "done", "skipped", "done", "done"]), true)).toBe("done");
});

test("a finished run never says `waiting` — the control for `runIsActive`", () => {
  /*
   * MUTATION: delete the `runIsActive` parameter and hard-code `true`. The first
   * assertion flips to `waiting`. THIS IS THE CONTROL FOR THE WHOLE TERMINAL
   * BRANCH and for the argument most likely to be dropped as unused.
   */
  const partly = lane(["done", "pending", "pending", "pending", "pending"]);
  expect(rollupOf(partly, false)).toBe("never-ran");
  expect(rollupOf(partly, true)).toBe("waiting");
});

test("a finished run never says `not started` either", () => {
  // Same mutation as above, from the other end of the table: with the flag gone,
  // the dead run reports `not-started`, which promises a beginning.
  const untouched = lane(["pending", "pending", "pending", "pending", "pending"]);
  expect(rollupOf(untouched, false)).toBe("never-ran");
  expect(rollupOf(untouched, true)).toBe("not-started");
});

test("a section still `running` on a dead run reads as stopped", () => {
  /*
   * MUTATION: drop the `(!runIsActive && has("running"))` clause from rule 2. This
   * falls through to `waiting`, so a run that died mid-seat would advertise that
   * the seat is about to continue.
   */
  expect(rollupOf(lane(["done", "running", "pending", "pending", "pending"]), false)).toBe(
    "stopped",
  );
  // And on a live run the same lane is genuinely working.
  expect(rollupOf(lane(["done", "running", "pending", "pending", "pending"]), true)).toBe(
    "working",
  );
});

test("no rollup token ever contains a space", () => {
  /*
   * `data-state` carries these and a selector cannot match a value with a space in
   * it the way a reader's word can. The visible chip renders `not started` and
   * `never ran`; the token stays hyphenated.
   *
   * MUTATION: return `"not started"` from rule 5.
   */
  const seen: StageRollup[] = [
    rollupOf(lane(["running", "pending", "pending", "pending", "pending"]), true),
    rollupOf(OWNERS_RUN, false),
    rollupOf(lane(["done", "done", "done", "skipped", "done"]), false),
    rollupOf(lane(["done", "pending", "pending", "pending", "pending"]), true),
    rollupOf(lane(["pending", "pending", "pending", "pending", "pending"]), true),
    rollupOf(lane(["pending", "pending", "pending", "pending", "pending"]), false),
  ];
  expect(seen).toEqual(["working", "stopped", "done", "waiting", "not-started", "never-ran"]);
  for (const token of seen) expect(token).toMatch(/^[a-z-]+$/);
});

test("the activity line is the FURTHEST thing the run said, not the first", () => {
  /*
   * MUTATION: read the FIRST non-pending section instead of the last. It returns
   * the plan sentence — a step that finished hours before the one the reader is
   * asking about — and the card stops answering "where did this get to".
   */
  expect(rollupActivityOf(OWNERS_RUN, false)).toBe(AUTHOR_SENTENCE);

  // A running section outranks a settled one further down the chain, because it
  // is the thing happening now.
  const working = lane(["done", "done", "running", "pending", "pending"], {
    author: AUTHOR_SENTENCE,
    capture: "captured https://kamilborzecki.dev",
  });
  expect(rollupActivityOf(working, true)).toBe(AUTHOR_SENTENCE);
});

test("the activity line does not promise a future on a dead run", () => {
  /*
   * MUTATION: delete step 3's `runIsActive` branch and always return the head
   * section's sentence. A cancelled run then reads "Reading your ticket and
   * working out what it cannot guess." on its card forever.
   */
  const untouched = lane(["pending", "pending", "pending", "pending", "pending"], {
    plan: PLAN_SENTENCE,
  });
  expect(rollupActivityOf(untouched, false)).toBe(NOTHING_WAS_MENTIONED);
  expect(rollupActivityOf(untouched, true)).toBe(PLAN_SENTENCE);
});

test("elapsed comes from the newest instant any section carried, or from none", () => {
  /*
   * A ROW THAT CARRIED NO INSTANT GETS NO TIME AT ALL — never the browser's clock,
   * which would date a run recorded last week to the moment the page opened.
   *
   * MUTATION: return `Date.now()` instead of null when nothing parses. The second
   * assertion goes red.
   */
  const timed = lane(["done", "skipped", "done", "pending", "pending"], undefined, {
    plan: "2026-08-04T09:10:00.000Z",
    capture: "2026-08-04T09:12:00.000Z",
    author: "2026-08-04T09:40:00.000Z",
  });
  expect(rollupAtOf(timed)).toBe(Date.parse("2026-08-04T09:40:00.000Z"));
  expect(rollupAtOf(lane(["pending", "pending", "pending", "pending", "pending"]))).toBeNull();
  // An unparseable instant is the same as none, not NaN carried into a clock.
  expect(rollupAtOf(lane(["done"], undefined, { plan: "not a date" }))).toBeNull();
});

test("the panel's counter counts done sections and nothing else", () => {
  /*
   * MUTATION: count `done` plus `skipped`. The owner's run then reads "2 of 5
   * done" while nothing has been skipped, and a lane with a skipped capture reads
   * as one section further along than the run ever got.
   */
  expect(rollupDoneCount(OWNERS_RUN)).toBe(1);
  expect(rollupDoneCount(lane(["done", "skipped", "done", "pending", "pending"]))).toBe(2);
  expect(rollupDoneCount(lane(["pending", "pending", "pending", "pending", "pending"]))).toBe(0);
});

test("a lane the fold shortened is still measured against its own length", () => {
  /*
   * NOT ALWAYS FIVE, AND THIS IS THE FIXTURE THAT SAYS SO. A reused acceptance
   * suite makes `foldLogStages` DROP `capture`, `author` and `audit` outright, so
   * the lane is `plan` and `freeze`. Every function here has to answer about the
   * array it was handed rather than about a table of five.
   *
   * MUTATION: index the chain positionally (`members[4]` for freeze). Every
   * assertion below reads a section that is not there.
   */
  const reused: readonly GraphStage[] = [
    { id: "plan", label: "plan", detail: "the plan dialogue is over", state: "done", at: null },
    {
      id: "freeze",
      label: "freeze",
      detail: "reusing the sealed suite from the ticket",
      state: "done",
      at: "2026-08-04T09:53:00.000Z",
    },
  ];
  expect(rollupOf(reused, false)).toBe("done");
  expect(rollupDoneCount(reused)).toBe(2);
  expect(rollupActivityOf(reused, false)).toBe("reusing the sealed suite from the ticket");
});

test("an empty lane claims nothing at all", () => {
  // `placeGraph` never draws a card for one, but a function that answers "done"
  // for zero sections is one refactor away from a card that says so.
  expect(rollupOf([], false)).toBe("never-ran");
  expect(rollupOf([], true)).toBe("not-started");
  expect(rollupActivityOf([], true)).toBe(NOTHING_WAS_MENTIONED);
  expect(rollupDoneCount([])).toBe(0);
  expect(rollupAtOf([])).toBeNull();
});
