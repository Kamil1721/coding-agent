/**
 * readout-copy.browser.spec.ts — THE READOUT PANELS AFTER THE PROSE WAS CUT.
 *
 * WHAT THIS FILE IS FOR, in one sentence: moving a fact behind the `Explain`
 * glyph and losing it altogether must not look the same to the suite. Both end
 * with a shorter panel and a paragraph gone from the screen. Only one of them is
 * allowed, and nothing in this repository could previously tell them apart.
 *
 * THREE KINDS OF ASSERTION, AND EACH HAS A MUTATION THAT MAKES IT FAIL.
 *
 *   1. A MOVED fact is still REACHABLE. The bubble must open and must carry the
 *      words. Mutation: delete the `Explain` call site — the fact is now gone
 *      from the product and this goes red.
 *   2. A KEPT fact is still PAINTED, with no interaction. Mutation: wrap it in an
 *      `Explain` — it would still be in the DOM, still findable by `getByText`,
 *      still "visible" to Playwright, and this goes red anyway because it
 *      measures the WIDTH of the box the reader can actually read.
 *   3. A DELETED sentence is gone from the DOM ENTIRELY, `sr-only` included.
 *      Mutation: put it back. `toHaveCount(0)` over the whole panel is the check,
 *      and it is the reason `not.toContainText` is not used: a closed bubble's
 *      text IS in the panel's `innerText` for some readers and not others.
 *
 * WIDTH, NEVER `toBeVisible()` — the rule `explain.browser.spec.ts` established
 * and measured. A shut bubble is `sr-only`: 1x1 and clipped, but a real box with
 * a real bounding rect, which Playwright reports as visible. `toBeVisible()`
 * therefore passes on a hidden fact, which is precisely the mutation #2 exists to
 * catch. The signal is the width: 1px shut, hundreds open.
 *
 * IT SERVES ITS OWN API through `page.route` rather than touching the shared
 * fixture, following `motion-readout`, `design-lock` and `document-intake`. The
 * body is spread from the real `RUN_DETAIL`, so a field added to `RunDetail`
 * cannot leave this file compiling against a shape the app no longer receives.
 *
 * NINE MUTATIONS WERE APPLIED TO PRODUCTION CODE, RUN, WATCHED AND REVERTED.
 * Every one went red, and each is named with the test it took down:
 *
 *   1. Deleted the `Explain` from `motion.tsx`'s subtitle          -> test 1
 *   2. Wrapped attachments.tsx's "Not the design references under
 *      Result" sentence in an `Explain`                            -> test 5
 *   3. Deleted the `Explain` from the documents heading            -> test 2
 *   4. Deleted the `Explain` from `code-browser.tsx`'s subtitle    -> test 4
 *   5. Restored "It is not an instruction to build with the same
 *      one" to `LibrariesNote`                                     -> test 7
 *   6. Restored "…is the run's verdict to answer" to the
 *      reduced-motion line                                         -> tests 7, 8
 *   7. Wrapped "The run's workspace, read-only." in an `Explain`   -> test 6
 *   8. Replaced `usage.tsx`'s cache-hit `Explain` with a bare label -> test 3
 *   9. Deleted the `Explain` from the empty-reading branch         -> test 2
 *
 * The test numbers are declaration order, not file order; `-g` and the titles
 * are how they were actually selected.
 *
 * MUTATION 2 IS THE ONE THIS FILE WAS WRITTEN FOR. Under it the sentence was
 * still in the DOM, still matched `getByText`, still returned `toHaveCount(1)`
 * and would still have satisfied `toBeVisible()` — the shape of assertion this
 * repository defaults to. It failed on the width, and only on the width.
 *
 * MUTATIONS 1, 4 AND 8 FAIL BY TIMEOUT rather than by assertion, because
 * `widthOf` waits for an element that no longer exists. Red is red and the
 * message names the missing bubble, but the minute it costs is worth knowing
 * about before someone assumes the suite has hung.
 *
 * THE PANELS UNDER TEST ARE THE THREE THAT A SINGLE RUN CAN SHOW AT ONCE:
 * `TicketAttachmentsPanel` and `MotionReadoutPanel` on Overview, and
 * `CodeBrowser` on Files. `diff.tsx`'s notes need an agent node with an applied
 * patch and `trace.tsx`'s empty state needs a terminal run with no events;
 * neither is reachable from this fixture, and both are named in the lane's
 * hand-off rather than asserted here by something that would pass on anything.
 */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import type { Attachment, ApiMotionSpec, RunDetail } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const RUN = "harness-readout-copy-run";

const REFERENCE: Attachment = {
  file: "reference-1.png",
  path: "/tmp/harness/reference-1.png",
  sha256: "a".repeat(64),
  bytes: 12_345,
  mediaType: "image/png",
  url: `/api/runs/${RUN}/attachments/reference-1.png`,
};

const DOCUMENT: Attachment = {
  file: "document-1.pdf",
  path: "/tmp/harness/document-1.pdf",
  sha256: "b".repeat(64),
  bytes: 54_321,
  mediaType: "application/pdf",
  url: `/api/runs/${RUN}/attachments/document-1.pdf`,
};

const MOTION: ApiMotionSpec = {
  url: "https://kamilborzecki.dev/",
  capturedAt: "2026-08-04T13:08:26.000Z",
  entries: [
    {
      family: "scroll-reveal",
      role: "span.headline",
      props: ["opacity", "transform"],
      durationMs: 250,
      staggerMs: null,
      easing: null,
      iterations: 1,
      scrollRatio: null,
      parity: true,
    },
  ],
  libraries: ["gsap"],
  respectsReducedMotion: true,
};

const DETAIL: RunDetail = {
  ...RUN_DETAIL,
  runId: RUN,
  references: [REFERENCE],
  documents: [DOCUMENT],
  motion: MOTION,
  /*
   * COUNTS, BECAUSE `RUN_DETAIL` HAS `tokens: null` AND THE ROW UNDER TEST IS
   * BEHIND THAT NULL. `UsagePanel` only draws the cache hit rate when
   * `cacheHitFraction` returns a number, so a fixture with no counts renders no
   * row, no glyph, and a test that would pass on a panel that had lost both.
   */
  tokens: {
    inputTokens: 12_000,
    outputTokens: 3_400,
    cacheReadTokens: 48_000,
    cacheWriteTokens: 6_000,
  },
};

/**
 * One handler for the whole API, most-recently-registered-wins.
 *
 * The file tree is served EMPTY on purpose: the Files panel's subtitle — the
 * string this file measures — renders above the tree in either state, and an
 * empty tree keeps the panel short enough that nothing under test needs
 * scrolling into view.
 */
async function serve(page: Page, over: Partial<RunDetail> = {}): Promise<readonly Error[]> {
  const detail: RunDetail = { ...DETAIL, ...over };
  const crashes: Error[] = [];
  page.on("pageerror", (error) => crashes.push(error));

  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = async (body: string): Promise<void> => {
      await route.fulfill({ status: 200, contentType: "application/json", body });
    };

    if (path.endsWith("/messages")) return json('{"messages":[]}');
    if (path.endsWith("/graph")) {
      return json('{"nodes":[],"edges":[],"inventory":null,"atSeq":0}');
    }
    if (path.endsWith("/files")) {
      return json(
        JSON.stringify({ root: "/tmp/harness", entries: [], truncated: false, exclusions: [] }),
      );
    }
    if (path.endsWith("/api/models")) return json("[]");
    if (path.endsWith("/api/health")) {
      return json('{"ok":true,"claudeAuth":"ok","codexAuth":"ok"}');
    }
    if (path.endsWith("/events")) {
      // NOT `abort()`: a network error makes EventSource retry for the length of
      // the test. A 204 with no event-stream type fails the connection once.
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    return json(JSON.stringify(detail));
  });

  await page.goto(`/runs/${RUN}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
  return crashes;
}

/**
 * The painted width of the first match, rounded.
 *
 * `evaluate` rather than `boundingBox()` because a `sr-only` element has a box
 * and Playwright will happily report it; the number is what separates the two
 * states, not the existence of the rect.
 */
async function widthOf(locator: Locator): Promise<number> {
  return locator.first().evaluate((element) => Math.round(element.getBoundingClientRect().width));
}

/** Wait for a bubble to be painted, not merely mounted. */
async function expectPainted(locator: Locator, message: string): Promise<void> {
  await expect
    .poll(async () => widthOf(locator), { message })
    .toBeGreaterThan(100);
}

const overview = (page: Page): Locator => page.getByTestId("overview-ticket");

async function openFiles(page: Page): Promise<void> {
  await page.getByTestId("rail-files").click();
  await expect(page.getByTestId("rail-panel")).toBeVisible();
}

/* ------------------------------------------------------------------ */

test.describe("facts that moved behind the glyph are still reachable", () => {
  test("the rounding of every figure opens from the motion panel's subtitle", async ({ page }) => {
    const crashes = await serve(page);
    const body = page.getByTestId("explain-motion-body");

    /*
     * SHUT FIRST, AND THIS HALF IS THE POINT OF THE LANE. The words are in the
     * accessibility tree — `aria-describedby` names this element at all times —
     * but they are not laid out, so the panel is short. 1px is `sr-only`.
     */
    expect(await widthOf(body), "the bubble is painted before anyone asked for it").toBeLessThan(20);

    await page.getByTestId("explain-motion").click();
    await expectPainted(body, "the bubble never painted after the glyph was clicked");

    /*
     * THE CONTENT, NOT THE ELEMENT. Both figures are named: a reader who copies
     * "250ms" out of this panel into a criterion as an exact value is authoring
     * something no second reading of the page can satisfy, and this sentence is
     * the only thing in the product that says so.
     */
    await expect(body).toContainText("rounded");
    await expect(body).toContainText("50ms");
    await expect(body).toContainText("20ms");
    // And the caveat that used to be the subtitle's second sentence.
    await expect(body).toContainText("not an inventory of the page");

    expect(crashes, "the run page threw").toEqual([]);
  });

  test("an empty reading still says what it is not proof of", async ({ page }) => {
    /*
     * THE BRANCH WHERE THE CAVEAT MATTERS MOST, WHICH IS WHY IT IS DRIVEN
     * SEPARATELY. A page that was read while nothing moved renders one sentence
     * and no list, and a reader who takes that for "this page is still" has been
     * misled BY THE PANEL. The limit may be hidden; it may not be dropped.
     */
    await serve(page, {
      motion: { ...MOTION, entries: [], libraries: [], respectsReducedMotion: true },
    });
    const body = page.getByTestId("explain-still-body");

    expect(await widthOf(body)).toBeLessThan(20);
    await page.getByTestId("explain-still").click();
    await expectPainted(body, "the empty-reading bubble never painted");

    await expect(body).toContainText("not proof that the page is still");
    await expect(body).toContainText("behind a click");
  });

  test("what a changed document does to the ticket opens from the documents heading", async ({
    page,
  }) => {
    await serve(page);
    const body = page.getByTestId("explain-documents-body");

    expect(await widthOf(body)).toBeLessThan(20);
    await page.getByTestId("explain-documents").click();
    await expectPainted(body, "the documents bubble never painted");

    // The fact that changes what the reader DOES: re-uploading an edited file
    // does not amend this ticket, it starts a different one.
    await expect(body).toContainText("different ticket");
    await expect(body).toContainText("tests of its own");
  });

  test("what the cache hit rate means opens from its own label", async ({ page }) => {
    await serve(page);
    const body = page.getByTestId("explain-cache-body");

    /*
     * THIS ONE WAS A `title` ATTRIBUTE BEFORE, WHICH IS WHY IT NEEDS A TEST AT
     * ALL. A native tooltip never opens on a touchscreen and never opens on
     * keyboard focus, so the fact was reachable by exactly one input device.
     * Moving it did not shorten the panel by a word — it is the only change in
     * `usage.tsx` — and nothing would have noticed if it had been dropped.
     */
    expect(await widthOf(body)).toBeLessThan(20);
    await page.getByTestId("explain-cache").click();
    await expectPainted(body, "the cache bubble never painted");

    await expect(body).toContainText("share of the whole input side");
    await expect(body).toContainText("subscription");
  });

  test("why a file is missing from the tree opens from the Files subtitle", async ({ page }) => {
    await serve(page);
    await openFiles(page);
    const body = page.getByTestId("explain-code-body");

    expect(await widthOf(body)).toBeLessThan(20);
    await page.getByTestId("explain-code").click();
    await expectPainted(body, "the code bubble never painted");

    await expect(body).toContainText("Credential files");
    await expect(body).toContainText("redactor");
  });
});

test.describe("facts kept inline are on screen with no interaction", () => {
  test("the uploads are told apart from the generated mockups before anything is clicked", async ({
    page,
  }) => {
    await serve(page);

    /*
     * THE ONE SENTENCE ON THIS PANEL THAT MAY NEVER BE HIDDEN. A reader who
     * takes their own uploads for `ui-designer`'s mockups mis-reads every
     * judgement on the page, and there is nothing later that corrects them.
     *
     * MEASURED, NOT `toBeVisible()`. Behind a shut `Explain` this element still
     * exists, still matches `getByText`, and still passes `toBeVisible()` — the
     * mutation below is exactly that, and width is the only thing that notices.
     */
    const sentence = overview(page).getByText("Not the design references under Result");
    await expect(sentence).toHaveCount(1);
    expect(
      await widthOf(sentence),
      "the sentence separating uploads from mockups is not laid out",
    ).toBeGreaterThan(100);

    // And it still names the thing it points at, which is a panel that exists.
    await expect(sentence).toContainText("mockups");
  });

  test("the workspace says read-only without being asked", async ({ page }) => {
    await serve(page);
    await openFiles(page);

    const sentence = page.getByTestId("rail-panel").getByText("read-only");
    expect(
      await widthOf(sentence),
      "the read-only warning is not laid out where a reader can see it",
    ).toBeGreaterThan(100);
  });
});

test.describe("what was deleted is gone, sr-only included", () => {
  /**
   * `toHaveCount(0)` OVER THE PANEL, NOT `not.toContainText`.
   *
   * A shut bubble's text is in the DOM. Asserting on `innerText` would pass for
   * a sentence that had been hidden rather than removed, which is the distinction
   * this whole file exists to hold — so the check is that no node anywhere in the
   * panel carries the string, painted or not.
   */
  const GONE = [
    // Restated the clause in front of it, and answered a question this panel's
    // reader is not asking.
    "not an instruction to build with the same one",
    // Named a different panel's job, in the word the owner banned.
    "verdict to answer",
    // Described where the bytes are served from. Nothing follows from it.
    "served back from this run's own directory",
  ] as const;

  test("the motion and attachment panels carry none of the deleted sentences", async ({ page }) => {
    await serve(page);
    const panel = overview(page);
    await expect(panel).toHaveCount(1);

    for (const phrase of GONE) {
      await expect(panel.getByText(phrase), `"${phrase}" is back on the panel`).toHaveCount(0);
    }
  });

  test("no readout panel says the word the owner banned", async ({ page }) => {
    await serve(page);

    /*
     * THE WORDS ON SCREEN, INCLUDING THE ONES BEHIND THE GLYPH — `innerText` is
     * the right reading here for the opposite reason to the test above: a banned
     * word is banned wherever a reader can meet it, and a shut bubble is read
     * aloud by a screen reader in browse mode.
     */
    const text = (await overview(page).innerText()).toLowerCase();
    for (const word of ["verdict", "seat", "freeze", "digest"]) {
      expect(text, `the Overview readouts use the word "${word}"`).not.toContain(word);
    }
  });
});
