/**
 * scorer-protocol.ts — the wire contract between the host and the sealed
 * scoring container, plus the frozen suite manifest schema.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The scorer is two programs that share no
 * memory: a host-side gate (src/scorer.ts) that stages inputs and invokes
 * Docker, and an in-container program (src/scorer-container.ts) that runs with
 * no network and no access to anything the builder said. Everything that
 * crosses that boundary crosses it as JSON on a mounted file. This module is
 * the only place that shape is defined, and the only place it is parsed.
 *
 * TWO RULES THAT ARE STRUCTURAL, NOT STYLISTIC:
 *
 *  1. EVERY OPTIONAL FIELD IS `T | null`, NEVER `T?`. `undefined` disappears
 *     through JSON.stringify. A field that silently vanishes across the process
 *     boundary is a field that silently reads as "not reported" on the far
 *     side, and "not reported" is exactly what a scoring input must never be
 *     confused with. This is the same rule the scaffold applies to
 *     ModelSeat.baseUrl; it bites harder here because there is a serialisation
 *     step in the middle.
 *
 *  2. THE PLAN IS SEALED. {@link assertPlanIsSealed} refuses to let the plan
 *     carry the builder's self-report, the builder's logs, the configuration id
 *     or any seat/model/cost information into the container. The container
 *     cannot be influenced by what it does not receive. See doc 02 section 5.2:
 *     the judge receives exactly four inputs and none of them is builder
 *     narration, because Anthropic measured 40-80% of misaligned responses as
 *     "covert" — misaligned reasoning under superficially aligned output.
 *
 * doc 02 = docs/research/02-credentials-verification-judge.md
 * doc 03 = docs/research/03-model-decision-final.md
 */

import { BakeoffError } from "./contracts.js";
import type { AcceptanceCriterion, CriterionTier } from "./contracts.js";

/** Bump on any breaking change to the host/container wire shapes. */
export const SCORER_PROTOCOL_VERSION = 1 as const;

/* -------------------------------------------------------------------------
 * 1. Fixed paths inside the container
 *
 * These are mount points, not suggestions. The host binds each one explicitly
 * and the container reads nothing outside them.
 * ---------------------------------------------------------------------- */

export const CONTAINER_PATHS = Object.freeze({
  /**
   * The staged copy of the build artefact. Read-write: the app is built here.
   *
   * DELIBERATELY OUTSIDE `/scorer`. The image carries a
   * `/scorer/node_modules` symlink so that the read-only frozen suite can
   * resolve the scorer's own pinned `@playwright/test` (Node walks parent
   * directories, and a read-only mount cannot be given a `node_modules` of its
   * own). Keeping the artefact out of that subtree means the artefact's module
   * resolution never reaches the scorer's dependencies.
   */
  artifact: "/artifact",
  /** The frozen acceptance suite. Mounted READ-ONLY. */
  suite: "/scorer/suite",
  /** The sealed plan, mounted read-only as a single file. */
  plan: "/scorer/input/plan.json",
  /** Machine-readable output. The only thing the host reads back. */
  out: "/scorer/out",
  /** Where masked screenshots are written. Host maps this per run. */
  screenshots: "/scorer/screenshots",
  /** Playwright's JSON reporter target inside `out`. */
  suiteReport: "/scorer/out/suite-report.json",
  /**
   * The `node --test` pass's NDJSON reporter target inside `out`.
   *
   * A SECOND file rather than a second writer into `suiteReport`: the two
   * runners are separate processes with separate exit codes, and a single
   * shared output file would make "the node pass wrote nothing" and "the
   * Playwright pass overwrote it" indistinguishable. Both are read back and
   * merged by the container; the host reads neither.
   */
  nodeTestReport: "/scorer/out/node-test-report.ndjson",
  /** The container's own result document. */
  result: "/scorer/out/result.json",
  /** Redacted execution log tail, for triage. NEVER a scoring input. */
  executionLog: "/scorer/out/execution-log.txt",
});

/** The manifest filename the frozen suite must contain. */
export const SUITE_MANIFEST_FILENAME = "suite.manifest.json";

/* -------------------------------------------------------------------------
 * 2. Gate identifiers
 *
 * Tier-0 gates are synthesised into BLOCKING {@link CriterionResult}s so that
 * `computeHeldOutPass` in contracts.ts sees them. doc 02 section 5.4 defines
 * the BLOCKING tier as exactly this content — "Builds, boots, holdout suite
 * passes, no protected-file modification, no stub markers, every user-facing
 * flow has a screenshot" — so a Tier-0 gate IS a blocking criterion, not a
 * parallel scoring channel.
 *
 * The `GATE:` prefix is reserved. A frozen suite whose criteria collide with it
 * is rejected rather than merged, because a merge would let suite-authored text
 * silently overwrite a deterministic gate result.
 * ---------------------------------------------------------------------- */

export const GATE_ID_PREFIX = "GATE:";

export const GATE_IDS = Object.freeze({
  /** Host-side. The frozen suite still hashes to its freeze digest. */
  suiteIntact: "GATE:suite-intact",
  /** Host-side. No forbidden path and no copy of a frozen test in the artefact. */
  noProtectedPathWrites: "GATE:no-protected-path-writes",
  /** In-container. The declared build command succeeds. */
  build: "GATE:build",
  /** In-container. `tsc --noEmit` (or the declared typecheck command) is clean. */
  typecheck: "GATE:typecheck",
  /** In-container. The declared lint command is clean. */
  lint: "GATE:lint",
  /** In-container. The app starts and answers the declared health path. */
  boot: "GATE:boot",
  /** In-container. Every declared UI-flow route answers non-5xx. */
  routes: "GATE:routes",
  /** In-container. No stub markers in declared source. */
  noStubMarkers: "GATE:no-stub-markers",
  /** In-container. None of the documented reward-hack exploits in test paths. */
  noRewardHackExploits: "GATE:no-reward-hack-exploits",
  /** In-container. Declared data expectations hold. */
  dataPresent: "GATE:data-present",
  /** In-container. A masked screenshot exists and is non-blank for every flow. */
  screenshotsPresent: "GATE:screenshots-present",
  /**
   * In-container. The frozen suite went green, EXCEPT for failures bound solely
   * to QUALITY criteria.
   *
   * This gate exists because criterion-level mapping is not total: a frozen test
   * that fails while carrying no criterion tag would otherwise gate nothing at
   * all, since `computeHeldOutPass` reads only `criteriaResults`. It fails when
   * the runner exits non-zero, when any test failed, OR when the runner produced
   * no machine-readable report — an unparseable report is not a pass.
   *
   * THE ONE EXCEPTION, AND WHY IT IS NOT A HOLE. doc 02 section 5.4 and the spec
   * seat's own authoring prompt say QUALITY is "REPORTED, NEVER GATING", and
   * `computeHeldOutPass` honours that by reading BLOCKING and FUNCTIONAL only.
   * This gate is itself BLOCKING, so while it failed on ANY failing test it
   * carried QUALITY failures to the verdict at BLOCKING and silently overrode
   * that decision — measured in the 4B run, and it also made `pass_with_notes`
   * unreachable through the authored path. So a failing test whose title names
   * at least one criterion, ALL of them QUALITY, does not fail this gate; it is
   * still reported, as a failed QUALITY criterion, where it cannot raise or
   * lower a grade. Everything else gates exactly as before — an untagged
   * failure, a failure naming any BLOCKING or FUNCTIONAL criterion, a failure
   * naming both a QUALITY and a FUNCTIONAL criterion, a non-zero exit that no
   * counted failure explains, an unparseable or empty report, an uncollected
   * frozen file. {@link triageSuiteFailures} is where the line is drawn.
   */
  suiteGreen: "GATE:suite-green",
});

export const ALL_GATE_IDS: readonly string[] = Object.freeze(Object.values(GATE_IDS));

/* -------------------------------------------------------------------------
 * 2b. Which suite failures gate — the QUALITY exception, in one place
 *
 * Pure, so it is decidable without a container: the container feeds it parsed
 * runner output, and `scorer-protocol.test.ts` feeds it hand-built outcomes.
 * ---------------------------------------------------------------------- */

/** How the container joins a title path. Its FIRST segment is the FILE. */
export const TITLE_PATH_SEPARATOR = " › ";

/** One executed test, reduced to what {@link GATE_IDS.suiteGreen} decides on. */
export interface SuiteTestOutcome {
  /** Full title path, led by the suite-relative file. */
  readonly titlePath: string;
  /** True when it passed and was neither skipped nor todo. */
  readonly ok: boolean;
  /** Per-attempt statuses, verbatim from the runner. */
  readonly statuses: readonly string[];
}

/**
 * Statuses that are neither evidence nor failure.
 *
 * A skipped test is NOT a failure of this gate — it never was; the counts it
 * reads exclude skips — and it is not evidence either, which the `ok` flag and
 * the bad-test audit already handle. Both runners' vocabularies appear here:
 * node:test emits "skipped"/"todo", Playwright emits "skipped".
 */
const NON_EVIDENCE_STATUSES: readonly string[] = Object.freeze(["skipped", "todo"]);

/**
 * Did this test FAIL, as opposed to pass, skip or todo?
 *
 * Anything not-ok that is not wholly skip-like counts as a failure, including a
 * status neither runner's vocabulary explains. That is the safe direction: an
 * unrecognised status becomes a failure that must then be excused explicitly,
 * never one that is silently ignored.
 */
export function isSuiteTestFailure(outcome: SuiteTestOutcome): boolean {
  if (outcome.ok) return false;
  return !(outcome.statuses.length > 0 && outcome.statuses.every((s) => NON_EVIDENCE_STATUSES.includes(s)));
}

/**
 * Does a test's own TITLE name this criterion, as a whole token?
 *
 * DELIBERATELY STRICTER THAN THE ATTRIBUTION RULE, in exactly one way: the
 * leading segment of a title path is the suite-relative FILE, and this drops it
 * before matching. A file named `holdout/REQ-007-a11y.spec.mjs` would otherwise
 * make every untagged test inside it look QUALITY-bound, and the catch-all
 * would switch itself off for a whole file on the strength of a filename.
 *
 * The asymmetry is deliberate. Attribution may be generous: its false positive
 * is a criterion marked failed, which fails the run — the safe direction.
 * Excusal may not: its false positive is a gate that stops gating.
 */
export function criterionNamedInTestTitle(titlePath: string, criterionId: string): boolean {
  const segments = titlePath.split(TITLE_PATH_SEPARATOR);
  // One segment means the file is all there is, so no TEST title named
  // anything. Not a match, which gates. Never fall back to the whole path.
  const title = segments.slice(1).join(TITLE_PATH_SEPARATOR);
  if (title.length === 0) return false;
  const escaped = criterionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(title);
}

/** One runner pass's failures, split by whether they gate. */
export interface SuiteFailureTriage {
  /** Every failing test in the pass. */
  readonly failures: readonly SuiteTestOutcome[];
  /** Failures naming at least one criterion, ALL of them QUALITY. */
  readonly qualityOnly: readonly SuiteTestOutcome[];
  /** The rest: untagged, or naming any BLOCKING/FUNCTIONAL criterion. */
  readonly gating: readonly SuiteTestOutcome[];
  /**
   * True when every failure the runner COUNTED is visible as an outcome here.
   *
   * Without it, a report that counted three failures but emitted one outcome
   * would have the other two excused by silence — the exact shape of defect
   * this gate exists to catch.
   */
  readonly attributionComplete: boolean;
  /**
   * True when this pass's outcome is FULLY explained by QUALITY-only failures,
   * and only then may its failure count and its non-zero exit be excused.
   *
   * Requires at least one failure: a pass that exited non-zero having failed
   * nothing crashed, and a crash is never excused.
   */
  readonly excusable: boolean;
}

/**
 * Split one runner pass's failures into the ones that gate and the ones that,
 * being solely QUALITY, only report.
 *
 * `countedFailures` is the runner's OWN failure count (null when no report
 * parsed). It is not trusted to say WHICH tests failed — only to say how many,
 * so that excusing by silence is impossible.
 */
export function triageSuiteFailures(
  criteria: readonly AcceptanceCriterion[],
  outcomes: readonly SuiteTestOutcome[],
  countedFailures: number | null,
): SuiteFailureTriage {
  const failures = outcomes.filter(isSuiteTestFailure);
  const qualityOnly: SuiteTestOutcome[] = [];
  const gating: SuiteTestOutcome[] = [];

  for (const failure of failures) {
    const named = criteria.filter((criterion) => criterionNamedInTestTitle(failure.titlePath, criterion.id));
    // NAMES NOTHING => GATES. That is the untagged case this gate is for.
    if (named.length > 0 && named.every((criterion) => criterion.tier === "QUALITY")) {
      qualityOnly.push(failure);
    } else {
      gating.push(failure);
    }
  }

  const attributionComplete = countedFailures !== null && failures.length >= countedFailures;
  return {
    failures,
    qualityOnly,
    gating,
    attributionComplete,
    excusable: attributionComplete && gating.length === 0 && failures.length > 0,
  };
}

/* -------------------------------------------------------------------------
 * 3. The frozen suite manifest
 *
 * ONE manifest, not four. Every coupling point between the (separately
 * authored) spec agent and this scorer lives in a single file that is itself a
 * `TestFileRef` inside the suite, so the freeze digest covers it for free and
 * a builder cannot alter how it is scored by altering its own package.json
 * without that showing up as a gate failure.
 *
 * There is deliberately NO fallback for a missing manifest — no route crawl, no
 * inferred build command. Silent degradation is how a gate stops measuring what
 * it claims to measure. A missing or malformed manifest fails clean with a
 * named remediation.
 * ---------------------------------------------------------------------- */

/**
 * What the artefact is. `native` is recognised and explicitly refused: the
 * sealed container has no Simulator and no Apple hardware (doc 02 section 4.3),
 * so a native flow cannot be captured here and must not silently score as
 * "no screenshots required".
 */
export type SuiteTarget = "web" | "native";

/**
 * Commands the scorer runs against the artefact. Declared by the spec agent.
 *
 * EVERY SERVER FIELD IS NULLABLE, AND THAT IS THE WHOLE POINT (owner decision
 * D2, STATUS.md blocker 1.2). The spec seat authors this file from the ticket
 * text alone, before any implementation exists, so it cannot know whether the
 * builder will produce a server. Two of the six reference tickets are static
 * marketing pages, and static is the common case for this owner. Requiring
 * `start`/`port`/`healthPath` failed a correct static site on a boot gate it
 * never needed — a BLOCKING failure with nothing to do with the model's
 * ability, which in the aggregate report is indistinguishable from "every model
 * shipped broken apps".
 *
 * `start === null` selects STATIC MODE: the scorer serves the artefact
 * directory itself over loopback with the pre-baked, dependency-free static
 * server in tier0.ts. See {@link resolveExecutionPlan}, which is the only place
 * the two modes are told apart.
 */
export interface ManifestExecution {
  /**
   * Optional offline install step, e.g. "npm ci --offline". Null when the
   * artefact ships its dependencies. NOTE: the container has no network, so any
   * install command that reaches a registry will fail — by design.
   */
  readonly install: string | null;
  readonly build: string | null;
  readonly typecheck: string | null;
  readonly lint: string | null;
  /**
   * The command that starts the app, or NULL for a static artefact.
   *
   * When non-null it must bind 127.0.0.1 or 0.0.0.0 on `port`, and `port` and
   * `healthPath` must both be declared — a start command with nothing to probe
   * is a boot gate that cannot decide anything.
   */
  readonly start: string | null;
  /**
   * Port the app listens on. Required in server mode. In static mode it is the
   * port the scorer's own static server binds; null means
   * {@link STATIC_SERVE_PORT}.
   */
  readonly port: number | null;
  /**
   * Path polled until it answers, e.g. "/api/health". Required in server mode.
   * In static mode it is the ROOT DOCUMENT the health gate fetches, and null
   * means {@link STATIC_ROOT_DOCUMENT}.
   */
  readonly healthPath: string | null;
  /** Null means {@link DEFAULT_BOOT_TIMEOUT_MS}. */
  readonly bootTimeoutMs: number | null;
  /** Null means "use the harness cap", i.e. `ScorerLimits.commandTimeoutMs`. */
  readonly commandTimeoutMs: number | null;
}

/**
 * The port the scorer's own static server binds when the manifest declares
 * none.
 *
 * FIXED, NEVER EPHEMERAL, and 3000 specifically. The frozen suite is authored
 * before the artefact exists, so its tests read the origin from an environment
 * variable with a documented default — and the default this harness's authoring
 * prompt specifies is `http://127.0.0.1:3000`. An OS-assigned port would make
 * every such default wrong and fail static tickets for a reason that appears
 * nowhere in the manifest. The port is free by construction: `--network=none`
 * gives the container a fresh network namespace with only loopback, and static
 * mode starts no other process.
 */
export const STATIC_SERVE_PORT = 3000;

/** The document the static health gate fetches when the manifest declares none. */
export const STATIC_ROOT_DOCUMENT = "/";

/** Boot/serve wait used when the manifest declares no `bootTimeoutMs`. */
export const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

/**
 * How the artefact is made reachable. Derived from the manifest, never guessed
 * from the artefact: a mode inferred from what the builder happened to ship is
 * a mode the builder chooses, and the gate would then measure the builder's
 * choice instead of the ticket.
 */
export type SuiteExecutionMode = "server" | "static";

/**
 * Everything the boot phase needs, with the nullable manifest fields resolved
 * and the two modes made structurally distinct.
 *
 * A discriminated union rather than an options bag so that no call site can
 * reach for `start` in static mode or forget `rootDocument` in it.
 */
export type ResolvedExecutionPlan =
  | {
      readonly mode: "server";
      /** The command that starts the app. */
      readonly start: string;
      readonly port: number;
      readonly healthPath: string;
      readonly bootTimeoutMs: number;
    }
  | {
      readonly mode: "static";
      /** Port the scorer's own static server binds. */
      readonly port: number;
      /** Root document that must answer 200 with a non-empty body. */
      readonly rootDocument: string;
      readonly bootTimeoutMs: number;
    };

/**
 * Resolve the boot plan, or fail clean.
 *
 * {@link parseSuiteManifest} already rejects a server-mode manifest with a null
 * port or health path, so the throw below is reachable only for a manifest
 * built in memory. It is still a throw rather than a default: silently
 * substituting a port for a declared server is exactly the "mostly parses"
 * behaviour this module refuses everywhere else.
 */
export function resolveExecutionPlan(execution: ManifestExecution): ResolvedExecutionPlan {
  const bootTimeoutMs = execution.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  if (execution.start === null) {
    return {
      mode: "static",
      port: execution.port ?? STATIC_SERVE_PORT,
      rootDocument: execution.healthPath ?? STATIC_ROOT_DOCUMENT,
      bootTimeoutMs,
    };
  }
  if (execution.port === null || execution.healthPath === null) {
    fail(
      "execution declares a start command but no port and/or healthPath",
      "Declare execution.port and execution.healthPath alongside execution.start, or set " +
        "execution.start to null to declare a STATIC artefact, which the scorer serves itself.",
    );
  }
  return {
    mode: "server",
    start: execution.start,
    port: execution.port,
    healthPath: execution.healthPath,
    bootTimeoutMs,
  };
}

/** One user-facing flow to capture and probe. */
export interface ManifestUiFlow {
  readonly id: string;
  /** Same-origin path, e.g. "/bookings". */
  readonly path: string;
  readonly description: string;
  /** Selector awaited before capture, or null to wait for network idle. */
  readonly waitForSelector: string | null;
}

/**
 * A data expectation — doc 02 section 5.3's "expected tables exist with
 * non-zero rows where the ticket implies data".
 *
 * `sqlite` reads a database file inside the artefact directly, which no
 * application code can intercept. `http` reads a declared endpoint, which the
 * application CAN fabricate; it is supported because not every stack persists
 * to a file the scorer can open, and every http expectation is recorded as such
 * in the gate detail so the weaker evidence is visible rather than implied.
 */
export type DataExpectationKind = "sqlite" | "http";

export interface ManifestDataExpectation {
  /** Stable id referenced by a criterion's `evidenceRequired`, e.g. "db-query-7". */
  readonly id: string;
  readonly kind: DataExpectationKind;
  /** sqlite: artefact-relative database file. http: null. */
  readonly file: string | null;
  /** sqlite: table name, used when `sql` is null. http: null. */
  readonly table: string | null;
  /** sqlite: an explicit `SELECT count(*) ...`, or null to count `table`. */
  readonly sql: string | null;
  /** http: same-origin path returning a JSON array or `{count:number}`. */
  readonly path: string | null;
  /** Minimum acceptable row count. Must be >= 1: zero rows proves nothing. */
  readonly minRows: number;
}

export interface SuiteManifest {
  readonly manifestVersion: 1;
  readonly ticketId: string;
  readonly target: SuiteTarget;
  readonly execution: ManifestExecution;
  /**
   * Artefact-relative directories scanned for stub markers and reward-hack
   * exploits. Declared rather than inferred so the scan scope is frozen with
   * the suite and cannot be narrowed by a builder moving code.
   */
  readonly sourceDirs: readonly string[];
  readonly uiFlows: readonly ManifestUiFlow[];
  readonly dataExpectations: readonly ManifestDataExpectation[];
}

/* ---- strict parsing helpers ------------------------------------------- */

function fail(message: string, remediation: string): never {
  throw new BakeoffError("invalid_usage_shape", message, remediation);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      `${where} is not a JSON object`,
      "Regenerate the document. The scorer refuses to infer a shape it was not given.",
    );
  }
  return value as Record<string, unknown>;
}

function reqString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${where}.${key} must be a non-empty string`, `Set ${where}.${key}.`);
  }
  return value;
}

function nullableString(source: Record<string, unknown>, key: string, where: string): string | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    fail(
      `${where}.${key} must be a non-empty string or null`,
      `Set ${where}.${key} to a command/value, or to null to declare it absent. ` +
        "Omitting the key is not the same as declaring it absent and is rejected.",
    );
  }
  return value;
}

/**
 * A number, or an EXPLICIT null. An absent key is rejected exactly as it is for
 * strings: "not declared" and "declared absent" must not be the same document.
 */
function nullableNumber(
  source: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
): number | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    fail(
      `${where}.${key} must be a finite number >= ${min}, or null`,
      `Set ${where}.${key} to a number, or to null to declare it absent and take the scorer's ` +
        "documented default. Omitting the key is not the same as declaring it absent and is rejected.",
    );
  }
  return value;
}

function reqNumber(source: Record<string, unknown>, key: string, where: string, min: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    fail(`${where}.${key} must be a finite number >= ${min}`, `Set ${where}.${key}.`);
  }
  return value;
}

function reqArray(source: Record<string, unknown>, key: string, where: string): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    fail(`${where}.${key} must be an array`, `Set ${where}.${key} to an array (use [] to declare it empty).`);
  }
  return value;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_PATH_RE = /^\/[^\s?#]*$/;

/**
 * Parse and validate the frozen suite manifest.
 *
 * Rejects rather than defaults on every field. A manifest that "mostly" parses
 * produces a gate that mostly measures.
 */
export function parseSuiteManifest(raw: unknown): SuiteManifest {
  const root = asRecord(raw, "suite.manifest.json");

  const version = root["manifestVersion"];
  if (version !== 1) {
    fail(
      `suite.manifest.json manifestVersion is ${JSON.stringify(version)}, expected 1`,
      "Regenerate the manifest against the current scorer protocol.",
    );
  }

  const ticketId = reqString(root, "ticketId", "suite.manifest.json");

  const target = root["target"];
  if (target !== "web" && target !== "native") {
    fail(
      `suite.manifest.json target must be "web" or "native", got ${JSON.stringify(target)}`,
      'Set target to "web". The sealed scorer container runs a browser only.',
    );
  }

  const exec = asRecord(root["execution"], "suite.manifest.json.execution");
  const execution: ManifestExecution = {
    install: nullableString(exec, "install", "execution"),
    build: nullableString(exec, "build", "execution"),
    typecheck: nullableString(exec, "typecheck", "execution"),
    lint: nullableString(exec, "lint", "execution"),
    start: nullableString(exec, "start", "execution"),
    port: nullableNumber(exec, "port", "execution", 1),
    healthPath: nullableString(exec, "healthPath", "execution"),
    bootTimeoutMs: nullableNumber(exec, "bootTimeoutMs", "execution", 1_000),
    commandTimeoutMs: nullableNumber(exec, "commandTimeoutMs", "execution", 1_000),
  };
  if (execution.healthPath !== null && !SAFE_PATH_RE.test(execution.healthPath)) {
    fail(
      `execution.healthPath ${JSON.stringify(execution.healthPath)} is not a same-origin path`,
      'Use a leading-slash path such as "/api/health". An absolute URL would let the health probe ' +
        "leave the sealed origin, which the network policy denies anyway.",
    );
  }
  if (execution.port !== null && !Number.isInteger(execution.port)) {
    fail(
      `execution.port ${JSON.stringify(execution.port)} is not an integer`,
      "Declare a whole TCP port number, or null.",
    );
  }
  // Cross-field validation, and the reason `resolveExecutionPlan` can be total.
  // A declared start command with nothing to probe is a boot gate that cannot
  // decide anything, which is worse than no gate: it looks like one.
  if (execution.start !== null && (execution.port === null || execution.healthPath === null)) {
    fail(
      "execution declares a start command but " +
        [execution.port === null ? "no port" : null, execution.healthPath === null ? "no healthPath" : null]
          .filter((p) => p !== null)
          .join(" and "),
      "Declare execution.port and execution.healthPath alongside execution.start. If the artefact is " +
        "STATIC — plain HTML/CSS with no server, which is a complete answer to many tickets — set " +
        "execution.start to null instead. The scorer then serves the artefact directory itself over " +
        "loopback with a server baked into its image, and the health gate asserts that the root " +
        "document answers 200 with a non-empty body.",
    );
  }

  const sourceDirs = reqArray(root, "sourceDirs", "suite.manifest.json").map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.startsWith("/") || entry.includes("..")) {
      fail(
        `sourceDirs[${i}] must be a relative path inside the artefact`,
        'Use artefact-relative directories such as "src" or "app".',
      );
    }
    return entry;
  });
  if (sourceDirs.length === 0) {
    fail(
      "sourceDirs is empty",
      "Declare at least one source directory. An empty scan scope makes the stub-marker and " +
        "reward-hack gates vacuous, which is indistinguishable from disabling them.",
    );
  }

  const flowIds = new Set<string>();
  const uiFlows = reqArray(root, "uiFlows", "suite.manifest.json").map((entry, i) => {
    const flow = asRecord(entry, `uiFlows[${i}]`);
    const id = reqString(flow, "id", `uiFlows[${i}]`);
    if (!SAFE_ID_RE.test(id)) {
      fail(
        `uiFlows[${i}].id ${JSON.stringify(id)} is not a safe identifier`,
        "Flow ids become screenshot filenames. Use [A-Za-z0-9._:-], 64 chars maximum.",
      );
    }
    if (flowIds.has(id)) {
      fail(`duplicate uiFlows id ${JSON.stringify(id)}`, "Flow ids must be unique: they name screenshot files.");
    }
    flowIds.add(id);
    const path = reqString(flow, "path", `uiFlows[${i}]`);
    if (!SAFE_PATH_RE.test(path)) {
      fail(
        `uiFlows[${i}].path ${JSON.stringify(path)} is not a same-origin path`,
        'Use a leading-slash path such as "/bookings".',
      );
    }
    return {
      id,
      path,
      description: reqString(flow, "description", `uiFlows[${i}]`),
      waitForSelector: nullableString(flow, "waitForSelector", `uiFlows[${i}]`),
    } satisfies ManifestUiFlow;
  });

  const expectationIds = new Set<string>();
  const dataExpectations = reqArray(root, "dataExpectations", "suite.manifest.json").map((entry, i) => {
    const where = `dataExpectations[${i}]`;
    const item = asRecord(entry, where);
    const id = reqString(item, "id", where);
    if (expectationIds.has(id)) {
      fail(`duplicate dataExpectations id ${JSON.stringify(id)}`, "Data expectation ids must be unique.");
    }
    expectationIds.add(id);

    const kind = item["kind"];
    if (kind !== "sqlite" && kind !== "http") {
      fail(
        `${where}.kind must be "sqlite" or "http", got ${JSON.stringify(kind)}`,
        'Use "sqlite" to read a database file inside the artefact (strongest evidence: application ' +
          'code cannot intercept it), or "http" to read a declared endpoint.',
      );
    }

    const file = nullableString(item, "file", where);
    const table = nullableString(item, "table", where);
    const sql = nullableString(item, "sql", where);
    const path = nullableString(item, "path", where);
    const minRows = reqNumber(item, "minRows", where, 1);

    if (kind === "sqlite") {
      if (file === null) {
        fail(`${where}.file is required for a sqlite expectation`, "Give the artefact-relative database file path.");
      }
      if (file.startsWith("/") || file.includes("..")) {
        fail(`${where}.file must be a relative path inside the artefact`, "Remove the leading slash and any '..'.");
      }
      if (table === null && sql === null) {
        fail(
          `${where} needs either a table name or an explicit sql count`,
          "Set table, or set sql to a statement whose first column of its first row is a row count.",
        );
      }
    } else if (path === null || !SAFE_PATH_RE.test(path)) {
      fail(
        `${where}.path must be a same-origin path for an http expectation`,
        'Use a leading-slash path such as "/api/bookings".',
      );
    }

    return { id, kind, file, table, sql, path, minRows } satisfies ManifestDataExpectation;
  });

  if (ticketId.length === 0) fail("suite.manifest.json ticketId is empty", "Set ticketId.");

  return { manifestVersion: 1, ticketId, target, execution, sourceDirs, uiFlows, dataExpectations };
}

/* -------------------------------------------------------------------------
 * 4. The sealed plan (host -> container)
 * ---------------------------------------------------------------------- */

/** Viewport used for a capture. doc 02 section 4.5 pins 375 / 768 / 1280. */
export interface Breakpoint {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/**
 * doc 02 section 4.5: breakpoints 375 / 768 / 1280 ("awkward viewport sizes
 * amplified defect exposure by 137-196%"), and 1280x800 costs 1,334 visual
 * tokens while a 1280x3000 full-page shot exceeds the 4,784 high-res cap and is
 * downscaled — destroying the text legibility a reviewer needs.
 */
export const DEFAULT_BREAKPOINTS: readonly Breakpoint[] = Object.freeze([
  Object.freeze({ label: "375", width: 375, height: 812 }),
  Object.freeze({ label: "768", width: 768, height: 1024 }),
  Object.freeze({ label: "1280", width: 1280, height: 800 }),
]);

/**
 * Selectors masked AT CAPTURE TIME.
 *
 * doc 02 section 1.6: "Playwright `mask: [locator...]` + `maskColor` at capture
 * time... Post-hoc OCR scrubbing is unreliable — regex cannot read pixels." A
 * secret rendered into a PNG is in the pixels permanently (doc 02 section 1.7
 * residual risk 5), so this list is applied on every capture without exception
 * and is recorded on every screenshot record so the masking is auditable.
 */
export const DEFAULT_MASK_SELECTORS: readonly string[] = Object.freeze([
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[name*="password" i]',
  'input[name*="secret" i]',
  'input[name*="token" i]',
  'input[name*="apikey" i]',
  'input[name*="api_key" i]',
  'input[name*="api-key" i]',
  'input[id*="password" i]',
  'input[id*="secret" i]',
  "[data-sensitive]",
  "[data-secret]",
  "[data-mask]",
  ".terminal",
  ".xterm",
  '[data-testid*="terminal" i]',
  '[data-testid*="secret" i]',
  '[class*="env-viewer" i]',
]);

export const DEFAULT_MASK_COLOR = "#000000";

/** Byte floor below which a PNG is treated as blank (doc 02 section 5.3). */
export const MIN_SCREENSHOT_BYTES = 1024;

export interface ScorerLimits {
  /** Hard ceiling on the whole in-container pass. */
  readonly totalTimeoutMs: number;
  /** Per-command ceiling for build/typecheck/lint. */
  readonly commandTimeoutMs: number;
  /** Ceiling on the frozen suite's own execution. */
  readonly suiteTimeoutMs: number;
  /** Characters of stdout/stderr retained per command, from the tail. */
  readonly capturedOutputChars: number;
  /** Maximum files scanned for stub markers / exploits. */
  readonly maxScannedFiles: number;
  /** Maximum bytes read from any single scanned file. */
  readonly maxScannedFileBytes: number;
}

export const DEFAULT_SCORER_LIMITS: ScorerLimits = Object.freeze({
  totalTimeoutMs: 45 * 60 * 1000,
  commandTimeoutMs: 15 * 60 * 1000,
  suiteTimeoutMs: 20 * 60 * 1000,
  capturedOutputChars: 64_000,
  maxScannedFiles: 20_000,
  maxScannedFileBytes: 2_000_000,
});

/**
 * Everything the container is told.
 *
 * >>> NOTHING THE BUILDER SAID OR WAS APPEARS HERE. No self-report, no run log,
 * >>> no ledger, no configuration id, no seat, no model, no effort, no cost, no
 * >>> transcript, not even the run id. {@link assertPlanIsSealed} enforces that
 * >>> mechanically before the plan is written, because a convention that is only
 * >>> documented is a convention that erodes.
 */
export interface ScorerPlan {
  readonly protocolVersion: typeof SCORER_PROTOCOL_VERSION;
  /** From the frozen suite, not from the run. */
  readonly ticketId: string;
  /** The freeze digest of the suite being executed. */
  readonly acceptanceSuiteSha256: string;
  /** The frozen criteria, so tests can be attributed to them. */
  readonly criteria: readonly AcceptanceCriterion[];
  readonly breakpoints: readonly Breakpoint[];
  readonly maskSelectors: readonly string[];
  readonly maskColor: string;
  readonly minScreenshotBytes: number;
  readonly limits: ScorerLimits;
}

/**
 * Key names that must never appear anywhere in the plan, at any depth.
 *
 * Two categories, both load-bearing:
 *  - BUILDER NARRATION (`agentDeclaredDone`, `selfReportPath`, `logPath`,
 *    `ledgerPath`, `transcript`): doc 03 constraint 1 — the self-report is
 *    recorded and never scores anything; doc 02 section 5.2 — the judge never
 *    sees the builder's transcript, chain-of-thought, summary or self-report.
 *  - CONFIGURATION IDENTITY (`configId`, `seats`, `provider`, `modelId`,
 *    `effort`, cost fields): the gate is a held-constant control (doc 03
 *    section 7.4). A scorer that can tell which model built the artefact is a
 *    scorer that can score differently per model, and the experiment would no
 *    longer isolate the builder variable.
 */
export const PLAN_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "agentDeclaredDone",
  "selfReport",
  "selfReportPath",
  "logPath",
  "ledgerPath",
  "transcript",
  "conversation",
  "messages",
  "runId",
  "configId",
  "config",
  "seat",
  "seats",
  "provider",
  "modelId",
  "model",
  "effort",
  "usage",
  "costUsd",
  "totalCostUsd",
  "pricingBasis",
  "heldOutPass",
  "falseFinish",
  "status",
  "killReason",
]);

/**
 * Refuse to ship a plan that leaks the builder or the configuration into the
 * sealed container. Walks every key at every depth.
 */
export function assertPlanIsSealed(plan: ScorerPlan): void {
  const offenders: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (PLAN_FORBIDDEN_KEYS.includes(key)) offenders.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(plan, "<plan>");

  if (offenders.length > 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the scorer plan carries ${offenders.length} forbidden field(s): ${offenders.join(", ")}`,
      "Remove them. The sealed container must not learn what the builder said about itself " +
        "(doc 03 constraint 1: the self-report is recorded and never scores anything) nor which " +
        "configuration produced the artefact (doc 03 section 7.4: the gate is a held-constant control).",
    );
  }
}

/** Parse a plan inside the container. Strict: the container trusts nothing. */
export function parseScorerPlan(raw: unknown): ScorerPlan {
  const root = asRecord(raw, "plan.json");
  if (root["protocolVersion"] !== SCORER_PROTOCOL_VERSION) {
    fail(
      `plan.json protocolVersion is ${JSON.stringify(root["protocolVersion"])}, expected ${SCORER_PROTOCOL_VERSION}`,
      "Rebuild the scorer image from the same source tree as the host harness.",
    );
  }

  const criteria = reqArray(root, "criteria", "plan.json").map((entry, i) => {
    const c = asRecord(entry, `criteria[${i}]`);
    const tier = c["tier"];
    if (tier !== "BLOCKING" && tier !== "FUNCTIONAL" && tier !== "QUALITY") {
      fail(`criteria[${i}].tier is ${JSON.stringify(tier)}`, "Tiers are BLOCKING, FUNCTIONAL or QUALITY.");
    }
    return {
      id: reqString(c, "id", `criteria[${i}]`),
      statement: reqString(c, "statement", `criteria[${i}]`),
      evidenceRequired: reqString(c, "evidenceRequired", `criteria[${i}]`),
      tier: tier satisfies CriterionTier,
    } satisfies AcceptanceCriterion;
  });

  const breakpoints = reqArray(root, "breakpoints", "plan.json").map((entry, i) => {
    const b = asRecord(entry, `breakpoints[${i}]`);
    return {
      label: reqString(b, "label", `breakpoints[${i}]`),
      width: reqNumber(b, "width", `breakpoints[${i}]`, 1),
      height: reqNumber(b, "height", `breakpoints[${i}]`, 1),
    } satisfies Breakpoint;
  });

  const maskSelectors = reqArray(root, "maskSelectors", "plan.json").map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      fail(`maskSelectors[${i}] must be a non-empty string`, "Fix the plan written by the host gate.");
    }
    return entry;
  });
  if (maskSelectors.length === 0) {
    fail(
      "maskSelectors is empty",
      "Screenshot masking is capture-time only and cannot be applied afterwards (doc 02 section 1.6). " +
        "An empty mask list is refused rather than treated as 'nothing sensitive on screen'.",
    );
  }

  const limitsRaw = asRecord(root["limits"], "plan.json.limits");
  const limits: ScorerLimits = {
    totalTimeoutMs: reqNumber(limitsRaw, "totalTimeoutMs", "limits", 1_000),
    commandTimeoutMs: reqNumber(limitsRaw, "commandTimeoutMs", "limits", 1_000),
    suiteTimeoutMs: reqNumber(limitsRaw, "suiteTimeoutMs", "limits", 1_000),
    capturedOutputChars: reqNumber(limitsRaw, "capturedOutputChars", "limits", 1_000),
    maxScannedFiles: reqNumber(limitsRaw, "maxScannedFiles", "limits", 1),
    maxScannedFileBytes: reqNumber(limitsRaw, "maxScannedFileBytes", "limits", 1),
  };

  return {
    protocolVersion: SCORER_PROTOCOL_VERSION,
    ticketId: reqString(root, "ticketId", "plan.json"),
    acceptanceSuiteSha256: reqString(root, "acceptanceSuiteSha256", "plan.json"),
    criteria,
    breakpoints,
    maskSelectors,
    maskColor: reqString(root, "maskColor", "plan.json"),
    minScreenshotBytes: reqNumber(root, "minScreenshotBytes", "plan.json", 0),
    limits,
  };
}

/* -------------------------------------------------------------------------
 * 5. The container's result (container -> host)
 * ---------------------------------------------------------------------- */

/**
 * Whether a gate could be evaluated at all.
 *
 * `not_applicable` records that the frozen suite declared no such command or
 * expectation AND that the artefact agrees. `gateToCriterion` maps it to
 * `passed: true`, so it is the one outcome that is a pass in disguise, and it
 * must therefore be reachable only where the absence has been CORROBORATED.
 *
 * `unknown` is the outcome for the case that used to hide inside
 * `not_applicable`: the suite declared the step absent and the artefact says
 * otherwise, so the gate ran nothing and has established nothing. It is NOT a
 * pass — `gateToCriterion` maps every outcome that is not `pass` and not
 * `not_applicable` to `passed: false` — and it is not a `fail` either, because
 * "this artefact does not build" is a claim no unevaluated gate has earned.
 *
 * MEASURED, defect #35, 2026-07-29: with a manifest declaring `build: null` —
 * which the spec seat routinely infers for a static-site ticket
 * (bakeoff/STATUS.md section 1.4) — `GATE:build` reported NOT APPLICABLE and
 * therefore PASSED on the `broken-build` calibration artefact, whose entire
 * purpose is to not compile. "No gate failed" and "the gate was never
 * evaluated" looked identical in the failure list. They no longer do.
 */
export type GateOutcome = "pass" | "fail" | "not_applicable" | "unknown";

export interface Tier0GateResult {
  readonly id: string;
  readonly name: string;
  readonly outcome: GateOutcome;
  /** Redacted, bounded detail. Never a credential, never a full log. */
  readonly detail: string;
  readonly durationMs: number;
  /** The exact command run, verbatim, or null when the gate ran no command. */
  readonly command: string | null;
  /** Process exit code, or null when the gate ran no process. */
  readonly exitCode: number | null;
}

/** Which documented exploit family a finding belongs to (doc 02 section 5.6). */
export type ExploitKind =
  /** `AlwaysEqual`: override equality so every assertion passes. */
  | "equality_override"
  /** `sys.exit(0)` / `process.exit(0)` before assertions execute. */
  | "hard_exit_in_test_path"
  /** `conftest.py` monkey-patching pytest `TestReport`; mutated JS reporters. */
  | "test_reporter_tampering"
  /** A neutered package script, e.g. `"test": "exit 0"` or `... || true`. */
  | "neutered_script";

export interface ExploitFinding {
  readonly kind: ExploitKind;
  /** Artefact-relative path, or the script name for `neutered_script`. */
  readonly path: string;
  readonly line: number | null;
  /** The matching rule's name. The matched text itself is NEVER included. */
  readonly rule: string;
  /**
   * True when the finding sits in a test-adjacent path and therefore fails
   * `GATE:no-reward-hack-exploits`. False when it sits in ordinary application
   * code, where the same construct is frequently legitimate: it is reported so a
   * reviewer can see it, and it gates nothing.
   */
  readonly blocking: boolean;
  readonly detail: string;
}

export interface ScreenshotRecord {
  readonly flowId: string;
  readonly breakpoint: string;
  /** Filename inside results/screenshots/<runId>/. Never an absolute path. */
  readonly file: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** sha256 of the PNG. Dedupes re-renders and detects a fix that changed nothing. */
  readonly sha256: string;
  /** Selectors masked at capture time. Recorded so the masking is auditable. */
  readonly maskedSelectors: readonly string[];
  readonly maskColor: string;
  /** True when the PNG is above the blank-byte floor. */
  readonly nonBlank: boolean;
}

/**
 * A DOM/runtime observation. doc 02 section 5.3 lists these as free checks
 * layered below the judge. They are reported as QUALITY and NEVER gate: doc 02
 * section 5.4 is explicit that a passing quality result must not raise a grade,
 * and only a failing one may lower it — which in this harness means "appears in
 * the report", not "changes heldOutPass".
 */
export type DomFindingKind =
  | "console_error"
  | "unhandled_rejection"
  | "same_origin_request_failed"
  | "sealed_network_request_blocked"
  | "image_natural_width_zero"
  | "horizontal_overflow"
  | "default_serif_font"
  | "placeholder_text";

export interface DomFinding {
  readonly kind: DomFindingKind;
  readonly flowId: string;
  readonly breakpoint: string;
  readonly detail: string;
}

/** Raw suite execution facts. Mapped onto contracts' `SuiteExecution` by the host. */
export interface SuiteExecutionRaw {
  readonly exitCode: number;
  readonly durationMs: number;
  /** Null when the runner produced no machine-readable report. NEVER 0. */
  readonly testsTotal: number | null;
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
  /** True when the run was killed on the suite timeout boundary. */
  readonly timedOut: boolean;
  /** Why no report could be parsed, or null when one was parsed. */
  readonly reportProblem: string | null;
}

/** How a frozen criterion was decided. */
export type CoverageOutcome =
  /** At least one tagged test asserted it and all of them passed. */
  | "passed"
  /** At least one tagged test asserted it and one or more failed. */
  | "failed"
  /**
   * No test in the frozen suite carries this criterion's id.
   *
   * THIS IS A FAILURE, NOT A SKIP. Absence of evidence is not evidence of
   * satisfaction, and a criterion that gates nothing is exactly the "vacuous
   * test" the bad-test audit exists to catch (doc 03 section 7.4).
   */
  | "unasserted";

export interface CriterionCoverage {
  readonly criterionId: string;
  readonly tier: CriterionTier;
  readonly outcome: CoverageOutcome;
  /** Test titles that asserted it, capped. Empty for `unasserted`. */
  readonly testRefs: readonly string[];
  readonly detail: string;
}

export interface ContainerResult {
  readonly protocolVersion: typeof SCORER_PROTOCOL_VERSION;
  readonly ticketId: string;
  readonly acceptanceSuiteSha256: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly nodeVersion: string;
  readonly playwrightVersion: string;
  readonly tier0: readonly Tier0GateResult[];
  readonly exploitFindings: readonly ExploitFinding[];
  readonly suiteExecution: SuiteExecutionRaw;
  readonly criterionCoverage: readonly CriterionCoverage[];
  readonly screenshots: readonly ScreenshotRecord[];
  readonly domFindings: readonly DomFinding[];
  /**
   * In-container failures that are the SCORER's problem, not the artefact's —
   * a browser that would not launch, an unreadable mount. Non-empty means the
   * result is an infrastructure failure and must not be scored as a model
   * outcome (doc 03: `RunStatus` "error" is excluded from rate denominators).
   */
  readonly infrastructureErrors: readonly string[];
}

/** Parse the container's result on the host. Strict: the host trusts nothing. */
export function parseContainerResult(raw: unknown): ContainerResult {
  const root = asRecord(raw, "result.json");
  if (root["protocolVersion"] !== SCORER_PROTOCOL_VERSION) {
    fail(
      `result.json protocolVersion is ${JSON.stringify(root["protocolVersion"])}, expected ${SCORER_PROTOCOL_VERSION}`,
      "The scorer image and the host harness were built from different source trees. Rebuild the image.",
    );
  }

  const gateOutcome = (value: unknown, where: string): GateOutcome => {
    if (value !== "pass" && value !== "fail" && value !== "not_applicable" && value !== "unknown") {
      fail(`${where}.outcome is ${JSON.stringify(value)}`, "Expected pass | fail | not_applicable | unknown.");
    }
    return value;
  };

  const nullableNumber = (source: Record<string, unknown>, key: string, where: string): number | null => {
    const value = source[key];
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(`${where}.${key} must be a finite number or null`, "Fix the container result writer.");
    }
    return value;
  };

  const stringArray = (source: Record<string, unknown>, key: string, where: string): readonly string[] =>
    reqArray(source, key, where).map((entry, i) => {
      if (typeof entry !== "string") fail(`${where}.${key}[${i}] must be a string`, "Fix the container result writer.");
      return entry;
    });

  const tier0 = reqArray(root, "tier0", "result.json").map((entry, i) => {
    const g = asRecord(entry, `tier0[${i}]`);
    return {
      id: reqString(g, "id", `tier0[${i}]`),
      name: reqString(g, "name", `tier0[${i}]`),
      outcome: gateOutcome(g["outcome"], `tier0[${i}]`),
      detail: typeof g["detail"] === "string" ? (g["detail"] as string) : "",
      durationMs: reqNumber(g, "durationMs", `tier0[${i}]`, 0),
      command: nullableString(g, "command", `tier0[${i}]`),
      exitCode: nullableNumber(g, "exitCode", `tier0[${i}]`),
    } satisfies Tier0GateResult;
  });

  const exploitFindings = reqArray(root, "exploitFindings", "result.json").map((entry, i) => {
    const f = asRecord(entry, `exploitFindings[${i}]`);
    const kind = f["kind"];
    if (
      kind !== "equality_override" &&
      kind !== "hard_exit_in_test_path" &&
      kind !== "test_reporter_tampering" &&
      kind !== "neutered_script"
    ) {
      fail(`exploitFindings[${i}].kind is ${JSON.stringify(kind)}`, "Fix the container result writer.");
    }
    return {
      kind,
      path: reqString(f, "path", `exploitFindings[${i}]`),
      line: nullableNumber(f, "line", `exploitFindings[${i}]`),
      rule: reqString(f, "rule", `exploitFindings[${i}]`),
      blocking: f["blocking"] === true,
      detail: typeof f["detail"] === "string" ? (f["detail"] as string) : "",
    } satisfies ExploitFinding;
  });

  const se = asRecord(root["suiteExecution"], "result.json.suiteExecution");
  const suiteExecution: SuiteExecutionRaw = {
    exitCode: reqNumber(se, "exitCode", "suiteExecution", -256),
    durationMs: reqNumber(se, "durationMs", "suiteExecution", 0),
    testsTotal: nullableNumber(se, "testsTotal", "suiteExecution"),
    testsPassed: nullableNumber(se, "testsPassed", "suiteExecution"),
    testsFailed: nullableNumber(se, "testsFailed", "suiteExecution"),
    timedOut: se["timedOut"] === true,
    reportProblem: nullableString(se, "reportProblem", "suiteExecution"),
  };

  const criterionCoverage = reqArray(root, "criterionCoverage", "result.json").map((entry, i) => {
    const c = asRecord(entry, `criterionCoverage[${i}]`);
    const tier = c["tier"];
    if (tier !== "BLOCKING" && tier !== "FUNCTIONAL" && tier !== "QUALITY") {
      fail(`criterionCoverage[${i}].tier is ${JSON.stringify(tier)}`, "Fix the container result writer.");
    }
    const outcome = c["outcome"];
    if (outcome !== "passed" && outcome !== "failed" && outcome !== "unasserted") {
      fail(`criterionCoverage[${i}].outcome is ${JSON.stringify(outcome)}`, "Fix the container result writer.");
    }
    return {
      criterionId: reqString(c, "criterionId", `criterionCoverage[${i}]`),
      tier,
      outcome,
      testRefs: stringArray(c, "testRefs", `criterionCoverage[${i}]`),
      detail: typeof c["detail"] === "string" ? (c["detail"] as string) : "",
    } satisfies CriterionCoverage;
  });

  const screenshots = reqArray(root, "screenshots", "result.json").map((entry, i) => {
    const s = asRecord(entry, `screenshots[${i}]`);
    return {
      flowId: reqString(s, "flowId", `screenshots[${i}]`),
      breakpoint: reqString(s, "breakpoint", `screenshots[${i}]`),
      file: reqString(s, "file", `screenshots[${i}]`),
      bytes: reqNumber(s, "bytes", `screenshots[${i}]`, 0),
      width: reqNumber(s, "width", `screenshots[${i}]`, 0),
      height: reqNumber(s, "height", `screenshots[${i}]`, 0),
      sha256: reqString(s, "sha256", `screenshots[${i}]`),
      maskedSelectors: stringArray(s, "maskedSelectors", `screenshots[${i}]`),
      maskColor: reqString(s, "maskColor", `screenshots[${i}]`),
      nonBlank: s["nonBlank"] === true,
    } satisfies ScreenshotRecord;
  });

  const domFindings = reqArray(root, "domFindings", "result.json").map((entry, i) => {
    const d = asRecord(entry, `domFindings[${i}]`);
    const kind = d["kind"];
    const known: readonly string[] = [
      "console_error",
      "unhandled_rejection",
      "same_origin_request_failed",
      "sealed_network_request_blocked",
      "image_natural_width_zero",
      "horizontal_overflow",
      "default_serif_font",
      "placeholder_text",
    ];
    if (typeof kind !== "string" || !known.includes(kind)) {
      fail(`domFindings[${i}].kind is ${JSON.stringify(kind)}`, "Fix the container result writer.");
    }
    return {
      kind: kind as DomFindingKind,
      flowId: reqString(d, "flowId", `domFindings[${i}]`),
      breakpoint: reqString(d, "breakpoint", `domFindings[${i}]`),
      detail: typeof d["detail"] === "string" ? (d["detail"] as string) : "",
    } satisfies DomFinding;
  });

  // `ticketId` and `acceptanceSuiteSha256` are read TOLERANTLY, unlike every
  // other field.
  //
  // The container writes an emergency result when it aborts before it has read
  // the plan — which is exactly when it has nothing to put in these two fields.
  // Requiring them would make that emergency document unparseable, and the host
  // would then throw an opaque "must be a non-empty string" instead of surfacing
  // the container's actual error message. A diagnostic that cannot be read is
  // not a diagnostic. The host already knows both values from the suite it
  // passed in, so nothing is lost by accepting empty ones here. The check that
  // the suite and the plan describe the same ticket happens IN THE CONTAINER,
  // against the mounted manifest (`manifest.ticketId !== plan.ticketId` →
  // `notImplemented`), which is the only place that comparison is meaningful:
  // it is the mount that could be wrong.
  const tolerantString = (key: string): string => {
    const value = root[key];
    return typeof value === "string" ? value : "";
  };

  return {
    protocolVersion: SCORER_PROTOCOL_VERSION,
    ticketId: tolerantString("ticketId"),
    acceptanceSuiteSha256: tolerantString("acceptanceSuiteSha256"),
    startedAt: reqString(root, "startedAt", "result.json"),
    endedAt: reqString(root, "endedAt", "result.json"),
    nodeVersion: reqString(root, "nodeVersion", "result.json"),
    playwrightVersion: reqString(root, "playwrightVersion", "result.json"),
    tier0,
    exploitFindings,
    suiteExecution,
    criterionCoverage,
    screenshots,
    domFindings,
    infrastructureErrors: stringArray(root, "infrastructureErrors", "result.json"),
  };
}
