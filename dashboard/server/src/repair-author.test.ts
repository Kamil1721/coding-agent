/**
 * THE PATCH AUTHOR, TESTED IN BOTH DIRECTIONS — including the direction that
 * says it may not become the thing that grades its own work.
 *
 * NO TEST HERE SPENDS QUOTA. Every model call is an injected `PatchAuthorCall`
 * that answers from a queue and records what it was sent, which is also how the
 * prompt's contents are measured rather than asserted about.
 *
 * THE FIXTURE IS A REAL GIT REPOSITORY, and deliberately a DIRTY one. The
 * evidence bar proves on `git archive HEAD` (`tools/repair/isolate.mjs`), so an
 * author that quoted the working tree would emit context lines that cannot
 * apply there. The happy-path test dirties the file it patches and then applies
 * the authored diff to an extracted archive of HEAD — if the reader ever goes
 * back to `readFileSync`, that apply fails and this file goes red.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTHOR_BUDGET_MS,
  MAX_DIFF_BYTES,
  MAX_REQUESTED_FILES,
  MAX_TOTAL_TARGET_BYTES,
  appendAuthorJournal,
  authorRepairPatch,
  checkAuthoredDiff,
  createAuthoringRepairDriver,
  diffShape,
  extractDiff,
  extractJsonObject,
  normaliseRequestedPath,
  patchAuthorSeat,
  readAtHead,
  refusedPathReason,
  renderAuthorTurn,
  withDeadline,
} from "./repair-author.js";
import type { AuthorOutcome, PatchAuthorCall, PatchAuthorCallRequest } from "./repair-author.js";
import { DEFAULT_SPEC_MODEL, SPEC_MODEL_ENV } from "./orchestrator.js";
import { REPAIR_CYCLE_TIMEOUT_MS } from "./supervisor-boot.js";
import { SUPERVISOR_REPAIR_DEADLINE_MS } from "./supervisor.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";
import type { SupervisorRepairOutcome, SupervisorRepairRequest } from "./supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const SIGNATURE = "a".repeat(64);
/** What the fake says answered, so the journal can be checked against it. */
const FAKE_MODEL = "fake-model-in-a-test";

/** The committed bytes. Every diff in this file quotes these exactly. */
const HEAD_SOURCE = "export function add(a, b) {\n  return a - b;\n}\n";
const GOOD_DIFF =
  "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n";

interface Fixture {
  readonly root: string;
  readonly repoRoot: string;
  readonly defectPath: string;
  readonly proposalsDir: string;
  readonly journalDir: string;
  readonly sha: string;
}

function git(cwd: string, args: readonly string[]): { status: number; out: string } {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return { status: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * A repository whose HEAD carries the defect, whose WORKING TREE has been edited
 * since — the state `git status` reported 11 files in on 2026-08-12 — and a
 * defect record pointing at it.
 */
function makeFixture(defect: Record<string, unknown> | null = null): Fixture {
  const root = mkdtempSync(join(tmpdir(), "repair-author-"));
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "thing.mjs"), HEAD_SOURCE, "utf8");
  git(repoRoot, ["init", "-q", "."]);
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "the defect"]);
  // DIRTY, ON PURPOSE. See this file's header.
  writeFileSync(join(repoRoot, "src", "thing.mjs"), `${HEAD_SOURCE}// UNCOMMITTED WORKING-TREE EDIT\n`, "utf8");

  const runDir = join(root, "runs", "run-1", "results");
  mkdirSync(runDir, { recursive: true });
  const record = defect ?? {
    runId: "run-1",
    signature: SIGNATURE,
    phase: "build",
    status: "failed",
    failureClass: "wrong_arithmetic",
    bakeoffCode: null,
    site: "build/failed/wrong_arithmetic",
    violations: [],
    attempts: [],
    fieldPaths: [],
    artefacts: ["/Users/somebody/runs/run-1/results/authoring-trail.json"],
    unavailable: [],
    failureReason: "add(2, 2) returned 0: src/thing.mjs subtracts where the ticket says it must add",
  };
  const defectPath = join(runDir, "defect.json");
  writeFileSync(defectPath, JSON.stringify(record), "utf8");
  return {
    root,
    repoRoot,
    defectPath,
    proposalsDir: join(root, "proposals"),
    journalDir: join(root, "journal"),
    sha: git(repoRoot, ["rev-parse", "HEAD"]).out.trim(),
  };
}

interface Recorder {
  readonly call: PatchAuthorCall;
  readonly sent: PatchAuthorCallRequest[];
}

/** A model that answers from a queue and remembers what it was asked. */
function recorder(answers: readonly (string | Error)[]): Recorder {
  const sent: PatchAuthorCallRequest[] = [];
  const call: PatchAuthorCall = (request) => {
    sent.push(request);
    const answer = answers[sent.length - 1];
    if (answer === undefined) return Promise.reject(new Error(`the fake model was called ${String(sent.length)} times and has no answer for that`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ text: answer, stopReason: "end_turn", modelId: FAKE_MODEL });
  };
  return { call, sent };
}

const surveyFor = (...files: string[]): string => JSON.stringify({ files, why: "the arithmetic is here" });

function journalRows(fixture: Fixture): Record<string, unknown>[] {
  const path = join(fixture.journalDir, `${SIGNATURE}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function author(fixture: Fixture, call: PatchAuthorCall): Promise<AuthorOutcome> {
  return authorRepairPatch({
    defectPath: fixture.defectPath,
    proposalsDir: fixture.proposalsDir,
    journalDir: fixture.journalDir,
    repoRoot: fixture.repoRoot,
    call,
    runId: "run-1",
    surveyTimeoutMs: 5_000,
    authorTimeoutMs: 5_000,
  });
}

/* ------------------------------------------------------------------ */

test("a defect with evidence yields a candidate diff that applies to the tree the evidence bar builds", async () => {
  const fixture = makeFixture();
  try {
    const model = recorder([surveyFor("src/thing.mjs"), `Here is the fix:\n\n\`\`\`diff\n${GOOD_DIFF}\`\`\`\n`]);
    const outcome = await author(fixture, model.call);

    assert.equal(outcome.kind, "authored", outcome.detail);
    assert.equal(outcome.code, "PATCH_AUTHORED");
    assert.deepEqual([...outcome.filesChanged], ["src/thing.mjs"]);
    assert.equal(outcome.headSha, fixture.sha);
    const written = readFileSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`), "utf8");
    assert.equal(written, GOOD_DIFF, "the diff on disk must be the diff, with no prose and no author-added header");

    /*
     * THE MEASUREMENT THAT DECIDES WHETHER ANY OF THIS CAN WORK. The prompt must
     * carry the COMMITTED bytes; the working tree has an extra line and it must
     * not be there. Without this the emitted context lines describe a file the
     * bar's copy does not contain, and every candidate answers
     * BAR_PATCH_DID_NOT_APPLY.
     */
    const authoringTurn = model.sent[1]?.userTurns.join("\n") ?? "";
    assert.ok(authoringTurn.includes("  return a - b;"), "the committed bytes never reached the author");
    assert.ok(!authoringTurn.includes("UNCOMMITTED WORKING-TREE EDIT"), "the author was quoted the dirty working tree, so its context lines cannot apply to git archive HEAD");
    assert.ok(authoringTurn.includes(fixture.sha), "the author was not told which commit the bytes came from");

    // AND THE PROOF THAT IT APPLIES THERE: the same tree isolate.mjs builds.
    const copy = join(fixture.root, "archive");
    mkdirSync(copy, { recursive: true });
    const tar = spawnSync("bash", ["-c", `git archive HEAD | tar -x -C ${JSON.stringify(copy)}`], { cwd: fixture.repoRoot, encoding: "utf8" });
    assert.equal(tar.status, 0, `could not build the archive copy: ${tar.stderr ?? ""}`);
    const patchPath = join(fixture.root, "candidate.diff");
    writeFileSync(patchPath, written, "utf8");
    const applied = git(copy, ["apply", "-p1", "--check", patchPath]);
    assert.equal(applied.status, 0, `the authored diff does not apply to git archive HEAD: ${applied.out}`);

    // AND THE AUTHOR CHANGED NOTHING ITSELF: the tree it read is untouched.
    assert.equal(readFileSync(join(fixture.repoRoot, "src", "thing.mjs"), "utf8"), `${HEAD_SOURCE}// UNCOMMITTED WORKING-TREE EDIT\n`);
    assert.equal(git(fixture.repoRoot, ["rev-parse", "HEAD"]).out.trim(), fixture.sha, "the author moved HEAD");

    const rows = journalRows(fixture);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["code"], "PATCH_AUTHORED");
    assert.equal(rows[0]?.["headSha"], fixture.sha, "the row does not name the commit the diff was authored against");
    assert.deepEqual(rows[0]?.["granted"], ["src/thing.mjs"]);
    assert.equal(rows[0]?.["modelId"], FAKE_MODEL, "the row names a model other than the one that answered");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a defect record with nothing actionable is a NAMED refusal, and costs no model call", async () => {
  /*
   * THE REAL RECORD, FIELD FOR FIELD. MEASURED 2026-08-12 from
   * dashboard/runs/run-2026-08-12T07-34-18-997Z-d143e52d/results/defect.json:
   * everything structured is empty and `failureReason` is null.
   */
  const fixture = makeFixture({
    runId: "run-1",
    signature: SIGNATURE,
    phase: "build",
    status: "cancelled",
    failureClass: "unclassified",
    bakeoffCode: null,
    site: "build/cancelled/no-code",
    violations: [],
    attempts: [],
    fieldPaths: [],
    artefacts: [],
    unavailable: ["violations: no structured DefectDetail travels on this failure yet"],
    failureReason: null,
  });
  try {
    const model = recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]);
    const outcome = await author(fixture, model.call);

    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.code, "NOTHING_ACTIONABLE", outcome.detail);
    assert.equal(model.sent.length, 0, "a record with no evidence in it still spent a seat call");
    assert.equal(outcome.diffPath, null);
    assert.ok(!existsSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`)), "an empty or guessed diff was written for a record that names nothing");
    assert.equal(journalRows(fixture).length, 1, "the refusal was not recorded");
    assert.equal(journalRows(fixture)[0]?.["code"], "NOTHING_ACTIONABLE");
    assert.equal(journalRows(fixture)[0]?.["modelId"], null, "a refusal that spent nothing still named a model, so the journal cannot show what a free refusal looks like");

    // THE OTHER ARM: the same fixture with one line of failureReason DOES call.
    writeFileSync(fixture.defectPath, JSON.stringify({ ...JSON.parse(readFileSync(fixture.defectPath, "utf8")) as Record<string, unknown>, failureReason: "add(2,2) returned 0" }), "utf8");
    const second = recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]);
    const authored = await author(fixture, second.call);
    assert.equal(authored.kind, "authored", authored.detail);
    assert.equal(second.sent.length, 2, "the evidence arm never reached the model, so the refusal above proves nothing");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the grader is refused in both directions: asking to read it, and emitting a diff that touches it", async () => {
  const fixture = makeFixture();
  try {
    // ARM 1 — the request. Refused before anything is read, and before a second call.
    const asking = recorder([surveyFor("tools/tier3/gate.mjs"), GOOD_DIFF]);
    const refusedAsk = await author(fixture, asking.call);
    assert.equal(refusedAsk.kind, "refused");
    assert.equal(refusedAsk.code, "REQUESTED_GRADER_FILE", refusedAsk.detail);
    assert.match(refusedAsk.detail, /tools\/tier3\/gate\.mjs/, "the refusal does not name the file it refused");
    assert.equal(asking.sent.length, 1, "the authoring call was spent on a request that was already refused");

    // ARM 2 — the emitted diff. The survey asked for a legal file; the diff did not.
    const graderDiff =
      "--- a/tools/tier3/gate.mjs\n+++ b/tools/tier3/gate.mjs\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n";
    const emitting = recorder([surveyFor("src/thing.mjs"), graderDiff]);
    const refusedDiff = await author(fixture, emitting.call);
    assert.equal(refusedDiff.kind, "refused");
    assert.equal(refusedDiff.code, "DIFF_TOUCHES_GRADER", refusedDiff.detail);
    assert.match(refusedDiff.detail, /tools\/tier3\/gate\.mjs/);
    assert.ok(!existsSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`)), "a diff touching the grader was written to the proposals directory");

    // BOTH REFUSALS ARE ON THE RECORD, and they are different rows.
    const rows = journalRows(fixture);
    assert.deepEqual(rows.map((r) => r["code"]), ["REQUESTED_GRADER_FILE", "DIFF_TOUCHES_GRADER"]);
    assert.deepEqual(rows[0]?.["rejected"], ["tools/tier3/gate.mjs"]);

    // AND THE PERMITTING ARM: an ordinary source file is neither refused.
    assert.equal(refusedPathReason("dashboard/server/src/preview.ts"), null);
    assert.equal(checkAuthoredDiff(GOOD_DIFF, ["src/thing.mjs"]).ok, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("every refused prefix refuses, and a path outside them all does not", () => {
  for (const path of [
    "tools/tier3/gate.mjs",
    "tools/repair/cycle.mjs",
    "bakeoff/src/scorer.ts",
    "bakeoff/test/tier3-fixtures/impossible/x.json",
    "bakeoff/docker/scorer.Dockerfile",
    "dashboard/acceptance/t-621a2808720d755e/suite.json",
    "dashboard/server/src/calibration/fixture.ts",
    "dashboard/server/probes/calibration-4a.mjs",
    "dashboard/data/tier3/trail.jsonl",
    "dashboard/runs/run-1/results/defect.json",
    "dashboard/results/scores/run-1.json",
  ]) {
    assert.ok(refusedPathReason(path) !== null, `${path} is not refused, so the author may edit what grades it`);
  }
  for (const path of ["dashboard/server/src/preview.ts", "dashboard/src/App.tsx", "src/thing.mjs", "docs/notes.md"]) {
    assert.equal(refusedPathReason(path), null, `${path} is refused, so the author can change nothing that is actually broken`);
  }

  // The path reader: traversal and absolutes cannot reach a refused prefix.
  assert.equal(normaliseRequestedPath("./src/thing.mjs"), "src/thing.mjs");
  assert.equal(normaliseRequestedPath("src/thing.mjs"), "src/thing.mjs");
  for (const bad of ["/etc/passwd", "../../etc/passwd", "src/../../x", "~/x", "", "  ", 7, null, "a\\b"]) {
    assert.equal(normaliseRequestedPath(bad), null, `${JSON.stringify(bad)} survived the path reader`);
  }
});

test("a diff outside the bounds it was granted is refused, with the bound that refused it named", async () => {
  const fixture = makeFixture();
  try {
    const cases: ReadonlyArray<{ readonly want: string; readonly diff: string }> = [
      {
        want: "DIFF_TOUCHES_UNREQUESTED_FILE",
        diff: "--- a/src/other.mjs\n+++ b/src/other.mjs\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n",
      },
      {
        want: "DIFF_DELETES_FILE",
        diff: "--- a/src/thing.mjs\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export function add(a, b) {\n-  return a - b;\n-}\n",
      },
      {
        want: "DIFF_TOO_LARGE",
        diff: `${GOOD_DIFF}${"+// filler\n".repeat(Math.ceil(MAX_DIFF_BYTES / 11) + 1)}`,
      },
      { want: "NO_DIFF_IN_ANSWER", diff: "I would change the sign on line 2, but I will not write it out." },
      { want: "DIFF_UNPARSEABLE", diff: "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ not a hunk header @@\n" },
    ];
    for (const probe of cases) {
      rmSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`), { force: true });
      const model = recorder([surveyFor("src/thing.mjs"), probe.diff]);
      const outcome = await author(fixture, model.call);
      assert.equal(outcome.code, probe.want, `${probe.want}: got ${outcome.code} — ${outcome.detail}`);
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.diffPath, null);
      assert.ok(!existsSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`)), `${probe.want} still wrote a candidate diff`);
    }
    assert.deepEqual(journalRows(fixture).map((r) => r["code"]), cases.map((c) => c.want), "not every refusal left exactly one row");

    // The file-count bound, both arms, without needing five real files at HEAD.
    const five = ["a", "b", "c", "d", "e"].map((n) => `--- a/${n}\n+++ b/${n}\n@@ -1,1 +1,1 @@\n-x\n+y\n`).join("");
    assert.equal(checkAuthoredDiff(five, ["a", "b", "c", "d", "e"]).code, "DIFF_TOO_MANY_FILES");
    const four = ["a", "b", "c", "d"].map((n) => `--- a/${n}\n+++ b/${n}\n@@ -1,1 +1,1 @@\n-x\n+y\n`).join("");
    assert.equal(checkAuthoredDiff(four, ["a", "b", "c", "d"]).ok, true, `${String(MAX_REQUESTED_FILES)} files must be allowed, or the bound refuses its own limit`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the author names too many files, or files that are not at HEAD, and is refused rather than trimmed", async () => {
  const fixture = makeFixture();
  try {
    const greedy = recorder([surveyFor("a.ts", "b.ts", "c.ts", "d.ts", "e.ts")]);
    const tooMany = await author(fixture, greedy.call);
    assert.equal(tooMany.code, "TOO_MANY_FILES_REQUESTED", tooMany.detail);
    assert.equal(greedy.sent.length, 1, "the authoring call was spent after the request was already over the bound");

    const missing = recorder([surveyFor("src/never-committed.mjs")]);
    const notAtHead = await author(fixture, missing.call);
    assert.equal(notAtHead.code, "NO_READABLE_TARGET", notAtHead.detail);
    assert.match(notAtHead.detail, /does not exist at HEAD/);

    const nothing = recorder([JSON.stringify({ files: [], why: "this record does not implicate a file I can name" })]);
    const named = await author(fixture, nothing.call);
    assert.equal(named.kind, "refused");
    assert.equal(named.code, "AUTHOR_NAMED_NO_FILES", named.detail);
    assert.match(named.detail, /does not implicate a file/, "the author's own reason was dropped from the record");

    const prose = recorder(["I think the problem is in the adder."]);
    const unreadable = await author(fixture, prose.call);
    assert.equal(unreadable.code, "SURVEY_UNREADABLE", unreadable.detail);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a call that never answers is abandoned on the author's own clock, and a call that throws is named", async () => {
  const fixture = makeFixture();
  try {
    const never: PatchAuthorCall = () => new Promise<never>(() => {});
    const started = Date.now();
    const hung = await authorRepairPatch({
      defectPath: fixture.defectPath,
      proposalsDir: fixture.proposalsDir,
      journalDir: fixture.journalDir,
      repoRoot: fixture.repoRoot,
      call: never,
      surveyTimeoutMs: 40,
      authorTimeoutMs: 40,
    });
    assert.equal(hung.kind, "inconclusive");
    assert.equal(hung.code, "AUTHOR_TIMED_OUT", hung.detail);
    assert.ok(Date.now() - started < 5_000, "the author waited on a call that never answers, which is the tick that stops the queue");

    const throwing = recorder([new Error("claude auth status: session expired")]);
    const failed = await author(fixture, throwing.call);
    assert.equal(failed.kind, "inconclusive");
    assert.equal(failed.code, "AUTHOR_CALL_FAILED", failed.detail);
    assert.match(failed.detail, /session expired/);

    // The second turn is bounded too, not only the first.
    let resolveSurvey = false;
    const halfHung: PatchAuthorCall = (request) =>
      request.purpose.includes("file survey")
        ? Promise.resolve({ text: surveyFor("src/thing.mjs"), stopReason: "end_turn" })
        : new Promise<never>(() => { resolveSurvey = true; });
    const stalled = await authorRepairPatch({
      defectPath: fixture.defectPath,
      proposalsDir: fixture.proposalsDir,
      journalDir: fixture.journalDir,
      repoRoot: fixture.repoRoot,
      call: halfHung,
      surveyTimeoutMs: 5_000,
      authorTimeoutMs: 40,
    });
    assert.equal(stalled.code, "AUTHOR_TIMED_OUT", stalled.detail);
    assert.equal(resolveSurvey, true, "the authoring turn was never reached, so its bound is untested");
    assert.equal(journalRows(fixture).length, 3, "an abandoned attempt left no record");

    // The guard itself, both arms.
    assert.deepEqual(await withDeadline(Promise.resolve(7), 1_000), { timedOut: false, value: 7 });
    assert.deepEqual(await withDeadline(new Promise<number>(() => {}), 10), { timedOut: true, value: null });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an existing proposal is never overwritten, and an unusable defect record is named rather than guessed at", async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.proposalsDir, { recursive: true });
    const byHand = "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1,1 +1,1 @@\n-owner's own patch\n+owner's own patch\n";
    writeFileSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`), byHand, "utf8");
    const model = recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]);
    const skipped = await author(fixture, model.call);
    assert.equal(skipped.code, "PROPOSAL_ALREADY_EXISTS", skipped.detail);
    assert.equal(model.sent.length, 0, "quota was spent on a defect that already has a candidate diff");
    assert.equal(readFileSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`), "utf8"), byHand, "a hand-authored proposal was overwritten");

    const missing = await authorRepairPatch({
      defectPath: join(fixture.root, "no-such-record.json"),
      proposalsDir: fixture.proposalsDir,
      journalDir: fixture.journalDir,
      repoRoot: fixture.repoRoot,
      call: recorder([]).call,
    });
    assert.equal(missing.code, "NO_DEFECT_RECORD", missing.detail);

    writeFileSync(fixture.defectPath, JSON.stringify({ signature: "not-a-digest", failureReason: "x" }), "utf8");
    const unaddressable = await author(fixture, recorder([]).call);
    assert.equal(unaddressable.code, "NO_DEFECT_SIGNATURE", unaddressable.detail);

    writeFileSync(fixture.defectPath, "{ this is not json", "utf8");
    const unreadable = await author(fixture, recorder([]).call);
    assert.equal(unreadable.code, "NO_DEFECT_RECORD", unreadable.detail);

    // Those three are unattributable, so they are journalled under that name.
    assert.equal(readdirSync(fixture.journalDir).sort().join(","), `${SIGNATURE}.jsonl,unattributed.jsonl`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a journal that cannot be written does not swallow the outcome", async () => {
  const fixture = makeFixture();
  try {
    // A FILE where the journal directory should be: mkdir and append both fail.
    const blocked = join(fixture.root, "blocked-journal");
    writeFileSync(blocked, "not a directory", "utf8");
    const outcome = await authorRepairPatch({
      defectPath: fixture.defectPath,
      proposalsDir: fixture.proposalsDir,
      journalDir: blocked,
      repoRoot: fixture.repoRoot,
      call: recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]).call,
    });
    assert.equal(outcome.kind, "authored", outcome.detail);
    assert.equal(outcome.journalPath, null, "an unwritable journal reported a path anyway");
    assert.match(outcome.detail, /could NOT be recorded/, "the outcome does not say its record is missing");

    const ok = appendAuthorJournal(join(fixture.root, "fresh"), {
      at: "2026-08-12T00:00:00.000Z",
      runId: "run-1",
      signature: SIGNATURE,
      kind: "refused",
      code: "X",
      detail: "y",
      headSha: null,
      requested: [],
      rejected: [],
      granted: [],
      filesChanged: [],
      diffPath: null,
      diffBytes: 0,
      modelId: "m",
      stopReason: null,
    });
    assert.equal(ok.ok, true, ok.detail);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the readers read what they claim: HEAD bytes, JSON objects, fenced and unfenced diffs", async () => {
  const fixture = makeFixture();
  try {
    const read = readAtHead(fixture.repoRoot, "src/thing.mjs");
    assert.equal(read.ok, true, read.detail);
    assert.equal(read.file?.text, HEAD_SOURCE, "readAtHead returned the working tree, not the commit");
    assert.equal(readAtHead(fixture.repoRoot, "src/absent.mjs").ok, false);
    assert.equal(readAtHead(fixture.repoRoot, "src/thing.mjs", 4).ok, false, "the per-target byte cap does not fire");

    assert.deepEqual(extractJsonObject('noise {"files":["a"]} tail')?.["files"], ["a"]);
    assert.equal(extractJsonObject("no object here"), null);
    assert.equal(extractJsonObject("[1,2,3]"), null, "an array is not a survey answer");

    assert.equal(extractDiff(`\`\`\`diff\n${GOOD_DIFF}\`\`\``), GOOD_DIFF);
    assert.equal(extractDiff(`prose first\n\n${GOOD_DIFF}`), GOOD_DIFF);
    assert.equal(extractDiff("no diff at all"), null);
    assert.equal(extractDiff("--- a/x\n+++ b/x\nno hunks here"), null);
    assert.ok(extractDiff(GOOD_DIFF.trimEnd())?.endsWith("\n"), "git apply refuses a truncated patch, so the newline must be restored");

    const shape = diffShape(GOOD_DIFF);
    assert.deepEqual([...shape.files], ["src/thing.mjs"]);
    assert.equal(shape.hunks, 1);
    assert.equal(shape.deletes.length, 0);

    // The prompt states the bound it will enforce, so a refusal is not a surprise.
    const turn = renderAuthorTurn({ signature: SIGNATURE }, [{ path: "src/thing.mjs", bytes: 42, text: HEAD_SOURCE }], "deadbeef");
    assert.match(turn, /git apply -p1/);
    assert.match(turn, /deadbeef/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the driver still decides: the author runs first, changes nothing, and its refusal reaches the ticket's sentence", async () => {
  const fixture = makeFixture();
  try {
    const requests: SupervisorRepairRequest[] = [];
    const graded: SupervisorRepairOutcome = {
      kind: "inconclusive",
      code: "NO_PATCH_AUTHOR",
      detail: "no candidate diff exists at <proposals>/<signature>.diff.",
    };
    const driver = (request: SupervisorRepairRequest): Promise<SupervisorRepairOutcome> => {
      requests.push(request);
      return Promise.resolve(graded);
    };
    const lines: string[] = [];
    const make = (call: PatchAuthorCall): ((r: SupervisorRepairRequest) => Promise<SupervisorRepairOutcome>) =>
      createAuthoringRepairDriver({
        driver,
        runsDir: join(fixture.root, "runs"),
        proposalsDir: fixture.proposalsDir,
        journalDir: fixture.journalDir,
        repoRoot: fixture.repoRoot,
        call,
        log: (line) => lines.push(line),
        surveyTimeoutMs: 5_000,
        authorTimeoutMs: 5_000,
      });
    const request: SupervisorRepairRequest = {
      ticketKey: "t-1",
      signature: SIGNATURE,
      runId: "run-1",
      failureClass: "wrong_arithmetic",
      cycleNo: 1,
      maxCycles: 3,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    };

    // AUTHORED: the driver's answer is returned unchanged, and a diff is on disk.
    const authored = await make(recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]).call)(request);
    assert.deepEqual(authored, graded, "the wrapper edited an outcome that only the driver may decide");
    assert.equal(requests.length, 1, "the driver did not run, so nothing graded the diff");
    assert.ok(existsSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`)), "the wrapper did not author anything");

    // REFUSED: the driver still decides, and the author's reason is appended.
    rmSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`), { force: true });
    const refused = await make(recorder([surveyFor("tools/repair/cycle.mjs")]).call)(request);
    assert.equal(refused.kind, graded.kind);
    assert.equal(refused.code, "NO_PATCH_AUTHOR", "the wrapper invented a code the supervisor's router does not know");
    assert.match(refused.detail, /REQUESTED_GRADER_FILE/, "the ticket's sentence lost the reason the author refused");

    /*
     * A THROWING SEAM IS THE AUTHOR'S OWN NAMED OUTCOME, not the wrapper's — the
     * call is inside `authorRepairPatch`'s try, which is where a failed seat call
     * belongs.
     */
    const seamThrew = await make(() => { throw new Error("the seam exploded"); })(request);
    assert.match(seamThrew.detail, /AUTHOR_CALL_FAILED/);
    assert.match(seamThrew.detail, /the seam exploded/);

    /*
     * AND THE WRAPPER'S OWN CATCH, WHICH IS A DIFFERENT ARM. `SupervisorLoop.#repair`
     * turns any throw out of the driver into one `REPAIR_DRIVER_THREW` code, so a
     * fault in the AUTHOR would be reported as the grader being broken before it
     * had run. A clock that throws reaches `authorRepairPatch` outside its own
     * try/catch and is the cheapest way to drive that path.
     */
    const thrown = await createAuthoringRepairDriver({
      driver,
      runsDir: join(fixture.root, "runs"),
      proposalsDir: fixture.proposalsDir,
      journalDir: fixture.journalDir,
      repoRoot: fixture.repoRoot,
      call: recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]).call,
      log: (line) => lines.push(line),
      now: () => { throw new Error("the clock exploded"); },
    })(request);
    assert.match(thrown.detail, /PATCH_AUTHOR_THREW/);
    assert.equal(thrown.code, "NO_PATCH_AUTHOR", "a fault in the author was reported as the driver's own code");
    assert.equal(requests.length, 4, "a throwing author cost the ticket its grading cycle");
    assert.ok(lines.some((l) => l.includes("SUPERVISOR REPAIR AUTHOR")), "nothing was logged about an authoring attempt");

    // NO RUN, NO RECORD, NO CALL: the driver's own NO_RUN_TO_REPAIR arm is untouched.
    const noRun = recorder([]);
    const withoutRun = await make(noRun.call)({ ...request, runId: null });
    assert.deepEqual(withoutRun, graded);
    assert.equal(noRun.sent.length, 0);
    assert.equal(requests.length, 5, "the driver was skipped for a ticket with no run, so NO_RUN_TO_REPAIR never fires");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the total-target cap drops the file that would blow the prompt, and keeps the ones before it", async () => {
  const fixture = makeFixture();
  try {
    /*
     * THREE FILES UNDER THE PER-FILE CAP THAT ARE OVER THE TOTAL ONE TOGETHER —
     * the arm the per-file cap cannot reach. 95 KB each: under MAX_TARGET_BYTES
     * (96 KB), and 285 KB against a 192 KB total.
     */
    const big = "x".repeat(95 * 1024);
    for (const name of ["one", "two", "three"]) writeFileSync(join(fixture.repoRoot, "src", `${name}.mjs`), `${big}\n`, "utf8");
    git(fixture.repoRoot, ["add", "-A"]);
    git(fixture.repoRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "three big files"]);
    assert.ok(95 * 1024 * 3 > MAX_TOTAL_TARGET_BYTES, "the fixture no longer exceeds the total cap, so this test measures nothing");

    const model = recorder([
      surveyFor("src/one.mjs", "src/two.mjs", "src/three.mjs"),
      "--- a/src/one.mjs\n+++ b/src/one.mjs\n@@ -1,1 +1,1 @@\n-x\n+y\n",
    ]);
    const outcome = await author(fixture, model.call);
    assert.equal(outcome.kind, "authored", outcome.detail);

    const row = journalRows(fixture)[0];
    assert.deepEqual(row?.["granted"], ["src/one.mjs", "src/two.mjs"], "the total-target cap did not stop at two files");
    assert.deepEqual(row?.["rejected"], ["src/three.mjs"], "the dropped file is not on the record");
    const turn = model.sent[1]?.userTurns.join("\n") ?? "";
    assert.ok(!turn.includes("src/three.mjs"), "the file the cap dropped was sent anyway");

    // AND THE DROPPED FILE IS NOT PATCHABLE: it was never granted.
    assert.equal(checkAuthoredDiff("--- a/src/three.mjs\n+++ b/src/three.mjs\n@@ -1,1 +1,1 @@\n-x\n+y\n", ["src/one.mjs", "src/two.mjs"]).code, "DIFF_TOUCHES_UNREQUESTED_FILE");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a repair window that cannot fit the job is refused before a call, and an open one is not", async () => {
  const fixture = makeFixture();
  const window = (deadlineAt: string | null): Promise<AuthorOutcome> => {
    const model = recorder([surveyFor("src/thing.mjs"), GOOD_DIFF]);
    return authorRepairPatch({
      defectPath: fixture.defectPath,
      proposalsDir: fixture.proposalsDir,
      journalDir: fixture.journalDir,
      repoRoot: fixture.repoRoot,
      call: model.call,
      deadlineAt,
      surveyTimeoutMs: 5_000,
      authorTimeoutMs: 5_000,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    }).then((outcome) => {
      calls.push(model.sent.length);
      return outcome;
    });
  };
  const calls: number[] = [];
  try {
    const closed = await window("2026-08-12T11:59:59.000Z");
    assert.equal(closed.code, "REPAIR_WINDOW_CLOSED", closed.detail);
    const tooShort = await window("2026-08-12T12:00:05.000Z"); // 5s left, 10s needed
    assert.equal(tooShort.code, "REPAIR_WINDOW_TOO_SHORT", tooShort.detail);
    assert.deepEqual(calls, [0, 0], "quota was spent on a ticket the supervisor is about to terminate");

    // THE PERMITTING ARM, and the one that proves the refusals above mean something.
    const open = await window("2026-08-12T12:30:00.000Z");
    assert.equal(open.kind, "authored", open.detail);
    assert.deepEqual(calls, [0, 0, 2]);

    // AND ABSENCE IS NOT EXPIRY: a direct caller with no ticket still authors.
    rmSync(join(fixture.proposalsDir, `${SIGNATURE}.diff`), { force: true });
    const unbounded = await window(null);
    assert.equal(unbounded.kind, "authored", unbounded.detail);

    assert.deepEqual(journalRows(fixture).map((r) => r["code"]), [
      "REPAIR_WINDOW_CLOSED",
      "REPAIR_WINDOW_TOO_SHORT",
      "PATCH_AUTHORED",
      "PATCH_AUTHORED",
    ], "a window refusal left no record");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the author's clock and the cycle's clock both fit inside the ticket's window", () => {
  /*
   * THE SAME ARITHMETIC THE EVIDENCE BAR ASSERTS FOR ITS OWN BUDGET, one stage
   * earlier, and read out of the OTHER modules rather than restated here — a
   * constant copied into this file would agree with itself for ever.
   */
  assert.equal(AUTHOR_BUDGET_MS, 240_000);
  assert.ok(
    AUTHOR_BUDGET_MS + REPAIR_CYCLE_TIMEOUT_MS < SUPERVISOR_REPAIR_DEADLINE_MS,
    `authoring (${String(AUTHOR_BUDGET_MS)}ms) plus one cycle (${String(REPAIR_CYCLE_TIMEOUT_MS)}ms) does not fit in the ` +
      `${String(SUPERVISOR_REPAIR_DEADLINE_MS)}ms repair window, so a ticket could spend quota on a patch that is never graded`,
  );
  assert.ok(
    SUPERVISOR_REPAIR_DEADLINE_MS - (AUTHOR_BUDGET_MS + REPAIR_CYCLE_TIMEOUT_MS) >= 5 * 60_000,
    "the margin between the ticket's window and one full author+grade pass is under five minutes, which is a stage killed with no time to write its row",
  );
});

test("the author runs the model id this machine runs, not the one the frozen literal carries", () => {
  /*
   * THE DEFECT THIS CATCHES. `orchestrator.ts#seat()` overrides `SPEC_SEAT.modelId`
   * on EVERY production seat with `env[DASHBOARD_SPEC_MODEL] ?? DEFAULT_SPEC_MODEL`,
   * so the literal id in `bakeoff/src/config.ts` reaches no CLI in this program.
   * An author using it would be the only seat running an unproven id, and would
   * fail as AUTHOR_CALL_FAILED on every ticket.
   */
  assert.equal(patchAuthorSeat({}).modelId, DEFAULT_SPEC_MODEL);
  assert.notEqual(patchAuthorSeat({}).modelId, SPEC_SEAT.modelId, "the author runs the bake-off literal, which nothing else on this machine runs");
  assert.equal(patchAuthorSeat({ [SPEC_MODEL_ENV]: "claude-sonnet-9" }).modelId, "claude-sonnet-9", "the owner's pin is ignored by this seat alone");
  assert.equal(patchAuthorSeat({ [SPEC_MODEL_ENV]: "   " }).modelId, DEFAULT_SPEC_MODEL, "a blank pin is read as a pin");
  assert.equal(patchAuthorSeat({}).role, "subagent", "the author borrowed a held-constant bake-off role, so its spend lands in a column that means something else");
  assert.equal(patchAuthorSeat({}).envKeyName, SPEC_SEAT.envKeyName);
});

test("the author is not in the grader's lane, and index.ts actually wires it", () => {
  const src = here.replace(/\/dist[^/]*$/, "/src");
  const author = readFileSync(join(src, "repair-author.ts"), "utf8");
  /*
   * COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT A CONVENIENCE. This file's
   * docblocks quote the very import that must not exist (the TS7016 measurement
   * spells out `import { frozenClosure } from "…/tools/tier3/closure.mjs"`), so a
   * naive match reports a violation that is prose. Stripping means these
   * assertions read CODE, which is the only thing that can execute.
   */
  const code = author.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /*
   * THE ARCHITECTURAL RULE AS A TEST. cycle.mjs's header: "a component that both
   * writes the patch and grades it is the shape this repository keeps catching
   * itself in". These are the mechanisms by which this file could become that,
   * and each one is a different route in.
   */
  assert.doesNotMatch(code, /from\s+"[^"]*tools\/(repair|tier3)/, "the author imports the lane that grades it");
  /*
   * THE MECHANISM, NOT THE NAME. This used to grep for "supervisor-cycle.mjs",
   * which went red the moment a REFUSAL SENTENCE mentioned the cycle to explain
   * itself — punishing the prose that makes an outcome readable while proving
   * nothing about behaviour. What actually matters is that this file cannot
   * START the grader, so: every process it spawns, enumerated.
   */
  const spawned = [...code.matchAll(/spawnSync\(\s*([^,]+),/g)].map((m) => (m[1] ?? "").trim());
  assert.deepEqual([...new Set(spawned)], ['"git"'], `the author starts a process other than git: ${spawned.join(" | ")}`);
  assert.doesNotMatch(code, /applyGatedPatch|runRepairCycle|proveRepair|openLedger/, "the author reaches into the bar's functions");
  assert.doesNotMatch(code, /"apply"|'apply'|\bapply\b\s*,/, "the author runs git apply, so it can patch a tree itself");
  assert.match(code, /git apply -p1/, "the prompt no longer tells the author what its diff has to apply with");
  // And the negative control for the stripper: it must not have eaten the code.
  assert.match(code, /export function refusedPathReason/, "the comment stripper removed the file, so these assertions prove nothing");

  const index = readFileSync(join(src, "index.ts"), "utf8");
  const mainAt = index.indexOf("export async function main(");
  assert.ok(mainAt > -1, "main() was renamed; this test is now measuring nothing");
  const mainBody = index.slice(mainAt);
  assert.match(mainBody, /createAuthoringRepairDriver\(/, "the author is constructed by nobody, so every repairing ticket still ends at NO_PATCH_AUTHOR");
  assert.match(mainBody, /createSeatPatchAuthorCall\(/, "the author is wired with no way to call a model");
  assert.match(mainBody, /repairArm\.armed\s*\?/, "the author would run even when the grader arm check refused to wire a driver, spending quota on a diff nothing can grade");
});
