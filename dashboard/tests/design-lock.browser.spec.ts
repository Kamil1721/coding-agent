/**
 * The mockup cards, in a browser, against the four shapes `RunDetail.designLock`
 * actually arrives in.
 *
 * WHAT THIS SUITE IS FOR, IN ONE SENTENCE: spec §17's diagram says "UI shows the
 * 5 mockups as clickable cards", and every failure below is a way of shipping
 * something that LOOKS like that and is not — cards that never appear, a click
 * that resumes without carrying the choice, cards that stay clickable after the
 * lock has already resolved, and the generic "waiting on input" notice
 * disappearing from runs that still need it.
 *
 * IT SERVES ITS OWN API, THROUGH `page.route`, AND TOUCHES NO SHARED FIXTURE.
 * `tests/fixtures/api-server.ts` serves one run and one replay run for the canvas
 * specs; four more parked shapes belong to this file rather than in everyone
 * else's fixture. The detail bodies are spread from the real `RUN_DETAIL`, so a
 * field added to `RunDetail` cannot leave this file compiling against a shape the
 * app no longer receives.
 *
 * THE ONE THING NO SPEC HERE CAN SEE, said plainly: whether the server ACCEPTS
 * the `chosenMockup` these cards send. `POST /api/runs/:id/resume` is faked here,
 * so what is proven is that the click carries the owner's choice on the wire —
 * not that a real `Orchestrator.resume` locks it. See this task's report; that
 * seam is measured on the server side or not at all.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { DesignLockState, RunDetail } from "../src/lib/api-types";
import { MOCKUP_LABEL } from "../src/lib/mockups";
import { RUN_DETAIL } from "./fixtures/run-fixture";

/* ------------------------------------------------------------------ */

const RUN = "harness-design-lock-run";
const WORKSPACE = "/Users/o/.dashboard/runs/harness/workspace/design-refs";
const PUBLISHED = `/Users/o/.dashboard/results/screenshots/${RUN}`;

const SECTIONS = ["hero", "selected work", "about", "contact", "footer"] as const;

/** Five mockups, published exactly the way `#recordDesignMockups` publishes them. */
const MOCKUPS = SECTIONS.map((section, index) => {
  const file = `0${String(index + 1)}-${section.replace(/ /g, "-")}.png`;
  return {
    path: `${PUBLISHED}/design-${file}`,
    label: `${MOCKUP_LABEL}${section}`,
    capturedAt: `2026-07-29T11:0${String(index)}:05.000Z`,
  };
});

/** The workspace ref the lock is taken on — deliberately NOT the published path. */
function refFor(index: number): string {
  const section = SECTIONS[index] ?? "hero";
  return `${WORKSPACE}/0${String(index + 1)}-${section.replace(/ /g, "-")}.png`;
}

/** A 1x1 PNG, so the cards resolve a real image rather than their error branch. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function detail(status: RunDetail["status"], designLock: DesignLockState | null): RunDetail {
  return { ...RUN_DETAIL, runId: RUN, status, designLock };
}

const PARKED = detail("awaiting_input", {
  awaiting: true,
  mockups: MOCKUPS,
  locked: null,
  lockedBy: null,
  reason: null,
});

/** The timeout fired: the status moved on, the cached lock record has not. */
const CLOSING = detail("queued", {
  awaiting: true,
  mockups: MOCKUPS,
  locked: null,
  lockedBy: null,
  reason: null,
});

/**
 * A DESIGN run that locked, still sitting at `awaiting_input` for an unrelated
 * reason — the shape that proves the notice is suppressed by the PARK and not by
 * the mere presence of a lock.
 */
const SETTLED = detail("awaiting_input", {
  awaiting: false,
  mockups: MOCKUPS,
  locked: refFor(1),
  lockedBy: "owner",
  reason: "chosen by the owner in the dashboard",
});

/** Parked for something that is not a design choice: no lane, no cards. */
const NO_LANE = detail("awaiting_input", null);

/* ------------------------------------------------------------------ */

interface Harness {
  /** Every body posted to the resume route, in order. `null` = no body sent. */
  readonly resumes: unknown[];
}

async function serve(page: Page, body: RunDetail): Promise<Harness> {
  const resumes: unknown[] = [];

  // ONE HANDLER, NOT SEVERAL. Playwright matches the most recently registered
  // route first, so a set of overlapping patterns would depend on declaration
  // order; switching inside one handler cannot drift that way.
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/resume")) {
      const raw = route.request().postData();
      resumes.push(raw === null ? null : JSON.parse(raw));
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return;
    }
    if (path.includes("/screenshots/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
      return;
    }
    if (path.endsWith("/events")) {
      // NOT `abort()`. A network error makes EventSource retry every three
      // seconds for the length of the test; a 204 with no event-stream type
      // fails the connection once and stays failed, so nothing reconnects
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
    if (path.endsWith("/api/models")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (path.endsWith("/api/health")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"ok":true,"claudeAuth":"ok","codexAuth":"ok"}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto(`/runs/${RUN}`);
  return { resumes };
}

const cards = (page: Page) => page.getByRole("button", { name: /^Build to the / });
const panel = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Design lock" }) });
const genericNotice = (page: Page) => page.getByText("Waiting on input", { exact: true });

/* ------------------------------------------------------------------ */

test.describe("parked on a design choice", () => {
  test("every mockup is a card, and the click carries THAT mockup", async ({ page }) => {
    const harness = await serve(page, PARKED);

    await expect(cards(page)).toHaveCount(MOCKUPS.length);
    await expect(page.getByRole("heading", { name: "Design lock" })).toBeVisible();

    // The section is the only thing about a mockup that reaches the browser, and
    // it has to be on the card: five identical thumbnails are not a choice.
    for (const section of SECTIONS) {
      await expect(panel(page).getByText(section, { exact: true })).toBeVisible();
    }

    await cards(page).nth(1).click();

    // THE ASSERTION THE WHOLE TASK EXISTS FOR. A resume that reaches the server
    // with no body is not a weaker version of this — it hands the pick to
    // `ui-designer` and records it as automatic, putting somebody else's name on
    // the owner's decision.
    await expect.poll(() => harness.resumes.length).toBe(1);
    expect(harness.resumes[0]).toEqual({ chosenMockup: MOCKUPS[1]?.path });
  });

  test("the generic waiting-on-input notice is replaced, not doubled up", async ({ page }) => {
    await serve(page, PARKED);
    await expect(cards(page)).toHaveCount(MOCKUPS.length);
    // That notice says this dashboard has no channel to answer a mid-run
    // question. On a design park the cards ARE the channel, so leaving it there
    // would be the page contradicting itself.
    await expect(genericNotice(page)).toHaveCount(0);
  });
});

test.describe("a run that is not awaiting a design choice", () => {
  test("no DESIGN lane: the page renders exactly as it did before the cards", async ({ page }) => {
    await serve(page, NO_LANE);

    // THE REGRESSION THIS SUITE IS MOST LIKELY TO CATCH. `awaiting_input` is also
    // what `reconcileOnBoot` sets for a run whose builder died with the server.
    // That run has no mockups and no question a card can answer, and its notice
    // is the only thing on the page naming its two moves.
    await expect(genericNotice(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Design lock" })).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
  });

  test("already locked: the cards are a record, and nothing on them is clickable", async ({
    page,
  }) => {
    await serve(page, SETTLED);

    await expect(page.getByRole("heading", { name: "Design lock" })).toBeVisible();
    // A card that no longer does anything is worse than no card: outside the
    // park there is no button in the tree at all, not a disabled one.
    await expect(cards(page)).toHaveCount(0);
    // And this run is still `awaiting_input` for a reason the cards cannot
    // answer, so the notice it needs is still there.
    await expect(genericNotice(page)).toBeVisible();

    // The locked one is distinguished — matched across the copy/ref path split,
    // which is the failure `design-lock.unit.spec.ts` pins at the string level.
    const locked = panel(page).locator("figure").filter({ hasText: "selected work" });
    await expect(locked).toHaveCount(1);
    await expect(locked.getByText("locked", { exact: true })).toBeVisible();
    await expect(panel(page).getByText("locked", { exact: true })).toHaveCount(1);
  });

  test("the window closed while the page was open: the cards stop offering", async ({ page }) => {
    await serve(page, CLOSING);

    // §17.3 rule 1's other half. The timeout fires server-side, the run moves to
    // `queued` over SSE, and the cached lock still reads `{awaiting: true,
    // locked: null}` until the next REST read. A card that keeps taking clicks in
    // that window sends a choice the run has already made without it.
    await expect(page.getByRole("heading", { name: "Design lock" })).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
  });
});
