/**
 * builders/codex-builder.ts — the OpenAI build driver.
 *
 * AUTHENTICATION, VERIFIED BY READING THE SDK'S OWN SOURCE. `@openai/codex-sdk`
 * spawns the `codex` CLI binary and sets `CODEX_API_KEY` in the child
 * environment ONLY when a `CodexOptions.apiKey` is supplied. This driver never
 * supplies one, so the CLI authenticates with the `codex login` browser-OAuth
 * credentials in CODEX_HOME. No API key is read, required or accepted.
 *
 * ISOLATION. `sandboxMode: "workspace-write"` and `approvalPolicy: "never"` are
 * the Codex CLI's own first-class controls: the agent may write inside the
 * working directory and may not stop to ask a human who is not there. Network
 * access is left enabled, for the same reason as the Claude driver — a builder
 * that cannot install a dependency cannot build most tickets. The dashboard's
 * build phase is not sealed; the SCORING phase is, and that is where the seal
 * is a measurement control.
 *
 * THE HELD-OUT SUITE IS NOT PROTECTED FROM READING ON THIS PATH. Stated here
 * rather than left to be discovered. `workspace-write` restricts WRITES to the
 * working directory; reads are unrestricted, and `ThreadOptions` exposes
 * nothing read-denying — its path-related field, `additionalDirectories`, is an
 * ALLOW list, so reaching for it would widen access, not narrow it. There is
 * therefore no mechanism on this driver equivalent to the Claude driver's
 * `sandbox.filesystem.denyRead`, and `request.sealedRoots` is readable by a
 * Codex build with `cat` or `grep`. That field now carries TWO roots, not one:
 * `dashboard/acceptance` (the suite store) and `dashboard/results/scorer-out`,
 * whose `result.json` persists `criterionCoverage[].testRefs` — held-out TEST
 * TITLES — outside the sealed store. Both are exposed on this path.
 *
 * CONSEQUENCE, PLAINLY: if a Codex build reads the held-out tests, that run's
 * `heldOutPass` and `falseFinish` mean nothing, and nothing detects it. The
 * bake-off does not have this problem because its builder runs inside a
 * container the held-out half is never mounted into; this builder runs on the
 * host as the same user. Recorded in dashboard/STATUS.md under "The held-out
 * boundary". Do not describe the dashboard gate as sealed against the builder.
 *
 * MODEL ID. `CODEX_DEFAULT_MODEL_ID` means "pass no model option at all and let
 * the CLI use the model the owner configured". The Codex CLI exposes no model
 * list to enumerate and `gpt-5.6-luna` has never been confirmed against any
 * vendor model list (bakeoff STATUS section 1.3), so the dashboard does not
 * assert one. Any other id came from `DASHBOARD_CODEX_MODELS` and is the
 * owner's assertion, passed through verbatim.
 *
 * TOKENS ARE OPENAI TOKENS AND ARE NEVER ADDED TO THE CLAUDE COUNTS from the
 * spec seat of the same run. Tokenizers differ; see tokens.ts.
 */

import { Codex } from "@openai/codex-sdk";
import type { Thread, ThreadEvent, ThreadItem, ThreadOptions } from "@openai/codex-sdk";
import { NOT_RATE_LIMITED, truncate } from "../claude-common.js";
import type { RateLimitState } from "../claude-common.js";
import { CODEX_DEFAULT_MODEL_ID } from "../models.js";
import { subscriptionSubprocessEnvStrings } from "../subprocess-env.js";
import { addTokens, zeroTokens } from "../tokens.js";
import type { TokenTotals } from "../tokens.js";
import type { BuildEventSink, BuildOutcome, BuildRequest, SubscriptionBuilder } from "./types.js";

/** Codex reports usage per turn. One build is one turn unless it is resumed. */
function tokensFromUsage(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
}): TokenTotals {
  return {
    provider: "openai",
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    callCount: 1,
  };
}

function describeItem(item: ThreadItem, sink: BuildEventSink): void {
  switch (item.type) {
    case "command_execution":
      sink.tool("Bash", truncate(item.command, 160));
      sink.raw(`\n[command] ${item.command}\n${item.aggregated_output}\n`);
      return;
    case "file_change": {
      const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
      sink.tool("Edit", truncate(summary, 160));
      sink.raw(`\n[patch ${item.status}] ${summary}\n`);
      return;
    }
    case "mcp_tool_call":
      sink.tool(`${item.server}/${item.tool}`, item.status);
      return;
    case "web_search":
      sink.tool("WebSearch", truncate(item.query, 160));
      return;
    case "agent_message":
      sink.raw(`\n[assistant]\n${item.text}\n`);
      sink.log("info", truncate(item.text, 500));
      return;
    case "error":
      sink.log("error", truncate(item.message, 400));
      return;
    case "todo_list": {
      const open = item.items.filter((entry) => !entry.completed).length;
      sink.log("info", `plan: ${String(item.items.length - open)}/${String(item.items.length)} done`);
      return;
    }
    case "reasoning":
      // Deliberately NOT surfaced as a log line and never persisted as
      // evidence: doc 02 section 5.2 keeps builder chain-of-thought out of
      // anything a grader reads. It goes to the raw transcript only.
      sink.raw(`\n[reasoning]\n${item.text}\n`);
      return;
    default:
      return;
  }
}

export class CodexSubscriptionBuilder implements SubscriptionBuilder {
  readonly provider = "openai" as const;

  async build(request: BuildRequest): Promise<BuildOutcome> {
    const { sink } = request;
    let tokens = zeroTokens("openai");
    let rateLimit: RateLimitState = NOT_RATE_LIMITED;
    let sessionId: string | null = request.resumeSessionId;
    let completed = false;
    let failure: string | null = null;

    // NOTE THE ABSENT OPTION: no `apiKey`. That omission is what makes the CLI
    // fall through to the subscription login. Adding one would switch this to
    // metered API billing without any other visible change — and so would an
    // inherited CODEX_API_KEY, which is why the env is filtered rather than
    // forwarded. `CodexOptions.env` REPLACES the child environment entirely,
    // so PATH, HOME and CODEX_HOME are preserved by subtraction.
    const codex = new Codex({ env: subscriptionSubprocessEnvStrings(request.env) });

    const threadOptions: ThreadOptions = {
      workingDirectory: request.workspace,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      // The workspace is git-initialised by the orchestrator, so the CLI's git
      // check passes; this stays false so a missing repo is a loud failure
      // rather than a silent run with no way to inspect the diff.
      skipGitRepoCheck: false,
      networkAccessEnabled: true,
      ...(request.modelId === CODEX_DEFAULT_MODEL_ID ? {} : { model: request.modelId }),
    };

    const thread: Thread =
      request.resumeSessionId === null
        ? codex.startThread(threadOptions)
        : codex.resumeThread(request.resumeSessionId, threadOptions);

    try {
      const streamed = await thread.runStreamed(request.prompt, { signal: request.signal });
      for await (const event of streamed.events as AsyncIterable<ThreadEvent>) {
        switch (event.type) {
          case "thread.started":
            sessionId = event.thread_id;
            sink.session(event.thread_id);
            sink.log("info", `Codex thread ${event.thread_id} started in ${request.workspace}`);
            break;
          case "item.completed":
            describeItem(event.item, sink);
            break;
          case "turn.completed":
            tokens = addTokens(tokens, tokensFromUsage(event.usage));
            sink.tokens(tokens);
            completed = true;
            break;
          case "turn.failed": {
            failure = truncate(event.error.message, 600);
            const limited = /rate.?limit|usage limit|quota|429/i.test(failure);
            if (limited) {
              rateLimit = { limited: true, retryAfterSec: null, kind: null, utilization: null };
              sink.rateLimit(rateLimit);
            }
            sink.log("error", `build ended: ${failure}`);
            break;
          }
          case "error":
            failure = truncate(event.message, 600);
            sink.log("error", failure);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request.signal.aborted) {
        return { sessionId, tokens, rateLimit, completed: false, cancelled: true, failure: null };
      }
      if (/rate.?limit|usage limit|quota|429/i.test(message)) {
        rateLimit = { limited: true, retryAfterSec: null, kind: null, utilization: null };
        sink.rateLimit(rateLimit);
      }
      failure = truncate(message, 600);
      sink.log("error", failure);
    }

    // Thread ids are only populated once the first turn starts; read it back in
    // case the stream ended before `thread.started` was observed.
    if (sessionId === null && thread.id !== null) sessionId = thread.id;

    return {
      sessionId,
      tokens,
      rateLimit,
      completed: completed && failure === null,
      cancelled: request.signal.aborted,
      failure,
    };
  }
}

