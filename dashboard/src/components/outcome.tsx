"use client";

import type { ReactNode } from "react";

import { Badge } from "./ui";

/**
 * `heldOutPass: null` is NOT `false`. Null means the sealed gate has not
 * returned a verdict; false means it returned one and the artefact failed.
 * Collapsing the two would report unscored runs as failures.
 */
export function HeldOutBadge({
  heldOutPass,
  compact = false,
}: {
  heldOutPass: boolean | null;
  compact?: boolean;
}): ReactNode {
  if (heldOutPass === null) {
    return (
      <Badge tone="neutral" title="The held-out suite has not returned a verdict.">
        {compact ? "unscored" : "not scored"}
      </Badge>
    );
  }
  return heldOutPass ? (
    <Badge tone="pass" title="The frozen suite went green in the sealed container.">
      held-out pass
    </Badge>
  ) : (
    <Badge tone="fail" title="The frozen suite did not go green in the sealed container.">
      held-out fail
    </Badge>
  );
}

/**
 * FALSE FINISH — the agent declared done AND the held-out suite failed.
 *
 * This is the failure that ships a broken app while claiming success, so it is
 * never a quiet grey chip. Rendered only when it is positively true; `null`
 * means unscored and `false` means the run did not lie.
 */
export function FalseFinishBadge({
  falseFinish,
}: {
  falseFinish: boolean | null;
}): ReactNode {
  if (falseFinish !== true) return null;
  return (
    <Badge
      tone="fail"
      className="font-semibold uppercase tracking-wide"
      title="The agent declared the work done and the held-out gate disagreed."
    >
      false finish
    </Badge>
  );
}
