/**
 * THE PRE-BUILD LANE ON THE CANVAS — Plan ── Orchestrator ── agents.
 *
 * THE OWNER'S ASK, VERBATIM, 2026-08-04: "when i click them they break funny.
 * Also Is it really necessary to have all these different nodes? I think there
 * should just be one plan node linking to orchestrator. When you click on the plan
 * node a menu on the left side of the screen comes up … replacing this. and
 * instead on that menu you have the different sections that show what it is doing
 * right now."
 *
 * WHAT REPLACED WHAT. This file used to assert five stage cards in x order and a
 * click that GREW one of them in place. Both of those are gone: the five cards are
 * one folded card whose height is a constant, and the click opens a docked panel.
 * The old open/close test asserted the exact behaviour the owner reported as a
 * bug, so it was deleted rather than adapted — a test that pins a defect keeps it.
 *
 * WHAT THIS FILE MEASURES, AND WHY EACH PART IS NEEDED.
 *
 *   1. THE COUNT, AND THE TWO SHAPES IT TAKES. A run with no agents draws exactly
 *      two cards — Plan and Orchestrator — with one link between them. A run that
 *      has spawned agents draws ONE, because the orchestrator's stage card is
 *      dropped in favour of the real root card and the link lands there instead.
 *      Both are asserted, because "exactly two" is only true of the first and a
 *      spec that asserted it everywhere would push an implementer into drawing two
 *      orchestrator boxes for one actor.
 *   2. THE CARD DOES NOT GROW. Measured in layout pixels before and after a click,
 *      which is the defect being designed out.
 *   3. THE PANEL IS WIRED, POPULATED AND REVERSIBLE. Its sections carry the
 *      SERVER'S sentences, not a hard-coded table; the run chip goes away while it
 *      is open and comes back by three separate routes; and it never covers a plan
 *      park, which is the answer surface for a run stopped waiting on the owner.
 *   4. IT SURVIVES A RELOAD. `use-run-stream.ts:820-822` never opens an
 *      EventSource for a terminal run, so anything derived from the live `trace`
 *      sink is BLANK on every finished run — which is most of the runs anyone
 *      opens, including the one this redesign was built against. `FINISHED_RUN_ID`
 *      is the harness's terminal fixture and the panel has to be whole on it, out
 *      of the REST snapshot alone.
 *
 * WHERE THE LANE ROWS COME FROM, AND WHY THEY ARE INJECTED HERE.
 *
 * `fixtures/build-run-fixture.ts` carries `graph_*` rows only — no `phase` row and
 * no recognised server sentence — so both of its snapshots fold to a state with NO
 * `stages` key at all. That file belongs to another lane, so rather than edit it,
 * these specs intercept `GET /api/runs/:id/graph` and answer with the SAME fixture
 * events plus the pre-build rows a real run writes.
 *
 * THE SNAPSHOT IS STILL PRODUCED BY THE REAL REDUCER. `foldGraphAll` is imported
 * and called on the event list; nothing here writes a `GraphState` literal. That
 * is the property `build-run-fixture.ts` refuses to give up at its own head, and
 * it matters more here: a literal would keep answering after `foldGraph`'s lane
 * arms broke, and these tests would silently become assertions about a fixture.
 *
 * `atSeq` IS THE UNMODIFIED FIXTURE'S WATERMARK, deliberately. The harness's
 * `/events` route replays the same rows from seq 1, and `use-run-graph.ts` folds a
 * tail event only when its seq is past the snapshot's — so reporting the injected
 * rows in the count would let the live twin fold the whole build a second time and
 * double every tool pill.
 *
 * THE CONTROL FOR ALL OF IT is `an untouched run draws no lane at all`, which
 * opens the same run id with NO interception. It is not a nicety: if `page.route`
 * silently failed to fire, every assertion above would be measuring the plain
 * fixture, and that test is the one that says whether the injection happened.
 *
 * THE SECTION LABELS ARE NOT ASSERTED HERE, AND THAT IS A LANE BOUNDARY RATHER
 * THAN AN OVERSIGHT. "Reference capture", "Spec seat", "Audit seat" and "Freeze"
 * are `STAGE_LABEL` in `server/src/graph.ts`, which this change does not own. What
 * is asserted instead is the content only this change can produce: the server's
 * own log lines reaching the panel unclamped, the state words, and the two fixed
 * sentences that refuse to promise a future on a dead run.
 */

import { expect, test, type Page } from "@playwright/test";

import { foldGraphAll } from "../src/lib/graph";
import type { RunEvent } from "../src/lib/api-types";
import { BUILD_RUN_ID, FINISHED_RUN_ID, PLAN_RUN_ID } from "./fixtures/config";
import {
  BUILD_AT_SEQ,
  BUILD_EVENTS,
  FINISHED_AT_SEQ,
  TERMINAL_STATUS,
} from "./fixtures/build-run-fixture";

/**
 * The rows a real run writes before it has any agent, in the order it writes them.
 *
 * EVERY SENTENCE IS ONE THE SERVER ACTUALLY EMITS — they are the phrases
 * `server/src/graph.ts` matches, quoted from the producing sites rather than
 * invented, which is what makes a fold of them a fold of a real run. The token
 * lines are the shape `orchestrator.ts` writes at the end of each seat.
 */
const LANE_ROWS: readonly RunEvent[] = [
  { type: "phase", phase: "plan", at: "2026-08-03T09:58:00.000Z" },
  {
    type: "log",
    level: "info",
    at: "2026-08-03T10:02:10.000Z",
    text: "the plan dialogue is folded into the brief",
  },
  { type: "phase", phase: "spec", at: "2026-08-03T10:02:11.000Z" },
  {
    type: "log",
    level: "info",
    at: "2026-08-03T10:02:40.000Z",
    text: "captured https://kamilborzecki.dev — 14 sections, 3 fonts, 2 breakpoints",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-03T10:03:00.000Z",
    text: "authoring the held-out acceptance suite",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-03T10:21:44.000Z",
    text: "spec seat — anthropic: 14 input, 40187 cache read, 8124 cache write, 416111 output over 2 call(s)",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-03T10:24:02.000Z",
    text: "audit seat — anthropic: 9 input, 21044 cache read, 1180 cache write, 38210 output over 1 call(s)",
  },
  {
    type: "log",
    level: "info",
    at: "2026-08-03T10:24:30.000Z",
    text: "sealed suite 7f3a91 — 11 criteria, frozen",
  },
  { type: "phase", phase: "build", at: "2026-08-03T10:24:31.000Z" },
];

/**
 * The lane the OWNER'S OWN RUN folds to, and the primary rendering of this
 * redesign rather than an edge case.
 *
 * `plan:done capture:pending author:unresolved audit:pending freeze:pending` —
 * recorded from `run-2026-08-04T11-08-10-487Z-162b186d` in `stage-node.tsx`'s
 * header. The `spec` phase row unresolves `plan`… so `plan` is closed first by its
 * own sentence, `author` is opened by the authoring line and never closed, and the
 * `gate` row moves the run past the spec phase while it is still open. No agent
 * rows at all: this run never reached the build.
 */
const STOPPED_LANE: readonly RunEvent[] = [
  { type: "phase", phase: "plan", at: "2026-08-04T11:08:10.000Z" },
  {
    type: "log",
    level: "info",
    at: "2026-08-04T11:12:10.000Z",
    text: "the plan dialogue is folded into the brief",
  },
  { type: "phase", phase: "spec", at: "2026-08-04T11:12:11.000Z" },
  {
    type: "log",
    level: "info",
    at: "2026-08-04T11:13:00.000Z",
    text: "authoring the held-out acceptance suite",
  },
];

/**
 * One turn of the builder's own prose — ask B, and the other half of this lane's
 * work. `graph_narration` folds into `GraphNode.activity` as `kind: "narration"`
 * with an EMPTY name, so a card that branched on the name rather than the kind
 * would draw nothing here.
 *
 * It comes after `BUILD_EVENTS` because `foldGraph`'s narration arm looks the node
 * up first and drops the row when the node does not exist yet.
 */
const NARRATION: RunEvent = {
  type: "graph_narration",
  node: "builder",
  text: "Reading the frozen suite before I touch the canvas, so the layout change and the criteria cannot drift apart.",
  truncated: false,
  attribution: "exact",
  at: "2026-08-03T10:26:00.000Z",
};

const LIVE_EVENTS: readonly RunEvent[] = [...LANE_ROWS, ...BUILD_EVENTS, NARRATION];
const REPLAY_EVENTS: readonly RunEvent[] = [...LIVE_EVENTS, TERMINAL_STATUS];

/**
 * Answer this run's snapshot with a fold that includes the pre-build rows.
 *
 * The route is installed BEFORE `page.goto`, and `useRunGraph` fetches the
 * snapshot on mount for terminal and live runs alike.
 */
async function serveLane(page: Page, runId: string): Promise<void> {
  const events = runId === FINISHED_RUN_ID ? REPLAY_EVENTS : LIVE_EVENTS;
  const atSeq = runId === FINISHED_RUN_ID ? FINISHED_AT_SEQ : BUILD_AT_SEQ;
  await page.route(`**/api/runs/${runId}/graph`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...foldGraphAll(events), atSeq }),
    });
  });
}

/** Answer with a lane and NO agent graph — the run before the build starts. */
async function serveLaneOnly(
  page: Page,
  runId: string,
  events: readonly RunEvent[] = LANE_ROWS,
): Promise<void> {
  await page.route(`**/api/runs/${runId}/graph`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...foldGraphAll(events), atSeq: 0 }),
    });
  });
}

/**
 * Wait until the fold has reached the renderer.
 *
 * `probe` is the deepest node in the fixture — root → builder → probe — so its
 * card existing means the whole graph was laid out, which every assertion below
 * depends on. The same anchor `finished-run.browser.spec.ts` uses.
 */
async function openCanvas(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId("rf__node-root")).toBeVisible();
  await expect(page.getByTestId("rf__node-probe")).toBeVisible();
}

/** The same, for a run whose canvas is the pre-build chain and nothing else. */
async function openLane(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId("stage-card-plan")).toBeVisible();
}

/** Layout pixels, which no React Flow zoom can scale under the assertion. */
function offsetHeightOf(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((element) => (element as HTMLElement).offsetHeight);
}

test.describe("before the build: two cards, not six", () => {
  test("the canvas draws exactly Plan and Orchestrator, wired together", async ({ page }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID);
    await openLane(page, FINISHED_RUN_ID);

    /*
     * THE COUNT IS THE ASK. Six cards became two, and the four that are gone are
     * gone as CARDS only — they are sections in the panel below, which the next
     * describe block reads back out. A count of three means one of them was
     * restored to `drawnStages` in `layout.ts`, which is the mutation for this.
     */
    await expect(page.locator('[data-testid^="stage-card-"]')).toHaveCount(2);
    await expect(page.getByTestId("stage-card-plan")).toBeVisible();
    await expect(page.getByTestId("stage-card-orchestrator")).toBeVisible();
    for (const id of ["capture", "author", "audit", "freeze"]) {
      await expect(
        page.getByTestId(`stage-card-${id}`),
        `${id} is still its own card — the fold did not happen`,
      ).toHaveCount(0);
    }

    /*
     * AND THEY ARE A CHAIN, NOT TWO CARDS THAT HAPPEN TO BE DRAWN. The link is
     * identified by its endpoints, because a count alone passes against a chain
     * wired to the wrong card, and `lane-conduit` is the lane's own path class so
     * a delegation edge cannot satisfy it.
     */
    await expect(page.locator("path.lane-conduit")).toHaveCount(1);
    await expect(
      page.locator('path[id="stage_plan-_stage_orchestrator-lane"]'),
      "there is no link from Plan to Orchestrator",
    ).toHaveCount(1);

    // Plan is to the LEFT of the orchestrator: the chain reads in the direction
    // the run ran.
    const plan = await page.getByTestId("stage-card-plan").boundingBox();
    const orchestrator = await page.getByTestId("stage-card-orchestrator").boundingBox();
    expect(plan?.x ?? 0).toBeLessThan(orchestrator?.x ?? 0);

    // The lane header is gone with the five cards it labelled.
    await expect(page.getByText("Before the build")).toHaveCount(0);
  });

  test("once agents exist the orchestrator is ONE box, and the chain lands on it", async ({
    page,
  }) => {
    await serveLane(page, FINISHED_RUN_ID);
    await openCanvas(page, FINISHED_RUN_ID);

    /*
     * THE OTHER SHAPE, AND THE REASON THE TEST ABOVE CANNOT BE THE ONLY ONE. This
     * run has a real root `graph_agent`, so the lane's own `orchestrator` stage is
     * dropped and the chain's last link lands on the root card. Asserting "exactly
     * two" here would be asserting two orchestrator boxes for one actor.
     */
    await expect(page.locator('[data-testid^="stage-card-"]')).toHaveCount(1);
    await expect(page.getByTestId("stage-card-orchestrator")).toHaveCount(0);
    await expect(page.locator("path.lane-conduit")).toHaveCount(1);
    await expect(
      page.locator('path[id="stage_plan-_root-lane"]'),
      "the folded card is not wired to the orchestrator's own card",
    ).toHaveCount(1);

    // And the agent graph is untouched: the delegation edges are still four exact
    // conduits plus the one inferred guess (`finished-run.browser.spec.ts`).
    await expect(page.locator("path.conduit-core")).toHaveCount(4);
    await expect(page.locator("path.conduit-guess")).toHaveCount(1);
  });

  test("the card carries the rollup the run's own state produces", async ({ page }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID, STOPPED_LANE);
    await openLane(page, FINISHED_RUN_ID);

    /*
     * THE OWNER'S RUN, END TO END THROUGH THE WIRE. `author` was opened and never
     * closed and the run is over, so the rollup is `stopped` — not `waiting`,
     * which is what the same lane produces when `runIsActive` is hard-coded true
     * at the one place it is threaded into the node data. That is the mutation for
     * this test, and it is the wiring mistake the unit spec cannot catch.
     */
    await expect(page.getByTestId("stage-card-plan")).toHaveAttribute("data-state", "stopped");
    await expect(page.getByTestId("stage-card-plan")).toContainText("stopped");
    // The card says where the run got to, which is the authoring seat.
    await expect(page.getByTestId("stage-card-plan")).toContainText(
      "Writing the held-out acceptance suite",
    );
  });

  test("the card does not grow when it is clicked", async ({ page }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID);
    await openLane(page, FINISHED_RUN_ID);

    /*
     * "WHEN I CLICK THEM THEY BREAK FUNNY", MEASURED. The card used to swap a
     * two-line clamp for `whitespace-pre-wrap` on click, growing inside a React
     * Flow layout that had already reserved its box. Layout pixels rather than
     * `boundingBox`, which is post-transform and moves with the canvas's zoom.
     *
     * MUTATION: restore `expanded ? "whitespace-pre-wrap break-words" :
     * "line-clamp-2 h-[32px]"` to the activity line. The second assertion fails.
     */
    const before = await offsetHeightOf(page, "stage-card-plan");

    await page.getByTestId("stage-card-plan").click();
    await expect(page.getByTestId("prebuild-panel")).toBeVisible();

    // The growth assertion comes FIRST so that it is the one that reddens: a
    // mutation restoring the expansion also usually removes the fixed height, and
    // asserting the constant first would hide which of the two facts broke.
    expect(await offsetHeightOf(page, "stage-card-plan"), "the card changed height when it was clicked").toBe(
      before,
    );
    expect(before, "the card is not the height `STAGE_HEIGHT` reserved for it").toBe(136);
  });
});

test.describe("the panel the click opens", () => {
  test("lists every folded section with the sentence the server wrote", async ({ page }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID);
    await openLane(page, FINISHED_RUN_ID);
    await page.getByTestId("stage-card-plan").click();

    const panel = page.getByTestId("prebuild-panel");
    await expect(panel).toBeVisible();

    /*
     * CONTENT, NOT PRESENCE, AND THE CONTENT IS THE SERVER'S. These are `log` rows
     * carried verbatim through the fold; a panel rebuilt from a hard-coded table
     * would list five rows and none of these strings. Rendering it empty — the
     * mutation for this test — takes every one of them red.
     */
    await expect(page.getByTestId("plan-section-capture")).toContainText(
      "captured https://kamilborzecki.dev",
    );
    await expect(page.getByTestId("plan-section-author")).toContainText(
      "spec seat — anthropic: 14 input",
    );
    await expect(page.getByTestId("plan-section-audit")).toContainText("audit seat — anthropic");
    await expect(page.getByTestId("plan-section-freeze")).toContainText("sealed suite 7f3a91");
    await expect(page.locator('[data-testid^="plan-section-"]')).toHaveCount(5);

    // The header counts what it lists rather than a table of five.
    await expect(panel).toContainText("5 of 5 done");
  });

  test("shows a seat's whole token report, unclamped", async ({ page }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID);
    await openLane(page, FINISHED_RUN_ID);
    await page.getByTestId("stage-card-plan").click();

    /*
     * THIS IS THE STRING THE DELETED OPEN/CLOSE TOGGLE EXISTED TO REVEAL, and it
     * is why the detail moved off a fixed-size card. Playwright reads clamped text
     * out of the DOM regardless, so presence proves nothing: the assertion is that
     * the element is not scrolling its own overflow.
     *
     * MUTATION: add `line-clamp-2` to the panel row's detail. `scrollHeight`
     * exceeds `clientHeight` and this goes red.
     */
    const detail = page.getByTestId("plan-section-author").locator("p").nth(1);
    await expect(detail).toContainText("416111 output over 2 call(s)");
    const clipped = await detail.evaluate((element) => {
      const box = element as HTMLElement;
      return box.scrollHeight > box.clientHeight;
    });
    expect(clipped, "the seat's report is clipped inside its own row").toBe(false);
  });

  test("a section the dead run never mentioned says so, and promises nothing", async ({
    page,
  }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID, STOPPED_LANE);
    await openLane(page, FINISHED_RUN_ID);
    await page.getByTestId("stage-card-plan").click();

    /*
     * BOTH HALVES ARE THE TEST. The server's pending sentence ("Waiting to hear
     * whether the ticket named a page to capture.") is a promise about a run that
     * is still going; this run is over. Rendering it unconditionally — the
     * mutation — reddens both the presence of the true line and the absence of the
     * false one.
     */
    const capture = page.getByTestId("plan-section-capture");
    await expect(capture).toContainText("The run ended before this was mentioned.");
    await expect(capture).not.toContainText("Waiting to hear whether the ticket");
    await expect(capture).toContainText("never ran");

    // The section that stopped is marked as stopped, not as failed and not as
    // pending, which on a finished run would read as "still to come".
    await expect(page.getByTestId("plan-section-author")).toContainText("stopped");
  });

  test("opening it hides the run chip, and three ways back all restore it", async ({ page }) => {
    await serveLaneOnly(page, FINISHED_RUN_ID);
    await openLane(page, FINISHED_RUN_ID);

    const chip = page.getByRole("button", { name: "run detail" });
    await expect(chip).toBeVisible();

    /*
     * THE SWAP THE OWNER ASKED FOR ("a menu … replacing this"). Deleting the
     * branch that swaps them leaves both rendered and the second assertion goes
     * red, which is the mutation for this test.
     */
    await page.getByTestId("stage-card-plan").click();
    await expect(page.getByRole("button", { name: "Back to run" })).toBeVisible();
    await expect(chip).toHaveCount(0);

    // 1. The button.
    await page.getByRole("button", { name: "Back to run" }).click();
    await expect(chip).toBeVisible();

    // 2. Clicking the card again, which toggles.
    await page.getByTestId("stage-card-plan").click();
    await expect(page.getByTestId("prebuild-panel")).toBeVisible();
    await page.getByTestId("stage-card-plan").click();
    await expect(chip).toBeVisible();

    // 3. Escape. MUTATION: remove the window key handler in the panel.
    await page.getByTestId("stage-card-plan").click();
    await expect(page.getByTestId("prebuild-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("prebuild-panel")).toHaveCount(0);
    await expect(chip).toBeVisible();
  });

  test("the page keeps exactly one h1, and the panel's Plan is not a second heading", async ({
    page,
  }) => {
    await serveLaneOnly(page, PLAN_RUN_ID);
    await openLane(page, PLAN_RUN_ID);
    await page.getByTestId("stage-card-plan").click();
    await expect(page.getByTestId("prebuild-panel")).toBeVisible();

    /*
     * `RunHud` OWNED THE PAGE'S ONLY `h1` AND THIS PANEL REPLACES `RunHud`, so
     * without the ticket label on the return bar the run page has no top-level
     * heading while the panel is open. MUTATION: drop the `<h1>`; the count goes
     * to 0.
     */
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).not.toBeEmpty();

    /*
     * AND THE PANEL'S OWN TITLE IS NOT ONE. `PlanDialoguePanel` already owns an
     * accessible heading named "Plan" and this run is parked on it, so rendering
     * the panel title as a heading makes `getByRole("heading", {name: "Plan"})`
     * ambiguous — a strict-mode violation that reddens
     * `plan-dialogue.browser.spec.ts:58`. This asserts the collision has not been
     * reintroduced, on the one run where both are on screen at once.
     */
    await expect(
      page.getByRole("heading", { name: "Plan", exact: true }),
      "there are two accessible headings named Plan",
    ).toHaveCount(1);
  });

  test("it never covers the panel a parked run is waiting on", async ({ page }) => {
    await serveLaneOnly(page, PLAN_RUN_ID);
    await openLane(page, PLAN_RUN_ID);
    await page.getByTestId("stage-card-plan").click();
    await expect(page.getByTestId("prebuild-panel")).toBeVisible();

    /*
     * THE LIMIT ON "REPLACING THIS", AND IT IS LOAD-BEARING. Taken literally the
     * ask would hide `PlanDialoguePanel` — the surface a run STOPPED on a question
     * is answered from. Clicking a card on the canvas would then cost the owner
     * the only control that can un-stick his own run. MUTATION: move
     * `PlanDialoguePanel` inside the `!planPanelOpen` branch.
     */
    await expect(page.getByTestId("plan-question-PQ-1")).toBeVisible();
  });

  test("a live run's pending sections still say what is coming", async ({ page }) => {
    await serveLaneOnly(page, PLAN_RUN_ID, [LANE_ROWS[0] as RunEvent]);
    await openLane(page, PLAN_RUN_ID);
    await page.getByTestId("stage-card-plan").click();

    /*
     * THE CONTROL FOR THE TEST ABOVE, AND FOR THE WHOLE `runIsActive` BRANCH. This
     * run is `awaiting_input`, which is not terminal, so the forward-looking
     * sentences are TRUE here and must survive. A blanket "never promise anything"
     * would pass the dead-run test and silently blank a live one.
     */
    const panel = page.getByTestId("prebuild-panel");
    await expect(panel).not.toContainText("The run ended before this was mentioned.");
    await expect(panel).not.toContainText("never ran");
    await expect(page.getByTestId("stage-card-plan")).toHaveAttribute("data-state", "working");
  });
});

test.describe("a finished run, opened cold", () => {
  test("the card and the panel are whole out of the snapshot alone", async ({ page }) => {
    await serveLane(page, FINISHED_RUN_ID);
    await openCanvas(page, FINISHED_RUN_ID);

    /*
     * THE REPLAY HALF. This run is `failed`, so `use-run-stream.ts` never
     * constructs an EventSource — there is no live `trace` for anything here to
     * have been derived from. Every word below came out of
     * `GET /api/runs/:id/graph`.
     *
     * MUTATION: source the panel's `members` from `trace` instead of
     * `graph.stages` on the run page. `trace` is empty on a terminal run, so the
     * panel renders its empty state and every assertion below goes red. That is
     * exactly how the pre-build lane shipped blank once already.
     */
    await page.getByTestId("stage-card-plan").click();
    const panel = page.getByTestId("prebuild-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-testid^="plan-section-"]')).toHaveCount(5);
    await expect(page.getByTestId("plan-section-author")).toContainText("spec seat — anthropic");
    await expect(page.getByTestId("plan-section-freeze")).toContainText("sealed suite 7f3a91");
    await expect(panel).not.toContainText("The run has not said anything about this yet.");
  });

  test("an untouched run draws no lane at all — the control for every test above", async ({
    page,
  }) => {
    /*
     * NO `serveLane` HERE, AND THAT IS THE POINT. The harness's own fixture
     * carries no `phase` row and no recognised sentence, so `foldGraph` produces a
     * state with no `stages` key — the shape every run recorded before the phases
     * existed folds to, and the one this canvas must draw exactly as it always did.
     *
     * It is also the proof that the interception in the other tests fires: if
     * `page.route` were silently doing nothing, this page and those pages would be
     * the same page, and both this `toHaveCount(0)` and their counts could not be
     * green at once.
     */
    await openCanvas(page, FINISHED_RUN_ID);

    await expect(page.locator('[data-testid^="stage-card-"]')).toHaveCount(0);
    await expect(page.locator("path.lane-conduit")).toHaveCount(0);
    // The delegation graph is exactly what it was without a lane.
    await expect(page.locator("path.conduit-core")).toHaveCount(4);
  });
});

test.describe("what an agent last said", () => {
  test("the builder's own prose is on its card", async ({ page }) => {
    await serveLane(page, BUILD_RUN_ID);
    await openCanvas(page, BUILD_RUN_ID);

    /*
     * ASK B, THE HALF THAT EXISTS. `graph_narration` is one assistant turn; the
     * thinking blocks are measured unavailable (7,037 in the corpus, zero
     * non-empty, encrypted), so this is the model's prose and nothing else. The
     * entry's `name` is `""`, so a card branching on the name draws nothing.
     */
    await expect(
      page.getByTestId("rf__node-builder").getByTestId("node-narration"),
      "the builder's narration is not on its card",
    ).toContainText("Reading the frozen suite before I touch the canvas");

    // And a node that never narrated does not sprout an empty block.
    await expect(
      page.getByTestId("rf__node-reviewer").getByTestId("node-narration"),
    ).toHaveCount(0);
  });
});

/**
 * THE INVISIBLE MARKER, WHICH SHIPPED ONCE AND MUST NOT AGAIN.
 *
 * `spec-pipeline.unit.spec.ts` holds this check for `orchestration-canvas.tsx`,
 * where the stage colours used to live: the running marker was written `bg-run`,
 * no `--color-run` exists in the theme, Tailwind emitted nothing, and the ONE
 * stage a reader is looking for had no marker at all. Moving the table into
 * `stage-node.tsx` would have moved it out from under that check — the scan would
 * still pass, over a file that no longer contains the colours. So it is repeated
 * here, over the files that do.
 *
 * BOTH FILES, SINCE 2026-08-04. The rollup chip and the progress rail live in
 * `stage-node.tsx`; the panel's row states, its left rules and its tinted active
 * row live in `run/prebuild-panel.tsx`. Scanning only the first would leave half
 * the new colour classes unchecked, which is the same gap that let `bg-run` ship.
 *
 * The assertion is on the class string rather than on pixels because a colour that
 * does not exist cannot be told from a colour that is dark, and the defect is the
 * former.
 */
test("no stage colour names something the theme does not define", async () => {
  const fs = await import("node:fs");
  const FILES = [
    "src/components/canvas/stage-node.tsx",
    "src/components/run/prebuild-panel.tsx",
  ];
  const unknownByFile: Record<string, string[]> = {};

  for (const path of FILES) {
    const raw = fs.readFileSync(path, "utf8");
    /*
     * COMMENTS ARE STRIPPED FIRST, and finding out why cost one red run worth
     * having: these files' own docblocks NAME the defect ("that shipped once, as
     * `bg-run`"), so a scan of the raw text reports `run` — the check failing on
     * the prose that explains it. The class attributes are what render; the
     * paragraphs about them are not.
     */
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

    // The palette, from `globals.css`. `run` is deliberately absent — it never existed.
    const DEFINED = [
      "accent", "accent-dim", "canvas", "fail", "fail-dim", "info", "info-dim",
      "ink", "ink-dim", "ink-faint", "line", "line-strong", "pass", "pass-dim",
      "surface", "surface-raised", "warn", "warn-dim",
    ];
    // `bg-`, `border-` and `text-` all take a colour, and the stage's state marker
    // uses all three — the dot is a background, the chip is a border and the label
    // is a foreground, so scanning only `bg-` would leave two thirds of the table
    // unchecked.
    const used = [...source.matchAll(/\b(?:bg|border|text)-([a-z][a-z-]*)(?:\/\d+)?\b/g)]
      .map((match) => match[1] ?? "")
      // `border-l-accent` captures `l-accent`: the side token is part of the
      // utility, not of the colour, and the panel's left rules all carry one.
      .map((name) => name.replace(/^[tblrxy]-/, ""))
      // `border-l-2` leaves nothing behind once the side token is stripped: it is
      // a width, not a colour.
      .filter((name) => name !== "");
    unknownByFile[path] = [...new Set(used)].filter(
      (name) =>
        !DEFINED.includes(name) &&
        // Tailwind keywords that share the prefix and name no colour: the side
        // suffixes (`border-t`), the styles (`border-dashed`), the alignments, and
        // the `border-l-` colour utilities' own side token.
        ![
          "transparent", "current", "black", "white",
          "t", "b", "l", "r", "x", "y",
          "dashed", "solid", "dotted", "none", "left", "right", "top", "bottom",
          "center", "wrap", "nowrap", "balance", "pretty", "clip", "ellipsis",
          // `text-lede` and `text-title` are the type scale, not colours.
          "lede", "title",
        ].includes(name),
    );
  }

  expect(
    unknownByFile,
    "a colour class naming no theme colour renders NOTHING — an invisible marker on the one stage that matters",
  ).toEqual({
    "src/components/canvas/stage-node.tsx": [],
    "src/components/run/prebuild-panel.tsx": [],
  });
});
