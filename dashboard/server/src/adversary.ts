/**
 * adversary.ts — `/debugfix --web --max`, ported to something the model can run.
 *
 * WHY A PORT AND NOT A CALL. `/debugfix` is a slash command declared with
 * `disable-model-invocation: true`, so this program cannot invoke it. What is
 * reproduced here is its PROCEDURE: attack the running artefact through its UI
 * the way a careless or hostile user would, collect evidence-backed findings,
 * and feed them back as fix work.
 *
 * THREE PROPERTIES, EACH ENFORCED RATHER THAN DESCRIBED:
 *
 *   IT NEEDS A RUNNING URL. A static read of the source is not this pass. No
 *   `previewUrl` means no adversary — not a degraded adversary.
 *
 *   IT IS READ-ONLY. `human-factors-adversary` declares `disallowedTools`
 *   covering Write/Edit/MultiEdit/NotebookEdit, the Agent tool (which could
 *   spawn something that writes) and every credential-bearing MCP server. That
 *   list is mirrored in {@link ADVERSARY_DISALLOWED_TOOLS} and a test asserts
 *   the mirror against the agent file on disk, because a copy drifts.
 *
 *   ITS FINDINGS ARE EVIDENCE, NOT A VERDICT. {@link withAdversaryFindings}
 *   appends to `failures` and does not touch `heldOutUnmet`. `heldOutPass` is
 *   computed by the sealed scorer from the frozen suite and nothing here may
 *   move it — an adversary that could change the verdict would be a second,
 *   unsealed grader.
 *
 * THE SAFETY GATE FAILS CLOSED (/debugfix §0.5). The default environment is
 * PROD-OR-UNKNOWN, under which nothing that commits state may be clicked. The
 * dashboard's preview is a loopback static server with no backend, so this is
 * normally moot — which is exactly why it is asserted rather than assumed. The
 * unlock is an explicit argument no current caller passes.
 *
 * NOT WIRED INTO A RUN AS OF THIS COMMIT, and that is stated rather than left to
 * be discovered. Two things this lane does not own are missing: `ADVERSARY_AGENT`
 * is not in `DELIVERY_LANES` (agent-shortlist.ts), so a delegated call would be
 * denied by the PreToolUse hook and produce nothing distinguishable from an
 * agent with nothing to do; and `BuildRequest` (builders/types.ts) has no
 * `disallowedTools` field to carry the denylist to a driver. Both are asserted
 * by tests here so the gap cannot be mistaken for wiring that works.
 */

import type { Surface } from "./agent-shortlist.js";
import type { AgentVisibleReport, FailureClass, FixableFailure } from "./gate-report.js";

export const ADVERSARY_AGENT = "human-factors-adversary";

export type AdversarySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** What the caller asserts about the target. Default is the forbidding one. */
export type AdversaryEnvironment = "TEST" | "PROD_OR_UNKNOWN";

export interface AdversaryFinding {
  readonly severity: AdversarySeverity;
  readonly klass: FailureClass;
  readonly summary: string;
  readonly detail?: string;
}

export interface AdversaryOptions {
  readonly agent: string;
  readonly previewUrl: string;
  readonly environment: AdversaryEnvironment;
  readonly disallowedTools: readonly string[];
  readonly prompt: string;
}

/**
 * Mirror of the `disallowedTools:` frontmatter in
 * `~/.claude/agents/human-factors-adversary.md`, verified against that file by
 * `adversary.test.ts`. Write tools first, then every MCP server that carries a
 * credential — the agent's own note is that clicking "Pay" makes the APP call a
 * real backend, which a tool denylist cannot stop.
 */
export const ADVERSARY_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "mcp__stripe",
  "mcp__github",
  "mcp__supabase",
  "mcp__trigger",
  "mcp__skyvern",
]);

/** Surfaces that have a browsable UI at all. */
const WEB_SURFACES: ReadonlySet<Surface> = new Set<Surface>(["web-ui", "fullstack"]);

/** Loopback only. Anything else is somebody's server. */
function isLoopback(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
}

export function shouldRunAdversary(input: { readonly surface: Surface; readonly previewUrl: string | null }): boolean {
  if (!WEB_SURFACES.has(input.surface)) return false;
  if (input.previewUrl === null) return false;
  return isLoopback(input.previewUrl);
}

const PROD_RULES = [
  "Environment: PROD-OR-UNKNOWN. Commit NOTHING.",
  "- Allowed: viewport/zoom stress, read-only navigation, extreme input typed into fields you do NOT submit.",
  "- Forbidden: any click that writes a row; any form submission; signing in; anything that creates, " +
    "approves, rejects, books, cancels or deletes.",
  "- If you cannot tell whether an action commits state, treat it as committing and skip it.",
].join("\n");

const TEST_RULES = [
  "Environment: environment=TEST — a proven test backend with test keys. Committing attacks are unlocked.",
  "- Two-account attacks still require disposable credentials handed to you explicitly. Never sign in an " +
    "account you were not given.",
].join("\n");

/**
 * What the adversary is told, and what it is denied.
 *
 * The prompt states the environment because the agent's own safety section keys
 * off it and defaults to the forbidding branch when the caller says nothing —
 * so saying nothing here would be relying on the agent to guess right.
 */
export function adversaryOptions(input: {
  readonly previewUrl: string;
  readonly environment?: AdversaryEnvironment;
}): AdversaryOptions {
  const environment = input.environment ?? "PROD_OR_UNKNOWN";
  const prompt = [
    `Attack the running web app at ${input.previewUrl} the way a careless or hostile real user would.`,
    "",
    environment === "TEST" ? TEST_RULES : PROD_RULES,
    "",
    "Report evidence-backed findings only. Every finding needs a severity (CRITICAL / HIGH / MEDIUM / LOW), " +
      "a repro as text, and evidence matched to its class. 'Could not reproduce' is valid only with an " +
      "attempt count. Never invent file:line, error text or network calls.",
    "",
    "You change nothing. You have no Write or Edit tool; hand every repro back as text.",
  ].join("\n");

  return {
    agent: ADVERSARY_AGENT,
    previewUrl: input.previewUrl,
    environment,
    disallowedTools: ADVERSARY_DISALLOWED_TOOLS,
    prompt,
  };
}

/**
 * Fold adversary findings into a report as ordinary fix work.
 *
 * `heldOutUnmet` IS COPIED UNCHANGED. That is the whole point: these findings
 * are evidence produced by an unsealed pass against a live preview, and letting
 * them move the criterion counts would make `heldOutPass` partly a function of
 * something the frozen suite never asserted.
 */
export function withAdversaryFindings(
  report: AgentVisibleReport,
  findings: readonly AdversaryFinding[],
): AgentVisibleReport {
  if (findings.length === 0) return report;
  const extra: FixableFailure[] = findings.map((finding, index) => ({
    id: `adversary:${String(index + 1)}`,
    klass: finding.klass,
    summary: `[${finding.severity}] ${finding.summary}`,
    detail: finding.detail ?? "",
    command: null,
    exitCode: null,
  }));
  return { ...report, failures: [...report.failures, ...extra] };
}
