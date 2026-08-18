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
      <Badge tone="neutral" title="The finished site has not been checked yet.">
        not checked
      </Badge>
    );
  }
  return heldOutPass ? (
    <Badge tone="pass" title="It passed checks it had never seen.">
      passed
    </Badge>
  ) : (
    <Badge tone="fail" title="It failed checks it had never seen.">
      did not pass
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
      title="It said the work was done. The checks say otherwise."
    >
      said done, not done
    </Badge>
  );
}
