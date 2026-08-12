/**
 * spec-freeze.ts — sealing the suite, and proving it is still sealed.
 *
 * Constraint 1: the acceptance suite "is hashed and frozen. No builder may
 * read, list or modify it." Freezing is the cheap half; VERIFYING is the half
 * that makes the claim true, because ImpossibleBench measured Claude-family
 * models editing test files more than 79% of the time when they could
 * (doc 02 section 5.6).
 *
 * FOUR DEFENCES, IN THE ORDER THEY ACTUALLY STOP SOMETHING:
 *
 *  1. THE SUITE IS NOT IN THE WORKSPACE. The builder is given a copy of the
 *     VISIBLE half and nothing else. It cannot modify what it cannot reach.
 *  2. A CONTENT DIGEST OVER EVERY FILE, checked immediately before scoring
 *     ({@link verifySuiteIntact}). This is what catches an edit.
 *  3. A DIRECTORY LISTING CHECK. A digest set only covers files it knows
 *     about; an ADDED file is invisible to it and can shadow or monkey-patch a
 *     real one. The listing check catches that.
 *  4. FILESYSTEM PERMISSIONS, last and weakest. `chmod 0444` stops an accident;
 *     it does not stop the owner, who can chmod it back. The real enforcement
 *     is the read-only mount in the scorer container. Recorded honestly in
 *     {@link FreezePermissions} rather than presented as a guarantee.
 *
 * A NOTE ON REDACTION, BECAUSE GETTING IT BACKWARDS BREAKS THE FREEZE
 * PERMANENTLY: test file bytes are written RAW and hashed RAW. They are not
 * results, logs or reports, so they are not the redactor's business. Routing
 * them through `redactForPersistence` would rewrite a plausible fixture — a
 * 40-character mixed-case token, a `const apiKey = "..."` line — and the
 * on-disk bytes would then disagree with every digest forever. Instead the
 * suite is CHECKED for credential-shaped content during the audit
 * (spec-validate.ts) and {@link freezeSuite} refuses to seal a manifest that
 * still matches a credential rule.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BAKEOFF_SCHEMA_VERSION, BakeoffError, assertSuiteUsable } from "./contracts.js";
import type { AcceptanceSuite, AuditFinding, HarnessIdentity, TestFileRef } from "./contracts.js";
import { acceptanceSuiteDigest, digestFileSet } from "./hash.js";
import { assertRedacted, redactForPersistence } from "./redact.js";
import {
  AUDIT_FILENAME,
  DEFAULT_ACCEPTANCE_ROOT,
  FROZEN_FILENAME,
  SUITE_ROOT_DIRNAME,
  VISIBILITY_DIRNAME,
  frozenRecordDigest,
  holdoutPlanDigest,
  pathProblems,
} from "./spec-types.js";
import type {
  DraftTestFile,
  FreezePermissions,
  FrozenSuiteRecord,
  HoldoutPlan,
  IntegrityViolation,
  IntegrityWarning,
  SuiteIntegrityReport,
} from "./spec-types.js";

/* -------------------------------------------------------------------------
 * 1. Paths
 * ---------------------------------------------------------------------- */

const TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeTicketId(ticketId: string): void {
  if (!TICKET_ID_PATTERN.test(ticketId)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `ticket id "${ticketId}" is not a safe path segment`,
      "Ticket ids become directory names under acceptance/. Use [A-Za-z0-9][A-Za-z0-9._-]* — no " +
        "separators, no traversal, no whitespace.",
    );
  }
}

/** `<acceptanceRoot>/<ticketId>`. */
export function ticketDirFor(ticketId: string, acceptanceRoot: string = DEFAULT_ACCEPTANCE_ROOT): string {
  assertSafeTicketId(ticketId);
  return join(acceptanceRoot, ticketId);
}

/** `<acceptanceRoot>/<ticketId>/suite` — the root the digests are relative to. */
export function suiteRootFor(ticketId: string, acceptanceRoot: string = DEFAULT_ACCEPTANCE_ROOT): string {
  return join(ticketDirFor(ticketId, acceptanceRoot), SUITE_ROOT_DIRNAME);
}

/** `<acceptanceRoot>/<ticketId>/FROZEN.json`. */
export function frozenManifestFor(
  ticketId: string,
  acceptanceRoot: string = DEFAULT_ACCEPTANCE_ROOT,
): string {
  return join(ticketDirFor(ticketId, acceptanceRoot), FROZEN_FILENAME);
}

/* -------------------------------------------------------------------------
 * 2. Harness identity
 * ---------------------------------------------------------------------- */

function readPackageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version: unknown = (parsed as Record<string, unknown>)["version"];
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Fall through. An unreadable package.json is not a reason to refuse to
    // author a suite; it is a reason to record "unknown" rather than invent.
  }
  return "unknown";
}

function readGitCommit(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  if (result.error !== undefined || result.status !== 0) return "unversioned";
  const commit = `${result.stdout ?? ""}`.trim();
  return /^[0-9a-f]{7,64}$/.test(commit) ? commit : "unversioned";
}

/**
 * Who authored this suite, and with what.
 *
 * Held-constant variable 2 is "one harness, ours, for every configuration"; the
 * identity is recorded on the suite so a result can be audited without this
 * source tree. `commit` is "unversioned" when git is unavailable — stated, not
 * faked.
 */
export function resolveHarnessIdentity(cwd: string = process.cwd()): HarnessIdentity {
  return {
    id: "bakeoff-spec-agent",
    version: readPackageVersion(),
    commit: readGitCommit(cwd),
  };
}

/* -------------------------------------------------------------------------
 * 3. Freezing
 * ---------------------------------------------------------------------- */

/**
 * One discarded or accepted authoring attempt.
 *
 * Structurally satisfied by `AuthoringAttempt` in spec-agent.ts; declared here
 * so spec-freeze does not import from its own caller.
 */
export interface AuthoringTrailEntry {
  readonly attempt: number;
  readonly promptSha256: string;
  readonly parsed: boolean;
  readonly problems: readonly string[];
  readonly findings: readonly AuditFinding[];
  readonly judgeRan: boolean;
  readonly accepted: boolean;
  readonly costUsd: number;
  /**
   * The `max_tokens` this attempt ran at, and whether the free truncation retry
   * fired inside it. Optional because trails frozen before 2026-08-10 do not
   * carry them and a reader must not mistake "not recorded" for "64,000".
   *
   * They are here so the rung reaches disk on the SUCCESS path too: the thrown
   * `suite_not_audited` message carries the same history on the failure path,
   * and between them there is no longer a run whose ceiling can only be
   * recovered by sampling a subprocess environment from outside the product.
   */
  readonly maxOutputTokens?: number;
  readonly truncationRetried?: boolean;
  /**
   * True when this attempt was ABANDONED on the per-call wall-clock bound rather
   * than answered. Optional for the same reason as the two above: trails frozen
   * before 2026-08-10 do not carry it, and a reader must not mistake absent for
   * `false` — "no attempt timed out" and "this build did not record timeouts" are
   * different facts about a run.
   *
   * WHY IT HAD TO BE DECLARED HERE AND WAS NOT. `spec-agent.ts` passes
   * `authoringTrail: authored.attempts`, and because that is a variable rather
   * than a fresh object literal, TypeScript's excess-property check does not run
   * — so the field reached the persisted `AUDIT.json` while being invisible to
   * every reader of this type, `readAuthoringAttempts` (defect-record.ts)
   * included. The defect record for the one failure mode the 2026-08-10 round
   * ADDS therefore could not say that an attempt had been abandoned.
   *
   * Not a digest risk: the trail lives in `AUDIT.json`, outside the hashed
   * manifest, so `suite_hash_mismatch` is not reachable from this field.
   */
  readonly timedOut?: boolean;
  /**
   * How many repair rounds ran inside this attempt, and what they were asked to
   * clear. Optional for the reason above: a trail frozen before 2026-08-12 does
   * not carry them, and absent must read as "not recorded" rather than as "no
   * repair ran" — the two are different facts about a run and only one of them
   * is evidence about the repair loop.
   *
   * DECLARED HERE BECAUSE `authoringTrail: authored.attempts` PASSES A VARIABLE
   * and TypeScript's excess-property check therefore does not fire — the exact
   * mechanism that let `timedOut` reach disk while being invisible to every
   * reader of this type. See {@link AuthoringAttempt.repairedProblems} for why
   * the second field is not decoration: without it a repaired attempt reads on
   * disk as an attempt that never had a defect.
   */
  readonly repairRounds?: number;
  readonly repairedProblems?: readonly string[];
  /**
   * Digest of the repair prompt, when one produced the accepted draft. Null on
   * an attempt that was not repaired; ABSENT on a trail frozen before
   * 2026-08-12, and the two must not be read as the same thing.
   */
  readonly repairPromptSha256?: string | null;
}

export interface FreezeSuiteInput {
  readonly suite: AcceptanceSuite;
  readonly plan: HoldoutPlan;
  /** The authored files, with their exact source bytes. */
  readonly files: readonly DraftTestFile[];
  /** Written alongside the manifest as a human-readable copy. */
  readonly auditFindings?: readonly AuditFinding[];
  /**
   * Every attempt, including the discarded ones.
   *
   * `AcceptanceSuite.authoringPromptSha256` is documented in contracts.ts as
   * being "for reproducibility", but on any suite that took more than one
   * attempt the prompt that produced it contained feedback derived from a
   * DISCARDED attempt's blocking findings. Only the accepted attempt's findings
   * reach FROZEN.json, so without this trail the digest is unreconstructable
   * for exactly the suites where reproducibility matters most. With it, the
   * feedback turn is derivable: it is `blockingFindingSummary` of the previous
   * entry's findings.
   */
  readonly authoringTrail?: readonly AuthoringTrailEntry[];
}

export interface FreezeOptions {
  readonly acceptanceRoot?: string;
  /** Attempt `chmod` read-only. Default true. */
  readonly makeReadOnly?: boolean;
  /**
   * Re-freeze over an existing manifest. Default FALSE.
   *
   * Refusing by default is the point: a second freeze over a suite that runs
   * have already been scored against silently changes what "the frozen suite"
   * means, and held-constant variable 5 stops being held.
   */
  readonly overwrite?: boolean;
  /** ISO-8601 instant. Defaults to now. */
  readonly frozenAt?: string;
}

function tryChmod(target: string, mode: number): string | null {
  try {
    chmodSync(target, mode);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Seal a suite to `acceptance/<ticketId>/`.
 *
 * ORDER IS LOAD-BEARING:
 *   1. refuse an unaudited suite;
 *   2. write the test files;
 *   3. digest them FROM DISK and check the digests match what the suite
 *      records — if the bytes that landed differ from the bytes that were
 *      hashed, the freeze is already broken and must fail here, not silently
 *      at the first scoring run;
 *   4. write FROZEN.json;
 *   5. chmod read-only LAST, deepest first. Locking the directory before
 *      writing the manifest into it would fail.
 */
export function freezeSuite(input: FreezeSuiteInput, options: FreezeOptions = {}): FrozenSuiteRecord {
  const { suite, plan, files } = input;
  const acceptanceRoot = options.acceptanceRoot ?? DEFAULT_ACCEPTANCE_ROOT;
  const frozenAt = options.frozenAt ?? new Date().toISOString();

  // 1. Never seal a suite that failed its adversarial bad-test audit. Without
  //    this the only guard is at run dispatch, so an unaudited suite reaches
  //    FROZEN.json and looks, from disk, exactly like a sealed one.
  assertSuiteUsable(suite);

  if (plan.ticketId !== suite.ticketId) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `hold-out plan is for ticket ${plan.ticketId} but the suite is for ${suite.ticketId}`,
      "Build the plan from the same draft as the suite (planFromDraft in spec-types.ts).",
    );
  }
  if (files.length !== suite.testFiles.length) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${files.length} source files were supplied but the suite records ${suite.testFiles.length}`,
      "The suite manifest and the file set must come from the same draft.",
    );
  }

  const ticketDir = ticketDirFor(suite.ticketId, acceptanceRoot);
  const suiteRoot = suiteRootFor(suite.ticketId, acceptanceRoot);
  const manifestPath = frozenManifestFor(suite.ticketId, acceptanceRoot);

  if (existsSync(manifestPath) && options.overwrite !== true) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `a frozen suite already exists at ${manifestPath}`,
      "Refusing to re-freeze. Held-constant variable 5 is 'the held-out acceptance suite': every " +
        "configuration must build against the SAME suite for the same ticket. If the ticket text " +
        "genuinely changed, freeze under a new ticket id and re-run every configuration against it. " +
        "Pass overwrite: true only when no run has been scored against the existing suite.",
    );
  }

  // 2. Write the sources. Raw bytes, UTF-8, no transformation of any kind.
  mkdirSync(ticketDir, { recursive: true });
  mkdirSync(suiteRoot, { recursive: true });
  for (const dirname_ of Object.values(VISIBILITY_DIRNAME)) {
    mkdirSync(join(suiteRoot, dirname_), { recursive: true });
  }
  for (const file of files) {
    const problems = pathProblems(file.path);
    if (problems.length > 0) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `refusing to write suite file "${file.path}": ${problems.join("; ")}`,
        "Suite paths are filesystem write targets inside a sealed directory. Fix the authoring " +
          "validation before freezing.",
      );
    }
    const target = join(suiteRoot, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.source, "utf8");
  }

  // 3. Digest from disk and confirm the suite manifest already agrees.
  const onDisk = digestFileSet(
    suiteRoot,
    files.map((f) => f.path),
  );
  assertFileSetsMatch(onDisk, suite.testFiles, suite.ticketId);

  const recomputed = acceptanceSuiteDigest({
    ticketId: suite.ticketId,
    ticketSha256: suite.ticketSha256,
    criteria: suite.criteria,
    testFiles: onDisk,
  });
  if (recomputed !== suite.sha256) {
    throw new BakeoffError(
      "suite_hash_mismatch",
      `the suite on disk digests to ${recomputed} but the manifest records ${suite.sha256}`,
      "Do NOT proceed. The bytes that were written are not the bytes that were hashed. Re-author " +
        "the suite rather than patching the digest.",
    );
  }

  const planSha256 = holdoutPlanDigest(plan);
  const record: FrozenSuiteRecord = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    recordVersion: 1,
    suite,
    plan,
    planSha256,
    recordSha256: frozenRecordDigest({
      suiteSha256: suite.sha256,
      planSha256,
      ticketId: suite.ticketId,
      ticketSha256: suite.ticketSha256,
      auditPassed: suite.auditPassed,
      criteriaCount: suite.criteria.length,
      testFileCount: suite.testFiles.length,
    }),
    frozenAt,
    suiteRootRelPath: SUITE_ROOT_DIRNAME,
    permissions: { attempted: false, filesReadOnly: false, directoriesReadOnly: false, problem: null },
  };

  // 4. The manifest is NOT redacted — redacting it would rewrite criterion
  //    statements that `recordSha256` and `suite.sha256` already cover. It is
  //    ASSERTED clean instead: a credential-shaped criterion is a suite defect
  //    that must be fixed at authoring time, not papered over at write time.
  const manifestJson = `${JSON.stringify(record, null, 2)}\n`;
  try {
    assertRedacted(manifestJson);
  } catch {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the freeze manifest for ${suite.ticketId} contains credential-shaped text`,
      "Re-author the suite with obviously-fake fixtures. The manifest cannot be redacted before " +
        "writing: redaction would rewrite criterion statements that the freeze digest already " +
        "covers, and every later integrity check would fail. The offending value is deliberately " +
        "not quoted.",
    );
  }
  writeFileSync(manifestPath, manifestJson, "utf8");

  if (input.auditFindings !== undefined || input.authoringTrail !== undefined) {
    writeFileSync(
      join(ticketDir, AUDIT_FILENAME),
      `${JSON.stringify(
        redactForPersistence({
          ticketId: suite.ticketId,
          acceptanceSuiteSha256: suite.sha256,
          authoringPromptSha256: suite.authoringPromptSha256,
          auditPassed: suite.auditPassed,
          auditedAt: suite.auditedAt,
          findings: input.auditFindings ?? [],
          authoringTrail: input.authoringTrail ?? [],
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  // 5. Read-only last, deepest first.
  const permissions = options.makeReadOnly === false
    ? { attempted: false, filesReadOnly: false, directoriesReadOnly: false, problem: null }
    : applyReadOnly(suiteRoot, manifestPath, files.map((f) => f.path));

  const finalRecord: FrozenSuiteRecord = { ...record, permissions };
  if (permissions.attempted) {
    // Rewriting the manifest with the permissions block requires it to still be
    // writable, so the manifest is chmod'ed after this write, not before.
    writeFileSync(manifestPath, `${JSON.stringify(finalRecord, null, 2)}\n`, "utf8");
    tryChmod(manifestPath, 0o444);
  }
  return finalRecord;
}

function applyReadOnly(
  suiteRoot: string,
  manifestPath: string,
  relPaths: readonly string[],
): FreezePermissions {
  const problems: string[] = [];
  let filesReadOnly = true;
  let directoriesReadOnly = true;

  for (const rel of relPaths) {
    const problem = tryChmod(join(suiteRoot, ...rel.split("/")), 0o444);
    if (problem !== null) {
      filesReadOnly = false;
      problems.push(`${rel}: ${problem}`);
    }
  }
  for (const dirname_ of Object.values(VISIBILITY_DIRNAME)) {
    const problem = tryChmod(join(suiteRoot, dirname_), 0o555);
    if (problem !== null) {
      directoriesReadOnly = false;
      problems.push(`${dirname_}/: ${problem}`);
    }
  }
  const rootProblem = tryChmod(suiteRoot, 0o555);
  if (rootProblem !== null) {
    directoriesReadOnly = false;
    problems.push(`${SUITE_ROOT_DIRNAME}/: ${rootProblem}`);
  }
  // The manifest is chmod'ed by the caller AFTER the permissions block is
  // written into it.
  void manifestPath;

  return {
    attempted: true,
    filesReadOnly,
    directoriesReadOnly,
    problem: problems.length === 0 ? null : redactForPersistence(problems.join("; ")),
  };
}

function assertFileSetsMatch(
  onDisk: readonly TestFileRef[],
  recorded: readonly TestFileRef[],
  ticketId: string,
): void {
  const byPath = new Map(recorded.map((f) => [f.path, f]));
  for (const actual of onDisk) {
    const expected = byPath.get(actual.path);
    if (expected === undefined) {
      throw new BakeoffError(
        "suite_hash_mismatch",
        `suite for ${ticketId}: file "${actual.path}" was written but is not in the manifest`,
        "Build the manifest and the file set from the same draft.",
      );
    }
    if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
      throw new BakeoffError(
        "suite_hash_mismatch",
        `suite for ${ticketId}: "${actual.path}" hashed to ${actual.sha256} (${actual.bytes} bytes) ` +
          `on disk but the manifest records ${expected.sha256} (${expected.bytes} bytes)`,
        "The in-memory digest and the on-disk digest disagree. Do not patch the manifest; find out " +
          "what rewrote the bytes (an editor, a formatter, a line-ending conversion) and stop it.",
      );
    }
    byPath.delete(actual.path);
  }
  const missing = [...byPath.keys()];
  if (missing.length > 0) {
    throw new BakeoffError(
      "suite_hash_mismatch",
      `suite for ${ticketId}: manifest lists ${missing.length} file(s) that were not written: ` +
        missing.join(", "),
      "Build the manifest and the file set from the same draft.",
    );
  }
}

/* -------------------------------------------------------------------------
 * 4. Reading and verifying
 * ---------------------------------------------------------------------- */

/** Read `FROZEN.json`. Throws clean when it is absent or unparseable. */
export function readFrozenSuite(
  ticketId: string,
  acceptanceRoot: string = DEFAULT_ACCEPTANCE_ROOT,
): FrozenSuiteRecord {
  const manifestPath = frozenManifestFor(ticketId, acceptanceRoot);
  if (!existsSync(manifestPath)) {
    throw new BakeoffError(
      "suite_not_audited",
      `no frozen acceptance suite at ${manifestPath}`,
      "Author and freeze the suite before any build run. doc 03 section 7.4: the suite is written " +
        "once per ticket, before any build, from the ticket text alone.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new BakeoffError(
      "suite_hash_mismatch",
      `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "The freeze manifest was corrupted or hand-edited. Do NOT score any run against it.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new BakeoffError(
      "suite_hash_mismatch",
      `${manifestPath} does not contain an object`,
      "The freeze manifest was corrupted or hand-edited. Do NOT score any run against it.",
    );
  }
  return parsed as FrozenSuiteRecord;
}

function listFilesRecursively(root: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        // Symlinks and devices are recorded as "present but not a regular
        // file"; hash.ts refuses to digest them, and an unhashable file inside
        // a frozen suite is exactly the hole the freeze must not have.
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

export interface VerifyOptions {
  readonly acceptanceRoot?: string;
  /** Warn when the suite is still writable. Default true. */
  readonly checkPermissions?: boolean;
}

/**
 * THE CHECK THE SCORER RUNS BEFORE EVERY SCORING RUN.
 *
 * Re-derives every digest from what is actually on disk and compares it to the
 * sealed manifest. Returns a report rather than throwing so a caller can log
 * the full picture; {@link assertSuiteIntact} is the throwing form.
 *
 * A violation here is never a model result. It means the sealed suite changed
 * after it was sealed, and the correct response is to stop and investigate, not
 * to score the run either way.
 */
export function verifySuiteIntact(
  ticketId: string,
  options: VerifyOptions = {},
): SuiteIntegrityReport {
  const acceptanceRoot = options.acceptanceRoot ?? DEFAULT_ACCEPTANCE_ROOT;
  const suiteDir = suiteRootFor(ticketId, acceptanceRoot);
  const checkedAt = new Date().toISOString();
  const violations: IntegrityViolation[] = [];
  const warnings: IntegrityWarning[] = [];

  let record: FrozenSuiteRecord;
  try {
    record = readFrozenSuite(ticketId, acceptanceRoot);
  } catch (error) {
    return {
      ticketId,
      suiteDir,
      intact: false,
      acceptanceSuiteSha256: null,
      violations: [
        {
          kind: error instanceof BakeoffError && error.code === "suite_not_audited"
            ? "missing_manifest"
            : "unreadable_manifest",
          path: null,
          detail: redactForPersistence(error instanceof Error ? error.message : String(error)),
        },
      ],
      warnings,
      checkedAt,
    };
  }

  const { suite, plan } = record;

  // Self-consistency of the manifest itself.
  const planSha256 = holdoutPlanDigest(plan);
  if (planSha256 !== record.planSha256) {
    violations.push({
      kind: "plan_digest_mismatch",
      path: null,
      detail:
        `hold-out plan digests to ${planSha256} but the manifest records ${record.planSha256}. ` +
        "The split, the runner assignment or a criterion-to-test binding was edited after the freeze.",
    });
  }
  const recordSha256 = frozenRecordDigest({
    suiteSha256: suite.sha256,
    planSha256: record.planSha256,
    ticketId: suite.ticketId,
    ticketSha256: suite.ticketSha256,
    auditPassed: suite.auditPassed,
    criteriaCount: suite.criteria.length,
    testFileCount: suite.testFiles.length,
  });
  if (recordSha256 !== record.recordSha256) {
    violations.push({
      kind: "record_digest_mismatch",
      path: null,
      detail: `freeze record digests to ${recordSha256} but records ${record.recordSha256}`,
    });
  }

  // The audit verdict must still hold.
  try {
    assertSuiteUsable(suite);
  } catch (error) {
    violations.push({
      kind: "audit_not_passed",
      path: null,
      detail: redactForPersistence(error instanceof Error ? error.message : String(error)),
    });
  }

  // Plan and suite must describe the same files.
  const manifestPaths = new Set(suite.testFiles.map((f) => f.path));
  const planPaths = new Set(plan.files.map((f) => f.path));
  for (const path of planPaths) {
    if (!manifestPaths.has(path)) {
      violations.push({
        kind: "plan_suite_disagreement",
        path,
        detail: "the hold-out plan lists a file the frozen suite does not",
      });
    }
  }
  for (const path of manifestPaths) {
    if (!planPaths.has(path)) {
      violations.push({
        kind: "plan_suite_disagreement",
        path,
        detail: "the frozen suite lists a file the hold-out plan does not",
      });
    }
  }

  // Content digests, from disk.
  if (!existsSync(suiteDir)) {
    violations.push({
      kind: "file_missing",
      path: null,
      detail: `the suite directory ${suiteDir} does not exist`,
    });
    return {
      ticketId,
      suiteDir,
      intact: false,
      acceptanceSuiteSha256: suite.sha256,
      violations,
      warnings,
      checkedAt,
    };
  }

  const present = new Set(listFilesRecursively(suiteDir));
  for (const expected of suite.testFiles) {
    if (!present.has(expected.path)) {
      violations.push({ kind: "file_missing", path: expected.path, detail: "frozen file is absent from disk" });
      continue;
    }
    present.delete(expected.path);
    try {
      const [actual] = digestFileSet(suiteDir, [expected.path]);
      if (actual === undefined) {
        violations.push({ kind: "file_missing", path: expected.path, detail: "file could not be digested" });
      } else if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        violations.push({
          kind: "file_digest_mismatch",
          path: expected.path,
          detail:
            `on disk ${actual.sha256} (${actual.bytes} bytes), frozen ${expected.sha256} ` +
            `(${expected.bytes} bytes)`,
        });
      }
    } catch (error) {
      violations.push({
        kind: "file_digest_mismatch",
        path: expected.path,
        detail: redactForPersistence(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  for (const extra of present) {
    // A digest set only covers files it knows about. An ADDED file — a
    // conftest-style hook, a shadowing module, a second copy under a different
    // name — is invisible to the digests and can change what the runner
    // executes. It is a violation, not a warning.
    violations.push({
      kind: "file_added",
      path: extra,
      detail:
        "a file exists inside the sealed suite that the freeze manifest does not list. Any added " +
        "file can shadow or monkey-patch a frozen one without changing a single frozen digest.",
    });
  }

  // The frozen suite digest itself.
  try {
    const recomputed = acceptanceSuiteDigest({
      ticketId: suite.ticketId,
      ticketSha256: suite.ticketSha256,
      criteria: suite.criteria,
      testFiles: suite.testFiles,
    });
    if (recomputed !== suite.sha256) {
      violations.push({
        kind: "suite_digest_mismatch",
        path: null,
        detail: `recomputed ${recomputed}, manifest records ${suite.sha256}`,
      });
    }
  } catch (error) {
    violations.push({
      kind: "suite_digest_mismatch",
      path: null,
      detail: redactForPersistence(error instanceof Error ? error.message : String(error)),
    });
  }

  if (options.checkPermissions ?? true) {
    if (record.permissions.attempted && !record.permissions.filesReadOnly) {
      warnings.push({
        detail:
          "the suite files were not made read-only at freeze time. chmod is the weakest of the four " +
          "defences and its absence is not itself a breach — but mount the suite read-only in the " +
          "scorer container, which is the defence that actually holds.",
      });
    }
    if (!record.permissions.attempted) {
      warnings.push({ detail: "read-only permissions were never attempted for this suite" });
    }
  }

  return {
    ticketId,
    suiteDir,
    intact: violations.length === 0,
    acceptanceSuiteSha256: suite.sha256,
    violations,
    warnings,
    checkedAt,
  };
}

/** Throwing form of {@link verifySuiteIntact}. Call before scoring. */
export function assertSuiteIntact(ticketId: string, options: VerifyOptions = {}): FrozenSuiteRecord {
  const report = verifySuiteIntact(ticketId, options);
  if (!report.intact) {
    const lines = report.violations.map(
      (v) => `  - [${v.kind}]${v.path === null ? "" : ` ${v.path}:`} ${v.detail}`,
    );
    throw new BakeoffError(
      "suite_hash_mismatch",
      `the sealed acceptance suite for ticket ${ticketId} is not intact:\n${lines.join("\n")}`,
      "Do NOT score this run in either direction. The frozen suite changed after it was sealed. " +
        "ImpossibleBench measured Claude-family models editing test files more than 79% of the time " +
        "when they could; a builder with any path to the suite is the failure mode this gate exists " +
        "to prevent. Re-freeze from the manifest's source of truth and re-run the affected runs.",
    );
  }
  return readFrozenSuite(ticketId, options.acceptanceRoot ?? DEFAULT_ACCEPTANCE_ROOT);
}

/* -------------------------------------------------------------------------
 * 5. Handing the visible half to the builder
 * ---------------------------------------------------------------------- */

export interface MaterialiseOptions {
  readonly acceptanceRoot?: string;
  /** Subdirectory created inside the workspace. Default `tests`. */
  readonly workspaceSubdir?: string;
}

/**
 * Copy the VISIBLE half into a builder workspace.
 *
 * This is the only part of the suite a builder is ever given, and it is a COPY.
 * The builder may run it, edit it, or delete it: scoring re-executes the FROZEN
 * originals in the clean container, so nothing done to this copy moves a
 * number. That is exactly why the visible half can be handed over at all — the
 * builder gets a real feedback signal, and the visible-vs-held-out gap stays
 * measurable because both halves are scored from the sealed copies.
 *
 * Refuses to write inside the acceptance root: the acceptance tree is a
 * forbidden path for every builder (config.ts BUILDER_FORBIDDEN_PATH_PREFIXES),
 * and a workspace nested inside it would hand over the whole sealed suite.
 */
export function materialiseVisibleSubset(
  ticketId: string,
  workspaceDir: string,
  options: MaterialiseOptions = {},
): readonly string[] {
  const acceptanceRoot = options.acceptanceRoot ?? DEFAULT_ACCEPTANCE_ROOT;
  const record = assertSuiteIntact(ticketId, { acceptanceRoot });
  const suiteRoot = suiteRootFor(ticketId, acceptanceRoot);

  const absWorkspace = resolve(workspaceDir);
  const absAcceptance = resolve(acceptanceRoot);
  const rel = relative(absAcceptance, absWorkspace);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `refusing to materialise the visible suite into ${absWorkspace}: it is inside the acceptance root ${absAcceptance}`,
      "The builder workspace must live outside acceptance/. Everything under acceptance/ is a " +
        "forbidden path for every builder; a workspace nested inside it hands over the sealed suite.",
    );
  }

  const targetDir = join(absWorkspace, options.workspaceSubdir ?? "tests");
  mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];
  for (const file of record.plan.files) {
    if (file.visibility !== "visible") continue;
    const source = readFileSync(join(suiteRoot, ...file.path.split("/")), "utf8");
    if (/\bholdout\s*\//.test(source)) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `visible file "${file.path}" references a "holdout/" path and will not be handed to a builder`,
        "The audit should have caught this before the freeze. Re-author the suite: a visible test " +
          "that names the held-out half leaks the sealed suite into the builder's workspace.",
      );
    }
    // Flattened: the builder never learns that a `visible/` directory exists,
    // and therefore never learns that a sibling `holdout/` might.
    const basename = file.path.split("/").slice(1).join("_");
    const target = join(targetDir, basename);
    writeFileSync(target, source, "utf8");
    // Deliberately writable. This copy is the builder's to use.
    written.push(target);
  }
  return written;
}
