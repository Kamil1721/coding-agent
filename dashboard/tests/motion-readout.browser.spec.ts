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
 *
 * ─── RE-POINTED 2026-08-05, AND THE COPY RE-READ OFF THE COMPONENT ───
 *
 * WHERE IT MOVED. Every test here died in `serve` waiting for a button named
 * `run detail`. The 560px sheet and its seven tabs are gone; `canvas/rail.tsx`
 * put one panel behind an icon rail, and `MotionReadoutPanel` is now mounted by
 * `OverviewPanel` (`canvas/sheet.tsx:942`) — i.e. the rail entry labelled
 * **Overview**, `#rail-panel`. The "Ticket tab" of the assertion names below is
 * now the Overview panel's "What you asked for" section. NOTHING ABOUT WHAT IS
 * MEASURED CHANGED: same component, same four bodies, same three states.
 *
 * WHAT DID CHANGE IS FOUR STRINGS, and they were re-read off `run/motion.tsx`
 * rather than remembered. The prose lane rewrote the panel's own copy in the same
 * wave, so three assertions were stale and one was almost-stale:
 *
 *   · "Presence only: … its content was NOT compared" → "Seen to run. Nothing was
 *     measured about how it moves." (motion.tsx:176). The assertion that carried
 *     the load in this file is the NUMBERS one below it, which is unchanged.
 *   · "nothing was observed to move" → "This page was opened and watched, and
 *     nothing moved." (motion.tsx:297).
 *   · the empty branch's negative assertion named "reduced-motion preference",
 *     a phrase no longer on the surface in any branch. It is now `/reduced
 *     motion/i`, which is what the two reduced-motion sentences (motion.tsx:331,
 *     :332) actually say — so the absence is asserted against the wording that
 *     exists rather than against wording that could not appear whatever the
 *     component did.
 *   · "about 120ms apart" gained "across siblings" (motion.tsx:142) and still
 *     matches, because `getByText` with a string is a substring match.
 *
 * AND A CLAIM ABOUT `innerText` WAS TESTED AND FOUND FALSE, WHICH IS WORTH MORE
 * HERE THAN THE CHANGE IT WAS MEANT TO JUSTIFY. The wave's hand-off states that
 * `innerText` EXCLUDES the sr-only body of a shut `<Explain>` and that a spec
 * reading it therefore has a hole: a banned word, or a figure, one hover away and
 * unseen. This panel now has two of those bubbles, so it was measured rather than
 * believed — `parityClauses` was moved INSIDE an `<Explain>` on the presence-only
 * row and the file run both ways:
 *
 *   textContent → RED ("the presence-only row published 1800 …")
 *   innerText   → RED, on the same assertion, with the hidden clause and the
 *                 subtitle's whole bubble printed in the received string.
 *
 * So on this surface `innerText` reports a shut bubble, and the hole does not
 * exist here: `sr-only` is `clip`, not `display:none`, and a clipped element is
 * still rendered. `textContent` is kept anyway — it is the read with no layout
 * in it at all, and `innerText` additionally applies `text-transform`, which is
 * how a heading arrives UPPERCASE and quietly stops matching — but it is kept as
 * a preference, not as a repair, and nobody should cite this file as evidence for
 * the hole.
 *
 * TWO MUTATIONS TO PRODUCTION CODE, APPLIED, WATCHED AND REVERTED — 2026-08-05,
 * because a spec whose navigation was rewritten and whose assertions were never
 * watched failing is a spec that measures the click:
 *
 *   1. `run/motion.tsx:163` — the `entry.parity` branch pinned to `true`, so a
 *      presence-only row prints the sampler's figures like any other. 1 of 5 RED,
 *      the presence-only test, first at the row's own sentence.
 *   2. same file:176 — the sentence KEPT and `parityClauses(entry)` appended to
 *      it, which is the sharper version of the same defect: the row still says
 *      nothing was measured and publishes the measurement beside it. 1 of 5 RED
 *      at the digits assertion — "the presence-only row published 1800 as if it
 *      were measured". That is the assertion this file calls load-bearing, and it
 *      is the one that had to be seen failing.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ApiMotionEntry, ApiMotionSpec, RunDetail } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const RUN = "harness-motion-readout-run";

/**
 * The rail's one panel. `rail.tsx` ids it `rail-panel` and mounts exactly one
 * body inside it; this file opens Overview, which is where the run page mounts
 * `MotionReadoutPanel`.
 */
const OVERVIEW_PANEL = "#rail-panel";

/** The panel's own heading. Nothing else on Overview carries this string. */
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
  await openOverview(page);
  return { crashes };
}

/**
 * Bring the Overview panel to the front, WITHOUT ASSUMING IT IS SHUT.
 *
 * A BARE CLICK IS WRONG HERE AND IT WAS MEASURED BEING WRONG: the rail button is
 * a toggle (`rail.tsx#RailButton`, `onOpen(selected ? null : entry.id)`) and the
 * run page OPENS OVERVIEW BY DEFAULT — `openPanel` is
 * `chosenPanel !== undefined ? chosenPanel : hasQuestions && … ? "questions" :
 * "overview"` (`runs/[runId]/page.tsx`). So the first repair of this file clicked
 * the panel it wanted CLOSED and all five tests failed on a `hidden` region.
 * `aria-expanded` is the rail's own answer to "is this one open" — it is on the
 * button for a screen reader regardless — and it is read rather than assumed.
 *
 * Wrapped in `toPass` because the default is DERIVED FROM THE RUN DETAIL, which
 * arrives over a fetch: a panel opened before the body lands can be re-derived
 * out from under a bare click.
 *
 * By `data-testid`, not by accessible name: that name is the whole tooltip
 * sentence, i.e. copy, and a way-in bound to it reports an editorial change as a
 * motion regression.
 */
async function openOverview(page: Page): Promise<void> {
  const button = page.getByTestId("rail-overview");
  await expect(async () => {
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 15_000 });
  await expect(overviewPanel(page)).toBeVisible();
}

const overviewPanel = (page: Page) => page.locator(OVERVIEW_PANEL);
/**
 * The motion panel's own `<section>` — the NEAREST one around its heading.
 *
 * NOT `locator("section").filter({ has: heading })`, WHICH IS AMBIGUOUS HERE AND
 * WAS MEASURED BEING SO. On the old Ticket tab this panel was a top-level
 * section; inside Overview it is nested in `overview-ticket`
 * (`canvas/sheet.tsx`), so a `filter` on `has:` matched the wrapper AND the panel
 * and Playwright refused the locator in strict mode. Every assertion below is
 * scoped to this element and the wrapper's other sections — the brief, the
 * attachments — must not be able to satisfy them, so widening the scope to the
 * outer section would have been the wrong repair: the presence-only test asserts
 * digits are ABSENT from it, and the more of the page it covers the less that
 * says.
 */
const motionPanel = (page: Page) =>
  overviewPanel(page)
    .getByRole("heading", { name: HEADING })
    .locator("xpath=ancestor::section[1]");
/** The brief Overview always renders — the control for "the panel is alive". */
const verbatimBrief = (page: Page) => overviewPanel(page).getByText("the ticket, verbatim");

/* ------------------------------------------------------------------ */

test.describe("a ticket whose reference page was read", () => {
  test("every entry's own numbers are on the Overview panel", async ({ page }) => {
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

    /*
     * THE DETECTED LIBRARIES. The comment here used to promise "and the sentence
     * that stops them reading as an order" — that sentence ("It is not an
     * instruction to build with the same one") was deleted from `motion.tsx` on
     * 2026-08-05 and the scope now rides on the words "on the reference page" in
     * the line itself, which is why they are asserted with the names.
     */
    await expect(panel.getByText(/found on the reference page/)).toBeVisible();
    await expect(panel.getByText("gsap, lenis")).toBeVisible();

    // `respectsReducedMotion: false` also comes out of `probeReducedMotion`'s
    // catch, so the panel may not say the page ignores the preference.
    await expect(panel.getByText(/could not be taken/)).toBeVisible();

    expect(harness.crashes, "the Overview panel threw").toEqual([]);
  });

  test("a presence-only row says its content was not compared, and prints no figure", async ({
    page,
  }) => {
    await serve(page, READ);
    const panel = motionPanel(page);

    const row = panel.locator("li").filter({ hasText: "main.app-shell" });
    await expect(row).toHaveCount(1);
    /*
     * THE ROW SAYS WHAT WAS AND WAS NOT CHECKED — re-read off `motion.tsx:176`
     * after the prose lane rewrote it ("Presence only: this was observed to run,
     * and its content was NOT compared. Nothing was measured about how it moves."
     * → the two clauses below). Both halves are asserted: "seen to run" without
     * "nothing was measured" would let this row read as a measurement, and
     * "nothing was measured" without "seen to run" would read as a failed capture.
     */
    await expect(row).toContainText("Seen to run.");
    await expect(row).toContainText("Nothing was measured about how it moves.");

    /*
     * THE ASSERTION THAT CAN FAIL. Everything above is satisfied by a panel that
     * prints every field of every entry; this one is not. 1800ms is the sampling
     * window, and 240/0.99 were never compared against anything.
     *
     * `textContent`, NOT `innerText` — 2026-08-05, AND NOT FOR THE REASON THE
     * WAVE'S HAND-OFF GIVES. Measured on this panel with the figures moved behind
     * an `<Explain>`: BOTH reads report a shut bubble, so the switch closed no
     * hole (the header records the run). It is kept because `innerText` is a
     * rendered read — it applies `text-transform`, and this panel sits under an
     * uppercase heading — while `textContent` is the text the document contains,
     * which is the right subject for "this number reaches no reader".
     */
    const text = ((await panel.textContent()) ?? "").replace(/\s+/g, " ");
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

  await expect(panel).toContainText("This page was opened and watched, and nothing moved.");
  /*
   * NOT the reading's verdict on reduced motion: with no observation to be about,
   * `respectsReducedMotion: true` is a fact about an empty list.
   *
   * THE PATTERN IS `/reduced motion/i` AND THAT IS A REPAIR. It read
   * `/reduced-motion preference/`, a phrase `motion.tsx` no longer prints in
   * EITHER branch — so the absence was asserted against wording that could not
   * have appeared however the component behaved, which is a check that can only
   * observe success. Both surviving sentences (motion.tsx:331-332) contain
   * "reduced motion", so this one goes red if the verdict is drawn here.
   */
  await expect(panel.getByText(/reduced motion/i)).toHaveCount(0);
  // A heading over an empty list is the shape the brief rules out by name.
  await expect(panel.locator("li")).toHaveCount(0);

  expect(harness.crashes).toEqual([]);
});

test.describe("a ticket that named no motion reference", () => {
  test("`motion: null` renders no panel at all", async ({ page }) => {
    const harness = await serve(page, NO_REFERENCE);

    /*
     * THE CONTROL RUNS FIRST — 2026-08-09. The tab being alive is what makes
     * "no panel" an absence rather than a blank page, and it used to be asserted
     * AFTER the absence it qualifies: a page that rendered nothing at all
     * satisfied the count-0 and only tripped one line later. The order is the
     * whole change; both assertions are the ones that were here.
     */
    await expect(verbatimBrief(page)).toBeVisible();
    await expect(motionPanel(page)).toHaveCount(0);
    expect(harness.crashes).toEqual([]);
  });

  test("a run recorded before the field existed renders no panel and does not throw", async ({
    page,
  }) => {
    const harness = await serve(page, MISSING_KEY);

    // The control before the absence, for the reason given in the test above.
    await expect(verbatimBrief(page)).toBeVisible();
    await expect(motionPanel(page)).toHaveCount(0);
    // THE ONE TEST THAT NOTICES A DELETED `?? null` AT THE CALL SITE.
    expect(harness.crashes, "an absent `motion` key took the Overview panel down").toEqual([]);
  });
});
