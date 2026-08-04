/**
 * THE TICKET SCREEN AFTER THE REDUNDANCY PASS, AND SPECIFICALLY WHAT SURVIVED IT.
 *
 * The owner's complaint was "a lot of redundant information", and the obvious way
 * to satisfy it is a blanket delete. Two of the sentences on that form are not
 * decoration: an attached file changes the ticket id, so it changes which frozen
 * suite the build is graded against; and the sealed scorer runs with no network,
 * so a criterion that needs a payment provider or a hosted database is graded
 * against a stub rather than against the thing. Both change what a person WRITES,
 * which is why they are on a form and not in a doc.
 *
 * SO EVERY TEST HERE HAS TWO HALVES, and that is the whole design of the file.
 * "The prose is gone" passes just as well against a form that deleted everything,
 * and "the rule is visible" passes just as well against a form that never made it
 * conditional and shows it on an empty screen. Neither half is evidence on its
 * own. The pair is: a specific sentence absent AND a specific sentence present, or
 * a rule absent BEFORE its trigger and present AFTER it.
 *
 * `getByText` COUNT 0 IS DELIBERATELY NOT `not.toBeVisible()`. A conditional that
 * renders the paragraph with `hidden` would satisfy the second and not the first,
 * and a reader with a screen reader would still be read the sentence this pass
 * exists to remove.
 *
 * IT SERVES ITS OWN API through `page.route`, following `model-picker`,
 * `design-lock`, `ticket-references` and `ticket-motion`: the shared fixture
 * serves the canvas specs, and a form-intake fixture belongs to the file that
 * intakes.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ModelOption } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const CREATED_RUN = "harness-redundancy-run";

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

/** A real 1x1 PNG, so the intake's type filter and its decoder both see an image. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

/** The brief. First textbox on the page, the idiom every ticket spec shares. */
const ticketBox = (page: Page) => page.getByRole("textbox").first();

/** The one file input, which both kinds of attachment go through. */
const fileInput = (page: Page) => page.locator('input[type="file"]').first();

/** The sentence that says an attachment re-keys the ticket. */
const identityRule = (page: Page) =>
  page.getByText(/a different file makes this a different ticket, with its own tests/i);

/** The sentence that says the first link is read once and never re-read. */
const captureRule = (page: Page) =>
  page.getByText(/the live page is never opened again/i);

/** The sentence that says the grader has no network and no logins. */
const gateRule = (page: Page) =>
  page.getByText(/graded against a stub/i);

async function attachPng(page: Page, name: string): Promise<void> {
  await fileInput(page).setInputFiles({
    name,
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(page.getByTitle(name)).toBeVisible();
}

test("the form still submits a brief AND an attachment after the cut", async ({
  page,
}) => {
  // THE FIRST THING A COPY PASS CAN BREAK IS THE FORM. Every other assertion in
  // this file reads text off a screen, and a screen renders its text perfectly
  // well when the submit path is dead. This test is the anchor for all of them.
  const harness = await serve(page);
  await ticketBox(page).fill("Rebuild the booking flow so a slot can be held for ten minutes.");
  await attachPng(page, "moodboard.png");

  await page.getByRole("button", { name: /start run/i }).click();
  await expect.poll(() => harness.creates.length).toBe(1);

  const body = harness.creates[0] as {
    ticketText?: unknown;
    references?: unknown;
    designLock?: unknown;
    deploy?: unknown;
  };
  expect(body.ticketText).toBe(
    "Rebuild the booking flow so a slot can be held for ten minutes.",
  );
  // THE ATTACHMENT IS ASSERTED ON THE WIRE, not as a chip on screen. The chip is
  // rendered from a `File` the browser already holds; only the request body can
  // show that the bytes were read, encoded and sent. A form that drew the chip
  // and dropped the data URL would look completely correct.
  expect(Array.isArray(body.references)).toBe(true);
  expect((body.references as readonly string[])[0]).toMatch(/^data:image\/png;base64,/);
  // The two controls whose LABELS this pass rewrote still send the values they
  // sent before it. `model-picker.browser.spec.ts:196` asserts this whole body
  // with `toEqual`, so a label edit that reached the state would break five
  // specs about models.
  expect(body.designLock).toBe("ask");
  expect(body.deploy).toBe(false);
});

test("the identity rule is absent until there is a file, then present", async ({
  page,
}) => {
  // BOTH HALVES, AND THE FIRST HALF IS THE ONE WITH TEETH. An unconditional
  // paragraph passes the second assertion and fails the first, which is exactly
  // the state this pass moved the form OUT of: a permanent lecture about
  // attachments on a form with no attachment.
  await serve(page);
  await expect(identityRule(page)).toHaveCount(0);

  await attachPng(page, "brand-sheet.png");
  await expect(identityRule(page)).toBeVisible();

  // AND IT GOES AWAY AGAIN. Removing the last chip returns the form to the state
  // the sentence does not describe. Without this, a guard written as
  // "has ever had a file" would pass everything above.
  await page.getByRole("button", { name: /remove brand-sheet\.png/i }).click();
  await expect(identityRule(page)).toHaveCount(0);
});

test("the capture rule is absent until the brief links somewhere, and keeps the unreachable clause", async ({
  page,
}) => {
  await serve(page);
  await expect(captureRule(page)).toHaveCount(0);

  await ticketBox(page).fill("Copy the booking flow at https://example.com onto our stack.");
  await expect(captureRule(page)).toBeVisible();

  // THE CLAUSE THE DESIGN SPEC WANTED CUT. `linksToAPage` is a presence test; the
  // server refuses localhost and private ranges and can time out, and on those
  // paths the run warns rather than refusing the submission. Without this
  // sentence the paragraph asserts a capture that did not happen, which is the
  // defect `page.tsx`'s own comment at the capture note exists to refuse.
  await expect(
    page.getByText(/if the page cannot be reached the run says so/i),
  ).toBeVisible();
});

test("the redundant prose is gone and the load-bearing prose is not", async ({
  page,
}) => {
  // THE PAIRING IS THE POINT. Four absences on their own are satisfied by an
  // empty page; two presences on their own are satisfied by the form nobody
  // changed. Asserted together, they say the cut was surgical.
  await serve(page);

  // Cut: restated the panel subtitle three inches above it in longer words.
  await expect(
    page.getByText(/ambiguity here becomes an untestable criterion/i),
  ).toHaveCount(0);
  // Cut: tutorial text for an affordance that refuses nothing when undiscovered.
  await expect(
    page.getByText(/paste and drop them into the brief above/i),
  ).toHaveCount(0);
  // Cut: an unchecked checkbox states its own default.
  await expect(page.getByText(/off by default/i)).toHaveCount(0);
  // Cut: the panel header that named a department above a checkbox already
  // ending "when it passes".
  await expect(page.getByRole("heading", { name: "Delivery" })).toHaveCount(0);

  // Kept, permanently and unconditionally, because nothing on this client can
  // tell which briefs need it and a person reads it while deciding what to write.
  await expect(gateRule(page)).toBeVisible();
  // Kept verbatim: `ticket-motion.browser.spec.ts:122` drives this field by label.
  await expect(page.getByLabel(/animation you want matched/i)).toBeVisible();
  // Kept: the panel subtitle is the one sentence that changes the output.
  await expect(
    page.getByText(/describe what you want built, and how you will know it works/i),
  ).toBeVisible();
});

test("three option panels became one, with every control still in it", async ({
  page,
}) => {
  const harness = await serve(page);

  await expect(page.getByRole("heading", { name: "Options" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Motion reference" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Design" })).toHaveCount(0);

  // THE CONTROLS ARE ASSERTED INSIDE THE MERGED PANEL, not merely somewhere on
  // the page. A merge that left the radio group behind in a fourth panel would
  // satisfy a page-wide lookup and would not be the merge.
  const options = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Options" }) });
  await expect(options.getByLabel(/animation you want matched/i)).toBeVisible();
  await expect(options.getByRole("radiogroup", { name: "Mockups" })).toBeVisible();
  await expect(options.getByRole("checkbox")).toBeVisible();

  // AND THEY STILL DRIVE THE WIRE. The panel merge moved three controls into a
  // new DOM parent; a state binding dropped in the move is invisible on screen,
  // because an unchecked checkbox and a checkbox wired to nothing look the same.
  await ticketBox(page).fill("Ship the pricing page.");
  await options.getByLabel(/animation you want matched/i).fill("https://stripe.com");
  await options.getByLabel(/let ui-designer pick/i).check();
  await options.getByRole("checkbox").check();

  await page.getByRole("button", { name: /start run/i }).click();
  await expect.poll(() => harness.creates.length).toBe(1);
  expect(harness.creates[0]).toMatchObject({
    motionUrl: "https://stripe.com",
    designLock: "auto",
    deploy: true,
  });
});
