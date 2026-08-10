import { defineConfig } from "@playwright/test";

/**
 * THE PURE-LOGIC SUITE, WITH NOTHING LISTENING ON A PORT.
 *
 * WHY A SECOND CONFIG EXISTS AT ALL. `playwright.config.ts` declares `webServer`
 * at the TOP LEVEL, so `--project=unit` still boots `next dev` and still runs
 * `globalSetup`'s fixture API. Every `*.unit.spec.ts` file in this directory is
 * pure computation over `src/lib` — it opens no page and makes no request — so
 * that server is pure cost. On 2026-08-10 the cost was not merely wasted: a real
 * Agent-SDK run was burning the owner's subscription window on this machine and
 * a `next dev` compile storm beside it is the kind of interference nobody can
 * measure after the fact.
 *
 * WHAT IT IS NOT. It is NOT a claim that the shipped suite passed. This config
 * runs `unit` and CANNOT run `browser`: it has no `baseURL`, no dev server and no
 * fixture API, so a browser spec pointed at it fails on the first `page.goto`
 * rather than quietly passing. That asymmetry is deliberate — `testIgnore` below
 * makes the refusal explicit instead of leaving it to a timeout — because the one
 * thing worse than a deferred suite is a deferred suite somebody reports as green.
 *
 * A NOTE ON THE PORTS, RECORDED BECAUSE IT CORRECTS A WRITTEN CLAIM. The reason
 * given for not running the shipped config was that its `webServer` binds the
 * ports a live run holds. It does not: `tests/fixtures/config.ts` binds 4322 and
 * 4177 and says in its own docblock that those are "DELIBERATELY NOT THE DEV
 * PORTS" (dev is 4319, the backend 4176). The real reasons to prefer this config
 * are the two above — cost, and interference that cannot be measured afterwards.
 *
 * Run it with:
 *   npx playwright test -c tests/no-server.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.unit\.spec\.ts$/,
  testIgnore: /.*\.browser\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 30_000,
});
