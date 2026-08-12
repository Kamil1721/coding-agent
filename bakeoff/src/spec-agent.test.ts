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
 * PARTS 4 AND 5 ADD A THIRD ROUTE, and it is worth naming because it is the one
 * that lets the REGENERATION LOOP be tested at all: `AnthropicSeatCaller` is
 * subclassable, so a caller that records its request and replays a scripted
 * response body drives the real `generateAuditedSuite`, the real
 * `parseSuiteDraft`, the real deterministic audit and the real
 * `parseSuiteManifest` across three attempts without a network or a token. The
 * base constructor still resolves a credential BY NAME, so the environment
 * carries a sentinel that is not a key and cannot be one.
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
 *
 * ------------------------------------------------------------------------
 * PART 3 — THE DOCUMENTED MANIFEST SHAPE, CHECKED AGAINST THE VALIDATOR
 * ------------------------------------------------------------------------
 *
 * WHAT WENT WRONG, MEASURED. Run `a913c871` (2026-08-09) spent 1h26m54s and died
 * in the spec phase. The prompt ORDERED a populated `dataExpectations` for any
 * SERVER ticket and showed only `"dataExpectations": []`; the sealed scorer's
 * parser requires seven keys; `grep -ac minRows bakeoff/src/spec-agent.ts`
 * returned 0. `parseSuiteManifest`'s `fail()` is typed `never`, so it throws at
 * the FIRST offending field and each rejection names exactly one. The three
 * attempts learned `id`, then `kind`, and the third dropped the `id` it had
 * already got right — the behaviour of a model that has never been shown the
 * object, not of one accumulating fields.
 *
 * WHY A STRING-MATCH TEST WOULD NOT HAVE CAUGHT IT, and this is the whole point
 * of part 3. `AUTHORING_SYSTEM_PROMPT.includes("dataExpectations")` was TRUE
 * throughout that run. So was every assertion in part 1. What was false — and
 * what nothing measured — is that the shape the prompt documents is a shape
 * `parseSuiteManifest` accepts. These tests cut the template out of the prompt
 * and run it through the scorer's own parser, and run a VIOLATION of every
 * documented rule through it too. Prose the validator does not enforce, and
 * enforcement the prose does not mention, both go red.
 *
 * NEGATIVE CONTROLS. Four mutations, applied to production code, run, WATCHED
 * RED, restored (2026-08-10). Two weaken the prompt and two weaken the
 * validator, because the binding has two ends and a one-ended test only sees
 * one of them:
 *
 *   mutation                                      test that went red
 *   A  the template's `dataExpectations` put      "the manifest template ... is
 *      back to `[]` — the literal pre-fix          accepted by the sealed
 *      prompt of run a913c871                      scorer's parser" ("the
 *                                                  template shows 0 data
 *                                                  expectation(s)") + "both
 *                                                  worked examples reach the
 *                                                  prompt verbatim"
 *   B  the sqlite example's `file` changed to     all four part-3 tests,
 *      "/data/app.db" (absolute)                   including each probe's own
 *                                                  control: "the control entry
 *                                                  ... is itself rejected, so
 *                                                  its violation proves nothing"
 *   C  the `minRows` prose rule deleted from      "every rule the prompt states
 *      the prompt                                  ... is a rule the scorer
 *                                                  enforces" ("the prompt no
 *                                                  longer states the rule
 *                                                  minRows is at least 1")
 *   D  `reqNumber(item,"minRows",where,1)` in     same test, other direction:
 *      scorer-protocol.ts replaced with a          "parseSuiteManifest ACCEPTED
 *      defaulting read                             a violation"
 *
 * B IS THE CONTROL ON THE CONTROLS. Each probe first parses a REPAIRED entry of
 * the same kind and requires it to be accepted. Without that, a violation
 * rejected for an unrelated reason — a typo in the fixture, a helper that
 * dropped a field — reads as the rule being enforced, which is this
 * repository's signature defect in its most convincing costume.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnthropicSeat, Ticket } from "./contracts.js";
import { BakeoffError } from "./contracts.js";
import { ticketDigest } from "./hash.js";
import {
  ATTEMPT_TIMEOUT_ENV_NAME,
  AUTHORING_JSON_SCHEMA,
  AUTHORING_SYSTEM_PROMPT,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  MANIFEST_DATA_EXPECTATION_EXAMPLES,
  TIMEOUT_FAILURE_MARKER,
  TURN_MARKER_CONSTRAINTS,
  TURN_MARKER_PRIOR,
  TURN_MARKER_TICKET,
  auditSuite,
  generateAuditedSuite,
  remediationForFailedAuthoring,
  resolveAttemptTimeoutMs,
  ticketTurn,
  withCoverageClaimsFrom,
  withoutCoverageClaims,
} from "./spec-agent.js";
import { acceptanceSignals } from "./spec-validate.js";
import type { AuditFinding } from "./contracts.js";
import { AnthropicSeatCaller } from "./anthropic-seat.js";
import type { SeatCallRequest, SeatCallResult } from "./anthropic-seat.js";
import { JUDGE_SEAT, SPEC_SEAT } from "./config.js";
import {
  STATIC_SERVE_PORT,
  SUITE_MANIFEST_FILENAME,
  parseSuiteManifest,
} from "./scorer-protocol.js";
import { AUTHORING_BUDGET, DEFAULT_MAX_AUTHORING_ATTEMPTS } from "./spec-types.js";
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

/* -------------------------------------------------------------------------
 * PART 3 — the documented manifest shape, checked against the validator
 * ---------------------------------------------------------------------- */

/**
 * The manifest template EXACTLY AS THE SEAT RECEIVES IT, cut out of the prompt.
 *
 * Sliced and brace-matched rather than read from a constant, for the reason
 * `manifestModeSection` gives one section up: the slice proves the document is
 * IN the prompt. A constant the prompt no longer interpolates would keep every
 * assertion below green while the seat is shown nothing.
 *
 * The matcher tracks quoting so a brace inside a string value cannot end the
 * document early. It throws rather than returning "" on any failure.
 */
function manifestTemplateJson(): string {
  const anchor = AUTHORING_SYSTEM_PROMPT.indexOf('"manifestVersion": 1');
  if (anchor < 0) {
    throw new Error(
      'AUTHORING_SYSTEM_PROMPT no longer contains a manifest template ("manifestVersion": 1). The ' +
        "seat is being ordered to emit a document it is never shown, which is how run a913c871 died.",
    );
  }
  const start = AUTHORING_SYSTEM_PROMPT.lastIndexOf("{", anchor);
  if (start < 0) throw new Error("the manifest template has no opening brace before manifestVersion");

  let depth = 0;
  let inString = false;
  for (let i = start; i < AUTHORING_SYSTEM_PROMPT.length; i += 1) {
    const ch = AUTHORING_SYSTEM_PROMPT[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return AUTHORING_SYSTEM_PROMPT.slice(start, i + 1);
    }
  }
  throw new Error("the manifest template in AUTHORING_SYSTEM_PROMPT is not brace-balanced");
}

/** The whole prompt with runs of whitespace collapsed. See `MODE_FLAT`. */
const PROMPT_FLAT = AUTHORING_SYSTEM_PROMPT.replace(/\s+/g, " ");

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT, and the reason it is not a string match.
 *
 * Run `a913c871` (2026-08-09) spent 1h26m54s and died because the prompt
 * mandated a populated `dataExpectations` and showed only `[]`. A test asserting
 * `AUTHORING_SYSTEM_PROMPT.includes("dataExpectations")` was satisfied by that
 * prompt. This one is not: it takes the document the seat is shown, parses it
 * with the SEALED SCORER'S OWN PARSER — the function whose rejection killed the
 * run — and fails if the two ever disagree.
 */
test("the manifest template in the prompt is accepted by the sealed scorer's parser", () => {
  const raw = manifestTemplateJson();

  // POSITIVE ANCHORS. Everything after this reads fields off the parse; a
  // template that shrank to `{}` would fail the parse loudly, but a template
  // whose dataExpectations quietly went back to `[]` would not.
  assert.ok(raw.length > 200, `the manifest template is only ${String(raw.length)} characters long`);

  const parsed = parseSuiteManifest(JSON.parse(raw) as unknown);

  assert.ok(
    parsed.dataExpectations.length >= 2,
    `the template shows ${String(parsed.dataExpectations.length)} data expectation(s). It must show ` +
      "both kinds populated. `[]` is the shape the seat was shown for the whole life of run a913c871, " +
      "and it is the one shape that teaches nothing, because it is the branch the mandate forbids.",
  );
  assert.deepEqual(
    [...parsed.dataExpectations].map((e) => e.kind).sort(),
    ["http", "sqlite"],
    "the template must show BOTH kinds: the seat picks one from the ticket and cannot infer the " +
      "other's fields from the one it was shown",
  );

  // THE FIELD THE THREE DEAD ATTEMPTS NEVER EMITTED AND WERE NEVER TOLD ABOUT.
  // `grep -ac minRows bakeoff/src/spec-agent.ts` returned 0 on 2026-08-09.
  assert.ok(
    AUTHORING_SYSTEM_PROMPT.includes("minRows"),
    "the prompt does not contain the string `minRows` anywhere. That was literally true during run " +
      "a913c871, and no attempt emitted the field.",
  );
});

/**
 * The examples are the constants, byte for byte.
 *
 * The prompt interpolates `JSON.stringify(example)`, so this assertion uses the
 * SAME call: an example edited in the constant and left stale in a hand-written
 * block, or vice versa, is red here rather than divergent in production.
 */
test("both worked examples reach the prompt verbatim, and both parse", () => {
  for (const [kind, example] of Object.entries(MANIFEST_DATA_EXPECTATION_EXAMPLES)) {
    assert.ok(
      AUTHORING_SYSTEM_PROMPT.includes(JSON.stringify(example)),
      `the ${kind} example is not in the prompt as it is written in the constant. The prompt must ` +
        "interpolate JSON.stringify of it, or the seat is shown something the test never checked.",
    );
    assert.doesNotThrow(
      () => parseSuiteManifest(manifestWith([example])),
      `the ${kind} example the prompt shows is rejected by parseSuiteManifest`,
    );
  }
});

/** A minimal, otherwise-valid manifest carrying the given expectations. */
function manifestWith(dataExpectations: readonly unknown[]): unknown {
  return {
    manifestVersion: 1,
    ticketId: "t-probe",
    target: "web",
    execution: {
      install: null,
      build: null,
      typecheck: null,
      lint: null,
      start: null,
      port: null,
      healthPath: null,
      bootTimeoutMs: null,
      commandTimeoutMs: null,
    },
    sourceDirs: ["."],
    uiFlows: [{ id: "home", path: "/", description: "landing", waitForSelector: null }],
    dataExpectations,
  };
}

/** An entry built from an example with fields overridden or deleted. */
function entry(
  base: "sqlite" | "http",
  overrides: Readonly<Record<string, unknown>>,
  drop: readonly string[] = [],
): Record<string, unknown> {
  const built: Record<string, unknown> = { ...MANIFEST_DATA_EXPECTATION_EXAMPLES[base], ...overrides };
  for (const key of drop) delete built[key];
  return built;
}

/**
 * One documented rule, one sentence in the prompt, one violation of it.
 *
 * `promptSays` is what the seat is told. `violation` is an entry that breaks
 * exactly that rule. `namesField` is what the validator must complain about.
 * The three together are the divergence check: prose the validator does not
 * enforce, or enforcement the prose does not mention, cannot both stay green.
 */
interface RuleProbe {
  readonly rule: string;
  readonly promptSays: RegExp;
  readonly violation: Record<string, unknown>;
  readonly namesField: RegExp;
}

const RULE_PROBES: readonly RuleProbe[] = [
  {
    rule: "all seven keys are present on every entry",
    promptSays: /Every entry carries ALL SEVEN of "id", "kind", "file", "table", "sql", "path" and "minRows"/,
    violation: entry("sqlite", {}, ["minRows"]),
    namesField: /minRows/,
  },
  {
    rule: "an omitted key is not a null key",
    promptSays: /Omitting a key is not the same as declaring it absent and is rejected/,
    violation: entry("sqlite", {}, ["sql"]),
    namesField: /\.sql\b/,
  },
  {
    rule: "id is a non-empty string",
    promptSays: /"id" is a non-empty string and no two entries may share one/,
    violation: entry("sqlite", { id: "" }),
    namesField: /\.id\b/,
  },
  {
    rule: 'kind is exactly "sqlite" or "http"',
    promptSays: /"kind" is exactly "sqlite" or "http"\. No other value is accepted\./,
    violation: entry("sqlite", { kind: "postgres" }),
    namesField: /\.kind\b/,
  },
  {
    rule: "minRows is at least 1",
    promptSays: /"minRows" is a number and must be at least 1\. Zero rows proves nothing, so 0 is rejected\./,
    violation: entry("sqlite", { minRows: 0 }),
    namesField: /minRows/,
  },
  {
    rule: "sqlite requires file",
    promptSays: /kind "sqlite" reads a database file inside the artefact.{0,400}?"file" is REQUIRED/,
    violation: entry("sqlite", { file: null }),
    namesField: /\.file\b/,
  },
  {
    rule: "a sqlite file path is artefact-relative",
    promptSays: /a path relative to the artefact root — no leading "\/" and no "\.\."/,
    violation: entry("sqlite", { file: "/etc/hosts" }),
    namesField: /\.file\b/,
  },
  {
    rule: "sqlite needs either a table or a sql count",
    promptSays: /EITHER "table", whose rows are counted for you, OR "sql"/,
    violation: entry("sqlite", { table: null, sql: null }),
    namesField: /table name or an explicit sql count/,
  },
  {
    rule: "http requires path",
    promptSays: /kind "http" reads a declared endpoint.{0,300}?"path" is REQUIRED/,
    violation: entry("http", { path: null }),
    namesField: /\.path\b/,
  },
  {
    rule: "an http path is same-origin, leading slash, no query and no fragment",
    promptSays: /a same-origin path starting with "\/" with no query string and no fragment/,
    violation: entry("http", { path: "https://example.test/api/bookings" }),
    namesField: /\.path\b/,
  },
];

test("every rule the prompt states about dataExpectations is a rule the scorer enforces", () => {
  assert.ok(RULE_PROBES.length >= 10, "the probe table was emptied, so this test measures nothing");

  for (const probe of RULE_PROBES) {
    assert.match(
      PROMPT_FLAT,
      new RegExp(probe.promptSays.source.replace(/\s+/g, " "), probe.promptSays.flags),
      `the prompt no longer states the rule "${probe.rule}", but parseSuiteManifest still enforces ` +
        "it. That gap is exactly how run a913c871 died: mandated, enforced, never shown.",
    );

    // THE NEGATIVE CONTROL, PER PROBE. Without it a violation that is rejected
    // for some unrelated reason — a typo in the fixture, a field the builder
    // helper dropped — reads as the rule being enforced.
    const repaired = entry(
      probe.violation["kind"] === "http" ? "http" : "sqlite",
      { id: "control" },
    );
    assert.doesNotThrow(
      () => parseSuiteManifest(manifestWith([repaired])),
      `the control entry for "${probe.rule}" is itself rejected, so its violation proves nothing`,
    );

    assert.throws(
      () => parseSuiteManifest(manifestWith([probe.violation])),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
        assert.match(
          error.message,
          probe.namesField,
          `the validator rejected the violation of "${probe.rule}" without naming the field. The ` +
            "seat gets this message and nothing else.",
        );
        return true;
      },
      `parseSuiteManifest ACCEPTED a violation of "${probe.rule}". The prompt tells the seat a rule ` +
        "the scorer does not have, which is a different way of lying to it.",
    );
  }
});

/* -------------------------------------------------------------------------
 * PART 4 — the remediation on a failed authoring run
 * ---------------------------------------------------------------------- */

/**
 * The finding that killed run a913c871, quoted from `runs.failure_reason`.
 *
 * Built the way `spec-validate.ts` builds it — `blocking("other", null, …)` —
 * because the null criterion is the whole subject. Its detail is the parser's
 * own message and remediation, joined by " :: ", exactly as the audit joins
 * them.
 */
const MANIFEST_FINDING: AuditFinding = {
  criterionId: null,
  kind: "other",
  detail:
    'the suite manifest "suite.manifest.json" is not executable by the sealed scorer: ' +
    "dataExpectations[0].id must be a non-empty string :: Set dataExpectations[0].id.",
  mustRegenerate: true,
};

const CRITERION_FINDING: AuditFinding = {
  criterionId: "REQ-004",
  kind: "vacuous",
  detail: 'criterion REQ-004: holdout test T-9 asserts nothing the criterion states',
  mustRegenerate: true,
};

/** An advisory finding never reaches the reasons list and must not steer this. */
const ADVISORY: AuditFinding = {
  criterionId: null,
  kind: "other",
  detail: "advisory: uiFlows[1].description is terse",
  mustRegenerate: false,
};

const AMBIGUITY = /the TICKET is ambiguous/;
const STRUCTURAL = /STRUCTURALLY UNEXECUTABLE/;
const NO_SUITE = /NO auditable suite at all/;

test("a null-criterion failure says the suite is unexecutable and names the field, and does NOT blame the ticket", () => {
  const text = remediationForFailedAuthoring([MANIFEST_FINDING]);

  assert.match(text, STRUCTURAL, "the remediation does not say the suite cannot be executed");
  assert.match(
    text,
    /dataExpectations\[0\]\.id/,
    "the remediation does not name the field. Naming it is the difference between a defect the " +
      "owner can fix in one edit and 87 minutes of auditing a ticket that was never at fault.",
  );

  // THE ASSERTION THIS FIX EXISTS FOR, AND IT IS AN ABSENCE. The old text sent
  // the owner to sharpen a ticket that carried no criterion to be ambiguous
  // about. A test that only checked the new sentence was present would have
  // passed with the accusation still underneath it.
  assert.doesNotMatch(
    text,
    AMBIGUITY,
    "the remediation still blames the ticket on a finding constructed with criterionId = null. " +
      "There is no criterion, so there is nothing to sharpen.",
  );
  assert.doesNotMatch(text, NO_SUITE, "a suite WAS audited; the no-suite branch must not fire");
});

test("a top-level manifest defect names its field too, not only a dataExpectations one", () => {
  // THE GAP THIS CLOSES. The field extractor's alternation is the parser's own
  // `where` prefixes; the top-level scalars are named INLINE in the parser's
  // message ("suite.manifest.json manifestVersion is 2, expected 1") rather
  // than as a `where`, so they were missing from it and this branch emitted the
  // structural paragraph with no field clause at all.
  const text = remediationForFailedAuthoring([
    {
      criterionId: null,
      kind: "other",
      detail:
        'the suite manifest "suite.manifest.json" is not executable by the sealed scorer: ' +
        "suite.manifest.json manifestVersion is 2, expected 1 :: Regenerate the manifest against the " +
        "current scorer protocol.",
      mustRegenerate: true,
    },
  ]);
  assert.match(text, STRUCTURAL);
  assert.match(text, /manifestVersion/, "the remediation names no field on a top-level manifest defect");
  assert.doesNotMatch(text, AMBIGUITY);
});

test("a criterion-bearing failure keeps the ambiguity advice, which is true when there is a criterion", () => {
  const text = remediationForFailedAuthoring([CRITERION_FINDING]);

  assert.match(text, AMBIGUITY, "the ambiguity advice was deleted wholesale rather than branched");
  assert.match(text, /REQ-004/, "the remediation does not name the criterion the owner has to sharpen");
  assert.doesNotMatch(
    text,
    STRUCTURAL,
    "a finding that names a criterion is not a structural defect in the suite document",
  );
  assert.doesNotMatch(text, NO_SUITE);
});

/**
 * THE VACUOUS-TRUTH BRANCH. "Every blocking finding has a null criterion" is
 * TRUE over an empty list, and the list is empty on the commonest failure there
 * is: a response that never parsed. A two-way branch reports a structural
 * manifest defect on a run where no manifest was ever seen.
 */
test("a run whose last attempt never parsed blames neither the ticket nor the suite", () => {
  for (const findings of [[], [ADVISORY]]) {
    const text = remediationForFailedAuthoring(findings);
    assert.match(text, NO_SUITE, "the response-level failure is not named");
    assert.doesNotMatch(text, STRUCTURAL, "no manifest was audited, so nothing structural was measured");
    assert.doesNotMatch(text, AMBIGUITY, "no criterion was measured, so the ticket is not implicated");
  }
});

test("a mixed failure leads with the structural half and keeps both", () => {
  const text = remediationForFailedAuthoring([CRITERION_FINDING, MANIFEST_FINDING]);

  assert.match(text, STRUCTURAL);
  assert.match(text, AMBIGUITY);
  assert.ok(
    text.indexOf("STRUCTURALLY UNEXECUTABLE") < text.search(AMBIGUITY),
    "the ambiguity advice comes first. A suite the scorer cannot parse blocks every configuration " +
      "at once, however sharp the ticket is, so it is the sentence to read first.",
  );
  assert.doesNotMatch(text, /EVERY blocking finding/, "not every finding is structural here");
});

test("every branch still refuses builds and still says raising maxAttempts is not the answer", () => {
  for (const findings of [[], [MANIFEST_FINDING], [CRITERION_FINDING], [CRITERION_FINDING, MANIFEST_FINDING]]) {
    const text = remediationForFailedAuthoring(findings);
    assert.match(text, /Do NOT start builds/, "a branch dropped the instruction that stops the run");
    assert.match(text, /Raising maxAttempts spends more money/, "a branch dropped the cost warning");
  }
});

test("the uniqueness rule the prompt states is enforced across the list", () => {
  const one = entry("sqlite", { id: "same" });
  const two = entry("http", { id: "same" });
  assert.doesNotThrow(() => parseSuiteManifest(manifestWith([one, entry("http", { id: "other" })])));
  assert.throws(
    () => parseSuiteManifest(manifestWith([one, two])),
    /duplicate dataExpectations id/,
    "two entries may share an id, but the prompt tells the seat they may not",
  );
});

/* -------------------------------------------------------------------------
 * PART 4 — THE REGENERATION PROMPT, REPLAYED FROM RUN a913c871's OWN BYTES
 * ---------------------------------------------------------------------- */

/**
 * WHAT IS REAL HERE AND WHAT IS CONSTRUCTED. Say it once, plainly, because a
 * fixture that is described as "the real run" and is not is worse than an
 * obviously synthetic one.
 *
 * REAL, BYTE FOR BYTE: {@link ATTEMPT_1_MANIFEST} and {@link ATTEMPT_2_MANIFEST}
 * are the `suite.manifest.json` entries the spec seat actually emitted on run
 * `run-2026-08-09T21-04-00-713Z-a913c871`, lifted out of the Claude Code CLI's
 * own session transcripts (`~/.claude/projects/…-dashboard/`, sessions
 * `cfdffda9…` 21:06:30→21:31:52 and `60fcb909…` 21:31:54→22:07:19), located by
 * the `StructuredOutput` tool_use input carrying `path: "suite.manifest.json"`.
 * `docs/RUN-a913c871-observations.md` names those transcripts; they still
 * existed on 2026-08-10 and this fixture is the only copy of them inside the
 * repository. Attempt 1's entries are `{entity, source, expectation}` and
 * attempt 2's are `{id, description, entity, minRowCount, readBack}` — the
 * exact "added `id`, still no `kind`, still no `minRows`" shapes the
 * post-mortem tabulated.
 *
 * CONSTRUCTED: the criteria and the two test files. The real suites were
 * 63,957 and 50,125 bytes of structured output across seven test files; what
 * they need to do here is reach the audit carrying ONE defect that is fixed
 * between attempts, and a compact pair does that without pretending to be a
 * portfolio suite.
 *
 * WHY THE FIXTURE MUST PARSE, AND THIS IS THE TRAP THIS FILE WALKED INTO ONCE
 * ALREADY. `spec-agent-ladder.test.ts` scripts every response as unparseable,
 * which is right for measuring a call sequence and fatal here: an unparseable
 * response yields NO `SuiteDraft`, so there is no manifest to echo and the
 * production line that echoes it never executes. A test built on that fixture
 * would assert on a prompt assembled by code that never ran. Every response
 * below is JSON that `parseSuiteDraft` accepts and whose manifest
 * `parseSuiteManifest` rejects — which is precisely what the real run did.
 * `assertReachedTheAudit` below refuses to let that silently regress.
 *
 * ------------------------------------------------------------------------
 * NEGATIVE CONTROLS — mutations applied to PRODUCTION code in `spec-agent.ts`,
 * each run, each WATCHED RED, each restored (2026-08-10). The first two ARE the
 * pre-2026-08-10 behaviour, so they double as the before-state:
 *
 *   mutation                                        test that went red
 *   E  `retryContext()` returns                     "attempt 2 is shown attempt
 *      `previousManifest: null` (the seat is         1's own manifest, verbatim"
 *      told nothing it wrote)                       + "attempt 3 is shown
 *                                                    attempt 2's manifest, not
 *                                                    attempt 1's"
 *   F  `recordConstraints` empties `constraints`    "attempt 3 still carries the
 *      before pushing — i.e. the old                 constraint attempt 1 was
 *      `feedback = <newest>` assignment              given"
 *   G  the three regeneration turns emitted in      "the regeneration turns
 *      the order constraints → prior → ticket        arrive in an order the seat
 *                                                    can resolve"
 *   K  `priorAttemptTurn` sends a CHARACTER         same two as E
 *      COUNT instead of the manifest bytes
 *
 * G IS THE CONTROL ON THE OTHER CONTROLS. E and F both stay GREEN under G:
 * every substring they look for is still somewhere in the prompt, just in an
 * order that makes "which document is the ticket and which is my last answer?"
 * a guess. Presence assertions cannot see ordering, so ordering is asserted
 * separately.
 *
 * K IS THE CONTROL ON "VERBATIM". A recap that described the manifest instead
 * of quoting it would satisfy every "the prompt mentions the previous attempt"
 * assertion and would reproduce the original defect exactly: what run
 * `a913c871`'s seat lost was the document, not the knowledge that a document
 * had existed.
 *
 * PART 5's mutations are listed in its own section header.
 */

/** Run `a913c871` attempt 1's manifest. Real bytes. No `id`, no `kind`, no `minRows`. */
const ATTEMPT_1_MANIFEST = `{
  "manifestVersion": 1,
  "ticketId": "t-b79ff5e2a1b314e4",
  "target": "web",
  "execution": {
    "install": null,
    "build": null,
    "typecheck": null,
    "lint": null,
    "start": "npm start",
    "port": 3000,
    "healthPath": "/api/health",
    "bootTimeoutMs": null,
    "commandTimeoutMs": null
  },
  "sourceDirs": ["."],
  "uiFlows": [
    { "id": "home", "path": "/", "description": "hero with name, role, one line, and the six-project selected-work strip", "waitForSelector": null },
    { "id": "work", "path": "/work", "description": "six CV project cards, each with its own illustration", "waitForSelector": null },
    { "id": "about", "path": "/about", "description": "career narrative, roles with dates, and the skills list", "waitForSelector": null },
    { "id": "contact", "path": "/contact", "description": "contact form posting to /api/contact and rendering the server response", "waitForSelector": null }
  ],
  "dataExpectations": [
    { "entity": "contact_message", "source": "POST /api/contact", "expectation": "every accepted submission is written to the SQLite file with name, email, message and a timestamp, survives a restart, and is only readable through GET /api/messages with the correct bearer token" },
    { "entity": "project", "source": "GET /api/projects", "expectation": "at least six project rows seeded into SQLite on first boot covering Teewise, Trade Assistant, JobSilver, Kori, Parts Agent and CrewFlow" }
  ]
}`;

/** Run `a913c871` attempt 2's manifest. Real bytes. `id` added; still no `kind`, no `minRows`. */
const ATTEMPT_2_MANIFEST = `{
  "manifestVersion": 1,
  "ticketId": "t-b79ff5e2a1b314e4",
  "target": "web",
  "execution": {
    "install": null,
    "build": null,
    "typecheck": null,
    "lint": null,
    "start": "npm start",
    "port": 3000,
    "healthPath": "/api/health",
    "bootTimeoutMs": null,
    "commandTimeoutMs": null
  },
  "sourceDirs": ["."],
  "uiFlows": [
    { "id": "home", "path": "/", "description": "Hero with name, role and the selected-work strip", "waitForSelector": null },
    { "id": "work", "path": "/work", "description": "Project cards drawn from the CV", "waitForSelector": null },
    { "id": "about", "path": "/about", "description": "Career narrative, roles with dates and the skills list", "waitForSelector": null },
    { "id": "contact", "path": "/contact", "description": "Contact form posting to /api/contact", "waitForSelector": null }
  ],
  "dataExpectations": [
    {
      "id": "contact-messages-stored",
      "description": "Accepted contact submissions are stored in SQLite with a timestamp and survive a restart",
      "entity": "messages",
      "minRowCount": 1,
      "readBack": "GET /api/messages with the configured bearer token"
    },
    {
      "id": "projects-seeded",
      "description": "The six CV projects are seeded into SQLite on first boot and served from there",
      "entity": "projects",
      "minRowCount": 6,
      "readBack": "GET /api/projects"
    }
  ]
}`;

/**
 * Not a credential and not shaped like one. The base caller resolves the seat's
 * key BY NAME at construction and refuses to build without it; nothing here
 * reaches a network, and the value must not match `PLACEHOLDER_RE` in `env.ts`.
 */
const SENTINEL = ["BAKEOFF", "TEST", "NO", "API", "KEY"].join("-");

const REPLAY_BRIEF =
  "Build a portfolio site whose contact form stores each submission in SQLite, whose /api/messages " +
  "endpoint reads them back behind a bearer token, and whose /api/projects list is served from the " +
  "same database.";

/**
 * The id is run `a913c871`'s real re-minted ticket id, so it matches the
 * `ticketId` inside both real manifests. The brief is not the real 190-line
 * one: `assertTicketUnedited` checks only that the brief matches its own
 * digest, and a 190-line brief in a fixture is 190 lines nobody reads.
 */
const REPLAY_TICKET: Ticket = Object.freeze({
  id: "t-b79ff5e2a1b314e4",
  brief: REPLAY_BRIEF,
  sha256: ticketDigest(REPLAY_BRIEF),
  tier: "hard",
  title: "a913c871 replay",
});

/** A credential-shaped literal — the defect attempt 1 was told about and attempt 2 repeated. */
const LEAKY_SOURCE =
  'const AUTHORIZATION_HEADER = "Bearer sk-live-AbCdEf0123456789AbCdEf0123456789";\n' +
  'test("[REQ-001] T-1 messages are readable with the token", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/messages", { headers: { authorization: AUTHORIZATION_HEADER } });\n' +
  "  if (r.status !== 200) throw new Error(String(r.status));\n" +
  "});\n";

/** The same test with the leak repaired. Everything else about it is identical. */
const CLEAN_SOURCE =
  'const TOKEN_FIXTURE = "not-a-real-token";\n' +
  'test("[REQ-001] T-1 messages are readable with the token", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/messages", { headers: { authorization: "Bearer " + TOKEN_FIXTURE } });\n' +
  "  if (r.status !== 200) throw new Error(String(r.status));\n" +
  "});\n";

const REPLAY_HOLDOUT_SOURCE =
  'test("[REQ-001] T-2 a submission survives a restart", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/contact", { method: "POST" });\n' +
  "  if (r.status !== 201) throw new Error(String(r.status));\n" +
  "});\n";

/** One scripted authoring response: a suite that parses, carrying the given manifest. */
function replayResponse(manifest: string, visibleSource: string): string {
  return JSON.stringify({
    criteria: [
      {
        id: "REQ-001",
        statement:
          "When a visitor submits the contact form, the system shall store the submission in SQLite.",
        evidenceRequired: "holdout test T-2 PASS and data expectation contact-messages-stored met",
        tier: "BLOCKING",
        holdoutTestIds: ["T-2"],
        visibleTestIds: ["T-1"],
        evidenceArtifacts: [],
        // REQUIRED BY `parseSuiteDraft`, EMPTY BECAUSE `REPLAY_BRIEF` DECLARES
        // NO ACCEPTANCE SIGNALS. `acceptanceSignals("...")` returns [] for it —
        // no "how I will know" heading — so this suite is required to cover
        // nothing and the rule's no-op arm is what runs here.
        coversAcceptanceSignals: [],
      },
      {
        id: "REQ-002",
        statement: "The system shall serve the project list from the database.",
        evidenceRequired: "holdout test T-2 PASS",
        tier: "FUNCTIONAL",
        holdoutTestIds: ["T-2"],
        visibleTestIds: ["T-1"],
        evidenceArtifacts: [],
        // REQUIRED BY `parseSuiteDraft`, EMPTY BECAUSE `REPLAY_BRIEF` DECLARES
        // NO ACCEPTANCE SIGNALS. `acceptanceSignals("...")` returns [] for it —
        // no "how I will know" heading — so this suite is required to cover
        // nothing and the rule's no-op arm is what runs here.
        coversAcceptanceSignals: [],
      },
    ],
    testFiles: [
      {
        path: "holdout/contact-api.test.mjs",
        visibility: "holdout",
        runner: "node-test",
        description: "held-out contact API checks",
        testIds: ["T-2"],
        criterionIds: ["REQ-001", "REQ-002"],
        source: REPLAY_HOLDOUT_SOURCE,
      },
      {
        path: "visible/contact-api.test.mjs",
        visibility: "visible",
        runner: "node-test",
        description: "visible twin",
        testIds: ["T-1"],
        criterionIds: ["REQ-001", "REQ-002"],
        source: visibleSource,
      },
      {
        path: "suite.manifest.json",
        visibility: "visible",
        runner: "node-test",
        description: "the scorer's execution manifest",
        testIds: [],
        criterionIds: [],
        source: manifest,
      },
    ],
  });
}

/** Records every request and replays a scripted response body. */
class ReplayCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];
  readonly #script: readonly string[];

  constructor(seat: AnthropicSeat, script: readonly string[]) {
    super(seat, { budget: AUTHORING_BUDGET, env: { [seat.envKeyName]: SENTINEL } });
    this.#script = script;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    return {
      text: this.#script[this.requests.length - 1] ?? "",
      stopReason: "end_turn",
      usage: { costUsd: 0 },
    } as unknown as SeatCallResult;
  }
}

interface Replay {
  readonly spec: ReplayCaller;
  readonly error: BakeoffError;
}

/**
 * Three attempts: attempt 1 leaks a credential-shaped literal AND carries the
 * real broken manifest; attempt 2 REPAIRS the leak and carries the real
 * partially-repaired manifest; attempt 3 repeats attempt 2. That is the shape
 * the accumulation claim needs — a defect that exists on attempt 1 and not on
 * attempt 2, so "attempt 3 still knows about it" cannot be satisfied by simply
 * forwarding the newest list.
 */
async function replayRun(): Promise<Replay> {
  const spec = new ReplayCaller(SPEC_SEAT, [
    replayResponse(ATTEMPT_1_MANIFEST, LEAKY_SOURCE),
    replayResponse(ATTEMPT_2_MANIFEST, CLEAN_SOURCE),
    replayResponse(ATTEMPT_2_MANIFEST, CLEAN_SOURCE),
  ]);
  const judge = new ReplayCaller(JUDGE_SEAT, []);
  try {
    await generateAuditedSuite(REPLAY_TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      // `node --check` would spawn a child process per file for sources whose
      // syntax is not what is under test here.
      syntaxCheck: false,
      /*
       * REPAIR OFF, BECAUSE THIS DRIVER MEASURES THE OTHER CHANNEL. Everything
       * below asserts what a REGENERATION is told — the manifest echo and the
       * accumulated constraints, both of which only exist between attempts.
       * With repair at its default of 1 this fixture's rejections (which name
       * `suite.manifest.json`) are localisable, so attempt 1 would be followed
       * by a repair round and `spec.requests[1]` would be a repair prompt: the
       * assertions would still be about a real prompt, just not the one they
       * name. The within-attempt channel has its own driver and its own
       * negative control in spec-repair.test.ts.
       *
       * This is also the seam where a future edit could silently delete the
       * regeneration path: if repair ever became unconditional, these tests
       * would be the only thing still exercising the turns above.
       */
      maxRepairRounds: 0,
    });
  } catch (error) {
    assert.ok(error instanceof BakeoffError, `expected a BakeoffError, got ${String(error)}`);
    return { spec, error };
  }
  throw new Error("the replay was expected to fail: every scripted manifest is unscorable");
}

/**
 * THE ARM CHECK. Every assertion below is about the CONTENT of a regeneration
 * prompt, and a regeneration prompt only exists if the audit actually rejected
 * something. If the fixture ever stops parsing — a renamed tier, a stricter
 * validator, a typo — the run fails at `parseSuiteDraft` instead, the manifest
 * echo is never reached, and the tests would go on asserting about a code path
 * that did not execute. `docs/RUN-a913c871-observations.md` catalogues twenty
 * checks that could only observe success; this file is not adding one.
 */
function assertReachedTheAudit(replay: Replay): void {
  assert.equal(
    replay.spec.requests.length,
    3,
    "the replay must make three authoring calls; fewer means an attempt died before the audit",
  );
  assert.match(
    replay.error.message,
    /is not executable by the sealed scorer/,
    "the fixture no longer reaches the MANIFEST audit — it is failing earlier (probably " +
      "parseSuiteDraft), so nothing below is measuring the regeneration prompt",
  );
  assert.doesNotMatch(
    replay.error.message,
    /response\.(criteria|testFiles)/,
    "the fixture stopped parsing: `parseSuiteDraft` problems are in the failure, which means the " +
      "draft never became a draft and there was never a manifest to echo",
  );
}

const turnsOf = (replay: Replay, attempt: number): readonly string[] => {
  const request = replay.spec.requests[attempt - 1];
  assert.ok(request !== undefined, `no request recorded for attempt ${String(attempt)}`);
  return request.userTurns;
};

const promptOf = (replay: Replay, attempt: number): string => turnsOf(replay, attempt).join("\n");

/**
 * ATTEMPT 1 IS UNTOUCHED, AND THE REASON IS THE FREEZE DIGEST.
 * `authoringPromptSha256` is recorded on every frozen suite. A ticket whose
 * first attempt succeeds must produce the same digest it produced before
 * 2026-08-10, or suites frozen either side of this change stop being
 * comparable — and comparability of the frozen suite is held-constant variable
 * 5. Asserted as an exact equality against the turn built from the ticket, not
 * as "one turn": a turn that gained a marker would still be one turn.
 */
test("attempt 1's prompt is exactly the ticket turn, unchanged and unlabelled", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);

  assert.deepEqual(turnsOf(replay, 1), [
    `TICKET ${REPLAY_TICKET.id}\n\nThe ticket text follows between the markers, verbatim. ` +
      `Everything you need is in it.\n\n<<<TICKET_BRIEF\n${REPLAY_TICKET.brief}\nTICKET_BRIEF>>>`,
  ]);
});

/**
 * THE HEADLINE. Run `a913c871`'s attempt 2 was told *"your previous suite …
 * has been discarded … you no longer have it"* and given one complaint. It
 * added `id` and rewrote everything else. This asserts the bytes it should have
 * been holding are in the prompt.
 *
 * VERBATIM, NOT PARAPHRASED: the assertion is `includes(ATTEMPT_1_MANIFEST)` on
 * the whole 1,468-byte document. A summary, a field list or a re-serialisation
 * would all pass a "mentions dataExpectations" test and would all reintroduce
 * the defect, because what the seat lost was the exact document.
 */
test("attempt 2 is shown attempt 1's own manifest, verbatim", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);
  const prompt = promptOf(replay, 2);

  assert.ok(
    prompt.includes(ATTEMPT_1_MANIFEST),
    "attempt 2's prompt does not contain attempt 1's manifest. This is the exact defect that made " +
      "run a913c871 unconvergeable: the seat was told its previous suite had been discarded and " +
      "was handed one field name to fix on a document it could no longer see.",
  );
  assert.match(
    prompt,
    /YOUR OWN output from an earlier attempt/,
    "the manifest is in the prompt but not identified as the seat's own prior output",
  );
  assert.doesNotMatch(
    prompt,
    /you no longer have it/,
    "the sentence that caused the defect is still in the regeneration prompt",
  );
});

/**
 * THE OTHER HALF, AND IT IS NOT THE SAME CLAIM. A retry could echo the previous
 * manifest and still forward only the newest complaint list; attempt 3 would
 * then be holding attempt 2's document with attempt 2's complaints and no
 * memory of what attempt 1 was told. Measured on the real run: attempt 1 was
 * told about a credential-shaped literal, attempt 2 never saw that sentence
 * again, and attempt 3 was told about the SAME defect in two files.
 *
 * The fixture repairs the leak on attempt 2 deliberately, so the complaint is
 * absent from attempt 2's own findings. Finding it in attempt 3's prompt is
 * therefore only possible by accumulation.
 */
test("attempt 3 still carries the constraint attempt 1 was given", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);

  const second = promptOf(replay, 2);
  const third = promptOf(replay, 3);

  assert.match(second, /credential-shaped literal/, "attempt 1's leak was never reported at all");
  // THE CONTROL ON THE CLAIM: the leak really is gone from attempt 2's suite,
  // so its reappearance in attempt 3's prompt cannot be the newest list.
  assert.ok(
    !replay.spec.requests[2]?.userTurns.some((t) => t.includes(CLEAN_SOURCE)),
    "the fixture is not doing what the docblock says it does",
  );
  assert.match(
    third,
    /credential-shaped literal/,
    "attempt 3 was not told about the defect attempt 1 was told about. The accumulated constraint " +
      "set is not accumulating — this is `feedback = <newest>` again, and it is why attempt 3 of " +
      "run a913c871 threw away the `id` it had already got right.",
  );
  assert.match(
    third,
    /FROM ATTEMPT 1:/,
    "the constraints are not attributed to the attempt that earned them",
  );
  assert.match(third, /FROM ATTEMPT 2:/, "attempt 2's own constraints are missing from attempt 3");
});

/**
 * THE MANIFEST SHOWN IS THE LATEST ONE THAT EXISTS, not the first one ever
 * seen. A recap that pinned attempt 1's document would hand attempt 3 a
 * manifest two revisions stale and tell it to keep the parts that were
 * accepted — advice about a document it had already replaced.
 */
test("attempt 3 is shown attempt 2's manifest, not attempt 1's", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);
  const third = promptOf(replay, 3);

  assert.ok(third.includes(ATTEMPT_2_MANIFEST), "attempt 3 is not holding attempt 2's manifest");
  assert.ok(
    !third.includes(ATTEMPT_1_MANIFEST),
    "attempt 3 is holding attempt 1's manifest as well — two conflicting documents, and the seat " +
      "has no way to know which one it is being asked to repair",
  );
  assert.match(third, /Attempt 2 emitted this as/, "the manifest is not attributed to an attempt");
});

/**
 * ORDERING, ASSERTED SEPARATELY FROM PRESENCE. Mutation G — emitting the same
 * three turns back to front — leaves every assertion above GREEN. A seat that
 * reads its complaints before it has seen the document they are about, and the
 * document before the ticket, is being asked to resolve the references
 * backwards.
 */
test("the regeneration turns arrive in an order the seat can resolve", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);
  const turns = turnsOf(replay, 2);

  assert.equal(turns.length, 3, "a regeneration is three turns: ticket, prior attempt, constraints");
  assert.ok(turns[0]?.startsWith(TURN_MARKER_TICKET), "turn 1 is not labelled as the ticket");
  assert.ok(turns[1]?.startsWith(TURN_MARKER_PRIOR), "turn 2 is not labelled as the prior attempt");
  assert.ok(
    turns[2]?.startsWith(TURN_MARKER_CONSTRAINTS),
    "turn 3 is not labelled as the constraint set",
  );

  const flat = turns.join("\n");
  assert.ok(
    flat.indexOf(TURN_MARKER_TICKET) <
      flat.indexOf(TURN_MARKER_PRIOR) &&
      flat.indexOf(TURN_MARKER_PRIOR) < flat.indexOf(TURN_MARKER_CONSTRAINTS),
    "the markers are present but out of order, so which document is which is a guess",
  );
});

/**
 * THE BOUNDARY, ASSERTED RATHER THAN ARGUED. {@link AuthoringRetryContext}'s
 * docblock claims this change hands the seat nothing but its own prior output
 * and the harness's own rejections. A docblock is not a check. Everything in
 * every regeneration turn must be traceable to the ticket, the seat's own
 * scripted response, or an audit sentence — so a future edit that folds in a
 * workspace path, a builder log or a file read goes red here.
 */
/*
 * NARROWED 2026-08-10, AND THE REASON IS THAT A GUARD WHICH REDDENS ON A BENIGN
 * WORD BECOMES A DELETED GUARD.
 *
 * The first version of this test forbade /workspace/i, /builder/i and
 * /\bimplementation\b/i anywhere in the prompt. Those are ORDINARY WORDS in the
 * vocabulary this prompt legitimately carries: the audit finding kind is literally
 * `leaks_implementation`, `recovery.ts`'s own sentences use "builder", and any
 * judge-seat prose about a suite that describes an implementation would trip it.
 * The property being guarded is real — every constraint originates in
 * `stopReasonProblem`, `redactText` of the seat's own JSON, `blockingFindingSummary`
 * or `attemptTimeoutProblem` — but a check whose first failure is a false alarm
 * gets read as a flake and then removed, and the seal loses its only assertion.
 *
 * So the word list is replaced by two things that cannot come from inside the seal:
 *
 *   SHAPES, not words — an absolute path, a `node_modules/` segment, a git command,
 *   a unified-diff hunk header. None of those can be produced by the ticket, by the
 *   seat's own JSON, or by the validator's sentences.
 *
 *   PROVENANCE, which is the assertion the word list was standing in for — every
 *   numbered constraint's file references and the whole of the echoed prior
 *   manifest must be traceable to bytes THE SEAT ITSELF EMITTED (its scripted
 *   responses) or to the ticket. That is checkable here because the replay knows
 *   exactly what the seat said.
 */
test("a regeneration prompt carries nothing the seat could not already see", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);

  /*
   * THE CORPUS IS WHAT IS INSIDE THE SEAL: the ticket as the harness serialises
   * it, plus every byte the seat itself produced. Anything in a regeneration turn
   * that names a file not in here came from somewhere the spec seat may not see.
   */
  const inTheSeal = [
    JSON.stringify(REPLAY_TICKET),
    replayResponse(ATTEMPT_1_MANIFEST, LEAKY_SOURCE),
    replayResponse(ATTEMPT_2_MANIFEST, CLEAN_SOURCE),
  ].join("\n");

  for (const attempt of [2, 3]) {
    const prompt = promptOf(replay, attempt);

    for (const forbidden of [
      // An absolute POSIX path. Nothing inside the seal has a filesystem root.
      /(?:^|[\s"'(])\/(?:Users|home|var|tmp|private|opt|etc)\//,
      /node_modules\//,
      /\bgit (?:diff|log|status|show|apply)\b/i,
      // A unified-diff hunk header, i.e. a patch pasted into the prompt.
      /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m,
      /^(?:\+\+\+|---) [ab]\//m,
    ]) {
      assert.doesNotMatch(
        prompt,
        forbidden,
        `attempt ${String(attempt)}'s prompt matches ${String(forbidden)}. The spec seat is sealed ` +
          "(tools: [], no history, no workspace) and that seal is what makes held_out_pass mean " +
          "anything. Its own previous manifest is inside the seal; anything from the build is not.",
      );
    }

    /*
     * PROVENANCE 1 — EVERY NUMBERED CONSTRAINT'S FILE REFERENCES. The constraint
     * bullets are the only free-form text in this turn, and a leak would arrive
     * naming a file: a builder log path, a source file from the workspace, a
     * `package.json`. Each token that looks like a file must be one the seat
     * itself wrote, or the manifest filename the harness owns.
     */
    const bullets = [...prompt.matchAll(/^\s+\d+\. (.*)$/gm)].map((m) => m[1] ?? "");
    assert.ok(
      bullets.length > 0,
      `attempt ${String(attempt)} carries no numbered constraints, so this test is asserting ` +
        "provenance over an empty list — vacuously true and worth nothing",
    );
    for (const bullet of bullets) {
      for (const token of bullet.match(/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|json)\b/g) ?? []) {
        assert.ok(
          inTheSeal.includes(token) || token === SUITE_MANIFEST_FILENAME,
          `a constraint shown to attempt ${String(attempt)} names "${token}", which appears nowhere ` +
            "in the ticket or in the seat's own responses. A constraint may only be built from what " +
            "the seat emitted and what the harness measured about it; a file name from anywhere else " +
            "is the seal leaking. Bullet: " + bullet,
        );
      }
    }

    /*
     * PROVENANCE 2 — THE ECHOED DOCUMENT IS THE SEAT'S OWN, WHOLE, AND ALONE.
     * The prior-attempt turn fences the manifest with `<<<PREVIOUS_MANIFEST`. What
     * is between the fences must be byte-equal to a manifest the seat emitted —
     * not a re-serialisation, not a merge, and not a second document beside it.
     */
    const fenced = /<<<PREVIOUS_MANIFEST\n([\s\S]*?)\nPREVIOUS_MANIFEST>>>/.exec(prompt);
    assert.ok(fenced !== null, `attempt ${String(attempt)} echoes no fenced previous manifest`);
    const echoed = fenced?.[1] ?? "";
    assert.ok(
      echoed === ATTEMPT_1_MANIFEST || echoed === ATTEMPT_2_MANIFEST,
      `attempt ${String(attempt)}'s echoed manifest is not byte-equal to anything the seat emitted. ` +
        "A re-serialised or merged document is the harness putting words in the seat's mouth, and the " +
        "field it silently normalises is the field the next attempt will lose.",
    );
    assert.equal(
      (prompt.match(/<<<PREVIOUS_MANIFEST/g) ?? []).length,
      1,
      `attempt ${String(attempt)} carries more than one fenced document, so which one it is being ` +
        "asked to repair is a guess",
    );
  }
});

/* -------------------------------------------------------------------------
 * PART 5 — THE PER-CALL WALL-CLOCK BOUND
 * ---------------------------------------------------------------------- */

/**
 * WHAT WENT WRONG, MEASURED. Run `a913c871`'s three authoring attempts ran
 * 25m23s, 35m25s and 23m43s with no wall-clock bound of any kind. 84 minutes 31
 * seconds passed between the phase starting and the run dying, and the events
 * table acquired six rows in that window, all `rate_limit` telemetry. Nothing
 * in the harness could distinguish a call that was thinking from a call that
 * was never coming back.
 *
 * WHY THE BOUND IS PER CALL AND NOT PER ATTEMPT. The free truncation retry
 * dispatches a second call inside the same attempt. A per-attempt budget would
 * hand that retry whatever was left — so an attempt that burned 29 of its 30
 * minutes and then truncated would get a one-minute retry and lose the ladder
 * silently, on the mechanism the previous round made visible.
 *
 * THE STUB NEVER RESOLVES, DELIBERATELY. It returns `new Promise(() => {})`
 * with no timer and no handle, so it holds nothing open and cannot itself end
 * the test. Before the bound existed these tests did not fail — they HUNG, and
 * `node --test` cancelled them on its own timeout. That is the watched red.
 *
 * NEGATIVE CONTROLS for part 5 — production mutations in `spec-agent.ts`, each
 * run, each WATCHED RED, each restored (2026-08-10):
 *
 *   mutation                                        result
 *   H  `callWithDeadline` returns `work`            both hang tests CANCELLED
 *      unconditionally — the pre-2026-08-10          at 20,000 ms ("tests 28,
 *      state, no bound at all                        pass 26, fail 0,
 *                                                    cancelled 2", exit 1)
 *   J  `describeAttemptTimeouts` can never          "the failure names the
 *      report a hit                                  bound, which attempts hit
 *                                                    it, and that they were not
 *                                                    cancelled"
 *   L  the no-hit sentence reduced to the bound     "a run where nothing timed
 *      alone                                         out says so"
 *   M  the resolver reads `options.env ?? {}`       "the override is read from
 *      instead of `?? process.env`                   the real process
 *                                                    environment"
 *   N  a timed-out attempt records no              "the attempt after a timeout
 *      constraint — the outcome exists but the      is told it timed out, and
 *      ladder cannot act on it                      told to write less"
 *   O  the NO-timeout sentence rewritten to        "a run where nothing timed
 *      contain `TIMEOUT_FAILURE_MARKER`             out says so"
 *
 * O IS THE CONTROL ON THE HANDOFF. `TIMEOUT_FAILURE_MARKER` is the substring
 * `recovery.ts` is meant to key on to tell an abandoned call apart from an
 * audited-and-rejected suite. If the negative sentence also contained it, every
 * non-timeout failure would classify as a timeout — the signature defect,
 * arriving from the classifier's side. The exclusion is asserted, not assumed.
 *
 * J AND L ARE THE SAME LINE FROM OPPOSITE SIDES, and both are needed: J proves
 * the positive report can fail, L proves the NEGATIVE report can. A wall-clock
 * line that only speaks when it fires is indistinguishable from one that is
 * disabled, which is the reading run `a913c871` had to reconstruct by hand for
 * the truncation ladder.
 *
 * M IS THE ONE THAT DECIDES WHETHER ANY OF THIS REACHES PRODUCTION. Everything
 * else here can be green while the only channel the orchestrator has — the
 * environment — is unwired.
 */
/** Never resolves, never rejects, holds nothing open. */
const HANG = null;

class HangingCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];
  readonly #script: readonly (string | null)[];

  constructor(seat: AnthropicSeat, script: readonly (string | null)[]) {
    super(seat, { budget: AUTHORING_BUDGET, env: { [seat.envKeyName]: SENTINEL } });
    this.#script = script;
  }

  get calls(): number {
    return this.requests.length;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    const scripted = this.#script[this.requests.length - 1] ?? HANG;
    if (scripted === HANG) return new Promise<SeatCallResult>(() => undefined);
    return { text: scripted, stopReason: "end_turn", usage: { costUsd: 0 } } as unknown as SeatCallResult;
  }
}

async function runAgainstAHang(
  options: {
    readonly attemptTimeoutMs?: number;
    readonly env?: NodeJS.ProcessEnv;
  },
  script: readonly (string | null)[] = [],
): Promise<{ readonly spec: HangingCaller; readonly error: BakeoffError }> {
  const spec = new HangingCaller(SPEC_SEAT, script);
  const judge = new ReplayCaller(JUDGE_SEAT, []);
  try {
    await generateAuditedSuite(REPLAY_TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      syntaxCheck: false,
      /*
       * REPAIR OFF: every assertion downstream indexes `spec.requests` BY
       * ATTEMPT, and a repair round is a call inside an attempt. With repair at
       * its default this driver's `requests[2]` is attempt 2's repair prompt
       * rather than attempt 3's authoring prompt, and the assertions would be
       * reading the wrong document while still passing or failing for reasons
       * about the timeout bound. The bound is what this driver measures; see
       * spec-repair.test.ts for the loop that is not.
       */
      maxRepairRounds: 0,
      ...options,
    });
  } catch (error) {
    assert.ok(error instanceof BakeoffError, `expected a BakeoffError, got ${String(error)}`);
    return { spec, error };
  }
  throw new Error("a run whose every call hangs cannot succeed");
}

test(
  "an authoring call that never returns is abandoned on the bound, and the ladder keeps going",
  { timeout: 20_000 },
  async () => {
    const { spec, error } = await runAgainstAHang({ attemptTimeoutMs: 150 });

    assert.equal(
      spec.calls,
      DEFAULT_MAX_AUTHORING_ATTEMPTS,
      "a timeout must consume exactly one attempt and let the next one start. Fewer calls means " +
        "the timeout aborted the loop; more means it bought a free retry it is not entitled to.",
    );
    assert.equal(error.code, "suite_not_audited");
  },
);

/**
 * A TIMEOUT IS NOT A TRUNCATION, AND THE LADDER MUST NOT TREAT IT AS ONE.
 * Raising `max_tokens` for a call that never came back buys a longer call. The
 * assertion above (exactly `DEFAULT_MAX_AUTHORING_ATTEMPTS` calls) is what
 * makes this checkable: a truncation would have produced attempts + 1.
 */
test("the failure names the bound, which attempts hit it, and that they were not cancelled", { timeout: 20_000 }, async () => {
  const { error } = await runAgainstAHang({ attemptTimeoutMs: 150 });

  assert.ok(
    error.message.includes(`Attempt(s) 1, 2, 3 ${TIMEOUT_FAILURE_MARKER}`),
    "the failure does not say which attempts were abandoned, so runs.failure_reason cannot tell a " +
      "harness-cut call apart from a suite the audit rejected",
  );
  assert.match(
    error.message,
    /NOT cancelled/,
    "the failure claims the calls were stopped. They were abandoned: SeatCallRequest carries no " +
      "AbortSignal and the seat subprocess keeps running.",
  );
  assert.doesNotMatch(
    error.message,
    /No attempt was abandoned/,
    "a run whose attempts all timed out must not carry the sentence saying none did",
  );
});

/**
 * WHAT THE RETRY DOES DIFFERENTLY AFTER A TIMEOUT, ASSERTED AT THE PROMPT.
 * "First-class outcome the ladder can act on" is only worth the phrase if the
 * NEXT attempt is told something it would not otherwise have been told. A
 * timeout produces no suite, so there is nothing for the audit to complain
 * about; without this the next attempt would receive an empty constraint set
 * and a silent absence where its own previous manifest should be, and would
 * behave exactly like a first attempt that had already burned half an hour.
 */
test("the attempt after a timeout is told it timed out, and told to write less", { timeout: 20_000 }, async () => {
  const { spec } = await runAgainstAHang({ attemptTimeoutMs: 150 }, [
    HANG,
    replayResponse(ATTEMPT_2_MANIFEST, CLEAN_SOURCE),
    replayResponse(ATTEMPT_2_MANIFEST, CLEAN_SOURCE),
  ]);

  const second = spec.requests[1]?.userTurns.join("\n") ?? "";
  assert.match(second, /FROM ATTEMPT 1:/, "the timeout did not become a constraint the next attempt sees");
  assert.match(
    second,
    /did not return within 0 minute\(s\) and was abandoned/,
    "the next attempt is not told that the previous call was abandoned rather than answered",
  );
  assert.match(
    second,
    /Emit a SMALLER suite/,
    "the next attempt is told what happened and not what to do differently, which buys another " +
      "identical timeout at the same price",
  );
  assert.match(
    second,
    /THERE IS NO MANIFEST TO SHOW YOU/,
    "a timed-out attempt produced no manifest, and the absence must be stated rather than left " +
      "as a missing turn the seat reads as 'you have no previous attempt'",
  );

  const third = spec.requests[2]?.userTurns.join("\n") ?? "";
  assert.ok(
    third.includes(ATTEMPT_2_MANIFEST),
    "attempt 3 must be holding attempt 2's manifest: the run recovered from the timeout and the " +
      "recap has to recover with it",
  );
  assert.match(third, /FROM ATTEMPT 1:/, "the timeout constraint was dropped once a suite arrived");
});

/**
 * THE NEGATIVE DIRECTION, AND IT IS THE HALF THAT KEEPS THE OTHER HALF HONEST.
 * A bound that reports only when it fires cannot be told apart from a bound
 * that is disabled or absent. Run `a913c871`'s post-mortem needed an argument
 * from the shape of an unrelated error message to establish that the truncation
 * ladder had NOT fired; this sentence is that argument, pre-written.
 */
test("a run where nothing timed out says so, and names the bound in force", async () => {
  const replay = await replayRun();
  assertReachedTheAudit(replay);

  assert.match(
    replay.error.message,
    /Per-call wall-clock bound: 60 minute\(s\)\. No attempt was abandoned on the per-call wall-clock bound/,
    "a run where the bound never fired must say both what the bound was and that it did not fire",
  );
  // THE NUMBER IS READ FROM THE CONSTANT AS WELL AS MATCHED AS TEXT, so a change
  // to the default cannot leave this file asserting a bound that is not in force.
  assert.match(
    replay.error.message,
    new RegExp(`Per-call wall-clock bound: ${String(DEFAULT_ATTEMPT_TIMEOUT_MS / 60_000)} minute\\(s\\)`),
    "the reported bound is not the default this build ships",
  );

  // THE DISCRIMINATOR MUST NOT FIRE HERE. `recovery.ts` keys on
  // TIMEOUT_FAILURE_MARKER to tell an abandoned call apart from an audited and
  // rejected suite. If the marker were a substring the NEGATIVE sentence also
  // contains, every non-timeout failure would classify as a timeout — a check
  // that can only observe success, arriving from the classifier's side.
  assert.ok(
    !replay.error.message.includes(TIMEOUT_FAILURE_MARKER),
    `the timeout discriminator "${TIMEOUT_FAILURE_MARKER}" appears in the failure message of a run ` +
      "where nothing timed out, so no caller can use it to discriminate anything",
  );
});

/**
 * THE ENV OVERRIDE IS THE ONLY CHANNEL PRODUCTION HAS. `orchestrator.ts` passes
 * nine options to `authorAndFreezeSuite` and `attemptTimeoutMs` is not one of
 * them, so an opt-in option would be an option nobody sets — the failure mode
 * this file already documents about `onEvent`. The bound is default-on and the
 * environment moves it.
 */
test("the environment can tighten, loosen and disable the bound", async () => {
  assert.equal(resolveAttemptTimeoutMs({ env: {} }), DEFAULT_ATTEMPT_TIMEOUT_MS);
  assert.equal(
    resolveAttemptTimeoutMs({ env: { [ATTEMPT_TIMEOUT_ENV_NAME]: "5" } }),
    5 * 60 * 1000,
    "minutes, to match BAKEOFF_SCORER_TIMEOUT_MIN — the only other timeout this repo exports",
  );
  assert.equal(
    resolveAttemptTimeoutMs({ env: { [ATTEMPT_TIMEOUT_ENV_NAME]: "0" } }),
    Number.POSITIVE_INFINITY,
    "0 must disable the bound rather than mean an instant timeout",
  );
  assert.equal(
    resolveAttemptTimeoutMs({ attemptTimeoutMs: 1234, env: { [ATTEMPT_TIMEOUT_ENV_NAME]: "5" } }),
    1234,
    "an explicit option outranks the environment",
  );
});

/**
 * `process.env`, NOT ONLY AN INJECTED `env` BAG — and this is the assertion
 * that decides whether the override exists in production at all.
 * `orchestrator.ts` passes no `env` to `authorAndFreezeSuite`, so if the
 * resolver fell back to `{}` instead of `process.env` every test above would
 * stay green and the owner's `BAKEOFF_SPEC_ATTEMPT_TIMEOUT_MIN=…` would do
 * nothing. Written and restored around the read, because a test that leaks an
 * env var into the rest of the file is a test that breaks a sibling.
 */
test("the override is read from the real process environment, which is what production has", () => {
  const before = process.env[ATTEMPT_TIMEOUT_ENV_NAME];
  try {
    process.env[ATTEMPT_TIMEOUT_ENV_NAME] = "7";
    assert.equal(
      resolveAttemptTimeoutMs({}),
      7 * 60 * 1000,
      "the resolver does not read process.env, so no production caller can move this bound",
    );
  } finally {
    if (before === undefined) delete process.env[ATTEMPT_TIMEOUT_ENV_NAME];
    else process.env[ATTEMPT_TIMEOUT_ENV_NAME] = before;
  }
  assert.equal(resolveAttemptTimeoutMs({}), DEFAULT_ATTEMPT_TIMEOUT_MS, "the test leaked its env var");
});

/**
 * A MALFORMED OVERRIDE THROWS RATHER THAN FALLING BACK. A safety bound that
 * silently ignores what the operator typed is a bound he believes he changed
 * and did not — the same class of defect as a probe that can only observe
 * success, arriving from the configuration side.
 */
test("a malformed bound is refused, not quietly replaced by the default", () => {
  for (const bad of ["abc", "-1", "ten"]) {
    assert.throws(
      () => resolveAttemptTimeoutMs({ env: { [ATTEMPT_TIMEOUT_ENV_NAME]: bad } }),
      /is not a number of minutes/,
      `${ATTEMPT_TIMEOUT_ENV_NAME}=${bad} was accepted`,
    );
  }
  assert.throws(() => resolveAttemptTimeoutMs({ attemptTimeoutMs: -5 }), /must be a finite number/);
});

/**
 * THE BOUND DOES NOT COST THE SEAT ITS ANSWER. A race that resolved to the
 * timeout sentinel while the call was already settling would turn every slow
 * success into a failure. Asserted with a bound long enough that the scripted
 * response always wins, and against the same replay fixture the rest of this
 * file uses, so it exercises the real `Promise.race`.
 */
test("a call that returns inside the bound is unaffected by it", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [replayResponse(ATTEMPT_2_MANIFEST, CLEAN_SOURCE)]);
  const judge = new ReplayCaller(JUDGE_SEAT, []);
  await assert.rejects(
    generateAuditedSuite(REPLAY_TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      syntaxCheck: false,
      maxAttempts: 1,
      attemptTimeoutMs: 10_000,
      // The claim is about the BOUND — one call, returned inside it, audited
      // rather than cut short. A repair round would make it two calls and the
      // count below would be measuring the repair loop instead.
      maxRepairRounds: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BakeoffError);
      assert.match(
        error.message,
        /is not executable by the sealed scorer/,
        "the call was cut short by the bound instead of being audited",
      );
      return true;
    },
  );
  assert.equal(spec.requests.length, 1);
});

/* -------------------------------------------------------------------------
 * PART 5b — WHAT AN ABANDONED CALL COSTS, AND WHAT STILL BOUNDS IT
 * ---------------------------------------------------------------------- */

/**
 * THE HOLE THIS PART CLOSES, AND IT WAS A REVIEW FINDING RATHER THAN A HUNCH.
 *
 * `callWithDeadline` ABANDONS; it does not cancel. So attempt N+1 is dispatched
 * while attempt N's call is still in flight — the first concurrency this phase has
 * ever had — and `SpendCeiling.checkBeforeCall` projects from `#spentUsd`, which an
 * abandoned call only reaches (`ceiling.record`, anthropic-seat.ts:673) IF IT
 * RETURNS. Attempts 2 and 3 were therefore authorised against a spend figure that
 * omitted every in-flight call, so the hard ceiling could be exceeded by up to
 * (attempts - 1) x worstCaseNextCallUsd with `allowed: true` on every decision row.
 *
 * `HangingCaller` ABOVE CANNOT SEE THIS AND THAT IS WHY THIS CLASS EXISTS. It
 * overrides `call()` and never touches the ceiling, so no pre-call decision is ever
 * pushed and the reservation has nothing to read. This caller reproduces the REAL
 * ordering — `checkBeforeCall`, `assertAllowed`, then dispatch — and then hangs.
 *
 * WHAT THE ARITHMETIC PROVES, so the assertion is not "a number went up":
 * ceiling $2.50, worst case $1.00 a call.
 *   attempt 1: projected 0.00 + 1.00 <= 2.50  allowed  -> abandoned, 1.00 reserved
 *   attempt 2: projected 1.00 + 1.00 <= 2.50  allowed  -> abandoned, 1.00 reserved
 *   attempt 3: projected 2.00 + 1.00 >  2.50  REFUSED  -> budget_exceeded
 * Without the reservation `#spentUsd` stays 0.00, all three are allowed, and the
 * phase ends `suite_not_audited` having authorised $3.00 against a $2.50 ceiling.
 * The two outcomes are different ERROR CODES, not different log lines.
 */
const RESERVE_WORST_CASE_USD = 1;

class CeilingHonouringHangingCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];

  constructor(seat: AnthropicSeat, budget: typeof AUTHORING_BUDGET) {
    super(seat, { budget, env: { [seat.envKeyName]: SENTINEL } });
  }

  get calls(): number {
    return this.requests.length;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    // THE ORDER IS THE PRODUCTION ORDER (anthropic-seat.ts:639-640): estimate,
    // check, assert, THEN dispatch. The reservation finds this decision by index,
    // so a stub that skipped the check would make it unfindable.
    const decision = this.ceiling.checkBeforeCall(RESERVE_WORST_CASE_USD, request.purpose);
    this.ceiling.assertAllowed(decision, request.purpose);
    return new Promise<SeatCallResult>(() => undefined);
  }
}

function tightBudget(maxCostUsd: number): typeof AUTHORING_BUDGET {
  return Object.freeze({ ...AUTHORING_BUDGET, maxCostUsd, maxCampaignCostUsd: 175 });
}

async function runAgainstAHangHonouringTheCeiling(
  maxCostUsd: number,
): Promise<{ readonly spec: CeilingHonouringHangingCaller; readonly error: BakeoffError }> {
  const budget = tightBudget(maxCostUsd);
  const spec = new CeilingHonouringHangingCaller(SPEC_SEAT, budget);
  const judge = new ReplayCaller(JUDGE_SEAT, []);
  try {
    await generateAuditedSuite(REPLAY_TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      syntaxCheck: false,
      attemptTimeoutMs: 150,
    });
  } catch (error) {
    assert.ok(error instanceof BakeoffError, `expected a BakeoffError, got ${String(error)}`);
    return { spec, error };
  }
  throw new Error("a run whose every call hangs cannot succeed");
}

test(
  "an abandoned call is charged to the ceiling at once, so the next attempt is projected over it",
  { timeout: 20_000 },
  async () => {
    const { spec, error } = await runAgainstAHangHonouringTheCeiling(2.5);

    assert.equal(
      error.code,
      "budget_exceeded",
      "the third attempt was authorised against a ceiling that two abandoned calls had already " +
        "committed. This is the whole finding: an abandoned call that never returns never reaches " +
        `ceiling.record, so without a reservation the projection is blind to it. Message: ${error.message}`,
    );
    assert.equal(
      spec.calls,
      3,
      "the refusal must land ON the third dispatch — earlier means the reservation over-charged, " +
        "later means it never charged",
    );
    assert.equal(
      spec.ceiling.spentUsd,
      2 * RESERVE_WORST_CASE_USD,
      "the amount charged is not the worst case the call's OWN pre-call decision computed. A guessed " +
        "figure here would be a second answer to a question the ceiling already answered.",
    );
    assert.match(
      error.message,
      /hard ceiling reached/,
      "the refusal does not read as a budget boundary, so an owner cannot tell it from a model failure",
    );
  },
);

/**
 * THE NEGATIVE CONTROL, AND WITHOUT IT THE TEST ABOVE PASSES AGAINST A CEILING
 * THAT REFUSES EVERYTHING. A reservation that charged the ceiling on every call —
 * or a ceiling misconfigured tight — would produce `budget_exceeded` no matter what
 * the bound did. With headroom the same three abandonments must run to the end of
 * the ladder and fail as a suite that was never authored.
 */
test(
  "with headroom the same three abandonments are NOT refused — the reservation bounds, it does not block",
  { timeout: 20_000 },
  async () => {
    const { spec, error } = await runAgainstAHangHonouringTheCeiling(25);

    assert.equal(
      error.code,
      "suite_not_audited",
      `three abandoned calls inside the ceiling must exhaust the ATTEMPTS, not the budget: ${error.message}`,
    );
    assert.equal(spec.calls, DEFAULT_MAX_AUTHORING_ATTEMPTS);
    assert.equal(
      spec.ceiling.spentUsd,
      DEFAULT_MAX_AUTHORING_ATTEMPTS * RESERVE_WORST_CASE_USD,
      "every abandoned call must be reserved, not just the ones near the ceiling",
    );
    assert.ok(
      error.message.includes(TIMEOUT_FAILURE_MARKER),
      "the failure does not name the abandonment, so the reservation is invisible to a reader",
    );
    assert.match(
      error.message,
      /charged the WORST CASE for each of them/,
      "the failure message does not say the ceiling was charged, so the run record still implies the " +
        "spend of an abandoned call is simply lost",
    );
    /*
     * THE FIGURE, NOT JUST THE CLAIM. A sentence that says "the ceiling was
     * charged" without the amount cannot be checked by the person reading
     * `runs.failure_reason`, and — the reason this assertion exists — the FIRST
     * version of that sentence asserted the charge UNCONDITIONALLY, which is false
     * on the subscription path where every reservation is $0. Three abandonments at
     * $1.0000 of worst case each is $3.0000.
     */
    assert.match(
      error.message,
      /\$3\.0000 in total across 3 abandonment\(s\)/,
      `the failure message does not report what was actually reserved: ${error.message}`,
    );
    assert.doesNotMatch(
      error.message,
      /NOTHING was charged to the spend ceiling/,
      "a run that DID reserve money is carrying the zero-reservation sentence",
    );
  },
);

/**
 * A SUBSCRIPTION CALL RESERVES NOTHING, WHICH IS THE DASHBOARD'S OWN PATH.
 * `SubscriptionSeatCaller` calls `checkBeforeCall(0, …)` because a subscription
 * call has no dollar cost. A reservation of 0 must be recorded as nothing at all —
 * charging a floor of "some" against a ceiling that cannot fire would put a
 * fabricated number into `spentUsd`, which is reported.
 */
class ZeroWorstCaseCaller extends CeilingHonouringHangingCaller {
  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    const decision = this.ceiling.checkBeforeCall(0, request.purpose);
    this.ceiling.assertAllowed(decision, request.purpose);
    return new Promise<SeatCallResult>(() => undefined);
  }
}

test("a worst case of zero reserves nothing at all", { timeout: 20_000 }, async () => {
  const spec = new ZeroWorstCaseCaller(SPEC_SEAT, tightBudget(2.5));
  const judge = new ReplayCaller(JUDGE_SEAT, []);
  await assert.rejects(
    generateAuditedSuite(REPLAY_TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      syntaxCheck: false,
      attemptTimeoutMs: 150,
    }),
    (error: unknown) => error instanceof BakeoffError && error.code === "suite_not_audited",
  );
  assert.equal(spec.ceiling.spentUsd, 0, "a zero worst case was turned into a non-zero charge");
  assert.equal(spec.calls, DEFAULT_MAX_AUTHORING_ATTEMPTS);

  /*
   * AND THE FAILURE MESSAGE SAYS SO, LOUDLY — this is the half a review caught.
   * The sentence that reaches `runs.failure_reason` used to claim, on every path,
   * that "the dollar ceiling still bounds this phase". On the dashboard's own seat
   * that is FALSE: `SubscriptionSeatCaller` calls `checkBeforeCall(0, …)`, nothing
   * is reserved, and the cost ceiling cannot fire at all. A reassuring sentence
   * beside a mechanism that does not do what it says is the exact defect this pass
   * is repairing, so the zero case is asserted as text, not only as a number.
   */
  const zeroError = await generateAuditedSuite(REPLAY_TICKET, {
    specCaller: new ZeroWorstCaseCaller(SPEC_SEAT, tightBudget(2.5)),
    judgeCaller: new ReplayCaller(JUDGE_SEAT, []),
    syntaxCheck: false,
    attemptTimeoutMs: 150,
  }).then(
    () => {
      throw new Error("a run whose every call hangs cannot succeed");
    },
    (error: unknown) => error as BakeoffError,
  );
  assert.match(
    zeroError.message,
    /NOTHING was charged to the spend ceiling for them/,
    `a phase whose reservations were all $0 still claims the ceiling bounded it: ${zeroError.message}`,
  );
  assert.match(
    zeroError.message,
    /SUBSCRIPTION seat/,
    "the message does not say WHY the reservation was zero, so a reader cannot tell a subscription " +
      "seat from a broken reservation",
  );
  assert.doesNotMatch(
    zeroError.message,
    /the dollar ceiling still bounds this phase/,
    "the run record tells the owner his spend was bounded on the one path where it was not",
  );
});

/**
 * THE DEADLINE TIMER IS REF'D, PROVEN IN A PROCESS WHOSE ONLY PENDING WORK IS THE
 * HANG — WHICH IS THE ONLY PLACE THE DIFFERENCE IS OBSERVABLE.
 *
 * `callWithDeadline` used to `timer.unref()`, justified as letting `node --test`
 * exit. An unref'd timer does not hold the event loop open, so the bound only fires
 * while something ELSE keeps the loop alive. In the dashboard server a listening
 * socket does — which is why every in-process test above stayed green either way.
 * In a CLI invocation (`bakeoff/src/cli.ts`) whose only pending work is a
 * handle-less hung promise, node drains and exits BEFORE the deadline: the exact
 * shape of hang the bound exists for, silently unbounded.
 *
 * SO THE ASSERTION IS ON STDOUT, NOT ON THE EXIT CODE, and that is measured rather
 * than assumed. Both directions were run by hand before this test was written:
 *
 *   ref'd    -> stdout "ABANDONED", exit 0
 *   unref'd  -> NO stdout, exit 13 ("Detected unsettled top-level await")
 *
 * An `assert.notEqual(code, 0)` would therefore have been GREEN on the broken
 * version and RED on the fixed one — the check inverted. The exit code is asserted
 * too, as the second half of the same measurement, but the stdout line is the
 * discriminator.
 */
test("the deadline timer holds the event loop open, so a bare hung process still abandons", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const specAgent = pathToFileURL(join(here, "spec-agent.js")).href;
  const source =
    `const { callWithDeadline } = await import(${JSON.stringify(specAgent)});\n` +
    "const outcome = await callWithDeadline(new Promise(() => {}), 200);\n" +
    'console.log(typeof outcome === "symbol" ? "ABANDONED" : "RETURNED");\n';

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(
    child.stdout.trim(),
    "ABANDONED",
    "a process whose ONLY pending work is a hung authoring call exited without abandoning it. The " +
      "deadline timer is unref'd, so the bound is not a bound — it fires only if something else " +
      `happens to keep the loop alive. stderr: ${child.stderr.trim()}`,
  );
  assert.equal(
    child.status,
    0,
    `the child did not exit cleanly after abandoning. stderr: ${child.stderr.trim()}`,
  );
});

/* -------------------------------------------------------------------------
 * PART 8 — the owner's acceptance signals: shown to the seat, declared back,
 *          and carried across a repair round.
 *
 * WHY THIS PART EXISTS. Run `6ec44b2f` shipped a working portfolio and its
 * sealed suite marked it DID NOT PASS. The brief said, under HOW I WILL KNOW IT
 * WORKS, *"Killing the server and starting it again still returns messages
 * submitted before."*; the seat wrote 25 criteria and none of them restarted
 * anything, checking persistence by grepping files with the SQLite header for
 * the posted bytes instead. `PRAGMA journal_mode = WAL` put the row in the -wal
 * sidecar until a checkpoint, so the grep found nothing on an artefact whose
 * data really did survive a kill-and-restart.
 *
 * THE RULE ITSELF IS TESTED IN `spec-validate.test.ts`. What is tested here is
 * the half that lives in this module: that the seat is SHOWN the signals with
 * the same numbering the rule decodes, that the schema makes the declaration
 * unskippable, and that a repair round neither loses the declarations nor
 * breaks the no-op guard by carrying them.
 * ---------------------------------------------------------------------- */

/** The owner's real ticket for run `6ec44b2f`, embedded verbatim. */
const SIGNAL_BRIEF = `Build my personal portfolio site — a real application with a working backend, not a
static page with a decorative contact form.

Content comes from the attached CV. Take the roles, dates, projects, skills and
contact details from it. Do not invent employers, job titles, dates or numbers. If
the CV is ambiguous about something, leave it out rather than filling the gap.

THE LOOK

Hand-drawn sketchbook, not a template. The attached image is the direction. In words,
so it can be graded:

Warm off-white paper background with faint coloured-pencil scribble at the edges of
the viewport. Content sits on slightly tilted white paper cards with soft drop shadows
and thin dark hand-inked rules, as if photographed on a desk. Headings are large,
uppercase, condensed and hand-lettered in near-black. Body copy is a plain readable
serif at normal weight — the drawing carries the personality, the text does not need
to. Illustrations are coloured-pencil line art with visible hatching, in a restrained
palette of purple, orange, green, red and blue on paper white. Buttons are small
outlined pills with lowercase labels. Section flows are numbered with circled digits
and hand-drawn curved arrows between steps. Top navigation is a single row of
uppercase links with a hand-drawn underline under the active one.

No gradients, no glassmorphism, no neon, no dark mode. If it could have come out of a
generic component library, it is wrong.

THE MOTION

Keep it to what the reference page actually does, which is very little: text spans
reveal once as they scroll into view, animating transform over about 250ms. Nothing
else moves on its own. Stay within about 40% of that duration, animate transform
rather than layout, and reveal each element once rather than every time it re-enters
the viewport. Everything must still work with
prefers-reduced-motion: reduce — motion is the finish, never the mechanism.

RESEARCH BEFORE YOU BUILD

You have network access while building; the graders do not. Before writing the
illustration and motion layer, look up how hand-drawn and sketch aesthetics are
actually implemented on the web today, and how the motion described above is
usually built. Say in your self-report what you looked at and what you
took from it. Vendor anything you depend on into the artefact — nothing is fetched at
grading time.

PAGES

/          hero with my name, role and one line about what I do; a short selected-work
           strip pulled from the CV.
/work      projects from the CV, each as its own paper card: title, what it is, the
           stack, my role.
/about     the career narrative, roles and dates from the CV, and the skills list.
/contact   the form described below.

THE BACKEND — THIS IS THE PART THAT MUST ACTUALLY WORK

A Node HTTP server. Zero runtime npm dependencies: node:http, node:sqlite and the
standard library only. Starts with \`npm start\`, listens on PORT defaulting to 3000,
serves every page and API route from one process, and persists to a SQLite file
created automatically on first boot.

  POST /api/contact   accepts {name, email, message} as JSON. Validates all three:
                      name non-empty, email structurally valid, message at least 20
                      characters. Rejects with 400 and a JSON body naming WHICH field
                      failed. On success stores the message with a timestamp and
                      returns 201 with the new record's id. An empty or invalid
                      submission must never be stored and must never return a success
                      response — a form that confirms a submission it discarded is the
                      failure I care most about.
  GET  /api/messages  stored messages as JSON, newest first. Requires a bearer token
                      read from an environment variable at boot: 401 without it, 401
                      with the wrong one. If the variable is unset the route stays
                      available and refuses every request rather than opening up.
  GET  /api/projects  the CV's projects as JSON, served from the database rather than
                      hardcoded in the page, seeded on first boot.
  GET  /api/health    200 with {"ok":true}.
  everything else     a real 404 page in the site's own visual style — not a stack
                      trace, not a blank body.

The contact page posts to /api/contact for real and renders the server's response: the
field-level error on a 400, a confirmation on a 201. No optimistic "thanks!" before the
server has answered. Rate-limit POST /api/contact to a handful of submissions per
minute per IP, in memory, returning 429 past that.

YOU CANNOT OPEN A PORT WHILE BUILDING THIS

The build sandbox denies listen() on every port with EPERM. That is measured. So
structure it to be testable without a socket: request handling in an exported router
function, \`server.mjs\` doing nothing but wiring it to node:http, every database access
behind functions taking a database handle as an argument. Write node --test tests that
call those directly. Cover the 400 on each invalid field, the 201, both 401s, the 429,
and survival of data across a reopen. Run them and get them passing before you declare
done, and say how many there are.

CONSTRAINTS

Runs entirely offline once built. No external API, no hosted database, no email
provider, no analytics, no third-party fonts or CDN — embed or self-host every asset.
No secrets in the repository; the one token is read from the environment. Responsive at
1440, 768 and 375 with no horizontal scrolling. Keyboard-navigable throughout, visible
focus rings, alt text on every illustration.

HOW I WILL KNOW IT WORKS

- \`npm start\` boots on one port and serves every page and every API route.
- Submitting the contact form with a blank message shows a field error and stores
  nothing; GET /api/messages with the right token proves the count did not change.
- A valid message returns 201 and then appears in GET /api/messages.
- GET /api/messages with no token and with a wrong token both return 401.
- Killing the server and starting it again still returns messages submitted before.
- Every project on /work traces to a line in the attached CV.
- All four pages render in the sketchbook style at 1440, 768 and 375.
- The motion matches what is described above, and the site is fully usable with reduced
  motion enabled.

--- WHAT IS DIFFERENT THIS TIME ---

You built this once already. It came out close. Everything above still stands; the list
below is in addition to it.

EACH PROJECT GETS ITS OWN PAGE

On /work the six project cards go nowhere. Clicking a project must open a page about that
project, the way it works on kamilborzecki.dev.

Treat the six project pages as ONE requirement, not six. They share a single template, and
one test that walks all six slugs is the right way to check them.

Stated one requirement at a time:

- When a visitor clicks a project card on /work, the site shall open that project's page.
- The site shall serve a page at /work/<slug> for each of the six projects, where slug is
  teewise, trade-assistant, jobsilver, kori, parts-agent and crewflow. Typing the URL
  directly shall work, not only clicking through.
- The site shall render, on each project page, the project name as the page heading.
- The site shall render, on each project page, a description of several sentences taken from
  the CV that does not appear on /work.
- The site shall render, on each project page, that project's role and stack from the CV.
- The site shall render, on each project page, that project's illustration.
- The site shall render, on each project page, a link back to /work.
- Where a project page is shown, the site shall keep the top navigation pinned and the
  sketchbook style identical to the rest of the site.
- If a project slug does not exist, then the site shall serve the styled 404 page rather than
  a crash or a blank body.
- The site shall make every project card reachable by keyboard, in the order the cards
  appear, with a visible focus ring.

GO ONE STEP PAST THE LITERAL MINIMUM

The site shall render, at the foot of each project page, links to the previous and next
project.

THREE THINGS THAT WERE MEASURABLY WRONG LAST TIME

Each one is stated on its own, with the measurement that decides it, because the last
build satisfied the prose and failed the check.

- Two poster images shipped STRETCHED, at 0.69 and 0.28 of their true aspect ratio, and
  nothing caught it. The site shall render every image so that its rendered box has the
  same width-to-height ratio as the image file it came from, within one percent, at 1440,
  768 and 375. A test that reads naturalWidth/naturalHeight and compares them to the
  rendered getBoundingClientRect() for every <img> on every page is the right way to
  check this.

- A submission that satisfies every documented validation rule did not answer 201. When a
  POST to /api/contact carries a non-empty name, a structurally valid email and a message
  of at least twenty characters, the site shall answer HTTP 201 with a JSON body carrying
  the new record's id. That exact request, with that exact shape, must not answer 400.

- Something that declares motion still animated under reduced motion. Where
  prefers-reduced-motion: reduce is set, the site shall run no animation at all:
  document.getAnimations() shall return an empty list after the page has settled, and no
  element shall change its opacity or transform over time. Reveal-on-scroll content shall
  be visible immediately in that mode rather than waiting for an animation that never runs.

HOW I WILL KNOW THIS PART WORKS

- Clicking any of the six cards on /work lands on that project's page.
- Each of the six URLs loads directly, with that project's own content.
- /work/nonsense returns the styled 404.
- No image renders at a shape different from the file it came from, on any page, at any of
  the three widths.
- A valid contact submission answers 201 and the message then appears in GET /api/messages.
- With reduced motion enabled, nothing on any page animates and nothing is left invisible.
- Every project page is readable at 375 with no horizontal scrolling.
`;

const SIGNAL_TICKET: Ticket = Object.freeze({
  id: "T-SIGNALS",
  brief: SIGNAL_BRIEF,
  sha256: ticketDigest(SIGNAL_BRIEF),
  tier: "hard",
  title: "6ec44b2f re-run",
});

test("the ticket turn numbers the owner's signals, and line N is signal N", () => {
  const turn = ticketTurn(SIGNAL_TICKET);
  const signals = acceptanceSignals(SIGNAL_BRIEF);
  assert.equal(signals.length, 15, "the fixture stopped yielding the owner's fifteen signals");

  assert.ok(turn.includes(SIGNAL_BRIEF), "the brief is no longer carried verbatim");
  assert.match(turn, /ACCEPTANCE SIGNALS — 15 sentences/);

  // PARSED BACK OUT OF THE RENDERED TURN, not re-derived from the extractor. A
  // block that renumbered, reordered or dropped an entry would still satisfy a
  // "contains the sentence" assertion; this cannot.
  const numbered = turn
    .split("\n")
    .map((line) => /^(\d+)\. (.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null);
  assert.equal(numbered.length, 15, "the turn does not carry exactly fifteen numbered lines");

  numbered.forEach((match, i) => {
    const signal = signals[i];
    assert.equal(match[1], String(i + 1), "the numbering shown to the seat is not 1..15 in order");
    // The rendered line collapses a hard-wrapped bullet onto one line; the
    // signal's own text keeps the break, because a finding quoting it must stay
    // findable in the brief. Compared under the same collapse.
    assert.equal(match[2], signal?.text.replace(/\s*\n\s*/g, " "), `line ${String(i + 1)} is not signal ${String(i + 1)}`);
  });

  // THE ONE THE RUN TURNED ON, named as a literal.
  assert.ok(
    turn.includes("5. Killing the server and starting it again still returns messages submitted before."),
    "the restart signal is not shown to the seat as number 5",
  );
});

test("NEGATIVE CONTROL: a brief with no acceptance section adds nothing to the turn", () => {
  // Most tickets look like this, and for them the turn must be exactly what it
  // was before any of this existed — a block appended unconditionally would be
  // fifteen lines of instruction about a list that does not exist.
  const plain: Ticket = Object.freeze({
    id: "T-PLAIN",
    brief: BRIEF,
    sha256: ticketDigest(BRIEF),
    tier: "medium",
    title: "portfolio",
  });
  const turn = ticketTurn(plain);
  assert.ok(!turn.includes("ACCEPTANCE SIGNALS"), "a signal block was rendered for a brief with no signals");
  assert.ok(turn.endsWith("TICKET_BRIEF>>>"), `the turn gained a trailing block: ${turn.slice(-120)}`);
});

test("the authoring schema REQUIRES coversAcceptanceSignals, so it cannot be skipped", () => {
  // Without this, deleting the field from the schema's `required` list leaves
  // every other test green: the model simply stops declaring coverage, every
  // signal reads as unclaimed, and the rule blocks every suite for a reason
  // nobody introduced on purpose.
  const properties = AUTHORING_JSON_SCHEMA["properties"] as Record<string, Record<string, unknown>>;
  const item = (properties["criteria"] ?? {})["items"] as Record<string, unknown>;
  const required = (item["required"] ?? []) as readonly string[];
  assert.ok(required.includes("coversAcceptanceSignals"), "the authoring schema no longer requires the declaration");
  const itemProps = (item["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  assert.deepEqual(itemProps["coversAcceptanceSignals"], { type: "array", items: { type: "integer" } });
});

test("the authoring prompt teaches the restart signal with the WAL case that forced it", () => {
  // The prompt is the only place the BEHAVIOURAL half of this can live: the
  // deterministic rule checks that a signal is claimed, never that the claim is
  // honoured. If this text goes, coverage becomes a box-ticking exercise.
  assert.match(AUTHORING_SYSTEM_PROMPT, /coversAcceptanceSignals/);
  assert.ok(
    AUTHORING_SYSTEM_PROMPT.includes(
      '"Killing the server and starting it again still returns messages submitted before."',
    ),
    "the worked example no longer quotes the signal it is about",
  );
  assert.match(AUTHORING_SYSTEM_PROMPT, /PRAGMA journal_mode = WAL/);
  assert.match(AUTHORING_SYSTEM_PROMPT, /EASIER TO PROVE/);
});

test("a repair round strips the declarations and puts them back by criterion id", () => {
  // BOTH HALVES, BECAUSE EITHER ONE ALONE IS A DEFECT. Unstripped, the repair
  // parser's no-op guard compares an eight-field original against a seven-field
  // correction and reads a pure echo as a change (run `d143e52d`'s failure).
  // Unrestored, the spliced suite declares no coverage at all and the re-audit
  // rejects it for a gap the repair never opened.
  const draft: SuiteDraft = {
    ticketId: SIGNAL_TICKET.id,
    ticketSha256: SIGNAL_TICKET.sha256,
    criteria: [
      { ...DRAFT.criteria[0]!, id: "REQ-001", coversAcceptanceSignals: [3, 5] },
      { ...DRAFT.criteria[0]!, id: "REQ-002", coversAcceptanceSignals: [] },
    ],
    files: DRAFT.files,
  };

  const stripped = withoutCoverageClaims(draft);
  for (const criterion of stripped.criteria) {
    assert.ok(
      !("coversAcceptanceSignals" in criterion),
      "the key survives the strip, so JSON.stringify still sees an eight-field object",
    );
  }
  // Everything else about the criterion is untouched.
  assert.equal(stripped.criteria[0]?.statement, draft.criteria[0]?.statement);
  assert.equal(stripped.files, draft.files);

  // Restored onto the shape a repair actually returns: the stripped objects,
  // one of them rewritten, in draft order.
  const repaired: SuiteDraft = {
    ...stripped,
    criteria: [
      { ...stripped.criteria[0]!, statement: "The system shall serve the contact API over HTTP." },
      stripped.criteria[1]!,
    ],
  };
  const restored = withCoverageClaimsFrom(repaired, draft);
  assert.deepEqual(restored.criteria[0]?.coversAcceptanceSignals, [3, 5]);
  assert.deepEqual(restored.criteria[1]?.coversAcceptanceSignals, []);
  assert.equal(
    restored.criteria[0]?.statement,
    "The system shall serve the contact API over HTTP.",
    "the restore overwrote the correction it was supposed to preserve",
  );
});
