/**
 * run-report.ts — the three files a run leaves behind for the person who was not
 * watching it.
 *
 * `assumptions.md` at spec-phase exit, `verdict.md` when the run reaches a
 * terminal state, and `spend.md` beside it. All three land in
 * `runs/<runId>/results/`, beside `run.json` and the build log. This module owns
 * the JOIN between the three Phase 2e modules and the run's own persisted state;
 * it renders nothing itself beyond the no-verdict page and the spend page below,
 * and it decides no outcome — `verdict.ts` does the arithmetic,
 * `spec-assumptions.ts` does the tracing, and `tokens.ts#runSpend` does the
 * per-vendor addition.
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
import type {
  ApiCriterion,
  ApiMeteredSpend,
  ApiRunSpend,
  ApiRunStatus,
  ApiSeatSpend,
  ApiTokens,
  ApiVendorSpend,
} from "./api-types.js";
import {
  extractAssumptions,
  isGateAssumption,
  isStatedByOwner,
  renderAssumptions,
} from "./spec-assumptions.js";
import type { AnsweredQuestion, Assumption, ReferenceReading } from "./spec-assumptions.js";
import { renderVerdict } from "./verdict.js";
import type { VerdictInput } from "./verdict.js";

/** Filenames, exported so tests and the API agree on one spelling. */
export const ASSUMPTIONS_FILE = "assumptions.md";
export const VERDICT_FILE = "verdict.md";
export const SPEND_FILE = "spend.md";

/**
 * How many criteria the owner did not state.
 *
 * ONE EXPRESSION, THREE CONSUMERS: this number, the sentence `verdict.ts`
 * renders ("N of M criteria were inferred rather than stated in your ticket"),
 * and `RunDetail.inferredCriteria`. The predicate is
 * `spec-assumptions.ts:isStatedByOwner`, negated — a house default is no more
 * something the owner wrote than a guess is. Counting only `source ===
 * "inferred"` here would put two different numbers under one name on the API and
 * in the file, and `run-report.test.ts` asserts the two agree by reading the
 * number back out of the rendered verdict.
 *
 * IT IS NOW IMPORTED RATHER THAN COPIED, AND THAT MATTERS AS OF THE PLAN PHASE.
 * This docblock used to say the predicate was "copied from
 * `verdict.ts:renderAssumptionSummary` deliberately", and two copies were
 * survivable while there was one owner-stated source. With `answered` there are
 * two, and a copy left behind would have this count call a criterion inferred
 * while the page beside it lists the owner's own reply — the disagreement the
 * paragraph above forbids, arriving through the fix for something else.
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
  return assumptions.filter((entry) => !isGateAssumption(entry) && !isStatedByOwner(entry)).length;
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

/**
 * `answered` DEFAULTS TO EMPTY — the same control as on `extractAssumptions`.
 * A run with no plan phase, and every caller written before there was one,
 * produces the byte-identical record it produced yesterday. `reference` defaults
 * to `null` on the identical argument: a run with no motion reference — which is
 * every run before 2026-08-04 — is unmoved by this parameter existing.
 */
export function assumptionsFor(
  ticketText: string,
  criteria: readonly ApiCriterion[],
  answered: readonly AnsweredQuestion[] = [],
  reference: ReferenceReading | null = null,
): readonly Assumption[] {
  return extractAssumptions(ticketText, forAssumptions(criteria), answered, reference);
}

export interface AssumptionRecord {
  /** Absolute path to the file that was written. */
  readonly path: string;
  /** `countInferredAssumptions` over the record. Persisted onto the run row. */
  readonly inferredCriteria: number;
  /**
   * How many criteria were traced to an answer the owner gave.
   *
   * REPORTED SEPARATELY FROM THE COUNT ABOVE BECAUSE IT IS THE ONE NUMBER THAT
   * SAYS WHETHER ASKING HIM WAS WORTH HIS TIME. `inferredCriteria` falling could
   * mean the plan phase worked or that the ticket was better written this time;
   * this cannot mean anything else. It is not persisted on the run row — it is
   * for the run log, where a zero beside a non-zero question count is the seat
   * asking questions nothing downstream used.
   */
  readonly answeredCriteria: number;
}

/**
 * Write `assumptions.md` and report what it says.
 *
 * Called at SPEC-PHASE EXIT, before a line of code is built, because that is
 * when the owner can still act on it: everything here is a sentence they can
 * add to the ticket, and correcting the ticket is cheaper than debugging the
 * verdict it produces.
 *
 * `answered` IS THE PLAN PHASE'S EXCHANGE and it is a separate parameter rather
 * than something folded into `ticketText` on purpose: the folded brief carries
 * DECLINED questions too, and a declined question's wording in the traced text
 * would manufacture overlap and credit the owner with a requirement he refused
 * to state. The caller passes what he actually answered, in his own words.
 *
 * `reference` IS BESIDE THE PROSE FOR THE MIRROR-IMAGE REASON. The motion block
 * IS in the composed brief, and `ticketProse` cuts it back off before this
 * function is ever reached — deliberately, since `classifySurface` reads the
 * same brief and a captured vocabulary there would pick the delegation lane. So
 * the reading has to arrive as its own argument or the fifth source is set by
 * nothing, which is exactly what it was for a day.
 */
export function writeAssumptions(
  resultsDir: string,
  ticketText: string,
  criteria: readonly ApiCriterion[],
  answered: readonly AnsweredQuestion[] = [],
  reference: ReferenceReading | null = null,
): AssumptionRecord {
  const assumptions = assumptionsFor(ticketText, criteria, answered, reference);
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, ASSUMPTIONS_FILE);
  writeFileSync(path, `${renderAssumptions(assumptions)}\n`, "utf8");
  return {
    path,
    inferredCriteria: countInferredAssumptions(assumptions),
    answeredCriteria: assumptions.filter((entry) => entry.source === "answered").length,
  };
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
 * THE FOOTER EVERY TERMINAL RUN CARRIES, and the one claim it makes.
 *
 * `verdict.md` IS THE PAGE THE OWNER OPENS, and until this footer nothing they
 * opened contradicted the two zeros sitting beside it: `costUsd: null` on the API
 * and a literal `totalCostUsd: 0` in `run.json`. Both are correct — a
 * subscription seat has no per-token price — and both are read as "this run was
 * free" at the end of a long build. So the sentence is written here, on the one
 * page a run always leaves behind.
 *
 * IT NAMES NO FILE AND NO NUMBER, DELIBERATELY. Pointing at `spend.md` would be a
 * path to a file that may not exist — the same lie as reporting `heldOutPass:
 * false` for a gate that never ran — because `writeRunSpend` has no caller yet
 * (see the spend section below). And it carries no figure of its own: the seat
 * totals live in the spend record, and a second source for them here is a second
 * number to go stale. What it states is true today and stays true after the
 * recorder is wired.
 *
 * NO HEADING, NO `$`, AND NONE OF THE VERDICT VOCABULARY. `PASSED`, `PASSED WITH
 * NOTES` and `DID NOT PASS` are asserted ABSENT on the no-verdict page by three
 * `doesNotMatch` checks in run-report.test.ts, and a footer that used any of those
 * words — or opened a heading a headline regex could match — would turn the
 * cancelled-run tests red for a reason that has nothing to do with cancelling.
 */
export const PRICING_FOOTER = [
  "---",
  "",
  "WHAT THIS RUN COST IS NOT ZERO, AND IT IS NOT ON THIS PAGE. A subscription seat",
  "consumes quota and is not billed per token, so no dollar figure exists for this",
  "run: the API reports `costUsd: null` and the run record carries `totalCostUsd: 0`.",
  "Both of those mean THERE IS NO PRICE FOR THIS. Neither of them means the run was",
  "free — it spent tokens on every seat it used, the spec and audit seats among them,",
  "and the run's own log names each seat and what it spent.",
].join("\n");

/**
 * The verdict page, or the page that says there is no verdict.
 *
 * THE BRANCH LIVES HERE and not at the call site, so that both arms are reached
 * through the same exported function the orchestrator calls. A caller that could
 * pick the arm would leave the choice itself untested.
 *
 * AND THE FOOTER IS APPENDED ONCE, OUTSIDE THE BRANCH, for the same reason the
 * branch is inside this function: three return statements each carrying their own
 * copy is three places for one of them to be dropped, and the arm that lost it
 * would be the arm no test happened to read.
 */
export function renderRunVerdict(source: RunVerdictSource): string {
  return `${verdictPageFor(source)}\n${PRICING_FOOTER}\n`;
}

function verdictPageFor(source: RunVerdictSource): string {
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

/* -------------------------------------------------------------------------
 * spend.md — what the run cost, in the units it was actually spent in
 *
 * THE DEFECT, MEASURED. One live run spent 525,471 output tokens across four
 * seats and reported 88,529 — the builder's — because that was the only figure
 * anything accumulated. The other 436,942 went to a log line and nowhere else.
 * This page is the record: every seat, one total per vendor, and the metered
 * image/video calls in calls and seconds.
 *
 * AND IT SAYS, IN THE OWNER'S WORDS, WHY THERE IS NO DOLLAR FIGURE. `costUsd:
 * null` on the API and `totalCostUsd: 0` in `run.json` are both correct and both
 * get read as "this run was free" at the end of a long build. A number is not
 * invented to fix that — api-types.ts's header forbids it, and a made-up rate is
 * a fabricated bill. The sentence is written out instead.
 * ---------------------------------------------------------------------- */

/** The first line of the spend page. Asserted verbatim in the tests. */
export const SPEND_HEADING = "# WHAT THIS RUN SPENT";

/**
 * The sentence that has to survive every future edit to this page.
 *
 * It is a CONSTANT rather than prose in the template because it is the one claim
 * this file exists to make, and a test that greps the rendered page for it would
 * otherwise be matching a string someone can reword into "no cost recorded".
 */
export const NOT_PRICED_SENTENCE =
  "NOT PRICED IS NOT THE SAME AS FREE. This run ran on subscription seats: quota is consumed, " +
  "not billed per token. The API reports `costUsd: null` and `run.json` carries `totalCostUsd: 0` " +
  "— both mean THERE IS NO PRICE FOR THIS, never that the run cost nothing. What it spent is " +
  "below, in tokens, calls and seconds.";

/**
 * Thousands separators, done here rather than by `toLocaleString`.
 *
 * `toLocaleString` reads the host's locale, so the same run would render
 * `525,471` on one machine and `525.471` on another, and a test asserting either
 * one would be asserting the test runner's environment. This is deterministic.
 */
export function groupDigits(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** The four counts, output first: it is the one the reader came for. */
function spendCounts(tokens: ApiTokens): string {
  return (
    `${groupDigits(tokens.outputTokens)} output, ${groupDigits(tokens.inputTokens)} input, ` +
    `${groupDigits(tokens.cacheReadTokens)} cache read, ${groupDigits(tokens.cacheWriteTokens)} cache write`
  );
}

/**
 * A seat's share of ITS OWN VENDOR's output, or null when there is none to take.
 *
 * WITHIN ONE VENDOR, DELIBERATELY. A share of "the run's tokens" would need a
 * cross-vendor denominator, which is the quantity tokens.ts refuses to produce;
 * this divides Anthropic by Anthropic. Null when the vendor's output is 0 —
 * `0/0` renders as `NaN%` and a share of nothing is not 0%.
 */
function shareOfVendorOutput(seat: ApiSeatSpend, vendors: readonly ApiVendorSpend[]): string | null {
  const vendor = vendors.find((row) => row.provider === seat.provider);
  if (vendor === undefined || vendor.tokens.outputTokens === 0) return null;
  const share = (seat.tokens.outputTokens / vendor.tokens.outputTokens) * 100;
  return `${share.toFixed(1)}% of ${seat.provider}'s output`;
}

function meteredLine(row: ApiMeteredSpend): string {
  const unit =
    row.deliveredSecondsFloor === null
      ? "not billed by time"
      : `at least ${groupDigits(row.deliveredSecondsFloor)}s delivered (A FLOOR: a leg that was ` +
        "generated and billed and then failed its download counts as zero here)";
  return `- ${row.kind} (${row.model}): ${groupDigits(row.calls)} call(s) attempted, ${unit}`;
}

/**
 * The spend page.
 *
 * AN EMPTY RECORD IS SAID OUT LOUD RATHER THAN RENDERED AS ZEROS, and that is the
 * same refusal `heldOutPass: null` makes one field over: a run that recorded no
 * seats is not a run that spent nothing. A page of `0 output, 0 input` for a run
 * whose spec seat burned 416,111 tokens before the recorder was wired up would be
 * a worse lie than the one this file exists to fix, because it would look
 * measured.
 */
export function renderRunSpend(spend: ApiRunSpend): string {
  const lines: string[] = [SPEND_HEADING, "", NOT_PRICED_SENTENCE, ""];

  lines.push("## Per vendor — this is the run's total", "");
  if (spend.byVendor.length === 0) {
    lines.push(
      "NOTHING WAS RECORDED for this run, and that is not a measurement of zero. Every seat writes",
      "its own row as it finishes, so an empty record means no seat reported: a run cancelled out of",
      "the queue, a run that never reached the spec phase, or a server that is not calling",
      "`recordSeatSpend`. Read the run's log stream for the seat lines before concluding anything",
      "about what this run spent.",
      "",
    );
  } else {
    lines.push(
      "Token counts are per vendor and are never summed across vendors — tokenizers differ, so one",
      "number spanning two of them is not a quantity. Each line below is a total.",
      "",
    );
    for (const vendor of spend.byVendor) {
      lines.push(
        `- ${vendor.provider}: ${spendCounts(vendor.tokens)}, over ` +
          `${groupDigits(vendor.callCount)} call(s), from ${String(vendor.seats.length)} seat(s) — ` +
          vendor.seats.join(", "),
      );
    }
    lines.push("");
  }

  if (spend.bySeat.length > 0) {
    lines.push("## Per seat — where it actually went", "");
    for (const seat of spend.bySeat) {
      const share = shareOfVendorOutput(seat, spend.byVendor);
      lines.push(
        `- ${seat.seat} (${seat.provider}, ${seat.modelId}): ${spendCounts(seat.tokens)}, over ` +
          `${groupDigits(seat.callCount)} call(s)${share === null ? "" : ` — ${share}`}`,
      );
    }
    lines.push("");
  }

  lines.push("## Metered image and video — counted, never priced", "");
  if (spend.metered.length === 0) {
    lines.push("No metered image or video call was recorded for this run.", "");
  } else {
    lines.push(
      "These are billed against a metered key, per call or per second of output. This program has no",
      "price table for them and does not invent one: the counts below are what it actually knows.",
      "",
    );
    for (const row of spend.metered) lines.push(meteredLine(row));
    lines.push("");
  }

  lines.push(
    "## What this page cannot tell you",
    "",
    "Which model inside a seat did the work. A seat's row carries the model it was CONFIGURED with,",
    "and delegation is the architecture here: an orchestrator on one model hands work to subagents on",
    "another, and three quarters of a measured build ran on a model the run never named. The run's log",
    "stream names the split per call; this page carries each seat's TOTAL, which is the number that",
    `must never come out smaller than what was spent. The pricing basis is \`${spend.pricing}\`.`,
    "",
  );
  return lines.join("\n");
}

/** Write `spend.md` and return its path. */
export function writeRunSpend(resultsDir: string, spend: ApiRunSpend): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, SPEND_FILE);
  writeFileSync(path, `${renderRunSpend(spend)}\n`, "utf8");
  return path;
}
