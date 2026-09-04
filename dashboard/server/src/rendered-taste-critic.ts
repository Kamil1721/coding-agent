/** Independent, tool-less rendered-taste critic and its durable host record. */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AnthropicSeat, BudgetPolicy } from "bakeoff/dist/contracts.js";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type { RateLimitState } from "./claude-common.js";
import { SubscriptionSeatCaller } from "./subscription-caller.js";
import type { SeatImage, SeatSessionFactory } from "./subscription-caller.js";
import {
  MAX_TASTE_EVIDENCE_PER_FINDING,
  MAX_TASTE_FINDINGS,
  MAX_TASTE_FINDINGS_PER_CATEGORY,
  MIN_TASTE_EVIDENCE_PER_FINDING,
  TASTE_ASSET_PROVENANCE,
  TASTE_CATEGORIES,
  TASTE_CODE_CATEGORY,
  TASTE_FINDING_CODES,
  buildTasteCriticPrompt,
  parseTasteCriticOutput,
} from "./taste-policy.js";
import type {
  LegacyTasteCriticOutputV1,
  TasteCriticOutputV1,
  TasteEvidence,
  TasteCriticPromptInput,
  TasteFindingV1,
  TastePolicyError,
} from "./taste-policy.js";
import type { TokenTotals } from "./tokens.js";

export const RENDERED_TASTE_CRITIC_SCHEMA_VERSION = 1 as const;
export const MAX_CREATIVE_REVIEW_ATTEMPTS = 3;
export const RENDERED_TASTE_CRITIC_MAX_OUTPUT_TOKENS = 16_000;
export const CREATIVE_CRITIC_DIRECTORY = "creative-critic";

/**
 * Detect any durable critic-artifact footprint without following or traversing it.
 * A malformed node still counts as authority evidence and must fail closed.
 */
export function hasRenderedTasteCriticArtifact(resultsDir: string): boolean {
  try {
    lstatSync(join(resultsDir, CREATIVE_CRITIC_DIRECTORY));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export type CriticDisposition = "accept" | "no_evidence" | "revise" | "unavailable";
type CompletedCriticDisposition = Exclude<CriticDisposition, "unavailable">;

export interface RenderedTasteCriticRecord {
  readonly schemaVersion: typeof RENDERED_TASTE_CRITIC_SCHEMA_VERSION;
  /** One-based critic-call ordinal, independently bounded to three. */
  readonly attempt: number;
  /** The zero-based render-manifest iteration whose evidence was judged. */
  readonly iteration: number;
  /** The render manifest's artifactHash. Named treeHash at the loop boundary. */
  readonly treeHash: string;
  readonly contractHash: string;
  readonly renderManifestHash: string;
  readonly recordedAt: string;
  readonly criticDisposition: CriticDisposition;
  readonly ran: boolean;
  readonly output: TasteCriticOutputV1 | LegacyTasteCriticOutputV1 | null;
  readonly findingFingerprint: string | null;
  readonly policyErrors: readonly TastePolicyError[];
  readonly detail: string;
  readonly tokens: TokenTotals | null;
  readonly rateLimit: RateLimitState | null;
  readonly criticBy: string;
}

export interface RenderedTasteCriticRequest {
  readonly attempt: number;
  readonly iteration: number;
  readonly treeHash: string;
  readonly prompt: TasteCriticPromptInput;
  /** Already admitted host content blocks. The critic never receives a path or a Read tool. */
  readonly images: readonly SeatImage[];
  readonly seat: AnthropicSeat;
  readonly budget: BudgetPolicy;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly startQuery?: SeatSessionFactory;
  readonly clock?: () => Date;
}

const HASH = /^[a-f0-9]{64}$/u;
const TASTE_CATEGORY_SET = new Set<string>(TASTE_CATEGORIES);
const TASTE_CODE_SET = new Set<string>(TASTE_FINDING_CODES);
const TASTE_PROVENANCE_SET = new Set<string>(TASTE_ASSET_PROVENANCE);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "attempt",
  "iteration",
  "treeHash",
  "contractHash",
  "renderManifestHash",
  "recordedAt",
  "criticDisposition",
  "ran",
  "output",
  "findingFingerprint",
  "policyErrors",
  "detail",
  "tokens",
  "rateLimit",
  "criticBy",
]);
const COMPLETED_CRITIC_DETAILS = {
  accept: "critic accepted the rendered evidence",
  no_evidence: "critic ran but the supplied rendered evidence was insufficient",
  revise: "critic requested bounded revisions",
} as const satisfies Record<CompletedCriticDisposition, string>;

function completedDispositionFor(
  output: TasteCriticOutputV1 | LegacyTasteCriticOutputV1,
): CompletedCriticDisposition {
  if (output.findings.length > 0) return "revise";
  return output.schemaVersion === 2 && !output.evidenceSufficient ? "no_evidence" : "accept";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUniqueStringArray(value: unknown, minimum: number, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function isTasteEvidence(value: unknown): value is TasteEvidence {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "contract") {
    return hasExactKeys(value, ["kind", "pointer", "valueSha256"]) &&
      isNonEmptyString(value["pointer"]) && typeof value["valueSha256"] === "string" && HASH.test(value["valueSha256"]);
  }
  if (value["kind"] === "dom_text") {
    return hasExactKeys(value, ["kind", "frameId", "sectionId", "excerpt", "textSha256"]) &&
      isNonEmptyString(value["frameId"]) && isNonEmptyString(value["sectionId"]) &&
      isNonEmptyString(value["excerpt"]) && typeof value["textSha256"] === "string" && HASH.test(value["textSha256"]);
  }
  if (value["kind"] === "region") {
    const box = value["box"];
    return hasExactKeys(value, ["kind", "frameId", "sectionId", "screenshotSha256", "box"]) &&
      isNonEmptyString(value["frameId"]) && isNonEmptyString(value["sectionId"]) &&
      typeof value["screenshotSha256"] === "string" && HASH.test(value["screenshotSha256"]) &&
      isRecord(box) && hasExactKeys(box, ["x", "y", "width", "height"]) &&
      typeof box["x"] === "number" && Number.isFinite(box["x"]) && box["x"] >= 0 &&
      typeof box["y"] === "number" && Number.isFinite(box["y"]) && box["y"] >= 0 &&
      typeof box["width"] === "number" && Number.isFinite(box["width"]) && box["width"] > 0 &&
      typeof box["height"] === "number" && Number.isFinite(box["height"]) && box["height"] > 0;
  }
  if (value["kind"] === "motion_trace") {
    const indexes = value["sampleIndexes"];
    return hasExactKeys(value, ["kind", "frameId", "motionId", "sampleIndexes", "observedProperties"]) &&
      isNonEmptyString(value["frameId"]) && isNonEmptyString(value["motionId"]) &&
      Array.isArray(indexes) && indexes.length >= 1 && indexes.length <= 8 &&
      indexes.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0) &&
      new Set(indexes).size === indexes.length && isUniqueStringArray(value["observedProperties"], 1, 8);
  }
  if (value["kind"] === "asset") {
    return hasExactKeys(value, ["kind", "frameId", "sectionId", "contentSha256", "provenance"]) &&
      isNonEmptyString(value["frameId"]) && isNonEmptyString(value["sectionId"]) &&
      (value["contentSha256"] === null || (typeof value["contentSha256"] === "string" && HASH.test(value["contentSha256"]))) &&
      typeof value["provenance"] === "string" && TASTE_PROVENANCE_SET.has(value["provenance"]);
  }
  return false;
}

function isTasteFinding(value: unknown): value is TasteFindingV1 {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["id", "category", "code", "routeId", "sectionIds", "diagnosis", "revision", "evidence"],
  )) return false;
  const evidence = value["evidence"];
  return isNonEmptyString(value["id"]) &&
    typeof value["category"] === "string" && TASTE_CATEGORY_SET.has(value["category"]) &&
    typeof value["code"] === "string" && TASTE_CODE_SET.has(value["code"]) &&
    TASTE_CODE_CATEGORY[value["code"] as keyof typeof TASTE_CODE_CATEGORY] === value["category"] &&
    isNonEmptyString(value["routeId"]) && isUniqueStringArray(value["sectionIds"], 1, 8) &&
    isNonEmptyString(value["diagnosis"]) && isNonEmptyString(value["revision"]) &&
    Array.isArray(evidence) && evidence.length >= MIN_TASTE_EVIDENCE_PER_FINDING &&
    evidence.length <= MAX_TASTE_EVIDENCE_PER_FINDING && evidence.every(isTasteEvidence) &&
    new Set(evidence.map(canonicalJson)).size === evidence.length;
}

function isTasteFindings(value: unknown): value is readonly TasteFindingV1[] {
  if (!Array.isArray(value) || value.length > MAX_TASTE_FINDINGS || !value.every(isTasteFinding)) return false;
  const categoryCounts = new Map<string, number>();
  const findingIds = new Set<string>();
  for (const finding of value) {
    if (findingIds.has(finding.id)) return false;
    findingIds.add(finding.id);
    const count = (categoryCounts.get(finding.category) ?? 0) + 1;
    if (count > MAX_TASTE_FINDINGS_PER_CATEGORY) return false;
    categoryCounts.set(finding.category, count);
  }
  return true;
}

/**
 * Run exactly one independent critic call. Every failure is data; none escapes
 * and none can mutate the functional or compiler authorities.
 */
export async function runRenderedTasteCritic(
  request: RenderedTasteCriticRequest,
): Promise<RenderedTasteCriticRecord> {
  let criticBy = "anthropic/unknown (subscription)";
  let recordedAt = new Date().toISOString();
  let caller: SubscriptionSeatCaller | null = null;

  try {
    criticBy = `anthropic/${request.seat.modelId} (subscription)`;
    recordedAt = (request.clock ?? (() => new Date()))().toISOString();
    if (!Number.isInteger(request.attempt) || request.attempt < 1 || request.attempt > MAX_CREATIVE_REVIEW_ATTEMPTS) {
      throw new Error(`critic attempt must be 1-${String(MAX_CREATIVE_REVIEW_ATTEMPTS)}`);
    }
    if (!Number.isInteger(request.iteration) || request.iteration < 0 || request.iteration > 3) {
      throw new Error("render iteration must be 0-3");
    }
    if (!HASH.test(request.treeHash)) throw new Error("critic treeHash must be a lowercase SHA-256");

    const prompt = buildTasteCriticPrompt(request.prompt);
    caller = new SubscriptionSeatCaller(request.seat, {
      budget: request.budget,
      cwd: request.cwd,
      env: request.env,
      abortController: abortControllerFor(request.signal),
      images: request.images,
      ...(request.startQuery === undefined ? {} : { startQuery: request.startQuery }),
    });
    const call = await caller.call({
      system:
        "You are an independent rendered-interface critic. You have one turn, no tools, no workspace access, " +
        "and no authority over functional tests, compilation, owner decisions, or source code.",
      userTurns: [prompt],
      maxOutputTokens: RENDERED_TASTE_CRITIC_MAX_OUTPUT_TOKENS,
      jsonSchema: null,
      purpose: `rendered taste critic attempt ${String(request.attempt)}, render iteration ${String(request.iteration)}`,
    });
    caller.assertUnused();

    if (call.stopReason === "max_tokens") {
      return unavailable(
        request,
        recordedAt,
        criticBy,
        true,
        `critic output reached the ${String(RENDERED_TASTE_CRITIC_MAX_OUTPUT_TOKENS)}-token ceiling`,
        caller,
      );
    }
    const parsed = parseTasteCriticOutput(call.text, request.prompt.evidenceIndex);
    if (!parsed.ok) {
      return unavailable(
        request,
        recordedAt,
        criticBy,
        true,
        "critic output failed the closed taste-policy schema",
        caller,
        parsed.errors,
      );
    }
    const output = redactForPersistence(parsed.output);
    const criticDisposition = completedDispositionFor(output);
    return {
      schemaVersion: RENDERED_TASTE_CRITIC_SCHEMA_VERSION,
      attempt: request.attempt,
      iteration: request.iteration,
      treeHash: request.treeHash,
      contractHash: output.contractHash,
      renderManifestHash: output.renderManifestHash,
      recordedAt,
      criticDisposition,
      ran: true,
      output,
      findingFingerprint: fingerprintTasteFindings(output.findings),
      policyErrors: [],
      detail: COMPLETED_CRITIC_DETAILS[criticDisposition],
      tokens: caller.tokens,
      rateLimit: caller.rateLimit,
      criticBy,
    };
  } catch (error) {
    return unavailable(
      request,
      recordedAt,
      criticBy,
      false,
      `critic pass could not run: ${error instanceof Error ? error.message : String(error)}`,
      caller,
    );
  }
}

function unavailable(
  request: RenderedTasteCriticRequest,
  recordedAt: string,
  criticBy: string,
  ran: boolean,
  detail: string,
  caller: SubscriptionSeatCaller | null,
  policyErrors: readonly TastePolicyError[] = [],
): RenderedTasteCriticRecord {
  return {
    schemaVersion: RENDERED_TASTE_CRITIC_SCHEMA_VERSION,
    attempt: request.attempt,
    iteration: request.iteration,
    treeHash: request.treeHash,
    contractHash: request.prompt.evidenceIndex.contractHash,
    renderManifestHash: request.prompt.evidenceIndex.renderManifestHash,
    recordedAt,
    criticDisposition: "unavailable",
    ran,
    output: null,
    findingFingerprint: null,
    policyErrors: redactForPersistence(policyErrors),
    detail: redactForPersistence(detail),
    tokens: caller?.tokens ?? null,
    rateLimit: caller?.rateLimit ?? null,
    criticBy,
  };
}

/** Stable semantic fingerprint; model-chosen finding ids do not affect it. */
export function fingerprintTasteFindings(findings: readonly TasteFindingV1[]): string {
  const semantic = findings.map((finding) => ({
    category: finding.category,
    code: finding.code,
    routeId: finding.routeId,
    sectionIds: [...finding.sectionIds].sort(),
    diagnosis: finding.diagnosis,
    revision: finding.revision,
    evidence: finding.evidence.map(canonicalJson).sort(),
  }));
  semantic.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function criticRecordPath(resultsDir: string, iteration: number): string {
  if (!Number.isInteger(iteration) || iteration < 0 || iteration >= MAX_CREATIVE_REVIEW_ATTEMPTS) {
    throw new Error(`render iteration must be 0-${String(MAX_CREATIVE_REVIEW_ATTEMPTS - 1)}`);
  }
  return join(resultsDir, CREATIVE_CRITIC_DIRECTORY, `${String(iteration)}.json`);
}

export function writeRenderedTasteCriticRecord(resultsDir: string, record: RenderedTasteCriticRecord): string {
  const path = criticRecordPath(resultsDir, record.iteration);
  const directory = join(resultsDir, CREATIVE_CRITIC_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("creative critic authority path must be a regular directory");
  }
  const temporary = join(directory, `.${String(record.iteration)}.${String(process.pid)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
    return path;
  } finally {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup after link or failure */ }
  }
}

/** Strict, append-only critic authority history. The final record is the only current authority. */
export function readRenderedTasteCriticHistory(resultsDir: string): readonly RenderedTasteCriticRecord[] | null {
  const directory = join(resultsDir, CREATIVE_CRITIC_DIRECTORY);
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const indexes = entries.map((entry) => {
    const match = /^([0-2])\.json$/u.exec(entry.name);
    return match !== null && entry.isFile() ? Number(match[1]) : null;
  });
  if (indexes.some((index) => index === null)) return null;
  const ordered = indexes
    .filter((index): index is number => index !== null)
    .sort((left, right) => left - right);
  if (ordered.length > MAX_CREATIVE_REVIEW_ATTEMPTS) return null;

  const records: RenderedTasteCriticRecord[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index] !== index) return null;
    const record = readRenderedTasteCriticRecord(resultsDir, index);
    if (record === null || record.attempt !== index + 1) return null;
    const prior = records.at(-1);
    if (prior !== undefined && record.contractHash !== prior.contractHash) return null;
    if (prior?.criticDisposition === "no_evidence" || prior?.criticDisposition === "unavailable") return null;
    records.push(record);
  }
  return records;
}

export function readRenderedTasteCriticRecord(
  resultsDir: string,
  iteration: number,
): RenderedTasteCriticRecord | null {
  const path = criticRecordPath(resultsDir, iteration);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Partial<RenderedTasteCriticRecord>;
    if (Object.keys(record).some((key) => !RECORD_KEYS.has(key)) || Object.keys(record).length !== RECORD_KEYS.size) {
      return null;
    }
    if (
      record.schemaVersion !== RENDERED_TASTE_CRITIC_SCHEMA_VERSION ||
      !Number.isInteger(record.attempt) ||
      (record.attempt ?? 0) < 1 ||
      (record.attempt ?? 0) > MAX_CREATIVE_REVIEW_ATTEMPTS ||
      record.iteration !== iteration ||
      !HASH.test(record.treeHash ?? "") ||
      !HASH.test(record.contractHash ?? "") ||
      !HASH.test(record.renderManifestHash ?? "") ||
      typeof record.recordedAt !== "string" ||
      Number.isNaN(Date.parse(record.recordedAt)) ||
      typeof record.ran !== "boolean" ||
      !Array.isArray(record.policyErrors) ||
      typeof record.detail !== "string" ||
      typeof record.criticBy !== "string" ||
      (record.criticDisposition !== "accept" &&
        record.criticDisposition !== "no_evidence" &&
        record.criticDisposition !== "revise" &&
        record.criticDisposition !== "unavailable")
    ) return null;
    if (record.criticDisposition === "unavailable") {
      if (record.output !== null || record.findingFingerprint !== null) return null;
    } else {
      const output = record.output as unknown;
      if (
        !isRecord(output) ||
        record.ran !== true ||
        record.policyErrors.length !== 0 ||
        !HASH.test(record.findingFingerprint ?? "") ||
        output["contractHash"] !== record.contractHash ||
        output["renderManifestHash"] !== record.renderManifestHash ||
        !isTasteFindings(output["findings"])
      ) return null;
      if (output["schemaVersion"] === 1) {
        if (!hasExactKeys(output, ["schemaVersion", "contractHash", "renderManifestHash", "findings"])) return null;
      } else if (output["schemaVersion"] === 2) {
        if (
          !hasExactKeys(output, ["schemaVersion", "contractHash", "renderManifestHash", "evidenceSufficient", "findings"]) ||
          typeof output["evidenceSufficient"] !== "boolean" ||
          (output["findings"].length > 0 && output["evidenceSufficient"] !== true)
        ) return null;
      } else return null;
      const completedOutput = output as unknown as TasteCriticOutputV1 | LegacyTasteCriticOutputV1;
      if (
        record.criticDisposition !== completedDispositionFor(completedOutput) ||
        record.findingFingerprint !== fingerprintTasteFindings(completedOutput.findings)
      ) return null;
    }
    return record as RenderedTasteCriticRecord;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
