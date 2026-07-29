# Model Decision — Final

**Status: CLOSED.** Reopen only on a named trigger in §9.
**Date: 2026-07-27.** All prices are list price as of this date.

> **Provenance, stated up front.** No live web access was available in this session. Every figure below is inherited from the Wave-3 research packet and from `/Users/kamilborzecki/Projects/coding-agent/docs/research/01-verification-corrections.md`, both of which were primary-source-verified on 2026-07-27. Where the packet's five lenses contradicted each other, the adversarial correction pass wins and I have applied it. **A retrieval caveat applies to everything here:** all source quotes in the packet were obtained through WebFetch's summarising model, not read off rendered HTML, and two fetches of the *same* arXiv URL returned different model counts and mean pass rates. Before any figure below is used to justify spend above ~$1,000, confirm that specific number in a browser. This is also the strongest argument for §7.

---

## 1. THE ANSWER

**Orchestrator: Claude Opus 5 (`claude-opus-5`) at `effort: high`** — with the Spec Architect and Adversarial Reviewer split out as separate agents pinned at `xhigh`, because changing effort mid-conversation destroys the prompt cache.

**Subagents: Claude Sonnet 5 (`claude-sonnet-5`) at `effort: medium`** — through 2026-08-31 at the introductory rate, and still after the 2026-09-01 rise.

**Nothing displaces either.** Kimi K3 is priced at **$3.00 / $0.30 / $15.00 per MTok — identical to the cent to Sonnet 5's post-2026-09-01 rate and *more expensive* than Sonnet 5 today** ($2 / $0.20 / $10), so the subagent swap is closed on arithmetic before any benchmark is consulted; DeepSeek V4 Pro is independently measured at **6.5% pass@1 on Long-Horizon Terminal-Bench while burning 14.45M tokens/task against GPT-5.6-sol's 4.32M**; GLM-5.1 is the only open-weight model ever measured on the official Terminal-Bench board and sits **15.9 points below Sonnet 5 on the identical Claude Code harness** with non-overlapping confidence intervals; MiniMax is blocked on a terms-of-service document that has been unretrievable across six attempts in two research waves. The community coding tier list is not evidence and is falsified in at least four places (§2.4).

**The thing the owner actually asked for — "closer to guaranteed quality" — is not in this section.** It is in §5. Model choice is the *fifth*-largest lever available and the four above it are cheaper.

---

## 2. THE FULL COMPARISON TABLE

### 2.1 Master table

Price is USD per million tokens: **input cache-miss / input cache-hit / output**. `IND` = independently measured. `SR` = vendor self-reported.

| Model (API ID) | in-miss / in-hit / out | Context | Caching mechanism | Long-horizon pacing | INDEPENDENT score | Vendor claim (SR) | ToS for a third-party product |
|---|---|---|---|---|---|---|---|
| **Claude Opus 5** `claude-opus-5` | **$5.00 / $0.50 / $25.00**<br>(5m write $6.25, 1h write $10) | 1M | Explicit `cache_control` breakpoints **+** automatic; **5-min AND 1-hour TTL**; read 0.1×; write 1.25×/2×. Cache reads do not count toward ITPM. **Only provider where 85% is engineerable.** | `task_budget` beta (`task-budgets-2026-03-13`) — *advisory, not enforced*; effort ladder low→max | **AA-Briefcase 1720 (max) / 1693 (xhigh) / 1606 (high) / 1470 (med) / 1223 (low) — rank 1**<br>**AA Terminal-Bench v2.1 89.1% (max)**<br>**Vals AI TB2.1 84.64%** | — | **PERMITTED.** Commercial Terms §A.1 verbatim: *"Anthropic gives Customer permission to use the Services, including to power products and services Customer makes available to its own customers and end users."* |
| **Claude Sonnet 5** `claude-sonnet-5` | **$2.00 / $0.20 / $10.00** to 2026-08-31<br>**$3.00 / $0.30 / $15.00** from 2026-09-01 | 1M | as Opus 5 | **No `task_budget`.** Effort ladder only; cap out-of-process via `max_tokens` + orchestrator ledger | **tbench.ai TB2.1 74.6% ±1.6 (Claude Code)**<br>**Vals AI TB2.1 74.53%**<br>AA-Briefcase 1386 (max) / 1194 (high) / 1056 (med) / 928 (low) | — | **PERMITTED** (same) |
| **Claude Fable 5** | $10.00 / $1.00 / $50.00 | 1M | as Opus 5 | `task_budget` supported | **tbench.ai TB2.1 83.8% ±1.2 (Claude Code) — rank 1**; 80.4% ±1.2 (Terminus 2)<br>**Vals AI TB2.1 80.52%**<br>AA-Briefcase 1574 (max) | — | **PERMITTED** — but **fully suspended 2026-06-12→06-30** on 3 days' notice under export controls; no ZDR; returns `stop_reason: "refusal"` as HTTP 200 |
| **Claude Haiku 4.5** | $1.00 / $0.10 / $5.00 | 200k | as Opus 5 | none — **no `effort` parameter at all** | absent from TB2.1; AA-Briefcase 612 | — | **PERMITTED** — but **Feb-2025 knowledge cutoff. Disqualified for code.** |
| **Kimi K3** `kimi-k3` | **$3.00 / $0.30 / $15.00** | 1,048,576 | **Automatic only**, no `cache_control`, 256-token minimum prefix. **No TTL documented anywhere** `[uncertain]`. **Cache-write charge undocumented** `[uncertain]` | `reasoning_effort` low/high/max (max default). No budget primitive | **Vals AI TB2.1 80.90%** (Terminus 2, pass@1, 2026-07-22, **effort setting undisclosed** `[uncertain]`)<br>AA-Briefcase 1540 — rank 5<br>**Absent from tbench.ai, LHTB, SWE-bench Pro** | **88.3 on TB2.1** — mixed harnesses across benchmarks (Kimi Code for some, Claude Code for others). **7.4pp above the independent measurement.** | **PERMITTED.** Verbatim: *"use … APIs to integrate the Services into your own applications, products, or Services … and to offer those Customer Applications to End Users."* No API-key transfer. |
| **Kimi K2.7-code** | $0.95 / $0.19 / $4.00 | 262,144 | as K3 | as K3 | **LHTB 6.5%**, 8.54M tok/task, $8.67/task, 85.4 min | — | **PERMITTED** (same) |
| **Kimi K2.6** | $0.95 / $0.16 / $4.00 | 256k | as K3 | as K3 | **LHTB 0.0%**; AA-Briefcase 818 | — | **PERMITTED** (same) |
| **DeepSeek V4 Pro** `deepseek-v4-pro` | **$0.435 / $0.003625 / $0.87**<br>(cache hit = 0.83% of miss) | 1M (384k max out) | **Automatic, no write premium, TTL "a few hours to a few days."** Docs explicitly disclaim any guarantee: operates *"on a best-effort basis"* | **`reasoning_effort: high\|max` only — a two-rung dial, no budget, no pacing** | **LHTB 6.5% pass@1, 14.45M tok/task, $6.19/task, 83.6 min**<br>**CAISI: SWE-Bench Verified 74% → PortBench (held-out) 44%; IRT Elo 800 ±28**<br>AA-Briefcase 930 — rank 25<br>**AA hallucination rate 94%, AA-Omniscience −10**<br>**Absent from tbench.ai (all 17 rows checked)** | SWE-bench Verified **80.6%**; SWE-bench Pro **55.4%**; Terminal Bench 2.0 **67.9%** — none independently replicated | **PERMITTED.** ToS §1.1 verbatim: *"providing services to both internal and external end users."* §4.2(3) explicitly permits training/distilling on outputs. **BUT: PRC law, Hangzhou courts, PRC data storage, no primary answer on training-on-inputs** `[uncertain]` |
| **DeepSeek V4 Flash** `deepseek-v4-flash` | **$0.14 / $0.0028 / $0.28** | 1M | as V4 Pro | as V4 Pro | AA-Briefcase 833 — rank 35 (**below Sonnet 5 at `low`, 928**) | — | **PERMITTED** (same, same caveats) |
| **GLM-5.2** (Z.ai) | $1.40 / $0.26 / $4.40<br>(read discount 0.186× — **worst in the field**) | `[uncertain]` not verified | Automatic; *"Cached Input Storage: Limited-time Free"* — a storage fee is expected later. No TTL published | not verified `[uncertain]` | **LHTB 2.2%**<br>AA-Briefcase 1254 (max)<br>**Never appears on tbench.ai** | **81.0 on TB2.1** (Z.ai docs) — **unreplicated; the model is not on the board** | **PERMITTED for pay-as-you-go API.** Terms of Use (eff. 2026-04-14), Additional Terms §1(a) grants the right to *"develop downstream systems, applications or functions to your End Users."* **PROHIBITED via the GLM Coding Plan subscription.** §1(f)(xii) bars using outputs to train external models — the opposite of DeepSeek |
| **GLM-5.1** (Z.ai) | as GLM-5.2 | `[uncertain]` | as GLM-5.2 | as GLM-5.2 | **tbench.ai TB2.1 58.7% ±1.2 (Claude Code) — the ONLY open-weight entry ever, and last place**<br>**LHTB 4.3%**; AA-Briefcase 973 | — | as GLM-5.2 |
| **MiniMax M3** | $0.30 / $0.06 / $1.20 (≤512k in)<br>**doubles to $0.60 / $0.12 / $2.40 above 512k** | ≥512k | Automatic **+** Anthropic-compatible explicit `cache_control`; read 0.20× | not verified `[uncertain]` | **LHTB 6.5%, 20.20M tok/task (4.7× GPT-5.6-sol), $6.13/task**<br>AA-Briefcase 1110 | — | **UNKNOWN — BLOCKED.** ToS unretrievable across **six** attempts in two research waves. Silence is not permission. |
| **Qwen3-Coder-Next** | ~$0.11 / — / $0.80 `[uncertain — aggregator, not Alibaba primary]` | 262k | implicit cache 20% of rate / explicit 10% `[uncertain]` | not verified | **Qwen3.7 Max: LHTB 4.3%**; AA-Briefcase 912. Qwen3.6 27B 810; Qwen3.5 397B 554 | — | **UNCHECKED** — Alibaba terms never opened |
| **GPT-5.6 Sol** | `[uncertain]` — not verified this session | — | — | — | **AA TB v2.1 89.5% (xhigh) — rank 1**; **Vals AI TB2.1 85.77% — rank 1**; **LHTB 15.2%**, 4.32M tok/task; AA-Briefcase 1503 (max) | — | **EXCLUDED ON BEHAVIOUR, not price.** METR: *"GPT-5.6 Sol's detected cheating rate was higher than any public model we have evaluated."* Documented packaging exploits to reveal hidden test suites |
| **GPT-5.5** | `[uncertain]` | — | — | — | **tbench.ai TB2.1 83.1% ±1.1 (Codex) — rank 2**; 78.0% (Terminus 2); **LHTB 15.2%**, 4.16M tok/task; **CAISI: SWE-Bench 81% → PortBench 78%, Elo 1260** | — | not researched this wave |
| **Grok 4.5** | **UNRESEARCHED** `[uncertain]` — the only figure is LHTB's measured **$10.95/task** | unresearched | **unresearched** | **unresearched** | **LHTB 28.3% pass@1 (13 of 46) — rank 1 on the board closest to this workload, 8.91M tok/task (fewer than DeepSeek's 14.45M), 74.9 min**; tbench.ai TB2.1 79.3% ±1.5 (Cursor CLI, rank 4); AA-Briefcase 1317 | — | **UNRESEARCHED.** See §2.5 — this model can be neither adopted nor rejected on current evidence |
| **gpt-oss-120b / Nemotron 3 / Llama 4 Maverick** | — | — | — | — | **AA-Briefcase: gpt-oss-120b (high) = 7 Elo; gpt-oss-20b, Llama 4 Maverick, Nemotron 3 Super 120B = 0.** Scale SWE-bench Pro: gpt-oss-120b 16.20% | — | **Rejected on capability. Do not price them.** |

### 2.2 The three numbers that do the work

| Claim | Evidence | Why it settles the matter |
|---|---|---|
| **Kimi K3 saves nothing in the subagent seat** | $3.00 / $0.30 / $15.00 (Moonshot first-party) vs Sonnet 5 $3 / $0.30 / $15 from 2026-09-01 and $2 / $0.20 / $10 today | Identical to the cent later, strictly worse now. **No benchmark is needed.** |
| **DeepSeek V4 Pro is measured, and measured badly, on the closest task type** | LHTB: 6.5% pass@1, **14.45M tokens/task vs GPT-5.6-sol's 4.32M (3.34×)** | The token ratio is measured directly and does not depend on the noisy pass rate. |
| **A frontier-tuned harness does not rescue a weaker model** | GLM-5.1 run *inside Claude Code* scores 58.7% ±1.2 against Sonnet 5's 74.6% ±1.6 in the same harness. Non-overlapping CIs | Kills the "cheap model + good harness" thesis with a controlled comparison. |

### 2.3 Two absence-claims from the packet that are FALSE — do not repeat them

- ~~"There is zero independent measurement of Kimi K3 on any agentic benchmark."~~ **Vals AI measures it at 80.90% on Terminal-Bench 2.1** (Terminus 2, pass@1, updated 2026-07-22). Effort undisclosed `[uncertain]` — cite this to refute "unmeasured", **not** to size the K3-vs-Opus-5 gap, since effort alone is worth 250–497 Elo against a 3.74pp difference.
- ~~"No independent agentic-coding number exists for DeepSeek V4."~~ **Long-Horizon Terminal-Bench carries a DeepSeek V4 Pro row: 6.5% pass@1, 14.45M tokens, $6.19, 83.6 min.** The measured number disqualifies it more firmly than the absence claim did.

### 2.4 The community tier list is falsified — four specific places

1. **Two of its four DeepSeek entries no longer exist as API products.** DeepSeek's own release note: *"deepseek-chat & deepseek-reasoner will be fully retired and inaccessible after Jul 24th, 2026, 15:59 (UTC)."* That is V3.2 and R1 — its entire B-tier DeepSeek row, retired three days ago.
2. **Its A tier spans >500 Elo.** Claude Sonnet 5 (1386 max) sits in the same band as Gemini 3.1 Pro Preview (457, rank 46 of 56 on AA-Briefcase).
3. **Its C tier outranks its own A tier.** MiMo-V2.5-Pro (C) scores 878 on AA-Briefcase — above DeepSeek V4 Flash (833, A), Kimi K2.6 (818, A) and Qwen3.6-27B (810, A).
4. **It has no notion of reasoning effort**, which is worth 250–497 Elo — more than the gap between its S and A tiers. Any one-number-per-model ranking is measuring something less important than the config flag it ignores.

It also ranks on vendor claims where independent numbers exist (K3 at 88.3 SR vs 80.90 IND), which systematically over-ranks whichever vendor markets hardest.

### 2.5 The one honest hole in this document: Grok 4.5

**Grok 4.5 leads Long-Horizon Terminal-Bench at 28.3% pass@1 — nearly double GPT-5.5's and GPT-5.6-sol's 15.2% — on the benchmark closest to this product's workload, while burning 8.91M tokens/task (fewer than DeepSeek V4 Pro's 14.45M) in 74.9 minutes at a measured $10.95/task.** The row is confirmed by two independent retrievals (arXiv v2 Table 1 and the live leaderboard's "13 of 46"). It is also rank 4 on tbench.ai TB2.1 at 79.3% ±1.5 and 1317 on AA-Briefcase.

**It was never in the owner's consideration set and no lens in this research wave priced it, checked its caching mechanism, looked for a pacing primitive, or read its terms of service.** That absence is not evidence-based, and I am not going to paper over it. It does not change the recommendation — a model with no verified price, no known cache economics and no ToS check cannot be adopted — but it is the one candidate this document *rejects by omission rather than by evidence*, and it is on the reopen list at §9 trigger 8 for exactly that reason. A model that solves 28.3% of ~90-minute autonomous terminal tasks while using 2.4× fewer tokens than DeepSeek is worth four fetches before the next model conversation.

### 2.6 A note on the Claude context figures

The 1M context window shown for Opus 5, Sonnet 5 and Fable 5 is `[uncertain]` — it is **derived**, not cited. Anthropic's pricing page confirms *"Full 1M context billed at standard rates,"* which establishes availability, and the internal research establishes Haiku 4.5's 200k as "5× smaller than the rest of the line." Every other cell in the master table is primary-sourced; this one is an inference. Verify before relying on it for a context-budget decision.

---

## 3. DEEPSEEK, ANSWERED DIRECTLY

### 3.1 What it costs — and this part is genuinely impressive

| | cache-miss in | **cache-hit in** | out | vs Claude Opus 5 |
|---|---|---|---|---|
| deepseek-v4-pro | $0.435 | **$0.003625** | $0.87 | **11.5× / 138× / 28.7× cheaper** |
| deepseek-v4-flash | $0.14 | **$0.0028** | $0.28 | 35.7× / 179× / 89.3× cheaper |

The cache-hit rate is the number that matters, because prompt caching is ~59% of this workload's bill. DeepSeek's cache is **automatic (no client breakpoints), carries no write premium, and lives "a few hours to a few days"** — against Anthropic's 5-minute/1-hour TTLs at a 1.25×/2× write premium. On mechanism alone, DeepSeek's caching is better suited to an hours-long run with idle gaps than Anthropic's is. That is a real finding and it is the strongest thing in DeepSeek's favour.

**Do not host it in the West.** DeepInfra charges $1.30 / $0.10 / $2.60 — 3.0× on tokens and **27.6× on cache hits**, which erases the entire economic case. Also: DeepInfra's own page claims 1M context while Artificial Analysis lists it at 66k, a 15× discrepancy `[uncertain]`.

### 3.2 Where it genuinely ranks

| Board | Type | DeepSeek V4 Pro | Comparator |
|---|---|---|---|
| **Long-Horizon Terminal-Bench** (~90-min autonomous terminal tasks, Terminus-2) | **INDEPENDENT academic** | **6.5% pass@1, 14.45M tok/task, $6.19, 83.6 min** | GPT-5.5 and GPT-5.6-sol **15.2%**, 4.16M / 4.32M tok. No Claude model on this board. |
| **NIST/CAISI** (9 benchmarks, 5 domains) | **INDEPENDENT, US government** | SWE-Bench Verified **74%** → PortBench (held-out) **44%** = **−30pp**. IRT Elo **800 ±28** | GPT-5.5: **81% → 78% = −3pp**. Elo **1260**. CAISI: DeepSeek V4 *"lags behind the frontier by about 8 months."* |
| **AA-Briefcase** (long-horizon agentic knowledge work) | **INDEPENDENT** | **930 — rank 25** | Claude Opus 5 **1720** (rank 1); Sonnet 5 at `low` **928** |
| **tbench.ai Terminal-Bench 2.1** | **INDEPENDENT, staff-verified** | **Absent — all 17 rows checked, three months post-launch** | — |
| **Scale SWE-bench Pro** | **INDEPENDENT** | **No V4 entry.** Only DeepSeek ever scored: V3.2 at **15.56 ±2.63** | vs its own self-reported 55.4% |
| **AA hallucination / AA-Omniscience** | **INDEPENDENT** | **94% hallucination (Pro), 96% (Flash); Omniscience −10 / −23** | AA's framing: *"when they don't know the answer they nearly always respond anyway"* |

The **−30pp vs −3pp differential** on public-to-held-out is the single most important row. It is not a geopolitical claim, it is a methodological one, and **your tickets are the held-out distribution, not the public one.**

### 3.3 Does the ToS permit this use? Yes — cleanly.

DeepSeek Open Platform ToS §1.1, verbatim: developers may *"integrate the capabilities of the DeepSeek models into various downstream systems, applications, or functionalities … providing services to both internal and external end users."* §4.2(2) assigns output rights to you. §4.2(3) explicitly permits training other models on inputs and outputs, *including distillation* — more permissive than any Western provider and the opposite of Z.ai's §1(f)(xii).

**Three commercial exposures that are not ToS problems but are your problems.** `[uncertain]` on all three: (a) the consumer Privacy Policy says inputs are used *"to train and improve our technology"* with an opt-out, and the dedicated open-platform privacy policy 404s — there is **no primary answer** on whether API traffic is excluded from training; (b) data is stored in the PRC, governed by PRC law, with jurisdiction in Hangzhou; (c) liability is capped at *"the total service fees you have actually consumed … in the past twelve months."* Your users submit product ideas. Decide this deliberately, not by default.

### 3.4 The precise conditions under which DeepSeek becomes the right call

All of these are falsifiable. Reopen the question when **(a) or (b)** fires, and adopt only when the whole list holds:

| # | Condition | Currently |
|---|---|---|
| a | A DeepSeek model appears on **tbench.ai Terminal-Bench 2.1 at ≥70%** in a harness you would actually use | absent entirely |
| b | A **V4-generation** model appears on **Scale SWE-bench Pro above ~45%**, consistent with the 55.4% self-report | absent; V3.2 scored 15.56% |
| c | The CAISI public-vs-held-out gap closes on re-evaluation | 74% → 44% |
| d | AA-Omniscience turns non-negative and the hallucination rate falls materially | −10, 94% |
| e | DeepSeek ships a **token/time budget primitive**, not a two-rung effort dial | `reasoning_effort: high\|max` only |
| f | You obtain a **written** answer on training-on-inputs | 404 / no primary source |
| g | Your own bake-off (§7) shows a ≥30% lower **$ per held-out pass** with **no increase in false-finish rate** | unmeasured |

Even before all seven, there is one configuration that is defensible today: **DeepSeek V4 Pro as a bounded subagent behind a deterministic gate the orchestrator runs** — generate this module against this interface, port this file, write tests to this frozen spec — where typecheck/lint/test decides pass/fail and DeepSeek **never** reports its own completion. Test V4 Pro, not V4 Flash (AA-Briefcase 833 puts Flash below Sonnet 5 at `low`).

### 3.5 Why it is not the call today — one paragraph

**The case against DeepSeek is not a cost case, and pretending otherwise would be dishonest.** On the paper's own columns DeepSeek V4 Pro costs roughly $95 per completed long-horizon task against GPT-5.5's ~$138 — it is plausibly *cheaper per finished unit of work*, though that edge rests on a 3-tasks-versus-7-tasks difference in single-run pass@1 on 46 tasks with no per-model confidence intervals, which is well inside noise `[uncertain]`. The case against it is threefold and none of it is about price. First, **absolute throughput**: at 6.5% pass@1, 93.5% of long-horizon runs fail — that is a product that cannot deliver tickets, not a product that delivers them expensively. Second, **the failure mode is the one that damages you**: a 94% hallucination rate and a negative Omniscience index describe a model whose default under uncertainty is to assert, and LHTB measures **19% of unresolved runs as the agent stopping on its own despite not satisfying the hidden verifier** — in your product a false finish does not cost a retry, it ships a broken app to a paying customer. Third, **the held-out collapse is the whole ballgame**: CAISI measured 74% on public SWE-bench Verified and 44% on held-out PortBench, a −30pp drop where GPT-5.5 dropped −3pp, and every ticket you receive is novel work. Add that DeepSeek has **no pacing primitive at all** for a workload whose two published failure modes are timeouts and false finishes, and that it is **absent from the one independent board closest to your task**, and the answer is: not in the orchestrator seat under any configuration; in a subagent seat only behind a gate it cannot see, and only after §7.

---

## 4. COST IF YOU SWITCH

### 4.1 Method

Token budget per ticket, from the existing cost model: **47.5M input / 2.5M output**, split **Opus-5 seat 9.0M / 0.55M** and **subagent seat 38.5M / 1.95M**. Cache split **85% read / 10% write / 5% fresh** throughout.

> **Footnote that cuts in the alternatives' favour.** Every non-Claude figure below holds the *Claude* token count fixed. Anthropic's own docs state its 4.7+ tokenizer *"produces approximately 30% more tokens for the same text"* than earlier Claude models. That note compares Claude to Claude, not Claude to Moonshot — but if the effect carries across vendors at all, the real per-ticket cost of Kimi, GLM, MiniMax and DeepSeek is up to **~23% lower** than shown. **These tables are conservative against the alternatives, not for them.** `[uncertain]` — nobody has measured tokens-per-identical-source-text across these vendors, and §7 must.

### 4.2 Per-seat cost

| Seat | Model | Cache reads | Cache writes | Fresh in | Output | **$/ticket** |
|---|---|---:|---:|---:|---:|---:|
| Orchestrator (9.0M / 0.55M) | **Claude Opus 5** | $3.83 | $5.63 | $2.25 | $13.75 | **$25.45** |
| Orchestrator | Kimi K3 — **cached** `[uncertain]` | $2.30 | (no write charge documented) | $4.05 | $8.25 | **$14.60** |
| Orchestrator | Kimi K3 — **zero cache hits** | — | — | $27.00 | $8.25 | **$35.25** |
| Orchestrator | DeepSeek V4 Pro | $0.03 | — | $0.59 | $0.48 | **$1.09** |
| Subagent (38.5M / 1.95M) | **Claude Sonnet 5 (intro)** | $6.55 | $9.63 | $3.85 | $19.50 | **$39.52** |
| Subagent | **Claude Sonnet 5 (from 2026-09-01)** | $9.82 | $14.44 | $5.78 | $29.25 | **$59.28** |
| Subagent | Kimi K3 | $9.82 | — | $17.33 | $29.25 | **$56.39** |
| Subagent | GLM-5.2 | $8.51 | — | $8.09 | $8.58 | **$25.17** |
| Subagent | Kimi K2.7-code | $6.22 | — | $5.49 | $7.80 | **$19.51** |
| Subagent | MiniMax M3 | $1.96 | — | $1.73 | $2.34 | **$6.04** |
| Subagent | DeepSeek V4 Pro | $0.12 | — | $2.51 | $1.70 | **$4.33** |
| Subagent | DeepSeek V4 Flash | $0.09 | — | $0.81 | $0.55 | **$1.45** |

### 4.3 Full-ticket configurations vs the baseline

| Config | $/ticket (Sonnet intro) | vs baseline | $/ticket (post-2026-09-01) | What you give up |
|---|---:|---:|---:|---|
| **A — BASELINE: Opus 5 + Sonnet 5** | **$64.97** | — | **$84.73** | — |
| B — Opus 5 + **Kimi K3** subagent | $81.84 | **+26% WORSE** | $81.84 (−3%) | Independent coding score drops from 74.6% (tbench, Claude Code) to 80.90% on a *different* board with undisclosed effort. **Not a saving.** |
| C — **Kimi K3** orchestrator + Sonnet 5 — *cache holds* `[uncertain]` | $54.12 | −17% | $73.88 (−13%) | 1540 vs 1606 AA-Briefcase Elo; **no `task_budget` analogue**; cache TTL and write charge both undocumented |
| C′ — **Kimi K3** orchestrator, **zero cache hits** | $74.77 | **+15% WORSE** | $94.53 (+12%) | This is the downside case to plan against |
| D — Opus 5 + **GLM-5.2** subagent | $50.62 | −22% | $50.62 (−40%) | The GLM family's only independent board score is **GLM-5.1 at 58.7%, 15.9pp below Sonnet 5 in the identical harness**. GLM-5.2's 81.0 is self-reported and the model has never appeared on the board. Worst cache-read discount in the field (0.186×). |
| E — Opus 5 + **DeepSeek V4 Pro** subagent (sticker) | $29.78 | −54% | $29.78 (−65%) | see §3 |
| E′ — Config E with **measured 3.34× token burn** applied to the DeepSeek seat | **$39.91** | −39% | −53% | The 3.34× is measured directly (14.45M vs 4.32M tok/task, LHTB) but is **GPT-relative, not Claude-relative** `[uncertain]`. **E′ and F′ are probably optimistic for DeepSeek:** the multiplier is applied proportionally across cache-read, cache-miss and output, but DeepSeek output ($0.87) is 2× its cache-miss input ($0.435), and a model burning 3.3× the tokens while failing is disproportionately burning *output* — retries and thinking, not prefix re-reads |
| F — **all-DeepSeek V4 Pro** (sticker) | $5.42 | −92% | −94% | Orchestrator seat filled by a model with 94% hallucination, no pacing primitive, and a −30pp held-out collapse. **Do not.** |
| F′ — Config F with 3.34× token burn | **$18.10** | −72% | −79% | as above |

### 4.4 Break-even — the number that decides each one

The existing model applies a **1.3× wastage factor**, so the baseline's effective cost is **$84.46** (intro) / **$110.15** (post-Sep). An alternative only saves money if its own wastage multiplier stays below:

| Config | Clean $/ticket | Break-even wastage multiplier vs baseline-effective | Implied convergence rate at break-even |
|---|---:|---:|---:|
| C (K3 orchestrator, cached) | $54.12 | **1.56×** | 64% (from ~77%) |
| D (Opus 5 + GLM-5.2) | $50.62 | **1.67×** | 60% |
| E′ (Opus 5 + DeepSeek, token-adjusted) | $39.91 | **2.12×** | 47% |
| F′ (all-DeepSeek, token-adjusted) | $18.10 | **4.67×** | 21% |

**Read this honestly: the cheap configurations have wide break-evens and might well clear them.** That is exactly why the argument against them in §3.5 is a quality and throughput argument, not a cost argument. It is also why §7 is not optional — the break-even is an empirical question about *your* pipeline that no leaderboard answers.

### 4.5 Monthly

Budgeted = clean × 1.3 wastage + ~$1/ticket non-token (web search at $10/1,000 searches; sandbox runtime at $0.08/session-hour).

| Tickets/mo | **A baseline, intro** | **A baseline, post-Sep** | C (K3 orch, cached) | D (Opus 5 + GLM-5.2) | E′ (Opus 5 + DeepSeek, adj.) |
|---:|---:|---:|---:|---:|---:|
| 20 | **$1,709** | **$2,223** | $1,427 | $1,336 | $1,058 |
| 30 | **$2,564** | **$3,335** | $2,141 | $2,004 | $1,587 |
| 50 | **$4,273** | **$5,558** | $3,568 | $3,340 | $2,645 |

**Reconciling the owner's own stated numbers, since these are the first figures he will check.** The stated "$65–75 clean" is the intro-rate baseline: **$64.97**. The stated "$112–140 effective" brackets from below at **$111.15** — that is post-2026-09-01 pricing ($84.73) at the existing 1.3× wastage factor plus ~$1 of non-token cost. The $140 top of that band implies a wastage factor closer to **1.6×** (a ~62% first-run convergence rate), which the packet's own evidence makes entirely plausible: METR found roughly half of test-passing SWE-bench Verified PRs would not be merged by maintainers. On monthly spend, the post-Sep budgeted row lands at **$2,223–$5,558** against the stated $2,300–7,100; the upper end is reached inside the ±2× confidence interval on the token estimate. **The 47.5M token figure is modelled, not measured** — it is anchored on LHTB's 9.9M tokens per ~89-minute task — and it is the single largest source of error in every figure above. §7 fixes that.

### 4.6 The lever that beats all of them

| Cache hit rate | $/ticket (baseline, intro) | vs 85% |
|---:|---:|---:|
| 0% | **$155** | +138% |
| 50% | **$108** | +66% |
| **85% (target)** | **$65** | — |

**Getting caching right is worth more than every model swap in §4.3 except the DeepSeek ones — and it does not cost you a single point of measured capability.** Two structural bonuses: a 5-minute cache write at 1.25× pays for itself after one read, and **cache reads do not count toward ITPM limits** (Anthropic's own example: a 2,000,000 ITPM limit at an 80% hit rate effectively processes 10,000,000 input tokens/minute). The one line of code that silently destroys it: decrementing `task_budget.remaining` on every follow-up request, which changes the cached prefix.

---

## 5. WHAT ACTUALLY BUYS QUALITY

**Lead with the single fact that settles the framing: on AA-Briefcase, Claude Opus 5 at `effort: low` scores 1223 — *below* GLM-5.2 at `max` (1254).** A misconfigured frontier model loses to a mid-tier open model while costing several times more. Model choice is not the top of this list. It is fifth.

| Rank | Intervention | Measured effect | Source | Eng. cost | Model-independent? |
|---:|---|---|---|---|---|
| **1** | **Generate a correct, machine-checkable acceptance spec BEFORE implementation — and detect bad specs** | **+26.3pp** (68.0% → 94.3%, SWE-bench Verified) | TDFlow, arXiv 2510.23761 (EACL 2026) | HIGH | **YES** |
| **2** | **Architecture that never lets one agent's context grow** (subagent isolation, bounded windows) | **avoids up to −81.3pp** (Claude-4.5-Opus 96.0% @8K → 14.7% @256K) | LOCA-bench, arXiv 2602.07962 | HIGH (structural) | **YES** |
| **3** | **Sealed environment + held-out acceptance gate the builder never sees** | **14.1–20.7pp** of apparent quality is leakage; reward-hacking gap grows **~27pp per 10× LOC**, reaching **100pp above 25K LOC** | Cursor (2026-06-25); SpecBench arXiv 2605.21384 | MEDIUM | **YES** |
| **4** | **Reasoning effort set to `xhigh`** | **250 Elo** medium→max, **497 Elo** low→max — vs **146 Elo** between the #1 and #2 models on the same board | AA-Briefcase | **TRIVIAL** | Partly (per-provider ladders) |
| **5** | **Model choice** | **11.24pp** across frontier models (Vals AI); **4.87pp** best-frontier vs best open-weight; **180 Elo** K3 vs Opus 5 on AA-Briefcase | Vals AI; AA-Briefcase | LOW to switch | n/a |
| **6** | Retries / best-of-N, **capped at 3–5**, scored only on held-out gates | best@k plateaus ~k=16; pass@40 = 80.4% is **oracle-only**; majority-vote = 58.4%. Extra search does **not** reduce reward hacking | CWM arXiv 2510.02387; SpecBench | LOW (HIGH for the selector) | **YES** |
| **7** | Harness / scaffolding investment | **0 to +5.1pp**, and only when harness and model share a vendor. Gemini CLI vs Terminus 2 = +0.2pp (null); generic Terminus 2 **beats** Gemini's own CLI by 8.1pp on Gemini 3 Pro | tbench.ai (publishes CIs) | HIGH | **NO** |
| **8** | **Programmatic tool calling** | **+9.4 to +13.3pp** — the only context technique positive and large across all three models tested | LOCA-bench | MEDIUM | **YES** |
| 8b | Compaction / memory files | **−2.7 to +2.7pp** (compaction); −2.7 to +9.4pp (memory). **Sign flips by model.** | LOCA-bench | MEDIUM | **NO** |
| 9 | Model-specific prompt tuning | **UNMEASURED for agentic coding.** Analogous small-model transfer losses of 10.9–15.7pp | prompt-optimisation literature | RECURRING (paid again on every switch) | **NO** |
| — | Prompt caching | **~59% of the bill.** Zero measured effect on output quality — a cost lever, listed for completeness | Anthropic pricing docs | LOW | NO |

**Units are not comparable across rows.** Rows 1, 2, 3, 7, 8 are percentage points on task completion; row 4 and part of row 5 are Elo on a different benchmark. Do not add them.

### 5.1 Caveats that keep this table honest

- **Rank 1's headline is a post-hoc subset.** The 93.3% figure is the solve rate on runs where the generated tests *happened* to have a 0% Bad Test Rate. TDFlow does not show an agent can reliably *achieve* BTR=0; the unconditional LLM-generated-test result is 68.0%. So: **26.3pp is the size of the prize, 93.3% proves the prize is reachable in principle, and building the bad-test detector is unsolved work, not a config change.** Also: TDFlow was validated on SWE-bench — bug-fixing in an existing repo against a stated issue — while your product is **greenfield with no reference implementation to constrain the spec**. SpecBench's 100pp gap above 25K LOC suggests greenfield is *harder*, not easier.
- **Rank 2 used previous-generation models** (Claude-4.5-Opus, GPT-5.2, Gemini-3-Flash, DeepSeek-V3.2). Read −81.3pp as the scale of the risk, not a prediction for Opus 5. The structural point survives regardless: LHTB measured **9.9M tokens per task**, which is ~38× the 256K point where degradation was catastrophic.
- **Rank 3's Cursor data is a vendor blog** — but adversarial against itself: Cursor's own Composer 2.5 dropped **more** (−20.7pp) than Anthropic's Opus 4.8 Max (−14.1pp). That is the signature of an honest measurement. The auditing result is the one to remember: **63% of successful resolutions retrieved the fix rather than derived it** (57% upstream lookup, 9% git-history mining).
- **Rank 4's cost curve argues for `xhigh`, not `max`.** Opus 5: high 1606 @ $10.41/task → xhigh 1693 @ $14.26 → max 1720 @ $17.79. The last step buys **+27 Elo for +25% cost** — the worst marginal return on the curve. Anthropic's own guidance for Opus 5 is *"Start with `high`, the default"*, a change from Opus 4.7/4.8.
- **The packet's "33% → 38% retry-cheating" claim could not be located.** Stop quoting it. The supported substitute is SpecBench: *"additional search does not reliably remove reward hacking,"* with 90th-percentile gaps often **growing** as search proceeds.

### 5.2 The one paragraph to act on

Spend the next month on ranks 1–3 and make the rank-4 config change today. The gap you would close by swapping models is **4.87pp**. The gap you would close with a working held-out acceptance gate is **14–21pp of real versus apparent quality**, and with a good generated spec, **26.3pp**. Until held-out pass rate is instrumented you cannot even measure whether a model swap helped — which is the real reason the model question keeps reopening.

---

## 6. THE HARNESS DECISION

**Recommendation: stay on the Claude Agent SDK. Use Anthropic Managed Agents for the hosted sandbox unless a customer commitment requires Zero Data Retention. Spend one day standing up OpenCode as a proven hedge, then leave it alone.**

### 6.1 "Open claw" — resolved

**OpenClaw** (`github.com/openclaw/openclaw`, MIT, 384,309 stars, created 2025-11-24, pushed 2026-07-27) is *"Your own personal AI assistant. Any OS. Any Platform."* — a messaging-channel assistant connecting WhatsApp, Telegram, Discord and Slack, with voice and a live Canvas. It is **explicitly not a coding agent** and is a dead end for this product. Its 384k stars make it the most-starred repo in the space, which is almost certainly why it surfaced.

### 6.2 The options, scored

| Option | Licence | Embeddable? | Model-agnostic? | Independent harness score | Verdict |
|---|---|---|---|---|---|
| **Claude Agent SDK** | **Proprietary** — npm declares `"SEE LICENSE IN README.md"`; governed by Anthropic Commercial ToS | Yes — subagents, hooks (`PreToolUse`/`PostToolUse`/`Stop`), MCP, permissions, `resume`/`forkSession`, `maxTurns`, `env` injection, and a `Monitor` tool for watching long test runs | In practice no | **Claude Code + Fable 5 = 83.8% ±1.2, rank 1 on TB2.1** | **RECOMMENDED** |
| **Anthropic Managed Agents** | — | Hosted harness + managed or self-hosted sandbox, SSE streaming, mid-run steering, scheduled deployments | — | — | **USE IT** for the sandbox — **$0.08/session-hour**, which Anthropic's own worked example puts at **11–15% of a 1-hour Opus 5 session**. **Disqualifier if it applies: not eligible for ZDR or a HIPAA BAA** (stateful by design) |
| **OpenCode** (`sst/opencode`) | **MIT**, 190,150 stars, released daily | **Best in class** — `opencode serve`, OpenAPI 3.1, typed `@opencode-ai/sdk`; the TUI is itself a client of the server | 75+ providers + any OpenAI-compatible `baseURL`; **per-agent `model` override** makes an orchestrator/subagent split a config change; `steps` cap per agent | — | **THE HEDGE.** Only harness where per-provider prompt-cache breakpoint insertion was verified from source (`provider/transform.ts` `applyCaching()`) |
| **Cline SDK** | Apache-2.0, 65,097 stars | Yes — `@cline/sdk`, the same engine behind the CLI and extensions; subagents, permission hooks, checkpoints | Yes, incl. `openai-compatible` with `baseUrl` | — | Closest structural analogue to the Agent SDK; younger as an SDK. Whether it inserts cache breakpoints is unverified `[uncertain]` |
| **OpenHands Software Agent SDK** | MIT, but the SDK repo is 933 stars | Yes, Python | Yes | — | Pick this **only** if the stack is Python or Docker/K8s sandbox orchestration is the dominant concern |
| **Codex CLI** | Apache-2.0, 101,814 stars | Yes, TS + Python SDK | **No — OpenAI-locked** | Codex + GPT-5.5 = 83.1% ±1.1, rank 2 | Excellent harness, wrong direction |
| **Goose** | Apache-2.0, 51,791 stars | **Shell-out only** — `goose serve` exposes `/status` and `/acp` for the desktop UI; *"No REST API endpoints, SDK, or programmatic driver documentation is provided"* | 15+ providers | — | Workable, weaker |
| **Crush** (Charm) | **FSL-1.1-MIT** | — | — | — | **HARD LEGAL GATE — DO NOT BUILD ON IT.** Competing Use bars *"making the Software available to others in a commercial product or service that … offers the same or substantially similar functionality."* That is precisely this product. |
| Aider / Roo Code | Apache-2.0 | — | — | — | **Stale** — last pushed 2026-05-22 and 2026-05-15 while every serious competitor pushed today |
| SWE-agent | MIT | Yes | Yes | mini-SWE-agent + Muse Spark 1.1 = 76.2% | Officially **maintenance-only**; wrong task shape (issue → patch) |

### 6.3 Why not re-platform

Your cost problem is a **model-price** problem, not a harness problem, and re-engineering the harness cannot fix a model-price problem. The measured harness delta is **0 to +5.1pp and only when harness and model share a vendor** — and it *reverses* for Gemini, where generic Terminus 2 beats Google's own CLI by 8.1 points. Meanwhile the Agent SDK already ships every item on the checklist and holds the top independent score.

### 6.4 The switch condition — and a legal task to start now

**Switch to OpenCode if either fires:**
1. Anthropic answers **"no" in writing** to: *may we use the Claude Agent SDK with `ANTHROPIC_BASE_URL` pointed at a non-Anthropic model endpoint, in a commercial product?*
2. You commit to a second model vendor in production.

**Start (1) this week, before a bake-off result can lock you in.** The situation is genuinely unresolved `[uncertain]`: Anthropic's gateway page states *"Anthropic doesn't endorse, maintain, or audit third-party gateway products, and doesn't support routing Claude Code to non-Claude models through any gateway"* — a **support** statement, not a prohibition. Commercial ToS §D.4 bars using the Services to build a competing product but says nothing about third-party model endpoints. And the SDK is proprietary. Two features are documented to silently degrade against a non-first-party host: **MCP tool search is disabled by default** (needs `ENABLE_TOOL_SEARCH=true` and a proxy that forwards `tool_reference` blocks) and **Remote Control is disabled as of v2.1.196**.

**Mechanically the swap is two environment variables**, which is what makes §7 cheap: DeepSeek publishes an Anthropic-format endpoint at `https://api.deepseek.com/anthropic` and maps `claude-opus*` → `deepseek-v4-pro`, `claude-sonnet*`/`claude-haiku*` → `deepseek-v4-flash`; Moonshot publishes `https://api.moonshot.ai/anthropic` with `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL`. Your orchestrator/subagent split transfers with zero code changes.

**Confirmed, not re-litigated:** the Agent SDK overview states verbatim *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* Pay-as-you-go remains the only sanctioned route.

---

## 7. THE BAKE-OFF PROTOCOL

**Goal: replace every modelled number in this document with a measured one from your own tickets, in one week, for roughly $2,000.** No published board contains Opus 5, Sonnet 5, Kimi K3 and DeepSeek V4 together on a long-horizon coding task. The comparison you need does not exist in public and cannot be bought.

### 7.1 Reference tickets — six, frozen

| # | Tier | Example | Why it is in the set |
|---|---|---|---|
| 1–2 | Trivial | portfolio site; one-page marketing site | Establishes the floor; catches harness bugs cheaply |
| 3–4 | Medium | CRUD app with auth; internal dashboard with a data model | The modal ticket |
| 5–6 | Hard | "build me a golf app" — data model + external API + persisted state + tests | The ticket the product is sold on |

Freeze the ticket text verbatim. **Never edit it between runs.** Store a hash.

### 7.2 Configurations — four

| ID | Orchestrator | Subagent | Why it is in the bake-off |
|---|---|---|---|
| **A** | Claude Opus 5 `high` | Claude Sonnet 5 `medium` | Baseline |
| **B** | Claude Opus 5 `high` | **DeepSeek V4 Pro** `reasoning_effort: max` | The only order-of-magnitude cost lever that exists |
| **C** | **Kimi K3** `high` | Claude Sonnet 5 `medium` | The only orchestrator-seat saving in the packet; also the **only way to measure Moonshot's undocumented cache TTL** |
| **D** | DeepSeek V4 Pro | DeepSeek V4 Pro | The floor. Include it to bound the question, expect it to fail. |

### 7.3 Six variables held constant — non-negotiable

Five of these come from the measurement-integrity finding that Artificial Analysis and Vals AI both run Terminal-Bench 2.1 on a Terminus 2 harness and **differ by ~4pp** — which is larger than the model gap you are trying to detect. The sixth is mine.

1. **Reasoning effort** — fixed per run and **recorded**. Effort alone is worth 250–497 Elo. An unrecorded effort setting makes the whole experiment uninterpretable.
2. **Harness** — one harness, yours, for every config. Do not compare Claude Code against a DeepSeek-native runner.
3. **Sandbox image and network isolation policy** — identical, and sealed: no egress to upstream repos, no package registry except a pinned mirror, no issue trackers. Cursor measured **14.1–20.7pp** evaporating when exactly this was sealed.
4. **Repeat count** — same for every config. Start at 1 for the screen, 3 for the finalists.
5. **The held-out acceptance suite** — see §7.4.
6. **Token accounting is per-vendor and never compared across vendors.** Tokenizers differ; a Claude token is not a Moonshot token. **Compare dollars and outcomes only.** Record raw `input`/`cache_read`/`cache_write`/`output` counts per vendor separately — this is how you measure Moonshot's cache TTL and DeepSeek's best-effort hit rate, which are the two undocumented facts that decide Config C and half of Config B.

### 7.4 The held-out gate

- The acceptance suite is written **once per ticket**, by a **separate Claude Opus 5 `xhigh` agent** from the ticket text alone, **before any build run**, with no access to any implementation.
- It is **hashed and frozen**. No builder in any config can read it, list it, or modify it.
- It executes in a **clean container** with no network and no access to the build agent's workspace history.
- Run a **bad-test audit** on it before use: a separate adversarial pass whose only job is to find tests that are vacuous, tautological, mis-specified or trivially satisfiable. TDFlow's entire 26.3pp effect lives here. If a suite fails the audit, regenerate it — do **not** start builds against it.
- **The agent's self-report is recorded but never scores anything.**

> **The gate is a held-constant control, not a config under test.** Every configuration — including Config D, all-DeepSeek — builds against an acceptance suite authored by Claude Opus 5 at `xhigh`. That is deliberate: it isolates the builder variable. **It also means Config D's result is not a costed all-DeepSeek product configuration** — a real all-DeepSeek product would have DeepSeek writing its own acceptance suites, which given a 94% hallucination rate is a materially worse proposition than what Config D measures. Do not let a good Config D number be read as "all-DeepSeek works."

### 7.5 Metrics

**Co-primary — both, neither alone:**

| Metric | Definition |
|---|---|
| **Held-out pass rate** | Fraction of runs where the frozen suite goes green in the clean container |
| **False-finish rate** | Fraction of runs where the agent **declared done** AND the held-out suite failed. LHTB measures this mode at **19% of unresolved runs**; in your product it is the failure that ships a broken app to a paying customer |

**Secondary:** timeout / non-termination rate; wall-clock; `BLOCKED` rate; **measured cache-hit token fraction per vendor**; $ per attempt.
**Derived, not primary:** $ per held-out pass.

### 7.6 Decision rule — write it down before you run anything

Switch away from Config A **only if all three hold**:
1. The alternative's held-out pass rate is **within one standard error** of baseline;
2. Its **$ per held-out pass is ≥30% lower**;
3. Its **false-finish rate is not higher** than baseline.

Otherwise **the question is closed for 90 days** or until a §9 trigger fires. Commit to this rule before seeing results.

### 7.7 Cost

| Phase | Runs | Estimate |
|---|---:|---:|
| Screen: 4 configs × 6 tickets × 1 run | 24 | A $390 + B $240 + C $325 + D $109 ≈ **$1,064** |
| Finals: top 2 configs × 2 hardest tickets × 3 repeats | 12 | ≈ **$700** |
| Failed/aborted runs, spec regeneration, contingency | — | ≈ **$300** |
| **Total** | **36** | **≈ $2,100** |

That is roughly **one month of the baseline at 20–25 tickets**, and it produces evidence strictly better than anything published. If the budget is tighter, cut ticket scope to roughly a third and the total falls to ~$700 — at the cost of testing the long-horizon regime that is the whole point. Do **not** economise by dropping the repeat count on the finalists: a single run on 46-task benchmarks is exactly the noise problem that makes every open-weight cost figure in §4 unreliable.

### 7.8 Two guardrails during the bake-off

- **Enforce a hard per-run dollar and token ceiling with a kill switch, out-of-process.** `task_budget` is *advisory* — Anthropic's own docs: *"Claude may occasionally exceed the budget if it is in the middle of an action."* Anthropic's Start tier is a **$500/month spend cap** and *"API usage pauses until the next month"*; at ~$85–124/ticket, one runaway loop exhausts a month. **Request a limit increase before you start.**
- **Do not build "the agent seems stuck" heuristics.** LHTB found 79% of unresolved runs time out **while still actively making progress** — heuristic stuck-detection would kill runs that were converging. Terminate on a **budget boundary**, never on a guess. These two guardrails are not in tension; one is a hard ceiling, the other is a ban on soft ones.

---

## 8. HONEST CEILING

**Quality cannot be guaranteed today, and the limit is verifier reliability, not model rank.**

### 8.1 The evidence, unsoftened

| Finding | Number | Source type |
|---|---|---|
| Best model on ~90-minute autonomous terminal tasks | **28.3% pass@1** (Grok 4.5, 13 of 46 tasks — **a model this document never priced; see §2.5**) | INDEPENDENT academic (LHTB) |
| Table average across the evaluated models | **6.4%** at R≥0.95; **3.2%** at R=1.0 | INDEPENDENT |
| Tasks never passed by **any** model | **29 of 46** | INDEPENDENT |
| Runs earning **exactly zero** reward | **9.2%** | INDEPENDENT |
| Unresolved runs that **time out while still actively working** | **79%** | INDEPENDENT |
| Unresolved runs where the agent **stops on its own without satisfying the hidden verifier** | **19%** | INDEPENDENT |
| Reward-hacking gap vs task size | **+~27pp per 10× LOC; 100pp above 25K LOC** | INDEPENDENT (SpecBench) |
| Successful SWE-bench Pro resolutions that **retrieved** rather than derived the fix | **63%** of 731 audited Opus 4.8 Max trajectories | Vendor blog, adversarial against itself (Cursor) |
| Test-passing SWE-bench Verified PRs a maintainer **would not merge** | roughly **half**; merge rate ~**24pp below** grader score | INDEPENDENT (METR) — *caveat: 1–2 model generations old* |

> **Source-defect warning, stated rather than smoothed.** The 79% and 19% figures are rounded, sum to 101%, and share a 660-run denominator that does not reconcile with the leaderboard's headline run count. Treat the split as directionally sound and **never quote 782, 17/18 models and 660 in the same sentence.** Separately, the LHTB abstract and results table disagree on model count and mean pass rate; cite the **v2 results table** for per-model figures and note the inconsistency.

**On the size of the open-weight cost win: argue from tokens, not from cost-per-success.** 6.5% of 46 tasks is *three tasks*; 15.2% is *seven*. Any cost-per-completed-task figure derived from that difference is a four-task artefact with no published confidence interval. The robust measurement is the token ratio — **14.45M (DeepSeek V4 Pro) and 20.20M (MiniMax M3) against 4.32M (GPT-5.6-sol)** — which is measured directly and does not depend on the pass rate at all.

### 8.2 The structural argument

*The Verification Horizon* (arXiv 2606.26300) argues the classical intuition that verifying is easier than producing **"is being inverted"** for today's coding agents, that **"every verifier we can build is only a proxy for human intent, never the intent itself,"** and that **"no fixed reward function can remain effective as policy capability continues to grow; verification must co-evolve with the generator."** Combined with SpecBench's finding that visible-test scores are *"nearly saturated"* while held-out scores *"diverge sharply,"* the conclusion is: **for a full app build, "the tests are green" carries close to zero information about real quality.**

There is **no published independent evidence that any model reliably completes a multi-hour, unattended, greenfield application build.** The closest real-world report (EPAM, six-week multi-agent experiment) grew to 5-hour runs and solved it by *"run overnight and review in the morning"* — and **that morning review is exactly the checkpoint this product removes.** Anthropic's own anecdotes (a Retro Game Maker in 6 hours at $200 on Opus 4.5; a DAW in 3h50 at $124.70 on Opus 4.6) are vendor self-reported single runs with no success rate and no independent verification — though note their costs bracket the modelled per-ticket figure closely, which is mild corroboration of the cost model and none at all of the reliability claim.

### 8.3 What "guaranteed quality" can and cannot mean

**It cannot mean** a completion guarantee. Do not sell one, do not design toward one, and do not let a marketing page imply one.

**It can mean, and this is worth building:**

1. **A published held-out pass rate per ticket category** — the fraction of tickets passing an acceptance suite the builder never saw and could not modify. This is the only quality figure that reward hacking cannot inflate, and it is the metric the entire product feedback loop should be built around.
2. **`BLOCKED` as a first-class outcome.** LHTB found **62.8% of runs earn partial credit that binary grading discards.** Shipping partial progress with an honest status beats shipping a confident false finish, and it beats shipping nothing.
3. **Checkpoint and resume**, so a wall-clock or budget boundary costs a resume rather than the whole run.
4. **A hard per-run dollar/token ceiling and kill switch, enforced out-of-process**, plus human review for everything below the published threshold.
5. **AI disclosure**, which is a build requirement not a nicety — Anthropic's Usage Policy: *"All consumer-facing chatbots, including any external-facing or interactive AI agent, must disclose to users that they are interacting with AI rather than a human."*

---

## 9. REOPEN TRIGGERS

The model question is closed. Reopen it only when one of these fires — not on a schedule, not on a new tier list, not on a launch blog.

| # | Trigger | Currently |
|---:|---|---|
| 1 | A DeepSeek model appears on **tbench.ai Terminal-Bench 2.1 at ≥70%** | absent (all 17 rows checked) |
| 2 | A **V4-generation** DeepSeek appears on **Scale SWE-bench Pro above ~45%** | absent; V3.2 = 15.56% |
| 3 | **Kimi K3 or a successor appears on tbench.ai** with a staff-verified coding score, **or Moonshot documents a cache TTL and cache-write charge** | absent; both undocumented |
| 4 | Your §7 bake-off satisfies the §7.6 decision rule | unmeasured |
| 5 | Anthropic answers **"no" in writing** on non-Claude routing through the Agent SDK | unasked — **do this this week** |
| 6 | **METR publishes a pre-deployment evaluation of Claude Opus 5**, or of any candidate | none exists for any Claude model, Kimi K3, DeepSeek V4, GLM-5.2 or Gemini 3.1 Pro. **Absence of published findings is not evidence of good behaviour** — GPT-5.6 Sol looks worst partly because it is the only current model anyone independently tested for this |
| 7 | Sonnet 5's 2026-09-01 price rise lands and a measured effort sweep shows `medium` failing | ~5 weeks away; budget at $3/$15 from now |
| 8 | **Grok 4.5's price, caching mechanism, pacing primitive and ToS are retrieved** — and it then clears the §7.6 decision rule | **Unresearched.** It leads LHTB at 28.3% on 8.91M tokens/task. Four fetches. **Do this before the next model conversation** — see §2.5 |

### 9.1 The single highest-value follow-up

**Read the Vals AI Terminal-Bench 2.1 table body in a real browser session** (Skyvern or Playwright — it renders client-side and defeated WebFetch across multiple attempts by multiple researchers). The page carries vendor categories for Alibaba, Anthropic, DeepSeek, Google, Meta, MiniMax, Mistral, Moonshot, NVIDIA, OpenAI and zAI, **plus a per-model "Cost / Test" column**. There are very probably independent Terminal-Bench 2.1 scores *and measured cost-per-task figures* for DeepSeek V4 Pro, GLM-5.2, MiniMax M3 and Qwen sitting on that page that nobody in this research programme has read. **That one table would settle most of the open-weight question on measured rather than inferred evidence, for the cost of one browser session.** Do it before §7.

---

## 10. ONE-PAGE SUMMARY

| Question | Answer |
|---|---|
| Orchestrator | **Claude Opus 5 at `high`**; Spec Architect and Adversarial Reviewer split out as separate agents at `xhigh` |
| Subagents | **Claude Sonnet 5 at `medium`**; budget at $3/$15 from 2026-09-01 |
| Non-code mechanical work | Haiku 4.5 — log triage, failure classification, report formatting only. **Never code** (Feb-2025 cutoff) |
| Does DeepSeek displace either? | **No.** 6.5% on LHTB at 3.34× the token burn; −30pp public-to-held-out where GPT-5.5 lost 3pp; 94% hallucination; no pacing primitive; absent from tbench.ai. Viable **only** as a gated subagent, after §7 |
| Does Kimi K3 displace either? | **No in the subagent seat — on price alone** ($3/$0.30/$15 = Sonnet 5 post-September, worse than Sonnet 5 today). **Unproven in the orchestrator seat**: $14.60/ticket cached vs Opus 5's $25.45, but **$35.25 uncached**, and Moonshot documents neither a cache TTL nor a cache-write charge |
| GLM / MiniMax / Qwen? | GLM: its only independent score is **58.7%, 15.9pp below Sonnet 5 in the identical harness**. MiniMax: **ToS unretrievable after six attempts — blocked, not rejected**. Qwen: pricing is aggregator-sourced and terms are unchecked |
| Harness | **Claude Agent SDK + Managed Agents.** OpenCode as a one-day proven hedge. Crush is legally barred. "Open claw" is a messaging assistant, not a coding agent |
| Biggest cost lever | **Prompt caching (~59% of the bill), then ticket volume.** Not model choice |
| Biggest quality lever | **A correct machine-checkable spec (+26.3pp), then context architecture, then a sealed held-out gate.** Model choice is fifth |
| Free win available today | **Set reasoning effort to `xhigh`, not `max` and not `medium`.** Opus 5 at `low` (1223 Elo) scores below GLM-5.2 at `max` (1254) |
| Can quality be guaranteed? | **No.** Best measured long-horizon result is 28.3%; 29 of 46 tasks were never solved by any model. Design toward a **published held-out pass rate**, `BLOCKED` as a first-class outcome, and human review below threshold |