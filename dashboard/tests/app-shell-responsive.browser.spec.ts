import { expect, test } from "@playwright/test";

test("the app shell contains the home page at 320px without hiding primary navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");

  await expect(page.getByTestId("supervisor-strip")).toBeVisible();

  const layout = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const bounds = (element: Element): { left: number; right: number } => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };

    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      header: bounds(document.querySelector("header") as HTMLElement),
      navigation: [...document.querySelectorAll("header nav a")].map(bounds),
    };
  });

  expect(layout.documentWidth).toBe(layout.viewportWidth);
  expect(layout.header).toEqual({ left: 0, right: 320 });
  expect(layout.navigation).toHaveLength(3);
  for (const link of layout.navigation) {
    expect(link.left).toBeGreaterThanOrEqual(0);
    expect(link.right).toBeLessThanOrEqual(layout.viewportWidth);
  }

  await expect(page.getByRole("link", { name: "New ticket" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
});
