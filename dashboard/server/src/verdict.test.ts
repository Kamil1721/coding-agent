/**
 * verdict.test.ts — Phase 2e Task 3.
 *
 * WHAT THESE PROTECT. Two of them protect a boundary and three of them protect a
 * distinction, and the distinction is the fragile one.
 *
 * THE BOUNDARY: no held-out test title may appear in the rendered page. The
 * fixture below is built the way the leak would actually arrive — the titles are
 * planted in `CriterionResult.detail` and `CriterionResult.evidenceRef`, which
 * are the two fields the sealed container fills in and the two a naive renderer
 * would print for "actionability". `builders/types.ts` records the same leak in
 * the scorer's `criterionCoverage[].testRefs`. If someone renders `detail`
 * tomorrow, that test goes red for the right reason rather than the whole thing
 * looking fine because the input never carried a title in the first place.
 *
 * THE DISTINCTION: `pass_with_notes` must be EARNED by a QUALITY finding, not
 * inferred from the absence of blockers. Three negative controls hold it from
 * both sides — notes when a finding exists, a plain pass when none does, and a
 * FUNCTIONAL failure that a pile of QUALITY notes cannot rescue. Without the
 * middle one, `computeOutcome` can collapse to two values, and then calibration
 * cannot tell a functionally correct site with bespoke motion from one with a
 * stock hover fade while reporting green.
 *
 * ONE DEVIATION FROM THE PLAN'S TEST BODIES, and it is deliberate. The first
 * test was written as `indexOf("DID NOT PASS") < indexOf("Why")`. `indexOf`
 * returns -1 when absent, and -1 is less than every real index, so a renderer
 * that emits no headline at all passed it. The presence assertion in front of it
 * is what makes the ordering assertion mean anything.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CriterionResult } from "bakeoff/dist/contracts.js";
import type { ApiCriterionTier } from "./api-types.js";
import type { Assumption } from "./spec-assumptions.js";
import { computeOutcome, failingTier, renderVerdict } from "./verdict.js";
import type { VerdictInput } from "./verdict.js";

interface RunSpec {
  readonly ticket?: string;
  /** Unmet requirements with prose the owner would recognise. FUNCTIONAL by default. */
  readonly unmet?: readonly {
    readonly id: string;
    readonly statement: string;
    readonly tier?: ApiCriterionTier;
  }[];
  /** Counts of anonymous unmet criteria, by tier. */
  readonly blocking?: number;
  readonly functional?: number;
  readonly quality?: number;
  readonly qualityFindings?: readonly string[];
  readonly heldOutUnmet?: Readonly<Partial<Record<ApiCriterionTier, number>>>;
  /**
   * Held-out test titles, planted in the two fields the sealed container fills.
   * Nothing else in this file may carry one.
   */
  readonly leakedTitles?: readonly string[];
  /** Satisfied criteria that trace back to the ticket. */
  readonly passing?: number;
  /** Satisfied criteria the grader invented. The dangerous ones on a pass. */
  readonly inferred?: number;
}

function runWith(spec: RunSpec = {}): VerdictInput {
  const criteriaResults: CriterionResult[] = [];
  const assumptions: Assumption[] = [];

  const push = (
    id: string,
    tier: ApiCriterionTier,
    passed: boolean,
    statement: string,
    source: Assumption["source"],
    sealed: { readonly detail: string; readonly evidenceRef: string } | null = null,
  ): void => {
    criteriaResults.push({
      criterionId: id,
      tier,
      passed,
      evidenceRef: sealed === null ? null : sealed.evidenceRef,
      detail: sealed === null ? null : sealed.detail,
    });
    assumptions.push({
      id: `A-${id}`,
      criterionId: id,
      statement,
      source,
      because:
        source === "ticket"
          ? `you wrote: "${statement}"`
          : "nothing in the ticket says so; the house rule for portfolio sites adds it",
    });
  };

  for (const entry of spec.unmet ?? []) {
    push(entry.id, entry.tier ?? "FUNCTIONAL", false, entry.statement, "ticket");
  }
  for (let i = 0; i < (spec.blocking ?? 0); i += 1) {
    push(`C-B${String(i)}`, "BLOCKING", false, `the site builds and boots (${String(i)})`, "ticket");
  }
  for (let i = 0; i < (spec.functional ?? 0); i += 1) {
    push(`C-F${String(i)}`, "FUNCTIONAL", false, `a section the ticket asked for (${String(i)})`, "ticket");
  }
  for (let i = 0; i < (spec.quality ?? 0); i += 1) {
    push(`C-Q${String(i)}`, "QUALITY", false, `the motion is bespoke, not a stock fade (${String(i)})`, "ticket");
  }
  for (let i = 0; i < (spec.passing ?? 0); i += 1) {
    push(`C-P${String(i)}`, "FUNCTIONAL", true, `a requirement you wrote down (${String(i)})`, "ticket");
  }
  for (let i = 0; i < (spec.inferred ?? 0); i += 1) {
    push(`C-I${String(i)}`, "FUNCTIONAL", true, `a requirement the grader invented (${String(i)})`, "inferred");
  }
  const titles = spec.leakedTitles ?? [];
  if (titles.length > 0) {
    // How the leak actually arrives: a sealed-gate result whose failure detail
    // quotes the assertion that produced it, and whose evidenceRef IS a title.
    push("C-HELD", "BLOCKING", false, "the hero section is present", "ticket", {
      detail: `held-out assertions failed: ${titles.join(" | ")}`,
      evidenceRef: `T-14 ${titles.join(" ")}`,
    });
  }

  return {
    ticket: spec.ticket ?? "Build a portfolio site for Ada Lovelace.",
    criteriaResults,
    qualityFindings: spec.qualityFindings ?? [],
    assumptions,
    heldOutUnmet: {
      BLOCKING: spec.heldOutUnmet?.BLOCKING ?? 0,
      FUNCTIONAL: spec.heldOutUnmet?.FUNCTIONAL ?? 0,
      QUALITY: spec.heldOutUnmet?.QUALITY ?? 0,
    },
  };
}

function failingRun(): VerdictInput {
  return runWith({
    ticket: "Build a portfolio site with a contact form that emails me.",
    unmet: [{ id: "C-1", statement: "the contact form submits and shows confirmation" }],
  });
}

function passingRun(spec: { readonly inferred: number }): VerdictInput {
  return runWith({ passing: 2, inferred: spec.inferred });
}

test("the verdict leads with the answer, then the reason", () => {
  const md = renderVerdict(failingRun());
  // Presence first: `indexOf` returns -1 for an absent needle, and -1 is less
  // than every real index, so the ordering assertion alone cannot go red.
  assert.ok(md.includes("DID NOT PASS"), "the answer must be in the document at all");
  assert.ok(md.indexOf("DID NOT PASS") < md.indexOf("Why"), "answer first");
});

test("the verdict names the ticket requirement that went unmet, in the owner's words", () => {
  // Not "C-3 unmet" — the owner did not write C-3, they wrote a sentence.
  const md = renderVerdict(
    runWith({
      ticket: "the contact form must email me",
      unmet: [{ id: "C-3", statement: "the contact form submits and confirms" }],
    }),
  );
  assert.match(md, /contact form/);
});

test("the verdict NEVER contains a held-out test title", () => {
  const md = renderVerdict(
    runWith({
      heldOutUnmet: { BLOCKING: 1, FUNCTIONAL: 0, QUALITY: 0 },
      leakedTitles: ["renders the hero heading"],
    }),
  );
  assert.doesNotMatch(md, /renders the hero heading/);
  assert.match(md, /1 BLOCKING/);
});

test("a QUALITY-only failure is reported as PASSED WITH NOTES, not FAILED", () => {
  // QUALITY never blocks. Rendering it as a failure would train the owner to
  // ignore red, which is worse than not reporting it.
  const md = renderVerdict(runWith({ blocking: 0, functional: 0, quality: 3 }));
  assert.match(md, /PASSED WITH NOTES/);
  assert.doesNotMatch(md, /^#.*FAILED/m);
});

test("assumptions are surfaced in the verdict when the run passed", () => {
  // A pass against inferred criteria is the dangerous case — the owner must see
  // WHAT it passed against, not just that it passed.
  const md = renderVerdict(passingRun({ inferred: 4 }));
  assert.match(md, /4 .*inferred/i);
});

// NEGATIVE CONTROLS (Revision 2, R3). The three-way outcome must be earned in
// both directions, or `pass_with_notes` is decoration.
test("QUALITY findings with no blockers give PASS_WITH_NOTES, not PASS", () => {
  assert.equal(computeOutcome(runWith({ blocking: 0, functional: 0, quality: 1 })), "pass_with_notes");
});

test("no findings at all give PASS, not PASS_WITH_NOTES", () => {
  assert.equal(computeOutcome(runWith({ blocking: 0, functional: 0, quality: 0 })), "pass");
});

test("a QUALITY finding never rescues a FUNCTIONAL failure into notes", () => {
  assert.equal(computeOutcome(runWith({ blocking: 0, functional: 1, quality: 5 })), "fail");
});

// ADDITIVE to the plan's eight, for the export the plan's own consumer needs:
// calibration must assert the outcome AND THE FAILING TIER without parsing
// markdown, and `fixtures.ts` says why — asserting the tier "stops a grader
// passing calibration by failing everything for the wrong reason". An export
// with no test is the thing this phase keeps finding.
test("failingTier reports the STRICTEST tier carrying a finding, and null only on a clean pass", () => {
  assert.equal(failingTier(runWith({ blocking: 1, functional: 1, quality: 1 })), "BLOCKING");
  assert.equal(failingTier(runWith({ functional: 1, quality: 1 })), "FUNCTIONAL");
  // pass_with_notes is not tier-less: a note IS a finding, and calibration
  // asserts QUALITY here for the stock-motion fixture.
  assert.equal(failingTier(runWith({ quality: 1 })), "QUALITY");
  assert.equal(failingTier(runWith({ passing: 2 })), null);
});
