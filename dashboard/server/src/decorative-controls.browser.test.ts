import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { decorativeControlsExpression } from "./decorative-controls.js";
import type { DecorativeControlSnapshot } from "./decorative-controls.js";

test("T23 literal clinic probe preserves the functional wizard green set", { timeout: 30_000 }, async () => {
  const root = join(import.meta.dirname, "..", "src", "test-fixtures", "clinic-131fd85f");
  const files: Readonly<Record<string, readonly [string, string]>> = {
    "/": ["index.html", "text/html"],
    "/app/styles.css": ["app/styles.css", "text/css"],
    "/app/main.mjs": ["app/main.mjs", "text/javascript"],
    "/app/wizard.mjs": ["app/wizard.mjs", "text/javascript"],
  };
  const server = createServer((request, response) => {
    const file = files[request.url ?? ""];
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": file[1] }).end(readFileSync(join(root, file[0])));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5_000);
    await page.goto(`http://127.0.0.1:${String(address.port)}/`, { waitUntil: "domcontentloaded" });
    const snapshot = async (id: string): Promise<DecorativeControlSnapshot> =>
      await page.evaluate(decorativeControlsExpression(`document.querySelector('[data-creative-section="${id}"]')`)) as DecorativeControlSnapshot;
    assert.deepEqual((await snapshot("s.a11y")).lookalikes.map(item => item.selector).sort(), [".bars", ".box", ".box--bad", ".chip"], "T23 literal probe must name the four measured specimens");
    assert.deepEqual((await snapshot("s.step1")).lookalikes, [], "T23 first-step controls and labels must remain green");
    await page.locator('#step-1 [data-action="next"]').click();
    assert.deepEqual((await snapshot("s.step1")).lookalikes, [], "T23 status warning glyph must remain green");
    await page.locator('#type-general-consultation').check();
    await page.locator('#step-1 [data-action="next"]').click();
    assert.deepEqual((await snapshot("s.step2")).lookalikes, [], "T23 slot inputs and labels must remain green");
    await page.locator('#appointment-date').fill('2030-01-15');
    await page.locator('.slot label').first().click();
    assert.equal(await page.locator('.slot input').first().isChecked(), true, "T23 visible slot label must select its real radio input");
    await page.locator('#step-2 [data-action="next"]').click();
    assert.deepEqual((await snapshot("s.step3")).lookalikes, [], "T23 review controls must remain green");
    await page.locator('[data-action="confirm"]').click();
    await page.locator('[data-action="reset"]').waitFor({ state: "visible" });
    const confirmation = await snapshot("s.confirm");
    const criteria = await page.evaluate(`(() => { const el=document.querySelector('.done-mark'); const style=getComputedStyle(el); return {tag:el.tagName,text:el.textContent,ariaHidden:el.getAttribute('aria-hidden'),height:el.getBoundingClientRect().height,background:style.backgroundColor,radius:style.borderRadius,roleAncestor:el.parentElement.closest('[role],[aria-label],[aria-labelledby]')?.tagName ?? null}; })()`);
    console.log("T23 literal done-mark measurement", JSON.stringify(criteria));
    assert.deepEqual(confirmation.lookalikes, [], "T23 every confirmation element, including the completion glyph, must remain green");
  } finally {
    try { await browser?.close(); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
