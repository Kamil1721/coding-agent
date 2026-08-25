/**
 * chat-parked.browser.spec.ts — the chat panel on a PARKED run says nothing is
 * running to read what was sent, and agrees with the notice over the graph.
 *
 * WHY THIS FILE EXISTS — 2026-08-25, run `run-2026-08-25T10-30-39-122Z-d728ab79`.
 * That run parked `awaiting_input` after ONE creative-author call whose output
 * the compiler rejected (`MOTION_FALLBACK_INVALID` at `/motion/1/trigger`); its
 * plan dialogue was already settled (`plan.awaiting=false`,
 * `closed.reason="answered"`), so nothing had asked a question. Two surfaces
 * described that park and contradicted each other: `AwaitingInputNotice` said
 * "Type your answer in the Chat panel, then press Resume", and the Chat panel,
 * under the "what is your question?" the owner typed in reply, said "queued —
 * not read yet" and "Not read yet, so there is nothing to answer — reopen this
 * tab to check" — as if reopening could change anything on a run nothing was
 * stepping. Lane B rewrote the notice for a park with no question ("Nothing
 * was asked, so there is nothing to type."); this lane gave the chat a
 * `runParked` prop read off the SAME gate that mounts that notice
 * (`runs/[runId]/page.tsx`, `genericParkOpen`). This file opens the chat on a
 * parked run and asserts BOTH surfaces at once, so the two can be seen to agree
 * — and opens it on a running run, a finished run, an answerable plan park and
 * a pending design park to prove the parked copy appears on none of them.
 *
 * THE MESSAGE IS THE OWNER'S OWN, byte for byte, with `deliveredAt: null` — the
 * row as `GET /messages` served it while the run sat parked, built by
 * `ownerMessage` (`fixtures/run-fixture.ts`), the same row
 * `chat-reply.unit.spec.ts` proves the record line under. It is ROUTED, on
 * BOTH METHODS, because the harness serves no `/messages` for `RUN_ID` or
 * `FINISHED_RUN_ID` at all (`fixtures/api-server.ts` answers 404, and
 * `page.tsx` swallows it into an empty list): a spec that routed only the POST,
 * as `orchestrator-steer.browser.spec.ts` does, would open a chat with no rows
 * and assert the absence of every sentence — green over nothing.
 *
 * THE PARKED PAGE IS `RUN_ID` PATCHED TO `awaiting_input` — the shape
 * `prose-guard.browser.spec.ts`'s "stopped, waiting on the owner" sweep uses.
 * `RUN_DETAIL` has `phase: "build"`, no `plan`, `designLock: null` and
 * `failureReason: null`, so it is the GENERIC park: not a plan park (which
 * would read the chat without Resume and suppress the notice) and not a design
 * park. `PLAN_RUN_ID` is not the parked page for exactly that reason — on it
 * the parked copy would be a lie and the notice does not render — which is
 * what makes it the neighbour below.
 *
 * THE TWO PARKS THAT MUST NOT SAY HELD — fix round 1, 2026-08-25. `runParked`
 * is `genericParkOpen` (`runs/[runId]/page.tsx`), three terms:
 * `status === "awaiting_input"`, `lockPhase !== "pending"`, `!planAnswerable`.
 * The three pages above differ only in STATUS, so a mount rewired to the bare
 * first term — the predicate the lane's map calls wrong on a plan park — left
 * every case in this file green (review finding, 2026-08-25). Two pages were
 * added, one per discriminating term:
 *   - `PLAN_RUN_ID`, served `PLAN_MESSAGES` plus the same queued owner row
 *     appended as seq 6. The dialogue is DERIVED FROM THE MESSAGE LIST
 *     (`planDialogueFrom` in `lib/plan-dialogue.ts` reads the `PQ-n` blocks),
 *     so the routed body must keep the question rows: a lone owner row nulls
 *     the dialogue, `planAnswerable` goes false, the page becomes the
 *     crash-window generic park `page.tsx` documents, and the held copy is
 *     CORRECT there — a test that served only the owner row would pass for the
 *     wrong reason. The "Plan" heading is asserted as the control that the
 *     dialogue rendered.
 *   - `RUN_ID` patched to `awaiting_input` WITH a pending design lock — the
 *     five-key legacy shape `design-lock.browser.spec.ts`'s `PARKED` serves,
 *     two mockups. The "Design lock" heading and two choosable cards are the
 *     control that `lockPhase` is `pending`: a card is a button only then.
 * On both, the same row reads "queued — not read yet" over the live gap
 * sentence, and no notice renders: a plan park reads chat without Resume
 * (`PlanDriver`), a design park consumes a direction-naming message
 * (`DesignDialogueDriver`) — on either, "nothing is running to read it" would
 * be untrue.
 *
 * EVERY PAGE IS ASSERTED IN BOTH DIRECTIONS: the sentences that must be on
 * screen, and the ones that must not. The chat is opened before any chat row
 * is read: the panel is mounted `hidden` until `rail-chat` is clicked, and
 * `toBeVisible` on a hidden row is red for the wrong reason. ON THE TWO PARK
 * NEIGHBOURS THE CONTROL COMES FIRST: `PlanDialoguePanel` and `DesignLockPanel`
 * render in the rail's QUESTIONS slot (`page.tsx`, `questionsBody`), the slot a
 * park opens by default and the chat click replaces — measured 2026-08-25, both
 * neighbours red on their control line with the chat rows already correct in
 * the failure snapshot when the heading was asserted after the click.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import type { ChatMessage, Screenshot } from "../src/lib/api-types";
import { MOCKUP_LABEL } from "../src/lib/mockups";
import { chatSection, openChat, openChatPanel } from "./fixtures/chat";
import { FINISHED_RUN_ID, PLAN_RUN_ID, RUN_ID } from "./fixtures/config";
import { CORS, patchDetail } from "./fixtures/patch-detail";
import { PLAN_MESSAGES, ownerMessage } from "./fixtures/run-fixture";

/* ------------------------------------------------------------------ */
/* the copy, verbatim — every string here is one the screen renders    */
/* ------------------------------------------------------------------ */

/** The owner's message on the observed run. */
const OWNER_TEXT = "what is your question?";

const HELD_STAMP = "queued — held until Resume; nothing is running to read it";
const HELD_GAP =
  "Nothing is running to read what you sent. Resume hands it to the run at its next work boundary — reopen this tab after that to check.";
const QUEUED_STAMP = "queued — not read yet";
const QUEUED_GAP = "Not read yet, so there is nothing to answer — reopen this tab to check.";
const NEVER_STAMP = "never read — the run ended first";
const NEVER_GAP = "The run ended before reading it, so there was nothing to answer.";

const NOTICE_TITLE = "Waiting on input";
/** Lane B's body for a park with no question — the sentence the chat must agree with. */
const NOTHING_ASKED = "Nothing was asked, so there is nothing to type.";
/** The plan-question script the observed run wrongly showed. */
const ANSWER_SCRIPT = /then press Resume/;

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * One queued owner row on `/messages`, on BOTH methods (see the header). The
 * preflight `OPTIONS` falls through to the fixture API, which answers every
 * path with 204 and the CORS headers.
 *
 * `before` is the transcript the row is appended to — empty on the generic,
 * running and finished pages; `PLAN_MESSAGES` on the plan park, whose dialogue
 * is read out of these same rows and must stay on screen (see the header).
 */
async function routeMessages(
  page: Page,
  runId: string,
  before: readonly ChatMessage[] = [],
): Promise<void> {
  const message = ownerMessage(OWNER_TEXT, before.length + 1);
  const messages = [...before, message];
  await page.route(
    (url) => url.pathname === `/api/runs/${runId}/messages`,
    async (route) => {
      const method = route.request().method();
      if (method === "OPTIONS") {
        await route.fallback();
        return;
      }
      if (method === "POST") {
        await route.fulfill({
          status: 202,
          headers: CORS,
          contentType: "application/json",
          body: JSON.stringify({
            disposition: "queued_boundary",
            message,
            documents: [],
            targetRunId: runId,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify({ messages }),
      });
    },
  );
}

/* ------------------------------------------------------------------ */
/* the design park                                                     */
/* ------------------------------------------------------------------ */

/**
 * Two mockups, published the way `#recordDesignMockups` publishes them — the
 * path is an absolute host path and the card fetches it through
 * `GET /api/runs/:id/screenshots/:file` (`lib/screenshots.ts`).
 */
const DESIGN_MOCKUPS: readonly Screenshot[] = ["hero", "contact"].map((section, index) => ({
  path: `/Users/o/.dashboard/results/screenshots/${RUN_ID}/design-0${String(index + 1)}-${section}.png`,
  label: `${MOCKUP_LABEL}${section}`,
  capturedAt: `2026-08-25T10:3${String(index)}:05.000Z`,
}));

/**
 * THE FIVE-KEY LOCK EVERY RECORDED RUN ACTUALLY ANSWERS WITH — the shape
 * `design-lock.browser.spec.ts` calls `PARKED`, on the shared run. With
 * `awaiting: true`, `locked: null`, no `stage` and `status: "awaiting_input"`,
 * `designLockPhase` (`lib/mockups.ts`) reads `pending`, which is the one lock
 * phase that turns `genericParkOpen` — and so `runParked` — off.
 */
const PENDING_LOCK = {
  awaiting: true,
  mockups: DESIGN_MOCKUPS,
  locked: null,
  lockedBy: null,
  reason: null,
};

/** A 1x1 PNG, so the cards resolve a real image rather than their error branch. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function routeMockupImages(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.includes("/screenshots/"),
    async (route) => {
      await route.fulfill({ status: 200, headers: CORS, contentType: "image/png", body: PIXEL });
    },
  );
}

/* ------------------------------------------------------------------ */
/* the six lines every page asserts                                    */
/* ------------------------------------------------------------------ */

/** The three rungs the record line and the gap can take, paired. */
const COPY = {
  held: [HELD_STAMP, HELD_GAP],
  queued: [QUEUED_STAMP, QUEUED_GAP],
  never: [NEVER_STAMP, NEVER_GAP],
} as const;

/**
 * One rung on screen and the other two absent — both directions, on every
 * page (see the header). The shown pair is asserted FIRST, so the four
 * absences are measured over a rendered row and not over a panel still
 * drawing. Each test keeps its own reply-label and notice lines: those are
 * what differ between the pages, not this block.
 */
async function expectChatCopy(panel: Locator, shown: keyof typeof COPY): Promise<void> {
  const [stamp, gap] = COPY[shown];
  await expect(panel.getByText(stamp, { exact: true })).toBeVisible();
  await expect(panel.getByText(gap)).toBeVisible();
  for (const kind of Object.keys(COPY) as (keyof typeof COPY)[]) {
    if (kind === shown) continue;
    const [otherStamp, otherGap] = COPY[kind];
    await expect(panel.getByText(otherStamp, { exact: true })).toHaveCount(0);
    await expect(panel.getByText(otherGap)).toHaveCount(0);
  }
}

/* ================================================================== */
/* the parked run                                                     */
/* ================================================================== */

test("on a parked run the message is held, the gap names Resume, and the notice agrees", async ({
  page,
}) => {
  await patchDetail(page, RUN_ID, (body) => {
    body["status"] = "awaiting_input";
  });
  await routeMessages(page, RUN_ID);
  await openChat(page, RUN_ID);

  const panel = chatSection(page);
  // The row is there at all — the control that makes every absence below mean something.
  await expect(panel.getByText(OWNER_TEXT)).toBeVisible();

  // The parked rung — and neither the running nor the finished one.
  await expectChatCopy(panel, "held");
  await expect(panel.getByText("no reply yet", { exact: true })).toBeVisible();
  await expect(panel.getByText("the run did not answer", { exact: true })).toHaveCount(0);

  // The notice over the graph, on the same screen, says the same thing: nothing
  // was asked. The answer-first script the observed run showed is absent.
  await expect(page.getByText(NOTICE_TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText(NOTHING_ASKED)).toBeVisible();
  await expect(page.getByText(ANSWER_SCRIPT)).toHaveCount(0);
  await expect(page.getByTestId("explain-answer-order")).toHaveCount(0);
  // `RUN_DETAIL` records no cause, so the cause block is not on screen either.
  await expect(page.getByTestId("awaiting-input-cause")).toHaveCount(0);
});

/* ================================================================== */
/* the running run                                                    */
/* ================================================================== */

test("on a running run the same message is queued, and nothing says held", async ({
  page,
}) => {
  await routeMessages(page, RUN_ID);
  await openChat(page, RUN_ID);

  const panel = chatSection(page);
  await expect(panel.getByText(OWNER_TEXT)).toBeVisible();

  await expectChatCopy(panel, "queued");
  await expect(panel.getByText("no reply yet", { exact: true })).toBeVisible();

  // No park, no notice.
  await expect(page.getByText(NOTICE_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(NOTHING_ASKED)).toHaveCount(0);
});

/* ================================================================== */
/* the finished run                                                   */
/* ================================================================== */

test("on a finished run the same message was never read, and nothing says held", async ({
  page,
}) => {
  await routeMessages(page, FINISHED_RUN_ID);
  await openChat(page, FINISHED_RUN_ID);

  const panel = chatSection(page);
  await expect(panel.getByText(OWNER_TEXT)).toBeVisible();

  await expectChatCopy(panel, "never");
  await expect(panel.getByText("the run did not answer", { exact: true })).toBeVisible();
  await expect(panel.getByText("no reply yet", { exact: true })).toHaveCount(0);

  await expect(page.getByText(NOTICE_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(NOTHING_ASKED)).toHaveCount(0);
});

/* ================================================================== */
/* the two parks that are NOT the generic park — see the header       */
/* ================================================================== */

test("on an answerable plan park the same message is queued, not held — the dialogue reads it", async ({
  page,
}) => {
  await routeMessages(page, PLAN_RUN_ID, PLAN_MESSAGES);
  await page.goto(`/runs/${PLAN_RUN_ID}`);

  // THE CONTROL, BEFORE THE CHAT OPENS: the dialogue rendered, so
  // `planAnswerable` is true. Without this line a routed body that lost the
  // question rows would turn the page into the generic park and every absence
  // below would still hold — for the wrong reason (`PLAN_RUN_ID` is
  // `awaiting_input` either way). It is asserted first because the plan panel
  // is the rail's questions slot, and the chat click below takes that slot.
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();

  await openChatPanel(page);
  const panel = chatSection(page);
  await expect(panel.getByText(OWNER_TEXT)).toBeVisible();

  // The live copy, under a park — because something IS reading it.
  await expectChatCopy(panel, "queued");
  await expect(panel.getByText("no reply yet", { exact: true })).toBeVisible();

  // And the generic notice is suppressed on this park, as `page.tsx`'s gate
  // says — the same boolean the chat was handed.
  await expect(page.getByText(NOTICE_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(NOTHING_ASKED)).toHaveCount(0);
  await expect(page.getByTestId("explain-answer-order")).toHaveCount(0);
});

test("on a pending design park the same message is queued, not held — a direction can be named", async ({
  page,
}) => {
  await patchDetail(page, RUN_ID, (body) => {
    body["status"] = "awaiting_input";
    body["designLock"] = PENDING_LOCK;
  });
  await routeMockupImages(page);
  await routeMessages(page, RUN_ID);
  await page.goto(`/runs/${RUN_ID}`);

  // THE CONTROL, BEFORE THE CHAT OPENS: the lock rendered AND its phase is
  // `pending` — a mockup is a choosable button only while the park is open. A
  // lock served in any other phase (`settled`, `unlocked`, `closing`) leaves
  // `genericParkOpen` true and the held copy correct, so the count is what
  // makes the absences mean it. Asserted first because the lock panel is the
  // rail's questions slot, and the chat click below takes that slot.
  await expect(page.getByRole("heading", { name: "Design lock" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Build to the / })).toHaveCount(
    DESIGN_MOCKUPS.length,
  );

  await openChatPanel(page);
  const panel = chatSection(page);
  await expect(panel.getByText(OWNER_TEXT)).toBeVisible();

  await expectChatCopy(panel, "queued");
  await expect(panel.getByText("no reply yet", { exact: true })).toBeVisible();

  // On a design park the cards are the channel; the generic notice is off.
  await expect(page.getByText(NOTICE_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(NOTHING_ASKED)).toHaveCount(0);
  await expect(page.getByTestId("explain-answer-order")).toHaveCount(0);
});
