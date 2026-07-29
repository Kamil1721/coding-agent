/**
 * cron-journal.ts — the only observer a tick has.
 *
 * THE TRAP THIS FILE EXISTS FOR. Six of the seven ways a tick can end produce
 * the identical observable — "no new run appeared" — and exactly one of them is
 * correct behaviour:
 *
 *   the dashboard was not running                                 FAULT
 *   DASHBOARD_PORT differs between the server and the schedule     FAULT
 *   a killed tick left its lease behind                            FAULT
 *   a ticket was claimed and the tick died before the POST         FAULT
 *   the POST was rejected                                          FAULT
 *   the schedule was never installed / never fired                 FAULT
 *   the queue was empty — nothing was supposed to happen           CORRECT
 *
 * `decision: "skipped"` and a silent exit produce the same number of runs and
 * MUST NOT produce the same record. So every terminal path of a tick appends
 * exactly one outcome row naming the decision and why.
 *
 * APPEND-ONLY JSONL, ONE `appendFileSync` PER ROW. No rewrite, no truncate, no
 * lock: a killed process can lose at most the tail of its own last line, and
 * `readJournal` counts that line rather than pretending it was never there. A
 * journal that threw on a half-written line could not answer the one question
 * the report most needs — "when did cron last tick" — precisely when something
 * has gone wrong.
 *
 * THE CEILING COUNTS INTENTS, NOT OUTCOMES, and that asymmetry is deliberate.
 * A tick killed between the atomic rename and the `POST` leaves an intent and no
 * outcome; counting outcomes would hand its slot back and let the next tick
 * spend it again. Counting intents over-charges by at most one per killed tick
 * and never under-charges, and `orphanIntents` names the tick that caused it so
 * the over-charge is explainable rather than mysterious.
 *
 * EVERY ROW GOES THROUGH `redactForPersistence`. A `reason` carries the
 * dashboard's own error body verbatim, which is the right thing to record and
 * also an arbitrary string from another process.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";

/**
 * The eight ways a tick can end. Each has a distinct exit code (see
 * `cron-tick.ts`), because `launchd`'s error log is the second surface and the
 * journal is the first.
 */
export type CronDecision =
  | "submitted" // a run exists now
  | "skipped" // deliberate no-op: nothing queued, or a run is still in flight
  | "refused" // the ceiling is spent
  | "lease-held" // another tick is running
  | "stranded" // a claimed ticket from a dead tick is unresolved
  | "misconfigured" // the config refuses to produce a submission
  | "unreachable" // the dashboard did not answer, or the model is unavailable
  | "rejected"; // the dashboard answered and said no

export interface CronRow {
  readonly tickId: string;
  readonly at: string;
  readonly phase: "intent" | "outcome";
  /** Null on an intent row: at intent time the outcome is not known. */
  readonly decision: CronDecision | null;
  readonly reason: string;
  readonly ticketFile: string | null;
  readonly runId: string | null;
  readonly exitCode: number | null;
  readonly dashboardUrl: string;
  readonly modelId: string | null;
}

export const CRON_JOURNAL_FILE = "journal.jsonl";

function append(dir: string, row: CronRow): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, CRON_JOURNAL_FILE), `${JSON.stringify(redactForPersistence(row))}\n`, "utf8");
}

/**
 * "I am about to submit." Written BEFORE the `POST`, so a tick that dies during
 * it is still counted and still named.
 */
export function appendIntent(dir: string, row: Omit<CronRow, "phase" | "decision" | "exitCode" | "runId">): void {
  append(dir, { ...row, phase: "intent", decision: null, runId: null, exitCode: null });
}

/** "This is what happened." Exactly one per tick, on every terminal path. */
export function appendOutcome(dir: string, row: Omit<CronRow, "phase">): void {
  append(dir, { ...row, phase: "outcome" });
}

export interface JournalRead {
  readonly rows: readonly CronRow[];
  /** Lines that did not parse, or parsed into something that is not a row. Reported, never silently dropped. */
  readonly unreadableLines: number;
}

const DECISIONS: readonly string[] = [
  "submitted",
  "skipped",
  "refused",
  "lease-held",
  "stranded",
  "misconfigured",
  "unreachable",
  "rejected",
];

function toRow(value: unknown): CronRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const at = raw["at"];
  const phase = raw["phase"];
  const decision = raw["decision"] ?? null;
  if (typeof raw["tickId"] !== "string") return null;
  // AN UNDATEABLE ROW IS UNREADABLE, not a row with a strange date. Every
  // consumer here windows by `at`; a row the window cannot place would leave the
  // ceiling's count without anything saying so.
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  if (phase !== "intent" && phase !== "outcome") return null;
  if (decision !== null && !(typeof decision === "string" && DECISIONS.includes(decision))) return null;
  return {
    tickId: raw["tickId"],
    at,
    phase,
    decision: decision as CronDecision | null,
    reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
    ticketFile: typeof raw["ticketFile"] === "string" ? raw["ticketFile"] : null,
    runId: typeof raw["runId"] === "string" ? raw["runId"] : null,
    exitCode: typeof raw["exitCode"] === "number" ? raw["exitCode"] : null,
    dashboardUrl: typeof raw["dashboardUrl"] === "string" ? raw["dashboardUrl"] : "",
    modelId: typeof raw["modelId"] === "string" ? raw["modelId"] : null,
  };
}

/**
 * Rows in FILE ORDER, which is append order, which is the order the ticks ran.
 *
 * An absent journal is `{rows: [], unreadableLines: 0}` and never an error: on a
 * fresh machine that is the true state, and "cron has never ticked" is a fact
 * the report states in those words.
 */
export function readJournal(dir: string): JournalRead {
  const path = join(dir, CRON_JOURNAL_FILE);
  if (!existsSync(path)) return { rows: [], unreadableLines: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { rows: [], unreadableLines: 0 };
  }
  const rows: CronRow[] = [];
  let unreadableLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines += 1;
      continue;
    }
    const row = toRow(parsed);
    if (row === null) unreadableLines += 1;
    else rows.push(row);
  }
  return { rows, unreadableLines };
}

export function windowRows(rows: readonly CronRow[], now: string, hours: number): readonly CronRow[] {
  const cutoff = Date.parse(now) - hours * 3_600_000;
  return rows.filter((row) => Date.parse(row.at) >= cutoff);
}

/** Intent rows in the window. THE CEILING COUNTS THESE. */
export function intentsInWindow(rows: readonly CronRow[], now: string, hours: number): readonly CronRow[] {
  return windowRows(rows, now, hours).filter((row) => row.phase === "intent");
}

/**
 * Intents with no outcome row for the same tickId — a tick that died mid-submit.
 *
 * Named rather than counted, because the owner's next question is always "which
 * one, and did the run start?", and `runId` plus `GET /api/runs` answers it.
 */
export function orphanIntents(rows: readonly CronRow[]): readonly CronRow[] {
  const settled = new Set(rows.filter((row) => row.phase === "outcome").map((row) => row.tickId));
  return rows.filter((row) => row.phase === "intent" && !settled.has(row.tickId));
}

export function lastRow(rows: readonly CronRow[]): CronRow | null {
  return rows.length === 0 ? null : (rows[rows.length - 1] ?? null);
}
