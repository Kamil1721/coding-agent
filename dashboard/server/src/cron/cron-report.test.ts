/**
 * cron-report.test.ts — the OVERDUE arm, and the null that must never read as a
 * pass.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ApiDesignLock, RunDetail } from "../api-types.js";
// THE CAPS THE WIRE ACTUALLY CARRIES, IMPORTED RATHER THAN TRANSCRIBED. This
// fixture hardcoded `turnsMax: 4` and stayed green while `MAX_DESIGN_LOCK_TURNS`
// moved to 8 and `http.ts` started sending it — a fixture describing a wire shape
// that no longer exists is a test that cannot see the drift it is standing in.
import { MAX_DESIGN_LOCK_TURNS, MAX_DESIGN_ON_DEMAND_RENDERS } from "../design-prompt.js";
import type { CronConfig } from "./cron-config.js";
import type { CronRow, JournalRead } from "./cron-journal.js";
import { CRON_DIRS, ensureCronDirs } from "./cron-queue.js";
import { CRON_REPORT_FILE, refreshCronReport, renderCronReport, runReport } from "./cron-report.js";
import type { TickResponse } from "./cron-tick.js";

const NOW = "2026-07-30T02:30:00.000Z";
const BASE_URL = "http://127.0.0.1:4176";

function config(over: Partial<CronConfig> = {}): CronConfig {
  return {
    root: "/cron",
    baseUrl: BASE_URL,
    modelId: "opus[1m]",
    deploy: false,
    maxRunsPerWindow: 4,
    windowHours: 24,
    leaseTtlMin: 15,
    expectEveryMin: 60,
    ...over,
  };
}

const outcome = (tickId: string, at: string, decision: CronRow["decision"], runId: string | null = null): CronRow => ({
  tickId,
  at,
  phase: "outcome",
  decision,
  reason: `${String(decision)} for the test`,
  ticketFile: null,
  runId,
  exitCode: 0,
  dashboardUrl: BASE_URL,
  modelId: "opus[1m]",
});

const intent = (tickId: string, at = "2026-07-30T02:00:00.000Z"): CronRow => ({
  ...outcome(tickId, at, null),
  phase: "intent",
});

const journalWith = (rows: readonly CronRow[]): JournalRead => ({ rows, unreadableLines: 0 });

function detail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    ticketTitle: "a portfolio",
    modelId: "opus[1m]",
    status: "failed",
    // Non-null does NOT mean failed, and null does not mean healthy — see
    // `RunDetail.failureReason`. The fixture states the absence explicitly so a
    // cron-report test never reads a stale reason from a previous shape.
    failureReason: null,
    startedAt: "2026-07-30T02:00:00.000Z",
    endedAt: "2026-07-30T02:20:00.000Z",
    heldOutPass: null,
    falseFinish: null,
    ticketText: "build me a portfolio",
    phase: "done",
    criteria: [],
    // `null`, not `[]`: this fixture asserts nothing about the twelve machine
    // gates, and `[]` would claim the gate ran and reported none of them.
    machineChecks: null,
    tokens: null,
    costUsd: null,
    rateLimit: null,
    screenshots: [],
    // A cron ticket is submitted from a file with no attachments, so both lists
    // are empty for every run this report has ever described.
    references: [],
    documents: [],
    artifactPath: null,
    previewUrl: null,
    inferredCriteria: 0,
    verdictPath: "",
    gateAttempts: 0,
    gateStopReason: null,
    designLock: null,
    // Never reached phase 5. `null` is "no pass record on this run" — NOT an
    // empty findings array, which would mean the pass ran and found nothing.
    adversary: null,
    // A cron ticket names no motion reference — and `toDetail` sends `null` for
    // every run today regardless, so this absence is the server's own.
    motion: null,
    // This fixture is `failed`, so it is not watched and nothing was published.
    silence: null,
    publishedProject: null,
    ...over,
  };
}

interface InputOver {
  readonly now?: string;
  readonly journal?: JournalRead;
  readonly expectEveryMin?: number;
  readonly maxRunsPerWindow?: number;
  readonly windowHours?: number;
  readonly queueDepth?: number;
  readonly stranded?: readonly string[];
  readonly failedCount?: number;
  readonly runIds?: readonly string[];
  readonly runs?: readonly RunDetail[];
}

const input = (over: InputOver = {}): Parameters<typeof renderCronReport>[0] => ({
  now: over.now ?? NOW,
  config: config({
    ...(over.expectEveryMin === undefined ? {} : { expectEveryMin: over.expectEveryMin }),
    ...(over.maxRunsPerWindow === undefined ? {} : { maxRunsPerWindow: over.maxRunsPerWindow }),
    ...(over.windowHours === undefined ? {} : { windowHours: over.windowHours }),
  }),
  journal: over.journal ?? journalWith([outcome("t1", "2026-07-30T02:00:00.000Z", "skipped")]),
  queueDepth: over.queueDepth ?? 0,
  stranded: over.stranded ?? [],
  failedCount: over.failedCount ?? 0,
  runIds: over.runIds ?? (over.runs ?? []).map((run) => run.runId),
  runs: over.runs ?? [],
});

test("OVERDUE: a schedule that stopped firing is the ONE failure nothing else can see", () => {
  // trap row 6. No tick can report this — a tick that runs is proof it ran. The
  // reader computes it, which is why `now` is an argument.
  const md = renderCronReport(
    input({
      now: "2026-07-30T09:00:00.000Z",
      journal: journalWith([outcome("t1", "2026-07-28T02:00:00.000Z", "skipped")]),
      expectEveryMin: 60,
    }),
  );
  assert.match(md, /OVERDUE/);
  assert.match(md, /2026-07-28T02:00/);
  assert.match(md, /schedule/i, "the remedy names the schedule, not the dashboard");
});

test("a tick that just ran is not overdue", () => {
  const md = renderCronReport(
    input({
      now: "2026-07-30T02:30:00.000Z",
      journal: journalWith([outcome("t1", "2026-07-30T02:00:00.000Z", "skipped")]),
      expectEveryMin: 60,
    }),
  );
  assert.doesNotMatch(md, /OVERDUE/);
});

test("ONE late tick is not OVERDUE and TWO missed intervals are — the threshold is measured", () => {
  // A detector that fires on the first tick to run a minute late is a detector
  // the owner learns to ignore, and then the real one is invisible too.
  const at = "2026-07-30T00:00:00.000Z";
  const late = renderCronReport(
    input({ now: "2026-07-30T01:30:00.000Z", journal: journalWith([outcome("t1", at, "skipped")]), expectEveryMin: 60 }),
  );
  assert.doesNotMatch(late, /OVERDUE/, "90 minutes on a 60-minute schedule is one late tick");
  const silent = renderCronReport(
    input({ now: "2026-07-30T02:01:00.000Z", journal: journalWith([outcome("t1", at, "skipped")]), expectEveryMin: 60 }),
  );
  assert.match(silent, /OVERDUE/, "two intervals of silence is a schedule that is not firing");
});

test("an EMPTY journal says cron has never ticked, not that all is well", () => {
  const md = renderCronReport(input({ journal: { rows: [], unreadableLines: 0 } }));
  assert.match(md, /never ticked/i);
  assert.doesNotMatch(md, /\bnothing to report\b/i);
});

test("heldOutPass: null renders as NO VERDICT and never as a pass or a fail", () => {
  // §16.1: on cron the compounding failure is "another confidently-wrong
  // result". A run whose gate could not run must not read like either outcome.
  const md = renderCronReport(
    input({
      runs: [detail({ runId: "run-1", status: "failed", heldOutPass: null, gateAttempts: 1, gateStopReason: "infra" })],
    }),
  );
  assert.match(md, /NO VERDICT/);
  assert.doesNotMatch(md, /run-1[^\n]*\bpassed\b/i);
  assert.match(md, /infra/);
});

test("a real verdict is NOT softened into NO VERDICT", () => {
  // The other direction, so "NO VERDICT" cannot be satisfied by printing it
  // unconditionally.
  const md = renderCronReport(input({ runs: [detail({ heldOutPass: true, falseFinish: false })] }));
  assert.doesNotMatch(md, /NO VERDICT/);
  assert.match(md, /held-out: PASS/);
});

test("a run with no recorded loop outcome says so, in those words", () => {
  // The state every run was in before the orchestrator started persisting the
  // pair. If that line is ever reverted, this is what the report starts saying
  // about every run — loudly.
  const md = renderCronReport(input({ runs: [detail({ gateAttempts: 0, gateStopReason: null })] }));
  assert.match(md, /no loop outcome recorded/i);
});

test("the ceiling is reported as used/allowed over the window", () => {
  const md = renderCronReport(
    input({ journal: journalWith([intent("t1"), intent("t2")]), maxRunsPerWindow: 4, windowHours: 24 }),
  );
  assert.match(md, /2 of 4/);
  assert.match(md, /24 h/);
});

test("a stranded claim and a damaged journal are both on the front page", () => {
  const md = renderCronReport(input({ stranded: ["/cron/claimed/t1-a.md"], journal: { rows: [], unreadableLines: 3 } }));
  assert.match(md, /STRANDED/);
  assert.match(md, /t1-a\.md/);
  assert.match(md, /3 unreadable/);
});

test("an intent with no outcome is named, not merely counted", () => {
  const md = renderCronReport(input({ journal: journalWith([intent("dead-tick")]) }));
  assert.match(md, /INTENT WITH NO OUTCOME/);
  assert.match(md, /dead-tick/);
});

test("the report names the files the owner should read, per run", () => {
  const md = renderCronReport(
    input({ runs: [detail({ runId: "run-1", verdictPath: "/runs/run-1/results/verdict.md" })] }),
  );
  for (const name of ["verdict.md", "backlog.md", "assumptions.md"]) assert.match(md, new RegExp(name));
});

test("the design lock's provenance is reported — automatic is not the same as chosen", () => {
  // §17.3 rule 4: the choice is recorded either way, with who made it and why.
  // An unattended run has to be explainable after the fact.
  // A PRE-2026-08-03 LOCK: no directions, `stage: "none"`, which is what the wire
  // reports for every run that predates the two-stage canvass.
  const lock: ApiDesignLock = {
    awaiting: false,
    mockups: [],
    locked: "/w/design-refs/01.png",
    lockedBy: "ui-designer",
    reason: "denser grid",
    directions: [],
    chosenDirection: null,
    chosenDirectionBy: null,
    stage: "none",
    turnsUsed: 0,
    turnsMax: MAX_DESIGN_LOCK_TURNS,
    rendersUsed: 0,
    rendersMax: MAX_DESIGN_ON_DEMAND_RENDERS,
    requests: [],
  };
  const md = renderCronReport(input({ runs: [detail({ designLock: lock })] }));
  assert.match(md, /ui-designer/);
  assert.match(md, /denser grid/);
  assert.match(md, /automatic/i);
  const owned = renderCronReport(input({ runs: [detail({ designLock: { ...lock, lockedBy: "owner" } })] }));
  assert.doesNotMatch(owned, /automatic/i, "an owner's pick must not read as an automatic one");
  assert.match(owned, /chosen by the owner/);
});

test("A RUN THE REPORT COULD NOT FETCH IS NAMED AS UNREADABLE, never as absent", () => {
  // FOUND BY EXECUTION, not by review. With a single `runs` field, a report whose
  // detail fetches all failed printed "No run was submitted in this window" three
  // lines below "submitted: 201 Created" — an absence claim standing in for a
  // failed lookup, which is the defect shape this whole phase is written against.
  const md = renderCronReport(input({ runIds: ["run-1"], runs: [] }));
  assert.match(md, /COULD NOT BE READ/);
  assert.match(md, /run-1/);
  assert.doesNotMatch(md, /No run id appears/, "a run that exists must not be reported as no run at all");
});

test("no run id in the window says so, and does not read as an all-clear", () => {
  const md = renderCronReport(input({ runIds: [], runs: [] }));
  assert.match(md, /No run id appears/);
  assert.doesNotMatch(md, /COULD NOT BE READ/);
  assert.doesNotMatch(md, /\bnothing to report\b/i);
});

test("no dollar figure appears anywhere in a report", () => {
  const md = renderCronReport(input({ runs: [detail({})] }));
  assert.doesNotMatch(md, /\$|costUsd|USD/);
});

test("the read-only entrypoint NEVER submits, and refreshes report.md", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "cron-report-")), "cron");
  mkdirSync(root, { recursive: true });
  ensureCronDirs(root);
  const methods: string[] = [];
  const http = async (url: string, init?: { method?: string }): Promise<TickResponse> => {
    methods.push(init?.method ?? "GET");
    return { status: 404, text: async () => `no ${url}` };
  };
  const printed: string[] = [];
  const code = await runReport({
    env: { DASHBOARD_CRON_DIR: root, DASHBOARD_CRON_MODEL: "opus[1m]" },
    now: () => NOW,
    http,
    out: (text) => printed.push(text),
  });
  assert.equal(code, 0);
  assert.equal(
    methods.every((method) => method === "GET"),
    true,
    "a report that could POST is a report that could start a run",
  );
  assert.equal(existsSync(join(root, CRON_REPORT_FILE)), true);
  assert.match(readFileSync(join(root, CRON_REPORT_FILE), "utf8"), /never ticked/i);
  assert.equal(printed.length, 1, "and it prints to stdout as well as to the file");
});

test("a config that cannot be used exits non-zero rather than printing an empty report", async () => {
  const code = await runReport({
    env: { DASHBOARD_CRON_DIR: mkdtempSync(join(tmpdir(), "cron-report-bad-")) },
    now: () => NOW,
    http: async () => ({ status: 200, text: async () => "[]" }),
    out: () => undefined,
  });
  assert.equal(code, 2);
});

test("refreshCronReport gathers the queue, the strandings and the failures from DISK", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "cron-report-disk-")), "cron");
  ensureCronDirs(root);
  writeFileSync(join(root, CRON_DIRS.queue, "a.md"), "x", "utf8");
  writeFileSync(join(root, CRON_DIRS.queue, "b.md"), "x", "utf8");
  writeFileSync(join(root, CRON_DIRS.claimed, "dead-c.md"), "x", "utf8");
  writeFileSync(join(root, CRON_DIRS.failed, "d.md"), "x", "utf8");
  const path = await refreshCronReport(config({ root }), NOW, async () => ({
    status: 404,
    text: async () => "",
  }));
  const md = readFileSync(path, "utf8");
  assert.match(md, /queue: 2 ticket\(s\)/);
  assert.match(md, /STRANDED/);
  assert.match(md, /dead-c\.md/);
  assert.match(md, /failed\/: 1/);
});
