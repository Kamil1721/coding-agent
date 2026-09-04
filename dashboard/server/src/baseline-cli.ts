import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createBaselineReport,
  renderBaselineJson,
  renderBaselineMarkdown,
} from "./baseline.js";
import type { BaselineCounts, BaselineReport } from "./baseline.js";
import type { BaselineClusterInputs } from "./baseline.js";
import type { BinaryCountCluster } from "./cluster-stats.js";
import { resolvePaths } from "./paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..", "..", "..");
const DEFAULT_OUTPUT_DIRECTORY = resolve(REPOSITORY_ROOT, "docs", "baseline");

export interface BaselineCliOptions {
  readonly databasePath?: string;
  readonly outputDirectory?: string;
  readonly now?: Date;
  readonly writeStdout?: (text: string) => void;
}

export interface BaselineCliResult {
  readonly report: BaselineReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly retainedBackupPaths: readonly string[];
}

function countValue(value: unknown, label: string): number {
  const count = typeof value === "bigint" ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`database returned an invalid ${label} count: ${String(value)}`);
  }
  return count;
}

export function readBaselineCounts(db: DatabaseSync): BaselineCounts {
  const row = db
    .prepare(
      `SELECT
         count(*) AS total_runs,
         count(held_out_pass) AS gated_denominator,
         sum(CASE WHEN held_out_pass = 1 THEN 1 ELSE 0 END) AS passes,
         sum(CASE WHEN held_out_pass = 0 THEN 1 ELSE 0 END) AS failures,
         sum(CASE WHEN held_out_pass IS NULL THEN 1 ELSE 0 END) AS no_verdict
       FROM runs`,
    )
    .get();
  if (row === undefined) throw new Error("baseline query returned no row");
  return {
    totalRuns: countValue(row["total_runs"], "total runs"),
    gatedDenominator: countValue(row["gated_denominator"], "gated denominator"),
    successes: countValue(row["passes"] ?? 0, "pass"),
    failures: countValue(row["failures"] ?? 0, "failure"),
    noVerdict: countValue(row["no_verdict"] ?? 0, "no-verdict"),
  };
}

export type CriterionTierGroup = "gating" | "quality";

export interface BaselineDatabaseSnapshot {
  readonly counts: BaselineCounts;
  readonly clusterInputs: BaselineClusterInputs;
}

export function readCriterionClusters(
  db: DatabaseSync,
  tierGroup: CriterionTierGroup,
): readonly BinaryCountCluster[] {
  const tierPredicate =
    tierGroup === "gating" ? "c.tier IN ('BLOCKING', 'FUNCTIONAL')" : "c.tier = 'QUALITY'";
  const rows = db
    .prepare(
      `SELECT
         c.run_id AS cluster_id,
         sum(CASE WHEN c.result = 'pass' THEN 1 ELSE 0 END) AS successes,
         count(*) AS observation_count
       FROM criteria AS c
       INNER JOIN runs AS r ON r.run_id = c.run_id
       WHERE r.held_out_pass IS NOT NULL
         AND c.result IN ('pass', 'fail')
         AND ${tierPredicate}
       GROUP BY c.run_id
       ORDER BY c.run_id`,
    )
    .all();

  return rows.map((row) => {
    const id = row["cluster_id"];
    if (typeof id !== "string" || id === "") {
      throw new Error(`database returned an invalid criterion cluster id: ${String(id)}`);
    }
    return {
      id,
      successes: countValue(row["successes"], `${tierGroup} cluster success`),
      n: countValue(row["observation_count"], `${tierGroup} cluster observation`),
    };
  });
}

/** Read every baseline input from one SQLite snapshot. The callback exists for concurrency tests. */
export function readBaselineSnapshot(
  db: DatabaseSync,
  afterCountsRead: () => void = () => undefined,
): BaselineDatabaseSnapshot {
  db.exec("BEGIN");
  try {
    const counts = readBaselineCounts(db);
    afterCountsRead();
    const clusterInputs = {
      gating: readCriterionClusters(db, "gating"),
      quality: readCriterionClusters(db, "quality"),
    };
    db.exec("COMMIT");
    return { counts, clusterInputs };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "baseline snapshot read failed and its transaction could not be rolled back",
      );
    }
    throw error;
  }
}

function sourceDatabaseForReport(databasePath: string): string {
  const repositoryRelativePath = relative(REPOSITORY_ROOT, databasePath);
  const isInsideRepository =
    repositoryRelativePath !== "" &&
    repositoryRelativePath !== ".." &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath);
  return isInsideRepository ? repositoryRelativePath.split(sep).join("/") : databasePath;
}

function assertRegularOutputTarget(path: string): void {
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error(`baseline output target must be a regular file: ${path}`);
  }
}

export interface PreparedBaselineArtifact {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly backupPath: string;
}

export type RenameFile = (from: string, to: string) => void;
export type RemoveFile = (path: string) => void;

/** Replace a prepared artifact pair, restoring both prior files if either replacement fails. */
export function replacePreparedBaselineArtifacts(
  artifacts: readonly PreparedBaselineArtifact[],
  renameFile: RenameFile = renameSync,
  removeFile: RemoveFile = (path) => rmSync(path, { force: true }),
): readonly string[] {
  const states = artifacts.map((artifact) => ({
    ...artifact,
    existed: existsSync(artifact.targetPath),
    backedUp: false,
    installed: false,
  }));
  for (const state of states) assertRegularOutputTarget(state.targetPath);

  try {
    for (const state of states) {
      if (!state.existed) continue;
      renameFile(state.targetPath, state.backupPath);
      state.backedUp = true;
    }
    for (const state of states) {
      renameFile(state.temporaryPath, state.targetPath);
      state.installed = true;
    }
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const state of [...states].reverse()) {
      if (state.installed) {
        try {
          removeFile(state.targetPath);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (state.backedUp) {
        try {
          renameFile(state.backupPath, state.targetPath);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "baseline artifact replacement failed and could not be fully rolled back",
      );
    }
    throw error;
  }

  const retainedBackupPaths: string[] = [];
  for (const state of states) {
    if (!state.backedUp) continue;
    try {
      removeFile(state.backupPath);
    } catch {
      retainedBackupPaths.push(state.backupPath);
    }
  }
  return retainedBackupPaths;
}

function writeBaselineArtifacts(
  jsonPath: string,
  json: string,
  markdownPath: string,
  markdown: string,
): readonly string[] {
  assertRegularOutputTarget(jsonPath);
  assertRegularOutputTarget(markdownPath);

  const suffix = `.tmp-${String(process.pid)}-${randomUUID()}`;
  const temporaryJsonPath = `${jsonPath}${suffix}`;
  const temporaryMarkdownPath = `${markdownPath}${suffix}`;
  const backupJsonPath = `${jsonPath}${suffix}.bak`;
  const backupMarkdownPath = `${markdownPath}${suffix}.bak`;
  try {
    writeFileSync(temporaryJsonPath, json, { encoding: "utf8", flag: "wx" });
    writeFileSync(temporaryMarkdownPath, markdown, { encoding: "utf8", flag: "wx" });
    return replacePreparedBaselineArtifacts([
      { targetPath: jsonPath, temporaryPath: temporaryJsonPath, backupPath: backupJsonPath },
      { targetPath: markdownPath, temporaryPath: temporaryMarkdownPath, backupPath: backupMarkdownPath },
    ]);
  } finally {
    rmSync(temporaryJsonPath, { force: true });
    rmSync(temporaryMarkdownPath, { force: true });
  }
}

export function runBaselineCli(options: BaselineCliOptions = {}): BaselineCliResult {
  const databasePath = resolve(options.databasePath ?? resolvePaths().database);
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let snapshot: BaselineDatabaseSnapshot;
  try {
    snapshot = readBaselineSnapshot(db);
  } finally {
    db.close();
  }
  const { counts, clusterInputs } = snapshot;

  const report = createBaselineReport(
    counts,
    generatedAt,
    sourceDatabaseForReport(databasePath),
    clusterInputs,
  );
  const basename = `baseline-${generatedAt.slice(0, 10)}`;
  const jsonPath = resolve(outputDirectory, `${basename}.json`);
  const markdownPath = resolve(outputDirectory, `${basename}.md`);
  mkdirSync(outputDirectory, { recursive: true });
  const retainedBackupPaths = writeBaselineArtifacts(
    jsonPath,
    renderBaselineJson(report),
    markdownPath,
    renderBaselineMarkdown(report),
  );

  const cleanupWarning =
    retainedBackupPaths.length === 0
      ? ""
      : `warning: baseline artifacts committed; retained backup files: ${retainedBackupPaths.join(", ")}\n`;
  const printedRates = Object.values(report.rates)
    .map(
      (item) =>
        `${item.label}: ${String(item.successes)}/${String(item.n)} ${item.denominatorLabel} ` +
        `(${(item.rate * 100).toFixed(2)}%, Wilson 95% ` +
        `[${item.interval.low.toFixed(4)}, ${item.interval.high.toFixed(4)}])`,
    )
    .join("\n");
  const gating = report.criterionClustering.gating.stats;
  const quality = report.criterionClustering.quality.stats;
  const printedClustering = [
    `GATING clustering: ICC ${gating.rawIcc.toFixed(4)}, recommended unequal-size DEFF ` +
      `${gating.planning.unequalSizeRecommended.designEffect.toFixed(4)}, ESS ` +
      `${gating.planning.unequalSizeRecommended.effectiveSampleSize.toFixed(4)} ` +
      `(mean-size reproducibility-only ESS ${gating.planning.meanSizeApproximation.effectiveSampleSize.toFixed(4)})`,
    `QUALITY clustering (never gating): ICC ${quality.rawIcc.toFixed(4)}, recommended unequal-size DEFF ` +
      `${quality.planning.unequalSizeRecommended.designEffect.toFixed(4)}, ESS ` +
      `${quality.planning.unequalSizeRecommended.effectiveSampleSize.toFixed(4)} ` +
      `(mean-size reproducibility-only ESS ${quality.planning.meanSizeApproximation.effectiveSampleSize.toFixed(4)})`,
  ].join("\n");
  const summary = `${printedRates}\n${printedClustering}\n${jsonPath}\n${markdownPath}\n${cleanupWarning}`;
  (options.writeStdout ?? ((text) => process.stdout.write(text)))(summary);
  return { report, jsonPath, markdownPath, retainedBackupPaths };
}

function parseArguments(args: readonly string[]): BaselineCliOptions {
  let databasePath: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--database" && value !== undefined) {
      databasePath = value;
      index += 1;
    } else if (argument === "--output-dir" && value !== undefined) {
      outputDirectory = value;
      index += 1;
    } else {
      throw new Error(`usage: baseline-cli [--database PATH] [--output-dir PATH]; unexpected ${String(argument)}`);
    }
  }
  return {
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  try {
    runBaselineCli(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
