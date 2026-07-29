import { defineConfig } from "@playwright/test";

import { API_ORIGIN, APP_ORIGIN, APP_PORT, TEST_DIST_DIR } from "./tests/fixtures/config";

/**
 * THE CLIENT'S TEST RUNNER, AND WHY IT IS THIS ONE.
 *
 * The server package runs `node:test` over `tsc` output, and matching it here
 * was tried first. It cannot work, and the reason is recorded rather than
 * asserted: Node's type stripping does not resolve extensionless specifiers, so
 * `node --test` on a file importing `src/lib/use-run-graph.ts` dies with
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *   '/…/dashboard/src/lib/api' imported from …/src/lib/use-run-graph.ts
 *
 * — and every module in this app is written that way, including
 * `src/lib/graph.ts`'s import of the SERVER's reducer, which is the one import
 * the canvas's correctness rests on. Emitting to `dist/` first would work, but
 * it buys a build step and a second copy of the tree for the sake of matching a
 * script name.
 *
 * A jsdom runner was rejected for a harder reason. THREE OF THE FOUR THINGS
 * THIS SUITE EXISTS TO CATCH ARE NOT FACTS ABOUT THE DOM, they are facts about
 * computed style and layout: the inferred edge's stroke resolves through a CSS
 * custom property, the reduced-motion rule lives in a media query, and the
 * canvas collapsing to a 324px grid track only happens once a real grid has
 * been laid out at a real width. jsdom has no layout engine and does not
 * resolve `var()`, so every one of those checks would pass no matter what the
 * source said — a check that cannot go red, which is the specific defect this
 * suite was commissioned to fix.
 *
 * So: `@playwright/test` for both halves. Its loader transpiles `.ts`/`.tsx`
 * and honours this package's `paths`, which lets the pure-logic specs import
 * application modules directly with no build; and its browser drives the REAL
 * Next dev server, so the styles under assertion are the ones a reader gets.
 * Type CHECKING is not lost by using a transpile-only loader — this package's
 * `tsconfig.json` includes every `.ts` file in the directory, so
 * `npm run typecheck` covers everything in here, fixtures included.
 *
 * `npm test` needs nothing set up by hand: `pretest` fetches the browser if it
 * is missing, `globalSetup` starts the fixture API in-process, and `webServer`
 * starts a dev server on ports of its own.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  // One dev server, one fixture API, one run id: parallel workers would only
  // buy contention.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  reporter: [["list"]],
  timeout: 60_000,
  expect: {
    // React Flow measures its nodes and fits the viewport across a couple of
    // frames, and the dev server compiles a route on first request.
    timeout: 15_000,
  },
  projects: [
    {
      name: "unit",
      testMatch: /.*\.unit\.spec\.ts$/,
    },
    {
      name: "browser",
      testMatch: /.*\.browser\.spec\.ts$/,
      use: {
        browserName: "chromium",
        baseURL: APP_ORIGIN,
        // Deterministic device pixel ratio and colour scheme: the assertions
        // below are on exact computed values.
        deviceScaleFactor: 1,
        colorScheme: "dark",
        trace: "off",
        video: "off",
      },
    },
  ],
  webServer: {
    command: `npx next dev -H 127.0.0.1 -p ${String(APP_PORT)}`,
    url: `${APP_ORIGIN}/`,
    // Never measure a server somebody else started: it may be serving a
    // different tree, and a mutation proved against it would prove nothing.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NEXT_TEST_DIST_DIR: TEST_DIST_DIR,
      NEXT_PUBLIC_API_BASE_URL: API_ORIGIN,
    },
  },
});
