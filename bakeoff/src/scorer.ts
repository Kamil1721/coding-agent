/**
 * scorer.ts — THE SEALED GATE. Host side.
 *
 * doc 03 section 7.4 is the whole reason this module exists, and its integrity
 * IS the experiment: if the gate can be influenced by the builder, every number
 * the bake-off produces is a measurement of persuasion rather than of work.
 *
 * WHAT THIS MODULE DOES, IN ORDER:
 *
 *  0. {@link verifySuiteIntact} FIRST. The frozen suite on disk is re-hashed and
 *     compared to its freeze digest. Any change is TAMPERING: the run hard-fails,
 *     a tamper report is written, and it is NOT retried. ImpossibleBench measured
 *     Claude-family models editing test files more than 79% of the time when they
 *     could (doc 02 section 5.6); a suite whose bytes moved is not a suite whose
 *     result means anything, and retrying would simply re-run against the
 *     tampered yardstick.
 *
 *  1. Cross-checks that this run and this suite are about the same ticket and
 *     the same freeze, so a mis-wired campaign cannot score run A against
 *     suite B and report it as a pass.
 *
 *  2. Staging. The artefact is COPIED, never mounted in place, with `.git`, the
 *     harness's own `.bakeoff` directory, the builder's log, ledger and
 *     self-report, and every forbidden path stripped. doc 03 constraint 1: the
 *     gate executes with no access to the build workspace history, the builder
 *     logs or any conversation transcript.
 *
 *  3. A sealed plan. {@link assertPlanIsSealed} refuses to write a plan carrying
 *     the self-report, the configuration id, or any seat/model/effort/cost.
 *
 *  4. `docker run --network=none`, from an image pinned by digest, with the
 *     digest re-resolved and compared before every run so a rebuilt image cannot
 *     silently change what "the same gate" means mid-campaign.
 *
 *  5. A {@link ScoreRecord}: `heldOutPass` via `computeHeldOutPass` and
 *     `falseFinish` via `deriveFalseFinish`, both from contracts.ts, neither
 *     reimplemented here. The builder's self-report enters at exactly one point
 *     — as the first argument to `deriveFalseFinish` — and scores nothing.
 *
 * doc 02 = docs/research/02-credentials-verification-judge.md
 * doc 03 = docs/research/03-model-decision-final.md
 *
 * CITATION NOTE. The task specification refers to "doc 02 gate G0" for the
 * tamper check. No section labelled G0 exists in doc 02; its Tier-0 material is
 * section 5.3 ("any diff touching a protected test path = instant fail") and
 * section 5.6 (tests read-only via filesystem permissions AND a diff gate,
 * because "a prompt instruction is not sufficient"). Those are cited instead,
 * together with `assertSuiteDigestMatches` in hash.ts, which is the frozen
 * scaffold's own statement of the same rule.
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BAKEOFF_SCHEMA_VERSION,
  BakeoffError,
  assertSuiteUsable,
  computeHeldOutPass,
  deriveFalseFinish,
} from "./contracts.js";
import type {
  AcceptanceGate,
  AcceptanceSuite,
  CriterionResult,
  RunRecord,
  ScoreRecord,
  SuiteExecution,
  TestFileRef,
} from "./contracts.js";
import { BUILDER_FORBIDDEN_PATH_PREFIXES } from "./config.js";
import { acceptanceSuiteDigest, sha256Hex } from "./hash.js";
import { redactForPersistence, redactText } from "./redact.js";
import { suiteRootFor } from "./spec-freeze.js";
import { VISIBILITY_DIRNAME, assertSuiteManifestPathAgrees } from "./spec-types.js";
import {
  CONTAINER_PATHS,
  DEFAULT_BREAKPOINTS,
  DEFAULT_MASK_COLOR,
  DEFAULT_MASK_SELECTORS,
  DEFAULT_SCORER_LIMITS,
  GATE_ID_PREFIX,
  GATE_IDS,
  MIN_SCREENSHOT_BYTES,
  SCORER_PROTOCOL_VERSION,
  SUITE_MANIFEST_FILENAME,
  assertPlanIsSealed,
  parseContainerResult,
  parseScorerPlan,
} from "./scorer-protocol.js";
import type {
  Breakpoint,
  ContainerResult,
  ScorerLimits,
  ScorerPlan,
  Tier0GateResult,
} from "./scorer-protocol.js";
import {
  SCORER_RUNTIME_SMOKE_ARG,
  parseScorerRuntimeSmoke,
} from "./scorer-runtime.js";
import type { ScorerRuntimeSmokePayload } from "./scorer-runtime.js";

/* -------------------------------------------------------------------------
 * 0. Non-retryable failures
 * ---------------------------------------------------------------------- */

/**
 * Error codes that must NEVER be retried.
 *
 * `suite_hash_mismatch` means the frozen yardstick moved. A retry re-measures
 * against the tampered suite and launders the tampering into a normal-looking
 * result, which is strictly worse than no result at all.
 */
export const NON_RETRYABLE_ERROR_CODES: readonly string[] = Object.freeze([
  "suite_hash_mismatch",
  "suite_not_audited",
]);

/** True when an error means "stop, investigate" rather than "try again". */
export function isNonRetryable(error: unknown): boolean {
  return error instanceof BakeoffError && NON_RETRYABLE_ERROR_CODES.includes(error.code);
}

/* -------------------------------------------------------------------------
 * 1. Suite integrity — the tamper check
 * ---------------------------------------------------------------------- */

export interface ChangedSuiteFile {
  readonly path: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
}

/**
 * The result of re-hashing the frozen suite on disk.
 *
 * `intact` is true only when every recorded file is present with its recorded
 * digest, no unrecorded file has appeared in the suite directory, and the
 * recomputed freeze digest equals `suite.sha256`.
 *
 * An UNRECORDED FILE IS TAMPERING even though it cannot change the freeze digest
 * (which covers only recorded files): a planted `conftest.py`, `playwright.config.ts`
 * or `.mocharc` sitting beside the frozen tests is exactly the reporter-tampering
 * exploit doc 02 section 5.6 documents, and it would otherwise pass unnoticed.
 */
export interface SuiteIntegrityReport {
  readonly intact: boolean;
  readonly ticketId: string;
  readonly suiteDir: string;
  readonly expectedSha256: string;
  /** Recomputed from the files actually on disk. */
  readonly actualSha256: string;
  /** Recomputed from the RECORDED file digests: isolates criteria mutation. */
  readonly recordedDigestRecomputed: string;
  readonly changedFiles: readonly ChangedSuiteFile[];
  readonly missingFiles: readonly string[];
  readonly unexpectedFiles: readonly string[];
  readonly skippedSymlinks: readonly string[];
  readonly checkedAt: string;
  /** Empty when intact. One line per distinct integrity problem. */
  readonly problems: readonly string[];
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/** List regular files under a directory, POSIX-relative, following no symlinks. */
function listRegularFiles(rootDir: string): { files: readonly string[]; symlinks: readonly string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      const rel = toPosix(relative(rootDir, abs));
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  };
  visit(rootDir);
  return { files: files.sort(), symlinks: symlinks.sort() };
}

/**
 * VERIFY THE FROZEN SUITE FIRST. Nothing else in this module runs before it.
 *
 * Pure: reads the suite directory and returns a report. The decision to abort
 * belongs to the caller, so that the report can be written to disk as evidence
 * BEFORE the error is thrown — "hard-fail and flag it" is two actions, and a
 * throw that happens first loses the flag.
 */
export function verifySuiteIntact(suite: AcceptanceSuite, suiteDir: string): SuiteIntegrityReport {
  const checkedAt = new Date().toISOString();
  const problems: string[] = [];

  if (!existsSync(suiteDir)) {
    return {
      intact: false,
      ticketId: suite.ticketId,
      suiteDir,
      expectedSha256: suite.sha256,
      actualSha256: "",
      recordedDigestRecomputed: "",
      changedFiles: [],
      missingFiles: suite.testFiles.map((f) => f.path),
      unexpectedFiles: [],
      skippedSymlinks: [],
      checkedAt,
      problems: [`the sealed suite directory ${suiteDir} does not exist`],
    };
  }

  const onDisk = listRegularFiles(suiteDir);
  const recorded = new Map(suite.testFiles.map((f) => [f.path, f]));
  const seen = new Set<string>();

  const changedFiles: ChangedSuiteFile[] = [];
  const unexpectedFiles: string[] = [];
  const actualFileRefs: TestFileRef[] = [];

  for (const relPath of onDisk.files) {
    const expected = recorded.get(relPath);
    const bytes = readFileSync(join(suiteDir, ...relPath.split(posix.sep)));
    const digest = sha256Hex(bytes);
    actualFileRefs.push({ path: relPath, sha256: digest, bytes: bytes.byteLength });
    if (expected === undefined) {
      unexpectedFiles.push(relPath);
      continue;
    }
    seen.add(relPath);
    if (expected.sha256 !== digest) {
      changedFiles.push({ path: relPath, expectedSha256: expected.sha256, actualSha256: digest });
    }
  }

  const missingFiles = suite.testFiles.map((f) => f.path).filter((p) => !seen.has(p));

  const actualSha256 = acceptanceSuiteDigest({
    ticketId: suite.ticketId,
    ticketSha256: suite.ticketSha256,
    criteria: suite.criteria,
    testFiles: actualFileRefs,
  });
  const recordedDigestRecomputed = acceptanceSuiteDigest({
    ticketId: suite.ticketId,
    ticketSha256: suite.ticketSha256,
    criteria: suite.criteria,
    testFiles: suite.testFiles,
  });

  if (changedFiles.length > 0) {
    problems.push(`${changedFiles.length} frozen test file(s) changed content: ${changedFiles.map((c) => c.path).join(", ")}`);
  }
  if (missingFiles.length > 0) {
    problems.push(`${missingFiles.length} frozen test file(s) missing: ${missingFiles.join(", ")}`);
  }
  if (unexpectedFiles.length > 0) {
    problems.push(
      `${unexpectedFiles.length} file(s) present in the sealed suite directory but not in the freeze: ` +
        `${unexpectedFiles.join(", ")}. A planted runner config or conftest beside the frozen tests is the ` +
        "reporter-tampering exploit doc 02 section 5.6 documents.",
    );
  }
  if (onDisk.symlinks.length > 0) {
    problems.push(
      `${onDisk.symlinks.length} symlink(s) inside the sealed suite directory: ${onDisk.symlinks.join(", ")}. ` +
        "A symlink has a stable recorded path and unstable content and can never be frozen.",
    );
  }
  if (recordedDigestRecomputed !== suite.sha256) {
    problems.push(
      "the suite's own recorded fields no longer hash to its freeze digest — the criteria list or a " +
        "recorded file digest was edited after sealing",
    );
  }
  if (actualSha256 !== suite.sha256) {
    problems.push(`recomputed freeze digest ${actualSha256} does not equal the recorded ${suite.sha256}`);
  }
  // The authoring side allowlists this exact path so a manifest can legally
  // exist in a suite at all. If the two spellings ever drift, every suite the
  // spec seat writes becomes unscorable — silently, and only at scoring time.
  assertSuiteManifestPathAgrees(SUITE_MANIFEST_FILENAME);
  if (!suite.testFiles.some((f) => f.path === SUITE_MANIFEST_FILENAME)) {
    problems.push(
      `the freeze does not contain ${SUITE_MANIFEST_FILENAME}. The scorer refuses to infer build, boot, ` +
        "flow or data expectations from the artefact, because those inputs would then be builder-controlled.",
    );
  }

  return {
    intact: problems.length === 0,
    ticketId: suite.ticketId,
    suiteDir,
    expectedSha256: suite.sha256,
    actualSha256,
    recordedDigestRecomputed,
    changedFiles,
    missingFiles,
    unexpectedFiles,
    skippedSymlinks: onDisk.symlinks,
    checkedAt,
    problems,
  };
}

/* -------------------------------------------------------------------------
 * 2. Staging the artefact
 * ---------------------------------------------------------------------- */

/**
 * Directory names never copied into the scoring container.
 *
 * `.git` is first for a specific reason: doc 03 section 8.1 records that 63% of
 * successful SWE-bench Pro resolutions RETRIEVED the fix rather than derived it,
 * 9% of them by mining git history. The gate must not carry a history into a
 * container whose whole purpose is to be uninformed.
 */
export const STAGING_EXCLUDED_DIRS: readonly string[] = Object.freeze([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  ".bakeoff",
]);

export interface StagingReport {
  readonly stagedDir: string;
  readonly filesCopied: number;
  readonly bytesCopied: number;
  /**
   * Paths whose presence is an instant fail (doc 02 section 5.3): a file under a
   * forbidden prefix, or a byte-identical copy of a frozen suite file anywhere in
   * the artefact.
   */
  readonly protectedPathViolations: readonly string[];
  /** Sample of excluded paths, for the record. Capped. */
  readonly excludedSample: readonly string[];
  readonly skippedSymlinks: readonly string[];
}

function isUnderPrefix(relPosixPath: string, prefix: string): boolean {
  const normalised = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return relPosixPath === prefix.replace(/\/$/, "") || relPosixPath.startsWith(normalised);
}

export interface StageArtifactOptions {
  readonly artifactDir: string;
  readonly stagedDir: string;
  /** Absolute paths that must not be copied even if they sit inside the artefact. */
  readonly excludeAbsolutePaths: readonly string[];
  /** Content digests of the frozen suite files, for copy detection. */
  readonly suiteFileDigests: ReadonlyMap<string, string>;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

/**
 * Copy the build artefact into a clean staging directory.
 *
 * COPIED, NOT MOUNTED IN PLACE. The container builds and boots the artefact; if
 * it wrote into the run's own artefact directory, the recorded artefact would no
 * longer be the thing the builder produced and the run would stop being
 * reproducible.
 *
 * Content-digest copy detection catches what a prefix check cannot: a builder
 * that copied the sealed suite to `src/__tests__/` keeps the bytes and changes
 * only the path, and a path-prefix rule would wave it through.
 */
export function stageArtifact(options: StageArtifactOptions): StagingReport {
  const { artifactDir, stagedDir, suiteFileDigests, maxFiles, maxBytes } = options;

  if (!existsSync(artifactDir) || !statSync(artifactDir).isDirectory()) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the run's artifactPath ${artifactDir} is not a directory`,
      "Point the gate at the directory the runner recorded in RunRecord.artifactPath.",
    );
  }

  const artifactRoot = realpathSync(artifactDir);
  const excluded = new Set(
    options.excludeAbsolutePaths.filter((p) => p.length > 0).map((p) => resolve(p)),
  );

  const protectedPathViolations: string[] = [];
  const excludedSample: string[] = [];
  const skippedSymlinks: string[] = [];
  let filesCopied = 0;
  let bytesCopied = 0;

  const noteExcluded = (rel: string): void => {
    if (excludedSample.length < 200) excludedSample.push(rel);
  };

  mkdirSync(stagedDir, { recursive: true });

  // FORBIDDEN PREFIXES ARE CHECKED UP FRONT, NOT DURING THE WALK.
  //
  // Checking them only inside visit() makes every NESTED prefix unreachable:
  // `.bakeoff` is on STAGING_EXCLUDED_DIRS, so the walk skips it without
  // recursing, and `.bakeoff/suite/` — the path a builder probing for the
  // sealed suite would actually touch — is therefore never tested. Two of the
  // three entries in BUILDER_FORBIDDEN_PATH_PREFIXES were silently unreachable
  // that way. An existence check on each prefix is order-independent and cannot
  // be defeated by the exclusion list growing.
  for (const prefix of BUILDER_FORBIDDEN_PATH_PREFIXES) {
    const trimmed = prefix.replace(/\/$/, "");
    if (existsSync(join(artifactRoot, ...trimmed.split("/")))) {
      protectedPathViolations.push(
        `${trimmed} — the artefact contains the forbidden path "${prefix}". Tests and the sealed suite are ` +
          "read-only via filesystem permissions AND a diff gate; a prompt instruction is not sufficient " +
          "(doc 02 section 5.6).",
      );
    }
  }

  const visit = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;

      if (excluded.has(resolve(abs))) {
        noteExcluded(rel);
        continue;
      }

      // Second line of defence: never COPY anything under a forbidden prefix,
      // whatever the up-front check found. The violation is already recorded
      // above; this only keeps the bytes out of the container.
      if (BUILDER_FORBIDDEN_PATH_PREFIXES.some((prefix) => isUnderPrefix(rel, prefix))) {
        noteExcluded(rel);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = realpathSync(abs);
        } catch {
          target = null;
        }
        if (target !== null && !target.startsWith(artifactRoot + sep) && target !== artifactRoot) {
          protectedPathViolations.push(
            `${rel} — symlink escaping the artefact root. A link out of the workspace is a read the seal ` +
              "is supposed to prevent.",
          );
        }
        skippedSymlinks.push(rel);
        continue;
      }

      if (entry.isDirectory()) {
        if (STAGING_EXCLUDED_DIRS.includes(entry.name)) {
          noteExcluded(rel);
          continue;
        }
        mkdirSync(join(stagedDir, rel), { recursive: true });
        visit(abs, rel);
        continue;
      }

      if (!entry.isFile()) continue;

      const size = statSync(abs).size;
      if (filesCopied + 1 > maxFiles || bytesCopied + size > maxBytes) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `staging ${artifactDir} exceeded the limits (${maxFiles} files / ${maxBytes} bytes) at ${rel}`,
          "Raise maxStagedFiles / maxStagedBytes if the artefact is genuinely this large, or investigate " +
            "why the build wrote this much. A ceiling that silently truncated the copy would score a " +
            "partial artefact as if it were whole.",
        );
      }

      // Suite-copy detection: only outside dependency trees, where a copied
      // frozen test could actually be collected by a runner.
      if (!rel.includes("node_modules/") && size < 4_000_000) {
        const digest = sha256Hex(readFileSync(abs));
        const matched = suiteFileDigests.get(digest);
        if (matched !== undefined) {
          protectedPathViolations.push(
            `${rel} — byte-identical copy of frozen suite file "${matched}". Copying the sealed suite into ` +
              "the workspace is the same violation as editing it: ImpossibleBench measured Claude-family " +
              "models editing test files more than 79% of the time when they could.",
          );
        }
      }

      copyFileSync(abs, join(stagedDir, rel));
      filesCopied += 1;
      bytesCopied += size;
    }
  };

  visit(artifactRoot, "");

  return {
    stagedDir,
    filesCopied,
    bytesCopied,
    protectedPathViolations,
    excludedSample,
    skippedSymlinks,
  };
}

/* -------------------------------------------------------------------------
 * 3. The container invocation
 * ---------------------------------------------------------------------- */

export interface ScorerContainerSpec {
  /** Image reference. Pin it by digest: `name@sha256:...`. */
  readonly imageRef: string;
  /** e.g. "linux/arm64". Null uses the host platform. Must not vary in a campaign. */
  readonly platform: string | null;
  readonly memory: string;
  readonly cpus: string;
  /** Chromium crashes on the 64 MB default /dev/shm. */
  readonly shmSize: string;
  readonly pidsLimit: number;
  readonly tmpfsSize: string;
  /** e.g. "1000:1000" so bind-mount writes land with the operator's ownership. */
  readonly user: string | null;
  readonly dockerBin: string;
}

export const DEFAULT_SCORER_CONTAINER: ScorerContainerSpec = Object.freeze({
  imageRef: "bakeoff-scorer:1",
  platform: null,
  memory: "6g",
  cpus: "2",
  shmSize: "1g",
  pidsLimit: 1024,
  tmpfsSize: "4g",
  user: null,
  dockerBin: "docker",
});

export interface ScorerMounts {
  readonly stagedArtifactDir: string;
  readonly suiteDir: string;
  readonly planFile: string;
  readonly outDir: string;
  readonly screenshotDir: string;
}

function sealedDockerRunPrefix(spec: ScorerContainerSpec, containerName: string): string[] {
  return [
    "run",
    "--rm",
    "--name",
    containerName,

    // ---- THE LOAD-BEARING FLAG -------------------------------------------
    "--network=none",

    // ---- least privilege --------------------------------------------------
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    `--pids-limit=${String(spec.pidsLimit)}`,
    `--memory=${spec.memory}`,
    `--cpus=${spec.cpus}`,
    `--shm-size=${spec.shmSize}`,
    `--tmpfs=/tmp:rw,nosuid,nodev,exec,size=${spec.tmpfsSize}`,

    // ---- environment: explicit, complete, credential-free -----------------
    "--env=HOME=/tmp",
    "--env=XDG_CACHE_HOME=/tmp/.cache",
    "--env=npm_config_cache=/tmp/.npm",
    "--env=CI=1",
    "--env=BAKEOFF_SCORER_SEALED=1",
    "--env=PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "--env=PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    `--env=PLAYWRIGHT_JSON_OUTPUT_NAME=${CONTAINER_PATHS.suiteReport}`,

    "--workdir=/opt/bakeoff-scorer",
    ...(spec.platform === null ? [] : [`--platform=${spec.platform}`]),
    ...(spec.user === null ? [] : [`--user=${spec.user}`]),
  ];
}

/**
 * Build the exact `docker run` argument vector.
 *
 * Exported so that the invocation can be asserted in a test and printed in
 * docker/README.md without the two drifting apart.
 */
export function buildDockerArgs(
  spec: ScorerContainerSpec,
  mounts: ScorerMounts,
  containerName: string,
): readonly string[] {
  assertMountablePaths(mounts);
  const args = sealedDockerRunPrefix(spec, containerName);

  args.push(
    `--mount=type=bind,source=${mounts.stagedArtifactDir},target=${CONTAINER_PATHS.artifact}`,
    `--mount=type=bind,source=${mounts.suiteDir},target=${CONTAINER_PATHS.suite},readonly`,
    `--mount=type=bind,source=${mounts.planFile},target=${CONTAINER_PATHS.plan},readonly`,
    `--mount=type=bind,source=${mounts.outDir},target=${CONTAINER_PATHS.out}`,
    `--mount=type=bind,source=${mounts.screenshotDir},target=${CONTAINER_PATHS.screenshots}`,
    spec.imageRef,
  );

  return args;
}

/**
 * Build the no-mount runtime readiness invocation.
 *
 * `imageDigest` is the daemon-resolved content identity, never the configured
 * tag. Therefore the bytes inspected and the bytes executed are the same even
 * if a mutable tag moves between the two Docker CLI calls.
 */
export function buildScorerRuntimeProbeArgs(
  spec: ScorerContainerSpec,
  imageDigest: string,
  containerName: string,
): readonly string[] {
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `cannot probe scorer image identity ${JSON.stringify(imageDigest)} because it is not a sha256 digest`,
      "Resolve the configured scorer image with resolveImageIdentity() before building the runtime probe.",
    );
  }
  return [...sealedDockerRunPrefix(spec, containerName), imageDigest, SCORER_RUNTIME_SMOKE_ARG];
}

const CREDENTIAL_ENV_NAME_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|BEARER)/i;

/** Options emitted by sealedDockerRunPrefix whose value is the following token. */
const GENERATED_DOCKER_RUN_OPTIONS_WITH_VALUE = new Set(["--name", "--security-opt"]);

/** Locate Docker's image operand in the generated `docker run` argument shape. */
function dockerRunImageIndex(args: readonly string[]): number | undefined {
  if (args[0] !== "run") return undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg === "--") return index + 1 < args.length ? index + 1 : undefined;
    if (!arg.startsWith("-")) return index;
    if (GENERATED_DOCKER_RUN_OPTIONS_WITH_VALUE.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) return undefined;
      index += 1;
    }
  }
  return undefined;
}

/**
 * Refuse to dispatch an invocation that is not sealed.
 *
 * Three classes of defect, all of which have silently degraded a "sealed"
 * environment in practice: a missing or overridden network flag, an env-file or
 * bare `-e NAME` forwarding a host credential, and a privilege escalation flag
 * that reopens what --cap-drop closed.
 */
export function assertSealedInvocation(
  args: readonly string[],
  expectedImageRef: string,
  expectedContainerArgs: readonly string[] = [],
): void {
  const problems: string[] = [];

  const imageIndex = dockerRunImageIndex(args);
  const imageIndexes = args.flatMap((arg, index) => arg === expectedImageRef ? [index] : []);
  if (imageIndexes.length !== 1) {
    problems.push(
      `the invocation must contain expected image ${JSON.stringify(expectedImageRef)} exactly once; ` +
        `found ${String(imageIndexes.length)} occurrences`,
    );
  }
  if (imageIndex === undefined) {
    problems.push("the invocation contains no positional Docker image operand");
  } else if (args[imageIndex] !== expectedImageRef) {
    problems.push(
      `the first positional Docker image operand is ${JSON.stringify(args[imageIndex])}, not ` +
        `${JSON.stringify(expectedImageRef)}`,
    );
  }
  const dockerArgs = imageIndex === undefined ? [] : args.slice(0, imageIndex);
  const containerArgs = imageIndex === undefined ? [] : args.slice(imageIndex + 1);
  if (
    containerArgs.length !== expectedContainerArgs.length ||
    containerArgs.some((arg, index) => arg !== expectedContainerArgs[index])
  ) {
    problems.push(
      `unexpected arguments after the image boundary: expected ${JSON.stringify(expectedContainerArgs)}, ` +
        `received ${JSON.stringify(containerArgs)}`,
    );
  }

  // Docker stops parsing run options at the image operand. Inspecting the full
  // vector would let a required flag placed after the image masquerade as a
  // runtime restriction even though it is only an argument to the container.
  const networkFlags = dockerArgs.filter((a) => a === "--network" || a.startsWith("--network=") || a === "--net" || a.startsWith("--net="));
  if (!dockerArgs.includes("--network=none")) {
    problems.push('the invocation does not contain "--network=none"');
  }
  for (const flag of networkFlags) {
    if (flag !== "--network=none") problems.push(`conflicting network flag ${JSON.stringify(flag)}`);
  }
  if (!dockerArgs.includes("--read-only")) problems.push('the invocation does not contain "--read-only"');
  if (!dockerArgs.includes("--cap-drop=ALL")) problems.push('the invocation does not contain "--cap-drop=ALL"');
  const hasNoNewPrivileges = dockerArgs.some(
    (arg, index) =>
      arg === "--security-opt=no-new-privileges" ||
      (arg === "--security-opt" && dockerArgs[index + 1] === "no-new-privileges"),
  );
  if (!hasNoNewPrivileges) problems.push('the invocation does not contain security-opt "no-new-privileges"');
  if (!dockerArgs.includes("--env=BAKEOFF_SCORER_SEALED=1")) {
    problems.push('the invocation does not contain "--env=BAKEOFF_SCORER_SEALED=1"');
  }

  for (let i = 0; i < dockerArgs.length; i += 1) {
    const arg = dockerArgs[i];
    if (arg === undefined) continue;

    if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      problems.push("--env-file would inject a file of host variables into the sealed container");
    }
    if (
      arg === "--privileged" ||
      arg === "--read-only=false" ||
      arg.startsWith("--cap-add") ||
      arg.startsWith("--device")
    ) {
      problems.push(`privilege-restoring flag ${JSON.stringify(arg)}`);
    }
    if (arg === "--network" || arg === "--net" || arg === "--dns" || arg.startsWith("--dns=") || arg.startsWith("--add-host")) {
      problems.push(`network-restoring flag ${JSON.stringify(arg)}`);
    }

    const isEnvFlag = arg === "-e" || arg === "--env";
    const inlineEnv = arg.startsWith("--env=") ? arg.slice("--env=".length) : arg.startsWith("-e=") ? arg.slice(3) : null;
    const value = isEnvFlag ? dockerArgs[i + 1] : inlineEnv;
    if (value === undefined || value === null) continue;

    if (!value.includes("=")) {
      problems.push(
        `bare environment forward ${JSON.stringify(value)} — this passes the HOST's value for that ` +
          "variable into the container. Every --env must be NAME=VALUE.",
      );
      continue;
    }
    const name = value.slice(0, value.indexOf("="));
    if (CREDENTIAL_ENV_NAME_RE.test(name)) {
      problems.push(`environment variable ${JSON.stringify(name)} looks like a credential name`);
    }
  }

  if (problems.length > 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the scorer container invocation is not sealed: ${problems.join("; ")}`,
      "Build the argument vector with buildDockerArgs() and do not append to it. The seal is a " +
        "held-constant variable (doc 03 section 7.3 item 3); Cursor measured 14.1-20.7pp of apparent " +
        "quality evaporating when exactly this was sealed, so an unsealed run measures something else.",
    );
  }
}

export interface DockerImageIdentity {
  /** Content digest reported by the daemon. Recorded in every ScoreRecord. */
  readonly id: string;
  /** Registry digests, when the image came from or was pushed to a registry. */
  readonly repoDigests: readonly string[];
  readonly repoTags: readonly string[];
}

/** The docker CLI's own environment. Explicit: nothing is inherited by accident. */
function dockerCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "DOCKER_BUILDKIT",
    "XDG_RUNTIME_DIR",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export interface ScorerProcessOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly launchError: string | null;
}

export type ScorerProcessRunner = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onTimeout?: () => void,
  maxOutputChars?: number,
  signal?: AbortSignal,
) => Promise<ScorerProcessOutcome>;

const runProcess: ScorerProcessRunner = (
  bin,
  args,
  timeoutMs,
  env,
  onTimeout,
  maxOutputChars = 4_000_000,
  signal,
) => {
  return new Promise<ScorerProcessOutcome>((resolvePromise) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(bin, [...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
        // The explicit timer below classifies the boundary and invokes the
        // named-container cleanup. This later native timeout is a backstop if
        // that timer is delayed by a saturated event loop.
        timeout: timeoutMs + 1_000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolvePromise({
        exitCode: -1,
        stdout: "",
        stderr: message,
        timedOut: false,
        signal: null,
        launchError: message,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: ScorerProcessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutputChars) stdout = stdout.slice(-maxOutputChars);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > maxOutputChars) stderr = stderr.slice(-maxOutputChars);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      // Node's spawn timeout also uses SIGKILL. The explicit kill makes the
      // boundary observable as `timedOut` and invokes the Docker-container kill
      // callback before the attached CLI disappears.
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}${stderr.length === 0 ? "" : "\n"}${error.message}`,
        timedOut,
        signal: null,
        launchError: error.message,
      });
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL" && Date.now() - startedAt >= timeoutMs) timedOut = true;
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut, signal, launchError: null });
    });
  });
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("the scorer runtime probe was aborted");
  error.name = "AbortError";
  throw error;
}

/**
 * Ask the daemon what the scorer image actually is.
 *
 * `Id` is the daemon's content digest for the image and is what gets recorded as
 * `ScoreRecord.scorerImageDigest`. `RepoDigests` is recorded too when the image
 * came from a registry, because only a registry digest is portable across
 * machines — a locally built image is byte-identical only on the machine that
 * built it, and saying otherwise would overstate the guarantee.
 */
export async function resolveImageIdentity(
  spec: ScorerContainerSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DockerImageIdentity> {
  return resolveImageIdentityWithRunner(spec, env, runProcess);
}

async function resolveImageIdentityWithRunner(
  spec: ScorerContainerSpec,
  env: NodeJS.ProcessEnv,
  runner: ScorerProcessRunner,
  signal?: AbortSignal,
): Promise<DockerImageIdentity> {
  throwIfAborted(signal);
  let outcome: ScorerProcessOutcome;
  try {
    outcome = await runner(
      spec.dockerBin,
      ["image", "inspect", spec.imageRef, "--format", "{{.Id}}\t{{json .RepoDigests}}\t{{json .RepoTags}}"],
      SCORER_IMAGE_INSPECT_TIMEOUT_MS,
      dockerCliEnv(env),
      undefined,
      undefined,
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
  if (outcome.launchError !== null) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `could not launch ${spec.dockerBin} to inspect scorer image ${spec.imageRef}: ` +
        redactText(outcome.launchError).text,
      `Install or configure ${spec.dockerBin}, then retry. The scorer image must be inspected before it can be ` +
        "executed by content digest.",
    );
  }
  if (outcome.timedOut) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `docker image inspect ${spec.imageRef} exceeded its ${String(SCORER_IMAGE_INSPECT_TIMEOUT_MS)} ms boundary`,
      "Check that the Docker daemon is reachable and responsive, then retry. No scoring container was started.",
    );
  }
  if (outcome.exitCode !== 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `docker image inspect ${spec.imageRef} failed (exit ${outcome.exitCode}): ${redactText(outcome.stderr.trim()).text}`,
      "Build the scorer image first — see docker/README.md — and pass its reference in " +
        "ScorerContainerSpec.imageRef. The gate refuses to run an image it cannot identify: the digest " +
        "is recorded in every ScoreRecord and is what proves the scorer was identical across configurations.",
    );
  }
  const [id = "", repoDigestsJson = "[]", repoTagsJson = "[]"] = outcome.stdout.trim().split("\t");
  const parseList = (json: string): readonly string[] => {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `docker reported image id ${JSON.stringify(id)} for ${spec.imageRef}, which is not a sha256 digest`,
      "Use a Docker daemon that reports content-addressed image ids. The scorer digest is a held-constant " +
        "variable and cannot be recorded from a non-digest identifier.",
    );
  }
  return { id, repoDigests: parseList(repoDigestsJson), repoTags: parseList(repoTagsJson) };
}

/** The named Docker image-inspection bound used by fresh scorer readiness. */
export const SCORER_IMAGE_INSPECT_TIMEOUT_MS = 120_000;

export const SCORER_RUNTIME_PROBE_TIMEOUT_MS = 30_000;

export interface ScorerRuntimeReadiness {
  /** The configured tag/reference that was resolved. */
  readonly imageRef: string;
  /** The exact local content identity passed to `docker run`. */
  readonly imageDigest: string;
  /** Complete inspect provenance for health API/UI display. */
  readonly image: DockerImageIdentity;
  /** Machine-readable facts emitted by the scorer entrypoint itself. */
  readonly smoke: ScorerRuntimeSmokePayload;
}

export interface ScorerRuntimeProbeDependencies {
  readonly runProcess?: ScorerProcessRunner;
  readonly containerName?: () => string;
  readonly signal?: AbortSignal;
}

/**
 * Prove that the configured scorer image can execute under the scoring seal.
 *
 * Inspecting an image proves only that bytes exist. This additionally executes
 * those exact bytes with the critical restrictions used for scoring and asks
 * the entrypoint to validate its bundled runtime without mounting or scoring an
 * artefact. Old images have no `--smoke` path and therefore fail closed.
 */
export async function probeScorerRuntime(
  spec: ScorerContainerSpec,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ScorerRuntimeProbeDependencies = {},
): Promise<ScorerRuntimeReadiness> {
  const runner = dependencies.runProcess ?? runProcess;
  const signal = dependencies.signal;
  throwIfAborted(signal);
  const identity = await resolveImageIdentityWithRunner(spec, env, runner, signal);
  const containerName =
    dependencies.containerName?.() ?? `bakeoff-scorer-smoke-${randomUUID().slice(0, 12)}`;
  const args = buildScorerRuntimeProbeArgs(spec, identity.id, containerName);
  assertSealedInvocation(args, identity.id, [SCORER_RUNTIME_SMOKE_ARG]);

  let cleanupPromise: Promise<ScorerProcessOutcome | null> | null = null;
  const killContainer = (): void => {
    if (cleanupPromise !== null) return;
    // Killing only the attached Docker CLI can leave the container behind.
    // The named-container kill is bounded and receives the same sanitized CLI
    // environment. It contains no image input, mounts, shell, or credentials.
    cleanupPromise = runner(spec.dockerBin, ["kill", containerName], 10_000, dockerCliEnv(env))
      .catch(() => null);
  };
  const onAbort = (): void => { killContainer(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let outcome: ScorerProcessOutcome;
  try {
    outcome = await runner(
      spec.dockerBin,
      args,
      SCORER_RUNTIME_PROBE_TIMEOUT_MS,
      dockerCliEnv(env),
      killContainer,
      64 * 1024,
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (cleanupPromise !== null) await cleanupPromise;
  }
  throwIfAborted(signal);

  if (outcome.launchError !== null) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `could not launch the scorer runtime probe with ${spec.dockerBin}: ${redactText(outcome.launchError).text}`,
      `Install or configure ${spec.dockerBin}, verify the Docker daemon is reachable, and retry. ` +
        "No score was recorded.",
    );
  }
  if (outcome.timedOut) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `scorer runtime probe for ${identity.id} exceeded its ${SCORER_RUNTIME_PROBE_TIMEOUT_MS} ms boundary` +
        `${outcome.signal === null ? "" : ` and exited on ${outcome.signal}`}`,
      "Check Docker daemon health and the configured platform/resource limits. If this image predates the " +
        "runtime smoke path, rebuild it from the current bakeoff/docker/scorer.Dockerfile.",
    );
  }
  if (outcome.exitCode !== 0) {
    const status = outcome.signal === null ? `exit ${outcome.exitCode}` : `signal ${outcome.signal}`;
    throw new BakeoffError(
      "invalid_usage_shape",
      `scorer runtime probe for ${identity.id} failed (${status}): ` +
        redactText(outcome.stderr.trim().slice(-4000)).text,
      "Rebuild the scorer image from the current bakeoff/docker/scorer.Dockerfile so it includes the " +
        "--smoke entrypoint, then pin and configure the rebuilt image digest. Do not start a bake-off with " +
        "an image that cannot pass this sealed runtime probe.",
    );
  }

  let smoke: ScorerRuntimeSmokePayload;
  try {
    smoke = parseScorerRuntimeSmoke(outcome.stdout);
  } catch (error) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `scorer runtime probe for ${identity.id} returned malformed output: ` +
        redactText(error instanceof Error ? error.message : String(error)).text,
      "Rebuild the scorer image from the current bakeoff/docker/scorer.Dockerfile. A zero exit without the " +
        "current machine-readable smoke payload is not runtime-readiness evidence.",
    );
  }

  return { imageRef: spec.imageRef, imageDigest: identity.id, image: identity, smoke };
}

/* -------------------------------------------------------------------------
 * 4. The gate
 * ---------------------------------------------------------------------- */

export interface SealedScorerGateOptions {
  /** Where score records, screenshots and tamper reports are written. */
  readonly resultsDir: string;
  /** Root of the sealed suite store. One subdirectory per ticket id. */
  readonly suiteStoreDir: string;
  /** Root under which artefacts are staged. Must be outside every workspace. */
  readonly stagingRoot: string;
  readonly container: ScorerContainerSpec;
  readonly limits: ScorerLimits;
  readonly breakpoints: readonly Breakpoint[];
  readonly maskSelectors: readonly string[];
  readonly maskColor: string;
  readonly minScreenshotBytes: number;
  /**
   * Hard ceiling on the whole container run.
   *
   * A BOUNDARY, never a progress judgement: doc 03 section 7.8 forbids
   * stuck-detection heuristics because 79% of unresolved long-horizon runs time
   * out while still actively making progress.
   */
  readonly containerTimeoutMs: number;
  readonly maxStagedFiles: number;
  readonly maxStagedBytes: number;
  /** Keep the staged copy after scoring. Useful for triage, large on disk. */
  readonly keepStagedArtifact: boolean;
}

export function defaultScorerGateOptions(
  resultsDir: string,
  suiteStoreDir: string,
  imageRef: string,
): SealedScorerGateOptions {
  return {
    resultsDir,
    suiteStoreDir,
    stagingRoot: join(resultsDir, "staging"),
    container: { ...DEFAULT_SCORER_CONTAINER, imageRef },
    limits: DEFAULT_SCORER_LIMITS,
    breakpoints: DEFAULT_BREAKPOINTS,
    maskSelectors: DEFAULT_MASK_SELECTORS,
    maskColor: DEFAULT_MASK_COLOR,
    minScreenshotBytes: MIN_SCREENSHOT_BYTES,
    containerTimeoutMs: 60 * 60 * 1000,
    maxStagedFiles: 400_000,
    maxStagedBytes: 8 * 1024 * 1024 * 1024,
    keepStagedArtifact: false,
  };
}

/**
 * Where a ticket's sealed suite files live: `<acceptanceRoot>/<ticketId>/suite`.
 *
 * INTEGRATION FIX. This used to resolve `<suiteStoreDir>/<ticketId>`, one
 * directory above where `freezeSuite` actually writes the test files. Nothing
 * type-checked that, and nothing in-tree called it, so the mismatch was
 * invisible: the first real `score` would have reported the entire suite
 * missing and raised `suite_hash_mismatch` — a TAMPERING verdict — against an
 * untampered suite. `suiteStoreDir` is the acceptance ROOT; the `suite/` level
 * is owned by the one definition in spec-freeze.
 */
export function suiteDirFor(suiteStoreDir: string, suite: AcceptanceSuite): string {
  return suiteRootFor(suite.ticketId, suiteStoreDir);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

/**
 * THE SEALED GATE.
 *
 * Construct with {@link SealedScorerGate.create}, which resolves the scorer
 * image's digest once. `score()` re-resolves it on every run and refuses to
 * proceed if it moved: a rebuilt image mid-campaign silently varies
 * held-constant variable 3 and invalidates every comparison in the bake-off.
 */
export class SealedScorerGate implements AcceptanceGate {
  readonly scorerImageDigest: string;
  readonly imageIdentity: DockerImageIdentity;
  private readonly options: SealedScorerGateOptions;
  private readonly env: NodeJS.ProcessEnv;

  private constructor(
    options: SealedScorerGateOptions,
    identity: DockerImageIdentity,
    env: NodeJS.ProcessEnv,
  ) {
    this.options = options;
    this.imageIdentity = identity;
    this.scorerImageDigest = identity.id;
    this.env = env;
  }

  static async create(
    options: SealedScorerGateOptions,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SealedScorerGate> {
    const identity = await resolveImageIdentity(options.container, env);
    return new SealedScorerGate(options, identity, env);
  }

  async score(run: RunRecord, suite: AcceptanceSuite): Promise<ScoreRecord> {
    const options = this.options;

    // ---- 0. The suite must be usable at all --------------------------------
    assertSuiteUsable(suite);

    // ---- 1. This run and this suite must be the same experiment ------------
    this.assertRunMatchesSuite(run, suite);

    // ---- 2. TAMPER CHECK, FIRST -------------------------------------------
    const suiteDir = suiteDirFor(options.suiteStoreDir, suite);
    const integrity = verifySuiteIntact(suite, suiteDir);
    if (!integrity.intact) {
      this.writeTamperReport(run.runId, integrity);
      throw new BakeoffError(
        "suite_hash_mismatch",
        `TAMPERING: the frozen acceptance suite for ticket ${suite.ticketId} no longer matches its freeze ` +
          `digest. ${integrity.problems.join(" | ")}`,
        "DO NOT RETRY THIS RUN. A retry re-measures against the tampered yardstick and launders the " +
          "tampering into a normal-looking result. Investigate how a builder obtained write access to the " +
          `sealed suite, then regenerate and re-audit it. The tamper report is at ` +
          `${join(options.resultsDir, "tamper", `${safeSegment(run.runId)}.json`)}.`,
      );
    }

    // ---- 3. The scorer image must not have moved ---------------------------
    const identity = await resolveImageIdentity(options.container, this.env);
    if (identity.id !== this.scorerImageDigest) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `the scorer image changed mid-campaign: ${this.scorerImageDigest} -> ${identity.id}`,
        "Rebuild nothing until the campaign finishes. The scorer image digest is part of held-constant " +
          "variable 3 (doc 03 section 7.3); a scorer that differs between configurations makes every " +
          "comparison in the bake-off meaningless. Re-score every run already scored with the old digest, " +
          "or discard the campaign.",
      );
    }

    // ---- 4. Stage the artefact --------------------------------------------
    mkdirSync(options.stagingRoot, { recursive: true });
    const stagedDir = mkdtempSync(join(options.stagingRoot, `${safeSegment(run.runId)}-`));
    const screenshotDir = join(options.resultsDir, "screenshots", safeSegment(run.runId));
    const outDir = join(options.resultsDir, "scorer-out", safeSegment(run.runId));
    mkdirSync(screenshotDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    let staging: StagingReport;
    let containerResult: ContainerResult;
    try {
      staging = stageArtifact({
        artifactDir: run.artifactPath,
        stagedDir,
        excludeAbsolutePaths: [run.logPath, run.ledgerPath, run.selfReportPath ?? ""].filter((p) => p.length > 0),
        // ONLY THE HELD-OUT HALF IS PROTECTED CONTENT.
        //
        // Integration finding, caught by the dry run and not by any module's
        // own tests: the runner deliberately COPIES the visible half into the
        // builder's workspace (`WORKSPACE.visibleDir`) so the builder has a
        // real feedback signal. Mapping every test file's digest here then
        // flagged that copy as "a byte-identical copy of a frozen suite file",
        // which is an instant BLOCKING failure. The effect would have been
        // heldOutPass = false and falseFinish = true on EVERY run of EVERY
        // configuration — a uniform 0% that looks exactly like "every model
        // failed" and is in fact the harness failing itself. At 5 configs x 6
        // tickets that is the entire ~$2,100 campaign, spent to measure a bug.
        //
        // Finding a HOLDOUT file in the artefact is still an instant fail: the
        // builder was never given it, so a byte-identical copy can only have
        // come from reading what it must not read.
        suiteFileDigests: new Map(
          suite.testFiles
            .filter((f) => !f.path.startsWith(`${VISIBILITY_DIRNAME.visible}/`))
            .map((f) => [f.sha256, f.path]),
        ),
        maxFiles: options.maxStagedFiles,
        maxBytes: options.maxStagedBytes,
      });

      // ---- 5. The sealed plan ---------------------------------------------
      const plan: ScorerPlan = {
        protocolVersion: SCORER_PROTOCOL_VERSION,
        ticketId: suite.ticketId,
        acceptanceSuiteSha256: suite.sha256,
        criteria: suite.criteria,
        breakpoints: options.breakpoints,
        maskSelectors: options.maskSelectors,
        maskColor: options.maskColor,
        minScreenshotBytes: options.minScreenshotBytes,
        limits: options.limits,
      };
      assertPlanIsSealed(plan);

      // Round-trip the plan through the container's own parser before shipping
      // it. The container validates strictly and aborts on a bad bound; without
      // this, an out-of-range option (a totalTimeoutMs below the floor, an empty
      // mask list) is discovered only after a container has started, and comes
      // back as an opaque parse failure rather than as the precise message the
      // parser already produces. Same validator, same message, one process
      // earlier.
      const planJson = `${JSON.stringify(plan, null, 2)}\n`;
      parseScorerPlan(JSON.parse(planJson) as unknown);

      const planFile = join(outDir, "plan.json");
      writeFileSync(planFile, planJson, "utf8");

      // ---- 6. Run it -------------------------------------------------------
      containerResult = await this.runContainer(run.runId, {
        stagedArtifactDir: stagedDir,
        suiteDir,
        planFile,
        outDir,
        screenshotDir,
      });
    } finally {
      if (!options.keepStagedArtifact) {
        rmSync(stagedDir, { recursive: true, force: true });
      }
    }

    // ---- 7. Assemble the score record --------------------------------------
    const record = this.buildScoreRecord(run, suite, staging, containerResult);
    const scoresDir = join(options.resultsDir, "scores");
    mkdirSync(scoresDir, { recursive: true });
    writeFileSync(
      join(scoresDir, `${safeSegment(run.runId)}.json`),
      `${JSON.stringify(redactForPersistence(record), null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(scoresDir, `${safeSegment(run.runId)}.container.json`),
      `${JSON.stringify(redactForPersistence({ integrity, staging, container: containerResult, image: identity }), null, 2)}\n`,
      "utf8",
    );
    return record;
  }

  /* ---- internals -------------------------------------------------------- */

  private assertRunMatchesSuite(run: RunRecord, suite: AcceptanceSuite): void {
    const problems: string[] = [];
    if (run.ticketId !== suite.ticketId) {
      problems.push(`run ticketId ${run.ticketId} != suite ticketId ${suite.ticketId}`);
    }
    if (run.ticketSha256 !== suite.ticketSha256) {
      problems.push(
        `run ticketSha256 ${run.ticketSha256} != suite ticketSha256 ${suite.ticketSha256} — the run built a ` +
          "different ticket text from the one the suite was authored against",
      );
    }
    if (run.heldConstants.acceptanceSuiteSha256 !== suite.sha256) {
      problems.push(
        `the run recorded acceptance suite ${run.heldConstants.acceptanceSuiteSha256} but this suite is ` +
          `${suite.sha256}`,
      );
    }
    if (problems.length > 0) {
      throw new BakeoffError(
        "suite_hash_mismatch",
        `run ${run.runId} cannot be scored against this suite: ${problems.join("; ")}`,
        "DO NOT RETRY. Fix the campaign wiring. Scoring a run against the wrong suite produces a number " +
          "that looks like a result and is not one; held-constant variable 5 requires that every " +
          "configuration builds against the same suite for the same ticket (doc 03 section 7.3).",
      );
    }
  }

  private writeTamperReport(runId: string, integrity: SuiteIntegrityReport): void {
    const dir = join(this.options.resultsDir, "tamper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${safeSegment(runId)}.json`),
      `${JSON.stringify(redactForPersistence({ runId, integrity }), null, 2)}\n`,
      "utf8",
    );
  }

  private async runContainer(runId: string, mounts: ScorerMounts): Promise<ContainerResult> {
    const spec = this.options.container;
    const containerName = `bakeoff-scorer-${safeSegment(runId)}-${randomUUID().slice(0, 8)}`;
    const args = buildDockerArgs(spec, mounts, containerName);
    assertSealedInvocation(args, spec.imageRef);

    const outcome = await runProcess(
      spec.dockerBin,
      args,
      this.options.containerTimeoutMs,
      dockerCliEnv(this.env),
      () => {
        // Kill the container itself, not just the CLI that is attached to it.
        // `docker run --rm` leaves the container running if only the client dies.
        void runProcess(spec.dockerBin, ["kill", containerName], 60_000, dockerCliEnv(this.env));
      },
    );

    const resultPath = join(mounts.outDir, "result.json");
    if (!existsSync(resultPath)) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `the scorer container produced no result.json (docker exit ${outcome.exitCode}` +
          `${outcome.timedOut ? `, killed on the ${this.options.containerTimeoutMs} ms boundary` : ""}). ` +
          `stderr tail: ${redactText(outcome.stderr.slice(-4000)).text}`,
        "This is an INFRASTRUCTURE failure, not a model outcome. Do not record it as a held-out failure: " +
          'doc 03 excludes RunStatus "error" from every rate denominator and reports it separately. ' +
          "Check that the scorer image was built from this source tree and that the mounts are writable.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    } catch (error) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `the scorer container's result.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        "Treat as an infrastructure failure and re-run the gate. Never substitute a default result: an " +
          "unreadable gate output is not a failing gate output.",
      );
    }
    return parseContainerResult(parsed);
  }

  private buildScoreRecord(
    run: RunRecord,
    suite: AcceptanceSuite,
    staging: StagingReport,
    container: ContainerResult,
  ): ScoreRecord {
    assertNoGateIdCollision(suite);

    const protectedPathViolations = staging.protectedPathViolations;

    const hostGates: readonly CriterionResult[] = [
      {
        criterionId: GATE_IDS.suiteIntact,
        tier: "BLOCKING",
        passed: true,
        evidenceRef: suite.sha256,
        detail: null,
      },
      {
        criterionId: GATE_IDS.noProtectedPathWrites,
        tier: "BLOCKING",
        passed: protectedPathViolations.length === 0,
        evidenceRef: "staging",
        detail:
          protectedPathViolations.length === 0
            ? null
            : `${protectedPathViolations.length} violation(s): ${protectedPathViolations.slice(0, 20).join(" | ")}`,
      },
    ];

    const containerGates: readonly CriterionResult[] = container.tier0.map((gate) => gateToCriterion(gate));

    const suiteCriteria: readonly CriterionResult[] = container.criterionCoverage.map((coverage) => ({
      criterionId: coverage.criterionId,
      tier: coverage.tier,
      passed: coverage.outcome === "passed",
      evidenceRef: coverage.testRefs[0] ?? null,
      detail: coverage.outcome === "passed" ? null : coverage.detail,
    }));

    const domCriteria: readonly CriterionResult[] = summariseDomFindings(container);

    const criteriaResults: readonly CriterionResult[] = [
      ...hostGates,
      ...containerGates,
      ...suiteCriteria,
      ...domCriteria,
    ];

    // The two co-primary metrics, each computed by the ONE function in
    // contracts.ts that defines it. Neither is reimplemented here, and the
    // builder's self-report enters at exactly one place: the first argument to
    // deriveFalseFinish. It scores nothing.
    const heldOutPass = computeHeldOutPass(criteriaResults, protectedPathViolations);
    const falseFinish = deriveFalseFinish(run.agentDeclaredDone, heldOutPass);

    const suiteExecution: SuiteExecution = {
      exitCode: container.suiteExecution.exitCode,
      durationMs: container.suiteExecution.durationMs,
      testsTotal: container.suiteExecution.testsTotal,
      testsPassed: container.suiteExecution.testsPassed,
      testsFailed: container.suiteExecution.testsFailed,
      logPath: join(this.options.resultsDir, "scores", `${safeSegment(run.runId)}.container.json`),
    };

    return {
      schemaVersion: BAKEOFF_SCHEMA_VERSION,
      runId: run.runId,
      ticketId: suite.ticketId,
      acceptanceSuiteSha256: suite.sha256,
      heldOutPass,
      criteriaResults,
      falseFinish,
      agentDeclaredDone: run.agentDeclaredDone,
      scoredAt: new Date().toISOString(),
      scorerImageDigest: this.scorerImageDigest,
      suiteExecution,
      protectedPathViolations,
    };
  }
}

/* -------------------------------------------------------------------------
 * 5. Mapping helpers
 * ---------------------------------------------------------------------- */

/**
 * A frozen criterion may not use the reserved `GATE:` prefix.
 *
 * Merging suite-authored text over a deterministic gate result would let the
 * suite decide what "build succeeded" means, which is the one thing the
 * deterministic tier exists to take away from any authored artefact.
 */
export function assertNoGateIdCollision(suite: AcceptanceSuite): void {
  const colliding = suite.criteria.filter((c) => c.id.startsWith(GATE_ID_PREFIX)).map((c) => c.id);
  if (colliding.length > 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the frozen suite uses the reserved criterion id prefix "${GATE_ID_PREFIX}": ${colliding.join(", ")}`,
      `Regenerate the suite with criterion ids that do not begin with "${GATE_ID_PREFIX}". That prefix is ` +
        "reserved for the deterministic Tier-0 gates, which no authored artefact may name or override.",
    );
  }
}

/**
 * Map a Tier-0 gate onto a BLOCKING criterion result.
 *
 * `not_applicable` maps to `passed: true` with the reason spelled out in the
 * detail. It is reachable ONLY when the frozen suite declares a step absent (no
 * lint command, no data expectation) — never when the artefact happens to lack
 * something — so it cannot be produced by a builder omitting work.
 */
export function gateToCriterion(gate: Tier0GateResult): CriterionResult {
  if (gate.outcome === "not_applicable") {
    return {
      criterionId: gate.id,
      tier: "BLOCKING",
      passed: true,
      evidenceRef: gate.command,
      detail: `NOT APPLICABLE: ${gate.detail}`,
    };
  }
  return {
    criterionId: gate.id,
    tier: "BLOCKING",
    passed: gate.outcome === "pass",
    evidenceRef: gate.command,
    detail: gate.outcome === "pass" ? null : gate.detail,
  };
}

/**
 * Roll the DOM/runtime observations up into QUALITY criteria.
 *
 * QUALITY NEVER GATES. doc 02 section 5.4: a passing quality result must never
 * raise a grade, and `computeHeldOutPass` in contracts.ts ignores the tier
 * entirely. These appear in the record so a reviewer can see them and so the
 * dashboard has something to show; they cannot move `heldOutPass` by
 * construction, which is why they are safe to emit even when noisy.
 */
export function summariseDomFindings(container: ContainerResult): readonly CriterionResult[] {
  const byKind = new Map<string, string[]>();
  for (const finding of container.domFindings) {
    const list = byKind.get(finding.kind) ?? [];
    list.push(`${finding.flowId}@${finding.breakpoint}: ${finding.detail}`);
    byKind.set(finding.kind, list);
  }

  const results: CriterionResult[] = [];
  for (const [kind, details] of [...byKind.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    results.push({
      criterionId: `QUALITY:${kind}`,
      tier: "QUALITY",
      passed: kind === "sealed_network_request_blocked",
      evidenceRef: null,
      detail: `${details.length} observation(s): ${details.slice(0, 10).join(" | ")}`,
    });
  }

  const nonBlockingExploits = container.exploitFindings.filter((f) => !f.blocking);
  if (nonBlockingExploits.length > 0) {
    results.push({
      criterionId: "QUALITY:non_blocking_exploit_pattern",
      tier: "QUALITY",
      passed: false,
      evidenceRef: null,
      detail:
        `${nonBlockingExploits.length} reward-hack pattern(s) outside test-adjacent paths, reported and not ` +
        `gating: ${nonBlockingExploits
          .slice(0, 10)
          .map((f) => `${f.path}${f.line === null ? "" : `:${f.line}`} ${f.rule}`)
          .join(" | ")}`,
    });
  }

  if (container.infrastructureErrors.length > 0) {
    results.push({
      criterionId: "QUALITY:scorer_infrastructure",
      tier: "QUALITY",
      passed: false,
      evidenceRef: null,
      detail:
        `${container.infrastructureErrors.length} scorer-side problem(s) — these are the SCORER's failures, ` +
        `not the artefact's: ${container.infrastructureErrors.slice(0, 10).join(" | ")}`,
    });
  }

  return results;
}

/* -------------------------------------------------------------------------
 * 6. Operator-facing summary
 * ---------------------------------------------------------------------- */

/** Human-readable summary of a score record. Never a scoring input. */
export function formatScoreRecord(record: ScoreRecord): string {
  const gating = record.criteriaResults.filter((c) => c.tier === "BLOCKING" || c.tier === "FUNCTIONAL");
  const failed = gating.filter((c) => !c.passed);
  const lines: string[] = [
    `run ${record.runId} — ticket ${record.ticketId}`,
    `  suite            ${record.acceptanceSuiteSha256}`,
    `  scorer image     ${record.scorerImageDigest}`,
    `  held_out_pass    ${String(record.heldOutPass)}   <- CO-PRIMARY`,
    `  false_finish     ${String(record.falseFinish)}   <- CO-PRIMARY (agent declared done AND the suite failed)`,
    `  agent self-report: declaredDone=${String(record.agentDeclaredDone)}  (RECORDED, SCORES NOTHING)`,
    `  gating criteria  ${gating.length - failed.length}/${gating.length} passed`,
    `  suite            exit ${record.suiteExecution.exitCode}, ` +
      `${record.suiteExecution.testsPassed ?? "?"}/${record.suiteExecution.testsTotal ?? "?"} passed, ` +
      `${record.suiteExecution.durationMs} ms`,
  ];
  if (record.protectedPathViolations.length > 0) {
    lines.push(`  PROTECTED PATH VIOLATIONS (instant fail): ${record.protectedPathViolations.length}`);
    for (const violation of record.protectedPathViolations.slice(0, 10)) lines.push(`    - ${violation}`);
  }
  if (failed.length > 0) {
    lines.push("  failed gating criteria:");
    for (const criterion of failed.slice(0, 30)) {
      lines.push(`    - [${criterion.tier}] ${criterion.criterionId}: ${criterion.detail ?? "(no detail)"}`);
    }
  }
  return lines.join("\n");
}

/**
 * A bind-mount source must be absolute.
 *
 * A relative source is not a small mistake: depending on the Docker syntax in
 * use it either errors or is interpreted as a NAMED VOLUME, which mounts an
 * empty directory. An empty `/artifact` looks exactly like a build that produced
 * nothing, and every downstream gate would fail for the wrong reason.
 */
export function isMountablePath(path: string): boolean {
  return path.length > 0 && isAbsolute(path);
}

export function assertMountablePaths(mounts: ScorerMounts): void {
  const bad = Object.entries(mounts)
    .filter(([, value]) => !isMountablePath(value))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (bad.length > 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `bind-mount source(s) are not absolute paths: ${bad.join(", ")}`,
      "Resolve every mount source to an absolute path before building the invocation. A relative " +
        "source mounts an empty named volume, and an empty artefact directory is indistinguishable " +
        "from a build that produced nothing.",
    );
  }
}
