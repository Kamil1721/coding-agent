/**
 * supervisor-boot.ts — THE WIRING. The reason this file exists is that without
 * it every claim made about the supervisor was false.
 *
 * MEASURED, 2026-08-10: `grep -in supervisor dashboard/server/src/index.ts` ->
 * 0 hits in a 130-line file. `SupervisorLoop` was constructed by nobody, there
 * was no 30 s interval, `HttpDeps.supervisor` was never passed, so every
 * `POST /api/supervisor/*` answered 503 `supervisor_not_wired` and every GET
 * answered `probe.wired: false`. The loop's proven behaviours — crash recovery,
 * orphan requeue, wake, drain — were all real and all unreachable, and
 * `SupervisorLoop.armCheck()` had no caller outside its own test. An arm check
 * only a test calls is a test.
 *
 * THREE THINGS LIVE HERE AND THEY ARE DELIBERATELY SEPARATE FUNCTIONS.
 *
 *   `startSupervisor`        arms, refuses to run blind, holds the interval.
 *   `createSupervisorSubmit` the `submit` dependency the loop has no default for.
 *   nothing else.
 *
 * WHY NOT IN `index.ts` DIRECTLY. `index.ts:main()` binds a port and opens the
 * owner's database, so nothing in it can be unit-tested; a boot sequence that
 * can only be verified by starting the whole dashboard is a boot sequence whose
 * arm check nobody proves. Everything decidable is therefore a pure-ish function
 * over injected seams here, and `index.ts` keeps only the call.
 *
 * ── THE RULE-4 ARM GATE, WHICH IS THE POINT OF THE FILE ───────────────────────
 *
 * `armCheck()` feeds the health discriminator three snapshots whose answers are
 * known in the source and requires three DIFFERENT verdicts. If it reports
 * blind, this file does NOT start the interval and forces `desired='stopped'`.
 * A blind supervisor that keeps ticking is strictly worse than a stopped one: it
 * spends the owner's quota on decisions taken by a discriminator that cannot
 * tell an idle queue from a lost submission, and it prints nothing while doing
 * it. Refusing to run is the fail-safe direction, and the refusal is written to
 * `supervisor_state` so `GET /api/supervisor` reports it rather than only stdout.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ticketWithReferences } from "./ticket.js";
import type { ApiProvider } from "./api-types.js";
import type { NewRun, RunRow, SupervisorDesired, SupervisorState } from "./db.js";
import type { SupervisorRepairOutcome, SupervisorRepairRequest, SupervisorSubmission } from "./supervisor.js";

/** The 30 s the design names. Exported so the test does not restate it. */
export const SUPERVISOR_TICK_MS = 30_000;

/**
 * WHAT THIS FILE NEEDS OF A LOOP, WHICH IS TWO METHODS.
 *
 * Narrow on purpose: the test drives a fake, and a fake that had to be a whole
 * `SupervisorLoop` would need a whole `RunStore`, i.e. the owner's database, i.e.
 * the arm gate would be unprovable again.
 */
export interface ArmableLoop {
  armCheck(): { readonly armed: boolean; readonly lines: readonly string[] };
  tick(): unknown;
}

/** The two `supervisor_state` methods the arm gate uses. */
export interface DesiredStateStore {
  readSupervisorState(): SupervisorState;
  setSupervisorState(desired: SupervisorDesired, changedBy: string, reason: string): SupervisorState;
}

/** An injectable timer, so the test never waits 30 s and never leaks a handle. */
export interface BootTimer {
  set(fn: () => void, ms: number): { unref(): void };
  clear(handle: { unref(): void }): void;
}

const REAL_TIMER: BootTimer = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => { clearInterval(handle as unknown as NodeJS.Timeout); },
};

export interface StartedSupervisor {
  /** False means the discriminator could not tell its own outputs apart. */
  readonly armed: boolean;
  /** True only when a repeating tick is actually installed. */
  readonly ticking: boolean;
  readonly lines: readonly string[];
  /** Idempotent. Called from `index.ts`'s shutdown. */
  stop(): void;
}

export interface StartSupervisorInput {
  readonly loop: ArmableLoop;
  readonly store: DesiredStateStore;
  readonly log?: (line: string) => void;
  readonly intervalMs?: number;
  readonly timer?: BootTimer;
}

/**
 * Arm the loop, then either install the tick or refuse to.
 *
 * THE ORDER IS THE POLICY: arm first, and never tick before the arm check has
 * answered. A tick before the arm check is a decision taken by a component whose
 * blindness has not been ruled out.
 */
export function startSupervisor(input: StartSupervisorInput): StartedSupervisor {
  const log = input.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const timer = input.timer ?? REAL_TIMER;
  const intervalMs = input.intervalMs ?? SUPERVISOR_TICK_MS;

  const arm = input.loop.armCheck();
  for (const line of arm.lines) log(`  ${line}`);

  if (!arm.armed) {
    /*
     * BLIND: STOP, AND WRITE THE STOP DOWN. `desired` is forced to `stopped`
     * even if it was already `stopped`, because the REASON is the payload — the
     * route reads it and the strip renders it, and "the owner stopped it" and
     * "the boot arm check refused to start it" must not be the same sentence.
     */
    const before = input.store.readSupervisorState().desired;
    input.store.setSupervisorState(
      "stopped",
      "boot",
      "the boot arm check reported the supervisor BLIND: its health discriminator could not tell its own " +
        "outputs apart, so no tick was installed and nothing will claim a ticket",
    );
    log(
      `ARM CHECK FAILED: the supervisor is BLIND and was NOT started (desired was '${before}', now forced to ` +
        "'stopped'). Nothing will claim a ticket until this is fixed — this is the fail-safe direction, not an idle system.",
    );
    return { armed: false, ticking: false, lines: arm.lines, stop: () => undefined };
  }

  const tickOnce = (why: string): void => {
    try {
      const result = input.loop.tick();
      // `tick()` is async. An unhandled rejection from a 30 s interval kills the
      // process under Node's default policy, which would take the dashboard with
      // it — the exact "the smallest thing goes wrong and the whole thing stops"
      // this component exists to end.
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          log(`supervisor tick (${why}) threw and was absorbed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (error) {
      log(`supervisor tick (${why}) threw and was absorbed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handle = timer.set(() => { tickOnce("interval"); }, intervalMs);
  // NEVER HOLDS THE PROCESS OPEN. A live interval on an exiting process is a
  // dashboard that will not respond to Ctrl-C.
  handle.unref();
  log(
    `ARM CHECK: supervisor loop armed; ticking every ${String(Math.round(intervalMs / 1000))}s, ` +
      `desired reads '${input.store.readSupervisorState().desired}'`,
  );
  // THE BOOT TICK, AFTER the interval is installed: §7 names boot as a tick
  // site, and it is what recovers an orphaned claim left by a `kill -9`.
  tickOnce("boot");

  let stopped = false;
  return {
    armed: true,
    ticking: true,
    lines: arm.lines,
    stop: () => {
      if (stopped) return;
      stopped = true;
      timer.clear(handle);
    },
  };
}

/* =========================================================================
 * THE SUBMISSION
 * ====================================================================== */

/** What `createSupervisorSubmit` needs. Narrow, for the same reason as above. */
export interface SubmitDeps {
  readonly store: {
    createRun(run: NewRun): RunRow;
    listQueued(): readonly RunRow[];
  };
  readonly bus: { emit(runId: string, event: { type: "status"; status: "queued" } | { type: "phase"; phase: "spec" }): unknown };
  readonly catalog: { resolve(modelId: string): Promise<{ readonly option: { readonly provider: ApiProvider; readonly available: boolean; readonly reason?: string | null } } | null> };
  readonly orchestrator: { pump(): void };
}

/**
 * The `submit` the loop has no default for, and the two things it does NOT do.
 *
 * IT DOES NOT CAPTURE, AND THAT IS A CORRECTNESS REQUIREMENT, NOT A SHORTCUT.
 * `POST /api/runs` scans the brief for a URL and folds the capture's outline
 * into the ticket identity. A capture is a live network read: two attempts at
 * the SAME supervisor ticket would fold different outlines, mint different
 * ticket ids, find no frozen acceptance suite and pay for a second spec phase —
 * with no throw and no compile error. A supervisor retry must be able to reuse
 * the suite its first attempt authored, so the identity has to be a function of
 * the brief alone. A supervisor ticket that needs a captured page must therefore
 * carry the outline in its text.
 *
 * IT DOES NOT CARRY REFERENCES OR DOCUMENTS. `supervisor_tickets` has no columns
 * for them, so there is nothing to lose; when it grows them this function is the
 * one place that changes.
 *
 * IT USES `ticketWithReferences`, NOT ITS OWN HASHING. That function is the sole
 * producer of the `(id, sha256)` pair, and a second construction of it is how a
 * run ends up graded under a suite it never authored.
 */
/* =========================================================================
 * THE REPAIR DRIVER
 *
 * `supervisor.ts` owns the routing and the bounds; this owns the one call that
 * crosses out of the TypeScript build. `tools/repair/` is `.mjs` at the
 * repository root, outside `dashboard/server`'s package boundary, so it is
 * SPAWNED rather than imported: a `tsc` build that reached up two directories
 * into an untyped tree would either fail or need `allowJs`, and neither is worth
 * paying for one call.
 * ====================================================================== */

/** What `createRepairDriver` needs. Every seam is injectable, so it is testable. */
export interface RepairDriverDeps {
  /** Absolute path to `tools/repair/supervisor-cycle.mjs`. */
  readonly cyclePath: string;
  /** `dashboard/runs` — where `results/defect.json` lives, per run. */
  readonly runsDir: string;
  /** `dashboard/data/defects/ruled-out` — the append-only ledger directory. */
  readonly ledgerDir: string;
  /** Where a hand-authored candidate diff is looked for, named by signature. */
  readonly proposalsDir: string;
  /**
   * Where the cycle writes the rollback record for a patch it applied. Separate
   * from `proposalsDir` because a proposal is an INPUT a human may edit and a
   * rollback point is an OUTPUT nothing may edit: the only thing standing between
   * an unattended patch and a tree nobody can restore.
   */
  readonly rollbackDir: string;
  /**
   * Runs the cycle and returns its stdout. Injected so the test never spawns a
   * process it did not write, and so a spawn failure is a value rather than an
   * exception in the middle of a tick.
   *
   * `timedOut` IS A SEPARATE FIELD AND NOT AN `ok: false`. A cycle killed by the
   * clock and a cycle that exited non-zero mean different things to the owner,
   * and the second one may still have printed a usable verdict.
   */
  readonly run: (args: readonly string[]) => {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
  };
  readonly log?: (line: string) => void;
}

/**
 * THE PER-CYCLE WALL CLOCK, AND WHY IT IS NOT OPTIONAL.
 *
 * `SupervisorLoop.#repair` AWAITS the driver inside `tick()`, behind the
 * re-entrancy flag. A cycle that hangs therefore stops every subsequent tick:
 * nothing reconciles, nothing wakes, nothing is claimed, and the strip keeps
 * showing the last reading it took. That is the queue dying silently — the exact
 * failure the supervisor exists to end — caused by the component meant to fix
 * things. Ten minutes is longer than the gate needs and shorter than a night.
 */
export const REPAIR_CYCLE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * The `repair` dep the loop has no default for.
 *
 * THE ONE THING IT MAY NOT DO IS THROW. `SupervisorLoop.#repair` catches and
 * converts, but a driver whose own failures arrive as exceptions makes every
 * fault read as `REPAIR_DRIVER_THREW` — one code for "the script is missing",
 * "the JSON was truncated" and "the ledger directory is read-only". So each of
 * those is a NAMED `inconclusive` outcome instead, and the ticket's sentence says
 * which. Every path returns; nothing here is allowed to be silent.
 */
export function createRepairDriver(deps: RepairDriverDeps): (request: SupervisorRepairRequest) => Promise<SupervisorRepairOutcome> {
  const log = deps.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  return (request: SupervisorRepairRequest): Promise<SupervisorRepairOutcome> => {
    if (request.runId === null) {
      return Promise.resolve({
        kind: "inconclusive",
        code: "NO_RUN_TO_REPAIR",
        detail:
          "the ticket names no run, so there is no defect record to repair from. A repairing ticket with no " +
          "`last_run_id` was written by something other than settle().",
      });
    }
    const defectPath = join(deps.runsDir, request.runId, "results", "defect.json");
    const args = [
      deps.cyclePath,
      "--defect",
      defectPath,
      "--ledger",
      deps.ledgerDir,
      "--proposals",
      deps.proposalsDir,
      "--rollback",
      deps.rollbackDir,
      /*
       * THE TICKET'S DEADLINE TRAVELS INTO THE CYCLE. The supervisor's bound
       * governs the TICKET across ticks; this hands the same instant to the
       * CYCLE, so a cycle starting inside a window that has already closed
       * refuses to spend a gate run on a ticket that is about to be terminated
       * anyway. Two enforcers, one instant — not two clocks.
       */
      "--deadline",
      request.deadlineAt,
    ];
    const result = deps.run(args);
    /*
     * THE CLOCK IS READ BEFORE THE OUTPUT IS, because a killed cycle's stdout is
     * whatever it had managed to flush — possibly a complete-looking JSON line
     * from an earlier stage. A timed-out cycle has no verdict by definition.
     */
    if (result.timedOut === true) {
      log(`SUPERVISOR REPAIR: the cycle was killed by its own wall clock after running too long`);
      return Promise.resolve({
        kind: "inconclusive",
        code: "REPAIR_CYCLE_TIMED_OUT",
        detail:
          `${deps.cyclePath} was killed by the per-cycle wall clock before it reached a verdict for run ` +
          `${request.runId}. The bound exists because the supervisor AWAITS this call inside a tick: a cycle ` +
          "allowed to hang would stop every subsequent tick, and the queue would die silently.",
      });
    }
    /*
     * A NON-ZERO EXIT IS STILL READ FOR AN ANSWER BEFORE IT IS TREATED AS A
     * FAULT, because the cycle prints its verdict and then may exit non-zero for
     * an unrelated reason (a full disk on the ledger write). Parse first, and only
     * report a spawn fault when there is genuinely nothing to read.
     */
    const line = result.stdout.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
    if (line === "") {
      log(`SUPERVISOR REPAIR: the cycle printed nothing (ok=${String(result.ok)}): ${result.stderr.trim() || "(no stderr)"}`);
      return Promise.resolve({
        kind: "inconclusive",
        code: "REPAIR_CYCLE_SILENT",
        detail:
          `${deps.cyclePath} produced no verdict on stdout for run ${request.runId} (exit ok=${String(result.ok)}). ` +
          `stderr: ${result.stderr.trim().slice(0, 400) || "(empty)"}`,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return Promise.resolve({
        kind: "inconclusive",
        code: "REPAIR_CYCLE_UNREADABLE",
        detail: `${deps.cyclePath} answered something that is not JSON: ${line.slice(0, 400)}`,
      });
    }
    const bag = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const kind = bag["kind"];
    const code = typeof bag["code"] === "string" ? bag["code"] : "NO_CODE";
    const detail = typeof bag["detail"] === "string" ? bag["detail"] : "the cycle named no reason";
    if (kind === "applied") {
      /*
       * AN APPLIED PATCH MUST NAME ITS ROLLBACK POINT, AND WITHOUT ONE IT IS NOT
       * READ AS APPLIED.
       *
       * This is the one arm where the conservative direction is not obvious.
       * Downgrading to `inconclusive` leaves a patch in the tree that the ticket
       * does not admit to — but the ticket says so, in its own sentence, and the
       * alternative is worse: `applied` re-queues the ticket for a run, and a run
       * on a patched tree nobody can revert is the state that needs a human at
       * 3am. So the tree is reported as CHANGED and UNREVERTIBLE, loudly, rather
       * than as repaired.
       */
      const rollbackPath = typeof bag["rollbackPath"] === "string" ? bag["rollbackPath"] : null;
      const patchId = typeof bag["patchId"] === "string" ? bag["patchId"] : null;
      if (rollbackPath === null || rollbackPath.trim() === "") {
        return Promise.resolve({
          kind: "inconclusive",
          code: "APPLIED_WITHOUT_ROLLBACK_POINT",
          detail:
            `${deps.cyclePath} reports that it applied a patch (${code}) and named NO rollback record, so nothing on ` +
            `this machine knows how to undo it without a human: ${detail}. The ticket is NOT re-queued — a run on a ` +
            "tree that cannot be restored is worse than a failure that stopped.",
        });
      }
      return Promise.resolve({
        kind: "applied",
        code,
        /*
         * THE COMMAND IS SPELLED OUT, AND IT IS ONE THAT EXISTS. This sentence
         * used to read "Revert with tools/repair/supervisor-gate.mjs from <path>",
         * naming a script whose CLI ran only `armCheck()` — so the owner's
         * remediation at 3am was to write a node one-liner. The `--revert` arm now
         * exists; nothing reverts on its own, and the sentence says that too,
         * because `revertGatedPatch` still has no production caller.
         */
        detail:
          `${detail} NOTHING WILL REVERT THIS ON ITS OWN — run: ` +
          `node tools/repair/supervisor-gate.mjs --revert ${rollbackPath}`,
        // A PATCH WITH NO ID IS NOT AN APPLIED PATCH. `lastRepair` on the strip is
        // specified as "blank is not legal", so a missing identifier gets a
        // visible placeholder rather than an empty string.
        patchId: patchId ?? (typeof bag["fingerprint"] === "string" ? bag["fingerprint"] : null) ?? "(the cycle applied a patch it did not fingerprint)",
      });
    }
    if (kind === "refused") return Promise.resolve({ kind: "refused", code, detail });
    /*
     * ANYTHING ELSE IS `inconclusive`, INCLUDING A `kind` THIS BUILD DOES NOT
     * KNOW. The conservative direction: an unrecognised verdict must never be read
     * as "a patch was applied", because that would re-queue a ticket onto an
     * unpatched tree and spend a run proving it.
     */
    return Promise.resolve({
      kind: "inconclusive",
      code: kind === "inconclusive" ? code : `UNKNOWN_VERDICT_${String(kind)}`,
      detail,
    });
  };
}

/**
 * THE REAL SPAWN, WITH THE CLOCK ON IT.
 *
 * Lives here rather than in `index.ts` for the same reason everything else does:
 * `index.ts` binds a port, so nothing in it is unit-testable, and a timeout that
 * only exists in an untested file is a timeout nobody has watched fire.
 */
export function createCycleRunner(timeoutMs: number = REPAIR_CYCLE_TIMEOUT_MS): RepairDriverDeps["run"] {
  return (args) => {
    const result = spawnSync(process.execPath, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      /*
       * SIGKILL, NOT SIGTERM — AND IT REAPS THE CHILD ONLY. SAY SO.
       *
       * This comment used to claim that SIGKILL covers the grandchildren "holding
       * the clock this bound exists to enforce". IT DOES NOT. `spawnSync` signals
       * the child pid; there is no `detached: true` and no process-group kill
       * anywhere on this path, so a Tier 3 gate that the cycle spawned survives its
       * parent being killed and keeps running — writing `dashboard/data/tier3`, and
       * on a machine with docker, holding containers — while the supervisor has
       * already filed the ticket as REPAIR_CYCLE_TIMED_OUT and moved on.
       *
       * WHAT IS BOUGHT INSTEAD, TODAY: `GATE_TIMEOUT_MS` in
       * `tools/repair/supervisor-cycle.mjs` is now strictly SHORTER than this
       * clock, so on a hanging gate the INNER clock fires first, inside the cycle
       * that is the gate's real parent, and this outer kill is the fail-safe rather
       * than the normal path. Reaping the group needs an async spawn (`spawn` +
       * `process.kill(-pid)`), which changes `RepairDriverDeps["run"]` from sync to
       * async and is carried forward, NOT claimed here.
       */
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });
    const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error === undefined ? "" : result.error.message),
      ...(timedOut ? { timedOut: true } : {}),
    };
  };
}

export interface RepairDriverArm {
  readonly armed: boolean;
  readonly probes: number;
  readonly wrong: readonly string[];
  readonly lines: readonly string[];
}

/**
 * THE DRIVER'S OWN ARM CHECK, AND THE REASON RULE 4 NEEDS ONE.
 *
 * `SupervisorLoop.armCheck()` used to print "a repair driver is wired" on the
 * strength of `repair !== undefined` and two constants read out of this build. It
 * observed NOTHING about the driver. That is a boot line reporting a healthy
 * component it cannot see, which is strictly worse than the honest absence it
 * replaced: the owner reads "a driver is wired" and leaves for eight hours.
 *
 * SO THE DRIVER IS DRIVEN, IN BOTH HALVES, WITH ANSWERS WRITTEN HERE IN THE SOURCE.
 *
 *   THE READER (this file). Eight known cycle answers must produce eight DISTINCT
 *   codes and eight DISTINCT sentences, exactly one of which is `applied`, and the
 *   `applied` one must carry a rollback point. Collapse any two arms of the parser
 *   — or let an unknown verdict read as a patch that landed — and the pair is
 *   named here.
 *
 *   THE DECIDER (`tools/repair/supervisor-cycle.mjs --armcheck`). Spawned, because
 *   it is `.mjs` outside this package boundary and cannot be imported. Its own arm
 *   check drives nine routing inputs AND the gate seam's eight verdict records. A
 *   reader that is perfect in front of a decider that reads every gate verdict as
 *   APPLY would report armed and be catastrophically wrong.
 *
 * IT SPENDS NO QUOTA AND WRITES NOTHING. `--armcheck` runs in a throwaway
 * directory and returns; that is what makes it safe to run at start-up on the
 * owner's real machine, and it is why the check exists at boot rather than only in
 * a test file.
 */
export async function armRepairDriver(deps: RepairDriverDeps): Promise<RepairDriverArm> {
  const wrong: string[] = [];
  const probes: readonly {
    readonly want: string;
    readonly kind: SupervisorRepairOutcome["kind"];
    readonly answer: { readonly ok: boolean; readonly stdout: string; readonly timedOut?: boolean };
  }[] = [
    {
      want: "GATE_APPLY",
      kind: "applied",
      answer: {
        ok: true,
        stdout: JSON.stringify({
          kind: "applied",
          code: "GATE_APPLY",
          detail: "the arm check's known-good answer",
          patchId: "armpatch",
          rollbackPath: "/dev/null/arm.json",
        }),
      },
    },
    {
      want: "APPLIED_WITHOUT_ROLLBACK_POINT",
      kind: "inconclusive",
      answer: { ok: true, stdout: JSON.stringify({ kind: "applied", code: "GATE_APPLY", detail: "no rollback point", patchId: "armpatch" }) },
    },
    {
      want: "GATE_REFUSE",
      kind: "refused",
      answer: { ok: true, stdout: JSON.stringify({ kind: "refused", code: "GATE_REFUSE", detail: "the arm check's known refusal" }) },
    },
    {
      want: "GATE_BLIND",
      kind: "inconclusive",
      answer: { ok: true, stdout: JSON.stringify({ kind: "inconclusive", code: "GATE_BLIND", detail: "the arm check's known non-verdict" }) },
    },
    { want: "REPAIR_CYCLE_SILENT", kind: "inconclusive", answer: { ok: false, stdout: "" } },
    { want: "REPAIR_CYCLE_UNREADABLE", kind: "inconclusive", answer: { ok: false, stdout: "Error: cannot find module\n" } },
    { want: "REPAIR_CYCLE_TIMED_OUT", kind: "inconclusive", answer: { ok: false, stdout: "", timedOut: true } },
    {
      want: "UNKNOWN_VERDICT_escalated",
      kind: "inconclusive",
      answer: { ok: true, stdout: JSON.stringify({ kind: "escalated", code: "TIER_3", detail: "a word from a newer build" }) },
    },
  ];

  /*
   * THE PROBE LOOP IS NOT WRAPPED IN A CATCH, AND THAT IS A MEASURED DECISION
   * RATHER THAN AN OVERSIGHT.
   *
   * One was written and then removed, because it survived its own mutation:
   * deleting it left the test that was supposed to prove it GREEN. The reason is
   * visible two lines below — this loop OVERRIDES `run` with its own fixed answer,
   * so `deps.run` is never called here and no injected seam can make this loop
   * throw. `createRepairDriver` construction cannot throw, the driver's own body
   * returns on every path, and its `JSON.parse` is already inside a `try`. A guard
   * over that is unreachable code that reads like protection, and this repository
   * has twenty-two catalogued instances of exactly that shape.
   *
   * THE ONE REAL THROW SEAM IN THIS FUNCTION IS THE SPAWN, and it IS guarded, by
   * name, further down — with a test that goes RED when the guard is removed. That
   * matters because this function is awaited in `main()` ABOVE `server.listen`: an
   * exception here means the dashboard never binds, which is the exact outcome the
   * 30 s clock exists to prevent.
   */
  const got: SupervisorRepairOutcome[] = [];
  for (const probe of probes) {
    const driver = createRepairDriver({
      ...deps,
      log: () => undefined,
      run: () => ({ ok: probe.answer.ok, stdout: probe.answer.stdout, stderr: "", ...(probe.answer.timedOut === true ? { timedOut: true } : {}) }),
    });
    got.push(
      await driver({
        ticketKey: "arm-ticket",
        signature: "a".repeat(64),
        runId: "arm-run",
        failureClass: "structural",
        cycleNo: 1,
        maxCycles: 1,
        deadlineAt: "2099-01-01T00:00:00.000Z",
      }),
    );
  }

  const codes = new Set(got.map((g) => g.code)).size;
  const sentences = new Set(got.map((g) => g.detail)).size;
  probes.forEach((probe, index) => {
    const answer = got[index];
    if (answer === undefined) return;
    if (answer.code !== probe.want) wrong.push(`${probe.want} read as ${answer.code}`);
    if (answer.kind !== probe.kind) wrong.push(`${probe.want} answered kind '${answer.kind}', wanted '${probe.kind}'`);
    if (answer.detail.trim() === "") wrong.push(`${probe.want} carries a blank sentence`);
  });
  if (got.length === probes.length) {
    if (codes !== probes.length) wrong.push(`${String(probes.length)} cycle answers collapsed into ${String(codes)} code(s)`);
    if (sentences !== probes.length) wrong.push(`${String(probes.length)} cycle answers collapsed into ${String(sentences)} sentence(s)`);
    const applied = got.filter((g) => g.kind === "applied").length;
    if (applied !== 1) wrong.push(`${String(applied)} of ${String(probes.length)} cycle answers were read as an applied patch; exactly one may be`);
  }

  /*
   * THE DECIDER'S OWN ARM CHECK, SPAWNED — AND READ, NOT MERELY EXIT-CODED.
   *
   * THE DEFECT THIS BLOCK EXISTS FOR. The whole verification of the decider used
   * to be `if (!decider.ok)`, and every line the child printed was then echoed
   * onto the boot block as `ARM CHECK: (cycle) <line>` regardless of what it said.
   * So a runner that exits 0 while printing something that is not an arm-check
   * report at all produced `armed=true, wrong=[]` and a boot block that LOOKED
   * healthy while quoting arbitrary text. That is a boot line reporting a
   * component it cannot see, which is the one direction rule 4 calls worse than an
   * honest absence.
   *
   * THE COUPLING THAT WAS ASSUMED IS NOW ASSERTED. `supervisor-cycle.mjs` ends
   * `process.exit(arm.armed ? 0 : 1)` and prints `ARM CHECK: armed — …` or
   * `ARM CHECK: BLIND — …` as its LAST line. Nothing here checked either fact, so
   * one refactor of that exit path would have made the boot line fiction. Both
   * halves are checked, and they are checked against EACH OTHER: an exit code that
   * disagrees with the printed verdict is its own named fault, because the two
   * disagreeing means one of them is not measuring the cycle.
   *
   * A MISSING SCRIPT IS NOT A BLIND ONE. `cyclePath` is derived from
   * `DASHBOARD_HOME`; point that anywhere but the repo's `dashboard/` and the
   * spawn fails for a reason that has nothing to do with the decider's eyesight.
   * "Nobody installed one" wearing "we refused a bad one" is the collapse the
   * three-state boot reading exists to prevent, so it gets its own sentence.
   */
  const deciderVerdict = /^ARM CHECK: (armed|BLIND)\b/;
  let deciderLines: string[] = [];
  if (!existsSync(deps.cyclePath)) {
    wrong.push(
      `the repair cycle script is not at ${deps.cyclePath}, so no decider was driven at all — this is "nobody installed one", ` +
        "not \"we refused a blind one\", and DASHBOARD_HOME pointing outside the repository is the way it happens",
    );
  } else {
    let decider: { readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean };
    try {
      decider = deps.run([deps.cyclePath, "--armcheck"]);
    } catch (error) {
      decider = { ok: false, stdout: "", stderr: `the spawn threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    deciderLines = decider.stdout.split("\n").filter((l) => l.trim() !== "");
    const verdictLine = deciderLines.filter((l) => deciderVerdict.test(l)).pop() ?? null;
    if (!decider.ok) {
      wrong.push(
        `${deps.cyclePath} --armcheck reported BLIND or could not run: ` +
          `${deciderLines.slice(-2).join(" | ") || decider.stderr.trim().slice(0, 300) || "(it said nothing at all)"}`,
      );
    }
    if (verdictLine === null) {
      wrong.push(
        `${deps.cyclePath} --armcheck exited ok=${String(decider.ok)} and printed no arm-check verdict line — nothing it said ` +
          `matched ${String(deciderVerdict)}, so its ${String(deciderLines.length)} line(s) are text of unknown meaning and must ` +
          `not be quoted onto a boot block as health: ${deciderLines.slice(-2).join(" | ") || "(it printed nothing)"}`,
      );
    } else if (deciderLines[deciderLines.length - 1] !== verdictLine) {
      wrong.push(
        `${deps.cyclePath} --armcheck printed its verdict line and then kept talking, so the last line of the boot block is ` +
          `not the cycle's verdict: ${String(deciderLines[deciderLines.length - 1]).slice(0, 200)}`,
      );
    } else if (decider.ok !== /^ARM CHECK: armed\b/.test(verdictLine)) {
      wrong.push(
        `${deps.cyclePath} --armcheck exited ok=${String(decider.ok)} while printing '${verdictLine.slice(0, 120)}' — the exit code ` +
          "and the printed verdict disagree, so one of them is not measuring the cycle and neither can be believed",
      );
    }
    /*
     * AND THE QUOTED TEXT MUST COVER THE GATE SEAM. This function's docblock
     * claims the decider drives "the gate seam's eight verdict records"; a cycle
     * that stopped printing that half would leave the claim standing over output
     * that no longer contains it.
     */
    if (decider.ok && !deciderLines.some((l) => /gate-verdict router/.test(l))) {
      wrong.push(
        `${deps.cyclePath} --armcheck said nothing about the gate-verdict seam, so this boot block cannot claim the gate ` +
          "records were driven — the sentence below would be describing a measurement that is not in the text above it",
      );
    }
  }

  const armed = wrong.length === 0;
  return {
    armed,
    probes: probes.length,
    wrong,
    lines: [
      `ARM CHECK: repair driver reads ${String(codes)} distinct code(s) and ${String(sentences)} distinct sentence(s) ` +
        `from ${String(probes.length)} known cycle answers, exactly ${String(got.filter((g) => g.kind === "applied").length)} of them applied; ` +
        `${String(wrong.length)} misread`,
      ...deciderLines.map((line) => `ARM CHECK: (cycle) ${line.replace(/^ARM CHECK: /, "")}`),
      armed
        ? "ARM CHECK: armed — the repair driver and the cycle it spawns both tell their own outcomes apart, and only a gate-authorised patch with a rollback point reads as applied"
        : `ARM CHECK: BLIND — the repair driver cannot be trusted to report what happened to a patch (${wrong.join("; ")}). It will NOT be wired.`,
    ],
  };
}

/**
 * `defectSignatureOf` — the ticket's `last_defect_id`, read off the real record.
 *
 * STRUCTURED, NEVER PROSE. It reads the `signature` field `defect-record.ts`
 * wrote and returns null for every other outcome (no file, bad JSON, no field),
 * because the per-signature repair bound must count a signature or nothing —
 * a fabricated key would give every failure its own fresh budget.
 */
export function createDefectSignatureReader(runsDir: string): (runId: string) => string | null {
  return (runId: string): string | null => {
    const path = join(runsDir, runId, "results", "defect.json");
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const bag = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const signature = bag["signature"];
      return typeof signature === "string" && /^[a-f0-9]{8,128}$/i.test(signature) ? signature : null;
    } catch {
      return null;
    }
  };
}

export function createSupervisorSubmit(deps: SubmitDeps): (spec: SupervisorSubmission) => Promise<{ readonly runId: string }> {
  return async (spec: SupervisorSubmission): Promise<{ readonly runId: string }> => {
    const entry = await deps.catalog.resolve(spec.modelId);
    if (entry === null) {
      // THROWN, NOT LOGGED. The loop's catch returns the ticket to the queue and
      // records the sentence on the ticket, where the strip can read it; a
      // submission that swallowed an unknown model would spin silently.
      throw new Error(`${spec.modelId} is not in the catalog, so this ticket cannot be submitted — GET /api/models lists the ids that can run`);
    }
    if (!entry.option.available) {
      throw new Error(`${spec.modelId} is not available: ${entry.option.reason ?? "no reason recorded"}`);
    }

    const ticket = ticketWithReferences({ prose: spec.ticketText, images: [], documents: [], capture: null, motion: null });
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

    deps.store.createRun({
      runId,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketText: ticket.brief,
      ticketSha256: ticket.sha256,
      modelId: spec.modelId,
      provider: entry.option.provider,
      deploy: spec.deploy,
      startedAt: new Date().toISOString(),
      queuePosition: deps.store.listQueued().length + 1,
      // THE TWO NEVER-PARK FIELDS, PERSISTED. `assertNeverParks` has already
      // refused any other combination on the loop's side; these are the columns
      // `designLockPolicy` reads at the top of every build segment, and an
      // unattended run that parks on a design choice is the failure the whole
      // supervisor exists to avoid.
      designLock: spec.designLock,
      interactive: spec.interactive,
    });
    deps.bus.emit(runId, { type: "status", status: "queued" });
    deps.bus.emit(runId, { type: "phase", phase: "spec" });
    deps.orchestrator.pump();
    return { runId };
  };
}
