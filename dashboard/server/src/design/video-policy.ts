import { PAGE_KINDS, SCROLL_PROGRESS_MIN_MOTION_INTENSITY } from "../creative-contract.js";
import type { PageKind } from "../creative-contract.js";

/** App is reserved here for T22; the creative-contract vocabulary is unchanged. */
export type VideoPolicyPageKind = PageKind | "app";

export interface VideoLegPolicy {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface VideoLegPolicyInput {
  readonly pageKind: VideoPolicyPageKind | null;
  readonly contractDial: number | null;
  readonly directionDial: number | null;
  /** Three-input callers have a contract; only the reader can establish absence. */
  readonly contractState?: "present" | "missing" | "invalid";
  readonly contractProblem?: string;
  readonly directionOccurrences?: number;
}

const validDial = (value: number | null): value is number => value !== null && Number.isInteger(value) && value >= 1 && value <= 10;

/** The contract and the chosen direction must both authorize a scroll-progress leg. */
export function videoLegPolicy(input: VideoLegPolicyInput): VideoLegPolicy {
  if (input.contractState === "missing") return { allowed: true, reason: "no contract; policy not applied" };
  const read = `page kind ${input.pageKind ?? "unknown"}; contract dial ${input.contractDial ?? "unknown"}; direction dial ${input.directionDial ?? "unknown"}; minimum ${String(SCROLL_PROGRESS_MIN_MOTION_INTENSITY)}`;
  const duplicate = (input.directionOccurrences ?? 0) > 1
    ? `; first of ${String(input.directionOccurrences)} direction dial declarations used`
    : "";
  if (input.contractState === "invalid") {
    return { allowed: false, reason: `video legs declined: ${read}${duplicate}; ${input.contractProblem ?? "invalid contract policy fields"}` };
  }
  if (input.directionDial === null && (input.directionOccurrences ?? 0) > 0) {
    return { allowed: false, reason: `video legs declined: ${read}${duplicate}; first direction dial declaration is invalid` };
  }
  const allowed = input.pageKind !== null && input.pageKind !== "app" && (PAGE_KINDS as readonly string[]).includes(input.pageKind) &&
    validDial(input.contractDial) && input.contractDial >= SCROLL_PROGRESS_MIN_MOTION_INTENSITY &&
    (input.directionDial === null || (validDial(input.directionDial) && input.directionDial >= SCROLL_PROGRESS_MIN_MOTION_INTENSITY));
  return { allowed, reason: `video legs ${allowed ? "allowed" : "declined"}: ${read}${duplicate}` };
}
