/**
 * Opening the chat panel, and finding it once it is open.
 *
 * WHY IT IS HERE — 2026-08-25. `orchestrator-steer.browser.spec.ts` and
 * `chat-parked.browser.spec.ts` each carried the same three lines (goto, click
 * `rail-chat`, wait for the composer), and `chat-plan-copy.browser.spec.ts`
 * and `chat-parked` each derived a section locator for the same panel from a
 * different anchor. Both strings this module pins are ones that have moved
 * before: `chat-attachments.browser.spec.ts` records the rail entry's
 * accessible name being rewritten twice in one week — which is why the entry
 * is found by its test id and never by name — and the composer's name is an
 * `aria-label` on the textarea (`orchestrator-chat.tsx`) that a copy pass can
 * touch. One copy of each, here, is one place that goes red on the next
 * rename. The two older specs still hold their own; folding them in is a
 * follow-up.
 *
 * THE PANEL IS MOUNTED HIDDEN, NOT UNMOUNTED, UNTIL THE ENTRY IS CLICKED —
 * `runs/[runId]/page.tsx` mounts the chat at the run view's level and merely
 * sets `hidden`, so a half-typed instruction survives a switch to Files
 * (`chat-attachments.browser.spec.ts` records the assertion that change
 * silently voided). `getByRole` ignores a hidden subtree, so `openChatPanel`
 * waits for the composer to be VISIBLE before it returns, and a spec that
 * reads a chat row before calling it is red for the wrong reason.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/** The composer's accessible name — `aria-label` on the textarea. */
const COMPOSER_NAME = "Message the orchestrator";

/**
 * Click the rail's chat entry and wait for the composer. Split from the
 * `goto` because a park opens the rail's QUESTIONS slot by default and a spec
 * may need to assert that panel first — opening the chat replaces it
 * (`chat-parked.browser.spec.ts`, the two park neighbours).
 */
export async function openChatPanel(page: Page): Promise<void> {
  await page.getByTestId("rail-chat").click();
  await expect(page.getByRole("textbox", { name: COMPOSER_NAME })).toBeVisible();
}

export async function openChat(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await openChatPanel(page);
}

/**
 * The chat panel: the section that holds the composer. Anchored on the
 * textbox `openChatPanel` has already waited for, so the wait and the locator
 * pin one string between them; `chat-plan-copy.browser.spec.ts`'s `composer`
 * reaches the same section through its send button.
 */
export function chatSection(page: Page): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("textbox", { name: COMPOSER_NAME }) });
}
