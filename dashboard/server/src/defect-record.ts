/**
 * defect-record.ts — the two records a terminal transition leaves behind, and
 * the reason they are written even when there is nothing to say.
 *
 * ─── WHAT THIS REPLACES ───
 *
 * Run `a913c871` died at 22:31:04.532Z after 1h26m54s and left, in the harness,
 * a `runs` row with a status and a prose `failure_reason`. Its three authoring
 * attempts existed in NO harness artefact at all: they were reconstructed nine
 * hours later from the Claude Code CLI's own session transcripts, keyed by the
 * seat's cwd. A different cwd, or retention off, and the post-mortem would have
 * had nothing.
 *
 * So two files are written at every terminal transition:
 *
 *   results/defect.json          — one machine-readable row per terminal run
 *   results/authoring-trail.json — what the spec phase attempted, on BOTH paths
 *
 * plus an append-only, content-addressed shard at
 * `data/defects/<signature>.jsonl`, so the second occurrence of a class is
 * findable without reading every run directory.
 *
 * ─── THE RULE THIS MODULE IS BUILT AROUND ───
 *
 * ABSENCE IS NOT EMPTINESS. `violations: []` reads as "the classifier looked and
 * found none"; `attempts: []` reads as "the seat made no attempt". Both are
 * false on a run whose evidence simply does not travel yet — the structured
 * `DefectDetail` of the design's §3.2 is a digest-moving change that has not
 * landed, and `BakeoffError` carries no `attempts`. Every unavailable field
 * therefore carries an explicit `*Available: false` flag and a sentence saying
 * why. A record that quietly reports zero is this repository's signature defect
 * with a JSON file behind it.
 *
 * ─── AND WHY NOTHING HERE PARSES PROSE ───
 *
 * `PhaseFailureSignals` has no `message` field and its docblock forbids one,
 * citing the 2026-08-04 death by name. The signature is built from a SITE and a
 * sorted list of FIELD PATHS — structured values written at the throw site —
 * and never from the failure text. `failureReason` is carried verbatim into the
 * record for a human to read; nothing in this file reads it back.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One field the validator refused, as the design's shared contract carries it. */
export interface DefectViolation {
  readonly path: string;
  readonly expected: string;
  readonly got: string;
}

/**
 * One authoring attempt as the record carries it.
 *
 * `at` IS OFTEN THE EMPTY STRING, AND THAT IS A MEASUREMENT. `AuthoringAttempt`
 * (spec-agent.ts) has no clock field, so an attempt read from the frozen audit
 * file has no timestamp to report. Empty means "this attempt carries no
 * instant", never "the epoch": `attemptsAvailable` and this field are read
 * together.
 */
export interface DefectAttempt {
  readonly n: number;
  readonly at: string;
  readonly problems: readonly string[];
}

/**
 * One recorded case the evidence bar replays around the fix.
 *
 * The shape is `tools/repair/prover.mjs#independentReplay`'s, verbatim, because
 * that is the only reader: `{name, command, targeted}`. A `targeted` case must
 * change its exit code across the patch; every other case must NOT.
 */
export interface DefectReplayCase {
  readonly name: string;
  readonly command: string;
  readonly targeted: boolean;
}

/**
 * THE REPRODUCTION — a command the evidence bar can actually execute, or a NAMED
 * absence saying why no such command exists for this defect.
 *
 * ─── THE CONSTRAINT THAT DECIDES EVERY ARM BELOW ───
 *
 * `tools/repair/isolate.mjs` builds the tree the bar proves on with
 * `git archive HEAD | tar -x`. MEASURED 2026-08-12 by building one:
 *
 *   23 MB, 4 top-level entries, no `node_modules` anywhere (gitignored),
 *   no `bakeoff/dist` and no `dashboard/server/dist` (build outputs),
 *   no `dashboard/runs` and no `dashboard/data` (gitignored, .gitignore:24-25).
 *
 * HALF OF THAT BOUND IS GONE AS OF 2026-08-12, AND THE REST OF IT DECIDES MORE
 * THAN IT DID. `isolate.mjs` now clones `bakeoff/node_modules` into the copy and
 * runs `tsc --noEmit` once to find out whether the result compiles — measured over
 * three consecutive real isolations (spread under 3%): 23 MB extracted in 141-144ms,
 * 57 MB of dependencies cloned in 300-317ms (copy-on-write, 1.9 MB of real disk),
 * probe 1013-1021ms, 1454-1481ms for the whole isolation against a 60s
 * PROVE_BUDGET_MS. A copy that does NOT compile is refused by name
 * (`supervisor-cycle.mjs#COPY_NOT_BUILDABLE`) before any reproduction runs, so a
 * broken toolchain can no longer arrive as a red reproduction. What has NOT
 * changed: `dashboard/runs` and `dashboard/data` are gitignored and are not in the
 * copy, and the copy is HEAD rather than the working tree.
 *
 * THE BUILD BELONGS INSIDE THE REPRODUCTION COMMAND, NEVER AT ISOLATION TIME, AND
 * THIS WAS MEASURED IN BOTH DIRECTIONS RATHER THAN ARGUED. The prover applies the
 * patch, runs the command, reverts the fix hunk and runs it again — so a `dist`
 * compiled ONCE, at isolation, is HEAD's `dist` for all three runs, and a patch to
 * `bakeoff/src` compiles to nothing the command can observe. Executed on a real
 * isolated copy carrying run `aa6e721e`'s own defect (`UBIQUITOUS_DETERMINERS`
 * narrowed back to `(?:The)`) with the diff that widens it:
 *
 *   command carries its own build step:
 *     cd bakeoff && ./node_modules/.bin/tsc -p tsconfig.json && node --test dist/spec-validate.test.js
 *     exit 1 (1046ms) → exit 0 (1050ms) → exit 1 on revert (1049ms)
 *     proveRepair: PROVEN in 4160ms, no-op ablation held
 *   dist built once at isolation, same diff, build removed from the command:
 *     exit 1 (127ms) → exit 1 (126ms)  ← the CORRECT patch, red
 *     proveRepair: NOT_FIXED, "the check still fails with the patch applied"
 *
 * So every command emitted by this module that needs compiled output MUST carry
 * `cd bakeoff && ./node_modules/.bin/tsc -p tsconfig.json && …` in the command
 * itself. `./node_modules/.bin/tsc`, not `npx tsc`: npx may reach the network, and
 * 1.05s per run is comfortably inside `MIN_COMMAND_TIMEOUT_MS` (5s).
 *
 * The reproduction command may otherwise read ONLY files tracked at HEAD. Four
 * commands were run inside a bare copy to fix that boundary rather than assume it:
 *
 *   node --test tools/repair/loop-guard.test.mjs        exit 0  (9 tests, 66ms)
 *   node --test "tools/**\/*.test.mjs"                   exit 1  (20/123 fail —
 *                                                       every failure is
 *                                                       `bakeoff/dist/tier0.js`
 *                                                       missing)
 *   node tools/replay/replay.mjs                        exit 1  (loads
 *                                                       `bakeoff/dist/scorer-protocol.js`,
 *                                                       a build output)
 *   node --test dashboard/server/src/defect-record.trail.test.ts
 *                                                       exit 1  ERR_MODULE_NOT_FOUND
 *                                                       on `./defect-record.js`
 *
 * The last one is the trap this type exists to avoid. Node 25.9.0 strips types
 * natively, so a `.ts` test file LOOKS runnable — but it does not remap a
 * relative `.js` specifier onto its `.ts` source, so every TypeScript module in
 * this repository that imports a sibling fails to load. A command that exits
 * non-zero for that reason is RED before the patch AND red after it: the bar
 * reads the first as "the defect reproduced" and the second as `NOT_FIXED`, and
 * a correct patch is recorded as a patch that does not work. A reproduction that
 * cannot run is strictly worse than none, which is why the absence arm exists and
 * why nothing here emits a command that has not been executed on a real copy.
 *
 * ─── WHAT MAKES A DEFECT REPRODUCIBLE, AS A MECHANISM AND NOT AS A NAME ───
 *
 * Two conditions, both measurable:
 *   1. THE ARGUMENTS OF THE FAILING CALL TRAVEL AS VALUES. `BakeoffError`
 *      (bakeoff/src/contracts.ts:75) carries `code`, a prose `message` and a
 *      prose `remediation` — and nothing else. Recovering a call's arguments from
 *      that message is the 2026-08-04 prose-matching mechanism, forbidden by
 *      this module's own header. So the arguments have to come from somewhere
 *      structured, which today means the `runs` row.
 *   2. THE CALLEE LOADS IN THE COPY WITH BARE NODE. Measured in the copy:
 *      `bakeoff/src/contracts.ts` has ZERO relative imports and
 *      `await import("./bakeoff/src/contracts.ts")` returned 21 exports at exit 0.
 *
 * Exactly one pair satisfies both today, and {@link planReproduction} writes a
 * command only for that pair. Everything else gets a named absence.
 */
export type DefectReproduction =
  | {
      readonly available: true;
      /** Run from the root of the isolated copy, through `sh -c`. */
      readonly command: string;
      readonly cases: readonly DefectReplayCase[];
      /** The measurement that says this command runs on `git archive HEAD`. */
      readonly why: string;
    }
  | {
      readonly available: false;
      /** Stable, machine-readable. Never prose, and never absent. */
      readonly code: string;
      /** What is missing, and what would have to change to close it. */
      readonly reason: string;
    };

export interface DefectRecord {
  readonly runId: string;
  readonly at: string;
  readonly phase: string;
  readonly failureClass: string;
  readonly bakeoffCode: string | null;
  /** sha256 hex of the site plus the sorted field paths. Never prose. */
  readonly signature: string;
  readonly violations: readonly DefectViolation[];
  readonly attempts: readonly DefectAttempt[];
  readonly artefacts: readonly string[];
  readonly repairable: boolean;

  /* ---- beyond the shared contract, and each one earns its place ---- */

  /** The terminal status this record was written at. `passed` records exist too. */
  readonly status: string;
  /** The signature's first ingredient, kept readable beside the digest. */
  readonly site: string;
  /** The signature's second ingredient, already sorted. */
  readonly fieldPaths: readonly string[];
  /** False when nothing structured was available — see the module docblock. */
  readonly violationsAvailable: boolean;
  readonly attemptsAvailable: boolean;
  /** Non-empty exactly when something above is `false`. */
  readonly unavailable: readonly string[];
  /** Carried verbatim for a human. NOTHING in this program parses it. */
  readonly failureReason: string | null;
  /**
   * How to watch this defect fail, or the named reason nobody can.
   *
   * ALWAYS PRESENT, EVEN WHEN THERE IS NOTHING TO SAY, for the same reason
   * `unavailable` is: `tools/repair/supervisor-cycle.mjs#readReproduction`
   * answers `NO_REPRODUCTION_COMMAND` for a record with no block and for a record
   * whose defect class genuinely has no runnable command, and those are different
   * facts about a run. The absence variant carries the second one by name.
   */
  readonly reproduction: DefectReproduction;
}

/**
 * The stable fingerprint.
 *
 * SITE PLUS SORTED FIELD PATHS, HASHED. Sorted because `a913c871`'s attempts
 * named `id`, then `kind`, then `kind` again with `id` lost — the same defect
 * arriving in three orders, and an order-sensitive fingerprint would call them
 * three different defects and never fire the oscillation arm.
 *
 * HEX, BECAUSE IT IS ALSO A FILENAME. The shard is
 * `data/defects/<signature>.jsonl`, and a signature built by joining a site and
 * some field paths with separators would carry `/` and escape the directory.
 */
export function defectSignature(site: string, fieldPaths: readonly string[]): string {
  const material = `site=${site}\n${[...fieldPaths].sort().join("\n")}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/* =========================================================================
 * The reproduction
 * ====================================================================== */

/**
 * The bakeoff codes thrown by `resolvePrice` (bakeoff/src/contracts.ts:802) —
 * the ONE call in this repository whose arguments travel structurally and whose
 * module loads in the isolated copy.
 *
 * READ THE MECHANISM, NOT THE CLASS NAME. `recovery.ts#classOfBakeoffCode` puts
 * five codes in `accounting`, and the other three are NOT here: `invalid_effort`
 * has no `new BakeoffError` site at all, and `unpriced_usage` /
 * `duplicate_usage_row` are thrown by `priceVendorUsage` /
 * `assertNoDuplicateUsageRows` over a USAGE LEDGER — rows this record does not
 * carry and which live under gitignored `dashboard/data`, so they are not in the
 * copy. Naming the class would have swept all five in and emitted three commands
 * that cannot run.
 */
const PRICE_LOOKUP_CODES: readonly string[] = ["unknown_model_price", "ambiguous_price_window"];

/**
 * What may be interpolated into a shell command, and it is an ALLOW-LIST.
 *
 * The command is executed by `tools/repair/prover.mjs#runCommand` with
 * `shell: true`, so it is parsed by `sh`. `modelId` reaches this module from a
 * SQLite column that an HTTP request writes, so a value carrying a quote would
 * either break the command (a reproduction that fails for the wrong reason —
 * exactly what this whole block exists to prevent) or run whatever follows it.
 * A record that cannot state its parameters safely gets the absence arm instead;
 * escaping was rejected because the failure of an escaping bug is silent and the
 * failure of this predicate is a named code.
 */
const SHELL_SAFE = /^[A-Za-z0-9._-]{1,80}$/;

/** `2026-08-12T09:00:35.066Z`. `resolvePrice` slices the first 10 characters. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** What {@link planReproduction} needs beyond the record it is building. */
export interface ReproductionInput {
  readonly status: string;
  readonly phase: string;
  readonly failureClass: string;
  readonly bakeoffCode: string | null;
  /** `RunRow.provider`. A column, never a word parsed out of a failure. */
  readonly provider: string;
  /** `RunRow.modelId`. Same. */
  readonly modelId: string;
  /** The record's own instant, which is the instant the price was needed at. */
  readonly at: string;
}

/** One `node -e` against the isolated copy's own `bakeoff/src/contracts.ts`. */
function priceProbe(body: string): string {
  return `node --input-type=module -e 'const c = await import("./bakeoff/src/contracts.ts"); ${body}'`;
}

/**
 * DECIDE WHAT THE BAR CAN ACTUALLY RUN FOR THIS DEFECT — pure, so the test can
 * drive every arm without a filesystem.
 *
 * ─── THE ONE RUNNABLE ARM, AND ITS MEASURED EXECUTION ───
 *
 * A run that died with `unknown_model_price` died because `PRICE_TABLE` in
 * `bakeoff/src/contracts.ts` has no window covering this run's model — a
 * committed data table in a module with no relative imports. All three of the
 * commands below were EXECUTED on a real `git archive HEAD` copy with no
 * `node_modules` and no `dist` (2026-08-12):
 *
 *   resolvePrice("anthropic", "claude-opus-6", …)   exit 1   ← the reproduction
 *   resolvePrice("anthropic", "claude-opus-5", …)   exit 0   ← the negative
 *                                                              control: the
 *                                                              command is not
 *                                                              red for everything
 *   every PRICE_TABLE row resolves to itself        exit 0   ← the replay case
 *
 * and the reproduction ran in 0.076s, two orders of magnitude under
 * `MIN_COMMAND_TIMEOUT_MS` (5s, supervisor-cycle.mjs).
 *
 * THE PROVIDER AND MODEL ARE THE RUN'S OWN COLUMNS, WHICH IS AN INFERENCE, AND
 * THE DIRECTION IT FAILS IN IS WHY IT IS ALLOWED. `BakeoffError` carries no
 * arguments, so this names the model the run was CONFIGURED with rather than the
 * model the failing lookup asked for. If a future call prices some other seat,
 * this command PASSES on the unpatched copy and `proveRepair` answers
 * `COULD_NOT_REPRODUCE` — inconclusive, no fingerprint written, nothing ruled
 * out. A wrong reproduction here degrades to "the experiment could not be
 * staged", never to a patch graded on somebody else's evidence.
 *
 * ─── THE CEILING THIS ARM REACHES IS `REFUSED`, NEVER `APPLY`, AND IT WAS
 *     MEASURED BY RUNNING THE REAL BAR ───
 *
 * `runEvidenceBar` was called with this exact record and a candidate diff that
 * adds the missing `ModelPrice` row (2026-08-12, 903ms, isolation + five command
 * runs at a 8549ms per-command share). The bar reproduced the defect, proved the
 * patch, replayed the recorded cases and then refused at ONE arm:
 *
 *   [TOUCHES_FROZEN_CLOSURE] the minimal diff reaches the frozen closure; this is
 *   owner-only regardless of how good the evidence is: bakeoff/src/contracts.ts
 *
 * which is correct and permanent: `tools/tier3/closure.mjs#frozenClosure` puts
 * `contracts.ts` in the GRADER partition, and PRICE_TABLE lives inside it. So the
 * property that makes this class reproducible — the fix is committed data in a
 * dependency-free module — is the same property that makes it owner-only, and no
 * patch for it can ever be APPLIED unattended.
 *
 * THE ARM IS STILL WORTH ITS LINES, and the difference is the whole point of this
 * change: before it, every ticket stopped at `NO_REPRODUCTION_COMMAND` with
 * nothing executed and nothing learned. After it, the bar runs five real commands
 * and returns a judgement on the IDEA — "this is the owner's file" — which the
 * supervisor's router can act on. An honest terminal state beats a dead end; the
 * accept path is NOT live and nothing here should be read as saying it is.
 *
 * ─── AND IT CANNOT FIRE ON THIS DEPLOYMENT TODAY, SAID HERE SO NOBODY READS A
 *     TESTED ARM AS AN OBSERVED ONE ───
 *
 * `recovery.ts:812-820` records the measurement: the dashboard server never calls
 * `resolvePrice`, so no run of this build can end with these codes. Re-measured
 * 2026-08-12 — `grep -rn resolvePrice dashboard/server/src` finds it only inside
 * that docblock. This is a bound placed before the capability it bounds, exactly
 * like `PROOF_BUDGET_EXCEEDED` in `supervisor-cycle.mjs`. It is written anyway
 * because the alternative is an extension point whose accept path no execution
 * has ever taken.
 *
 * ─── EVERY OTHER CLASS GETS AN ABSENCE, AND EACH ONE NAMES ITS OWN BLOCKER ───
 *
 * Not one generic sentence: the blockers are different, and `suite_authoring`'s is
 * now measurably one blocker narrower than it was — the missing build output was
 * removed on 2026-08-12 and the arm still refuses, on the half that is left. An
 * absence that gets SMALLER is the shape of progress here; an absence that gets
 * replaced by a command nobody executed is not.
 */
export function planReproduction(input: ReproductionInput): DefectReproduction {
  /*
   * NOT-A-DEFECT FIRST. A `passed` record and a `cancelled` record are both
   * written by `#finish`, and neither has anything to reproduce: nothing failed,
   * or a human stopped it. `recovery.ts`'s first classification rule is that a
   * run somebody stopped on purpose is not a run to reason about.
   */
  if (input.status === "passed" || input.status === "cancelled" || input.failureClass === "intentional") {
    return {
      available: false,
      code: "REPRODUCTION_NOT_A_DEFECT",
      reason:
        `this record was written at status "${input.status}" (class "${input.failureClass}"), which is not a failure to ` +
        "reproduce: a passed run has no defect and a cancelled one was stopped by a person. A command emitted here " +
        "would be an experiment with no hypothesis.",
    };
  }

  if (input.bakeoffCode !== null && PRICE_LOOKUP_CODES.includes(input.bakeoffCode)) {
    /*
     * THE GUARD IS BEFORE THE COMMAND, AND ITS FAILURE IS AN ABSENCE RATHER THAN
     * AN ESCAPE. See {@link SHELL_SAFE}. `at` is checked too: `resolvePrice`
     * throws `ambiguous_price_window` for an instant it cannot read a date out
     * of, so a malformed clock value would produce a command that is red at HEAD
     * for a reason that has nothing to do with the price table — the confounded
     * red this whole type exists to refuse.
     */
    if (!SHELL_SAFE.test(input.provider) || !SHELL_SAFE.test(input.modelId) || !ISO_INSTANT.test(input.at)) {
      return {
        available: false,
        code: "REPRODUCTION_PARAMETERS_UNSAFE",
        reason:
          `the price lookup that failed (${input.bakeoffCode}) is reproducible in principle, but this run's recorded ` +
          `parameters cannot be written into a shell command safely: provider=${JSON.stringify(input.provider)}, ` +
          `modelId=${JSON.stringify(input.modelId)}, at=${JSON.stringify(input.at)}. The command runs through ` +
          "`sh -c` (prover.mjs#runCommand, shell: true), so anything outside [A-Za-z0-9._-] is refused rather than " +
          "escaped: an escaping bug fails silently and this refusal fails by name.",
      };
    }
    const args = `"${input.provider}", "${input.modelId}", "${input.at}"`;
    return {
      available: true,
      command: priceProbe(`c.resolvePrice(${args});`),
      cases: [
        {
          /*
           * THE TARGETED CASE ASKS FOR MORE THAN THE REPRODUCTION DOES — that the
           * resolved window NAMES this model — so a patch that made `resolvePrice`
           * return some fallback row would clear the reproduction and fail here.
           * It is deliberately not byte-equal to the reproduction command:
           * `independentReplay` refuses `REPLAY_NOT_INDEPENDENT` for a case that
           * re-runs the reproduction, "the test the patch was written against".
           */
          name: "the run's model resolves to a window that names it",
          command: priceProbe(`const r = c.resolvePrice(${args}); if (r.price.modelId !== "${input.modelId}") process.exit(1);`),
          targeted: true,
        },
        {
          /*
           * THE UNRELATED CASE IS DERIVED FROM THE TABLE, NEVER FROM A MODEL ID
           * WRITTEN HERE. A hard-coded "claude-opus-5" would start failing the
           * day that row's window closes, and a control that fails on its own is
           * a control that refuses every patch. Reading the table and asking each
           * row to resolve to itself keeps the check alive as the table moves —
           * and it catches the two ways a price patch damages what is already
           * there: an overlapping window (`ambiguous_price_window`) and a row that
           * no longer covers its own start date.
           *
           * IT REFUSES AN EMPTY TABLE. Without that line a patch that deleted
           * PRICE_TABLE would satisfy this case vacuously — zero rows, zero
           * failures, green. That is this repository's signature defect, and the
           * `process.exit(1)` on length 0 is its negative control.
           */
          name: "every price window already in the table still resolves to itself",
          command: priceProbe(
            "if (c.PRICE_TABLE.length === 0) process.exit(1); " +
              "for (const p of c.PRICE_TABLE) { " +
              'const r = c.resolvePrice(p.provider, p.modelId, p.effectiveFrom + "T00:00:00.000Z"); ' +
              "if (r.price.modelId !== p.modelId) process.exit(1); }",
          ),
          targeted: false,
        },
      ],
      why:
        "bakeoff/src/contracts.ts has no relative imports, so Node's native type stripping loads it from a " +
        "`git archive HEAD` copy with no node_modules and no dist — measured 2026-08-12: 21 exports, exit 0, and the " +
        "reproduction itself exit 1 in 0.076s against the same copy. PRICE_TABLE is committed data in that same file, " +
        "so the patch that fixes this defect and the code that observes it are both inside the archive.",
    };
  }

  /*
   * SUITE AUTHORING — THE CLASS THAT ACTUALLY FIRES, THE BLOCKER THAT WAS REMOVED,
   * AND THE ONE THAT IS LEFT.
   *
   * MEASURED: 3 of the 7 `results/defect.json` files under `dashboard/runs` are
   * `spec/failed/suite_not_audited`. This arm used to answer
   * REPRODUCTION_NEEDS_A_BUILT_CHECKER and name two blockers. The FIRST IS GONE:
   * `isolate.mjs` provisions `bakeoff/node_modules` and proves the copy compiles
   * (0.30s clone, 1.31s probe), and a command carrying its own `tsc` was executed
   * on a real copy through the whole prover — red, green, red again, PROVEN. A
   * suite-authoring reproduction can now RUN. The second blocker is why it still
   * cannot SAY ANYTHING, and it is two measurements deep:
   *
   *   1. THIS RUN'S MANIFEST IS NOT IN THE COPY. The reproduction for a
   *      suite-authoring death is the manifest THIS seat emitted, replayed through
   *      the live checker: red while the checker rejects it, green when the patch
   *      makes it acceptable. That document lives under gitignored
   *      `dashboard/runs` (.gitignore:25) and reaches this record as nothing at
   *      all — `violations` is null and `artefacts` carries an absolute path into
   *      the owner's working tree, which is not the copy. The committed fixtures
   *      under `tools/replay/fixtures` are run a913c871's three, not this run's.
   *   2. AND THE CLASS-GENERIC COMMANDS ARE NOT REPRODUCTIONS, WHICH IS THE TRAP
   *      THIS ARM EXISTS TO REFUSE. `node tools/replay/replay.mjs` was executed in
   *      a built copy: EXIT 0, "5 case(s); 0 failing/unarmed; 0 blind arm(s)".
   *      `node --test dist/spec-validate.test.js` and
   *      `tools/repair/a913c871-oscillation.test.mjs`: exit 0 as well. They are
   *      REGRESSION harnesses — green exactly when the repository is healthy — so
   *      they are green before a patch and green after it, for ever. `proveRepair`
   *      answers COULD_NOT_REPRODUCE and the ticket learns nothing, at the price of
   *      isolation plus five command runs. A command that can never be red is a
   *      reproduction in name only, which this type's header calls strictly worse
   *      than none.
   *
   * AND THE FOUR KNOWN INSTANCES OF THIS CLASS ARE ALREADY REPAIRED AT HEAD, which
   * is the measurement that settles it: `spec-validate.ts:292` widened
   * `UBIQUITOUS_DETERMINERS` citing run `aa6e721e` by name, and `spec-repair.ts`'s
   * header names `ac275880`, `0629aa6c`, `aa6e721e` and `a913c871` as the four
   * rejections it was built for. Even with the manifest in hand, replaying one of
   * these three records against HEAD is green — the defect is gone. The reproduction
   * for a suite-authoring defect can only ever come from the FAILING RUN'S OWN
   * ARTEFACTS, captured at the throw site, and it has to be captured while the tree
   * that failed is still the tree.
   *
   * WHAT WOULD CLOSE IT, AND IT IS NOT IN THIS FILE: the producer that writes this
   * record (`orchestrator.ts#finish`) copying the rejected manifest into
   * `results/` and naming it here, so the command becomes
   * `cd bakeoff && ./node_modules/.bin/tsc -p tsconfig.json && node --test dist/…`
   * over a document the copy actually contains.
   */
  if (input.failureClass === "suite_authoring" || input.bakeoffCode === "suite_not_audited") {
    return {
      available: false,
      code: "REPRODUCTION_NEEDS_THE_RECORDED_MANIFEST",
      reason:
        "the reproduction for a suite-authoring defect is the manifest THIS seat emitted, replayed through the live " +
        "checker — and the checker half is now solved: isolate.mjs provisions bakeoff/node_modules (0.30s, " +
        "copy-on-write) and proves the copy compiles, and a command carrying its own `tsc` was driven through the " +
        "whole prover on a real copy (red 1046ms, green 1050ms, red on revert 1049ms, PROVEN). The manifest half is " +
        "not: this run's document lives under gitignored dashboard/runs (.gitignore:25) and reaches this record as " +
        "nothing — violations is null and artefacts holds an absolute path into the owner's working tree, not the " +
        "copy. A class-generic command is not a substitute: `node tools/replay/replay.mjs` was executed in a BUILT " +
        "copy and exited 0 (5 cases, 0 failing, 0 blind), as did `node --test dist/spec-validate.test.js` — they are " +
        "regression harnesses, green before a patch and green after it, so the bar would answer COULD_NOT_REPRODUCE " +
        "after paying for isolation and five command runs. The four known instances of this class are also already " +
        "repaired at HEAD (spec-validate.ts:292 widened UBIQUITOUS_DETERMINERS citing run aa6e721e; spec-repair.ts's " +
        "header names all four runs), so even the recorded manifest would replay green against HEAD. Closing this " +
        "needs the producer at the throw site to copy the rejected manifest into results/ while the failing tree is " +
        "still the tree — not a cleverer reader here.",
    };
  }

  /*
   * THE SEALED CONTAINER. `done/failed` with no bakeoff code is the held-out
   * suite going red inside the Tier 3 container — 2 of the 7 records. The subject
   * of that experiment is the BUILT PROJECT under gitignored `dashboard/runs`,
   * not the harness the copy contains, and re-running it needs docker.
   */
  if (input.phase === "done" && input.bakeoffCode === null) {
    return {
      available: false,
      code: "REPRODUCTION_NEEDS_THE_SEALED_CONTAINER",
      reason:
        "this run died with the frozen held-out suite red in the sealed container, so the thing that has to be re-run " +
        "is the BUILT PROJECT plus its container — and neither is in the isolated copy: the workspace lives under " +
        "gitignored dashboard/runs, and the copy is `git archive HEAD` of the harness with no node_modules and no " +
        "docker daemon assumed. A command emitted here would be red on the copy for want of an image, which the bar " +
        "cannot tell apart from the defect.",
    };
  }

  return {
    available: false,
    code: "REPRODUCTION_PARAMETERS_DO_NOT_TRAVEL",
    reason:
      `no runnable reproduction is expressible for ${input.phase}/${input.status}/${input.bakeoffCode ?? "no-code"} ` +
      `(class "${input.failureClass}"): BakeoffError (bakeoff/src/contracts.ts:75) carries a code, a prose message and ` +
      "a prose remediation and NOTHING structured, so the arguments of the call that failed do not reach this record. " +
      "Recovering them from the message is the prose-matching mechanism this module's header forbids by name, and a " +
      "guessed reproduction is a guessed defect. Closing this needs a structured payload on the throw — the §3.2 " +
      "DefectDetail — not a cleverer reader here.",
  };
}

export interface DefectRecordInput {
  readonly runId: string;
  readonly at: string;
  readonly phase: string;
  readonly status: string;
  readonly failureClass: string;
  readonly bakeoffCode: string | null;
  readonly failureReason: string | null;
  /** Where the failure was raised, structurally. Never a message. */
  readonly site: string;
  /** Null means "no structured violations travel yet", NOT "there were none". */
  readonly violations: readonly DefectViolation[] | null;
  /** Null means "the attempts did not reach this record", NOT "there were none". */
  readonly attempts: readonly DefectAttempt[] | null;
  readonly artefacts: readonly string[];
  /**
   * `RunRow.provider` and `RunRow.modelId`, as columns.
   *
   * REQUIRED, NOT OPTIONAL, and there is exactly one caller so the cost is one
   * line. They are the only structured arguments any reproduction has (see
   * {@link planReproduction}); making them optional would let a future call site
   * silently drop the one input that decides whether the evidence bar is
   * reachable, and the record would report a named absence that is really a
   * forgotten parameter.
   */
  readonly provider: string;
  readonly modelId: string;
  /**
   * May an automated agent propose a repair for this class. `isRepairable`
   * (recovery.ts), NOT `boundFor(klass) > 0` — see that function's docblock for
   * the disagreement the two predicates produced. Corrected 2026-08-10; the
   * comment here used to describe the retry budget.
   */
  readonly repairable: boolean;
}

export function buildDefectRecord(input: DefectRecordInput): DefectRecord {
  const violations = input.violations ?? [];
  const attempts = input.attempts ?? [];
  const unavailable: string[] = [];
  if (input.violations === null) {
    unavailable.push(
      "violations: no structured DefectDetail travels on this failure yet (design §3.2 is a " +
        "digest-moving change that has not landed), so the offending field paths are UNKNOWN — " +
        "not absent. Read failureReason for what the layer that threw actually said.",
    );
  }
  if (input.attempts === null) {
    unavailable.push(
      "attempts: the authoring trail did not reach this record. On the failure path the thrown " +
        "BakeoffError carries no attempts array; on the success path the trail is in the frozen " +
        "audit file. Zero attempts here would be a lie.",
    );
  }
  return {
    runId: input.runId,
    at: input.at,
    phase: input.phase,
    failureClass: input.failureClass,
    bakeoffCode: input.bakeoffCode,
    signature: defectSignature(
      input.site,
      violations.map((v) => v.path),
    ),
    violations,
    attempts,
    artefacts: input.artefacts,
    repairable: input.repairable,
    status: input.status,
    site: input.site,
    fieldPaths: [...violations.map((v) => v.path)].sort(),
    violationsAvailable: input.violations !== null,
    attemptsAvailable: input.attempts !== null,
    unavailable,
    failureReason: input.failureReason,
    /*
     * THE REPRODUCTION IS COMPUTED HERE AND NOT PASSED IN, so that no caller can
     * hand this record a command nobody checked against the isolated copy — the
     * whole risk {@link DefectReproduction} is written around. It is also AFTER
     * `signature`, and deliberately not an input to it: `defectSignature` is site
     * plus sorted field paths, and adding anything else would give every existing
     * `data/defects/<signature>.jsonl` shard a new name, so the second occurrence
     * of a class already recorded would land in a fresh file and read as a first.
     */
    reproduction: planReproduction({
      status: input.status,
      phase: input.phase,
      failureClass: input.failureClass,
      bakeoffCode: input.bakeoffCode,
      provider: input.provider,
      modelId: input.modelId,
      at: input.at,
    }),
  };
}

export interface DefectWriteTargets {
  /** `dashboard/runs/<runId>/results` — the per-run copy. */
  readonly resultsDir: string;
  /** `dashboard/data/defects` — the append-only, content-addressed shards. */
  readonly defectsDir: string;
}

export interface DefectWriteResult {
  readonly recordPath: string;
  readonly shardPath: string;
}

/**
 * Both writes, in that order.
 *
 * THE SHARD IS APPEND-ONLY AND CONTENT-ADDRESSED BY SIGNATURE, which is what
 * makes "has this happened before?" a `wc -l` rather than a walk of every run
 * directory. Appending never rewrites, so an earlier occurrence cannot be lost
 * by a later one — the retention rule the research round insisted on
 * (accumulate, never replace).
 */
export function writeDefectRecord(record: DefectRecord, targets: DefectWriteTargets): DefectWriteResult {
  mkdirSync(targets.resultsDir, { recursive: true });
  mkdirSync(targets.defectsDir, { recursive: true });
  const recordPath = join(targets.resultsDir, "defect.json");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const shardPath = join(targets.defectsDir, `${record.signature}.jsonl`);
  appendFileSync(shardPath, `${JSON.stringify(record)}\n`, "utf8");
  return { recordPath, shardPath };
}

/* =========================================================================
 * The authoring trail
 * ====================================================================== */

export interface AuthoringTrailFile {
  readonly runId: string;
  readonly at: string;
  readonly ticketId: string;
  /** `frozen` — a suite was sealed. `failed` — the phase threw. */
  readonly outcome: "frozen" | "failed";
  readonly suiteSha256: string | null;
  readonly attempts: readonly DefectAttempt[];
  readonly attemptsAvailable: boolean;
  /** Where the attempts came from, or why there are none. Never blank. */
  readonly source: string;
}

/**
 * Read the attempts out of whatever is actually available, STRUCTURALLY.
 *
 * `candidate` is either the parsed frozen audit file (success) or the thrown
 * error (failure). Both are probed the same way — is there an array called
 * `attempts` (the error's shape once the digest-moving §8.0a change lands) or
 * `authoringTrail` (the audit file's shape today)? — because the alternative is
 * matching on the message, and the one hard constraint the recovery layer
 * states is that no discrimination in this program may be a prose match.
 *
 * IT RETURNS `null` RATHER THAN `[]` WHEN IT FINDS NOTHING. That distinction is
 * the whole point of the module: today the failure path finds nothing, and it
 * must say so out loud rather than file a run with three authoring calls as a
 * run with zero.
 */
export function readAuthoringAttempts(candidate: unknown): readonly DefectAttempt[] | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const bag = candidate as Record<string, unknown>;
  const raw = Array.isArray(bag["attempts"])
    ? (bag["attempts"] as unknown[])
    : Array.isArray(bag["authoringTrail"])
      ? (bag["authoringTrail"] as unknown[])
      : null;
  if (raw === null) return null;
  return raw.map((entry, index) => {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const n = typeof item["attempt"] === "number" ? item["attempt"] : index + 1;
    // `at` only if the entry really carries one. See {@link DefectAttempt}.
    const at = typeof item["at"] === "string" ? item["at"] : "";
    const problems: string[] = [];
    /*
     * ABANDONMENT IS THE FIRST PROBLEM ON THE ROW WHEN IT HAPPENED, and it goes
     * on `problems` rather than into a new field because `problems` is the one
     * channel a reader of `DefectAttempt` already reads. An attempt that was cut
     * off by the harness produced nothing, so every other problem on the row is
     * downstream of that fact and reading it second inverts the cause.
     *
     * `=== true`, NEVER TRUTHINESS. `timedOut` is optional on
     * `AuthoringTrailEntry` precisely so that a trail frozen before 2026-08-10
     * reads as "not recorded" rather than as "did not time out"; a loose check
     * would turn every absent field into a claim.
     */
    if (item["timedOut"] === true) {
      problems.push(
        "the authoring call was ABANDONED on the per-call wall-clock bound and produced nothing — " +
          "this attempt was cut off by the harness, not answered by the seat",
      );
    }
    /*
     * A REPAIRED ATTEMPT'S DEFECTS, WHICH ITS OWN `findings` NO LONGER CARRY.
     * When a repair round clears a blocking finding, the attempt is recorded
     * with the findings of the RE-audit — which is clean — so the row of an
     * attempt that shipped a credential-shaped literal and then fixed it is
     * indistinguishable from the row of an attempt that never had one. That is
     * the fact `repairedProblems` exists to keep, and a defect record built
     * without it would report a spec phase that went green first time.
     *
     * `typeof === "number"`, never truthiness: `repairRounds` is optional on
     * `AuthoringTrailEntry` so that a trail frozen before 2026-08-12 reads as
     * "not recorded", and 0 is a measurement that must not read as absent.
     */
    if (typeof item["repairRounds"] === "number" && item["repairRounds"] > 0) {
      const cleared = Array.isArray(item["repairedProblems"])
        ? (item["repairedProblems"] as unknown[]).filter((p): p is string => typeof p === "string")
        : [];
      problems.push(
        `${String(item["repairRounds"])} repair round(s) ran inside this attempt` +
          (cleared.length === 0 ? "" : `, against: ${cleared.join(" | ")}`),
      );
    }
    if (Array.isArray(item["problems"])) {
      for (const p of item["problems"] as unknown[]) if (typeof p === "string") problems.push(p);
    }
    if (Array.isArray(item["findings"])) {
      for (const f of item["findings"] as unknown[]) {
        if (typeof f === "object" && f !== null) {
          const finding = f as Record<string, unknown>;
          const id = typeof finding["criterionId"] === "string" ? finding["criterionId"] : "(no criterion)";
          const kind = typeof finding["kind"] === "string" ? finding["kind"] : "(no kind)";
          problems.push(`${kind} :: ${id}`);
        }
      }
    }
    return { n, at, problems };
  });
}

export function writeAuthoringTrail(trail: AuthoringTrailFile, resultsDir: string): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, "authoring-trail.json");
  writeFileSync(path, `${JSON.stringify(trail, null, 2)}\n`, "utf8");
  return path;
}

/** The artefacts a replay would need, filtered to the ones that actually exist. */
export function existingArtefacts(candidates: readonly string[]): readonly string[] {
  return candidates.filter((path) => path !== "" && existsSync(path) && existsSync(dirname(path)));
}
