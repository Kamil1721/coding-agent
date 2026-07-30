/**
 * The model dropdown, in a browser, against the two things it would be easy to
 * ship broken.
 *
 * THE FIRST IS THE ONE THIS FILE EXISTS FOR: A PICKER THAT RENDERS AND DOES NOT
 * PICK. Every assertion about the list — options present, roles correct, a label
 * on the trigger — can pass on a control that submits the default model no matter
 * what was clicked. So the load-bearing assertions here are all on the body of
 * `POST /api/runs`, captured off the wire: choose the third model, submit, and the
 * request must carry the THIRD model's id. Nothing else proves the control is
 * wired to the form.
 *
 * THE SECOND IS A REFUSAL THAT ISN'T ONE. `ModelOption.available: false` has to
 * mean "cannot be chosen", not "looks different and is chosen anyway". Both
 * routes into it are exercised — click and Enter — and both are checked the same
 * way: the trigger's text is unchanged AND the submitted body still names the
 * model that was already selected.
 *
 * A THIRD THING, CHEAP TO GET WRONG AND SILENT WHEN IT IS: this control lives
 * inside the ticket `<form>`, and Enter on a `<button>` in a form submits it. So
 * "Enter selected a model" is asserted together with "and nothing was posted".
 *
 * IT SERVES ITS OWN API THROUGH `page.route` AND TOUCHES NO SHARED FIXTURE, for
 * the same reason `design-lock.browser.spec.ts` does: the shared fixture serves
 * one model and one run for the canvas specs, and a catalog with a deliberately
 * unavailable row in it belongs to this file.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ModelOption } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const CREATED_RUN = "harness-picker-run";

const NO_LOGIN =
  "Claude CLI reports no authenticated session. Run `claude setup-token` in a terminal.";

/**
 * Four rows, and the ORDER IS PART OF THE FIXTURE.
 *
 * The unavailable row is LAST so that `pickDefaultModel` (page.tsx) resolves to
 * `sonnet` deterministically and the disabled row is not the one a fresh
 * `ArrowDown` would land on — otherwise a passing "cannot be chosen" test could
 * be an artefact of nothing ever reaching that row.
 *
 * MIXED AVAILABILITY IS A CONTRACT CASE, NOT A PRODUCTION SNAPSHOT. Today's
 * catalog is all-or-nothing: logged in, every Anthropic row is available; logged
 * out, there is one unavailable row. `ModelOption` carries `available` PER ROW,
 * the picker refuses PER ROW, and a fixture that copied the all-or-nothing shape
 * could not exercise the refusal at all. The logged-out shape is covered by its
 * own describe block below.
 */
const MODELS: readonly ModelOption[] = [
  {
    id: "sonnet",
    label: "Sonnet (claude-sonnet-5)",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
  {
    id: "opus[1m]",
    label: "Opus (1M context) (claude-opus-5[1m])",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
  {
    id: "haiku",
    label: "Haiku (claude-haiku-4-5-20251001)",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
  {
    id: "default",
    label: "Claude (CLI default model)",
    provider: "anthropic",
    tier: "included",
    available: false,
    reason: NO_LOGIN,
  },
];

/** Every row unavailable — the shape `/api/models` really returns with no login. */
const LOGGED_OUT: readonly ModelOption[] = [
  {
    id: "default",
    label: "Claude (CLI default model)",
    provider: "anthropic",
    tier: "included",
    available: false,
    reason: NO_LOGIN,
  },
];

interface Harness {
  /** Every `POST /api/runs` body, in order. Empty means nothing was submitted. */
  readonly creates: unknown[];
}

async function serve(page: Page, models: readonly ModelOption[]): Promise<Harness> {
  const creates: unknown[] = [];

  // ONE HANDLER, NOT SEVERAL — Playwright matches the most recently registered
  // route first, so overlapping patterns would depend on declaration order.
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/runs" && request.method() === "POST") {
      const raw = request.postData();
      creates.push(raw === null ? null : JSON.parse(raw));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ runId: CREATED_RUN }),
      });
      return;
    }
    if (path === "/api/runs") {
      // No recent runs: this screen is the picker and nothing else.
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (path === "/api/models") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(models),
      });
      return;
    }
    if (path === "/api/health") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"ok":true,"claudeAuth":"ok","codexAuth":"missing"}',
      });
      return;
    }
    if (path.endsWith("/events")) {
      // A 204 with no event-stream type fails the connection once and stays
      // failed. `abort()` would make EventSource retry every three seconds
      // underneath an assertion.
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path.endsWith("/graph")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes: [], edges: [], inventory: null, atSeq: 0 }),
      });
      return;
    }
    // The run the POST redirects to, so a submitted form lands somewhere real
    // instead of on an error page that could mask what was asserted before it.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...RUN_DETAIL, runId: CREATED_RUN }),
    });
  });

  await page.goto("/");
  await expect(trigger(page)).toBeVisible();
  return { creates };
}

const trigger = (page: Page) => page.getByRole("combobox", { name: "Model" });
const list = (page: Page) => page.getByRole("listbox", { name: "Model" });
const options = (page: Page) => page.getByRole("option");
const startRun = (page: Page) => page.getByRole("button", { name: "Start run" });

const TICKET = "Build a one-page site for a bike shop.";

/** Fill the brief, so the submit button is not blocked by the OTHER precondition. */
async function writeTicket(page: Page): Promise<void> {
  await page.locator("textarea").fill(TICKET);
}

/**
 * The WHOLE body `POST /api/runs` should carry for a given model.
 *
 * Asserted entire rather than by picking `modelId` out of it: `designLock: "ask"`
 * is set by `src/lib/api.ts` and is what makes a dashboard submission interactive
 * (spec section 17.3 rule 2). A field silently disappearing from this request would
 * park every web-UI run and auto-lock the first mockup, and no assertion about the
 * model would notice.
 */
function bodyFor(modelId: string): unknown {
  return { designLock: "ask", ticketText: TICKET, modelId, deploy: false };
}

/* ------------------------------------------------------------------ */
/* closed, open, and what the trigger says                             */
/* ------------------------------------------------------------------ */

test("closed by default, and the trigger names the selected model", async ({ page }) => {
  await serve(page, MODELS);

  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(list(page)).toHaveCount(0);
  await expect(options(page)).toHaveCount(0);
  // The default resolved by `pickDefaultModel`, and the id as well as the label:
  // the id is the string that goes on the wire.
  await expect(trigger(page)).toContainText("Sonnet (claude-sonnet-5)");
  await expect(trigger(page)).toContainText("sonnet");
  // Nothing to explain while the selection can run.
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("opening lists EVERY model, including the one that cannot run", async ({ page }) => {
  await serve(page, MODELS);
  await trigger(page).click();

  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(list(page)).toBeVisible();
  await expect(options(page)).toHaveCount(MODELS.length);
  await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");

  // THE REASON IS PART OF THE OPTION'S ACCESSIBLE NAME, which is the whole point
  // of not using a `<select>`. Matching on the reason text through the ROLE query
  // is what proves the association: a reason rendered as a sibling line outside
  // the option would be visible on screen and absent from this name, and a test
  // that only looked for the text on the page would pass either way.
  const dead = page.getByRole("option", { name: /claude setup-token/ });
  await expect(dead).toHaveCount(1);
  await expect(dead).toHaveAttribute("aria-disabled", "true");
  await expect(dead).toContainText("unavailable");
  // The available rows carry no such attribute — without this, "aria-disabled is
  // present" could be true of every row.
  await expect(options(page).nth(0)).not.toHaveAttribute("aria-disabled", "true");
});

/* ------------------------------------------------------------------ */
/* the assertions that prove it is wired to the form                   */
/* ------------------------------------------------------------------ */

test("CLICKING a model changes the trigger AND changes what gets submitted", async ({ page }) => {
  const harness = await serve(page, MODELS);
  await writeTicket(page);

  await trigger(page).click();
  await options(page).nth(2).click();

  // Closed again, and the trigger says the new model.
  await expect(list(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText("Haiku (claude-haiku-4-5-20251001)");

  await startRun(page).click();

  await expect.poll(() => harness.creates.length).toBe(1);
  // The load-bearing line in this file. `modelId: "sonnet"` here — the default,
  // ignoring the choice — is the failure the whole suite is aimed at, and it is
  // invisible on screen.
  expect(harness.creates[0]).toEqual(bodyFor("haiku"));
});

test("THE KEYBOARD: arrows move aria-activedescendant, Enter selects, and Enter does not submit", async ({
  page,
}) => {
  const harness = await serve(page, MODELS);
  await writeTicket(page);

  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(list(page)).toBeVisible();

  // Opening puts the active option on the CURRENT selection (index 0), so one
  // more ArrowDown is index 1.
  const activeId = async (): Promise<string | null> =>
    trigger(page).getAttribute("aria-activedescendant");
  const idOf = async (index: number): Promise<string | null> =>
    options(page).nth(index).getAttribute("id");

  expect(await activeId()).toBe(await idOf(0));
  await page.keyboard.press("ArrowDown");
  expect(await activeId()).toBe(await idOf(1));
  await page.keyboard.press("End");
  expect(await activeId()).toBe(await idOf(3));
  await page.keyboard.press("Home");
  expect(await activeId()).toBe(await idOf(0));

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(list(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText("Opus (1M context) (claude-opus-5[1m])");
  // ENTER MUST NOT HAVE SUBMITTED THE FORM. This control is inside the ticket
  // form; the default action of Enter on a button in a form is submit, and a
  // dropdown that queues a run on the way to choosing a model would be the worst
  // defect this file could miss.
  expect(harness.creates).toHaveLength(0);
  // Focus came back to the trigger, so the next Tab goes forward from here rather
  // than from the top of the document.
  await expect(trigger(page)).toBeFocused();

  await startRun(page).click();
  await expect.poll(() => harness.creates.length).toBe(1);
  expect(harness.creates[0]).toEqual(bodyFor("opus[1m]"));
});

test("ESCAPE closes without committing, and returns focus", async ({ page }) => {
  const harness = await serve(page, MODELS);
  await writeTicket(page);

  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  // Active is now index 2 while the SELECTION is still index 0 — the two states
  // are distinct, which is the reason Escape has anything to undo.
  expect(await trigger(page).getAttribute("aria-activedescendant")).toBe(
    await options(page).nth(2).getAttribute("id"),
  );

  await page.keyboard.press("Escape");

  await expect(list(page)).toHaveCount(0);
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toContainText("Sonnet (claude-sonnet-5)");

  await startRun(page).click();
  await expect.poll(() => harness.creates.length).toBe(1);
  expect(harness.creates[0]).toEqual(bodyFor("sonnet"));
});

/* ------------------------------------------------------------------ */
/* the refusal                                                         */
/* ------------------------------------------------------------------ */

test("an UNAVAILABLE model cannot be chosen — not by click, not by Enter", async ({ page }) => {
  const harness = await serve(page, MODELS);
  await writeTicket(page);

  // 1. By pointer. `force: true` IS THE POINT OF THIS LINE, not a workaround:
  // Playwright's actionability check treats `aria-disabled="true"` as disabled and
  // refuses to click at all, so an unforced click would pass this test on a
  // component with no guard whatsoever — Playwright's refusal standing in for the
  // app's. Forcing it dispatches the real event and measures MY guard.
  await trigger(page).click();
  await options(page).nth(3).click({ force: true });
  await expect(trigger(page)).toContainText("Sonnet (claude-sonnet-5)");
  await expect(trigger(page)).not.toContainText("Claude (CLI default model)");

  // 2. By keyboard. The row IS reachable — that is deliberate, because the reason
  // it cannot run is inside the option and skipping the row would hide the
  // explanation from a screen-reader user — and Enter on it must still do nothing.
  await page.keyboard.press("End");
  expect(await trigger(page).getAttribute("aria-activedescendant")).toBe(
    await options(page).nth(3).getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(list(page)).toBeVisible();
  await expect(trigger(page)).toContainText("Sonnet (claude-sonnet-5)");

  await page.keyboard.press("Escape");
  await startRun(page).click();

  // AND THE WIRE AGREES. "The label did not change" alone would pass on a control
  // that quietly held the unavailable id in state and posted it.
  await expect.poll(() => harness.creates.length).toBe(1);
  expect(harness.creates[0]).toEqual(bodyFor("sonnet"));
});

/* ------------------------------------------------------------------ */
/* the logged-out screen                                               */
/* ------------------------------------------------------------------ */

test("with NO model that can run, the collapsed control still states the cause", async ({
  page,
}) => {
  const harness = await serve(page, LOGGED_OUT);
  await writeTicket(page);

  // `pickDefaultModel` finds nothing available, so there is no selection to name.
  await expect(trigger(page)).toContainText("No model selected");
  // THE REASON SURVIVES THE COLLAPSE. This is the line a dropdown loses by
  // default: the row is inside the popup, and the popup is shut.
  await expect(page.getByRole("status")).toContainText("No model in this list can run");
  await expect(page.getByRole("status")).toContainText("claude setup-token");

  await expect(startRun(page)).toBeDisabled();
  expect(harness.creates).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* the phone layout                                                    */
/* ------------------------------------------------------------------ */

test.describe("375px", () => {
  test.use({ viewport: { width: 375, height: 780 } });

  test("the open list is ON SCREEN, not below the fold", async ({ page }) => {
    await serve(page, MODELS);
    await trigger(page).scrollIntoViewIfNeeded();
    await trigger(page).click();
    await expect(list(page)).toBeVisible();

    // MEASURED AGAINST THE VIEWPORT, through `getBoundingClientRect` rather than
    // Playwright's `boundingBox()` — that one is document-relative, so it cannot
    // tell "below the fold" from "further down the page" at all.
    //
    // This is a real regression, caught in a 375px screenshot: the picker is the
    // last panel in the stacked column, and a list opening downward put four of
    // the five models past the bottom edge. `toBeVisible()` passes on that page —
    // the element has a box and is not `display:none` — which is exactly why the
    // assertion here is arithmetic on the rect.
    const rect = await list(page).evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(rect.height).toBeGreaterThan(80);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    // ONE PIXEL OF SLACK, AND IT IS SUB-PIXEL SLACK. `scrollIntoView` settles on a
    // fractional offset — measured 780.0625 against a 780 viewport — and the
    // failure this test exists for is not close: with the scroll removed, this
    // harness measured the bottom edge at 897.0625 against a 780 viewport — 117px
    // of list past the fold — so a one-pixel tolerance cannot absorb it.
    expect(rect.bottom).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  });

  test("and it still picks a model on a phone", async ({ page }) => {
    // The scroll-on-open must not break the pointer path: a list the page moved
    // under the finger would land the tap on the wrong row.
    const harness = await serve(page, MODELS);
    await writeTicket(page);
    await trigger(page).scrollIntoViewIfNeeded();
    await trigger(page).click();
    await options(page).nth(1).click();
    await expect(trigger(page)).toContainText("Opus (1M context) (claude-opus-5[1m])");

    await startRun(page).click();
    await expect.poll(() => harness.creates.length).toBe(1);
    expect(harness.creates[0]).toEqual(bodyFor("opus[1m]"));
  });
});

/* ------------------------------------------------------------------ */
/* motion                                                             */
/* ------------------------------------------------------------------ */

test("the popup animates in", async ({ page }) => {
  await serve(page, MODELS);
  await trigger(page).click();
  // The control for the reduced-motion test below: without this, that assertion
  // would pass on a popup that never animated at all.
  await expect(list(page)).toHaveCSS("animation-name", "picker-in");
});

test.describe("prefers-reduced-motion: reduce", () => {
  /*
   * `contextOptions`, NOT a bare `reducedMotion` — the same trap
   * `canvas-edges.browser.spec.ts` records. Written the bare way this compiles as
   * far as `playwright test` cares, emulates NOTHING, and the assertion below
   * measures an un-emulated browser. That is not hypothetical here: this spec was
   * written the wrong way first, `matchMedia("(prefers-reduced-motion: reduce)")`
   * came back `false` inside the emulated context, and `npm run typecheck` named
   * it with TS2353 while the suite was still calling it a CSS bug.
   */
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the popup appears at once", async ({ page }) => {
    await serve(page, MODELS);
    await trigger(page).click();
    await expect(list(page)).toBeVisible();
    // The emulation itself is asserted, not assumed: an un-emulated context would
    // make the CSS assertion below a check of the default state under a
    // reduced-motion title.
    expect(
      await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
    ).toBe(true);
    await expect(list(page)).toHaveCSS("animation-name", "none");
  });
});
