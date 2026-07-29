/**
 * calibration/grade-fixture.ts — run one fixture through the REAL sealed gate.
 *
 * WHAT THIS PROVES, AND IT IS NARROWER THAN IT LOOKS. It proves the Tier-0 gates
 * fire, that reward-hack detection inspects test files the ARTEFACT shipped,
 * that `computeOutcome`'s tier arithmetic holds against real container output,
 * and that the verdict renders. It does NOT prove the grader discriminates: the
 * suite in `suites/portfolio-suite.ts` is committed, so whatever discrimination
 * it produces was chosen by its author — who had read all seven artefacts —
 * rather than measured. Task 4B authors a suite from the ticket alone and is the
 * one that answers Gap 4. Nothing here may be quoted as evidence that the
 * grader's judgement is any good.
 *
 * NO STAND-IN ANYWHERE IN THE PATH. `createGate` builds the same
 * `SealedScorerGate` the bake-off uses: a `--network=none` container from a
 * digest-resolved image, the frozen suite mounted read-only at 0444, the
 * artefact staged into a copy. A calibration run against a mock would measure
 * the mock.
 *
 * THE RUN RECORD IS REPRODUCED FROM `bakeoff/test/scorer-modes.e2e.mjs`, which
 * is the primary source for this shape — the orchestrator's own `#runRecord` is
 * private. Two fields there are stand-ins and are named as such below rather
 * than left to look real: there is no builder and no builder sandbox in
 * calibration, because the artefact was committed rather than built.
 *
 * TWO THINGS MEASURED HERE THAT CHANGED THE DESIGN, both recorded in
 * `probes/results/calibration-4a.json`:
 *
 *   1. `GATE:suite-green` is a BLOCKING container gate that fails whenever ANY
 *      frozen test fails, whatever tier the test's criterion declares. So every
 *      content failure is carried at BLOCKING, and FUNCTIONAL can never be the
 *      STRICTEST failing tier for any artefact the suite catches. The tier
 *      assertion in `calibration.test.ts` is therefore weaker than Revision 2's
 *      R2 assumed, and `failedGates` — not `failingTier` — is what keeps the
 *      exploit path from dying unnoticed.
 *   2. A QUALITY criterion cannot be carried by a frozen test, for the same
 *      reason: it would fail the run at BLOCKING through `GATE:suite-green`.
 *      QUALITY findings therefore come from `qualityFindingsFor` below, outside
 *      the suite.
 *
 * WHAT IS DELIBERATELY NOT FILTERED. Every `CriterionResult` the score record
 * carries goes into the verdict input, including the `QUALITY:*` results the
 * host rolls up from the container's DOM observations. Dropping those would make
 * `correct-portfolio` easier to keep green by hiding a class of QUALITY signal,
 * which is tuning the yardstick with extra steps.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceSuite, CriterionResult, RunRecord, ScoreRecord } from "bakeoff/dist/contracts.js";
import {
  DEFAULT_BUDGET,
  JUDGE_SEAT,
  SEALED_NETWORK_POLICY,
  SPEC_SEAT,
  getConfig,
  heldConstantsFor,
} from "bakeoff/dist/config.js";
import { createGate } from "bakeoff/dist/gate.js";
import { acceptanceSuiteDigest, sha256Hex, ticketDigest } from "bakeoff/dist/hash.js";
import { freezeSuite, verifySuiteIntact } from "bakeoff/dist/spec-freeze.js";
import { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "bakeoff/dist/spec-types.js";
import { deterministicAudit } from "bakeoff/dist/spec-validate.js";
import type { ExploitFinding } from "bakeoff/dist/scorer-protocol.js";
import type { ApiCriterionTier } from "../api-types.js";
import { extractAssumptions } from "../spec-assumptions.js";
import { computeOutcome, failingTier, renderVerdict } from "../verdict.js";
import type { VerdictInput, VerdictOutcome } from "../verdict.js";
import { visualCriteriaFor } from "../visual-criteria.js";
import { artefactDir } from "./fixtures.js";
import type { CalibrationFixture } from "./fixtures.js";
import { portfolioDraft } from "./suites/portfolio-suite.js";

/** Scorer image. Overridable so the negative control can point at a missing one. */
const SCORER_IMAGE = process.env["BAKEOFF_SCORER_IMAGE"] ?? "bakeoff-scorer:1";

/**
 * Where freeze output, staging, score records and screenshots land.
 *
 * Under `dashboard/results/`, which `.gitignore` already excludes as run state.
 * NOT under `src/`: `freezeSuite` chmods the sealed suite to 0444 and `tsc`
 * would then be compiling a read-only tree it has no business seeing.
 */
export const CALIBRATION_RUN_ROOT = fileURLToPath(new URL("../../../results/calibration-4a/", import.meta.url));

export interface FixtureVerdict {
  readonly outcome: VerdictOutcome;
  /** The strictest tier carrying a failure, or null on pass. */
  readonly failingTier: ApiCriterionTier | null;
  /** Gate ids that failed, for the record. Reserved `GATE:` prefix only. */
  readonly failedGates: readonly string[];
  readonly exploitFindings: readonly ExploitFinding[];
  /* --- recorded beyond the plan's interface, because a bare outcome cannot be
     triaged when it disagrees with the fixture. --- */
  /** Authored criterion ids (REQ-nnn) that did not pass. */
  readonly failedCriteria: readonly string[];
  /** `QUALITY:*` results the host rolled up from the container's observations. */
  readonly qualityCriteria: readonly string[];
  /** Authored QUALITY notes, from `qualityFindingsFor`. */
  readonly qualityFindings: readonly string[];
  readonly heldOutPass: boolean;
  readonly suiteSha256: string;
  /** Rendered verdict. Kept so calibration can prove the page renders at all. */
  readonly verdictMarkdown: string;
  readonly scoreRecordPath: string;
}

/* -------------------------------------------------------------------------
 * QUALITY findings — the half of the bar no frozen test may carry
 * ---------------------------------------------------------------------- */

/**
 * Satisfiers for `VIS-MOTION-AUTHORED`, as a disjunction.
 *
 * `visual-criteria.ts` states the rule this encodes: scroll-scrubbed media, a
 * real GSAP/ScrollTrigger timeline, or rAF-driven scrubbing all satisfy it, and
 * no single library may be mandated — the owner's own reference site would fail
 * a criterion demanding GSAP. Hover lifts and opacity fades satisfy nothing,
 * which is why `transition` and `:hover` are absent from this list.
 */
const MOTION_SATISFIERS: readonly RegExp[] = [
  /\bIntersectionObserver\b/,
  /\brequestAnimationFrame\b/,
  /\bScrollTrigger\b/,
  /\bgsap\s*\.\s*(?:timeline|to|from|fromTo)\b/,
  /\bscrollY\b|\bscrollTop\b|\bgetBoundingClientRect\b/,
  /addEventListener\s*\(\s*['"`]scroll['"`]/,
  /\bcurrentTime\s*=/,
  /\banimation-timeline\b|\bscroll-timeline\b|\bview\s*\(\s*\)|\bscroll\s*\(\s*\)/,
  /\bWeb\s*Animations\b|\.animate\s*\(/,
];

/** Files whose text can carry motion. HTML counts: inline `<script>` is script. */
const MOTION_SOURCE_SUFFIXES: readonly string[] = [".js", ".mjs", ".cjs", ".ts", ".html", ".htm"];

function readMotionSources(dir: string): string {
  const parts: string[] = [];
  const visit = (current: string): void => {
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MOTION_SOURCE_SUFFIXES.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue;
      try {
        parts.push(readFileSync(abs, "utf8"));
      } catch {
        /* unreadable file: recorded by absence, never by a guess */
      }
    }
  };
  visit(dir);
  return parts.join("\n");
}

/**
 * QUALITY notes for one artefact.
 *
 * A DELIBERATE PROXY, AND ITS LIMITS ARE THE POINT. Phase 2b's DESIGN lane will
 * judge `visualCriteriaFor`'s criteria against a locked mockup with a vision
 * model. That is nondeterministic and cannot be a standing gate, so this grades
 * ONE of those criteria — `VIS-MOTION-AUTHORED` — by the only deterministic
 * evidence available offline: whether the artefact's own scripts drive anything
 * from scroll position or a frame callback. The other floor criteria (contrast,
 * measure, surface habits) have no deterministic proxy and are NOT emitted here:
 * a criterion that cannot be decided produces findings on every artefact, which
 * is a finding generator rather than a check.
 *
 * IT IS ALSO THE NEGATIVE CONTROL FOR TASK 2. The statement is taken from
 * `visualCriteriaFor`, not rewritten here, and an empty motion set throws. If
 * Task 2 ever returns `[]`, `stock-motion-only` would otherwise grade a clean
 * `pass`, become indistinguishable from `correct-portfolio`, and calibration
 * would stay green with the visual path dead — R3, exactly.
 */
export function qualityFindingsFor(dir: string): readonly string[] {
  const motion = visualCriteriaFor({ lockedMockup: null }).filter((criterion) => criterion.check === "motion");
  if (motion.length === 0) {
    throw new Error(
      "visualCriteriaFor() returned no motion criterion. With none, pass_with_notes is unreachable and " +
        "stock-motion-only grades identically to correct-portfolio — calibration would stay green with " +
        "the visual-criteria path dead (Phase 2e Revision 2, R3).",
    );
  }
  const authored = motion[0];
  if (authored === undefined) return [];
  const text = readMotionSources(dir);
  if (MOTION_SATISFIERS.some((pattern) => pattern.test(text))) return [];
  return [
    `${authored.id}: no authored motion. Nothing in the artefact's own scripts is driven by scroll ` +
      `position, a frame callback or a media timeline — only declarative hover/opacity transitions, if ` +
      `that. Criterion: ${authored.statement}`,
  ];
}

/* -------------------------------------------------------------------------
 * The gate run
 * ---------------------------------------------------------------------- */

function hasBuildScript(dir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return false;
    const scripts = (parsed as Record<string, unknown>)["scripts"];
    if (scripts === null || typeof scripts !== "object") return false;
    return typeof (scripts as Record<string, unknown>)["build"] === "string";
  } catch {
    return false;
  }
}

/**
 * The image's own content digest.
 *
 * `RepoDigests` is empty for a locally built image, so `.Id` is used — the same
 * choice `SealedScorerGate` makes for the scorer image itself. It stands in for
 * the builder sandbox in `heldConstants`, which wants a `sha256:<64 hex>` and
 * has nothing true to be given: calibration has no builder.
 */
function localImageId(imageRef: string): string {
  const raw = execFileSync("docker", ["image", "inspect", imageRef, "--format", "{{.Id}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(raw)) {
    throw new Error(`docker reported image id ${JSON.stringify(raw)} for ${imageRef}, which is not a content digest`);
  }
  return raw;
}

/** `freezeSuite` writes 0444, so a previous tree cannot simply be unlinked. */
function resetDir(dir: string): void {
  if (existsSync(dir)) {
    try {
      execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
    } catch {
      /* best effort; rmSync reports the real problem with the real path */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

function buildSuite(draft: ReturnType<typeof portfolioDraft>): AcceptanceSuite {
  const criteria = criteriaFromDraft(draft);
  const testFiles = testFileRefsFromDraft(draft);
  const now = new Date().toISOString();
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    ticketId: draft.ticketId,
    ticketSha256: draft.ticketSha256,
    criteria,
    testFiles,
    sha256: acceptanceSuiteDigest({
      ticketId: draft.ticketId,
      ticketSha256: draft.ticketSha256,
      criteria,
      testFiles,
    }),
    generatedBy: SPEC_SEAT,
    generatedByHarness: { id: "dashboard-calibration-4a", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex(
      "phase 2e task 4A: hand-authored calibration suite, committed. No model was called.",
    ),
    generatedAt: now,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: now,
  };
}

/**
 * A ticket id derived from the fixture name. `CAL-BLANK-PAGE` and friends: the
 * sealed store is keyed by it, so it must be a stable filesystem segment.
 */
function ticketIdFor(name: string): string {
  return `CAL-${name.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`;
}

/**
 * Score one fixture through the sealed container.
 *
 * THROWS RATHER THAN DEGRADING. Every failure mode here — no docker daemon, no
 * scorer image, an artefact directory that is not there, a draft the
 * deterministic audit rejects — is a reason calibration DID NOT RUN, and a
 * calibration that did not run must never be reported as one that passed. The
 * messages name the reason so a red suite is actionable without a rerun.
 */
export async function gradeFixture(fixture: CalibrationFixture): Promise<FixtureVerdict> {
  const dir = artefactDir(fixture.name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`calibration fixture ${fixture.name} has no artefact directory at ${dir}`);
  }

  const ticketId = ticketIdFor(fixture.name);
  const draft = portfolioDraft({
    ticketId,
    ticketSha256: ticketDigest(fixture.ticket),
    hasBuildScript: hasBuildScript(dir),
  });

  // The real deterministic bad-test audit, before anything is frozen.
  // contracts.ts:314-317: a suite that fails the audit must never have builds
  // run against it. That applies to the calibration suite as much as to an
  // authored one — more so, since this one is committed and would stay wrong.
  const auditFindings = deterministicAudit(draft);
  const blocking = auditFindings.filter((finding) => finding.mustRegenerate);
  if (blocking.length > 0) {
    throw new Error(
      `the committed calibration suite FAILS the deterministic bad-test audit, so no artefact was scored ` +
        `against it: ${blocking.map((finding) => finding.detail).join(" | ")}`,
    );
  }

  const base = join(CALIBRATION_RUN_ROOT, fixture.name);
  const acceptanceRoot = join(base, "acceptance");
  const resultsDir = join(base, "results");
  const runDir = join(base, "run");
  resetDir(base);
  for (const each of [acceptanceRoot, resultsDir, runDir]) mkdirSync(each, { recursive: true });

  const suite = buildSuite(draft);
  freezeSuite(
    { suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [...auditFindings] },
    { acceptanceRoot },
  );
  const intact = verifySuiteIntact(ticketId, { acceptanceRoot });
  if (!intact.intact) {
    throw new Error(`the frozen calibration suite for ${fixture.name} did not verify intact after freezing`);
  }

  const gate = await createGate({
    ...process.env,
    BAKEOFF_SCORER_IMAGE: SCORER_IMAGE,
    BAKEOFF_RESULTS_DIR: resultsDir,
    BAKEOFF_ACCEPTANCE_ROOT: acceptanceRoot,
  });

  const config = getConfig("A");
  const startedAt = new Date().toISOString();
  const runId = `cal-${fixture.name}`;
  const run: RunRecord = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId,
    ticketId,
    ticketSha256: draft.ticketSha256,
    configId: config.id,
    repeatIndex: 0,
    startedAt,
    endedAt: startedAt,
    wallClockMs: 0,
    status: "completed",
    killReason: null,
    // RECORDED, NEVER SCORING. True so that a failing fixture also surfaces as a
    // false finish — the metric that would otherwise hide a harness bug behind
    // "the model shipped a broken app".
    agentDeclaredDone: true,
    selfReportPath: null,
    usage: [],
    totalCostUsd: 0,
    pricingBasis: [],
    seats: config.seats,
    heldConstants: heldConstantsFor({
      config,
      harness: { id: "dashboard-calibration-4a", version: "0.1.0", commit: "unversioned" },
      // STAND-IN, and named as one: calibration builds nothing, so there is no
      // builder sandbox. The scorer image's own id fills a slot that wants a
      // content digest and that nothing in this path reads.
      sandbox: {
        imageRef: SCORER_IMAGE,
        imageDigest: localImageId(SCORER_IMAGE),
        networkPolicy: SEALED_NETWORK_POLICY,
      },
      repeatCount: 1,
      acceptanceSuiteSha256: suite.sha256,
    }),
    budget: DEFAULT_BUDGET,
    artifactPath: dir,
    logPath: join(runDir, "run.log"),
    ledgerPath: join(runDir, "run.jsonl"),
    harnessErrors: [],
  };
  writeFileSync(run.logPath, "", "utf8");
  writeFileSync(run.ledgerPath, "", "utf8");

  const record: ScoreRecord = await gate.score(run, suite);
  return verdictFrom(fixture, record, dir, join(resultsDir, "scores", `${runId}.json`));
}

/** The exploit findings live on the CONTAINER result, not on the score record. */
function readExploitFindings(scoreRecordPath: string): readonly ExploitFinding[] {
  const containerPath = scoreRecordPath.replace(/\.json$/, ".container.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(containerPath, "utf8")) as unknown;
  } catch {
    // Absence is reported as absence. Returning [] silently would let the
    // exploit assertion in calibration.test.ts pass for a missing file.
    throw new Error(
      `the container result ${containerPath} could not be read, so exploit findings could not be verified. ` +
        "A calibration that cannot see the exploit findings must fail, not assume there were none.",
    );
  }
  // MEASURED SHAPE, NOT AN ASSUMED ONE. The file is a WRAPPER — `{ integrity,
  // staging, container, image }` — and the container's own result is nested one
  // level down. Reading `exploitFindings` off the root yields `undefined`, which
  // an `Array.isArray` guard turns into `[]`: the exploit assertion in
  // calibration.test.ts would then be asserting over a list that was never read.
  // So the shape is checked and a mismatch throws.
  const container = (parsed as { container?: unknown }).container;
  const findings = (container as { exploitFindings?: unknown } | undefined)?.exploitFindings;
  if (!Array.isArray(findings)) {
    throw new Error(
      `${containerPath} has no container.exploitFindings array. The scorer's result shape changed; ` +
        "calibration must fail rather than report zero exploit findings it never read.",
    );
  }
  return findings as readonly ExploitFinding[];
}

function verdictFrom(
  fixture: CalibrationFixture,
  record: ScoreRecord,
  dir: string,
  scoreRecordPath: string,
): FixtureVerdict {
  const criteriaResults: readonly CriterionResult[] = record.criteriaResults;
  const qualityFindings = qualityFindingsFor(dir);

  const input: VerdictInput = {
    ticket: fixture.ticket,
    criteriaResults,
    qualityFindings,
    assumptions: extractAssumptions(fixture.ticket, criteriaResults.map((result) => ({
      id: result.criterionId,
      tier: result.tier,
      statement: statementFor(result.criterionId),
      evidenceRequired: "",
    }))),
    // ZERO ON PURPOSE, NOT UNMEASURED. `criteriaResults` already carries one
    // entry per held-out criterion — ids and tiers, never titles — so counting
    // the same failures again here would double them and inflate every summary
    // line in the verdict.
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
  };

  const failed = criteriaResults.filter((result) => !result.passed);
  return {
    outcome: computeOutcome(input),
    failingTier: failingTier(input),
    failedGates: failed.filter((result) => result.criterionId.startsWith("GATE:")).map((r) => r.criterionId),
    exploitFindings: readExploitFindings(scoreRecordPath),
    failedCriteria: failed.filter((result) => /^REQ-\d{3}$/.test(result.criterionId)).map((r) => r.criterionId),
    qualityCriteria: failed.filter((result) => result.criterionId.startsWith("QUALITY:")).map((r) => r.criterionId),
    qualityFindings,
    heldOutPass: record.heldOutPass,
    suiteSha256: record.acceptanceSuiteSha256,
    verdictMarkdown: renderVerdict(input),
    scoreRecordPath,
  };
}

/**
 * The owner-facing prose for a criterion id.
 *
 * The score record carries ids and tiers; the statements live in the committed
 * draft. Gate ids and the host's rolled-up `QUALITY:*` ids have no authored
 * statement, so they get their own id back — the verdict then says "GATE:build"
 * rather than dropping the requirement, and `verdict.ts` is explicit that an
 * unmet requirement rendering as nothing is a false pass in a smaller font.
 */
function statementFor(criterionId: string): string {
  const authored = AUTHORED_STATEMENTS.get(criterionId);
  return authored ?? criterionId;
}

/** Built once from the committed draft; ids are stable across all fixtures. */
const AUTHORED_STATEMENTS: ReadonlyMap<string, string> = new Map(
  portfolioDraft({ ticketId: "CAL-STATEMENTS", ticketSha256: sha256Hex("statements"), hasBuildScript: false }).criteria.map(
    (criterion) => [criterion.id, criterion.statement] as const,
  ),
);
