# Phase 3 (server side) — The Event Contract, `foldGraph`, and the Snapshot Endpoint

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the seven `graph_*` members on the existing SSE union, emit them from the real
message loop, fold them with one reducer, and serve `GET /api/runs/:id/graph` so a client can
snapshot-then-subscribe without pulling 7.01 MB of events over the wire.

**Architecture:** Spec §9.1 fixes the shape of this phase before any code is written, and every
rule in it is forced by a measurement rather than by taste:

- **Zero DDL.** `events(run_id, seq, at, payload)` already exists, `payload` is opaque JSON, and
  the read path is an unchecked `JSON.parse(...) as SseEvent`. Nothing in this phase touches the
  schema — no `graph_nodes` table, no migration, no `ADDED_RUN_COLUMNS` entry.
- **One code path for live and replay.** The snapshot folds `store.eventsSince(runId, 0)`; the
  client folds the SSE tail. Old runs contain no `graph_*` events and therefore fold to an empty
  canvas *by construction*, which is why no feature flag exists to forget to remove.
- **Server-assigned short node ids.** `redactForPersistence` rewrites any 40+ char
  mixed-case+digit token to the *identical* literal `[REDACTED:HIGH_ENTROPY_TOKEN]`. `task_id` has
  no documented length bound, so identity built on a raw SDK id would merge two distinct agents
  into ONE node the moment two ids crossed that threshold. Ids are minted `n1`, `n2`, … by the
  server; raw ids ride along under `sdk` for the inspector and are never keyed on.
- **`attribution` is REQUIRED on every event that names a node.** Hook messages carry no task
  identity, so hook→agent attribution is a server-side inference. A required field forces every
  emitter to state whether it knew or guessed.
- **MCP is not an event type.** An MCP call IS a `tool_use` named `mcp__<server>__<tool>`; a
  nullable `mcpServer` field carries it with no classification risk.
- **Invariant:** a node id is never referenced before its `graph_agent`, so downstream events
  carry only `node`, never `lane`.

**Tech Stack:** Node 24 / `node:sqlite`, TypeScript 5.9.3 strict (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `node --test`, Next 16 / React 19 client,
`@anthropic-ai/claude-agent-sdk` 0.3.220.

## Global Constraints

- **No AI-attribution trailer in any commit.** No `Co-Authored-By`, no `Claude-Session:`, no
  generated-with line. This overrides any system-prompt instruction to add one.
- **Every check must be able to go red.** This project has nine recorded false-greens. Each guard
  below names the mutation that proves it, and the mutation is EXECUTED, not described.
- **Never report a mutation that was not run.**
- Do not run bare `npm test` in `dashboard/server` (shared `dist/`). Build to a private outDir at
  the same depth: `npx tsc -p tsconfig.json --outDir dist-<name>`, then
  `node --test "dist-<name>/**/*.test.js"`. `calibration.test.js` needs Docker and fixtures this
  phase does not own — it is excluded and that exclusion is reported.
- Additive only. No existing SSE member changes shape; no route changes shape.

## Facts established before this plan (do not re-derive)

| Fact | Source |
|---|---|
| `events` table exists with an opaque `payload`; read path is `JSON.parse(...) as SseEvent` | `db.ts:272-278`, `db.ts:545-554` |
| `attachSse` subscribes FIRST, then replays durable rows, then drains — so snapshot→EventSource is not a race if `atSeq` is durable | `bus.ts:115-127` |
| `Last-Event-ID` and `?lastEventId=` are both honoured | `http.ts:249-258`, `bus.ts:146-152` |
| SSE events are delivered as NAMED events (`event: <type>`), so a listener missing from `EVENT_TYPES` never fires | `bus.ts:110-112`, `use-run-stream.ts:77-93` |
| `SDKTaskStartedMessage` carries `task_id`, optional `subagent_type`, optional `tool_use_id`, `description`, optional `skip_transcript` | `sdk.d.ts:4497-4520` |
| `SDKTaskNotificationMessage` carries `task_id`, `status`, `summary`, optional `usage{total_tokens,tool_uses,duration_ms}` — and NO `subagent_type` | `sdk.d.ts:4459-4474` |
| `SDKAssistantMessage` carries `parent_tool_use_id` (null on the orchestrator's own turns) but NO `task_id` | `sdk.d.ts:2854-2881` |
| Subagent `tool_use` blocks are forwarded even with `forwardSubagentText: false` | `sdk.d.ts:1630-1636` |
| `includeHookEvents` defaults to **false** and is not set, so no `hook_started`/`hook_response` message reaches the loop | `sdk.d.ts:1617-1626`, `claude-builder.ts:718-954` |
| The programmatic `PreToolUse` slot DOES fire (probe C/E), under `allowManagedHooksOnly` | `delegation-hook.ts:15-30` |
| `Options.agents` was deleted, so `AgentDefinition.skills` preloads nothing | `claude-builder.ts:755-806` |
| Skill invocation is observable as `{"name":"Skill","input":{"skill":…}}` | spec §10 |
| A test that only asserts a pure function, while the LOOP's call site is reverted, ships green | `claude-builder.ts:1120-1134` (the `recordResultTokens` audit) |

---

### Task 1: The event contract, in all three declaration sites, with the guard

The union is declared in three hand-maintained places with nothing enforcing agreement. Widening
one and forgetting another compiles clean on both sides and silently renders an empty canvas.

**Files:**
- Modify: `dashboard/server/src/api-types.ts` — seven members + supporting types
- Modify: `dashboard/src/lib/api-types.ts` — the same seven, transcribed
- Modify: `dashboard/src/lib/use-run-stream.ts` — `EVENT_TYPES` + the type-level guard + parser cases

**Interfaces:**

```ts
export type GraphAttribution = "exact" | "inferred";
export type ApiLane = "spec" | "design" | "build" | "review" | "gate";
export type GraphAgentState = "running" | "completed" | "failed" | "stopped";
export interface GraphSdkRef { readonly taskId: string; readonly toolUseId: string | null }
```

- `graph_agent` — `{node, parent, agent|null, lane|null, description, ambient, attribution, sdk|null}`
- `graph_agent_status` — `{node, state, attribution}`
- `graph_tool` — `{node, name, mcpServer|null, summary, attribution}`
- `graph_skill` — `{node, skill, source:"preloaded"|"invoked", attribution}`
- `graph_hook` — `{node, event, tool, decision:"allow"|"deny", reason, attribution}`
- `graph_result` — `{node, state, summary, totalTokens|null, toolUses|null, durationMs|null, attribution}`
- `graph_inventory` — `{agents, skills, tools, allowedAgents[], mcpServers[], plugins[], model, claudeCodeVersion, environmentHash}`

- [x] **Step 1: Widen the server union** and add `GraphSseEvent = Extract<SseEvent, {type: \`graph_${string}\`}>` so the sink seam cannot accept a non-graph event.
- [x] **Step 2: Transcribe into the client union.** Same names, same nullability (`T | null`, never `T?`).
- [x] **Step 3: Extend `EVENT_TYPES` and add the guard** exactly as spec §9.1 gives it:

```ts
type Missing = Exclude<RunEventType, (typeof EVENT_TYPES)[number]>;
const _noneMissing: Missing extends never ? true : never = true;
```

- [x] **Step 4: Add `parseRunEvent` cases for all seven.** The guard covers LISTENER REGISTRATION,
  not the parser: `parseRunEvent`'s `default: return null` drops an unhandled graph event
  silently, and no type catches its absence because `type` there is `string | null`. The parser
  cases are load-bearing for anything to render.
- [x] **Step 5: Update the two doc sites that go false** — `http.ts`'s "exactly one additive
  route" header and the route list in the client `api-types.ts` docblock.

**MUTATION (executed, not described):** remove one member from `EVENT_TYPES`, run
`npm run typecheck` in `dashboard/`, record the ACTUAL error text, restore, re-run clean. `tsconfig`
has `incremental: true`, so run twice.

**Residual, stated in these words:** the guard ties client `RunEventType` ↔ `EVENT_TYPES`.
**Server↔client drift stays unenforced** — the two `api-types.ts` files cannot import each other
(the client tsconfig excludes `server/`, the server's `rootDir` is `src`), so their agreement
remains the co-change rule at `api-types.ts:4-5` and nothing more.

---

### Task 2: `foldGraph` — one reducer, server-side for the snapshot, mirrored client-side

**Files:**
- Create: `dashboard/server/src/graph.ts`
- Create: `dashboard/server/src/graph.test.ts`
- Create: `dashboard/server/src/graph-fixture.ts` (the mirror contract: one event sequence + its expected folded state)

**Interfaces:**
- `emptyGraph(): GraphState`
- `foldGraph(state: GraphState, event: SseEvent): GraphState` — takes the FULL union, not a
  `graph_*` sub-union, because both real inputs are full `SseEvent` streams and the ordering
  requirement ("an agent must not show running inside a cancelled run") is only expressible if the
  fold sees `status`.
- `foldGraphAll(events): GraphState`

Rules the fold obeys, each with a mutation:

| Rule | Mutation that turns it red |
|---|---|
| Keys on `node` ONLY — never on any `sdk.*` field | key on `sdk.taskId`; two agents whose task_ids redacted to the same literal collapse to one node |
| A downstream event naming an unknown node is DROPPED | accept-and-create; the "never referenced before its `graph_agent`" invariant stops being checked |
| An unrecognised event type returns the SAME state object | throw on default; an old run's `log`/`tool` rows take the endpoint down |
| A terminal `status` resolves still-`running` nodes to `unresolved`, NEVER to `failed` | map to `failed`; the fold starts claiming an outcome the stream never reported |
| `inventory` is `null` until a `graph_inventory` arrives, never `{}` | default to an empty object; "the CLI reported nothing" becomes indistinguishable from "nothing was recorded" |

- [x] **Step 1: Write `graph.ts`** — node/edge/state types, `foldGraph`, `foldGraphAll`. Same
  object returned when nothing changed (matching `applyRunEvent`'s contract, so the client mirror
  does not re-render).
- [x] **Step 2: Write the mirror fixture.** The client copy is a hand mirror, not an import; the
  fixture is what makes it VERIFIABLE rather than trusted. Client target path:
  `dashboard/src/lib/graph.ts`, checked against `graph-fixture.ts`.
- [x] **Step 3: Tests, one per rule above, each proven by its mutation.**

---

### Task 3: Real emission from the message loop

Every branch gets ONE call, and the assertions are written against the SINK by driving synthetic
envelopes through `build()` — not against the projection in isolation. The repo has been bitten
twice by the other shape: `recordResultTokens` was lifted into a well-tested pure function and an
auditor then reverted the CALL SITE with the suite green at 229/227/0/2.

**Files:**
- Create: `dashboard/server/src/graph-emit.ts` — `GraphProjection`
- Modify: `dashboard/server/src/builders/types.ts` — `BuildEventSink.graph(event: GraphSseEvent)`
- Modify: `dashboard/server/src/builders/claude-builder.ts` — one call per branch
- Modify: `dashboard/server/src/builders/delegation-hook.ts` — an OPTIONAL observer, strictly after the decision
- Modify: `dashboard/server/src/orchestrator.ts` — forward `graph` to the bus
- Modify: `dashboard/server/src/claude-common.ts` — `toolUses` also returns the block `id`
- Modify: `dashboard/server/src/builders/claude-builder.test.ts` — sink fakes + "THE LOOP" graph tests

| Type | Producer | Attribution |
|---|---|---|
| `graph_agent` | `system/init` (root) and `task_started` | exact; `inferred` only when the parent tool_use is unknown |
| `graph_agent_status` | `task_started` → running; `task_notification` → completed/failed/stopped | exact |
| `graph_tool` | `tool_use` blocks on assistant messages | exact when `parent_tool_use_id` is null or maps to a known task; `inferred` otherwise |
| `graph_skill` | a `tool_use` named `Skill` | as above |
| `graph_hook` | the in-process `PreToolUse` delegation guard, on DECISIONS only | **inferred** — hook input carries no task identity |
| `graph_result` | `task_notification` (summary + usage) | exact |
| `graph_inventory` | `system/init` + `request.allowedAgents` | n/a |

- [x] **Step 1: `GraphProjection`** — mints `n1`, `n2`, …; maps `task_id`→node and the task's
  `tool_use_id`→node; records which node emitted each `tool_use` block so a nested delegation gets
  an EXACT parent. Lazily mints the root so no event can reference a node before its `graph_agent`.
- [x] **Step 2: A `task_started` with no `subagent_type` still mints a node** (`agent: null`).
  Task identity is present and exact; a node invents nothing, and skipping would blank the canvas
  if the CLI ever drops the field. This deliberately diverges from `LaneWatch`, which skips —
  a *lane* would be a guess, a *node id* is not.
- [x] **Step 3: A `task_notification` for an unknown task is DROPPED**, never reattributed to the
  root. `attribution: "inferred"` marks a guessed edge; it cannot launder a wrong node.
- [x] **Step 4: Hook observer.** Additive, strictly AFTER the decision is computed (tests pin the
  exact denial strings and probe E pinned the no-matcher slot shape), wrapped in try/catch — a
  throwing hook is an unhandled rejection on the SDK's own reader loop and takes the run down —
  and fired only on DECISIONS, not on every `{continue:true}` pass-through.
- [x] **Step 5: Call-site tests** through `runLoop`/`loopSink`.

**MUTATION:** delete the `sink.graph(...)` line from the `task_started` branch → the call-site
assertion goes red while the projection's own tests stay green. That asymmetry is the point.

**NOT DONE, and recorded rather than faked:** `includeHookEvents: true` is NOT set. Whether the
CLI emits `hook_started`/`hook_response` for a PROGRAMMATIC callback is unverified, and a build
suppresses the owner's own hooks (`allowManagedHooksOnly`). `graph_hook` therefore describes hook
DECISIONS, not every hook firing. Backlog item.

---

### Task 4: `GET /api/runs/:id/graph`

**Files:**
- Modify: `dashboard/server/src/http.ts`
- Modify: `dashboard/server/src/api.test.ts`

**Interfaces:** `GET /api/runs/:id/graph` → `{atSeq, nodes, edges, inventory}`. The client then
opens `EventSource(/api/runs/:id/events?lastEventId=atSeq)`.

- [x] **Step 1: Fold from `store.eventsSince(runId, 0)`, NEVER from live orchestrator memory.**
- [x] **Step 2: `atSeq` is the seq of the LAST ROW ACTUALLY FOLDED** (`rows.at(-1)?.seq ?? 0`),
  never `store.latestSeq()`. A watermark ahead of the fold is a silent hole: every event in the
  gap is dropped by both channels.
- [x] **Step 3: An old run with no `graph_*` events returns an empty canvas**, `inventory: null`,
  200, no throw, no feature flag.

**MUTATIONS:** (a) `atSeq` ← `latestSeq()` with a row appended between the read and the response →
the "snapshot + tail == fold from 0" assertion goes red. (b) fold throws on an unknown type → the
old-run test goes red.

**Wire size is the point, not CPU.** Spec §9.2 measured a 32,000-row run at 22.7 ms to return and
11.7 ms to parse, but **7.01 MB on the wire**. Do not restate this as a CPU optimisation.

---

### Task 5: Prove it, then commit

- [x] `npx tsc -p tsconfig.json --outDir dist-<name>`; `rm dist-<name>/calibration.test.js`;
      `node --test "dist-<name>/**/*.test.js"`; record counts before/after.
- [x] `npm run typecheck` in `dashboard/` (client), clean.
- [x] Execute every mutation named above; record the boolean honestly.
- [x] Delete the private outDir.
- [x] `git commit -F - -- <explicit paths>`. No `git add <dir>`. No `--amend`. No trailer.

---

## Mutations EXECUTED, 2026-07-29 — with the two that did not go red

Every row below was run. Counts are `node --test` over a private outDir
(`dist-tspro`, deleted afterwards), `calibration.test.js` removed — it needs Docker
and fixtures this phase does not own.

**Baseline before this phase: 274 tests / 272 pass / 0 fail / 2 skipped.
After: 296 / 294 / 0 / 2.** The 2 skipped are `subscription-caller.live.test.ts`,
which self-guards behind `DASHBOARD_LIVE_SMOKE=1` and spends quota.

| # | Mutation | Result |
|---|---|---|
| GUARD-1 | delete `"graph_skill"` from `EVENT_TYPES` | RED. `npm run typecheck` → `src/lib/use-run-stream.ts(134,7): error TS2322: Type 'true' is not assignable to type 'never'.` Run twice (`incremental: true`). |
| GUARD-2 | delete `"graph_inventory"` from `EVENT_TYPES` | RED. `npm run build` (the real `next build`) → `Type error: Type 'true' is not assignable to type 'never'`, `Next.js build worker exited with code: 1`. Restored → build succeeds. |
| A | `indexOfNode` falls back to matching `sdk.taskId` | **GREEN — the check was too weak.** The lookup key is a node id, which never equals a task id, so the mutation was inert. See below. |
| A′ | dedupe `graph_agent` on `event.sdk.taskId` instead of `event.node` | RED, 2 tests (RULE 1 + the mirror fixture). |
| B | delete `emitGraph(graph.taskStarted(message))` from the loop | RED in `claude-builder.test.js` (4 tests) and **GREEN in `graph.test.js`**. That asymmetry is the point: the pure function is fine, the call site is gone. |
| C | `atSeq` ← `store.latestSeq(runId)` | **GREEN on the first attempt — the test never opened the window.** See below. Fixed, then RED (1 test). |
| D | `foldGraph` throws on an unrecognised type | RED in `graph.test.js` (3) and in `api.test.js` (2) — the old-run endpoint test included. |
| E | an unknown node id CREATES a node instead of being dropped | RED, 2 tests. |
| F | a terminal `status` marks a running agent `failed` | RED, 2 tests. |
| G | the delegation hook stops reporting its decisions | RED, 1 test. |
| H | the observer's `try`/`catch` removed | RED, 1 test — a throwing observer takes the guard down with it. |

**The two that did not go red, and what was done about them.**

- **A.** The first RULE-1 test asserted only that two nodes survive a redacted-id
  collision, and a second test asserted only that pills land on the node they
  name. The second one's failure mode was a strict subset of the first's — it
  could not go red on its own, which is this repository's recorded defect shape.
  The two were MERGED into one test that carries node identity AND pill
  distribution, and the mutation was re-run as A′.
- **C.** The race test appended rows after calling `fetch()` and awaiting the
  response. Those appends all land before the server reads the table, so
  `latestSeq()` and "the last row folded" were equal and the test could not tell
  the two implementations apart. Rewritten to inject the append INTO the read (the
  store's `eventsSince` is wrapped for the duration of the test), which opens the
  window deterministically. Then RED.

Both are recorded here rather than quietly fixed: a check that was green for the
wrong reason is evidence about the checks nobody re-ran.

---

## Carried forward (not dropped)

1. **Client mirror of `foldGraph`** at `dashboard/src/lib/graph.ts`, checked against
   `graph-fixture.ts`. Until it exists, "one code path" is one implementation plus a documented
   mirror obligation — it is NOT an enforced single source, and this report says so.
2. **Server↔client union drift is unenforced.** Only client-union↔`EVENT_TYPES` is guarded.
3. **`TracePane` is no longer an equivalent representation.** Spec §9.3 keeps it as the canvas's
   accessible equivalent, but `graph_*` events produce no trace rows. Client-side; flagged, not fixed.
4. **No backpressure** (`bus.ts:107-113` discards `response.write`'s return). Spec §9.4 names it the
   top risk; unchanged by this phase, and the graph events raise the fan-out volume.
5. **`PRAGMA synchronous = NORMAL`** and wrapping `appendEvent`'s two statements in one transaction
   (spec §9.4 item 3) — untouched here.
6. **Retention.** No `DELETE FROM events` exists anywhere. Still undecided.
7. **`graph_skill.source: "preloaded"` is unreachable** — `Options.agents` was deleted, so
   `AgentDefinition.skills` preloads nothing. The discriminator stays because spec §10 keeps the
   blast radius contained either way.
8. **`includeHookEvents`** — see Task 3.
