/**
 * Ticket reference attachment, asserted ON THE WIRE.
 *
 * THE DEFECT THIS FILE EXISTS FOR: A CHIP LIST THAT RENDERS AND POSTS NOTHING.
 * Every assertion about the UI — a chip appears, a filename shows, a remove
 * button works — passes perfectly on a control whose files never reach
 * `POST /api/runs`. And the consequence is not cosmetic: a reference is part of
 * the TICKET'S IDENTITY (`ticket.ts#ticketWithReferences` folds the image
 * digests into the id), so a reference that silently fails to attach produces a
 * DIFFERENT ticket id, a different frozen suite, and a run graded against a
 * brief the owner thinks included their image. So every load-bearing assertion
 * below reads the captured request body.
 *
 * THE SECOND THING, AND IT IS NOT SYMMETRIC WITH THE FIRST: an empty attachment
 * list must leave `references` ABSENT from the body, not present as `[]`. The
 * server's `exactOptionalPropertyTypes` contract wants the key missing, and
 * `model-picker.browser.spec.ts` asserts whole POST bodies with `toEqual` — an
 * unconditional `references: []` turns five unrelated specs red. Asserting the
 * key's ABSENCE is the only way this file notices that regression before they do.
 *
 * THE THIRD IS THE KEYBOARD ACCELERATOR, WHICH IS TWO CLAIMS, NOT ONE. Plain
 * Enter must NOT submit — the ticket placeholder is deliberately multi-paragraph
 * and a form that posts on Enter eats half-written tickets. Cmd/Ctrl-Enter must
 * submit, and must submit ONCE. Both are checked against `creates`, because
 * "nothing was posted" is a claim about the wire and nothing else can see it.
 *
 * IT SERVES ITS OWN API through `page.route`, following `model-picker` and
 * `design-lock`: the shared fixture serves the canvas specs, and a form-intake
 * fixture belongs to the file that intakes.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ModelOption } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const CREATED_RUN = "harness-refs-run";

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

/** The smallest valid PNG, so the data URL is a real one the server would accept. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
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

const ticketBox = (page: Page) => page.getByRole("textbox").first();

async function typeTicket(page: Page, text: string): Promise<void> {
  await ticketBox(page).click();
  await ticketBox(page).fill(text);
}

/** Attach through the file input the intake control owns, whether or not it is visible. */
async function attach(page: Page, names: readonly string[]): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(
    names.map((name) => ({ name, mimeType: "image/png", buffer: PNG_BYTES })),
  );
}

test("a reference actually reaches the wire — chips are not evidence", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "Rebuild the landing page to match the attached reference.");
  await attach(page, ["hero.png"]);

  await page.getByRole("button", { name: /start run/i }).click();
  await expect.poll(() => harness.creates.length).toBe(1);

  const body = harness.creates[0] as { references?: readonly string[] };
  expect(
    body.references,
    "the chip rendered but the file never reached the POST — the run would be graded against a " +
      "different ticket id than the owner believes they submitted",
  ).toBeDefined();
  expect(body.references).toHaveLength(1);
  expect(body.references?.[0] ?? "").toMatch(/^data:image\/png;base64,/);
});

test("NO attachment leaves `references` absent, not an empty array", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "A ticket with no reference at all.");

  await page.getByRole("button", { name: /start run/i }).click();
  await expect.poll(() => harness.creates.length).toBe(1);

  // Not `toEqual([])` — the KEY must be missing. `exactOptionalPropertyTypes` on
  // the server wants absence, and model-picker asserts whole bodies with toEqual.
  expect(
    Object.hasOwn(harness.creates[0] as object, "references"),
    "an unconditional `references: []` compiles, renders identically, and turns five unrelated " +
      "model-picker specs red",
  ).toBe(false);
});

test("plain Enter does NOT submit — the ticket box is deliberately multi-paragraph", async ({
  page,
}) => {
  const harness = await serve(page);
  await typeTicket(page, "First paragraph of a brief.");
  await ticketBox(page).press("Enter");
  await ticketBox(page).type("Second paragraph.");

  // A short settle, so "nothing was posted" is a measurement rather than a race.
  await page.waitForTimeout(300);
  expect(
    harness.creates,
    "Enter submitting would post half-written tickets, and a ticket is frozen into a suite",
  ).toHaveLength(0);
  expect(await ticketBox(page).inputValue()).toContain("Second paragraph.");
});

test("Cmd/Ctrl-Enter submits, and submits exactly ONCE", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "Ship it.");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await ticketBox(page).press(`${modifier}+Enter`);
  await expect.poll(() => harness.creates.length).toBe(1);

  // A second hit must not create a second run. The guard is `submitting`, and a
  // double-submit here spends the owner's quota twice on one ticket.
  await ticketBox(page).press(`${modifier}+Enter`).catch(() => {});
  await page.waitForTimeout(400);
  expect(harness.creates).toHaveLength(1);
});
