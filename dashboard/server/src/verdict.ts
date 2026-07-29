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
 * IT DOES NOT WRITE THE FILE. `renderVerdict` returns a string; the orchestrator
 * writes `runs/<runId>/results/verdict.md` at run end (Phase 2e Task 5). Keeping
 * the render pure is what lets the eight tests below run without a filesystem.
 */

import type { CriterionResult } from "bakeoff/dist/contracts.js";
import type { ApiCriterionTier } from "./api-types.js";
import type { Assumption } from "./spec-assumptions.js";

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
 * a missing or malformed entry is a real shape rather than a paranoid one. It
 * clamps DOWN to zero rather than up: an invented failure would fail a correct
 * artefact, and this file must never be the reason a run goes red.
 */
function heldOutCount(input: VerdictInput, tier: ApiCriterionTier): number {
  const raw = input.heldOutUnmet[tier];
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function unmetCriteria(input: VerdictInput, tier: ApiCriterionTier): readonly CriterionResult[] {
  return input.criteriaResults.filter((result) => !result.passed && result.tier === tier);
}

/**
 * Every finding at a tier, from all three sources that can produce one: an unmet
 * visible criterion, an unmet held-out test, and — at QUALITY only — an authored
 * note that no test could have expressed.
 */
function findingCount(input: VerdictInput, tier: ApiCriterionTier): number {
  const counted = unmetCriteria(input, tier).length + heldOutCount(input, tier);
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
  const provenance =
    assumption.source === "ticket"
      ? `FROM YOUR TICKET — ${oneLine(assumption.because)}`
      : assumption.source === "inferred"
        ? `INFERRED, not something you wrote — ${oneLine(assumption.because)}`
        : `A HOUSE DEFAULT, not something you wrote — ${oneLine(assumption.because)}`;
  return [`- ${prefix}${oneLine(assumption.statement)}`, `  - ${provenance}`];
}

function renderWhy(input: VerdictInput): readonly string[] {
  const named = [...unmetCriteria(input, "BLOCKING"), ...unmetCriteria(input, "FUNCTIONAL")];
  const lines = ["## Why it did not pass", ""];
  if (named.length === 0) {
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
  for (const result of unmetQuality) lines.push(...renderUnmetCriterion(input, result, "not met: "));
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
  const inferred = input.assumptions.filter((entry) => entry.source !== "ticket");
  const total = input.assumptions.length;
  if (inferred.length === 0) {
    lines.push(`All ${String(total)} criteria trace back to something you wrote.`, "");
    return lines;
  }
  lines.push(
    `${String(inferred.length)} of ${String(total)} criteria were inferred rather than stated in your ticket:`,
    "",
  );
  for (const entry of inferred) {
    lines.push(`- ${oneLine(entry.statement)}`, `  - ${oneLine(entry.because)}`);
  }
  lines.push("");
  return lines;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function summaryLine(input: VerdictInput, outcome: VerdictOutcome): string {
  const blocking = findingCount(input, "BLOCKING");
  const functional = findingCount(input, "FUNCTIONAL");
  const quality = findingCount(input, "QUALITY");
  if (outcome === "fail") {
    return `${plural(blocking + functional, "thing the ticket asked for is", "things the ticket asked for are")} not there — ${String(blocking)} BLOCKING, ${String(functional)} FUNCTIONAL.`;
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
  if (outcome === "fail") lines.push(...renderWhy(input));
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
