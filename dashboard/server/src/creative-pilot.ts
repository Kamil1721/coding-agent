/** Durable, default-off host policy for the rendered creative-review pilot. */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type { Ticket } from "bakeoff/dist/contracts.js";

import {
  canonicalJson,
  compileCreativeContract,
  sha256Hex,
} from "./creative-contract.js";
import type {
  CreativeCompileError,
  CreativeContractV1,
  CreativeEvidenceRef,
  CreativeEvidenceResolver,
} from "./creative-contract.js";
import type {
  CreativeAuthorFact,
  CreativeContractAuthorInput,
  CreativeContractAuthorResult,
} from "./creative-contract-author.js";
import type { CreativeReviewState } from "./creative-review-loop.js";
import type { RenderedTasteCriticRecord } from "./rendered-taste-critic.js";
import type { CreativeRenderOutput } from "./creative-render.js";
import { RENDER_PROFILE_IDS } from "./render-manifest.js";
import type { RenderProfileId } from "./render-manifest.js";
import type { ReferenceManifest } from "./ticket-refs.js";
import { manifestDocuments } from "./ticket-refs.js";
import { TASTE_CATEGORIES, TASTE_CODE_CATEGORY, TASTE_FINDING_CODES } from "./taste-policy.js";

export const CREATIVE_CONTRACT_FILE = "creative-contract.json";
/** Exact repository identity for the default-off-everywhere-else WEB pilot. */
export const CREATIVE_PILOT_PROJECT_ID = "coding-agent";
export const CREATIVE_COMPILE_FILE = "creative-compile.json";
export const CREATIVE_AUTHOR_FILE = "creative-contract-author.json";
export const CREATIVE_STATUS_FILE = "creative-status.json";
export const CREATIVE_DECISION_FILE = "creative-owner-decision.json";
export const CREATIVE_RENDER_DIRECTORY = "creative-render";

export type CreativeCompileOutcome = "unknown" | "passed" | "failed" | "unavailable";
export type CreativeOwnerDecision = "approved" | "revision_requested" | "waived" | "cancelled" | null;

export interface CreativeCompileRecord {
  readonly outcome: CreativeCompileOutcome;
  readonly contractHash: string | null;
  readonly findings: readonly CreativeCompileError[];
  readonly checkedAt: string;
}

export interface CreativePilotStatus {
  readonly schemaVersion: 1;
  readonly applicable: boolean;
  readonly enabled: boolean;
  readonly contractHash: string | null;
  readonly compile: CreativeCompileRecord;
  readonly renderManifestHash: string | null;
  readonly renderFresh: boolean | null;
  readonly renderProfiles: readonly {
    readonly profileId: RenderProfileId;
    readonly captureCount: number;
    readonly complete: boolean;
  }[] | null;
  readonly criticDisposition: "accept" | "revise" | "unavailable" | null;
  readonly criticFindings: readonly {
    readonly category: string;
    readonly code: string;
    readonly routeId: string;
    readonly sectionIds: readonly string[];
    readonly diagnosis: string;
    readonly revision: string;
  }[];
  readonly criticAttempt: number | null;
  readonly reviewState: CreativeReviewState["status"] | null;
  readonly reviewStopReason: CreativeReviewState["stopReason"];
  readonly ownerDecision: CreativeOwnerDecision;
  readonly ownerDecisionReason: string | null;
  readonly ownerDecisionTargetRunId: string | null;
  readonly heldOutPass: boolean | null;
  readonly updatedAt: string;
}

export interface FreshCreativeContract {
  readonly contract: CreativeContractV1;
  readonly contractHash: string;
}

export interface CreativeDecisionClaim {
  readonly decision: Exclude<CreativeOwnerDecision, null>;
  readonly reason: string | null;
  readonly claimedAt: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const COMPILE_OUTCOMES = new Set<CreativeCompileOutcome>(["unknown", "passed", "failed", "unavailable"]);
const CRITIC_DISPOSITIONS = new Set(["accept", "revise", "unavailable"]);
const REVIEW_STATES = new Set(["reviewing", "creative_ready", "creative_review_required", "not_converging", "failed"]);
const REVIEW_STOP_REASONS = new Set([
  "accepted", "functional_red", "compiler_red", "prerequisite_unknown", "critic_unavailable",
  "repeated_tree_and_findings", "attempts_exhausted", "invalid_attempt",
]);
const OWNER_DECISIONS = new Set(["approved", "revision_requested", "waived", "cancelled"]);
const PROFILE_IDS = new Set<string>(RENDER_PROFILE_IDS);
const TASTE_CATEGORY_SET = new Set<string>(TASTE_CATEGORIES);
const TASTE_CODE_SET = new Set<string>(TASTE_FINDING_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && HASH.test(value));
}

export function creativePilotEnabled(
  actualProjectId: string | null | undefined,
  allowedProjectId: string | null | undefined,
): boolean {
  return actualProjectId != null && allowedProjectId != null && actualProjectId === allowedProjectId;
}

export function webCreativeApplicable(surface: string): boolean {
  return surface === "web-ui" || surface === "fullstack";
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(redactForPersistence(value), null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function unavailableCompileRecord(): CreativeCompileRecord {
  return {
    outcome: "unavailable",
    contractHash: null,
    findings: [],
    checkedAt: new Date().toISOString(),
  };
}

export function initialCreativePilotStatus(applicable: boolean, enabled: boolean): CreativePilotStatus {
  return {
    schemaVersion: 1,
    applicable,
    enabled,
    contractHash: null,
    compile: { outcome: "unknown", contractHash: null, findings: [], checkedAt: new Date().toISOString() },
    renderManifestHash: null,
    renderFresh: null,
    renderProfiles: null,
    criticDisposition: null,
    criticFindings: [],
    criticAttempt: null,
    reviewState: null,
    reviewStopReason: null,
    ownerDecision: null,
    ownerDecisionReason: null,
    ownerDecisionTargetRunId: null,
    heldOutPass: null,
    updatedAt: new Date().toISOString(),
  };
}

export function writeCreativePilotStatus(resultsDir: string, status: CreativePilotStatus): void {
  atomicJson(join(resultsDir, CREATIVE_STATUS_FILE), status);
}

export function claimCreativeDecision(
  resultsDir: string,
  decision: Exclude<CreativeOwnerDecision, null>,
  reason: string | null,
  clock: () => Date = () => new Date(),
): { readonly kind: "created" | "replay" | "conflict"; readonly claim: CreativeDecisionClaim } {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, CREATIVE_DECISION_FILE);
  const candidate: CreativeDecisionClaim = { decision, reason, claimedAt: clock().toISOString() };
  const temporary = `${path}.${process.pid}.${randomUUID()}.claim`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Linking a fully-written inode is the exclusive compare-and-set. Creating
    // the final path first would expose an empty/partial JSON file to the loser.
    linkSync(temporary, path);
    return { kind: "created", claim: candidate };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || !hasExactKeys(raw, ["decision", "reason", "claimedAt"])) {
      throw new Error("creative owner-decision claim is malformed");
    }
    const record = raw as unknown as Partial<CreativeDecisionClaim>;
    if (
      typeof record.decision !== "string" || !OWNER_DECISIONS.has(record.decision) ||
      !(record.reason === null || typeof record.reason === "string") ||
      typeof record.claimedAt !== "string" || !Number.isFinite(Date.parse(record.claimedAt))
    ) throw new Error("creative owner-decision claim is malformed");
    const existing = record as CreativeDecisionClaim;
    const same = existing.decision === decision && existing.reason === reason;
    return { kind: same ? "replay" : "conflict", claim: existing };
  } finally {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup after the durable link */ }
  }
}

export function writeCreativeRenderManifest(outputDir: string, canonicalManifest: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalManifest); }
  catch { throw new Error("creative render returned a non-JSON canonical manifest"); }
  atomicJson(join(outputDir, "manifest.json"), parsed);
}

export function readCreativePilotStatus(resultsDir: string): CreativePilotStatus | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(resultsDir, CREATIVE_STATUS_FILE), "utf8"));
    if (!isRecord(raw) || !hasExactKeys(raw, [
      "schemaVersion", "applicable", "enabled", "contractHash", "compile", "renderManifestHash",
      "renderFresh", "renderProfiles", "criticDisposition", "criticFindings", "criticAttempt",
      "reviewState", "reviewStopReason", "ownerDecision", "ownerDecisionReason",
      "ownerDecisionTargetRunId", "heldOutPass", "updatedAt",
    ])) return null;
    const record = raw as unknown as Partial<CreativePilotStatus>;
    const compile = record.compile;
    if (!isRecord(compile) || !hasExactKeys(compile, ["outcome", "contractHash", "findings", "checkedAt"])) return null;
    if (
      typeof compile.outcome !== "string" || !COMPILE_OUTCOMES.has(compile.outcome as CreativeCompileOutcome) ||
      !isNullableHash(compile.contractHash) ||
      !Array.isArray(compile.findings) ||
      !compile.findings.every((finding) => isRecord(finding) &&
        hasExactKeys(finding, ["code", "path", "message"]) &&
        typeof finding["code"] === "string" && typeof finding["path"] === "string" && typeof finding["message"] === "string") ||
      typeof compile.checkedAt !== "string" || !Number.isFinite(Date.parse(compile.checkedAt))
    ) return null;
    const profiles = record.renderProfiles;
    if (profiles !== null) {
      if (!Array.isArray(profiles) || profiles.length !== RENDER_PROFILE_IDS.length) return null;
      const ids = new Set<string>();
      for (const profile of profiles) {
        if (
          !isRecord(profile) || !hasExactKeys(profile, ["profileId", "captureCount", "complete"]) ||
          typeof profile["profileId"] !== "string" || !PROFILE_IDS.has(profile["profileId"]) || ids.has(profile["profileId"]) ||
          typeof profile["captureCount"] !== "number" || !Number.isInteger(profile["captureCount"]) || profile["captureCount"] < 0 ||
          typeof profile["complete"] !== "boolean"
        ) return null;
        ids.add(profile["profileId"]);
      }
    }
    const criticFindings = record.criticFindings;
    if (!Array.isArray(criticFindings)) return null;
    for (const finding of criticFindings) {
      if (
        !isRecord(finding) ||
        !hasExactKeys(finding, ["category", "code", "routeId", "sectionIds", "diagnosis", "revision"]) ||
        typeof finding["category"] !== "string" || !TASTE_CATEGORY_SET.has(finding["category"]) ||
        typeof finding["code"] !== "string" || !TASTE_CODE_SET.has(finding["code"]) ||
        TASTE_CODE_CATEGORY[finding["code"] as keyof typeof TASTE_CODE_CATEGORY] !== finding["category"] ||
        typeof finding["routeId"] !== "string" || finding["routeId"].length === 0 ||
        !Array.isArray(finding["sectionIds"]) || !finding["sectionIds"].every((section) => typeof section === "string") ||
        typeof finding["diagnosis"] !== "string" || typeof finding["revision"] !== "string"
      ) return null;
    }
    if (
      record.schemaVersion !== 1 ||
      typeof record.applicable !== "boolean" ||
      typeof record.enabled !== "boolean" ||
      !isNullableHash(record.contractHash) ||
      (compile.outcome === "passed" ? compile.contractHash === null : compile.contractHash !== null) ||
      record.contractHash !== compile.contractHash ||
      !isNullableHash(record.renderManifestHash) ||
      !(record.renderFresh === null || typeof record.renderFresh === "boolean") ||
      (record.renderFresh === true && (record.renderManifestHash === null || profiles === null)) ||
      !(record.criticDisposition === null ||
        (typeof record.criticDisposition === "string" && CRITIC_DISPOSITIONS.has(record.criticDisposition))) ||
      (record.criticDisposition === "accept" && criticFindings.length !== 0) ||
      (record.criticDisposition === "revise" && criticFindings.length === 0) ||
      !(record.criticAttempt === null ||
        (typeof record.criticAttempt === "number" && Number.isInteger(record.criticAttempt) &&
          record.criticAttempt >= 1 && record.criticAttempt <= 3)) ||
      !(record.reviewState === null || (typeof record.reviewState === "string" && REVIEW_STATES.has(record.reviewState))) ||
      !(record.reviewStopReason === null ||
        (typeof record.reviewStopReason === "string" && REVIEW_STOP_REASONS.has(record.reviewStopReason))) ||
      !(record.ownerDecision === null ||
        (typeof record.ownerDecision === "string" && OWNER_DECISIONS.has(record.ownerDecision))) ||
      !(record.ownerDecisionReason === null || typeof record.ownerDecisionReason === "string") ||
      !(record.ownerDecisionTargetRunId === null || typeof record.ownerDecisionTargetRunId === "string") ||
      !(record.heldOutPass === null || typeof record.heldOutPass === "boolean") ||
      typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))
    ) return null;
    return record as unknown as CreativePilotStatus;
  } catch {
    return null;
  }
}

export function authorInputFor(
  ticket: Ticket,
  manifest: ReferenceManifest | null,
): { readonly input: CreativeContractAuthorInput; readonly resolver: CreativeEvidenceResolver } {
  const facts: CreativeAuthorFact[] = [];
  const resolutions = new Map<string, { readonly sha256: string; readonly excerptSha256: string }>();
  const add = (
    id: string,
    kind: CreativeAuthorFact["kind"],
    statement: string,
    evidenceKind: CreativeEvidenceRef["kind"],
    locator: string,
    sha256: string,
  ): CreativeAuthorFact => {
    const bounded = statement.replace(/\s+/gu, " ").trim().slice(0, 500);
    const evidence: CreativeEvidenceRef = {
      kind: evidenceKind,
      locator,
      sha256,
      excerptSha256: sha256Hex(bounded),
    };
    resolutions.set(canonicalJson(evidence), { sha256: evidence.sha256, excerptSha256: evidence.excerptSha256 });
    const fact = { id, kind, statement: bounded, evidence } satisfies CreativeAuthorFact;
    facts.push(fact);
    return fact;
  };

  const ticketFact = add(
    "ticket.goal",
    "goal",
    ticket.brief,
    "owner_message",
    `ticket:${ticket.id}`,
    ticket.sha256,
  );
  const designFact = add(
    "host.web-surface",
    "technical_constraint",
    "The host classified this ticket as a browser-visible interface. The delivered page must expose deterministic route, section, and motion data markers for rendered capture.",
    "brief_artifact",
    `ticket:${ticket.id}:surface`,
    ticket.sha256,
  );
  const referenceFacts: CreativeAuthorFact[] = [];
  for (const [index, image] of (manifest?.images ?? []).entries()) {
    referenceFacts.push(add(
      `reference.image.${String(index + 1)}`,
      "reference_imagery",
      `The owner attached reference image ${basename(image.path)}; its bytes are identified by the admitted digest.`,
      "brief_artifact",
      `reference:image:${String(index + 1)}`,
      image.sha256,
    ));
  }
  for (const [index, document] of manifestDocuments(manifest).entries()) {
    referenceFacts.push(add(
      `reference.document.${String(index + 1)}`,
      "content_claim",
      `The owner attached a ${document.mediaType} reference document identified by the admitted digest.`,
      "brief_artifact",
      `reference:document:${String(index + 1)}`,
      document.sha256,
    ));
  }
  return {
    input: {
      contractId: `creative-${ticket.id}`,
      ticket: { id: ticket.id, sha256: ticket.sha256, facts: [ticketFact] },
      designFacts: [designFact],
      referenceFacts,
    },
    resolver: { resolve(reference) { return resolutions.get(canonicalJson(reference)) ?? null; } },
  };
}

export function persistCreativeAuthorResult(
  resultsDir: string,
  result: CreativeContractAuthorResult,
): CreativeCompileRecord {
  atomicJson(join(resultsDir, CREATIVE_AUTHOR_FILE), result);
  const compile: CreativeCompileRecord = {
    outcome: result.status === "compiled" ? "passed" : result.status === "invalid" ? "failed" : "unavailable",
    contractHash: result.contractHash,
    findings: result.compileErrors,
    checkedAt: new Date().toISOString(),
  };
  if (result.contract !== null) atomicJson(join(resultsDir, CREATIVE_CONTRACT_FILE), result.contract);
  atomicJson(join(resultsDir, CREATIVE_COMPILE_FILE), compile);
  return compile;
}

export function freshCreativeContract(
  resultsDir: string,
  resolver: CreativeEvidenceResolver,
): { readonly fresh: FreshCreativeContract | null; readonly compile: CreativeCompileRecord } {
  let frozenContractHash: string;
  try {
    const authored: unknown = JSON.parse(readFileSync(join(resultsDir, CREATIVE_AUTHOR_FILE), "utf8"));
    if (!isRecord(authored)) throw new Error("missing frozen author contract hash");
    const record = authored as { readonly status?: unknown; readonly contractHash?: unknown };
    if (record.status !== "compiled" || typeof record.contractHash !== "string" ||
      !HASH.test(record.contractHash)) throw new Error("missing frozen author contract hash");
    frozenContractHash = record.contractHash;
  } catch {
    const compile = unavailableCompileRecord();
    atomicJson(join(resultsDir, CREATIVE_COMPILE_FILE), compile);
    return { fresh: null, compile };
  }
  let compiled: ReturnType<typeof compileCreativeContract>;
  try {
    compiled = compileCreativeContract(readFileSync(join(resultsDir, CREATIVE_CONTRACT_FILE), "utf8"), resolver);
  } catch {
    const compile = unavailableCompileRecord();
    atomicJson(join(resultsDir, CREATIVE_COMPILE_FILE), compile);
    return { fresh: null, compile };
  }
  let fresh: FreshCreativeContract | null = null;
  let compile: CreativeCompileRecord;
  if (!compiled.ok) {
    compile = { outcome: "failed", contractHash: null, findings: compiled.errors, checkedAt: new Date().toISOString() };
  } else if (compiled.contractHash !== frozenContractHash) {
    compile = {
      outcome: "failed",
      contractHash: null,
      findings: [{ code: "INVALID_VALUE", path: "/", message: "contract hash differs from the frozen authored contract" }],
      checkedAt: new Date().toISOString(),
    };
  } else {
    fresh = { contract: compiled.contract, contractHash: compiled.contractHash };
    compile = { outcome: "passed", contractHash: compiled.contractHash, findings: [], checkedAt: new Date().toISOString() };
  }
  atomicJson(join(resultsDir, CREATIVE_COMPILE_FILE), compile);
  return { fresh, compile };
}

export function creativeContractPrompt(contract: FreshCreativeContract): string {
  const projection = canonicalJson(contract.contract);
  return [
    "CREATIVE CONTRACT (HOST-COMPILED; REQUIRED)",
    `contractHash: ${contract.contractHash}`,
    "Implement this closed contract without changing its criteria.",
    "Every route root MUST carry data-creative-route=\"<route id>\".",
    "Every contracted section MUST carry data-creative-section=\"<section id>\".",
    "Every contracted motion target MUST carry data-motion-id=\"<motion id>\".",
    "Compiled contract JSON:",
    projection,
  ].join("\n");
}

export function creativeRevisionPrompt(
  contract: FreshCreativeContract,
  critic: RenderedTasteCriticRecord,
): string {
  const findings = critic.output?.findings.map((finding) => ({
    category: finding.category,
    code: finding.code,
    routeId: finding.routeId,
    sectionIds: finding.sectionIds,
    diagnosis: finding.diagnosis,
    revision: finding.revision,
    evidence: finding.evidence,
  })) ?? [];
  return [
    "CREATIVE REVISION BOUNDARY",
    "Resume this SAME builder session. Do not change the contract or its criteria.",
    creativeContractPrompt(contract),
    "Admitted rendered findings:",
    canonicalJson(findings),
    "Apply only bounded revisions supported by those facts. Re-run the project's normal compiler/tests and update the self-report.",
  ].join("\n\n");
}

export function statusAfterCompile(
  status: CreativePilotStatus,
  compile: CreativeCompileRecord,
): CreativePilotStatus {
  return { ...status, contractHash: compile.contractHash, compile, updatedAt: new Date().toISOString() };
}

export function statusAfterRender(
  status: CreativePilotStatus,
  output: CreativeRenderOutput,
): CreativePilotStatus {
  return {
    ...status,
    renderManifestHash: output.renderManifestHash,
    renderFresh: true,
    renderProfiles: output.manifest.profiles.map((profile) => ({
      profileId: profile.id,
      captureCount: output.manifest.captures.filter((capture) => capture.profileId === profile.id).length,
      // The output reached this function only after validateRenderManifest's
      // closed coverage checks succeeded.
      complete: true,
    })),
    updatedAt: new Date().toISOString(),
  };
}

/** A builder mutation invalidates rendered evidence until the host captures again. */
export function statusBeforeCreativeMutation(status: CreativePilotStatus): CreativePilotStatus {
  return { ...status, renderFresh: false, updatedAt: new Date().toISOString() };
}

export function statusAfterReview(
  status: CreativePilotStatus,
  review: CreativeReviewState,
  critic: RenderedTasteCriticRecord | null,
  renderManifestHash: string | null,
): CreativePilotStatus {
  const findings = critic === null
    ? status.criticFindings
    : critic.output?.findings.map((finding) => ({
        category: finding.category,
        code: finding.code,
        routeId: finding.routeId,
        sectionIds: [...finding.sectionIds],
        diagnosis: finding.diagnosis,
        revision: finding.revision,
      })) ?? [];
  return {
    ...status,
    heldOutPass: review.heldOutPass,
    renderManifestHash: renderManifestHash ?? status.renderManifestHash,
    criticDisposition: critic?.criticDisposition ?? status.criticDisposition,
    criticFindings: findings,
    criticAttempt: critic?.attempt ?? status.criticAttempt,
    reviewState: review.status,
    reviewStopReason: review.stopReason,
    ownerDecision: review.ownerDecision === "pending" ? null : review.ownerDecision,
    updatedAt: new Date().toISOString(),
  };
}

export function pilotMayPublish(status: CreativePilotStatus | null): boolean {
  if (
    status === null || !status.enabled || !status.applicable || status.heldOutPass !== true ||
    status.compile.outcome !== "passed"
  ) return false;
  return (
    status.criticDisposition === "accept" && status.ownerDecision === "approved"
  ) || (
    status.criticDisposition === "revise" &&
    status.ownerDecision === "waived" &&
    (status.ownerDecisionReason?.trim().length ?? 0) > 0
  );
}

export function hashCreativeArtifact(rootDir: string, ignoredDir: string): string {
  const lines: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (full === ignoredDir) continue;
      const relative = full.slice(rootDir.length + 1).replace(/\\/gu, "/");
      if (entry.isDirectory()) { lines.push(`D ${relative}`); walk(full); }
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        lines.push(`F ${relative} ${String(statSync(full).size)} ${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  walk(rootDir);
  return sha256Hex(lines.join("\n"));
}
