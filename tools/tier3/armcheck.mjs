/**
 * TIER 3 — THE GATE'S OWN ARM CHECK. DESIGN §6.6, RUN AT S0, EVERY CYCLE.
 *
 * A GATE THAT ALWAYS PASSES IS INDISTINGUISHABLE FROM A HEALTHY SYSTEM. The
 * canonical local instance is `RUN-a913c871-observations.md:100-133` — *"the
 * watcher I built to catch Finding 1 had Finding 1's defect"*: it printed
 * `0.0% cpu, 38 MB`, an idle HTTP server, and *"would have printed a healthy
 * seat forever after the seat died."*
 *
 * So every arm is EXERCISED WHILE THE ANSWER IS KNOWN: the failure is planted,
 * the detector must report it, the plant is removed, and the detector must go
 * quiet again. An arm that only ever sees the healthy case is not an arm.
 *
 * A cycle whose arm-check block is absent is a cycle whose gate is unproven,
 * and `gate.mjs` treats absence exactly like failure.
 *
 * §6.6's A3 (re-score) and A4 (calibration replay) need a container. They are
 * REGISTERED AS UNARMED rather than omitted, and the two arms that replace
 * them here — the classifier arm and the trail-append arm — are host-runnable
 * and cover the two components most able to fail silently: a router stuck on
 * "self-apply", and a writer that overwrites its own evidence.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDiff } from "./closure.mjs";
import { buildFrozenManifest, verifyFrozenManifest } from "./manifest.mjs";
import { fixtureManifest } from "./fixture-g.mjs";
import { appendTrail } from "./trail.mjs";

function line(id, name, text, ok) {
  return `ARM CHECK ${id} ${name}: ${text} — ${ok ? "OK" : "BLIND"}`;
}

/**
 * A1 — the frozen-manifest verifier. Flip one byte in the isolated copy; the
 * verifier must report exactly that path. Restore; it must go quiet.
 */
export function armFrozenManifest({ repoRoot, isolatedRoot, isolatedPaths, closure }) {
  const target = isolatedPaths.find((p) => existsSync(join(isolatedRoot, p)));
  if (target === undefined) {
    return { id: "A1", ok: false, line: line("A1", "frozen-manifest", "no isolated file to plant a byte in", false) };
  }
  const manifest = buildFrozenManifest(repoRoot, { closure });
  const scoped = { ...manifest, entries: manifest.entries.filter((e) => isolatedPaths.includes(e.path)) };

  const before = verifyFrozenManifest(scoped, isolatedRoot);
  const abs = join(isolatedRoot, target);
  const original = readFileSync(abs);
  writeFileSync(abs, Buffer.concat([original, Buffer.from("\n")]));
  const planted = verifyFrozenManifest(scoped, isolatedRoot);
  writeFileSync(abs, original);
  const after = verifyFrozenManifest(scoped, isolatedRoot);

  const detected = planted.mismatches.filter((m) => m.path === target).length;
  const ok = before.ok && detected === 1 && planted.mismatches.length === 1 && after.ok;
  return {
    id: "A1",
    ok,
    detail: { target, detected, plantedMismatches: planted.mismatches.length, quietBefore: before.ok, quietAfter: after.ok },
    line: line(
      "A1",
      "frozen-manifest",
      `mismatch detected on ${String(detected)} planted byte (must be 1); clean before ${String(before.ok)}, clean after restore ${String(after.ok)}`,
      ok,
    ),
  };
}

/**
 * A2 — the manifest-reject corpus through the REAL `collectManifestProblems`.
 * Every case rejected NAMING ITS FIELD, and the valid manifest accepted with
 * an empty list. Any acceptance of a bad case, or any complaint about the good
 * one, and the collector is not discriminating.
 */
export async function armManifestReject({ repoRoot, distRoot }) {
  const protocol = await import(`file://${join(distRoot, "scorer-protocol.js")}`);
  const base = fixtureManifest(repoRoot);
  const cases = [
    { name: "a913c871 attempt 1 {entity,source,expectation}", expectations: [{ entity: "messages", source: "sqlite", expectation: "one row" }], mustName: "dataExpectations[0].id" },
    { name: "a913c871 attempt 3 {kind,method,path,...} — lost id", expectations: [{ kind: "http", method: "GET", path: "/api/messages", expectStatus: 200, description: "x" }], mustName: "dataExpectations[0].id" },
    { name: "sqlite with neither table nor sql", expectations: [{ id: "d", kind: "sqlite", file: "data/a.db", table: null, sql: null, path: null, minRows: 1 }], mustName: "dataExpectations[0]" },
    { name: "http with no path", expectations: [{ id: "d", kind: "http", file: null, table: null, sql: null, path: null, minRows: 1 }], mustName: "dataExpectations[0]" },
    { name: "minRows absent", expectations: [{ id: "d", kind: "sqlite", file: "data/a.db", table: "t", sql: null, path: null }], mustName: "dataExpectations[0].minRows" },
  ];

  let rejectedNamingField = 0;
  const misses = [];
  for (const c of cases) {
    const problems = protocol.collectManifestProblems({ ...base, dataExpectations: c.expectations });
    const named = problems.some((p) => String(p.field).startsWith(c.mustName));
    if (problems.length > 0 && named) rejectedNamingField += 1;
    else misses.push(`${c.name} → ${problems.length === 0 ? "ACCEPTED" : problems.map((p) => p.field).join(",")}`);
  }

  const good = protocol.collectManifestProblems(base);
  const ok = rejectedNamingField === cases.length && good.length === 0;
  return {
    id: "A2",
    ok,
    detail: { rejectedNamingField, cases: cases.length, validAccepted: good.length === 0, misses },
    line: line(
      "A2",
      "manifest-reject",
      `${String(rejectedNamingField)}/${String(cases.length)} rejected naming their field, ${good.length === 0 ? "1/1" : "0/1"} valid accepted (must be ${String(cases.length)}/${String(cases.length)} and 1/1)`,
      ok,
    ),
  };
}

/**
 * A3 — the fixture-G data expectation, TWO-SIDED. The hollow artefact must be
 * unsatisfied and the restored one satisfied by the SAME call. One side alone
 * proves nothing: a checker stuck on "unsatisfied" passes the hollow case for
 * ever.
 */
export async function armDataExpectation({ distRoot, pair }) {
  const tier0 = await import(`file://${join(distRoot, "tier0.js")}`);
  const hollow = await tier0.evaluateSqliteExpectation(pair.hollow, "db-query-7", "data/app.db", "messages", null, 1);
  const restored = await tier0.evaluateSqliteExpectation(pair.restored, "db-query-7", "data/app.db", "messages", null, 1);
  const ok = hollow.satisfied === false && restored.satisfied === true;
  return {
    id: "A3",
    ok,
    detail: { hollow: hollow.detail, restored: restored.detail },
    line: line(
      "A3",
      "data-expectation",
      `hollow satisfied=${String(hollow.satisfied)} (must be false), restored satisfied=${String(restored.satisfied)} (must be true)`,
      ok,
    ),
  };
}

/**
 * A4 — THE CLASSIFIER, and it is the arm most easily forgotten. A router stuck
 * on one answer is invisible: every patch routes somewhere, and "self-apply"
 * looks exactly like a healthy verdict. Three diffs with three known answers,
 * and the arm fails if they do not differ.
 */
export function armClassifier({ closure }) {
  const diffFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
  const inside = classifyDiff(diffFor("bakeoff/src/scorer.ts"), closure);
  const admission = classifyDiff(diffFor("bakeoff/test/tier3-fixtures/impossible/imp-002-nonexistent-table.json"), closure);
  const outside = classifyDiff(diffFor("bakeoff/test/quality-gating.e2e.mjs"), closure);
  const routes = [inside.route, admission.route, outside.route];
  const distinct = new Set(routes).size === 3;
  const ok =
    inside.route === "INSIDE-CLOSURE" && admission.route === "REFUSED" && outside.route === "OUTSIDE-CLOSURE" && distinct;
  return {
    id: "A4",
    ok,
    detail: { inside: inside.route, admission: admission.route, outside: outside.route },
    line: line(
      "A4",
      "classifier",
      `scorer.ts→${inside.route} impossible-set→${admission.route} bakeoff/test→${outside.route} (must be INSIDE-CLOSURE / REFUSED / OUTSIDE-CLOSURE, all distinct)`,
      ok,
    ),
  };
}

/**
 * A5 — the trail writer. Write one record, then attempt to overwrite it and
 * observe the refusal. This is the arm that closes the measured
 * `calibration-4a.mjs` gap: today, re-running until green is frictionless and
 * invisible for the most important measurement in the gate.
 */
export function armTrailAppend() {
  const dir = mkdtempSync(join(tmpdir(), "tier3-arm5-"));
  const record = { runStamp: "arm-check", change: "arm-check", at: new Date().toISOString(), verdict: "ARM" };
  const first = appendTrail(record, dir);
  const second = appendTrail(record, dir);
  const ok = first.ok === true && second.ok === false;
  return {
    id: "A5",
    ok,
    detail: { firstWrite: first.ok, overwriteRefused: second.ok === false, reason: second.reason ?? null },
    line: line("A5", "trail-append", `1 write accepted, ${second.ok === false ? "1" : "0"} overwrite refused on 1 attempt (must be >=1)`, ok),
  };
}

/** Container-only arms from §6.6, registered UNARMED rather than omitted. */
export function unarmedContainerArms() {
  return [
    {
      id: "A6",
      ok: null,
      line: "ARM CHECK A6 rescore: UNARMED — re-scoring run 1 with a nonexistent artefact needs the sealed image; docker is the Verify phase's",
    },
    {
      id: "A7",
      ok: null,
      line: "ARM CHECK A7 calibration: UNARMED — replaying the archived gutted suite needs ~32 s of container time",
    },
  ];
}

export async function runArmChecks(ctx) {
  const arms = [
    armFrozenManifest(ctx),
    await armManifestReject(ctx),
    await armDataExpectation(ctx),
    armClassifier(ctx),
    armTrailAppend(),
  ];
  const unarmed = unarmedContainerArms();
  const blind = arms.filter((a) => a.ok !== true);
  return {
    arms,
    unarmed,
    lines: [...arms.map((a) => a.line), ...unarmed.map((a) => a.line)],
    // FIVE ARMS, RE-DERIVED AND FLOORED. `blind.length === 0` is green on an
    // empty list, so the count is asserted too.
    armed: arms.length,
    ok: arms.length === 5 && blind.length === 0,
    blind: blind.map((a) => a.id),
  };
}
