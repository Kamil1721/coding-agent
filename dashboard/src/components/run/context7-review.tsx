import type { ReactNode } from "react";

import type {
  Context7Evidence,
  Context7Lifecycle,
  Context7Review,
} from "@/lib/api-types";
import type { Tone } from "@/lib/presentation";
import { Badge, Panel, cx } from "@/components/ui";

interface StatusCopy {
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string;
}

const CAPABILITY_UNAVAILABLE_CODES = new Set([
  "pilot_not_enabled",
  "server_unavailable",
  "tool_unavailable",
]);
const FAILED_CODES = new Set(["session_error", "bootstrap_protocol_error"]);
const CONTEXT7_TOOLS = new Set([
  "mcp__context7__resolve-library-id",
  "mcp__context7__query-docs",
]);
const DENIED_CODES = new Set(["tool_not_allowlisted", "claim_not_routed"]);
const UNSATISFIED_CODES = new Set([
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
  "required_evidence_missing",
  "source_unavailable",
  "source_incomplete",
  "scope_unavailable",
]);
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
const PREFLIGHT_CODES = new Set(["source_unavailable", "source_incomplete", "scope_unavailable"]);
const CONTINUABLE_BOOTSTRAP_CODES = new Set(["server_unavailable", "tool_unavailable"]);
const INDEPENDENT_REVIEW_SEAT = "independent_code_review";
const CONTEXT7_SERVER = "context7";
const INTERNAL_NONPREFLIGHT_UNSATISFIED_CODES = new Set([
  "missing_structured_output",
  "invalid_structured_output",
  "raw_evidence_in_output",
]);

function statusCodeMatches(status: string, code: unknown): boolean {
  if (status === "completed") return code === null;
  if (typeof code !== "string") return false;
  if (status === "capability_unavailable") return CAPABILITY_UNAVAILABLE_CODES.has(code);
  if (status === "failed") return FAILED_CODES.has(code);
  return status === "unsatisfied" && UNSATISFIED_CODES.has(code);
}

function sourceStateMatches(source: Context7Review["source"], code: string | null): boolean {
  if (code === "source_unavailable") return source.files.length === 0;
  if (code === "source_incomplete") return source.files.length > 0 && source.truncated;
  if (code === "scope_unavailable") return true;
  return source.files.length > 0 && !source.truncated;
}

function internalOutcomeMatches(status: Context7Review["status"], code: string | null): boolean {
  if (status === "completed" || status === "failed") return true;
  if (status !== "unsatisfied" || code === null) return false;
  return PREFLIGHT_CODES.has(code) || INTERNAL_NONPREFLIGHT_UNSATISFIED_CODES.has(code);
}

function lifecycleEventMatches(event: Context7Lifecycle): boolean {
  const noHashes = event.producedArtefactHashes.length === 0;
  const allowlistedTool = event.tool !== null && CONTEXT7_TOOLS.has(event.tool);
  const hasClaim = event.claimId !== null;

  if (["planned", "granted", "connected"].includes(event.state)) {
    return event.claimId === null && event.tool === null && event.code === null && noHashes;
  }
  if (event.state === "attempted") {
    return hasClaim && allowlistedTool && event.code === null && noHashes;
  }
  if (event.state === "succeeded") {
    return hasClaim && allowlistedTool && event.code === null && event.producedArtefactHashes.length === 1;
  }
  if (event.state === "denied") {
    return allowlistedTool && event.code !== null && DENIED_CODES.has(event.code) && noHashes;
  }
  if (event.state === "failed") {
    if (!noHashes || event.code === null) return false;
    if (event.code === "tool_error") return hasClaim && allowlistedTool;
    return FAILED_CODES.has(event.code) && event.claimId === null && event.tool === null;
  }
  if (event.state === "satisfied") {
    return event.claimId === null && event.tool === null && event.code === null;
  }
  if (event.state === "unsatisfied") {
    return (
      event.claimId === null &&
      event.tool === null &&
      (event.code === null || UNSATISFIED_LIFECYCLE_CODES.has(event.code))
    );
  }
  return false;
}

function equalHashSets(left: readonly string[], right: ReadonlySet<string>): boolean {
  const leftSet = new Set(left);
  return leftSet.size === right.size && [...right].every((hash) => leftSet.has(hash));
}

function lifecycleProofMatches(review: Pick<
  Context7Review,
  "status" | "capabilityApplicability" | "code" | "evidence" | "lifecycle"
>): boolean {
  const { status, capabilityApplicability, code, evidence, lifecycle } = review;
  const notApplicable = capabilityApplicability === "not_applicable";
  const preflight = code !== null && PREFLIGHT_CODES.has(code);
  if (notApplicable || preflight) return lifecycle.length === 0 && evidence.length === 0;
  if ((status === "capability_unavailable" || status === "failed") && evidence.length > 0) return false;
  if (lifecycle.length === 0 || lifecycle[0]?.state !== "planned") return false;
  if (
    status === "completed" &&
    capabilityApplicability === "required" &&
    !lifecycle.some((event) => event.state === "connected")
  ) {
    return false;
  }

  const pendingAttempts = new Map<string, number>();
  const resolvedClaims = new Set<string>();
  const queryHashesByClaim = new Map<string, Set<string>>();
  const preludeRanks: Readonly<Record<string, number>> = { planned: 0, granted: 1, connected: 2 };
  let preludeRank = -1;
  let activityStarted = false;
  for (const [index, event] of lifecycle.entries()) {
    const isFinal = index === lifecycle.length - 1;
    const nextPreludeRank = preludeRanks[event.state];
    if (nextPreludeRank !== undefined) {
      if (activityStarted || nextPreludeRank < preludeRank) return false;
      preludeRank = nextPreludeRank;
      continue;
    }
    activityStarted = true;

    if (event.state === "satisfied" && !isFinal) return false;
    if (
      event.state === "failed" &&
      event.code !== null &&
      FAILED_CODES.has(event.code) &&
      !isFinal
    ) {
      return false;
    }
    if (event.state === "unsatisfied" && event.code !== null && !isFinal) {
      const continuingSuggestedBootstrap =
        capabilityApplicability === "suggested" &&
        CONTINUABLE_BOOTSTRAP_CODES.has(event.code);
      const failedBootstrapPrelude =
        status === "failed" &&
        code === "bootstrap_protocol_error" &&
        event.code === "bootstrap_protocol_error";
      if (!continuingSuggestedBootstrap && !failedBootstrapPrelude) return false;
    }

    if (event.state === "attempted" && event.tool !== null && event.claimId !== null) {
      if (
        event.tool === "mcp__context7__query-docs" &&
        !resolvedClaims.has(event.claimId)
      ) {
        return false;
      }
      const key = JSON.stringify([event.claimId, event.tool]);
      pendingAttempts.set(key, (pendingAttempts.get(key) ?? 0) + 1);
    }
    const isToolResult =
      event.state === "succeeded" ||
      (event.state === "failed" && event.code === "tool_error");
    if (isToolResult && event.tool !== null && event.claimId !== null) {
      const key = JSON.stringify([event.claimId, event.tool]);
      const pending = pendingAttempts.get(key) ?? 0;
      if (pending === 0) return false;
      pendingAttempts.set(key, pending - 1);
      if (event.state === "succeeded" && event.tool === "mcp__context7__resolve-library-id") {
        resolvedClaims.add(event.claimId);
      }
      if (event.state === "succeeded" && event.tool === "mcp__context7__query-docs") {
        const hashes = queryHashesByClaim.get(event.claimId) ?? new Set<string>();
        for (const hash of event.producedArtefactHashes) hashes.add(hash);
        queryHashesByClaim.set(event.claimId, hashes);
      }
    }
  }

  if (
    evidence.some(
      (entry) => !queryHashesByClaim.get(entry.claimId)?.has(entry.evidenceHash),
    )
  ) {
    return false;
  }

  const finalEvent = lifecycle.at(-1);
  if (finalEvent === undefined) return false;
  if (status === "completed") {
    if (finalEvent.state !== "satisfied") return false;
  } else if (status === "failed") {
    if (finalEvent.state !== "failed" || finalEvent.code !== code) return false;
  } else if (finalEvent.state !== "unsatisfied" || finalEvent.code !== code) {
    return false;
  }
  if (
    (finalEvent.state === "satisfied" || finalEvent.state === "unsatisfied") &&
    [...pendingAttempts.values()].some((count) => count > 0)
  ) {
    return false;
  }

  const evidenceHashes = new Set(evidence.map((entry) => entry.evidenceHash));
  if (
    lifecycle.some(
      (event) =>
        event.state === "satisfied" &&
        !equalHashSets(event.producedArtefactHashes, evidenceHashes),
    )
  ) {
    return false;
  }
  if (
    status === "completed" &&
    !equalHashSets(finalEvent.producedArtefactHashes, evidenceHashes)
  ) {
    return false;
  }
  return true;
}

function packageEvidenceKey(row: {
  readonly package: string;
  readonly versionOrRange: string | null;
}): string {
  return JSON.stringify([row.package, row.versionOrRange]);
}

function isContext7Review(value: unknown): value is Context7Review {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const object = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry);
  const nullableString = (entry: unknown): entry is string | null => entry === null || typeof entry === "string";
  const stringArray = (entry: unknown): entry is readonly string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string");
  const sha256 = (entry: unknown): entry is string => typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry);
  const source = row["source"];
  const verdict = row["verdict"];
  const packages = row["packages"];
  const evidence = row["evidence"];
  const lifecycle = row["lifecycle"];
  const status = String(row["status"]);
  const hasVerdict = verdict !== null;
  if ((status === "completed") !== hasVerdict) return false;
  if (!(
    ["completed", "capability_unavailable", "unsatisfied", "failed"].includes(status) &&
    ["not_applicable", "suggested", "required"].includes(String(row["capabilityApplicability"])) &&
    nullableString(row["code"]) &&
    statusCodeMatches(status, row["code"]) &&
    Array.isArray(packages) &&
    packages.every(
      (entry) =>
        object(entry) &&
        typeof entry["package"] === "string" &&
        nullableString(entry["versionOrRange"]),
    ) &&
    Array.isArray(evidence) &&
    evidence.every(
      (entry) =>
        object(entry) &&
        typeof entry["claimId"] === "string" &&
        typeof entry["package"] === "string" &&
        nullableString(entry["versionOrRange"]) &&
        typeof entry["queryPurpose"] === "string" &&
        typeof entry["success"] === "boolean" &&
        sha256(entry["evidenceHash"]) &&
        entry["seat"] === INDEPENDENT_REVIEW_SEAT,
    ) &&
    Array.isArray(lifecycle) &&
    lifecycle.every(
      (entry) =>
        object(entry) &&
        nullableString(entry["claimId"]) &&
        entry["seat"] === INDEPENDENT_REVIEW_SEAT &&
        sha256(entry["obligationHash"]) &&
        entry["server"] === CONTEXT7_SERVER &&
        nullableString(entry["tool"]) &&
        typeof entry["state"] === "string" &&
        nullableString(entry["code"]) &&
        stringArray(entry["producedArtefactHashes"]) &&
        entry["producedArtefactHashes"].every(sha256),
    ) &&
    object(source) &&
    sha256(source["sourceHash"]) &&
    typeof source["bytes"] === "number" &&
    Number.isFinite(source["bytes"]) &&
    source["bytes"] >= 0 &&
    typeof source["truncated"] === "boolean" &&
    stringArray(source["files"]) &&
    (verdict === null || (
      object(verdict) &&
      ["pass", "fail"].includes(String(verdict["verdict"])) &&
      typeof verdict["summary"] === "string" &&
      Array.isArray(verdict["findings"]) &&
      verdict["findings"].every(
        (entry) =>
          object(entry) &&
          typeof entry["claimId"] === "string" &&
          ["info", "warning", "error"].includes(String(entry["severity"])) &&
          typeof entry["title"] === "string" &&
          typeof entry["detail"] === "string",
      ) &&
      Array.isArray(verdict["evidence"]) && verdict["evidence"].every((entry) => object(entry) && typeof entry["claimId"] === "string")
    ))
  )) {
    return false;
  }

  const typedPackages = packages as Context7Review["packages"];
  const typedEvidence = evidence as Context7Review["evidence"];
  const typedLifecycle = lifecycle as Context7Review["lifecycle"];
  const typedSource = source as unknown as Context7Review["source"];
  if (!sourceStateMatches(typedSource, row["code"] as string | null)) return false;
  if (!typedLifecycle.every(lifecycleEventMatches)) return false;
  const notApplicable = row["capabilityApplicability"] === "not_applicable";
  if (notApplicable !== (typedPackages.length === 0)) return false;
  if (notApplicable && !internalOutcomeMatches(
    status as Context7Review["status"],
    row["code"] as string | null,
  )) {
    return false;
  }
  if (typedPackages.length > 0 && row["capabilityApplicability"] !== "required") return false;

  const typedVerdict = verdict as Context7Review["verdict"];
  if (typedVerdict !== null) {
    const verdictClaimIds = typedVerdict.evidence.map((entry) => entry.claimId);
    if (new Set(verdictClaimIds).size !== verdictClaimIds.length) return false;
  }

  const packageKeys = typedPackages.map(packageEvidenceKey);
  if (new Set(packageKeys).size !== packageKeys.length) return false;
  const declaredPackages = new Set(packageKeys);
  const evidenceKeys = typedEvidence.map(packageEvidenceKey);
  if (new Set(evidenceKeys).size !== evidenceKeys.length) return false;
  const evidenceClaimIds = typedEvidence.map((entry) => entry.claimId);
  if (new Set(evidenceClaimIds).size !== evidenceClaimIds.length) return false;
  if (
    typedEvidence.some(
      (entry) => !entry.success || !declaredPackages.has(packageEvidenceKey(entry)),
    )
  ) {
    return false;
  }

  if (
    status === "completed" &&
    typedPackages.length > 0 &&
    (typedEvidence.length !== typedPackages.length ||
      packageKeys.some(
        (key) => evidenceKeys.filter((evidenceKey) => evidenceKey === key).length !== 1,
      ))
  ) {
    return false;
  }

  if (!lifecycleProofMatches({
    status: status as Context7Review["status"],
    capabilityApplicability: row["capabilityApplicability"] as Context7Review["capabilityApplicability"],
    code: row["code"] as string | null,
    evidence: typedEvidence,
    lifecycle: typedLifecycle,
  })) {
    return false;
  }

  return true;
}

const CODE_COPY: Readonly<Record<string, string>> = {
  pilot_not_enabled: "This project was not enabled for the Context7 review pilot.",
  server_unavailable: "Context7 did not connect before the review started.",
  tool_unavailable: "The SDK inventory did not include every required Context7 tool.",
  tool_not_allowlisted: "A tool request was refused because it was outside the review allowlist.",
  claim_not_routed: "A tool request did not match its host-routed package claim.",
  tool_error: "A Context7 request returned no admissible documentation evidence.",
  session_error: "The independent reviewer session stopped before it completed.",
  bootstrap_protocol_error: "The SDK inventory could not be verified safely.",
  missing_structured_output: "The reviewer returned no structured review outcome.",
  invalid_structured_output: "The reviewer output did not match the required review format.",
  raw_evidence_in_output: "The reviewer copied raw source or documentation into its report, so the report was rejected.",
  required_evidence_missing: "At least one external package claim lacks required documentation evidence.",
  source_unavailable: "No readable source was available, so no review outcome was admitted.",
  source_incomplete: "The source snapshot was incomplete, so no review outcome was admitted.",
  scope_unavailable: "The npm package scope could not be established safely, so no review outcome was admitted.",
};

function statusCopy(review: Context7Review): StatusCopy {
  if (review.status === "completed" && review.capabilityApplicability === "not_applicable") {
    return {
      label: "Not applicable",
      tone: "neutral",
      detail: "This review covered repository-internal work only. Context7 tools were not routed or used.",
    };
  }
  if (review.status === "completed") {
    if (review.capabilityApplicability === "suggested") {
      return {
        label: "Review completed",
        tone: "info",
        detail: "Context7 was suggested. The review completed with the documentation evidence shown below.",
      };
    }
    return {
      label: "Evidence complete",
      tone: "pass",
      detail: "Every required external package claim has admitted documentation evidence.",
    };
  }
  if (review.status === "unsatisfied") {
    return {
      label: "Evidence missing",
      tone: "warn",
      detail: codeDetail(review.code, "The reviewer could not admit an outcome because its evidence requirement was not met."),
    };
  }
  if (review.status === "capability_unavailable") {
    return {
      label: "Unavailable",
      tone: "warn",
      detail: codeDetail(review.code, "The required documentation capability was unavailable."),
    };
  }
  return {
    label: "Review stopped",
    tone: "warn",
    detail: codeDetail(review.code, "The independent reviewer stopped before it could finish."),
  };
}

function codeDetail(code: string | null, fallback: string): string {
  if (code === null) return fallback;
  return CODE_COPY[code] ?? `${fallback} Recorded code: ${code}.`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function evidenceFor(
  evidence: readonly Context7Evidence[],
  packageName: string,
  versionOrRange: string | null,
): Context7Evidence | null {
  return (
    evidence.find(
      (entry) => entry.package === packageName && entry.versionOrRange === versionOrRange,
    ) ?? null
  );
}

function lifecycleTone(state: string): Tone {
  if (state === "succeeded" || state === "satisfied") return "pass";
  if (state === "connected" || state === "attempted") return "info";
  if (state === "failed" || state === "denied" || state === "unsatisfied") return "warn";
  return "neutral";
}

function cleanToolName(tool: string): string {
  return tool.replace(/^mcp__context7__/u, "");
}

function CountRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-[minmax(7.5rem,0.7fr)_minmax(0,1.3fr)] gap-3 border-t border-line px-3 py-2 first:border-t-0">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="min-w-0 text-right text-[11.5px] text-ink-dim">{children}</dd>
    </div>
  );
}

function EvidenceLedger({ review }: { review: Context7Review }): ReactNode {
  const rows = review.packages.map((claim) => ({
    ...claim,
    evidence: evidenceFor(review.evidence, claim.package, claim.versionOrRange),
  }));
  const declared = new Set(review.packages.map(packageEvidenceKey));
  const unmatched = review.evidence
    .filter((entry) => !declared.has(packageEvidenceKey(entry)))
    .map((evidence) => ({
      package: evidence.package,
      versionOrRange: evidence.versionOrRange,
      evidence,
    }));
  const allRows = [...rows, ...unmatched];

  if (review.capabilityApplicability === "not_applicable") {
    return (
      <div className="border-t border-line px-3 py-2.5" data-testid="context7-claims-na">
        <p className="text-[12px] leading-relaxed text-ink-dim">
          No external package claims were in scope, so there is no documentation ledger for this run.
        </p>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="border-t border-line px-3 py-2.5" data-testid="context7-claims-empty">
        <p className="text-[12px] leading-relaxed text-warn">
          The review record contains no external package claims.
        </p>
      </div>
    );
  }

  return (
    <section className="border-t border-line" aria-labelledby="context7-claims-heading">
      <h4
        id="context7-claims-heading"
        className="px-3 pt-2.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint"
      >
        External claim ledger
      </h4>
      <ol className="mt-1.5">
        {allRows.map((row, index) => {
          const admitted = row.evidence?.success === true;
          return (
            <li
              key={`${row.package}:${row.versionOrRange ?? "unspecified"}:${String(index)}`}
              className="border-t border-line px-3 py-2.5 first:border-t-0"
              data-testid="context7-claim"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words font-mono text-[12px] font-semibold text-ink">
                  {row.package}
                  <span className="font-normal text-ink-faint">
                    @{row.versionOrRange ?? "version not recorded"}
                  </span>
                </p>
                <Badge tone={admitted ? "pass" : "warn"}>
                  {admitted ? "Evidence admitted" : "Evidence missing"}
                </Badge>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">
                {row.evidence?.queryPurpose ??
                  "No successful documentation query was admitted for this claim."}
              </p>
              {row.evidence !== null && (
                <p className="mt-1 font-mono text-[10.5px] text-ink-faint">
                  {row.evidence.claimId} · evidence sha256:{" "}
                  <span title={row.evidence.evidenceHash}>{shortHash(row.evidence.evidenceHash)}</span>
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ReviewOutcome({ review }: { review: Context7Review }): ReactNode {
  const outcome = review.verdict;
  if (outcome === null) {
    return (
      <section className="border-t border-line px-3 py-2.5" data-testid="context7-no-outcome">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            Independent review outcome
          </h4>
          <Badge tone="neutral">Not admitted</Badge>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">
          {review.capabilityApplicability === "not_applicable" && review.code === null
            ? "No source-only review outcome was recorded."
            : codeDetail(review.code, "No review outcome was admitted for this run.")}
        </p>
      </section>
    );
  }

  return (
    <section className="border-t border-line px-3 py-2.5" data-testid="context7-outcome">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
          Independent review outcome
        </h4>
        <Badge tone={outcome.verdict === "pass" ? "pass" : "warn"}>
          {review.capabilityApplicability === "not_applicable" ? "Source-only " : ""}
          {outcome.verdict}
        </Badge>
      </div>
      <p className="mt-1.5 min-w-0 break-words text-[12px] leading-relaxed text-ink-dim">{outcome.summary}</p>
      <p className="mt-1 min-w-0 break-all font-mono text-[10.5px] text-ink-faint">
        Non-gating.
        {outcome.evidence.length > 0
          ? ` Cited ${outcome.evidence.map((entry) => entry.claimId).join(", ")}.`
          : " No documentation claims cited."}
      </p>

      {outcome.findings.length > 0 && (
        <ul className="mt-2 overflow-hidden rounded border border-line">
          {outcome.findings.map((finding, index) => (
            <li
              key={`${finding.claimId}:${finding.title}:${String(index)}`}
              className="border-t border-line bg-canvas/35 px-2.5 py-2 first:border-t-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words text-[11.5px] font-medium text-ink">{finding.title}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="min-w-0 break-all font-mono text-[10px] text-ink-faint">{finding.claimId}</span>
                  <Badge tone={finding.severity === "info" ? "info" : "warn"}>
                    {finding.severity}
                  </Badge>
                </div>
              </div>
              <p className="mt-1 min-w-0 break-words text-[11.5px] leading-relaxed text-ink-dim">{finding.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LifecycleProof({ review }: { review: Context7Review }): ReactNode {
  const uniqueObligations = [...new Set(review.lifecycle.map((event) => event.obligationHash))];

  return (
    <details className="group border-t border-line" data-testid="context7-proof">
      <summary className="cursor-pointer list-none px-3 py-2.5 text-[11.5px] font-medium text-ink-dim transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="font-mono text-ink-faint group-open:rotate-90">
            &gt;
          </span>
          Lifecycle and source proof
        </span>
      </summary>
      <div className="border-t border-line bg-canvas/25">
        <dl>
          <CountRow label="Source snapshot">
            <span className="numeric">{review.source.files.length}</span> files, {formatBytes(review.source.bytes)}
            {review.source.truncated ? ", truncated" : ", complete"}
          </CountRow>
          <CountRow label="Source sha256">
            <span className="font-mono" title={review.source.sourceHash}>
              {shortHash(review.source.sourceHash)}
            </span>
          </CountRow>
          {uniqueObligations.length > 0 && (
            <CountRow label="Obligation sha256">
              <span className="font-mono" title={uniqueObligations.join(", ")}>
                {uniqueObligations.map(shortHash).join(", ")}
              </span>
            </CountRow>
          )}
        </dl>

        {review.lifecycle.length === 0 ? (
          <p className="border-t border-line px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-dim">
            No capability lifecycle was recorded. This is expected when Context7 is not applicable.
          </p>
        ) : (
          <ol aria-label="Context7 lifecycle">
            {review.lifecycle.map((event, index) => (
              <LifecycleRow key={`${event.obligationHash}:${event.state}:${String(index)}`} event={event} />
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function LifecycleRow({ event }: { event: Context7Lifecycle }): ReactNode {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-3 py-2">
      <Badge tone={lifecycleTone(event.state)}>{event.state.replaceAll("_", " ")}</Badge>
      <span className="font-mono text-[10.5px] text-ink-dim">{event.server}</span>
      {event.claimId !== null && (
        <span className="min-w-0 break-all font-mono text-[10.5px] text-ink-faint">
          {event.claimId}
        </span>
      )}
      {event.tool !== null && (
        <span className="min-w-0 break-all font-mono text-[10.5px] text-ink-faint">
          {cleanToolName(event.tool)}
        </span>
      )}
      {event.code !== null && (
        <span className="min-w-0 break-all font-mono text-[10.5px] text-warn">{event.code}</span>
      )}
      {event.producedArtefactHashes.length > 0 && (
        <span
          className="font-mono text-[10px] text-ink-faint"
          title={event.producedArtefactHashes.join(", ")}
        >
          {event.producedArtefactHashes.length === 1
            ? `proof ${shortHash(event.producedArtefactHashes[0] ?? "")}`
            : `${String(event.producedArtefactHashes.length)} proofs`}
        </span>
      )}
    </li>
  );
}

export function Context7ReviewPanel({
  review,
}: {
  review: Context7Review | null;
}): ReactNode {
  if (review === null) return null;
  if (!isContext7Review(review)) {
    return (
      <Panel
        title="Context7 documentation review"
        subtitle="Independent evidence record. It does not change the run result."
        actions={<Badge tone="warn">Unavailable</Badge>}
        bodyClassName="p-0"
        className="min-w-0 overflow-hidden"
      >
        <p className="min-w-0 break-words px-3 py-2.5 text-[12px] leading-relaxed text-warn" data-testid="context7-review-unavailable">
          Context7 record unavailable
        </p>
      </Panel>
    );
  }

  const status = statusCopy(review);
  const attempted = review.lifecycle.filter((event) => event.state === "attempted").length;
  const succeeded = review.lifecycle.filter((event) => event.state === "succeeded").length;
  const denied = review.lifecycle.filter((event) => event.state === "denied").length;
  const available = review.lifecycle.some((event) => event.state === "connected");
  const tools = new Set(
    review.lifecycle.flatMap((event) => (event.tool === null ? [] : [event.tool])),
  );
  const admitted = review.evidence.filter((entry) => entry.success).length;

  return (
    <Panel
      title="Context7 documentation review"
      subtitle="Independent evidence record. It does not change the run result."
      actions={<Badge tone={status.tone}>{status.label}</Badge>}
      bodyClassName="p-0"
      className="min-w-0 overflow-hidden"
    >
      <div className="px-3 py-2.5" data-testid="context7-review">
        <p className={cx("min-w-0 break-words text-[12px] leading-relaxed", status.tone === "warn" ? "text-warn" : "text-ink-dim")}>
          {status.detail}
        </p>
      </div>

      <dl className="border-t border-line bg-canvas/20">
        <CountRow label="Capability">
          {review.capabilityApplicability === "not_applicable"
            ? "Not needed"
            : review.capabilityApplicability === "required"
              ? "Required"
              : "Suggested"}
        </CountRow>
        <CountRow label="SDK inventory">
          {review.capabilityApplicability === "not_applicable"
            ? "Not needed"
            : available
              ? "Verified before review"
              : "Not verified"}
        </CountRow>
        <CountRow label="Tool activity">
          <span className="numeric">{tools.size}</span> named, <span className="numeric">{attempted}</span> invoked,{" "}
          <span className="numeric">{succeeded}</span> returned, <span className="numeric">{denied}</span> denied
        </CountRow>
        <CountRow label="Documentation evidence">
          <span className="numeric">{admitted}</span> of <span className="numeric">{review.packages.length}</span> claims admitted
        </CountRow>
      </dl>

      <EvidenceLedger review={review} />
      <ReviewOutcome review={review} />
      <LifecycleProof review={review} />
    </Panel>
  );
}
