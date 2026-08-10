/**
 * WITH EVERY PANEL SHUT, THE SCREEN SAYS WHOSE RUN IT IS — and offers the one
 * control that cannot wait.
 *
 * WHAT WAS MEASURED BEFORE THIS. `run-hud.tsx` had no importer at all. The icon
 * rail took over the run chip's job and `sheet.tsx` records the handover; what
 * neither noticed is that the rail's Overview panel is CLOSEABLE, and with it
 * closed the run view carried no title, no status, no verdict, no clock and no
 * Cancel. Closing the panel is also the only way to get the canvas above 0.51
 * zoom — so stopping a run that was going wrong meant reopening a 400px panel
 * to reach the button.
 *
 * THE PAIR, AND WHY IT IS A PAIR. "The chip is there when the panel is shut"
 * would pass just as well against a chip that is ALWAYS there, which would
 * duplicate five facts and two buttons next to the panel already showing them.
 * "The chip is absent when the panel is open" would pass against a chip that was
 * never mounted — the state this file exists to end. Only both together say
 * what the change is: the chip is the panel's complement.
 *
 * AND ONE DOCUMENT, ONE HEADING, IN BOTH STATES. `runs/[runId]/page.tsx` renders
 * an `sr-only` `h1` precisely because the visible title used to come and go with
 * a panel; the chip renders an `h1` of its own with the same label. Two `h1`s is
 * the failure `prebuild-lane.browser.spec.ts` already measures for the pre-build
 * panel, so it is measured here too rather than assumed to have been thought
 * about.
 */

import { expect, test, type Page } from "@playwright/test";

import { API_ORIGIN, FINISHED_RUN_ID, RUN_ID } from "./fixtures/config";

const CHIP = "aside-less run chip";

/**
 * Open a run and land on its rail.
 *
 * The rail opens a panel by default — `overview`, or `questions` on a run that
 * parked — so every test below starts from "a panel is open".
 */
async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
  await expect(page.getByTestId("rail-panel")).toBeVisible();
}

/**
 * Toggle a rail entry BY KEYBOARD.
 *
 * `next dev` pins its badge over the bottom-left of the viewport where the
 * rail's last entry sits and Playwright refuses a pointer click it would
 * intercept; every rail entry is operable from the keyboard. The same
 * workaround is recorded in `rail.browser.spec.ts` and `result-surfaces`.
 */
async function toggleRail(page: Page, entry: string): Promise<void> {
  const button = page.getByTestId(`rail-${entry}`);
  await button.focus();
  await page.keyboard.press("Enter");
}

test.describe("the run chip is the rail panel's complement", () => {
  test("shutting the panel puts the run's identity and Cancel back on screen", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);

    /*
     * THE STATE BEFORE, AND IT IS HALF THE MEASUREMENT. While the panel is open
     * the chip must not be drawn: the panel is already carrying the status, the
     * title, the phase, the model, the clock and both buttons.
     */
    await expect(page.getByTestId("run-chip")).toHaveCount(0);
    const openHeadings = await page.locator("h1").count();
    expect(openHeadings, `${CHIP}: the document must have exactly one h1`).toBe(1);

    await toggleRail(page, "overview");
    /*
     * `toBeHidden`, NOT `toHaveCount(0)`. The panel container is always in the
     * tree — `rail.tsx` keeps it mounted and sets the HTML `hidden` attribute,
     * because the chat's half-typed draft lives in its own state and unmounting
     * throws it away. `hidden` is `display: none`, so this is still the honest
     * assertion that the panel is off the screen and out of the a11y tree.
     */
    await expect(page.getByTestId("rail-panel")).toBeHidden();

    const shown = page.getByTestId("run-chip");
    await expect(shown).toBeVisible();

    /*
     * THE FOUR THINGS THAT WERE MISSING, one assertion each rather than one
     * screenshot. The status badge, the run's own name, the clock's line and —
     * the reason this is a trust defect and not a cosmetic one — Cancel.
     */
    await expect(shown.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(shown.getByText("running", { exact: false }).first()).toBeVisible();
    await expect(shown.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(shown.getByText(RUN_ID, { exact: false })).toBeVisible();

    // Still exactly one heading: the page's `sr-only` one stood down.
    expect(await page.locator("h1").count(), `${CHIP}: still one h1 with the chip up`).toBe(
      1,
    );
  });

  test("the chip's own button reopens the panel it stands in for", async ({ page }) => {
    await openRun(page, RUN_ID);
    await toggleRail(page, "overview");
    await expect(page.getByTestId("run-chip")).toBeVisible();

    /*
     * THE BUTTON USED TO SAY "run detail" AND OPEN A SHEET THAT NO LONGER
     * EXISTS. Asserting the label as well as the effect is deliberate: a button
     * that opens the right panel under the wrong name is the defect
     * `sheet.tsx` deleted its own copy of this button over.
     */
    await page.getByTestId("run-chip").getByRole("button", { name: "overview" }).click();

    await expect(page.getByTestId("rail-panel")).toBeVisible();
    // And the chip stands down again, so nothing is said twice.
    await expect(page.getByTestId("run-chip")).toHaveCount(0);
  });

  /*
   * THE CORNER IS NOT THE CHIP'S ALONE, and this is the case the first three
   * tests could not see: all of them use runs with nothing floating.
   *
   * `orchestration-canvas.tsx` pins the notice stack to the pane's top-left at
   * `left-3` — "THE FLOATING STACK. Top-left, over the flow" — and that is
   * exactly where the chip goes. A rate-limited run is the cheapest state that
   * puts something there, and it is not a hypothetical: it is the state the
   * unattended run is most likely to park in.
   *
   * THE CHIP YIELDS RATHER THAN STACKING. Every surface in that stack is a run
   * that has STOPPED and is waiting on the reader, and `RateLimitNotice` carries
   * its own Resume — so the identity is gone for as long as the notice is up.
   *
   * "AND NOTHING ACTIONABLE IS" USED TO FOLLOW THAT SENTENCE AND IT WAS WRONG —
   * corrected 2026-08-09. `RateLimitNotice` rendered Resume and NOTHING ELSE, so
   * what this test was watching the chip take off screen included the only
   * Cancel on it. That is fixed in the product (the notice now carries Cancel
   * too) and measured in `rail.browser.spec.ts`, "with a notice up and the panel
   * shut, both surfaces are gone and the notice carries Cancel". This test
   * deliberately does NOT re-assert it: what it owns is the yield, and one
   * assertion in two files is one assertion that can rot in two places.
   *
   * THE POSITIVE HALF IS WHAT STOPS THIS BEING "the chip never renders": the
   * notice is asserted PRESENT in the same state, so a page that drew nothing at
   * all fails here rather than passing.
   */
  test("the chip yields the corner to a run that has stopped and is waiting", async ({
    page,
  }) => {
    const seed = await page.request.get(`${API_ORIGIN}/api/runs/${RUN_ID}`);
    const body = (await seed.json()) as Record<string, unknown>;
    body["status"] = "rate_limited";
    body["rateLimit"] = { limited: true, retryAfterSec: 900 };
    const payload = JSON.stringify(body);
    await page.route(
      (url) => url.pathname === `/api/runs/${RUN_ID}` && url.search === "",
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
          contentType: "application/json",
          body: payload,
        });
      },
    );

    await openRun(page, RUN_ID);
    await toggleRail(page, "overview");
    await expect(page.getByTestId("rail-panel")).toBeHidden();

    // Something IS floating in that corner — addressed by test id, so a prose
    // pass cannot turn this control into a silent pass.
    await expect(page.getByTestId("explain-rate-limit")).toBeAttached();
    // And the chip is not under it.
    await expect(page.getByTestId("run-chip")).toHaveCount(0);
  });

  test("a finished run gets its verdict and no Cancel", async ({ page }) => {
    await openRun(page, FINISHED_RUN_ID);
    await toggleRail(page, "overview");

    const shown = page.getByTestId("run-chip");
    await expect(shown).toBeVisible();

    /*
     * THE NEGATIVE THAT MATTERS. `Cancel` is rendered on `!terminal` alone, so a
     * chip that offered it here would be offering a button the server answers
     * 409 to. The positive beside it is what stops this passing against a chip
     * that failed to render: the run's outcome is on it.
     */
    await expect(shown.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(shown.getByText("failed", { exact: false }).first()).toBeVisible();
    await expect(shown.getByRole("button", { name: "overview" })).toBeVisible();
  });
});
