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
 *
 * THE EVIDENCE BAR IS THE OTHER SEAM, AND IT IS NOT FAKED EVERYWHERE. The gate
 * tests below inject `bar` for the same reason they inject `gate` — the real bar
 * copies HEAD and runs a reproduction command three times per case, which no
 * per-verdict unit test may do. But the four tests under THE EVIDENCE BAR at the
 * bottom of this file pass NO `bar` key at all: they build a real git repository
 * whose recorded command really fails, really passes under the patch, and really
 * fails again under a revert of it. A seam every test injects is a seam whose
 * production default nothing ever executes.
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { proposalFingerprint } from "./evidence.mjs";
import { openLedger } from "./ruled-out.mjs";
import { isolateRepairRoot } from "./isolate.mjs";
import {
  GATE_TIMEOUT_MS,
  MAX_PROVED_RUNS,
  MIN_COMMAND_TIMEOUT_MS,
  PROVE_BUDGET_MS,
  armCheck,
  classifyBarResult,
  decideRepairOutcome,
  runEvidenceBar,
  runSupervisorCycle,
} from "./supervisor-cycle.mjs";
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

/**
 * An evidence-bar seam that clears every diff and counts how often it was asked.
 *
 * IT CANNOT REACH `applied` ON ITS OWN, which is why injecting it is safe: a bar
 * answering `ok` buys exactly one gate run, and the gate still has to return APPLY
 * with a token that re-mints over this diff before `applyGatedPatch` will write
 * anything. Every test that uses this one also asserts on the gate's answer.
 */
function fakeBar(answer = { ok: true }) {
  const calls = [];
  return {
    calls,
    bar: (input) => {
      calls.push(input);
      return answer;
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

test("the outcomes are all different answers, and none of them is silent", () => {
  const cases = [
    { code: "NO_DEFECT_RECORD", input: { defect: null, diff: null, diffPath: "p", ruledOutFingerprints: [] } },
    {
      code: "NO_DEFECT_SIGNATURE",
      input: { defect: { signature: "nope" }, diff: null, diffPath: "p", ruledOutFingerprints: [] },
    },
    { code: "NO_PATCH_AUTHOR", input: { defect: { signature: SIG }, diff: null, diffPath: "p", ruledOutFingerprints: [] } },
    // THE BAR COMES BEFORE THE GATE, so a diff with no bar answer is not an
    // ungraded patch — it is an UNPROVED one, and it says so with its own code.
    { code: "NO_EVIDENCE_BAR_ANSWER", input: { defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [] } },
    { code: "NO_GATE_ANSWER", input: { defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [], bar: { ok: true } } },
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
  assert.equal(decideRepairOutcome(cases[5].input).kind, "refused");
  assert.equal(decideRepairOutcome(cases[4].input).kind, "inconclusive");
  assert.equal(decideRepairOutcome(cases[3].input).kind, "inconclusive");

  // The remaining arms are the ones the arm check itself drives; this is the
  // assertion that the arm check is not measuring a smaller router than production.
  const arm = armCheck();
  assert.equal(arm.armed, true, arm.wrong.join("; "));
  assert.equal(arm.probes, 12);
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
    const cleared = fakeBar();

    // FRESH: not refused on sight — it reaches the gate. Without this half the
    // test would pass against a component that refuses every proposal ever
    // offered.
    const fresh = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      repoRoot: box.dir,
      bar: cleared.bar,
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
      bar: cleared.bar,
      gate: refusing.gate,
    });
    assert.equal(again.code, "ALREADY_RULED_OUT");
    assert.equal(again.kind, "refused");
    assert.equal(refusing.calls.length, 1, "the ruled-out proposal was sent to the gate a second time");
    // AND THE LEDGER IS CONSULTED BEFORE THE BAR IS, not only before the gate: the
    // bar is the second most expensive step in the file and a known-failed diff
    // must not buy a copy of HEAD and three command runs either.
    assert.equal(cleared.calls.length, 1, "the ruled-out proposal was proved a second time");
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
        bar: fakeBar().bar,
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
      bar: fakeBar().bar,
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
      bar: fakeBar().bar,
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
      bar: fakeBar().bar,
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
      bar: fakeBar().bar,
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
    const bar = fakeBar();
    const got = runSupervisorCycle({
      defectPath: closed.defect,
      ledgerDir: closed.ledger,
      proposalsDir: closed.proposals,
      rollbackDir: closed.rollback,
      repoRoot: closed.root,
      bar: bar.bar,
      gate: gate.gate,
      deadlineAt: "2026-08-10T00:00:00.000Z",
      now: () => new Date("2026-08-10T00:00:01.000Z"),
    });
    assert.equal(got.code, "REPAIR_WINDOW_CLOSED");
    assert.equal(gate.calls.length, 0, "a closed window still spent a gate run");
    // AND NOT A BAR CYCLE EITHER. The bar copies HEAD and runs the reproduction
    // three times; spending that on a ticket the supervisor is about to terminate
    // is the same waste one stage earlier.
    assert.equal(bar.calls.length, 0, "a closed window still spent a bar cycle");
    assert.equal(closed.read(), "old\n");

    // NEGATIVE HALF: the same everything with the deadline in the FUTURE does run
    // the gate, so the bound is a clock comparison and not a refusal to work.
    const open = fakeGate(applyRecord(DIFF));
    const openBar = fakeBar();
    const ok = runSupervisorCycle({
      defectPath: closed.defect,
      ledgerDir: closed.ledger,
      proposalsDir: closed.proposals,
      rollbackDir: closed.rollback,
      repoRoot: closed.root,
      bar: openBar.bar,
      gate: open.gate,
      deadlineAt: "2026-08-10T01:00:00.000Z",
      now: () => new Date("2026-08-10T00:00:01.000Z"),
    });
    assert.equal(openBar.calls.length, 1);
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
    const bar = fakeBar();
    const got = runSupervisorCycle({
      defectPath: looping.defect,
      ledgerDir: looping.ledger,
      proposalsDir: looping.proposals,
      rollbackDir: looping.rollback,
      repoRoot: looping.root,
      bar: bar.bar,
      gate: gate.gate,
    });
    assert.equal(got.code, "ANTI_LOOP_NON_MONOTONE");
    assert.equal(got.kind, "refused");
    assert.equal(gate.calls.length, 0, "a non-convergent sequence still spent a gate run");
    assert.equal(bar.calls.length, 0, "a non-convergent sequence still spent a bar cycle");
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
    const bar = fakeBar();
    const got = runSupervisorCycle({
      defectPath: shrinking.defect,
      ledgerDir: shrinking.ledger,
      proposalsDir: shrinking.proposals,
      rollbackDir: shrinking.rollback,
      repoRoot: shrinking.root,
      bar: bar.bar,
      gate: gate.gate,
    });
    assert.equal(bar.calls.length, 1, "a converging sequence was escalated instead of proved");
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

/* ===========================================================================
 * THE EVIDENCE BAR — no seam is injected below this line
 *
 * `tools/repair/cycle.mjs#runRepairCycle` — reproduce, prove, replay
 * independently, validate, record — had exactly one caller in the tree before
 * this round: `arm.mjs`, its own arm check. The supervisor's real path built a
 * proposal out of a hand-authored diff and handed it to the Tier 3 gate, so a
 * candidate patch reached the gate having never been watched failing or passing
 * anything. Everything below runs the real bar over a real git repository whose
 * recorded command really goes red, then green, then red again.
 * ======================================================================== */

const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Red on `old`, green on `new`. Not the same string as any replay case below. */
const REPRO_COMMAND = "grep -q '^new$' src/thing.mjs";

/**
 * A tree the bar can really prove a patch on, plus a defect record that names the
 * commands. `reproduction` is an extension the record writer does not produce yet
 * (measured 2026-08-12: `DefectRecord` has no such field and none of the 7
 * records under `dashboard/runs` carries one) — which is exactly why the ACCEPT
 * arm has to be driven here, or it would be a path no test ever takes.
 */
function barSandbox(reproduction = {}) {
  const box = treeSandbox();
  writeFileSync(
    box.defect,
    JSON.stringify({
      runId: "run-x",
      signature: SIG,
      failureClass: "structural",
      phase: "spec",
      artefacts: ["src/thing.mjs"],
      reproduction: {
        command: REPRO_COMMAND,
        cases: [
          // TARGETED, VIA A DIFFERENT INPUT than the reproduction: exit 1 -> 0.
          { name: "targeted-via-another-input", command: 'test "$(cat src/thing.mjs)" = new', targeted: true },
          // UNRELATED recorded behaviour: exit 0 both sides, and it must stay 0.
          { name: "unrelated-recorded-input", command: "test -f src/thing.mjs" },
        ],
        ...reproduction,
      },
    }),
    "utf8",
  );
  writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");
  return box;
}

/* ---------------------------------------------------------------------------
 * 1. A DIFF THAT DOES NOT CLEAR THE BAR NEVER REACHES THE GATE.
 *
 * Two ways to fail it, and they must not answer the same thing: the recorded
 * command still fails with the patch applied (the patch does not work), and the
 * recorded command PASSES on the unpatched tree (there was nothing to repair, and
 * `prover.mjs` refuses to grade a patch for a defect nobody reproduced).
 * ------------------------------------------------------------------------ */
test("a candidate diff that does not reproduce-and-fix the defect never reaches the gate", () => {
  const cases = [
    {
      label: "the command is still red with the patch applied",
      // Nothing in the tree ever matches, so red before and red after.
      reproduction: { command: "grep -q 'ZZZ-not-in-this-tree' src/thing.mjs" },
      code: "BAR_NOT_FIXED",
      kind: "refused",
      ledgerVerdict: "NOT_FIXED",
    },
    {
      label: "the command passes on the unpatched tree",
      reproduction: { command: "test -f src/thing.mjs" },
      code: "BAR_COULD_NOT_REPRODUCE",
      kind: "inconclusive",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
    },
  ];
  const seen = new Set();
  for (const c of cases) {
    const box = barSandbox(c.reproduction);
    try {
      const gate = fakeGate(applyRecord(DIFF));
      const got = runSupervisorCycle({
        defectPath: box.defect,
        ledgerDir: box.ledger,
        proposalsDir: box.proposals,
        rollbackDir: box.rollback,
        repoRoot: box.root,
        gate: gate.gate,
      });
      assert.equal(got.code, c.code, `${c.label}: ${got.detail}`);
      assert.equal(got.kind, c.kind, c.label);
      seen.add(got.code);

      // THE GATE SEAM IS THE ASSERTION. A bar that refused in its return value and
      // let the proposal through anyway would satisfy every check above, and the
      // gate would then grade a patch on nobody's evidence — the state this round
      // exists to end. The gate here would have said APPLY.
      assert.equal(gate.calls.length, 0, `${c.label}: an unproved diff was sent to the Tier 3 gate`);
      assert.equal(box.read(), "old\n", `${c.label}: the tree was patched by a diff that never cleared the bar`);

      // THE ROW IS WRITTEN — a refusal that leaves no row is indistinguishable
      // from one that never ran — AND IT CARRIES NO FINGERPRINT. The copy is
      // `git archive HEAD` and has no node_modules, so "the patch does not work"
      // and "the copy could not run the command" are the same bytes; a blacklist
      // keyed on that would refuse a good diff for ever.
      const rows = openLedger(box.ledger).read(SIG);
      assert.equal(rows.length, 1, `${c.label} wrote ${rows.length} ledger rows`);
      assert.equal(rows[0].verdict, c.ledgerVerdict, c.label);
      assert.equal(rows[0].proposalFingerprint, null, `${c.label}: a bar outcome blacklisted the proposal`);
      assert.deepEqual(openLedger(box.ledger).ruledOutFingerprints(SIG), [], c.label);
      assert.equal(got.fingerprint, null, c.label);
    } finally {
      box.cleanup();
    }
  }
  assert.equal(seen.size, 2, "the two ways of failing the bar answered with one code");
});

/* ---------------------------------------------------------------------------
 * 2. AND A DIFF THAT DOES CLEAR IT REACHES THE GATE.
 *
 * Without this half the bar is a component that can only refuse — which passes
 * every assertion above while repairing nothing, ever. This is the whole chain
 * with only the gate faked: real defect record, real candidate diff, real copy of
 * HEAD, real reproduction run three times, real independent replay.
 * ------------------------------------------------------------------------ */
test("a candidate diff that CLEARS the bar reaches the gate, and the gate is handed the prover's own transcripts", () => {
  const box = barSandbox();
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "GATE_APPLY", got.detail);
    assert.equal(got.kind, "applied", got.detail);
    assert.equal(gate.calls.length, 1, `a proved diff never reached the gate: ${got.detail}`);
    assert.equal(box.read(), "new\n", "the gate authorised the patch and the tree did not change");
    assert.equal(openLedger(box.ledger).read(SIG)[0].verdict, "ACCEPTED");

    /*
     * THE EVIDENCE THE GATE RECEIVED IS THE PROVER'S, NOT THE AUTHOR'S. These are
     * the bytes three real processes wrote on the isolated copy: the recorded
     * command failing before the patch, passing with it, and failing again under a
     * revert of the fix. Before this round the gate got whatever
     * `<signature>.evidence.json` said, or nothing at all.
     */
    const proposal = gate.calls[0].proposal;
    assert.match(proposal.evidence.redBefore, /# exit code: 1/, "the RED transcript did not come from a failing run");
    assert.match(proposal.evidence.greenAfter, /# exit code: 0/, "the GREEN transcript did not come from a passing run");
    assert.match(proposal.evidence.mutationRed, /# exit code: 1/, "reverting the fix did not turn the check red");
    assert.match(proposal.evidence.redBefore, /grep -q/, "the transcript does not carry the command that was run");
    assert.notEqual(proposal.evidence.redBefore, proposal.evidence.greenAfter);
    assert.deepEqual(proposal.filesChanged, ["src/thing.mjs"]);
  } finally {
    box.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * 3. THE TREE THE BAR PROVES ON IS A COPY, OUTSIDE THE REPOSITORY, AND IT IS GONE.
 *
 * `prover.mjs#assertSandbox` THROWS for any path inside this repository, and that
 * refusal is why the bar was never wired: proving a repair applies the diff, runs
 * the reproduction, reverts the fix hunk and runs it again — on the owner's live
 * tree, with a second worker mid-edit in `bakeoff/src`, that is a corrupted
 * workspace. So the copy has to be real, and it has to be cleaned up on BOTH the
 * accepting and the refusing path, or the machine fills with patched trees.
 * ------------------------------------------------------------------------ */
test("the bar proves on a copy of HEAD outside REPO_ROOT, and removes it on every path", () => {
  // A. THE HELPER, DIRECTLY. What it copies and what it does not is the property
  //    that decides whether a reproduction means anything.
  const iso = isolateRepairRoot({ repoRoot: REPO_ROOT });
  try {
    assert.equal(iso.ok, true, iso.detail);
    assert.ok(
      !iso.root.startsWith(REPO_ROOT + path.sep) && iso.root !== REPO_ROOT,
      `the isolated copy is inside the repository (${iso.root}); the prover refuses to run there and would throw`,
    );
    assert.ok(existsSync(path.join(iso.root, "tools", "repair", "cycle.mjs")), "the copy does not contain the tree it claims to copy");
    // AND IT IS HEAD, NOT THE WORKING TREE: `node_modules` is gitignored, so its
    // absence here is what makes the 23 MB / 0.196s measurement true — and it is
    // the reason a bar outcome never blacklists a proposal.
    assert.ok(!existsSync(path.join(iso.root, "node_modules")), "the copy pulled in gitignored paths");
  } finally {
    iso.cleanup();
  }
  assert.ok(!existsSync(iso.root), "the isolated copy outlived its cleanup");

  // B. THROUGH THE SUPERVISOR, ON BOTH VERDICTS. The path the cycle really used
  //    travels on the decision, so this is the copy that was proved on and not a
  //    second one made by the test.
  for (const arm of [
    { label: "accepted", reproduction: {}, code: "GATE_APPLY" },
    { label: "refused", reproduction: { command: "grep -q 'ZZZ-not-in-this-tree' src/thing.mjs" }, code: "BAR_NOT_FIXED" },
  ]) {
    const box = barSandbox(arm.reproduction);
    try {
      const got = runSupervisorCycle({
        defectPath: box.defect,
        ledgerDir: box.ledger,
        proposalsDir: box.proposals,
        rollbackDir: box.rollback,
        repoRoot: box.root,
        gate: fakeGate(applyRecord(DIFF)).gate,
      });
      assert.equal(got.code, arm.code, got.detail);
      assert.equal(typeof got.isolatedRoot, "string", `${arm.label}: the cycle named no isolated root`);
      assert.ok(
        !got.isolatedRoot.startsWith(REPO_ROOT + path.sep),
        `${arm.label}: the bar proved inside the repository at ${got.isolatedRoot}`,
      );
      assert.ok(!existsSync(got.isolatedRoot), `${arm.label}: the isolated copy was left behind at ${got.isolatedRoot}`);
    } finally {
      box.cleanup();
    }
  }
});

/* ---------------------------------------------------------------------------
 * 4. A FAILURE TO ISOLATE IS A NAMED OUTCOME, NOT AN EXCEPTION IN A TICK.
 *
 * `SupervisorLoop.#repair` awaits the cycle inside `tick()` behind a re-entrancy
 * flag. A throw from here is a lost ticket, and the queue is exactly what the
 * supervisor exists to keep moving.
 * ------------------------------------------------------------------------ */
test("a failure to isolate, and a bar that throws, are both named outcomes rather than exceptions", () => {
  // A. NOTHING TO ARCHIVE. `box.dir` is a real directory and not a git
  //    repository, so `git archive HEAD` fails — the same shape as a corrupted
  //    object store or a repository with no commit yet.
  const box = barSandbox();
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.dir,
      gate: gate.gate,
    });
    assert.equal(got.code, "ISOLATION_FAILED", got.detail);
    assert.equal(got.kind, "inconclusive");
    assert.match(got.detail, /GIT_ARCHIVE_FAILED/, "the sentence does not say WHY the copy could not be built");
    assert.equal(gate.calls.length, 0, "a diff nobody could prove was sent to the gate");
    assert.equal(got.fingerprint, null, "an environment fault blacklisted the proposal");
    const rows = openLedger(box.ledger).read(SIG);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, "COULD_NOT_REPRODUCE");
    assert.equal(rows[0].proposalFingerprint, null);
    assert.ok(!existsSync(String(got.isolatedRoot)), "the failed copy was left behind");
  } finally {
    box.cleanup();
  }

  // B. THE SEAM ITSELF THROWS. `runEvidenceBar` catches a throw from the cycle;
  //    this is the outer catch, which is what stops an injected or future bar from
  //    taking the tick down with it.
  const boom = barSandbox();
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: boom.defect,
      ledgerDir: boom.ledger,
      proposalsDir: boom.proposals,
      rollbackDir: boom.rollback,
      repoRoot: boom.root,
      bar: () => {
        throw new Error("the injected bar exploded");
      },
      gate: gate.gate,
    });
    assert.equal(got.code, "EVIDENCE_BAR_THREW");
    assert.equal(got.kind, "inconclusive");
    assert.match(got.detail, /the injected bar exploded/);
    assert.equal(gate.calls.length, 0);
    assert.equal(boom.read(), "old\n");

    // AND A BAR THAT ANSWERS WITHOUT A CODE IS NAMED TOO, because `undefined` in a
    // ledger row and `NO_CODE` on the ticket is a refusal nobody can act on.
    const mute = decideRepairOutcome({
      defect: { signature: SIG },
      diff: DIFF,
      diffPath: "p",
      ruledOutFingerprints: [],
      bar: { ok: false },
    });
    assert.equal(mute.code, "BAR_UNREADABLE");
    assert.equal(mute.kind, "inconclusive");
    assert.equal(mute.ledgerVerdict, "COULD_NOT_REPRODUCE");
    assert.notEqual(mute.detail.trim(), "");
  } finally {
    boom.cleanup();
  }

  /*
   * C. A DIFF THAT CANNOT BE PARSED. MEASURED with a probe on 2026-08-12:
   *    `countHunks("--- a/x\n+++ b/x\n@@ bad @@\n")` THROWS, and counting hunks is
   *    the first thing the bar asks of the diff — so before this arm a malformed
   *    candidate left `runEvidenceBar` by exception rather than by return.
   */
  const malformed = barSandbox();
  try {
    writeFileSync(path.join(malformed.proposals, `${SIG}.diff`), "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ not a hunk header @@\n", "utf8");
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: malformed.defect,
      ledgerDir: malformed.ledger,
      proposalsDir: malformed.proposals,
      rollbackDir: malformed.rollback,
      repoRoot: malformed.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "DIFF_UNPARSEABLE", got.detail);
    assert.equal(got.kind, "inconclusive");
    assert.equal(gate.calls.length, 0);
    assert.equal(malformed.read(), "old\n");
    assert.equal(got.fingerprint, null);
    /*
     * AND THE ROW SURVIVES THE SAME DIFF. This assertion is the one that found a
     * latent crash: `filesInDiff` throws on an unparseable diff and the ledger
     * write called it outside any catch, so this input threw out of
     * `runSupervisorCycle` — no row, no JSON line, an exception in the tick.
     */
    const rows = openLedger(malformed.ledger).read(SIG);
    assert.equal(rows.length, 1, "an unparseable diff left no row, so the refusal is invisible");
    assert.equal(rows[0].reasons[0].code, "DIFF_UNPARSEABLE");
    assert.deepEqual(rows[0].filesChanged, []);
  } finally {
    malformed.cleanup();
  }

  // D. THE NEGATIVE HALF FOR ALL THREE: the SAME defect record and the SAME diff, with
  //    a real git repository as the root and no seam, isolates and proves. Without
  //    it, a `runEvidenceBar` that answered ISOLATION_FAILED unconditionally would
  //    pass every assertion above.
  const fine = barSandbox();
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: fine.defect,
      ledgerDir: fine.ledger,
      proposalsDir: fine.proposals,
      rollbackDir: fine.rollback,
      repoRoot: fine.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "GATE_APPLY", got.detail);
    assert.equal(gate.calls.length, 1);
  } finally {
    fine.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * 5. THE RECORD CARRIES NO REPRODUCTION COMMAND — WHICH IS TODAY'S PRODUCTION
 *    ANSWER, AND IT IS A REFUSAL RATHER THAN A GUESS.
 *
 * MEASURED 2026-08-12: `dashboard/server/src/defect-record.ts` defines every field
 * a `results/defect.json` carries and none of them is a command; all 7 records
 * under `dashboard/runs` grep clean for `command`. So every real ticket stops
 * here. The alternative — deriving a command from `failureReason` — is a prose
 * match, the mechanism that died on 2026-08-04.
 * ------------------------------------------------------------------------ */
test("a defect record with no reproduction block stops at a named outcome instead of guessing one", () => {
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
    assert.equal(got.code, "NO_REPRODUCTION_COMMAND", got.detail);
    assert.equal(got.kind, "inconclusive");
    assert.match(got.detail, /failureReason/, "the sentence does not say why the prose is not read instead");
    assert.equal(gate.calls.length, 0, "a diff nobody could prove was sent to the gate");
    assert.equal(box.read(), "old\n");
    assert.equal(got.fingerprint, null);
    assert.equal(openLedger(box.ledger).read(SIG)[0].verdict, "COULD_NOT_REPRODUCE");
  } finally {
    box.cleanup();
  }

  // AND THE OTHER HALF OF THE SAME READER: a command with no INDEPENDENT replay
  // case is its own outcome, refused BEFORE the reproduction is run three times
  // for an answer that was knowable from the record. `independentReplay` is
  // explicit that `unrelatedChanged: []` from an empty case list means nothing was
  // executed, not that nothing was damaged.
  const targetedOnly = barSandbox({
    cases: [{ name: "targeted-only", command: 'test "$(cat src/thing.mjs)" = new', targeted: true }],
  });
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: targetedOnly.defect,
      ledgerDir: targetedOnly.ledger,
      proposalsDir: targetedOnly.proposals,
      rollbackDir: targetedOnly.rollback,
      repoRoot: targetedOnly.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "NO_RECORDED_REPLAY_CASES", got.detail);
    assert.equal(got.kind, "inconclusive");
    assert.equal(gate.calls.length, 0);
    assert.equal(targetedOnly.read(), "old\n");
  } finally {
    targetedOnly.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * 6. THE BAR'S SHARE OF THE SUPERVISOR'S TEN MINUTES.
 *
 * The bar now runs inside the same awaited tick as the gate, so the two clocks
 * ADD UP. `REPAIR_CYCLE_TIMEOUT_MS` bounds the whole process from outside and
 * `spawnSync` signals only the child on either path, so an inner stage that
 * outlives the outer clock is orphaned rather than reaped.
 * ------------------------------------------------------------------------ */
test("the bar and the gate together still fit inside the supervisor's outer clock, and an unaffordable proof is refused unspent", () => {
  const bootSrc = readFileSync(path.join(HERE, "..", "..", "dashboard", "server", "src", "supervisor-boot.ts"), "utf8");
  const m = /REPAIR_CYCLE_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*([\d_]+);/.exec(bootSrc);
  assert.ok(m !== null, "the supervisor's outer bound is no longer readable from supervisor-boot.ts");
  const outer = Number(m[1]) * Number(m[2]) * Number(m[3].replace(/_/g, ""));
  assert.ok(
    PROVE_BUDGET_MS + GATE_TIMEOUT_MS < outer,
    `the bar (${PROVE_BUDGET_MS}ms) plus the gate (${GATE_TIMEOUT_MS}ms) is not shorter than the supervisor's ` +
      `${outer}ms, so the outer kill becomes the normal path and the inner stage is orphaned`,
  );
  assert.ok(
    outer - (PROVE_BUDGET_MS + GATE_TIMEOUT_MS) >= 60_000,
    `only ${outer - (PROVE_BUDGET_MS + GATE_TIMEOUT_MS)}ms separates the two clocks`,
  );

  /*
   * AND THE PER-COMMAND SHARE IS BOUNDED BY CONSTRUCTION. `cycle.mjs` takes a
   * per-command timeout and has no overall clock, and the number of runs comes
   * from INPUTS — 3 for the proof, one more per hunk, two per replay case. Six
   * recorded cases is 3 + 12 = 15 runs, which at the 5s floor is 75s and does not
   * fit the 60s budget, so it is refused BEFORE a 23 MB copy is built.
   */
  const box = barSandbox({
    cases: [
      { name: "t", command: 'test "$(cat src/thing.mjs)" = new', targeted: true },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `u${i}`, command: "test -f src/thing.mjs" })),
    ],
  });
  try {
    const defect = JSON.parse(readFileSync(box.defect, "utf8"));
    const tooBig = runEvidenceBar({ defect, diff: DIFF, repoRoot: box.root });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.code, "PROOF_BUDGET_EXCEEDED", tooBig.detail);
    assert.match(tooBig.detail, new RegExp(String(MAX_PROVED_RUNS)));
    assert.equal(tooBig.isolatedRoot, null, "an unaffordable proof still built a copy of HEAD");
    assert.equal(MAX_PROVED_RUNS, Math.floor(PROVE_BUDGET_MS / MIN_COMMAND_TIMEOUT_MS));

    // NEGATIVE HALF: the same tree with the two recorded cases (3 + 4 = 7 runs)
    // is affordable and is proved. A budget arm that refused everything would be
    // indistinguishable from the bar never having been wired at all.
    const affordable = JSON.parse(readFileSync(barSandboxRecord(box), "utf8"));
    const ok = runEvidenceBar({ defect: affordable, diff: DIFF, repoRoot: box.root, log: () => {} });
    assert.equal(ok.ok, true, ok.detail);
    assert.equal(ok.code, "BAR_ACCEPTED");
    assert.ok(ok.perCommandMs >= MIN_COMMAND_TIMEOUT_MS, `the per-command share fell below the floor at ${ok.perCommandMs}ms`);
    assert.ok(!existsSync(ok.isolatedRoot), "the affordable proof left its copy behind");
  } finally {
    box.cleanup();
  }
});

/** The two-case record, written beside the six-case one so both are real files. */
function barSandboxRecord(box) {
  const record = JSON.parse(readFileSync(box.defect, "utf8"));
  const two = {
    ...record,
    reproduction: {
      command: REPRO_COMMAND,
      cases: [
        { name: "targeted-via-another-input", command: 'test "$(cat src/thing.mjs)" = new', targeted: true },
        { name: "unrelated-recorded-input", command: "test -f src/thing.mjs" },
      ],
    },
  };
  const at = path.join(box.dir, "results", "defect-two-cases.json");
  writeFileSync(at, JSON.stringify(two), "utf8");
  return at;
}

/* ---------------------------------------------------------------------------
 * 7. A PATCH THE CHECK CANNOT SEE IS REFUSED AS A PATCH, NOT FILED AS AN
 *    EXPERIMENT THAT WOULD NOT RUN.
 *
 * `MUTATION_SURVIVED` is the prover's vacuity control: the recorded command went
 * red, then green with the patch, and STAYED GREEN when the fix was reverted — so
 * the check never observed the patch and the green run proved nothing. That is a
 * judgement on the IDEA (`refused`), and it is one keystroke away from being filed
 * as a judgement on the COPY (`inconclusive`), which is the sentence the supervisor
 * shows for "your command could not be run here". MEASURED with a mutation on
 * 2026-08-12: dropping MUTATION_SURVIVED and UNPROVEN_HUNKS from
 * `BAR_REFUSING_VERDICTS` left all 97 tests green, so nothing held that split for
 * the two verdicts the arm check does not drive.
 *
 * THE COMMAND HERE IS STATEFUL ON PURPOSE, because that is the only way a real
 * tree produces this outcome: it fails once and passes for ever after, so it moves
 * from red to green while the patch is applied and is not measuring the patch at
 * all. A cached check, a marker file, a test that writes its own fixture — this is
 * the shape, and the bar has to be able to tell the owner which one it hit.
 * ------------------------------------------------------------------------ */
test("a patch the recorded check cannot observe is REFUSED by name, not filed as a copy that could not run it", () => {
  // Red the first time, green every time after: the patch is never what changes it.
  const BLIND_CHECK = "if [ -f .bar-probe-seen ]; then exit 0; fi; touch .bar-probe-seen; exit 1";
  const box = barSandbox({ command: BLIND_CHECK });
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: box.defect,
      ledgerDir: box.ledger,
      proposalsDir: box.proposals,
      rollbackDir: box.rollback,
      repoRoot: box.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "BAR_MUTATION_SURVIVED", got.detail);
    assert.equal(
      got.kind,
      "refused",
      `a vacuous patch was reported as '${got.kind}' — the sentence the owner reads for an experiment that could not ` +
        `be staged, about a patch whose experiment ran and showed the check does not observe it: ${got.detail}`,
    );
    assert.equal(gate.calls.length, 0, "a patch the check cannot see was sent to the Tier 3 gate");
    assert.equal(box.read(), "old\n", "the tree was patched by a diff whose proof was vacuous");

    // THE ROW CARRIES THE CYCLE'S OWN WORD, so the ledger says which experiment was
    // run rather than filing every bar outcome under the same heading.
    const rows = openLedger(box.ledger).read(SIG);
    assert.equal(rows.length, 1, `the vacuous proof wrote ${rows.length} ledger rows`);
    assert.equal(rows[0].verdict, "MUTATION_SURVIVED", "the ledger row does not name the verdict the cycle reached");
    // AND STILL NO FINGERPRINT: the copy has no node_modules, so a bar refusal must
    // never become a permanent blacklist (supervisor-cycle.mjs, THE BAR NEVER BLACKLISTS).
    assert.equal(rows[0].proposalFingerprint, null, "a bar refusal blacklisted the proposal");
    assert.deepEqual(openLedger(box.ledger).ruledOutFingerprints(SIG), []);
    assert.equal(got.fingerprint, null);
  } finally {
    box.cleanup();
  }

  /*
   * THE NEGATIVE HALF, ON THE SAME MACHINERY: a command that DOES observe the patch
   * clears the bar and reaches the gate. Without it, a bar that answered
   * BAR_MUTATION_SURVIVED to everything would satisfy every assertion above.
   */
  const seeing = barSandbox();
  try {
    const gate = fakeGate(applyRecord(DIFF));
    const got = runSupervisorCycle({
      defectPath: seeing.defect,
      ledgerDir: seeing.ledger,
      proposalsDir: seeing.proposals,
      rollbackDir: seeing.rollback,
      repoRoot: seeing.root,
      gate: gate.gate,
    });
    assert.equal(got.code, "GATE_APPLY", got.detail);
    assert.equal(gate.calls.length, 1);
  } finally {
    seeing.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * 8. EVERY VERDICT `cycle.mjs` CAN REACH IS READ AS ITSELF — INCLUDING THE ONES
 *    NO SINGLE TREE IN THIS FILE CAN PRODUCE.
 *
 * Section 7 drives ONE of these through a real repository, which is what stops
 * this table from grading itself. The rest are here because producing them
 * behaviourally needs four more repositories (a diff that does not apply, a revert
 * that cannot be constructed, a two-hunk diff with scaffolding in it) for a
 * property that lives entirely in one pure function — and MEASURED 2026-08-12,
 * three mutations of that function survived the whole suite:
 *
 *   BAR_REFUSING_VERDICTS = ["REFUSED", "NOT_FIXED"]      97 pass — SURVIVED
 *   a result with no verdict reads as ACCEPTED            97 pass — SURVIVED
 *   ledgerVerdict = verdict (unknown words included)      97 pass — SURVIVED
 *
 * The second is the one that costs: `runRepairCycle` returning a shape this file
 * cannot read would send an UNPROVED diff to the Tier 3 gate, which is exactly the
 * state the evidence bar was built to end.
 * ------------------------------------------------------------------------ */
test("every verdict the cycle can reach is classified as itself, an unknown one is not, and a missing one is never an acceptance", () => {
  const cases = [
    // A JUDGEMENT ON THE IDEA: the experiment ran and the patch did not survive it.
    { verdict: "REFUSED", kind: "refused" },
    { verdict: "NOT_FIXED", kind: "refused" },
    { verdict: "MUTATION_SURVIVED", kind: "refused" },
    { verdict: "UNPROVEN_HUNKS", kind: "refused" },
    // A JUDGEMENT ON THE COPY: the experiment could not be staged at all. Telling
    // the owner "your patch does not fix this" here is a false statement the ledger
    // row then keeps.
    { verdict: "COULD_NOT_REPRODUCE", kind: "inconclusive" },
    { verdict: "PATCH_DID_NOT_APPLY", kind: "inconclusive" },
    { verdict: "MUTANT_NOT_CONSTRUCTIBLE", kind: "inconclusive" },
  ];
  for (const c of cases) {
    const got = classifyBarResult({ verdict: c.verdict, reasons: [{ code: c.verdict, detail: "the recorded outcome" }] });
    assert.equal(got.ok, false, `${c.verdict} was classified as a proved patch`);
    assert.equal(got.code, `BAR_${c.verdict}`, `${c.verdict} lost its name`);
    assert.equal(got.kind, c.kind, `${c.verdict} was classified '${got.kind}': ${got.detail}`);
    assert.equal(got.ledgerVerdict, c.verdict, `${c.verdict} would be written to the ledger as '${got.ledgerVerdict}'`);
    assert.equal(got.proposal, null, `${c.verdict} carried a proposal to the gate`);
    assert.match(got.detail, new RegExp(c.verdict), `${c.verdict}'s sentence does not say what happened`);

    // AND THE KIND SURVIVES THE ROUTER, which is where the supervisor branches.
    const decided = decideRepairOutcome({ defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [], bar: got });
    assert.equal(decided.code, `BAR_${c.verdict}`, `${c.verdict} did not reach the ticket`);
    assert.equal(decided.kind, c.kind, `${c.verdict} reached the ticket as '${decided.kind}'`);
    assert.equal(decided.ledgerVerdict, c.verdict);
    assert.equal(decided.fingerprint, null, `${c.verdict} blacklisted the proposal`);
  }

  /*
   * THE TABLE IS PINNED AGAINST THE PROVER'S OWN SOURCE, not against itself. A new
   * failing outcome added to `prover.mjs` and not classified here would arrive as
   * an unrecognised verdict — `inconclusive`, "the copy could not stage the
   * experiment" — for a patch whose experiment ran and refused it.
   */
  const proverOutcomes = new Set(
    [...readFileSync(path.join(HERE, "prover.mjs"), "utf8").matchAll(/outcome:\s*"([A-Z_]+)"/g)]
      .map((m) => m[1])
      .filter((o) => o !== "PROVEN"),
  );
  assert.ok(proverOutcomes.size >= 6, `only ${proverOutcomes.size} prover outcomes were readable; the pin is no longer measuring anything`);
  for (const outcome of proverOutcomes) {
    assert.ok(
      cases.some((c) => c.verdict === outcome),
      `prover.mjs can return ${outcome} and nothing classifies it, so it reaches the ticket as an experiment that could not be staged`,
    );
  }

  // A VERDICT NOTHING HERE KNOWS keeps its word in the SENTENCE and loses it in the
  // LEDGER, because the ledger's vocabulary is read back and a word nothing else
  // knows is a row nobody can act on.
  const unknown = classifyBarResult({ verdict: "SOME_FUTURE_VERDICT" });
  assert.equal(unknown.ok, false, "an unrecognised verdict was read as a proved patch");
  assert.equal(unknown.code, "BAR_SOME_FUTURE_VERDICT", "the sentence lost the word the cycle actually used");
  assert.equal(unknown.kind, "inconclusive");
  assert.equal(unknown.ledgerVerdict, "COULD_NOT_REPRODUCE", "an unknown verdict word was written into the ledger's vocabulary");

  /*
   * AND A RESULT WITH NO VERDICT AT ALL IS NEVER AN ACCEPTANCE. `runRepairCycle`
   * has four early returns and a shape this file does not own; a default that read
   * as ACCEPTED would hand the gate a diff nothing ever proved, which is the state
   * of the world this whole lane was added to end.
   */
  for (const empty of [{}, { verdict: "" }, { verdict: "   " }, { verdict: null }, { verdict: 7 }, null, undefined]) {
    const got = classifyBarResult(empty);
    assert.equal(got.ok, false, `a cycle result of ${JSON.stringify(empty ?? null)} was read as a proved patch`);
    assert.equal(got.code, "BAR_NO_VERDICT", `a cycle result of ${JSON.stringify(empty ?? null)} was named ${got.code}`);
    assert.equal(got.kind, "inconclusive");
    assert.equal(got.ledgerVerdict, "COULD_NOT_REPRODUCE");
    assert.equal(
      decideRepairOutcome({ defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [], bar: got }).kind,
      "inconclusive",
    );
  }

  /*
   * THE NEGATIVE CONTROL FOR THE WHOLE TABLE: ACCEPTED still accepts, and it
   * carries the prover's proposal through. A classifier that refused everything
   * satisfies every assertion above while making the repair lane incapable of ever
   * repairing anything — the exact defect this file's arm check names.
   */
  const accepted = classifyBarResult({ verdict: "ACCEPTED", proposal: { evidence: { redBefore: "$ cmd\n# exit code: 1\n" } } });
  assert.equal(accepted.ok, true, "an ACCEPTED cycle was refused, so no proved patch can ever reach the gate");
  assert.equal(accepted.code, "BAR_ACCEPTED");
  assert.equal(accepted.ledgerVerdict, null, "an accepted bar wrote its own ledger row ahead of the gate's answer");
  assert.equal(accepted.proposal.evidence.redBefore, "$ cmd\n# exit code: 1\n", "the prover's transcripts did not survive classification");
  assert.equal(
    decideRepairOutcome({ defect: { signature: SIG }, diff: DIFF, diffPath: "p", ruledOutFingerprints: [], bar: accepted }).code,
    "NO_GATE_ANSWER",
    "a proved patch did not go on to the gate",
  );
});

/* ---------------------------------------------------------------------------
 * 9. THE COPY ARRIVES ABLE TO COMPILE — OR THE BAR REFUSES IT BY NAME AND RUNS
 *    NOTHING.
 *
 * WHY THIS SECTION EXISTS. Every reproduction for a suite-authoring defect has to
 * build the package before it can observe anything, so its command starts with
 * `tsc`. A copy with no dependencies makes that command exit non-zero BEFORE the
 * patch and non-zero AFTER it — and `proveRepair` reads the first as "the defect
 * reproduced" and the second as `NOT_FIXED`. A correct patch, filed as broken.
 *
 * MEASURED ON A REAL COPY 2026-08-12, which is why the arms below are the arms:
 *   provision bakeoff/node_modules   0.30s, 1.9 MB of real disk (cp -c, APFS clone)
 *   tsc --noEmit probe               1.31s
 *   whole isolation                  1.47s   (against a 60s PROVE_BUDGET_MS)
 *   the same command through the prover, build INSIDE it:
 *     exit 1 (1046ms) -> exit 0 (1050ms) -> exit 1 on revert (1049ms) = PROVEN
 *   dist built once at isolation, build removed from the command:
 *     exit 1 -> exit 1 with the SAME correct patch = NOT_FIXED
 * ------------------------------------------------------------------------ */

/** A repository whose `bakeoff` package is real enough to compile — or not. */
function bakeoffSandbox({ source = "export const ok: number = 1;\n", provision = true, commitConfig = true } = {}) {
  const box = sandbox();
  const root = path.join(box.dir, "tree");
  mkdirSync(path.join(root, "bakeoff", "src"), { recursive: true });
  writeFileSync(path.join(root, "bakeoff", "src", "thing.ts"), source, "utf8");
  writeFileSync(
    path.join(root, "bakeoff", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "nodenext", outDir: "dist" }, include: ["src/**/*.ts"] }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  // `commitConfig: false` leaves tsconfig.json UNTRACKED, so it is in the working
  // tree and NOT in `git archive HEAD` — which is what a truncated copy looks like.
  execFileSync("git", ["add", commitConfig ? "." : "bakeoff/src"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: root });
  if (provision) {
    // The compiler comes from the real bakeoff, cloned: a fixture that installed
    // its own typescript would measure npm, not this file.
    const real = path.join(REPO_ROOT, "bakeoff", "node_modules");
    assert.ok(existsSync(real), `${real} must exist for this test to mean anything — run \`cd bakeoff && npm install\``);
    const cp = spawnSync("cp", ["-c", "-R", real, path.join(root, "bakeoff", "node_modules")], { encoding: "utf8" });
    if (cp.status !== 0) spawnSync("cp", ["-R", real, path.join(root, "bakeoff", "node_modules")], { encoding: "utf8" });
  }
  return { ...box, root };
}

test("the isolated copy is provisioned and PROVED to compile, and the proof is a value the caller can refuse on", () => {
  const iso = isolateRepairRoot({ repoRoot: REPO_ROOT });
  try {
    assert.equal(iso.ok, true, iso.detail);
    assert.equal(iso.buildable, true, `this repository's own copy cannot compile: ${iso.build.code} — ${iso.build.detail}`);
    assert.equal(iso.build.code, "BUILDS");

    // IT IS A REAL DIRECTORY, NOT A LINK. A symlink here would be a write path
    // back into the owner's working copy: the prover runs repository commands
    // inside this tree, and one `npm install` in a reproduction would land in the
    // node_modules a live run is reading.
    const provisioned = path.join(iso.root, "bakeoff", "node_modules");
    assert.ok(existsSync(provisioned), "the copy was not provisioned, so no command that builds can run in it");
    assert.equal(lstatSync(provisioned).isSymbolicLink(), false, "bakeoff/node_modules in the copy is a LINK into the live repository");
    assert.equal(lstatSync(provisioned).isDirectory(), true);
    assert.ok(existsSync(path.join(provisioned, ".bin", "tsc")), "the copy has dependencies and no compiler");

    // AND THE PROBE EMITTED NOTHING. A `dist` left here would be HEAD's, and a
    // reproduction whose own build step failed would read it and report the
    // unpatched tree's behaviour as the patched tree's — the whole reason the
    // build lives inside the command instead.
    assert.equal(existsSync(path.join(iso.root, "bakeoff", "dist")), false, "the isolation-time probe left a HEAD-built dist in the copy");

    // The measurement is REPORTED, not just performed.
    assert.equal(typeof iso.build.elapsedMs, "number");
    assert.ok(iso.build.provisionMs >= 0 && iso.build.elapsedMs >= iso.build.provisionMs);
    assert.ok(["clone", "copy", "already-present"].includes(iso.build.provisionMode), `unnamed provisioning mode ${String(iso.build.provisionMode)}`);
    // It has to fit the bar's budget, which spends `PROVE_BUDGET_MS - elapsedMs`.
    assert.ok(iso.elapsedMs < PROVE_BUDGET_MS / 4, `isolation took ${iso.elapsedMs}ms of the ${PROVE_BUDGET_MS}ms proof budget`);
  } finally {
    iso.cleanup();
  }
});

test("BOTH DIRECTIONS: a copy that cannot compile says so, and each blocker gets its own name", () => {
  /*
   * FOUR WAYS TO BE UNBUILDABLE AND ONE WAY NOT TO BE. Without the last arm this
   * test passes on an `isolateRepairRoot` that answered `buildable: false`
   * unconditionally — which would stop every bar cycle in the file above, and this
   * repository has catalogued that shape twenty-two times.
   */
  const arms = [
    {
      label: "the compiler refuses the source",
      box: () => bakeoffSandbox({ source: "export const bad: number = 'not a number';\n" }),
      buildable: false,
      code: "BUILD_FAILED",
    },
    {
      label: "nothing was ever installed to provision",
      box: () => bakeoffSandbox({ provision: false }),
      buildable: false,
      code: "DEPENDENCIES_NOT_INSTALLED",
    },
    {
      label: "the package is in the working tree but not in the archive",
      box: () => bakeoffSandbox({ commitConfig: false }),
      buildable: false,
      code: "TRUNCATED_COPY",
    },
    {
      // THE NEGATIVE CONTROL. A tree with no compiled package has no build step
      // for a command to fail in, so refusing it would be refusing a tree that
      // never needed a compiler — every other test in this file uses one.
      label: "there is no compiled package at all",
      box: () => treeSandbox(),
      buildable: true,
      code: "NOTHING_TO_BUILD",
    },
  ];
  const details = new Set();
  for (const arm of arms) {
    const box = arm.box();
    const iso = isolateRepairRoot({ repoRoot: box.root });
    try {
      assert.equal(iso.ok, true, `${arm.label}: the copy itself failed (${iso.code}) — this arm measures the BUILD, not the copy`);
      assert.equal(iso.buildable, arm.buildable, `${arm.label}: buildable=${String(iso.buildable)} (${iso.build.code}: ${iso.build.detail})`);
      assert.equal(iso.build.code, arm.code, iso.build.detail);
      assert.ok(iso.build.detail.length > 80, `${arm.label}: "${iso.build.detail}" does not say what an operator must do`);
      details.add(iso.build.detail);
    } finally {
      iso.cleanup();
      box.cleanup();
    }
  }
  assert.equal(details.size, arms.length, "two blockers share a sentence, so the owner cannot tell them apart");
});

test("a copy that cannot compile is COPY_NOT_BUILDABLE, and the reproduction is never run", () => {
  /*
   * THE SENTINEL IS THE POINT. "Never run the reproduction" is not observable from
   * an outcome code — a bar that ran the command and then refused would answer the
   * same thing. So the recorded command's only job is to create a file OUTSIDE the
   * copy, and the assertion is on that file's absence. The second arm creates it,
   * which is what makes the absence in the first arm mean something.
   */
  for (const arm of [
    { label: "unbuildable", source: "export const bad: number = 'not a number';\n", code: "COPY_NOT_BUILDABLE", ran: false },
    { label: "buildable", source: "export const ok: number = 1;\n", code: "BAR_COULD_NOT_REPRODUCE", ran: true },
  ]) {
    const box = bakeoffSandbox({ source: arm.source });
    const sentinel = path.join(box.dir, `reproduction-ran-${arm.label}`);
    try {
      writeFileSync(
        box.defect,
        JSON.stringify({
          runId: "run-x",
          signature: SIG,
          failureClass: "suite_authoring",
          phase: "spec",
          reproduction: {
            command: `touch ${JSON.stringify(sentinel)} && cd bakeoff && ./node_modules/.bin/tsc -p tsconfig.json`,
            cases: [
              { name: "targeted", command: "true", targeted: true },
              { name: "unrelated", command: "true" },
            ],
          },
        }),
        "utf8",
      );
      writeFileSync(path.join(box.proposals, `${SIG}.diff`), DIFF, "utf8");
      const got = runSupervisorCycle({
        defectPath: box.defect,
        ledgerDir: box.ledger,
        proposalsDir: box.proposals,
        rollbackDir: box.rollback,
        repoRoot: box.root,
        gate: fakeGate(applyRecord(DIFF)).gate,
      });
      // THE SENTINEL IS ASSERTED FIRST, so that a guard that stopped refusing
      // reports "the reproduction RAN" rather than a code mismatch downstream of it.
      assert.equal(existsSync(sentinel), arm.ran, `${arm.label}: the reproduction ${arm.ran ? "did NOT run" : "RAN"} and it had to be the other way round`);
      assert.equal(got.code, arm.code, got.detail);
      assert.equal(got.kind, "inconclusive", got.detail);
      if (!arm.ran) {
        // The sentence has to carry the blocker, or the owner is told "it did not
        // work" about a machine that needs `npm install`.
        assert.match(got.detail, /BUILD_FAILED/, "COPY_NOT_BUILDABLE does not name WHY the copy will not compile");
        assert.match(got.detail, /NOT\s+run/, "the outcome does not say that the reproduction was never executed");
      }
      // NEITHER ARM BLACKLISTS. A broken toolchain is a fact about the machine.
      assert.equal(got.fingerprint, null, `${arm.label}: an environment fault ruled the proposal out for ever`);
      assert.equal(openLedger(box.ledger).read(SIG)[0].proposalFingerprint, null);
      assert.ok(!existsSync(String(got.isolatedRoot)), `${arm.label}: the ~80 MB provisioned copy was left behind`);
    } finally {
      box.cleanup();
    }
  }
});
