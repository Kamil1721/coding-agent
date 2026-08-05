/**
 * THE "i" — proved against the four ways it can silently become a downgrade.
 *
 * WHAT THIS COMPONENT REPLACES. Roughly 1,700 words of permanent explanatory
 * prose across eighteen components. The owner's ask was "if something really
 * must have a explanation it should have little i icon to when i hover over it
 * brings it up", and the failure mode of granting exactly that ask is a bubble
 * only a mouse can open — the prose everyone could read replaced by a fact only
 * some readers can reach. Every test below is aimed at one of the ways that
 * happens:
 *
 *   1. IT OPENS FROM THE KEYBOARD and Escape both closes it and hands focus
 *      back. The mutation is "make it hover-only", which is the exact shortcut
 *      the ask invites.
 *   2. THE TEXT IS ATTACHED TO THE TRIGGER FOR ASSISTIVE TECH, and it is
 *      attached WHILE CLOSED as well — a screen reader in browse mode never
 *      moves DOM focus, so a description that only exists while open is a
 *      description that user never hears.
 *   3. IT DOES NOT MOVE THE PAGE. A bubble that reflows the line it explains is
 *      worse than the paragraph it replaced.
 *   4. IT IS NOT CLIPPED BY THE PANEL IT LIVES IN. Every adopted call site will
 *      sit inside the rail's `overflow-y-auto` body inside the run view's
 *      `overflow-hidden` shell, and an in-place bubble is cut off there — near
 *      an edge only, which is the kind of half-working a spot check passes.
 *
 * ASSERTIONS ARE ON CONTENT AND ON MEASURED GEOMETRY, never on `toBeVisible()`
 * alone: "the element exists" is this repository's signature defect.
 *
 * IT RUNS AGAINST `/explain-probe`, a bench route that exists because this
 * component landed before the six lanes that consume it. See that file's
 * docblock — including the part about deleting it once a real screen carries an
 * `Explain` and this spec can be retargeted.
 *
 * EVERY MUTATION NAMED BELOW WAS APPLIED TO `src/components/explain.tsx`,
 * WATCHED GO RED, AND REVERTED.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

const FLOW_TEXT = "Written from your ticket before any code existed, then locked.";
const CLIPPED_TEXT = "The workspace holds no publishable file yet.";

async function openBench(page: Page): Promise<void> {
  await page.goto("/explain-probe");
  await expect(page.getByTestId("probe-before")).toBeVisible();
}

/**
 * SHOWN AND SHUT ARE MEASURED, BECAUSE `toBeHidden()` CANNOT SEE THIS.
 *
 * Found by running it, not by reading it: every assertion in the first draft of
 * this file used `toBeVisible()`/`toBeHidden()`, and five tests failed with
 * `locator resolved to <span class="sr-only" …> - unexpected value "visible"`.
 * A shut bubble is `sr-only` — 1x1, clipped, off-colour — precisely so its text
 * stays in the accessibility tree for `aria-describedby`, and Playwright counts
 * any non-empty box as visible. So `toBeHidden()` was never going to go green
 * while the component was doing the accessible thing, and — much worse — a test
 * written the other way round (`toBeVisible()` for the open state) would have
 * stayed GREEN against a component that never painted anything at all.
 *
 * The width of the box is the honest signal: 1px shut, hundreds open.
 *
 * THE `visibility` GATE WAS ADDED AFTER A FLAKE, not from first principles. The
 * bubble has to be MEASURED before it can be PLACED, so for one frame it exists
 * at full width with `visibility: hidden` at the viewport's origin. Width alone
 * accepted that frame, and the clipping test read the geometry of a bubble that
 * had not been positioned yet — it failed with a centre 18px down the page,
 * having passed on every earlier run. A width test that can pass on an unpainted
 * element is a width test that proves nothing.
 */
async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    if (getComputedStyle(element).visibility !== "visible") return 0;
    return Math.round(element.getBoundingClientRect().width);
  });
}

async function expectShut(locator: Locator): Promise<void> {
  await expect
    .poll(async () => widthOf(locator), { message: "the bubble is still painted" })
    .toBeLessThanOrEqual(2);
}

async function expectShowing(locator: Locator, text: string): Promise<void> {
  await expect(locator).toHaveText(text);
  await expect
    .poll(async () => widthOf(locator), { message: "the bubble is not painted" })
    .toBeGreaterThan(80);
}

/** The bubble's own box, in viewport coordinates. */
async function boxOf(locator: Locator): Promise<{
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    };
  });
}

test.describe("the keyboard path, which is the one hover-only breaks", () => {
  test("Tab opens it, Escape closes it and gives focus back", async ({ page }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-flow");
    const bubble = page.getByTestId("explain-flow-body");

    await expectShut(bubble);

    /*
     * ARRIVED AT BY A REAL TAB, not by `locator.focus()`. `:focus-visible` is
     * what decides whether focus opens the bubble — a mouse click focuses the
     * button too, and opening on that would fight the click toggle — and only a
     * genuine key press sets it. A programmatic focus is not the path under
     * test.
     */
    await page.getByTestId("probe-before").click();
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();

    /*
     * MUTATION APPLIED: deleted `onFocus` and `onClick` from the trigger in
     * `explain.tsx`, leaving the pointer handlers — i.e. the hover-only version
     * the owner's wording invites. This went red here: the bubble never
     * appeared. Reverted.
     *
     * CONTENT, NOT PRESENCE. `toHaveText` is what makes this a test of the fact
     * being reachable rather than of a box being drawn.
     */
    await expectShowing(bubble, FLOW_TEXT);


    /*
     * MUTATION APPLIED: dropped the `Escape` branch of the window keydown
     * listener. The bubble stayed up and this went red. Reverted.
     */
    await page.keyboard.press("Escape");
    await expectShut(bubble);

    /*
     * AND FOCUS IS STILL ON THE TRIGGER. Escape that closes the bubble and drops
     * focus on `<body>` strands a keyboard reader mid-page.
     *
     * A MUTATION THAT DID NOT REDDEN, RECORDED RATHER THAN QUIETLY DROPPED:
     * deleting `triggerRef.current?.focus()` from the Escape branch left this
     * GREEN, because on this path focus never left the trigger in the first
     * place — the line was a no-op here and the comment claiming it was under
     * test was wrong. `explain.tsx` now guards that restore, and the mutation
     * that DOES redden this is the one that actually breaks the promise:
     * MUTATION APPLIED: `triggerRef.current?.blur()` in place of the restore.
     * Focus went to `<body>` and this went red. Reverted.
     */
    await expect(trigger).toBeFocused();
  });

  test("Escape after a hover does not drag focus onto the glyph", async ({ page }) => {
    await openBench(page);

    const bubble = page.getByTestId("explain-flow-body");
    const before = page.getByTestId("probe-before");

    /*
     * THE OTHER HALF OF THE RESTORE. A mouse reader who pointed at a glyph and
     * pressed Escape has not asked for the caret to move there, and an
     * unguarded restore does exactly that — it would silently move keyboard
     * position every time somebody dismissed a hover.
     *
     * MUTATION APPLIED: removed the `hadFocus` guard, restoring focus
     * unconditionally. Focus jumped from the `before` button to the glyph and
     * this went red. Reverted.
     */
    await before.click();
    await expect(before).toBeFocused();
    await page.getByTestId("explain-flow").hover();
    await expectShowing(bubble, FLOW_TEXT);

    await page.keyboard.press("Escape");
    await expectShut(bubble);
    await expect(before).toBeFocused();
  });

  test("Escape is eaten here, so the panel around it does not also close", async ({
    page,
  }) => {
    await openBench(page);

    /*
     * WHY THIS IS ITS OWN TEST. The rail closes its whole panel on Escape
     * (`canvas/rail.tsx`, `onPanelKeyDown`), and React 19 attaches that handler
     * at the app root — INSIDE `window`. A bubble-phase listener in `explain.tsx`
     * would therefore run after it, and the reader's first Escape would close
     * the panel out from under the bubble they were reading. The listener is
     * capturing so it can stop the event.
     *
     * Measured on the bench, which has no rail: a capture-phase listener on
     * `document` — the position the rail's handler occupies relative to this one
     * — must not see the keydown while the bubble is open, and must see it once
     * the bubble is shut.
     *
     * MUTATION APPLIED: changed the `keydown` listener registration in
     * `explain.tsx` from capturing to bubbling (`true` -> omitted). The outer
     * listener saw the event and `outerSawEscape` came back 1. Reverted.
     */
    await page.evaluate(() => {
      const state = { count: 0 };
      (window as unknown as { __outer: { count: number } }).__outer = state;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape") state.count += 1;
        },
        true,
      );
    });

    await page.getByTestId("probe-before").click();
    await page.keyboard.press("Tab");
    await expectShowing(page.getByTestId("explain-flow-body"), FLOW_TEXT);

    await page.keyboard.press("Escape");
    await expectShut(page.getByTestId("explain-flow-body"));

    const outerSawEscape = await page.evaluate(
      () => (window as unknown as { __outer: { count: number } }).__outer.count,
    );
    expect(outerSawEscape, "the surrounding panel also received the Escape").toBe(0);

    // And the app is not left deaf to Escape: with the bubble shut it passes
    // straight through.
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => (window as unknown as { __outer: { count: number } }).__outer.count,
      ),
      "Escape is swallowed even when nothing is open",
    ).toBe(1);
  });
});

test.describe("the relationship assistive tech reads", () => {
  test("the trigger is named, and described by the bubble's own text", async ({
    page,
  }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-flow");
    const bubble = page.getByTestId("explain-flow-body");

    /*
     * A REAL NAME, DERIVED FROM `about`. Sixty buttons all called "More info" is
     * a screen reader reading out a wall of prose — the defect this control was
     * built to remove, by a quieter mechanism.
     *
     * MUTATION APPLIED: replaced `aria-label={`Explain: ${about}`}` with
     * `aria-label="More info"`. Red. Reverted.
     */
    await expect(trigger).toHaveAccessibleName("Explain: acceptance criteria");

    /*
     * AND THE WIRING ITSELF. Both halves are asserted — the attribute names the
     * bubble's id, and the bubble is the thing that id belongs to — because
     * either one alone passes against a dangling reference.
     *
     * MUTATION APPLIED: deleted `aria-describedby={id}` from the trigger. The
     * `describedby` read came back null and both this and the description
     * assertion below went red. Reverted.
     *
     * MUTATION APPLIED: deleted `role="tooltip"` from the bubble. This went red
     * on the role. Reverted.
     *
     * THE `toHaveCount(1)` IS NOT DECORATION. Without it the "bubble only exists
     * while open" mutation below reddened as a 60-SECOND TIMEOUT on
     * `getAttribute` against an element that was not there — red for the right
     * reason and unreadable about it. Counted first, the same mutation fails in
     * a second and says what it is.
     */
    await expect(
      bubble,
      "there is no description element on the page while the bubble is shut",
    ).toHaveCount(1);
    const describedby = await trigger.getAttribute("aria-describedby");
    expect(describedby, "the trigger points at nothing").not.toBeNull();
    expect(await bubble.getAttribute("id")).toBe(describedby);
    expect(await bubble.getAttribute("role")).toBe("tooltip");

    /*
     * DESCRIBED WHILE CLOSED, WHICH IS THE POINT. A screen reader reading in
     * browse mode never moves DOM focus, so a bubble that only exists while open
     * is a fact that reader never hears. The content element is always in the
     * tree — `sr-only` when shut — and this is the assertion that keeps it that
     * way.
     *
     * MUTATION APPLIED: rendered the bubble only when open
     * (`{open ? createPortal(bubble, document.body) : null}`). This went red on
     * the count above — no description element exists on a page nobody is
     * pointing at — while every visual test in this file stayed green, which is
     * exactly the failure it is here to catch. Reverted.
     */
    await expectShut(bubble);
    await expect(trigger).toHaveAccessibleDescription(FLOW_TEXT);

    // And still described once it is open, from the same single element.
    await trigger.click();
    await expectShowing(bubble, FLOW_TEXT);
    await expect(trigger).toHaveAccessibleDescription(FLOW_TEXT);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("pointer and touch", () => {
  test("hover opens it and leaving closes it", async ({ page }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-flow");
    const bubble = page.getByTestId("explain-flow-body");

    /*
     * MUTATION APPLIED: deleted `onPointerEnter` from the wrapper. Red — the
     * owner's literal ask is hover, and it has to keep working.
     */
    await trigger.hover();
    await expectShowing(bubble, FLOW_TEXT);

    await page.getByTestId("probe-after").hover();
    await expectShut(bubble);
  });

  test("a click keeps it up with no pointer on it, and a second click closes it", async ({
    page,
  }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-flow");
    const bubble = page.getByTestId("explain-flow-body");

    /*
     * THE TOUCH PATH, MEASURED THE ONLY WAY A DESKTOP RUN CAN. A tap has no
     * pointer to leave afterwards, so a click-opened bubble that closed on
     * `pointerleave` would be invisible on a phone — it would open and vanish in
     * the same gesture.
     *
     * MUTATION APPLIED: made `onPointerLeave` close unconditionally rather than
     * only when `openBy === "hover"`. The bubble vanished as soon as the pointer
     * moved off and this went red. Reverted.
     */
    await trigger.click();
    await expectShowing(bubble, FLOW_TEXT);
    await page.mouse.move(600, 600);
    await expectShowing(bubble, FLOW_TEXT);

    // A second click on the glyph closes it.
    await trigger.click();
    await expectShut(bubble);

    /*
     * AND A CLICK ANYWHERE ELSE CLOSES IT — but see the test below for WHICH
     * mechanism does it. MUTATION APPLIED: deleted the `pointerdown`
     * outside-click listener. THIS STAYED GREEN, because in Chromium a click
     * focuses the trigger and the click elsewhere blurs it. Recorded rather than
     * quietly kept: on this path the listener is not what closes the bubble.
     */
    await trigger.click();
    await expectShowing(bubble, FLOW_TEXT);
    await page.getByTestId("probe-after").click();
    await expectShut(bubble);
  });

  test("opening one shuts the others, so bubbles never stack", async ({ page }) => {
    await openBench(page);

    const first = page.getByTestId("explain-flow-body");
    const second = page.getByTestId("explain-canvas-body");

    /*
     * THREE OPEN BUBBLES IS THE WALL OF PROSE AGAIN, NOW FLOATING. Each glyph is
     * its own component, so nothing makes them exclusive by default — a reader
     * clicking down a panel would end up with a stack of them over the content
     * they were reading.
     *
     * THE SECOND ONE IS OPENED BY HOVER, and it took two rewrites to find the
     * case where the exclusivity loop is the only thing that can close the
     * first — both recorded rather than tidied away, because they say what the
     * loop is and is not for:
     *
     *   Click, then CLICK the second: green with the loop deleted. The second
     *     click blurs the first trigger and lands outside its wrapper, so
     *     `onBlur` and the outside-click listener both close it already.
     *   Click WITHOUT FOCUS (WebKit's behaviour), then click the second: green
     *     too, for the second of those reasons.
     *   Click, then HOVER the second: nothing is clicked and no focus moves, so
     *     this is the one that needs `show()`.
     *
     * MUTATION APPLIED: removed the `for (const other of MOUNTED_CLOSERS)` loop
     * from `show()`. Both bubbles were painted at once and this went red.
     * Reverted.
     */
    await page.getByTestId("explain-flow").click();
    await expectShowing(first, FLOW_TEXT);

    await page.getByTestId("explain-canvas").hover();
    await expectShowing(second, "What this card did, in one sentence.");
    await expectShut(first);
  });

  test("opened by a click that granted no focus, an outside click still closes it", async ({
    page,
  }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-flow");
    const bubble = page.getByTestId("explain-flow-body");

    /*
     * THE CASE BLUR CANNOT COVER, AND IT IS NOT HYPOTHETICAL. WebKit does not
     * focus a `<button>` when it is clicked — Safari on macOS and every browser
     * on iOS — so on those the trigger is opened with focus still wherever the
     * reader left it, and `onBlur` never fires for the click that dismisses it.
     * A bubble that could only be dismissed by blurring would be a bubble that
     * sticks to the screen on the owner's laptop and on any phone.
     *
     * Chromium cannot be asked to behave that way, so the click is DISPATCHED
     * without focus, which is the same state WebKit hands the component. The
     * previous test's version of this assertion passes on blur alone; this one
     * can only pass on the `pointerdown` listener.
     *
     * MUTATION APPLIED: replaced the `document.addEventListener("pointerdown",
     * …, true)` registration with `void onPointerDown;`. The previous test
     * stayed GREEN and this one went red — the bubble was still painted over the
     * page after the outside click. Reverted.
     */
    await trigger.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expectShowing(bubble, FLOW_TEXT);
    expect(
      await trigger.evaluate((element) => document.activeElement === element),
      "the trigger took focus, so this test is measuring blur again",
    ).toBe(false);

    await page.getByTestId("probe-after").click();
    await expectShut(bubble);
  });
});

test.describe("it costs the page nothing", () => {
  test("opening it moves no element and adds no scrollbar", async ({ page }) => {
    await openBench(page);

    const measure = async (): Promise<Record<string, number>> =>
      page.evaluate(() => {
        const rectOf = (id: string): DOMRect =>
          (
            document.querySelector(`[data-testid="${id}"]`) as HTMLElement
          ).getBoundingClientRect();
        const before = rectOf("probe-before");
        const neighbour = rectOf("probe-neighbour");
        const after = rectOf("probe-after");
        return {
          beforeTop: Math.round(before.top),
          neighbourLeft: Math.round(neighbour.left),
          neighbourTop: Math.round(neighbour.top),
          afterLeft: Math.round(after.left),
          afterTop: Math.round(after.top),
          docWidth: document.documentElement.scrollWidth,
          docHeight: document.documentElement.scrollHeight,
        };
      });

    const closed = await measure();
    await page.getByTestId("explain-flow").click();
    await expectShowing(page.getByTestId("explain-flow-body"), FLOW_TEXT);
    const opened = await measure();

    /*
     * THE WHOLE POINT OF A PORTAL AND `position: fixed`. A bubble in normal flow
     * pushes the words it is explaining out from under the reader's eye, which
     * is a worse experience than the paragraph it replaced.
     *
     * MUTATION APPLIED: dropped `fixed` from the open bubble's class list, so
     * the portaled bubble laid out in flow at the end of `<body>`. The whole
     * measurement came back different and this went red. Reverted.
     */
    expect(opened, "opening the bubble moved the page").toEqual(closed);
  });
});

test.describe("inside a scrolling panel, which is where every call site will live", () => {
  /**
   * Put the trigger near the bottom of the rail-shaped scroller, so the bubble
   * is placed BELOW the panel's own clip rect. Anything less does not test the
   * clipping at all — a bubble that happens to fit inside the panel passes
   * whether it escapes or not.
   */
  async function scrollTriggerToBottom(page: Page): Promise<number> {
    const scroller = page.getByTestId("probe-scroller");
    /*
     * MEASURED FROM RECTS, NOT FROM `offsetTop`, and the first version used
     * `offsetTop` and quietly measured nothing: the scroller is statically
     * positioned, so an inner element's `offsetParent` is not the scroller and
     * `offsetTop` is an offset from somewhere else entirely. The trigger ended up
     * mid-panel, the bubble fitted comfortably inside the clip rect, and the
     * assertion below — the one that exists to catch exactly this — is what said
     * so.
     */
    await scroller.evaluate((element) => {
      const trigger = element.querySelector<HTMLElement>('[data-testid="explain-clipped"]');
      if (trigger === null) throw new Error("the bench lost its clipped trigger");
      const panel = element.getBoundingClientRect();
      // Leave the glyph 6px clear of the panel's bottom edge, so the bubble is
      // placed at or below that edge and is cut in half by any clip.
      element.scrollTop += trigger.getBoundingClientRect().bottom - (panel.bottom - 6);
    });
    return scroller.evaluate((element) => element.getBoundingClientRect().bottom);
  }

  test("the bubble escapes the panel's clip and is hit-testable outside it", async ({
    page,
  }) => {
    await openBench(page);
    const scrollerBottom = await scrollTriggerToBottom(page);

    const trigger = page.getByTestId("explain-clipped");
    const bubble = page.getByTestId("explain-clipped-body");
    await trigger.click();
    await expectShowing(bubble, CLIPPED_TEXT);

    const box = await boxOf(bubble);

    /*
     * ITS CENTRE IS OUTSIDE THE PANEL — otherwise the rest of this proves
     * nothing, and this assertion is a control on the TEST rather than on the
     * component: it caught the `offsetTop` mistake above.
     */
    expect(
      box.top + box.height / 2,
      "the bubble fits inside the panel, so this test is not measuring clipping",
    ).toBeGreaterThan(scrollerBottom);

    /*
     * HIT-TESTED, NOT ASSUMED. `toBeVisible()` passes for an element its
     * ancestor has clipped to nothing in some layouts, and Playwright's own
     * visibility check is about boxes and styles rather than about paint.
     * `elementFromPoint` at the bubble's centre is the browser answering "what
     * is actually drawn here".
     *
     * MUTATION APPLIED: returned `bubble` directly instead of
     * `createPortal(bubble, document.body)`. This went red — but only on
     * `parentIsBody`, and the reason is worth more than the test: `position:
     * fixed` ALREADY escapes a plain `overflow` ancestor, so the un-portaled
     * bubble was still painted correctly here. A scrolling panel on its own
     * cannot prove the portal is load-bearing. The test below, against a
     * TRANSFORMED ancestor, is the one that can. Reverted.
     */
    const hit = await page.evaluate(
      (point) => {
        const element = document.elementFromPoint(point.x, point.y);
        const body = document.querySelector('[data-testid="explain-clipped-body"]');
        return {
          insideBubble: body !== null && element !== null && body.contains(element),
          parentIsBody: body?.parentElement === document.body,
        };
      },
      { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
    );
    expect(hit.insideBubble, "nothing of the bubble is painted at its own centre").toBe(
      true,
    );
    expect(hit.parentIsBody, "the bubble is still inside the scrolling panel").toBe(true);

    // And it is on-screen, not merely uncut.
    const viewport = page.viewportSize();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport?.width ?? 1280);
    expect(box.bottom).toBeLessThanOrEqual(viewport?.height ?? 720);
  });

  test("inside a transformed pane — the canvas — it is still painted where it belongs", async ({
    page,
  }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-canvas");
    const bubble = page.getByTestId("explain-canvas-body");
    await trigger.click();
    await expectShowing(bubble, "What this card did, in one sentence.");

    const box = await boxOf(bubble);
    const pane = await boxOf(page.getByTestId("explain-canvas").locator("xpath=ancestor::div[contains(@class,'overflow-hidden')][1]"));

    /*
     * THE CASE THAT MAKES THE PORTAL LOAD-BEARING. React Flow's viewport carries
     * a `transform`, which makes it the containing block for `position: fixed`
     * descendants and hands the clipping back to the `overflow: hidden` pane
     * around it. Every `Explain` on a canvas card is inside exactly that.
     *
     * MUTATION APPLIED: returned `bubble` instead of `createPortal(bubble,
     * document.body)`. `elementFromPoint` at the bubble's own centre came back
     * the pane rather than the bubble — mispositioned by the transform and
     * clipped by the pane — and this went red where the scrolling-panel test
     * above only noticed the missing portal structurally. Reverted.
     */
    expect(
      box.top,
      "the bubble fits inside the transformed pane, so this proves nothing",
    ).toBeGreaterThan(pane.bottom - 2);

    const hit = await page.evaluate(
      (point) => {
        const element = document.elementFromPoint(point.x, point.y);
        const body = document.querySelector('[data-testid="explain-canvas-body"]');
        return body !== null && element !== null && body.contains(element);
      },
      { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
    );
    expect(hit, "the bubble is not painted at its own centre").toBe(true);
  });

  test("scrolling the panel underneath it keeps the bubble on its glyph", async ({
    page,
  }) => {
    await openBench(page);
    await scrollTriggerToBottom(page);

    const trigger = page.getByTestId("explain-clipped");
    const bubble = page.getByTestId("explain-clipped-body");
    await trigger.click();
    await expectShowing(bubble, CLIPPED_TEXT);

    const before = await boxOf(bubble);
    const triggerBefore = await boxOf(trigger);

    /*
     * A SCROLL EVENT ON AN INNER ELEMENT DOES NOT BUBBLE TO `window`; it only
     * passes through in the capture phase. A non-capturing listener therefore
     * hears the page scroll and never the panel's, and the bubble is left
     * hanging over unrelated content — which is precisely the case every adopted
     * call site is in.
     *
     * MUTATION APPLIED: registered the scroll listener without the capture flag.
     * The bubble did not move — `moved` came back 0 against a trigger that had
     * moved 40 — and this went red. Reverted.
     */
    await page
      .getByTestId("probe-scroller")
      .evaluate((element) => (element.scrollTop -= 40));
    await expect
      .poll(async () => Math.round((await boxOf(bubble)).top))
      .not.toBe(Math.round(before.top));

    const after = await boxOf(bubble);
    const triggerAfter = await boxOf(trigger);
    expect(
      Math.round(after.top - before.top),
      "the bubble did not travel with the glyph it belongs to",
    ).toBe(Math.round(triggerAfter.top - triggerBefore.top));
  });

  test("against the bottom of the viewport it flips above the glyph", async ({
    page,
  }) => {
    await openBench(page);

    const trigger = page.getByTestId("explain-bottom");
    const bubble = page.getByTestId("explain-bottom-body");
    await trigger.click();
    await expectShowing(bubble, "Send it before you resume, or that prompt is composed without it.");

    const box = await boxOf(bubble);
    const glyph = await boxOf(trigger);
    const viewport = page.viewportSize();

    /*
     * MUTATION APPLIED: deleted the flip branch in `place()`, leaving `y =
     * trigger.bottom + GAP` unconditionally. The bubble was placed past the
     * bottom of the viewport and both assertions went red. Reverted.
     */
    expect(box.bottom, "the bubble sits below the glyph at the bottom edge").toBeLessThanOrEqual(
      glyph.top,
    );
    expect(box.bottom).toBeLessThanOrEqual(viewport?.height ?? 720);
  });
});
