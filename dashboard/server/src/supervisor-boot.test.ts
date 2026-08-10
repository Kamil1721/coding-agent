/**
 * THE WIRING, TESTED IN BOTH DIRECTIONS — including the direction that says
 * `index.ts` actually calls it.
 *
 * THE DEFECT THIS FILE EXISTS FOR IS "NOTHING BUILT THIS ROUND HAS A CALLER".
 * The loop, the arm check and the health discriminator were all real, all
 * mutation-proved, and all constructed by nobody: `grep -in supervisor
 * dashboard/server/src/index.ts` returned 0 hits. A behaviour with no caller is
 * byte-identical to no behaviour at 3am, so the last test in this file reads
 * `index.ts`'s SOURCE and asserts the call is inside `main()`.
 *
 * WHAT THAT SOURCE TEST DOES AND DOES NOT PROVE, stated so it is not over-read:
 * it proves the call exists in the boot path, which is exactly the defect that
 * was found. It does NOT prove the process boots — that needs a bound port and
 * the owner's database, which the build phase may not do. The Verify phase owns
 * that half.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SUPERVISOR_TICK_MS,
  armRepairDriver,
  createCycleRunner,
  createDefectSignatureReader,
  createRepairDriver,
  createSupervisorSubmit,
  startSupervisor,
} from "./supervisor-boot.js";
import type { ArmableLoop, BootTimer, DesiredStateStore, RepairDriverDeps } from "./supervisor-boot.js";
import type { NewRun, RunRow, SupervisorDesired, SupervisorState } from "./db.js";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

function stateStore(desired: SupervisorDesired): DesiredStateStore & {
  readonly writes: { desired: SupervisorDesired; changedBy: string; reason: string }[];
} {
  const writes: { desired: SupervisorDesired; changedBy: string; reason: string }[] = [];
  let current = desired;
  return {
    writes,
    readSupervisorState: (): SupervisorState => ({
      desired: current,
      changedAt: "2026-08-10T03:00:00.000Z",
      changedBy: "owner",
      reason: "the owner pressed start",
    }),
    setSupervisorState: (next, changedBy, reason): SupervisorState => {
      current = next;
      writes.push({ desired: next, changedBy, reason });
      return { desired: next, changedAt: "2026-08-10T03:00:01.000Z", changedBy, reason };
    },
  };
}

function fakeLoop(armed: boolean, onTick?: () => unknown): ArmableLoop & { ticks: number } {
  const loop = {
    ticks: 0,
    armCheck: () => ({
      armed,
      lines: [armed ? "ARM CHECK: supervisor produced 3 distinct verdicts" : "ARM CHECK: supervisor is BLIND"],
    }),
    tick: (): unknown => {
      loop.ticks += 1;
      return onTick?.();
    },
  };
  return loop;
}

function fakeTimer(): BootTimer & { readonly installed: { fn: () => void; ms: number }[]; cleared: number; unrefs: number } {
  const installed: { fn: () => void; ms: number }[] = [];
  const box = {
    installed,
    cleared: 0,
    unrefs: 0,
    set: (fn: () => void, ms: number) => {
      installed.push({ fn, ms });
      return { unref: () => { box.unrefs += 1; } };
    },
    clear: () => { box.cleared += 1; },
  };
  return box;
}

/* ------------------------------------------------------------------ */
/* THE ARM GATE — the rule-4 requirement, both ways                    */
/* ------------------------------------------------------------------ */

void test("an ARMED loop gets a 30s interval, an unref, and one boot tick", () => {
  const store = stateStore("running");
  const loop = fakeLoop(true);
  const timer = fakeTimer();
  const lines: string[] = [];

  const started = startSupervisor({ loop, store, timer, log: (l) => lines.push(l) });

  assert.equal(started.armed, true);
  assert.equal(started.ticking, true);
  assert.equal(timer.installed.length, 1);
  assert.equal(timer.installed[0]?.ms, SUPERVISOR_TICK_MS);
  assert.equal(SUPERVISOR_TICK_MS, 30_000);
  assert.equal(timer.unrefs, 1, "an interval that is not unref'd stops the process exiting on Ctrl-C");
  assert.equal(loop.ticks, 1, "the boot tick is what recovers an orphaned claim left by kill -9");
  // The interval really is the loop's tick and not a no-op closure.
  timer.installed[0]?.fn();
  assert.equal(loop.ticks, 2);
  // An armed boot does not rewrite the owner's desired state.
  assert.deepEqual(store.writes, []);

  started.stop();
  assert.equal(timer.cleared, 1);
  started.stop();
  assert.equal(timer.cleared, 1, "stop() is idempotent: shutdown may run twice");
});

void test("a BLIND loop is NOT started, is forced to stopped, and says so loudly", () => {
  const store = stateStore("running");
  const loop = fakeLoop(false);
  const timer = fakeTimer();
  const lines: string[] = [];

  const started = startSupervisor({ loop, store, timer, log: (l) => lines.push(l) });

  assert.equal(started.armed, false);
  assert.equal(started.ticking, false);
  assert.equal(timer.installed.length, 0, "a blind supervisor that keeps ticking spends quota on decisions it cannot make");
  assert.equal(loop.ticks, 0, "not even the boot tick: nothing may act before blindness is ruled out");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]?.desired, "stopped");
  assert.equal(store.writes[0]?.changedBy, "boot");
  assert.match(store.writes[0]?.reason ?? "", /BLIND/);
  assert.equal(store.readSupervisorState().desired, "stopped", "the refusal is durable, not only on stdout");
  assert.ok(
    lines.some((l) => l.includes("ARM CHECK FAILED") && l.includes("desired was 'running'")),
    `the refusal must name what it overrode; got ${JSON.stringify(lines)}`,
  );
  // NEGATIVE HALF: the arm lines themselves are printed either way, so a reader
  // cannot tell armed from blind by their absence.
  assert.ok(lines.some((l) => l.includes("BLIND")));
});

void test("a tick that throws — sync or async — is absorbed, and the interval survives it", () => {
  const store = stateStore("running");
  const lines: string[] = [];
  const sync = fakeLoop(true, () => { throw new Error("the store is locked"); });
  const timerA = fakeTimer();
  startSupervisor({ loop: sync, store, timer: timerA, log: (l) => lines.push(l) });
  assert.equal(sync.ticks, 1);
  timerA.installed[0]?.fn();
  assert.equal(sync.ticks, 2, "a throwing tick must not stop the next one");
  assert.ok(lines.some((l) => l.includes("absorbed") && l.includes("the store is locked")));

  const async_ = fakeLoop(true, () => Promise.reject(new Error("submit exploded")));
  const timerB = fakeTimer();
  startSupervisor({ loop: async_, store, timer: timerB, log: (l) => lines.push(l) });
  // An unhandled rejection from a 30s interval kills the process under Node's
  // default policy, taking the dashboard with it. Absorbed, and named.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.ok(
        lines.some((l) => l.includes("absorbed") && l.includes("submit exploded")),
        `the async rejection was not absorbed; got ${JSON.stringify(lines)}`,
      );
      resolve();
    }, 10);
  });
});

/* ------------------------------------------------------------------ */
/* THE SUBMISSION                                                      */
/* ------------------------------------------------------------------ */

function submitFakes(available = true) {
  const created: NewRun[] = [];
  const emitted: unknown[] = [];
  let pumps = 0;
  const deps = {
    store: {
      createRun: (run: NewRun): RunRow => {
        created.push(run);
        return { runId: run.runId } as unknown as RunRow;
      },
      listQueued: (): readonly RunRow[] => [],
    },
    bus: { emit: (runId: string, event: unknown) => { emitted.push({ runId, event }); } },
    catalog: {
      resolve: (modelId: string) =>
        Promise.resolve(
          modelId === "claude-sonnet-4-6"
            ? { option: { provider: "anthropic" as const, available, reason: available ? null : "the CLI is not authenticated" } }
            : null,
        ),
    },
    orchestrator: { pump: () => { pumps += 1; } },
  };
  return { deps, created, emitted, pumps: () => pumps };
}

const SPEC = {
  ticketText: "build a portfolio site with a dark hero",
  modelId: "claude-sonnet-4-6",
  designLock: "auto" as const,
  interactive: false as const,
  deploy: false as const,
};

void test("a submission creates a run whose ticket id is a function of the BRIEF ALONE — so a retry reuses the frozen suite", async () => {
  const a = submitFakes();
  const first = await createSupervisorSubmit(a.deps)(SPEC);
  const b = submitFakes();
  const second = await createSupervisorSubmit(b.deps)(SPEC);

  assert.notEqual(first.runId, second.runId, "two submissions are two runs");
  assert.equal(
    a.created[0]?.ticketId,
    b.created[0]?.ticketId,
    "the SAME brief must mint the SAME ticket id, or attempt 2 finds no frozen suite and pays for a second spec phase",
  );
  assert.equal(a.created[0]?.ticketSha256, b.created[0]?.ticketSha256);
  // NEGATIVE HALF: a DIFFERENT brief is a different ticket. Without this, an id
  // that was a constant would pass the assertion above.
  const c = submitFakes();
  await createSupervisorSubmit(c.deps)({ ...SPEC, ticketText: "build a recipe app" });
  assert.notEqual(a.created[0]?.ticketId, c.created[0]?.ticketId);

  // The never-park columns are persisted, not defaulted.
  assert.equal(a.created[0]?.designLock, "auto");
  assert.equal(a.created[0]?.interactive, false);
  assert.equal(a.created[0]?.provider, "anthropic");
  assert.equal(a.pumps(), 1, "a run nobody pumps sits queued forever");
  assert.deepEqual(a.emitted, [
    { runId: first.runId, event: { type: "status", status: "queued" } },
    { runId: first.runId, event: { type: "phase", phase: "spec" } },
  ]);
});

void test("an unknown or unavailable model THROWS — the loop's catch is the only thing allowed to decide what that costs", async () => {
  const unknown = submitFakes();
  await assert.rejects(
    createSupervisorSubmit(unknown.deps)({ ...SPEC, modelId: "gpt-9" }),
    /not in the catalog/,
  );
  assert.deepEqual(unknown.created, [], "nothing is written for a model that cannot run");

  const unavailable = submitFakes(false);
  await assert.rejects(
    createSupervisorSubmit(unavailable.deps)(SPEC),
    /not available: the CLI is not authenticated/,
  );
  assert.deepEqual(unavailable.created, []);

  // NEGATIVE HALF: the same fakes with a known, available model do create a run,
  // so the rejections above are about the model and not about the fakes.
  const ok = submitFakes();
  await createSupervisorSubmit(ok.deps)(SPEC);
  assert.equal(ok.created.length, 1);
});

/* ------------------------------------------------------------------ */
/* THE CALLER — the defect itself                                      */
/* ------------------------------------------------------------------ */

void test("index.ts CONSTRUCTS the loop and calls startSupervisor INSIDE main(), and clears it on shutdown", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Read the SOURCE, not the build output: the defect was a missing call, and a
  // stale `dist` would hide either direction of that.
  const src = readFileSync(join(here.replace(/\/dist[^/]*$/, "/src"), "index.ts"), "utf8");

  const mainAt = src.indexOf("export async function main(");
  assert.ok(mainAt > -1, "main() was renamed; this test is now measuring nothing");
  const mainBody = src.slice(mainAt);

  assert.match(mainBody, /new SupervisorLoop\(/, "the loop is constructed by nobody, so nothing claims a ticket");
  assert.match(mainBody, /startSupervisor\(/, "startSupervisor is never called, so there is no interval and no arm gate");
  assert.match(mainBody, /createSupervisorSubmit\(/, "the loop has no submit, so a claim can never become a run");
  assert.match(mainBody, /supervisor:\s*\w+/, "HttpDeps.supervisor is never passed, so every POST /api/supervisor answers 503");
  assert.match(mainBody, /onRunSettled/, "without the settle hook a finished run waits up to 30s to be noticed");
  assert.match(mainBody, /\.stop\(\)/, "the interval is never cleared, so shutdown leaves a tick behind");

  /*
   * ─── THE ROUND'S OWN DEFECT, ASSERTED IN THE ONE PLACE IT LIVED ─────────────
   *
   * MEASURED 2026-08-10 from this process's boot line: "NO REPAIR DRIVER is wired.
   * Every ticket that reaches 'repairing' terminates at 'blocked' with
   * NO_REPAIR_DRIVER." The construction site passed `store`, `submit` and `resume`
   * and no `repair`, so `tools/repair` (16 files) and `tools/tier3` (9 files) —
   * green, arm-checked, mutation-proved — were invoked by no process at all.
   *
   * All four names below are load-bearing and each has its own failure:
   *   `armRepairDriver`      unmeasured driver: the boot line claims health it
   *                          has not observed.
   *   `createRepairDriver`   no driver: `repairing` terminates at `blocked`.
   *   `repairArm`            the loop cannot tell "no driver" from "a blind
   *                          driver we refused to wire".
   *   `createDefectSignatureReader`  `lastDefectId` stays null, so the
   *                          per-signature budget keys on the failure CLASS, the
   *                          `<signature>.diff` lookup can never hit, and the
   *                          ruled-out ledger cannot be addressed.
   */
  assert.match(mainBody, /armRepairDriver\(/, "the repair driver is wired without being measured, so the boot line would claim health it has not observed");
  assert.match(mainBody, /createRepairDriver\(/, "no repair driver is constructed, so every 'repairing' ticket terminates at 'blocked' with NO_REPAIR_DRIVER");
  assert.match(mainBody, /repairArm/, "the loop is not told what the arm check measured, so it cannot distinguish 'no driver' from 'a blind driver we refused to wire'");
  assert.match(mainBody, /createDefectSignatureReader\(/, "no defect signature reader is wired, so lastDefectId stays null and the per-signature repair bound counts the failure class instead");

  /*
   * AND THE ARM CHECK MUST GATE THE WIRING, NOT MERELY PRECEDE IT. A `main()` that
   * called `armRepairDriver` and then passed the driver regardless would satisfy
   * every assertion above while wiring a driver known to be blind.
   */
  const wiring = mainBody.slice(mainBody.indexOf("new SupervisorLoop("), mainBody.indexOf("supervisorHolder.loop ="));
  assert.match(
    wiring,
    /repairArm\.armed\s*\?/,
    "the driver is passed unconditionally: a blind driver would be wired anyway and the arm check would be decoration",
  );

  // NEGATIVE HALF: the assertions above are on `main()`'s body, not on the whole
  // file, so a call sitting in a comment at the top or in dead code below the
  // entrypoint guard cannot satisfy them.
  const preamble = src.slice(0, mainAt);
  assert.doesNotMatch(preamble, /startSupervisor\(/, "the call must be in main(), not above it");
  assert.doesNotMatch(preamble, /armRepairDriver\(/, "the arm check must be called in main(), not above it");
});

/* ---------------------------------------------------------------------------
 * THE REPAIR DRIVER — the call that crosses out of the TypeScript build
 *
 * `supervisor.ts` proves the routing and the bounds against an injected `repair`.
 * These tests prove the thing that actually gets injected: that a cycle's answer
 * is read structurally (never by matching its prose), that every way the spawn can
 * fail is a NAMED non-verdict rather than an exception mid-tick, and that an
 * unrecognised verdict is never read as "a patch was applied".
 * ------------------------------------------------------------------------ */

function driverDeps(
  run: (args: readonly string[]) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean },
): RepairDriverDeps {
  return {
    cyclePath: "/repo/tools/repair/supervisor-cycle.mjs",
    runsDir: "/repo/dashboard/runs",
    ledgerDir: "/repo/dashboard/data/defects/ruled-out",
    proposalsDir: "/repo/dashboard/data/repair-proposals",
    rollbackDir: "/repo/dashboard/data/repair-rollback",
    run,
    log: () => {},
  };
}

const REPAIR_REQUEST = {
  ticketKey: "k1",
  signature: "a".repeat(64),
  runId: "run-1",
  failureClass: "structural",
  cycleNo: 1,
  maxCycles: 2,
  deadlineAt: "2026-08-10T01:00:00.000Z",
};

test("the driver reads the cycle's verdict structurally, and hands the loop the run's own defect path", async () => {
  const seen: string[][] = [];
  const driver = createRepairDriver(
    driverDeps((args) => {
      seen.push([...args]);
      return { ok: true, stdout: `${JSON.stringify({ kind: "refused", code: "ALREADY_RULED_OUT", detail: "seen before" })}\n`, stderr: "" };
    }),
  );

  const outcome = await driver(REPAIR_REQUEST);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.code, "ALREADY_RULED_OUT");
  // The defect record of THIS run, not a global one: a repair attributed to the
  // wrong run's evidence is worse than no repair.
  assert.deepEqual(seen, [
    [
      "/repo/tools/repair/supervisor-cycle.mjs",
      "--defect",
      "/repo/dashboard/runs/run-1/results/defect.json",
      "--ledger",
      "/repo/dashboard/data/defects/ruled-out",
      "--proposals",
      "/repo/dashboard/data/repair-proposals",
      "--rollback",
      "/repo/dashboard/data/repair-rollback",
      // THE TICKET'S OWN DEADLINE, so the cycle refuses to spend a gate run inside
      // a window the supervisor has already closed. One instant, two enforcers.
      "--deadline",
      REPAIR_REQUEST.deadlineAt,
    ],
  ]);
});

test("an applied verdict carries a patch id, and one without a fingerprint still says something", async () => {
  const withFingerprint = createRepairDriver(
    driverDeps(() => ({
      ok: true,
      stdout: `${JSON.stringify({ kind: "applied", code: "ACCEPTED", detail: "one file", patchId: "abc123", rollbackPath: "/r/abc123.json" })}\n`,
      stderr: "",
    })),
  );
  const applied = await withFingerprint(REPAIR_REQUEST);
  assert.equal(applied.kind, "applied");
  assert.equal(applied.kind === "applied" ? applied.patchId : "", "abc123");
  // The sentence must say how to undo it. An owner reading `lastRepair` at 3am
  // needs the path, not the word "applied".
  assert.match(applied.detail, /\/r\/abc123\.json/);

  const anonymous = createRepairDriver(
    driverDeps(() => ({
      ok: true,
      stdout: `${JSON.stringify({ kind: "applied", code: "ACCEPTED", detail: "one file", rollbackPath: "/r/x.json" })}\n`,
      stderr: "",
    })),
  );
  const nameless = await anonymous(REPAIR_REQUEST);
  // `lastRepair` is specified as "blank is not legal". An empty patch id would
  // render as nothing at all on the strip, which reads as "no patch was applied"
  // about a ticket that was just patched.
  assert.notEqual(nameless.kind === "applied" ? nameless.patchId.trim() : "", "");
});

test("AN APPLIED PATCH WITH NO ROLLBACK POINT IS NOT READ AS APPLIED — the ticket is not re-queued onto a tree nobody can restore", async () => {
  const unrevertible = createRepairDriver(
    driverDeps(() => ({
      ok: true,
      stdout: `${JSON.stringify({ kind: "applied", code: "GATE_APPLY", detail: "one file, gate-authorised", patchId: "deadbeef" })}\n`,
      stderr: "",
    })),
  );
  const outcome = await unrevertible(REPAIR_REQUEST);
  /*
   * `inconclusive`, WHICH IS THE NON-OBVIOUS DIRECTION. The tree really was
   * patched, so `refused` would be a lie — but `applied` routes the ticket to
   * `queued` and spends a run on a tree that cannot be put back without a human,
   * which is precisely the state an unattended machine must never reach. So: the
   * ticket stops, and its sentence says the tree changed and cannot be undone.
   */
  assert.equal(outcome.kind, "inconclusive");
  assert.equal(outcome.code, "APPLIED_WITHOUT_ROLLBACK_POINT");
  assert.match(outcome.detail, /undo|revert|restore/i);

  // NEGATIVE HALF: the identical answer WITH a rollback path is applied, so this
  // arm is about the rollback point and not about refusing applied patches.
  const revertible = createRepairDriver(
    driverDeps(() => ({
      ok: true,
      stdout: `${JSON.stringify({ kind: "applied", code: "GATE_APPLY", detail: "one file, gate-authorised", patchId: "deadbeef", rollbackPath: "/r/deadbeef.json" })}\n`,
      stderr: "",
    })),
  );
  assert.equal((await revertible(REPAIR_REQUEST)).kind, "applied");
});

test("A CYCLE THAT HANGS IS KILLED AND NAMED — an awaited repair inside a tick must not be able to stop the queue", async () => {
  const hung = createRepairDriver(
    driverDeps(() => ({
      ok: false,
      // A KILLED CYCLE'S STDOUT IS WHATEVER IT FLUSHED, and that may be a
      // complete-looking JSON line from an earlier stage. The clock is therefore
      // read BEFORE the output: a timed-out cycle has no verdict by definition.
      stdout: `${JSON.stringify({ kind: "applied", code: "GATE_APPLY", detail: "flushed before the kill", patchId: "x", rollbackPath: "/r/x.json" })}\n`,
      stderr: "",
      timedOut: true,
    })),
  );
  const outcome = await hung(REPAIR_REQUEST);
  assert.equal(outcome.code, "REPAIR_CYCLE_TIMED_OUT");
  assert.notEqual(outcome.kind, "applied", "a killed cycle's flushed stdout was read as an applied patch");

  // AND THE REAL RUNNER REALLY KILLS. Everything above drives a fake `run`, which
  // proves the reader and proves nothing about the clock. This spawns a node
  // process that sleeps far longer than its budget and requires the runner to
  // report `timedOut` rather than blocking until the process feels like exiting.
  const started = Date.now();
  const killed = createCycleRunner(300)(["-e", "setTimeout(() => {}, 60000)"]);
  assert.equal(killed.timedOut, true, `the runner did not report a timeout after ${String(Date.now() - started)}ms`);
  assert.ok(Date.now() - started < 20_000, "the runner waited for a process it was supposed to kill");

  // NEGATIVE HALF: a process that finishes inside its budget is NOT reported as
  // timed out, so this is a clock and not a component that kills everything.
  const quick = createCycleRunner(20_000)(["-e", "process.stdout.write('{}')"]);
  assert.equal(quick.timedOut, undefined);
  assert.equal(quick.ok, true);
  assert.equal(quick.stdout, "{}");
});

test("THE DRIVER'S OWN ARM CHECK DRIVES THE DRIVER, and reports BLIND when the cycle it spawns is blind", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const cyclePath = join(repoRoot, "tools", "repair", "supervisor-cycle.mjs");

  /*
   * THE REAL SPAWN, because the second half of this arm check is the `.mjs` decider
   * and a fake `run` would make that half measure nothing. `--armcheck` writes only
   * to a throwaway directory, which is what makes it safe at start-up.
   */
  const arm = await armRepairDriver({
    cyclePath,
    runsDir: "/nonexistent/runs",
    ledgerDir: "/nonexistent/ledger",
    proposalsDir: "/nonexistent/proposals",
    rollbackDir: "/nonexistent/rollback",
    run: createCycleRunner(120_000),
    log: () => {},
  });
  assert.equal(arm.armed, true, arm.wrong.join("; "));
  assert.equal(arm.probes, 8);
  // The decider's lines travel with the driver's, so one boot block reports both.
  assert.ok(arm.lines.some((l) => /\(cycle\)/.test(l)), "the driver's arm check says nothing about the cycle it spawns");
  assert.ok(arm.lines.some((l) => /gate-verdict router/.test(l)), "the driver's arm check says nothing about the gate seam");
  assert.match(arm.lines[arm.lines.length - 1] ?? "", /^ARM CHECK: armed/);

  /*
   * AND IT CAN REPORT BLIND, WHICH IS THE ONLY THING THAT MAKES IT AN ARM CHECK.
   * The decider is replaced with one that exits non-zero — the shape of a cycle
   * whose own arm check collapsed — and the driver must refuse to be wired.
   */
  const blind = await armRepairDriver({
    cyclePath: join(repoRoot, "tools", "repair", "supervisor-cycle.mjs"),
    runsDir: "/nonexistent/runs",
    ledgerDir: "/nonexistent/ledger",
    proposalsDir: "/nonexistent/proposals",
    rollbackDir: "/nonexistent/rollback",
    run: (args) =>
      args.includes("--armcheck")
        ? { ok: false, stdout: "ARM CHECK: BLIND — two arms collapsed into one code\n", stderr: "" }
        : createCycleRunner(120_000)(args),
    log: () => {},
  });
  assert.equal(blind.armed, false);
  assert.match(blind.lines[blind.lines.length - 1] ?? "", /^ARM CHECK: BLIND/);
  assert.match(blind.lines[blind.lines.length - 1] ?? "", /will NOT be wired/);
  assert.ok(blind.wrong.some((w) => /armcheck/.test(w)), `the blind reason does not name the cycle: ${blind.wrong.join("; ")}`);
});

/* ---------------------------------------------------------------------------
 * THE BOOT ARM READS THE DECIDER'S TEXT, NOT ONLY ITS EXIT CODE.
 *
 * THE DEFECT, MEASURED 2026-08-10: the whole verification of the spawned decider
 * was `if (!decider.ok)`, and every line it printed was echoed onto the boot block
 * as `ARM CHECK: (cycle) <line>` regardless of content. A runner that exits 0
 * while printing anything at all therefore produced `armed=true, wrong=[]` and a
 * boot block that LOOKED healthy while quoting text of unknown meaning — a boot
 * line reporting a component it cannot see, which hard rule 4 calls worse than the
 * honest absence it replaced.
 *
 * Each case below is a separate way the decider's output can be untrustworthy, and
 * every one of them must reach BLIND. The last case is the negative control: a
 * decider whose text IS an arm-check report, agreeing with its exit code, is
 * armed — so this is a reader and not a component that refuses everything.
 * ------------------------------------------------------------------------- */
test("a decider that exits 0 while printing something that is not an arm-check report makes the boot arm BLIND", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const cyclePath = join(repoRoot, "tools", "repair", "supervisor-cycle.mjs");
  const seam = "ARM CHECK: gate-verdict router returns 8 distinct code(s) and 8 distinct sentence(s) on 8 known gate records, exactly 1 of them APPLY; 0 misread";
  const armedLine = "ARM CHECK: armed — every outcome is named, only a gate-authorised patch reads as applied";

  const withDecider = (answer: { ok: boolean; stdout: string }): Promise<Awaited<ReturnType<typeof armRepairDriver>>> =>
    armRepairDriver({
      cyclePath,
      runsDir: "/nonexistent/runs",
      ledgerDir: "/nonexistent/ledger",
      proposalsDir: "/nonexistent/proposals",
      rollbackDir: "/nonexistent/rollback",
      run: (args) => (args.includes("--armcheck") ? { ...answer, stderr: "" } : createCycleRunner(120_000)(args)),
      log: () => {},
    });

  // 1. EXIT 0 AND ARBITRARY TEXT. The shape the old code reported as healthy.
  const mute = await withDecider({ ok: true, stdout: "hello from an unrelated script\nall good\n" });
  assert.equal(mute.armed, false, "a decider that exited 0 while printing prose was reported as armed");
  assert.match(mute.lines[mute.lines.length - 1] ?? "", /^ARM CHECK: BLIND/);
  assert.ok(
    mute.wrong.some((w) => /printed no arm-check verdict line/.test(w)),
    `the reason does not name the missing verdict line: ${mute.wrong.join("; ")}`,
  );

  // 2. EXIT 0 AND NOTHING AT ALL. Silence is not agreement.
  const silent = await withDecider({ ok: true, stdout: "" });
  assert.equal(silent.armed, false, "a decider that exited 0 and printed nothing was reported as armed");
  assert.ok(silent.wrong.some((w) => /printed nothing/.test(w)), silent.wrong.join("; "));

  // 3. THE EXIT CODE AND THE PRINTED VERDICT DISAGREE. One of them is not
  // measuring the cycle, and there is no way to tell which, so neither is believed.
  const disagree = await withDecider({ ok: true, stdout: `${seam}\nARM CHECK: BLIND — two arms collapsed into one code\n` });
  assert.equal(disagree.armed, false, "a decider printing BLIND while exiting 0 was reported as armed");
  assert.ok(disagree.wrong.some((w) => /disagree/.test(w)), disagree.wrong.join("; "));

  // 4. THE VERDICT LINE IS NOT LAST, so the boot block's final line — the one the
  // owner reads — is not the cycle's verdict.
  const trailing = await withDecider({ ok: true, stdout: `${seam}\n${armedLine}\nnode: warning about something else\n` });
  assert.equal(trailing.armed, false, "a decider that kept talking after its verdict was reported as armed");
  assert.ok(trailing.wrong.some((w) => /kept talking/.test(w)), trailing.wrong.join("; "));

  // 5. THE GATE SEAM IS NOT IN THE TEXT. `armRepairDriver`'s docblock claims the
  // decider drives the gate's verdict records; a cycle that stopped printing that
  // half would leave the claim standing over output that no longer contains it.
  const noSeam = await withDecider({ ok: true, stdout: `${armedLine}\n` });
  assert.equal(noSeam.armed, false, "a decider that said nothing about the gate seam was reported as armed");
  assert.ok(noSeam.wrong.some((w) => /gate-verdict seam/.test(w)), noSeam.wrong.join("; "));

  // 6. NEGATIVE CONTROL. An arm-check report that agrees with its exit code and
  // covers both halves IS armed — otherwise every case above is satisfied by a
  // function that always says BLIND.
  const healthy = await withDecider({ ok: true, stdout: `${seam}\n${armedLine}\n` });
  assert.equal(healthy.armed, true, healthy.wrong.join("; "));
  assert.match(healthy.lines[healthy.lines.length - 1] ?? "", /^ARM CHECK: armed/);
});

test("a cyclePath that is not there is 'nobody installed one', not 'we refused a blind one'", async () => {
  let spawned = 0;
  const missing = join(mkdtempSync(join(tmpdir(), "supervisor-boot-nocycle-")), "tools", "repair", "supervisor-cycle.mjs");
  const arm = await armRepairDriver({
    cyclePath: missing,
    runsDir: "/nonexistent/runs",
    ledgerDir: "/nonexistent/ledger",
    proposalsDir: "/nonexistent/proposals",
    rollbackDir: "/nonexistent/rollback",
    run: (args) => {
      if (args.includes("--armcheck")) spawned += 1;
      return { ok: true, stdout: "", stderr: "" };
    },
    log: () => {},
  });
  assert.equal(arm.armed, false);
  // THE TWO STATES MUST NOT COLLAPSE. `DASHBOARD_HOME` pointing outside the
  // repository makes the script absent, and the boot line must not then describe a
  // driver that "could not be shown to tell its own outcomes apart" — that is the
  // "nobody wired one" fact wearing the "we refused a bad driver" sentence.
  assert.ok(arm.wrong.some((w) => w.includes(missing)), `the reason does not name the path: ${arm.wrong.join("; ")}`);
  assert.ok(arm.wrong.some((w) => /nobody installed one/.test(w)), arm.wrong.join("; "));
  assert.equal(spawned, 0, "the arm spawned a script it had already found to be absent");
});

test("a SPAWN that throws is an unarmed driver, not a dashboard that never binds", async () => {
  /*
   * `armRepairDriver` is awaited ABOVE `server.listen`. A throw used to reject out
   * of `main()`, so a wedged environment meant a dead port instead of the named
   * failure the 30 s clock exists to produce.
   *
   * IT IS THE SPAWN, NOT THE PROBE LOOP, AND THE DISTINCTION WAS MEASURED. A catch
   * was first written around the eight probes too; removing it left this test green
   * (MUTATION SURVIVED, watched 2026-08-10), because the probe loop overrides `run`
   * with its own fixed answers and therefore cannot reach an injected runner at
   * all. The guard was deleted rather than kept as decoration; the spawn below is
   * the only seam an injected throw can reach, and this test is what proves it.
   */
  const arm = await armRepairDriver({
    cyclePath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "repair", "supervisor-cycle.mjs"),
    runsDir: "/nonexistent/runs",
    ledgerDir: "/nonexistent/ledger",
    proposalsDir: "/nonexistent/proposals",
    rollbackDir: "/nonexistent/rollback",
    run: () => { throw new Error("spawn EAGAIN"); },
    log: () => {},
  });
  assert.equal(arm.armed, false);
  assert.ok(arm.wrong.length > 0, "a throwing runner produced no reason at all");
  assert.match(arm.lines[arm.lines.length - 1] ?? "", /^ARM CHECK: BLIND/);
  assert.ok(
    arm.wrong.some((w) => /EAGAIN/.test(w)),
    `the reason does not carry what actually went wrong: ${arm.wrong.join("; ")}`,
  );
});

test("every way the cycle can fail is a NAMED non-verdict, and none of them is an applied patch", async () => {
  const cases: readonly { readonly label: string; readonly stdout: string; readonly ok: boolean; readonly code: string }[] = [
    { label: "silent", stdout: "", ok: false, code: "REPAIR_CYCLE_SILENT" },
    { label: "not json", stdout: "Error: cannot find module\n", ok: false, code: "REPAIR_CYCLE_UNREADABLE" },
    {
      label: "a verdict word this build does not know",
      stdout: `${JSON.stringify({ kind: "escalated", code: "TIER_3", detail: "to the gate" })}\n`,
      ok: true,
      code: "UNKNOWN_VERDICT_escalated",
    },
  ];
  const codes = new Set<string>();
  for (const c of cases) {
    const driver = createRepairDriver(driverDeps(() => ({ ok: c.ok, stdout: c.stdout, stderr: "boom" })));
    const outcome = await driver(REPAIR_REQUEST);
    assert.equal(outcome.code, c.code, c.label);
    // THE CONSERVATIVE DIRECTION IS THE WHOLE POINT: reading an unknown verdict as
    // `applied` would re-queue the ticket onto an UNPATCHED tree and spend a run
    // proving it.
    assert.notEqual(outcome.kind, "applied", `${c.label} was read as an applied patch`);
    assert.notEqual(outcome.detail.trim(), "", `${c.label} answered with a blank sentence`);
    codes.add(outcome.code);
  }
  assert.equal(codes.size, cases.length, "two failure modes share a code, so the ticket cannot say which happened");

  // NEGATIVE CONTROL: a well-formed answer through the same driver is NOT turned
  // into a fault, so this is a reader and not a component that refuses everything.
  const healthy = createRepairDriver(
    driverDeps(() => ({ ok: true, stdout: `${JSON.stringify({ kind: "inconclusive", code: "NO_PATCH_AUTHOR", detail: "no diff" })}\n`, stderr: "" })),
  );
  assert.equal((await healthy(REPAIR_REQUEST)).code, "NO_PATCH_AUTHOR");
});

test("a repairing ticket that names no run gets a sentence, not a spawn", async () => {
  let spawned = 0;
  const driver = createRepairDriver(driverDeps(() => { spawned += 1; return { ok: true, stdout: "{}", stderr: "" }; }));
  const outcome = await driver({ ...REPAIR_REQUEST, runId: null });
  assert.equal(outcome.code, "NO_RUN_TO_REPAIR");
  assert.equal(spawned, 0);
});

test("the defect signature is read off the real record, and anything else reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-boot-defect-"));
  try {
    const read = createDefectSignatureReader(dir);
    const write = (runId: string, body: string): void => {
      mkdirSync(join(dir, runId, "results"), { recursive: true });
      writeFileSync(join(dir, runId, "results", "defect.json"), body, "utf8");
    };
    write("good", JSON.stringify({ signature: "c".repeat(64), phase: "spec" }));
    assert.equal(read("good"), "c".repeat(64));

    // EVERY OTHER SHAPE IS NULL, because the per-signature repair bound must count
    // a real digest or nothing: a fabricated key hands each failure a fresh budget,
    // and a non-hex one makes the ledger throw mid-tick.
    write("bad-json", "{ this is not json");
    write("no-field", JSON.stringify({ phase: "spec" }));
    write("not-hex", JSON.stringify({ signature: "spec/failed/suite_not_audited" }));
    assert.equal(read("bad-json"), null);
    assert.equal(read("no-field"), null);
    assert.equal(read("not-hex"), null);
    assert.equal(read("no-such-run"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE REAL CYCLE, SPAWNED: the driver and tools/repair/supervisor-cycle.mjs agree on the wire format", async () => {
  /*
   * THE ONE TEST THAT CROSSES THE BOUNDARY FOR REAL. Everything above drives a
   * fake `run`, which proves the reader and proves nothing about the writer. The
   * two sides are in different languages and different package boundaries, and
   * "both lanes were green" is exactly how a contract drifts — so this spawns the
   * actual file the production driver would spawn and asserts the loop can act on
   * what comes back.
   */
  // `dist-<lane>/…` or `dist/…` or `src/…` — four levels up is the repo root in
  // all of them, and the `existsSync` below is what turns a wrong guess into a
  // named failure rather than a silently skipped test.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const cyclePath = join(repoRoot, "tools", "repair", "supervisor-cycle.mjs");
  assert.ok(existsSync(cyclePath), `the cycle this driver spawns does not exist at ${cyclePath}`);

  const dir = mkdtempSync(join(tmpdir(), "supervisor-boot-cycle-"));
  try {
    mkdirSync(join(dir, "runs", "run-1", "results"), { recursive: true });
    writeFileSync(
      join(dir, "runs", "run-1", "results", "defect.json"),
      JSON.stringify({ runId: "run-1", signature: "d".repeat(64), failureClass: "structural" }),
      "utf8",
    );
    const driver = createRepairDriver({
      cyclePath,
      runsDir: join(dir, "runs"),
      ledgerDir: join(dir, "ruled-out"),
      proposalsDir: join(dir, "proposals"),
      rollbackDir: join(dir, "rollback"),
      log: () => {},
      run: (args) => {
        const result = spawnSync(process.execPath, [...args], { encoding: "utf8" });
        return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    });

    // AN OPEN WINDOW, EXPLICITLY. `REPAIR_REQUEST`'s deadline is in the past, and
    // the real cycle honours it — which is itself the proof that `--deadline`
    // crosses the boundary, asserted below.
    const outcome = await driver({ ...REPAIR_REQUEST, deadlineAt: "2099-01-01T00:00:00.000Z" });
    // NO PATCH AUTHOR EXISTS, so this is the honest answer — and it is an
    // `inconclusive` OUTCOME the loop turns into `blocked` with the sentence,
    // rather than a ticket left in `repairing` for ever.
    assert.equal(outcome.kind, "inconclusive");
    assert.equal(outcome.code, "NO_PATCH_AUTHOR");
    assert.match(outcome.detail, /repair-proposals|\.diff/);
    // And the occurrence was recorded by the spawned process, not by this test.
    assert.ok(existsSync(join(dir, "ruled-out", `${"d".repeat(64)}.jsonl`)), "the cycle wrote no ledger row");

    /*
     * AND THE WALL CLOCK REALLY CROSSES THE BOUNDARY. The same driver, the same
     * defect record, the same everything except an instant in the past, answers
     * differently — so `--deadline` is a value the cycle acts on and not an
     * argument the driver appends and nobody reads. Measured the hard way: this
     * assertion was written the other way round first, and the real cycle answered
     * REPAIR_WINDOW_CLOSED for the `NO_PATCH_AUTHOR` case above.
     */
    const closed = await driver({ ...REPAIR_REQUEST, deadlineAt: "2026-08-10T01:00:00.000Z" });
    assert.equal(closed.code, "REPAIR_WINDOW_CLOSED");
    assert.notEqual(closed.code, outcome.code, "the cycle answers the same thing whether its window is open or closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
