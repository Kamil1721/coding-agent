/**
 * The code sidebar, in a real browser, measuring the three things only a browser
 * can settle.
 *
 * WHAT IS DELIBERATELY NOT HERE. Path traversal, the credential deny-list, the
 * held-out boundary and the byte cap are facts about a filesystem and a resolved
 * path; they are proved over a real workspace and a real sealed suite in
 * `server/src/code-files.test.ts`, against the real server. A fake API cannot
 * refuse a symlink, and a spec that pointed at one and passed would be measuring
 * the fixture.
 *
 * WHAT ONLY A BROWSER CAN SETTLE:
 *
 * 1. THE TREE IS REACHABLE BY KEYBOARD AND DOES NOT TRAP FOCUS. Every row is a
 *    real `<button>` in a nested `<ul>`, so Tab walks in and Tab walks out. The
 *    canvas ships an accessible equivalent for exactly this reason and the run
 *    page says so in prose; a sidebar that could only be clicked would quietly
 *    make that claim false for the code, which is the part the owner opened the
 *    panel to read.
 *
 * 2. TRUNCATION IS ON SCREEN. The server caps a file at 256 KB and this run's
 *    real builder transcript is 12,369,476 bytes. "Say plainly in the UI when a
 *    file is truncated rather than silently showing a prefix" is a rendering
 *    claim, and the only way to check a rendering claim is to render it.
 *
 * 3. THE GUTTER LINES UP WITH THE CODE. The line numbers are a SEPARATE `<pre>`
 *    from the text — one text node each, because 8,000 line elements is a slow
 *    paint — and the alignment therefore rests on the two sharing a computed
 *    line height. That is a fact about resolved CSS, invisible to any DOM-only
 *    runner, and it is the kind of thing that silently drifts when a font size
 *    changes. A misaligned gutter makes every number a lie about which row it
 *    labels.
 */

import { expect, test, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

const CODE_PANEL = "section:has(> header:has-text('Code'))";

async function openRun(page: Page): Promise<void> {
  await page.goto(`/runs/${RUN_ID}`);
  // The panel arrives with the run detail, and the tree is a second fetch.
  await expect(page.locator(`${CODE_PANEL} nav[aria-label="Files this run produced"]`)).toBeVisible();
}

test.describe("at 1280", () => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  test("the tree is keyboard reachable, opens a nested file, and does not trap focus", async ({
    page,
  }) => {
    await openRun(page);
    const tree = page.locator(`${CODE_PANEL} nav[aria-label="Files this run produced"]`);

    // The default: a root file is open, and the directory row says it is open.
    await expect(page.getByTestId("code-text")).toContainText("<h1>Coglane</h1>");
    const dirRow = tree.locator("button", { hasText: "visible-acceptance/" }).first();
    await expect(dirRow).toHaveAttribute("aria-expanded", "true");

    // KEYBOARD ONLY from here. Focus the directory row, collapse it with Enter,
    // expand it again — `aria-expanded` is the assertion because a reader using a
    // screen reader has nothing else to go on.
    await dirRow.focus();
    await page.keyboard.press("Enter");
    await expect(dirRow).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(dirRow).toHaveAttribute("aria-expanded", "true");

    // Tab from the directory row reaches its child file, and Enter opens it.
    await page.keyboard.press("Tab");
    const nested = tree.locator("button", { hasText: "coglane-page.spec.mjs" });
    await expect(nested).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(nested).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("code-text")).toContainText("the visible subset");

    // NO TRAP. Tabbing forward from the last row leaves the tree entirely:
    // whatever holds focus after enough presses is outside the <nav>.
    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press("Tab");
      const inside = await tree.evaluate(
        (node, ) => node.contains(document.activeElement),
      );
      if (!inside) return;
    }
    throw new Error("focus never left the file tree — it is a trap");
  });

  test("a truncated file says so, and says how much is missing", async ({ page }) => {
    await openRun(page);
    await page
      .locator(`${CODE_PANEL} nav button`, { hasText: "build.log" })
      .click();

    const notice = page.getByTestId("code-truncated");
    await expect(notice).toBeVisible();
    // BOTH NUMBERS. "Truncated" alone does not tell the reader whether they are
    // missing two lines or twelve megabytes.
    await expect(notice).toContainText("256 KB");
    await expect(notice).toContainText("11.8 MB");

    // POSITIVE CONTROL: the notice is absent on a file that fits, so its
    // presence above is a fact about this file and not a permanent banner.
    await page.locator(`${CODE_PANEL} nav button`, { hasText: "index.html" }).click();
    await expect(page.getByTestId("code-text")).toContainText("Coglane");
    await expect(page.getByTestId("code-truncated")).toHaveCount(0);
  });

  test("the line-number gutter shares the code's line height", async ({ page }) => {
    await openRun(page);
    const code = page.getByTestId("code-text");
    const gutter = page.locator(`${CODE_PANEL} pre[aria-hidden="true"]`);

    const metrics = await Promise.all(
      [gutter, code].map((locator) =>
        locator.evaluate((node) => {
          const style = window.getComputedStyle(node);
          return {
            lineHeight: style.lineHeight,
            fontSize: style.fontSize,
            top: node.getBoundingClientRect().top,
          };
        }),
      ),
    );
    const [gutterStyle, codeStyle] = metrics;
    expect(gutterStyle?.lineHeight).toBe(codeStyle?.lineHeight);
    expect(gutterStyle?.fontSize).toBe(codeStyle?.fontSize);
    // Same first baseline, or number 1 does not sit beside line 1.
    expect(Math.abs((gutterStyle?.top ?? 0) - (codeStyle?.top ?? 0))).toBeLessThan(2);

    // The gutter counts the file's lines, not an arbitrary number of them.
    const lines = await code.evaluate((node) => (node.textContent ?? "").split("\n").length);
    const numbers = await gutter.evaluate((node) => (node.textContent ?? "").split("\n").length);
    expect(numbers).toBe(lines);

    // The code must NOT wrap: a wrapped line puts every number below it against
    // the wrong row.
    await expect(code).toHaveCSS("white-space", "pre");
  });
});

test.describe("at 375", () => {
  test.use({ viewport: { width: 375, height: 780 } });

  test("the tree stacks above the file rather than squeezing beside it", async ({ page }) => {
    await openRun(page);
    const tree = page.locator(`${CODE_PANEL} nav[aria-label="Files this run produced"]`);
    const code = page.getByTestId("code-text");

    const treeBox = await tree.boundingBox();
    const codeBox = await code.boundingBox();
    if (treeBox === null || codeBox === null) throw new Error("the code panel did not render");

    // Stacked: the file starts BELOW the tree ends, not beside it.
    expect(codeBox.y).toBeGreaterThan(treeBox.y + treeBox.height - 2);
    // And the tree is the full width of the panel rather than a 200px column.
    expect(treeBox.width).toBeGreaterThan(300);
  });
});
