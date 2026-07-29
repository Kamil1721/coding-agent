/**
 * cron-config.ts — the environment a tick is allowed to run in, or a REFUSAL.
 *
 * REFUSALS RATHER THAN DEFAULTS WHEREVER A DEFAULT WOULD BE A GUESS ABOUT SPEND.
 * `DASHBOARD_CRON_MODEL` has no default: picking one would mean this file
 * choosing which of the owner's subscriptions to spend at 03:00. A number outside
 * its range is refused rather than clamped, because a clamp reads in the journal
 * exactly as if the number had been honoured — the operator sets 999, sees runs
 * happening, and believes the ceiling is 999.
 *
 * NO DESIGN-LOCK KNOB EXISTS HERE, and its absence is asserted by a test. The
 * only way to express `"ask"` is the HTTP field, which the tick hardcodes to
 * `"auto"`: a scheduled run that parks forever waiting for a click is the exact
 * failure unattended operation exists to avoid (spec §17.3 rule 2).
 *
 * `assertOutsideBakeoff` IS APPLIED TO THE CRON ROOT for the reason `paths.ts`
 * gives: the bake-off's `score` and `report` walk a results directory, and a
 * dashboard-owned directory inside that tree would be aggregated into a ~$2,100
 * measurement it was never part of.
 */

import { isAbsolute, join, resolve } from "node:path";
import { dashboardBaseUrl } from "../dashboard-url.js";
import { assertOutsideBakeoff, resolvePaths } from "../paths.js";
import { DEFAULT_LEASE_TTL_MIN } from "./cron-lease.js";

/** Non-secret configuration. Names only; no value here is ever a credential. */
export const CRON_ENV = Object.freeze({
  /** Where the queue, journal, lease and report live. Default: `<DASHBOARD_HOME>/cron`. */
  dir: "DASHBOARD_CRON_DIR",
  /** REQUIRED. No default — a default here is this file choosing what to spend. */
  model: "DASHBOARD_CRON_MODEL",
  /** `1` to ask for a deployed preview. */
  deploy: "DASHBOARD_CRON_DEPLOY",
  maxRuns: "DASHBOARD_CRON_MAX_RUNS_PER_WINDOW",
  windowHours: "DASHBOARD_CRON_WINDOW_HOURS",
  leaseTtlMin: "DASHBOARD_CRON_LEASE_TTL_MIN",
  /** How often the schedule is expected to fire. REPORT-ONLY; nothing here schedules anything. */
  expectEveryMin: "DASHBOARD_CRON_EXPECT_EVERY_MIN",
});

export interface CronConfig {
  readonly root: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly deploy: boolean;
  readonly maxRunsPerWindow: number;
  readonly windowHours: number;
  readonly leaseTtlMin: number;
  readonly expectEveryMin: number;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: CronConfig }
  | { readonly ok: false; readonly why: string };

/**
 * `<DASHBOARD_HOME>/cron`, or `DASHBOARD_CRON_DIR`. Throws if it lands inside the
 * bake-off tree.
 *
 * Exported separately because `runTick` needs it on the one path where the config
 * itself failed: an unusable cron root is the single failure this design cannot
 * record durably, and it must at least be attempted.
 */
export function cronRoot(env: NodeJS.ProcessEnv): string {
  const raw = (env[CRON_ENV.dir] ?? "").trim();
  const root = raw.length > 0 ? (isAbsolute(raw) ? raw : resolve(process.cwd(), raw)) : join(resolvePaths(env).home, "cron");
  assertOutsideBakeoff(root, "cron");
  return root;
}

interface Bound {
  readonly name: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  /** Said in the refusal, so the operator learns the reason and not just the range. */
  readonly why: string;
}

const BOUNDS: readonly Bound[] = [
  {
    name: CRON_ENV.maxRuns,
    fallback: 4,
    min: 1,
    max: 24,
    why:
      "0 means nothing may ever run, which is what not installing the schedule already does; above 24 " +
      "is more runs than one provider window can absorb and is a typo rather than an intention",
  },
  { name: CRON_ENV.windowHours, fallback: 24, min: 1, max: 24 * 7, why: "the journal is the only memory, and a window longer than a week is not a rate limit" },
  // ONE declaration of the lease TTL default, in the module that owns the lease.
  { name: CRON_ENV.leaseTtlMin, fallback: DEFAULT_LEASE_TTL_MIN, min: 1, max: 240, why: "a TTL longer than four hours outlives the wall-clock ceiling on a single seat call" },
  { name: CRON_ENV.expectEveryMin, fallback: 60, min: 1, max: 7 * 24 * 60, why: "this only decides when the report says OVERDUE" },
];

function readBound(env: NodeJS.ProcessEnv, bound: Bound): number | string {
  const raw = (env[bound.name] ?? "").trim();
  if (raw.length === 0) return bound.fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw || value < bound.min || value > bound.max) {
    return (
      `${bound.name} must be a whole number between ${String(bound.min)} and ${String(bound.max)}, got ` +
      `${JSON.stringify(raw)} — refused rather than clamped, because a clamp reads in the journal as if ` +
      `the number had been honoured (${bound.why})`
    );
  }
  return value;
}

export function readCronConfig(env: NodeJS.ProcessEnv): ConfigResult {
  // THE ROOT FIRST. Everything below is recorded IN the root, so a root that
  // cannot be used is the failure that has to be found before any other.
  let root: string;
  try {
    root = cronRoot(env);
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }

  const modelId = (env[CRON_ENV.model] ?? "").trim();
  if (modelId.length === 0) {
    return {
      ok: false,
      why:
        `${CRON_ENV.model} is not set, and it has no default: choosing a model here would be choosing ` +
        `which of the owner's subscriptions to spend unattended. GET /api/models lists the ids, and it ` +
        `costs no quota.`,
    };
  }

  const rawDeploy = (env[CRON_ENV.deploy] ?? "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true"].includes(rawDeploy)) {
    return {
      ok: false,
      why: `${CRON_ENV.deploy} must be 1, 0, true, false or unset, got ${JSON.stringify(rawDeploy)}`,
    };
  }

  const values: number[] = [];
  for (const bound of BOUNDS) {
    const value = readBound(env, bound);
    if (typeof value === "string") return { ok: false, why: value };
    values.push(value);
  }
  const [maxRunsPerWindow, windowHours, leaseTtlMin, expectEveryMin] = values;
  if (
    maxRunsPerWindow === undefined ||
    windowHours === undefined ||
    leaseTtlMin === undefined ||
    expectEveryMin === undefined
  ) {
    return { ok: false, why: "the configuration bounds did not all resolve" };
  }

  let baseUrl: string;
  try {
    // THE SAME RESOLVER `index.ts` BINDS WITH. A second parser here is trap row
    // 2: the tick would dial a port the server did not bind, and the only symptom
    // is a run that never appears.
    baseUrl = dashboardBaseUrl(env);
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }

  return {
    ok: true,
    config: {
      root,
      baseUrl,
      modelId,
      deploy: rawDeploy === "1" || rawDeploy === "true",
      maxRunsPerWindow,
      windowHours,
      leaseTtlMin,
      expectEveryMin,
    },
  };
}
