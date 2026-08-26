/**
 * Shared protocol for the scorer image's deliberately small runtime smoke path.
 *
 * This module is compiled into the image and imported by the host. Keeping the
 * flag, line prefix and payload parser in one place prevents an old or unrelated
 * image from being mistaken for a ready scorer merely because it exited zero.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCORER_PROTOCOL_VERSION } from "./scorer-protocol.js";

export const SCORER_RUNTIME_SMOKE_ARG = "--smoke";
export const SCORER_RUNTIME_SMOKE_PREFIX = "BAKEOFF_SCORER_SMOKE ";
export const SCORER_RUNTIME_SMOKE_VERSION = 2 as const;

const SCORER_HOME = "/opt/bakeoff-scorer";
const REQUIRED_RUNTIME_FILES = Object.freeze([
  "package.json",
  "dist/scorer-container.js",
  "playwright.config.mjs",
  "node-test-reporter.mjs",
]);

export interface ScorerRuntimeSmokePayload {
  readonly smokeVersion: typeof SCORER_RUNTIME_SMOKE_VERSION;
  readonly status: "ok";
  readonly protocolVersion: typeof SCORER_PROTOCOL_VERSION;
  readonly nodeVersion: string;
  readonly playwrightVersion: string;
  readonly chromiumVersion: string;
  readonly checkedFiles: readonly string[];
}

interface SmokeBrowser {
  close(): Promise<void>;
  version(): string;
}

interface SmokeChromium {
  launch(options: {
    readonly headless: true;
    readonly chromiumSandbox: false;
    readonly args: string[];
  }): Promise<SmokeBrowser>;
}

export interface ScorerRuntimeSmokeDependencies {
  readonly scorerHome?: string;
  readonly loadPlaywright?: () => Promise<{ readonly chromium: SmokeChromium }>;
  readonly loadRuntimeModule?: (absolutePath: string) => Promise<unknown>;
}

function requiredFile(scorerHome: string, relativePath: string): void {
  const path = join(scorerHome, relativePath);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`required scorer runtime file ${relativePath} is not a non-empty regular file`);
  }
}

/**
 * Validate only the scorer's own runtime. This never reads a plan or suite and
 * never starts, builds, or inspects a submitted artefact.
 */
export async function runScorerRuntimeSmoke(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ScorerRuntimeSmokeDependencies = {},
): Promise<ScorerRuntimeSmokePayload> {
  if (env["BAKEOFF_SCORER_SEALED"] !== "1") {
    throw new Error("BAKEOFF_SCORER_SEALED=1 is required");
  }

  const scorerHome = dependencies.scorerHome ?? SCORER_HOME;
  for (const relativePath of REQUIRED_RUNTIME_FILES) requiredFile(scorerHome, relativePath);

  const packageJson = JSON.parse(readFileSync(join(scorerHome, "package.json"), "utf8")) as unknown;
  if (packageJson === null || typeof packageJson !== "object") {
    throw new Error("the bundled package.json is not an object");
  }
  const declaredPlaywright = (packageJson as { dependencies?: Record<string, unknown> }).dependencies?.[
    "@playwright/test"
  ];
  if (typeof declaredPlaywright !== "string" || declaredPlaywright.length === 0) {
    throw new Error("the bundled package.json does not declare @playwright/test");
  }

  const playwrightPackagePath = join(scorerHome, "node_modules", "@playwright", "test", "package.json");
  requiredFile(scorerHome, "node_modules/@playwright/test/package.json");
  const playwrightPackage = JSON.parse(readFileSync(playwrightPackagePath, "utf8")) as unknown;
  const playwrightVersion =
    playwrightPackage !== null && typeof playwrightPackage === "object"
      ? (playwrightPackage as Record<string, unknown>)["version"]
      : undefined;
  if (typeof playwrightVersion !== "string" || playwrightVersion.length === 0) {
    throw new Error("the installed @playwright/test package has no version");
  }
  if (declaredPlaywright !== playwrightVersion) {
    throw new Error(
      `the installed @playwright/test version ${playwrightVersion} does not match package.json ${declaredPlaywright}`,
    );
  }

  const browsersPath = env["PLAYWRIGHT_BROWSERS_PATH"];
  if (browsersPath === undefined || browsersPath.length === 0) {
    throw new Error("PLAYWRIGHT_BROWSERS_PATH is not set");
  }
  if (!statSync(browsersPath).isDirectory()) {
    throw new Error(`PLAYWRIGHT_BROWSERS_PATH ${browsersPath} is not a directory`);
  }

  /*
   * A package manifest and a populated directory are not executable evidence.
   * Load the same three modules the real gate depends on, then launch Chromium
   * with the real scorer's sealed-container options. Invalid-but-non-empty
   * config/reporter files, a broken module graph and a missing browser binary
   * now all fail this pre-spend proof rather than the terminal gate.
   */
  const loadRuntimeModule = dependencies.loadRuntimeModule ??
    (async (absolutePath: string): Promise<unknown> => await import(pathToFileURL(absolutePath).href));
  const previousOrigin = process.env["BAKEOFF_APP_ORIGIN"];
  process.env["BAKEOFF_APP_ORIGIN"] = previousOrigin ?? "http://127.0.0.1:1";
  try {
    const configModule = await loadRuntimeModule(join(scorerHome, "playwright.config.mjs"));
    if (
      configModule === null ||
      typeof configModule !== "object" ||
      (configModule as { readonly default?: unknown }).default === null ||
      typeof (configModule as { readonly default?: unknown }).default !== "object"
    ) {
      throw new Error("the bundled Playwright config has no default config object");
    }
    const reporterModule = await loadRuntimeModule(join(scorerHome, "node-test-reporter.mjs"));
    if (
      reporterModule === null ||
      typeof reporterModule !== "object" ||
      typeof (reporterModule as { readonly default?: unknown }).default !== "function"
    ) {
      throw new Error("the bundled node:test reporter has no default reporter function");
    }
  } finally {
    if (previousOrigin === undefined) delete process.env["BAKEOFF_APP_ORIGIN"];
    else process.env["BAKEOFF_APP_ORIGIN"] = previousOrigin;
  }

  const playwright = await (dependencies.loadPlaywright ??
    (async (): Promise<{ readonly chromium: SmokeChromium }> => await import("@playwright/test")))();
  if (playwright === null || typeof playwright !== "object" || typeof playwright.chromium?.launch !== "function") {
    throw new Error("the installed @playwright/test module does not expose chromium.launch");
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
  });
  let chromiumVersion: string;
  try {
    chromiumVersion = browser.version();
    if (chromiumVersion.length === 0) throw new Error("the launched Chromium browser reported no version");
  } finally {
    await browser.close();
  }

  return {
    smokeVersion: SCORER_RUNTIME_SMOKE_VERSION,
    status: "ok",
    protocolVersion: SCORER_PROTOCOL_VERSION,
    nodeVersion: process.version,
    playwrightVersion,
    chromiumVersion,
    checkedFiles: [...REQUIRED_RUNTIME_FILES, "node_modules/@playwright/test/package.json", browsersPath],
  };
}

export function formatScorerRuntimeSmoke(payload: ScorerRuntimeSmokePayload): string {
  return `${SCORER_RUNTIME_SMOKE_PREFIX}${JSON.stringify(payload)}`;
}

/** Parse one bounded machine-readable stdout line. Extra output fails closed. */
export function parseScorerRuntimeSmoke(stdout: string): ScorerRuntimeSmokePayload {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0]?.startsWith(SCORER_RUNTIME_SMOKE_PREFIX)) {
    throw new Error(`expected exactly one ${SCORER_RUNTIME_SMOKE_PREFIX.trim()} line`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0].slice(SCORER_RUNTIME_SMOKE_PREFIX.length)) as unknown;
  } catch (error) {
    throw new Error(`smoke payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("smoke payload is not an object");
  const value = parsed as Record<string, unknown>;
  if (value["smokeVersion"] !== SCORER_RUNTIME_SMOKE_VERSION) {
    throw new Error(`unsupported smokeVersion ${JSON.stringify(value["smokeVersion"])}`);
  }
  if (value["status"] !== "ok") throw new Error(`smoke status is not ok: ${JSON.stringify(value["status"])}`);
  if (value["protocolVersion"] !== SCORER_PROTOCOL_VERSION) {
    throw new Error(`scorer protocol version is ${JSON.stringify(value["protocolVersion"])}`);
  }
  if (typeof value["nodeVersion"] !== "string" || !/^v\d+\./u.test(value["nodeVersion"])) {
    throw new Error("smoke payload has no valid nodeVersion");
  }
  if (typeof value["playwrightVersion"] !== "string" || value["playwrightVersion"].length === 0) {
    throw new Error("smoke payload has no playwrightVersion");
  }
  if (typeof value["chromiumVersion"] !== "string" || value["chromiumVersion"].length === 0) {
    throw new Error("smoke payload has no chromiumVersion");
  }
  if (
    !Array.isArray(value["checkedFiles"]) ||
    value["checkedFiles"].length === 0 ||
    !value["checkedFiles"].every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("smoke payload has no valid checkedFiles list");
  }
  return parsed as unknown as ScorerRuntimeSmokePayload;
}
