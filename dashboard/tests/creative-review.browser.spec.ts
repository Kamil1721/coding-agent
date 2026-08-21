import { expect, test, type Page } from "@playwright/test";

import type { CreativeStatus } from "../src/lib/api-types";
import { API_ORIGIN, RUN_ID } from "./fixtures/config";

function creative(overrides: Partial<CreativeStatus> = {}): CreativeStatus {
  return {
    applicable: true,
    enabled: true,
    contractHash: "a".repeat(64),
    compileOutcome: "passed",
    compileFindings: [],
    renderManifestHash: "b".repeat(64),
    renderFresh: true,
    renderProfiles: [
      { profileId: "desktop", captureCount: 2, complete: true },
      { profileId: "mobile", captureCount: 2, complete: true },
      { profileId: "reduced_motion", captureCount: 2, complete: true },
      { profileId: "no_media", captureCount: 2, complete: true },
    ],
    criticDisposition: "accept",
    criticFindings: [],
    criticAttempt: 1,
    reviewState: "creative_ready",
    reviewStopReason: "accepted",
    ownerDecision: null,
    ownerDecisionReason: null,
    ownerDecisionTargetRunId: null,
    ...overrides,
  };
}

async function patchCreative(
  page: Page,
  review: CreativeStatus | null,
  heldOutPass: boolean | null = true,
): Promise<void> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${RUN_ID}`);
  const body = (await seed.json()) as Record<string, unknown>;
  body["creative"] = review;
  body["heldOutPass"] = heldOutPass;
  const payload = JSON.stringify(body);

  await page.route(
    (url) => url.pathname === `/api/runs/${RUN_ID}` && url.search === "",
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: payload,
      });
    },
  );
}

async function openResult(page: Page): Promise<void> {
  await page.goto(`/runs/${RUN_ID}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
  const button = page.getByTestId("rail-result");
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("creative-review")).toBeVisible();
}

function authority(page: Page, name: "functional" | "compiler" | "critic" | "owner") {
  return page.getByTestId(`creative-authority-${name}`);
}

function panel(page: Page) {
  return page.getByTestId("creative-review").locator("xpath=ancestor::section[1]");
}

test("keeps critic acceptance separate from the functional, compiler, and owner authorities", async ({ page }) => {
  await patchCreative(page, creative());
  await openResult(page);

  await expect(authority(page, "functional")).toContainText("Passed");
  await expect(authority(page, "compiler")).toContainText("Passed");
  await expect(authority(page, "critic")).toContainText("Accepted");
  await expect(authority(page, "owner")).toContainText("Awaiting owner");
  await expect(page.getByTestId("creative-owner-awaiting")).toBeVisible();
  await expect(page.getByTestId("creative-critic-attempt")).toContainText("Attempt 1");
  await expect(panel(page).getByText("a".repeat(64))).toBeVisible();
  await expect(panel(page).getByText("b".repeat(64))).toBeVisible();
});

test("keeps a durable revision continuation reachable after reload", async ({ page }) => {
  const targetRunId = "run-cont-1234567890abcdefabcd";
  await patchCreative(page, creative({
    criticDisposition: "revise",
    criticFindings: [{
      category: "hierarchy",
      code: "HIERARCHY_FLAT",
      routeId: "home",
      sectionIds: ["hero"],
      diagnosis: "The hierarchy is too flat.",
      revision: "Use the admitted editorial hierarchy.",
    }],
    reviewState: "creative_review_required",
    reviewStopReason: "attempts_exhausted",
    ownerDecision: "revision_requested",
    ownerDecisionReason: "Continue from the latest rendered attempt.",
    ownerDecisionTargetRunId: targetRunId,
  }));
  await openResult(page);
  await expect(page.getByRole("link", { name: `Open continuation ${targetRunId}` })).toHaveAttribute(
    "href",
    `/runs/${targetRunId}`,
  );
  await expect(page.getByText("Owner rationale: Continue from the latest rendered attempt.")).toBeVisible();
});

test("waits for the server receipt before promoting an owner approval", async ({ page }) => {
  await patchCreative(page, creative());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requestBody: unknown = null;
  await page.route(
    (url) => url.pathname === `/api/runs/${RUN_ID}/creative-decision`,
    async (route) => {
      requestBody = route.request().postDataJSON();
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: RUN_ID,
          ownerDecision: "approved",
          mayPublish: true,
          published: true,
          targetRunId: null,
        }),
      });
    },
  );
  await openResult(page);
  await page.getByText("Owner decision controls").click();
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(authority(page, "owner")).toContainText("Awaiting owner");
  await expect(page.getByRole("button", { name: "Recording…" })).toBeVisible();
  release();
  await expect(page.getByTestId("creative-decision-receipt")).toContainText(
    "Server recorded approved. The project copy was published.",
  );
  await expect(authority(page, "owner")).toContainText("Approved");
  expect(requestBody).toEqual({ decision: "approved" });
});

test("requires a bounded reason before sending a critic waiver", async ({ page }) => {
  await patchCreative(page, creative({
    criticDisposition: "revise",
    reviewState: "creative_review_required",
    criticFindings: [{
      category: "density",
      code: "dense-proof",
      routeId: "/",
      sectionIds: ["proof"],
      diagnosis: "The proof band is visually dense.",
      revision: "Reduce the density.",
    }],
  }));
  let requestBody: unknown = null;
  await page.route(
    (url) => url.pathname === `/api/runs/${RUN_ID}/creative-decision`,
    async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: RUN_ID,
          ownerDecision: "waived",
          mayPublish: false,
          published: false,
          targetRunId: null,
        }),
      });
    },
  );
  await openResult(page);
  await page.getByText("Owner decision controls").click();
  const waive = page.getByRole("button", { name: "Waive critic revision" });
  await expect(waive).toBeDisabled();
  await page.getByLabel("Reason for revision or waiver").fill("Owner accepts this bounded visual trade-off.");
  await expect(waive).toBeEnabled();
  await waive.click();

  await expect(page.getByTestId("creative-decision-receipt")).toContainText("Publication was not promoted");
  expect(requestBody).toEqual({
    decision: "waived",
    reason: "Owner accepts this bounded visual trade-off.",
  });
});

test("shows rendered-evidence revisions in a native keyboard disclosure", async ({ page }) => {
  await patchCreative(page, creative({
    criticDisposition: "revise",
    criticAttempt: 2,
    reviewState: "creative_review_required",
    criticFindings: [{
      category: "hierarchy",
      code: "hero-weight",
      routeId: "/launch",
      sectionIds: ["hero", "proof"],
      diagnosis: "The hero and proof band compete at the same visual weight.",
      revision: "Reduce the proof band contrast and preserve the primary action.",
    }],
  }));
  await openResult(page);

  await expect(authority(page, "critic")).toContainText("Revise");
  const disclosure = page.getByText(/Rendered evidence findings/);
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("creative-critic-finding")).toContainText("hero-weight");
  await expect(page.getByTestId("creative-critic-finding")).toContainText("route /launch");
  await expect(page.getByTestId("creative-critic-finding")).toContainText("hero, proof");
  await expect(authority(page, "owner")).toContainText("Awaiting owner");
});

test("keeps a compiler failure red even when the functional suite passed", async ({ page }) => {
  await patchCreative(page, creative({
    compileOutcome: "failed",
    compileFindings: [{
      code: "missing-evidence",
      path: "routes/landing/sections/hero/evidence/" + "segment-".repeat(20),
      message: "The required contract evidence does not resolve to an admitted source.",
    }],
    criticDisposition: null,
    criticAttempt: null,
    reviewState: "failed",
  }));
  await openResult(page);

  await expect(authority(page, "functional")).toContainText("Passed");
  await expect(authority(page, "compiler")).toContainText("Failed");
  await expect(authority(page, "critic")).toContainText("Not run");
  const disclosure = page.getByText(/Compiler findings/);
  await disclosure.click();
  await expect(panel(page)).toContainText("missing-evidence");
});

test("renders every absent authority as unknown, not green", async ({ page }) => {
  await patchCreative(page, creative({
    contractHash: null,
    compileOutcome: "unknown",
    renderManifestHash: null,
    renderFresh: null,
    renderProfiles: null,
    criticDisposition: null,
    criticAttempt: null,
    reviewState: null,
    ownerDecision: null,
  }), null);
  await openResult(page);

  await expect(authority(page, "functional")).toContainText("Unknown");
  await expect(authority(page, "compiler")).toContainText("Unknown");
  await expect(authority(page, "critic")).toContainText("Not run");
  await expect(authority(page, "owner")).toContainText("Awaiting owner");
  await expect(panel(page).getByText("Not recorded", { exact: true })).toHaveCount(3);
  await expect(panel(page).locator(".text-pass")).toHaveCount(0);
});

test("shows a stale manifest and incomplete profile without promoting either", async ({ page }) => {
  await patchCreative(page, creative({
    renderManifestHash: "f".repeat(64),
    renderFresh: false,
    renderProfiles: [
      { profileId: "desktop", captureCount: 2, complete: true },
      { profileId: "mobile", captureCount: 0, complete: false },
      { profileId: "reduced_motion", captureCount: 2, complete: true },
      { profileId: "no_media", captureCount: 2, complete: true },
    ],
  }));
  await openResult(page);

  await expect(panel(page).getByText("Manifest freshness")).toBeVisible();
  await expect(panel(page).getByText("Stale", { exact: true })).toBeVisible();
  const profiles = page.getByTestId("creative-profile-coverage");
  await expect(profiles).toContainText("desktop: 2 captured");
  await expect(profiles).toContainText("mobile: incomplete");
  await expect(panel(page).getByText(/^Fresh$/)).toHaveCount(0);
});

test("fails a malformed partial creative payload closed to one unavailable record", async ({ page }) => {
  await patchCreative(page, {
    ...creative(),
    criticDisposition: "accept",
    criticFindings: [{
      category: "hierarchy",
      code: "bad-shape",
      routeId: "/",
      sectionIds: [42],
      diagnosis: "Malformed finding",
      revision: "Malformed finding",
    }],
  } as unknown as CreativeStatus);

  await page.goto(`/runs/${RUN_ID}`);
  await page.getByTestId("rail-result").click();
  await expect(page.getByTestId("creative-review-unavailable")).toContainText(
    "No authority result was admitted",
  );
  await expect(page.getByTestId("creative-authority-critic")).toHaveCount(0);
  await expect(page.getByText("Accepted", { exact: true })).toHaveCount(0);
});

test("contains long ids and findings at 320px and 200 percent zoom", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await patchCreative(page, creative({
    contractHash: "c".repeat(64),
    renderManifestHash: "d".repeat(64),
    criticDisposition: "revise",
    criticFindings: [{
      category: "hierarchy-".repeat(30),
      code: "code-".repeat(60),
      routeId: "/" + "route/".repeat(80),
      sectionIds: ["section-".repeat(80)],
      diagnosis: "Diagnosis ".repeat(300),
      revision: "Revision ".repeat(300),
    }],
  }));
  await openResult(page);
  await page.getByText(/Rendered evidence findings/).click();
  await page.evaluate(() => { document.body.style.zoom = "2"; });

  const creativePanel = panel(page);
  await expect(creativePanel).toBeVisible();
  expect(await creativePanel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
});
