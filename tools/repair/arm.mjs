#!/usr/bin/env node
/**
 * START-UP ARM CHECK for the repair agent.
 *
 * Every component in this directory fails silently by nature: an evidence bar that accepts
 * everything, a comparator whose signature never moves, a prover that cannot execute and
 * reports code review as a mutation proof. The canonical local instance is
 * RUN-a913c871-observations.md:100-133 — "the watcher I built to catch Finding 1 had
 * Finding 1's defect" — and the rule that came out of it is the rule here: a probe whose
 * failure mode is silence needs a control at start, while the answer is still known.
 *
 * Each arm is exercised in BOTH directions. "It refused a bad proposal" proves nothing on
 * its own: a bar wired shut refuses everything. So every arm also feeds the good case and
 * requires it through.
 *
 * Run it:  node tools/repair/arm.mjs      (exit 0 = armed, exit 1 = blind, and it says why)
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeSignature } from "./signature.mjs";
import { evaluateAttempts } from "./loop-guard.mjs";
import { validateProposal } from "./evidence.mjs";
import { assertSandbox, proveRepair, runCommand, REPO_ROOT } from "./prover.mjs";
import { openLedger } from "./ruled-out.mjs";
import { runRepairCycle } from "./cycle.mjs";
import { A913C871_ATTEMPTS, A913C871_SITE, SHRINKING_ATTEMPTS } from "./fixtures.mjs";

export const DEFAULT_DEPS = { computeSignature, evaluateAttempts, validateProposal, proveRepair, runCommand, assertSandbox, openLedger, runRepairCycle };

/**
 * The frozen closure the cycle now REQUIRES. Two real §6.1 members, neither of which any
 * sandbox diff below can reach — so the guard is exercised without changing any verdict.
 * Before 2026-08-10 the cycle defaulted this to `[]`, which made the owner-only check refuse
 * nothing and report a clean ACCEPT.
 */
const ARM_CLOSURE = ["bakeoff/src/scorer.ts", "bakeoff/src/contracts.ts"];

const WIDGET = `export function add(a, b) {
  return a - b;
}
`;
const CHECK = `import { add } from "./widget.mjs";
if (add(2, 3) !== 5) { console.error("FAIL: add(2, 3) === " + add(2, 3)); process.exit(1); }
console.log("ok");
`;
const FIX = `--- a/widget.mjs
+++ b/widget.mjs
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

const GOOD_PROPOSAL = {
  signature: "a".repeat(64),
  diff: FIX,
  filesChanged: ["widget.mjs"],
  touchesFrozenClosure: false,
  evidence: { redBefore: "$ node check.mjs\nFAIL\n# exit code: 1\n", greenAfter: "$ node check.mjs\nok\n# exit code: 0\n", mutationRed: "$ node check.mjs\nFAIL\n# exit code: 1\n" },
  proposedAt: "2026-08-10T00:00:00.000Z",
};
const GOOD_CTX = {
  defect: { candidatePaths: ["widget.mjs"] },
  frozenClosure: ["bakeoff/src/contracts.ts"],
  ruledOutFingerprints: [],
  independentCheck: { ran: true, targetedChanged: true, unrelatedChanged: [] },
};

function must(cond, message) {
  if (!cond) throw new Error(message);
}

function sandbox(tmpRoot, files) {
  const root = mkdtempSync(join(tmpRoot, "repair-arm-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body, "utf8");
  }
  return root;
}

export const ARMS = [
  {
    name: "signature",
    run: (d) => {
      const a = d.computeSignature({ site: A913C871_SITE, violations: [{ path: "dataExpectations[0].id" }] });
      const b = d.computeSignature({ site: A913C871_SITE, violations: [{ path: "dataExpectations[0].kind" }] });
      const c = d.computeSignature({ site: A913C871_SITE, violations: [{ path: "dataExpectations[7].id", expected: "different prose entirely" }] });
      must(a !== b, "two different defects hashed the same: the signature does not discriminate");
      must(a === c, "the same defect at another index / other prose hashed differently: the signature is not stable");
      return `discriminates (${a.slice(0, 8)} != ${b.slice(0, 8)}) and is index/prose invariant`;
    },
  },
  {
    name: "anti-loop",
    run: (d) => {
      const hot = d.evaluateAttempts(A913C871_ATTEMPTS, { site: A913C871_SITE });
      const cold = d.evaluateAttempts(SHRINKING_ATTEMPTS, { site: A913C871_SITE });
      must(hot.escalate && hot.escalateAtAttempt === 2 && hot.arm === "NON_MONOTONE", `a913c871 must escalate at attempt 2, got ${hot.arm} at ${hot.escalateAtAttempt}`);
      must(!cold.escalate, "a shrinking sequence escalated: the comparator escalates on everything and is useless");
      return `a913c871 escalates at attempt ${hot.escalateAtAttempt} (${hot.arm}); a shrinking sequence does not escalate`;
    },
  },
  {
    name: "evidence-bar",
    run: (d) => {
      const ok = d.validateProposal(GOOD_PROPOSAL, GOOD_CTX);
      must(ok.verdict === "ACCEPTED", `a complete proposal was refused (${ok.reasons.map((r) => r.code).join(",")}): the bar is wired shut and refuses everything`);
      let refused = 0;
      for (const field of ["redBefore", "greenAfter", "mutationRed"]) {
        const p = { ...GOOD_PROPOSAL, evidence: { ...GOOD_PROPOSAL.evidence } };
        delete p.evidence[field];
        const v = d.validateProposal(p, GOOD_CTX);
        must(v.verdict === "REFUSED", `a proposal missing evidence.${field} was ACCEPTED: absence is not being treated as failure`);
        refused += 1;
      }
      const noInd = d.validateProposal(GOOD_PROPOSAL, { ...GOOD_CTX, independentCheck: null });
      must(noInd.verdict === "REFUSED", "a proposal with no independent check was ACCEPTED");
      return `accepts a complete proposal; refuses all ${refused} missing transcripts and a missing independent check`;
    },
  },
  {
    name: "prover-executes",
    run: (d, ctx) => {
      const root = sandbox(ctx.tmpRoot, { "widget.mjs": WIDGET, "check.mjs": CHECK });
      try {
        const red = d.runCommand("node check.mjs", { cwd: root });
        const green = d.runCommand("node -e \"process.exit(0)\"", { cwd: root });
        must(red.exitCode === 1, `a known-failing command reported exit ${red.exitCode}: the prover is not executing`);
        must(green.exitCode === 0, `a known-passing command reported exit ${green.exitCode}`);
        must(/FAIL: add\(2, 3\) === -1/.test(red.transcript), "the transcript did not carry the process's own bytes");
        return `observed rc=1 on a known-failing command and rc=0 on a known-passing one; transcripts carry real output`;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "sandbox-refusal",
    run: (d, ctx) => {
      let refused = false;
      try {
        d.assertSandbox(REPO_ROOT);
      } catch {
        refused = true;
      }
      must(refused, "the prover accepted the repository as its working root: the isolation guard is inert");
      const root = sandbox(ctx.tmpRoot, { "a.txt": "x" });
      try {
        d.assertSandbox(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      return `refuses ${REPO_ROOT} and accepts an isolated copy`;
    },
  },
  {
    name: "ledger-writes",
    run: (d, ctx) => {
      const dir = mkdtempSync(join(ctx.tmpRoot, "repair-arm-ledger-"));
      try {
        const l = d.openLedger(dir);
        const sig = "d".repeat(64);
        must(l.read(sig).length === 0, "a fresh ledger was not empty");
        l.append({ signature: sig, verdict: "REFUSED", proposalFingerprint: "beef", reasons: [{ code: "X", detail: "y" }] });
        must(l.read(sig).length === 1, "a refusal wrote no row: a refusal nobody can read is a refusal that never ran");
        must(l.ruledOutFingerprints(sig).includes("beef"), "the refused repair did not come back as ruled out");
        return "a refusal appends exactly one readable row and comes back as ruled out";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "cycle-end-to-end",
    run: (d, ctx) => {
      const dir = mkdtempSync(join(ctx.tmpRoot, "repair-arm-cycle-"));
      const good = sandbox(ctx.tmpRoot, { "widget.mjs": WIDGET, "check.mjs": CHECK, "probe.mjs": 'import { add } from "./widget.mjs";\nprocess.exit(add(10, 1) === 11 ? 0 : 7);\n', "unrelated.mjs": 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("check.mjs", "utf8").includes("add(2, 3)") ? 0 : 9);\n' });
      const nothingWrong = sandbox(ctx.tmpRoot, { "widget.mjs": WIDGET.replace("a - b", "a + b"), "check.mjs": CHECK });
      const quiet = () => {};
      try {
        const defect = { signature: "e".repeat(64), attempts: [], artefacts: ["widget.mjs"], candidatePaths: ["widget.mjs"] };
        const accepted = d.runRepairCycle({
          defect,
          candidateDiff: FIX,
          root: good,
          command: "node check.mjs",
          ledgerDir: dir,
          replayCases: [
            { name: "targeted-via-a-different-input", command: "node probe.mjs", targeted: true },
            { name: "unrelated-recorded-input", command: "node unrelated.mjs" },
          ],
          frozenClosure: ARM_CLOSURE,
          log: quiet,
        });
        must(accepted.verdict === "ACCEPTED", `a provable repair was not accepted end to end: ${JSON.stringify(accepted.reasons)}`);
        must(accepted.proposal?.evidence?.mutationRed?.includes("exit code: 1"), "the accepted proposal carries no red mutation transcript");
        must(accepted.replay?.ran === true, "the independent replay did not run on the accepted proposal");

        // and the same repair with NO unrelated case must be refused: an empty
        // unrelatedChanged means nothing was executed, not that nothing was damaged.
        const notIndependent = d.runRepairCycle({
          defect: { ...defect, signature: "1234abcd".repeat(8) },
          candidateDiff: FIX,
          root: sandbox(ctx.tmpRoot, { "widget.mjs": WIDGET, "check.mjs": CHECK }),
          command: "node check.mjs",
          ledgerDir: dir,
          replayCases: [{ name: "targeted", command: "node check.mjs", targeted: true }],
          frozenClosure: ARM_CLOSURE,
          log: quiet,
        });
        must(notIndependent.verdict === "REFUSED", "a replay consisting only of the reproduction command was accepted as independent");

        const cnr = d.runRepairCycle({
          defect: { ...defect, signature: "f".repeat(64) },
          candidateDiff: FIX,
          root: nothingWrong,
          command: "node check.mjs",
          ledgerDir: dir,
          frozenClosure: ARM_CLOSURE,
          log: quiet,
        });
        must(cnr.verdict === "COULD_NOT_REPRODUCE", `a defect that does not reproduce produced ${cnr.verdict}`);
        must(cnr.proposal === null, "a proposal was produced for a defect that could not be reproduced");
        must(openLedger(dir).read("f".repeat(64)).length === 1, "the could-not-reproduce outcome left no row");
        return "accepts a provable repair with a real unrelated replay case; refuses an unreproducible one and a self-replay; all with ledger rows";
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(good, { recursive: true, force: true });
        rmSync(nothingWrong, { recursive: true, force: true });
      }
    },
  },
];

/** @returns {{ok: boolean, arms: {name:string, ok:boolean, detail:string}[]}} */
export function runArmChecks({ deps = DEFAULT_DEPS, tmpRoot = process.env.REPAIR_TEST_TMP ?? tmpdir(), log = () => {} } = {}) {
  const results = [];
  for (const arm of ARMS) {
    try {
      const detail = arm.run({ ...DEFAULT_DEPS, ...deps }, { tmpRoot });
      results.push({ name: arm.name, ok: true, detail });
      log(`ARM CHECK: ${arm.name} — ${detail}`);
    } catch (err) {
      results.push({ name: arm.name, ok: false, detail: err.message });
      log(`ARM CHECK FAILED: ${arm.name} — ${err.message}`);
    }
  }
  return { ok: results.every((r) => r.ok), arms: results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, arms } = runArmChecks({ log: (l) => process.stdout.write(l + "\n") });
  process.stdout.write(ok ? `ARM CHECK: repair agent armed — ${arms.length}/${arms.length} arms live\n` : `ARM CHECK: REPAIR AGENT IS BLIND — ${arms.filter((a) => !a.ok).map((a) => a.name).join(", ")}\n`);
  process.exit(ok ? 0 : 1);
}
