/**
 * spec-agent.test.ts — the audit's wiring into the deterministic rules.
 *
 * WHY THIS FILE IS ONE TEST WIDE. `auditSuite` calls a metered model seat, so
 * almost nothing in it is reachable without spending quota. The exception is the
 * early return: when the deterministic pass produces a blocking finding and
 * `alwaysRunJudge` is not set, `auditSuite` returns BEFORE the seat is
 * constructed (`spec-agent.ts` — `deterministicBlocks && ... !== true`). That
 * window is exactly where the wiring below lives, so it can be tested for free.
 *
 * WHAT IT GUARDS, and it is a seam rather than a behaviour. `deterministicAudit`
 * accepts an optional `ticketBrief`. `DeterministicAuditOptions`' own docblock
 * says: "`auditSuite` in spec-agent.ts already holds the `Ticket` and should
 * pass `ticketBrief: ticket.brief` when it builds these options." It did not.
 * The rule still fired without it — by design, since a rule that disarms itself
 * on a missing optional input is this repository's signature defect — so nothing
 * was red and nothing was obviously wrong.
 *
 * WHAT WAS ACTUALLY LOST WAS THE FEEDBACK. `proseLengthFloorFindings` branches
 * its detail string on the brief: with it, the seat is told ", and the ticket
 * never states 200"; without it, only the generic sentence. That specific
 * clause is the whole argument for making the rule BLOCKING — `mustRegenerate`
 * discards the suite and buys another authoring call, and it is worth it only if
 * the re-author is told something the three prior runs were not. Unwired, the
 * expensive half of the rule was paying for the cheap half's message.
 *
 * So the assertion is on the DETAIL TEXT, not on a call spy: the text is the
 * thing that reaches the seat, and a spy would pass just as happily on a brief
 * that was threaded and then dropped.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Ticket } from "./contracts.js";
import { ticketDigest } from "./hash.js";
import { auditSuite } from "./spec-agent.js";
import type { SuiteDraft } from "./spec-types.js";

/**
 * A ticket that says nothing about character counts.
 *
 * It must NOT state 200: a brief that stated it would suppress the finding
 * entirely and the test would pass with the wiring absent, for the wrong reason.
 * The suppression direction is covered in `spec-validate.test.ts`, which can
 * reach `proseLengthFloorFindings` directly without a seat.
 */
const BRIEF = "Build a portfolio site for Ada Lovelace. It needs a hero with her name.";

const TICKET: Ticket = {
  id: "T-WIRING",
  tier: "medium",
  title: "portfolio",
  brief: BRIEF,
  sha256: ticketDigest(BRIEF),
};

const HOLDOUT_SOURCE = [
  'import { expect, test } from "@playwright/test";',
  "",
  'test("[REQ-001] T-1 the page carries real copy", async ({ page }) => {',
  '  await page.goto("/");',
  '  const rendered = (await page.locator("body").innerText()).trim();',
  "  expect(rendered.length).toBeGreaterThan(200);",
  "});",
].join("\n");

const DRAFT: SuiteDraft = {
  ticketId: TICKET.id,
  ticketSha256: TICKET.sha256,
  criteria: [
    {
      id: "REQ-001",
      tier: "BLOCKING",
      statement: "The portfolio site shall render the home page.",
      evidenceRequired: "holdout test T-1 PASS: the home page renders",
      holdoutTestIds: ["T-1"],
      visibleTestIds: [],
      evidenceArtifacts: [],
    },
  ],
  files: [
    {
      path: "holdout/hero.spec.mjs",
      visibility: "holdout",
      runner: "playwright",
      description: "holdout/hero.spec.mjs",
      expectedTestIds: ["T-1"],
      criterionIds: ["REQ-001"],
      source: HOLDOUT_SOURCE,
    },
  ],
};

test("auditSuite threads the ticket brief into the deterministic pass", async () => {
  // No seat is constructed on this path: the blocking finding short-circuits
  // before `callerFor`. If this test ever starts costing quota, the early
  // return has moved and that is itself the thing to look at.
  const result = await auditSuite(DRAFT, TICKET, { syntaxCheck: false });

  assert.ok(result.mustRegenerate, "a prose-length floor must force a re-author");
  assert.equal(result.judgeRan, false, "the judge must not have been called on this path");

  const prose = result.deterministicFindings.filter((f) => /character-count floor/.test(f.detail));
  assert.equal(prose.length, 1, `expected one prose-floor finding, got ${prose.length}`);

  // THE ASSERTION. This clause exists only on the branch that received a brief.
  assert.match(
    prose[0]?.detail ?? "",
    /the ticket never states 200/,
    "the finding did not name the ticket, so `ticketBrief` never reached the rule",
  );
});
