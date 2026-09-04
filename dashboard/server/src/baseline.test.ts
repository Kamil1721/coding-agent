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
import { replacePreparedBaselineArtifacts, runBaselineCli } from "./baseline-cli.js";

function scratch(parentDirectory = tmpdir()): { readonly directory: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(parentDirectory, "dashboard-baseline-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function fixtureDatabase(directory: string, rows: readonly (0 | 1 | null)[]): string {
  const path = join(directory, "runs.db");
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE runs (status TEXT NOT NULL, held_out_pass INTEGER)");
    const insert = db.prepare("INSERT INTO runs (status, held_out_pass) VALUES (?, ?)");
    for (const heldOutPass of rows) {
      insert.run(heldOutPass === null ? "passed" : "failed", heldOutPass);
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

test("the CLI writes parseable full-precision JSON and a denominator-rich Markdown report", () => {
  const temp = scratch();
  try {
    const databasePath = fixtureDatabase(
      temp.directory,
      [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    );
    let stdout = "";
    const result = runBaselineCli({
      databasePath,
      outputDirectory: join(temp.directory, "output"),
      now: new Date("2026-09-04T08:00:00.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
    });
    const parsed = JSON.parse(readFileSync(result.jsonPath, "utf8")) as { rates: { heldOutPass: { interval: { low: number } } } };
    assert.equal(parsed.rates.heldOutPass.interval.low, 0.23098652405492354);
    assert.equal(result.report.sourceDatabase, databasePath);
    const markdown = readFileSync(result.markdownPath, "utf8");
    assert.match(markdown, /Held-out pass \| 7\/16 gated runs \| 43\.75% \| \[0\.2310, 0\.6682\]/);
    assert.match(markdown, /14 with no verdict/);
    assert.match(markdown, /\+10pp \| 53\.75% \| 389 \| 314-389/);
    assert.match(stdout, /Held-out pass: 7\/16 gated runs \(43\.75%, Wilson 95% \[0\.2310, 0\.6682\]\)/);
    assert.match(stdout, /Held-out fail: 9\/16 gated runs \(56\.25%, Wilson 95% \[0\.3318, 0\.7690\]\)/);
    assert.match(stdout, /Gate reach: 16\/30 all runs \(53\.33%, Wilson 95% \[0\.3614, 0\.6977\]\)/);
    assert.match(stdout, /No verdict: 14\/30 all runs \(46\.67%, Wilson 95% \[0\.3023, 0\.6386\]\)/);
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
