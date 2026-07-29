/**
 * APPARATUS CONTROL for probe A — does `canUseTool` fire AT ALL in this harness?
 *
 * Probe A measured `denyConsulted=[]` in all four sessions: the callback fired
 * for NO tool, and the subagent started anyway. Two readings are consistent with
 * that, and they mean opposite things:
 *
 *   (i)  the engine does not consult `canUseTool` for Agent (a FINDING), or
 *   (ii) `canUseTool` is not wired at all when `query()` is given a plain string
 *        prompt in SDK 0.3.220 (a HARNESS BUG — probe A would prove nothing).
 *
 * This script settles it WITHOUT touching probe A: same option shape, same
 * string-prompt call style, but a prompt whose tool (Write) is not pre-approved
 * under `permissionMode: "default"`. If the callback fires here, wiring works
 * and reading (i) stands. If it never fires, reading (ii) stands.
 *
 * Runs the cheapest arm first and stops as soon as the callback fires.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Absolute path: this script lives outside the package, so bare specifier
// resolution does not find node_modules. Same module, same version.
const { query } = await import(
  "/Users/kamilborzecki/Projects/coding-agent/dashboard/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
);

const warnings = [];
process.on("warning", (w) => warnings.push(`${w.code ?? "?"}: ${w.message}`));

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "apparatus-")));
const workspace = join(root, "workspace");
mkdirSync(workspace);
writeFileSync(join(workspace, "ordinary.txt"), "this file is not sealed\n");

const HARD_TIMEOUT_MS = 90_000;

async function arm(label, options, prompt) {
  const consulted = [];
  const toolUses = [];
  let sawResult = false;
  let timedOut = false;
  let error = null;
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, HARD_TIMEOUT_MS);
  let session;
  try {
    session = query({
      prompt,
      options: {
        ...options,
        abortController,
        canUseTool: async (toolName, input) => {
          consulted.push(toolName);
          return { behavior: "allow", updatedInput: input };
        },
      },
    });
    for await (const m of session) {
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b?.type === "tool_use") toolUses.push(b.name);
        }
      }
      if (m.type === "result") sawResult = true;
    }
  } catch (e) {
    if (!timedOut) error = String(e?.message ?? e);
  } finally {
    clearTimeout(timer);
    abortController.abort();
    try {
      await session?.return?.(undefined);
    } catch {
      /* child already gone */
    }
  }
  return { label, consulted, toolUses, sawResult, timedOut, error };
}

const base = {
  cwd: workspace,
  model: "claude-haiku-4-5-20251001",
  maxTurns: 4,
  includePartialMessages: false,
  tools: { type: "preset", preset: "claude_code" },
  settingSources: ["user"],
};

const WRITE_PROMPT = "Create a file named apparatus.txt in the current directory containing the single word HELLO. Use the Write tool.";

const results = [];

// ARM 1 — probe A's exact option shape (sandbox on, permissionMode "default").
results.push(
  await arm(
    "1/probeA-shape-default-mode",
    {
      ...base,
      permissionMode: "default",
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: [workspace] } },
    },
    WRITE_PROMPT,
  ),
);

// ARM 2 — only if arm 1 was silent: no sandbox, so nothing can pre-approve the
// write via the sandbox's own allowWrite list.
if (results[0].consulted.length === 0) {
  results.push(
    await arm("2/no-sandbox-default-mode", { ...base, permissionMode: "default" }, WRITE_PROMPT),
  );
}

// ARM 3 — only if both were silent: a Bash command, the other classically
// permission-gated tool, with no sandbox auto-allow in play.
if (results.every((r) => r.consulted.length === 0)) {
  results.push(
    await arm(
      "3/no-sandbox-bash",
      { ...base, permissionMode: "default" },
      "Run this shell command and report its output: echo APPARATUS-OK",
    ),
  );
}

const out = {
  ranAt: new Date().toISOString(),
  fixture: root,
  wroteFile: existsSync(join(workspace, "apparatus.txt")),
  warnings,
  arms: results,
  verdict:
    results.some((r) => r.consulted.length > 0)
      ? "CALLBACK-WIRING-WORKS: canUseTool fires in this harness for at least one tool, so probe A's empty consulted list is a fact about the Agent tool, not about the wiring."
      : "CALLBACK-NEVER-FIRES: canUseTool did not fire for any tool in any arm — probe A's result may be a harness wiring bug, not an engine finding.",
};
console.log(JSON.stringify(out, null, 2));
