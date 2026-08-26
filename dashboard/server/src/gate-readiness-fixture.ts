/** Test-only affirmative readiness. Production must construct FreshGateReadiness. */
import type { GateReadiness, GateReadinessResult } from "./gate-readiness.js";

export const READY_GATE_READINESS: GateReadiness = Object.freeze({
  checkFresh: (): Promise<GateReadinessResult> =>
    Promise.resolve({
      state: "ready",
      detail: "injected ready scorer runtime",
      remediation: "No action required.",
      checkedAt: "2026-08-26T00:00:00.000Z",
    }),
});
