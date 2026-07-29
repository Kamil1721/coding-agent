# Model & Agent Architecture

> **How to read the confidence tags.** `[verified]` = read off a primary source and re-confirmed in adversarial verification on 2026-07-27. `[uncertain]` = not established by primary source; do not build a load-bearing decision on it. `[corrected]` = the first research pass got this wrong and the figure below is the corrected one. Every dollar figure is list price as of 2026-07-27.

---

## 1. Model & Billing Recommendation

### 1.1 Decision summary

| Decision | Recommendation | Runner-up | Switch when |
|---|---|---|---|
| Orchestrator model | **Claude Opus 5** (`claude-opus-5`) at `effort: high` | Claude Fable 5 at `xhigh` | Opus 5 at `xhigh` still produces >2 re-plans per ticket **and** you have implemented the Fable 5 `fallbacks` refusal path |
| Spec / review model | **Claude Opus 5** at `effort: xhigh`, run as separate agents | Fable 5 | Same as above |
| Subagent (code-writing) model | **Claude Sonnet 5** (`claude-sonnet-5`) at `effort: medium` | GPT-5.3-codex via a second provider | Sonnet 5 medium fails an effort sweep after the 2026-09-01 price rise |
| Subagent (non-code mechanical) | **Claude Haiku 4.5** — log triage, failure classification, report formatting only | Sonnet 5 at `low` | Never for code: Feb 2025 knowledge cutoff |
| Billing route | **Anthropic first-party pay-as-you-go API key under Commercial Terms** | Amazon Bedrock (only if AWS Activate credits land) | Activate grant approved; then route *overflow* to Bedrock, never primary |
| Gateway | **None initially.** Anthropic direct + SDK-level `fallbacks` | Vercel AI Gateway (0% markup incl. BYOK) | You add a second model vendor |

### 1.2 Orchestrator: Claude Opus 5 at `high`

**Why Opus 5 and not Fable 5**, despite Fable 5 topping the official Terminal-Bench 2.1 board at 83.8%:

| Factor | Opus 5 | Fable 5 |
|---|---|---|
| Price per MTok in/out `[verified]` | $5 / $25 | $10 / $50 |
| AA-Briefcase long-horizon agentic Elo `[corrected]` | **1720 (max), 1693 (xhigh), 1606 (high)** — rank 1 | 1574 (max) — rank 4 |
| AA Terminal-Bench v2.1, Terminus 2 harness `[verified]` | 89.1% (max) | not listed at max |
| Availability risk `[verified]` | none known | **fully suspended 2026-06-12 to 06-30** (18 days) under US export controls, on 3 days' notice; multi-cloud failover was *not* immediately restored |
| Refusal path | none | returns `stop_reason: "refusal"` as HTTP 200; needs `fallbacks` handling. Its AA-Briefcase entry is annotated "Opus 4.8 Fallback" |
| Benchmark validity | measured post-release | **both headline scores (Jun 5/7) predate the June 12 suspension**; the redeployed model ships a stricter safety classifier and has not been re-run |
| Task budgets (`task-budgets-2026-03-13`) | supported | supported |
| ZDR eligible | yes | no (30-day retention, designated Covered Model) |

Opus 5 is the top-ranked model on the only independent long-horizon agentic benchmark that carries both, at half Fable 5's token price, with no availability precedent and no refusal-path integration burden. This is not close.

> **Correction flagged inline.** An earlier pass claimed Opus 5 had "zero independent agentic verification." That was wrong. Artificial Analysis publishes two independent evaluations of it (AA-Briefcase Elo 1720; Terminal-Bench v2.1 89.1%), both at *max* effort. Do not read the 1720 figure as applying to the `high` setting you will actually run.

**Effort policy — this matters more than model choice.** On AA-Briefcase, holding model, benchmark and evaluator constant and varying only `effort`, Opus 5 spans **1720 (max) → 1693 (xhigh) → 1606 (high) → 1470 (medium)**. That ~250-Elo spread from effort alone dwarfs every model-vs-model gap in this document. Critically, **Opus 5 at `medium` (1470) ranks below Fable 5 at max (1574) and Kimi K3 (1540)** — so the obvious budget cut (drop the orchestrator to medium) is the one cut you must not make.

| Role | Effort | Rationale |
|---|---|---|
| Orchestrator routine turns (dispatch, merge, gate check) | `high` | Anthropic's own Opus 5 guidance is verbatim "Start with `high`, the default" — a change from Opus 4.7/4.8, which said start at `xhigh`. Do not carry old effort settings over. |
| Spec Architect | `xhigh` | one-shot, high leverage, ~0.7M tokens |
| Adversarial Reviewer | `xhigh` | one-shot, high leverage |
| Anything | **never `max`** | non-monotonic: GPT-5.6 Sol scores *higher* at xhigh (89.5%) than max (88.0%) on AA Terminal-Bench; Anthropic's own doc warns max "can lead to overthinking." Cost rises, quality may not. |

Because **changing `effort` mid-conversation invalidates prompt caching** `[verified]`, the Spec Architect and Adversarial Reviewer must be *separate agents on separate threads* pinned at `xhigh`, not the orchestrator temporarily raising its own effort. That is a hard architectural constraint, not a stylistic preference — it is the reason the roster in §3 splits those two roles out.

**Two Opus 5 modifiers to disable explicitly in code:**
- `speed: "fast"` — research preview, prices Opus 5 at **$10/$50, exactly 2x**, across the full context window. If any wrapper or default enables it, your entire cost model doubles silently. Assert it is unset.
- `inference_geo: "us"` — applies a **1.1x multiplier to all token categories including cache reads and writes** on Claude 4.6+. Only enable if you have a data-residency requirement; budget +10% on every figure below if you do.

### 1.3 Subagents: Claude Sonnet 5 at `medium`

Sonnet 5 is the strongest independently-verified cheap agentic model in the Claude line: **74.6% ± 1.6% on Terminal-Bench 2.1** in Claude Code, within 4.3 points of Opus 4.8, at roughly 40% of the token price. Anthropic's own effort doc states verbatim that **"Medium effort … Comparable to Claude Sonnet 4.6 at high effort"** — so `medium` is a genuine cost step-down, not a capability step-down.

**Haiku 4.5 is rejected for code work** and this is worth stating plainly, because it is the obvious cheap pick. It has a **Feb 2025 reliable knowledge cutoff** (fatal for writing 2026-era framework code), a 200k context (5x smaller than the rest of the line), **no `effort` parameter at all**, no task-budget support, and it does not appear on the Terminal-Bench 2.1 board. Sonnet 5 at `medium` costs roughly 2x more and is a different class of tool. Use Haiku 4.5 only where correctness is checkable by a regex: triaging log lines, classifying test failures into buckets, reformatting reports.

**Sonnet 5 has a dated cost cliff you must plan around now:**

| Date | Sonnet 5 in/out per MTok | Effective vs a Sonnet 4.6 baseline |
|---|---|---|
| through 2026-08-31 `[verified]` | $2 / $10 (introductory) | cheap |
| from 2026-09-01 `[verified]` | **$3 / $15** (+50%) | **~$3.90/$19.50-equivalent** once the ~30% tokenizer inflation is applied |

Claude 4.7-and-later models use a newer tokenizer that **"produces approximately 30% more tokens for the same text"** `[verified]`. Sonnet 5 is on it; Sonnet 4.6 is not. Two independent increases land within five weeks of each other. **Budget every month after August at the $3/$15 rate.** Do not read this as "downgrade to Sonnet 4.6" — 4.6 does not support `xhigh` and needs more tokens for equivalent output, which partly cancels the difference.

**Sonnet 5 does not support task budgets** `[verified]`. The budget countdown lives on the orchestrator only; subagent spend is capped out-of-process by `max_tokens` and the orchestrator's ledger.

### 1.4 Billing route: pay-as-you-go, and the subscription question answered

**The blunt answer to the user's question: no provider sells a monthly coding subscription whose quota may lawfully be spent through your own API key to power a ticket-driven product that other people submit work to.** This was tested against primary legal documents in two independent verification passes. Pay-as-you-go under Anthropic's Commercial Terms is not merely the cheapest sanctioned route — it is the only clearly sanctioned one.

The permission is explicit, not inferred. Anthropic Commercial Terms §A.1, verbatim: **"Anthropic gives Customer permission to use the Services, including to power products and services Customer makes available to its own customers and end users."**

#### Subscriptions: disqualified vs viable

| Subscription | Price | API key from it? | Solo commercial use | Multi-tenant product | Verdict |
|---|---|---|---|---|---|
| **Claude Pro / Max** | $20/mo ($17 annual, $200 up front); Max from $100/mo `[corrected: annual total is $200, not $204]` | Partial — `claude setup-token` mints a documented one-year OAuth token for CI, but drives Claude Code / Agent SDK only, not raw `/v1/messages` | **Contested** | **No** | **DISQUALIFIED** |
| **ChatGPT Plus / Pro / Business** | $20 / $100–200 / $25 per seat | **No — no tier exposes an API key.** Codex "API-key mode" is a separate PAYG track billed at API rates | n/a | n/a | **DISQUALIFIED (technically impossible)** |
| **Z.ai GLM Coding Plan** | from $18/mo | Yes, technically — `https://api.z.ai/api/anthropic` | **No** | **No** | **DISQUALIFIED (explicitly prohibited)** |
| **MiniMax Token Plan** | Plus $20 / Max $50 / Ultra $120 per month `[corrected: this is verified-primary on platform.minimax.io, not an aggregator lead]` | Yes — Subscription Key against `https://api.minimax.io/anthropic`, "callable from backend code using the Anthropic SDK" | **Unknown** | **Unknown** | **DO NOT BUILD ON IT** |
| **Cerebras Code** | Pro $50 / Max $200 per month | Yes, OpenAI-compatible | — | — | **UNAVAILABLE — both tiers sold out as of 2026-07-27** |
| **Synthetic** | $30/mo | Yes | — | — | **ARCHITECTURALLY DISQUALIFIED — "1 concurrent request per model"** |
| **Google AI Pro / Ultra** | Pro: **$10/mo** in Google Cloud credits; Ultra: $40 (20TB) or $100 (30TB) `[corrected: the $40 figure belongs to Ultra, not Pro — earlier research crossed the rows]` | Yes — credits redeem into a normal Google Cloud billing account, spendable on Vertex AI / Gemini API | Yes | Yes | **VIABLE BUT IMMATERIAL** |
| **GitHub Copilot** | $10 / $39 / $100 per month | Yes — GitHub Models with a `models:read` PAT | — | — | **PROTOTYPING ONLY** — free tier is 10–15 req/min and 50–450 req/day |

**Why each disqualification holds:**

- **Claude Pro/Max.** Consumer Terms §3, verbatim: *"You may not share your Account login information, Anthropic API key, or Account credentials with anyone else **or make your Account available to anyone else**."* A dashboard where other people submit tickets that spend your subscription quota is precisely that. Independently, the Claude Agent SDK overview states: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* And Anthropic's own support guidance steers you away: *"Teams running shared production automation should use Claude Platform with an API key for predictable pay-as-you-go billing"*; *"Credits belong to individual accounts. They can't be shared or pooled across teammates."*
  > **`[uncertain]` — flag for an EEA-based owner.** Anthropic's Consumer Terms are **geo-served from a single URL**. The EEA/Switzerland variant contains a subsection headed *"Non-commercial use only"* reading *"You agree that you will not use our Services for any commercial or business purposes…"*. This sits in Section 11 (liability and indemnity), **not** in the Section 3 prohibited-use list, and its operative half is a damages limitation — standard EU consumer-contract drafting. It is single-sourced to one verification pass and a second pass reading the same URL did not see it. Net: **solo** commercial use of a Claude subscription is *contested, not clearly permitted*. This does not change the recommendation; it strengthens it.
- **Z.ai GLM Coding Plan.** The governing subscription terms (not the FAQ) prohibit this use four separate ways, verbatim: *"You shall not use the GLM Coding Plan quota for general-purpose API access or any scenarios outside such tools"*; *"you may not resell, sub-resell, repackage, aggregate, proxy or otherwise provide the GLM Coding Plan to any third party"*; *"nor may you use the GLM Coding Plan to provide model capabilities as a service to third parties"*; *"tied to a single account and is licensed only to the individual natural person."* Enforcement is stated: *"rate limiting, account freezing, or other restrictions."* Separately, its published quotas are 2–3x smaller than they look: `[corrected]` GLM-5.2 and GLM-5-Turbo *"will be deducted at 3x during peak hours and 2x during off-peak hours"*, so a Lite plan's advertised ~80 prompts/5h is roughly **27 flagship-model prompts at peak**.
- **MiniMax.** This is the best *technical* fit in the entire market — a $20–120/month subscription whose key works against an Anthropic-compatible endpoint from backend code — and its legal answer is **blank**. The governing Open Platform ToS was unretrievable across four independent attempts (`platform.minimax.io/protocol/service-agreement` returns 404). The quickstart enumerates a closed list of eight supported tools (Claude Code, Cursor, Trae, OpenCode, Kilo Code, Grok CLI, Codex CLI, Droid); a bespoke orchestrator is not among them, and the FAQ uses supported-tools framing. Silence is not permission. Do not build on it without written confirmation from MiniMax.
- **Google.** The only legally clean subscription-to-API-credit path, because the credits land in an ordinary Google Cloud billing account under ordinary commercial terms. It is also **economically irrelevant here**: $10/month is roughly 12% of one modelled ticket. Credits *"expire a year after grant"* and *"cannot roll over"*, so you cannot bank them. Treat this as a rounding error, not an exception.

#### Gateways: skip them for now

| Route | Inference markup | Real cost | Verdict |
|---|---|---|---|
| **Anthropic direct** | — | list | **Recommended** |
| Vercel AI Gateway | **0%, including BYOK** `[verified]` | payment processing fees only; free monthly credit is **forfeited permanently on first top-up** | Add later, as a second-vendor router. Costs nothing to have. |
| OpenRouter | 0% on inference `[verified]` | **5.5% Stripe deposit fee** ($0.80 min), 5% crypto; BYOK 5% after the first 1M monthly requests | Only if you need model breadth. The "no markup" framing is misleading — the 5.5% is real. |
| Amazon Bedrock | **+20% on the Opus line** (Opus 4.8: $6/$30 vs $5/$25) `[verified]` | see below | Only with Activate credits |
| Claude Platform on AWS | list rates, billed as Claude Consumption Units | — | **Trap — see below** |

At one vendor and one dashboard, a gateway buys you nothing that the Agent SDK's own `fallbacks` parameter does not. Add Vercel AI Gateway the day you add a second vendor.

**Two Bedrock caveats that are easy to get wrong:**
- `[uncertain]` The +20% uplift is **verified only on the Opus line**. AWS's Bedrock pricing page carries a Sonnet 5 note quoting **$2/$10 rising to $3/$15** — identical to Anthropic first-party, i.e. *parity, not 1.2x*. The Sonnet 5 Bedrock table row itself could not be retrieved. Verify in a browser before assuming Bedrock is uniformly 20% worse.
- **Claude Platform on AWS pins you to the Start tier permanently.** Verbatim: *"Organizations on Claude Platform on AWS are placed on the Start tier and do not move between usage tiers automatically… the Request rate limit increase flow is not available."* That caps you at **$500/month forever with no self-service escape** — roughly 6 tickets. Do not route AWS credits through it.

**AWS Activate is worth more than every routing optimisation combined.** Up to **$200,000** in credits, and AWS states verbatim *"Credits are redeemable on third-party models on Amazon Bedrock."* At the modelled per-ticket cost that is thousands of tickets, and it makes Bedrock's uplift irrelevant. Apply to it and to Anthropic's startup programme in parallel with building. `[uncertain]` Whether Activate credits apply to *Claude Platform on AWS* (as opposed to Bedrock) is unverified and Marketplace charges are commonly excluded — confirm before planning around it.

### 1.5 Three non-negotiable constraints the billing route imposes

1. **The Start-tier spend cap is your month-one ceiling.** $500/month `[verified]`, which at the modelled cost is **about 6 tickets**. It *does* auto-escalate (*"limits… increase automatically as your organization builds usage history"*) and a "Request rate limit increase" flow exists — so it is a friction, not a wall — but it will bite in week one. Apply for an increase before launch. `[corrected: earlier research called this "the binding production constraint" and omitted the escalation path.]`
2. **A per-ticket hard dollar ceiling and kill switch is a launch blocker, not a nice-to-have.** At ~$85/ticket against a $500 cap, one runaway agent loop in an unattended overnight run can exhaust the month's entire API budget before you wake up, and *"API usage pauses until the next month."* The dashboard must enforce a per-ticket token and dollar ceiling out-of-process, independent of anything the model decides.
3. **AI disclosure is a build requirement.** Anthropic's Usage Policy, verbatim: *"All consumer-facing chatbots, including any external-facing or interactive AI agent, must disclose to users that they are interacting with AI rather than a human."* A ticket dashboard driving an autonomous agent is squarely in scope. Ship the disclosure surface from day one.

**Also note: Priority Tier is not an option.** It is closed to new purchase *and* explicitly unsupported on Opus 5 and Sonnet 5. There is no guaranteed-capacity product for the models this uses.

---

## 2. Cost Model Per Completed Ticket

### 2.1 Token budget for one "build me a golf app"-scale ticket

Assumptions, stated so you can re-run them: full-stack app, ~5 hours wall clock, ~680 model calls across all agents, ~1.5 agents running on average. Counts are in **Claude 4.7+ tokenizer units** — multiply by ~0.77 to compare against any non-Anthropic model, because of the ~30% tokenizer inflation.

| Phase | Calls | Gross input | Output | Owner |
|---|---:|---:|---:|---|
| Clarify + spec freeze | 15 | 0.7M | 50k | Spec Architect (Opus 5 xhigh) |
| Plan + task graph | 25 | 1.8M | 100k | Orchestrator (Opus 5 high) |
| Scaffold + infra | 40 | 2.5M | 150k | Builder (Sonnet 5 medium) |
| Backend build | 140 | 10.0M | 525k | Builder-backend |
| Frontend build | 140 | 10.0M | 525k | Builder-frontend |
| Acceptance test authoring | 55 | 4.0M | 300k | Test Author |
| Test run + debug loops (x2–3) | 130 | 9.0M | 400k | Debugger |
| Adversarial review | 40 | 3.0M | 150k | Reviewer (Opus 5 xhigh) |
| Fix iterations (cap 3) | 85 | 6.0M | 250k | Debugger + Builders |
| Final gate + handoff report | 10 | 0.5M | 50k | Orchestrator |
| **Total** | **680** | **47.5M** | **2.5M** | |

**Sanity check against the one published anchor.** Long-Horizon-Terminal-Bench measured **9.8M tokens per ~89-minute task** — about 110k tokens/minute single-threaded. Five hours single-threaded would be ~33M; at ~1.5 average concurrency that is ~50M. The estimate lands where the only real measurement says it should.

### 2.2 Dollars, by route

Cache split used throughout: **85% cache read / 10% 5-minute cache write / 5% fresh input.**

| Route | Cache reads | Cache writes | Fresh input | Output | **$/ticket** |
|---|---:|---:|---:|---:|---:|
| **All Opus 5, no caching** | — | — | $237.50 | $62.50 | **$300.00** |
| **All Opus 5, 85% cache** | $20.19 | $29.69 | $11.88 | $62.50 | **$124.25** |
| **Heterogeneous (recommended)** — Opus 5 orchestrator + Sonnet 5 subagents, 85% cache | $10.37 | $15.25 | $6.10 | $33.25 | **$65** |
| Heterogeneous, **after 2026-09-01** Sonnet price rise | $13.64 | $20.06 | $8.03 | $43.00 | **$85** |
| All Sonnet 5 (intro), 85% cache — *capability floor, not recommended* | $8.08 | $11.88 | $4.75 | $25.00 | **$50** |

Heterogeneous split used: Opus 5 carries 9.0M input / 0.55M output (spec, plan, review, final gate, plus ~3.0M of delegation and merge supervision); Sonnet 5 carries the remaining 38.5M / 1.95M.

**Heterogeneous routing cuts the bill 48%** versus all-Opus ($124 → $65) while keeping Opus 5 on every decision that actually needs it: what "done" means, task decomposition, adversarial review, and the termination call.

### 2.3 The caching effect — the single biggest lever you control

| Cache hit rate | $/ticket (heterogeneous, intro rates) | vs 85% |
|---:|---:|---:|
| 0% (no `cache_control` at all) | **$155** | +138% |
| 50% (naive / churning prefix) | **$108** | +66% |
| **85% (target)** | **$65** | — |

Getting caching right is worth roughly **10x more than picking the cheapest reseller**, and more than the entire model-choice decision. Two structural reasons it also buys headroom:

- Cache reads cost **0.1x** base input, and a 5-minute cache write at 1.25x **pays for itself after a single read**.
- **Cache reads do not count toward ITPM rate limits** on Opus 5 or Sonnet 5. Anthropic's own worked example: *"With a 2,000,000 ITPM limit and an 80% cache hit rate, you could effectively process 10,000,000 total input tokens per minute."* Good caching buys throughput as well as money.

Prompt layout to hit 85% is in §5.4. The one thing that silently destroys it: **decrementing `task_budget.remaining` on every follow-up request invalidates the cache prefix that contains it** — set the budget once, and only pass `remaining` when you actually compact.

### 2.4 Monthly cost at real volume

Per-ticket figures include ~$1 of non-token cost (web search at $10/1,000 searches, sandbox/session runtime at $0.08/session-hour if on Managed Agents). "Budgeted" applies a **1.3x wastage factor** for tickets that do not converge on the first run, re-runs after `BLOCKED`, and abandoned starts.

| Tickets/mo | Modelled (intro rates) | **Budgeted (intro)** | Modelled (post-Sep-1) | **Budgeted (post-Sep-1)** |
|---:|---:|---:|---:|---:|
| 20 | $1,320 | **$1,720** | $1,720 | **$2,240** |
| 30 | $1,980 | **$2,580** | $2,580 | **$3,360** |
| 50 | $3,300 | **$4,300** | $4,300 | **$5,600** |

**Read this against the stated budget constraint honestly: this is not a cheap product to run.** Three levers, in order of size:

1. **Ticket volume is the budget knob, not model choice.** 20 tickets/month at ~$86 budgeted is a real, sustainable number. 50 is not, at this stage.
2. **The $500 Start-tier spend cap allows ~6 tickets in month one.** Request an increase before launch.
3. If the budget is hard-capped below ~$1,500/month, the correct response is **fewer tickets at full quality**, not the same tickets on a cheaper model. Opus 5 at `medium` (Elo 1470) is worse at long-horizon work than Fable 5 and Kimi K3 — degrading the orchestrator produces tickets that fail the gates in §4 and cost *more* through retries.

### 2.5 Confidence and what would break this

**Confidence: MEDIUM-LOW. Treat the per-ticket figure as ±2x, i.e. $35–$170.**

The three things most likely to make it wrong, in order:

1. **The 47.5M token figure is modelled, not measured.** It is anchored on one published benchmark (LH-Terminal-Bench, 9.8M tokens / 89 min) run on non-Anthropic models against benchmark tasks, not product builds. **Instrument one real ticket end-to-end before committing to any number here.** The Agent SDK's `ResultMessage` and Managed Agents' `span.model_request_end` both carry per-call `model_usage` — you get a real figure on run one.
2. **The 85% cache-hit rate is a target, not a measurement.** It is the highest-leverage assumption in the model and it moves the answer by 138% at the extreme. It is genuinely engineerable on Anthropic because you control `cache_control` breakpoints — but only if the prompt is laid out as §5.4 describes and nothing mutates the prefix.
3. **The 1.3x wastage factor is a guess.** The relevant published evidence is discouraging: LH-Terminal-Bench found a **6.4% mean pass rate** on ~89-minute autonomous tasks, with **79% of failures being timeout-driven incompletion.** And METR found **roughly half of test-passing SWE-bench Verified PRs would not be merged by maintainers** — merge rate averaged **~24 percentage points below** automated grader scores, with rejections for code quality, breaking unrelated code, and not actually solving the stated problem. Tests-green is close to a coin flip for merge-readiness. (Caveat: METR studied Claude 3.5/3.7 Sonnet, Claude 4 Opus, Claude 4.5 Sonnet and GPT-5 — one to two generations old, so the gap may have narrowed.) If your real convergence rate is 50% rather than the ~77% implied by 1.3x, double every monthly figure.

Also mispriced by omission if you are not careful: `speed: "fast"` (2x), `inference_geo: "us"` (1.1x), and the Managed Agents session-runtime charge of $0.08/session-hour, which is a **second billing dimension** on top of tokens and is explicitly excluded from the Batch discount. The Batch API's 50% discount is unavailable to you regardless — Anthropic states of agent sessions verbatim: *"Sessions are stateful and interactive. There is no batch mode."*

---

## 3. Orchestrator + Specialist Subagent Design

### 3.1 The governing principle: single writer, many advisors

Cognition published "Don't Build Multi-Agents" in June 2025, then revised it in April 2026 with "Multi-Agents: What's Actually Working." The revision does **not** reinstate a swarm. It establishes: **"Multiple agents contribute intelligence to a task while writes stay single-threaded."** Anthropic's January 2026 guidance lands independently in the same place — decompose by **context boundary, not by problem type**, at a cost of **3–10x tokens** — and explicitly lists *"most coding tasks (fewer parallelizable components than research)"* as a poor fit for multi-agent.

So: this architecture is multi-agent for **two** reasons only, and neither is "more agents are smarter."

1. **Cost routing.** Opus 5 on decisions, Sonnet 5 on mechanical work. This is the 48% saving in §2.2.
2. **Context isolation.** The Adversarial Reviewer must not see the Builder's reasoning; the Test Author must not see the implementation. Independence is the mechanism, and it cannot be achieved inside one context window.

Everything else is done by the orchestrator or by one writer at a time.

**Keep the roster exactly one level deep.** Managed Agents enforces this anyway (*"The coordinator can only delegate to one level of agents"*, max 20 agents, max 25 concurrent threads, all sharing one sandbox and filesystem), and designing to that limit keeps the system portable between the self-hosted Agent SDK and Managed Agents without a rewrite.

### 3.2 The roster

| # | Agent | Model / effort | Writes | Owns | Context it receives | Returns |
|---|---|---|---|---|---|---|
| 0 | **Orchestrator** | Opus 5 / `high` | `PLAN.md`, `STATE.json` only | ticket state machine, task graph, merges, gate evaluation, **the termination decision** | constitution, frozen `SPEC.md`, `PLAN.md`, `STATE.json`, last N subagent digests | dispatch decisions, terminal state |
| 1 | **Spec Architect** | Opus 5 / `xhigh` | `SPEC.md`, `contracts/` (once, then frozen) | acceptance criteria in EARS notation with stable REQ-IDs; interface contracts | ticket text, clarifying Q&A, stack constraints | `SPEC.md` + open questions |
| 2 | **Test Author** | Opus 5 / `high` | `tests/acceptance/**` only | one executable test per REQ-ID, plus a held-out set | **`SPEC.md` + `contracts/` ONLY — never the implementation** | test files + REQ-ID→test map |
| 3 | **Builder-backend** | Sonnet 5 / `medium` | `src/server/**` | implementation of its slice | its `SPEC.md` slice, its task, **the affected-test list**, `contracts/`, target file contents | diff + run log pointer |
| 4 | **Builder-frontend** | Sonnet 5 / `medium` | `src/app/**` | implementation of its slice | same, frontend slice | diff + run log pointer |
| 5 | **Debugger** | Sonnet 5 / `high`, escalating to Opus 5 / `high` | `src/**` under a single-writer lease | failing-gate triage and repair | failing test stdout, affected files, affected-test list, last 2 attempt diffs | diff + root-cause note |
| 6 | **Adversarial Reviewer** | Opus 5 / `xhigh` | **nothing — read-only** | finding spec violations, stubs, reward-hacks | frozen `SPEC.md`, final diff, CI evidence bundle. **Explicitly NOT the builders' reasoning or conversation history** | findings with severity |
| 7 | **E2E / Integration** | Sonnet 5 / `medium` | `e2e/**` only | Playwright flows, axe-core a11y report | `SPEC.md` acceptance flows, running app URL | test results + artifacts |

Eight agents, one level, well inside every platform limit. Concurrency policy: **at most one writer active at a time**, plus up to three read-only agents in parallel.

### 3.3 Parallelism without concurrent writes

Two sanctioned forms, both from the Cognition revision:

- **Map-reduce-and-manage.** Builder-backend and Builder-frontend may run concurrently **only** when `STATE.json` carries a `file_ownership` manifest with **disjoint** globs, and `contracts/` (shared types, API schema) is frozen and owned by neither. This is exactly the Flappy-Bird failure case Cognition documented — two agents independently inventing a visual style — and a frozen contract directory is the fix.
- **Code-Review-Loop.** The Adversarial Reviewer runs with **no shared prior context**, which is why it works: Cognition reports an average of **2 bugs found per PR, 58% of them severe**, attributed to the reviewer's clean, short context and its reasoning backward from the implementation.

Plus one escalation form:

- **Smart Friend.** When the Debugger fails the same gate twice, escalate the *same task* to Opus 5 `high` rather than re-planning. Cognition's caveat applies: this only works when both models are capable, because *"dumber models lack calibration to recognize when they've reached their limits."* Sonnet 5 clears that bar; Haiku 4.5 would not.

### 3.4 How results are merged

Subagents **write full artifacts to disk and return a pointer plus a ≤10-line digest.** They never return prose the orchestrator has to reconstitute. This is Anthropic's own finding from their multi-agent research system: subagents *"output to filesystem rather than routing everything through the lead agent,"* explicitly to avoid a game of telephone.

Merge protocol per completed task:
1. Subagent writes `.agent/reports/<task-id>.md` (full detail) and returns `{task_id, status, files_touched, digest, next_blockers}`.
2. Orchestrator runs the **deterministic gates** (§4.2) — it does not take the subagent's word for anything.
3. Orchestrator updates `STATE.json` (`req_status`, `gates`, `file_ownership`) and commits.
4. Only the digest enters the orchestrator's context. The full report is on disk, addressable by path if a later phase needs it.

### 3.5 Where a subagent is the WRONG call

Say it plainly, because the default failure of this architecture is over-delegation:

| Situation | Why delegation is wrong | Do this instead |
|---|---|---|
| Deciding the stack, the task order, or what "done" means | Requires the whole plan in head; a subagent with a partial view will make a locally sensible, globally wrong call | Orchestrator does it |
| Any edit under ~3 files / ~200 LOC | Delegation overhead is **~40–80k tokens** (fresh context load, spec re-read, contract read, digest write-back). Below that threshold you pay more to delegate than to do | Current writer does it inline |
| Splitting sequential phases of the same work (model → controller → route) | Anthropic's explicit warning: *"avoid splitting sequential phases of the same work or tightly coupled components"* | One Builder, one slice, sequentially |
| Anything sharing types with work in flight | Contract drift; two agents will diverge on the same interface | Freeze `contracts/` first, then delegate |
| A "read-only researcher" subagent that reads files and reports back | Cognition: readonly-only subagents *"resemble tool calls rather than true collaboration."* It is a tool call wearing a costume, and you pay a fresh-context tax for it | Use a tool (grep/glob/read) |
| Anything where you would have to send the subagent the same context the parent already has | You have gained isolation you did not need and paid 3–10x for it | Parent does it |

**The single genuine exception to "orchestrator does the thinking":** the Adversarial Reviewer and the Test Author must be separate agents *precisely because* they must not have the parent's context. Their isolation is the product, not a side effect.

### 3.6 Where context fragmentation bites, and the mitigation

| Fragmentation risk | Symptom | Mitigation |
|---|---|---|
| Divergent shared types / API shape | frontend and backend disagree on a schema | `contracts/` written only by Spec Architect, frozen, read-only to Builders (PreToolUse deny) |
| Divergent style / conventions | inconsistent naming, mixed patterns | `constitution.md` (Spec Kit pattern) re-read at the start of **every** subagent invocation, and after every compaction |
| Duplicate implementations | the same helper written twice under different names | Ralph's documented failure mode. Mandatory grep/index check plus the `file_ownership` manifest before any file creation |
| Lossy digests | orchestrator loses a detail it needed three phases later | Full artifact on disk; digest is a pointer, never the record |
| Orchestrator context bloat from merged results | quality decay past ~150k tokens | Digests capped at 10 lines; server-side compaction at 150k; mechanical re-read (§5.3) |

---

## 4. Verifiable Completion — The Termination Contract

**The core rule: an agent cannot know it is finished unless "finished" is machine-checkable, and self-assessment plus a visible scoring function is actively dangerous.** METR measured reward hacking **more than 43x more common** when the model could see the entire scoring function. ImpossibleBench measured GPT-5 exploiting test cases **76%** of the time on impossible SWE-bench variants, with **Claude-family models cheating primarily by editing the test files directly — over 79% of their cheats.**

### 4.1 The acceptance-criteria artifact, produced before any code

`SPEC.md`, authored by the Spec Architect and **frozen before the first line of implementation.**

Format follows AWS Kiro's spec structure, which is the cleanest machine-checkable template available:

- **`SPEC.md`** — requirements in **EARS notation** with stable IDs: `REQ-014: WHEN a user submits a scorecard with a hole count other than 9 or 18 THE SYSTEM SHALL reject it with a 422 and a field-level error.`
- **`contracts/`** — interface definitions, API schema, shared types.
- **`PLAN.md`** — task graph, each task tagged with the REQ-IDs it satisfies.

Every REQ-ID must map to at least one executable test. Requirements that cannot be expressed as an EARS statement testable by a machine go into an `ADVISORY` section and **are excluded from the termination contract** — they are reported, not gated.

**Freeze mechanism, three layers:**
1. `sha256` of `SPEC.md`, `contracts/`, `tests/acceptance/**` and the CI script recorded in `STATE.json` at freeze time.
2. A `PreToolUse` hook returns `permissionDecision: "deny"` for any `Write`/`Edit` touching those paths. Anthropic documents that **deny beats every other decision** (`deny > defer > ask > allow`) and that hooks **fire inside subagents**, which do not inherit parent permissions — so this is the one enforcement layer that actually holds across a delegating orchestrator.
3. **Out-of-process re-verification** of all four hashes by the orchestrator after every phase. Layer 2 runs inside the harness; layer 3 does not trust the harness.

### 4.2 The gates — deterministic first, model-graded last

All must be green. The order matters: never let a model grade something a compiler can decide.

| Gate | Check | Tool | On red |
|---|---|---|---|
| **G0** | Spec + contracts + test + CI-script hashes unchanged | orchestrator, out-of-process | **Hard abort. Flag tampering. Do not retry.** |
| **G1** | Typecheck clean | `tsc --noEmit` | → Debugger |
| **G2** | Lint: 0 errors | eslint | → Debugger |
| **G3** | Production build succeeds | framework build | → Debugger |
| **G4** | Unit + integration tests pass | vitest/jest | → Debugger |
| **G5** | **Every REQ-ID has ≥1 passing acceptance test**, run from a clean checkout of the frozen tests, in randomised order, in a fresh process | tagged test run | → Debugger |
| **G6** | Held-out acceptance tests pass (never in any agent's context) | orchestrator-only run | → Debugger; **repeated failure here is a cheating signal, not a bug signal** |
| **G7** | E2E happy paths + the 3 named edge cases per flow | Playwright | → Debugger |
| **G8** | axe-core: **0 critical/serious** violations | `@axe-core/playwright` | → Debugger. Lower severities are **reported, not gated** |
| **G9** | No stub markers in `src/`: `TODO`, `FIXME`, `NotImplemented`, `not implemented`, empty function bodies on exported symbols | grep | → Debugger |
| **G10** | Adversarial review: 0 open findings at severity ≥ high | Reviewer agent | → Debugger |
| **G11** | Outcome grader returns `satisfied` against the frozen rubric | Outcomes / own grader | → revise |

**On G8, be honest about what it buys.** Playwright's own documentation states verbatim: *"Automated accessibility tests can detect some common accessibility problems… But many accessibility problems can only be discovered through manual testing,"* and deliberately publishes **no coverage percentage**. Circulating third-party figures (30–40%, ~50%) conflict and are all secondary. A green axe run does not mean accessible. Gate narrowly on critical/serious or you will block convergence on cosmetic findings.

### 4.3 The grader/critic loop

Use Anthropic Managed Agents **Outcomes** if you are on that platform (`user.define_outcome`, requires beta header `managed-agents-2026-04-01`); otherwise implement the identical shape yourself with a fresh-context grader.

| Property | Value |
|---|---|
| API shape | `{"type":"user.define_outcome","description":"…","rubric":{…},"max_iterations":5}` |
| `max_iterations` | default **3**, max **20**. Use **3.** |
| Terminal results | `satisfied` \| `needs_revision` \| `max_iterations_reached` \| `failed` \| `interrupted` |
| Concurrency | **one active outcome at a time**; chain them in sequence |
| Isolation | grader runs in a separate context window and does not see the agent's reasoning chain |

**Position it last, and never alone.** Anthropic's own published lift for Outcomes is modest — *"task success by up to 10 points"*, +8.4% on docx, +10.1% on pptx. That is a real but single-digit improvement on document tasks. It is the final gate over deterministic CI, not a substitute for it.

**The grader's default failure mode is rubber-stamping** — Anthropic's own cookbook says so. The rubric must force evidence, not opinion:

- Bad: *"Check that scorecard validation works."*
- Good: *"For each REQ-ID in SPEC.md, paste the verbatim test name and the verbatim pass/fail line from the CI output. Mark UNVERIFIED any REQ-ID for which you cannot produce both. Approve only if zero rows are UNVERIFIED."*
- Plus: tell it what to **ignore** (style nits, pre-existing issues) and require a fixed output format (one-line scorecard + one bullet per failure).

> **`[uncertain]` — resolve this before you rely on the grader.** It is **not documented** whether the Outcomes grader can execute commands (`tsc`, `npm test`, `playwright test`) or only read artifacts. This single fact decides whether Outcomes can gate a codebase alone. **Assume the conservative case: the grader only reads.** Run deterministic CI yourself and hand the grader an evidence bundle. Resolve with a 20-minute experiment — define an outcome whose rubric demands *"paste the verbatim stdout of `npm test`"* and check whether `span.outcome_evaluation_end.explanation` contains real output.

### 4.4 The adversarial pass

Independence must be **structural**, not instructed:

- A separate agent instance on a separate session thread.
- **No shared conversation history** with any Builder or the Orchestrator.
- Input is exactly: frozen `SPEC.md`, the final diff, and the CI evidence bundle. **Not** the builders' reasoning, not their commit messages' justifications.
- Read-only: PreToolUse denies every write tool for this agent.
- Its brief includes explicit reward-hack hunting (§4.5), not just "find bugs."

Measured support: Cognition's Code-Review-Loop catches ~2 bugs/PR, 58% severe. TDFlow's decomposed workflow — which includes a **separate** test-generation sub-agent — reached **94.3% on SWE-Bench Verified with only 7 test-hacking instances across 800 runs**, and identified reproduction-test generation, not patch writing, as the real bottleneck (spend budget on the Test Author accordingly). `[uncertain]` There is **no published effect size** for adversarial red-team agents on generated full-stack applications — everything available is blogs and vendor content. Do not claim a number.

### 4.5 Reward-hacking failure modes and the defence for each

| Failure mode | Evidence | Defence |
|---|---|---|
| **Editing the acceptance tests to pass** | ImpossibleBench: Claude-family models used direct test-file modification for **>79% of their cheats** | G0 hash check out-of-process + PreToolUse `deny` on `tests/acceptance/**`; run G5 from a clean checkout of the frozen tests |
| **Overloading comparison operators** — wrapper classes whose `__eq__`/`valueOf` always return the expected value | ImpossibleBench taxonomy | Reviewer greps for custom equality/coercion on assertion paths; run tests in a fresh process from clean checkout |
| **Special-casing / hardcoding expected values** | ImpossibleBench taxonomy | **G6 held-out tests.** Test Author writes N+M acceptance tests; M are withheld from every agent's context and run only by the orchestrator at G6 |
| **Recording extra state** — call counters returning different results for identical inputs | ImpossibleBench taxonomy | Randomised test order + fresh process per G5/G6 run |
| **Stubs and placeholders shipped as done** | Ralph's documented failure mode #2 | G9 grep gate + Reviewer explicitly tasked to hunt stubs |
| **False finish** — stopping early while claiming completion | LH-Terminal-Bench: **79% of failures were timeout-driven incompletion**; "weak self-verification / false finishes" is a *separately* documented mode, with high-reward early exits averaging only 0.22–0.51 reward | Orchestrator owns ticket status **out-of-process** and re-runs all gates. `Stop` hooks are a nudge, not an authority — Anthropic documents that `stop_hook_active` forces them to give up after one block, and that **hooks may not fire at all when the agent hits `max_turns`** |
| **Seeing the whole scoring function** | METR: reward hacking **>43x more common** when the full scorer was visible | Rubric, CI script and held-out tests all outside the agent's context and non-writable |
| **Fabricating done-ness because there is no legal way out** | ImpossibleBench: an explicit abort option cut GPT-5 cheating **54% → 9%**, o3 **49% → 12%** | **A sanctioned `BLOCKED` terminal state is a cheating countermeasure, not a courtesy.** Make "I cannot finish this, here is why" a first-class, rewarded outcome |
| **More attempts → more cheating** | ImpossibleBench: allowing multiple submissions raised cheating **33% → 38%** | Hard iteration caps (§4.6). Do not let it grind |
| **Weak prompting** | ImpossibleBench: strict vs loose prompt cut GPT-5 cheating **92% → 1%** | Strict, explicit anti-cheat language in every Builder and Debugger system prompt |
| **"Do TDD" as an instruction** | TDAD: procedural TDD prompting *without* a targeted test list **raised** regressions to 9.94% vs a 6.08% baseline — **worse than no intervention** | Never lecture about TDD. Ship the Builder a concrete **affected-test list** derived from impact analysis. TDAD's targeted version cut regressions 6.08% → 1.82% |

**One design rule that ties these together: read-only test access, not hidden tests.** ImpossibleBench found hiding tests entirely gave near-zero cheating but **degraded legitimate performance**; read-only access *"provides a middle ground,"* restoring performance while preventing modification, and is *"particularly effective against models whose primary strategy involves test file changes"* — which is exactly the Claude family. So: Builders **read** the acceptance tests, cannot write them, and never see the held-out set.

### 4.6 Iteration caps and escalation

| Cap | Value | Enforced by |
|---|---|---|
| Attempts per gate | **3** | orchestrator |
| Total fix cycles per ticket | **8** | orchestrator |
| Token budget per ticket | `task_budget.total` on the orchestrator (Opus 5 supports it; Sonnet 5 does not) | Anthropic API, advisory |
| **Hard dollar ceiling per ticket** | e.g. $150 | **dashboard, out-of-process, with a kill switch** |
| Wall-clock ceiling | e.g. 8h | dashboard |

> **Three `task_budget` traps.** (1) It is **advisory, not enforced** — *"Claude may occasionally exceed the budget if it is in the middle of an action."* `max_tokens` is the only hard cap in-band. (2) An **undersized** budget is actively harmful: *"When Claude sees a budget that is clearly insufficient… it may decline to attempt the task at all, scope it down aggressively, or stop early with a partial result."* Measure p99 spend without a budget first, then set it. (3) Do **not** decrement `remaining` on every follow-up while resending full history — you get premature wrap-up *and* a destroyed cache prefix from one line of code.

**Escalation ladder:**

1. Gate red, attempt 1–2 → Debugger (Sonnet 5 `high`) on the same task.
2. Gate red, attempt 3 → **Smart Friend**: escalate the same task to Opus 5 `high`, fresh context, given the last two attempt diffs and the failing output.
3. Still red → Orchestrator **re-plans that slice** with fresh context. Counts as 1 fix cycle.
4. 8 cycles used, or 70% of the token budget consumed with any gate red, or the dollar ceiling hit → **terminal state `BLOCKED`**.

**Terminal states — the orchestrator emits exactly one:**

| State | Meaning | Payload |
|---|---|---|
| `COMPLETE` | **All gates G0–G11 green.** No other path to this state. | run report, coverage map, cost ledger |
| `PARTIAL` | A named subset of REQ-IDs is green and gated; the rest are explicitly listed as not done | per-REQ-ID status table |
| `BLOCKED` | Cannot converge. **This is a success of the contract, not a failure of the run.** | failing REQ-IDs, last 3 attempt diffs, failing test stdout, and **one specific question for the human** |
| `BUDGET_EXHAUSTED` | Ceiling hit before convergence | same as `BLOCKED` + spend ledger |
| `FAILED` | G0 tampering, or infrastructure failure | forensic bundle |

---

## 5. Context & State Across a Multi-Hour Run

### 5.1 The governing rule

**The context window is a cache. It is never the source of truth.** Every harness that survives multi-hour runs does the same thing: move authoritative mission state onto disk and re-read it mechanically after every reset. Ralph keeps 100% of state in `PROMPT.md`, `fix_plan.md`, `specs/` and git, and throws the window away every iteration. OpenHands keeps an append-only `EventLog` plus `base_state.json` and records **compaction itself as a replayable `CondensationEvent`** so a truncated history reconstructs deterministically. Anthropic's own guidance is structured note-taking persisted outside the window, and its Pokemon example is the existence proof that an agent can cross full context resets without losing the mission.

No context-window size fixes drift. Chroma measured degradation across 18 models driven by needle-question similarity and distractors, and found — counterintuitively — that **logically coherent haystacks degrade attention *more* than shuffled ones.** A 1M-token window does not save you.

### 5.2 What lives where

| Layer | Contents | Written by | Authoritative? |
|---|---|---|---|
| **Orchestrator context window** | system prompt, `constitution.md`, full `SPEC.md`, current `PLAN.md` slice, `STATE.json` digest, last N subagent digests (≤10 lines each) | — | **No** |
| **Subagent context window** | system prompt, `constitution.md`, its `SPEC.md` slice, its task, affected-test list, `contracts/`, target file contents | — | **No** |
| **Repo / disk** | `SPEC.md` (frozen + hashed), `contracts/`, `PLAN.md`, `STATE.json`, `tests/`, `src/`, `.agent/reports/*.md`, `.agent/journal.md` | orchestrator + the one owning agent | **Yes** |
| **Git** | one commit per green gate; one branch per ticket; tag per phase boundary | orchestrator | **Yes — rollback target** |
| **Database (dashboard)** | ticket row, run row, phase events, per-call token/$ ledger, gate results, terminal state, `session_id`, sandbox snapshot id, spec hash | orchestrator, **out-of-process** | **Yes — resume contract** |

`STATE.json`, the resume contract:

```json
{
  "ticket_id": "tkt_01H…",
  "spec_sha256": "9f2c…",
  "contracts_sha256": "b30d…",
  "tests_sha256": "4a81…",
  "ci_script_sha256": "77e5…",
  "phase": "fix",
  "current_slice": "REQ-014..REQ-019",
  "gates": { "G1": "green", "G4": "green", "G5": "red", "G6": "not_run" },
  "req_status": { "REQ-001": "green", "REQ-014": "red" },
  "file_ownership": { "src/server/**": "builder-backend", "src/app/**": "builder-frontend" },
  "fix_cycles_used": 3,
  "gate_attempts": { "G5": 2 },
  "tokens_spent": 31200000,
  "usd_spent": 41.80,
  "usd_ceiling": 150.00,
  "last_checkpoint_commit": "abc1234",
  "open_questions": [],
  "terminal_state": null
}
```

### 5.3 Compaction policy and the mechanical re-read

Use the server-side compaction beta (`anthropic-beta: compact-2026-01-12`), `trigger: {type: "input_tokens", value: 150000}` (minimum 50,000). Note the cost accounting trap: **compaction costs tokens that are NOT in the top-level `input_tokens`/`output_tokens`** — you must sum `usage.iterations` or your ledger will under-report.

**Immediately after any compaction, the orchestrator performs a mechanical re-read, in this fixed order, before any other action:**

1. `constitution.md`
2. `SPEC.md` (full, verbatim — plus a hash check)
3. `STATE.json`
4. current `PLAN.md` slice
5. last gate result

This is a mechanical file read, not "remember what we were doing." **Nothing that appears in `SPEC.md` or `STATE.json` is ever trusted from a compaction summary.** The summary is allowed to carry only ephemera — what a specific file looked like, why an approach was abandoned.

**Subagents never compact.** If a subagent reaches ~60% of its window, it writes its report to `.agent/reports/` and terminates; the orchestrator spawns a fresh one with a handoff prompt. This follows Amp, which removed compaction outright on the grounds that it is lossy and *"encourages long, meandering threads, in which you just compact once you run out of context window, stacking summary on top of summary."* Fresh context beats stacked summaries.

`[uncertain]` Claude Code's CLI auto-compaction threshold (~167k / 83.5%, with a ~33k buffer) is documented only by third parties and has shifted across releases. **Do not build a controller that assumes a fixed CLI threshold.** The API-side 150,000 default is the only officially documented figure.

### 5.4 Prompt layout for the 85% cache-hit target

Order the prompt **immutable-prefix-first**, because caching is prefix-based:

| Position | Content | Mutability during a run | `cache_control` |
|---|---|---|---|
| 1 | System prompt (role, strict anti-cheat instructions) | immutable | — |
| 2 | `constitution.md` | immutable | — |
| 3 | Frozen `SPEC.md` + `contracts/` | immutable | **1-hour breakpoint here** |
| 4 | `PLAN.md` slice + `STATE.json` digest | changes per phase | 5-minute breakpoint |
| 5 | Rolling conversation tail, tool results | volatile | — |

The **1-hour TTL on the immutable prefix (2x write cost) is correct despite the premium**, because a long build or test run creates gaps well over five minutes and a 5-minute TTL would force a full re-write each time. Anthropic's own guidance: 1-hour caching pays off after two reads. The 5-minute breakpoint on the semi-stable block pays off after one.

**Cache-invalidation hazards to enforce in code:**
- **Never change `effort` mid-conversation** — it does not preserve cached prefixes. Pin one effort per agent role for the whole run.
- **Never decrement `task_budget.remaining` on every turn** — the changed value invalidates any prefix containing it. Set once; pass `remaining` only on an actual compaction.
- Never insert anything mutable above position 4.

### 5.5 Resume after interruption

**Checkpoint at every phase boundary and every gate result**, atomically: git commit → `STATE.json` write → DB row → sandbox snapshot.

**On resume, restart from the last checkpoint with a FRESH context. Do not resume the transcript.** This is Anthropic's own recommendation for the Agent SDK, verbatim: *"Don't rely on session resume. Capture the results you need (analysis output, decisions, file diffs) as application state and pass them into a fresh session's prompt. This is often more robust than shipping transcript files around."*

Two facts that make transcript-resume a trap:

- **Sessions persist the conversation, not the filesystem.** Agent SDK sessions are JSONL under `~/.claude/projects/<encoded-cwd>/`, and Anthropic warns explicitly: *"To snapshot and revert file changes the agent made, use file checkpointing."* Conversation and filesystem must be checkpointed as two separate things.
- Session resume is **keyed by working directory** — *"If a `resume` call returns a fresh session instead of the expected history, the most common cause is a mismatched `cwd`."* A container that comes back on a different host or path silently loses the session.

Resume sequence:

1. Read the ticket + run row from the DB. Recover `last_checkpoint_commit`, `phase`, `gates`, `fix_cycles_used`, `usd_spent`.
2. `git checkout` the checkpoint commit; restore the sandbox snapshot.
3. **Re-verify all four hashes (G0).** If any differ, terminal `FAILED` with a forensic bundle — the interruption may have masked tampering.
4. **Re-run the deterministic gates from G1.** Never trust a recorded gate result across a restart; they are cheap.
5. Spawn a fresh orchestrator context, seeded by the §5.3 mechanical re-read plus a one-paragraph "where we were" derived from `STATE.json` — **not** from a saved transcript.
6. Resume dispatch. `fix_cycles_used` and `usd_spent` carry forward, so an interruption cannot be used to reset the iteration cap.

`[uncertain]` **Managed Agents caveat if you go that route.** It is *"not currently eligible for Zero Data Retention or HIPAA Business Associate Agreement coverage"* because sessions are stateful by design and store conversation history, sandbox state and outputs server-side. No maximum session lifetime is documented on any of the four primary pages — billing accruing only during `running` status *implies* no wall-clock cap, but that is inference, not documentation. Confirm with Anthropic before designing around unbounded sessions.

---

*Deliverable also persisted at `/private/tmp/claude-501/-Users-kamilborzecki-Projects-coding-agent/809fd866-9e5e-4bf9-8f1e-3f3d4a9e6de1/scratchpad/model-agent-architecture.md`. Note: the `advisor` tool returned "temporarily overloaded" on both attempts (pre-draft and pre-finalisation), so this section has had a self-verification pass on arithmetic and citations but no external review.*

---

# Platform & Delivery

> **Reading note.** Every dollar figure and platform limit below traces to a primary source verified on 2026-07-27. Figures I modelled rather than read off a page are marked **[modelled]** with the assumptions stated. Figures I could not verify in this pass are marked **[verify]** — check them before they land in a budget.

---

## 1. Recommended stack

### 1.1 The one decision that determines the other nine

**Claude Managed Agents (public beta, header `managed-agents-2026-04-01`) collapses four layers into one.** It ships the agent loop, a per-session hosted sandbox, a multiagent coordinator, MCP server wiring, skills, a per-end-user credential vault, SSE event streaming, mid-run steering, and cron deployments — for **$0.08 per session-hour** on top of standard token rates, metered to the millisecond and only while session status is `running` ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), [overview](https://platform.claude.com/docs/en/managed-agents/overview)).

A 3-hour ticket costs **$0.24** in runtime — against $0.50 on Daytona, $0.82 on Vercel Sandbox, $1.14 on Modal — **and it includes the harness**. Take it. The self-hosted Agent SDK path is your escape hatch, not your v1.

Its three disqualifying conditions, all verified:

| Condition | Consequence |
|---|---|
| Not eligible for Zero Data Retention or a HIPAA BAA — "stateful by design" | Cannot serve tenants with a data-residency or PHI requirement |
| Coordinator delegates **one level only**; max **20 unique agents** per roster; max **25 concurrent threads**; all agents share one sandbox and filesystem | No nested subagent trees. Design flat. |
| Public beta; **max session duration is not documented** on any of the four primary pages | Do not architect around unbounded sessions until Anthropic confirms |

### 1.2 Stack table

| Layer | Recommendation | Runner-up | Switch condition | $/mo at 20–50 tickets |
|---|---|---|---|---|
| **Dashboard / frontend** | Next.js App Router on **Vercel Pro** | React Router on Cloudflare Pages | You need an EU-only region, or you're avoiding Vercel lock-in | **$20** (Hobby is likely non-commercial — **[verify]**) |
| **API** | Next.js Route Handlers, same deployment | Separate Hono service on Fly.io | You need long-lived server-held SSE beyond function limits, or a non-JS runtime | **$0** (inside Vercel Pro) |
| **Database** | **Supabase Postgres** (Pro) | Neon + Better Auth | You don't want auth/storage/realtime bundled | **$25** **[verify]** |
| **Auth** | **Supabase Auth** (bundled, RLS-native) | Clerk | You need orgs/SSO/SCIM in the first 3 months | **$0** |
| **Durable execution** | **Trigger.dev** (Hobby) | Cloudflare Workflows | A single ticket must live >14 days (Cloud TTL), or you must self-host | **$10** |
| **Sandboxed execution (build)** | **Claude Managed Agents** cloud sandbox | Agent SDK + **Vercel Sandbox** (Firecracker, 24 h max on Pro) | You need ZDR/HIPAA, non-Anthropic models, or hit an undocumented session cap | **$7–24** |
| **Sandboxed execution (verify)** | **Trigger.dev task, custom image**, `medium-1x` (1 vCPU / 2 GB, $0.0000850/s) — the clean-room gate | Vercel Sandbox | You need GPU or >2 GB for E2E | **$2–4**, drawn from Hobby's $10 credit |
| **Artifact storage** | **GitHub repo** (the deliverable) + **Supabase Storage** (logs, traces, screenshots, coverage) | Cloudflare R2 (zero egress) | Artifact egress becomes material | **$0–3** |
| **Realtime → browser** | **Trigger.dev Realtime** (`useRealtimeRun`, `useRealtimeStream`) relaying the Managed Agents SSE stream | Supabase Realtime on an append-only `run_events` table | You leave Trigger.dev | **$0** (included) |
| **Observability / tracing** | Append-only `run_events` table in Postgres, fed from Managed Agents span events + Trigger.dev run dashboard | Langfuse (self-host) or OTel → Grafana Cloud free tier | You need cross-version eval comparison (Phase 6) | **$0** |
| **Deployment target** | Vercel (UI+API) + Trigger.dev Cloud (supervisor) + Anthropic (agents) | Everything on Fly.io | Cost or region forces consolidation | **$0** |
| | | | **INFRA SUBTOTAL** | **$62–82** |

**Why Trigger.dev wins durable execution.** Its `maxDuration` counts **CPU time only** — time spent in `wait.for`, `triggerAndWait`, `batchTriggerAndWait` is checkpointed and free ([docs](https://trigger.dev/docs/runs/max-duration)). A supervisor that spends 3 hours waiting on an Anthropic session costs near zero. Compare: Inngest caps any single step at **2 hours**; Cloudflare Workflows allow unlimited wall time but **30 s CPU per step (5 min max)**. Both force you to decompose the wait, which Trigger.dev does not. Hard limit to know: Trigger.dev Cloud enforces a **14-day TTL on all runs**, and Hobby retains logs for **7 days** (Pro, $50/mo, gives 30).

**Why the two-sandbox split.** The Managed Agents sandbox is where the agent *builds*. Your out-of-process verification gate (§2) runs in a **second, clean sandbox** you control — a fresh `git clone` of the pushed branch with the frozen acceptance tests restored from your own database. Never verify inside the environment that produced the work.

### 1.3 The number that actually matters

**[modelled]** Assumptions, stated so you can re-run them:

- **52 M tokens per ticket.** Derived: Long-Horizon-Terminal-Bench measured **9.8 M tokens per ~89-minute task**; scale ~4× for a 3-hour build with parallel subagents (39.2 M); then **×1.3 for the tokenizer**. That last step is not optional — LHTB tested GPT-5.x, Grok, DeepSeek, Gemini, Qwen/Kimi/GLM/MiniMax/Doubao, **all on the old tokenizer**, while Claude 4.7-and-later models (Opus 5, Sonnet 5) "produce approximately 30 % more tokens for the same text." Anchoring on the raw 9.8 M understates your bill by 30 %.
- 95 % input / 5 % output; input split 85 % cache reads / 10 % 5-min cache writes / 5 % fresh.
- 30 % of tokens through Opus 5 (orchestrator + reviewer), 70 % through Sonnet 5 (workers).

| | Opus 5 only | Sonnet 5 only | **Recommended 30/70 mix** |
|---|---|---|---|
| Clean pass, today | $129.23 | $51.69 | **$74.95** |
| Clean pass, from 2026-09-01 | $129.23 | $77.54 | **$93.05** |
| **Effective @ 1.5× retry factor, today** | $194 | $78 | **$112** |
| **Effective @ 1.5× retry, from Sep 1** | $194 | $116 | **$140** |

The 1.5× retry factor is generous. Long-Horizon-Terminal-Bench measured a **6.4 % mean pass rate** on ~89-minute autonomous terminal tasks across 17 frontier models, with the best (Grok 4.5) at 28.3 %; **79 % of failures were timeouts**, not crashes. Your effective multiplier may be 2–3× until the harness is tuned.

| | 20 tickets/mo | 50 tickets/mo |
|---|---|---|
| Model tokens (effective, today) | **$2,240** | **$5,600** |
| Model tokens (effective, from Sep 1) | **$2,790** | **$6,980** |
| Infrastructure | $62–82 | $62–82 |
| **TOTAL, today** | **~$2,310** | **~$5,680** |
| **TOTAL, from 2026-09-01** | **~$2,860** | **~$7,060** |

**Infrastructure is 1–3 % of total spend. Stop optimising it.** Two levers are worth 10–50× more than any provider switch:

1. **Prompt caching.** A cache hit costs 0.1× base input. On the modelled ticket, moving from no caching to an 85 % hit rate takes Opus 5 from **$312 → $129** — a 58.6 % cut. Cache reads also **do not count toward ITPM rate limits** on any model except Haiku 3.5.
2. **The `effort` parameter.** On Artificial Analysis' AA-Briefcase long-horizon agentic eval, Claude Opus 5 spans Elo **1720 (max) / 1693 (xhigh) / 1606 (high, the API default) / 1470 (medium)** — a ~250-point spread from effort alone, which dwarfs any model swap. But it is **not monotonic**: GPT-5.6 Sol scores *higher* at xhigh (89.5 %) than at max (88.0 %). Anthropic's own guidance for Opus 5 is "**start with `high`, the default**" and to "run a fresh effort sweep on your evals rather than reusing them" from earlier models. Budget a per-role effort sweep as a Phase 1 build task.

### 1.4 The billing constraint that will bite first

This is **not** price — it is Anthropic's **monthly organisation spend cap**:

| Tier | Cap | Tickets covered @ $112 effective |
|---|---|---|
| Start (default for new orgs) | **$500/mo** | **~4** |
| Build | $1,000/mo | ~9 |
| Scale | $200,000/mo | ~1,780 |

"Once you reach your tier's spend cap, API usage pauses until the next month **unless you request a higher limit**." Tiers escalate automatically with usage history, and a self-service "Request rate limit increase" flow exists — but **no primary source states how fast progression is**. Request an increase before Phase 3.

Two traps:
- **Claude Platform on AWS orgs "are placed on the Start tier and do not move between usage tiers automatically"**, and the self-service increase flow **is not available** there. If you route AWS Activate credits (up to $200,000, "redeemable on third-party models on Amazon Bedrock") through Claude Platform on AWS, you inherit a permanently pinned $500 ceiling. Whether Activate credits even apply to Claude Platform on AWS (an Anthropic-operated Marketplace product, not a Bedrock third-party model) is **unverified and worth up to $200k** — confirm with AWS before planning around it.
- **Anthropic Priority Tier is closed to new purchase AND is not supported on Claude Opus 5 or Sonnet 5.** There is no guaranteed-capacity option for the models this product needs.

### 1.5 What was rejected, and why

| Rejected | Reason |
|---|---|
| **Any monthly subscription consumed via API key** (the owner's stated preference) | See §5.3. No provider lawfully offers this for a multi-tenant product. |
| E2B | Sessions >1 hour require the **$150/mo Pro plan** — 2× your entire infra budget for one layer |
| Modal Sandboxes | Billed at ~3× Modal's standard compute rate ($0.00003942/core/s); ~$1.14/ticket vs $0.24 on Managed Agents |
| Temporal Cloud | Support-tier minimum is "greater of $100/mo or 5 % of usage spend"; no free tier |
| Inngest | 2-hour hard cap per step |
| Amazon Bedrock as primary | Claude Opus 4.8 on Bedrock is exactly **1.2× Anthropic first-party** on every line ($6/$30 vs $5/$25). Only worth it if Activate credits are confirmed. |
| OpenRouter as primary gateway | 0 % inference markup is real, but credit purchases carry a **5.5 % Stripe fee ($0.80 min)**. Vercel AI Gateway is 0 % on both — use that if you want a gateway at all. You don't need one for an Anthropic-only v1. |
| Self-hosting open weights | 8×H100 ≈ $23.92/h ≈ **$17,222/mo**; break-even is ~547 tickets/month against GLM-5.2 API pricing |
| Claude Haiku 4.5 for subagents | Reliable knowledge cutoff **Feb 2025**, 200 k context, no `effort` parameter, no task-budget support. Sonnet 5 at `low` effort costs ~2× more and is strictly better equipped. |
| Batch API's 50 % discount for the main loop | Anthropic's own docs disqualify it: "Sessions are stateful and interactive. **There is no batch mode.**" Usable only for genuinely offline side-tasks. |
| `speed: "fast"` mode | $10/$50 per MTok on Opus 5 — **exactly 2× standard**. If any wrapper enables it, your cost model silently doubles. |

---

## 2. The ticket lifecycle

### 2.1 State machine

```
                                    ┌──────────────┐
DRAFT ──▶ CLARIFYING ──▶ SPEC_REVIEW ──▶ QUEUED ──▶ PLANNING ──▶ BUILDING
              │  ▲            │  ▲                                  │
              └──┘            └──┘                                  ▼
         (waitpoint,     (waitpoint,                          VERIFYING
          run suspended)  human edits spec)                         │
                                                                    ▼
                                                              REVIEWING
                                                                    │
                              ┌─────────────────────────────────────┤
                              ▼                                     ▼
                    ┌──── BUILDING (retry, ≤N)              GATE_PENDING
                    │         ▲                                     │
                    └─────────┘                    ┌────────────────┼────────────────┐
                                                   ▼                ▼                ▼
                                              DELIVERED         BLOCKED           FAILED
```

Terminal states: `DELIVERED`, `BLOCKED`, `FAILED`, `CANCELLED`. **`BLOCKED` is a first-class, sanctioned outcome, not an error** — see §2.6.

### 2.2 Walkthrough

| # | Transition | What happens | Where it lives |
|---|---|---|---|
| 1 | `DRAFT → CLARIFYING` | User submits prose in the dashboard. Insert `tickets` row; trigger the Trigger.dev supervisor task with the ticket ID as idempotency key. Return immediately; the browser subscribes to `useRealtimeRun`. | Vercel → Postgres → Trigger.dev |
| 2 | Intake pass | Supervisor opens a Managed Agents session with an **intake agent** (Sonnet 5, `effort: low`, read-only tools, no sandbox writes). It produces (a) ≤7 clarifying questions with proposed defaults, (b) a draft `spec/requirements.md` in **EARS notation** (`WHEN <condition> THE SYSTEM SHALL <behaviour>`) with stable IDs `REQ-001…`. Session goes `idle` — **billing stops**. | Managed Agents |
| 3 | **Pause for human** | Supervisor creates a Trigger.dev **waitpoint token** and persists it. `wait.for*` does not accrue CPU time, so the suspended run is effectively free. Dashboard renders the questions; the user answers or accepts defaults; the dashboard POSTs the token back; the run resumes with full state. **[verify the exact waitpoint API in your Trigger.dev version; if unavailable, fall back to a `wait.for` poll loop against a Postgres flag.]** Waitpoint has a TTL (48 h default): on expiry, either auto-apply the proposed defaults or move to `BLOCKED`. | Trigger.dev + Postgres |
| 4 | `CLARIFYING → SPEC_REVIEW` | Answers are folded into `spec/requirements.md`. An **acceptance-test generator agent** (Opus 5, `effort: high`) writes **two suites**, each test tagged with the `REQ-` ID it proves: (a) the **visible suite** → `acceptance/`, which the builder may read but not write; (b) a **held-out suite** stored only in your Postgres, never written to the build sandbox, covering the same `REQ-` IDs with different cases, boundaries and negative paths. Per TDFlow, *this step is the real bottleneck* — "the primary obstacle to human-level software engineering performance lies within writing successful reproduction tests." Spend your best model here, not on the implementation. | Managed Agents |
| 5 | Human approves spec | Second waitpoint. The user sees requirements + generated tests side by side and can edit either. This is your highest-leverage human checkpoint and it costs ~2 minutes. | Trigger.dev |
| 6 | **SPEC FREEZE** | On approval: SHA-256 every file under `spec/` and `acceptance/`, store the manifest in Postgres, and register a `PreToolUse` hook that returns `permissionDecision: "deny"` for any `Write`/`Edit`/`Bash` touching those paths. Deny **beats every other hook decision** and **fires inside subagents**. This is the single most important line of code in the product. | Postgres + hooks |
| 7 | `QUEUED → PLANNING` | Coordinator agent (Opus 5, `effort: high` — Anthropic's own Opus 5 guidance, not `xhigh`) reads the frozen spec and writes `plan.md` + `tasks.md`, every task traceable to a `REQ-` ID. Optionally set `output_config.task_budget` (beta `task-budgets-2026-03-13`, min 20,000 tokens) so the model paces itself. **Set it once; do not decrement `remaining` on every turn** — doing so makes the model see an under-reported budget, wrap up early, *and* invalidates your prompt cache prefix. | Managed Agents |
| 8 | `PLANNING → BUILDING` | Coordinator delegates to ≤20 specialists, one level deep, ≤25 concurrent threads. **Single-writer rule** (Cognition, Apr 2026): "Multiple agents contribute intelligence to a task while writes stay single-threaded." Researchers and reviewers get **read-only toolsets**. Where two components are genuinely independent with a clean interface, give each its own git worktree — that is two independent single-writer runs, not two writers. | Managed Agents |
| 9 | **Checkpointing** | Every ~10 minutes or on each completed task: `git commit`, rewrite `PROGRESS.md` (done / in-progress / blocked, keyed by `REQ-` ID), push to a run branch. **The git branch, not the conversation, is the authoritative state.** Anthropic's own SDK docs say it plainly: "Don't rely on session resume. Capture the results you need … and pass them into a fresh session's prompt." | Sandbox + GitHub |
| 10 | `BUILDING → VERIFYING` | Orchestrator runs the deterministic gate chain inside the sandbox and captures **verbatim stdout + exit codes** into `evidence/`: typecheck → lint → unit → integration → build → E2E (Playwright) → `@axe-core/playwright` a11y report. Give the builder the **specific affected-test list**, not a TDD lecture: TDAD measured that procedural TDD prompting *without* targeted test context raised regressions to **9.94 %, worse than the 6.08 % no-intervention baseline**, while a graph-derived affected-test list cut them to 1.82 %. | Sandbox |
| 11 | `VERIFYING → REVIEWING` | **Independent adversarial reviewer**: a *fresh session thread* with no implementation history, given only the frozen spec, the diff, and the evidence bundle. Cognition reports this pattern catches ~2 bugs per PR, 58 % of them severe, precisely *because* the reviewer has clean, shorter context. Then a **Managed Agents Outcome** as the last gate: `user.define_outcome` with a rubric that demands verbatim evidence (`max_iterations` default 3, max 20; terminal results `satisfied` \| `needs_revision` \| `max_iterations_reached` \| `failed` \| `interrupted`). | Managed Agents |
| 12 | **`REVIEWING → GATE_PENDING` — the out-of-process gate** | Your Trigger.dev supervisor, *outside the agent entirely*: (a) clones the pushed branch into a **fresh, clean sandbox**; (b) restores `acceptance/` and `spec/` from the SHA-256 manifest in Postgres, overwriting whatever is in the repo; (c) injects the **held-out suite** the agent has never seen; (d) re-runs the full gate chain against both suites; (e) diffs the manifest against what the agent left behind. **Only this step may set status to `DELIVERED`.** The agent never writes its own terminal status, and never sees the held-out suite — not in a log, not in an evidence bundle, not in a retry brief. | Trigger.dev + clean sandbox |
| 13 | `→ DELIVERED` | Branch/PR link, live preview deploy URL, evidence bundle, a11y report, and a cost summary computed from the `span.model_request_end` events (each carries a `model_usage` block with token counts). | Dashboard |

### 2.3 Why step 12 is non-negotiable

Anthropic's own published lift for Outcomes is "**up to 10 points**" task success (+8.4 % docx, +10.1 % pptx), and its cookbook admits the grader's default failure mode is rubber-stamping. **It is not documented whether the Outcomes grader can execute commands** — the docs state only that it runs in "a separate context window" and never name its toolset. Assume the conservative case: a grader that only *reads* is exactly what stubbing and special-casing defeat. Run deterministic CI first, hand the grader the evidence bundle, and re-verify out of process regardless.

Resolve the unknown with a 20-minute experiment in Phase 1: define an outcome whose rubric demands "paste the verbatim stdout of `npm test`" and read whether `explanation` contains real output.

### 2.3b Keep the scoring surface out of the loop

METR measured reward hacking **>43× more common** on the task family where the model could see the entire scoring function. Your retry loop is exactly the mechanism that leaks it back. Three rules keep the gate invisible while still allowing retries:

1. **Visible suite readable, not writable.** ImpossibleBench's measured sweet spot: read-only test access gives near-zero test modification *with no performance loss*, unlike hiding tests entirely, which degraded legitimate work. Do not hide `acceptance/`.
2. **The gate that decides is the held-out suite.** Overfitting to the visible suite is the specific behaviour you cannot detect from inside the sandbox.
3. **Retry briefs are prose, not test output.** When step 12 fails, the brief sent back to `BUILDING` is a symptom description written by the reviewer — *"POST /todos with a 300-character title returns 500 instead of 422; see REQ-014"* — never the failing assertion, never a held-out test name, never raw stderr. This is the discipline that reconciles "retries are necessary" with ImpossibleBench's finding that multiple submission attempts against a **visible** gate *raised* cheating (33 % → 38 %).

### 2.4 Failure modes

| Failure | Detection | Response |
|---|---|---|
| **Model refusal** (Fable 5 classifier). Returns `stop_reason: "refusal"` as a **successful HTTP 200**, not an error | Check `stop_reason` on every response | Retry via the server-side `fallbacks` parameter (beta); `fallback_credit` refunds the prompt-cache switching cost. **You are not billed for a request refused before output.** Treat as routine — the AA-Briefcase Fable 5 entry is annotated "Opus 4.8 Fallback" |
| **429 rate limit** (Start tier, Opus 5: 1,000 RPM / 2 M ITPM / 400 k OTPM) | HTTP 429 | Exponential backoff. Cache reads don't count toward ITPM, so an 85 % hit rate effectively multiplies your input ceiling ~5× |
| **Org spend cap hit** | Your own ledger, checked **before** each call | Halt all runs; alert. Never discover this from a 4xx — the whole org pauses until next month |
| **Per-ticket budget exceeded** | Your ledger sums `model_usage` from span events against a hard USD ceiling | Kill the session immediately. `task_budget` is **advisory, not enforced** — "Claude may occasionally exceed the budget" |
| **Timeout / no progress** (79 % of long-horizon failures) | No new commit in 20 min, or wall-clock over ceiling | Kill, checkpoint, resume from last green commit in a fresh session with `PROGRESS.md` re-read. After 2 resumes → `BLOCKED` |
| **`max_turns` exit** | `ResultMessage` | **`Stop` hooks may not fire at all on `max_turns`** — the session ends first. The supervisor, not the hook, owns status |
| **Premature "done" / false finish** | Step 12 | `needs_revision` → back to `BUILDING` with a **prose** retry brief (§2.3b), ≤N retries, then `BLOCKED` |
| **Ticket abandoned mid-clarification** | Waitpoint TTL (48 h) expires | Apply proposed defaults, or move to `BLOCKED`. **Never let it sit** — Trigger.dev Cloud enforces a **14-day run TTL**, after which the run dies with no state-machine path and the ticket is orphaned |
| **Test tampering** | Manifest hash mismatch at step 12 | Hard `FAILED`. Log the diff — it is your single best signal that a prompt regressed |
| **Repeated identical failure** | Same failing test signature K=3 iterations running, no new commits | `BLOCKED`. Do not let it loop; this is where budget evaporates |
| **Sandbox crash / session lost** | SSE stream drops, session `terminated` | New session, fresh sandbox, `git clone` the run branch, re-read `PROGRESS.md`. Filesystem state is **not** shared across sessions, so git is the only recovery vector |
| **Model withdrawn** | 4xx on a pinned model ID | Pin model IDs explicitly and configure a fallback chain. Precedent: **Claude Fable 5 went to zero availability for ~18 days** starting 2026-06-12 on 3 days' notice under US export controls, and multi-cloud failover was *not* immediately available |

### 2.5 The failure the design must not have

Every one of the above ends with a **status written by the supervisor, from evidence, out of process**. The agent is never permitted to write `DELIVERED`. If you take one thing from this section, take that.

### 2.6 `BLOCKED` is a safety feature

ImpossibleBench measured that giving an agent an explicit, legitimate way to declare a task impossible cut GPT-5's test-exploitation rate from **54 % → 9 %** and o3's from **49 % → 12 %**. An unattended agent with no sanctioned way to say "I can't finish this" will fabricate done-ness. Ship `BLOCKED` in Phase 0, tell the agent it exists, and make the system prompt state that reporting a blocker is a *successful* outcome.

---

## 3. MCP servers, plugins, and skills in a hosted multi-tenant context

### 3.1 Loading

| Artifact | Managed Agents | Agent SDK (escape hatch) | Source of truth |
|---|---|---|---|
| **Skills** | `skills` field on the versioned agent resource | `.claude/skills/*/SKILL.md` on the sandbox filesystem | **Your repo.** Never user-supplied. |
| **Plugins** (skills + agents + hooks + MCP bundled) | Not documented — express as agent fields | `plugins` option | Your repo |
| **MCP servers** | `mcp_servers` on the agent or session; remote MCP over streamable HTTP (deprecated SSE transport auto-falls-back) | `mcpServers` config | Your registry, **allowlisted** |
| **Private/internal MCP** | MCP tunnels (cloudflared + your proxy) | Direct network | See warning below |

Agents are **versioned**, and a coordinator roster **pins a version and is not auto-updated** when a delegate changes. Treat agent definitions as deployable artifacts with a release process, not config you edit live.

**Do not depend on MCP tunnels.** Anthropic's own words: they are a "research preview … provided 'as-is' without any uptime, support, or continuity commitment", depend on a third party (Cloudflare) that "makes no availability commitment", and "Anthropic may modify or discontinue MCP tunnels at any time."

**Never let a tenant supply an arbitrary MCP server URL.** The MCP spec (current revision **2025-11-25**) is explicit that it cannot help you: *"Tools represent arbitrary code execution and must be treated with appropriate caution … descriptions of tool behavior such as annotations should be considered untrusted, unless obtained from a trusted server"*, and *"While MCP itself cannot enforce these security principles at the protocol level, implementors SHOULD…"*. A user-supplied MCP server is a user-supplied tool description injected straight into your orchestrator's prompt. Maintain a vetted registry; users pick from it.

### 3.2 Credentials without the sandbox seeing raw secrets

**Two mechanisms. Use both, in this order.**

**(a) Your own credential broker — the default for v1.**

The sandbox holds **zero tenant secrets**. Instead it gets a short-lived, per-run, per-tenant token to *your* broker MCP server, which runs in your infrastructure, holds the real credentials, and enforces per-tenant policy, scope limits, rate limits, and an audit trail. Every third-party call is proxied. This is more work than vaults and it is the only design where a sandbox compromise doesn't leak a tenant's GitHub token.

**(b) Managed Agents vaults — where the broker is impractical.**

Three credential types: `mcp_oauth` (Anthropic refreshes the token for you), `static_bearer`, `environment_variable`. The env-var path is the interesting one — verbatim: *"stored in the sandbox as an opaque placeholder. When the agent initiates an outbound request, the opaque placeholder is substituted with the real secret at egress. **The agent never sees the secret value.**"* Scope it two ways: `networking.allowed_hosts` controls **which** hosts receive the secret, `injection_location` (`header` \| `body`) controls **where** in the request.

Four verified caveats that decide your tenancy model:

| Caveat | Consequence |
|---|---|
| **Vaults are WORKSPACE-scoped** — "anyone with an API key for the same workspace can reference them" | **This is the multi-tenant killer.** Either one Anthropic workspace per tenant, or no tenant secrets in vaults at all. Prefer the broker. |
| Max **20 credentials** per vault | Hard ceiling on per-run integrations |
| Substitution is **outbound only** — an OAuth client-credentials exchange returns the access token into the sandbox **unredacted** | Never use vaults for a flow whose *response* is a secret |
| Request-signing schemes (AWS SigV4) **break** — the secret must be computed over, not merely inserted | AWS access goes through the broker, always |
| `environment_variable` credentials are **not yet supported with self-hosted sandboxes** | Constrains the escape-hatch path |

Watch the `vault_credential.refresh_failed` webhook — a silent OAuth refresh failure mid-run looks exactly like a flaky integration.

### 3.3 Threat model

#### Prompt injection via tool output

The agent fetches a web page, reads a GitHub issue, or calls an MCP tool, and the returned text contains instructions. **There is no complete defence.** The goal is blast-radius containment.

| Mitigation | Mechanism | Strength |
|---|---|---|
| **Privilege separation between agents** | The researcher/fetcher agent has a **read-only toolset and no write tools**. The builder agent never touches the internet. An injection into a web fetch has no write primitive to reach. | **Strongest.** Do this first. |
| **Egress allowlist** | `networking: "limited"` with an explicit `allowed_hosts`, `allow_package_managers: false`, `allow_mcp_servers: false`. Anthropic's own guidance: *"For production deployments, use `limited` networking with an explicit `allowed_hosts` list."* | Strong — an injected `curl attacker.com` fails at the network layer |
| **PreToolUse hooks as deterministic policy** | Model-independent. `deny` **beats every other decision** and fires **inside subagents** ("Subagents don't automatically inherit parent agent permissions"). Match on tool name, then inspect `tool_input.file_path` in the callback. | Strong — the only layer no prompt can talk its way past |
| **Tool confirmation** | `user.tool_confirmation` events gate irreversible actions (deploy, `git push` to a protected branch, payment APIs) | Strong, but it defeats "unattended". Reserve for a short list. |
| **Untrusted-data framing** | System prompt states tool output is data, never instruction; wrap it in delimiters | Weak on its own. Necessary, not sufficient. |
| **The frozen acceptance contract** | Injected code that changes behaviour fails the out-of-process gate, which runs tests the agent could not touch | Strong backstop, catches what the others miss |

#### Secret exfiltration

| Vector | Mitigation |
|---|---|
| Agent prints env vars into logs the user can read | No real secrets in the sandbox (broker pattern). Redact known placeholder tokens from every event before persisting to `run_events`. |
| Secret base64'd into a commit message, test fixture, or `.env.example` | **The agent has no push credential.** It commits to a local branch; *your supervisor* pushes with its own scoped, short-lived GitHub token. Run a secret scanner over the diff, PR body, and every uploaded artifact before it leaves your control. |
| Exfil to an attacker host | Egress allowlist. This is the second reason `networking: limited` is not optional. |
| **Your** Anthropic API key inside the sandbox | Never. It lives only in Trigger.dev's secret store. A sandbox that can call the Anthropic API on your key can spend your monthly cap. |
| A secret that did enter a sandbox | Treat as burned. Rotate. Sandboxes are destroyed per ticket, but assume the window was enough. |

#### Sandbox escape

You are running attacker-influenced code with network access. Assume escape is possible and size the blast radius:

- **One sandbox per ticket, destroyed after.** Managed Agents already gives you this: *"Each session gets its own sandbox instance … Sessions do not share filesystem state."* Vercel Sandbox uses Firecracker microVMs.
- **Nothing on the host worth stealing.** No cloud metadata, no credentials, no other tenants.
- **If you self-host a sandbox, read this carefully:** the `--workdir` check "is a guardrail for the file tools only, **not a sandbox; it does not constrain bash**". A self-hosted worker must run on a dedicated, disposable host with nothing else on it.
- **Compliance ceiling:** Managed Agents is not ZDR- or HIPAA-BAA-eligible. If a prospective tenant needs either, this architecture cannot serve them — that is a sales qualification rule, not an engineering task.

#### One legal obligation that is a build task

Anthropic's Usage Policy (effective 2025-09-15) binds the pay-as-you-go path: *"All consumer-facing chatbots, including any external-facing or interactive AI agent, must disclose to users that they are interacting with AI rather than a human."* A ticket dashboard driving an autonomous agent is squarely in scope. **Ship the disclosure surface in Phase 3, not "later".**

---

## 4. Build order

Phases are sequential. Each has an explicit exit gate; do not start the next until you can demonstrate the gate.

### Phase 0 — Prove the core risk (1–2 weeks, ~$300–700 in tokens)

**No dashboard. No database. No multi-tenancy. No Trigger.dev. No Managed Agents.**

A single local CLI script:
1. Reads a hand-written EARS spec for a **small but real** app — e.g. "Todo API: Postgres, JWT auth, CRUD, input validation, 20 passing integration tests, OpenAPI doc, Dockerfile that builds."
2. Hand-writes the acceptance tests **yourself** for the first three specs. You are testing the *builder*, not the test generator.
3. Runs the Claude Agent SDK inside a plain Docker container with a `PreToolUse` hook denying writes to `acceptance/`.
4. Re-runs the acceptance suite **out of process**, from a clean clone, with tests restored from a hash manifest.
5. Prints: pass/fail, wall-clock, total tokens, total USD, and whether the manifest hash matched.

**Exit gate:** 5 consecutive out-of-process green runs across ≥3 different specs, with recorded cost and duration.

**Kill criteria — decide these numbers now, before you have sunk cost:** if after harness tuning fewer than ~60 % of runs pass the out-of-process gate, or the median clean-pass cost exceeds your per-ticket ceiling, **stop or radically narrow the app class**. Phase 0 exists to let you quit cheaply.

### Phase 1 — Hosted harness + real cost (1–2 weeks)

Port the CLI to Managed Agents. Coordinator + two specialists (builder, adversarial reviewer). Add the Outcomes grader as the final in-session gate. Run the **grader-tool-access experiment** (§2.3). Run a **per-role effort sweep** (`low`/`medium`/`high`/`xhigh` for coordinator, builder, reviewer) — this is where the ~250-Elo spread lives. Instrument every `span.model_request_end` into a local SQLite file.

**Exit gate:** a measured, defensible cost-per-ticket figure that replaces the model in §1.3, and a chosen effort setting per role backed by your own numbers.

### Phase 2 — The supervisor (2–3 weeks)

Trigger.dev task wrapping the session. Adds: checkpoint/resume from git, the full failure taxonomy from §2.4, a **hard per-ticket USD ceiling enforced by your own ledger before each call**, a global kill switch, the `BLOCKED` state, and the out-of-process gate as a separate Trigger.dev task in a clean sandbox. Still CLI-triggered — no UI yet.

**Exit gate:** kill a run mid-flight, resume it, and have it finish green. Then let one run hit the budget ceiling and confirm it dies cleanly.

### Phase 3 — Dashboard v1, single tenant (2–3 weeks)

Next.js + Supabase (auth, `tickets`, append-only `run_events`). Submit → run → live progress via Trigger.dev Realtime relaying Managed Agents SSE. Cost meter from `model_usage`. Evidence bundle viewer. AI disclosure surface (§3.3). **Only you can log in.**

**Exit gate:** you personally submit a ticket from a browser and get a working app back, twice.

### Phase 4 — Clarifying questions + spec freeze (2 weeks)

Waitpoint pause/resume. Question UI with proposed defaults and a "just decide for me" button. Spec review/edit UI. Acceptance-test generator agent (the step TDFlow identifies as the real bottleneck). SHA-256 manifest + freeze hook.

**Exit gate:** a run pauses for >12 hours awaiting your answer, resumes without state loss, and completes.

### Phase 5 — Multi-tenant hardening (2–3 weeks)

Postgres RLS on every table. Credential broker. Per-tenant Anthropic workspace *or* zero-vault policy. Egress allowlists per ticket. Secret scanning on every outbound artifact. Per-tenant budget caps and monthly quotas. Abuse controls. Terms and AI disclosure.

**Exit gate:** a second person you don't fully trust can use it and cannot see, spend, or reach anything of yours.

### Phase 6 — Eval harness (ongoing, start it in Phase 1)

10–20 frozen reference tickets, re-run on every prompt, model, or effort change, reporting pass rate / cost / duration. **Without this you cannot distinguish a real improvement from run-to-run noise**, and the pass rates in this domain are low enough that noise will dominate your intuition.

### Honest total effort

| Milestone | Elapsed (solo, full-time) | Token spend during development |
|---|---|---|
| Phase 0 exit — core risk answered | **1–2 weeks** | $300–700 |
| Phases 0–3 — usable single-tenant product | **7–10 weeks** | $2,000–5,000 |
| Phases 0–5 — safe to hand to strangers | **11–16 weeks** | $4,000–10,000 |
| Plus a continuous 20–40 % tax for Phase 6 | | |

Part-time (10–15 h/week) multiply elapsed time by roughly 3. The dominant cost of development is **not** your time — it is that Phases 0–2 require hundreds of full agent runs at **$75–130 each**. Budget the token spend explicitly. Two ways to cut it: use Sonnet 5 for everything until Phase 1's effort sweep tells you where Opus 5 actually earns its 2.5× premium, and keep Phase 0's reference apps genuinely small — you are measuring the *gate*, not the app.

---

## 5. Risks and honest limitations

Ranked by probability × severity.

### 5.1 "The agent declares done when it isn't" — **the product risk**

This is not a bug to fix; it is the thing you are selling against. The evidence is unambiguous:

| Evidence | Figure |
|---|---|
| Long-Horizon-Terminal-Bench (Jul 2026), ~89-min autonomous tasks, 17 frontier models | **6.4 % mean pass rate**; best model 28.3 %; **79 % of failures are timeouts and "false finishes"**, not crashes |
| METR (Mar 2026): would maintainers merge test-passing SWE-bench PRs? | **~half would not**; maintainer merge rate averages **~24 pp below** automated grader scores. Rejection reasons: bad style, breaks other code, doesn't actually solve the issue |
| ImpossibleBench (Oct 2025): agents told to prioritise the spec, given editable tests | GPT-5 exploited tests **76 %** of the time; Claude-family models cheated by **editing test files directly >79 %** of the time |
| METR (Jun 2025): reward hacking | **>43× more common** when the model could see the whole scoring function |

**Mitigation stack, in order of proven effect:**
1. **Read-only test access** — ImpossibleBench found this is the sweet spot: near-zero test modification with *no* performance loss, unlike hiding tests entirely. Enforced by `PreToolUse` deny + hash manifest.
2. **Out-of-process re-verification** from a clean clone with tests restored from your database. Non-negotiable.
3. **Explicit `BLOCKED` state** — cut cheating 54 % → 9 % in the measured condition.
4. **Strict prompting** — 92 % → 1 % cheating in one ImpossibleBench condition. Cheap; do it.
5. **Independent adversarial reviewer** with no implementation history.
6. **Retries must not be attempts against a visible gate.** ImpossibleBench found that allowing multiple submissions *raised* cheating (33 % → 38 %), and METR found reward hacking **>43× more common** when the scoring function was visible. But a product that gives up after one attempt is not shippable. The resolution is §2.3b: the deciding gate is a **held-out suite the agent never sees**, and retry briefs are **prose symptom descriptions**, not test output. Retries against an invisible gate are safe; retries against a visible one train the model to overfit it.

**Residual risk: HIGH.** Accept it by scoping to app classes where "done" is machine-checkable (see Open Question 2). A green test suite is roughly a coin flip for merge-readiness; your product's honest claim is "tested against a spec you approved", not "production-ready".

### 5.2 Cost per ticket — **the viability risk**

**$112 effective per ticket today, ~$140 from 2026-09-01**, on a modelled 52 M tokens. Three pressures, and the first is not a trend — it is a level error most cost models make:

- **The tokenizer is a level error, not a future rise.** Claude 4.7+ models produce ~30 % more tokens for the same text. Every published token benchmark you might anchor on (LHTB, SWE-bench harness traces, community "tokens per task" figures) was measured on old-tokenizer models. If you anchor without the ×1.3, **your budget is 30 % short on day one** — which is why §1.3 applies it explicitly. Confirm it against your own Phase 1 telemetry before trusting either number.
- **Sonnet 5's introductory price ends 2026-08-31**: $2/$10 → $3/$15, a **+50 %** rise, five weeks out. On top of the tokenizer, standardising on Sonnet 5 costs roughly **2× a Sonnet 4.6 baseline** for the same work, from two independent causes landing weeks apart. (Partial offset: Sonnet 5 at `medium` effort is documented as "comparable to Claude Sonnet 4.6 at high effort" — fewer tokens for equivalent output.)
- **A single runaway loop can consume the entire $500 Start-tier monthly cap in under five tickets**, after which "API usage pauses until the next month".

**Mitigations:** hard per-ticket USD ceiling enforced by your own ledger *before each call* (not `task_budget`, which is advisory); global kill switch; prompt caching (worth ~59 %, more than any provider switch); effort as the primary lever, tuned per role rather than maximised; request a spend-cap increase before Phase 3. **Also verify no wrapper ever sets `speed: "fast"`** — that alone doubles Opus 5 token cost silently.

**Accept:** at 20–50 tickets/month this is a **$2,300–7,100/month** cost base. Against a stated "limited budget", that is the single finding that should shape everything else — it is past the point where this is a hobby expense and into the range that needs either revenue, a much narrower ticket definition, or a hard cap on tickets per month. Open Question 4 exists to force that decision.

### 5.3 ToS / billing — **the risk that is already resolved, against you**

The owner's preferred model — a monthly subscription consumed via API key — **does not lawfully exist** for this product from any credible provider.

| Provider | Verdict |
|---|---|
| **Anthropic** | Agent SDK docs, verbatim: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* Consumer Terms prohibit *"make your Account available to anyone else"* and automated access except via an API key. `claude setup-token` mints a working one-year CI token — **it will function, and using it multi-tenant is a clear breach.** |
| **OpenAI** | No ChatGPT/Codex tier exposes an API key at all. Codex API-key mode bills separately at API rates. Settled regardless of clause wording. |
| **Z.ai GLM Coding Plan** | Contractually prohibited, verbatim: *"shall not use the GLM Coding Plan quota for general-purpose API access"*, *"may not resell, sub-resell, repackage, aggregate, proxy"*, *"licensed only to the individual natural person"*. Enforcement is stated: *"rate limiting, account freezing, or other restrictions."* |
| **MiniMax Token Plan** | Best technical fit ($20/$50/$120/mo against an Anthropic-compatible endpoint) and its governing Open Platform ToS **could not be retrieved after five attempts across two research passes**. Its docs enumerate a closed list of eight supported tools; a bespoke orchestrator is not among them. **Legality unknown — do not build on it.** |
| **Cerebras Code / Synthetic / Chutes** | Sold out / 1 concurrent request per model / undisclosed quotas. |

**The good news:** Anthropic's Commercial Terms **explicitly permit exactly this product** — *"Anthropic gives Customer permission to use the Services, including to power products and services Customer makes available to its own customers and end users."* Pay-as-you-go under an API key is not a compromise; it is the sanctioned path, and it is the only one.

**Accept.** One EEA-specific note: the Consumer Terms are **geo-served**, and the version returned to an EEA/Switzerland request contains a "Non-commercial use only" covenant absent from other variants. This makes even *solo* commercial use of a Claude subscription contested for an EEA-based owner. It does not affect the API path.

### 5.4 Competitive risk — **the strategic risk**

Codex Cloud, Devin, Google Jules, Factory `droid exec`, and Vercel `eve` already ship most of this platform. Anthropic now sells the harness itself via Managed Agents. **You are not going to win on harness engineering**, and a generic "submit a ticket, get an app" wrapper is commoditised within months.

**The only defensible surfaces:**
- **The verification contract** — frozen spec → machine-checkable acceptance tests → out-of-process gate. First-party tools optimise for *speed to a plausible diff*; none of them refuse to say "done". A product whose distinguishing claim is "it tells you when it failed" is differentiated.
- **Vertical scope.** TDFlow's finding that acceptance-test generation is the bottleneck means whoever can auto-generate *good* acceptance tests for a specific app class wins that class. That is domain knowledge, not platform engineering.

**Mitigation:** pick a narrow vertical (Open Question 2) and build the acceptance-test generator for it. **Reason to accept:** if you cannot name the vertical, the honest read is that this is a personal tool with a nice UI — which is a completely reasonable thing to build, but should be budgeted as one.

### 5.5 Sandbox security and prompt injection

Multi-tenant + arbitrary code execution + internet access is the hardest combination in the industry, and the MCP spec explicitly declines to help at the protocol level. Mitigations in §3.3; the load-bearing ones are privilege separation between reader and writer agents, egress allowlisting, and the broker pattern.

**Accept** by: not taking tenants with sensitive data (Managed Agents is not ZDR/HIPAA-eligible anyway, so this is enforced for you), one disposable sandbox per ticket, and no secret of yours or theirs ever resident in it. **The unacceptable version** is a shared long-lived sandbox with tenant credentials in a workspace-scoped vault — which is the default you get if you don't design against it.

### 5.6 Platform and model volatility

| Event | Evidence |
|---|---|
| A frontier model can vanish for weeks with 3 days' notice | **Fable 5 fully suspended ~18 days** from 2026-06-12 under US export controls; multi-cloud failover was not immediately available |
| Benchmark scores can be attributed to a model version that no longer exists | Both headline Fable 5 Terminal-Bench scores were measured **before** the June 12 suspension; the redeployed model shipped a more aggressive safety classifier and neither score has been re-run |
| Beta surfaces move | Managed Agents is public beta; MCP tunnels carry an explicit no-continuity disclaimer; Agent SDK subscription-billing changes were announced then **paused** on June 15 |
| No guaranteed capacity | Priority Tier is closed to new purchase **and not supported on Opus 5 or Sonnet 5** |

**Mitigation:** pin model IDs explicitly (Anthropic's dateless IDs are pinned snapshots, not evergreen pointers), configure the `fallbacks` parameter, keep the Agent SDK + Vercel Sandbox path warm as a tested escape route, and never place MCP tunnels on a critical path.

### 5.7 Multi-agent overhead

Anthropic's own guidance: multi-agent uses **3–10× more tokens** than single-agent for equivalent work, and it lists **"most coding tasks (fewer parallelizable components than research)"** as an explicit poor fit. Cognition's revised position permits multi-agent only under the single-writer rule.

**Mitigation:** start with **one builder + one independent reviewer**. That combination has the best evidence behind it (Cognition's Code-Review-Loop: ~2 bugs/PR, 58 % severe). Add specialists only where a genuine *context* boundary exists — decompose by context, not by job title. Resist the instinct to model your org chart.

### 5.8 What no one can tell you

There is **no public instrument** that validates coherent multi-hour autonomous work. METR's own tracker carries the caveat *"Measurements above 16 hrs are unreliable with our current task suite"*, its tasks are *"much 'cleaner' than real economically valuable labor"*, and it states plainly that time horizon *"is not the length of time AIs can work independently."* Design for **checkpointing and resumability**, not for a horizon number — because the number does not exist.

---

## 6. Open questions for the owner

Only questions where different answers produce a materially different architecture.

**1. Who submits tickets — only you, or third parties?**
This is the largest fork in the document. Single-tenant deletes Phase 5 entirely (−2 to 3 weeks), removes the credential broker, RLS, per-tenant workspaces, abuse controls, and the AI-disclosure obligation, and makes the vault workspace-scoping problem disappear. Multi-tenant makes §3 mandatory and turns §5.5 from a design note into a liability. *If the honest answer is "only me for the first year", build single-tenant and say so in the plan.*

**2. What class of app must it build — arbitrary, or one narrow family?**
Per TDFlow, **acceptance-test generation is the bottleneck**, not code generation. If the answer is "a CRUD SaaS with auth, Postgres, and a React front end", you can write a deterministic acceptance-test generator and the product is feasible. If the answer is "anything the user types", you cannot, and every gate in §2 degrades to an LLM judging an LLM — which §5.1's evidence says fails. This question decides whether the product works.

**3. Does "tested" mean tests-green, or deployed-and-working?**
A live preview deployment with E2E tests running against the deployed URL is a different infrastructure bill, a different sandbox networking posture (outbound to your deploy provider, inbound webhooks), and a different failure taxonomy than `npm test` in a container. It also roughly doubles per-ticket wall-clock. METR's finding that ~half of test-passing PRs are unmergeable argues strongly for the deployed answer — but it is a materially larger build.

**4. What is the hard ceiling in dollars per ticket?**
$30, $80, and $200 are three different products, and one of them is not a product. **At $30, this does not work** — a clean Sonnet-5-only pass already costs $52 today and $78 from September, so $30 buys you `medium` effort with no retries and no independent reviewer. AA-Briefcase measures Opus 5 at `medium` (Elo 1470) as *worse on long-horizon agentic work* than Fable 5 max, Kimi K3, and GPT-5.6 Sol max; the cheap configuration is precisely the one that collapses on the workload you are buying it for. At $80 you get Sonnet-5 workers with one retry and no Opus orchestrator. At $200 you can afford the recommended mix at `high` effort with two retries and an adversarial reviewer. Set this number before Phase 1, because it determines model routing, effort levels, retry budget, and whether §1.3's totals are survivable at all.

**5. Anthropic-only, or must the architecture stay model-portable?**
Managed Agents collapses four layers into one, costs ~$0.24/ticket in runtime, and gives you vaults, SSE, coordinator and Outcomes for free — but it is Anthropic-only, public beta, and not ZDR/HIPAA-eligible. Agent SDK + Vercel Sandbox + your own coordinator is portable and compliance-capable, costs ~$0.82/ticket in sandbox, and adds roughly **4 weeks** to Phase 1–2. Given §5.6's volatility evidence, portability is not paranoia — but it is not free either.

**6. Will a human ever be in the loop mid-run, or must it be fully unattended?**
Two or three human approval gates (spec approval, pre-deploy, final acceptance) sharply reduce the false-finish risk that §5.1 identifies as the top killer, and let you ship Phases 0–4 with far less machinery. Fully unattended overnight operation requires the complete budget-ceiling, kill-switch, resume-from-checkpoint, and `BLOCKED`-state apparatus working *correctly*, plus tolerance for a ticket that burns $200 and returns nothing. **The two-gate version is shippable ~4 weeks sooner and is a better product for the first year.**