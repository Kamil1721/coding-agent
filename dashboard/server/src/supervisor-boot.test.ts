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

  // NEGATIVE HALF: the assertions above are on `main()`'s body, not on the whole
  // file, so a call sitting in a comment at the top or in dead code below the
  // entrypoint guard cannot satisfy them.
  const preamble = src.slice(0, mainAt);
  assert.doesNotMatch(preamble, /startSupervisor\(/, "the call must be in main(), not above it");
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
  run: (args: readonly string[]) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string },
): RepairDriverDeps {
  return {
    cyclePath: "/repo/tools/repair/supervisor-cycle.mjs",
    runsDir: "/repo/dashboard/runs",
    ledgerDir: "/repo/dashboard/data/defects/ruled-out",
    proposalsDir: "/repo/dashboard/data/repair-proposals",
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
    ],
  ]);
});

test("an applied verdict carries a patch id, and one without a fingerprint still says something", async () => {
  const withFingerprint = createRepairDriver(
    driverDeps(() => ({
      ok: true,
      stdout: `${JSON.stringify({ kind: "applied", code: "ACCEPTED", detail: "one file", fingerprint: "abc123" })}\n`,
      stderr: "",
    })),
  );
  const applied = await withFingerprint(REPAIR_REQUEST);
  assert.equal(applied.kind, "applied");
  assert.equal(applied.kind === "applied" ? applied.patchId : "", "abc123");

  const anonymous = createRepairDriver(
    driverDeps(() => ({ ok: true, stdout: `${JSON.stringify({ kind: "applied", code: "ACCEPTED", detail: "one file" })}\n`, stderr: "" })),
  );
  const nameless = await anonymous(REPAIR_REQUEST);
  // `lastRepair` is specified as "blank is not legal". An empty patch id would
  // render as nothing at all on the strip, which reads as "no patch was applied"
  // about a ticket that was just patched.
  assert.notEqual(nameless.kind === "applied" ? nameless.patchId.trim() : "", "");
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
      log: () => {},
      run: (args) => {
        const result = spawnSync(process.execPath, [...args], { encoding: "utf8" });
        return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    });

    const outcome = await driver(REPAIR_REQUEST);
    // NO PATCH AUTHOR EXISTS, so this is the honest answer — and it is an
    // `inconclusive` OUTCOME the loop turns into `blocked` with the sentence,
    // rather than a ticket left in `repairing` for ever.
    assert.equal(outcome.kind, "inconclusive");
    assert.equal(outcome.code, "NO_PATCH_AUTHOR");
    assert.match(outcome.detail, /repair-proposals|\.diff/);
    // And the occurrence was recorded by the spawned process, not by this test.
    assert.ok(existsSync(join(dir, "ruled-out", `${"d".repeat(64)}.jsonl`)), "the cycle wrote no ledger row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
