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
import { GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import type { ApiCriterionTier } from "./api-types.js";
import type { Assumption } from "./spec-assumptions.js";
import { GATE_SECTION_HEADING, computeOutcome, failingTier, renderVerdict } from "./verdict.js";
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
  /**
   * Tier-0 gate ids that FAILED, fed in with the exact fabricated provenance the
   * live 4B run produced: statement = the bare id, source = `inferred`. That is
   * not a straw man — it is what `dashboard/results/calibration-4b/.../
   * cal4b-correct-portfolio.verdict.md` printed on 2026-07-29, because the
   * token-overlap tracer was pointed at the string "GATE:suite-green" and found
   * no overlap. A renderer that reads the assumption record for a gate will
   * reproduce it, and these tests say so.
   */
  readonly unmetGates?: readonly string[];
  /** Tier-0 gate ids that PASSED. Present so the gate section can be shown to discriminate. */
  readonly metGates?: readonly string[];
  /** An unmet criterion the grader genuinely inferred. The positive control for gate provenance. */
  readonly unmetInferred?: readonly { readonly id: string; readonly statement: string }[];
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
  for (const entry of spec.unmetInferred ?? []) {
    push(entry.id, "FUNCTIONAL", false, entry.statement, "inferred");
  }
  // Every tier-0 gate is BLOCKING; scorer-protocol.ts section 2 says so.
  for (const id of spec.unmetGates ?? []) push(id, "BLOCKING", false, id, "inferred");
  for (const id of spec.metGates ?? []) push(id, "BLOCKING", true, id, "inferred");
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

// ADDITIVE. `runWith` records an assumption for every criterion it creates —
// which is what Task 1 guarantees — so the fallback branch that fires when that
// guarantee breaks was, until this test, code that would first run in front of
// the owner on a failing run. An unmet requirement that renders as nothing is a
// false pass in a smaller font.
test("an unmet criterion with no assumption record is still reported, as a grader defect", () => {
  const base = runWith({ unmet: [{ id: "C-3", statement: "the contact form confirms" }] });
  const md = renderVerdict({ ...base, assumptions: [] });
  assert.match(md, /C-3/, "the requirement must survive even with no prose for it");
  assert.match(md, /NO STATEMENT WAS RECORDED/);
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

/* -------------------------------------------------------------------------
 * TIER-0 GATES. Measured defect, `cal4b-correct-portfolio.verdict.md`,
 * 2026-07-29: the page opened "3 things the ticket asked for are not there —
 * 1 BLOCKING, 2 FUNCTIONAL" and the first entry was the literal string
 * `GATE:suite-green`, annotated "INFERRED, not something you wrote — the grader
 * added this". Three defects in one bullet: a machine id where a sentence
 * belongs, fabricated provenance on a fixed infrastructure check, and a roll-up
 * of the two FUNCTIONAL failures listed under it counted a second time at a
 * stricter tier.
 * ---------------------------------------------------------------------- */

/** The body of one `## ` section, so a claim about WHERE a line sits can be made. */
function sectionBody(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `the page has no "## ${heading}" section:\n${markdown}`);
  const rest = markdown.slice(start);
  // From index 1, so the section's own heading cannot terminate it.
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

test("a failing tier-0 gate renders as a sentence the owner can read, never as a bare id", () => {
  const md = renderVerdict(runWith({ unmetGates: [GATE_IDS.build] }));
  assert.match(md, /does not build/i, "the gate must be stated in owner-facing English");
  assert.doesNotMatch(
    md,
    /^- GATE:build\s*$/m,
    "a bare machine id is what shipped on 2026-07-29; the owner reads a requirement list and finds a symbol",
  );
});

test("a gate is never given fabricated provenance, while a real inference keeps its own", () => {
  // POSITIVE AND NEGATIVE IN ONE FIXTURE. An absence assertion alone passes if
  // the renderer simply stops emitting the INFERRED prose for everyone, so the
  // genuinely inferred criterion below must still carry it on the same page.
  const md = renderVerdict(
    runWith({
      unmetGates: [GATE_IDS.build],
      unmetInferred: [{ id: "REQ-009", statement: "the site exposes an RSS feed" }],
    }),
  );
  assert.match(
    md,
    /INFERRED, not something you wrote/,
    "the genuinely inferred requirement must still be labelled — otherwise this test proves nothing",
  );
  assert.doesNotMatch(
    sectionBody(md, GATE_SECTION_HEADING),
    /INFERRED|the grader added this|grader's guess/,
    "a tier-0 gate is a fixed check, not a guess about what the ticket implied",
  );
});

test("gates sit in their own section, not among the things the ticket asked for", () => {
  const md = renderVerdict(
    runWith({
      unmetGates: [GATE_IDS.build],
      unmet: [{ id: "REQ-005", statement: "the projects section lists three entries" }],
    }),
  );
  const asked = sectionBody(md, "Why it did not pass");
  assert.match(asked, /projects section/, "the ticket requirement belongs here");
  assert.doesNotMatch(asked, /GATE:|does not build/i, "a container gate is not a thing the owner asked for");
  assert.match(sectionBody(md, GATE_SECTION_HEADING), /does not build/i);
});

test("GATE:suite-green adds no finding when the failures it rolls up are already named", () => {
  // The roll-up fails whenever ANY frozen test fails, so on a run with named
  // criterion failures the "1 BLOCKING" IS the FUNCTIONAL failures counted again
  // at a stricter tier. That is backlog #32: `failingTier` returned BLOCKING for
  // every fixture and discriminated nothing.
  const input = runWith({
    unmetGates: [GATE_IDS.suiteGreen],
    unmet: [
      { id: "REQ-005", statement: "the projects section lists three entries" },
      { id: "REQ-006", statement: "the contact form confirms on submit" },
    ],
  });
  assert.equal(computeOutcome(input), "fail", "suppressing the roll-up must never turn a red run green");
  assert.equal(failingTier(input), "FUNCTIONAL", "the strictest REAL finding is FUNCTIONAL");
  const md = renderVerdict(input);
  assert.doesNotMatch(md, /suite-green/, "the roll-up must not be listed beside the failures it rolls up");
  assert.match(md, /2 things the ticket asked for are not there/, "counted once, not twice");
});

test("GATE:suite-green STILL reports when it is the only failure — the suite went red and nothing else said so", () => {
  // THE NEGATIVE CONTROL FOR THE TEST ABOVE. Unconditional suppression would
  // build a check that can only observe success: a frozen suite that went red
  // with no criterion attributed would render as a clean pass.
  const input = runWith({ unmetGates: [GATE_IDS.suiteGreen], passing: 3 });
  assert.equal(computeOutcome(input), "fail");
  assert.equal(failingTier(input), "BLOCKING");
  const md = renderVerdict(input);
  assert.match(md, /acceptance suite/i, "the one thing that failed must be named");
  assert.match(md, /DID NOT PASS/);
});

test("GATE:suite-green is NOT suppressed by QUALITY-only criterion failures", () => {
  // DELIBERATE NARROWING. `scorer-protocol.ts` already exempts QUALITY-only test
  // failures from this gate, so a suite-green failure standing beside nothing but
  // QUALITY failures came from something else — an untagged test, a non-zero
  // exit, an unparseable report. Suppressing it there would flip `fail` to
  // `pass_with_notes` and lose the only record that the suite went red.
  const input = runWith({ unmetGates: [GATE_IDS.suiteGreen], quality: 2 });
  assert.equal(computeOutcome(input), "fail", "QUALITY findings cannot absorb a red suite");
  assert.equal(failingTier(input), "BLOCKING");
});

test("QUALITY still never gates once gates are counted separately", () => {
  // The standing owner decision, re-asserted against the new counting path: a
  // run whose only findings are QUALITY, with every gate green, is notes.
  const input = runWith({ metGates: [GATE_IDS.build, GATE_IDS.suiteGreen], quality: 2 });
  assert.equal(computeOutcome(input), "pass_with_notes");
  assert.equal(failingTier(input), "QUALITY");
});

test("failingTier discriminates a gate failure from a ticket failure", () => {
  // Requirement 6, and the reason the tier existed at all: a fixture stopped by
  // the container and a fixture missing a section must not report the same tier
  // for the same reason.
  const gateOnly = runWith({ unmetGates: [GATE_IDS.build], passing: 3 });
  const criterionOnly = runWith({
    unmet: [{ id: "REQ-005", statement: "the projects section lists three entries" }],
    passing: 3,
  });
  assert.equal(failingTier(gateOnly), "BLOCKING");
  assert.equal(failingTier(criterionOnly), "FUNCTIONAL");
  assert.notEqual(
    failingTier(gateOnly),
    failingTier(criterionOnly),
    "before this change both were BLOCKING, because GATE:suite-green fired on everything",
  );
});

test("gate ids are kept out of the assumption roll-call, and the count says how many there were", () => {
  // 12 of the 22 entries under "What this run assumed" were `GATE:*` lines on
  // 2026-07-29, which is how a review document stops being read. Dropping them
  // silently would be its own defect, so the number is still stated.
  const md = renderVerdict(
    runWith({
      metGates: [GATE_IDS.build, GATE_IDS.typecheck, GATE_IDS.lint],
      inferred: 2,
      passing: 1,
    }),
  );
  const assumed = sectionBody(md, "What this run assumed");
  assert.doesNotMatch(assumed, /GATE:/, "a fixed check is not an assumption about the ticket");
  assert.match(assumed, /2 of 3 criteria were inferred/, "the ticket-scoped arithmetic must exclude gates");
  assert.match(assumed, /3 fixed checks/, "and must still account for the gates it left out");
});
