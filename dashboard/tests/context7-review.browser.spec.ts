import { expect, test, type Page } from "@playwright/test";

import type { Context7Review } from "../src/lib/api-types";
import { API_ORIGIN, RUN_ID } from "./fixtures/config";

async function patchReview(page: Page, review: Context7Review | null): Promise<void> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${RUN_ID}`);
  const body = (await seed.json()) as Record<string, unknown>;
  body["context7Review"] = review;
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
  await expect(page.getByTestId("rail-panel")).toBeVisible();
}

function reviewPanel(page: Page) {
  return page.getByTestId("context7-review").locator("xpath=ancestor::section[1]");
}

function baseReview(overrides: Partial<Context7Review> = {}): Context7Review {
  return {
    startedAt: "2026-08-20T08:00:00.000Z",
    completedAt: "2026-08-20T08:00:05.000Z",
    status: "completed",
    capabilityApplicability: "required",
    code: null,
    packages: [{ package: "next", versionOrRange: "16.2.12" }],
    source: {
      sourceHash: "a".repeat(64),
      files: ["package.json", "src/app/page.tsx"],
      bytes: 2_621,
      truncated: false,
    },
    verdict: {
      verdict: "fail",
      summary: "The route handler uses an API that changed in the installed version.",
      evidence: [{ claimId: "EC-1" }],
      findings: [
        {
          claimId: "EC-1",
          severity: "error",
          title: "Route handler signature is outdated",
          detail: "Update the handler to the current request contract.",
        },
      ],
    },
    evidence: [
      {
        claimId: "EC-1",
        package: "next",
        versionOrRange: "16.2.12",
        queryPurpose:
          "Verify current public usage, configuration, version compatibility, and deprecations for next as used by the supplied source.",
        success: true,
        evidenceHash: "b".repeat(64),
        seat: "independent_code_review",
      },
    ],
    lifecycle: [
      {
        claimId: null,
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: null,
        state: "planned",
        code: null,
        producedArtefactHashes: [],
      },
      {
        claimId: null,
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: null,
        state: "connected",
        code: null,
        producedArtefactHashes: [],
      },
      {
        claimId: "EC-1",
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: "mcp__context7__resolve-library-id",
        state: "attempted",
        code: null,
        producedArtefactHashes: [],
      },
      {
        claimId: "EC-1",
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: "mcp__context7__resolve-library-id",
        state: "succeeded",
        code: null,
        producedArtefactHashes: ["d".repeat(64)],
      },
      {
        claimId: "EC-1",
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: "mcp__context7__query-docs",
        state: "attempted",
        code: null,
        producedArtefactHashes: [],
      },
      {
        claimId: "EC-1",
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: "mcp__context7__query-docs",
        state: "succeeded",
        code: null,
        producedArtefactHashes: ["b".repeat(64)],
      },
      {
        claimId: null,
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: null,
        state: "satisfied",
        code: null,
        producedArtefactHashes: ["b".repeat(64)],
      },
    ],
    ...overrides,
  };
}

function twoClaimReview(): Context7Review {
  const base = baseReview();
  const claimActivity = base.lifecycle.slice(2, -1);
  const secondClaimActivity = claimActivity.map((event) => ({
    ...event,
    claimId: "EC-2",
    producedArtefactHashes:
      event.state !== "succeeded"
        ? event.producedArtefactHashes
        : [event.tool === "mcp__context7__query-docs" ? "f".repeat(64) : "e".repeat(64)],
  }));
  return {
    ...base,
    packages: [
      ...base.packages,
      { package: "react", versionOrRange: "19.2.4" },
    ],
    evidence: [
      ...base.evidence,
      {
        claimId: "EC-2",
        package: "react",
        versionOrRange: "19.2.4",
        queryPurpose: "Verify the current React API used by the supplied source.",
        success: true,
        evidenceHash: "f".repeat(64),
        seat: "independent_code_review",
      },
    ],
    verdict: {
      ...base.verdict!,
      evidence: [{ claimId: "EC-1" }, { claimId: "EC-2" }],
    },
    lifecycle: [
      ...base.lifecycle.slice(0, 2),
      ...claimActivity,
      ...secondClaimActivity,
      {
        ...base.lifecycle.at(-1)!,
        producedArtefactHashes: ["b".repeat(64), "f".repeat(64)],
      },
    ],
  };
}

test("shows SDK proof, tool counts, claim evidence, and the non-gating review outcome", async ({
  page,
}) => {
  await patchReview(page, baseReview());
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Evidence complete");
  await expect(panel).toContainText("Verified before review");
  await expect(panel).toContainText("2 named, 2 invoked, 2 returned, 0 denied");

  const claim = page.getByTestId("context7-claim");
  await expect(claim).toContainText("next@16.2.12");
  await expect(claim).toContainText("Evidence admitted");
  await expect(claim).toContainText("Verify current public usage");
  await expect(claim).toContainText("bbbbbbbbbbbb");

  await expect(page.getByTestId("context7-outcome")).toContainText("fail");
  await expect(page.getByTestId("context7-outcome")).toContainText("Non-gating");
  await expect(page.getByTestId("context7-outcome")).toContainText("Route handler signature is outdated");

  await page.getByText("Lifecycle and source proof").click();
  const proof = page.getByTestId("context7-proof");
  await expect(proof).toContainText("2 files, 2.6 KB, complete");
  await expect(proof).toContainText("connected");
  await expect(proof).toContainText("query-docs");
});

test("accepts independent resolver and query proof chains for two external claims", async ({ page }) => {
  await patchReview(page, twoClaimReview());
  await openResult(page);

  await expect(reviewPanel(page)).toContainText("Evidence complete");
  await expect(page.getByTestId("context7-claim")).toHaveCount(2);
  await expect(page.getByTestId("context7-review-unavailable")).toHaveCount(0);
});

test("keeps missing evidence separate from an admitted outcome", async ({ page }) => {
  const completedLifecycle = baseReview().lifecycle;
  const review = baseReview({
    status: "unsatisfied",
    code: "required_evidence_missing",
    packages: [
      { package: "next", versionOrRange: "16.2.12" },
      { package: "react", versionOrRange: "19.2.4" },
    ],
    verdict: null,
    lifecycle: [
      ...completedLifecycle.slice(0, -1),
      {
        ...completedLifecycle.at(-1)!,
        state: "unsatisfied",
        code: "required_evidence_missing",
        producedArtefactHashes: [],
      },
    ],
  });
  await patchReview(page, review);
  await openResult(page);

  await expect(reviewPanel(page)).toContainText("Evidence missing");
  await expect(page.getByTestId("context7-claim")).toHaveCount(2);
  await expect(
    page.getByTestId("context7-claim").filter({ hasText: "react@19.2.4" }),
  ).toContainText("No successful documentation query was admitted for this claim.");
  await expect(page.getByTestId("context7-no-outcome")).toContainText("Not admitted");
  await expect(page.getByTestId("context7-no-outcome")).toContainText(
    "At least one external package claim lacks required documentation evidence.",
  );
});

test("renders an internal-only review as not applicable and tool-less", async ({ page }) => {
  const review = baseReview({
    capabilityApplicability: "not_applicable",
    packages: [],
    evidence: [],
    lifecycle: [],
    verdict: {
      verdict: "pass",
      summary: "The repository-local change is internally consistent.",
      findings: [],
      evidence: [],
    },
  });
  await patchReview(page, review);
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Not applicable");
  await expect(panel).toContainText("Context7 tools were not routed or used.");
  await expect(panel).toContainText("SDK inventoryNot needed");
  await expect(panel).toContainText("0 named, 0 invoked, 0 returned, 0 denied");
  await expect(page.getByTestId("context7-claims-na")).toContainText(
    "No external package claims were in scope",
  );
  await expect(page.getByTestId("context7-outcome")).toContainText("Source-only pass");
});

test("renders an incomplete internal source as a failed preflight, not normal not-applicable", async ({ page }) => {
  await patchReview(page, baseReview({
    status: "unsatisfied",
    capabilityApplicability: "not_applicable",
    code: "source_incomplete",
    packages: [],
    evidence: [],
    lifecycle: [],
    verdict: null,
    source: { sourceHash: "a".repeat(64), files: ["src/index.ts"], bytes: 1_024, truncated: true },
  }));
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Evidence missing");
  await expect(panel).not.toContainText("This review covered repository-internal work only");
  await expect(page.getByTestId("context7-no-outcome")).toContainText(
    "The source snapshot was incomplete, so no review outcome was admitted.",
  );
});

test("renders an unavailable internal source with an empty source snapshot", async ({ page }) => {
  await patchReview(page, baseReview({
    status: "unsatisfied",
    capabilityApplicability: "not_applicable",
    code: "source_unavailable",
    packages: [],
    verdict: null,
    evidence: [],
    lifecycle: [],
    source: { sourceHash: "a".repeat(64), files: [], bytes: 0, truncated: false },
  }));
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Evidence missing");
  await expect(panel).toContainText("No readable source was available, so no review outcome was admitted.");
  await expect(page.getByTestId("context7-review-unavailable")).toHaveCount(0);
});

test("accepts a pilot-disabled capability record with an unsatisfied bootstrap lifecycle", async ({ page }) => {
  const planned = baseReview().lifecycle[0]!;
  await patchReview(page, baseReview({
    status: "capability_unavailable",
    code: "pilot_not_enabled",
    verdict: null,
    evidence: [],
    lifecycle: [
      planned,
      {
        ...planned,
        state: "unsatisfied",
        code: "pilot_not_enabled",
      },
    ],
  }));
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Unavailable");
  await expect(panel).toContainText("This project was not enabled for the Context7 review pilot.");
  await expect(page.getByTestId("context7-review-unavailable")).toHaveCount(0);
});

test("renders nothing when the run has no review record", async ({ page }) => {
  await patchReview(page, null);
  await openResult(page);

  await expect(page.getByTestId("context7-review")).toHaveCount(0);
});

test("renders a compact warning instead of throwing on a partial runtime record", async ({ page }) => {
  await patchReview(page, { status: "completed" } as Context7Review);
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
});

test("rejects a completed record without a verdict instead of rendering misleading status", async ({ page }) => {
  await patchReview(page, baseReview({ verdict: null }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  const panel = page.getByTestId("context7-review-unavailable").locator("xpath=ancestor::section[1]");
  await expect(panel).not.toContainText("Evidence complete");
  await expect(panel).not.toContainText("Not admitted");
});

test("rejects status and code contradictions instead of rendering a completed or stopped result", async ({ page }) => {
  await patchReview(page, baseReview({ code: "session_error" }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);

  await page.unrouteAll({ behavior: "wait" });
  await patchReview(page, baseReview({
    status: "failed",
    code: "source_incomplete",
    verdict: null,
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Review stopped", { exact: true })).toHaveCount(0);
});

for (const scenario of [
  {
    name: "source-unavailable with files",
    review: baseReview({
      status: "unsatisfied",
      capabilityApplicability: "not_applicable",
      code: "source_unavailable",
      packages: [],
      verdict: null,
      evidence: [],
      lifecycle: [],
    }),
  },
  {
    name: "source-incomplete without files",
    review: baseReview({
      status: "unsatisfied",
      capabilityApplicability: "not_applicable",
      code: "source_incomplete",
      packages: [],
      verdict: null,
      evidence: [],
      lifecycle: [],
      source: { sourceHash: "a".repeat(64), files: [], bytes: 0, truncated: true },
    }),
  },
  {
    name: "source-incomplete without truncation",
    review: baseReview({
      status: "unsatisfied",
      capabilityApplicability: "not_applicable",
      code: "source_incomplete",
      packages: [],
      verdict: null,
      evidence: [],
      lifecycle: [],
    }),
  },
  {
    name: "completed with no source files",
    review: baseReview({
      source: { sourceHash: "a".repeat(64), files: [], bytes: 0, truncated: false },
    }),
  },
  {
    name: "completed with a truncated source",
    review: baseReview({
      source: { ...baseReview().source, truncated: true },
    }),
  },
] satisfies readonly { name: string; review: Context7Review }[]) {
  test(`rejects a mismatched ${scenario.name} state`, async ({ page }) => {
    await patchReview(page, scenario.review);
    await openResult(page);

    await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
    await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
  });
}

test("rejects not-applicable records that still declare an external package", async ({ page }) => {
  await patchReview(page, baseReview({ capabilityApplicability: "not_applicable" }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Not applicable", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects an external review relabeled as suggested", async ({ page }) => {
  await patchReview(page, baseReview({ capabilityApplicability: "suggested" }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Review completed", { exact: true })).toHaveCount(0);
});

for (const scenario of [
  {
    name: "capability-unavailable",
    status: "capability_unavailable",
    code: "tool_unavailable",
  },
  {
    name: "required-evidence-missing",
    status: "unsatisfied",
    code: "required_evidence_missing",
  },
] satisfies readonly {
  name: string;
  status: Context7Review["status"];
  code: string;
}[]) {
  test(`rejects an internal zero-obligation ${scenario.name} record`, async ({ page }) => {
    await patchReview(page, baseReview({
      status: scenario.status,
      capabilityApplicability: "not_applicable",
      code: scenario.code,
      packages: [],
      verdict: null,
      evidence: [],
      lifecycle: [],
    }));
    await openResult(page);

    await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  });
}

for (const scenario of [
  {
    name: "failed",
    status: "failed",
    code: "session_error",
    label: "Review stopped",
    detail: "The independent reviewer session stopped before it completed.",
  },
  {
    name: "unsatisfied",
    status: "unsatisfied",
    code: "invalid_structured_output",
    label: "Evidence missing",
    detail: "The reviewer output did not match the required review format.",
  },
] satisfies readonly {
  name: string;
  status: Context7Review["status"];
  code: string;
  label: string;
  detail: string;
}[]) {
  test(`renders a production-shaped internal zero-obligation ${scenario.name} record`, async ({ page }) => {
    await patchReview(page, baseReview({
      status: scenario.status,
      capabilityApplicability: "not_applicable",
      code: scenario.code,
      packages: [],
      verdict: null,
      evidence: [],
      lifecycle: [],
    }));
    await openResult(page);

    const panel = reviewPanel(page);
    await expect(panel).toContainText(scenario.label);
    await expect(panel).toContainText(scenario.detail);
    await expect(page.getByTestId("context7-review-unavailable")).toHaveCount(0);
  });
}

test("rejects duplicate verdict claim references", async ({ page }) => {
  const verdict = baseReview().verdict!;
  await patchReview(page, baseReview({
    verdict: {
      ...verdict,
      evidence: [{ claimId: "EC-1" }, { claimId: "EC-1" }],
    },
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

for (const scenario of [
  { name: "missing", evidence: [] },
  {
    name: "mismatched",
    evidence: [{
      ...baseReview().evidence[0]!,
      versionOrRange: "15.0.0",
    }],
  },
] satisfies readonly { name: string; evidence: Context7Review["evidence"] }[]) {
  test(`rejects completed required reviews with ${scenario.name} package evidence`, async ({ page }) => {
    await patchReview(page, baseReview({ evidence: scenario.evidence }));
    await openResult(page);

    await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
    await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
  });
}

test("rejects a denied lifecycle row carrying a session failure code", async ({ page }) => {
  await patchReview(page, baseReview({
    lifecycle: [{
      ...baseReview().lifecycle[2]!,
      state: "denied",
      code: "session_error",
    }],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects lifecycle attempts that claim a produced evidence hash", async ({ page }) => {
  await patchReview(page, baseReview({
    lifecycle: [{
      ...baseReview().lifecycle[2]!,
      producedArtefactHashes: ["d".repeat(64)],
    }],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects foreign review seats and lifecycle servers", async ({ page }) => {
  await patchReview(page, baseReview({
    evidence: [{ ...baseReview().evidence[0]!, seat: "primary_reviewer" }],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");

  await page.unrouteAll({ behavior: "wait" });
  await patchReview(page, baseReview({
    lifecycle: baseReview().lifecycle.map((event) => ({ ...event, server: "untrusted" })),
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects evidence whose hash was not produced by a successful query-docs call", async ({ page }) => {
  await patchReview(page, baseReview({
    lifecycle: baseReview().lifecycle.map((event) =>
      event.state === "succeeded" && event.tool === "mcp__context7__query-docs"
        ? { ...event, producedArtefactHashes: ["e".repeat(64)] }
        : event),
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects query proof that has no successful resolver for its claim", async ({ page }) => {
  await patchReview(page, baseReview({
    lifecycle: baseReview().lifecycle.filter(
      (event) => event.tool !== "mcp__context7__resolve-library-id",
    ),
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects a completed required review without a connected lifecycle transition", async ({ page }) => {
  await patchReview(page, baseReview({
    lifecycle: baseReview().lifecycle.filter((event) => event.state !== "connected"),
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects a query whose resolver succeeded for a different claim", async ({ page }) => {
  await patchReview(page, baseReview({
    evidence: [{ ...baseReview().evidence[0]!, claimId: "EC-2" }],
    lifecycle: baseReview().lifecycle.map((event) =>
      event.tool === "mcp__context7__query-docs"
        ? { ...event, claimId: "EC-2" }
        : event),
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects evidence that borrows another claim's successful query hash", async ({ page }) => {
  const review = twoClaimReview();
  await patchReview(page, {
    ...review,
    evidence: review.evidence.map((entry, index) => ({
      ...entry,
      evidenceHash: review.evidence[index === 0 ? 1 : 0]!.evidenceHash,
    })),
  });
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects a completed review that continues after a terminal session failure", async ({ page }) => {
  const lifecycle = baseReview().lifecycle;
  await patchReview(page, baseReview({
    lifecycle: [
      ...lifecycle.slice(0, -1),
      {
        ...lifecycle[0]!,
        state: "failed",
        code: "session_error",
      },
      lifecycle.at(-1)!,
    ],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects a completed external review ending unsatisfied without an error code", async ({ page }) => {
  const lifecycle = baseReview().lifecycle;
  await patchReview(page, baseReview({
    lifecycle: [
      ...lifecycle.slice(0, -1),
      { ...lifecycle.at(-1)!, state: "unsatisfied" },
    ],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects a satisfied lifecycle with an unmatched tool attempt", async ({ page }) => {
  const lifecycle = baseReview().lifecycle;
  await patchReview(page, baseReview({
    lifecycle: [
      ...lifecycle.slice(0, -1),
      lifecycle[4]!,
      lifecycle.at(-1)!,
    ],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("accepts a terminal session failure while a tool attempt is still outstanding", async ({ page }) => {
  const lifecycle = baseReview().lifecycle;
  await patchReview(page, baseReview({
    status: "failed",
    code: "session_error",
    verdict: null,
    evidence: [],
    lifecycle: [
      ...lifecycle.slice(0, 5),
      {
        ...lifecycle[0]!,
        state: "failed",
        code: "session_error",
      },
    ],
  }));
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Review stopped");
  await expect(panel).toContainText("The independent reviewer session stopped before it completed.");
  await expect(page.getByTestId("context7-review-unavailable")).toHaveCount(0);
});

test("accepts the production external orchestration-catch failure lifecycle", async ({ page }) => {
  const planned = baseReview().lifecycle[0]!;
  await patchReview(page, baseReview({
    status: "failed",
    code: "session_error",
    verdict: null,
    evidence: [],
    lifecycle: [
      planned,
      {
        ...planned,
        state: "failed",
        code: "session_error",
      },
    ],
  }));
  await openResult(page);

  const panel = reviewPanel(page);
  await expect(panel).toContainText("Review stopped");
  await expect(panel).toContainText("The independent reviewer session stopped before it completed.");
  await expect(page.getByTestId("context7-review-unavailable")).toHaveCount(0);

  await page.getByText("Lifecycle and source proof").click();
  const proof = page.getByTestId("context7-proof");
  await expect(proof).toContainText("planned");
  await expect(proof).toContainText("failed");
  await expect(proof).toContainText("session_error");
});

test("rejects a satisfied terminal row placed before its query proof", async ({ page }) => {
  const lifecycle = baseReview().lifecycle;
  await patchReview(page, baseReview({
    lifecycle: [
      ...lifecycle.slice(0, 4),
      lifecycle.at(-1)!,
      ...lifecycle.slice(4, -1),
    ],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("rejects preflight outcomes that retain admitted evidence", async ({ page }) => {
  await patchReview(page, baseReview({
    status: "unsatisfied",
    code: "source_incomplete",
    verdict: null,
    lifecycle: [],
  }));
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
  await expect(page.getByText("Evidence complete", { exact: true })).toHaveCount(0);
});

test("renders a compact warning instead of throwing on malformed nested source fields", async ({ page }) => {
  await patchReview(page, {
    ...baseReview(),
    source: { sourceHash: "not-a-sha", files: [123], bytes: Number.NaN, truncated: false } as unknown as Context7Review["source"],
  });
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
});

test("renders a compact warning instead of throwing on malformed nested evidence fields", async ({ page }) => {
  await patchReview(page, {
    ...baseReview(),
    evidence: [{ package: "next", versionOrRange: 16, success: true }] as unknown as Context7Review["evidence"],
  });
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
});

test("renders a compact warning instead of throwing on malformed nested verdict and lifecycle fields", async ({ page }) => {
  await patchReview(page, {
    ...baseReview(),
    verdict: {
      verdict: "pass",
      summary: "Malformed nested shape.",
      evidence: [{ claimId: "EC-1" }],
      findings: [{ claimId: "EC-1", severity: "critical", title: "bad", detail: "bad" }],
    } as unknown as Context7Review["verdict"],
    lifecycle: [
      {
        claimId: null,
        seat: "independent_code_review",
        obligationHash: "c".repeat(64),
        server: "context7",
        tool: null,
        state: "succeeded",
        code: null,
        producedArtefactHashes: [123],
      },
    ] as unknown as Context7Review["lifecycle"],
  });
  await openResult(page);

  await expect(page.getByTestId("context7-review-unavailable")).toContainText("Context7 record unavailable");
});

test("max-length review prose stays contained at 320px and 200 percent zoom", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const claimId = "C".repeat(128);
  await patchReview(page, baseReview({
    verdict: {
      verdict: "fail",
      summary: "S".repeat(2_000),
      evidence: [{ claimId }],
      findings: [{
        claimId,
        severity: "error",
        title: "T".repeat(300),
        detail: "D".repeat(4_000),
      }],
    },
  }));
  await openResult(page);
  await page.evaluate(() => { document.body.style.zoom = "2"; });

  const panel = reviewPanel(page);
  await expect(panel).toBeVisible();
  const contained = await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(contained).toBe(true);
  const viewportOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(viewportOverflow).toBe(true);
});

test("keeps the evidence ledger inside the result sheet at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await patchReview(page, baseReview());
  await openResult(page);
  await page.getByText("Lifecycle and source proof").click();

  const panelBox = await reviewPanel(page).boundingBox();
  assertBox(panelBox, "Context7 panel");
  for (const locator of [page.getByTestId("context7-claim"), page.getByTestId("context7-outcome"), page.getByTestId("context7-proof")]) {
    const box = await locator.boundingBox();
    assertBox(box, "Context7 child surface");
    expect(box.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);
  }
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390);
});

function assertBox(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null,
  label: string,
): asserts box is { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  expect(box, `${label} must participate in layout`).not.toBeNull();
}
