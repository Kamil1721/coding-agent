#!/usr/bin/env node
/**
 * THE SUPERVISOR'S REPAIR ENTRY POINT — one defect record in, one JSON line out.
 *
 * ─── WHY THIS FILE EXISTS ───
 *
 * Measured 2026-08-10: `grep -rn 'tools/repair\|tools/tier3\|tools/replay'
 * dashboard/server/src dashboard/src bakeoff/src | wc -l` → **0**. 110 tests and
 * 16 arm checks, all green, none of them reachable from any process. On the other
 * side of the same gap, `supervisor.ts` settled a structural failure to
 * `repairing` with the sentence "waiting for a repair proposal" and nothing in
 * the tree ever produced one. This is the seam between those two facts: the
 * supervisor spawns this, and this answers with an outcome the supervisor's
 * router already knows how to act on.
 *
 * ─── WHAT IT DOES NOT DO, STATED FIRST BECAUSE IT IS THE HONEST PART ───
 *
 * IT DOES NOT AUTHOR A PATCH. Design §5.3: "THE PATCH AUTHOR IS NOT BUILT", and
 * `runRepairCycle` takes the candidate diff as an INPUT. So on a tree with no
 * candidate diff for the defect, the only truthful answer is `NO_PATCH_AUTHOR` —
 * and it is returned as an `inconclusive` OUTCOME, which the supervisor turns
 * into `blocked` with that sentence on the ticket. That is the whole point of the
 * round: an honest terminal state beats a dead end.
 *
 * IT DOES NOT RUN THE PROVER ON THE WORKING TREE, and it cannot. `prover.mjs`
 * refuses the repository root by design (arm-checked both ways) because proving a
 * repair means applying a patch, running a command, reverting the fix hunk and
 * running it again — on the owner's live tree that is a corrupted workspace. A
 * candidate diff that IS present therefore returns `NO_SANDBOX`, which names the
 * missing piece rather than pretending the diff was graded.
 *
 * WHAT IT DOES DO, AND IT IS THE PIECE THE BRIEF ASKED FOR: it consults the
 * ruled-out ledger, so a proposal already known not to clear this signature is
 * REFUSED on sight instead of being re-proved for ever — and every decision,
 * including the two that mean "I could not decide", appends a ledger row. A
 * refusal that leaves no row is indistinguishable from a refusal that never ran.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposalFingerprint } from "./evidence.mjs";
import { openLedger } from "./ruled-out.mjs";

/** Where the supervisor looks for a hand-authored candidate diff. */
export const DEFAULT_PROPOSALS_DIR = "dashboard/data/repair-proposals";

const HEX = /^[a-f0-9]{8,128}$/i;

/**
 * THE DECISION, PURE, WHICH IS WHY THE ARM CHECK CAN DRIVE IT.
 *
 * Every input is a value: the parsed record, the diff text (or null), and the
 * fingerprints the ledger already knows. No file is read here and no clock is
 * consulted, so the arm check below can feed it inputs whose answers are written
 * in this source — the only kind of arm check that can run at start-up without
 * writing fake rows into the owner's data.
 *
 * @param {{defect: unknown, diff: string|null, diffPath: string,
 *          ruledOutFingerprints: readonly string[]}} input
 * @returns {{kind: "applied"|"refused"|"inconclusive", code: string, detail: string,
 *            patchId?: string, ledgerVerdict: string|null, fingerprint: string|null}}
 */
export function decideRepairOutcome(input) {
  const defect = input.defect;
  if (typeof defect !== "object" || defect === null) {
    return {
      kind: "inconclusive",
      code: "NO_DEFECT_RECORD",
      detail:
        "there is no readable defect record for this run, so there is nothing to attribute a repair to. " +
        "The record is written by orchestrator.ts at every terminal transition to results/defect.json.",
      ledgerVerdict: null,
      fingerprint: null,
    };
  }
  const signature = defect.signature;
  if (typeof signature !== "string" || !HEX.test(signature)) {
    return {
      kind: "inconclusive",
      code: "NO_DEFECT_SIGNATURE",
      detail:
        `the defect record carries no hex signature (${JSON.stringify(signature)}), so it cannot be attributed, ` +
        "de-duplicated or ruled out. The ledger is content-addressed by that digest and refuses anything else.",
      ledgerVerdict: null,
      fingerprint: null,
    };
  }

  if (input.diff === null || input.diff.trim() === "") {
    return {
      kind: "inconclusive",
      code: "NO_PATCH_AUTHOR",
      detail:
        `no candidate diff exists at ${input.diffPath}, and nothing in this build authors one — design §5.3 ` +
        "records that the patch author is deliberately not built, because a component that both writes a patch " +
        "and grades it is the shape this repository keeps catching itself in. Write a diff to that path (or run " +
        "tools/repair/cycle.mjs against an isolated copy by hand) and re-enqueue the ticket.",
      ledgerVerdict: "NO_PATCH_AUTHOR",
      fingerprint: null,
    };
  }

  const fingerprint = proposalFingerprint({ diff: input.diff });
  if (input.ruledOutFingerprints.includes(fingerprint)) {
    return {
      kind: "refused",
      code: "ALREADY_RULED_OUT",
      detail:
        `proposal ${fingerprint} was already tried against defect ${signature} and did not clear it, so it is ` +
        "refused on sight rather than re-proved. This is the a913c871 shape at the repair level: attempt 3 " +
        "re-proposed attempt 1's answer because nothing on disk said it had failed.",
      ledgerVerdict: "REFUSED",
      fingerprint,
    };
  }

  return {
    kind: "inconclusive",
    code: "NO_SANDBOX",
    detail:
      `a candidate diff for defect ${signature} exists at ${input.diffPath} (fingerprint ${fingerprint}) and this ` +
      "build cannot grade it: proving a repair applies the patch, runs the reproduction, reverts the fix hunk and " +
      "runs it again, and prover.mjs refuses to do that to the working tree. Nothing here makes an isolated copy " +
      "yet. Copy the repo and run tools/repair/cycle.mjs against the copy.",
    ledgerVerdict: "COULD_NOT_REPRODUCE",
    fingerprint,
  };
}

/**
 * The IO half: read the record, find the diff, ask the ledger, write the row.
 *
 * @param {{defectPath: string, ledgerDir: string, proposalsDir: string}} input
 */
export function runSupervisorCycle(input) {
  let defect = null;
  if (existsSync(input.defectPath)) {
    try {
      defect = JSON.parse(readFileSync(input.defectPath, "utf8"));
    } catch {
      defect = null;
    }
  }
  const signature = typeof defect?.signature === "string" ? defect.signature : "";
  const diffPath = join(input.proposalsDir, `${signature === "" ? "unattributed" : signature}.diff`);
  const diff = existsSync(diffPath) ? readFileSync(diffPath, "utf8") : null;

  const ledger = openLedger(input.ledgerDir);
  const known = HEX.test(signature) ? ledger.ruledOutFingerprints(signature) : [];
  const decision = decideRepairOutcome({ defect, diff, diffPath, ruledOutFingerprints: known });

  /*
   * THE ROW IS WRITTEN BEFORE THE ANSWER IS PRINTED, and only when there is a
   * signature to address it to. A ledger keyed by a digest cannot record a defect
   * that has no digest, and inventing a bucket for it would put unattributable
   * rows in the same namespace as the addressable ones.
   */
  if (decision.ledgerVerdict !== null && HEX.test(signature)) {
    ledger.append({
      signature,
      verdict: decision.ledgerVerdict,
      proposalFingerprint: decision.fingerprint,
      filesChanged: [],
      reasons: [{ code: decision.code, detail: decision.detail }],
      note: "written by tools/repair/supervisor-cycle.mjs on behalf of the supervisor",
    });
  }
  return decision;
}

/**
 * THE ARM CHECK — four known inputs, four answers that must differ.
 *
 * It runs in a throwaway directory so it can be executed at start-up without
 * touching the owner's ledger, and it fails LOUDLY: merge any two arms of
 * {@link decideRepairOutcome} and the collapsed pair is named. An entry point
 * whose failure mode is "returns something plausible" is the defect this
 * repository has catalogued twenty-two times.
 */
export function armCheck() {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-cycle-arm-"));
  try {
    const sig = "a".repeat(64);
    const probes = [
      { want: "NO_DEFECT_RECORD", input: { defect: null, diff: null, diffPath: "x", ruledOutFingerprints: [] } },
      { want: "NO_DEFECT_SIGNATURE", input: { defect: { signature: "not-a-digest" }, diff: null, diffPath: "x", ruledOutFingerprints: [] } },
      { want: "NO_PATCH_AUTHOR", input: { defect: { signature: sig }, diff: null, diffPath: "x", ruledOutFingerprints: [] } },
      { want: "NO_SANDBOX", input: { defect: { signature: sig }, diff: "--- a\n+++ b\n", diffPath: "x", ruledOutFingerprints: [] } },
      {
        want: "ALREADY_RULED_OUT",
        input: {
          defect: { signature: sig },
          diff: "--- a\n+++ b\n",
          diffPath: "x",
          ruledOutFingerprints: [proposalFingerprint({ diff: "--- a\n+++ b\n" })],
        },
      },
    ];
    const got = probes.map((p) => decideRepairOutcome(p.input));
    const wrong = [];
    probes.forEach((p, i) => {
      if (got[i].code !== p.want) wrong.push(`${p.want} read as ${got[i].code}`);
      if (String(got[i].detail ?? "").trim() === "") wrong.push(`${p.want} carries a blank detail`);
    });
    const codes = new Set(got.map((g) => g.code)).size;
    const details = new Set(got.map((g) => g.detail)).size;
    if (codes !== probes.length) wrong.push(`${probes.length} inputs collapsed into ${codes} code(s)`);
    if (details !== probes.length) wrong.push(`${probes.length} inputs collapsed into ${details} sentence(s)`);
    // AND THE LEDGER MUST ACTUALLY WRITE. A decision that records nothing is a
    // brake that cannot fire the second time: `ruledOutFingerprints` would return
    // [] for ever and the same proposal would be re-proved on every occurrence.
    const ledger = openLedger(dir);
    ledger.append({ signature: sig, verdict: "REFUSED", proposalFingerprint: "deadbeef", reasons: [] });
    if (!ledger.ruledOutFingerprints(sig).includes("deadbeef")) {
      wrong.push("the ruled-out ledger did not read back a row it had just written");
    }
    const lines = [
      `ARM CHECK: supervisor repair entry point returns ${codes} distinct code(s) and ${details} distinct sentence(s) ` +
        `on ${probes.length} known inputs; ${wrong.length} misread`,
      wrong.length === 0
        ? "ARM CHECK: armed — every outcome is named, and the ruled-out ledger reads back what it writes"
        : `ARM CHECK: BLIND — ${wrong.join("; ")}. A repairing ticket may be told the wrong thing about why it stopped.`,
    ];
    return { armed: wrong.length === 0, wrong, lines, probes: probes.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/tools\/)/, ""))) {
  if (process.argv.includes("--armcheck")) {
    const arm = armCheck();
    for (const line of arm.lines) process.stdout.write(line + "\n");
    process.exit(arm.armed ? 0 : 1);
  }
  const defectPath = arg("defect");
  const ledgerDir = arg("ledger");
  if (defectPath === null || ledgerDir === null) {
    process.stderr.write(
      "usage: node tools/repair/supervisor-cycle.mjs --defect <results/defect.json> --ledger <dir> " +
        `[--proposals <dir, default ${DEFAULT_PROPOSALS_DIR}>]\n   or: node tools/repair/supervisor-cycle.mjs --armcheck\n`,
    );
    process.exit(2);
  }
  const decision = runSupervisorCycle({
    defectPath,
    ledgerDir,
    proposalsDir: arg("proposals", DEFAULT_PROPOSALS_DIR),
  });
  // ONE JSON LINE ON STDOUT AND NOTHING ELSE, because the supervisor parses this
  // stream. Every human-readable word is inside `detail`.
  process.stdout.write(JSON.stringify(decision) + "\n");
}
