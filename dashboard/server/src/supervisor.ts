/**
 * supervisor.ts — the durable queue and the tick loop behind the owner's
 * start/stop switch.
 *
 * ─── WHY THIS IS A CLASS IN THIS PROCESS AND NOT A SECOND ONE ───
 *
 * `cron/cron-tick.ts:4-12` states the constraint in its own words: a tick "DOES
 * NOT CONSTRUCT AN `Orchestrator` OR OPEN `runs.db`… Two `Orchestrator`s against
 * one `runs.db` is the corruption case (both would `pump()`, both would claim
 * the same queued row, two builders would run in one workspace), and it is
 * designed out rather than discouraged." So the supervisor shares the process
 * and the `RunStore`, and the only concurrency primitive it needs is a
 * re-entrancy flag plus conditional `UPDATE`s.
 *
 * ─── NOTHING ABOUT WHICH TICKET IS IN FLIGHT LIVES IN MEMORY ───
 *
 * Every decision this loop makes is taken from `supervisor_tickets` and the
 * `runs` table on the tick that makes it. That is what lets a process that has
 * just booted resume instead of forget: a crash between the claim and the
 * submission leaves a `claimed` ticket with a null `current_run_id`, and the
 * next tick recognises that pair as an orphaned claim and returns it to the
 * queue. See {@link classifySupervisorHealth} — the same pair is what the arm
 * check uses to tell *stuck* from *idle*.
 *
 * ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ───
 *
 * It does not construct itself, mount an HTTP route, or hold a timer. Those are
 * `index.ts` and `http.ts`, which this lane does not own; `tick()` is written to
 * be safe to call from all four sites the design names (boot, a 30 s interval,
 * the `#finish` hook, and `POST /api/supervisor/start`) and from none of them.
 * An unwired supervisor is honest about being unwired; a supervisor that
 * believes it is running while nothing runs is the failure this whole lane
 * exists to make impossible.
 */

import { isTerminal } from "./db.js";
import { boundFor, isRepairable } from "./recovery.js";
import type { FailureClass } from "./recovery.js";
import type {
  RunStore,
  SupervisorDesired,
  SupervisorTicket,
  SupervisorTicketState,
} from "./db.js";
import type { ApiRunStatus } from "./api-types.js";

/**
 * What the supervisor hands the submission path.
 *
 * THE THREE NEVER-PARK FIELDS ARE FIXED LITERALS, NOT OPTIONS. `planPolicy(false)`
 * returns `"skip"` (plan-record.ts:111-113), so the plan seat is never called
 * and cannot park; `designLockPolicy("auto", …)` returns `"auto"`
 * (design-lock.ts:48-51) before `interactive` is consulted, so the design lock
 * is never awaited. Both parks are therefore UNREACHABLE for a supervisor run
 * rather than defaulted after a timeout — and {@link assertNeverParks} refuses
 * a submission that would make them reachable again.
 */
export interface SupervisorSubmission {
  readonly ticketText: string;
  readonly modelId: string;
  readonly designLock: "auto";
  readonly interactive: false;
  readonly deploy: false;
}

export interface SupervisorDeps {
  readonly store: RunStore;
  /**
   * Creates a run and returns its id. Injected rather than imported so the loop
   * can be tested without the capture stack, and so the real implementation
   * ({@link submitRun}) can be wired by the lane that owns `http.ts`.
   */
  readonly submit: (spec: SupervisorSubmission) => Promise<{ readonly runId: string }>;
  /**
   * ONE REPAIR CYCLE FOR ONE TICKET, OR ABSENT.
   *
   * Optional, and the absent case is the one that had to be designed first:
   * before this dep existed a ticket that reached `repairing` stayed there for
   * ever, because nothing in the tree produced a proposal and nothing moved a
   * ticket out. {@link routeRepairOutcome} treats `undefined` as a NAMED
   * TERMINAL OUTCOME (`NO_REPAIR_DRIVER`) rather than as a reason to wait, which
   * is the whole fix: a dead-end state is worse than an honest terminal one.
   *
   * It may touch the working tree, so the loop never calls it while a run is in
   * flight — see {@link SupervisorLoop.tick}'s repair step.
   */
  readonly repair?: (request: SupervisorRepairRequest) => Promise<SupervisorRepairOutcome>;
  /**
   * The defect signature of a finished run, read from whatever wrote the record.
   *
   * Injected because `defect.json` is written by `orchestrator.ts` under
   * `runs/<runId>/results`, and a loop that read that path itself could not be
   * tested without a run directory. It is what fills `supervisor_tickets
   * .last_defect_id` — a column that, until this round, no writer ever set, so
   * the per-signature repair bound below had nothing to count against and the
   * strip's `lastDefectId` was permanently null.
   */
  readonly defectSignatureOf?: (runId: string) => string | null;
  /**
   * Resume a non-terminal parked run. Optional: the loop falls back to a
   * re-submission, which is always legal, and `resume()` is only ever the
   * CHEAPER path (§7.5).
   */
  readonly resume?: (runId: string) => boolean;
  readonly now?: () => Date;
  /** Where the arm check and the loud lines go. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
}

/** How long a `waiting` ticket sleeps when the row names no wake instant. */
export const SUPERVISOR_DEFAULT_WAIT_MS = 15 * 60 * 1_000;

/* =========================================================================
 * 0. THE REPAIR SEAM — how a ticket LEAVES `repairing`
 *
 * MEASURED 2026-08-10, and it is the reason this section exists: `settle()`
 * routed a structural failure to `repairing` with the sentence "waiting for a
 * repair proposal for this failure class", `#tickOnce` step 1 listed
 * `["claimed","running","waiting"]`, and NOTHING in the tree — no route, no
 * loop, no process — produced a proposal or moved a ticket out. `repairing` was
 * a dead end wearing the word *waiting*. On an unattended night that is the
 * same observable as a crash: the queue stops and the strip says something
 * reassuring.
 *
 * THE RULE THIS SEAM IS BUILT ON: a ticket that enters `repairing` leaves it,
 * every time, by one of six NAMED outcomes, and five of the six are terminal.
 * The bound is wall clock AND attempts-per-signature, so "leaves it" does not
 * depend on a driver behaving.
 * ====================================================================== */

/**
 * How long one ticket may sit in `repairing` in total, across ticks.
 *
 * WALL CLOCK, NOT TICKS. The repair step declines to touch the tree while a run
 * is in flight (a patch applied under a live build is a corrupted workspace with
 * a green log), so "how many ticks did it get" is a function of how busy the
 * queue was. A deadline is the only bound that holds when the answer to that is
 * "permanently".
 */
export const SUPERVISOR_REPAIR_DEADLINE_MS = 30 * 60 * 1_000;

/**
 * How many repair cycles one DEFECT SIGNATURE gets, across every ticket.
 *
 * PER SIGNATURE, DELIBERATELY NOT PER TICKET, and never `attemptNo`. §7.6 is
 * explicit that mixing counters is how a bound stops working — `attemptNo`
 * answers "how many runs has this ticket had", and re-using it here would make
 * one repair cycle cost the ticket a run it never made. Two questions, two
 * numbers, and this one lives in its own column.
 */
export const SUPERVISOR_REPAIR_MAX_PER_SIGNATURE = 2;

/** What one repair cycle is told. Nothing here is prose the driver must parse. */
export interface SupervisorRepairRequest {
  readonly ticketKey: string;
  /** The defect record's signature, or null when no record named one. */
  readonly signature: string | null;
  /** The run whose failure is being repaired. */
  readonly runId: string | null;
  readonly failureClass: string | null;
  /** 1 for the first cycle against this signature. */
  readonly cycleNo: number;
  readonly maxCycles: number;
  /** The instant after which this ticket leaves `repairing` regardless. */
  readonly deadlineAt: string;
}

/**
 * What one repair cycle reports. THREE KINDS, AND `refused` IS NOT A FAILURE.
 *
 * `applied` means the tree now carries a patch that passed the gate, so the
 * ticket is worth re-running. `refused` means the bar said no — a ruled-out
 * fingerprint, a frozen-closure touch, a mutation that survived. `inconclusive`
 * means the cycle could not reach a verdict at all, which today is the ordinary
 * case: the patch AUTHOR is not built (design §5.3, "THE PATCH AUTHOR IS NOT
 * BUILT"), so a cycle with no candidate diff to grade returns `NO_PATCH_AUTHOR`.
 *
 * `code` IS A SHORT MACHINE TOKEN AND `detail` IS FOR THE OWNER. The router
 * below branches on `kind` only; `code` travels into the ticket's sentence so
 * that two refusals for different reasons do not read identically.
 */
export type SupervisorRepairOutcome =
  | {
      readonly kind: "applied";
      readonly code: string;
      readonly detail: string;
      /** Recorded on the ticket so the strip's `lastRepair` has a producer. */
      readonly patchId: string;
    }
  | { readonly kind: "refused"; readonly code: string; readonly detail: string }
  | { readonly kind: "inconclusive"; readonly code: string; readonly detail: string };

/**
 * Every way a ticket can leave `repairing`. Six, and each has its own sentence.
 *
 * `REPAIR_DEFERRED` is the one non-terminal member and the only one that leaves
 * the ticket in `repairing` — it means "a run is in flight, so the tree is not
 * mine to patch this tick". It cannot become a dead end because
 * `REPAIR_DEADLINE_EXCEEDED` is checked BEFORE it on every tick.
 */
export type SupervisorRepairCode =
  | "REPAIR_APPLIED"
  | "REPAIR_REFUSED"
  | "REPAIR_INCONCLUSIVE"
  | "NO_REPAIR_DRIVER"
  | "REPAIR_CYCLES_EXHAUSTED"
  | "REPAIR_DEADLINE_EXCEEDED"
  | "REPAIR_DEFERRED";

export interface RepairRouting {
  readonly code: SupervisorRepairCode;
  /** Where the ticket goes. `repairing` only for `REPAIR_DEFERRED`. */
  readonly state: SupervisorTicketState;
  /** True when the loop should invoke the driver rather than write this routing. */
  readonly invoke: boolean;
  /** The ticket's `nextAction`. A sentence, never blank, never shared. */
  readonly nextAction: string;
  /** The `supervisor_log` reason. Also a sentence, also never shared. */
  readonly reason: string;
}

export interface RepairRoutingInput {
  readonly ticketKey: string;
  readonly signature: string | null;
  readonly failureClass: string | null;
  /** False when no `repair` dep is wired into this supervisor. */
  readonly driverWired: boolean;
  /** Cycles already spent against this signature. */
  readonly cyclesSpent: number;
  readonly maxCycles: number;
  /** True when the ticket's repair deadline is in the past. */
  readonly deadlinePassed: boolean;
  /** True when some ticket's run is still alive, so the tree may not be patched. */
  readonly runInFlight: boolean;
  /** Null on the pre-invocation pass; set once the driver has answered. */
  readonly outcome: SupervisorRepairOutcome | null;
}

/**
 * THE ROUTER, PURE, WHICH IS THE ONLY REASON THE ARM CHECK CAN DRIVE IT.
 *
 * The order of the arms IS the policy and each one is here for a measured
 * reason:
 *
 *   1. THE DEADLINE FIRST. It is checked before the in-flight arm and before the
 *      driver, so a ticket cannot be starved into permanence by a queue that
 *      always has something running. This is the arm that makes "leaves
 *      `repairing` deterministically" true without trusting anything.
 *   2. NO DRIVER IS A TERMINAL ANSWER, NOT A WAIT. This is the state the tree
 *      was in an hour ago, and it is the state it is in again the moment
 *      `index.ts` forgets to pass `repair`. Blocking with the sentence is what
 *      makes that visible in one line instead of as a queue that quietly stops.
 *   3. THE CYCLE BOUND BEFORE THE SPEND, for the same reason the attempt cap is
 *      read at claim time rather than only in `settle()`.
 *   4. DEFERRED ONLY AFTER ALL THREE, so the one non-terminal arm can only be
 *      reached when every bound still has room.
 */
export function routeRepairOutcome(input: RepairRoutingInput): RepairRouting {
  const sig = input.signature ?? "(no signature recorded)";
  const klass = input.failureClass ?? "none recorded";

  if (input.outcome === null) {
    if (input.deadlinePassed) {
      return {
        code: "REPAIR_DEADLINE_EXCEEDED",
        state: "blocked",
        invoke: false,
        nextAction:
          `nothing automatic: this ticket spent its whole repair window in 'repairing' without a cycle reaching a ` +
          `verdict for defect ${sig} (class '${klass}'). Repair by hand, then re-enqueue the ticket.`,
        reason:
          `the repair deadline passed with no verdict for defect ${sig}, so the ticket was blocked rather than left ` +
          `in 'repairing' for ever`,
      };
    }
    if (!input.driverWired) {
      return {
        code: "NO_REPAIR_DRIVER",
        state: "blocked",
        invoke: false,
        nextAction:
          `nothing automatic: no repair driver is wired into this supervisor, so no proposal for defect ${sig} ` +
          `(class '${klass}') can ever be produced. Run tools/repair/cycle.mjs by hand and re-enqueue the ticket.`,
        reason:
          `there is no repair driver, so 'repairing' would be a dead end for defect ${sig}; the ticket was blocked ` +
          `with that sentence instead`,
      };
    }
    if (input.cyclesSpent >= input.maxCycles) {
      return {
        code: "REPAIR_CYCLES_EXHAUSTED",
        state: "blocked",
        invoke: false,
        nextAction:
          `nothing automatic: defect ${sig} has already had all ${String(input.maxCycles)} repair cycle(s) it is ` +
          `allowed and none cleared it. The same proposal will not be re-proved.`,
        reason:
          `defect ${sig} is at its per-signature repair bound (${String(input.cyclesSpent)} of ` +
          `${String(input.maxCycles)} cycles spent), so no cycle was started`,
      };
    }
    if (input.runInFlight) {
      return {
        code: "REPAIR_DEFERRED",
        state: "repairing",
        invoke: false,
        nextAction:
          `waiting for the in-flight run to finish before a repair cycle for defect ${sig} may touch the tree; ` +
          `this ticket is blocked automatically if the repair window closes first`,
        reason: `a repair cycle for defect ${sig} was deferred: a run is still live and a patch must not land under it`,
      };
    }
    return {
      code: "REPAIR_APPLIED", // provisional: the driver answers next
      state: "repairing",
      invoke: true,
      nextAction: `a repair cycle for defect ${sig} is running (cycle ${String(input.cyclesSpent + 1)} of ${String(input.maxCycles)})`,
      reason: `a repair cycle for defect ${sig} was started, cycle ${String(input.cyclesSpent + 1)} of ${String(input.maxCycles)}`,
    };
  }

  /*
   * AN APPLIED PATCH GOES TO `queued`, AND THE ATTEMPT CAP STILL RULES IT.
   * A ticket already at `maxAttempts` is re-queued here and then BLOCKED by the
   * claim guard on the same tick, with the attempt-cap sentence rather than a
   * repair one — so `patch_id` is set on a ticket that never ran again. That is
   * deliberate: the patch really was applied and the tree really did change, and
   * the alternative (letting a repair mint an extra attempt) is the counter-mixing
   * §7.6 forbids. The owner re-enqueues to spend it.
   */
  const outcome = input.outcome;
  if (outcome.kind === "applied") {
    return {
      code: "REPAIR_APPLIED",
      state: "queued",
      invoke: false,
      nextAction:
        `re-submitting: patch ${outcome.patchId} for defect ${sig} passed the gate and was applied — ${outcome.detail}`,
      reason: `the repair cycle for defect ${sig} was ACCEPTED as ${outcome.patchId} (${outcome.code}); the ticket is queued for a re-run`,
    };
  }
  if (outcome.kind === "refused") {
    return {
      code: "REPAIR_REFUSED",
      state: "blocked",
      invoke: false,
      nextAction:
        `nothing automatic: the repair proposal for defect ${sig} was REFUSED by the evidence bar ` +
        `(${outcome.code}) — ${outcome.detail}`,
      reason: `the repair cycle for defect ${sig} refused its own proposal (${outcome.code})`,
    };
  }
  return {
    code: "REPAIR_INCONCLUSIVE",
    state: "blocked",
    invoke: false,
    nextAction:
      `nothing automatic: the repair cycle for defect ${sig} reached NO verdict (${outcome.code}) — ${outcome.detail}`,
    reason: `the repair cycle for defect ${sig} was inconclusive (${outcome.code}); the ticket was blocked, not left repairing`,
  };
}

/**
 * The per-signature repair counter, carried in one JSON column.
 *
 * ITS OWN COLUMN, NOT `class_counts` AND NEVER `attempt_no`. See
 * {@link SUPERVISOR_REPAIR_MAX_PER_SIGNATURE}. Unparseable text reads as `{}`
 * rather than throwing: this counter is a brake, and a brake that turns a
 * corrupted cell into a crashed tick is worse than one that starts again from
 * zero — the deadline still bounds the ticket either way.
 */
export function readRepairCounts(raw: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw === "" ? "{}" : raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * THE REPAIR ROUTER'S ARM CHECK — six known inputs, six answers that must differ.
 *
 * It is a top-level function rather than a method because it needs no store, no
 * clock and no driver: every input is written here in the source with its answer
 * beside it, which is the only way an arm check can run at start-up on the
 * owner's real database without writing fake rows into it.
 *
 * WHAT MAKES IT ABLE TO FAIL, which is the whole point. It requires that all six
 * probes return the code named for them, that the six codes are DISTINCT, and
 * that the six `nextAction` sentences are distinct. Merge any two arms of
 * {@link routeRepairOutcome} — or make two of them share a sentence, which is
 * the easier mistake — and this reports the pair by name.
 *
 * THE LIMIT, STATED SO IT IS NOT OVER-READ: it compares sentences for EQUALITY,
 * so it catches a copied sentence and not a NEARLY copied one. An edit that
 * reworks two arms into near-duplicates differing by a word passes this check
 * while being unreadable to the owner at 3am. Measured the hard way: the first
 * attempt at this file's own mutation proof copied a sentence but dropped its
 * last clause, and the arm check correctly — and uselessly — stayed armed.
 */
export function armRepairRouter(): {
  readonly armed: boolean;
  readonly probes: number;
  readonly distinctCodes: number;
  readonly distinctSentences: number;
  readonly wrong: readonly string[];
} {
  const common = {
    ticketKey: "arm-ticket",
    signature: "a".repeat(64),
    failureClass: "structural",
    driverWired: true,
    cyclesSpent: 0,
    maxCycles: SUPERVISOR_REPAIR_MAX_PER_SIGNATURE,
    deadlinePassed: false,
    runInFlight: false,
    outcome: null as SupervisorRepairOutcome | null,
  };
  const probes: readonly { readonly want: SupervisorRepairCode; readonly input: RepairRoutingInput }[] = [
    { want: "REPAIR_DEADLINE_EXCEEDED", input: { ...common, deadlinePassed: true } },
    { want: "NO_REPAIR_DRIVER", input: { ...common, driverWired: false } },
    { want: "REPAIR_CYCLES_EXHAUSTED", input: { ...common, cyclesSpent: SUPERVISOR_REPAIR_MAX_PER_SIGNATURE } },
    { want: "REPAIR_DEFERRED", input: { ...common, runInFlight: true } },
    {
      want: "REPAIR_APPLIED",
      input: {
        ...common,
        outcome: { kind: "applied", code: "ACCEPTED", detail: "the arm check's known-good outcome", patchId: "arm-patch" },
      },
    },
    {
      want: "REPAIR_REFUSED",
      input: { ...common, outcome: { kind: "refused", code: "ALREADY_RULED_OUT", detail: "the arm check's known refusal" } },
    },
    {
      want: "REPAIR_INCONCLUSIVE",
      input: {
        ...common,
        outcome: { kind: "inconclusive", code: "NO_PATCH_AUTHOR", detail: "the arm check's known non-verdict" },
      },
    },
  ];
  const got = probes.map((probe) => routeRepairOutcome(probe.input));
  const wrong: string[] = [];
  probes.forEach((probe, index) => {
    const code = got[index]?.code;
    if (code !== probe.want) wrong.push(`${probe.want} read as ${String(code)}`);
  });
  const distinctCodes = new Set(got.map((r) => r.code)).size;
  const distinctSentences = new Set(got.map((r) => r.nextAction)).size;
  if (distinctCodes !== probes.length) wrong.push(`${String(probes.length)} inputs collapsed into ${String(distinctCodes)} code(s)`);
  if (distinctSentences !== probes.length) {
    wrong.push(`${String(probes.length)} inputs collapsed into ${String(distinctSentences)} sentence(s)`);
  }
  // A ROUTING WITH A BLANK SENTENCE IS A BLIND ROUTING. `nextAction` is the field
  // the design says can never be blank, and a `repairing` ticket whose sentence is
  // empty is indistinguishable from one nobody looked at.
  for (const routing of got) {
    if (routing.nextAction.trim() === "" || routing.reason.trim() === "") wrong.push(`${routing.code} carries a blank sentence`);
  }
  return { armed: wrong.length === 0, probes: probes.length, distinctCodes, distinctSentences, wrong };
}

export function bumpRepairCount(raw: string, key: string): { readonly json: string; readonly count: number } {
  const counts = readRepairCounts(raw);
  const count = (counts[key] ?? 0) + 1;
  counts[key] = count;
  return { json: JSON.stringify(counts), count };
}

/* =========================================================================
 * 1. The idle / in-flight / stuck discriminator
 *
 * A PURE FUNCTION OVER A SNAPSHOT, WHICH IS THE ONLY REASON THE ARM CHECK CAN
 * EXIST. `armSupervisor` feeds it three snapshots whose answers are known at
 * start-up; a discriminator that reads the database directly could only be
 * armed by writing fake rows into the owner's database, so it would not be
 * armed at all.
 * ====================================================================== */

/** A run status as the snapshot carries it, plus the case that has no row. */
export type SnapshotRunStatus = ApiRunStatus | "no-row";

export interface SnapshotTicket {
  readonly ticketKey: string;
  readonly state: SupervisorTicketState;
  readonly currentRunId: string | null;
  /** `null` when the ticket names no run at all. */
  readonly runStatus: SnapshotRunStatus | null;
}

export interface SupervisorSnapshot {
  readonly desired: SupervisorDesired;
  readonly tickets: readonly SnapshotTicket[];
}

/**
 * The six things the supervisor can be, and three of them are the arm check.
 *
 * `idle-empty-queue` and `stuck-orphan-claim` are the pair that matters: both
 * look identical from outside (nothing is running), and one is correct while
 * the other means a submission was lost. A status surface that cannot tell them
 * apart is this repository's signature defect.
 */
export type SupervisorHealthCode =
  | "stopped"
  | "draining"
  | "idle-empty-queue"
  | "idle-queue-waiting"
  | "in-flight"
  | "stuck-orphan-claim"
  | "stuck-vanished-run";

export interface SupervisorHealth {
  readonly code: SupervisorHealthCode;
  /** A sentence, never blank, that distinguishes this code from every other. */
  readonly line: string;
  readonly stuck: boolean;
}

export function classifySupervisorHealth(snapshot: SupervisorSnapshot): SupervisorHealth {
  const claimed = snapshot.tickets.filter((t) => t.state === "claimed" || t.state === "running");

  /*
   * THE STUCK ARMS ARE CHECKED FIRST AND ON PURPOSE. A ticket the loop believes
   * is in flight, whose run cannot be found, is the one state that must never
   * be reported as healthy — and it is reachable in two ways, so it is named in
   * two ways rather than folded into one message that cannot say which.
   */
  const orphan = claimed.find((t) => t.currentRunId === null);
  if (orphan !== undefined) {
    return {
      code: "stuck-orphan-claim",
      stuck: true,
      line:
        `STUCK: ticket ${orphan.ticketKey} is ${orphan.state} but names no run — the submission was lost ` +
        `between the claim and the run row. The next tick returns it to the queue.`,
    };
  }
  const vanished = claimed.find((t) => t.runStatus === "no-row" || t.runStatus === null);
  if (vanished !== undefined) {
    return {
      code: "stuck-vanished-run",
      stuck: true,
      line:
        `STUCK: ticket ${vanished.ticketKey} names run ${vanished.currentRunId ?? "(none)"} and that run has no ` +
        `row. The next tick returns the ticket to the queue.`,
    };
  }

  const live = claimed.find((t) => t.runStatus !== null && !isTerminal(t.runStatus as ApiRunStatus));
  if (live !== undefined) {
    return {
      code: "in-flight",
      stuck: false,
      line: `IN FLIGHT: ticket ${live.ticketKey} is running as ${String(live.currentRunId)} (${String(live.runStatus)}).`,
    };
  }

  if (snapshot.desired === "stopped") {
    return {
      code: "stopped",
      stuck: false,
      line: `STOPPED: nothing will be claimed until the owner presses start. ${describeQueue(snapshot)}`,
    };
  }
  if (snapshot.desired === "draining") {
    return {
      code: "draining",
      stuck: false,
      line: `DRAINING: no new ticket will be claimed; the in-flight run finishes first. ${describeQueue(snapshot)}`,
    };
  }

  const queued = snapshot.tickets.filter((t) => t.state === "queued");
  if (queued.length === 0) {
    return {
      code: "idle-empty-queue",
      stuck: false,
      line: "IDLE: running, nothing in flight, and the queue is empty. There is no work, which is not a fault.",
    };
  }
  return {
    code: "idle-queue-waiting",
    stuck: false,
    line:
      `IDLE WITH WORK WAITING: running, nothing in flight, and ${String(queued.length)} ticket(s) are queued. ` +
      `The next tick claims ${String(queued[0]?.ticketKey)}. If this line repeats, the loop is not ticking.`,
  };
}

function describeQueue(snapshot: SupervisorSnapshot): string {
  const queued = snapshot.tickets.filter((t) => t.state === "queued").length;
  return queued === 0 ? "The queue is empty." : `${String(queued)} ticket(s) are queued.`;
}

/* =========================================================================
 * 2. The never-park assertion
 * ====================================================================== */

/**
 * A park under the supervisor is a bug, so the submission that could cause one
 * is refused before it is made.
 *
 * IMPOSSIBLE RATHER THAN UNLIKELY, WHICH IS THE INSTRUCTION. The alternative —
 * watching for `awaiting_input` and recovering from it — is a probe that can
 * only observe the failure after the owner's evening is gone. This throws at
 * the boundary, on the field, before any quota is spent.
 */
export function assertNeverParks(spec: SupervisorSubmission): void {
  if (spec.designLock !== "auto") {
    throw new Error(
      `a supervisor submission must carry designLock "auto"; "${String(spec.designLock)}" would park the run at the ` +
        `design lock with nobody to answer it (design-lock.ts:48-51)`,
    );
  }
  if (spec.interactive !== false) {
    throw new Error(
      "a supervisor submission must be non-interactive; interactive:true makes planPolicy return \"ask\" " +
        "(plan-record.ts:111-113) and the plan seat parks for a question nobody is there to answer",
    );
  }
}

/* =========================================================================
 * 3. The loop
 * ====================================================================== */

export interface SupervisorTickReport {
  readonly ranAt: string;
  readonly desired: SupervisorDesired;
  readonly health: SupervisorHealth;
  /** One line per decision taken this tick; empty means the tick decided nothing. */
  readonly decisions: readonly string[];
  readonly submittedRunId: string | null;
  /** True when the tick returned immediately because another tick was in progress. */
  readonly reentered: boolean;
}

export class SupervisorLoop {
  readonly #deps: SupervisorDeps;
  #ticking = false;

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #say(line: string): void {
    (this.#deps.log ?? ((l: string) => { console.log(l); }))(line);
  }

  /**
   * The live snapshot, read fresh every time. The loop's decisions and the
   * status surface therefore read the SAME function, so a panel that says
   * "idle" and a loop that is stuck cannot disagree.
   */
  snapshot(): SupervisorSnapshot {
    const store = this.#deps.store;
    const tickets = store.listSupervisorTickets();
    return {
      desired: store.readSupervisorState().desired,
      tickets: tickets.map((ticket) => ({
        ticketKey: ticket.ticketKey,
        state: ticket.state,
        currentRunId: ticket.currentRunId,
        runStatus:
          ticket.currentRunId === null
            ? null
            : ((store.getRun(ticket.currentRunId)?.status ?? "no-row") as SnapshotRunStatus),
      })),
    };
  }

  health(): SupervisorHealth {
    return classifySupervisorHealth(this.snapshot());
  }

  /**
   * THE START-UP ARM CHECK. Runs while the answer is known and says loudly if
   * the component is blind.
   *
   * The precedent is `RUN-a913c871-observations.md:100-133` — a watcher built to
   * catch a dead seat that had the dead seat's own defect and "would have
   * printed a healthy seat forever after the seat died". The failure mode of a
   * supervisor is exactly that shape: it prints nothing, and nothing is what an
   * idle queue prints too.
   *
   * NOT YET INVOKED AT START-UP, AND SAYING SO IS PART OF THE CHECK. The
   * construction site is `index.ts`, which this lane does not own; until the
   * lane that owns it calls this before the first `tick()`, the arm check is
   * implemented and mutation-proved but NOT ARMED. An arm check only a test
   * calls is a test, not an arm check.
   *
   * So the check does not ask whether the loop is healthy. It feeds the
   * discriminator three snapshots whose answers are known here in the source —
   * an empty queue, a lost submission, and a live run — and requires three
   * DIFFERENT verdicts. Collapse any arm and the check reports BLIND, which is
   * what `supervisor.test.ts`'s mutation proof does.
   */
  armCheck(): { readonly armed: boolean; readonly lines: readonly string[] } {
    const probes: readonly { readonly want: SupervisorHealthCode; readonly snapshot: SupervisorSnapshot }[] = [
      { want: "idle-empty-queue", snapshot: { desired: "running", tickets: [] } },
      {
        want: "stuck-orphan-claim",
        snapshot: {
          desired: "running",
          tickets: [{ ticketKey: "arm-orphan", state: "claimed", currentRunId: null, runStatus: null }],
        },
      },
      {
        want: "in-flight",
        snapshot: {
          desired: "running",
          tickets: [{ ticketKey: "arm-live", state: "claimed", currentRunId: "arm-run", runStatus: "running" }],
        },
      },
    ];
    const got = probes.map((probe) => classifySupervisorHealth(probe.snapshot));
    const wrong = probes.filter((probe, index) => got[index]?.code !== probe.want);
    const distinct = new Set(got.map((health) => health.code)).size;
    const repair = armRepairRouter();
    const live = this.snapshot();
    const counts = {
      queued: live.tickets.filter((t) => t.state === "queued").length,
      inFlight: live.tickets.filter((t) => t.state === "claimed" || t.state === "running").length,
      waiting: live.tickets.filter((t) => t.state === "waiting").length,
    };
    const armed = wrong.length === 0 && distinct === probes.length && repair.armed;
    const repairingNow = live.tickets.filter((t) => t.state === "repairing").length;
    const lines = [
      `ARM CHECK: supervisor discriminator returns ${String(distinct)} distinct verdict(s) on ` +
        `${String(probes.length)} known inputs; ${String(wrong.length)} misread`,
      `ARM CHECK: supervisor sees ${String(live.tickets.length)} ticket(s) — queued ${String(counts.queued)}, ` +
        `in flight ${String(counts.inFlight)}, waiting ${String(counts.waiting)}; desired='${live.desired}'`,
      /*
       * THE REPAIR ROUTER GETS ITS OWN ARM AND ITS OWN BLIND STATE. Instance
       * twenty-two of this repository's signature defect was a three-state arm
       * check that shipped with an arm for *unreachable* and none for *reachable
       * but malformed*. The equivalent hole here is an arm check that proves the
       * health discriminator and says NOTHING about the component that decides
       * whether a ticket ever leaves `repairing`. So the router's outcomes are
       * driven with inputs whose answers are known in this source, and a collapse
       * of either the codes or the SENTENCES reports BLIND — the sentences
       * matter because the owner reads those, and six outcomes that all say the
       * same thing are as unreadable as one.
       */
      repair.armed
        ? `ARM CHECK: repair router returns ${String(repair.distinctCodes)} distinct code(s) and ` +
          `${String(repair.distinctSentences)} distinct sentence(s) on ${String(repair.probes)} known inputs; ` +
          `0 misread — a ticket in 'repairing' always leaves it`
        : `ARM CHECK: BLIND — the repair router cannot tell its own outcomes apart ` +
          `(${repair.wrong.join("; ") || "codes or sentences collapsed"}). A ticket in 'repairing' may never leave it.`,
      /*
       * AND A SEPARATE, LOUDER FACT: whether a driver exists at all. This is NOT
       * blindness — the router terminates such a ticket at `blocked` with
       * `NO_REPAIR_DRIVER`, which is honest and bounded — but an owner who left a
       * run overnight expecting self-repair has to be able to read that no repair
       * can happen, in one line, at boot, rather than infer it from a queue that
       * emptied itself into `blocked`.
       */
      this.#deps.repair === undefined
        ? `ARM CHECK: NO REPAIR DRIVER is wired. Every ticket that reaches 'repairing' terminates at 'blocked' with ` +
          `NO_REPAIR_DRIVER and the loop carries on to the next ticket. ${String(repairingNow)} ticket(s) are repairing now.`
        : `ARM CHECK: a repair driver is wired; a repairing ticket gets at most ` +
          `${String(SUPERVISOR_REPAIR_MAX_PER_SIGNATURE)} cycle(s) per defect signature and leaves 'repairing' within ` +
          `${String(Math.round(SUPERVISOR_REPAIR_DEADLINE_MS / 60_000))} minutes either way. ` +
          `${String(repairingNow)} ticket(s) are repairing now.`,
      armed
        ? `ARM CHECK: armed — idle and stuck are distinguishable. ${classifySupervisorHealth(live).line}`
        : `ARM CHECK: BLIND — the supervisor cannot tell an idle queue from a lost submission ` +
          `(${wrong.map((p) => p.want).join(", ") || "verdicts collapsed"})` +
          `${repair.armed ? "" : ", and its repair router has collapsed too"}. Do not trust its status line.`,
    ];
    for (const line of lines) this.#say(line);
    return { armed, lines };
  }

  /**
   * One pass. Synchronous decisions, one awaited submission, re-entrancy
   * guarded exactly as `pump()` is.
   */
  async tick(): Promise<SupervisorTickReport> {
    if (this.#ticking) {
      return {
        ranAt: this.#now().toISOString(),
        desired: this.#deps.store.readSupervisorState().desired,
        health: this.health(),
        decisions: [],
        submittedRunId: null,
        reentered: true,
      };
    }
    this.#ticking = true;
    try {
      return await this.#tickOnce();
    } finally {
      this.#ticking = false;
    }
  }

  async #tickOnce(): Promise<SupervisorTickReport> {
    const store = this.#deps.store;
    const decisions: string[] = [];
    const desired = store.readSupervisorState().desired;

    /*
     * THE REPAIRING LIST IS TAKEN BEFORE RECONCILE RUNS, AND THE ORDER IS THE
     * DECISION. `#reconcile` -> `settle()` is what PUTS a ticket into
     * `repairing`; if the repair step below re-read the table it would consume
     * that ticket in the same tick that created it, and `repairing` would never
     * be an observable state on the strip — the owner would see a failure become
     * `blocked` with no intermediate reading, which is exactly the "the display
     * reports a state nobody could watch" problem in reverse. So a ticket gets
     * one tick of visible `repairing` and the NEXT tick decides its fate. 30
     * seconds, bounded, legible.
     */
    const repairing = store.listSupervisorTickets(["repairing"]);

    // 1. RECONCILE. This step, and not any in-memory field, is what makes the
    //    loop survive its own restart.
    for (const ticket of store.listSupervisorTickets(["claimed", "running", "waiting"])) {
      const decision = this.#reconcile(ticket);
      if (decision !== null) decisions.push(decision);
    }

    // 2. WAKE anything whose wait has expired.
    for (const ticket of store.listSupervisorTickets(["waiting"])) {
      const decision = this.#wake(ticket);
      if (decision !== null) decisions.push(decision);
    }

    const inFlight = this.#inFlight();

    // 2b. REPAIR. Every `repairing` ticket is looked at on every tick, and the
    //     step is placed HERE — before the `desired !== "running"` return and
    //     before the in-flight guard — for two different reasons.
    //
    //     BEFORE THE IN-FLIGHT GUARD, because a `repairing` ticket has a null
    //     `currentRunId` and `#inFlight()` cannot see it: put this step after
    //     `if (inFlight !== null) return` and a repairing ticket is starved for
    //     as long as ANY other ticket is running, which on a busy queue is
    //     "for ever" — the dead end again, one line further down.
    //
    //     `inFlight` IS THE READING TAKEN ABOVE, BEFORE THE CLAIM STEP, and that
    //     is what makes "never patch under a live build" true rather than
    //     probable: a repair cycle is AWAITED to completion here, and only then
    //     can step 4 submit anything, so a repair and a fresh run cannot overlap
    //     within a tick. The only overlap that exists is a run that was already
    //     live when the tick began, which is exactly what this reading names.
    //
    //     AND YET STILL GATED ON `desired === "running"`: a stopped supervisor
    //     spends nothing, and a repair cycle runs commands. The deadline keeps
    //     ticking while the supervisor is stopped, so the ticket does not become
    //     immortal by being ignored — it lands `blocked` on the first tick after
    //     the owner presses start.
    if (desired === "running") {
      for (const ticket of repairing) {
        // RE-READ THE ROW, because the list is a tick old by now and this loop is
        // the only component allowed to believe a stale reading of its own table.
        const fresh = store.getSupervisorTicket(ticket.ticketKey);
        if (fresh === null || fresh.state !== "repairing") continue;
        const decision = await this.#repair(fresh, inFlight !== null);
        if (decision !== null) decisions.push(decision);
      }
    }

    // 3. NOT RUNNING: the drain finishes itself, and nothing is claimed.
    if (desired !== "running") {
      if (desired === "draining" && inFlight === null) {
        store.setSupervisorState("stopped", "guard", "the drain finished: nothing is in flight");
        store.logSupervisorDecision({
          ticketKey: null,
          runId: null,
          decision: "drained",
          reason: "the last in-flight run reached its own verdict, so the drain completed",
        });
        decisions.push("drained: the last in-flight run finished, so the supervisor is now stopped");
      }
      return this.#report(desired, decisions, null);
    }

    // 4. CLAIM. One ticket in flight at a time, matching the orchestrator's
    //    single active slot. "In flight" is any ticket whose run is non-terminal
    //    — NOT `activeRunId` — because a rate-limited run holds no active slot
    //    and a second claim on top of it would run two builds in one workspace.
    if (inFlight !== null) return this.#report(desired, decisions, null);
    const next = store.listSupervisorTickets(["queued"])[0];
    if (next === undefined) return this.#report(desired, decisions, null);

    /*
     * THE CAP IS READ HERE, BEFORE THE SPEND, AND NOT ONLY IN `settle()`.
     *
     * MEASURED 2026-08-10: `settle()` was the sole reader of
     * `attemptNo >= maxAttempts`, and it only runs when a run reaches a TERMINAL
     * status. Two paths therefore walked past the only brake in the file.
     *
     *   (a) A submission that throws (bad model id, missing directory, full
     *       disk) returned the ticket to `queued` and did not increment
     *       `attemptNo` — the increment was on the success path only — so the
     *       loop re-claimed the same ticket every 30 s FOREVER. No model quota
     *       was spent, because the throw is before the run exists, but the
     *       `supervisor_log` grew without bound and the machine reported
     *       progress while making none. That is the shape of failure this whole
     *       component exists to end.
     *
     *   (b) `#wake` re-queues a non-resumable run for a FRESH submission. Each
     *       such submission does increment, but with the cap read only in
     *       `settle()` a ticket whose runs keep landing non-terminal
     *       (`rate_limited` / `awaiting_input` -> wait 15 min -> wake ->
     *       re-submit) could exceed `maxAttempts` without bound and without
     *       anyone being told.
     *
     * ONE READ CLOSES BOTH, because both arrive at this line with the attempts
     * already spent. `blocked`, never `queued`: §7.6's one rule.
     */
    if (next.attemptNo >= next.maxAttempts) {
      store.updateSupervisorTicket(next.ticketKey, {
        state: "blocked",
        currentRunId: null,
        nextAction: `nothing: this ticket has used all ${String(next.maxAttempts)} attempt(s) and was never claimed again`,
        nextActionAt: null,
      });
      store.logSupervisorDecision({
        ticketKey: next.ticketKey,
        runId: null,
        decision: "settled",
        reason:
          `the claim step refused to submit: attempt ${String(next.attemptNo)} of ${String(next.maxAttempts)} is already spent. ` +
          "A ticket at its cap is blocked, never re-queued.",
      });
      decisions.push(`${next.ticketKey} is at its attempt cap and was blocked instead of claimed`);
      return this.#report(desired, decisions, null);
    }

    if (!store.claimSupervisorTicket(next.ticketKey, "submitting this ticket as a new run")) {
      decisions.push(`claim of ${next.ticketKey} lost a race and was not taken`);
      return this.#report(desired, decisions, null);
    }
    store.logSupervisorDecision({
      ticketKey: next.ticketKey,
      runId: null,
      decision: "claimed",
      reason: `the supervisor is running, nothing was in flight, and this was the oldest queued ticket`,
    });

    const spec: SupervisorSubmission = {
      ticketText: next.ticketText,
      modelId: next.modelId,
      designLock: "auto",
      interactive: false,
      deploy: false,
    };
    assertNeverParks(spec);
    let runId: string;
    try {
      ({ runId } = await this.#deps.submit(spec));
    } catch (error) {
      /*
       * A FAILED SUBMISSION RETURNS THE TICKET, IT DOES NOT SWALLOW IT. The
       * ticket is left `claimed` with a null run id by the throw, which is the
       * orphan pair the next tick already knows how to read — but saying so
       * here costs one row and turns a silent retry into a legible one.
       */
      const reason = error instanceof Error ? error.message : String(error);
      /*
       * THE ATTEMPT IS COUNTED EVEN THOUGH NO RUN EXISTS, AND THAT IS THE FIX.
       *
       * The increment used to live on the success path alone, so a `submit` that
       * threw deterministically was a free retry: same ticket, same throw, every
       * 30 s, unbounded. Counting it here means the claim guard above reaches the
       * cap in `maxAttempts` ticks and the ticket lands `blocked` — a bounded
       * spin with a named end, instead of a loop that looks like work.
       *
       * IT COSTS A REAL ATTEMPT ON A TRANSIENT FAULT, and that is the accepted
       * trade: three cheap failures that stop are better than an infinite series
       * that does not. A per-failure exponential backoff would keep the attempts
       * for the model and is carried forward, not pretended.
       */
      const attemptNo = next.attemptNo + 1;
      store.updateSupervisorTicket(next.ticketKey, {
        state: "queued",
        attemptNo,
        nextAction:
          attemptNo >= next.maxAttempts
            ? `nothing further will be attempted automatically: submission ${String(attemptNo)} of ${String(next.maxAttempts)} threw — ${reason}`
            : `re-submitting (attempt ${String(attemptNo + 1)} of ${String(next.maxAttempts)}) after the last submission threw: ${reason}`,
      });
      store.logSupervisorDecision({
        ticketKey: next.ticketKey,
        runId: null,
        decision: "refused",
        reason: `the submission threw and the ticket was returned to the queue: ${reason}`,
      });
      decisions.push(`submission of ${next.ticketKey} threw and the ticket went back to the queue`);
      return this.#report(desired, decisions, null);
    }

    store.updateSupervisorTicket(next.ticketKey, {
      state: "running",
      currentRunId: runId,
      lastRunId: runId,
      attemptNo: next.attemptNo + 1,
      nextAction: `watching run ${runId} to its verdict`,
      nextActionAt: null,
    });
    store.logSupervisorDecision({
      ticketKey: next.ticketKey,
      runId,
      decision: "submitted",
      reason: `attempt ${String(next.attemptNo + 1)} of ${String(next.maxAttempts)}`,
    });
    decisions.push(`submitted ${next.ticketKey} as ${runId}`);
    return this.#report(desired, decisions, runId);
  }

  #report(desired: SupervisorDesired, decisions: readonly string[], submittedRunId: string | null): SupervisorTickReport {
    return {
      ranAt: this.#now().toISOString(),
      desired,
      health: this.health(),
      decisions,
      submittedRunId,
      reentered: false,
    };
  }

  /** The ticket whose run is still alive, or null. */
  #inFlight(): SupervisorTicket | null {
    for (const ticket of this.#deps.store.listSupervisorTickets(["claimed", "running"])) {
      if (ticket.currentRunId === null) continue;
      const row = this.#deps.store.getRun(ticket.currentRunId);
      if (row !== null && !isTerminal(row.status)) return ticket;
    }
    return null;
  }

  /**
   * ONE `repairing` TICKET, ONE TICK, AND IT ALWAYS ENDS SOMEWHERE NAMED.
   *
   * The decision is {@link routeRepairOutcome}'s, twice: once before the driver
   * runs (which is where the deadline, the missing-driver case and the
   * per-signature bound are enforced) and once on its answer. This method is only
   * the IO — read the counter, call the dep, write the row, journal the sentence.
   *
   * THE COUNTER IS BUMPED BEFORE THE CALL, NOT AFTER IT. Identical reasoning to
   * the throw path in the claim step twenty lines up: a driver that throws or
   * hangs deterministically would otherwise be a free retry every 30 s, and a
   * spin that looks like work is the exact failure this component exists to end.
   *
   * A THROWING DRIVER IS AN `inconclusive` OUTCOME, NEVER AN ESCAPED EXCEPTION.
   * `tick()` is called from a 30 s interval; an exception here would abort the
   * whole tick, so the ticket would keep its `repairing` row AND the claim step
   * would never run — one bad driver stopping the entire queue.
   */
  async #repair(ticket: SupervisorTicket, runInFlight: boolean): Promise<string | null> {
    const store = this.#deps.store;
    const signature = ticket.lastDefectId;
    const key = signature ?? `class:${ticket.lastClass ?? "unclassified"}`;
    const storedCounts = store.readSupervisorRepairCounts(ticket.ticketKey);
    const counts = readRepairCounts(storedCounts);
    const base: Omit<RepairRoutingInput, "outcome"> = {
      ticketKey: ticket.ticketKey,
      signature,
      failureClass: ticket.lastClass,
      driverWired: this.#deps.repair !== undefined,
      cyclesSpent: counts[key] ?? 0,
      maxCycles: SUPERVISOR_REPAIR_MAX_PER_SIGNATURE,
      /*
       * A `repairing` TICKET WITH NO DEADLINE IS TREATED AS EXPIRED, NOT AS
       * IMMORTAL. `settle()` always writes one, so a null here means the row was
       * written by an older build (or by hand) — and the fail-safe direction for
       * an unattended machine is the terminal one, with a sentence, rather than a
       * ticket that sits in `repairing` because its clock was never set.
       */
      deadlinePassed:
        ticket.nextActionAt === null || new Date(ticket.nextActionAt).getTime() <= this.#now().getTime(),
      runInFlight,
    };

    const before = routeRepairOutcome({ ...base, outcome: null });
    if (!before.invoke) {
      if (before.code === "REPAIR_DEFERRED") {
        // The ticket STAYS in `repairing`, so only the sentence moves. The
        // deadline is deliberately not extended.
        store.updateSupervisorTicket(ticket.ticketKey, { nextAction: before.nextAction });
        return null; // not a decision: nothing changed but the sentence
      }
      this.#finishRepair(ticket, before, null);
      return `${ticket.ticketKey} left repairing as ${before.state}: ${before.code}`;
    }

    const bumped = bumpRepairCount(storedCounts, key);
    store.updateSupervisorTicket(ticket.ticketKey, {
      repairCounts: bumped.json,
      nextAction: before.nextAction,
    });
    store.logSupervisorDecision({
      ticketKey: ticket.ticketKey,
      runId: ticket.lastRunId,
      decision: "repairing",
      reason: before.reason,
    });

    let outcome: SupervisorRepairOutcome;
    try {
      outcome = await (this.#deps.repair as NonNullable<SupervisorDeps["repair"]>)({
        ticketKey: ticket.ticketKey,
        signature,
        runId: ticket.lastRunId,
        failureClass: ticket.lastClass,
        cycleNo: bumped.count,
        maxCycles: SUPERVISOR_REPAIR_MAX_PER_SIGNATURE,
        deadlineAt: ticket.nextActionAt ?? new Date(this.#now().getTime() + SUPERVISOR_REPAIR_DEADLINE_MS).toISOString(),
      });
    } catch (error) {
      outcome = {
        kind: "inconclusive",
        code: "REPAIR_DRIVER_THREW",
        detail: `the repair driver threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const after = routeRepairOutcome({ ...base, cyclesSpent: bumped.count, outcome });
    this.#finishRepair(ticket, after, outcome);
    return `${ticket.ticketKey} left repairing as ${after.state}: ${after.code}`;
  }

  /** The one write and the one journal row every terminal repair routing gets. */
  #finishRepair(ticket: SupervisorTicket, routing: RepairRouting, outcome: SupervisorRepairOutcome | null): void {
    this.#deps.store.updateSupervisorTicket(ticket.ticketKey, {
      state: routing.state,
      currentRunId: null,
      nextAction: routing.nextAction,
      // CLEARED, because the deadline was a repair-window instant and the ticket
      // has left the window. A stale instant on a `blocked` row would be read by
      // `#wake`'s own clock comparison if the ticket were ever re-queued.
      nextActionAt: null,
      ...(outcome !== null && outcome.kind === "applied" ? { patchId: outcome.patchId } : {}),
    });
    this.#deps.store.logSupervisorDecision({
      ticketKey: ticket.ticketKey,
      runId: ticket.lastRunId,
      decision: routing.state === "queued" ? "rerun" : "settled",
      reason: routing.reason,
    });
    this.#say(`SUPERVISOR REPAIR: ${ticket.ticketKey} -> ${routing.state} (${routing.code}) — ${routing.reason}`);
  }

  #reconcile(ticket: SupervisorTicket): string | null {
    const store = this.#deps.store;
    if (ticket.state === "waiting") return null; // step 2 owns these

    if (ticket.currentRunId === null) {
      store.updateSupervisorTicket(ticket.ticketKey, {
        state: "queued",
        nextAction: "re-submitting: the previous claim was lost before a run row existed",
      });
      store.logSupervisorDecision({
        ticketKey: ticket.ticketKey,
        runId: null,
        decision: "settled",
        reason: "orphan-claim: the ticket was claimed but names no run, so the submission was lost",
      });
      return `orphan claim on ${ticket.ticketKey} returned to the queue`;
    }

    const row = store.getRun(ticket.currentRunId);
    if (row === null) {
      store.updateSupervisorTicket(ticket.ticketKey, {
        state: "queued",
        currentRunId: null,
        nextAction: "re-submitting: the run this ticket named has no row",
      });
      store.logSupervisorDecision({
        ticketKey: ticket.ticketKey,
        runId: ticket.currentRunId,
        decision: "settled",
        reason: "vanished: the named run has no row",
      });
      return `${ticket.ticketKey} named a run with no row and was returned to the queue`;
    }

    if (isTerminal(row.status)) return this.settle(ticket, row.status, row.recoveryClass, row.runId);

    if (row.status === "rate_limited" || row.status === "awaiting_input") {
      /*
       * POLL, DO NOT HOLD A TIMER. A ticket that sleeps in the table costs
       * nothing across a restart; a seven-day wait held in a `setTimeout` is
       * lost on the first crash and looks, from outside, exactly like the
       * twelve-hour death of 2026-07-30.
       */
      const wakeAt = new Date(this.#now().getTime() + SUPERVISOR_DEFAULT_WAIT_MS).toISOString();
      store.updateSupervisorTicket(ticket.ticketKey, {
        state: "waiting",
        nextAction:
          row.status === "rate_limited"
            ? "waiting out the provider's refusal, then resuming this run"
            : "waiting for the run's own park to clear, then resuming it",
        nextActionAt: wakeAt,
      });
      store.logSupervisorDecision({
        ticketKey: ticket.ticketKey,
        runId: row.runId,
        decision: "waiting",
        reason: `the run is ${row.status}; the ticket wakes at ${wakeAt}`,
      });
      return `${ticket.ticketKey} is waiting on a ${row.status} run until ${wakeAt}`;
    }
    return null; // the run is live; leave it alone
  }

  #wake(ticket: SupervisorTicket): string | null {
    const store = this.#deps.store;
    if (ticket.nextActionAt !== null && new Date(ticket.nextActionAt).getTime() > this.#now().getTime()) return null;
    const row = ticket.currentRunId === null ? null : store.getRun(ticket.currentRunId);
    if (row !== null && !isTerminal(row.status) && this.#deps.resume?.(row.runId) === true) {
      store.updateSupervisorTicket(ticket.ticketKey, {
        state: "running",
        nextAction: `resumed run ${row.runId}; watching it to its verdict`,
        nextActionAt: null,
      });
      store.logSupervisorDecision({
        ticketKey: ticket.ticketKey,
        runId: row.runId,
        decision: "rerun",
        reason: "the wait expired and the run was still resumable, which is the cheap path",
      });
      return `${ticket.ticketKey} resumed ${row.runId}`;
    }
    store.updateSupervisorTicket(ticket.ticketKey, {
      state: "queued",
      currentRunId: null,
      nextAction: "re-submitting: the wait expired and the previous run could not be resumed",
      nextActionAt: null,
    });
    store.logSupervisorDecision({
      ticketKey: ticket.ticketKey,
      runId: ticket.currentRunId,
      decision: "rerun",
      reason: "the wait expired and the run was not resumable, so the ticket is queued for a fresh submission",
    });
    return `${ticket.ticketKey} woke and was queued for a fresh submission`;
  }

  /**
   * §7.6's table, and the one rule it turns on: a ticket at its cap is
   * `blocked`, never `queued`. Never loop.
   */
  settle(
    ticket: SupervisorTicket,
    status: ApiRunStatus,
    recoveryClass: string | null,
    runId: string,
  ): string {
    const store = this.#deps.store;
    const finish = (state: SupervisorTicketState, nextAction: string, reason: string): string => {
      store.updateSupervisorTicket(ticket.ticketKey, {
        state,
        currentRunId: null,
        lastRunId: runId,
        lastClass: recoveryClass,
        nextAction,
        nextActionAt: null,
      });
      store.logSupervisorDecision({ ticketKey: ticket.ticketKey, runId, decision: "settled", reason });
      return `${ticket.ticketKey} settled to ${state}: ${reason}`;
    };

    if (status === "passed") {
      return finish("done", "nothing: this ticket passed", `run ${runId} passed`);
    }
    if (status === "cancelled") {
      return finish("blocked", "nothing: a human cancelled this run", `run ${runId} was cancelled`);
    }
    // `failed` from here down.
    if (recoveryClass === "intentional") {
      return finish("blocked", "nothing: a human stopped this run", "the failure class is intentional");
    }
    /*
     * THE OWNER-ONLY CLASSES, NAMED BEFORE THE BUDGET IS CONSULTED. They have a
     * zero bound, so the arm below would already refuse to retry them — but
     * `repairing` says "an agent will propose a patch", and for these that is
     * false and dangerous. `owner_action` is `budget_exceeded` /
     * `missing_credential` (design §3.6 items 2 and 3: spend authorisation and a
     * credential that must never arrive through the chat). `integrity` is
     * `suite_hash_mismatch`, whose cheapest repair is re-freezing — which is
     * grader-softening wearing the word autonomy.
     *
     * THE LIST WAS HAND-WRITTEN HERE AND IS NOW ASKED FOR, 2026-08-10, for the
     * same reason the budget below is asked for and never restated: this arm was
     * the ONLY definition of "no agent may propose a repair", and
     * `orchestrator.ts` was independently deriving the defect record's
     * `repairable` field from `boundFor(...) > 0` — a retry-budget predicate that
     * is `false` for every class the split created. The record therefore said
     * repairable=false about the same failure this arm was routing to `repairing`,
     * and both reached the owner. {@link isRepairable} is now the single answer
     * and both callers read it.
     *
     * `=== false`, NOT `!isRepairable(...)`, AND THAT PRESERVES THE UNKNOWN-CLASS
     * ARM BELOW. `isRepairable` is an exhaustive switch with no `default`, so a
     * class string written by a newer build returns `undefined` at runtime.
     * Negating that would send every unrecognised class to `blocked` and silently
     * delete the "unknown to this build" sentence the next arm exists to print.
     */
    const repairAllowed = isRepairable(recoveryClass as FailureClass) as boolean | undefined;
    if (repairAllowed === false) {
      return finish(
        "blocked",
        `nothing automatic: class '${String(recoveryClass)}' is owner-only and no agent may propose a repair for it`,
        `run ${runId} failed with the owner-only class '${String(recoveryClass)}'`,
      );
    }
    /*
     * THE BUDGET IS ASKED FOR, NEVER RESTATED. An earlier draft of this method
     * hard-listed the zero-bound classes and MISSED TWO of the eleven, which
     * re-submitted a spend refusal up to `maxAttempts`. `recovery.ts` owns the
     * table; a copy of it here is a second answer to a question that must have
     * one.
     *
     * `typeof bound !== "number"` IS THE UNKNOWN-CLASS ARM AND IT IS LOAD-BEARING.
     * `boundFor` is an exhaustive switch with no `default`, so a class string it
     * has never seen returns `undefined` at runtime — and `runs.recovery_class`
     * is read with `strOrNull`, not `oneOf`, precisely so that a word written by
     * a newer version reads through instead of throwing. A class this file does
     * not recognise therefore takes the CONSERVATIVE path (no retry), which is
     * the same default `classOfBakeoffCode` chose for the same reason.
     */
    const bound = boundFor(recoveryClass as FailureClass) as number | undefined;
    if (typeof bound !== "number" || bound === 0) {
      /*
       * REPAIRING, NOT QUEUED, AND THE REASON IS MEASURED. A zero bound means
       * the layer that still had the evidence declared a byte-identical retry
       * futile. Re-queueing here would spend another 87-minute spec phase on the
       * defect that just killed one — which is what `a913c871` would have cost.
       */
      /*
       * AND IT NOW CARRIES A DEADLINE AND A SIGNATURE, WHICH IS WHAT MAKES
       * `repairing` A STATE RATHER THAN A DEAD END.
       *
       * MEASURED 2026-08-10: the sentence here used to be "waiting for a repair
       * proposal for this failure class" and nothing in the tree ever produced
       * one or moved a ticket out — no route, no loop, no process. So the two
       * fields the repair step needs are written at the moment the evidence is
       * still in hand: `nextActionAt` is the window after which the ticket
       * leaves `repairing` no matter what anybody does, and `lastDefectId` is the
       * signature the per-signature cycle bound counts against. A `repairing`
       * row with neither is what the old build produced, and `#repair` treats a
       * null deadline as EXPIRED for exactly that reason.
       */
      const deadlineAt = new Date(this.#now().getTime() + SUPERVISOR_REPAIR_DEADLINE_MS).toISOString();
      const signature = this.#deps.defectSignatureOf?.(runId) ?? null;
      const settled = finish(
        "repairing",
        `a repair cycle for defect ${signature ?? "(no signature recorded)"} runs on the next tick; this ticket ` +
          `leaves 'repairing' by ${deadlineAt} whatever happens`,
        `run ${runId} failed with class '${String(recoveryClass ?? "none recorded")}', whose retry bound is ` +
          `${typeof bound === "number" ? "0" : "unknown to this build"}`,
      );
      /*
       * AFTER `finish`, NOT BEFORE IT, AND THE ORDER IS LOAD-BEARING. `finish`
       * writes `nextActionAt: null` — correctly, because every OTHER state it
       * writes is terminal and must not carry a future instant. `repairing` is the
       * one non-terminal state it produces, so the deadline goes on here, second.
       *
       * DELETE THIS WRITE AND C IS SILENTLY OFF: `#repair` reads a null
       * `nextActionAt` as EXPIRED (deliberately — see its `deadlinePassed`), so
       * every repairing ticket would terminate on the next tick with
       * `REPAIR_DEADLINE_EXCEEDED` and no driver would ever be called. Watched red
       * 2026-08-10; the transcript is in the round report.
       */
      store.updateSupervisorTicket(ticket.ticketKey, { lastDefectId: signature, nextActionAt: deadlineAt });
      return settled;
    }
    if (ticket.attemptNo >= ticket.maxAttempts) {
      return finish(
        "blocked",
        `nothing: this ticket has used all ${String(ticket.maxAttempts)} attempts`,
        `run ${runId} failed at attempt ${String(ticket.attemptNo)} of ${String(ticket.maxAttempts)}`,
      );
    }
    return finish(
      "queued",
      `re-submitting: attempt ${String(ticket.attemptNo + 1)} of ${String(ticket.maxAttempts)}`,
      `run ${runId} failed with class '${String(recoveryClass ?? "none recorded")}' and attempts remain`,
    );
  }
}
