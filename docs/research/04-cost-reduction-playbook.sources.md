# Wave 4 — raw findings (technique / saving / evidence / quality risk)


---

# W4a-caching

**Summary.** Lens: prompt caching as an engineering discipline. Headline: for the owner's workload, cache engineering is the rare optimisation class with **zero quality risk** — a byte-identical prefix delivers identical tokens to the model, so nothing is dropped, summarised or compressed. That is the sharp contrast with the "caveman mode" class of idea, which trades information for tokens. Three carve-outs are honest exceptions and are flagged as such: lowering `effort`, context-editing/tool-result clearing, and prompt reordering.

Verified mechanics (platform.claude.com, current as of 2026-07-27): 5-min cache write = **1.25x** base input; 1-hour write = **2.0x**; cache read = **0.1x**. Max **4** explicit `cache_control` breakpoints. Minimum cacheable prefix is **512 tokens on Claude Opus 5** and **1,024 on Claude Sonnet 5** — below that, caching silently no-ops with no error. Cache hierarchy renders `tools -> system -> messages`; a change at any level invalidates that level and everything after it. Lookback window is **20 blocks per breakpoint**.

The owner's cost-model observation holds and is actually understated. Output is 5% of token volume but ~51% of the $65 bill ($33.25/$65) precisely because cache reads cut effective input price 10x. Caching therefore *amplifies* output's share of the bill: at 0% caching output is ~21% of the bill, at 85% it is ~51%. Cache work has a ceiling and moving toward it shifts the bottleneck to output.

Four findings are architecture-specific and are the ones most likely to be silently costing money in a multi-hour agent run:
1. **The 20-block lookback breaks on parallel tool calls.** N parallel tool calls produce 2N content blocks in one turn. At N>=10 the turn exceeds the lookback and the trailing breakpoint finds nothing — total miss on the whole history. Anthropic's own Turn-3 example documents exactly this failure. Fix: rolling trailing breakpoints.
2. **The 5-minute TTL versus tool-execution gaps is the single highest-leverage decision here.** The cache refreshes free on *use*, so turn count is irrelevant — idle time is what kills it. This product builds and tests; an `npm install`, a docker build or a test suite easily exceeds 5 minutes between model calls, and the next call then pays a cold write on a huge prefix. Derived break-even: 1-hour TTL wins if the prefix would otherwise expire and be re-written more than 1.6 times, i.e. **if any gap exceeds 5 minutes even once, 1h TTL is already cheaper**.
3. **Cache diagnostics beta (`cache-diagnosis-2026-04-07`)** is a documented, production-grade root-cause tool that returns a typed `cache_miss_reason` naming *which* of model/system/tools/messages diverged. This is the answer to "how do I verify hit rate in production" and it is far better than any practitioner dashboard.
4. **Cache pre-warming is a documented first-class feature** (`max_tokens: 0`), not a hack — and it is the correct fix for concurrent fan-out, because a cache entry only becomes available after the first response begins.

Widely-repeated claims that do NOT survive scrutiny: the "90% token savings" headline attached to auto-breakpoint tooling is arithmetic, not measurement — 90% is exactly 1 minus the 0.1x read multiplier, i.e. the price sheet restated as a benchmark.

**Could not verify:**

- WebSearch budget was exhausted (200/200) at the very start of this session. All research was done via direct WebFetch of known URLs plus the public HN Algolia JSON API. Consequence: I could not run open discovery for conference talks, YouTube videos, or GitHub repositories, so the practitioner/community coverage the brief asked for is THINNER than the vendor-doc coverage. Sub-questions C (silent killers) and F (measurement) are nonetheless well-evidenced because Anthropic documents both authoritatively — but the independent practitioner corroboration is weak.
- An HN story titled '$38k AWS Bedrock bill caused by a simple prompt caching miss' (2026-04-28, author Zephyr0x, 8 points, 0 comments, HN objectID 47933355) surfaced in search and would be exactly the kind of cautionary evidence the brief wants. I could NOT retrieve the underlying postmortem URL — the Algolia item record returned a null url field. The dollar figure is therefore UNCITED and I have deliberately excluded it from the findings rather than launder an unverifiable number. Worth the owner searching for directly.
- OpenAI's cached-input DISCOUNT PERCENTAGE was not stated on the prompt-caching guide I fetched (it refers to a 'cached-input rate' without a multiplier). Google's cached-token discount and TTL/storage cost were likewise absent from the caching page. DeepSeek's cache-hit price was absent. So the cross-provider comparison covers mechanics and TTL confidently but NOT the discount magnitudes — the owner should check each provider's pricing page directly before any cost comparison.
- No published measurement exists (that I could find) for the DISTRIBUTION OF TOOL-EXECUTION GAP DURATIONS in autonomous coding agents. My 5m-vs-1h TTL recommendation rests on the plausible claim that builds and test suites frequently exceed 5 minutes. This is the single most consequential recommendation in this lens and it is the one the owner can most cheaply falsify with their own telemetry: log the wall-clock delta between consecutive model calls per conversation and plot the tail.
- Anthropic publishes NO measured token-savings or quality-impact benchmarks for context editing (clear_tool_uses_20250919), despite it being a headline cost feature. The clear_at_least break-even I give is my own derivation from the caching multipliers, not a vendor or third-party measurement.
- I found NO credible independent (non-vendor, non-self-published) measurement of achieved cache hit rates in production multi-hour agent runs. Every hit-rate number encountered was either a vendor example, a self-published tool benchmark, or a forum estimate. The claim '85% is achievable' is architecturally plausible from the documented mechanics but I cannot cite anyone who has published a measured 85% over a 5-hour, 680-call run.
- Anthropic docs describe thinking/effort invalidation of the TOOLS and SYSTEM caches as 'model-specific' and point to a per-model table I did not retrieve in full. I confirmed that changing effort ALWAYS invalidates the messages cache on every model, and that effort:'high' equals omitting it on Opus 5 / Sonnet 5. Whether effort changes also invalidate tools/system specifically on Claude Opus 5 is UNCONFIRMED — but it is moot under the recommendation to freeze effort per conversation.

### `measured` — Exact caching price mechanics: 1.25x (5m write) / 2.0x (1h write) / 0.1x (read), 4 breakpoints max, 512-token minimum on Opus 5 and 1,024 on Sonnet 5

- **Claimed saving:** Up to 90% off input token price on any cached prefix (read = 0.1x base). Derived break-even: caching a prefix pays off if it is read even ONCE more. n>0.278 reads needed to beat uncached; at n=1, 1.25+0.1=1.35x vs 2.0x uncached = 32% saving. Effectively always worth it for any repeated prefix.
- **Evidence:** MEASURED/AUTHORITATIVE: Anthropic official prompt caching docs, fetched 2026-07-27. Verbatim: '5-minute cache write tokens are 1.25 times the base input tokens price, 1-hour cache write tokens are 2 times the base input tokens price, Cache read tokens are 0.1 times the base input tokens price.' Minimum cacheable length table gives 512 tokens for Claude Opus 5 / Fable 5 / Mythos 5 and 1,024 for Claude Sonnet 5 / Opus 4.8 / Sonnet 4.6. 'You can define up to 4 cache breakpoints.' Break-even inequality is my own derivation from these published multipliers — arithmetic, not a vendor claim.
- **Quality risk:** NONE. A cache read delivers byte-identical tokens to the model. There is no information loss, no summarisation, no truncation. This is the key property distinguishing cache engineering from every compression-based cost technique.
- **Eng cost:** Low — adding cache_control markers is a few lines. The cost is in maintaining prefix stability (see anti-patterns).

Sources:
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching

### `measured` — Invalidation hierarchy: know exactly which parameter changes blow away tools vs system vs messages caches

- **Claimed saving:** Avoids full-prefix rewrites. On the owner's curve each 1 percentage point of hit rate is worth ~$1.2/ticket at the top of the range (50%->85% = $43 over 35pp); recovering a single systematic invalidation that costs 10pp is worth ~$12/ticket, ~18% of the bill.
- **Evidence:** MEASURED/AUTHORITATIVE: Anthropic 'Cache invalidation reference' table, fetched verbatim 2026-07-27, legend 'x = cache is invalidated; check = cache remains valid'. In prose: (a) Changing TOOL DEFINITIONS (names, descriptions, parameters, or order) invalidates tools + system + messages — the entire cache. (b) Toggling WEB SEARCH, toggling CITATIONS, or switching SPEED (fast mode) keeps the tools cache but invalidates system + messages. (c) Changing TOOL_CHOICE invalidates ONLY messages — 'Changes to tool_choice parameter only affect message blocks'. (d) ADDING/REMOVING IMAGES anywhere invalidates ONLY messages. (e) THINKING PARAMETERS and OUTPUT_CONFIG.EFFORT always invalidate messages; effect on tools/system is model-specific depending on whether the model renders the config ahead of them. (f) Notably safe: 'Setting effort explicitly to the model's default is equivalent to omitting it and does not invalidate' — so effort:'high' == omitted on Opus 5 and Sonnet 5. (g) On Opus 4.5+ and Sonnet 4.6+ thinking blocks are preserved by default so cache remains valid; on earlier Opus/Sonnet and ALL Haiku, prior thinking blocks are stripped and everything after them leaves the cache. Anthropic also publishes a worked experiment on Sonnet 4.6 showing a budget change on request 3 producing cache_creation_input_tokens=1370, cache_read_input_tokens=0 — i.e. a full re-write.
- **Quality risk:** NONE for the caching aspect itself. There IS a quality dimension to the underlying knob: holding effort constant to protect the cache means you cannot dynamically escalate effort mid-run when a subtask looks hard. Anthropic's own best practice resolves this: 'vary effort across workloads rather than within a conversation that relies on cache hits' — i.e. pick effort per subagent role at dispatch, not per turn.
- **Eng cost:** Low-medium. Mostly a discipline of freezing request parameters for the lifetime of a conversation, plus a lint/assert in the request builder.

Sources:
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking

### `measured` — The 20-block lookback window fails on high-fan-out parallel tool-calling turns — fix with rolling trailing breakpoints

- **Claimed saving:** Prevents a total (100%) cache miss on the accumulated history for any turn that adds >20 content blocks. In a run with a ~70k-token average context (47.5M / 680 calls), a single such miss costs the difference between a 0.1x read and a 1.25x write on ~70k tokens; systematically, it is the difference between a working cache and no cache at all on the orchestrator loop.
- **Evidence:** MEASURED/AUTHORITATIVE, but the application to parallel tool calls is my inference. Anthropic docs verbatim: 'The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint, counting the breakpoint itself as the first. If the system finds no matching entry in that window, checking stops.' Their worked example: 'Turn 3: 35 blocks, breakpoint on block 35. The system checks 20 positions (blocks 35 through 16) and finds nothing. The turn-2 entry at block 15 is one position outside the window, so there is no cache hit. Adding a second breakpoint at block 15 starts a second lookback window there, which finds the turn-2 entry.' MY INFERENCE (not in the docs): an orchestrator dispatching N parallel tool calls emits N tool_use blocks plus N tool_result blocks = 2N blocks in one turn, so N>=10 parallel calls crosses the threshold. Also relevant: the docs warn the lookback is not a fallback for a bad breakpoint — 'The lookback does not find stable content behind the breakpoint; it only finds entries that earlier requests wrote at their own breakpoints.'
- **Quality risk:** NONE. Adding breakpoints changes only billing/latency, never the tokens the model sees.
- **Eng cost:** Low. Maintain a small ring buffer of the last 2-3 turn-boundary block indices and place cache_control at each. Budget: 4 breakpoints total, so 1 pinned prefix + up to 3 rolling.

Sources:
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching

### `asserted-credible` — 1-hour TTL for long unattended runs where tool execution stalls the loop past 5 minutes

- **Claimed saving:** DERIVED break-even: the cache 'is refreshed for no additional cost each time the cached content is used', so the only thing that expires a cache is IDLE TIME, not turn count. Paying 2.0x once beats paying 1.25x k times when 2.0 < 1.25k, i.e. k > 1.6. So the 1-hour TTL is already cheaper if the prefix would otherwise expire and be re-written even ONCE more within the hour. Each avoided miss saves (1.25 - 0.1) = 1.15x base input on the whole prefix.
- **Evidence:** MEASURED mechanics + MY DERIVATION for the break-even. Docs verbatim: 'By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used.' Mixed-TTL constraint, verbatim: 'Cache entries with longer TTL must appear before shorter TTLs (i.e., a 1-hour cache entry must appear before any 5-minute cache entries)', with a three-position billing rule (A = highest cache hit, B = highest 1h breakpoint after A, C = last breakpoint; charged read on A, 1h write on B-A, 5m write on C-B). Cache diagnostics docs corroborate the diagnosis path: diagnostics null + cache read tokens low/zero means 'your requests match but the cache entry was no longer available. Consider shortening gaps between turns or using the 1-hour cache TTL.' WORKLOAD-SPECIFIC APPLICATION IS MINE: this product builds and tests, so npm/pip installs, docker builds and test suites plausibly exceed 5 minutes between model calls. I found no published measurement of tool-gap distributions for autonomous coding agents — the owner should measure their own.
- **Quality risk:** NONE.
- **Eng cost:** Trivial — add ttl:'1h' to the prefix breakpoint. The only constraint is ordering longest-TTL-first, which falls out naturally (tools/system are both the most stable and the earliest).

Sources:
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics

### `asserted-credible` — Cache pre-warming with max_tokens: 0 — and using it to fix concurrent fan-out cold writes

- **Claimed saving:** Eliminates N-1 redundant cold writes when N calls sharing an IDENTICAL prefix are dispatched concurrently. Worked example (my arithmetic, illustrative): 6 concurrent instances of the SAME subagent role sharing a 30k-token prefix on Sonnet 5 at $2/MTok intro: naive parallel fan-out = 6 cold writes = 6 x 30k x $2 x 1.25/1M = $0.45 per wave; pre-warm once then fan out = 1 write + 6 reads = $0.075 + $0.036 = $0.111 per wave. ~75% saving on that prefix per wave. Multiply by 1.5 from 2026-09-01 when Sonnet 5 goes to $3/MTok.
- **Evidence:** MEASURED/AUTHORITATIVE feature; the fan-out saving is MY arithmetic on published multipliers, and the wave count is an assumption not a measurement. Docs verbatim on the mechanic: 'For concurrent requests, note that a cache entry only becomes available after the first response begins. If you need cache hits for parallel requests, wait for the first response before sending subsequent requests.' Pre-warming docs verbatim: 'Set max_tokens: 0 in your request. The API reads your prompt into the model and writes the cache at any cache_control breakpoint, then returns immediately without generating any output... Zero output tokens are billed.' Two critical gotchas, verbatim: 'Place the cache_control breakpoint on the last block that is shared with the follow-up request... not on the placeholder user message. Otherwise the cache entry is keyed to the placeholder and the follow-up request won't hit it. Use the same thinking configuration and output_config.effort as your follow-up requests too.' This forces EXPLICIT breakpoints — automatic caching puts the breakpoint on the placeholder and silently defeats the pre-warm. max_tokens:0 is rejected with stream:true, extended thinking (thinking.type:'enabled'), structured outputs, tool_choice type 'tool'/'any', and inside Message Batches.
- **Quality risk:** NONE.
- **Eng cost:** Low. One extra call before each fan-out wave. IMPORTANT SCOPE LIMIT: this only pays when the concurrent calls share a byte-identical prefix, i.e. N instances of the SAME subagent role. Different specialist roles (test-writer vs frontend-dev) have different system prompts and different tool arrays, share no prefix, and each writes its own entry once regardless — there is no cold-write waste to recover there.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pre-warming-the-cache
- https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking

### `measured` — Cache diagnostics beta (cache-diagnosis-2026-04-07) — root-cause a cache miss instead of guessing

- **Claimed saving:** Unquantified directly, but it converts cache-hit-rate work from guesswork into a debug loop. Given ~$1.2/ticket per percentage point of hit rate at the top of the owner's curve, finding one systematic invalidation is typically worth $5-15/ticket.
- **Evidence:** MEASURED/AUTHORITATIVE: dedicated Anthropic docs page, fetched 2026-07-27. Pass beta header 'cache-diagnosis-2026-04-07' and diagnostics.previous_message_id = the prior response id; the API compares request fingerprints and returns a typed cache_miss_reason. The six types, verbatim from the docs table: model_changed ('a router, A/B test, or fallback selected a different model. The cache is per-model'); system_changed ('Typically a timestamp, request ID, or other per-request value was interpolated into the system prompt'); tools_changed ('tools were added, removed, or reordered between turns, or tool input_schema JSON was serialized non-deterministically'); messages_changed ('an earlier entry in messages was altered, reordered, or removed rather than appended to... assistant turns and tool_result blocks were re-serialized differently on resend'); previous_message_not_found; and unavailable — which explicitly covers 'another prompt-affecting request parameter (tool_choice, thinking, context_management, output_config, output_format, or the set of active anthropic-beta headers) differs'. Each *_changed type carries cache_missed_input_tokens. The docs also publish a 2x2 interpretation matrix combining diagnostics with usage.cache_read_input_tokens. Fingerprints are hashes only (ZDR eligible). LIMITATIONS: Claude API only — NOT available on Amazon Bedrock or Google Cloud; short fingerprint retention; same workspace only; best-effort, never blocks the request.
- **Quality risk:** NONE — diagnostics never alters the prompt or the response.
- **Eng cost:** Low. One header plus threading the previous response id through the agent loop. Worth gating behind a flag since it is beta and 'field names and semantics may change before general availability'.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics

### `measured` — Measurement: usage fields, correct hit-rate formula, and the zero-hit-rate signature

- **Claimed saving:** Unquantified — this is instrumentation, but without it every other finding is unfalsifiable.
- **Evidence:** MEASURED/AUTHORITATIVE. Three usage fields: cache_creation_input_tokens (written), cache_read_input_tokens (read), input_tokens. Critical trap, verbatim: 'input_tokens field represents only the tokens that come AFTER the last cache breakpoint in your request - not all the input tokens you sent.' Correct total: total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens; hit rate = cache_read / that total. With mixed TTLs a cache_creation object breaks the write down into ephemeral_5m_input_tokens and ephemeral_1h_input_tokens, and cache_creation_input_tokens equals their sum. ZERO HIT RATE SIGNATURE, verbatim: 'To verify whether a prompt was cached, check the response usage fields: if both cache_creation_input_tokens and cache_read_input_tokens are 0, the prompt was not cached (likely because it did not meet the minimum length requirement)' — and this failure is SILENT: 'Any requests to cache fewer than this number of tokens will be processed without caching, and no error is returned.' Anthropic Console Usage page carries a cache-rate chart: 'The cache rate for your input tokens (that is, the percentage of input tokens read from the cache).' SECOND-ORDER BENEFIT: cache reads do NOT count toward rate limits. Verbatim from the rate-limits page: 'cache_read_input_tokens (tokens read from cache) do NOT count toward ITPM for most models', with the worked example 'With a 2,000,000 ITPM limit and an 80% cache hit rate, you could effectively process 10,000,000 total input tokens per minute'. Only Claude Haiku 3.5 counts cache reads toward ITPM. Opus 5 and Sonnet 5 each have separate ITPM pools (2M Start / 5M Build / 10M Scale) and are NOT in the shared Opus 4.x / Sonnet 4.x buckets.
- **Quality risk:** NONE.
- **Eng cost:** Low-medium. Log the four usage fields per call, tagged with call class and model, into whatever store the dashboard reads.

Sources:
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/api/rate-limits

### `measured` — Silent cache killers: the documented list of things that quietly destroy hit rate in real agent code

- **Claimed saving:** Each item is a potential total-prefix miss. Non-deterministic JSON key ordering in particular produces an intermittent, near-undebuggable ~0% hit rate.
- **Evidence:** MEASURED/AUTHORITATIVE — this list is from Anthropic's own troubleshooting section, not folklore. Verbatim items: 'Confirm your breakpoint is on a block that stays identical across requests. Cache writes happen only at the breakpoint, and if that block changes (timestamps, per-request context, the incoming message), the prefix hash never matches.' And, naming specific languages: 'Verify that the keys in your tool_use content blocks have stable ordering as some languages (for example, Swift, Go) randomize key order during JSON conversion, breaking caches.' Also: verify tool_choice, image usage, thinking configuration and output_config.effort remain consistent; validate you are caching at least the model minimum; 'Cache hits require 100% identical prompt segments, including all text and images up to and including the block marked with cache control.' ISOLATION: caches are workspace-scoped on the Claude API ('Prompt caching uses workspace-level isolation'), organization-scoped on Bedrock and Google Cloud, and never shared across organizations — so splitting traffic across workspaces silently splits your cache. PRACTITIONER CORROBORATION (paraphrased by a summarising model from the HN Algolia API, not verbatim quotes): commenter NeutralForest (2026-07-21) warns to 'avoid anything dynamic: model change, tool change' and keep system prompts static without dates/times/names; commenter jabenhaim (2026-07-14) notes that editing anything upstream blows away provider prompt caching because providers use exact prefix matching. These are low-weight corroboration of what the vendor docs already state authoritatively.
- **Quality risk:** NONE. Every fix here is a byte-stability fix — canonical JSON serialisation, moving a timestamp out of the system prompt into the first post-breakpoint user block. The model receives the same information either way.
- **Eng cost:** Medium — this is the real work. Requires a single canonical request-serialisation path (sorted keys, stable tool ordering), a frozen system prompt template, and an assertion that no per-request value can be interpolated before the last breakpoint.

Sources:
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
- https://news.ycombinator.com/item?id=48994534
- https://news.ycombinator.com/item?id=48913137

### `asserted-credible` — Context editing (clear_tool_uses_20250919) fights the cache — use clear_at_least to make each invalidation pay

- **Claimed saving:** Net saving is conditional and can be NEGATIVE. Clearing at position p forces a rewrite of everything after p at 1.25x, to save 0.1x per future read on the cleared tokens. Directionally, clearing only pays when (tokens cleared) x (number of remaining calls) x 0.1 exceeds 1.15 x (tokens after the clear point). For a long run this means clear rarely and clear big.
- **Evidence:** MEASURED/AUTHORITATIVE mechanics, NO published benchmark. Anthropic docs verbatim: 'Tool result clearing: Invalidates cached prompt prefixes when content is cleared. To account for this, clear enough tokens to make the cache invalidation worthwhile. Use the clear_at_least parameter to ensure a minimum number of tokens is cleared each time. You'll incur cache write costs each time content is cleared, but subsequent requests can reuse the newly cached prefix.' For thinking: 'When thinking blocks are kept in context (not cleared), the prompt cache is preserved, enabling cache hits and reducing input token costs. When thinking blocks are cleared, the cache is invalidated at the point where clearing occurs.' Defaults: trigger 100,000 input tokens, keep 3 tool uses, clear_at_least unset. The token-counting endpoint accepts context_management so you can preview original_input_tokens vs input_tokens before committing. When combining strategies, clear_thinking_20251015 must be listed first. Anthropic publishes NO measured token-savings or quality numbers for context editing — that is a finding in itself. The break-even inequality above is my derivation from the published multipliers.
- **Quality risk:** REAL AND NON-ZERO — this is one of the three carve-outs. Cleared tool results are replaced with placeholder text; the model loses the actual content. For an agent that must remember what a test run output 40 turns ago, this is information loss, not compression. Anthropic frames the keep parameter as an explicit trade-off between 'cache performance' and 'context window availability'. Treat it as a context-window pressure valve, not a cost optimisation.
- **Eng cost:** Low to enable, high to tune safely — needs eval coverage to prove the agent still converges after clearing.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/context-editing

### `folklore` — Auto-breakpoint-injection tooling (e.g. prompt-caching.ai) claiming '90% token savings'

- **Claimed saving:** Claimed 80-92%: 'Bug fix (single file, 20 turns): 184,000 tokens without caching vs 28,400 with (85%)'; 'Refactor (5 files, 15 turns): 310,000 vs 61,200 (80%)'; 'General coding (40 turns): 890,000 vs 71,200 (92%)'. Stated methodology: 'Measured on real Claude Code sessions with Sonnet. Break-even at turn 2.'
- **Evidence:** PRACTITIONER, VENDOR-SELF-MEASURED, AND LARGELY CIRCULAR. Built by Ercan Ermis, MIT licensed, surfaced on HN 2026-03-13 with 69 points and 27 comments. CRITICAL READ: the '90% average token cost reduction' headline is exactly 1 minus the 0.1x cache-read multiplier — it is Anthropic's price sheet restated as a benchmark, not an independent measurement. The site itself concedes this: it explains the saving as 'cache reads cost 0.1x instead of 1x'. The per-scenario percentages (80/85/92%) are consistent with simply varying what fraction of the prompt is cacheable, which is arithmetic. No baseline methodology is published (how was the 'without caching' figure computed — actually run uncached, or inferred?), no independent replication, no confidence intervals, and no quality comparison. The USEFUL signal is the qualitative claim 'break-even at turn 2', which matches my independent derivation from the multipliers (n > 0.278 reads).
- **Quality risk:** Unknown and unmeasured by the tool's author. In principle breakpoint injection is quality-neutral (it changes only cache_control markers). The real risk is operational: auto-injected breakpoints may land on unstable blocks and consume the 4-breakpoint budget, and the tool is a third party in a path where the owner should control layout directly.
- **Eng cost:** Low to adopt, but the owner should implement breakpoint placement in-house — it is ~50 lines and it is core to their cost model, not a dependency worth taking.

Sources:
- https://prompt-caching.ai/
- https://news.ycombinator.com/item?id=43350596

### `measured` — Cross-provider caching comparison — does a cheaper sticker price survive a cache-heavy, stall-prone workload?

- **Claimed saving:** Not a saving; a decision input. The strategic point: Anthropic's caching is EXPLICIT (you choose breakpoints, you can buy a 1-hour TTL, you can pre-warm). Providers with automatic-only caching give you NO lever when a 12-minute test run stalls the loop — the exact failure mode this workload has. A cheaper base rate on an automatic-cache provider can therefore be more expensive in practice.
- **Evidence:** MEASURED/AUTHORITATIVE per-provider docs, fetched 2026-07-27. OPENAI: automatic for prompts >=1024 tokens; explicit prompt_cache_breakpoint markers on GPT-5.6+; cache writes on GPT-5.6+ cost '1.25x the uncached input token rate' tracked via cache_write_tokens; TTL is '5 to 10 minutes of inactivity, up to a maximum of one hour' on the in-memory policy, with GPT-5.6+ offering a minimum 30-minute retention via prompt_cache_options.ttl and older models up to 24h extended retention; prompt_cache_key improves routing with the guidance to 'keep the total traffic across all prefixes for each key to approximately 15 requests per minute'; reported as usage.prompt_tokens_details.cached_tokens. GOOGLE GEMINI: implicit caching enabled by default for Gemini 2.5 and newer; minimums 2,048 tokens (2.5 Flash/Pro) and 4,096 (3.5 Flash, 3.1 Pro Preview); reported as usage.total_cached_tokens; the Interactions API supports implicit caching ONLY (no explicit cache objects). DEEPSEEK: fully automatic, 'enabled by default for all users'; eviction is vague — 'Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days'; reported as prompt_cache_hit_tokens / prompt_cache_miss_tokens; explicitly 'best-effort' with no hit-rate guarantee.
- **Quality risk:** NONE from caching itself; model-choice quality is out of scope per the brief.
- **Eng cost:** N/A — informational.

Sources:
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://ai.google.dev/gemini-api/docs/caching
- https://api-docs.deepseek.com/guides/kv_cache


---

# W4b-context

**Summary.** CEILING FIRST. Context management reduces INPUT tokens, and input is only ~$31.72 of the ~$65 ticket (48.8%). I verified the owner's key observation from the stated model: input effective rate = $31.72/47.5M = $0.668/MTok; output effective rate = $33.25/2.5M = $13.30/MTok — output tokens cost ~20x input tokens at 85% cache-hit, so 5% of volume is 51% of the bill. CONFIRMED. Therefore my entire lens is bounded by ~49% of the bill, and a realistic halving of input volume saves ~$16/ticket (~24%). Any headline like "context editing cuts tokens 84%" is a VOLUME claim, not a cost claim.

THE BIGGER LEVER IS RELIABILITY, NOT TOKENS. At the brief's 1.3–1.5x wastage multiplier, effective cost is ~$85–98/ticket. Eliminating non-convergence saves ~$20–33 — MORE than halving input volume. Chroma's independent 18-model study is the bridge: performance degrades measurably "well within stated context windows." Smaller context is a QUALITY lever that buys fewer failed runs, and that is worth more than the input-line saving. Optimise context for convergence first, tokens second.

THE SINGLE MOST ACTIONABLE FINDING is not on the A–G list: Anthropic's prompt cache only looks back 20 content blocks for a prior cache entry. In a growing agentic loop the breakpoint outruns that window and you get a SILENT total cache miss — the difference between $65 and $155/ticket. Fix is trivial (use up to 4 explicit cache breakpoints, staggered). Check this before any other context technique.

THE CENTRAL TRAP: context editing (clear_tool_uses) EXPLICITLY invalidates the cache prefix. I derived the break-even in closed form from documented prices: N = (w−1)·(T/C) − w turns, where w = cache-write/cache-read ratio (12.5 for 5m TTL, 20 for 1h) , T = context size, C = tokens cleared. Clearing 33% of context takes 22 turns (5m) or 37 (1h) just to break even. Clearing 80%+ breaks even in ~2–4 turns. Rule: CLEAR BIG, CLEAR RARELY. Naive frequent clearing is a net cost increase that looks like a saving on the token counter.

PURE WINS (no information loss, cache-safe): tool search / defer_loading (prefix explicitly untouched), filesystem-as-memory, staggered cache breakpoints, and subagent isolation for exploration-heavy work. Everything else trades information for tokens, and I quantify the trade per technique.

COVERAGE CAVEAT: the WebSearch budget was exhausted (200/200) on my first call. All evidence below is WebFetch-only, from a URL index harvested via platform.claude.com/llms.txt and one surviving search result set. Coverage is therefore Anthropic-primary-heavy; I found fewer independent practitioner measurements than the brief wanted, and I flag that as a gap rather than papering over it.

**Could not verify:**

- COVERAGE CONSTRAINT, STATED PLAINLY: the WebSearch budget was exhausted (200/200) on my very first call. All evidence here was gathered WebFetch-only, from a URL index harvested via platform.claude.com/llms.txt plus one surviving search result set. Consequence: coverage skews Anthropic-primary. The brief explicitly asked for conference talks, YouTube videos, and many practitioner write-ups; I found ONE independent measurement (Chroma), ONE third-party benchmark (Stacklok), ONE practitioner cost analysis (Augment Code) and ONE critique (Conikee). Do not read this as 'these are the only sources that exist' — read it as 'these are the sources reachable without search'.
- BLOCKING UNKNOWN — compaction billing rate. The compaction iteration is billed separately (usage.iterations), and the docs' example shows 180,000 input tokens for one event, but the docs never state whether those tokens are charged at base rate or cache-read rate. On Opus 5 that is ~$0.99 vs ~$0.18 per event — across 10–20 events per ticket, $10–20 vs $2–4. This single unknown decides whether compaction is a cheap win or a material cost sink. MEASUREMENT RECIPE: run one real ticket with compaction enabled, sum every entry in usage.iterations, and compare against cache_read_input_tokens on the same call. One run answers it.
- No published token-composition breakdown for a long CODING-agent run. The best available (Anthropic cookbook: 96.3% file-read results / 1.9% tool-call records / 1.7% reasoning) is from a 5-turn, 8-document READING demo. A coding agent additionally carries test output, compiler and linter errors, diffs, and far more reasoning at effort:xhigh. Since this data is what decides where to optimise, the owner should instrument their own run rather than inherit these ratios.
- Context rot has NOT been replicated on 2026-generation models. Chroma's study is July 2025 on Claude Opus 4 / Sonnet 4 / GPT-4.1 / Gemini 2.5 / Qwen3. No equivalent measurement exists for Opus 5, Sonnet 5, Fable 5 or GPT-5.6. Vendors now ship 1M-token windows and claim improved long-context handling; whether the degradation curve has flattened is UNKNOWN. The mechanism (n-squared attention, training distributions favouring short sequences) is architectural and unlikely to have vanished, but the magnitude may have changed and the whole 'smaller context is a quality lever' argument rests on this unreplicated result.
- NO measured before/after agent-performance comparison for compaction on a coding task. The only quality probe located is the cookbook's 6-item factual recall test (3/3 high-level preserved, 0/3 obscure specifics preserved) on a document-research task. Nobody has published 'we ran N coding tickets with and without compaction and the pass rate went from X to Y'. This is the single most valuable missing measurement for this product and the owner is well-positioned to produce it.
- My break-even formula N = (w−1)(T/C) − w is DERIVED from documented list prices, not measured. It assumes the clear point sits early enough that essentially the whole suffix must be re-written, and it ignores second-order effects (the 20-block lookback interacting with clearing, partial breakpoint reuse, multiple breakpoints). Treat it as a decision aid whose direction is reliable — clear big, clear rarely — rather than an exact per-event figure. Validate against cache_creation_input_tokens on a real run.
- Which cache TTL a 5-hour run actually sustains is unresolved and it doubles or halves several conclusions. Cache reads refresh the TTL for free, so a 5-minute TTL survives indefinitely IF turns are under 5 minutes apart. But an orchestrator blocking on a multi-minute subagent may exceed that, forcing 1-hour caching at 2x write cost ($10/MTok on Opus 5) and roughly doubling every clearing break-even. Requires measuring actual inter-turn wall-clock gaps in the orchestrator loop.
- The Anthropic-vs-Stacklok conflict on tool search accuracy is unresolved IN THE 10–50 TOOL REGIME that actually matters here. Anthropic asserts selection degrades above 30–50 tools (so tool search helps); Stacklok measured 34%/30% selection accuracy but at 2,792 tools and while selling a competing product. Nobody has published tool-search accuracy at the tens-of-tools scale this product will run.
- No independent verification of ANY Anthropic context-management figure. The 84%/29%/39% numbers, the 'over 85 percent' tool-definition reduction, and the ~55k multi-server baseline are all vendor-self-reported on undisclosed datasets. Stacklok noted the same about the '191,300 tokens preserved / 85% reduction' claim: 'these figures derive from internal testing with undisclosed datasets'.
- Cost/benefit of context management on SUBAGENTS specifically is unresearched. All published guidance targets a single long-lived conversation. With ~680 model calls across an orchestrator plus many short-lived subagents, the right configuration almost certainly differs per role — a subagent that lives 20 turns may never reach a 100k clearing trigger, making the whole apparatus dead weight for it.
- GitHub/practitioner implementation evidence is thin. I verified one issue (anthropics/claude-code#19530 — a plan-mode UI bug, closed, has-repro) and located but could not fetch NousResearch/hermes-agent#526 (a context-editing integration proposal) or the Agno third-party implementation docs. The brief asked for issue threads and repos as a source type and this angle is under-covered.

### `asserted-credible` — Staggered explicit cache breakpoints to defeat the 20-block cache lookback window

- **Claimed saving:** Prevents a SILENT total cache miss. Per the brief's own model this is the difference between 85% hit ($65/ticket) and 0% hit ($155/ticket) — up to $90/ticket. Not a saving so much as avoiding a catastrophic loss.
- **Evidence:** Anthropic prompt-caching docs, primary. Verbatim mechanism: the system only checks 20 blocks backward for a prior cache entry. Worked example in the doc: Turn 1 breakpoint at block 10 (write); Turn 2 at block 15 walks back and hits; Turn 3 at block 35 checks blocks 35 down to 16, and the turn-2 entry at block 15 is ONE POSITION OUTSIDE the window -> no cache hit. Doc guidance verbatim: use up to 4 breakpoints to 'ensure a cache hit when a growing conversation pushes your breakpoint 20 or more blocks past the last cache write.' A long agentic loop with 680 model calls grows blocks far faster than 20 per stretch, so this is the default failure mode, not an edge case. Also confirmed: cache read is 0.1x AND refreshes the TTL for free, so a 5-min TTL survives indefinitely if turns are <5 min apart; a 1h TTL costs 2x to write ($10/MTok on Opus 5) and is only needed if the orchestrator blocks on subagents for >5 minutes.
- **Quality risk:** NONE. Purely a billing/caching mechanic. No content is altered, removed or summarised. This is the cleanest pure win in the entire research.
- **Eng cost:** Very low — hours. Add cache_control breakpoints at 2–4 staggered positions in the message array and verify via cache_read_input_tokens vs cache_creation_input_tokens in the usage object each turn.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md

### `asserted-credible` — Context editing — clear_tool_uses_20250919 (clearing stale tool results server-side)

- **Claimed saving:** Anthropic: 84% token reduction on a 100-turn web search eval, and 29% performance improvement. Anthropic cookbook (measured on its own demo): peak context 335,279 -> 173,137 tokens (48% reduction) with 4 clearing events, ~163,000 tokens freed per event; separately 67% reduction on a sample corpus (128,740 -> 43,060). BUT these are VOLUME reductions, and cost can move the other way — see quality/cost risk.
- **Evidence:** Anthropic blog (29%/39%/84%, unnamed internal eval, self-reported, Sept 29 2025) + Anthropic docs (parameters, primary) + Anthropic cookbook (peak-context numbers on a document-reading demo). CRITICAL primary finding from the docs, verbatim: clearing 'Invalidates cached prompt prefixes when content is cleared... You'll incur cache write costs each time content is cleared.' The clear_at_least parameter exists specifically to stop cache thrashing. MY DERIVED ARITHMETIC from documented prices (label: derivation, not measurement): break-even turns N = (w−1)·(T/C) − w, where w = cache-write/cache-read multiplier (12.5 at 5-min TTL, 20 at 1-hour TTL), T = total context, C = tokens cleared. Clear 33% -> 22 turns (5m) / 37 turns (1h) before the clear pays for itself. Clear 50% -> 10.5 / 18 turns. Clear 80% -> 1.9 / 3.75 turns. Clear 92% -> immediate. Because clearing removes the OLDEST results, the clear point sits early and nearly the whole suffix must be re-written at 1.25x (5m) or 2x (1h) base rate. CONTRADICTION WORTH REPORTING: the cookbook's own cost table says clearing has 'no inference cost, server-side edit only' while its implementation checklist tells you to monitor cache_creation_input_tokens because 'clearing/compaction invalidate caches.' The vendor's cost comparison omits the vendor's own documented cache-write cost.
- **Quality risk:** LOW-TO-NONE for re-fetchable content, REAL for non-re-fetchable. Anthropic's own framing: 'once a tool has been called deep in the message history, why would the agent need to see the raw result again?' — genuinely lossless when the tool result is a file read the agent can repeat. Cleared content is replaced with placeholder text so the model knows something was removed. Real risk: clearing results the agent cannot cheaply re-derive (long test output, one-shot API responses, error traces). Mitigate with exclude_tools. Defaults: trigger 100k input tokens, keep 3 tool uses, clear_tool_inputs false (tool CALL parameters stay visible, only results are cleared).
- **Eng cost:** Low — one config block. Header anthropic-beta: context-management-2025-06-27. Real cost is in TUNING: you must set clear_at_least high enough to clear the cache-invalidation cost, which is the opposite of the intuitive setting.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/context-editing.md
- https://claude.com/blog/context-management
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md

### `asserted-credible` — Server-side compaction (compact_20260112) — automatic summarisation of older context

- **Claimed saving:** Anthropic cookbook (measured on its demo): peak context 335,279 -> 169,164 tokens, a 50% reduction, with a ~2,783-token summary standing in for an entire first batch of work plus task state; separately 39% compression on a small demo conversation (~741 -> ~449 tokens). Net COST saving is unresolved — see evidence.
- **Evidence:** Anthropic docs (primary, mechanism and billing) + cookbook (measured peak-context figures). Mechanism: header anthropic-beta: compact-2026-01-12; default trigger 150,000 input tokens, minimum 50,000; only input_tokens trigger type supported. Prior content blocks are DROPPED and replaced by a <summary> block. Supported on Opus 5, Opus 4.8/4.7/4.6, Sonnet 5/4.6, Fable 5, Mythos 5. BILLING — the critical and under-appreciated part, verbatim: 'Top-level input_tokens and output_tokens do NOT include compaction iteration usage'; 'Total tokens billed = sum of all entries in usage.iterations'. The doc's own example shows a compaction iteration of 180,000 input / 3,500 output tokens billed SEPARATELY from the 23,000/1,000 message. On Opus 5 that single event is ~$0.99 if the 180k is charged at base rate, or ~$0.18 if charged at cache-read rate — the docs do not say which, and at 10–20 events per ticket that is the difference between ~$2–4 and ~$10–20. Anyone tracking cost from top-level input_tokens/output_tokens is UNDER-COUNTING their bill. Good news: re-applying previous compaction blocks incurs no additional cost, and compaction blocks accept cache_control so the system prompt cache survives a compaction event.
- **Quality risk:** MEASURED AND REAL — this is the clearest quality-degradation evidence in the research. Anthropic's own cookbook probed a 2,783-token summary and reported: high-level facts 3/3 PRESERVED (lifespan figures, organism identities); obscure specifics 0/3 PRESERVED (appendix table cells I-squared=61% and effect magnitude=55%, epigenetic clock ratio 0.72). Translated to a coding agent: architectural decisions survive, exact error strings / version pins / config values / line numbers do NOT. Anthropic's own context-engineering post names the tension: 'aggressive compaction risks losing subtle but critical context whose importance emerges later.' MITIGATION with real teeth: the `instructions` parameter lets you dictate what the summariser must preserve — but note it REPLACES the default prompt entirely rather than supplementing it, so a sloppy custom instruction can lose more than the default would. Also `pause_after_compaction: true` returns stop_reason 'compaction' and lets you inspect/augment the summary before continuing.
- **Eng cost:** Low to configure, MEDIUM to do safely. Must (a) rewrite cost tracking to aggregate usage.iterations, (b) write and test custom `instructions` for code-specific preservation, (c) ideally use pause_after_compaction to re-ground from disk rather than trusting the summary.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/compaction.md
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### `asserted-credible` — Thinking-block clearing (clear_thinking_20251015)

- **Claimed saving:** Unquantified by Anthropic. Response object reports cleared_thinking_turns and cleared_input_tokens per event so you can measure it yourself. In the cookbook's baseline document-agent run, reasoning was only 1.7% of context — but that workload was read-heavy; at effort:xhigh on a coding run reasoning will be a materially larger share.
- **Evidence:** Anthropic docs, primary. Parameter: keep = 'all' or {type: thinking_turns, value: N}. Model-class defaults differ: Opus 4.5+ and Sonnet 4.6+ keep ALL prior thinking by default; older models keep only the last turn. IMPORTANT ACCOUNTING POINT the owner should not misfile: this reduces the cost of CARRYING thinking forward as input on subsequent turns. Those tokens were already billed as OUTPUT when generated and that spend is unrecoverable. So this is an input-side lever only — it does not touch the 51%-of-bill output line. Caching interaction, verbatim: when thinking blocks are kept, 'the prompt cache is preserved'; when cleared, 'the cache is invalidated at the point where clearing occurs.' Same break-even arithmetic as tool-result clearing applies. Ordering constraint: when combined with clear_tool_uses, clear_thinking_20251015 MUST be listed first.
- **Quality risk:** UNKNOWN and under-studied — the honest answer. Anthropic ships keep-all as the DEFAULT on current models (Opus 4.5+, Sonnet 4.6+), which is a strong implicit signal that they consider retained reasoning valuable on frontier models. No published measurement of coding-agent quality with thinking cleared vs kept was located. Given the default, deviating from it is the risky choice, not the safe one.
- **Eng cost:** Very low — one config entry. But treat the default as the tested path.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/context-editing.md
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools

### `measured` — Tool search tool / defer_loading — progressive disclosure of tool definitions

- **Claimed saving:** Anthropic: a typical multi-server setup (GitHub, Slack, Sentry, Grafana, Splunk) consumes ~55k tokens in definitions before any work, and tool search 'typically reduces this by over 85 percent', loading only the 3–5 tools needed. FOR THIS PRODUCT, use the formula not the percentage: saving = tool_def_tokens x n_calls x cache_read_rate. At 55k defs x 680 calls x $0.50/MTok = $18.70/ticket. At a realistic coding-agent 10k of definitions = $3.40/ticket. Sanity check: 47.5M input / 680 calls ~= 70k average context per call, so 55k of tool definitions is implausible here — assume the low end.
- **Evidence:** Anthropic docs, primary, GA (not beta). CACHING ANSWER — this is the key differentiator and it is a genuine pure win, verbatim: 'Internally, the API excludes deferred tools from the system-prompt prefix. When Claude discovers a deferred tool through tool search, the API appends a tool_reference block inline in the conversation, then expands it into the full tool definition before passing it to Claude. The prefix is untouched, so prompt caching is preserved.' Contrast with context editing, which explicitly destroys the prefix. Constraints: max 10,000 deferred tools; 5 results per search; regex patterns <=200 chars, BM25 queries <=500; at least one tool must stay non-deferred; a deferred tool cannot carry cache_control (400 error). Not metered as a separate server tool.
- **Quality risk:** CONFLICTING EVIDENCE — resolve by REGIME. Anthropic claims tool search IMPROVES quality: 'Claude's ability to pick the right tool degrades once you exceed 30–50 available tools', so deferred loading keeps selection accuracy high. Stacklok (dev.to, tested 2025-12-10, 2,792 tools from the MCP-tools dataset, synthetic LLM-generated queries, Claude Sonnet 4.5) measured the OPPOSITE at extreme scale: Anthropic tool search BM25 = 34% selection / 48% retrieval accuracy; regex = 30% / 39%; versus their own MCP Optimizer at 94% / 98%. Token use was comparable (2,823 BM25 vs 3,296 MCP Optimizer vs 3,679 regex, against a 206,073-token all-tools baseline that blew the context window). Latency favoured MCP Optimizer (5.75s vs 12.05s/13.55s). BOTH CAN BE TRUE: Stacklok tested 2,792 tools, two orders of magnitude beyond this product's likely tens-of-tools regime, and Stacklok sells the competing product — measured, but vendor-interested. Practical read: safe and quality-positive at tens of tools; do NOT assume it holds if you aggregate hundreds of MCP tools.
- **Eng cost:** Low. Add defer_loading: true to infrequently-used tools, keep the 3–5 hottest non-deferred, add the tool search tool. Note you still transmit every tool definition in the request each turn — defer_loading controls context, not payload.

Sources:
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool.md
- https://dev.to/stacklok/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison-2f32
- https://www.anthropic.com/engineering/advanced-tool-use

### `asserted-credible` — Memory tool (memory_20250818) — durable state on disk, pointer/digest in context

- **Claimed saving:** Anthropic blog: memory tool + context editing = 39% performance improvement over baseline vs 29% for context editing alone (unnamed internal eval, self-reported). Cookbook (measured on its demo): ~2,999 tokens of structured notes written to /memories carried the state that would otherwise require re-reading ~170k of source context in a later session. That is roughly a 50:1 compression on cross-session state.
- **Evidence:** Anthropic docs, primary, GENERALLY AVAILABLE (no beta header), available on all Claude 4 and later models. Client-side by design: Claude requests file ops, YOUR application executes them against storage you control; /memories is a prefix you map to real storage. Six commands: view (with view_range paging), create, str_replace, insert, delete, rename. The API AUTO-INJECTS a system-prompt protocol you do not have to write, verbatim: 'IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE... ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.' That last line IS the re-grounding protocol — it is what makes memory the antidote to compaction's measured loss of specifics. Anthropic's explicit layering guidance: 'compaction keeps the active context small without client-side bookkeeping, and memory preserves the information that must survive summarization.'
- **Quality risk:** NET QUALITY POSITIVE, and the best available mitigation for compaction loss. No information is destroyed — it is relocated to durable storage and re-read on demand. Residual risks are operational, not informational: (a) the agent must actually write the right things down (Anthropic supplies prompt patterns to enforce this); (b) unbounded memory files re-inflate context, so cap file size and cap what view returns, letting Claude page with view_range; (c) SECURITY — you execute every file op Claude requests, so path-traversal validation against /memories/../../secrets.env is mandatory, and Anthropic explicitly warns about URL-encoded traversal (%2e%2e%2f).
- **Eng cost:** MEDIUM — the only technique here requiring real application code. You implement the handler. Python/TypeScript ship BetaLocalFilesystemMemoryTool ready-made; Python/C# subclass BetaAbstractMemoryTool, TS uses betaMemoryTool, Java implements BetaMemoryToolHandler; Go, Ruby and PHP have no helper and you run the loop yourself. Budget extra for path validation and size caps.

Sources:
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md
- https://claude.com/blog/context-management
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools

### `asserted-credible` — Progress-file / feature-list / init-script harness pattern for multi-session re-grounding

- **Claimed saving:** Unquantified — Anthropic published NO token figures or duration metrics for this pattern. Its value is convergence, not tokens: it attacks the 1.3–1.5x retry multiplier, which at ~$65 base is worth ~$20–33/ticket, more than any input-token technique in this report.
- **Evidence:** Anthropic engineering, 'Effective harnesses for long-running agents', 2025-11-26. This is the most directly on-point source for THIS PRODUCT (multi-hour unattended coding runs). Three concrete artefacts: claude-progress.txt (log of what prior sessions accomplished), feature_list.json (structured end-to-end feature descriptions with pass/fail status), init.sh (launches the dev server). Re-grounding sequence each session: run pwd to confirm working directory; read git logs and progress files; review the feature list and pick the highest-priority incomplete feature; run the init script to verify the dev server launches; execute basic end-to-end tests BEFORE starting new work. Two non-obvious design choices with stated reasoning: (1) JSON over Markdown for the feature list because 'the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files'; (2) git commits with descriptive messages as the recovery mechanism, so a bad change can be reverted to a known-good state. THE LOAD-BEARING QUOTE for this owner: 'compaction isn't sufficient' alone, even with frontier models like Opus 4.5. Discipline rule: mark a feature complete only after END-TO-END VERIFICATION confirms it works, not when the code is written — which is exactly this product's 'returns only when complete and TESTED' promise.
- **Quality risk:** NONE from information loss — this ADDS a durable, verifiable ground truth outside the context window and is the standard defence against compaction's measured loss of specifics. Only failure mode is a stale or lying progress file, which the 'verify end-to-end before marking complete' rule and git history are designed to catch.
- **Eng cost:** MEDIUM — this is harness architecture, not a config flag. Initializer session, per-session bootstrap sequence, end-of-session update discipline, git integration. But it is the highest-leverage engineering in this report for a multi-hour unattended product, and it is exactly the shape of run the owner is building.

Sources:
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md

### `asserted-credible` — Subagent context isolation — keeping large intermediate context out of the orchestrator

- **Claimed saving:** NET SAVE when exploration is large and the returned digest is small. Anthropic's stated shape: subagents 'explore extensively but return condensed summaries (typically 1,000-2,000 tokens)'. Economics for this product: the marginal cost of carrying X extra tokens in the Opus orchestrator for N remaining turns is X x N x $0.50/MTok. A 50k-token exploration carried through 200 remaining orchestrator turns costs 50k x 200 x $0.50/MTok = $5.00; the same work done in a Sonnet subagent returning a 1.5k digest costs Sonnet rates once plus 1.5k x 200 x $0.50/MTok = $0.15. Delegation wins by roughly an order of magnitude for exploration-heavy subtasks. It NET COSTS when the subtask is small (handoff/re-grounding overhead exceeds the context saved) or when the subagent must be re-briefed with context the orchestrator already holds.
- **Evidence:** BRIEF CORRECTION — the task premise cites 'Anthropic guidance that multi-agent uses 3-10x more tokens.' That figure does not appear in the primary source. Anthropic's multi-agent research system post (2025-06-13) states verbatim: 'agents typically use about 4x more tokens than chat interactions' and 'multi-agent systems use about 15x more tokens than chats.' The correct multiplier is 4x (agent vs chat) and 15x (multi-agent vs chat) — and note the 15x baseline is CHAT, not single-agent. CRUCIAL REFRAME: the 15x is because multi-agent systems DO MORE WORK (parallel breadth-first exploration), not because identical work costs 15x. Same post: 'token usage by itself explains 80% of the variance' on BrowseComp, with three factors explaining 95%; and the multi-agent system (Opus 4 lead + Sonnet 4 subagents) 'outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval.' Anthropic's own economic gate, verbatim: 'multi-agent systems require tasks where the value of the task is high enough to pay for the increased performance', best for 'heavy parallelization, information that exceeds single context windows, and interfacing with numerous complex tools.' Independent corroboration of the cost scale: Augment Code documents a real production run — Bun's 535,000-line Zig-to-Rust migration with 64 parallel agents, 5.9B uncached input, 72B cached input reads, 690M output, ~$165,000, cached reads outnumbering output ~100:1.
- **Quality risk:** MIXED, and the direction depends on what you delegate. POSITIVE: isolation gives each subagent a clean, small context, which by the context-rot evidence raises per-subagent quality, and 90.2% measured improvement on a research task supports this. NEGATIVE: the digest boundary is a genuine lossy compression — the orchestrator sees 1–2k tokens where 50k existed, and cannot audit what the subagent did or verify a 'done' claim from the summary alone. For a product whose promise is 'complete and TESTED', pair every subagent digest with a filesystem artefact (test output, git commit) the orchestrator can verify independently rather than trusting the summary.
- **Eng cost:** HIGH — this is the orchestrator's core architecture, not an add-on. Task decomposition, digest schema, handoff protocol, failure/retry semantics. The owner is already building this, so the actionable part is the digest contract and verification, not the decision to delegate.

Sources:
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.augmentcode.com/guides/ai-coding-cost-analysis-agent-token-spend

### `measured` — Context rot — smaller context as a QUALITY lever, not just a cost lever

- **Claimed saving:** No direct token saving. This is the justification for every other technique in the list, and the bridge to the reliability lever (worth ~$20–33/ticket at the brief's 1.3–1.5x wastage multiplier).
- **Evidence:** STRONGEST INDEPENDENT MEASUREMENT IN THIS REPORT. Chroma Research, 'Context Rot', 2025-07-14, Kelly Hong / Anton Troynikov / Jeff Huber. 18 LLMs across four vendors (Claude Opus 4, Sonnet 4, Sonnet 3.7/3.5, Haiku 3.5; o3, GPT-4.1 + mini + nano, GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo; Gemini 2.5 Pro/Flash, 2.0 Flash; Qwen3-235B/32B/8B). Three task families: extended needle-in-haystack (8 input lengths from 25 to 10,000 words, 11 needle positions, 5 embedding models for similarity, 0–4 distractors); LongMemEval conversational QA (306 manually-cleaned prompts averaging ~113k tokens, comparing ~300-token 'focused' inputs against 'full' inputs padded with irrelevant context); and a repeated-words replication task (1,090 variations per word combination, scored by normalised Levenshtein distance). Headline result verbatim: 'model performance consistently degrades with increasing input length' and degradation occurs 'well within stated context windows' across ALL model families. Secondary findings that matter operationally: lower semantic similarity between question and answer steepens the decline; a SINGLE distractor measurably reduces accuracy and four compound it, with effects amplifying at longer context; Claude models showed the LARGEST focused-vs-full gap on LongMemEval, though Opus 4 and Sonnet 4 abstained conservatively rather than hallucinating; and counterintuitively 'models perform better on shuffled haystacks than on logically structured ones.' Anthropic corroborates the mechanism independently: the n-squared attention argument plus 'models train on distributions favoring shorter sequences, leaving them with fewer specialized parameters for managing context-wide dependencies.'
- **Quality risk:** INVERTED — this finding says LARGE context is the quality risk. For a 47.5M-input-token run this is the core argument that aggressive context management is not a cost-vs-quality tradeoff but quality-positive, provided the discarded information is recoverable from disk. The distractor finding has a sharp practical edge: stale tool results and dead-end explorations left in context act as measured distractors, so clearing them is quality-positive independent of any token saving.
- **Eng cost:** N/A — this is evidence, not a technique. It changes how you rank the others.

Sources:
- https://www.trychroma.com/research/context-rot
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools

### `measured` — Token composition — what actually fills an agent's context (determines where to optimise)

- **Claimed saving:** N/A — this is the targeting data. It says: optimise TOOL RESULTS (file reads) first; reasoning and tool-call records are rounding errors by comparison.
- **Evidence:** MEASURED, but on the wrong workload — read carefully. Anthropic's cookbook instrumented a baseline research agent with no context management: peak 335,279 tokens across 5 turns, composed at the end of 96.3% file-read results (322,946 tokens), 1.9% tool-call records, 1.7% reasoning. On a 200K window it hard-stopped at turn 3 with 8 of 8 documents unread. Separately, Augment Code reports a Claude Sonnet 4.6 session breakdown of ~94.5% cache reads / ~5.0% cache writes / ~0.5% output / ~0.1% uncached input, total $0.55 — showing that in a well-cached agent loop almost all token VOLUME is cache reads. Augment's four named accumulation categories (context re-reading, system-prompt/CLAUDE.md re-injection, tool definitions at fixed per-request cost — they cite the computer-use tool at 735 input tokens per request — and compaction/fan-out multipliers) are NOT individually quantified. CAVEAT THE OWNER MUST APPLY: the 96.3% figure comes from a 5-turn, 8-document READING demo. A coding agent additionally carries test output, compiler/linter errors, diffs, and far more reasoning at effort:xhigh. Treat it as directional evidence that tool results dominate — which is well-supported and consistent across sources — not as a calibrated breakdown for this product.
- **Quality risk:** N/A — measurement, not intervention.
- **Eng cost:** LOW and HIGH PRIORITY: instrument your own run before optimising anything. Use /v1/messages/count_tokens with context_management to preview savings without spending, and read context_management.applied_edits (cleared_tool_uses, cleared_input_tokens) plus cache_read_input_tokens / cache_creation_input_tokens from every response. The cookbook's first checklist item is exactly this: 'Measure baseline peak context and composition (file results vs. reasoning).'

Sources:
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- https://www.augmentcode.com/guides/ai-coding-cost-analysis-agent-token-spend
- https://platform.claude.com/docs/en/build-with-claude/context-editing.md

### `asserted-credible` — Just-in-time retrieval — pointers in context, payloads on disk

- **Claimed saving:** Unquantified as a standalone technique. Mechanically it is what produces the cookbook's measured 48–50% peak-context reductions, since file-read results were 96.3% of the baseline context.
- **Evidence:** Anthropic engineering, 'Effective context engineering for AI agents' (2025-09-29), asserted best practice with a named exemplar rather than a measurement. Pattern: rather than preprocessing all data upfront, agents maintain 'lightweight identifiers (file paths, stored queries, web links, etc.)' and load data at runtime. Claude Code is cited as the reference implementation, using targeted queries and bash commands to analyse large datasets without loading full objects into context. The memory-tool docs describe the same principle as the reason memory exists: 'Rather than loading all relevant information up front, an agent records what it learns in memory files and reads them back on demand.' Concrete coding-agent instances: grep/ripgrep for line-matches instead of reading whole files; head/tail/sed ranges instead of full file reads; view_range paging on memory files; storing build logs to disk and reading only the failing section.
- **Quality risk:** LOW, with one honest caveat. Information is not destroyed — it stays on disk and is retrievable. The residual risk is that the agent fails to retrieve something it needed and never knows it was missing, which is a recall failure rather than an information-loss failure. Counterweight from Chroma: loading the full document instead would itself degrade recall (the focused-vs-full LongMemEval gap), so full-load is not a safe default either.
- **Eng cost:** LOW-MEDIUM — mostly prompt and tool design: give the agent surgical read tools (ranged reads, grep, structured queries) and instruct it to prefer them over whole-file reads. Largely free if you are already exposing bash.

Sources:
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools

### `asserted-credible` — Layered configuration: clearing at 100k + compaction at 150k + memory (Anthropic's recommended stack)

- **Claimed saving:** Anthropic cookbook: 'Further reduction when used together with non-overlapping triggers' — explicitly NOT quantified for the combination. Individually measured on its demo: compaction 50% peak reduction, clearing 48%. The combined figure is asserted, not measured.
- **Evidence:** Anthropic cookbook, primary, with a concrete recommended config for long-horizon work: clear_tool_uses_20250919 at trigger 100,000 input tokens, keep 6 tool uses, clear_at_least 15,000 input tokens, exclude_tools ['memory']; plus compact_20260112 at trigger 150,000 with custom instructions. Stated rationale: 'Clearing fires first at 100K (low threshold to catch re-fetchable content early), compaction fires at 150K (catches reasoning/dialogue growth). The two work in layers without interfering.' Checklist rules: set the clearing trigger above your typical single-tool-call size but below 200K; keep 3–6 depending on whether re-fetching is cheap; set the compaction trigger 30–50K above the clearing trigger. NOTE MY DISAGREEMENT WITH THE VENDOR DEFAULT: clear_at_least 15,000 against a 100,000 trigger is a T/C ratio of ~6.7, which by the break-even formula needs ~64 turns at 5-min TTL (or ~107 at 1-hour) to repay the cache invalidation. That default is tuned for CONTEXT-WINDOW SURVIVAL, not for cost. If cost is the objective, raise clear_at_least substantially so each clearing event removes a large fraction of context.
- **Quality risk:** COMPOUNDING and under-measured. Each layer loses something different (clearing loses re-fetchable raw results; compaction loses obscure specifics — measured 0/3 retained), and no source measures the quality of all three layered together on a coding task. exclude_tools: ['memory'] is a necessary safeguard so the durable-state channel is never cleared. Note the ordering constraint if thinking-clearing is added: clear_thinking_20251015 must be listed first.
- **Eng cost:** Low to configure, medium to tune. Requires a representative workload and iteration against context_management.applied_edits feedback.

Sources:
- https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- https://platform.claude.com/docs/en/build-with-claude/context-editing.md
- https://platform.claude.com/docs/en/build-with-claude/compaction.md

### `folklore` — The claim that context editing is unsafe 'garbage collection without write barriers' (widely-circulated critique)

- **Claimed saving:** N/A — a criticism, not a technique. Included because the brief asked me to flag widely-repeated claims with no measured evidence, and this is the clearest example.
- **Evidence:** Chetan Conikee, Substack 'Beyond Boundaries', 2026-02-11. No institutional affiliation stated. Argument: clearing tool results and thinking blocks is GC without write barriers — the runtime cannot know 'what the agent's current reasoning depends on' because dependency tracking lives only in attention weights, not in any inspectable data structure. Cites five failure classes: orphaned state, premature collection, unsafe defaults, clearing despite opt-out, and semantic loss of ground truth needed to verify decisions built on summarised evidence. TWO REASONS TO DISCOUNT IT. (1) NO MEASUREMENTS — the piece presents zero experiments, zero token data, zero decision-quality data; every claim is an assertion resting on GitHub issues. (2) CATEGORY ERROR, which I verified directly: the issues cited are CLAUDE CODE product bugs, not API context-editing defects. I fetched issue #19530 — it is a Claude Code plan-mode UI bug (v2.1.12, macOS) where selecting 'Yes, and manually approve edits' clears context anyway; closed, labelled has-repro, 'this never worked', reported 2026-01-20. That is a real bug in a consumer UI affordance and says nothing about whether the clear_tool_uses_20250919 API strategy loses information. The GC analogy is conceptually elegant but is applied to a domain where liveness semantics do not transfer — and it is contradicted in direction by Chroma's measured finding that stale distractors actively HARM performance, i.e. some 'premature collection' is beneficial.
- **Quality risk:** The critique's own recommendations are nonetheless sensible and cost nothing to adopt: clear only at safe task boundaries, use exclude_tools as a crude write barrier, use pause_after_compaction to inspect and augment summaries, and proactively crystallise knowledge into durable artefacts before context pressure builds. That last one is just the memory/progress-file pattern, which IS evidenced. Take the recommendations; do not take the risk assessment as measured.
- **Eng cost:** N/A

Sources:
- https://conikeec.substack.com/p/context-editing-looks-like-a-feature
- https://github.com/anthropics/claude-code/issues/19530

### `asserted-credible` — Anthropic's headline '84% token reduction / 29% / 39% performance improvement' figures

- **Claimed saving:** 84% token reduction on a 100-turn web search eval; 29% performance improvement from context editing alone; 39% from memory tool + context editing combined.
- **Evidence:** Anthropic blog, 2025-09-29, VENDOR SELF-REPORTED on an eval Anthropic names only as 'our internal agentic search evaluation' — no benchmark name, no dataset, no baseline configuration, no confidence intervals, no independent replication located. I searched for third-party replication and found none. THREE REASONS THE 84% DOES NOT TRANSFER TO THIS PRODUCT'S BILL. (1) It is a WEB SEARCH workload; web search results are large, self-contained and highly clearable, whereas coding agents carry diffs, test output and errors with different clearability. (2) It is a TOKEN VOLUME reduction, and at 85% cache-hit the tokens removed are mostly $0.50/MTok cache reads, so an 84% volume cut is far less than an 84% cost cut. (3) It ignores the cache-write cost that Anthropic's own context-editing doc discloses elsewhere. The framing in the blog — agents 'complete workflows that would otherwise fail due to context exhaustion' — reveals the real value proposition: these features exist primarily to prevent RUN FAILURE, and only incidentally to save money. For this owner that is the right reason to adopt them, since failure avoidance is the larger lever anyway.
- **Quality risk:** The 29%/39% figures are performance IMPROVEMENTS, which is genuine evidence that context management is quality-positive rather than a degradation — but on an unnamed internal eval with no methodology published, so weight accordingly. Do not cite these numbers to stakeholders as measured.
- **Eng cost:** N/A — this is a credibility assessment of a widely-repeated statistic.

Sources:
- https://claude.com/blog/context-management
- https://platform.claude.com/docs/en/build-with-claude/context-editing.md


---

# W4c-tool-output

**Summary.** ## Lens: tool output and retrieval discipline

### 1. The cost arithmetic, verified and corrected (my derivation from list prices)

The owner's key observation holds, and it holds *structurally*, not by coincidence. Every Claude model in the roster prices output at exactly 5x input and cache-read at 0.1x input. So the cost of one output token measured in input tokens is:

`ratio = 5 / (h x 0.1 + (1-h))` where h = cache hit rate

- h=0%: 5.0x  |  h=50%: 9.1x  |  h=85%: **21.3x**  |  h=95%: 34.5x

This is identical for Opus 5 ($5/$25/$0.50), Sonnet 5 intro ($2/$10/$0.20) and Sonnet 5 post-September ($3/$15/$0.30). **The better your cache hit rate gets, the more the balance tips toward output-token reduction.** (Note: I recomputed the 95% case; an earlier reviewer figure of 25.6x is an arithmetic slip — 0.95x0.1+0.05 = 0.145, and 5/0.145 = 34.5.)

Reconciling the owner's $31.72 input figure: 47.5M tokens at 85% cache costs $55.8 if all-Opus and $22.3 if all-Sonnet-intro. Solving, $31.72 implies **~13.3M input tokens on Opus (28%) and ~34.2M on Sonnet (72%)**. The $33.25 output figure implies ~0.55M output tokens on Opus (22%) and ~1.95M on Sonnet. Those two splits are consistent with each other, so the model is internally coherent. Blended effective prices: **input $0.668/MTok, output $13.30/MTok — a 19.9x observed ratio** (slightly under the structural 21.3x because Opus carries a larger share of input than of output).

**Consequence for this lens, stated plainly:** cutting 1M tokens of tool output saves ~$0.67. Cutting 50k tokens of model output saves the same. Tool-output work must operate at millions-of-tokens scale to move the bill. It usually can — but the interventions that also cut *turns*, *output tokens*, or *failed runs* are worth more per unit of engineering.

### 2. Do not double-count amplification — there are two distinct levers

47.5M input tokens across 680 calls is **69.9k average context per call**. That 47.5M is *already* the sum of context sizes across calls, i.e. it already includes re-reads. The unique tool-result bytes generated in a ticket are plausibly only 1–3M; the 47.5M is those bytes multiplied by how many turns each one survives in its thread. So:

- **Lever A — emit less**: truncation, failure-only filtering, programmatic tool calling, subagent isolation, ranged reads. Reduces the base.
- **Lever B — evict sooner**: context editing (`clear_tool_uses`), `clear_tool_inputs`, compaction. Reduces the multiplier *without* reducing what the agent can see at the moment it needs it.

Lever B is under-appreciated and is the only one that is close to blindness-free, because the content was present when it mattered and is removed only afterwards. It deserves to rank near the top, not near the bottom.

**Eviction vs cache arithmetic (mine):** clearing N tokens saves `N x remaining_turns x $0.50/MTok` (Opus cache read) but forces a re-write of the reshaped prefix at `$6.25/MTok` (cache write = 1.25x base). Break-even is roughly `remaining_turns > 12.5 x (retained_prefix / N)`. In a 5-hour, 680-call run there are usually many turns remaining, so eviction pays — but only if you clear in large chunks. `clear_at_least` is the knob that enforces this.

### 3. The framing risk that would sink this report

**Every threshold I verified below is Claude Code behaviour, not Claude API behaviour.** The owner is building a bespoke orchestrator against the raw Messages API. They inherit *none* of this for free:

| Guard | Claude Code default | Owner gets it? |
|---|---|---|
| Bash output | 30,000 chars, then full output saved to file, model gets path + short preview; `BASH_MAX_OUTPUT_LENGTH` up to a hard 150,000 ceiling | No — must build |
| MCP tool output | warn at 10,000 tokens, cap at 25,000 (`MAX_MCP_OUTPUT_TOKENS`); per-tool `anthropic/maxResultSizeChars` override | No |
| Any tool response | Anthropic's own tools guidance cites a 25,000-token cap | No |
| Read | paginates with a `PARTIAL view` notice and `offset`/`limit` guidance; errors rather than OOMing on huge single lines | No |
| Glob | capped at 100 files with a truncation flag | No |
| Hook output | 10,000 chars, then spilled to file with preview + path | No |
| MCP tool schemas | deferred by default (tool search on unless `ENABLE_TOOL_SEARCH=false`) | No — must opt in via `defer_loading` |

Treat the table as a **reference implementation to copy**, and copy it in week one. The single highest-value line in it is the bash pattern: cap at N, write the full output to a file, return `preview + path`. It preserves recoverability (the agent can grep the file) while bounding what enters context.

### 4. Ranked by TOKENS SAVED (the brief's requested ordering), with blindness risk

Volume estimates are mine, scaled to a 47.5M-input ticket; treat as order-of-magnitude.

| # | Intervention | Est. input tokens saved | Est. $ saved | What the agent can no longer see |
|---|---|---|---|---|
| 1 | **Subagent isolation of exploration, log reading, test runs** | 10–20M | $7–13 | Raw evidence behind the summary. If the summary omits a detail needed 200 turns later, the parent must re-derive it. Anthropic's own worked example compresses 6,100 tokens of file reads to a 420-token return — a 93% cut, and 93% of the detail is gone. |
| 2 | **Context editing / `clear_tool_uses` (evict sooner)** | 8–20M | $5–13 | Nothing *at the time of use*; older tool results become placeholders. Risk is an agent that revisits a file it read 100 turns ago and must re-read it — a partial refund of the saving. Set `exclude_tools` for anything genuinely load-bearing (spec, acceptance criteria). |
| 3 | **Programmatic tool calling / code-as-orchestration** | 5–15M | $3–10 | Intermediate results never enter context, so the model cannot notice anomalies in data it filtered programmatically. A buggy filter fails silently. |
| 4 | **Hard cap + file-offload on every tool result** | 3–10M | $2–7 | Only the tail of long outputs, and only until the agent greps the file. Lowest-blindness intervention in the table *provided the path is returned*. If you truncate without a path, blindness is total for the discarded tail. |
| 5 | **Failure-only test/build reporting** | 2–8M | $1.5–5 | Passing tests, and context lines around failures. A naive `grep -A 5 FAIL` cuts assertion diffs mid-way and hides flaky-test patterns and timing/ordering signals. This is the highest blindness-per-token in the table. |
| 6 | **Search-not-stuff: grep/glob + ranged reads instead of whole-file loads** | 3–8M | $2–5 | Code that doesn't match the query lexically. Cursor measured this cost: grep-only was 12.5% less accurate than grep+semantic. |
| 7 | **Tool schema deferral (`defer_loading` / tool search)** | 1–5M (fixed prefix, re-read every call) | $0.7–3 | Tools it never discovers. Anthropic's data says accuracy *rises*, not falls — this is the rare unambiguous win. |
| 8 | **Concise tool response formats (drop IDs, timestamps, nulls)** | 1–4M | $0.7–3 | Technical identifiers needed for follow-up calls. Anthropic's own example keeps the fields required for downstream calls and still cuts 66%. |
| 9 | **`clear_tool_inputs: true`** | 1–4M | $0.7–3 | The *arguments* of old calls — which for a coding agent means full file bodies on Write and full patch bodies on Edit. Removing them means the agent can't recall exactly what it wrote without re-reading the file. |
| 10 | **Output-token discipline: diffs not whole files, no preamble, no self-imposed re-verification** | 0.3–1M **output** | **$4–13** | Narration the orchestrator may use for its own state tracking. On weaker models, diff formats measurably *reduce* correctness. |

### 5. Ranked by DOLLARS SAVED — the order changes

Because of the 21.3x ratio, item 10 jumps from last to roughly **third**: 0.5M fewer output tokens ≈ 7.5M fewer input tokens in cost terms. The dollar order is approximately: **1 (subagents) → 2 (context editing) → 10 (output discipline) → 3 (PTC) → 4 (caps) → 6 (search) → 5 (log filtering) → 8 → 7 → 9.**

Where the two orders diverge, the dollar order is the one to build against — with one exception: item 4 (hard caps) should be built first regardless of rank, because it is cheap, near-blindness-free, and bounds the tail risk of a single runaway log dump.

### 6. Blindness risk is a cost line, not a caveat

The brief gives a 1.3–1.5x retry multiplier. On a $65 ticket, moving from 1.3x to 1.4x costs **~$6.50**. Cutting 20% of all input tokens saves **~$6.35**. These are the same order of magnitude. **Any tool-output intervention that raises the non-convergence rate by even a few percentage points has negative expected value.** That is the whole argument for gating each of these behind an A/B on completed tickets rather than on token counts.


**Could not verify:**

- NO published instrumented breakdown of token consumption by source for a real long-horizon coding-agent run exists, from any vendor or practitioner. The best available are Anthropic's hand-authored context-window simulation (from which I derive ~46-50% tool results for a short session — illustrative, NOT measured) and minusx.ai's network-log reverse engineering of Claude Code's fixed prompt block (~2,800 system + ~9,400 tools, Aug 2025). Close this internally, not by more searching: log per-call input_tokens plus a token count on every tool_result block, bucketed by tool name, into your own traces. One day of work, and it turns the unanswerable literature question into an owned metric that also tells you which of the interventions below to build first.
- NO measurement exists anywhere for failure-only test/log filtering, despite Anthropic shipping the hook script and asserting 'tens of thousands of tokens to hundreds'. There is also no agent-specific test-reporter tooling with published token or accuracy numbers. This is a heavily-repeated practice resting entirely on plausibility.
- NO measurement exists for the 'caveman mode' ~75% claim. The peer-reviewed adjacent work (LLMLingua) compresses input with an auxiliary model and does not test terse human-authored style, does not address output tokens, and would fight prompt caching.
- NO vendor or practitioner publishes a PRICE-WEIGHTED (dollar) result for any of these techniques on 2026 models. Anthropic's dynamic-filtering post is the sole exception and it reports the awkward result — cost down on Sonnet 4.6, up on Opus 4.6. Every other figure in this report is a token count or an accuracy score, and token counts are not dollars once thinking and cache dynamics are involved.
- Aider's edit-format evidence — the only rigorous public measurement of diff-vs-whole-file — is GPT-3.5/GPT-4-era (2023-2024) and shows the effect INVERTS on weaker models. Nobody has re-run it on Sonnet 5 or Opus 5. The direction is safe to assume; the magnitudes are not.
- Aider's repo map, LSP/symbol navigation (Serena, Claude Code code-intelligence plugins) — all three publish mechanisms and zero token or accuracy measurements. The 1,024-token map budget is read from source, so the mechanism is certain, but its value is entirely unmeasured.
- No published measurement of clear_tool_inputs, which for a coding agent controls whether full file bodies and patch bodies persist in history. Given Write/Edit inputs frequently exceed their outputs, this could be one of the largest single levers and it is completely unstudied.
- Cursor's semantic-vs-grep result (+12.5% accuracy) is a vendor measuring its own paid feature, and reports no token cost. Anthropic's pro-grep position is asserted with no numbers. The cheaper-per-token question for code retrieval is genuinely open in 2026.
- Context rot's 18-model study predates the current generation; Anthropic asserts Opus 5 holds quality across its 1M window. Nobody has independently re-run a long-context degradation study on 2026 frontier models, so the size of the quality penalty for large contexts today is unknown.

### `measured` — Cost-structure verification: one output token costs 21.3 input tokens at 85% cache hit (structural, not incidental)

- **Claimed saving:** Not a saving — a weighting rule. ratio = 5/(h*0.1 + (1-h)); 5.0x at h=0, 9.1x at h=0.5, 21.3x at h=0.85, 34.5x at h=0.95. Identical for Opus 5, Sonnet 5 intro and Sonnet 5 post-September because all three price output at 5x input and cache-read at 0.1x input. Observed blended ratio on the owner's numbers is 19.9x ($13.30/MTok output vs $0.668/MTok input).
- **Evidence:** My own arithmetic from Anthropic list prices supplied in the brief and confirmed on the effort/pricing docs. Reconciliation: 47.5M input at 85% cache costs $55.8 all-Opus, $22.3 all-Sonnet-intro; the stated $31.72 implies ~13.3M input tokens on Opus (28%) and ~34.2M on Sonnet (72%). The stated $33.25 output implies ~0.55M output tokens on Opus (22%). The two splits are mutually consistent, so the cost model audits clean.
- **Quality risk:** None — it is arithmetic. The risk is misreading it: it does NOT mean tool-output work is pointless, it means tool-output work must operate at millions-of-tokens scale to match a modest output-token cut.
- **Eng cost:** Zero. One spreadsheet cell.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://code.claude.com/docs/en/costs

### `asserted-credible` — Quantifying the problem (A): what fraction of a coding-agent run is tool results

- **Claimed saving:** n/a — diagnostic. Anthropic's published interactive context-window simulation of a Claude Code session assigns: system prompt 4,200; auto memory 680; environment info 280; MCP tool names (deferred) 120; skill descriptions 450; user CLAUDE.md 320; project CLAUDE.md 1,800 (fixed startup block = 7,850 tokens). Session events: file reads 2,400 + 1,100 + 1,800 + 1,600; grep 600; npm test output 1,200; rule injections 380 + 290; hook outputs 120 + 100; edits 400 + 600; subagent return 420. Summing, tool results are ~46-50% of that session's context. Separately: avg context per call on the owner's numbers is 47.5M/680 = 69.9k tokens, against a fixed prefix of only ~8-12k — so ~58k per call is accumulated conversation, dominated by tool results and prior model output.
- **Evidence:** Anthropic's own authored simulation on code.claude.com/docs/en/context-window (numbers are hand-authored for teaching, NOT instrumented from a real run). minusx.ai's network-log reverse engineering of Claude Code (Vivek Aithal, 2025-08-21) independently puts the system prompt at ~2,800 tokens and tool definitions at ~9,400 tokens, corroborating the order of magnitude of the fixed block, and reports 'Edit is the most frequent tool, followed by Read and TodoWrite' without token attribution. No vendor or practitioner has published an instrumented per-source token breakdown for a long-horizon coding-agent run.
- **Quality risk:** n/a
- **Eng cost:** To close the gap properly: log per-call input_tokens plus a token count for every tool_result block, bucketed by tool name, into your own traces. One day of work, and it turns an unanswerable literature question into an owned metric.

Sources:
- https://code.claude.com/docs/en/context-window
- https://minusx.ai/blog/decoding-claude-code/

### `measured` — Programmatic tool calling (PTC): model writes code in a sandbox that calls your tools; only the final result enters context

- **Claimed saving:** 'Average usage dropped from 43,588 to 27,297 tokens, a 37% reduction on complex research tasks.' Accuracy rose at the same time: internal knowledge retrieval 25.6% -> 28.5%, GIA benchmarks 46.5% -> 51.2%. On BrowseComp and DeepSearchQA, adding PTC on top of basic search tools 'improved performance by an average of 11% while using 24% fewer input tokens'.
- **Evidence:** Anthropic engineering, 'Advanced tool use', 2025-11-24, with named benchmarks and before/after deltas. Corroborated by the API reference page. This is the strongest measured evidence in the whole survey for a tool-output intervention that cuts tokens AND raises accuracy simultaneously.
- **Quality risk:** Two-sided. Measured accuracy went UP on the cited benchmarks. But the model never sees intermediate results, so a silently wrong filter in generated code produces a confident wrong answer with no trace in context. Documented constraints: tools with strict:true are unsupported; tool_choice cannot force a programmatic call; disable_parallel_tool_use is unsupported; input schemas with recursive $ref fail with 'Circular $ref detected'; and Anthropic states it does not help 'strictly sequential workflows where each call depends on Claude reasoning over the previous result' — which is a large fraction of a coding agent's inner loop.
- **Eng cost:** High if self-hosted (secure sandbox, resource limits, monitoring — Anthropic explicitly calls this out as operational overhead). Moderate if using Anthropic's code execution tool, but that adds its own container pricing and a ZDR question.

Sources:
- https://www.anthropic.com/engineering/advanced-tool-use
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool

### `measured` — HEADLINE CAVEAT — dynamic filtering: 24% fewer input tokens, +11% accuracy, and yet price-weighted cost ROSE on Opus

- **Claimed saving:** BrowseComp: Sonnet 4.6 33.3% -> 46.6%, Opus 4.6 45.3% -> 61.6%. DeepsearchQA F1: Sonnet 4.6 52.6 -> 59.4, Opus 4.6 69.8 -> 77.3. Average accuracy +11%, input tokens -24%. Then the crucial line: 'Price-weighted token costs varied by model; Sonnet 4.6 showed cost decreases while Opus 4.6 showed increases.'
- **Evidence:** Anthropic, 'Improved web search with dynamic filtering', 2026-02-17, evaluated with and without dynamic filtering and no other tools enabled, on two established benchmarks.
- **Quality risk:** Quality improved. COST did not, on the expensive model. The mechanism is exactly the 21.3x ratio at work: filtering moves work out of raw input and into code execution plus reasoning, and reasoning bills as output at 5x. For an Opus orchestrator this can invert the saving. This is the single most decision-relevant number found: it is the owner's two-axis framing proven by the vendor's own data, and it means 'fewer input tokens' must never be accepted as a proxy for 'cheaper' without a price-weighted measurement.
- **Eng cost:** Low if using Anthropic's web search/fetch (dynamic filtering is provisioned automatically and code execution is free when used with web_search_20260209 / web_fetch_20260209 or later). Moderate to replicate for your own tools.

Sources:
- https://claude.com/blog/improved-web-search-with-dynamic-filtering
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool

### `asserted-credible` — Code execution with MCP (progressive tool disclosure via a filesystem of tool files)

- **Claimed saving:** 'reduces the token usage from 150,000 tokens to 2,000 tokens—a time and cost saving of 98.7%'
- **Evidence:** Anthropic engineering, 2025-11-04. IMPORTANT: this is a single illustrative worked example (a Google Drive transcript -> Salesforce record workflow), not a benchmark, with no methodology and no error bars. Simon Willison's contemporaneous write-up endorses the design ('This all looks very solid to me... a sensible way to take advantage of the strengths of coding agents') while flagging 'There's one catch: Anthropic outline the proposal in some detail but provide no code to execute on it!' Treat 98.7% as an existence proof of the mechanism's ceiling, not as an expected value.
- **Quality risk:** Unknown — no accuracy measurement accompanies the figure. The 37% PTC number is the same idea measured properly; prefer it when reasoning about expected outcomes. Anthropic itself notes 'code execution introduces its own complexity' and requires 'a secure execution environment with appropriate sandboxing, resource limits, and monitoring'.
- **Eng cost:** High. Sandbox, filesystem layout of tool definitions, and a code-generation loop.

Sources:
- https://www.anthropic.com/engineering/code-execution-with-mcp
- https://simonwillison.net/2025/Nov/4/code-execution-with-mcp/

### `asserted-credible` — Subagent context isolation — verbose exploration happens in a throwaway context, only a distilled summary returns

- **Claimed saving:** Anthropic's published session walkthrough: 'The subagent read 6,100 tokens of files. You got a 420-token result. That's the context savings.' — a 93% cut, ~14.5x compression. The context-engineering post generalises: a subagent may use 'tens of thousands of tokens or more, but returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)'. Claude Code docs name this the top use: 'One of the most effective uses for subagents is isolating operations that produce large amounts of output. Running tests, fetching documentation, or processing log files can consume significant context.'
- **Evidence:** Anthropic docs and engineering blog (2025-09-29 and current Claude Code docs). The 6,100 -> 420 figure is authored for a teaching simulation, not instrumented. Counterweight from the same vendor: 'agents typically use about 4x more tokens than chat interactions, and multi-agent systems use about 15x more tokens than chats' (2025-06-13), and Claude Code's cost page states agent teams 'use approximately 7x more tokens than standard sessions when teammates run in plan mode'. So subagents save the PARENT's context while raising TOTAL spend.
- **Quality risk:** Real and structural. The parent loses the raw evidence; if the summary omits something needed later, the work is redone. Anthropic's own Opus 5 prompting guidance warns the model 'delegates to subagents more readily than prior models' and that delegation 'multiplies cost and time when applied to small tasks', recommending explicit caps: 'Do not delegate work you can finish yourself in a handful of tool calls, and do not use subagents to verify or double-check your own work.'
- **Eng cost:** Low-moderate — the owner already has an orchestrator/subagent split. The work is in the return contract: force a fixed-schema summary plus file paths, not free prose.

Sources:
- https://code.claude.com/docs/en/context-window
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://code.claude.com/docs/en/sub-agents
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://code.claude.com/docs/en/costs
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### `measured` — Context editing (clear_tool_uses_20250919) — server-side eviction of old tool results

- **Claimed saving:** 'reducing token consumption by 84%' in a 100-turn web search evaluation. 'Context editing alone delivered a 29% improvement' in performance over baseline; 'combining the memory tool with context editing improved performance by 39% over baseline'. Defaults: trigger at 100,000 input tokens; keep the last 3 tool uses; clear_at_least unset; exclude_tools unset; clear_tool_inputs false.
- **Evidence:** Anthropic, 2025-09-29, on an internal agentic-search eval set. The 84% is specifically attributed to a 100-turn run where context editing 'enabled agents to complete workflows that would otherwise fail due to context exhaustion' — i.e. part of the gain is completing tasks that previously failed, which for this owner also attacks the 1.3-1.5x retry multiplier.
- **Quality risk:** Moderate but bounded. Cleared results are replaced with placeholder text so the model knows content was removed rather than hallucinating around a gap. Measured performance went UP, not down. The real risk is a coding agent re-reading a file it already read, partially refunding the saving. CRITICAL for this owner: clearing 'invalidates cached prompt prefixes'. At an 85% cache-hit assumption this is a direct conflict. My arithmetic: clearing N tokens saves N x remaining_turns x $0.50/MTok (Opus cache read) against a re-write of the retained prefix at $6.25/MTok (cache write = 1.25x base), so break-even is roughly remaining_turns > 12.5 x (retained_prefix / N). Clear in big infrequent chunks via clear_at_least, never in a trickle.
- **Eng cost:** Low. A beta header (context-management-2025-06-27) and a config block. The count_tokens endpoint previews savings before you commit, returning original_input_tokens vs input_tokens.

Sources:
- https://claude.com/blog/context-management
- https://platform.claude.com/docs/en/build-with-claude/context-editing

### `folklore` — clear_tool_inputs — the under-ranked half of eviction, specific to coding agents

- **Claimed saving:** Unquantified. Defaults to false, meaning only tool RESULTS are cleared and tool ARGUMENTS persist forever in history.
- **Evidence:** Anthropic context-editing reference: 'When false (default), only tool results are cleared. Set true to also clear tool call parameters.' No published measurement of the delta.
- **Quality risk:** Higher than clearing results, and specifically for a coding agent: tool inputs are where the full file bodies live on a Write call and the full patch bodies live on an Edit call. Those are frequently larger than the results they produce (an Edit returns a short confirmation; its input carries the whole patch). Clearing them means the agent cannot recall exactly what it wrote without re-reading the file from disk — which is cheap and reliable, so the trade is usually good. Untested at scale; gate it behind an eval.
- **Eng cost:** Trivial — one boolean. The measurement to justify it is the real work.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/context-editing

### `asserted-credible` — Hard output caps with file offload: return preview + path, never the whole thing (C)

- **Claimed saving:** Unquantified as a percentage, but the thresholds are concrete. Claude Code: bash output capped at '30,000 characters by default. When a command produces more than that, Claude Code saves the full output to a file in the session directory and gives Claude the file path plus a short preview from the start... Raise the limit with BASH_MAX_OUTPUT_LENGTH, up to a hard ceiling of 150,000 characters.' MCP output: warning at 10,000 tokens, 'the default maximum is 25,000 tokens', overridable per-tool with the anthropic/maxResultSizeChars annotation. Hook output: 'capped at 10,000 characters... Output exceeding this limit is saved to a file and replaced with a preview and file path.' Anthropic's tool-writing guidance states Claude Code 'restricts tool responses to 25,000 tokens by default'. Read paginates with a PARTIAL view notice plus offset/limit guidance. Glob caps at 100 files with a truncation flag the model can see.
- **Evidence:** Claude Code tools reference, MCP docs, hooks docs, and Anthropic engineering 'Writing effective tools for agents' (2025-09-11), which recommends 'implementing some combination of pagination, range selection, filtering, and/or truncation with sensible default parameter values'.
- **Quality risk:** The lowest-blindness intervention available, ON ONE CONDITION: the path must be returned so the agent can grep the full artifact when it needs to. Truncation without a recovery path is genuine information loss and will show up as retries. The truncation flag on Glob and the PARTIAL view notice on Read matter for the same reason — the agent must KNOW it was truncated, or it will reason as if it saw everything.
- **Eng cost:** Low, and the owner must build all of it — these are Claude Code behaviours, not API behaviours. A bespoke orchestrator on the raw Messages API inherits none of them.

Sources:
- https://code.claude.com/docs/en/tools-reference
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/hooks
- https://www.anthropic.com/engineering/writing-tools-for-agents

### `asserted-credible` — Failure-only test and log reporting via a pre/post-tool filter (F)

- **Claimed saving:** 'Instead of Claude reading a 10,000-line log file to find errors, a hook can grep for ERROR and return only matching lines, reducing context from tens of thousands of tokens to hundreds.' Anthropic ships a working PreToolUse hook that rewrites test commands to `$cmd 2>&1 | grep -A 5 -E '(FAIL|ERROR|error:)' | head -100`. PostToolUse hooks can rewrite results wholesale via hookSpecificOutput.updatedToolOutput.
- **Evidence:** Claude Code cost-management docs (mechanism + working script) and hooks reference. THIS IS THE FINDING: the mechanism is fully documented by the vendor and the saving is ASSERTED with zero measurement — no benchmark, no before/after token counts, no accuracy check. I could not find any published measurement of failure-only test reporting for agents from any vendor or practitioner, nor any agent-specific test-reporter tooling with published numbers. A widely-repeated technique with no measured evidence behind it.
- **Quality risk:** The highest blindness-per-token in this survey, and it is under-discussed. `grep -A 5` truncates assertion diffs mid-way; `head -100` silently drops later failures; failure-only output hides which tests PASSED (so the agent cannot tell a regression from a pre-existing failure), hides timing and ordering signals that diagnose flakiness, and hides setup/teardown errors that do not match the pattern. For an unattended run that 'returns only when the product is complete and TESTED', a filter that hides a flaky test is a correctness bug in the product, not a context optimisation. Prefer structured reporters (JSON/JUnit XML parsed by your harness) over regex over human-readable output, and cap per-failure detail rather than per-run detail.
- **Eng cost:** Low to build, high to build SAFELY. Budget the eval, not the script.

Sources:
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/hooks

### `measured` — Tool schema cost and deferred loading / tool search (G)

- **Claimed saving:** 'A typical multiserver setup (GitHub, Slack, Sentry, Grafana, and Splunk) can consume ~55k tokens in definitions before Claude does any work. Tool search typically reduces this by over 85 percent, loading only the 3-5 tools Claude needs.' Anthropic's engineering post: 'an 85% reduction in token usage while maintaining access to your full tool library', and 'preserves 191,300 tokens of context compared to 122,800 with Claude's traditional approach'. Accuracy IMPROVED: 'Opus 4 improved from 49% to 74%'; 'Opus 4.5 improved from 79.5% to 88.1% with Tool Search Tool enabled.' Independently, tool-selection accuracy 'degrades once you exceed 30-50 available tools'. minusx measured Claude Code's tool block at ~9,400 tokens in Aug 2025.
- **Evidence:** Anthropic tool-search reference plus 'Advanced tool use' (2025-11-24), with named model/accuracy deltas. Claude Code now defers MCP tools by default (ENABLE_TOOL_SEARCH unset = all deferred; auto = load upfront if they fit in 10% of the context window).
- **Quality risk:** The rare unambiguous win: fewer tokens AND higher accuracy, because a smaller live toolset is easier to select from. Two mechanical caveats: (1) you still send every tool definition in the request on every call — deferral controls what enters CONTEXT, not what you transmit; (2) a tool with defer_loading:true cannot carry cache_control (400 error), so put the cache breakpoint on a non-deferred tool. Anthropic explicitly notes deferred tools are excluded from the system-prompt prefix so 'The prefix is untouched, so prompt caching is preserved' — unlike context editing, this one does not fight your cache. Keep the 3-5 hottest tools non-deferred.
- **Eng cost:** Low. Set defer_loading on cold tools, add a tool_search_tool_regex/bm25 entry, keep hot tools eager. Also: prefer CLI tools (gh, aws, gcloud) over MCP servers where possible — Anthropic notes they 'don't add any per-tool listing'.

Sources:
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://www.anthropic.com/engineering/advanced-tool-use
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/costs
- https://minusx.ai/blog/decoding-claude-code/

### `measured` — Concise vs detailed tool response formats (strip low-signal fields)

- **Claimed saving:** Anthropic's worked Slack example: DETAILED response = 206 tokens, CONCISE response = 72 tokens — roughly one third, a ~66% reduction, 'while maintaining functionality for downstream tool calls'.
- **Evidence:** Anthropic engineering, 'Writing effective tools for agents', 2025-09-11. A single worked example, but with exact token counts and an explicit statement that the concise form retains the fields needed for follow-up calls. Their evaluation methodology is described: realistic multi-step tasks with dozens of tool calls, measuring 'accuracy, runtime, tool call counts, token consumption, and error rates' against held-out test sets.
- **Quality risk:** Low if you keep the identifiers needed for chaining (IDs, paths, line numbers) and drop only decoration (timestamps, nulls, display names, MIME types, ETags). High if you strip identifiers — the agent then cannot address the thing it just found, and burns a round trip re-finding it. Expose it as a response_format enum so the agent can ask for detail when it genuinely needs it.
- **Eng cost:** Low, and it applies to every tool the owner writes. Highest saving-per-hour item in the survey for a bespoke harness.

Sources:
- https://www.anthropic.com/engineering/writing-tools-for-agents

### `measured` — Search instead of stuffing: agentic grep/glob just-in-time retrieval vs embedding-based indexing (D)

- **Claimed saving:** Contested, and the 2026 evidence genuinely cuts both ways. FOR grep: Anthropic states Claude Code 'employs both — uploading CLAUDE.md files initially while using grep and glob for dynamic retrieval', described as 'effectively bypassing the issues of stale indexing and complex syntax trees'; it also concedes 'Runtime exploration is slower than retrieving pre-computed data.' AGAINST grep-only: Cursor measured semantic search giving 'on average 12.5% higher accuracy in answering questions (6.5%-23.5% depending on the model)' versus a grep-only toolset, plus code retention +0.3% overall and +2.6% in codebases over 1,000 files, and 2.2% more dissatisfied follow-ups when semantic search was removed.
- **Evidence:** Anthropic 'Effective context engineering' (2025-09-29, asserted, no numbers) vs Cursor (2025-11-06, offline evals on Cursor Context Bench PLUS online A/B tests on real users — the more rigorous of the two, though a vendor measuring its own paid feature). Cursor's own conclusion is hybrid: 'semantic search is currently necessary to achieve the best results, especially in large codebases', while 'combining grep with semantic search produces optimal outcomes'. Neither publishes token cost, so the cheaper-per-token question is genuinely unanswered.
- **Quality risk:** Grep-only blindness is specific and measurable: code that is semantically relevant but lexically different (a function named `refreshCredentials` when the agent greps `renewToken`). Cursor's 12.5% is the price of that blindness. Embedding-only blindness is different: stale indexes after edits, and chunk boundaries that split a function from its type. For a ONE-SHOT greenfield build ('build me a golf app') the repo is being written by the agent itself, so index staleness is maximal and grep on a small, self-authored tree is likely sufficient — the Cursor result is strongest at 1,000+ files, which a fresh ticket will not reach.
- **Eng cost:** Grep/glob: near zero (ripgrep). Semantic index: high (embedding pipeline, incremental re-indexing, storage), and largely wasted on a repo the agent just created.

Sources:
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://cursor.com/blog/semsearch

### `folklore` — Repo maps, AST/symbol indexes and LSP navigation (D/E)

- **Claimed saving:** Aider's repo map runs on a token budget: RepoMap initialises with map_tokens=1024 (the --map-tokens default, ~1,000 tokens), expanding via map_mul_no_files=8 when no files are in the chat, bounded by max_context_window minus 4,096 padding. It ranks identifiers with a graph algorithm over tree-sitter tags (multipliers: mentioned identifiers x10, long snake/camel names x10, references in chat files x50, underscore-prefixed x0.1, identifiers with >5 definitions x0.1) and binary-searches the tag count to hit the budget within a 15% error margin. Claude Code's cost docs claim code-intelligence (LSP) plugins mean 'A single go to definition call replaces what might otherwise be a grep followed by reading multiple candidate files.'
- **Evidence:** Aider's repomap docs and repomap.py source (the constants are read directly from code — high confidence in the MECHANISM). But: Aider publishes NO measurement of the repo map's effect on pass rate or token count, and its docs concede specific benefits 'aren't provided'. Claude Code's LSP claim is asserted with no number. Serena (oraios/serena, LSP-based symbol retrieval MCP) claims its symbolic tools are 'less error-prone and much more token-efficient than typical alternatives' and cites an agent's remark that 'cross-file renames, moves, and reference lookups that would cost me 8-12 careful, error-prone steps collapse into one atomic call' — but its evaluation over '~20 routine coding tasks' reports no token counts. A ~1,000-token structural map replacing multiple whole-file reads is plausibly a 10-50x saving on orientation, but nobody has published that number.
- **Quality risk:** A repo map shows signatures, not bodies — the agent sees that a function exists and what it takes, not what it does. That is usually the right trade for orientation and the wrong one for editing, which is why Aider expands the map 8x only when no files are in the chat. LSP go-to-definition is exact and near-blindness-free for typed languages, and unavailable for untyped ones.
- **Eng cost:** Repo map: moderate (tree-sitter grammars per language + a ranking pass). LSP: moderate, and language-server-per-language is real ongoing maintenance. Both are poor fits for a greenfield one-shot build where the code does not exist yet — they pay off during the later edit/debug phases.

Sources:
- https://aider.chat/docs/repomap.html
- https://github.com/Aider-AI/aider/blob/main/aider/repomap.py
- https://code.claude.com/docs/en/costs
- https://github.com/oraios/serena

### `measured` — Diffs and patches instead of whole files, for both reading and writing (E/H)

- **Claimed saving:** Aider's leaderboard states plainly: 'Models which can use one of the diff formats are much more efficient, using far fewer tokens', and diff-format models 'are able to edit larger files with less cost and without hitting token limits', whereas whole-file 'uses a lot of tokens and may limit how large a file can be edited' and 'significantly increases costs and latency compared to diff'. The one hard measurement: switching GPT-4 Turbo from SEARCH/REPLACE to unified diffs cut lazy coding 3x (lazy comments in 12 of 89 refactoring tasks -> 4 of 89) and lifted the score from '20% as a baseline' to 61%.
- **Evidence:** Aider (Paul Gauthier), unified-diffs post 2023-12-21, on a purpose-built 89-task Python refactoring benchmark with AST-based validation (parses as Python, target function exists at top level, AST node count verified so code was not replaced with comments). Rigorous for its era. CRITICAL CAVEAT: the magnitudes are GPT-3.5/GPT-4-era and do not transfer to Sonnet 5. The same benchmark family shows the INVERSE on weak models — GPT-3.5 scored 46% with whole-file and only ~19-30% with diff, and 'When GPT-3.5 is able to correctly generate the diff edit format, it often uses it in a pathological manner' by echoing entire files into both blocks. Aider also reports disabling flexible patch application produced 'a 9X increase in editing errors'.
- **Quality risk:** Real and model-dependent. Diff formats trade output tokens for edit-application failures; every failed patch is a retry, and retries are the 1.3-1.5x multiplier. The direction (diff = fewer output tokens) is robust and still asserted on Aider's current leaderboard; the magnitudes are stale. Measure edit-error rate per format on Sonnet 5 before committing — and invest in a forgiving patch applier, which is where the 9x figure says the value actually sits.
- **Eng cost:** Moderate. The edit tool is easy; the fuzzy/flexible patch applier that keeps error rates down is the real work.

Sources:
- https://aider.chat/2023/12/21/unified-diffs.html
- https://aider.chat/docs/leaderboards/edit.html
- https://aider.chat/docs/benchmarks.html

### `asserted-credible` — Output-token reduction by prompting: verbosity control, removing self-imposed verification, capping delegation (H)

- **Claimed saving:** Anthropic's Opus 5 prompting guide is unusually direct. On over-verification: 'If your prompt contains explicit verification instructions (include a final verification step for any non-trivial task, use a subagent to verify), remove them: instructions like these cause over-verification on Claude Opus 5, and removing them reduces wasted tokens with no loss in quality.' On self-correction: 'Avoid instructing re-checks it already performs (double-check your answer, re-verify before responding); like verification instructions, these compound with the model's own behavior and add cost without improving results.' On verbosity: 'Claude Opus 5's default user-facing responses run longer than prior Opus models'... To control response length, prompt for it explicitly', with a supplied conciseness instruction. On written artefacts: files it writes to disk 'are often longer than on prior models'. On delegation: 'Do not delegate work you can finish yourself in a handful of tool calls.'
- **Evidence:** Anthropic's model-specific prompting guide (current). Vendor-asserted with an explicit 'no loss in quality' claim but no published benchmark. The effort docs corroborate the mechanism: effort 'affects all tokens in the response, including text responses, tool calls and function arguments, and thinking', and at lower effort the model tends to 'combine multiple operations into fewer tool calls', 'make fewer tool calls', and 'proceed directly to action without preamble'. But note the Opus 5-specific limitation: 'Effort controls thinking volume, not visible response length: on Claude Opus 5, changing effort does not reliably shorten responses, so prompt for length instead.' Also: 'thinking enabled at low effort performs better than thinking disabled at similar cost', and disabling thinking on Opus 5 produces two documented failure artefacts (tool calls emitted as text that never run but persist in history, and leaked internal XML tags).
- **Quality risk:** The removal of verification instructions is the standout: vendor states explicitly it costs nothing in quality on Opus 5, and it is a pure output-token saving on the most expensive model. It is also the item most likely to be wrong if the owner's harness relies on that narration for state tracking — check what your orchestrator parses before deleting the narration it parses. Verbosity capping on user-facing prose is near-free. Suppressing preamble entirely has a documented downside on Opus 5 with thinking disabled.
- **Eng cost:** Trivial — prompt edits. Highest dollar-per-hour intervention in the survey, because at 21.3x, 0.5M fewer output tokens equals 10.6M fewer input tokens in cost terms.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
- https://platform.claude.com/docs/en/build-with-claude/effort

### `folklore` — 'Caveman mode' / ultra-compressed prompting style (the owner's cited example) — and its measured cousin

- **Claimed saving:** The ~75% token reduction claim for caveman-style prompt compression has NO published measurement I can find from any vendor, benchmark or credible practitioner write-up. That absence is the finding. The measured relative in this space is Microsoft's LLMLingua family: 'up to 20x compression with minimal performance loss'; LongLLMLingua reports 'improving RAG performance by up to 21.4%' while 'using only 1/4 of the tokens'.
- **Evidence:** LLMLingua (EMNLP 2023), LongLLMLingua (ACL 2024), LLMLingua-2 (ACL 2024 Findings) — peer-reviewed, with benchmarks. But they compress the INPUT using a small auxiliary model to score and drop tokens; they say nothing about a human-authored terse style, and nothing about output tokens. Note the direction of the mismatch: for this owner, input is only ~1/20th as expensive per token as output, so even a spectacular input-compression result is worth less than a modest output cut. Applying LLMLingua to a 47.5M-token input stream at 85% cache would also fight the cache: compressed prompts differ every turn, destroying prefix reuse.
- **Quality risk:** For an ultra-terse HOUSE STYLE in system prompts: low risk, low reward — system prompts are the most-cached, cheapest tokens you own. Compressing them saves the least and risks instruction-following most. For terse MODEL OUTPUT: that is really the verbosity finding above, which does have vendor backing. The genuinely dangerous version is compressing tool results or specs, where dropped articles and connectives change meaning in ways that are invisible until the build is wrong. Recommend: apply terseness to what the model EMITS, never to what it READS.
- **Eng cost:** Trivial for prompt style; high and cache-hostile for a real compressor in the loop.

Sources:
- https://github.com/microsoft/LLMLingua
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### `measured` — The quality argument for trimming tool output: long context measurably degrades accuracy (context rot)

- **Claimed saving:** No token saving — this is the quality axis, and it points the same way as the cost axis for once. Across 18 models (Claude Opus 4, Sonnet 4, Haiku 3.5; GPT-4.1, o3, GPT-4o; Gemini 2.5 Pro/Flash; Qwen3), 'model performance varies significantly as input length changes, even on simple tasks'. Degradation is worse when needle-question semantic similarity is low, distractors amplify non-uniformly at longer lengths, and even 'the most capable models' are sensitive to input structure.
- **Evidence:** Chroma technical report, 2025-07-14, using extended NIAH variants, LongMemEval (~113k tokens) and a repeated-words replication task. Independent of the model vendors. CAVEAT: the models tested are a generation old, and Anthropic now claims Opus 5's 'instruction following, tool calling, and reasoning stay consistent throughout' its 1M window — an unverified vendor claim that directly contradicts the extrapolation.
- **Quality risk:** Inverted: this is evidence that NOT trimming carries a quality cost. A 47.5M-token ticket that lets contexts run to hundreds of thousands of tokens is paying twice — once at $0.668/MTok, and again in degraded retrieval that shows up as retries. It also means the honest framing of every intervention above is not 'saves tokens, risks quality' but 'saves tokens, and shifts quality in a direction that must be measured per intervention'.
- **Eng cost:** n/a — it is a reason to prioritise the eviction and offloading work, not a technique.

Sources:
- https://www.trychroma.com/research/context-rot
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5


---

# W4d-compression

**Summary.** VERDICT ON THE CAVEMAN CLASS: the ~75% claim is folklore. The technique is real but is an OUTPUT-side lever worth roughly 3-15% of the ticket, not 75%. Applied to instructions (input side) it is nearly worthless and can actively backfire.

THE OWNER'S KEY OBSERVATION IS CONFIRMED, AND UNDERSTATED. Output is 5% of token volume (2.5M/50M) and ~51% of the bill ($33.25/$65). The reason is not just the 5x list-price ratio — it is that caching applies only to input. Effective blended rates in the owner's model: output $13.30/MTok vs input $0.668/MTok at 85% cache hit. Each output token costs ~20x a blended input token, not 5x. Corollary: a 1% relative cut in output (~$0.33/ticket) and a 1% relative cut in input (~$0.32/ticket) are worth almost exactly the same money, because input volume is 19x larger but 20x cheaper per token. Percentages are not comparable across the two sides — only dollars are.

THE INPUT BILL IS NOT WHERE YOU THINK. Of the $31.72 input spend, the 85% of volume that hits cache costs ~$11.5, while the 15% that misses costs ~$20.2 — 15% of volume is ~64% of the input bill. Compression aimed at the cached prefix (system prompts, tool definitions, agent instructions — exactly what caveman mode edits) attacks the cheapest tokens in the system.

THE DECISIVE INTERACTION (item G, and the most valuable thing here). Compression and caching are in direct conflict. On Opus 5 at 85% cache hit the effective input rate is 0.2725x base (0.85 x 0.1 + 0.15 x 1.25). Any scheme that makes the prefix VARY per call forfeits the cache and pays 1.0x base. Break-even requires >3.7x compression just to draw level with doing nothing. LLMLingua-2's published range is 2-5x — marginal at best, before quality is even considered. Independently confirmed: the CAPC paper (Jul 2026) states query-aware compression "mechanically invalidat[es] the prefix-strict cache on every call" and measured that it only beats naive caching at r>=6.

A SECOND, SILENT FAILURE MODE nobody writes about: Anthropic's minimum cacheable prefix is 512 tokens (Opus 5) and 1,024 (Sonnet 5), and "shorter prompts cannot be cached, even if marked with cache_control. No error is returned." Caveman-compressing a 1,200-token Sonnet 5 subagent prompt to ~600 tokens moves it from 0.1x to 1.0x base — a 10x price INCREASE, silently.

THE DISTINCTION THAT ORGANISES EVERYTHING: static rewriting vs dynamic compression. Caveman mode is a one-time static edit — byte-identical every call, so it does NOT break cache (if it stays above the minimum length). Automated compressors produce per-query output — they DO break cache. Static rewriting is cache-safe but low-yield; dynamic compression is high-yield on paper but cache-hostile in practice. Input compression fights caching; output compression cannot, because output is uncacheable by construction. That is why C and D are the real levers and A and B are the traps.

ON QUALITY, IT IS WORSE THAN THE BLOGS ADMIT FOR AGENTS SPECIFICALLY. AGORA (May 2026) found token-level compression collapses agents to mean reward <=0.05 across ALL 17 tested configurations despite 1.3-13.3x compression, because tokens carrying action semantics (identifiers, brackets, action verbs) rank lowest in self-information and get deleted first. And a controlled study measured 56x OUTPUT EXPANSION on MBPP at r=0.3 when task-critical instructions were truncated: compressing the prompt made the bill go UP by an order of magnitude on a code benchmark. "Compress more" does not merely diminish — it inverts.

WHERE THE IDEA IS GENUINELY SAFE AND PAYS: this product runs unattended, so no human reads the prose. The narration and preamble caveman mode kills are near-zero-value here. Anthropic's own Opus 5 guide independently endorses this: Opus 5 responses "run longer than prior Opus models'", it "narrates readily", and files it writes to disk "are often longer than on prior models" — and Anthropic supplies exact conciseness wording. That is vendor-primary validation of the caveman class on the output side, which is the half of the bill that matters.

THE BIGGEST SURPRISE AND CHEAPEST WIN: on Opus 5 the highest-value prompt edit is DELETING instructions, not compressing them. Anthropic states explicit verification instructions cause over-verification and that "removing them reduces wasted tokens with no loss in quality" — a vendor claim of a strictly free saving, pointing opposite to the entire compression literature.

TWO PRIMARY-SOURCE FOLKLORE KILLERS: effort does NOT reliably shorten visible output on Opus 5 (it controls thinking volume; you need a separate length instruction), and thinking.display "omitted" saves nothing because billing is identical regardless of display.

CREDIBILITY CAVEAT: three of the most quotable numbers below (the -27.9% RCT, the 56x MBPP expansion, "code tolerates r>=0.6") trace to a single-author, arXiv-only, self-citing series by Warren Johnson with no visible peer review. I label all three asserted-credible symmetrically — the pro-compression figure takes the same discount as the anti-compression ones. No recommendation depends on them; they rest on Anthropic primary docs plus the independent AGORA and TACO work.

**Could not verify:**

- NO CONTROLLED STUDY EXISTS of telegraphic/caveman instruction style on AGENTIC CODING with a frontier model. This is the central gap. Telegraph English (the closest academic analogue, 50% compression at 99.1% accuracy) is QA-only on LongBench-v2. Every caveman measurement I found is N=5 to N=24 prompts, single-run, on conversational tasks. Nobody has measured it on a multi-hour autonomous build.
- NO PUBLIC MEASUREMENT of any compression technique on Claude Opus 5 or Sonnet 5 specifically. The best agentic compression evidence (AGORA, TACO) uses other backbones; the caveman benchmarks used older Claude models; the format benchmarks used Sonnet 4.6/Haiku 4.5 and DeepSeek V3. Compounding this, Anthropic states Claude 4.7+ uses a tokenizer producing ~30% more tokens for the same text, so NO externally measured compression ratio transfers 1:1 to this stack.
- THE SECOND-ORDER OUTPUT EFFECT IS UNQUANTIFIED ANYWHERE. In an agentic loop, output text is fed back as conversation history and re-read as input on subsequent calls, so cutting output also cuts future input. No source I found counts this — meaning every published caveman saving figure is probably an UNDERSTATEMENT of the true effect in a long agentic run. This is the one direction in which the folklore may be too conservative.
- CREDIBILITY CONCENTRATION: three of the most decision-relevant quantitative findings (the -27.9% RCT saving at r=0.5, the 56x MBPP output expansion at r=0.3, and 'code tolerates r>=0.6' plus TAAC's 22%-cost-at-96%-quality) all trace to a single-author, arXiv-only, self-citing series by Warren Johnson with no visible peer review or venue. I applied this discount symmetrically to the pro- and anti-compression numbers. They are directionally corroborated by independent work (AGORA, CAPC), but the specific figures should not be quoted as settled.
- METHODOLOGICAL LIMIT ON MY OWN RESEARCH: this session's WebSearch budget was fully exhausted (200/200) before I began, so all findings come from WebFetch against the arXiv API, DuckDuckGo HTML, vendor docs and direct URLs. I therefore have NO coverage of YouTube talks, conference presentations, podcasts, or Hacker News / Reddit / Discord practitioner threads — source types the owner explicitly asked for. Practitioner sentiment beyond the three caveman write-ups I fetched is unsampled.
- NO CURRENT-MODEL MEASUREMENT of diff-vs-whole-file OUTPUT TOKEN cost. Aider's benchmark is Dec 2023 on GPT-4-era models and explicitly reports no token figures. The widely repeated belief that diffs save output tokens is intuitively obvious but, as far as I could find, unmeasured on any 2026 model.
- THE STRUCTURED-OUTPUT QUALITY RESULT IS TWO YEARS STALE. 'Let Me Speak Freely?' is Aug 2024 and predates native structured-output support in current models. I found no 2026 replication, so whether format constraints still degrade reasoning on Opus 5 is genuinely unknown.
- LLMLINGUA MAINTENANCE STATUS UNCERTAIN. The README timeline I fetched tops out at Dec 2024 (SCBench) / Jul 2024 (MInference), with no 2025-2026 release listed, and all 2026 successor work I found came from other groups. I could not confirm whether Microsoft has abandoned the line or simply not updated the README, and I could not fetch the commit history or issues list within budget — so the practitioner failure reports on structured/code input that the issues list would likely contain remain unread.
- I COULD NOT VERIFY THE UNDERLYING TOKEN SPLIT of the owner's cost model. I reproduced the stated $31.72 input / $33.25 output figures to within ~10% and derived that they imply roughly 22% of output tokens coming from Opus 5 and 78% from Sonnet 5, but the actual orchestrator/subagent split, the per-call context growth curve, and how the 85% cache-hit figure was obtained are all unverified inputs I took on trust.
- NO EVIDENCE EITHER WAY on whether concision instructions interact with the 1.3-1.5x retry multiplier. It is plausible that terser reasoning or terser inter-agent messages raise the non-convergence rate on hard tickets, which would swamp every token saving in this report. Nobody has measured this, and it is the single most important thing the owner should measure themselves.

### `folklore` — "Caveman mode" / telegraphic instruction style (drop articles, filler, pleasantries, preamble) — the owner's cited example

- **Claimed saving:** Headline claim ">75% usage reduction" and "63% token reduction". Reality per the source repo's OWN instrumented benchmark: 4-12% output-token reduction (N=5, across Haiku/Sonnet/Opus). Best independent review: 30-50% output-token reduction in normal use, which it computes as only 5-15% of a total bill. Applied to the owner's model (output = 51% of $65): a 10-30% output cut = $3.3-10.0/ticket, i.e. 5-15%.
- **Evidence:** MIXED, and the headline is not measured. Traced to origin. (1) nathanonn.com (Apr 10 2026) headlines ">75%" but its own test is a single qualitative comparison on one contact-form task; its 99% figure is for the explanation WRAPPER only (377->5 characters), not the code. (2) The underlying repo github.com/drona23/claude-token-efficient (5.9k stars) claims "~63% reduction in output words" — WORD counts, single run, 5 prompts — and the authors themselves call it "a directional indicator, not a statistically controlled study". The repo's later reproducible benchmark measuring actual API output_tokens found only ~4-12% reduction. (3) Independent reviewer andrew.ooo (updated Jul 2026) reports 30-50% output-token reduction, cites a 24-prompt community comparison finding a one-line "be brief" instruction captured MOST of the savings versus the full skill, and a 6-line hand-rolled prompt that "outperformed the full Caveman skill on the quality/token tradeoff". So 75% is folklore; measured values span 4-50% depending on who measured and what they counted — a ~10x disagreement.
- **Quality risk:** LOW-TO-MODERATE, and it depends entirely on who reads the output. For this product (unattended, machine-consumed) the killed content is near-zero-value narration, so risk is low. Reported degradations: andrew.ooo found "telegraphic responses occasionally drop edge cases" and "a small but real regression on tasks requiring nuanced explanations" in the most aggressive mode, plus agents that "sometimes drift back to verbose mode mid-session". nathanonn explicitly recommends NOT using it for architecture discussion or debugging unfamiliar errors. The nearest controlled evidence on instruction register is the politeness study (separate finding), which points mildly against aggressive terseness — but "terse" is not "impolite", so that transfer is weak.
- **Eng cost:** Trivial — a static edit to a system prompt / CLAUDE.md. Hours, not days. Cache-safe because the compressed text is byte-identical every call.

Sources:
- https://www.nathanonn.com/claude-code-caveman-mode/
- https://github.com/drona23/claude-token-efficient
- https://andrew.ooo/posts/caveman-claude-code-skill-token-savings-review/

### `measured` — THE DENOMINATOR PROBLEM: why caveman-compressing INSTRUCTIONS cannot matter much even if 75% were true

- **Claimed saving:** Ceiling ~4.5% of ticket cost, realistically 1-3%. Assumption made visible: 47.5M input tokens over 680 calls = ~70k tokens/call; assume a generous 20k tokens/call of instructions = 13.6M instruction tokens/ticket. Instructions are the MOST cacheable content (byte-identical every call), so price at cache-read ~$0.284/MTok = ~$3.86/ticket. A 75% cut saves ~$2.90 = 4.5% of $65. If instructions cache closer to 100%, the saving is smaller still.
- **Evidence:** MY ARITHMETIC using the owner's cost model plus Anthropic's published cache-read multiplier (0.1x base input). Not a literature finding — and that is the point: every caveman write-up reports a percentage of the thing it compressed, never a percentage of the bill. The one reviewer who attempted the denominator (andrew.ooo) reached the same structural conclusion independently, noting the technique "only affects output tokens (cheapest part), leaving expensive input/context tokens untouched".
- **Quality risk:** None — this is a costing argument, not an intervention.
- **Eng cost:** None. It is a decision input: it tells you not to spend engineering time here.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://andrew.ooo/posts/caveman-claude-code-skill-token-savings-review/

### `measured` — THE CACHING CONFLICT (item G): dynamic prompt compression forfeits the 10x cache discount and is usually net-negative

- **Claimed saving:** NEGATIVE unless compression exceeds ~3.7x. My arithmetic: on Opus 5 at 85% cache hit the effective input rate is 0.2725x base (0.85 x 0.1 cache-read + 0.15 x 1.25 cache-write). Compression that makes the prefix vary per call pays 1.0x base on 1/r of the tokens, so break-even needs r > 3.67. LLMLingua-2's published range is 2-5x. Concretely: a stable 100k-token prefix costs $0.05/call at Opus 5 cache-read ($0.50/MTok); compressed 2x to 50k but varying per call it costs $0.25-0.31/call — a 5-6x INCREASE for half the tokens.
- **Evidence:** MEASURED (independent) plus my arithmetic, and the two converge. CAPC (arXiv 2607.15516, Yan Song, 17 Jul 2026) states the literature "has standardized on query-aware methods that produce a different compressed prefix per query, mechanically invalidating the prefix-strict cache on every call", and measured on Anthropic's Sonnet 4.6 API that query-aware compression only beats naive caching at r>=6. It also measured real cache hit rate plateauing at rho~0.83 (not the rho=1.0 the compression literature assumes), with a two-tier architecture and a sharp threshold near ~3,500 tokens. Their fix (query-AGNOSTIC compression + explicit cache_control + a tier-preserving ratio bound) was cheapest in 16/16 configurations on LongBench-v2: 49% cheaper than cache-only, 64% cheaper than query-aware, at quality within 0.05 of uncompressed. Anthropic primary confirms the mechanics: cache follows a strict tools -> system -> messages hierarchy, and a change at any level invalidates that level and all subsequent ones.
- **Quality risk:** Distinct from cost, but note CAPC's quality result (within 0.05 of baseline) was on QA, not code or agentic tasks.
- **Eng cost:** The RECOMMENDATION is cheap: do nothing (don't run a compressor over cached content). Implementing CAPC-style query-agnostic compression properly is a multi-week project requiring a hosted compressor model.

Sources:
- https://arxiv.org/abs/2607.15516
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/about-claude/pricing

### `measured` — SILENT BACKFIRE: compressing a prompt below the minimum cacheable prefix disables caching entirely, with no error

- **Claimed saving:** NEGATIVE — a 10x price increase on the affected block. Anthropic's documented minimum cacheable prefix is 512 tokens for Opus 5 / Fable 5 / Mythos 5 and 1,024 tokens for Sonnet 5 / Sonnet 4.6 / Opus 4.8. Compressing a 1,200-token Sonnet 5 subagent system prompt to ~600 tokens moves it from 0.1x to 1.0x base input. For a fleet of small specialist subagent prompts — exactly this product's architecture — this is a realistic and completely invisible own-goal.
- **Evidence:** VERIFIED PRIMARY (Anthropic docs), quoted: "Shorter prompts cannot be cached, even if marked with cache_control. No error is returned — check usage.cache_creation_input_tokens and cache_read_input_tokens to verify if caching occurred." I found no blog post, paper or repo in this entire research pass that mentions this interaction.
- **Quality risk:** None (cost-only failure), but undetectable without explicit instrumentation — which is what makes it dangerous.
- **Eng cost:** Trivial guardrail: assert every cacheable prefix stays above the model's minimum, and log cache_creation_input_tokens / cache_read_input_tokens on every call.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### `asserted-credible` — OUTPUT-SIDE COMPRESSION on Opus 5 — explicit conciseness plus narration-cadence instructions (vendor-endorsed)

- **Claimed saving:** Unquantified by Anthropic, but it targets the 51% of the bill that is output, and Anthropic supplies exact wording. Combined with the caveman evidence, a 10-30% output cut is the realistic band = $3.3-10.0/ticket.
- **Evidence:** VERIFIED PRIMARY, and it independently validates the caveman thesis. Anthropic's Opus 5 prompting guide: "Claude Opus 5's default user-facing responses run longer than prior Opus models'"; "Claude Opus 5 narrates readily during agentic work: it tends to announce what it is about to do, and its per-message output in agentic sessions is often longer than prior models'"; and separately "files that Claude Opus 5 writes to disk (reports, Markdown documents, summaries) are often longer than on prior models". Fixes quoted verbatim in the doc, including "Keep responses focused, brief, and concise... spend most of the response on the main answer", a narration-cadence instruction, and "Match the length of written documents to what the task needs: cover the substance, but do not pad with filler sections, redundant summaries, or boilerplate." Anthropic also advises pairing a short <tone_preference> reminder near the END of a long system prompt.
- **Quality risk:** LOW for this product — the suppressed content is user-facing narration nobody reads in an unattended run. Note Anthropic's steer that "Positive examples of the communication style you want tend to be more effective than instructions about what not to do", so specify the shape you want rather than listing bans. UNMEASURED upside I found no source for: in an agentic loop output is fed back as conversation history, so cutting output also cuts future input — meaning published caveman figures may UNDERSTATE the true effect on long runs.
- **Eng cost:** Trivial — static prompt text, cache-safe.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### `asserted-credible` — THE CHEAPEST WIN IS THE OPPOSITE OF COMPRESSION: delete redundant verification and self-check instructions on Opus 5

- **Claimed saving:** Unquantified by Anthropic but claimed strictly free. Also caps subagent spawning, the largest discretionary cost in a multi-agent architecture (each avoided subagent is an entire conversation, not a few tokens).
- **Evidence:** VERIFIED PRIMARY, quoted verbatim: "Claude Opus 5 verifies its own work without being told to. If your prompt contains explicit verification instructions ('include a final verification step for any non-trivial task,' 'use a subagent to verify'), remove them: instructions like these cause over-verification on Claude Opus 5, and removing them reduces wasted tokens with no loss in quality. The same applies to legacy harness scaffolding that adds separate verification steps." On self-correction: "Avoid instructing re-checks it already performs ('double-check your answer,' 're-verify before responding'); like verification instructions, these compound with the model's own behavior and add cost without improving results." On delegation: "Claude Opus 5 delegates to subagents more readily than prior models. Delegation pays off on genuinely independent, sizeable tracks of work, but it multiplies cost and time when applied to small tasks" — with a recommended cap instruction quoted in the doc.
- **Quality risk:** NONE per vendor ("with no loss in quality"). This is a vendor assertion, not an independent measurement — verify on your own evals. Note the interaction with the 1.3-1.5x retry multiplier: this is one of very few levers that cuts cost WITHOUT touching the verification behaviour that keeps runs converging, because the model performs it natively regardless.
- **Eng cost:** Trivial — deleting lines from a prompt. Highest ratio of dollars saved to hours spent in this entire report.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### `asserted-credible` — REASONING-TOKEN CONTROL (item D): effort is the calibrated lever; prompt-based thinking suppression is not

- **Claimed saving:** Not published as a number by Anthropic, but the doc gives you the instrumentation: usage.output_tokens_details.thinking_tokens returns the exact reasoning share of billed output. Since output is 51% of the bill and reasoning is typically its largest component, this is the first thing to measure.
- **Evidence:** VERIFIED PRIMARY, with several decision-relevant facts. (1) Thinking is billed as OUTPUT tokens. (2) FOLKLORE KILLER: billing is identical whether thinking.display is "summarized" or "omitted" — "You are billed for the full thinking process, not the thinking content visible in the response." Hiding reasoning saves nothing. (3) On Opus 5: "Effort controls thinking volume, not visible response length: on Claude Opus 5, changing effort does not reliably shorten responses, so prompt for length instead" — two separate controls, you need both. (4) Anthropic warns against prompt-based suppression: "Steering Claude to think less often may reduce quality on tasks that benefit from reasoning. Lowering the effort level is usually the better first lever, since it is a calibrated control rather than a wording-sensitive instruction." (5) DO NOT disable thinking to save: "for most tasks, thinking enabled at low effort performs better than thinking disabled at similar cost" — and disabling it makes the model occasionally write tool calls as plain text that never execute, with the leaked text persisting in history and corrupting later turns. In an unattended loop that is a direct retry-multiplier risk. (6) Anthropic concedes non-monotonicity: max effort "on most workloads adds significant cost for relatively small quality gains, and on some structured-output or less intelligence-sensitive tasks it can lead to overthinking."
- **Quality risk:** Vendor-acknowledged and level-dependent. Anthropic's Opus 5 guidance is to "use low and medium liberally as your primary control for token cost and response time wherever your evals show quality holds" — the conditional is load-bearing. Sweep effort per subagent ROLE.
- **Eng cost:** Low for the parameter change; moderate for the eval suite needed to justify each level. Hard constraint: hold effort constant per conversation.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### `measured` — IS THE REASONING-LENGTH / QUALITY RELATIONSHIP MONOTONIC? No — it is an inverted U, on code as well as maths

- **Claimed saving:** Implies reasoning reduction can be free or even quality-POSITIVE up to a point, then falls off sharply. This is the strongest theoretical support for reasoning-token reduction in this report.
- **Evidence:** MEASURED, multiple independent groups. (1) "On the Optimal Reasoning Length for RL-Trained Language Models" (arXiv 2602.09591, Nohara/Nakamura/Yokota, Feb 2026, revised Jun 2026): "across both mathematical reasoning and code generation, accuracy is non-monotonic in output length, peaking at an intermediate value", with the mechanism identified as dispersion — mode accuracy keeps improving while sample accuracy plateaus or declines. Code generation is explicitly in scope. (2) "Brief Is Better" (arXiv 2604.02155, Xuan Qi, Apr 2026) on Berkeley Function Calling Leaderboard v3, 200 tasks, six budgets 0-512 tokens: 32-token CoT lifted accuracy from 44.0% to 64.0% (+45% relative) while 256-token CoT COLLAPSED it to 25.0%, below the no-CoT baseline (McNemar p<0.001). Error decomposition: long CoT produced 28.0% wrong function selections and 18.0% hallucinated functions. Oracle analysis: 88.6% of solvable tasks needed <=32 reasoning tokens; true optimum 8-16. (3) Multiple 2026 papers report simultaneous length reduction AND accuracy gain: STACK -59.9% length with +4.8 points on maths (arXiv 2604.09150); SWAP -64.3% with +5.7%; CRISP -56% on MATH with improved accuracy.
- **Quality risk:** IMPORTANT TRANSFER LIMIT: "Brief Is Better" used Qwen2.5-1.5B-Instruct, a tiny model, on function-calling — do NOT extrapolate its 8-16 token optimum to Opus 5 on multi-hour agentic coding. What transfers is the qualitative shape (inverted U, present on code) and the implication: run an empirical effort sweep on your own tickets rather than issuing a blanket "think less" instruction. Note most maths results come from RL-trained/fine-tuned setups you cannot replicate through the API.
- **Eng cost:** Low to run an effort sweep; the real cost is a held-out ticket suite sensitive enough to detect quality regressions.

Sources:
- https://arxiv.org/abs/2602.09591
- https://arxiv.org/abs/2604.02155
- https://arxiv.org/abs/2604.09150

### `measured` — AUTOMATED PROMPT COMPRESSION (item B): LLMLingua / LLMLingua-2 / LongLLMLingua — what they deliver and where

- **Claimed saving:** LLMLingua-2: 2x-5x compression, up to 14x on GSM8K 9-step CoT prompts, 3x-6x faster than prior compression methods, 1.6x-2.9x end-to-end latency acceleration. LongLLMLingua: +21.4% performance at 1/4 the tokens on RAG. Series headline: "up to 20x compression with minimal performance loss".
- **Evidence:** MEASURED but on the WRONG TASKS for this product — the distinction the owner asked me to report clearly. LLMLingua-2's published evaluation (arXiv 2403.12968, Microsoft Research) covers MeetingBank, LongBench, ZeroScrolls, GSM8K and BBH: QA, summarisation and maths. NO code-specific benchmark appears in the evaluation set. The README mentions code scenarios among its examples but publishes no code benchmark numbers, and gives essentially no limitations section — no discussion of failures on structured data, code edge cases or agentic workflows. Maintenance signal: the README timeline tops out at Dec 2024 (SCBench) and Jul 2024 (MInference); no 2025-2026 release is listed, and all 2026 successor work I found came from other groups. Transfer failure is documented: a May 2026 study found LLMLingua-2 transfers poorly to diffusion LLMs, with information omission rather than semantic drift driving failures (arXiv 2605.17932).
- **Quality risk:** HIGH for this product on three independent grounds: (a) evaluated on QA/summarisation, not agentic coding; (b) AGORA shows the token-level family destroys agent action grammar; (c) it is query-aware, so it breaks prompt caching. Claude-specific trap: Anthropic's pricing doc states Claude 4.7+ uses a tokenizer producing "approximately 30% more tokens for the same text", so compression ratios measured on GPT tokenizers do not transfer 1:1 to the Claude 5 series.
- **Eng cost:** HIGH and recurring — you must host and run a compressor model on every call, which in an API-priced product is an extra billed inference on top of the tokens you saved.

Sources:
- https://arxiv.org/abs/2403.12968
- https://github.com/microsoft/LLMLingua
- https://www.microsoft.com/en-us/research/project/llmlingua/
- https://arxiv.org/html/2605.17932
- https://platform.claude.com/docs/en/about-claude/pricing

### `measured` — STRONGEST COUNTER-EVIDENCE FOR AGENTS: token-level compression causes "action-grammar destruction" and collapses agent reward to near zero

- **Claimed saving:** None — a catastrophic-failure finding. Mean reward <=0.05 in EVERY ONE of 17 (environment, backbone, method) cells, spanning two independent token-level method families, despite 1.3-13.3x realized compression.
- **Evidence:** MEASURED, independent (AGORA, arXiv 2605.26596, Haoran Zhang & Zhaohua Sun, May 2026). Mechanism quoted: "the tokens carrying action semantics (identifiers, brackets, action verbs) are exactly those self-information ranks lowest, so a general-purpose compressor reliably removes them and the environment rejects the residual." This is precisely why compression that looks fine on QA is lethal on tool-calling agents: perplexity-based importance is anti-correlated with syntactic necessity. The fix is STEP-level rather than TOKEN-level compression: AGORA (a 125M relevance scorer, ~2ms/step, no per-step LLM call) is "the only [method] retaining >=75% uncompressed performance in 8 of 9 cells", with a structural always-keep floor for format- and recency-critical content isolated by ablation as the dominant quality lever.
- **Quality risk:** This IS the quality-risk finding. It is the single strongest reason not to point LLMLingua-class tooling at an agentic coding harness.
- **Eng cost:** N/A as an avoidance recommendation. The transferable design principle is cheap: if you compress anything in an agent loop, do it at step/message granularity with a hard always-keep floor for format-critical and recent content — never at token granularity.

Sources:
- https://arxiv.org/abs/2605.26596

### `measured` — THE ONE COMPRESSION TECHNIQUE WITH POSITIVE MEASURED AGENTIC RESULTS: compress TOOL OUTPUT / terminal observations, not instructions (TACO)

- **Claimed saving:** 1-4% ACCURACY GAIN on TerminalBench (1.0 and 2.0) across strong agentic models, and 2-3% accuracy improvement under the SAME token budget. It saves tokens and improves quality simultaneously — the only technique here that does both, measured, on agentic coding.
- **Evidence:** MEASURED, independent, on the closest available proxy for this product (TACO, arXiv 2604.19572, Ren/Wu/Li et al., Apr 2026, revised May 2026). Evaluated on TerminalBench 1.0 and 2.0 plus SWE-Bench Lite, CompileBench, DevEval and CRUST-Bench. Framing quoted: "a key bottleneck is not merely limited context length, but the accumulation of noisy terminal observations in the interaction history", with the warning that "naive compression may discard task-critical signals needed for subsequent actions". Training-free, plug-and-play, self-evolving — it discovers and reuses structured compression rules from its own interaction trajectories. STRATEGIC FIT: tool results are the VARIABLE suffix of the prompt, never cacheable anyway, so compressing them costs nothing in cache terms. This is the correct target.
- **Quality risk:** POSITIVE on the evidence — accuracy improved rather than degraded. Residual risk: rule-based filtering could in principle discard a stack trace needed later; TACO's self-evolving rule discovery is designed against exactly that and the measured net was positive.
- **Eng cost:** MODERATE. A real component to build or port, but training-free and plug-and-play by design, and it lives in your harness not the model. Since it hits the expensive uncached 15% of input volume AND improves task success (attacking the 1.3-1.5x retry multiplier), this is the highest-expected-value compression work available.

Sources:
- https://arxiv.org/abs/2604.19572

### `asserted-credible` — AGGRESSIVE COMPRESSION INVERTS: it can increase total cost via output expansion, including 56x expansion on a code benchmark

- **Claimed saving:** NEGATIVE at high ratios. Moderate compression (r=0.5) reduced mean total cost 27.9%; aggressive compression (r=0.2) INCREASED mean cost by 1.8% despite large input reduction. Separately, at r=0.3 one provider showed 56x OUTPUT EXPANSION on MBPP.
- **Evidence:** ASSERTED-CREDIBLE (see credibility flag). Two studies, both single-author (Warren Johnson), arXiv-only, no visible peer review — I apply this discount symmetrically to pro- and anti-compression numbers alike. (1) arXiv 2603.23525 (Mar 2026): a PRE-REGISTERED six-arm randomized controlled trial on production multi-agent task orchestration, 358 successful Claude Sonnet 4.5 runs (59-61 per arm) drawn from a randomized corpus of 1,199 real orchestration instructions, measuring total input+output cost and embedding-based response similarity. r=0.5 gave -27.9%; r=0.2 gave +1.8%; recency-weighted gave -23.5%; moderate and recency-weighted occupied the cost-similarity Pareto frontier while aggressive was DOMINATED on both axes. Conclusion quoted: "'compress more' is not a reliable production heuristic and... output tokens must be treated as a first-class outcome when designing compression policies." The pre-registration and multi-agent orchestration setting make this unusually relevant despite the credibility caveat. (2) arXiv 2603.23527 (Mar 2026): 5,400 API calls across three benchmarks and multiple providers. At r=0.3, DeepSeek showed 56x output expansion on MBPP (instruction survival probability Psi~0.15) versus 5x on HumanEval (Psi~0.72); GPT-4o-mini was comparatively stable. The moderator is PROMPT STRUCTURE, not provider identity: when compression truncates task-critical instruction segments the model flails and emits vastly more output. It proposes a Compression Robustness Index and warns "single-benchmark assessments can produce misleading conclusions about compression safety and efficiency."
- **Quality risk:** Severe at aggressive ratios, and the failure is bimodal — not a graceful 5% quality slide but an unrecoverable output explosion on the specific prompts whose critical instructions got truncated. For a 5-hour unattended run this is the worst possible failure shape.
- **Eng cost:** N/A (avoidance). Actionable rule: if you ever compress, never exceed r=0.5, and validate on more than one benchmark.

Sources:
- https://arxiv.org/abs/2603.23525
- https://arxiv.org/abs/2603.23527

### `measured` — THE COMPRESSOR'S OWN COST: preprocessing overhead frequently exceeds the savings

- **Claimed saving:** LLMLingua achieved up to 18% end-to-end speed-up, but ONLY "when prompt length, compression ratio, and hardware capacity are well matched". Outside that window "the compression step dominates and cancels out the gains."
- **Evidence:** MEASURED, independent, large-scale ("Prompt Compression in the Wild", arXiv 2604.02985, Kummer/Jurkschat/Farber/Vahdati, Apr 2026) — "the first systematic, large-scale study of this trade-off, with thousands of runs and 30,000 queries across several open-source LLMs and three GPU classes", separating compression overhead from decoding latency while tracking output quality and memory usage. Response quality remained statistically unchanged across summarisation, code generation and QA within the good operating window. They ship an open-source profiler predicting the break-even point per model-hardware setup.
- **Quality risk:** None reported within the operating window — the finding is economic, not qualitative.
- **Eng cost:** IMPORTANT TRANSLATION: this study measures self-hosted GPU latency. For an API-priced product the analogous cost is worse, not better — the compressor is an additional billed inference call on every request, paid before you know whether the compression saved anything.

Sources:
- https://arxiv.org/abs/2604.02985

### `measured` — NOTATION SCHEMES (item F): "Telegraph English" — the closest academic validation of caveman-style rewriting, and its scope limit

- **Claimed saving:** ~50% token reduction at 99.1% accuracy retention on key facts (GPT-4.1), outperforming LLMLingua-2 at matched compression ratios on EVERY model and task tested, with the gap widening up to 11 percentage points on smaller models.
- **Evidence:** MEASURED (arXiv 2605.04426, Arbuzov/Bei/Dong/Kalaev/Shvets, May 2026), evaluated on 4,081 question-answer pairs from LongBench-v2 across five OpenAI models and two difficulty levels. It rewrites natural language into atomic fact lines using ~40 logical and relational symbols, with the ratio adapting to each document's information density. Notable design property: because each output line is an independently addressable fact, "compression and semantic chunking become the same operation" — the compressed form doubles as a semantic index. Grammar spec, compression prompt, benchmark data and reference implementation are released. This is the strongest evidence that a symbol-dense telegraphic dialect can genuinely preserve meaning — i.e. the caveman INTUITION is sound in principle.
- **Quality risk:** THE SCOPE LIMIT IS DECISIVE AND MUST NOT BE GLOSSED: the evaluation is QA only. No code evaluation, no agentic evaluation. Combined with AGORA's finding that compression destroys action grammar in agent loops, Telegraph English validates the caveman idea for exactly the workload this product does NOT have. Also: it is a full semantic REWRITE performed by a model, so applying it dynamically re-introduces both the compressor cost and the cache-invalidation problem.
- **Eng cost:** Moderate if applied statically to fixed documentation/instructions (cache-safe, one-off). High and cache-hostile if applied dynamically per call.

Sources:
- https://arxiv.org/abs/2605.04426

### `measured` — FORMAT EFFICIENCY (item E): the folklore is backwards — YAML costs MORE than JSON, and pretty XML is the real waste

- **Claimed saving:** Measured token deltas: YAML uses ~19% MORE tokens than JSON; TOML ~44% more; XML pretty ~18,291 tokens versus JSON compact ~6,970 for the same payload (~2.6x) with NO accuracy benefit; CSV ~3,922 tokens (44% fewer than JSON) at near-equal accuracy on flat tabular data. This directly contradicts the widely repeated claim that "YAML saves 15-30% of tokens versus JSON", which I found asserted in search results with no measurement behind it.
- **Evidence:** MEASURED by two independent practitioners, in agreement. (1) nathom.dev (Oct 12 2025) measured tokens-per-node across nested, sparse and tabular shapes AND accuracy via exact-match and Jaccard index on DeepSeek V3: JSON best overall; YAML ~19% more tokens AND "surprisingly poor" accuracy; TOML ~44% more tokens though scoring "remarkably well" on Jaccard; CSV the clear winner for tabular. Conclusion: "don't use YAML"; JSON is the practical optimum for agent communication. (2) Thore Hoeltig's benchmark repo (Dec 2025 - Mar 2026), run on Haiku 4.5 and Sonnet 4.6 with thinking on/off, flat and nested structures, scored as weighted accuracy (66.7% retrieval/structure, 33.3% filtering/aggregation) over a 31-record dataset: on Sonnet 4.6 nested dense data, TOON default ~6,970 tokens at 99.73% accuracy versus JSON compact ~6,970 at 97.85%, CSV ~3,922 at 97.58%, XML pretty ~18,291 at 97-98%. Both are practitioner work, not vendor or peer-reviewed, but both publish methodology and raw results.
- **Quality risk:** Format choice measurably moves accuracy, not just tokens — TOON beat JSON compact by ~1.9 accuracy points at identical token cost on Sonnet 4.6. The clear waste to eliminate is verbose/pretty XML: 2.6x the tokens for no accuracy gain. Directly relevant here because heavy XML tagging is a common agent-prompt convention.
- **Eng cost:** Low — a serialisation change in the harness for tool inputs/outputs. Cache-safe if applied consistently. Caveat: measured on Sonnet 4.6/Haiku 4.5 and DeepSeek V3, not Opus 5; re-measure on your own models since Claude 4.7+ changed tokenizer.

Sources:
- https://nathom.dev/llm-data-formats/
- https://github.com/thoeltig/file-format-token-accuracy-benchmark-results
- https://www.toon-kit.com/playground

### `asserted-credible` — STRUCTURED OUTPUT / FORMAT CONSTRAINTS CAN DEGRADE REASONING (the quality cost of the obvious output-compression move)

- **Claimed saving:** N/A — a quality-risk finding attached to a technique commonly recommended for token savings. A related 2025 paper measured JSON reducing output tokens 75% and latency 43% versus XML for BPMN generation, but explicitly did NOT assess correctness (arXiv 2509.24592).
- **Evidence:** MEASURED but DATED. "Let Me Speak Freely? A Study on the Impact of Format Restrictions on Performance of Large Language Models" (arXiv 2408.02442, Tam/Wu/Tsai/Lin/Lee/Chen, Aug 2024, revised Oct 2024): "Surprisingly, we observe a significant decline in LLMs reasoning abilities under format restrictions. Furthermore, we find that stricter format constraints generally lead to greater performance degradation in reasoning tasks." The abstract does not quantify the decline and the fetched page did not expose the per-model tables.
- **Quality risk:** THIS IS THE RISK, and it cuts against "just make it emit structured output to save tokens". STALENESS CAVEAT I want to flag honestly: this is an Aug 2024 paper predating every current model by roughly two years, and Opus 5 has native structured-output support that did not exist when it was written. Treat it as a hypothesis to test on your own harness, not a settled result. I found no 2026 replication.
- **Eng cost:** N/A — the actionable step is to A/B structured versus free-form output on your own ticket suite before standardising on structured output for reasoning-heavy subagents.

Sources:
- https://arxiv.org/abs/2408.02442
- https://arxiv.org/abs/2509.24592

### `measured` — DIFF-BASED EDITS INSTEAD OF WHOLE-FILE REWRITES — a retry-rate lever, NOT (on the available evidence) a token lever

- **Claimed saving:** Measured QUALITY effect, no measured token effect. On Aider's 89-task Python refactoring benchmark, GPT-4 Turbo scored 20% with SEARCH/REPLACE versus 61% with unified diffs, and "lazy" placeholder comments fell from 12 tasks to 4 — a 3x reduction in laziness. June GPT-4 went from 26% to 59%.
- **Evidence:** MEASURED (Aider, Paul Gauthier, Dec 21 2023), 89 Python refactoring tasks from 9 open-source repositories. HONEST LIMITATION, stated because this technique is widely cited as a token saver: the write-up contains NO figures on token consumption differences between edit formats, and no direct numerical comparison against whole-file replacement. It therefore does not support "diffs save output tokens", even though that is intuitively true and widely assumed. What it DOES support is that diff formats substantially reduce lazy/placeholder code. FURTHER CAVEAT: Dec 2023, GPT-4-era models, roughly 2.5 years stale relative to Opus 5.
- **Quality risk:** POSITIVE on the measured axis — diffs improved correctness and reduced placeholder output. Route the argument through the 1.3-1.5x retry multiplier: fewer lazy stubs means fewer non-converging runs, a larger and better-evidenced saving than the token delta. Note this may be a shrinking opportunity given Anthropic's claim that Opus 5 "completes full tasks rather than leaving stubs or placeholders".
- **Eng cost:** Moderate — edit-format design plus a robust patch applier and a fallback path for failed applications.

Sources:
- https://aider.chat/2023/12/21/unified-diffs.html
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

### `asserted-credible` — THE POLITENESS EVIDENCE — weak, dated, and deliberately NOT overstated against caveman mode

- **Claimed saving:** N/A — a quality-risk signal only.
- **Evidence:** MEASURED but of limited transfer (arXiv 2402.14531, Yin/Wang/Horio/Kawahara/Sekine, Feb 2024, revised Oct 2024). Across English, Chinese and Japanese: "We observed that impolite prompts often result in poor performance, but overly polite language does not guarantee better outcomes. The best politeness level is different according to the language." The abstract does not quantify the degradation.
- **Quality risk:** I am flagging the register distinction rather than pressing the point: caveman mode drops articles, filler and pleasantries — it is TERSE, not IMPOLITE. The paper measured rudeness, not concision, so transfer is genuinely weak, and it is a Feb 2024 study on models two generations old. It belongs here as the only controlled evidence I could find that instruction REGISTER affects output quality at all, and as a caution against caveman variants that drift into brusque or adversarial phrasing. It is NOT a reason to avoid concision instructions — Anthropic's own Opus 5 guide recommends them directly.
- **Eng cost:** N/A.

Sources:
- https://arxiv.org/abs/2402.14531

### `asserted-credible` — CACHE TTL SCHEDULING ON A 5-HOUR RUN — plausibly a bigger lever than any prompt compression

- **Claimed saving:** Not measured by anyone I found, but the arithmetic is favourable and the stakes are large. Anthropic's default cache TTL is 5 minutes; the run is 5 hours over ~680 calls. Every gap longer than 5 minutes (a test suite, a build, a slow subagent, a rate-limit backoff) expires the prefix and forces a re-write at 1.25x base. The 1-hour TTL costs 2x base on write but survives those gaps — and two re-writes at 1.25x already exceed one write at 2x.
- **Evidence:** VERIFIED PRIMARY on the mechanics and pricing (5-min write 1.25x, 1-hour write 2x, cache read 0.1x; cache hierarchy tools -> system -> messages). The scheduling implication is MY INFERENCE from those primitives plus the owner's stated run shape — I found no published measurement of TTL selection on multi-hour agentic runs, and I label it accordingly. Supporting datapoint: CAPC measured real-world hit rate plateauing at rho~0.83 on Sonnet 4.6 rather than the rho=1.0 the compression literature assumes, which independently suggests the owner's 85% assumption is realistic-to-slightly-optimistic rather than aspirational — a useful validation of the $65 baseline the whole analysis rests on.
- **Quality risk:** None — pure billing configuration, zero effect on output.
- **Eng cost:** Trivial to change (one cache_control field). Moderate to validate: instrument cache_creation_input_tokens versus cache_read_input_tokens per call and measure the real re-write rate across an actual 5-hour run before choosing.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/about-claude/pricing
- https://arxiv.org/abs/2607.15516


---

# W4e-practitioners

**Summary.** The owner's key observation is CONFIRMED by arithmetic, and sharpens into a ranking rule. Their figures reproduce exactly ($31.72 + $33.25 = $64.97, implying ~25% of traffic on Opus): output is 51.2% of the bill on 5.0% of token volume. The useful form is a marginal-value ladder — per MTok REMOVED, cached input is worth $0.284, uncached input $2.843, output $13.30. So an output token is worth 46.8 cached input tokens. A non-obvious corollary: that ratio RISES with cache hit rate (9.1x at 50%, 21.3x at 85%, 34.5x at 95%), so caching and output-reduction are complements, not competing priorities. One correction: the model prices cache writes at 1.0x when they bill at 1.25x, so the true baseline is nearer $70 than $65.\n\nThis ladder demolishes most of the popular advice. Compressing system prompts and instructions attacks the cheapest token class in the system. 'Caveman mode' aims at the right axis (output) but its 65-75% claim does not reproduce — independent benchmarks land at 14-21% and 30-50%, 'be brief.' captures most of it, and it explicitly does not touch thinking tokens, which are plausibly most of this workload's output. LLMLingua-class compression is rigorous but measured on QA/summarization, compresses the cheap side, and mutates the prefix (breaking cache). The entire '90% savings from prompt caching' blog genre is the 0.1x cache-read multiplier restated as a result; it is arithmetic, not evidence, and several of those domains look like AI-generated SEO farms.\n\nThe strongest evidence found is JetBrains Research's 'The Complexity Trap' (arXiv:2508.21433, SWE-agent on SWE-bench Verified, n=500, 5 configs, bootstrap CIs) — and reading its appendix changed the conclusion. Environment observations are 83.9% of agent context; simple observation masking halves cost versus a raw agent while matching or beating LLM summarization on solve rate. BUT Appendix A discloses four of five configs were self-hosted Qwen priced off cache-blind list rates, so the ~50% will not transfer to Anthropic's 0.1x cache read. What does transfer is the quality data, and it is a warning: on the one cache-aware, thinking-enabled config, masking cost 4.0 solve-rate points (p=0.04) and summarization cost 9.0 (p<0.0001). Its most valuable result for this product is trajectory elongation — summarization lengthened runs 15% because summaries 'mask signs of a failing trajectory, encouraging the agent to persist in unproductive loops', and adding a critic made it worse with no accuracy gain. That directly inflates the 1.3-1.5x retry multiplier, which at $19.50-$32.50/ticket is the joint-largest lever in the model and the least attacked.\n\nPractically, the biggest safe wins are unglamorous and touch nothing the model sees: cache hygiene (85%→95% is worth $12.15/ticket with zero quality risk), the 1-hour TTL (provably correct for a 5-hour run with long test waits), and deterministic filtering of test/build output, which attacks the expensive UNCACHED class at $2.843/MTok. Anthropic's tool search (55k→8.7k tokens, with tool-selection accuracy rising) and programmatic tool calling (43,588→27,297) are rare both-axes wins but are unreproduced vendor evals and conditional on actually carrying a large tool surface. Above all: measure first. Both load-bearing assumptions (85% hit rate, 47.5M input) are unverified, the widely-cited 85% is a convention with no empirical basis I could find, and my arithmetic surfaces a consistency problem — 70k input per call against thinking blocks that are retained and re-billed as input on Opus 5 and Sonnet 5.

**Could not verify:**

- BUCKET D (YouTube/conference talks) RETURNED NOTHING THAT MET THE EVIDENCE BAR. I did not find a single 2026 technical talk on agent cost engineering with measurable claims. This is partly a tooling limit — my WebSearch budget was exhausted at the first call and I worked the rest of the task through WebFetch plus DuckDuckGo's HTML endpoint, which surfaces video content poorly. Treat bucket D as unsearched rather than empty.
- THE '90% COST REDUCTION FROM PROMPT CACHING' GENRE IS NOT A MEASUREMENT — THIS IS ITSELF A FINDING. Every 2026 blog post I surfaced on this (digitalapplied.com, agentmarketcap.ai, usewire.io, tianpan.co, paperclipped.de) restates the 0.1x cache-read multiplier as if it were an observed result. It is arithmetic from the price card, not evidence, and it silently assumes a 100% hit rate on 100% of input. Several of these domains show the signature of AI-generated SEO content farms. I rejected them as sources and the owner should too.
- THE MOST-CITED PRACTITIONER POST ON AGENT CACHE HIT RATES CONTAINS NO MEASUREMENTS. Daniel Vaughan's Codex CLI prompt-caching analysis is well-informed on mechanism (append-only conversation, prompt_cache_key routing stickiness, what breaks the prefix) but its numbers — '85% hit', '40-55% cost reduction' — are worked hypotheticals, not observations. Since the owner's own model also assumes 85%, note that this figure circulates widely as a convention with no published empirical basis I could find. MEASURE YOUR OWN.
- NO PUBLISHED COST FIGURE EXISTS FOR A MULTI-HOUR AUTONOMOUS 'BUILD ME AN APP' RUN. I searched specifically and found none. The nearest real anchors are per-task benchmark costs 2-3 orders of magnitude smaller (Aider $0.13/task, JetBrains $0.18-$1.29/instance) and Anthropic's human-in-the-loop aggregate ($13/dev/active day). The owner's $65-70/ticket is a model, not a validated figure, and the first real run is worth more than all of this research.
- OPENHANDS, CLINE, ROO CODE, GOOSE AND OPENCODE INTERNALS ARE ONLY PARTLY COVERED. I confirmed OpenHands' condenser abstraction (llm_summarizing_condenser 'replaces the first half of all events with a single summary event', plus no-op and pipeline condensers) and Roo Code's intelligent context condensing (enabled by default, threshold slider defaulting to 100%, reserves 30% of the window, and warns that using a different model for condensing can 'degrade summary quality when the history includes tool calls, tool results, or other structured content'). But docs.cline.bot/features/prompt-caching and the SWE-agent history_processors docs both 404'd, so Cline's cache-breakpoint strategy and SWE-agent's full processor list are cited second-hand rather than read. sweagent/agent/history_processors.py (399 lines) is the file to read directly.
- THE JETBRAINS COST FIGURES DO NOT TRANSFER CLEANLY TO ANTHROPIC PRICING, AND I NEARLY REPORTED THEM AS IF THEY DID. Appendix A discloses that four of five configs are self-hosted Qwen priced post-hoc off Alibaba list rates, and that for Qwen3-32B that pricing 'does not distinguish between cache hit and miss input tokens. This leads to an inflated cost.' Only the two Gemini rows are true cache-aware API-returned costs. Under Anthropic's 0.1x cache read, the tokens observation masking removes sit in the cheapest class you own, so the ~50% saving will NOT reproduce at that magnitude. The solve-rate results transfer fine (model behaviour); the dollar results do not.
- I COULD NOT VERIFY WHETHER A CACHE READ REFRESHES THE TTL. This determines whether a 1-hour TTL actually spans a 5-hour run or merely postpones the first miss, and it changes the cache-strategy recommendation materially. Anthropic's docs describe TTL and multipliers but I did not retrieve an explicit statement on refresh-on-use. Confirm before designing around it.
- NO INDEPENDENT REPRODUCTION EXISTS OF ANTHROPIC'S TOOL-SEARCH (85%, 55k→8.7k) OR PROGRAMMATIC-TOOL-CALLING (37%, 43,588→27,297) NUMBERS. They are internal evaluations on unpublished task suites. The numbers are specific and the mechanism is sound, but they are vendor marketing for vendor features and should be re-measured on the owner's own tool surface — which may be far smaller than the 55k five-MCP-server baseline the saving is computed against.
- THE CAVEMAN REPRODUCTIONS ARE THEMSELVES WEAK EVIDENCE. The 14-21% and 30-50% figures come from individual blog benchmarks with small prompt suites, single runs and no confidence intervals. They are more credible than the vendor's 65-75% only because they are independent and directionally consistent with each other. Nobody has run this properly.
- I DID NOT RESEARCH BATCH API, OFF-PEAK PRICING OR SERVICE TIERS as cost levers, because the owner's own doc 01 already establishes they are inapplicable: Anthropic states sessions 'are stateful and interactive. There is no batch mode', and Priority Tier is both closed to purchase and explicitly unsupported on Opus 5 and Sonnet 5.

### `measured` — ARITHMETIC FIRST: the marginal-value ladder ($ per MTok removed). Rank every other technique by which token class it removes.

- **Claimed saving:** Owner's model reproduces exactly. $31.72 input + $33.25 output = $64.97. Solving for the blend: ~28.1% of input tokens and ~22% of output tokens run on Opus (consistent, ~1/4 of traffic on the orchestrator). Output = 51.2% of the bill on 5.0% of token volume — THE OWNER'S KEY OBSERVATION IS CONFIRMED. Marginal value per MTok REMOVED, at their blend: cached input $0.284, uncached input $2.843, output $13.30. So one output token is worth 46.8 cached input tokens, or 4.7 uncached input tokens. Per-model ratio is invariant: output/average-input = 5 / 0.235 = 21.3x at 85% cache, because both Opus and Sonnet price output at exactly 5x input. NON-OBVIOUS COROLLARY: the ratio RISES with cache hit rate — 9.1x at 50% cache, 21.3x at 85%, 34.5x at 95%. Caching and output-reduction are complements, not substitutes: the better your caching gets, the more disproportionately valuable output reduction becomes.
- **Evidence:** My own calculation from list prices re-verified live on 2026-07-27 in the owner's own /Users/kamilborzecki/Projects/coding-agent/docs/research/01-verification-corrections.md (Opus 5 $5/$25, cache read 0.10x; Sonnet 5 $2/$10 intro). Effective input multiplier at 85% hit = 0.85(0.1) + 0.15(1.0) = 0.235. Deterministic arithmetic, not a source claim.
- **Quality risk:** None — it is a costing rule, not an intervention. Its VALUE is that it prevents quality-risky work: it shows that shaving prose off cached system prompts is nearly worthless ($0.284/MTok), so effort should not be spent there.
- **Eng cost:** Zero. One spreadsheet.

Sources:
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### `measured` — Cache-hit-rate elasticity, and a correction: the owner's model understates cost by ~5-8% because it prices cache WRITES as ordinary input

- **Claimed saving:** Elasticity on the owner's model: 85%→95% hit takes input from $31.72 to $19.57, saving $12.15/ticket (18.7% of the whole bill) — larger than any prompt-compression technique I found. 85%→90% saves $6.07. Slipping 85%→70% costs $12.15. CORRECTION: a 5-minute cache write is billed at 1.25x base input, not 1.0x. If the 15% non-hit slice is predominantly writes, real input cost is 47.5 x 0.15 x $2.843 x 1.25 = $25.31 rather than $20.25 — about +$5.06/ticket, so true cost is nearer $70 than $65. Give it as a 5-8% band, since the slice is really a mix of writes (1.25x) and genuinely cold first reads.
- **Evidence:** Anthropic pricing page, verbatim and independently re-verified by the owner's own adversarial pass today: '5-minute cache write tokens are 1.25 times the base input tokens price', '1-hour cache write tokens are 2 times', 'Cache read tokens are 0.1 times'. Elasticity is my arithmetic on those multipliers.
- **Quality risk:** None. Raising cache hit rate is pure win — identical tokens reach the model either way. This is the only large lever in this report with literally zero quality exposure.
- **Eng cost:** Low-to-moderate: cache breakpoint discipline and prefix stability (see next two findings). Mostly a matter of NOT doing harmful things.

Sources:
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### `asserted-credible` — Use the 1-hour cache TTL (ttl: '1h'), not the 5-minute default, for a 5-hour unattended run

- **Claimed saving:** Computable and decisive for this product. 1h write costs 2.0x base vs 5m write at 1.25x — a one-off +0.75x premium. A prefix that goes cold and is re-read costs 1.0x instead of 0.1x — a 0.9x loss. Since 0.75 < 0.9, the 1-hour TTL pays for itself if it prevents even ONE expiry per cached prefix. Anthropic states it 'pays off after just one cache read for the 5-minute duration (1.25x write), or after two cache reads for the 1-hour duration (2x write)'. At 680 calls over 5 hours the average gap is 26s, but that average is misleading: a subagent waiting on a full test suite, a container build, or an npm install routinely idles past 5 minutes, and every such gap silently converts a 0.1x read into a 1.0x re-read of a ~70k-token prefix.
- **Evidence:** Anthropic prompt-caching docs (TTL options and multipliers, fetched 2026-07-27). Corroborated as a real-world failure by Claude Code docs: 'your first message after a break longer than the cache lifetime misses the cache and reprocesses your full context'; and by claude-code issue #46829, 'Cache TTL silently regressed from 1 hour to 5 minutes around early March 2026', labelled area:cost + bug + has repro, which users diagnosed as causing 'quota and cost inflation'.
- **Quality risk:** None. Identical content reaches the model.
- **Eng cost:** Trivial — one field: cache_control: {type: 'ephemeral', ttl: '1h'}.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://code.claude.com/docs/en/costs
- https://github.com/anthropics/claude-code/issues?q=is%3Aissue+cache+cost+token+usage

### `measured` — Cache-prefix hygiene: breakpoint placement, the 20-block lookback window, and the list of things that silently invalidate everything

- **Claimed saving:** Unquantified in general but this is the mechanism that DELIVERS the 85%→95% band above (worth $12.15/ticket). Anthropic documents a specific, extremely common own-goal verbatim: 'Common mistake: Breakpoint on content that changes every request... You set cache_control on block 6 [containing a timestamp]... No cache hit. You pay for a fresh cache write on every request and never get a read.' Also documented and easy to miss: 'The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint' — so a growing agent conversation that adds more than 20 blocks past the last cache write needs a SECOND explicit breakpoint or it misses entirely. Max 4 breakpoints. Hierarchy is strictly tools → system → messages; a change at any level invalidates that level and everything after it.
- **Evidence:** Anthropic prompt-caching docs, fetched 2026-07-27, including an explicit invalidation matrix. Invalidators relevant to this product: tool definitions (names, descriptions, parameters — invalidates EVERYTHING), speed:'fast', tool_choice, images, and thinking/effort configuration. The effort point is separately demonstrated with a runnable three-request trace in Anthropic's extended-thinking docs: request 3 shows cache_creation_input_tokens=1370, cache_read_input_tokens=0 purely because the thinking budget changed.
- **Quality risk:** None if done correctly. The risk is silent financial, not qualitative — a broken breakpoint produces identical output at up to 10x the input cost, and nothing in the response flags it except the usage fields.
- **Eng cost:** Moderate and front-loaded: keep tool definitions byte-stable, hoist all dynamic content (timestamps, file lists, TODO state) AFTER the last breakpoint, pin effort per thread, and assert cache_read_input_tokens > 0 in tests.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking

### `measured` — Environment observation masking (replace tool outputs older than a rolling window of M turns with a placeholder), instead of LLM summarization

- **Claimed saving:** The best-controlled measurement in this entire search. JetBrains Research + TU Munich, SWE-agent on SWE-bench Verified, n=500 instances, 5 model configs, 95% bootstrap CIs (B=10,000), paired significance tests. Headline: masking 'halves cost relative to the raw agent' while matching or slightly exceeding LLM summarization's solve rate. Environment observations are 83.9% of an average SWE-agent turn's context (vs reasoning 9.6%, action 6.5%). Best config (Qwen3-Coder 480B): $1.29 → $0.61/instance (-52.7%) AND solve rate 53.4% → 54.8% (+2.6% relative). Rolling window M=10 was optimal; M=20 was worse. CRITICAL TRANSFER CAVEAT (I checked the appendix): Appendix A states the Qwen costs were computed post-hoc from Alibaba list pricing and that 'the official Alibaba API pricing for the Qwen3-32B model does not distinguish between cache hit and miss input tokens. This leads to an inflated cost of the Qwen3-32B experiments.' Only the Gemini rows are true API-returned, cache-aware costs. So the ~50% figure is NOT bankable at Anthropic's 0.1x cache-read rate: the tokens masking removes are mid-history observations that would otherwise sit in the CHEAPEST token class you own ($0.284/MTok). Worse, a rolling mask boundary rewrites one historical block per turn, which under Anthropic's prefix rules invalidates the cache from that point forward unless you deliberately place a breakpoint at the mask boundary.
- **Evidence:** Lindenbauer, Slinko, Felder, Bogomolov, Zharov (JetBrains Research / TU Munich), 'The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management', arXiv:2508.21433v2, 5 Sep 2025. I read the PDF directly, including Table 1, Table 3 (asymmetric CIs), Table 4 (paired bootstrap p-values) and Appendix A (the cost-model disclosure). Code and data released for reproducibility.
- **Quality risk:** REAL AND MEASURED, and it cuts against the headline. On Gemini 2.5 Flash (thinking) — the one config that is BOTH cache-aware-priced AND reasoning-enabled, i.e. the closest analogue to an Opus/Sonnet agent — observation masking cost 4.0 percentage points of solve rate (40.4% → 36.4%, p=0.0406, statistically significant) and LLM summarization cost 9.0 points (40.4% → 31.4%, p=0.0000). On Qwen3-32B non-thinking, masking cost 2.0pp (not significant). So: in 3 of 5 configs a context strategy beat the raw agent, but on the thinking-enabled config BOTH strategies significantly HARMED it. Do not adopt this blind on a reasoning model. Tune M, and A/B it on your own ticket suite before trusting it.
- **Eng cost:** Low — this is the cheapest intervention here. It is a pure function over message history: replace observations older than M turns with 'Previous N lines omitted for brevity.' No extra model call. Add a cache breakpoint at the mask boundary to avoid the invalidation trap.

Sources:
- https://arxiv.org/abs/2508.21433
- https://huggingface.co/datasets/the-complexity-trap-19fna01lf1Y/main-experiments

### `measured` — TRAJECTORY ELONGATION: LLM summarization/compaction measurably makes agents run LONGER, inflating the retry/wastage multiplier

- **Claimed saving:** This is a NEGATIVE finding and it is the most important one for the owner's largest un-attacked lever. The 1.3-1.5x retry multiplier is $19.50-$32.50/ticket of pure waste on a $65 ticket — bigger than any compression technique in this report. Measured: LLM-Summary produced 15% longer mean trajectories than observation masking on Gemini 2.5 Flash (52 turns vs 44; raw agent 50) and +15% vs raw on Qwen3-Coder 480B. The authors' diagnosis, verbatim: summaries 'mask signs of a failing trajectory, encouraging the agent to persist in unproductive loops' and 'context summaries act as a reinforcing signal, encouraging the agent to keep going.' Separately, summarizer API calls themselves are 0.65%-7.20% of instance cost (Table 2), and are cache-hostile: 'each requires processing a unique sequence of turns, limiting cache reuse to the LLM-Summary system prompt.'
- **Evidence:** Same paper, Sections 4.4, 5.1, 5.2, Figure 4 (turn-count box plots), Table 2. Measured across n=500 instances per model.
- **Quality risk:** This IS the quality/cost risk. A smoothed summary destroys the very failure signal that would have terminated a doomed run — so the technique that looks like a cost saving is partly funding longer failed runs. Transfer caveat: the paper's 'critic' is summarization-time self-critique inside one loop, NOT a separate adversarial reviewer agent, so this is not an argument against the Adversarial Reviewer role in the owner's doc 01.
- **Eng cost:** Low to detect, moderate to act on: instrument turns-per-ticket and cost-per-ticket separately by strategy, and add an out-of-process loop/plateau detector rather than relying on the model to notice it is stuck.

Sources:
- https://arxiv.org/abs/2508.21433

### `measured` — Critic-enhanced summarization (asking the summarizer to also reflect on whether the agent is stuck) — a published NEGATIVE result

- **Claimed saving:** None — it costs more and delivers nothing. Worth recording because it is the obvious next idea and it has already been tried and measured.
- **Evidence:** Same paper, Section 5.1 / Appendix D.3, tested on 150 samples of SWE-bench Verified: the critic-enhanced approach 'showed no improvement in solve rate over standard LLM-Summary. More concerning, we observed exacerbated trajectory elongation patterns, with critic-enhanced runs producing even longer trajectories.' Authors' explanation: 'the critic's reflections naturally encourage the agent to explore alternative solution paths, try additional debugging strategies, or reconsider its approach, all of which translate to more turns.'
- **Quality risk:** No quality gain measured, and a measured cost increase. Strictly dominated.
- **Eng cost:** N/A — recommendation is do not build it.

Sources:
- https://arxiv.org/abs/2508.21433

### `asserted-credible` — Tool search + deferred tool loading (defer_loading: true) — cut tool-definition bloat out of the cached prefix

- **Claimed saving:** Anthropic publishes before/after token counts, not just a percentage: a typical five-MCP-server setup (GitHub, Slack, Sentry, Grafana, Splunk) 'can consume ~55k tokens in definitions before Claude does any work'; tool search reduces this to '~8.7K tokens' — an 84% cut, 'typically reduces this by over 85 percent'. QUANTIFIED FOR THIS PRODUCT: if the orchestrator really carries ~55k of tool definitions, removing ~46k across 680 calls is ~31.5M cached-prefix tokens ≈ $8.9/ticket at $0.284/MTok. If it carries ten hand-written tools (~3k), the saving is approximately zero. So this is conditional — token-count your own tool surface first.
- **Evidence:** Anthropic Engineering, 'Advanced tool use' — internal evaluations with before/after numbers: '85% reduction in token usage'; MCP evaluation accuracy Opus 4 '49% to 74%', Opus 4.5 '79.5% to 88.1%'. Vendor-published internal evals with specific figures; not independently reproduced.
- **Quality risk:** NET POSITIVE on both axes — one of very few here. Anthropic documents that tool selection accuracy 'degrades once you exceed 30-50 available tools', and the MCP eval numbers show accuracy going UP, not down. Crucially for cost: 'the API excludes deferred tools from the system-prompt prefix... The prefix is untouched, so prompt caching is preserved.' One gotcha: a deferred tool cannot also carry cache_control (400 error) — put the breakpoint on a non-deferred tool.
- **Eng cost:** Low. Add the tool_search_tool_regex/bm25 entry, set defer_loading: true on all but your 3-5 hottest tools. Note Claude Code already defers MCP tool definitions by default.

Sources:
- https://www.anthropic.com/engineering/advanced-tool-use
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://code.claude.com/docs/en/costs

### `asserted-credible` — Programmatic tool calling / code execution — orchestrate tools in code so intermediate results never enter context

- **Claimed saving:** 37% reduction on complex research tasks, given as an absolute before/after: '43,588 to 27,297 tokens'. This is the right shape for an orchestrator that currently fans out to subagents and pulls every result back into its own context.
- **Evidence:** Anthropic Engineering, 'Advanced tool use'. Also reports accuracy gains alongside: internal knowledge retrieval '25.6% to 28.5%', GIA benchmarks '46.5% to 51.2%'. Vendor internal evals; specific numbers, unreproduced externally.
- **Quality risk:** Reported as accuracy-improving, not degrading. Anthropic's own stated tradeoff is honest: the features 'add latency through extra processing steps; ROI depends on context savings and accuracy gains outweighing additional overhead.' Latency matters less on a 5-hour unattended run than almost anywhere else, which makes this an unusually good fit.
- **Eng cost:** Moderate — requires restructuring orchestrator/subagent handoffs to pass identifiers and let code do the joining, rather than pasting transcripts.

Sources:
- https://www.anthropic.com/engineering/advanced-tool-use

### `asserted-credible` — Filter verbose tool output BEFORE it reaches the model (PreToolUse hooks / wrapper scripts on test and build commands)

- **Claimed saving:** Anthropic gives the shape but not a benchmark: 'Instead of Claude reading a 10,000-line log file to find errors, a hook can grep for ERROR and return only matching lines, reducing context from tens of thousands of tokens to hundreds.' Independent corroboration of the size of the prize: the JetBrains paper measured environment observations at 83.9% of agent context. For a product whose loop is 'build, run tests, read output', test/build logs are plausibly the single largest token class in the run — and unlike system prompts, they are UNCACHED tail content at $2.843/MTok, ten times the value of trimming the cached prefix.
- **Evidence:** Claude Code cost docs publish a working PreToolUse hook that rewrites `npm test`/`pytest`/`go test` into a grep-filtered form. Vendor guidance with a concrete implementation; no published before/after benchmark. The 83.9% observation share is measured (JetBrains).
- **Quality risk:** REAL and under-discussed. Over-aggressive filtering hides the stack trace, the failing assertion's context, or the flaky-test signal — and an agent that cannot see why a test failed will loop, which costs more than the tokens saved (see trajectory elongation). Mitigate by filtering deterministically and generously (grep -A 5 with a head cap, keep full output for the FIRST failure), never by summarizing with a model.
- **Eng cost:** Low, and it is the highest value-per-hour item in this report because it attacks the expensive uncached class with a deterministic, zero-model-call transform.

Sources:
- https://code.claude.com/docs/en/costs
- https://arxiv.org/abs/2508.21433

### `asserted-credible` — Extended thinking is very probably the dominant output cost — and on Opus 5 / Sonnet 5 it is billed TWICE (as output, then as input forever after)

- **Claimed saving:** Unquantified for this product until measured, but structurally the largest output lever. Anthropic: 'Thinking tokens are billed as output tokens, and the default budget can be tens of thousands of tokens per request.' At 680 calls, even ~3.5k thinking tokens per call is ~2.4M tokens — i.e. essentially the owner's entire 2.5M output budget. Then the compounding part: 'Claude Opus 4.5 and models numbered 4.6 and higher keep prior turns' thinking blocks in context and bill them as input, where Claude Sonnet 4.5, Claude Haiku 4.5, and earlier models stripped them.' Opus 5 and Sonnet 5 are both in the retaining class. Anthropic ships clear_thinking_20251015 (context editing) with a keep: {thinking_turns: N} option specifically for this.
- **Evidence:** Anthropic extended-thinking docs and context-editing docs, both fetched 2026-07-27; Claude Code cost docs. A CONSISTENCY FLAG WORTH RAISING: 47.5M / 680 = ~70k input per call. Unbounded thinking-block retention over 680 calls would blow far past that, so either the run already compacts, or the 47.5M figure assumes clearing that is not yet configured. Measure before trusting the model.
- **Quality risk:** HIGH and asymmetric — this is where cost-cutting most easily becomes a downgrade. The owner's own doc 01 records a ~250-Elo AA-Briefcase spread from effort alone on Opus 5 (1720 max → 1470 medium), with Opus 5 at medium ranking BELOW Fable 5 at max. Cutting orchestrator thinking is the one cut not to make. The safe version is selective: clear_thinking on turns whose reasoning is spent, and route mechanical dispatch/triage turns to SEPARATE low-effort threads. It must be separate threads, because changing effort mid-conversation invalidates the cache (demonstrated with a runnable trace in Anthropic's docs) — so the cache constraint and the quality constraint happen to point at the same architecture.
- **Eng cost:** Low to instrument (one usage field), moderate to act on (thread topology). Note clearing thinking blocks invalidates the cache at that point, so batch it — Anthropic provides clear_at_least for exactly this reason.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://code.claude.com/docs/en/costs

### `folklore` — 'Caveman mode' and ultra-terse output styles — the owner's example, researched properly

- **Claimed saving:** Headline claim ~65-75% output-token reduction (vendor: '65% mean output-token reduction' across a ten-prompt suite, range 22-87%; one popular post claims 'slash output tokens by 75%'). Independent reproductions do NOT support this: one benchmark measured 'actual token savings landed between 14 and 21 percent'; a review aggregating community reproductions reports 'real-world savings are typically 30-50% on output tokens, not 75%', and separately that 'a one-line be brief. instruction captured most of the savings on its own' and that a hand-rolled 6-line prompt beat the full skill on the quality/token tradeoff.
- **Evidence:** Vendor repo (JuliusBrussee/caveman) vs at least three independent practitioner reproductions. Methodologies are thin — small prompt suites, single runs, no confidence intervals — but they are genuine before/after measurements and they disagree with the vendor by 3-5x. This is exactly the pattern the ground rules ask to be flagged.
- **Quality risk:** Documented, and mode-dependent: 'lite and full modes preserve correctness on coding tasks. ultra mode occasionally drops edge cases', plus 'a small but real regression on tasks requiring nuanced explanations'. THE STRUCTURAL LIMIT MATTERS MORE THAN THE QUALITY RISK: the skill's own docs say it 'only affects output tokens — thinking/reasoning tokens are untouched'. For this workload, thinking is plausibly most of the 2.5M output, and the non-thinking remainder is mostly source code and tool-call JSON, which is incompressible without information loss. Terse prose only compresses the narration. That is precisely why 14-21% reproduces and 75% does not.
- **Eng cost:** Trivial (a system-prompt block) — but it must be a STABLE block placed inside the cached prefix, never rotated per call, or it destroys more in cache invalidation than it saves.

Sources:
- https://github.com/JuliusBrussee/caveman
- https://andrew.ooo/posts/caveman-claude-code-skill-token-savings-review/
- https://www.nathanonn.com/claude-code-caveman-mode/

### `asserted-credible` — Learned prompt compression (LLMLingua / LongLLMLingua / LLMLingua-2)

- **Claimed saving:** 'up to 20x compression with minimal performance loss'; LongLLMLingua reports 'up to 21.4% performance boost' in RAG using 1/4 of the tokens; an 11.2x example on a maths reasoning task. Peer-reviewed (EMNLP'23, ACL'24).
- **Evidence:** Microsoft Research repo and papers. The published evaluations are dominated by QA, summarization and reasoning benchmarks — a code-compression example exists in the repo but I found no agentic-coding evaluation. Maintenance signal is weak for 2026: ~85 commits on main and the most recent releases referenced are 2024-era (MInference 24/07/03, KV cache 24/12/13).
- **Quality risk:** Unknown for this workload, and the burden of proof is unmet. Compressing source code, diffs, stack traces and tool-call JSON is categorically different from compressing prose, and none of the headline numbers were measured on that. WRONG AXIS ANYWAY: it compresses INPUT — the cheap side at $0.284/MTok cached — and it does so by rewriting content, which mutates the prefix and breaks caching. Under this cost structure it can plausibly cost more than it saves.
- **Eng cost:** High — an extra model in the loop, plus latency, plus a new failure mode.

Sources:
- https://github.com/microsoft/LLMLingua

### `asserted-credible` — Subagent context isolation: return condensed results to the orchestrator, never raw transcripts

- **Claimed saving:** Anthropic's own architecture guidance quantifies the return payload — sub-agents should return condensed summaries 'often 1,000-2,000 tokens' to a coordinator. Claude Code docs give the rationale directly: 'Delegate these to subagents so the verbose output stays in the subagent's context while only a summary returns to your main conversation.' This matters more than it looks under the owner's price ladder, because a subagent transcript pulled into the orchestrator is billed twice — once as Sonnet output at $10/MTok, then again as Opus input at up to $5/MTok uncached.
- **Evidence:** Anthropic Engineering 'Effective context engineering for AI agents' and Claude Code cost docs. Notably, the engineering post's OWN measured backing is thin — its sub-agent claim is 'substantial improvement over single-agent systems on complex research tasks' with no percentages, and its compaction claim of 'minimal performance degradation' has, in the fetched text, no quantitative support. Treat as reasoned vendor architecture guidance, not measurement.
- **Quality risk:** Real: a 1,000-2,000 token summary of a 50,000-token debugging session is lossy by construction, and if the orchestrator later needs the detail it must re-derive it — a retry, which is the expensive failure mode. Mitigate with the just-in-time pattern: return the summary PLUS stable identifiers (file paths, log paths, run IDs) the orchestrator can re-fetch on demand, rather than trying to make the summary self-sufficient.
- **Eng cost:** Moderate — it is an orchestrator protocol decision, cheapest to make now and expensive to retrofit.

Sources:
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://code.claude.com/docs/en/costs

### `asserted-credible` — Repo maps and code intelligence instead of speculative file reads (Aider's tree-sitter + PageRank repo map)

- **Claimed saving:** Aider ships a hard token budget for codebase context: --map-tokens defaults to 1,000 tokens for a map of an entire git repo, built with tree-sitter and ranked by 'a graph ranking algorithm, computed on a graph where each source file is a node and edges connect files which have dependencies', selecting 'the most important identifiers, the ones which are most often referenced by other portions of the code'. Independent corroboration from Anthropic: code intelligence plugins mean 'a single go to definition call replaces what might otherwise be a grep followed by reading multiple candidate files.'
- **Evidence:** Aider documentation (the mechanism is well-documented; I found no published before/after token benchmark for the repo map specifically). Aider is the most credible source here because it also publishes real dollar accounting — see the cost-accounting finding.
- **Quality risk:** Low, and arguably positive — a ranked map plus targeted reads is closer to how the relevant code is actually found than dumping directory trees. Residual risk: a map that is too small hides the file that mattered, causing exploratory reads that cost more than the map saved. The budget is tunable for exactly this reason.
- **Eng cost:** Moderate — tree-sitter parsing and ranking, or adopt an existing implementation.

Sources:
- https://aider.chat/docs/repomap.html
- https://code.claude.com/docs/en/costs

### `asserted-credible` — Per-run, per-phase, per-agent cost instrumentation (the prerequisite for everything else)

- **Claimed saving:** No direct saving — but nothing else in this report can be validated without it, and the owner's model contains at least two assumptions (85% cache hit, 47.5M input) that are currently unmeasured. The exact fields to log per call: cache_read_input_tokens, cache_creation_input_tokens, input_tokens (Anthropic states total_input_tokens = the sum of these three), output_tokens, and usage.output_tokens_details.thinking_tokens, which 'reports how many of the billed output tokens were internal reasoning'. If context editing or compaction is on, sum usage.iterations — Anthropic warns the top-level counts 'reflect only non-compaction iterations', so a naive integration UNDER-COUNTS the bill.
- **Evidence:** Anthropic API docs (usage fields, compaction iterations). Tooling that exists and is maintained: ccusage (17.5k stars, 1,503 commits, MIT, scheduled pricing-update workflow) reads local agent session data and reports per-session/per-model cost with cache creation and cache read tracked distinctly. Anthropic recommends OpenTelemetry export as 'the only option that streams per-user token and cost metrics into your own observability stack in near real time', and notes 'several large enterprises reported using LiteLLM' for per-key spend. Langfuse/Helicone/LangSmith occupy the same niche via OTel GenAI semantic conventions.
- **Quality risk:** None.
- **Eng cost:** Low — log the usage block per call, tagged with ticket ID, phase, agent role and model. Do this before any optimisation, so every later change has a measured before/after on YOUR workload rather than someone else's benchmark.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://github.com/ryoppippi/ccusage
- https://code.claude.com/docs/en/costs
- https://langfuse.com/docs/observability/features/token-and-cost-tracking

### `asserted-credible` — COMMUNITY-DOCUMENTED FAILURE MODES: how agent bills actually blow up in the field

- **Claimed saving:** Avoided losses, unquantified individually, but these are the non-obvious sinks. From the anthropics/claude-code tracker (the area:cost label is a useful discovery vector in itself): #46829 cache TTL silently regressing 1h→5m 'around early March 2026', causing 'quota and cost inflation' (labelled bug + has repro); #46917 'CC v2.1.100+ inflates cache_creation by ~20K tokens vs v2.1.98 with identical payloads' — server-side, open; #40524 'Conversation history invalidated on subsequent turns', a regression with direct token-cost impact. From cline/cline: #4047 'Cline Sends Excessive Cache Data to LLM Even for Trivial Prompts'; #3158 'Prompt Caching Issue & High Cost Spikes'; #5067 Anthropic cache 'not functioning as expected with LiteLLM'; #11037 context-window UI 'double-counts cacheReads for OpenAI-compatible providers'. Anthropic's own docs name the sinks plainly: long context, cache misses after a break, scheduled tasks firing on idle sessions, and 'Compaction: /compact reads the conversation it summarizes, so compacting a large context is itself a large request.'
- **Evidence:** GitHub issue trackers (anthropics/claude-code, cline/cline) and Claude Code cost documentation, all read 2026-07-27. Mixed rigor — several are user reports rather than confirmed root causes — but the recurring pattern is unambiguous and points one way: cost regressions are almost always CACHE regressions, they are silent, and they are frequently caused by someone else's change (a harness upgrade, a proxy layer, a server-side default).
- **Quality risk:** N/A — these are pure financial failures producing identical or worse output.
- **Eng cost:** Low: alert on cache_read_input_tokens / total_input_tokens dropping below a threshold, pin harness and SDK versions, and be wary of proxy layers (two of the above are LiteLLM/gateway integration bugs, which is a mark against inserting a gateway before you need one — consistent with doc 01's 'skip gateways initially' conclusion).

Sources:
- https://github.com/anthropics/claude-code/issues?q=is%3Aissue+label%3Aarea%3Acost
- https://github.com/cline/cline/issues?q=is%3Aissue+cost+cache+token+usage
- https://code.claude.com/docs/en/costs

### `asserted-credible` — Parallel agent fan-out is the most expensive architectural decision available — treat team size as a cost parameter

- **Claimed saving:** Inverted: a documented cost MULTIPLIER. Anthropic publishes a figure: 'Agent teams use approximately 7x more tokens than standard sessions when teammates run in plan mode, because each teammate maintains its own context window and runs as a separate Claude instance', and 'token usage is roughly proportional to team size.' Their mitigations are directly applicable: use Sonnet for teammates, keep teams small, keep spawn prompts focused ('Teammates load CLAUDE.md, MCP servers, and skills automatically, but everything in the spawn prompt adds to their context from the start'), and shut teammates down when done since 'each active teammate continues consuming tokens until it exits'.
- **Evidence:** Claude Code cost documentation, fetched 2026-07-27. Vendor-published aggregate from their own deployment; the 7x is scoped specifically to plan mode and is not a general multiplier.
- **Quality risk:** Genuinely two-sided and unresolved. Anthropic's own context-engineering post claims sub-agent architectures give 'substantial improvement over single-agent systems on complex research tasks'. So fan-out may buy quality. The point is not to avoid it but to price it: each additional concurrent subagent is a roughly linear cost increase, and idle-but-alive subagents are pure waste.
- **Eng cost:** Low to control (cap concurrency, reap finished subagents, keep spawn prompts minimal), high to get wrong.

Sources:
- https://code.claude.com/docs/en/costs
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### `asserted-credible` — PUBLISHED REAL COST FIGURES (bucket G) — what actually exists, and it is thinner than the market implies

- **Claimed saving:** N/A — reference points for sanity-checking the $65-70/ticket model. (1) Aider's leaderboard publishes total dollar cost per full benchmark run of 225 tasks, e.g. 'gpt-5 (high) $29.08' (2025-08-23), 'o3-pro (high) $146.32' (2025-06-28), 'DeepSeek-V3.2-Exp $0.88' (2025-10-03) — roughly $0.13/task for gpt-5 high, on small self-contained edit tasks. (2) JetBrains measured $0.18-$1.29 per SWE-bench Verified instance across five configs. (3) Anthropic publishes real deployment aggregates: 'the average cost is around $13 per developer per active day and $150-250 per developer per month, with costs remaining below $30 per active day for 90% of users', plus background token usage 'typically under $0.04 per session'. The gap between $0.13-$1.29 per bench task and $65-70 per multi-hour autonomous build is roughly two orders of magnitude, which is what you would expect and does not invalidate the model — but nothing I found independently validates a figure at the owner's scale.
- **Evidence:** Aider leaderboard (self-reported by the harness authors, but generated by their own accounting code — unusually credible and reproducible); arXiv:2508.21433; Anthropic Claude Code cost docs (vendor aggregate over enterprise deployments, no methodology published).
- **Quality risk:** N/A.
- **Eng cost:** N/A.

Sources:
- https://aider.chat/docs/leaderboards/
- https://arxiv.org/abs/2508.21433
- https://code.claude.com/docs/en/costs

### `asserted-credible` — Server-side context editing and compaction (Anthropic-managed) as an alternative to rolling your own

- **Claimed saving:** Unquantified by Anthropic — and that absence is itself the finding. clear_tool_uses_20250919 clears oldest tool results (defaults: trigger 100,000 input tokens, keep 3 tool uses), clear_thinking_20251015 clears thinking blocks, and compact_20260112 summarizes at a default 150,000-token trigger. The docs publish NO token-reduction percentages and NO benchmark accuracy deltas for any of them. Two cost mechanics are documented and easy to miss: clearing tool results 'invalidates cached prefixes... You'll incur cache write costs each time' (hence the clear_at_least knob, explicitly 'helps avoid breaking prompt cache for marginal gains'), and compaction 'requires an additional sampling iteration for summarization, which contributes to both rate limits and billing'.
- **Evidence:** Anthropic context-editing and compaction docs, fetched 2026-07-27. The fetched compaction page's only quality statement is directional, not measured: 'As a conversation grows, response quality degrades, so compaction replaces older content with a concise summary.'
- **Quality risk:** UNKNOWN from the vendor — no published evaluation. But the best available external evidence is directly on point and is a warning: the JetBrains paper measured LLM summarization costing 9.0 solve-rate points on a thinking-enabled model (p<0.0001) and lengthening trajectories 15%. Anthropic's compaction is the same mechanism, server-side. Do not enable it on the strength of convenience alone; A/B it against plain observation masking on your own ticket suite.
- **Eng cost:** Very low to enable (a beta header and a config block) — which is precisely the risk, since it is easier to turn on than to evaluate.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://arxiv.org/abs/2508.21433
