/**
 * machine-checks.test.ts — the twelve gates on their way to the owner's screen.
 *
 * WHAT THIS FILE IS THE ONLY WATCHER OF, AND WHY THAT IS NOT AN OPINION.
 * `tests/prose-guard.browser.spec.ts` bans a vocabulary on screen — `suite`,
 * `frozen`, `sealed`, `verdict`, `env` and the rest — and it CANNOT see a
 * machine-check label. Its separation of chrome from data is mechanical: every
 * string the API served for the run is subtracted from the rendered text before
 * the vocabulary rule runs, and any served string of twelve characters or more
 * is cut wholesale. A label is served. So `label: "The full suite came back
 * green"` would render on the owner's screen and that guard would stay GREEN,
 * because it would have subtracted the sentence as data seconds earlier.
 *
 * The vocabulary check below is therefore not a duplicate of the browser guard.
 * It is the only check of any kind on these twelve strings, and it carries its
 * own copy of the banned pattern — written out rather than imported, because the
 * client and the server are separate TypeScript programs with no path between
 * them (`contract-parity.test.ts`'s header records the same constraint).
 *
 * THE NEGATIVE CONTROLS, applied to production code, watched, and reverted:
 *
 *   M1  `MACHINE_CHECK_LABELS[GATE_IDS.suiteGreen]` -> "The full suite came back
 *       green". The vocabulary test went RED naming the gate and the word.
 *
 *       AND THE OTHER HALF OF M1, RUN SEPARATELY BECAUSE IT IS THE CLAIM ABOVE:
 *       the same banned label was put on the browser fixture that FEEDS the
 *       Result panel (`tests/fixtures/build-run-fixture.ts`), so the words "The
 *       full suite came back green" were genuinely rendered on screen in the
 *       harness. `npx playwright test tests/prose-guard.browser.spec.ts` then
 *       reported 28 passed — GREEN, including the state that opens that very
 *       panel. Both mutations reverted; both files diffed byte-identical after.
 *   M2  `readMachineChecks` returning `[]` instead of `null` for a run with no
 *       score record. The null-vs-empty test went RED.
 *   M3  `machineChecksFrom`'s allowlist check neutralised
 *       (`DETAIL_ALLOWLIST.has(id) || true`), so every failed gate served its
 *       detail. The leak test went RED on `GATE:suite-green`'s held-out output
 *       tail. Recorded as neutralised rather than deleted because DELETING it
 *       does not compile — the import goes unused and `tsc` catches it first,
 *       which is a real layer and a weak one: it stops that spelling of the
 *       mistake and no other.
 *   M4  the `!passed` condition dropped from `mayShowDetail`, so passing gates
 *       served theirs. The passing-detail test went RED — and that is the
 *       mutation that would have put "NOT APPLICABLE: the frozen manifest
 *       declares no build step" on the owner's screen, through the channel the
 *       browser guard cannot see.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ALL_GATE_IDS, GATE_IDS } from "bakeoff/dist/scorer-protocol.js";

import { scoresRoot } from "./gate-attempts.js";
import { DETAIL_ALLOWLIST } from "./gate-report.js";
import {
  MACHINE_CHECK_LABELS,
  MAX_MACHINE_CHECK_DETAIL,
  readMachineChecks,
} from "./machine-checks.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";

/**
 * The owner's banned vocabulary, COPIED from `tests/prose-guard.browser.spec.ts`
 * rather than imported.
 *
 * The two packages do not share a program, and a check that reads the other
 * file's source as text to extract a regex would be a parser watching a parser.
 * A copy drifts only in the safe direction: this list going stale means the
 * browser guard bans a word this one permits, and that word is then caught the
 * moment it reaches any string the guard CAN see.
 */
const BANNED =
  /\b(seats?|suites?|digests?|freezes?|freeze|frozen|verdicts?|traces?|env|held-?outs?|sealed|false finish(es)?)\b/i;

/** A `ScoreRecord`-shaped body: only the fields this reader looks at. */
function scoreRecord(
  gates: readonly { readonly id: string; readonly passed: boolean; readonly detail?: string }[],
  extra: readonly Record<string, unknown>[] = [],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: "run-under-test",
    heldOutPass: gates.every((gate) => gate.passed),
    criteriaResults: [
      ...gates.map((gate) => ({
        criterionId: gate.id,
        tier: "BLOCKING",
        passed: gate.passed,
        evidenceRef: null,
        detail: gate.detail ?? null,
      })),
      ...extra,
    ],
  });
}

/** Every gate passing, so a test can flip exactly the one it is about. */
function allPassing(): { readonly id: string; readonly passed: boolean }[] {
  return ALL_GATE_IDS.map((id) => ({ id, passed: true }));
}

interface Bed {
  readonly paths: DashboardPaths;
  /** Write this run's score record. Omit to leave the run unscored. */
  write(runId: string, body: string): void;
  close(): void;
}

function bed(): Bed {
  const home = mkdtempSync(join(tmpdir(), "machine-checks-"));
  const paths = resolvePaths({ DASHBOARD_HOME: home });
  ensureDirs(paths);
  return {
    paths,
    write(runId, body) {
      mkdirSync(scoresRoot(paths), { recursive: true });
      writeFileSync(join(scoresRoot(paths), `${runId}.json`), body, "utf8");
    },
    close() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("MACHINE CHECKS: all twelve gates arrive, in one fixed order, each with plain words", () => {
  const it = bed();
  try {
    it.write("run-1", scoreRecord(allPassing()));
    const checks = readMachineChecks(it.paths, "run-1");

    assert.notEqual(checks, null, "a scored run must report its machine checks");
    assert.deepEqual(
      checks?.map((check) => check.id),
      [...ALL_GATE_IDS],
      "the rows must be every gate id, in ALL_GATE_IDS order — a panel whose rows " +
        "reorder between runs, or drops one, is a panel that cannot be read across runs",
    );
    assert.equal(checks?.every((check) => check.passed), true);
    // THE POSITIVE CONTROL FOR EVERY REDACTION BELOW: a composer that returned
    // ids as labels would satisfy the leak tests perfectly.
    for (const check of checks ?? []) {
      assert.notEqual(
        check.label,
        check.id,
        `${check.id} has no plain label and would render its own grader key on screen`,
      );
      assert.match(check.label, /[a-z]/, `${check.id}'s label is not a sentence`);
    }
  } finally {
    it.close();
  }
});

test("MACHINE CHECKS: no label uses a word the owner banned from the screen", () => {
  /*
   * THE ONLY CHECK ON THIS VOCABULARY ANYWHERE. See the file header: the browser
   * guard subtracts served strings as data before it applies this rule, and a
   * label is served, so a banned word here is invisible to it.
   *
   * IT READS THE EXPORTED TABLE, not a rendered page, so it also covers gates no
   * fixture happens to fail.
   */
  for (const id of ALL_GATE_IDS) {
    const label = MACHINE_CHECK_LABELS[id];
    assert.equal(
      typeof label,
      "string",
      `${id} has no label. A gate added upstream must be given owner-facing words here, ` +
        "or it renders as its own id.",
    );
    assert.doesNotMatch(
      label ?? "",
      BANNED,
      `${id}'s label uses a word the owner struck off the screen: "${String(label)}"`,
    );
  }
});

test("MACHINE CHECKS: a failed gate's detail crosses only from the allowlist", () => {
  /*
   * `GATE:suite-green`'s detail is assembled from the held-out runner's own
   * output tail — test titles, verbatim, up to 4,000 characters of them. It is
   * the reason `DETAIL_ALLOWLIST` exists, and the reason this panel serves an
   * outcome for it and nothing else.
   */
  const heldOutTail = "holdout/coglane.test.mjs › [REQ-001] the root document answers 200";
  const it = bed();
  try {
    it.write(
      "run-2",
      scoreRecord([
        ...allPassing().filter(
          (gate) => gate.id !== GATE_IDS.suiteGreen && gate.id !== GATE_IDS.typecheck,
        ),
        { id: GATE_IDS.suiteGreen, passed: false, detail: `node-test: exit 1 | ${heldOutTail}` },
        { id: GATE_IDS.typecheck, passed: false, detail: "src/app/page.tsx(11,3): error TS2322" },
      ]),
    );
    const checks = readMachineChecks(it.paths, "run-2") ?? [];
    const byId = new Map(checks.map((check) => [check.id, check]));

    const suiteGreen = byId.get(GATE_IDS.suiteGreen);
    assert.equal(suiteGreen?.passed, false, "the failure itself must reach the owner");
    assert.equal(
      suiteGreen?.detail,
      null,
      "this gate's detail quotes the held-out runner and may never reach a browser",
    );
    for (const check of checks) {
      assert.doesNotMatch(
        JSON.stringify(check),
        /holdout\//,
        `${check.id} carried a held-out test path onto the wire`,
      );
    }

    // POSITIVE CONTROL: an allowlisted failure DOES say what went wrong, or this
    // whole section is a list of twelve words nobody can act on.
    assert.equal(byId.get(GATE_IDS.typecheck)?.detail, "src/app/page.tsx(11,3): error TS2322");
    assert.equal(DETAIL_ALLOWLIST.has(GATE_IDS.typecheck), true);
    assert.equal(DETAIL_ALLOWLIST.has(GATE_IDS.suiteGreen), false);
  } finally {
    it.close();
  }
});

test("MACHINE CHECKS: a PASSING gate never carries a detail, allowlisted or not", () => {
  /*
   * `gateToCriterion` writes `NOT APPLICABLE: <the gate's own words>` for a gate
   * the frozen manifest declared no step for, and those words begin "the frozen
   * manifest declares no build step". Serving details for passing gates would
   * put that sentence on screen — a banned word, arriving through the one
   * channel the browser guard structurally cannot see.
   */
  const it = bed();
  try {
    it.write(
      "run-3",
      scoreRecord([
        ...allPassing().filter((gate) => gate.id !== GATE_IDS.build),
        {
          id: GATE_IDS.build,
          passed: true,
          detail: "NOT APPLICABLE: the frozen manifest declares no build step",
        },
      ]),
    );
    const checks = readMachineChecks(it.paths, "run-3") ?? [];
    assert.equal(
      checks.every((check) => check.detail === null),
      true,
      "a passing gate served a detail: " + JSON.stringify(checks.filter((c) => c.detail !== null)),
    );
    /*
     * OVER WHAT REACHES THE SCREEN — labels and details — AND NOT OVER THE IDS.
     * `GATE:suite-intact` contains a banned word by construction; it is the
     * grader's key, it stays on the wire for a bug report to quote, and
     * `criteria.tsx` deliberately keeps it out of the DOM (no `title`, no text).
     * Asserting over the ids too would make this test unpassable and would be
     * asserting the wrong thing.
     */
    assert.doesNotMatch(
      checks.map((check) => `${check.label} ${check.detail ?? ""}`).join(" "),
      BANNED,
      "the record's own words reached the wire",
    );
  } finally {
    it.close();
  }
});

test("MACHINE CHECKS: a long detail is bounded before it leaves the server", () => {
  const it = bed();
  try {
    it.write(
      "run-4",
      scoreRecord([
        ...allPassing().filter((gate) => gate.id !== GATE_IDS.lint),
        { id: GATE_IDS.lint, passed: false, detail: "x".repeat(4_000) },
      ]),
    );
    const detail = (readMachineChecks(it.paths, "run-4") ?? []).find(
      (check) => check.id === GATE_IDS.lint,
    )?.detail;
    assert.equal(typeof detail, "string");
    assert.ok(
      (detail ?? "").length <= MAX_MACHINE_CHECK_DETAIL + 1,
      `a ${String((detail ?? "").length)}-character detail reached a panel row`,
    );
  } finally {
    it.close();
  }
});

test("MACHINE CHECKS: a run that never reached the gate reports null, NEVER an empty list", () => {
  /*
   * THE DISTINCTION THE WHOLE FIELD EXISTS FOR. `[]` renders as "no checks" and
   * `null` renders as "these have not run"; a queued run drawn as twelve absent
   * checks is the same lie as `heldOutPass: false` for a gate that never ran.
   *
   * FOUR WAYS TO HAVE NO ANSWER, and all four are the same answer. The last one
   * is the subtle one: a record that PARSES and holds no gate entry is a file
   * this reader does not recognise, not twelve failures.
   */
  const it = bed();
  try {
    assert.equal(readMachineChecks(it.paths, "never-gated"), null, "no score record at all");

    it.write("garbage", "{ this is not json");
    assert.equal(readMachineChecks(it.paths, "garbage"), null, "an unparseable record");

    it.write("shapeless", JSON.stringify({ criteriaResults: "not an array" }));
    assert.equal(readMachineChecks(it.paths, "shapeless"), null, "a record of another shape");

    it.write(
      "criteria-only",
      scoreRecord([], [{ criterionId: "REQ-001", tier: "BLOCKING", passed: false, detail: null }]),
    );
    assert.equal(
      readMachineChecks(it.paths, "criteria-only"),
      null,
      "a record with no gate entries must not manufacture twelve failures",
    );
  } finally {
    it.close();
  }
});

test("MACHINE CHECKS: a gate missing from a real record fails closed", () => {
  /*
   * NOT A PASS, AND NOT A GAP IN THE LIST. `gate-report.ts`, `gateToCriterion`
   * and `heldOutPass: null` all take the same line: a gate that was never
   * evaluated is not a gate that passed. This only fires on a record that HAS
   * gates — the empty case above is `null`, so the fails-closed rule can never
   * turn "nothing was measured" into twelve red rows.
   */
  const it = bed();
  try {
    it.write("run-5", scoreRecord(allPassing().filter((gate) => gate.id !== GATE_IDS.boot)));
    const checks = readMachineChecks(it.paths, "run-5") ?? [];
    assert.equal(checks.length, ALL_GATE_IDS.length, "the missing gate still gets a row");
    const boot = checks.find((check) => check.id === GATE_IDS.boot);
    assert.equal(boot?.passed, false, "a gate the record never mentioned must not read as a pass");
    assert.equal(boot?.detail, null, "there is no detail to show for a gate that left no record");
  } finally {
    it.close();
  }
});

test("MACHINE CHECKS: an entry whose `passed` is not a boolean is not a pass", () => {
  /*
   * The reader drops what it cannot understand rather than coercing it —
   * `passed: "true"` is a record written by something that is not our scorer,
   * and truthiness is how a string like that becomes a green tick.
   */
  const it = bed();
  try {
    it.write(
      "run-6",
      scoreRecord(
        allPassing().filter((gate) => gate.id !== GATE_IDS.routes),
        [{ criterionId: GATE_IDS.routes, tier: "BLOCKING", passed: "true", detail: null }],
      ),
    );
    const routes = (readMachineChecks(it.paths, "run-6") ?? []).find(
      (check) => check.id === GATE_IDS.routes,
    );
    assert.equal(routes?.passed, false);
  } finally {
    it.close();
  }
});
