import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type {
  HookJSONOutput,
  Options,
  PreToolUseHookInput,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  CONTEXT7_QUERY_TOOL,
  CONTEXT7_RESOLVE_TOOL,
  CONTEXT7_URL,
  Context7ReviewRunner,
  compileReviewCapabilitySet,
  compileSuggestedContext7Control,
  evaluateCapabilityBootstrap,
} from "./context7-review.js";
import type {
  Context7ReviewRequest,
  Context7ReviewSessionFactory,
  IndependentReviewVerdict,
  ReviewCapabilitySet,
  ReviewScope,
} from "./context7-review.js";

function envelope(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

function init(options: { connected?: boolean; tools?: readonly string[] } = {}): SDKMessage {
  const connected = options.connected ?? true;
  return envelope({
    type: "system",
    subtype: "init",
    mcp_servers: connected ? [{ name: "context7", status: "connected" }] : [],
    tools: options.tools ?? (connected ? [CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL] : []),
  });
}

function result(verdict: IndependentReviewVerdict): SDKMessage {
  return envelope({ type: "result", subtype: "success", structured_output: verdict });
}

function verdict(evidence: readonly string[] = ["sdk"]): IndependentReviewVerdict {
  return {
    verdict: "pass",
    summary: "reviewed",
    findings: [],
    evidence: evidence.map((claimId) => ({ claimId })),
  };
}

const EXTERNAL_SCOPE: ReviewScope = {
  projectId: "pilot-project",
  claims: [
    {
      kind: "external",
      id: "sdk",
      package: "Next.js",
      versionOrRange: "16.x",
      queryPurpose: "Verify the current route-handler configuration API.",
    },
  ],
};

const INTERNAL_SCOPE: ReviewScope = {
  projectId: "any-project",
  claims: [{ kind: "internal", id: "layout", subject: "Badge alignment and copy." }],
};

const NEXT_RESOLUTION = {
  content: [
    "- Title: Next.js",
    "- Context7-compatible library ID: /vercel/next.js",
    "- Versions: v15.4.0, v16.1.6, v16.2.9",
  ].join("\n"),
};
const NEXT_16_ID = "/vercel/next.js/v16.2.9";

function request(scope: ReviewScope = EXTERNAL_SCOPE): Context7ReviewRequest {
  return { scope, source: "export const route = true;", modelId: "default", effort: "low" };
}

interface Scenario {
  readonly init: SDKMessage;
  readonly consumeReviewPrompt?: boolean;
  readonly tools?: readonly {
    readonly name: string;
    readonly input: unknown;
    readonly failed?: boolean;
    readonly result?: unknown;
    readonly extraResultBlock?: boolean;
    readonly duplicateResult?: boolean;
  }[];
  readonly final?: SDKMessage;
}

interface ScenarioRecord {
  calls: number;
  prompts: string[];
  continuedAfterInit: number;
  options: Options | null;
  hookAnswers: HookJSONOutput[];
  closed: boolean;
}

function scenarioFactory(scenario: Scenario): { factory: Context7ReviewSessionFactory; record: ScenarioRecord } {
  const record: ScenarioRecord = {
    calls: 0,
    prompts: [],
    continuedAfterInit: 0,
    options: null,
    hookAnswers: [],
    closed: false,
  };
  const factory: Context7ReviewSessionFactory = ({ prompt, options }) => {
    record.calls += 1;
    record.options = options;
    let closed = false;
    return {
      close() {
        closed = true;
        record.closed = true;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        let promptIterator: AsyncIterator<SDKUserMessage> | null = null;
        if (typeof prompt === "string") record.prompts.push(prompt);
        else {
          promptIterator = prompt[Symbol.asyncIterator]();
          const bootstrap = await promptIterator.next();
          if (!bootstrap.done) record.prompts.push(String(bootstrap.value.message.content));
        }
        yield scenario.init;
        if (closed) {
          await promptIterator?.return?.();
          return;
        }
        record.continuedAfterInit += 1;
        if (promptIterator !== null && scenario.consumeReviewPrompt !== false) {
          const review = await promptIterator.next();
          if (!review.done) record.prompts.push(String(review.value.message.content));
        }

        for (const [index, tool] of (scenario.tools ?? []).entries()) {
          const callback = options.hooks?.PreToolUse?.[0]?.hooks[0];
          assert.ok(callback, "Context7 seat has no PreToolUse boundary");
          const hookInput: PreToolUseHookInput = {
            hook_event_name: "PreToolUse",
            session_id: "session-1",
            transcript_path: "/tmp/context7-review.jsonl",
            cwd: tmpdir(),
            tool_name: tool.name,
            tool_input: tool.input,
            tool_use_id: `tool-${String(index + 1)}`,
          };
          const hookAnswer = await callback(hookInput, `tool-${String(index + 1)}`, {
            signal: new AbortController().signal,
          });
          record.hookAnswers.push(hookAnswer);
          if (!("hookSpecificOutput" in hookAnswer)) {
            yield envelope({
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: `tool-${String(index + 1)}`,
                    is_error: tool.failed === true,
                    content: "transient raw documentation",
                  },
                  ...(tool.extraResultBlock === true
                    ? [{ type: "tool_result", tool_use_id: "unexpected-second-result", content: "ambiguous" }]
                    : []),
                ],
              },
              tool_use_result: tool.result ?? { content: "transient raw documentation" },
            });
            if (tool.duplicateResult === true) {
              yield envelope({
                type: "user",
                message: {
                  role: "user",
                  content: [{ type: "tool_result", tool_use_id: `tool-${String(index + 1)}`, is_error: true, content: "late error" }],
                },
                tool_use_result: { content: "late error" },
              });
            }
          }
        }
        if (scenario.final !== undefined) yield scenario.final;
      },
    };
  };
  return { factory, record };
}

function runner(factory: Context7ReviewSessionFactory, env: NodeJS.ProcessEnv = {}): Context7ReviewRunner {
  return new Context7ReviewRunner({
    cwd: tmpdir(),
    optedInProjectId: "pilot-project",
    env,
    startQuery: factory,
  });
}

test("compiler makes Context7 required only for external claims", () => {
  const external = compileReviewCapabilitySet(EXTERNAL_SCOPE);
  assert.equal(external.applicability, "required");
  assert.equal(external.obligations.length, 1);
  assert.deepEqual(external.obligations[0]?.toolAllowlist, [CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL]);
  assert.match(external.promptCapabilityText, /\[claim:sdk\]/);

  const internal = compileReviewCapabilitySet(INTERNAL_SCOPE);
  assert.equal(internal.applicability, "not_applicable");
  assert.deepEqual(internal.obligations, []);
});

test("compiler rejects ambiguous claim identities before composing a capability", () => {
  assert.throws(
    () =>
      compileReviewCapabilitySet({
        projectId: "pilot-project",
        claims: [
          { kind: "internal", id: "same", subject: "copy" },
          { kind: "internal", id: "same", subject: "layout" },
        ],
      }),
    /unique and non-empty/u,
  );
  assert.throws(
    () =>
      compileReviewCapabilitySet({
        projectId: "pilot-project",
        claims: [{ kind: "external", id: "sdk", package: " ", versionOrRange: null, queryPurpose: "docs" }],
      }),
    /package and query purpose/u,
  );
  assert.throws(
    () =>
      compileReviewCapabilitySet({
        projectId: "pilot-project",
        claims: [{ kind: "external", id: "sdk", package: "Next.js", versionOrRange: ">=16 <17", queryPurpose: "docs" }],
      }),
    /exact semver/u,
  );
  assert.throws(
    () =>
      compileReviewCapabilitySet({
        projectId: "pilot-project",
        claims: [{ kind: "external", id: "sdk", package: " @angular/core", versionOrRange: null, queryPurpose: "docs" }],
      }),
    /leading or trailing whitespace/u,
  );
  assert.throws(
    () =>
      compileReviewCapabilitySet({
        projectId: "pilot-project",
        claims: [{ kind: "external", id: "sdk", package: "@angular//core", versionOrRange: null, queryPurpose: "docs" }],
      }),
    /@scope\/name/u,
  );
});

test("required-unavailable ends at init before any model turn", async () => {
  const { factory, record } = scenarioFactory({ init: init({ connected: false }) });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "capability_unavailable");
  assert.equal(outcome.code, "server_unavailable");
  assert.equal(record.prompts.length, 1);
  assert.doesNotMatch(record.prompts[0] ?? "", /export const route/u);
  assert.equal(record.continuedAfterInit, 0);
  assert.equal(record.closed, true);
  assert.deepEqual(
    outcome.lifecycle.map((row) => row.state),
    ["planned", "granted", "unsatisfied"],
  );
});

test("a result is rejected unless the source-bearing message crossed the bootstrap gate", async () => {
  const { factory, record } = scenarioFactory({
    init: envelope({ type: "system", subtype: "init", mcp_servers: [], tools: [] }),
    consumeReviewPrompt: false,
    final: result({ verdict: "pass", summary: "pretended review", findings: [], evidence: [] }),
  });
  const outcome = await runner(factory).review(request(INTERNAL_SCOPE));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "bootstrap_protocol_error");
  assert.equal(record.prompts.length, 1);
  assert.doesNotMatch(record.prompts[0] ?? "", /Badge alignment/u);
});

test("required and suggested missing-tool decisions remain distinct", async () => {
  const missingQuery = init({ tools: [CONTEXT7_RESOLVE_TOOL] });
  const { factory, record } = scenarioFactory({ init: missingQuery });
  const required = await runner(factory).review(request());
  assert.equal(required.status, "capability_unavailable");
  assert.equal(required.code, "tool_unavailable");
  assert.equal(record.continuedAfterInit, 0);

  const suggested = evaluateCapabilityBootstrap(compileSuggestedContext7Control(EXTERNAL_SCOPE), missingQuery);
  assert.equal(suggested.continueReview, true);
  assert.equal(suggested.blockingCode, null);
  assert.ok(suggested.lifecycle.some((row) => row.state === "unsatisfied" && row.code === "tool_unavailable"));
});

test("unexpected MCP inventory is a bootstrap protocol failure", async () => {
  const { factory, record } = scenarioFactory({
    init: envelope({
      type: "system",
      subtype: "init",
      mcp_servers: [
        { name: "context7", status: "connected" },
        { name: "unrouted", status: "connected" },
      ],
      tools: [CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL, "mcp__unrouted__mutate"],
    }),
  });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "bootstrap_protocol_error");
  assert.equal(record.continuedAfterInit, 0);
});

test("suggested-unavailable records unsatisfied and continues", async () => {
  const capabilities: ReviewCapabilitySet = compileSuggestedContext7Control(EXTERNAL_SCOPE);
  const decision = evaluateCapabilityBootstrap(capabilities, init({ connected: false }));

  assert.equal(decision.continueReview, true);
  assert.equal(decision.blockingCode, null);
  assert.ok(decision.lifecycle.some((row) => row.state === "unsatisfied" && row.code === "server_unavailable"));
});

test("connected-but-unused cannot satisfy a required external review", async () => {
  const { factory, record } = scenarioFactory({ init: init(), final: result(verdict()) });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "unsatisfied");
  assert.equal(outcome.code, "required_evidence_missing");
  assert.equal(outcome.verdict, null);
  assert.ok(outcome.lifecycle.some((row) => row.state === "connected"));
  assert.equal(outcome.lifecycle.some((row) => row.state === "attempted"), false);
  assert.equal(record.continuedAfterInit, 1);
});

test("successful marked query satisfies the review and persists only a hash projection", async () => {
  const { factory, record } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: { content: "SECRET RAW DOC RESULT" },
      },
    ],
    final: result(verdict()),
  });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.verdict?.verdict, "pass");
  assert.deepEqual(
    outcome.lifecycle.map((row) => row.state),
    ["planned", "granted", "connected", "attempted", "succeeded", "attempted", "succeeded", "satisfied"],
  );
  assert.equal(outcome.evidence.length, 1);
  const expectedHash = createHash("sha256")
    .update('{"content":"SECRET RAW DOC RESULT"}', "utf8")
    .digest("hex");
  assert.equal(outcome.evidence[0]?.evidenceHash, expectedHash);
  assert.ok(
    outcome.lifecycle.some(
      (row) => row.state === "succeeded" && row.tool === CONTEXT7_QUERY_TOOL && row.producedArtefactHashes[0] === expectedHash,
    ),
  );
  assert.doesNotMatch(JSON.stringify(outcome), /SECRET RAW DOC RESULT|transient raw documentation/u);
  assert.equal((record.hookAnswers[1] as { continue?: boolean } | undefined)?.continue, true);
});

test("query-docs is bound to an exact resolver candidate and matching version", async () => {
  for (const control of [
    {
      resolution: {
        content:
          "- Title: React\n- Context7-compatible library ID: /facebook/react\n- Versions: v16.2.9",
      },
      libraryId: "/facebook/react/v16.2.9",
    },
    { resolution: NEXT_RESOLUTION, libraryId: "/vercel/next.js" },
    {
      resolution: NEXT_RESOLUTION,
      libraryId: "/vercel/next.js/v15.4.0",
    },
    {
      resolution: {
        content: [
          "- Title: Next.js",
          "- Context7-compatible library ID: /vercel/next.js",
          "- Source Reputation: High",
          "- Benchmark Score: 90",
          "- Versions: v16.2.9",
          "----------",
          "- Title: Next.js",
          "- Context7-compatible library ID: /someone/next-clone",
          "- Source Reputation: Low",
          "- Benchmark Score: 10",
          "- Versions: v16.2.9",
        ].join("\n"),
      },
      libraryId: "/someone/next-clone/v16.2.9",
    },
  ]) {
    const { factory, record } = scenarioFactory({
      init: init(),
      tools: [
        {
          name: CONTEXT7_RESOLVE_TOOL,
          input: {
            libraryName: "Next.js",
            query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
          },
          result: control.resolution,
        },
        {
          name: CONTEXT7_QUERY_TOOL,
          input: {
            libraryId: control.libraryId,
            query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
          },
        },
      ],
      final: result(verdict()),
    });
    const outcome = await runner(factory).review(request());
    assert.equal(outcome.status, "unsatisfied");
    assert.equal(
      (record.hookAnswers[1] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)
        ?.hookSpecificOutput?.permissionDecision,
      "deny",
    );
    assert.equal(outcome.lifecycle.some((row) => row.state === "satisfied"), false);
  }
});

test("version binding follows zero-major caret semantics and safe package aliases", async () => {
  const zeroScope: ReviewScope = {
    projectId: "pilot-project",
    claims: [{ kind: "external", id: "sdk", package: "Example", versionOrRange: "^0.2.3", queryPurpose: "Verify API." }],
  };
  const { factory: caretFactory, record: caretRecord } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: { libraryName: "Example", query: "[claim:sdk] Example@^0.2.3: Verify API." },
        result: {
          content: "- Title: Example\n- Context7-compatible library ID: /owner/example\n- Versions: v0.3.0",
        },
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: { libraryId: "/owner/example/v0.3.0", query: "[claim:sdk] Example@^0.2.3: Verify API." },
      },
    ],
    final: result(verdict()),
  });
  const caret = await runner(caretFactory).review(request(zeroScope));
  assert.equal(caret.status, "unsatisfied");
  assert.equal(
    (caretRecord.hookAnswers[1] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)
      ?.hookSpecificOutput?.permissionDecision,
    "deny",
  );

  const aliasScope: ReviewScope = {
    projectId: "pilot-project",
    claims: [{ kind: "external", id: "sdk", package: "next", versionOrRange: null, queryPurpose: "Verify API." }],
  };
  const { factory: aliasFactory } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: { libraryName: "next", query: "[claim:sdk] next@unspecified: Verify API." },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: { libraryId: "/vercel/next.js", query: "[claim:sdk] next@unspecified: Verify API." },
        result: { content: "Current documentation evidence." },
      },
    ],
    final: result(verdict()),
  });
  const alias = await runner(aliasFactory).review(request(aliasScope));
  assert.equal(alias.status, "completed");
});

test("a scoped package cannot bind an unrelated same-basename resolver result", async () => {
  const scope: ReviewScope = {
    projectId: "pilot-project",
    claims: [{ kind: "external", id: "sdk", package: "@angular/core", versionOrRange: null, queryPurpose: "Verify API." }],
  };
  const query = "[claim:sdk] @angular/core@unspecified: Verify API.";
  const { factory, record } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: { libraryName: "@angular/core", query },
        result: { content: "- Title: Angular Core\n- Context7-compatible library ID: /unrelated/core" },
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: { libraryId: "/unrelated/core", query },
        result: { content: "unrelated" },
      },
    ],
    final: result(verdict()),
  });
  const outcome = await runner(factory).review(request(scope));
  assert.equal(outcome.status, "unsatisfied");
  assert.equal(
    (record.hookAnswers[1] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)
      ?.hookSpecificOutput?.permissionDecision,
    "deny",
  );

  const punctuatedScope: ReviewScope = {
    projectId: "pilot-project",
    claims: [{ kind: "external", id: "sdk", package: "@foo-bar/core", versionOrRange: null, queryPurpose: "Verify API." }],
  };
  const punctuatedQuery = "[claim:sdk] @foo-bar/core@unspecified: Verify API.";
  const { factory: punctuatedFactory, record: punctuatedRecord } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: { libraryName: "@foo-bar/core", query: punctuatedQuery },
        result: { content: "- Title: Core\n- Context7-compatible library ID: /foobar/core" },
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: { libraryId: "/foobar/core", query: punctuatedQuery },
        result: { content: "unrelated" },
      },
    ],
    final: result(verdict()),
  });
  const punctuated = await runner(punctuatedFactory).review(request(punctuatedScope));
  assert.equal(punctuated.status, "unsatisfied");
  assert.equal(
    (punctuatedRecord.hookAnswers[1] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)
      ?.hookSpecificOutput?.permissionDecision,
    "deny",
  );
});

test("two claims cannot cross-bind one resolver result or partially satisfy the obligation", async () => {
  const scope: ReviewScope = {
    projectId: "pilot-project",
    claims: [
      ...EXTERNAL_SCOPE.claims,
      {
        kind: "external",
        id: "react",
        package: "React",
        versionOrRange: null,
        queryPurpose: "Verify the current effect cleanup contract.",
      },
    ],
  };
  const reactResolution = {
    content: [
      "- Title: React",
      "- Context7-compatible library ID: /facebook/react",
      "- Source Reputation: High",
      "- Benchmark Score: 90",
    ].join("\n"),
  };
  const { factory, record } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: { content: "Next evidence" },
      },
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "React",
          query: "[claim:react] React@unspecified: Verify the current effect cleanup contract.",
        },
        result: reactResolution,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:react] React@unspecified: Verify the current effect cleanup contract.",
        },
      },
    ],
    final: result({
      verdict: "pass",
      summary: "reviewed",
      findings: [],
      evidence: [{ claimId: "sdk" }, { claimId: "react" }],
    }),
  });
  const outcome = await runner(factory).review(request(scope));

  assert.equal(outcome.status, "unsatisfied");
  assert.equal(outcome.code, "required_evidence_missing");
  assert.equal(
    (record.hookAnswers[3] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput
      ?.permissionDecision,
    "deny",
  );
  assert.deepEqual(outcome.evidence.map((row) => row.package), ["Next.js"]);
});

test("successful tool use without declared output evidence remains unsatisfied", async () => {
  const { factory } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
      },
    ],
    final: result(verdict([])),
  });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "unsatisfied");
  assert.equal(outcome.code, "required_evidence_missing");
  assert.ok(outcome.lifecycle.some((row) => row.state === "succeeded"));
  assert.ok(outcome.lifecycle.some((row) => row.state === "unsatisfied"));
});

test("a failed tool result is failed, never succeeded or satisfied", async () => {
  const { factory } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        failed: true,
      },
    ],
    final: result(verdict()),
  });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "unsatisfied");
  assert.ok(outcome.lifecycle.some((row) => row.state === "failed" && row.code === "tool_error"));
  assert.equal(
    outcome.lifecycle.some((row) => row.state === "succeeded" && row.tool === CONTEXT7_QUERY_TOOL),
    false,
  );
  assert.equal(outcome.lifecycle.some((row) => row.state === "satisfied"), false);
});

test("an empty successful query result is recorded as failed, never as evidence", async () => {
  for (const empty of [{ content: "" }, { content: [{ type: "text", text: "" }] }]) {
    const { factory } = scenarioFactory({
      init: init(),
      tools: [
        {
          name: CONTEXT7_RESOLVE_TOOL,
          input: {
            libraryName: "Next.js",
            query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
          },
          result: NEXT_RESOLUTION,
        },
        {
          name: CONTEXT7_QUERY_TOOL,
          input: {
            libraryId: NEXT_16_ID,
            query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
          },
          result: empty,
        },
      ],
      final: result(verdict()),
    });
    const outcome = await runner(factory).review(request());

    assert.equal(outcome.status, "unsatisfied");
    assert.equal(outcome.evidence.length, 0);
    assert.ok(outcome.lifecycle.some((row) => row.state === "failed" && row.tool === CONTEXT7_QUERY_TOOL));
  }
});

test("raw Context7 payload copied into verdict prose is rejected and not returned", async () => {
  const raw = "This exact documentation sentence is deliberately long enough to trigger the raw evidence boundary.";
  const copied: IndependentReviewVerdict = {
    verdict: "pass",
    summary: raw,
    findings: [],
    evidence: [{ claimId: "sdk" }],
  };
  const { factory } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: { content: raw },
      },
    ],
    final: result(copied),
  });
  const outcome = await runner(factory).review(request());

  assert.equal(outcome.status, "unsatisfied");
  assert.equal(outcome.code, "raw_evidence_in_output");
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(raw, "u"));
});

test("short and embedded raw Context7 text cannot escape through verdict prose", async () => {
  for (const [raw, summary] of [
    ["OWNER-TOKEN", "Docs state: OWNER-TOKEN today."],
    ["SECRET RAW DOC RESULT", "SECRET RAW DOC RESULT"],
    ["1234567890123456789012345678901234567890", "Docs state: 1234567890123456789012345678901234567890 today."],
  ] as const) {
    const { factory } = scenarioFactory({
      init: init(),
      tools: [
        {
          name: CONTEXT7_RESOLVE_TOOL,
          input: {
            libraryName: "Next.js",
            query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
          },
          result: NEXT_RESOLUTION,
        },
        {
          name: CONTEXT7_QUERY_TOOL,
          input: {
            libraryId: NEXT_16_ID,
            query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
          },
          result: { content: raw },
        },
      ],
      final: result({ ...verdict(), summary }),
    });
    const outcome = await runner(factory).review(request());
    assert.equal(outcome.status, "unsatisfied");
    assert.equal(outcome.code, "raw_evidence_in_output");
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(raw, "u"));
  }
});

test("ambiguous multi-result SDK frames fail closed", async () => {
  const { factory } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: { content: "documentation" },
        extraResultBlock: true,
      },
    ],
    final: result(verdict()),
  });
  const outcome = await runner(factory).review(request());
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "session_error");
  assert.equal(outcome.evidence.length, 0);
});

test("duplicate result frames cannot contradict an already-settled attempt", async () => {
  const { factory } = scenarioFactory({
    init: init(),
    tools: [
      {
        name: CONTEXT7_RESOLVE_TOOL,
        input: {
          libraryName: "Next.js",
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: NEXT_RESOLUTION,
      },
      {
        name: CONTEXT7_QUERY_TOOL,
        input: {
          libraryId: NEXT_16_ID,
          query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        },
        result: { content: "documentation" },
        duplicateResult: true,
      },
    ],
    final: result(verdict()),
  });
  const outcome = await runner(factory).review(request());
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "session_error");
  assert.equal(outcome.evidence.length, 0);
});

test("an unmarked or non-allowlisted call is denied before dispatch", async () => {
  for (const tool of [
    { name: CONTEXT7_QUERY_TOOL, input: { libraryId: "/vercel/next.js", query: "unrouted question" } },
    {
      name: CONTEXT7_RESOLVE_TOOL,
      input: {
        libraryName: "Next.js",
        query:
          "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API. APPENDED PROPRIETARY SOURCE",
      },
    },
    {
      name: CONTEXT7_RESOLVE_TOOL,
      input: {
        libraryName: "Next.js",
        query: "[claim:sdk] Next.js@16.x: Verify the current route-handler configuration API.",
        secret: "owner-token",
      },
    },
    { name: "Read", input: { file_path: "/etc/passwd" } },
  ]) {
    const { factory, record } = scenarioFactory({ init: init(), tools: [tool], final: result(verdict()) });
    const outcome = await runner(factory).review(request());
    assert.equal(outcome.status, "unsatisfied");
    assert.equal(
      (record.hookAnswers[0] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput
        ?.permissionDecision,
      "deny",
    );
    assert.ok(outcome.lifecycle.some((row) => row.state === "denied"));
    assert.equal(outcome.lifecycle.some((row) => row.state === "attempted"), false);
  }
});

test("internal review is tool-less and completes with Context7 not_applicable", async () => {
  const { factory, record } = scenarioFactory({
    init: envelope({ type: "system", subtype: "init", mcp_servers: [], tools: [] }),
    final: result({ verdict: "pass", summary: "aligned", findings: [], evidence: [] }),
  });
  const outcome = await runner(factory).review(request(INTERNAL_SCOPE));

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.capabilityApplicability, "not_applicable");
  assert.deepEqual(record.options?.tools, []);
  assert.deepEqual(record.options?.mcpServers, {});
  assert.deepEqual(record.options?.managedSettings?.allowedMcpServers, []);
  assert.deepEqual(outcome.lifecycle, []);
});

test("SDK StructuredOutput finalization is allowed without becoming an MCP lifecycle row", async () => {
  const { factory, record } = scenarioFactory({
    init: envelope({ type: "system", subtype: "init", mcp_servers: [], tools: ["StructuredOutput"] }),
    tools: [{ name: "StructuredOutput", input: { verdict: "pass" } }],
    final: result({ verdict: "pass", summary: "aligned", findings: [], evidence: [] }),
  });
  const outcome = await runner(factory).review(request(INTERNAL_SCOPE));

  assert.equal(outcome.status, "completed");
  assert.equal((record.hookAnswers[0] as { continue?: boolean } | undefined)?.continue, true);
  assert.deepEqual(outcome.lifecycle, []);
});

test("internal claims cannot be declared as Context7 evidence", async () => {
  const { factory } = scenarioFactory({
    init: envelope({ type: "system", subtype: "init", mcp_servers: [], tools: [] }),
    final: result({
      verdict: "pass",
      summary: "aligned",
      findings: [],
      evidence: [{ claimId: "layout" }],
    }),
  });
  const outcome = await runner(factory).review(request(INTERNAL_SCOPE));

  assert.equal(outcome.status, "unsatisfied");
  assert.equal(outcome.code, "invalid_structured_output");
  assert.equal(outcome.verdict, null);
});

test("SDK composition is strict, exact and strips a Context7 key from the child", async () => {
  const { factory, record } = scenarioFactory({ init: init(), final: result(verdict()) });
  await runner(factory, { CONTEXT7_API_KEY: "must-not-reach-child", PATH: "/bin" }).review(request());

  const options = record.options;
  assert.ok(options);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settingSources?.length, 0);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.tools, [CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL]);
  assert.deepEqual(options.allowedTools, [CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL]);
  assert.deepEqual(options.managedSettings?.allowedMcpServers, [{ serverName: "context7" }]);
  assert.equal(options.managedSettings?.allowManagedMcpServersOnly, true);
  assert.equal(options.managedSettings?.disableClaudeAiConnectors, true);
  assert.equal(options.mcpServers?.["context7"]?.type, "http");
  assert.equal(options.mcpServers?.["context7"]?.url, CONTEXT7_URL);
  assert.equal(options.env?.["CONTEXT7_API_KEY"], undefined);
});

test("external capability is fail-closed outside the single opted-in project", async () => {
  const { factory, record } = scenarioFactory({ init: init(), final: result(verdict()) });
  const offPilot = request({ ...EXTERNAL_SCOPE, projectId: "different-project" });
  const outcome = await runner(factory).review(offPilot);

  assert.equal(outcome.status, "capability_unavailable");
  assert.equal(outcome.code, "pilot_not_enabled");
  assert.equal(record.calls, 0);
  assert.deepEqual(
    outcome.lifecycle.map((row) => row.state),
    ["planned", "unsatisfied"],
  );
});

test("session construction and zero-frame failures are closed lifecycle outcomes", async () => {
  const throws: Context7ReviewSessionFactory = () => {
    throw new Error("spawn failed");
  };
  const thrown = await runner(throws).review(request());
  assert.equal(thrown.status, "failed");
  assert.equal(thrown.code, "session_error");
  assert.deepEqual(
    thrown.lifecycle.map((row) => row.state),
    ["planned", "granted", "failed"],
  );

  const empty: Context7ReviewSessionFactory = () => ({
    close() {},
    async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      return;
    },
  });
  const zero = await runner(empty).review(request());
  assert.equal(zero.status, "failed");
  assert.equal(zero.code, "bootstrap_protocol_error");
  assert.deepEqual(
    zero.lifecycle.map((row) => row.state),
    ["planned", "granted", "failed"],
  );
});
