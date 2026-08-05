/**
 * pages-prose.browser.spec.ts — the two PAGES after the prose pass, and the one
 * distinction the rest of this suite cannot currently make.
 *
 * THE CUT THIS FILE GUARDS. `app/page.tsx` (the new-ticket form) and
 * `app/runs/[runId]/page.tsx` (the run view) carried 434 words of user-visible
 * string, most of it explanatory paragraphs under controls. Four facts on those
 * screens change what a person types or clicks and could not be deleted:
 *
 *   1. an attached file re-keys the ticket, so it is graded by different tests;
 *   2. grading runs offline, so a criterion needing Stripe or a hosted database
 *      is graded against a stand-in;
 *   3. the first link in a brief is captured once and never re-read;
 *   4. a message typed into a run that is past its build segments will most
 *      likely never be read.
 *
 * They are behind `Explain` now. Which is the whole reason this file exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY ASSERTION HERE MEASURES GEOMETRY INSTEAD OF CALLING `toBeVisible`.
 *
 * `Explain` keeps its sentence in the DOM at all times — `sr-only` when shut, so
 * a screen reader in browse mode still gets the fact — and Tailwind's `sr-only`
 * is `position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0)`.
 * A 1px box is a NON-EMPTY box, so Playwright reports it VISIBLE. Measured on
 * this tree, not assumed: `toBeVisible()` passes against text no sighted reader
 * can see.
 *
 * That is not a footnote, it is the failure mode this lane was warned about:
 * MOVING A FACT AND LOSING IT MUST NOT LOOK THE SAME TO THE SUITE, and to a
 * `toBeVisible` suite, moving a fact behind the glyph and leaving it painted on
 * the page ALSO look the same. So:
 *
 *   · "on screen without interaction" is a `Range` rect at least 100px wide
 *     WHOSE OWN PIXELS ANSWER `elementFromPoint` — i.e. a reader's click at the
 *     start of that sentence lands on that sentence;
 *   · "reachable" is: the trigger's `aria-describedby` target holds the sentence
 *     while shut, and one click paints it in a box big enough to read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MUTATIONS APPLIED TO PRODUCTION CODE, RUN, WATCHED RED, REVERTED. Every one
 * below was really edited into the file and really run; none is a claim.
 *
 * M1  `app/page.tsx` — the inline "Grading runs offline, with no logins." wrapped
 *     in a second `<Explain>` so it becomes `sr-only`, i.e. the KEPT fact is
 *     MOVED. RED in "the offline-grading condition is painted…", at
 *     `expect(box?.hits).toBe(true)`.
 *     AND THIS IS THE MEASUREMENT THAT JUSTIFIES THE WHOLE HELPER: the WIDTH and
 *     HEIGHT assertions above it still PASSED under this mutation. `sr-only` text
 *     lays out at its full natural size and merely gets clipped, so a spec that
 *     measured the box and stopped would have called hidden text "on screen".
 *     Only the hit test saw it. This is the control the lane brief demands for a
 *     KEEP-INLINE decision.
 * M2  `app/page.tsx` — the `<Explain about="grading offline">` deleted outright,
 *     leaving the short inline line. RED in "the grading consequence is one click
 *     away", `toHaveCount(1)` → received 0. The fact was deleted, and the suite
 *     says so instead of reading it as a successful trim.
 * M3  `app/page.tsx` — the `<Explain about="attaching files">` deleted. RED in
 *     "the identity rule is reachable before a file is attached", same shape.
 *     Without this control, moving the identity rule out of its conditional
 *     paragraph and landing it nowhere would look exactly like a tidy-up.
 * M4  `app/page.tsx` — "When off, the build stays on this machine." restored
 *     under the deploy checkbox. RED in "the deleted paragraphs are gone from the
 *     DOM…" at `/stays on this machine/i`. The delete half has teeth too.
 * M5  `runs/[runId]/page.tsx` — `chatDeliveryNote`'s `spec` branch returned to
 *     the shipped 60-word paragraph (`text` = all of it, `detail` = ""). RED in
 *     "the chat note is one line…" at `expect(box).not.toBeNull()`: the short
 *     sentence is not on the screen at all. Recorded honestly — this fails on the
 *     FIRST assertion rather than on the height one it was aimed at, which is why
 *     M5b exists.
 * M5b `runs/[runId]/page.tsx` — the short sentence KEPT and the old mechanism
 *     clause appended to it, so the note is one paragraph of three lines again.
 *     Run twice. The first spelling used "segment's prompt" and went RED on the
 *     jargon assertion while the height assertion PASSED — because the height was
 *     being read off a `Range` around the first sentence, which stayed short
 *     while the paragraph around it grew. The assertion was changed to measure
 *     the PARAGRAPH's own box, and a second spelling of M5b in plain words
 *     ("the next design or build agent's instructions…") then went RED on height:
 *     92.03px against a cap of 80. Both spellings are recorded because the first
 *     one found a real hole in this spec.
 * M6  `runs/[runId]/page.tsx` — the `<Explain>` beside the delivery note deleted.
 *     RED in the same test: `getByTestId("explain-delivery")` never resolves.
 * M7  `app/page.tsx` — the unreachable clause ("If the page cannot be reached the
 *     run says so…") deleted from the capture bubble, leaving the rest. RED in
 *     "the capture rule keeps its unreachable clause". A moved paragraph that
 *     quietly loses a clause on the way is the failure this lane was warned
 *     about; a bubble that merely EXISTS would satisfy anything weaker.
 * M8  `app/page.tsx` — the motion bubble's second sentence ("What was read from
 *     it is shown on the run's own page") deleted, which is what the first draft
 *     of this pass actually shipped. RED in "the deleted paragraphs are gone from
 *     the DOM…". It is here because that sentence LOOKS like a pointer worth
 *     cutting and is not: `ticket-motion.browser.spec.ts:174` records that the
 *     form may not be read as asserting the link was read.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ModelOption } from "../src/lib/api-types";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const RUN = "harness-prose-run";

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

/**
 * WHERE A SENTENCE ACTUALLY IS ON THE GLASS.
 *
 * A `Range` around the text itself rather than its element's box, because the
 * element is a flex row wider than the words in it — an element-box assertion
 * would be satisfied by an empty row. And `elementFromPoint` on top of the
 * measurement, because `sr-only` text still LAYS OUT at its natural width
 * (`white-space: nowrap` inside a 1px box overflows rather than wrapping), so a
 * width test alone cannot tell painted from hidden. Hit testing can: `clip`
 * removes the element from it.
 */
async function paintedBox(
  page: Page,
  needle: string,
): Promise<{ width: number; height: number; hits: boolean } | null> {
  return page.evaluate((text: string) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const content = node.textContent ?? "";
      const at = content.indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const rect = range.getBoundingClientRect();
      const owner = node.parentElement;
      // Two characters in from the left edge and halfway down: inside the first
      // word, never in the gap after the last one.
      const hit = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2);
      return {
        width: rect.width,
        height: rect.height,
        hits: owner !== null && hit !== null && (hit === owner || owner.contains(hit) || hit.contains(owner)),
      };
    }
    return null;
  }, needle);
}

/**
 * THE ONE BUBBLE THAT IS OPEN, resolved through the trigger's own
 * `aria-describedby`.
 *
 * `getByRole("tooltip")` cannot be used: every `Explain` on the page keeps its
 * content element mounted with `role="tooltip"` whether it is open or not (that
 * is what puts the sentence in the accessibility tree), so a bare role lookup is
 * a strict-mode violation on any screen with two of them. Going through the
 * trigger also means the assertion proves the OPENED bubble belongs to the
 * control that was clicked, rather than to whichever one the DOM happened to
 * put first.
 */
async function bubbleOf(page: Page, triggerName: string | RegExp) {
  const trigger = page.getByRole("button", { name: triggerName });
  await expect(trigger).toHaveCount(1);
  const id = await trigger.getAttribute("aria-describedby");
  expect(id).not.toBeNull();
  // An attribute selector rather than `#id`: React's `useId` values contain
  // underscores and colons, and `CSS.escape` does not exist in Node's context.
  return page.locator(`[id="${id ?? ""}"]`);
}

/** Does this string appear ANYWHERE in the document, painted or `sr-only`? */
async function anywhereInDom(page: Page, pattern: RegExp): Promise<boolean> {
  const text = await page.evaluate(() => document.body.textContent ?? "");
  return pattern.test(text);
}

/**
 * The new-ticket form with its own API, following `ticket-redundancy`,
 * `ticket-motion` and `model-picker`: the shared fixture serves the canvas
 * specs, and a form spec serves its own intake.
 */
async function serveForm(page: Page): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/runs" && request.method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ runId: RUN }),
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
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await expect(page.getByRole("textbox").first()).toBeVisible();
}

/**
 * A run STOPPED IN THE SPEC PHASE — the state the chat's delivery note describes
 * and the shared fixture cannot reach.
 *
 * `RUN_DETAIL` is `phase: "build"`, and patching it through the live fixture
 * would not hold: `use-run-stream.ts:599` folds the replayed `phase` event back
 * over the REST snapshot, so the note would flip to null a second after paint.
 * Hence a whole synthetic run with `/events` answering 204 — no stream, no
 * fold, one deterministic phase.
 */
async function serveSpecPhaseRun(page: Page): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/models") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MODELS),
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
    if (path.endsWith("/messages")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [] }),
      });
      return;
    }
    if (path === `/api/runs/${RUN}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...RUN_DETAIL,
          runId: RUN,
          status: "running",
          phase: "spec",
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/runs/${RUN}`);
  await page.getByRole("button", { name: /^Chat\b/i }).click();
  await expect(page.getByPlaceholder(/Tell it what to change/)).toBeVisible();
}

/* ─────────────────────────── THE NEW-TICKET FORM ─────────────────────────── */

test("the offline-grading condition is painted on screen, with no interaction", async ({
  page,
}) => {
  // THE KEEP-INLINE DECISION, MEASURED. This half of the grading note is the one
  // sentence on the form that can stop a payments story being written against a
  // grader that cannot reach a payment provider, and it has to be readable WHILE
  // the brief is being typed. M1 above is the mutation that moves it behind the
  // glyph; it fails here rather than looking like a tidier form.
  await serveForm(page);

  const box = await paintedBox(page, "Grading runs offline, with no logins.");
  expect(box).not.toBeNull();
  // A real line of 11px type is ~190px wide here. `sr-only` collapses the box
  // that answers `elementFromPoint`, which is the assertion with the teeth.
  expect(box?.width ?? 0).toBeGreaterThan(100);
  expect(box?.height ?? 0).toBeGreaterThan(8);
  expect(box?.hits).toBe(true);
});

test("the grading consequence is one click away, and is in the a11y tree before the click", async ({
  page,
}) => {
  // THE MOVE, MEASURED BOTH WAYS. The paragraph that used to name payment
  // providers, databases and logins is gone from the glass; the fact is not.
  await serveForm(page);

  const trigger = page.getByRole("button", { name: "Explain: grading offline" });
  await expect(trigger).toHaveCount(1);

  // BEFORE ANY CLICK: the sentence is the trigger's own description, which is
  // what a screen reader in browse mode reads. A tooltip that only exists while
  // open is a tooltip that population never hears.
  const bubble = await bubbleOf(page, "Explain: grading offline");
  await expect(bubble).toContainText(/stand-in the build wrote itself/i);

  await trigger.click();
  await expect(bubble).toContainText(
    /needs a real payment provider, hosted database or login/i,
  );
  // AND IT IS PAINTED, not merely present: `sr-only` would satisfy every
  // assertion above it.
  const rect = await bubble.boundingBox();
  expect(rect?.width ?? 0).toBeGreaterThan(150);
  expect(rect?.height ?? 0).toBeGreaterThan(30);
});

test("the identity rule is reachable before a file is attached", async ({ page }) => {
  // IT USED TO APPEAR AT THE FIRST CHIP — after the decision it describes. On the
  // glyph beside the intake it is readable while deciding whether to attach at
  // all, and costs no words either way. What may NOT happen is the third
  // outcome: the sentence quietly disappearing with the paragraph (M3).
  await serveForm(page);

  const bubble = await bubbleOf(page, "Explain: attaching files");
  await page.getByRole("button", { name: "Explain: attaching files" }).click();

  await expect(bubble).toContainText(
    "A different file makes this a different ticket, with its own tests.",
  );
});

test("the capture rule keeps its unreachable clause, behind the glyph", async ({
  page,
}) => {
  await serveForm(page);

  // ABSENT UNTIL THE BRIEF LINKS SOMEWHERE — including from the accessibility
  // tree, which is where a moved sentence hides. `linksToAPage` gates the whole
  // paragraph, glyph included.
  expect(await anywhereInDom(page, /the live page is never opened again/i)).toBe(false);

  await page
    .getByRole("textbox")
    .first()
    .fill("Copy the booking flow at https://example.com onto our stack.");

  // The line that changes what he types stays painted…
  const box = await paintedBox(
    page,
    "The first link in this brief is captured before the tests are written.",
  );
  expect(box?.hits).toBe(true);
  expect(box?.width ?? 0).toBeGreaterThan(100);

  // …and the two sentences about what happens AFTER submission are one click
  // away. The unreachable clause in particular may not be dropped: without it
  // the paragraph asserts a capture that a refused host or a timeout never made.
  const bubble = await bubbleOf(page, "Explain: capturing that link");
  await page.getByRole("button", { name: "Explain: capturing that link" }).click();
  await expect(bubble).toContainText(/the live page is never opened again/i);
  await expect(bubble).toContainText(/if the page cannot be reached the run says so/i);
});

test("the deleted paragraphs are gone from the DOM, and the kept facts are not", async ({
  page,
}) => {
  // THE PAIRING IS THE POINT, and it is the house idiom: four absences alone are
  // satisfied by an empty page, and the presences alone by the form nobody
  // touched. `anywhereInDom` rather than `toHaveCount(0)` because a sentence
  // parked in an `sr-only` node is still read aloud — a delete has to be a
  // delete.
  await serveForm(page);

  // Deleted: an unchecked checkbox states its own default, and where the build
  // lands is on the run's Result panel (M4 restores it).
  expect(await anywhereInDom(page, /stays on this machine/i)).toBe(false);
  // Deleted: it pointed at a surface that only exists after submission, and
  // named it "event stream" — which is not what that panel is called.
  expect(await anywhereInDom(page, /event stream/i)).toBe(false);
  // Reworded, not merely moved: "stub" was the one word on this form a person
  // who does not write code cannot be assumed to have.
  expect(await anywhereInDom(page, /graded against a stub/i)).toBe(false);

  // Kept, painted, unconditional: the one sentence that changes the output.
  const subtitle = await paintedBox(
    page,
    "Describe what you want built, and how you will know it works.",
  );
  expect(subtitle?.hits).toBe(true);

  // Kept as facts, behind glyphs — four of them and no more, so "hide it" cannot
  // quietly become this form's new default.
  await expect(page.getByRole("button", { name: /^Explain: / })).toHaveCount(4);
  expect(await anywhereInDom(page, /Asking stops the run once the mockups exist/i)).toBe(true);
  expect(await anywhereInDom(page, /Only the movement is taken/i)).toBe(true);
  // AND THE MOTION NOTE STILL DEFERS. `ticket-motion.browser.spec.ts:174` records
  // why the second half of that note may not simply vanish: this form must not
  // be read as claiming a reading HAPPENED. The old wording pointed at "the
  // run's own event stream" — a phrase on no screen in this app — so the
  // vocabulary changed and the deferral did not (M8).
  expect(await anywhereInDom(page, /what was read from it is shown on the run/i)).toBe(true);
});

/* ───────────────────────────── THE RUN VIEW ──────────────────────────────── */

test("the chat note is one line on screen, and the mechanism is one click behind it", async ({
  page,
}) => {
  await serveSpecPhaseRun(page);

  // ON THE GLASS: one sentence, and it is the one that decides whether typing is
  // worth it at all. M5 puts the 60-word paragraph back.
  const box = await paintedBox(
    page,
    "The tests are still being written, so a message is stored rather than delivered.",
  );
  expect(box).not.toBeNull();
  expect(box?.hits).toBe(true);

  /*
   * AND THE WHOLE NOTE IS THAT SENTENCE, measured as the paragraph's own height
   * rather than as a word count.
   *
   * THE RANGE'S HEIGHT IS NOT ENOUGH AND THE MUTATION IS WHY: M5b appended the
   * old mechanism clause to the same paragraph, and the range around the FIRST
   * sentence still measured short — the paragraph grew underneath it. The block
   * is what a reader sees, so the block is what is asserted. The rail panel is
   * ~324px wide: this sentence wraps to two lines there, the shipped paragraph
   * wrapped to five.
   */
  const noteHeight = await page
    .getByTestId("explain-delivery")
    .evaluate((el: Element) => el.closest("p")?.getBoundingClientRect().height ?? 0);
  expect(noteHeight).toBeGreaterThan(0);
  expect(noteHeight).toBeLessThan(80);

  // NOT IN THE NOTE AT ALL — neither painted nor `sr-only` — is the vocabulary
  // the paragraph used to carry. SCOPED TO THIS NOTE rather than to the
  // document: "segment" and "suite" appear in surfaces five other lanes own, and
  // a document-wide assertion here would go red on their edits and tell this
  // lane nothing.
  const note = await page
    .getByTestId("explain-delivery")
    .evaluate((el: Element) => el.closest("p")?.textContent ?? "");
  expect(note).not.toMatch(/segment/i);
  expect(note).not.toMatch(/suite/i);
  expect(note).not.toMatch(/build session/i);
  expect(note).not.toMatch(/prompt/i);

  // BEHIND THE GLYPH: why the line above is true, and the fact that a message
  // sent now reaches the first design or build agent — which is what makes
  // sending early worth doing (M6 deletes it).
  const bubble = await bubbleOf(page, /^Explain: messages while the tests/);
  await page.getByTestId("explain-delivery").click();
  await expect(bubble).toContainText(/no agent is building yet/i);
  await expect(bubble).toContainText(/first design or build agent/i);
  const rect = await bubble.boundingBox();
  expect(rect?.width ?? 0).toBeGreaterThan(150);
});
