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
 * own. The pair is: a specific sentence absent AND a specific sentence present,
 * or a rule unpainted until it is asked for and painted the moment it is.
 *
 * `getByText` COUNT 0 IS DELIBERATELY NOT `not.toBeVisible()`, FOR EVERY SENTENCE
 * THIS PASS CUT. A conditional that renders the paragraph with `hidden` would
 * satisfy the second and not the first, and a reader with a screen reader would
 * still be read the sentence the cut exists to remove. A cut sentence is gone
 * from the screen AND out of the tree, so count 0 is the honest assertion for it
 * and stays.
 *
 * THE IDENTITY RULE IS NOW THE EXCEPTION, AND IT IS AN INVERSION RATHER THAN AN
 * EXEMPTION (2026-08-05, the prose pass). That sentence was not cut: it moved
 * behind the intake's "i" and is `sr-only` FROM FIRST PAINT, on purpose — a
 * screen-reader user has to be able to reach it BEFORE deciding to attach, and a
 * sighted reader must not be lectured about attachments on a form he has not
 * touched. Against that form, count 0 asserts the sentence was DELETED, which is
 * the one outcome this file exists to refuse. What the old assertion MEANT — not
 * shown until it applies — is measured directly instead, as the sentence's
 * rendered box.
 *
 * AND THE BOX IS MEASURED BECAUSE `toBeVisible()` CANNOT SAY THIS. A shut
 * `Explain` body is a clipped 1x1 `sr-only` span and Playwright reports it
 * VISIBLE; that was measured on this page, not assumed, and it is why two
 * assertions below read a `getBoundingClientRect` instead.
 *
 * IT SERVES ITS OWN API through `page.route`, following `model-picker`,
 * `design-lock`, `ticket-references` and `ticket-motion`: the shared fixture
 * serves the canvas specs, and a form-intake fixture belongs to the file that
 * intakes.
 */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

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

/**
 * THE HALF OF THE OFFLINE-GRADING NOTE THAT STAYS ON THE SCREEN: the CONDITION.
 * It is the one line on this form that can stop a payments story being written
 * against a grader that cannot reach a payment provider, so it has to be
 * readable while the brief is being typed. `page.tsx` commits to that in prose;
 * this is the assertion that makes the commitment cost something.
 */
const gateRule = (page: Page) =>
  page.getByText(/grading runs offline, with no logins/i);

/**
 * The other half, which the prose pass moved behind the "i": the CONSEQUENCE.
 * Hidden is allowed for this one — it is read once and changes no wording —
 * and deleted is not, which is why it is asserted at all.
 */
const gateConsequence = (page: Page) =>
  page.getByText(/graded against a stand-in the build wrote itself/i);

/**
 * The largest area, in CSS px², that anything matching `locator` renders.
 *
 * THE ONE MEASUREMENT `toBeVisible()` DOES NOT MAKE. Tailwind's `sr-only` is a
 * 1x1 clipped box, which is visible to Playwright and unreadable to a person, so
 * paint and presence have to be asked about separately on this form. `max`
 * rather than `first()` so a second, painted copy of a sentence cannot hide
 * behind an unpainted one; the callers assert the count as well.
 */
async function paintedArea(locator: Locator): Promise<number> {
  return locator.evaluateAll((elements) =>
    Math.max(
      0,
      ...elements.map((element) => {
        const box = element.getBoundingClientRect();
        return box.width * box.height;
      }),
    ),
  );
}

/**
 * Bigger than a clipped `sr-only` box (1x1) and far below one line of the 11px
 * type this form sets its notes in (~40x14 for three words). A sentence that
 * lands between the two is one a sighted reader can begin to make out, and it
 * fails both bounds, which is the intent.
 */
const UNPAINTED_MAX_AREA = 4;
const PAINTED_MIN_AREA = 200;

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

test("the identity rule is never painted on the form, and is one gesture from being read", async ({
  page,
}) => {
  // WHAT THIS TEST USED TO SAY, AND WHY IT NO LONGER SAYS IT. It read "absent
  // until there is a file, then present", and it asserted count 0 → visible →
  // count 0 across attaching and removing a chip. The form it was written
  // against put the sentence in a paragraph below the chips; the prose pass
  // moved it behind the intake's "i", where it is `sr-only` from first paint and
  // has no conditional state left to observe. Count 0 against THAT form asserts
  // the sentence was deleted — the opposite of what the old test was protecting.
  //
  // THE INTENT SURVIVES INTACT AND IS ASSERTED DIRECTLY: it is not shown to a
  // sighted reader who did not ask for it, and it is not lost to anyone. Both
  // halves are still here, and each still fails on its own kind of regression —
  // a permanent lecture lights up the paint bounds, and a deletion or a
  // `display:none` lights up the count and the on-demand bound at the bottom.
  await serve(page);

  const glyph = page.getByRole("button", { name: "Explain: attaching files" });

  // ONE HOME FOR THE SENTENCE. Two matches would mean the paragraph came back
  // BESIDE the glyph rather than instead of it, which is the redundancy this
  // whole file exists to keep out.
  await expect(identityRule(page)).toHaveCount(1);
  expect(
    await paintedArea(identityRule(page)),
    "a permanent lecture about attachments on a form with no attachment is the state this pass " +
      "moved the form out of",
  ).toBeLessThan(UNPAINTED_MAX_AREA);

  // IT IS A SENTENCE THE PAGE HANDS TO A READER, not text orphaned in the DOM.
  // Hiding it was only allowed because the glyph names this exact element as its
  // description, so a browse-mode screen reader is read it without moving focus.
  // Break that link and the rule is gone for every reader who cannot see the
  // bubble, while every other assertion here stays green.
  const bodyId = await identityRule(page).getAttribute("id");
  expect(bodyId, "the Explain body is the element `aria-describedby` names").not.toBeNull();
  await expect(glyph).toHaveAttribute("aria-describedby", bodyId ?? "");

  // ATTACHING DOES NOT PAINT IT EITHER, and this is the half that inherits the
  // old test's teeth. The paragraph that was cut appeared at the FIRST CHIP —
  // i.e. after the decision it describes — so restoring it would leave the
  // assertion above green and light this one up.
  await attachPng(page, "brand-sheet.png");
  await expect(identityRule(page)).toHaveCount(1);
  expect(
    await paintedArea(identityRule(page)),
    "the sentence is readable while DECIDING to attach; a copy that appears at the first chip is " +
      "the prose this pass removed",
  ).toBeLessThan(UNPAINTED_MAX_AREA);

  // ASKED FOR, IT PAINTS. Without this the two measurements above are satisfied
  // by a `display:none` span or by a sentence no reader can ever reach — that
  // is, by the deletion this file refuses. Polled rather than sampled once
  // because the bubble is placed after it is measured (`explain.tsx` holds it
  // `visibility: hidden` for the frame where its coordinates are still null).
  await glyph.click();
  await expect
    .poll(async () => paintedArea(identityRule(page)))
    .toBeGreaterThan(PAINTED_MIN_AREA);
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
  //
  // MEASURED AS A BOX RATHER THAN WITH `toBeVisible()` (2026-08-05). The note was
  // SPLIT, not cut: the condition stays inline and the consequence went behind an
  // "i". A shut `Explain` body is a clipped 1x1 span that Playwright still calls
  // visible, so `toBeVisible()` alone would go green for a condition that had
  // been hidden along with it — and `page.tsx` is on record refusing exactly that
  // move, on the grounds that this is the only line able to stop a payments story
  // being written against a grader with no network. A commitment no test can
  // break is not a commitment.
  await expect(gateRule(page)).toHaveCount(1);
  await expect(gateRule(page)).toBeVisible();
  expect(
    await paintedArea(gateRule(page)),
    "the condition has to be readable while the brief is being typed; behind the glyph it is not",
  ).toBeGreaterThan(PAINTED_MIN_AREA);
  // And the consequence is HIDDEN, not gone — the wording changed with the move
  // ("a stand-in the build wrote itself" for "a stub"), the fact did not.
  await expect(gateConsequence(page)).toHaveCount(1);
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
