/**
 * chat-attachments.browser.spec.ts — the object URLs of a send that is still in
 * flight.
 *
 * THE DEFECT, MEASURED BEFORE THE FIX. `OrchestratorChat#send` posted, and in
 * its `.then()` ran `releaseAttachments(attachments)` — the list its closure
 * captured at send time, which is correct — and then `setAttachments([])`,
 * which is not. Anything attached WHILE the request was in flight was in state
 * but not in that closure, so the unconditional clear dropped it from the
 * composer without revoking its `blob:` URL. Two consequences, and the second
 * is the one a reader notices:
 *
 *   · the blob is pinned for the life of the document with no reference left
 *     to free it — the cap is six images at 8 MB, so up to 48 MB;
 *   · the chip VANISHES. The owner attached a screenshot, it was never sent,
 *     and it silently disappeared from the box he attached it to.
 *
 * WHY THIS IS A BROWSER SPEC AND NOT A UNIT TEST OF A HELPER. The bug is a
 * stale closure over React state; a pure function extracted from it and tested
 * on its own would be green whether or not the component called it, which is
 * this repository's signature defect. So the measurement is taken from the real
 * component in a real browser: `URL.createObjectURL`/`revokeObjectURL` are
 * instrumented before the app loads, the chip's own `<img src>` says which blob
 * belongs to which file, and the POST is held open by `page.route` so that
 * "while the request is in flight" is a real state and not a simulated one.
 *
 * THE LEAK NEEDS THE THIRD ASSERTION AND THE FIRST TWO ARE NOT ENOUGH.
 * "second.png's URL was not revoked" is true of the BROKEN code too — that is
 * what leaking means. What separates them is that after the fix the survivor is
 * still HELD: its chip is on screen, and unmounting the composer revokes it.
 * Broken, it was dropped from state before the unmount sweep could ever see it,
 * so it is never revoked at all. (WHAT UNMOUNTS IT changed on 2026-08-05 — it
 * used to be closing the sheet, and closing the rail's panel does not; see the
 * re-pointing note at the foot of this block.)
 *
 * ─── MUTATIONS RUN, WATCHED FAIL, AND RESTORED ───
 *
 * M1  `orchestrator-chat.tsx` — `send`'s success arm put back to what shipped:
 *     `releaseAttachments(attachments); setAttachments([])`. RED at
 *     `getByTitle("second.png")`: the file the owner attached and never sent is
 *     gone from the composer. This is the original defect, reproduced.
 * M2  same file — the filter widened to `previous.filter(() => false)`, i.e.
 *     `sent` ignored while everything else stays. RED, same assertion. This is
 *     the one that proves the test reads the FILTER rather than the mere
 *     presence of a `setAttachments` call.
 * M3  same file — `releaseAttachments(sent)` deleted. RED at
 *     `expect(revoked).toContain(firstUrl)` with `Received array: []` — nothing
 *     is ever revoked. Without this control the spec would accept a component
 *     that leaks everything, since "second.png was not revoked" is satisfied by
 *     revoking nothing.
 * M4  same file — `releaseAttachments(sent)` swapped for
 *     `releaseAttachments(held.current)`, the LIVE list. RED at
 *     `expect(revoked).not.toContain(secondUrl)`: the survivor's thumbnail is
 *     revoked underneath a chip that is still rendering it — the opposite
 *     mistake, and the one a fix aimed only at the leak would introduce.
 *
 * MUTATION THAT DOES **NOT** GO RED, RECORDED BECAUSE A SILENT ONE IS A LIE.
 * Swapping `releaseAttachments(sent)` back to `releaseAttachments(attachments)`
 * — leaving the new filter in place — passes both tests, and it should: `send`
 * is a `useCallback` over `[text, attachments, busy, onSend]`, so the closure
 * that runs holds the list AS IT WAS AT CLICK TIME, which is the same array
 * `sent` names. The release argument was never the bug; `setAttachments([])`
 * was. `sent` is named so that the two uses cannot drift apart later, and no
 * test in this file distinguishes those two spellings today.
 *
 * "a send that is REFUSED keeps every chip" ALSO PASSES AGAINST THE UNFIXED
 * COMPONENT — it did, on the first run, before a line was changed. It is a
 * control on the success gate (`.catch` must not release), not evidence for
 * this fix, and it is labelled that way rather than counted.
 *
 * ─── RE-POINTED 2026-08-05, AND ONE ASSERTION HAD LOST ITS TRIGGER ───
 *
 * THE WAY IN. Both tests died on `getByRole("button", { name: /^chat/ })`. The
 * rail replaced the old `chat` button with an icon whose accessible name is its
 * whole tooltip sentence — "Chat — send this run an instruction or a reference
 * image." — so the anchored, case-sensitive regex stopped matching. It is
 * `getByTestId("rail-chat")` now: that name is COPY, rewritten twice in the week
 * this repair was made, and a spec bound to it reports an editorial change as an
 * object-URL leak.
 *
 * THE THIRD ASSERTION NEEDED A NEW UNMOUNT, AND THIS IS THE PART WORTH READING.
 * "It is HELD, not leaked" is measured by unmounting the composer and watching
 * the survivor's URL come back — `orchestrator-chat.tsx:541` is the sweep
 * (`useEffect(() => () => releaseAttachments(held.current), [])`), and it can
 * only find what is still in the component's state. CLOSING THE PANEL NO LONGER
 * UNMOUNTS ANYTHING: `runs/[runId]/page.tsx:1006` mounts the chat at the run
 * view's level and merely sets `hidden`, deliberately, so a half-typed
 * instruction survives clicking Files. That is a product improvement and it
 * silently voided this assertion — `getByRole` ignores a `hidden` subtree, so
 * "the composer is gone" would still have PASSED while the sweep had not run and
 * the revoke had not happened.
 *
 * So the unmount is now a CLIENT-SIDE NAVIGATION away from the run view: the
 * app shell's "agent console" `<Link href="/">` (`components/app-shell.tsx:158`).
 * It has to be a `<Link>` click and not `page.goto` — a full navigation destroys
 * the document, and with it `window.__blobLog`, so the revoke would be
 * unobservable rather than absent. MEASURED, not assumed: with the navigation
 * replaced by the old panel-close the test goes GREEN on `toHaveCount(0)` and RED
 * on the revoke, which is exactly the hole described above. That experiment was
 * run — the failure came in past `expect(sendButton).toHaveCount(0)`, at
 * `expect(revoked).toContain(secondUrl)` with only the SENT url in the array.
 *
 * M5, THE CONTROL FOR THE NEW UNMOUNT — 2026-08-05. `orchestrator-chat.tsx:541`,
 * the sweep itself, replaced by `useEffect(() => () => undefined, [])`. RED at
 * the same revoke assertion, with the sent url present and the survivor's absent;
 * the second test stayed green, which is right, since it revokes nothing either
 * way. So the navigation really unmounts the composer and the sweep really runs:
 * the third assertion is live again rather than merely re-worded.
 */

import { expect, test, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

/** The smallest valid PNG, so the browser really decodes something. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

declare global {
  interface Window {
    /** Every object URL this document made and every one it handed back. */
    readonly __blobLog: { readonly created: string[]; readonly revoked: string[] };
  }
}

/**
 * Record every `createObjectURL`/`revokeObjectURL` before a single app module
 * runs.
 *
 * The real implementations are still called, so nothing about the page's
 * behaviour changes — a spy that swallowed the revoke would make the leak
 * unobservable by causing it.
 */
async function watchBlobs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const created: string[] = [];
    const revoked: string[] = [];
    const makeUrl = URL.createObjectURL.bind(URL);
    const dropUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource): string => {
      const url = makeUrl(object);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
      dropUrl(url);
    };
    Object.defineProperty(window, "__blobLog", { value: { created, revoked } });
  });
}

function revoked(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...window.__blobLog.revoked]);
}

/**
 * The composer's send button — `exact`, and that is not tidiness.
 *
 * MEASURED: `getByRole("button", { name: "send" })` is a SUBSTRING match, and the
 * rail's own Chat icon is named with its whole tooltip sentence — "Chat — send
 * this run an instruction or a reference image." So the loose name resolved to
 * two buttons and Playwright refused it in strict mode. `exact: true` is what
 * separates the control from a sentence describing it, and it also keeps
 * `sending…` out, which the assertions below depend on being a different state.
 */
const sendButton = (page: Page) =>
  page.getByRole("button", { name: "send", exact: true });

/**
 * The `blob:` URL the chip for `name` is actually rendering.
 *
 * READ OFF THE `<img>` RATHER THAN FROM THE CREATION ORDER, because anything
 * else on this page that makes an object URL would shift an index and the spec
 * would then be asserting about the wrong file while still going green.
 */
async function previewUrlOf(page: Page, name: string): Promise<string> {
  const image = page.locator(`img[alt="${name}"]`);
  await expect(image).toBeVisible();
  const source = await image.getAttribute("src");
  expect(source).toMatch(/^blob:/);
  return source ?? "";
}

interface HeldSend {
  /** Let the POST answer. Resolves once the handler has been reached. */
  readonly release: () => void;
}

/**
 * Open the run's chat with `POST …/messages` intercepted and HELD.
 *
 * The shared fixture API does not serve a POST for this run, and it could not
 * hold one open anyway; the interception is what makes "in flight" a state the
 * spec can stand inside. Every other request — the run detail, the event
 * stream, the GET of the transcript — goes to the fixture untouched.
 */
async function openHeldChat(page: Page): Promise<HeldSend> {
  let reached: (() => void) | null = null;
  await page.route("**/api/runs/*/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await new Promise<void>((resolve) => {
      reached = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { seq: 1, at: new Date().toISOString(), role: "owner", text: "", images: [], deliveredAt: null },
      }),
    });
  });

  await page.goto(`/runs/${RUN_ID}`);
  await page.getByTestId("rail-chat").click();
  await expect(sendButton(page)).toBeVisible();

  return {
    release: () => {
      // Assigned by the route handler when the POST arrives; the caller waits
      // for the button to read `sending…` first, which is that same moment.
      const resolve: (() => void) | null = reached;
      if (resolve === null) throw new Error("the POST was never intercepted, so nothing was in flight");
      resolve();
    },
  };
}

async function attach(page: Page, name: string): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "image/png", buffer: PNG_BYTES });
  await expect(page.getByTitle(name)).toBeVisible();
}

test("an image attached while the send is in flight survives it, and is still held", async ({ page }) => {
  await watchBlobs(page);
  const held = await openHeldChat(page);

  await page.getByPlaceholder(/Tell it what to change/).fill("look at this");
  await attach(page, "first.png");
  const firstUrl = await previewUrlOf(page, "first.png");

  await sendButton(page).click();
  // The composer says `sending…` for exactly as long as the POST is held, so
  // this is the in-flight window and everything below happens inside it.
  await expect(page.getByRole("button", { name: "sending…" })).toBeVisible();

  await attach(page, "second.png");
  const secondUrl = await previewUrlOf(page, "second.png");
  expect(secondUrl).not.toBe(firstUrl);

  held.release();
  await expect(sendButton(page)).toBeVisible();

  // ── what was SENT is gone, and its preview was handed back ────────────────
  // The positive control: a release that never happened would satisfy every
  // assertion about the survivor below.
  await expect(page.getByTitle("first.png")).toHaveCount(0);
  expect(await revoked(page)).toContain(firstUrl);

  // ── what was NOT sent is still there, and is still rendering ──────────────
  // THE DEFECT'S SIGNATURE. Before the fix this chip was gone: `setAttachments([])`
  // cleared the whole list, sent or not.
  await expect(page.getByTitle("second.png")).toBeVisible();
  expect(await revoked(page)).not.toContain(secondUrl);
  // The thumbnail still resolves — a revoked URL under a live chip renders as a
  // broken image, which is the opposite mistake and is invisible to a count.
  await expect(page.locator('img[alt="second.png"]')).toHaveJSProperty("naturalWidth", 1);

  // ── and it is HELD, not leaked ────────────────────────────────────────────
  /*
   * This is the assertion the leak needs. "not revoked" is equally true of the
   * broken version; being revoked ON UNMOUNT is only true when the survivor is
   * still in the component's state for the sweep to find.
   *
   * THE UNMOUNT IS A CLIENT-SIDE NAVIGATION, NOT A PANEL CLOSE — see this file's
   * header. Closing the rail panel leaves the composer mounted and merely
   * `hidden`, so it revokes nothing and the old form of this check passed on a
   * document still holding the blob.
   */
  await page.getByRole("link", { name: /agent console/ }).click();
  await expect(page).toHaveURL(/\/$/);
  // The composer really is gone from the document, not merely hidden: `hidden`
  // takes a subtree out of the accessibility tree too, so this alone would not
  // have told the two apart. It is the precondition, and the revoke is the fact.
  await expect(sendButton(page)).toHaveCount(0);
  expect(await revoked(page)).toContain(secondUrl);
});

test("a send that is REFUSED keeps every chip, and revokes nothing", async ({ page }) => {
  // The other half of the rule, and the one a filter written against the wrong
  // list would also break: nothing is released unless the post succeeded.
  await watchBlobs(page);
  await page.route("**/api/runs/*/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "this run has finished" }),
    });
  });

  await page.goto(`/runs/${RUN_ID}`);
  await page.getByTestId("rail-chat").click();
  await attach(page, "kept.png");
  const keptUrl = await previewUrlOf(page, "kept.png");

  await sendButton(page).click();
  await expect(page.getByText("this run has finished")).toBeVisible();

  await expect(page.getByTitle("kept.png")).toBeVisible();
  expect(await revoked(page)).not.toContain(keptUrl);
});
