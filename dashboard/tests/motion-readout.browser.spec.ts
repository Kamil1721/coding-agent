/**
 * The motion reading, ON SCREEN — the second stage of the defect `references`
 * and `documents` shipped in on 2026-08-02.
 *
 * WHAT WENT WRONG THEN, because this file is the answer to it.
 * `contract-parity.test.ts:591-659` proves `RunDetail.motion` has the same shape
 * on the server and on the client, and it passed on the day the field went on
 * the wire with nothing in `dashboard/src` reading it. Parity is a claim about
 * two type declarations; it cannot see a renderer. So the check that the panel
 * EXISTS has to be a browser check, and it has to assert the NUMBERS rather than
 * a heading — a heading over an empty list is exactly the failure the panel is
 * forbidden from shipping.
 *
 * THREE STATES, AND THE SERVER WENT TO SOME LENGTH TO KEEP THEM APART.
 * `api-types.ts` and `http.ts#toDetail` both say it: `motion: null` is "no
 * reading was taken for this run", a spec with an EMPTY `entries` is "a page was
 * read and nothing moved inside the sampling window", and a spec with entries is
 * a reading. This panel is the first thing that can collapse them, so all three
 * are driven here and the empty one is asserted to say what it means rather than
 * to disappear into the first.
 *
 * THE FOURTH BODY IS THE ONE THAT CAN ACTUALLY GO RED. A run recorded before
 * this field existed answers with NO `motion` KEY AT ALL, and `lib/api.ts` casts
 * responses with `parsed as T` and validates nothing — so the declared type lies
 * about that payload. `motion: null` passes whether or not `sheet.tsx` flattens
 * with `?? null`; only `MISSING_KEY` below fails when the flattening is deleted.
 * `design-lock.browser.spec.ts` keeps a `LegacyDesignLock` for the same reason
 * and states the same measurement.
 *
 * THE PRESENCE-ONLY ASSERTION IS NEGATIVE ON PURPOSE. Every "the number appears"
 * assertion here is satisfied by a panel that prints every field of every entry.
 * A `parity: false` row's `durationMs` describes the SAMPLING WINDOW rather than
 * a declared animation (`ApiMotionEntry`), so printing it is inventing a
 * measurement — and the only check that notices is one that requires the number
 * to be ABSENT.
 *
 * IT SERVES ITS OWN API through `page.route` and touches no shared fixture,
 * following `design-lock`, `ticket-references` and `document-intake`: the fixture
 * server owns the canvas specs' one run, and four motion-shaped bodies belong to
 * the file that measures motion. The detail bodies are spread from the real
 * `RUN_DETAIL`, so a field added to `RunDetail` cannot leave this file compiling
 * against a shape the app no longer receives.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ApiMotionEntry, ApiMotionSpec, RunDetail } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const RUN = "harness-motion-readout-run";

/** The tabpanel `sheet.tsx` ids after the selected tab. The sheet opens here. */
const TICKET_PANEL = "#run-panel-ticket";

/** The panel's own heading. Nothing else on the Ticket tab carries this string. */
const HEADING = "Motion read from the reference";

const REFERENCE_URL = "https://gsap.com/";

function entry(over: Partial<ApiMotionEntry> = {}): ApiMotionEntry {
  return {
    family: "scroll-reveal",
    role: "div.card",
    props: ["opacity", "transform"],
    durationMs: 500,
    staggerMs: null,
    easing: "ease-out",
    iterations: 1,
    scrollRatio: null,
    parity: true,
    ...over,
  };
}

/**
 * One entry per rendering branch, and every number distinct.
 *
 * THE NUMBERS DO NOT REPEAT ACROSS ROWS, which is load-bearing rather than
 * tidy: with two 500ms rows, an assertion that "500" is on screen would pass on
 * a panel that dropped one of them. Each value below identifies its own row.
 */
const ENTRIES: readonly ApiMotionEntry[] = [
  entry({
    family: "load-entrance",
    role: "h1.hero__title",
    props: ["opacity", "transform"],
    durationMs: 650,
    easing: "ease-out",
  }),
  entry({
    family: "scroll-reveal",
    role: "div.card",
    props: ["opacity"],
    durationMs: 550,
    staggerMs: 120,
  }),
  entry({
    family: "scroll-linked",
    role: "div.parallax",
    props: ["transform"],
    durationMs: 750,
    easing: null,
    scrollRatio: 0.35,
  }),
  entry({
    family: "ambient-loop",
    role: "svg.badge",
    props: ["transform"],
    durationMs: 2_000,
    easing: "linear",
    // `null` iterations is "repeats without end", not "repeats zero times".
    iterations: null,
  }),
  entry({
    // A THIRTEENTH FAMILY. `family` is `string` on both sides deliberately so a
    // newer server can send one; a renderer that switched exhaustively would
    // blank this row instead of naming it.
    family: "aurora-wash",
    role: "div.aurora",
    props: ["filter"],
    durationMs: 1_250,
    easing: "ease-in-out",
  }),
  entry({
    // PRESENCE ONLY. 1800 is the sampling window, not an animation.
    family: "route-transition",
    role: "main.app-shell",
    props: ["opacity"],
    durationMs: 1_800,
    staggerMs: 240,
    easing: "ease-in",
    scrollRatio: 0.99,
    parity: false,
  }),
];

/** The digits of the presence-only row, which must reach no reader. */
const PRESENCE_ONLY_NUMBERS = ["1800", "1,800", "240", "0.99"] as const;

const SPEC: ApiMotionSpec = {
  url: REFERENCE_URL,
  capturedAt: "2026-08-04T09:14:22.000Z",
  entries: ENTRIES,
  libraries: ["gsap", "lenis"],
  respectsReducedMotion: false,
};

/** A page WAS read, and nothing moved while it was watched. Not `null`. */
const EMPTY_SPEC: ApiMotionSpec = {
  url: "https://example.com/still",
  capturedAt: "2026-08-04T09:20:00.000Z",
  entries: [],
  libraries: [],
  respectsReducedMotion: true,
};

const READ: RunDetail = { ...RUN_DETAIL, runId: RUN, motion: SPEC };
const NOTHING_MOVED: RunDetail = { ...RUN_DETAIL, runId: RUN, motion: EMPTY_SPEC };
const NO_REFERENCE: RunDetail = { ...RUN_DETAIL, runId: RUN, motion: null };

/**
 * A run recorded before the field existed, served with the keys it really has.
 *
 * `Omit` rather than `motion: undefined`: `exactOptionalPropertyTypes` is on and
 * `JSON.stringify` drops an explicit `undefined` anyway, so the only way to
 * state "this key is absent from the body" in a type is to remove it.
 */
type LegacyDetail = Omit<RunDetail, "motion">;

const MISSING_KEY: LegacyDetail = (() => {
  // Binding the key is how it is REMOVED, so the discarded name is the point of
  // the expression rather than an oversight.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { motion: _dropped, ...rest } = { ...RUN_DETAIL, runId: RUN };
  return rest;
})();

interface Harness {
  /** Anything the page threw during the test. Empty is the only pass. */
  readonly crashes: readonly Error[];
}

async function serve(page: Page, body: RunDetail | LegacyDetail): Promise<Harness> {
  const crashes: Error[] = [];
  // A render that throws blanks the tab, and "the panel is not there" is exactly
  // what a blank tab looks like. Both negative tests below anchor on the brief
  // as well, and this catches the throw itself.
  page.on("pageerror", (error) => crashes.push(error));

  // ONE HANDLER, NOT SEVERAL — Playwright matches the most recently registered
  // route first, so overlapping patterns would depend on declaration order.
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/messages")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"messages":[]}',
      });
      return;
    }
    if (path.endsWith("/events")) {
      // NOT `abort()`: a network error makes EventSource retry every three
      // seconds for the length of the test. A 204 with no event-stream type
      // fails the connection once and stays failed.
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
  // The sheet opens on the Ticket tab (`openRunSheet` sets it explicitly), so
  // the panel is one click away and no tab click is needed.
  await page.getByRole("button", { name: "run detail" }).click();
  await expect(ticketPanel(page)).toBeVisible();
  return { crashes };
}

const ticketPanel = (page: Page) => page.locator(TICKET_PANEL);
const motionPanel = (page: Page) =>
  ticketPanel(page)
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: HEADING }) });
/** The brief the Ticket tab always renders — the control for "the tab is alive". */
const verbatimBrief = (page: Page) => ticketPanel(page).getByText("the ticket, verbatim");

/* ------------------------------------------------------------------ */

test.describe("a ticket whose reference page was read", () => {
  test("every entry's own numbers are on the Ticket tab", async ({ page }) => {
    const harness = await serve(page, READ);
    const panel = motionPanel(page);
    await expect(panel).toHaveCount(1);

    // The address that was read, as a link — this is a URL, not a host path.
    const link = panel.getByRole("link", { name: REFERENCE_URL });
    await expect(link).toHaveAttribute("href", REFERENCE_URL);

    // Each parity row, by the number that identifies it. `about` is the register
    // `ApiMotionEntry` requires: every figure is a bucket, not a measurement.
    await expect(panel.getByText("h1.hero__title")).toBeVisible();
    await expect(panel.getByText("about 650ms")).toBeVisible();
    await expect(panel.getByText("about 550ms")).toBeVisible();
    await expect(panel.getByText("about 120ms apart")).toBeVisible();
    await expect(panel.getByText("0.35px per px scrolled")).toBeVisible();
    await expect(panel.getByText("about 2000ms")).toBeVisible();
    await expect(panel.getByText("repeating without end")).toBeVisible();
    await expect(panel.getByText("ease-out").first()).toBeVisible();

    // The properties, which are what a builder reproduces.
    await expect(panel.getByText("opacity and transform").first()).toBeVisible();

    // A family this client has never heard of is NAMED, not dropped.
    await expect(panel.getByText("aurora-wash")).toBeVisible();
    await expect(panel.getByText("about 1250ms")).toBeVisible();

    // Detected libraries, and the sentence that stops them reading as an order.
    await expect(panel.getByText("gsap, lenis")).toBeVisible();

    // `respectsReducedMotion: false` also comes out of `probeReducedMotion`'s
    // catch, so the panel may not say the page ignores the preference.
    await expect(panel.getByText(/could not be taken/)).toBeVisible();

    expect(harness.crashes, "the Ticket tab threw").toEqual([]);
  });

  test("a presence-only row says its content was not compared, and prints no figure", async ({
    page,
  }) => {
    await serve(page, READ);
    const panel = motionPanel(page);

    const row = panel.locator("li").filter({ hasText: "main.app-shell" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/NOT compared/);

    // THE ASSERTION THAT CAN FAIL. Everything above is satisfied by a panel that
    // prints every field of every entry; this one is not. 1800ms is the sampling
    // window, and 240/0.99 were never compared against anything.
    const text = (await panel.innerText()).replace(/\s+/g, " ");
    for (const digits of PRESENCE_ONLY_NUMBERS) {
      expect(text, `the presence-only row published ${digits} as if it were measured`).not.toContain(
        digits,
      );
    }
  });
});

test("a page that was read while nothing moved says so, and is not an empty list", async ({
  page,
}) => {
  const harness = await serve(page, NOTHING_MOVED);
  const panel = motionPanel(page);
  await expect(panel).toHaveCount(1);

  await expect(panel).toContainText(/nothing was observed to move/);
  // NOT the reading's verdict on reduced motion: with no observation to be about,
  // `respectsReducedMotion: true` is a fact about an empty list.
  await expect(panel.getByText(/reduced-motion preference/)).toHaveCount(0);
  // A heading over an empty list is the shape the brief rules out by name.
  await expect(panel.locator("li")).toHaveCount(0);

  expect(harness.crashes).toEqual([]);
});

test.describe("a ticket that named no motion reference", () => {
  test("`motion: null` renders no panel at all", async ({ page }) => {
    const harness = await serve(page, NO_REFERENCE);

    await expect(motionPanel(page)).toHaveCount(0);
    // The control: the tab is alive, so "no panel" is an absence rather than a
    // blank page.
    await expect(verbatimBrief(page)).toBeVisible();
    expect(harness.crashes).toEqual([]);
  });

  test("a run recorded before the field existed renders no panel and does not throw", async ({
    page,
  }) => {
    const harness = await serve(page, MISSING_KEY);

    await expect(motionPanel(page)).toHaveCount(0);
    await expect(verbatimBrief(page)).toBeVisible();
    // THE ONE TEST THAT NOTICES A DELETED `?? null` AT THE CALL SITE.
    expect(harness.crashes, "an absent `motion` key took the Ticket tab down").toEqual([]);
  });
});
