/**
 * plan-dialogue.browser.spec.ts — the parked run, in a browser.
 *
 * WHAT ONLY A BROWSER CAN SHOW HERE. `plan-dialogue.unit.spec.ts` proves the
 * derivation and the composed strings; neither of those says the panel is on
 * screen without a click, that the generic "Waiting on input" notice got out of
 * its way, or that pressing `you decide` puts the right bytes on the wire. Those
 * are the three ways this surface ships looking finished and doing nothing.
 *
 * IT DRIVES THE SHARED FIXTURE, not `page.route`, because the plan panel is fed
 * by TWO channels that have to arrive together — `GET /messages` for the
 * questions and the SSE `/events` stream for the park line the countdown is
 * derived from. `route.fulfill` cannot hold a stream open (see
 * `fixtures/api-server.ts`), so a routed version of this spec would render a
 * panel with no clock and quietly stop measuring the clock.
 *
 * THE FIXTURE'S CHAT IS MUTABLE, which is what makes the send assertion real: the
 * browser posts, the fixture stores, and this spec reads the stored string back
 * out of the same endpoint the app re-fetches from.
 *
 * ─── MUTATIONS RUN, WATCHED FAIL, AND RESTORED ───
 *
 * M7  `runs/[runId]/page.tsx` — the `&& !planParked` gate removed from
 *     `AwaitingInputNotice`. "the generic park notice is out of the way" goes
 *     red: the notice telling him his two moves are resume and cancel renders
 *     directly above the panel where the actual moves are, and a bodyless resume
 *     closes the dialogue with every open question recorded as an assumption.
 * M8  `components/run/plan-dialogue.tsx` — `composeDecline` swapped for
 *     `composeAnswer(id, "you decide")` at the `you decide` button. "you decide
 *     posts a decline the server can read" goes red on the exact wire string.
 *     This is the mutation that matters most: both versions look identical on
 *     screen and only one of them is recorded as a decline.
 * M9  `runs/[runId]/page.tsx` — the `planDialogue !== null` panel block deleted.
 *     Every test in this file goes red.
 * M10 `components/run/plan-dialogue.tsx` — `badgeFor` returns the same badge for
 *     `open` and `answered`. "open and answered are distinguishable" goes red.
 * M11 `runs/[runId]/page.tsx` — the panel's `max-h-[62vh]` put back to the
 *     `max-h-[420px]`-free percentage form the dock uses. "the panel is capped
 *     and scrolls" goes red at 1198.8px of dock in a 900px viewport.
 *     SUPERSEDED 2026-08-05: there is no `max-h` on the dialogue any more and no
 *     dock to put one on. The replacement is M15 below.
 * M13 `components/run/plan-dialogue.tsx` — `submit` clears the textarea without
 *     waiting for the post to resolve, which is what it did first. "a refused
 *     send keeps the words he typed" goes red with an empty box.
 * M14 `runs/[runId]/page.tsx` — the notice gated on `!planParked` again instead
 *     of `!planAnswerable`. "a park with no questions in the chat still says the
 *     run is stopped" goes red: a stopped run with nothing on screen saying so.
 * M15 `canvas/rail.tsx` — `overflow-y-auto` dropped from the panel body. "every
 *     row of the dialogue is reachable" goes red, which is the SAME defect the
 *     deleted `max-h-[62vh]` was measured against by a different mechanism.
 *     RE-PROVED 2026-08-05 against the hardened form, and the numbers are the
 *     point: at 1440x900 the panel body ends at 899 with content down to 1054
 *     (953px of dialogue in a 798px box) and no ancestor scrolling, and BOTH
 *     mechanisms go red there — "155px painted below a box that does not scroll"
 *     and "953 > 798 with overflow-y: visible", each confirmed with the other
 *     disabled. 900 IS THE HEIGHT THAT MATTERS: the form this replaced sampled
 *     the last button, which sits at 663, and was GREEN at 900, 800 and 700
 *     under this same mutation. Red at 600 as well, but 600 was never the test.
 * M16 `runs/[runId]/page.tsx` — `onSendPlanReply` stops calling `sendRunMessage`
 *     (it still refreshes, so the panel behaves as though something happened).
 *     "`you decide` posts a decline the server can read as one" goes red: nothing
 *     reaches the wire and the fixture's transcript never grows.
 *
 * ─── WHAT MOVED UNDER THIS FILE — 2026-08-05 ───
 *
 * THE DIALOGUE IS NOT DOCKED OVER THE CANVAS ANY MORE. It is the rail's Questions
 * panel (`canvas/rail.tsx`, `runs/[runId]/page.tsx:896-923`), which the run page
 * OPENS WITHOUT A CLICK while there is a dialogue to show — so this file's first
 * and load-bearing property, "the questions are on screen without a click", still
 * holds and still passes. Answering is intact: the send path, the decline wire
 * string, the refusal handling and the focus ring were all green throughout.
 *
 * THREE THINGS HAD TO BE REPOINTED, and each is documented at its own test: the
 * park's positive control (`awaiting input` is only rendered by `OverviewPanel`,
 * which is not mounted while Questions is the open panel), the turn bound (moved
 * behind `explain-turns` in the copy pass), and the dock geometry (the panel is
 * capped by construction now, so what is asserted is reachability rather than a
 * length). The confirmation string lost its full stop and took `/Sent\./` with it.
 */

import { expect, test, type Page } from "@playwright/test";

import { PLAN_RUN_ID } from "./fixtures/config";

const SHOT_DIR =
  "/private/tmp/claude-501/-Users-kamilborzecki-Projects-coding-agent/3c01d874-1540-48f7-843f-5e9c0f3adc14/scratchpad";

/** Open the parked run and wait for the panel the park is answered in. */
async function openParked(page: Page): Promise<void> {
  await page.goto(`/runs/${PLAN_RUN_ID}`);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
}

/**
 * The card for one question.
 *
 * BY `data-testid`, NOT BY TEXT, and the first version of this file was by text
 * and did not work: `PQ-1` appears in the card's heading, in its textarea's
 * `aria-label` and inside the strings its buttons compose, so a text filter
 * matched several ancestors and `.first()` picked a wrapper holding every other
 * question. A spec that asserts "PQ-1 is open" while reading PQ-3's controls is
 * a check that cannot go red for the right reason.
 */
function card(page: Page, id: string) {
  return page.getByTestId(`plan-question-${id}`);
}

test("the questions are on screen without a click, in rank order", async ({ page }) => {
  await openParked(page);

  // NO CLICK, NO TAB. A decision the run is stopped on cannot be behind one.
  await expect(page.getByText("How many projects should the grid show?")).toBeVisible();
  await expect(page.getByText("Which of the two images you attached is the one at the top?")).toBeVisible();

  // THE SEAT'S PLAN IS SHOWN AND IT IS SHORT. Two lines, above the questions.
  await expect(page.getByText("what it plans to build")).toBeVisible();
  await expect(page.getByText(/A single-page portfolio/)).toBeVisible();

  // RANK ORDER IS THE SERVER'S, AND IT SURVIVES. PQ-1 is asked before PQ-3.
  const asked = await page
    .locator("text=/^PQ-[13]$/")
    .allTextContents();
  expect(asked).toEqual(["PQ-1", "PQ-3"]);
});

test("open and answered are distinguishable at a glance, per question", async ({ page }) => {
  await openParked(page);

  // THE OWNER'S NAMED WORST OUTCOME. He asked a question about PQ-1 rather than
  // answering it; PQ-1 must still say `open` and must still have a box to type
  // in. PQ-2, which he did answer, must say so and must have neither.
  await expect(card(page, "PQ-1").getByText("open", { exact: true })).toBeVisible();
  await expect(card(page, "PQ-1").getByRole("textbox")).toBeVisible();

  await expect(card(page, "PQ-2").getByText("answered", { exact: true })).toBeVisible();
  await expect(card(page, "PQ-2").getByText("one page is enough")).toBeVisible();
  await expect(card(page, "PQ-2").getByRole("textbox")).toHaveCount(0);
});

test("the generic park notice is out of the way", async ({ page }) => {
  await openParked(page);
  // `AwaitingInputNotice` says the two moves are resume and cancel. On a plan
  // park the moves are answer, decline and ask — and a bodyless resume would
  // close the dialogue on assumptions. Its heading must not be on this screen.
  await expect(page.getByText("Waiting on input")).toHaveCount(0);

  /*
   * POSITIVE CONTROL: the run really is parked, so the suppression above is a
   * decision rather than the state never arriving.
   *
   * IT COSTS A CLICK NOW, AND THE CLICK IS THE HONEST VERSION. `awaiting input`
   * is `statusMeta`'s label (`lib/presentation.ts:84`) and the only surface on
   * this route that renders it is `OverviewPanel` (`canvas/sheet.tsx:760`) —
   * which is NOT mounted here, because the rail auto-opens Questions on a run
   * with a dialogue (`runs/[runId]/page.tsx:567-572`). So this read zero, and
   * the suppression above was being asserted with no proof the run was parked at
   * all: exactly the failure mode this control exists to rule out.
   *
   * WHAT WAS REFUSED AS THE REPLACEMENT: the rail's own Overview icon carries a
   * `warn` status dot on a parked run (`rail.tsx:256-266`), which needs no click.
   * It is a 6px `<span aria-hidden>` with no text — a colour is not the run
   * saying what state it is in, and asserting one would have swapped a broken
   * content check for a check on paint.
   */
  await page.getByTestId("rail-overview").click();
  await expect(
    page.getByTestId("overview-this-run").getByText("awaiting input"),
    "the run is not actually parked, so the notice above was suppressed for nothing",
  ).toBeVisible();
  // And the notice does not come back merely because Overview is the open panel:
  // it floats over the canvas and is gated on the dialogue, not on the panel.
  await expect(page.getByText("Waiting on input")).toHaveCount(0);
});

test("the clock says how long, and that running out is not a failure", async ({ page }) => {
  await openParked(page);
  // The fixture parks 4 minutes ago inside a 20-minute window, so the number is
  // read off the park line's own timestamp rather than from a constant.
  await expect(page.getByText(/1[56] minutes left/)).toBeVisible();
  await expect(page.getByText(/carries on and records what it assumed/)).toBeVisible();

  /*
   * THE SECOND CLOCK, WHICH HIS OWN CLICKS MOVE. `turnsUsed` increments on every
   * owner message the dialogue consumes, `MAX_OWNER_TURNS` is 6
   * (`plan-question.ts:187`), and reaching it closes the dialogue on assumptions
   * exactly as the window closing does. The CAP IS NOT ON THE WIRE, so the copy
   * says the cost rather than showing a number that would be wrong the day the
   * server changes it.
   *
   * IT MOVED BEHIND AN "i" — 2026-08-05, and this assertion followed it rather
   * than being deleted with the sentence. It used to read "Asking back costs a
   * reply, and replies are bounded too" inline; it is now `explain-turns` on the
   * clock. THE FACT IS WHAT WAS BEING GUARDED, so the repair opens the bubble and
   * reads its words. A check that the glyph merely EXISTS would pass over an
   * empty one.
   */
  const turns = page.getByTestId("explain-turns");
  await expect(turns, "the clock has no `i` at all — the turn bound is on no surface").toHaveCount(
    1,
  );
  await turns.click();
  await expect(page.getByTestId("explain-turns-body")).toContainText(
    "use up a small, fixed number of turns",
  );
});

test("`you decide` posts a decline the server can read as one", async ({ page, request }) => {
  await openParked(page);

  await card(page, "PQ-1").getByRole("button", { name: "you decide", exact: true }).click();
  // The confirmation was "Sent. It is still shown as open until the run says what
  // it recorded." and lost its full stop in the 2026-08-05 copy pass
  // (`plan-dialogue.tsx:531`). `/Sent\./` matched nothing, which is why this test
  // failed at the click rather than at the wire assertion below.
  await expect(
    card(page, "PQ-1").getByText(/Sent — it stays open until the run says what it recorded/),
  ).toBeVisible();

  /*
   * READ BACK OFF THE WIRE, NOT OFF THE SCREEN. The whole risk lives in the
   * string: `PQ-1: you decide` renders identically and the real classifier
   * records it as an ANSWER whose words are "you decide", which then counts as a
   * traced answer and can credit a criterion to an owner who declined to state
   * one. Only the bytes can tell the two apart.
   */
  const response = await request.get(
    `http://127.0.0.1:4177/api/runs/${PLAN_RUN_ID}/messages`,
  );
  const body = (await response.json()) as { messages: { role: string; text: string }[] };
  const last = body.messages[body.messages.length - 1];
  expect(last?.role).toBe("owner");
  expect(last?.text).toBe("you decide (PQ-1)");
});

test("a reply ending in a question mark is offered as a question, not an answer", async ({
  page,
}) => {
  await openParked(page);

  const pq3 = card(page, "PQ-3");
  await pq3.getByRole("textbox").fill("six");
  // The primary control mirrors the server's own routing rule, so a plain
  // sentence is an answer…
  await expect(pq3.getByRole("button", { name: "answer", exact: true })).toBeVisible();

  await pq3.getByRole("textbox").fill("which of the two do you mean?");
  // …and a question is a question. `classifyOwnerReply` puts its question-mark
  // rung above its answer rung, so a button reading "answer" here would be the
  // one place the label and the mechanism disagree.
  await expect(pq3.getByRole("button", { name: "ask", exact: true })).toBeVisible();
  await expect(pq3.getByText(/stays open/)).toBeVisible();
});

test("every control is reachable and shows focus", async ({ page }) => {
  await openParked(page);

  const decide = card(page, "PQ-1").getByRole("button", { name: "you decide", exact: true });
  await decide.focus();
  await expect(decide).toBeFocused();
  const outline = await decide.evaluate(
    (element) => getComputedStyle(element).outlineWidth,
  );
  // `globals.css` gives every `:focus-visible` a 2px accent ring. A control that
  // can be tabbed to and shows nothing is not keyboard reachable in practice.
  expect(Number.parseFloat(outline)).toBeGreaterThan(0);
});

/**
 * The questions panel's scroll box, everything painted inside it, and whether
 * anything scrolls to the parts that fall outside.
 *
 * NO SENTINEL ELEMENT. The form this replaced sampled ONE node — the last
 * `<button>` in the last card — and asked whether IT was above the fold. That is
 * not the bottom-most content: `plan-dialogue.tsx` draws the answered card's
 * recorded answer, the decline hint and the panel's own trailing padding BELOW
 * the last control, so a panel could clip ~155px and still report its sentinel
 * comfortably on screen. `contentBottom` is the maximum over every painted
 * descendant instead, so there is no node the measurement can miss.
 */
interface PanelGeometry {
  cards: number;
  /** The bottom edge of the scroll box itself. */
  boxBottom: number;
  /** The bottom edge of the LOWEST painted thing inside it, whatever that is. */
  contentBottom: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  /** The box, or an ancestor of it, actually scrolls. */
  scrollable: boolean;
  panelBottom: number;
  viewport: number;
  /** The node the replaced form sampled. Recorded, and asserted on once, below. */
  sentinelBottom: number;
}

async function measurePanel(page: Page): Promise<PanelGeometry | null> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="rail-panel"]');
    if (panel === null) return null;
    const cards = [...panel.querySelectorAll<HTMLElement>('[data-testid^="plan-question-"]')];
    const first = cards[0];
    if (first === undefined) return null;
    // THE SCROLL BOX BY STRUCTURE, NOT BY CLASS: the panel's direct child that
    // contains the dialogue (`rail.tsx:541`). Naming its Tailwind classes here
    // would make the spec pass the day the class is renamed and the scrolling
    // with it.
    const body = [...panel.children].find((child) => child.contains(first));
    if (!(body instanceof HTMLElement)) return null;

    const boxBottom = body.getBoundingClientRect().bottom;
    let contentBottom = Number.NEGATIVE_INFINITY;
    for (const node of body.querySelectorAll<HTMLElement>("*")) {
      const rect = node.getBoundingClientRect();
      // `display:none` and collapsed wrappers paint nothing, and a closed
      // `<Explain>` body is `sr-only` at 1x1 — neither is content running off
      // the bottom of the box.
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom > contentBottom) contentBottom = rect.bottom;
    }

    // Something that actually scrolls to what falls outside — the box itself or
    // any ancestor of it. The property is "it can be reached", not "this div
    // owns the scrollbar".
    let node: HTMLElement | null = body;
    let scrollable = false;
    while (node !== null) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === "auto" || overflow === "scroll") {
          scrollable = true;
          break;
        }
      }
      node = node.parentElement;
    }

    // THE NODE THE REPLACED FORM SAMPLED, kept so this file can assert that the
    // heights it runs at are still heights where that node was on screen.
    const buttons = cards.flatMap((card) => [...card.querySelectorAll("button")]);
    const send = buttons[buttons.length - 1] ?? null;

    return {
      cards: cards.length,
      boxBottom: Math.round(boxBottom),
      contentBottom: Math.round(contentBottom),
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      overflowY: getComputedStyle(body).overflowY,
      scrollable,
      panelBottom: Math.round(panel.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      sentinelBottom:
        send === null ? Number.POSITIVE_INFINITY : Math.round(send.getBoundingClientRect().bottom),
    };
  });
}

test("every row of the dialogue is reachable, rather than running off the screen", async ({
  page,
}) => {
  /*
   * WHAT THIS USED TO MEASURE, AND WHY THE PROPERTY OUTLIVED IT.
   *
   * The dialogue was docked over the canvas in a `div.pointer-events-auto`
   * mounted `absolute left-3 top-3` with no height, so its containing block was
   * indefinite and `max-h-[62%]` resolved to `none` — the cap LOOKED right in the
   * source and did nothing. Measured before that fix: 1198.8px of dock inside a
   * 900px viewport, not scrolling, with the document not scrolling either; every
   * row past the fold unreachable by any means.
   *
   * The dock is gone (`runs/[runId]/page.tsx` — the dialogue is the rail's
   * Questions panel now) and THE CAP IS STRUCTURAL: the panel is a flex column in
   * an `h-dvh overflow-hidden` shell with `min-h-0 flex-1 overflow-y-auto` on its
   * body (`rail.tsx:541`). Asserting a NUMBER against that would assert the
   * viewport, so what is asserted is the property the number stood in for.
   *
   * ─── WHY THE SENTINEL FORM WAS REPLACED, 2026-08-05 ───
   *
   * The version between those two asked whether the LAST BUTTON was above the
   * fold, at one viewport, 600px. Both halves of that were weak. MEASURED under
   * M15 (`overflow-y-auto` deleted from `rail.tsx:541`) at 1440x900: the box ends
   * at 899, the lowest painted row of the dialogue ends at 1054, computed
   * `overflow-y` is `visible` and NOTHING SCROLLS — 155px of the dialogue
   * unreachable by any means. The old form's sentinel sat at 663, so
   * `bottom < viewport` was TRUE and the assertion was GREEN on that screen. It is
   * green at 800 and 700 for the same reason; 663 only falls off at 600, which is
   * the single height the old form was ever run at. The check agreed with the bug
   * everywhere except the one place it looked.
   *
   * SO THE FORM HERE IS SENTINEL-INDEPENDENT AND RUN AT FOUR HEIGHTS. The
   * invariant is that a box which cannot scroll must not have content below its
   * own bottom edge, stated twice over: once geometrically (`contentBottom` is the
   * max over every painted descendant, not one chosen node) and once against the
   * box's own scroll metrics (`scrollHeight > clientHeight` while computed
   * `overflow-y` is `visible`). Two mechanisms because one of them is a browser
   * semantics question — whether Chromium reports a flex-constrained box with
   * visible overflow as having `scrollHeight > clientHeight` — and a lane whose
   * whole job is un-blinding an assertion should not rest on the answer.
   */
  await openParked(page);

  /*
   * EVERY HEIGHT IS MEASURED BEFORE ANY OF THEM IS ASSERTED, so a failure at the
   * shortest window still leaves the taller ones in the run's output. The first
   * red produced by this test was at 600 only, and reading it that way is what
   * would hide a second, worse reading at 900.
   *
   * WIDTH IS FIXED AT 1440: below 1120px `rail.tsx` switches the panel from a
   * static flex sibling to an absolute overlay, and moving the layout branch and
   * the height at once would measure two things.
   */
  const heights = [600, 700, 800, 900];
  const seen: { height: number; panel: PanelGeometry; documentScrolls: boolean }[] = [];
  for (const height of heights) {
    await page.setViewportSize({ width: 1440, height });
    await expect(card(page, "PQ-1")).toBeVisible();
    await expect(card(page, "PQ-3")).toBeVisible();
    const panel = await measurePanel(page);
    expect(panel, `at ${String(height)}px the dialogue drew no card, so nothing was measured`)
      .not.toBeNull();
    if (panel === null) continue;
    seen.push({
      height,
      panel,
      documentScrolls: await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight,
      ),
    });
  }
  expect(seen.length, "not every viewport was measured").toBe(heights.length);

  for (const { height, panel, documentScrolls } of seen) {
    // THREE CARDS. A dialogue that silently stopped rendering the open questions
    // would fit any box, and must not be able to pass this by being short.
    expect(panel.cards, `at ${String(height)}px the dialogue drew fewer cards than the fixture asks`)
      .toBe(3);
    expect(
      panel.panelBottom,
      `at ${String(height)}px the questions panel runs past the bottom of the window`,
    ).toBeLessThanOrEqual(height);

    // THE INVARIANT, GEOMETRIC FORM: content painted below the box's own bottom
    // edge is only acceptable if something scrolls to it.
    expect(
      panel.contentBottom > panel.boxBottom + 1 && !panel.scrollable,
      `at ${String(height)}px the dialogue paints ${String(
        panel.contentBottom - panel.boxBottom,
      )}px below the bottom of a box that does not scroll`,
    ).toBe(false);

    // THE SAME INVARIANT OFF THE BOX'S OWN SCROLL METRICS.
    expect(
      panel.scrollHeight > panel.clientHeight + 1 && panel.overflowY === "visible",
      `at ${String(height)}px the panel body overflows (${String(panel.scrollHeight)} > ${String(
        panel.clientHeight,
      )}) with overflow-y: ${panel.overflowY}, so the overflow is unreachable`,
    ).toBe(false);

    // AND THE PAGE ITSELF STILL DOES NOT SCROLL — `run-layout.browser.spec.ts`
    // owns that property for the canvas and this panel must not break it.
    expect(documentScrolls, `at ${String(height)}px the document itself scrolls`).toBe(false);
  }

  /*
   * TWO POSITIVE CONTROLS AT THE TALLEST HEIGHT, and they are the reason 900 is in
   * the list at all.
   *
   * FIRST: the invariant above is satisfied for free by a dialogue that FITS its
   * box, so on its own it cannot tell "the panel scrolls" from "there was never
   * anything to scroll". At 900 this fixture paints 953px of dialogue into an
   * 798px box — 155px past the bottom edge — so the scroll is load-bearing at
   * every height in the list. If this reads false the fixture shrank and the loop
   * went vacuous with it.
   *
   * SECOND: 900 is a height where the REPLACED form was blind. Its sentinel, the
   * last `<button>` in the last card, sits at 663 — comfortably on screen — so
   * "the last control is above the fold" was true at 900, 800 and 700 whether or
   * not the panel could scroll. This asserts that 900 is still such a height, so
   * that a fixture change which moves the sentinel below the fold cannot quietly
   * turn this file back into a test that only discriminates at 600.
   */
  const tallest = seen[seen.length - 1];
  expect(tallest?.height).toBe(900);
  expect(
    (tallest?.panel.contentBottom ?? 0) - (tallest?.panel.boxBottom ?? 0),
    "the dialogue now FITS the panel at 900px, so the assertions above measure nothing there",
  ).toBeGreaterThan(100);
  expect(
    (tallest?.panel.sentinelBottom ?? Number.POSITIVE_INFINITY) < 900,
    "the last control now falls off the 900px viewport, so this height no longer proves the sentinel form was blind",
  ).toBe(true);
});

test("a refused send keeps the words he typed", async ({ page }) => {
  await openParked(page);

  /*
   * THE STATE THIS EXISTS FOR IS REAL AND THE SERVER MAKES IT: `PlanDriver.
   * deliver` refuses a record that is no longer awaiting, and `postMessage`
   * refuses a terminal run outright — so the window between painting an open
   * question and clicking its button can close under him. Losing the sentence he
   * had just written to a 409 is the worst possible response to that.
   */
  await page.route("**/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "not_open", message: "this run is no longer parked" }),
    });
  });

  const box = card(page, "PQ-1").getByRole("textbox");
  await box.fill("six of them");
  await card(page, "PQ-1").getByRole("button", { name: "answer", exact: true }).click();

  await expect(page.getByText(/no longer parked/)).toBeVisible();
  // THE ASSERTION. The refusal is on screen AND the answer is still in the box.
  await expect(box).toHaveValue("six of them");
});

test("a park with no questions in the chat still says the run is stopped", async ({ page }) => {
  /*
   * THE ORCHESTRATOR'S OWN CRASH WINDOW, quoted from `#planPhase`: "Parking first
   * leaves it parked with the questions missing from the chat, which the timer
   * resolves on its own by expiring." For that whole park there is no dialogue to
   * derive, so the panel cannot render — and if the generic notice were
   * suppressed on `planParked` rather than on the panel, the screen would show a
   * stopped run and nothing at all about why.
   */
  await page.route("**/messages", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ messages: [] }),
    });
  });

  await page.goto(`/runs/${PLAN_RUN_ID}`);
  await expect(page.getByText("Waiting on input")).toBeVisible();
  // POSITIVE CONTROL: with no questions there is no panel, so the notice is
  // standing in for one rather than doubling it up.
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toHaveCount(0);
});

test("screenshot: the parked run as the owner sees it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openParked(page);
  await expect(page.getByText("How many projects should the grid show?")).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/plan-parked-run.png`, fullPage: false });

  /*
   * AND THE PANEL ON ITS OWN, WHICH IS WHAT HE ACTUALLY SEES — not the
   * `<section>`. The dialogue element is TALLER than the box it is read in (its
   * wrapper scrolls), so screenshotting the section captures rows that are
   * off-screen and makes the result look like more panel than there is. The
   * rail's panel is the visible box.
   *
   * IT WAS `div.pointer-events-auto` and timed out: that class is on the floating
   * notice stack, which is not an ancestor of the dialogue any more and does not
   * render at all on this run. NOTHING HERE IS ASSERTED — this test writes two
   * pngs and nothing else, and it should not be counted as covering a surface.
   */
  const dock = page.getByTestId("rail-panel");
  await dock.screenshot({ path: `${SHOT_DIR}/plan-panel.png` });
});
