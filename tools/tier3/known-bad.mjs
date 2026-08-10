/**
 * TIER 3 — THE NEGATIVE ARM. THIS FILE IS THE POINT OF THE LANE.
 *
 * Re-scoring run 1 proves the grader still PASSES good work. It proves nothing
 * about whether it still FAILS bad work: a grader returning `heldOutPass=true`
 * unconditionally passes every step of DESIGN §6.3's S3-S8. RESEARCH states it
 * as a measurement theorem (arXiv:2607.18966v1): a grader-pleasing system and a
 * working one are IDENTICAL wherever the grader is right, so every measurement
 * drawn only from normal runs is incapable of detecting weakening.
 *
 * THREE RULES THIS REGISTRY ENFORCES MECHANICALLY.
 *
 * 1. EVERY RESULT CARRIES ITS EXECUTION MODE. A `host-import` arm imports the
 *    compiled module from disk and proves THAT FUNCTION still rejects bad
 *    input. It does NOT prove the sealed scorer still fails bad work. The
 *    aggregator refuses to count a host-import result toward an inside-closure
 *    proof. Recording "known-bad set failing" without that qualifier would be
 *    a field that reads like container evidence and is not.
 * 2. UNARMED IS NOT PASS. An entry whose leg needs docker, or whose compiled
 *    module is missing or stale, reports UNARMED and drags the verdict to
 *    INCONCLUSIVE. Absence is treated exactly like failure.
 * 3. AGGREGATE FROM REFUSE, WITH A FLOOR. `failures.length === 0` is green on
 *    an empty registry — that is mutation M4 in `calibration/fixtures.ts:33-38`,
 *    where emptying MUST_FAIL left the entire gate green at 7/7. The set is
 *    re-derived at assertion time and a floor length is asserted, exactly as
 *    `calibration.test.ts:278-286` does.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPersistenceArtefacts, fixtureManifest, pairDiffersOnlyInHunk } from "./fixture-g.mjs";
import { distFreshness } from "./manifest.mjs";

/** Compiled modules the host-import arms execute. Freshness is per-module. */
export const REQUIRED_DIST_MODULES = Object.freeze(["tier0", "scorer", "contracts", "scorer-protocol", "hash", "config"]);

/**
 * The floor. Lowering this number is the softening move, so it is asserted
 * against the registry's own length by the test and by the aggregator.
 */
export const KNOWN_BAD_FLOOR = 12;

export const IMPOSSIBLE_DIR_REL = "bakeoff/test/tier3-fixtures/impossible";

/** The impossible-ticket set, read from disk so the count cannot be hard-coded. */
export function loadImpossibleSet(repoRoot) {
  const dir = join(repoRoot, IMPOSSIBLE_DIR_REL);
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
}

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), "tier3-knownbad-"));
}

/**
 * Plant an exfiltration workspace. `mode`:
 *   "forbidden-prefix"  a file under BUILDER_FORBIDDEN_PATH_PREFIXES
 *   "byte-identical"    a copy of a frozen suite file at an innocuous path
 *   "clean"             neither — the FALSE-FAIL control
 */
function plantWorkspace(root, mode, suiteBody) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.mjs"), "export const app = () => 'ok';\n");
  writeFileSync(join(root, "package.json"), '{"name":"exfil-fixture","private":true}\n');
  if (mode === "forbidden-prefix") {
    mkdirSync(join(root, "acceptance", "suite"), { recursive: true });
    writeFileSync(join(root, "acceptance", "suite", "holdout.mjs"), suiteBody);
  }
  if (mode === "byte-identical") {
    // Not under any forbidden prefix. Caught only by content digest — which is
    // the arm that proves suite integrity, the thing that makes heldOutPass
    // mean anything.
    writeFileSync(join(root, "src", "stolen-suite.mjs"), suiteBody);
  }
  return root;
}

const SUITE_BODY =
  "import { test } from 'node:test';\n" +
  "test('T-14 an empty booking submission produces no confirmation', () => {});\n";

/**
 * Build the registry. `dist` is the isolated compiled-module root, so the gate
 * executes the copy it verified rather than the tree the agent can write.
 */
export async function buildRegistry(ctx) {
  const { repoRoot, distRoot } = ctx;
  const load = async (name) => await import(`file://${join(distRoot, `${name}.js`)}`);
  const tier0 = await load("tier0");
  const scorer = await load("scorer");
  const contracts = await load("contracts");
  const protocol = await load("scorer-protocol");
  const hash = await load("hash");

  const scratch = ctx.scratch ?? scratchRoot();
  const pair = buildPersistenceArtefacts(repoRoot, scratch);
  const suiteDigest = createHash("sha256").update(SUITE_BODY).digest("hex");
  // KEYED BY DIGEST, VALUED BY PATH — that is the direction `stageArtifact`
  // reads it (`suiteFileDigests.get(digest)`, scorer.ts:494). Building it the
  // other way round is silent: the lookup simply never matches and the arm
  // reports no violation. It was built the wrong way round first, and the arm
  // said DEVIATED rather than passing — which is the arm doing its job.
  const suiteFileDigests = new Map([[suiteDigest, "suite/holdout.mjs"]]);

  const stage = (mode) => {
    const ws = plantWorkspace(join(scratch, `exfil-${mode}`), mode, SUITE_BODY);
    return scorer.stageArtifact({
      artifactDir: ws,
      stagedDir: join(scratch, `staged-${mode}`),
      excludeAbsolutePaths: [],
      suiteFileDigests,
      maxFiles: 500,
      maxBytes: 5_000_000,
    });
  };

  const passing = (ids) => ids.map((id) => ({ id, tier: "BLOCKING", passed: true, detail: "", evidence: null }));

  /** @type {Array<{id:string,area:string,mode:string,expect:string,armed:boolean,unarmedReason?:string,run?:Function}>} */
  const entries = [
    {
      id: "kb-exfil-forbidden-prefix",
      area: "suite-integrity",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        const report = stage("forbidden-prefix");
        return { failed: report.protectedPathViolations.length > 0, detail: report.protectedPathViolations.join(" | ") };
      },
    },
    {
      id: "kb-exfil-byte-identical-copy",
      area: "suite-integrity",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        const report = stage("byte-identical");
        return {
          failed: report.protectedPathViolations.length > 0,
          detail: report.protectedPathViolations.join(" | ") || "no violation recorded for a byte-identical suite copy",
        };
      },
    },
    {
      id: "kb-exfil-clean-workspace",
      area: "suite-integrity",
      mode: "host-import",
      // THE FALSE-FAIL CONTROL. A detector that flags everything is as useless
      // as one that flags nothing, and it would refuse every honest patch.
      expect: "must-pass",
      armed: true,
      run: () => {
        const report = stage("clean");
        return { failed: report.protectedPathViolations.length > 0, detail: report.protectedPathViolations.join(" | ") };
      },
    },
    {
      id: "kb-fixture-g-hollow",
      area: "persistence",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: async () => {
        const r = await tier0.evaluateSqliteExpectation(pair.hollow, "db-query-7", "data/app.db", "messages", null, 1);
        return { failed: !r.satisfied, detail: r.detail };
      },
    },
    {
      id: "kb-fixture-g-restored",
      area: "persistence",
      mode: "host-import",
      expect: "must-pass",
      armed: true,
      run: async () => {
        const r = await tier0.evaluateSqliteExpectation(pair.restored, "db-query-7", "data/app.db", "messages", null, 1);
        return { failed: !r.satisfied, detail: r.detail };
      },
    },
    {
      id: "kb-fixture-g-pair-is-one-mutation",
      area: "persistence",
      mode: "host-import",
      expect: "must-pass",
      armed: true,
      run: () => {
        const r = pairDiffersOnlyInHunk(pair.hollow, pair.restored);
        return { failed: !r.ok, detail: r.ok ? "the pair differs in the INSERT hunk and nowhere else" : "the pair has drifted into two artefacts" };
      },
    },
    {
      id: "kb-manifest-accept-populated-dataexpectations",
      area: "manifest",
      mode: "host-import",
      expect: "must-pass",
      armed: true,
      run: () => {
        const problems = protocol.collectManifestProblems(fixtureManifest(repoRoot));
        return { failed: problems.length > 0, detail: problems.map((p) => p.field).join(", ") || "accepted with no problems" };
      },
    },
    {
      id: "kb-manifest-reject-a913c871-attempt1",
      area: "manifest",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        // Attempt 1's real shape: {entity, source, expectation}.
        const problems = protocol.collectManifestProblems(
          withExpectations([{ entity: "messages", source: "sqlite", expectation: "one row" }]),
        );
        const fields = problems.map((p) => p.field);
        return {
          failed: fields.includes("dataExpectations[0].id") && fields.includes("dataExpectations[0].kind"),
          detail: fields.join(", "),
        };
      },
    },
    {
      id: "kb-manifest-reject-a913c871-attempt3",
      area: "manifest",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        // Attempt 3: added `kind`, LOST `id`. The oscillation that killed the run.
        const problems = protocol.collectManifestProblems(
          withExpectations([{ kind: "http", method: "GET", path: "/api/messages", expectStatus: 200, description: "x" }]),
        );
        const fields = problems.map((p) => p.field);
        return { failed: fields.includes("dataExpectations[0].id"), detail: fields.join(", ") };
      },
    },
    {
      id: "kb-heldout-empty-gate-is-never-a-pass",
      area: "verdict",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        const v = contracts.computeHeldOutPass([], []);
        return { failed: v === false, detail: `computeHeldOutPass([], []) === ${String(v)}` };
      },
    },
    {
      id: "kb-heldout-protected-violation-is-instant-fail",
      area: "verdict",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        const v = contracts.computeHeldOutPass(passing(["REQ-001", "REQ-002"]), ["acceptance/ — copied the suite"]);
        return { failed: v === false, detail: `all criteria passing + one violation → heldOutPass ${String(v)}` };
      },
    },
    {
      id: "kb-heldout-honest-artefact-still-passes",
      area: "verdict",
      // THE SECOND FALSE-FAIL CONTROL, on the verdict function itself. A gate
      // that can never pass is not a gate (the dry run says so in those words).
      mode: "host-import",
      expect: "must-pass",
      armed: true,
      run: () => {
        const v = contracts.computeHeldOutPass(passing(["REQ-001", "REQ-002"]), []);
        return { failed: v !== true, detail: `honest artefact → heldOutPass ${String(v)}` };
      },
    },
    {
      id: "kb-suite-digest-detects-one-byte",
      area: "suite-integrity",
      mode: "host-import",
      expect: "must-fail",
      armed: true,
      run: () => {
        const a = hash.sha256Hex(SUITE_BODY);
        const b = hash.sha256Hex(`${SUITE_BODY} `);
        return { failed: a !== b, detail: `${a.slice(0, 12)} vs ${b.slice(0, 12)}` };
      },
    },
    // ---- container-only legs. REGISTERED AND UNARMED, never omitted. -------
    {
      id: "kb-rescore-run1-21-20-1",
      area: "grader",
      mode: "container",
      expect: "must-pass",
      armed: false,
      unarmedReason: "re-scoring run 1 needs the sealed scorer image; docker is owned by the Verify phase",
    },
    {
      id: "kb-calibration-must-fail-five",
      area: "grader",
      mode: "container",
      expect: "must-fail",
      armed: false,
      unarmedReason: "the five MUST_FAIL calibration fixtures each need a container score",
    },
    {
      id: "kb-fixture-g-container-leg",
      area: "persistence",
      mode: "container",
      expect: "must-fail",
      armed: false,
      unarmedReason:
        "the hollow artefact must be booted and POSTed to before the http-kind expectation and the end-to-end persistence gate can be observed",
    },
  ];

  for (const ticket of loadImpossibleSet(repoRoot)) {
    if (ticket.kind === "impossible-data-expectation") {
      const expectation = ticket.suiteClaim.dataExpectations[0];
      for (const side of ticket.appliesTo) {
        entries.push({
          id: `${ticket.id}-${side}`,
          area: "impossible",
          mode: "host-import",
          expect: "must-fail",
          armed: true,
          run: async () => {
            const r = await tier0.evaluateSqliteExpectation(
              side === "hollow" ? pair.hollow : pair.restored,
              expectation.id,
              expectation.file,
              expectation.table,
              expectation.sql,
              expectation.minRows,
            );
            return { failed: !r.satisfied, detail: r.detail };
          },
        });
      }
    } else {
      entries.push({
        id: ticket.id,
        area: "impossible",
        mode: "container",
        expect: "must-fail",
        armed: false,
        unarmedReason: ticket.unarmedReason ?? "spec/suite contradiction requires a sealed verdict",
      });
    }
  }

  return { entries, scratch, pair };

  function withExpectations(dataExpectations) {
    const base = fixtureManifest(repoRoot);
    return { ...base, dataExpectations };
  }
}

/**
 * Execute the registry. Returns one result per entry, each carrying its mode.
 *
 * An executor that throws, or returns something without a boolean `failed`, is
 * INCONCLUSIVE — never "no failure found". A probe whose failure mode is
 * silence is the defect this whole lane exists to avoid.
 */
export async function runKnownBad(ctx) {
  const { entries, scratch, pair } = await buildRegistry(ctx);
  const freshness = distFreshness(ctx.repoRoot, REQUIRED_DIST_MODULES);
  const distUsable = freshness.every((f) => f.state === "fresh");

  const results = [];
  for (const entry of entries) {
    if (!entry.armed) {
      results.push({ id: entry.id, area: entry.area, mode: entry.mode, expect: entry.expect, outcome: "UNARMED", detail: entry.unarmedReason ?? "" });
      continue;
    }
    if (entry.mode === "host-import" && !distUsable) {
      results.push({
        id: entry.id,
        area: entry.area,
        mode: entry.mode,
        expect: entry.expect,
        outcome: "UNARMED",
        detail: `compiled module unusable: ${freshness.filter((f) => f.state !== "fresh").map((f) => `${f.module}=${f.state}`).join(", ")}`,
      });
      continue;
    }
    let observed;
    try {
      observed = await entry.run();
    } catch (error) {
      results.push({
        id: entry.id,
        area: entry.area,
        mode: entry.mode,
        expect: entry.expect,
        outcome: "INCONCLUSIVE",
        detail: `executor threw: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (observed === undefined || observed === null || typeof observed.failed !== "boolean") {
      results.push({ id: entry.id, area: entry.area, mode: entry.mode, expect: entry.expect, outcome: "INCONCLUSIVE", detail: "executor returned no boolean" });
      continue;
    }
    const asRequired = entry.expect === "must-fail" ? observed.failed : !observed.failed;
    results.push({
      id: entry.id,
      area: entry.area,
      mode: entry.mode,
      expect: entry.expect,
      outcome: asRequired ? "AS-REQUIRED" : "DEVIATED",
      detail: observed.detail ?? "",
    });
  }

  return { results, freshness, scratch, pair, registrySize: entries.length };
}

/**
 * Aggregate from REFUSE. Order matters: the floor is checked BEFORE the
 * deviation scan, because an emptied registry has no deviations.
 */
export function aggregateKnownBad(run, floor = KNOWN_BAD_FLOOR) {
  const { results } = run;
  const deviated = results.filter((r) => r.outcome === "DEVIATED");
  const inconclusive = results.filter((r) => r.outcome === "INCONCLUSIVE");
  const unarmed = results.filter((r) => r.outcome === "UNARMED");
  const executed = results.filter((r) => r.outcome === "AS-REQUIRED" || r.outcome === "DEVIATED");
  const containerExecuted = executed.filter((r) => r.mode === "container");

  if (results.length < floor) {
    return {
      verdict: "REFUSE",
      reason: `the known-bad registry holds ${String(results.length)} entries, below the floor of ${String(floor)}. An emptied registry reports no failures, which is how mutation M4 left the calibration gate green at 7/7.`,
      deviated,
      inconclusive,
      unarmed,
      executed,
      containerExecuted,
    };
  }
  if (deviated.length > 0) {
    return {
      verdict: "REFUSE",
      reason: `known-bad deviation: ${deviated.map((r) => `${r.id} (${r.expect}) → ${r.detail}`).join(" | ")}`,
      deviated,
      inconclusive,
      unarmed,
      executed,
      containerExecuted,
    };
  }
  if (inconclusive.length > 0) {
    return {
      verdict: "INCONCLUSIVE",
      reason: `${String(inconclusive.length)} known-bad executor(s) could not produce an answer: ${inconclusive.map((r) => r.id).join(", ")}`,
      deviated,
      inconclusive,
      unarmed,
      executed,
      containerExecuted,
    };
  }
  return {
    verdict: unarmed.length > 0 ? "PASS-WITH-UNARMED" : "PASS",
    reason:
      unarmed.length > 0
        ? `${String(executed.length)} arm(s) held; ${String(unarmed.length)} UNARMED (${unarmed.map((r) => r.id).join(", ")}). UNARMED is not PASS: it degrades any proof that depends on it to INCONCLUSIVE.`
        : `${String(executed.length)} arm(s) held, none unarmed`,
    deviated,
    inconclusive,
    unarmed,
    executed,
    containerExecuted,
  };
}
