/**
 * The design park's countdown, against the sentence the server actually emits.
 *
 * WHY THIS FILE HAD TO EXIST BEFORE THE NUMBER COULD SHIP. `ApiDesignLock`
 * carries neither `parkedAt` nor the configured timeout, so the deadline is
 * PARSED out of the run's own log line — and a parse that is never measured is
 * a number the owner can plan around and be wrong about, which is the exact
 * trade `design-lock.tsx` refused in writing before this. Every browser fixture
 * in this suite answers `/events` with a 204, so the trace is empty there and
 * the countdown branch never renders: these are the only tests that read it.
 *
 * THE INPUT IS QUOTED FROM THE PRODUCER, not invented. `#parkForDesignLock`
 * (server/src/orchestrator.ts) builds one `info` line from three concatenated
 * fragments, and the whole of it is below, byte for byte, with the run id and
 * the minute count it interpolates.
 */

import { expect, test } from "@playwright/test";

import { designCountdown, designParkClock } from "../src/lib/design-directions";
import type { TraceEntry } from "../src/lib/use-run-stream";

const RUN = "run-2026-08-03T09-00-00-000Z-abcdef01";

/** `#parkForDesignLock`'s `#emitLog`, verbatim, with `timeoutMin` interpolated. */
function parkLine(timeoutMin: number): string {
  return (
    `the DESIGN lane produced its mockups and the run is waiting for one to be chosen. ` +
    `POST /api/runs/${RUN}/resume {"chosenMockup":"<path>"} locks it; with no choice inside ` +
    `${String(timeoutMin)} minutes, ui-designer picks and the choice is recorded as automatic.`
  );
}

function row(atMs: number, text: string): TraceEntry {
  return { seq: 1, atMs, kind: "log", level: "info", text, name: null, result: null };
}

const PARKED_AT = Date.parse("2026-08-03T09:04:00.000Z");

test("the real park line yields the deadline it names", () => {
  const clock = designParkClock([row(PARKED_AT, parkLine(30))]);

  expect(clock.windowMin).toBe(30);
  expect(clock.deadlineMs).toBe(PARKED_AT + 30 * 60_000);

  // AND THE WINDOW IS IN THE LINE'S SECOND SENTENCE, which is why the two
  // matches are separate expressions rather than one anchored pattern: the
  // marker is before the full stop and the minute count is after it.
  expect(parkLine(30).indexOf("inside 30 minutes")).toBeGreaterThan(
    parkLine(30).indexOf("to be chosen"),
  );
});

test("a reworded line yields NO number rather than a default nobody configured", () => {
  // `DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN` is settable, so a hardcoded fallback
  // here would be a countdown that is silently wrong on any machine that set it.
  // Both matches are required; either one missing means no clock.
  const noMinutes = designParkClock([
    row(PARKED_AT, "the DESIGN lane produced its mockups and the run is waiting for one to be chosen."),
  ]);
  expect(noMinutes).toEqual({ deadlineMs: null, windowMin: null });

  const noMarker = designParkClock([
    row(PARKED_AT, "the plan window closes with no answer inside 20 minutes"),
  ]);
  expect(noMarker).toEqual({ deadlineMs: null, windowMin: null });

  expect(designParkClock([])).toEqual({ deadlineMs: null, windowMin: null });
});

test("THE FIRST PARK LINE WINS, because a re-park carries the original instant", () => {
  /*
   * `#parkForDesignLock(runId, paths, park.parkedAt)` re-arms for the REMAINDER
   * of the original window across a restart, and the panel says on screen that
   * the countdown does not reset on reload. Taking the newest line would walk
   * the deadline forward on every re-park and make that sentence false.
   */
  const later = PARKED_AT + 9 * 60_000;
  const clock = designParkClock([row(PARKED_AT, parkLine(30)), row(later, parkLine(30))]);

  expect(clock.deadlineMs).toBe(PARKED_AT + 30 * 60_000);
});

test("a line the trace cap has not dropped is still read at any depth", () => {
  // The park line is one row among thousands on a long run; nothing about its
  // position may matter, up to the point where the cap drops it — which this
  // parse cannot detect and the module's docblock says so rather than implying
  // the clock is exact.
  const noise = Array.from({ length: 40 }, (_unused, index) =>
    row(PARKED_AT - (40 - index) * 1_000, `builder step ${String(index)}`),
  );
  const clock = designParkClock([...noise, row(PARKED_AT, parkLine(45))]);

  expect(clock.windowMin).toBe(45);
});

test("the countdown floors to whole minutes and names the closed window", () => {
  const deadline = PARKED_AT + 30 * 60_000;

  expect(designCountdown(deadline, PARKED_AT)).toEqual({ kind: "left", minutes: 30 });
  expect(designCountdown(deadline, deadline - 90_000)).toEqual({ kind: "left", minutes: 1 });
  // UNDER A MINUTE IS 0 AND NOT "closing" — the window is open until it is not.
  expect(designCountdown(deadline, deadline - 30_000)).toEqual({ kind: "left", minutes: 0 });
  // A LAPSED WINDOW IS NOT A NEGATIVE NUMBER. The timer fires, the server
  // chooses, and the row can still read `awaiting_input` for a beat.
  expect(designCountdown(deadline, deadline + 1_000)).toEqual({ kind: "closing", minutes: 0 });
  expect(designCountdown(null, PARKED_AT)).toBe(null);
});
