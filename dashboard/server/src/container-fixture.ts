/**
 * container-fixture.ts — a valid `ContainerResult`, built by hand, for tests.
 *
 * NOT A TEST FILE, ON PURPOSE, and the same reason `graph-fixture.ts` is not:
 * `node --test "dist/**\/*.test.js"` runs every file whose name matches, so a
 * shared builder living in a `.test.ts` would be executed as a suite of its own
 * with nothing in it.
 *
 * WHY A BUILDER AND NOT AN OBJECT LITERAL PER TEST. `parseContainerResult` is
 * strict — it is the host refusing to trust the container — and a
 * `ContainerResult` has fourteen required fields. A test that has to restate all
 * fourteen to say "build failed" ends up saying it wrong, or ends up asserting
 * against a partial cast that the production parser would have rejected. This
 * builder is typed as the real thing, so a fixture that could not survive the
 * round trip does not compile.
 */

import { SCORER_PROTOCOL_VERSION } from "bakeoff/dist/scorer-protocol.js";
import type {
  ContainerResult,
  CriterionCoverage,
  DomFinding,
  ExploitFinding,
  ScreenshotRecord,
  SuiteExecutionRaw,
  Tier0GateResult,
} from "bakeoff/dist/scorer-protocol.js";

const CLEAN_EXECUTION: SuiteExecutionRaw = {
  exitCode: 0,
  durationMs: 1_200,
  testsTotal: 6,
  testsPassed: 6,
  testsFailed: 0,
  timedOut: false,
  reportProblem: null,
};

/** Every field a `ContainerResult` requires, in its "nothing went wrong" state. */
export function containerFixture(patch: Partial<ContainerResult> = {}): ContainerResult {
  return {
    protocolVersion: SCORER_PROTOCOL_VERSION,
    ticketId: "T-fixture",
    acceptanceSuiteSha256: "a".repeat(64),
    startedAt: "2026-07-29T10:00:00.000Z",
    endedAt: "2026-07-29T10:04:00.000Z",
    nodeVersion: "v24.0.0",
    playwrightVersion: "1.50.0",
    tier0: [],
    exploitFindings: [],
    suiteExecution: CLEAN_EXECUTION,
    criterionCoverage: [],
    screenshots: [],
    domFindings: [],
    infrastructureErrors: [],
    ...patch,
  };
}

export function tier0Fixture(patch: Partial<Tier0GateResult> & { readonly id: string }): Tier0GateResult {
  return {
    name: patch.id,
    outcome: "fail",
    detail: "",
    durationMs: 100,
    command: null,
    exitCode: null,
    ...patch,
  };
}

export function coverageFixture(patch: Partial<CriterionCoverage> & { readonly criterionId: string }): CriterionCoverage {
  return {
    tier: "FUNCTIONAL",
    outcome: "failed",
    testRefs: [],
    detail: "",
    ...patch,
  };
}

export function domFindingFixture(patch: Partial<DomFinding> = {}): DomFinding {
  return {
    kind: "console_error",
    flowId: "home",
    breakpoint: "1280x800",
    detail: "",
    ...patch,
  };
}

export function exploitFindingFixture(patch: Partial<ExploitFinding> = {}): ExploitFinding {
  return {
    kind: "equality_override",
    path: "src/app.ts",
    line: 12,
    rule: "always-equal",
    blocking: true,
    detail: "",
    ...patch,
  };
}

export function screenshotFixture(patch: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    flowId: "home",
    breakpoint: "1280x800",
    file: "home-1280x800.png",
    bytes: 40_000,
    width: 1280,
    height: 800,
    sha256: "b".repeat(64),
    maskedSelectors: [],
    maskColor: "#ff00ff",
    nonBlank: true,
    ...patch,
  };
}
