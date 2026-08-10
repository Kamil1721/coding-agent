#!/usr/bin/env node
/**
 * UNIT A + UNIT C — CHECKER REPLAY over the regression corpus. FREE. NO MODEL CALLS.
 *
 * RESEARCH-self-improving-practice.md H1(a): "checker replay — free, no model
 * calls. Stored artefacts × candidate checker. Answers 'does
 * collectManifestProblems still reject everything it rejected?' in milliseconds."
 * R33 orders this shipped before seat replay, because it is the unit that makes
 * a prompt or validator change measurable without spending a run.
 *
 *   node tools/replay/replay.mjs              run the corpus, print a report
 *   node tools/replay/replay.mjs --json       machine-readable, for the defect stream
 *   node tools/replay/replay.mjs --rounds     also print rounds-to-accept per case
 *   REPLAY_CHECKER=<file> node …              replay against a CANDIDATE checker
 *
 * EXIT CODES
 *   0  every case matched its recorded outcome, arm checks armed
 *   1  a case disagreed with its record, or an arm check FAILED (the harness is
 *      blind), or the corpus is empty / partly unarmed
 *
 * ============================ THE ARM CHECKS =============================
 * A replay harness that silently replays zero cases is this repository's
 * signature defect wearing a new costume. Four distinct ways this harness could
 * be blind, each with a control that runs BEFORE any case, while the answer is
 * known, and each of which prints its measurement rather than its conclusion:
 *
 *   ARM 1  corpus size          — 0 cases is a hard failure, never "0 failures, PASS"
 *   ARM 2  checker is not blind — a known-good manifest must be ACCEPTED and a
 *                                 known-bad one REJECTED **naming the field**.
 *                                 One direction alone passes on a stub.
 *   ARM 3  fixture integrity    — every fixture's sha256 matches its recorded meta
 *   ARM 4  fixtures are distinct— the three a913c871 manifests must differ from
 *                                 one another. An extractor bug that wrote the
 *                                 same manifest three times is the silent failure
 *                                 most likely to survive review.
 * =========================================================================
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { KNOWN_BAD_EXPECTED_FIELD, KNOWN_GOOD_MANIFEST, REPO_ROOT, checkManifest, knownBadManifest, loadChecker } from "./checker.mjs";
import { FIXTURE_DIR, loadCorpus } from "./corpus.mjs";
// ONE canonicaliser, imported from the side that WROTE the digest. Two
// implementations of the same serialisation on opposite sides of an integrity
// check is a diverging validator, and it makes the check either spuriously red
// or wrongly agreeable.
import { canonicalJson as canonical, sha256 } from "./extract-fixtures.mjs";
import { defectSignature, normaliseFieldPaths } from "./signature.mjs";

/** ARM 2 — the checker must be able to say both yes and no. */
export function armChecker(checker) {
  const good = checkManifest(checker, KNOWN_GOOD_MANIFEST);
  const bad = checkManifest(checker, knownBadManifest());
  const badNames = bad.collectAllFields.includes(KNOWN_BAD_EXPECTED_FIELD);
  return {
    name: "checker is not blind",
    armed: good.accepted && !bad.accepted && badNames,
    detail:
      `known-good manifest -> ${good.accepted ? "ACCEPTED" : `REJECTED (${good.failFast})`}; ` +
      `known-bad (minRows dropped) -> ${bad.accepted ? "ACCEPTED" : "REJECTED"}` +
      `, names ${KNOWN_BAD_EXPECTED_FIELD}: ${badNames ? "yes" : `NO (named ${bad.collectAllFields.join(",") || "nothing"})`}`,
  };
}

/** ARM 3 — a fixture edited by hand, or truncated on copy, is not evidence. */
export function armFixtureIntegrity(fixtureDir = FIXTURE_DIR) {
  const checked = [];
  const broken = [];
  for (const n of [1, 2, 3]) {
    const id = `a913c871-attempt${n}`;
    const metaPath = path.join(fixtureDir, `${id}.meta.json`);
    const manPath = path.join(fixtureDir, `${id}.manifest.json`);
    if (!existsSync(metaPath) || !existsSync(manPath)) {
      broken.push(`${id}: file missing`);
      continue;
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    /**
     * Compare the file on disk against a digest RECORDED AT EXTRACTION TIME.
     * Hashing the same bytes twice and finding they agree is the thing this
     * whole harness exists to refuse, so the recorded value must come from the
     * meta file and its absence is a failure, not a skip.
     */
    if (typeof meta.manifestCanonicalSha256 !== "string") {
      broken.push(`${id}: meta records no manifestCanonicalSha256 — re-run extract-fixtures.mjs`);
      continue;
    }
    const haveSha = sha256(canonical(JSON.parse(readFileSync(manPath, "utf8"))));
    checked.push(`${id}=${haveSha.slice(0, 12)}`);
    if (haveSha !== meta.manifestCanonicalSha256) {
      broken.push(`${id}: on-disk ${haveSha.slice(0, 12)} != recorded ${meta.manifestCanonicalSha256.slice(0, 12)}`);
    }
  }
  return {
    name: "fixture integrity",
    armed: broken.length === 0 && checked.length === 3,
    detail: broken.length === 0 ? `3 fixture(s) hashed: ${checked.join(" ")}` : broken.join("; "),
  };
}

/** ARM 4 — three fixtures that are byte-identical are one fixture. */
export function armFixturesDistinct(fixtureDir = FIXTURE_DIR) {
  const shapes = new Map();
  for (const n of [1, 2, 3]) {
    const f = path.join(fixtureDir, `a913c871-attempt${n}.manifest.json`);
    if (!existsSync(f)) continue;
    const de = JSON.parse(readFileSync(f, "utf8")).dataExpectations ?? [];
    const keys = [...new Set(de.flatMap((e) => Object.keys(e ?? {})))].sort().join(",");
    shapes.set(`attempt${n}`, keys);
  }
  const distinct = new Set(shapes.values());
  return {
    name: "fixtures are distinct",
    armed: shapes.size === 3 && distinct.size === 3,
    detail: [...shapes].map(([k, v]) => `${k}{${v}}`).join("  "),
  };
}

/**
 * ROUNDS-TO-ACCEPT — the corpus's headline metric, and the one number that says
 * whether a feedback change actually bought anything.
 *
 * Simulates an OBEDIENT seat: repair exactly the fields the validator named,
 * with a legal value for the entry's own kind, and re-submit. `failFast` repairs
 * one field per round (what a913c871 lived through); `collectAll` repairs every
 * named field per round. The post-mortem records 7/6/5 vs 2/2/1 against a budget
 * of 3, measured independently on 2026-08-10.
 *
 * MEASURED HERE, and it half-reproduces the published table:
 *   collect-all  2 / 2 / 1   — EXACTLY the post-mortem's figures.
 *   fail-fast   14 / 12 / 10 — EXACTLY 2x the post-mortem's 7 / 6 / 5, and each
 *                              of these three manifests carries TWO
 *                              dataExpectations entries. The published
 *                              simulation repaired one entry; this one repairs
 *                              the document the seat actually emitted. Same
 *                              mechanism, different denominator — not a
 *                              contradiction, and not silently smoothed over.
 * Either way the conclusion is the one the run died of: budget 3, and fail-fast
 * needs ten rounds at best.
 *
 * Honest limit: an obedient seat is not a real seat. Attempt 3 was measured
 * REPLACING its whole vocabulary rather than repairing. This is an upper bound on
 * how well feedback can work, not a prediction of a run.
 */
export function roundsToAccept(checker, manifest, mode, cap = 40) {
  let doc = structuredClone(manifest);
  for (let round = 1; round <= cap; round += 1) {
    const r = checkManifest(checker, doc);
    if (r.accepted) return round - 1;
    const fields = mode === "failFast" ? firstField(r) : r.collectAllFields;
    if (fields.length === 0) return null;
    let changed = false;
    for (const f of fields) {
      if (repairField(doc, f)) changed = true;
      if (mode === "failFast") break;
    }
    if (!changed) return null;
  }
  return null;
}

function firstField(result) {
  const hit = result.collectAll.find((p) => p.message === result.failFast);
  const field = hit?.field ?? result.collectAll[0]?.field;
  return field === undefined || field === "suite.manifest.json" ? [] : [field];
}

const LEGAL = {
  id: () => `expectation-${Math.random().toString(36).slice(2, 8)}`,
  kind: (entry) => (typeof entry.path === "string" ? "http" : "sqlite"),
  minRows: () => 1,
  file: (entry) => (entry.kind === "http" ? null : "data/app.db"),
  table: (entry) => (entry.kind === "http" ? null : "t"),
  sql: () => null,
  path: (entry) => (entry.kind === "http" ? "/api/thing" : null),
};

/** Apply the one legal repair for a named field path. Returns true if it changed. */
function repairField(doc, fieldPath) {
  const m = /^dataExpectations\[(\d+)\]\.(\w+)$/.exec(fieldPath);
  if (m === null) return false;
  const entry = doc.dataExpectations?.[Number(m[1])];
  if (entry === undefined) return false;
  const fix = LEGAL[m[2]];
  if (fix === undefined) return false;
  const next = fix(entry);
  if (entry[m[2]] === next) return false;
  entry[m[2]] = next;
  return true;
}

export async function runReplay({ checkerOverride, corpusFile, withRounds = false } = {}) {
  const checker = await loadChecker(checkerOverride ?? process.env.REPLAY_CHECKER ?? undefined);
  const corpus = await loadCorpus(corpusFile === undefined ? {} : { expectationsFile: corpusFile });

  const arms = [
    {
      name: "corpus size",
      armed: corpus.cases.length > 0,
      detail: `${corpus.cases.length} case(s) declared`,
    },
    armChecker(checker),
    armFixtureIntegrity(),
    armFixturesDistinct(),
  ];

  const results = [];
  for (const c of corpus.cases) {
    if (c.manifest === null) {
      results.push({ id: c.id, verdict: "UNARMED", detail: c.unarmed });
      continue;
    }
    const r = checkManifest(checker, c.manifest);
    const fields = normaliseFieldPaths(r.collectAllFields);
    const signature = defectSignature(corpus.site, fields);
    const problems = [];
    const drift = [];

    const gotOutcome = r.accepted ? "accept" : "reject";
    if (gotOutcome !== c.expect) {
      problems.push(`outcome ${c.expect} -> ${gotOutcome}${r.failFast === null ? "" : ` (${r.failFast})`}`);
    }
    for (const want of c.expectFields ?? []) {
      if (!fields.includes(want)) problems.push(`validator no longer names ${want}`);
    }
    for (const got of fields) {
      if (!(c.expectFields ?? []).includes(got)) drift.push(`newly names ${got}`);
    }
    if (c.signature !== undefined && c.signature !== signature) {
      problems.push(`signature ${c.signature} -> ${signature}`);
    }
    if (c.expectFailFastMessage !== undefined && c.expectFailFastMessage !== r.failFast) {
      drift.push(`fail-fast message changed: ${JSON.stringify(r.failFast)}`);
    }

    const entry = {
      id: c.id,
      verdict: problems.length > 0 ? "FAIL" : drift.length > 0 ? "DRIFT" : "OK",
      outcome: gotOutcome,
      signature,
      fields,
      failFast: r.failFast,
      problems,
      drift,
    };
    if (withRounds && !r.accepted) {
      entry.rounds = {
        failFast: roundsToAccept(checker, c.manifest, "failFast"),
        collectAll: roundsToAccept(checker, c.manifest, "collectAll"),
      };
    }
    results.push(entry);
  }

  const blindArms = arms.filter((a) => !a.armed);
  const failed = results.filter((r) => r.verdict === "FAIL" || r.verdict === "UNARMED");
  return {
    at: new Date().toISOString(),
    checker: checker.identity,
    arms,
    results,
    ok: blindArms.length === 0 && failed.length === 0,
  };
}

function report(run) {
  console.log(`CHECKER REPLAY — ${run.at}`);
  console.log(`checker: ${run.checker.path}  ${run.checker.bytes} B  mtime ${run.checker.mtime}`);
  console.log(`         sha256 ${run.checker.sha256}`);
  console.log("");
  for (const a of run.arms) {
    console.log(`ARM CHECK: ${a.name} — ${a.armed ? "ARMED" : "BLIND"}: ${a.detail}`);
  }
  console.log("");
  for (const r of run.results) {
    if (r.verdict === "UNARMED") {
      console.log(`UNARMED  ${r.id}  ${r.detail}`);
      continue;
    }
    console.log(`${r.verdict.padEnd(7)}  ${r.id}  ${r.outcome}  ${r.signature}`);
    if (r.fields.length > 0) console.log(`           fields: ${r.fields.join(" | ")}`);
    for (const p of r.problems) console.log(`           FAIL: ${p}`);
    for (const d of r.drift) console.log(`           drift: ${d}`);
    if (r.rounds !== undefined) {
      console.log(
        `           rounds to accept (obedient seat): fail-fast ${r.rounds.failFast ?? "never"} | collect-all ${r.rounds.collectAll ?? "never"}  (budget 3)`,
      );
    }
  }
  console.log("");
  const blind = run.arms.filter((a) => !a.armed).length;
  const bad = run.results.filter((r) => r.verdict === "FAIL" || r.verdict === "UNARMED").length;
  console.log(
    `${run.results.length} case(s); ${bad} failing/unarmed; ${blind} blind arm(s). ${run.ok ? "PASS" : "FAIL"}`,
  );
  if (blind > 0) {
    console.log("REFUSING TO REPORT A PASS: an arm check is blind, so this run measured nothing.");
  }
}

async function main(argv) {
  const run = await runReplay({ withRounds: argv.includes("--rounds") });
  if (argv.includes("--json")) console.log(JSON.stringify(run, null, 2));
  else report(run);
  process.exit(run.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

export { REPO_ROOT };
