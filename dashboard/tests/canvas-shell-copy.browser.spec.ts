/**
 * THE SHELL'S OWN COPY — what the rail says, and what its two panel bodies say.
 *
 * WHAT THIS LANE DID, so the assertions below read as the record of a decision
 * rather than as a list of strings. `canvas/sheet.tsx` and `canvas/rail.tsx`
 * carried 535 words of copy between them. Four paragraphs and four tooltip
 * sentences went; three facts moved behind the `<Explain>` glyph; one stayed
 * inline. This file is the guard on the last two of those, because THEY LOOK THE
 * SAME TO A WORD COUNT AND THEY ARE NOT THE SAME TO A READER:
 *
 *   a fact that was MOVED must still be reachable — if the glyph is dropped, the
 *     fact is gone and nothing on screen changes, which is how a "cleanup" loses
 *     a constraint silently;
 *   a fact that was KEPT INLINE must still be laid out as text — if somebody
 *     tidies it behind a glyph later, the reader who needed it before acting no
 *     longer gets it, and again nothing looks broken.
 *
 * WHY EVERY VISIBILITY CHECK HERE IS A MEASURED WIDTH AND NOT `toBeVisible()`.
 * `<Explain>`'s closed body is `sr-only` — absolutely positioned at 1×1 and
 * clipped, but NOT `display:none`. Playwright calls a 1×1 element VISIBLE and
 * `getByText` resolves it, so `toBeVisible()` passes on a sentence that has been
 * tidied behind the glyph. That is not reasoning, it is a measurement: with the
 * "kept inline" mutation applied — the subtitle wrapped in an `<Explain>` — this
 * file was run with `await expect(warning).toBeVisible()` in place of the width
 * assertion and PASSED. The bounding box is the only thing that tells "on
 * screen" from "hidden".
 *
 * AND WHY THE DELETION CHECK READS `textContent` RATHER THAN `innerText`, which
 * is a correction this file had to make to itself. `innerText` was expected to
 * include `sr-only` text — an isolated probe (a `sr-only` span inside a plain
 * div) returned "visible\nhiddenword", so the first version of this file scanned
 * `innerText` and said so in this docblock. Measured against the real panel it is
 * the OPPOSITE: `innerText` on the rail panel does NOT contain the roster
 * bubble's sentence and `textContent` does. So an `innerText` scan cannot tell a
 * sentence that was DELETED from one that was quietly tucked into a bubble, and
 * the deletion assertion below would have passed either way. `textContent` can,
 * and mutation 9 is the proof.
 *
 * THAT SAME MEASUREMENT IS A HOLE IN A SIBLING SPEC AND IS REPORTED AS ONE.
 * `panel-copy.browser.spec.ts` applies its banned-word list to `innerText`, so
 * any lane that moves jargon BEHIND an `<Explain>` rather than rewriting it
 * passes that guard while the word is still one hover away. Nothing in this lane
 * does that — every banned word here was rewritten, not hidden — but the guard
 * cannot currently tell the difference.
 *
 * MUTATIONS: every test below names one, and each was applied to the production
 * file, run, watched red, and reverted. The exact edits are in each test.
 */

import { expect, test, type Page } from "@playwright/test";

import { API_ORIGIN, FINISHED_RUN_ID, PLAN_RUN_ID, RUN_ID } from "./fixtures/config";

/* ------------------------------------------------------------------ */
/* Driving the rail                                                    */
/* ------------------------------------------------------------------ */

/**
 * Open a panel BY KEYBOARD, for the harness reason `rail.browser.spec.ts`
 * records: `next dev` pins a `<nextjs-portal>` badge to the bottom-left of the
 * viewport, exactly where the rail pins its last entry, and Playwright refuses a
 * pointer click it would intercept.
 *
 * Enter is a TOGGLE, so an already-open panel is left alone — Overview opens by
 * itself and pressing Enter on it would close it.
 */
async function openPanel(page: Page, entry: string): Promise<void> {
  const button = page.getByTestId(`rail-${entry}`);
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("rail-panel")).toBeVisible();
}

/**
 * Land on a run page with its rail mounted, RETRYING THE NAVIGATION rather than
 * the wait — and the difference is the whole reason this helper is four lines
 * instead of two.
 *
 * WHAT WENT WRONG, AND WHY A LONGER WAIT IS NOT THE ANSWER. Under a full-suite
 * run these three tests died here on `toolbar … element(s) not found`, and
 * "give it longer" was already the state of the file: `playwright.config.ts`
 * sets `expect.timeout` to 15_000, so the bare `toBeVisible()` this replaces
 * had ALREADY waited fifteen seconds. A wait that long does not expire because
 * the page is slow. It expires because the mount reached a state it never
 * leaves — the empty, `run === null` page whose cause `patchDetail` records
 * below. On a FINISHED run that state is FINAL: `pollIntervalFor`
 * (`use-run-stream.ts:840`) returns 0 for a terminal status, so nothing is ever
 * fetched again and the page will sit empty for as long as anyone waits. Only a
 * fresh mount can undo it, which is why the `goto` is inside the retry.
 *
 * THE PAIR THAT PROVES IT, run against a mount deliberately made to lose the
 * race — the detail response held back 1.5s for the first six seconds, which is
 * enough for the stream to empty the cache. The pre-repair body (`goto` once,
 * then wait) is RED twice out of two at the 15s mark with the reported error
 * verbatim. This body is GREEN twice out of two, and the log says why: the
 * first navigation is abandoned at 11s and the second one, past the injected
 * window, mounts the rail at ~11.6s. The delay is removed again for the run
 * that ships — see `patchDetail`, which is where the real repair is.
 *
 * THE SHAPE IS THE ONE THE SAME WAVE ADDED TO `diff-render.browser.spec.ts` and
 * `motion-readout.browser.spec.ts` — do the action, assert the state, `toPass`.
 * IT DEVIATES IN ONE PLACE, DELIBERATELY: those two guard the action with an
 * `aria-expanded` check because a rail button is a TOGGLE and acting twice would
 * undo it. `goto` is idempotent, so there is nothing to guard and a guard would
 * only add a way to skip the navigation entirely. `page.route` handlers survive
 * navigation, so a patched detail is still patched on the second attempt.
 *
 * 11s INSIDE 33s. Neither is the config default, and that is the point: with
 * the config's 15s expect timeout inside a 15s `toPass` there is room for
 * exactly one attempt and the retry is decoration. The inner window is longer
 * than a healthy mount by an order of magnitude (these tests take ~250ms each
 * once the page is up) and long enough to cover SWR's first error-retry rung at
 * ~5s, so a page that is merely slow is never navigated away from; the outer
 * one is three of those. 33s is also the ceiling — the test budget is 60s and
 * `openPanel` and a bounding box still have to happen after this call.
 *
 * ONLY THE WAY IN IS WRAPPED. Every assertion in this file is outside it, since
 * a retried assertion is one that reports a real regression as a timeout.
 */
async function openRun(page: Page, runId: string): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Run panels" });
  await expect(async () => {
    await page.goto(`/runs/${runId}`);
    await expect(toolbar).toBeVisible({ timeout: 11_000 });
  }).toPass({ timeout: 33_000 });
}

/**
 * Serve one run's detail with fields changed.
 *
 * THE HEADERS ARE WRITTEN OUT RATHER THAN COPIED, and the reason is
 * `panel-copy.browser.spec.ts`'s, verified again here by writing the shortcut
 * first: reusing `response.headers()` carries `connection`/`keep-alive`, which a
 * fulfilled response may not restate, and the page then mounts with `run ===
 * null` and NO RAIL AT ALL — so the failure reads as "the toolbar never
 * rendered" rather than as anything about copy.
 *
 * THE BODY IS FETCHED ONCE, HERE, AND NOT INSIDE THE HANDLER — and that one
 * move is the repair for the three flakes this file used to contribute to a
 * full-suite run. THE OLD SHAPE `await route.fetch()` PER REQUEST PUT A SECOND
 * ROUND TRIP IN FRONT OF EVERY DETAIL RESPONSE, and the run page cannot afford
 * one. It races its own SSE stream, and it loses badly:
 *
 *   `use-run-stream.ts:942` writes every stream event into the SWR cache with
 *   `mutate(previous => applyRunEvent(previous, event), { revalidate: false })`,
 *   and `applyRunEvent` (`:596`) is `if (previous === undefined) return
 *   undefined`. So an event that arrives BEFORE the REST detail does not queue
 *   behind it — it writes `undefined` over the cache. On a FINISHED run the
 *   stream replays every event it ever had and `pollIntervalFor` (`:840`)
 *   returns 0 for a terminal status, so once the replay has out-run the detail
 *   there is no further fetch and THE PAGE IS EMPTY FOR GOOD. That is the
 *   `run === null`, no-rail mount the paragraph above describes, reached by a
 *   second route.
 *
 * MEASURED, not deduced. With the per-request `route.fetch()` in place and this
 * file's own three tests instrumented, the bad mounts are exactly the ones whose
 * `/events` response is logged BEFORE the detail response, and they show a
 * second detail fetch (the stream's terminal `status` triggering the `mutate()`
 * at `:970`) that lands on an already-emptied cache and changes nothing. The
 * six tests in this file that do NOT go through `patchDetail` have never
 * flaked; the three that do are the three that failed. Serving a pre-fetched
 * body takes the extra trip out and the detail lands first.
 *
 * The delay is the harness's own, so this is not a production bug being papered
 * over here — but the production race is real, it is filed with this lane's
 * report, and a slow enough machine can lose it with no harness at all.
 */
async function patchDetail(
  page: Page,
  runId: string,
  patch: (body: Record<string, unknown>) => void,
): Promise<void> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${runId}`);
  const body = (await seed.json()) as Record<string, unknown>;
  patch(body);
  const payload = JSON.stringify(body);

  await page.route(
    (url) => url.pathname === `/api/runs/${runId}` && url.search === "",
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: payload,
      });
    },
  );
}

/**
 * The width below which a piece of text is not being READ by anyone.
 *
 * `sr-only` is 1px wide. A laid-out sentence in the 400px rail panel is 250px or
 * more. 120 is far enough from both that the number is not load-bearing.
 */
const LAID_OUT = 120;

/* ------------------------------------------------------------------ */
/* MOVED — the fact is behind the glyph and a reader can still get it  */
/* ------------------------------------------------------------------ */

/**
 * THE SINGLE MOST IMPORTANT TEST IN THIS LANE.
 *
 * WHAT WAS THERE: 41 words above the agent roster — "Every agent this run
 * started, in arrival order and never folded — picking one here selects its card
 * on the canvas. The canvas itself is navigable with the arrow keys; this is the
 * faster read when you already know the name."
 *
 * WHAT IT WAS SPLIT INTO. The arrow-key clause is DELETED: it is a property of
 * the canvas, discoverable by pressing an arrow key on the canvas. The rest is
 * the answer to "why is this list here when the graph is right there" — the
 * canvas folds agents into decks and this list never does — which changes WHERE
 * A READER GOES to find a missing agent. That is the "may be hidden, may never be
 * deleted" case from `explain.tsx`'s docblock, quoted here in full because this
 * lane's decisions all turn on it:
 *
 *   A FACT THAT CHANGES WHAT THE USER DOES MAY BE HIDDEN. IT MAY NEVER BE
 *   DELETED.
 */
test.describe("the agent-list fact survived being hidden", () => {
  test("shut, it is in the accessibility tree; open, it is painted", async ({ page }) => {
    await openRun(page, RUN_ID);
    await openPanel(page, "overview");

    const trigger = page.getByTestId("explain-roster");
    const body = page.getByTestId("explain-roster-body");

    /*
     * THE NAME IS PART OF THE FACT BEING REACHABLE. A screen-reader user hears
     * the button before they hear anything else about it, and sixty buttons
     * called "more info" is the wall of prose read aloud.
     */
    await expect(trigger).toHaveAttribute("aria-label", "Explain: the agent list");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    /*
     * SHUT AND STILL ANNOUNCED. `aria-describedby` points at this element at all
     * times, so a reader in browse mode — who never moves DOM focus and so never
     * opens anything — still gets the sentence.
     */
    const describedBy = await trigger.getAttribute("aria-describedby");
    expect(describedBy, "the trigger describes nothing").not.toBeNull();
    await expect(body).toHaveAttribute("id", describedBy ?? "");
    await expect(body).toContainText("the canvas folds some of these into decks");

    /* And shut means SHUT: 1px of clipped box, not a laid-out sentence. */
    const shut = await body.boundingBox();
    expect(shut?.width ?? 0, "the bubble is painted before anyone opened it").toBeLessThan(
      LAID_OUT,
    );

    /*
     * OPEN, BY THE ONE ROUTE EVERY READER HAS. Keyboard, because the rail is
     * keyboard-driven in this harness anyway and because focus-open is the path
     * a mouse-only test would never exercise.
     */
    await trigger.focus();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    const open = await body.boundingBox();
    expect(open?.width ?? 0, "the bubble did not paint when it was opened").toBeGreaterThan(
      LAID_OUT,
    );
    await expect(body).toContainText(
      "picking one here selects its card on the canvas",
    );
  });

  /*
   * MUTATION APPLIED TO `canvas/sheet.tsx`: deleted the whole `explain={...}`
   * prop from the "who worked on it" `PanelSection`. Both tests in this describe
   * went red — the first on `explain-roster` never resolving, the second on the
   * roster section not being found to have a glyph. Reverted, green.
   *
   * WHY THE SECOND TEST EXISTS AT ALL. The first one proves the glyph works. It
   * does NOT prove the glyph is attached to the roster rather than sitting in
   * some other section of a five-section panel, and an `<Explain>` about the
   * agent list mounted next to "machine and cost" would be a fact filed where
   * nobody looking for it will pass.
   */
  test("the glyph is on the roster's own heading, not loose in the panel", async ({
    page,
  }) => {
    await openRun(page, RUN_ID);
    await openPanel(page, "overview");

    const roster = page.getByTestId("overview-agents");
    await expect(roster.getByTestId("explain-roster")).toHaveCount(1);
    await expect(roster.locator("h3")).toContainText("who worked on it");

    /*
     * AND THE DELETED CLAUSE IS DELETED — `textContent`, not `innerText`, and
     * the difference is the whole assertion. `textContent` reads the closed
     * bubble too, so this is a check on the DELETE decision and not only on the
     * MOVE: a clause quietly tucked into the bubble instead of dropped fails
     * here. See the file docblock for the measurement, and mutation 9 below for
     * the proof.
     *
     * MUTATION 9 APPLIED TO `canvas/sheet.tsx`: appended " The canvas itself is
     * navigable with the arrow keys." to the roster `<Explain>`'s children —
     * hiding the deleted clause rather than deleting it. Red here. The same
     * mutation with `innerText` in place of `textContent` was GREEN, which is
     * why this line reads the way it does. Reverted.
     */
    const panel = await page.getByTestId("rail-panel").textContent();
    expect(
      panel ?? "",
      "the clause that was deleted for being a property of the canvas is back",
    ).not.toContain("navigable with the arrow keys");
    expect(panel ?? "", "the roster's old caption is back on screen").not.toContain(
      "the faster read when you already know the name",
    );
  });

  /**
   * THE OTHER MOVED FACT, AND THE ONE THAT TURNED OUT TO BE FALSE.
   *
   * "reported once, by the CLI, at the start of the run" was a second uppercase
   * mono strip under the "machine and cost" heading. Moving it behind the glyph
   * was the easy half; reading the mechanism was the half that mattered.
   * `graph_inventory` is emitted inside the per-SEGMENT `system/init` branch
   * (`server/src/builders/claude-builder.ts:1420`) and `graph.ts:960` replaces
   * `state.inventory` wholesale on each one — so it fires once per CLI session,
   * not once per run, and the panel shows the LATEST reading.
   *
   * THIS TEST ASSERTS THE CORRECTED CLAIM AND FORBIDS THE OLD ONE, because the
   * old one is the shorter and friendlier sentence and is exactly what a future
   * tidy-up would reach for.
   *
   * MUTATION 10 APPLIED TO `canvas/sheet.tsx`: put the bubble's text back to
   * "Reported once by the CLI when the run started, and not updated since."
   * Red on both assertions. Reverted.
   */
  test("the machine reading says it is the latest, not the first", async ({ page }) => {
    await openRun(page, RUN_ID);
    await openPanel(page, "overview");

    const section = page.getByTestId("overview-env");
    await expect(section.getByTestId("explain-env")).toHaveCount(1);

    const body = page.getByTestId("explain-env-body");
    await expect(body).toContainText("each time it starts a step");
    await expect(body).toContainText("the latest reading");

    const panel = (await page.getByTestId("rail-panel").textContent()) ?? "";
    expect(
      panel,
      "the panel claims one reading at the start of the run, which the emitter does not do",
    ).not.toMatch(/reported once|not updated since/i);
  });
});

/* ------------------------------------------------------------------ */
/* KEPT INLINE — and it must not be tidied away later                  */
/* ------------------------------------------------------------------ */

/**
 * A run whose usability review filed a CRITICAL finding.
 *
 * NO FIXTURE HAS ONE AND NO RUN ON THIS MACHINE EVER HAS: `sheet.tsx`'s own
 * docblock records that the lane producing `RunDetail.adversary` has never
 * executed, and `run-fixture.ts` serves `adversary: null` on every run. So the
 * only panel in this file whose copy is genuinely about a hazard has never been
 * in front of a browser check, which is precisely the condition under which the
 * "Verdict tab" sentence survived a rename that deleted the Verdict tab.
 *
 * Injected HERE rather than in the shared fixture: `run-fixture.ts` is another
 * lane's file and several specs measure these runs for pixels.
 */
async function withUsabilityFindings(page: Page): Promise<void> {
  await patchDetail(page, FINISHED_RUN_ID, (body) => {
    body["artifactPath"] = "/tmp/harness/runs/harness-finished-run/workspace";
    body["adversary"] = {
      ran: true,
      stop: "ran",
      stopDetail: "",
      reportWritten: true,
      findings: [
        {
          severity: "CRITICAL",
          klass: "logic",
          summary: "The contact form reported success on a request that returned 400.",
          detail: "",
        },
      ],
    };
  });
}

test.describe("the non-gating warning is readable without touching anything", () => {
  /**
   * THE ONE SENTENCE ON THIS PANEL THAT STAYED INLINE, and why it earned it.
   *
   * "Reported only. Nothing here changed the pass or fail above." A reader
   * looking at a CRITICAL row has ALREADY drawn the wrong conclusion by the
   * moment an `i` could have corrected him, and what he does next — go hunting
   * for the finding that failed his run — is wasted on a list that cannot move
   * `heldOutPass`, `status` or `failureReason`. Read before acting, not
   * recoverable after. That is the `KEEP INLINE` category.
   *
   * MUTATION APPLIED TO `canvas/sheet.tsx`: replaced the `subtitle` string with
   *
   *   subtitle={<Explain about="what this list is">Reported only. Nothing here
   *     changed the pass or fail above.</Explain>}
   *
   * — i.e. exactly the tidy-up this test exists to forbid. The sentence was
   * still in the DOM, still in `innerText`, and `toBeVisible()` still passed on
   * it; the WIDTH assertion went red at 1px. Reverted, green. That mutation is
   * the reason this file measures boxes instead of asking Playwright whether
   * something is visible.
   */
  test("it is laid out as text above the findings, with no click", async ({ page }) => {
    await withUsabilityFindings(page);
    await openRun(page, FINISHED_RUN_ID);
    await openPanel(page, "result");

    const panel = page.getByTestId("rail-panel");
    const warning = panel.getByText(
      "Reported only. Nothing here changed the pass or fail above.",
      { exact: true },
    );

    await expect(warning).toHaveCount(1);
    const box = await warning.boundingBox();
    expect(
      box?.width ?? 0,
      "the non-gating warning is not laid out as readable text — it has been hidden behind something",
    ).toBeGreaterThan(LAID_OUT);
    expect(box?.height ?? 0).toBeGreaterThan(8);

    /*
     * AND IT IS ABOVE THE THING IT IS WARNING ABOUT. A caveat printed under a
     * list of CRITICAL rows is a caveat read second.
     */
    const finding = panel.getByText("CRITICAL", { exact: true }).first();
    const findingBox = await finding.boundingBox();
    expect(findingBox, "the injected finding did not render").not.toBeNull();
    expect(
      box?.y ?? 0,
      "the warning sits below the findings it is warning about",
    ).toBeLessThan(findingBox?.y ?? 0);
  });

  /*
   * THE HALF OF THE SUBTITLE THAT DID MOVE, checked in the same place so the
   * split cannot rot into "all of it went behind the glyph".
   *
   * MUTATION APPLIED: deleted the `<Explain>` from the panel's `title` and left
   * the bare "Usability review" string. Red on `explain-usability`. Reverted.
   */
  test("the mechanism sentence is behind the glyph and still reachable", async ({
    page,
  }) => {
    await withUsabilityFindings(page);
    await openRun(page, FINISHED_RUN_ID);
    await openPanel(page, "result");

    const trigger = page.getByTestId("explain-usability");
    await expect(trigger).toHaveAttribute("aria-label", "Explain: the usability review");

    const body = page.getByTestId("explain-usability-body");
    await expect(body).toContainText(
      "asked what got in the way of using it",
    );

    await trigger.focus();
    const box = await body.boundingBox();
    expect(box?.width ?? 0, "the bubble did not paint").toBeGreaterThan(LAID_OUT);
  });
});

/* ------------------------------------------------------------------ */
/* The two words the owner said meant nothing to him                   */
/* ------------------------------------------------------------------ */

test.describe("Result names the folder in words a reader has", () => {
  /*
   * MUTATION APPLIED TO `canvas/sheet.tsx`: put the label back to `Artifact` and
   * deleted its `<Explain>`. Red on both halves — the heading assertion and the
   * bubble's text. Reverted.
   *
   * THIS COMMENT USED TO SAY `artifactPath` IS `null` ON EVERY HARNESS FIXTURE
   * AND THAT IS NO LONGER TRUE — `build-run-fixture.ts:613` gives the finished
   * run a real path, so the row is drawn whether or not `withUsabilityFindings`
   * patches one in. Measured, not read: with `patch()` dropped from
   * `patchDetail`, the two usability tests below went red and THIS ONE STAYED
   * GREEN. The first assertion is still worth its line — the row is conditional
   * on `sheet.tsx:1093` and this glyph lives only inside it — but it is no
   * longer the patch that keeps this test honest, and saying so would be
   * claiming a control this file does not have.
   */
  test("the row is headed Workspace, and the i says which folder to open", async ({
    page,
  }) => {
    await withUsabilityFindings(page);
    await openRun(page, FINISHED_RUN_ID);
    await openPanel(page, "result");

    const panel = page.getByTestId("rail-panel");

    /*
     * THE ANTI-VACUITY CONTROL. The row is conditional — `sheet.tsx:1093` draws
     * it only for a run with an `artifactPath` — and this glyph exists nowhere
     * else, so a panel that rendered the row is the only panel the assertions
     * below can be reading. What it does NOT prove is that the patch above did
     * anything: the finished-run fixture now carries a path of its own. See the
     * note on this test.
     */
    await expect(
      page.getByTestId("explain-workspace"),
      "the workspace row did not render, so this test measured nothing",
    ).toHaveCount(1);

    /*
     * READ AS A REGEX ON `innerText`, not as an exact-text locator, and the
     * reason is worth the line: the label span CONTAINS the `<Explain>`, whose
     * closed body is `sr-only` but still in the text — so `getByText("Workspace",
     * { exact: true })` resolves to nothing. `innerText` also applies
     * `text-transform`, so what is actually in this string is "WORKSPACE".
     */
    const rendered = await panel.innerText();
    expect(rendered, "the workspace row lost its label").toMatch(/\bworkspace\b/i);
    expect(rendered, "the word the owner named as meaningless is back").not.toMatch(
      /\bartifacts?\b/i,
    );

    /*
     * THE DISTINCTION IS THE WHOLE REASON THE ROW HAS AN `i`: both rows on this
     * panel are folders, and a reader who opens this one has opened the evidence
     * instead of the copy that was made for him.
     */
    await expect(page.getByTestId("explain-workspace-body")).toContainText(
      "The copy meant for you is the project below.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* The rail's tooltips                                                 */
/* ------------------------------------------------------------------ */

/**
 * ONE SENTENCE PER ICON, FOREVER.
 *
 * Four of the six hints carried a trailing sentence about what the reader would
 * find AFTER opening the panel — "The panel says whether it is delivered live or
 * queued", "The raw record", "Opens by itself when it is waiting on one". A
 * tooltip is the NAME of an icon; the panel is one click away and says all of it.
 *
 * THE ASSERTION IS A SENTENCE COUNT, NOT A CHARACTER BUDGET, because a character
 * budget is a number somebody raises. A second full stop is the shape of the
 * thing that came back.
 *
 * MUTATION APPLIED TO `canvas/rail.tsx`: appended " The raw record." to the
 * `activity` hint — the exact string this lane deleted. Red, naming activity and
 * printing the two-sentence label. Reverted.
 */
test.describe("no rail tooltip explains the panel it opens", () => {
  test("each of the five always-present hints is one sentence", async ({ page }) => {
    await openRun(page, RUN_ID);

    for (const entry of ["overview", "chat", "files", "result", "activity"]) {
      const label =
        (await page.getByTestId(`rail-${entry}`).getAttribute("aria-label")) ?? "";

      expect(label, `${entry} has no tooltip at all`).not.toBe("");
      expect(
        label.match(/\./g)?.length ?? 0,
        `${entry}'s tooltip is more than one sentence: "${label}"`,
      ).toBe(1);
      expect(label, `${entry}'s tooltip ends mid-thought`).toMatch(/\.$/);
    }
  });

  /*
   * Questions renders only on a parked run, so it is checked on the one fixture
   * that has a dialogue. MUTATION APPLIED: restored "Opens by itself when it is
   * waiting on one." to the `questions` hint. Red. Reverted.
   */
  test("and so is the conditional one", async ({ page }) => {
    await openRun(page, PLAN_RUN_ID);

    const label =
      (await page.getByTestId("rail-questions").getAttribute("aria-label")) ?? "";
    expect(label, "the Questions entry is absent on the parked fixture").not.toBe("");
    expect(
      label.match(/\./g)?.length ?? 0,
      `the Questions tooltip is more than one sentence: "${label}"`,
    ).toBe(1);
  });

  /*
   * AND THE TRIM DID NOT COST THE MAPPING, which is the thing the hints are for.
   * `rail.browser.spec.ts` checks that each label STARTS with the panel's word;
   * this checks the clause after the dash still describes the panel, by naming a
   * word that must be in it. A hint cut down to "Files —" would pass every
   * length rule ever written.
   *
   * MUTATION APPLIED: replaced the `files` hint with "Files — the panel."
   * Red on `workspace`. Reverted.
   */
  test("each hint still says what is behind the icon", async ({ page }) => {
    await openRun(page, RUN_ID);

    const must: readonly (readonly [string, RegExp])[] = [
      ["overview", /how this run went/i],
      ["chat", /send this run/i],
      ["files", /workspace/i],
      ["result", /whether it passed/i],
      ["activity", /every event this run sent/i],
    ];

    for (const [entry, needle] of must) {
      const label =
        (await page.getByTestId(`rail-${entry}`).getAttribute("aria-label")) ?? "";
      expect(label, `${entry}'s tooltip no longer describes its panel`).toMatch(needle);
    }
  });
});
