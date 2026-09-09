---
document_status: research
written: 2026-09-04
scope: 30 profiled systems, each carrying a results lens and a mechanism lens, plus a measured reading of this repository's own run history and stored artefacts
question: can this pipeline learn from its own results (branch A), or from the owner's taste judgements (branch B), without fine-tuning
---

# A learning loop for this pipeline: branch A against branch B

## 1. Headline

**Branch A, the autonomous loop, has still not been done anywhere with verified evidence, and at our run volume it cannot be shown to work or to fail. Branch B, the owner as judge, has been done, but only ever to improve an evaluator, never once to improve a generator. Build branch B anyway, because it is the only one of the two whose claims we can test, and start by spending fifteen minutes proving there is a taste gap at all.**

Three things came out of this round that were not known when the question was asked.

**The metric everyone has been reasoning about has the wrong denominator.** The brief for this study, and every prior document, treats the pipeline's success rate as 5 of 30 runs. Queried directly against `dashboard/data/runs.db`, the co-primary metric `held_out_pass` is set in only 16 of the 30 rows. Fourteen runs never reached a gate verdict at all, so they are not trials on this metric; they are a different failure that `heldOutPass` cannot see at any sample size.

| Quantity | Value | Basis |
|---|---|---|
| Runs in total history | 30 | measured, `dashboard/data/runs.db` |
| `status` breakdown | 19 failed, 6 cancelled, 5 passed | measured |
| `held_out_pass = 1` | 7 | measured |
| `held_out_pass = 0` | 9 | measured |
| `held_out_pass IS NULL` | 14 | measured |
| Real heldOutPass rate | 7/16 = 43.75% | computed from measured |
| Wilson 95% interval on that rate | [23.1%, 66.8%] | computed from measured |
| Minimum detectable effect at 16 runs per arm | +42.4pp, candidate must reach 86.1% | computed from measured |

A 44 point interval on the primary metric, and an experiment that can only see a near-doubling, is not a measurement problem to be improved. It is the reason branch A cannot be validated here.

**The second co-primary metric carries no independent information.** Among the 16 gated runs, `false_finish` is exactly `agentDeclaredDone AND NOT heldOutPass`, and 14 of the 16 declared done. The crosstab is (hop=0, ff=1, declared=1) seven times, (hop=1, ff=0, declared=1) seven times, (hop=0, ff=0, declared=0) twice. There is no alpha split to pay for two endpoints, and equally no second endpoint to appeal to when the first is uninformative.

**The axis the owner is complaining about is structurally unmeasured.** Of the 342 acceptance criteria across all 30 runs, the words `palette`, `typograph`, `hierarch`, `composition`, `font`, `spacing` and `grid` appear zero times each. Seven criteria mention `colour`, one mentions `contrast`, four mention `whitespace`, and every one of those is a mechanical threshold. `dashboard/server/src/taste-policy.ts` defines seven taste categories and twenty-one finding codes with no typography category and no colour category, and the critic rejects unknown codes at parse time. Separately, `chosenDirectionBy` in the design lane reads `ui-designer` nine times, `fallback` three times and null twice. It has never once read `owner`. The seat the owner is unhappy with has never received his input, and the vocabulary in which he would express a complaint does not exist yet.

**What to build, in one line:** an owner pairwise-preference store feeding the design lane and the taste critic, behind one flag, with a withheld-rule negative control on every rule before it is kept, and with no aggregate-rate promotion path anywhere near it.

**What to do first, before building anything:** twenty-four winner-versus-loser design direction pairs are already on disk from past runs. Show them to the owner blind, in randomised order, and record his picks. If he agrees with the incumbent `ui-designer` choice on at least 21 of 24, there is no taste gap in that seat and the complaint lies elsewhere. That is one sitting of roughly fifteen minutes and zero new runs, and it decides whether the rest of this document is worth acting on.

**The load-bearing negative, stated plainly:** no primary source in this pack shows a persisted preference store improving a generator. ICAI and EvalGen improve evaluators. CIPHER improves edit distance against a simulated user, in a setting whose authors state there is no distinction between training and testing. DesignPref and TASTE produce scorers. The case for branch B is not demonstrated efficacy. It is falsifiability and marginal cost per observation, and section 4 argues it on exactly those grounds and no others.

---

## 2. The two branches

Thirty systems were profiled, each attacked by a results lens and a mechanism lens. **The two lenses disagree on most rows, and that disagreement is the useful part.** The common outcome is that a paper's numbers do not survive but its mechanism does, so a single "refuted" label would misreport the majority of the table. The verdict column therefore records the two lenses separately:

- **results refuted, mechanism survived**: the described machinery is real and correctly reported, but its evidence does not license the claim.
- **both refuted**: the numbers and the described machinery both failed checking.
- **results survived, mechanism refuted**: the reported measurement holds, but the profile's account of how it would work in our repository does not.
- **both survived**: rare. One row.

`fit` is a 1 to 5 judgement of how closely the system matches our situation, not a judgement of its quality.

### 2.1 Candidate learning mechanisms

These persist something and could, in principle, be built.

| System | Branch | What persists | What signal | Fine-tuning? | Sample size the result rests on | Refuter verdict | Fit |
|---|---|---|---|---|---|---|---|
| **EvalGen** (https://arxiv.org/abs/2404.12272, UIST 2024, doi 10.1145/3654777.3676450, 2024-10-11) | B | selected assertion implementations per criterion; grades themselves do not survive the session | human thumbs up/down on sampled outputs, used to re-rank an already-generated candidate pool | no | 2 pipelines, 16 human-graded outputs each for selection, metrics over 84 and 100; 9 practitioners for the qualitative study | both refuted | 4 |
| **GATE** (https://arxiv.org/abs/2310.11589, 2023-10-17) | B | the raw elicitation transcript, within one session only; no cross-episode store exists | human answers to LM-chosen questions and labels on LM-synthesised edge cases | no | 19 to 31 participants per domain-method cell, one five-minute session each | results refuted, mechanism survived | 4 |
| **PRELUDE / CIPHER** (https://arxiv.org/abs/2404.15269, v3 2024-11-23) | B | a flat list of (context embedding, inferred preference string) pairs, retrieved top-k | edit distance between the agent's output and the user's rewrite | no | 200 rounds x 3 seeds x 2 tasks with a GPT-4 simulated user; real humans only in a 105-judgement and a 60-edit study | results refuted, mechanism survived | 3 |
| **MemGuard** (https://arxiv.org/abs/2608.21867, 2026-08-22) | A | structured memory records with a verifier descriptor and a lifecycle state including `provisional` | a verifier LLM's multi-criterion score over the trajectory, plus runtime status | no | 4 benchmarks x 4 backbones x 5 seeds; separate 2,294-issue stream; 51,896 frozen decisions joined post hoc | results refuted, mechanism survived | 3 |
| **ICAI** (https://arxiv.org/abs/2406.06560, ICLR 2025) | B | a short numbered constitution of natural-language principles, built once per dataset | pairwise preference labels, reconstructed into principles then filtered by reconstruction agreement | no | 65 train / 65 test pairs for the held-out arm; 9 and 12 annotations for the per-individual arms, with no train/test split | results refuted, mechanism survived | 4 |
| **ICAI+** (https://arxiv.org/abs/2606.30116, 2026-06-29) | B | same, plus early filtering and targeted principle refinement | same, plus per-principle accuracy and coverage over the train split | no | 520 to 800 train pairs per constitution; test splits of 128 and 400 | both refuted | 3 |
| **SPADE** (https://arxiv.org/abs/2401.03038, v2 2024-03-31) | B | a selected set of Python assertion functions | prompt-edit deltas as the generation signal; roughly 75 labelled outputs per pipeline for one-shot filtering | no | 9 pipelines, of which 6 also built the taxonomy and only 1 is both held out and human-labelled | both refuted | 3 |
| **LangSmith few-shot LLM-as-judge** (https://docs.langchain.com/langsmith/create-few-shot-evaluators, read 2026-09-04) | B | an auto-created corrections dataset, auto-populated once corrections begin | a human overriding an evaluator's score, plus an optional written explanation | no | none published; no metric of any kind appears on either primary page | both refuted | 3 |
| **Claude Code memory** (https://code.claude.com/docs/en/memory, read 2026-09-04) | B | `CLAUDE.md`, `.claude/rules/*.md`, and a self-written auto-memory index | for the files, none; for auto memory, a conversational correction judged worth keeping by the model itself | no | zero; the page publishes no evaluation of any kind | results refuted, mechanism survived | 4 |
| **DesignPref** (https://arxiv.org/abs/2511.20513, 2025-11-25) | B | a per-designer index of their own labelled pairs, retrieved top-8 as in-context exemplars | designer pairwise preference on rendered UI screenshots with a four-level strength label | retrieval arm no; the headline arm yes | 2,400 held-out judgements resting on at most 600 unique pairs, 20 designers | results refuted, mechanism survived | 3 |
| **TASTE** (https://arxiv.org/abs/2605.20731, v2 2026-06-02) | B | a frozen labelled corpus plus frozen MLP scoring heads over a frozen backbone | professional-designer ranking on nine criteria, collected once | scoring heads yes; using the released checkpoint no | roughly 80 prompts per criterion, 10 designers, train/validation split never stated | results refuted, mechanism survived | 3 |

### 2.2 Instruments and constraints

These measure or bound. None of them learns, and none improves anything by itself.

| System | Branch | What persists | What signal | Fine-tuning? | Sample size the result rests on | Refuter verdict | Fit |
|---|---|---|---|---|---|---|---|
| **Two-proportion power** (https://cran.r-project.org/web/packages/pwr/vignettes/pwr-vignette.html, read 2026-09-04) | neither | nothing | none; closed form over stored outcome counts | no | zero episodes; one empirical input, our own run counts | both refuted | 3 |
| **Miller, error bars for evals** (https://arxiv.org/abs/2411.00640, 2024-11-01) | both | nothing | none; arithmetic over stored per-item scores | no | zero learning episodes; one real-data table on unnamed internal models | both refuted | 4 |
| **Card et al., power analysis** (https://aclanthology.org/2020.emnlp-main.745/, EMNLP 2020) | both | nothing | none; a pre-registered decision rule | no | 117 Likert comparisons, 119 accuracy comparisons, 4 MT model pairs; zero learning episodes | results refuted, mechanism survived | 4 |
| **Bowyer et al., Wilson over CLT** (https://arxiv.org/abs/2503.01747, v3 2025-05-28) | neither | nothing | none | no | simulated coverage only; the closed forms are Wilson 1927 and Clopper-Pearson 1934 | results survived, mechanism refuted | 5 |
| **Cawley and Talbot, selection inflation** (https://www.jmlr.org/papers/v11/cawley10a.html, JMLR 11:2079, 2010) | A | nothing | none; a promotion threshold | no | classification model selection on benchmark datasets; zero LLM-pipeline episodes | both refuted | 5 |
| **Killip et al., intracluster correlation** (https://pmc.ncbi.nlm.nih.gov/articles/PMC1466680/, Ann Fam Med 2(3):204, 2004-05) | B | nothing | none; a design-effect calculation | no | one worked example of 128 patients in 4 clusters; zero owner ratings ever recorded here | both refuted | 3 |
| **Design2Code** (https://arxiv.org/abs/2403.03163, v3 2025-02-09) | A | nothing across episodes; one within-session self-revision turn | rendered screenshot compared against a reference screenshot | the paper's best system yes, and that arm is out for us | 484 pages, one generation per model per method, no seeds and no confidence intervals; 218 held-out human pairs for the metric validation | both refuted | 4 |
| **Thresholdout** (https://arxiv.org/abs/1506.02629, v2 2015-09-25) | both | a budget counter and a re-randomised threshold | disagreement between two estimates of the same quantity | no | one synthetic simulation, 10,000 samples, 100 executions; the experiment used parameters outside the theorem | results refuted, mechanism survived | 2 |
| **Atil et al., non-determinism at temperature zero** (https://arxiv.org/abs/2408.04667, v5 2025-04-02) | both | nothing | disagreement between replicate runs of an unchanged configuration | no | 80 conditions x 10 runs; all single-turn multiple choice, no Claude model, no 2025 or 2026 model | results refuted, mechanism survived | 4 |
| **PrefEval** (https://arxiv.org/abs/2502.09597, ICLR 2025 Oral) | neither | nothing; a static corpus | per-episode adherence verdict from an LLM judge | the only mitigation that substantially worked, yes, and it is out for us | 1,000 pairs x 3 forms, 20 topics, 10 models, up to 100k tokens | results refuted, mechanism survived | 3 |
| **Lakens, equivalence tests** (https://pmc.ncbi.nlm.nih.gov/articles/PMC5502906/, 2017-05-05) | both | a prespecified indifference margin per metric | none; a decision rule | no | zero episodes; analytic power tables and one worked replication | both refuted | 3 |
| **FormatSpread** (https://arxiv.org/abs/2310.11324, ICLR 2024) | both | nothing | task accuracy of one sampled prompt format as a bandit reward | no | 53 tasks x models; cheapest configuration 10 formats x 250 samples, search configuration 40,000 to 51,200 evaluations | results refuted, mechanism survived | 2 |
| **Null models beat benchmarks** (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral) | A | nothing; the "model" is a constant string | the judge's own token probability of naming it the winner | no | full benchmark sets: 805, 500 and 80 instructions; optimisation on 4 to 10 held-out training instructions | **both survived** | 4 |
| **Prompt caching** (https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching, read 2026-09-04) | neither | nothing | none | no | zero; every figure is a product specification | both refuted | 3 |
| **Zheng et al., LLM-as-a-judge** (https://arxiv.org/abs/2306.05685, NeurIPS 2023 D&B, v4 2023-12-24) | B | a static labelled dataset, consumed once | human expert pairwise votes and 1 to 10 grades | no | roughly 3,000 expert votes over 80 questions; the headline agreement cell is 479 non-tie votes | both refuted | 4 |
| **Ioannidis, positive predictive value** (https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.0020124, 2005-08) | A | nothing | none; closed-form arithmetic over three hand-supplied inputs | no | zero empirical episodes; every published number is a simulation from the author's own formulas | both refuted | 4 |
| **Harness-IF** (https://arxiv.org/abs/2608.11727, 2026-08-12) | neither | nothing | per-rule pass/fail verdicts from an evidence bundle | no | 2,160 runs, 40,104 verdict rows, 12 model builds; reliability on 919 audited rows and 116 paired verdicts | both refuted | 4 |
| **Khatri, do context files help** (https://arxiv.org/abs/2607.27250, 2026-07-28) | neither | nothing; the context file is static across all runs | gold-test pass/fail, used only as a dependent variable | no | 288 evaluated cells but the unit of analysis is the task, so effective n is 15 and 17 clusters | results refuted, mechanism survived | 4 |
| **VAB, visual aesthetic benchmark** (https://arxiv.org/abs/2605.12684, 2026-05-12) | neither | nothing; a fixed evaluation set | expert consensus over 10 judges per task, collected once | the paper's proposed remedy yes, and it is out for us | 400 tasks / 1,195 images; the transferable sub-study is 8 annotators over 226 tasks | results refuted, mechanism survived | 3 |

---

## 3. Branch A, autonomous

### What exists

Half of branch A is already built in this repository, and it is the half that works. `tools/tier3/gate.mjs:245 decide()` implements a reproduce-then-clear apply gate with `APPLY`, `REFUSE` and `PARK` intents and apply-token minting; `tools/repair/` holds the evidence validator, which requires three prover transcripts, a red-before, a green-after and a mutation-red, checked for mutual inequality and for exit-code trailers going the right way, with the diff reconciled against the files it claims to change. `dashboard/data/tier3/index.jsonl` holds four records. All four are synthetic fixtures from a single day, all carry `applied: false`, all carry `humanReviewed: null`, and the one `APPLY` was minted over a `PASS-WITH-UNARMED` verdict with three of four proofs unsatisfied. The mechanism exists and has never fired on a real proposal.

The other half, the aggregate-rate learner, does not exist and there is no promotion rule to hang it on. `applyDecisionRule` at `bakeoff/src/contracts.ts:1547` is a cost-switch rule for a model bake-off, not a quality gate: its second condition hard-requires a cut in dollars per held-out pass, so it structurally cannot promote a change that improves quality at unchanged cost. It also fails closed rather than open, because `dollarsPerHeldOutPass` returns null at zero passes and the condition is then false regardless of anything else. There is no unsafe-promotion bug to patch. There is an absence of any promotion rule at all.

### What survived checking

One row in the entire pack came back with both lenses surviving, and it is a negative result about branch A. A null model with no trainable parameters, submitting the same constant string as its answer to every instruction, scored 76.8 length-controlled win rate on AlpacaEval 2.0 against a verified state of the art of 57.5, with zero search, zero logprobs and a hand-written string (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral). Its three defence failures were measured, not asserted:

| Defence | Result | Reading |
|---|---|---|
| Length control and style disentanglement | 86.5 LC against 76.9 raw | the guard designed to stop gaming rewards the attack |
| Private evaluation set | 92.1 LC on an unseen official template after searching on paraphrases | keeping the template private does not protect |
| Windowed perplexity filter | the 76.8 response sits below the threshold | the filter does not catch it |

Two negative controls isolate the effect (same source, https://arxiv.org/abs/2410.07137, ICLR 2025 Oral). Sixteen persuasive null responses written by a chat model all scored under 1%, and an optimised adversarial suffix without the counterfeit structure was ineffective. The vulnerability is specifically template counterfeiting, not adversarial text in general, and it is annotator-specific: the same hand-crafted string scored 2.9 and 0.4 against Llama-3 annotators.

Independent corroboration of the finding class on our own model family exists. Content-free master keys such as a bare colon or "Thought process:" elicit false positive rewards from judges including Claude-4-class systems (https://arxiv.org/abs/2507.08794, 2025-07). Self-preference is measured: GPT-4 favours itself by a 10% higher win rate and Claude-v1 by 25% (https://arxiv.org/abs/2306.05685, v4 2023-12-24).

MemGuard is the newest and best-shaped branch A candidate in the pack, and its own numbers do not carry it (https://arxiv.org/abs/2608.21867, 2026-08-22).

| Quantity | Value | Reading |
|---|---|---|
| Cells where the verifier-only control already beats the baseline | 15 of 16 | most of the raw gain is verification, not memory governance |
| Marginal value of persisting the descriptor | typically 1.5 to 2.9 points | the actual contribution is small |
| Settings surviving Holm correction | 7 of 16 | the aggregate ordering is not family-wise significant |
| Matched seed-level comparisons lost | 11 of 320, plus 1 tie | the ordering is not universal at the seed level |
| Verifier reliability against human inspection | 86% and 83% on 800 audited decisions | the single point of failure is roughly 85% reliable |
| False accepts reaching active memory | 22 of 60 | governance leaks, by the authors' own trace |

Its released repository contains a governance library and ten smoke tests and no benchmark runner, so nothing in the paper is reproducible from what shipped (https://github.com/whyyyyy123/MemGuard, read 2026-09-04). The paper was thirteen days old when read.

### What the negative replications say

The obvious first version of branch A, injecting the defect ledger into a builder prompt, is the exact intervention two independent groups have measured. Khatri finds no pass-rate movement across three strategies and two agent families (https://arxiv.org/abs/2607.27250, 2026-07-28). Gloaguen et al. independently report that context files do not generally improve task success rates while increasing inference cost by over 20% (https://arxiv.org/abs/2602.11988, v2 2026-06-23). A third study reports efficiency gains "while maintaining a comparable task completion behavior" (https://arxiv.org/abs/2601.20404, revised 2026-03-30). The correctness literature is consistent in one direction and the cost literature is three-way inconsistent.

The honest strength of that finding must be stated with its own limitation attached. Khatri's unit of analysis is the task, not the run, so effective n is 15 and 17 clusters, and his own Monte Carlo puts the minimum detectable effect above 30 percentage points (https://arxiv.org/abs/2607.27250, 2026-07-28). The defensible claim is not "proven no-op". It is: no effect large enough to detect at that sample size, zero positive evidence anywhere, and one measured cost penalty.

Our own ledger is worse placed than the ones studied. `dashboard/data/defects/` holds 24 lines across 6 shards, every reference in the repository is a writer, a test or an offline tool, and one shard holds 11 lines under a single signature hash spanning four distinct causes. Before anything reads it, the signature function has to stop collapsing unlike failures into one bucket.

### The honest verdict for our scale

Three separate mechanisms make an aggregate-rate branch A loop unfalsifiable here.

**Volume.** At 16 runs per arm the minimum detectable effect from 43.75% is +42.4pp. Spending the entire gated history as a single arm buys the power to detect a near-doubling and nothing smaller. Section 5 gives the full table.

**Pairing does not rescue it.** Ticket-paired analysis is the standard fix, and it is unavailable: 21 distinct tickets across 30 runs, only two with three or more gated runs, and those two are 3 of 3 passing and 0 of 3 passing. Between-ticket variance dominates the metric.

**Selection inflation.** Picking the best of k candidates scored against the same fixed history manufactures apparent gains with no real effect (https://www.jmlr.org/papers/v11/cawley10a.html, JMLR 11:2079, 2010). The illustrative magnitude for our history is roughly 13 percentage points at k=24, but that figure was computed on the 5/30 status rate rather than on `heldOutPass`, and the order-statistic table it was checked against did not reproduce on re-fetch. Take the mechanism, which is sound and independently established, and treat the number as illustrative only.

Add the drift confound and the picture closes. A parallel A/B long enough to matter would run for months while the pipeline is edited weekly, so the arms would not be comparable. This is not an expensive experiment. It is an unrunnable one.

**Verdict.** Branch A is legitimate wherever a defect has a red-before, a green-after and an independent check, because a deterministic reproduce-then-clear proof is not a 16-sample binomial and carries almost none of the above. It is unmeasurable for anything scored on an aggregate rate, and an autonomous loop that cannot detect its own regression is worse than no loop, because the failure is silent. Keep the carve-out. Give it no aggregate-rate promotion path.

---

## 4. Branch B, owner as judge

The previous round searched coding agents and software-engineering benchmarks. It did not search preference learning, taste adaptation or human-in-the-loop personalisation. That is where this branch lives, and everything in this section is new to the repository.

### What exists

Eleven candidate mechanisms were profiled. The pattern across them is consistent enough to state as a finding:

**Every system that learns from human preference in this pack improves an evaluator. Not one improves a generator.**

- EvalGen selects assertion implementations that better predict a human's grades. No result in the paper shows any output getting better (https://arxiv.org/abs/2404.12272, UIST 2024, doi 10.1145/3654777.3676450, 2024-10-11).
- ICAI reconstructs a constitution that better predicts a person's picks. It is a classifier of taste, not a producer of it (https://arxiv.org/abs/2406.06560, ICLR 2025).
- SPADE synthesises assertions from prompt edits. The measured quantity is assertion-set parsimony and false-failure rate, never output quality (https://arxiv.org/abs/2401.03038, v2 2024-03-31).
- DesignPref and TASTE produce scorers over rendered designs (https://arxiv.org/abs/2511.20513, 2025-11-25; https://arxiv.org/abs/2605.20731, v2 2026-06-02).
- CIPHER is the closest to a generator result, and its authors state there is no distinction between training and testing in their setting; the reported metric is cumulative edit distance summed over the same rounds during which the store is being written (https://arxiv.org/abs/2404.15269, v3 2024-11-23).

### What survived checking

Four things survived, and they are mostly constraints rather than encouragements.

**Ask for a pick, never a score.** In the VAB sub-study, the same annotator's numeric scores contradict their own direct comparisons roughly half the time: top-1 self-consistency 45.5%, mean Kendall tau 0.188 on homogeneous tasks. Pick-based inter-annotator agreement runs 90.8% against 39.5% for scoring on homogeneous content, and 90.7% against 49.5% on heterogeneous content, which is the condition our deliberately-distinct design directions actually match (https://arxiv.org/abs/2605.12684, 2026-05-12).

**Do not accumulate one global preference string.** This is the direct measurement of the owner's own regression worry, and it is in the paper that proposes the method. On summarisation, a context-agnostic accumulated preference produced 65,218 and 57,915 edits against 48,269 for no learning at all. Retrieval of raw past edits also failed, at 32,405 against 31,103 for no memory. Preference must be keyed to a recurring context and retrieved, never concatenated (https://arxiv.org/abs/2404.15269, v3 2024-11-23). The same direction appears in a preregistered human study: user-written preference text went net-negative against no elicitation in the emails domain, which the authors attribute to users lacking a clear understanding of their own preferences (https://arxiv.org/abs/2310.11589, 2023-10-17).

**Do not target judge-owner agreement as the endpoint.** Personalising a design-preference judge on a person's own labels yields, in the arm that needs no weight updates, the gains below.

| Model | Zero-shot binary | With 8 retrieved personal examples | Gain |
|---|---|---|---|
| GPT-5 | 57.70% | 58.89% | +1.19pp |
| Gemini-2.5-Pro | 53.65% | 56.53% | +2.88pp |
| Qwen3-VL-30B | 54.82% | 56.20% | +1.38pp |
| Qwen3-VL-235B | 55.36% | 56.83% | +1.47pp |

Source: https://arxiv.org/abs/2511.20513, 2025-11-25. The runnable range is +1.19 to +2.88pp over 2,400 held-out judgements resting on at most 600 unique pairs. The paper's larger number is its fine-tuned arm and is out for us.

The ceiling those gains are measured against is low, from two separate designer studies.

| Quantity | Value | Source |
|---|---|---|
| Designer inter-rater agreement, binary | 62.4% | https://arxiv.org/abs/2511.20513, 2025-11-25 |
| Krippendorff alpha on the same | 0.248 | as above |
| Comparisons with at least 96% pairwise disagreement | 28.5% | as above |
| Best off-the-shelf judge, macro agreement | 0.539 | https://arxiv.org/abs/2605.20731, v2 2026-06-02 |
| Chance floor on the same task | 0.500 | as above |
| Leave-one-out human ceiling | 0.741 | as above |

Single-digit gains against a ceiling that low are undetectable at any sample size we can reach.

**Elicitation beats a written brief, on small tasks.** Actively-chosen questions beat a user-written prompt in 6 of 10 domain-method settings, and generative yes/no questions improved on user-written prompts in every setting studied, though the moral-reasoning domain was underpowered (https://arxiv.org/abs/2310.11589, 2023-10-17). Our plan seat already implements this shape, and `questionEarnsItsPlace` at `dashboard/server/src/plan-question.ts:292` is stricter than anything in the paper. The evidence is on three toy classification tasks under a five-minute budget, so it supports the direction and bounds nothing about multi-hour builds.

### What the owner would actually have to supply

One forced A/B pick plus one free-text reason, roughly ten seconds per pair. Never a numeric score, for the reason given above. The substrate for this already exists on disk.

| Artefact | Count | Location |
|---|---|---|
| `results/design-lock.json` files | 14, of which 12 carry a full 3-direction array | run results directories |
| Published design mockup images | 131 | run results directories |
| Winner-versus-loser direction pairs available immediately | 24 | derived from the above |
| Screenshots labelled by viewport and section | 257 across 16 runs | `screenshots` table |
| Owner-authored direction picks to date | 0 | `chosenDirectionBy` |

Cadence:

| When | Volume | Effort |
|---|---|---|
| Week 1, one sitting | 24 retrospective direction pairs | about 15 minutes |
| Per canvassed run, ongoing | the live 3-direction pick | about 30 seconds |
| Weekly, ongoing | about 60 pairwise picks over stored screenshots, order randomised | about 10 minutes |

`designLockPolicy` at `dashboard/server/src/design-lock.ts:48` already returns `"ask"` when the run is interactive, and `DesignLockRecord` at `design-lock.ts:443` already carries the losers array with their published mockups. The path is built and has never executed. This is wiring, not design.

Below roughly ten minutes a week the store grows at about one item per run, which is Branch A's rate, and the branch loses its only structural advantage.

### The honest verdict

Branch B is the recommendation, and the reasons are narrow. It is not that it learns better; no source here shows a preference store improving a generator. It is that:

1. **Its endpoint is testable at our scale.** A change of 0.20 in owner accept rate is reachable in roughly 56 paired labels. The same change on `heldOutPass` needs 94 runs per arm.
2. **Its observations already exist.** 131 mockups and 257 screenshots are on disk. Zero new runs are needed to begin.
3. **It is aimed at the axis the owner is complaining about**, on which 0 of 342 criteria currently say anything.
4. **Branch A is unfalsifiable and branch B is not.** That asymmetry, not efficacy, is the argument.

Two cautions must survive into any downstream ticket. The signal-density advantage is much smaller than it looks; section 5 measures it. And the source that supplies the clustering arithmetic concludes that increasing the number of clusters raises power more efficiently than increasing subjects within a cluster (https://pmc.ncbi.nlm.nih.gov/articles/PMC1466680/, 2004-05). Runs are the clusters here. On power efficiency alone, that source favours more runs over richer per-run scoring. Branch B's case is marginal cost per observation and endpoint testability, and it must never be argued on power efficiency.

---

## 5. The arithmetic

### The formula and one worked substitution

Two-proportion normal approximation, two-sided alpha 0.05, power 0.80:

```
n per arm = (z_0.025 + z_0.20)^2 * [p1*q1 + p2*q2] / (p2 - p1)^2
```

with `z_0.025 = 1.95996`, `z_0.20 = 0.84162`, and `(1.95996 + 0.84162)^2 = 7.8489`.

Worked, for a 10 point improvement on the real base rate:

| Step | Value |
|---|---|
| p1 (measured heldOutPass) | 0.4375 |
| p2 (target) | 0.5375 |
| p1 * q1 | 0.4375 * 0.5625 = 0.24609 |
| p2 * q2 | 0.5375 * 0.4625 = 0.24859 |
| sum | 0.49469 |
| delta squared | 0.01 |
| n per arm | 7.8489 * 0.49469 / 0.01 = 388 |
| total runs | 777 |

The formula was validated against the CRAN `pwr` vignette's published worked examples: the vignette reports 1564.529 per group for a 0.55 against 0.50 comparison, and the closed form gives 1562 (https://cran.r-project.org/web/packages/pwr/vignettes/pwr-vignette.html, read 2026-09-04).

### Runs required, on the correct variable

Base rate 43.75%, Wilson 95% [23.1%, 66.8%].

| Improvement | Target rate | Runs per arm | Total runs |
|---|---|---|---|
| +10pp | 0.537 | 388 | 777 |
| +15pp | 0.588 | 170 | 341 |
| +20pp | 0.637 | 94 | 187 |
| +30pp | 0.738 | 38 | 77 |

For comparison, the same table on the brief's premise of 5 of 30 at 16.7%, Wilson [7.3%, 33.6%]:

| Improvement | Target rate | Runs per arm | Total runs |
|---|---|---|---|
| +5pp | 0.217 | 969 | 1,938 |
| +10pp | 0.267 | 263 | 525 |
| +15pp | 0.317 | 124 | 248 |
| +20pp | 0.367 | 73 | 146 |
| +30pp | 0.467 | 34 | 68 |

### Minimum detectable effect at affordable sample sizes

| Runs per arm | MDE from 43.75% | Candidate must reach |
|---|---|---|
| 8 | +52.6pp | 96.4% |
| 15 | +43.3pp | 87.1% |
| 16 (entire gated history as one arm) | +42.4pp | 86.1% |
| 30 | +33.3pp | 77.1% |
| 74 | +22.3pp | 66.1% |

Throughput, for sizing any of the above: 168 hours a week divided by 6 hours a run is 28 runs started, and the measured gate-reach rate of 16 of 30 gives 14.9 gated observations a week. At the 12 hour worst case it is 7.5.

### Signal density: run outcomes against per-criterion judgements

The attractive move is to treat 342 criteria over 30 runs as n = 342. Measured clustering forbids it. Criteria within a run share a plan, a spec, a builder seat and one site, so the design effect applies:

```
DEFF = 1 + (m - 1) * rho
effective n = raw items / DEFF
```

Measured on the scored gating criteria in this repository:

| Quantity | Value |
|---|---|
| Scored observations | 248 |
| Clusters (runs) | 16 |
| Mean items per cluster | 15.5 |
| Mean pass rate | 0.7823 |
| One-way ANOVA intracluster correlation | 0.4675 |
| DEFF = 1 + 14.5 * 0.4675 | 7.78 |
| Effective sample size = 248 / 7.78 | 31.9 |

The QUALITY tier alone is worse: 49 observations, ICC 0.8253, effective sample size 18.1, and that tier never gates anyway.

Design effect by items per cluster at the measured rho of 0.4675:

| Items per cluster | DEFF |
|---|---|
| 2 | 1.47 |
| 3 | 1.94 |
| 6 | 3.34 |
| 10 | 5.21 |
| 16 | 8.01 |

The comparison, stated honestly:

| Source | Raw items | Clusters | Items per cluster | DEFF | Effective n |
|---|---|---|---|---|---|
| Branch A, gated runs | 16 | 16 | 1 | 1.00 | 16.0 |
| Criteria already scored | 248 | 16 | 15.5 | 7.78 | 31.9 |
| Direction pairs on disk | 24 | 12 | 2 | 1.47 | 16.4 |
| Screenshots on disk | 257 | 16 | 16 | 8.01 | 32.1 |

**On the data already on disk, the two branches are within a factor of two of each other. The density argument mostly fails.** What discriminates them is marginal cost per observation: a branch A observation costs 6 to 12 machine hours and has a measured 47% chance of yielding nothing, while a branch B observation costs about ten seconds of owner attention and cannot fail to yield one. At 30 minutes a week branch B yields roughly 54 effective observations a week against branch A's 15; at two hours a week, roughly 216 against 15. Those projections use the measured rho as a placeholder.

**Caveat that must survive into any downstream ticket.** The 0.4675 figure was measured on functional pass/fail, and the per-run table is bimodal (0 of 13, 0 of 13, 9 of 9, 7 of 7, 6 of 6, 8 of 8, 16 of 16) because a broken run breaks everything. Taste labels on three deliberately distinct directions are a different construct with plausibly lower rho. **No branch B power figure may be quoted until rho is re-estimated on the first thirty owner labels.**

### Precision available, and the paired alternative

Wilson half-width at p = 0.5:

| Effective n | Half-width |
|---|---|
| 16 | +/- 22.0pp |
| 32 | +/- 16.4pp |
| 100 | +/- 9.6pp |
| 200 | +/- 6.9pp |
| 400 | +/- 4.9pp |

The paired design, same artefact with a rule on and off, uses McNemar and depends on the discordance rate, not on the marginals:

```
n pairs = [z_0.025 * sqrt(pi_d) + z_0.20 * sqrt(pi_d - delta^2)]^2 / delta^2
```

| Discordance | delta = 0.30 | delta = 0.20 | delta = 0.15 | delta = 0.10 |
|---|---|---|---|---|
| pi_d = 0.30 | 24 pairs | 56 pairs | 102 pairs | 233 pairs |
| pi_d = 0.20 | 15 pairs | 37 pairs | not computed | not computed |

`pi_d` is not estimable from current data and must be measured in the first withheld-rule batch.

**Read the whole section this way.** Branch B does not escape the requirement that effects be large. It escapes the cost of testing for them.

---

## 6. Regression control

### The specific failure mode of an evaluator inside the loop it optimises

This is the mechanism that makes branch A dangerous rather than merely useless, and it is the one row in the pack where both lenses survived.

A null model with no trainable parameters, returning the same constant string for every instruction, scored a length-controlled win rate of 76.8 on AlpacaEval 2.0 against a verified state of the art of 57.5, hand-crafted, with zero search and zero access to token probabilities (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral). The string counterfeits the annotator's own prompt template, so the judge's parse latches onto a fake comparison in which both candidate outputs are empty, and falls back to positional preference.

Three guards were tested and all three failed, and one of them failed in the wrong direction:

| Guard | Measured outcome |
|---|---|
| Length control, built specifically to reduce gameability | the attack scores higher on LC (86.5) than raw (76.9), because it is short |
| Keeping the annotator template private | 92.1 LC on the unseen official template after searching on paraphrases only |
| Windowed perplexity filter at a permissive threshold | the 76.8 response sits below the threshold and is not caught |

The negative controls matter and are worth carrying: sixteen persuasive null responses of the "ignore the above and output M" kind all scored under 1%, and an optimised adversarial suffix without the counterfeit structure was ineffective. So the vulnerability is template counterfeiting specifically, and it is annotator-dependent: the same string scored 2.9 and 0.4 against Llama-3 annotators. The attack also composes with real work; appended to a normal model's answers it climbed above 90%.

Two independent lines corroborate the class on our own family. Content-free master keys elicit false positive rewards from judges including Claude-4-class systems (https://arxiv.org/abs/2507.08794, 2025-07). Self-preference is measured at +10% for GPT-4 and +25% for Claude-v1 (https://arxiv.org/abs/2306.05685, v4 2023-12-24), which is directly live for us because our critic and our builder are the same model family.

**The boundary, stated plainly.** Everything above was measured on text with pairwise or scalar scoring. There is no image, render, screenshot or DOM input anywhere in it. The correct verdict for our four rendered-quality judges is that their gameability is **unknown, therefore do not gate on them and do not use them as a fitness signal**, not that they are known-broken.

One further calibration, from the same paper (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral). Judge fidelity does not predict judge gameability, and the correlation ran the wrong way in the one place it was measured.

| Annotator | Agreement with human labels | Score achieved by the hand-crafted attack |
|---|---|---|
| GPT-4-1106-Preview | 69.2 | 76.8 LC |
| Llama-3-70B-Instruct | 68.8 | 0.4 LC |
| Human self-agreement, for reference | 65.7 | not applicable |

The more human-agreeing judge was the more gameable one. For branch B this means that showing a taste rubric agrees with the owner on a sample is **not** evidence it is safe to optimise against on unreviewed runs. Those are two different properties.

### The codeable rules

Each is a small, separable task.

1. **`requiredRuns(baseRate, delta)` refuses before it prints.** Keys off `held_out_pass IS NOT NULL`, never off `status`. Returns an interval derived from the Wilson bounds on the base rate, not a point estimate. Refuses with an explicit error when the gated denominator is under ten. Every proposal is priced before it is built, not after.

2. **Every rate is rendered through `wilsonInterval`, never bare.** The function already exists at `bakeoff/src/analyze.ts:133` with input assertions and clamping; the dashboard path never calls it. Pin regression tests to actual values: `(5,30)` gives `[0.0734, 0.3356]`, `(7,16)` gives `[0.2310, 0.6682]`, `(0,30)` gives `[0, 0.1135]` with `high > 0`, `(30,30)` gives `[0.8865, 1]` with `low < 1`. Do **not** assert that `(0,30)` differs from `[0,0]`: at p = 0 the lower bound is exactly 0 and that assertion fails against a correct implementation, while passing against a stub that always returns `[0,1]`. Because the two packages have separate builds, either extract the function into a shared module or vendor it with a both-directions drift test in the pattern of `dashboard/server/src/contract-parity.test.ts`.

3. **Tie goes to the incumbent.** Nothing is promoted on a difference whose interval straddles zero. At our sample sizes most comparisons are ties, so this is the default outcome and must be written as the default, not as an exception.

4. **Withheld-rule negative control, mandatory before a rule enters the store.** Re-run the same frozen spec twice, once with the rule pack injected and once with the target rule withheld, and keep the rule only if the withheld run reproduces the defect. A rule the builder would have obeyed anyway carries no information. **This is ours to build, not a port.** The source system's zero-injection control covers only 44.1% of its own against-prior denominator, 46.5% of the labels are hand-curated, and the clean per-rule paired version was never run (https://arxiv.org/abs/2608.11727, 2026-08-12).

5. **Fresh-sample confirmation.** Any change selected by inspecting past runs is re-measured only on runs created after the selection timestamp (https://arxiv.org/abs/1506.02629, v2 2015-09-25). Run ids are ISO-8601 prefixed, so this is a string comparison. Record the selection timestamp on every promoted change.

6. **Declare k, and widen by it.** Record how many candidates were compared before a winner was named, and widen the interval at alpha divided by k (https://www.jmlr.org/papers/v11/cawley10a.html, JMLR 11:2079, 2010). `compareProportions` in `bakeoff/src/analyze.ts` already returns an interval and an `insideNoise` flag and already refuses when the Wald standard error collapses; what it lacks is multiplicity.

7. **No LLM verdict gates on a single call.** Judge-swap agreement on the nearest measured instrument is kappa 0.163, and human agreement is kappa 0.515 (https://arxiv.org/abs/2608.11727, 2026-08-12). Order-swap consistency for a frontier pairwise judge is 65.0% (https://arxiv.org/abs/2306.05685, v4 2023-12-24). Require order-swapped agreement and treat disagreement as `unavailable`, never as `accept`.

8. **Fail closed on insufficient evidence.** `rendered-taste-critic` currently returns `accept` when the findings array is empty, while the prompt itself states that an empty array is correct when evidence is insufficient. Insufficient evidence therefore publishes. Split `accept` from `no-evidence`.

9. **Do not touch `applyDecisionRule` at `bakeoff/src/contracts.ts:1547`.** It fails closed, and it requires a cost reduction it can never get from a quality-only change. No promotion rule for quality changes exists in this repository. One must be written fresh with rule 3 inside it. Reparameterising the existing rule after seeing results is the reinterpretation its own comments forbid.

10. **One flag, one revert.** The taste store is read behind a single boolean; flipping it off restores byte-identical prompts. Snapshot the exact injected rule set per run, so that any movement can be attributed to the artefact rather than to a changed prompt.

11. **Injection is capped and de-duplicated.** Bounded token budget, retrieved by nearest artefact rather than concatenated, hard maximum on rules per prompt. Unbounded growth is the documented context-collapse path, and global concatenation is the configuration measured as worse than no memory at all (https://arxiv.org/abs/2404.15269, v3 2024-11-23).

12. **Rules are advisory to the design and critic seats only, never to the sealed gate.** The held-out suite, its hash and the scorer stay untouched. Nothing owner-derived may edit a criterion.

---

## 7. What we should build

### Build

**Task 1. The premise probe.** A dashboard view that presents the 24 stored winner-versus-loser direction pairs blind, in randomised order, and records the owner's pick and a free-text reason. No store schema yet, no injection. This is the kill-criterion-1 instrument and it must exist before anything else does. Order randomisation is not optional: it is part of the reference harness for the pick format we are borrowing (https://arxiv.org/abs/2605.12684, 2026-05-12).

**Task 2. The `owner_pref` table.** A new table in `dashboard/data/runs.db` holding `(pref_id, kind, run_id, item_a, item_b, chosen, reason, rated_at, rater)` with `kind` in `{direction, screenshot, section}`. A new table under `CREATE TABLE IF NOT EXISTS` is free on an existing database, so there is no migration on a live table. Pairwise picks with a free-text reason. **No numeric score**, because the score is the part that contradicts itself.

**Task 3. Write `chosenDirectionBy = "owner"`.** `designLockPolicy` already returns `"ask"` when interactive and `DesignLockRecord` already persists the losers with their mockups. Wire the interactive path so a live run's 3-direction pick lands as an `owner_pref` row.

**Task 4. Extend the taste vocabulary.** Add `typography` and `colour` categories with codes to `dashboard/server/src/taste-policy.ts` and the matching `TASTE_CODE_CATEGORY` entries, which are enforced at parse time. Until this lands, no owner rule about type or palette can be expressed at all. The externally validated criteria set is nine dimensions covering typography, colour harmony, colour accuracy, visual hierarchy, mood and tone, and spatial accuracy, with above-chance designer agreement established (https://arxiv.org/abs/2605.20731, v2 2026-06-02). The import is validated for typography, colour and hierarchy only, is strictly additive, and is not a warrant for the seven categories we already have.

**Task 5. Estimate rho.** Run the same one-way ANOVA that produced the 0.4675 figure over the first thirty owner labels, and publish the result before any branch B power figure is quoted anywhere.

**Task 6. The withheld-rule harness.** Per rule, run the same frozen spec twice with the rule injected and withheld, and record whether the withheld run reproduces the defect. This is rule 4 above and it is net-new code.

**Task 7. A derived, versioned rule pack.** Rules induced from the picks, each carrying id, rule text, the `pref_id` list it came from, its withheld-run control result, a version, a created-at timestamp and an enabled flag. Append-only; never rewrite an earlier version. Retrieval keyed to artefact or section type.

**Task 8. Injection behind one flag**, into the design lane's direction-authoring prompt and the taste critic, with a per-run snapshot of exactly which rule ids and pack version were injected.

**Task 9. Probe the sealed-seat memory channel.** `subscription-caller.ts` sets `settingSources: []` for the spec, plan, judge and fix seats deliberately, but auto memory is loaded regardless of that setting and those seats run with a working directory inside this repository (https://code.claude.com/docs/en/agent-sdk/claude-code-features, read 2026-09-04). Set `autoMemoryDirectory` to a scratch path, seed it with a canary string, dump the assembled prompt, and assert the canary is present by default and absent under `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Present-and-absent, not present-only. Until this runs, the store we build is not the only cross-run channel in the pipeline.

**Task 10. Fix the defect signature function.** One shard holds 11 lines under a single hash spanning four distinct causes. Per-defect learning is impossible on that ledger even once something reads it.

### Do not build

**Do not inject the defect ledger into a builder prompt.** That is the exact channel two independent groups measured as producing no correctness movement, with one measuring a cost penalty above 20% (https://arxiv.org/abs/2607.27250, 2026-07-28; https://arxiv.org/abs/2602.11988, v2 2026-06-23). Leave `dashboard/data/defects/*.jsonl` write-only for now.

**Do not build an aggregate-rate promotion path for branch A.** Section 5 gives the reason. A promise to roll back if `heldOutPass` drops costs hundreds of runs to make credible, so it is not a real guard at our volume.

**Do not run ICAI as published.** Its call volume at maintainer defaults is inside the thousands-of-scored-calls exclusion, its smallest split is 520 train pairs, and `inverse-cai` ingests text strings with **no image path at all** (https://github.com/rdnfn/icai, read 2026-09-04). Feeding it direction descriptions instead of stills would induce rules about the writing rather than about the pixels the owner judged, which is the pipeline-versus-chat gap restated. Its filter is four independent gates rather than the net-zero rule sometimes reported, and the 10% relevance threshold is a configurable parameter, so any port must set it explicitly rather than inherit it.

**Do not run ICAI on the corpus as it stands.** All eleven stored picks were authored by `ui-designer` or by fallback. Inducing rules from them and injecting them back into `ui-designer` would feed that seat a distillation of its own past choices, which is model taste laundered as owner taste. Owner-authored picks are a hard precondition.

**Do not adopt a surface-placement rule from the instruction-following literature.** The precedence pilot ran nine older model builds over four synthetic conflict pairs with only 6 of 9 per-build fits reproducing the ordering, and its own authors state the three leading surfaces are not statistically distinguished (https://arxiv.org/abs/2608.11727, 2026-08-12). Placement is an empirical question for our own withheld-rule test.

**Do not take Design2Code's revision result as a reason to gate.** The claim that self-revision degrades a frontier model on four of five metrics was a baseline artefact and is withdrawn; the correct comparison is text-augmented against self-revision, which is up or flat. Gate revision on keep-if-better anyway, but justify it by the absence of confidence intervals and the single generation per model per method, not by a degradation that was not measured (https://arxiv.org/abs/2403.03163, v3 2025-02-09).

**Do not build a constitution-reconstruction pipeline, a per-designer fine-tune, or any assertion-synthesis loop that needs thousands of scored programmatic calls.** These are excluded by the standing constraint, not deferred.

### One candidate worth recording but not yet building

The creative contract is injected once at the top of a session that then runs for hours: `creativeContractPrompt` at `dashboard/server/src/creative-pilot.ts:792` has three call sites, all at the top of a session, with no mid-segment re-emission. That is the long-context regime in which a stated preference decays, and the best non-fine-tuning mitigation measured was simply restating the preference next to the generating turn (https://arxiv.org/abs/2502.09597, ICLR 2025 Oral). **The evidence is text-only conversational recommendation over 20 lifestyle topics, and it bounds nothing about a multi-hour code-writing agent.** Record re-emission as plausible and unevidenced for our domain; do not spend the first week on it.

---

## 8. Kill criteria

Observable conditions, ordered cheapest first.

**1. Premise check. Do this before building anything else.** Show the owner the 24 retrospective winner-versus-loser direction pairs blind and order-randomised, and record his picks.

| Outcome | Action |
|---|---|
| Agreement with the incumbent `ui-designer` pick on 21 or more of 24 | **Stop.** There is no taste gap in this seat and the complaint lies elsewhere |
| 17 to 20 of 24 | proceed |
| 16 or fewer of 24 | proceed; true agreement of 85% is ruled out |

The 21 of 24 threshold has a chance probability of 0.00014 under a coin flip and a Wilson interval of [0.690, 0.957]. Cost is one sitting of about fifteen minutes and zero new runs.

**2. Label supply.** Fewer than 40 new `owner_pref` rows in any 14-day window, read off `rated_at`. Below that rate the store grows at about one item per run, the design effect collapses towards branch A's, and branch B loses its only structural advantage. Kill, or renegotiate the cadence explicitly.

**3. Taste-label intracluster correlation.** Estimate rho on the first thirty owner labels using the same one-way ANOVA that produced 0.4675. **Rho above 0.8 kills the density argument**: items within a run stop being distinct observations and six labels per run buy about two effective ones. Report rho before quoting any branch B power figure.

**4. Withheld-rule control.** For each rule, the withheld run must reproduce the defect. A rule whose withheld run is clean is deleted, not filed. **If more than half of the first ten rules fail this**, the rules are describing behaviour the builder already had and the store is recording noise.

**5. Owner self-consistency.** Re-present about fifteen already-labelled pairs at two weeks' distance or more. **Test-retest below roughly 70% kills the endpoint**: the ceiling would be too low for any learned artefact to clear, and accumulation does not fix it. This is the same construct that gave 45.5% top-1 self-consistency for numeric scoring in the one place it was measured (https://arxiv.org/abs/2605.12684, 2026-05-12), which is why the endpoint is a pick and not a score.

**6. Accept-rate movement.** On paired rule-on against rule-off batches, the change in owner accept rate must reach 0.20 to be detectable in about 56 pairs. **Two consecutive batches whose interval straddles zero, or a discordance rate below 0.10, kills the injection path.** Fall back to keeping the store as an owner-facing record with no prompt injection.

**7. Regression trip.** Any batch in which the rules-on arm's accept rate is below rules-off with the interval excluding zero: revert the flag immediately, keep the pack version, do not tune. This is the measured failure mode of accumulated preference text (https://arxiv.org/abs/2404.15269, v3 2024-11-23) and it must have a pre-committed response rather than a discussion.

**8. Branch A carve-out.** If, after ten attempts, no defect signature produces a red-before, green-after, mutation-red triple that clears `decide()` on a non-synthetic proposal, close the carve-out. Observable from `dashboard/data/tier3/index.jsonl`, which today holds four records, all synthetic, all `applied: false`.

---

## 9. Method, what was dropped, and blind spots

### Method

Thirty systems were profiled. Each carries two adversarial lens verdicts, one on whether the reported numbers mean what they appear to mean, and one on whether the described mechanism is what the primary source actually implements. **Where a lens refuted a profile's claim, this document reports the refuted status and uses the corrected mechanism, not the original.** Repository facts were measured against `dashboard/data/runs.db` and against source files at their cited line numbers, not taken from any prior document; the wrong-denominator finding in section 1 is exactly what that discipline caught.

### What was dropped, and why

**Already covered by prior rounds, not re-derived here:** GEPA; DSPy, MIPRO and TextGrad; HarnessFix; the model-collapse literature; ACE agentic context engineering and its context-collapse result; Dynamic Cheatsheet; ExpeL; SpecBench; ImpossibleBench; self-preference bias in rubric evaluation; Argo Rollouts and Temporal control patterns; and from the 60-system prior-art study, ReasoningBank, SWE-Exp, AHE, SICA, the Darwin Godel Machine, the RHO retro-harness, Meta-Harness and EvoMal.

**Dropped on the fine-tuning and call-volume rules, and not carried as future work:**

| Technique | Reason it is out |
|---|---|
| The headline arm of DesignPref (https://arxiv.org/abs/2511.20513, 2025-11-25) | per-designer fine-tune of a CLIP variant; weight updates |
| The training of TASTE's scoring heads (https://arxiv.org/abs/2605.20731, v2 2026-06-02) | gradient loop plus roughly 1,600 designer ratings per criterion |
| VAB's proposed remedy (https://arxiv.org/abs/2605.12684, 2026-05-12) | fine-tuning a 35B model on 2,000 expert examples |
| PrefEval's only substantial mitigation (https://arxiv.org/abs/2502.09597, ICLR 2025 Oral) | supervised fine-tuning |
| FormatSpread's bandit (https://arxiv.org/abs/2310.11324, ICLR 2024) | cheapest configuration is thousands of scored calls per task; search configurations reach 40,000 to 51,200 |
| ICAI and ICAI+ as published (https://arxiv.org/abs/2406.06560; https://arxiv.org/abs/2606.30116) | roughly 7,000 scored calls per constitution at the reduced setting, more at maintainer defaults; smallest split 520 train pairs |
| Thresholdout as an algorithm (https://arxiv.org/abs/1506.02629, v2 2015-09-25) | needs an i.i.d. query object we do not have, and a holdout larger than our entire history by orders of magnitude |
| Half of Miller's variance-reduction recommendations (https://arxiv.org/abs/2411.00640, 2024-11-01) | requires next-token probabilities, unavailable on subscription access |
| The optimised half of the null-model attack (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral) | its objective is a token probability; only the hand-crafted result is reproducible under our constraints, and we would not want to reproduce it |

### Blind spots

**No image-modality evidence exists anywhere in the pack.** Every gameability, judge-agreement and instruction-following result was measured on text with pairwise or scalar scoring. Our four rendered-quality judges consume renders. Their behaviour is unknown, not known-bad.

**Several "no independent replication" findings are not-checked rather than established.** Multiple profiles exhausted their web-search budget at 200 of 200, and Semantic Scholar returned HTTP 429 repeatedly on 2026-09-04. Where a profile records an absence of replication, read it as an absence of search unless a citation-graph check is named.

**Rho for taste labels is unmeasured** and the placeholder was taken from functional pass/fail on a bimodal per-run table. Kill criterion 3 exists because of this.

**The discordance rate `pi_d` is not estimable from current data**, so the paired sample sizes in section 5 are conditional, not measurements.

**The sealed-seat auto-memory channel is unprobed.** `settingSources: []` does not exclude auto memory, and the sealed seats run with a working directory inside this repository. Task 9 exists because of this and it must run with both a positive and a negative control.

**The defect-ledger signature function collapses distinct causes.** Eleven lines in one shard under one hash span four different failures, so the ledger cannot support per-defect learning even after something reads it.

**Criteria mentioning colour, contrast and whitespace do exist** among the 342, seven and one and four of them respectively, so the claim is not that the gating suite is entirely silent on visual matters. It is that every such criterion is a mechanical threshold, and no criterion anywhere addresses palette, typography, hierarchy or composition as judgements.

**Two paths named in this document have code but no execution history.** The Tier-3 apply gate has four synthetic records and has never fired on a real proposal. `chosenDirectionBy = "owner"` is a complete type with an implemented policy branch that has never run. Both are wiring tasks, but neither is proven.

---

## 10. Sources

### Papers and preprints

- Adding Error Bars to Evals (Miller): https://arxiv.org/abs/2411.00640, 2024-11-01
- Cheating Automatic LLM Benchmarks (null models), ICLR 2025 Oral: https://arxiv.org/abs/2410.07137, v2 2025-03-02
- Constitutional preference reconstruction, open problems (ICAI+): https://arxiv.org/abs/2606.30116, 2026-06-29
- Design2Code: https://arxiv.org/abs/2403.03163, v3 2025-02-09
- DesignPref: https://arxiv.org/abs/2511.20513, 2025-11-25
- Do Context Files Help Coding Agents (Khatri): https://arxiv.org/abs/2607.27250, 2026-07-28
- Equivalence Tests, a practical primer (Lakens): https://pmc.ncbi.nlm.nih.gov/articles/PMC5502906/, 2017-05-05
- Evaluating AGENTS.md (Gloaguen et al.): https://arxiv.org/abs/2602.11988, v2 2026-06-23
- EvalGen, Who Validates the Validators, UIST 2024 doi 10.1145/3654777.3676450: https://arxiv.org/abs/2404.12272, published 2024-10-11
- FormatSpread, ICLR 2024: https://arxiv.org/abs/2310.11324, v2 2024-07-01
- GATE, Generative Active Task Elicitation: https://arxiv.org/abs/2310.11589, 2023-10-17
- Generalization in Adaptive Data Analysis and Holdout Reuse (Thresholdout): https://arxiv.org/abs/1506.02629, v2 2015-09-25
- Harness-IF: https://arxiv.org/abs/2608.11727, 2026-08-12
- Impact of AGENTS.md on agent efficiency (Lulla et al.): https://arxiv.org/abs/2601.20404, revised 2026-03-30
- Inverse Constitutional AI, ICLR 2025: https://arxiv.org/abs/2406.06560, v2 2025-04-21
- Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena, NeurIPS 2023 D&B: https://arxiv.org/abs/2306.05685, v4 2023-12-24
- MemGuard: https://arxiv.org/abs/2608.21867, 2026-08-22
- Model selection and subsequent selection bias (Cawley and Talbot), JMLR 11:2079: https://www.jmlr.org/papers/v11/cawley10a.html, 2010
- Non-Determinism of Deterministic LLM Settings (Atil et al.): https://arxiv.org/abs/2408.04667, v5 2025-04-02
- One Token to Fool LLM-as-a-Judge: https://arxiv.org/abs/2507.08794, 2025-07
- Position: Don't Use the CLT in LLM Evals (Bowyer et al.): https://arxiv.org/abs/2503.01747, v3 2025-05-28
- PrefEval, ICLR 2025 Oral (forum QWunLKbBGF): https://arxiv.org/abs/2502.09597, 2025-02-13
- PRELUDE / CIPHER, learning latent preference from user edits: https://arxiv.org/abs/2404.15269, v3 2024-11-23
- SPADE, synthesising data quality assertions: https://arxiv.org/abs/2401.03038, v2 2024-03-31
- TASTE, designer-annotated preference dataset: https://arxiv.org/abs/2605.20731, v2 2026-06-02
- VAB, Visual Aesthetic Benchmark: https://arxiv.org/abs/2605.12684, 2026-05-12
- Why Most Published Research Findings Are False (Ioannidis): https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.0020124, 2005-08
- Why Most Published Research Findings Are False, problems in the analysis (Goodman and Greenland): https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.0040168, 2007
- With Little Power Comes Great Responsibility (Card et al.), EMNLP 2020: https://aclanthology.org/2020.emnlp-main.745/, 2020-11
- What Is an Intracluster Correlation Coefficient (Killip et al.), Ann Fam Med 2(3):204: https://pmc.ncbi.nlm.nih.gov/articles/PMC1466680/, 2004-05

### Documentation and code repositories

- Anthropic prompt caching: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching, read 2026-09-04
- Claude Agent SDK, Claude Code features: https://code.claude.com/docs/en/agent-sdk/claude-code-features, read 2026-09-04
- Claude Code memory: https://code.claude.com/docs/en/memory, read 2026-09-04
- Claude Code sub-agents: https://code.claude.com/docs/en/sub-agents, read 2026-09-04
- ChainForge (EvalGen implementation): https://github.com/ianarawjo/ChainForge, read 2026-09-04
- CRAN `pwr` vignette: https://cran.r-project.org/web/packages/pwr/vignettes/pwr-vignette.html, read 2026-09-04
- Design effect (Kish): https://en.wikipedia.org/wiki/Design_effect, read 2026-09-04
- generative-elicitation (GATE code): https://github.com/alextamkin/generative-elicitation, read 2026-09-04
- inverse-cai (ICAI code): https://github.com/rdnfn/icai, read 2026-09-04
- LangSmith few-shot evaluators: https://docs.langchain.com/langsmith/create-few-shot-evaluators, read 2026-09-04
- LangSmith audit evaluator scores: https://docs.langchain.com/langsmith/audit-evaluator-scores, read 2026-09-04
- LangSmith changelog: https://docs.langchain.com/langsmith/changelog, read 2026-09-04
- McNemar's test: https://en.wikipedia.org/wiki/McNemar%27s_test, read 2026-09-04
- MemGuard code: https://github.com/whyyyyy123/MemGuard, read 2026-09-04
- PRELUDE code: https://github.com/gao-g/prelude, read 2026-09-04
- SPADE experiments: https://github.com/shreyashankar/spade-experiments, read 2026-09-04
- TASTE code and dataset: https://github.com/purvanshi-lica/taste and https://huggingface.co/datasets/purvanshi/TASTE, read 2026-09-04
- VAB code: https://github.com/BakeLab/Visual-Aesthetic-Benchmark, read 2026-09-04

### This repository, measured 2026-09-04

- `dashboard/data/runs.db`: run counts, `held_out_pass`, `false_finish`, `agentDeclaredDone`, ticket distribution, criteria table
- `dashboard/data/defects/`: 24 lines across 6 shards, one shard holding 11 lines under one signature
- `dashboard/data/tier3/index.jsonl`: 4 records, all synthetic, all `applied: false`
- `dashboard/server/src/taste-policy.ts`: 7 categories, 21 finding codes, no typography, no colour
- `dashboard/server/src/design-lock.ts:48` (`designLockPolicy`), `:184` (`chooseDirection`), `:443` (`DesignLockRecord`)
- `dashboard/server/src/creative-pilot.ts:792` (`creativeContractPrompt`), three call sites
- `dashboard/server/src/plan-question.ts:292` (`questionEarnsItsPlace`)
- `dashboard/server/src/rendered-taste-critic.ts`, `subscription-caller.ts`
- `bakeoff/src/analyze.ts:133` (`wilsonInterval`), `bakeoff/src/contracts.ts:1547` (`applyDecisionRule`)
- `tools/tier3/gate.mjs:245` (`decide`), `tools/repair/`
- Stored artefacts: 14 `design-lock.json` files, 131 mockup images, 24 winner-versus-loser pairs, 257 screenshots across 16 runs

### Related documents in this repository

- [FINDINGS-2026-09-02-pipeline-vs-chat.md](FINDINGS-2026-09-02-pipeline-vs-chat.md)
- [RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md](RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md)
- [COMPARISON-2026-09-03-prior-art-vs-internal-findings.md](COMPARISON-2026-09-03-prior-art-vs-internal-findings.md)
