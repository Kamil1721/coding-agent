/**
 * run-report.ts — the two files a run leaves behind for the person who was not
 * watching it.
 *
 * `assumptions.md` at spec-phase exit, `verdict.md` when the run reaches a
 * terminal state. Both land in `runs/<runId>/results/`, beside `run.json` and
 * the build log. This module owns the JOIN between the three Phase 2e modules
 * and the run's own persisted state; it renders nothing itself beyond the
 * no-verdict page below, and it decides no outcome — `verdict.ts` does the
 * arithmetic, `spec-assumptions.ts` does the tracing.
 *
 * THREE STATES, NOT TWO, AND THAT IS THE WHOLE DESIGN OF `renderRunVerdict`.
 * orchestrator.ts states the rule this file obeys: "a gate that cannot run must
 * never be indistinguishable from a gate that passed", which is why
 * `heldOutPass` is nullable and why `orchestrator.test.ts` says "cancelled is
 * not failed: no verdict was reached". A run can therefore end three ways, and
 * exactly one of them is a verdict:
 *
 *   the gate scored it        -> `renderVerdict` — PASSED / PASSED WITH NOTES /
 *                                DID NOT PASS, computed from criterion results
 *   cancelled                 -> the no-verdict page
 *   ended before the gate ran -> the no-verdict page, naming the reason
 *
 * The tempting third option — synthesise a BLOCKING finding so `computeOutcome`
 * returns "fail" — was rejected on purpose. It renders a cancelled run as DID
 * NOT PASS, which conflates "the gate said no" with "the gate never ran" in the
 * other direction, and it inflates the verdict's own inferred-criteria count by
 * one because the synthetic needs an assumption record to have any prose at all.
 *
 * ONE ENTRY POINT, `writeRunVerdict`, AND THE BRANCH IS INSIDE IT. If the
 * orchestrator picked the branch, the choice itself would be untested wiring and
 * whichever branch the wiring test does not reach would be dead in production
 * with a unit test standing over it. That is the shape of the defect this
 * project has already shipped twice.
 *
 * THE STORE IS THE SOURCE, AND THAT IS A BOUNDARY RATHER THAN A CONVENIENCE.
 * Everything here is built from `ApiCriterion` rows and the run row — both
 * already redacted on the way into SQLite. Three fields that CAN carry a
 * held-out test title are therefore structurally absent rather than merely
 * unused:
 *
 *   - `CriterionResult.detail` — the container's failure message, which quotes
 *     the assertion that produced it. The `criteria` table has a `detail`
 *     column; `listCriteria` does not select it, so it cannot arrive here.
 *   - `CriterionResult.evidenceRef` — a test reference by definition.
 *   - `AcceptanceCriterion.evidenceRequired` — contracts.ts documents its own
 *     example as "holdout test T-14 PASS AND db-query-7 count >= 1". It names
 *     held-out test ids BY CONTRACT. `ApiCriterion` has no such field, and the
 *     conversion below fills it with "" rather than passing anything through.
 *     THAT BLANK IS A TYPE-LEVEL INVARIANT, NOT A GUARD ANYTHING WATCHES:
 *     MEASURED 2026-07-29, passing the source criterion's `evidenceRequired`
 *     through instead of blanking it leaves every test in `run-report.test.ts`
 *     green, because there is no field on `ApiCriterion` for a value to arrive
 *     on. The narrowing that a mutation CAN break is one level up, in
 *     `Orchestrator.#recordCriteria`, which is where the frozen suite's criteria
 *     become these rows; breaking it there turns `run-report.test.ts` red.
 *
 * What survives into both files is the ticket, criterion ids, tiers and
 * statements — all of which the dashboard already serves to the UI on
 * `GET /api/runs/:id`. Held-out failures appear as counts by tier and as
 * nothing else, which is `verdict.ts`'s rule and not a new one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCriterion, CriterionResult } from "bakeoff/dist/contracts.js";
import type { ApiCriterion, ApiRunStatus } from "./api-types.js";
import { extractAssumptions, isGateAssumption, renderAssumptions } from "./spec-assumptions.js";
import type { Assumption } from "./spec-assumptions.js";
import { renderVerdict } from "./verdict.js";
import type { VerdictInput } from "./verdict.js";

/** Filenames, exported so tests and the API agree on one spelling. */
export const ASSUMPTIONS_FILE = "assumptions.md";
export const VERDICT_FILE = "verdict.md";

/**
 * How many criteria the owner did not state.
 *
 * ONE EXPRESSION, THREE CONSUMERS: this number, the sentence `verdict.ts`
 * renders ("N of M criteria were inferred rather than stated in your ticket"),
 * and `RunDetail.inferredCriteria`. The predicate is `source !== "ticket"`,
 * copied from `verdict.ts:renderAssumptionSummary` deliberately — a house
 * default is no more something the owner wrote than a guess is. Counting only
 * `source === "inferred"` here would put two different numbers under one name on
 * the API and in the file, and `run-report.test.ts` asserts the two agree by
 * reading the number back out of the rendered verdict.
 *
 * `assumptions.md` splits the same set further, into guesses and house
 * defaults. That is a finer breakdown of this number, not a competing one.
 *
 * TIER-0 GATES ARE EXCLUDED, and they must be excluded HERE AND IN THE PAGE
 * TOGETHER. A gate is not a criterion the owner did not state; it is not a
 * criterion about their ticket at all, and there were twelve of them in the 4B
 * run against ten authored requirements. Filtering them out of the verdict's
 * listing while leaving them in this number would make the page drop twelve
 * entries it had just claimed to have — the silent-drop defect, wearing an
 * accurate-looking count. `verdict.ts:renderAssumptionSummary` applies the same
 * `isGateAssumption` filter and `run-report.test.ts` reads the number back out
 * of the rendered page to prove they agree.
 */
export function countInferredAssumptions(assumptions: readonly Assumption[]): number {
  return assumptions.filter((entry) => !isGateAssumption(entry) && entry.source !== "ticket").length;
}

/**
 * `ApiCriterion` -> `AcceptanceCriterion`, with `evidenceRequired` blanked.
 *
 * The blank is the point and it is written out rather than defaulted: this is
 * the one field on the contract type documented to name held-out test ids, and
 * this conversion is the only place a value could enter these two files.
 */
function forAssumptions(criteria: readonly ApiCriterion[]): readonly AcceptanceCriterion[] {
  return criteria.map((criterion) => ({
    id: criterion.id,
    statement: criterion.statement,
    tier: criterion.tier,
    evidenceRequired: "",
  }));
}

export function assumptionsFor(
  ticketText: string,
  criteria: readonly ApiCriterion[],
): readonly Assumption[] {
  return extractAssumptions(ticketText, forAssumptions(criteria));
}

export interface AssumptionRecord {
  /** Absolute path to the file that was written. */
  readonly path: string;
  /** `countInferredAssumptions` over the record. Persisted onto the run row. */
  readonly inferredCriteria: number;
}

/**
 * Write `assumptions.md` and report what it says.
 *
 * Called at SPEC-PHASE EXIT, before a line of code is built, because that is
 * when the owner can still act on it: everything here is a sentence they can
 * add to the ticket, and correcting the ticket is cheaper than debugging the
 * verdict it produces.
 */
export function writeAssumptions(
  resultsDir: string,
  ticketText: string,
  criteria: readonly ApiCriterion[],
): AssumptionRecord {
  const assumptions = assumptionsFor(ticketText, criteria);
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, ASSUMPTIONS_FILE);
  writeFileSync(path, `${renderAssumptions(assumptions)}\n`, "utf8");
  return { path, inferredCriteria: countInferredAssumptions(assumptions) };
}

/* -------------------------------------------------------------------------
 * The verdict
 * ---------------------------------------------------------------------- */

/** Everything the verdict needs, and all of it already persisted and redacted. */
export interface RunVerdictSource {
  /** The owner's ticket, as stored. Their words are the point of the document. */
  readonly ticketText: string;
  /** The run's criteria and their results, from `RunStore.listCriteria`. */
  readonly criteria: readonly ApiCriterion[];
  /** The terminal status being recorded. */
  readonly status: ApiRunStatus;
  /** Redacted, with remediation where one exists. Null on a clean run. */
  readonly failureReason: string | null;
}

/** The first line of the no-verdict page. Asserted verbatim in the tests. */
export const NO_VERDICT_HEADING = "# NO VERDICT WAS REACHED";

/**
 * Did the sealed gate score this run?
 *
 * A criterion is written `pending` when the suite freezes and is overwritten
 * only by `setCriterionResult`, which runs once per `CriterionResult` the score
 * record carries. So one non-pending criterion means the container ran and
 * reported; all-pending means it did not. A run with no criteria at all — one
 * cancelled from the queue, or one whose spec phase never froze a suite — never
 * reached the gate either, and `some()` is false for an empty list, which is the
 * right answer rather than a lucky one.
 */
export function gateProducedResults(criteria: readonly ApiCriterion[]): boolean {
  return criteria.some((criterion) => criterion.result !== "pending");
}

/**
 * The verdict input, assembled from persisted state.
 *
 * `qualityFindings` IS EMPTY, AND NOT BECAUSE QUALITY IS UNIMPORTANT. Those are
 * authored notes about look and motion, and nothing in the dashboard pipeline
 * evaluates `visual-criteria.ts` yet: Phase 2b owns the `DesignManifest` and the
 * comparison against a locked mockup. Emitting the CRITERIA here as if they were
 * FINDINGS would report every run as `pass_with_notes` by declaring failures
 * nobody measured — the finding generator `grade-fixture.ts` explains at length.
 * QUALITY signal that does exist arrives as QUALITY-tier criterion results from
 * the gate, and `verdict.ts` already counts those.
 *
 * `heldOutUnmet` IS ZERO FOR THE SAME REASON CALIBRATION MEASURED: the criteria
 * list already carries one entry per held-out criterion — id, tier and the
 * authored statement, never a test title — so counting those failures again
 * here would double every number in the summary line.
 */
function verdictInputFor(source: RunVerdictSource): VerdictInput {
  const criteriaResults: readonly CriterionResult[] = source.criteria.map((criterion) => ({
    criterionId: criterion.id,
    tier: criterion.tier,
    passed: criterion.result === "pass",
    // Both null by construction, not by omission. See the file header.
    evidenceRef: null,
    detail: null,
  }));
  return {
    ticket: source.ticketText,
    criteriaResults,
    qualityFindings: [],
    assumptions: assumptionsFor(source.ticketText, source.criteria),
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
  };
}

function quoteBlock(text: string): string {
  const body = text.trim().length > 0 ? text.trim() : "(the ticket text was empty)";
  return body
    .split("\n")
    .map((line) => `> ${line.trim()}`)
    .join("\n");
}

/**
 * The page for a run that produced no verdict.
 *
 * It is not a verdict wearing a different hat: it carries no outcome, no
 * headline from `verdict.ts`'s `HEADLINE` map, and no criterion list. Its whole
 * job is to be impossible to read as a result in either direction, which is why
 * the second paragraph says so in the owner's terms rather than in the tier
 * vocabulary of the document it is standing in for.
 */
function renderNoVerdict(source: RunVerdictSource, why: string): string {
  const lines: string[] = [
    NO_VERDICT_HEADING,
    "",
    why,
    "",
    "Nothing here says this work is good and nothing here says it is broken. The",
    "sealed container never scored it, so there is no result to report either way —",
    "a gate that could not run is not a gate that said no.",
    "",
    "You asked for this:",
    "",
    quoteBlock(source.ticketText),
    "",
    "## What to do",
    "",
    "The workspace and the frozen acceptance suite are both intact. Starting the",
    "ticket again reuses the same sealed suite, so a second attempt is measured",
    "against the same yardstick as this one would have been. What this run assumed",
    `your ticket meant is recorded next to this file in ${ASSUMPTIONS_FILE}, and it is`,
    "worth reading first: correcting the TICKET is cheaper than re-running against",
    "the same guesses.",
    "",
  ];
  return lines.join("\n");
}

/**
 * The verdict page, or the page that says there is no verdict.
 *
 * THE BRANCH LIVES HERE and not at the call site, so that both arms are reached
 * through the same exported function the orchestrator calls. A caller that could
 * pick the arm would leave the choice itself untested.
 */
export function renderRunVerdict(source: RunVerdictSource): string {
  if (source.status === "cancelled") {
    return renderNoVerdict(source, "This run was cancelled before the sealed gate scored it.");
  }
  if (!gateProducedResults(source.criteria)) {
    const reason =
      source.failureReason === null
        ? "no reason was recorded, which is itself a defect worth reporting"
        : source.failureReason;
    return renderNoVerdict(
      source,
      `This run ended before the sealed gate produced a result: ${reason}`,
    );
  }
  return renderVerdict(verdictInputFor(source));
}

/**
 * Write `verdict.md` and return its path.
 *
 * Called once, when a run reaches a terminal status. `rate_limited` is NOT
 * terminal — the window drains and the run resumes — so a rate-limited run has
 * no verdict file until it finishes, which is the same rule that leaves its
 * `heldOutPass` null.
 */
export function writeRunVerdict(resultsDir: string, source: RunVerdictSource): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, VERDICT_FILE);
  writeFileSync(path, `${renderRunVerdict(source)}\n`, "utf8");
  return path;
}
