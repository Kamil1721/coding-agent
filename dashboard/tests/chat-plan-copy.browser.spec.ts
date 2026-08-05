/**
 * chat-plan-copy.browser.spec.ts — the prose that left the chat composer and the
 * plan panel, and the three facts that did NOT leave with it.
 *
 * WHAT THIS FILE IS FOR. The owner screenshotted the chat composer as the worst
 * instance of "these long explanations for everything ... If something really
 * must have a explanation it should have little i icon". Ninety words of
 * permanent prose sat under the send button. Cutting them is easy. Cutting them
 * WITHOUT LOSING A FACT is the part that needs watching, and to a suite that
 * only checks "the paragraph is gone", a fact moved behind an "i" and a fact
 * deleted outright look exactly the same. Every test below is aimed at telling
 * those two apart.
 *
 * THE THREE OUTCOMES, AND WHICH TESTS COVER WHICH:
 *
 *   DELETED   — the composer's mechanism sentences ("goes into the open
 *               session", "folded into the next prompt") and the plan panel's
 *               closing paragraph, which said its own subtitle again in longer
 *               words. Covered by "the composer carries no paragraph at all" and
 *               "the plan panel does not say its subtitle twice".
 *   MOVED     — three facts that change what the reader DOES: WHEN a message is
 *               read, WHAT the run can be asked to change, and WHAT a `run` row
 *               actually is. Covered by the three "still reachable" tests, which
 *               open the glyph and assert the sentence, painted.
 *   KEPT      — the plan window's consequence. Covered by "on screen without
 *               interaction", which MEASURES it rather than asserting presence.
 *
 * WHY WIDTH AND NOT `toBeVisible()`, learned from `explain.browser.spec.ts`
 * rather than rediscovered: a shut bubble is `sr-only` — 1x1 and clipped, so its
 * text stays in the accessibility tree for `aria-describedby` — and Playwright
 * counts any non-empty box as visible. `toBeVisible()` on this component is
 * green whether it painted or not, which is precisely the check that cannot go
 * red. So: shut is <= 2px, painted is > 80px, and the kept-inline sentence is
 * measured the same way, because "we hid it behind the i" is exactly what that
 * test has to be able to fail on.
 *
 * ─── MUTATIONS APPLIED TO PRODUCTION CODE, RUN, WATCHED RED, REVERTED ───
 *
 * C1  `canvas/orchestrator-chat.tsx` — the `<Explain testId="explain-timing">`
 *     block deleted, as a "cleanup" of the last thing left under the send row.
 *     "the timing fact is still reachable" goes red on a missing trigger. THIS
 *     IS THE MUTATION THIS FILE EXISTS FOR: without it, deleting the fact and
 *     moving it are the same green.
 * C2  `canvas/orchestrator-chat.tsx` — the first deleted paragraph pasted back
 *     under the send row verbatim. "the composer carries no paragraph at all"
 *     goes red at 54 words against a cap of 12.
 * C3  `run/plan-dialogue.tsx` — the kept-inline window sentence wrapped in an
 *     `<Explain>`, i.e. the exact over-correction this lane could have made.
 *     "the window's consequence is on screen without interaction" goes red: the
 *     span is gone, and it is gone even though the words are still in the DOM.
 * C4  `run/plan-dialogue.tsx` — the closing paragraph restored on the parked
 *     branch. "the plan panel does not say its subtitle twice" goes red on the
 *     phrase it was deleted for repeating.
 * C5  `canvas/orchestrator-chat.tsx` — "the acceptance suite is frozen, so ask
 *     for changes it is indifferent to" restored as a paragraph. "no banned word
 *     is on screen" goes red on `suite` and on `frozen`.
 *
 * ITS TWO RUNS ARE BOTH FIXTURES. `PLAN_RUN_ID` is `awaiting_input`, which is
 * the only status in the harness that renders a LIVE composer (so the timing
 * glyph exists at all — it is deliberately not rendered on a finished run, where
 * the surrounding `<fieldset disabled>` would leave a trigger nobody can open)
 * AND renders the parked plan panel with its clock. `FINISHED_RUN_ID` is the
 * other half of that one decision.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { FINISHED_RUN_ID, PLAN_RUN_ID } from "./fixtures/config";

/**
 * Words the owner said mean nothing to him, plus the two this lane's own copy
 * had to be reworded out of.
 *
 * `trace` IS NOT HERE and its absence is deliberate rather than an oversight:
 * the ban is on `trace` as a NOUN for the activity log, which neither of this
 * lane's files ever writes, and a bare word match would fire on a future
 * sentence using it correctly.
 */
const BANNED = ["seat", "suite", "digest", "freeze", "frozen", "verdict", "terminal run"];

/** The chat composer's own section — the one holding the send button. */
function composer(page: Page): Locator {
  return page.locator("section").filter({ has: page.getByRole("button", { name: "send", exact: true }) });
}

/** The plan panel — the one whose heading is exactly "Plan". */
function planPanel(page: Page): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Plan", exact: true }) });
}

/**
 * The rendered width of a box, or 0 while it is measured-but-unpainted.
 *
 * THE `visibility` GATE IS COPIED FROM `explain.browser.spec.ts` AND IS LOAD
 * BEARING: the bubble is laid out at full width with `visibility: hidden` for
 * one frame before it is positioned, and a width check that accepts that frame
 * can pass against a bubble that never painted.
 */
async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    if (getComputedStyle(element).visibility !== "visible") return 0;
    return Math.round(element.getBoundingClientRect().width);
  });
}

/**
 * The words a READER sees inside an element.
 *
 * IT REMOVES THE `sr-only` BUBBLES FIRST, and without that this whole file
 * measures nothing: every fact this lane moved is still in `textContent`, one
 * pixel wide, so a naive word count would report the wall as still standing and
 * a mutation restoring a paragraph would barely move the number.
 *
 * IT ALSO REMOVES THE MESSAGE LIST. Those rows are the run's own words and the
 * owner's, arriving from the fixture — counting them would make this a test of
 * the conversation's length rather than of the panel's copy.
 */
async function readerWords(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    for (const bubble of clone.querySelectorAll("[data-testid$='-body']")) bubble.remove();
    for (const list of clone.querySelectorAll("ul")) list.remove();
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  });
}

/**
 * The bubble is PAINTED.
 *
 * `expect.poll` AND NOT A BARE READ, for the reason `explain.browser.spec.ts`
 * records after a flake: the bubble must be MEASURED before it can be PLACED, so
 * for one frame it exists at full width with `visibility: hidden`. A single
 * synchronous read lands in that frame often enough to be useless, and this
 * spec's first run failed on it with a width of 0.
 */
async function expectPainted(locator: Locator): Promise<void> {
  await expect
    .poll(async () => widthOf(locator), { message: "the bubble never painted" })
    .toBeGreaterThan(80);
}

function wordCount(text: string): number {
  return text === "" ? 0 : text.split(" ").length;
}

/** Open the parked run and the chat panel on it; both surfaces are then live. */
async function openParkedChat(page: Page): Promise<void> {
  await page.goto(`/runs/${PLAN_RUN_ID}`);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^chat/i }).click();
  await expect(page.getByRole("button", { name: "send", exact: true })).toBeVisible();
}

/* ══════════════════════════════════════════════════════════════════════════
 * MOVED — the three facts that must survive their paragraphs
 * ══════════════════════════════════════════════════════════════════════════ */

test.describe("a fact that was moved is still reachable by a reader", () => {
  /**
   * THE ONE THAT MATTERS MOST. "Send before you resume, or that prompt is
   * composed without it" changes the ORDER of two things the owner is about to
   * do — it is the clause `explain.tsx` names as the type specimen for hiding
   * rather than deleting. If this goes green while the trigger is missing, this
   * lane has deleted a fact and called it a cleanup.
   */
  test("the timing fact is still reachable, and the composer never prints it", async ({
    page,
  }) => {
    await openParkedChat(page);

    const trigger = page.getByTestId("explain-timing");
    const bubble = page.getByTestId("explain-timing-body");

    // NOT ON SCREEN AS PROSE. The words are in the accessibility tree at 1px;
    // what must not be true is that they are painted under the button again.
    expect(await widthOf(bubble)).toBeLessThanOrEqual(2);

    await trigger.click();

    await expect(bubble).toContainText(
      "send it before you resume, or that prompt is composed without it",
    );
    // BOTH PATHS, WHICH IS THE HALF A SHORTER SENTENCE WOULD HAVE DROPPED: this
    // composer is not told the run's status and renders on parked runs too.
    await expect(bubble).toContainText("While the run is working it reads this at its next step");
    await expect(bubble).toContainText("While it is stopped the message waits");
    await expectPainted(bubble);
  });

  test("what the run can be asked to change is still reachable", async ({ page }) => {
    await openParkedChat(page);

    const bubble = page.getByTestId("explain-scope-body");
    expect(await widthOf(bubble)).toBeLessThanOrEqual(2);

    await page.getByTestId("explain-scope").click();

    // THE CLAIM IS `owner-message.ts:84-101`, NOT A PARAPHRASE OF IT: the tests
    // cannot be edited, and a contradicting instruction is reported rather than
    // quietly applied. Both halves are asserted because dropping the second one
    // turns a true sentence into "your instruction will be ignored".
    await expect(bubble).toContainText(
      "The tests this run is graded on were written before any code and cannot be edited",
    );
    await expect(bubble).toContainText("reported back, not made quietly");
    await expectPainted(bubble);
  });

  test("what a reply actually is, is reachable from the row that could be misread", async ({
    page,
  }) => {
    await openParkedChat(page);

    /*
     * BY THE ROW'S OWN ID, NOT BY `.first()`, AND THAT IS NOT TIDINESS. An open
     * bubble is portaled to the END of the document, so `.first()` on a shared
     * testid silently starts resolving to a DIFFERENT row's shut bubble the
     * instant one opens — and every one of these carries the same sentence, so
     * the text assertion goes green against a bubble that never painted. This
     * spec failed exactly that way before the per-row id existed.
     *
     * SEQ 1 IS A `run` ROW in `PLAN_MESSAGES` — the seat's opening plan. An
     * `owner` row carries no glyph at all, which is the point of the gate.
     */
    const bubble = page.getByTestId("explain-reply-1-body");
    expect(await widthOf(bubble)).toBeLessThanOrEqual(2);

    // AND THE OWNER'S OWN ROW HAS NONE: seq 3 is his, and "what the run sends
    // back" is not true of it.
    await expect(page.getByTestId("explain-reply-3")).toHaveCount(0);

    await page.getByTestId("explain-reply-1").click();

    // "NOT AN ANSWER WRITTEN FOR YOU" IS THE WHOLE SENTENCE'S REASON FOR
    // EXISTING. Without it the panel reads as a chatbot that answered him, and
    // the row above it is the agent's last narration of a build step.
    await expect(bubble).toContainText("the last thing the agent wrote in that stretch of work");
    await expect(bubble).toContainText("not an answer written for you");
    await expectPainted(bubble);
  });

  /**
   * THE GLYPH IS NOT RENDERED WHERE IT COULD NOT BE OPENED, and this is the test
   * that keeps that decision honest rather than letting it rot into an omission.
   * Everything in the send row is inside `<fieldset disabled={runIsOver}>`, which
   * disables descendant buttons — the trigger was on screen and inert until this
   * was found by clicking it. On a finished run nothing can be sent, so WHEN a
   * message is read is not a fact the reader can act on.
   */
  test("no dead trigger on a finished run, where nothing can be sent", async ({ page }) => {
    await page.goto(`/runs/${FINISHED_RUN_ID}`);
    await page.getByRole("button", { name: /^chat/i }).click();
    await expect(page.getByRole("button", { name: "send", exact: true })).toBeVisible();

    await expect(page.getByTestId("explain-timing")).toHaveCount(0);
    // AND THE REASON HE CANNOT SEND IS STILL STATED, in one sentence rather than
    // the three-clause version that explained the server's refusal to him.
    await expect(composer(page)).toContainText("This run has finished. Start a new run to use this.");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * KEPT INLINE — the one sentence that earned the screen
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * MEASURED, NOT LOCATED. The failure this guards against is the opposite of the
 * one above: over-correcting, and putting behind an "i" a fact the reader needs
 * BEFORE he acts and cannot recover after. The plan window closing is not
 * undoable — every open question is recorded as an assumption and the criteria
 * are authored from it — so it is the one sentence in either file that stays on
 * screen with no interaction at all.
 */
test("the window's consequence is on screen without interaction, painted", async ({ page }) => {
  await page.goto(`/runs/${PLAN_RUN_ID}`);

  const sentence = page.getByTestId("plan-window-consequence");

  // NO CLICK, NO HOVER, NO TAB ANYWHERE ABOVE THIS LINE.
  await expect(sentence).toHaveText("When it closes, the run carries on and records what it assumed.");
  expect(await widthOf(sentence)).toBeGreaterThan(150);
});

/* ══════════════════════════════════════════════════════════════════════════
 * DELETED — and the screens that are shorter for it
 * ══════════════════════════════════════════════════════════════════════════ */

test("the composer carries no explanatory paragraph at all", async ({ page }) => {
  await openParkedChat(page);

  const words = await readerWords(composer(page));

  /*
   * TWELVE. The composer's own reader-visible text is now its heading, the
   * message count, and two button labels — "Chat 5 send attach images" — and
   * the cap is set just above that so a returning paragraph cannot hide under
   * it. Either of the deleted paragraphs alone is forty-odd words.
   */
  expect(wordCount(words), `composer prose was: ${words}`).toBeLessThanOrEqual(12);

  // THE EXACT CLAUSES THAT WENT, NAMED, so a future edit reintroducing one by
  // hand fails on the sentence rather than on an arithmetic cap it might squeak
  // under.
  for (const gone of [
    "goes into the open session",
    "picked up at the agent",
    "folded into the next prompt",
    "Images are read before it acts on them",
    "stored verbatim",
  ]) {
    expect(words, `still on screen: ${gone}`).not.toContain(gone);
  }
});

test("the plan panel does not say its subtitle twice", async ({ page }) => {
  await page.goto(`/runs/${PLAN_RUN_ID}`);

  const words = await readerWords(planPanel(page));

  // THE SUBTITLE ITSELF STAYS — it is the panel's label, and it is the thing the
  // deleted paragraph was a longer copy of.
  expect(words).toContain("Answers go into the brief before any criterion is written.");
  // AND THE COPY OF IT IS GONE, both branches of it.
  expect(words).not.toContain("the whole exchange goes into the brief the criteria are written from");
  expect(words).not.toContain("This is the run's chat. Anything you send here");

  // THE ONE FACT INSIDE IT SURVIVED, behind the subtitle's own glyph: a reader
  // who thinks the Chat tab is a second inbox answers there and comes back here
  // looking for it.
  await page.getByTestId("explain-channel").click();
  const bubble = page.getByTestId("explain-channel-body");
  await expect(bubble).toContainText("Anything you send from the Chat tab is read as part of this exchange");
  await expectPainted(bubble);
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE WORDS THE OWNER SAID MEAN NOTHING TO HIM
 * ══════════════════════════════════════════════════════════════════════════ */

test("no banned word is on screen in either panel", async ({ page }) => {
  /*
   * THE PLAN PANEL IS READ BEFORE THE CHAT PANEL IS OPENED, and the first draft
   * of this test read them in the other order and hung for sixty seconds. THE
   * RAIL SHOWS ONE PANEL AT A TIME: opening Chat unmounts the docked plan panel,
   * so `planPanel(page)` was waiting on a section that no longer existed. A
   * banned word can only be found on a surface that is actually mounted.
   */
  await page.goto(`/runs/${PLAN_RUN_ID}`);
  const planWords = await readerWords(planPanel(page));

  await page.getByRole("button", { name: /^chat/i }).click();
  await expect(page.getByRole("button", { name: "send", exact: true })).toBeVisible();

  const seen = `${await readerWords(composer(page))} ${planWords}`;

  for (const word of BANNED) {
    expect(seen.toLowerCase(), `"${word}" is on screen: ${seen}`).not.toContain(word);
  }
});
