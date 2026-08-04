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
 *   3. THE OLD STACK IS GONE AND ITS FACTS ARE NOT. Deleting a surface is only
 *      safe if what it carried is still reachable, so both halves are asserted
 *      together: no "run detail" button and no run chip anywhere, AND the status,
 *      the model, the run id and Cancel all present one click into Overview.
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

test.describe("the stack that was deleted", () => {
  test("the run chip and the run-detail sheet are gone, and their facts are not", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);

    /*
     * BOTH HALVES ARE THE TEST. Deleting a surface is only safe if what it carried
     * is still reachable, and asserting only the deletion is how a fact quietly
     * leaves the product.
     *
     * MUTATION APPLIED: rendered `<RunHud … onOpenDetail={…}/>` back into the
     * floating stack in `runs/[runId]/page.tsx`. The "run detail" count went to 1
     * and this went red. Reverted.
     */
    await expect(
      page.getByRole("button", { name: "run detail" }),
      "the seven-tab run sheet's entry point is still on the page",
    ).toHaveCount(0);
    await expect(
      page.getByRole("tablist", { name: "Run detail" }),
      "the seven-tab strip is still rendered",
    ).toHaveCount(0);

    // With everything closed, no run-level facts are stacked over the canvas.
    await page.getByTestId("rail-overview").click();
    await expect(page.getByTestId("rail-panel")).toBeHidden();
    await expect(page.getByTestId("overview-this-run")).toBeHidden();

    // And one click puts every one of them back: status, model, id, and the
    // control that stops a run going wrong.
    await page.getByTestId("rail-overview").click();
    const chip = page.getByTestId("overview-this-run");
    await expect(chip).toContainText("running");
    await expect(chip).toContainText("Sonnet 4.6");
    await expect(chip).toContainText(RUN_ID);
    await expect(chip.getByRole("button", { name: "Cancel" })).toBeVisible();
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
     */
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
