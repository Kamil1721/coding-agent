/** Durable, raw-document-free record for the independent Context7 review. */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  CONTEXT7_QUERY_TOOL,
  CONTEXT7_RESOLVE_TOOL,
  CONTEXT7_SERVER,
  INDEPENDENT_REVIEW_SEAT,
  compileReviewCapabilitySet,
  expectedContext7ObligationHashes,
} from "./context7-review.js";
import type { Context7ReviewOutcome, ReviewScope } from "./context7-review.js";
import type { Context7SourceSnapshot } from "./context7-pipeline.js";

export const CONTEXT7_REVIEW_RECORD_FILE = "context7-review.json";

export interface Context7ReviewRecord {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scope: ReviewScope;
  readonly source: Omit<Context7SourceSnapshot, "text">;
  readonly outcome: Context7ReviewOutcome;
}

export function writeContext7ReviewRecord(resultsDir: string, record: Context7ReviewRecord): void {
  const target = join(resultsDir, CONTEXT7_REVIEW_RECORD_FILE);
  const temporary = join(resultsDir, `.${CONTEXT7_REVIEW_RECORD_FILE}.${String(process.pid)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as readonly string[];
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

const LIFECYCLE_STATES = new Set([
  "planned",
  "granted",
  "connected",
  "attempted",
  "succeeded",
  "failed",
  "denied",
  "satisfied",
  "unsatisfied",
]);

const OUTCOME_CODES = new Set([
  "pilot_not_enabled",
  "server_unavailable",
  "tool_unavailable",
  "tool_not_allowlisted",
  "claim_not_routed",
  "tool_error",
  "session_error",
  "bootstrap_protocol_error",
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
  "required_evidence_missing",
  "source_unavailable",
  "source_incomplete",
  "scope_unavailable",
]);
const DENIED_LIFECYCLE_CODES = new Set(["tool_not_allowlisted", "claim_not_routed"]);
const FAILED_LIFECYCLE_CODES = new Set(["tool_error", "session_error", "bootstrap_protocol_error"]);
const UNSATISFIED_LIFECYCLE_CODES = new Set([
  "pilot_not_enabled",
  "server_unavailable",
  "tool_unavailable",
  "bootstrap_protocol_error",
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
  "required_evidence_missing",
]);
const CAPABILITY_UNAVAILABLE_CODES = new Set(["pilot_not_enabled", "server_unavailable", "tool_unavailable"]);
const FAILED_OUTCOME_CODES = new Set(["session_error", "bootstrap_protocol_error"]);
const UNSATISFIED_OUTCOME_CODES = new Set([
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
  "required_evidence_missing",
  "source_unavailable",
  "source_incomplete",
  "scope_unavailable",
]);
const PREFLIGHT_OUTCOME_CODES = new Set(["source_unavailable", "source_incomplete", "scope_unavailable"]);
const INTERNAL_UNSATISFIED_OUTCOME_CODES = new Set([
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
]);
const COMPLETION_TERMINAL_CODES = new Set([
  "pilot_not_enabled",
  "server_unavailable",
  "tool_unavailable",
  "session_error",
  "bootstrap_protocol_error",
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
  "required_evidence_missing",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTEXT7_TOOL_NAMES = new Set([CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL]);

function outcomeCode(value: unknown): boolean {
  return value === null || (typeof value === "string" && OUTCOME_CODES.has(value));
}

function lifecycleShape(
  state: unknown,
  tool: unknown,
  code: unknown,
  hashes: readonly string[],
  claimId: unknown,
): boolean {
  if (
    typeof state !== "string" ||
    !LIFECYCLE_STATES.has(state) ||
    !nullableString(tool) ||
    !nullableString(claimId)
  ) {
    return false;
  }
  const noResult = hashes.length === 0;
  if (["planned", "granted", "connected"].includes(state)) {
    return tool === null && claimId === null && code === null && noResult;
  }
  if (state === "attempted") return tool !== null && claimId !== null && code === null && noResult;
  if (state === "succeeded") return tool !== null && claimId !== null && code === null && hashes.length === 1;
  if (state === "denied") {
    return tool !== null && typeof code === "string" && DENIED_LIFECYCLE_CODES.has(code) && noResult;
  }
  if (state === "failed") {
    if (typeof code !== "string" || !FAILED_LIFECYCLE_CODES.has(code) || !noResult) return false;
    return code === "tool_error" ? tool !== null && claimId !== null : tool === null && claimId === null;
  }
  if (state === "satisfied") return tool === null && claimId === null && code === null;
  return (
    state === "unsatisfied" &&
    tool === null &&
    claimId === null &&
    (code === null || (typeof code === "string" && UNSATISFIED_LIFECYCLE_CODES.has(code)))
  );
}

function outcomeStatusCode(status: unknown, code: unknown): boolean {
  if (status === "completed") return code === null;
  if (typeof code !== "string") return false;
  if (status === "capability_unavailable") return CAPABILITY_UNAVAILABLE_CODES.has(code);
  if (status === "failed") return FAILED_OUTCOME_CODES.has(code);
  return status === "unsatisfied" && UNSATISFIED_OUTCOME_CODES.has(code);
}

function reviewClaim(value: unknown): boolean {
  const claim = object(value);
  if (claim === null || typeof claim["id"] !== "string") return false;
  if (claim["kind"] === "internal") return typeof claim["subject"] === "string";
  return (
    claim["kind"] === "external" &&
    typeof claim["package"] === "string" &&
    nullableString(claim["versionOrRange"]) &&
    typeof claim["queryPurpose"] === "string"
  );
}

function finding(value: unknown): boolean {
  const row = object(value);
  return (
    row !== null &&
    typeof row["claimId"] === "string" &&
    ["info", "warning", "error"].includes(String(row["severity"])) &&
    typeof row["title"] === "string" &&
    typeof row["detail"] === "string"
  );
}

function verdict(value: unknown): boolean {
  if (value === null) return true;
  const row = object(value);
  if (
    row === null ||
    !["pass", "fail"].includes(String(row["verdict"])) ||
    typeof row["summary"] !== "string" ||
    !Array.isArray(row["findings"]) ||
    !row["findings"].every(finding) ||
    !Array.isArray(row["evidence"])
  ) {
    return false;
  }
  return row["evidence"].every((entry) => typeof object(entry)?.["claimId"] === "string");
}

function evidenceProjection(value: unknown): boolean {
  const row = object(value);
  return (
    row !== null &&
    typeof row["claimId"] === "string" &&
    typeof row["package"] === "string" &&
    nullableString(row["versionOrRange"]) &&
    typeof row["queryPurpose"] === "string" &&
    typeof row["success"] === "boolean" &&
    typeof row["evidenceHash"] === "string" &&
    SHA256.test(row["evidenceHash"]) &&
    row["seat"] === INDEPENDENT_REVIEW_SEAT
  );
}

function lifecycleEvent(value: unknown): boolean {
  const row = object(value);
  const hashes = stringArray(row?.["producedArtefactHashes"]);
  return (
    row !== null &&
    hashes !== null &&
    row["seat"] === INDEPENDENT_REVIEW_SEAT &&
    typeof row["obligationHash"] === "string" &&
    SHA256.test(row["obligationHash"]) &&
    nullableString(row["claimId"]) &&
    row["server"] === CONTEXT7_SERVER &&
    nullableString(row["tool"]) &&
    (row["tool"] === null || CONTEXT7_TOOL_NAMES.has(String(row["tool"]))) &&
    typeof row["state"] === "string" &&
    LIFECYCLE_STATES.has(String(row["state"])) &&
    outcomeCode(row["code"]) &&
    hashes.every((hash) => SHA256.test(hash)) &&
    lifecycleShape(row["state"], row["tool"], row["code"], hashes, row["claimId"])
  );
}

type LifecycleEvent = Context7ReviewOutcome["lifecycle"][number];

function lifecycleByObligation(
  lifecycle: readonly LifecycleEvent[],
  obligations: ReadonlySet<string>,
): ReadonlyMap<string, readonly LifecycleEvent[]> {
  const grouped = new Map<string, LifecycleEvent[]>([...obligations].map((hash) => [hash, []]));
  for (const row of lifecycle) grouped.get(row.obligationHash)?.push(row);
  return grouped;
}

function claimToolKey(claimId: string, tool: string): string {
  return JSON.stringify([claimId, tool]);
}

function consumeAttempt(pending: Map<string, number>, claimId: string, tool: string): boolean {
  const key = claimToolKey(claimId, tool);
  const count = pending.get(key) ?? 0;
  if (count === 0) return false;
  if (count === 1) pending.delete(key);
  else pending.set(key, count - 1);
  return true;
}

function lifecycleOrderingValid(
  lifecycle: readonly LifecycleEvent[],
  obligations: ReadonlySet<string>,
): boolean {
  for (const rows of lifecycleByObligation(lifecycle, obligations).values()) {
    if (rows.length === 0) continue;
    if (rows[0]?.state !== "planned") return false;
    const pending = new Map<string, number>();
    const resolvedClaims = new Set<string>();
    let granted = false;
    let connected = false;
    let terminal = false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined || terminal) return false;
      if (row.state === "planned") {
        if (index !== 0) return false;
      } else if (row.state === "granted") {
        if (granted) return false;
        granted = true;
      } else if (row.state === "connected") {
        if (!granted || connected) return false;
        connected = true;
      } else if (row.state === "attempted") {
        if (!connected || row.tool === null || row.claimId === null) return false;
        if (row.tool === CONTEXT7_QUERY_TOOL && !resolvedClaims.has(row.claimId)) return false;
        const key = claimToolKey(row.claimId, row.tool);
        pending.set(key, (pending.get(key) ?? 0) + 1);
      } else if (row.state === "succeeded") {
        if (!connected || row.tool === null || row.claimId === null || !consumeAttempt(pending, row.claimId, row.tool)) return false;
        if (row.tool === CONTEXT7_QUERY_TOOL && !resolvedClaims.has(row.claimId)) return false;
        if (row.tool === CONTEXT7_RESOLVE_TOOL) resolvedClaims.add(row.claimId);
      } else if (row.state === "failed") {
        if (row.tool !== null && !connected) return false;
        if (row.tool !== null && (row.claimId === null || !consumeAttempt(pending, row.claimId, row.tool))) return false;
        terminal = row.code === "session_error" || row.code === "bootstrap_protocol_error";
      } else if (row.state === "satisfied") {
        if (!connected) return false;
        if (pending.size > 0) return false;
        terminal = true;
      } else if (row.state === "unsatisfied") {
        if (pending.size > 0) return false;
      }
      if (terminal && index !== rows.length - 1) return false;
    }
  }
  return true;
}

function finalRowsMatch(
  lifecycle: readonly LifecycleEvent[],
  obligations: ReadonlySet<string>,
  predicate: (row: LifecycleEvent) => boolean,
): boolean {
  if (obligations.size === 0) return false;
  const grouped = lifecycleByObligation(lifecycle, obligations);
  return [...obligations].every((hash) => {
    const rows = grouped.get(hash) ?? [];
    const final = rows.at(-1);
    return final !== undefined && predicate(final);
  });
}

function outcomeHistoryValid(
  outcome: Context7ReviewOutcome,
  obligations: ReadonlySet<string>,
  externalCount: number,
): boolean {
  if (!lifecycleOrderingValid(outcome.lifecycle, obligations)) return false;
  if (typeof outcome.code === "string" && PREFLIGHT_OUTCOME_CODES.has(outcome.code)) {
    return outcome.status === "unsatisfied" && outcome.lifecycle.length === 0 && outcome.evidence.length === 0;
  }
  if (externalCount === 0) {
    if (obligations.size !== 0 || outcome.lifecycle.length !== 0 || outcome.evidence.length !== 0) return false;
    return (
      outcome.status === "completed" ||
      outcome.status === "failed" ||
      (outcome.status === "unsatisfied" &&
        typeof outcome.code === "string" &&
        INTERNAL_UNSATISFIED_OUTCOME_CODES.has(outcome.code))
    );
  }
  if (outcome.status === "capability_unavailable") {
    if (outcome.verdict !== null || outcome.evidence.length > 0) return false;
    if (outcome.lifecycle.some((row) => ["attempted", "succeeded", "failed", "denied", "satisfied"].includes(row.state))) {
      return false;
    }
    const final = finalRowsMatch(
      outcome.lifecycle,
      obligations,
      (row) => row.state === "unsatisfied" && row.code === outcome.code,
    );
    return final && outcome.lifecycle.filter((row) => row.state === "unsatisfied").length === obligations.size;
  }
  if (outcome.status === "failed") {
    if (outcome.verdict !== null || outcome.evidence.length > 0) return false;
    if (
      outcome.lifecycle.some(
        (row) =>
          row.state === "unsatisfied" &&
          !(outcome.code === "bootstrap_protocol_error" && row.code === "bootstrap_protocol_error"),
      )
    ) {
      return false;
    }
    const final = finalRowsMatch(
      outcome.lifecycle,
      obligations,
      (row) => row.state === "failed" && row.code === outcome.code,
    );
    const terminalFailures = outcome.lifecycle.filter(
      (row) => row.state === "failed" && (row.code === "session_error" || row.code === "bootstrap_protocol_error"),
    );
    return final && terminalFailures.length === obligations.size;
  }
  if (outcome.status === "unsatisfied") {
    if (outcome.evidence.length > 0 && outcome.code !== "required_evidence_missing") return false;
    const final = finalRowsMatch(
      outcome.lifecycle,
      obligations,
      (row) => row.state === "unsatisfied" && row.code === outcome.code,
    );
    return final && outcome.lifecycle.filter((row) => row.state === "unsatisfied").length === obligations.size;
  }
  if (outcome.lifecycle.some((row) => typeof row.code === "string" && COMPLETION_TERMINAL_CODES.has(row.code))) {
    return false;
  }
  const final = finalRowsMatch(
    outcome.lifecycle,
    obligations,
    (row) => row.state === "satisfied" && row.code === null,
  );
  const finalStates = outcome.lifecycle.filter((row) => row.state === "satisfied" || row.state === "unsatisfied");
  return final && finalStates.length === obligations.size;
}

function sourceStateMatchesOutcome(
  source: Context7ReviewRecord["source"],
  outcome: Context7ReviewOutcome,
): boolean {
  // Scope compilation has precedence in the producer, so scope_unavailable may
  // legitimately accompany any source snapshot (including a missing workspace).
  if (outcome.code === "scope_unavailable") return true;
  if (source.files.length === 0) return outcome.code === "source_unavailable";
  if (source.truncated) return outcome.code === "source_incomplete";
  return outcome.code !== "source_unavailable" && outcome.code !== "source_incomplete";
}

/**
 * Validate the envelope and the fields the API renders. The outcome was written
 * by the host-owned runner; an unknown vocabulary is treated as an unreadable
 * record instead of being painted as a success.
 */
export function readContext7ReviewRecord(resultsDir: string): Context7ReviewRecord | null {
  const path = join(resultsDir, CONTEXT7_REVIEW_RECORD_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const record = object(raw);
  const scope = object(record?.["scope"]);
  const source = object(record?.["source"]);
  const outcome = object(record?.["outcome"]);
  if (
    record?.["schemaVersion"] !== 1 ||
    typeof record["startedAt"] !== "string" ||
    typeof record["completedAt"] !== "string" ||
    scope === null ||
    typeof scope["projectId"] !== "string" ||
    !Array.isArray(scope["claims"]) ||
    scope["claims"].length === 0 ||
    !scope["claims"].every(reviewClaim) ||
    source === null ||
    typeof source["sourceHash"] !== "string" ||
    !SHA256.test(source["sourceHash"]) ||
    stringArray(source["files"]) === null ||
    typeof source["bytes"] !== "number" ||
    !Number.isFinite(source["bytes"]) ||
    source["bytes"] < 0 ||
    typeof source["truncated"] !== "boolean" ||
    outcome === null ||
    !["completed", "capability_unavailable", "unsatisfied", "failed"].includes(String(outcome["status"])) ||
    !["not_applicable", "suggested", "required"].includes(String(outcome["capabilityApplicability"])) ||
    !outcomeStatusCode(outcome["status"], outcome["code"]) ||
    !verdict(outcome["verdict"]) ||
    !Array.isArray(outcome["evidence"]) ||
    !outcome["evidence"].every(evidenceProjection) ||
    !Array.isArray(outcome["lifecycle"]) ||
    !outcome["lifecycle"].every(lifecycleEvent)
  ) {
    return null;
  }
  const hasVerdict = outcome["verdict"] !== null;
  if ((outcome["status"] === "completed") !== hasVerdict) return null;
  const parsed = raw as Context7ReviewRecord;
  const typed: Context7ReviewRecord = {
    schemaVersion: 1,
    startedAt: parsed.startedAt,
    completedAt: parsed.completedAt,
    scope: {
      projectId: parsed.scope.projectId,
      claims: parsed.scope.claims.map((claim) => claim.kind === "internal"
        ? { kind: "internal", id: claim.id, subject: claim.subject }
        : {
            kind: "external",
            id: claim.id,
            package: claim.package,
            versionOrRange: claim.versionOrRange,
            queryPurpose: claim.queryPurpose,
          }),
    },
    source: {
      sourceHash: parsed.source.sourceHash,
      files: [...parsed.source.files],
      bytes: parsed.source.bytes,
      truncated: parsed.source.truncated,
    },
    outcome: {
      status: parsed.outcome.status,
      capabilityApplicability: parsed.outcome.capabilityApplicability,
      code: parsed.outcome.code,
      verdict: parsed.outcome.verdict === null ? null : {
        verdict: parsed.outcome.verdict.verdict,
        summary: parsed.outcome.verdict.summary,
        findings: parsed.outcome.verdict.findings.map((row) => ({
          claimId: row.claimId,
          severity: row.severity,
          title: row.title,
          detail: row.detail,
        })),
        evidence: parsed.outcome.verdict.evidence.map((row) => ({ claimId: row.claimId })),
      },
      evidence: parsed.outcome.evidence.map((row) => ({
        claimId: row.claimId,
        package: row.package,
        versionOrRange: row.versionOrRange,
        queryPurpose: row.queryPurpose,
        success: row.success,
        evidenceHash: row.evidenceHash,
        seat: row.seat,
      })),
      lifecycle: parsed.outcome.lifecycle.map((row) => ({
        seat: row.seat,
        obligationHash: row.obligationHash,
        claimId: row.claimId,
        server: row.server,
        tool: row.tool,
        state: row.state,
        code: row.code,
        producedArtefactHashes: [...row.producedArtefactHashes],
      })),
    },
  };
  if (typed.scope.claims.length === 0) return null;
  if (!sourceStateMatchesOutcome(typed.source, typed.outcome)) return null;
  const ids = typed.scope.claims.map((claim) => claim.id);
  if (new Set(ids).size !== ids.length) return null;
  const claimIds = new Set(typed.scope.claims.map((claim) => claim.id));
  const external = typed.scope.claims.filter((claim) => claim.kind === "external");
  const externalIds = new Set(external.map((claim) => claim.id));
  const externalById = new Map(external.map((claim) => [claim.id, claim]));
  let expectedApplicability: Context7ReviewOutcome["capabilityApplicability"];
  let expectedObligations: ReadonlySet<string>;
  try {
    expectedApplicability = compileReviewCapabilitySet(typed.scope).applicability;
    expectedObligations = new Set(expectedContext7ObligationHashes(typed.scope));
  } catch {
    return null;
  }
  const notApplicable = expectedApplicability === "not_applicable";
  if (typed.outcome.lifecycle.some((row) => !expectedObligations.has(row.obligationHash))) return null;
  if (typed.outcome.lifecycle.some((row) => row.claimId !== null && !externalIds.has(row.claimId))) return null;
  if (typed.outcome.capabilityApplicability !== expectedApplicability) return null;
  if (!outcomeHistoryValid(typed.outcome, expectedObligations, external.length)) return null;
  const evidenceClaimIds = typed.outcome.evidence.map((row) => row.claimId);
  if (new Set(evidenceClaimIds).size !== evidenceClaimIds.length) return null;
  if (
    typed.outcome.evidence.some((row) => {
      const claim = externalById.get(row.claimId);
      return (
        !row.success ||
        claim === undefined ||
        row.package !== claim.package ||
        row.versionOrRange !== claim.versionOrRange ||
        row.queryPurpose !== claim.queryPurpose
      );
    })
  ) {
    return null;
  }
  if (
    typed.outcome.verdict?.findings.some((row) => !claimIds.has(row.claimId)) === true ||
    typed.outcome.verdict?.evidence.some((row) => !externalIds.has(row.claimId)) === true
  ) {
    return null;
  }
  const queryHashesByClaim = new Map<string, Set<string>>();
  for (const row of typed.outcome.lifecycle) {
    if (row.state !== "succeeded" || row.tool !== CONTEXT7_QUERY_TOOL || row.claimId === null) continue;
    const hashes = queryHashesByClaim.get(row.claimId) ?? new Set<string>();
    for (const hash of row.producedArtefactHashes) hashes.add(hash);
    queryHashesByClaim.set(row.claimId, hashes);
  }
  if (
    typed.outcome.evidence.some(
      (row) => queryHashesByClaim.get(row.claimId)?.has(row.evidenceHash) !== true,
    )
  ) {
    return null;
  }
  if (notApplicable) {
    if (typed.outcome.lifecycle.length > 0 || typed.outcome.evidence.length > 0) return null;
    if ((typed.outcome.verdict?.evidence.length ?? 0) > 0) return null;
  }
  if (typed.outcome.status === "completed") {
    if (typed.outcome.code !== null) return null;
    if (typed.outcome.evidence.length !== external.length || typed.outcome.evidence.some((row) => !row.success)) return null;
    if (
      external.some(
        (claim) =>
          typed.outcome.evidence.filter(
            (row) =>
              row.success &&
              row.claimId === claim.id &&
              row.package === claim.package &&
              row.versionOrRange === claim.versionOrRange &&
              row.queryPurpose === claim.queryPurpose,
          ).length !== 1,
      )
    ) {
      return null;
    }
    const finalRows = [...lifecycleByObligation(typed.outcome.lifecycle, expectedObligations).values()]
      .map((rows) => rows.at(-1))
      .filter((row): row is LifecycleEvent => row !== undefined);
    const verdictRefs = typed.outcome.verdict?.evidence.map((row) => row.claimId) ?? [];
    if (new Set(verdictRefs).size !== verdictRefs.length) return null;
    if (external.some((claim) => verdictRefs.filter((id) => id === claim.id).length !== 1)) return null;
    const evidenceHashes = new Set(typed.outcome.evidence.filter((row) => row.success).map((row) => row.evidenceHash));
    if (finalRows.some((row) => {
      const hashes = new Set(row.producedArtefactHashes);
      return hashes.size !== evidenceHashes.size || [...evidenceHashes].some((hash) => !hashes.has(hash));
    })) return null;
    const lifecycleHashes = new Set(
      finalRows.flatMap((row) => row.producedArtefactHashes),
    );
    if (evidenceHashes.size !== lifecycleHashes.size || [...evidenceHashes].some((hash) => !lifecycleHashes.has(hash))) return null;
    if (
      typed.outcome.evidence.some(
        (row) => queryHashesByClaim.get(row.claimId)?.has(row.evidenceHash) !== true,
      )
    ) {
      return null;
    }
  } else if (typed.outcome.code === null) {
    return null;
  }
  return typed;
}
