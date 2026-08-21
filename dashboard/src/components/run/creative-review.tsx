"use client";

import { useState, type ReactNode } from "react";

import type {
  CreativeDecisionResponse,
  CreativeCompileFinding,
  CreativeCriticFinding,
  CreativeOwnerDecision,
  CreativeStatus,
} from "@/lib/api-types";
import { decideCreativeReview } from "@/lib/api";
import type { Tone } from "@/lib/presentation";
import { Badge, Button, Panel, cx } from "@/components/ui";

interface AuthorityCopy {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: Tone;
}

const COMPILE_OUTCOMES = new Set(["unknown", "passed", "failed", "unavailable"]);
const RENDER_PROFILE_IDS = new Set(["desktop", "mobile", "reduced_motion", "no_media"]);
const CRITIC_DISPOSITIONS = new Set(["accept", "revise", "unavailable"]);
const REVIEW_STATES = new Set([
  "reviewing",
  "creative_ready",
  "creative_review_required",
  "not_converging",
  "failed",
]);
const OWNER_DECISIONS = new Set([
  "approved",
  "revision_requested",
  "waived",
  "cancelled",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableSha256(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function isCompileFinding(value: unknown): value is CreativeCompileFinding {
  return (
    isObject(value) &&
    typeof value["code"] === "string" &&
    typeof value["path"] === "string" &&
    typeof value["message"] === "string"
  );
}

function isCriticFinding(value: unknown): value is CreativeCriticFinding {
  return (
    isObject(value) &&
    typeof value["category"] === "string" &&
    typeof value["code"] === "string" &&
    typeof value["routeId"] === "string" &&
    Array.isArray(value["sectionIds"]) &&
    value["sectionIds"].every((section) => typeof section === "string") &&
    typeof value["diagnosis"] === "string" &&
    typeof value["revision"] === "string"
  );
}

function isRenderProfiles(value: unknown): value is NonNullable<CreativeStatus["renderProfiles"]> {
  if (!Array.isArray(value) || value.length !== RENDER_PROFILE_IDS.size) return false;
  const ids = new Set<string>();
  for (const profile of value) {
    if (
      !isObject(profile) ||
      typeof profile["profileId"] !== "string" ||
      !RENDER_PROFILE_IDS.has(profile["profileId"]) ||
      ids.has(profile["profileId"]) ||
      typeof profile["captureCount"] !== "number" ||
      !Number.isInteger(profile["captureCount"]) ||
      profile["captureCount"] < 0 ||
      typeof profile["complete"] !== "boolean"
    ) {
      return false;
    }
    ids.add(profile["profileId"]);
  }
  return true;
}

/** Fail the whole audit closed: a partial record must never leak a green row. */
function isCreativeStatus(value: unknown): value is CreativeStatus {
  if (!isObject(value)) return false;
  const compileOutcome = value["compileOutcome"];
  const criticDisposition = value["criticDisposition"];
  const reviewState = value["reviewState"];
  const ownerDecision = value["ownerDecision"];
  const criticAttempt = value["criticAttempt"];
  return (
    typeof value["applicable"] === "boolean" &&
    typeof value["enabled"] === "boolean" &&
    isNullableSha256(value["contractHash"]) &&
    typeof compileOutcome === "string" &&
    COMPILE_OUTCOMES.has(compileOutcome) &&
    Array.isArray(value["compileFindings"]) &&
    value["compileFindings"].every(isCompileFinding) &&
    isNullableSha256(value["renderManifestHash"]) &&
    (value["renderFresh"] === null || typeof value["renderFresh"] === "boolean") &&
    (value["renderProfiles"] === null || isRenderProfiles(value["renderProfiles"])) &&
    (criticDisposition === null ||
      (typeof criticDisposition === "string" && CRITIC_DISPOSITIONS.has(criticDisposition))) &&
    Array.isArray(value["criticFindings"]) &&
    value["criticFindings"].every(isCriticFinding) &&
    (criticAttempt === null ||
      (typeof criticAttempt === "number" &&
        Number.isInteger(criticAttempt) &&
        criticAttempt >= 1)) &&
    (reviewState === null ||
      (typeof reviewState === "string" && REVIEW_STATES.has(reviewState))) &&
    (value["reviewStopReason"] === null || typeof value["reviewStopReason"] === "string") &&
    (ownerDecision === null ||
      (typeof ownerDecision === "string" && OWNER_DECISIONS.has(ownerDecision))) &&
    (value["ownerDecisionReason"] === null || typeof value["ownerDecisionReason"] === "string") &&
    (value["ownerDecisionTargetRunId"] === null || typeof value["ownerDecisionTargetRunId"] === "string")
  );
}

function functionalCopy(pass: boolean | null): AuthorityCopy {
  if (pass === true) {
    return {
      label: "Functional suite",
      value: "Passed",
      detail: "The sealed held-out checks passed.",
      tone: "pass",
    };
  }
  if (pass === false) {
    return {
      label: "Functional suite",
      value: "Failed",
      detail: "The sealed held-out checks failed.",
      tone: "fail",
    };
  }
  return {
    label: "Functional suite",
    value: "Unknown",
    detail: "No held-out result is recorded.",
    tone: "neutral",
  };
}

function compileCopy(outcome: CreativeStatus["compileOutcome"]): AuthorityCopy {
  if (outcome === "passed") {
    return {
      label: "Creative compiler",
      value: "Passed",
      detail: "The creative contract compiled without an admitted finding.",
      tone: "pass",
    };
  }
  if (outcome === "failed") {
    return {
      label: "Creative compiler",
      value: "Failed",
      detail: "The contract compiler recorded one or more blocking findings.",
      tone: "fail",
    };
  }
  if (outcome === "unavailable") {
    return {
      label: "Creative compiler",
      value: "Unavailable",
      detail: "The compiler could not produce an outcome.",
      tone: "warn",
    };
  }
  return {
    label: "Creative compiler",
    value: "Unknown",
    detail: "No compiler outcome is recorded.",
    tone: "neutral",
  };
}

function criticCopy(disposition: CreativeStatus["criticDisposition"]): AuthorityCopy {
  if (disposition === "accept") {
    return {
      label: "Rendered critic",
      value: "Accepted",
      detail: "The critic accepted the rendered evidence for this attempt.",
      tone: "pass",
    };
  }
  if (disposition === "revise") {
    return {
      label: "Rendered critic",
      value: "Revise",
      detail: "The critic recorded rendered-evidence revisions.",
      tone: "warn",
    };
  }
  if (disposition === "unavailable") {
    return {
      label: "Rendered critic",
      value: "Unavailable",
      detail: "The critic could not issue a rendered-evidence disposition.",
      tone: "warn",
    };
  }
  return {
    label: "Rendered critic",
    value: "Not run",
    detail: "No critic disposition is recorded.",
    tone: "neutral",
  };
}

function ownerCopy(decision: CreativeStatus["ownerDecision"]): AuthorityCopy {
  if (decision === "approved") {
    return {
      label: "Owner decision",
      value: "Approved",
      detail: "The owner explicitly approved this creative result.",
      tone: "accent",
    };
  }
  if (decision === "revision_requested") {
    return {
      label: "Owner decision",
      value: "Revision requested",
      detail: "The owner explicitly requested another revision.",
      tone: "warn",
    };
  }
  if (decision === "waived") {
    return {
      label: "Owner decision",
      value: "Waived",
      detail: "The owner explicitly waived creative acceptance.",
      tone: "info",
    };
  }
  if (decision === "cancelled") {
    return {
      label: "Owner decision",
      value: "Cancelled",
      detail: "The owner cancelled the creative review.",
      tone: "neutral",
    };
  }
  return {
    label: "Owner decision",
    value: "Awaiting owner",
    detail: "No owner decision is recorded.",
    tone: "neutral",
  };
}

function reviewStateCopy(state: CreativeStatus["reviewState"]): string {
  if (state === null) return "Not recorded";
  const labels: Readonly<Record<NonNullable<CreativeStatus["reviewState"]>, string>> = {
    reviewing: "Reviewing",
    creative_ready: "Creative ready",
    creative_review_required: "Revision required",
    not_converging: "Not converging",
    failed: "Stopped",
  };
  return labels[state];
}

function AuthorityRow({
  authority,
  testId,
}: {
  readonly authority: AuthorityCopy;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t border-line px-3 py-2.5 first:border-t-0"
      data-testid={testId}
    >
      <div className="min-w-0">
        <dt className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
          {authority.label}
        </dt>
        <dd className="mt-1 min-w-0 break-words text-[11.5px] leading-relaxed text-ink-dim">
          {authority.detail}
        </dd>
      </div>
      <dd className="self-start">
        <Badge tone={authority.tone}>{authority.value}</Badge>
      </dd>
    </div>
  );
}

function HashCell({ label, value }: { readonly label: string; readonly value: string | null }): ReactNode {
  return (
    <div className="min-w-0 border-t border-line px-3 py-2 first:border-t-0 sm:border-l sm:first:border-l-0 sm:first:border-t sm:[&:nth-child(2)]:border-t-0">
      <dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd
        className={cx(
          "mt-1 min-w-0 font-mono text-[10.5px] leading-relaxed",
          value === null ? "text-ink-faint" : "break-all text-ink-dim",
        )}
        title={value ?? undefined}
      >
        {value ?? "Not recorded"}
      </dd>
    </div>
  );
}

function CompileFindings({ findings }: { readonly findings: readonly CreativeCompileFinding[] }): ReactNode {
  return (
    <details className="group border-t border-line" data-testid="creative-compile-findings">
      <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-medium text-ink-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        Compiler findings <span className="numeric text-ink-faint">({findings.length})</span>
      </summary>
      <div className="border-t border-line bg-canvas/20">
        {findings.length === 0 ? (
          <p className="px-3 py-2.5 text-[11.5px] text-ink-faint">No compiler findings recorded.</p>
        ) : (
          <ol>
            {findings.map((finding, index) => (
              <li
                key={`${finding.code}:${finding.path}:${String(index)}`}
                className="min-w-0 border-t border-line px-3 py-2.5 first:border-t-0"
              >
                <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                  <span className="min-w-0 max-w-full break-all rounded-sm border border-fail/45 bg-fail-dim px-1.5 py-[2px] text-[10.5px] font-medium leading-[16px] text-fail">
                    {finding.code}
                  </span>
                  <span className="min-w-0 break-all font-mono text-[10.5px] text-ink-faint">
                    {finding.path || "Path not recorded"}
                  </span>
                </div>
                <p className="mt-1.5 min-w-0 break-words text-[11.5px] leading-relaxed text-ink-dim">
                  {finding.message}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function CriticFindings({ findings }: { readonly findings: readonly CreativeCriticFinding[] }): ReactNode {
  return (
    <details className="group border-t border-line" data-testid="creative-critic-findings">
      <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-medium text-ink-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        Rendered evidence findings <span className="numeric text-ink-faint">({findings.length})</span>
      </summary>
      <div className="border-t border-line bg-canvas/20">
        {findings.length === 0 ? (
          <p className="px-3 py-2.5 text-[11.5px] text-ink-faint">No critic findings recorded.</p>
        ) : (
          <ol>
            {findings.map((finding, index) => (
              <li
                key={`${finding.code}:${finding.routeId}:${String(index)}`}
                className="min-w-0 border-t border-line px-3 py-2.5 first:border-t-0"
                data-testid="creative-critic-finding"
              >
                <div className="flex min-w-0 flex-wrap items-start gap-1.5">
                  <span className="min-w-0 max-w-full break-all rounded-sm border border-warn/40 bg-warn-dim px-1.5 py-[2px] text-[10.5px] font-medium leading-[16px] text-warn">
                    {finding.category}
                  </span>
                  <span className="min-w-0 break-all font-mono text-[10px] text-ink-faint">
                    {finding.code} · route {finding.routeId || "not recorded"}
                  </span>
                </div>
                <p className="mt-1 min-w-0 break-all font-mono text-[10px] text-ink-faint">
                  Sections: {finding.sectionIds.length > 0 ? finding.sectionIds.join(", ") : "not recorded"}
                </p>
                <p className="mt-1.5 min-w-0 break-words text-[11.5px] leading-relaxed text-ink-dim">
                  {finding.diagnosis}
                </p>
                <p className="mt-1 min-w-0 break-words text-[11.5px] leading-relaxed text-warn">
                  Revision: {finding.revision}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export function CreativeReviewPanel({
  runId,
  heldOutPass,
  review,
}: {
  readonly runId: string;
  readonly heldOutPass: boolean | null;
  readonly review: CreativeStatus | null;
}): ReactNode {
  const [receipt, setReceipt] = useState<CreativeDecisionResponse | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<CreativeOwnerDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  if (review === null) return null;
  if (!isCreativeStatus(review)) {
    return (
      <Panel
        title="Creative contract · rendered review"
        subtitle="Independent functional, compiler, critic, and owner authorities."
        actions={<Badge tone="warn">Unavailable</Badge>}
        bodyClassName="p-0"
        className="min-w-0 overflow-hidden"
      >
        <p
          className="min-w-0 break-words px-3 py-2.5 text-[12px] leading-relaxed text-warn"
          data-testid="creative-review-unavailable"
        >
          Creative review record unavailable. No authority result was admitted.
        </p>
      </Panel>
    );
  }

  const state = reviewStateCopy(review.reviewState);
  const effectiveDecision = receipt?.ownerDecision ?? review.ownerDecision;
  const mayApprove =
    heldOutPass === true &&
    review.compileOutcome === "passed" &&
    review.criticDisposition === "accept" &&
    review.reviewState === "creative_ready";
  const mayWaive =
    heldOutPass === true &&
    review.compileOutcome === "passed" &&
    review.criticDisposition === "revise" &&
    review.criticFindings.length > 0;
  const decide = async (decision: CreativeOwnerDecision): Promise<void> => {
    const trimmed = reason.trim();
    setPending(decision);
    setDecisionError(null);
    try {
      const result = await decideCreativeReview(runId, {
        decision,
        ...((decision === "waived" || decision === "revision_requested")
          ? { reason: trimmed }
          : {}),
      });
      setReceipt(result);
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "The owner decision was not recorded.");
    } finally {
      setPending(null);
    }
  };
  return (
    <Panel
      title="Creative contract · rendered review"
      subtitle="Four separate authorities; none is promoted from another."
      actions={<Badge tone="neutral">{state}</Badge>}
      bodyClassName="p-0"
      className="min-w-0 overflow-hidden"
    >
      <div data-testid="creative-review">
        <dl className="bg-canvas/20" aria-label="Creative review authorities">
          <AuthorityRow authority={functionalCopy(heldOutPass)} testId="creative-authority-functional" />
          <AuthorityRow authority={compileCopy(review.compileOutcome)} testId="creative-authority-compiler" />
          <AuthorityRow authority={criticCopy(review.criticDisposition)} testId="creative-authority-critic" />
          <AuthorityRow authority={ownerCopy(effectiveDecision)} testId="creative-authority-owner" />
        </dl>

        <section className="border-t border-line" aria-labelledby="creative-provenance-heading">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
            <h3
              id="creative-provenance-heading"
              className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint"
            >
              Contract → render → critic
            </h3>
            <span className="font-mono text-[10px] text-ink-faint" data-testid="creative-critic-attempt">
              Attempt {review.criticAttempt === null ? "not recorded" : String(review.criticAttempt)}
            </span>
          </div>
          <dl className="grid min-w-0 sm:grid-cols-2">
            <HashCell label="Contract sha256" value={review.contractHash} />
            <HashCell label="Render manifest sha256" value={review.renderManifestHash} />
          </dl>
          <dl className="grid min-w-0 border-t border-line sm:grid-cols-2">
            <div className="min-w-0 px-3 py-2">
              <dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Manifest freshness</dt>
              <dd className="mt-1">
                <Badge
                  tone={review.renderFresh === true ? "pass" : review.renderFresh === false ? "warn" : "neutral"}
                >
                  {review.renderFresh === true ? "Fresh" : review.renderFresh === false ? "Stale" : "Unknown"}
                </Badge>
              </dd>
            </div>
            <div className="min-w-0 border-t border-line px-3 py-2 sm:border-l sm:border-t-0">
              <dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Profile coverage</dt>
              <dd className="mt-1 flex min-w-0 flex-wrap gap-1.5" data-testid="creative-profile-coverage">
                {review.renderProfiles === null || review.renderProfiles.length === 0 ? (
                  <Badge tone="neutral">Unknown</Badge>
                ) : review.renderProfiles.map((profile) => (
                  <Badge key={profile.profileId} tone={profile.complete ? "pass" : "warn"}>
                    {profile.profileId}: {profile.complete ? `${String(profile.captureCount)} captured` : "incomplete"}
                  </Badge>
                ))}
              </dd>
            </div>
          </dl>
        </section>

        <CompileFindings findings={review.compileFindings} />
        <CriticFindings findings={review.criticFindings} />

        {(review.reviewStopReason !== null || review.ownerDecisionReason !== null) && (
          <div className="min-w-0 border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-ink-dim">
            {review.reviewStopReason !== null && (
              <p className="min-w-0 break-words">Review stopped: {review.reviewStopReason.replaceAll("_", " ")}.</p>
            )}
            {review.ownerDecisionReason !== null && (
              <p className="mt-1 min-w-0 break-words">Owner rationale: {review.ownerDecisionReason}</p>
            )}
          </div>
        )}

        {receipt === null && review.ownerDecisionTargetRunId !== null && (
          <a
            className="block min-w-0 break-all border-t border-line px-3 py-2.5 font-mono text-[10.5px] text-accent underline decoration-accent/40 underline-offset-2"
            href={`/runs/${encodeURIComponent(review.ownerDecisionTargetRunId)}`}
          >
            Open continuation {review.ownerDecisionTargetRunId}
          </a>
        )}

        {effectiveDecision === null && (
          <details className="border-t border-line" data-testid="creative-owner-awaiting">
            <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-medium text-ink-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              Owner decision controls
            </summary>
            <div className="min-w-0 border-t border-line bg-canvas/20 px-3 py-2.5">
              <label className="block min-w-0">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-faint">
                  Reason for revision or waiver
                </span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={1_000}
                  rows={3}
                  className="mt-1.5 w-full min-w-0 resize-y rounded border border-line-strong bg-canvas px-2.5 py-2 text-[12px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-accent/60 focus:ring-1 focus:ring-accent/30"
                  placeholder="Required for revision or waiver"
                />
              </label>
              <div className="mt-2.5 flex min-w-0 flex-wrap gap-1.5">
                {mayApprove && (
                  <Button
                    variant="primary"
                    disabled={pending !== null}
                    onClick={() => void decide("approved")}
                  >
                    {pending === "approved" ? "Recording…" : "Approve"}
                  </Button>
                )}
                <Button
                  variant="default"
                  disabled={pending !== null || reason.trim() === ""}
                  onClick={() => void decide("revision_requested")}
                >
                  {pending === "revision_requested" ? "Recording…" : "Request revision"}
                </Button>
                {mayWaive && (
                  <Button
                    variant="default"
                    disabled={pending !== null || reason.trim() === ""}
                    onClick={() => void decide("waived")}
                  >
                    {pending === "waived" ? "Recording…" : "Waive critic revision"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => void decide("cancelled")}
                >
                  {pending === "cancelled" ? "Recording…" : "Cancel review"}
                </Button>
              </div>
              {decisionError !== null && (
                <p className="mt-2 min-w-0 break-words text-[11.5px] leading-relaxed text-fail" role="alert">
                  {decisionError}
                </p>
              )}
            </div>
          </details>
        )}

        {receipt !== null && (
          <div
            className="min-w-0 border-t border-line px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-dim"
            role="status"
            data-testid="creative-decision-receipt"
          >
            <p className="min-w-0 break-words">
              Server recorded {ownerCopy(receipt.ownerDecision).value.toLowerCase()}.
              {receipt.published
                ? " The project copy was published."
                : receipt.mayPublish
                  ? " Publication is permitted but no published copy was reported."
                  : " Publication was not promoted."}
            </p>
            {receipt.targetRunId !== null && (
              <a
                className="mt-1 inline-block min-w-0 break-all font-mono text-[10.5px] text-accent underline decoration-accent/40 underline-offset-2"
                href={`/runs/${encodeURIComponent(receipt.targetRunId)}`}
              >
                Open continuation {receipt.targetRunId}
              </a>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
