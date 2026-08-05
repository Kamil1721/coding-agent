/**
 * recovery.ts — WHETHER A STOPPED RUN MAY CONTINUE ITSELF, AND IF SO WHEN.
 *
 * The owner's constraint, in his words: "context loss is not ok, using up a lot
 * of tokens is", and "the agent should be self maintaining". A run that dies of
 * something time or a restart would cure should carry on by itself; the 12-hour
 * run of 2026-07-30 and the 52-minute run of 2026-08-04 were both thrown away
 * because nothing here could decide that. This module is that decision and
 * nothing else.
 *
 * WHY IT IS A SEPARATE FILE WITH NO IMPORTS. It has no `Orchestrator`, no
 * `RunStore`, no filesystem, no `Date.now()` and no `setTimeout`. `now` arrives
 * as a string, the wait comes back as a number, and the caller owns the timer.
 * That is deliberate and it is the same bargain `planRateLimitResume`
 * (orchestrator.ts:717) and `cron-policy.ts` already struck here: A DECISION
 * THAT CAN ONLY BE OBSERVED BY SPENDING THE OWNER'S QUOTA IS A DECISION NOBODY
 * CHECKS. Every arm below — including a five-day wait — is reachable from a unit
 * test in under a millisecond, and `recovery.test.ts` reaches all of them.
 *
 * THE DEFAULT IS STOP. Everywhere. An unrecognised failure, a missing signal, a
 * number that does not parse, a class this module has never seen: all of them
 * return `stop` with a reason fit to show the owner. The failure this repo
 * should fear is not a run that gives up too early — the owner can press Resume
 * — it is a run that re-enters an expensive phase for ever while nobody is
 * watching. An unknown failure that loops is strictly worse than one that stops.
 *
 * WHAT IT DELIBERATELY REFUSES TO DECIDE:
 *
 *  - WHETHER THE PROVIDER'S WINDOW ACTUALLY DRAINED. Nothing can know that; the
 *    only evidence is the next call being accepted. This computes the wait the
 *    provider itself reported and stops there (`planRateLimitResume` says the
 *    same about itself, :713-715).
 *  - WHO INCREMENTS THE COUNTER. `autoContinueCount` is an input. The reviewer's
 *    first finding on the design was that a cap whose counter nothing increments
 *    is dead code, so this module takes the number and enforces it, and the
 *    caller must be able to point at the line that moves it. See
 *    {@link mayAutoContinue}'s docblock.
 *  - WHETHER THE RUN IS RESUMABLE AT ALL. Terminal rows, the active run, the
 *    queue: all `resume()`'s business (orchestrator.ts:1391).
 *  - WHAT A FAILURE MEANS FROM ITS MESSAGE. See {@link throttleHintFromMessage}:
 *    the one prose match in this file is exported for the SEAT layer to call,
 *    and the classifier physically cannot see a message.
 */

/* =========================================================================
 * 1. The classes
 * ====================================================================== */

/**
 * What kind of failure this was, decided from structured signals only.
 *
 * ORDER OF EVALUATION IS LOAD-BEARING and is asserted by test: intentional,
 * interrupted, structural, throttled, transient, unclassified. A classifier that
 * asked "was it rate limited?" before "did the owner cancel it?" would restart
 * runs the owner deliberately killed — `run-…-c228e63b` in the real store died
 * with `Claude Code process aborted by user`, and orchestrator.ts:1815-1817
 * already records the lesson in its own words: check the SIGNAL, not the
 * message.
 *
 *  - `intentional` — the owner cancelled, or the server is shutting down. Bound
 *    0: a run somebody stopped on purpose must never restart itself.
 *  - `interrupted` — the process died under a run that was working. Nothing is
 *    wrong with the run. Bound {@link AUTO_CONTINUE_MAX}, and the counter is the
 *    crash-loop brake: boot → queue → start → crash → boot has no other one.
 *  - `structural` — a byte-identical retry is futile. The harness converts an
 *    exhausted call-level ladder into a `BakeoffError` before it leaves
 *    (spec-agent.ts:1200-1211 throws `invalid_usage_shape` with the remediation
 *    "regenerating cannot fix it — there is no higher max_tokens to retry at").
 *    Bound 0 is what keeps the phase level from re-spending what the call level
 *    already spent; the two levels never attempt the same thing, so there is no
 *    shared counter and no "retries 9 times, reports 3".
 *  - `throttled` — the provider refused; time is the only fix. Bound
 *    {@link AUTO_CONTINUE_MAX}, plus a wait ceiling (§{@link RECOVERY_MAX_AUTO_WAIT_MS}).
 *  - `transient` — a fault a byte-identical retry could survive. **NO REAL
 *    ERROR MAPS TO THIS TODAY**; see {@link SeatFailureKind} and
 *    {@link TRANSIENT_MAX}. The arm exists and is tested by injection.
 *  - `unclassified` — everything else. Bound 0, always recorded. This is the
 *    evidence channel: the next real fault this program has never seen arrives
 *    here with its full description instead of being guessed at.
 */
export type FailureClass =
  | "intentional"
  | "interrupted"
  | "structural"
  | "throttled"
  | "transient"
  | "unclassified";

/* =========================================================================
 * 2. The bounds
 * ====================================================================== */

/**
 * How many times a run may continue ITSELF, across all classes together.
 *
 * ONE COUNTER FOR EVERY CLASS, because the failure mode to fear is not three
 * throttles — it is a run bouncing between classes for ever: throttled, wait,
 * resume, restart, interrupted, requeue, throttled again. A run that waited out
 * one window and was then interrupted by a restart has ONE continuation left,
 * and its log says so.
 *
 * THREE, AND WHY THREE. It is the number the existing throttle ladder already
 * uses (`RATE_LIMIT_AUTO_RESUME_MAX_RESUMES`, orchestrator.ts:663) and its
 * reasoning carries: one reported `resetsAt` cannot tell a 5-hour rollover from
 * the weekly cap, so under a weekly cap the reported instant is minutes away
 * while the real refusal is days long. An unbounded arm would resume, be
 * refused, re-arm, and grind through the quota in short steps for a week. Three
 * re-entries, then a human.
 *
 * IT IS NOT `resumeCount`, AND THAT IS THE POINT. `resumeCount` counts the
 * owner's own presses of Resume too (orchestrator.ts:1546), so binding automatic
 * continuation to it means a run the owner nursed by hand three times can never
 * continue itself. The two numbers answer different questions. THE COROLLARY THE
 * CALLER MUST NOT SKIP: a separate counter needs a separate increment site, and
 * if nothing increments it this cap is dead code and the run continues for ever.
 * See {@link mayAutoContinue}.
 */
export const AUTO_CONTINUE_MAX = 3;

/**
 * The bound for `transient`, and it is REASONED, NOT MEASURED — the same honesty
 * `DEFAULT_SILENCE_WARN_MIN` applies to its own n = 1.
 *
 * The evidence base contains ZERO observed transients: four runs, three
 * failures, none from a network fault or a 5xx. Two is "enough for a blip, few
 * enough that a systematic fault stops quickly", and nothing on this machine
 * supports a stronger claim than that.
 */
export const TRANSIENT_MAX = 2;

/**
 * The per-class ceiling, checked against the ONE counter of
 * {@link AUTO_CONTINUE_MAX}.
 *
 * Bound 0 is not "off pending configuration"; it is a statement that continuing
 * cannot help. `structural` means the layer that still had the evidence declared
 * the retry futile; `intentional` means a human said stop; `unclassified` means
 * nobody here knows what happened, which is the case that must never loop.
 */
export function boundFor(klass: FailureClass): number {
  switch (klass) {
    case "intentional":
      return 0;
    case "structural":
      return 0;
    case "unclassified":
      return 0;
    case "throttled":
      return AUTO_CONTINUE_MAX;
    case "interrupted":
      return AUTO_CONTINUE_MAX;
    case "transient":
      return TRANSIENT_MAX;
  }
}

/* =========================================================================
 * 3. The two wait ceilings, which are different ceilings
 * ====================================================================== */

/**
 * The longest delay a timer on this platform can hold, and the reason a longer
 * one is REFUSED rather than clamped.
 *
 * `setTimeout` keeps its delay in a signed 32-bit integer: a delay above
 * 2_147_483_647 ms does not wait longer, it FIRES IMMEDIATELY (Node prints
 * `TimeoutOverflowWarning` and substitutes 1 ms). For this feature that is the
 * worst possible inversion — a run that should wait 115 days would continue in a
 * millisecond, unattended, into a window that is certainly still shut. A wait
 * this program cannot represent is a wait it must not claim.
 *
 * Mirrors `RATE_LIMIT_RESUME_MAX_DELAY_MS` (orchestrator.ts:647) deliberately:
 * same number, same reason, and this module is where the wait is computed once
 * so the two cannot drift.
 */
export const RECOVERY_TIMER_MAX_DELAY_MS = 2_147_483_647;

/**
 * The longest wait this server will hold UNATTENDED, and why it is a separate
 * ceiling from {@link RECOVERY_TIMER_MAX_DELAY_MS}.
 *
 * That one refuses a delay the PROGRAM cannot hold. This one refuses a delay the
 * OWNER did not agree to hold. The distinction matters because the delays this
 * machine actually records sail straight through the 32-bit guard: every
 * `rate_limit` frame in `runs.db` as of 2026-08-05 reports kind `seven_day` with
 * a reset 2.2-5.0 DAYS out — about 4.3e8 ms, comfortably representable. Without
 * a second ceiling the first real refusal arms a five-day unattended timer and
 * nothing on the wire says so.
 *
 * SIX HOURS, AND THE HONEST CONSEQUENCE OF SIX HOURS. It covers a five-hour
 * rolling window plus slack, which is the wait the owner called cheap. It also
 * REFUSES EVERY WINDOW THIS MACHINE HAS EVER RECORDED, because all of them are
 * `seven_day`. So on today's evidence a throttled run parks and says how long it
 * would have had to wait, rather than waiting: that is a deliberate default, not
 * an accident, and it is why {@link RECOVERY_MAX_WAIT_ENV} exists and why the
 * refusal names it. An owner who wants the seven-day wait held automatically
 * sets `DASHBOARD_RECOVERY_MAX_WAIT_MIN=10080` and gets it. Nobody gets it by
 * default without deciding.
 */
export const RECOVERY_MAX_AUTO_WAIT_MS = 6 * 60 * 60 * 1_000;

/** Minutes. Overrides {@link RECOVERY_MAX_AUTO_WAIT_MS}. */
export const RECOVERY_MAX_WAIT_ENV = "DASHBOARD_RECOVERY_MAX_WAIT_MIN";

/**
 * Read the unattended ceiling from the environment.
 *
 * UNPARSEABLE IS THE DEFAULT, NOT AN ERROR, and not "no ceiling". A typo in a
 * launchd plist must not enrol a machine into a multi-day unattended wait, so
 * every value this cannot read as a positive finite number of minutes falls back
 * to {@link RECOVERY_MAX_AUTO_WAIT_MS}.
 *
 * IT IS ALSO CLAMPED to {@link RECOVERY_TIMER_MAX_DELAY_MS}: a configured
 * ceiling above what a timer can hold would let a delay past the 32-bit arm and
 * straight into "fires immediately", which is the one inversion neither ceiling
 * may permit.
 */
export function recoveryMaxWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = (env[RECOVERY_MAX_WAIT_ENV] ?? "").trim();
  if (raw === "") return RECOVERY_MAX_AUTO_WAIT_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return RECOVERY_MAX_AUTO_WAIT_MS;
  return Math.min(Math.round(minutes * 60_000), RECOVERY_TIMER_MAX_DELAY_MS);
}

/**
 * How long to hold a `transient` before trying again. REASONED, NOT MEASURED —
 * see {@link TRANSIENT_MAX}; zero transients have ever been observed here.
 *
 * It is not zero because an immediate retry of a fault that lasts a second is
 * two failures instead of one, and it is not minutes because a fault that lasts
 * minutes is not what this class is for.
 */
export const TRANSIENT_BACKOFF_MS = 30_000;

/* =========================================================================
 * 4. The signals
 * ====================================================================== */

/**
 * What kind of failure the seat layer decided it was, at the layer that still
 * had the evidence.
 *
 * `transport` HAS NO PRODUCER IN THIS PROGRAM AND THAT IS THE DECISION, not an
 * oversight. On the subscription path there is no structured way to tell a 503
 * from an expired auth session: the seat drives the Claude CLI as a subprocess
 * through the agent SDK, so a thrown failure carries no status code, no
 * `Retry-After` and no typed error — only a message. The residual is therefore
 * assigned `unknown`, and `unknown` never continues. Mapping the residual into
 * `transport` would retry auth expiry, retry harness bugs, and retry things
 * nobody has ever seen, unattended, on the owner's quota. The `transient` arm
 * ships with an EMPTY ALLOW-LIST: it exists, it is bounded, it is unit-tested by
 * injecting the kind, and no real error reaches it until something earns the
 * signal.
 */
export type SeatFailureKind = "throttled" | "protocol" | "transport" | "unknown";

/**
 * The provider's refusal AS IT ACCOMPANIED THIS FAILURE.
 *
 * READ THE FIELD NAMES AND THEN READ THIS, BECAUSE THE OBVIOUS WIRING IS WRONG.
 * `observedAt`/`retryAfterSec` must be the reading carried from the throw site
 * (the build and gate paths already do exactly this — orchestrator.ts:1850,
 * :1875 pass `outcome.rateLimit` / `loop.rateLimit`). They must NOT be
 * `runs.rate_limit_retry_after_sec` and `runs.rate_limited`, which are ROUTINE
 * TELEMETRY: `#noteRateLimit` overwrites them on every `rate_limit` frame,
 * including the `limited:false` ones that merely report a window filling, and
 * `runs.rate_limited` is never reset within a run. Classify off those and a
 * plan-phase rejected frame makes an unrelated spec-phase harness fault look
 * throttled, arms off a stale instant, and spends quota reproducing a failure
 * that had nothing to do with rate limits — while the log and the wire both say
 * "rate limited". `RateLimitResumeInput.rateLimitedAt`'s docblock
 * (orchestrator.ts:672-677) was written to prevent exactly this inversion; this
 * type is that docblock turned into a shape the caller cannot get wrong by
 * accident.
 */
export interface RefusalEvidence {
  /** True only when the provider REFUSED this call. `limited:false` is telemetry. */
  readonly limited: boolean;
  /** Seconds until the window reopens, or null when the provider did not say. */
  readonly retryAfterSec: number | null;
  /** e.g. "five_hour", "seven_day". Verbatim from the provider, or null. */
  readonly kind: string | null;
  /** ISO instant of the refusal itself. Null when nothing recorded it. */
  readonly observedAt: string | null;
}

/**
 * Everything the classifier is allowed to know. STRUCTURED ONLY.
 *
 * THERE IS NO `message` FIELD AND THERE MUST NEVER BE ONE. The 2026-08-04 death
 * carried "Claude's response exceeded the 64000 output token maximum"; a
 * message-keyed retry would re-run a 50-minute spec phase against a ceiling that
 * cannot move, three times, and report one attempt. The CLI's abort wording is
 * identical whoever aborted, too. The rule "the orchestrator never matches on
 * prose" is enforced here by the shape of this type rather than by discipline.
 */
export interface PhaseFailureSignals {
  /** `signal.aborted`. */
  readonly aborted: boolean;
  /** `abortReasonOf(signal)` — compared against the exported constants, never parsed. */
  readonly abortReason: "cancelled" | "shutdown" | null;
  /**
   * The process died under a run that was still working — the boot path's
   * signal, derived from a row that says `running` when nothing is running. It
   * comes from the row's own status and from nothing else, because
   * `#abandonedForShutdown` deliberately writes no terminal state
   * (orchestrator.ts:5714-5731).
   */
  readonly interrupted: boolean;
  /**
   * `error.code` when the throw was a `BakeoffError`, else null. ANY non-null
   * value is `structural`; this is not matched against a list of codes. A list
   * would silently drop a code added later, and the point of the harness's error
   * type is that it only exists for failures it has already declared clean and
   * unrecoverable.
   */
  readonly bakeoffCode: string | null;
  /** {@link SeatFailureKind} when the throw was a `SeatCallError`, else null. */
  readonly seatKind: SeatFailureKind | null;
  /** {@link RefusalEvidence} carried from the throw site, or null. */
  readonly refusal: RefusalEvidence | null;
}

/**
 * The two `AbortSignal.reason` values this program uses, COPIED rather than
 * imported.
 *
 * They are `ABORT_CANCELLED` / `ABORT_SHUTDOWN` at orchestrator.ts:449-450.
 * Importing them would make this module depend on the orchestrator — the one
 * thing it must not do — so instead the copy is guarded: `recovery.test.ts`
 * imports the originals and asserts these equal them. A rename over there turns
 * that test red instead of silently reclassifying every cancellation as an
 * unknown fault.
 */
export const RECOVERY_ABORT_CANCELLED = "cancelled";
export const RECOVERY_ABORT_SHUTDOWN = "shutdown";

/** A failure with no signals at all: the shape every helper starts from. */
const NO_SIGNALS: PhaseFailureSignals = {
  aborted: false,
  abortReason: null,
  interrupted: false,
  bakeoffCode: null,
  seatKind: null,
  refusal: null,
};

/**
 * The signals for a run found `running` at boot with no process under it.
 *
 * Exported because the boot sweep has no `Error` to hand to {@link signalsFor} —
 * there was no throw, the process simply stopped existing — and inventing one
 * would be the kind of fiction this module is meant to remove.
 */
export function interruptedSignals(): PhaseFailureSignals {
  return { ...NO_SIGNALS, interrupted: true };
}

/**
 * THE ONE PLACE IN THIS PROGRAM THAT LOOKS AT AN ERROR MESSAGE, AND IT IS
 * FRAGILE. Named so, exported so, and kept out of the classifier's reach.
 *
 * WHY IT EXISTS AT ALL. The subscription seat does not speak HTTP. When the
 * agent SDK throws instead of returning a result frame there is no status code,
 * no `Retry-After` header and no typed error; the only thing that survives is
 * `Error.message`. `subscription-caller.ts:2122` already guesses from prose for
 * that reason. This is the same regex, moved somewhere it can be tested and
 * pointed at.
 *
 * WHERE IT MAY BE CALLED. In the SEAT layer, to convert a guess into a typed
 * {@link SeatFailureKind} exactly once. Everything upstream reads the type.
 * {@link signalsFor} does NOT call it and {@link classifyPhaseFailure} cannot —
 * {@link PhaseFailureSignals} has no message field. So a prose match can decide
 * "call this throttled"; it can never, by itself, decide "re-enter a 50-minute
 * phase".
 *
 * WHAT IT IS NOT ALLOWED TO MATCH, asserted by test: the 2026-08-04 overflow
 * death ("exceeded the 64000 output token maximum") and the abort wording
 * ("aborted by user"). If a future edit widens this regex until either matches,
 * the test goes red rather than the owner's quota going down.
 */
export function throttleHintFromMessage(message: string): boolean {
  return /rate.?limit|429|usage limit/i.test(message);
}

/**
 * Extract the structured signals from whatever a phase threw. PURE, and the only
 * function here that touches an `Error` at all.
 *
 * IT TAKES THE REFUSAL AS AN ARGUMENT AND NOT A `RunRow`, deliberately — see
 * {@link RefusalEvidence}. Passing the row would put the classifier one field
 * access away from the telemetry columns that misclassify.
 *
 * ERROR IDENTITY IS BY SHAPE, NOT `instanceof`. `BakeoffError` and
 * `SeatCallError` live in `bakeoff/`, which this module does not import: a pure
 * policy file that drags in the harness is a policy file that cannot be tested
 * without building the harness, and `instanceof` across two loaded copies of a
 * module is false in exactly the cases that matter. Both classes set `name` in
 * their constructors (contracts.ts:82, anthropic-seat.ts:93) and both carry
 * `remediation`, so the shape is a stronger check here than the prototype is.
 */
export function signalsFor(
  error: unknown,
  signal: AbortSignal | null,
  refusal: RefusalEvidence | null,
): PhaseFailureSignals {
  const aborted = signal !== null && signal.aborted;
  const abortReason: "cancelled" | "shutdown" | null = !aborted
    ? null
    : signal.reason === RECOVERY_ABORT_SHUTDOWN
      ? "shutdown"
      : "cancelled";

  const shape = error as { name?: unknown; code?: unknown; kind?: unknown; remediation?: unknown } | null;
  const named = typeof shape?.name === "string" ? shape.name : "";
  const bakeoffCode =
    named === "BakeoffError" && typeof shape?.code === "string" && typeof shape.remediation === "string"
      ? shape.code
      : null;
  const seatKind =
    named === "SeatCallError" && isSeatFailureKind(shape?.kind) ? (shape?.kind as SeatFailureKind) : null;

  return { aborted, abortReason, interrupted: false, bakeoffCode, seatKind, refusal };
}

function isSeatFailureKind(value: unknown): boolean {
  return value === "throttled" || value === "protocol" || value === "transport" || value === "unknown";
}

/* =========================================================================
 * 5. The classifier
 * ====================================================================== */

/**
 * Which class of failure this was. Order is load-bearing; see
 * {@link FailureClass}.
 *
 * `protocol` IS `structural`, NOT `transient`. The one producer today is the
 * SDK's `error_max_turns` result subtype: retrying identically re-hits the same
 * turn cap, and the seat's own remediation tells the operator to raise
 * `SEAT_MAX_TURNS_ENV`. Turning that into a call-level rung is a reasonable
 * future change and is somebody else's.
 *
 * A THROTTLE NEEDS EVIDENCE THAT THE PROVIDER REFUSED *THIS* CALL: either the
 * seat typed it `throttled`, or a {@link RefusalEvidence} with `limited: true`
 * came along with the failure. `limited: false` is a window-filling report and
 * is not a refusal.
 */
export function classifyPhaseFailure(s: PhaseFailureSignals): FailureClass {
  // 1. INTENTIONAL FIRST, unconditionally. A run somebody stopped is not a run
  //    to reason about: cancel and shutdown both abort the same signal, and the
  //    error that surfaces from an aborted CLI is indistinguishable from a
  //    crash by its text.
  if (s.aborted) return "intentional";

  // 2. INTERRUPTED, which is not an error at all — it is a row that says
  //    `running` with nothing running. It cannot coexist with a throw, and it is
  //    checked here so that a stale `refusal` on the row can never turn a
  //    restart into a multi-day wait.
  if (s.interrupted) return "interrupted";

  // 3. STRUCTURAL BEFORE THROTTLED. A `BakeoffError` thrown while the run
  //    happened to be near a rate limit is still futile to retry, and this
  //    ordering is what stops the phase level from re-spending a ladder the call
  //    level already exhausted and declared dead.
  if (s.bakeoffCode !== null) return "structural";
  if (s.seatKind === "protocol") return "structural";

  // 4. THROTTLED, on this call's own evidence.
  if (s.seatKind === "throttled") return "throttled";
  if (s.refusal !== null && s.refusal.limited) return "throttled";

  // 5. TRANSIENT. Empty allow-list by design — see {@link SeatFailureKind}.
  if (s.seatKind === "transport") return "transient";

  // 6. EVERYTHING ELSE, INCLUDING `unknown`. Bound 0. This is the runaway guard:
  //    a fault nobody here recognises is recorded in full and stopped, never
  //    retried on a hunch.
  return "unclassified";
}

/* =========================================================================
 * 6. The bound, as an outcome rather than an exception
 * ====================================================================== */

export type BoundVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RecoveryStopCode; readonly reason: string };

export interface RecoveryBoundInput {
  readonly klass: FailureClass;
  /**
   * How many times THIS RUN has already continued ITSELF. Not `resumeCount` —
   * see {@link AUTO_CONTINUE_MAX}.
   *
   * THE CALLER MUST BE ABLE TO NAME THE LINE THAT INCREMENTS IT, and that line
   * must be at the moment a continuation is COMMITTED TO (the arming of the
   * timer, the requeue at boot) rather than inside `resume()`, which the owner's
   * own button also calls, and not on every server restart, which would let
   * three restarts during development exhaust the budget of every live run. A
   * cap read from a counter nothing moves is not a cap.
   */
  readonly autoContinueCount: number;
  readonly enabled: boolean;
}

/**
 * May this run continue itself once more? Exhausting the bound is an OUTCOME
 * with its own sentence, never a throw: the caller is a park path that must
 * carry on parking either way, and the reason is the product — it goes onto the
 * run's own log at the moment of the refusal so a run that is going to sit there
 * until morning SAYS so when it stops instead of going quiet.
 */
export function mayAutoContinue(i: RecoveryBoundInput): BoundVerdict {
  const bound = boundFor(i.klass);
  if (bound === 0) {
    return { ok: false, code: "class_terminal", reason: terminalClassReason(i.klass) };
  }
  if (!i.enabled) {
    return {
      ok: false,
      code: "disabled",
      reason:
        `automatic recovery is opt-in and is off. Set ${RECOVERY_ENABLED_ENV}=1 to let a run continue ` +
        `itself after a ${i.klass} failure; until then a human has to resume this run — nothing will do ` +
        `it for them.`,
    };
  }
  if (!Number.isFinite(i.autoContinueCount) || i.autoContinueCount < 0) {
    return {
      ok: false,
      code: "cap_reached",
      reason:
        `the run's automatic-continuation count is not a usable number ` +
        `(${String(i.autoContinueCount)}), so the cap cannot be enforced. Continuing without a working ` +
        `cap is how an unattended run spends without bound, so this stops and a human has to resume it.`,
    };
  }
  if (i.autoContinueCount >= bound) {
    return {
      ok: false,
      code: "cap_reached",
      reason:
        `this run has already continued itself ${String(i.autoContinueCount)} time(s) and the cap for a ` +
        `${i.klass} failure is ${String(bound)}. The work is kept and the run resumes the moment you ` +
        `press Resume; nothing further happens by itself.`,
    };
  }
  return { ok: true };
}

function terminalClassReason(klass: FailureClass): string {
  switch (klass) {
    case "intentional":
      return (
        "this run was stopped on purpose — cancelled, or caught by a server shutdown. Nothing restarts a " +
        "run somebody stopped; press Resume if that is what you want."
      );
    case "structural":
      return (
        "the failure is one the layer that saw it declared unrecoverable, so an identical retry cannot " +
        "succeed. Re-running it would spend the same time and end the same way. Read the remediation on " +
        "the error and change something first."
      );
    case "unclassified":
      return (
        "nothing here recognises this failure, so nothing here can say a retry would help. An unrecognised " +
        "failure is recorded in full and stopped rather than retried on a hunch — the full description is " +
        "on the run's attempt record, and it is what a signal for this case would be built from."
      );
    // Classes with a non-zero bound never reach here; the switch is exhaustive so
    // that adding a class without deciding its bound fails to compile.
    case "throttled":
    case "interrupted":
    case "transient":
      return `a ${klass} failure has a non-zero bound and does not have a terminal reason`;
  }
}

/* =========================================================================
 * 7. The decision
 * ====================================================================== */

/**
 * The flag. DEFAULT OFF, and unrecognised values are OFF, which inverts
 * `designLockPolicy`'s rule for the same reason `RATE_LIMIT_AUTO_RESUME_ENV`
 * does (orchestrator.ts:619-622): there the safe direction is the one that ENDS
 * a park; here the safe direction is the one that does not SPEND, so a typo in a
 * launchd plist cannot enrol a machine into unattended quota burn.
 */
export const RECOVERY_ENABLED_ENV = "DASHBOARD_AUTO_RECOVER";

const RECOVERY_ENABLED_ON: readonly string[] = ["1", "true", "yes", "on"];

export function autoRecoverEnabled(env: NodeJS.ProcessEnv): boolean {
  return RECOVERY_ENABLED_ON.includes((env[RECOVERY_ENABLED_ENV] ?? "").trim().toLowerCase());
}

/**
 * Why a `stop` stopped. The prose in `reason` is for the owner; this is for the
 * caller and for the tests, so a control can assert WHICH arm refused rather
 * than pattern-matching English that is free to be rewritten.
 */
export type RecoveryStopCode =
  | "class_terminal" // bound 0: intentional, structural, unclassified
  | "disabled" // the flag is off
  | "cap_reached" // autoContinueCount >= bound
  | "no_refusal" // classified throttled with no refusal evidence attached
  | "no_retry_after" // the provider named no reset instant
  | "retry_after_not_future" // it named one that had already passed
  | "no_refusal_instant" // nothing recorded WHEN the refusal happened
  | "wait_unrepresentable" // longer than a 32-bit timer
  | "wait_too_long"; // longer than this server waits unattended

/**
 * Continue now, continue after a wait, or stop — and in every case, why.
 *
 * `firesAt` IS AN INSTANT, NOT A DURATION, because a duration on the wire is
 * stale the moment it is sent and a countdown rendered from a stale duration is
 * a lie that gets worse with every second the page is open.
 */
export type RecoveryDecision =
  | { readonly kind: "continue"; readonly klass: FailureClass; readonly reason: string }
  | {
      readonly kind: "wait";
      readonly klass: FailureClass;
      readonly delayMs: number;
      readonly firesAt: string;
      readonly reason: string;
    }
  | {
      readonly kind: "stop";
      readonly klass: FailureClass;
      readonly code: RecoveryStopCode;
      readonly reason: string;
    };

export interface RecoveryInput {
  readonly signals: PhaseFailureSignals;
  /** See {@link RecoveryBoundInput.autoContinueCount}. */
  readonly autoContinueCount: number;
  /** {@link autoRecoverEnabled}. */
  readonly enabled: boolean;
  /** ISO. The caller's clock, so a five-day wait is testable in a millisecond. */
  readonly now: string;
  /** {@link recoveryMaxWaitMs}. Passed in so the ceiling is visible in every test. */
  readonly maxWaitMs: number;
}

/**
 * THE ONE ENTRY POINT. Classify, bound, and — for a throttle — compute the wait.
 *
 * ONE WAIT COMPUTATION, ON PURPOSE. The design this implements calls for
 * `planRateLimitResume` to be EXTENDED rather than duplicated, for the reason
 * that two ladders drift and then a run retries nine times and reports three.
 * This module owns the computation; the caller in `orchestrator.ts` should
 * delegate to it rather than keep a second copy. Its arms are deliberately the
 * same arms in the same order as `planRateLimitResume` (:717-780) so the
 * delegation is a substitution and not a behaviour change: enabled, then the
 * refusal's own numbers, then the instant, then the cap, then the 32-bit
 * ceiling — with the unattended ceiling added after the 32-bit one.
 *
 * TWO ORDERING DECISIONS WORTH THE WORDS:
 *
 *  - THE CAP IS CHECKED BEFORE THE WAIT IS COMPUTED. A run at the cap must arm
 *    NOTHING, whatever the numbers say, and a test that drives it must not have
 *    to supply a plausible window to reach the answer.
 *  - `continue` (the window already drained) IS STILL SUBJECT TO THE CAP. It is
 *    a continuation like any other; a zero-length wait is not a free one.
 */
export function planRecovery(input: RecoveryInput): RecoveryDecision {
  const klass = classifyPhaseFailure(input.signals);

  const bound = mayAutoContinue({
    klass,
    autoContinueCount: input.autoContinueCount,
    enabled: input.enabled,
  });
  if (!bound.ok) {
    return { kind: "stop", klass, code: bound.code, reason: bound.reason };
  }

  if (klass === "interrupted") {
    return {
      kind: "continue",
      klass,
      reason:
        "the process died under this run while it was working — nothing about the run itself failed — so " +
        "it is being continued from where it stopped rather than started again.",
    };
  }

  if (klass === "transient") {
    const firesAt = plusMs(input.now, TRANSIENT_BACKOFF_MS);
    if (firesAt === null) return { kind: "stop", klass, code: "no_refusal_instant", reason: UNREADABLE_NOW };
    return {
      kind: "wait",
      klass,
      delayMs: TRANSIENT_BACKOFF_MS,
      firesAt,
      reason:
        `a fault of a kind a byte-identical retry can survive; waiting ` +
        `${String(Math.round(TRANSIENT_BACKOFF_MS / 1000))}s and continuing. The wait is reasoned rather ` +
        `than measured — no fault of this kind has ever been observed on this machine.`,
    };
  }

  // Only `throttled` remains: every other class either has bound 0 (refused
  // above) or returned already.
  return planThrottledWait(klass, input);
}

const UNREADABLE_NOW =
  "the current time could not be read as an instant, so no wait can be computed from it. Rather than " +
  "guess a delay, this stops and a human has to resume the run.";

/**
 * The throttled wait, arm for arm.
 *
 * WHAT IT DOES NOT DO — and `planRateLimitResume` says the same about itself: it
 * does not establish that the window actually drained. Nothing can; the only
 * evidence is the next call being accepted. It computes the wait THE PROVIDER
 * ITSELF REPORTED and stops there.
 */
function planThrottledWait(klass: FailureClass, input: RecoveryInput): RecoveryDecision {
  const refusal = input.signals.refusal;
  if (refusal === null || !refusal.limited) {
    // Reachable when the seat typed the failure `throttled` but no reading came
    // with it. Arming off the row's telemetry instead is the misclassification
    // RefusalEvidence exists to prevent, so this refuses rather than substitutes.
    return {
      kind: "stop",
      klass,
      code: "no_refusal",
      reason:
        "this failure was reported as a rate limit but arrived with no reading of the refusal itself, so " +
        "there is no window to wait out. The last telemetry on the row is not a substitute — it is written " +
        "by routine frames that report a window filling, not by a refusal. A human has to resume this run.",
    };
  }

  if (refusal.retryAfterSec === null) {
    return {
      kind: "stop",
      klass,
      code: "no_retry_after",
      reason:
        "the provider reported no reset instant with this refusal, so nothing here knows when the window " +
        "reopens. A countdown from a number nobody reported is an invention, so no timer is armed and a " +
        "human has to resume this run.",
    };
  }
  if (!Number.isFinite(refusal.retryAfterSec) || refusal.retryAfterSec <= 0) {
    // `claude-common.ts:214` produces 0 via `Math.max(0, …)` when the provider
    // refused a call while naming a reset instant already in the past: a refusal
    // with no wait attached, which answered immediately walks straight back into
    // itself.
    return {
      kind: "stop",
      klass,
      code: "retry_after_not_future",
      reason:
        `the provider refused the call while reporting a reset instant that is not in the future ` +
        `(retryAfterSec ${String(refusal.retryAfterSec)}). A continuation with no wait attached re-enters ` +
        `the same refusal, so no timer is armed and a human has to resume this run.`,
    };
  }

  const refusedAt = refusal.observedAt === null ? Number.NaN : Date.parse(refusal.observedAt);
  const at = Date.parse(input.now);
  if (!Number.isFinite(refusedAt) || !Number.isFinite(at)) {
    return {
      kind: "stop",
      klass,
      code: "no_refusal_instant",
      reason:
        `there is no usable record of when the provider refused ` +
        `(${refusal.observedAt ?? "none recorded"}), so the remaining wait cannot be computed. Waiting the ` +
        `full window from now would restart the whole window on every boot, which is the one thing this ` +
        `must never do; a human has to resume this run.`,
    };
  }

  // ELAPSED IS FLOORED AT ZERO, exactly as `#parkForDesignLock` and
  // `planRateLimitResume` floor theirs: a clock that moved backwards must not
  // lengthen the wait beyond what was reported.
  const elapsed = Math.max(0, at - refusedAt);
  const delayMs = refusal.retryAfterSec * 1000 - elapsed;

  if (delayMs <= 0) {
    return {
      kind: "continue",
      klass,
      reason:
        `the ${refusal.kind ?? "rate limit"} window the provider reported has already elapsed, so the run ` +
        `continues now. Whether it actually reopened is unknowable from here — the next call is the only ` +
        `evidence — and a refusal simply parks it again.`,
    };
  }
  if (delayMs > RECOVERY_TIMER_MAX_DELAY_MS) {
    return {
      kind: "stop",
      klass,
      code: "wait_unrepresentable",
      reason:
        `the reported wait is ${String(Math.round(delayMs / 86_400_000))} day(s), longer than a timer on ` +
        `this platform can hold — setTimeout keeps its delay in 32 bits and a longer one fires ` +
        `IMMEDIATELY. Refused rather than clamped, because firing immediately is the opposite of waiting.`,
    };
  }
  if (delayMs > input.maxWaitMs) {
    return {
      kind: "stop",
      klass,
      code: "wait_too_long",
      reason:
        `the provider reported a ${refusal.kind ?? "rate limit"} window that reopens in ` +
        `${hours(delayMs)} h, longer than the ${hours(input.maxWaitMs)} h this server will wait ` +
        `unattended. The run is kept and resumes the moment you press Resume; raise ` +
        `${RECOVERY_MAX_WAIT_ENV} to let it wait by itself.`,
    };
  }

  const firesAt = plusMs(input.now, delayMs);
  if (firesAt === null) return { kind: "stop", klass, code: "no_refusal_instant", reason: UNREADABLE_NOW };
  return {
    kind: "wait",
    klass,
    delayMs,
    firesAt,
    reason:
      `the provider refused with a ${refusal.kind ?? "rate limit"} window reopening in ${hours(delayMs)} h; ` +
      `the run is parked and continues itself then. Nothing is lost in the meantime and Resume still works.`,
  };
}

/** ISO `now` plus a delay, or null when `now` is not an instant. */
function plusMs(now: string, ms: number): string | null {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return null;
  return new Date(at + ms).toISOString();
}

/** One decimal place, because "0 h" for a 20-minute wait reads as a bug. */
function hours(ms: number): string {
  return (Math.round(ms / 360_000) / 10).toFixed(1);
}
