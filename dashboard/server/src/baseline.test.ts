import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { wilsonInterval } from "bakeoff/dist/analyze.js";
import {
  createBaselineReport,
  renderBaselineJson,
  renderBaselineMarkdown,
  requiredRuns,
} from "./baseline.js";
import type { BaselineClusterInputs, BaselineReport } from "./baseline.js";
import {
  readBaselineSnapshot,
  readCriterionClusters,
  replacePreparedBaselineArtifacts,
  runBaselineCli,
} from "./baseline-cli.js";

const PINNED_GATING_COUNTS = [
  [9, 9], [13, 0], [23, 16], [23, 21], [23, 18], [22, 17], [22, 18], [7, 7],
  [6, 6], [8, 8], [19, 15], [12, 11], [16, 16], [16, 16], [16, 16], [13, 0],
] as const;

const PINNED_QUALITY_COUNTS = [
  [4, 3], [3, 0], [2, 2], [2, 2], [2, 2], [3, 3], [3, 3], [3, 3],
  [2, 2], [4, 4], [4, 4], [5, 5], [3, 3], [3, 3], [3, 3], [3, 0],
] as const;

function fixtureClusterInputs(clusterCount = 10): BaselineClusterInputs {
  const clusters = Array.from({ length: clusterCount }, (_, index) => ({
    id: `cluster-${String(index)}`,
    successes: 1,
    n: 2,
  }));
  return { gating: clusters, quality: clusters };
}

function scratch(parentDirectory = tmpdir()): { readonly directory: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(parentDirectory, "dashboard-baseline-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function fixtureDatabase(directory: string, rows: readonly (0 | 1 | null)[]): string {
  const path = join(directory, "runs.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, held_out_pass INTEGER);
      CREATE TABLE criteria (
        run_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (run_id, criterion_id)
      );
    `);
    const insertRun = db.prepare("INSERT INTO runs (run_id, status, held_out_pass) VALUES (?, ?, ?)");
    const insertCriterion = db.prepare(
      "INSERT INTO criteria (run_id, criterion_id, tier, result) VALUES (?, ?, ?, ?)",
    );
    for (const [index, heldOutPass] of rows.entries()) {
      const runId = `run-${String(index)}`;
      insertRun.run(runId, heldOutPass === null ? "passed" : "failed", heldOutPass);
      insertCriterion.run(runId, "gating-pass", "FUNCTIONAL", "pass");
      insertCriterion.run(runId, "gating-fail", "BLOCKING", "fail");
      insertCriterion.run(runId, "quality-pass", "QUALITY", "pass");
      insertCriterion.run(runId, "quality-fail", "QUALITY", "fail");
    }
  } finally {
    db.close();
  }
  return path;
}

function pinnedClusterDatabase(directory: string): string {
  const path = fixtureDatabase(
    directory,
    [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  );
  const db = new DatabaseSync(path);
  try {
    db.exec("DELETE FROM criteria");
    const insertCriterion = db.prepare(
      "INSERT INTO criteria (run_id, criterion_id, tier, result) VALUES (?, ?, ?, ?)",
    );
    for (const [clusterIndex, [n, successes]] of PINNED_GATING_COUNTS.entries()) {
      const runId = `run-${String(clusterIndex)}`;
      for (let observationIndex = 0; observationIndex < n; observationIndex += 1) {
        const passed = observationIndex < successes;
        insertCriterion.run(
          runId,
          `gating-${String(observationIndex)}`,
          passed ? "FUNCTIONAL" : "BLOCKING",
          passed ? "pass" : "fail",
        );
      }
    }
    for (const [clusterIndex, [n, successes]] of PINNED_QUALITY_COUNTS.entries()) {
      const runId = `run-${String(clusterIndex)}`;
      for (let observationIndex = 0; observationIndex < n; observationIndex += 1) {
        insertCriterion.run(
          runId,
          `quality-${String(observationIndex)}`,
          "QUALITY",
          observationIndex < successes ? "pass" : "fail",
        );
      }
    }
  } finally {
    db.close();
  }
  return path;
}

test("the shared Wilson implementation reproduces the pinned boundary values", () => {
  assert.deepEqual(wilsonInterval(5, 30), { low: 0.0733654237184855, high: 0.3356435050641603 });
  assert.deepEqual(wilsonInterval(7, 16), { low: 0.23098652405492354, high: 0.6682144360118811 });
  const none = wilsonInterval(0, 30);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0);
  assert.ok(Math.abs(none.high - 0.11351339317396876) < 1e-12);
  const all = wilsonInterval(30, 30);
  assert.ok(all.low < 1);
  assert.ok(Math.abs(all.low - 0.8864866068260312) < 1e-12);
  assert.ok(Math.abs(all.high - 1) < 1e-12);
});

test("a [0,1] Wilson stub makes report creation fail pinned validation for the intended mismatch", () => {
  assert.throws(
    () =>
      createBaselineReport(
        { totalRuns: 30, gatedDenominator: 16, successes: 7, failures: 9, noVerdict: 14 },
        "2026-09-04T08:00:00.000Z",
        "fixture.db",
        fixtureClusterInputs(),
        () => ({ low: 0, high: 1 }),
      ),
    /wilsonInterval pinned-value mismatch for 5\/30/,
  );
});

test("requiredRuns uses observed gated counts, ceiling, and the Wilson interior maximum", () => {
  const observed = { successes: 7, gatedDenominator: 16 };
  const expected = [
    { delta: 0.1, point: 389, low: 314, high: 389 },
    { delta: 0.15, point: 171, low: 130, high: 171 },
    { delta: 0.2, point: 94, low: 66, high: 95 },
    { delta: 0.3, point: 39, low: 23, high: 40 },
  ];
  for (const item of expected) {
    const actual = requiredRuns(observed, item.delta);
    assert.equal(actual.perArm, item.point);
    assert.deepEqual(actual.perArmRange, { low: item.low, high: item.high });
  }
});

test("requiredRuns refuses an observed gated denominator below ten", () => {
  assert.throws(
    () => requiredRuns({ successes: 4, gatedDenominator: 9 }, 0.1),
    /gated denominator must be at least 10.*got 9/,
  );
});

test("an all-null database refuses instead of reporting zero percent", () => {
  const temp = scratch();
  try {
    const databasePath = fixtureDatabase(temp.directory, [null, null]);
    assert.throws(
      () =>
        runBaselineCli({
          databasePath,
          outputDirectory: join(temp.directory, "output"),
          now: new Date("2026-09-04T08:00:00.000Z"),
          writeStdout: () => undefined,
        }),
      /gated denominator is zero/,
    );
  } finally {
    temp.cleanup();
  }
});

test("status passed with a null held_out_pass is no verdict, not a pass", () => {
  const temp = scratch();
  try {
    const databasePath = fixtureDatabase(temp.directory, [null, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    const result = runBaselineCli({
      databasePath,
      outputDirectory: join(temp.directory, "output"),
      now: new Date("2026-09-04T08:00:00.000Z"),
      writeStdout: () => undefined,
    });
    assert.deepEqual(result.report.counts, {
      totalRuns: 11,
      gatedDenominator: 10,
      successes: 5,
      failures: 5,
      noVerdict: 1,
    });
    assert.equal(result.report.rates.heldOutPass.n, 10);
    assert.equal(result.report.rates.heldOutPass.successes, 5);
  } finally {
    temp.cleanup();
  }
});

test("criterion cluster query joins to verdict runs, ignores status, filters results, and separates tiers", () => {
  const temp = scratch();
  try {
    const databasePath = fixtureDatabase(temp.directory, [1, 0, 1, 0, 1, 0, 1, 0, null]);
    const db = new DatabaseSync(databasePath);
    let gating: ReturnType<typeof readCriterionClusters>;
    let quality: ReturnType<typeof readCriterionClusters>;
    try {
      db.exec(`
        UPDATE runs SET status = 'cancelled' WHERE run_id = 'run-1';
        INSERT INTO criteria VALUES ('run-0', 'extra-gating-pass', 'BLOCKING', 'pass');
        INSERT INTO criteria VALUES ('run-0', 'pending-gating', 'FUNCTIONAL', 'pending');
        INSERT INTO criteria VALUES ('run-0', 'other-tier-pass', 'OWNER_PREF', 'pass');
        INSERT INTO criteria VALUES ('run-1', 'extra-quality-fail', 'QUALITY', 'fail');
        INSERT INTO criteria VALUES ('run-8', 'no-verdict-gating-pass', 'FUNCTIONAL', 'pass');
        INSERT INTO criteria VALUES ('run-8', 'no-verdict-quality-pass', 'QUALITY', 'pass');
        INSERT INTO criteria VALUES ('orphan-run', 'orphan-gating-pass', 'BLOCKING', 'pass');
        INSERT INTO criteria VALUES ('orphan-run', 'orphan-quality-pass', 'QUALITY', 'pass');
      `);
      gating = readCriterionClusters(db, "gating");
      quality = readCriterionClusters(db, "quality");
    } finally {
      db.close();
    }

    assert.equal(gating.length, 8);
    assert.equal(quality.length, 8);
    assert.deepEqual(gating[0], { id: "run-0", successes: 2, n: 3 });
    assert.deepEqual(quality[0], { id: "run-0", successes: 1, n: 2 });
    assert.deepEqual(gating[1], { id: "run-1", successes: 1, n: 2 });
    assert.deepEqual(quality[1], { id: "run-1", successes: 1, n: 3 });
    assert.equal(gating.some((cluster) => cluster.id === "run-8"), false);
    assert.equal(quality.some((cluster) => cluster.id === "run-8"), false);
    assert.equal(gating.some((cluster) => cluster.id === "orphan-run"), false);
    assert.equal(quality.some((cluster) => cluster.id === "orphan-run"), false);
  } finally {
    temp.cleanup();
  }
});

test("all baseline inputs come from one SQLite snapshot while WAL writes continue", () => {
  const temp = scratch();
  try {
    const databasePath = fixtureDatabase(temp.directory, [1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    const setup = new DatabaseSync(databasePath);
    try {
      setup.exec("PRAGMA journal_mode=WAL");
    } finally {
      setup.close();
    }

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    const writer = new DatabaseSync(databasePath);
    try {
      const snapshot = readBaselineSnapshot(reader, () => {
        writer.prepare("INSERT INTO runs (run_id, status, held_out_pass) VALUES (?, ?, ?)").run(
          "run-concurrent",
          "passed",
          1,
        );
        const insertCriterion = writer.prepare(
          "INSERT INTO criteria (run_id, criterion_id, tier, result) VALUES (?, ?, ?, ?)",
        );
        insertCriterion.run("run-concurrent", "gating-pass", "FUNCTIONAL", "pass");
        insertCriterion.run("run-concurrent", "gating-fail", "BLOCKING", "fail");
        insertCriterion.run("run-concurrent", "quality-pass", "QUALITY", "pass");
        insertCriterion.run("run-concurrent", "quality-fail", "QUALITY", "fail");
      });

      assert.equal(snapshot.counts.gatedDenominator, 10);
      assert.equal(snapshot.clusterInputs.gating.length, 10);
      assert.equal(snapshot.clusterInputs.quality.length, 10);
      assert.equal(writer.prepare("SELECT count(*) AS n FROM runs WHERE held_out_pass IS NOT NULL").get()?.["n"], 11);
    } finally {
      reader.close();
      writer.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("the CLI writes parseable full-precision JSON and a denominator-rich Markdown report", () => {
  const temp = scratch();
  try {
    const databasePath = pinnedClusterDatabase(temp.directory);
    let stdout = "";
    const result = runBaselineCli({
      databasePath,
      outputDirectory: join(temp.directory, "output"),
      now: new Date("2026-09-04T08:00:00.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
    });
    const parsed = JSON.parse(readFileSync(result.jsonPath, "utf8")) as BaselineReport;
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.rates.heldOutPass.interval.low, 0.23098652405492354);
    const gating = parsed.criterionClustering.gating;
    const quality = parsed.criterionClustering.quality;
    assert.deepEqual(Object.keys(gating), [
      "label",
      "gateRole",
      "tiers",
      "includedResults",
      "runScope",
      "stats",
      "designEffectByClusterSize",
    ]);
    assert.deepEqual(Object.keys(gating.stats), [
      "clusterCount",
      "observationCount",
      "successes",
      "mean",
      "meanClusterSize",
      "sumSquaredClusterSizes",
      "sizeWeightedM",
      "m0",
      "betweenMeanSquare",
      "withinMeanSquare",
      "rawIcc",
      "rhoForPlanning",
      "planning",
    ]);
    assert.deepEqual(
      {
        label: gating.label,
        gateRole: gating.gateRole,
        tiers: gating.tiers,
        includedResults: gating.includedResults,
        runScope: gating.runScope,
        clusterCount: gating.stats.clusterCount,
        observationCount: gating.stats.observationCount,
        sizeWeightedM: gating.stats.sizeWeightedM,
        rawIcc: gating.stats.rawIcc,
        recommendedDesignEffect: gating.stats.planning.unequalSizeRecommended.designEffect,
        recommendedEffectiveSampleSize: gating.stats.planning.unequalSizeRecommended.effectiveSampleSize,
      },
      {
        label: "GATING",
        gateRole: "gating",
        tiers: ["BLOCKING", "FUNCTIONAL"],
        includedResults: ["pass", "fail"],
        runScope: "held_out_pass IS NOT NULL",
        clusterCount: 16,
        observationCount: 248,
        sizeWeightedM: 17.725806451612904,
        rawIcc: 0.4674721124035525,
        recommendedDesignEffect: 8.818848073588452,
        recommendedEffectiveSampleSize: 28.12158662112965,
      },
    );
    assert.deepEqual(gating.designEffectByClusterSize, [
      { clusterSize: 2, designEffect: 1.4674721124035526 },
      { clusterSize: 3, designEffect: 1.9349442248071052 },
      { clusterSize: 6, designEffect: 3.3373605620177624 },
      { clusterSize: 10, designEffect: 5.207249011631973 },
      { clusterSize: 16, designEffect: 8.012081686053289 },
    ]);
    assert.deepEqual(
      {
        label: quality.label,
        gateRole: quality.gateRole,
        tiers: quality.tiers,
        includedResults: quality.includedResults,
        runScope: quality.runScope,
        clusterCount: quality.stats.clusterCount,
        observationCount: quality.stats.observationCount,
        rawIcc: quality.stats.rawIcc,
        recommendedEffectiveSampleSize: quality.stats.planning.unequalSizeRecommended.effectiveSampleSize,
      },
      {
        label: "QUALITY",
        gateRole: "never-gating",
        tiers: ["QUALITY"],
        includedResults: ["pass", "fail"],
        runScope: "held_out_pass IS NOT NULL",
        clusterCount: 16,
        observationCount: 49,
        rawIcc: 0.8253275109170305,
        recommendedEffectiveSampleSize: 16.975794251134644,
      },
    );
    assert.equal(result.report.sourceDatabase, databasePath);
    const markdown = readFileSync(result.markdownPath, "utf8");
    assert.match(markdown, /Held-out pass \| 7\/16 gated runs \| 43\.75% \| \[0\.2310, 0\.6682\]/);
    assert.match(markdown, /14 with no verdict/);
    assert.match(markdown, /\*\*QUALITY is never gating\.\*\*/);
    assert.match(markdown, /\| 16 \| 248 \| 15\.5000 \| 15\.3516 \| 1\.3615 \| 0\.0941 \| 0\.4675 \|/);
    assert.match(markdown, /\| Historical mean-size approximation \| 15\.5000 \| 7\.7783 \| 31\.8834 \| Reproducibility only \|/);
    assert.match(markdown, /\| Unequal-size estimate \| 17\.7258 \| 8\.8188 \| 28\.1216 \| Recommended \|/);
    assert.match(markdown, /\| 3 \| 1\.93 \|/);
    assert.match(markdown, /\| 16 \| 49 \| 3\.0625 \| 3\.0476 \| 0\.3500 \| 0\.0227 \| 0\.8253 \|/);
    assert.match(markdown, /\| Unequal-size estimate \| 3\.2857 \| 2\.8865 \| 16\.9758 \| Recommended \|/);
    assert.match(markdown, /\+10pp \| 53\.75% \| 389 \| 314-389/);
    assert.match(stdout, /Held-out pass: 7\/16 gated runs \(43\.75%, Wilson 95% \[0\.2310, 0\.6682\]\)/);
    assert.match(stdout, /Held-out fail: 9\/16 gated runs \(56\.25%, Wilson 95% \[0\.3318, 0\.7690\]\)/);
    assert.match(stdout, /Gate reach: 16\/30 all runs \(53\.33%, Wilson 95% \[0\.3614, 0\.6977\]\)/);
    assert.match(stdout, /No verdict: 14\/30 all runs \(46\.67%, Wilson 95% \[0\.3023, 0\.6386\]\)/);
    assert.match(stdout, /GATING clustering: ICC 0\.4675, recommended unequal-size DEFF 8\.8188, ESS 28\.1216/);
    assert.match(stdout, /QUALITY clustering \(never gating\): ICC 0\.8253, recommended unequal-size DEFF 2\.8865, ESS 16\.9758/);
  } finally {
    temp.cleanup();
  }
});

test("the CLI records repository databases with a portable relative path", () => {
  const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temp = scratch(serverDirectory);
  try {
    const databasePath = fixtureDatabase(
      temp.directory,
      [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    );
    const result = runBaselineCli({
      databasePath,
      outputDirectory: join(temp.directory, "output"),
      now: new Date("2026-09-04T08:00:00.000Z"),
      writeStdout: () => undefined,
    });
    assert.match(result.report.sourceDatabase, /^dashboard\/server\/dashboard-baseline-[^/]+\/runs\.db$/);
  } finally {
    temp.cleanup();
  }
});

test("an invalid Markdown target publishes neither baseline artifact", () => {
  const temp = scratch();
  try {
    const databasePath = fixtureDatabase(
      temp.directory,
      [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    );
    const outputDirectory = join(temp.directory, "output");
    const jsonPath = join(outputDirectory, "baseline-2026-09-04.json");
    mkdirSync(join(outputDirectory, "baseline-2026-09-04.md"), { recursive: true });

    let thrown: unknown;
    try {
      runBaselineCli({
        databasePath,
        outputDirectory,
        now: new Date("2026-09-04T08:00:00.000Z"),
        writeStdout: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(existsSync(jsonPath), false);
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /baseline output target must be a regular file/);
  } finally {
    temp.cleanup();
  }
});

test("a second replacement failure restores both prior baseline artifacts", () => {
  const temp = scratch();
  try {
    const jsonPath = join(temp.directory, "baseline.json");
    const markdownPath = join(temp.directory, "baseline.md");
    const temporaryJsonPath = join(temp.directory, "baseline.json.tmp");
    const temporaryMarkdownPath = join(temp.directory, "baseline.md.tmp");
    const backupJsonPath = join(temp.directory, "baseline.json.bak");
    const backupMarkdownPath = join(temp.directory, "baseline.md.bak");
    writeFileSync(jsonPath, "old json", "utf8");
    writeFileSync(markdownPath, "old markdown", "utf8");
    writeFileSync(temporaryJsonPath, "new json", "utf8");
    writeFileSync(temporaryMarkdownPath, "new markdown", "utf8");

    let renameCount = 0;
    const failFourthRename = (from: string, to: string): void => {
      renameCount += 1;
      if (renameCount === 4) throw new Error("injected second replacement failure");
      renameSync(from, to);
    };
    assert.throws(
      () =>
        replacePreparedBaselineArtifacts(
          [
            { targetPath: jsonPath, temporaryPath: temporaryJsonPath, backupPath: backupJsonPath },
            {
              targetPath: markdownPath,
              temporaryPath: temporaryMarkdownPath,
              backupPath: backupMarkdownPath,
            },
          ],
          failFourthRename,
        ),
      /injected second replacement failure/,
    );
    assert.equal(readFileSync(jsonPath, "utf8"), "old json");
    assert.equal(readFileSync(markdownPath, "utf8"), "old markdown");
    assert.equal(existsSync(backupJsonPath), false);
    assert.equal(existsSync(backupMarkdownPath), false);
  } finally {
    temp.cleanup();
  }
});

test("a failed first publication leaves neither baseline artifact installed", () => {
  const temp = scratch();
  try {
    const jsonPath = join(temp.directory, "baseline.json");
    const markdownPath = join(temp.directory, "baseline.md");
    const temporaryJsonPath = join(temp.directory, "baseline.json.tmp");
    const temporaryMarkdownPath = join(temp.directory, "baseline.md.tmp");
    const backupJsonPath = join(temp.directory, "baseline.json.bak");
    const backupMarkdownPath = join(temp.directory, "baseline.md.bak");
    writeFileSync(temporaryJsonPath, "new json", "utf8");
    writeFileSync(temporaryMarkdownPath, "new markdown", "utf8");

    let renameCount = 0;
    const failSecondRename = (from: string, to: string): void => {
      renameCount += 1;
      if (renameCount === 2) throw new Error("injected second replacement failure");
      renameSync(from, to);
    };
    assert.throws(
      () =>
        replacePreparedBaselineArtifacts(
          [
            { targetPath: jsonPath, temporaryPath: temporaryJsonPath, backupPath: backupJsonPath },
            {
              targetPath: markdownPath,
              temporaryPath: temporaryMarkdownPath,
              backupPath: backupMarkdownPath,
            },
          ],
          failSecondRename,
        ),
      /injected second replacement failure/,
    );
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(markdownPath), false);
    assert.equal(existsSync(backupJsonPath), false);
    assert.equal(existsSync(backupMarkdownPath), false);
  } finally {
    temp.cleanup();
  }
});

test("backup cleanup failures preserve a committed pair and report every retained backup", () => {
  const temp = scratch();
  try {
    const jsonPath = join(temp.directory, "baseline.json");
    const markdownPath = join(temp.directory, "baseline.md");
    const temporaryJsonPath = join(temp.directory, "baseline.json.tmp");
    const temporaryMarkdownPath = join(temp.directory, "baseline.md.tmp");
    const backupJsonPath = join(temp.directory, "baseline.json.bak");
    const backupMarkdownPath = join(temp.directory, "baseline.md.bak");
    writeFileSync(jsonPath, "old json", "utf8");
    writeFileSync(markdownPath, "old markdown", "utf8");
    writeFileSync(temporaryJsonPath, "new json", "utf8");
    writeFileSync(temporaryMarkdownPath, "new markdown", "utf8");

    const removalAttempts: string[] = [];
    const failBackupRemoval = (path: string): void => {
      removalAttempts.push(path);
      throw new Error(`injected cleanup failure for ${path}`);
    };
    const retainedBackupPaths = replacePreparedBaselineArtifacts(
      [
        { targetPath: jsonPath, temporaryPath: temporaryJsonPath, backupPath: backupJsonPath },
        {
          targetPath: markdownPath,
          temporaryPath: temporaryMarkdownPath,
          backupPath: backupMarkdownPath,
        },
      ],
      renameSync,
      failBackupRemoval,
    );
    assert.deepEqual(removalAttempts, [backupJsonPath, backupMarkdownPath]);
    assert.deepEqual(retainedBackupPaths, [backupJsonPath, backupMarkdownPath]);
    assert.equal(readFileSync(jsonPath, "utf8"), "new json");
    assert.equal(readFileSync(markdownPath, "utf8"), "new markdown");
    assert.equal(readFileSync(backupJsonPath, "utf8"), "old json");
    assert.equal(readFileSync(backupMarkdownPath, "utf8"), "old markdown");
  } finally {
    temp.cleanup();
  }
});

test("renderers preserve machine precision and round only presentation", () => {
  const report = createBaselineReport(
    { totalRuns: 30, gatedDenominator: 16, successes: 7, failures: 9, noVerdict: 14 },
    "2026-09-04T08:00:00.000Z",
    "dashboard/data/runs.db",
    fixtureClusterInputs(),
  );
  const json = renderBaselineJson(report);
  assert.match(json, /0\.23098652405492354/);
  const parsed = JSON.parse(json) as { rates: { heldOutPass: Record<string, unknown> } };
  assert.deepEqual(Object.keys(parsed.rates.heldOutPass), [
    "successes",
    "n",
    "rate",
    "standardError",
    "interval",
    "confidence",
    "standardErrorDegenerate",
    "label",
    "denominatorLabel",
  ]);
  assert.match(renderBaselineMarkdown(report), /\[0\.2310, 0\.6682\]/);
});
