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
import { assertNoScreenshotReference } from "./visual-substance.js";
import type { AgentVisibleReport, FixableFailure } from "./gate-report.js";
import type { FixTask } from "./fix-triage.js";

/**
 * The delegation bound for ONE fix round: exactly the agent this work was routed
 * to, and nothing else.
 *
 * NARROWER THAN THE BUILD'S OWN SHORTLIST, ON PURPOSE. The build may reach ~26
 * agents because it is doing open-ended work. A fix round has one job that
 * triage already decided; handing it the full shortlist invites a second
 * exploratory build inside a loop whose whole value is that it is bounded.
 *
 * An empty array would deny all delegation (builders/types.ts), so a caller that
 * forgot this would get a fixer that silently does everything itself. This
 * returns a one-element array rather than letting that be the default.
 */
export function fixAllowedAgents(task: FixTask): readonly string[] {
  return [task.agent];
}

export interface FixPromptRequest {
  readonly task: FixTask;
  readonly report: AgentVisibleReport;
  /** The builder's cwd. Named so the agent does not have to guess. */
  readonly workspace: string;
  /** 1-based. Stated so the agent knows the budget is finite and small. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * What a withheld VISUAL detail says. It says something, for `WITHHELD_DETAIL`'s
 * reason: a blank line where evidence should be reads as "there was nothing".
 */
export const WITHHELD_VISUAL_DETAIL =
  "detail withheld: the text this gate wrote about the finding carries what looks like a file path or " +
  "an image filename, and a capture is the one thing a fix prompt may not locate. Masking is applied at " +
  "capture time and is the only masking there is, so a path here is an invitation to open an image " +
  "nobody vetted. The flow and the breakpoint above are the whole of what can be said about where — " +
  "render that flow at that breakpoint yourself and look at it.";

/**
 * A visual failure's detail, FAIL-CLOSED at the last boundary before an agent.
 *
 * WHY IT LIVES HERE AND NOT WHERE THE FAILURE IS BUILT. `gate-report.ts` copies
 * `domFindings[].detail` and `exploitFindings[].detail` into a `FixableFailure`
 * verbatim, with a length cap and no allowlist — the tier-0 path has
 * `DETAIL_ALLOWLIST` and those two do not. This function does not repair that;
 * it stops the one class whose free text is written ABOUT A RENDERED CAPTURE
 * from carrying a way to find it. `gate-report.ts` belongs to no lane in this
 * wave, and a guard at the terminal boundary covers every producer that will
 * ever feed it, including ones not written yet.
 *
 * WITHHELD, NOT THROWN, AND THE DIFFERENCE IS THE OWNER'S OVERNIGHT RUN.
 * `assertNoScreenshotReference` throws, which is correct where it is called
 * today — inside record construction, where a throw is a programming error
 * caught in a test. Here the same throw would reject `runGateFixLoop`'s promise,
 * fail the gate phase, and turn a FIXABLE visual failure into a crashed run at
 * three in the morning. A withheld detail costs the fixer one piece of evidence;
 * a throw costs the owner the night. The boundary is equally closed either way.
 *
 * NOT APPLIED TO THE OTHER CLASSES, DELIBERATELY. The guard's pattern matches
 * any `/` after whitespace or a quote, so `TS2345 at src/app.ts:12` — the exact
 * string the leak test asserts DOES cross — would be withheld, and a debugger
 * told only "the build failed" is a fix round spent rediscovering the error.
 */
function visualDetail(detail: string): string {
  try {
    assertNoScreenshotReference(detail, "a visual failure's detail on its way to a fixing agent");
    return detail;
  } catch {
    return WITHHELD_VISUAL_DETAIL;
  }
}

function renderFailure(index: number, failure: FixableFailure): readonly string[] {
  const lines = [`${String(index + 1)}. [${failure.klass}] ${failure.summary}`];
  if (failure.command !== null) lines.push(`   command: ${failure.command}`);
  if (failure.exitCode !== null) lines.push(`   exit code: ${String(failure.exitCode)}`);
  const detail = failure.klass === "visual" ? visualDetail(failure.detail) : failure.detail;
  if (detail.length > 0) lines.push(`   ${detail.split("\n").join("\n   ")}`);
  return lines;
}

/**
 * What a visual fixer is told to DO, and why the generic instruction is not it.
 *
 * A VISUAL FAILURE HAS NO COMMAND. `gate-report.ts` sets `command: null` on every
 * DOM finding and on the screenshot gates, so the generic "re-run the failing
 * command yourself to check it" names a thing that does not exist. An agent
 * handed a routed task it cannot act on is worse than an unrouted one: the run
 * spends a round, re-gates, sees the same finding, and stops — having looked
 * from the outside exactly like a fixer that tried.
 *
 * THE ASSET CLAUSE IS THE OWNER'S STANDING RULE, and this is the single most
 * likely place in the whole program to break it: a design specialist told to fix
 * a missing or broken image will reach for an icon package or a stock-photo URL,
 * because that is what its own skills recommend. Stating the rule at the point
 * of temptation is cheaper than detecting the violation afterwards — and it is
 * currently the ONLY place it is stated to a fixing agent.
 *
 * MECHANICAL, NOT SCOLDING, for the reason in this file's header: Anthropic
 * measured "only a misaligned AI would do X" framing producing HIGHER
 * misalignment than neutral framing. "The suite still asks for the section" is a
 * fact about the measurement. "Do not cheat by deleting it" is the framing that
 * measured worse.
 */
const VISUAL_INSTRUCTIONS: readonly string[] = Object.freeze([
  "HOW TO WORK A VISUAL FAILURE:",
  "- There is no command to re-run for these. Each one was observed on a page that had already been " +
    "rendered, so the way to check a fix is to serve the build, open the flow named above at the " +
    "breakpoint named above, and look at it.",
  "- What this build is judged against is the design reference this run LOCKED, which is in the " +
    "workspace with the rest of the run's design material. Read it before you change anything, and " +
    "match it rather than improve on it — a change that is better than the locked design is still a " +
    "divergence from the locked design, and divergence is what is being measured.",
  "- ANY IMAGE, ICON OR FONT YOU ADD MUST BE GENERATED FOR THIS BUILD AND SHIPPED FROM THIS WORKSPACE. " +
    "No CDN link, no icon font, no icon package, no stock-photo URL, no remote webfont — including the " +
    "ones your own skills recommend by name. This is a standing rule of the product and not a " +
    "preference of this round. If a fix needs an asset that does not exist yet, say which asset and " +
    "stop; an asset you fetched is a defect whatever it looks like.",
  "- Fix the style or the markup that produced the observation. Removing the element removes the " +
    "element: the acceptance suite was written from the ticket and still asks for whatever was there.",
]);

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

  // ANY VISUAL FAILURE IN THE BATCH, not "every". A task is batched by AGENT,
  // and `taste-frontend-expert` is reached only by `visual`, so in practice the
  // batch is homogeneous — but `ROUTES` is data, and a table that later routed
  // two classes to one agent would silently drop this block if it asked for
  // `every`. The failure mode of asking for `some` is four extra lines of true
  // instruction; the failure mode of asking for `every` is a visual failure with
  // no instruction, which is the state this block exists to end.
  const hasVisual = task.failures.some((failure) => failure.klass === "visual");
  if (hasVisual) lines.push("", ...VISUAL_INSTRUCTIONS);

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
    `- ${task.agent} is the specialist this work was routed to, and the only agent you may delegate to ` +
      "this round. Use it, or do the work yourself; anything else is denied.",
    hasVisual
      ? "- Fix the cause in the application code, then check it the way the section above describes."
      : "- Fix the cause in the application code, then re-run the failing command yourself to check it.",
    "- If a failure is not real — the gate is wrong about the artefact — say so and say why, and change " +
      "nothing. A wrong fix costs a whole round.",
    "- Report back what you changed and what you could not close. Anything you leave open is written to " +
      "the run's backlog, so an unfinished item is a recorded item, not a failure to hide.",
  );

  return lines.join("\n");
}
