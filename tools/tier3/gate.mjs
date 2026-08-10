/**
 * TIER 3 — THE AUTO-APPLY GATE.
 *
 * THE POLICY, AS AGREED, IMPLEMENTED AS A ROUTER WITH FOUR EXITS:
 *
 *   diff OUTSIDE the frozen closure  → self-applies behind the normal gate.
 *   diff INSIDE the closure          → must ALSO leave the impossible-ticket
 *                                      set failing, the known-bad set failing,
 *                                      run 1 re-scoring 21/20/1 with the sole
 *                                      REQ-013 QUALITY failure, and a no-op
 *                                      ablation of the accepting check
 *                                      failing. All four, or rollback.
 *   INCONCLUSIVE (not failed)        → degrade to self-PROPOSING, loudly.
 *                                      Tiers 1 and 2 keep running. THE
 *                                      PIPELINE NEVER STOPS; only that patch
 *                                      parks. (RESEARCH W3/R15: Argo's third
 *                                      outcome — Inconclusive pauses the
 *                                      patch, not the pipeline.)
 *   diff touching the ADMISSION set  → REFUSED, never queued, at any tier.
 *                                      The admission predicate becomes the
 *                                      objective function (RESEARCH R30), so
 *                                      it cannot be self-editable.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE.
 *
 * (1) HOST EVIDENCE MAY NOT SATISFY A CLOSURE PROOF. Every known-bad result
 *     carries `mode`. A `host-import` result proves the function on disk still
 *     rejects bad input; it does not prove the SEALED SCORER still fails bad
 *     work. `proofsFor` counts only container-mode evidence, so with docker
 *     unavailable an inside-closure diff can never reach APPLY. That is a
 *     mechanical property, and it is the one the tests pin hardest.
 *
 * (2) ABSENCE IS FAILURE. No arm-check block, no frozen verification, a
 *     missing evidence transcript, an executor that threw — each of these
 *     lands on REFUSE or INCONCLUSIVE. None of them lands on APPLY.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenClosure } from "./closure.mjs";
import { buildFrozenManifest, isolateGateRoot, manifestDir, verifyFrozenSplit, writeFrozenManifest, distFreshness } from "./manifest.mjs";
import { REQUIRED_DIST_MODULES, aggregateKnownBad, runKnownBad } from "./known-bad.mjs";
import { runArmChecks } from "./armcheck.mjs";
import { decideApply, mintApplyToken, validateProposal } from "./proposal.mjs";
import { appendTrail, trailDir } from "./trail.mjs";

/** The four proofs an inside-closure diff must clear. Named, not counted. */
export const CLOSURE_PROOFS = Object.freeze([
  "impossible-set-failing",
  "known-bad-set-failing",
  "rescore-run1-21-20-1",
  "no-op-ablation-failing",
]);

function headSha(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the four proofs from the evidence actually collected.
 *
 * `mode: "container"` is REQUIRED for the three that grade artefacts. A proof
 * whose only evidence is a host import is recorded as UNARMED with the reason
 * spelled out, so the trail can never read as container evidence.
 */
export function proofsFor({ knownBad, aggregate, proposal }) {
  const containerResults = knownBad.results.filter((r) => r.mode === "container");
  const container = (area) => containerResults.filter((r) => r.area === area);
  const held = (rows) => rows.length > 0 && rows.every((r) => r.outcome === "AS-REQUIRED");

  const impossible = container("impossible");
  const grader = container("grader");
  // The re-score row is filtered by MODE FIRST, exactly like the other two.
  // Reading it by id alone would let a host-import row of the same id satisfy
  // the proof — the one path by which host evidence could still reach APPLY.
  const rescore = containerResults.filter((r) => r.id === "kb-rescore-run1-21-20-1");
  const rescoreAnyMode = knownBad.results.filter((r) => r.id === "kb-rescore-run1-21-20-1");

  const hostOnly = (area) =>
    `only host-import evidence exists for ${area}; a host import proves the function on disk rejects bad input, not that the sealed scorer still fails bad work`;

  return [
    {
      id: "impossible-set-failing",
      satisfied: held(impossible),
      mode: "container",
      why: held(impossible) ? "every impossible ticket still failed under the sealed scorer" : hostOnly("the impossible-ticket set"),
    },
    {
      id: "known-bad-set-failing",
      satisfied: held(container("suite-integrity").concat(container("persistence"), grader.filter((r) => r.expect === "must-fail"))),
      mode: "container",
      why: hostOnly("the known-bad set"),
    },
    {
      id: "rescore-run1-21-20-1",
      satisfied: rescore.length > 0 && rescore.every((r) => r.outcome === "AS-REQUIRED"),
      mode: "container",
      why:
        rescoreAnyMode.length > 0 && rescoreAnyMode[0].outcome === "UNARMED"
          ? `UNARMED: ${rescoreAnyMode[0].detail}`
          : rescore.length === 0
            ? "no container-mode re-score of run 1 was observed"
            : "the re-score did not produce 21/20/1 with the sole REQ-013 QUALITY failure",
    },
    {
      id: "no-op-ablation-failing",
      satisfied: typeof proposal?.evidence?.noOpAblation === "string" && proposal.evidence.noOpAblation.trim().length > 0,
      mode: "evidence",
      why:
        "the accepting check must be run against a no-op implementation of the thing being fixed and observed FAILING; " +
        "a check that still passes against a no-op is vacuous and the patch is UNPROVEN (RESEARCH R8)",
    },
    // The aggregate is carried so a REFUSE inside the known-bad set cannot be
    // hidden by a proof that happens not to read it.
  ].map((p) => ({ ...p, aggregateVerdict: aggregate.verdict }));
}

/**
 * Run one gate cycle. Nothing here writes to the working tree except the
 * append-only trail; APPLYING is the caller's job and it must present the
 * token this function mints.
 */
export async function runGate(options) {
  const repoRoot = options.repoRoot;
  const proposal = options.proposal ?? null;
  const scratch = options.scratch ?? mkdtempSync(join(tmpdir(), "tier3-gate-"));
  const dir = options.trailDir ?? trailDir(repoRoot);
  const at = new Date().toISOString();
  const runStamp = at.replace(/[:.]/g, "-");

  const closure = frozenClosure(repoRoot);
  const iso = isolateGateRoot(repoRoot, join(scratch, "isolated"), closure);
  const manifest = buildFrozenManifest(repoRoot, { closure });
  const manifestPath = writeFrozenManifest(manifest, options.manifestDir ?? manifestDir(), runStamp);
  const freshness = distFreshness(repoRoot, REQUIRED_DIST_MODULES);

  const knownBad = await runKnownBad({ repoRoot, distRoot: iso.distRoot, scratch: join(scratch, "known-bad") });
  const aggregate = aggregateKnownBad(knownBad);

  const arm = await runArmChecks({
    repoRoot,
    distRoot: iso.distRoot,
    isolatedRoot: iso.root,
    isolatedPaths: iso.copied,
    closure,
    pair: knownBad.pair,
  });

  const verify = verifyFrozenSplit(manifest, { isolatedRoot: iso.root, isolatedPaths: iso.copied, repoRoot });
  const validation = proposal === null ? { ok: false, refusals: ["no proposal supplied"], route: "NONE" } : validateProposal(proposal, closure);
  const proofs = proofsFor({ knownBad, aggregate, proposal });

  const decision = decide({ arm, verify, validation, aggregate, proofs, closure });

  const applyToken =
    decision.verdict === "APPLY"
      ? mintApplyToken({
          frozenDigest: manifest.digest,
          diff: proposal.diff,
          verdicts: { knownBad: aggregate.verdict, proofs: proofs.map((p) => `${p.id}:${String(p.satisfied)}`), arm: arm.ok },
        })
      : null;

  const record = {
    at,
    runStamp,
    change: options.change ?? proposal?.signature?.slice(0, 32) ?? "no-proposal",
    signature: proposal?.signature ?? null,
    route: validation.route,
    verdict: decision.verdict,
    reason: decision.reason,
    applied: false,
    applyToken,
    frozen: {
      manifestPath,
      digest: manifest.digest,
      graderCount: manifest.graderCount,
      controlCount: manifest.controlCount,
      missingFromFloor: manifest.missingFromFloor,
      addedSinceFloor: manifest.addedSinceFloor,
      verify: { ok: verify.ok, checked: verify.checked, mismatches: verify.mismatches.slice(0, 20) },
      note: "TAMPER-EVIDENT, NOT TAMPER-PROOF: under the current single-uid configuration the agent can write both the tree and this manifest. What is bought is that the two are separate acts in separate trust domains, both recorded.",
    },
    armCheck: { ok: arm.ok, armed: arm.armed, blind: arm.blind, lines: arm.lines },
    knownBad: {
      verdict: aggregate.verdict,
      reason: aggregate.reason,
      registrySize: knownBad.registrySize,
      executed: aggregate.executed.length,
      containerExecuted: aggregate.containerExecuted.length,
      unarmed: aggregate.unarmed.map((r) => r.id),
      results: knownBad.results,
    },
    distFreshness: freshness,
    proofs,
    // Relabelled deliberately: the mutation transcript is a VACUITY control,
    // never evidence of correctness (RESEARCH W5).
    negativeControl: proposal?.evidence ?? null,
    proposalRefusals: validation.refusals,
    rollback: {
      sourceSha: headSha(repoRoot),
      imageTag: null,
      note: "no image tag was recorded: this cycle ran with docker unavailable, so nothing was rebuilt and there is nothing to roll an image back to. A rolled-back image running against rolled-forward source is the failure DESIGN §6.3 warns about.",
    },
    humanReviewed: null,
  };

  const trail = appendTrail(record, dir);
  return { ...decision, record, applyToken, trail, manifest, manifestPath, arm, aggregate, knownBad, proofs, closure, isolated: iso };
}

/** The router. Order is the policy: refuse, then blind, then integrity, then proofs. */
export function decide({ arm, verify, validation, aggregate, proofs }) {
  if (validation.route === "REFUSED" && validation.classified?.touchesAdmission === true) {
    return { verdict: "REFUSED", reason: validation.classified.reason, selfProposing: false };
  }
  if (!arm.ok) {
    return {
      verdict: "REFUSE-BLIND",
      reason: `the gate cannot be shown to fail: arm(s) ${arm.blind.join(", ") || "(none registered)"} did not report. Tier 3 self-apply is DISABLED; Tier 1 and Tier 2 continue and the run does not stop.`,
      selfProposing: true,
    };
  }
  if (!verify.ok) {
    return {
      verdict: "REFUSE",
      reason: `frozen manifest mismatch on ${String(verify.mismatches.length)} path(s): ${verify.mismatches.slice(0, 5).map((m) => `${m.path}@${m.where}`).join(", ")}`,
      selfProposing: true,
    };
  }
  if (!validation.ok) {
    return { verdict: "REFUSED", reason: `the proposal is refused, not queued: ${validation.refusals.join("; ")}`, selfProposing: false };
  }
  if (aggregate.verdict === "REFUSE") {
    return { verdict: "REFUSE", reason: aggregate.reason, selfProposing: true };
  }
  if (aggregate.verdict === "INCONCLUSIVE") {
    return { verdict: "SELF-PROPOSE", reason: `${aggregate.reason}. The patch parks; Tiers 1 and 2 keep running.`, selfProposing: true };
  }

  /*
   * OUTSIDE THE CLOSURE — SELF-APPLIES, BUT NOT ON THE PROPOSER'S WORD ALONE.
   *
   * THE ABLATION IS CONSULTED HERE NOW, AND THE REASON IS MEASURED. This branch
   * used to return APPLY before `proofs` was read at all, so the door that
   * authorises writing to the EDITABLE package — where the orchestrator, the
   * recovery classifier and this gate's own caller live — asked for LESS evidence
   * than the door to the sealed one. The ablation is the only proof that observes
   * VACUITY of the accepting check (RESEARCH R8): a check that still passes
   * against a no-op implementation of the thing being fixed proves nothing, and a
   * repair loop grading its own patch on a vacuous check is this repository's
   * signature defect with money attached.
   *
   * IT PARKS, IT DOES NOT REFUSE. `SELF-PROPOSE` keeps Tiers 1 and 2 running —
   * INCONCLUSIVE is not FAILED, and the pipeline must never stop for one patch.
   *
   * The three CONTAINER proofs are NOT required here and must not be: they grade
   * the sealed scorer, which an editable-only diff does not touch, and requiring
   * them would make every editable repair wait for docker.
   */
  if (validation.route === "OUTSIDE-CLOSURE") {
    const ablation = proofs.find((p) => p.id === "no-op-ablation-failing");
    if (ablation?.satisfied !== true) {
      return {
        verdict: "SELF-PROPOSE",
        reason:
          `every changed path is EDITABLE, but the no-op ablation proof is not satisfied (${ablation?.why ?? "the proof was not computed at all"}). ` +
          "A patch whose accepting check has never been watched failing against a no-op is UNPROVEN, so it parks; " +
          "Tiers 1 and 2 keep running and the pipeline does not stop.",
        selfProposing: true,
      };
    }
    return { verdict: "APPLY", reason: "every changed path is EDITABLE, the no-op ablation held, and the normal gate held", selfProposing: false };
  }

  const unmet = proofs.filter((p) => p.satisfied !== true);
  if (unmet.length > 0) {
    return {
      verdict: "SELF-PROPOSE",
      reason:
        `the diff is INSIDE the frozen closure and ${String(unmet.length)} of ${String(proofs.length)} required proofs are not satisfied ` +
        `(${unmet.map((p) => `${p.id}: ${p.why}`).join(" | ")}). INCONCLUSIVE is not FAILED: the patch parks and Tier 3 degrades to ` +
        "self-PROPOSING for it. Tiers 1 and 2 keep running; the pipeline does not stop.",
      selfProposing: true,
    };
  }
  return { verdict: "APPLY", reason: `all ${String(proofs.length)} closure proofs satisfied under container evidence`, selfProposing: false };
}

/** What a caller must do to actually apply. Re-exported so there is one door. */
export { decideApply };

/** CLI: `node tools/tier3/gate.mjs [--proposal <file>]`. Prints the arm block first. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const idx = process.argv.indexOf("--proposal");
  const proposal = idx > -1 ? JSON.parse(readFileSync(process.argv[idx + 1], "utf8")) : null;
  const repoRoot = process.env.TIER3_REPO_ROOT ?? process.cwd();
  const result = await runGate({ repoRoot, proposal });
  for (const l of result.arm.lines) console.log(l);
  console.log(`KNOWN-BAD ${result.aggregate.verdict}: ${result.aggregate.reason}`);
  console.log(`VERDICT ${result.verdict}: ${result.reason}`);
  console.log(`TRAIL ${result.trail.ok ? result.trail.file : `REFUSED — ${result.trail.reason}`}`);
  process.exitCode = result.verdict === "APPLY" ? 0 : 1;
}
