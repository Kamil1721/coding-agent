/**
 * The motion-reference field, asserted ON THE WIRE, and the notice it falsified.
 *
 * TWO CLAIMS, AND THEY PULL IN OPPOSITE DIRECTIONS. A filled field must reach
 * `POST /api/runs`; an empty one must leave the key ABSENT rather than send
 * `null` or `""`. The second is not tidiness:
 * `model-picker.browser.spec.ts:196` asserts the WHOLE request body with
 * `toEqual`, so an unconditional `motionUrl` turns five specs red that have
 * nothing to do with motion, and `ticket-references.browser.spec.ts` records the
 * same hazard for `references`. Absence is a thing only a test can see — it is
 * invisible on screen and it compiles either way.
 *
 * EVERY ASSERTION HERE ANCHORS ON A CAPTURED BODY FIRST. `creates` is checked to
 * have exactly one entry before the key is examined, because "no motionUrl was
 * sent" and "nothing was sent at all" are the same green otherwise — a form
 * broken so badly it cannot submit would pass an absence assertion perfectly.
 *
 * THE THIRD CLAIM IS ABOUT PROSE. The capture disclosure promised "never a
 * comparison against the live page", and the motion reference is captured
 * precisely so a build can later be held to what it measured. Asserting only
 * that the old sentence is GONE would pass if the whole disclosure vanished, so
 * the replacement is asserted present in the same test.
 *
 * IT SERVES ITS OWN API through `page.route`, following `model-picker`,
 * `design-lock` and `ticket-references`: the shared fixture serves the canvas
 * specs, and a form-intake fixture belongs to the file that intakes.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ModelOption } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const CREATED_RUN = "harness-motion-run";

const MODELS: readonly ModelOption[] = [
  {
    id: "sonnet",
    label: "Sonnet (claude-sonnet-5)",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
];

interface Harness {
  /** Every `POST /api/runs` body, in order. Empty means nothing was submitted. */
  readonly creates: unknown[];
}

async function serve(page: Page): Promise<Harness> {
  const creates: unknown[] = [];

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
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (path === "/api/models") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MODELS),
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...RUN_DETAIL, runId: CREATED_RUN }),
    });
  });

  await page.goto("/");
  await expect(ticketBox(page)).toBeVisible();
  return { creates };
}

/**
 * THE FIRST TEXTBOX ON THE PAGE, WHICH IS NOT AN INCIDENTAL CHOICE.
 * `ticket-references.browser.spec.ts` addresses the brief the same way, and the
 * motion field is the second textbox this form has ever had. The ordering test
 * below is what keeps that idiom true.
 */
const ticketBox = (page: Page) => page.getByRole("textbox").first();

/** The motion field, addressed through its VISIBLE label and nothing else. */
const motionBox = (page: Page) => page.getByLabel(/animation you want matched/i);

async function typeTicket(page: Page, text: string): Promise<void> {
  await ticketBox(page).click();
  await ticketBox(page).fill(text);
}

test("an empty motion field sends NO motionUrl key at all", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "Build a one-page site for a bike shop.");

  await page.getByRole("button", { name: /start run/i }).click();
  // ANCHORED FIRST: without this, a form that cannot submit at all passes the
  // absence assertion below.
  await expect.poll(() => harness.creates.length).toBe(1);

  expect(
    Object.hasOwn(harness.creates[0] as object, "motionUrl"),
    "an unconditional `motionUrl` compiles, renders identically, and turns five unrelated " +
      "model-picker specs red — they assert the whole POST body with toEqual",
  ).toBe(false);
});

test("a filled motion field reaches the wire", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "Build a one-page site for a bike shop.");
  await motionBox(page).fill("https://example.com");

  await page.getByRole("button", { name: /start run/i }).click();
  await expect.poll(() => harness.creates.length).toBe(1);

  const body = harness.creates[0] as { motionUrl?: unknown };
  expect(
    body.motionUrl,
    "the field rendered and accepted a URL that never left the browser — the owner would see a " +
      "control that does nothing and a run that never read the page they chose",
  ).toBe("https://example.com");
});

test("the motion field sits BELOW the brief, so `textbox.first()` is still the ticket", async ({
  page,
}) => {
  // `ticket-references.browser.spec.ts:117` and the two accelerator tests in it
  // drive `getByRole("textbox").first()`. A motion panel placed above the Ticket
  // panel would retarget all of them at a URL field and they would fail for a
  // reason nobody would connect to this change. Same hazard the file input's own
  // comment names at `page.tsx`'s intake row.
  await serve(page);
  await expect(motionBox(page)).toBeVisible();
  expect(await ticketBox(page).evaluate((element) => element.tagName)).toBe("TEXTAREA");
});

test("the panel defers what happened to the run's log rather than asserting a reading", async ({
  page,
}) => {
  // THE TENSE IS THE CLAIM. Nothing server-side reads `motionUrl` in the commit
  // that added this field, so a note opening "Read once when the ticket is
  // submitted" would put a false sentence on the form — the same defect as the
  // capture notice below, which this change exists to remove. The note states
  // what any reading is limited to and hands the fact of one to the event
  // stream, following the attachment disclosure's rule that sending a file is
  // not the same as a seat reading it.
  //
  // REWORDED AND REHOUSED 2026-08-05, AND THE CLAIM IS UNTOUCHED. "What the run
  // made of the link is on the run's own event stream" became "What was read
  // from it is shown on the run's own page", behind the field's "i"
  // (`page.tsx`, the `Explain about="what is taken from that page"`). The
  // vocabulary went — no screen in this app is called an event stream — and the
  // deferral did not: the form still declines to say a reading HAPPENED.
  // The regex stops before "own page" because the source renders `&rsquo;`, so
  // "run's" is a typographic apostrophe and an ASCII one would never match.
  await serve(page);
  const deferral = page.getByText(/what was read from it is shown on the run/i);
  await expect(deferral).toBeVisible();

  // `toBeVisible()` IS NOT A CLAIM ABOUT PAINT HERE, AND THAT IS WORTH STATING
  // RATHER THAN LEAVING FOR A READER TO ASSUME. A shut `Explain` body is a
  // clipped 1x1 `sr-only` span, and Playwright reports that VISIBLE — measured
  // on this very sentence, not inferred. So the line above says the sentence is
  // in the tree, and it would say exactly the same for a sentence orphaned there
  // with nothing pointing at it.
  //
  // THE BINDING IS THE ASSERTION WITH TEETH. Hiding this sentence was only ever
  // allowed because the glyph beside the field names it as its description, so a
  // browse-mode screen reader is read it without moving focus. Break that link
  // and the note is deleted for every reader who cannot see the bubble, while
  // the presence check above stays green.
  const bodyId = await deferral.getAttribute("id");
  expect(bodyId, "the Explain body is the element `aria-describedby` names").not.toBeNull();
  await expect(
    page.getByRole("button", { name: "Explain: what is taken from that page" }),
  ).toHaveAttribute("aria-describedby", bodyId ?? "");
});

test("the form no longer promises there is never a comparison against the live page", async ({
  page,
}) => {
  await serve(page);
  await typeTicket(page, "Copy the layout at https://example.com");

  // BOTH HALVES, BECAUSE ABSENCE ALONE IS NOT EVIDENCE. A deleted disclosure, an
  // inverted `linksToAPage` or a broken panel would satisfy the absence below and
  // leave the owner with no statement of what the capture does at all.
  //
  // THE PRESENT HALF IS ASSERTED FIRST (2026-08-09): in the other order the
  // absence is read off a form whose capture note has not rendered yet, and it
  // passes for that reason rather than for the deletion it is about.
  await expect(page.getByText(/the live page is never opened again/i)).toBeVisible();
  await expect(page.getByText(/never a comparison against the live page/i)).toHaveCount(0);
});
