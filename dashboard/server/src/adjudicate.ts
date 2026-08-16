/**
 * adjudicate.ts — is a red gate the GRADER's fault or the BUILD's?
 *
 * THIS IS THE ROUTER THAT DECIDES WHETHER THE REPAIR LANE WAKES AT ALL, and it
 * is the reason adjudication cannot be deferred to a later increment than the
 * trigger (DESIGN-repair-lane-2026-08-16 §3A). The lane fires on PIPELINE and on
 * nothing else:
 *
 *   PIPELINE  the GRADER is broken. The test never fairly exercised the
 *             criterion — the harness died before it reached the app.
 *             => the repair lane wakes. Its scope is `bakeoff/src`,
 *                `dashboard/server/src`, `tools/`. Never the artefact (§3A.1).
 *   ARTEFACT  the BUILD is broken. The app was reached and answered wrongly.
 *             => the MAIN workflow owns it, and it SUCCEEDED. The lane sleeps.
 *   UNKNOWN   the evidence cannot tell. => nothing wakes, a human is told.
 *
 * THE ASYMMETRY OF THE TWO MISTAKES IS WHY `UNKNOWN` EXISTS AND MUST BE
 * REACHABLE. A false PIPELINE wakes an unsupervised repair lane on a system that
 * is working, and hands it a defect it cannot reproduce. A false ARTEFACT hides
 * a grader bug behind a `DID NOT PASS` that reads as an honest one — which is
 * the 2026-08-12 failure this whole lane exists to stop happening again. Neither
 * is worth a guess, so a verdict is only issued where the evidence names it, and
 * `UNKNOWN` is a first-class answer rather than a synonym for either.
 *
 * WHY IT IS PURE, AND WHY IT IS HERE RATHER THAN IN THE SCORER. No filesystem,
 * no clock, no network, no database: it is a function from one already-collected
 * result to a verdict per failing criterion. `scorer-container.ts` is where this
 * logic would naturally sit next to its input, and that module EXPORTS NOTHING
 * AND THROWS ON IMPORT outside the sealed container (its own header says so), so
 * anything written there is unreachable by any test. Increment 1 already had to
 * lift `collectFailures` out of it for that reason. Code the repair lane routes
 * on cannot be code no test can reach.
 *
 * ── WHAT IT READS, AND THE ONE FIELD THAT MADE IT POSSIBLE ──────────────────
 *
 * `suiteExecution.failures` (increment 1, 2026-08-16). Before it existed the
 * only machine-readable record of a failure was `CriterionCoverage.outcome`
 * plus a `detail` naming the TEST TITLE — and a title cannot distinguish "the
 * app answered 401" from "npm had no start script". Design §12.3 states the
 * consequence plainly: the cheap discriminators (`gate_stop_reason`,
 * `false_finish`) cannot settle this question, and the per-test failure reason
 * is the only evidence in the system that can. Every ARCHIVED result predates
 * the field, which is why this module answers UNKNOWN for all of them rather
 * than inventing a verdict from a title — see {@link adjudicate}'s note on
 * `evidenceComplete`.
 *
 * ── THE DISCRIMINATORS, AND WHERE EACH WAS MEASURED ─────────────────────────
 *
 * Every signal below was derived from an archived run in
 * `dashboard/results/scorer-out/`, not from a guess about what an error looks
 * like. Three runs are the ground truth this module is fitted to and tested
 * against; each is named at the signal it produced.
 *
 *   047f9872 — 7 tests across 2 files, every one of them failing with
 *     `npm start did not answer /api/health on port NNNNN within 45s
 *      npm error Missing script: "start"`
 *     while all three sibling files passed 3/3, 4/4 and 6/6. The artefact was
 *     later hand-verified CORRECT. MUST be PIPELINE.
 *   6ec44b2f REQ-020 — image aspect ratios 1.2–1.8% off a 1% tolerance, one of
 *     the two asserting tests failing and its file's sibling test passing. A
 *     real build defect. MUST be ARTEFACT.
 *   e1c15359 REQ-022 — uppercase-nav / background luminance, which PASSED in
 *     047f9872 on the same frozen suite. A real build defect. MUST be ARTEFACT.
 *
 * THE TRAP THAT KILLS THE OBVIOUS IMPLEMENTATION: all three carry
 * `code: "ERR_ASSERTION"` or a Playwright `expect()` shape, and 047f9872's
 * failures are `AssertionError`s. "It threw an AssertionError, so the app must
 * have answered" is wrong on the single most important case in the archive. The
 * discriminator is not the error CLASS, it is whether the failure describes a
 * RESPONSE (a status, a rendered measurement, a compared value) or an
 * ENVIRONMENT (a missing script, an unresolvable module, a refused connection,
 * a boot that never answered).
 *
 * A SECOND TRAP, AND IT IS WHY {@link isSubstantiveComparison} EXISTS.
 * `assert.ok(found)` reports `expected: "true", actual: "false"` — a comparison
 * in shape and nothing in content. 6ec44b2f's `sqlite-storage.test.mjs` failures
 * carry exactly that pair with the message "no file carrying the SQLite header
 * was found under /opt/bakeoff-scorer, /opt, /app, /srv/app, /workspace", and
 * that is the grader searching the wrong roots, not the app answering. Reading
 * any expected/actual pair as proof the app was reached classifies a known
 * grader defect as a build defect.
 *
 * ── THE SHAPE RULE, WHICH IS THE ONE THAT NEEDS NO STRINGS ──────────────────
 *
 * A whole file failing 100% while sibling files pass is a FILE-LEVEL cause, not
 * N independent defects (§6.1 makes the same observation about report ordering).
 * 047f9872 is that shape twice over. It is the strongest evidence available and
 * it is also the most dangerous rule in this module, because an artefact defect
 * in one endpoint that every test in a file uses produces the same silhouette.
 * {@link fileLevelCause} therefore refuses to fire when any failure in the file
 * shows the app answering, when only one test in the file failed, when any test
 * in the file passed, when the file's failures do not share one cause signature,
 * or when no sibling file is fully green; and {@link adjudicate} refuses to call
 * it at all when the failure list is incomplete or the pass census is provably
 * short. Each of those seven guards has its own test and each was mutated
 * individually: the ledger is at the head of `adjudicate.test.ts`.
 *
 * ── WHAT IS DELIBERATELY NOT A SIGNAL ───────────────────────────────────────
 *
 *  - `suiteExecution.timedOut`. An app that hangs is an ARTEFACT defect; a
 *    scorer whose budget is too small is a PIPELINE defect. The flag cannot
 *    separate them, so it decides nothing here and a criterion whose only
 *    evidence is a timeout stays UNKNOWN.
 *  - `exitCode`. Non-zero is what brought us here; it says nothing about whose
 *    fault it is.
 *  - `code: "ERR_ASSERTION"`. See the trap above.
 *  - Anything a MODEL said. This module reads recorded facts only; §1.1 refuses
 *    a verdict that rests on an opinion, one level up.
 */

import { TITLE_PATH_SEPARATOR } from "bakeoff/dist/scorer-protocol.js";
// The REAL coverage type rather than a local restatement, per the rule stated at
// `verdict.ts:109`: a second declaration of a shape is a second thing to keep in
// step. The failure type below is restated ONLY because it cannot be imported at
// this tree's HEAD — see {@link AdjudicableFailure}.
import type { CriterionCoverage } from "bakeoff/dist/scorer-protocol.js";
import type { CriterionTier } from "bakeoff/dist/contracts.js";

/**
 * One failing test's reason — structurally the scorer protocol's `TestFailure`.
 *
 * WHY THIS IS A LOCAL DECLARATION AND NOT AN IMPORT, WHICH IS A CONSTRAINT AND
 * NOT A PREFERENCE. `TestFailure` is increment 1 of the repair-lane design and
 * is NOT in this worktree's `bakeoff/src/scorer-protocol.ts` (HEAD `ea80328`;
 * `grep -n TestFailure bakeoff/src/scorer-protocol.ts` returns only the
 * unrelated `isSuiteTestFailure`). It exists in the increment-1 tree at
 * `bakeoff/src/scorer-protocol.ts:1552` with these exact fields. Importing it
 * here would leave `npm run typecheck` red in this lane; restating it keeps the
 * module compiling and, because the shape is identical, makes the eventual
 * replacement a one-line import swap. `adjudicate.test.ts` carries the
 * compile-time bridge to uncomment the moment both land, as a line of code
 * rather than a prose TODO — prose TODOs rot, and §12.1 of the design is a table
 * of exactly that.
 *
 * A NARROW INPUT IS ALSO THE RIGHT SHAPE ON ITS OWN TERMS. The lane's real
 * caller is a defect record replay, not always a live `ContainerResult`, and a
 * router that demands fourteen fields it never reads cannot be driven from a
 * fixture or a database row.
 */
export interface AdjudicableFailure {
  /** Suite-relative title path, led by the file: `holdout/x.test.mjs › [REQ-006] T-108 …`. */
  readonly titlePath: string;
  readonly runner: "playwright" | "node-test";
  /** Criterion ids this title carries as whole tokens. Empty when untagged. */
  readonly criterionIds: readonly string[];
  /** Error class, e.g. `AssertionError`, `PlaywrightError`. Null when none was reported. */
  readonly name: string | null;
  readonly message: string | null;
  /** Bounded. The frames are how a suite defect is told from an artefact defect. */
  readonly stack: string | null;
  readonly operator: string | null;
  /** `ERR_ASSERTION`, `ENOENT`, … Never decisive on its own; see the header. */
  readonly code: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
}

/**
 * Everything this router reads. A `ContainerResult` satisfies it structurally
 * once increment 1 lands, and so does a defect record that carried the same
 * fields forward.
 */
export interface AdjudicationInput {
  readonly suiteExecution: {
    /**
     * The runner's OWN count. Not trusted to say WHICH tests failed — only how
     * many, which is the only way to detect that {@link AdjudicationInput.suiteExecution.failures}
     * is missing some of them. Null when no machine-readable report parsed.
     */
    readonly testsFailed: number | null;
    /** Why no report could be parsed, or null when one was. */
    readonly reportProblem: string | null;
    /**
     * Every failing test's reason, capped at `MAX_PERSISTED_FAILURES` (60) by
     * the writer. EMPTY IS AMBIGUOUS: it means "nothing failed" OR "things
     * failed and no reason reached this record", and `testsFailed` is what
     * separates them. This module refuses to route on the second case.
     */
    readonly failures: readonly AdjudicableFailure[];
  };
  readonly criterionCoverage: readonly CriterionCoverage[];
  /** Scorer-side failures: a browser that would not launch, an unreadable mount. */
  readonly infrastructureErrors: readonly string[];
}

export type Verdict = "PIPELINE" | "ARTEFACT" | "UNKNOWN";

export type EvidenceSide = "pipeline" | "artefact";

/**
 * The named things this module can see. Stable ids, because a downstream trigger
 * must be able to throttle on ONE of them (e.g. "stop waking on
 * `criterion-unasserted`") without re-deriving the verdict from prose.
 */
export type SignalId =
  /* pipeline */
  | "runner-error-code"
  | "boot-or-spawn-failure"
  | "scorer-install-frame"
  | "suite-helper-frame"
  | "whole-file-one-cause"
  | "criterion-unasserted"
  | "no-machine-readable-report"
  | "scorer-infrastructure-error"
  /* artefact */
  | "assertion-comparison"
  | "http-status-from-app"
  | "rendered-measurement"
  | "matcher-comparison";

export interface Evidence {
  readonly signal: SignalId;
  readonly side: EvidenceSide;
  /** Where it was read: `failures[3].message`, `suiteExecution.reportProblem`, … */
  readonly source: string;
  /** WHAT was seen, bounded and ANSI-stripped so a report can print it. */
  readonly detail: string;
}

export interface FailureVerdict {
  readonly titlePath: string;
  /** Suite-relative file, or null when the title path does not lead with one. */
  readonly file: string | null;
  readonly verdict: Verdict;
  readonly evidence: readonly Evidence[];
  /** One line naming why. Written for the owner's email, not for a log grep. */
  readonly reason: string;
}

export interface CriterionVerdict {
  readonly criterionId: string;
  readonly tier: CriterionTier;
  readonly verdict: Verdict;
  readonly reason: string;
  /** The failing tests charged to this criterion, each with its own verdict. */
  readonly failures: readonly FailureVerdict[];
  /** Criterion-level and run-level evidence. Per-test evidence lives on the failures. */
  readonly evidence: readonly Evidence[];
}

export interface Adjudication {
  /** One row per criterion that did not pass, in the order the result carried them. */
  readonly criteria: readonly CriterionVerdict[];
  /**
   * Failing tests that name no criterion. They are the ones most likely to BE
   * the suite defect — a test that carries no id is invisible to
   * `criterionCoverage` entirely — so they are reported rather than dropped.
   */
  readonly unattributedFailures: readonly FailureVerdict[];
  /** Run-level pipeline evidence: an infrastructure error, an unparseable report. */
  readonly runEvidence: readonly Evidence[];
  /**
   * THE ROUTING DECISION, and the executable form of §3A. True iff something is
   * PIPELINE. An ARTEFACT-only result means the main workflow did its job.
   */
  readonly wakeRepairLane: boolean;
  /**
   * True when every failure the runner counted is present with its reason. When
   * false the shape rules are switched off, because "no test in this file
   * passed" cannot be established from a list that is missing rows.
   */
  readonly evidenceComplete: boolean;
  /** Why the evidence is incomplete, or what else a reader should distrust. */
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------
 * Signal tables. Each entry is a FAMILY, and each family is named so that the
 * evidence says which one matched rather than "a regex fired".
 * ---------------------------------------------------------------------- */

/**
 * Error codes that mean the test process could not do its job — an OS refusal, a
 * module that would not resolve, a socket that would not open. A test that dies
 * with one of these asserted nothing about the app.
 *
 * `ERR_ASSERTION` IS DELIBERATELY ABSENT and its absence is the whole point:
 * every one of 047f9872's seven grader-caused failures carries it.
 */
const HARNESS_ERROR_CODES: readonly string[] = Object.freeze([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ECONNREFUSED",
  "ECONNRESET",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_REQUIRE_ESM",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_INVALID_MODULE_SPECIFIER",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_DLOPEN_FAILED",
]);

/**
 * The subset of {@link HARNESS_ERROR_CODES} that a WORKING app can also produce
 * by dying, and which therefore stop being evidence once the app has answered.
 *
 * Every other code in that table is about the environment the test ran in — a
 * missing file, an unresolvable module, a bad permission — and no amount of
 * app-side breakage produces one. These five are socket deaths, and a socket
 * dies the same way whether the harness never connected or the server fell over
 * halfway through.
 */
const APP_DIED_CODES: readonly string[] = Object.freeze([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EADDRNOTAVAIL",
]);

/**
 * Six independent grammars for "the harness never reached the app". They are
 * families rather than one regex so that a message matching only the 2026-08-12
 * incident's exact words is not what this module is fitted to: `Missing script`
 * is one member of one family, and removing it leaves five other ways for the
 * same class of defect to be recognised.
 */
const BOOT_FAILURE_PATTERNS: readonly { readonly family: string; readonly test: RegExp }[] = Object.freeze([
  { family: "module-resolution", test: /\bcannot find (module|package)\b|\berr_module_not_found\b/i },
  { family: "package-script", test: /\bmissing script\b|\bnpm (error|err!)\b|\bcommand not found\b/i },
  { family: "process-spawn", test: /\bspawn\s+\S+\s+enoent\b|\bfailed to (start|spawn|launch)\b|\bexited (with code|before)\b/i },
  { family: "connection-refused", test: /\beconnrefused\b|\bconnection refused\b|\bsocket hang up\b|\bfetch failed\b/i },
  { family: "boot-timeout", test: /\bdid not (answer|respond|start|boot|become ready)\b|\btimed out waiting for\b|\bwaiting for (the )?(server|port|app|dev server)\b/i },
  { family: "browser-launch", test: /browsertype\.launch|executable doesn't exist|\bplaywright install\b/i },
]);

/**
 * Grammars for "the app answered". Each was read off a real archived failure and
 * the run is named, because a pattern nothing in the archive produces is a
 * pattern nobody has seen fire.
 */
const ARTEFACT_MESSAGE_PATTERNS: readonly {
  readonly signal: SignalId;
  readonly family: string;
  readonly test: RegExp;
}[] = Object.freeze([
  {
    // 6ec44b2f `[REQ-008] T-8`: "GET /api/messages with the credential answered
    // 401: {"error":"unauthorized"}" — and the "401 !== 200" that follows it.
    signal: "http-status-from-app",
    family: "response-status",
    test: /\b(answered|responded|returned|status(?: code)?|http)\b[^\n]{0,60}?\b[1-5]\d{2}\b|\b[1-5]\d{2}\s*!==?\s*[1-5]\d{2}\b/i,
  },
  {
    // 6ec44b2f `[REQ-020] T-21`: "file 1200x896 rendered 423x322", "1440px /".
    // A number of pixels is something only a rendered document can produce.
    signal: "rendered-measurement",
    family: "dom-measurement",
    test: /\brendered\b[^\n]{0,60}?\d+\s*[x×]\s*\d+|\b\d+(?:\.\d+)?px\b|\brgba?\(|\bgetcomputedstyle\b|\bcomputed (style|value)\b/i,
  },
  {
    // e1c15359 `[REQ-022] T-127`: "expect(received).toEqual(expected) // deep
    // equality" with a "- Expected / + Received" diff. A matcher printed a diff,
    // which means it had two values, which means one came back from the page.
    signal: "matcher-comparison",
    family: "matcher-diff",
    test: /\bexpect\(|\.to(equal|be|contain|havetext|havecount|haveattribute|matchsnapshot)\b|-\s*expected\b[\s\S]{0,80}\+\s*received\b/i,
  },
]);

/**
 * The scorer's own install root inside the container.
 *
 * NOT AN IMPORT: it is `const SCORER_HOME` at `bakeoff/src/scorer-container.ts:87`
 * and that module exports nothing (it throws on import outside the container),
 * so there is no symbol to import. `CONTAINER_PATHS` in `scorer-protocol.ts:47`
 * covers the MOUNTS — the artefact, the suite, the outputs — but not the image's
 * own tree, which is exactly the tree a grader defect lives in.
 */
const SCORER_INSTALL_ROOT = "/opt/bakeoff-scorer";

/** Values that make an `expected`/`actual` pair a shape rather than a comparison. */
const DEGENERATE_COMPARISON_VALUES: readonly string[] = Object.freeze(["", "true", "false", "null", "undefined"]);

/**
 * Stack frame function names that ARE the test body, not a helper.
 *
 * node:test renders the test callback as `TestContext.<anonymous>` and its own
 * machinery as `Test.run` / `startSubtestAfterBootstrap`; Playwright renders an
 * assertion inside the test body as a bare `at <path>:<line>:<col>` with no
 * function name at all (measured on 6ec44b2f and e1c15359 —
 * `at /scorer/suite/holdout/images-and-motion.spec.mjs:78:100`). A NAMED suite
 * frame that is none of these is a helper the test called, which is where
 * 047f9872 died: `at startServer (file:///scorer/suite/holdout/messages-persistence.test.mjs:116:12)`.
 */
const TEST_BODY_FRAME_NAMES: readonly string[] = Object.freeze([
  "TestContext.<anonymous>",
  "Test.run",
  "Test.processPendingSubtests",
  "startSubtestAfterBootstrap",
  "async TestContext.<anonymous>",
  "async Test.run",
  "async Test.processPendingSubtests",
  "async startSubtestAfterBootstrap",
  "process.processTicksAndRejections",
]);

/* -------------------------------------------------------------------------
 * Text helpers. All bounded, all pure.
 * ---------------------------------------------------------------------- */

/**
 * Remove SGR escapes.
 *
 * Playwright's `error.message` carries ANSI colour verbatim — measured on
 * e1c15359, whose message begins
 * `Error: …\n\n\x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m…` — and the
 * container copies it into `TestFailure.message` without stripping. Left in, the
 * escapes end up inside {@link Evidence.detail} and from there inside an email
 * to the owner as mojibake.
 */
function stripAnsi(text: string): string {
  // ESC is written as `\u001b` rather than a literal control character so the
  // source stays greppable and editable, and the escape is REQUIRED: the
  // pattern `\[[0-9;]*[A-Za-z]` on its own also eats the `[R` of `[REQ-006]`,
  // which would corrupt every title path this module reads.
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Literal `reportProblem` values the scorer writes when the SUITE NEVER RAN.
 *
 * Each is a `reportProblem:` assignment in `bakeoff/src/scorer-container.ts`,
 * quoted verbatim from the line cited. These are the three cases where the field
 * says "there was nothing to report" rather than "the report could not be read",
 * and the difference decides whether an unsupervised repair lane wakes.
 *
 * `:1634` is the one that was measured over-firing: run `052c6e02` produced it,
 * every criterion came back `unasserted`, and the module charged all sixteen to
 * the pipeline on a run whose artefact served no root document.
 */
const SUITE_NEVER_RAN_PROBLEMS: readonly string[] = Object.freeze([
  // scorer-container.ts:1634 — `runFrozenSuite`, `origin === null`.
  "the app never booted, so the frozen suite was not executed",
  // scorer-container.ts:2003 and :2087 — the total time budget, spent before the suite.
  "the scorer's total time budget was exhausted before the frozen suite could run",
  // scorer-container.ts:2184 — the top-level abort path.
  "the scorer aborted before executing the suite",
]);

/**
 * Is this `reportProblem` the HARNESS's failure, or merely the absence of a run?
 *
 * TRUE means "a report existed or should have and could not be read" — a parse
 * error, a truncated stream, a summary that disagrees with its own outcomes.
 * Those are the scorer's own defects and are pipeline evidence.
 *
 * FALSE means the suite never executed, and the message does not say why. The
 * app may not have booted because the BUILD is broken (artefact), or because the
 * frozen manifest declared no start command (the spec seat, i.e. pipeline). This
 * field cannot separate those, so the caller records a note and every criterion
 * it would have gated becomes UNKNOWN.
 *
 * ENUMERATE THE ABSENCES, DEFAULT THE REST TO HARNESS — and that direction is
 * deliberate. The absence set is small, closed and quoted from its producers; the
 * harness set is open-ended (every parse and consistency problem
 * `parseNodeTestReport` can push, and it composes them with `" | "`). Defaulting
 * the open set to "harness" keeps a new PARSE problem correctly pipeline-side.
 * The cost is that a new "never ran" message added to `scorer-container.ts`
 * without a line here would over-fire again — so the test suite pins all three
 * literals, and this comment is the instruction to extend it.
 */
function reportProblemIsHarnessFailure(reportProblem: string): boolean {
  return !SUITE_NEVER_RAN_PROBLEMS.some((known) => reportProblem.includes(known));
}

function bounded(text: string, max: number): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * A key two records of the SAME test agree on, even when one of them was
 * truncated by a different cap than the other.
 *
 * `CriterionCoverage.testRefs` is capped at 200 characters
 * (`scorer-container.ts:1299`) and `TestFailure.titlePath` at 300
 * (`collectFailures`). A title longer than 200 therefore appears in one place
 * cut and in the other whole, and a naive set membership would read a FAILING
 * test as a passing sibling — which is the one direction that turns the file
 * rule off when it should fire, and (worse, if the polarity is ever flipped) on
 * when it should not. Both writers' truncation markers are recognised.
 */
function titleKey(titlePath: string): string {
  const withoutMarker = stripAnsi(titlePath)
    .replace(/…\s*\(\d+ more characters\)\s*$/, "")
    .replace(/…\[truncated\]\s*$/, "");
  return withoutMarker.slice(0, 150);
}

/**
 * The suite-relative FILE a title path leads with, or null.
 *
 * Both runners lead with it: node:test because the reporter prepends the file
 * segment, Playwright because its report's root suite title IS the file. The
 * extension check is what stops a nested `describe()` title from being mistaken
 * for a filename when a title path somehow arrives without one.
 */
export function fileOfTitlePath(titlePath: string): string | null {
  const first = titlePath.split(TITLE_PATH_SEPARATOR)[0];
  if (first === undefined) return null;
  const trimmed = first.trim();
  return /\.[cm]?[jt]sx?$/.test(trimmed) ? trimmed : null;
}

/**
 * A fingerprint for "these two failures have the same cause".
 *
 * Digits are erased because the four `messages-persistence.test.mjs` failures in
 * 047f9872 differ ONLY in an ephemeral port number and a log timestamp
 * (`port 39211`, `port 36389`, …). Without that erasure the four read as four
 * causes and the file rule — the rule whose entire premise is "one cause" —
 * would never fire on the run it was derived from.
 */
function causeSignature(failure: AdjudicableFailure): string {
  const head = failure.message === null ? "" : bounded(failure.message.split("\n")[0] ?? "", 200);
  return `${failure.name ?? ""}|${failure.code ?? ""}|${head.toLowerCase().replace(/\d+/g, "#")}`;
}

/** Stack frames, as `{ fn, path }`. `fn` is null for a bare `at <path>:<l>:<c>` frame. */
function stackFrames(stack: string): readonly { readonly fn: string | null; readonly path: string }[] {
  const frames: { fn: string | null; path: string }[] = [];
  for (const line of stripAnsi(stack).split("\n")) {
    const named = /^\s*at\s+(.+?)\s+\((.+?)\)\s*$/.exec(line);
    if (named !== null && named[1] !== undefined && named[2] !== undefined) {
      frames.push({ fn: named[1], path: named[2] });
      continue;
    }
    const bare = /^\s*at\s+(\S+)\s*$/.exec(line);
    if (bare !== null && bare[1] !== undefined) frames.push({ fn: null, path: bare[1] });
  }
  return frames;
}

/**
 * Did the test compare two values that CARRY INFORMATION about what came back?
 *
 * `assert.ok(x)` renders `expected: "true", actual: "false"`. That is a
 * predicate that failed, not a value the app returned, and 6ec44b2f's
 * `sqlite-storage.test.mjs` failures — a documented GRADER defect, the byte-grep
 * looking under the wrong roots — carry exactly that pair. Treating any
 * expected/actual pair as proof the app answered would route that grader defect
 * to the build lane, where nothing can fix it.
 */
export function isSubstantiveComparison(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return false;
  const degenerate = (value: string): boolean => DEGENERATE_COMPARISON_VALUES.includes(value.trim().toLowerCase());
  return !(degenerate(expected) && degenerate(actual));
}

/* -------------------------------------------------------------------------
 * Phase 1 — evidence a single failure carries on its own.
 * ---------------------------------------------------------------------- */

/**
 * Read one failure's direct evidence. Returns BOTH sides: a failure that shows
 * both a dead harness and an answering app is a contradiction, and this module
 * reports the contradiction rather than picking the side it likes.
 */
/**
 * Families that mean "the app was never REACHED", regardless of anything else.
 *
 * A missing npm script, an unresolvable module, a spawn ENOENT or a browser that
 * will not launch are properties of the ENVIRONMENT the test ran in. None of
 * them can be caused by an app that works and then stops working, so none is
 * conditional on {@link AdjudicationInput}'s run-level state.
 *
 * `package-script` is the family that carries run `047f9872`, the case this
 * module is fitted to. It is in this list, which is why the narrowing below
 * cannot cost that verdict.
 */
const UNCONDITIONAL_BOOT_FAMILIES: readonly string[] = Object.freeze([
  "module-resolution",
  "package-script",
  "process-spawn",
  "browser-launch",
]);

function directEvidence(
  failure: AdjudicableFailure,
  source: string,
  /**
   * Did ANY criterion pass in this run — i.e. was the app observed answering?
   *
   * ADDED 2026-08-16 from a debugfix finding. `connection-refused` and
   * `boot-timeout` were unconditional pipeline evidence, so an artefact that
   * HANGS OR CRASHES PART-WAY THROUGH the suite produced a decisive PIPELINE
   * verdict and woke the unsupervised repair lane — against a working pipeline
   * and a broken website, which is the one wake design section 3A forbids.
   *
   * The module's own header already states the principle for `timedOut`: "An app
   * that hangs is an ARTEFACT defect; a scorer whose budget is too small is a
   * PIPELINE defect. The flag cannot separate them." Two message families were
   * deciding that same class anyway.
   *
   * A passing criterion is proof the app answered at least once. After that, a
   * refused connection to the artefact's own origin is at best undecidable, so
   * it stops being evidence for either side.
   */
  appAnswered: boolean,
): readonly Evidence[] {
  const found: Evidence[] = [];
  const text = `${failure.message ?? ""}\n${failure.stack ?? ""}`;
  const haystack = stripAnsi(text);

  if (failure.code !== null && HARNESS_ERROR_CODES.includes(failure.code.trim().toUpperCase())) {
    /*
     * THE SOCKET CODES ARE CONDITIONAL, FOR THE SAME REASON THE MESSAGE FAMILIES
     * ARE. Corrected 2026-08-16 — the first pass at this narrowing guarded the
     * BOOT_FAILURE_PATTERNS loop below and left this branch untouched, so the
     * identical class of failure still routed PIPELINE through the other door.
     * Fixing one of two paths is not fixing it.
     *
     * `ECONNREFUSED` from a harness that never reached the app is the harness's
     * problem. The same code, after the app has demonstrably answered, is an app
     * that died mid-suite — and that is the artefact's problem, which the main
     * workflow owns. The code cannot tell the two apart, so once `appAnswered` it
     * decides nothing.
     *
     * The module and file codes above it are NOT conditional: `ENOENT`,
     * `ERR_MODULE_NOT_FOUND` and their relatives describe the environment the
     * test ran in, and no working-then-crashing app produces them.
     */
    const code = failure.code.trim().toUpperCase();
    if (!(APP_DIED_CODES.includes(code) && appAnswered)) {
      found.push({
        signal: "runner-error-code",
        side: "pipeline",
        source: `${source}.code`,
        detail: `${failure.code} is an OS/module/socket failure, so the test never asserted anything`,
      });
    }
  }

  for (const pattern of BOOT_FAILURE_PATTERNS) {
    if (!pattern.test.test(haystack)) continue;
    /*
     * THE NARROWING. A "stopped answering" family is only pipeline evidence when
     * the app was never seen answering in the first place. Once a criterion has
     * passed, the same words describe an app that died mid-suite, which is the
     * artefact's failure and not the harness's — and no evidence at all is the
     * honest output, because this text cannot tell the two apart.
     */
    if (!UNCONDITIONAL_BOOT_FAMILIES.includes(pattern.family) && appAnswered) continue;
    found.push({
      signal: "boot-or-spawn-failure",
      side: "pipeline",
      source: `${source}.message`,
      detail: `${pattern.family}: ${bounded(failure.message ?? failure.stack ?? "", 200)}`,
    });
  }

  if (failure.stack !== null) {
    const frames = stackFrames(failure.stack);
    const installFrame = frames.find((frame) => frame.path.includes(SCORER_INSTALL_ROOT));
    if (installFrame !== undefined) {
      found.push({
        signal: "scorer-install-frame",
        side: "pipeline",
        source: `${source}.stack`,
        detail: `raised under the scorer's own install (${SCORER_INSTALL_ROOT}), not the artefact: ${bounded(installFrame.path, 160)}`,
      });
    }
  }

  if (isSubstantiveComparison(failure.expected, failure.actual)) {
    found.push({
      signal: "assertion-comparison",
      side: "artefact",
      source: `${source}.expected/actual`,
      detail: `expected ${bounded(failure.expected ?? "", 80)}, got ${bounded(failure.actual ?? "", 80)} — the app produced a value`,
    });
  }

  for (const pattern of ARTEFACT_MESSAGE_PATTERNS) {
    const hit = pattern.test.exec(haystack);
    if (hit === null) continue;
    found.push({
      signal: pattern.signal,
      side: "artefact",
      source: `${source}.message`,
      detail: `${pattern.family}: ${bounded(hit[0], 160)}`,
    });
  }

  return found;
}

/**
 * The LAST resort before UNKNOWN: the failure was raised inside a helper the
 * test called, rather than at an assertion in the test body.
 *
 * Applied ONLY to a failure that carries no direct evidence at all, which is why
 * it cannot overrule an app that answered. It is the shape of 047f9872 —
 * `at startServer (file:///scorer/suite/holdout/messages-persistence.test.mjs:116:12)`
 * — and the shape of every "the fixture blew up before the test ran" defect.
 *
 * ITS RISK, STATED: a helper that itself asserts against a response (`postJson`
 * throwing "unexpected status 500") also raises in a named frame. That case
 * carries a status in its message, so phase 1 has already claimed it and this
 * function is never reached. A helper that throws something UNRECOGNISED will be
 * called PIPELINE here, and that is the deliberate bias: an unrecognised throw
 * inside suite plumbing is a suite problem more often than it is a build one.
 */
function helperFrameEvidence(failure: AdjudicableFailure, source: string): Evidence | null {
  if (failure.stack === null) return null;
  const suiteFrame = stackFrames(failure.stack).find(
    (frame) => frame.path.includes("/suite/") || /\.(test|spec)\.[cm]?[jt]s/.test(frame.path),
  );
  if (suiteFrame === undefined || suiteFrame.fn === null) return null;
  if (TEST_BODY_FRAME_NAMES.includes(suiteFrame.fn)) return null;
  return {
    signal: "suite-helper-frame",
    side: "pipeline",
    source: `${source}.stack`,
    detail: `raised in the suite helper \`${bounded(suiteFrame.fn, 60)}\`, not at an assertion in the test body`,
  };
}

/* -------------------------------------------------------------------------
 * Phase 2 — the shape of the whole run.
 * ---------------------------------------------------------------------- */

interface FileCensus {
  /** Failures recorded against this file. */
  readonly failed: number;
  /** Tests KNOWN to have passed in it. A lower bound: the census is built from `testRefs`. */
  readonly passedKnown: number;
}

/**
 * Per-file pass/fail counts, assembled from the two places a test title appears.
 *
 * `criterionCoverage[].testRefs` lists the tests that asserted each criterion,
 * passing and failing alike; `failures[].titlePath` lists the failing ones. A ref
 * that is not a failure is therefore a test that PASSED.
 *
 * THE CENSUS IS A LOWER BOUND ON PASSES, AND THE BOUND IS NOT ALWAYS SAFE.
 * An untagged passing test appears in neither list, and under-counting passes on
 * its own only makes {@link fileLevelCause}'s guard 3 easier to satisfy — which
 * is the dangerous direction, not the safe one. Two things hold it down. The
 * `testRefs` cap is detected by the caller and switches the shape rules off
 * outright. The remaining hole is a KEY COLLISION: {@link titleKey} compares the
 * first 150 characters, so two tests identical for 150 characters — one passing,
 * one failing — make the passing one look like the failing one, drop it from the
 * census, and let the file rule fire on a file that had a survivor. It needs a
 * suite with near-duplicate titles in one file to happen at all, and no archived
 * suite has one; it is recorded rather than fixed because the alternative
 * (comparing full titles) reintroduces the two-different-caps bug that
 * {@link titleKey} exists for, which is the commoner failure by far.
 */
function censusByFile(input: AdjudicationInput, failingKeys: ReadonlySet<string>): ReadonlyMap<string, FileCensus> {
  const census = new Map<string, { failed: number; passedKnown: number }>();
  const bump = (file: string | null, key: "failed" | "passedKnown"): void => {
    if (file === null) return;
    const row = census.get(file) ?? { failed: 0, passedKnown: 0 };
    row[key] += 1;
    census.set(file, row);
  };

  const seenRefs = new Set<string>();
  for (const criterion of input.criterionCoverage) {
    for (const ref of criterion.testRefs) {
      const key = titleKey(ref);
      if (seenRefs.has(key) || failingKeys.has(key)) continue;
      seenRefs.add(key);
      bump(fileOfTitlePath(ref), "passedKnown");
    }
  }
  for (const failure of input.suiteExecution.failures) bump(fileOfTitlePath(failure.titlePath), "failed");
  return census;
}

/**
 * Is this file's redness one file-level cause? Six guards, and every one of
 * them exists because removing it lets a working pipeline be blamed.
 *
 * 1. the failure list is complete — otherwise "no test in this file passed" is
 *    read off a list that is missing rows. ENFORCED BY THE CALLER
 *    (`shapeRulesUsable`), which also covers the `testRefs` cap, because both
 *    are properties of the whole result rather than of one file;
 * 2. at least two failures — one failing test in a one-test file has no shape,
 *    it is just a failing test;
 * 3. no test in the file is known to have passed — a sibling test that passed
 *    proves the file's harness ran;
 * 4. some OTHER file is fully green — without it the whole run is red and
 *    "this file is special" is not a claim the evidence supports;
 * 5. every failure in the file shares one cause signature — otherwise it is N
 *    defects that happen to live together;
 * 6. no failure in the file shows the app answering — the case this rule is
 *    most dangerous for is a single broken endpoint that every test in one file
 *    depends on, and that case always leaves an answer behind.
 */
function fileLevelCause(
  file: string,
  census: ReadonlyMap<string, FileCensus>,
  failuresInFile: readonly AdjudicableFailure[],
  fileHasArtefactEvidence: boolean,
): Evidence | null {
  const row = census.get(file);
  if (row === undefined || row.failed < 2 || row.passedKnown > 0) return null;
  if (fileHasArtefactEvidence) return null;

  const greenSibling = [...census.entries()].find(
    ([other, stats]) => other !== file && stats.failed === 0 && stats.passedKnown > 0,
  );
  if (greenSibling === undefined) return null;

  const signatures = new Set(failuresInFile.map(causeSignature));
  if (signatures.size !== 1) return null;

  return {
    signal: "whole-file-one-cause",
    side: "pipeline",
    source: `suiteExecution.failures[file=${file}]`,
    detail:
      `all ${row.failed} test(s) in ${file} failed with one signature while ${greenSibling[0]} passed all ` +
      `${greenSibling[1].passedKnown} of its known test(s) — a file-level cause, not ${row.failed} independent defects`,
  };
}

/* -------------------------------------------------------------------------
 * The verdict.
 * ---------------------------------------------------------------------- */

function verdictFrom(evidence: readonly Evidence[]): { verdict: Verdict; reason: string } {
  const pipeline = evidence.filter((item) => item.side === "pipeline");
  const artefact = evidence.filter((item) => item.side === "artefact");
  if (pipeline.length > 0 && artefact.length > 0) {
    return {
      verdict: "UNKNOWN",
      reason:
        `the evidence contradicts itself: ${pipeline.map((item) => item.signal).join(", ")} says the harness died, ` +
        `${artefact.map((item) => item.signal).join(", ")} says the app answered`,
    };
  }
  if (pipeline.length > 0) {
    return { verdict: "PIPELINE", reason: pipeline.map((item) => item.detail).join("; ") };
  }
  if (artefact.length > 0) {
    return { verdict: "ARTEFACT", reason: artefact.map((item) => item.detail).join("; ") };
  }
  return {
    verdict: "UNKNOWN",
    reason: "no evidence in the record says whether the app was reached",
  };
}

/**
 * Adjudicate one scored run: for every criterion that did not pass, whose fault
 * it is, and therefore whether the repair lane wakes.
 *
 * PURE. Same input, same answer, forever — which is what lets the acceptance
 * test (§9.3 conjunct 1, "the lane WAKES on 047f9872, classifying it pipeline
 * rather than artefact") be a unit test rather than a re-run of a container.
 *
 * ON ARCHIVED RESULTS IT ANSWERS `UNKNOWN`, AND THAT IS CORRECT RATHER THAN A
 * GAP. Every `result.json` written before 2026-08-16 has no `failures` array, so
 * the only thing the record says about a failing criterion is which test titles
 * failed. §12.3 is explicit that titles cannot settle this question. Returning
 * PIPELINE for those would be the guess this module exists to refuse.
 */
export function adjudicate(input: AdjudicationInput): Adjudication {
  const notes: string[] = [];
  const runEvidence: Evidence[] = [];
  /*
   * TRUE when the suite produced no report AND the reason does not say whose
   * fault that is. Read by the `unasserted` arm, which must not charge a
   * criterion to the pipeline on the strength of a row the scorer marks
   * `unasserted` for EVERY criterion when the run never executed.
   */
  let undecidableSuiteOutcome = false;

  if (input.infrastructureErrors.length > 0) {
    runEvidence.push({
      signal: "scorer-infrastructure-error",
      side: "pipeline",
      source: "infrastructureErrors[0]",
      detail: `the scorer itself failed: ${bounded(input.infrastructureErrors[0] ?? "", 200)}`,
    });
  }
  if (input.suiteExecution.reportProblem !== null) {
    /*
     * NOT EVERY `reportProblem` IS A HARNESS FAILURE, AND TREATING THEM ALIKE
     * WAKES THE LANE ON A BROKEN WEBSITE. Corrected 2026-08-16 against a real
     * archived record.
     *
     * This branch used to push `side: "pipeline"` for every value. Measured on
     * `run-2026-07-30T20-16-40-242Z-052c6e02`: its `reportProblem` is *"the app
     * never booted, so the frozen suite was not executed"* — written by
     * `runFrozenSuite` when `origin === null` (`bakeoff/src/scorer-container.ts`)
     * — and the whole run came out `{"PIPELINE": 16}` with `wakeRepairLane:
     * true`. That run's `GATE:boot` failed because the artefact served no root
     * document. **A build that does not boot is the purest ARTEFACT defect there
     * is**, and design §3A assigns it to the main workflow. The repair lane would
     * have woken to patch the pipeline over a website that does not run.
     *
     * The split is on WHO the message is about, not on a string from one
     * incident. A report that could not be READ is the harness's problem. A
     * report that does not exist because the APP never came up is not — and,
     * critically, it is not automatically the artefact's either: the manifest may
     * have declared no start command, which is the spec seat's defect. That is
     * genuinely undecidable from this field, which is what UNKNOWN is for.
     *
     * DEFAULTS TO `unknown`, DELIBERATELY. An unrecognised value is the exact
     * case where we do not know, and the two mistakes are not symmetric: a false
     * PIPELINE wakes the lane against a working pipeline and lets it patch the
     * machine over a broken website, which is the one wake the owner forbade. A
     * false UNKNOWN costs a missed wake and says so on the owner's report.
     */
    if (reportProblemIsHarnessFailure(input.suiteExecution.reportProblem)) {
      runEvidence.push({
        signal: "no-machine-readable-report",
        side: "pipeline",
        source: "suiteExecution.reportProblem",
        detail: `no machine-readable report was parsed, so nothing was fairly measured: ${bounded(input.suiteExecution.reportProblem, 200)}`,
      });
    } else {
      /*
       * A NOTE, NOT EVIDENCE, AND THE CHANNEL IS THE POINT. `EvidenceSide` is
       * deliberately binary — every Evidence entry argues FOR one side — so an
       * undecidable fact has no honest representation there. Forcing it in as
       * `pipeline` is precisely the defect this block was corrected for.
       */
      undecidableSuiteOutcome = true;
      notes.push(
        `the suite produced no report and the reason does not say whose fault that is, so every criterion it ` +
          `would have gated is UNKNOWN rather than charged to either side: ${bounded(input.suiteExecution.reportProblem, 200)}`,
      );
    }
  }

  const failures = input.suiteExecution.failures;
  const counted = input.suiteExecution.testsFailed;
  // `===`, WHERE THE SIBLING PREDICATE USES `>=`. `triageSuiteFailures`'
  // `attributionComplete` (`scorer-protocol.ts:277`) accepts `failures.length >=
  // countedFailures`, which is right for a GATE that must not excuse a failure
  // by silence. This is not that question. More reasons than counted failures
  // means the two lists disagree about what happened, and a census built on a
  // list that disagrees with the runner is a census nothing should be routed on
  // — so the strict form, which errs toward "shape rules off".
  const evidenceComplete = counted !== null && failures.length === counted;
  if (!evidenceComplete) {
    notes.push(
      counted === null
        ? "the runner reported no failure count, so this record cannot be shown to be complete; shape rules are off"
        : `${counted} test(s) failed but ${failures.length} reason(s) reached the record; shape rules are off`,
    );
  }
  // `testRefs` is capped at 10 per criterion (`scorer-container.ts:1299`). At the
  // cap the pass census is PROVABLY short, so "no test in this file passed" is
  // no longer a claim the data supports and the file rule must not be trusted.
  const refCapHit = input.criterionCoverage.some((criterion) => criterion.testRefs.length >= 10);
  if (refCapHit) {
    notes.push("a criterion carries 10 testRefs, the writer's cap, so the pass census is incomplete; shape rules are off");
  }
  const shapeRulesUsable = evidenceComplete && !refCapHit;

  const failingKeys = new Set(failures.map((failure) => titleKey(failure.titlePath)));
  const census = censusByFile(input, failingKeys);

  /* Phase 1 for every failure, then phase 2 for the ones it left empty. */
  /*
   * PROOF THE APP ANSWERED AT LEAST ONCE. A passed criterion cannot be produced
   * by an app that never came up, so this is the discriminator between "never
   * reached" and "stopped responding". See `directEvidence`'s `appAnswered`.
   */
  const appAnswered = input.criterionCoverage.some((criterion) => criterion.outcome === "passed");
  const direct = failures.map((failure, index) => directEvidence(failure, `failures[${index}]`, appAnswered));
  const artefactByFile = new Set<string>();
  failures.forEach((failure, index) => {
    const file = fileOfTitlePath(failure.titlePath);
    if (file !== null && (direct[index] ?? []).some((item) => item.side === "artefact")) artefactByFile.add(file);
  });

  const verdicts: FailureVerdict[] = failures.map((failure, index) => {
    const file = fileOfTitlePath(failure.titlePath);
    const evidence = [...(direct[index] ?? []), ...runEvidence];
    if (evidence.length === 0 && shapeRulesUsable && file !== null) {
      const sameFile = failures.filter((other) => fileOfTitlePath(other.titlePath) === file);
      const shape = fileLevelCause(file, census, sameFile, artefactByFile.has(file));
      if (shape !== null) evidence.push(shape);
    }
    if (evidence.length === 0) {
      const helper = helperFrameEvidence(failure, `failures[${index}]`);
      if (helper !== null) evidence.push(helper);
    }
    const { verdict, reason } = verdictFrom(evidence);
    return { titlePath: failure.titlePath, file, verdict, evidence, reason };
  });

  /* Charge failures to criteria. */
  const criteria: CriterionVerdict[] = [];
  const charged = new Set<number>();
  for (const criterion of input.criterionCoverage) {
    if (criterion.outcome === "passed") continue;

    const refKeys = new Set(criterion.testRefs.map(titleKey));
    const mine: FailureVerdict[] = [];
    failures.forEach((failure, index) => {
      // `criterionIds` is the scorer's OWN attribution and is preferred. The
      // `testRefs` fallback exists because a failure whose tagging was lost —
      // the reporter dropping the field, a title cut by a cap — would otherwise
      // vanish from the criterion it belongs to, and a criterion with no charged
      // failure is the shape that reads as "no evidence".
      const isMine = failure.criterionIds.includes(criterion.criterionId) || refKeys.has(titleKey(failure.titlePath));
      if (!isMine) return;
      const row = verdicts[index];
      if (row === undefined) return;
      charged.add(index);
      mine.push(row);
    });

    if (criterion.outcome === "unasserted") {
      /*
       * `unasserted` MEANS TWO DIFFERENT THINGS AND ONLY ONE OF THEM IS A
       * PIPELINE DEFECT. Corrected 2026-08-16.
       *
       * When the suite RAN, `unasserted` means what `attributeCriteria` says it
       * means: no test in the frozen suite carries this criterion's token. That
       * IS a pipeline defect and it is the purest one — the suite is frozen
       * before the build starts, so nothing the builder did could remove a test
       * that was never written.
       *
       * When the suite NEVER RAN, the scorer marks EVERY criterion `unasserted`
       * as a side effect, and the word carries no information at all. Reading it
       * as "no test carries this token" then charges the pipeline for sixteen
       * criteria on the strength of a field that was never populated. Measured
       * on `052c6e02`: `{"PIPELINE": 16}`, `wakeRepairLane: true`, on a run whose
       * artefact served no root document.
       *
       * THE DISCRIMINATOR IS STRUCTURAL, NOT A STRING. `undecidableSuiteOutcome`
       * is set above from the shape of the report problem, and a suite that
       * produced no outcomes at all cannot distinguish the two readings, so the
       * answer is UNKNOWN and the lane stays asleep.
       */
      if (undecidableSuiteOutcome) {
        const detail =
          `${criterion.criterionId} is marked unasserted, but the suite never produced a report, so every ` +
          `criterion is marked that way and the word says nothing about whether a test for it exists`;
        criteria.push({
          criterionId: criterion.criterionId,
          tier: criterion.tier,
          verdict: "UNKNOWN",
          reason: detail,
          failures: mine,
          evidence: [
            {
              signal: "criterion-unasserted",
              side: "pipeline",
              source: `criterionCoverage[${criterion.criterionId}]`,
              detail,
            },
          ],
        });
        continue;
      }
      // NOT AN ARTEFACT DEFECT, EVER. The suite is frozen before the build runs,
      // so nothing the builder did can remove a test that was never written. It
      // is the purest case of "the test never fairly exercised the criterion".
      const detail =
        input.suiteExecution.reportProblem === null
          ? `no test in the frozen suite carries ${criterion.criterionId}; the suite, not the build, failed to gate it`
          : `${criterion.criterionId} looks unasserted because no report parsed, which is a harness failure, not a missing test`;
      const evidence: Evidence[] = [
        { signal: "criterion-unasserted", side: "pipeline", source: `criterionCoverage[${criterion.criterionId}]`, detail },
        ...runEvidence,
      ];
      criteria.push({
        criterionId: criterion.criterionId,
        tier: criterion.tier,
        verdict: "PIPELINE",
        reason: detail,
        failures: mine,
        evidence,
      });
      continue;
    }

    if (mine.length === 0) {
      criteria.push({
        criterionId: criterion.criterionId,
        tier: criterion.tier,
        verdict: runEvidence.length > 0 ? "PIPELINE" : "UNKNOWN",
        reason:
          runEvidence.length > 0
            ? runEvidence.map((item) => item.detail).join("; ")
            : `${criterion.criterionId} failed but no per-test reason reached this record, so nothing says why`,
        failures: [],
        evidence: [...runEvidence],
      });
      continue;
    }

    const sides = new Set(mine.map((row) => row.verdict));
    let verdict: Verdict;
    let reason: string;
    if (sides.has("PIPELINE") && sides.has("ARTEFACT")) {
      // One test says the harness died and another says the app answered. Both
      // may be true — a grader defect can coexist with a build defect — and
      // choosing between them here is the guess §1.1 refuses.
      verdict = "UNKNOWN";
      reason =
        `${mine.filter((row) => row.verdict === "PIPELINE").length} test(s) show a dead harness and ` +
        `${mine.filter((row) => row.verdict === "ARTEFACT").length} show the app answering; the record cannot say which broke this criterion`;
    } else if (sides.has("ARTEFACT")) {
      // An UNKNOWN sibling does not contradict a test that watched the app
      // answer wrongly: the criterion IS unmet, and the main workflow owns it.
      verdict = "ARTEFACT";
      reason = mine
        .filter((row) => row.verdict === "ARTEFACT")
        .map((row) => row.reason)
        .join("; ");
    } else if (sides.has("PIPELINE")) {
      verdict = "PIPELINE";
      reason = mine
        .filter((row) => row.verdict === "PIPELINE")
        .map((row) => row.reason)
        .join("; ");
    } else {
      verdict = "UNKNOWN";
      reason = `${mine.length} test(s) failed and none of them says whether the app was reached`;
    }

    criteria.push({
      criterionId: criterion.criterionId,
      tier: criterion.tier,
      verdict,
      reason,
      failures: mine,
      evidence: [...runEvidence],
    });
  }

  const unattributedFailures = verdicts.filter((_row, index) => !charged.has(index));

  return {
    criteria,
    unattributedFailures,
    runEvidence,
    /*
     * UNATTRIBUTED FAILURES COUNT. Corrected 2026-08-16 from a debugfix finding.
     *
     * This read `runEvidence.length > 0 || criteria.some(PIPELINE)` and excluded
     * `unattributedFailures` — the failures this module's own docblock calls
     * "the ones most likely to BE the suite defect", because a test carrying no
     * criterion id is invisible to `criterionCoverage` entirely. So the class of
     * failure most likely to be a grader bug was the one class that could never
     * wake the lane. Measured: one failing test with no criterion id and a
     * message of `connect ECONNREFUSED 127.0.0.1:3000`, every coverage row
     * passing -> `unattributedFailures[0].verdict === "PIPELINE"`, `criteria`
     * empty, `wakeRepairLane` FALSE, and `notes` empty, so nothing anywhere said
     * the lane had slept on pipeline evidence.
     */
    wakeRepairLane:
      runEvidence.length > 0 ||
      criteria.some((row) => row.verdict === "PIPELINE") ||
      unattributedFailures.some((row) => row.verdict === "PIPELINE"),
    evidenceComplete,
    notes,
  };
}
