/**
 * backlog.ts — what the loop did not close, written on EVERY terminal outcome
 * including green.
 *
 * WHY IT IS WRITTEN EVEN WHEN NOTHING IS LEFT. An unattended run that stops
 * without saying what remains is unactionable, and a missing file is ambiguous
 * between "nothing was deferred" and "the backlog step never ran". A green run
 * therefore writes a backlog that says, in those words, that nothing was
 * deferred. (CLAUDE.md rule 7: never drop a deferred or blocked item.)
 *
 * IT IS SUBJECT TO THE SAME BOUNDARY AS A FIX PROMPT. This file is read by a
 * human, but it is written into the run directory, which `deploy` may serve over
 * loopback and which a later run's builder shares a filesystem with. It renders
 * `FixableFailure`s — already through `gate-report.ts` — and per-tier COUNTS. It
 * must never grow a field that reads `criterionCoverage` directly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type { CriterionTier } from "bakeoff/dist/contracts.js";
import { agentFor } from "./fix-triage.js";
import type { FixTask } from "./fix-triage.js";
import type { FailureClass, FixableFailure } from "./gate-report.js";
import type { StopReason } from "./gate-fix-loop.js";

export interface BacklogInput {
  readonly reason: StopReason;
  readonly attempts: number;
  readonly remaining: readonly FixableFailure[];
  readonly heldOutUnmet: Readonly<Record<CriterionTier, number>>;
  /** Planned work this run's shortlist would not permit. Recorded, not dropped. */
  readonly denied?: readonly FixTask[];
  readonly infraFailure?: string | null;
}

/** Why the loop stopped, in the owner's terms rather than the enum's. */
const REASONS: Readonly<Record<StopReason, string>> = Object.freeze({
  green: "the gate went green — every tier-0 gate passed and every acceptance criterion was satisfied.",
  "retry-cap": "the fix loop hit its attempt cap. Work below is real and unfinished, not unknown.",
  "not-converging":
    "two consecutive gate runs produced the identical failures, so the fix round changed nothing " +
    "observable. The remaining budget was not spent proving that a third time.",
  infra:
    "the gate did not complete, so THIS IS NOT A VERDICT ABOUT THE BUILD. Nothing below is evidence " +
    "about the artefact.",
  cancelled: "the run was cancelled. Whatever is below was true at the last gate it completed.",
});

/** The next concrete action per class. Named agent included — it is delegable. */
const NEXT_ACTION: Readonly<Record<FailureClass, string>> = Object.freeze({
  install: "resolve the dependency tree (lockfile, peer ranges, registry availability), then re-run the build",
  build: "read the compiler/bundler error and fix the source it points at, then re-run the build command",
  boot: "start the app the way the gate does and fix whatever stops it answering its health path",
  route: "request each declared route and fix the handler behind the one that does not answer",
  "test-infra": "remove the construct from the test path and let the tests assert for real",
  logic: "reproduce the failure, fix the cause in application code, and re-run the failing command",
  structure: "apply the lint/structure fix without changing behaviour, then re-run the check",
  visual: "re-render the flow and fix what makes the screenshot blank, overflowing or unstyled",
});

function renderRemaining(remaining: readonly FixableFailure[], measured: boolean): readonly string[] {
  // THE TRAP THIS BRANCH EXISTS FOR, caught by its own test rather than in
  // production: with no failures to list, an unmeasured run rendered "Nothing
  // deferred: no gate failure was left open" — a build the scorer never scored,
  // reading exactly like a clean one. "The gate could not run" and "the gate
  // passed" must not look alike at any level of this program.
  if (!measured) {
    return [
      "UNKNOWN — the gate did not complete, so nothing here has been measured. This is not a claim that " +
        "the build is clean; it is the absence of a claim.",
    ];
  }
  if (remaining.length === 0) return ["Nothing deferred: no gate failure was left open."];
  const lines: string[] = [];
  for (const failure of remaining) {
    lines.push(`- **[${failure.klass}] ${failure.summary}**`);
    if (failure.command !== null) lines.push(`  - command: \`${failure.command}\``);
    if (failure.exitCode !== null) lines.push(`  - exit code: ${String(failure.exitCode)}`);
    if (failure.detail.length > 0) lines.push(`  - ${failure.detail.split("\n").join(" ")}`);
    lines.push(`  next: ${NEXT_ACTION[failure.klass]} (${agentFor(failure.klass)})`);
  }
  return lines;
}

function renderHeldOut(unmet: Readonly<Record<CriterionTier, number>>, measured: boolean): readonly string[] {
  if (!measured) {
    return [
      "UNKNOWN — the frozen suite did not run, so no criterion has a result. `heldOutPass` stays NULL for " +
        "this run, which is what a run with no verdict looks like.",
    ];
  }
  const total = unmet.BLOCKING + unmet.FUNCTIONAL + unmet.QUALITY;
  if (total === 0) return ["Every acceptance criterion the sealed suite checks was satisfied."];
  return [
    `${String(unmet.BLOCKING)} BLOCKING, ${String(unmet.FUNCTIONAL)} FUNCTIONAL and ` +
      `${String(unmet.QUALITY)} QUALITY criteria were not satisfied.`,
    "",
    "WHICH criteria, and what they assert, is not recorded here and was not shown to any fixing agent. " +
      "That is the measurement: the suite was authored from your ticket text before this build existed, " +
      "and the half that is not in the workspace is what makes the verdict mean anything. If the counts " +
      "surprise you, the cheap correction is the TICKET — see assumptions.md in this directory.",
  ];
}

export function renderBacklog(input: BacklogInput): string {
  const infraFailure = input.infraFailure ?? null;
  /** Did a gate run to completion? An infra stop means no, and says so. */
  const measured = input.reason !== "infra" && infraFailure === null;
  const lines: string[] = [
    "# Backlog",
    "",
    `**Stopped:** \`${input.reason}\` after ${String(input.attempts)} attempts.`,
    "",
    REASONS[input.reason],
  ];

  if (infraFailure !== null) {
    // A run that stopped before the gate is not an infrastructure failure of the
    // scorer, and labelling it as one would file the owner's own cancel under
    // "the machine broke".
    lines.push("", `**${input.reason === "infra" ? "Infrastructure failure" : "Why nothing was measured"}:** ${infraFailure}`);
  }

  lines.push("", "## Still broken", "", ...renderRemaining(input.remaining, measured));
  lines.push("", "## Held-out acceptance suite", "", ...renderHeldOut(input.heldOutUnmet, measured));

  const denied = input.denied ?? [];
  if (denied.length > 0) {
    lines.push(
      "",
      "## Planned, and not permitted to run",
      "",
      "These fixes were routed to an agent this run's delegation shortlist does not permit, so nothing " +
        "attempted them. They are recorded here because a denied agent produces no output, and no output " +
        "is indistinguishable from an agent that had nothing to do.",
      "",
    );
    for (const task of denied) {
      lines.push(`- **${task.agent}** — ${String(task.failures.length)} failure(s):`);
      for (const failure of task.failures) lines.push(`  - [${failure.klass}] ${failure.summary}`);
    }
  }

  return `${redactForPersistence(lines.join("\n"))}\n`;
}

/** `runs/<runId>/results/backlog.md`. Returns the path it wrote. */
export function writeBacklog(resultsDir: string, input: BacklogInput): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, "backlog.md");
  writeFileSync(path, renderBacklog(input), "utf8");
  return path;
}
