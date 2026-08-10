/**
 * THE SEAM BETWEEN THE GATE'S VERDICT AND THE TICKET'S FATE.
 *
 * ─── WHY THIS FILE EXISTS ───
 *
 * `tools/tier3/gate.mjs` decides. `dashboard/server/src/supervisor.ts` routes a
 * ticket. Until this file there was nothing in between, so the supervisor's
 * repair step could reach `applied` only by a driver deciding for itself that a
 * patch was good — which is the one path the brief calls a bug. Everything here
 * exists to make the gate's verdict the ONLY input to "was this patch applied".
 *
 * ─── THE ONE MECHANICAL GUARANTEE, AND ITS EXACT SIZE ───
 *
 * A patch is written to a tree by exactly one function in this file
 * ({@link applyGatedPatch}), and that function refuses unless the decision it is
 * handed has `intent === "APPLY"`. {@link classifyGateRecord} returns that intent
 * only when the gate's own record says `verdict: "APPLY"` **and** the record
 * carries an apply token that {@link decideApply} re-mints from the frozen
 * manifest digest, this exact diff, and the verdicts the gate recorded.
 *
 * So "the caller skipped the gate", "the gate refused", and "the gate said APPLY
 * about a different diff" are all the SAME outcome here, and none of them is
 * `applied`. That is `tools/tier3/proposal.mjs`'s L4 design, consumed rather than
 * re-implemented: a second copy of "is this token good" is a second answer to a
 * question that must have one.
 *
 * WHAT THE TOKEN IS NOT, STATED BECAUSE THIS DOCBLOCK USED TO IMPLY OTHERWISE.
 * It said "the token is the only authority this file accepts". THE TOKEN IS A
 * BINDING, NOT AN AUTHORITY. {@link tokenInputs} reads the frozen digest, the
 * known-bad verdict, the proof list and `armCheck.ok` OUT OF THE SAME RECORD it is
 * validating, and `mintApplyToken` is an UNKEYED sha256 over them. So a verifying
 * token proves exactly one thing: this record has not been edited since it was
 * minted, and it is about THIS diff and THIS frozen manifest. It is NOT evidence
 * that a gate ran, that the known-bad set passed, or that any proof was satisfied
 * — {@link armApplyRecord} below fabricates a record and mints a verifying token
 * for it in five lines, and anything that can write a record can do the same.
 *
 * AND NO GUARD BESIDE THE TOKEN CAN FIX THAT, which is why there is none. Adding
 * "refuse unless `record.knownBad.verdict` passed and `record.armCheck.ok` was
 * true" reads MORE self-supplied fields from the same record a forger would be
 * writing, and — measured against `tools/tier3/gate.mjs#decide` — it is also
 * unreachable on every record the real gate produces: `decide` already returns
 * REFUSE/SELF-PROPOSE on a failing known-bad verdict (gate.mjs:241-246) and
 * REFUSE-BLIND on `!arm.ok` (gate.mjs:224), so any record that says APPLY has
 * already cleared both. Such a guard could only ever fire on a fabricated record
 * and could only ever be proved by a probe written to satisfy it — this
 * repository's signature defect, in the file that exists to prevent it. The
 * forgery surface is closed by making the record's PROVENANCE checkable (a keyed
 * or gate-signed trail), not by digesting more of its own contents; that is
 * carried forward and named, not quietly half-built here.
 *
 * ─── WHY `git apply` IS SPELLED OUT HERE AND NOT IMPORTED ───
 *
 * `prover.mjs#applyDiff` is the natural home and it CANNOT be used: it calls
 * `assertSandbox`, which throws for any path inside this repository, by design —
 * proving a repair means running a reproduction three times and that must never
 * happen to the owner's tree. But APPLYING an already-proved patch is precisely
 * an operation on the owner's tree. The two operations have opposite constraints,
 * so this file has its own single door ({@link gitApplyAt}) that both the apply
 * and the revert go through. One implementation, two callers — not two
 * implementations.
 *
 * ─── WHAT IS DELIBERATELY NOT HERE ───
 *
 * No patch author, no prover, no sandbox. Design §5.3 records that the patch
 * author is not built, so on a tree with no candidate diff and no evidence
 * bundle the reachable ceiling is REFUSED or PARKED. Every one of those is a
 * NAMED outcome with its own sentence; none of them is silence, and none of them
 * is `applied`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideApply, mintApplyToken } from "../tier3/proposal.mjs";

/**
 * WHAT A CLASSIFIED GATE RECORD MEANS FOR THE TICKET, IN THREE WORDS.
 *
 *   APPLY   the tree may be written, once, by `applyGatedPatch`.
 *   REFUSE  the bar said no. The proposal joins the ruled-out ledger so the same
 *           idea is not re-proved on the next occurrence of this defect.
 *   PARK    the gate could not reach a verdict, or reached one that is not a
 *           refusal of the IDEA. The PATCH parks; the pipeline does not stop, and
 *           the proposal is NOT ruled out — see `ledgerFingerprint` below.
 */
export const GATE_INTENTS = Object.freeze(["APPLY", "REFUSE", "PARK"]);

/**
 * THE VERDICTS `tools/tier3/gate.mjs#decide` CAN RETURN, restated here as data.
 *
 * Restated rather than imported because importing `gate.mjs` pulls in the frozen
 * manifest builder and the known-bad registry, and this file must be loadable in
 * a 5 ms arm check that touches nothing. A verdict word this list does not know
 * lands on `GATE_VERDICT_UNRECOGNISED`, which is a PARK — never an APPLY.
 */
const KNOWN_VERDICTS = Object.freeze(["APPLY", "SELF-PROPOSE", "REFUSE", "REFUSED", "REFUSE-BLIND"]);

function str(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Re-mint the token inputs from the gate's OWN record.
 *
 * THE INPUTS ARE READ FROM THE RECORD, NOT FROM THE CALLER, and that is the
 * whole mechanism. `mintApplyToken` digests the frozen manifest digest, the diff
 * and the verdict triple; if any of those moved between the gate cycle and this
 * moment — a re-frozen manifest, a re-authored diff, a proof that was not
 * satisfied after all — the re-mint does not match and the patch is not applied.
 */
function tokenInputs(record, diff) {
  return {
    frozenDigest: str(record?.frozen?.digest),
    diff,
    verdicts: {
      knownBad: record?.knownBad?.verdict,
      proofs: (record?.proofs ?? []).map((p) => `${String(p?.id)}:${String(p?.satisfied)}`),
      arm: record?.armCheck?.ok,
    },
  };
}

/**
 * THE ROUTER, PURE, WHICH IS THE ONLY REASON {@link armCheck} CAN DRIVE IT.
 *
 * Eight arms, eight codes, eight sentences. The order is the policy:
 *
 *   1. NO RECORD AT ALL is a PARK, never an APPLY. A gate that did not answer is
 *      not a gate that agreed — the brief's exact words, and the arm the
 *      docker-unavailable machine reaches most often.
 *   2. APPLY IS CHECKED AGAINST THE TOKEN BEFORE IT IS BELIEVED. An `APPLY`
 *      verdict whose token is missing or was minted over another diff is a
 *      REFUSE with its own code, so the ticket's sentence says which of the two
 *      happened.
 *   3. `REFUSE-BLIND` NAMES THE ARMS THAT DID NOT REPORT. With docker away the
 *      container arms cannot run, and an owner reading the ticket at 3am needs
 *      the arm names, not the word "inconclusive".
 *
 * @param {{record: unknown, diff: string}} input
 * @returns {{intent: string, code: string, detail: string, ledgerVerdict: string|null,
 *            ledgerFingerprint: "proposal"|"none", token: string|null}}
 */
export function classifyGateRecord(input) {
  const record = input?.record;
  const diff = str(input?.diff);

  if (typeof record !== "object" || record === null) {
    return {
      intent: "PARK",
      code: "NO_GATE_RECORD",
      detail:
        "the Tier 3 gate produced no readable record for this proposal, so nothing has decided anything about it. " +
        "A gate that did not answer is not a gate that agreed: the patch parks and the tree is untouched.",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      ledgerFingerprint: "none",
      token: null,
    };
  }

  const verdict = str(record.verdict);
  const reason = str(record.reason).trim() || "the gate recorded no reason";

  if (verdict === "APPLY") {
    const inputs = tokenInputs(record, diff);
    const decision = decideApply({ token: record.applyToken, ...inputs });
    if (!decision.apply) {
      return {
        intent: "REFUSE",
        code: "GATE_APPLY_UNTOKENED",
        detail:
          `the gate's record says APPLY but its apply token does not verify against the frozen manifest digest ` +
          `(${inputs.frozenDigest || "absent"}), this diff and the verdicts the record carries — ${decision.reason} ` +
          "No patch is written on a verdict word alone: the token is what binds this record to this diff, and without it " +
          "the record could be about any patch at all.",
        ledgerVerdict: "REFUSED",
        /*
         * "none", NOT "proposal", AND THE REASONING IS THE SAME AS PARK'S.
         *
         * An untokened APPLY means THE BAR SAID YES AND THE PLUMBING DISAGREED —
         * a drift between what `runGate` mints over and what `tokenInputs` reads,
         * or a record that lost a field on its way to disk. It is not a refusal
         * of the IDEA. Ruling the fingerprint out here would blacklist the diff
         * for ever: one wrong field path in `tokenInputs` would silently
         * permanently refuse EVERY patch the gate ever approved, and this arm
         * check would report armed the whole time. The row is still written, so a
         * refusal that ran is distinguishable from one that did not.
         */
        ledgerFingerprint: "none",
        token: null,
      };
    }
    return {
      intent: "APPLY",
      code: "GATE_APPLY",
      detail: `the Tier 3 gate returned APPLY and minted a token that verifies over this exact diff: ${reason}`,
      ledgerVerdict: "ACCEPTED",
      ledgerFingerprint: "proposal",
      token: str(record.applyToken),
    };
  }

  if (verdict === "SELF-PROPOSE") {
    return {
      intent: "PARK",
      code: "GATE_SELF_PROPOSE",
      detail:
        `the Tier 3 gate degraded to SELF-PROPOSING for this patch: ${reason} The PATCH parks, not the pipeline — ` +
        "INCONCLUSIVE is not FAILED, so the proposal stays proposable and is NOT written to the ruled-out ledger.",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      ledgerFingerprint: "none",
      token: null,
    };
  }

  if (verdict === "REFUSE-BLIND") {
    const blind = Array.isArray(record.armCheck?.blind) ? record.armCheck.blind.map((a) => String(a)) : [];
    return {
      intent: "PARK",
      code: "GATE_BLIND",
      detail:
        `the Tier 3 gate cannot be shown to fail, so it refused to authorise anything: arm(s) ` +
        `${blind.join(", ") || "(none were named)"} did not report. This is the docker-unavailable shape — ` +
        "the container arms are how an inside-closure patch satisfies its proofs. A gate that cannot see must " +
        `not become a gate that agrees, so the patch parks and the proposal is NOT ruled out. ${reason}`,
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      ledgerFingerprint: "none",
      token: null,
    };
  }

  if (verdict === "REFUSE") {
    return {
      intent: "REFUSE",
      code: "GATE_REFUSE",
      detail:
        `the Tier 3 gate REFUSED this patch on its evidence: ${reason} The proposal joins the ruled-out ledger so ` +
        "the same idea is refused on sight the next time this defect occurs, instead of being re-proved for ever.",
      ledgerVerdict: "REFUSED",
      ledgerFingerprint: "proposal",
      token: null,
    };
  }

  if (verdict === "REFUSED") {
    return {
      intent: "REFUSE",
      code: "GATE_REFUSED_ADMISSION",
      detail:
        `the Tier 3 gate REFUSED this proposal at admission — it was never queued: ${reason} A diff that touches the ` +
        "admission set is refused at any tier, because the admission predicate would otherwise become the objective " +
        "function. This is a permanent refusal and it is recorded as one.",
      ledgerVerdict: "REFUSED",
      ledgerFingerprint: "proposal",
      token: null,
    };
  }

  return {
    intent: "PARK",
    code: `GATE_VERDICT_UNRECOGNISED_${verdict || "BLANK"}`,
    detail:
      `the gate answered with a verdict word this build does not know (${JSON.stringify(record.verdict)}; known words ` +
      `are ${KNOWN_VERDICTS.join(", ")}). The conservative direction is the only safe one: an unrecognised verdict ` +
      "must never be read as APPLY, because that re-queues a ticket onto a tree nobody patched.",
    ledgerVerdict: "COULD_NOT_REPRODUCE",
    ledgerFingerprint: "none",
    token: null,
  };
}

/* =========================================================================
 * APPLYING, AND UNDOING IT WITHOUT A HUMAN
 * ====================================================================== */

/** The single door to `git apply` in this file. Both directions go through it. */
function gitApplyAt(root, diff, { reverse = false, check = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-gate-patch-"));
  const file = join(dir, "candidate.diff");
  try {
    writeFileSync(file, diff.endsWith("\n") ? diff : diff + "\n", "utf8");
    const args = ["apply", "-p1", ...(reverse ? ["-R"] : []), ...(check ? ["--check"] : []), file];
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function headShaAt(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Write the patch, and write down how to un-write it FIRST.
 *
 * THE ROLLBACK RECORD IS PERSISTED BEFORE `git apply` RUNS, and the order is the
 * point. A crash between the two leaves a record for a patch that was never
 * applied — and `revertGatedPatch` handles that case by NAME
 * (`REVERT_NOT_APPLIED`), because `git apply -R` refuses a patch that is not
 * there. The other order leaves an applied patch nobody can name, on an
 * unattended machine, which is the state no amount of logging recovers from.
 *
 * @param {{root: string, diff: string, decision: object, signature: string,
 *          rollbackDir: string, gateTrail?: string|null, now?: () => Date}} input
 */
export function applyGatedPatch(input) {
  const decision = input?.decision;
  const diff = str(input?.diff);
  /*
   * THE REFUSAL THAT MAKES THE GUARANTEE MECHANICAL. Every caller of this
   * function must have been through `classifyGateRecord`; a caller that wants to
   * apply a patch on its own judgement has to forge an intent, and forging it is
   * a visible edit to a source file rather than an omission.
   */
  if (decision?.intent !== "APPLY") {
    return {
      ok: false,
      code: "APPLY_WITHOUT_GATE_AUTHORITY",
      detail:
        `refusing to write a patch: the gate decision carries intent '${String(decision?.intent)}' (code ` +
        `'${String(decision?.code)}'), not APPLY. The gate decides whether a patch lands; this function only performs ` +
        "the write it authorised.",
      patchId: null,
      rollbackPath: null,
    };
  }
  if (diff.trim() === "") {
    return {
      ok: false,
      code: "APPLY_EMPTY_DIFF",
      detail: "the gate authorised an APPLY over a diff that is empty here, so there is nothing to write and the token cannot have been minted over it",
      patchId: null,
      rollbackPath: null,
    };
  }

  const dry = gitApplyAt(input.root, diff, { check: true });
  if (!dry.ok) {
    return {
      ok: false,
      code: "APPLY_DOES_NOT_FIT",
      detail:
        `the gate authorised this patch but it does not apply to ${input.root} — the tree moved since the proposal was ` +
        `written: ${dry.output.trim().slice(0, 400) || "(git said nothing)"}`,
      patchId: null,
      rollbackPath: null,
    };
  }

  const at = (input.now?.() ?? new Date()).toISOString();
  const patchId = str(decision.token).slice(0, 16) || "untokened";
  const rollbackPath = join(input.rollbackDir, `${patchId}.json`);
  mkdirSync(input.rollbackDir, { recursive: true });
  writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        patchId,
        signature: str(input.signature),
        appliedAt: at,
        root: input.root,
        sourceSha: headShaAt(input.root),
        gateTrail: input.gateTrail ?? null,
        applyToken: str(decision.token),
        diff,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const applied = gitApplyAt(input.root, diff);
  if (!applied.ok) {
    return {
      ok: false,
      code: "APPLY_FAILED_AFTER_CHECK",
      detail:
        `git apply --check passed and the write then failed, which means the tree changed underneath this cycle: ` +
        `${applied.output.trim().slice(0, 400)}. The rollback record at ${rollbackPath} describes a patch that was NOT applied.`,
      patchId,
      rollbackPath,
    };
  }
  return {
    ok: true,
    code: "APPLIED",
    detail: `patch ${patchId} was applied to ${input.root}; it is revertible from ${rollbackPath} with no human involved`,
    patchId,
    rollbackPath,
  };
}

/**
 * Undo an applied patch from its own record. NO HUMAN, NO GUESSING.
 *
 * A missing record and a patch that is not in the tree are DIFFERENT named
 * outcomes, because they mean opposite things: the first is "nobody wrote down
 * what to revert" and the second is "there is nothing to revert". Collapsing
 * them would make a successful revert and a no-op indistinguishable, which is
 * this repository's signature defect in the one place it costs the most.
 *
 * @param {{rollbackPath: string, root?: string}} input
 */
export function revertGatedPatch(input) {
  const path = str(input?.rollbackPath);
  if (path === "" || !existsSync(path)) {
    return {
      ok: false,
      code: "NO_ROLLBACK_RECORD",
      detail: `there is no rollback record at ${path || "(no path given)"}, so nothing here knows what to revert`,
    };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      code: "ROLLBACK_RECORD_UNREADABLE",
      detail: `the rollback record at ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const root = str(input?.root) || str(record?.root);
  const diff = str(record?.diff);
  if (root === "" || diff.trim() === "") {
    return {
      ok: false,
      code: "ROLLBACK_RECORD_INCOMPLETE",
      detail: `the rollback record at ${path} names ${root === "" ? "no root" : "no diff"}, so the revert cannot be performed`,
    };
  }
  const off = gitApplyAt(root, diff, { reverse: true });
  if (!off.ok) {
    return {
      ok: false,
      code: "REVERT_NOT_APPLIED",
      detail:
        `git apply -R refused, which means this patch is not in ${root} — either it was never applied, or something ` +
        `else has already reverted or overwritten it: ${off.output.trim().slice(0, 400) || "(git said nothing)"}`,
    };
  }
  return {
    ok: true,
    code: "REVERTED",
    detail: `patch ${str(record.patchId) || "(unnamed)"} was reverted from ${root}; the tree is back to what it was before the repair`,
  };
}

/* =========================================================================
 * THE ARM CHECK — eight known records, eight answers that must differ, and a
 * real apply/revert round trip in a throwaway git repository.
 * ====================================================================== */

/**
 * A record shaped exactly like the one `runGate` writes, for the ONE probe that
 * must come back APPLY. Its token is minted through the REAL `mintApplyToken`
 * over `tokenInputs`, so if either side of the token formula moves, this probe
 * stops verifying and the arm check reports BLIND.
 */
function armApplyRecord(diff) {
  const record = {
    verdict: "APPLY",
    reason: "the arm check's known-good record",
    frozen: { digest: "f".repeat(64) },
    knownBad: { verdict: "PASS" },
    proofs: [{ id: "no-op-ablation-failing", satisfied: true }],
    armCheck: { ok: true, blind: [] },
    applyToken: null,
  };
  return { ...record, applyToken: mintApplyToken(tokenInputs(record, diff)) };
}

export function armCheck() {
  const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  const wrong = [];
  const applyRecord = armApplyRecord(diff);

  const probes = [
    { want: "NO_GATE_RECORD", intent: "PARK", record: null },
    { want: "GATE_APPLY", intent: "APPLY", record: applyRecord },
    { want: "GATE_APPLY_UNTOKENED", intent: "REFUSE", record: { ...applyRecord, applyToken: "0".repeat(64) } },
    { want: "GATE_SELF_PROPOSE", intent: "PARK", record: { verdict: "SELF-PROPOSE", reason: "a proof was not satisfied" } },
    { want: "GATE_BLIND", intent: "PARK", record: { verdict: "REFUSE-BLIND", reason: "an arm did not report", armCheck: { ok: false, blind: ["A6-rescore"] } } },
    { want: "GATE_REFUSE", intent: "REFUSE", record: { verdict: "REFUSE", reason: "the known-bad set did not hold" } },
    { want: "GATE_REFUSED_ADMISSION", intent: "REFUSE", record: { verdict: "REFUSED", reason: "the diff touches the admission set" } },
    { want: "GATE_VERDICT_UNRECOGNISED_MAYBE", intent: "PARK", record: { verdict: "MAYBE", reason: "a word from a newer build" } },
  ];

  const got = probes.map((probe) => classifyGateRecord({ record: probe.record, diff }));

  probes.forEach((probe, index) => {
    const answer = got[index];
    if (answer.code !== probe.want) wrong.push(`${probe.want} read as ${answer.code}`);
    if (answer.intent !== probe.intent) wrong.push(`${probe.want} carries intent ${answer.intent}, wanted ${probe.intent}`);
    if (str(answer.detail).trim() === "") wrong.push(`${probe.want} carries a blank sentence`);
  });
  const codes = new Set(got.map((g) => g.code)).size;
  const sentences = new Set(got.map((g) => g.detail)).size;
  if (codes !== probes.length) wrong.push(`${probes.length} gate records collapsed into ${codes} code(s)`);
  if (sentences !== probes.length) wrong.push(`${probes.length} gate records collapsed into ${sentences} sentence(s)`);

  /*
   * AND EXACTLY ONE PROBE MAY BE AN APPLY. A mapping that turned two verdicts
   * into APPLY would still have eight distinct codes and eight distinct
   * sentences — the distinctness checks above cannot see it. This one can.
   */
  const applies = got.filter((g) => g.intent === "APPLY").length;
  if (applies !== 1) wrong.push(`${applies} of ${probes.length} gate records were read as APPLY; exactly one may be`);

  /*
   * THE ROUND TRIP, FOR REAL, IN A THROWAWAY REPOSITORY. A revert that has never
   * been performed is a promise, and this repository has twenty-two catalogued
   * instances of a check that can only observe success. So: apply a patch,
   * require the file to have changed, revert from the record alone, require the
   * bytes back — and require that a SECOND revert reports NOT_APPLIED rather
   * than succeeding again.
   */
  const dir = mkdtempSync(join(tmpdir(), "supervisor-gate-arm-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "x"), "a\n", "utf8");
    execFileSync("git", ["add", "x"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=arm@local", "-c", "user.name=arm", "commit", "-qm", "arm"], { cwd: dir });
    const authorised = got[probes.findIndex((p) => p.want === "GATE_APPLY")];
    const applied = applyGatedPatch({ root: dir, diff, decision: authorised, signature: "a".repeat(64), rollbackDir: join(dir, ".rollback") });
    if (!applied.ok) wrong.push(`the authorised patch did not apply in a clean repository: ${applied.detail}`);
    else if (readFileSync(join(dir, "x"), "utf8") !== "b\n") wrong.push("the patch reported applied but the file did not change");
    else {
      const reverted = revertGatedPatch({ rollbackPath: applied.rollbackPath });
      if (!reverted.ok) wrong.push(`the applied patch could not be reverted from its own record: ${reverted.detail}`);
      else if (readFileSync(join(dir, "x"), "utf8") !== "a\n") wrong.push("the revert reported success but the bytes did not come back");
      const twice = revertGatedPatch({ rollbackPath: applied.rollbackPath });
      if (twice.ok) wrong.push("reverting the same patch twice reported success both times, so a no-op revert is indistinguishable from a real one");
    }
    // AND THE NEGATIVE CONTROL ON THE WRITE DOOR: a PARK decision must not write.
    const parked = applyGatedPatch({ root: dir, diff, decision: got[probes.findIndex((p) => p.want === "GATE_SELF_PROPOSE")], signature: "a".repeat(64), rollbackDir: join(dir, ".rollback") });
    if (parked.ok) wrong.push("a PARKED decision was allowed to write a patch, so the gate is not the thing deciding");
  } catch (error) {
    wrong.push(`the apply/revert round trip could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const lines = [
    `ARM CHECK: gate-verdict router returns ${codes} distinct code(s) and ${sentences} distinct sentence(s) on ` +
      `${probes.length} known gate records, exactly ${applies} of them APPLY; ${wrong.length} misread`,
    wrong.length === 0
      ? "ARM CHECK: armed — an APPLY is only reachable with a token that verifies, and an applied patch was reverted from its own record"
      : `ARM CHECK: BLIND — ${wrong.join("; ")}. A repairing ticket may be applied to, or told the wrong thing about, a patch nobody graded.`,
  ];
  return { armed: wrong.length === 0, wrong, lines, probes: probes.length };
}

/**
 * CLI. Two arms, and the second one exists because a sentence promised it.
 *
 * `supervisor-boot.ts` appends "Revert with tools/repair/supervisor-gate.mjs from
 * <rollbackPath>" to every applied outcome — the sentence the owner reads at 3am.
 * Until now this file's CLI ran `armCheck()` and nothing else, so that sentence
 * named a command that did not exist and the honest instruction was "write a node
 * one-liner". `--revert <rollbackPath>` is that command.
 *
 * IT DOES NOT MAKE THE REVERT AUTOMATIC, AND THE SENTENCE MUST NOT SAY IT DOES.
 * `revertGatedPatch` still has NO production caller: nothing on this machine
 * reverts an applied patch on its own. What is bought is that the remediation is
 * one paste instead of a program, and that its refusals (NO_ROLLBACK_RECORD,
 * ROLLBACK_RECORD_UNREADABLE, ROLLBACK_RECORD_INCOMPLETE, REVERT_NOT_APPLIED) are
 * printed with their codes rather than lost inside a thrown stack.
 */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const revertAt = process.argv.indexOf("--revert");
  if (revertAt > -1) {
    const rollbackPath = process.argv[revertAt + 1] ?? "";
    const rootAt = process.argv.indexOf("--root");
    const result = revertGatedPatch({ rollbackPath, ...(rootAt > -1 && process.argv[rootAt + 1] !== undefined ? { root: process.argv[rootAt + 1] } : {}) });
    process.stdout.write(`${result.code}: ${result.detail}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  const arm = armCheck();
  for (const line of arm.lines) process.stdout.write(line + "\n");
  process.exit(arm.armed ? 0 : 1);
}
