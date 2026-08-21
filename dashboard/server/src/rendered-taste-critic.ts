/** Independent, tool-less rendered-taste critic and its durable host record. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnthropicSeat, BudgetPolicy } from "bakeoff/dist/contracts.js";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type { RateLimitState } from "./claude-common.js";
import { SubscriptionSeatCaller } from "./subscription-caller.js";
import type { SeatImage, SeatSessionFactory } from "./subscription-caller.js";
import {
  buildTasteCriticPrompt,
  parseTasteCriticOutput,
} from "./taste-policy.js";
import type {
  TasteCriticOutputV1,
  TasteCriticPromptInput,
  TasteFindingV1,
  TastePolicyError,
} from "./taste-policy.js";
import type { TokenTotals } from "./tokens.js";

export const RENDERED_TASTE_CRITIC_SCHEMA_VERSION = 1 as const;
export const MAX_CREATIVE_REVIEW_ATTEMPTS = 3;
export const RENDERED_TASTE_CRITIC_MAX_OUTPUT_TOKENS = 16_000;
export const CREATIVE_CRITIC_DIRECTORY = "creative-critic";

export type CriticDisposition = "accept" | "revise" | "unavailable";

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
  readonly output: TasteCriticOutputV1 | null;
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
    return {
      schemaVersion: RENDERED_TASTE_CRITIC_SCHEMA_VERSION,
      attempt: request.attempt,
      iteration: request.iteration,
      treeHash: request.treeHash,
      contractHash: output.contractHash,
      renderManifestHash: output.renderManifestHash,
      recordedAt,
      criticDisposition: output.findings.length === 0 ? "accept" : "revise",
      ran: true,
      output,
      findingFingerprint: fingerprintTasteFindings(output.findings),
      policyErrors: [],
      detail: output.findings.length === 0 ? "critic accepted the rendered evidence" : "critic requested bounded revisions",
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
  if (!Number.isInteger(iteration) || iteration < 0 || iteration > 3) {
    throw new Error("render iteration must be 0-3");
  }
  return join(resultsDir, CREATIVE_CRITIC_DIRECTORY, `${String(iteration)}.json`);
}

export function writeRenderedTasteCriticRecord(resultsDir: string, record: RenderedTasteCriticRecord): string {
  const path = criticRecordPath(resultsDir, record.iteration);
  mkdirSync(join(resultsDir, CREATIVE_CRITIC_DIRECTORY), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
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
        record.criticDisposition !== "revise" &&
        record.criticDisposition !== "unavailable")
    ) return null;
    if (record.criticDisposition === "unavailable") {
      if (record.output !== null || record.findingFingerprint !== null) return null;
    } else {
      if (
        typeof record.output !== "object" ||
        record.output === null ||
        !HASH.test(record.findingFingerprint ?? "") ||
        record.output.contractHash !== record.contractHash ||
        record.output.renderManifestHash !== record.renderManifestHash ||
        !Array.isArray(record.output.findings) ||
        (record.criticDisposition === "accept" && record.output.findings.length !== 0) ||
        (record.criticDisposition === "revise" && record.output.findings.length === 0)
      ) return null;
    }
    return record as RenderedTasteCriticRecord;
  } catch {
    return null;
  }
}

function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
