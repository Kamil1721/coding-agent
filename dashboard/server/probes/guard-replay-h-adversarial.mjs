/**
 * ADVERSARIAL REPLAY — probe H claim 1, against the SHIPPED guard.
 *
 * Probe H reproduced the production guard "from its described shape" and never
 * read delegation-hook.ts (scope fence). That leaves its headline premise
 * ("SendMessage is waved through BY CONSTRUCTION") measured for a stand-in and
 * ASSUMED for the real thing.
 *
 * This file removes the assumption without touching the fenced source: it
 * imports the COMPILED artefact dist/builders/delegation-hook.js and runs the
 * real hook over the VERBATIM tool_input objects recorded in probes/results/raw
 * during probes H and H2.
 *
 * CONTROLS, in the same execution:
 *   - a denied-agent Agent call MUST come back `deny`  (guard is armed)
 *   - an allowed-agent Agent call MUST come back `continue` (guard is not a
 *     blanket denier — otherwise "SendMessage continues" would mean nothing)
 * If either control fails, every other line printed here is void, and the
 * script says so and exits non-zero.
 *
 * READ-ONLY. Writes nothing. Starts no session.
 */
import { readFileSync } from "node:fs";

const DIST = "/Users/kamilborzecki/Projects/coding-agent/dashboard/server/dist/builders/delegation-hook.js";
const { makeDelegationHook, isDelegationShaped, decideDelegation } = await import(DIST);

const RAW = "/Users/kamilborzecki/Projects/coding-agent/dashboard/server/probes/results/raw";

/** Every parent-side tool_use the H probes recorded, input string parsed back
 *  into the object the hook would have been handed. */
function recordedInputs(file) {
  const log = JSON.parse(readFileSync(`${RAW}/${file}`, "utf8"));
  const out = [];
  for (const session of log.sessions ?? []) {
    for (const use of session.toolUses ?? []) {
      let input;
      try {
        input = JSON.parse(use.input);
      } catch {
        continue;
      }
      out.push({ source: `${file}:${session.label}`, name: use.name, input });
    }
  }
  return out;
}

const cases = [
  ...recordedInputs("H-session-log.json"),
  ...recordedInputs("H2-DENIED-TARGET-session-log.json"),
];

// The shortlist as the H probes configured it: code-reviewer allowed,
// wordpress-master deliberately NOT.
const SHORTLIST = ["code-reviewer", "trigger-dev-expert", "debugger"];
const hookSpec = makeDelegationHook(SHORTLIST);
const hookFn = hookSpec.hooks[0];

async function runGuard(toolName, toolInput) {
  const result = await hookFn({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  });
  const decision = result?.hookSpecificOutput?.permissionDecision ?? null;
  return {
    verdict: decision === "deny" ? "DENY" : result?.continue === true ? "CONTINUE" : `OTHER:${JSON.stringify(result)}`,
    reason: result?.hookSpecificOutput?.permissionDecisionReason ?? null,
  };
}

console.log("=== SHIPPED GUARD (dist/builders/delegation-hook.js) vs RECORDED INPUTS ===\n");
console.log("isDelegationShaped is:", isDelegationShaped.toString().replace(/\s+/g, " "));
console.log("shortlist:", SHORTLIST.join(", "), "\n");

const rows = [];
for (const c of cases) {
  const r = await runGuard(c.name, c.input);
  rows.push({ ...c, ...r });
  console.log(
    `${c.name.padEnd(12)} keys=[${Object.keys(c.input).sort().join(",")}]\n` +
      `    subagent_type=${JSON.stringify(c.input.subagent_type)}  isolation=${JSON.stringify(c.input.isolation)}  ` +
      `run_in_background=${JSON.stringify(c.input.run_in_background)}\n` +
      `    -> ${r.verdict}${r.reason ? `  reason: ${r.reason.slice(0, 90)}…` : ""}\n` +
      `    (${c.source})\n`,
  );
}

// ── CONTROLS ────────────────────────────────────────────────────────────────
const deniedAgent = rows.find((r) => r.name === "Agent" && r.input.subagent_type === "wordpress-master");
const allowedAgent = rows.find((r) => r.name === "Agent" && r.input.subagent_type === "code-reviewer");
const sendMessages = rows.filter((r) => r.name === "SendMessage");

const controlDenyHeld = deniedAgent?.verdict === "DENY";
const controlAllowHeld = allowedAgent?.verdict === "CONTINUE";

console.log("=== CONTROLS ===");
console.log(`  denied-type Agent{subagent_type:"wordpress-master"} -> ${deniedAgent?.verdict ?? "NOT PRESENT"}  (must be DENY)`);
console.log(`  allowed-type Agent{subagent_type:"code-reviewer"}   -> ${allowedAgent?.verdict ?? "NOT PRESENT"}  (must be CONTINUE)`);

if (!controlDenyHeld || !controlAllowHeld) {
  console.log("\nVOID: a control failed. The SendMessage readings below prove nothing.");
  process.exitCode = 1;
} else {
  console.log("\n  BOTH CONTROLS HELD — the guard is armed and is not a blanket denier in this harness.");
}

console.log("\n=== SENDMESSAGE ===");
console.log(`  ${sendMessages.length} recorded SendMessage inputs replayed.`);
const verdicts = [...new Set(sendMessages.map((r) => r.verdict))];
console.log(`  distinct verdicts: ${verdicts.join(", ")}`);
console.log(
  `  any carrying subagent_type: ${sendMessages.some((r) => "subagent_type" in r.input)}\n` +
    `  any carrying isolation:     ${sendMessages.some((r) => "isolation" in r.input)}`,
);

// A synthetic leak case: does the router even LOOK at SendMessage if the shape
// changed? Proves the CONTINUE above is caused by the shape, not by the name.
const synthetic = await runGuard("SendMessage", {
  to: "a778c6fcb0f4113bb",
  summary: "x",
  message: "y",
  subagent_type: "wordpress-master",
});
console.log(
  `\n  differential: the SAME tool_name with subagent_type added -> ${synthetic.verdict}\n` +
    "  (so the CONTINUE is produced by the INPUT SHAPE, not by the tool name being unknown)",
);

console.log(
  "\ndecideDelegation on a bare SendMessage input, called directly (bypassing the router):",
  JSON.stringify(decideDelegation(sendMessages[0]?.input ?? {}, SHORTLIST)).slice(0, 160),
);
