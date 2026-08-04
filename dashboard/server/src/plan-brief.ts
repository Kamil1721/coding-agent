/**
 * plan-brief.ts — folding the whole exchange back into the brief.
 *
 * ONE FUNCTION, ONE CALL SITE, AND IT TAKES THE WHOLE STATE. The owner's rule is
 * "the orchestrator must not be left not knowing something": everything said in
 * the plan dialogue — the questions, the answers, the declines, the owner's own
 * questions and the seat's replies to them — has to be in the brief BEFORE the
 * suite is authored. Knowledge that exists only in the chat transcript is
 * knowledge the criteria author never sees, which would reproduce the exact
 * defect this phase exists to fix, one level down.
 *
 * {@link foldPlanIntoBrief} therefore takes {@link PlanState} itself rather than
 * a filtered selection of it. There is no parameter a caller could use to leave a
 * turn out, and the test drives an exchange containing every kind of turn and
 * asserts each one's text survives.
 *
 * ─── WHAT IS DELIBERATELY NOT FOLDED, AND WHY THAT IS NOT A DROPPED TURN ───
 *
 * Questions the worth rule REFUSED. They were never put to the owner, so they
 * are not part of any exchange; they are the seat's discarded guesses. Writing
 * them into the brief would hand the criteria author a list of things nobody
 * asked and nobody answered, dressed as part of the ticket. They are recorded in
 * `PlanState.dropped` for the run log, which is where a record of the seat's
 * behaviour belongs.
 *
 * ─── THE HANDOFF THIS FILE CANNOT COMPLETE, STATED PLAINLY ───
 *
 * `ticket-refs.ts#ticketProse` cuts a composed brief at `CAPTURE_BLOCK_BEGIN` so
 * the surface classifier and the assumptions tracer see the OWNER'S words and not
 * the machine's reading of a captured page. It does not yet know about
 * {@link PLAN_BLOCK_BEGIN}, and until it does, a run with NO site capture would
 * put this whole block inside what `ticketProse` returns. The consequence is
 * specific and bad: `spec-assumptions.ts` traces a criterion to the ticket by
 * content-token overlap, so a DECLINED question's wording sitting in the prose
 * region would manufacture that overlap and stamp a criterion the owner
 * explicitly refused to state as "traced to words you wrote" — a false-pass
 * shape inside the one module built to prevent them.
 *
 * THAT WIRING HAS SINCE LANDED, AND NOT WHERE THIS PARAGRAPH EXPECTED IT.
 * `ticket-refs.ts` was left alone; the composition is done at each call site
 * instead — `orchestrator.ts` reads `ticketProse(stripPlanBlock(brief))`, and
 * `classifySurface` gets the same treatment. MEASURED 2026-08-02 on the folded
 * brief of run `…052c6e02`: `ticketProse(stripPlanBlock(b))` and
 * `stripPlanBlock(ticketProse(b))` return the identical string, because
 * {@link foldPlanIntoBrief} appends and so the plan block is always last. So the
 * order of the two cuts is not load-bearing and neither one is the reason
 * `inferredCriteria` did not move — see {@link answeredInOwnerWords}, which is.
 * {@link planBlockIndex} remains exported for the earliest-of cut if the two
 * ever have to become one call.
 */

import type { PlanQuestionState, PlanState } from "./plan-state.js";
import type { AnsweredQuestion } from "./spec-assumptions.js";

/**
 * The marker that separates the owner's words from the planning exchange.
 *
 * GREPPABLE AND STABLE, exactly like `CAPTURE_BLOCK_BEGIN`, and for the same
 * reason: two other things depend on the exact string — {@link stripPlanBlock}
 * here, and `ticketProse` once it is wired.
 */
export const PLAN_BLOCK_BEGIN = "--- WHAT THE DASHBOARD ASKED BEFORE ANY CRITERIA WERE WRITTEN ---";
export const PLAN_BLOCK_END = "--- END OF THE PLANNING EXCHANGE ---";

/**
 * Fold the exchange into the brief.
 *
 * WITH NOTHING TO SAY THIS RETURNS THE BRIEF UNCHANGED — not an equal-looking
 * string, the same one. That property is what keeps the ticket id stable for the
 * ordinary case: a run whose plan seat asked nothing, or whose questions all
 * expired unanswered with nothing recorded, must derive the same id it would have
 * derived with no plan phase at all, or every suite already frozen on disk is
 * addressed by an id nothing will compute again. `composeBrief` makes the same
 * promise for a capture-less run and there is a test on it.
 *
 * WHAT COUNTS AS "NOTHING TO SAY": no question ever reached the owner and no
 * clarification happened. An EXPIRED question with an assumption DOES count as
 * something to say — the criteria author needs to know what the run is
 * proceeding on and that nobody stated it.
 */
export function foldPlanIntoBrief(brief: string, state: PlanState): string {
  if (state.questions.length === 0 && state.clarifications.length === 0) return brief;

  const lines: string[] = [
    PLAN_BLOCK_BEGIN,
    "",
    "Before the acceptance criteria for this run were written, the dashboard read the",
    "ticket and asked the owner the questions below. HIS ANSWERS ARE HIS OWN WORDS and",
    "are part of what he asked for. Where he left a question to the dashboard, or where",
    "the window closed before he answered, the assumption the run is proceeding on is",
    "stated instead — THOSE ARE THE DASHBOARD'S GUESSES AND NOT HIS, and a criterion",
    "resting on one is a guess however confidently it is written.",
    "",
  ];

  if (state.plan.length > 0) {
    lines.push(
      "WHAT THE DASHBOARD SAID IT WOULD BUILD (its own reading of the ticket, shown to the",
      "owner before he answered; not his words):",
      ...state.plan.map((line) => `  ${redactHostPaths(line)}`),
      "",
    );
  }

  for (const entry of state.questions) {
    lines.push(...questionLines(entry), "");
  }

  if (state.clarifications.length > 0) {
    lines.push("THE OWNER ALSO ASKED:", "");
    for (const exchange of state.clarifications) {
      const about = exchange.about.length === 0 ? "" : ` (about ${exchange.about.join(", ")})`;
      lines.push(
        `  he asked${about}: ${quote(exchange.asked)}`,
        `  the dashboard answered: ${quote(exchange.reply)}`,
        "",
      );
    }
  }

  if (state.closed !== null) {
    lines.push(`HOW THE EXCHANGE ENDED: ${state.closed.detail}.`, "");
  }

  lines.push(PLAN_BLOCK_END);
  return [brief, "", "", ...lines].join("\n");
}

/**
 * One question, in the state it ended in.
 *
 * THE LABELS ARE OWNER-FACING AND THE DISTINCTION IS LOAD-BEARING. `answered`
 * carries his sentence and may be traced to him. `declined` and `expired` carry
 * the same field — the question's own `ifUnanswered` — and both are labelled as
 * the dashboard's, so nothing downstream can read a declined question's default
 * as something he stated. That is what keeps "you decide without penalty" from
 * also being "you decide and the run reports you specified it".
 */
function questionLines(entry: PlanQuestionState): readonly string[] {
  const asked = `${entry.question.id} — asked: ${quote(entry.question.text)}`;
  switch (entry.status) {
    case "answered":
      return [
        `${asked} [ANSWERED BY THE OWNER]`,
        `  he answered: ${quote(entry.answer?.text ?? "")}`,
        ...(entry.answer?.paraphrased === true
          ? [`  (recorded from his message: ${quote(entry.answer.quoted)})`]
          : []),
      ];
    case "declined":
      return [
        `${asked} [LEFT TO THE DASHBOARD BY THE OWNER]`,
        `  the dashboard is assuming: ${quote(entry.assumed ?? entry.question.ifUnanswered)}`,
      ];
    case "expired":
      return [
        `${asked} [NEVER ANSWERED — the plan window closed]`,
        `  the dashboard is assuming: ${quote(entry.assumed ?? entry.question.ifUnanswered)}`,
      ];
    case "open":
      return [
        `${asked} [STILL OPEN WHEN THE BRIEF WAS AMENDED]`,
        `  the dashboard is assuming: ${quote(entry.question.ifUnanswered)}`,
      ];
  }
}

/**
 * The answered questions, with the owner's LITERAL reply on each.
 *
 * WHY THIS EXISTS BESIDE `plan-state.ts:answeredPairs`, WHICH LOOKS LIKE IT DOES
 * THE SAME JOB. That one maps `entry.answer.text`, and `text` is the RECORDED
 * wording, which is the seat's paraphrase whenever `paraphrased` is true —
 * `questionLines` above renders "(recorded from his message: …)" for precisely
 * that case. `spec-assumptions.ts` credits a criterion to the owner by finding
 * HIS words in it and then quoting the reply back to him to be checked; fed a
 * paraphrase, it would stamp a criterion as his on the strength of a sentence
 * the machine wrote and then invite him to check for words he never typed. That
 * is the module's own defect reproduced one level down, so the resolution
 * happens here, at the one place that already knows the two fields apart.
 *
 * A PARAPHRASED ANSWER IS NOT DROPPED — it falls back to `quoted`, the span of
 * his turn the paraphrase rests on. His words are still on record; only the
 * seat's tidying of them is discarded. An entry with neither (a button press
 * with no text, where `quoted` is `""`) yields nothing rather than an empty
 * answer: an empty answer would let the QUESTION carry a match on its own, which
 * is the one thing {@link AnsweredQuestion}'s rule refuses.
 *
 * DECLINED AND EXPIRED QUESTIONS NEVER APPEAR, same rule and same reason as
 * `answeredPairs`: what they record is the house's `ifUnanswered`, and crediting
 * that to him would make declining everything the cheapest route to a report
 * that says he specified it all.
 */
export function answeredInOwnerWords(state: PlanState): readonly AnsweredQuestion[] {
  const pairs: AnsweredQuestion[] = [];
  for (const entry of state.questions) {
    if (entry.status !== "answered" || entry.answer === null) continue;
    const own = entry.answer.paraphrased ? entry.answer.quoted : entry.answer.text;
    if (own.trim().length === 0) continue;
    pairs.push({ question: entry.question.text, answer: own });
  }
  return pairs;
}

/**
 * The owner's words, recovered from an amended brief.
 *
 * THE EXACT CUT `ticketProse` MUST LEARN. Kept here as a function so the round
 * trip — fold, then strip, then compare — is testable in this file, and so the
 * wiring agent has one expression to compose rather than a marker to re-derive.
 */
export function stripPlanBlock(brief: string): string {
  const index = planBlockIndex(brief);
  if (index < 0) return brief;
  return brief.slice(0, index).replace(/\n+$/, "");
}

/**
 * Where the planning block starts, or `-1`.
 *
 * FOR `ticketProse`'S EARLIEST-OF CUT. It must take the minimum of this and the
 * capture marker's index rather than the last of either: a run with a plan block
 * and no capture would otherwise keep the whole exchange in the prose region,
 * which is the hazard named in this file's header.
 *
 * `lastIndexOf` MATCHES THE SIBLING'S CHOICE. `ticket-refs.ts` uses it so that an
 * owner who types the marker into his own prose truncates his own brief rather
 * than shifting the machine's block; the same reasoning and the same harmless
 * spoof apply here.
 */
export function planBlockIndex(brief: string): number {
  return brief.lastIndexOf(`\n${PLAN_BLOCK_BEGIN}`);
}

/**
 * Absolute host paths and image filenames, removed.
 *
 * WHY IT IS HERE AT ALL. The planning seat is the FIRST seat allowed to look at
 * the owner's reference images, and it is shown them the way `owner-message.ts`
 * shows the builder chat images: absolute paths in the prompt with an explicit
 * instruction to read each one. A seat holding those paths can put one in a
 * question — "should the layout follow /Users/…/ref.png?" — and that question,
 * folded here, would carry a host path into the brief that the spec seat and the
 * builder both read. The guarantee this phase must keep is that the criteria
 * author never receives an image or a route to one; a path is a route.
 *
 * REDACTS RATHER THAN THROWS, which is where it differs from
 * `visual-substance.ts#assertNoScreenshotReference` (the same boundary argument,
 * the same deliberately broad match). That one guards a record being committed
 * and can afford to refuse. This one runs on the last step before the run
 * proceeds, and throwing would fail a run over a cosmetic leak in a sentence the
 * owner already answered.
 */
export function redactHostPaths(text: string): string {
  return text
    .replace(PATH_LIKE, (match) => {
      const punctuation = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
      const core = punctuation.length > 0 ? match.slice(0, -punctuation.length) : match;
      return isWebRoute(core) ? match : `[a file path was removed here]${punctuation}`;
    })
    .replace(/\b[\w.-]+\.(?:png|jpe?g|webp|gif|avif|pdf|docx?|rtf)\b/gi, "[a filename was removed here]");
}

/**
 * Anything that could be a path: `/x`, `~/x`, `./x`, `../x`.
 *
 * `(?:~|\.{1,2})?` RATHER THAN `[~.]?`, WHICH IS A FIX AND NOT A TIDY-UP. The
 * single-character class matched only ONE dot, so `../refs/hero.png` matched from
 * the second dot and the redaction left a stray `.` in front of the marker. The
 * path still went — this never leaked — but the sentence the owner read was
 * wrong, and a redaction that visibly mis-cuts invites someone to widen it.
 */
const PATH_LIKE = /(?:^|(?<=[\s"'(]))(?:~|\.{1,2})?\/[^\s"')]+/g;

/**
 * First segments that are filesystem roots whatever else they look like.
 *
 * `/tmp/reference-1` is lowercase, two segments and extension-free — the shape
 * {@link isWebRoute} otherwise keeps — and it is a host path. So the roots are
 * named rather than inferred.
 */
const FILESYSTEM_ROOTS = new Set([
  "users", "home", "var", "tmp", "etc", "opt", "private", "mnt", "root", "usr",
  "srv", "applications", "volumes", "dev", "proc", "sys", "library", "bin",
  "sbin", "media", "run", "node_modules",
]);

/** A route has at most this many segments. Chosen, not measured; see below. */
const MAX_ROUTE_SEGMENTS = 3;

/**
 * Is this the name of a PAGE on the site being built, rather than a file on this
 * machine?
 *
 * WHY THIS PREDICATE EXISTS, MEASURED. On run `…162b186d` the owner answered a
 * question about his own `/work` page and the brief the spec seat read said
 * "every project card on [a file path was removed here]". Route names are the
 * vocabulary of every web ticket this dashboard runs, and the plan phase exists
 * to turn the grader's guesses into the owner's own words — so deleting the nouns
 * from his answers defeats the phase precisely on the tickets it was built for.
 *
 * THE TWO MISTAKES DO NOT COST THE SAME, AND THE RULE LEANS ACCORDINGLY. An
 * over-redacted route costs one mangled sentence in a brief. An under-redacted
 * path hands the criteria author a route to an image it must never see, which is
 * the whole reason {@link redactHostPaths} exists. So every test below is a
 * conjunction and anything failing one of them is treated as a path:
 *
 *   · it must start with `/` — `~/x`, `./x` and `../x` are never pages;
 *   · at most {@link MAX_ROUTE_SEGMENTS} segments, because a brief naming a
 *     four-deep URL is rarer than a run whose workspace path is four deep;
 *   · every segment lowercase alphanumeric-or-dash, so a capitalised `/Users`
 *     and any segment carrying a file extension both fail;
 *   · the first segment is not a {@link FILESYSTEM_ROOTS} member.
 *
 * WHAT IT STILL LETS THROUGH, said plainly rather than discovered later: a host
 * path that is lowercase, at most three segments, extension-free and rooted
 * somewhere not on the list — `/srv2/app/x` — is kept. Widening the list is a
 * one-line change; widening the SHAPE would take the routes back out.
 */
function isWebRoute(token: string): boolean {
  if (!token.startsWith("/")) return false;
  const segments = token.slice(1).split("/");
  if (segments.length === 0 || segments.length > MAX_ROUTE_SEGMENTS) return false;
  if (FILESYSTEM_ROOTS.has((segments[0] ?? "").toLowerCase())) return false;
  return segments.every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment));
}

/** One line, quoted, with the newlines flattened so a block cannot be reshaped. */
function quote(text: string): string {
  const flat = redactHostPaths(text).replace(/\s+/g, " ").trim();
  return flat.length === 0 ? '""' : `"${flat}"`;
}
