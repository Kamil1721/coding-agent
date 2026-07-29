/**
 * cron-report.ts — what happened while you were asleep, including "cron never ran".
 *
 * WHY THE RENDERER TAKES `now` AS AN ARGUMENT. The tick writes this file, and a
 * tick can only write it when it runs — so a report that computed its own
 * staleness could never say "cron has not ticked in three days", which is the one
 * failure with no observer anywhere inside the system. `now` is therefore an
 * argument and there are TWO callers: the tick (whose `now` is the tick's own
 * clock, so `report.md` matches the row the tick just wrote) and the read-only
 * entrypoint the owner runs when they wake up (whose `now` is now, which is the
 * only way the OVERDUE arm is reachable at all).
 *
 * `heldOutPass: null` IS RENDERED AS "NO VERDICT" AND NEVER AS EITHER OUTCOME.
 * Spec §16.1 is explicit that cron's compounding failure is not a crash but
 * "another confidently-wrong result": a shelf of green-looking runs whose gate
 * could not run. A reader who has to squint at this file to tell a pass from an
 * ungraded run is exactly that failure, one layer up.
 *
 * NO DOLLAR FIGURE, ANYWHERE, and a test asserts the absence. `costUsd` is null
 * for a subscription run by invariant; a report that priced one would be the
 * fabrication `db.ts` refuses to give a column to. The bounds cron owns are runs
 * per window; the run-level bounds are turns and calls.
 *
 * THE READ-ONLY ENTRYPOINT NEVER SUBMITS and takes no lease. It mutates nothing a
 * tick reads except `report.md`, which a tick rewrites on its next pass.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunDetail } from "../api-types.js";
import { readCronConfig } from "./cron-config.js";
import type { CronConfig } from "./cron-config.js";
import { intentsInWindow, lastRow, orphanIntents, readJournal, windowRows } from "./cron-journal.js";
import type { JournalRead } from "./cron-journal.js";
import { listQueue, strandedClaims } from "./cron-queue.js";
import { CRON_DIRS } from "./cron-queue.js";
import type { TickRequestInit, TickResponse } from "./cron-tick.js";
import { readdirSync } from "node:fs";

export const CRON_REPORT_FILE = "report.md";

/**
 * How many expected intervals of silence before the report shouts.
 *
 * TWO, not one, and the reason is the surface this feeds: one missed interval is
 * a laptop that slept, a slow boot, or a tick that ran a minute late. Two
 * consecutive misses is a schedule that is not firing. A detector that cries wolf
 * on the first late tick is a detector the owner learns to ignore, and then the
 * real one is invisible too.
 */
export const OVERDUE_FACTOR = 2;

export interface CronReportInput {
  readonly now: string;
  readonly config: CronConfig;
  readonly journal: JournalRead;
  readonly queueDepth: number;
  readonly stranded: readonly string[];
  readonly failedCount: number;
  /** One per run id that appears in the window's outcome rows. */
  readonly runs: readonly RunDetail[];
}

function minutesBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60_000;
}

function heldOutLine(run: RunDetail): string {
  if (run.heldOutPass === null) {
    return (
      "  - held-out: **NO VERDICT** — the sealed gate did not produce a result, so this run is neither a " +
      "pass nor a fail"
    );
  }
  return `  - held-out: ${run.heldOutPass ? "PASS" : "FAIL"}`;
}

function falseFinishLine(run: RunDetail): string {
  if (run.falseFinish === null) return "  - false finish: undetermined";
  return run.falseFinish
    ? "  - false finish: **YES** — the build declared itself done and the gate disagreed"
    : "  - false finish: no";
}

function loopLine(run: RunDetail): string {
  if (run.gateAttempts === 0 && run.gateStopReason === null) {
    return "  - gate/fix loop: **no loop outcome recorded** for this run";
  }
  return `  - gate/fix loop: ${String(run.gateAttempts)} attempt(s), stopped on \`${String(run.gateStopReason)}\``;
}

function designLine(run: RunDetail): string {
  const lock = run.designLock;
  if (lock === null) return "  - design lane: none for this run";
  if (lock.awaiting) return "  - design lock: **still awaiting a choice** — this run is parked";
  if (lock.locked === null) return "  - design lock: the lane ran and locked nothing";
  if (lock.lockedBy === "owner") {
    return `  - design lock: ${lock.locked} — chosen by the owner (${lock.reason ?? "no reason recorded"})`;
  }
  // §17.3 rule 4: the choice is recorded either way, with who made it and why. An
  // unattended pick has to READ as automatic, or a reader will assume a human
  // looked at five mockups and picked one.
  return (
    `  - design lock: ${lock.locked} — chosen automatically by \`${String(lock.lockedBy)}\`: ` +
    `${lock.reason ?? "no reason recorded"}`
  );
}

function filesLine(run: RunDetail): string {
  if (run.verdictPath.length === 0) {
    return "  - files: verdict.md, backlog.md and assumptions.md are not written until the run is terminal";
  }
  const dir = dirname(run.verdictPath);
  return `  - files in ${dir}: verdict.md, backlog.md, assumptions.md, design-lane.json`;
}

export function renderCronReport(input: CronReportInput): string {
  const { config, journal, now } = input;
  const lines: string[] = [];
  lines.push(`# cron — ${config.root}`, "", `read at ${now}`, "");

  // 1. WHEN DID CRON LAST TICK. Trap row 6, and the only arm no tick can write.
  const last = lastRow(journal.rows);
  if (last === null) {
    lines.push(
      "- last tick: **cron has never ticked.** There is no journal in this directory. Either the schedule " +
        "was never installed, or it has never fired, or it is pointed at a different cron directory.",
    );
  } else {
    const age = minutesBetween(last.at, now);
    const overdue = age !== null && age >= config.expectEveryMin * OVERDUE_FACTOR;
    const ago = age === null ? "an unreadable time" : `${String(Math.round(age))} minutes`;
    lines.push(
      `- last tick: ${last.at} (${ago} ago) — ${String(last.decision ?? "intent, no outcome")}: ${last.reason}`,
    );
    if (overdue) {
      lines.push(
        `- **OVERDUE.** A tick was expected every ${String(config.expectEveryMin)} minutes and the last one ` +
          `was at ${last.at}. No tick can report this, so nothing else will: check that the schedule is ` +
          `loaded and firing (\`launchctl list | grep dashboard-cron\`, or \`crontab -l\`), and that the ` +
          `machine was awake.`,
      );
    }
  }

  // 2. THE CEILING, as used of allowed over the window.
  const used = intentsInWindow(journal.rows, now, config.windowHours).length;
  lines.push(
    `- ceiling: ${String(used)} of ${String(config.maxRunsPerWindow)} submission intents in the last ` +
      `${String(config.windowHours)} h. Counted as INTENTS, so a tick that died mid-submit still spent its slot.`,
  );
  lines.push(`- ticks recorded in the window: ${String(windowRows(journal.rows, now, config.windowHours).length)}`);
  lines.push(`- queue: ${String(input.queueDepth)} ticket(s) waiting`);
  lines.push(`- refused tickets in ${CRON_DIRS.failed}/: ${String(input.failedCount)}`);

  // 3. THE THINGS THAT NEED A HUMAN, on the front page rather than buried.
  if (input.stranded.length > 0) {
    lines.push(
      `- **STRANDED**: ${String(input.stranded.length)} claimed ticket(s) nobody settled. Cron will refuse ` +
        `every tick until these are resolved. ${input.stranded.join(", ")}`,
    );
  }
  const orphans = orphanIntents(journal.rows);
  if (orphans.length > 0) {
    lines.push(
      `- **INTENT WITH NO OUTCOME**: ${orphans.map((row) => `${row.tickId} at ${row.at}`).join(", ")}. Each of ` +
        `those ticks may or may not have created a run; GET /api/runs is the answer.`,
    );
  }
  if (journal.unreadableLines > 0) {
    lines.push(
      `- **DAMAGED JOURNAL**: ${String(journal.unreadableLines)} unreadable line(s). They are counted, not ` +
        `dropped, so the numbers above are lower bounds.`,
    );
  }

  // 4. PER RUN. Every field here already exists on the frozen contract.
  lines.push("", "## runs cron submitted in this window", "");
  if (input.runs.length === 0) {
    lines.push("No run was submitted in this window. That is a fact, not an all-clear: see the ceiling above.");
  }
  for (const run of input.runs) {
    lines.push(`### ${run.runId} — ${run.status}`);
    lines.push(`  - ticket: ${run.ticketTitle}`);
    lines.push(heldOutLine(run));
    lines.push(falseFinishLine(run));
    lines.push(loopLine(run));
    lines.push(`  - criteria the owner did not state: ${String(run.inferredCriteria)}`);
    lines.push(designLine(run));
    lines.push(filesLine(run));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------
 * Gathering the input. Filesystem plus GETs; no POST, ever.
 * ---------------------------------------------------------------------- */

export type ReportHttp = (url: string, init?: TickRequestInit) => Promise<TickResponse>;

async function runDetails(
  config: CronConfig,
  http: ReportHttp,
  runIds: readonly string[],
): Promise<readonly RunDetail[]> {
  const details: RunDetail[] = [];
  for (const runId of runIds) {
    try {
      const response = await http(`${config.baseUrl}/api/runs/${runId}`);
      if (response.status !== 200) continue;
      details.push(JSON.parse(await response.text()) as RunDetail);
    } catch {
      // A detail we could not fetch is omitted from the per-run section. The
      // journal's own row for that tick still names the run id above.
      continue;
    }
  }
  return details;
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .length;
  } catch {
    return 0;
  }
}

export async function gatherCronReport(config: CronConfig, now: string, http: ReportHttp): Promise<CronReportInput> {
  const journal = readJournal(config.root);
  const runIds = [
    ...new Set(
      windowRows(journal.rows, now, config.windowHours)
        .map((row) => row.runId)
        .filter((runId): runId is string => runId !== null),
    ),
  ];
  return {
    now,
    config,
    journal,
    queueDepth: listQueue(config.root).length,
    stranded: strandedClaims(config.root),
    failedCount: countFiles(join(config.root, CRON_DIRS.failed)),
    runs: await runDetails(config, http, runIds),
  };
}

/** Render and write `report.md`. Returns the path. */
export function writeCronReport(root: string, input: CronReportInput): string {
  const path = join(root, CRON_REPORT_FILE);
  writeFileSync(path, renderCronReport(input), "utf8");
  return path;
}

export async function refreshCronReport(config: CronConfig, now: string, http: ReportHttp): Promise<string> {
  return writeCronReport(config.root, await gatherCronReport(config, now, http));
}

export interface ReportDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => string;
  readonly http: ReportHttp;
  readonly out?: (text: string) => void;
}

/**
 * The read-only entrypoint. Reads the journal, fetches details, prints, and
 * refreshes `report.md`.
 *
 * ITS `now` IS THE REAL NOW, which is the entire point: this is the only caller
 * that can reach the OVERDUE arm, because a tick that is running is proof that a
 * tick ran.
 */
export async function runReport(deps: ReportDeps): Promise<number> {
  const out = deps.out ?? ((text: string): void => void process.stdout.write(text));
  const config = readCronConfig(deps.env);
  if (!config.ok) {
    process.stderr.write(`the cron configuration is unusable, so there is nothing to report on: ${config.why}\n`);
    return 2;
  }
  const input = await gatherCronReport(config.config, deps.now(), deps.http);
  const markdown = renderCronReport(input);
  writeCronReport(config.config.root, input);
  out(markdown);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runReport({
    env: process.env,
    now: () => new Date().toISOString(),
    http: async (url, init) => await fetch(url, init as RequestInit | undefined),
  }).then((code) => {
    process.exit(code);
  });
}
