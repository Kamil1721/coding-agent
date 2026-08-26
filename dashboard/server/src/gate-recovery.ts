/**
 * An isolated, gate-only recovery lane.
 *
 * This module intentionally has no Orchestrator, catalog, builder, fixer,
 * critic, Context7, judge, adversary, preview, or publisher dependency. The
 * only expensive operation it can reach is AcceptanceGate.score().
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BAKEOFF_SCHEMA_VERSION, BakeoffError, computeHeldOutPass, deriveFalseFinish } from "bakeoff/dist/contracts.js";
import type { AcceptanceGate, AcceptanceSuite, CriterionResult, RunRecord, ScoreRecord } from "bakeoff/dist/contracts.js";
import { createGate } from "bakeoff/dist/gate.js";
import { canonicalJson, sha256Hex } from "bakeoff/dist/hash.js";
import { WORKSPACE } from "bakeoff/dist/runner.js";
import {
  DEFAULT_SCORER_CONTAINER,
  STAGING_EXCLUDED_DIRS,
  defaultScorerGateOptions,
  stageArtifact,
} from "bakeoff/dist/scorer.js";
import type { StageArtifactOptions, StagingReport } from "bakeoff/dist/scorer.js";
import { ALL_GATE_IDS, GATE_ID_PREFIX, parseContainerResult } from "bakeoff/dist/scorer-protocol.js";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import { assertSuiteIntact } from "bakeoff/dist/spec-freeze.js";
import type { GateRecoveryRow, NewGateRecovery, RunRow, RunStore } from "./db.js";
import { isTerminal } from "./db.js";
import { checkGateReadinessFresh } from "./gate-readiness.js";
import type { GateReadiness, GateReadinessResult } from "./gate-readiness.js";
import { liveResultPath, scoresRoot } from "./gate-attempts.js";
import { gateEnv, runPathsFor, safeSegment } from "./paths.js";
import type { DashboardPaths, RunPaths } from "./paths.js";
import { writeRunVerdict } from "./run-report.js";

export const GATE_RECOVERY_PROTOCOL_VERSION = 1;
export const GATE_RECOVERY_METADATA_FILE = "recovery.json";
export const GATE_RECOVERY_OWNER_FILE = ".gate-recovery-owner.json";
export const MAX_GATE_RECOVERY_CLIENT_REQUEST_ID = 128;

const DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface GateRecoveryRequest {
  readonly clientRequestId: string;
  readonly payloadSha256: string;
}

export interface GateRecoveryResponse {
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly recoveryState: GateRecoveryRow["state"];
  readonly status: RunRow["status"];
  readonly heldOutPass: boolean | null;
  readonly falseFinish: boolean | null;
  readonly replayed: boolean;
  readonly tasteCritic: "not_run_gate_only";
}

export class GateRecoveryRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly remediation: string | null;

  constructor(status: number, code: string, message: string, remediation: string | null) {
    super(message);
    this.name = "GateRecoveryRefusal";
    this.status = status;
    this.code = code;
    this.remediation = remediation;
  }
}

export interface WorkspaceInventoryEntry {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly mode: number;
  readonly bytes: number | null;
  readonly sha256: string | null;
}

export interface WorkspaceInventory {
  readonly entries: readonly WorkspaceInventoryEntry[];
  readonly sha256: string;
}

export type InventoryWorkspace = (workspace: string) => WorkspaceInventory;
export type StageWorkspace = (options: StageArtifactOptions) => StagingReport;

export interface GateRecoveryControllerOptions {
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  readonly readiness: GateReadiness;
  readonly env?: NodeJS.ProcessEnv;
  readonly makeGate?: (env: NodeJS.ProcessEnv) => Promise<AcceptanceGate>;
  readonly now?: () => Date;
  readonly newRunId?: (sourceRunId: string, request: GateRecoveryRequest, at: Date) => string;
  readonly inventory?: InventoryWorkspace;
  readonly stageWorkspace?: StageWorkspace;
}

interface EligibleSource {
  readonly row: RunRow;
  readonly runPaths: RunPaths;
  readonly runRecord: RunRecord;
  readonly suite: AcceptanceSuite;
  readonly workspaceRealPath: string;
}

type ReadyGateReadiness = GateReadinessResult & {
  readonly scorerImageDigest: string;
  readonly checkedAt: string;
};

interface OwnerMarker {
  readonly protocolVersion: 1;
  readonly sourceRunId: string;
  readonly clientRequestId: string;
  readonly payloadSha256: string;
  readonly targetRunId: string;
}

interface ScorerOutputReservation {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly role: "score" | "container" | "tamper" | "scorer-out" | "screenshots";
  readonly dev: number;
  readonly ino: number;
}

interface RecoveryMetadata {
  readonly protocolVersion: 1;
  readonly kind: "gate-only-recovery";
  readonly sourceRunId: string;
  readonly clientRequestId: string;
  readonly payloadSha256: string;
  readonly targetRunId: string;
  readonly ticketId: string;
  readonly ticketSha256: string;
  readonly suiteSha256: string;
  readonly artifactDigestSemantics: "recovery-time-scorer-visible-snapshot";
  readonly sourceArtifactSha256: string | null;
  readonly targetArtifactSha256: string | null;
  readonly readiness: {
    readonly checkedAt: string;
    readonly scorerImageDigest: string;
  };
  readonly tasteCritic: {
    readonly status: "not-run";
    readonly reason: "gate-only recovery makes no model calls";
  };
  readonly timestamps: {
    readonly createdAt: string;
    readonly snapshotCompletedAt: string | null;
    readonly scoringStartedAt: string | null;
    readonly completedAt: string | null;
  };
  readonly state: GateRecoveryRow["state"];
  readonly terminalError: string | null;
}

function refusal(status: number, code: string, message: string, remediation: string | null = null): never {
  throw new GateRecoveryRefusal(status, code, message, remediation);
}

function exactObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return exactObject(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function readJsonRegularObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  return stat.isSymbolicLink() || !stat.isFile() ? null : readJsonObject(path);
}

function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Canonical scorer-visible inventory. It mirrors the scorer's directory-name
 * exclusions, but refuses facts that the scorer copy would otherwise silently
 * skip (symlinks and unsupported filesystem entries).
 */
export function inventoryScorerVisibleWorkspace(workspace: string): WorkspaceInventory {
  if (!existsSync(workspace) || lstatSync(workspace).isSymbolicLink() || !lstatSync(workspace).isDirectory()) {
    refusal(409, "gate_recovery_workspace_missing", `workspace ${workspace} is not a directory`);
  }
  const entries: WorkspaceInventoryEntry[] = [];
  const visit = (directory: string, relDir: string): void => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const rel = relDir.length === 0 ? child.name : `${relDir}/${child.name}`;
      const absolute = join(directory, child.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        refusal(409, "gate_recovery_symlink_refused", `workspace entry ${rel} is a symbolic link`);
      }
      if (child.isDirectory()) {
        if (STAGING_EXCLUDED_DIRS.includes(child.name)) continue;
        entries.push({ path: rel, type: "directory", mode: stat.mode & 0o777, bytes: null, sha256: null });
        visit(absolute, rel);
        continue;
      }
      if (!child.isFile()) {
        refusal(409, "gate_recovery_entry_refused", `workspace entry ${rel} is not a regular file or directory`);
      }
      entries.push({
        path: rel,
        type: "file",
        mode: stat.mode & 0o777,
        bytes: stat.size,
        sha256: sha256File(absolute),
      });
    }
  };
  visit(resolve(workspace), "");
  const serializable = entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    bytes: entry.bytes,
    sha256: entry.sha256,
  }));
  return { entries, sha256: sha256Hex(canonicalJson(serializable)) };
}

function assertRegularTree(workspace: string): void {
  // The scorer reports skipped symlinks and protected paths. This preliminary
  // walk adds only the fact it does not model: unsupported filesystem entries.
  const visit = (directory: string, relDir: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const rel = relDir.length === 0 ? child.name : `${relDir}/${child.name}`;
      const absolute = join(directory, child.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) refusal(409, "gate_recovery_symlink_refused", `workspace entry ${rel} is a symbolic link`);
      if (!child.isDirectory() && !child.isFile()) {
        refusal(409, "gate_recovery_entry_refused", `workspace entry ${rel} is not a regular file or directory`);
      }
      if (child.isDirectory()) visit(absolute, rel);
    }
  };
  visit(workspace, "");
}

function assertCleanStaging(report: StagingReport): void {
  if (report.skippedSymlinks.length > 0) {
    refusal(409, "gate_recovery_symlink_refused", `scorer staging skipped symlink ${report.skippedSymlinks[0] ?? "unknown"}`);
  }
  if (report.protectedPathViolations.length > 0) {
    refusal(409, "gate_recovery_forbidden_path", report.protectedPathViolations[0] ?? "protected path violation");
  }
}

function ownerMarker(recovery: GateRecoveryRow): OwnerMarker {
  return {
    protocolVersion: GATE_RECOVERY_PROTOCOL_VERSION,
    sourceRunId: recovery.sourceRunId,
    clientRequestId: recovery.clientRequestId,
    payloadSha256: recovery.payloadSha256,
    targetRunId: recovery.targetRunId,
  };
}

function markerMatches(path: string, expected: OwnerMarker): boolean {
  const parsed = readJsonObject(path);
  return parsed?.["protocolVersion"] === expected.protocolVersion &&
    parsed["sourceRunId"] === expected.sourceRunId &&
    parsed["clientRequestId"] === expected.clientRequestId &&
    parsed["payloadSha256"] === expected.payloadSha256 &&
    parsed["targetRunId"] === expected.targetRunId;
}

function describeError(error: unknown): string {
  return error instanceof BakeoffError
    ? `[${error.code}] ${error.message}; fix: ${error.remediation}`
    : error instanceof Error ? error.message : String(error);
}

function scorePath(paths: DashboardPaths, runId: string): string {
  return join(scoresRoot(paths), `${safeSegment(runId)}.json`);
}

function parsePersistedScore(value: unknown): ScoreRecord | null {
  const parsed = exactObject(value);
  if (parsed === null) return null;
  const string = (key: string): string | null => typeof parsed[key] === "string" ? String(parsed[key]) : null;
  const boolean = (key: string): boolean | null => typeof parsed[key] === "boolean" ? Boolean(parsed[key]) : null;
  const criteriaRaw = parsed["criteriaResults"];
  const protectedRaw = parsed["protectedPathViolations"];
  const execution = exactObject(parsed["suiteExecution"]);
  if (!Array.isArray(criteriaRaw) || !Array.isArray(protectedRaw) || execution === null) return null;
  const criteria: CriterionResult[] = [];
  for (const raw of criteriaRaw) {
    const row = exactObject(raw);
    if (row === null || typeof row["criterionId"] !== "string" || String(row["criterionId"]).length === 0 ||
      !["BLOCKING", "FUNCTIONAL", "QUALITY"].includes(String(row["tier"])) ||
      typeof row["passed"] !== "boolean" ||
      !(row["evidenceRef"] === null || typeof row["evidenceRef"] === "string") ||
      !(row["detail"] === null || typeof row["detail"] === "string")) return null;
    criteria.push({
      criterionId: String(row["criterionId"]),
      tier: String(row["tier"]) as CriterionResult["tier"],
      passed: Boolean(row["passed"]),
      evidenceRef: row["evidenceRef"] as string | null,
      detail: row["detail"] as string | null,
    });
  }
  const nullableCount = (key: string): number | null | undefined => {
    const raw = execution[key];
    if (raw === null) return null;
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  };
  const durationMs = execution["durationMs"];
  const exitCode = execution["exitCode"];
  const testsTotal = nullableCount("testsTotal");
  const testsPassed = nullableCount("testsPassed");
  const testsFailed = nullableCount("testsFailed");
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) ||
    typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 ||
    testsTotal === undefined || testsPassed === undefined || testsFailed === undefined ||
    !(execution["logPath"] === null || typeof execution["logPath"] === "string") ||
    protectedRaw.some((entry) => typeof entry !== "string")) return null;
  const runId = string("runId");
  const ticketId = string("ticketId");
  const suiteSha = string("acceptanceSuiteSha256");
  const scoredAt = string("scoredAt");
  const image = string("scorerImageDigest");
  const heldOutPass = boolean("heldOutPass");
  const falseFinish = boolean("falseFinish");
  const agentDeclaredDone = boolean("agentDeclaredDone");
  if (parsed["schemaVersion"] !== BAKEOFF_SCHEMA_VERSION || runId === null || ticketId === null ||
    suiteSha === null || !DIGEST.test(suiteSha) || scoredAt === null || !Number.isFinite(Date.parse(scoredAt)) ||
    image === null || !IMAGE_DIGEST.test(image) || heldOutPass === null || falseFinish === null ||
    agentDeclaredDone === null) return null;
  const score: ScoreRecord = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION, runId, ticketId, acceptanceSuiteSha256: suiteSha,
    heldOutPass, criteriaResults: criteria, falseFinish, agentDeclaredDone, scoredAt,
    scorerImageDigest: image,
    suiteExecution: {
      exitCode, durationMs, testsTotal, testsPassed, testsFailed,
      logPath: execution["logPath"] as string | null,
    },
    protectedPathViolations: protectedRaw as string[],
  };
  return computeHeldOutPass(score.criteriaResults, score.protectedPathViolations) === score.heldOutPass &&
    deriveFalseFinish(score.agentDeclaredDone, score.heldOutPass) === score.falseFinish ? score : null;
}

function readMatchingScore(paths: DashboardPaths, recovery: GateRecoveryRow): ScoreRecord | null {
  const parsed = readJsonRegularObject(scorePath(paths, recovery.targetRunId));
  if (parsed === null) return null;
  const score = parsePersistedScore(parsed);
  return score !== null && score.runId === recovery.targetRunId &&
    score.acceptanceSuiteSha256 === recovery.suiteSha256 && score.agentDeclaredDone ? score : null;
}

function readContainer(paths: DashboardPaths, runId: string): ContainerResult | null {
  const path = liveResultPath(paths, runId);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
  try {
    return parseContainerResult(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export class GateRecoveryController {
  readonly #store: RunStore;
  readonly #paths: DashboardPaths;
  readonly #readiness: GateReadiness;
  readonly #env: NodeJS.ProcessEnv;
  readonly #makeGate: (env: NodeJS.ProcessEnv) => Promise<AcceptanceGate>;
  readonly #now: () => Date;
  readonly #newRunId: (sourceRunId: string, request: GateRecoveryRequest, at: Date) => string;
  readonly #inventory: InventoryWorkspace;
  readonly #stageWorkspace: StageWorkspace;
  readonly #singleFlight = new Map<
    string,
    { readonly payloadSha256: string; readonly task: Promise<GateRecoveryResponse> }
  >();

  constructor(options: GateRecoveryControllerOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#readiness = options.readiness;
    this.#env = options.env ?? process.env;
    this.#makeGate = options.makeGate ?? createGate;
    this.#now = options.now ?? (() => new Date());
    this.#newRunId = options.newRunId ?? ((sourceRunId, request) =>
      `run-gate-recovery-${sha256Hex(`${sourceRunId}\u0000${request.clientRequestId}\u0000${request.payloadSha256}`).slice(0, 24)}`);
    this.#inventory = options.inventory ?? inventoryScorerVisibleWorkspace;
    this.#stageWorkspace = options.stageWorkspace ?? stageArtifact;
  }

  async recover(sourceRunId: string, request: GateRecoveryRequest): Promise<GateRecoveryResponse> {
    const key = `${sourceRunId}\u0000${request.clientRequestId}`;
    const active = this.#singleFlight.get(key);
    if (active !== undefined) {
      if (active.payloadSha256 !== request.payloadSha256) {
        refusal(409, "gate_recovery_idempotency_conflict", "clientRequestId is active with a different payload");
      }
      return { ...(await active.task), replayed: true };
    }
    const task = this.#recover(sourceRunId, request);
    const flight = { payloadSha256: request.payloadSha256, task };
    this.#singleFlight.set(key, flight);
    try {
      return await task;
    } finally {
      if (this.#singleFlight.get(key) === flight) this.#singleFlight.delete(key);
    }
  }

  /** Must run before Orchestrator.reconcileOnBoot(). */
  async reconcileOnBoot(): Promise<void> {
    for (const { recovery } of this.#store.listIncompleteGateRecoveries()) {
      try {
        await this.#resumeAfterBoot(recovery);
      } catch (error) {
        await this.#failRecovery(recovery, `boot recovery failed: ${describeError(error)}`);
      }
    }
  }

  async #recover(sourceRunId: string, request: GateRecoveryRequest): Promise<GateRecoveryResponse> {
    const existing = this.#store.gateRecovery(sourceRunId, request.clientRequestId);
    if (existing !== null) {
      if (existing.payloadSha256 !== request.payloadSha256) {
        refusal(409, "gate_recovery_idempotency_conflict", "clientRequestId was already used with a different payload");
      }
      if (existing.state !== "completed" && existing.state !== "infra_failed") {
        await this.#resumeAfterBoot(existing);
      }
      const resumed = this.#store.gateRecovery(sourceRunId, request.clientRequestId) ?? existing;
      return this.#response(resumed, true);
    }

    const source = this.#eligibleSource(sourceRunId);
    const readiness = await this.#requireReadiness();
    // Read again after the async probe; no source fact may change in that gap.
    this.#eligibleSource(sourceRunId);
    const now = this.#now();
    const targetRunId = this.#newRunId(sourceRunId, request, now);
    const targetPaths = runPathsFor(this.#paths, targetRunId);
    this.#runsRootRealPath();
    if (existsSync(targetPaths.root)) {
      refusal(409, "gate_recovery_target_exists", `target root ${targetPaths.root} already exists`);
    }
    const claimInput: NewGateRecovery = {
      sourceRunId,
      clientRequestId: request.clientRequestId,
      payloadSha256: request.payloadSha256,
      target: {
        runId: targetRunId,
        ticketId: source.row.ticketId,
        ticketTitle: `${source.row.ticketTitle} — gate recovery`,
        ticketText: source.row.ticketText,
        ticketSha256: source.row.ticketSha256,
        modelId: source.row.modelId,
        provider: source.row.provider,
        deploy: false,
        startedAt: now.toISOString(),
        queuePosition: 0,
        designLock: source.row.designLock === "auto" || source.row.designLock === "ask"
          ? source.row.designLock
          : null,
        interactive: source.row.interactive,
      },
      targetArtifactPath: targetPaths.workspace,
      ticketSha256: source.row.ticketSha256,
      suiteSha256: source.suite.sha256,
      criteria: source.suite.criteria.map(({ id, statement, tier }) => ({ id, statement, tier })),
      createdAt: now.toISOString(),
    };
    const claim = this.#store.claimGateRecovery(claimInput);
    if (claim.kind === "conflict") {
      refusal(409, "gate_recovery_idempotency_conflict", "clientRequestId was already used with a different payload");
    }
    if (claim.kind === "source_blocked") {
      if (claim.recovery.state === "infra_failed") {
        refusal(
          409,
          "gate_recovery_attempts_exhausted",
          `source exhausted its bounded gate-only recovery attempts; latest child is ${claim.recovery.targetRunId}`,
          "Do not invoke the sealed scorer again for this source. Review the infrastructure failure before creating a controlled replacement run.",
        );
      }
      refusal(
        409,
        "gate_recovery_source_already_claimed",
        `source already has recovery ${claim.recovery.targetRunId} in state ${claim.recovery.state}`,
        "Replay its original clientRequestId. A fresh key is allowed only after an infrastructure-failed recovery.",
      );
    }
    if (claim.kind === "replay") return this.#response(claim.recovery, true);
    await this.#stageAndScore(claim.recovery, source, readiness);
    const completed = this.#store.gateRecovery(sourceRunId, request.clientRequestId);
    if (completed === null) throw new Error("gate recovery lineage vanished after execution");
    return this.#response(completed, false);
  }

  #eligibleSource(sourceRunId: string): EligibleSource {
    if (this.#store.isGateRecoveryTarget(sourceRunId)) {
      refusal(409, "gate_recovery_target_as_source", "a gate-recovery child cannot itself be recovered");
    }
    const row = this.#store.getRun(sourceRunId);
    if (row === null) refusal(404, "unknown_run", `no run ${sourceRunId}`);
    if (
      row.status !== "failed" || row.phase !== "done" || row.heldOutPass !== null ||
      row.falseFinish !== null || row.gateStopReason !== "infra" || !row.agentDeclaredDone ||
      row.suiteSha256 === null
    ) {
      refusal(
        409,
        "gate_recovery_ineligible",
        "source must be terminal failed/done with agentDeclaredDone=true, gateStopReason=infra, and no held-out verdict",
      );
    }
    const runPaths = runPathsFor(this.#paths, sourceRunId);
    const runsRootRealPath = this.#runsRootRealPath();
    if (!existsSync(runPaths.root) || lstatSync(runPaths.root).isSymbolicLink() ||
      !existsSync(runPaths.workspace) || lstatSync(runPaths.workspace).isSymbolicLink() ||
      !lstatSync(runPaths.workspace).isDirectory()) {
      refusal(409, "gate_recovery_workspace_missing", "source workspace is missing");
    }
    const realRoot = realpathSync(runPaths.root);
    if (relative(runsRootRealPath, realRoot) !== safeSegment(sourceRunId)) {
      refusal(409, "gate_recovery_run_root_escape", "source run root does not resolve as a direct child of the runs root");
    }
    const workspaceRealPath = realpathSync(runPaths.workspace);
    const rel = relative(realRoot, workspaceRealPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      refusal(409, "gate_recovery_workspace_escape", "source workspace does not resolve inside its expected run root");
    }
    assertRegularTree(runPaths.workspace);
    const sourceScore = scorePath(this.#paths, sourceRunId);
    if (existsSync(sourceScore)) refusal(409, "gate_recovery_source_already_scored", "source already has a score record");
    const selfReport = readJsonObject(join(runPaths.workspace, WORKSPACE.selfReport));
    if (selfReport?.["status"] !== "done") {
      refusal(409, "gate_recovery_self_report_invalid", "source self-report is absent, malformed, or not status=done");
    }
    const runJsonPath = join(runPaths.results, "run.json");
    const runJson = readJsonObject(runJsonPath);
    const held = exactObject(runJson?.["heldConstants"]);
    if (
      runJson === null || runJson["schemaVersion"] !== BAKEOFF_SCHEMA_VERSION ||
      runJson["runId"] !== sourceRunId || runJson["ticketId"] !== row.ticketId ||
      runJson["ticketSha256"] !== row.ticketSha256 || runJson["agentDeclaredDone"] !== true ||
      runJson["artifactPath"] !== runPaths.workspace ||
      held?.["acceptanceSuiteSha256"] !== row.suiteSha256
    ) {
      refusal(409, "gate_recovery_run_record_mismatch", "source DB row and run.json identity do not match exactly");
    }
    if (sha256Hex(row.ticketText) !== row.ticketSha256) {
      refusal(409, "gate_recovery_ticket_mismatch", "stored source ticket text does not match ticketSha256");
    }
    let frozen;
    try {
      frozen = assertSuiteIntact(row.ticketId, { acceptanceRoot: this.#paths.acceptance });
    } catch (error) {
      refusal(409, "gate_recovery_suite_not_intact", describeError(error));
    }
    if (
      frozen.suite.ticketId !== row.ticketId || frozen.suite.ticketSha256 !== row.ticketSha256 ||
      frozen.suite.sha256 !== row.suiteSha256
    ) {
      refusal(409, "gate_recovery_suite_mismatch", "source row, ticket, and frozen suite identity do not match exactly");
    }
    return { row, runPaths, runRecord: runJson as unknown as RunRecord, suite: frozen.suite, workspaceRealPath };
  }

  #assertSourceRootIdentity(source: EligibleSource): void {
    const runsRootRealPath = this.#runsRootRealPath();
    if (lstatSync(source.runPaths.root).isSymbolicLink() ||
      relative(runsRootRealPath, realpathSync(source.runPaths.root)) !== safeSegment(source.row.runId) ||
      lstatSync(source.runPaths.workspace).isSymbolicLink() ||
      realpathSync(source.runPaths.workspace) !== source.workspaceRealPath) {
      refusal(409, "gate_recovery_workspace_identity_changed", "source workspace identity changed during recovery staging");
    }
  }

  #runsRootRealPath(): string {
    if (!existsSync(this.#paths.runs)) {
      refusal(409, "gate_recovery_runs_root_missing", `runs root ${this.#paths.runs} is missing`);
    }
    const stat = lstatSync(this.#paths.runs);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      refusal(409, "gate_recovery_runs_root_unsafe", `runs root ${this.#paths.runs} is not a real directory`);
    }
    return realpathSync(this.#paths.runs);
  }

  async #requireReadiness(): Promise<ReadyGateReadiness> {
    const result = await checkGateReadinessFresh(this.#readiness);
    if (result.state !== "ready") {
      refusal(503, result.state === "unknown" ? "scorer_readiness_unknown" : "scorer_unavailable", result.detail, result.remediation);
    }
    if (result.checkedAt === null || !IMAGE_DIGEST.test(result.scorerImageDigest ?? "")) {
      refusal(503, "scorer_readiness_identity_missing", "fresh readiness did not return an exact scorer image digest");
    }
    return result as ReadyGateReadiness;
  }

  async #stageAndScore(
    recovery: GateRecoveryRow,
    source: EligibleSource,
    readiness: ReadyGateReadiness,
  ): Promise<void> {
    const staging = this.#store.transitionGateRecovery(
      recovery.targetRunId,
      "prepared",
      "staging",
      this.#now().toISOString(),
    );
    if (staging === null) return;
    try {
      const snapshot = this.#stageSnapshot(staging, source, readiness);
      const ready = this.#store.transitionGateRecovery(
        recovery.targetRunId,
        "staging",
        "ready_to_score",
        this.#now().toISOString(),
        { sourceArtifactSha256: snapshot.source.sha256, targetArtifactSha256: snapshot.target.sha256 },
      );
      if (ready === null) return;
      await this.#scoreReady(ready, source, readiness);
    } catch (error) {
      await this.#failRecovery(staging, describeError(error));
    }
  }

  #stageSnapshot(
    recovery: GateRecoveryRow,
    source: EligibleSource,
    readiness: ReadyGateReadiness,
  ): { readonly source: WorkspaceInventory; readonly target: WorkspaceInventory } {
    this.#runsRootRealPath();
    this.#assertSourceRootIdentity(source);
    assertRegularTree(source.runPaths.workspace);
    const targetPaths = runPathsFor(this.#paths, recovery.targetRunId);
    const stageRoot = `${targetPaths.root}.gate-recovery-stage`;
    const stagePaths = { root: stageRoot, workspace: join(stageRoot, "workspace"), results: join(stageRoot, "results") };
    const marker = ownerMarker(recovery);
    const stageMarker = join(stageRoot, GATE_RECOVERY_OWNER_FILE);
    if (existsSync(stageRoot)) {
      if (!markerMatches(stageMarker, marker)) {
        refusal(409, "gate_recovery_staging_not_owned", `existing staging root ${stageRoot} is not owned by this recovery`);
      }
      rmSync(stageRoot, { recursive: true, force: true });
    }
    if (existsSync(targetPaths.root)) {
      refusal(409, "gate_recovery_target_exists", `target root ${targetPaths.root} already exists`);
    }
    mkdirSync(stagePaths.results, { recursive: true });
    writeFileSync(stageMarker, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    this.#stageSource(source, stagePaths.workspace);
    this.#assertSourceRootIdentity(source);
    const afterDir = join(stageRoot, "source-after");
    this.#stageSource(source, afterDir);
    this.#assertSourceRootIdentity(source);
    const sourceBefore = this.#inventory(stagePaths.workspace);
    const sourceAfter = this.#inventory(afterDir);
    if (sourceBefore.sha256 !== sourceAfter.sha256) {
      rmSync(stageRoot, { recursive: true, force: true });
      refusal(409, "gate_recovery_snapshot_changed", "source scorer-visible staging changed between the before and after snapshots");
    }
    rmSync(afterDir, { recursive: true, force: true });
    const reportSource = join(source.runPaths.workspace, WORKSPACE.selfReport);
    const reportTarget = join(stagePaths.workspace, WORKSPACE.selfReport);
    mkdirSync(join(stagePaths.workspace, ".bakeoff"), { recursive: true });
    copyFileSync(reportSource, reportTarget);
    const target = this.#inventory(stagePaths.workspace);
    if (target.sha256 !== sourceBefore.sha256) {
      rmSync(stageRoot, { recursive: true, force: true });
      refusal(409, "gate_recovery_snapshot_changed", "target scorer-visible snapshot changed while provenance was attached");
    }
    const at = this.#now().toISOString();
    const metadata: RecoveryMetadata = {
      protocolVersion: GATE_RECOVERY_PROTOCOL_VERSION,
      kind: "gate-only-recovery",
      sourceRunId: recovery.sourceRunId,
      clientRequestId: recovery.clientRequestId,
      payloadSha256: recovery.payloadSha256,
      targetRunId: recovery.targetRunId,
      ticketId: source.row.ticketId,
      ticketSha256: recovery.ticketSha256,
      suiteSha256: recovery.suiteSha256,
      artifactDigestSemantics: "recovery-time-scorer-visible-snapshot",
      sourceArtifactSha256: sourceBefore.sha256,
      targetArtifactSha256: target.sha256,
      readiness: { checkedAt: readiness.checkedAt, scorerImageDigest: readiness.scorerImageDigest },
      tasteCritic: { status: "not-run", reason: "gate-only recovery makes no model calls" },
      timestamps: { createdAt: recovery.createdAt, snapshotCompletedAt: at, scoringStartedAt: null, completedAt: null },
      state: "ready_to_score",
      terminalError: null,
    };
    writeFileSync(join(stagePaths.results, GATE_RECOVERY_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    renameSync(stageRoot, targetPaths.root);
    return { source: sourceBefore, target };
  }

  #stageSource(source: EligibleSource, stagedDir: string): void {
    const options = defaultScorerGateOptions(
      this.#paths.results,
      this.#paths.acceptance,
      this.#env["BAKEOFF_SCORER_IMAGE"] ?? DEFAULT_SCORER_CONTAINER.imageRef,
    );
    const suiteFileDigests = new Map(
      source.suite.testFiles
        .filter((file) => !file.path.startsWith("visible/"))
        .map((file) => [file.sha256, file.path] as const),
    );
    const report = this.#stageWorkspace({
      artifactDir: source.runPaths.workspace,
      stagedDir,
      excludeAbsolutePaths: [
        source.runPaths.runLog,
        source.runPaths.ledger,
        join(source.runPaths.workspace, WORKSPACE.selfReport),
      ],
      suiteFileDigests,
      maxFiles: options.maxStagedFiles,
      maxBytes: options.maxStagedBytes,
    });
    assertCleanStaging(report);
  }

  #readySnapshotMatches(
    recovery: GateRecoveryRow,
    source: EligibleSource,
    readiness: ReadyGateReadiness,
  ): boolean {
    if (recovery.sourceArtifactSha256 === null || recovery.targetArtifactSha256 === null) return false;
    const targetPaths = runPathsFor(this.#paths, recovery.targetRunId);
    const metadata = readJsonObject(join(targetPaths.results, GATE_RECOVERY_METADATA_FILE));
    const metadataReadiness = exactObject(metadata?.["readiness"]);
    if (
      !markerMatches(join(targetPaths.root, GATE_RECOVERY_OWNER_FILE), ownerMarker(recovery)) ||
      metadata?.["protocolVersion"] !== GATE_RECOVERY_PROTOCOL_VERSION ||
      metadata["sourceRunId"] !== recovery.sourceRunId ||
      metadata["clientRequestId"] !== recovery.clientRequestId ||
      metadata["payloadSha256"] !== recovery.payloadSha256 ||
      metadata["ticketSha256"] !== recovery.ticketSha256 ||
      metadata["suiteSha256"] !== recovery.suiteSha256 ||
      metadata["sourceArtifactSha256"] !== recovery.sourceArtifactSha256 ||
      metadata["targetArtifactSha256"] !== recovery.targetArtifactSha256 ||
      metadataReadiness?.["scorerImageDigest"] !== readiness.scorerImageDigest ||
      this.#inventory(targetPaths.workspace).sha256 !== recovery.targetArtifactSha256
    ) return false;
    return this.#stagedSourceHash(source, recovery.targetRunId) === recovery.sourceArtifactSha256;
  }

  #stagedSourceHash(source: EligibleSource, targetRunId: string): string {
    this.#runsRootRealPath();
    const checkRoot = mkdtempSync(join(this.#paths.runs, `.gate-recovery-check-${safeSegment(targetRunId)}-`));
    try {
      const staged = join(checkRoot, "workspace");
      this.#stageSource(source, staged);
      return this.#inventory(staged).sha256;
    } finally {
      rmSync(checkRoot, { recursive: true, force: true });
    }
  }

  #safeResultsChildDirectory(name: string): string {
    if (!existsSync(this.#paths.results) || lstatSync(this.#paths.results).isSymbolicLink() ||
      !lstatSync(this.#paths.results).isDirectory()) {
      refusal(409, "gate_recovery_results_root_unsafe", `results root ${this.#paths.results} is not a real directory`);
    }
    const resultsRealPath = realpathSync(this.#paths.results);
    const child = join(this.#paths.results, name);
    if (!existsSync(child)) mkdirSync(child);
    if (lstatSync(child).isSymbolicLink() || !lstatSync(child).isDirectory() ||
      relative(resultsRealPath, realpathSync(child)) !== name) {
      refusal(409, "gate_recovery_results_child_unsafe", `results child ${child} is not a real direct-child directory`);
    }
    return child;
  }

  #reserveScorerOutputs(runId: string): readonly ScorerOutputReservation[] {
    const scores = this.#safeResultsChildDirectory("scores");
    const scorerOut = this.#safeResultsChildDirectory("scorer-out");
    const screenshots = this.#safeResultsChildDirectory("screenshots");
    const tamper = this.#safeResultsChildDirectory("tamper");
    // The scorer uses a random mkdtemp child here; validating the parent closes
    // the deterministic symlink target without predicting the random suffix.
    this.#safeResultsChildDirectory("staging");
    const reservations: ScorerOutputReservation[] = [];
    try {
      for (const [suffix, role] of [[".json", "score"], [".container.json", "container"]] as const) {
        const path = join(scores, `${safeSegment(runId)}${suffix}`);
        writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          refusal(409, "gate_recovery_score_output_unsafe", `reserved scorer output ${path} is not a regular file`);
        }
        reservations.push({ path, type: "file", role, dev: stat.dev, ino: stat.ino });
      }
      const tamperPath = join(tamper, `${safeSegment(runId)}.json`);
      writeFileSync(tamperPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      const tamperStat = lstatSync(tamperPath);
      if (tamperStat.isSymbolicLink() || !tamperStat.isFile()) {
        refusal(409, "gate_recovery_score_output_unsafe", `reserved tamper output ${tamperPath} is not a regular file`);
      }
      reservations.push({ path: tamperPath, type: "file", role: "tamper", dev: tamperStat.dev, ino: tamperStat.ino });
      for (const [parent, role] of [[scorerOut, "scorer-out"], [screenshots, "screenshots"]] as const) {
        const path = join(parent, safeSegment(runId));
        mkdirSync(path, { mode: 0o700 });
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          refusal(409, "gate_recovery_score_output_unsafe", `reserved scorer directory ${path} is not a real directory`);
        }
        reservations.push({ path, type: "directory", role, dev: stat.dev, ino: stat.ino });
      }
      return reservations;
    } catch (error) {
      for (const reservation of reservations) {
        if (!existsSync(reservation.path)) continue;
        const stat = lstatSync(reservation.path);
        const sameType = reservation.type === "file" ? stat.isFile() : stat.isDirectory();
        if (!stat.isSymbolicLink() && sameType && stat.dev === reservation.dev && stat.ino === reservation.ino) {
          rmSync(reservation.path, { recursive: reservation.type === "directory", force: true });
        }
      }
      throw error;
    }
  }

  #scorerOutputsStillReserved(reservations: readonly ScorerOutputReservation[]): boolean {
    return reservations.every((reservation) => {
      if (!existsSync(reservation.path)) return false;
      const stat = lstatSync(reservation.path);
      const sameType = reservation.type === "file" ? stat.isFile() : stat.isDirectory();
      return !stat.isSymbolicLink() && sameType && stat.dev === reservation.dev && stat.ino === reservation.ino;
    });
  }

  #removeUnusedTamperReservation(reservations: readonly ScorerOutputReservation[]): void {
    const reservation = reservations.find((entry) => entry.role === "tamper");
    if (reservation === undefined || !directoryEntryExists(reservation.path)) return;
    const stat = lstatSync(reservation.path);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.dev === reservation.dev && stat.ino === reservation.ino &&
      stat.size === 0) {
      rmSync(reservation.path, { force: true });
    }
  }

  async #scoreReady(
    recovery: GateRecoveryRow,
    source: EligibleSource,
    readiness: ReadyGateReadiness,
  ): Promise<void> {
    const targetPaths = this.#ownedWritableTarget(recovery);
    if (targetPaths === null) {
      await this.#failRecovery(recovery, "target ownership changed before scorer preparation");
      return;
    }
    const startedAt = this.#now().toISOString();
    const runRecord = this.#childRunRecord(recovery, source, targetPaths, startedAt);
    writeFileSync(join(targetPaths.results, "run.json"), `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
    writeFileSync(
      targetPaths.runLog,
      "Gate-only recovery: builder/fixer/model/critic/Context7/judge/adversary/publisher were not run.\n" +
        "Taste Critic was explicitly not run because this recovery makes no model calls.\n",
      "utf8",
    );
    const scoring = this.#store.claimGateRecoveryScoring(recovery.targetRunId, startedAt);
    if (scoring === null) return;
    let reservations: readonly ScorerOutputReservation[] = [];
    let score: ScoreRecord;
    try {
      reservations = this.#reserveScorerOutputs(recovery.targetRunId);
      const gate = await this.#makeGate(gateEnv(this.#paths, this.#env));
      score = await gate.score(runRecord, source.suite);
    } catch (error) {
      // A reservation refusal may belong to someone else; only quarantine
      // paths after this controller successfully created both regular files.
      if (reservations.length > 0) this.#quarantineUncertainScore(recovery);
      this.#removeUnusedTamperReservation(reservations);
      const finalizing = this.#store.transitionGateRecovery(
        recovery.targetRunId,
        "scoring",
        "finalizing",
        this.#now().toISOString(),
      );
      if (finalizing !== null) await this.#failRecovery(finalizing, `sealed scorer failed: ${describeError(error)}`);
      return;
    }
    const finalizing = this.#store.transitionGateRecovery(
      recovery.targetRunId,
      "scoring",
      "finalizing",
      this.#now().toISOString(),
    );
    if (finalizing === null) return;
    if (!this.#scorerOutputsStillReserved(reservations)) {
      this.#quarantineUncertainScore(finalizing);
      await this.#failRecovery(finalizing, "reserved scorer output ownership changed during the sealed score call");
      return;
    }
    this.#removeUnusedTamperReservation(reservations);
    const targetHash = this.#inventory(targetPaths.workspace).sha256;
    if (targetHash !== finalizing.targetArtifactSha256) {
      this.#quarantineUncertainScore(finalizing);
      await this.#failRecovery(finalizing, "child scorer-visible workspace changed during the sealed score call");
      return;
    }
    const parsedScore = parsePersistedScore(score);
    if (parsedScore === null ||
      !this.#scoreMatches(parsedScore, finalizing, source.row.ticketId, readiness.scorerImageDigest)) {
      this.#quarantineUncertainScore(finalizing);
      await this.#failRecovery(finalizing, "scorer returned a record whose recovery identity or readiness image digest did not match");
      return;
    }
    await this.#finalizeScore(finalizing, parsedScore);
  }

  #childRunRecord(recovery: GateRecoveryRow, source: EligibleSource, paths: RunPaths, endedAt: string): RunRecord {
    const sourceStarted = Date.parse(recovery.createdAt);
    return {
      ...source.runRecord,
      schemaVersion: BAKEOFF_SCHEMA_VERSION,
      runId: recovery.targetRunId,
      ticketId: source.row.ticketId,
      ticketSha256: recovery.ticketSha256,
      configId: "dashboard-gate-recovery",
      repeatIndex: 0,
      startedAt: recovery.createdAt,
      endedAt,
      wallClockMs: Math.max(0, Date.parse(endedAt) - sourceStarted),
      status: "completed",
      killReason: null,
      agentDeclaredDone: true,
      selfReportPath: join(paths.workspace, WORKSPACE.selfReport),
      usage: [],
      totalCostUsd: 0,
      pricingBasis: [],
      seats: [],
      artifactPath: paths.workspace,
      logPath: paths.runLog,
      ledgerPath: paths.ledger,
      harnessErrors: [],
      heldConstants: { ...source.runRecord.heldConstants, acceptanceSuiteSha256: recovery.suiteSha256 },
    };
  }

  #scoreMatches(
    score: ScoreRecord,
    recovery: GateRecoveryRow,
    expectedTicketId: string,
    readinessImageDigest: string,
  ): boolean {
    const expectedCriteria = new Map(
      this.#store.listCriteria(recovery.targetRunId).map((criterion) => [criterion.id, criterion.tier] as const),
    );
    const scoredCriteria = new Map(score.criteriaResults.map((criterion) => [criterion.criterionId, criterion.tier] as const));
    const unique = scoredCriteria.size === score.criteriaResults.length;
    const frozenComplete = [...expectedCriteria].every(([id, tier]) => scoredCriteria.get(id) === tier);
    const machineComplete = ALL_GATE_IDS.every((id) => scoredCriteria.get(id) === "BLOCKING");
    const allowed = score.criteriaResults.every((criterion) => {
      if (expectedCriteria.has(criterion.criterionId)) return expectedCriteria.get(criterion.criterionId) === criterion.tier;
      if (criterion.criterionId.startsWith(GATE_ID_PREFIX)) {
        return ALL_GATE_IDS.includes(criterion.criterionId) && criterion.tier === "BLOCKING";
      }
      return criterion.criterionId.startsWith("QUALITY:") && criterion.criterionId.length > "QUALITY:".length &&
        criterion.tier === "QUALITY";
    });
    return score.runId === recovery.targetRunId && score.ticketId === expectedTicketId &&
      score.acceptanceSuiteSha256 === recovery.suiteSha256 && score.agentDeclaredDone &&
      computeHeldOutPass(score.criteriaResults, score.protectedPathViolations) === score.heldOutPass &&
      deriveFalseFinish(score.agentDeclaredDone, score.heldOutPass) === score.falseFinish &&
      score.scorerImageDigest === readinessImageDigest && unique && frozenComplete && machineComplete && allowed;
  }

  async #finalizeScore(recovery: GateRecoveryRow, score: ScoreRecord): Promise<void> {
    const paths = this.#ownedWritableTarget(recovery);
    if (paths === null) {
      this.#quarantineUncertainScore(recovery);
      await this.#failRecovery(recovery, "target ownership changed before score finalization");
      return;
    }
    const container = readContainer(this.#paths, recovery.targetRunId);
    const results = new Map(score.criteriaResults.map((criterion) => [criterion.criterionId, criterion] as const));
    const storedCriteria = this.#store.listCriteria(recovery.targetRunId);
    if (storedCriteria.some((criterion) => !results.has(criterion.id))) {
      this.#quarantineUncertainScore(recovery);
      await this.#failRecovery(recovery, "score record omitted one or more frozen acceptance criteria");
      return;
    }
    const criteria = storedCriteria.map((criterion) => {
      const result = results.get(criterion.id);
      return { ...criterion, result: result?.passed === true ? "pass" as const : "fail" as const };
    });
    const endedAt = this.#now().toISOString();
    const failureReason = score.heldOutPass ? null : "the frozen held-out suite did not go green in gate-only recovery";
    const verdictPath = writeRunVerdict(paths.results, {
      ticketText: this.#store.getRun(recovery.targetRunId)?.ticketText ?? "",
      criteria,
      status: score.heldOutPass ? "passed" : "failed",
      failureReason,
    });
    this.#writeTerminalMetadata(recovery, "completed", endedAt, failureReason);
    const screenshots = (container?.screenshots ?? []).filter((shot) => shot.nonBlank).map((shot) => ({
      path: join(this.#paths.results, "screenshots", recovery.targetRunId, shot.file),
      label: `${shot.flowId} @ ${shot.breakpoint}`,
      capturedAt: container?.endedAt ?? endedAt,
    }));
    this.#store.finalizeGateRecovery({
      targetRunId: recovery.targetRunId,
      state: "completed",
      endedAt,
      status: score.heldOutPass ? "passed" : "failed",
      heldOutPass: score.heldOutPass,
      falseFinish: score.falseFinish,
      failureReason,
      verdictPath,
      gateStopReason: score.heldOutPass ? "green" : "not-converging",
      criteria: storedCriteria.map((criterion) => {
        const scored = results.get(criterion.id);
        if (scored === undefined) throw new Error(`validated score lost frozen criterion ${criterion.id}`);
        return {
          criterionId: criterion.id,
          result: scored.passed ? "pass" : "fail",
          detail: scored.detail,
        };
      }),
      screenshots,
    });
  }

  async #failRecovery(recovery: GateRecoveryRow, detail: string): Promise<void> {
    let current = this.#store.gateRecoveryForTarget(recovery.targetRunId);
    if (current === null || current.state === "completed" || current.state === "infra_failed") return;
    if (current.state !== "finalizing") {
      current = this.#store.transitionGateRecovery(
        current.targetRunId,
        current.state,
        "finalizing",
        this.#now().toISOString(),
      );
      if (current === null) return;
    }
    const paths = this.#ownedWritableTarget(current);
    const endedAt = this.#now().toISOString();
    const failure = `gate-only recovery infrastructure failure: ${detail}`;
    const row = this.#store.getRun(current.targetRunId);
    const verdictPath = paths === null ? null : writeRunVerdict(paths.results, {
        ticketText: row?.ticketText ?? "",
        criteria: this.#store.listCriteria(current.targetRunId),
        status: "failed",
        failureReason: failure,
      });
    if (paths !== null) this.#writeTerminalMetadata(current, "infra_failed", endedAt, failure);
    this.#store.finalizeGateRecovery({
      targetRunId: current.targetRunId,
      state: "infra_failed",
      endedAt,
      status: "failed",
      heldOutPass: null,
      falseFinish: null,
      failureReason: failure,
      verdictPath,
      gateStopReason: "infra",
      criteria: [],
      screenshots: [],
    });
  }

  #ownedWritableTarget(recovery: GateRecoveryRow): RunPaths | null {
    const paths = runPathsFor(this.#paths, recovery.targetRunId);
    const runsRootRealPath = this.#runsRootRealPath();
    const marker = ownerMarker(recovery);
    if (!existsSync(paths.root)) {
      try {
        mkdirSync(paths.root);
        writeFileSync(
          join(paths.root, GATE_RECOVERY_OWNER_FILE),
          `${JSON.stringify(marker, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch {
        return null;
      }
    }
    if (lstatSync(paths.root).isSymbolicLink() ||
      relative(runsRootRealPath, realpathSync(paths.root)) !== safeSegment(recovery.targetRunId) ||
      !markerMatches(join(paths.root, GATE_RECOVERY_OWNER_FILE), marker) ||
      (existsSync(paths.results) && lstatSync(paths.results).isSymbolicLink()) ||
      (existsSync(paths.workspace) && lstatSync(paths.workspace).isSymbolicLink())) return null;
    mkdirSync(paths.results, { recursive: true });
    return paths;
  }

  #writeTerminalMetadata(
    recovery: GateRecoveryRow,
    state: "completed" | "infra_failed",
    completedAt: string,
    terminalError: string | null,
  ): void {
    const paths = runPathsFor(this.#paths, recovery.targetRunId);
    const path = join(paths.results, GATE_RECOVERY_METADATA_FILE);
    const current = readJsonObject(path) ?? {};
    const timestamps = exactObject(current["timestamps"]) ?? {};
    const metadata = {
      ...current,
      state,
      terminalError,
      timestamps: { ...timestamps, scoringStartedAt: recovery.scoringStartedAt, completedAt },
    };
    writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  async #resumeAfterBoot(recovery: GateRecoveryRow): Promise<void> {
    if (recovery.state === "scoring" || recovery.state === "finalizing") {
      const target = this.#store.getRun(recovery.targetRunId);
      const metadata = readJsonObject(join(runPathsFor(this.#paths, recovery.targetRunId).results, GATE_RECOVERY_METADATA_FILE));
      const readiness = exactObject(metadata?.["readiness"]);
      const score = target === null ? null : readMatchingScore(this.#paths, recovery);
      let finalizing = recovery;
      if (recovery.state === "scoring") {
        finalizing = this.#store.transitionGateRecovery(
          recovery.targetRunId,
          "scoring",
          "finalizing",
          this.#now().toISOString(),
        ) ?? recovery;
      }
      const runJson = readJsonObject(join(runPathsFor(this.#paths, recovery.targetRunId).results, "run.json"));
      const targetPaths = runPathsFor(this.#paths, recovery.targetRunId);
      const targetHash = recovery.targetArtifactSha256 !== null && existsSync(targetPaths.workspace)
        ? this.#inventory(targetPaths.workspace).sha256
        : null;
      const imageDigest = String(readiness?.["scorerImageDigest"] ?? "");
      const valid = score !== null && target !== null &&
        targetHash === recovery.targetArtifactSha256 &&
        this.#scoreMatches(score, recovery, target.ticketId, imageDigest) &&
        runJson?.["runId"] === recovery.targetRunId && runJson["ticketSha256"] === recovery.ticketSha256 &&
        runJson["artifactPath"] === targetPaths.workspace;
      if (!valid || score === null) {
        this.#quarantineUncertainScore(recovery);
        await this.#failRecovery(finalizing, "the process stopped after scoring began and no valid matching score record exists");
      } else {
        await this.#finalizeScore(finalizing, score);
      }
      return;
    }
    if (recovery.state === "ready_to_score") {
      const source = this.#eligibleSource(recovery.sourceRunId);
      const readiness = await this.#requireReadiness();
      if (!this.#readySnapshotMatches(recovery, source, readiness)) {
        await this.#failRecovery(
          recovery,
          "ready-to-score recovery ownership, identity, readiness image, or scorer-visible snapshot no longer matches",
        );
        return;
      }
      await this.#scoreReady(recovery, source, readiness);
      return;
    }
    if (recovery.state === "prepared" || recovery.state === "staging") {
      const source = this.#eligibleSource(recovery.sourceRunId);
      const readiness = await this.#requireReadiness();
      if (recovery.state === "staging") {
        const targetPaths = runPathsFor(this.#paths, recovery.targetRunId);
        const marker = ownerMarker(recovery);
        const metadata = readJsonObject(join(targetPaths.results, GATE_RECOVERY_METADATA_FILE));
        const sourceHash = metadata?.["sourceArtifactSha256"];
        const targetHash = metadata?.["targetArtifactSha256"];
        if (
          markerMatches(join(targetPaths.root, GATE_RECOVERY_OWNER_FILE), marker) &&
          DIGEST.test(String(sourceHash ?? "")) && sourceHash === targetHash &&
          this.#stagedSourceHash(source, recovery.targetRunId) === sourceHash &&
          this.#inventory(targetPaths.workspace).sha256 === targetHash
        ) {
          const ready = this.#store.transitionGateRecovery(
            recovery.targetRunId,
            "staging",
            "ready_to_score",
            this.#now().toISOString(),
            { sourceArtifactSha256: String(sourceHash), targetArtifactSha256: String(targetHash) },
          );
          if (ready !== null) await this.#scoreReady(ready, source, readiness);
          return;
        }
        // A staging crash may be retried only after proving and cleaning our own temp root.
        const stageRoot = `${targetPaths.root}.gate-recovery-stage`;
        if (existsSync(stageRoot)) {
          if (!markerMatches(join(stageRoot, GATE_RECOVERY_OWNER_FILE), marker)) {
            await this.#failRecovery(recovery, "staging root exists without this recovery's ownership marker");
            return;
          }
          rmSync(stageRoot, { recursive: true, force: true });
        }
        const prepared = this.#store.transitionGateRecovery(
          recovery.targetRunId,
          "staging",
          "prepared",
          this.#now().toISOString(),
        );
        if (prepared === null) return;
        await this.#stageAndScore(prepared, source, readiness);
        return;
      }
      await this.#stageAndScore(recovery, source, readiness);
    }
  }

  #quarantineUncertainScore(recovery: GateRecoveryRow): void {
    let scores: string;
    try {
      scores = this.#safeResultsChildDirectory("scores");
    } catch {
      return;
    }
    const quarantine = join(scores, "recovery-uncertain");
    if (!existsSync(quarantine)) {
      try { mkdirSync(quarantine); } catch { return; }
    }
    if (lstatSync(quarantine).isSymbolicLink() || !lstatSync(quarantine).isDirectory() ||
      relative(realpathSync(scores), realpathSync(quarantine)) !== "recovery-uncertain") return;
    const runId = safeSegment(recovery.targetRunId);
    const owned = join(quarantine, runId);
    if (!existsSync(owned)) {
      try {
        mkdirSync(owned);
        writeFileSync(
          join(owned, GATE_RECOVERY_OWNER_FILE),
          `${JSON.stringify(ownerMarker(recovery), null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch { return; }
    }
    if (lstatSync(owned).isSymbolicLink() || !lstatSync(owned).isDirectory() ||
      relative(realpathSync(quarantine), realpathSync(owned)) !== runId ||
      !markerMatches(join(owned, GATE_RECOVERY_OWNER_FILE), ownerMarker(recovery))) return;
    for (const suffix of [".json", ".container.json"]) {
      const source = join(scores, `${runId}${suffix}`);
      if (!existsSync(source)) continue;
      const stat = lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const target = join(owned, `${runId}${suffix}`);
      if (directoryEntryExists(target)) continue;
      try { renameSync(source, target); } catch { /* best-effort quarantine; DB still records no verdict */ }
    }
  }

  #response(recovery: GateRecoveryRow, replayed: boolean): GateRecoveryResponse {
    const target = this.#store.getRun(recovery.targetRunId);
    if (target === null) throw new Error(`gate recovery target ${recovery.targetRunId} is missing`);
    return {
      sourceRunId: recovery.sourceRunId,
      targetRunId: recovery.targetRunId,
      recoveryState: recovery.state,
      status: target.status,
      heldOutPass: target.heldOutPass,
      falseFinish: target.falseFinish,
      replayed,
      tasteCritic: "not_run_gate_only",
    };
  }
}

/** Public validation shared by the API route and direct callers. */
export function validateGateRecoveryRequest(value: unknown): GateRecoveryRequest {
  const body = exactObject(value);
  if (body === null || Object.keys(body).length !== 1 || !("clientRequestId" in body)) {
    refusal(400, "invalid_body", "body must contain exactly clientRequestId");
  }
  const id = body["clientRequestId"];
  if (
    typeof id !== "string" || id.trim() !== id || id.length < 1 ||
    id.length > MAX_GATE_RECOVERY_CLIENT_REQUEST_ID || !/^[A-Za-z0-9._:-]+$/.test(id)
  ) {
    refusal(400, "invalid_client_request_id", "clientRequestId must be 1..128 characters from [A-Za-z0-9._:-]");
  }
  return { clientRequestId: id, payloadSha256: sha256Hex(canonicalJson({ clientRequestId: id })) };
}

/** Structural invariant used by tests: recovery targets are never ordinary resumable runs. */
export function gateRecoveryTargetIsTerminalOrControllerOwned(store: RunStore, runId: string): boolean {
  const row = store.getRun(runId);
  return row !== null && store.isGateRecoveryTarget(runId) && (isTerminal(row.status) || row.status === "running");
}
