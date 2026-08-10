/**
 * ONE REPAIR CYCLE: defect record in, RepairProposal or a refusal out.
 *
 *   reproduce -> prove -> replay independently -> validate -> record
 *
 * The patch AUTHOR is not in this file and deliberately not in this lane. A candidate diff
 * arrives as an input; everything here is the bar it has to clear. That split is the point:
 * the evidence bar is the product, and a component that both writes the patch and grades it
 * is the shape this repository keeps catching itself in.
 *
 * Every exit writes a ledger row — ACCEPTED, REFUSED, COULD_NOT_REPRODUCE, MUTATION_SURVIVED
 * and the rest alike. Ruled-out repairs are first-class records, so the same failed idea is
 * refused on sight the second time instead of being re-proved for ever.
 */

import { evaluateAttempts } from "./loop-guard.mjs";
import { formatVerdict, proposalFingerprint, validateProposal } from "./evidence.mjs";
import { applyDiff, independentReplay, proveRepair } from "./prover.mjs";
import { openLedger } from "./ruled-out.mjs";
import { filesInDiff } from "./diff.mjs";

/**
 * @param {{ defect: object, candidateDiff: string, root: string, command: string,
 *           ledgerDir: string, replayCases?: object[], frozenClosure?: readonly string[],
 *           site?: string, log?: (line: string) => void, timeoutMs?: number }} input
 */
export function runRepairCycle(input) {
  const log = input.log ?? ((line) => process.stdout.write(line + "\n"));
  const defect = input.defect ?? {};
  const signature = defect.signature;
  if (typeof signature !== "string" || !/^[a-f0-9]{8,128}$/i.test(signature)) {
    // The ledger is content-addressed by signature and refuses anything that is not a
    // digest. Catch it here, loudly, rather than letting the store throw mid-cycle.
    log(`REPAIR CYCLE REFUSED  the defect record carries no usable signature (${JSON.stringify(signature)}); it cannot be attributed, de-duplicated or ruled out`);
    return { verdict: "REFUSED", proposal: null, row: null, loop: null, reasons: [{ code: "MISSING_SIGNATURE", detail: "the defect record carries no hex signature" }] };
  }
  /*
   * THE CLOSURE IS REQUIRED HERE, BEFORE THE PROVER SPENDS ANYTHING.
   *
   * `evidence.mjs` refuses NO_FROZEN_CLOSURE at the end of the cycle, which is
   * correct but late: by then the prover has run the reproduction three times.
   * Refusing at entry costs nothing and says the same thing. A caller with no
   * closure to hand can get the real §6.1 list from
   * `tools/tier3/closure.mjs#frozenClosure(repoRoot)`.
   */
  if (!Array.isArray(input.frozenClosure) || input.frozenClosure.length === 0) {
    log(
      "REPAIR CYCLE REFUSED  no frozen closure was supplied, so the owner-only check would refuse nothing and report " +
        "a clean ACCEPT. Absence is treated exactly like failure. Pass frozenClosure from tools/tier3/closure.mjs#frozenClosure.",
    );
    return {
      verdict: "REFUSED",
      proposal: null,
      row: null,
      loop: null,
      reasons: [{ code: "NO_FROZEN_CLOSURE", detail: "the cycle was called with no frozen closure" }],
    };
  }
  const ledger = openLedger(input.ledgerDir);
  const fingerprint = proposalFingerprint({ diff: input.candidateDiff });

  // The anti-loop reading travels with the cycle: it is why this defect is here at all.
  const loop = evaluateAttempts(defect.attempts ?? [], { site: input.site ?? defect.failureClass ?? "", bakeoffCode: defect.bakeoffCode ?? null });
  if (loop.escalate) log(`ANTI-LOOP: escalating at attempt ${loop.escalateAtAttempt} (${loop.arm}) — ${loop.why}`);

  const finish = (verdictName, extra) => {
    const row = ledger.append({ signature, verdict: verdictName, proposalFingerprint: fingerprint, filesChanged: extra.filesChanged ?? [], reasons: extra.reasons ?? [], note: extra.note ?? null });
    return { verdict: verdictName, proposal: extra.proposal ?? null, row, loop, ...extra };
  };

  const alreadyRuledOut = ledger.ruledOutFingerprints(signature);
  if (alreadyRuledOut.includes(fingerprint)) {
    log(`REPAIR PROPOSAL REFUSED  signature=${signature} fingerprint=${fingerprint} reasons=1\n  1. [ALREADY_RULED_OUT] this repair was already tried against this signature and did not clear it`);
    return finish("REFUSED", { reasons: [{ code: "ALREADY_RULED_OUT", detail: "seen before; not re-proved" }], note: "short-circuited before the prover ran" });
  }

  /*
   * THE TREE IS HANDED BACK UNPATCHED ON EVERY EXIT EXCEPT ACCEPTED.
   *
   * MEASURED 2026-08-10: nothing here reverted on any path. `proveRepair` leaves
   * the patch applied by design, the replay RE-APPLIES it, and the REFUSED return
   * handed the tree back patched — so the next cycle over the same root reported
   * `COULD_NOT_REPRODUCE`, "there is nothing here to repair and a patch would be a
   * guess". For an unattended retry loop that is a clean, plausible, WRONG answer,
   * and it burns the ticket's remaining attempts on it.
   *
   * ACCEPTED KEEPS THE PATCH APPLIED, DELIBERATELY, and that is the contract this
   * function now states: an ACCEPTED root is the proof artefact the Tier 3 gate and
   * the applier read; every other verdict means "I changed nothing", and the tree
   * has to agree with the sentence.
   *
   * A FAILED REVERT IS REPORTED, NEVER SWALLOWED. It cannot change the verdict —
   * the patch was already refused — but a root left dirty is a root the next cycle
   * will misread, so it says so.
   */
  const restore = () => {
    const off = applyDiff(input.root, input.candidateDiff, { reverse: true });
    if (!off.ok && !/can't find file|No such file|does not match|patch does not apply|Reversed/i.test(off.output)) {
      log(`REPAIR CYCLE WARNING  the root could not be restored after a non-accepted verdict: ${off.output.trim()}`);
    }
    return off.ok;
  };

  const prove = proveRepair({ root: input.root, command: input.command, diff: input.candidateDiff, timeoutMs: input.timeoutMs });
  if (!prove.ok) {
    restore();
    log(`REPAIR ATTEMPT ${prove.outcome}  signature=${signature} fingerprint=${fingerprint}\n  ${prove.detail ?? ""}`);
    return finish(prove.outcome, { reasons: [{ code: prove.outcome, detail: prove.detail ?? "" }], prove, note: prove.detail ?? null });
  }

  // proveRepair leaves the patch APPLIED; the replay must measure the unpatched tree first,
  // so hand it back over explicitly rather than letting its apply fail and report `ran:false`.
  let replay = { ran: false, targetedChanged: false, unrelatedChanged: [], detail: "no recorded replay cases were supplied" };
  if (input.replayCases?.length) {
    const off = applyDiff(input.root, input.candidateDiff, { reverse: true });
    if (!off.ok) {
      replay = { ran: false, targetedChanged: false, unrelatedChanged: [], detail: `could not unapply the patch for the replay: ${off.output.trim()}` };
    } else {
      replay = independentReplay({ root: input.root, diff: input.candidateDiff, cases: input.replayCases, reproductionCommand: input.command, timeoutMs: input.timeoutMs });
      applyDiff(input.root, input.candidateDiff);
    }
  }

  const files = filesInDiff(input.candidateDiff);
  const closure = input.frozenClosure;
  const proposal = {
    signature,
    diff: input.candidateDiff,
    filesChanged: files,
    touchesFrozenClosure: files.some((f) => closure.some((c) => f === c || f.endsWith("/" + c))),
    evidence: prove.evidence,
    proposedAt: new Date().toISOString(),
  };

  const verdict = validateProposal(proposal, {
    defect,
    frozenClosure: closure,
    ruledOutFingerprints: alreadyRuledOut,
    independentCheck: replay,
  });
  log(formatVerdict(verdict, proposal));
  // ACCEPTED keeps the patch; anything else must not.
  if (verdict.verdict !== "ACCEPTED") restore();

  return finish(verdict.verdict, {
    reasons: verdict.reasons,
    proposal: verdict.verdict === "ACCEPTED" ? proposal : null,
    filesChanged: files,
    prove,
    replay,
    verdictDetail: verdict,
  });
}
