/**
 * fix-prompt.ts — what a fixing agent is told, and the reason it is told so
 * little.
 *
 * THE TYPE SIGNATURE IS THE FIRST HALF OF THE BOUNDARY. This function accepts a
 * {@link FixTask} and an {@link AgentVisibleReport} and NOTHING ELSE. It cannot
 * be handed a `ContainerResult`, so the leak the whole phase exists to prevent
 * is not merely discouraged here, it does not typecheck. `gate-report.ts` is the
 * only thing that produces an `AgentVisibleReport`, and it takes nothing from
 * `criterionCoverage` except a per-tier count.
 *
 * (The second half is a test — `gate-fix-loop.test.ts` runs a container with a
 * held-out title planted in every carrier it has, through the REAL redactor and
 * the REAL prompt builder, and asserts the title is absent from what the loop
 * hands an agent. A type cannot catch a template literal that reads a field it
 * was given legitimately.)
 *
 * NO ANTI-CHEATING SCOLDING, for the same measured reason `build-prompt.ts`
 * carries none: Anthropic measured that "only dangerously misaligned AIs would
 * hack" framing produced HIGHER misalignment than neutral framing (doc 02 §5.6).
 * What is stated instead is mechanical and true — the acceptance suite is not in
 * this workspace, editing `visible-acceptance/` changes nothing that is scored —
 * because a fixer that does not know that wastes its round discovering it.
 */

import { WORKSPACE } from "bakeoff/dist/runner.js";
import type { AgentVisibleReport } from "./gate-report.js";
import type { FixTask } from "./fix-triage.js";

export interface FixPromptRequest {
  readonly task: FixTask;
  readonly report: AgentVisibleReport;
  /** The builder's cwd. Named so the agent does not have to guess. */
  readonly workspace: string;
  /** 1-based. Stated so the agent knows the budget is finite and small. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

function renderFailure(index: number, failure: FixPromptRequest["report"]["failures"][number]): readonly string[] {
  const lines = [`${String(index + 1)}. [${failure.klass}] ${failure.summary}`];
  if (failure.command !== null) lines.push(`   command: ${failure.command}`);
  if (failure.exitCode !== null) lines.push(`   exit code: ${String(failure.exitCode)}`);
  if (failure.detail.length > 0) lines.push(`   ${failure.detail.split("\n").join("\n   ")}`);
  return lines;
}

/**
 * The instruction for one batched fix task.
 *
 * Every failure in the task is stated in one prompt rather than one per spawn:
 * three type errors are one job for one debugger, and three sequential spawns
 * would each re-read the tree to discover the other two.
 */
export function buildFixPrompt(request: FixPromptRequest): string {
  const { task, report, workspace, attempt, maxAttempts } = request;
  const lines: string[] = [
    `The build in ${workspace} did not pass its gate. You are fixing it.`,
    "",
    `This is fix round ${String(attempt)} of at most ${String(maxAttempts)}. The run stops after that ` +
      "whether or not the gate is green, so prefer the change that closes a failure over the change that " +
      "is most thorough.",
    "",
    `WHAT FAILED (${String(task.failures.length)} item(s) routed to you):`,
  ];

  task.failures.forEach((failure, index) => {
    lines.push(...renderFailure(index, failure));
  });

  const unmet = report.heldOutUnmet;
  const unmetTotal = unmet.BLOCKING + unmet.FUNCTIONAL + unmet.QUALITY;
  lines.push(
    "",
    "HOW THIS IS BEING JUDGED:",
    `- The acceptance suite was written from the ticket text before this build existed. Part of it was ` +
      `copied into ${WORKSPACE.visibleDir}/ as a real feedback signal; the rest is not in this workspace ` +
      "and is not available to you or to me.",
    unmetTotal === 0
      ? "- Every acceptance criterion is currently satisfied. Do not regress one to close a gate."
      : `- Currently unmet, by tier and count only: ${String(unmet.BLOCKING)} BLOCKING, ` +
        `${String(unmet.FUNCTIONAL)} FUNCTIONAL, ${String(unmet.QUALITY)} QUALITY. Which criteria those ` +
        "are, and what they assert, is the measurement — it is not something I can tell you.",
    `- Changing anything under ${WORKSPACE.visibleDir}/ changes nothing that is scored. The suite that ` +
      "scores this run is a separate frozen copy outside the workspace.",
    "",
    "WHAT TO DO:",
    "- Fix the cause in the application code, then re-run the failing command yourself to check it.",
    "- If a failure is not real — the gate is wrong about the artefact — say so and say why, and change " +
      "nothing. A wrong fix costs a whole round.",
    "- Report back what you changed and what you could not close. Anything you leave open is written to " +
      "the run's backlog, so an unfinished item is a recorded item, not a failure to hide.",
  );

  return lines.join("\n");
}
