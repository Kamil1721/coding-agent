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
import type { Ticket } from "./contracts.js";
import { ticketDigest } from "./hash.js";
import {
  AUTHORING_SYSTEM_PROMPT,
  MANIFEST_DATA_EXPECTATION_EXAMPLES,
  auditSuite,
  remediationForFailedAuthoring,
} from "./spec-agent.js";
import type { AuditFinding } from "./contracts.js";
import { STATIC_SERVE_PORT, parseSuiteManifest } from "./scorer-protocol.js";
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
