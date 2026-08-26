/** Durable, default-off host policy for the rendered creative-review pilot. */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
import { manifestDocuments, ticketProse } from "./ticket-refs.js";
import { PLAN_BLOCK_BEGIN, PLAN_BLOCK_END, stripPlanBlock } from "./plan-brief.js";
import { TASTE_CATEGORIES, TASTE_CODE_CATEGORY, TASTE_FINDING_CODES } from "./taste-policy.js";

export const CREATIVE_CONTRACT_FILE = "creative-contract.json";
/** Exact repository identity for the default-off-everywhere-else WEB pilot. */
export const CREATIVE_PILOT_PROJECT_ID = "coding-agent";
export const CREATIVE_COMPILE_FILE = "creative-compile.json";
export const CREATIVE_AUTHOR_FILE = "creative-contract-author.json";
/**
 * One file per author attempt within a phase entry, beside the canonical
 * CREATIVE_AUTHOR_FILE (which keeps the LAST result and is the only file
 * `freshCreativeContract` and the UI read). Name pattern follows
 * `creative-revision-N.txt`. Measured 2026-08-25, run
 * run-2026-08-25T10-30-39-122Z-d728ab79: the results directory held exactly one
 * author record, so when the repair loop was added there was nothing on disk to
 * show what attempt 2 was told or what it answered.
 */
export function creativeAuthorAttemptFile(attempt: number): string {
  return `creative-contract-author-attempt-${String(attempt)}.json`;
}
/**
 * The model's output text for one attempt, beside its JSON record. A `.txt`
 * and not a key in the JSON: `rawText` is up to 256 KiB (`MAX_CREATIVE_AUTHOR_RAW_TEXT_CHARS`),
 * and a JSON record carrying it would be that large for every reader that
 * only wants `status` and `compileErrors`. Written only when the author
 * returned output that did not compile; a compiled attempt's output is the
 * canonical contract file. Measured 2026-08-25, run
 * run-2026-08-25T10-30-39-122Z-d728ab79, resume #2 at 15:42:18: three
 * rejected attempts, `repairs: []` on each, and no record of what was written.
 */
export function creativeAuthorAttemptTextFile(attempt: number): string {
  return `creative-contract-author-attempt-${String(attempt)}.txt`;
}
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
  "accepted", "functional_red", "compiler_red", "prerequisite_unknown", "artifact_contract", "critic_unavailable",
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

function atomicText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, path);
}

function atomicJson(path: string, value: unknown): void {
  atomicText(path, `${JSON.stringify(redactForPersistence(value), null, 2)}\n`);
}

/**
 * The author result without its `rawText`, which is persisted as its own
 * `.txt` (see `creativeAuthorAttemptTextFile`) and never inside a JSON record.
 */
function authorRecordWithoutRawText(result: CreativeContractAuthorResult): Omit<CreativeContractAuthorResult, "rawText"> {
  const { rawText: _rawText, ...record } = result;
  return record;
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

function boundedFactStatements(label: string, value: string, maximum: number): readonly string[] {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || maximum <= 0) return [];
  const payloadLimit = Math.max(100, 470 - label.length);
  const parts: string[] = [];
  let rest = normalized;
  while (rest.length > 0) {
    if (rest.length <= payloadLimit) {
      parts.push(rest);
      break;
    }
    const candidate = rest.slice(0, payloadLimit + 1);
    const boundary = candidate.lastIndexOf(" ");
    const take = boundary >= Math.floor(payloadLimit / 2) ? boundary : payloadLimit;
    parts.push(rest.slice(0, take).trim());
    rest = rest.slice(take).trim();
  }
  const render = (part: string, index: number): string =>
    `${label}${parts.length > 1 ? ` (part ${String(index + 1)} of ${String(parts.length)})` : ""}: ${part}`;
  if (parts.length <= maximum) return parts.map(render);

  const omitted = parts.length - maximum + 1;
  const notice = `${label} projection notice: ${String(omitted)} middle part(s) were omitted to keep the trusted fact packet bounded; the beginning and end are preserved.`;
  if (maximum === 1) {
    const budget = Math.max(20, 500 - notice.length - 9);
    const head = normalized.slice(0, Math.floor(budget / 2)).trim();
    const tail = normalized.slice(-Math.ceil(budget / 2)).trim();
    return [`${notice} ${head} […] ${tail}`];
  }
  if (maximum === 2) {
    const tailBudget = Math.max(20, 500 - notice.length - 7);
    return [render(parts[0] ?? "", 0), `${notice} Tail: ${normalized.slice(-tailBudget).trim()}`];
  }
  const contentSlots = maximum - 1;
  const headCount = Math.ceil(contentSlots / 2);
  const tailCount = contentSlots - headCount;
  return [
    ...parts.slice(0, headCount).map(render),
    notice,
    ...parts.slice(parts.length - tailCount).map((part, offset) => render(part, parts.length - tailCount + offset)),
  ];
}

function foldedPlanAnswerStatements(brief: string): readonly string[] {
  const start = brief.lastIndexOf(PLAN_BLOCK_BEGIN);
  if (start < 0) return [];
  const end = brief.indexOf(PLAN_BLOCK_END, start + PLAN_BLOCK_BEGIN.length);
  const block = brief.slice(start, end < 0 ? brief.length : end);
  const statements: string[] = [];
  let question: string | null = null;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.endsWith("[ANSWERED BY THE OWNER]")) {
      question = line.slice(0, -"[ANSWERED BY THE OWNER]".length).trim();
      continue;
    }
    if (question !== null && line.startsWith("he answered:")) {
      const answer = line.slice("he answered:".length).trim();
      statements.push(...boundedFactStatements("Planning answer", `${question} ${answer}`, 2));
      question = null;
      continue;
    }
    if (/\[(?:LEFT TO THE DASHBOARD|NEVER ANSWERED|STILL OPEN)/u.test(line)) question = null;
  }
  return statements;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function recordOf(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringListOf(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedWarning(warnings: string[], code: string, detail: string): void {
  if (warnings.length >= 6) return;
  warnings.push(`Creative author reference warning [${code}]: ${detail}`.slice(0, 300));
}

export function authorInputFor(
  ticket: Ticket,
  manifest: ReferenceManifest | null,
): {
  readonly input: CreativeContractAuthorInput;
  readonly resolver: CreativeEvidenceResolver;
  readonly warnings: readonly string[];
} {
  const facts: CreativeAuthorFact[] = [];
  const resolutions = new Map<string, { readonly sha256: string; readonly excerptSha256: string }>();
  const warnings: string[] = [];
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

  const ticketFacts: CreativeAuthorFact[] = [];
  const ownerProse = ticketProse(stripPlanBlock(ticket.brief));
  // Reserve ten ticket-fact slots for late plan answers and enough prompt room
  // for the closed vocabularies plus the twenty reference-fact ceiling.
  for (const [index, statement] of boundedFactStatements("Owner brief", ownerProse, 18).entries()) {
    ticketFacts.push(add(
      `ticket.goal.${String(index + 1)}`,
      "goal",
      statement,
      "owner_message",
      `ticket:${ticket.id}:brief:${String(index + 1)}`,
      ticket.sha256,
    ));
  }
  const answerStatements = foldedPlanAnswerStatements(ticket.brief);
  for (const [index, statement] of answerStatements.slice(0, 10).entries()) {
    ticketFacts.push(add(
      `ticket.plan-answer.${String(index + 1)}`,
      "constraint",
      statement,
      "owner_message",
      `ticket:${ticket.id}:plan-answer:${String(index + 1)}`,
      ticket.sha256,
    ));
  }
  const designFact = add(
    "host.web-surface",
    "technical_constraint",
    "The host classified this ticket as a browser-visible interface. The delivered page must expose deterministic route, section, and motion data markers for rendered capture.",
    "brief_artifact",
    `ticket:${ticket.id}:surface`,
    ticket.sha256,
  );
  const referenceFacts: CreativeAuthorFact[] = [];
  const pushReference = (
    id: string,
    kind: CreativeAuthorFact["kind"],
    statement: string,
    locator: string,
    sha256 = ticket.sha256,
  ): void => {
    if (referenceFacts.length >= 20) return;
    referenceFacts.push(add(id, kind, statement, "brief_artifact", locator, sha256));
  };
  const rawCapture = manifest?.capture as unknown;
  if (rawCapture !== null && rawCapture !== undefined) {
    const capture = recordOf(rawCapture);
    const outline = recordOf(capture?.["outline"]);
    let malformed = capture === null || outline === null;
    const outlineUrl = typeof outline?.["url"] === "string"
      ? outline["url"]
      : typeof capture?.["url"] === "string" ? capture["url"] : null;
    const outlineTitle = typeof outline?.["title"] === "string" ? outline["title"] : null;
    if (outlineUrl !== null) {
      pushReference(
        "reference.capture.overview",
        "reference_copy",
        `Captured page address: ${outlineUrl}. Captured page title: ${outlineTitle || "No title was extracted."}`,
        `ticket:${ticket.id}:capture:overview`,
      );
    } else {
      malformed = true;
    }
    const rawHeadings = outline?.["headings"];
    const headings = Array.isArray(rawHeadings)
      ? rawHeadings.flatMap((value) => {
          const heading = recordOf(value);
          return heading !== null && Number.isInteger(heading["level"]) && typeof heading["text"] === "string"
            ? [{ level: heading["level"] as number, text: heading["text"] }]
            : [];
        })
      : [];
    if (!Array.isArray(rawHeadings) || headings.length !== rawHeadings.length) malformed = true;
    for (const [index, statement] of boundedFactStatements(
      "Captured headings in document order",
      headings.map((heading) => `h${String(heading.level)}: ${heading.text}`).join("; "),
      3,
    ).entries()) {
      pushReference(
        `reference.capture.headings.${String(index + 1)}`,
        "reference_layout",
        statement,
        `ticket:${ticket.id}:capture:headings:${String(index + 1)}`,
      );
    }
    const links = stringListOf(outline?.["links"]);
    if (links === null) malformed = true;
    for (const [index, statement] of boundedFactStatements(
      "Captured link labels",
      (links ?? []).join("; "),
      1,
    ).entries()) {
      pushReference(
        `reference.capture.links.${String(index + 1)}`,
        "reference_copy",
        statement,
        `ticket:${ticket.id}:capture:links:${String(index + 1)}`,
      );
    }
    const palette = stringListOf(outline?.["palette"]);
    if (palette === null) malformed = true;
    if ((palette?.length ?? 0) > 0) {
      pushReference(
        "reference.capture.palette",
        "reference_color",
        `Colours extracted from the captured page markup, most used first: ${(palette ?? []).join(", ")}`,
        `ticket:${ticket.id}:capture:palette`,
      );
    }
    if (malformed) {
      boundedWarning(warnings, "capture-partial", "malformed optional capture fields or entries were skipped");
    }
  }
  const rawMotion = manifest?.motion as unknown;
  if (rawMotion !== null && rawMotion !== undefined) {
    const motion = recordOf(rawMotion);
    let malformed = motion === null;
    const motionUrl = typeof motion?.["url"] === "string" ? motion["url"] : null;
    const libraries = stringListOf(motion?.["libraries"]);
    const respectsReducedMotion = typeof motion?.["respectsReducedMotion"] === "boolean"
      ? motion["respectsReducedMotion"]
      : null;
    if (motionUrl !== null && libraries !== null && respectsReducedMotion !== null) {
      pushReference(
        "reference.motion.overview",
        "reference_motion",
        `Motion reference address: ${motionUrl}. Detected libraries: ${libraries.join(", ") || "none"}. Reduced-motion respected: ${respectsReducedMotion ? "yes" : "no"}.`,
        `ticket:${ticket.id}:motion:overview`,
      );
    } else {
      malformed = true;
    }
    const rawEntries = motion?.["entries"];
    const validEntries = Array.isArray(rawEntries)
      ? rawEntries.flatMap((value) => {
          const entry = recordOf(value);
          const props = stringListOf(entry?.["props"]);
          const durationMs = finiteNumberOrNull(entry?.["durationMs"]);
          const staggerMs = finiteNumberOrNull(entry?.["staggerMs"]);
          const iterations = finiteNumberOrNull(entry?.["iterations"]);
          const scrollRatio = finiteNumberOrNull(entry?.["scrollRatio"]);
          const easing = entry?.["easing"];
          if (
            entry === null || typeof entry["family"] !== "string" || typeof entry["role"] !== "string" ||
            props === null || durationMs === null || durationMs === undefined || staggerMs === undefined ||
            (easing !== null && typeof easing !== "string") || iterations === undefined || scrollRatio === undefined ||
            typeof entry["parity"] !== "boolean"
          ) return [];
          return [{
            family: entry["family"], role: entry["role"], props, durationMs, staggerMs,
            easing, iterations, scrollRatio, parity: entry["parity"],
          }];
        })
      : [];
    if (!Array.isArray(rawEntries) || validEntries.length !== rawEntries.length) malformed = true;
    const entries = validEntries.map((entry) =>
      `${entry.family} on ${entry.role}; properties ${entry.props.join("+")}; duration ${String(entry.durationMs)}ms; ` +
      `stagger ${entry.staggerMs === null ? "none" : `${String(entry.staggerMs)}ms`}; easing ${entry.easing ?? "unspecified"}; ` +
      `iterations ${entry.iterations === null ? "unspecified" : String(entry.iterations)}; ` +
      `scroll ratio ${entry.scrollRatio === null ? "none" : String(entry.scrollRatio)}; parity ${entry.parity ? "required" : "presence-only"}`
    ).join(". ");
    for (const [index, statement] of boundedFactStatements("Observed reference motion", entries, 3).entries()) {
      pushReference(
        `reference.motion.entries.${String(index + 1)}`,
        "reference_motion",
        statement,
        `ticket:${ticket.id}:motion:entries:${String(index + 1)}`,
      );
    }
    if (malformed) {
      boundedWarning(warnings, "motion-partial", "malformed optional motion fields or entries were skipped");
    }
  }
  for (const [index, value] of (manifest?.images ?? []).entries()) {
    const image = recordOf(value);
    if (image === null || typeof image["path"] !== "string" || typeof image["sha256"] !== "string") {
      boundedWarning(warnings, "image-partial", "a malformed optional reference image entry was skipped");
      continue;
    }
    pushReference(
      `reference.image.${String(index + 1)}`,
      "reference_imagery",
      `The owner attached reference image ${basename(image["path"])}; its bytes are identified by the admitted digest.`,
      `reference:image:${String(index + 1)}`,
      image["sha256"],
    );
  }
  for (const [index, value] of manifestDocuments(manifest).entries()) {
    const document = recordOf(value);
    if (document === null || typeof document["mediaType"] !== "string" || typeof document["sha256"] !== "string") {
      boundedWarning(warnings, "document-partial", "a malformed optional reference document entry was skipped");
      continue;
    }
    pushReference(
      `reference.document.${String(index + 1)}`,
      "content_claim",
      `The owner attached a ${document["mediaType"]} reference document identified by the admitted digest.`,
      `reference:document:${String(index + 1)}`,
      document["sha256"],
    );
  }
  return {
    input: {
      contractId: `creative-${ticket.id}`,
      ticket: { id: ticket.id, sha256: ticket.sha256, facts: ticketFacts },
      designFacts: [designFact],
      referenceFacts,
    },
    resolver: { resolve(reference) { return resolutions.get(canonicalJson(reference)) ?? null; } },
    warnings,
  };
}

export function persistCreativeAuthorResult(
  resultsDir: string,
  result: CreativeContractAuthorResult,
): CreativeCompileRecord {
  atomicJson(join(resultsDir, CREATIVE_AUTHOR_FILE), authorRecordWithoutRawText(result));
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

/**
 * Durable record of ONE author attempt (see `creativeAuthorAttemptFile`). Lives
 * here because `atomicJson` is private to this module. Writes nothing else: the
 * canonical author, contract and compile files are `persistCreativeAuthorResult`'s,
 * so an invalid attempt file beside a compiled canonical record leaves
 * `freshCreativeContract` fresh, and a compiled attempt file beside an invalid
 * canonical record does not make it fresh.
 *
 * PER PHASE ENTRY, ON PURPOSE. A resumed entry's attempt 1 overwrites the
 * previous entry's attempt 1: Resume hands the author a fresh three-attempt
 * budget (an owner pressed it), and the count that was spent is in the event
 * log and the park sentence, not in a counter this file carries forward.
 *
 * THE OUTPUT TEXT GOES BESIDE THE RECORD, NOT IN IT. A non-empty `rawText`
 * is written as `creativeAuthorAttemptTextFile(attempt)` and stripped from
 * the JSON; a null or empty one writes no `.txt`, and a stale `.txt` from a
 * previous entry's same-numbered attempt is removed so the pair on disk
 * always describes one call. Redacted again on the way out (idempotent) so
 * this writer has the same chokepoint as `atomicJson`.
 */
export function persistCreativeAuthorAttempt(
  resultsDir: string,
  attempt: number,
  result: CreativeContractAuthorResult,
): void {
  atomicJson(join(resultsDir, creativeAuthorAttemptFile(attempt)), authorRecordWithoutRawText(result));
  const textPath = join(resultsDir, creativeAuthorAttemptTextFile(attempt));
  if (typeof result.rawText === "string" && result.rawText.length > 0) atomicText(textPath, redactForPersistence(result.rawText));
  else if (existsSync(textPath)) unlinkSync(textPath);
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
