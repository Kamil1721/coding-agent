/**
 * gate-readiness.ts — the UNCACHED scorer-runtime check that guards spend.
 *
 * `GateProbe.status()` is deliberately cached because it feeds a polled health
 * endpoint. That makes it useful telemetry and an unsafe spend barrier: Docker
 * can stop during the cache window. This module is the second reading. Every
 * call starts a new sealed runtime smoke probe and callers fail closed unless it
 * returns `ready`.
 *
 * SCOPE OF THIS MILESTONE. Direct `POST /api/runs` and the orchestrator queue
 * entry use this port. Supervisor submission and cron intake still bypass the
 * direct HTTP route and must be wired separately; neither is claimed covered by
 * this module merely because queued execution has a second check.
 */

import { BakeoffError } from "bakeoff/dist/contracts.js";
import {
  DEFAULT_SCORER_CONTAINER,
  defaultScorerGateOptions,
  probeScorerRuntime,
} from "bakeoff/dist/scorer.js";
import type {
  ScorerContainerSpec,
  ScorerRuntimeReadiness,
} from "bakeoff/dist/scorer.js";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import { gateEnv } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

export type GateReadinessState = "ready" | "unavailable" | "unknown";

export interface GateReadinessResult {
  readonly state: GateReadinessState;
  readonly detail: string;
  readonly remediation: string;
  readonly checkedAt: string | null;
  /** Exact daemon-resolved image identity. Present only on a successful measured probe. */
  readonly scorerImageDigest?: string;
}

/** A fresh-check port shared by HTTP and the orchestrator. */
export interface GateReadiness {
  checkFresh(signal?: AbortSignal): Promise<GateReadinessResult>;
}

export type ScorerRuntimeProbe = (
  spec: ScorerContainerSpec,
  env?: NodeJS.ProcessEnv,
  dependencies?: { readonly signal?: AbortSignal },
) => Promise<ScorerRuntimeReadiness>;

export interface FreshGateReadinessOptions {
  readonly paths: DashboardPaths;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam at the one bounded docker-runtime probe. */
  readonly probe?: ScorerRuntimeProbe;
  readonly now?: () => Date;
  /** Host-resource admission. Every admitted call still performs a fresh probe. */
  readonly maxConcurrentProbes?: number;
  readonly maxQueuedProbes?: number;
}

interface ProbeWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

export const SCORER_READINESS_REMEDIATION =
  "Start Docker, build or restore the configured scorer image, and verify its bundled runtime smoke check. " +
  "Then resume the parked run or submit the ticket again.";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("the scorer-runtime readiness check was aborted");
}

/**
 * Fail-closed fallback for a host that forgot to wire production readiness.
 * It is intentionally not `ready`: optional dependency compatibility must not
 * turn a missing spend barrier into permission to spend.
 */
export const UNKNOWN_GATE_READINESS: GateReadiness = Object.freeze({
  checkFresh: (): Promise<GateReadinessResult> =>
    Promise.resolve({
      state: "unknown",
      detail: "no fresh scorer-runtime readiness checker is wired",
      remediation: "Wire one shared FreshGateReadiness instance before accepting or starting runs.",
      checkedAt: null,
    }),
});

/**
 * Run the configured scorer image far enough to prove its bundled Node,
 * Playwright and scorer files load under the same sealed container constraints
 * the real gate uses.
 */
export class FreshGateReadiness implements GateReadiness {
  readonly #paths: DashboardPaths;
  readonly #env: NodeJS.ProcessEnv;
  readonly #probe: ScorerRuntimeProbe;
  readonly #now: () => Date;
  readonly #maxConcurrentProbes: number;
  readonly #maxQueuedProbes: number;
  #activeProbes = 0;
  readonly #probeWaiters: ProbeWaiter[] = [];

  constructor(options: FreshGateReadinessOptions) {
    this.#paths = options.paths;
    this.#env = options.env ?? process.env;
    this.#probe = options.probe ?? (probeScorerRuntime as ScorerRuntimeProbe);
    this.#now = options.now ?? (() => new Date());
    this.#maxConcurrentProbes = options.maxConcurrentProbes ?? 1;
    this.#maxQueuedProbes = options.maxQueuedProbes ?? 8;
    if (!Number.isSafeInteger(this.#maxConcurrentProbes) || this.#maxConcurrentProbes < 1) {
      throw new Error("maxConcurrentProbes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxQueuedProbes) || this.#maxQueuedProbes < 0) {
      throw new Error("maxQueuedProbes must be a non-negative safe integer");
    }
  }

  async checkFresh(signal?: AbortSignal): Promise<GateReadinessResult> {
    const env = gateEnv(this.#paths, this.#env);
    const imageRef = env["BAKEOFF_SCORER_IMAGE"] ?? DEFAULT_SCORER_CONTAINER.imageRef;
    const spec = defaultScorerGateOptions(this.#paths.results, this.#paths.acceptance, imageRef).container;
    let release: (() => void) | null = null;
    try {
      release = await this.#acquireProbe(signal);
      const result = await this.#probe(spec, env, signal === undefined ? {} : { signal });
      return {
        state: "ready",
        detail:
          `scorer runtime ${result.smoke.protocolVersion} answered ok from ` +
          `${result.imageDigest.slice(0, 19)}… with Node ${result.smoke.nodeVersion} and ` +
          `Playwright ${result.smoke.playwrightVersion}`,
        remediation: "No action required.",
        checkedAt: this.#now().toISOString(),
        scorerImageDigest: result.imageDigest,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const detail = error instanceof BakeoffError
        ? `[${error.code}] ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      return {
        state: "unavailable",
        detail: redactForPersistence(detail),
        remediation: error instanceof BakeoffError ? error.remediation : SCORER_READINESS_REMEDIATION,
        checkedAt: this.#now().toISOString(),
      };
    } finally {
      release?.();
    }
  }

  async #acquireProbe(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.#activeProbes < this.#maxConcurrentProbes) {
      this.#activeProbes += 1;
      return this.#releaseProbeOnce();
    }
    if (this.#probeWaiters.length >= this.#maxQueuedProbes) {
      throw new Error(
        `scorer-runtime readiness admission is saturated ` +
          `(${String(this.#activeProbes)} active, ${String(this.#probeWaiters.length)} queued)`,
      );
    }
    return await new Promise<() => void>((resolve, reject) => {
      let waiter: ProbeWaiter;
      const onAbort = signal === undefined
        ? undefined
        : (): void => {
            const index = this.#probeWaiters.indexOf(waiter);
            if (index >= 0) this.#probeWaiters.splice(index, 1);
            reject(abortReason(signal));
          };
      waiter = { resolve, reject, signal, onAbort };
      this.#probeWaiters.push(waiter);
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      // Abort can race between the entry check and listener installation.
      // EventTarget does not replay an already-fired abort event.
      if (signal?.aborted) onAbort?.();
    });
  }

  #releaseProbeOnce(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#activeProbes -= 1;
      while (this.#probeWaiters.length > 0) {
        const waiter = this.#probeWaiters.shift();
        if (waiter === undefined) break;
        if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(abortReason(waiter.signal));
          continue;
        }
        this.#activeProbes += 1;
        waiter.resolve(this.#releaseProbeOnce());
        break;
      }
    };
  }
}

/**
 * Defensive boundary around an injected implementation. Production's class
 * already returns a value on every path, but a throwing test/custom adapter is
 * still "unknown", never permission to spend.
 */
export async function checkGateReadinessFresh(
  readiness: GateReadiness,
  signal?: AbortSignal,
): Promise<GateReadinessResult> {
  try {
    if (signal?.aborted) throw abortReason(signal);
    if (signal === undefined) return await readiness.checkFresh();
    return await new Promise<GateReadinessResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => reject(abortReason(signal)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void readiness.checkFresh(signal).then(
        (result) => { finish(() => resolve(result)); },
        (error: unknown) => { finish(() => reject(error)); },
      );
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return {
      state: "unknown",
      detail: redactForPersistence(
        `the scorer-runtime readiness check itself failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      remediation: SCORER_READINESS_REMEDIATION,
      checkedAt: null,
    };
  }
}
