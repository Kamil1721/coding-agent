/**
 * gate-fix-loop.ts — gate, triage, fix, re-gate, and STOP.
 *
 * This is the loop that lets the owner submit a ticket and walk away, so its
 * failure mode matters more than its feature set. Two properties are
 * non-negotiable and everything else here is in service of them:
 *
 *   BOUNDED. Four separate stops, every one of them reachable and every one
 *   tested: green, the retry cap, non-convergence, and infrastructure. An
 *   unattended system that retries forever is worse than one that stops and says
 *   why — it spends a subscription's shared rate-limit window on a build nobody
 *   is watching.
 *
 *   TWO MORE BOUNDS WERE ADDED ON 2026-08-05 AND NONE WAS REMOVED — a wall-clock
 *   budget and an ordinal no-progress detector. Both can only stop the loop
 *   EARLIER than it stopped before, which is the only direction a bound is
 *   allowed to move here. See {@link timeBudgetFrom} and
 *   {@link NO_PROGRESS_WINDOW}.
 *
 *   THE ATTEMPT CAP STAYED AT 3, AGAINST THE SPEC, ON MEASUREMENT. The design
 *   (2026-08-05-design-fidelity-gate.md §6) proposed 3 -> 6. Both gated runs in
 *   the owner's database recorded `gate_attempts = 1`; the cap has never been
 *   approached in either direction, so raising it changes nothing observed and
 *   doubles worst-case context pressure on a builder session that is RESUMED per
 *   round (orchestrator.ts) and has already died once from an output-token
 *   ceiling. `DASHBOARD_GATE_MAX_ATTEMPTS` already buys the owner a longer night,
 *   1..10, without guessing on his behalf.
 *
 *   REDACTED. Nothing reaches a fixing agent except through
 *   `toAgentVisible` -> `planFixes` -> `buildFixPrompt`. A `ContainerResult`
 *   carries held-out TEST TITLES (`criterionCoverage[].testRefs`); an agent that
 *   learns them can write code shaped to the titles, and `heldOutPass` stops
 *   measuring anything while still looking like a verdict.
 *
 * WHY IT IS A FREE FUNCTION AND NOT A PRIVATE METHOD. The orchestrator builds
 * its gate from `createGate()` and its fixer from a subscription SDK; a loop
 * that constructed either could only be tested by spending the owner's quota,
 * which is a test nobody runs twice. `gate` and `runFix` are injected. Everything
 * between them is the production path, so the leak test observes the real
 * prompt rather than a reconstruction of it.
 *
 * ONE PROMPT CHANNEL, NOT TWO. The plan specified an `onAgentPrompt` observer
 * alongside the fix call. It is deliberately absent: a test that watches a
 * channel the agent is not actually given is the shape of check this repository
 * keeps shipping. The prompt passed to {@link GateFixLoopRequest.runFix} is the
 * prompt the agent receives, and it is the only one built.
 */

import { createHash } from "node:crypto";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import { gatingUnmet, isGreen, toAgentVisible, unmetTotal } from "./gate-report.js";
import type { AgentVisibleReport } from "./gate-report.js";
import { partitionByPermission, planFixes } from "./fix-triage.js";
import type { FixTask } from "./fix-triage.js";
import { buildFixPrompt } from "./fix-prompt.js";

export type StopReason =
  | "green"
  | "retry-cap"
  | "not-converging"
  | "infra"
  | "cancelled"
  | "artifact-contract";

/**
 * WHY THE LOOP STOPPED, at the resolution the loop actually knows.
 *
 * `StopReason` is the PERSISTED vocabulary: `db.ts` types `RunPatch.gateStopReason`
 * as it, `backlog.ts` keys a TOTAL `Record<StopReason, string>` of owner-facing
 * headings off it, and `orchestrator.ts` writes it to the run row. Six members
 * is what every one of those files was built around.
 *
 * THREE OF THOSE SIX COVER TWO SITUATIONS EACH, and each pair reads as the
 * wrong one of the two (2026-08-05-design-fidelity-gate.md §6.2):
 *
 *   `cancelled`       — the owner stopped this run  /  a provider rate limit did.
 *                       One is terminal; the other is meant to resume. Recorded
 *                       identically, they say the owner abandoned a run he did not.
 *   `not-converging`  — the fixer changed nothing  /  NOTHING WAS ALLOWED TO RUN.
 *                       The second is a permissions fault wearing a word that
 *                       describes the fixer's competence.
 *   `retry-cap`       — the attempt cap  /  the wall-clock budget.
 *
 * SO THE CAUSE IS A SECOND, FINER FIELD RATHER THAN A WIDER `StopReason`. Adding
 * members to `StopReason` is a two-line change here and a compile error in
 * `backlog.ts`, whose `REASONS` record is total by design and which belongs to
 * neither this lane nor either concurrent workflow. The cause is returned on
 * {@link GateFixLoopResult} and stated in the loop's own log line, so nothing it
 * knows is hidden; only the backlog HEADING is still coarse, and promoting a
 * cause to a persisted reason later is a one-line addition per member in
 * `backlog.ts` plus this map. Recorded rather than done.
 */
export type StopCause =
  | "green"
  | "attempt-cap"
  | "time-budget"
  | "no-progress"
  | "identical-report"
  | "no-permitted-fixer"
  | "infra"
  | "artifact-contract"
  | "owner-cancelled"
  | "rate-limited";

/**
 * Cause -> the coarse reason that is persisted. Total, so a new cause does not
 * compile until someone has decided which owner-facing heading it lands under.
 *
 * `time-budget` -> `retry-cap` IS THE ONE IMPRECISE ROW, and it is imprecise in
 * its heading only: `backlog.ts` will say "the fix loop hit its attempt cap",
 * which is false, above a list of work that is genuinely "real and unfinished,
 * not unknown", which is the half that matters. It is not silent — the loop logs
 * the cause verbatim. Fixing the heading means widening `StopReason`, which is
 * the change described above.
 */
const REASON_OF: Readonly<Record<StopCause, StopReason>> = Object.freeze({
  green: "green",
  "attempt-cap": "retry-cap",
  "time-budget": "retry-cap",
  "no-progress": "not-converging",
  "identical-report": "not-converging",
  "no-permitted-fixer": "not-converging",
  infra: "infra",
  "artifact-contract": "artifact-contract",
  "owner-cancelled": "cancelled",
  "rate-limited": "cancelled",
});

/** Default rounds. Overridable per run; see `DASHBOARD_GATE_MAX_ATTEMPTS`. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Env var for the cap. A number outside 1..10 is refused, not clamped silently. */
export const GATE_MAX_ATTEMPTS_ENV = "DASHBOARD_GATE_MAX_ATTEMPTS";

/**
 * The wall-clock ceiling on the whole loop. Four hours.
 *
 * CHOSEN, NOT MEASURED, and it has to be labelled that way because this repo has
 * shipped an invented number as if it were an observation before. What IS
 * measured: the one passing run took 105 minutes end to end, of which the BUILD
 * phase was 24.4 minutes and the gate itself was 14.5 seconds. A fix round
 * resumes that same builder session, so a round costs roughly a build. Six
 * rounds of roughly one build each, plus slack, is where 240 came from. No run
 * has ever performed a second gate attempt, so a fix round's real duration has
 * never been observed at all.
 */
export const DEFAULT_TIME_BUDGET_MS = 240 * 60_000;

/** Env var for the budget, in MINUTES. Outside 1..1440 is refused, not clamped. */
export const GATE_TIME_BUDGET_ENV = "DASHBOARD_GATE_TIME_BUDGET_MIN";

/**
 * How many consecutive gate rounds may pass with no ordinal improvement.
 *
 * THREE MEANS "TWO FIX ROUNDS BOUGHT NOTHING": round 3 is compared against round
 * 1, not against round 2. One round of memory is what {@link fingerprint} has and
 * it is why an A->B->A->B fixer can run to the cap.
 *
 * IT IS LIVE AT THE DEFAULT CAP, WHICH IS THE POINT. A window of 3 compared
 * against the round 3 back would need a 4th gate to fire, and with
 * `DEFAULT_MAX_ATTEMPTS = 3` that is a detector no default run can reach — a
 * check that could only ever be observed not firing.
 */
export const NO_PROGRESS_WINDOW = 3;

export interface GateFixLoopRequest {
  /**
   * Validate the artifact immediately before the next gate is counted or
   * constructed. A refusal is an artifact prerequisite result, never scorer
   * infrastructure, and preserves the last completed gate report.
   */
  readonly preGate?: (
    nextAttempt: number,
  ) => Promise<{ readonly cause: "artifact-contract"; readonly detail: string } | null>;
  /** Run the sealed gate for `attempt` and return its container result. */
  readonly gate: (attempt: number) => Promise<ContainerResult | null>;
  /** Spawn `task.agent` with exactly `prompt` and nothing else about the gate. */
  readonly runFix: (task: FixTask, prompt: string, attempt: number) => Promise<void>;
  readonly maxAttempts: number;
  readonly workspace: string;
  /** This run's delegation shortlist. Work routed outside it cannot run. */
  readonly allowedAgents: readonly string[];
  readonly signal?: AbortSignal;
  readonly log?: (level: "info" | "warn" | "error", text: string) => void;
  /**
   * The whole loop's wall-clock ceiling. Defaults to {@link DEFAULT_TIME_BUDGET_MS}.
   */
  readonly timeBudgetMs?: number;
  /**
   * INJECTED SO THE BUDGET IS TESTABLE WITHOUT WAITING FOUR HOURS. Defaults to
   * `Date.now`. A test that proved a four-hour bound by sleeping is a test nobody
   * runs, which is the same as a bound nobody checked.
   */
  readonly now?: () => number;
  /**
   * Why {@link GateFixLoopRequest.signal} aborted, when the caller knows.
   *
   * Defaults to `"owner-cancelled"`, which is what this loop assumed for every
   * abort until now. The caller that knows better is `orchestrator.ts`: its
   * `runFix` sets a local `rateLimit` and calls `loopAbort.abort()` when a fix
   * task comes back rate-limited, and that distinction is currently thrown away
   * one line later. Supplying this closure is how it stops being thrown away;
   * that line belongs to the recovery workflow and is recorded, not taken.
   */
  readonly abortCause?: () => "owner-cancelled" | "rate-limited";
}

export interface GateFixLoopResult {
  readonly passed: boolean;
  /** Gate runs actually performed. 1-based, so 1 means "gated once". */
  readonly attempts: number;
  readonly reason: StopReason;
  /** The same stop at the finer resolution. See {@link StopCause}. */
  readonly cause: StopCause;
  /** The FINAL attempt's redacted report. Safe to persist and to render. */
  readonly report: AgentVisibleReport;
  /** Work that was planned and could not be run — for the backlog. */
  readonly deniedTasks: readonly FixTask[];
  /** Additional terminal context supplied by a pre-gate refusal. */
  readonly detail: string | null;
}

/**
 * The cap, from the environment, refusing nonsense rather than clamping it.
 *
 * A clamp would let `DASHBOARD_GATE_MAX_ATTEMPTS=100` run as 10 and read in the
 * log as if the owner's number had been honoured. The upper bound exists because
 * this loop re-runs a container scorer and spawns a subscription agent per
 * round: ten rounds of a four-hour ceiling is not a bound anyone meant.
 */
export function maxAttemptsFrom(env: NodeJS.ProcessEnv): number {
  const raw = (env[GATE_MAX_ATTEMPTS_ENV] ?? "").trim();
  if (raw.length === 0) return DEFAULT_MAX_ATTEMPTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) return DEFAULT_MAX_ATTEMPTS;
  return value;
}

/**
 * The wall-clock budget, in MILLISECONDS, from an environment stated in MINUTES.
 *
 * MINUTES IN, MILLISECONDS OUT, deliberately: every duration the owner has ever
 * seen about this system is in minutes (105-minute run, 24.4-minute build,
 * 8h39m stall), and `DASHBOARD_GATE_TIME_BUDGET_MIN=240` is a number he can
 * check against those. A millisecond env var invites a value three orders of
 * magnitude off that would read as a working bound.
 *
 * REFUSED, NOT CLAMPED, for {@link maxAttemptsFrom}'s reason. The upper band is
 * 1440 — a day. Anything above that is not a bound on an overnight run, it is
 * the absence of one wearing a number.
 */
export function timeBudgetFrom(env: NodeJS.ProcessEnv): number {
  const raw = (env[GATE_TIME_BUDGET_ENV] ?? "").trim();
  if (raw.length === 0) return DEFAULT_TIME_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1440) return DEFAULT_TIME_BUDGET_MS;
  return value * 60_000;
}

/**
 * The ordinal state of a build: gating criteria unmet, then failures.
 *
 * BOTH, AND IN THIS ORDER, because they are not interchangeable. `gatingUnmet`
 * is what `computeHeldOutPass` reads and therefore what decides the verdict;
 * `failures.length` is the tier-0 surface a fixer works on. A round that closes
 * a criterion has progressed even if it uncovered two new tier-0 failures doing
 * it, and a round that closes tier-0 failures while the criteria stand still has
 * progressed too. Lexicographic order is exactly that claim.
 */
interface ProgressPair {
  readonly gating: number;
  readonly failures: number;
}

function progressOf(report: AgentVisibleReport): ProgressPair {
  return { gating: gatingUnmet(report), failures: report.failures.length };
}

/**
 * Strict ordinal improvement, lexicographic on {@link ProgressPair}.
 *
 * "5 FAILURES BECAME 5 DIFFERENT FAILURES" IS NOT PROGRESS HERE, and that is the
 * whole difference from {@link fingerprint}. The fingerprint is a CHANGE
 * detector over free text: it reads any reworded detail as movement, and on the
 * one real failing artefact in this tree it is defeated outright, because
 * `GATE:boot`'s detail embeds a poll count and an elapsed-milliseconds figure
 * that differ every round. A loop watching only that ran to its cap on a fixer
 * that changed nothing.
 *
 * THE COST IS ACCEPTED AND IS NOT ZERO: a fixer that closes two failures and
 * uncovers two others shows no ordinal improvement and, if it does that for
 * {@link NO_PROGRESS_WINDOW} rounds running, is stopped while genuinely working.
 * The window is the tolerance for exactly that, and the failure mode is a run
 * that stops early with its work recorded — not one that spends the owner's
 * shared rate-limit window all night proving the same thing.
 */
function improved(current: ProgressPair, earlier: ProgressPair): boolean {
  if (current.gating !== earlier.gating) return current.gating < earlier.gating;
  return current.failures < earlier.failures;
}

/**
 * A stable identity for "the state this build is in".
 *
 * Two identical fingerprints across a fix round mean the fix changed nothing
 * OBSERVABLE — same failures, same details, same number of unmet criteria — and
 * the remaining budget would produce the same evidence again.
 *
 * THE UNMET COUNTS ARE PART OF IT, and that is not padding. A build can pass
 * every tier-0 gate while criteria stay unmet; with failures alone the
 * fingerprint would be constant across every such round and the loop would call
 * "not converging" on a fixer that had just closed two of three criteria.
 *
 * THE FIELD SEPARATOR IS U+001F (ASCII UNIT SEPARATOR), WRITTEN AS THE SOURCE
 * ESCAPE `\u001F` RATHER THAN AS A RAW BYTE, so this file is plain ASCII.
 * It carried three RAW NUL BYTES until 2026-07-30, and the reason for the change
 * is a tooling hazard rather than a hashing one: a file containing a NUL is
 * BINARY to `grep`, which then skips it in silence — `grep -c "" gate-fix-loop.ts`
 * printed nothing and exited 1 while `grep -a -c ""` printed 215. Every "that
 * string does not appear in this file" claim made over the old file was therefore
 * unfounded, and this was the only such file in the tree.
 *
 * WHAT THE CHANGE COULD NOT BE ALLOWED TO BREAK, and why it does not: the
 * separator's whole job is INJECTIVITY — `klass`/`id`/`detail` must not be able
 * to re-split across the boundary and collide, since `detail` is free text a
 * gate wrote. U+001F is exactly as unlikely in that text as NUL is, and it is
 * verified the same way (see the collision test in gate-fix-loop.test.ts). The
 * DIGEST VALUES all changed, and nothing observes them: `fingerprint` is called
 * once, at one site in `runGateFixLoop`, compared only against the previous
 * round's value in a local variable, never logged, never returned on
 * `GateFixLoopResult`, and never written to disk or the store. The invariant is
 * the equality relation between two values produced by one process, not the
 * bytes, so no persisted value can disagree with a new one.
 */
export function fingerprint(report: AgentVisibleReport): string {
  const hash = createHash("sha256");
  for (const failure of [...report.failures].sort((a, b) => `${a.klass}${a.id}`.localeCompare(`${b.klass}${b.id}`))) {
    hash.update(`${failure.klass}\u001F${failure.id}\u001F${failure.detail}\u001F`);
  }
  hash.update(
    `unmet:${String(report.heldOutUnmet.BLOCKING)}/${String(report.heldOutUnmet.FUNCTIONAL)}/` +
      `${String(report.heldOutUnmet.QUALITY)}`,
  );
  return hash.digest("hex");
}

const EMPTY_REPORT: AgentVisibleReport = {
  failures: [],
  heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
  infraFailure: "the loop never ran",
};

export async function runGateFixLoop(request: GateFixLoopRequest): Promise<GateFixLoopResult> {
  const log = request.log ?? ((): void => undefined);
  const cap = Math.max(1, Math.trunc(request.maxAttempts));
  /**
   * READ AS A CALL, NOT AS A PROPERTY. `request.signal?.aborted === true`
   * inlined three times compiles to three checks that TypeScript narrows to
   * `false | undefined` after the first one — it treats the field as immutable
   * and reports the later checks as comparisons that can never hold (TS2367).
   * The value is precisely the one thing here that changes underneath us. A
   * function call cannot be narrowed, so each check reads the signal again.
   */
  const aborted = (): boolean => request.signal?.aborted === true;
  const now = request.now ?? Date.now;
  const budget = request.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const deadline = now() + budget;
  const abortCause = request.abortCause ?? ((): "owner-cancelled" => "owner-cancelled");
  let attempt = 0;
  let previous: string | null = null;
  let report: AgentVisibleReport = EMPTY_REPORT;
  let denied: readonly FixTask[] = [];
  let detail: string | null = null;
  const progress: ProgressPair[] = [];

  const stop = (cause: StopCause): GateFixLoopResult => ({
    passed: cause === "green",
    attempts: attempt,
    reason: REASON_OF[cause],
    cause,
    report,
    deniedTasks: denied,
    detail,
  });

  /**
   * OUT OF TIME — but never before the first gate has run.
   *
   * A budget that could stop the loop at `attempt === 0` would return a run with
   * no verdict at all, which is strictly worse than a run that overran: "the
   * gate could not run" and "the gate says no" must not look alike anywhere in
   * this program. The `attempt > 0` guard is that, and it also means a budget
   * misconfigured to something tiny still buys exactly one honest measurement.
   */
  const outOfTime = (): boolean => attempt > 0 && now() >= deadline;

  for (;;) {
    if (aborted()) return stop(abortCause());
    /**
     * CHECKED AT THE HEAD, AND THAT IS A BOUND ON ROUNDS STARTED, NOT A TIMEOUT.
     * Say it plainly rather than let the constant imply more than it does:
     * `request.runFix` is an injected call this loop cannot interrupt — it takes
     * no signal and returns when the agent is done — so a single fix round that
     * hangs for nine hours is not caught here. It is caught by whatever bounds
     * the agent call itself, which is the caller's, and the shape of that
     * failure has been observed: the one overnight attempt stalled 8h39m INSIDE
     * a segment, emitting no events, before this loop ever ran.
     *
     * What this does bound is the thing it can see: no NEW gate and no NEW fix
     * round begins once the budget is spent.
     */
    const preflight = await request.preGate?.(attempt + 1) ?? null;
    if (preflight !== null) {
      detail = preflight.detail;
      log(
        "error",
        `gate preflight stopped before attempt ${String(attempt + 1)}: ${preflight.detail}`,
      );
      return stop(preflight.cause);
    }
    if (outOfTime()) {
      log(
        "warn",
        `stopping at the ${String(Math.round(budget / 60_000))}-minute wall-clock budget after ` +
          `${String(attempt)} attempt(s); what is still broken goes to the backlog`,
      );
      return stop("time-budget");
    }
    attempt += 1;

    report = toAgentVisible(await request.gate(attempt));

    // INFRA FIRST. `infrastructureErrors` (and a missing result) mean the SCORER
    // failed — a browser that would not launch, an unreadable mount. Entering
    // the loop here burns quota fixing a problem the artefact does not have, and
    // the run has no verdict either way.
    if (report.infraFailure !== null) {
      // CANCELLATION WINS. A gate that was interrupted produces no result, which
      // is indistinguishable from a gate that broke — and "the owner cancelled
      // this" reported as "the scorer failed" is a fault attributed to the
      // machine that the machine did not have.
      if (aborted()) return stop(abortCause());
      log("error", `the sealed gate could not produce a result: ${report.infraFailure}`);
      return stop("infra");
    }

    if (isGreen(report)) {
      log("info", `the gate is green after ${String(attempt)} attempt(s)`);
      return stop("green");
    }

    log(
      "warn",
      `gate attempt ${String(attempt)}: ${String(report.failures.length)} failure(s), ` +
        `${String(unmetTotal(report))} unmet criteri${unmetTotal(report) === 1 ? "on" : "a"}`,
    );

    const current = fingerprint(report);
    if (previous !== null && current === previous) {
      log("warn", "the same failures came back unchanged after a fix round — stopping rather than repeating it");
      return stop("identical-report");
    }
    previous = current;

    // THE ORDINAL WINDOW, AFTER THE BYTE-IDENTICAL CATCH AND BEFORE THE CAP.
    // After the fingerprint because a literal repeat is the more specific fact
    // and deserves the more specific cause; before the cap because "two fix
    // rounds bought nothing" tells the owner more than "we ran out of rounds",
    // and at `DEFAULT_MAX_ATTEMPTS = 3` both would otherwise fire on the same
    // round.
    progress.push(progressOf(report));
    if (progress.length >= NO_PROGRESS_WINDOW) {
      const earlier = progress[progress.length - NO_PROGRESS_WINDOW];
      const latest = progress[progress.length - 1];
      if (earlier !== undefined && latest !== undefined && !improved(latest, earlier)) {
        log(
          "warn",
          `${String(NO_PROGRESS_WINDOW)} gate rounds with no reduction in either unmet gating criteria ` +
            `(${String(earlier.gating)} -> ${String(latest.gating)}) or failures ` +
            `(${String(earlier.failures)} -> ${String(latest.failures)}) — stopping rather than buying a fourth`,
        );
        return stop("no-progress");
      }
    }

    if (attempt >= cap) {
      log("warn", `stopping at the attempt cap (${String(cap)}); what is still broken goes to the backlog`);
      return stop("attempt-cap");
    }

    const split = partitionByPermission(planFixes(report), request.allowedAgents);
    denied = split.denied;
    for (const task of split.denied) {
      log(
        "warn",
        `${String(task.failures.length)} failure(s) route to ${task.agent}, which this run's delegation ` +
          "shortlist does not permit. They are recorded in the backlog rather than attempted.",
      );
    }

    if (split.runnable.length === 0) {
      // Re-gating now would produce the identical report and consume the whole
      // budget one round at a time, which reads in the log as a fixer that tried
      // and failed rather than as work nothing could pick up.
      //
      // AND IT IS A PERMISSIONS FAULT, NOT A CONVERGENCE ONE. `not-converging`
      // is a statement about a fixer that tried; here nothing was allowed to
      // try. The distinction is the whole point of `no-permitted-fixer`, and it
      // is the shape a visual failure takes on a run whose shortlist has no
      // design lane: the gate has an opinion the run has nobody to act on it.
      log(
        "warn",
        `no fix task could be run for this report — every planned task routes to an agent this run's ` +
          `delegation shortlist denies (${split.denied.map((t) => t.agent).join(", ")}). Stopping instead ` +
          "of re-gating an unchanged build.",
      );
      return stop("no-permitted-fixer");
    }

    for (const task of split.runnable) {
      if (aborted()) return stop(abortCause());
      // THE BUDGET IS RE-READ BEFORE EACH FIX ROUND, not only at the loop head.
      // The head check happens before a gate that itself costs time; a task list
      // several agents long can cross the deadline between the first spawn and
      // the last, and starting a fresh agent after the budget is spent is
      // exactly what the budget exists to stop.
      if (outOfTime()) {
        log(
          "warn",
          `the ${String(Math.round(budget / 60_000))}-minute wall-clock budget was spent partway through ` +
            `fix round ${String(attempt)}; the remaining task(s) go to the backlog unstarted`,
        );
        return stop("time-budget");
      }
      const prompt = buildFixPrompt({ task, report, workspace: request.workspace, attempt, maxAttempts: cap });
      log("info", `fix round ${String(attempt)}: ${task.agent} on ${String(task.failures.length)} failure(s)`);
      await request.runFix(task, prompt, attempt);
    }

    if (aborted()) return stop(abortCause());
  }
}
