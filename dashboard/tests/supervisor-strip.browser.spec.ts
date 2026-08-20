/**
 * THE STRIP IN A REAL BROWSER — three visually distinct states, an honest
 * unreachable, and the canvas it did not break.
 *
 * WHY THE STATES ARE FED BY `page.route` AND NOT BY THE FIXTURE API. Four
 * scenarios that differ only in one field read far better next to each other
 * than scattered through `fixtures/api-server.ts`, and — the load-bearing half
 * — the UNREACHABLE case needs a connection that FAILS, which a fixture server
 * that is up by construction cannot produce. `route.abort()` can. Nothing in
 * `tests/fixtures/` is touched, so no sibling spec can be destabilised by this
 * file.
 *
 * WHAT `supervisor-strip.unit.spec.ts` ALREADY PROVES AND THIS FILE DOES NOT
 * REPEAT: every arm of the classifier, in both directions. A browser cannot
 * measure a classifier more precisely than a function call can. What only a
 * browser can measure is the three things below — that the states are
 * TELLABLE APART ON SCREEN, that the rejection trail is legible, and that the
 * 30px this strip costs did not push the canvas out of its viewport.
 */

import { expect, test, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";
import golden from "./fixtures/supervisor-wire.golden.json";

/**
 * NAMED ARTEFACTS FOR THE VISUAL CLAIMS, because a colour assertion is a
 * number and "it reads clearly" is not. These four are what a human looks at
 * to check the second half of the claim; the `expect`s above are what a
 * machine can check. Written next to the app's existing shots.
 */
const SHOT_DIR = "screenshots";
import type { SupervisorState } from "../src/lib/api-types";

/**
 * WIRE SHAPE, AND `Partial<SupervisorState>` IS WHAT ENFORCES IT.
 *
 * Corrected 2026-08-10: these bodies used to be built from a mirror that disagreed
 * with `ApiSupervisorState` in fifteen fields, so every test in this file painted a
 * green RUNNING bar over a body the server has never sent. The last test in the file
 * serves the GOLDEN — a body the server's own composer produced — through the same
 * client, which is the only fixture here that is evidence about the wire.
 */
const PROBE: SupervisorState["probe"] = {
  ticketsSeen: 0,
  runsSeen: 0,
  eventsSeen: 0,
  wired: true,
  armed: true,
  armNote: "the route distinguished its own three outputs",
  unsourced: ["attempts", "lastDefect", "lastRepair"],
};

function body(over: Partial<SupervisorState>): SupervisorState {
  return {
    desired: "running",
    changedAt: new Date(Date.now() - 3_600_000).toISOString(),
    changedBy: "owner",
    reason: "the owner pressed start",
    at: new Date().toISOString(),
    ticket: null,
    run: null,
    attempts: [],
    lastDefect: null,
    lastDefectId: null,
    lastRepair: null,
    lastPatchId: null,
    nextAction: "claim the oldest queued ticket",
    nextActionAt: null,
    queueDepth: 0,
    queuedRuns: 0,
    probe: PROBE,
    ...over,
  };
}

const TICKET = {
  ticketKey: "t-b79ff5e2a1b314e4",
  title: "a portfolio site",
  state: "running",
  attemptNo: 1,
  maxAttempts: 3,
} as const;

const RUNNING = (): SupervisorState =>
  body({
    ticket: TICKET,
    run: {
      runId: "run-2026-08-09T21-04-00-713Z-a913c871",
      phase: "build",
      status: "running",
      quietForMs: 42_000,
    },
    probe: { ...PROBE, ticketsSeen: 1, runsSeen: 1, eventsSeen: 412 },
  });

const IDLE = (): SupervisorState =>
  body({
    desired: "stopped",
    changedBy: "owner",
    reason: "the owner pressed stop and the drain finished",
    nextAction: "waiting for the owner to press start",
  });

/**
 * STUCK — AND IT IS THE WALL-CLOCK ARM, NOT THE a913c871 ARM.
 *
 * The trail comparator is the one that catches a913c871, and the route does not
 * report the trail yet (`SupervisorAttemptView`'s note), so the state a browser
 * can be shown today is the silent-too-long one: a run whose last non-telemetry
 * event is past the 40-minute ceiling. When `attempts` lands on the wire, this
 * fixture grows the three real rejection sets and the assertions below tighten
 * to name `dataExpectations[0].id`.
 */
const STUCK = (): SupervisorState =>
  body({
    ticket: { ...TICKET, attemptNo: 3 },
    run: {
      runId: "run-2026-08-09T21-04-00-713Z-a913c871",
      phase: "spec",
      status: "running",
      quietForMs: 55 * 60_000,
    },
    lastDefectId: "a1b2c3d4e5f60718",
    probe: { ...PROBE, ticketsSeen: 1, runsSeen: 1, eventsSeen: 1816 },
  });

/** The route is up and there is nothing behind it. A fifth, honest answer. */
const UNWIRED = (): SupervisorState =>
  body({
    probe: {
      ...PROBE,
      wired: false,
      armed: false,
      armNote: "no supervisor is constructed in this process",
    },
  });

async function serve(page: Page, state: SupervisorState | "abort"): Promise<void> {
  await page.route("**/api/supervisor", async (route) => {
    if (state === "abort") {
      await route.abort("connectionrefused");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  });
}

/** The badge's own painted colours, which is what "visually distinct" means. */
async function openDetail(page: Page): Promise<void> {
  const pane = page.locator('[data-testid="supervisor-detail"]');
  if (!(await pane.isVisible())) {
    await page.getByTestId("supervisor-detail-toggle").click();
  }
  await expect(pane).toBeVisible();
}

async function paint(page: Page): Promise<{
  liveness: string;
  headline: string;
  because: string;
  colour: string;
  background: string;
}> {
  const strip = page.locator('[data-testid="supervisor-strip"]');
  /*
   * `blocked` IS IN THIS REGEX AND WAS ADDED WITH THE STATE (2026-08-10). A
   * helper that waited for five of six states would time out on the sixth with
   * "expected /running|idle|…/ received blocked" — a failure that names the
   * regex rather than the feature, in every test that touches the new state.
   */
  await expect(strip).toHaveAttribute(
    "data-liveness",
    /running|idle|stuck|blocked|unreachable|malformed/,
  );
  /*
   * THE SENTENCE MOVED TO THE DETAIL PANE (owner's call, 2026-08-18: the row
   * carries headline and cells only). Reading it therefore means opening the
   * pane; the toggle is idempotent-checked so repeated paints do not close it.
   */
  await openDetail(page);
  return strip.evaluate((node) => {
    const badge = node.querySelector('[data-testid="supervisor-liveness"] span');
    const because = node.querySelector('[data-testid="supervisor-because"]');
    const style = getComputedStyle(badge as Element);
    return {
      liveness: node.getAttribute("data-liveness") ?? "",
      headline:
        node.querySelector('[data-testid="supervisor-liveness"]')?.textContent?.trim() ?? "",
      because: because?.textContent?.trim() ?? "",
      colour: style.color,
      background: style.backgroundColor,
    };
  });
}

test.describe("the three states, and the fourth that is not one of them", () => {
  test("running, idle and stuck paint differently — text AND colour", async ({ page }) => {
    /*
     * DESIGN §7.6.2's arm check on the surface: "the panel renders three
     * visually distinct states … a test asserts all three differ". A status
     * panel whose failure mode is showing nothing is this repository's
     * signature defect, and three states that render the same grey bar is that
     * defect with more markup.
     */
    const strip = page.locator('[data-testid="supervisor-strip"]');

    await serve(page, RUNNING());
    await page.goto("/");
    const running = await paint(page);
    await strip.screenshot({ path: `${SHOT_DIR}/supervisor-strip-running.png` });

    await page.unroute("**/api/supervisor");
    await serve(page, IDLE());
    await page.goto("/");
    const idle = await paint(page);
    await strip.screenshot({ path: `${SHOT_DIR}/supervisor-strip-idle.png` });

    await page.unroute("**/api/supervisor");
    await serve(page, STUCK());
    await page.goto("/");
    const stuck = await paint(page);
    await strip.screenshot({ path: `${SHOT_DIR}/supervisor-strip-stuck.png` });

    expect(running.liveness).toBe("running");
    expect(idle.liveness).toBe("idle");
    expect(stuck.liveness).toBe("stuck");

    const colours = new Set([running.colour, idle.colour, stuck.colour]);
    expect(colours.size, `three states painted ${String(colours.size)} colour(s)`).toBe(3);

    const backgrounds = new Set([running.background, idle.background, stuck.background]);
    expect(backgrounds.size).toBe(3);

    const sentences = new Set([running.because, idle.because, stuck.because]);
    expect(sentences.size, "three states, fewer than three sentences").toBe(3);
    for (const sentence of sentences) expect(sentence).not.toBe("");

    // The stuck one names the field that came back, on the strip itself, with
    // no click required. That is the five-second read.
    expect(stuck.because).toContain("past the 40m ceiling");
    expect(stuck.headline.toLowerCase()).toContain("silent too long");
  });

  test("a dead endpoint says so instead of freezing the last good reading", async ({ page }) => {
    /*
     * The order matters: a GOOD read first, so SWR's `keepPreviousData` is
     * holding a healthy body, and only then the failure. A strip that renders
     * `data` without consulting `error` shows a confident green bar over a dead
     * backend, forever, and that is the eight-hour failure the owner is paying
     * for.
     */
    let alive = true;
    await page.route("**/api/supervisor", async (route) => {
      if (!alive) {
        await route.abort("connectionrefused");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(RUNNING()),
      });
    });

    await page.goto("/");
    expect((await paint(page)).liveness).toBe("running");

    alive = false;
    const strip = page.locator('[data-testid="supervisor-strip"]');
    await expect(strip).toHaveAttribute("data-liveness", "unreachable");
    await expect(strip).toHaveAttribute("data-stale", "true");
    await openDetail(page);
    await expect(page.locator('[data-testid="supervisor-because"]')).toContainText(
      "history, not state",
    );

    await strip.screenshot({ path: `${SHOT_DIR}/supervisor-strip-unreachable.png` });

    // And the unreachable paint is not the same as any of the three above.
    const dead = await paint(page);
    expect(dead.colour).not.toBe("");
    expect(dead.headline.toLowerCase()).toContain("unreachable");
  });

  test("the arm check runs at mount and reports itself armed", async ({ page }) => {
    const lines: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("ARM CHECK")) lines.push(message.text());
    });

    await serve(page, RUNNING());
    await page.goto("/");
    await expect(page.locator('[data-testid="supervisor-strip"]')).toHaveAttribute(
      "data-armed",
      "true",
    );

    /*
     * POLLED, NOT READ ONCE, AND THE FLAKE WAS MEASURED BEFORE IT WAS FIXED
     * (2026-08-10). `data-armed` is an attribute of the rendered tree and lands
     * with the commit; the arm LINE arrives over CDP as a `console` event, on a
     * different channel with its own latency. A synchronous read of `lines`
     * immediately after an attribute assertion therefore races the transport:
     * `--repeat-each=4` on this one test gave 2 passed / 2 failed, both failures
     * "the arm check printed nothing at mount", with no source change between
     * them. Nothing about the product was wrong — the effect fires at mount and
     * `console.info` is called — so the assertion is SYNCHRONISED rather than
     * weakened: it still requires a line, and every content check below is
     * unchanged.
     *
     * IT IS SELECTED BY CONTENT, NOT BY `lines[0]`, AND THAT TOO WAS MEASURED
     * (2026-08-10, on this run). `RenderGuard` mounted around the strip prints an
     * ARM CHECK line of its own, so index 0 is whichever of two components'
     * mount effects reached the CDP channel first — this test failed on the
     * guard's line, which says nothing about `distinct`, while both arms were
     * armed. Two always-on arm checks is the correct number; assuming there is
     * one is what broke.
     */
    await expect
      .poll(() => lines.filter((line) => line.includes("supervisor strip")).length, {
        message: "the strip's arm check printed nothing at mount",
      })
      .toBeGreaterThan(0);
    const armLine = lines.find((line) => line.includes("supervisor strip")) ?? "";
    /*
     * THE COUNT IS DERIVED FROM THE LINE, NOT PINNED TO A LITERAL — corrected
     * 2026-08-10 after this assertion pinned "5 distinct" and the product grew a
     * sixth state (`blocked`) in the same round, so the spec went red over a
     * legitimate widening. Pinning the number tests the number; binding it to the
     * enumerated states tests the thing that matters — that every state the arm
     * NAMES is a state it actually distinguished. A probe that lists six and
     * distinguishes four is the defect this strip exists to avoid, one layer up,
     * and only this form can see it.
     */
    const enumerated = /resolves \d+ known inputs to ([^(]+)\((\d+) distinct\)/.exec(armLine);
    expect(enumerated, `the arm line did not state its states and its count: ${armLine}`).not.toBeNull();
    const states = (enumerated?.[1] ?? "").split("·").map((s) => s.trim()).filter(Boolean);
    expect(states.length).toBeGreaterThanOrEqual(5);
    expect(Number(enumerated?.[2])).toBe(states.length);
    expect(armLine).toContain("escalates a913c871 at attempt 2");
    expect(armLine).not.toContain("FAILED");

    // No alarm banner when armed — the loud one is reserved for blindness.
    await expect(page.locator('[data-testid="supervisor-arm-alarm"]')).toHaveCount(0);
  });
});

test("an unwired route is not rendered as a considered decision", async ({ page }) => {
  /*
   * `wired: false` means every field the route sent is a DEFAULT, including
   * `desired: "stopped"`. Painting that as a stopped supervisor would report a
   * decision nobody made — the same class of error as rendering a kept
   * snapshot as live.
   */
  await serve(page, UNWIRED());
  await page.goto("/");
  const strip = page.locator('[data-testid="supervisor-strip"]');
  await expect(strip).toHaveAttribute("data-liveness", "unreachable");
  await openDetail(page);
  await expect(page.locator('[data-testid="supervisor-because"]')).toContainText(
    "no supervisor is constructed in this process",
  );
});

test("the missing authoring trail is SAID, not rendered as an empty box", async ({ page }) => {
  /*
   * THE HANDOFF, ASSERTED. The route carries `lastDefectSignature` and no
   * per-attempt history, so the comparison that catches a non-converging loop
   * has no live data. An empty list would read as a run that converged — the
   * exact reading that cost 87 minutes — so the panel says why it is empty and
   * prints the comparator's own arm line beside it.
   */
  await serve(page, STUCK());
  await page.goto("/");
  /*
   * BY TEST ID, NOT BY ACCESSIBLE NAME. Playwright matches `name` as a
   * SUBSTRING by default, and the run route's rail carries a button called
   * "run detail" (`rail.browser.spec.ts:524`). `name: "detail"` therefore
   * resolves two elements there and dies on strict mode — a failure that would
   * have looked like this strip breaking the rail.
   */
  await openDetail(page);

  const detail = page.locator('[data-testid="supervisor-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-testid="supervisor-attempts-absent"]')).toContainText(
    "does not report the authoring trail yet",
  );
  await expect(detail.locator('[data-testid="supervisor-attempts"]')).toHaveCount(0);

  // And the comparator is nevertheless armed, which is the difference between
  // "not wired yet" and "quietly broken".
  await expect(detail.locator('[data-testid="supervisor-arm-line"]')).toContainText(
    "escalates a913c871 at attempt 2",
  );
});

test.describe("at 2000px — the strip cost the canvas 30px and nothing else", () => {
  test.use({ viewport: { width: 2000, height: 1200 } });

  test("the run view still fits its viewport with the strip mounted", async ({ page }) => {
    /*
     * DO NOT REGRESS WHAT SHIPPED TODAY. `run-layout.browser.spec.ts` owns
     * these invariants; this is the same measurement taken with the new header
     * row in place, so a regression is attributed to THIS change rather than
     * discovered later in a file that predates it.
     *
     * The 30px is paid by flex, not by arithmetic: the shell is `h-dvh
     * overflow-hidden` and `main` is `flex-1 min-h-0`, so a taller header
     * leaves the canvas shorter and nothing overflows. If that ever stops being
     * true the failure is a scrollbar, and the scrollbar is asserted.
     */
    await serve(page, RUNNING());
    await page.goto(`/runs/${RUN_ID}`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page.locator("path.conduit-core").first()).toBeAttached();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "",
        ),
      )
      .not.toBe("");

    const frame = await page.evaluate(() => {
      const main = document.querySelector("main");
      const flow = document.querySelector(".react-flow");
      const pane = document.querySelector<HTMLElement>(".react-flow__viewport");
      const strip = document.querySelector('[data-testid="supervisor-strip"]');
      if (main === null || flow === null || pane === null || strip === null) {
        throw new Error("the run view did not render its shell, or the strip is not mounted");
      }
      const de = document.documentElement;
      const nodes = [...document.querySelectorAll(".react-flow__node")];
      const flowBox = flow.getBoundingClientRect();
      return {
        stripHeight: Math.round(strip.getBoundingClientRect().height),
        mainBottom: Math.round(main.getBoundingClientRect().bottom),
        flowBottom: Math.round(flowBox.bottom),
        flowTop: Math.round(flowBox.top),
        windowHeight: window.innerHeight,
        scale: Number(/scale\(([\d.]+)\)/.exec(pane.style.transform)?.[1] ?? 0),
        nodeCount: nodes.length,
        clipped: nodes.filter((node) => {
          const box = node.getBoundingClientRect();
          return box.right > flowBox.right + 1 || box.left < flowBox.left - 1;
        }).length,
        vScrollbar: de.scrollHeight > de.clientHeight,
        hScrollbar: de.scrollWidth > de.clientWidth,
      };
    });

    expect(frame.nodeCount, "no nodes were drawn, so nothing was measured").toBeGreaterThan(0);
    expect(frame.stripHeight, "the strip is not on the run route at all").toBeGreaterThan(0);
    expect(frame.stripHeight, "the strip grew past the one row it was budgeted").toBeLessThanOrEqual(
      36,
    );
    expect(frame.vScrollbar, "the run view acquired a vertical scrollbar").toBe(false);
    expect(frame.hScrollbar, "the run view acquired a horizontal scrollbar").toBe(false);
    expect(frame.clipped, "cards extend past the pane and are cut off").toBe(0);
    expect(
      frame.windowHeight - frame.mainBottom,
      "`main` runs past the bottom of the window — its last row is unreachable",
    ).toBeLessThanOrEqual(1);
    expect(
      frame.mainBottom - frame.flowBottom,
      "the canvas stops short of the bottom of the space it was given",
    ).toBeLessThanOrEqual(1);
    // `run-layout.browser.spec.ts`'s own number, re-asserted here: losing 30px
    // of height must not push the fit back to a ~1440px scale.
    expect(frame.scale, "the graph refitted smaller than the pane it was given").toBeGreaterThan(
      0.7,
    );
  });

  test("the detail pane opens OVER the canvas, not above it", async ({ page }) => {
    // An in-flow expansion would move the graph under the owner's cursor every
    // time he asked why. `absolute` is the fix and this is its assertion.
    await serve(page, STUCK());
    await page.goto(`/runs/${RUN_ID}`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();

    const before = await page
      .locator(".react-flow")
      .evaluate((node) => Math.round(node.getBoundingClientRect().top));
    /*
   * BY TEST ID, NOT BY ACCESSIBLE NAME. Playwright matches `name` as a
   * SUBSTRING by default, and the run route's rail carries a button called
   * "run detail" (`rail.browser.spec.ts:524`). `name: "detail"` therefore
   * resolves two elements there and dies on strict mode — a failure that would
   * have looked like this strip breaking the rail.
   */
  await openDetail(page);
    await expect(page.locator('[data-testid="supervisor-detail"]')).toBeVisible();
    const after = await page
      .locator(".react-flow")
      .evaluate((node) => Math.round(node.getBoundingClientRect().top));

    expect(after, "opening the detail pane moved the canvas").toBe(before);
  });
});

/**
 * THE PAGE STILL RENDERS WHEN `/api/supervisor` ANSWERS 200 WITH SOMETHING ELSE —
 * AND THIS IS THE TEST THAT DID NOT EXIST WHEN IT MATTERED.
 *
 * WHAT HAPPENED, MEASURED. Ten of this suite's browser spec files install a
 * catch-all `page.route("**\/api/**")` that fulfils every unmatched path with
 * their own body — `design-lock.browser.spec.ts:436` answers with a run-detail
 * JSON. `/api/supervisor` is unmatched, so it got a 200 with no `probe`. The
 * strip's `const wired = snapshot !== null && snapshot.probe.wired` threw
 * `Cannot read properties of undefined (reading 'wired')` out of
 * `SupervisorStrip` -> `AppShell` -> `RootLayout`, and A THROWING RootLayout
 * RENDERS NOTHING: no strip, no nav, no canvas, no error text. 80 failed / 186
 * passed across 11 files, 77 with that one line, against a baseline of 259
 * passed.
 *
 * WHY IT IS HERE AND NOT IN THE UNIT SPEC. `supervisor-strip.unit.spec.ts` proves
 * the classifier hands out no snapshot for such a body — a function-call fact. It
 * CANNOT prove that the app still paints, because the failure was a React render
 * throw two components above it, and the thing an owner lost was every other
 * panel on the page. That is a browser fact and nothing smaller can hold it.
 *
 * ONLY `/api/supervisor` IS STUBBED, AND THAT IS A CORRECTION MADE ON EVIDENCE.
 * The first version of this test installed the same broad `**\/api/**` catch-all
 * the ten files use, and it went red for the WRONG REASON: with every endpoint
 * answering a run-detail body, `/api/models` returns an object where the page
 * maps an array, so the PAGE threw and took the shell with it — the strip's own
 * element was gone and the assertion below could not tell that apart from the
 * defect under test. The catch-all was only the DELIVERY mechanism; the defect is
 * a 200 on this one path whose body is not a `SupervisorState`, and that is what
 * is reproduced. Everything else reaches the real fixture API.
 */
test("a 200 on /api/supervisor whose body is a run detail leaves the page rendered", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Byte-for-byte the shape `design-lock.browser.spec.ts:436` answers with.
  const RUN_DETAIL = {
    run: { runId: RUN_ID, status: "running" },
    events: [],
    messages: [],
    designLock: null,
  };

  await page.route("**/api/supervisor", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(RUN_DETAIL),
    });
  });

  await page.goto("/");

  /*
   * THE ROOT LAYOUT RENDERED. These three are what a blank page does not have:
   * the shell's nav, its main region, and the strip itself. Asserting only the
   * strip's own sentence would pass on a page that lost everything else, which
   * is precisely the failure — so the nav is checked first.
   */
  await expect(page.getByRole("link", { name: "Runs" })).toBeVisible();
  await expect(page.locator("main")).toBeAttached();

  const strip = page.locator('[data-testid="supervisor-strip"]');
  /*
   * `malformed`, NOT `unreachable` — RENAMED 2026-08-10 AND THE RENAME IS THE
   * FIX. "The route did not answer" and "the route answered with something else"
   * need two different moves from the owner: the first may come back on its own,
   * the second will not until he changes what is serving that path. Folding them
   * into one word left the only actionable half in a sentence the 30px row
   * truncates.
   */
  await expect(strip).toHaveAttribute("data-liveness", "malformed");
  await openDetail(page);
  await expect(page.locator('[data-testid="supervisor-because"]')).toContainText(
    "a body this page cannot read",
  );
  // The sentence NAMES the field, because "the wrong shape" at 3am is a dead end.
  await openDetail(page);
  await expect(page.locator('[data-testid="supervisor-because"]')).toContainText("probe is absent");

  /*
   * AND NOTHING THREW. `pageerror` is the exact channel that carried the 77
   * failures; a React render throw in a client component reaches it. Asserting
   * the DOM alone would not distinguish "nothing threw" from "it threw and
   * something recovered", and the message is included in the failure so a
   * regression names its own line.
   */
  expect(errors, `the page threw: ${errors.join(" | ")}`).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* THE WALK — SEVEN BODIES A 200 MAY CARRY, NONE OF THEM A READING     */
/* ------------------------------------------------------------------ */

/**
 * ONE BODY IS NOT A TEST OF THIS, AND THAT IS THE LESSON THE 77 FAILURES TAUGHT
 * TWICE.
 *
 * The test above pins the ONE body that was measured — `design-lock`'s run
 * detail, which is missing `probe`. It proves that body is survivable and says
 * nothing about the next one. The defect was never "the run-detail shape": it
 * was a component dereferencing fields on a body nothing had validated, so the
 * assertion has to be over a SET of bodies, chosen so that each reaches a
 * DIFFERENT dereference in the strip:
 *
 *   `{}`                     no `probe`, no `lastRepair`, no `desired`
 *   `null`                   a 200 that parses to nothing at all
 *   a state minus `probe`    every other field right, one absent
 *   `<!doctype html>`        a 200 that is not JSON — a dev server or a proxy
 *   `lastDefectId`           a STRING field carrying an object: reaches
 *     as an object            `shortSignature()`, which calls `.slice` on it
 *   `lastDefect.signature`   a nested string field carrying an object
 *   `ticket.ticketKey`       a nested string field carrying an object: reaches
 *     as an object            JSX as a child, which React refuses to render
 *
 * THE LAST THREE WERE FOUND BY READING THE COMPONENT, NOT BY WATCHING IT FAIL, and
 * they went red on the tree that had already been declared fixed: the shape arm
 * checked `probe`, `ticket`, `lastRepair`, `desired` and `queuedTickets` — the
 * fields the ARMS read plus the two the detail pane reads — and the strip's
 * always-visible row still reads `lastDefectSignature` and `ticket.ticketKey`.
 * An arm that guards five of nineteen fields guards nothing the day a body
 * arrives wrong in the other fourteen, which is why the validator this file
 * drove is over EVERY field the contract declares rather than over the ones a
 * crash has already been observed on.
 */
const NOT_A_READING: readonly {
  readonly name: string;
  readonly raw: string;
  readonly contentType: string;
  /** A phrase the strip's own sentence must carry. Never "" — see the loop. */
  readonly says: string;
}[] = [
  {
    name: "an empty object",
    raw: "{}",
    contentType: "application/json",
    says: "probe is absent",
  },
  {
    name: "literal null",
    raw: "null",
    contentType: "application/json",
    /*
     * `request()` in `lib/api.ts` parses a 200's text and hands back `null` both
     * for a body that IS `null` and for one that does not parse, so the strip
     * cannot tell those two apart today and does not pretend to: it says it has
     * never had a reading, which is true of the strip, and it does not throw.
     * FILED AS A HANDOFF rather than papered over — the fix is a fetcher that
     * keeps the raw body, and it is not worth destabilising every other panel's
     * error path for a sentence.
     */
    says: "has never had a reading",
  },
  {
    name: "a state with `probe` absent",
    raw: JSON.stringify(
      ((): Record<string, unknown> => {
        const withoutProbe = { ...RUNNING() } as Record<string, unknown>;
        delete withoutProbe["probe"];
        return withoutProbe;
      })(),
    ),
    contentType: "application/json",
    says: "probe is absent",
  },
  {
    name: "a 200 that is not JSON at all",
    raw: "<!doctype html><title>a dev server, not this API</title>",
    contentType: "text/html",
    says: "has never had a reading",
  },
  /*
   * A STRING FIELD CARRYING AN OBJECT, ON THE FIELD THE STRIP ACTUALLY `.slice`s
   * TODAY. This entry used to name `lastDefectSignature`, which was a mirror
   * invention: the wire sends `lastDefect` (an object or null) and `lastDefectId` (a
   * string or null), and it is the ID the defect cell shortens. Renamed with the
   * mirror on 2026-08-10 — pointing this case at a field nothing reads would have
   * left the crash class untested while looking identical in the report.
   */
  {
    name: "`lastDefectId` carrying an object",
    raw: JSON.stringify({ ...RUNNING(), lastDefectId: { signature: "a1b2c3d4e5f60718" } }),
    contentType: "application/json",
    says: "lastDefectId is an object",
  },
  {
    name: "`lastDefect.signature` carrying an object",
    raw: JSON.stringify({
      ...RUNNING(),
      lastDefect: {
        signature: { was: "a string" },
        failureClass: "spec_manifest_rejected",
        bakeoffCode: null,
        at: "2026-08-10T00:20:00.000Z",
        repairable: true,
      },
    }),
    contentType: "application/json",
    says: "lastDefect.signature is an object",
  },
  {
    name: "`ticket.ticketKey` carrying an object",
    raw: JSON.stringify({
      ...RUNNING(),
      ticket: { ...TICKET, ticketKey: { key: "t-b79ff5e2a1b314e4" } },
    }),
    contentType: "application/json",
    says: "ticket.ticketKey is an object",
  },
  /*
   * ───────────────────────────────────────────────────────────────────────────
   * THE BODY THE SHIPPED SERVER ACTUALLY SENDS USED TO BE THE SEVENTH ENTRY IN
   * THIS LIST, AND IT HAS LEFT — WHICH IS THE ROUND'S RESULT, NOT A DELETION.
   *
   * It sat here asserted as `malformed` with `says: "lastRepair is null"`, under a
   * docblock that recorded the measurement (seven mirror fields not on the wire,
   * eight wire fields not in the mirror, `lastRepair` null on a healthy run) and
   * ended: "THE DAY SOMEBODY ALIGNS THE TWO, THIS CASE FLIPS — the strip will read
   * it as `running` and this entry has to move to the fixtures above. That is the
   * intended way for it to fail."
   *
   * The mirror was aligned on 2026-08-10 and the case flipped. It now lives in
   * "the body the SERVER's own composer produces reads RUNNING in a real browser"
   * below, driven by `fixtures/supervisor-wire.golden.json` rather than by a body
   * pasted into this file — a paste ages silently, and that is the whole reason the
   * strip spent a day amber.
   */
];

test("seven bodies that are not a reading: each renders a state, and NONE of them throws", async ({
  page,
}) => {
  for (const shape of NOT_A_READING) {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.unroute("**/api/supervisor");
    await page.route("**/api/supervisor", async (route) => {
      await route.fulfill({ status: 200, contentType: shape.contentType, body: shape.raw });
    });
    await page.goto("/");

    /*
     * THE SHELL FIRST, AND IN THIS ORDER. A blank page has no nav and no `main`;
     * a page that kept the shell and lost the strip is a DIFFERENT failure, and
     * one that kept all three but painted nothing is a third. Asserting the
     * strip's sentence alone would pass on the first two.
     */
    /*
     * `exact: true` BECAUSE THE HOME PAGE HAS AN "all runs" LINK TO THE SAME
     * HREF and Playwright matches `name` as a substring, which resolves two
     * elements and dies on strict mode — a failure that reads exactly like the
     * blank page under test. The second link only appears once the runs list
     * has loaded, so the loose locator is a race as well as a bug.
     */
    await expect(
      page.getByRole("link", { name: "Runs", exact: true }),
      `${shape.name}: the nav is gone, so the layout threw`,
    ).toBeVisible();
    await expect(page.locator("main"), `${shape.name}: there is no main region`).toBeAttached();

    const strip = page.locator('[data-testid="supervisor-strip"]');
    await expect(strip, `${shape.name}: the strip did not render`).toBeVisible();

    /*
     * A LEGIBLE STATE, WHICH MEANS A NAME FROM THE KNOWN SET AND NOT A BLANK.
     * `malformed` is one of them and is its own word: "the route answered with a
     * body that is not a reading" and "the route did not answer" are two
     * different things for the owner to do at 3am.
     */
    await expect(strip).toHaveAttribute(
      "data-liveness",
      /^(idle|running|stuck|blocked|unreachable|malformed)$/,
    );
    await expect(strip).toHaveAttribute("data-stale", /^(true|false)$/);

    await openDetail(page);
    const because = page.locator('[data-testid="supervisor-because"]');
    await expect(because, `${shape.name}: the strip said nothing`).not.toHaveText("");
    await expect(because, `${shape.name}: the sentence does not name what is wrong`).toContainText(
      shape.says,
    );

    // The headline is never blank either — a badge with no word in it is the
    // "shows nothing on failure" defect wearing a colour.
    await expect(page.locator('[data-testid="supervisor-liveness"]')).not.toHaveText("");

    expect(errors, `${shape.name} threw: ${errors.join(" | ")}`).toEqual([]);
    page.removeAllListeners("pageerror");
  }
});

/* ------------------------------------------------------------------ */
/* THE BODY THE SERVER ACTUALLY SENDS, IN A REAL BROWSER               */
/* ------------------------------------------------------------------ */

/**
 * THE ONE FIXTURE IN THIS FILE THAT IS EVIDENCE ABOUT THE WIRE.
 *
 * Every other body here is built from `body()`, i.e. from the CLIENT's own
 * `SupervisorState`. That is exactly how this strip came to be blind: on 2026-08-10
 * the mirror disagreed with `ApiSupervisorState` in fifteen fields, so this suite
 * was green, the unit suite was green and all three typecheckers were clean, while
 * against a real server the strip read amber `MALFORMED` on `/`, `/runs`,
 * `/projects` and a run page, naming eight absent fields. Amber for a healthy loop
 * and amber for a wedged one is not an instrument.
 *
 * `fixtures/supervisor-wire.golden.json` was GENERATED by running the server's own
 * `composeSupervisorState` (`fixtures/supervisor-wire.golden.mjs`), and
 * `server/src/supervisor-route.test.ts` deep-equals the composer against it, so it
 * cannot rot into a paste. What only a BROWSER can add is that these bodies reach
 * the owner as three different readable screens through the real component tree —
 * `RootLayout` -> `AppShell` -> `SupervisorStrip` — with the real data cells
 * rendered from the real fields.
 *
 * THREE BODIES, THREE STATES, THREE COLOURS. One body asserted "not malformed"
 * would pass against a strip that painted everything green.
 */
test("the body the SERVER's own composer produces reads RUNNING in a real browser", async ({
  page,
}) => {
  const wire = golden as unknown as Record<string, SupervisorState>;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const paints: { readonly name: string; readonly liveness: string; readonly colour: string }[] = [];

  for (const [name, expected] of [
    ["idle", "idle"],
    ["claimed", "running"],
    ["notWired", "unreachable"],
  ] as const) {
    await page.unroute("**/api/supervisor");
    /*
     * `at` AND THE POLL CLOCK: the golden's timestamps are fixed strings from the
     * generator, and NOTHING here ages against them — `classifySupervisor` measures
     * freshness from when THIS CLIENT received the body, so a 2026-08-10 stamp in the
     * payload does not make the reading stale. That is the documented limit of the
     * stale arm, and this test is where it is visible: a route that answers instantly
     * with an old computation reads as live.
     */
    await serve(page, wire[name] as SupervisorState);
    await page.goto("/");

    // THE SHELL FIRST. A blank page has no nav; asserting the strip alone would pass
    // on the failure this whole file exists for.
    await expect(page.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
    const painted = await paint(page);
    expect(painted.liveness, `the composer's '${name}' body: ${painted.because}`).toBe(expected);
    paints.push({ name, liveness: painted.liveness, colour: painted.colour });

    const strip = page.locator('[data-testid="supervisor-strip"]');
    await strip.screenshot({ path: `${SHOT_DIR}/supervisor-strip-wire-${name}.png` });

    if (name === "claimed") {
      /*
       * THE DATA CELLS, FROM THE WIRE'S OWN FIELDS. The ticket key comes from
       * `ticket.ticketKey`, the clock from `run.quietForMs` — the two the old mirror
       * got wrong in different ways (an invented `ticket.currentRunId` beside it, and
       * a `quietForSeconds` that has never existed). A green badge over empty cells
       * would be the same blindness with a nicer colour.
       */
      await expect(strip).toContainText("t-b17e54c98f1a0617");
      await expect(strip).toContainText("42s");
      expect(painted.headline).toContain("spec");
      expect(painted.headline).toContain("attempt 1 of 3");

      /*
       * AND THE DETAIL PANE READS THE FIELDS NO ARM TOUCHES. `lastRepair` is
       * `null` on the wire and the sentence about it is composed on this side, so
       * this is where a mirror that expected a `summary` field printed
       * `undefined`. `probe.unsourced` is what makes the empty trail legible.
       */
      await openDetail(page);
      const detail = page.locator('[data-testid="supervisor-detail"]');
      await expect(detail).toContainText("no patch has been applied");
      await expect(detail).toContainText("composed 2026-08-10T03:00:00.000Z");
      await expect(page.locator('[data-testid="supervisor-attempts-absent"]')).toContainText(
        "does not report the authoring trail yet",
      );
    }

    expect(errors, `the composer's '${name}' body threw: ${errors.join(" | ")}`).toEqual([]);
  }

  // THREE DISTINCT WORDS AND THREE DISTINCT COLOURS, from three real composer
  // outputs. This is the assertion a constant-painting strip cannot pass.
  expect(new Set(paints.map((entry) => entry.liveness)).size).toBe(3);
  expect(new Set(paints.map((entry) => entry.colour)).size).toBe(3);
});

/**
 * a913c871 ON SCREEN — THE RENDERING PATH THIS PASS MADE LIVE, AND NOTHING HAD EVER
 * RENDERED.
 *
 * Until 2026-08-10 the component read a module constant, `ATTEMPTS_NOT_ON_THE_WIRE =
 * []`, so FOUR THINGS WERE DEAD CODE: the `<ol data-testid="supervisor-attempts">`
 * branch, `formatClock(attempt.at)`, the `key` prop, and the `recurring.includes(...)`
 * red highlight. Arm 7 — `"retrying, not improving"`, the ONLY arm that can catch
 * a913c871, where three attempts inside a budget of three killed a run over 87
 * minutes while the screen said WORKING — was likewise unreachable from any live
 * body. Reading `snapshot.attempts` made all of it reachable in one edit, and a newly
 * reachable rendering path with no probe is this repository's signature defect with a
 * new date on it.
 *
 * SO THIS SERVES THE RUN'S OWN THREE REJECTION SETS. `unsourced: []` is the switch:
 * it says the server DOES source the trail, which is what turns the honest blank off
 * and the list on. When a producer lands on the route, this is the body it will send
 * and this test already covers the screen.
 */
test("the run that died reads STUCK with the field that came back named on screen", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await serve(
    page,
    body({
      ticket: { ...TICKET, attemptNo: 3 },
      // A HEALTHY QUIET CLOCK, DELIBERATELY. a913c871 was never silent — it emitted
      // attempt boundaries the whole time — so if this test could pass via the
      // 40-minute ceiling it would not be testing arm 7 at all.
      run: {
        runId: "run-2026-08-09T21-04-00-713Z-a913c871",
        phase: "spec",
        status: "running",
        quietForMs: 15_000,
      },
      attempts: [
        { n: 1, at: "2026-08-09T21:31:52.000Z", problems: ["dataExpectations[0].id"] },
        { n: 2, at: "2026-08-09T22:07:19.000Z", problems: ["dataExpectations[0].kind"] },
        { n: 3, at: "2026-08-09T22:31:03.000Z", problems: ["dataExpectations[0].id"] },
      ],
      probe: { ...PROBE, ticketsSeen: 1, runsSeen: 1, eventsSeen: 1816, unsourced: [] },
    }),
  );
  await page.goto("/");

  const painted = await paint(page);
  expect(painted.liveness, `a non-converging loop painted ${painted.liveness}`).toBe("stuck");
  expect(painted.headline).toContain("retrying, not improving");
  // THE FIELD IS NAMED IN THE SENTENCE — which lives in the detail pane since
  // the owner cut prose from the row (2026-08-18); `paint()` opens the pane.
  expect(painted.because).toContain("dataExpectations[0].id");
  expect(painted.because).toContain("another attempt is spend, not progress");

  const strip = page.locator('[data-testid="supervisor-strip"]');
  await strip.screenshot({ path: `${SHOT_DIR}/supervisor-strip-oscillating.png` });

  await openDetail(page);

  /*
   * THE LIST, NOT THE HONEST BLANK. `unsourced: []` means the server sources the
   * trail, so the blank sentence must be gone and the three attempts must be on
   * screen — attempt 1's rejection BESIDE attempt 3's, which is the comparison
   * nothing in this app could show while the run was dying.
   */
  await expect(page.locator('[data-testid="supervisor-attempts-absent"]')).toHaveCount(0);
  const list = page.locator('[data-testid="supervisor-attempts"]');
  await expect(list).toBeVisible();
  /*
   * DIRECT CHILDREN, AND THE COUNT IS WHY: each attempt `<li>` holds a NESTED `<ul>`
   * of its problems, so a bare `li` locator resolves 6 here (3 attempts + 3
   * rejections) and would have passed for the wrong reason on a trail of six attempts
   * with no problems. Both numbers are asserted rather than one loose one.
   */
  await expect(list.locator("> li")).toHaveCount(3);
  await expect(list.locator("> li ul > li")).toHaveCount(3);
  await expect(list).toContainText("attempt 1");
  await expect(list).toContainText("attempt 3");
  // THE RECURRENCE IS MARKED, which is the whole point: `id` -> `kind` -> `id`.
  await expect(list).toContainText("rejected, fixed, rejected again");
  /*
   * SCOPED 2026-08-10. This read `[data-testid="supervisor-detail"] h3`, which matches
   * TWO headings — "ticket census — …" and "authoring attempts — …" — so Playwright
   * failed on strict mode rather than on the product. The assertion was right and the
   * locator was not: `AttemptProgress` genuinely includes `oscillating` and the
   * attempts heading renders it. Scoped by the heading's own words, so it still fails
   * if the product stops naming the comparison.
   */
  await expect(
    page.locator('[data-testid="supervisor-detail"] h3').filter({ hasText: "authoring attempts" }),
    "the heading does not name the comparison it just made",
  ).toContainText("oscillating");

  /*
   * AND THE SECOND BLANK SENTENCE, which is the other half of `unsourced`: a trail the
   * server DOES source and has no attempts for is an EMPTY list, not a missing one.
   * Two different facts, two different sentences; one sentence for both would say
   * "not recorded" over a converged run.
   */
  await page.unroute("**/api/supervisor");
  await serve(page, body({ ticket: TICKET, probe: { ...PROBE, unsourced: [] } }));
  await page.goto("/");
  await openDetail(page);
  await expect(page.locator('[data-testid="supervisor-attempts-absent"]')).toContainText(
    "an empty list, not a missing one",
  );

  expect(errors, `the page threw: ${errors.join(" | ")}`).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* THE FIVE STATES, AT THE WIDTH THIS APP IS ACTUALLY LOOKED AT        */
/* ------------------------------------------------------------------ */

/**
 * ONE SHOT PER STATE, AT 1440x900, BECAUSE A VISUAL CLAIM WITH NO VIEWED IMAGE
 * BEHIND IT IS NOT EVIDENCE IN THIS REPOSITORY.
 *
 * The describe above screenshots three states at the project's default viewport
 * (1280x720). 1440 is the width every other measurement in this suite is taken
 * at — `app-shell.tsx` caps content at `max-w-[1440px]` and the strip's own
 * docblock argues its one-line budget from that number — so the shots a human
 * actually reads are taken here.
 *
 * WHAT THE ASSERTIONS ARE FOR. Six states must produce six different WORDS and
 * six different SENTENCES; they produce FOUR colours, and the two collisions are
 * deliberate rather than oversights — `malformed` shares `unreachable`'s amber
 * because both mean "this page cannot see", and `blocked` shares `stuck`'s red
 * because both mean "act on the run". The count is asserted at exactly 4 so that
 * a later edit which quietly paints `malformed` red, or gives `blocked` an amber
 * of its own, reddens this test instead of shipping.
 *
 * ─── IT WAS "ALL FIVE STATES" UNTIL 2026-08-10, AND THE RENAME IS THE POINT ───
 *
 * `blocked` became an always-on liveness in the census pass. THIS TEST WOULD HAVE
 * STAYED GREEN FOR EVER: it enumerates its own five states, so a sixth is simply
 * never driven, and the title would have gone on saying "all five states" about a
 * strip with six. That is the same defect as an arm check whose probe count does
 * not move — a confident pass about something nothing looks at — and it is why the
 * unit suite asserts `report.probes` NAMES rather than only its length.
 */
test.describe("all six states, viewed at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("six words, six sentences, four colours — and both collisions are on purpose", async ({
    page,
  }) => {
    const strip = page.locator('[data-testid="supervisor-strip"]');
    const seen: { state: string; word: string; sentence: string; colour: string }[] = [];

    const shoot = async (state: string): Promise<void> => {
      const read = await paint(page);
      await strip.screenshot({ path: `${SHOT_DIR}/strip-1440-${state}.png` });
      seen.push({
        state: read.liveness,
        word: read.liveness,
        sentence: read.because,
        colour: read.colour,
      });
    };

    await serve(page, RUNNING());
    await page.goto("/");
    await shoot("running");

    await page.unroute("**/api/supervisor");
    await serve(page, IDLE());
    await page.goto("/");
    await shoot("idle");

    await page.unroute("**/api/supervisor");
    await serve(page, STUCK());
    await page.goto("/");
    await shoot("stuck");

    /*
     * UNREACHABLE NEEDS A CONNECTION THAT FAILS AND A GOOD READ BEFORE IT, so
     * that `keepPreviousData` is holding a healthy body when the failure lands —
     * the state the owner sees at 3am is this one, not a cold start.
     */
    await page.unroute("**/api/supervisor");
    let alive = true;
    await page.route("**/api/supervisor", async (route) => {
      if (!alive) {
        await route.abort("connectionrefused");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(RUNNING()),
      });
    });
    await page.goto("/");
    await expect(strip).toHaveAttribute("data-liveness", "running");
    alive = false;
    await expect(strip).toHaveAttribute("data-liveness", "unreachable");
    await shoot("unreachable");

    // MALFORMED — the shape the ten catch-all specs send, and the shape the
    // shipped server sends. Fresh, truthy, 200, and not a reading.
    await page.unroute("**/api/supervisor");
    await page.route("**/api/supervisor", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run: { runId: RUN_ID, status: "running" }, events: [] }),
      });
    });
    await page.goto("/");
    await expect(strip).toHaveAttribute("data-liveness", "malformed");
    await shoot("malformed");

    /*
     * BLOCKED — nothing claimed, nothing queued, and a census in which a ticket
     * ended `blocked`. This is the state the owner actually came back to, and it
     * is the one that used to be byte-identical to `idle`.
     */
    await page.unroute("**/api/supervisor");
    await serve(page, IDLE());
    await serveCensus(page, { tickets: DIED_ROWS });
    await page.goto("/");
    await expect(strip).toHaveAttribute("data-liveness", "blocked");
    await shoot("blocked");
    await page.unroute("**/api/supervisor/tickets");

    expect(
      seen.map((entry) => entry.state),
      "the six states did not resolve to the six names",
    ).toEqual(["running", "idle", "stuck", "unreachable", "malformed", "blocked"]);

    const words = new Set(seen.map((entry) => entry.word));
    expect(words.size, `six states, ${String(words.size)} word(s) on the badge`).toBe(6);

    const sentences = new Set(seen.map((entry) => entry.sentence));
    expect(sentences.size, `six states, ${String(sentences.size)} sentence(s)`).toBe(6);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);

    const colours = new Set(seen.map((entry) => entry.colour));
    expect(
      colours.size,
      `expected four colours across six states (malformed shares unreachable's amber, blocked shares stuck's red), read ${String(
        colours.size,
      )}: ${[...colours].join(", ")}`,
    ).toBe(4);
    // AND BOTH SHARED PAIRS ARE THE INTENDED PAIRS, not accidental collisions.
    expect(seen[4]?.colour, "malformed is not painted the same amber as unreachable").toBe(
      seen[3]?.colour,
    );
    expect(seen[4]?.colour, "malformed is painted the same red as stuck").not.toBe(seen[2]?.colour);
    /*
     * `blocked` IS RED, AND IT IS THE SAME RED AS `stuck` RATHER THAN A SIXTH
     * COLOUR. Both mean the owner must act on the run; they differ in when. The
     * assertion that it is NOT the amber is the load-bearing one — amber means
     * "this page cannot see", and here the page sees perfectly and what it sees is
     * that the work failed.
     */
    expect(seen[5]?.colour, "blocked is not painted the same red as stuck").toBe(seen[2]?.colour);
    expect(seen[5]?.colour, "blocked is painted amber, which means 'cannot see'").not.toBe(
      seen[3]?.colour,
    );

    // The malformed sentence must not blame the run: against the real backend
    // this is the state a HEALTHY supervisor produces today.
    expect(seen[4]?.sentence).toContain("the supervisor itself may be fine");
  });
});

/* ------------------------------------------------------------------ */
/* THE BOUNDARY — WHAT HAPPENS WHEN THE STRIP THROWS ANYWAY            */
/* ------------------------------------------------------------------ */

/**
 * A THROW NO VALIDATOR CAN SEE, AND THE PAGE SURVIVES IT.
 *
 * The shape validator's guarantee is about DATA: a body it clears cannot make a
 * consumer throw. It cannot promise anything about CODE — a field the contract
 * grows and nobody validates, a hook that throws after an upgrade, an `Intl`
 * option a future browser rejects. `RenderGuard` is the promise about code, and
 * this is the only kind of test that can prove it: a fault injected somewhere no
 * validator is looking.
 *
 * `Date.prototype.toLocaleString` IS THE INJECTION POINT AND IT IS NOT ARBITRARY.
 * `formatClock` is the only caller of that method in this app (`formatTokens` and
 * `formatInt` call `Number.prototype.toLocaleString`, a different function;
 * `formatTimeOnly` calls `toLocaleTimeString`; `formatRelative`, which is what
 * the home page uses, calls `toLocaleDateString`). So the patch reaches the
 * strip's detail pane — `formatClock(snapshot.since)` — and nothing else on `/`.
 * A `RangeError` out of `Intl` is a real class of fault, not a contrivance.
 *
 * WHAT IS ASSERTED AND WHAT IS NOT. The page keeps its nav, its `main` and a
 * legible row where the strip was. `pageerror` is NOT asserted empty: React
 * reports a CAUGHT error to `console.error` and Next's dev overlay listens to
 * it, so an empty-errors assertion here would be asserting the absence of the
 * boundary's own working. The DOM is the evidence — the blank page had no nav.
 */
test.describe("the render guard", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a throw inside the strip costs 30px of header, not the whole application", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = Date.prototype.toLocaleString;
      // Only the option set `formatClock` passes: month + second. Anything else
      // keeps working, so the injection cannot be mistaken for a broken page.
      Date.prototype.toLocaleString = function patched(
        this: Date,
        locales?: unknown,
        options?: Record<string, unknown>,
      ): string {
        if (options !== undefined && "month" in options && "second" in options) {
          throw new RangeError("this browser refused the date format the strip asked for");
        }
        return original.call(this, locales as string | undefined, options as never);
      } as typeof Date.prototype.toLocaleString;
    });

    await serve(page, RUNNING());
    await page.goto("/");

    // The row renders: nothing in it calls `formatClock`.
    await expect(page.locator('[data-testid="supervisor-strip"]')).toHaveAttribute(
      "data-liveness",
      "running",
    );
    // And the guard says it is armed before it has ever caught anything, which
    // is the half of an arm check that nobody ever writes.
    await expect(page.locator('[data-testid="render-guard"]')).toHaveAttribute("data-arm", "true");
    await expect(page.locator('[data-testid="render-guard-alarm"]')).toHaveCount(0);

    /*
     * This click is the fault injection. `openDetail` cannot be used here: its
     * success condition is a visible pane, while the success condition of this
     * test is the boundary replacing that pane before it can mount.
     */
    await page.getByTestId("supervisor-detail-toggle").click();

    /*
     * THE THREE THINGS A BLANK PAGE DOES NOT HAVE. The nav is asserted FIRST
     * because it is the one the 77 failures lost: a page that keeps the shell and
     * degrades one row is a different outcome from a page that renders nothing,
     * and only the nav can tell them apart.
     */
    await expect(page.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
    await expect(page.locator("main")).toBeAttached();

    const guard = page.locator('[data-testid="render-guard"]');
    await expect(guard).toHaveAttribute("data-guard", "failed");
    const line = page.locator('[data-testid="render-guard-line"]');
    await expect(line).toContainText("the supervisor strip stopped rendering");
    // IT PRINTS THE FAULT AND SAYS WHOSE IT IS NOT. A generic "something went
    // wrong" would be the signature defect with nicer markup.
    await expect(line).toContainText("refused the date format");
    await expect(line).toContainText("not in the run");

    // The fallback is the same one row the strip was budgeted: a failure in the
    // header must not resize the canvas the owner is watching.
    const height = await guard.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    expect(height, "the fallback row grew past the strip's budget").toBeLessThanOrEqual(36);

    await guard.screenshot({ path: `${SHOT_DIR}/strip-1440-guard-caught.png` });
  });

  test("the guard's own arm check runs at mount and prints, pass or fail", async ({ page }) => {
    const lines: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("ARM CHECK")) lines.push(message.text());
    });

    await serve(page, RUNNING());
    await page.goto("/");
    await expect(page.locator('[data-testid="render-guard"]')).toHaveAttribute("data-arm", "true");

    await expect
      .poll(() => lines.filter((line) => line.includes("render guard")).length, {
        message: "the render guard's arm check printed nothing at mount",
      })
      .toBeGreaterThan(0);
    const armLine = lines.find((line) => line.includes("render guard")) ?? "";
    expect(armLine).toContain("routes a throw to a failed state");
    expect(armLine).not.toContain("FAILED");
  });
});

/* ------------------------------------------------------------------ */
/* THE MORNING READOUT IN A BROWSER — "IT FINISHED" vs "IT ALL DIED"   */
/* ------------------------------------------------------------------ */

/**
 * ⚠ NOT EXECUTED WHEN IT WAS WRITTEN (2026-08-10), AND SAYING SO IS PART OF THE
 * TEST.
 *
 * A real Agent-SDK run was live on this machine and `playwright.config.ts`
 * declares `webServer` at the TOP LEVEL, so every project run boots a `next dev`
 * beside it. The pure-logic half of this feature was executed and mutation-proved
 * (`supervisor-strip.unit.spec.ts`, sixteen mutations, every one red); everything
 * below is unrun. It is written now rather than later because the specs are what
 * make the next run of this suite meaningful, and a lane that ships components
 * without them ships a claim nobody can check — but nobody may report these as
 * green until they have been run.
 *
 * WHAT ONLY A BROWSER CAN MEASURE HERE, i.e. why these are not more unit tests.
 * The unit suite proves the CLASSIFIER tells a finished queue from an all-blocked
 * one. It cannot prove that the strip PAINTS them differently, that the census
 * survives a route that 404s on every tick, or that the blocked ticket's own
 * `next_action` is actually reachable on screen rather than merely present in a
 * reading nobody renders. Those three are the failures that would leave the owner
 * with the same useless row he had before.
 */

/** The census route, fed the same way `/api/supervisor` is. */
async function serveCensus(
  page: Page,
  census: unknown | "abort" | "notfound",
): Promise<void> {
  /*
   * THE PATTERN ENDS AT `tickets` AND THE STATE ROUTE'S ENDS AT `supervisor`, so
   * the two globs do not overlap: `**\/api/supervisor` requires the URL to END
   * there. Registered as its own route so a test can vary one and hold the other.
   */
  await page.route("**/api/supervisor/tickets", async (route) => {
    if (census === "abort") {
      await route.abort("connectionrefused");
      return;
    }
    if (census === "notfound") {
      /* TODAY'S REAL ANSWER: the GET has no producer, so the route 404s. */
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "no route for GET /api/supervisor/tickets" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(census),
    });
  });
}

const DONE_ROWS = [
  { ticketKey: "t-1", state: "done", updatedAt: "2026-08-10T05:00:00.000Z" },
  { ticketKey: "t-2", state: "done", updatedAt: "2026-08-10T06:00:00.000Z" },
];

const DIED_ROWS = [
  { ticketKey: "t-1", state: "done", updatedAt: "2026-08-10T05:00:00.000Z" },
  {
    ticketKey: "t-2",
    state: "blocked",
    updatedAt: "2026-08-10T06:00:00.000Z",
    lastClass: "structural",
    nextAction:
      "no repair driver is wired; run tools/repair/cycle.mjs against an isolated copy and re-enqueue",
  },
];

test.describe("the readout the owner reads at 7am", () => {
  test("a FINISHED queue and an ALL-BLOCKED queue do not paint the same — this is the measured gap", async ({
    page,
  }) => {
    /*
     * THE GAP, VERBATIM FROM THE MEASUREMENT: with `ticket: null` and
     * `queueDepth: 0` the state route says the same thing in both cases, and the
     * strip rendered `IDLE / idle, queue empty` byte for byte whether the night
     * worked or every ticket died.
     */
    await serve(page, IDLE());
    await serveCensus(page, { tickets: DONE_ROWS });
    await page.goto(`/runs/${RUN_ID}`);
    const finished = await paint(page);
    const finishedCell = await page
      .locator('[data-testid="supervisor-census"]')
      .textContent();

    await page.unroute("**/api/supervisor");
    await page.unroute("**/api/supervisor/tickets");
    await serve(page, IDLE());
    await serveCensus(page, { tickets: DIED_ROWS });
    await page.goto(`/runs/${RUN_ID}`);
    const died = await paint(page);
    const diedCell = await page.locator('[data-testid="supervisor-census"]').textContent();

    // THE POSITIVE HALVES — each names its own count.
    expect(finished.liveness).toBe("idle");
    expect(finished.headline).toContain("queue finished");
    expect(finishedCell).toContain("2 done");
    expect(finishedCell).toContain("0 blocked");

    expect(died.liveness).toBe("blocked");
    expect(died.headline).toContain("queue ended");
    expect(diedCell).toContain("1 blocked");

    /*
     * THE NEGATIVE HALF, AND IT IS THE ONLY ASSERTION A BROWSER CAN MAKE THAT A
     * UNIT TEST CANNOT: the two rows differ in COLOUR as well as in text. A
     * distinction that exists only in a string is one a reader scanning a 30px
     * row at 7am does not make.
     */
    expect(died.background).not.toBe(finished.background);
    expect(died.colour).not.toBe(finished.colour);
    expect(new Set([finished.because, died.because]).size).toBe(2);
  });

  test("a queue where every ticket died reads RED, not amber — amber is reserved for 'this page cannot see'", async ({
    page,
  }) => {
    /*
     * The colour rule this whole component follows: amber means the PAGE cannot
     * see, red means the OWNER must act. A legible failure painted amber is the
     * preview card announcing a healthy backend was down, inverted — and it is the
     * mistake this lane was most likely to make, because every other new state on
     * this strip has been amber.
     */
    await serve(page, IDLE());
    await serveCensus(page, { tickets: DIED_ROWS });
    await page.goto(`/runs/${RUN_ID}`);
    const died = await paint(page);

    await page.unroute("**/api/supervisor");
    await page.unroute("**/api/supervisor/tickets");
    await serve(page, IDLE());
    await serveCensus(page, "notfound");
    await page.goto(`/runs/${RUN_ID}`);
    const cannotSee = await paint(page);

    expect(died.liveness).toBe("blocked");
    expect(cannotSee.liveness).toBe("idle");
    // The failure and the cannot-see share no tone.
    expect(died.background).not.toBe(cannotSee.background);
    // And `blocked` shares the tone `stuck` has always had, because both mean
    // the same thing to the owner: act on the run.
    await page.unroute("**/api/supervisor");
    await page.unroute("**/api/supervisor/tickets");
    await serve(page, STUCK());
    await serveCensus(page, "notfound");
    await page.goto(`/runs/${RUN_ID}`);
    const stuck = await paint(page);
    expect(stuck.liveness).toBe("stuck");
    expect(died.background).toBe(stuck.background);
  });

  test("the blocked ticket's OWN next_action is on screen — the string that was only in the database", async ({
    page,
  }) => {
    await serve(page, IDLE());
    await serveCensus(page, { tickets: DIED_ROWS });
    await page.goto(`/runs/${RUN_ID}`);

    // The 30px row carries it in the sentence…
    await openDetail(page);
    await expect(page.locator('[data-testid="supervisor-because"]')).toContainText(
      "run tools/repair/cycle.mjs",
    );

    // …and the detail pane — already open from the read above — carries the
    // row it came from, with the failure class.
    const failed = page.locator('[data-testid="supervisor-census-failed"]');
    await expect(failed).toContainText("t-2");
    await expect(failed).toContainText("blocked");
    await expect(failed).toContainText("structural");
    await expect(failed).toContainText("re-enqueue");

    /*
     * THE NEGATIVE HALF: a census WITHOUT the column must say so on screen rather
     * than render an empty paragraph. A blank there reads as "there is nothing to
     * do", which is the opposite of true for a blocked ticket.
     */
    await page.unroute("**/api/supervisor");
    await page.unroute("**/api/supervisor/tickets");
    await serve(page, IDLE());
    await serveCensus(page, { tickets: [{ ticketKey: "t-9", state: "blocked" }] });
    await page.goto(`/runs/${RUN_ID}`);
    await openDetail(page);
    await expect(page.locator('[data-testid="supervisor-census-failed"]')).toContainText(
      "does not carry next_action",
    );
    await expect(page.locator('[data-testid="supervisor-census-absent"]')).toContainText(
      "nextAction",
    );
  });

  test("a census route that 404s on every tick leaves the strip rendered and says WHICH kind of missing", async ({
    page,
  }) => {
    /*
     * TODAY'S BUILD, EXACTLY. `GET /api/supervisor/tickets` has no producer, so
     * this is what every poll does. The three things that must hold: the page still
     * renders (a 404 on a second route is not a blank RootLayout), the STATE
     * reading is not painted as a fault, and the row does not print a count it
     * does not have.
     */
    await serve(page, IDLE());
    await serveCensus(page, "notfound");
    await page.goto(`/runs/${RUN_ID}`);

    const painted = await paint(page);
    expect(painted.liveness).toBe("idle");
    // NOT amber, NOT red: a missing census route says nothing about the loop.
    await expect(page.locator('[data-testid="supervisor-strip"]')).toHaveAttribute(
      "data-liveness",
      "idle",
    );
    // The cell prints a word rather than a number, and never a zero.
    const cell = page.locator('[data-testid="supervisor-census"]');
    await expect(cell).toHaveText(/ticket list unread|no ticket list/);
    await expect(cell).not.toContainText("0 blocked");
    /*
     * RETARGETED 2026-08-10. This asserted "did not answer" on
     * `supervisor-because`, which carries the DESIRED-STATE reason — for this
     * fixture, "owner set it to stopped: the owner pressed stop and the drain
     * finished". The census failure lives in `supervisor-census-note`, whose own
     * docblock (`lib/supervisor.ts:953`) is "Never blank. Why there is no census".
     * Two different facts in two different sentences is the property this suite is
     * built on, so the spec was asserting the right substance against the wrong
     * element — and it is retargeted rather than relaxed: the note must still name
     * the route and still say it did not answer.
     */
    /*
     * AND THE NOTE LIVES IN THE DETAIL PANEL, so it has to be opened to be read —
     * found the hard way: asserting it on the collapsed strip failed with
     * "element(s) not found", which is a third distinct way this one assertion was
     * wrong. The COLLAPSED row's job is the word above ("ticket list unread" vs "no
     * census"); the SENTENCE naming the route is one gesture away, and both halves
     * are asserted rather than either being taken on trust.
     */
    await openDetail(page);
    const note = page.locator('[data-testid="supervisor-census-note"]');
    await expect(note).toContainText("did not answer");
    await expect(note).toContainText("/api/supervisor/tickets");
    // And the headline sentence still speaks only about the loop, never about the census.
    await openDetail(page);
    await expect(page.locator('[data-testid="supervisor-because"]')).not.toContainText(
      "did not answer",
    );

    /*
     * THE PAGE IS STILL THERE — the whole shell did not go down over a 404 on a
     * route nobody asked for. The nav is asserted first for the reason the
     * render-guard test above states: a page that keeps the shell and degrades one
     * row is a different outcome from a page that renders nothing, and only the nav
     * can tell them apart.
     */
    await expect(page.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="run-rail"]')).toBeVisible();
    await expect(page.locator('[data-testid="render-guard-alarm"]')).toHaveCount(0);
  });

  test("four bodies that are not a census: each renders a state, none of them throws, and none invents a count", async ({
    page,
  }) => {
    /*
     * THE SHAPE OF THE FAILURE THIS FILE ALREADY HAS ONE OF FOR `/api/supervisor`
     * (see "six bodies that are not a reading"): a 200 with the wrong body used to
     * take RootLayout down and blank every page in the app. The census is a second
     * route that can do the same thing, so it gets the same table.
     */
    const shapes: readonly { readonly name: string; readonly body: unknown }[] = [
      { name: "a run detail answering the census path", body: { runId: "x", status: "running" } },
      { name: "tickets is a string", body: { tickets: "none" } },
      { name: "a row with no state", body: { tickets: [{ ticketKey: "t-1" }] } },
      { name: "a row whose nextAction is an object", body: { tickets: [{ ticketKey: "t-1", state: "blocked", nextAction: { text: "x" } }] } },
    ];

    for (const shape of shapes) {
      await page.unroute("**/api/supervisor");
      await page.unroute("**/api/supervisor/tickets");
      await serve(page, IDLE());
      await serveCensus(page, shape.body);
      await page.goto(`/runs/${RUN_ID}`);

      // The strip is still there, which is the assertion the 77 browser failures
      // bought: a throwing RootLayout renders no strip, no canvas and no error.
      const strip = page.locator('[data-testid="supervisor-strip"]');
      await expect(strip, `${shape.name}: the strip did not render`).toBeVisible();
      const cell = page.locator('[data-testid="supervisor-census"]');
      await expect(cell, `${shape.name}: the outcome cell was blank`).not.toHaveText("");
      await expect(cell, `${shape.name}: a count was invented`).not.toContainText("done ·");

      await openDetail(page);
      const note = page.locator('[data-testid="supervisor-census-note"]');
      await expect(note, `${shape.name}: the note does not name what is wrong`).toContainText(
        /tickets is|state is|nextAction is|the body is/,
      );
      await expect(note, `${shape.name}: waiting was offered as a cure`).toContainText(
        "Waiting will not fix this one",
      );
    }
  });

  test("the repair cycle row tells 'nobody reports this' from 'nothing to report'", async ({
    page,
  }) => {
    /*
     * ITEM C. `lastRepair` is null for three of the four outcomes
     * `decideRepairOutcome` can produce, so the row above this one says "no patch
     * has been applied" for a cycle that ran, consulted the ruled-out ledger and
     * refused a proposal on sight. These two states must not read the same.
     */
    await serve(page, IDLE());
    await serveCensus(page, "notfound");
    await page.goto(`/runs/${RUN_ID}`);
    await openDetail(page);
    const row = page.locator('[data-testid="supervisor-repair-cycle"]');
    // TODAY: the field is not on the wire at all.
    await expect(row).toHaveAttribute("data-cycle", "unreported");
    await expect(row).toContainText("NOT the same as 'no repair was attempted'");

    // A PRODUCER THAT LANDED AND HAS NOTHING TO REPORT.
    await page.unroute("**/api/supervisor");
    await page.unroute("**/api/supervisor/tickets");
    await serve(page, IDLE());
    await serveCensus(page, "notfound");
    await page.route("**/api/supervisor", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...IDLE(), lastRepairCycle: null }),
      });
    });
    await page.goto(`/runs/${RUN_ID}`);
    await openDetail(page);
    await expect(page.locator('[data-testid="supervisor-repair-cycle"]')).toHaveAttribute(
      "data-cycle",
      "null",
    );

    // A CYCLE THAT RAN AND APPLIED A PATCH WITH NO ROLLBACK POINT — the one fact
    // the owner would want in the first clause.
    await page.unroute("**/api/supervisor");
    await page.unroute("**/api/supervisor/tickets");
    await serveCensus(page, "notfound");
    await page.route("**/api/supervisor", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...IDLE(),
          lastRepairCycle: {
            signature: "a".repeat(64),
            outcomeKind: "applied",
            outcomeCode: "APPLIED",
            verdict: "ACCEPTED",
            applied: true,
          },
        }),
      });
    });
    await page.goto(`/runs/${RUN_ID}`);
    await openDetail(page);
    const applied = page.locator('[data-testid="supervisor-repair-cycle"]');
    await expect(applied).toHaveAttribute("data-cycle", "reported");
    await expect(applied).toContainText("NO ROLLBACK POINT WAS RECORDED");
    await expect(applied).toContainText("an edit, not a repair");
  });

  test("the outcome cell costs the canvas nothing — the strip is still one 30px line", async ({
    page,
  }) => {
    /*
     * THE CONSTRAINT THIS STRIP HAS ALWAYS HAD: it mounts on every route including
     * `/runs/<id>`, whose shell is `h-dvh overflow-hidden` with the canvas as a
     * `flex-1 min-h-0` child. Every pixel the strip takes is a pixel off the graph,
     * so a sixth cell that wrapped the row to two lines would cost the canvas 30px
     * on every page in the app.
     */
    await serve(page, IDLE());
    await serveCensus(page, { tickets: DIED_ROWS });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/runs/${RUN_ID}`);
    const box = await page.locator('[data-testid="supervisor-strip"] > div').first().boundingBox();
    expect(box?.height).toBeLessThanOrEqual(31);

    // AND AT A NARROW WIDTH: the row still does not wrap. The sentence truncates,
    // which is what `flex-1 truncate` is for, and the cells stay on the line.
    await page.setViewportSize({ width: 900, height: 800 });
    const narrow = await page.locator('[data-testid="supervisor-strip"] > div').first().boundingBox();
    expect(narrow?.height).toBeLessThanOrEqual(31);
    await expect(page.locator('[data-testid="supervisor-census"]')).toBeVisible();
  });
});
