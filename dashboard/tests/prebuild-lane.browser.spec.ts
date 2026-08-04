/**
 * THE PRE-BUILD LANE ON THE CANVAS — Planning ── … ── Orchestrator ── agents.
 *
 * THE OWNER'S ASK, VERBATIM: "the whole Before you build box should be redesigned
 * to be more interactive. I think it should be linked as part of the actual
 * orchestration canvas, except that you should have the build planning, then the
 * line going to the orchestrator. Once that whole process has been done, the
 * orchestrator spawns the other agents. You're still on the actual same canvas,
 * but you don't have the thing where the orchestrator doesn't show."
 *
 * WHAT THIS FILE MEASURES, AND WHY EACH HALF IS NEEDED.
 *
 *   1. THE CHAIN IS DRAWN, WIRED, AND IN ORDER, on a run that has already spawned
 *      agents. Not "a stage card exists" — the x ordering of the cards, the count
 *      of lane links, and the specific link `stage:freeze -> root` by id. A canvas
 *      that drew five disconnected stage cards somewhere on the left would satisfy
 *      any presence check and would be exactly the panel this replaced.
 *   2. IT SURVIVES A RELOAD. `use-run-stream.ts:820-822` never opens an
 *      EventSource for a terminal run, so anything derived from the live `trace`
 *      sink is BLANK on every finished run — which is most of the runs anyone
 *      opens. `FINISHED_RUN_ID` is the harness's terminal fixture and the lane has
 *      to be whole on it, out of the REST snapshot alone.
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
 */

import { expect, test, type Page } from "@playwright/test";

import { foldGraphAll } from "../src/lib/graph";
import type { RunEvent } from "../src/lib/api-types";
import { BUILD_RUN_ID, FINISHED_RUN_ID } from "./fixtures/config";
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

/** The five stage cards this event list produces, left to right. */
const CHAIN = ["plan", "capture", "author", "audit", "freeze"] as const;

async function xOf(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} has no box — it is not on the canvas`).not.toBeNull();
  return box?.x ?? Number.NaN;
}

test.describe("the pre-build lane, on a run that has spawned agents", () => {
  test("draws Planning → … → Orchestrator as wired nodes, left of the graph", async ({
    page,
  }) => {
    await serveLane(page, FINISHED_RUN_ID);
    await openCanvas(page, FINISHED_RUN_ID);

    for (const id of CHAIN) {
      await expect(
        page.getByTestId(`stage-card-${id}`),
        `the ${id} stage is missing — the lane did not reach the canvas`,
      ).toBeVisible();
    }

    /*
     * THE ORCHESTRATOR IS ONE BOX, NOT TWO. `GraphState.stages` carries an
     * `orchestrator` member and this run also has a real root `graph_agent`; the
     * layout drops the stage and lets the chain land on the root card, because
     * two orchestrator boxes would be the canvas inventing a hand-off between an
     * agent and itself.
     */
    await expect(
      page.getByTestId("stage-card-orchestrator"),
      "the lane drew its own orchestrator card beside the root card — that is two boxes for one actor",
    ).toHaveCount(0);

    /*
     * THE ORDER, MEASURED IN PIXELS. Presence proves nothing about a CHAIN: five
     * cards stacked at one x would pass every check above. Each stage is left of
     * the next, and the last of them is left of the orchestrator's own card.
     */
    const xs: number[] = [];
    for (const id of CHAIN) xs.push(await xOf(page, `stage-card-${id}`));
    const rootX = await xOf(page, "rf__node-root");
    for (let index = 0; index + 1 < xs.length; index += 1) {
      expect(
        xs[index],
        `${CHAIN[index]} is not to the left of ${CHAIN[index + 1]}`,
      ).toBeLessThan(xs[index + 1] ?? Number.NaN);
    }
    expect(
      xs[xs.length - 1],
      "the last pre-build stage is not to the left of the orchestrator",
    ).toBeLessThan(rootX);

    /*
     * THE LINKS. Four between the five stages, and ONE INTO THE ORCHESTRATOR —
     * which is the line the ask is about ("then the line going to the
     * orchestrator"). `lane-conduit` is the lane's own path class, so this cannot
     * be satisfied by delegation edges, and the id below pins the endpoints: the
     * count alone would pass against a chain wired to the wrong card.
     */
    await expect(page.locator("path.lane-conduit")).toHaveCount(5);
    await expect(
      page.locator('path[id="stage_freeze-_root-lane"]'),
      "there is no link from the last pre-build stage to the orchestrator",
    ).toHaveCount(1);

    // And the agent graph is untouched: the delegation edges are still four exact
    // conduits plus the one inferred guess (`finished-run.browser.spec.ts`).
    await expect(page.locator("path.conduit-core")).toHaveCount(4);
    await expect(page.locator("path.conduit-guess")).toHaveCount(1);
  });

  test("each stage carries the state and the sentence the server wrote", async ({ page }) => {
    await serveLane(page, FINISHED_RUN_ID);
    await openCanvas(page, FINISHED_RUN_ID);

    /*
     * CONTENT, NOT PRESENCE. `detail` is the server's own log line, carried
     * verbatim through the fold; a lane rebuilt from a hard-coded label table
     * would draw five cards reading "Spec seat" and nothing else.
     */
    await expect(page.getByTestId("stage-card-author")).toContainText(
      "spec seat — anthropic: 14 input",
    );
    await expect(page.getByTestId("stage-card-capture")).toContainText(
      "captured https://kamilborzecki.dev",
    );
    await expect(page.getByTestId("stage-card-freeze")).toContainText("sealed suite 7f3a91");

    // The state is on the card as a word AND as an attribute the fold decided.
    for (const id of CHAIN) {
      await expect(page.getByTestId(`stage-card-${id}`)).toHaveAttribute("data-state", "done");
    }
  });

  test("opening a stage is what the click does, and it shows the whole line", async ({
    page,
  }) => {
    await serveLane(page, FINISHED_RUN_ID);
    await openCanvas(page, FINISHED_RUN_ID);

    const card = page.getByTestId("stage-card-author");
    const shell = page.getByTestId("rf__node-stage:author").getByRole("button");

    await expect(card).toContainText("open");
    await expect(shell).toHaveAttribute("aria-pressed", "false");

    const closed = await card.boundingBox();
    await card.click();

    await expect(card).toContainText("close");
    await expect(shell).toHaveAttribute("aria-pressed", "true");

    /*
     * THE CARD GREW, which is the difference between a clamped line and the whole
     * one. The seat's token line runs past two lines at this width, so an opened
     * card that did not get taller would be a state flag with no disclosure behind
     * it.
     */
    const opened = await card.boundingBox();
    expect(opened?.height ?? 0).toBeGreaterThan(closed?.height ?? 0);
  });
});

test.describe("a finished run, opened cold", () => {
  test("still has its whole pre-build lane, out of the snapshot alone", async ({ page }) => {
    await serveLane(page, FINISHED_RUN_ID);
    await openCanvas(page, FINISHED_RUN_ID);

    /*
     * THE REPLAY HALF. This run is `failed`, so `use-run-stream.ts` never
     * constructs an EventSource — there is no live `trace` for anything here to
     * have been derived from. Every card, every state and every link below came
     * out of `GET /api/runs/:id/graph`.
     *
     * The mutation that reddens it is `use-run-graph.ts` dropping `stages` from
     * the snapshot it dispatches, which is exactly how this shipped before this
     * change: the lane folded on the server, serialised, arrived, and was thrown
     * away one line before the canvas.
     */
    for (const id of CHAIN) {
      await expect(page.getByTestId(`stage-card-${id}`)).toBeVisible();
    }
    await expect(page.locator("path.lane-conduit")).toHaveCount(5);
    await expect(page.getByTestId("stage-card-author")).toContainText("spec seat — anthropic");
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
     * the same page, and both this `toHaveCount(0)` and their `toHaveCount(5)`
     * could not be green at once.
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
 * here, over the file that does.
 *
 * The assertion is on the class string rather than on pixels because a colour that
 * does not exist cannot be told from a colour that is dark, and the defect is the
 * former.
 */
test("no stage colour names something the theme does not define", async () => {
  const raw = await import("node:fs").then((fs) =>
    fs.readFileSync("src/components/canvas/stage-node.tsx", "utf8"),
  );
  /*
   * COMMENTS ARE STRIPPED FIRST, and finding out why cost one red run worth
   * having: this file's own docblock NAMES the defect ("that shipped once, as
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
  const used = [...source.matchAll(/\b(?:bg|border|text)-([a-z][a-z-]*)(?:\/\d+)?\b/g)].map(
    (match) => match[1] ?? "",
  );
  const unknown = [...new Set(used)].filter(
    (name) =>
      !DEFINED.includes(name) &&
      // Tailwind keywords that share the prefix and name no colour: the side
      // suffixes (`border-t`), the styles (`border-dashed`) and the alignments.
      ![
        "transparent", "current", "black", "white",
        "t", "b", "l", "r", "x", "y",
        "dashed", "solid", "dotted", "none", "left", "right", "top", "bottom",
        "center", "wrap", "nowrap", "balance", "pretty", "clip", "ellipsis",
      ].includes(name),
  );
  expect(
    unknown,
    "a colour class naming no theme colour renders NOTHING — an invisible marker on the one stage that matters",
  ).toEqual([]);
});

