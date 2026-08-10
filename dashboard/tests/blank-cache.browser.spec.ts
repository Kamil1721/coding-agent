/**
 * THE BLANK RUN PAGE — the product race behind the browser suite's flake.
 *
 * WHAT IS BEING MEASURED. A run page that loses a race between its own SSE
 * replay and its REST detail mounts EMPTY AND STAYS EMPTY. Not slow: final. The
 * captured failure snapshot the full-suite runs kept producing was
 *
 *     - main: - heading "Run" [level=2]
 *
 * and nothing else, which is `runs/[runId]/page.tsx:727` — the branch for
 * `run === undefined && error === undefined && !isLoading`.
 *
 * THE MECHANISM, in three lines of `lib/use-run-stream.ts`:
 *
 *   1. every stream event is written into the SWR cache with
 *      `mutate(previous => applyRunEvent(previous, event), { revalidate: false })`;
 *   2. `applyRunEvent` is `if (previous === undefined) return undefined`, so an
 *      event that beats the detail folds into nothing — AND the write itself
 *      makes SWR discard the detail request that is already in flight, because
 *      SWR drops any response whose request started before a mutation;
 *   3. `pollIntervalFor` returns 0 for `status === undefined`, so after that
 *      there is no further fetch. The page is empty for good.
 *
 * The terminal `status` row does ask for a revalidation (`settlesExtraFields`),
 * and it is not enough: the fixture's stream writes one more frame after it
 * (`socket-echo`, exactly as the real `attachSse` replays a post-terminal row),
 * and that frame's `mutate` discards the revalidation in turn.
 *
 * WHY THE HARNESS CANNOT FIX THIS, AND WHY THIS FILE EXISTS BEFORE THE HARNESS
 * EDITS DO. Three sibling specs carried the pre-repair `await route.fetch()`
 * shape that made the race easy to lose — `prose-guard`, `result-surfaces` and
 * `panel-copy` — and porting `canvas-shell-copy.browser.spec.ts`'s repair to
 * them (done, same pass) removes the harness's own contribution to the delay.
 * That is a follow-up, not the fix: doing it first would have made the product
 * defect unobservable, which is this repository's signature failure manufactured
 * on purpose. So this file loses the race DELIBERATELY, with a delay of its own
 * that no amount of harness tidying can remove, and asserts the page recovers.
 *
 * THE CONTROL VARIES ONE THING. Both tests below open the SAME fixture
 * (`FINISHED_RUN_ID`), through the SAME route handler, serving the SAME
 * pre-fetched bytes, and assert the SAME element. The only difference is
 * `DETAIL_DELAY_MS` — 0 in the control, 1500 in the test. A previous pass's
 * "negative control" compared two different fixtures and therefore proved
 * nothing; this one cannot, because there is nothing else to differ.
 *
 * `FINISHED_RUN_ID` AND NOT A LIVE RUN, on purpose: on a terminal run
 * `pollIntervalFor` is 0 by design, which is the branch that makes the empty
 * mount FINAL rather than merely slow. A live run would recover on its own next
 * poll and this test would pass against the defect.
 *
 * NO `toPass` RETRY ANYWHERE IN THIS FILE. Every other spec that touches this
 * race retries the navigation, and a retry is precisely what hides the defect:
 * only a fresh mount undoes an emptied cache. One `goto`, one assertion.
 */

import { expect, test } from "@playwright/test";

import { API_ORIGIN, FINISHED_RUN_ID } from "./fixtures/config";

/**
 * How long the detail response is held back.
 *
 * 1500ms is well past the whole replay: the fixture writes every durable row
 * plus the echo the instant the stream opens, so by the time the detail is
 * released the cache has already been written over and the discard has already
 * happened. It is also comfortably inside the 15s expect timeout, so a page
 * that merely waits its turn still passes.
 */
const DETAIL_DELAY_MS = 1_500;

/**
 * Serve the run detail from memory, optionally late, and count the requests.
 *
 * THE BODY IS FETCHED ONCE, BEFORE THE ROUTE IS INSTALLED — the shape
 * `canvas-shell-copy.browser.spec.ts` landed for this exact race. Fetching
 * inside the handler would add a round trip of the harness's own to every
 * response and make the delay below un-attributable.
 *
 * The counter is what turns "the page is blank" into "and nothing fetched
 * again": a page that is merely slow keeps asking.
 */
async function serveDetail(
  page: import("@playwright/test").Page,
  runId: string,
  delayMs: number,
): Promise<{ readonly count: () => number }> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${runId}`);
  const payload = JSON.stringify((await seed.json()) as Record<string, unknown>);

  let requests = 0;
  await page.route(
    (url) => url.pathname === `/api/runs/${runId}` && url.search === "",
    async (route) => {
      requests += 1;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: payload,
      });
    },
  );

  return { count: (): number => requests };
}

test.describe("A run page that loses the race to its own stream still renders", () => {
  /*
   * THE CONTROL. Identical to the test below except that the detail is served
   * immediately. If this one ever goes red the failure is not about the race
   * and the test below says nothing.
   */
  test("control: the detail wins the race and the run renders", async ({ page }) => {
    const detail = await serveDetail(page, FINISHED_RUN_ID, 0);

    await page.goto(`/runs/${FINISHED_RUN_ID}`);

    await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
    expect(detail.count()).toBeGreaterThan(0);
  });

  test("the stream beats the detail and the page recovers", async ({ page }) => {
    const detail = await serveDetail(page, FINISHED_RUN_ID, DETAIL_DELAY_MS);

    await page.goto(`/runs/${FINISHED_RUN_ID}`);

    /*
     * THE RAIL, NOT SOME TEXT. `runs/[runId]/page.tsx` renders the whole rail
     * only past the `run === undefined` guard, so this element existing IS the
     * guard having been passed. The empty branch renders `<Panel title="Run">`
     * and nothing inside it.
     */
    await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();

    /*
     * AND THE EMPTY BRANCH IS GONE, not merely covered. Two elements can both
     * be on the page; this one may not be.
     */
    await expect(page.getByRole("heading", { name: "Run", level: 2 })).toHaveCount(0);

    expect(detail.count()).toBeGreaterThan(0);
  });
});
