/**
 * Serve one run's detail with fields changed — the seed-then-route helper the
 * browser specs used to carry one private copy each.
 *
 * WHY IT IS HERE — 2026-08-25. `panel-copy.browser.spec.ts`,
 * `result-surfaces.browser.spec.ts` and `canvas-shell-copy.browser.spec.ts`
 * hold the same twenty lines apiece, `prose-guard.browser.spec.ts` holds the
 * variant that also ledgers the strings a patch introduces, and the fifth copy
 * — written for `chat-parked.browser.spec.ts` — took an object and
 * `Object.assign` where the other four take a callback, so it was no longer
 * diffable against them. This is `panel-copy.browser.spec.ts`'s body, with
 * the two facts every copy re-learned kept beside the code they protect. The
 * four older specs still carry their own; folding them in (and letting
 * prose-guard's variant wrap this one) is a follow-up so that lane's diff did
 * not grow.
 *
 * THE HEADERS ARE WRITTEN OUT, NOT COPIED, AND BOTH SHORTCUTS WERE TRIED AND
 * WATCHED FAIL — in the same way, which is why it is worth the paragraph
 * (`panel-copy.browser.spec.ts` records the diagnosis at length). Neither
 * `route.fulfill({ response, json })` nor a copy of `response.headers()`
 * produces a page: the run view mounts with `run === null` and renders the
 * bare `<Panel title="Run">` skeleton, so the RAIL IS SIMPLY ABSENT and the
 * failure reads as "the toolbar was never rendered" rather than as anything
 * about a response. The first carries the original `content-length` over a
 * body of a different length; the second carries `connection` and
 * `keep-alive`, which are hop-by-hop headers a fulfilled response may not
 * restate. `access-control-allow-origin` is not optional: the app is served
 * from 4322 and the fixture API from 4177 (`config.ts`), so a fulfilled
 * response without it is a CORS failure and the same blank page.
 *
 * AND THE BODY IS FETCHED ONCE, BEFORE THE ROUTE IS INSTALLED — the repair
 * `canvas-shell-copy.browser.spec.ts` landed on 2026-08-05 for three flakes of
 * its own. `await route.fetch()` inside the handler added a round trip of the
 * harness's own to every detail response, and the run page raced that delay
 * against its own SSE replay; a stream that won used to write over the SWR
 * cache and the page never recovered. That product race is closed in
 * `lib/use-run-stream.ts` and deliberately lost in
 * `blank-cache.browser.spec.ts`, so what the pre-fetch removes now is a delay
 * nobody asked for, not a failure.
 *
 * THE ROUTE MATCHES THE BARE DETAIL PATH ONLY (`url.search === ""`): the
 * sub-resources under `/api/runs/:id/` have paths of their own and the
 * fixture API keeps answering those.
 */

import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./config";

/**
 * The two headers a fulfilled JSON body needs on this harness: the
 * cross-origin allowance argued above, and the `no-store` the fixture API
 * sends on every JSON body of its own (`api-server.ts`, `sendJson`), mirrored
 * so a routed detail is not cached differently from a served one.
 */
export const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };

export async function patchDetail(
  page: Page,
  runId: string,
  patch: (body: Record<string, unknown>) => void,
): Promise<void> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${runId}`);
  const body = (await seed.json()) as Record<string, unknown>;
  patch(body);
  const payload = JSON.stringify(body);

  await page.route(
    (url) => url.pathname === `/api/runs/${runId}` && url.search === "",
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: payload,
      });
    },
  );
}
