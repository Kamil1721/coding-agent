# Live Multi-Agent Orchestration Canvas

**Date:** 2026-07-28
**Status:** Design approved, ready for implementation planning
**Scope:** Rebuild the dashboard's `build` phase into real multi-agent delegation, and render it live as a zoomable n8n-style canvas.

---

## 1. Goal

Two deliverables, stacked:

1. **Real delegation.** The `build` phase stops being one agent and becomes an orchestrator that delegates across the owner's own custom agents, skills and MCP servers. Never one agent doing all the work.
2. **A live canvas.** An n8n-style zoomable/pannable graph showing each agent as a node, with the skills, hooks and MCP calls it is using, live, and a click-through to that agent's real transcript.

The canvas renders **observations, never inferences**. Every node, edge and pill traces to a real SDK event. Where attribution is guessed, the wire format says so.

## 2. Existing system

`dashboard/` is a Next.js 16 / React 19.2 / Tailwind 4 UI on `127.0.0.1:4319`, with a framework-free Node API on `127.0.0.1:4176`. A ticket runs `spec → build → gate → judge → done`. `build` is a single `query()` call into the Claude Agent SDK (`builders/claude-builder.ts`).

Two headline metrics: `heldOutPass` (did the sealed suite go green) and `falseFinish` (did the agent claim done while it wasn't). Both are meaningless if a builder can read the sealed acceptance suite.

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Delegation first, canvas second | Nothing on the canvas is ever simulated |
| 2 | Hybrid graph — authored lanes, runtime specialists | Stable zoomable layout that still reflects real choices |
| 3 | Model-routed within a curated shortlist | Real decision, bounded search space |
| 4 | Observe + inspect, read-only | A run is never mutated by the viewer |
| 5 | DESIGN lane at the pipeline head | Gemini stills become the build template *and* the visual-gate reference |
| 6 | Dogfood — the canvas itself is built this way | It should meet the bar it enforces |
| 7 | All user-scope MCP servers available in builds | Owner's explicit call; see §5 for the containment it requires |
| 8 | `@xyflow/react` for the canvas | Measured, not assumed; see §9 |
| 9 | Animation gate reports at QUALITY tier, never blocks | Subjective judgement shouldn't false-fail a run |
| 10 | Anti-slop lexical hooks block from day one | Unambiguous signals, enforced at write time |
| 11 | **Claude only. Codex is out of scope.** | Owner decision, 2026-07-28. See §14 for what was learned and why it may reverse |

---

## 4. Phase 0 — Fix the held-out boundary (BLOCKING, ships first)

**There is an executed bypass open in the current code, with one builder.** Verified by execution, not inspection:

```
Grep{ path: "<ancestor-of-suite>", pattern: "assert", output_mode: "content" }  →  ALLOW
```

`insideDir` (`claude-builder.ts:113-117`) asks only *"is the candidate inside `heldOutRoot`?"* — never *"does the candidate recursively **contain** `heldOutRoot`?"*. ripgrep walks down and returns held-out test source.

Three more holes of the same class:

| Hole | Cause |
|---|---|
| `mcp__*` read tools, `ReadMcpResource` | `READ_TOOLS` (`:100`) is a **tool-name allowlist** — structurally fail-open to every read-capable tool that ships next |
| `Grep`/`Glob` with `path` omitted | `pathInput` returns `null` → falls through to ALLOW; CLI then defaults to cwd |
| Held-out **test titles** leak | `results/scorer-out/<runId>/result.json` persists `criterionCoverage[].testRefs` *outside* the sealed store |

### 4.1 Changes to `decideToolPermission` (`claude-builder.ts:130-160`)

All four are pure-function changes, unit-tested beside the existing 9, each with a negative control.

1. Deny when the resolved candidate is inside `heldOutRoot` **OR recursively contains it**.
2. Flip `READ_TOOLS` from a name allowlist to **deny-by-default**: any tool whose input carries a value resolving into/containing the suite is denied *regardless of tool name*.
3. Treat a missing `path` on `Grep`/`Glob` as **cwd**, not as "no path".
4. **New Agent branch** — allowlist `subagent_type` against the compiled shortlist; deny any call carrying `isolation`; deny unless `run_in_background === false`.

Rationale for (4): `AgentInput.isolation` accepts `"worktree"` (escapes `sandbox.filesystem.allowWrite`) and `"remote"` (**runs the build off-host**, outside every local layer — sandbox, `denyRead`, `allowWrite`, path checks — and the workspace plus ticket text leave the machine). `run_in_background` **defaults to `true`**, so without forcing it false, lanes do not sequence and the gate scores a moving artefact.

### 4.2 Close the results leak

Either write `result.json` under `heldOutRoot` (inherits the deny) or strip `criterionCoverage[].testRefs` and `tier0[].detail` from the persisted copy, keeping them in SQLite only.

### 4.3 Why this blocks everything else

Decision #7 (all MCP servers available) hands build agents file-read tools that bypass the guard **entirely** under today's name-allowlist. Phase 0 is what makes decision #7 safe. Without it, `heldOutPass` is not "strong signal, not proof" as STATUS §0 claims — it is **"signal with a known, executed bypass."**

Update STATUS §0 with the corrected framing once fixed.

---

## 5. Phase 0.5 — The canary probe (one run, settles five unknowns)

One throwaway run: haiku, `maxTurns ≈ 8`, a few thousand tokens. Plant a unique string in `<heldOutRoot>/canary.txt`, print `system/init`, prompt the parent to delegate to exactly one subagent, then assert:

| # | Assertion | Settles |
|---|---|---|
| a | `system/init.tools[]` contains the Agent/Task tool | **Precondition** — without it, SDK-native delegation has no mechanism |
| b | `system/init.skills[]` is non-empty under `settingSources: []` | Whether `AgentDefinition.skills` preloads anything at all, or silently nothing |
| c | `canUseTool` fired with `agentID` non-null for the child's calls | Whether the sealed-suite guard survives delegation |
| d | Child's `Grep{path:<ancestor>}` is DENIED and the canary is absent | Phase 0 fix works against a *subagent* |
| e | Child's Bash `cat <heldOutRoot>/canary.txt` is refused | **First ever exercise of `denyRead` OS enforcement** (STATUS §3 records it as never run) |

Also assert the canary appears nowhere in the child's `tool_use_result` report — that closes the **content-laundering** path, where a subagent obtains suite text and returns it in a structured report while the parent's own tool history never names the path.

**Contingency if (b) fails:** copy shortlisted skill directories into a run-controlled path and preload from there — which also makes the skill set recordable per run.

---

## 6. Phase 1 — Delegation

### 6.1 Execution model: SDK-native, single session

**One `query()` for the build phase.** The SDK's own Agent tool performs delegation.

The rejected alternative — N separate `query()` calls, one per lane — produces **zero real edges**: `parent_tool_use_id` is `null` at the top level of every separate session, so every line on the canvas would be fabricated. It also yields N `session_id` values against a `sessionId: string | null` field that the rate-limit resume path depends on.

What the SDK gives us for free:

```
task_started        → node created    task_id, subagent_type, description, prompt
parent_tool_use_id  → the edge        agent → its children
task_updated.patch  → node status     pending|running|completed|failed|killed|paused
task_notification   → node closed     status, tokens, tool_uses, duration
tool_progress       → tool pills      carries parent_tool_use_id AND task_id
```

Subagent `tool_use`/`tool_result` blocks are forwarded **by default**. `forwardSubagentText: true` adds text/thinking for the click-a-node transcript. `agentProgressSummaries: true` forks each running subagent ~30s for a short present-tense caption — the live node subtitle, at negligible cost.

**Accepted tradeoff:** lanes are server-side labels on `subagent_type`, not separate processes, so lane ordering is advisory rather than enforced by construction. Forcing `run_in_background: false` recovers most of the guarantee.

### 6.2 Loading the owner's agents and skills

**SUPERSEDED 2026-07-28 by probe evidence and an owner decision. Read this section, not §6.3's contingency.**

The original design hand-compiled `AgentDefinition`s so `settingSources: []` could stay. A live probe killed the premise:

```
settingSources: []        ->  16 skills (built-in only), 5 agents.  OWNER SKILLS: NONE
settingSources: ["user"]  -> 162 skills, 144+ agents.               OWNER SKILLS: all
```

`AgentDefinition.skills` can only name a **discovered** skill. Under `settingSources: []` the owner's 41 are not discovered, so preloading them would silently load nothing. Programmatic `Options.agents` solves agents; **nothing solves skills** short of loading user settings or repackaging the skills per run.

The concern that justified `settingSources: []` was **comparability** — an uncontrolled input that changes what gets built without appearing in the ticket. **The owner has dropped model comparison** (it existed to pit Claude against Codex; Codex is now out of scope, §14). With no comparison to protect, the cost of loading user settings is close to zero and the benefit is the entire skill system, which is essential to the DESIGN lane and the motion bar.

> **DECISION: `settingSources: ["user"]`.** The owner's agents, skills and CLAUDE.md all load natively.

This **shrinks Phase 1 substantially**. No longer needed:
- the frontmatter parser and `AgentDefinition` compiler
- the `model:`-stripping and description-rewriting pass
- the skill-name canonicalisation table
- the run-scoped skill-packaging contingency

Still needed, and unchanged:
- **`allowedAgents` remains the delegation boundary.** `settingSources` decides what the orchestrator can *see*; the `canUseTool` Agent branch decides what it may *use*. Keep the curated shortlist — 144 visible agents is a noisy search space, and the guard is already built and tested.
- **Record the agent/skill/MCP set per run** (names + hash). `claude-builder.ts:192-195` demands no *unrecorded* input, and that still holds.

**`heldOutPass` still matters** and all Phase 0/0.1/0.2 work stands. It is no longer a comparison metric but it is still the answer to "did this build actually deliver?", and it is meaningless if the suite is readable.

**Consequence to watch:** user settings also load the owner's **hooks** into every build —
`guard.sh`, `secret-guard.sh` (PreToolUse), `verify.sh` (PostToolUse + Stop), `migration-lint.sh`,
`session-summary.sh`. The two guards are a net gain. **`verify.sh full` on Stop is built for
interactive sessions and can block completion** — if a build hangs there, exclude that one hook
rather than abandoning `settingSources: ["user"]`.

### 6.2a Superseded approach, kept for the record

The comment at `:192-195` demands not "no external input" but **"no *unrecorded* input"** — so the exact agent set, skill list and MCP set are recorded in the run record (names + hash) alongside the ticket.

**Frontmatter allowlist** (positive assertion, not a denylist — a future key must not flow through):
`description`, `prompt` (markdown body), `tools`, `disallowedTools`, `model`, `skills`, `maxTurns`, `effort`.

**Refused / stripped:**

| Field | Action | Why |
|---|---|---|
| `permissionMode` | **REFUSE — fail the run** | Accepts `bypassPermissions`, which would route around the one layer proven to cover subagents |
| `mcpServers` | **STRIP** | Set at run level instead; `strictMcpConfig` does not filter agent-declared servers |
| `mcp__*` entries inside `tools:` | **FILTER** | `scientific-literature-researcher.md:4` proves these appear inside `tools:` arrays too |
| `model` | **DROP, pin our own** | See below |
| `background` | **DROP** | Compounds the `run_in_background` default |

**`model` is pinned unconditionally.** Every shortlisted agent carries `model: claude-opus-5` on line 5 — with one exception (`trigger-dev-task-writer.md:4`, `model: inherit`). This is not "flag the exceptions"; it is universal. A frontmatter `model:` silently overrides the run's chosen model and would make a build non-deterministic per lane, breaking `request.modelId` as the record of what built the ticket.

**Descriptions must be rewritten mutually exclusive at parse time.** `fullstack-developer`'s description swallows `backend-developer`'s and `nextjs-developer`'s wholesale. The orchestrator selects on `description`; ambiguous descriptions select badly no matter how good the agents are.

**Two special cases:**
- `trigger-dev-task-writer.md` has **no `tools:` line at all** → inherits every parent tool. Set an explicit list. Key the Record by frontmatter `name` (`trigger-dev-expert`), not filename.
- The shortlist must be enforced **twice**: `Options.agents` limits what the orchestrator can *see*, but `subagent_type` is a free string in the schema. The `canUseTool` Agent branch (§4.1.4) is what makes it a boundary rather than a suggestion. `Query.supportedAgents()` reads back what the CLI actually registered.

### 6.3 Skill preloads

> **CORRECTED 2026-07-28.** An earlier draft claimed `skills: ["taste-skill"]` resolves to nothing because the canonical name is `design-taste-frontend`. **That was wrong.** The live init payload lists skills by **directory name** (`taste-skill`, `output-skill`, `gpt-tasteskill`), and the SDK accepts *either* the SKILL.md `name` **or** the directory name. Both spellings work. The table below is kept as a useful cross-reference, not as a trap to code around.

For reference, directory name vs SKILL.md `name:`:

| Directory | Canonical `name:` |
|---|---|
| `taste-skill` | `design-taste-frontend` |
| `soft-skill` | `high-end-visual-design` |
| `minimalist-skill` | `minimalist-ui` |
| `brutalist-skill` | `industrial-brutalist-ui` |
| `output-skill` | `full-output-enforcement` |
| `gpt-tasteskill` | `gpt-taste` |
| `image-to-code-skill` | `image-to-code` |
| `redesign-skill` | `redesign-existing-projects` |

`skills: ["taste-skill"]` resolves to **nothing**, silently. The postgres family and the six `trigger-*` skills use names identical to their directories.

**All five pg-aiguide skills ARE installed** (`postgres`, `design-postgres-tables`, `pgvector-semantic-search`, `postgres-database-migration`, `postgres-hybrid-text-search`) with matching names. No install prerequisite. `postgres-pro` preloads `["postgres", "design-postgres-tables"]`.

**`gpt-taste` is preloaded on BOTH `taste-frontend-expert` and the frontend build agents.** It is the only skill in the registry whose description names strict GSAP ScrollTriggers, and the *builders* write the motion. Preload it only on the designer and the motion bar dies at the DESIGN→BUILD boundary. Note `taste-frontend-expert.md:29` marks it "only when explicitly asked" — the compiled prompt must state that the pipeline **is** the explicit ask, or the agent body will decline it.

**`impeccable` is preloaded on the frontend build and review agents** (owner requirement). Constraints: `allowed-tools` narrows Bash to `Bash(npx impeccable *)` and `Bash(node .claude/skills/impeccable/scripts/*)`; its setup step resolves against the skill's loaded base directory, so it works when preloaded even though a fresh workspace has no `.claude/skills/impeccable/`. Its `reference/craft-floor.md` — "the quality floor, the absolute bans, the reflexes no detector catches" — is the **authoritative source for the Layer-1 hook ruleset in §7**, and `reference/animate.md` is the animation playbook. Do not invent rules that this file already owns.

### 6.4 The lane model

| Lane | Agents | Concurrency |
|---|---|---|
| **SPEC** | `context-manager` → `product-manager` ∥ `architect-reviewer` (∥ `api-designer`) → `qa-expert` | `context-manager` strictly first (CLAUDE.md:25); `qa-expert` last — it grades the others |
| **DESIGN** | `taste-frontend-expert` (owner), `ui-designer` (tokens only) | **Strictly sequential** — `-i` chains each image off the last to hold the palette |
| **BUILD** | 11 specialists, filtered by surface | Scaffold sequential, then parallel **by file-ownership disjointness only** |
| **REVIEW** | `code-reviewer`, `accessibility-tester`, `security-auditor`, `ai-writing-auditor`, `ui-designer` (visual gate), `architect-reviewer` | Fully parallel over a **frozen** tree |
| **GATE/FIX** | `debugger`, `test-automator`, `dependency-manager`, `refactoring-specialist`, `qa-expert`, + adversaries (§8) | Sequential — parallel fixes race a failing tree |

**28 agents** shortlisted from 144 (26 + the two adversaries in §8). Dropped wholesale: PowerShell/Windows/M365 (11), vertical markets (6), mobile/native (10), non-JS backends (16), infra/SRE (11), ML/data (12), business/GTM (14), and all 7 meta-orchestrators — *the SDK's Agent tool **is** the delegation mechanism; those duplicate the orchestrator being authored.*

**Write-capability gaps — treat as prose-returning lenses, never ask for a file path:**

| Agent | Tools | Missing |
|---|---|---|
| `accessibility-tester`, `qa-expert` | `Read, Grep, Glob, Bash` | **no Write/Edit** |
| `security-auditor` | `Read, Grep, Glob` | **no Bash, no Write** |
| `context-manager`, `product-manager` | no Bash | cannot run anything |

### 6.5 Routing

Classify once at SPEC exit into a `surface` plus additive `traits`. Lanes are a pure function of the classification, so it is testable without running a build.

`surface`, first match wins: `background-jobs` → `cli` → `library` → `api` → `web-ui` → `fullstack`.
`traits`: `db`, `container`, `auth`, `existing-ui`, `python`.

SPEC, BUILD, REVIEW, GATE/FIX **always run**. DESIGN is the only conditional lane:

```
designLane = surface ∈ {web-ui, fullstack}
          && (visualIntent(ticket) || surface === "web-ui")
          && geminiKeyAvailable()
```

The `|| surface === "web-ui"` term is deliberate: for a pure web-UI ticket the deliverable *is* the visual, and the standing motion bar applies whether or not the ticket says "design". `fullstack` requires explicit visual intent, so an internal admin CRUD screen does not pay for five mockups.

`geminiKeyAvailable()` is a **server-side** check mirroring `gemini-image.sh:36-39` resolution order. **If false, DESIGN degrades — it does not block.** `taste-frontend-expert` still art-directs and produces written direction; the visual gate falls back to rule-based scoring with no reference PNGs; the canvas shows the lane as degraded. Blocking a build on an absent image key is a worse failure than shipping without mockups.

---

## 7. Phase 2 — The DESIGN lane and the motion bar

### 7.1 What "custom animation" actually means

Derived from the owner's own reference, **kamilborzecki.dev**, analysed at runtime rather than assumed:

```
/assets/world/leg-1.mp4   5.6 MB  ← fetch() → blob: URL (fully buffered)
/assets/world/leg-2.mp4   6.1 MB  ← fetch() → blob: URL
leg-1-poster.webp / leg-2-poster.webp   77/100 KB, instant first paint
video: paused, autoplay=false, loop=false, muted, playsInline, objectFit:cover
DOM:   scroll-journey__stage > __media > __layer ×2, __progress, __chapter ×2
document.getAnimations() === 0      no GSAP, no Framer, no Three, no Lenis
5 × section illustrations (~2.8 MB PNG each), Gemini-generated
```

**The mechanism is scroll-scrubbed video.** MP4s are fetched into blobs so seeking is instant, then `video.currentTime` is driven by scroll progress via `requestAnimationFrame`. Nothing animates in the CSS sense — the viewer scrolls *through* a pre-rendered world in legs.

**The pipeline this implies:** Gemini still (nano banana) → image-to-video (Higgsfield-class) → scroll-scrubbed world layer, with a `.webp` poster for first paint.

> **Correction carried into §8:** an earlier draft of the Layer-2 gate required "GSAP or Framer Motion with a real timeline." That rule would have **failed this very site**, which uses neither. The bar is *motion derived from the design stills* — scroll-scrubbed video, GSAP/Framer timelines, or rAF-driven scrubbing all satisfy it. What is banned is stock hover/fade with nothing bespoke.

### 7.1a Phase staging of the motion bar

The scroll-scrubbed-video path needs an image→video capability. It is scoped as **Phase 2c** (§7.6) rather than left implicit — but it ships *after* 2b, so the Layer-2 gate must be staged:

| | Phases 2a/2b | Phase 2c onward |
|---|---|---|
| DESIGN output | ≥5 stills (`design-refs/*.png`) | stills **+** scrubbable `.mp4` per key section, `.webp` poster each |
| Layer-2 satisfiers | GSAP/ScrollTrigger timeline, or rAF-driven element scrubbing | the above **+** scroll-scrubbed video world-journey |
| Layer-2 still fails | hover/fade only; library imported but unused in a timeline | unchanged |

**Until 2c lands, the gate must not demand video.** Gate the satisfier list on a capability flag derived from whether `gemini-video.sh` is present and a key resolves — the same degrade-don't-block posture as §6.5.

### 7.2 Mockup generation

`taste-frontend-expert` shells out to `~/.claude/scripts/gemini-image.sh` — already wired, already documented in the agent body:

- default model `gemini-3.1-flash-image-preview` (Nano Banana 2)
- `-a` aspect (`1:1 … 21:9`), `-o` output path
- **`-i reference.png`** — style-consistency pass; this is what holds the palette across the set, and why generation is strictly sequential
- key resolution `$GEMINI_API_KEY` → `$NANOBANANA_API_KEY` → `~/.gemini/api_key`

Closed-loop critique per `taste-frontend-expert.md:46`: after each generation, Read the image and critique it against the routed skill's rules; regenerate weak images with a corrected prompt, max 2 retries, using `-i` with the best sibling.

**≥5 PNGs land in `design-refs/` inside the workspace** with a `manifest.json` mapping absolute path → section, aspect, intent.

### 7.3 DESIGN → BUILD handoff

Subagents do not share context. A mockup living only in `taste-frontend-expert`'s transcript is invisible downstream. Three mechanisms, **all required**:

1. **Filesystem** — PNGs in `design-refs/` inside the workspace, the only path `sandbox.filesystem.allowWrite: [workspace]` permits.
2. **Prompt injection** — the orchestrator reads `manifest.json` and injects **absolute image paths**, the design read, and the three dials (`DESIGN_VARIANCE` / `MOTION_INTENSITY` / `VISUAL_DENSITY`) verbatim into *each* build agent's prompt. Paths in a prompt are what make `Read` on a PNG actually happen.
3. **Skill bridge** — `image-to-code` preloaded on frontend builders, turning "here are pictures" into a mechanical implementation procedure.

### 7.4 DESIGN → REVIEW link

The visual gate is **`ui-designer`, deliberately not the mockup author** — an agent grading its own art direction is not a gate. It is one of only two shortlisted agents with Bash + Read + Write together, which is exactly what driving Playwright and writing a report requires.

Mechanism: same `manifest.json` paths injected → Playwright captures one screenshot per section at the mockup's aspect → gate `Read`s each mockup/screenshot pair (both render visually to the model) → scores against the manifest intent plus preloaded `design-taste-frontend` rules → writes `review/visual-gate.md` at **QUALITY tier, non-blocking**.

### 7.5 Known failure points in the image chain

| Risk | Detail | Mitigation |
|---|---|---|
| **`TMPDIR`** | `gemini-image.sh:43` does `mktemp -d` in the *system* temp dir; `allowWrite` is `[workspace]` | Set `TMPDIR` inside the workspace in the subprocess env. **Most likely silent breakage.** |
| **Network egress** | `:71` curls `generativelanguage.googleapis.com`; `sandbox.network` is unconfigured | Verify CLI default; allowlist the host if a network policy is ever added |
| **`python3`** | Hard dependency, used twice (`:48`, `:97`) | Assert present in preflight |
| **`npx impeccable`** | `impeccable`'s `allowed-tools` permits `Bash(npx impeccable *)`; base-dir resolution covers the `scripts/*` pattern but **not** this one. If the package does not resolve, the skill's own setup step fails | Assert resolvable in the same preflight as `python3` |
| **Key survives stripping** | `GEMINI_API_KEY`/`NANOBANANA_API_KEY` are absent from `STRIPPED_ENV_NAMES` (`subprocess-env.ts:39-55`, documented as "a subtraction, never an allowlist") | Intended. Never echo the key into a prompt, log line, or canvas node (CLAUDE.md:18) |
| **Failures are invisible to the permission layer** | `autoAllowBashIfSandboxed: true` means Bash never reaches `decideToolPermission` — these surface as script errors | The canvas **must** surface the agent's degradation message, or a DESIGN lane that produced zero images looks successful |

**Metered-call note.** `costUsd: null` is a system-wide invariant for subscription runs. The DESIGN lane spends real money via a key that survives env-stripping by reading `~/.gemini/api_key` from disk. Design-lane spend is tracked on its own line; `costUsd` stays `null` for build/gate/judge.

---

## 7.6 Phase 2c — The image→video step

Makes the technique in §7.1 reachable. **Veo 3.1 via the Gemini API — the same key, same provider, same resolution order as `gemini-image.sh`.** No new credential, no third-party service.

Corroboration that this is the right tool: the reference site's videos are **4.04 s at 1280×720**, which is exactly Veo's `durationSeconds: "4"` at `resolution: "720p"`.

### 7.6.1 API shape (verified from Google's docs, not assumed)

```
POST https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning
Header: x-goog-api-key: $GEMINI_API_KEY

{ "instances": [{ "prompt": "<motion direction>",
                  "image": { "inlineData": { "mimeType": "image/png", "data": "<base64>" }}}],
  "parameters": { "aspectRatio": "16:9", "resolution": "720p", "durationSeconds": "4" }}

poll:     GET https://generativelanguage.googleapis.com/v1beta/{operation_name}   until done:true
download: .response.generateVideoResponse.generatedSamples[0].video.uri
          curl -L -o leg-N.mp4 -H "x-goog-api-key: $KEY" "<uri>"
```

| | Values |
|---|---|
| Models | `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview` |
| Aspect | **`16:9` (default), `9:16` only** |
| Duration | `4`, `6`, `8` s — 8 s required for 1080p/4k or reference images |
| Resolution | `720p` (default), `1080p`, `4k` (Lite: 1080p only) |

### 7.6.2 `~/.claude/scripts/gemini-video.sh`

A sibling to `gemini-image.sh`, deliberately the same shape so `taste-frontend-expert` uses it the same way:

```
gemini-video.sh "<motion prompt>" -i still.png [-a 16:9] [-d 4] [-r 720p] [-o leg-1.mp4] [-m model]
```

- **Same key resolution**: `$GEMINI_API_KEY` → `$NANOBANANA_API_KEY` → `~/.gemini/api_key`.
- **Blocks until done.** The script polls internally and returns only when the mp4 is on disk, with a hard timeout. An agent must never burn turns polling a long-running operation.
- **Emits the poster too**: a `.webp` derived from the source still. The still *is* the first frame, so no frame extraction is needed — just a downscale/convert. Preflight-assert whatever converter is used (`sips` is built into macOS; `cwebp` otherwise), same as the `python3` assertion.

### 7.6.3 Constraints this pushes back into the DESIGN lane

1. **Stills destined for animation must be generated at `16:9` or `9:16`.** `gemini-image.sh` accepts `1:1 … 21:9`; Veo does not. The `manifest.json` gains an `animate: boolean` and an `aspect` field, and any section marked `animate` is generated at a Veo-compatible aspect from the start.
2. **Bounded by default: at most 2 video legs per run.** Matches the reference site (`leg-1`, `leg-2`) and caps a materially more expensive call than image generation. Raising it is a per-run, recorded opt-in.
3. **Audio is generated and ignored.** Veo 3.1 produces native audio; the playback pattern is `muted` + `playsInline`. Do not build on the audio track.
4. **Long-running, so the canvas must show it.** A video leg takes minutes, not seconds. The node needs a distinct long-running state, or the canvas looks stalled. `agentProgressSummaries` covers the caption; the duration does not fit the ordinary tool-pill lifecycle.

### 7.6.4 Consumption pattern the build agents must implement

Taken from the reference site's runtime behaviour, not invented:

```
fetch(mp4) → blob: URL → <video muted playsInline preload paused, no autoplay, no loop>
poster=<leg-N-poster.webp>                       instant first paint
rAF loop: video.currentTime = f(scrollProgress)   scrub, do not play
layers: position:absolute, object-fit:cover       full-bleed world
```

The `fetch`→blob step is what makes seeking instant; a plain `<video src>` streams and scrubs badly. This is the concrete satisfier the Layer-2 gate accepts once 2c has landed.

---

## 8. Phase 2b — Anti-slop enforcement

Hooks are **deterministic code that runs whether the model cooperates or not**. The taste skills' pre-flight checks are advisory today; a hook is a gate. Verified mechanisms: `PreToolUse` denials **bypass `canUseTool` entirely**; a `Stop` hook can set `prevent_continuation`.

**Register `Options.hooks` callbacks, not `includeHookEvents`.** `SDKHookStartedMessage` carries `hook_id`, `hook_name`, `hook_event` and **no `agent_id`, no `tool_use_id`** — hooks you can see but cannot attribute. Only the callback's `HookInput` carries `agent_id`/`agent_type`. That same `PreToolUse` callback is also the per-call MCP detector (`mcp__<server>__<tool>` prefix) and the skill-invocation detector.

### Layer 1 — `PreToolUse` on Write/Edit — lexical, blocking from day one

Ruleset sourced from `impeccable/reference/craft-floor.md`, not invented. Covers: purple→pink gradients, placeholder media (`picsum`, `placehold.co`, `unsplash.com/random`, lorem ipsum), Inter+slate boilerplate with no custom type scale, motion poverty, centered-hero+3-cards. Denial quotes the violated rule so the agent self-corrects — the same instructive-denial pattern already proven in `decideToolPermission`.

**Retry cap: the same rule firing 3× escalates to the orchestrator** rather than looping. Every fire is logged with rule + agent, so the false-positive rate is measured from real runs rather than guessed.

### Layer 2 — `Stop`/`SubagentStop` — completion gate

A frontend agent may not declare done unless the output carries **bespoke motion derived from the design stills**. Satisfied by *any* of:

- scroll-scrubbed video/world-journey (`fetch`→blob→`currentTime = f(scrollProgress)`)
- a real GSAP/ScrollTrigger timeline — pinned, scrubbed, staggered, custom easing
- rAF-driven element scrubbing

Failed by: only hover/fade/`transition-all`, or an animation library imported but never used in a timeline. On failure → `prevent_continuation` with specifics; the agent keeps working.

### Layer 3 — visual gate — QUALITY tier, never blocks

Per §7.4. Reports per-section verdicts against the mockups. Owner's explicit call: subjective judgement informs, it does not false-fail a run.

### `/debugfix` integration

`/debugfix` is a **slash command with `disable-model-invocation: true`** (`~/.claude/commands/debugfix.md`) — the model cannot invoke it, and a subagent cannot invoke slash commands at all. Its *procedure* is therefore compiled into the GATE/FIX lane by server code reading the command file.

Flags map to lane parameters derived from the surface classification:

| Flag | Trigger | Agent |
|---|---|---|
| `--web <url>` (alias `--url`) | `surface ∈ {web-ui, fullstack}` | `human-factors-adversary` |
| `--native [device]` | **currently unreachable** — see below | `mobile-adversary` |
| `--max` ≡ `--effort max` | always, for the gate lane | — |

**`--native` is specified but not yet reachable, stated plainly rather than implied to work.** The `surface` enum in §6.5 has no mobile member, and every mobile/native agent was dropped from the shortlist, so no ticket can currently classify as mobile. `mobile-adversary` is wired and pinned so the path exists, but it will not fire until a `mobile` surface and at least one native build agent (`expo-react-native-expert` is the natural first) are added. Tracked in §11.


**The URL comes free:** `preview.ts` already serves the artefact at `http://127.0.0.1:<port>` via `deploy: true`, using the same dependency-free static server the sealed scorer uses. That is exactly the running target `--web` needs.

Both adversaries carry `model: inherit` (pin explicitly) and an extensive `disallowedTools` list covering Write/Edit/Agent **and every credential-bearing MCP server** — they are mechanically read-only. They need a Playwright/Chrome-DevTools browser MCP, and **no agent in the registry carries browser tools**, so the gate depends on Bash plus workspace-installed Playwright — a network-dependent step that can fail *after* BUILD has already succeeded.

`/debugfix`'s own preflight requires `~/.claude/hooks/{guard,verify}.sh` and a `.debugfix-active` sentinel. The ported lane must either satisfy that or state plainly that it is using in-workflow verification only — never claim hook enforcement it does not have.

---

## 9. Phase 3 — The canvas

### 9.1 Event contract — zero DDL

```sql
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)) WITHOUT ROWID;
```

`payload` is opaque JSON and the read path is an unchecked `JSON.parse(...) as SseEvent`. So **live-canvas and replay-an-old-run are ONE code path** — the same `foldGraph(state, event)` reducer over a live SSE tail or `eventsSince(runId, 0)`. No DDL, no migration, no `graph_nodes` table. Old runs contain no `graph_*` events and render an empty canvas with no feature flag.

**Extend the `SseEvent` union on the existing stream. Do not add a parallel channel.** Total ordering against `status`/`phase` is a correctness requirement (an agent must not show "running" inside a cancelled run), and `seq` gives it for free. `Last-Event-ID` resumability already works and is exact.

Seven new members: `graph_agent` · `graph_agent_status` · `graph_tool` · `graph_skill` · `graph_hook` · `graph_result` · `graph_inventory`.

Three design rules, each forced by evidence:

- **Node ids are server-assigned and short** (`n1`, `n2`, …). `redactForPersistence` rewrites any 40+ char mixed-case+digit token to the *identical* literal `[REDACTED:HIGH_ENTROPY_TOKEN]`, which would **merge two distinct agents into one node**. `task_id` has no documented length bound, so identity must never be built on raw SDK ids — they ride along under `sdk` for the inspector only.
- **`attribution: "exact" | "inferred"` is REQUIRED.** Hook messages carry no task identity, so hook→agent attribution is a server-side inference. A required field forces every emitter to state whether it knew or guessed, and lets the canvas render an inferred edge differently instead of lying.
- **MCP is not a separate event type.** An MCP call *is* a `tool_use` whose name matches `mcp__<server>__<tool>`. A nullable `mcpServer` field carries the same information with no classification risk.

**Invariant:** a node id is never referenced before its `graph_agent` event, so downstream events carry only `node`, not `lane`.

**The union is declared in THREE hand-maintained places** — server `api-types.ts`, client `api-types.ts`, and the runtime `EVENT_TYPES` array — with nothing enforcing agreement. Widening one and forgetting another **compiles clean on both sides and silently blanks the canvas**. Add the type-level guard in the same commit:

```ts
type Missing = Exclude<RunEventType, (typeof EVENT_TYPES)[number]>;
const _noneMissing: Missing extends never ? true : never = true;
```

`api-types.ts:4-5` is a **co-change rule, not an immutability rule** — "same commit" means all four artefacts move together.

### 9.2 Snapshot, then subscribe

Measured on a 32,000-row run: `eventsSince(runId, 0)` returns in 22.7 ms and parses in 11.7 ms — but is **7.01 MB on the wire**. The snapshot is a **wire-size fix, not a CPU one**.

Add additive `GET /api/runs/:id/graph` → `{atSeq, nodes, edges, inventory}`, then `EventSource(...?lastEventId=atSeq)`.

**THE INVARIANT: fold the snapshot from `store.eventsSince(runId, 0)`, never from live orchestrator memory.** `attachSse` replays from durable rows, so the window between snapshot and EventSource is not a race — but only if `atSeq` is a durable watermark.

Same `foldGraph` runs server-side for the snapshot and client-side for the tail.

### 9.3 Rendering

**`@xyflow/react` 12.11.2** — measured against this exact stack, not assumed: clean npm resolve against React 19.2.4 (no ERESOLVE), successful `next build` on Next 16.2.12/Turbopack, production headless-Chromium load with **zero console messages and zero hydration warnings**. Cost **+55.9 kB gzip JS, +2.6 kB gzip CSS** on a route already `"use client"`. Tree-shaking saves 71 bytes, so the number is honest and fixed. ~52 kB of it is d3-zoom/drag/selection — precisely the interaction engine a hand-roll would reimplement.

Canvas/WebGL rejected **on category**: its only advantage is node-count headroom the measurements prove unnecessary, and it forfeits the DOM needed for skill/MCP/hook pills and click-to-inspect.

Config: `colorMode="dark"`, `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={false}`, `proOptions={{hideAttribution:true}}`, `fitView` (**initial-fit only — verified it does not re-fit**), `onlyRenderVisibleElements` left `false`. Import `dist/base.css`, not `dist/style.css`.

**Layout: a sticky `Map<task_id, row>`** assigned on first `task_started` sighting inside its authored lane, **never re-sorted**. The x-axis is already fixed by lanes, so no dagre/elk is needed in any variant.

**Two mount hazards, both verified:**
- `page.tsx:68-89` early-returns while `run === undefined` — the canvas must live **below** that boundary.
- Never wrap it in a condition or give it a changing `key` — either resets the viewport mid-run.

**Data-loss trap:** `MAX_TRACE_ENTRIES = 3000` slices oldest-first. Graph state must live in its **own accumulator keyed by `task_id`**, never derived from `trace.entries`, or nodes silently vanish mid-run on a long ticket.

Measured: pan holds **60 fps from 30 to 2,500 nodes (15,000 pills)** — pan is one composited CSS transform, so node count is irrelevant to pan cost.

**Accessibility: do not claim the canvas provides it.** React Flow gives partial affordances only. Keep `TracePane` as the accessible equivalent representation and say so in the UI.

### 9.4 Throughput and the real risks

Volume is a **non-issue**: ~15,000 appends/sec measured against a faithful replica of `db.ts`'s two-statement path, versus a realistic tens/sec with 6-8 concurrent specialists. **Do not build a queue.**

What actually bites:

1. **No backpressure — top risk.** `bus.ts:107-113` discards `response.write`'s return and never waits for `drain`; `bus.emit` fans out synchronously from the orchestrator's message loop on the HTTP thread. Invisible at today's rate; with eight subagents it OOMs. Minimum fix: per-listener pending-byte count, then coalesce or close with a code the client already reconnects on.
2. **Heartbeat write-amplification.** `SDKToolProgressMessage.heartbeat` carries no state change. **Never persist heartbeats** — derive elapsed time client-side from the `graph_agent` timestamp.
3. **`PRAGMA synchronous = NORMAL`** is worth 4.5× and does **not** violate `db.ts` rule 3 — in WAL mode it is fully durable against process crash. Also wrap `appendEvent`'s two statements in one transaction.
4. **Unbounded growth.** No `DELETE FROM events` exists anywhere. Decide retention now, while there is nothing to migrate.

---

## 10. Unverified — must not be load-bearing

| # | Claim | How it gets settled |
|---|---|---|
| 1 | `canUseTool` fires for subagent-originated calls | Canary probe (c). Inferred from `agentID: e.request.agent_id` plumbing + `SDKPermissionDeniedMessage.agent_id`; **never observed**. If a CLI version regresses this, N subagents run with no host-side check while unit tests still pass — they exercise a pure function, not the wiring. |
| 2 | Skills are discovered under `settingSources: []` | Canary probe (b). If not, `AgentDefinition.skills` preloads nothing, silently. |
| 3 | `sandbox.filesystem.denyRead` covers in-process Read/Grep/Glob | Canary probe (e). Typings scope filesystem clauses to "within the sandbox"/"sandboxed commands", and state explicitly that in-process WebFetch is *not* gated by the network equivalent. |
| 4 | The `claude_code` preset exposes the Agent/Task tool | Canary probe (a). **Precondition** — without it the whole approach is moot. |
| 5 | `settings.permissions.deny` `Read(<glob>)` is filesystem-scoped vs tool-name-scoped | CLI docs, not typings. Affects whether the engine-level second layer is real coverage. |
| 6 | `canUseTool`'s `updatedInput` is honoured for the Agent tool | Not load-bearing — the Agent branch **denies** rather than rewrites until observed. |

**Skill invocation is observable** — confirmed empirically from a real session transcript: `{"name":"Skill","input":{"skill":"superpowers:brainstorming"}}`. The SDK's `ToolInputSchemas` has no `SkillInput` entry, which is real negative evidence but not decisive, since the tool demonstrably exists at runtime. The `graph_skill.source: "preloaded" | "invoked"` discriminator contains the blast radius either way.

**Pin the SDK version.** 0.3.220 / claudeCodeVersion 2.1.220. `subagent_type` on messages, the `task_*` family and `agentProgressSummaries` are recent surface with no stability guarantee; treat a bump as a canvas-regression risk.

---

## 11. Backlog — carried forward, not dropped

Per CLAUDE.md rule 7.

1. **`/simplify`, `/debugfix`, `/trimpng` are not skill directories** — `/debugfix` is a command (`~/.claude/commands/debugfix.md`), the others reach the session through the harness. GATE/FIX substitutes `refactoring-specialist` + `debugger`; this substitution is surfaced, not silently equated.
2. **Trigger.dev MCP mandate cannot be fully satisfied** — CLAUDE.md:108-110 requires skills + subagent + MCP *together*. Under decision #7 the MCP is available; if that ever narrows, the build can write task code but not init/deploy/query runs. Surface as a limitation.
3. **Per-agent `maxTurns`/`effort` are unset.** `DEFAULT_MAX_TURNS = 400` is session-level. The DESIGN lane alone is ~20-25 turns (5 images × up to 2 retries + Read-and-critique each). Set explicitly or one runaway lens consumes the budget before GATE/FIX starts.
4. **Illustration weight on the reference site** — 5 × ~2.8 MB PNG (~14 MB) while posters are 77-100 KB webp. The REVIEW lane should catch unoptimised hero media.
5. ~~Image-to-video step is unspecified.~~ **Scoped as Phase 2c (§7.6)** — Veo 3.1 via the Gemini API, same key.
6. **Retention policy for `events`.** Decide before there is data to migrate.
7. **Engine-level permission layer** (`settings.permissions.deny`) as a second boundary under `canUseTool` — pending item 5 in §10.
8. **Mobile surface unreachable.** `--native` / `mobile-adversary` are wired but cannot fire: no `mobile` member in the `surface` enum and no native build agent shortlisted. Add `mobile` to §6.5 and re-admit `expo-react-native-expert` when the ticket space includes apps.

---

## 16. The grader — the component that replaces the owner

**Owner framing, 2026-07-28:** *"I would rather just build it and walk away, or have it run on cron. Key is to have this self-improving and managing itself with little to no need for me to do anything."*

That reframes the whole project. **The canvas is the window; the grader is the engine.**

### 16.1 Why the grader is the load-bearing component

Today the owner is the grader: they look at the output and decide. **The moment they walk away, that job is vacant.** If nothing fills it, the system tells itself it succeeded.

```
owner watching:  agent says done -> owner checks    -> owner decides
owner away:      agent says done -> nothing checks  -> a broken artefact with
                                                       a confident summary
```

On cron this compounds — every scheduled run accumulates another confidently-wrong result.
`falseFinish` is precisely the name for this failure: *declared done while it wasn't.*

**A grader is also the precondition for self-improvement.** A system cannot improve without a
signal to improve against. `heldOutPass` and `falseFinish` are that signal; the GATE/FIX loop is
what consumes it. Without a grader, "self-managing" means "doing more things and hoping."

### 16.2 What the grader must satisfy

| Property | How it is met |
|---|---|
| **Ungameable** | Written before any code exists, frozen by content digest, half held out, executed in a `--network=none` container against a staged copy with `.git`/`.bakeoff` stripped. The builder cannot read it — Phases 0/0.1/0.2 exist for this. |
| **Tests the right thing** | A suite that passes on a broken site is worthless. The spec seat's output is audited against a bad-test checklist before it is frozen. |
| **Covers what unit tests cannot** | Visual and motion quality are not unit-testable. The visual gate compares screenshots against the **locked** design reference (§17). |
| **Encodes the owner's taste** | Not generic quality — *their* bar. Sources: the taste skills, `impeccable/reference/craft-floor.md`, and the design the owner locked in. |
| **Explains itself** | A failure must say what failed and why, or an unattended run produces an unactionable "no". |

### 16.3 The self-managing loop

```
build -> gate -> FAIL -> triage by failure class -> fix -> re-gate
                          install/version  -> dependency-manager
                          test infra       -> test-automator
                          logic            -> debugger
                          structure        -> refactoring-specialist
      -> gate -> PASS -> done, recorded
      -> still failing after N rounds -> stop, write the backlog, report honestly
```

The bounded-retry exit matters as much as the loop: an unattended system that retries forever is
worse than one that stops and says why.

### 16.4 What is NOT promised

The system does **not** rewrite its own prompts, shortlist, or grader from outcome history. That is
a much later idea and possibly never. "Self-managing" here means the **within-run** correction loop
above plus a carried-forward backlog — which is what actually delivers "walk away and come back to
something that works, or a clear account of why it doesn't."

---

## 17. Design lock-in — the one place a human pause is worth it

**Owner request, 2026-07-28:** when the DESIGN lane returns 5 mockups, the owner can click one to
lock it in; otherwise the system chooses.

This is deliberately in tension with unattended operation, and the tension resolves cleanly: taste
is the one judgement worth pausing for, and it is **optional**.

### 17.1 The mechanism already exists

No new machinery. `ApiRunStatus` already includes **`awaiting_input`**, documented as a first-class
orchestrator state (`PAUSED-AWAITING-HUMAN`), and `POST /api/runs/:id/resume` already resumes a
parked run. The screenshots route already serves images by basename.

```
DESIGN lane produces design-refs/*.png + manifest.json
        |
        v
   status = awaiting_input        UI shows the 5 mockups as clickable cards
        |
   +----+---------------------------+
   |                                |
 owner clicks one            no owner (cron / timeout)
   |                                |
 POST /resume {chosenMockup}   ui-designer scores all 5 against the
   |                           brief and the taste rules, picks one,
   |                           and RECORDS why
   +----+---------------------------+
        v
   manifest.json gains  "locked": "<path>"
   BUILD builds to it · the visual gate grades against it
```

### 17.2 Why this makes the grader better, not weaker

Today §7.4's visual gate compares the built site against *five* mockups — against which one? A
locked reference turns a vague comparison into a precise one: **"does this match the design that was
chosen."** The lock-in feature is a grader improvement disguised as a UI feature.

### 17.3 Rules

1. **Never blocks indefinitely.** `DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN` (default: pick a sane finite
   value, not infinity). On timeout, auto-select and record that it was automatic.
2. **Cron runs auto-select by default.** A scheduled run that parks forever waiting for a click is
   the exact failure unattended operation exists to avoid. `POST /api/runs` accepts
   `designLock: "auto" | "ask"`, defaulting to `auto` when the request is not interactive.
3. **The auto-chooser is `ui-designer`, not `taste-frontend-expert`.** The author must not pick its
   own favourite — same independence rule as the visual gate (§7.4).
4. **The choice is recorded either way**, with who made it and why. An unattended run must be
   explainable after the fact.
5. **A locked design is an input to the gate**, so it is recorded in the run record alongside the
   ticket — the same "no unrecorded input" rule as §6.2.

---

## 15. Context management — why delegation is load-bearing beyond the canvas

**The failure mode this section exists to prevent:** a portfolio build touches design, frontend,
backend and database. In one session that is more than any context window holds. When it fills,
the SDK compacts — which is lossy — and the orchestrator starts forgetting decisions it made an
hour ago. **The run does not fail. It quietly gets worse.** An end-to-end pipeline that degrades
silently is worse than one that stops, because nothing tells you the output is no longer trustworthy.

Delegation is not only how the canvas gets a graph. **It is the primary context-compression
mechanism**, and the design has to treat it that way.

### 15.1 The four mechanisms, in order of leverage

**1. Delegation compresses by construction.** A subagent runs in its **own context window**. It
may make fifty tool calls, read twenty files and write ten — the parent sees only the final report.
That is a 50:1 compression the architecture gets for free, and it is the entire reason a long build
is feasible at all.

This only holds **if reports stay small**. A subagent that returns 8k tokens of narration hands the
problem straight back. Every `AgentDefinition.prompt` must demand a compact structured report:
what changed, which files, what the next lane needs, what is unresolved. Nothing else.

**2. `forwardSubagentText` does not cost parent context.** Verified from the typings: it forwards
subagent text "so **consumers** can render a nested transcript" — consumer meaning the SDK host,
i.e. our canvas. It widens the **message stream we observe**, not the model's context. So the
click-a-node transcript is free with respect to the thing under pressure.

**3. The filesystem is the context bus.** Lanes hand off through **artifacts, not conversation**:

```
SPEC    -> spec.md, visible-acceptance/
DESIGN  -> design-refs/*.png + manifest.json
BUILD   -> the workspace itself
REVIEW  -> review/visual-gate.md, review/findings.md
GATE    -> results/, backlog.md
```

A later lane reads **only what it needs**, by absolute path injected into its prompt. This is
already the DESIGN→BUILD mechanism in §7.3 — §15 generalises it to every boundary. Artifacts also
survive compaction, which conversation does not.

**4. Bound each agent.** Per-agent `maxTurns` and `effort` (spec §11 item 3). An unbounded lens
consumes the run's budget before GATE/FIX starts.

### 15.2 Make degradation visible, not silent

The SDK exposes everything needed to stop this being invisible:

| Surface | Use |
|---|---|
| `Query.getContextUsage()` | live per-category token counts — poll it, render it |
| `SDKCompactBoundaryMessage` | a compaction **happened** — mark it on the canvas timeline |
| `PreCompact` / `PostCompact` hooks | fires before/after, with attribution |
| `SDKStatus: 'compacting'` | the session is compacting right now |
| `autoCompactThreshold`, `autoCompactWindow`, `autoCompactEnabled` | tunable, not fixed |

**A compaction boundary is a first-class canvas event.** When you look at a run that produced
mediocre output, "the context compacted three times during BUILD" is the explanation, and it should
be on screen rather than buried. Add `graph_compaction` to the event union alongside the seven in
§9.1.

### 15.3 The single-session tradeoff, revisited honestly

§6.1 chose **one `query()` for the whole build** because it yields real `parent_tool_use_id` edges
rather than edges our code invents. That decision stands — but it does mean **one context for the
whole build phase**, and this section is the mitigation.

If a real portfolio build still degrades after 15.1 is implemented, the escape hatch is
**one `query()` per lane** (spec approach B, §"Lane-per-query"): a fresh context per lane, bought
at the cost of fabricated cross-lane edges and surgery on the single-`sessionId` resume path.

**Do not pre-emptively switch.** Instrument first (15.2), run a real portfolio ticket, and look at
where the context actually goes. Switching costs the canvas's honesty claim; do it on evidence, not
on the fear of a problem the compression may already solve.

### 15.4 What Phase 1 must therefore include

1. Report-shape discipline in every generated `AgentDefinition.prompt`.
2. Per-agent `maxTurns` and `effort`.
3. `getContextUsage()` sampled at lane boundaries, logged with the run.
4. Compaction observed and persisted, so a degraded run is explainable after the fact.

Items 1 and 2 are cheap and belong in Phase 1. Items 3 and 4 are instrumentation and may land with
the canvas in Phase 3 — but the **data must be captured from Phase 1**, or the first long build is
unexplainable.

---

## 14. Codex — out of scope, and what was learned

**Owner decision 2026-07-28: Claude only.** Codex stays in the tree as working code but is not a
selectable provider for orchestration runs. Recorded here rather than dropped (CLAUDE.md rule 7),
because the findings were expensive to obtain and the decision may reverse.

### What was verified (zero-auth, on codex 0.145.0)

**Codex CAN enforce the sealed-read boundary, and more strongly than Claude.**
`CodexOptions.config` flattens an arbitrary object into `--config key=value`, reaching the whole
`config.toml` surface — so the `codex-builder.ts` header claim that there is "no mechanism
equivalent to `sandbox.filesystem.denyRead`" is **false**. It is true of `ThreadOptions` only.

```
permissions.sealed.extends    = ":workspace"      # REQUIRED — omitting it SIGABRTs, exit 134,
permissions.sealed.filesystem = { "<sealed>" = "none" }   # empty stdout AND stderr
default_permissions           = "sealed"

cat  <sealed>/x   ->  Operation not permitted     # kernel/seatbelt EPERM
grep -r X <sealed> -> Operation not permitted
```

This covers **Bash and every subprocess** — precisely the hole Claude documents at
`claude-builder.ts:120-125`, where `autoAllowBashIfSandboxed: true` means a sandboxed command
never reaches `canUseTool`.

### The finding that inverted the premise

> **Claude delegates ZERO today** — `claude-builder.ts:435` sets `allowedAgents = []`, so every
> Agent/Task call is denied. **Codex delegates BY DEFAULT** on `gpt-5.6-sol`, invisibly, and
> **cannot be switched off by config** — four documented switches were tried and all failed.

The comparability risk therefore ran opposite to the assumption: not "Codex lacks delegation" but
"Codex delegates when Claude cannot, and you can neither see nor stop it." The correct move was
always to **restrict** Codex, not to build delegation for it.

**Delegation is welded to model identity** — `multi_agent_version` is a per-model catalog
property: `sol`/`terra` = v2, `luna` = v1, `gpt-5.5`/`5.4`/`5.2` = None. So `sol vs gpt-5.5` is an
*architecture* comparison wearing a model's name, not a model comparison.

### Why parity was only PARTIAL

| Gap | Detail |
|---|---|
| No `canUseTool` equivalent | The SDK writes the prompt then **closes stdin** (`index.js:262-263`), so `approvalPolicy:"on-request"` has no back-channel |
| Sub-agent activity invisible | SDK event vocabulary is closed — 8 events, 8 item types, **zero agent identity**. A 6-agent Codex run would render as **one node, no edges** |
| Sub-agent policy inheritance | **UNVERIFIED.** The preflight proves the *root* agent's policy only |
| Background-by-default | No forcing switch, and all agents share one working directory — a parent turn can return while a child still writes |
| Hooks unusable as a boundary | Gated by `HookStateToml{enabled, trusted_hash}`; the only bypass is a CLI flag the SDK never passes |

### Two landmines, if this is ever revisited

1. **A sealed path containing a `.` SILENTLY FAILS OPEN.** The SDK flattener builds unquoted
   dotted keys (`index.js:335`), so the override never lands. Today's roots are dot-free, but
   `dashboard/results/scorer-out` does not exist on disk yet — assert this in a negative control.
2. **Omitting `extends=":workspace"`** produces a silent `SIGABRT` (exit 134) with empty stdout
   *and* stderr. Unmissable in production, invisible in a log.

### If reversed, do this

1. `codex login` — the machine is **not authenticated** (`codex login status` = "Not logged in").
2. Restrict to `multi_agent_version: None` models for a clean comparison.
3. Surface `multi_agent_version` in the model picker so delegation classes are never mixed.
4. Accept a degraded Codex canvas, or fund the app-server integration separately. **Never let a
   blank Codex hook/skill lane read as "Codex ran no hooks".**

---

## 13. Scope note

This spec covers six phases and is **too large for a single implementation plan**. Plan it per phase, in the §12 order. Phase 0 in particular should land and be verified on its own — it is a security fix to live code, it is independently valuable, and it is a precondition for everything after it. Phases 1-3 can then be planned as a unit or individually.

---

## 12. Implementation order

**REORDERED 2026-07-28** after the owner's "build it and walk away, ideally on cron" framing. The
canvas is the window; the **grader and the fix loop are the engine**. Unattended operation depends
on GATE/FIX being trustworthy, and not at all on the canvas existing.

```
Phase 0    held-out boundary fix + results leak        DONE — ships and verified ALONE
Phase 0.5  canary probe                                 DONE — denyRead proven, incl. subagents
Phase 1    delegation: environment, shortlist, bounds, context discipline
Phase 2a   anti-slop hooks (Layers 1-2)                 self-correction at WRITE time
Phase 2b   DESIGN lane — stills + design lock-in (§17)
Phase 2d   GATE/FIX loop + /debugfix port               <-- MOVED UP. The walk-away enabler.
Phase 2c   image→video (Veo 3.1) + scroll-scrub satisfier
Phase 3    event contract + canvas                      <-- MOVED DOWN. The window, not the engine.
Phase 4    cron / scheduled tickets                     only once GATE/FIX is trustworthy
```

**Why 2d moved ahead of 2c and 3.** The owner's goal is to submit a ticket and leave. What makes
that safe is: something independent grades the result (§16), failures get triaged and fixed without
a human, and the loop stops honestly when it cannot. Video and the canvas are both valuable and
neither is on that path.

**Why cron is Phase 4 and not sooner.** `POST /api/runs` already exists, so scheduling is a handful
of lines — but **cron plus an untrustworthy gate is automated disappointment**, accumulating
confidently-wrong builds nobody reads. Schedule only after the gate loop has earned it.

**Phase 0 ships alone**, on the owner's explicit instruction. It is a security fix to code running today, it is independently valuable, and it is a precondition for decision #7.

**Hooks land before the DESIGN lane, not after.** The Layer-1 ruleset comes from `craft-floor.md`, which is independent of anything DESIGN produces — so sequencing hooks first means the very first DESIGN-fed build is already gated, at no extra cost.

**2c after 2b, not merged with it.** 2b proves the still pipeline, the manifest and the handoff end to end. 2c adds one script plus a consumption pattern on top of a working lane; merged, a failure in either is hard to attribute — and Veo calls are materially more expensive to debug against.

Phase 0 is not sequenced first out of caution. There is an **executed bypass open today**, and N specialists doing broad repo search make hitting it near-certain.
