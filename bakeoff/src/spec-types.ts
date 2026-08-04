/**
 * spec-types.ts — the types the held-out acceptance suite needs and that
 * contracts.ts does not expose.
 *
 * contracts.ts is FROZEN. It models a suite as `criteria + testFiles + a freeze
 * digest`, which is everything the SCORER needs. It deliberately models nothing
 * about:
 *
 *   - the VISIBLE / HELD-OUT split (doc 03 section 7.5: the gap between the two
 *     pass rates IS the reward-hacking metric, and it must be reported);
 *   - which runner executes a file (Playwright for UI flows, node:test for
 *     API/logic);
 *   - which test ids satisfy which criterion, which is what makes
 *     "every criterion names its evidence" (doc 02 section 5.4) checkable
 *     instead of aspirational;
 *   - the test ids the scorer should EXPECT to see, which is what turns
 *     "the runner collected zero tests" into a detectable infrastructure error
 *     rather than a uniform false negative across every configuration.
 *
 * Everything here is additive. Nothing in contracts.ts, config.ts, hash.ts,
 * redact.ts or env.ts is modified.
 *
 * THE SPLIT RIDES IN THE FREEZE DIGEST. A test file's visibility is encoded in
 * its path (`holdout/...` or `visible/...`), and `acceptanceSuiteDigest` covers
 * the sorted file paths. Flipping a file from held-out to visible therefore
 * changes the frozen suite digest and is caught by the scorer's pre-run check.
 * The remaining metadata — runner, criterion bindings, expected test ids — is
 * NOT covered by that digest, so this module supplies a second digest
 * ({@link holdoutPlanDigest}) which the freeze record carries and verifies.
 */

import { BAKEOFF_SCHEMA_VERSION, BakeoffError } from "./contracts.js";
import type {
  AcceptanceCriterion,
  AcceptanceSuite,
  BudgetPolicy,
  CriterionTier,
  TestFileRef,
} from "./contracts.js";
import { canonicalJsonDigest, sha256Hex } from "./hash.js";
import type { JsonValue } from "./hash.js";

/* -------------------------------------------------------------------------
 * 1. Layout constants
 * ---------------------------------------------------------------------- */

/**
 * Default root for sealed suites. A suite lands at
 * `<root>/<ticketId>/FROZEN.json` with its test files under
 * `<root>/<ticketId>/suite/{holdout,visible}/`.
 *
 * `acceptance/generated` RATHER THAN `acceptance`, deliberately. The scaffold's
 * .gitignore ignores `acceptance/generated/` and states why: "no builder may
 * read, list or modify the suite. Keeping it out of the repo keeps it out of
 * any workspace clone." A default of bare `acceptance/` would commit every
 * sealed gate into git, and constraint 1 would then rest on nobody cloning the
 * harness repo into a build workspace. Pass `acceptanceRoot: "acceptance"` to
 * get the flatter layout; the path SHAPE is `<root>/<ticketId>/FROZEN.json`
 * either way. Both are covered by BUILDER_FORBIDDEN_PATH_PREFIXES' "acceptance/".
 */
export const DEFAULT_ACCEPTANCE_ROOT = "acceptance/generated";

/** Directory inside `acceptance/<ticketId>/` that holds the test files. */
export const SUITE_ROOT_DIRNAME = "suite";

/** The freeze manifest, written at `acceptance/<ticketId>/FROZEN.json`. */
export const FROZEN_FILENAME = "FROZEN.json";

/** Audit report. Outside the digested suite root; a convenience copy. */
export const AUDIT_FILENAME = "AUDIT.json";

/**
 * Which half of the split a test file belongs to.
 *
 * - `holdout` — never leaves `acceptance/`. The builder cannot read, list or
 *   modify it. This is what decides `heldOutPass`.
 * - `visible` — a COPY is materialised into the builder's workspace so the
 *   builder has a real feedback signal. Scoring NEVER executes the builder's
 *   copy: it re-executes the frozen original in the clean container. The
 *   builder may therefore edit its copy freely without affecting any number.
 */
export type SuiteVisibility = "holdout" | "visible";

export const SUITE_VISIBILITIES: readonly SuiteVisibility[] = Object.freeze(["holdout", "visible"]);

/** Directory name for each half. Also the required first path segment. */
export const VISIBILITY_DIRNAME: Readonly<Record<SuiteVisibility, string>> = Object.freeze({
  holdout: "holdout",
  visible: "visible",
});

/**
 * Test runners.
 *
 * `node-test` is `node:test` for API and logic; `playwright` is
 * `@playwright/test` for UI flows.
 */
export type TestRunner = "node-test" | "playwright";

export const TEST_RUNNERS: readonly TestRunner[] = Object.freeze(["node-test", "playwright"]);

/**
 * WHAT THE SEALED SCORER IMAGE MUST ALREADY CONTAIN, per runner.
 *
 * This is a prerequisite on the scorer, which lives outside this module, and
 * it is stated here because `plan.files[].runner` is the only place the
 * requirement is derivable from.
 *
 * The failure it prevents is expensive and silent: the sandbox network policy
 * is `egress: "denied"` with an empty allowlist (held-constant variable 3), so
 * `npx playwright install` CANNOT run at scoring time. Browsers must be baked
 * into the image. If they are not, every Playwright test fails in every
 * configuration, `heldOutPass` is false everywhere, and the uniform result
 * reads as five models failing rather than as one missing dependency.
 * {@link assertAllExpectedTestsReported} catches a runner that collected
 * NOTHING; it cannot catch tests that ran and failed for want of a browser.
 */
export const SCORER_IMAGE_REQUIREMENTS: Readonly<Record<TestRunner, string>> = Object.freeze({
  "node-test":
    "node >= 22.12, invoked as a SECOND pass: `node --test --test-concurrency=1` over the frozen " +
    "*.test.mjs files, named explicitly, with the image's own NDJSON reporter " +
    "(docker/node-test-reporter.mjs) written to an explicit --test-reporter-destination. No extra " +
    "dependency. Its outcomes are merged with Playwright's into ONE outcome set before criteria are " +
    "attributed.",
  playwright:
    "@playwright/test installed AND its browser binaries pre-baked into the image, plus a config " +
    "whose testMatch is NARROWED to **/*.spec.mjs. The 1.62 DEFAULT, " +
    "**/*.@(spec|test).?(c|m)[jt]s?(x), also collects *.test.mjs — where an imported node:test " +
    "`test()` registers nothing, so those files run, print, and produce no attributable outcome. " +
    "That defect made every node-test criterion unpassable and read as a uniform model failure " +
    "(STATUS.md blocker 1.1). Verify at image-build time, not at scoring time: egress is denied and " +
    "the download cannot happen then.",
});

/**
 * Required file suffix per runner.
 *
 * `.mjs` for BOTH runners, verified rather than assumed:
 *   - `node --check <file>.mjs` syntax-checks ESM (including top-level await),
 *     which is what makes the pre-freeze syntax gate possible without a
 *     TypeScript toolchain inside the sealed scorer container;
 *   - Playwright's default `testMatch` is
 *     `**\/*.@(spec|test).?(c|m)[jt]s?(x)` (verified in playwright 1.62,
 *     `lib/common/index.js`), which matches `.spec.mjs`.
 * A suite written in TypeScript would need a compiler in the scorer image,
 * which is a second thing that has to be held constant across every run.
 */
export const RUNNER_SUFFIX: Readonly<Record<TestRunner, string>> = Object.freeze({
  "node-test": ".test.mjs",
  playwright: ".spec.mjs",
});

/**
 * Cap on total acceptance criteria (doc 02 section 5.4: "Cap total criteria at
 * ~25"). Enforced as a hard 25 — a cap that is not enforced is a suggestion.
 */
export const MAX_CRITERIA = 25;

/** Stable REQ-ID, e.g. "REQ-014". */
export const REQ_ID_PATTERN = /^REQ-\d{3}$/;

/** Stable test id, e.g. "T-14" (doc 02 section 5.4's own example). */
export const TEST_ID_PATTERN = /^T-\d{1,3}$/;

/** Test file basename: no traversal, no spaces, no leading dot. */
export const TEST_BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Minimum fraction of FUNCTIONAL criteria that must have a VISIBLE counterpart
 * as well as a held-out one.
 *
 * HARNESS CHOICE, not prescribed by any source document. Rationale: the
 * visible-vs-held-out gap is only interpretable as reward hacking when the two
 * halves test the SAME requirements with different fixtures. A gap computed
 * over one paired criterion is noise. One paired criterion is the hard floor
 * (below it the gap is undefined and doc 03 section 7.5 cannot be satisfied);
 * this fraction is the advisory target above that floor.
 */
export const MIN_VISIBLE_FUNCTIONAL_FRACTION = 1 / 3;

/* -------------------------------------------------------------------------
 * 2. The authoring budget
 * ---------------------------------------------------------------------- */

/**
 * HARD CEILING FOR SUITE AUTHORING — enforced out of process, checked BEFORE
 * each API call, exactly as constraint 3 requires.
 *
 * DELIBERATELY NOT `DEFAULT_BUDGET` from config.ts. That policy's
 * `maxCostUsd` is $120, sized at roughly 2x a modelled baseline BUILD ticket.
 * Suite authoring is two to six Opus 5 `xhigh` calls at roughly $2-6 each; a
 * ceiling twenty times above expected spend never fires, and a ceiling that
 * never fires is decoration rather than a control.
 *
 * Sizing: worst case per call is ~$3.30 (a conservative input estimate at the
 * $5/MTok cache-miss rate plus 128,000 output tokens at $25/MTok). One ticket
 * runs at most `maxAttempts` x (author + audit) calls; at the default of 3
 * attempts that is 6 calls, ~$20 if every single one exhausts `max_tokens`.
 * Realistic spend is $3-6. $25 clears the worst case without leaving a runaway
 * unbounded.
 *
 * CAMPAIGN: $175 covers 6 reference tickets at the $25 per-ticket worst case
 * plus one re-author. IT ONLY BINDS WHEN ONE `SpendCeiling` IS SHARED ACROSS
 * ALL SIX TICKETS — `authorAndFreezeSuite` called six times builds six
 * independent ceilings and the campaign figure never fires. Use
 * `authorAndFreezeAllSuites`, which shares one, or pass `ceiling` yourself. A
 * documented ceiling that cannot fire is worse than no ceiling: it reads as
 * enforcement.
 *
 * This spend draws on the "failed runs, spec regeneration, contingency ~$300"
 * line in config.ts's campaign arithmetic — it is NOT additional to the $3,500
 * campaign ceiling.
 */
export const AUTHORING_BUDGET: BudgetPolicy = Object.freeze({
  maxCostUsd: 25,
  maxWallClockMs: 30 * 60 * 1000,
  maxCampaignCostUsd: 175,
  warnAtFraction: 0.8,
  perVendorMaxOutputTokens: null,
  // The spec seat runs a single non-agentic call per invocation, so there is no
  // agentic loop for a vendor task budget to pace. Recorded as empty rather
  // than omitted so the run log states it explicitly.
  vendorAdvisoryBudgets: Object.freeze([]),
});

/**
 * The streamable `max_tokens` ceiling on every current Claude model except
 * Haiku 4.5, which caps at 64K. There is nothing above this to retry at.
 */
export const MAX_STREAMABLE_OUTPUT_TOKENS = 128_000;

/**
 * What the Claude CLI gives a call when nothing sets
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
 *
 * MEASURED OFF A DEAD RUN, NOT READ OUT OF A DOC. Run
 * `run-2026-08-04T11-08-10-487Z-162b186d` died in the spec phase with the CLI's
 * own words in the event log: "API Error: Claude's response exceeded the 64000
 * output token maximum. To configure this behavior, set the
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable." Every constant in this
 * file said 128,000 at the time; the number that actually governed was this one,
 * because on the subscription path `maxOutputTokens` never reached the model
 * (`dashboard/server/src/subscription-caller.ts`, which now sets the variable).
 *
 * Named rather than inlined so the ladder below starts on a rung this repo can
 * point at, and so a test can assert the starting budget IS the CLI's default
 * rather than a number someone liked.
 */
export const CLI_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * The STARTING `max_tokens` for an authoring or audit call. The first rung, not
 * the ceiling — {@link MAX_STREAMABLE_OUTPUT_TOKENS} is the ceiling.
 *
 * ─── WHAT THIS CONSTANT USED TO SAY, AND WHY IT NO LONGER SAYS IT ───
 *
 * Until 2026-08-04 this was `= MAX_STREAMABLE_OUTPUT_TOKENS`, argued as follows,
 * and the argument is reproduced because the half of it that is still true is
 * still load-bearing:
 *
 *   "128,000, NOT the documented 64,000 floor for effort `xhigh`. Two things
 *   share this budget and the second is easy to forget: adaptive thinking tokens
 *   are billed as output AND count against `max_tokens`, and the spec seat runs
 *   at `xhigh` precisely so it thinks hard. A hard ticket's suite is up to 25
 *   criteria plus eight or ten test files whose complete source is carried
 *   inside JSON string literals; at 64,000 a deep thinking pass can leave too
 *   little behind it. A truncated response is the expensive failure mode here,
 *   because the model cannot fix it — `max_tokens` is the harness's parameter,
 *   not the model's — so a truncation would otherwise burn an authoring attempt
 *   on a defect no amount of regeneration addresses, three times, and leave the
 *   two hard tickets with no suite at all. Headroom is cheaper than that."
 *
 * THE ARITHMETIC IS STILL RIGHT. Thinking still shares the budget, the spec seat
 * still runs at `xhigh`, and a suite carrying eight files' complete source is
 * still enormous. Nothing below rebuts any of that.
 *
 * WHAT IS REBUTTED IS THE PREMISE UNDERNEATH IT: "a truncation would burn an
 * attempt on a defect no amount of regeneration addresses". That was true when
 * the paragraph was written and it is not true now. `spec-agent.ts` detects a
 * truncation, raises the budget to {@link MAX_STREAMABLE_OUTPUT_TOKENS} and
 * retries WITHOUT consuming an attempt. Pre-emptive headroom was the cheapest
 * way to avoid the expensive failure only while the expensive failure was
 * unobservable.
 *
 * AND SETTING THIS EQUAL TO THE CEILING DISABLED THE THING THAT REPLACED IT. The
 * ladder's guard is `if (outputTokens < MAX_STREAMABLE_OUTPUT_TOKENS)`. With the
 * default AT the ceiling, the rung it climbs to was the rung it started on: the
 * retry could never fire, and the only outcome a truncation could produce was
 * the terminal "does not fit in a single response" error. A recovery mechanism
 * that cannot execute is not headroom, it is decoration.
 *
 * SO THE START IS THE CLI'S OWN DEFAULT ({@link CLI_DEFAULT_MAX_OUTPUT_TOKENS}),
 * WHICH IS ALSO WHAT ACTUALLY RAN. This is not a reduction from 128,000 in
 * practice — on the subscription path the effective budget was already 64,000
 * and the harness simply did not know it. What changes is that the number is now
 * declared, sent (via `CLAUDE_CODE_MAX_OUTPUT_TOKENS`), observed when it is
 * exceeded, and climbed out of. The API path (`anthropic-seat.ts` passes
 * `max_tokens` straight through) starts one rung lower than it used to and pays
 * for that with at most ONE extra call on the hardest tickets, on the owner's
 * explicit ordering: "context loss is not ok, using up a lot of tokens is."
 *
 * ONE INTERACTION TO KNOW ABOUT, NOT A REGRESSION. {@link AUTHORING_BUDGET}
 * caps wall clock at 30 minutes and `SpendCeiling.checkBeforeCall` refuses a
 * dispatch once that is spent, so a first attempt that burns the half hour will
 * have its free retry refused. That is not worse than before — before, there was
 * no retry to refuse — and the dashboard, which is where the measured failure
 * happened, supervises with `DASHBOARD_BUDGET` (four hours) instead.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = CLI_DEFAULT_MAX_OUTPUT_TOKENS;

/** Default regeneration cap. Fail clean rather than loop (constraint 3). */
export const DEFAULT_MAX_AUTHORING_ATTEMPTS = 3;

/* -------------------------------------------------------------------------
 * 3. Draft shapes — what the spec seat produces, before it is frozen
 * ---------------------------------------------------------------------- */

/**
 * One test file as authored, with its source still in memory.
 *
 * `expectedTestIds` is the contract with the scorer: these ids MUST appear in
 * the runner's report. If the runner reports none of them, the suite did not
 * execute — an infrastructure error that would otherwise present as every
 * criterion failing, identically, in every configuration.
 */
export interface DraftTestFile {
  /** POSIX-relative to the suite root, e.g. `holdout/booking.test.mjs`. */
  readonly path: string;
  readonly visibility: SuiteVisibility;
  readonly runner: TestRunner;
  /** One line, for the audit report. Never shown to a builder. */
  readonly description: string;
  /** Test ids this file defines. Each must literally appear in `source`. */
  readonly expectedTestIds: readonly string[];
  /** REQ-IDs this file provides evidence for. */
  readonly criterionIds: readonly string[];
  /** The file's exact bytes, as UTF-8 text. Written verbatim, never rewritten. */
  readonly source: string;
}

/**
 * A criterion plus the structured evidence binding that
 * {@link AcceptanceCriterion.evidenceRequired} states in prose.
 *
 * doc 02 section 5.4: "Every criterion must name the evidence artifact that can
 * satisfy it. This is the mechanism that stops a judge passing a stub." Prose
 * alone is not checkable; the id lists are.
 */
export interface DraftCriterion extends AcceptanceCriterion {
  /** Held-out test ids that decide this criterion. MUST be non-empty. */
  readonly holdoutTestIds: readonly string[];
  /** Visible twins of the above, testing the same requirement, different fixtures. */
  readonly visibleTestIds: readonly string[];
  /** Non-test artefacts, e.g. "db-query-7 count >= 1". May be empty. */
  readonly evidenceArtifacts: readonly string[];
}

/** A complete suite as authored, before audit and freeze. */
export interface SuiteDraft {
  readonly ticketId: string;
  readonly ticketSha256: string;
  readonly criteria: readonly DraftCriterion[];
  readonly files: readonly DraftTestFile[];
}

/* -------------------------------------------------------------------------
 * 4. The hold-out plan — the metadata the freeze digest does not cover
 * ---------------------------------------------------------------------- */

export interface SuiteTestFilePlan {
  readonly path: string;
  readonly visibility: SuiteVisibility;
  readonly runner: TestRunner;
  readonly description: string;
  readonly expectedTestIds: readonly string[];
  readonly criterionIds: readonly string[];
}

export interface CriterionEvidencePlan {
  readonly criterionId: string;
  readonly tier: CriterionTier;
  readonly holdoutTestIds: readonly string[];
  readonly visibleTestIds: readonly string[];
  readonly evidenceArtifacts: readonly string[];
}

/**
 * The split, the runner assignment and the criterion bindings.
 *
 * Digested separately by {@link holdoutPlanDigest} because
 * `acceptanceSuiteDigest` (hash.ts, frozen) covers only ticket id, ticket
 * digest, criteria and per-file content digests. Without this second digest a
 * criterion could be re-bound to a different test without changing the frozen
 * suite digest.
 */
export interface HoldoutPlan {
  readonly planVersion: 1;
  readonly ticketId: string;
  readonly files: readonly SuiteTestFilePlan[];
  readonly evidence: readonly CriterionEvidencePlan[];
}

const sortByPath = <T extends { readonly path: string }>(a: T, b: T): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const sortById = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Build the plan from a draft. Sorted, so the digest is order-independent. */
export function planFromDraft(draft: SuiteDraft): HoldoutPlan {
  return {
    planVersion: 1,
    ticketId: draft.ticketId,
    files: [...draft.files]
      .sort(sortByPath)
      .map((f) => ({
        path: f.path,
        visibility: f.visibility,
        runner: f.runner,
        description: f.description,
        expectedTestIds: [...f.expectedTestIds].sort(sortById),
        criterionIds: [...f.criterionIds].sort(sortById),
      })),
    evidence: [...draft.criteria]
      .sort((a, b) => sortById(a.id, b.id))
      .map((c) => ({
        criterionId: c.id,
        tier: c.tier,
        holdoutTestIds: [...c.holdoutTestIds].sort(sortById),
        visibleTestIds: [...c.visibleTestIds].sort(sortById),
        evidenceArtifacts: [...c.evidenceArtifacts].sort(sortById),
      })),
  };
}

/** Digest of the hold-out plan. Deterministic: sorted keys, sorted members. */
export function holdoutPlanDigest(plan: HoldoutPlan): string {
  const value: JsonValue = {
    planVersion: plan.planVersion,
    ticketId: plan.ticketId,
    files: [...plan.files].sort(sortByPath).map((f) => ({
      path: f.path,
      visibility: f.visibility,
      runner: f.runner,
      expectedTestIds: [...f.expectedTestIds].sort(sortById),
      criterionIds: [...f.criterionIds].sort(sortById),
    })),
    evidence: [...plan.evidence]
      .sort((a, b) => sortById(a.criterionId, b.criterionId))
      .map((e) => ({
        criterionId: e.criterionId,
        tier: e.tier,
        holdoutTestIds: [...e.holdoutTestIds].sort(sortById),
        visibleTestIds: [...e.visibleTestIds].sort(sortById),
        evidenceArtifacts: [...e.evidenceArtifacts].sort(sortById),
      })),
  };
  return canonicalJsonDigest(value);
}

/** Strip a draft down to the frozen `AcceptanceCriterion` shape. */
export function criteriaFromDraft(draft: SuiteDraft): readonly AcceptanceCriterion[] {
  return draft.criteria.map((c) => ({
    id: c.id,
    statement: c.statement,
    evidenceRequired: c.evidenceRequired,
    tier: c.tier,
  }));
}

/**
 * Content digests for the draft's files, computed from the IN-MEMORY source.
 *
 * These must equal what `digestFileSet` (hash.ts) later computes from disk.
 * They do, because `freezeSuite` writes each source with UTF-8 encoding and no
 * transformation — the same bytes that are hashed here. `freezeSuite` asserts
 * the equality rather than assuming it.
 */
export function testFileRefsFromDraft(draft: SuiteDraft): readonly TestFileRef[] {
  return [...draft.files]
    .sort(sortByPath)
    .map((f) => {
      const bytes = Buffer.from(f.source, "utf8");
      return { path: f.path, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    });
}

/* -------------------------------------------------------------------------
 * 5. Path helpers
 * ---------------------------------------------------------------------- */

/** Expected path prefix for a visibility, e.g. `holdout/`. */
export function visibilityPrefix(visibility: SuiteVisibility): string {
  return `${VISIBILITY_DIRNAME[visibility]}/`;
}

/**
 * The scorer's execution manifest, at the suite ROOT.
 *
 * Must equal `SUITE_MANIFEST_FILENAME` in scorer-protocol.ts. It is spelled out
 * here rather than imported so spec-types.ts stays free of a scorer dependency;
 * `assertSuiteManifestPathAgrees` below is the guard that keeps the two honest.
 */
export const SUITE_MANIFEST_PATH = "suite.manifest.json";

/**
 * Throw if the two spellings of the manifest path have drifted apart.
 *
 * Called by the scorer at startup. A silent divergence here re-creates exactly
 * the contradiction this constant was introduced to remove.
 */
export function assertSuiteManifestPathAgrees(scorerFilename: string): void {
  if (scorerFilename !== SUITE_MANIFEST_PATH) {
    throw new Error(
      `not implemented: the suite manifest path disagrees between modules — ` +
        `spec-types says ${JSON.stringify(SUITE_MANIFEST_PATH)}, the scorer says ` +
        `${JSON.stringify(scorerFilename)}. A suite authored against one is unscorable by the other.`,
    );
  }
}

/** True for the suite-level declaration file, which is not a test. */
export function isSuiteManifestPath(path: string): boolean {
  return path === SUITE_MANIFEST_PATH;
}

/**
 * The visibility a path declares, or null when the path is not a legal suite
 * path. Legal shape: exactly `<holdout|visible>/<basename>.{test,spec}.mjs`.
 *
 * The suite manifest sits at the root and declares NO visibility. It is held
 * out from the builder by virtue of not being under `visible/`, which is the
 * only thing `materialiseVisibleSubset` copies.
 */
export function visibilityOfPath(path: string): SuiteVisibility | null {
  for (const visibility of SUITE_VISIBILITIES) {
    if (path.startsWith(visibilityPrefix(visibility))) return visibility;
  }
  return null;
}

/** The runner a path's suffix declares, or null when it declares none. */
export function runnerOfPath(path: string): TestRunner | null {
  for (const runner of TEST_RUNNERS) {
    if (path.endsWith(RUNNER_SUFFIX[runner])) return runner;
  }
  return null;
}

/**
 * Structural problems with a suite-relative path, or an empty list.
 *
 * Rejects traversal, absolute paths, backslashes, nesting and any suffix that
 * neither runner claims. A suite path is a filesystem write target inside a
 * sealed directory; it is not somewhere to be permissive.
 */
export function pathProblems(path: string): readonly string[] {
  // THE ONE DECLARATION FILE THAT IS NOT A TEST.
  //
  // Integration finding: this function required every suite path to be exactly
  // `<holdout|visible>/<basename>.{test,spec}.mjs`, while the sealed scorer
  // (scorer.ts, `SUITE_MANIFEST_FILENAME`) REFUSES any suite whose freeze does
  // not contain a file at exactly `suite.manifest.json`. No string satisfied
  // both, so no suite the spec seat could author was scorable — and nothing
  // type-checked it, so the first sign would have been a uniform scoring
  // failure across all five configurations, after the money was spent.
  //
  // The manifest is resolved by EXACT string match, deliberately. It is not a
  // prefix, not a suffix and not case-insensitive: `x/suite.manifest.json`,
  // `suite.manifest.jsonx` and `SUITE.MANIFEST.JSON` all remain illegal. It
  // lives at the suite ROOT rather than under `holdout/`, which is what keeps
  // it away from the builder: `materialiseVisibleSubset` copies paths under
  // `visible/` and nothing else, so a root-level file is never materialised.
  if (path === SUITE_MANIFEST_PATH) return [];

  const problems: string[] = [];
  if (path.length === 0) {
    return ["path is empty"];
  }
  if (path !== path.trim()) problems.push("path has leading or trailing whitespace");
  if (path.includes("\\")) problems.push("path contains a backslash; use POSIX separators");
  if (path.startsWith("/")) problems.push("path is absolute; it must be relative to the suite root");
  if (path.includes("..")) problems.push('path contains ".."');
  if (path.includes("//")) problems.push("path contains an empty segment");

  const segments = path.split("/");
  if (segments.length !== 2) {
    problems.push(
      `path must have exactly two segments, "<holdout|visible>/<basename>", got ${segments.length}`,
    );
    return problems;
  }
  const [dir, basename] = segments as [string, string];
  if (dir !== VISIBILITY_DIRNAME.holdout && dir !== VISIBILITY_DIRNAME.visible) {
    problems.push(
      `first segment must be "${VISIBILITY_DIRNAME.holdout}" or "${VISIBILITY_DIRNAME.visible}", got "${dir}"`,
    );
  }
  if (!TEST_BASENAME_PATTERN.test(basename)) {
    problems.push(`basename "${basename}" is not [A-Za-z0-9][A-Za-z0-9._-]*`);
  }
  if (runnerOfPath(path) === null) {
    problems.push(
      `basename must end with "${RUNNER_SUFFIX["node-test"]}" (node:test) or ` +
        `"${RUNNER_SUFFIX.playwright}" (Playwright)`,
    );
  }
  return problems;
}

/* -------------------------------------------------------------------------
 * 6. The visible-vs-held-out gap (doc 03 section 7.5)
 * ---------------------------------------------------------------------- */

/** One test's outcome, as reported by the runner in the clean container. */
export interface TestOutcome {
  readonly testId: string;
  readonly passed: boolean;
}

/**
 * THE reward-hacking metric.
 *
 * doc 02 section 5.4: "Surface the visible-vs-holdout pass-rate GAP as a
 * first-class dashboard number. That gap IS the reward-hacking metric, and it
 * grows 28 percentage points per tenfold increase in code size — so it will be
 * widest on exactly the ambitious tickets this product exists to serve."
 *
 * Computed ONLY over criteria that have BOTH a held-out and a visible test, so
 * the two rates measure the same requirements. A criterion tested only
 * held-out would otherwise depress the held-out rate for a reason that has
 * nothing to do with overfitting.
 *
 * BOTH RATES ARE MEASURED ON THE FROZEN FILES, executed in the clean container.
 * The builder's writable copy of the visible half is never an input: if it
 * were, a builder that deleted a visible test would report a perfect visible
 * rate and a zero gap.
 */
export interface VisibleHoldoutGap {
  /** Criteria with at least one held-out AND at least one visible test. */
  readonly pairedCriteria: number;
  /** Fraction of paired criteria whose visible tests all passed. */
  readonly visiblePassRate: number | null;
  /** Fraction of paired criteria whose held-out tests all passed. */
  readonly holdoutPassRate: number | null;
  /** (visible - held-out) in percentage points. Positive means overfitting. */
  readonly gapPercentagePoints: number | null;
  /**
   * Test ids a paired criterion depends on for which the runner reported
   * nothing. Non-empty means the rates are NOT computed: a missing outcome is
   * an infrastructure error, and silently treating it as a failure would make
   * a broken runner look like a model result.
   */
  readonly unreportedTestIds: readonly string[];
}

/** Compute the gap. Never guesses at a missing outcome. */
export function computeVisibleHoldoutGap(
  plan: HoldoutPlan,
  outcomes: readonly TestOutcome[],
): VisibleHoldoutGap {
  const byId = new Map<string, boolean>();
  for (const outcome of outcomes) {
    const existing = byId.get(outcome.testId);
    // A test id reported twice is only "passed" if every report passed.
    byId.set(outcome.testId, existing === undefined ? outcome.passed : existing && outcome.passed);
  }

  const paired = plan.evidence.filter(
    (e) => e.holdoutTestIds.length > 0 && e.visibleTestIds.length > 0,
  );
  if (paired.length === 0) {
    return {
      pairedCriteria: 0,
      visiblePassRate: null,
      holdoutPassRate: null,
      gapPercentagePoints: null,
      unreportedTestIds: [],
    };
  }

  const unreported = new Set<string>();
  for (const e of paired) {
    for (const id of [...e.holdoutTestIds, ...e.visibleTestIds]) {
      if (!byId.has(id)) unreported.add(id);
    }
  }
  if (unreported.size > 0) {
    return {
      pairedCriteria: paired.length,
      visiblePassRate: null,
      holdoutPassRate: null,
      gapPercentagePoints: null,
      unreportedTestIds: [...unreported].sort(sortById),
    };
  }

  const allPassed = (ids: readonly string[]): boolean => ids.every((id) => byId.get(id) === true);
  const visiblePasses = paired.filter((e) => allPassed(e.visibleTestIds)).length;
  const holdoutPasses = paired.filter((e) => allPassed(e.holdoutTestIds)).length;
  const visiblePassRate = visiblePasses / paired.length;
  const holdoutPassRate = holdoutPasses / paired.length;

  return {
    pairedCriteria: paired.length,
    visiblePassRate,
    holdoutPassRate,
    gapPercentagePoints: (visiblePassRate - holdoutPassRate) * 100,
    unreportedTestIds: [],
  };
}

/** Every test id the frozen suite expects the runner to report. */
export function expectedTestIds(
  plan: HoldoutPlan,
  visibility?: SuiteVisibility,
): readonly string[] {
  const ids = new Set<string>();
  for (const file of plan.files) {
    if (visibility !== undefined && file.visibility !== visibility) continue;
    for (const id of file.expectedTestIds) ids.add(id);
  }
  return [...ids].sort(sortById);
}

/**
 * Guard for the scorer: refuse to score when the runner did not report the
 * tests the frozen plan says exist.
 *
 * Without this, a runner that collected zero tests produces "every criterion
 * failed" — identically, in every configuration — which reads as a uniform
 * model failure rather than as the broken harness it is.
 */
export function assertAllExpectedTestsReported(
  plan: HoldoutPlan,
  outcomes: readonly TestOutcome[],
): void {
  const reported = new Set(outcomes.map((o) => o.testId));
  const expected = expectedTestIds(plan);
  const missing = expected.filter((id) => !reported.has(id));
  if (missing.length === 0) return;
  throw new BakeoffError(
    "invalid_usage_shape",
    `the suite runner reported ${reported.size} of ${expected.length} expected test ids for ticket ` +
      `${plan.ticketId}; missing: ${missing.slice(0, 20).join(", ")}` +
      (missing.length > 20 ? ` (+${missing.length - 20} more)` : ""),
    "Do NOT record this as a held-out failure. A runner that collects fewer tests than the frozen " +
      "plan declares is an infrastructure error: it fails every criterion identically in every " +
      "configuration and reads as a model result. Check the scorer image, the runner invocation and " +
      "the test-file glob, then re-score.",
  );
}

/* -------------------------------------------------------------------------
 * 7. The freeze record
 * ---------------------------------------------------------------------- */

/** Outcome of the read-only attempt. Recorded, never silently assumed. */
export interface FreezePermissions {
  readonly attempted: boolean;
  readonly filesReadOnly: boolean;
  readonly directoriesReadOnly: boolean;
  /** Redacted reason the attempt failed, or null. */
  readonly problem: string | null;
}

/**
 * `acceptance/<ticketId>/FROZEN.json`.
 *
 * Carries the frozen {@link AcceptanceSuite} verbatim plus the hold-out plan
 * that the suite digest cannot cover, and its own self-consistency digest.
 *
 * `recordSha256` covers the suite's freeze digest, the plan digest, the ticket
 * identity and the audit verdict. Re-running the audit rewrites this file and
 * changes `recordSha256`; it does NOT change `suite.sha256`, which is the
 * digest recorded in every run and score record. That separation is deliberate
 * (hash.ts: "Re-running the adversarial audit must not change the freeze").
 */
export interface FrozenSuiteRecord {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly recordVersion: 1;
  readonly suite: AcceptanceSuite;
  readonly plan: HoldoutPlan;
  readonly planSha256: string;
  readonly recordSha256: string;
  /** ISO-8601 instant the suite was sealed. */
  readonly frozenAt: string;
  /** Suite root relative to the record, always `suite`. */
  readonly suiteRootRelPath: string;
  readonly permissions: FreezePermissions;
}

/** Digest over the freeze record's load-bearing fields. */
export function frozenRecordDigest(input: {
  readonly suiteSha256: string;
  readonly planSha256: string;
  readonly ticketId: string;
  readonly ticketSha256: string;
  readonly auditPassed: boolean;
  readonly criteriaCount: number;
  readonly testFileCount: number;
}): string {
  const value: JsonValue = {
    recordVersion: 1,
    suiteSha256: input.suiteSha256,
    planSha256: input.planSha256,
    ticketId: input.ticketId,
    ticketSha256: input.ticketSha256,
    auditPassed: input.auditPassed,
    criteriaCount: input.criteriaCount,
    testFileCount: input.testFileCount,
  };
  return canonicalJsonDigest(value);
}

/* -------------------------------------------------------------------------
 * 8. Integrity report
 * ---------------------------------------------------------------------- */

export type IntegrityViolationKind =
  | "missing_manifest"
  | "unreadable_manifest"
  | "record_digest_mismatch"
  | "plan_digest_mismatch"
  | "suite_digest_mismatch"
  | "file_digest_mismatch"
  | "file_missing"
  | "file_added"
  | "audit_not_passed"
  | "plan_suite_disagreement";

export interface IntegrityViolation {
  readonly kind: IntegrityViolationKind;
  /** Suite-relative path, or null for a suite-level violation. */
  readonly path: string | null;
  readonly detail: string;
}

/** Non-fatal observations. A writable suite is a warning, not a mismatch. */
export interface IntegrityWarning {
  readonly detail: string;
}

export interface SuiteIntegrityReport {
  readonly ticketId: string;
  readonly suiteDir: string;
  readonly intact: boolean;
  /** The freeze digest the scorer must record, or null when unreadable. */
  readonly acceptanceSuiteSha256: string | null;
  readonly violations: readonly IntegrityViolation[];
  readonly warnings: readonly IntegrityWarning[];
  readonly checkedAt: string;
}
