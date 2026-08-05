# Dashboard observability + self-maintenance — verified findings

2026-08-04. Every claim here was established by reading the cited code or querying
`dashboard/data/runs.db`. Nothing in this file is inferred from a name.

The owner's four asks:

- **A.** "the agent should be self maintaining" — a run must not die on a config default.
  "Context loss is not ok, using up a lot of tokens is."
- **B.** "showing how its thinking and what its thinking like it does in terminal with claude code"
- **C.** "when it starts editing it shows the added green lines and taken away red lines"
- **D.** "the whole Before you build box should be redesigned to be more interactive … linked as part
  of the actual orchestration canvas … you don't have the thing where the orchestrator doesn't show."
  Clarified: `Planning (node) ----- Orchestrator (node) ------ (then whatever the orchestrator spawns)`

---

## 1. The phase the owner is complaining about is not on the path everyone instruments

Two different callers reach the model, and they share almost nothing.

| | build / design seats | spec, audit, plan, judge seats |
|---|---|---|
| caller | `builders/claude-builder.ts:1404` stream loop | `subscription-caller.ts:1531` stream loop |
| constructed at | build segment | `orchestrator.ts:2338`, `orchestrator.ts:2475` |
| tools | full toolset | **`tools: []`** (`subscription-caller.ts:1510`) |
| emits to the event bus | `sink.log`, `sink.tool`, `emitGraph(...)` | **nothing** |
| partial messages | not set | **`includePartialMessages: false`** (`subscription-caller.ts:1514`) |

Measured consequence, from the DB:

- failed run `run-2026-08-04T11-08-10-487Z-162b186d` — died in `spec` — **61 events over 51 minutes**,
  of which `36 log, 11 status, 9 rate_limit, 4 phase, 1 verdict`. **Zero `tool`. Zero `graph_*`.**
- passing run `run-2026-07-29T23-28-46-665Z-3d4d1ccb` — reached build — **388 events**
  (`120 tool, 120 graph_tool, 44 log, 25 criterion, 22 graph_agent_status, 13 graph_agent, 11 graph_result, …`).

**So: the "Before the build" panel is dead because the seat behind it is structurally silent, not
because the panel is badly designed.** Fixing `claude-common.ts:244` and `graph-emit.ts:348` — the
two obvious defects on the *build* path — would not put a single new pixel in that panel.

Any plan that instruments only the build path answers a question the owner did not ask.

---

## 2. Ask A — the self-healing ladder already exists and cannot fire

This is the sharpest finding in the investigation.

**The ladder is already written.** `bakeoff/src/spec-agent.ts:1143-1157`:

```
if (!generated.ok && wasTruncated(generated.call) && !truncationRetried) {
  truncationRetried = true;
  if (outputTokens < MAX_STREAMABLE_OUTPUT_TOKENS) {
    outputTokens = MAX_STREAMABLE_OUTPUT_TOKENS;
    generated = await generateSuite(...);   // retry, without consuming an attempt
  }
}
```

Detect truncation → raise the ceiling → retry once for free. Exactly the self-maintenance the owner
asked for. It did not run. Three independent reasons, each sufficient:

**(i) The harness asks for 128K; the CLI silently gives 64K.**
`bakeoff/src/spec-types.ts:251` — `DEFAULT_MAX_OUTPUT_TOKENS = MAX_STREAMABLE_OUTPUT_TOKENS = 128_000`.
On the API path that number is honoured: `bakeoff/src/anthropic-seat.ts:658` passes
`max_tokens: request.maxOutputTokens` straight to the Anthropic SDK.
On the subscription path it is not. `subscription-caller.ts:1457-1459` states it plainly:

> `maxOutputTokens` has no SDK equivalent and is NOT silently ignored — it is enforced after the fact
> by the caller's own truncation check (`stop_reason`), which is what spec-agent already keys off.

I confirmed the SDK side. In `@anthropic-ai/claude-agent-sdk@0.3.220`, `Options` carries **no
output-token ceiling** — only `maxThinkingTokens` and a task budget. The `maxOutputTokens` at
`sdk.d.ts:1273` is a field on **`ModelUsage`**, i.e. reporting, not control. The env var
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` is genuinely the only lever, and nothing in the repo sets it.

So the effective ceiling on the spec seat was the CLI's own 64,000 default while every constant in
the harness said 128,000.

**(ii) The overflow arrives as an exception, so the detector never sees it.**
`wasTruncated` is `call.stopReason === "max_tokens"` (`bakeoff/src/spec-agent.ts:710-712`) — it reads
a *returned* `SeatCallResult`. On the subscription path an over-length response comes back as a CLI
**error result**, which sets `failure` and then `throw new SeatCallError(...)`
(`subscription-caller.ts:1556-1585`). No `SeatCallResult` is ever returned, so `wasTruncated()` is
never called and the ladder at `:1143` is jumped straight over.

**(iii) The fallback ceiling is already at the top.** Even if the ladder did fire, it raises to
`MAX_STREAMABLE_OUTPUT_TOKENS` — which `DEFAULT_MAX_OUTPUT_TOKENS` already equals. The rung it climbs
to is the rung it starts on.

This is the repo's signature defect in its purest form: **a recovery mechanism that is correctly
named, correctly reasoned about in its own comments, and positioned where it cannot observe the
failure it exists for.**

Note also `sdk.d.ts:2901`: `'max_output_tokens'` is a declared member of `SDKAssistantMessageError`.
The SDK types this failure explicitly, which gives a clean classifier hook.

### Why the same ticket succeeded before

The passing run logged `spec seat — anthropic: 14 input, 40187 cache read, 8124 cache write, 416111
output over 2 call(s)`. 416K output across 2 calls, under the same 64K ceiling — because a "call" is
a session of many turns. The failure was never total volume. It was **one assistant turn trying to
emit the whole suite at once**, which is forced by `tools: []`: a toolless seat has no `Write` to
spill into and must return everything in a single response.

### Correction to what I told the owner earlier

I said the fix was `CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000` on the server process, and that the durable
version was for the spec seat to declare its own ceiling like `plan-seat.ts:102` does. Both stand,
but neither is sufficient, and the second was based on an assumption I had not yet checked:
`plan-seat.ts:517` passes `maxOutputTokens: PLAN_SEAT_MAX_OUTPUT_TOKENS` into `caller.call(...)` — and
on the subscription path **that value never reaches the model.** It is only ever checked after the
fact against `stop_reason`. The plan seat's declared 4000-token ceiling is not a ceiling; it is an
assertion made after the response has already been generated.

Raising the env var makes a 128K single response *legal*. It does not make it reliable, and it does
not repair the ladder.

---

## 3. Ask B — thinking. Two different things, wildly different costs

The owner said "how its thinking and what its thinking". Those are two features.

**Narration** — the assistant's prose. **Already captured**, then thrown away twice over:
- `builders/claude-builder.ts:1455` — `sink.log("info", truncate(text, 500))`. Lands in a generic
  `{type:"log", level:"info", text}` event in the same channel as `spec seat — anthropic: 14 input…`
  telemetry. The UI has no way to tell narration from a token count.
- `graph-emit.ts:348` — `if (uses.length === 0) return out;`. An assistant turn that is pure prose
  with no tool call emits **no graph event at all**.

Re-typing that into its own event and rendering it on the node is most of the terminal feel, with no
SDK change, no volume increase, and no new redaction surface. **Build path only** — the spec seat
does not call `sink` at all.

**Thinking blocks — NOT AVAILABLE. Measured, not assumed.**

`claude-common.ts:243-248` drops them, but that turns out not to be the binding constraint. I counted
every thinking block in the local transcript corpus:

| model | thinking blocks | non-empty |
|---|---|---|
| `claude-opus-4-8` | 4610 | **0** |
| `claude-fable-5` | 1797 | **0** |
| `claude-opus-5` | 619 | **0** |
| `claude-sonnet-5` | 11 | **0** |
| **total** | **7037** | **0** |

A block's keys are `['type','thinking','signature']`. `thinking` is `""`; `signature` is a long
base64 blob. The reasoning is **encrypted**, not merely unforwarded — no SDK option decrypts it.

So **ask B's "what it's thinking" cannot be built as literally asked.** What can be built is the
narration above, plus a derived activity line ("reading the CV…", "auditing the suite…") synthesised
from tool calls and phase transitions — which is in fact what the Claude Code terminal mostly shows.

`includePartialMessages: true` (`sdk.d.ts:1631`) still matters, but for a different reason: it emits
`SDKPartialAssistantMessage` (`sdk.d.ts:4150`) carrying **text** deltas, which is the only liveness
signal available for a `tools: []` seat during those 50 silent minutes.

Also found, relevant to the build path: **`forwardSubagentText?: boolean`** (`sdk.d.ts:1637`) — "the
full subagent conversation is forwarded so consumers can render a nested transcript." Currently unset.

Volume and host-path redaction on these new text paths remain unresolved and are the main risk.

---

## 4. Ask C — the SDK already computes the diff; we throw it away

My first pass said "no diff data anywhere". That is true of what we **capture** and wrong about what
is **available** — the correction matters because it makes this the cheapest of the four asks.

`sdk-tools.d.ts:3025-3072`, `FileEditOutput` — the result of an `Edit`, delivered on the **user**
message as `tool_use_result`:

```
filePath, oldString, newString,
originalFile: string | null,
structuredPatch: { oldStart, oldLines, newStart, newLines, lines: string[] }[],
userModified, replaceAll,
gitDiff?: { filename, status, additions, deletions, changes, patch }
```

`structuredPatch.lines` carries the literal `" "` / `"+"` / `"-"` prefixes. `gitDiff` carries a ready
patch plus additions/deletions counts. **The green and red lines the owner asked for are already
computed and already crossing the process boundary** — we simply never read the user message.

What is still true:
- `summariseToolInput` keeps only `file_path`, discarding everything above.
- The workspace git repo has exactly one commit, `workspace created`, so there is no local history —
  but with `structuredPatch` there no longer needs to be.
- Reading the **result** rather than the tool_use block also fixes the correctness problem: a failed
  edit produces no `FileEditOutput`, so only edits that actually applied can render.

Two carve-outs that must be visible in the UI, not buried:
- **Bash-driven edits** (`sed -i`, heredocs, `npm init`) produce no structured output and can never
  appear as diffs.
- Whether **delegated (subagent)** tool results reach the parent stream is unverified. Possibly
  gated behind `forwardSubagentText`.

---

## 5. Ask D — the pre-build panel, and the replay hole underneath it

`orchestration-canvas.tsx:1846-1932`. An **overlay**, rendered only inside the
`showEmptyOverlay || !ready` branch — only while the canvas has zero nodes. Re-laying it out as
`Planning → Orchestrator → spawned agents` is mostly a re-render of data already on the wire.

Two constraints found underneath it, both verified, both larger than the layout work:

**(i) The lane deletes itself at the build boundary.** `dashboard/src/lib/spec-pipeline.ts:246` —
`if (phase !== "spec") return [];`. So the pre-build stages cannot persist next to the agent graph;
the owner's single continuous canvas requires changing this guard, not just moving the box.

**(ii) It is blank on every finished run.** `specPipelineFrom` reads `trace`, and `trace` comes from
the SSE stream — which a terminal run never opens. `use-run-stream.ts:820-822`:

```
const streamClosed = status !== undefined && isTerminalStatus(status);
...
if (runId === null || streamClosed || !graphReady) return;   // EventSource never constructed
```

Correct on its own terms (a finished run must not hold a socket open), but it means **anything
derived from `trace` exists only while you are watching live**. Open the run afterwards and it is
gone. Whatever we build for asks B, C and D must reach `GraphState` or a durable REST read, not the
trace sink.

Supporting this: `dashboard/src/lib/graph.ts:64-69` re-exports the **server's** `foldGraph` /
`foldGraphAll`, so snapshot and live tail are literally the same function — one new `case` in that
fold covers both replay and live. That is the seam to build on.

---

## 6. Sequencing

1. **Repair the ladder** (§2) so the CLI's error-result path reaches `wasTruncated`, and give it a
   rung above where it starts. This is the run-killer and it is the smallest fix.
   Note the coupled risk: `PLAN_SEAT_MAX_OUTPUT_TOKENS = 4000` (`plan-seat.ts:102`) becomes a real
   ceiling for the first time once ceilings are actually applied — needs re-checking against measured
   plan-turn sizes before it starts truncating plans.
2. **Land the durable seam** — new data must reach `foldGraph` (§5), never the trace sink, or it is
   invisible on every finished run.
3. **Diffs (ask C)** — read `tool_use_result.structuredPatch` off the user message. Highest
   value-per-unit-work of the four, now that the data turns out to be free.
4. **Narration (ask B, achievable half)** — re-type what is already captured; delete the
   `uses.length === 0` early return.
5. **Instrument the seat path** — `includePartialMessages` on `subscription-caller.ts` for text
   deltas, so the 50-minute spec phase stops being a black box.
6. **Canvas re-layout (ask D)** — including the `phase !== "spec"` guard.

Not doing: thinking-block rendering. Measured unavailable (§3).

Redaction is a blocker on anything shipping raw model text or file contents to the browser and must
be settled before those land, not after. `structuredPatch` carries `filePath` and full file contents.

## 7. Struck during verification

Claims produced during research that did not survive checking:

- *"`spec-agent.ts` has no truncation handling."* — false; it has a complete ladder at `:1143`. The
  defect is that it cannot be reached, not that it is missing.
- *"The plan seat correctly declares its output ceiling, so the spec seat should copy it."* — my own
  earlier claim to the owner. `plan-seat.ts:517` passes `maxOutputTokens`, but on the subscription
  path it never reaches the model.
- *"Thinking blocks are available once `includePartialMessages` is on."* — my own implication.
  Measured 0 non-empty of 7037; the content is encrypted.
- *"No diff data exists anywhere."* — my own claim. Nothing is *captured*; the SDK *computes* it and
  hands it over unread.
- *"`dashboard/server/src/spec-pipeline.ts:246`"* (workflow) — no such file. Correct line, wrong
  directory: it is `dashboard/src/lib/spec-pipeline.ts:246`.
- *"Thinking is empty because of a non-interactive forcing function."* (workflow) — struck by its own
  verifier; interactive sessions where that path cannot fire are equally empty.
