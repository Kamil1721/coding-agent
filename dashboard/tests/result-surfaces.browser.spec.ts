/**
 * result-surfaces.browser.spec.ts — what the Result panel still SAYS after the
 * prose came off it.
 *
 * WHAT THIS LANE DID. `notices.tsx`, `criteria.tsx`, `published-project.tsx` and
 * `screenshots.tsx` carried 891 words of user-visible strings; the pass took them
 * to 570, and 137 of those 570 are now behind the `Explain` glyph rather than on
 * the screen. Three outcomes were available for every paragraph — DELETE, MOVE
 * BEHIND THE GLYPH, KEEP INLINE — and the danger is that the SUITE cannot tell
 * the first two apart. A fact that was moved and a fact that was lost look
 * identical to `expect(panel).not.toContainText(...)`, and this repository's
 * signature defect is a check that can only observe the outcome it wanted.
 *
 * SO EVERY TEST HERE ASSERTS TWO THINGS AT ONCE: that the sentence is not
 * permanently on the screen, AND that a reader can still get to it. Both halves
 * have a mutation, both were applied to production code, watched, and reverted —
 * each is recorded in the test it belongs to.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY GEOMETRY AND NOT `toBeVisible()`.
 *
 * `Explain` keeps its text in ONE element in both states: `sr-only` and inline
 * when shut, portaled and painted when open. `sr-only` is `position:absolute;
 * width:1px; height:1px; clip:rect(0,0,0,0)` — which means the element still has
 * a non-empty box and is not `visibility:hidden`, so Playwright calls it VISIBLE
 * and `innerText` still reports its words. Measured, not assumed: the run
 * screenshotted for this lane printed the whole hidden sentence in the panel's
 * `innerText` while the PNG of the same panel shows no such line.
 *
 * A check written on `toBeVisible` or `toContainText` therefore cannot tell "on
 * the screen" from "behind the glyph", which is the ONE distinction this lane
 * exists to make. Width can: 1px shut, ≫100px painted. Every assertion below
 * about whether a reader can SEE something is a width.
 */

import { expect, test, type Page } from "@playwright/test";

import { FINISHED_RUN_ID, RUN_ID } from "./fixtures/config";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/**
 * Serve one run's detail with fields changed.
 *
 * THE HEADERS ARE WRITTEN OUT RATHER THAN COPIED, and that is not a style
 * choice — `panel-copy.browser.spec.ts` records both shortcuts being tried and
 * both producing a page with no rail at all: `route.fulfill({ response })`
 * carries the original `content-length` over a body of a different length, and a
 * copy of `response.headers()` carries hop-by-hop headers a fulfilled response
 * may not restate. `access-control-allow-origin` is required because the app and
 * the fixture API are on different ports.
 */
async function patchDetail(
  page: Page,
  runId: string,
  patch: (body: Record<string, unknown>) => void,
): Promise<void> {
  await page.route(
    (url) => url.pathname === `/api/runs/${runId}` && url.search === "",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      patch(body);
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}

/**
 * Open the Result panel BY KEYBOARD.
 *
 * `next dev` pins a `<nextjs-portal>` badge to the bottom-left of the viewport,
 * exactly where the rail pins its last entry, and Playwright refuses a pointer
 * click it would intercept. Every rail entry is operable from the keyboard
 * anyway; `rail.browser.spec.ts` records the same workaround.
 */
async function openResult(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
  const button = page.getByTestId("rail-result");
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("rail-panel")).toBeVisible();
}

/**
 * The painted width of an element, in CSS pixels, or 0 when it has no box.
 *
 * 1 for anything `sr-only`. The thresholds below are deliberately far from both
 * ends — nothing in this app renders a 40px-wide sentence — so a change in font
 * or panel width cannot flip one.
 */
async function widthOf(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  return box === null ? 0 : box.width;
}

/** The exact sentence that moved off the criteria panel and behind its glyph. */
const LOCKED_PROMISE = "locked so the build could not edit them";

/* ------------------------------------------------------------------ */
/* MOVED — the fact is off the screen and a reader can still get it     */
/* ------------------------------------------------------------------ */

/**
 * THE SINGLE MOST IMPORTANT TEST IN THIS LANE.
 *
 * The sentence "Written from your ticket before any code existed, then locked so
 * the build could not edit them" is what makes a green count mean anything:
 * criteria written after a build, by the builder, grade nothing. It was on the
 * Result panel TWICE — as the criteria panel's subtitle and again in its empty
 * state — and it is now once, behind the glyph on the heading.
 *
 * FOUR MUTATIONS, EACH APPLIED TO PRODUCTION CODE, RUN, WATCHED, REVERTED.
 *
 *   M1  Deleted the whole `<Explain>` from `criteria.tsx`'s `title`, leaving
 *       "Acceptance criteria". RED — `locator.boundingBox` timed out waiting for
 *       `explain-criteria-body`. This is the mutation that separates MOVED from
 *       DELETED, and it is why the later assertion is on the body's TEXT rather
 *       than on the trigger's existence.
 *
 *   M2  Put the sentence back as the panel's `subtitle` as well, keeping the
 *       glyph. RED on the FIRST assertion, received 109.640625px. Note what
 *       stayed green: the shut-width check and the bubble's content, because the
 *       glyph's own copy is untouched. Without the painted-width loop this test
 *       would pass on a panel that still prints the paragraph — which is the
 *       failure mode of every "the element exists" check in this repository.
 *
 *   M3  Left the glyph in place and replaced its sentence with "More info." RED
 *       on `toHaveText`. A test that asserted only that a bubble OPENED would
 *       have survived this one.
 *
 *   M12 Deleted `normal-case` from the call site. RED on the casing assertion
 *       below — and GREEN before that assertion existed, which is why it exists.
 */
test("the locked-tests promise is off the screen and one click away", async ({
  page,
}) => {
  await openResult(page, RUN_ID);
  const panel = page.getByTestId("rail-panel");

  /*
   * NOTHING PAINTED CARRIES IT. `getByText` finds the `sr-only` element too, so
   * the discriminator is the width of every match, not the count of them.
   */
  const painted = panel.getByText(LOCKED_PROMISE);
  for (let index = 0; index < (await painted.count()); index += 1) {
    const box = await painted.nth(index).boundingBox();
    expect(
      box === null ? 0 : box.width,
      "the criteria panel still prints the locked-tests sentence on the screen",
    ).toBeLessThan(40);
  }

  // Shut: one element, one CSS pixel wide.
  expect(await widthOf(page, "explain-criteria-body")).toBeLessThan(4);

  /*
   * AND SHUT, IT IS STILL A SENTENCE RATHER THAN SHOUTING.
   *
   * ADDED AFTER A MUTATION SURVIVED. `Explain`'s shut bubble is an `sr-only`
   * child of the wrapper, and `sr-only` sets no `text-transform` — so inside
   * this `uppercase` `h2` the hidden sentence inherits the transform, and the
   * ACCESSIBILITY TREE, which is the whole reason the element is rendered while
   * shut, gets "WRITTEN FROM YOUR TICKET…". Some voices spell that out letter by
   * letter. The call site pays for `normal-case`; deleting it was mutation M12
   * and this file was GREEN over it until this assertion existed.
   *
   * `innerText` APPLIES `text-transform`, `textContent` DOES NOT — which is why
   * this reads the rendered text and the assertion is on case, not on wording.
   */
  expect(
    await page.getByTestId("explain-criteria-body").innerText(),
    "the shut bubble has inherited the heading's uppercase, so a screen reader is handed shouting",
  ).toContain("Written from your ticket before any code existed");

  await page.getByTestId("explain-criteria").click();

  /*
   * THE CONTENT, NOT THE CONTROL. A test that asserted the bubble merely opened
   * would stay green if the sentence inside it were replaced by "More info".
   */
  await expect(page.getByTestId("explain-criteria-body")).toHaveText(
    "Written from your ticket before any code existed, then locked so the build could not edit them.",
  );
  expect(
    await widthOf(page, "explain-criteria-body"),
    "the bubble opened without painting anything",
  ).toBeGreaterThan(120);
});

/**
 * The masking rule, same shape, different panel — and it is the one that would
 * otherwise be a mystery on screen rather than a sentence nobody reads. A reader
 * looking at a blacked-out strip in a capture has to be able to find out that it
 * is masking and that it cannot be undone.
 *
 * MUTATION M4, APPLIED, RED, REVERTED. Deleted the `<Explain>` from the panel
 * title in `screenshots.tsx`. RED — `locator.boundingBox` timed out waiting for
 * `explain-masking-body`.
 */
test("the masking rule is off the screen and one click away", async ({ page }) => {
  await patchDetail(page, RUN_ID, (body) => {
    // A PRODUCT capture, not a reference: `splitCaptures` files a shot under the
    // design references only when its label starts with the mockup prefix, and
    // the glyph renders only when there is at least one product capture.
    body["screenshots"] = [
      {
        path: "/tmp/harness/home-1280.png",
        label: "home @ 1280",
        capturedAt: "2026-08-04T12:00:00.000Z",
      },
    ];
  });
  await openResult(page, RUN_ID);

  expect(await widthOf(page, "explain-masking-body")).toBeLessThan(4);
  await page.getByTestId("explain-masking").click();
  await expect(page.getByTestId("explain-masking-body")).toHaveText(
    "Masking is applied when a capture is taken. It cannot be added or removed afterwards.",
  );
  expect(await widthOf(page, "explain-masking-body")).toBeGreaterThan(120);
});

/* ------------------------------------------------------------------ */
/* KEPT INLINE — the fact is on the screen with no interaction at all   */
/* ------------------------------------------------------------------ */

/**
 * THE OTHER HALF OF THE PAIR, AND THE REASON THE GLYPH IS NOT A DUMPING GROUND.
 *
 * A false finish is the failure that ships a broken app while claiming success.
 * The reader has to know the agent's own summary is unreliable BEFORE they read
 * it, and this panel is where they read it — a fact needed before acting, with
 * no recovery from missing it, which is the one category `explain.tsx` reserves
 * for staying on screen.
 *
 * MUTATION M5, APPLIED, RED, REVERTED. Wrapped the sentence in an `<Explain>` in
 * `notices.tsx` — the exact move this test exists to forbid. Read the order of
 * what happened: `getByText` still found it (the shut bubble is in the DOM), and
 * `expect(warning).toBeVisible()` on the line above PASSED on the 1px box. Only
 * the WIDTH assertion went red, received 1. That is the whole argument for
 * measuring geometry rather than trusting `toBeVisible` in this file.
 *
 * MUTATION M6, APPLIED, RED, REVERTED. Put the old title back — "FALSE FINISH —
 * it said it was done. The gate says otherwise." RED on the last assertion,
 * which is what keeps the fact that moved INTO the title from being quietly
 * reworded back into the grader's vocabulary.
 */
test("a false finish says so on the screen, with nothing to click", async ({
  page,
}) => {
  await patchDetail(page, FINISHED_RUN_ID, (body) => {
    body["falseFinish"] = true;
  });
  await openResult(page, FINISHED_RUN_ID);
  const panel = page.getByTestId("rail-panel");

  const warning = panel.getByText(
    "Its own account of this run is not reliable — the criteria below are the evidence, its summary is not.",
  );
  await expect(warning).toBeVisible();
  const box = await warning.boundingBox();
  expect(
    box === null ? 0 : box.width,
    "the false-finish warning is not painted — it has been hidden behind a glyph",
  ).toBeGreaterThan(150);

  // And the title still names what disagreed, in words that are not the
  // grader's: `gate` was the term of art it replaced.
  await expect(panel).toContainText("The tests it never saw disagree.");
});

/* ------------------------------------------------------------------ */
/* DELETED — the repetition the owner screenshotted is gone             */
/* ------------------------------------------------------------------ */

/**
 * The empty criteria panel said the same thing twice, two lines apart: the
 * subtitle "Written from your ticket before any code existed, then locked…" and
 * then "No criteria yet. They are written from your ticket first, before any
 * build starts."
 *
 * `toHaveText` IS EXACT, WHICH IS THE POINT. `toContainText` would pass on the
 * old string too.
 *
 * MUTATION M7, APPLIED, RED, REVERTED. Restored the second sentence to the
 * `EmptyState` in `criteria.tsx`. RED — the `/^No criteria yet\.$/` filter
 * matched nothing, so the locator resolved to zero elements.
 */
test("an empty criteria panel says it once, in three words", async ({ page }) => {
  await patchDetail(page, RUN_ID, (body) => {
    body["criteria"] = [];
  });
  await openResult(page, RUN_ID);

  await expect(
    page.getByTestId("rail-panel").locator("p", { hasText: /^No criteria yet\.$/ }),
  ).toHaveText("No criteria yet.");
});

/* ------------------------------------------------------------------ */
/* MOVED, BEHIND A DISCLOSURE — the server's own words                  */
/* ------------------------------------------------------------------ */

/**
 * THE BLOCK THE OWNER SCREENSHOTTED. A refused publish printed the server's
 * `detail` verbatim: four rendered lines narrating an absolute host path which
 * the same tab already prints as a copyable field one block above.
 *
 * IT IS NOT BEHIND THE GLYPH, AND THAT IS DELIBERATE. `Explain`'s bubble is
 * capped at 288px and is not hoverable — its own hand-off says one or two
 * sentences, not a passage carrying a 100-character path. A shut `<details>` is
 * the right affordance for machine text, and it is the one `OutcomeNotice`
 * already uses for `failureReason` in the same panel.
 *
 * THE STRING BELOW IS THE REAL ONE, copied from
 * `GET /api/runs/run-2026-08-04T11-08-10-487Z-162b186d` on the owner's backend —
 * a run that genuinely declined `workspace-empty`.
 *
 * FOUR MUTATIONS, EACH APPLIED, RUN, WATCHED, REVERTED.
 *
 *   M8  Forced the `DECLINE_LINE` lookup to miss, so `record.detail` renders
 *       inline as it used to. RED on "The run left no file worth copying."
 *
 *   M13 Kept the short line AND rendered `record.detail` beside it — the
 *       mutation M8 could not test, because M8 reddens an earlier assertion.
 *       RED on the path check, which is the one that says the block has stopped
 *       narrating.
 *
 *   M9  Deleted the `<details>` entirely, keeping only the short line. RED on
 *       the disclosure click. This is what stops the test from being satisfied
 *       by DELETING the server's account instead of hiding it.
 *
 *   M10 Left the shape alone and made `workspace-empty` say "Something went
 *       wrong." RED. The map is the one place this lane put words in the
 *       server's mouth, so it is the one place a wording check is worth having.
 */
const WORKSPACE_PATH =
  "/Users/kamilborzecki/Projects/coding-agent/dashboard/runs/run-2026-08-04T11-08-10-487Z-162b186d/workspace";
const DECLINE_DETAIL =
  `the workspace at ${WORKSPACE_PATH} holds no publishable file — 0 entries were ` +
  "excluded and nothing else was there. A run cancelled before the builder wrote " +
  "anything looks exactly like this.";

test("a refused copy stops narrating the path and keeps the server's words", async ({
  page,
}) => {
  await patchDetail(page, FINISHED_RUN_ID, (body) => {
    body["publishedProject"] = {
      published: false,
      reason: "workspace-empty",
      detail: DECLINE_DETAIL,
      attemptedAt: "2026-08-04T12:00:03.678Z",
    };
  });
  await openResult(page, FINISHED_RUN_ID);
  const panel = page.getByTestId("rail-panel");

  // The short line the client owns, and the refusal's own name beside it.
  await expect(panel).toContainText("Nothing was copied");
  await expect(panel).toContainText("The run left no file worth copying.");
  await expect(panel).toContainText("workspace-empty");

  /*
   * NOT NARRATED. A shut `<details>` renders `display:none` for everything but
   * its summary, so the path is genuinely absent from the panel's text — no
   * geometry needed for this one.
   */
  expect(
    await panel.innerText(),
    "the refused block is still narrating the workspace path in prose",
  ).not.toContain(WORKSPACE_PATH);

  // And it is one click away, in the words the server actually recorded.
  await panel.getByText("What the publisher recorded").click();
  await expect(panel).toContainText(DECLINE_DETAIL);
});

/**
 * The other half of the same block: when there is NO record at all, the panel
 * says one short line, and the distinction that must never be collapsed —
 * "no record" is not "refused" — is behind the glyph rather than gone.
 *
 * This file's production header insists those two states may never be drawn the
 * same way. They are not: a refusal is a warn-toned block naming which refusal,
 * and this is a plain one. But a reader working out WHY there is nothing here
 * needs the difference, and it changes the next move — there is no publisher
 * decision to argue with, so the move is to re-publish.
 *
 * MUTATION M11, APPLIED, RED, REVERTED. Dropped the `explain` prop from the
 * `Block` call in `published-project.tsx`. RED — `locator.boundingBox` timed out
 * waiting for `explain-project-body`.
 */
test("no publish record says so once, with the distinction behind the glyph", async ({
  page,
}) => {
  await patchDetail(page, FINISHED_RUN_ID, (body) => {
    body["publishedProject"] = null;
  });
  await openResult(page, FINISHED_RUN_ID);
  const panel = page.getByTestId("rail-panel");

  await expect(panel).toContainText("No copy was recorded for this run.");

  expect(await widthOf(page, "explain-project-body")).toBeLessThan(4);
  await page.getByTestId("explain-project").click();
  await expect(page.getByTestId("explain-project-body")).toContainText(
    "This is not a refusal — there is no record either way.",
  );
  expect(await widthOf(page, "explain-project-body")).toBeGreaterThan(120);
});
