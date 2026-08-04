/**
 * verdict.ts — the one page the owner reads when they were not watching.
 *
 * WHY THIS EXISTS. Everything upstream of here produces a boolean and a pile of
 * JSON. `heldOutPass` is correct and it is unreadable: an owner who comes back
 * to a red badge has to reconstruct the reason from a run log, a score record
 * and a container's stdout tail. That reconstruction is the most expensive
 * minute in the loop and it happens on every failing unattended run. This module
 * turns the machine's answer into a page a human can act on in ten seconds: the
 * answer, then what they asked for that is not there, in the words they used.
 *
 * IT DECIDES NOTHING THE GATE ALREADY DECIDED. `computeOutcome` is arithmetic
 * over criterion results that were produced elsewhere — it never inspects an
 * artefact, never calls a model, and cannot flip a tier. It exists as a separate
 * export from `renderVerdict` for one reason: calibration must be able to assert
 * the outcome and the failing tier without parsing markdown. A calibration that
 * greps a rendered document is testing the document, not the arithmetic.
 *
 * THE TIER RULE, AND IT IS THE WHOLE OF IT:
 *
 *   any unmet BLOCKING or FUNCTIONAL   -> "fail"
 *   otherwise, >= 1 QUALITY finding    -> "pass_with_notes"
 *   otherwise                          -> "pass"
 *
 * `pass_with_notes` IS EARNED, NEVER INFERRED FROM ABSENCE. It requires a
 * QUALITY finding that actually exists. Deriving it from "nothing blocked" would
 * make a functionally correct site with bespoke motion indistinguishable from
 * one with a stock hover fade — which is precisely the discrimination the
 * QUALITY tier was added to make. Calibration would stay green with the entire
 * visual-criteria path dead.
 *
 * QUALITY IS REPORTED AND NEVER BLOCKS. Owner decision, 2026-07-28. A QUALITY-only
 * result renders as PASSED WITH NOTES, never as a failure. Rendering subjective
 * judgement in red trains the owner to ignore red, and an ignored red badge is
 * worse than an unreported note.
 *
 * ONE RULE GOVERNS WHAT MAY APPEAR IN THE RENDERED PAGE, and it is a boundary,
 * not a style preference:
 *
 *   Fields authored BEFORE the build render verbatim — the ticket, criterion
 *   statements carried by the assumption record, the reasons behind them, and
 *   the authored QUALITY findings.
 *   Fields produced BY the sealed container never render at all — `detail` and
 *   `evidenceRef` on a `CriterionResult`. `evidenceRef` is a test reference and
 *   `detail` is a failure message quoting the assertion that produced it, so
 *   both can carry HELD-OUT TEST TITLES. `builders/types.ts` records the same
 *   leak in the scorer's own `criterionCoverage[].testRefs`, and Phase 0 sealed
 *   the scorer output against the builder for exactly this reason. A verdict
 *   file sits in `results/`, which is served to the UI; printing `detail` there
 *   would walk the held-out half back out through the front door.
 *
 * Held-out failures therefore appear as COUNTS BY TIER ("1 BLOCKING") and as
 * nothing else. That is not a limitation to be worked around later; it is the
 * boundary working.
 *
 * WHY THE OWNER-FACING PROSE COMES FROM THE ASSUMPTION RECORD. `CriterionResult`
 * carries an id, a tier and a pass flag — nothing a human can read. The prose
 * lives on `Assumption.statement`, and `spec-assumptions.ts` guarantees every
 * criterion has a record ("silence is the failure mode"). That guarantee is what
 * makes this join total. Where it is not, this module says so out loud rather
 * than dropping the requirement, because an unmet requirement that renders as
 * nothing is the same false pass in a smaller font.
 *
 * A VISUAL OBSERVATION IS A FOURTH SOURCE OF A FINDING, AND IT IS NOT A
 * REQUIREMENT. `visual-substance.ts` enumerates three OBJECTIVE observations that
 * may reach FUNCTIONAL — "the capture shows a page with nothing in it" and two
 * that are shadow-locked. Until 2026-07-30 `findingCount` summed exactly
 * `unmetCriteria + unmetGatesAt + heldOutCount`, so there was no arithmetic a
 * visual finding could enter: the module's `"gating"` mode was a LABEL, and a run
 * started in it printed GATING and behaved identically to shadow. That is worse
 * than shadow, because shadow's own report says plainly that nothing in it can
 * fail the run.
 *
 * IT IS COUNTED SEPARATELY FROM "things you asked for", for the same reason a
 * tier-0 gate is. Nobody wrote a ticket asking that the page not be blank; the
 * observation is ticket-INDEPENDENT, which is the only argument for having it at
 * all. Filing it under the owner's requirements is what let a machine id turn up
 * in a list of sentences they wrote (backlog #36), and `summaryLine` subtracts it
 * from the requirement counts for exactly that reason.
 *
 * THIS MODULE RE-FILTERS ON `gating` RATHER THAN TRUSTING THE CALLER.
 * `visual-substance.ts` exports both `record.violations` and `verdictFindings`,
 * and says in its own header that "passing violations straight through is how a
 * shadow gate becomes a live one by accident". A caller that reaches for the
 * wrong one must not be able to turn a shadow run red from here, so
 * {@link visualFindingsAt} counts only rows whose `gating` flag is true AND whose
 * verdict is `violated`. Two modules asserting the same invariant is the point:
 * one of them is the one that will be edited.
 *
 * IT DOES NOT WRITE THE FILE. `renderVerdict` returns a string; the orchestrator
 * writes `runs/<runId>/results/verdict.md` at run end (Phase 2e Task 5). Keeping
 * the render pure is what lets its tests run without touching a filesystem.
 */

import type { CriterionResult } from "bakeoff/dist/contracts.js";
// VALUE imports. The gate id list is a public constant of the scorer protocol,
// not something the sealed container produced, and importing it as a type would
// erase at runtime — leaving the ordering below silently matching nothing.
import { ALL_GATE_IDS, GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import type { ApiCriterionTier } from "./api-types.js";
import {
  gateLabel,
  isGateAssumption,
  isGateCriterionId,
  isQualityRollupId,
  isStatedByOwner,
} from "./spec-assumptions.js";
import type { Assumption } from "./spec-assumptions.js";
// The REAL type rather than a local restatement: a second declaration of the
// shape is a second thing to keep in step, and the field this module reads —
// `gating` — is exactly the one a restatement would be tempted to drop.
import type { VisualObservationOutcome } from "./visual-substance.js";
// VALUE import: the owner-facing sentence comes from a constant table, never from
// the grader's note. See `visualObservationLabel`'s own doc comment.
import { visualObservationLabel } from "./visual-substance.js";

export type VerdictOutcome = "pass" | "fail" | "pass_with_notes";

export interface VerdictInput {
  /** The owner's ticket, verbatim. Their words are the point of this document. */
  readonly ticket: string;
  /** Criterion-level results from the sealed gate. Ids and tiers only, here. */
  readonly criteriaResults: readonly CriterionResult[];
  /**
   * QUALITY notes authored before the build (`visual-criteria.ts`). Rendered
   * verbatim: nothing from the container went into them.
   */
  readonly qualityFindings: readonly string[];
  /** One per criterion. The only place criterion prose survives to here. */
  readonly assumptions: readonly Assumption[];
  /**
   * Unmet HELD-OUT tests, counted by tier. Counts, never titles — this shape is
   * the boundary, expressed as a type.
   */
  readonly heldOutUnmet: Readonly<Record<ApiCriterionTier, number>>;
  /**
   * Objective visual observations that FIRED and that this run allows to count —
   * `verdictFindings(record)` from `visual-substance.ts`.
   *
   * OPTIONAL, AND ABSENT MEANS ABSENT RATHER THAN CLEAN. A run with no visual
   * evaluation contributes zero findings here, which is correct: `undefined` is
   * not "the screenshots were fine", it is "no observation was scored". The
   * distinction lives on the visual record's own `mode` field, which states
   * whether the run was shadow or gating, so a silent shadow run cannot be read
   * as a gating run that found nothing.
   *
   * IT IS OPTIONAL FOR A SECOND, BLUNTER REASON: every existing caller
   * (`run-report.ts`, `calibration/grade-fixture.ts`) predates it, and a required
   * field would have made this wiring a change to files it does not own.
   */
  readonly visualFindings?: readonly VisualObservationOutcome[];
}

/** Strictest first. Order is load-bearing: `failingTier` walks it in this order. */
const TIERS: readonly ApiCriterionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];

const HEADLINE: Readonly<Record<VerdictOutcome, string>> = {
  fail: "DID NOT PASS",
  pass_with_notes: "PASSED WITH NOTES",
  pass: "PASSED",
};

/**
 * The count of held-out failures at a tier, clamped to a sane integer.
 *
 * This record crosses a JSON boundary on its way here from the score record, so
 * a missing or malformed entry is a real shape rather than a paranoid one.
 *
 * ANY POSITIVE VALUE COUNTS AS AT LEAST ONE FAILURE. A plain `Math.floor` would
 * turn a 0.4 into a clean pass, and the two failure directions are not
 * symmetric: a false fail announces itself and burns a fix round, a false pass
 * is trusted and compounds. So a malformed positive rounds UP to one, and only
 * a non-positive or non-finite value rounds to zero — no reachable input turns a
 * recorded held-out failure into green.
 */
function heldOutCount(input: VerdictInput, tier: ApiCriterionTier): number {
  const raw = input.heldOutUnmet[tier];
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1, Math.floor(raw));
}

/**
 * Unmet criteria at a tier, GATES EXCLUDED.
 *
 * "Things the ticket asked for" is the only list this feeds, and a tier-0 gate
 * was never asked for by anybody. See {@link unmetGates}.
 */
function unmetCriteria(input: VerdictInput, tier: ApiCriterionTier): readonly CriterionResult[] {
  return input.criteriaResults.filter(
    (result) => !result.passed && result.tier === tier && !isGateCriterionId(result.criterionId),
  );
}

/**
 * Did a NAMED requirement fail — one the owner can read in the section above?
 *
 * BLOCKING and FUNCTIONAL only, and the narrowing is deliberate. See
 * {@link unmetGates}: `scorer-protocol.ts` already exempts QUALITY-only test
 * failures from `GATE:suite-green`, so a suite-green failure standing beside
 * nothing but QUALITY criterion failures was caused by something the criteria do
 * NOT name — an untagged test, a non-zero exit, an unparseable report. Counting
 * QUALITY as "already named" there would suppress the only record that the suite
 * went red and turn a `fail` into `pass_with_notes`.
 */
function hasNamedGatingFailure(input: VerdictInput): boolean {
  return unmetCriteria(input, "BLOCKING").length + unmetCriteria(input, "FUNCTIONAL").length > 0;
}

/**
 * The tier-0 gates that failed, in protocol order, with the roll-up de-duplicated.
 *
 * WHY `GATE:suite-green` IS TREATED DIFFERENTLY FROM EVERY OTHER GATE. It is not
 * an independent check. `scorer-protocol.ts` documents it as the catch-all that
 * fires "when any test failed" — it exists so that a frozen test carrying no
 * criterion tag still gates something. So whenever a criterion failure has
 * already been named, suite-green is THE SAME FACT counted a second time, and
 * counted at a stricter tier than the failure it rolls up. MEASURED, 4B run
 * 2026-07-29: `cal4b-correct-portfolio` opened "3 things the ticket asked for
 * are not there — 1 BLOCKING, 2 FUNCTIONAL" where the 1 BLOCKING WAS the 2
 * FUNCTIONAL; `failingTier` therefore returned BLOCKING for all seven fixtures
 * and discriminated nothing (backlog #32).
 *
 * IT IS SUPPRESSED, NEVER DELETED. When the suite went red and no criterion was
 * attributed, suite-green is the only thing that knows, and it must still say
 * so — a roll-up that can only ever be silent is a check that can only observe
 * success. `verdict.test.ts` holds both directions.
 */
function unmetGates(input: VerdictInput): readonly CriterionResult[] {
  const failed = input.criteriaResults.filter(
    (result) => !result.passed && isGateCriterionId(result.criterionId),
  );
  const kept = hasNamedGatingFailure(input)
    ? failed.filter((result) => result.criterionId !== GATE_IDS.suiteGreen)
    : failed;
  // Protocol order, not score-record order: the page must read the same way
  // twice. An id the constant does not know goes last rather than vanishing.
  return [...kept].sort((a, b) => gateRank(a.criterionId) - gateRank(b.criterionId));
}

function gateRank(id: string): number {
  const index = ALL_GATE_IDS.indexOf(id);
  return index === -1 ? ALL_GATE_IDS.length : index;
}

function unmetGatesAt(input: VerdictInput, tier: ApiCriterionTier): number {
  return unmetGates(input).filter((result) => result.tier === tier).length;
}

/**
 * Visual observations that fired, are allowed to count on this run, and declare
 * this tier.
 *
 * THREE CONDITIONS, ALL RE-CHECKED HERE. `verdict === "violated"` because a row
 * downgraded by its corroboration rule is `unknown` and must not count;
 * `gating === true` because a shadow row and a shadow-locked row both carry
 * `gating: false` and either one reaching this arithmetic is the accident the
 * visual module's header names; `declaredTier === tier` because a finding must
 * land where it says it lands rather than wherever it was passed.
 */
function visualFindingsAt(input: VerdictInput, tier: ApiCriterionTier): number {
  return (input.visualFindings ?? []).filter(
    (finding) => finding.verdict === "violated" && finding.gating && finding.declaredTier === tier,
  ).length;
}

/**
 * Every finding at a tier, from all five sources that can produce one: an unmet
 * visible criterion, a failed tier-0 gate, an unmet held-out test, an objective
 * visual observation that fired, and — at QUALITY only — an authored note that no
 * test could have expressed.
 */
function findingCount(input: VerdictInput, tier: ApiCriterionTier): number {
  const counted =
    unmetCriteria(input, tier).length +
    unmetGatesAt(input, tier) +
    heldOutCount(input, tier) +
    visualFindingsAt(input, tier);
  return tier === "QUALITY" ? counted + input.qualityFindings.length : counted;
}

/**
 * The answer. Read the tier rule in the file header before changing this: the
 * three branches are not symmetric and the middle one is the fragile one.
 */
export function computeOutcome(input: VerdictInput): VerdictOutcome {
  if (findingCount(input, "BLOCKING") > 0 || findingCount(input, "FUNCTIONAL") > 0) return "fail";
  if (findingCount(input, "QUALITY") > 0) return "pass_with_notes";
  return "pass";
}

/**
 * The strictest tier carrying a finding, or null when the run was clean.
 *
 * Exported so calibration can assert WHY a fixture failed, not merely that it
 * did. `fixtures.ts` states the reason: asserting the tier "stops a grader
 * passing calibration by failing everything for the wrong reason" — a
 * reward-hacked artefact that fails on missing content instead of on the exploit
 * gate is a dead exploit path wearing a green calibration.
 *
 * It returns "QUALITY" on `pass_with_notes` — a note is a finding, and a
 * calibration asserting `pass_with_notes` with a null tier would be asserting a
 * pass wearing a label.
 */
export function failingTier(input: VerdictInput): ApiCriterionTier | null {
  return TIERS.find((tier) => findingCount(input, tier) > 0) ?? null;
}

/** Collapse to one line so a multi-line statement cannot break the list it sits in. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quoteBlock(text: string): string {
  const body = text.trim().length > 0 ? text.trim() : "(the ticket text was empty)";
  return body
    .split("\n")
    .map((line) => `> ${line.trim()}`)
    .join("\n");
}

function assumptionFor(input: VerdictInput, criterionId: string): Assumption | null {
  return input.assumptions.find((entry) => entry.criterionId === criterionId) ?? null;
}

/**
 * One unmet requirement, in the owner's words, with its provenance.
 *
 * The provenance line is the actionable half. "You asked for this and it is not
 * there" and "I made this up and it is not there" call for opposite responses —
 * fix the code, or fix the ticket — and only the second one is cheap.
 */
function renderUnmetCriterion(
  input: VerdictInput,
  result: CriterionResult,
  prefix = "",
): readonly string[] {
  const assumption = assumptionFor(input, result.criterionId);
  if (assumption === null) {
    // Task 1 guarantees a record per criterion. If that guarantee ever breaks,
    // the requirement is still reported — loudly, and as a grader defect.
    return [
      `- ${prefix}${result.criterionId} — NO STATEMENT WAS RECORDED for this criterion.`,
      "  The assumption record is incomplete, which is a grader defect: report it.",
    ];
  }
  // The tags are uppercase and the reason follows them, because the reason is
  // written by another module and may start with anything.
  //
  // A SWITCH AND NOT A TERNARY CHAIN, AS OF THE FOURTH SOURCE. The chain this
  // replaces ended in an `else` reading "A HOUSE DEFAULT, not something you
  // wrote", so `answered` — a criterion the owner settled in his own words —
  // would have been announced to him as a house default he never stated. An
  // exhaustive switch over the union makes the next source added upstream a
  // COMPILE error here instead of a false sentence on his page.
  //
  // THE FIFTH SOURCE ARRIVED THAT WAY, and this is the branch it needed. A
  // criterion carrying a duration read off a page the owner linked is neither
  // his sentence nor the grader's guess, and there is no default branch here to
  // absorb it quietly — the compile error is what routed it to its own line.
  const provenance = ((): string => {
    switch (assumption.source) {
      case "ticket":
        return `FROM YOUR TICKET — ${oneLine(assumption.because)}`;
      case "answered":
        return `YOU ANSWERED THIS when the dashboard asked — ${oneLine(assumption.because)}`;
      case "reference":
        return `READ FROM THE PAGE YOU REFERENCED — ${oneLine(assumption.because)}`;
      case "inferred":
        return `INFERRED, not something you wrote — ${oneLine(assumption.because)}`;
      case "default":
        return `A HOUSE DEFAULT, not something you wrote — ${oneLine(assumption.because)}`;
    }
  })();
  return [`- ${prefix}${oneLine(assumption.statement)}`, `  - ${provenance}`];
}

/**
 * The heading the gates render under. Exported so a test can assert WHERE a
 * gate line sits rather than merely that the page contains it somewhere.
 */
export const GATE_SECTION_HEADING = "Checks every artefact must clear";

/**
 * The tier-0 gates that failed, as fixed sentences.
 *
 * SEPARATE FROM "things you asked for", because it is not one. A container gate
 * is a fact about whether the artefact could be evaluated at all, and filing it
 * under the owner's requirements is what let a machine id turn up in a list of
 * sentences they wrote. The label comes from `spec-assumptions.ts`'s constant
 * table — never from the assumption record, which is where the fabricated
 * "INFERRED, not something you wrote" came from, and never from `detail`, which
 * is written by the container and can quote a held-out test title.
 */
function renderGates(input: VerdictInput): readonly string[] {
  const failed = unmetGates(input);
  if (failed.length === 0) return [];
  const lines = [
    `## ${GATE_SECTION_HEADING}`,
    "",
    "These are not things you asked for. They run on every artefact whatever the",
    "ticket says, and there is nothing to correct in your ticket here:",
    "",
  ];
  for (const result of failed) {
    lines.push(`- ${gateLabel(result.criterionId)} (${result.criterionId})`);
  }
  lines.push("");
  return lines;
}

/**
 * The heading the visual observations render under. Exported so a test can assert
 * WHERE the line sits rather than merely that the page contains it somewhere.
 */
export const VISUAL_SECTION_HEADING = "What the screenshots show";

/**
 * Objective visual observations that failed this run.
 *
 * SEPARATE FROM BOTH LISTS ABOVE. It is not a thing the owner asked for — no
 * ticket says "the page should not be blank" — and it is not a tier-0 container
 * gate either. It is a fixed observation about the delivered page, so it gets its
 * own heading and its own sentence, and `summaryLine` counts it separately.
 *
 * THE SENTENCE COMES FROM THE CONSTANT TABLE AND THE MACHINE ID COMES ALONG IN
 * BRACKETS. `outcome.note` is written during the run and is deliberately NOT
 * rendered here, for the same reason `detail` is not: a verdict file sits in
 * `results/`, which is served to the UI.
 */
function renderVisualObservations(input: VerdictInput): readonly string[] {
  const fired = (input.visualFindings ?? []).filter(
    (finding) => finding.verdict === "violated" && finding.gating,
  );
  if (fired.length === 0) return [];
  const lines = [
    `## ${VISUAL_SECTION_HEADING}`,
    "",
    "These are not things you asked for. They are fixed observations about the",
    "delivered page that run whatever the ticket says:",
    "",
  ];
  for (const finding of fired) {
    lines.push(
      `- ${visualObservationLabel(finding.observationId)} (${finding.observationId}, ` +
        `seen at ${finding.frame.flowId} / ${finding.frame.breakpoint})`,
    );
  }
  lines.push("");
  return lines;
}

function renderWhy(input: VerdictInput): readonly string[] {
  const named = [...unmetCriteria(input, "BLOCKING"), ...unmetCriteria(input, "FUNCTIONAL")];
  const lines = ["## Why it did not pass", ""];
  if (named.length === 0) {
    // A failed gate IS the reason, and it has already been stated above in its
    // own words. Repeating the grader-defect paragraph there would report a
    // working grader as broken on every build failure. THE SAME APPLIES TO A
    // VISUAL OBSERVATION: it is a recorded reason, printed under its own heading
    // immediately above, so a run failed by one alone must not be described as
    // "failed without a recorded reason, which is a grader defect".
    if (unmetGates(input).length > 0 || visualFindingsAt(input, "BLOCKING") + visualFindingsAt(input, "FUNCTIONAL") > 0) {
      return [];
    }
    lines.push(
      "No requirement could be named. The failure is in the held-out counts below;",
      "if that section is empty too, the run was failed without a recorded reason,",
      "which is a grader defect rather than a verdict.",
      "",
    );
    return lines;
  }
  lines.push("These are the things you asked for that are not there:", "");
  for (const result of named) lines.push(...renderUnmetCriterion(input, result));
  lines.push("");
  return lines;
}

/**
 * Held-out failures, as counts.
 *
 * The explanation is rendered next to the numbers on purpose. An owner who does
 * not know why the titles are missing reads this section as the tool being
 * unhelpful and goes looking for the titles — which is the behaviour the sealed
 * store exists to prevent.
 */
function renderHeldOut(input: VerdictInput): readonly string[] {
  const counted = TIERS.map((tier) => ({ tier, count: heldOutCount(input, tier) })).filter(
    (entry) => entry.count > 0,
  );
  if (counted.length === 0) return [];
  const lines = [
    "## Held-out checks that did not pass",
    "",
    "The acceptance suite is held out from the builder, so its test titles are not",
    "shown here or anywhere outside the sealed store. The counts are:",
    "",
  ];
  for (const entry of counted) lines.push(`- ${String(entry.count)} ${entry.tier}`);
  lines.push("");
  return lines;
}

function renderNotes(input: VerdictInput): readonly string[] {
  const unmetQuality = unmetCriteria(input, "QUALITY");
  const heldOutQuality = heldOutCount(input, "QUALITY");
  if (input.qualityFindings.length === 0 && unmetQuality.length === 0 && heldOutQuality === 0) {
    return [];
  }
  const lines = [
    "## Notes on quality",
    "",
    "These did not fail the run and were never going to. They are judgement, and",
    "judgement reports rather than blocks.",
    "",
  ];
  for (const finding of input.qualityFindings) lines.push(`- ${oneLine(finding)}`);
  // Criterion statements are written as the satisfied case ("the motion is
  // bespoke"), so an unmet one needs the negation said out loud or it reads as
  // praise sitting in a list of complaints.
  //
  // A HOST ROLL-UP IS THE EXCEPTION, and it gets no prefix. `QUALITY:*` ids carry
  // no authored prose at all: their sentence comes from `spec-assumptions.ts`'s
  // constant table and is written in the OBSERVED voice, because an observation
  // that did not fire produces no criterion to render. "not met: the page
  // renders in the browser's default serif font" negates a sentence that is
  // already negative and tells the owner the opposite of what happened.
  for (const result of unmetQuality) {
    lines.push(
      ...renderUnmetCriterion(input, result, isQualityRollupId(result.criterionId) ? "" : "not met: "),
    );
  }
  if (heldOutQuality > 0) lines.push(`- ${String(heldOutQuality)} QUALITY (held out, counted only)`);
  lines.push("");
  return lines;
}

/**
 * What the grader believed. This is the section that matters most on a PASS.
 *
 * A pass against criteria the owner never saw is a false pass wearing a green
 * badge, and the only person who can tell is the one who wrote the ticket. So
 * the inferred count leads, and the inferred statements are listed.
 */
function renderAssumptionSummary(input: VerdictInput): readonly string[] {
  const lines = ["## What this run assumed", ""];
  if (input.assumptions.length === 0) {
    lines.push(
      "No assumption record was produced for this run, so there is no way to tell",
      "what the grader believed your ticket meant. Treat the result above as",
      "unverified.",
      "",
    );
    return lines;
  }
  // GATES ARE NOT ASSUMPTIONS ABOUT THE TICKET, so they are not counted as such
  // and not listed as such — 12 of the 22 entries here were `GATE:*` lines in the
  // 4B run, and a review document that is mostly boilerplate stops being read.
  // The number is still stated: dropping twelve entries the page had just
  // claimed to have would be its own defect. `run-report.ts` counts the same set
  // for `RunDetail.inferredCriteria`, and its tests assert the two agree.
  const ticketScoped = input.assumptions.filter((entry) => !isGateAssumption(entry));
  const gateCount = input.assumptions.length - ticketScoped.length;
  const gateNote =
    gateCount === 0
      ? []
      : [
          `Plus ${plural(gateCount, "fixed check that runs", "fixed checks that run")} on every artefact ` +
            "whatever the ticket says — the build, the boot, the routes, the exploit scan.",
          "Those are not guesses about your ticket and there is nothing in them to correct.",
          "",
        ];
  // `isStatedByOwner`, NOT `source !== "ticket"`. The predicate lives in
  // `spec-assumptions.ts` and is shared with `run-report.ts:countInferred-
  // Assumptions` because it now has two true cases: a criterion the owner
  // ANSWERED is as much his as one he typed, and a local copy of the old test
  // would both inflate this count past `RunDetail.inferredCriteria` — which
  // `run-report.test.ts` asserts against — and list his own reply under a
  // heading saying he never stated it.
  const inferred = ticketScoped.filter((entry) => !isStatedByOwner(entry));
  const total = ticketScoped.length;
  if (inferred.length === 0) {
    lines.push(`All ${String(total)} criteria trace back to something you wrote.`, "", ...gateNote);
    return lines;
  }
  lines.push(
    `${String(inferred.length)} of ${String(total)} criteria were inferred rather than stated in your ticket:`,
    "",
  );
  for (const entry of inferred) {
    lines.push(`- ${oneLine(entry.statement)}`, `  - ${oneLine(entry.because)}`);
  }
  lines.push("", ...gateNote);
  return lines;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * The one line an owner reads before deciding whether to open the run.
 *
 * IT SEPARATES THE TWO KINDS OF FAILURE, because they call for opposite next
 * moves. "The projects section is missing" is a fix to the work; "the project
 * does not build" is a fix to the ground the work stands on. Before this split
 * the line read "3 things the ticket asked for are not there — 1 BLOCKING, 2
 * FUNCTIONAL" for a correct portfolio whose only real defect was two FUNCTIONAL
 * criteria, and the same shape of sentence for a blank page (backlog #36).
 *
 * The gate clause makes NO claim about what was or was not measured. A failed
 * `GATE:screenshots-present` does not mean the artefact went unevaluated, so the
 * line says what failed and stops there.
 */
function summaryLine(input: VerdictInput, outcome: VerdictOutcome): string {
  const gates = unmetGates(input).length;
  // A VISUAL OBSERVATION IS SUBTRACTED FROM EVERY REQUIREMENT COUNT. Nobody wrote
  // a ticket asking that the page not be blank, and "2 things the ticket asked for
  // are not there" for a run whose only extra finding is a screenshot observation
  // is backlog #36's defect with a new source feeding it. The QUALITY subtraction
  // is defensive rather than reachable: `declaredTier` is the literal
  // "FUNCTIONAL", so a QUALITY visual finding cannot exist today — and if that
  // literal is ever widened, this line keeps the note count honest instead of
  // silently inflating it.
  const visual = visualFindingsAt(input, "BLOCKING") + visualFindingsAt(input, "FUNCTIONAL");
  const blocking =
    findingCount(input, "BLOCKING") - unmetGatesAt(input, "BLOCKING") - visualFindingsAt(input, "BLOCKING");
  const functional =
    findingCount(input, "FUNCTIONAL") - unmetGatesAt(input, "FUNCTIONAL") - visualFindingsAt(input, "FUNCTIONAL");
  const quality =
    findingCount(input, "QUALITY") - unmetGatesAt(input, "QUALITY") - visualFindingsAt(input, "QUALITY");
  if (outcome === "fail") {
    const gateClause = `${plural(gates, "check every artefact must clear did", "checks every artefact must clear did")} not pass.`;
    const visualClause = `${plural(visual, "fixed observation about the screenshots did", "fixed observations about the screenshots did")} not pass.`;
    if (blocking + functional === 0) {
      // WHICH CLAUSES ARE PRESENT IS DECIDED BY WHAT ACTUALLY FIRED. Before the
      // visual source existed this branch could only be reached with gates > 0;
      // it is now reachable with gates === 0, and printing "0 checks every
      // artefact must clear did not pass" is the kind of sentence that makes an
      // owner distrust the whole page.
      const reasons = [gates === 0 ? null : gateClause, visual === 0 ? null : visualClause].filter(
        (clause): clause is string => clause !== null,
      );
      const stated = reasons.length === 0 ? "" : `${reasons.join(" ")} `;
      return `${stated}No requirement from your ticket was reported as missing.`;
    }
    const asked = `${plural(blocking + functional, "thing the ticket asked for is", "things the ticket asked for are")} not there — ${String(blocking)} BLOCKING, ${String(functional)} FUNCTIONAL.`;
    return [asked, gates === 0 ? null : gateClause, visual === 0 ? null : visualClause]
      .filter((clause): clause is string => clause !== null)
      .join(" ");
  }
  if (outcome === "pass_with_notes") {
    return `Everything the ticket asked for is there. ${plural(quality, "note", "notes")} on quality, which do not fail the run.`;
  }
  return "Everything the ticket asked for is there, and nothing was noted against it.";
}

/**
 * The page.
 *
 * The heading comes from `computeOutcome` and from nowhere else — a renderer
 * with its own opinion about what failed is a second grader, and the two would
 * drift the first time either changed.
 */
export function renderVerdict(input: VerdictInput): string {
  const outcome = computeOutcome(input);
  const lines: string[] = [
    `# ${HEADLINE[outcome]}`,
    "",
    summaryLine(input, outcome),
    "",
    "You asked for this:",
    "",
    quoteBlock(input.ticket),
    "",
  ];
  // GATES FIRST on a failing run. When the container stopped the artefact, that
  // is the fact the owner has to act on before any requirement in the list below
  // means anything.
  // GATES FIRST, THEN THE SCREENSHOT OBSERVATIONS, THEN THE REQUIREMENTS. Both
  // of the first two are facts about the delivered artefact that the owner has to
  // act on before any requirement below means anything, and neither is a sentence
  // they wrote.
  if (outcome === "fail") {
    lines.push(...renderGates(input), ...renderVisualObservations(input), ...renderWhy(input));
  }
  lines.push(...renderHeldOut(input));
  lines.push(...renderNotes(input));
  lines.push(...renderAssumptionSummary(input));
  lines.push(
    "## If this verdict is wrong",
    "",
    "Correcting the TICKET is cheaper than debugging the verdict. Anything listed",
    "as inferred above is a sentence you can write yourself, and the next run will",
    "grade against your words instead of the grader's guess. Known grader",
    "limitations are recorded in dashboard/STATUS.md.",
    "",
  );
  return lines.join("\n");
}
