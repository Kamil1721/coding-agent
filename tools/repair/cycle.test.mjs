import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepairCycle } from "./cycle.mjs";
import { validateProposal } from "./evidence.mjs";
import { openLedger } from "./ruled-out.mjs";
import { A913C871_ATTEMPTS, A913C871_SITE } from "./fixtures.mjs";

const TMP = process.env.REPAIR_TEST_TMP ?? tmpdir();
const SIG = "1".repeat(64);

const WIDGET = 'export function add(a, b) {\n  return a - b;\n}\n';
const CHECK = 'import { add } from "./widget.mjs";\nif (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }\nconsole.log("ok");\n';
const FIX = `--- a/widget.mjs
+++ b/widget.mjs
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;
// counted: the shell appends one line per invocation, so "the prover did not run" is an
// observation rather than an assumption about control flow.
const COUNTED = "sh -c 'echo ran >> runs.log; node check.mjs'";

function fixture() {
  const root = mkdtempSync(join(TMP, "repair-cycle-"));
  writeFileSync(join(root, "widget.mjs"), WIDGET, "utf8");
  writeFileSync(join(root, "check.mjs"), CHECK, "utf8");
  // probe.mjs is a SECOND recorded observation of the targeted behaviour, reached by a
  // different input than the reproduction. unrelated.mjs is behaviour the defect does not
  // implicate and must not move.
  writeFileSync(join(root, "probe.mjs"), 'import { add } from "./widget.mjs";\nprocess.exit(add(10, 1) === 11 ? 0 : 7);\n', "utf8");
  writeFileSync(join(root, "unrelated.mjs"), 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("check.mjs", "utf8").includes("add(2, 3)") ? 0 : 9);\n', "utf8");
  const ledgerDir = mkdtempSync(join(TMP, "repair-cycle-ledger-"));
  return { root, ledgerDir, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); } };
}
/*
 * THE FROZEN CLOSURE IS NOW A REQUIRED ARGUMENT and every call below names it. It used to
 * default to `[]`, which made the TOUCHES_FROZEN_CLOSURE check refuse nothing and report a
 * clean ACCEPT — a check that can only observe success, in the file written to forbid them.
 * The real list comes from `tools/tier3/closure.mjs#frozenClosure`; these two entries are
 * enough to prove the guard is consulted and cannot be reached by `widget.mjs`.
 */
const CLOSURE = ["bakeoff/src/scorer.ts", "bakeoff/src/contracts.ts"];
const defect = { signature: SIG, attempts: [], artefacts: ["widget.mjs"], candidatePaths: ["widget.mjs"] };
const lines = (root) => (existsSync(join(root, "runs.log")) ? readFileSync(join(root, "runs.log"), "utf8").trim().split("\n").length : 0);

test("a proposal with no independent check is REFUSED and the refusal leaves a readable row", () => {
  const f = fixture();
  try {
    const r = runRepairCycle({ defect, candidateDiff: FIX, root: f.root, command: "node check.mjs", ledgerDir: f.ledgerDir, frozenClosure: CLOSURE, log: () => {} });
    assert.equal(r.verdict, "REFUSED");
    assert.equal(r.proposal, null);
    assert.deepEqual(r.reasons.map((x) => x.code), ["NO_INDEPENDENT_CHECK"]);
    const rows = openLedger(f.ledgerDir).read(SIG);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasons[0].code, "NO_INDEPENDENT_CHECK");
  } finally {
    f.cleanup();
  }
});

test("a repair already ruled out is refused BEFORE the prover spends anything on it", () => {
  const f = fixture();
  try {
    const first = runRepairCycle({ defect, candidateDiff: FIX, root: f.root, command: COUNTED, ledgerDir: f.ledgerDir, frozenClosure: CLOSURE, log: () => {} });
    assert.equal(first.verdict, "REFUSED");
    const spentOnce = lines(f.root);
    assert.ok(spentOnce >= 3, `the first cycle should have run the check at least three times (red, green, mutant); saw ${spentOnce}`);

    const second = runRepairCycle({ defect, candidateDiff: FIX, root: f.root, command: COUNTED, ledgerDir: f.ledgerDir, frozenClosure: CLOSURE, log: () => {} });
    assert.deepEqual(second.reasons.map((x) => x.code), ["ALREADY_RULED_OUT"]);
    assert.equal(lines(f.root), spentOnce, "the second cycle ran the check again: the ruled-out memory is not being consulted");
    assert.equal(second.prove, undefined);
    assert.equal(openLedger(f.ledgerDir).read(SIG).length, 2, "both refusals are recorded");
  } finally {
    f.cleanup();
  }
});

test("the whole cycle ACCEPTS a provable, scoped, independently replayed repair", () => {
  const f = fixture();
  try {
    const r = runRepairCycle({
      defect,
      candidateDiff: FIX,
      root: f.root,
      command: "node check.mjs",
      ledgerDir: f.ledgerDir,
      replayCases: [
        { name: "targeted-via-a-different-input", command: "node probe.mjs", targeted: true },
        { name: "unrelated-recorded-input", command: "node unrelated.mjs" },
      ],
      frozenClosure: CLOSURE,
      log: () => {},
    });
    assert.deepEqual(r.reasons, []);
    assert.equal(r.verdict, "ACCEPTED");
    assert.deepEqual(r.proposal.filesChanged, ["widget.mjs"]);
    assert.match(r.proposal.evidence.redBefore, /# exit code: 1/);
    assert.match(r.proposal.evidence.greenAfter, /# exit code: 0/);
    assert.match(r.proposal.evidence.mutationRed, /# exit code: 1/);
    assert.equal(r.replay.ran, true);
    assert.deepEqual(r.replay.unrelatedChanged, []);
  } finally {
    f.cleanup();
  }
});

test("the anti-loop reading travels with the cycle, so an escalation is visible in the record", () => {
  const f = fixture();
  try {
    const r = runRepairCycle({
      defect: { ...defect, attempts: A913C871_ATTEMPTS },
      site: A913C871_SITE,
      candidateDiff: FIX,
      root: f.root,
      command: "node check.mjs",
      ledgerDir: f.ledgerDir,
      frozenClosure: CLOSURE,
      log: () => {},
    });
    assert.equal(r.loop.escalate, true);
    assert.equal(r.loop.escalateAtAttempt, 2);
    assert.equal(r.loop.arm, "NON_MONOTONE");
  } finally {
    f.cleanup();
  }
});

test("a replay made only of the reproduction command is not independent and is REFUSED", () => {
  const f = fixture();
  try {
    const r = runRepairCycle({
      defect,
      candidateDiff: FIX,
      root: f.root,
      command: "node check.mjs",
      ledgerDir: f.ledgerDir,
      replayCases: [{ name: "targeted", command: "node check.mjs", targeted: true }],
      frozenClosure: CLOSURE,
      log: () => {},
    });
    assert.deepEqual(r.reasons.map((x) => x.code), ["NO_INDEPENDENT_CHECK"]);
    assert.equal(r.replay.code, "REPLAY_NOT_INDEPENDENT");
    assert.match(r.replay.detail, /nothing was executed/);
    assert.equal(r.proposal, null);
  } finally {
    f.cleanup();
  }
});

test("a defect record with no usable signature is refused loudly instead of crashing the ledger", () => {
  const f = fixture();
  try {
    const r = runRepairCycle({ defect: { ...defect, signature: "not-a-digest" }, candidateDiff: FIX, root: f.root, command: "node check.mjs", ledgerDir: f.ledgerDir, frozenClosure: CLOSURE, log: () => {} });
    assert.equal(r.verdict, "REFUSED");
    assert.deepEqual(r.reasons.map((x) => x.code), ["MISSING_SIGNATURE"]);
  } finally {
    f.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * THE CLOSURE IS REQUIRED, AND ITS ABSENCE COSTS NOTHING TO CATCH.
 *
 * `evidence.mjs:150` read `ctx.frozenClosure ?? []`, so a caller that omitted it
 * got a TOUCHES_FROZEN_CLOSURE check that refused nothing and a clean ACCEPT.
 * The input below is the one that matters: a diff against
 * `bakeoff/src/scorer.ts` — the sealed grader — with the closure omitted. Before
 * this change that was an owner-only patch waved through by a check that had
 * nothing to compare against.
 * ------------------------------------------------------------------------- */
test("a scorer.ts diff with the closure OMITTED is REFUSED, and the prover never spends anything on it", () => {
  const f = fixture();
  try {
    const r = runRepairCycle({ defect, candidateDiff: FIX, root: f.root, command: COUNTED, ledgerDir: f.ledgerDir, log: () => {} });
    assert.equal(r.verdict, "REFUSED");
    assert.deepEqual(r.reasons.map((x) => x.code), ["NO_FROZEN_CLOSURE"]);
    assert.equal(lines(f.root), 0, "the prover ran before the missing closure was noticed");

    // AND THE BAR ITSELF, not only the cycle's entry guard: `validateProposal`
    // refuses an omitted closure too, so a second caller cannot route around it.
    const bare = validateProposal(
      {
        signature: SIG,
        diff: "--- a/bakeoff/src/scorer.ts\n+++ b/bakeoff/src/scorer.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        filesChanged: ["bakeoff/src/scorer.ts"],
        evidence: { redBefore: "FAIL\n# exit code: 1", greenAfter: "ok\n# exit code: 0", mutationRed: "FAIL\n# exit code: 1" },
        proposedAt: "2026-08-10T09:00:00.000Z",
      },
      { defect: { artefacts: ["bakeoff/src/scorer.ts"] }, independentCheck: { ran: true, targetedChanged: true, unrelatedChanged: [] } },
    );
    assert.ok(bare.reasons.some((x) => x.code === "NO_FROZEN_CLOSURE"), bare.reasons.map((x) => x.code).join(","));
    assert.equal(bare.verdict, "REFUSED");

    // NEGATIVE HALF: the SAME proposal WITH the closure is still refused, but for
    // the right reason — TOUCHES_FROZEN_CLOSURE, not the absence of a list. An
    // empty closure and a populated one must not produce the same sentence.
    const withList = validateProposal(
      {
        signature: SIG,
        diff: "--- a/bakeoff/src/scorer.ts\n+++ b/bakeoff/src/scorer.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        filesChanged: ["bakeoff/src/scorer.ts"],
        evidence: { redBefore: "FAIL\n# exit code: 1", greenAfter: "ok\n# exit code: 0", mutationRed: "FAIL\n# exit code: 1" },
        proposedAt: "2026-08-10T09:00:00.000Z",
      },
      { defect: { artefacts: ["bakeoff/src/scorer.ts"] }, frozenClosure: CLOSURE, independentCheck: { ran: true, targetedChanged: true, unrelatedChanged: [] } },
    );
    assert.ok(withList.reasons.some((x) => x.code === "TOUCHES_FROZEN_CLOSURE"));
    assert.ok(!withList.reasons.some((x) => x.code === "NO_FROZEN_CLOSURE"));
  } finally {
    f.cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * A REFUSED CYCLE HANDS THE TREE BACK UNPATCHED.
 *
 * MEASURED 2026-08-10, and this is the exact sequence: cycle 1 -> REFUSED /
 * INDEPENDENT_CHECK_MISSED_TARGET, then `node check.mjs` exits 0 in the sandbox
 * because the patch was still applied, then cycle 2 over the same root ->
 * COULD_NOT_REPRODUCE, "there is nothing here to repair and a patch would be a
 * guess". A clean, plausible, wrong answer for an unattended retry loop, and it
 * spends the ticket's remaining attempts on it.
 * ------------------------------------------------------------------------- */
test("two cycles over ONE root: the second still reproduces the defect instead of reporting COULD_NOT_REPRODUCE", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.root, "widget.mjs"), "utf8");
    const first = runRepairCycle({ defect, candidateDiff: FIX, root: f.root, command: "node check.mjs", ledgerDir: f.ledgerDir, frozenClosure: CLOSURE, log: () => {} });
    assert.equal(first.verdict, "REFUSED", `expected a refusal to set up the second cycle; got ${first.verdict}`);
    assert.equal(
      readFileSync(join(f.root, "widget.mjs"), "utf8"),
      before,
      "a REFUSED cycle left the patch applied — the retry can no longer tell 'nothing to fix' from 'already fixed'",
    );

    // The second cycle uses a fresh ledger so ALREADY_RULED_OUT does not mask the
    // reproduction: the question under test is whether the defect is still there.
    const ledgerDir = mkdtempSync(join(TMP, "repair-cycle-ledger-2-"));
    try {
      const second = runRepairCycle({ defect, candidateDiff: FIX, root: f.root, command: "node check.mjs", ledgerDir, frozenClosure: CLOSURE, log: () => {} });
      assert.notEqual(second.verdict, "COULD_NOT_REPRODUCE", "the second cycle reported nothing to repair — the tree was handed back patched");
      assert.equal(second.verdict, "REFUSED");
      assert.deepEqual(second.reasons.map((x) => x.code), first.reasons.map((x) => x.code));
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }

    // NEGATIVE HALF: an ACCEPTED cycle KEEPS the patch, because the applied root
    // is the artefact the gate and the applier read. A revert on every path would
    // pass the assertion above and destroy the proof.
    const g = fixture();
    try {
      const accepted = runRepairCycle({
        defect,
        candidateDiff: FIX,
        root: g.root,
        command: "node check.mjs",
        ledgerDir: g.ledgerDir,
        frozenClosure: CLOSURE,
        replayCases: [
          { name: "targeted-via-a-different-input", command: "node probe.mjs", targeted: true },
          { name: "unrelated-recorded-input", command: "node unrelated.mjs" },
        ],
        log: () => {},
      });
      assert.equal(accepted.verdict, "ACCEPTED");
      assert.match(readFileSync(join(g.root, "widget.mjs"), "utf8"), /return a \+ b/, "an ACCEPTED cycle reverted its own proof");
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});
