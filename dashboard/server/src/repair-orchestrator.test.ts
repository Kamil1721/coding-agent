/**
 * repair-orchestrator.test.ts
 *
 * THE PROPERTY THIS FILE DEFENDS is not "the loop works". It is that the loop
 * CANNOT REACH `APPLIED` WITHOUT PROOF. Almost every test below is therefore a
 * negative control: it removes one piece of evidence and asserts the repair does
 * not land. A suite that only checked the happy path would be the defect this
 * repository is named for, sitting on top of the machinery built to prevent it.
 *
 * Every test names the mutation that reddens it. All were run.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { classifyPatch, goalMet, runRepair, scopeRefusals } from "./repair-orchestrator.js";
import type { GoalEvidence, PatchProposal, RepairDeps, RepairRequest, SuiteResult } from "./repair-orchestrator.js";

const GREEN: readonly SuiteResult[] = [
  { name: "server", ran: true, green: true, detail: "2188 tests" },
  { name: "bakeoff", ran: true, green: true, detail: "246 tests" },
];

function evidence(patch: Partial<GoalEvidence> = {}): GoalEvidence {
  return {
    reproducedRedBefore: true,
    greenAfterPatch: true,
    redAgainWhenReverted: true,
    suites: GREEN,
    ...patch,
  };
}

const PROPOSAL: PatchProposal = {
  diff: "--- a/dashboard/server/src/recovery.ts\n+++ b/dashboard/server/src/recovery.ts\n@@ -1 +1 @@\n",
  paths: ["dashboard/server/src/recovery.ts"],
  rationale: "return an unknown price instead of throwing",
};

function deps(patch: Partial<RepairDeps> = {}): RepairDeps {
  return {
    ask: async () => ["is the price table the only source?"],
    answer: async () => ({ sourced: true, answer: "yes — recovery.ts:41" }),
    authorPatch: async () => PROPOSAL,
    review: async () => ({ concerns: [] }),
    reproduce: async () => ({ exitCode: 1, detail: "red" }),
    applyPatch: async () => ({ ok: true, detail: "applied" }),
    revertPatch: async () => ({ ok: true, detail: "reverted" }),
    runSuites: async () => GREEN,
    gate: async () => ({ authorised: true, why: "proofs held" }),
    commit: async () => "abc1234",
    log: () => {},
    ...patch,
  };
}

function request(patch: Partial<RepairRequest> = {}): RepairRequest {
  return {
    signature: "ad220a03e411",
    adjudication: { wakeRepairLane: true },
    reproductionCommand: "node --test dist/recovery.test.js",
    inFlight: new Map(),
    maxAttempts: 2,
    boundedFileCap: 4,
    ...patch,
  };
}

/**
 * A reproduce() that is RED, then GREEN, then RED again — the real ablation
 * shape. The default fake above returns RED every time, which is what most
 * negative controls want; the happy path needs this one.
 */
function ablatingReproduce(): () => Promise<{ exitCode: number; detail: string }> {
  const codes = [1, 0, 1];
  let i = 0;
  return async () => ({ exitCode: codes[i++] ?? 1, detail: `call ${String(i)}` });
}

/* ---- the goal predicate ------------------------------------------------ */

test("the goal is met only when all four conjuncts hold", () => {
  assert.equal(goalMet(evidence()).met, true);
});

/**
 * MUTATION: delete the `reproducedRedBefore` arm from `goalMet` -> RED.
 *
 * This is the conjunct an eager loop drops first, and dropping it is how a
 * defect that was never reproduced gets recorded as fixed: the "after" run is
 * green because it was ALWAYS green.
 */
test("a defect that never reproduced cannot have been fixed", () => {
  const verdict = goalMet(evidence({ reproducedRedBefore: false }));
  assert.equal(verdict.met, false);
  assert.equal(verdict.failedConjunct, "reproduce");
});

/**
 * THE ABLATION IS THE WHOLE DESIGN. Without it, "I changed something and the
 * symptom went away" passes as a repair.
 *
 * MUTATION: delete the `redAgainWhenReverted` arm -> RED.
 */
test("a fix that survives its own removal did not do the fixing", () => {
  const verdict = goalMet(evidence({ redAgainWhenReverted: false }));
  assert.equal(verdict.met, false);
  assert.equal(verdict.failedConjunct, "ablate");
});

/**
 * `[].every(...)` IS `true`, WHICH IS THE TRAP. A fourth conjunct written the
 * obvious way reports "no regressions" for a run that executed no tests.
 *
 * MUTATION: replace the `suites.length === 0` guard with
 * `suites.every((s) => s.green)` -> RED. That is the natural implementation and
 * it is wrong.
 */
test("no suites at all is NOT no regressions", () => {
  const verdict = goalMet(evidence({ suites: [] }));
  assert.equal(verdict.met, false);
  assert.equal(verdict.failedConjunct, "regress");
  assert.match(verdict.why, /no test suite was run/);
});

/**
 * A SUITE THAT DID NOT RUN IS NOT A SUITE THAT PASSED, and the two are separate
 * fields for exactly this reason.
 *
 * MUTATION: drop the `notRun` check, leaving only the `green` check -> RED,
 * because `{ran:false, green:false}` would then read as an ordinary red suite
 * and the message would blame the patch for a suite that never executed.
 */
test("a suite that could not start is refused, and is not reported as broken by the patch", () => {
  const verdict = goalMet(
    evidence({ suites: [{ name: "bakeoff", ran: false, green: false, detail: "runner not found" }] }),
  );
  assert.equal(verdict.met, false);
  assert.equal(verdict.failedConjunct, "regress");
  assert.match(verdict.why, /did not run/);
  assert.doesNotMatch(verdict.why, /broke/, "a suite that never ran must not be reported as broken BY the change");
});

/* ---- write scope ------------------------------------------------------- */

/**
 * §3A.1's hard boundary. The artefact is the thing under measurement; a repair
 * that edits it voids every number the run produced, with no tripwire.
 *
 * MUTATION: make `scopeRefusals` return `[]` -> RED here AND on the loop test
 * below, which is the pair that matters: the predicate and its use.
 */
test("the lane may never write the artefact under measurement", () => {
  const refused = scopeRefusals(["dashboard/runs/run-1/workspace/server.mjs"]);
  assert.equal(refused.length, 1);
  assert.match(refused[0]?.why ?? "", /forged measurement/);
});

test("an ordinary source file is not refused — the control", () => {
  assert.deepEqual(scopeRefusals(["dashboard/server/src/recovery.ts"]), []);
});

/* ---- classification ---------------------------------------------------- */

test("a shared contract makes a patch the owner's call, however small", () => {
  const classified = classifyPatch(["dashboard/server/src/api-types.ts"], 4);
  assert.equal(classified.path, "architectural");
});

/**
 * MUTATION: raise the cap comparison to `>=` -> RED. An off-by-one here silently
 * widens what an unsupervised lane may land.
 */
test("a patch wider than the bounded cap is architectural", () => {
  assert.equal(classifyPatch(["a.ts", "b.ts", "c.ts", "d.ts"], 4).path, "bounded");
  assert.equal(classifyPatch(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], 4).path, "architectural");
});

/* ---- the loop ---------------------------------------------------------- */

test("the happy path applies, commits, and reports its attempts", async () => {
  const result = await runRepair(request(), deps({ reproduce: ablatingReproduce() }));
  assert.equal(result.kind, "APPLIED");
  if (result.kind !== "APPLIED") return;
  assert.equal(result.commit, "abc1234");
  assert.equal(result.attempts, 1);
});

/**
 * §3A, and the owner's sharpest constraint: the lane must not fire when the
 * WEBSITE is what broke.
 *
 * MUTATION: delete the `wakeRepairLane` guard -> RED. Note the second assertion:
 * it must refuse WITHOUT spending a model call, because the lane runs on the
 * owner's own subscription quota.
 */
test("an ARTEFACT failure does not wake the lane, and costs nothing", async () => {
  let asked = 0;
  const result = await runRepair(
    request({ adjudication: { wakeRepairLane: false } }),
    deps({
      ask: async () => {
        asked += 1;
        return [];
      },
    }),
  );
  assert.equal(result.kind, "NOT_MINE");
  assert.equal(asked, 0, "the lane spent a model call deciding not to run");
});

/**
 * MUTATION: drop the `inFlight` lookup -> RED. Dedup is by DEFECT SIGNATURE and
 * never by run: two runs can surface one defect, and it is one repair (§13.2).
 */
test("a defect already being repaired under another run is not repaired twice", async () => {
  const result = await runRepair(
    request({ inFlight: new Map([["ad220a03e411", "run-earlier"]]) }),
    deps(),
  );
  assert.equal(result.kind, "ALREADY_REPAIRING");
  if (result.kind !== "ALREADY_REPAIRING") return;
  assert.equal(result.underRunId, "run-earlier");
});

/**
 * MUTATION: let a null reproductionCommand fall through into the loop -> RED.
 * Without a reproduction, conjunct 1 can never hold, so every attempt is spent
 * arriving at a patch nobody can trust.
 */
test("a defect with no reproduction is refused before any token is spent", async () => {
  let authored = 0;
  const result = await runRepair(
    request({ reproductionCommand: null }),
    deps({
      authorPatch: async () => {
        authored += 1;
        return PROPOSAL;
      },
    }),
  );
  assert.equal(result.kind, "NO_REPRODUCTION");
  assert.equal(authored, 0);
});

/**
 * §10.3. A question the lane cannot source is the OWNER's, and answering it from
 * the model's own priors is the failure the whole design refuses.
 *
 * MUTATION: treat an unsourced answer as sourced -> RED, and the lane would
 * proceed to patch on a guess.
 */
test("a question with no evidence source parks for the owner instead of being guessed", async () => {
  const result = await runRepair(
    request(),
    deps({
      ask: async () => ["should an earned DID NOT PASS re-queue the build?"],
      answer: async () => ({ sourced: false, answer: "" }),
    }),
  );
  assert.equal(result.kind, "PARKED_FOR_OWNER");
  if (result.kind !== "PARKED_FOR_OWNER") return;
  assert.equal(result.questions.length, 1);
});

/**
 * THE CASE THE ACCEPTANCE TEST ACTUALLY HITS. The `APP_DIR` grader defect is
 * fixed in `bakeoff/src/scorer-container.ts`, and `bakeoff/src/` is refused as
 * the frozen grader closure. The lane must diagnose it, author the patch, and
 * then STOP — handing the owner a patch rather than applying one.
 *
 * MUTATION: remove the `scopeRefusals` check from the loop -> RED, and an
 * unsupervised agent edits its own grader.
 */
test("a patch landing outside the writable scope is parked WITH the diff, not applied", async () => {
  let committed = 0;
  const result = await runRepair(
    request(),
    deps({
      authorPatch: async () => ({
        diff: "--- a/bakeoff/src/scorer-container.ts\n+++ b/bakeoff/src/scorer-container.ts\n@@ -1 +1 @@\n",
        paths: ["bakeoff/src/scorer-container.ts"],
        rationale: "export APP_DIR alongside APP_ROOT",
      }),
      commit: async () => {
        committed += 1;
        return "nope";
      },
    }),
  );
  assert.equal(result.kind, "PARKED_SCOPE_REFUSED");
  if (result.kind !== "PARKED_SCOPE_REFUSED") return;
  assert.match(result.refusals[0]?.why ?? "", /grader closure/);
  assert.ok(result.diff.length > 0, "the owner must receive the patch, not just a refusal");
  assert.equal(committed, 0);
});

/**
 * MUTATION: make the loop ignore `goalMet` and gate on `greenAfterPatch` alone
 * -> RED. This is the single most dangerous simplification available, because
 * the symptom really has gone away.
 */
test("a patch whose removal does NOT bring the fault back is never applied", async () => {
  let gated = 0;
  const result = await runRepair(
    request({ maxAttempts: 1 }),
    deps({
      // red, green, then green again when reverted: the ablation fails.
      reproduce: (() => {
        const codes = [1, 0, 0];
        let i = 0;
        return async () => ({ exitCode: codes[i++] ?? 0, detail: "" });
      })(),
      gate: async () => {
        gated += 1;
        return { authorised: true, why: "" };
      },
    }),
  );
  assert.equal(result.kind, "GOAL_NOT_MET");
  assert.equal(gated, 0, "the gate was consulted for a patch that failed its own ablation");
});

/**
 * MUTATION: treat a gate refusal as advisory -> RED. The gate is the only thing
 * standing between an unsupervised agent and the tree; §3 gives it the last word
 * precisely because everything upstream of it is loosened.
 */
test("a gate refusal is final, and nothing is committed", async () => {
  let committed = 0;
  const result = await runRepair(
    request(),
    deps({
      reproduce: ablatingReproduce(),
      gate: async () => ({ authorised: false, why: "an arm was UNARMED" }),
      commit: async () => {
        committed += 1;
        return "x";
      },
    }),
  );
  assert.equal(result.kind, "REFUSED_BY_GATE");
  assert.equal(committed, 0);
});

/**
 * §3B: a patch that only reaches the working tree is erased by the next
 * checkout, and the same defect fires again having taught the system nothing.
 *
 * MUTATION: delete the `commit` call -> RED.
 */
test("an applied repair is COMMITTED, so it survives the next checkout", async () => {
  const messages: string[] = [];
  const result = await runRepair(
    request(),
    deps({
      reproduce: ablatingReproduce(),
      commit: async (message) => {
        messages.push(message);
        return "deadbee";
      },
    }),
  );
  assert.equal(result.kind, "APPLIED");
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /ad220a03e411/, "the commit message names the defect it closes");
});

/**
 * MUTATION: remove the attempt bound from the `while` -> the fake never
 * succeeds and the test HANGS rather than reddening. A hang is a failure too,
 * but a slow one, so the assertion pins the count as well as the outcome.
 */
test("the loop is bounded, and reports how many attempts it spent", async () => {
  let authored = 0;
  const result = await runRepair(
    request({ maxAttempts: 3 }),
    deps({
      authorPatch: async () => {
        authored += 1;
        return null;
      },
    }),
  );
  assert.equal(result.kind, "GOAL_NOT_MET");
  if (result.kind !== "GOAL_NOT_MET") return;
  assert.equal(result.attempts, 3);
  assert.equal(authored, 3);
});


/* =========================================================================
 * THE WRITE SCOPE IS READ FROM THE DIFF, NOT FROM WHAT THE AUTHOR CLAIMS
 *
 * Found 2026-08-16 by a debugfix lens, in this file, two hours after it was
 * written. `runRepair` checked `proposal.paths` — a field the MODEL-BACKED patch
 * author declares — while `applyPatch` handed `git apply` the `proposal.diff`.
 * Nothing reconciled them.
 *
 * Measured: a proposal declaring an innocuous file, carrying a diff header for
 * `bakeoff/src/scorer-container.ts`, returned `APPLIED` and was committed. The
 * unattended lane would have edited the frozen grader — the exact thing this
 * file's header says no model-backed seam may reach.
 * ====================================================================== */

const REAL_DIFF = (path: string): string => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`;

/**
 * TWO GUARDS STAND HERE AND NEITHER ALONE IS NECESSARY — measured, and stated
 * that way because the first draft of this docblock claimed otherwise.
 *
 *   A. the scope check reads the DIFF (`scopeRefusals(targets.files)`)
 *   B. a declared/actual disagreement is refused outright
 *
 * Any lie that defeats A is caught by B, and vice versa, so they are redundant
 * by construction. MUTATION RESULTS, run rather than reasoned:
 *
 *   revert A to `scopeRefusals(proposal.paths)`   -> GREEN. B catches it.
 *   delete B alone                                -> GREEN. A catches it.
 *   BOTH                                          -> RED, `kind === "APPLIED"`,
 *                                                    committed. The measured bypass.
 *
 * So this test pins the PAIR, not either member, and that is the honest claim.
 * Both are kept deliberately: A is the conceptually correct check (read what the
 * applier reads), B is cheap and catches a class A cannot see on its own — a
 * patch author that misdescribes its own work has a defect or an intent, and
 * either is worth stopping before an unattended commit.
 */
test("a patch that LIES about which files it touches is refused, not applied", async () => {
  let committed = 0;
  const result = await runRepair(
    request(),
    deps({
      reproduce: ablatingReproduce(),
      authorPatch: async () => ({
        // Declares something harmless…
        paths: ["dashboard/server/src/recovery.ts"],
        // …and actually patches the frozen grader.
        diff: REAL_DIFF("bakeoff/src/scorer-container.ts"),
        rationale: "innocuous-looking",
      }),
      commit: async () => {
        committed += 1;
        return "x";
      },
    }),
  );
  assert.equal(result.kind, "PARKED_SCOPE_REFUSED", "the diff, not the declaration, decides the scope");
  assert.equal(committed, 0, "an unattended lane committed a patch to the grader it is not allowed to edit");
});

/**
 * A rename-only diff has no `--- `/`+++ ` pair, so `diffShape` yields NO files —
 * and "no files" would sail straight through a check that only looks for refused
 * prefixes among the files it found.
 *
 * MUTATION: make `patchTargets` return `{files: [], problem: null}` for an empty
 * set -> RED, and a patch whose targets cannot be read gets applied.
 */
test("a patch whose targets cannot be read is refused, because unreadable is not empty", async () => {
  const result = await runRepair(
    request(),
    deps({
      reproduce: ablatingReproduce(),
      authorPatch: async () => ({
        paths: ["dashboard/server/src/recovery.ts"],
        diff: "diff --git a/x b/y\nrename from dashboard/server/src/recovery.ts\nrename to bakeoff/src/gate.ts\n",
        rationale: "a rename nobody can scope",
      }),
    }),
  );
  assert.equal(result.kind, "PARKED_SCOPE_REFUSED");
  if (result.kind !== "PARKED_SCOPE_REFUSED") return;
  assert.match(result.refusals[0]?.why ?? "", /unreadable scope is not an empty one/);
});

/**
 * `refusedPathReason` is a raw `startsWith`, so a path that means the same thing
 * spelled differently walks past it.
 *
 * MUTATION: drop the `normaliseRequestedPath` call from `scopeRefusals` -> RED.
 */
test("a refused path spelled awkwardly is still refused", async () => {
  assert.equal(scopeRefusals(["./bakeoff/src/scorer-container.ts"]).length, 1, "a leading ./ must not defeat the prefix test");
  assert.equal(scopeRefusals(["/etc/passwd"]).length, 1, "an absolute path cannot be scoped and must be refused");
  assert.equal(scopeRefusals(["../../etc/passwd"]).length, 1, "nor can one that climbs out of the repo");
  // THE CONTROL: an ordinary in-scope path is still allowed after normalising.
  assert.deepEqual(scopeRefusals(["dashboard/server/src/recovery.ts"]), []);
});

/**
 * THE HONEST-PATCH CONTROL. Every test above refuses something; without this one
 * the whole set is satisfied by a function that refuses everything.
 */
test("a patch that describes itself accurately and stays in scope still applies", async () => {
  const result = await runRepair(
    request(),
    deps({
      reproduce: ablatingReproduce(),
      authorPatch: async () => ({
        paths: ["dashboard/server/src/recovery.ts"],
        diff: REAL_DIFF("dashboard/server/src/recovery.ts"),
        rationale: "return an unknown price instead of throwing",
      }),
    }),
  );
  assert.equal(result.kind, "APPLIED");
});

/* =========================================================================
 * OUTCOMES THAT WERE REACHABLE IN CODE AND UNREACHABLE IN THE SUITE
 *
 * A debugfix lens found three: `PARKED_ARCHITECTURAL` was never produced by any
 * test (so deleting its guard was silent), the `spike` verdict was computed and
 * dropped, and a failed apply was reported as "the change did not stop the fault
 * happening" — a sentence about a patch that never reached the tree.
 * ====================================================================== */

/**
 * MUTATION: delete the `classification.path === "architectural"` guard in the
 * loop -> RED. Before this test that deletion was completely silent.
 */
test("a patch touching a shared contract parks for the owner and is never applied", async () => {
  let committed = 0;
  const result = await runRepair(
    request(),
    deps({
      reproduce: ablatingReproduce(),
      authorPatch: async () => ({
        paths: ["dashboard/server/src/api-types.ts"],
        diff: REAL_DIFF("dashboard/server/src/api-types.ts"),
        rationale: "widen a shape other components compile against",
      }),
      commit: async () => {
        committed += 1;
        return "x";
      },
    }),
  );
  assert.equal(result.kind, "PARKED_ARCHITECTURAL");
  assert.equal(committed, 0);
});

/**
 * MUTATION: delete the `classification.path === "spike"` arm -> RED, and an
 * empty patch is applied and committed. Its own classification says "the repair
 * changed no files, so it is a finding rather than a fix".
 */
test("a patch that changes nothing is not committed as a repair", async () => {
  let committed = 0;
  const result = await runRepair(
    request({ maxAttempts: 1 }),
    deps({
      reproduce: ablatingReproduce(),
      // A well-formed diff with a header pair but no file the shape reader keeps.
      authorPatch: async () => ({ paths: [], diff: "--- a/dev/null\n+++ b/dev/null\n", rationale: "nothing" }),
      commit: async () => {
        committed += 1;
        return "x";
      },
    }),
  );
  assert.notEqual(result.kind, "APPLIED");
  assert.equal(committed, 0);
});

/**
 * A PATCH THAT WOULD NOT APPLY HAS NOT BEEN TESTED, and must not be described as
 * one that failed on its merits.
 *
 * MUTATION: restore `const after = applied.ok ? await deps.reproduce() : {exitCode: 1, …}`
 * -> the reason becomes "the change did not stop the fault happening", which is a
 * claim about a patch that never reached the tree, and this goes RED.
 */
test("a patch that will not apply says so, rather than being blamed for not working", async () => {
  const result = await runRepair(
    request({ maxAttempts: 1 }),
    deps({
      reproduce: ablatingReproduce(),
      applyPatch: async () => ({ ok: false, detail: "hunk #1 FAILED at 42" }),
    }),
  );
  assert.equal(result.kind, "GOAL_NOT_MET");
  if (result.kind !== "GOAL_NOT_MET") return;
  assert.match(result.why, /would not apply/);
  assert.doesNotMatch(result.why, /did not stop the fault/, "that sentence is about a patch that was actually tried");
});

/**
 * MUTATION: delete the `notes.push(\`reviewer concern: …\`)` line -> RED. The
 * concerns previously reached `deps.log` only, so a second attempt re-authored
 * the same patch knowing nothing about the first review — while the docblock
 * claimed they were "recorded for the report and for the next attempt".
 */
test("a reviewer's concerns reach the next attempt's author, not just the log", async () => {
  /*
   * THE FIXTURE HAS TO REACH `review`, WHICH RUNS AFTER `authorPatch`. An earlier
   * draft returned null from the author to force a second attempt — that skips
   * review entirely, so no concern was ever produced and the test failed for the
   * wrong reason. Instead the author succeeds and the GOAL fails (the default
   * `reproduce` is red every time, so `greenAfterPatch` is false), which loops.
   */
  const seen: string[][] = [];
  await runRepair(
    request({ maxAttempts: 2 }),
    deps({
      review: async () => ({ concerns: ["this widens the retry bound as a side effect"] }),
      authorPatch: async (_signature, notes) => {
        seen.push([...notes]);
        return PROPOSAL;
      },
    }),
  );
  assert.equal(seen.length, 2, "the fixture must reach a second attempt, or this measures nothing");
  assert.ok(
    seen[1]?.some((note) => note.includes("widens the retry bound")),
    "the second attempt was authored without the first review's objection",
  );
});
