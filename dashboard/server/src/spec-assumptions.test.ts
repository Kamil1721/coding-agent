/**
 * spec-assumptions.test.ts — can this module be wrong in the direction that hurts?
 *
 * The first three tests here would all pass against a stub that returned every
 * criterion marked `ticket` with a canned reason. That stub is the exact defect
 * this module exists to prevent — it would report "the grader assumed nothing,
 * everything came from you" about a run that inferred a dozen requirements. So
 * the load-bearing test is the negative control at the bottom, and the two after
 * it, which pin down the two labels a stub cannot produce.
 *
 * WHAT MAKES EACH TEST ABLE TO GO RED, stated because a check that cannot fail
 * is not a check:
 *   - `ticket` case: fails if the tracer stops matching, or if `because` stops
 *     quoting the owner's own sentence.
 *   - `inferred` case: fails if a criterion with no support is called supported.
 *   - accounting: fails if any criterion is dropped from the record — silence is
 *     the failure mode, since an unrecorded inference is an invisible one.
 *   - render order: fails if the inferences stop leading the document.
 *   - negative control: fails if overlap is counted over stopwords or over the
 *     domain boilerplate ("build", "site") that every ticket contains.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AcceptanceCriterion } from "bakeoff/dist/contracts.js";
// A VALUE import, deliberately. A `import type` here would erase at runtime and
// the drift test below would then compare the label table against nothing —
// a check that can only observe success, which is the defect this repo ships.
import { ALL_GATE_IDS, GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import {
  GATE_LABELS,
  extractAssumptions,
  gateLabel,
  isQualityRollupId,
  qualityRollupLabel,
  renderAssumptions,
} from "./spec-assumptions.js";

/** A minimal criterion. The tracer reads `id` and `statement` and nothing else. */
function c(id: string, statement: string): AcceptanceCriterion {
  return { id, statement, evidenceRequired: `holdout test for ${id} PASS`, tier: "FUNCTIONAL" };
}

test("a criterion traceable to the ticket is marked `ticket`, not `inferred`", () => {
  const a = extractAssumptions("Build a portfolio with a contact form",
    [c("C-1", "the contact form submits and shows confirmation")]);
  assert.equal(a.find((x) => x.criterionId === "C-1")?.source, "ticket");
  assert.match(String(a.find((x) => x.criterionId === "C-1")?.because), /contact form/);
});

test("a criterion with no basis in the ticket is marked `inferred` and says why", () => {
  // "portfolio website" implies a project list. The owner never said so.
  const a = extractAssumptions("Build a portfolio website",
    [c("C-2", "a project list renders at least three entries")]);
  const x = a.find((v) => v.criterionId === "C-2");
  assert.equal(x?.source, "inferred");
  assert.ok(x?.because && x.because.length > 10, "an inference must justify itself");
});

test("every criterion is accounted for — silence is the failure mode", () => {
  const a = extractAssumptions("thin ticket", [c("C-1", "x"), c("C-2", "y"), c("C-3", "z")]);
  for (const id of ["C-1", "C-2", "C-3"]) {
    assert.ok(a.some((v) => v.criterionId === id), `${id} has no assumption record`);
  }
});

test("the rendered record leads with what was INFERRED — that is what needs review", () => {
  const md = renderAssumptions([
    { id: "A-1", criterionId: "C-1", statement: "s", source: "ticket", because: "b" },
    { id: "A-2", criterionId: "C-2", statement: "t", source: "inferred", because: "c" },
  ]);
  assert.ok(md.indexOf("INFERRED") < md.indexOf("FROM YOUR TICKET"), "inferences first");
});

// NEGATIVE CONTROL. Without this, a stub returning every criterion as `ticket`
// passes the first three tests. Stopword-only overlap must not count as support.
test("a criterion sharing only stopwords with the ticket is NOT `ticket`-sourced", () => {
  const a = extractAssumptions("Build a site for the studio",
    [c("C-9", "the build is for a site and the thing shall be there")]);
  assert.notEqual(a.find((x) => x.criterionId === "C-9")?.source, "ticket",
    "matching on 'the'/'for'/'a' would mark every inference as owner-approved");
});

/*
 * The two below close paths the five above leave open. They are additive; the
 * five are as the plan wrote them.
 */

test("the stopword-only criterion lands on `inferred` specifically, not on `default`", () => {
  // The control above only asserts NOT-`ticket`. A house-rule pattern loose
  // enough to fire on the word "build" would satisfy it by routing C-9 to
  // `default` — passing the control while the tracer was still broken.
  const a = extractAssumptions("Build a site for the studio",
    [c("C-9", "the build is for a site and the thing shall be there")]);
  const x = a.find((v) => v.criterionId === "C-9");
  assert.equal(x?.source, "inferred");
  assert.match(String(x?.because), /studio/,
    "an inference must name what the ticket DID give it to work with");
});

test("the quoted sentence contains every word the reason credits as shared", () => {
  // A real ticket is several sentences, and every other test here uses one. The
  // owner's only check on a `ticket` label is to read the quote and find the
  // words in it; crediting support to a sentence that does not carry it breaks
  // exactly that check while still reading as evidence.
  const a = extractAssumptions(
    "Build a portfolio site for Ada Lovelace. It needs a hero with her name, a projects " +
      "section listing at least three projects, and a contact form that confirms when submitted.",
    [c("C-1", "the hero displays the name Ada Lovelace")],
  );
  const because = String(a.find((x) => x.criterionId === "C-1")?.because);
  const quoted = because.match(/you wrote: "([^"]+)"/)?.[1] ?? "";
  const credited = (because.match(/shared wording: (.+)\.$/)?.[1] ?? "").split(", ");
  assert.ok(quoted.length > 0, "a `ticket` reason must quote the owner's own sentence");
  assert.ok(credited.length > 0 && credited[0] !== "", "and must name what it matched on");
  for (const word of credited) {
    assert.ok(quoted.toLowerCase().includes(word),
      `"${word}" is credited to a sentence that does not contain it: ${quoted}`);
  }
});

test("the rendered record drops nothing — an unrendered inference is an invisible one", () => {
  // Ordering is asserted above; this asserts presence. A renderer that emitted
  // only the section it considered interesting would satisfy the ordering test
  // while losing the record, and losing it silently.
  const a = extractAssumptions("Build a portfolio with a contact form for the studio", [
    c("C-1", "the contact form submits and shows confirmation"),
    c("C-2", "a project list renders at least three entries"),
    c("C-3", "npm run build succeeds with no errors"),
  ]);
  const md = renderAssumptions(a);
  for (const x of a) {
    assert.ok(md.includes(x.statement), `${x.criterionId} is missing from the record`);
    assert.ok(md.includes(x.because), `${x.criterionId} is rendered with no reason`);
  }
  assert.match(md, /Of 3 criteria: 1 inferred/, "the count the owner scans for");
});

test("a Tier-0 gate criterion is `default` — a house rule, not an inference about the ticket", () => {
  // "the build succeeds" is not something the grader guessed from the owner's
  // prose; it is a gate that runs on every artefact. Filing it under INFERRED
  // would bury the two or three real inferences under boilerplate the owner
  // cannot act on, which is how a review document stops being read.
  const a = extractAssumptions("Build a portfolio for the studio", [
    c("G-1", "npm run build succeeds with no errors"),
    c("G-2", "no stub markers such as TODO or FIXME remain in the shipped output"),
  ]);
  for (const id of ["G-1", "G-2"]) {
    const x = a.find((v) => v.criterionId === id);
    assert.equal(x?.source, "default", `${id} should be a house default`);
    assert.match(String(x?.because), /every run/i, "a default must say it is unconditional");
  }
});

/* -------------------------------------------------------------------------
 * TIER-0 GATE IDS
 *
 * The tests above route a gate to `default` by matching its STATEMENT against a
 * house-rule pattern. That only works when someone authored a statement. The
 * scorer synthesises tier-0 gates with no authored prose, so what actually
 * arrives is a criterion whose id AND statement are both the bare string
 * `GATE:suite-green` — no pattern matches, no overlap with the ticket exists,
 * and the tracer stamped it "INFERRED, not something you wrote — the grader
 * added this". That is fabricated provenance on a fixed infrastructure check,
 * and it is what shipped in the 4B run on 2026-07-29.
 * ---------------------------------------------------------------------- */

test("EVERY tier-0 gate id has a label — the table cannot drift from bakeoff's constant", () => {
  // ALL_GATE_IDS is imported as a VALUE above. A new gate added in
  // `bakeoff/src/scorer-protocol.ts` turns this red rather than rendering as a
  // bare machine id in front of the owner, and a label for a gate that no longer
  // exists turns it red too.
  assert.deepEqual(
    [...GATE_LABELS.keys()].sort(),
    [...ALL_GATE_IDS].sort(),
    "the owner-facing gate labels and the protocol's gate ids have drifted apart",
  );
  for (const id of ALL_GATE_IDS) {
    const label = gateLabel(id);
    assert.ok(label.length > 10, `${id} has no usable label`);
    assert.doesNotMatch(label, /^GATE:/, `${id} renders as its own id, which is the defect`);
  }
});

test("a gate criterion is `default` on its ID alone, never `inferred`, and reads as a sentence", () => {
  // The ticket below shares nothing with "GATE:suite-green", which is exactly
  // the input that produced the fabricated INFERRED label. The genuine
  // inference beside it is the positive control: if this test went green because
  // the module stopped labelling anything `inferred`, C-2 would catch it.
  const a = extractAssumptions("Build a portfolio site for Ada Lovelace", [
    { id: GATE_IDS.suiteGreen, statement: GATE_IDS.suiteGreen, tier: "BLOCKING", evidenceRequired: "" },
    { id: GATE_IDS.build, statement: GATE_IDS.build, tier: "BLOCKING", evidenceRequired: "" },
    c("C-2", "a project list renders at least three entries"),
  ]);
  assert.equal(a.find((x) => x.criterionId === "C-2")?.source, "inferred", "the positive control");
  for (const id of [GATE_IDS.suiteGreen, GATE_IDS.build]) {
    const x = a.find((v) => v.criterionId === id);
    assert.equal(x?.source, "default", `${id} is a fixed check, not a guess about the ticket`);
    assert.notEqual(x?.statement, id, `${id} still renders as its own machine id`);
    assert.equal(x?.statement, gateLabel(id));
    assert.doesNotMatch(String(x?.because), /grader's guess|nothing you wrote appears/);
  }
});

/* -------------------------------------------------------------------------
 * HOST-ROLLED-UP QUALITY IDS
 *
 * Same defect as the gate ids above, one door down and NOT fixable the same
 * way. `bakeoff/src/scorer.ts:summariseDomFindings` mints one criterion per DOM
 * observation kind that fired — `QUALITY:default_serif_font` — with no authored
 * prose, and `calibration/grade-fixture.ts:statementFor` hands the bare id back
 * as the statement. The tracer then found no overlap with the ticket, because
 * there is none to find, and stamped it "INFERRED, not something you wrote".
 *
 * WHY THERE IS NO DRIFT TEST HERE. `ALL_GATE_IDS` is exported; there is no
 * `ALL_DOM_FINDING_KINDS`. The eight DOM kinds are checked by the COMPILER
 * instead — `DOM_FINDING_LABELS` is `satisfies Record<DomFindingKind, string>`,
 * so a kind added upstream is a missing property and a kind renamed upstream is
 * an unknown property. Both directions were mutated and both went red; see the
 * comment on the table. The two roll-ups that are not DOM findings are string
 * literals in scorer.ts with nothing to check against, and the fallback below is
 * what covers them.
 * ---------------------------------------------------------------------- */

test("a QUALITY roll-up is `default` on its ID alone, never `inferred`, and reads as a sentence", () => {
  // The ticket shares nothing with "QUALITY:default_serif_font" — the input that
  // produced the fabricated INFERRED label. C-2 is the positive control: if this
  // went green because the module stopped labelling anything `inferred`, it
  // catches that.
  const a = extractAssumptions("Build a portfolio site for Ada Lovelace", [
    { id: "QUALITY:default_serif_font", statement: "QUALITY:default_serif_font", tier: "QUALITY", evidenceRequired: "" },
    { id: "QUALITY:scorer_infrastructure", statement: "QUALITY:scorer_infrastructure", tier: "QUALITY", evidenceRequired: "" },
    c("C-2", "a project list renders at least three entries"),
  ]);
  assert.equal(a.find((x) => x.criterionId === "C-2")?.source, "inferred", "the positive control");
  for (const id of ["QUALITY:default_serif_font", "QUALITY:scorer_infrastructure"]) {
    const x = a.find((v) => v.criterionId === id);
    assert.equal(x?.source, "default", `${id} is an observation the grader makes, not a guess about the ticket`);
    assert.notEqual(x?.statement, id, `${id} still renders as its own machine id`);
    assert.equal(x?.statement, qualityRollupLabel(id));
    assert.doesNotMatch(String(x?.because), /grader's guess|nothing you wrote appears/);
  }
});

test("every DOM observation kind that can be rolled up has a sentence, and no sentence is an id", () => {
  // Driven from the KINDS, not from the label table: iterating the table would
  // only prove the table agrees with itself. The list is the union's members,
  // and the compiler is what keeps the union and the table in step.
  const kinds = [
    "console_error",
    "unhandled_rejection",
    "same_origin_request_failed",
    "sealed_network_request_blocked",
    "image_natural_width_zero",
    "horizontal_overflow",
    "default_serif_font",
    "placeholder_text",
  ];
  for (const id of [...kinds.map((k) => `QUALITY:${k}`), "QUALITY:non_blocking_exploit_pattern", "QUALITY:scorer_infrastructure"]) {
    const label = qualityRollupLabel(id);
    assert.ok(label.length > 10, `${id} has no usable label`);
    assert.doesNotMatch(label, /^QUALITY:/, `${id} renders as its own id, which is the defect`);
    assert.doesNotMatch(label, /has no description/, `${id} fell through to the unlabelled fallback`);
  }
});

test("an id the table does not know says so IN ENGLISH — the fallback is reachable here", () => {
  // Unlike `gateLabel`, whose drift test makes its fallback nearly unreachable,
  // two of the ten roll-up ids are unchecked string literals upstream. This
  // branch is where a rename lands, so it has to leave the owner with something
  // to act on.
  const label = qualityRollupLabel("QUALITY:something_renamed_upstream");
  assert.match(label, /grader defect|report it/i, "an unlabelled roll-up must read as a grader defect");
  assert.notEqual(label, "QUALITY:something_renamed_upstream");
  assert.equal(isQualityRollupId("QUALITY:something_renamed_upstream"), true, "the PREFIX decides, not the table");
  assert.equal(isQualityRollupId("REQ-004"), false);
});
