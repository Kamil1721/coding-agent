import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "./ruled-out.mjs";

const TMP = process.env.REPAIR_TEST_TMP ?? tmpdir();
const SIG = "b".repeat(64);
const dir = () => mkdtempSync(join(TMP, "repair-ledger-"));

test("ARM: an untouched ledger reads empty, so 'nothing was ruled out' is a real answer and not a missing file", () => {
  const d = dir();
  try {
    const l = openLedger(d);
    assert.deepEqual(l.read(SIG), []);
    assert.deepEqual(l.ruledOutFingerprints(SIG), []);
    assert.equal(existsSync(l.fileFor(SIG)), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a REFUSAL leaves a row: a refusal nobody can read is indistinguishable from a refusal that never ran", () => {
  const d = dir();
  try {
    const l = openLedger(d);
    l.append({ signature: SIG, verdict: "REFUSED", proposalFingerprint: "ff00", reasons: [{ code: "MISSING_EVIDENCE_MUTATION_RED", detail: "x" }], filesChanged: ["a.ts"] });
    const rows = l.read(SIG);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, "REFUSED");
    assert.equal(rows[0].reasons[0].code, "MISSING_EVIDENCE_MUTATION_RED");
    assert.match(rows[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(readFileSync(l.fileFor(SIG), "utf8"), /\n$/, "jsonl: one record per line");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the ledger is append-only: a later record never overwrites an earlier one", () => {
  const d = dir();
  try {
    const l = openLedger(d);
    l.append({ signature: SIG, verdict: "REFUSED", proposalFingerprint: "aaa" });
    l.append({ signature: SIG, verdict: "COULD_NOT_REPRODUCE", proposalFingerprint: "bbb" });
    l.append({ signature: SIG, verdict: "ACCEPTED", proposalFingerprint: "ccc" });
    assert.deepEqual(l.read(SIG).map((r) => r.verdict), ["REFUSED", "COULD_NOT_REPRODUCE", "ACCEPTED"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("only the repairs that did NOT clear the defect come back as ruled out", () => {
  const d = dir();
  try {
    const l = openLedger(d);
    l.append({ signature: SIG, verdict: "REFUSED", proposalFingerprint: "aaa" });
    l.append({ signature: SIG, verdict: "REFUSED", proposalFingerprint: "aaa" });
    l.append({ signature: SIG, verdict: "COULD_NOT_REPRODUCE", proposalFingerprint: "bbb" });
    l.append({ signature: SIG, verdict: "ACCEPTED", proposalFingerprint: "ccc" });
    assert.deepEqual(l.ruledOutFingerprints(SIG).sort(), ["aaa", "bbb"], "an accepted repair is not a ruled-out one, and duplicates collapse");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("records for different signatures never share a file", () => {
  const d = dir();
  const other = "c".repeat(64);
  try {
    const l = openLedger(d);
    l.append({ signature: SIG, verdict: "REFUSED", proposalFingerprint: "aaa" });
    l.append({ signature: other, verdict: "REFUSED", proposalFingerprint: "zzz" });
    assert.deepEqual(l.ruledOutFingerprints(SIG), ["aaa"]);
    assert.deepEqual(l.ruledOutFingerprints(other), ["zzz"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a signature that is not a hex digest is refused, so a record can never escape its directory", () => {
  const d = dir();
  try {
    const l = openLedger(d);
    assert.throws(() => l.append({ signature: "../../etc/passwd", verdict: "REFUSED" }), /not a hex digest/);
    assert.throws(() => l.read("no"), /not a hex digest/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
