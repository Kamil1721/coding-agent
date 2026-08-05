/**
 * THE DESIGN SURFACES AFTER THE PROSE CAME OFF — what a reader can still reach.
 *
 * The owner's two complaints, verbatim: "are you also clearning up these long
 * explanations for everything… If something really must have a explanation it
 * should have little i icon to when i hover over it brings it up", and "spec seat
 * audit seat freeze. These dont really mean anything to me."
 *
 * `design-lock.tsx` and `design-directions.tsx` carried 239 and 145 words of
 * permanent explanation between them. Deleting words is easy and MEASURING THAT
 * NOTHING LOAD-BEARING WENT WITH THEM is the whole job, so every test here is one
 * of three shapes:
 *
 *   1. A FACT THAT WAS MOVED behind the `i` is still reachable by a user, and is
 *      NOT on screen before they ask for it. Moving a fact and losing it must not
 *      look the same to this file — it is the reason the file exists.
 *   2. A FACT THAT WAS KEPT INLINE is on screen with no interaction at all, so a
 *      later cleanup cannot quietly demote it to a bubble.
 *   3. WHAT WAS DELETED STAYS DELETED, asserted as a count rather than as an
 *      absence of one string: the pending panel said "ui-designer picks" twice,
 *      five lines apart, and a test for "the sentence is gone" would go green on
 *      a panel that still says it twice in different words.
 *
 * EVERY TEST BELOW ASSERTS CONTENT — the sentence, or how many times it appears.
 * `toBeVisible()` on a container proves nothing here: `Explain` keeps its text in
 * the DOM as `sr-only` while shut, so a spec that merely queries for the sentence
 * passes whether or not a reader can reach it. Tests 1 and 5 therefore assert the
 * PAINTED body element (`<testId>-body`, portaled to `document.body` and only
 * rendered while open) and assert its absence beforehand.
 *
 * IT SERVES ITS OWN API through `page.route`, like `design-lock.browser.spec.ts`,
 * and touches no shared fixture.
 *
 * MUTATIONS — ALL APPLIED TO PRODUCTION CODE, RUN, WATCHED RED, REVERTED. Each is
 * named on the test it belongs to.
 */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import type {
  DesignDirectionState,
  DesignLockState,
  RunDetail,
  Screenshot,
} from "../src/lib/api-types";
import { MOCKUP_LABEL } from "../src/lib/mockups";
import { MAX_DESIGN_LOCK_TURNS, MAX_DESIGN_ON_DEMAND_RENDERS } from "./fixtures/design-caps";
import { RUN_DETAIL } from "./fixtures/run-fixture";

/* ------------------------------------------------------------------ */

const RUN = "harness-design-surfaces-run";
const WORKSPACE = "/Users/o/.dashboard/runs/harness/workspace/design-refs";
const PUBLISHED = `/Users/o/.dashboard/results/screenshots/${RUN}`;

/** A 1x1 PNG, so a card resolves a real image rather than its error branch. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const LEGACY_SECTIONS = ["hero", "selected work", "about"] as const;

const LEGACY_MOCKUPS: readonly Screenshot[] = LEGACY_SECTIONS.map((section, index) => ({
  path: `${PUBLISHED}/design-0${String(index + 1)}-${section.replace(/ /g, "-")}.png`,
  label: `${MOCKUP_LABEL}${section}`,
  capturedAt: `2026-07-29T11:0${String(index)}:05.000Z`,
}));

/**
 * THE FIVE-KEY LOCK EVERY RUN RECORDED BEFORE 2026-08-03 ANSWERS WITH, declared
 * here for the same reason `design-lock.browser.spec.ts` declares it: `lib/api.ts`
 * casts responses and validates nothing, so a fixture that helpfully fills in the
 * nine newer fields would be testing a body no run on this machine sends.
 */
interface LegacyDesignLock {
  readonly awaiting: boolean;
  readonly mockups: readonly Screenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
}

type LegacyDetail = Omit<RunDetail, "designLock"> & {
  readonly designLock: LegacyDesignLock | null;
};

/** Parked on the pre-canvass question: pick one of these five stills. */
const LEGACY_PARKED: LegacyDetail = {
  ...RUN_DETAIL,
  runId: RUN,
  status: "awaiting_input",
  designLock: {
    awaiting: true,
    mockups: LEGACY_MOCKUPS,
    locked: null,
    lockedBy: null,
    reason: null,
  },
};

/* ------------------------------------------------------------------ */
/* The canvass                                                         */
/* ------------------------------------------------------------------ */

const DIRECTION_SECTIONS = ["hero", "selected work"] as const;

function canvassShots(slug: string): readonly Screenshot[] {
  return DIRECTION_SECTIONS.map((section, index) => ({
    path: `${PUBLISHED}/design-${slug}-0${String(index + 1)}-${section.replace(/ /g, "-")}.png`,
    label: `${MOCKUP_LABEL}${section}`,
    capturedAt: `2026-08-03T09:0${String(index)}:05.000Z`,
  }));
}

const DIRECTIONS: readonly DesignDirectionState[] = [
  {
    slug: "editorial-slab",
    name: "Editorial slab",
    distinction: "A magazine masthead: one enormous serif headline and a rule under it.",
    discarded: false,
    mockups: canvassShots("editorial-slab").map((shot) => shot.path),
    notes: `${WORKSPACE}/direction-editorial-slab.md`,
  },
  {
    slug: "terminal-grid",
    name: "Terminal grid",
    distinction: "Monospace on a hard 12-column grid, with no images above the fold.",
    discarded: false,
    mockups: canvassShots("terminal-grid").map((shot) => shot.path),
    notes: `${WORKSPACE}/direction-terminal-grid.md`,
  },
];

const CANVASS_MOCKUPS: readonly Screenshot[] = [
  ...canvassShots("editorial-slab"),
  ...canvassShots("terminal-grid"),
];

function canvassLock(overrides: Partial<DesignLockState> = {}): DesignLockState {
  return {
    awaiting: true,
    mockups: CANVASS_MOCKUPS,
    locked: null,
    lockedBy: null,
    reason: null,
    directions: DIRECTIONS,
    chosenDirection: null,
    chosenDirectionBy: null,
    stage: "canvass",
    turnsUsed: 0,
    turnsMax: MAX_DESIGN_LOCK_TURNS,
    rendersUsed: 0,
    rendersMax: MAX_DESIGN_ON_DEMAND_RENDERS,
    requests: [],
    ...overrides,
  };
}

function detail(status: RunDetail["status"], designLock: DesignLockState): RunDetail {
  return { ...RUN_DETAIL, runId: RUN, status, designLock };
}

const CANVASS = detail("awaiting_input", canvassLock());

/** The canvass answered and the hero locked — the settled record. */
const SETTLED = detail(
  "passed",
  canvassLock({
    awaiting: false,
    locked: `${PUBLISHED}/design-terminal-grid-01-hero.png`,
    lockedBy: "owner",
    reason: "chosen by the owner in the dashboard",
    chosenDirection: "terminal-grid",
    chosenDirectionBy: "owner",
    stage: "settled",
    directions: DIRECTIONS.map((entry) => ({
      ...entry,
      discarded: entry.slug !== "terminal-grid",
    })),
  }),
);

/* ------------------------------------------------------------------ */

async function serve(page: Page, body: RunDetail | LegacyDetail): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/resume")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return;
    }
    if (path.endsWith("/messages")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"messages":[]}',
      });
      return;
    }
    if (path.includes("/screenshots/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
      return;
    }
    if (path.endsWith("/events")) {
      // A 204 with no event-stream type fails the connection once and stays
      // failed; `abort()` would make EventSource retry under every assertion.
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
}

const panel = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Design lock" }) });

/* ------------------------------------------------------------------ */
/* PAINTED OR NOT, MEASURED — `toBeVisible()` CANNOT ANSWER THIS       */
/* ------------------------------------------------------------------ */

/**
 * TAKEN FROM `explain.browser.spec.ts`, WHICH FOUND THIS BY RUNNING IT.
 *
 * A shut `Explain` keeps its sentence in the DOM as a 1x1 clipped `sr-only`
 * span, on purpose, so `aria-describedby` can still name it for a screen reader
 * in browse mode. Playwright counts any non-empty box as visible — so
 * `toBeHidden()` on a shut bubble is red against a CORRECT component, and, far
 * worse for this file, `toBeVisible()` on an inline sentence stays GREEN after
 * somebody "tidies" it into a bubble that never paints. The first draft of this
 * spec asserted `toHaveCount(0)` on the shut body and failed for exactly that
 * reason: the element is always there.
 *
 * The box's WIDTH is the honest signal: 1px shut, hundreds painted. The
 * `visibility` gate is `Explain`'s measure-then-place frame, which is full width
 * and unpainted.
 */
async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    if (getComputedStyle(element).visibility !== "visible") return 0;
    return Math.round(element.getBoundingClientRect().width);
  });
}

/** In the accessibility tree, off the screen. */
async function expectShut(locator: Locator): Promise<void> {
  await expect
    .poll(async () => widthOf(locator), { message: "the sentence is painted on the screen" })
    .toBeLessThanOrEqual(2);
}

/** On the screen, with these words in it. */
async function expectPainted(locator: Locator, text: string): Promise<void> {
  await expect(locator).toHaveText(text);
  await expect
    .poll(async () => widthOf(locator), { message: "the sentence is not painted" })
    .toBeGreaterThan(80);
}

/**
 * The comparison layer opens itself on every canvassed park. Closing it is not
 * tidying: the dock panel underneath is a DIFFERENT surface with its own copy,
 * and reading one through the other would attribute the layer's words to it.
 */
async function closeLayer(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: "Close the comparison" });
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toHaveCount(0);
}

/* ================================================================== */
/* 1. THE FACT THAT WAS MOVED                                          */
/* ================================================================== */

test.describe("a fact that was moved behind the i", () => {
  /**
   * THE MOST IMPORTANT TEST IN THIS LANE.
   *
   * The pre-canvass park's body paragraph said "Every build agent is given the
   * locked mockup, and the visual gate grades the finished site against it rather
   * than against the set", inside 46 words that also said the choice was optional
   * twice. The optional half was deleted; THIS half decides which card he clicks
   * and cannot be recovered after the click, so it went behind the `i`.
   *
   * MUTATION, APPLIED AND WATCHED RED: delete the `<Explain about="picking a
   * mockup">` element from `design-lock.tsx`, leaving the instruction line. The
   * screen still reads as a finished, tidy panel — which is exactly the failure —
   * and this test fails on the missing trigger.
   */
  test("the pre-canvass park hides what the pick decides, and hands it over on demand", async ({
    page,
  }) => {
    await serve(page, LEGACY_PARKED);

    const instruction = panel(page).getByText(
      "Pick a mockup, or let the window close and ui-designer picks.",
    );
    await expect(instruction).toBeVisible();

    // NOT ON SCREEN UNTIL IT IS ASKED FOR, and that half is measured too: an "i"
    // whose sentence was painted all along would not be a cut, and this file
    // would be describing a screen nobody has.
    const body = page.getByTestId("explain-pick-mockup-body");
    await expectShut(body);

    await page.getByTestId("explain-pick-mockup").click();

    await expectPainted(
      body,
      "The finished site is compared against the one you pick, not against the whole set.",
    );
  });

  /**
   * The canvassed park's equivalent: what the pick actually does. It is not
   * "build this image" — the direction is EXPANDED into its remaining sections
   * first, and a reader who thinks the two stills in front of him are the whole
   * deliverable is choosing on the wrong question.
   *
   * MUTATION, APPLIED AND WATCHED RED: change the sentence inside the `Explain`
   * to "The others are kept as a record of what was offered" — a true sentence
   * about a different fact. The trigger is still there and still opens; only the
   * content assertion catches it.
   */
  test("the canvassed park hides what the pick expands into, and hands it over on demand", async ({
    page,
  }) => {
    await serve(page, CANVASS);
    await closeLayer(page);

    await expect(panel(page).getByText("Pick a direction.")).toBeVisible();

    const body = page.getByTestId("explain-pick-direction-body");
    await expectShut(body);

    await page.getByTestId("explain-pick-direction").click();

    await expectPainted(
      body,
      "The rest of its sections are rendered in the direction you pick, and the site is built to it.",
    );
  });

  /**
   * The settled record's `locked` badge. This fact was on screen TWICE before —
   * as a `title` attribute on the badge (invisible to keyboard and touch) and as
   * a paragraph in the panel above it. It is now one `Explain`, on the image it
   * is about.
   *
   * MUTATION, APPLIED AND WATCHED RED: remove the `<Explain>` from the badge in
   * `design-directions.tsx`. The badge still says "locked" and the panel still
   * looks complete; nothing else on the page says what "locked" MEANS.
   */
  test("what `locked` means is reachable from the badge itself", async ({ page }) => {
    await serve(page, SETTLED);

    const body = page.getByTestId("explain-locked-image-body");
    await expectShut(body);

    await page.getByTestId("explain-locked-image").click();

    await expectPainted(body, "The finished site was compared against this one image.");
  });
});

/* ================================================================== */
/* 2. THE FACT THAT WAS KEPT INLINE                                    */
/* ================================================================== */

test.describe("a fact that was kept inline", () => {
  /**
   * THE ONE PARAGRAPH ON THESE SURFACES THAT WAS NOT ALLOWED BEHIND THE `i`.
   *
   * He is about to spend one of a capped number of image renders — "6 of 6
   * renders left" is on the line above the box — and what he cannot recover is
   * spending it on something the run will never check. `Explain`'s own rule for
   * inline copy is "a cost that is about to be spent".
   *
   * The sentence also had to be REWRITTEN rather than merely shortened: it read
   * "The acceptance suite was frozen in the spec phase…", and `suite` and `freeze`
   * are two of the words the owner named as meaningless to him.
   *
   * MUTATION, APPLIED AND WATCHED RED: wrap the sentence in an
   * `<Explain about="what asking here changes">` — the tidiest possible way to
   * lose it. Its text moves into `sr-only` and `toBeVisible()` goes false, which
   * is the whole reason this assertion is on visibility and not on presence.
   */
  test("the ask limit is on screen beside the box, with nothing to click", async ({ page }) => {
    await serve(page, CANVASS);

    // MEASURED, NOT `toBeVisible()`. The mutation this test exists for is the
    // tidy one — wrap the sentence in an `Explain` — and a wrapped sentence is a
    // 1x1 `sr-only` span that Playwright still calls visible. Width is what tells
    // "on the screen" from "in the accessibility tree".
    await expectPainted(
      page.getByText("Asking here changes what gets built, not what counts as done."),
      "Asking here changes what gets built, not what counts as done.",
    );
  });

  /**
   * The countdown's consequence. A reader who misses it does not know the park
   * resolves without him, and cannot find that out after the window closes.
   *
   * MUTATION, APPLIED AND WATCHED RED: delete the `<p>` from `ParkClock`. Every
   * other test in this file still passes.
   */
  test("what happens if he does nothing is on screen, unprompted", async ({ page }) => {
    await serve(page, CANVASS);
    await closeLayer(page);

    await expectPainted(
      panel(page).getByText("If you do nothing, ui-designer picks and the run carries on."),
      "If you do nothing, ui-designer picks and the run carries on.",
    );
  });
});

/* ================================================================== */
/* 3. WHAT WAS DELETED STAYS DELETED                                   */
/* ================================================================== */

test.describe("the panel does not say one thing twice", () => {
  /**
   * MEASURED, NOT ASSERTED AS AN ABSENCE. Before this pass the canvassed dock
   * carried "…if the window closes first, ui-designer picks and the run records
   * that the pick was automatic" in the body AND "If you do nothing, ui-designer
   * picks a direction, the run carries on…" five lines below it, plus "let the
   * window close and ui-designer picks" in the subtitle above: the same fact
   * three times in fifty words. A test for one deleted string would go green with
   * two of the three still on screen.
   *
   * MUTATION, APPLIED AND WATCHED RED: restore the old body paragraph to
   * `design-lock.tsx`'s `pending` branch. The count goes to 2.
   */
  test("`ui-designer picks` appears exactly once on the parked panel", async ({ page }) => {
    await serve(page, CANVASS);
    await closeLayer(page);

    const text = (await panel(page).innerText()).toLowerCase();
    const hits = text.split("ui-designer picks").length - 1;
    expect(hits, `panel text was:\n${text}`).toBe(1);
  });

  /**
   * The words the owner named. `suite`, `freeze`/`frozen`, `verdict`, `seat`,
   * `digest`, `env` and `trace`-as-a-noun — scanned over BOTH surfaces this lane
   * owns, dock and layer.
   *
   * THE FIXTURE SUPPLIES NO BANNED WORD, which is what makes a whole-panel scan
   * safe here where `panel-copy.browser.spec.ts` needs a subtraction step: every
   * direction name, distinction and path above is written in this file.
   *
   * MUTATION, APPLIED AND WATCHED RED: restore `FROZEN_SUITE_SENTENCE`'s first
   * clause ("The acceptance suite was frozen in the spec phase.") to the reply
   * box.
   */
  test("no banned word survives on either design surface", async ({ page }) => {
    const banned = /\b(seats?|suites?|digests?|freezes?|freeze|frozen|verdicts?|traces?|env)\b/i;

    await serve(page, CANVASS);

    // The layer first, while it is open over the canvas.
    const layer = page.getByRole("dialog", { name: "Choose a design direction" });
    const layerText = await layer.innerText();
    expect(banned.test(layerText), `layer text was:\n${layerText}`).toBe(false);

    await closeLayer(page);
    const dockText = await panel(page).innerText();
    expect(banned.test(dockText), `dock text was:\n${dockText}`).toBe(false);
  });

  /**
   * The settled record, which is the other half of the surface and has its own
   * vocabulary. "building this" was on the chosen direction's badge on a run that
   * finished an hour ago.
   *
   * MUTATION, APPLIED AND WATCHED RED: put "building this" back on the badge.
   */
  test("a finished run does not claim it is still building", async ({ page }) => {
    await serve(page, SETTLED);

    const settled = await panel(page).innerText();
    expect(settled.toLowerCase()).not.toContain("building this");
    expect(banishNewlines(settled)).toContain("chosen");
    // The direction record still says WHO chose and WHAT was not built — the
    // deletion took the sentence that restated those badges, not the badges.
    expect(settled).toContain("You chose Terminal grid.");
    expect(settled).toContain("not built");
  });
});

function banishNewlines(value: string): string {
  return value.replace(/\s+/g, " ");
}
