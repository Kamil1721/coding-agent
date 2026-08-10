/**
 * The supervisor's repair entry point — and the negative control that matters.
 *
 * Every test here pairs a "something happened" with a "something visibly
 * different happened": the same defect record produces NO_PATCH_AUTHOR with no
 * diff, NO_SANDBOX with one, and ALREADY_RULED_OUT once the ledger says that diff
 * has failed before. An entry point that answered the same thing to all three
 * would be indistinguishable from one that never looked, which is the failure
 * class this repository has catalogued twenty-two times.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { proposalFingerprint } from "./evidence.mjs";
import { openLedger } from "./ruled-out.mjs";
import { armCheck, decideRepairOutcome, runSupervisorCycle } from "./supervisor-cycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "supervisor-cycle.mjs");
const SIG = "b3".repeat(32);
const DIFF = "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1 +1 @@\n-old\n+new\n";

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "supervisor-cycle-"));
  const paths = {
    dir,
    defect: path.join(dir, "results", "defect.json"),
    ledger: path.join(dir, "ruled-out"),
    proposals: path.join(dir, "proposals"),
  };
  mkdirSync(path.join(dir, "results"), { recursive: true });
  mkdirSync(paths.proposals, { recursive: true });
  writeFileSync(
    paths.defect,
    JSON.stringify({ runId: "run-x", signature: SIG, failureClass: "structural", phase: "spec" }, null, 2),
    "utf8",
  );
  return { ...paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the five outcomes are five different answers, and none of them is silent", () => {
  const cases = [
    { code: "NO_DEFECT_RECORD", input: { defect: null, diff: null, diffPath: "p", ruledOutFingerprints: [] } },
    {
      code: "NO_DEFECT_SIGNATURE",
      input: { defect: { signature: "nope" }, diff: null, diffPath: "p", ruledOutFingerprints: [] },
    },
    { code: "NO_PATCH_AUTHOR", input: { defect: { signature: SIG }, diff: null, diffPath: "p", ruledOutFingerprints: [] } },
    { code: "NO_SANDBOX", input: { defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [] } },
    {
      code: "ALREADY_RULED_OUT",
      input: {
        defect: { signature: SIG },
        diff: DIFF,
        diffPath: "p",
        ruledOutFingerprints: [proposalFingerprint({ diff: DIFF })],
      },
    },
  ];
  const details = new Set();
  for (const c of cases) {
    const got = decideRepairOutcome(c.input);
    assert.equal(got.code, c.code);
    assert.notEqual(got.detail.trim(), "", `${c.code} answered with a blank sentence`);
    details.add(got.detail);
  }
  assert.equal(details.size, cases.length, "two outcomes share a sentence, so the owner cannot tell them apart");

  // THE KIND MATTERS AS MUCH AS THE CODE, because the supervisor's router
  // branches on it: `refused` means the bar said no, `inconclusive` means no
  // verdict was reached, and conflating them would tell the owner a proposal was
  // graded when none was.
  assert.equal(decideRepairOutcome(cases[4].input).kind, "refused");
  assert.equal(decideRepairOutcome(cases[3].input).kind, "inconclusive");
});

test("with no candidate diff the answer is NO_PATCH_AUTHOR and the occurrence reaches the ledger", () => {
  const box = sandbox();
  try {
    const first = runSupervisorCycle({ defectPath: box.defect, ledgerDir: box.ledger, proposalsDir: box.proposals });
    assert.equal(first.code, "NO_PATCH_AUTHOR");
    assert.match(first.detail, /design §5\.3/);
    assert.match(first.detail, /\.diff/, "the sentence does not say where to put a diff");

    // A DECISION THAT RECORDS NOTHING IS A BRAKE THAT CANNOT FIRE THE SECOND
    // TIME. Two occurrences, two rows: "has this defect been here before" is a
    // file read, not a walk of every run directory.
    runSupervisorCycle({ defectPath: box.defect, ledgerDir: box.ledger, proposalsDir: box.proposals });
    const rows = openLedger(box.ledger).read(SIG);
    assert.equal(rows.length, 2, `the ledger holds ${rows.length} row(s) after two cycles`);
    assert.equal(rows[0].verdict, "NO_PATCH_AUTHOR");
    assert.equal(rows[0].reasons[0].code, "NO_PATCH_AUTHOR");
  } finally {
    box.cleanup();
  }
});

test("a diff the ledger has already failed is refused on sight, and a fresh one is not", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");

    // FRESH: not refused. Without this half the test would pass against a
    // component that refuses every proposal ever offered.
    const fresh = runSupervisorCycle({ defectPath: box.defect, ledgerDir: box.ledger, proposalsDir: box.proposals });
    assert.equal(fresh.code, "NO_SANDBOX");
    assert.equal(fresh.kind, "inconclusive");
    assert.equal(fresh.fingerprint, proposalFingerprint({ diff: DIFF }));

    // The row that first cycle wrote is itself what rules the fingerprint out, so
    // the second cycle over the identical diff must refuse it.
    const again = runSupervisorCycle({ defectPath: box.defect, ledgerDir: box.ledger, proposalsDir: box.proposals });
    assert.equal(again.code, "ALREADY_RULED_OUT");
    assert.equal(again.kind, "refused");
  } finally {
    box.cleanup();
  }
});

test("a run with no defect record on disk gets a named non-verdict, not a crash", () => {
  const box = sandbox();
  try {
    rmSync(box.defect);
    const got = runSupervisorCycle({ defectPath: box.defect, ledgerDir: box.ledger, proposalsDir: box.proposals });
    assert.equal(got.code, "NO_DEFECT_RECORD");
    // AND NOTHING WAS WRITTEN, because a ledger addressed by digest cannot record
    // a defect that has no digest.
    assert.deepEqual(openLedger(box.ledger).read(SIG), []);
  } finally {
    box.cleanup();
  }
});

test("the arm check is armed, and the process really answers one JSON line", () => {
  const arm = armCheck();
  assert.equal(arm.armed, true, arm.wrong.join("; "));
  assert.equal(arm.lines.length, 2);
  assert.match(arm.lines[1], /^ARM CHECK: armed/);

  // THE ENTRY POINT ITSELF, SPAWNED. Everything above tests exported functions;
  // this is the only assertion that the file the supervisor actually runs parses
  // its own arguments, prints exactly one JSON line, and exits 0.
  const box = sandbox();
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, "--defect", box.defect, "--ledger", box.ledger, "--proposals", box.proposals],
      { encoding: "utf8" },
    );
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 1, `the CLI printed ${lines.length} lines on stdout; the supervisor parses this stream`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.code, "NO_PATCH_AUTHOR");
    assert.equal(parsed.kind, "inconclusive");
    // And the spawned process wrote the row, so the ledger is not test-only.
    assert.equal(JSON.parse(readFileSync(openLedger(box.ledger).fileFor(SIG), "utf8").trim()).verdict, "NO_PATCH_AUTHOR");

    const armOut = execFileSync(process.execPath, [CLI, "--armcheck"], { encoding: "utf8" });
    assert.match(armOut, /ARM CHECK: armed/);
  } finally {
    box.cleanup();
  }
});
