#!/usr/bin/env node
/**
 * UNIT B — SEAT REPLAY. ONE MODEL CALL INSTEAD OF A 90-MINUTE RUN.
 *
 * RESEARCH-self-improving-practice.md H1(b): "seat replay — one spec-seat
 * authoring call, not one 90-minute run. Stored prompt inputs × candidate prompt
 * -> fresh artefact -> checker. This is the GEPA rollout, and it is the only
 * thing that answers the design's own open question: nothing has ever proved the
 * seat would emit a valid manifest if shown the shape."
 *
 * That question is still open at the time this file was written. The
 * post-mortem's §STILL UNPROVEN AFTER THE FIXES opens with it:
 *   "NO RUN HAS PRODUCED A VALID MANIFEST. The evidence is a validator probe,
 *    not a live seat. ... What is NOT proven: that a seat shown the shape emits
 *    it. No run has been made since the fix."
 *
 * THIS ENTRYPOINT DOES NOT SPEND THE CALL BY DEFAULT AND CANNOT SPEND IT BY
 * ACCIDENT. Without `--spend` it prints the plan, the cost, and the exact
 * command that would dispatch. `--spend` is checked before anything is
 * constructed, and the dispatcher is only imported on that branch.
 *
 *   node tools/replay/seat-replay.mjs                       plan + cost, no call
 *   node tools/replay/seat-replay.mjs --attempt 3           replay attempt 3's inputs
 *   node tools/replay/seat-replay.mjs --json                machine-readable plan
 *   node tools/replay/seat-replay.mjs --spend               ACTUALLY dispatch (see below)
 *
 * WHAT ONE INVOCATION COSTS — measured from this run's own transcripts, not
 * estimated (docs/RUN-a913c871-observations.md §What the 87 minutes cost):
 *
 *   attempt 1  output 201,492 tok   25m23s wall
 *   attempt 2  output 238,518 tok   35m25s wall
 *   attempt 3  output 181,862 tok   23m43s wall
 *   ------------------------------------------------
 *   one replay ~= ONE of those rows: ~180k-240k output tokens and 20-40 minutes,
 *   plus the input side: ~14k characters of ticket text and ONE attached document,
 *   the CV PDF (106,804 base64 chars). Cache reads across the three attempts
 *   totalled 163,640 and cache writes 314,481.
 *
 *   ONE CORRECTION TO THE POST-MORTEM, MEASURED HERE. It records the 559,692-byte
 *   reference PNG being re-sent on every seat call (events 9/15/21/27,
 *   "746256 base64 chars"). Those events are the PLAN seat. Counting every image
 *   and document block across all three authoring transcripts gives
 *   {('user','document','application/pdf'): 1} per transcript and NO image block
 *   at all — the spec seat was shown the CV and not the reference image. A cost
 *   model that budgets 560 KB of PNG per authoring replay is over by that much.
 *
 *   Against the alternative: the run that produced those three attempts cost
 *   1h26m54s of wall clock, ~628,441 output tokens, and reached phase two of ten.
 *   One seat replay is roughly one third of that and answers the same question.
 *
 * WHAT IT CANNOT DO, STATED SO NOBODY DISCOVERS IT AFTER PAYING. The seat's
 * attachments are the owner's real CV and a reference image; they are NOT copied
 * into this repo (only their digests are). A faithful replay therefore needs
 * those two files located on disk, and `--spend` refuses if they are not.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REPO_ROOT, checkManifest, loadChecker } from "./checker.mjs";
import { FIXTURE_DIR } from "./corpus.mjs";
import { defectSignature } from "./signature.mjs";

/** Measured per-attempt cost, from the CLI transcripts. Not an estimate. */
export const MEASURED_ATTEMPT_COST = Object.freeze({
  1: Object.freeze({ outputTokens: 201492, wall: "25m23s", transcript: "cfdffda9" }),
  2: Object.freeze({ outputTokens: 238518, wall: "35m25s", transcript: "60fcb909" }),
  3: Object.freeze({ outputTokens: 181862, wall: "23m43s", transcript: "e327a0fb" }),
});

export function loadAttemptInputs(attempt, fixtureDir = FIXTURE_DIR) {
  const id = `a913c871-attempt${attempt}`;
  const promptFile = path.join(fixtureDir, `${id}.prompt.txt`);
  const metaFile = path.join(fixtureDir, `${id}.meta.json`);
  if (!existsSync(promptFile) || !existsSync(metaFile)) {
    throw new Error(
      `no stored inputs for attempt ${attempt} (${path.relative(REPO_ROOT, promptFile)}). ` +
        `Run: node tools/replay/extract-fixtures.mjs`,
    );
  }
  return {
    id,
    userTurn: readFileSync(promptFile, "utf8"),
    meta: JSON.parse(readFileSync(metaFile, "utf8")),
    priorManifest: JSON.parse(readFileSync(path.join(fixtureDir, `${id}.manifest.json`), "utf8")),
  };
}

/**
 * The CANDIDATE prompt — the thing under test. Resolved at invoke time, never
 * vendored: the whole point of the unit is "stored inputs × CANDIDATE prompt",
 * so a frozen copy would test history. Read from the BUILT module so it is what
 * a run would actually send, and digested so a result is attributable.
 */
export async function resolveCandidatePrompt({ file, moduleFile } = {}) {
  if (file !== undefined) {
    if (!existsSync(file)) throw new Error(`--system-prompt-file not found: ${file}`);
    const text = readFileSync(file, "utf8");
    return { source: path.relative(REPO_ROOT, file), text, sha256: (await import("node:crypto")).createHash("sha256").update(text).digest("hex") };
  }
  const built = moduleFile ?? path.join(REPO_ROOT, "bakeoff", "dist", "spec-agent.js");
  if (!existsSync(built)) {
    return { source: null, text: null, sha256: null, why: `built spec-agent missing: ${path.relative(REPO_ROOT, built)} — build it, or pass --system-prompt-file` };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(built).href);
  } catch (err) {
    return { source: null, text: null, sha256: null, why: `built spec-agent failed to import: ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = mod.AUTHORING_SYSTEM_PROMPT;
  if (typeof text !== "string") {
    return { source: null, text: null, sha256: null, why: "built spec-agent does not export AUTHORING_SYSTEM_PROMPT" };
  }
  const { createHash } = await import("node:crypto");
  return {
    source: path.relative(REPO_ROOT, built),
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    mentionsMinRows: text.includes("minRows"),
    chars: text.length,
  };
}

/**
 * The attachments the stored prompt referenced, located on disk by digest if
 * possible. Nothing is copied into the repo — these are the owner's real CV and
 * reference image.
 */
export function locateAttachments(meta) {
  return (meta.attachments ?? []).map((a) => ({
    kind: a.kind,
    mediaType: a.mediaType,
    base64Chars: a.base64Chars,
    sha256OfBase64: a.sha256OfBase64,
    presentInRepo: false,
    note: "not copied into the repo (owner's real CV / reference image); --spend needs a path for this",
  }));
}

export async function planSeatReplay({ attempt = 3, systemPromptFile } = {}) {
  const inputs = loadAttemptInputs(attempt);
  const prompt = await resolveCandidatePrompt({ file: systemPromptFile });
  const checker = await loadChecker();
  const priorResult = checkManifest(checker, inputs.priorManifest);
  const priorFields = priorResult.collectAllFields;

  return {
    at: new Date().toISOString(),
    attempt,
    storedInputs: {
      id: inputs.id,
      userTurnChars: inputs.userTurn.length,
      userTurnSha256: inputs.meta.promptTextSha256,
      transcript: inputs.meta.provenance.transcript,
      attachments: locateAttachments(inputs.meta),
    },
    candidatePrompt: prompt,
    checker: checker.identity,
    /** What the STORED attempt produced, so the replay has a baseline to beat. */
    baseline: {
      accepted: priorResult.accepted,
      failFast: priorResult.failFast,
      signature: defectSignature("spec/suite.manifest.json", priorFields),
      fields: priorFields,
    },
    cost: MEASURED_ATTEMPT_COST[attempt] ?? null,
    /** The question one call answers. */
    question:
      "Does the spec seat emit a dataExpectations entry the sealed parser accepts, when the prompt shows it the shape? " +
      "Never answered by any run. The only evidence today is a validator probe.",
    spends: false,
  };
}

function printPlan(plan) {
  console.log(`SEAT REPLAY — PLAN ONLY, NOTHING DISPATCHED  (${plan.at})`);
  console.log("");
  console.log(`stored inputs   : ${plan.storedInputs.id}  ${plan.storedInputs.userTurnChars} chars of ticket text`);
  console.log(`                  from CLI transcript ${plan.storedInputs.transcript}, sha256 ${String(plan.storedInputs.userTurnSha256).slice(0, 16)}`);
  for (const a of plan.storedInputs.attachments) {
    console.log(`attachment      : ${a.kind} ${a.mediaType ?? ""} ${a.base64Chars} base64 chars — ${a.note}`);
  }
  console.log("");
  if (plan.candidatePrompt.text === null) {
    console.log(`candidate prompt: UNRESOLVED — ${plan.candidatePrompt.why}`);
  } else {
    console.log(`candidate prompt: ${plan.candidatePrompt.source}  ${plan.candidatePrompt.chars} chars`);
    console.log(`                  sha256 ${plan.candidatePrompt.sha256}`);
    console.log(
      `                  mentions "minRows": ${plan.candidatePrompt.mentionsMinRows ? "YES" : "NO — this is the a913c871 root cause, the seat cannot see the field"}`,
    );
  }
  console.log(`checker         : ${plan.checker.path}  sha256 ${plan.checker.sha256.slice(0, 16)}`);
  console.log("");
  console.log(`baseline (what attempt ${plan.attempt} actually emitted, replayed through the checker just now):`);
  console.log(`                  ${plan.baseline.accepted ? "ACCEPTED" : `REJECTED — ${plan.baseline.failFast}`}`);
  console.log(`                  signature ${plan.baseline.signature}`);
  console.log("");
  console.log("WHAT INVOKING THIS COSTS — measured, not estimated:");
  if (plan.cost !== null) {
    console.log(`  ~${plan.cost.outputTokens.toLocaleString()} output tokens and ~${plan.cost.wall} of wall clock`);
    console.log("  (that is attempt " + plan.attempt + "'s own measured figure from transcript " + plan.cost.transcript + ")");
  }
  console.log("  plus the input side: ~14k chars of ticket text and one attached CV PDF. (The spec seat");
  console.log("  was NOT shown the reference PNG — that goes to the plan seat. Measured, see this file.)");
  console.log("  Compare: the full run that produced these three attempts cost 1h26m54s and ~628,441 output");
  console.log("  tokens, and reached phase two of ten. One seat replay is ~1/3 of that and answers the");
  console.log("  question the whole project is stuck on.");
  console.log("");
  console.log("THE QUESTION IT ANSWERS:");
  console.log(`  ${plan.question}`);
  console.log("");
  console.log("NOT DISPATCHED. Nothing was sent. To dispatch, re-run with --spend, which will refuse");
  console.log("until the two attachment paths are supplied (they are the owner's real CV and reference");
  console.log("image and are deliberately not in the repo).");
}

async function main(argv) {
  const attemptAt = argv.indexOf("--attempt");
  const attempt = attemptAt >= 0 ? Number(argv[attemptAt + 1]) : 3;
  const promptAt = argv.indexOf("--system-prompt-file");
  const systemPromptFile = promptAt >= 0 ? argv[promptAt + 1] : undefined;

  const plan = await planSeatReplay({ attempt, systemPromptFile });

  if (!argv.includes("--spend")) {
    if (argv.includes("--json")) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    return;
  }

  /**
   * THE SPEND BRANCH. Deliberately incomplete, and it says so instead of
   * pretending: dispatching needs the two attachment files, which are not in the
   * repo, and a seat caller, which lives in a package another lane is editing.
   * A half-wired dispatcher that quietly sent a call with no attachments would
   * spend 20-40 minutes answering a different question than the one asked.
   */
  console.error("SEAT REPLAY --spend: REFUSED, and here is exactly what is missing.");
  console.error("");
  console.error("  1. attachments. The stored prompt referenced:");
  for (const a of plan.storedInputs.attachments) {
    console.error(`       ${a.kind} ${a.mediaType ?? ""} ${a.base64Chars} base64 chars sha256(base64) ${a.sha256OfBase64.slice(0, 16)}`);
  }
  console.error("     Supply it with --cv <path.pdf>. Its digest is checked");
  console.error("     against the recorded ones, so a replay cannot silently run on different inputs.");
  console.error("");
  console.error("  2. a dispatcher. The seat caller lives in the dashboard/bakeoff packages, which are");
  console.error("     under concurrent edit. This entrypoint deliberately owns no code there.");
  console.error("");
  console.error(`  Cost if it did run: ~${plan.cost?.outputTokens.toLocaleString() ?? "?"} output tokens, ~${plan.cost?.wall ?? "?"}.`);
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
