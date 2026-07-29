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
import { extractAssumptions, renderAssumptions } from "./spec-assumptions.js";

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
