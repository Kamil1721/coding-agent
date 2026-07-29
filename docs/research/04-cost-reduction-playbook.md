# Cost-Per-Ticket Playbook — Autonomous Coding Agent

> **How to read this.** Every figure is per **completed ticket**, at Anthropic list prices verified live on 2026-07-27. `[uncertain]` = not established by a primary source or not measurable without your own telemetry; do not build a load-bearing decision on it. Where a claim is vendor-asserted with no published benchmark, it says so.
>
> **Provenance.** Verification inherited from the adversarial re-fetch of 2026-07-27; this synthesis fetched nothing new. The one item flagged as un-re-verified is Sonnet 5's absence from the tool-search compatibility table (§5.4a) — check it before architecting around it.
>
> **Pricing convention, stated once.** All sensitivity figures use the owner's original convention: the 15% cache-miss slice priced at **1.0x** base input. That reproduces his own anchors and keeps this document comparable to his existing model. The true baseline is a **$65–$70 band** — see §0.2. §10 is the only section that switches to the write-corrected convention, and it compares like-for-like there.

---

## 0. THE BASELINE, CORRECTED

### 0.1 The model reproduces to the cent — and its mechanism is stronger than stated

Solving the owner's own figures for the model blend: **28.0% of input tokens** and **22.0% of output tokens** run on Opus 5, the rest on Sonnet 5. Two independently derived splits both land near one quarter of traffic on the orchestrator, and `$31.72 + $33.25 = $64.97`. The model is internally coherent.

| Quantity | Value |
|---|---|
| Output share of token **volume** | **5.00%** (2.5M / 50.0M) |
| Output share of the **bill** | **51.18%** ($33.25 / $64.97) |
| Effective input rate at h=0.85 | **$0.668 / MTok** |
| Effective output rate | **$13.30 / MTok** |
| Observed output:input cost ratio | **19.9x** |
| Structural single-model ratio | **21.28x** — identical for Opus 5, Sonnet 5 intro and Sonnet 5 post-September, because all three price output at exactly 5x input and cache-read at exactly 0.1x |

**The owner's mechanism attribution needs one correction, and it is the part that determines where to aim.** He attributes output's half-share to "5x price AND uncacheable." Both true; the weights are wildly unequal:

- Volume ratio is 19:1 input:output. At 5x list with **no** caching, output would be `5/(5+19)` = **20.8%** of the bill.
- 85% caching divides the effective input price by 4.26, taking the per-token ratio to 21.3x → output = **52.9%** single-model, 51.2% at his blend.

**The 5x multiple gets you to ~21%. Caching carries it from 21% to 51%.** Output's share of the bill is a *function of cache success*, not a fixed property of the workload. Consequence: cache work and output work are complements, not competitors — every point of cache improvement raises the dollar value of every output-token intervention.

| Cache hit rate | Output:input cost ratio | Output share of bill |
|---|---|---|
| 0% | 5.0x | ~21% |
| 50% | 9.1x | ~32% |
| 85% | 21.3x | **~51%** |
| 95% | 34.5x | ~64% |

### 0.2 Two defects in the stated baseline

**(a) The 0%-caching anchor is wrong.** Deriving the blended base input rate from the 85% point gives **B = $2.842/MTok**, so `I(h) = 135.0 × (1 − 0.9h)`:

| Hit rate | Input | Total | Owner stated |
|---|---|---|---|
| 85% | $31.72 | **$64.97** | $65 ✓ |
| 50% | $74.25 | **$107.50** | $108 ✓ |
| 0% | $135.00 | **$168.25** | ~~$155~~ ✗ |

The 0% figure is **understated by ~$13 (8%)**. This *strengthens* the caching case: the true 0%→85% spread is **$103, not $90**.

**Marginal value of cache hit rate: `dI/dh = −$121.50`, i.e. $1.215 per percentage point.** 50→85% = $42.53. 85→92% = $8.51. 85→95% = $12.15.

**(b) The input line should be a band, not a point.** The model prices the 15% non-read slice at 1.0x; a 5-minute cache write actually bills at **1.25x**. If the entire non-read slice is writes, the multiplier is `0.85(0.1) + 0.15(1.25) = 0.2725`, input becomes **$36.79** and the total **$70.04**.

Which applies is a harness decision: **with a rolling breakpoint on the growing tail, most of that slice IS cache writes (→ ~$70); with only a static prefix breakpoint, the tail is simply uncached at 1.0x (→ ~$65).** The recommended layout in §3 uses rolling breakpoints, so plan on ~$70. Note the direction: this correction makes output a *smaller* share (47.5%), not larger. The headline survives either way — **output is 47.5–51% of the bill on 5% of volume.**

### 0.3 The $65–$140 envelope, decoded

| Corner | Assumptions | Per ticket |
|---|---|---|
| **$65** | intro rates, 85% hit, non-read slice at 1.0x, no retries | $64.97 |
| **$70** | intro rates, 85% hit, non-read slice at 1.25x (rolling breakpoints), no retries | $70.04 |
| **$83** | post-2026-09-01 Sonnet 5 at $3/$15, 85% hit, 1.0x slice, no retries | $82.74 |
| **$98** | intro rates, write-corrected, **1.4x retry multiplier** | $98.06 |
| **$134** | post-September, write-corrected, **1.5x retry multiplier** | $133.6 |

**The 1.3–1.5x retry multiplier is worth $19.49–$32.49 per ticket of pure waste** on the $65 base. That exceeds the realistic yield of every compression technique in this document combined. It is also the least attacked.

**Post-September restatement (5 weeks out, verified and dated):** holding the blend, input $39.74 + output $43.00 = **$82.74**, output share **52.0%**. The framing claim survives the price change unchanged; the bill rises ~27%.

---

## 1. THE RANKED PLAYBOOK

Ordered by expected dollars saved per completed ticket, marginal against status quo at intro rates, **holding everything else fixed**. Build-order column reflects effort-adjusted sequencing — do the trivial rows in week one regardless of rank.

**These rows do not sum.** The four knobs are multiplicative: `Total = [V × B × M(h)] + [output_volume × $13.30]`, all `× R`. A 30% volume cut plus a cache improvement from 0.2725→0.192 is not 30% + 29.5% = 59.5%; it is `0.70 × 0.705` = **50.7%**. Naive addition overstates by ~9 points. The single composed figure is in §10.

| # | Technique | Saving ($ / % of $65) | Evidence | Quality risk | Eng cost | Model-independent | Build |
|---|---|---|---|---|---|---|---|
| 1 | **Cut the retry multiplier 1.4→1.2x** — out-of-process loop/plateau detector, hard per-ticket dollar ceiling, end-to-end verification gate before marking a feature complete, `feature_list.json` + git commits as recovery points | **$13.00** (range $6.50–19.50) / 14% of effective bill | Prize **measured** (arithmetic on the owner's own multiplier); efficacy of any specific fix **unevidenced**. The one measured result says what NOT to do | None — positive | HIGH | Yes | 2 |
| 2 | **Cache hygiene: hold 92%+ hit rate** — breakpoint discipline, byte-stable prefix, canonical JSON, frozen params (§3) | **+$8.51** (85→92) / 13%. Plus **$42–103 downside protection** against a silent regression | **Measured** (documented mechanics + own derivation) | **NONE** — byte-identical tokens reach the model | MED | No (Anthropic-specific spec; principle universal) | **1** |
| 3 | **Tool-output governor** — hard caps on every tool result, full artefact to disk, return `preview + path + truncation notice`; failure-only test reporting | **$6–11** / 9–17% | Mechanism vendor-documented; **saving asserted, never measured** by anyone | LOW if the path is returned. **HIGH for naive failure-only filtering** (see §5) | LOW–MED | Yes | **1** |
| 4 | **Output verbosity discipline** — conciseness + narration-cadence + document-length instructions, static, inside the cached prefix | **$2–7** / 3–11% | Vendor wording **asserted-credible**; the 65–75% headline is **folklore** (§6) | LOW for an unattended run — nobody reads the narration | TRIVIAL | Partly (wording is Opus 5-specific) | **1** |
| 5 | **Delete verification / self-check instructions + cap delegation** (Opus 5) | **$2–6** / 3–9% | **Asserted** — vendor states "no loss in quality," no published benchmark | Vendor says none. Audit what your harness parses first | TRIVIAL | No (Opus 5-specific) | **1** |
| 6 | **Effort topology per role** — mechanical turns (triage, dispatch, formatting, log classification) to *separate* low-effort threads | **$2–6** / 3–9% | Asserted + independent **measured** inverted-U on length/accuracy | **HIGH if applied to the orchestrator** — 250-Elo spread from effort alone on Opus 5 | LOW + eval | No | 3 |
| 7 | **Context editing / observation masking (evict sooner)** — clear big, clear rarely | **$2–7** / 3–11% `[uncertain]` | **Measured** on non-Anthropic pricing; the dollar result does **not** transfer | Measured **−4.0pp solve rate** (p=0.04) on the one cache-aware thinking-enabled config | LOW | Yes | 3 |
| 8 | **`clear_thinking` on subagent threads** — thinking is retained and re-billed as input on Opus 5 / Sonnet 5 | **$1–5** / 2–8% `[uncertain]` | Mechanism **measured**; share of context **unmeasured** | **Unknown** — Anthropic ships keep-all as the default on these models | LOW | No | 3 |
| 9 | **Concise tool response formats** — drop timestamps/nulls/display names, compact JSON, CSV for flat tabular, kill pretty XML | **$1–4** / 2–6% | **Measured** (vendor worked example 206→72 tokens; two independent practitioner benchmarks) | LOW if you keep chaining identifiers | TRIVIAL | Yes | **1** |
| 10 | **Subagent digest contract** — fixed schema (findings, paths, line numbers, verdict) + a verifiable filesystem artefact, never free prose | **$1–4** / 2–6% | **Asserted** (vendor architecture guidance) | Guards *against* blindness; the digest boundary is lossy by construction | MED | Yes | 2 |
| 11 | **1-hour cache TTL** | **$0–8** / 0–12% `[uncertain — conditional]` | Mechanics **measured**; the trigger condition **unmeasured by anyone** | NONE | TRIVIAL (one field) | No | 2, **after** telemetry |
| 12 | **Tool search / `defer_loading`** | **$0–3** / 0–5% `[uncertain]` — was $8.9 if you carry a 55k tool surface, ~$0 if you carry ten hand-written tools | **Measured** (vendor internal eval, unreproduced) | **Positive** — tool-selection accuracy rises. The rare both-axes win | LOW | No | 2 |
| 13 | **Cache pre-warming (`max_tokens: 0`) before same-role fan-out** | **$0.5–3** / 1–5% | **Measured** mechanic; the wave count is an assumption | NONE | LOW | No | 2 |
| 14 | **Programmatic tool calling / code-as-orchestration** | **$0–6** / 0–9% `[uncertain]` | **Measured** (vendor, unreproduced): 43,588→27,297 tokens, accuracy up. But the sibling feature's **price-weighted cost ROSE on Opus** | Accuracy measured up; silent filter bugs are invisible | HIGH (sandbox) | No | 4 |
| 15 | **Repo map / ranked structural index instead of speculative reads** | **$0–3** / 0–5% `[uncertain]` | Mechanism documented; **zero published token or accuracy measurement** | LOW | MED | Yes | 4 — poor fit for greenfield |

**Row 1 needs a split confidence and the owner should read it that way.** The *size of the prize* ($19.50–$32.50) is measured arithmetic from his own multiplier. The *efficacy of any specific fix* has **no published measurement**. The only measured result bearing on it is a warning about the obvious fix: LLM summarisation **lengthened** mean trajectories 15% (52 turns vs 44) because summaries "mask signs of a failing trajectory, encouraging the agent to persist in unproductive loops," and adding a critic to the summariser made elongation **worse** with **no** solve-rate gain. Build a detector *outside* the agent; do not expect a smarter summary to help.

---

## 2. THE FREE WINS — do these in week one

Six items. Total engineering: roughly one week. Combined marginal value: **$12–25/ticket**, at zero or near-zero quality risk.

### 2.1 Delete over-verification instructions (Opus 5) — trivial, vendor-asserted free

Anthropic's Opus 5 prompting guide, verbatim: *"Claude Opus 5 verifies its own work without being told to. If your prompt contains explicit verification instructions … remove them: instructions like these cause over-verification on Claude Opus 5, and removing them reduces wasted tokens with no loss in quality. The same applies to legacy harness scaffolding that adds separate verification steps."* And: *"Avoid instructing re-checks it already performs ('double-check your answer,' 're-verify before responding'); … these compound with the model's own behavior and add cost without improving results."*

**Do:** grep every Opus 5 system prompt for `verify`, `double-check`, `re-check`, `confirm before`, `final verification step`, `use a subagent to verify`. Delete them. Then add the vendor's delegation cap — Opus 5 *"delegates to subagents more readily than prior models"* and the recommended instruction includes **"do not use subagents to verify or double-check your own work."** Each avoided subagent is a whole conversation, not a few tokens.

**Caveat:** "no loss in quality" is a vendor assertion with no published benchmark. But it is a claim of a *strictly free* saving, so the downside of testing it is bounded. **Audit what your orchestrator parses from the model's narration before you suppress narration.**

### 2.2 Three conciseness instructions, static, inside the cached prefix

Anthropic states Opus 5's *"default user-facing responses run longer than prior Opus models'"*, that it *"narrates readily"*, and that files it writes to disk *"are often longer than on prior models."* Add all three of the vendor's supplied instructions: (a) response conciseness, (b) narration cadence, (c) written-document length calibration. Pair with a short `<tone_preference>` reminder near the **end** of a long system prompt. Prefer *positive examples of the style you want* over lists of bans.

**Hard constraint:** this block must be **byte-identical every call and live inside the cached prefix**. Rotating it per call destroys more in cache invalidation than it saves. And it must not push any cacheable prefix below the minimum length (§6.2).

### 2.3 Kill pretty XML; use compact JSON; CSV for flat tabular

The folklore here is backwards. Two independent practitioner benchmarks agree: **YAML uses ~19% MORE tokens than JSON** (and scored worse on accuracy), TOML ~44% more, **pretty XML ~2.6x compact JSON for no accuracy benefit**, and CSV ~44% fewer tokens than JSON at near-equal accuracy on flat tabular data. Do not "switch to YAML to save tokens." Re-measure on Opus 5 — Claude 4.7+ uses a newer tokenizer producing *"approximately 30% more tokens for the same text."*

### 2.4 A `response_format` enum on every tool, defaulting to CONCISE

Vendor worked example: detailed response 206 tokens → concise 72 tokens, **~66% cut**, *"while maintaining functionality for downstream tool calls."* Keep every identifier the agent needs to chain a follow-up (IDs, paths, line numbers); drop only decoration (timestamps, nulls, display names, MIME types, ETags). Highest saving-per-engineering-hour item for a bespoke harness, because it applies to every tool you write.

### 2.5 The universal tool-result governor

Cap every tool result, write the full artefact to disk, return `preview + path + explicit truncation notice`. **You inherit none of this from the raw Messages API** — these are Claude Code product behaviours. Copy its constants as a starting point:

| Guard | Value to copy |
|---|---|
| Bash / shell output | 30,000 chars → spill to file + preview + path; hard ceiling 150,000 |
| Any tool result | 25,000 tokens |
| Warn threshold | 10,000 tokens |
| File read | paginate with an explicit `PARTIAL view` notice and `offset`/`limit` |
| Glob / file listing | cap at 100 with a truncation flag **the model can see** |
| Hook output | 10,000 chars → spill to file + preview + path |

The truncation notice is load-bearing: an agent that does not *know* it was truncated will reason as if it saw everything.

### 2.6 Cache pre-warming before same-role fan-out

*"A cache entry only becomes available after the first response begins."* Naive concurrent fan-out of N instances of the same subagent role pays **N cold writes**. Fire one `max_tokens: 0` request, await it, then dispatch all N. Zero output tokens are billed. Two gotchas that silently defeat it: put `cache_control` on the **shared** system/tools block, not on the placeholder user message; and use the **identical** thinking config and `output_config.effort` as the real calls.

Worked example (6 concurrent instances, 30k shared prefix, Sonnet 5 intro): naive = 6 cold writes = $0.45/wave; pre-warmed = 1 write + 6 reads = $0.111/wave, **~75% off that prefix**. Scope limit: this only pays for N instances of the **same role**. Different specialist roles share no prefix and each writes once regardless.

`max_tokens: 0` is rejected with `stream: true`, extended thinking enabled, structured outputs, `tool_choice` type `tool`/`any`, and inside Message Batches.

---

## 3. CACHING: THE ENGINEERING SPEC

### 3.1 Verified mechanics

| Item | Value |
|---|---|
| 5-minute cache write | **1.25x** base input |
| 1-hour cache write | **2.0x** base input |
| Cache read | **0.1x** base input |
| Max explicit breakpoints | **4** (and if all 4 are explicit block-level, the API returns **400** because no slot is left for automatic caching) |
| Minimum cacheable prefix | **512 tokens on Opus 5**; **1,024 on Sonnet 5** |
| Lookback window | **20 blocks per breakpoint**, counting the breakpoint itself as the first |
| Render/invalidation hierarchy | `tools → system → messages`; a change at any level invalidates that level and everything after |
| TTL refresh | **A cache read refreshes the TTL for free.** *"The cache is refreshed for no additional cost each time the cached content is used."* |

**The TTL fact changes a top-3 recommendation.** Turn count and run duration are **irrelevant** — only **idle time** expires a cache. A 5-minute TTL survives a 5-hour, 680-call run indefinitely provided no gap between consecutive calls on that thread exceeds 5 minutes.

So `ttl: '1h'` is **not** a default; it is **insurance against tool-execution stalls** (npm install, docker build, full test suite, rate-limit backoff). The break-even is unchanged — a 2.0x write beats repeated 1.25x writes above **1.6 rewrites** — but it is now conditional on a measurement nobody has taken. **`[uncertain]` — no published measurement of tool-gap distributions in autonomous coding agents exists.** Log the wall-clock delta between consecutive calls per thread, plot the tail, then decide. Do not buy the 2.0x premium on a hypothesis.

### 3.2 The prompt layout

Order strictly by rate of change.

```
LAYER 1  tools array — FIXED order, input_schema through a canonical
         JSON encoder with SORTED KEYS. Never varies for the life of the ticket.
LAYER 2  system prompt — a FROZEN CONSTANT. No ticket ID, no timestamp,
         no repo path, no user name, no decrementing budget counter,
         no conditional sections.
  >>>>>  BREAKPOINT #1  (on the last NON-DEFERRED tool, or the system prompt)
LAYER 3  per-ticket context (ticket text, repo tree, standards) as the
         FIRST user message. Set once, then frozen.
LAYER 4  conversation history — APPEND-ONLY. Never edited, truncated,
         reordered or re-serialised.
  >>>>>  BREAKPOINTS #2, #3, #4 roll here at the last three turn boundaries
```

**Budget the four breakpoints explicitly.** This is the conflict no single lens caught, because each proposed its own layout in isolation: one layout wants all four for TTL tiers; defeating the 20-block lookback wants 2–4; observation masking wants one at the mask boundary; and tool search constrains *where* the prefix breakpoint may sit. **Adopting every "pure win" as specified is not possible.**

Resolution: **1 pinned prefix breakpoint + 3 rolling trailing breakpoints.** Anything else (mask boundary, separate per-ticket-context block, a second TTL tier) must *displace* one of those four, and the displacement must be costed.

**Why three rolling, not one.** N parallel tool calls emit **2N content blocks** in one turn, so **N ≥ 10 parallel calls crosses the 20-block lookback** and the trailing breakpoint finds nothing — a total miss on the whole history. Anthropic's own worked example documents it: *"Turn 3: 35 blocks, breakpoint on block 35. The system checks 20 positions (blocks 35 through 16) and finds nothing. The turn-2 entry at block 15 is one position outside the window, so there is no cache hit. Adding a second breakpoint at block 15 starts a second lookback window there, which finds the turn-2 entry."*

**Ordering rule:** entries with longer TTL must appear **before** shorter ones. The layout above satisfies this naturally.

**Do not rely on automatic caching.** It places the single breakpoint on the *last* block, which in an agent loop is the varying incoming block, and it defeats pre-warming entirely (the entry gets keyed to the placeholder message).

**Tool search constraint:** a tool with `defer_loading: true` **cannot** carry `cache_control` — the API returns **400**. Put breakpoint #1 on a non-deferred tool.

### 3.3 The audit checklist — what silently destroys hit rate

Grep the agent codebase for every one of these.

1. Any **timestamp, date, ticket ID, request ID, UUID, user name, session ID or run ID** interpolated anywhere **before** the last breakpoint.
2. A **decrementing token/step/budget counter** in the system prompt — the most seductive killer, because it changes every single turn. Move it to a trailing user block after all breakpoints.
3. **Conditional system-prompt sections** assembled per request (feature flags, dynamically included examples). Hoist all variants into one static prompt, or split into separate stable prefixes per role.
4. A **tool set that varies per request**. Tools added when "relevant" invalidate `tools + system + messages` — the *entire* cache. Ship the full fixed array every turn.
5. **JSON serialisation without sorted keys.** Anthropic explicitly names **Swift and Go** as randomising key order in `tool_use` blocks and "breaking caches." This produces an intermittent, near-undebuggable ~0% hit rate.
6. Anything that **edits, truncates, reorders or re-serialises earlier history.** Echo assistant content and `tool_result` blocks back **verbatim**.
7. **Adding or removing an image** anywhere (invalidates messages).
8. **Changing `tool_choice`** mid-conversation (invalidates messages).
9. **Changing `output_config.effort` or thinking configuration** mid-conversation (always invalidates messages). Note `effort: "high"` is byte-equivalent to omitting it on Opus 5, so it is safe to set explicitly.
10. **Splitting traffic across API workspaces** — caches are workspace-isolated on the Claude API. This silently halves your hit rate.
11. Any **A/B test, model router or fallback** that can swap models mid-conversation. The cache is per-model.
12. **`speed: "fast"`** set anywhere — it prices Opus 5 at $10/$50 and invalidates system + messages.
13. A cached segment **below the model minimum** (512 Opus 5 / 1,024 Sonnet 5). Fails **silently**, no error. Pad up to the threshold if a prefix falls just short.

### 3.4 How to measure hit rate in production

Three usage fields per response: `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`.

**The trap:** *"`input_tokens` … represents only the tokens that come AFTER the last cache breakpoint in your request — not all the input tokens you sent."*

```
total_input = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
hit_rate    = cache_read_input_tokens / total_input
```

With mixed TTLs, `cache_creation` breaks down into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.

**Log per call, tagged by model AND call class** — orchestrator turns, each subagent role, one-shot side calls. A global 85% hides which class is cold, and the levers differ per class.

**What a zero reading means.** If **both** `cache_creation_input_tokens` **and** `cache_read_input_tokens` are **0**, the prompt was **not cached at all**, almost certainly because it fell below the minimum cacheable length — *"Any requests to cache fewer than this number of tokens will be processed without caching, and no error is returned."* This is a **10x price increase on that block, invisible in every log except these two fields.** Alert on it.

**Root-cause a miss with the diagnostics beta.** Pass header `cache-diagnosis-2026-04-07` and `diagnostics.previous_message_id` = the prior response id. Returns a typed `cache_miss_reason` with `cache_missed_input_tokens`:

| Reason | Owner |
|---|---|
| `model_changed` | your router / A-B test / fallback |
| `system_changed` | a per-request value is being interpolated into the "frozen" prompt |
| `tools_changed` | tool ordering, or non-deterministic schema serialisation |
| `messages_changed` | something edits history instead of appending, or re-serialises tool results |
| `previous_message_not_found` | threading bug |
| `unavailable` | `tool_choice`, `thinking`, `context_management`, `output_config`, `output_format` or the set of active beta headers differs |

**Read it with the 2x2:** `diagnostics == null` **and** cache reads low/zero means your requests **match** but the entry **expired** — that is a **TTL problem, not a prefix-stability problem**, and the fix is `ttl: '1h'`, not more byte-stability work.

Limitations: **Claude API only — not available on Amazon Bedrock or Google Cloud.** Do not architect around a Bedrock deployment if you want this. Beta; gate behind a flag.

**Second-order benefit worth planning capacity around:** `cache_read_input_tokens` do **not** count toward ITPM rate limits on Opus 5 or Sonnet 5. With a 2,000,000 ITPM limit and an 80% hit rate you can effectively process 10,000,000 total input tokens per minute.

### 3.5 The one architectural fix most teams miss: forked side calls

Summarisers, reviewers and compaction passes are the classic cold-write offenders — they get a bespoke system prompt and a repackaged history, share no prefix with the parent, and pay a **full cold write on a large context**.

Instead: issue the side call with the parent's **identical** tools array and **identical** system prompt, append the fork instruction as a **new trailing user message after the existing breakpoints**, and keep model/effort/thinking identical. The fork then reads the parent prefix at **0.1x** instead of writing it at 1.25x.

---

## 4. OUTPUT TOKENS

### 4.1 The corrected arithmetic

- Output is **5.00% of token volume** and **51.18% of the bill** ($33.25 / $64.97). **Confirmed.**
- Write-corrected: **47.5%** of the bill ($33.25 / $70.04). Still roughly half.
- Post-2026-09-01: **52.0%** ($43.00 / $82.74). **The claim survives the price change unchanged.**
- One output token costs **21.3 input tokens** at h=0.85, structurally, for every Claude model in the roster.
- **Caching, not the 5x multiple, is what makes output half the bill** (§0.1). This is why §3 comes before §4 in build order and why the two are complements.

### 4.2 What output actually consists of, and what each part costs

| Component | Compressible? | Notes |
|---|---|---|
| **Thinking / reasoning** | Only via `effort` | Billed as **output**. On Opus 5 and Sonnet 5 prior thinking blocks are **retained in context and re-billed as input on every subsequent turn** — so it is billed twice |
| **Code** | No | Compression = information loss |
| **Tool-call JSON** | No | Compression = malformed calls |
| **Narration / prose / preamble** | **Yes** | The only genuinely compressible share. This is what "caveman mode" attacks — and why 75% does not reproduce |

**Measure the split before optimising it:** `usage.output_tokens_details.thinking_tokens` reports exactly how many billed output tokens were internal reasoning. This single number tells you whether §4 is a $15/ticket lever or a $3 one.

**A consistency flag worth resolving first:** `47.5M / 680 = ~70k` input per call. With thinking blocks retained and re-billed as input over 680 calls, unbounded retention would blow far past that. Either the run already compacts, or the 47.5M figure assumes clearing that is not yet configured. One real run answers it.

### 4.3 Interventions, with the evidence on correctness

| Intervention | Saving | Does it harm correctness? |
|---|---|---|
| **Delete verification / self-check instructions** | $2–6 | Vendor: *"reduces wasted tokens with no loss in quality."* Asserted, no benchmark, but a claim of a strictly free saving |
| **Cap subagent delegation** | included above | Vendor: delegation *"multiplies cost and time when applied to small tasks."* Removes whole conversations, not tokens |
| **Conciseness + narration-cadence + document-length instructions** | $2–7 | Low for an unattended run. Independent reviewer found *"ultra mode occasionally drops edge cases"* and *"a small but real regression on tasks requiring nuanced explanations"* — so keep the **final user-facing report** readable |
| **Lower `effort` on mechanical subagent roles** | $2–6 | **Real risk, and level-dependent.** Independent work finds the length/accuracy curve is an **inverted U on code as well as maths** — reduction can be free or quality-*positive* up to a point, then collapses. Run a sweep per role |
| **`clear_thinking_20251015` on subagent threads** | $1–5 `[uncertain]` | **Unknown.** Anthropic ships **keep-all as the default** on Opus 4.5+/Sonnet 4.6+, a strong implicit signal that retained reasoning is valuable. Deviating from the default is the risky choice |
| **Diffs instead of whole-file rewrites** | Direction robust, magnitude stale | Measured **positive** on correctness in the only rigorous benchmark (lazy placeholder comments 12/89 → 4/89; score 20% → 61%) — but that is **GPT-4-era, 2023**, and the effect **inverts on weak models**. The real money is in a **forgiving patch applier**: disabling flexible patch application produced a **9x increase in editing errors** |

### 4.4 Four folklore corrections on reasoning tokens — all verified verbatim

1. **`effort` does NOT shorten visible output on Opus 5.** *"The effort parameter controls how much the model thinks rather than how much it says: lowering effort can reduce thinking volume without reliably shortening the visible response. To control response length, prompt for it explicitly."* **You need two separate controls.** Anyone lowering effort expecting shorter responses is mis-targeting.
2. **`thinking.display: "omitted"` saves nothing.** *"You are billed for the full thinking process, not the thinking content visible in the response."*
3. **Do not disable thinking to save money.** *"For most tasks, thinking enabled at low effort performs better than thinking disabled at similar cost."* With thinking disabled, Opus 5 *"occasionally writes a tool call into its user-facing text instead of emitting a structured `tool_use` block. The turn completes normally and the call never runs, and in agentic loops the leaked text stays in the conversation history, so later turns are affected as well."* For a 5-hour unattended loop that is a **direct retry-multiplier risk**, not a cosmetic one.
4. **Never `max` effort.** Vendor: on most workloads it *"adds significant cost for relatively small quality gains, and on some structured-output or less intelligence-sensitive tasks it can lead to overthinking."*

**And the one cut not to make:** on AA-Briefcase, holding everything constant and varying only `effort`, Opus 5 spans 1720 (max) → 1693 (xhigh) → 1606 (high) → **1470 (medium)**. Opus 5 at medium ranks **below** Fable 5 at max. **Do not turn the orchestrator down.** Route mechanical turns to separate low-effort threads instead — which is also what the cache constraint demands, since changing effort mid-conversation invalidates the messages cache. The cost constraint and the quality constraint happen to require the same topology.

---

## 5. TOOL OUTPUT AND CONTEXT

### 5.1 Two distinct levers — do not conflate them

`47.5M / 680 = ~70k` average context per call. **That 47.5M is already the sum of context sizes across calls** — it already includes re-reads. The *unique* tool-result bytes generated in a ticket are plausibly only 1–3M; the 47.5M is those bytes multiplied by how many turns each survives.

- **Lever A — emit less.** Caps, failure-only filtering, concise formats, ranged reads, subagent isolation. Reduces the **base**.
- **Lever B — evict sooner.** Context editing, `clear_tool_inputs`, observation masking. Reduces the **multiplier** without reducing what the agent sees *at the moment it needs it*.

Lever B is under-appreciated and is the closest to blindness-free, because the content was present when it mattered.

**Arithmetic that shows why carry cost dominates:** a 50k-token tool result surviving 200 subsequent turns on an Opus thread costs **$0.31** for the one cache write (`50k × 1.25 × $5/MTok`) and **$4.98** in cache reads (`50k × $0.50/MTok × 199`). **The write is a rounding error; the carry is 94% of the cost.** Evicting it after 20 turns instead of 200 saves ~$4.50 on that one result — which is why Lever B (evict sooner) is worth as much as Lever A (emit less).

### 5.2 Interventions ranked, with blindness stated

| Intervention | Est. input tokens saved | ~$ | **What the agent can no longer see** — and does it matter here? |
|---|---|---|---|
| **Subagent isolation of exploration / log reading / test runs** | 10–20M | $7–13 | The raw evidence behind the summary. Vendor's own example compresses 6,100 tokens of file reads to a 420-token return — **93% of the detail is gone**. *Matters:* the orchestrator cannot audit a "done" claim from a 1–2k digest. **Mitigation: pair every digest with a filesystem artefact (test output, git commit) the orchestrator verifies independently.** For a product promising "complete and TESTED," trusting the summary is the failure mode |
| **Context editing / `clear_tool_uses` (evict sooner)** | 8–20M | $5–13 gross, **$2–7 net** of cache-write cost | Nothing *at the time of use*; older results become placeholders so the model knows content was removed. *Matters little* for re-fetchable file reads; *matters* for one-shot API responses and long error traces. Use `exclude_tools` to pin the spec, acceptance criteria and memory |
| **Hard caps + file offload** | 3–10M | $2–7 | Only the tail, and only until the agent greps the file. **Lowest blindness in the table — provided the path is returned.** Truncation without a recovery path is total blindness for the discarded tail |
| **Failure-only test / build reporting** | 2–8M | $1.5–5 | Passing tests, and context around failures. **The highest blindness-per-token here.** A naive `grep -A 5 FAIL` cuts assertion diffs mid-way, `head -100` silently drops later failures, and failure-only output hides **which tests passed** (so the agent cannot tell a regression from a pre-existing failure), **timing/ordering signals that diagnose flakiness**, and **setup/teardown errors that don't match the pattern**. *For a product that "returns only when TESTED," a filter that hides a flaky test is a correctness bug shipped to the customer, not a context optimisation.* **Prefer structured reporters (JSON / JUnit XML parsed by your harness) over regex over human-readable output; cap per-failure detail, not per-run detail; keep the FIRST failure in full** |
| **Grep / glob + ranged reads instead of whole-file loads** | 3–8M | $2–5 | Code that is semantically relevant but lexically different (`refreshCredentials` when you grep `renewToken`). Measured cost of that blindness: **12.5% lower accuracy** for grep-only vs grep+semantic — but that result is strongest at **1,000+ files**, which a greenfield ticket will not reach |
| **`clear_tool_inputs: true`** | 1–4M | $0.7–3 | The **arguments** of old calls — which for a coding agent means **full file bodies on Write and full patch bodies on Edit**, frequently larger than the results they produce. The agent cannot recall exactly what it wrote without re-reading the file — which is cheap and reliable, so the trade is usually good. **Completely unmeasured; plausibly a top-three lever. Defaults to `false`. Measure it** |
| **Tool schema deferral** | 1–5M (fixed prefix, re-read every call) | $0–3 | Tools it never discovers. Vendor data says accuracy **rises**. See the Sonnet 5 caveat in §5.4 |

### 5.3 Context editing vs caching — the break-even, and why the defaults fail it

Clearing invalidates the cached prefix. Vendor, verbatim: *"Tool result clearing: Invalidates cached prompt prefixes when content is cleared. To account for this, clear enough tokens to make the cache invalidation worthwhile. Use the `clear_at_least` parameter … You'll incur cache write costs each time content is cleared."*

Closed form: **`N = (w − 1)(T/C) − w`** turns to break even, where `w` = cache-write/read ratio (**12.5** at 5m TTL, **20** at 1h), `T` = total context, `C` = tokens cleared.

| Fraction cleared | Break-even turns (5m TTL) | (1h TTL) |
|---|---|---|
| 33% | 22 | 37 |
| 50% | 10.5 | 18 |
| 80% | ~2 | ~4 |
| 92% | immediate | ~1 |

**THE RULE: CLEAR BIG, CLEAR RARELY.** Frequent small clears are a cost **increase** that reads as a saving on the token counter.

**Both the vendor default and the vendor cookbook fail this test.** The verified API default leaves `clear_at_least` **unset (None)**, so clearing can fire and invalidate the prefix for an arbitrarily small gain. The cookbook's suggested 15,000 against a 100,000 trigger is a `T/C` ratio of ~6.7 — needing **~64 turns at 5m TTL** to repay the invalidation. Both are tuned for **context-window survival, not for cost**. If cost is the objective, raise `clear_at_least` substantially.

**Preview before committing:** `/v1/messages/count_tokens` accepts `context_management` and returns `original_input_tokens` vs `input_tokens`.

**Ordering:** when combining strategies, `clear_thinking_20251015` must be listed **first**.

### 5.4 Three architecture-specific warnings

**(a) Tool search is not listed for Claude Sonnet 5. `[uncertain — verify before architecting]`** The model-compatibility table as rendered on 2026-07-27 lists Fable 5, Mythos 5, Opus 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Opus 4.5, Sonnet 4.5 and Haiku 4.5 — **Sonnet 5 is absent**. In this product the **subagents carry the tool surface and run on Sonnet 5**, while only the orchestrator runs Opus 5. If the omission is real rather than a docs lag, `defer_loading` is an **orchestrator-only** technique and the projected subagent saving is **zero**. I could not re-verify (no web access in this pass). Check it first.

**(b) Token-count your own tool surface before adopting tool search.** The 85% headline is computed against a ~55k-token five-MCP-server baseline. **Sanity check that settles it:** `47.5M / 680 = ~70k` average context, so a 55k tool block is implausible for this product. Assume the low end and the saving falls from ~$8.9/ticket to near zero. The vendor supplies the disqualifier itself: *"Standard tool calling, without tool search, is a better fit when you have fewer than 10 tools, every tool is used in every request, or your tool definitions are small (less than 100 tokens total)."* Also: **prefer CLI tools (`gh`, `aws`, `gcloud`) over MCP servers where a CLI exists — they add no per-tool listing at all.**

**(c) `defer_loading` controls context, not payload.** *"You still send every tool's full definition in the `tools` array on every request."* It does, however, preserve caching: *"the API excludes deferred tools from the system-prompt prefix … The prefix is untouched, so prompt caching is preserved."* That is the sharp contrast with context editing, which destroys the prefix.

### 5.5 The quality argument is currently unsettled — do not lean on it

Three lenses used the "context rot" study to argue smaller context is quality-positive. **It is a generation stale and directly contradicted by the vendor.** Chroma tested Claude Opus 4 / Sonnet 4 / GPT-4.1 / Gemini 2.5 / Qwen3 in **July 2025**, finding degradation *"well within stated context windows."* Anthropic's Opus 5 guide now states the opposite for the current model: *"Claude Opus 5 has a 1M token context window as both the default and the maximum, and its instruction following, tool calling, and reasoning stay consistent throughout the window."*

Neither claim is independently verified on 2026 frontier models. **The honest position: the magnitude of any long-context quality penalty on Opus 5 is UNKNOWN.** "Aggressive context management is quality-positive" is an untested hypothesis on this stack, not a settled result. Justify context work on **cost**, and measure quality yourself.

---

## 6. THE CAVEMAN QUESTION, ANSWERED

### 6.1 LEAD WITH THIS: compressing a prompt can cost MORE — by 5x

At 85% hit on Opus 5 the effective input multiplier is `0.85(0.1) + 0.15(1.25) = 0.2725x` base. **A scheme that makes the prefix VARY per call forfeits the cache entirely and pays 1.0x on `1/r` of the tokens. Break-even requires `r > 1/0.2725 = 3.67x` compression merely to draw level with doing nothing.**

Concretely:

| | Tokens | Cost per call (Opus 5) |
|---|---|---|
| Stable 100k prefix, cached | 100,000 | **$0.05** |
| Compressed 2x to 50k, **varying per call** | 50,000 | **$0.25** |

**A 5x price INCREASE for half the tokens.** LLMLingua-2's published range is **2–5x** — marginal at best before quality is considered. Independently corroborated: a July 2026 paper measured that query-aware compression *"mechanically invalidat[es] the prefix-strict cache on every call"* and only beats naive caching at **r ≥ 6**.

**The organising distinction that resolves the whole question:**

| | Cache-safe? | Yield |
|---|---|---|
| **STATIC rewrite** — caveman mode, terser system prompts. Byte-identical every call | **Yes** | **Low** |
| **DYNAMIC per-query compression** — LLMLingua and friends | **No — destroys the prefix** | High on paper, negative in practice |

### 6.2 The second, silent own-goal — and it targets *this* architecture specifically

Verified minimums: **512 tokens on Opus 5, 1,024 on Sonnet 5.** Verified failure mode: *"Shorter prompts cannot be cached, even if marked with `cache_control`. Any requests to cache fewer than this number of tokens will be processed without caching, and **no error is returned**."*

**Compressing a 1,200-token Sonnet 5 subagent system prompt down to ~600 tokens moves that block from 0.1x to 1.0x base input — a 10x price increase, invisible.** For a product built on a **fleet of small specialist subagent prompts running on Sonnet 5 against a 1,024-token floor**, this is a realistic own-goal caused by doing exactly what the caveman advice recommends. It appears in **no blog post or paper** found in any lens.

**Guardrail:** assert every intended-cacheable prefix exceeds the model minimum, and alert when `cache_creation_input_tokens` **and** `cache_read_input_tokens` are both zero.

### 6.3 Does the ~75% claim hold up? No. The provenance collapses.

The chain, traced end to end:

- The owner's ~75% figure originates at **nathanonn.com**, whose headline is ">75% on Usage" and whose **stated provenance is a Reddit post title** ("Taught Claude to talk like a caveman to use 75% less tokens") — **not a measurement**. Its own test is a **single contact-form validation task**. Its most dramatic sub-figure — 99% — is explicitly the *"reduction in the explanation wrapper"* (377 characters of prose → 5), and the post concedes *"The code is virtually identical in both cases."* **Nothing in the source chain measures 75% of anything.**
- **The decisive evidence against caveman is inside its own repo.** `drona23/claude-token-efficient` (5.9k stars) headlines **~63%** output reduction — but that is a **WORD count across FIVE prompts**. The **same repo** publishes a later reproducible benchmark measuring actual API output **TOKENS** and reports **~4% (Haiku), ~12% (Sonnet), ~7% (Opus)**. That is a **5–15x collapse between the word-count claim and the same project's own token-count claim.** The repo concedes its figures are *"directional indicators rather than statistically controlled studies."*
- `JuliusBrussee/caveman` (93.4k stars) claims **65% mean output-token reduction** across 10 prompts (range 22–87%) from real API counts, and is commendably honest in its own "Honest numbers warning" that this is **output tokens only** and that whole-session savings are smaller.
- Independent reviewer **andrew.ooo** (updated Jul 2026) measures **30–50%** output reduction in normal use, computes that as a **5–15% bill cut**, and reports that **"a one-line `be brief.` instruction captured most of the savings on its own"** and that **"a hand-rolled 6-line prompt outperformed the full Caveman skill on the quality/token tradeoff."**

**Verdict: the technique is real; the headline is inflated by measuring the wrong unit on a handful of prompts.** Measured values span 4–50% depending on who measured and what they counted — a ~10x disagreement.

### 6.4 The structural ceiling matters more than the inflated percentage

*"Caveman only affects output tokens — thinking/reasoning tokens are untouched."*

For this owner specifically the two effects pull in opposite directions:

- **Raises the ceiling:** output is **51% of the bill** here, not the 10–30% andrew.ooo assumed for a Claude Code session.
- **Lowers the ceiling, harder:** the compressible fraction is only the **prose share** of output. Thinking is untouched; code and tool-call JSON are incompressible without information loss.

**Realistic yield: 6–20% of output = $2–7/ticket = 3–10% of the bill.** That is the number to plan on.

### 6.5 Where it is safe, where it is harmful

**SAFE — do this:**
- Apply terseness to what the model **EMITS**, never to what it **READS**.
- Use the **one-line instruction**, plus Anthropic's own three conciseness instructions (§2.2). Skip the skill.
- Keep the block **byte-identical and inside the cached prefix**. Never rotate it per call.
- The run is unattended, so nobody reads the narration you are deleting. That is precisely why the quality risk is low *here* and higher in interactive use.

**HARMFUL — do not:**
- **Do not use "ultra" modes.** Documented: *"ultra mode occasionally drops edge cases"* and *"a small but real regression on tasks requiring nuanced explanations."*
- **Do not compress system prompts / instructions to save money.** The ceiling is **~4.5% of ticket cost** under a generous 20k-instruction-tokens-per-call assumption, realistically **1–3%**, because instructions are the most-cached and therefore cheapest tokens you own. It is not harmful — static rewrites are cache-safe — it is simply not worth the engineering time or the readability cost, and it risks §6.2.
- **Do not compress tool results, specs or acceptance criteria.** Dropped articles and connectives change meaning in ways that are invisible until the build is wrong.
- **Do not drift into brusque or adversarial phrasing.** The only controlled evidence on instruction register found that *"impolite prompts often result in poor performance"* — weak transfer (terse ≠ impolite, and it is a Feb 2024 study), but it is the boundary to respect.

### 6.6 The one measured compression technique that works on agentic coding — and it is not caveman

Compress **tool output / terminal observations**, not instructions. TACO (arXiv:2604.19572) measured a **1–4% accuracy GAIN** on TerminalBench 1.0 and 2.0 while cutting tokens, and **2–3% accuracy improvement under the same token budget** — the only technique in this survey that saves tokens *and* improves quality, measured, on agentic coding.

**Strategically ideal here:** tool results are the **variable suffix** of the prompt, never cacheable anyway, so compressing them **forfeits no cache discount**. Compress at **step/message granularity with a hard always-keep floor for format-critical and recent content — never at token granularity**, which is exactly the documented failure mode in §8.2.

---

## 7. TECHNIQUES THAT CONFLICT

| A | undermines | B | Mechanism | Resolution |
|---|---|---|---|---|
| **Dynamic prompt compression** | ⛔ kills | **Prompt caching** | A varying prefix forfeits the 0.1x read. Break-even needs `r > 3.67x` | Never run a compressor over cached content. Static rewrites only |
| **Compressing a subagent prompt** | ⛔ silently kills | **Caching that prompt** | Falls below 512 (Opus 5) / 1,024 (Sonnet 5) minimum. **No error returned** | Assert length > minimum; alert when both cache usage fields are 0 |
| **Context editing / `clear_tool_uses`** | ⚠️ fights | **Prompt caching** | Clearing invalidates the prefix and forces a re-write at 1.25x | `N = (w−1)(T/C) − w`. **Clear big, clear rarely.** Raise `clear_at_least` far above the vendor default |
| **Rolling observation masking (M≈10)** | ⚠️ fights | **Prompt caching**, twice | (1) A rolling boundary rewrites one historical block **every turn**, invalidating from that point forward — strictly worse than periodic large clears. (2) The tokens it removes are mid-history observations that at 85% hit are the **cheapest tokens you own** | Adopt the paper's **quality** findings; do **not** expect its ~50% dollar figure (computed on cache-blind Alibaba list pricing). If used, it demands a breakpoint at the mask boundary — which the 4-slot budget cannot spare |
| **4 competing breakpoint layouts** | ⛔ oversubscribe | **The 4-breakpoint cap** | TTL tiers, lookback defence, mask boundary and per-ticket context block each want slots. Hard cap, and a **400** if all four are explicit | **1 pinned prefix + 3 rolling trailing.** Anything else must displace one, and the displacement must be costed |
| **`defer_loading: true` on a tool** | ⛔ blocks | **`cache_control` on that tool** | API returns **400** | Put the prefix breakpoint on the last **non-deferred** tool |
| **Escalating `effort` on a hard subtask** | ⛔ kills | **The messages cache** | Any effort/thinking change invalidates messages on every model | Choose effort **per subagent role at dispatch**; route mechanical turns to **separate low-effort threads**. Never escalate inside a live thread |
| **Summarisation / server-side compaction** | ⛔ inflates | **The retry multiplier** | Summaries *"mask signs of a failing trajectory"*: **+15% mean trajectory length** (52 turns vs 44). Critic-enhanced summarisation was **worse, with no solve-rate gain** | Prefer plain observation masking. A/B compaction against it on completed tickets before enabling |
| **Moving work to subagents** | ⚖️ two-sided | **Total system cost** | **Saves the parent**: 50k of exploration carried through 200 orchestrator turns ≈ $5.00 vs ~$0.15 for a 1.5k digest. **Costs the system**: measured 4x (agent vs chat) and 15x (multi-agent vs chat); Opus 5 over-delegates by default | Delegate only genuinely large independent tracks. Pair every digest with a **verifiable filesystem artefact** |
| **"Fewer input tokens"** | ⛔ is not | **"Cheaper"** | Vendor's own dynamic filtering: **−24% input tokens, +11% accuracy, and price-weighted cost DECREASED on Sonnet 4.6 but INCREASED on Opus 4.6**. Filtering moves work into code generation and reasoning, which bill as **output at 5x, uncacheable** | **Gate every intervention on dollars per COMPLETED TICKET, never tokens per call.** This is the governing caveat on every input-side technique in this document |
| **A gateway / proxy layer** | ⚠️ risks | **Caching correctness** | Two documented community cost failures are gateway integration bugs (Anthropic caching broken through LiteLLM; cache reads double-counted for OpenAI-compatible providers) | Add one the day you add a second vendor, not before |

**One conflict that is NOT a conflict, and it reframes the priority order:** cache engineering and output reduction are **complements**. Output's share of the bill *is* a function of cache success (21% at h=0, 51% at h=0.85, ~64% at h=0.95). **Improving caching mechanically raises the dollar value of every output intervention.** Do cache work first because it is the only class with zero quality risk — then output work, which is now worth more because you did the first. Cache work also **saturates**: past ~90–95% the remaining money is in output tokens and in eliminating failed runs.

---

## 8. DO NOT BOTHER

### 8.1 The "90% savings from prompt caching" blog genre — arithmetic wearing a lab coat

**90% is exactly `1 − 0.1`, the cache-read multiplier.** It is Anthropic's price sheet restated as a benchmark, and it silently assumes a **100% hit rate on 100% of input**. The per-scenario figures circulating (80%/85%/92%) are consistent with nothing more than varying what fraction of the prompt is cacheable. No baseline methodology is published anywhere for how the "without caching" figure was obtained. Several domains repeating this show the signature of **AI-generated SEO content farms**. Treat any "90% saving" headline as a restatement of the price card.

Corollary: **do not adopt third-party auto-breakpoint-injection tooling.** Breakpoint placement is ~50 lines, it is core to your cost model, and an auto-injected breakpoint may land on an unstable block and consume one of your four slots.

### 8.2 LLMLingua-class automated compression — disqualified on four independent grounds

Any one is sufficient:

1. **Wrong axis.** It compresses **input**, which at 85% cache costs $0.668/MTok effective versus **$13.30 for output** — off by a factor of ~20.
2. **Breaks caching.** Query-aware compression mutates the prefix every call. Break-even needs `r > 3.67`; published range is 2–5x; independent measurement says it only beats naive caching at `r ≥ 6`.
3. **Wrong benchmarks.** Its published evaluation set is QA, summarisation and maths (MeetingBank, LongBench, ZeroScrolls, GSM8K, BBH). **No code or agentic benchmark.**
4. **Catastrophic on agents.** Token-level compression collapsed agent reward to **≤0.05 in ALL 17 tested configurations** via *"action-grammar destruction"* — identifiers, brackets and action verbs rank **lowest** in self-information and are deleted first. Perplexity-based importance is **anti-correlated with syntactic necessity**.

Plus: the compressor is an **extra billed inference on every request**, paid before you know whether it saved anything; and the ~30% tokenizer shift on Claude 4.7+ means no published ratio transfers anyway.

**And if you ever do compress anything: never exceed `r = 0.5`.** A pre-registered RCT found `r=0.5` saved 27.9% while `r=0.2` **increased** cost 1.8% and was Pareto-dominated on both axes; a companion study measured **56x output expansion on MBPP at `r=0.3`** when task-critical instructions were truncated. The failure is **bimodal, not a graceful slide** — the worst possible shape for a 5-hour unattended run. `[credibility flag: both figures come from a single-author, arXiv-only, self-citing series with no visible peer review; directionally corroborated by independent work, but do not quote as settled]`

### 8.3 Never quote 84% as a cost saving

The context-editing reference page publishes **no** token-savings percentage and **no** quality measurement for **any** strategy. The circulating 84%/29%/39% figures come from a blog post describing an unnamed *"internal agentic search evaluation"* — no benchmark name, no dataset, no baseline configuration, no confidence intervals, **no independent replication found by anyone**. Three reasons it does not transfer: it is a **web search** workload whose results are large and highly clearable, unlike diffs and test output; it is a **token volume** reduction, and at 85% cache the tokens removed are mostly $0.50/MTok cache reads; and it ignores the cache-write cost the same vendor documents elsewhere.

**Anthropic ships a headline cost feature with zero published efficacy data. That absence is itself a finding.**

### 8.4 The rest of the skip list

| Skip | Why |
|---|---|
| **Compressing system prompts / instructions** | Ceiling ~4.5% of ticket cost, realistically 1–3%. These are the cheapest tokens you own. And it risks §6.2 |
| **The full caveman skill, and "ultra" mode** | A one-line `be brief.` captured most of the saving; a hand-rolled 6-line prompt beat the full skill on the quality/token tradeoff; ultra mode drops edge cases |
| **`thinking.display: "omitted"` to save money** | Billing is identical regardless of display. Saves exactly nothing |
| **Lowering `effort` to shorten responses** | On Opus 5, effort controls **thinking volume, not visible response length**. Prompt for length separately |
| **Disabling thinking** | *"Thinking enabled at low effort performs better than thinking disabled at similar cost"* — and disabling it leaks tool calls into text that never execute but persist in history |
| **`effort: max` anywhere** | Non-monotonic; vendor warns it *"can lead to overthinking"* |
| **Dropping the orchestrator to `medium`** | ~250-Elo spread from effort alone on Opus 5; medium ranks **below** Fable 5 at max. The obvious budget cut is the one not to make |
| **YAML "to save tokens"** | Measured **~19% MORE** tokens than JSON, and worse accuracy. TOML ~44% more |
| **Critic-enhanced summarisation** | Measured: *"no improvement in solve rate"* and *"even longer trajectories."* Strictly dominated. Already tried, already measured |
| **An embedding / semantic index for greenfield builds** | The +12.5% accuracy result is strongest at **1,000+ files**; a ticket that starts from nothing has a small, agent-authored tree where index staleness is maximal |
| **Repo maps / LSP indexes at ticket start** | Zero published token or accuracy measurement; and they pay off during later edit/debug phases, not on code that does not exist yet |
| **A gateway / proxy layer, now** | Two documented cost failures are gateway integration bugs. Add one when you add a second vendor |
| **Batch API, Priority Tier, off-peak** | Already settled elsewhere: sessions *"are stateful and interactive. There is no batch mode"*; Priority Tier is closed to purchase and unsupported on Opus 5 / Sonnet 5 |

**One sourcing note, in the technique's favour:** every arXiv ID cited across all five research lenses — including every suspicious 2026-dated one — resolves to a real paper with matching title and authors, and both caveman repositories exist. **The defects in this research are interpretive and arithmetical, not invented.** The skip list above is about *transfer failure*, not fabrication.

---

## 9. INSTRUMENTATION FIRST

**Nothing above is actionable until this exists.** Two load-bearing assumptions in the cost model — the **85% hit rate** and the **47.5M input** — are currently unmeasured, and the 85% figure circulates widely as a convention with **no published empirical basis** found in any lens.

### 9.1 Log per call, tagged `{ticket_id, phase, agent_role, model, effort}`

| Field | Why |
|---|---|
| `cache_read_input_tokens` | numerator of hit rate |
| `cache_creation_input_tokens` | write volume; also the 5m/1h split via the `cache_creation` object |
| `input_tokens` | **only tokens after the LAST breakpoint** — never treat as total |
| `output_tokens` | the 51% line |
| `usage.output_tokens_details.thinking_tokens` | tells you whether §4 is a $15 or a $3 lever |
| `context_management.applied_edits` (`cleared_tool_uses`, `cleared_input_tokens`) | did clearing fire, and how big |
| **`sum(usage.iterations)`** | **compaction usage is NOT in the top-level counts.** Any dashboard reading `input_tokens`/`output_tokens` **under-reports the bill** whenever compaction fires |
| **wall-clock delta since the previous call on this thread** | the only way to decide the 1h TTL question (§3.1) |
| token count of every `tool_result` block, **bucketed by tool name** | tells you whether tool results are 30% or 70% of your 47.5M — the ranking in §5 is scaled to an illustrative figure, not your run |

Plus the **cache diagnostics beta** (`cache-diagnosis-2026-04-07`) in staging and on a sampled production slice (§3.4).

### 9.2 Alert on these

- `cache_read_input_tokens / total_input` dropping below threshold, **per call class**.
- **Both** cache usage fields `== 0` on any block you expected to cache → below minimum length, 10x silent price increase.
- `speed: "fast"` set anywhere (2x on Opus 5) and `inference_geo: "us"` (1.1x on every category including cache reads).
- Per-ticket dollar spend exceeding a hard ceiling → kill the run.

**Pin your harness and SDK versions.** Every documented cost blowup in the community trackers was a **silent cache regression caused by someone else's change** — a TTL silently regressing 1h→5m, ~20k of cache_creation inflation between two point releases, conversation history invalidated on subsequent turns. They produce **identical output at multiples of the cost**.

### 9.3 The three experiments that resolve open questions, in order

| # | Experiment | Resolves | Swing |
|---|---|---|---|
| 1 | Run **one real ticket** with full logging. Compute the actual hit rate per call class, the actual input total, and the actual thinking share | Whether the $65–$70 model is even right | The whole document |
| 2 | Plot the **tail of inter-call wall-clock gaps per thread** | 5m vs 1h TTL | $0–8/ticket, and it is the only way to decide |
| 3 | Run **one ticket with compaction enabled**; sum every entry in `usage.iterations` and compare against `cache_read_input_tokens` on the same call | Whether a compaction iteration bills at base rate or cache-read rate `[uncertain — the docs do not say]` | **~$0.18 vs ~$0.99 per event; at 10–20 events, $2–4 vs $10–20/ticket** |

### 9.4 Measuring the retry multiplier — the metric that matters most

**Reducing failed runs is worth more than any per-token optimisation in this document.** At 1.3–1.5x on a $65 base, non-convergence costs **$19.49–$32.49 per ticket of pure waste**, exceeding the combined realistic yield of every compression technique here.

Measure it as:

```
effective_cost_per_completed_ticket
  = total_spend_across_all_attempts / count(tickets that shipped)
```

**Never** cost per attempt, **never** cost per call. Break it out by:

- **turns per ticket**, split by context strategy — this is how trajectory elongation shows up. The measured result is that LLM summarisation lengthens runs **15%** (52 turns vs 44).
- **abandonment reason**: dollar ceiling hit / loop detected / test suite never green / hard error.
- **cost of the first failed attempt** — the cheapest failure is an early one.

**Build the loop detector OUT OF PROCESS.** The measured evidence says the agent will not notice it is stuck, and that summarisation makes it *less* likely to notice. Watch for: repeated identical tool calls, no new files touched in N turns, test pass count not increasing, the same error string recurring. Pair it with a **hard per-ticket dollar ceiling**.

**Gate every optimisation on an A/B over completed tickets.** The arithmetic that makes this non-negotiable: moving the retry multiplier from 1.3x to 1.4x costs **~$6.50**; cutting 20% of all input tokens saves **~$6.35**. They are the same order of magnitude. **Any token optimisation that raises non-convergence by even a few percentage points has negative expected value.**

---

## 10. REALISTIC TARGET

All figures below use the **write-corrected** convention on **both** sides, so the comparison is like-for-like. They are **not** comparable to the $65 anchor used in §1.

### 10.1 The composed model

Four multiplicative knobs: `Total = [V × B × M(h)] + [output_volume × $13.30]`, all `× R`.

| | Today | Composed target |
|---|---|---|
| Input volume | 47.5M | **33.25M** (−30%: tool-output governor, caps, concise formats, ranged reads) |
| Cache multiplier | 0.2725 (h=0.85) | **0.192** (h=0.92) |
| **Input cost** | **$36.79** | **$18.14** |
| Output volume | 2.5M | **2.125M** (−15%: verbosity discipline, deleted over-verification, effort topology) |
| **Output cost** | **$33.25** | **$28.26** |
| **Base per ticket** | **$70.04** | **$46.40** (**−33.8%**) |
| Retry multiplier | 1.4x | **1.2x** |
| **Effective per completed ticket** | **$98.06** | **$55.68** (**−43.2%**) |

**Reconciling §1 with this table.** Row 2 quotes 85→92% as **$8.51** under the 1.0x convention; the same 7 percentage points is worth **$10.87** write-corrected (`47.5 × 2.842 × (0.2725 − 0.192)`), which is what is banked here. And rows 4+5+6 claim $6–19 of output saving, but only **$4.99** (−15%) is banked — that overlap is **intentional**, because all three attack the same prose share, and effort topology mostly *relocates* thinking to cheaper threads rather than removing it.

### 10.2 The corners — read the downside one

| Scenario | Base | Effective | vs today |
|---|---|---|---|
| **Today** (intro rates, 1.4x retry) | $70.04 | **$98.06** | — |
| **Pessimistic** — volume −15%, hit 85→88%, output −8%, retry unchanged | $57.90 | **$81.06** | −17% |
| **Downside corner** — full token work lands, **retry reduction delivers nothing** | $46.40 | **$64.96** | −34% |
| **Composed target** | $46.40 | **$55.68** | −43% |
| **Post-2026-09-01, status quo** (1.4x retry) | $89.08 | **$124.71** | — |
| **Post-2026-09-01, composed target** | $59.28 | **$71.14** | **−43%** |

### 10.3 The honest statement

**Planning target: $71–83 effective per completed ticket** — post-2026-09-01 rates, down from **~$125** on the same architecture untouched. Introductory rates expire in five weeks, so this is the number the business case runs on.

At today's introductory rates the same architecture lands at **$55–65 effective, from ~$98**. Use that as the reference when you measure your first real run this month; do not use it as the business case.

Three things the owner should weigh before believing either number:

1. **Roughly half the gain comes from retry reduction, which is the least evidenced component in this entire document.** The size of the prize is solid arithmetic; the efficacy of any specific fix is unmeasured, and the one measured result available says the popular remedy (summarisation) makes it *worse*. **If retry work delivers nothing, the floor from token work alone is ~$46 base / ~$65 effective — still a 34% cut, and that number I would defend.**
2. **The −30% input volume assumption is the shakiest token figure.** It is scaled to a vendor's illustrative context breakdown, not to your run. Experiment 1 in §9.3 could move it to −15% or −45%.
3. **Do not model below ~$46 base.** Cache work saturates around 92–95%; output is 47–52% of the bill and its compressible share (prose only — not thinking, not code, not tool JSON) is a minority of that. There is no plausible path to $30/ticket on this architecture at these prices without changing model, which is out of scope.

**The single largest risk to this target is not that an optimisation underdelivers — it is that one of them silently breaks caching.** The 0%→85% spread is **$103 per ticket**, larger than every technique in this document combined. That asymmetry is why §3 is the spec and §9 is the prerequisite.