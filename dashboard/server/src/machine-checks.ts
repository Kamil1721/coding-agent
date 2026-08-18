/**
 * machine-checks.ts — the twelve gates, as the OWNER reads them.
 *
 * THE DEFECT THIS CLOSES, MEASURED RATHER THAN SUSPECTED. `Orchestrator
 * #gatePhase` walks `record.criteriaResults` and calls
 * `store.setCriterionResult(runId, criterionId, …)` for every entry it finds.
 * That statement is an `UPDATE … WHERE criterion_id = ?` against the `criteria`
 * table, and `#recordCriteria` only ever inserted the frozen suite's own `REQ-*`
 * rows — so all twelve `GATE:*` results matched no row, updated nothing, and
 * were dropped without an error. Read off this machine's own database on
 * 2026-08-18: every `criterion_id` in `criteria` is a `REQ-*`, on every run.
 *
 * WHAT THE OWNER SAW BECAUSE OF IT. The Result panel counts the criteria it can
 * see, so a run whose held-out suite did not go green — or whose build never
 * compiled — could print "8 of 8 must-pass checks green" while the thing that
 * actually failed it had no row anywhere on the screen. The verdict said failed,
 * the panel said green, and nothing named the check.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE ANSWER COMES FROM, AND WHY IT IS NOT THE CONTAINER RESULT
 *
 * `results/scores/<runId>.json` — the run's own `ScoreRecord`. It is read here
 * rather than `results/scorer-out/<runId>/result.json` for a reason that is not
 * convenience:
 *
 *   · THE CONTAINER CANNOT ANSWER FOR TWO OF THE TWELVE. `GATE:suite-intact` and
 *     `GATE:no-protected-path-writes` are HOST-side. `Scorer#buildScoreRecord`
 *     synthesises them from the freeze check and from `staging
 *     .protectedPathViolations`; they are not in `container.tier0` at all —
 *     verified against every archived `result.json` in this repo, each of which
 *     carries exactly ten gates. A panel built off the container would have to
 *     re-derive those two, which is a second scoring path for the two gates that
 *     answer "was the grader itself tampered with".
 *   · THE SCORE RECORD IS WHAT THE VERDICT WAS COMPUTED FROM.
 *     `computeHeldOutPass` reads `criteriaResults`, which is precisely the array
 *     read here, so this panel cannot disagree with the `heldOutPass` printed
 *     above it. Any other source could.
 *   · IT IS ALREADY REDACTED. The scorer writes it through
 *     `redactForPersistence`, so nothing served below can carry a credential the
 *     record itself does not.
 *
 * THE PATH IS `scoresRoot()` FROM `gate-attempts.ts`, not a second `join`. That
 * module owns the sealed roots and records what happened the two times a results
 * directory was spelled out at a second call site.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CROSSES, AND WHAT DOES NOT
 *
 * `DETAIL_ALLOWLIST` in `gate-report.ts` is the same list, imported rather than
 * copied. Its three exclusions hold for the owner exactly as they hold for a
 * fixing agent: `GATE:suite-green`'s detail is up to 4,000 characters of the
 * held-out runner's output — test titles verbatim — and `GATE:suite-intact` /
 * `GATE:no-protected-path-writes` name frozen files. Those three report their
 * outcome and `null`.
 *
 * A FAILED GATE'S DETAIL IS THE MACHINE'S OWN WORDS AND IS NOT REWRITTEN, which
 * includes the owner's banned vocabulary when the machine used it. Measured on
 * this machine's own records: `GATE:boot`'s failure on the 2026-07-30 run reads
 * "the frozen manifest declares no start command…". That word stays. The line
 * this repo draws is stated in `tests/prose-guard.browser.spec.ts`'s own header
 * — everything the API SERVED for a run is DATA and everything else on screen is
 * the product's voice — and it names the precedent exactly: `failureReason`
 * carries the server's "the spec SEAT (default) call … failed" and the Result
 * panel prints it verbatim as evidence. Editing a gate's account of what it
 * observed to suit a word list would be the dashboard rewriting the evidence.
 * The LABELS are ours and are plain; the DETAILS are the gate's and are quoted.
 *
 * A PASSING GATE ALSO REPORTS `null`, allowlisted or not, and that is a decision
 * with a measured reason. `gateToCriterion` writes `NOT APPLICABLE: <the gate's
 * own words>` as the detail of a `not_applicable` gate, and those words begin
 * "the frozen manifest declares no build step" — so serving details for passing
 * gates would put the banned word "frozen" on the owner's screen through a
 * channel the browser prose guard structurally cannot see (a served string is
 * DATA there, and is subtracted before the vocabulary rule runs). There is also
 * nothing to do with it: a passing gate's detail restates its own configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_GATE_IDS, GATE_IDS, GATE_ID_PREFIX } from "bakeoff/dist/scorer-protocol.js";

import type { ApiMachineCheck } from "./api-types.js";
import { truncate } from "./claude-common.js";
import { DETAIL_ALLOWLIST } from "./gate-report.js";
import { scoresRoot } from "./gate-attempts.js";
import { safeSegment } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

/**
 * The plain sentence each gate gets on screen. THE ONE SPELLING, server-side.
 *
 * COMPOSED HERE RATHER THAN IN THE COMPONENT so that the run report, a future
 * mail, and the panel cannot drift into three vocabularies for one gate — and so
 * that the vocabulary is testable at all. `Tier0GateResult.name` was the
 * alternative and it is the grader's voice, not the owner's: "the frozen
 * held-out suite goes green", "no stub markers in declared source".
 *
 * EVERY LABEL AVOIDS THE OWNER'S BANNED VOCABULARY, and that is enforced by
 * `machine-checks.test.ts` rather than by care: `tests/prose-guard.browser.spec
 * .ts` CANNOT catch a banned word here, because it subtracts every string the
 * API served before it applies the rule. A label is served, so to that guard it
 * is data. The server-side test is the only thing watching this list.
 *
 * NOT PARTIAL. A gate id with no entry here would otherwise render as its own
 * id, which is the grader's join key with a colon in it. `everyGateHasALabel`
 * in the test file fails on a gate added upstream instead.
 */
export const MACHINE_CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [GATE_IDS.build]: "It builds",
  [GATE_IDS.typecheck]: "Types check",
  [GATE_IDS.lint]: "Lint is clean",
  [GATE_IDS.boot]: "It starts",
  [GATE_IDS.routes]: "Every page answers",
  [GATE_IDS.noStubMarkers]: "No placeholder stubs",
  [GATE_IDS.noRewardHackExploits]: "No faked passes",
  [GATE_IDS.suiteIntact]: "The checks were not tampered with",
  [GATE_IDS.noProtectedPathWrites]: "Nothing protected was touched",
  [GATE_IDS.dataPresent]: "The real content is on the page",
  [GATE_IDS.screenshotsPresent]: "Screenshots captured",
  [GATE_IDS.suiteGreen]: "The full check run came back green",
});

/**
 * Longest detail that reaches the browser.
 *
 * SHORTER THAN `gate-report.ts`'s 1,200, deliberately. That budget feeds a
 * PROMPT, where a fixing agent needs the whole compiler error; this one feeds a
 * line under a row on a panel, where the reader needs the first sentence and
 * nothing else. A wall of build output in a run panel is the thing this app's
 * prose rules exist to prevent.
 *
 * 201 CHARACTERS ON THE WIRE, NOT 200: `truncate` appends an ellipsis to
 * anything it cuts, so this is the budget for the machine's own words and the
 * marker saying they were cut is one character on top. Written down because a
 * later reader measuring `detail.length` against this constant would otherwise
 * find it off by one and "fix" the wrong end of it.
 */
export const MAX_MACHINE_CHECK_DETAIL = 200;

/** One gate as the score record recorded it. Nothing else from that file. */
interface RecordedGate {
  readonly passed: boolean;
  readonly detail: string | null;
}

/**
 * The `GATE:*` entries of a score record, or `null` when there is no usable one.
 *
 * IT PARSES ONLY WHAT IT SERVES. This is not a `ScoreRecord` parser — bakeoff
 * exports none for a single record file, and writing one here would be a second
 * declaration of a shape this module reads four fields of. Everything it cannot
 * understand is dropped rather than defaulted: an entry with no boolean `passed`
 * is not a pass, it is an entry this function never saw, and it comes back out
 * of {@link machineChecksFrom} as `passed: false` with the rest of the missing.
 *
 * `null` FOR AN EMPTY HARVEST, NOT AN EMPTY MAP. A record that parses and holds
 * no `GATE:` entry at all is not evidence that twelve gates failed — it is a
 * file this reader does not recognise, and twelve manufactured "did not pass"
 * rows would be a claim about a run nothing measured.
 */
function recordedGates(text: string): ReadonlyMap<string, RecordedGate> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const results = (parsed as { criteriaResults?: unknown }).criteriaResults;
  if (!Array.isArray(results)) return null;

  const gates = new Map<string, RecordedGate>();
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as { criterionId?: unknown; passed?: unknown; detail?: unknown };
    if (typeof row.criterionId !== "string" || !row.criterionId.startsWith(GATE_ID_PREFIX)) continue;
    if (typeof row.passed !== "boolean") continue;
    gates.set(row.criterionId, {
      passed: row.passed,
      detail: typeof row.detail === "string" ? row.detail : null,
    });
  }
  return gates.size === 0 ? null : gates;
}

/**
 * The twelve rows, in `ALL_GATE_IDS` order, from whatever the record held.
 *
 * FIXED LENGTH AND FIXED ORDER. The panel's rows must not reorder between two
 * runs of the same ticket, and a gate the record never mentioned must still have
 * a row: `passed: false`, which is what "never evaluated is not a pass" means in
 * `gate-report.ts`, in `gateToCriterion`, and in `heldOutPass: null`. The
 * fails-closed direction is only sound because the empty-record case is `null`
 * one level up — see {@link recordedGates}.
 */
export function machineChecksFrom(
  gates: ReadonlyMap<string, RecordedGate>,
): readonly ApiMachineCheck[] {
  return ALL_GATE_IDS.map((id) => {
    const recorded = gates.get(id) ?? null;
    const passed = recorded?.passed ?? false;
    const mayShowDetail = !passed && DETAIL_ALLOWLIST.has(id) && recorded !== null;
    const detail =
      mayShowDetail && recorded.detail !== null && recorded.detail.trim().length > 0
        ? truncate(recorded.detail, MAX_MACHINE_CHECK_DETAIL)
        : null;
    return {
      id,
      label: MACHINE_CHECK_LABELS[id] ?? id,
      passed,
      detail,
    };
  });
}

/**
 * This run's twelve machine checks, or `null` when it never reached the gate.
 *
 * EVERY ABSENCE IS `null` AND NONE OF THEM IS `[]`: no score record (queued,
 * building, parked, cancelled before the gate, or a gate that could not run), a
 * record that will not parse, a record with no gate entries. `api-types.ts`
 * carries the rule where the field is declared, and the panel renders `null` as
 * "not run yet" rather than as twelve of anything.
 *
 * THE RUN ID COMES FROM A PERSISTED ROW, never straight off a request —
 * `safeSegment` is belt-and-braces on top of that, the same pairing every other
 * per-run read in this server uses.
 */
export function readMachineChecks(
  paths: DashboardPaths,
  runId: string,
): readonly ApiMachineCheck[] | null {
  const path = join(scoresRoot(paths), `${safeSegment(runId)}.json`);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const gates = recordedGates(text);
  return gates === null ? null : machineChecksFrom(gates);
}
