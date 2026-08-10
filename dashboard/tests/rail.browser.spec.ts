/**
 * THE LEFT ICON RAIL — what it exposes, what each icon opens, and what it deleted.
 *
 * THE OWNER'S ASK, VERBATIM, 2026-08-04, pointing at the old left dock: "but this
 * looks terrible and needs to be changed. I suggest designing some icons with the
 * taste agent that then will sit on the left side of the canva and when I click
 * them they expand into different things. Like chat, [a screenshot of VS Code's
 * activity bar and file explorer], the index where the code structure is. Maybe
 * like a overview of the project and what has been entered. I want it userfriendly
 * and simple in terms of no jargon needs to be custom assets not from some
 * library."
 *
 * WHAT WAS THERE. A permanently-visible column down the left — run chip, `chat`
 * button, notices, the plan dialogue, the design lock — and a SECOND navigation on
 * the right: a 560px sheet with seven tabs (Ticket / Chat / Verdict / Code /
 * Agents / Run / Trace) behind a button reading "run detail".
 *
 * WHAT THIS FILE MEASURES, AND WHY EACH PART CANNOT BE DROPPED.
 *
 *   1. THE NAMES, IN ORDER. An icon-only rail is unusable and untestable through
 *      its pictures; its accessible names ARE its interface. Asserted as an exact
 *      ordered array rather than by counting buttons, because a count passes
 *      against a rail with six copies of one icon.
 *   2. WHAT EACH ICON OPENS, BY CONTENT. Every panel is asserted on a string only
 *      that panel can render — a path out of the workspace tree for Files, the
 *      fixture's own criterion for Result, the trace pane's empty sentence for
 *      Activity. `toBeVisible()` on a panel proves a box exists, which is the
 *      defect this repository is known for.
 *   3. THE CHIP AND THE PANEL ARE COMPLEMENTS. Rewritten 2026-08-09: this point
 *      used to read "no 'run detail' button and no run chip anywhere", and by
 *      then BOTH of those strings were dead — nothing in `dashboard/src` renders
 *      `role="tablist"` at all, and the chip's button says `overview`. The chip
 *      itself came back on 2026-08-09, mounted on the complement of the panel, so
 *      what is asserted now is the rule that is actually true and actually
 *      breakable: exactly ONE of the two surfaces is on screen, both directions
 *      checked, with the status / model / run id / Cancel present on whichever it
 *      is. See that test's own docblock for the three mutations.
 *   4. THE PANEL PUSHES; IT DOES NOT COVER. The owner's complaint is that the
 *      canvas is crowded out. Measured as a width difference on the flow pane plus
 *      the absence of any node under the rail.
 *   5. THE ICONS ACTUALLY PAINT. A CSS mask will not load cross-origin, and when
 *      it fails the buttons stay clickable and the rail goes blank — a silent
 *      failure. Both the computed `mask-image` AND an HTTP fetch of every URL
 *      inside it are asserted, because the computed value is the DECLARED string
 *      and stays non-`none` when the file behind it has been deleted.
 *   6. NO JARGON, scoped to the strings this change owns.
 *   7. QUESTIONS OPENS BY ITSELF on a run that is stopped waiting for an answer.
 *      This is the one that protects the owner's un-stick control.
 *
 * EVERY TEST BELOW NAMES THE MUTATION THAT REDDENS IT, and each of those mutations
 * was applied to the production file, watched go red, and reverted.
 */

import { expect, test, type Page } from "@playwright/test";

import { PLAN_RUN_ID, RUN_ID } from "./fixtures/config";

/**
 * The rail's accessible names, in rail order, on a run with no dialogue.
 *
 * `questions` is absent here BY CONSTRUCTION rather than by omission: `RUN_ID`'s
 * fixture serves no chat rows and no design lock, so there is nothing for that
 * panel to hold. Its 44px slot is still reserved — see the layout test.
 */
const NAMES = ["Overview", "Chat", "Files", "Result", "Activity"] as const;

/** The first word of each `aria-label`, which is the label the rail is named by. */
async function railNames(page: Page): Promise<string[]> {
  const labels = await page
    .getByRole("toolbar", { name: "Run panels" })
    .getByRole("button")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? ""),
    );
  return labels.map((label) => label.split(" —")[0] ?? "");
}

/**
 * Open a panel from the rail — BY KEYBOARD, and the reason is the harness rather
 * than the product.
 *
 * `next dev` mounts its own dev-tools indicator in a `<nextjs-portal>` pinned to
 * the BOTTOM-LEFT of the viewport, which is exactly where an activity-bar rail
 * pins its last entry. Playwright refuses a pointer click it would intercept
 * ("<nextjs-portal> … intercepts pointer events"), and forcing the click would
 * suppress a real overlap check as well as this fake one. Pressing the button is
 * an actual user path — every rail entry has to be operable from the keyboard
 * anyway — and it is the one that is not a fixture of the dev server. Verified on
 * the app's own dev server that nothing of OURS covers the button: at 1280x720
 * `document.elementFromPoint` on its centre returns the icon.
 */
async function openPanel(page: Page, entry: string): Promise<void> {
  await page.getByTestId(`rail-${entry}`).focus();
  await page.keyboard.press("Enter");
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
}

test.describe("the rail's interface", () => {
  test("exposes exactly these names, in this order, each with a sentence", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);

    /*
     * MUTATION APPLIED: swapped the Files and Result entries in `ENTRIES`
     * (rail.tsx). This went red on the array diff. Reverted.
     */
    expect(await railNames(page)).toEqual([...NAMES]);

    /*
     * AND EVERY ONE CARRIES A SENTENCE, on `aria-label` and on `title` alike. An
     * icon-only rail with no text affordance is a guessing game; the tooltip is
     * not polish. MUTATION APPLIED: dropped the `title` attribute from
     * `RailButton`. The second loop went red on the first entry it reached.
     * Reverted.
     */
    for (const entry of ["overview", "chat", "files", "result", "activity"]) {
      const button = page.getByTestId(`rail-${entry}`);
      const label = await button.getAttribute("aria-label");
      const title = await button.getAttribute("title");
      expect(label, `${entry} has no sentence on its accessible name`).toContain(" — ");
      expect(title, `${entry}'s tooltip does not match its accessible name`).toBe(label);
    }

    /*
     * AND THE PANEL EACH ONE OPENS IS TITLED WITH THE SAME WORD. The array above
     * reads the SENTENCE; this reads the LABEL, and they are two different fields.
     * That gap was found by running the mutation rather than by reading the test:
     * renaming `label: "Result"` back to `"Verdict"` left every assertion above
     * green, because nothing had ever looked at the word the panel is headed with.
     */
    for (const [index, entry] of ["overview", "chat", "files", "result", "activity"].entries()) {
      await openPanel(page, entry);
      await expect(page.getByTestId("rail-panel").locator("> header h2")).toHaveText(
        NAMES[index] ?? "",
      );
    }
  });

  test("announces which panel is open, on exactly one button", async ({ page }) => {
    await openRun(page, RUN_ID);

    /*
     * SELECTED MUST BE ANNOUNCED, NOT ONLY DRAWN. The accent bar, the raised
     * background and the brighter ink are paint, and a screen-reader user gets
     * none of them — five equally-named buttons with no indication of which panel
     * is open would be a worse rail than the stack it replaced.
     *
     * MUTATION APPLIED: hard-coded `aria-expanded={false}` on `RailButton`. The
     * first expectation went red — nothing expanded where one was expected.
     * Reverted.
     */
    const expanded = async (): Promise<string[]> =>
      page
        .getByRole("toolbar", { name: "Run panels" })
        .getByRole("button")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => node.getAttribute("aria-expanded") === "true")
            .map((node) => (node.getAttribute("aria-label") ?? "").split(" —")[0] ?? ""),
        );

    // Overview is the default: a run view that opens as a bare canvas does not
    // say which run it is.
    expect(await expanded()).toEqual(["Overview"]);

    await page.getByTestId("rail-files").click();
    expect(await expanded()).toEqual(["Files"]);

    // And clicking the selected one closes it, leaving none expanded.
    await page.getByTestId("rail-files").click();
    expect(await expanded()).toEqual([]);
  });

  test("every icon is a 24px mask that the server actually serves", async ({ page }) => {
    await openRun(page, RUN_ID);

    /*
     * THE FAILURE THIS EXISTS FOR IS SILENT. A CSS mask image will not load
     * cross-origin or from `file://`; when it does not load the buttons stay
     * clickable, the tooltips still work, and the rail is six empty squares.
     *
     * THE COMPUTED VALUE ALONE CANNOT CATCH IT, and that is why the fetch is here:
     * `getComputedStyle().maskImage` returns the DECLARED `image-set(…)` string
     * and stays non-`none` after the PNG behind it is deleted. MUTATION APPLIED:
     * `mv public/rail/files-48.png` aside. This went red, and it can only have been
     * the fetch that failed — nothing above it reads the file at all, which is
     * exactly the point. Reverted.
     */
    for (const entry of ["overview", "chat", "files", "result", "activity"]) {
      const icon = page.getByTestId(`rail-icon-${entry}`);
      const shape = await icon.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          mask: style.maskImage,
          webkit: style.webkitMaskImage,
          width: Math.round(box.width),
          height: Math.round(box.height),
          // The glyph is painted by the button's own colour through the mask; a
          // transparent background paints nothing whatever the mask says.
          paint: style.backgroundColor,
        };
      });
      expect(shape.mask, `${entry} has no mask`).not.toBe("none");
      expect(shape.webkit, `${entry} has no -webkit- mask`).not.toBe("none");
      expect(shape.mask, `${entry}'s mask is not this entry's asset`).toContain(
        `/rail/${entry}-`,
      );
      expect({ w: shape.width, h: shape.height }).toEqual({ w: 24, h: 24 });
      expect(shape.paint).not.toBe("rgba(0, 0, 0, 0)");

      const urls = [...shape.mask.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] ?? "");
      expect(urls.length, `${entry}'s mask names no file`).toBeGreaterThan(0);
      for (const url of urls) {
        const status = await page.evaluate(
          async (target) => (await fetch(target, { cache: "no-store" })).status,
          url,
        );
        expect(status, `${url} is not served`).toBe(200);
      }
    }
  });

  test("no rail label, tooltip or panel heading uses the old vocabulary", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);

    /*
     * "verdict", "trace" and "env" are the three words this rename deleted;
     * `seat`, `digest`, `suite` and `freeze` are the banned list the server's own
     * copy test (`server/src/graph.test.ts`) already enforces, repeated here over
     * the client strings that test cannot see. That file is not touched or
     * weakened by this one.
     *
     * SCOPED TO THE STRINGS THIS CHANGE OWNS. A whole-page scan would fail on the
     * fixture's own ticket ("Give the client a test suite") and on component copy
     * belonging to other lanes — a check that reddens on somebody else's prose
     * teaches people to delete it.
     *
     * MUTATION APPLIED: renamed `label: "Result"` back to `"Verdict"`. THE FIRST
     * VERSION OF THIS TEST STAYED GREEN THROUGH IT — see the note on the header
     * split below, and on the panel-title loop in the first test. Both were
     * rewritten until the mutation reddened them. Reverted.
     */
    const banned = /\b(verdict|trace|env|seat|digest|suite|freeze)\b/i;

    for (const entry of ["overview", "chat", "files", "result", "activity"]) {
      const label = (await page.getByTestId(`rail-${entry}`).getAttribute("aria-label")) ?? "";
      expect(label, `${entry}'s own sentence uses the old vocabulary`).not.toMatch(banned);
    }

    for (const entry of ["overview", "chat", "files", "result", "activity"]) {
      await openPanel(page, entry);
      /*
       * READ AS TWO STRINGS, NOT AS THE HEADER'S `textContent`, and finding out
       * why cost one mutation that should have been red and was not: the header's
       * text nodes concatenate to `runVerdictclose`, and `\bverdict\b` has no
       * word boundary inside a run of letters. A scan of the whole header could
       * therefore never see a one-word rename.
       *
       * `> header` and not `header`: the Files panel's own CodeBrowser has a
       * header of its own, and that copy belongs to another lane.
       */
      const header = page.getByTestId("rail-panel").locator("> header");
      const title = (await header.locator("h2").textContent()) ?? "";
      const eyebrow = (await header.locator("p").first().textContent()) ?? "";
      expect(title, `the ${entry} panel is titled with the old vocabulary`).not.toMatch(
        banned,
      );
      expect(eyebrow, `the ${entry} panel's eyebrow uses the old vocabulary`).not.toMatch(
        banned,
      );
    }
  });
});

test.describe("what each icon opens", () => {
  /*
   * CONTENT, NEVER PRESENCE. Every string below is one only its own panel can
   * render, so a rail that opened the same panel for every icon — the mutation for
   * this whole block — reddens four of the five.
   *
   * MUTATION APPLIED: `onOpen("overview")` from every rail button's click AND key
   * handler. Files, Result, Activity and Chat all went red, along with four other
   * tests in this file. Reverted.
   */
  test("Overview carries the ticket, the roster and the machine", async ({ page }) => {
    await openRun(page, RUN_ID);
    const panel = page.getByTestId("rail-panel");

    // The `ticket` tab's verbatim brief.
    await expect(panel).toContainText("Add a test suite to the dashboard client.");
    // The `agents` tab, buried into a section rather than deleted.
    await expect(page.getByTestId("overview-agents")).toContainText(
      "picking one here selects its card on the canvas",
    );
    // The `env` tab, likewise — the fixture's own inventory.
    await expect(page.getByTestId("overview-env")).toContainText("context7");
    // And the run chip's facts, which is where they went.
    await expect(page.getByTestId("overview-this-run")).toContainText("Sonnet 4.6");
    await expect(page.getByTestId("overview-this-run")).toContainText(RUN_ID);
  });

  test("Files opens the workspace index, with the tree's own paths in it", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);
    await page.getByTestId("rail-files").click();

    const panel = page.getByTestId("rail-panel");
    // Straight out of `CODE_TREE`. A Files button pointed at any other panel
    // cannot produce these.
    await expect(panel).toContainText("visible-acceptance");
    await expect(panel).toContainText("index.html");
    await expect(panel).toContainText("build.log");
  });

  test("Result opens the graded criteria, not the ticket", async ({ page }) => {
    await openRun(page, RUN_ID);
    await page.getByTestId("rail-result").click();

    const panel = page.getByTestId("rail-panel");
    await expect(panel).toContainText("npm test runs from cold.");
    // And it is NOT the ticket panel wearing a different header.
    await expect(panel).not.toContainText("Add a test suite to the dashboard client.");
  });

  test("Activity opens the event record", async ({ page }) => {
    await openRun(page, RUN_ID);
    await openPanel(page, "activity");

    // The fixture's stream opens and sends nothing, so this is the trace pane's
    // own empty sentence — a string no other panel has.
    await expect(page.getByTestId("rail-panel")).toContainText(
      "Waiting for the first event.",
    );
  });

  test("Chat opens the composer, and a typed draft survives leaving it", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);
    await page.getByTestId("rail-chat").click();

    const draft = page.getByTestId("rail-panel").getByRole("textbox").first();
    await draft.fill("do not throw this away");

    /*
     * THE DRAFT-LOSS TRAP, WHICH THE RAIL MADE WORSE BEFORE IT FIXED IT. The
     * composer's text lives in `OrchestratorChat`'s own state and that component
     * has no `value`/`onChange` pair to lift it out through. The old sheet kept
     * the chat mounted across TAB changes for exactly this reason and recorded
     * what it did not survive: closing the sheet. A rail unmounts a closed panel,
     * so the chat is mounted at the run view's level and merely hidden.
     *
     * MUTATION APPLIED: `key={String(openPanel)}` on the chat's wrapper, which
     * remounts it on every panel change exactly as a conditional mount would. The
     * refill assertion came back empty. Reverted.
     */
    await page.getByTestId("rail-files").click();
    await expect(page.getByTestId("rail-panel")).toContainText("visible-acceptance");
    await page.getByTestId("rail-chat").click();
    await expect(draft).toHaveValue("do not throw this away");

    // And it survives the panel being CLOSED, which the old sheet's version did
    // not: closing unmounted it.
    await page.getByTestId("rail-chat").click();
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    await page.getByTestId("rail-chat").click();
    await expect(draft).toHaveValue("do not throw this away");
  });
});

/**
 * Serve `RUN_ID` back to the page as a RATE-LIMITED run.
 *
 * WHY AN INTERCEPT AND NOT A FIXTURE RUN. `RUN_ID`'s detail is measured for
 * pixels by four other specs (`config.ts` says so twice) and the fixture server
 * has no rate-limited run at all, so the alternatives were a fifth fixture run
 * or a two-line rewrite of one response. The intercept touches ONLY
 * `GET /api/runs/:id`; `/graph`, `/events` and everything else still come from
 * the fixture server, so the canvas, the rail and the panels are the same ones
 * every other test in this file measures.
 *
 * `limited: true` AND a `retryAfterSec` because `RateLimitNotice` renders a
 * countdown off the second and the notice's own copy branches on it — a `null`
 * would exercise the "the provider did not say how long" arm instead, which is
 * not the arm a reader most often sees.
 */
async function openRateLimitedRun(page: Page): Promise<void> {
  await page.route(`**/api/runs/${RUN_ID}`, async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...detail,
        status: "rate_limited",
        rateLimit: { limited: true, retryAfterSec: 3_600 },
      },
    });
  });
  await openRun(page, RUN_ID);
}

test.describe("the stack that was deleted", () => {
  test("with no notice up, the run chip and the Overview panel are exact complements", async ({
    page,
  }) => {
    /*
     * RENAMED 2026-08-09 (second time), AND THE RENAME IS THE FIX. It was "…and
     * neither one can vanish", under a docblock stating "exactly one of the two
     * surfaces is on screen at a time". That is a THREE-state rule asserted as a
     * two-state one: `hudMounted = openPanel === null && notices === undefined`,
     * and `notices` is non-undefined in four situations (`preBuildOpen`, an
     * `actionError`, `rate_limited`, the awaiting-input branch). In every one of
     * those with the panel shut, NEITHER surface is on screen — so "neither one
     * can vanish" is false of the product, and this fixture (a running run with
     * no notices) simply never reaches the state that would have shown it.
     *
     * The three mutations below still reproduce and the assertions are unchanged;
     * what changed is that the name no longer claims the arm this test cannot
     * reach. The arm itself is the test directly below, on a fixture that DOES
     * reach it.
     */
    await openRun(page, RUN_ID);

    /*
     * REWRITTEN 2026-08-09, AND THE OLD VERSION IS WHY. It read:
     *
     *   getByRole("button", { name: "run detail" }).toHaveCount(0)
     *   getByRole("tablist",  { name: "Run detail" }).toHaveCount(0)
     *
     * under a docblock claiming ONE reproduced mutation as proof of BOTH. By the
     * time it was read again, neither could observe anything:
     *
     *   `grep -arn "tablist" dashboard/src` returns NOTHING. No component in this
     *   product has ever rendered that role, so that line was vacuous on the day
     *   it was written — the claimed mutation cannot have turned it red, and the
     *   docblock was crediting it with the other line's proof.
     *
     *   every hit for "run detail" in `dashboard/src` is inside a COMMENT.
     *   `run-hud.tsx:210` renders the literal `overview` now. So the first line
     *   was a dead string too — and worse, the exact mutation the old docblock
     *   said it had reproduced (`RunHud` rendered back into the run page) IS THE
     *   SHIPPED PRODUCT, and the test stayed green through it. The test's own
     *   name said the run chip was gone while the chip was on screen.
     *
     * WHAT REPLACES IT IS THE RULE THAT IS ACTUALLY TRUE, and it is a rule a
     * product change can break. `page.tsx` mounts the chip on
     * `openPanel === null && notices === undefined` — the chip and the Overview
     * panel carry the SAME five facts and the same two actions, so WITH NO NOTICE
     * UP exactly one of them is on screen. That is checked here in both
     * directions, because a one-directional check is satisfied by a product that
     * dropped one of the two surfaces entirely, which is the failure this
     * describe block was created to catch in the first place.
     *
     * THE SECOND CONJUNCT IS NOT MEASURED HERE AND MUST NOT BE CLAIMED HERE.
     * `notices === undefined` holds for the whole of this fixture's life, so
     * every assertion below is conditional on it and this test cannot observe
     * what happens when it is false. The test below reaches that state on
     * purpose.
     *
     * WHAT IS NOT ASSERTED, DELIBERATELY. There is no "the seven-tab sheet is
     * gone" assertion any more. Every string that named the sheet is now dead in
     * the product, so any such assertion is unfalsifiable by construction; the
     * rename guard below (`overview` present, "run detail" absent) is the honest
     * remainder — it fails if the old label ever comes back, because then the new
     * one is missing.
     *
     * THREE MUTATIONS APPLIED, EACH TO THE PRODUCT, EACH REVERTED. In every one
     * of them the OLD version of this test — run side by side from a temporary
     * spec file — STAYED GREEN, which is the measurement that condemned it.
     *
     *   `hudMounted = true`  -> step 1 red: "Received: 1" for `run-chip` while
     *                           the Overview panel is open.
     *   `hudMounted = false` -> step 3 red: `run-chip` "element(s) not found"
     *                           with every panel shut.
     *   run-hud.tsx's label `overview` -> `run detail` -> step 4 red: the
     *                           `overview` button is not found.
     */

    // 1. A PANEL IS OPEN, so the chip must NOT be stacked over the canvas.
    await expect(page.getByTestId("rail-panel")).toBeVisible();
    await expect(
      page.getByTestId("run-chip"),
      "the chip and the Overview panel are both on screen, saying the same five facts twice",
    ).toHaveCount(0);

    // 2. The panel is the one holding the facts while it is open: status, model,
    //    id, and the control that stops a run going wrong.
    const panelChip = page.getByTestId("overview-this-run");
    await expect(panelChip).toContainText("running");
    await expect(panelChip).toContainText("Sonnet 4.6");
    await expect(panelChip).toContainText(RUN_ID);
    await expect(panelChip.getByRole("button", { name: "Cancel" })).toBeVisible();

    // 3. SHUT THE PANEL and the other half has to appear — with the same facts
    //    and the same Cancel, at the canvas's top-left. This is the direction the
    //    old test could not check, and it is the one the owner needs: shutting the
    //    panel is the only way to get the canvas above 0.51 zoom.
    await page.getByTestId("rail-overview").click();
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    await expect(panelChip).toBeHidden();

    const chip = page.getByTestId("run-chip");
    await expect(chip, "with every panel shut the screen carries no run identity and no Cancel").toBeVisible();
    await expect(chip).toContainText(RUN_ID);
    await expect(chip.getByRole("button", { name: "Cancel" })).toBeVisible();

    // 4. THE RENAME GUARD. The chip's third button opens the Overview panel, so
    //    it is named for the panel it opens. If it ever says "run detail" again —
    //    the label of a sheet that no longer exists — the first line fails.
    await expect(
      chip.getByRole("button", { name: "overview" }),
      "the chip's panel button lost the name of the panel it opens",
    ).toBeVisible();
    await expect(chip.getByRole("button", { name: "run detail" })).toHaveCount(0);
  });

  test("with a notice up and the panel shut, both surfaces are gone and the notice carries Cancel", async ({
    page,
  }) => {
    /*
     * THE THIRD STATE, which the test above cannot reach and used to be claimed
     * by its name anyway. Added 2026-08-09 with the product fix it measures.
     *
     * WHAT IS ACTUALLY TRUE HERE, and it is worth stating plainly because it is
     * NOT the complement rule: with a notice up and the rail's panel shut,
     * NEITHER the run chip NOR the Overview panel is on screen. `hudMounted`
     * needs `notices === undefined` and this run has a notice, so the chip is
     * suppressed by design — two absolutely-positioned 360px cards in the same
     * top-left corner is not a layout.
     *
     * SO THE THING THAT MATTERS IS WHAT SURVIVES THE SUPPRESSION, and until
     * today the answer was "nothing". `page.tsx` justified suppressing the chip
     * with "`AwaitingInputNotice` and `RateLimitNotice` carry their own Cancel
     * and Resume", and `RateLimitNotice` took `{ run, onResume, busy }` — one
     * button. A rate-limited run with the panel shut therefore carried NO way to
     * stop it, which is verbatim the defect the chip was reintroduced to close
     * ("a control that stops a run does not belong behind two clicks"), back in
     * the one state where the run is stopped and the reader is deciding whether
     * to keep it. Cancel was added to that notice; this is the assertion that
     * keeps it there.
     *
     * MUTATIONS THAT REDDEN IT, each applied to production source and reverted:
     *
     *   delete the `<Button variant="danger" onClick={onCancel}>Cancel</Button>`
     *     from `RateLimitNotice`'s `actions` -> step 3 red: the Cancel control
     *     is not found, which is the pre-fix product exactly.
     *   `hudMounted = openPanel === null` (drop the notices conjunct)
     *     -> step 2 red: `run-chip` count 1 while the notice is up.
     */
    await openRateLimitedRun(page);

    // 1. THE PRECONDITION. If the intercept ever stops taking, everything below
    //    is a statement about a `running` run with no notices — which is the
    //    test above, passing again under a different name.
    const notice = page.getByText("Rate limited", { exact: false }).first();
    await expect(
      notice,
      "the rate-limited detail never reached the page, so this test is measuring the no-notice state",
    ).toBeVisible();

    // 2. Shut the panel. Now neither of the two run-identity surfaces is up —
    //    the honest three-state rule, asserted in the state that produces it.
    await page.getByTestId("rail-overview").click();
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    await expect(page.getByTestId("overview-this-run")).toHaveCount(0);
    await expect(
      page.getByTestId("run-chip"),
      "the chip is stacked under the notice in the same corner",
    ).toHaveCount(0);

    /*
     * 3. AND THE CONTROL THAT STOPS THE RUN IS STILL ON SCREEN — in the notice
     *    itself, not merely somewhere on the page. Asserted as "there is an
     *    element that contains BOTH the rate-limit title and a Cancel button",
     *    innermost first, so a Cancel that reappeared on some unrelated surface
     *    cannot stand in for the one this notice is supposed to be carrying.
     */
    const cardWithBoth = page
      .locator("div")
      .filter({ hasText: "Rate limited" })
      .filter({ has: page.getByRole("button", { name: "Cancel" }) })
      .last();
    await expect(
      cardWithBoth,
      "a rate-limited run with every panel shut carries no way to stop it",
    ).toBeVisible();

    // 4. Resume is still the primary move — the countdown says when it works,
    //    and Cancel must not have displaced it.
    await expect(page.getByRole("button", { name: /Resume/ })).toBeVisible();
  });

  test("a Cancel that FAILS does not take the last Cancel off the screen with it", async ({
    page,
  }) => {
    /*
     * THE SECOND OF THE FOUR SUPPRESSING STATES, and the nastiest, because the
     * reader reaches it by pressing the very control that then disappears.
     *
     * `actionError` is one of the four things that make `notices` non-undefined,
     * so it suppresses the run chip exactly like the rate-limit notice does — and
     * the notice it puts up was a bare `<p>` with no actions at all. So: shut the
     * panel, press the chip's Cancel, have the request fail, and the chip is
     * replaced by a card that says the action did not go through and offers
     * nothing. The one control the reader was reaching for is now behind
     * reopening a rail panel, which is the two-click hunt the chip exists to
     * remove, arrived at from the chip itself.
     *
     * IT IS ALSO NOT SELF-CLEARING: `setActionError(null)` runs at the TOP of the
     * next action, so the state persists until the reader attempts something
     * else — and the something else they want IS this.
     *
     * THE 500 IS THE PRODUCT'S OWN FAILURE PATH, not an invented one:
     * `page.tsx`'s `onCancel` catches and calls `setActionError(errorMessage(…))`.
     * Intercepting the POST is the same technique `chat-attachments.browser.spec.ts`
     * uses on the run's messages endpoint.
     *
     * MUTATION THAT REDDENS IT: delete the `actions` prop from the action-error
     * `<Notice>` in `runs/[runId]/page.tsx` — i.e. the pre-fix product — and step
     * 4 goes red with the Cancel not found.
     */
    await page.route(`**/api/runs/${RUN_ID}/cancel`, async (route) => {
      await route.fulfill({
        status: 500,
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/json",
        body: JSON.stringify({ error: "the orchestrator refused to stop this run" }),
      });
    });
    await openRun(page, RUN_ID);

    // 1. Shut the panel so the chip is the surface carrying Cancel.
    await page.getByTestId("rail-overview").click();
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    const chip = page.getByTestId("run-chip");
    await expect(chip).toBeVisible();

    // 2. Press it, and let it fail.
    await chip.getByRole("button", { name: "Cancel" }).click();

    // 3. The failure notice is up — and it has taken the chip with it, which is
    //    the behaviour this test is scoped around rather than against.
    const failure = page.getByText("That action did not go through");
    await expect(failure).toBeVisible();
    await expect(page.getByTestId("run-chip")).toHaveCount(0);

    /*
     * 4. AND CANCEL SURVIVED. Same shape as the rate-limit arm: an element that
     *    contains BOTH the failure title and a Cancel button, so a Cancel that
     *    reappeared on some unrelated surface cannot stand in for it.
     */
    const cardWithBoth = page
      .locator("div")
      .filter({ hasText: "That action did not go through" })
      .filter({ has: page.getByRole("button", { name: "Cancel" }) })
      .last();
    await expect(
      cardWithBoth,
      "a failed Cancel left the screen with no way to stop the run — reached by pressing Cancel",
    ).toBeVisible();
  });

  test("the panel pushes the canvas rather than covering it", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await openRun(page, RUN_ID);
    await expect(page.getByTestId("rail-panel")).toBeVisible();

    const paneWidth = (): Promise<number> =>
      page
        .locator(".react-flow")
        .evaluate((element) => Math.round(element.getBoundingClientRect().width));

    const withPanel = await paneWidth();
    await page.getByTestId("rail-overview").click();
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    const without = await paneWidth();

    /*
     * THE OWNER'S COMPLAINT WAS THAT THE CANVAS IS CROWDED OUT, so the panel is a
     * LAYOUT SIBLING of the flow and not something over it. 400px is the panel's
     * width; a panel that overlaid would leave the pane unchanged.
     *
     * MUTATION APPLIED: deleted the panel's `min-[1120px]:` variants, so it is
     * `absolute` at every width. The difference came back 0 and this went red.
     * Reverted.
     */
    expect(without - withPanel, "opening the panel did not resize the flow pane").toBe(
      400,
    );
    // And the canvas is still the main object: 1600 - 48 rail - 400 panel.
    expect(withPanel).toBeGreaterThanOrEqual(672);

    // Nothing the canvas draws lands under the rail.
    await page.getByTestId("rail-overview").click();
    const leftmost = await page
      .locator('[data-testid^="rf__node-"]')
      .evaluateAll((nodes) =>
        Math.min(...nodes.map((node) => node.getBoundingClientRect().left)),
      );
    expect(leftmost, "a card is drawn underneath the rail").toBeGreaterThanOrEqual(48);
  });

  test("the rail is driven by the keyboard, and Escape hands focus back", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);

    /*
     * ROVING TABINDEX: one tab stop for the whole rail, which is the selected
     * button. Six stops in a 48px column would cost six presses to Tab past it.
     */
    await page.getByTestId("rail-overview").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("rail-chat")).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByTestId("rail-activity")).toBeFocused();
    // And it wraps rather than stopping dead.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("rail-overview")).toBeFocused();

    // Enter on the entry that is ALREADY open toggles it shut, which is the
    // documented behaviour; End again and open Activity instead.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rail-panel")).toContainText(
      "Waiting for the first event.",
    );

    /*
     * MUTATION APPLIED: deleted the `focusEntry(returning)` call in
     * `onPanelKeyDown`. Focus stayed on the panel container and the last assertion
     * went red. Reverted.
     */
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    await expect(page.getByTestId("rail-activity")).toBeFocused();
  });
});

test.describe("a run that is stopped waiting on an answer", () => {
  test("Questions opens by itself, with no click, and says so on the rail", async ({
    page,
  }) => {
    await openRun(page, PLAN_RUN_ID);

    /*
     * THE ONE THAT PROTECTS THE OWNER'S UN-STICK CONTROL, and the reason is
     * written into `runs/[runId]/page.tsx` already: "A Plan panel that covered a
     * plan park would mean clicking a card on the canvas costs the owner the only
     * control that can un-stick his run." Behind an icon with no auto-open, that
     * control is one click away from a reader who does not know the icon is there
     * — the same failure by a quieter mechanism.
     *
     * MUTATION APPLIED: removed the `setOpenPanel("questions")` call from the
     * auto-open effect. The run opened on Overview and this went red. Reverted.
     */
    const panel = page.getByTestId("rail-panel");
    await expect(panel.locator("> header h2")).toHaveText("Questions");
    // The fixture's own open question, straight off the chat rows.
    await expect(panel).toContainText("How many projects should the grid show?");
    await expect(page.getByTestId("rail-questions")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    /*
     * AND THE RAIL SAYS IT WITHOUT BEING OPENED. The dot is the whole reason a
     * reader who closed the panel can still tell the run wants something.
     * MUTATION APPLIED: passed `questionsDot={null}` unconditionally from
     * `runs/[runId]/page.tsx`. This went red — the icon carried no `bg-warn`.
     * Reverted.
     */
    const dot = await page
      .getByTestId("rail-questions")
      .evaluate((button) => button.querySelector("span[aria-hidden]:last-of-type")?.className ?? "");
    expect(dot, "the Questions icon carries no attention dot on a parked run").toContain(
      "bg-warn",
    );
  });

  test("a run with nothing to ask has no Questions button, and nothing else moves", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);

    /*
     * THE CONTROL FOR THE TEST ABOVE. An entry with nothing to show is ABSENT, not
     * greyed out — no rail entry is ever disabled.
     *
     * THE RAIL IS ASSERTED PAINTED FIRST — added 2026-08-09. `openRun` waits for
     * the toolbar, which is the rail's own element, but this test's whole content
     * is "one named entry is missing from it", and an absence is only that if the
     * entries around it are on screen. Overview is the entry that is present on
     * every run there is.
     */
    await expect(page.getByTestId("rail-overview")).toBeVisible();
    await expect(page.getByTestId("rail-questions")).toHaveCount(0);

    /*
     * BUT ITS 44px SLOT IS STILL RESERVED, and that is a positional argument
     * rather than a cosmetic one: an icon-only rail lives on position memory, and
     * a rail whose icons slide 44px as a run progresses is a rail you have to read
     * every time. Measured against the same run's parked twin.
     *
     * MUTATION APPLIED: dropped the `h-11` from the Questions slot's wrapper, so
     * the slot collapses when there is no dialogue. This went red. Reverted.
     */
    const withoutQuestions = await page
      .getByTestId("rail-overview")
      .evaluate((button) => Math.round(button.getBoundingClientRect().top));

    await openRun(page, PLAN_RUN_ID);
    const withQuestions = await page
      .getByTestId("rail-overview")
      .evaluate((button) => Math.round(button.getBoundingClientRect().top));

    expect(
      withQuestions - withoutQuestions,
      "the rail's icons move when a run gains a question",
    ).toBeLessThanOrEqual(
      // Only the separator appears — 1px rule plus its 6px margins.
      13,
    );
  });
});
