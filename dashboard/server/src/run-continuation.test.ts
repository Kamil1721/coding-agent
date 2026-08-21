import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaths, runPathsFor } from "./paths.js";
import { stageContinuationWorkspace } from "./run-continuation.js";

test("the continuation staging winner owns the target and a replay loser cannot rewrite it", () => {
  const directory = mkdtempSync(join(tmpdir(), "dash-continuation-stage-"));
  const paths = resolvePaths({ DASHBOARD_HOME: directory });
  const source = runPathsFor(paths, "run-source");
  const target = runPathsFor(paths, "run-target");
  try {
    mkdirSync(paths.runs, { recursive: true });
    mkdirSync(source.workspace, { recursive: true });
    writeFileSync(join(source.workspace, "index.html"), "winner source", "utf8");

    assert.equal(stageContinuationWorkspace(source, target), true);
    writeFileSync(join(target.workspace, "winner.txt"), "must survive", "utf8");
    writeFileSync(join(source.workspace, "index.html"), "loser source", "utf8");

    assert.throws(
      () => stageContinuationWorkspace(source, target),
      /EEXIST/,
      "the deterministic root is an exclusive filesystem claim",
    );
    assert.equal(readFileSync(join(target.workspace, "index.html"), "utf8"), "winner source");
    assert.equal(readFileSync(join(target.workspace, "winner.txt"), "utf8"), "must survive");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("continuation staging refuses a terminal source with no workspace", () => {
  const directory = mkdtempSync(join(tmpdir(), "dash-continuation-missing-"));
  const paths = resolvePaths({ DASHBOARD_HOME: directory });
  const source = runPathsFor(paths, "run-source");
  const target = runPathsFor(paths, "run-target");
  try {
    mkdirSync(paths.runs, { recursive: true });
    assert.equal(stageContinuationWorkspace(source, target), false);
    assert.equal(existsSync(target.root), false, "a refused continuation does not claim a target identity");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
