---
document_status: comparison
written: 2026-09-03
compares:
  - docs/RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md
  - docs/FINDINGS-2026-09-02-pipeline-vs-chat.md
method: both documents read in full; five cross-document lenses; one fresh sweep on build-time visual feedback; fourteen top cross-document claims adversarially re-verified against the two documents and the code, of which eleven were refuted and three survived with corrections
---

# Prior art against internal forensics: what the two studies together say to do next

## 1. Headline

Two studies were written on 2026-09-02 by parallel sessions that could not see each
other. The external study profiled 60 systems, each attacked by a results-real lens
and a mechanism-real lens, with a fact-check pass on 2026-09-03 that re-opened the
primary source behind every headline claim
(RESEARCH §9:506, "Nine sweeps produced 60 profiles"). Its self-side facts are
sourced entirely to project documentation at commit `c4c9f37`, two commits behind
HEAD, and it cites no line of our source code (RESEARCH front matter :5; §10:590).
The internal study measured the code at `e5f9ce4` and the persisted artefacts of one
source run, its delivered continuation and two recovery children, with six readers
and two refuters per finding, one against the code and one against the run artefacts
(FINDINGS front matter :3; method :17-21). Its citations resolve exactly; I re-opened
the load-bearing ones.

They are complementary instruments with opposite blind spots, and their blind spots
are shaped by their methods. Because both of the external study's lenses asked
verification questions, all eleven of its ranked lessons are gating, receipts or
metrics items, and a grep of RESEARCH lines 307 to 441 for sandbox, network, egress,
loopback, seatbelt or allowLocal returns one hit, line 313, which is the word
"regressions". The internal study's dominant cause, a builder that cannot see its own
page, therefore maps to none of the eleven lessons. Running the other way, the
internal study has no external reference class and no measured baseline for the thing
it explains: its warrant is one owner judgement of one page (FINDINGS :9-11), with no
chat artefact in evidence and its dominant cause's ablation deferred to
"the first experiment" (FINDINGS :305-306). The external study holds the base rates
and the variance arithmetic that would settle it.

The one thing the comparison produces that neither study produced alone is a
reordering of the fix. A fresh sweep found exactly one system in the literature that
gets a rendered signal back to a generator before it stops, unattended, and that
system does not give the builder eyes. WebGen-Agent captures the screenshot in the
workflow, hands it to a separate vision model that returns a description, a 0 to 5
appearance score and improvement suggestions, and appends that text to the coding
model's trajectory (https://arxiv.org/abs/2509.22644, 2025-09-26). The counterweight
is Design2Code, where handing a model a render of its own page beside the reference
and asking it to improve moved GPT-4V's block match from 87.6 to 88.8 and brought
"no improvement on Gemini Pro Vision and all other open-source models"
(https://arxiv.org/abs/2403.03163, 2024-03-05, NAACL 2025). Set that against the
internal measurement that four rendered-quality judges exist in our code and the
number that has ever produced a gating verdict is zero (FINDINGS §2:73-77, :95-96),
and against the external study's independent record of the same fact
(RESEARCH §7.6:479, "Our rendered taste critic has never completed a run").
**Therefore.** The first build is not a renderer for the build seat. It is making the
rendered critic complete and giving it a re-entry rule that runs before DONE. Neither
document ranks that first: the external study ranks a freeze-time discrimination
check first and has no lesson about rendered feedback at all, and the internal study
ranks the blind builder as dominant and names the sandbox knobs as the first
experiment.

---

## 2. Where they agree

### 2.1 Coverage of the five internal causes

| Internal cause (FINDINGS) | Prior-art lessons that address it | Prior-art systems and sections | Coverage |
|---|---|---|---|
| **1. The builder cannot see its own page (dominant)**, FINDINGS §1:36-66 | None of RESEARCH §5.1 to §5.11 | RESEARCH §3.9:240, browser tool calls per app correlate with accuracy at r = 0.72 against edit calls at r = 0.09; §7.6:479 records rendered-quality grading as unsolved by anyone; §3.10:256 asks for builder egress to be closed, which points the opposite way | **Does not address in the ranked lessons.** A grep of §5 for sandbox, network, egress, loopback, seatbelt or allowLocal returns only line 313's "regressions". Partly addressed outside them: §3.9:240, §7.6:479, and the fresh sweep's WebGen-Agent (section 4) |
| **2. Nobody judges quality before the builder says done**, FINDINGS §2:68-96 | §5.2 receipt-backed DONE (partial), §5.5 critic qualification, §5.8 known-bad corpus | RESEARCH §7.6:479, VCB judge agreement spans 36.1% to 86.4% across models against a human ceiling of 88.6-93.6% (§3.9:240); §3.12:282, forced-haiku reviewers flagged 0 of 10 planted defects at correct severity | **Partly addresses.** 5.2 catches the "did it run" class, not the "is it good" class; 5.5 and 5.8 qualify a critic rather than make one exist |
| **3. The builder is told the wrong thing**, FINDINGS §3:98-141 | §5.3's fourth item (continuation state, and it pulls the other way on one artefact class) | RESEARCH §3.8:218, Antigravity coordinates through workspace artefacts plus handoff files that preserve state at context exhaustion; §4:303 rates our continuation "Behind" | **Partly addresses.** Contract memory and handoff have prior art; the prompt-assembly defect (0 of 87 ticket lines in the build prompt) and the single-URL fact reader have none |
| **4. The builder is taxed by the grader**, FINDINGS §4:143-177 | §5.6 fix ladder with written adjudication, §5.4 third gate outcome plus `falseAbort`, §5.7 per-criterion gradient, §5.11 once re-keyed | RESEARCH §3.5:178, mini-swe-agent's typed exit statuses persisted in a `finally:`; §3.12:284, rounds 1-3 resume the implementer and 4-5 escalate one tier | **Partly addresses, and it is the best-covered cause of the five** |
| **5. Model and effort**, FINDINGS §5:179-193 | None | Grep of RESEARCH for "effort" returns one line, §3.1:114, in SWE-Marathon's anti-cheat discussion; "xhigh" returns zero. §6:455 tiers reviewers down under a stronger builder, the inverse of ours; §3.12:284 escalates model tier, not reasoning effort; §3.1:112 reports effort-annotated rows and never varies effort as a factor | **Does not address** |

### 2.2 The strongest convergence: four judges, zero gating verdicts

Two sessions, two methods, two commits, same finding. The external study records at
RESEARCH §7.6:479 that "Our rendered taste critic has never completed a run", citing
`docs/CAPABILITIES.md`. The internal study measured the artefacts and found the same
thing at a commit two ahead: "The critic route exists in code (`ea54c35`, `e5f9ce4`);
it has never completed" (FINDINGS §2:95-96). The internal study then widens it.
The visual-substance gate is SHADOW in all 13 persisted reports, quoting
`visual-gate.md`'s own "NONE of them can fail this run"; the rendered Taste Critic has
`criticAttempt: null` in all 7 creative runs; Context7 has never executed; the
adversary has never run dynamically; and "Across 30 persisted runs, 0 had any
visual-quality signal reach the builder before it declared done"
(FINDINGS §2:73-77). The two commits whose messages read like repairs,
`ea54c35` "recover terminal creative reviews" and `e5f9ce4` "repair deterministic
creative renders", did not change the fact, so the external study's staleness caveat
resolves in its favour here.

This corroborates lesson 5.5 rather than qualifying it, because 5.5's own premise is
non-execution: "A critic that has never been shown to fail on a build we know is
broken is unmeasured, which is this repository's catalogued signature defect arriving
in the review layer" (RESEARCH §5.5:365). One correction to an earlier reading. Lesson
5.8 has no critic dependency at all: its concrete change is to "Drop the 102
applications and their bug lists into the frozen known-bad corpus behind the offline
self-diagnosis gate" (RESEARCH §5.8:401), which is a dataset import. And the adversary
does execute and is billed; the internal predicate is scoped to "never run
dynamically", and the same document records adversary spend in the run row
(FINDINGS §5:191-193). **Therefore.** Widen the external study's item 6 from the taste
critic to the whole rendered-judgement tier, and record the count: four independent
quality judges exist in code, zero have produced a gating verdict.

### 2.3 The second strongest: the fix and recovery half of cause 4

Lesson 5.6 asks for a per-criterion budget with mandatory advance, resumption of the
same fix context for the first rounds with tier escalation only after, and a written
ruling for every finding the orchestrator declines to act on, "so the postmortem
question 'why was this dropped' is answerable from data" (RESEARCH §5.6:377). The
internal study measured a marker-repair lane that died after "the one allowed repair"
with no recorded adjudication: `m-contact-state` was still not observed at events seq
276 of recovery child `4c4285c5` (FINDINGS §4:171-173). Lesson 5.4 asks for a typed
third gate outcome, and mini-swe-agent's rule is the general form: "Typed exit statuses
persisted per step in a `finally:`" (RESEARCH §3.5:178). The internal study found a
probe whose refusal "carries no explanation" at `creative-render.ts:1073`, watching
transform and opacity on the `[data-motion-id]` element alone under a hover trigger
(FINDINGS §4:167-170).

Two corrections to how this convergence has been stated. `falseAbort` is defined with
a counterfactual, "a run killed by the anti-loop or a budget cap whose workspace would
have passed the held-out suite", and is to be measured "by replaying the anti-loop rule
against logged runs where the true verdict is already known" (RESEARCH §5.4:353). The
internal study establishes neither half for `4c4285c5`: the word "held-out" does not
appear in FINDINGS at all, and what killed the run was the creative-render motion
probe, not the sealed held-out suite. So that run is a candidate for `falseAbort`
measurement, not an instance of it. And `infra-inconclusive` cannot be said to map to
nothing internal: FINDINGS never classifies any event as infrastructure, and it records
verdict-less judge outcomes downstream of the build, including a critic capture that
was "refused" on the continuation because of contract-id drift (FINDINGS §3:114-116).
**Therefore.** Adopt 5.6's ladder and mandatory ruling, treat `falseAbort` as a metric
to measure in shadow mode against `4c4285c5` rather than a label it already earns, and
extend the inconclusive outcome to cover judges that produce neither pass nor fail.

### 2.4 Would the two-sided no-op check have caught the placeholder rows? No.

Lesson 5.1's freeze-time half is: "run every held-out test against an empty scaffold in
the sealed container. Any test that passes is vacuous and goes back to the spec seat as
a defect, and the count of vacuous tests becomes a suite-quality number recorded in the
frozen manifest" (RESEARCH §5.1:317). The test in question is REQ-007, "a work section
lists at least two distinct pieces of work", which "passed the two placeholder rows"
(FINDINGS §2:82-85). Its body filters on
`matches(WORK_RE, s.key) && !PROCESS_RE.test(s.head) && s.share < 0.75 && s.entries >= 2`
and then asserts `usable.length` is greater than zero
(`dashboard/acceptance/t-cbf387df97b9b6dd/suite/holdout/page-content.spec.mjs:186-192`),
and its section list is derived from `document.querySelectorAll('h2, h3')` at the same
file's lines 39-76. On an empty scaffold that list is empty, the assertion fails, and
the test goes red. So 5.1 passes REQ-007 through as discriminating, it contributes zero
to the vacuous-test count, and the defect ships.

5.1's second stage does not entrench the defect either, but it is inert rather than
helpful: it flags only "any held-out test that never passed on any green artefact for
that ticket" (RESEARCH §5.1:317), and REQ-007 passed on the green artefact, which the
external study itself records as passing 32/32 (RESEARCH §4:303). The vacuity 5.1 tests
for is empty versus non-empty; the vacuity that was measured is placeholder versus
real. The ticket asked for verified projects from kamilborzecki.dev, whose bundle lists
five named projects, and "None appear" (FINDINGS :30-32).

This is a coverage limit, not a defect in 5.1, and the external study already books the
gap as unsolved by anyone: "Nobody has done it at freeze time with nothing to compare
to" (RESEARCH §7.4:475). The obvious repair, running NL2Repo-Bench's spec-derivability
check backwards so that every entity the ticket makes binding must carry an assertion,
is a new synthesis rather than prior art: as documented the check runs the other way,
"for every symbol, route or selector a held-out test asserts on, require a hit in the
frozen ticket or spec text" (RESEARCH §3.10:256), and a bare count assertion names no
symbol, route or selector. It also would not have worked alone here, because the five
project names are not in the ticket: they live in the site's JS bundle, and the
pipeline "owns exactly one JS-rendering reader" pointed at the first URL in the ticket
(`site-capture.ts:203`, "THE FIRST URL WINS", FINDINGS §3:128-131). **Action.** Ship
5.1 for the class it does catch, a test green on nothing, and do not count it as
coverage for content criteria. Pair a reversed derivability rule with FINDINGS' own fix
shape, "Render every URL the ticket makes binding, not only the first"
(FINDINGS §3:139-141), because without the second the first has no content to bind to.

### 2.5 Would receipt-backed DONE have caught motion verified by reading CSS? Half.

The instance is in cause 1's effect paragraph: the builders "verified the motion
requirements by reading CSS rather than running it", citing the continuation's
`workspace/.bakeoff/self-report.json` (FINDINGS §1:51-52). DeerFlow's parent-side
acceptance layer would label that UNVERIFIED, because a motion self-report is not one
of its three decidable leaves and "anything undecidable is UNVERIFIED, 'not neutral'"
(RESEARCH §3.11:262). But in DeerFlow the label carries no consequence: "Verdicts are
advisory signals for the lead model, no gating, no retry loops" (RESEARCH §3.11:264).
And lesson 5.2's own blocking rule is narrower than the label: "an unresolved citation
blocks the transition to the gate" (RESEARCH §5.2:329), while a receipt for a file read
resolves. 5.2's Risk paragraph concedes exactly this: "receipts prove a call happened
and its status", with a fixed limitation string, "execution evidence only... does not
validate claim correctness" (RESEARCH §5.2:333). Note also that 5.2's concrete change
imports receipts, cited claims and citation resolution only; the acceptance-check layer
is recommended separately, in §3.11's Copy paragraph (RESEARCH :270).

The internal study left the input question open, "Whether the builder ever opened the
design stills: `build.log` records assistant prose only; no tool-use records survive"
(FINDINGS :301-302), and the external study left the same question open, "Can we get
per-tool-call receipts out of a Claude Code subprocess seat without cooperation from
the model?" (RESEARCH §8:490). Neither had to. The runtime already parses both sides of
every tool call: `dashboard/server/src/claude-common.ts:262-282` exports `toolUses`,
which reads every `block.type === "tool_use"` off an assistant message and returns its
id, name and input, and `:295-299` defines `SdkToolResult` carrying `toolUseId` and the
tool's full structured output. A receipt ledger is a persistence change here, not a new
capability. **Action.** Build the ledger off `toolUses` and `SdkToolResult`, persisted
beside `build.log` where the seat cannot rewrite it, and implement 5.2 with two
amendments the prior art does not state: type receipts per claim class, so a motion or
layout claim may cite only a receipt whose tool is an execution tool and never a file
read; and import the acceptance-check layer so that an UNVERIFIED decidable leaf blocks
the gate transition, not only an unresolved citation.

---

## 3. Where they disagree or qualify each other

Four items require the external study to change, two require the internal study to
change, and one requires an owner decision that neither document poses.

### 3.1 RESEARCH §1:13 must change. Verification independence is not what our suite asserts.

The sentence is: "Leg three, verification that is not self-graded, is where the real
evidence lives, and this repository is ahead of every profiled builder on it"
(RESEARCH §1:13). It is the document's only unqualified statement of that standing. The
internal study measures what the sealed grader actually asserts: the spec seat authors
"from ticket text alone, binary only, 'never quality of X'", with QUALITY "REPORTED,
NEVER GATING" (FINDINGS §2:80-82, citing `bakeoff/src/spec-agent.ts:204, 217, 231`);
"Across all 30 runs the criteria table holds 342 criteria; none mention palette,
typography, hierarchy or composition" (FINDINGS §2:86-87); and the one gating judge
counts elements.

Two corrections to how this has been put. The comparison matrix is not the overclaim
and must not be edited: RESEARCH §4:299's verdict already reads "Ahead on sealing,
behind on grader trustworthiness", which affirms the headline's own property and adds
an orthogonal one, and under the matrix's own definition at §4:290 those are verdicts
on two different properties. Nor is the matrix the only hedge: §3.2:118 names our
remaining work as "making the grader as trustworthy as the seal already is",
§7.7:481 lists "Grader trustworthiness at any scale" among the unsolved and ends "Ours
has seven fixtures", and §7.6:479 records the taste critic never completing. The
internal evidence also targets validity rather than self-grading: a sealed,
independent grader that measures the wrong property is still not self-graded.
**Action.** Edit line 13 only, to say ahead of every profiled builder on sealing the
grader from the builder, and unmeasured on whether the sealed grader measures the right
thing. Leave §4:299 alone.

### 3.2 RESEARCH §4:297 must be rescoped. Two different components are being scored as one.

The workspace-isolation cell reads: "Sandboxed builder workspace; held-out suite
protected by an OS-sandbox read denial *and* a policy-tier permission rule ...; sealed
scorer with `--network=none`, egress verified denied from inside on every run", verdict
"Ahead, and by a wide margin. We are the only system in the pack with a two-layer seal
that was tested by disabling each layer" (RESEARCH §4:297).

No sentence conflates the two components: the semicolons separate them, and the
two-layer seal that was tested by disabling each layer is the filesystem pair. What is
wrong is the scope of the dimension label. `--network=none` and the verified egress
denial belong to the sealed scorer, which is a container. The builder is not a
container, and its options carry "no `sandbox.network` clause at all", with
`orchestrator.test.ts:3591` pinning that absence (FINDINGS §1:38-41). The cell's
network clause therefore says nothing about the builder, and the dimension is titled
"Workspace isolation".

The important consequence is that the fix costs none of the lead. The read-denial layer
and the network defaults are separable: `filesystem: { allowWrite, denyRead }` is set at
`claude-builder.ts:1034` and the network knobs are simply absent, so setting them does
not touch the layer that was tested. **Action.** Rewrite the cell so the two-layer seal
is explicitly scoped to the held-out suite's filesystem protection, add one clause
stating that builder egress is unmeasured and unrestricted, and add a §8 open-question
row for it, since §3.10:256 already flags builder egress and §8 never asks about it.

### 3.3 RESEARCH §4:299 must state `falseFinish`'s observable surface.

The cell lists "two co-primary metrics, `heldOutPass` and `falseFinish`". The metric is
defined in our own code as "declared done AND the held-out suite failed"
(`dashboard/server/src/build-prompt.ts:33-34`). Since the suite is authored binary-only
with QUALITY never gating, a run whose defects live only in the QUALITY tier cannot
register a `falseFinish`.

The blind spot is wider than visual, and this is where an earlier reading was wrong.
The delivered run's headline defect was factual content, and it passed a gating
FUNCTIONAL criterion: REQ-007 admitted two placeholder rows under an `entries >= 2`
heading regex (FINDINGS §2:82-85). A count-only assertion inside the gating population
is a second, separate route to a silent false finish. **Action.** State the population
wherever the metric is published: `falseFinish` is defined over the criteria as
authored, cannot fire on a QUALITY-tier defect, and cannot fire on a defect a count-only
assertion admits. A falling `falseFinish` is not on its own evidence of improvement in
the class the owner complained about.

### 3.4 RESEARCH §4:303 needs an annotation, not a correction. This one is a qualification.

The cell cites `run-cont-e22fa17f9b7972c79641` as having "preserved the work-reveal fix,
changed only skip-link CSS and passed 32/32", scoped as "verified for one narrow green
path", under a row whose verdict is "Behind". The internal study names the same run as
the delivered site whose thinness is the subject of the whole forensic
(FINDINGS :13-14, :25-32).

These do not contradict. The internal study corroborates the external parenthetical:
after the source's build lane, the further turns "produced only gate-driven changes in
the delivered site: a scroll-based reveal rewrite and an opacity nudge from the fix
round, and a net 13-line skip-link rule from the continuation" (FINDINGS §4:147-150).
The two propositions, state preservation and rendered quality, are simultaneously true,
and cause 2 explains how: the suite is 19 count-based criteria. Thirty-two tests against
nineteen criteria is tests versus criteria, not a discrepancy between the documents.
**Action.** Annotate the parenthetical so a reader skimming the matrix cannot take
"passed 32/32" as a quality datapoint, and adopt the general rule: no green from this
corpus is cited as capability evidence without naming what it did not check.

### 3.5 FINDINGS cause 1's fix shape must change. The three knobs alone will not launch Chromium.

The internal fix shape is "set the three sandbox knobs, or hand the builder the host's
own captures after every build segment" (FINDINGS §1:65-66). The first half is
documented as insufficient for default multi-process Chromium, and the reason is
specific. anthropics/claude-code issue #82660, opened 2026-07-30 by samlaf and still
open, reports the identical fatal our runs carry,
`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer...: Permission denied (1100)`,
which is byte-for-byte the failure FINDINGS records at continuation `build.log:174`.
The reporter's root cause is that the Seatbelt profile emits only `(allow mach-lookup ...)`
under `(deny default)` and contains no mach-register allowance, while Chromium's
multi-process launch must register a per-pid Mach bootstrap service, so
"allowMachLookup ... only emits (allow mach-lookup ...) rules, structurally incapable of
granting registration rights". The two workarounds offered both fully unsandbox the
browser.

Against that stands this repository's own paired positive, which the internal study
records and does not connect: recovery child `8a65087e` launched Chromium with
`--no-sandbox --disable-gpu --single-process`, served the workspace by route
interception, ran 20 browser checks and looked at sliced full-page screenshots
(FINDINGS §1:60-63, citing that run's `build.log:103`). Single-process removes the
per-pid Mach rendezvous #82660 names, so the documented failure elsewhere and the
measured success here are consistent.

Two smaller corrections to the same paragraph, verified locally. `allowMachLookup` is
not a boolean: at
`dashboard/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2752` it is an
optional array of strings, while `allowLocalBinding` at `:2751` is a boolean and
`allowUnixSockets` at `:2749` is an array with a companion boolean at `:2750`. On the Playwright
citation, this document's first draft said there is no Playwright docblock at those
lines, which is true but misleading, and it is corrected here. There is no docblock
beside the schema at `:2749-2752`, but the same field is documented for Playwright
elsewhere in the same file: `:6171` reads "macOS only: Additional XPC/Mach service names
to allow looking up ... Needed for tools that communicate via XPC such as the iOS
Simulator or Playwright", verified in this session. The published settings reference says
the same (https://code.claude.com/docs/en/settings-reference, read 2026-09-03). So the
honest position on this knob is necessary but not sufficient: lookup is documented as
needed for a browser, registration is what default multi-process Chromium additionally
requires, and nothing in the package exposes registration. That is why single-process,
not the knobs, is doing the work in the one arm with a precedent here.
**Action.** Restate the fix shape as three arms, not two: host captures handed to the
seat, which needs no sandbox change; an orchestrator-owned renderer outside the seal;
and, only if a browser inside the seat is wanted, the knobs paired with single-process
Chromium. Do not expect the knobs alone to produce a renderer, and note that
`allowLocalBinding` remains plausibly necessary for the dev server's `listen()`, which
is a different operation from Chromium's Mach registration.

### 3.6 FINDINGS cause 5 must be reclassified, and one sentence reattributed.

Cause 5 records that `models.ts:129` pins `BUILDER_EFFORT = "high"` and
`claude-builder.ts:1039` passes it on every design, build, fix and recovery call, while
the owner's chat and the pipeline's spec, audit and judge seats run xhigh
(FINDINGS §5:181-185). It is the only ranked cause with no "Fix shape" paragraph, and it
asserts no measured quality delta. The sentence "That is the first experiment" is at
FINDINGS :306, in the "Still unmeasured" section, and its antecedent is cause 1's
renderer question, not effort.

The prior art cannot settle it and says so implicitly by never testing it, but it does
constrain any test. VCB's variance decomposition attributes 92.5%, 92.1% and 73.5% of
total variance to the generation side with generation standard errors of 3.47 to 5.00
points (RESEARCH §3.9:240), and the Copy paragraph draws the conclusion for us: "the
variance decomposition says a single-run A/B on our pipeline will report phantom
regressions" (RESEARCH §3.9:242). **Action.** Reclassify cause 5 from a cause to an
untested configuration difference, and run any effort comparison with replicates on a
fixed ticket panel. One internal lead is worth recording while we are here: superpowers'
tier rule is prompt-enforced and was measured being violated silently, a dispatch
specifying `model: "opus"` spawning `claude-sonnet-5` with nothing reporting it
(RESEARCH §3.12:282, issue #2245), whereas ours is enforced in code. That compares two
different knobs, their model tier against our effort level.

### 3.7 FINDINGS' rejected-findings count does not add up.

The method paragraph says "Nine were rejected on cause or impact although their
mechanism was real; those are listed at the end so nobody re-derives them"
(FINDINGS :19-21). The section at :195-211 lists six bullets. Three rejections were
dropped with no record of what they were or why, which is the silent discard that
lesson 5.6 forbids in the fix loop: superpowers' terminal breaker "forbids silent
discards, requiring per open finding a written ruling that records the decision, the
reason, and what the decision costs if it is wrong" (RESEARCH §5.6:375).
**Action.** Recover the three missing rejections from the six readers' raw output
before the document is used to scope work, and apply the written-adjudication rule to
research documents as well as to the fix loop.

### 3.8 The owner decision neither document poses: two continuation lanes, opposite provenance policies.

Lesson 5.3's fourth item is to "strip git history, prior gate outputs and cached reports
from the workspace at continuation entry" (RESEARCH §5.3:341), motivated by
mini-swe-agent issue #787, where 21% of Opus 4.6 runs on SWE-bench Pro used
`git log --all -S` to read the gold fix and 17 passed that way (RESEARCH §3.5:172).
FINDINGS cause 4's fix shape asks to "Copy the results tree and the resolved manifest on
continuation" (FINDINGS §4:176).

There is no head-on collision, and an earlier reading overstated one. 5.3's item is a
closed three-item list inside a section titled "Harden the gate's own runtime, not just
its files", aimed at artefacts the graded party could mine. Neither of cause 3's
information defects, the per-run re-authored creative contract and the absent ticket
bytes, is in that list, and cause 3's own fix shape asks to carry the contract forward,
which 5.3 never forbids. The narrow tension is with cause 4's results-tree copy, and
only on the unstated inference that the tree carries score files. The carry-declarative
and strip-evaluative split is also not novel: Antigravity coordinates through workspace
artefacts and handoff files while subagents "do not inherit the parent's existing
conversation history (context window), starting with a clean slate" (RESEARCH §3.8:218),
which the Copy list takes as "Clean-slate subagent context as the property that makes a
critic independent" (RESEARCH §3.8:226).

What neither document saw is that our two continuation lanes already carry opposite
policies, which I verified this session.
`dashboard/server/src/run-continuation.ts:19` sets
`EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".next", "coverage"])`, with the
comment at `:55-58` that "Git metadata and dependency caches are not carried across
identities". `dashboard/server/src/creative-recovery.test.ts:436` is titled
"terminal creative recovery preserves regular .bakeoff and .git workspace trees" and
asserts at `:451-452` that `.bakeoff/self-report.json` and `.git/HEAD` arrive in the
child workspace. `.bakeoff` is excluded by neither lane, and FINDINGS itself reads a
prior `workspace/.bakeoff/self-report.json` as run evidence (FINDINGS §1:51-52).
**Action.** Decide one policy deliberately and apply it to both lanes: carry declarative
state forward (the frozen contract, the resolved manifest with rewritten paths, the
ticket bytes), strip evaluative state (prior gate outputs, score files, cached reports,
git history). The recovery test is an intentional preservation contract, not a bug
report, so this is an owner decision, not a fix.

---

## 4. The blind spot in the prior-art study: build-time visual feedback

### 4.1 What section 5 contains, and what it does not

The eleven ranked lessons are a freeze-time discrimination check, receipt-backed DONE,
gate-runtime hardening, a third gate outcome plus `falseAbort`, a planted-defect
battery, a fix ladder, per-criterion scoring, a known-bad corpus, an escalation channel,
a replay harness and coordination-cost instrumentation (RESEARCH §5:311-441). None
proposes giving any code-writing seat a renderer or a capture. The comparison matrix has
eight dimensions and none of them is whether a builder can observe its own artefact. The
one place rendered quality appears is §7.6:479, and it is framed as post-hoc grading by
an independent judge. The one line in the whole report that touches builder egress is
§3.10:256, a deep-dive Copy paragraph asking for egress to be closed during the build,
which was never promoted into a numbered lesson and points the opposite way from the fix
cause 1 needs. **Therefore.** A roadmap built from §5 alone funds receipts, gate
hardening and critic qualification, and never touches the internal study's dominant
cause.

### 4.2 Which systems put the render in the loop before the agent stops

A fresh sweep on 2026-09-03 fetched known URLs directly, because the web-search budget
was exhausted before it began. It will have missed systems a keyword search would
surface. Every systems row below is self-reported and none is organiser-checked.

**Exactly one system gets an unattended rendered signal back to the generator before it
stops: WebGen-Agent** (https://arxiv.org/abs/2509.22644, submitted 2025-09-26).
Algorithm 1 loops to a maximum of 20 iterations; each step generates edits, executes,
and gathers feedback. On successful execution "a screenshot of the landing page of the
website is captured first", and a separate vision model, Qwen2.5-VL-32B-Instruct,
returns a description, an appearance score from 0 to 5 against successful rendering,
content relevance, layout harmony and modernness and beauty, plus suggestions. If
appearance is satisfactory a GUI agent explores the site and an LLM judges its
trajectory. Backtracking fires "If five consecutive steps contain code execution
errors", and selection is by highest GUI score, then highest screenshot score, then
latest step. **The load-bearing detail: the coding model receives the vision model's
text, and the paper does not state that it receives the image.** The rendering stack,
containerisation and sandbox posture are not disclosed anywhere in the paper.

Its ablation is the only per-component measurement of build-time visual feedback in
either study's reach, on DeepSeek-V3 as the coding model, reported as accuracy over
appearance: execution-only 45.9% / 3.0; plus screenshot critic 46.6% / 3.6; plus
GUI-agent tester 49.9% / 3.4; plus backtracking 51.2% / 3.7; plus select-best 52.6% /
3.8. The headline is "WebGen-Agent increases the accuracy of Claude-3.5-Sonnet from
26.4% to 51.9% and its appearance score from 3.0 to 3.9". Read the ablation, not the
headline: the screenshot critic bought 0.7 points of functional accuracy and 0.6 of
appearance; the browser-driving tester bought 3.3 points of accuracy while appearance
fell from 3.6 to 3.4, recovered only by backtracking and select-best. The external study
independently records that this line of work has no replication: "three independent
re-runs each changed both judge and scaffold, so none replicates any number"
(RESEARCH §2.1:62).

**The counterweight, and it should be read before anyone promises a large effect.**
Design2Code's self-revision condition gives the model the reference screenshot, a
screenshot of its own generated page and its own code, and asks it to improve
(https://arxiv.org/abs/2403.03163, 2024-03-05, NAACL 2025). GPT-4V moved from
text-augmented to self-revision on block match 87.6 to 88.8, text 98.2 to 98.1, position
80.2 to 81.1, colour 73.0 to 72.9, CLIP 87.2 to 87.2. The authors' own summary is that
self-revision "brings no improvement on Gemini Pro Vision and all other open-source
models", and human evaluation found no substantial improvement for GPT-4o. Sketch2Code
points the same way with a human-proxy oracle holding the ground truth: five rounds of
feedback-following moved GPT-4o's visual similarity 82.29 to 86.29 and layout IoU 20.38
to 21.21, while the question-asking condition failed, with "all VLMs struggl[ing] to
formulate meaningful questions" (https://arxiv.org/abs/2410.16232, 2024-10-21).

**Everything else is human-mediated or optional.** Bolt.diy renders into a WebContainer
preview that a person looks at, and is WebGen-Agent's own baseline at 20.8% / 2.0
against 52.6% / 3.8. Stagewise and Onlook bind a rendered DOM element back to source and
require a human to point at it. v0 ships the render to a human and automates only the
non-visual error signal. Cursor's agent browser is available and never mandatory: it
gives the agent full control through MCP tools and states that "Screenshots are
integrated directly with the file reading tool, so Agent actually sees the browser state
as images rather than relying on text descriptions"
(https://cursor.com/docs/agent/browser, read 2026-09-03), with no "verify your work"
requirement and no quality measurement anywhere. Antigravity's browser subagent drives a
separate Chrome profile and saves screenshots and action videos as artefacts
(https://antigravity.google/docs/ide/browser, read 2026-09-03), and the external study
records that its Auditor runs "a final audit ... forced before the Sentinel notifies the
user" (RESEARCH §3.8:212-226) without establishing that the audit looks at a render.
WebGen-Bench and Vibe Code Bench grade post-hoc only.
**Therefore.** No shipped product has a mandatory pre-DONE visual gate. That is an open
position rather than a catch-up, and it matches RESEARCH §7.6:479 exactly.

### 4.3 The re-entry rule, shipped on our substrate

Claude Code's `/goal` is the only shipped, non-self-graded, pre-DONE re-entry rule the
sweep found on our substrate (https://code.claude.com/docs/en/goal, read 2026-09-03).
It is "a wrapper around a session-scoped prompt-based Stop hook": after each turn the
condition and the conversation go to a small fast model, which returns Not yet met, Met
or Impossible, and "If the model judges it not yet met, Claude starts another turn
instead of returning control to you", with "completion ... decided by a fresh model
rather than the one doing the work". It runs non-interactively:
`claude -p "/goal ..."` "runs the loop to completion in a single invocation", which
matters because the external study's one negative result about our runtime is that agent
teams are unavailable under `-p` (RESEARCH §1:15, §6:449).

Two documented limits force the design. The evaluator "judges your condition against
what Claude has surfaced in the conversation. It doesn't run commands or read files
independently", so a visual verdict has to be put into the transcript by a seat that can
render. And a Stop hook "blocks the turn from ending until it passes. Claude Code
overrides the hook and ends the turn after 8 consecutive blocks", so a hook is not an
unbounded veto. **Therefore.** The orchestrator must own the veto, and the critic must
surface its verdict as text. That is WebGen-Agent's architecture arriving from a second
direction.

### 4.4 How the mechanism transfers to a macOS seatbelt sandbox with CLI subprocess seats

The sandbox findings below were gathered on 2026-09-03 and, where they concern this
machine, verified locally.

The blocking finding is issue #82660, described in section 3.5: the operation Chromium
needs is mach-register, no SDK or settings key emits `(allow mach-register ...)`, and
the only offered workarounds fully unsandbox the browser. The paired positive is
recovery child `8a65087e`, which launched Chromium with `--single-process` and looked at
sliced full-page screenshots (FINDINGS §1:60-63).

A containerised renderer cannot be started from inside a sandboxed build seat. The
Claude Code sandboxing documentation states that "docker is incompatible with the
sandbox. Add `docker *` to excludedCommands to run it outside the sandbox", and warns
that allowing access to the Docker socket "effectively grants access to the host system
through the Docker socket" (https://code.claude.com/docs/en/sandboxing, read
2026-09-03). So if the renderer is a container, the orchestrator starts it, not the seat,
which is the same conclusion WebGen-Agent's architecture reaches from the other end.

The renderer-outside-the-seat route is documented by Playwright itself. The official
image `mcr.microsoft.com/playwright:v1.62.0-noble` ships the browsers and their system
dependencies, recommends `--init` and `--ipc=host` with Chromium, and supports running a
Playwright Server in Docker while the client stays on the host, connecting over
`browserType.connect()`. The constraint to design around is version pinning: "The major
and minor version of the Playwright instance that connects needs to match the version of
Playwright that launches the browser" (https://playwright.dev/docs/docker and
https://playwright.dev/docs/api/class-browsertype, read 2026-09-03), which is the same
discipline our scorer image digest already imposes. Microsoft's Playwright MCP publishes
`mcr.microsoft.com/playwright/mcp`, supports `--isolated`, and carries a design opinion
worth taking: "Uses Playwright's accessibility tree, not pixel-based input", and "You
can't perform actions based on the screenshot, use browser_snapshot for actions"
(https://github.com/microsoft/playwright-mcp, read 2026-09-03). Google's
chrome-devtools-mcp can attach to an already-running Chrome via `--browser-url`
(https://github.com/ChromeDevTools/chrome-devtools-mcp, read 2026-09-03), which
sidesteps #82660 entirely.

Two routes are closed for an unattended seat. The vendor's own browser integration is
deliberately not headless and is unavailable under API-key authentication: "Browser
actions run in a visible Chrome window in real time", it requires a direct Anthropic
plan, and "If you authenticate with an API key or a long-lived token from
claude setup-token, Claude Code keeps Chrome integration off, even when you pass
--chrome" (https://code.claude.com/docs/en/chrome, read 2026-09-03). And every MCP route
costs a policy change here, because our build seat sets `allowedMcpServers: []` with a
docblock that states the intent: "A BUILD KEEPS NONE OF THIS. It writes code in a
workspace; it has no business deploying, driving a browser, or spawning a remote agent"
(`dashboard/server/src/builders/claude-builder.ts:1005-1007`). Two open issues also show
that an egress proxy breaks browsers even when they launch, #85757 (opened 2026-08-11)
and #90521 (opened 2026-08-29), which argues for pointing any renderer at a loopback dev
server or a route-interception path rather than through the proxy, exactly as
`8a65087e` did. Codex's Seatbelt rule set could not be read: two raw source URLs returned
HTTP 404 on 2026-09-03, so whether Codex allows mach-register is unverified.

**Therefore.** The transfer is architectural, not a sandbox patch. The renderer is owned
by the orchestrator and lives outside the seal; the seat receives a description, a score
and suggestions, or the capture files themselves; and the sandbox knobs are needed only
if a browser is wanted inside the seat, in which case they must be paired with
single-process Chromium. Host captures cost no policy change; the MCP route costs a
policy change and a docblock rewrite.

---

## 5. The blind spot in the internal study

### 5.1 Prior-art findings it had no way to know

**Its own first experiment will report a phantom result at n=1.** VCB's variance
decomposition puts 73.5% to 92.5% of total variance on the generation side with
generation standard errors of 3.47 to 5.00 points, against evaluator standard errors of
0.99 to 3.00 (RESEARCH §3.9:240), and the Copy paragraph says so directly (§3.9:242).
The internal study ranks five causes from one source run, one continuation and two
recovery children, with no variance estimate anywhere.

**Its framing device has a measured base rate.** CATTest is 102 web applications
generated in a single pass by Claude Code backed by Claude-Opus-4.6, with 190
human-verified functional bugs annotated on top; the project-level pass rate is 22.55%,
meaning 77.45% carry at least one confirmed functional bug, and the worst category is
Marketing/Landing at 100% (RESEARCH §5.8:399). The delivered artefact is a
marketing and landing page. That does not overturn the owner's judgement, and it does
qualify it: part of the observed gap may be the configuration's base rate. Use the
corpus and never its scores, since both CATJudge lenses were refuted and two reads of
the distributed bug file returned different counts (RESEARCH §5.8:405, §8).

**Its stack is the one the pack measures worst.** ByteDance's Multi-SWE-bench ran one
scaffold across languages with the same model and got Python 52.20%, JavaScript 5.06%
and TypeScript 2.23%, attributing it to struggles with "long-lived, interactive
processes, often resulting in premature termination or container crashes", and the
external study adds "Our builds are Next.js dev servers" (RESEARCH §3.6:192). That
qualifies one of the recorded rejections without overturning it.

**Its cause 2 fix is an open research problem, not a wiring task.** RESEARCH §7.6:479
lists design and taste verification by an independent grader among the seven unsolved
problems, with VCB's judge agreement spanning 36.1% to 86.4% depending on the model and
WebGen-Bench's appearance score coming from a single screenshot of the root path at 768
px. The internal study proposes "A rendered-quality judge that runs before done"
(FINDINGS §2:94-95) as an implementation item.

**Three metrics and mechanisms it never considers.** `falseAbort` (RESEARCH §5.4:353)
appears in zero source files in this repository, which I verified: the only two files
containing the string are the research document and its evidence pack. Yet `infra` is
already a live stop reason at `dashboard/server/src/creative-recovery.ts:48`, so the
third gate outcome is half shipped and the mirror metric is absent. The escalation
channel (RESEARCH §5.9:411-413) is the return path that cause 4's better-error-message
fix omits: a seat that could only move attributes for the probe did exactly that and
still died. The model-free replay harness (RESEARCH §5.10:423) is the missing validation
route for every fix the internal study proposes, with the detail that makes it survive
being that the fixture hash key excludes the system prompt.

**Critic qualification has no corpus pointed at it.** `tools/tier3/known-bad.mjs:43`
sets `KNOWN_BAD_FLOOR = 12`, and I confirmed the floor; the entries are gate, scorer and
manifest fixtures. No critic seat has ever been shown a build it should fail, which is
what lesson 5.5 asks for.

**Continuation provenance is unexamined.** Covered in section 3.8: the two lanes carry
opposite policies and `.bakeoff` is excluded by neither. mini-swe-agent issue #787
measured 21% of Opus 4.6 runs mining git history for the gold fix (RESEARCH §3.5:172),
which is the general warning.

### 5.2 Which rejected findings to revisit

The recorded six are at FINDINGS :197-211; three more were claimed and not written down,
and must be recovered first.

- **Revisit: "Graders outspend the page-writer. True and causally inert."** Re-ask it as
  discrimination rather than spend. The prior art makes model tier a measurable property
  of critics, with forced-haiku reviewers flagging 0 of 10 planted defects at correct
  severity and Opus controllers passing 2/2 against Sonnet controllers at 1/5
  (RESEARCH §5.5:363). The internal study only ever asked about the builder's rung.
- **Revisit: "MCP servers stripped as the binding cause. True, but the binding cause is
  the single JS-rendering reader aimed at the wrong URL."** The rejection is right on the
  facts for the content defect. It should be qualified twice: the JS/TS long-lived-process
  failure class is broader than a wrong URL (RESEARCH §3.6:192), and the MCP denial is
  precisely the route every prior-art system uses to give an agent a browser, so
  `allowedMcpServers: []` is a live design choice rather than an inert fact.
- **Partly revisit: "No owner channel for content facts. The plan seat exists and
  fired."** The rejection holds on cause. What the internal study could not know is that
  a structured escalation tool is the sanctioned exit for "I cannot produce what you
  require" (RESEARCH §5.9:411), and nothing currently routes content-fact doubt into the
  channel that does exist.
- **Stay rejected on this evidence:** video lane harm, font prohibition, and the
  ticket-less build prompt read as a budget problem. The last is reinforced by the
  document's own cause 3, which says the brief is frozen into direction and contract
  rather than lost.

**Action.** Recover the three unrecorded rejections, then re-open the two named above
with their questions changed.

---

## 6. The combined priority list

This supersedes both documents' separate lists. Ranked by expected value with the
internal evidence taken into account.

**1. Make the rendered critic complete on one run, and give it a pre-DONE re-entry rule
the orchestrator owns.**
Support: both studies plus the fresh sweep. Evidence: four judges exist and zero have
produced a gating verdict (FINDINGS §2:73-77, :95-96; RESEARCH §7.6:479); WebGen-Agent's
architecture, where the workflow renders and a separate model returns a description, a
score and suggestions into the coding model's trajectory
(https://arxiv.org/abs/2509.22644, 2025-09-26); a supporting datapoint from Anthropic's
harness-design post, that "tuning a standalone evaluator to be skeptical turns out to be
far more tractable than making a generator critical of its own work", which is
pack-sourced from `evidence-pack.json:1800`, was not re-opened for this comparison, and
sits behind a profile the prior-art study dropped for being n=1 per condition with no
released code (RESEARCH §2.2:75); `/goal` as a shipped per-turn completion veto that runs
under `-p`, with the evaluator unable to run commands and the hook overridden after 8
consecutive blocks
(https://code.claude.com/docs/en/goal, read 2026-09-03). Stage: creative review lane and
the orchestrator's DONE handler. Risk: the critic is unqualified, which is this
repository's signature defect arriving in the review layer; and the appearance gain in
the only ablation available is 3.0 to 3.6, not a step change.

**2. Hand the builder and the fix seat the host's existing captures at segment
boundaries, and remove the fix prompt's self-contradiction.**
Support: FINDINGS cause 1's second fix shape, unchanged by the sandbox correction.
Evidence: the pipeline already renders at 375, 768 and 1280 in the sealed scorer and no
code path shows the captures to the builder or fixer; `fix-prompt.ts:62-99` masks any
path-shaped visual detail and `:144` tells the fixer "the renderer is not available to
you", while the same prompt for the same failure class still ends
"render that flow at that breakpoint yourself and look at it" (FINDINGS §1:52-58 and the
executed fixture table at :274-283). Stage: build and fix seats. Risk: Design2Code says a
render alone, without a scoring critic and a mandatory re-entry, buys close to nothing;
do this with item 1, not instead of it.

**3. Run the empty-scaffold negative control against the existing frozen suite.**
Support: RESEARCH §5.1:317; the internal study supplies the predicted result. Evidence:
it costs one sealed container and no model call, and it is the first probe in either
study with a real negative control; RESEARCH §8:493 already lists it as the way to settle
whether the gate can go green with zero tests executed. Stage: adversarial audit before
freeze and seal, plus one manifest field. Risk: it will not flag REQ-007, for the reason
in section 2.4, so it must not be sold as coverage for content criteria.

**4. Persist a runtime-owned receipt ledger, and make DONE a claim the orchestrator can
refuse.**
Support: RESEARCH §5.2, upgraded by a repository fact neither study used. Evidence:
`claude-common.ts:262-282` already parses every `tool_use` block and `:295-299` carries
the structured result, so this is persistence rather than new capability; DeerFlow's own
framing is our metric, "a run that did nothing but reports success is indistinguishable
from one that did the work" (RESEARCH §3.11:262). Stage: builder and fix seats plus the
DONE handler. Risk: without the two amendments in section 2.5 it does not catch the
measured instance; and copy DeerFlow's limitation string so a receipt is never read as
endorsement.

**5. Fix one continuation policy and apply it to both lanes.**
Support: FINDINGS cause 4's fix shape, RESEARCH §5.3:341 and §3.8:218, plus the
verified divergence in section 3.8. Evidence: the continuation re-ran a canvass and an
expansion segment because the copied manifest carried absolute paths into the old run's
directory, spending 32 of 59 builder turns and about 96k of 114k output tokens
re-validating a byte-identical design (FINDINGS §4:156-165). Stage: `run-continuation.ts`
and `creative-recovery.ts`. Risk: the recovery test pins preservation deliberately, so
this needs an owner ruling before code.

**6. Give every refusal a typed status, add the fix ladder's written adjudication, and
give the seats an escalation tool.**
Support: RESEARCH §5.6:377, §5.9:411, §3.5:178; FINDINGS cause 4. Evidence: the motion
probe's refusal "carries no explanation" (`creative-render.ts:1073`) and the last
recovery attempt died on `m-contact-state` after one allowed repair (FINDINGS §4:167-173).
Stage: fix seat, marker-repair lane, and the existing `awaiting_input` dashboard path.
Risk: both lenses on the escalation-channels paper were refuted, so adopt the tool shape
and treat its effect size as unverified.

**7. Add `falseAbort` in shadow mode and finish the third gate outcome.**
Support: RESEARCH §5.4:353; the internal corpus supplies the replay set. Evidence:
`falseAbort` is in zero source files while `infra` is already a live stop reason at
`creative-recovery.ts:48`; recovery child `8a65087e` is the only artefact in the corpus
built by a seat that could see its own page and it was discarded on a marker-repair rule
with nobody measuring it (FINDINGS §1:60-63, §4:153-154). Stage: sealed gate, fix-seat
budget accounting, metrics record. Risk: an inconclusive state is where real failures
hide, so it needs its own alarm.

**8. Import CATTest as the known-bad corpus, then qualify the critic seats against it.**
Support: RESEARCH §5.8 and §5.5. Evidence: the current floor is 12 gate-shaped fixtures
(`tools/tier3/known-bad.mjs:43`); CATTest supplies 102 real Claude-Code-authored web apps
with human-confirmed defects (RESEARCH §5.8:399). Stage: offline self-diagnosis tier.
Risk: verify the distributed bug file first, use the corpus and never its scores, and
sequence the qualification battery behind item 1 so the flag rate is measured on a seat
that fires.

**9. Add a content-specificity admission rule at freeze, paired with rendering every
binding URL.**
Support: neither document as written; it is the synthesis the REQ-007 instance forces,
using RESEARCH §3.10:256's mechanism reversed and FINDINGS §3:139-141's fix shape.
Evidence: section 2.4. Stage: spec seat and the freeze-time audit, plus `site-capture.ts`.
Risk: the rule has nothing to bind to unless the fact source is rendered first, so the
two ship together or not at all.

**10. Test the sandbox knobs paired with single-process Chromium, with replicates.**
Support: FINDINGS cause 1's first fix shape, corrected by issue #82660 and by the
measured success of `8a65087e`. Evidence: section 3.5. Stage: builder options. Risk: the
knobs alone will not launch default-flag Chromium; and VCB's variance decomposition means
a single run per arm cannot separate the effect from noise (RESEARCH §3.9:242).

**11. Instrument coordination cost, re-keyed from gate state to workspace state.**
Support: RESEARCH §5.11:437, re-keyed on the internal evidence. Evidence: 5.11's trigger
is "cumulative tokens without a change in gate state", and the largest measured block of
wasted builder spend happened pre-gate, in segments scheduled before building
(FINDINGS §4:162-165). Note that spend is already measured per seat and the gap is the
run-row aggregation, since `writeRunSpend` has no production caller (FINDINGS §5:191-193),
and whether cumulative spend is available to the orchestrator mid-run is unestablished in
both documents. Stage: metrics record, anti-loop, per-seat budgets. Risk: the bands come
from a self-run study with 20-instance subsets (RESEARCH §5.11:441).

**12. Adopt the model-free replay harness as a guard on items 1 to 11.**
Support: RESEARCH §5.10:423. Evidence: it would have caught cause 3's prompt-assembly
mechanism as a red test, because the build segment resumes the design session so
`dashboardBuilderPrompt` is never sent (FINDINGS §3:118-124). Stage: offline repair tier
and the harness test suite. Risk: replay proves plumbing, not model behaviour, and must
never be presented as evidence that a prompt change improved anything.

**13. Run the effort comparison, with replicates.**
Support: my proposal, not the internal study's; cause 5 proposes nothing. Evidence:
section 3.6. Stage: `models.ts`. Risk: highest variance, lowest prior, and the pack cannot
answer it.

### 6.1 Which of the eleven ranked lessons drop, and why

- **5.1 drops from first.** It does not catch content criteria, and the concrete instance
  the internal study measured is one it certifies as discriminating. Ship it for vacuity
  only; it becomes item 3.
- **5.7 drops.** A per-criterion ratio over 342 criteria that never mention palette,
  typography, hierarchy or composition (FINDINGS §2:86-87) gives the fix seat a sharper
  gradient pointing in the wrong direction. It should land after a criterion class exists
  for rendered quality.
- **5.10 drops to a guard.** It validates the fixes; it is not one.
- **5.11 changes rather than drops.** Re-key the trigger from gate state to workspace
  tree or resolved manifest, and drop the claim that its data source does not exist.
- **5.4 splits.** The metric is a shadow-mode replay against the existing corpus; the
  inconclusive outcome should extend to verdict-less judge outcomes, not only to gate-time
  infrastructure.
- **5.2 rises.** The receipt stream is available today off `claude-common.ts:262-282`,
  which was an open question in both documents, but it needs per-claim-class typing and
  the acceptance layer.
- **5.5 stays where it is but is resequenced** behind a critic that fires.
- **5.8 does not drop.** It is a cheap corpus import with no critic dependency.
- **5.3, 5.6 and 5.9 keep their places**, with 5.3's continuation item resolved by an
  owner decision rather than adopted verbatim.
- **The new number one is in neither list.**

---

## 7. Method and limits

This comparison was made by reading both documents in full, then running five
cross-document lenses (convergence, contradiction, coverage gaps in each direction, and a
method comparison), one fresh sweep on build-time visual feedback, and an adversarial
verification pass over the fourteen highest-value cross-document claims. Of those
fourteen, eleven were refuted and three survived with corrections; all fourteen carry a
corrected version, and this document uses only corrected versions. The refutations were
substantive rather than clerical: they overturned the claim that lesson 5.1 would have
certified the measured test as vacuous, the claim that `falseFinish`'s blind spot is
visual-only, the claim that the comparison matrix is the sentence that must change, the
claim that cause 3 collides with lesson 5.3, the claim that lesson 5.8 depends on a critic
that fires, and the attribution of "That is the first experiment" to cause 5. I
independently re-opened the repository facts that the unverified lenses supplied, and
five of them are cited above with the line I read.

What neither study nor this comparison has measured. No chat-produced artefact exists in
evidence anywhere, so the gap the internal study explains has no measured size. No run has
been produced with a renderer available to the build seat, with the sandbox knobs set, or
with host captures handed over. No critic seat has ever produced a gating verdict, so
whether the Taste Critic prompt would surface real defects is unknown, and no persisted
critic output exists to inspect. The empty-scaffold control has never been run against the
frozen suite, so the vacuous-test count is unknown. `falseAbort` has never been computed.
Whether cumulative per-seat spend is available to the orchestrator mid-run is unestablished
in both documents. Whether per-tool-call receipts survive in the session transcript JSONL,
as opposed to `build.log` where they do not, is unsettled. And every effect size in section
4 is self-reported by its authors, none is organiser-checked, none has an independent
replication, and the largest number available on our task shape, VCB's r = 0.72 for browser
tool calls against r = 0.09 for edit calls (RESEARCH §3.9:240), is correlational.

Two limits on the sweep itself. Its web-search budget was exhausted before it began, so it
fetched known URLs only and will have missed systems a keyword search would surface.
Codex's Seatbelt rule set could not be read, two raw source URLs having returned HTTP 404
on 2026-09-03, so no claim is made about whether it permits mach-register. And the external
study's own transfer warning applies to everything quoted from it here: the pack is
weighted toward Python and SWE-bench-shaped tasks, and "transfer of any number in this
report to our Next.js workload should be assumed poor" (RESEARCH §9:518).

---

## 7A. What the cross-session exchange produced, credited to neither study

These four items came out of a disagreement between the two sessions on 2026-09-02 and
2026-09-03, after both documents were written. Every one was verified in this session
against the code, `dashboard/data/runs.db` or by execution, not relayed from the peer.

**7A.1 Delegation is three mechanisms, and only one is unavailable.** The prior-art study
said Claude Code agent teams are unavailable under `-p`, and drew from that the conclusion
that the lead-plus-workers pattern is unavailable here. The second clause was too strong.
Agent-tool delegation runs headless and is already in production: source run `3c0e92be`
carries eight `"name":"Agent"` events, the first at seq 101 spawning `taste-frontend-expert`
with `attribution: "exact"`. What is unavailable is the branded feature with named
teammates, a file-locked shared task list and JSON mailboxes. Peer messaging sits between
the two: available on the platform, refused here by our own policy.

**7A.2 A refusal that carries a working remediation, five for five.** Every `SendMessage`
attempt in the entire events table was denied by our `PreToolUse` hook, whose string is
authored at `delegation-hook.ts:225` with `AGENT_MESSAGE_TOOL_NAMES` at `:198`. There are
five, at `fccefcee`@265, `e1c15359`@293, `6a39e96e`@339, `b1219c2d`@422 and `3c0e92be`@251,
and zero allowed. In all five the next tool event is immediately adjacent and is an Agent
delegation preserving the blocked message's intent: 266 "Fix field-notebook work still",
294 "Retry margin-notebook work still", 340 "Retry editorial-ledger footer still", 423
"Expand warm-editorial full page", and 252 "Fix two work stills" against a blocked message
of "Regenerate two work stills, taste findings". The denial string tells the model to start
a fresh delegation with the Agent tool, and the model does, every time, with no intervening
turn. This is an existence proof on our own substrate for a property no profiled system
reports: whether a refusal tells the agent what to do instead. It bears directly on item 6
of section 6 and on RESEARCH §5.9, where the profiled escalation channel returns a fixed
receipt engineered to reveal nothing and whose results were refuted.

**7A.3 The fix prompt's contradiction is pinned green by two tests, and that is the sharper
defect.** Section 6 item 2 records the contradiction. What it does not record is why a green
suite cannot see it. Both sides are asserted, separately, by tests that pass:
`fix-prompt.test.ts:131` asserts `doesNotMatch(p, /and look at it\./)`, its comment
restating the impossibility principle and the `54927ebc` measurement; `fix-prompt.test.ts:198`
asserts `match(p, /render that flow at that breakpoint yourself and look at it/)`, on the
equally sound ground that a redaction reading as "there was nothing to say" is its own lie.
Both call the same `visualPrompt()` helper with different detail fixtures, so neither probe
can observe the other. Executed in this session against `dist/fix-prompt.js` with the suite's
own two fixtures: the no-path fixture yields a prompt containing "YOU CANNOT SEE THE PAGE"
and not the imperative; the path-shaped fixture yields a prompt containing both. The
path-shaped case is the common one, because these findings are written about captures.
This repository's catalogued signature defect is a check that can only observe success.
This is a new species of it: two checks that are each correct in isolation and jointly
incoherent, invisible to a green suite. It belongs in the known-bad corpus of section 6
item 8 as a first-class entry.

**7A.4 A platform constraint on how finely any Claude Code system can police delegation.**
The target agent's id appears only in the Agent tool's result and never reaches
`PreToolUse`, so a hook inspecting a `to` field judges a display name against nothing. That
is why the denial in 7A.2 has to be blunt rather than selective. It is a property of the
SDK rather than of this pipeline, so it applies to any system in the prior-art matrix built
on the same substrate, and it is a reason to expect refusal quality, not refusal precision,
to be the tractable lever.

## 8. Sources

**The two documents compared**
- `/Users/kamilborzecki/Projects/coding-agent/docs/RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md` (written 2026-09-02, fact-check applied 2026-09-03, compared against this repository at commit `c4c9f37`)
- `/Users/kamilborzecki/Projects/coding-agent/docs/FINDINGS-2026-09-02-pipeline-vs-chat.md` (`verified_at_commit: e5f9ce4`, `verified_on: 2026-09-02`)
- `/Users/kamilborzecki/Projects/coding-agent/docs/research/prior-art-2026-09-02/evidence-pack.json` (the raw evidence for the prior-art profiles; referenced by the coverage lenses and not re-opened for this comparison)

**Repository facts re-opened for this comparison, on 2026-09-03**
- `dashboard/server/src/claude-common.ts:262-282` (`toolUses`) and `:295-299` (`SdkToolResult`)
- `dashboard/server/src/run-continuation.ts:19` (`EXCLUDED_DIRECTORIES`) and `:55-58`
- `dashboard/server/src/creative-recovery.test.ts:436-452` (terminal recovery preserves `.git` and `.bakeoff`)
- `dashboard/server/src/creative-recovery.ts:48` (`GATE_STOP_REASONS` includes `infra`)
- `dashboard/server/src/builders/claude-builder.ts:1005-1007` (`allowedMcpServers: []` and its docblock)
- `dashboard/server/src/fix-prompt.ts:62-67` and `:143-146`
- `dashboard/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2749-2752`
- `tools/tier3/known-bad.mjs:43` (`KNOWN_BAD_FLOOR = 12`)
- `dashboard/acceptance/t-cbf387df97b9b6dd/suite/holdout/page-content.spec.mjs:39-76` and `:186-192`
- Repository-wide grep for `falseAbort`: two matches, both documents, zero source files

**Build-time visual feedback, fetched 2026-09-03**
- https://arxiv.org/abs/2509.22644 WebGen-Agent (2025-09-26)
- https://arxiv.org/abs/2505.03733 WebGen-Bench (2025-05-06)
- https://arxiv.org/abs/2403.03163 Design2Code (2024-03-05, NAACL 2025)
- https://arxiv.org/abs/2410.16232 Sketch2Code (2024-10-21)
- https://arxiv.org/abs/2603.04601 Vibe Code Bench (cross-referenced from the prior-art study)
- https://github.com/stackblitz-labs/bolt.diy
- https://cursor.com/docs/agent/browser
- https://code.claude.com/docs/en/chrome
- https://code.claude.com/docs/en/goal
- https://antigravity.google/docs/ide/browser
- https://docs.stagewise.io/ ; https://github.com/onlook-dev/onlook ; https://v0.app/docs
- https://arxiv.org/abs/2401.13649 VisualWebArena (included for observation machinery only)

**Sandbox mechanics, fetched 2026-09-03**
- https://github.com/anthropics/claude-code/issues/82660 (opened 2026-07-30, open); related #14881, #29533, #85757 (2026-08-11), #90521 (2026-08-29)
- https://code.claude.com/docs/en/settings-reference
- https://code.claude.com/docs/en/sandboxing
- https://playwright.dev/docs/docker and https://playwright.dev/docs/api/class-browsertype
- https://github.com/microsoft/playwright-mcp
- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://learn.chatgpt.com/codex/sandboxing (Codex's own Seatbelt rule set could not be read; two raw source URLs returned HTTP 404 on 2026-09-03)
