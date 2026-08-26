/** Controller-owned recovery for terminal WEB creative artifact-contract failures. */

import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ENVIRONMENT_FILE } from "./build-environment.js";
import { canonicalJson, sha256Hex } from "./creative-contract.js";
import {
  CREATIVE_AUTHOR_FILE,
  CREATIVE_COMPILE_FILE,
  CREATIVE_CONTRACT_FILE,
  CREATIVE_STATUS_FILE,
  hashCreativeArtifact,
  readCreativePilotStatus,
  writeCreativePilotStatus,
} from "./creative-pilot.js";
import type { CreativePilotStatus } from "./creative-pilot.js";
import type { CreativeReviewStopReason } from "./creative-review-loop.js";
import type { StopReason } from "./gate-fix-loop.js";
import type { RunRow, RunStore } from "./db.js";
import { isTerminal } from "./db.js";
import { GateRecoveryRefusal, inventoryScorerVisibleWorkspace } from "./gate-recovery.js";
import { runPathsFor } from "./paths.js";
import type { DashboardPaths } from "./paths.js";
import { copyContinuationReferences } from "./run-continuation.js";
import { readReferenceManifest, writeReferenceManifest } from "./ticket-refs.js";

export const CREATIVE_RECOVERY_PROTOCOL_VERSION = 2 as const;
export const CREATIVE_RECOVERY_FILE = "creative-recovery.json";
export const CREATIVE_RECOVERY_OWNER_FILE = ".creative-recovery-owner.json";
export const CREATIVE_RECOVERY_WORKER_STARTED_FILE = ".creative-recovery-worker-started.json";
export const MAX_CREATIVE_RECOVERY_CLIENT_REQUEST_ID = 128;

const HASH = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]+$/u;
const COPY_RESULTS = [CREATIVE_CONTRACT_FILE, CREATIVE_AUTHOR_FILE, CREATIVE_COMPILE_FILE, ENVIRONMENT_FILE] as const;
const GATE_STOP_REASONS = new Set<StopReason>(["green", "retry-cap", "not-converging", "infra", "cancelled", "artifact-contract"]);
const REVIEW_STOP_REASONS = new Set<Exclude<CreativeReviewStopReason, null>>([
  "accepted", "functional_red", "compiler_red", "prerequisite_unknown", "artifact_contract",
  "critic_unavailable", "repeated_tree_and_findings", "attempts_exhausted", "invalid_attempt",
]);

export interface TerminalCreativeRecoveryRequest {
  readonly clientRequestId: string;
  readonly contractHash: string;
}

export interface TerminalCreativeRecoveryWork {
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly contractHash: string;
  readonly resolvedModelId: string;
}

export interface TerminalCreativeRecoveryWorkResult {
  readonly terminalStatus: "passed" | "failed";
  readonly heldOutPass: boolean | null;
  readonly falseFinish: boolean | null;
  readonly failureReason: string | null;
  readonly artifactHashBeforeMutation: string;
  readonly artifactHashAfterMutation: string;
  readonly renderManifestHash: string | null;
  readonly criticDisposition: "accept" | "revise" | "unavailable" | null;
  readonly criticAttempt: number | null;
  readonly iteration: number | null;
  readonly reviewStopReason: CreativeReviewStopReason;
  readonly gateAttempts: number;
  readonly gateStopReason: StopReason;
}

export interface TerminalCreativeRecoveryResponse extends TerminalCreativeRecoveryWorkResult {
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly contractHash: string;
  readonly resolvedModelId: string;
  readonly state: "completed";
  readonly replayed: boolean;
}

interface RecoveryRecord extends Omit<TerminalCreativeRecoveryResponse, "state" | "replayed"> {
  readonly protocolVersion: typeof CREATIVE_RECOVERY_PROTOCOL_VERSION;
  readonly state: "finalizing" | "completed";
  readonly payloadSha256: string;
  readonly createdAt: string;
  readonly completedAt: string;
}

export interface TerminalCreativeRecoveryControllerOptions {
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  readonly run: (work: TerminalCreativeRecoveryWork) => Promise<TerminalCreativeRecoveryWorkResult>;
  readonly now?: () => Date;
}

export class TerminalCreativeRecoveryRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly remediation: string | null;

  constructor(status: number, code: string, message: string, remediation: string | null = null) {
    super(message);
    this.name = "TerminalCreativeRecoveryRefusal";
    this.status = status;
    this.code = code;
    this.remediation = remediation;
  }
}

function refuse(status: number, code: string, message: string, remediation: string | null = null): never {
  throw new TerminalCreativeRecoveryRefusal(status, code, message, remediation);
}

export function validateTerminalCreativeRecoveryRequest(value: unknown): TerminalCreativeRecoveryRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(400, "invalid_creative_recovery_request", "creative recovery requires a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "clientRequestId" && key !== "contractHash");
  if (unknown.length > 0) refuse(400, "unknown_creative_recovery_field", `unknown field: ${unknown[0] ?? "unknown"}`);
  const clientRequestId = record["clientRequestId"];
  const contractHash = record["contractHash"];
  if (
    typeof clientRequestId !== "string" || clientRequestId.length === 0 ||
    clientRequestId.length > MAX_CREATIVE_RECOVERY_CLIENT_REQUEST_ID || !REQUEST_ID.test(clientRequestId)
  ) {
    refuse(400, "invalid_creative_recovery_request_id", "clientRequestId must be 1-128 URL-safe characters");
  }
  if (typeof contractHash !== "string" || !HASH.test(contractHash)) {
    refuse(400, "invalid_creative_recovery_contract_hash", "contractHash must be a lowercase SHA-256 digest");
  }
  return { clientRequestId, contractHash };
}

export function terminalCreativeRecoveryRunId(sourceRunId: string, request: TerminalCreativeRecoveryRequest): string {
  const digest = createHash("sha256")
    // The idempotency key owns one identity independent of the payload. A
    // changed contractHash must conflict, not mint a second child.
    .update(`${sourceRunId}\n${request.clientRequestId}`)
    .digest("hex")
    .slice(0, 20);
  return `run-creative-recovery-${digest}`;
}

function payloadSha256(request: TerminalCreativeRecoveryRequest): string {
  return sha256Hex(canonicalJson(request));
}

function readRecord(path: string): RecoveryRecord | null {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const nullableHash = (item: unknown): item is string | null => item === null || (typeof item === "string" && HASH.test(item));
    const nullableInteger = (item: unknown): item is number | null => item === null || (typeof item === "number" && Number.isInteger(item) && item >= 0);
    const nullableDisposition = (item: unknown): boolean => item === null || item === "accept" || item === "revise" || item === "unavailable";
    const nullableStop = (item: unknown): boolean => item === null || (typeof item === "string" && REVIEW_STOP_REASONS.has(item as Exclude<CreativeReviewStopReason, null>));
    if (
      value["protocolVersion"] !== CREATIVE_RECOVERY_PROTOCOL_VERSION ||
      (value["state"] !== "finalizing" && value["state"] !== "completed") ||
      typeof value["sourceRunId"] !== "string" || typeof value["targetRunId"] !== "string" ||
      typeof value["contractHash"] !== "string" || !HASH.test(value["contractHash"]) ||
      typeof value["resolvedModelId"] !== "string" || value["resolvedModelId"].length === 0 ||
      typeof value["payloadSha256"] !== "string" || !HASH.test(value["payloadSha256"]) ||
      typeof value["createdAt"] !== "string" || !Number.isFinite(Date.parse(value["createdAt"])) ||
      typeof value["completedAt"] !== "string" || !Number.isFinite(Date.parse(value["completedAt"])) ||
      (value["terminalStatus"] !== "passed" && value["terminalStatus"] !== "failed") ||
      (value["heldOutPass"] !== null && typeof value["heldOutPass"] !== "boolean") ||
      (value["falseFinish"] !== null && typeof value["falseFinish"] !== "boolean") ||
      (value["failureReason"] !== null && typeof value["failureReason"] !== "string") ||
      typeof value["artifactHashBeforeMutation"] !== "string" || !HASH.test(value["artifactHashBeforeMutation"]) ||
      typeof value["artifactHashAfterMutation"] !== "string" || !HASH.test(value["artifactHashAfterMutation"]) ||
      !nullableHash(value["renderManifestHash"]) || !nullableDisposition(value["criticDisposition"]) ||
      !nullableInteger(value["criticAttempt"]) || !nullableInteger(value["iteration"]) || !nullableStop(value["reviewStopReason"]) ||
      typeof value["gateAttempts"] !== "number" || !Number.isInteger(value["gateAttempts"]) || value["gateAttempts"] < 0 ||
      typeof value["gateStopReason"] !== "string" || !GATE_STOP_REASONS.has(value["gateStopReason"] as StopReason)
    ) return null;
    return value as unknown as RecoveryRecord;
  } catch {
    return null;
  }
}

function atomicRecord(path: string, value: RecoveryRecord): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

interface RecoveryOwnerMarker {
  readonly protocolVersion: typeof CREATIVE_RECOVERY_PROTOCOL_VERSION;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly clientRequestId: string;
  readonly payloadSha256: string;
  readonly resolvedModelId: string;
}

function readOwnerMarker(path: string): RecoveryOwnerMarker | null {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      parsed["protocolVersion"] !== CREATIVE_RECOVERY_PROTOCOL_VERSION ||
      typeof parsed["sourceRunId"] !== "string" || typeof parsed["targetRunId"] !== "string" ||
      typeof parsed["clientRequestId"] !== "string" || typeof parsed["payloadSha256"] !== "string" ||
      typeof parsed["resolvedModelId"] !== "string" || parsed["resolvedModelId"].length === 0 ||
      !HASH.test(parsed["payloadSha256"])
    ) return null;
    return parsed as unknown as RecoveryOwnerMarker;
  } catch { return null; }
}

function resolvedSourceModel(results: string, source: RunRow): string {
  const path = join(results, ENVIRONMENT_FILE);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    refuse(409, "creative_recovery_resolved_model_unavailable", "the source has no regular frozen environment record naming its resolved builder model");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { refuse(409, "creative_recovery_resolved_model_unavailable", "the source environment record is unreadable"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(409, "creative_recovery_resolved_model_unavailable", "the source environment record has an invalid shape");
  }
  const model = (parsed as Record<string, unknown>)["model"];
  const sessionId = (parsed as Record<string, unknown>)["sessionId"];
  if (typeof model !== "string" || model.trim().length === 0 || model.length > 256) {
    refuse(409, "creative_recovery_resolved_model_unavailable", "the source environment record does not name a bounded resolved model");
  }
  if (source.builderSessionId === null || sessionId !== source.builderSessionId) {
    refuse(409, "creative_recovery_resolved_model_mismatch", "the source environment record is not bound to its terminal builder session");
  }
  return model;
}

function sanitizedRecoveryStatus(source: CreativePilotStatus, updatedAt: string): CreativePilotStatus {
  return {
    ...source,
    renderManifestHash: null,
    renderFresh: null,
    renderProfiles: null,
    criticDisposition: null,
    criticFindings: [],
    criticAttempt: null,
    reviewState: "reviewing",
    reviewStopReason: null,
    ownerDecision: null,
    ownerDecisionReason: null,
    ownerDecisionTargetRunId: null,
    heldOutPass: null,
    updatedAt,
  };
}

function assertContractBinding(results: string, expectedHash: string): void {
  let authored: unknown;
  let contract: unknown;
  try {
    authored = JSON.parse(readFileSync(join(results, CREATIVE_AUTHOR_FILE), "utf8")) as unknown;
    contract = JSON.parse(readFileSync(join(results, CREATIVE_CONTRACT_FILE), "utf8")) as unknown;
  } catch {
    refuse(409, "creative_recovery_contract_unavailable", "the source has no readable frozen creative contract");
  }
  const authoredHash = typeof authored === "object" && authored !== null
    ? (authored as Record<string, unknown>)["contractHash"]
    : null;
  const actualHash = sha256Hex(canonicalJson(contract));
  if (authoredHash !== expectedHash || actualHash !== expectedHash) {
    refuse(
      409,
      "creative_recovery_contract_mismatch",
      "the requested contract hash does not exactly bind both the frozen author record and canonical contract",
    );
  }
}

function eligibleSource(store: RunStore, paths: DashboardPaths, sourceRunId: string, request: TerminalCreativeRecoveryRequest): RunRow {
  const source = store.getRun(sourceRunId);
  if (source === null) refuse(404, "creative_recovery_source_not_found", `run ${sourceRunId} was not found`);
  if (!isTerminal(source.status)) {
    refuse(409, "creative_recovery_source_not_terminal", "creative recovery is available only for a terminal source run");
  }
  if (source.heldOutPass !== true || source.suiteSha256 === null || source.artifactPath === null) {
    refuse(409, "creative_recovery_source_not_green", "the source must retain a green held-out verdict and frozen suite lineage");
  }
  const sourcePaths = runPathsFor(paths, sourceRunId);
  assertRegularTree(sourcePaths.workspace, "source workspace");
  for (const file of COPY_RESULTS) assertRegularFile(join(sourcePaths.results, file), `source results/${file}`);
  const creative = readCreativePilotStatus(sourcePaths.results);
  if (creative === null || !creative.enabled || !creative.applicable) {
    refuse(409, "creative_recovery_not_applicable", "the source has no applicable enabled WEB creative pilot record");
  }
  if (creative.contractHash !== request.contractHash || creative.compile.outcome !== "passed") {
    refuse(409, "creative_recovery_contract_mismatch", "the source creative status is not green for the requested frozen contract");
  }
  if (creative.criticAttempt !== null || creative.criticDisposition !== null) {
    refuse(409, "creative_recovery_prior_critic_unsupported", "this recovery slice supports failures before the first critic attempt only");
  }
  if (creative.reviewStopReason !== "artifact_contract" && !(
    creative.reviewStopReason === "critic_unavailable" && hasLegacyDeterministicMarkerConflict(sourcePaths.workspace, sourcePaths.results)
  )) {
    refuse(409, "creative_recovery_failure_class_unsupported", `unsupported creative stop reason: ${creative.reviewStopReason ?? "none"}`);
  }
  assertContractBinding(sourcePaths.results, request.contractHash);
  return source;
}

/** Admit legacy misclassified STATIC failures only when exact marker evidence exists on disk. */
function hasLegacyDeterministicMarkerConflict(workspace: string, results: string): boolean {
  if (!existsSync(join(workspace, "index.html"))) return false;
  let contract: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(join(results, CREATIVE_CONTRACT_FILE), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    contract = parsed as Record<string, unknown>;
  } catch { return false; }
  const ids = (key: "routes" | "sections" | "motion"): readonly string[] => {
    const values = contract[key];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const id = (value as Record<string, unknown>)["id"];
      return typeof id === "string" ? [id] : [];
    });
  };
  const inventory = inventorySource(workspace);
  const text = inventory.entries
    .filter((entry) => entry.type === "file" && (entry.bytes ?? 0) <= 2_000_000)
    .flatMap((entry) => {
      try { return [readFileSync(join(workspace, entry.path), "utf8")]; } catch { return []; }
    })
    .join("\n");
  const bindings = [
    ...ids("routes").map((id) => ["data-creative-route", id] as const),
    ...ids("sections").map((id) => ["data-creative-section", id] as const),
    ...ids("motion").map((id) => ["data-motion-id", id] as const),
  ];
  const hasAnyMarker = /data-(?:creative-(?:route|section)|motion-id)=["'][^"']+["']/u.test(text);
  return hasAnyMarker && bindings.some(([attribute, id]) =>
    !text.includes(`${attribute}="${id}"`) && !text.includes(`${attribute}='${id}'`));
}

export function isTerminalCreativeRecoveryTarget(paths: DashboardPaths, runId: string): boolean {
  const marker = join(runPathsFor(paths, runId).results, CREATIVE_RECOVERY_OWNER_FILE);
  return existsSync(marker) && !lstatSync(marker).isSymbolicLink() && lstatSync(marker).isFile();
}

function inventorySource(workspace: string): ReturnType<typeof inventoryScorerVisibleWorkspace> {
  try {
    return inventoryScorerVisibleWorkspace(workspace);
  } catch (error) {
    if (error instanceof GateRecoveryRefusal) {
      refuse(error.status, error.code, error.message, error.remediation);
    }
    throw error;
  }
}

function assertRegularTree(directory: string, label: string): void {
  let root;
  try { root = lstatSync(directory); }
  catch { refuse(409, "creative_recovery_source_tree_unsupported", `${label} is missing or unreadable`); }
  if (root.isSymbolicLink()) {
    refuse(409, "creative_recovery_symlink_refused", `${label} is a symbolic link`);
  }
  if (!root.isDirectory()) {
    refuse(409, "creative_recovery_source_tree_unsupported", `${label} is not a directory`);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      refuse(409, "creative_recovery_symlink_refused", `${label}/${entry.name} is a symbolic link`);
    }
    if (entry.isDirectory()) assertRegularTree(path, `${label}/${entry.name}`);
    else if (!entry.isFile()) {
      refuse(409, "creative_recovery_source_tree_unsupported", `${label}/${entry.name} is not a regular file or directory`);
    }
  }
}

function assertRegularFile(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch { refuse(409, "creative_recovery_source_tree_unsupported", `${label} is missing or unreadable`); }
  if (stat.isSymbolicLink()) {
    refuse(409, "creative_recovery_symlink_refused", `${label} is a symbolic link`);
  }
  if (!stat.isFile()) {
    refuse(409, "creative_recovery_source_tree_unsupported", `${label} is not a regular file`);
  }
}

export class TerminalCreativeRecoveryController {
  readonly #store: RunStore;
  readonly #paths: DashboardPaths;
  readonly #run: TerminalCreativeRecoveryControllerOptions["run"];
  readonly #now: () => Date;
  readonly #active = new Map<string, {
    readonly payloadSha256: string;
    readonly promise: Promise<TerminalCreativeRecoveryResponse>;
  }>();
  #activeRecoveryKey: string | null = null;

  constructor(options: TerminalCreativeRecoveryControllerOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#run = options.run;
    this.#now = options.now ?? (() => new Date());
  }

  async recover(sourceRunId: string, request: TerminalCreativeRecoveryRequest): Promise<TerminalCreativeRecoveryResponse> {
    const key = `${sourceRunId}\u0000${request.clientRequestId}`;
    const digest = payloadSha256(request);
    const current = this.#active.get(key);
    if (current !== undefined) {
      if (current.payloadSha256 !== digest) {
        refuse(409, "creative_recovery_idempotency_conflict", "the active recovery idempotency key is owned by a different payload");
      }
      return { ...(await current.promise), replayed: true };
    }
    if (this.#activeRecoveryKey !== null) {
      refuse(
        409,
        "creative_recovery_busy",
        "another controller-owned creative recovery is already in flight",
        "Replay the active request or wait for it to finish before choosing a different recovery identity.",
      );
    }
    const work = this.#recover(sourceRunId, request);
    this.#active.set(key, { payloadSha256: digest, promise: work });
    this.#activeRecoveryKey = key;
    try {
      return await work;
    } finally {
      this.#active.delete(key);
      if (this.#activeRecoveryKey === key) this.#activeRecoveryKey = null;
    }
  }

  async #recover(sourceRunId: string, request: TerminalCreativeRecoveryRequest): Promise<TerminalCreativeRecoveryResponse> {
    const targetRunId = terminalCreativeRecoveryRunId(sourceRunId, request);
    const targetPaths = runPathsFor(this.#paths, targetRunId);
    const recordPath = join(targetPaths.results, CREATIVE_RECOVERY_FILE);
    const digest = payloadSha256(request);
    const durable = readRecord(recordPath);
    if (durable !== null) {
      if (durable.sourceRunId !== sourceRunId || durable.payloadSha256 !== digest || durable.contractHash !== request.contractHash) {
        refuse(409, "creative_recovery_idempotency_conflict", "the deterministic recovery identity is owned by a different payload");
      }
      return this.#finishDurableRecord(durable, true, targetRunId, digest);
    }
    const source = eligibleSource(this.#store, this.#paths, sourceRunId, request);
    const sourcePaths = runPathsFor(this.#paths, sourceRunId);
    const resolvedModelId = resolvedSourceModel(sourcePaths.results, source);
    const sourceCreative = readCreativePilotStatus(sourcePaths.results);
    if (sourceCreative === null) {
      refuse(409, "creative_recovery_status_unavailable", "the source creative status became unavailable before staging");
    }
    let staged = false;
    const existingTarget = this.#store.getRun(targetRunId);
    if (existsSync(targetPaths.root)) {
      const marker = readOwnerMarker(join(targetPaths.results, CREATIVE_RECOVERY_OWNER_FILE));
      if (
        marker === null || marker.sourceRunId !== sourceRunId || marker.targetRunId !== targetRunId ||
        marker.clientRequestId !== request.clientRequestId || marker.payloadSha256 !== digest ||
        marker.resolvedModelId !== resolvedModelId
      ) {
        refuse(409, "creative_recovery_idempotency_conflict", "the deterministic target is not owned by this exact recovery payload");
      }
      if (existingTarget !== null) {
        const workerStarted = existsSync(join(targetPaths.results, CREATIVE_RECOVERY_WORKER_STARTED_FILE));
        const attempts = this.#store.listAttempts(targetRunId);
        const attemptSafe = attempts.length === 0 || (attempts.length === 1 && attempts[0]?.endedAt === null);
        const preparable = !workerStarted && !isTerminal(existingTarget.status) &&
          attemptSafe &&
          existingTarget.ticketId === source.ticketId && existingTarget.ticketSha256 === source.ticketSha256 &&
          existingTarget.modelId === source.modelId && existingTarget.provider === source.provider &&
          existingTarget.builderSessionId === null && existingTarget.gateAttempts === 0 &&
          (existingTarget.artifactPath === null || existingTarget.artifactPath === targetPaths.workspace) &&
          (existingTarget.suiteSha256 === null || existingTarget.suiteSha256 === source.suiteSha256);
        if (!preparable) {
          refuse(
            409,
            "creative_recovery_incomplete",
            "a recovery worker may already have mutated this deterministic child",
            "Inspect the child recovery record; do not rerun or overwrite a partially mutated artifact.",
          );
        }
      }
      staged = true;
    } else if (existingTarget !== null) {
      refuse(409, "creative_recovery_incomplete", "the recovery child row exists but its owned filesystem snapshot is missing");
    }

    if (!staged) {
      assertRegularTree(sourcePaths.workspace, "source workspace");
      for (const file of COPY_RESULTS) assertRegularFile(join(sourcePaths.results, file), `source results/${file}`);
      const before = inventorySource(sourcePaths.workspace);
      const staging = mkdtempSync(join(this.#paths.runs, ".creative-recovery-staging-"));
      try {
        cpSync(sourcePaths.workspace, join(staging, "workspace"), {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        });
        // Validate the copy independently: a symlink introduced after the
        // source check but before cpSync reaches an excluded metadata subtree
        // is copied verbatim and must never cross the builder boundary.
        assertRegularTree(join(staging, "workspace"), "staged workspace");
        mkdirSync(join(staging, "results"), { recursive: true });
        for (const file of COPY_RESULTS) {
          cpSync(join(sourcePaths.results, file), join(staging, "results", file), { errorOnExist: true, force: false });
          assertRegularFile(join(staging, "results", file), `staged results/${file}`);
        }
        writeCreativePilotStatus(
          join(staging, "results"),
          sanitizedRecoveryStatus(sourceCreative, this.#now().toISOString()),
        );
        if (!existsSync(join(staging, "results", CREATIVE_STATUS_FILE))) {
          refuse(500, "creative_recovery_status_unavailable", "the sanitized child creative status was not staged");
        }
        writeFileSync(join(staging, "results", CREATIVE_RECOVERY_OWNER_FILE), `${JSON.stringify({
          protocolVersion: CREATIVE_RECOVERY_PROTOCOL_VERSION,
          sourceRunId,
          targetRunId,
          clientRequestId: request.clientRequestId,
          payloadSha256: digest,
          resolvedModelId,
        }, null, 2)}\n`, "utf8");
        const sourceReferences = join(sourcePaths.root, "references");
        const sourceDocuments = join(sourcePaths.root, "documents");
        if (existsSync(sourceReferences)) assertRegularTree(sourceReferences, "references");
        if (existsSync(sourceDocuments)) assertRegularTree(sourceDocuments, "documents");
        const manifest = copyContinuationReferences(
          readReferenceManifest(sourceReferences),
          [],
          [],
          join(staging, "references"),
          join(staging, "documents"),
        );
        if (manifest !== null) writeReferenceManifest(join(staging, "references"), manifest);
        const after = inventorySource(sourcePaths.workspace);
        if (before.sha256 !== after.sha256) {
          refuse(409, "creative_recovery_source_changed", "the terminal source workspace changed while it was being snapshotted");
        }
        assertRegularTree(sourcePaths.workspace, "source workspace");
        renameSync(staging, targetPaths.root);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    }

    // Also protect durable pre-worker staging recovered after a controller
    // crash; its workspace must meet the same complete-tree boundary.
    assertRegularTree(targetPaths.workspace, "recovery workspace");

    const createdAt = this.#now().toISOString();
    if (existingTarget === null) {
      this.#store.createRun({
        runId: targetRunId,
        ticketId: source.ticketId,
        ticketTitle: `${source.ticketTitle} (creative recovery)`,
        ticketText: source.ticketText,
        ticketSha256: source.ticketSha256,
        modelId: source.modelId,
        provider: source.provider,
        deploy: false,
        startedAt: createdAt,
        queuePosition: 0,
        designLock: null,
        interactive: false,
      });
    }
    this.#store.updateRun(targetRunId, {
      status: "running",
      phase: "build",
      queuePosition: null,
      artifactPath: targetPaths.workspace,
      suiteSha256: source.suiteSha256,
      agentDeclaredDone: true,
    });
    this.#store.putCriteria(targetRunId, this.#store.listCriteria(sourceRunId));
    if (this.#store.listAttempts(targetRunId).length === 0) {
      this.#store.openAttempt(targetRunId, createdAt, "build");
    }
    if (existingTarget === null) {
      this.#store.appendEvent(targetRunId, { type: "phase", phase: "build" });
      this.#store.appendEvent(targetRunId, { type: "status", status: "running" });
      this.#store.appendEvent(targetRunId, {
        type: "log",
        level: "info",
        text: `controller-owned terminal creative recovery child of ${sourceRunId}; source workspace and terminal session are immutable`,
      });
    }

    try {
      writeFileSync(join(targetPaths.results, CREATIVE_RECOVERY_WORKER_STARTED_FILE), `${JSON.stringify({
        protocolVersion: CREATIVE_RECOVERY_PROTOCOL_VERSION,
        targetRunId,
        startedAt: this.#now().toISOString(),
      }, null, 2)}\n`, "utf8");
      const outcome = await this.#run({ sourceRunId, targetRunId, contractHash: request.contractHash, resolvedModelId });
      const terminal = this.#store.getRun(targetRunId);
      if (
        terminal === null || terminal.status !== outcome.terminalStatus || terminal.heldOutPass !== outcome.heldOutPass ||
        terminal.falseFinish !== outcome.falseFinish || terminal.failureReason !== outcome.failureReason ||
        terminal.gateAttempts !== outcome.gateAttempts || terminal.gateStopReason !== outcome.gateStopReason
      ) {
        refuse(
          500,
          "creative_recovery_worker_did_not_terminalize",
          "the recovery worker returned without the normal terminal lifecycle recording its exact verdict and gate history",
        );
      }
      const completedAt = this.#now().toISOString();
      const response: TerminalCreativeRecoveryResponse = {
        sourceRunId,
        targetRunId,
        contractHash: request.contractHash,
        resolvedModelId,
        state: "completed",
        replayed: false,
        ...outcome,
      };
      const { replayed: _transportReplay, ...durableResponse } = response;
      const record: RecoveryRecord = {
        protocolVersion: CREATIVE_RECOVERY_PROTOCOL_VERSION,
        payloadSha256: digest,
        createdAt,
        completedAt,
        ...durableResponse,
        state: "finalizing",
      };
      atomicRecord(recordPath, record);
      return this.#finishDurableRecord(record, false, targetRunId, digest);
    } catch (error) {
      // The worker owns terminalization through the Orchestrator's single
      // terminal funnel. This controller never synthesizes a competing verdict.
      throw error;
    }
  }

  #finishDurableRecord(
    record: RecoveryRecord,
    replayed: boolean,
    expectedTargetRunId: string,
    expectedPayloadSha256: string,
  ): TerminalCreativeRecoveryResponse {
    if (record.targetRunId !== expectedTargetRunId || record.payloadSha256 !== expectedPayloadSha256) {
      refuse(409, "creative_recovery_idempotency_conflict", "the durable recovery record has a foreign target or payload binding");
    }
    const targetPaths = runPathsFor(this.#paths, expectedTargetRunId);
    const marker = readOwnerMarker(join(targetPaths.results, CREATIVE_RECOVERY_OWNER_FILE));
    if (
      marker === null || marker.sourceRunId !== record.sourceRunId || marker.targetRunId !== expectedTargetRunId ||
      marker.payloadSha256 !== expectedPayloadSha256 || marker.resolvedModelId !== record.resolvedModelId ||
      terminalCreativeRecoveryRunId(record.sourceRunId, {
        clientRequestId: marker.clientRequestId,
        contractHash: record.contractHash,
      }) !== expectedTargetRunId
    ) {
      refuse(409, "creative_recovery_terminal_conflict", "the durable recovery record conflicts with its owner marker");
    }
    const source = this.#store.getRun(record.sourceRunId);
    if (source === null || source.artifactPath === null) {
      refuse(409, "creative_recovery_terminal_conflict", "the durable recovery record has no immutable source row");
    }
    const sourcePaths = runPathsFor(this.#paths, record.sourceRunId);
    assertRegularTree(sourcePaths.workspace, "source workspace");
    assertRegularTree(targetPaths.workspace, "recovery workspace");
    for (const file of COPY_RESULTS) assertRegularFile(join(sourcePaths.results, file), `source results/${file}`);
    assertRegularFile(join(targetPaths.results, CREATIVE_STATUS_FILE), "recovery creative status");
    if (resolvedSourceModel(sourcePaths.results, source) !== record.resolvedModelId) {
      refuse(409, "creative_recovery_terminal_conflict", "the durable recovery record changed its frozen resolved model");
    }
    assertContractBinding(sourcePaths.results, record.contractHash);
    const sourceHash = hashCreativeArtifact(sourcePaths.workspace, join(sourcePaths.results, "creative-render"));
    const targetHash = hashCreativeArtifact(targetPaths.workspace, join(targetPaths.results, "creative-render"));
    if (sourceHash !== record.artifactHashBeforeMutation || targetHash !== record.artifactHashAfterMutation) {
      refuse(409, "creative_recovery_terminal_conflict", "the durable recovery record conflicts with its source or recovered artifact hash");
    }
    const creative = readCreativePilotStatus(targetPaths.results);
    if (
      creative === null || creative.contractHash !== record.contractHash ||
      creative.heldOutPass !== record.heldOutPass || creative.renderManifestHash !== record.renderManifestHash ||
      creative.criticDisposition !== record.criticDisposition || creative.criticAttempt !== record.criticAttempt ||
      creative.reviewStopReason !== record.reviewStopReason
    ) {
      refuse(409, "creative_recovery_terminal_conflict", "the durable recovery record conflicts with its creative evidence");
    }
    const target = this.#store.getRun(record.targetRunId);
    if (target === null) refuse(409, "creative_recovery_incomplete", "the finalizing recovery record has no child run row");
    const targetStatus = record.terminalStatus;
    if (!isTerminal(target.status)) {
      refuse(409, "creative_recovery_incomplete", "the finalizing recovery record has no normally terminalized child run");
    }
    if (
      target.status !== targetStatus || target.heldOutPass !== record.heldOutPass ||
      target.falseFinish !== record.falseFinish || target.failureReason !== record.failureReason ||
      target.gateAttempts !== record.gateAttempts || target.gateStopReason !== record.gateStopReason ||
      target.artifactPath !== targetPaths.workspace || target.ticketId !== source.ticketId ||
      target.ticketSha256 !== source.ticketSha256 || target.suiteSha256 !== source.suiteSha256 ||
      target.modelId !== source.modelId || target.provider !== source.provider
    ) {
      refuse(409, "creative_recovery_terminal_conflict", "the finalizing record conflicts with the child run's terminal verdict");
    }
    const completed: RecoveryRecord = { ...record, state: "completed" };
    atomicRecord(join(runPathsFor(this.#paths, record.targetRunId).results, CREATIVE_RECOVERY_FILE), completed);
    return { ...completed, state: "completed", replayed };
  }
}
