/**
 * THE ISOLATED COPY THE PROVER IS ALLOWED TO TOUCH — and nothing else in this
 * repository may hand it a root.
 *
 * ─── WHY THIS FILE EXISTS ───
 *
 * `prover.mjs#assertSandbox` THROWS for any path inside this repository, and that
 * refusal is the reason `runRepairCycle` was never wired into the supervisor's
 * real path: proving a repair means applying the diff, running the reproduction,
 * reverting the fix hunk and running it again, which on the owner's live tree is a
 * corrupted workspace — with a second worker mid-edit in `bakeoff/src` while this
 * runs. So the bar needs a tree that is a faithful copy of the repository and is
 * NOT the repository. This builds one, and it is the only thing that does.
 *
 * ─── `git archive HEAD | tar -x`, AND WHY NOT THE TWO OBVIOUS ALTERNATIVES ───
 *
 * MEASURED 2026-08-12 on this repository:
 *   git archive HEAD | tar -x   0.196s wall, 23 MB, 686 files
 *   du -sh .                    2.9 G  (dashboard/node_modules 476M,
 *                               dashboard/server/node_modules 619M,
 *                               bakeoff/node_modules 57M, dashboard/runs 90M)
 *
 * 1. NOT `cp -R` OF THE WORKING TREE. 2.9 GB against 23 MB is the whole argument,
 *    and the second one is worse: a copy taken while another worker is writing
 *    `bakeoff/src` is a torn read, and the bar would then be proving a patch
 *    against a tree that never existed.
 * 2. NOT `git worktree add`. It WRITES into `REPO_ROOT/.git/worktrees` — a
 *    mutation of the owner's repository state, taken by a process whose designed
 *    death is being killed by the supervisor's ten-minute clock, which would leave
 *    stale worktree metadata behind every time. `git archive` reads and writes
 *    nothing inside `REPO_ROOT`, and cleanup is one `rmSync`.
 *
 * ─── THE TWO BOUNDS THIS CHOICE CARRIES, STATED HERE BECAUSE THEY ARE REAL ───
 *
 * A. IT IS HEAD, NOT THE WORKING TREE, AND THAT IS THE SECOND CEILING ON THIS
 *    WHOLE LANE. A candidate diff authored against uncommitted edits does not
 *    apply to this copy, and the bar answers `PATCH_DID_NOT_APPLY` — a NAMED
 *    outcome that deliberately does not rule the proposal out (see
 *    `supervisor-cycle.mjs`, THE BAR NEVER BLACKLISTS). It is not a rare case:
 *    `git status --porcelain` at 2026-08-12 11:00 listed `bakeoff/src/spec-agent.ts`,
 *    `contracts.ts`, `spec-validate.ts`, `spec-repair.ts`, `brief-shape.ts` and
 *    `tools/tier3/gate.mjs` as modified and uncommitted by concurrent workers, and
 *    those files are exactly where this repository's defects are recorded. How
 *    often a REAL candidate diff would hit this is UNMEASURED — no candidate diff
 *    has ever been authored. Closing it needs the record (or the proposal) to name
 *    the commit-ish the diff was written against, so the copy can be taken from
 *    that tree instead of from HEAD; guessing it here would be this file deciding
 *    what the patch was written against.
 * B. `node_modules` IS GITIGNORED, SO IT IS NOT IN THE ARCHIVE — AND THAT BOUND IS
 *    CLOSED FOR `bakeoff` AS OF 2026-08-12; SEE THE NEXT SECTION. What has not
 *    changed is the reason it is not SYMLINKED: a reproduction command that ran
 *    `npm install` against a symlink would be writing into the owner's
 *    `node_modules` while a live run reads it, and the prover runs repository
 *    commands inside this tree. A symlink is a write path back into the working
 *    copy, so `bakeoff/node_modules` is CLONED (a real directory of real files),
 *    never linked.
 *
 * NOTHING HERE THROWS. A failure to isolate that arrived as an exception would
 * land in the middle of a supervisor tick; every path returns a value with a code.
 *
 * ─── PROVISIONING `bakeoff/node_modules`, AND WHY IT IS AFFORDABLE ───
 *
 * Three of the seven `results/defect.json` records on disk are
 * `spec/failed/suite_not_audited`, and every reproduction anyone can write for that
 * class runs the LIVE checker — which is TypeScript that has to be compiled. On a
 * copy with no dependencies there is no compiler, so the command is red before the
 * patch AND red after it, and a correct patch is graded `NOT_FIXED`. That is the
 * hazard `defect-record.ts#DefectReproduction` is written around, and it is why the
 * copy is now provisioned rather than left bare.
 *
 * MEASURED 2026-08-12 on this machine (APFS, /var/folders and the repository on the
 * same volume), each number by running the command and reading `df -k` around it:
 *
 *   du -sh bakeoff/node_modules             57 MB   (typescript alone is 23 MB)
 *   cp -c -R  (clonefile, copy-on-write)    0.285s, 1.9 MB of real disk consumed
 *   cp -R     (byte copy, the fallback)     0.714s, 58.5 MB of real disk consumed
 *   rm -rf of the whole provisioned copy    0.249s
 *
 * so the clone is 2.5x faster and 30x smaller on disk, and the fallback is still
 * affordable. `-c` is NOT assumed to work: it fails on a cross-filesystem copy, on
 * a non-APFS volume, and on GNU `cp`, where `-c` is not even a valid flag — so the
 * plain copy is attempted whenever the clone exits non-zero, and which one ran is
 * REPORTED (`build.provisionMode`) rather than guessed at.
 *
 * End to end, over three consecutive isolations of this repository (spread under
 * 3%): archive+extract 141-144ms, provision 300-317ms, probe 1013-1021ms,
 * 1454-1481ms in total — against the 60s `PROVE_BUDGET_MS` the bar has to spend.
 *
 * ─── AND THE BUILD PROBE IS A PROBE, NOT PROVISIONING ───
 *
 * `--noEmit`, DELIBERATELY, and this is the subtle half. The question asked here is
 * "can this copy compile at all", and the answer has to arrive as a value the
 * caller can refuse on (`buildable`). It must NOT leave a compiled `bakeoff/dist`
 * behind: that dist would reflect HEAD, and a reproduction command whose own build
 * step was missing or failing would then silently read STALE HEAD OUTPUT and report
 * a patched tree's behaviour as the unpatched tree's. The build a proof depends on
 * runs INSIDE the reproduction command, on every prover invocation — see
 * `defect-record.ts#DefectReproduction`. Measured: `tsc --noEmit` 0.886s against
 * `tsc` (emitting) 1.474s, and `tsconfig.json` sets neither `incremental` nor
 * `composite`, so a pre-built dist would not even make the in-command build faster.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSandbox } from "./prover.mjs";

/**
 * How long the copy itself may take. Measured at 0.196s above, so this is three
 * orders of magnitude of headroom and exists only so that a hung `git` (an index
 * lock held by the concurrent worker, a network filesystem) is a named refusal
 * rather than a supervisor tick that never returns.
 */
export const ISOLATE_TIMEOUT_MS = 30_000;

/**
 * How long provisioning and the build probe may take, EACH.
 *
 * 15s against a measured 0.285s clone and a measured 0.886s `tsc --noEmit` is 50x
 * and 17x of headroom. It is deliberately much tighter than {@link
 * ISOLATE_TIMEOUT_MS}, and the reason is arithmetic the caller pays:
 * `supervisor-cycle.mjs` divides `PROVE_BUDGET_MS - iso.elapsedMs` between the
 * bar's command runs, so every second spent here is taken off the reproduction's
 * own clock. Worst case is 30 + 15 + 15 = 60s, which exhausts the budget and drops
 * every command to `MIN_COMMAND_TIMEOUT_MS`; that is a slow tick rather than a hung
 * one, and it can only be reached by two simultaneous hangs.
 */
export const BUILD_PROBE_TIMEOUT_MS = 15_000;

/**
 * The package whose dependencies are provisioned, as one name in one place.
 *
 * ONLY `bakeoff`, and that is a measurement rather than an oversight:
 * `dashboard/node_modules` is 476 MB and `dashboard/server/node_modules` is 619 MB
 * against bakeoff's 57 MB, and NO reproduction command anyone can write today runs
 * a dashboard test — `dashboard/server/src/*.test.ts` files import siblings by
 * relative `.js` specifier, which Node's type stripping does not remap (measured in
 * a copy: ERR_MODULE_NOT_FOUND, `defect-record.ts`'s docblock records the run). A
 * clone of 1.1 GB to run nothing is 1.1 GB of nothing.
 */
const BUILT_PACKAGE = "bakeoff";

/**
 * The value every path below returns. `elapsedMs` is the whole provision+probe.
 *
 * @param {{buildable: boolean, code: string, detail: string, startedAt: number,
 *          provisionMs?: number, provisionMode?: string|null}} v
 */
function buildAnswer(v) {
  return {
    buildable: v.buildable,
    code: v.code,
    detail: v.detail,
    elapsedMs: Date.now() - v.startedAt,
    provisionMs: v.provisionMs ?? 0,
    provisionMode: v.provisionMode ?? null,
  };
}

/**
 * PROVISION THE COPY'S DEPENDENCIES, THEN ASK IT TO COMPILE — and answer with a
 * value on every path, including the ones where nothing was built.
 *
 * ─── THE ARM THAT MAKES `buildable: true` MEAN SOMETHING ───
 *
 * `NOTHING_TO_BUILD` is `buildable: true`, and on its own that is exactly this
 * repository's signature defect: a probe that reports success when it looked at
 * nothing. What stops it is that the question is asked of BOTH TREES. The source
 * repository is consulted first — `bakeoff/tsconfig.json` is tracked at HEAD
 * (`git ls-files` confirms it), so for THIS repository the copy must have it, and a
 * copy that does not is `TRUNCATED_COPY`, `buildable: false`. `NOTHING_TO_BUILD`
 * can therefore only be reached by a repoRoot that genuinely has no such package —
 * which is every fixture repository `supervisor-cycle.test.mjs` builds, and for
 * those a bar refusal on a missing compiler would be a refusal of a tree that never
 * needed one.
 *
 * NOTHING HERE THROWS, for the same reason nothing else in this file does.
 */
function provisionAndProbe(repoRoot, root, timeout) {
  const startedAt = Date.now();
  const sourcePkg = join(repoRoot, BUILT_PACKAGE);
  const copyPkg = join(root, BUILT_PACKAGE);
  const sourceHasPackage = existsSync(join(sourcePkg, "tsconfig.json"));
  const copyHasPackage = existsSync(join(copyPkg, "tsconfig.json"));

  if (!sourceHasPackage && !copyHasPackage) {
    return buildAnswer({
      buildable: true,
      code: "NOTHING_TO_BUILD",
      detail:
        `neither ${sourcePkg} nor ${copyPkg} carries a tsconfig.json, so this tree has no compiled package: there is ` +
        "no build step for a reproduction command to fail in, and nothing to provision. Reported as buildable because " +
        "the hazard this probe exists to catch — a command red for want of a compiler — cannot arise here.",
      startedAt,
    });
  }
  if (sourceHasPackage && !copyHasPackage) {
    return buildAnswer({
      buildable: false,
      code: "TRUNCATED_COPY",
      detail:
        `${join(repoRoot, BUILT_PACKAGE, "tsconfig.json")} exists and is tracked at HEAD, but the copy at ${copyPkg} ` +
        "has no tsconfig.json — so the archive or the extraction dropped the package the reproduction has to compile. " +
        "Every command that builds it would be red on this copy for a reason that has nothing to do with any patch.",
      startedAt,
    });
  }

  const target = join(copyPkg, "node_modules");
  let provisionMode = "already-present";
  if (!existsSync(target)) {
    const source = join(sourcePkg, "node_modules");
    if (!existsSync(source)) {
      return buildAnswer({
        buildable: false,
        code: "DEPENDENCIES_NOT_INSTALLED",
        detail:
          `${source} does not exist, so there is nothing to provision into the copy and the copy cannot compile. Run ` +
          `\`cd ${BUILT_PACKAGE} && npm install\` in ${repoRoot} — the copy is built from HEAD and node_modules is ` +
          "gitignored (.gitignore), so it can only ever come from the working tree.",
        startedAt,
      });
    }
    /*
     * CLONE FIRST, BYTE COPY SECOND, AND NEVER A SYMLINK. Measured 2026-08-12:
     * `cp -c -R` 0.285s / 1.9 MB of real disk, `cp -R` 0.714s / 58.5 MB. `-c` is
     * refused by GNU cp and by any non-APFS or cross-volume target, so its failure
     * is expected rather than exceptional and the fallback is not an error path.
     */
    const clone = spawnSync("cp", ["-c", "-R", source, target], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
    provisionMode = "clone";
    if (clone.status !== 0) {
      const plain = spawnSync("cp", ["-R", source, target], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
      provisionMode = "copy";
      if (plain.status !== 0) {
        return buildAnswer({
          buildable: false,
          code: "PROVISION_FAILED",
          detail:
            `${source} could not be provisioned into ${target}: the copy-on-write clone exited ` +
            `${String(clone.status)} (${(clone.stderr ?? "").trim().slice(-200) || "no stderr"}) and the plain copy ` +
            `exited ${String(plain.status)} (${(plain.stderr ?? "").trim().slice(-200) || "no stderr"}).`,
          startedAt,
          provisionMs: Date.now() - startedAt,
          provisionMode,
        });
      }
    }
  }
  const provisionMs = Date.now() - startedAt;

  const compiler = join(target, ".bin", "tsc");
  if (!existsSync(compiler)) {
    return buildAnswer({
      buildable: false,
      code: "COMPILER_MISSING",
      detail:
        `${target} was provisioned (${provisionMode}) but carries no .bin/tsc, so the copy has dependencies and no ` +
        "compiler. A reproduction command that builds the package would be red on this copy for want of a toolchain, " +
        "which the evidence bar cannot tell apart from the defect.",
      startedAt,
      provisionMs,
      provisionMode,
    });
  }
  /*
   * `--noEmit`: A PROBE, NOT A BUILD. See the header. An emitted dist here would be
   * HEAD's, and a reproduction whose own build step failed would then read it and
   * report the unpatched tree's behaviour as the patched tree's.
   */
  const probe = spawnSync(compiler, ["-p", "tsconfig.json", "--noEmit"], {
    cwd: copyPkg,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (probe.status !== 0) {
    /*
     * A PROBE KILLED BY THE CLOCK IS FILED HERE TOO, AND SAYS SO IN WORDS RATHER
     * THAN IN A CODE OF ITS OWN. A copy whose compiler hangs is exactly as unusable
     * as one whose compiler refuses, and both refuse the bar for the same reason.
     * A separate code would need an arm to drive it, and the only way to drive it
     * is a clock short enough to kill `tsc` (0.886s measured) but long enough to
     * let the 0.285s clone finish — a race dressed up as a test. The distinction is
     * kept where it costs nothing: in the sentence.
     */
    return buildAnswer({
      buildable: false,
      code: "BUILD_FAILED",
      detail:
        `\`tsc -p tsconfig.json --noEmit\` in ${copyPkg} ` +
        (probe.signal
          ? `was KILLED with ${probe.signal} after the ${timeout}ms build bound`
          : `exited ${String(probe.status)}`) +
        ", so this copy cannot compile the package every reproduction for a suite-authoring defect has to build: " +
        `${`${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().slice(-400) || "(no output)"}`,
      startedAt,
      provisionMs,
      provisionMode,
    });
  }
  return buildAnswer({
    buildable: true,
    code: "BUILDS",
    detail:
      `${BUILT_PACKAGE}/node_modules provisioned by ${provisionMode} in ${provisionMs}ms and ` +
      `\`tsc -p tsconfig.json --noEmit\` exited 0 in ${copyPkg}: a reproduction command carrying its own build step ` +
      "can run on this copy.",
    startedAt,
    provisionMs,
    provisionMode,
  });
}

/**
 * Build the copy. Returns `{ ok, root, code, detail, buildable, build, cleanup }`
 * and never throws.
 *
 * `cleanup` IS RETURNED ON EVERY PATH, INCLUDING THE FAILING ONES, and the failing
 * paths have already called it. `rmSync(..., { force: true })` is idempotent, so a
 * caller's `finally` that calls it a second time is harmless — which is the point:
 * the caller must not have to know which paths cleaned up after themselves.
 *
 * `buildable` IS PRESENT ON EVERY PATH TOO, AND IT IS NOT THE SAME FACT AS `ok`.
 * A copy that could not be made and a copy that cannot compile are different
 * sentences for the owner and different outcomes in `supervisor-cycle.mjs`, so the
 * failing paths carry `buildable: false` with `build.code: "COPY_NEVER_BUILT"` —
 * "nothing was probed", never "the probe said no". Absence is not emptiness.
 *
 * @param {{repoRoot: string, timeoutMs?: number, buildTimeoutMs?: number}} input
 */
export function isolateRepairRoot(input) {
  const startedAt = Date.now();
  const repoRoot = String(input?.repoRoot ?? "");
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), "repair-isolated-"));
  } catch (error) {
    return {
      ok: false,
      root: null,
      code: "NO_SCRATCH_DIRECTORY",
      detail: `a temporary directory for the isolated copy could not be created: ${message(error)}`,
      elapsedMs: Date.now() - startedAt,
      buildable: false,
      build: NEVER_BUILT,
      cleanup: () => {},
    };
  }
  const root = join(scratch, "tree");
  /*
   * THE TAR IS A SIBLING OF THE COPY, NOT A FILE INSIDE IT. An archive extracted
   * over itself leaves `head.tar` in the tree the prover then diffs and runs, and
   * a 23 MB file that is in neither HEAD nor the diff is exactly the kind of
   * difference between "the copy" and "the repository" that makes a proof mean
   * something other than what it says.
   */
  const tarPath = join(scratch, "head.tar");
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const fail = (code, detail) => {
    cleanup();
    return { ok: false, root, code, detail, elapsedMs: Date.now() - startedAt, buildable: false, build: NEVER_BUILT, cleanup };
  };

  try {
    mkdirSync(root, { recursive: true });
    const timeout = input?.timeoutMs ?? ISOLATE_TIMEOUT_MS;
    const archive = spawnSync("git", ["archive", "--format=tar", "-o", tarPath, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    if (archive.status !== 0) {
      return fail(
        "GIT_ARCHIVE_FAILED",
        `git archive HEAD failed in ${repoRoot} (exit ${String(archive.status)}` +
          `${archive.signal ? `, signal ${archive.signal}` : ""}): ${(archive.stderr ?? "").trim().slice(-300) || "(no stderr)"}`,
      );
    }
    const extract = spawnSync("tar", ["-xf", tarPath, "-C", root], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
    if (extract.status !== 0) {
      return fail(
        "EXTRACT_FAILED",
        `the archive of HEAD could not be extracted into ${root} (exit ${String(extract.status)}): ` +
          `${(extract.stderr ?? "").trim().slice(-300) || "(no stderr)"}`,
      );
    }
    rmSync(tarPath, { force: true });

    /*
     * TWO NEGATIVE CONTROLS ON THE COPY ITSELF, because both failures are silent.
     *
     * `assertSandbox` is the PROVER'S OWN predicate, imported rather than
     * restated: if this ever produced a path inside the repository, the prover
     * would throw mid-cycle and the supervisor would see an exception instead of
     * an outcome. Asking the same function here turns that into a code.
     *
     * An EMPTY copy is the other one. `git archive` of a repository with no
     * commits exits non-zero, but a filtered or truncated extraction would leave a
     * readable, empty directory — against which every diff fails to apply and
     * every reproduction "fails", for ever, plausibly.
     */
    assertSandbox(root);
    const entries = readdirSync(root);
    if (entries.length === 0) {
      return fail("EMPTY_COPY", `the isolated copy at ${root} came back empty, so nothing could be reproduced in it`);
    }
    /*
     * THE PROBE IS RUN, NOT ASSUMED, AND ITS FAILURE IS NOT A FAILURE TO ISOLATE.
     * The copy is real either way: a caller may still want to know what the tree
     * looks like, and the one thing it must not do is treat "cannot compile" as
     * "cannot copy". So this returns `ok: true` with `buildable: false`, and
     * `supervisor-cycle.mjs` answers COPY_NOT_BUILDABLE rather than
     * ISOLATION_FAILED — two facts, two names.
     */
    /*
     * ITS OWN try/catch, INSIDE THE OUTER ONE, so that a throw from the probe is a
     * BUILD answer and not `ISOLATION_THREW`. The outer catch already stops any
     * exception reaching the supervisor's tick — but it would report a copy that
     * exists and compiles badly as a copy that could not be made, and the caller
     * routes those to different outcomes.
     */
    let build;
    try {
      build = provisionAndProbe(repoRoot, root, input?.buildTimeoutMs ?? BUILD_PROBE_TIMEOUT_MS);
    } catch (error) {
      build = {
        buildable: false,
        code: "BUILD_PROBE_THREW",
        detail: `the copy was made but its build could not be probed at all: ${message(error)}`,
        elapsedMs: 0,
        provisionMs: 0,
        provisionMode: null,
      };
    }
    return {
      ok: true,
      root,
      code: "ISOLATED",
      detail:
        `${entries.length} top-level entr${entries.length === 1 ? "y" : "ies"} copied from HEAD of ${repoRoot} into ` +
        `${root}; build probe ${build.code} in ${build.elapsedMs}ms`,
      entries: entries.length,
      elapsedMs: Date.now() - startedAt,
      buildable: build.buildable,
      build,
      cleanup,
    };
  } catch (error) {
    return fail("ISOLATION_THREW", `the isolated copy could not be built: ${message(error)}`);
  }
}

/**
 * What `build` says on a path where the copy itself failed.
 *
 * FROZEN, so that a caller cannot mistake it for a probe result it can edit, and
 * NAMED differently from every code {@link provisionAndProbe} returns: "the probe
 * never ran" and "the probe said no" are different facts about the machine.
 */
const NEVER_BUILT = Object.freeze({
  buildable: false,
  code: "COPY_NEVER_BUILT",
  detail: "the isolated copy could not be made, so no build was attempted and nothing is known about whether it compiles",
  elapsedMs: 0,
  provisionMs: 0,
  provisionMode: null,
});

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
