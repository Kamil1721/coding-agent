/**
 * design-segment-probe.mjs — does `resume: <sessionId>` actually continue the
 * session, and are a resumed session's token totals per-call or cumulative?
 *
 *   node src/design-segment-probe.mjs
 *   DESIGN_PROBE_MODEL=claude-haiku-4-5-20251001 node src/design-segment-probe.mjs
 *
 * The result is written to `design-segment-probe-result.json` on every exit path.
 *
 * WHY THIS PROBE EXISTS. The whole of Phase 2b rests on ONE claim about an
 * external tool: that a second `query()` carrying `resume: <id>` continues the
 * first one's conversation rather than starting a fresh session that happens to
 * accept the option. Everything in `orchestrator.test.ts` tests OUR side of that
 * seam — which id we pass, which prompt we build, which shortlist we narrow. Not
 * one of those assertions can tell a resume that worked from a resume the SDK
 * silently ignored, because the SDK accepting an option it no longer honours
 * produces exactly the same observable on our side of the wire.
 *
 * THREE ARMS, AND THE CONTROL IS THE ONE THAT MAKES THE OTHER TWO MEAN ANYTHING:
 *
 *   segment 1        a trivial prompt ("remember the word FERROUS"); record the
 *                    `session_id` from `system/init`.
 *   segment 2 ARMED  a second query with `resume: <that id>`, asking which word.
 *                    PASSES only if the reply names FERROUS **and**
 *                    `system/init.session_id` is the SAME id.
 *   segment 2 CONTROL a byte-identical second query with `resume` OMITTED. It
 *                    must NOT know the word. Without this arm, a model that
 *                    guessed, or a prompt that leaked the word, would read as a
 *                    successful resume — which is this repository's signature
 *                    defect wearing a live-run costume.
 *
 * AND THE TOKEN QUESTION, WHICH IS NOT DECORATION. `mergeTokenTotals` takes a
 * field-wise MAXIMUM because nothing in this repo had ever run two segments
 * against one session, so whether segment 2's `usage` is per-call or already
 * cumulative was unknowable. Both arms print their totals:
 *
 *   segment 2 input >= segment 1 input   -> CUMULATIVE; the max is exactly right
 *   segment 2 input is small/independent -> PER-CALL; the merge should become a
 *                                           SUM, and that is a one-line change in
 *                                           tokens.ts to be made in the same
 *                                           commit as this probe's result.
 *
 * IF THE ARMED ARM FAILS, STOP. The two-segment model is wrong and the park has
 * to move into a hook-await instead of a second `query()`. Do not paper over it:
 * a resume that does not resume means segment 2 rebuilds the ticket from nothing
 * with the design prompt's context gone, and the run still looks like a success.
 *
 * `settingSources: []` ON PURPOSE, for the same reason `antislop-probe.mjs` does
 * it: the owner's own hooks and 144 agents would otherwise load into the probe
 * and make any result ambiguous.
 *
 * IT SPENDS THE OWNER'S SUBSCRIPTION. Three short haiku sessions. It is NOT run
 * by `npm test` and must not be: a probe in the suite is a suite that cannot run
 * offline.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULT = join(SERVER, "design-segment-probe-result.json");
const MODEL = process.env.DESIGN_PROBE_MODEL ?? "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 120_000;

/** A word with no reason to appear in a reply that did not carry the context. */
const SECRET = "FERROUS";
const SEGMENT_1 = `Remember the word ${SECRET}. Reply with exactly the word OK and nothing else.`;
const SEGMENT_2 = "What word did I ask you to remember? Reply with just that word, or with UNKNOWN.";

const { query } = await import(join(SERVER, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"));

const record = {
  probe: "design-segment-resume-2b",
  runStamp: new Date().toISOString(),
  model: MODEL,
  arms: {},
  verdict: "not-run",
  tokenAccounting: "unknown",
};

async function finish(code) {
  await writeFile(RESULT, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${RESULT}`);
  process.exit(code);
}

/**
 * Drain one session with a hard timeout and report what it said.
 *
 * `sessionId` is read from `system/init`, which is the field the orchestrator
 * persists as `builderSessionId` — the same one, not a proxy for it.
 */
async function run({ cwd, prompt, resume }) {
  const seen = { text: "", sessionId: null, usage: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        model: MODEL,
        maxTurns: 4,
        permissionMode: "acceptEdits",
        settingSources: [],
        allowedTools: [],
        ...(resume === undefined ? {} : { resume }),
        abortController: controller,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        seen.sessionId = message.session_id ?? null;
      }
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text") seen.text += block.text;
        }
      }
      if (message.type === "result") {
        seen.usage = {
          inputTokens: message.usage?.input_tokens ?? null,
          outputTokens: message.usage?.output_tokens ?? null,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? null,
          cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? null,
        };
        if (message.session_id !== undefined && seen.sessionId === null) seen.sessionId = message.session_id;
      }
    }
  } catch (error) {
    seen.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  return seen;
}

const cwd = await mkdtemp(join(tmpdir(), "design-resume-probe-"));
try {
  console.log(`segment 1 — ${MODEL}`);
  const first = await run({ cwd, prompt: SEGMENT_1 });
  record.arms.segment1 = first;
  console.log(`  session_id: ${String(first.sessionId)}`);
  console.log(`  usage:      ${JSON.stringify(first.usage)}`);
  if (first.sessionId === null) {
    record.verdict = "inconclusive: segment 1 reported no session_id, so there is nothing to resume";
    console.error(`\n${record.verdict}`);
    await finish(2);
  }

  console.log("segment 2 ARMED — resume: <segment 1's id>");
  const armed = await run({ cwd, prompt: SEGMENT_2, resume: first.sessionId });
  record.arms.segment2Armed = armed;
  console.log(`  session_id: ${String(armed.sessionId)}`);
  console.log(`  said:       ${JSON.stringify(armed.text.trim().slice(0, 200))}`);
  console.log(`  usage:      ${JSON.stringify(armed.usage)}`);

  console.log("segment 2 CONTROL — byte-identical prompt, resume OMITTED");
  const control = await run({ cwd, prompt: SEGMENT_2 });
  record.arms.segment2Control = control;
  console.log(`  said:       ${JSON.stringify(control.text.trim().slice(0, 200))}`);

  const armedKnows = armed.text.toUpperCase().includes(SECRET);
  const controlKnows = control.text.toUpperCase().includes(SECRET);
  const sameSession = armed.sessionId === first.sessionId;

  record.arms.summary = { armedKnows, controlKnows, sameSession };

  // TOKEN ACCOUNTING — the question `mergeTokenTotals` could not settle.
  //
  // ACROSS ALL FOUR FIELDS, NOT `inputTokens` ALONE. `input_tokens` on a cached
  // session is the UNCACHED remainder and is a single-digit number in both arms,
  // so `armedInput >= firstInput` is a comparison of 10 against 10 — it answers
  // "cumulative" for a per-call stream and for a cumulative one alike, which is a
  // check that can only observe one outcome. Cumulative totals are monotonic BY
  // DEFINITION, so ANY field of segment 2 that is strictly below segment 1's
  // settles it: a running total cannot go down.
  const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
  const comparable = FIELDS.filter(
    (field) => typeof first.usage?.[field] === "number" && typeof armed.usage?.[field] === "number",
  );
  const decreased = comparable.filter((field) => armed.usage[field] < first.usage[field]);
  if (comparable.length > 0) {
    record.tokenAccounting = decreased.length > 0 ? "per-call" : "cumulative";
    record.tokenAccountingEvidence = { comparable, decreased };
    record.tokenAccountingDetail =
      decreased.length > 0
        ? `segment 2 reported LESS than segment 1 on ${decreased.join(", ")}, and a running total cannot ` +
          "go down — so a resumed session reports PER-CALL totals and mergeTokenTotals must be a SUM. " +
          "A field-wise max would silently drop segment 2's share of every field segment 1 happened to " +
          "lead on."
        : "no field of segment 2 fell below segment 1's, so a resumed session reports CUMULATIVE totals " +
          "and mergeTokenTotals's field-wise max is exactly right.";
  }

  if (!armedKnows || !sameSession) {
    record.verdict =
      "FAILED — resume does not continue the session. The two-segment build model is wrong and the " +
      "design park has to move into a hook-await rather than a second query(). Phase 2b is BLOCKED.";
    console.error(`\n${record.verdict}`);
    await finish(1);
  }
  if (controlKnows) {
    record.verdict =
      "INCONCLUSIVE — the CONTROL arm also named the word, so the armed arm proves nothing: either the " +
      "prompt leaks it or the model guessed. Change the secret and re-run.";
    console.error(`\n${record.verdict}`);
    await finish(2);
  }

  record.verdict =
    "PASSED — the armed arm named the word and reported segment 1's session_id; the control arm, with " +
    "the same prompt and no resume, did not. `resume: <sessionId>` continues the session.";
  console.log(`\n${record.verdict}`);
  console.log(`token accounting: ${record.tokenAccounting}`);
  await finish(0);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
