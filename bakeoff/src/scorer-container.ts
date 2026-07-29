#!/usr/bin/env node
/**
 * scorer-container.ts — the program that runs INSIDE the sealed scoring
 * container. It is the entrypoint of docker/scorer.Dockerfile.
 *
 * WHAT IT CAN SEE: a staged copy of the build artefact, the frozen acceptance
 * suite (read-only), and a sealed plan carrying the frozen criteria and capture
 * settings.
 *
 * WHAT IT CANNOT SEE, BY CONSTRUCTION: the network (`--network=none`), the build
 * workspace's git history (stripped during staging and never walked), the
 * builder's logs, the builder's self-report, the configuration id, the models,
 * the efforts, the costs. {@link assertPlanIsSealed} on the host refuses to
 * write a plan containing any of that, so this program cannot be influenced by
 * it even accidentally.
 *
 * ORDER OF WORK, AND WHY:
 *   1. Static scans (stub markers, reward-hack exploits, neutered scripts).
 *      Free, and structurally immune to every judge bias — doc 02 section 5.3.
 *   2. Build / typecheck / lint.
 *   3. Boot and health probe, then routes.
 *   4. Masked screenshot capture and DOM/runtime observations.
 *   5. Data expectations.
 *   6. The frozen suite, executed with THIS IMAGE's pinned Playwright and THIS
 *      IMAGE's configuration — never with the artefact's node_modules and never
 *      with an artefact-supplied runner config. That single choice is what makes
 *      artefact-side reporter tampering inert rather than merely detected.
 *
 * It always writes /scorer/out/result.json, including when it fails: a missing
 * result is indistinguishable from a crashed container, and the host must be
 * able to tell an infrastructure failure from a model outcome (doc 03: runs with
 * status "error" are excluded from rate denominators, not counted as failures).
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { notImplemented } from "./contracts.js";
import { sha256Hex } from "./hash.js";
import { redactForPersistence, redactText } from "./redact.js";
import {
  CONTAINER_PATHS,
  GATE_IDS,
  SCORER_PROTOCOL_VERSION,
  SUITE_MANIFEST_FILENAME,
  TITLE_PATH_SEPARATOR,
  parseScorerPlan,
  parseSuiteManifest,
  resolveExecutionPlan,
  triageSuiteFailures,
} from "./scorer-protocol.js";
import type {
  ContainerResult,
  CriterionCoverage,
  DomFinding,
  ExploitFinding,
  GateOutcome,
  ManifestDataExpectation,
  ManifestUiFlow,
  ScorerPlan,
  ScreenshotRecord,
  SuiteExecutionRaw,
  SuiteFailureTriage,
  SuiteManifest,
  Tier0GateResult,
} from "./scorer-protocol.js";
import {
  assertRunningInsideSealedContainer,
  detectBuildEvidence,
  evaluateHttpExpectation,
  evaluateSqliteExpectation,
  loopbackOrigins,
  probeHealth,
  probeStaticRoot,
  runCommand,
  scanExploits,
  scanPackageScripts,
  loadScannableSources,
  scanStubMarkers,
  startProcess,
  startStaticServer,
  walkFiles,
} from "./tier0.js";
import type { DataExpectationResult, StartedProcess, StaticServer, WalkedFile } from "./tier0.js";

/** Where the scorer's own pinned Playwright and config live inside the image. */
const SCORER_HOME = "/opt/bakeoff-scorer";
const SUITE_PLAYWRIGHT_CONFIG = `${SCORER_HOME}/playwright.config.mjs`;

/* -------------------------------------------------------------------------
 * Browser-side globals.
 *
 * Declared locally rather than adding "DOM" to `lib` in tsconfig.json. The DOM
 * lib and @types/node both declare `fetch`, `Response`, `Headers`, `AbortSignal`
 * and friends; pulling DOM into this program's global scope would change those
 * types for every other module in the harness — the runner, the ledger, the
 * preflight — none of which run in a browser. These declarations exist only so
 * the callbacks passed to `page.evaluate` typecheck; they are ambient and are
 * erased entirely, and the callback body executes in Chromium, not in Node.
 * ---------------------------------------------------------------------- */

interface EvaluatedImage {
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly currentSrc: string;
  readonly src: string;
}
interface EvaluatedBody {
  readonly innerText: string | null;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}
declare const document: {
  readonly body: EvaluatedBody;
  readonly images: ArrayLike<EvaluatedImage>;
};
declare function getComputedStyle(element: EvaluatedBody): { readonly fontFamily: string };

/* -------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------- */

function gate(
  id: string,
  name: string,
  outcome: GateOutcome,
  detail: string,
  durationMs: number,
  command: string | null,
  exitCode: number | null,
): Tier0GateResult {
  return { id, name, outcome, detail: redactText(detail).text, durationMs, command, exitCode };
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/**
 * Environment handed to every command run against the artefact.
 *
 * Deliberately minimal and deliberately explicit. The container receives no
 * credentials, so there is nothing here to leak; the point of rebuilding the
 * environment rather than inheriting it is that a future change to the run
 * invocation cannot silently widen what builder-authored build scripts can read.
 */
function artifactEnv(origin: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    npm_config_cache: "/tmp/.npm",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    XDG_CACHE_HOME: "/tmp/.cache",
  };
  if (origin !== null) env["BAKEOFF_APP_ORIGIN"] = origin;
  return env;
}

/* -------------------------------------------------------------------------
 * Phase 1 — static scans
 * ---------------------------------------------------------------------- */

interface StaticScanOutput {
  readonly gates: readonly Tier0GateResult[];
  readonly exploitFindings: readonly ExploitFinding[];
  /**
   * Every file the scan walked.
   *
   * Handed on to the BUILD gate rather than re-walked there, so that "what was
   * looked at for build evidence" and "what was scanned" are the same list with
   * the same exclusions and the same cap. Two walks would be two scopes, and the
   * second one's exclusions would drift silently.
   */
  readonly walkedFiles: readonly WalkedFile[];
}

function runStaticScans(plan: ScorerPlan, manifest: SuiteManifest): StaticScanOutput {
  const startedAt = Date.now();
  const artifactDir = CONTAINER_PATHS.artifact;

  const missingDirs = manifest.sourceDirs.filter((dir) => {
    try {
      return !statSync(join(artifactDir, dir)).isDirectory();
    } catch {
      return true;
    }
  });

  // SCAN THE WHOLE ARTEFACT, NOT ONLY THE DECLARED DIRECTORIES.
  //
  // `sourceDirs` is the suite's assertion about where the work is meant to live,
  // and its absence is a gate failure below. It is NOT the scan scope: a
  // manifest declaring ["src"] against a builder that also created lib/ would
  // leave lib/ unscanned while the missing-directory check stayed silent,
  // because src/ does exist. NEVER_WALKED_DIRS already removes node_modules,
  // dist, build, out, coverage and the VCS directories, and
  // isScannableSourceFile limits reads to source extensions and runner configs,
  // so the whole-tree sweep costs very little precision and closes the hole.
  const walk = walkFiles(artifactDir, ["."], plan.limits.maxScannedFiles);
  const selection = loadScannableSources(walk.files, plan.limits.maxScannedFileBytes);
  const stubs = scanStubMarkers(selection.sources);
  const exploits = [...scanExploits(selection.sources), ...scanPackageScripts(artifactDir)];
  const scanMs = Date.now() - startedAt;

  const scopeNote =
    `scanned ${selection.sources.length} source file(s) of ${walk.files.length} walked, across the whole artefact ` +
    (selection.skippedMinified.length > 0
      ? `(skipped ${selection.skippedMinified.length} machine-generated/minified file(s)) `
      : "") +
    (selection.skippedTooLarge.length > 0
      ? `(skipped ${selection.skippedTooLarge.length} file(s) above the ${plan.limits.maxScannedFileBytes}-byte read cap) `
      : "") +
    `(declared sourceDirs: ${manifest.sourceDirs.join(", ")}; skipped ${walk.skippedDirs.length} excluded dir(s))` +
    (walk.truncated ? ` (TRUNCATED at the ${plan.limits.maxScannedFiles}-file cap)` : "") +
    (missingDirs.length > 0 ? `; declared but absent: ${missingDirs.join(", ")}` : "");

  const stubGate =
    missingDirs.length > 0
      ? gate(
          GATE_IDS.noStubMarkers,
          "no stub markers in declared source",
          "fail",
          `the frozen manifest declares source directories that do not exist in the artefact: ` +
            `${missingDirs.join(", ")}. A scan scope that does not exist is a scan that proves nothing, ` +
            `so this is a failure rather than a skip. ${scopeNote}`,
          scanMs,
          null,
          null,
        )
      : gate(
          GATE_IDS.noStubMarkers,
          "no stub markers in declared source",
          stubs.length === 0 ? "pass" : "fail",
          stubs.length === 0
            ? `no forbidden pattern found; ${scopeNote}`
            : `${stubs.length} stub marker(s); ${scopeNote}. First 20: ` +
              stubs
                .slice(0, 20)
                .map((f) => `${f.path}:${f.line} ${f.rule}`)
                .join("; "),
          scanMs,
          null,
          null,
        );

  const blockingExploits = exploits.filter((f) => f.blocking);
  const exploitGate = gate(
    GATE_IDS.noRewardHackExploits,
    "no reward-hack exploits in test paths",
    blockingExploits.length === 0 ? "pass" : "fail",
    blockingExploits.length === 0
      ? `no blocking exploit pattern found; ${exploits.length} non-blocking finding(s) recorded for review`
      : `${blockingExploits.length} blocking finding(s): ` +
        blockingExploits
          .slice(0, 20)
          .map((f) => `${f.path}${f.line === null ? "" : `:${f.line}`} ${f.rule}`)
          .join("; "),
    scanMs,
    null,
    null,
  );

  return { gates: [stubGate, exploitGate], exploitFindings: exploits, walkedFiles: walk.files };
}

/**
 * What `GATE:build` reports when the frozen manifest declares no build step.
 *
 * NOT A CONSTANT, and defect #35 is why it stopped being one. The manifest is
 * authored by the spec seat from the ticket alone, before any implementation
 * exists, and for a static-site ticket it routinely declares `build: null`. That
 * declaration used to produce `not_applicable`, which `gateToCriterion` maps to
 * `passed: true` — so a BLOCKING gate the owner reads as always-on was switched
 * off by an inference about the TICKET, on artefacts that plainly do have a
 * build. Measured on `broken-build`: NOT APPLICABLE, and the run's failure list
 * showed nothing at all where the build gate should have been.
 *
 * The absence is now corroborated against the artefact. No evidence of a build
 * step: `not_applicable`, as before, and the detail names what was searched for
 * so the absence can be audited. Evidence of a build step: `unknown`, which is
 * not a pass and appears in the failure list carrying its own reason — the gate
 * did not run, and nothing may read that as the artefact having built.
 *
 * IT IS DELIBERATELY NOT `fail`. The gate compiled nothing; "this artefact does
 * not build" is a claim it has not earned, and a gate that reports a conclusion
 * it did not measure is the defect this whole change exists to remove.
 */
function absentBuildVerdict(artifactDir: string, walkedFiles: readonly WalkedFile[]): AbsentVerdict {
  const evidence = detectBuildEvidence(artifactDir, walkedFiles);
  if (evidence.found.length === 0) {
    return {
      outcome: "not_applicable",
      detail:
        "the frozen manifest declares no build step, and the artefact agrees: searched for " +
        `${evidence.searchedFor.join("; ")} across ${walkedFiles.length} walked file(s) and found none. ` +
        "A hand-written static site has nothing to build, which is the common case for this harness.",
    };
  }
  return {
    outcome: "unknown",
    detail:
      "THE BUILD GATE WAS NEVER EVALUATED, and this is not a pass. The frozen manifest declares no build " +
      `step, but the artefact contradicts that declaration: ${evidence.found.slice(0, 10).join("; ")}` +
      `${evidence.found.length > 10 ? ` (+${evidence.found.length - 10} more)` : ""}. ` +
      "Nothing was compiled, so nothing here says the artefact builds. Either the suite's manifest is " +
      "wrong for this ticket (the spec seat inferred a static site and the builder shipped a compiled " +
      "one), or the artefact ships sources it never built. Both need a human; neither is a green build.",
  };
}

/* -------------------------------------------------------------------------
 * Phase 2 — build, typecheck, lint
 * ---------------------------------------------------------------------- */

/** What a gate reports when the frozen manifest declared its command absent. */
interface AbsentVerdict {
  readonly outcome: GateOutcome;
  readonly detail: string;
}

async function runCommandGate(
  id: string,
  name: string,
  command: string | null,
  absent: AbsentVerdict,
  cwd: string,
  timeoutMs: number,
  plan: ScorerPlan,
): Promise<Tier0GateResult> {
  if (command === null) {
    return gate(id, name, absent.outcome, absent.detail, 0, null, null);
  }
  const result = await runCommand(command, cwd, timeoutMs, plan.limits.capturedOutputChars, artifactEnv(null));
  const ok = result.exitCode === 0 && !result.timedOut;
  return gate(
    id,
    name,
    ok ? "pass" : "fail",
    ok
      ? `exit 0 in ${result.durationMs} ms`
      : `${result.timedOut ? `killed on the ${timeoutMs} ms boundary` : `exit ${result.exitCode}`}; output tail: ` +
        truncate(result.outputTail, 4_000),
    result.durationMs,
    command,
    result.exitCode,
  );
}

/* -------------------------------------------------------------------------
 * Phase 3 — boot and routes
 * ---------------------------------------------------------------------- */

interface BootOutput {
  readonly gates: readonly Tier0GateResult[];
  readonly origin: string | null;
  /** The artefact's own server process. Null in static mode and on failure. */
  readonly server: StartedProcess | null;
  /** The scorer's own static server. Null in server mode and on failure. */
  readonly staticServer: StaticServer | null;
}

/**
 * Make the artefact reachable, one of two ways.
 *
 * SERVER MODE runs the declared start command and polls the declared health
 * path. STATIC MODE (owner decision D2) starts the scorer's own pre-baked
 * static server over the artefact directory and asserts the root document.
 *
 * The gate id is `GATE:boot` in both modes, deliberately. It answers one
 * question — "was the deliverable actually reachable and real?" — and keeping
 * one id means the BLOCKING set is identical for every ticket, so a static
 * ticket and a server ticket produce comparable score records. What must NEVER
 * happen is `not_applicable`: `gateToCriterion` maps that to `passed: true`, so
 * a static artefact would sail through a gate that checked nothing, which is
 * precisely the silent degradation D2 exists to prevent.
 */
async function bootApp(plan: ScorerPlan, manifest: SuiteManifest): Promise<BootOutput> {
  const startedAt = Date.now();
  const execution = resolveExecutionPlan(manifest.execution);

  if (execution.mode === "static") {
    let staticServer: StaticServer;
    try {
      staticServer = await startStaticServer(CONTAINER_PATHS.artifact, execution.port);
    } catch (error) {
      return {
        gates: [
          gate(
            GATE_IDS.boot,
            "the static artefact is served and its root document is real",
            "fail",
            `the scorer's own static server could not bind 127.0.0.1:${execution.port} inside the sealed ` +
              `container: ${redactText(error instanceof Error ? error.message : String(error)).text}`,
            Date.now() - startedAt,
            null,
            null,
          ),
        ],
        origin: null,
        server: null,
        staticServer: null,
      };
    }

    const probe = await probeStaticRoot(staticServer.origin, execution.rootDocument, execution.bootTimeoutMs);
    if (!probe.ok) {
      await staticServer.close();
      return {
        gates: [
          gate(
            GATE_IDS.boot,
            "the static artefact is served and its root document is real",
            "fail",
            `the frozen manifest declares no start command, so the artefact directory was served over ` +
              `${staticServer.origin} by the scorer's own pre-baked static server (no network was used: ` +
              `egress is denied at scoring time). The root document ${execution.rootDocument} did not ` +
              `answer HTTP 200 with a non-empty body after ${probe.attempts} attempt(s) in ` +
              `${probe.waitedMs} ms. Problem: ${probe.problem ?? "unknown"}. A blank or missing root ` +
              "document is a failure, never a skip.",
            Date.now() - startedAt,
            null,
            null,
          ),
        ],
        origin: null,
        server: null,
        staticServer: null,
      };
    }

    return {
      gates: [
        gate(
          GATE_IDS.boot,
          "the static artefact is served and its root document is real",
          "pass",
          `static mode: the frozen manifest declares no start command, so the artefact directory was ` +
            `served over ${staticServer.origin} by the scorer's own pre-baked static server. ` +
            `${execution.rootDocument} answered HTTP 200 with ${probe.bodyBytes ?? 0} non-blank byte(s) ` +
            `after ${probe.waitedMs} ms.`,
          Date.now() - startedAt,
          null,
          null,
        ),
      ],
      origin: staticServer.origin,
      server: null,
      staticServer,
    };
  }

  const server = startProcess(
    execution.start,
    CONTAINER_PATHS.artifact,
    plan.limits.capturedOutputChars,
    artifactEnv(null),
  );
  const probe = await probeHealth(execution.port, execution.healthPath, execution.bootTimeoutMs);

  if (!probe.reachable) {
    server.stop();
    return {
      gates: [
        gate(
          GATE_IDS.boot,
          "app boots and answers a health check",
          "fail",
          `no loopback origin answered ${execution.healthPath} within ` +
            `${execution.bootTimeoutMs} ms after ${probe.attempts} attempt(s). ` +
            `Last problem: ${probe.problem ?? "unknown"}. Probed ${loopbackOrigins(execution.port).join(" and ")} ` +
            `(127.0.0.1 literally, never "localhost": the container has only a loopback interface). ` +
            `Server output tail: ${truncate(server.outputTail(), 4_000)}`,
          Date.now() - startedAt,
          execution.start,
          null,
        ),
      ],
      origin: null,
      server: null,
      staticServer: null,
    };
  }

  return {
    gates: [
      gate(
        GATE_IDS.boot,
        "app boots and answers a health check",
        "pass",
        `${probe.origin ?? ""}${execution.healthPath} answered HTTP ${probe.status ?? 0} ` +
          `after ${probe.waitedMs} ms`,
        Date.now() - startedAt,
        execution.start,
        null,
      ),
    ],
    origin: probe.origin,
    server,
    staticServer: null,
  };
}

async function checkRoutes(origin: string, flows: readonly ManifestUiFlow[]): Promise<Tier0GateResult> {
  const startedAt = Date.now();
  if (flows.length === 0) {
    return gate(
      GATE_IDS.routes,
      "every declared route answers non-5xx",
      "not_applicable",
      "the frozen manifest declares no UI flows",
      0,
      null,
      null,
    );
  }

  const failures: string[] = [];
  for (const flow of flows) {
    try {
      const response = await fetch(`${origin}${flow.path}`, { signal: AbortSignal.timeout(30_000) });
      if (response.status >= 500) failures.push(`${flow.id} ${flow.path} -> HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${flow.id} ${flow.path} -> ${redactText(error instanceof Error ? error.message : String(error)).text}`);
    }
  }

  return gate(
    GATE_IDS.routes,
    "every declared route answers non-5xx",
    failures.length === 0 ? "pass" : "fail",
    failures.length === 0
      ? `${flows.length} declared route(s) answered non-5xx`
      : `${failures.length} of ${flows.length} route(s) failed: ${failures.slice(0, 20).join("; ")}`,
    Date.now() - startedAt,
    null,
    null,
  );
}

/* -------------------------------------------------------------------------
 * Phase 4 — masked screenshot capture and DOM observations
 * ---------------------------------------------------------------------- */

interface CaptureOutput {
  readonly gate: Tier0GateResult;
  readonly screenshots: readonly ScreenshotRecord[];
  readonly domFindings: readonly DomFinding[];
  readonly infrastructureErrors: readonly string[];
}

interface PageObservations {
  readonly brokenImages: readonly string[];
  readonly horizontalOverflow: boolean;
  readonly bodyFontFamily: string;
  readonly placeholders: readonly string[];
}

async function captureFlows(plan: ScorerPlan, manifest: SuiteManifest, origin: string): Promise<CaptureOutput> {
  const startedAt = Date.now();
  const screenshots: ScreenshotRecord[] = [];
  const domFindings: DomFinding[] = [];
  const infrastructureErrors: string[] = [];

  if (manifest.uiFlows.length === 0) {
    return {
      gate: gate(
        GATE_IDS.screenshotsPresent,
        "a masked, non-blank screenshot exists for every declared flow",
        "not_applicable",
        "the frozen manifest declares no UI flows",
        0,
        null,
        null,
      ),
      screenshots,
      domFindings,
      infrastructureErrors,
    };
  }

  mkdirSync(CONTAINER_PATHS.screenshots, { recursive: true });

  const { chromium } = await import("@playwright/test");
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({
      // The CONTAINER is the sandbox: --network=none, --read-only rootfs, all
      // capabilities dropped, no-new-privileges. Chromium's own setuid sandbox
      // cannot start without those capabilities, so it is disabled rather than
      // left to fail at launch. --disable-dev-shm-usage avoids the 64 MB
      // default /dev/shm crash that looks like a flaky app but is not.
      chromiumSandbox: false,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
    });
  } catch (error) {
    return {
      gate: gate(
        GATE_IDS.screenshotsPresent,
        "a masked, non-blank screenshot exists for every declared flow",
        "fail",
        "the browser could not be launched; see infrastructureErrors",
        Date.now() - startedAt,
        null,
        null,
      ),
      screenshots,
      domFindings,
      infrastructureErrors: [
        `chromium.launch failed: ${redactText(error instanceof Error ? error.message : String(error)).text}`,
      ],
    };
  }

  try {
    for (const breakpoint of plan.breakpoints) {
      const context = await browser.newContext({
        viewport: { width: breakpoint.width, height: breakpoint.height },
        // A fixed, reproducible rendering environment: held-constant variable 3
        // covers the sandbox image, and a drifting locale or timezone would put
        // noise straight into the screenshot diff.
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "reduce",
      });

      for (const flow of manifest.uiFlows) {
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const sameOriginFailures: string[] = [];
        const sealedNetworkBlocks = new Set<string>();

        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(truncate(message.text(), 300));
        });
        page.on("pageerror", (error) => pageErrors.push(truncate(error.message, 300)));
        page.on("requestfailed", (request) => {
          const url = request.url();
          if (url.startsWith(origin)) {
            sameOriginFailures.push(`${request.resourceType()} ${truncate(url, 200)}`);
          } else {
            try {
              sealedNetworkBlocks.add(new URL(url).host);
            } catch {
              sealedNetworkBlocks.add("(unparseable url)");
            }
          }
        });

        try {
          await page.goto(`${origin}${flow.path}`, { waitUntil: "load", timeout: 60_000 });
          if (flow.waitForSelector !== null) {
            await page.locator(flow.waitForSelector).first().waitFor({ state: "visible", timeout: 30_000 });
          }
          await page.waitForTimeout(750); // settle: fonts, late layout, hydration

          const file = `${flow.id}__${breakpoint.label}.png`;
          const absolute = join(CONTAINER_PATHS.screenshots, file);

          // MASKING IS APPLIED HERE, AT CAPTURE TIME, AND NOWHERE ELSE.
          // doc 02 section 1.6: "regex cannot read pixels". A secret rendered
          // into a PNG is in that PNG permanently, so there is no code path in
          // this program that writes an unmasked capture and scrubs it later.
          await page.screenshot({
            path: absolute,
            mask: plan.maskSelectors.map((selector) => page.locator(selector)),
            maskColor: plan.maskColor,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });

          const bytes = readFileSync(absolute);
          screenshots.push({
            flowId: flow.id,
            breakpoint: breakpoint.label,
            file,
            bytes: bytes.byteLength,
            width: breakpoint.width,
            height: breakpoint.height,
            sha256: sha256Hex(bytes),
            maskedSelectors: plan.maskSelectors,
            maskColor: plan.maskColor,
            nonBlank: bytes.byteLength >= plan.minScreenshotBytes,
          });

          const observations = (await page.evaluate(() => {
            const body = document.body;
            const broken = Array.from(document.images)
              .filter((image) => image.complete && image.naturalWidth === 0)
              .map((image) => image.currentSrc || image.src)
              .slice(0, 10);
            const text = (body.innerText ?? "").slice(0, 200_000);
            const placeholders: string[] = [];
            if (/lorem ipsum/i.test(text)) placeholders.push("lorem ipsum");
            if (text.includes("[object Object]")) placeholders.push("[object Object]");
            if (/\bundefined\b/.test(text)) placeholders.push("undefined");
            if (/\bNaN\b/.test(text)) placeholders.push("NaN");
            return {
              brokenImages: broken,
              horizontalOverflow: body.scrollWidth > body.clientWidth + 1,
              bodyFontFamily: getComputedStyle(body).fontFamily,
              placeholders,
            };
          })) as PageObservations;

          const add = (kind: DomFinding["kind"], detail: string): void => {
            domFindings.push({ kind, flowId: flow.id, breakpoint: breakpoint.label, detail: redactText(detail).text });
          };
          for (const message of consoleErrors.slice(0, 10)) add("console_error", message);
          for (const message of pageErrors.slice(0, 10)) add("unhandled_rejection", message);
          for (const failure of sameOriginFailures.slice(0, 10)) add("same_origin_request_failed", failure);
          if (sealedNetworkBlocks.size > 0) {
            add(
              "sealed_network_request_blocked",
              `the page requested ${sealedNetworkBlocks.size} external host(s) that the sealed network policy ` +
                `denies: ${[...sealedNetworkBlocks].slice(0, 10).join(", ")}. Expected under --network=none and ` +
                "recorded separately so it is never mistaken for an application defect.",
            );
          }
          for (const source of observations.brokenImages) add("image_natural_width_zero", truncate(source, 200));
          if (observations.horizontalOverflow) {
            add("horizontal_overflow", "document.body.scrollWidth exceeds clientWidth");
          }
          if (/^\s*(?:serif|"?Times New Roman"?)\s*$/i.test(observations.bodyFontFamily)) {
            add(
              "default_serif_font",
              `body font-family resolves to ${observations.bodyFontFamily} — the signature of a stylesheet ` +
                "that never loaded",
            );
          }
          for (const placeholder of observations.placeholders) {
            add("placeholder_text", `rendered text contains ${JSON.stringify(placeholder)}`);
          }
        } catch (error) {
          infrastructureErrors.push(
            `flow ${flow.id} at ${breakpoint.label}: ` +
              redactText(error instanceof Error ? error.message : String(error)).text,
          );
        } finally {
          await page.close().catch(() => undefined);
        }
      }
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const expected = manifest.uiFlows.length * plan.breakpoints.length;
  const usable = screenshots.filter((s) => s.nonBlank);
  const flowsWithUsable = new Set(usable.map((s) => s.flowId));
  const missingFlows = manifest.uiFlows.filter((f) => !flowsWithUsable.has(f.id)).map((f) => f.id);

  return {
    gate: gate(
      GATE_IDS.screenshotsPresent,
      "a masked, non-blank screenshot exists for every declared flow",
      missingFlows.length === 0 ? "pass" : "fail",
      `${usable.length} usable of ${screenshots.length} captured (${expected} expected); ` +
        `blank floor ${plan.minScreenshotBytes} bytes` +
        (missingFlows.length === 0 ? "" : `; no usable capture for flow(s): ${missingFlows.join(", ")}`),
      Date.now() - startedAt,
      null,
      null,
    ),
    screenshots,
    domFindings,
    infrastructureErrors,
  };
}

/* -------------------------------------------------------------------------
 * Phase 5 — data expectations
 * ---------------------------------------------------------------------- */

async function checkDataExpectations(
  expectations: readonly ManifestDataExpectation[],
  origin: string | null,
): Promise<Tier0GateResult> {
  const startedAt = Date.now();
  if (expectations.length === 0) {
    return gate(
      GATE_IDS.dataPresent,
      "expected tables exist with non-zero rows",
      "not_applicable",
      "the frozen suite declares no data expectations, i.e. the spec agent judged that this ticket " +
        "implies no persisted data. This is a declaration by the suite, never an inference from the artefact.",
      0,
      null,
      null,
    );
  }

  const results: DataExpectationResult[] = [];
  for (const expectation of expectations) {
    if (expectation.kind === "sqlite" && expectation.file !== null) {
      results.push(
        await evaluateSqliteExpectation(
          CONTAINER_PATHS.artifact,
          expectation.id,
          expectation.file,
          expectation.table,
          expectation.sql,
          expectation.minRows,
        ),
      );
    } else if (expectation.kind === "http" && expectation.path !== null) {
      if (origin === null) {
        results.push({
          id: expectation.id,
          satisfied: false,
          observedRows: null,
          detail: "the app never booted, so an http data expectation could not be evaluated; it FAILS rather than skips",
        });
      } else {
        results.push(await evaluateHttpExpectation(origin, expectation.id, expectation.path, expectation.minRows));
      }
    } else {
      results.push({
        id: expectation.id,
        satisfied: false,
        observedRows: null,
        detail: `data expectation kind ${JSON.stringify(expectation.kind)} is not evaluable with the fields supplied`,
      });
    }
  }

  const failed = results.filter((r) => !r.satisfied);
  return gate(
    GATE_IDS.dataPresent,
    "expected tables exist with non-zero rows",
    failed.length === 0 ? "pass" : "fail",
    results.map((r) => `${r.id}: ${r.detail}`).join(" | "),
    Date.now() - startedAt,
    null,
    null,
  );
}

/* -------------------------------------------------------------------------
 * Phase 6 — the frozen suite
 * ---------------------------------------------------------------------- */

/**
 * The two runners the frozen suite may be written for.
 *
 * `RUNNER_SUFFIX` in ../src/spec-types.ts is the single source of the mapping:
 * `.test.mjs` is node:test, `.spec.mjs` is Playwright. It is restated here as a
 * literal rather than imported because this program runs inside the sealed
 * image and must not pull the spec-authoring module (and its dependencies) into
 * the container; {@link SUITE_FILE_SUFFIX} and that constant are checked against
 * each other by the scorer fixture, not by the type system.
 */
type SuiteRunner = "playwright" | "node-test";

const SUITE_FILE_SUFFIX: Readonly<Record<SuiteRunner, string>> = Object.freeze({
  "node-test": ".test.mjs",
  playwright: ".spec.mjs",
});

/** The NDJSON reporter this image runs `node --test` under. See docker/node-test-reporter.mjs. */
const NODE_TEST_REPORTER = `${SCORER_HOME}/node-test-reporter.mjs`;

/**
 * Paths this program is willing to interpolate into a shell command line.
 *
 * The frozen suite is adversarially-authored content. Its basenames are already
 * constrained by the freeze validator, but a shell command built from a path is
 * an injection site regardless of who is expected to have written it, and the
 * cost of being wrong here is arbitrary code inside the gate.
 */
const SHELL_SAFE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

interface SuiteOutcome {
  readonly gate: Tier0GateResult;
  readonly execution: SuiteExecutionRaw;
  readonly coverage: readonly CriterionCoverage[];
  /**
   * Scorer-side failures discovered while running the suite — chiefly a frozen
   * test file that NEITHER runner collected. Merged into
   * `ContainerResult.infrastructureErrors` by the caller so the host reads them
   * as the harness's fault rather than the artefact's.
   */
  readonly infrastructureErrors: readonly string[];
}

interface ParsedSpec {
  readonly runner: SuiteRunner;
  readonly titlePath: string;
  readonly ok: boolean;
  readonly statuses: readonly string[];
}

interface ParsedReport {
  readonly specs: readonly ParsedSpec[];
  readonly testsTotal: number | null;
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
  readonly problem: string | null;
  /**
   * Absolute paths of frozen suite files that reported AT LEAST ONE test.
   *
   * This is the evidence for the collection check. A file that produced no
   * entry here was not run by this runner — whether because the glob missed it,
   * because its imports did not resolve, or because it contains no tests at
   * all. All three are indistinguishable from the outside and all three are
   * failures.
   */
  readonly filesReported: readonly string[];
}

/** Suite-relative display path. Absolute container paths mean nothing to a reader. */
function suiteRelative(suiteDir: string, file: string): string {
  const rel = relative(suiteDir, file);
  return rel.length === 0 || rel.startsWith("..") ? file : rel;
}

function emptyReport(): ParsedReport {
  return { specs: [], testsTotal: 0, testsPassed: 0, testsFailed: 0, problem: null, filesReported: [] };
}

function parsePlaywrightReport(path: string, suiteDir: string): ParsedReport {
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (error) {
    return {
      specs: [],
      testsTotal: null,
      testsPassed: null,
      testsFailed: null,
      problem: `no machine-readable report at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      filesReported: [],
    };
  }
  if (raw === null || typeof raw !== "object") {
    return {
      specs: [],
      testsTotal: null,
      testsPassed: null,
      testsFailed: null,
      problem: "report root is not an object",
      filesReported: [],
    };
  }

  const root = raw as Record<string, unknown>;
  const specs: ParsedSpec[] = [];
  const filesReported = new Set<string>();

  // Playwright reports `spec.file` relative to `config.rootDir`, which is the
  // directory holding the CONFIG (this image's /opt/bakeoff-scorer), not the
  // testDir. Resolving against the report's own rootDir rather than assuming
  // one keeps the collection check correct if either ever moves.
  const config = root["config"];
  const rootDir =
    config !== null && typeof config === "object" && typeof (config as Record<string, unknown>)["rootDir"] === "string"
      ? ((config as Record<string, unknown>)["rootDir"] as string)
      : suiteDir;

  const visitSuite = (node: unknown, ancestors: readonly string[]): void => {
    if (node === null || typeof node !== "object") return;
    const suite = node as Record<string, unknown>;
    const title = typeof suite["title"] === "string" ? (suite["title"] as string) : "";
    const path = title.length > 0 ? [...ancestors, title] : [...ancestors];

    const specList = suite["specs"];
    if (Array.isArray(specList)) {
      for (const entry of specList) {
        if (entry === null || typeof entry !== "object") continue;
        const spec = entry as Record<string, unknown>;
        const specTitle = typeof spec["title"] === "string" ? (spec["title"] as string) : "";
        const specFile = typeof spec["file"] === "string" ? (spec["file"] as string) : null;
        if (specFile !== null) filesReported.add(resolve(rootDir, specFile));
        const tests = Array.isArray(spec["tests"]) ? (spec["tests"] as readonly unknown[]) : [];
        const statuses = tests.map((t) =>
          t !== null && typeof t === "object" && typeof (t as Record<string, unknown>)["status"] === "string"
            ? ((t as Record<string, unknown>)["status"] as string)
            : "unknown",
        );
        specs.push({
          runner: "playwright",
          titlePath: [...path, specTitle].join(TITLE_PATH_SEPARATOR),
          // A SKIPPED TEST IS NOT EVIDENCE. Playwright sets `spec.ok` on a
          // skipped spec, so `ok` alone would let a `test.skip` satisfy a
          // criterion — the same "absence of evidence read as satisfaction"
          // this file refuses everywhere else. The bad-test audit rejects
          // `.skip` before the freeze; this is the runtime backstop, and it is
          // written identically for the node:test pass below.
          ok: spec["ok"] === true && statuses.length > 0 && statuses.every((status) => status !== "skipped"),
          statuses,
        });
      }
    }

    const children = suite["suites"];
    if (Array.isArray(children)) for (const child of children) visitSuite(child, path);
  };

  const topLevel = root["suites"];
  if (Array.isArray(topLevel)) for (const suite of topLevel) visitSuite(suite, []);

  const stats = root["stats"];
  if (stats === null || typeof stats !== "object") {
    return {
      specs,
      testsTotal: null,
      testsPassed: null,
      testsFailed: null,
      problem: "the report carries no stats block, so pass/fail counts are unknown",
      filesReported: [...filesReported],
    };
  }
  const s = stats as Record<string, unknown>;
  const num = (key: string): number => (typeof s[key] === "number" ? (s[key] as number) : 0);
  const expected = num("expected");
  const unexpected = num("unexpected");
  const flaky = num("flaky");
  const skipped = num("skipped");

  return {
    specs,
    testsTotal: expected + unexpected + flaky + skipped,
    testsPassed: expected,
    testsFailed: unexpected,
    problem: null,
    filesReported: [...filesReported],
  };
}

/**
 * Parse the NDJSON written by docker/node-test-reporter.mjs.
 *
 * Every disagreement between the stream and itself is recorded as a `problem`
 * rather than smoothed over. A node:test pass that "mostly" parsed is a pass
 * that mostly gates, and this whole second runner exists because a runner that
 * silently produced no attributable outcome cost the harness a campaign.
 */
function parseNodeTestReport(path: string, suiteDir: string): ParsedReport {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      specs: [],
      testsTotal: null,
      testsPassed: null,
      testsFailed: null,
      problem:
        `no machine-readable node:test report at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      filesReported: [],
    };
  }

  const problems: string[] = [];
  const specs: ParsedSpec[] = [];
  const leafOutcomes = new Map<string, number>();
  const summaries = new Map<string, { tests: number; passed: number; failed: number; skipped: number; todo: number }>();

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) continue;

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      problems.push(`line ${index + 1} of the node:test report is not JSON`);
      continue;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      problems.push(`line ${index + 1} of the node:test report is not a JSON object`);
      continue;
    }
    const r = record as Record<string, unknown>;
    const kind = r["kind"];

    if (kind === "parse-error") {
      problems.push(typeof r["detail"] === "string" ? (r["detail"] as string) : "the node:test reporter failed");
      continue;
    }

    const file = typeof r["file"] === "string" ? resolve(r["file"] as string) : null;

    if (kind === "summary") {
      // The FINAL summary carries no file. Only the per-file summaries are used:
      // the final one additionally counts the synthetic file-level entry node
      // reports for a file that collected nothing, which would inflate the total
      // by exactly the files this pass is meant to flag.
      if (file === null) continue;
      const counts = r["counts"];
      if (counts === null || typeof counts !== "object") {
        problems.push(`the node:test summary for ${suiteRelative(suiteDir, file)} carried no counts`);
        continue;
      }
      const c = counts as Record<string, unknown>;
      const num = (key: string): number =>
        typeof c[key] === "number" && Number.isFinite(c[key]) ? (c[key] as number) : 0;
      summaries.set(file, {
        tests: num("tests"),
        passed: num("passed"),
        failed: num("failed"),
        skipped: num("skipped"),
        todo: num("todo"),
      });
      continue;
    }

    if (kind !== "test") continue;
    if (file === null) {
      problems.push(`a node:test outcome on line ${index + 1} carried no file and cannot be attributed`);
      continue;
    }

    const rawPath = Array.isArray(r["titlePath"])
      ? (r["titlePath"] as readonly unknown[]).map((value) => (typeof value === "string" ? value : ""))
      : [];
    const nesting = typeof r["nesting"] === "number" && Number.isFinite(r["nesting"]) ? (r["nesting"] as number) : 0;

    // Node reports a synthetic top-level entry NAMED AFTER THE FILE when a file
    // produced no tests of its own (an empty file, or one whose imports threw).
    // It is not a test and must not become one; the missing per-file summary is
    // what actually reports that file, below.
    const only = rawPath.length === 1 ? (rawPath[0] ?? "") : "";
    if (nesting === 0 && rawPath.length === 1 && (only === file || only === basename(file))) continue;

    // A `describe()` block reports its own aggregate outcome. Its title is
    // already part of every child's title path, so counting it again would
    // double-attribute the criterion its children assert.
    if (r["entity"] === "suite") continue;

    const skip = r["skip"] === true;
    const todo = r["todo"] === true;
    const passed = r["outcome"] === "pass";
    leafOutcomes.set(file, (leafOutcomes.get(file) ?? 0) + 1);
    specs.push({
      runner: "node-test",
      // The suite-relative file path leads the title path, exactly as Playwright's
      // top-level suite title is the file. One shape, one attribution rule.
      titlePath: [suiteRelative(suiteDir, file), ...rawPath].join(TITLE_PATH_SEPARATOR),
      // Node reports a skipped test as a PASS. It is not evidence — same rule as
      // the Playwright branch above.
      ok: passed && !skip && !todo,
      statuses: [skip ? "skipped" : todo ? "todo" : passed ? "passed" : "failed"],
    });
  }

  // Self-check: the reporter's own per-file summary must agree with the number of
  // leaf outcomes it emitted for that file. A disagreement means the event stream
  // was truncated or the wrapper-detection above dropped a real test — either way
  // the counts cannot be trusted, and saying so is the only honest option.
  for (const [file, counts] of summaries) {
    const leaves = leafOutcomes.get(file) ?? 0;
    if (leaves !== counts.tests) {
      problems.push(
        `the node:test reporter emitted ${leaves} test outcome(s) for ${suiteRelative(suiteDir, file)} ` +
          `but its summary counts ${counts.tests}`,
      );
    }
  }

  let testsTotal = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  const filesReported: string[] = [];
  for (const [file, counts] of summaries) {
    testsTotal += counts.tests;
    testsPassed += counts.passed;
    testsFailed += counts.failed;
    if (counts.tests > 0) filesReported.push(file);
  }

  return {
    specs,
    testsTotal,
    testsPassed,
    testsFailed,
    problem: problems.length === 0 ? null : problems.slice(0, 10).join(" | "),
    filesReported,
  };
}

/**
 * Attribute frozen tests to frozen criteria.
 *
 * Convention: a test's title path contains the criterion id as a whole token,
 * e.g. `test("[REQ-014] booking persists", ...)`. A criterion no test mentions is
 * `unasserted`, which is a FAILURE — absence of evidence is not evidence of
 * satisfaction, and an unasserted criterion is precisely the vacuous criterion
 * the adversarial bad-test audit exists to catch before any build starts.
 *
 * ONE RULE, BOTH RUNNERS. `report` is the MERGED outcome set: Playwright specs
 * and node:test outcomes, each carrying a title path that begins with its
 * suite-relative file. The token rule is applied to that merged set unchanged.
 * Applying two rules, or applying one rule to one runner's output, is how a
 * whole class of criteria came back `unasserted` in every configuration and read
 * as a model result (STATUS.md blocker 1.1).
 */
function attributeCriteria(plan: ScorerPlan, report: ParsedReport): readonly CriterionCoverage[] {
  const perRunner = (runner: SuiteRunner): number => report.specs.filter((spec) => spec.runner === runner).length;
  const census =
    `the merged outcome set holds ${report.specs.length} test(s): ` +
    `${perRunner("playwright")} from Playwright, ${perRunner("node-test")} from node:test`;

  return plan.criteria.map((criterion) => {
    const escaped = criterion.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
    const matching = report.specs.filter((spec) => token.test(spec.titlePath));

    if (matching.length === 0) {
      return {
        criterionId: criterion.id,
        tier: criterion.tier,
        outcome: "unasserted" as const,
        testRefs: [],
        detail:
          `no test in the frozen suite carries the token "${criterion.id}" in its title path. ` +
          `Required evidence was: ${truncate(criterion.evidenceRequired, 300)}. ` +
          // The census is the difference between "the model did not satisfy this"
          // and "a runner never ran". Both produce `unasserted`; only one is a
          // model result, and the reader must be able to tell them apart.
          `For triage: ${census}.`,
      };
    }

    const failing = matching.filter((spec) => !spec.ok);
    return {
      criterionId: criterion.id,
      tier: criterion.tier,
      outcome: failing.length === 0 ? ("passed" as const) : ("failed" as const),
      testRefs: matching.slice(0, 10).map((spec) => truncate(spec.titlePath, 200)),
      detail:
        failing.length === 0
          ? `${matching.length} test(s) asserted this criterion and all passed`
          : `${failing.length} of ${matching.length} asserting test(s) failed: ` +
            failing
              .slice(0, 5)
              .map((spec) => `${truncate(spec.titlePath, 160)} [${spec.statuses.join(",")}]`)
              .join("; "),
    };
  });
}

/* ---- file inventory --------------------------------------------------- */

interface SuiteInventory {
  /** Every frozen file that must be collected by SOME runner. Absolute, sorted. */
  readonly mustBeCollected: readonly string[];
  readonly playwright: readonly string[];
  readonly nodeTest: readonly string[];
  /** Files whose name matches neither runner's suffix. Collectible by nobody. */
  readonly unclaimed: readonly string[];
}

/**
 * Enumerate the frozen suite on disk and assign each file to a runner.
 *
 * EVERY file except `suite.manifest.json` must be collected. The freeze
 * validator already restricts a suite to `<holdout|visible>/<name>.test.mjs`,
 * `<holdout|visible>/<name>.spec.mjs` and that one manifest, so anything else
 * present is either a runner-less file the spec seat should never have written
 * or a file planted after the freeze — and the host's `verifySuiteIntact`
 * treats the second as tampering. Neither may be scored around silently.
 */
function inventorySuiteFiles(suiteDir: string): SuiteInventory {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Symlinks are deliberately not followed: the host's freeze check refuses
      // a suite containing one, so a symlink here means the seal already failed.
      if (!entry.isFile()) continue;
      if (entry.name === SUITE_MANIFEST_FILENAME) continue;
      files.push(resolve(full));
    }
  };
  walk(suiteDir);

  const playwright = files.filter((f) => f.endsWith(SUITE_FILE_SUFFIX.playwright));
  const nodeTest = files.filter((f) => f.endsWith(SUITE_FILE_SUFFIX["node-test"]));
  const claimed = new Set([...playwright, ...nodeTest]);
  return {
    mustBeCollected: files,
    playwright,
    nodeTest,
    unclaimed: files.filter((f) => !claimed.has(f)),
  };
}

/* ---- one runner's pass ------------------------------------------------- */

interface RunnerPass {
  readonly runner: SuiteRunner;
  readonly files: readonly string[];
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outputTail: string;
  readonly report: ParsedReport;
}

/**
 * A runner with no files to run.
 *
 * NOT A FAILURE, and deliberately not `null` either. A ticket whose criteria are
 * all UI flows has no node:test file; a ticket that is pure API has no spec. The
 * merged total is what must be non-zero — enforced in {@link runFrozenSuite} —
 * so an individual empty pass reports zero tests, zero failures and no problem.
 */
function unusedPass(runner: SuiteRunner): RunnerPass {
  return {
    runner,
    files: [],
    command: null,
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    outputTail: "",
    report: emptyReport(),
  };
}

/** A runner that had files and no time left. A gate that did not run has not passed. */
function starvedPass(runner: SuiteRunner, files: readonly string[]): RunnerPass {
  return {
    runner,
    files,
    command: null,
    exitCode: -1,
    durationMs: 0,
    timedOut: true,
    outputTail: "",
    report: {
      specs: [],
      testsTotal: null,
      testsPassed: null,
      testsFailed: null,
      problem:
        `the ${runner} pass had ${files.length} frozen file(s) to run and no suite budget left. ` +
        "Recorded as a failure, never as a skip.",
      filesReported: [],
    },
  };
}

/**
 * Environment for both suite runners.
 *
 * `BAKEOFF_APP_ORIGIN` is the documented name and the one docker/playwright.config.mjs
 * reads for `baseURL`. `APP_BASE_URL` is set to the same value because the spec
 * seat is instructed (AUTHORING_SYSTEM_PROMPT in ../src/spec-agent.ts) to read the
 * base URL "from an environment variable with an explicit, documented default",
 * and every fixture in this tree uses that name. Two names, both pointing at the
 * loopback origin that actually answered the health probe — never a guess at a
 * port, and never five speculative aliases.
 */
function suiteEnv(origin: string): NodeJS.ProcessEnv {
  const env = artifactEnv(origin);
  env["BAKEOFF_SUITE_DIR"] = CONTAINER_PATHS.suite;
  env["APP_BASE_URL"] = origin;
  return env;
}

async function runPlaywrightPass(
  plan: ScorerPlan,
  origin: string,
  timeoutMs: number,
  files: readonly string[],
  suiteDir: string,
): Promise<RunnerPass> {
  if (files.length === 0) return unusedPass("playwright");
  if (timeoutMs <= 0) return starvedPass("playwright", files);

  // The suite runs with THIS IMAGE's Playwright and THIS IMAGE's configuration.
  // The artefact's node_modules and any artefact-supplied runner config are not
  // on this path at all, which is what makes reporter tampering inert.
  // The reporter is NOT selected on the command line. `--reporter=json` writes
  // the report to stdout, where it would be interleaved with the application's
  // own output and would replace the human-readable reporter that makes a
  // failure triageable. The config pins the JSON reporter to an explicit
  // outputFile and keeps a line reporter for the stdout tail. The config's
  // `testMatch` is narrowed to `**/*.spec.mjs`, so this pass no longer collects
  // the node:test half.
  const command = `node ${SCORER_HOME}/node_modules/@playwright/test/cli.js test --config=${SUITE_PLAYWRIGHT_CONFIG}`;

  const env = suiteEnv(origin);
  env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = CONTAINER_PATHS.suiteReport;
  env["PLAYWRIGHT_BROWSERS_PATH"] = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "/ms-playwright";

  const result = await runCommand(command, SCORER_HOME, timeoutMs, plan.limits.capturedOutputChars, env);
  return {
    runner: "playwright",
    files,
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    outputTail: result.outputTail,
    report: parsePlaywrightReport(CONTAINER_PATHS.suiteReport, suiteDir),
  };
}

async function runNodeTestPass(
  plan: ScorerPlan,
  origin: string,
  timeoutMs: number,
  files: readonly string[],
  suiteDir: string,
): Promise<RunnerPass> {
  if (files.length === 0) return unusedPass("node-test");
  if (timeoutMs <= 0) return starvedPass("node-test", files);

  const unsafe = files.filter((file) => !SHELL_SAFE_PATH_RE.test(file));
  if (unsafe.length > 0) {
    return {
      runner: "node-test",
      files,
      command: null,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      outputTail: "",
      report: {
        specs: [],
        testsTotal: null,
        testsPassed: null,
        testsFailed: null,
        problem:
          `${unsafe.length} frozen file path(s) contain characters this program refuses to put on a ` +
          `command line: ${unsafe.map((f) => suiteRelative(suiteDir, f)).join(", ")}`,
        filesReported: [],
      },
    };
  }

  // FILES ARE NAMED EXPLICITLY rather than left to `node --test <dir>`.
  // Node's own default test-file globs include `**/test/**/*.mjs` and several
  // `*-test`/`test-*` shapes, so a directory argument would make "what this pass
  // collected" a property of node's glob rather than of the freeze. Naming the
  // files makes the collection check below exact: the set handed in and the set
  // that reported back must be the same set.
  //
  // --test-concurrency=1 is the counterpart of `workers: 1` in
  // docker/playwright.config.mjs. `node --test` runs each file in its own child
  // process and defaults to running several at once; every one of them talks to
  // the SAME loopback app, so held-constant variable 5 — the same suite deciding
  // the same way for every configuration — would depend on how that app behaves
  // under concurrent load. Observed with the flag: a two-file suite (one file
  // sleeping 2.1 s) emits each file's outcomes and its summary as an unbroken
  // group, and the per-file counts agree with the emitted outcomes. The
  // reporter keys ancestry per file regardless, so a future change to this flag
  // cannot splice one file's `describe()` title onto another file's test.
  //
  // Two reporters, same split as the Playwright config: the machine-readable one
  // to an explicit file, `spec` to stdout so a failure is triageable from the
  // captured output tail.
  const command =
    "node --test --test-concurrency=1 " +
    `--test-reporter=${NODE_TEST_REPORTER} --test-reporter-destination=${CONTAINER_PATHS.nodeTestReport} ` +
    "--test-reporter=spec --test-reporter-destination=stdout " +
    files.map((file) => `'${file}'`).join(" ");

  const result = await runCommand(command, SCORER_HOME, timeoutMs, plan.limits.capturedOutputChars, suiteEnv(origin));
  return {
    runner: "node-test",
    files,
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    outputTail: result.outputTail,
    report: parseNodeTestReport(CONTAINER_PATHS.nodeTestReport, suiteDir),
  };
}

/** One outcome set from both passes. Counts sum; problems concatenate; nothing is dropped. */
function mergeReports(passes: readonly RunnerPass[]): ParsedReport {
  const sum = (pick: (report: ParsedReport) => number | null): number | null => {
    let total = 0;
    let sawOne = false;
    for (const pass of passes) {
      const value = pick(pass.report);
      if (value !== null) {
        total += value;
        sawOne = true;
      }
    }
    return sawOne ? total : null;
  };
  const problems = passes
    .filter((pass) => pass.report.problem !== null)
    .map((pass) => `${pass.runner}: ${String(pass.report.problem)}`);

  return {
    specs: passes.flatMap((pass) => pass.report.specs),
    testsTotal: sum((r) => r.testsTotal),
    testsPassed: sum((r) => r.testsPassed),
    testsFailed: sum((r) => r.testsFailed),
    problem: problems.length === 0 ? null : problems.join(" | "),
    filesReported: passes.flatMap((pass) => pass.report.filesReported),
  };
}

/**
 * Run the frozen suite under BOTH runners and merge their outcomes.
 *
 * WHY TWO PASSES. `RUNNER_SUFFIX` lets the spec seat author `.test.mjs`
 * (node:test, for API/logic/persistence) and `.spec.mjs` (Playwright, for
 * browser flows). Until this change the container invoked Playwright only, and
 * Playwright's default `testMatch` collected `*.test.mjs` too — where an
 * imported `node:test` `test()` registers nothing. Those files ran, printed
 * ticks, and produced no attributable outcome, so every node:test criterion came
 * back `unasserted`, which fails. It does not error: it yields a complete,
 * plausible ScoreRecord with `heldOutPass: false` and `falseFinish: true` in
 * every configuration, which reads as five models shipping broken apps.
 * STATUS.md blocker 1.1; owner decision (a).
 *
 * BOTH PASSES ALWAYS RUN, and a pass with no files is not a failure — but the
 * MERGED set must contain at least one test, and every frozen file must have
 * been collected by exactly one of them.
 */
async function runFrozenSuite(plan: ScorerPlan, origin: string | null, timeoutMs: number): Promise<SuiteOutcome> {
  if (origin === null) {
    const execution: SuiteExecutionRaw = {
      exitCode: -1,
      durationMs: 0,
      testsTotal: null,
      testsPassed: null,
      testsFailed: null,
      timedOut: false,
      reportProblem: "the app never booted, so the frozen suite was not executed",
    };
    return {
      gate: gate(
        GATE_IDS.suiteGreen,
        "the frozen held-out suite goes green",
        "fail",
        "the app never booted, so the frozen suite could not run. Recorded as a suite failure, not as a skip.",
        0,
        null,
        null,
      ),
      execution,
      coverage: plan.criteria.map((criterion) => ({
        criterionId: criterion.id,
        tier: criterion.tier,
        outcome: "unasserted" as const,
        testRefs: [],
        detail: "the frozen suite was never executed because the app did not boot",
      })),
      infrastructureErrors: [],
    };
  }

  const suiteDir = CONTAINER_PATHS.suite;
  const inventory = inventorySuiteFiles(suiteDir);

  // node:test first: it is the cheaper pass, and Playwright then gets whatever
  // of the suite budget remains. Both boundaries bind; whichever binds first wins.
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => deadline - Date.now();
  const nodePass = await runNodeTestPass(plan, origin, Math.min(timeoutMs, remaining()), inventory.nodeTest, suiteDir);
  const playwrightPass = await runPlaywrightPass(plan, origin, remaining(), inventory.playwright, suiteDir);
  const passes: readonly RunnerPass[] = [nodePass, playwrightPass];
  const merged = mergeReports(passes);

  // ---- THE COLLECTION CHECK ---------------------------------------------
  //
  // A frozen file that NEITHER runner collected asserted nothing, and every
  // criterion that depended on it comes back `unasserted` — which is a model
  // failure everywhere it is read. That is exactly the silent-skip class that
  // cost this harness blocker 1.1, so it is a named, loud failure here: the
  // BLOCKING suite gate fails AND the file is reported as an infrastructure
  // error, because it is the harness's fault and not the artefact's.
  const reported = new Set(merged.filesReported);
  const uncollected = inventory.mustBeCollected.filter((file) => !reported.has(file));
  const infrastructureErrors: string[] = [];
  if (uncollected.length > 0) {
    const unclaimed = new Set(inventory.unclaimed);
    infrastructureErrors.push(
      `${uncollected.length} frozen suite file(s) were collected by NEITHER runner and therefore asserted ` +
        `NOTHING: ` +
        uncollected
          .slice(0, 20)
          .map(
            (file) =>
              `${suiteRelative(suiteDir, file)} (` +
              (unclaimed.has(file)
                ? `matches neither "${SUITE_FILE_SUFFIX["node-test"]}" nor "${SUITE_FILE_SUFFIX.playwright}", so no runner claims it`
                : `handed to ${file.endsWith(SUITE_FILE_SUFFIX["node-test"]) ? "node --test" : "Playwright"} and never reported back — an unresolved import, a syntax error, or a file with no tests in it`) +
              ")",
          )
          .join("; ") +
        ". THIS IS A SCORER FAULT, NOT A MODEL RESULT: it fails every criterion that file was written " +
        "to assert, identically in every configuration, which reads as a uniform model failure. Do not " +
        "record it as one — fix the runner invocation or the suite and re-score.",
    );
  }

  const ranPasses = passes.filter((pass) => pass.files.length > 0);
  const failingExit = ranPasses.find((pass) => pass.exitCode !== 0);
  const durationMs = passes.reduce((total, pass) => total + pass.durationMs, 0);

  const execution: SuiteExecutionRaw = {
    exitCode: failingExit?.exitCode ?? (ranPasses.length > 0 ? 0 : -1),
    durationMs,
    testsTotal: merged.testsTotal,
    testsPassed: merged.testsPassed,
    testsFailed: merged.testsFailed,
    timedOut: passes.some((pass) => pass.timedOut),
    reportProblem:
      infrastructureErrors.length === 0
        ? merged.problem
        : [merged.problem, infrastructureErrors[0]].filter((p) => p !== null && p !== undefined).join(" | "),
  };

  // ---- WHICH FAILURES GATE ------------------------------------------------
  //
  // PER PASS, because an exit code is per pass: one runner's crash may not be
  // excused by the other runner's excusable failures. `excusable` is true only
  // when every failure that pass reported is bound SOLELY to QUALITY criteria
  // AND the count the runner itself reported is fully attributed — see
  // `triageSuiteFailures`, which is where the QUALITY exception is defined and
  // where it is unit-tested.
  const triage = new Map<SuiteRunner, SuiteFailureTriage>(
    passes.map((pass) => [
      pass.runner,
      triageSuiteFailures(plan.criteria, pass.report.specs, pass.report.testsFailed),
    ]),
  );
  const excused = (pass: RunnerPass): boolean => triage.get(pass.runner)?.excusable === true;

  // Fails on a non-zero exit from either runner, on any failed test, on an
  // unparseable report, on a frozen file neither runner collected, AND on a
  // merged report that contains no tests at all. The last two matter most:
  // without them a suite that produced no report, or that collected zero tests
  // because its imports did not resolve, would gate nothing — criterion
  // attribution would silently find no tests and `computeHeldOutPass` reads only
  // criteria. An empty suite is the most dangerous possible state for a gate,
  // because it looks like success from every direction except this one.
  //
  // TWO of those seven conditions — and only two, the exit code and the failure
  // count — now admit `excused`, because those are the two a QUALITY-only test
  // failure moves. The other five are untouched and still unconditional: an
  // uncollected frozen file, a pass that never ran, a timeout, a report problem
  // and a zero-test suite all fail this gate whatever any criterion's tier says.
  // The failure count is read PER PASS here rather than from `merged`; that is
  // the same arithmetic while nothing is excused, since `merged.testsFailed` is
  // their sum and an unparseable count always arrives with `merged.problem` set.
  const green =
    uncollected.length === 0 &&
    ranPasses.length > 0 &&
    ranPasses.every((pass) => pass.exitCode === 0 || excused(pass)) &&
    !execution.timedOut &&
    merged.problem === null &&
    (merged.testsTotal ?? 0) > 0 &&
    ranPasses.every((pass) => (pass.report.testsFailed ?? 1) === 0 || excused(pass));

  // A gate that went green over a red test says so, in the detail an owner
  // reads. An unexplained green is indistinguishable from a broken gate.
  const excusedFailures = green ? passes.flatMap((pass) => triage.get(pass.runner)?.qualityOnly ?? []) : [];
  const excusedNote =
    excusedFailures.length === 0
      ? ""
      : ` — ${excusedFailures.length} failing test(s) bound SOLELY to QUALITY criteria did NOT fail this gate ` +
        `(doc 02 section 5.4: QUALITY is reported, never gating; they are reported as failed QUALITY criteria): ` +
        excusedFailures
          .slice(0, 5)
          .map((outcome) => truncate(outcome.titlePath, 160))
          .join("; ");

  const census = passes
    .map(
      (pass) =>
        `${pass.runner}: ${pass.files.length} file(s)` +
        (pass.files.length === 0
          ? " (nothing to run — not a failure)"
          : `, exit ${pass.exitCode === null ? "n/a" : String(pass.exitCode)}, ` +
            `${pass.report.testsPassed ?? 0}/${pass.report.testsTotal ?? 0} passed` +
            (pass.timedOut ? ", KILLED ON THE TIME BOUNDARY" : "")),
    )
    .join(" | ");

  const outputTails = passes
    .filter((pass) => pass.outputTail.length > 0)
    .map((pass) => `[${pass.runner}] ${truncate(pass.outputTail, 4_000)}`)
    .join("\n");

  return {
    gate: gate(
      GATE_IDS.suiteGreen,
      "the frozen held-out suite goes green",
      green ? "pass" : "fail",
      green
        ? `${merged.testsPassed ?? 0} of ${merged.testsTotal ?? 0} test(s) passed in ${durationMs} ms — ${census}` +
          excusedNote
        : [
            census,
            uncollected.length > 0
              ? `${uncollected.length} frozen file(s) collected by NO runner: ` +
                uncollected
                  .slice(0, 20)
                  .map((file) => suiteRelative(suiteDir, file))
                  .join(", ")
              : merged.problem === null
                ? (merged.testsTotal ?? 0) === 0
                  ? "the frozen suite collected ZERO tests across both runners — an empty gate is never a pass"
                  : `${merged.testsFailed ?? 0} failed of ${merged.testsTotal ?? 0}`
                : `report problem: ${merged.problem}`,
            `output tail: ${outputTails}`,
          ].join("; "),
      durationMs,
      // Both commands, verbatim, newline-separated. One of them may be absent
      // when that runner had no files; recording only one would misdescribe what
      // the gate actually executed.
      ranPasses.length === 0 ? null : ranPasses.map((pass) => pass.command ?? `(${pass.runner}: not invoked)`).join("\n"),
      execution.exitCode,
    ),
    execution,
    coverage: attributeCriteria(plan, merged),
    infrastructureErrors,
  };
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

function writeResult(result: ContainerResult): void {
  mkdirSync(CONTAINER_PATHS.out, { recursive: true });
  writeFileSync(CONTAINER_PATHS.result, `${JSON.stringify(redactForPersistence(result), null, 2)}\n`, "utf8");
}

async function main(): Promise<number> {
  assertRunningInsideSealedContainer();
  const startedAt = new Date().toISOString();
  mkdirSync(CONTAINER_PATHS.out, { recursive: true });

  const plan = parseScorerPlan(readJsonFile(CONTAINER_PATHS.plan));
  const manifestPath = join(CONTAINER_PATHS.suite, SUITE_MANIFEST_FILENAME);
  const manifest = parseSuiteManifest(readJsonFile(manifestPath));

  if (manifest.target === "native") {
    notImplemented(
      "native UI verification in the sealed scorer container. Xcode and the iOS Simulator are macOS-only " +
        "and Android needs /dev/kvm (doc 02 section 4.3), neither of which exists in this Linux container. " +
        'Set the manifest target to "web", or score native artefacts on the dedicated host described in ' +
        "doc 02 section 4.4. Silently reporting 'no screenshots required' would be worse than refusing.",
    );
  }
  if (manifest.ticketId !== plan.ticketId) {
    notImplemented(
      `reconciling a suite manifest for ticket ${manifest.ticketId} with a plan for ticket ${plan.ticketId}. ` +
        "These must be the same ticket; the mismatch means the wrong suite was mounted.",
    );
  }

  const infrastructureErrors: string[] = [];
  const gates: Tier0GateResult[] = [];

  // ---- the in-container time boundary ------------------------------------
  //
  // A BOUNDARY, NEVER A PROGRESS JUDGEMENT (doc 03 section 7.8: 79% of
  // unresolved long-horizon runs time out while still actively making
  // progress, so there is no "seems stuck" test anywhere in this program).
  //
  // It exists because the host's `docker kill` produces NO result.json, which
  // the host must classify as an INFRASTRUCTURE failure and exclude from every
  // rate denominator. An artefact that is merely too slow should score as a
  // failure, not vanish from the denominator — so the container enforces its
  // own, earlier boundary and still writes a complete, honest result.
  const deadline = Date.now() + plan.limits.totalTimeoutMs;
  const remainingMs = (): number => deadline - Date.now();

  // The frozen suite MAY declare the per-command timeout; the harness caps it,
  // so a manifest cannot declare a ten-hour build and outlive the campaign. A
  // null declaration takes the harness cap, which is the only defensible
  // default: the spec seat authors the manifest before any implementation
  // exists and cannot know how long a build it has never seen will take.
  const commandBudget = (): number =>
    Math.max(
      1_000,
      Math.min(
        manifest.execution.commandTimeoutMs ?? plan.limits.commandTimeoutMs,
        plan.limits.commandTimeoutMs,
        remainingMs(),
      ),
    );

  const outOfTime = (id: string, name: string): Tier0GateResult =>
    gate(
      id,
      name,
      "fail",
      `the scorer's ${plan.limits.totalTimeoutMs} ms total budget was exhausted before this gate ran. ` +
        "Recorded as a failure, never as a skip: a gate that did not run has not passed.",
      0,
      null,
      null,
    );

  const statics = runStaticScans(plan, manifest);
  gates.push(...statics.gates);

  const commandGates: readonly {
    readonly id: string;
    readonly name: string;
    readonly command: string | null;
    readonly absent: AbsentVerdict;
  }[] = [
    {
      id: GATE_IDS.build,
      name: "build succeeds",
      command: composeBuildCommand(manifest),
      absent: absentBuildVerdict(CONTAINER_PATHS.artifact, statics.walkedFiles),
    },
    {
      id: GATE_IDS.typecheck,
      name: "typecheck is clean",
      command: manifest.execution.typecheck,
      // TYPECHECK AND LINT ARE DELIBERATELY LEFT AS DECLARED-ABSENT-IS-ABSENT,
      // and that is a known remaining gap rather than a decision that they are
      // safe. A missing lint step is a genuine choice a project makes; a missing
      // typecheck on a TypeScript artefact is the same hole as #35 one door
      // down, and it is not closed here because no false-positive measurement
      // has been taken for it. Recorded rather than quietly assumed benign.
      absent: { outcome: "not_applicable", detail: "the frozen manifest declares no typecheck step" },
    },
    {
      id: GATE_IDS.lint,
      name: "lint is clean",
      command: manifest.execution.lint,
      absent: { outcome: "not_applicable", detail: "the frozen manifest declares no lint step" },
    },
  ];
  for (const spec of commandGates) {
    gates.push(
      remainingMs() <= 0
        ? outOfTime(spec.id, spec.name)
        : await runCommandGate(
            spec.id,
            spec.name,
            spec.command,
            spec.absent,
            CONTAINER_PATHS.artifact,
            commandBudget(),
            plan,
          ),
    );
  }

  if (remainingMs() <= 0) {
    for (const [id, name] of [
      [GATE_IDS.boot, "app boots and answers a health check"],
      [GATE_IDS.routes, "every declared route answers non-5xx"],
      [GATE_IDS.screenshotsPresent, "a masked, non-blank screenshot exists for every declared flow"],
      [GATE_IDS.dataPresent, "expected tables exist with non-zero rows"],
      [GATE_IDS.suiteGreen, "the frozen held-out suite goes green"],
    ] as readonly (readonly [string, string])[]) {
      gates.push(outOfTime(id, name));
    }
    writeResult({
      protocolVersion: SCORER_PROTOCOL_VERSION,
      ticketId: plan.ticketId,
      acceptanceSuiteSha256: plan.acceptanceSuiteSha256,
      startedAt,
      endedAt: new Date().toISOString(),
      nodeVersion: process.version,
      playwrightVersion: resolvePlaywrightVersion(),
      tier0: gates,
      exploitFindings: statics.exploitFindings,
      suiteExecution: {
        exitCode: -1,
        durationMs: 0,
        testsTotal: null,
        testsPassed: null,
        testsFailed: null,
        timedOut: true,
        reportProblem: "the scorer's total time budget was exhausted before the frozen suite could run",
      },
      criterionCoverage: plan.criteria.map((criterion) => ({
        criterionId: criterion.id,
        tier: criterion.tier,
        outcome: "unasserted" as const,
        testRefs: [],
        detail: "the scorer's total time budget was exhausted before the frozen suite could run",
      })),
      screenshots: [],
      domFindings: [],
      infrastructureErrors,
    });
    return 0;
  }

  const boot = await bootApp(plan, manifest);
  gates.push(...boot.gates);

  let screenshots: readonly ScreenshotRecord[] = [];
  let domFindings: readonly DomFinding[] = [];

  try {
    if (boot.origin !== null) {
      gates.push(
        remainingMs() <= 0
          ? outOfTime(GATE_IDS.routes, "every declared route answers non-5xx")
          : await checkRoutes(boot.origin, manifest.uiFlows),
      );
      if (remainingMs() <= 0) {
        gates.push(
          outOfTime(GATE_IDS.screenshotsPresent, "a masked, non-blank screenshot exists for every declared flow"),
        );
      } else {
        const capture = await captureFlows(plan, manifest, boot.origin);
        gates.push(capture.gate);
        screenshots = capture.screenshots;
        domFindings = capture.domFindings;
        infrastructureErrors.push(...capture.infrastructureErrors);
      }
    } else {
      gates.push(
        gate(
          GATE_IDS.routes,
          "every declared route answers non-5xx",
          "fail",
          "the app never booted, so no route could be probed",
          0,
          null,
          null,
        ),
        gate(
          GATE_IDS.screenshotsPresent,
          "a masked, non-blank screenshot exists for every declared flow",
          "fail",
          "the app never booted, so no flow could be captured",
          0,
          null,
          null,
        ),
      );
    }

    gates.push(
      remainingMs() <= 0
        ? outOfTime(GATE_IDS.dataPresent, "expected tables exist with non-zero rows")
        : await checkDataExpectations(manifest.dataExpectations, boot.origin),
    );

    // The suite's own ceiling, clamped by whatever remains of the total budget.
    // Both are boundaries; whichever binds first, binds.
    const suiteBudget = Math.min(plan.limits.suiteTimeoutMs, remainingMs());
    const suite =
      suiteBudget <= 0
        ? {
            gate: outOfTime(GATE_IDS.suiteGreen, "the frozen held-out suite goes green"),
            execution: {
              exitCode: -1,
              durationMs: 0,
              testsTotal: null,
              testsPassed: null,
              testsFailed: null,
              timedOut: true,
              reportProblem: "the scorer's total time budget was exhausted before the frozen suite could run",
            } satisfies SuiteExecutionRaw,
            coverage: plan.criteria.map((criterion) => ({
              criterionId: criterion.id,
              tier: criterion.tier,
              outcome: "unasserted" as const,
              testRefs: [] as readonly string[],
              detail: "the scorer's total time budget was exhausted before the frozen suite could run",
            })),
            infrastructureErrors: [] as readonly string[],
          }
        : await runFrozenSuite(plan, boot.origin, suiteBudget);
    gates.push(suite.gate);
    // A frozen file that neither runner collected is the SCORER's failure, not
    // the artefact's, and the host excludes a run with infrastructure errors from
    // its rate denominators rather than charging it to a configuration.
    infrastructureErrors.push(...suite.infrastructureErrors);

    writeResult({
      protocolVersion: SCORER_PROTOCOL_VERSION,
      ticketId: plan.ticketId,
      acceptanceSuiteSha256: plan.acceptanceSuiteSha256,
      startedAt,
      endedAt: new Date().toISOString(),
      nodeVersion: process.version,
      playwrightVersion: resolvePlaywrightVersion(),
      tier0: gates,
      exploitFindings: statics.exploitFindings,
      suiteExecution: suite.execution,
      criterionCoverage: suite.coverage,
      screenshots,
      domFindings,
      infrastructureErrors,
    });
  } finally {
    boot.server?.stop();
    // MUST be awaited, and must destroy live sockets (StaticServer.close does).
    // The static server runs IN THIS PROCESS: a listener with an open
    // keep-alive socket — Chromium leaves several — keeps Node's event loop
    // alive, the container never exits, no result.json is written, and the host
    // is forced to classify an ordinary scoring run as an INFRASTRUCTURE
    // failure, which doc 03 excludes from every rate denominator.
    if (boot.staticServer !== null) await boot.staticServer.close();
  }

  return 0;
}

/** Install (when declared) and build, as one gate: a failed install is a failed build. */
function composeBuildCommand(manifest: SuiteManifest): string | null {
  const { install, build } = manifest.execution;
  if (install === null) return build;
  if (build === null) return install;
  return `${install} && ${build}`;
}

function resolvePlaywrightVersion(): string {
  try {
    const pkg = readJsonFile(join(SCORER_HOME, "node_modules", "@playwright", "test", "package.json"));
    if (pkg !== null && typeof pkg === "object") {
      const version = (pkg as Record<string, unknown>)["version"];
      if (typeof version === "string") return version;
    }
  } catch {
    /* fall through to the honest answer */
  }
  return "unknown";
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).text;
    // Always leave a machine-readable result. A missing result.json is
    // indistinguishable from a crashed container, and the host needs to
    // distinguish an infrastructure failure from a model outcome.
    try {
      writeResult({
        protocolVersion: SCORER_PROTOCOL_VERSION,
        ticketId: "",
        acceptanceSuiteSha256: "",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        nodeVersion: process.version,
        playwrightVersion: resolvePlaywrightVersion(),
        tier0: [],
        exploitFindings: [],
        suiteExecution: {
          exitCode: -1,
          durationMs: 0,
          testsTotal: null,
          testsPassed: null,
          testsFailed: null,
          timedOut: false,
          reportProblem: "the scorer aborted before executing the suite",
        },
        criterionCoverage: [],
        screenshots: [],
        domFindings: [],
        infrastructureErrors: [message],
      });
    } catch {
      /* the mount itself is unwritable; the host will report a missing result */
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
