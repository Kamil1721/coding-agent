/**
 * playwright.config.mjs — the configuration the FROZEN SUITE runs under.
 *
 * This file lives in the scorer image, not in the artefact and not in the
 * suite. That is the point: doc 02 section 5.6 documents `conftest.py`
 * monkey-patching pytest's `TestReport` as an exploit Anthropic observed in
 * production RL, and its JavaScript equivalent is an artefact-supplied runner
 * config with a custom `reporter`, `globalSetup` or `setupFiles`. Because the
 * suite executes under THIS config with THIS image's Playwright, an
 * artefact-side reporter patch is inert — it patches something that is never
 * loaded. The static scan in src/tier0.ts still reports it, as evidence about
 * the builder rather than as a threat to the verdict.
 *
 * Everything here is deliberate; nothing is a default that happened to be left.
 */

import { defineConfig } from "@playwright/test";

const suiteDir = process.env.BAKEOFF_SUITE_DIR ?? "/scorer/suite";
const baseURL = process.env.BAKEOFF_APP_ORIGIN;

if (!baseURL) {
  // Fail clean rather than let every test fail with a confusing relative-URL
  // error. The scorer sets this to the loopback origin that actually answered
  // the health probe (127.0.0.1 literally, never "localhost": under
  // --network=none the container has only a loopback interface and Node's
  // IPv6-first name resolution turns a working server into an intermittent
  // ECONNREFUSED).
  throw new Error(
    "BAKEOFF_APP_ORIGIN is not set. The sealed scorer sets it after the boot gate passes; " +
      "this config is not usable outside that container.",
  );
}

export default defineConfig({
  testDir: suiteDir,

  // ---- THE TWO RUNNERS MUST NOT FIGHT OVER THE SAME FILES ----------------
  //
  // Playwright's DEFAULT testMatch is `**/*.@(spec|test).?(c|m)[jt]s?(x)`,
  // which collects `*.test.mjs` as well as `*.spec.mjs`. The frozen suite uses
  // BOTH suffixes and they mean different runners: `RUNNER_SUFFIX` in
  // ../src/spec-types.ts pins `.test.mjs` to node:test and `.spec.mjs` to
  // Playwright.
  //
  // Under the default, every node:test file was collected HERE, where an
  // imported `node:test` `test()` registers nothing Playwright knows about. The
  // file executed, printed its own ticks, and produced NO attributable outcome —
  // so every node:test criterion came back `unasserted`, which fails. Across a
  // campaign that reads as "every model shipped broken apps" while the real
  // fault is the harness running half its own suite under the wrong runner.
  // STATUS.md blocker 1.1; owner decision (a).
  //
  // Narrowed to `.spec.mjs` ONLY. The node:test half is executed by the second
  // pass in ../src/scorer-container.ts, and any frozen file that neither runner
  // collects is a hard, named failure there rather than a silent skip.
  testMatch: "**/*.spec.mjs",

  // The suite mount is READ-ONLY. Everything Playwright writes goes to the
  // tmpfs, never next to the frozen tests.
  outputDir: "/tmp/playwright-artifacts",

  // ---- determinism -------------------------------------------------------
  // One worker, no parallelism, no retries. A retry would let a flaky test pass
  // on a second attempt and turn `heldOutPass` into a partly random variable;
  // held-constant variable 5 (doc 03 section 7.3) requires that the same suite
  // decides the same way for every configuration.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  // A `.only` anywhere in the frozen suite silently skips every other test in
  // its file. Refusing to run is correct: the suite is frozen and audited, so a
  // `.only` in it is a defect in the freeze, not a local convenience.
  forbidOnly: true,

  timeout: 120_000,
  expect: { timeout: 15_000 },
  globalTimeout: 20 * 60 * 1000,

  // ---- reporting ---------------------------------------------------------
  // The JSON reporter writes to an explicit file rather than to stdout, where it
  // would interleave with the application's own output. The line reporter keeps
  // stdout human-readable so a failure is triageable from the captured tail.
  reporter: [
    ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "/scorer/out/suite-report.json" }],
    ["line"],
  ],

  use: {
    baseURL,

    // ---- CAPTURE PATHS THAT CANNOT BE MASKED ARE DISABLED ----------------
    // doc 02 section 1.6: masking is capture-time only, because "regex cannot
    // read pixels". Playwright's automatic screenshot, video and trace capture
    // accept no mask option, so each of them is an unmaskable path by which a
    // rendered credential becomes permanent.
    //
    // `trace` is the largest of the three and the easiest to leave on by habit:
    // a trace .zip carries full DOM snapshots, network request and response
    // bodies, and console output. A password typed into a login form during a
    // test is in that archive verbatim, not merely as pixels.
    //
    // Screenshots for the record are captured separately by the scorer with an
    // explicit mask list; see DEFAULT_MASK_SELECTORS in src/scorer-protocol.ts.
    screenshot: "off",
    video: "off",
    trace: "off",

    actionTimeout: 30_000,
    navigationTimeout: 60_000,

    // A fixed rendering environment. Held-constant variable 3 covers the image;
    // a drifting locale, timezone or colour scheme would put noise straight into
    // results that are compared across configurations.
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    viewport: { width: 1280, height: 800 },

    launchOptions: {
      // The CONTAINER is the sandbox: --network=none, a read-only root
      // filesystem, every capability dropped, no-new-privileges. Chromium's own
      // setuid sandbox cannot start without those capabilities, so it is
      // disabled explicitly instead of failing at launch and looking like a
      // flaky app. --disable-dev-shm-usage avoids the crash that the default
      // 64 MB /dev/shm produces under load; the run invocation also passes
      // --shm-size=1g.
      chromiumSandbox: false,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
    },
  },

  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
