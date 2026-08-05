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
 *
 * RE-POINTED 2026-08-02: THE PANEL IS BEHIND TWO CLICKS NOW, AND THE OLD SCOPE
 * HAD NO REFERENT. All four tests below died in `openRun` — `element(s) not
 * found` for `section:has(> header:has-text('Code'))` — because `CodeBrowser` is
 * no longer mounted on the run page. `runs/[runId]/page.tsx:59` records the move
 * in as many words: it is the `RunSheet`'s "Code" tab, reached with the chip's
 * `run detail` button and then the tab. Nothing about what is measured changed;
 * only where it is measured. The `section`/`header` wrapper was the run page's,
 * not `code-browser.tsx`'s — that component renders a `<header>` for the FILE,
 * never one saying "Code" — so the scope is the container the app gives the slot,
 * which is a real id rather than a shape reconstructed from text.
 *
 * RE-POINTED AGAIN 2026-08-05, FOR THE SAME REASON AND TO A DIFFERENT PLACE.
 * The sheet and its seven tabs are gone; `canvas/rail.tsx` replaced them with an
 * icon rail whose ONE panel is `#rail-panel`, and the "Code" tab is now the rail
 * entry labelled **Files** (`rail.tsx#ENTRIES`, mounted by `FilesPanel` at
 * `canvas/sheet.tsx:1186`). All four tests died in `openRun` waiting for a button
 * named `run detail` that no longer exists. The way in is one click on
 * `rail-files`; NOT ONE ASSERTION BELOW CHANGED, because none of them was about
 * the sheet — they are about the tree, the truncation notice and the gutter, and
 * all three are the same component in the same states.
 *
 * WHY THE SCOPE IS STILL WORTH HAVING. `#rail-panel` holds exactly one panel body
 * at a time and `FilesPanel` is mounted ONLY while Files is the open one
 * (`runs/[runId]/page.tsx` keeps it conditional on purpose: `CodeBrowser` fetches
 * on mount), so every assertion below is inside the panel it names and a
 * regression that moved the tree somewhere else on the page cannot satisfy it.
 *
 * THE RAIL BUTTON IS ADDRESSED BY `data-testid`, NOT BY ITS ACCESSIBLE NAME. The
 * name is the whole tooltip sentence and that sentence is COPY — it was rewritten
 * twice in the week this repair was made. A way-in that breaks on a copy edit is
 * a spec that reports a prose change as a code-browser regression.
 *
 * THREE MUTATIONS APPLIED TO PRODUCTION CODE AND WATCHED — 2026-08-05, each
 * applied, run, reverted and run green again. A re-pointed spec that was never
 * made to fail is a spec that now asserts the navigation and nothing else:
 *
 *   1. `code-browser.tsx:214` — the shown figure swapped for the total, so the
 *      notice reads "Showing the first 11.8 MB of 11.8 MB". 1 of 4 RED, at
 *      `toContainText(formatBytes(shownBytes))`. This is the defect the comment
 *      at that assertion describes: a notice that understates how much is
 *      missing while still looking like a truncation notice.
 *   2. same file:379 — `md:` dropped from the grid, i.e. two columns at every
 *      width. 1 of 4 RED, but on the STACKING assertion, which fires first — so
 *      it does NOT exercise the width floor, and is recorded as the control it
 *      is not.
 *   3. same file:387 — `max-w-[200px]` added to the tree, which stacks correctly
 *      and is then a 200px column inside a 327px panel. 1 of 4 RED at the width
 *      floor itself: "Expected: > 294.3, Received: 200". THIS is the control for
 *      the relative floor that replaced the old `> 300` literal.
 */

import { expect, test, type Page } from "@playwright/test";

import { formatBytes } from "../src/lib/code-tree";
import { RUN_ID } from "./fixtures/config";
import { CODE_FILES } from "./fixtures/run-fixture";

/**
 * The over-cap transcript the truncation test measures, read off the fixture the
 * API server is serving rather than described in a literal. The throw is a
 * negative control: without it a renamed fixture key would leave the assertions
 * below comparing `undefined` to `undefined`.
 */
const TRUNCATED_FILE = CODE_FILES["build.log"];
if (TRUNCATED_FILE === undefined) throw new Error("the fixture has no build.log");

const CODE_PANEL = "#rail-panel";
const TREE = `${CODE_PANEL} nav[aria-label="Files this run produced"]`;

async function openRun(page: Page): Promise<void> {
  await page.goto(`/runs/${RUN_ID}`);
  // `CodeBrowser` fetches on mount and the page mounts it only while Files is the
  // open rail panel, so the tree is a request that only starts on this click —
  // which is why the wait is after the click and not after the navigation.
  await page.getByTestId("rail-files").click();
  await expect(page.locator(TREE)).toBeVisible();
}

test.describe("at 1280", () => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  test("the tree is keyboard reachable, opens a nested file, and does not trap focus", async ({
    page,
  }) => {
    await openRun(page);
    const tree = page.locator(TREE);

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

    /*
     * BOTH NUMBERS. "Truncated" alone does not tell the reader whether they are
     * missing two lines or twelve megabytes.
     *
     * THE SHOWN FIGURE IS DERIVED FROM THE RESPONSE, NOT WRITTEN DOWN — and that
     * is the correction this test needed rather than a new value. It asserted the
     * literal `256 KB`, the server's cap, and had never once passed: the notice
     * reads `Showing the first 241 KB of 11.8 MB`. Neither side was wrong about
     * the cap. `code-browser.tsx:181-191` refuses to name it on purpose — "a
     * second constant that silently goes stale the day the server's changes, and
     * the sentence would then be wrong in the most misleading possible way,
     * understating how much is missing" — so it encodes the text it actually
     * received. The fixture then never reached the cap anyway: `TRUNCATED_TEXT`
     * is `"builder step\n".repeat(19_000)`, 13 × 19,000 = 247,000 bytes, and its
     * `.slice(0, 262_144)` is a no-op on a string already shorter than that.
     *
     * So the expectation is computed the same way the component computes it, from
     * the same fixture the server is serving. A component that went back to
     * printing a cap constant goes red here, and a fixture whose transcript
     * changes size does not — which is the opposite of what the literal did.
     */
    const shownBytes = new TextEncoder().encode(TRUNCATED_FILE.text ?? "").length;
    expect(shownBytes).toBeGreaterThan(0);
    await expect(notice).toContainText(formatBytes(shownBytes));
    await expect(notice).toContainText(formatBytes(TRUNCATED_FILE.bytes));
    // The literal total as well, because the file header quotes it and a derived
    // pair that happened to be the same number would satisfy the two lines above.
    await expect(notice).toContainText("11.8 MB");
    expect(formatBytes(shownBytes)).not.toBe(formatBytes(TRUNCATED_FILE.bytes));

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
    const tree = page.locator(TREE);
    const code = page.getByTestId("code-text");

    const treeBox = await tree.boundingBox();
    const codeBox = await code.boundingBox();
    const panelBox = await page.locator(CODE_PANEL).boundingBox();
    if (treeBox === null || codeBox === null || panelBox === null) {
      throw new Error("the code panel did not render");
    }

    // Stacked: the file starts BELOW the tree ends, not beside it.
    expect(codeBox.y).toBeGreaterThan(treeBox.y + treeBox.height - 2);
    /*
     * AND THE TREE IS THE FULL WIDTH OF THE PANEL RATHER THAN A COLUMN INSIDE IT.
     *
     * MEASURED AGAINST THE PANEL, NOT AGAINST A LITERAL — and that is a repair
     * rather than a loosening. The literal here was `> 300`, written when this
     * component lived in a 560px sheet; the rail's panel is
     * `w-[min(400px,calc(100vw-48px))]`, so at 375 it is 327px and a tree filling
     * every pixel of it would have failed a 300px floor by 27px on the panel's
     * width alone. The claim was never about 300 pixels: it is that the tree is
     * not the `minmax(200px,264px)` grid track it becomes above `md`, which at
     * this panel width is 200/327 = 61%. A 90% floor separates those two by a
     * wide margin and moves with the panel.
     */
    expect(treeBox.width).toBeGreaterThan(panelBox.width * 0.9);
  });
});
