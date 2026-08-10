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
   * Runs the cycle and returns its stdout. Injected so the test never spawns a
   * process it did not write, and so a spawn failure is a value rather than an
   * exception in the middle of a tick.
   */
  readonly run: (args: readonly string[]) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
  readonly log?: (line: string) => void;
}

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
    ];
    const result = deps.run(args);
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
      const fingerprint = typeof bag["fingerprint"] === "string" ? bag["fingerprint"] : null;
      return Promise.resolve({
        kind: "applied",
        code,
        detail,
        // A PATCH WITH NO ID IS NOT AN APPLIED PATCH. `lastRepair` on the strip is
        // specified as "blank is not legal", so a missing fingerprint gets a
        // visible placeholder rather than an empty string.
        patchId: fingerprint ?? "(the cycle applied a patch it did not fingerprint)",
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
