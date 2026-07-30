/**
 * health-gate.ts — can the sealed gate be BUILT right now, and when was that
 * last true?
 *
 * THE GAP THIS CLOSES. Nothing touched the docker daemon until `#gatePhase`,
 * which runs after the spec phase and after the entire build — measured at
 * ~1h45 on the owner's recorded run. With the daemon down or the scorer image
 * missing, all of that time is spent and the run ends `unscored`, with no
 * preview and no way to re-score (`http.ts` refuses to resume a terminal run).
 * The check is cheap and the failure is total, so it belongs in front of the
 * owner BEFORE the ticket is submitted, not in the trace afterwards.
 *
 * IT CALLS `createGate(gateEnv(...))`, WHICH IS THE WHOLE POINT AND NOT A
 * CONVENIENCE. A hardcoded `docker image inspect bakeoff-scorer:1` would answer
 * a question the run never asks: `gateEnv` (paths.ts:183) passes
 * `BAKEOFF_SCORER_IMAGE` through from `DASHBOARD_ENV.scorerImage`, and the image
 * is MEANT to be pinned by digest (`bakeoff/src/gate.ts:32`). A probe checking
 * the default tag would go green against a configuration the real gate refuses.
 * Everything the gate needs to resolve — the image reference, the results root,
 * the acceptance root, the timeout — is read by the same function, from the same
 * environment, in the same order as `orchestrator.ts:2127`.
 *
 * WHAT AN `ok` HERE DOES AND DOES NOT PROVE. `createGate` resolves the scorer
 * image's content digest from the daemon (`scorer.ts:774` — one
 * `docker image inspect`) and returns. So `ok` means: the docker CLI was on
 * PATH, the daemon answered, and the configured image exists and reports a
 * sha256 id. It does NOT prove a container can actually run (no `--network=none`
 * container is started here, nothing is mounted, no memory limit is applied), it
 * does not prove any ticket's frozen suite exists, and it is not a promise about
 * the future — the daemon can stop between this answer and the gate phase. The
 * one thing it rules out is the failure that costs ~1h45.
 *
 * THREE STATES, AND `unknown` IS NOT A DEGRADED `ok`. The probe has an answer
 * ("ok"/"unavailable") or it has not produced one yet ("unknown"). See
 * {@link GateHealth} in api-types.ts for the rule the renderer must follow.
 *
 * WHY THE CACHE IS ON THE READ PATH AND NOT A TIMER. `/api/health` is polled
 * every 30 s by an open dashboard tab (`hooks.ts:26`) and by every cron tick, and
 * each probe is a subprocess spawn. A TTL means a poll is nearly always free,
 * and no probe runs at all while nobody is looking — which is the right
 * behaviour for a machine whose docker daemon may be deliberately off.
 */

import { createGate } from "bakeoff/dist/gate.js";
import type { AcceptanceGate } from "bakeoff/dist/contracts.js";
import type { GateHealth } from "./api-types.js";
// `describeError` unfolds a `BakeoffError` into `[code] message` plus its
// remediation, and `createGate` throws exactly that for the common case — "the
// scorer image could not be resolved" carries the `docker build …` command that
// fixes it. Re-spelling the formatting here would produce a second, worse
// sentence for the same error. It costs this module an import of the whole run
// pipeline, which its ONE consumer (`http.ts`) already has for the same reason.
import { describeError } from "./orchestrator.js";
import { gateEnv } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

/**
 * How long one answer is reused. A gate configuration does not change minute to
 * minute; a docker daemon that just came up is worth waiting a minute to notice.
 */
export const GATE_CACHE_MS = 60_000;

/**
 * How long `/api/health` will WAIT for a probe before answering with what it
 * already knows.
 *
 * NOT THE PROBE'S TIMEOUT — the probe has no timeout of its own to give. Inside
 * `createGate`, `resolveImageIdentity` allows the docker CLI 120 s
 * (`bakeoff/src/scorer.ts:781`), and a health endpoint that could block for two
 * minutes is a hung page. So the probe keeps running past this deadline and its
 * answer lands in the cache for the NEXT poll, while this request answers with
 * the last known state — "not probed yet" the first time. A warm daemon answers
 * an image inspect in well under a second; a missing docker binary fails
 * immediately; this budget is for the case in between.
 *
 * IT APPLIES TO THE COLD START ONLY. Once any answer exists, `status()` serves
 * it and does not wait on a refresh at all.
 */
export const GATE_PROBE_DEADLINE_MS = 5_000;

/** The literal served before any probe has completed. `checkedAt` says so too. */
const NOT_PROBED: GateHealth = {
  state: "unknown",
  detail:
    "The scorer gate has not been probed yet. This dashboard checks docker and the scorer image on " +
    "demand; refresh in a moment for an answer.",
  checkedAt: null,
};

export interface GateProbeOptions {
  readonly paths: DashboardPaths;
  /**
   * The environment the RUN will get, not merely this process's.
   *
   * `gateEnv` reads `BAKEOFF_SCORER_IMAGE` and `BAKEOFF_SCORER_TIMEOUT_MIN` out
   * of it (paths.ts:190-193), so a probe reading a different object answers for
   * a different configuration than the gate phase — the precise defect `auth.ts`'s header
   * records for the auth probe ("THE PROBE MUST SEE THE SAME ENVIRONMENT THE RUN
   * WILL GET"), arriving by another road. `index.ts` builds the orchestrator
   * with its own `env` and does not yet pass one to `createDashboardServer`; in
   * the only production path `main()` is called with no argument, so both are
   * the identical `process.env` object and the default below is truthful. If
   * `main(customEnv)` ever becomes a real path, index.ts has to thread it here.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * How the gate is constructed. The same seam, with the same name and the same
   * default, as `OrchestratorDeps.makeGate` — read that docblock
   * (orchestrator.ts:256-277) before assuming this weakens anything. Nothing in
   * production passes it.
   */
  readonly makeGate?: (env: NodeJS.ProcessEnv) => Promise<AcceptanceGate>;
  /**
   * The clock, the TTL and the wait, all injectable for the same reason:
   * without them the only way to test "a stale answer is refreshed" and "the
   * cold path gives up and reports `unknown`" is to wait a real minute or hang a
   * real docker. A test that cannot reach a branch is how this repository ends
   * up with checks that only ever observe success.
   */
  readonly nowMs?: () => number;
  readonly cacheMs?: number;
  readonly deadlineMs?: number;
}

/**
 * Resolve when `work` settles, or when `ms` elapses — whichever is first, and
 * never reject.
 *
 * The timer is unref'd and cleared on the winning path: a 5 s handle left behind
 * by a request that has already answered would hold `server.close()` open for no
 * reason, which is a hang in the test suite before it is one anywhere else. Both
 * arms of `then` resolve, because a rejection here is a fact about the probe
 * (already recorded by it) and never a reason to fail the request.
 */
function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void work.then(done, done);
  });
}

/**
 * The cached gate probe.
 *
 * ONE INSTANCE PER SERVER — the cache and the in-flight promise are the state
 * that makes polling cheap, and a fresh instance per request would probe on
 * every poll. `http.ts` builds one in `createDashboardServer`.
 */
export class GateProbe {
  #last: GateHealth = NOT_PROBED;
  /** null until the first probe COMPLETES. Not the same as `#last.checkedAt`. */
  #lastAtMs: number | null = null;
  /**
   * The probe currently running, or null.
   *
   * MEMOISED, AND THAT IS LOAD-BEARING RATHER THAN TIDY. With a hung daemon the
   * docker CLI runs for 120 s while this deadline is 5 s, so every poll in that
   * window would start ANOTHER `docker image inspect` — piling up subprocesses on
   * exactly the machine state the probe exists to report. One at a time.
   */
  #inFlight: Promise<void> | null = null;
  readonly #paths: DashboardPaths;
  readonly #env: NodeJS.ProcessEnv;
  readonly #makeGate: (env: NodeJS.ProcessEnv) => Promise<AcceptanceGate>;
  readonly #nowMs: () => number;
  readonly #cacheMs: number;
  readonly #deadlineMs: number;

  constructor(options: GateProbeOptions) {
    this.#paths = options.paths;
    this.#env = options.env ?? process.env;
    this.#makeGate = options.makeGate ?? createGate;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#cacheMs = options.cacheMs ?? GATE_CACHE_MS;
    this.#deadlineMs = options.deadlineMs ?? GATE_PROBE_DEADLINE_MS;
  }

  /**
   * The gate's state, as far as this process knows it.
   *
   * NEVER THROWS, AND WAITS ONLY WHEN IT HAS NOTHING TO SERVE. Three cases:
   *
   *   · fresh answer      — returned immediately, no subprocess;
   *   · stale answer      — the OLD answer is returned immediately and a refresh
   *                         runs behind it, landing in the cache for the next
   *                         poll. Nothing waits on docker once an answer exists;
   *   · no answer at all  — waits up to the deadline, so the first `/api/health`
   *                         of a session usually carries a real state instead of
   *                         "not probed yet". If the deadline wins, `unknown` is
   *                         returned and the probe keeps going.
   *
   * SO AN ANSWER CAN LAG REALITY by up to the TTL plus one poll interval: a
   * daemon that stops right after an `ok` reads `ok` until the next poll after
   * the TTL expires. That is what `checkedAt` is on the wire for, and why the
   * contract says `ok` describes the instant it was taken and not this one.
   */
  async status(): Promise<GateHealth> {
    const last = this.#lastAtMs;
    if (last !== null && this.#nowMs() - last < this.#cacheMs) return this.#last;
    const refresh = this.#refresh();
    if (last === null) await settleWithin(refresh, this.#deadlineMs);
    return this.#last;
  }

  #refresh(): Promise<void> {
    const running = this.#inFlight;
    if (running !== null) return running;
    const started = (async () => {
      // `#probe` answers on every path, refusals included — see its docblock.
      // The catch is here anyway because this promise is deliberately LEFT
      // FLOATING whenever a previous answer exists, and an unhandled rejection
      // ends the process: a module whose job is to stop a docker outage being a
      // dashboard outage must not be the thing that takes the dashboard down.
      try {
        const health = await this.#probe();
        this.#last = health;
        this.#lastAtMs = this.#nowMs();
      } catch {
        // Nothing was learned, so nothing is written: `#last` keeps the previous
        // answer and the next poll probes again. Recording "unavailable" here
        // would report the probe's own bug as a fact about the daemon.
      }
    })().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = started;
    return started;
  }

  /**
   * One construction attempt, turned into an answer.
   *
   * EVERY PATH RETURNS A VALUE. `#probe` is the only thing between a rejected
   * `createGate` and an unhandled rejection that would take the server down, and
   * a refusal from the gate is the MEASUREMENT here rather than an error — "the
   * scorer image is not built" is precisely what the owner needs to read.
   */
  async #probe(): Promise<GateHealth> {
    try {
      const gate = await this.#makeGate(gateEnv(this.#paths, this.#env));
      return {
        state: "ok",
        // The same 19-character prefix `#gatePhase` logs for the scored image
        // (orchestrator.ts:2172): enough to compare two answers by eye, and not
        // a claim that this digest will still be the one that scores the run.
        detail: `The docker daemon resolved the scorer image to ${gate.scorerImageDigest.slice(0, 19)}…`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        state: "unavailable",
        detail: describeError(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
