/**
 * spec-agent.test.ts — the manifest-mode rule in the frozen authoring prompt,
 * and the audit's wiring into the deterministic rules.
 *
 * WHAT CAN BE TESTED HERE WITHOUT SPENDING QUOTA, which is what shapes the file.
 * `generateSuite` and most of `auditSuite` call a metered model seat. Two things
 * do not: the authoring prompt is a frozen module-level constant, so the rule it
 * states is readable directly; and `auditSuite` returns BEFORE the seat is
 * constructed when the deterministic pass has already produced a blocking
 * finding and `alwaysRunJudge` is not set (`spec-agent.ts` —
 * `deterministicBlocks && ... !== true`).
 *
 * ------------------------------------------------------------------------
 * PART 1 — THE MANIFEST-MODE RULE (`CHOOSE ONE OF TWO MODES`)
 * ------------------------------------------------------------------------
 *
 * WHAT WENT WRONG. Until 2026-08-02 the STATIC branch read: "Choose this when
 * the ticket asks for pages and nothing server-side: a marketing page, a
 * portfolio, a one-pager, a brochure site ... THIS IS THE COMMON CASE." The
 * discriminator was a list of SITE-TYPE NOUNS, and one of them was the noun the
 * owner's own tickets lead with. A ticket that says "portfolio" AND asks for an
 * HTTP API, a SQLite database, bearer-token auth and a 429 rate limit could be
 * classified STATIC — and STATIC means `execution.start` is null, so the scorer
 * serves the delivered folder as files, the server is never booted, and every
 * criterion about the backend fails against a directory listing. The run of
 * 2026-07-30 failed `GATE:boot` in exactly that configuration.
 *
 * WHY DELETING THE WORD "portfolio" WOULD NOT HAVE FIXED IT. The defect is the
 * SHAPE of the rule, not the noun in it: any rule that discriminates on what
 * kind of site the ticket is about mis-classifies the next ticket whose noun is
 * not on the list. So the tests below assert the shape — the SERVER branch names
 * BEHAVIOURS (an API, persistence between requests, a stored submission, auth,
 * rate limiting, a database), the STATIC branch is conditioned on the ABSENCE of
 * all of them, and no site-type noun appears in the section at all.
 *
 * THE ABSENCE ASSERTION IS SCOPED TO THE MODE SECTION, DELIBERATELY. The word
 * "portfolio" still appears elsewhere in `AUTHORING_SYSTEM_PROMPT`, inside the
 * prose-floor rule, where it records a MEASUREMENT ("a correct portfolio that
 * rendered 189"). A prompt-wide noun assertion could only be made green by
 * deleting that measurement, so it would be the wrong test.
 *
 * NEGATIVE CONTROLS. Eight mutations were applied to AUTHORING_SYSTEM_PROMPT in
 * `spec-agent.ts`, each run, each WATCHED RED, each restored (2026-08-02). One
 * wholesale revert of the wording would only have proved the tests can see one
 * string; each mutation below isolates a single requirement, and between them
 * every assertion-bearing test in part 1 has been observed failing:
 *
 *   #  mutation applied to the mode section        assertion that went red
 *   1  re-insert "a portfolio, a brochure site"    "names a site type
 *        into the STATIC branch                      (/\bportfolios?\b/i)"
 *   2  re-insert "THIS IS THE COMMON CASE."        "one mode is advertised as
 *                                                   the default"
 *   3  delete the "WHEN BOTH ARE PRESENT ...       "does not say which mode wins
 *        IT IS SERVER" paragraph                     when ... pages AND server"
 *   4  replace the "Do not invent a server ..."    "the anti-invention warning
 *        warning with a neutral sentence             is gone"
 *   5a change "Declare the port as               "no longer defaults to the
 *        ${STATIC_SERVE_PORT}" to a literal 8080     port the sealed scorer
 *                                                    serves on"
 *   5b delete ", all three together"               "no longer requires start,
 *                                                   port and healthPath together"
 *   6  delete the "rate limiting, a quota" line    "no longer names rate
 *        from the SERVER list                        limiting"
 *   7  weaken STATIC's condition from "ONLY when   "STATIC is no longer gated on
 *        NOTHING ..." to "Choose this when ..."      the absence of the SERVER
 *                                                    behaviours"
 *   8  restore the old dataExpectations wording,    "dataExpectations is not tied
 *        "[] unless the ticket implies persisted      to the SERVER persistence
 *        data"                                        triggers"
 *
 * 4 IS THE REVERSE-DIRECTION CONTROL and the reason it is here: tests 1-3 only
 * check that the new behaviour rule is PRESENT, and all three stay green while
 * the sentence protecting a ticket that needs no server is deleted.
 *
 * ------------------------------------------------------------------------
 * PART 2 — THE DETERMINISTIC PASS'S TICKET BRIEF
 * ------------------------------------------------------------------------
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
import { AUTHORING_SYSTEM_PROMPT, auditSuite } from "./spec-agent.js";
import { STATIC_SERVE_PORT } from "./scorer-protocol.js";
import type { SuiteDraft } from "./spec-types.js";

/* -------------------------------------------------------------------------
 * PART 1 — the manifest-mode rule
 * ---------------------------------------------------------------------- */

const MODE_SECTION_START = "CHOOSE ONE OF TWO MODES";
const MODE_SECTION_END = "## Output";

/**
 * The manifest-mode instruction as the spec seat receives it.
 *
 * Sliced out of the prompt rather than read from a separate exported constant,
 * because the slice proves the text is IN the prompt and in the manifest
 * section. Throws rather than returning "" when either marker is gone: an empty
 * section would satisfy every absence assertion below, which is this
 * repository's signature defect wearing a different hat.
 */
function manifestModeSection(): string {
  const start = AUTHORING_SYSTEM_PROMPT.indexOf(MODE_SECTION_START);
  if (start < 0) {
    throw new Error(
      `AUTHORING_SYSTEM_PROMPT no longer contains "${MODE_SECTION_START}" — the manifest-mode rule ` +
        "was renamed or removed, and every assertion in part 1 is now measuring nothing.",
    );
  }
  const end = AUTHORING_SYSTEM_PROMPT.indexOf(MODE_SECTION_END, start);
  if (end < 0) {
    throw new Error(
      `AUTHORING_SYSTEM_PROMPT has no "${MODE_SECTION_END}" heading after the manifest-mode rule.`,
    );
  }
  return AUTHORING_SYSTEM_PROMPT.slice(start, end);
}

/**
 * The section with runs of whitespace collapsed.
 *
 * The prompt is hard-wrapped at 100 columns, so every sentence in it straddles a
 * newline at some column that means nothing. Asserting on the flattened text
 * makes the tests sensitive to the WORDS and blind to the wrapping — a re-wrap
 * must not turn them red, and a deleted sentence must.
 */
const MODE_FLAT = manifestModeSection().replace(/\s+/g, " ");

/**
 * Site-type nouns. The old rule used the first four as its STATIC exemplars;
 * the rest are the same shape of noun for tickets the owner has not written yet.
 * None of them may appear in the mode section, because the mode is not a
 * property of what the site is called.
 */
const SITE_TYPE_NOUNS: readonly RegExp[] = [
  /\bportfolios?\b/i,
  /\bbrochure\b/i,
  /\bone-?pagers?\b/i,
  /\bmarketing\b/i,
  /\blanding page\b/i,
  /\bblog\b/i,
  /\br[eé]sum[eé]s?\b/i,
];

/**
 * The behaviours that force SERVER. Each is a thing a browser handed a folder of
 * files cannot do, and each one alone is sufficient — that is the rule the
 * owner's portfolio-with-an-API ticket needs, since it trips six of them.
 */
const SERVER_BEHAVIOURS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "an HTTP API", pattern: /\bHTTP API\b/i },
  { name: "a route under /api", pattern: /route the ticket writes under "\/api"/i },
  { name: "data that persists between requests", pattern: /persists between requests/i },
  { name: "a database of any kind", pattern: /a database of any kind/i },
  { name: "a submission that must be stored", pattern: /submission must be STORED/i },
  { name: "authentication", pattern: /authentication of any kind/i },
  { name: "rate limiting", pattern: /rate limiting/i },
];

test("the manifest-mode rule discriminates on behaviour, not on what kind of site it is", () => {
  // POSITIVE ANCHORS FIRST. Every assertion after these is an ABSENCE, and an
  // absence is satisfied by an empty string; without these three the test would
  // pass over a deleted section and report that as health.
  assert.ok(MODE_FLAT.length > 500, `the mode section is ${String(MODE_FLAT.length)} characters long`);
  assert.match(MODE_FLAT, /- SERVER — "start": "<command>"/, "the SERVER branch is gone");
  assert.match(MODE_FLAT, /- STATIC — "start": null/, "the STATIC branch is gone");

  assert.match(
    MODE_FLAT,
    /DECIDE ON THE BEHAVIOUR THE TICKET ASKS FOR, NEVER ON WHAT KIND OF SITE IT IS/,
    "the rule no longer states what it keys on",
  );

  for (const noun of SITE_TYPE_NOUNS) {
    assert.doesNotMatch(
      MODE_FLAT,
      noun,
      `the mode section names a site type (${String(noun)}). A noun cannot be the discriminator: ` +
        "the ticket that broke this rule was a portfolio WITH an API, and it was classified STATIC.",
    );
  }

  // No mode may be advertised as the one to reach for by default. "THIS IS THE
  // COMMON CASE" sat on the STATIC branch and was doing the same work as the
  // nouns — putting a thumb on the scale before the ticket had been read.
  assert.doesNotMatch(
    MODE_FLAT,
    /\b(common|usual|default|typical|normal) case\b/i,
    "one mode is advertised as the default, which decides before the ticket is read",
  );
});

test("the SERVER branch names every behaviour a folder of files cannot provide", () => {
  const serverBranch = MODE_FLAT.slice(MODE_FLAT.indexOf("- SERVER —"), MODE_FLAT.indexOf("- STATIC —"));
  assert.ok(serverBranch.length > 300, "the SERVER branch is missing or empty");

  for (const behaviour of SERVER_BEHAVIOURS) {
    assert.match(
      serverBranch,
      behaviour.pattern,
      `the SERVER branch no longer names ${behaviour.name}, so a ticket that asks only for that ` +
        "can be read as STATIC and its server is never booted",
    );
  }

  // One is enough. A rule that reads as a conjunction lets a ticket with an API
  // and no database argue itself into STATIC.
  assert.match(serverBranch, /ANY ONE of these is enough/, "the SERVER triggers are no longer disjunctive");
});

test("STATIC is conditioned on the ABSENCE of server behaviour, and both present is SERVER", () => {
  assert.match(
    MODE_FLAT,
    /Choose this ONLY when NOTHING in the ticket asks for any behaviour in the SERVER list/,
    "STATIC is no longer gated on the absence of the SERVER behaviours",
  );

  // THE WHOLE DEFECT, IN ONE ASSERTION. The old rule had no answer for a ticket
  // that asks for pages and a server both, and its STATIC branch — "pages and
  // nothing server-side" — was the one that named the owner's noun.
  assert.match(
    MODE_FLAT,
    /WHEN BOTH ARE PRESENT[^.]*IT IS SERVER\./,
    "the rule does not say which mode wins when the ticket asks for pages AND server behaviour",
  );
  assert.match(
    MODE_FLAT,
    /the app is never booted/,
    "the consequence of getting BOTH wrong is no longer stated, so the rule reads as a preference",
  );
});

test("the warning that protects a ticket needing no server survives", () => {
  // MEASURED, AND STILL TRUE: requiring start/port/healthPath failed a correct
  // static site on a boot gate it never needed (scorer-protocol.ts, owner
  // decision D2). Steering toward SERVER must not cost that protection — this
  // test is the reverse-direction control on the four above.
  assert.match(
    MODE_FLAT,
    /Do not invent a server for a ticket that does not need one/,
    "the anti-invention warning is gone; a correct static artefact now fails a boot gate it never needed",
  );
  assert.match(
    MODE_FLAT,
    /fails a correct implementation for a reason that has nothing to do with whether the work was done/,
    "the warning no longer says what it costs, which is the half that makes it persuasive",
  );
});

test("the manifest fields the scorer needs are still declared together, on the harness's port", () => {
  // The port is asserted through the imported constant, not the literal: a suite
  // authored against one port and executed on another fails every test for a
  // reason that appears in neither the suite nor the manifest.
  assert.match(
    MODE_FLAT,
    new RegExp(`Declare the port as ${String(STATIC_SERVE_PORT)} unless the ticket names one`),
    "the SERVER branch no longer defaults to the port the sealed scorer serves on",
  );
  assert.ok(
    MODE_FLAT.includes(`http://127.0.0.1:${String(STATIC_SERVE_PORT)}`),
    "the STATIC branch no longer names the loopback origin the scorer serves on",
  );

  // scorer-protocol.ts rejects a manifest with `start` and no `port`/`healthPath`
  // (`invalid_manifest`). That validation is correct and is another module's
  // business; what this file owns is that the prompt asks for all three.
  assert.match(
    MODE_FLAT,
    /"start": "<command>", "port": <number>, "healthPath": "<same-origin path>", all three together/,
    "the SERVER branch no longer requires start, port and healthPath together",
  );
  assert.match(
    MODE_FLAT,
    /"start": null, "port": null, "healthPath": null/,
    "the STATIC branch no longer nulls all three",
  );

  // THE SAME DEFECT, ONE FIELD OVER. Choosing SERVER boots the app; it does not
  // check what the app stored. That is `dataExpectations`, and MEASURED in
  // scorer-container.ts `checkDataExpectations`: an empty array returns the
  // `dataPresent` gate as "not_applicable" — the persistence check does not fail,
  // it disappears. The old wording ("[] unless the ticket implies persisted
  // data") left that to a soft verb, so a ticket whose whole point is a stored
  // submission could boot, pass, and never have its rows counted by anything the
  // builder could not fabricate.
  assert.match(
    MODE_FLAT,
    /if you chose SERVER for a persistence trigger, declare at least one expectation here/,
    "dataExpectations is not tied to the SERVER persistence triggers, so a ticket that boots can " +
      "still skip the only check the builder cannot fabricate",
  );
});

/* -------------------------------------------------------------------------
 * PART 2 — the deterministic pass's ticket brief
 * ---------------------------------------------------------------------- */

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
