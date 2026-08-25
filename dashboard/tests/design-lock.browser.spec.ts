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

import type {
  DesignDirectionState,
  DesignLockState,
  DesignRenderRequest,
  RunDetail,
  Screenshot,
} from "../src/lib/api-types";
import { MOCKUP_LABEL } from "../src/lib/mockups";
// THE CAPS THE SERVER SENDS. Hardcoding `turnsMax: 4` here left this file
// asserting the panel's own sentence — "4 of 4 turns left" — against a body no
// run answers with, green, for as long as `MAX_DESIGN_LOCK_TURNS` was 8.
import { MAX_DESIGN_LOCK_TURNS, MAX_DESIGN_ON_DEMAND_RENDERS } from "./fixtures/design-caps";
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

/**
 * THE FIVE-KEY LOCK EVERY RECORDED RUN ACTUALLY ANSWERS WITH.
 *
 * Not a convenience type: it is the whole old-runs regression control. The nine
 * fields added on 2026-08-03 are ABSENT from the three runs on this machine —
 * measured against the running backend, and `lib/api.ts` casts responses with
 * `parsed as T` and validates nothing — so a page that reads `lock.directions
 * .length` on one of those bodies throws inside a render and blanks. Every
 * pre-canvass shape below is served through this type, which means these tests
 * see the bytes the server sends rather than a fixture that quietly fills the
 * gaps in.
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

function detail(status: RunDetail["status"], designLock: DesignLockState | null): RunDetail {
  return { ...RUN_DETAIL, runId: RUN, status, designLock };
}

/** A run recorded before directions existed, served with the keys it really has. */
function legacy(status: RunDetail["status"], designLock: LegacyDesignLock | null): LegacyDetail {
  return { ...RUN_DETAIL, runId: RUN, status, designLock };
}

const PARKED = legacy("awaiting_input", {
  awaiting: true,
  mockups: MOCKUPS,
  locked: null,
  lockedBy: null,
  reason: null,
});

/** The timeout fired: the status moved on, the cached lock record has not. */
const CLOSING = legacy("queued", {
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
const SETTLED = legacy("awaiting_input", {
  awaiting: false,
  mockups: MOCKUPS,
  locked: refFor(1),
  lockedBy: "owner",
  reason: "chosen by the owner in the dashboard",
});

/** Parked for something that is not a design choice: no lane, no cards. */
const NO_LANE = legacy("awaiting_input", null);

/**
 * The lane ran and locked NOTHING — degraded, or failed.
 *
 * NOT THE SAME AS `designLock: null`, which means the run had no DESIGN lane at
 * all. `api-types.ts` calls this "the case the whole lane's reporting exists to
 * make visible", so it has to render something that says so rather than folding
 * into the no-lane branch and disappearing.
 */
const UNLOCKED = legacy("passed", {
  awaiting: false,
  mockups: MOCKUPS,
  locked: null,
  lockedBy: null,
  reason: null,
});

/** Locked on a ref that was never published — no card can be distinguished. */
const LOCKED_ELSEWHERE = legacy("passed", {
  awaiting: false,
  mockups: MOCKUPS,
  locked: `${WORKSPACE}/09-never-published.png`,
  lockedBy: "ui-designer",
  reason: "the strongest hero of the set",
});

/* ------------------------------------------------------------------ */
/* THE CANVASS — three directions, the same two sections each          */
/* ------------------------------------------------------------------ */

const DIRECTION_SECTIONS = ["hero", "selected work"] as const;

/** One direction's canvass stills, published the way `#recordDesignMockups` does. */
function canvassShots(slug: string): readonly Screenshot[] {
  return DIRECTION_SECTIONS.map((section, index) => ({
    path: `${PUBLISHED}/design-${slug}-0${String(index + 1)}-${section.replace(/ /g, "-")}.png`,
    label: `${MOCKUP_LABEL}${section}`,
    capturedAt: `2026-08-03T09:0${String(index)}:05.000Z`,
  }));
}

const EDITORIAL = canvassShots("editorial-slab");
const TERMINAL = canvassShots("terminal-grid");
const SOFT = canvassShots("soft-studio");

const CANVASS_MOCKUPS: readonly Screenshot[] = [...EDITORIAL, ...TERMINAL, ...SOFT];

function direction(
  slug: string,
  name: string,
  distinction: string,
  shots: readonly Screenshot[],
  discarded = false,
): DesignDirectionState {
  return {
    slug,
    name,
    distinction,
    discarded,
    mockups: shots.map((shot) => shot.path),
    notes: `${WORKSPACE}/direction-${slug}.md`,
  };
}

const DIRECTIONS: readonly DesignDirectionState[] = [
  direction(
    "editorial-slab",
    "Editorial slab",
    "A magazine masthead: one enormous serif headline and a rule under it.",
    EDITORIAL,
  ),
  direction(
    "terminal-grid",
    "Terminal grid",
    "Monospace on a hard 12-column grid, with no images above the fold.",
    TERMINAL,
  ),
  direction(
    "soft-studio",
    "Soft studio",
    "Wide air, one photograph, and type that never shouts.",
    SOFT,
  ),
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

const CANVASS = detail("awaiting_input", canvassLock());

/**
 * The still the owner commissioned. PUBLISHED LIKE ANY OTHER — an on-demand
 * render is an `addScreenshot` row and a copy in the served directory, which is
 * the only way the answer reaches him at all (the host may not compose a `run`
 * chat row of its own).
 */
const REQUESTED_SHOT: Screenshot = {
  path: `${PUBLISHED}/design-soft-studio-req-01-contact.png`,
  label: `${MOCKUP_LABEL}contact`,
  capturedAt: "2026-08-03T09:11:30.000Z",
};

/**
 * Both caps spent: the box must say so rather than take another click.
 *
 * SPENT MEANS EQUAL TO THE CAP, WHICH IS WHY THESE ARE THE CONSTANTS. As `4` and
 * `6` this fixture stopped being "both caps spent" the moment the turn cap moved
 * to 8 — four turns of eight is a live box — and the test below kept passing on
 * the renders half alone.
 */
const CANVASS_SPENT = detail(
  "awaiting_input",
  canvassLock({
    mockups: [...CANVASS_MOCKUPS, REQUESTED_SHOT],
    turnsUsed: MAX_DESIGN_LOCK_TURNS,
    rendersUsed: MAX_DESIGN_ON_DEMAND_RENDERS,
    requests: [
      {
        at: "2026-08-03T09:11:00.000Z",
        section: "contact page",
        direction: "soft-studio",
        outcome: "rendered",
        detail: "",
        mockup: REQUESTED_SHOT.path,
      },
      {
        at: "2026-08-03T09:14:00.000Z",
        section: "pricing",
        direction: "brutal-slab",
        outcome: "unknown-direction",
        detail: "no direction named brutal-slab was offered on this run",
        mockup: null,
      },
    ] satisfies readonly DesignRenderRequest[],
  }),
);

/**
 * NO IMAGE KEY ON THE MACHINE: three directions, written art direction, and not
 * one still. The panel must still be answerable — a run that silently falls back
 * to one direction is the feature quietly not existing where it matters least.
 */
const DEGRADED = detail(
  "awaiting_input",
  canvassLock({
    mockups: [],
    directions: DIRECTIONS.map((entry) => ({ ...entry, mockups: [] })),
  }),
);

/** Stage B: the choice is made, the hero is not locked yet. */
const EXPANDING = detail(
  "queued",
  canvassLock({
    awaiting: false,
    chosenDirection: "terminal-grid",
    chosenDirectionBy: "owner",
    stage: "expanding",
  }),
);

/** Stage B returned and the hero locked. */
const CANVASS_SETTLED = detail(
  "passed",
  canvassLock({
    awaiting: false,
    locked: `${WORKSPACE}/terminal-grid-01-hero.png`,
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

interface Harness {
  /** Every body posted to the resume route, in order. `null` = no body sent. */
  readonly resumes: unknown[];
  /** Every body posted to the messages route, in order. */
  readonly messages: unknown[];
}

/**
 * The refusal `POST /api/runs/:id/resume` actually returns, transcribed from
 * `sendError` in `server/src/http.ts`. `error` is a machine code and `message` is
 * the sentence written for a person; both are on the wire, and which one the UI
 * picks is the difference between a run page that explains itself and one that
 * says `not_resumable`.
 */
const REFUSAL = {
  error: "not_resumable",
  message: `run ${RUN} is awaiting_input and cannot be resumed, or ${String(MOCKUPS[1]?.path)} is not one of its mockups`,
  remediation:
    "A finished run is not resumed: re-running a scored artefact would overwrite a real result with a second one taken under different conditions. Submit a new run instead.",
} as const;

async function serve(
  page: Page,
  body: RunDetail | LegacyDetail,
  resume: { status: number; body: string } = { status: 200, body: '{"ok":true}' },
): Promise<Harness> {
  const resumes: unknown[] = [];
  const messages: unknown[] = [];

  // ONE HANDLER, NOT SEVERAL. Playwright matches the most recently registered
  // route first, so a set of overlapping patterns would depend on declaration
  // order; switching inside one handler cannot drift that way.
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/resume")) {
      const raw = route.request().postData();
      resumes.push(raw === null ? null : JSON.parse(raw));
      await route.fulfill({
        status: resume.status,
        contentType: "application/json",
        body: resume.body,
      });
      return;
    }
    if (path.endsWith("/messages")) {
      // THE DESIGN DIALOGUE RIDES THE ORDINARY CHAT INTAKE, so a request for a
      // section is a POST here and nothing else. GET is the transcript the run
      // page fetches on mount; both are answered, and only the POST is recorded.
      if (route.request().method() === "POST") {
        const raw = route.request().postData();
        messages.push(raw === null ? null : JSON.parse(raw));
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            message: { seq: 1, at: "2026-08-03T09:20:00.000Z", role: "owner", text: "", images: [], deliveredAt: null },
          }),
        });
        return;
      }
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
  return { resumes, messages };
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

  test("a REFUSED choice says which path was refused, not `not_resumable`", async ({ page }) => {
    // THE PATH EVERY REAL CLICK TAKES TODAY, and the reason this test exists at
    // all. `Orchestrator.resume` locks by exact equality against
    // `manifest.refs[].path`, and the only path these cards can send is the
    // PUBLISHED COPY — so until that seam is fixed server-side, 409 is not an
    // edge case here, it is the outcome. What the owner reads in that moment is
    // therefore part of the feature, not part of its error handling.
    //
    // Both halves are asserted. The bare code alone is what shipped before this
    // commit, and it is indistinguishable from a working UI right up until
    // something goes wrong.
    await serve(page, PARKED, { status: 409, body: JSON.stringify(REFUSAL) });

    await cards(page).nth(1).click();

    const failure = page.getByText("That action did not go through");
    await expect(failure).toBeVisible();
    await expect(page.getByText(REFUSAL.message)).toBeVisible();
    await expect(page.getByText("not_resumable", { exact: true })).toHaveCount(0);

    // And the run stays exactly where it was: still parked, still offering.
    await expect(cards(page)).toHaveCount(MOCKUPS.length);
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
    // And with no cause recorded (`RUN_DETAIL` carries `failureReason: null`,
    // which is also `reconcileOnBoot`'s shape on the wire) there is no `pre` to
    // fill: the reasonless kind shows no cause block — 2026-08-25. The other
    // direction, a recorded cause IS shown, is `plan-dialogue.browser.spec.ts`
    // "a later creative park cannot reopen the folded plan".
    await expect(page.getByText("Last recorded cause")).toHaveCount(0);
    await expect(page.getByTestId("awaiting-input-cause")).toHaveCount(0);
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

  test("a lane that locked NOTHING says so, and is not the no-lane branch", async ({ page }) => {
    await serve(page, UNLOCKED);

    // `{awaiting:false, locked:null}` is a lane that ran and produced nothing to
    // lock; `designLock: null` is a run with no lane. The panel appears for the
    // first and not the second, which is the only thing on the page that can
    // tell them apart.
    await expect(page.getByRole("heading", { name: "Design lock" })).toBeVisible();
    await expect(panel(page).getByText("nothing locked", { exact: true })).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    // The consequence is stated, because it changes what a pass on this run
    // means: the look was checked against no reference at all.
    //
    // TRANSCRIBED FROM THE PANEL, NOT FROM THE MECHANISM. This read
    // `/rule-based floor/` until 2026-08-05, when the copy pass took the
    // internal name of the fallback off the screen — it survives only as a
    // source comment in `design-lock.tsx`, and a spec that matched it would have
    // been asserting against a comment. What replaced it is the same fact in the
    // words a reader gets, and it is the whole sentence rather than a fragment
    // because BOTH halves are the point: no reference, and weaker rather than
    // failed.
    await expect(
      panel(page).getByText(
        "No design was locked, so the site was checked without a reference. That is a weaker " +
          "check, not a failing one.",
      ),
    ).toBeVisible();
  });

  test("a lock on a mockup that was never published is said out loud", async ({ page }) => {
    await serve(page, LOCKED_ELSEWHERE);

    /*
     * THE ABSENCE IS READ LAST, AND THAT ORDERING IS THE FIX OF 2026-08-09. It
     * used to be the FIRST assertion in this test, and an absence asserted
     * before anything is known to have painted is answered by the blank page:
     * measured, not assumed — with this file's `serve()` answering the run
     * detail 500 the old order reported its failure at the
     * `/not one of the mockups shown here/` line BELOW, which means the count-0
     * above it had just passed over a panel that did not exist. Nothing about
     * WHAT is asserted changed; the two paint assertions simply run first, so
     * the absence is only ever read off a rendered panel.
     */
    // "is not among the mockups published on this run" became "is not one of the
    // mockups shown here" on 2026-08-05. Same claim, shorter.
    await expect(panel(page).getByText(/not one of the mockups shown here/)).toBeVisible();
    // And ui-designer's reason — the one reason on this screen an agent wrote
    // rather than the host — is carried verbatim.
    await expect(panel(page).getByText(/the strongest hero of the set/)).toBeVisible();
    /*
     * Distinguishing no card here would read as "no design was locked", which is
     * the opposite of what the record says. The path is shown instead.
     *
     * MUTATION APPLIED (2026-08-09), and this one is a product edit, reverted:
     * a `<span>locked</span>` added to `design-lock.tsx`'s "not one of the
     * mockups shown here" paragraph — the badge this line exists to refuse.
     * Red here: `Expected: 0 / Received: 1`, "34 × locator resolved to 1
     * element". So this guard reads a real panel and can fail on one.
     */
    await expect(panel(page).getByText("locked", { exact: true })).toHaveCount(0);
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

  test("a run with no directions grows no directions box", async ({ page }) => {
    await serve(page, PARKED);

    // THE OLD-RUNS CONTROL, and it is served through `LegacyDesignLock` — the
    // five keys the three recorded runs actually answer with. Anything that
    // reads the nine new fields without a default crashes this page rather than
    // failing an assertion, which is why the assertion below is the WEAKER of
    // the two things this test checks.
    await expect(cards(page)).toHaveCount(MOCKUPS.length);
    await expect(directionCards(page)).toHaveCount(0);
    await expect(page.getByText(/compare the .* directions side by side/)).toHaveCount(0);
    // THE REPLY BOX IS NOT DRAWN EITHER, and this line names the sentence that
    // box carries TODAY. It read `/The acceptance suite was frozen/` — a string
    // the 2026-08-05 copy pass deleted from the app entirely — so it had stopped
    // being a check on this branch and become a check that a deleted sentence
    // stays deleted, which is true on every page in the product.
    await expect(page.getByText(/Asking here changes what gets built/)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* THE CANVASS                                                         */
/* ------------------------------------------------------------------ */

const directionCards = (page: Page) => page.locator("[data-testid^='design-direction-']");
const chooseButtons = (page: Page) => page.getByRole("button", { name: /^Build in the / });

test.describe("choosing a direction", () => {
  test("the directions are shown side by side, each with its own difference", async ({ page }) => {
    await serve(page, CANVASS);

    await expect(directionCards(page)).toHaveCount(DIRECTIONS.length);
    for (const entry of DIRECTIONS) {
      // THE NAME AND THE ONE SENTENCE, because three unlabelled columns of
      // pictures are not a choice — they are the same file listing the old panel
      // was, with more files in it.
      await expect(page.getByText(entry.name, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(entry.distinction)).toBeVisible();
    }

    // AND THE STILLS ARE COMPARABLE: the same sections, in every column.
    await expect(page.getByRole("button", { name: /^Enlarge the / })).toHaveCount(
      CANVASS_MOCKUPS.length,
    );
  });

  test("the click carries THE SLUG, and no mockup path with it", async ({ page }) => {
    const harness = await serve(page, CANVASS);

    await chooseButtons(page).nth(1).click();

    await expect.poll(() => harness.resumes.length).toBe(1);
    /*
     * THE ASSERTION THIS WHOLE STAGE EXISTS FOR, and `toEqual` rather than
     * `toMatchObject` on purpose. `chosenMockup` is validated against the
     * manifest's refs and a published copy earns a 409 there — the refusal case
     * above records it — so an extra key here would not be harmless
     * belt-and-braces, it would turn a valid direction choice into a refusal.
     */
    expect(harness.resumes[0]).toEqual({ chosenDirection: "terminal-grid" });
  });

  test("a still opens large, and the choice is a separate control", async ({ page }) => {
    await serve(page, CANVASS);

    // Two overlapping click targets on one card is how an owner locks a design
    // when he meant to look at it. The still zooms; the button chooses.
    await page.getByRole("button", { name: /^Enlarge the / }).first().click();
    // THE DIALOG IS STILL THERE; ITS NAME MOVED. `Lightbox` names itself with
    // its `alt` (`ui.tsx`), and `ZoomedStill` passes `${section} mockup` since
    // the 2026-08-05 pass took the word "still" off every label a reader meets —
    // it reads as a verb first. Matched on the ROLE plus the section, so a zoom
    // that stopped being a dialog, or opened on the wrong image, still fails.
    await expect(page.getByRole("dialog", { name: /hero mockup/ })).toBeVisible();
  });

  test("Escape closes the still first and the comparison second", async ({ page }) => {
    await serve(page, CANVASS);

    const layer = page.getByRole("dialog", { name: "Choose a design direction" });
    await expect(layer).toBeVisible();

    await page.getByRole("button", { name: /^Enlarge the / }).first().click();
    // `/hero still/` until 2026-08-05 — see the test above; the name is the
    // `alt`, and "still" became "mockup" everywhere on this surface.
    const still = page.getByRole("dialog", { name: /hero mockup/ });
    await expect(still).toBeVisible();

    /*
     * ONE STEP PER PRESS. `Lightbox` closes itself on a `window` listener and the
     * layer needs Escape too, so with both listening one keypress takes the still
     * AND the comparison under it — the owner asks for his image back and loses
     * the three directions he was reading it against.
     */
    await page.keyboard.press("Escape");
    await expect(still).toHaveCount(0);
    await expect(layer).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(layer).toHaveCount(0);
    // And it is not a trap: the deck is still in the dock, and the layer reopens.
    await expect(directionCards(page)).toHaveCount(DIRECTIONS.length);
  });

  test("the limit on what asking can do is stated where he types, with both caps", async ({
    page,
  }) => {
    await serve(page, CANVASS);

    /*
     * THE OPERATIVE HALF, WHICH IS ALL THAT IS LEFT OF IT. This was the
     * 32-word "The acceptance suite was frozen in the spec phase. …" sentence
     * until 2026-08-05; the first clause said WHEN the tests were written, which
     * changes nothing the owner can do while typing, and was deleted rather than
     * hidden. The half that bounds what he is about to spend a render on is
     * still at reading size against the box, which is what this test is for —
     * the title said "the frozen suite" and now says what the sentence says.
     *
     * TRANSCRIBED, NOT IMPORTED. `design-directions.tsx` exports this string as
     * `ASK_LIMIT_SENTENCE`; asserting against that export would pass on any
     * rewording of it, which is the one thing a copy spec must not do.
     */
    await expect(
      page.getByText("Asking here changes what gets built, not what counts as done."),
    ).toBeVisible();
    // He is spending image generations on a parked run; being refused is the
    // wrong way to find out how many are left.
    //
    // THE SENTENCE IS BUILT FROM THE SERVER'S CAPS, NOT TRANSCRIBED. As a literal
    // it read "4 of 4 turns left" and passed for as long as the fixture above
    // also said 4 — the panel and the assertion agreeing with each other about a
    // number the server had already changed to 8.
    await expect(
      page.getByText(
        `${String(MAX_DESIGN_ON_DEMAND_RENDERS)} of ${String(MAX_DESIGN_ON_DEMAND_RENDERS)} renders left · ` +
          `${String(MAX_DESIGN_LOCK_TURNS)} of ${String(MAX_DESIGN_LOCK_TURNS)} turns left`,
      ),
    ).toBeVisible();
  });

  test("asking for a section posts ONE addressed message", async ({ page }) => {
    const harness = await serve(page, CANVASS);

    await page.getByLabel("The section to render").fill("contact page");
    // The ordinal and the name are one accessible name with no space between
    // them (`3Soft studio`), which is why this is a regex and not a literal.
    await page.getByRole("button", { name: /^3\s*Soft studio$/ }).click();
    await page.getByRole("button", { name: "ask for it" }).click();

    await expect.poll(() => harness.messages.length).toBe(1);
    /*
     * ADDRESSED BY SLUG, NOT BY ORDINAL. The server's parser returns null when a
     * message names neither a section nor a direction, and an unclaimed message
     * is not refused — it stays pending for the next segment boundary. So a
     * mis-addressed ask looks sent, costs nothing, and answers nothing.
     */
    expect(harness.messages[0]).toEqual({
      text: "show me the contact page in soft-studio",
      images: [],
    });
  });

  test("a spent cap says so instead of taking another click", async ({ page }) => {
    await serve(page, CANVASS_SPENT);

    await expect(
      // "No more renders on this run —" was cut to "No renders left —" on
      // 2026-08-05. The half that tells him what to do instead is unchanged.
      page.getByText("No renders left — pick one of the directions above."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "ask for it" })).toHaveCount(0);
    // The directions are still choosable — the cap bounds the dialogue, not the
    // decision it exists to inform.
    await expect(chooseButtons(page)).toHaveCount(DIRECTIONS.length);
  });

  test("what he asked for is shown, refusals included", async ({ page }) => {
    await serve(page, CANVASS_SPENT);

    await expect(page.getByText("you asked for this one")).toBeVisible();
    // A refusal spent a turn and produced nothing; hiding it is how an owner
    // concludes the panel ignored him.
    await expect(
      page.getByText("no direction by that name — nothing was rendered"),
    ).toBeVisible();
  });

  test("no image key: three directions, no stills, still answerable", async ({ page }) => {
    await serve(page, DEGRADED);

    // `mockups: []` USED TO SWALLOW THE ENTIRE CHOICE. The panel's empty state
    // fires on that count, and on the one machine where the lane writes prose
    // instead of pictures it would have told an owner with a real decision to
    // make that there was nothing to publish.
    await expect(directionCards(page)).toHaveCount(DIRECTIONS.length);
    await expect(chooseButtons(page)).toHaveCount(DIRECTIONS.length);
    // "Written art direction, with no stills" became "Written art direction, no
    // pictures: …" — same two facts, and "still" is gone from this surface.
    await expect(
      page.getByText(/Written art direction, no pictures/).first(),
    ).toBeVisible();
    /*
     * AND THE EMPTY STATE IS NOT UNDER IT, which is the half of this test that
     * catches the regression it was written for. The forbidden string was
     * `/there was nothing to publish/` — a clause the 2026-08-05 pass deleted
     * from the app — so the check had quietly become unfalsifiable. The
     * `EmptyState` that `mockups: []` used to reach is still in the tree
     * (`design-lock.tsx`), and this is the sentence it renders.
     */
    await expect(
      page.getByText("The design lane recorded no mockups on this run."),
    ).toHaveCount(0);
  });
});

test.describe("after the choice", () => {
  test("expanding never says the lane finished without a design", async ({ page }) => {
    await serve(page, EXPANDING);

    /*
     * THE WINDOW THE PHASE DERIVATION EXISTS FOR. Between the choice and the
     * hero lock the record is `{awaiting:false, locked:null}` — byte-identical
     * to a lane that produced nothing — and it stays that way for the whole of
     * stage B. The old ordering printed "The DESIGN lane finished without a
     * design to lock" over a run that was busy rendering the design.
     */
    /*
     * THE FORBIDDEN SUBTITLE IS THE ONE `unlocked` REALLY CARRIES. This read
     * "The DESIGN lane finished without a design to lock", which is how the
     * subtitle was worded before 2026-08-05 and appears nowhere in the app now —
     * so the guard could not have failed even if this run took the `unlocked`
     * branch outright. It is the shipped string, so the branch mix-up it exists
     * to catch is caught again.
     */
    /*
     * THE PAINT ASSERTIONS RUN FIRST — 2026-08-09. The forbidden subtitle below
     * used to be asserted before any of them, and that order is the one this
     * repository keeps getting wrong: measured with `serve()`'s run-detail route
     * answering 500, the old order sailed through the count-0 and reported its
     * failure on the sentence below it, i.e. the absence had been read off a page
     * with nothing on it. Same three assertions, and now the two that establish
     * the page come first.
     */
    // "The rest of its sections" → "Its other sections".
    await expect(
      page.getByText("Your direction is chosen. Its other sections are being rendered now."),
    ).toBeVisible();
    await expect(page.getByText(/You chose Terminal grid\./)).toBeVisible();
    await expect(
      page.getByText("The design lane finished with nothing to lock."),
    ).toHaveCount(0);
    // Nothing is being asked of him now, so nothing offers.
    await expect(chooseButtons(page)).toHaveCount(0);
  });

  test("settled: which direction won, and that the others were not built", async ({ page }) => {
    await serve(page, CANVASS_SETTLED);

    /*
     * WHO CHOSE, AND WHICH ONE — the sentence, minus a clause that is now the
     * two badges below it.
     *
     * THE CLAUSE THAT CAME OFF IS DISCLOSED RATHER THAN QUIETLY DROPPED. It read
     * " The other 2 directions were offered and not built — nothing was graded
     * against them", and `design-lock.tsx`'s `directionSentence` records
     * deleting it on 2026-08-05 as a sentence whose whole content was the label
     * one row under it. The two assertions that follow ARE that content, on the
     * cards, counted — so what this test checks is unchanged even though the
     * string it transcribes is shorter.
     */
    await expect(page.getByText("You chose Terminal grid.")).toBeVisible();
    // Marked on the cards as well as in the sentence: a reader who skims the
    // columns must not read a discarded direction as part of the build.
    await expect(page.getByText("not built", { exact: true })).toHaveCount(2);
    // "building this" until 2026-08-05, and the rename was a correction rather
    // than a trim: `state` cannot tell stage B from a finished run, so that badge
    // was wrong in both directions — nothing is built yet during the expansion,
    // and it was built, past tense, afterwards.
    await expect(page.getByText("chosen", { exact: true })).toHaveCount(1);
    // And the one still the gate actually graded against is distinguished, which
    // is `lockedMockup`'s unchanged meaning.
    await expect(page.getByText("locked", { exact: true })).toHaveCount(1);
  });
});
