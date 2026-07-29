/**
 * The double-count, end to end — the same defect `graph-dedup.unit.spec.ts`
 * pins on the reducer, checked here through the parts the reducer cannot see.
 *
 * WHY BOTH. The unit spec hands `graphReducer` a seq directly, so it proves the
 * WATERMARK ARITHMETIC and nothing else. Everything between the wire and that
 * argument is untested by it: that `bus.ts`'s `id:` line survives as
 * `MessageEvent.lastEventId`, that `seqOf` parses it rather than returning
 * `UNKNOWN_SEQ`, and that `useLiveRun` passes it to `ingest` instead of dropping
 * it. If any of those broke, every frame would take the fold-anyway branch and
 * the canvas would double the run while the unit spec stayed green. This spec is
 * the one that notices, and it notices the way a reader would: a tool pill that
 * says the wrong number.
 *
 * WHAT MAKES IT NON-VACUOUS. A correct client's canvas does not change while the
 * replay streams, so asserting on it too early passes against a page whose
 * socket never opened. The stream therefore ends with one row PAST the snapshot
 * watermark, and the spec waits for that row's card to be drawn before it reads
 * the pill. Ordered delivery makes the marker's arrival a proof that everything
 * before it was folded.
 */

import { expect, test } from "@playwright/test";

import { REPLAY_RUN_ID } from "./fixtures/config";

test("a stream that replays the snapshot's rows does not double the tool counts", async ({
  page,
}) => {
  await page.goto(`/runs/${REPLAY_RUN_ID}`);

  // The snapshot has landed and the canvas is drawn.
  await expect(page.getByTestId("rf__node-root")).toBeVisible();

  // The tail marker — the last frame of the replay. Until this card exists, the
  // stream is still in flight and nothing below would mean anything.
  await expect(page.getByTestId("rf__node-tail")).toBeVisible();

  // Now the count. `root` called `Read` twice on this run; the stream replayed
  // both of those rows, and both were already in the snapshot. Deleting the
  // watermark guard makes this title read `Read, called 4×`.
  const pill = page.getByTestId("rf__node-root").getByTitle(/^Read, called \d+×$/);
  await expect(pill).toHaveAttribute("title", "Read, called 2×");
});
