import { expect, test } from "@playwright/test";

import { FINISHED_RUN_ID, RUN_ID } from "./fixtures/config";
import { GRAPH_SNAPSHOT } from "./fixtures/run-fixture";

for (const runId of [RUN_ID, FINISHED_RUN_ID]) {
  test(`${runId}: role headings retain secondary identity and accessible names`, async ({ page }) => {
    await page.goto(`/runs/${runId}`);
    const root = page.getByTestId("rf__node-root");
    const builder = page.getByTestId("rf__node-builder");
    await expect(root.getByRole("heading", { level: 3 })).toHaveText("session");
    await expect(builder.getByRole("heading", { level: 3 })).toHaveText("frontend");
    await expect(builder.locator("article > p").first()).toHaveText("frontend-developer");
    await expect(builder.locator(".node-shell")).toHaveAccessibleName(/^frontend, frontend-developer, /);
    await expect(page.getByTestId("rf__node-reviewer").getByRole("heading", { level: 3 }))
      .toHaveText("review");
    await expect(page.getByTestId("rf__node-guard").getByRole("heading", { level: 3 }))
      .toHaveText("review");
    await expect(page.locator(".react-flow h3").filter({ hasText: /^(taste-frontend-expert|frontend-developer)$/ }))
      .toHaveCount(0);

    await builder.locator(".node-shell").focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("region", { name: "frontend", exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { level: 2 })).toHaveText("frontend");
    await expect(sheet.getByText("frontend-developer", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    const overview = page.getByTestId("rail-overview");
    if ((await overview.getAttribute("aria-expanded")) !== "true") {
      await overview.focus();
      await page.keyboard.press("Enter");
    }
    const row = page.getByTestId("rail-panel").getByRole("button", { name: /^frontend\b/ });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".text-ink").first()).toHaveText("frontend");
    await expect(row.locator(".text-ink-faint").first()).toContainText("frontend-developer");
  });
}

test("design, debug, and unknown identities render from a scoped fixture", async ({ page }) => {
  await page.route(`**/api/runs/${RUN_ID}/graph`, (route) => route.fulfill({
    json: {
      ...GRAPH_SNAPSHOT,
      nodes: GRAPH_SNAPSHOT.nodes.map((node) => {
        if (node.id === "builder") return { ...node, agent: "taste-frontend-expert", lane: "design" };
        if (node.id === "reviewer") return { ...node, agent: "some-agent-nobody-has-named", lane: null };
        if (node.id === "guard") return { ...node, agent: "debugger" };
        return node;
      }),
    },
  }));
  await page.goto(`/runs/${RUN_ID}`);
  const designer = page.getByTestId("rf__node-builder");
  await expect(designer.getByRole("heading", { level: 3 })).toHaveText("design");
  await expect(designer.locator("article > p").first()).toHaveText("taste-frontend-expert");
  await expect(designer.locator(".node-shell")).toHaveAccessibleName(/^design, taste-frontend-expert, /);
  await expect(page.locator(".react-flow h3").filter({ hasText: /^(taste-frontend-expert|frontend-developer)$/ }))
    .toHaveCount(0);
  await expect(page.getByTestId("rf__node-reviewer").getByRole("heading", { level: 3 }))
    .toHaveText("some-agent-nobody-has-named");
  await expect(page.getByTestId("rf__node-guard").getByRole("heading", { level: 3 }))
    .toHaveText("debug");
});
