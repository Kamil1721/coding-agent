/**
 * Fixtures drawn from real recorded defects, not invented ones.
 *
 * A913C871_ATTEMPTS is the measured violation-path sequence of the run that killed the
 * pipeline on 2026-08-09 (RUN-a913c871-observations.md:385-393 for attempts 1 and 2, and
 * the verbatim `failure_reason` at :336-339 for attempt 3, which names `id` again).
 * Everything the anti-loop rule claims is asserted against this sequence.
 */

export const A913C871_SITE = "collectManifestProblems";

export const A913C871_ATTEMPTS = [
  { n: 1, at: "2026-08-09T21:31:52.892Z", violations: [{ path: "dataExpectations[0].id", expected: "a non-empty string", got: "undefined" }] },
  { n: 2, at: "2026-08-09T22:07:19.000Z", violations: [{ path: "dataExpectations[0].kind", expected: '"sqlite" or "http"', got: "undefined" }] },
  { n: 3, at: "2026-08-09T22:31:03.000Z", violations: [{ path: "dataExpectations[0].id", expected: "a non-empty string", got: "undefined" }] },
];

/** The same defect as it would be recorded once the validator reports every field at once. */
export const SHRINKING_ATTEMPTS = [
  { n: 1, violations: [{ path: "dataExpectations[0].id" }, { path: "dataExpectations[0].kind" }, { path: "dataExpectations[0].minRows" }] },
  { n: 2, violations: [{ path: "dataExpectations[0].kind" }, { path: "dataExpectations[0].minRows" }] },
  { n: 3, violations: [{ path: "dataExpectations[0].minRows" }] },
];

/** Prose-only attempts: what the DefectRecord contract's `problems: string[]` gives you. */
export const PROSE_ONLY_ATTEMPTS = [
  { n: 1, problems: ['dataExpectations[0].id must be a non-empty string :: Set dataExpectations[0].id.'] },
  { n: 2, problems: ['dataExpectations[0].kind must be "sqlite" or "http", got undefined'] },
];

export const A913C871_DEFECT = {
  runId: "run-2026-08-09T21-04-00-713Z-a913c871",
  at: "2026-08-09T22:31:04.532Z",
  phase: "spec",
  failureClass: "structural::schema_shape",
  bakeoffCode: "invalid_usage_shape",
  signature: "0".repeat(64),
  violations: [{ path: "dataExpectations[0].id", expected: "a non-empty string", got: "undefined" }],
  attempts: A913C871_ATTEMPTS,
  artefacts: ["bakeoff/src/spec-agent.ts"],
  candidatePaths: ["bakeoff/src/spec-agent.ts"],
  repairable: true,
};

/**
 * A record shaped EXACTLY like the DefectRecord contract: `attempts[]` carries prose
 * `problems`, and there is no per-attempt structure at all. This is what the record writer
 * promises today, and the anti-loop rule is BLIND on it — see loop-guard.test.mjs.
 */
export const CONTRACT_SHAPED_DEFECT = {
  runId: "run-2026-08-09T21-04-00-713Z-a913c871",
  at: "2026-08-09T22:31:04.532Z",
  phase: "spec",
  failureClass: "structural",
  bakeoffCode: "invalid_usage_shape",
  signature: "9".repeat(64),
  violations: [{ path: "dataExpectations[0].id", expected: "a non-empty string", got: "undefined" }],
  attempts: [
    { n: 1, at: "2026-08-09T21:31:52.892Z", problems: ["dataExpectations[0].id must be a non-empty string"] },
    { n: 2, at: "2026-08-09T22:07:19.000Z", problems: ['dataExpectations[0].kind must be "sqlite" or "http", got undefined'] },
    { n: 3, at: "2026-08-09T22:31:03.000Z", problems: ["dataExpectations[0].id must be a non-empty string"] },
  ],
  artefacts: ["dashboard/runs/run-2026-08-09T21-04-00-713Z-a913c871/results/defect.json"],
  repairable: true,
};
