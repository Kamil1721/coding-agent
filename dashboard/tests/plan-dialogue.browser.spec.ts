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
 * M13 `components/run/plan-dialogue.tsx` — `submit` clears the textarea without
 *     waiting for the post to resolve, which is what it did first. "a refused
 *     send keeps the words he typed" goes red with an empty box.
 * M14 `runs/[runId]/page.tsx` — the notice gated on `!planParked` again instead
 *     of `!planAnswerable`. "a park with no questions in the chat still says the
 *     run is stopped" goes red: a stopped run with nothing on screen saying so.
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
  // POSITIVE CONTROL: the run really is parked, so the suppression is a decision
  // rather than the state never arriving.
  await expect(page.getByText("awaiting input")).toBeVisible();
});

test("the clock says how long, and that running out is not a failure", async ({ page }) => {
  await openParked(page);
  // The fixture parks 4 minutes ago inside a 20-minute window, so the number is
  // read off the park line's own timestamp rather than from a constant.
  await expect(page.getByText(/1[56] minutes left/)).toBeVisible();
  await expect(page.getByText(/carries on and records what it assumed/)).toBeVisible();
  // THE SECOND CLOCK, WHICH HIS OWN CLICKS MOVE. `turnsUsed` increments on every
  // owner message the dialogue consumes, `MAX_OWNER_TURNS` is 6, and reaching it
  // closes the dialogue on assumptions exactly as the window closing does. The
  // CAP IS NOT ON THE WIRE, so this says the cost rather than showing a number
  // that would be wrong the day the server changes it.
  await expect(page.getByText(/Asking\s+back costs a reply/)).toBeVisible();
});

test("`you decide` posts a decline the server can read as one", async ({ page, request }) => {
  await openParked(page);

  await card(page, "PQ-1").getByRole("button", { name: "you decide", exact: true }).click();
  await expect(card(page, "PQ-1").getByText(/Sent\./)).toBeVisible();

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

test("the panel is capped and scrolls, rather than running off the screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openParked(page);

  /*
   * THE CAP HAS TO BE A LENGTH, NOT A PERCENTAGE, and this test exists because
   * the percentage version LOOKED right in the source and did nothing. The dock
   * is mounted `absolute left-3 top-3` with no height, so its containing block
   * is indefinite and `max-h-[62%]` resolves to `none`. Measured before the fix:
   * 1198.8px of dock inside a 900px viewport, not scrolling, with the document
   * not scrolling either — every row past the fold unreachable by any means.
   */
  const dock = await page
    .getByRole("heading", { name: "Plan", exact: true })
    .evaluate((element) => {
      let node = element.parentElement;
      while (node !== null && !node.className.toString().includes("pointer-events-auto")) {
        node = node.parentElement;
      }
      return node?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY;
    });
  expect(dock).toBeLessThan(900);

  // AND THE PAGE ITSELF STILL DOES NOT SCROLL — `run-layout.browser.spec.ts`
  // owns that property for the canvas and this panel must not break it.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  expect(overflows).toBe(false);
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
   * AND THE DOCK ON ITS OWN, WHICH IS WHAT HE ACTUALLY SEES — not the `<section>`.
   * The panel element is TALLER than the box it is read in (the wrapper scrolls),
   * so screenshotting the section captures rows that are off-screen and makes the
   * result look like more panel than there is. The dock is the visible box.
   */
  const dock = page.locator("div.pointer-events-auto").first();
  await dock.screenshot({ path: `${SHOT_DIR}/plan-panel.png` });
});
