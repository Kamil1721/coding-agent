/**
 * The supervisor's repair entry point — and the negative control that matters.
 *
 * Every test here pairs a "something happened" with a "something visibly
 * different happened": the same defect record produces NO_PATCH_AUTHOR with no
 * diff, NO_GATE_ANSWER with one and no gate, ALREADY_RULED_OUT once the ledger
 * says that diff has failed before, and — the point of the round — a DIFFERENT
 * terminal answer for each of the gate's verdicts. An entry point that answered
 * the same thing to all of them would be indistinguishable from one that never
 * looked, which is the failure class this repository has catalogued twenty-two
 * times.
 *
 * NO TEST IN THIS FILE RUNS THE REAL TIER 3 GATE. `spawnGate` builds a frozen
 * manifest, appends to an append-only trail and takes minutes; every test below
 * injects the gate as a seam and asserts on the record it hands back. The one
 * thing that is NOT faked is the tree: applying and reverting happen in a real
 * throwaway git repository, because a revert that has never been performed is a
 * promise and not a proof.
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { proposalFingerprint } from "./evidence.mjs";
import { openLedger } from "./ruled-out.mjs";
import { GATE_TIMEOUT_MS, armCheck, decideRepairOutcome, runSupervisorCycle } from "./supervisor-cycle.mjs";
import { revertGatedPatch } from "./supervisor-gate.mjs";
import { mintApplyToken } from "../tier3/proposal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "supervisor-cycle.mjs");
const GATE_CLI = path.join(HERE, "supervisor-gate.mjs");
const SIG = "b3".repeat(32);
const DIFF = "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1 +1 @@\n-old\n+new\n";

/** A gate seam that answers a fixed record and counts how often it was asked. */
function fakeGate(record, detail = "the injected gate") {
  const calls = [];
  return {
    calls,
    gate: (input) => {
      calls.push(input);
      return { record, detail };
    },
  };
}

/** The token the real gate would have minted for this record over this diff. */
function tokenFor(record, diff) {
  return mintApplyToken({
    frozenDigest: record.frozen.digest,
    diff,
    verdicts: {
      knownBad: record.knownBad.verdict,
      proofs: record.proofs.map((p) => `${p.id}:${String(p.satisfied)}`),
      arm: record.armCheck.ok,
    },
  });
}

function applyRecord(diff) {
  const record = {
    verdict: "APPLY",
    reason: "all four closure proofs held under container evidence",
    frozen: { digest: "e".repeat(64) },
    knownBad: { verdict: "PASS" },
    proofs: [{ id: "no-op-ablation-failing", satisfied: true }],
    armCheck: { ok: true, blind: [] },
  };
  return { ...record, applyToken: tokenFor(record, diff) };
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "supervisor-cycle-"));
  const paths = {
    dir,
    defect: path.join(dir, "results", "defect.json"),
    ledger: path.join(dir, "ruled-out"),
    proposals: path.join(dir, "proposals"),
    rollback: path.join(dir, "rollback"),
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

/**
 * A real git repository with one tracked file, so `git apply` has something to
 * apply to. `src/thing.mjs` matches DIFF's paths.
 */
function treeSandbox() {
  const box = sandbox();
  const root = path.join(box.dir, "tree");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "thing.mjs"), "old\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: root });
  return {
    ...box,
    root,
    read: () => readFileSync(path.join(root, "src", "thing.mjs"), "utf8"),
  };
}

test("the nine outcomes are nine different answers, and none of them is silent", () => {
  const cases = [
    { code: "NO_DEFECT_RECORD", input: { defect: null, diff: null, diffPath: "p", ruledOutFingerprints: [] } },
    {
      code: "NO_DEFECT_SIGNATURE",
      input: { defect: { signature: "nope" }, diff: null, diffPath: "p", ruledOutFingerprints: [] },
    },
    { code: "NO_PATCH_AUTHOR", input: { defect: { signature: SIG }, diff: null, diffPath: "p", ruledOutFingerprints: [] } },
    { code: "NO_GATE_ANSWER", input: { defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [] } },
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

  // The remaining four arms are the ones the arm check itself drives; this is the
  // assertion that the arm check is not measuring a smaller router than production.
  const arm = armCheck();
  assert.equal(arm.armed, true, arm.wrong.join("; "));
  assert.equal(arm.probes, 9);
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
    // The gate REFUSES this proposal, which is what puts the fingerprint in the
    // ledger; without a refusal there would be nothing to rule out.
    const refusing = fakeGate({ verdict: "REFUSE", reason: "the known-bad set did not hold" });

    // FRESH: not refused on sight — it reaches the gate. Without this half the
    // test would pass against a component that refuses every proposal ever
    // offered.
    const fresh = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      repoRoot: box.dir,
      gate: refusing.gate,
    });
    assert.equal(fresh.code, "GATE_REFUSE");
    assert.equal(fresh.kind, "refused");
    assert.equal(fresh.fingerprint, proposalFingerprint({ diff: DIFF }));
    assert.equal(refusing.calls.length, 1, "the fresh proposal never reached the gate");

    // The row that first cycle wrote is itself what rules the fingerprint out, so
    // the second cycle over the identical diff must refuse it — WITHOUT asking the
    // gate again. That is the whole value of the ledger: the expensive step is
    // skipped, not merely repeated with the same answer.
    const again = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      repoRoot: box.dir,
      gate: refusing.gate,
    });
    assert.equal(again.code, "ALREADY_RULED_OUT");
    assert.equal(again.kind, "refused");
    assert.equal(refusing.calls.length, 1, "the ruled-out proposal was sent to the gate a second time");
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

/* ---------------------------------------------------------------------------
 * THE GATE DECIDES — one test per verdict, and the tree is the assertion
 * ------------------------------------------------------------------------ */

test("each gate verdict routes to its own answer, and only the tokened APPLY touches the tree", () => {
  const cases = [
    {
      label: "APPLY with a token that verifies",
      record: (diff) => applyRecord(diff),
      code: "GATE_APPLY",
      kind: "applied",
      patched: true,
      ledgerVerdict: "ACCEPTED",
    },
    {
      label: "APPLY with no token at all",
      record: () => ({ ...applyRecord(DIFF), applyToken: undefined }),
      code: "GATE_APPLY_UNTOKENED",
      kind: "refused",
      patched: false,
      ledgerVerdict: "REFUSED",
    },
    {
      label: "APPLY with a token minted over a different diff",
      record: () => applyRecord("--- a/other\n+++ b/other\n@@ -1 +1 @@\n-x\n+y\n"),
      code: "GATE_APPLY_UNTOKENED",
      kind: "refused",
      patched: false,
      ledgerVerdict: "REFUSED",
    },
    {
      label: "SELF-PROPOSE",
      record: () => ({ verdict: "SELF-PROPOSE", reason: "a required proof is not satisfied" }),
      code: "GATE_SELF_PROPOSE",
      kind: "inconclusive",
      patched: false,
      ledgerVerdict: "COULD_NOT_REPRODUCE",
    },
    {
      label: "REFUSE-BLIND",
      record: () => ({ verdict: "REFUSE-BLIND", reason: "the gate cannot be shown to fail", armCheck: { ok: false, blind: ["A6-rescore", "A3-known-bad"] } }),
      code: "GATE_BLIND",
      kind: "inconclusive",
      patched: false,
      ledgerVerdict: "COULD_NOT_REPRODUCE",
    },
    {
      label: "REFUSE",
      record: () => ({ verdict: "REFUSE", reason: "the known-bad set did not hold" }),
      code: "GATE_REFUSE",
      kind: "refused",
      patched: false,
      ledgerVerdict: "REFUSED",
    },
    {
      label: "REFUSED at admission",
      record: () => ({ verdict: "REFUSED", reason: "the diff touches the admission set" }),
      code: "GATE_REFUSED_ADMISSION",
      kind: "refused",
      patched: false,
      ledgerVerdict: "REFUSED",
    },
    {
      label: "no record at all — the gate never answered",
      record: () => null,
      code: "NO_GATE_RECORD",
      kind: "inconclusive",
      patched: false,
      ledgerVerdict: "COULD_NOT_REPRODUCE",
    },
  ];

  const codes = new Set();
  for (const c of cases) {
    const box = treeSandbox();
    try {
      writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");
      const gate = fakeGate(c.record(DIFF));
      const got = runSupervisorCycle({
        defectPath: box.defect,
        ledgerDir: box.ledger,
        proposalsDir: box.proposals,
        rollbackDir: box.rollback,
        repoRoot: box.root,
        gate: gate.gate,
      });
      assert.equal(got.code, c.code, c.label);
      assert.equal(got.kind, c.kind, c.label);
      assert.notEqual(got.detail.trim(), "", `${c.label} answered with a blank sentence`);
      codes.add(got.code);

      // THE TREE IS THE ASSERTION, NOT THE RETURN VALUE. A router that said
      // "refused" and patched anyway would satisfy every check above.
      assert.equal(
        box.read(),
        c.patched ? "new\n" : "old\n",
        `${c.label}: the tree is ${box.read().trim()} and should be ${c.patched ? "new" : "old"}`,
      );

      const rows = openLedger(box.ledger).read(SIG);
      assert.equal(rows.length, 1, `${c.label} wrote ${rows.length} ledger rows`);
      assert.equal(rows[0].verdict, c.ledgerVerdict, c.label);
    } finally {
      box.cleanup();
    }
  }
  // SEVEN, NOT EIGHT: the two untokened APPLY records share `GATE_APPLY_UNTOKENED`
  // deliberately — "no token" and "a token minted over another diff" are the same
  // fact about authority, and `decideApply` is explicit that the caller skipping
  // the gate and the gate refusing must be indistinguishable.
  assert.equal(codes.size, 7, `the eight gate answers collapsed into ${codes.size} code(s)`);
});

test("A GATE THAT CANNOT SEE DOES NOT BECOME A GATE THAT AGREES: blind parks the patch and does not rule it out", () => {
  const box = treeSandbox();
  try {
    writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");
    const blind = fakeGate({
      verdict: "REFUSE-BLIND",
      reason: "arm A6-rescore did not report",
      armCheck: { ok: false, blind: ["A6-rescore"] },
    });
    const first = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.root,
      gate: blind.gate,
    });
    assert.equal(first.kind, "inconclusive");
    assert.equal(first.code, "GATE_BLIND");
    // WHICH ARMS COULD NOT RUN, BY NAME. "Inconclusive" without the arm names is
    // unactionable at 3am.
    assert.match(first.detail, /A6-rescore/);
    assert.match(first.detail, /docker/i);
    assert.equal(box.read(), "old\n", "a blind gate was allowed to patch the tree");

    /*
     * AND THE PROPOSAL IS STILL PROPOSABLE. A patch parked for want of docker is
     * not a patch that failed; writing its fingerprint to the ruled-out ledger
     * would refuse it for ever on a machine that later HAS docker. So the row
     * exists (a refusal that leaves no row is indistinguishable from one that
     * never ran) and it carries NO fingerprint.
     */
    assert.equal(first.fingerprint, null);
    const rows = openLedger(box.ledger).read(SIG);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].proposalFingerprint, null);
    assert.deepEqual(openLedger(box.ledger).ruledOutFingerprints(SIG), []);

    // THE NEGATIVE HALF: the same diff, through the same cycle, with a gate that
    // CAN see, does reach a verdict. So the park above is about the gate's
    // blindness and not about this cycle refusing everything.
    const seeing = fakeGate(applyRecord(DIFF));
    const second = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.root,
      gate: seeing.gate,
    });
    assert.equal(second.kind, "applied");
    assert.equal(box.read(), "new\n");
  } finally {
    box.cleanup();
  }
});

test("AN APPLIED PATCH IS REVERTIBLE WITHOUT A HUMAN, and a revert of nothing says so", () => {
  const box = treeSandbox();
  try {
    writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.root,
      gate: gate.gate,
    });
    assert.equal(got.kind, "applied");
    assert.equal(box.read(), "new\n");

    // THE ROLLBACK POINT IS RECORDED, and it is what the revert reads. Nothing
    // about the revert consults the proposals directory or the gate again.
    assert.equal(typeof got.rollbackPath, "string");
    assert.ok(existsSync(got.rollbackPath), `no rollback record at ${String(got.rollbackPath)}`);
    const record = JSON.parse(readFileSync(got.rollbackPath, "utf8"));
    assert.equal(record.patchId, got.patchId);
    assert.equal(record.signature, SIG);
    assert.equal(record.diff, DIFF);
    assert.match(String(record.sourceSha), /^[0-9a-f]{40}$/, "the rollback point names no source commit");

    const reverted = revertGatedPatch({ rollbackPath: got.rollbackPath });
    assert.equal(reverted.ok, true, reverted.detail);
    assert.equal(box.read(), "old\n", "the revert reported success and the bytes did not come back");

    // NEGATIVE CONTROL: reverting again is a NAMED refusal, not a second silent
    // success. Without this half a `revertGatedPatch` that did nothing at all and
    // returned ok would pass the assertion above on a tree that was never patched.
    const twice = revertGatedPatch({ rollbackPath: got.rollbackPath });
    assert.equal(twice.ok, false);
    assert.equal(twice.code, "REVERT_NOT_APPLIED");
    assert.equal(revertGatedPatch({ rollbackPath: path.join(box.rollback, "nope.json") }).code, "NO_ROLLBACK_RECORD");
  } finally {
    box.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * THE REMEDIATION SENTENCE NAMES A COMMAND THAT EXISTS.
 *
 * `supervisor-boot.ts` appends "run: node tools/repair/supervisor-gate.mjs
 * --revert <rollbackPath>" to every applied outcome. Until this round that flag did
 * not exist: the script's CLI ran `armCheck()` and nothing else, so the sentence
 * the owner reads at 3am named a command whose real effect was to print an arm
 * check and exit 0 — the most dangerous possible answer, because it LOOKS like the
 * revert worked.
 * ------------------------------------------------------------------------- */
test("the CLI --revert arm really reverts, and its three refusals are named rather than thrown", () => {
  const box = treeSandbox();
  try {
    writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");
    const got = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.root,
      gate: fakeGate(applyRecord(DIFF)).gate,
    });
    assert.equal(got.kind, "applied");
    assert.equal(box.read(), "new\n");

    const revert = (args) => {
      const res = spawnSync(process.execPath, [GATE_CLI, ...args], { encoding: "utf8" });
      return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
    };

    const first = revert(["--revert", got.rollbackPath]);
    assert.equal(first.status, 0, `the CLI refused to revert its own rollback record: ${first.out}`);
    assert.match(first.out, /^REVERTED: /);
    assert.equal(box.read(), "old\n", "the CLI said REVERTED and the bytes did not come back");

    /*
     * THE NEGATIVE CONTROLS, AND THE FIRST ONE IS THE MUTATION THAT MATTERS. A CLI
     * with NO `--revert` arm falls through to `armCheck()`, which is armed on this
     * machine and exits 0 — so "exit 0" alone cannot tell a revert from an arm
     * check. Each refusal is therefore checked BY CODE and by a non-zero exit.
     */
    const twice = revert(["--revert", got.rollbackPath]);
    assert.equal(twice.status, 1, `reverting twice exited ${String(twice.status)}: ${twice.out}`);
    assert.match(twice.out, /^REVERT_NOT_APPLIED: /);

    const missing = revert(["--revert", path.join(box.rollback, "nope.json")]);
    assert.equal(missing.status, 1);
    assert.match(missing.out, /^NO_ROLLBACK_RECORD: /);

    const blank = revert(["--revert"]);
    assert.equal(blank.status, 1, "a --revert with no path printed an arm check and exited 0");
    assert.match(blank.out, /^NO_ROLLBACK_RECORD: /);

    // AND THE OTHER ARM STILL WORKS: `--armcheck` is not broken by the new branch.
    const arm = spawnSync(process.execPath, [GATE_CLI, "--armcheck"], { encoding: "utf8" });
    assert.equal(arm.status, 0, arm.stdout + arm.stderr);
    assert.match(arm.stdout, /ARM CHECK: armed/);
  } finally {
    box.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * THE INNER CLOCK FIRES FIRST, OR A HANGING GATE IS ORPHANED EVERY TIME.
 *
 * MEASURED 2026-08-10: both clocks were ten minutes and the OUTER one starts
 * first, so a hanging gate was always killed from outside — and `spawnSync`
 * signals the child only, with no `detached: true` and no process-group kill on
 * either path, so `gate.mjs` survived, kept writing `dashboard/data/tier3`, and on
 * a machine with docker kept holding containers, while the supervisor had already
 * filed the ticket as REPAIR_CYCLE_TIMED_OUT and moved on.
 * ------------------------------------------------------------------------- */
test("the gate's own clock is strictly shorter than the supervisor's, so the outer kill is the fail-safe and not the normal path", () => {
  const bootSrc = readFileSync(path.join(HERE, "..", "..", "dashboard", "server", "src", "supervisor-boot.ts"), "utf8");
  const m = /REPAIR_CYCLE_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*([\d_]+);/.exec(bootSrc);
  assert.ok(m !== null, "the supervisor's outer bound is no longer readable from supervisor-boot.ts, so this inequality cannot be checked at all");
  const outer = Number(m[1]) * Number(m[2]) * Number(m[3].replace(/_/g, ""));
  assert.ok(outer > 0, `the outer bound read as ${String(outer)}`);
  assert.ok(
    GATE_TIMEOUT_MS < outer,
    `the gate's clock (${String(GATE_TIMEOUT_MS)}ms) is not shorter than the supervisor's (${String(outer)}ms), so a hanging ` +
      "gate is killed from the outside first and orphaned: nothing on either path kills a process group",
  );
  // AND THE GAP IS NOT COSMETIC: a gate killed one millisecond before its parent
  // has not been given time to write its trail row and exit.
  assert.ok(outer - GATE_TIMEOUT_MS >= 60_000, `only ${String(outer - GATE_TIMEOUT_MS)}ms separates the two clocks`);
});

test("THE BOUNDS STOP A CYCLE THAT WILL NOT CONVERGE, and each bound is spent before the gate is", () => {
  // 1. THE WALL CLOCK. A cycle whose window has already closed does not spend a
  //    gate run on a ticket the supervisor is about to terminate.
  const closed = treeSandbox();
  try {
    writeFileSync(path.join(closed.proposals, `${SIG}.diff`), DIFF, "utf8");
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: closed.defect,
      ledgerDir: closed.ledger,
      proposalsDir: closed.proposals,
      rollbackDir: closed.rollback,
      repoRoot: closed.root,
      gate: gate.gate,
      deadlineAt: "2026-08-10T00:00:00.000Z",
      now: () => new Date("2026-08-10T00:00:01.000Z"),
    });
    assert.equal(got.code, "REPAIR_WINDOW_CLOSED");
    assert.equal(gate.calls.length, 0, "a closed window still spent a gate run");
    assert.equal(closed.read(), "old\n");

    // NEGATIVE HALF: the same everything with the deadline in the FUTURE does run
    // the gate, so the bound is a clock comparison and not a refusal to work.
    const open = fakeGate(applyRecord(DIFF));
    const ok = runSupervisorCycle({
      defectPath: closed.defect,
      ledgerDir: closed.ledger,
      proposalsDir: closed.proposals,
      rollbackDir: closed.rollback,
      repoRoot: closed.root,
      gate: open.gate,
      deadlineAt: "2026-08-10T01:00:00.000Z",
      now: () => new Date("2026-08-10T00:00:01.000Z"),
    });
    assert.equal(open.calls.length, 1);
    assert.equal(ok.kind, "applied");
  } finally {
    closed.cleanup();
  }

  // 2. THE ANTI-LOOP RULE, WHICH IS SIGNATURE COMPARISON AND NOT COUNTING. The
  //    a913c871 sequence never exceeded its budget; it escalates here because the
  //    reported violation set went DISJOINT at attempt 2 and came back at 3.
  const looping = treeSandbox();
  try {
    writeFileSync(
      looping.defect,
      JSON.stringify({
        runId: "run-x",
        signature: SIG,
        failureClass: "structural",
        attempts: [
          { n: 1, at: "t1", violations: ["dataExpectations[0].id"] },
          { n: 2, at: "t2", violations: ["dataExpectations[0].kind"] },
          { n: 3, at: "t3", violations: ["dataExpectations[0].id"] },
        ],
      }),
      "utf8",
    );
    writeFileSync(path.join(looping.proposals, `${SIG}.diff`), DIFF, "utf8");
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: looping.defect,
      ledgerDir: looping.ledger,
      proposalsDir: looping.proposals,
      rollbackDir: looping.rollback,
      repoRoot: looping.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "ANTI_LOOP_NON_MONOTONE");
    assert.equal(got.kind, "refused");
    assert.equal(gate.calls.length, 0, "a non-convergent sequence still spent a gate run");
    assert.equal(looping.read(), "old\n");
    // The escalation is about the SEQUENCE, so it must not rule out a diff nobody
    // graded — that would refuse a good patch for ever on the next occurrence.
    assert.equal(got.fingerprint, null);
    assert.deepEqual(openLedger(looping.ledger).ruledOutFingerprints(SIG), []);
    assert.equal(openLedger(looping.ledger).read(SIG)[0].verdict, "ESCALATED");
  } finally {
    looping.cleanup();
  }

  // 3. THE NEGATIVE CONTROL FOR THE SAME ARM: a SHRINKING sequence — what a
  //    working feedback channel produces — walks past it and reaches the gate. A
  //    comparator that escalates on everything would terminate every repairing
  //    ticket with a convincing sentence and repair nothing, ever.
  const shrinking = treeSandbox();
  try {
    writeFileSync(
      shrinking.defect,
      JSON.stringify({
        runId: "run-x",
        signature: SIG,
        failureClass: "structural",
        attempts: [
          { n: 1, at: "t1", violations: ["a.id", "a.kind"] },
          { n: 2, at: "t2", violations: ["a.id"] },
        ],
      }),
      "utf8",
    );
    writeFileSync(path.join(shrinking.proposals, `${SIG}.diff`), DIFF, "utf8");
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: shrinking.defect,
      ledgerDir: shrinking.ledger,
      proposalsDir: shrinking.proposals,
      rollbackDir: shrinking.rollback,
      repoRoot: shrinking.root,
      gate: gate.gate,
    });
    assert.equal(gate.calls.length, 1, "a converging sequence was escalated instead of graded");
    assert.equal(got.kind, "applied");
  } finally {
    shrinking.cleanup();
  }
});

test("THE TOKEN FORMULA IS PINNED AGAINST THE GATE'S OWN MINT, because a self-consistent arm check cannot see the drift", () => {
  /*
   * WHAT NO OTHER TEST HERE CAN SEE. `armApplyRecord` mints with
   * `mintApplyToken(tokenInputs(record, diff))` and `classifyGateRecord` verifies
   * with `decideApply({ ...tokenInputs(record, diff) })` — the SAME function on
   * both sides, so the pair is self-consistent by construction. If `tokenInputs`
   * read `record.frozenDigest` instead of `record.frozen.digest`, every probe
   * would still pass, the arm check would report armed, and production would
   * answer GATE_APPLY_UNTOKENED for every patch the gate ever approved. Silently,
   * for ever.
   *
   * SO THE OTHER SIDE OF THE CONTRACT IS READ FROM `gate.mjs`'s SOURCE. The two
   * files are in different lanes with no shared type, which is exactly how a
   * contract drifts while both suites stay green.
   */
  const gateSrc = readFileSync(path.join(HERE, "..", "tier3", "gate.mjs"), "utf8");
  const mintAt = gateSrc.indexOf("mintApplyToken({");
  assert.ok(mintAt > -1, "gate.mjs no longer mints an apply token the way this seam expects");
  const mintBody = gateSrc.slice(mintAt, gateSrc.indexOf("})", mintAt));

  // The four inputs the token digests, and the record field each one must survive
  // into. Left side: what `runGate` mints over. Right side: what `tokenInputs`
  // reads back off the record it wrote.
  const contract = [
    { mints: /frozenDigest:\s*manifest\.digest/, reads: /frozenDigest:\s*str\(record\?\.frozen\?\.digest\)/ },
    { mints: /knownBad:\s*aggregate\.verdict/, reads: /knownBad:\s*record\?\.knownBad\?\.verdict/ },
    { mints: /proofs:\s*proofs\.map\(\(p\) => `\$\{p\.id\}:\$\{String\(p\.satisfied\)\}`\)/, reads: /\(record\?\.proofs \?\? \[\]\)\.map\(\(p\) => `\$\{String\(p\?\.id\)\}:\$\{String\(p\?\.satisfied\)\}`\)/ },
    { mints: /arm:\s*arm\.ok/, reads: /arm:\s*record\?\.armCheck\?\.ok/ },
  ];
  const seamSrc = readFileSync(path.join(HERE, "supervisor-gate.mjs"), "utf8");
  for (const pair of contract) {
    assert.match(mintBody, pair.mints, `gate.mjs stopped minting over ${String(pair.mints)}; the seam's re-mint will never match again`);
    assert.match(seamSrc, pair.reads, `supervisor-gate.mjs stopped reading ${String(pair.reads)} off the record; every APPLY becomes GATE_APPLY_UNTOKENED`);
  }
  // AND THE DIFF ITSELF, which is the input that makes the token specific to one
  // patch rather than to one gate cycle.
  assert.match(mintBody, /diff:\s*proposal\.diff/, "the token is no longer minted over the diff, so one token would authorise any patch");

  // NEGATIVE HALF: the pinning above is regex over source, so it must be shown to
  // FAIL on a wrong formula rather than merely to pass on the right one.
  assert.doesNotMatch(mintBody, /frozenDigest:\s*manifest\.sha/, "this assertion cannot distinguish the right formula from a wrong one");
});

test("the arm check is armed, and the process really answers one JSON line", () => {
  const arm = armCheck();
  assert.equal(arm.armed, true, arm.wrong.join("; "));
  assert.match(arm.lines[arm.lines.length - 1], /^ARM CHECK: armed/);
  // The gate seam's own lines travel with it: this file's blindness includes the
  // blindness of the thing it delegates the verdict to.
  assert.ok(
    arm.lines.some((l) => /gate-verdict router/.test(l)),
    "the entry point's arm check says nothing about the gate seam it depends on",
  );

  // THE ENTRY POINT ITSELF, SPAWNED. Everything above tests exported functions;
  // this is the only assertion that the file the supervisor actually runs parses
  // its own arguments, prints exactly one JSON line, and exits 0.
  //
  // IT USES A DEFECT WITH NO CANDIDATE DIFF ON PURPOSE, so the real gate is never
  // reached: `spawnGate` builds a frozen manifest and appends to an append-only
  // trail, and a test that did that would be writing to the owner's Tier 3 record.
  const box = sandbox();
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, "--defect", box.defect, "--ledger", box.ledger, "--proposals", box.proposals, "--rollback", box.rollback],
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
