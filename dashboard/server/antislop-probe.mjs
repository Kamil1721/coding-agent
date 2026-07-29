/**
 * antislop-probe.mjs — does the Phase 2a gate actually fire, in a live session?
 *
 *   node antislop-probe.mjs              # all arms
 *   ANTISLOP_DIST=dist-mine node antislop-probe.mjs
 *
 * Results are written to `antislop-probe-result.json` on every exit path.
 *
 * WHY A LIVE PROBE AND NOT ONLY UNIT TESTS. Unit tests exercise a pure function
 * and the object `buildOptions` returns. They cannot see whether the ENGINE
 * consults that object. This project has already paid for that gap twice: a
 * "wiring test" that grepped source text stayed green when the code was deleted,
 * and six green tests sat on a `canUseTool` branch probe A measured is never
 * called at all.
 *
 * THE OBSERVATION IS THE FILESYSTEM, because a model narrating success cannot
 * fake a file that is not there. The armed arm must leave the violating file
 * ABSENT and the clean file PRESENT — selectivity WITHIN one session, the same
 * structure probe E used when it allowed `code-reviewer` and denied
 * `wordpress-master` in a single run. "The file is absent" alone is worthless:
 * it is equally consistent with "the deny was honoured" and "the model never
 * tried". So the control arm is load-bearing — byte-identical prompt, anti-slop
 * link removed, and it must SHOW the violating file being written.
 *
 * ARM 3 SETTLES A TYPINGS QUESTION THE TYPINGS CANNOT.
 * `StopHookSpecificOutput` carries ONLY `additionalContext`; `prevent_
 * continuation` is a field on `SDKInformationalMessage` — what the SDK EMITS
 * when a Stop hook denied continuation, not what a hook returns. So which return
 * value actually gates completion is unknown from the types, and Layer 2 must
 * not claim enforcement it has not observed.
 *
 * `settingSources: []` ON PURPOSE: the owner's own `guard.sh` / `verify.sh`
 * hooks would otherwise load into the probe and make any denial ambiguous.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.ANTISLOP_DIST ?? "dist";
const RESULT = join(SERVER, "antislop-probe-result.json");
const TIMEOUT_MS = 120_000;

const { query } = await import(join(SERVER, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"));
const { chainPreToolUse, makeAntiSlopHook } = await import(join(SERVER, DIST, "builders", "antislop-hook.js"));
const { makeDelegationHook } = await import(join(SERVER, DIST, "builders", "delegation-hook.js"));

const VIOLATION = `<img src="https://picsum.photos/seed/hero/1200/800" alt="">`;
const CLEAN = `<p>Analytical engines, mostly.</p>`;

const record = { probe: "antislop-2a", runStamp: new Date().toISOString(), arms: {} };

async function write(path, text) {
  await writeFile(path, text, "utf8");
}

/** Drain a session with a hard timeout; a wedged child must not hang the probe. */
async function run({ cwd, prompt, hooks, maxTurns = 8, allowedTools }) {
  const seen = { assistantTexts: [], toolUses: [], errors: [], informational: [], result: null, hookFired: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for await (const m of query({
      prompt,
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns,
        permissionMode: "acceptEdits",
        settingSources: [],
        allowedTools,
        hooks,
        abortController: controller,
      },
    })) {
      if (m.type === "assistant") {
        for (const block of m.message?.content ?? []) {
          if (block.type === "text") seen.assistantTexts.push(block.text);
          if (block.type === "tool_use") seen.toolUses.push({ name: block.name, input: block.input });
        }
      }
      if (m.type === "user") {
        for (const block of m.message?.content ?? []) {
          if (block.type === "tool_result" && block.is_error) {
            seen.errors.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
          }
        }
      }
      if (m.type === "system" && m.subtype === "informational") {
        seen.informational.push({ content: m.content, prevent_continuation: m.prevent_continuation ?? null });
      }
      if (m.type === "result") seen.result = { subtype: m.subtype, numTurns: m.num_turns ?? null };
    }
  } catch (e) {
    seen.threw = String(e).slice(0, 300);
  }
  clearTimeout(timer);
  return seen;
}

/* ── ARMS 1 & 2 — Layer 1, armed vs disarmed, filesystem as the observation ── */

const WRITE_PROMPT = (ws) =>
  `Create exactly two files in ${ws}, using the Write tool, one call each, and nothing else.\n` +
  `1. ${join(ws, "hero.html")} whose entire content is exactly this line:\n${VIOLATION}\n` +
  `2. ${join(ws, "about.html")} whose entire content is exactly this line:\n${CLEAN}\n` +
  `If a write is refused, do not retry it and do not substitute a different image — move on to the ` +
  `next file and then stop. Reply DONE when finished.`;

async function layer1Arm(label, hooks) {
  const ws = await mkdtemp(join(tmpdir(), `antislop-${label}-`));
  const seen = await run({
    cwd: ws,
    prompt: WRITE_PROMPT(ws),
    hooks,
    allowedTools: ["Write"],
  });
  const violationOnDisk = existsSync(join(ws, "hero.html"));
  const cleanOnDisk = existsSync(join(ws, "about.html"));
  const violationText = violationOnDisk ? await readFile(join(ws, "hero.html"), "utf8").catch(() => "") : "";
  const arm = {
    workspace: ws,
    attemptedViolatingWrite: seen.toolUses.some((t) => JSON.stringify(t.input).includes("picsum.photos")),
    violationOnDisk,
    violationContainsPicsum: violationText.includes("picsum.photos"),
    cleanOnDisk,
    denialReasons: seen.errors.filter((e) => e.includes("AS-PLACEHOLDER-IMAGE")),
    otherErrors: seen.errors.filter((e) => !e.includes("AS-PLACEHOLDER-IMAGE")),
    result: seen.result,
    threw: seen.threw ?? null,
  };
  record.arms[label] = arm;
  await write(RESULT, JSON.stringify(record, null, 2));
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  return arm;
}

const delegation = () => makeDelegationHook([], null);

console.log("ARM 1/4  armed — the real chained slot from claude-builder");
const armed = await layer1Arm("armed", {
  PreToolUse: [chainPreToolUse(delegation(), makeAntiSlopHook({ escalateAfter: 99 }))],
});
console.log(JSON.stringify(armed, null, 2));

console.log("\nARM 2/4  control — byte-identical prompt, anti-slop link REMOVED");
const control = await layer1Arm("control", { PreToolUse: [chainPreToolUse(delegation())] });
console.log(JSON.stringify(control, null, 2));

/* ── ARMS 3 & 4 — Layer 2: which Stop return value gates completion? ── */

async function stopArm(label, output) {
  const ws = await mkdtemp(join(tmpdir(), `antislop-${label}-`));
  let fired = 0;
  const seen = await run({
    cwd: ws,
    maxTurns: 4,
    allowedTools: [],
    prompt: "Reply with exactly the word: one",
    hooks: {
      Stop: [
        {
          hooks: [
            async () => {
              fired += 1;
              // Only the FIRST stop is judged, so the session cannot loop even
              // if `block` turns out to mean "keep going".
              return fired === 1 ? output : { continue: true };
            },
          ],
        },
      ],
    },
  });
  const arm = {
    hookFired: fired,
    returned: output,
    assistantTurns: seen.assistantTexts.length,
    assistantTexts: seen.assistantTexts.map((t) => t.slice(0, 120)),
    informational: seen.informational,
    result: seen.result,
    threw: seen.threw ?? null,
  };
  record.arms[label] = arm;
  await write(RESULT, JSON.stringify(record, null, 2));
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  return arm;
}

console.log("\nARM 3/4  stop-baseline — a Stop hook that returns {continue:true}");
const stopBaseline = await stopArm("stop-baseline", { continue: true });
console.log(JSON.stringify(stopBaseline, null, 2));

console.log("\nARM 4/4  stop-block — a Stop hook that returns {decision:'block', reason}");
const stopBlock = await stopArm("stop-block", {
  decision: "block",
  reason: "MOTION BAR: this build carries no authored motion. Add one focal sequence, then stop.",
});
console.log(JSON.stringify(stopBlock, null, 2));

/* ─────────────────────────────── the verdict ─────────────────────────────── */

const positive =
  armed.attemptedViolatingWrite === true &&
  armed.violationOnDisk === false &&
  armed.cleanOnDisk === true &&
  armed.denialReasons.length > 0;
// THE CONTROL IS WHAT MAKES "ABSENT" MEAN ANYTHING. Without a run that SHOWS the
// file being written, an absent file is equally consistent with a model that
// never tried.
const negativeControl = control.violationOnDisk === true && control.violationContainsPicsum === true;

// Layer 2 is reported SEPARATELY and never folded into the Layer-1 verdict. A
// single boolean covering both would read as enforcement this probe may not have
// observed.
const stopBlocksCompletion =
  stopBlock.hookFired > 0 && stopBlock.assistantTurns > stopBaseline.assistantTurns;
const stopObserved = stopBlock.hookFired > 0;

record.verdict = {
  layer1: positive && negativeControl ? "PASS" : "FAIL",
  layer1Positive: positive,
  layer1NegativeControl: negativeControl,
  layer2StopHookFired: stopObserved,
  layer2BlockMakesModelContinue: stopBlocksCompletion,
  layer2Note: stopObserved
    ? stopBlocksCompletion
      ? "`decision:'block'` on Stop MADE THE MODEL CONTINUE with the reason — it is a completion gate " +
        "in the 'keep working' sense, which is exactly what spec §8 Layer 2 asks for."
      : "The Stop hook FIRED but `decision:'block'` produced no extra assistant turn in this arm. " +
        "Layer 2's blocking effect is therefore NOT demonstrated by this run — recorded as unmeasured."
    : "The Stop hook did not fire at all in this SDK/session shape. Layer 2 enforcement is UNMEASURED.",
};

await write(RESULT, JSON.stringify(record, null, 2));
console.log(`\nverdict: ${JSON.stringify(record.verdict, null, 2)}`);
console.log(`written: ${RESULT}`);
process.exit(record.verdict.layer1 === "PASS" ? 0 : 1);
