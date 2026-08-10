/**
 * TIER 3 — THE FROZEN CLOSURE, COMPUTED, NOT HAND-LISTED.
 *
 * DESIGN §6.1 lists 11 production files and 7 test files. A hand-maintained
 * list drifts the first time somebody adds an import, and a drifted list is a
 * partition that reports "outside the closure" for a file that is inside it —
 * which is the direction that costs, because that answer authorises a
 * self-apply. So the closure is DERIVED here from the four verdict-producing
 * entry points by transitive local-import walk, at every gate cycle.
 *
 * HONEST CEILING, STATED IN THE CODE AND NOT ONLY IN THE DOC.
 * Under the current single-uid configuration this whole file is writable by
 * the same agent whose patches it classifies. It is TAMPER-EVIDENT, NOT
 * TAMPER-PROOF: chmod, git hooks and CODEOWNERS are, in the design's words,
 * "documentation wearing an enforcement costume". The property bought is
 * DETECTABILITY (§6.2 L2 digest manifest kept outside the tree, §6.2 L4 apply
 * token, the append-only trail) — never prevention. RESEARCH H3/R9 is the
 * reason this says "under the current single-uid configuration" rather than
 * the design's absolute "nothing on this machine is unwritable": a second
 * non-root uid would make L1 a kernel refusal, and nobody has tested it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The four entry points that produce a verdict. DESIGN §1.3 / §6.1. */
export const VERDICT_ENTRY_POINTS = Object.freeze(["gate.ts", "scorer.ts", "scorer-container.ts", "tier0.ts"]);

/**
 * The 11 the design derived on 2026-08-10. Used as a FLOOR, never as an
 * equality: a legitimate new import must not fail the gate (it would fail for
 * the wrong reason), but a MISSING member is the softening direction — losing
 * `spec-freeze.ts` from the closure makes "which half is held out" editable
 * without touching a scorer file. Monotone ratchet, RESEARCH R13.
 */
export const CLOSURE_FLOOR = Object.freeze([
  "config.ts",
  "contracts.ts",
  "gate.ts",
  "hash.ts",
  "redact.ts",
  "scorer-container.ts",
  "scorer-protocol.ts",
  "scorer.ts",
  "spec-freeze.ts",
  "spec-types.ts",
  "tier0.ts",
]);

/**
 * FROZEN-DATA AND POLICY. DESIGN §6.1 — no closure derivation is possible for
 * these (they are artefacts and fixtures, not modules), so they are prefixes.
 */
export const FROZEN_DATA_PREFIXES = Object.freeze([
  "dashboard/server/src/calibration/",
  "dashboard/server/src/calibration.test.ts",
  "dashboard/server/calibration/",
  "dashboard/server/probes/calibration-4a.mjs",
  "dashboard/server/probes/calibration-authoring.mjs",
  "dashboard/server/probes/results/",
  "dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/",
  "dashboard/results/scores/run-2026-07-29T23-28-46-665Z-3d4d1ccb.container.json",
  "dashboard/acceptance/t-621a2808720d755e/",
  "dashboard/acceptance/t-ac91abe93759dc0b/",
  "bakeoff/docker/scorer.Dockerfile",
  "bakeoff/docker/scorer.Dockerfile.dockerignore",
  "bakeoff/docker/playwright.config.mjs",
  "bakeoff/docker/node-test-reporter.mjs",
]);

/**
 * THE ADMISSION SET — REFUSED AT EVERY TIER, NEVER QUEUED.
 *
 * RESEARCH R30 / Ferbach arXiv:2407.09499: a curated self-consuming loop
 * provably maximises the expected reward of its own curation rule and
 * amplifies its biases. The admission predicate therefore BECOMES the
 * objective function, so it cannot be self-editable at any tier — including
 * the impossible-ticket set, because a movable anchor is not an anchor
 * (RESEARCH R10). This is stricter than FROZEN: frozen paths can be patched
 * with owner approval; these are refused before the queue.
 */
export const ADMISSION_PREFIXES = Object.freeze([
  "tools/tier3/",
  "bakeoff/test/tier3-fixtures/impossible/",
]);

const IMPORT_RE = /from\s+"\.\/([A-Za-z0-9._-]+)\.js"/g;

/** Transitive local-import closure of `entryPoints` inside `srcDir`. */
export function importClosure(srcDir, entryPoints = VERDICT_ENTRY_POINTS) {
  const seen = new Set();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const abs = join(srcDir, file);
    if (!existsSync(abs)) continue;
    seen.add(file);
    const text = readFileSync(abs, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const next = `${match[1]}.ts`;
      if (!seen.has(next) && existsSync(join(srcDir, next))) queue.push(next);
    }
  }
  return [...seen].sort();
}

/** Test files importing any closure module. DESIGN §6.1 FROZEN-CONTROLS. */
export function controlFiles(srcDir, closure) {
  const bases = new Set(closure.map((f) => f.replace(/\.ts$/, "")));
  const out = [];
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".test.ts")) continue;
    if (closure.includes(name)) continue;
    const text = readFileSync(join(srcDir, name), "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      if (bases.has(match[1])) {
        out.push(name);
        break;
      }
    }
  }
  return out.sort();
}

/**
 * Compute the whole partition. `missingFromFloor` is the alarm: it is the only
 * direction of drift that softens the grader.
 */
export function frozenClosure(repoRoot) {
  const srcDir = join(repoRoot, "bakeoff", "src");
  const closure = importClosure(srcDir);
  const controls = controlFiles(srcDir, closure);
  return {
    srcDir,
    grader: closure.map((f) => `bakeoff/src/${f}`),
    controls: controls.map((f) => `bakeoff/src/${f}`),
    dataPrefixes: [...FROZEN_DATA_PREFIXES],
    admissionPrefixes: [...ADMISSION_PREFIXES],
    missingFromFloor: CLOSURE_FLOOR.filter((f) => !closure.includes(f)),
    addedSinceFloor: closure.filter((f) => !CLOSURE_FLOOR.includes(f)),
  };
}

/**
 * Classify one repo-relative path. ADMISSION IS CHECKED FIRST and deliberately
 * so: the impossible-ticket set lives under `bakeoff/test/`, which is
 * otherwise EDITABLE, and the wrong order would make the anchor set editable
 * by the process it anchors.
 */
export function classifyPath(rel, closure) {
  const p = rel.replace(/^\.\//, "");
  if (closure.admissionPrefixes.some((prefix) => p === prefix || p.startsWith(prefix))) return "admission";
  if (closure.grader.includes(p)) return "frozen-grader";
  if (closure.controls.includes(p)) return "frozen-controls";
  if (closure.dataPrefixes.some((prefix) => p === prefix || p.startsWith(prefix))) return "frozen-data";
  return "editable";
}

const FROZEN_CLASSES = new Set(["frozen-grader", "frozen-controls", "frozen-data"]);

/** Paths named by a unified diff, from the `+++ b/` and `--- a/` headers. */
export function filesInDiff(diffText) {
  const out = new Set();
  for (const line of diffText.split("\n")) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git !== null) {
      out.add(git[1]);
      out.add(git[2]);
      continue;
    }
    const head = /^(?:\+\+\+ b\/|--- a\/)(.+?)(?:\t.*)?$/.exec(line);
    if (head !== null && head[1] !== "dev/null") out.add(head[1]);
  }
  return [...out].sort();
}

/**
 * ROUTE A DIFF. The three outcomes are the agreed policy, §6 of the brief:
 *   REFUSED          — touches the admission gate or the impossible set.
 *   INSIDE-CLOSURE   — needs all four extra proofs or automatic rollback.
 *   OUTSIDE-CLOSURE  — self-applies behind the normal gate.
 */
export function classifyDiff(diffText, closure) {
  const filesChanged = filesInDiff(diffText);
  const byPath = filesChanged.map((path) => ({ path, class: classifyPath(path, closure) }));
  const touchesAdmission = byPath.some((f) => f.class === "admission");
  const touchesFrozenClosure = byPath.some((f) => FROZEN_CLASSES.has(f.class));
  let route = "OUTSIDE-CLOSURE";
  if (touchesAdmission) route = "REFUSED";
  else if (touchesFrozenClosure) route = "INSIDE-CLOSURE";
  return {
    filesChanged,
    byPath,
    touchesAdmission,
    touchesFrozenClosure,
    route,
    reason:
      route === "REFUSED"
        ? `the diff touches the admission set (${byPath
            .filter((f) => f.class === "admission")
            .map((f) => f.path)
            .join(", ")}); the admission predicate is the objective function and is not self-editable at any tier`
        : route === "INSIDE-CLOSURE"
          ? `the diff touches the frozen closure (${byPath
              .filter((f) => FROZEN_CLASSES.has(f.class))
              .map((f) => f.path)
              .join(", ")}); all four extra proofs are required`
          : "every changed path is EDITABLE; the normal gate decides",
  };
}
