/**
 * chat-reply.unit.spec.ts — what the record line under an owner message says,
 * and what the row that stands where a reply would be says, for each of the
 * three run states the chat panel is now told about.
 *
 * WHY THIS FILE EXISTS — 2026-08-25, run `run-2026-08-25T10-30-39-122Z-d728ab79`.
 * That run parked `awaiting_input` after ONE creative-author call whose output
 * the compiler rejected (`MOTION_FALLBACK_INVALID` at `/motion/1/trigger`); its
 * plan dialogue was already settled (`plan.awaiting=false`,
 * `closed.reason="answered"`), so nothing had asked a question. The dashboard
 * still showed the plan-question script "Type your answer in the Chat panel,
 * then press Resume"; the owner typed "what is your question?" into Chat and
 * it stayed "queued — not read yet", because a parked run has no live session
 * and nothing was stepping. The panel had one flag, `runIsOver`, and could not
 * tell a park from a running stretch of work. `deliveryStamp` and `replyGap`
 * (`components/canvas/orchestrator-chat.tsx`) now take a `RunLifecycle` with a
 * second flag, `runParked`; this file is their proof. `replyGap`'s docblock
 * reserved this file's name on 2026-07-31 and called the rule "currently
 * unwatched" — it is watched now, in case 7.
 *
 * EVERY CASE IS WRITTEN IN BOTH DIRECTIONS: the input that must produce the
 * label or kind, and a neighbouring input — one flag or one field away — that
 * must not. A stamp function that returned one string for everything, or a gap
 * function that returned one kind, passes every positive below and fails every
 * negative; a test that can only observe success is the defect class this
 * repository keeps finding in itself.
 *
 * THE MESSAGE IS THE OWNER'S OWN, byte for byte, with `deliveredAt: null` —
 * the row as `GET /messages` served it while the run sat parked, built by
 * `ownerMessage` (`fixtures/run-fixture.ts`), the same row
 * `chat-parked.browser.spec.ts` routes onto its pages.
 *
 * NO BROWSER: both functions are pure over a message list and two booleans.
 * `orchestrator-chat.tsx` is a `"use client"` module that imports `next/link`;
 * Playwright's loader transpiles it the same way `ticket-title.unit.spec.ts`
 * loads `run-hud.tsx`, and nothing here renders a tree.
 *
 * ─── MUTATIONS RUN, WATCHED FAIL, AND RESTORED — 2026-08-25 ───
 *
 * M1  `orchestrator-chat.tsx` — `deliveryStamp`'s `runIsOver` and `runParked`
 *     rungs swapped, and `replyGap`'s two returns with them, so the park beats
 *     the ending. Case 5 ("both flags true") goes red on both functions and
 *     nothing else moves: 1 failed, 7 passed. Restored.
 * M2  `orchestrator-chat.tsx` — the `runParked` rung deleted from
 *     `deliveryStamp` (a parked run falls through to "queued — not read yet").
 *     Case 1 goes red on its positive half, case 2 on its NEGATIVE half (the
 *     parked label is now the queued one), case 4 on its control, case 5 on
 *     its control, and the distinctness case on a two-member set: 5 failed,
 *     3 passed. Restored, byte-identical by hash.
 * Run with: `npx playwright test -c tests/no-server.config.ts tests/chat-reply.unit.spec.ts`
 */

import { expect, test } from "@playwright/test";

import {
  deliveryStamp,
  replyGap,
  type RunLifecycle,
} from "../src/components/canvas/orchestrator-chat";
import type { ChatMessage } from "../src/lib/api-types";
import { formatTimeOnly } from "../src/lib/format";
import { ownerMessage } from "./fixtures/run-fixture";

/* ------------------------------------------------------------------ */
/* the three run states, and the fourth that is a caller bug          */
/* ------------------------------------------------------------------ */

const PARKED: RunLifecycle = { runIsOver: false, runParked: true };
const RUNNING: RunLifecycle = { runIsOver: false, runParked: false };
const OVER: RunLifecycle = { runIsOver: true, runParked: false };
/** `RunStatus` is one field; terminal and `awaiting_input` cannot both hold. */
const BOTH: RunLifecycle = { runIsOver: true, runParked: true };

/* ------------------------------------------------------------------ */
/* the labels, verbatim — a paraphrase here would be a second copy    */
/* ------------------------------------------------------------------ */

const HELD = "queued — held until Resume; nothing is running to read it";
const QUEUED = "queued — not read yet";
const NEVER = "never read — the run ended first";

/* ------------------------------------------------------------------ */
/* the rows                                                           */
/* ------------------------------------------------------------------ */

/** The owner's message on the observed run, as `/messages` served it. */
const OWNER_QUEUED: ChatMessage = ownerMessage("what is your question?");

const READ_AT = "2026-08-25T10:45:12.000Z";
const OWNER_READ: ChatMessage = { ...OWNER_QUEUED, deliveredAt: READ_AT };

/** The run's own last narration of a stretch of work — a `run` row. */
const RUN_ROW: ChatMessage = {
  seq: 2,
  at: "2026-08-25T10:46:00.000Z",
  role: "run",
  text: "Compiled the motion section and moved on to the hero.",
  images: [],
  deliveredAt: null,
};

/* ================================================================== */
/* 1. the parked run                                                  */
/* ================================================================== */

test("1. a parked run holds the message: the stamp says so and the gap is parked", () => {
  const stamp = deliveryStamp(OWNER_QUEUED, PARKED);
  expect(stamp.label).toBe(HELD);
  expect(stamp.tone).toBe("text-warn");
  expect(replyGap([OWNER_QUEUED], PARKED)).toEqual({ kind: "parked", read: false });

  // The negative: the same message, one flag away, is NOT held.
  expect(deliveryStamp(OWNER_QUEUED, RUNNING).label).not.toBe(HELD);
  expect(replyGap([OWNER_QUEUED], RUNNING)?.kind).not.toBe("parked");
});

/* ================================================================== */
/* 2. the running run                                                 */
/* ================================================================== */

test("2. the same message on a running run is queued, not held", () => {
  const stamp = deliveryStamp(OWNER_QUEUED, RUNNING);
  expect(stamp.label).toBe(QUEUED);
  expect(stamp.tone).toBe("text-ink-faint");
  expect(replyGap([OWNER_QUEUED], RUNNING)).toEqual({ kind: "waiting", read: false });

  // The negative: flip to parked and neither the label nor the kind survives.
  expect(deliveryStamp(OWNER_QUEUED, PARKED).label).not.toBe(QUEUED);
  expect(replyGap([OWNER_QUEUED], PARKED)?.kind).not.toBe("waiting");
});

/* ================================================================== */
/* 3. the ended run                                                   */
/* ================================================================== */

test("3. the same message on an ended run was never read", () => {
  const stamp = deliveryStamp(OWNER_QUEUED, OVER);
  expect(stamp.label).toBe(NEVER);
  expect(stamp.tone).toBe("text-warn");
  expect(replyGap([OWNER_QUEUED], OVER)).toEqual({ kind: "unanswered", read: false });

  // The negative: a run that is merely parked has not ended.
  expect(deliveryStamp(OWNER_QUEUED, PARKED).label).not.toBe(NEVER);
  expect(replyGap([OWNER_QUEUED], PARKED)?.kind).not.toBe("unanswered");
});

/* ================================================================== */
/* 4. a stamp beats the park                                          */
/* ================================================================== */

test("4. a delivered message on a parked run reads 'read at', never 'held'", () => {
  const stamp = deliveryStamp(OWNER_READ, PARKED);
  expect(stamp.label).toBe(`read at ${formatTimeOnly(READ_AT)}`);
  expect(stamp.tone).toBe("text-pass");
  expect(stamp.label).not.toBe(HELD);
  // The gap is still parked — nothing will answer until Resume — but it was read.
  expect(replyGap([OWNER_READ], PARKED)).toEqual({ kind: "parked", read: true });

  // The negative: clear the stamp and the same row on the same run is held.
  expect(deliveryStamp(OWNER_QUEUED, PARKED).label).toBe(HELD);
  expect(replyGap([OWNER_QUEUED], PARKED)).toEqual({ kind: "parked", read: false });
});

/* ================================================================== */
/* 5. precedence                                                      */
/* ================================================================== */

test("5. both flags true is a caller bug, and the terminal fact wins", () => {
  const stamp = deliveryStamp(OWNER_QUEUED, BOTH);
  expect(stamp.label).toBe(NEVER);
  expect(stamp.label).not.toBe(HELD);
  expect(replyGap([OWNER_QUEUED], BOTH)).toEqual({ kind: "unanswered", read: false });
  expect(replyGap([OWNER_QUEUED], BOTH)?.kind).not.toBe("parked");

  // The negative: drop `runIsOver` and the park is what shows.
  expect(deliveryStamp(OWNER_QUEUED, { ...BOTH, runIsOver: false }).label).toBe(HELD);
  expect(replyGap([OWNER_QUEUED], { ...BOTH, runIsOver: false })?.kind).toBe("parked");
});

/* ================================================================== */
/* 6. a parked run whose last word is the run's                       */
/* ================================================================== */

test("6. a parked run that ends in a reply, or has no rows, has no gap", () => {
  expect(replyGap([OWNER_QUEUED, RUN_ROW], PARKED)).toBeNull();
  expect(replyGap([], PARKED)).toBeNull();

  // The negative: one more queued owner row after the reply, and the gap is back.
  const later: ChatMessage = { ...OWNER_QUEUED, seq: 3, at: "2026-08-25T10:50:00.000Z" };
  expect(replyGap([OWNER_QUEUED, RUN_ROW, later], PARKED)).toEqual({
    kind: "parked",
    read: false,
  });
});

/* ================================================================== */
/* 7. an old reply does not answer a new question                     */
/* ================================================================== */

test("7. an old run row followed by a new queued owner row is not read, on any live run", () => {
  const newQuestion: ChatMessage = {
    ...OWNER_QUEUED,
    seq: 3,
    at: "2026-08-25T10:50:00.000Z",
    text: "hello?",
  };
  const conversation = [OWNER_READ, RUN_ROW, newQuestion];
  expect(replyGap(conversation, RUNNING)).toEqual({ kind: "waiting", read: false });
  expect(replyGap(conversation, PARKED)).toEqual({ kind: "parked", read: false });

  // The negative, from `ReplyGap`'s own worked example: a delivered owner row
  // anywhere AFTER the last reply makes the whole unanswered group "read", and
  // a newer queued row must not downgrade it.
  const readThenQueued = [RUN_ROW, { ...OWNER_READ, seq: 3 }, { ...newQuestion, seq: 4 }];
  expect(replyGap(readThenQueued, RUNNING)).toEqual({ kind: "waiting", read: true });
  expect(replyGap(readThenQueued, PARKED)).toEqual({ kind: "parked", read: true });
});

/* ================================================================== */
/* the three states are three different sentences                    */
/* ================================================================== */

test("an unstamped message gets a different label and kind on each of the three runs", () => {
  const labels = new Set(
    [RUNNING, PARKED, OVER].map((run) => deliveryStamp(OWNER_QUEUED, run).label),
  );
  const kinds = new Set([RUNNING, PARKED, OVER].map((run) => replyGap([OWNER_QUEUED], run)?.kind));
  expect(labels.size).toBe(3);
  expect(kinds.size).toBe(3);
  expect(labels).toEqual(new Set([QUEUED, HELD, NEVER]));
  expect(kinds).toEqual(new Set(["waiting", "parked", "unanswered"]));
});
