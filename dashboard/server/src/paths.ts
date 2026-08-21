/**
 * paths.ts — every directory the dashboard owns, and the guarantee that none
 * of them is inside the bake-off tree.
 *
 * WHY THIS FILE EXISTS AT ALL. `bakeoff`'s `score` and `report` subcommands
 * discover work by WALKING A RESULTS DIRECTORY (`loadRunRecords` in
 * `score-run.ts` scans for `run.jsonl`). A dashboard run record written under
 * `bakeoff/results/` would therefore be picked up by a campaign `score` and
 * aggregated into the bake-off's co-primary metrics — carrying a sandbox spec
 * that is NOT a container digest, from a run driven by a subscription SDK
 * rather than the budget proxy. That is the same failure class as STATUS
 * section 6 item 2 (a default results root that fell outside `.gitignore`),
 * and it would corrupt a ~$2,100 measurement with runs that were never part of
 * it.
 *
 * So: the dashboard writes NOTHING under `bakeoff/`. `assertOutsideBakeoff`
 * enforces it at startup, and `gateEnv()` overrides `BAKEOFF_RESULTS_DIR` and
 * `BAKEOFF_ACCEPTANCE_ROOT` for the sealed gate rather than letting it fall
 * back to its campaign defaults.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BakeoffError } from "bakeoff/dist/contracts.js";

/** Non-secret configuration. Names only; no value here is ever a credential. */
export const DASHBOARD_ENV = Object.freeze({
  /** Root of the dashboard's own state. Default: the `dashboard/` directory. */
  home: "DASHBOARD_HOME",
  /** Interface to bind. Only 127.0.0.1 is accepted — see http.ts. */
  host: "DASHBOARD_HOST",
  port: "DASHBOARD_PORT",
  /** Actual repository identity, independent of state-directory overrides. */
  /**
   * How many runs may execute at once. Default 1 — the serial behaviour this
   * dashboard has always had. Raising it is the owner's call and costs quota in
   * parallel against one subscription, so it is opt-in rather than a guess.
   */
  maxConcurrentRuns: "DASHBOARD_MAX_CONCURRENT_RUNS",
  /** Scorer image reference. Pin it by digest. */
  scorerImage: "BAKEOFF_SCORER_IMAGE",
  /** Hard boundary on one scoring container, in minutes. */
  scorerTimeoutMin: "BAKEOFF_SCORER_TIMEOUT_MIN",
  /**
   * Where finished code is PUBLISHED. Default: the sibling of `home`.
   *
   * An override exists because the default is derived from `home`'s PARENT and
   * is therefore the one dashboard directory that is not under `DASHBOARD_HOME`.
   * A test that sets `DASHBOARD_HOME` to a `mkdtemp` directory would otherwise
   * publish into the system temp root, shared with every other test file on the
   * machine; a test that uses the DEFAULT home would publish into the owner's
   * real repository. Both are avoided by pointing this at a scratch directory.
   */
  projects: "DASHBOARD_PROJECTS_DIR",
});

/** `dashboard/server/src` at source, `dashboard/server/dist` when compiled. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** `dashboard/` — the parent of `dashboard/server`. */
const DEFAULT_HOME = resolve(HERE, "..", "..");
const DEFAULT_PROJECT_ID = basename(resolve(HERE, "..", "..", ".."));

export function dashboardProjectId(_env: NodeJS.ProcessEnv): string {
  // This is the observed project identity, not an opt-in switch. Keeping it
  // anchored to the module location means an environment variable cannot make
  // an unrelated checkout impersonate the exact-project pilots.
  return DEFAULT_PROJECT_ID;
}

/** The bake-off tree this dashboard reuses. Read-only as far as we are concerned. */
export const BAKEOFF_ROOT = resolve(DEFAULT_HOME, "..", "bakeoff");

export interface DashboardPaths {
  /** `dashboard/` */
  readonly home: string;
  /** `dashboard/data` — the SQLite database lives here. */
  readonly data: string;
  /** `dashboard/data/runs.db` */
  readonly database: string;
  /** `dashboard/runs` — one subdirectory per run. */
  readonly runs: string;
  /** `dashboard/acceptance` — sealed suite store. NEVER `bakeoff/acceptance`. */
  readonly acceptance: string;
  /** `dashboard/results` — score records, screenshots, staging, tamper reports. */
  readonly results: string;
  /**
   * `<parent of home>/projects` — WHERE FINISHED CODE IS PUBLISHED, and the one
   * path here that is deliberately OUTSIDE `home`.
   *
   * WHY IT IS NOT UNDER `home`. The owner's words were "the code will be saved
   * into a folder within this directory", said about the repository he opens —
   * not about `dashboard/runs/<44-character run id>/workspace/`, which is where
   * the artefact actually lives and which he reported he cannot find. `home` is
   * `dashboard/`, a server package; its parent is the tree the owner works in.
   *
   * IT IS A COPY, NOT THE ARTEFACT. `RunPaths.workspace` stays the run's own
   * record and the scorer's input; `project-publish.ts` copies out of it and
   * moves nothing. Two consequences follow and both are load-bearing: deleting a
   * published folder cannot damage a run, and editing one does NOT change what
   * was graded.
   *
   * NOT CREATED BY `ensureDirs`, deliberately — see there.
   */
  readonly projects: string;
}

function absolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/**
 * Refuse any dashboard path that lands inside the bake-off tree.
 *
 * A same-path check is not enough: `bakeoff/results/dashboard` is still inside
 * the directory `loadRunRecords` walks.
 */
export function assertOutsideBakeoff(path: string, label: string): void {
  const rel = relative(BAKEOFF_ROOT, path);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the dashboard's ${label} directory (${path}) is inside the bake-off tree at ${BAKEOFF_ROOT}`,
      "Point DASHBOARD_HOME somewhere outside bakeoff/. The bake-off's `score` and `report` " +
        "subcommands discover runs by walking a results directory; a dashboard run record found " +
        "there would be aggregated into the campaign's co-primary metrics, carrying a sandbox spec " +
        "that is not a container digest. A dashboard run is not a bake-off run and the two record " +
        "sets must never mix.",
    );
  }
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): DashboardPaths {
  const raw = (env[DASHBOARD_ENV.home] ?? "").trim();
  const home = raw.length > 0 ? absolute(raw, process.cwd()) : DEFAULT_HOME;
  const rawProjects = (env[DASHBOARD_ENV.projects] ?? "").trim();
  const paths: DashboardPaths = {
    home,
    data: join(home, "data"),
    database: join(home, "data", "runs.db"),
    runs: join(home, "runs"),
    acceptance: join(home, "acceptance"),
    results: join(home, "results"),
    // DERIVED FROM `home`, NOT FROM `DEFAULT_HOME`. Deriving it from the module's
    // own location would make every test that points `DASHBOARD_HOME` at a temp
    // directory publish into the owner's real repository instead — a test suite
    // that writes folders into the tree it is testing.
    projects: rawProjects.length > 0 ? absolute(rawProjects, process.cwd()) : resolve(home, "..", "projects"),
  };
  assertOutsideBakeoff(paths.home, "home");
  assertOutsideBakeoff(paths.runs, "runs");
  assertOutsideBakeoff(paths.acceptance, "acceptance");
  assertOutsideBakeoff(paths.results, "results");
  // THE SAME FENCE, FOR A DIRECTORY THAT IS NOT UNDER `home`. `projects` is the
  // one path here derived from home's PARENT, so a `DASHBOARD_HOME` of
  // `bakeoff/x/dashboard` — or a `DASHBOARD_PROJECTS_DIR` pointed straight at the
  // bake-off tree — would land published folders inside the directory
  // `loadRunRecords` walks. Published code carries no `run.jsonl` and so could
  // not be aggregated as a run record, but the fence is cheaper to keep whole
  // than to reason about per directory.
  assertOutsideBakeoff(paths.projects, "projects");
  return paths;
}

/**
 * `projects` IS ABSENT FROM THIS LIST ON PURPOSE.
 *
 * Every other directory here is harness state that the server needs before it
 * can answer a request. `projects/` holds the owner's finished code and nothing
 * else; creating it at boot would put an empty, permanently empty folder at the
 * top of the tree he works in for every dashboard that never finishes a run.
 *
 * `publishProject` creates it on the first publish attempt THAT GETS AS FAR AS
 * CLAIMING A FOLDER NAME — said that precisely because it is not the same moment
 * as "the first successful publish". A `workspace-empty` decline removes it
 * again (non-recursively, so it cannot touch a `projects/` that already holds
 * anything); a `copy-failed` decline does NOT, so a filesystem fault can leave
 * an empty `projects/` behind. That is the deliberate trade — the half-copy is
 * the evidence of what went wrong, and the record says `copy-failed` rather than
 * reporting a folder as complete.
 */
export function ensureDirs(paths: DashboardPaths): void {
  for (const dir of [paths.data, paths.runs, paths.acceptance, paths.results]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Per-run layout. `workspace` is the artefact; everything else is harness state. */
export interface RunPaths {
  readonly root: string;
  /** The builder's cwd, git-initialised. Becomes `RunRecord.artifactPath`. */
  readonly workspace: string;
  /** Harness-side files for this run: logs, ledger, run record. */
  readonly results: string;
  readonly buildLog: string;
  readonly runLog: string;
  readonly ledger: string;
  /** Where the build prompt actually sent is recorded, verbatim. */
  readonly promptFile: string;
  /**
   * Metered image→video spend, in UNITS. `costUsd` stays null; see
   * `api-types.ts` and spec §7.5 — the script prints a path, the Veo response
   * carries no price, and this program has no price table to look one up in.
   *
   * ITS EXISTENCE IS ALSO A GUARD. `runVideoLane` reads this path back to decide
   * whether the run has already spent, so a resumed BUILD segment does not buy
   * the cap a second time.
   */
  readonly videoRecord: string;
}

export function runPathsFor(paths: DashboardPaths, runId: string): RunPaths {
  const root = join(paths.runs, safeSegment(runId));
  return {
    root,
    workspace: join(root, "workspace"),
    results: join(root, "results"),
    buildLog: join(root, "results", "build.log"),
    runLog: join(root, "results", "run.log"),
    ledger: join(root, "results", "ledger.jsonl"),
    promptFile: join(root, "results", "prompt.txt"),
    videoRecord: join(root, "results", "video.json"),
  };
}

/**
 * A filesystem-safe form of an identifier.
 *
 * Run ids are generated by this process, so this is belt-and-braces rather
 * than a defence — but a run id reaching `join()` unfiltered is a path
 * traversal, and the cost of being sure is one regex.
 */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 ? "unnamed" : cleaned;
}

export function ensureRunDirs(runPaths: RunPaths): void {
  for (const dir of [runPaths.root, runPaths.workspace, runPaths.results]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function runDirExists(runPaths: RunPaths): boolean {
  return existsSync(runPaths.root);
}

/**
 * The environment handed to `createGate()`.
 *
 * Deliberately built from a small allowlist plus the two path overrides rather
 * than spreading `process.env`: the scorer container is given no credential and
 * has no network, so there is nothing for it to authenticate to. If a key were
 * ever needed here, the suite would be reaching the internet and the
 * measurement would already be invalid (gate.ts says exactly this).
 */
export function gateEnv(paths: DashboardPaths, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const gate: NodeJS.ProcessEnv = {
    PATH: env["PATH"] ?? "",
    HOME: env["HOME"] ?? "",
    BAKEOFF_RESULTS_DIR: paths.results,
    BAKEOFF_ACCEPTANCE_ROOT: paths.acceptance,
  };
  const image = (env[DASHBOARD_ENV.scorerImage] ?? "").trim();
  if (image.length > 0) gate["BAKEOFF_SCORER_IMAGE"] = image;
  const timeout = (env[DASHBOARD_ENV.scorerTimeoutMin] ?? "").trim();
  if (timeout.length > 0) gate["BAKEOFF_SCORER_TIMEOUT_MIN"] = timeout;
  return gate;
}
