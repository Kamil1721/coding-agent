# DESIGN — THE SELF-MAINTAINING PIPELINE

Written 2026-08-10. Read-only round: nothing outside this file was created or edited.

**Every claim about the current system carries the command or `file:line` that produced
it. Everything else is marked PROPOSED.** Where a grounding agent supplied a reading I
did not re-measure, it says so.

> ### THE TREE MOVED UNDER THIS DOCUMENT, AND IT MOVED IN OUR FAVOUR
>
> A concurrent workflow was editing `bakeoff/src` and `dashboard/server/src` while this
> was measured. `git status --porcelain | wc -l` → **40 modified**, `git log --oneline -1`
> → `3d01c2c`, nothing committed. Five items from `STATE` §6 are **already in the working
> tree and absent from HEAD**:
>
> | item | worktree | HEAD |
> |---|---|---|
> | N1 — populated `dataExpectations` example in the authoring prompt | `spec-agent.ts:135-165, :359, :415-423` (`MANIFEST_DATA_EXPECTATION_EXAMPLES`, both `sqlite` and `http`, all seven fields named) | `git show HEAD:bakeoff/src/spec-agent.ts \| grep -c minRows` → **0** |
> | N3 — collect-all manifest validation | `scorer-protocol.ts:880 collectManifestProblems`, consumed `spec-validate.ts:1317` | `git show HEAD:bakeoff/src/scorer-protocol.ts \| grep -c collectManifestProblems` → **0** |
> | N4 — structural vs attributed remediation | `spec-agent.ts:1527-1528` (`criterionId === null` split) | absent |
> | R1 — orchestrator heartbeat | `orchestrator.ts:3167` armed, `:6517 #armHeartbeat` | absent |
> | R3 — the no-capture emitter | `orchestrator.ts:2983` | absent |
>
> **This design does not re-propose any of them.** It is written for the tree that
> exists. Every line number below is from that tree and will drift; re-grep before
> implementing.

> ### CORRECTED 2026-08-10 (LATER THE SAME DAY) — THE TREE MOVED AGAIN, AND THIS DOCUMENT WAS PARTLY BUILT
>
> Five of this design's sections were implemented in a build round on 2026-08-10 by five
> parallel lanes, a verifier, a reviewer and a repair pass. **HEAD is now `d32ad85`, and
> the repo has exactly one tag.**
>
> ```
> git rev-parse --short HEAD                                → d32ad85
> git tag -l                                                → gate-verified-2026-08-10
> git rev-parse gate-verified-2026-08-10^{commit}            → d32ad858fc8bdcbf84e9731f993fa902b041d913
> ```
>
> Two consequences for reading the rest of this file:
>
> 1. **§9's STEP 0 is FALSIFIED.** It says *"the repo has zero git tags, so there is nothing
>    to seed that pointer with"* and *"nothing in §6 can be built until that round lands and
>    is tagged."* The round landed and was tagged; steps 8–15 are unblocked by the design's
>    own rule. Corrected in place at §9.
> 2. **The line numbers in §§3–8 are from the pre-round tree and have drifted by hundreds of
>    lines in `orchestrator.ts` and `http.ts`.** Every dated `IMPLEMENTED 2026-08-10` block
>    below carries re-measured anchors; anywhere else, re-grep.
>
> Where the implementation departs from what is proposed here, the departure is recorded at
> the section it touches — §3.4 (a fourth comparator arm the design does not have), §5.1
> (the shipped record is not this shape), §6.7 (the trail is written somewhere else, on
> purpose), §7.3 (the loop grew an attempt cap the design's step list omits), §7.6.2 (three
> of the seven fields have no producer). The full build report, the operator's page and the
> unflinching not-proven list are `STATE-2026-08-09-where-we-are.md` §7.

---

## 1. THE ASK, AND WHAT IT MEANS TECHNICALLY

The owner, verbatim in substance:

> *"Make it self-maintaining. It overcomes edge cases intelligently and does not stop. Or
> if it has to stop it resolves them and then continues. It does not wait for me to
> intervene and put out a fix. It needs to be self-improving — rather than us typing here
> in the chat, it does that itself to fix itself. I want Tier 3 autonomous as well.
> Additionally I want it trained on its own data, so it learns from itself. I can hit
> start and stop on the dashboard somewhere. There should not be a point where it stops on
> its own and requires me to boot it up. The only exception is if localhost stops."*

### 1.1 The translation, clause by clause

| the ask | what is being built |
|---|---|
| *"does not stop"* | **Tier 1.** Per-failure-class retry budgets replacing one collapsed class at bound 0; a fingerprint anti-loop rule; ceiling escalation; timeouts that resolve to defaults instead of parking. §4. |
| *"if it has to stop it resolves them and then continues"* | **Tier 2.** A structured defect record written at the throw site, a repair agent that reproduces → fixes → mutation-proves, and a patch queued with evidence. §5. |
| *"does not wait for me to put out a fix"* | **Tier 3.** The patch applies itself behind a gate whose failing arm is the whole design. §6. |
| *"start and stop on the dashboard"* | **The supervisor.** A durable ticket table, an in-process loop, and a `desired` state that survives restart. §7. |
| *"trained on its own data"* | **Not fine-tuning.** §1.2. |
| *"no point where it stops on its own"* | Never-park submission, poll-not-timer waits, boot reconcile with a terminal `else`. §7.4. |
| *"the only exception is localhost"* | Costed in §7.7, not built. |

### 1.2 "Trained on its own data" is NOT fine-tuning, and saying otherwise would be a lie

There is no fine-tuning on the subscription path. The seats drive the Claude Agent SDK
binary as a host subprocess — the a913c871 post-mortem measured the live process
(`ps eww -p 44002` → `…/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
`RUN-a913c871-observations.md:200-201`). The weights are the vendor's. Nothing on this
machine can move them. **Anyone who designs a training pipeline here is designing a thing
that cannot be built.**

What is being built instead is two loops, §8:

- **FORWARD — a prompt-resident exemplar corpus.** Knowledge this installation already
  owns, re-entering as bounded, class-keyed exemplars in a seat's user turns. Not
  learning in the weights sense; it does not generalise past a retrieval key. But it is
  exactly the a913c871 defect: the one correct populated `dataExpectations` entry existed
  verbatim at `bakeoff/docker/README.md:391` while the seat that needed it was never shown
  it.
- **BACKWARD — a frozen test set that grows from real runs.** Every real verdict clearing
  an oracle that is *not the scorer* is promoted into the calibration fixture set. The
  examiner gets stricter over time.

**The honest framing for the owner: the system does not get smarter. It gets less able to
repeat itself, and its examiner gets harder to fool.** Claiming more would be this
repository's signature defect — a check that can only observe success — wearing the word
*learning*.

### 1.3 The integrity constraint, restated as the thing that shapes §6

A system that can rewrite its own grader can pass its own tests. `heldOutPass` is worth
something only while the builder cannot reach the suite and the grader cannot be softened.

**The brief's partition — editable = `bakeoff/src`, frozen = fixtures + baseline + gate —
is not disjoint, and this is a correction to the brief, not a quibble.** Measured:

```
cd bakeoff/src && for f in gate.ts scorer.ts scorer-container.ts tier0.ts scorer-protocol.ts \
  contracts.ts hash.ts redact.ts config.ts spec-freeze.ts spec-types.ts; do
  printf "%-22s " "$f"; grep -o 'from "\./[a-z0-9-]*\.js"' $f | sort -u | tr '\n' ' '; echo; done
```

`contracts.ts` holds `computeHeldOutPass` (`grep -n "export function computeHeldOutPass"
bakeoff/src/contracts.ts` → `:1433`). `spec-freeze.ts` decides which half of the suite is
held out. `scorer-protocol.ts:590` is `parseSuiteManifest`. All of it is compiled into the
image that decides the verdict (`scorer.Dockerfile:78-79`). **A by-directory partition is
defeated without touching a single frozen path.**

§6 derives the partition **by import closure**. The payoff, and it is the strongest
measured argument in this document: **the a913c871 repair — `spec-agent.ts` and
`spec-validate.ts` — is outside the closure.** The system can fix its own worst known bug
at full autonomy without ever proposing a frozen-path write.

---

## 2. THE WORKED EXAMPLE — RUN `a913c871`. THIS SECTION IS THE DESIGN'S ACCEPTANCE TEST

### 2.1 What happened

`run-2026-08-09T21-04-00-713Z-a913c871`. Died `22:31:04.532Z`, **1h26m54s**, phase `spec`.

```
sqlite3 "file:dashboard/data/runs.db?mode=ro" \
  "select status,phase,recovery_class,auto_continue_count,length(ticket_text) from runs
   where run_id like '%a913c871';"
→ failed|spec|structural|0|13714
```

Three authoring attempts, each rejected by the bad-test audit on `dataExpectations`. Root
cause, from the post-mortem (`RUN-a913c871-observations.md:330-394`): the seat was ordered
to emit a populated `dataExpectations` and never shown its shape; `parseSuiteManifest`'s
`fail()` is typed `never` (`scorer-protocol.ts:508-510`), so each rejection named one
field of seven. Attempt 1 emitted `{entity,source,expectation}`; attempt 2 added `id`;
attempt 3 added `kind` **and lost `id`**. Arithmetically impossible.

Then nine hours of owner time and a manual post-mortem.

### 2.2 What the designed system does, minute by minute

Marked **[LANDED]** where the mechanism is in the working tree today, **[T1/T2/T3]** where
it is proposed at that tier.

| clock | today | designed |
|---|---|---|
| 21:04:00 | run created, `interactive=1`, plan seat parks at 21:04:17 | **[T1/§7.4]** a supervisor submission carries `designLock:"auto"` and no `Referer`, so `planPolicy(false)` → `"skip"` (`plan-record.ts:111-113`) and **the park never happens**. The 13,714-char brief already carries both rounds of folded Q&A. |
| 21:06:29 | phase → `spec` | same |
| 21:06:30–21:31:52 | authoring attempt 1, 25m23s, silence | **[LANDED]** the R1 heartbeat (`orchestrator.ts:3167`) emits *"…has been working for N minutes"*. **[T1/§4.4]** the attempt boundary is an event, not a CLI-transcript reconstruction. |
| **21:31:52** | attempt 1 rejected on `dataExpectations[0].id` alone. Attempt 2 begins and spends 35m25s. | **[LANDED, N1+N3]** attempt 1 would probably not have failed at all — the prompt now carries both worked examples with all seven fields (`spec-agent.ts:135-165`). If it did, `collectManifestProblems` (`scorer-protocol.ts:880`) names **every** offending field in one rejection, not the first. **[T1/§4.3]** the fingerprint is recorded: `{invalid_usage_shape, collectManifestProblems, [id,kind,minRows,…], criterionId=null}`. |
| 22:07:19 | attempt 2 rejected on `kind` | **would not occur.** If it did: the violation path set is a proper **subset** of attempt 1's → the *shrink* arm → attempt 3 is legitimate spend. |
| **22:31:03** | attempt 3 adds `kind`, **loses `id`**, run dies | **[T1/§4.3] the oscillation arm fires at attempt 2 and attempt 3 is never spent.** A path that was fixed reappeared; the feedback channel is proven non-convergent. No counter can see this — the budget was never exceeded. Escalate. |
| 22:31:04.532 | `status failed`, `recovery_class=structural`, `boundFor("structural") → 0` (`recovery.ts:146-147`), run parks for the owner | **[T2/§5]** `settle()` fires on the terminal transition, writes a **defect record at 22:31:05** carrying the failure verbatim, the fingerprint, the authoring trail and the throw site, and moves the ticket to `repairing`. **The nine-hour manual post-mortem becomes a row written one second after death.** |
| 22:31 → 22:4x | nothing | **[T2]** repair agent reproduces from the record, patches, mutation-proves, queues. Both candidate paths (`spec-agent.ts`, `spec-validate.ts`) are **outside the grader closure** (§6.1). |
| 22:4x | — | **[T3/§6.3]** gate: arm check → frozen-manifest verify → rebuild → recalibrate 7 fixtures → re-score run 1 to `heldOutPass=true, 21/20/1, sole REQ-013 QUALITY` → known-bad set stays red → apply token → apply. |
| next | owner types the fix at ~07:00 the following morning | **[T1/§7]** the supervisor re-submits the same 13,714 chars. Nothing to reuse (`suite_sha256=''`), so it correctly pays a fresh spec phase. |

### 2.3 The verdict, stated as the brief demands

**Detected at 22:31:04 and routed to a repair record at 22:31:05, instead of dying at
22:31:04 and waiting nine hours.** Patch gated and applied within the same hour; the next
run starts unattended.

**And the honest limits, which are the more useful half:**

1. **The corpus would not have saved the first occurrence.** N1 — showing the shape — is
   what fixes that, and it has landed. The corpus's narrower claim is that the *second*
   occurrence of any class never costs an attempt.
2. **The gate's negative control is vacuous in exactly this area.** No fixture in the
   repository has ever populated `dataExpectations`:
   ```
   grep -arn "dataExpectations" --include='*.mjs' --include='*.ts' bakeoff/test dashboard/server/src/calibration
   → bakeoff/test/quality-gating.e2e.mjs:149      dataExpectations: [],
     bakeoff/test/scorer-modes.e2e.mjs:161,187    dataExpectations: [],
     dashboard/server/src/calibration/suites/portfolio-suite.ts:237  dataExpectations: [],
   ```
   Four instances, all empty. The persistence gate has **never executed with a real
   expectation end to end**. A patch that quietly disabled it would pass the entire §6
   sequence. That is `STATE`'s instance twenty, and it sits directly under the first
   repair this system will attempt. **§6.4 fixture G is a precondition for arming Tier 3.**
3. **It is not proven a seat shown all seven fields emits a valid manifest.** No re-run
   was made (`RUN-a913c871-observations.md:635`). Each attempt correctly adopted the field
   it was named — suggestive, not conclusive. If a shown seat still fails, `schema_shape`
   is not deterministic and belongs in Tier 2.

---

## 3. THE FAILURE TAXONOMY, AND THE BUDGET POLICY

### 3.1 CORRECTION TO THE BRIEF — there is not "one global count of 3"

There are four independent budgets at three levels, and they multiply. Measured:

| level | budget | value | file:line |
|---|---|---|---|
| call | free 64k→128k truncation rung | 1 per **run** | `spec-agent.ts:1300` (`truncationRetried` outside the loop), guard `:1322` |
| phase | spec authoring attempts | `DEFAULT_MAX_AUTHORING_ATTEMPTS = 3` | `spec-types.ts:312` |
| phase | gate/fix loop attempts | `DEFAULT_MAX_ATTEMPTS = 3` | `gate-fix-loop.ts:122` |
| run | auto-continue, **one counter for all classes** | `AUTO_CONTINUE_MAX = 3` | `recovery.ts:120` |

The brief's premise is true of the **run level only**. That is where the collapse is.

### 3.2 THE COLLAPSE. This is the finding the taxonomy exists to undo

`BakeoffErrorCode` has **12 members** (`contracts.ts:56-68`). `classifyPhaseFailure` maps
**any non-null code** to `structural` on one line:

```
grep -an "bakeoffCode !== null" dashboard/server/src/recovery.ts
→ 631:  if (s.bakeoffCode !== null) return "structural";
```

and `boundFor("structural")` returns **0** (`recovery.ts:146-147`). So a schema-shape
defect the system can repair from its own validator, a spend refusal only the owner can
authorise, and a frozen-suite digest mismatch are one class with one bound.

**The hard constraint on how it may be split.** `PhaseFailureSignals` has no `message`
field and its docblock forbids one, citing the 2026-08-04 death by name (`recovery.ts`:
*"THERE IS NO `message` FIELD AND THERE MUST NEVER BE ONE"* — grounding agent's read,
re-confirmed by the absence of any message field in the interface). **Every new
discrimination must be a structured field written at the throw site, never a prose match.**

**PROPOSED — the carrier.** `BakeoffError` is `{code, message, remediation}`
(`contracts.ts:73-86`). `ManifestProblem` (`scorer-protocol.ts:762`) already carries
`{field, message, remediation}` — the structure exists, it just does not travel:

```ts
// contracts.ts — carried, never parsed
interface DefectDetail {
  readonly site: string;                       // "collectManifestProblems"
  readonly violations: readonly ManifestProblem[];   // reuse, do not reinvent
}
class BakeoffError { readonly code; readonly message; readonly remediation;
                     readonly detail?: DefectDetail }
interface AuditFinding { …; readonly detail?: DefectDetail }
interface PhaseFailureSignals { …; readonly bakeoffDetail: DefectDetail | null }
```

### 3.3 The taxonomy

`FROZEN?` = would the cheapest repair reach the frozen closure (§6.1)? Any `yes` is
owner-only regardless of how machine-classifiable it is.

#### A. Observed terminal deaths — n=4, one per run

```
sqlite3 "file:dashboard/data/runs.db?mode=ro" "select run_id,status,phase,recovery_class from runs order by started_at;"
→ 3d4d1ccb passed/done | c228e63b failed/spec | 052c6e02 failed/done | 162b186d failed/spec | a913c871 failed/spec/structural
```

| # | subclass | observed on | discriminator today | repair | tier | FROZEN? | budget |
|---|---|---|---|---|---|---|---|
| A1 | `intentional` | `c228e63b` *"aborted by user"* | `aborted:true`, checked first | none | — | no | **0**, keep |
| A2 | `structural::call_ceiling` | `162b186d` *"exceeded the 64000 output token maximum"* | needs `detail.site="maxOutputTokens"` | **deterministic** — the rung exists (`spec-agent.ts:1322`) and is still unexercised | 1 | no | 1 rung; see §3.5 |
| A3 | `structural::schema_shape` | `a913c871` | `criterionId === null` **is already the discriminator** (`spec-validate.ts:1334` builds `blocking("other", null, …)`) | **deterministic** — the validator owns the schema | 1 | no | 2, fingerprint-gated |
| A4 | `gate_red` | `052c6e02` | `heldOutPass=0`, `gateStopReason` | model-assisted; this is the fix seat's job. **`0/0 tests passed` is a worse, separate class** and must never be "repaired" by relaxing the gate | 1 / **2** for `0/0` | no; **yes if the proposed repair edits the suite** | 3 gate attempts; `0/0` → 0 |
| A5 | `gate_loop_stopped` | `052c6e02` | `gateStopReason` | depends; `cancelled` → A1 | — | no | inherits |

#### B. Reachable in code, never observed — the structural family, split

| # | subclass | member codes | repair | tier | FROZEN? | budget |
|---|---|---|---|---|---|---|
| B1 | `schema_shape` | `invalid_usage_shape`, `suite_not_audited` where every blocking finding has `criterionId === null` | deterministic | 1 | no | 2, fingerprint-gated |
| B2 | `authoring_quality` | `suite_not_audited` with `vacuous`/`tautological`/`ambiguous`/`mis_specified` and a real `criterionId` | model-assisted; **this is the branch where "sharpen the ticket" is correct advice** | 1 | no | 3 attempts, fingerprint-gated |
| B3 | `harness_defect` | `not_implemented`, `unknown_config` | model-assisted, **offline** | **2** | no | **0** in-run |
| B4 | `accounting` | `unknown_model_price`, `unpriced_usage`, `ambiguous_price_window`, `invalid_effort`, `duplicate_usage_row` | a price-table row or a dedupe key; a repair agent writes it | **2** | no | **0** in-run |
| B5 | `resource` | `budget_exceeded`, `missing_credential` | **OWNER-ONLY** — §3.6 | — | no | **0** always |
| B6 | `integrity` | `suite_hash_mismatch` | **OWNER-ONLY.** The cheapest repair is re-freezing, which is grader-softening dressed as autonomy | — | **YES** | **0** always |
| B7 | `protocol` | SDK `error_max_turns` | deterministic turn-cap rung mirroring the token rung | 1 | no | 1 rung then 0 |
| B8 | `throttled` | `refusal.limited === true` | deterministic wait; the ladder exists | 1 | no | 3 + `RECOVERY_MAX_AUTO_WAIT_MS` = 12 h (`recovery.ts:227`) |
| B9 | `interrupted` | row says `running`, nothing running | **already built and already unattended** — `orchestrator.ts:1774-1778` requeues and increments the brake | 1 | no | 3, keep |
| B10 | `transient` | `retryable:true` + 5xx | deterministic backoff. **Inert on this deployment** — the CLI subprocess path reports no HTTP status | 1 | no | `TRANSIENT_MAX = 2` (`recovery.ts:131`) |
| B11 | `unclassified` | everything else | **model-assisted, offline.** This is the evidence channel and the runaway guard | **2** | no | **0** in-run, always |

#### C. The stall classes — no row, no `failure_reason`, and these are what the owner sat through

Enumerated from **code**, not from the store: a run that hangs writes nothing. Building
the taxonomy from `runs.failure_reason` alone would reproduce the signature defect in the
method — a classification that can only observe failures that succeeded at failing.

| # | stall | why nothing fires | fix | tier |
|---|---|---|---|---|
| S1 | seat alive, product blind | `select count(*) from events where payload like '%still working%'` → **0** across `1816\|5` events/runs (arm check: `'%seat —%'` → **26**) | **[LANDED]** `#armHeartbeat` (`orchestrator.ts:6517`) | 1 |
| S2 | the silence watch cannot fire on the observed shape | `DEFAULT_SILENCE_WARN_MIN = 90` (`orchestrator.ts:923`) and the clock resets on **any** event, including the `limited:false` telemetry that landed every 20-25 min. Largest real gap 25.2 min; whole spec phase 84.6 min. Both under 90 | measure silence **per seat call**; exclude routine telemetry. **Do not make it a killer** — `orchestrator.ts:886-894` cites LHTB: 79% of unresolved runs time out while still making progress | 1 |
| S3 | the watch performs no action even when it fires | its whole body is one `#emitLog`; docblock: *"It may not kill, requeue, restart or fail a run"* | give it a **wall-clock budget boundary** it may act on, distinct from the liveness guess it may not make. `gate-fix-loop.ts` already has one at the loop level; `spec` has none | 1 |
| S4 | **`awaiting_input` with no readable park record = infinite park** | *"`awaiting_input` has no other exit"* — `orchestrator.ts:1810-1819`, `:1165`, `:1362`. Boot reconcile handles plan, then design-lock, then `continue`s past anything else | a terminal `else` on that loop: no park record → resume or fail with a reason. **This is the supervisor's job**, §7.4 | 1 |
| S5 | capture stage stuck `pending` | terminal fold only converts `running`→`unresolved`. **[LANDED]** the emitter now exists at `orchestrator.ts:2983`, so this is now only the fold rule | terminal fold must convert `pending` too | 1 |
| S6 | localhost down | — | **the owner's stated exception.** §7.7 | — |

### 3.4 THE ANTI-LOOP PRIMITIVE IS A FINGERPRINT, NOT A COUNT

`a913c871` is the proof a counter cannot work: three attempts, budget never exceeded, and
attempt 3 **oscillated back**.

```
fingerprint = sha256( errorCode ‖ detail.site ‖ sorted(violation field paths) ‖ criterionId )
```

Every ingredient except `detail` exists today. The blocking findings already travel into
the next attempt's prompt verbatim (`spec-agent.ts` → `feedback = blockingFindingSummary(
audit.findings)`), so the data is on the wire; it is only unstructured.

**Three arms:**

- **identical fingerprint twice** → the feedback channel is not working. Do not spend the
  next attempt; escalate to Tier 1 deterministic repair, then Tier 2.
- **the path set OSCILLATES** (A → B → A, or a fixed path reappears) → the channel is
  one-field-at-a-time and cannot converge. Same escalation. **This is the arm that catches
  `a913c871`, and no counter can.**
- **the path set strictly SHRINKS** → the channel is working. Spend another attempt, up to M.

**Negative control, or this is instance twenty-one.** The comparator must be exercised by
a fixture feeding it `a913c871`'s three real manifests and asserting it escalates at
attempt 2, **and** by a fixture feeding a shrinking sequence and asserting it does *not*
escalate. A comparator that always escalates is as useless as one that never does.

> ### IMPLEMENTED 2026-08-10 — WITH A FOURTH ARM THIS SECTION DOES NOT HAVE, AND IT IS THE ONE THAT FIRES
>
> `tools/repair/loop-guard.mjs` (+ `loop-guard.test.mjs`, 9 tests). **The three arms above
> cannot fire on `a913c871`'s 1→2 transition** (`{id}` → `{kind}` is not identical, not yet
> an oscillation, not a shrink), so a §3.4-only comparator escalates at attempt **3** —
> 87 minutes too late. A fourth arm, **NON_MONOTONE** (the reported set is DISJOINT from the
> previous one), fires at attempt 2. Licensed by `RESEARCH` R4. Mutation-proved by the lane:
> disabling it produced `✖ a913c871 escalates at attempt 2 … 3 !== 2`; making SHRINK escalate
> produced `✖ NEGATIVE CONTROL: a shrinking sequence does NOT escalate`. A fifth outcome,
> **BLIND**, fires when an attempt carries only prose — the guard refuses to regex a field
> name out of a message, which is the mechanism this repo banned on 2026-08-04.
>
> **AND IT IS BLIND ON THE PRODUCTION RECORD SHAPE — CONFIRMED LIVE, NOT INFERRED.** The
> shipped writer's `DefectAttempt.problems` is `readonly string[]` of prose and `violations`
> lives only at the record's top level, so driving `runRepairCycle` with a contract-exact
> record built from `a913c871`'s real data printed
> `ANTI-LOOP: escalating at attempt 2 (BLIND) — an attempt carries no structured violation
> paths, so the comparator cannot see repetition; refusing to guess from prose`. It gives the
> right answer on `a913c871` **for the wrong reason** and would escalate a healthy
> CONVERGING sequence identically. The SHRINK negative control — the only thing that makes
> this a discriminator rather than an alarm — **can never fire in production** until the
> writer carries per-attempt structured paths. Root cause is one line:
> `dashboard/server/src/orchestrator.ts:7316` passes `violations: null`.
>
> **UNRESOLVED DESIGN-vs-RESEARCH CONFLICT, recorded rather than litigated.** This section
> says a strictly SHRINKING set means the channel is working, so spend another attempt;
> `RESEARCH` R5 says a subset carries no new information, so stop and escalate. A strict
> shrink IS a subset. The implementation follows §3.4 (shrink → continue), because R5's rule
> makes the comparator escalate on every sequence and makes §3.4's own mandatory negative
> control unbuildable. **If R5 wins, the negative control must be replaced by something else
> or the comparator is "always escalate" with extra steps.** Owner decision.

### 3.5 The budgets

`recovery.ts:98-118` already argued the failure to fear: *not* three throttles, but a run
bouncing between classes for ever. Per-class N without a global cap reverses that decision
without answering its argument. So:

```
GLOBAL cap RETAINED. AUTO_CONTINUE_MAX stays 3 unless the owner rules otherwise (§10.3).
boundFor:
  intentional             0   unchanged
  structural::resource    0   owner-only
  structural::integrity   0   owner-only, FROZEN
  unclassified            0   unchanged — the runaway guard
  structural::harness     0   in-run; Tier 2 instead
  structural::accounting  0   in-run; Tier 2 instead
  structural::schema      2   ONLY if the fingerprint changed (§3.4)
  structural::quality     2   ONLY if the fingerprint changed
  structural::protocol    1   one turn-cap rung, then 0
  transient               2   unchanged
  throttled               3   unchanged, + the 12 h ceiling
  interrupted             3   unchanged — the crash-loop brake
```

**The multiplication, priced, because it is the real spend.** Schema class at phase-2 ×
(3 authoring + 1 rung) = **8 spec seat calls**. At `a913c871`'s ~28 min/call that is
~3.7 h and, extrapolating its measured 628,441 output tokens over 3 calls, ~1.7M output
tokens for one dead run. **The fingerprint rule is the brake, not the number: with it,
`a913c871` costs 2 calls instead of 8. Per-class N shipped WITHOUT the fingerprint is
strictly worse than today.**

> **WHAT SHIPPED, AND THE TABLE ABOVE IS NOT IT — RATIFIED 2026-08-10.** Left in place because
> it is the argument, and the argument was followed; only the numbers differ. **The split
> landed with ALL SIX bounds at 0** — no class received a nonzero budget, and the row this
> table prices at 2 (`structural::schema`, shipped as `suite_authoring`) is 0. **The split
> delivers a LABEL (`runs.recovery_class`) and a SENTENCE, not a budget.** Three measurements,
> obeying this section's own closing rule rather than overruling it:
> 1. **Nothing re-enters a non-throttled class today.** `#recoverFrom` (`orchestrator.ts:6801`)
>    reads `if (klass !== "throttled") return false`, so a `BakeoffError` never reaches
>    `planRecovery` at all. A budget here would spend nothing today and everything the day that
>    line changes.
> 2. **The phase boundary carries nothing.** One writer for the frozen-suite `authoringTrail`,
>    on the success path (`spec-agent.ts:2401`), so a PHASE-level retry re-runs three authoring
>    attempts knowing nothing about the three that just failed. The 2026-08-10 authoring fix
>    makes attempts informed of each other **inside** one phase; it carries nothing across the
>    boundary.
> 3. **§3.4's fingerprint does not exist**, and this section's own rule is *"per-class N shipped
>    WITHOUT the fingerprint is strictly worse than today."*
>
> **THE SHIPPED NAMES ALSO DIFFER FROM THIS TABLE'S**, so grep for the real ones:
> `owner_action` (= `::resource`, and it absorbs `budget_exceeded` + `missing_credential`),
> `integrity`, `accounting`, `harness_defect` (= `::harness`), `suite_authoring`
> (= `::schema`/`::quality`), and `structural` retained as the default that catches
> `invalid_usage_shape` **and every unknown code**. `::protocol` was not created.
> `AUTO_CONTINUE_MAX` is untouched at 3. Per-code table and the three codes this design's own
> §3.3 mapping got wrong: `STATE` §6.9.

Two corrections independent of the taxonomy:

- **The truncation rung should be per-attempt.** `truncationRetried` at `spec-agent.ts:1300`
  is outside the loop; the rung guard (`outputTokens < MAX_STREAMABLE`, `:1322`) is what
  actually makes it once-per-run. Making it per-attempt means resetting `outputTokens` at
  the top of each attempt — a deliberate change with a real cost, not a scope fix.
- **Wall-clock is the only boundary the silence watch may act on.** S2/S3.

### 3.6 THE CLASSES THAT MUST ALWAYS STOP AND REQUIRE THE OWNER

Four. Distinguish *stops the run* (common, fine) from *requires the owner* (this list).

1. **Publishing personal data, or anything naming a person leaving this machine.**
   Grounded, not imagined: PQ-1 in `a913c871` was *declined — no phone number anywhere*.
   A default that publishes is not recoverable by a later edit.
2. **`budget_exceeded`** — spend authorisation.
3. **`missing_credential`** — and per the standing rule it must never arrive through the
   chat. The system scaffolds an empty `.env` placeholder or points at
   `~/.claude/scripts/set-secret.sh`; it never prompts for the value.
4. **Any repair whose minimal diff reaches the FROZEN set.** Detected from the diff, not
   from the class.

**Not on the list, deliberately.** Design taste (`designLockPolicy` resolves it,
`design-lock.ts:48-51`, and the fallback is honest about applying no judgement). Ticket
ambiguity (that is B2, and it is model-assisted). `unclassified` — it stops the *run* at
bound 0 and goes to a Tier-2 repair agent; the owner sees a patch, not a prompt.

---

### 3.7 DEFERRED, NAMED, AND NOT DROPPED — the abandoned-call class (`ADDED 2026-08-10`)

**An exported discriminator with no reader is a check that can never fire, so it is filed
here with its consumer, its blocker and its cost rather than left to be rediscovered.**

**What exists.** `bakeoff/src/spec-agent.ts` exports

```
export const TIMEOUT_FAILURE_MARKER = "were abandoned on the per-call wall-clock bound";
```

and `describeAttemptTimeouts` emits it — in the POSITIVE sentence only, asserted in both
directions — into the `suite_not_audited` message, which lands verbatim in
`runs.failure_reason`. `grep -arn TIMEOUT_FAILURE_MARKER bakeoff/src dashboard/server/src`
→ **three hits: the definition, the emitter, and `spec-agent.test.ts`. No consumer in
`dashboard/server/src`.**

**What that costs today.** An authoring phase every attempt of which was abandoned throws
`suite_not_audited` → `classOfBakeoffCode` → `suite_authoring` → the owner is shown that
class's `terminalClassReason`. That sentence used to end *"Read the blocking findings on the
error — they name the fields"*, and for an abandoned phase `last.findings` is `[]`: no suite
was authored, so nothing was audited. **The owner-facing sentence is the entire product of
the 2026-08-10 split, and the one new failure mode the round introduced was being handed a
sentence describing something that did not happen.** That half is FIXED — the sentence now
points at the thrown message (always populated: last attempt's problems, the output-token
rung per attempt, and the wall-clock bound in both directions) and says explicitly that a
blocking finding is not guaranteed. `recovery.test.ts` pins it, including the negative half.

**What is deferred: the class itself.** An abandoned call is the ONE case in this taxonomy
where re-running the same phase unchanged is reasonable — nothing about the ticket or the
suite was established, and a larger `BAKEOFF_SPEC_ATTEMPT_TIMEOUT_MIN` is a real
difference between attempt N and N+1. It is not built in this pass because it is five
changes, not one:

1. **`PhaseFailureSignals` carries no message field.** `classifyPhaseFailure` sees
   `aborted`, `interrupted`, `bakeoffCode`, `seatKind`, `refusal` — and nothing else. It
   cannot see this string without a new signal on the struct and a new read in
   `signalsFor`, whose signature is consumed across the server package.
2. **`recovery.ts` deliberately does not import `bakeoff/`** (`signalsFor`'s docblock:
   *"a pure policy file that drags in the harness is a policy file that cannot be tested
   without building the harness"*). So the marker would have to be duplicated here and
   pinned to the original by a cross-package equality test.
3. A new `FailureClass` needs a `boundFor` arm, a `terminalClassReason` arm, an
   `isRepairable` arm, and a row in every test that enumerates the union.
4. A **non-zero** bound needs an arm in `planRecovery` as well, or the class falls through
   into `planThrottledWait` and stops with `no_refusal` — telling the owner his abandoned
   call "was reported as a rate limit but arrived with no reading of the refusal itself".
   That is measured output, not a prediction (see `boundFor`'s fourth note).
5. And a bounded re-entry needs the fingerprint gate of §3.4, or it is the blind re-roll
   §3.5 prices at ~3.7 h and ~1.7M output tokens for one dead run.

**Do not delete the constant to close this.** The emitted sentence is the only channel that
carries the fact at all, and `runs.failure_reason` is a channel with a proven reader — run
`a913c871`'s post-mortem quoted the whole of that column.

---

## 4. TIER 1 — IN-RUN HEALING

No code change, no offline loop. Touchpoints at `file:line` in the tree as measured.

### 4.1 Full validator requirements instead of the first violation — **[LANDED]**

`collectManifestProblems` (`scorer-protocol.ts:880`) surveys with the same parser and
returns every isolable field; `spec-validate.ts:1317` consumes it and pushes **one finding
per problem**, deliberately, because `blockingFindingSummary` renders one line per finding.
Its own comment states the safety property: *"its first entry is always the parser's own
first complaint, so this can never say less than the fail-fast path said."*

The must-reject corpus is in **`scorer-protocol.test.ts`** (8 references to
`collectManifestProblems`, `:345`–`:476`, including `assert.deepEqual(…, [])` on a valid
manifest — the arm check). `git show HEAD:bakeoff/src/scorer-protocol.test.ts | grep -c
parseSuiteManifest` → **0**: it is new and uncommitted. **§6.1 puts that file in
FROZEN-CONTROLS, which is where it must stay** — the first patch the system will attempt is
in this area, and collect-all is one keystroke from collect-nothing.

**A second, different control lives in `spec-agent.test.ts`** (13 `parseSuiteManifest`
references, also absent at HEAD) and it must not be confused with the first. It asserts
**prompt↔parser agreement**: that the exemplar the prompt shows is *accepted* by the parser
(`:562-563`, both `kind`s), and that every rule the prompt states is still *enforced* by it
(`:687`, `:704-715` — *"the prompt tells the seat a rule the parser does not enforce"*).
That is authoring-side by subject and it is **exactly the file a repair agent patching
`spec-agent.ts`'s prompt would naturally touch.** It is nevertheless in FROZEN-CONTROLS by
the §6.1 closure derivation (it imports `scorer-protocol.js` at `:167`), which is the
derivation doing its job — but the implication for Tier 3 should be stated rather than
discovered: **a prompt patch cannot be self-applied without an owner-approved frozen-path
write, because its own agreement control is frozen.** That is the correct trade and §10.5.2
carries it.

### 4.2 Ceiling escalation

- **Token rung** — `spec-agent.ts:1322`, unexercised in production (`a913c871` never
  truncated; `RUN-a913c871-observations.md:245-252`). Make it per-attempt (§3.5) and
  **emit an event when it fires**: today `spec-agent.ts:1188-1198` emits nothing, so the
  single most informative event the spec phase can produce is invisible.
- **Turn-cap rung** — B7. Mirror the token rung for `error_max_turns`; the seat's own
  remediation already names the env var.

### 4.3 The fingerprint gate on re-entry

Implemented where the attempt loop already lives (`spec-agent.ts:1300-1382`) and mirrored
at the phase level in `recovery.ts`'s continuation decision. Per-class counters need
somewhere to live: `runs.auto_continue_count` is one integer, and `recovery.ts`'s own
warning applies — *a cap read from a counter nothing moves is not a cap*. **PROPOSED:** the
per-class counters live on the supervisor ticket (§7.2), not on `runs`, so no new column
per class is needed and the dashboard can read them.

### 4.4 Attempt boundaries become events

`STATE` §6 N5. `attempts[]` reaches disk only via `freezeSuite`'s `authoringTrail`
(`spec-agent.ts:1613`, `spec-freeze.ts:381`) — **called only on success.** The orchestrator-
side emit is free; attaching the trail to the thrown error is digest-moving. Both are §8's
requirement zero and §9 step 2.

### 4.5 Apply `ifUnanswered` defaults instead of parking — mostly already true

All three parks already resolve and continue on a timer. **Measured:**

| park | timeout | on expiry | what is lost |
|---|---|---|---|
| plan questions | `DEFAULT_PLAN_TIMEOUT_MIN = 20` (`plan-record.ts:95`) | applies each question's `ifUnanswered`, writes it into the brief as *"the dashboard is assuming: …"*, resumes | criteria authored from `criterionIfDefault`, not `criterionIfAnswered`. A **cheaper** verdict, not a wrong one, and the run reports it |
| design lock | `DEFAULT_DESIGN_LOCK_TIMEOUT_MIN = 30` (`design-lock.ts:40`) | *"selecting automatically"* → takes the **first** direction, and the log says it applies no judgement | taste |
| rate limit | 12 h ceiling (`recovery.ts:227`), bound 3 | waits, then parks | every refusal this machine has recorded is `seven_day`, so it parks rather than waits |

**For a supervisor run the first two are unreachable, not defaulted** — `planPolicy(false)`
→ `"skip"` (`plan-record.ts:111-113`) makes **no seat call at all**, and
`designLockPolicy("auto", …)` → `"auto"` (`design-lock.ts:48-51`) before `interactive` is
consulted. §7.4.

**The one privacy constraint the timer cannot enforce:** a question whose `ifUnanswered`
publishes personal data must be structurally incapable of resolving by timeout. That is a
property of how the plan seat **authors** `ifUnanswered`, not of the timer, and nothing
today constrains it (grounding agent's finding; I did not re-measure `plan-seat.ts`).

---

## 5. TIER 2 — SELF-DIAGNOSIS AND OFFLINE REPAIR

### 5.1 The defect record

Written on the terminal transition, success or failure, in the `finally` that already
exists at `orchestrator.ts:3181-3197`. Dashboard-side, **free**.

```ts
interface DefectRecord {
  readonly schemaVersion: 1;
  readonly defectId: string;            // "d-<runStamp>-<n>"
  readonly at: string;
  readonly runId: string; readonly ticketId: string; readonly phase: ApiPhase;

  // CLASSIFICATION — every field from a structured source, never a prose match
  readonly failureClass: string;        // "structural::schema_shape"
  readonly bakeoffCode: BakeoffErrorCode | null;
  readonly detail: DefectDetail | null; // §3.2
  readonly fingerprint: string;         // §3.4
  readonly fingerprintHistory: readonly string[];   // the oscillation evidence
  readonly criterionId: string | null;  // the B1/B2 discriminator

  // REPRODUCTION — what a repair agent needs and nothing more
  readonly failureReason: string;       // verbatim, carried not parsed
  readonly authoringTrail: readonly AuthoringAttempt[];   // needs §9 step 2
  readonly seatCalls: readonly { seat; attempt; startedAt; endedAt; outputTokens }[];
  readonly artefactSha256: string | null;

  // ROUTING
  readonly tier: 1 | 2 | 3;
  readonly candidatePaths: readonly string[];   // from the throw site's module
  readonly reachesFrozen: boolean;              // computed against §6.1, before any agent runs
}
```

`reachesFrozen` is computed **before** the repair agent is spawned. A defect whose only
plausible repair is inside the closure never gets an agent; it gets an owner notification.

> ### IMPLEMENTED 2026-08-10 — THE SHIPPED RECORD IS NOT THIS SHAPE, AND IT HAS NEVER WRITTEN ONE FOR REAL
>
> `dashboard/server/src/defect-record.ts` + `#writeDefectRecord` hanging off `#finish` in
> `orchestrator.ts` (the single funnel every terminal status passes through), written to BOTH
> `runs/<runId>/results/defect.json` and the append-only, content-addressed
> `data/defects/<signature>.jsonl`. 3 integration tests
> (`orchestrator.defect-record.test.ts`) driven by a run that really dies in `spec`.
>
> **Differences from the interface above, each deliberate:** no `fingerprintHistory` (the
> shard IS the history — one line per occurrence, so "has this signature happened before" is
> a file read); no `defectId` (content-addressed by `signature` instead); `detail` is
> `violations: null` plus a `violationsAvailable:false` flag and an `unavailable[]` list of
> sentences naming what is unknown and why — **absence is not emptiness**, because `[]` would
> read as "the classifier looked and found none". `failureClass` and `repairable` are READ
> from `recovery.ts` (`boundFor(...) > 0`), never restated.
>
> **NOT PROVEN: it has never written a real record.**
> `find dashboard/runs -name defect.json -o -name authoring-trail.json` → nothing;
> `ls -d dashboard/data/defects` → *No such file or directory*. Every claim about this channel
> rests on its tests. The first real record is also the first moment the signature
> disagreement below becomes a lost lookup rather than a note.
>
> **THREE SIGNATURE FORMULAS SHARE ONE ADDRESS SPACE — measured on one input, not reasoned.**
> With `site='spec/failed/suite_not_audited'` and path `dataExpectations[0].id`:
> `defect-record.ts:112` → `ad220a03e411…`; `tools/repair/signature.mjs#computeSignature` →
> `cd3e4a3880795d5b…` (with `bakeoffCode`) / `138acb9c810e276e…` (without);
> `tools/replay/signature.mjs` is a third format entirely (16-hex `site#digest`, e.g.
> `spec/suite.manifest.json#176d75d025b304fd`). **AGREE: false.** Both the defect shard and
> the repair agent's ruled-out ledger are content-addressed BY that digest, so
> `tools/repair/ruled-out.mjs#fileFor` reads a path nothing writes, `ruledOutFingerprints()`
> returns `[]` for ever, and the "already tried and failed" brake can never fire. Worse: the
> writer KEEPS array subscripts, so the same defect at `[3]` buckets apart from `[0]` and
> `a913c871`'s own oscillation would shard three ways. **Adopt the reader's index-collapsing
> formula in all three sites**, and add the cross-side test neither lane has (production
> writer → `openLedger().fileFor()` → same file).

### 5.2 The repair loop

```
1. CLASSIFY   defect record → tier. Tier 2 only. Tier 1 never reaches here;
              §3.6 classes never reach here.
2. SPAWN      repair agent, write allowlist = EDITABLE set (§6.2 L1), enforced by
              the harness that spawns it, not by its prompt.
3. REPRODUCE  a failing test that fails for the recorded reason, BEFORE any fix.
              No RED, no repair — the agent stops and files "could not reproduce",
              which is itself a useful record.
4. FIX        minimal diff.
5. MUTATION-PROVE  §5.3.
6. FULL GATE  §6.3, run from the isolated copy.
7. QUEUE      patch + evidence bundle → the supervisor's patch hook.
```

> ### MEASURED 2026-08-10 (strip-crash round) — STEP 0 EXISTS NOW, AND STEPS 3-7 STILL CANNOT RUN
>
> **The hole this list did not have a step for was step 0: who calls it.** `repairing` was a
> terminal park — `settle()` was its only producer and nothing ever moved a ticket out — so this
> whole loop had no entry point from the running system. **It has one now.** `tick()` gained a
> repair step, placed **before** the in-flight early return (a repairing ticket has a null
> `currentRunId`, so `#inFlight()` cannot see it and a later placement starves it), reading a list
> snapshotted **before** reconcile so `repairing` stays an observable state for one tick. It routes
> through a pure `routeRepairOutcome()` with **six named outcomes, five terminal**:
> `REPAIR_DEADLINE_EXCEEDED`, `NO_REPAIR_DRIVER`, `REPAIR_CYCLES_EXHAUSTED`, `REPAIR_APPLIED`,
> `REPAIR_REFUSED`, `REPAIR_INCONCLUSIVE`, plus the one non-terminal `REPAIR_DEFERRED`. **The arm
> ORDER is the policy:** the deadline is checked first, so no queue can starve a ticket into
> permanence. Bounds: 30 minutes per ticket, 2 cycles per signature, counted in a new
> `supervisor_tickets.repair_counts` column — **never in `attempt_no`, never in `class_counts`**, per
> §7.6's counter rule.
>
> **AN ABSENT DRIVER IS A NAMED TERMINAL OUTCOME, NOT A WAIT** — that is the whole difference
> between this and the park it replaces, and it is why the honest state of the system is legible:
> the boot arm check prints `NO REPAIR DRIVER is wired. Every ticket that reaches 'repairing'
> terminates at 'blocked' with NO_REPAIR_DRIVER and the loop carries on to the next ticket.`
>
> **AND STEPS 3-7 STILL CANNOT RUN, for three independent reasons, each sufficient on its own:**
> `index.ts` passes no `repair` dep (~4 lines, 0 grep hits); **step 4 has no author** (§5.3's dated
> block — the diff is an INPUT); and **step 2's isolated copy does not exist**, so `prover.mjs`,
> which correctly refuses the working tree, is unreachable and a hand-authored diff at
> `dashboard/data/repair-proposals/<signature>.diff` returns `NO_SANDBOX`. The cycle's answer today
> is `NO_PATCH_AUTHOR` — an honest `inconclusive` that the loop turns into `blocked` with that
> sentence. **A `git worktree`-based sandbox factory is the missing piece.**
>
> **ONE COST OF THE DESIGN, RECORDED RATHER THAN DISCOVERED LATER:** the step declines entirely
> while a run is in flight (never patch a tree under a live build), so on a permanently busy queue
> a repairing ticket gets **no cycle at all** and terminates at its deadline. The sentence says so.
> Raise the deadline once a sandbox exists — not before, or the ticket waits longer for the same
> nothing.

### 5.3 THE EVIDENCE BAR — a fix with no verbatim RED is unlanded

This repository's signature defect is checks that can only observe success, twenty
catalogued. A repair agent producing its own test is the highest-risk instance possible, so
the bar is mechanical, not editorial:

- **The reproduction must be watched RED before the fix, and the RED output is stored
  verbatim in the patch record.** Not "a test was added" — the actual failing output.
- **The same test must be watched GREEN after the fix**, same command, both transcripts in
  the bundle.
- **A mutation must be watched RED after the fix**: revert the fix hunk, re-run, store the
  output. This is what distinguishes a test that observes the fix from a test that observes
  nothing. The repository already does this by hand — `calibration.test.ts:50` records M4
  (*"emptying `MUST_FAIL`"*) as the mutation that survived an adversarial pass, and
  `fixtures.ts:33-38` records that emptying it *"left the entire gate green at 7/7"*. That
  is the standard to meet.
- **A patch whose bundle is missing any of the three transcripts is refused by the queue.**
  Absence is treated exactly like failure.

**The known hazard:** verify-class agents in this environment are read-only and silently
degrade mutation testing into code review. The repair agent and its verifier must both
have Bash, or the mutation proof is a claim.

> ### MEASURED 2026-08-10 (strip-crash round) — THE BAR APPLIES TO THIS PROJECT'S OWN ROUNDS, AND IT WAS APPLIED PER MUTATION
>
> **"The round was mutation-proved" is a round-level claim and this bar does not accept it.** In the
> strip-crash / still-parks round eleven mutations were reported; **six were independently reproduced
> by the gate** with byte-exact restoration proved by **sha256** — not by `git diff`, which is
> worthless here because most of the mutated files are UNTRACKED, so a diff shows nothing whether or
> not the file was restored — **one more was independently reproduced by the final check**, and the
> remaining **four are the repair pass's own claims, relayed**. STATE §8.5 is the per-mutation ledger.
> **Record which is which, or the strongest sentence in a report is the one nobody checked.**
>
> **AND A MUTATION SURVIVED, which this bar says is DATA:** a first attempt at collapsing two
> repair-router sentences copied a sentence but dropped its last clause, and the arm check — which
> compares sentences for **equality** — correctly, and uselessly, stayed armed. It catches a copied
> sentence, not a nearly-copied one. That limit now lives in the function's docblock rather than in
> a reviewer's memory.

> ### IMPLEMENTED 2026-08-10 — THE BAR IS REAL, THE PROVER EXECUTES, AND THE PATCH AUTHOR IS NOT BUILT
>
> `tools/repair/` — `evidence.mjs` (15 named refusal codes; the tests assert the EXACT code
> set with `deepEqual`, so one over-broad predicate cannot mask five others), `prover.mjs`
> (reproduce-first → GREEN → RED under a mechanically derived `git apply -R` of the fix hunk
> → per-hunk revert naming unproven scaffolding; everything through `spawnSync`, and a
> transcript is the process's own bytes framed by the command line and `# exit code: N`),
> `cycle.mjs`, `ruled-out.mjs`, `loop-guard.mjs`, `signature.mjs`, `arm.mjs`. **72 tests across
> seven files** (re-measured 2026-08-10 by the recorder — the lane reported 70 before the repair
> pass added two); `node tools/repair/arm.mjs` → 7/7 arms live, exit 0.
>
> **THREE CHECKS THE DESIGN DOES NOT NAME, AND THEY ARE THE LOAD-BEARING ONES.**
> `RED_EQUALS_GREEN` and `MUTATION_RED_EQUALS_GREEN` catch transcripts that observed nothing;
> `EVIDENCE_EXIT_CODES_INCONSISTENT` catches a "RED" that exited 0 or a transcript with no
> exit-code trailer, which makes the prover **the only legal producer** of the three strings.
> Without that last one, "three verbatim transcripts" is satisfiable with three string
> literals — measured, see §6.3's dated block.
>
> **PROVEN ON `a913c871`'s REAL DEFECT DATA:** `VERDICT: ACCEPTED`, `prove outcome: PROVEN`,
> all three transcripts present with exit-code trailers, `filesChanged: ['src/prompt.mjs']`.
> **NOT a real end-to-end:** there was no real defect record to hand it (none exists on
> disk), so the record was hand-built from the run's `runs.db` row plus the three extracted
> manifests, and everything ran in an isolated scratch sandbox — the prover REFUSES to
> operate on the working tree and is arm-checked both ways
> (`ARM CHECK: sandbox-refusal — refuses /Users/…/coding-agent and accepts an isolated copy`).
>
> **THE PATCH AUTHOR IS NOT BUILT, and that is named rather than omitted.** `runRepairCycle`
> takes the candidate diff as an INPUT; everything in `tools/repair` is the bar it must clear.
> A component that both writes the patch and grades it is the shape this repo keeps catching
> itself in. Wiring an authoring seat needs the §6.2 L1 write allowlist enforced by the
> spawning harness, not by a prompt.
>
> **`ctx.frozenClosure` WAS OFF BY DEFAULT AND IS NOW REQUIRED.** `evidence.mjs` read
> `ctx.frozenClosure ?? []`, so a caller that omitted the closure got a check that refused
> nothing and reported a clean ACCEPT — this section's own "absence is treated exactly like
> failure" rule, inverted. Now a named `NO_FROZEN_CLOSURE` refusal on absent OR empty, in
> both `evidence.mjs` and at `cycle.mjs` ENTRY (before the prover spends three runs), with a
> negative control whose input is a `bakeoff/src/scorer.ts` diff with the closure omitted.
> The list itself comes from `tools/tier3/closure.mjs#frozenClosure`, which computes it.

### 5.4 What Tier 2 does with the classes it owns

- **B3 harness_defect / B11 unclassified** — the evidence channel. A record a human can
  read, and a patch proposal if one is derivable.
- **B4 accounting** — a price-table row or a dedupe key. Deterministic-ish; the agent
  writes the patch and the mutation is trivial to construct.
- **A4 `0/0 tests passed`** — a suite that executes nothing. Deterministic to detect,
  **and it must never be "repaired" by relaxing the gate.** The only legal repairs are in
  the suite-execution path.

---

## 6. TIER 3 — AUTONOMOUS SELF-APPLICATION

The owner has decided this is autonomous, including `bakeoff/src`. Not re-litigated. This
section is the detection behind it.

### 6.0 THE DECISION, AND THE POLICY THAT IMPLEMENTS IT — RATIFIED 2026-08-10

*(New section. **Marker for this block: `RATIFIED 2026-08-10`, deliberately NOT one of the five
literals `STATE`'s pointer counts** — so that recorded figure does not move under me. Its last
digit is bracketed below **so the quotation does not match itself**; writing it out plainly the
first time inflated the count by 2, which is this document's own lesson about a locator measured
against its own output:*

```
grep -c 'IMPLEMENTED 2026-08-1[0]\|CORRECTED 2026-08-1[0]\|FALSIFIED 2026-08-1[0]\|STATUS 2026-08-1[0]\|ADDED 2026-08-1[0]' \
  docs/DESIGN-self-maintaining-pipeline.md   → 15
grep -c 'RATIFIED 2026-08-1[0]' docs/DESIGN-self-maintaining-pipeline.md   → 4   # this round
```

*The second count is **4 hits = 3 substantive blocks (§6.0, the §3.5 budget correction, the
§6.3 rollback correction) plus this note**, so a reader greping 4 does not go hunting for a
fourth. The first is **15, where `STATE`'s pointer records 14** — the two figures disagree and
**this recorder did not establish which edit accounts for it**; the plausible reading is a
dated block landing after that pointer was written, but that history was not measured. Neither
figure is mine.)*

**THE DECISION.** Tier 3 is **autonomous, including `bakeoff/src`.** The owner has decided
it; §6.1-§6.7 are the detection, not a re-litigation.

**THE MECHANISM IS A MECHANICAL PROOF, NOT A HUMAN TOKEN — and the reason is a measurement
theorem, not a preference.** `RESEARCH` §5 item 2 (arXiv:2607.18966v1, 2026-07-21): *a
grader-pleasing system and a working one are indistinguishable wherever the grader is right*,
therefore **"every measurement drawn only from normal runs is incapable of detecting
weakening."** A human eye on a diff, or a human token gating an apply, is not a measurement at
all — it is a slower version of the same blind instrument, and it is unavailable at 3am, which
is the hour this pipeline exists for. So the authority to apply is a token **minted from
evidence drawn from outside normal runs**: `mintApplyToken` digests
`(frozen-manifest digest ‖ diff digest ‖ the verdicts)`, and `decideApply` refuses a token
minted over a different diff **and a missing one identically** — so *"the caller skipped the
gate"* is indistinguishable from *"the gate refused"*, which is the correct fail-safe
direction (§6.2 L4).

**THE POLICY, FOUR CLAUSES. Each carries where it is implemented and what is MEASURED about
it today** — a policy stated as operative over an unarmed mechanism is the failure this
document exists to post-mortem.

1. **A diff wholly OUTSIDE the frozen closure self-applies behind the normal gate.** No extra
   ceremony: the ordinary suites, `tsc`, and the evidence bar of §5.3. Implemented as the
   OUTSIDE-CLOSURE branch of `tools/tier3/gate.mjs`. **MEASURED:** the accept direction works
   (an editable-only diff with full evidence → `VERDICT APPLY`, token minted) — **and this
   branch was the round's worst defect before it was fixed.** It returned APPLY on
   `{redBefore:"x", greenAfter:"x", mutationRed:"x", noOpAblation:"x"}` because it answered
   before `proofs` was consulted and its only bar was a non-empty-string check. **That door is
   the only one authorising writes to the package containing the orchestrator, the recovery
   classifier and the gate's own caller.** Now behind `validateProposal`'s four
   proposal-decidable refusals plus the ablation requirement; **two of the six available
   checks remain unenforced** (§10.5 item 10, `STATE` §6.6 item 10).
2. **A diff INSIDE the closure must additionally hold ALL FOUR named proofs, or roll back
   automatically.** Implemented as `proofsFor` (`tools/tier3/gate.mjs:72`), ids verbatim:
   `impossible-set-failing`, `known-bad-set-failing`, `rescore-run1-21-20-1` (21/20/1 with the
   sole REQ-013 QUALITY failure), `no-op-ablation-failing`. The first three are **mode-gated to
   `container`** — including the re-score row, filtered by mode *before* id, because reading it
   by id alone would let a host-import row of the same id satisfy the proof, *"the one path by
   which host evidence could still reach APPLY."* Rollback is §6.3 S11, and **a rollback that is
   not re-verified against the same 21/20/1 is a check that can only observe success.**
   **MEASURED, AND THIS IS THE OPERATIVE TRUTH: 17 arms held, ZERO container arms executed.**
   `proofsFor` therefore cannot reach 4/4 for any diff, so **today every inside-closure diff
   parks SELF-PROPOSE.** The gate's refusal of a real grader softening
   (`scorer-container.ts` with `const suiteGreen = true` and a full evidence bundle) was
   correct **for the wrong reason** — inside-closure plus unarmed legs. **There is no softening
   detector.** The mechanism that would be one is the five `MUST_FAIL` calibration fixtures
   going green under the softened scorer; that set has no executor. **When someone writes them,
   re-run that test; do not cite today's correct verdict as evidence the detector works.**
   And `no-op-ablation-failing` is `mode: "evidence"` — **a string nothing executes**, so a
   Tier-2 agent that fabricates it satisfies that proof. The three container proofs cannot be
   fabricated this way, which is exactly why they carry the mode gate.
3. **INCONCLUSIVE is not FAILED: it degrades to self-proposing, LOUDLY, with Tiers 1 and 2
   still running** — *"the patch parks; Tiers 1 and 2 keep running"* (`gate.mjs:245`). **The
   pipeline never stops on an unarmed instrument.** An executor that throws or returns no
   boolean is INCONCLUSIVE, **never "no failure found"**, and container legs are **REGISTERED
   as UNARMED rather than omitted** — omitting them is what makes a gate lie. `aggregateKnownBad`
   checks the **floor first**, because an emptied registry has no deviations: the exact mutation
   `calibration/fixtures.ts:33-38` records as having left the gate green at 7/7.
4. **A diff touching the admission gate or the impossible-ticket set is REFUSED, NEVER
   QUEUED — at any tier, including this one.** `ADMISSION_PREFIXES` covers
   `bakeoff/test/tier3-fixtures/impossible/`; a diff against `imp-001` →
   `VERDICT REFUSED: the diff touches the admission set`, mutation-proved by dropping the
   admission branch. **The warrant is the same theorem as the mechanism** (`RESEARCH` R10): the
   corpus admission predicate becomes the objective function, so a movable anchor is not an
   anchor, and it cannot be self-editable at any tier. This is the one clause that is a
   **refusal rather than a park** — there is no evidence bundle that earns it.

**THE RESIDUAL RISK, IN THE SAME BREATH, BECAUSE IT IS NOT A FOOTNOTE.** All four proofs
detect **a grader that got WEAKER**. None of them detects **a prompt or a criterion generator
that made authoring EASIER**, and **that second one has no known solution** — not here, and
not in the literature (§10.1, §10.2, `RESEARCH` §5 item 3: sealed-suite gating is *"a
reasonable engineering response with no published evidence behind it"*). S3-S8 grade **frozen
artefacts against frozen suites**; the spec seat never runs. Concretely, and it is this
round's own headline: **the authoring-retry fix of 2026-08-10 — the manifest echo and the
accumulated constraint set, `STATE` §6.10 — is a prompt change inside `bakeoff/src`, and the
sealed gate observed nothing whatsoever about it.** The sharpest standing instance remains
`bakeoff/src/spec-validate.ts`: EDITABLE, and it **is** the bad-test audit. Softening it moves
no `heldOutPass` on any frozen artefact; it changes which suites get frozen next — weaker
criteria, authored honestly, passing honestly. The only instrument is the 4B authoring proxy
(§6.5), it is noisy on correctness (7/7, 5/7, 5/7 across three committed runs), and it is the
most expensive step in the loop. **A patch inside the authoring closure that makes the next
suite weaker is, today, indistinguishable from one that makes the next suite better.**

### 6.1 The partition, derived by import closure

**FROZEN-GRADER — 11 files**, the transitive local-import closure of the four
verdict-producing entry points. Command in §1.3.

```
bakeoff/src/contracts.ts        computeHeldOutPass :1433, tiers, BakeoffError
bakeoff/src/hash.ts             acceptanceSuiteDigest
bakeoff/src/redact.ts
bakeoff/src/config.ts           BUILDER_FORBIDDEN_PATH_PREFIXES
bakeoff/src/spec-types.ts
bakeoff/src/spec-freeze.ts      freezeSuite — DEFINES the held-out boundary
bakeoff/src/scorer-protocol.ts  parseSuiteManifest :590, collectManifestProblems :880
bakeoff/src/tier0.ts            deterministic gates + exploit scanners
bakeoff/src/scorer.ts           staging, protectedPathViolations, heldOutPass
bakeoff/src/scorer-container.ts in-container execution + criterion coverage
bakeoff/src/gate.ts             createGate
```

`spec-freeze.ts`'s membership is not an accident to be optimised away: it decides which
half of the suite is held out, so softening it is a leniency path that never touches a
scorer file.

**FROZEN-CONTROLS** — the closure is worthless if the tests guarding it are editable.
Derived the same way (test files importing any closure module):

```
cd bakeoff/src && grep -ln 'from "\./\(contracts\|hash\|redact\|config\|spec-types\|spec-freeze\|scorer-protocol\|tier0\|scorer\|scorer-container\|gate\)\.js"' *.test.ts
→ scorer-protocol.test.ts  tier0.test.ts  report.test.ts  analyze.test.ts
  spec-validate.test.ts  spec-agent.test.ts  spec-agent-ladder.test.ts
```

**FROZEN-DATA AND POLICY** (no closure derivation needed):

```
dashboard/server/src/calibration/fixtures.ts, grade-fixture.ts, suites/**
dashboard/server/src/calibration.test.ts, calibration/run-root.test.ts,
  calibration/correct-portfolio-artefact.test.ts
dashboard/server/calibration/**                    the artefact trees
dashboard/server/probes/calibration-4a.mjs, probes/calibration-authoring.mjs
dashboard/server/probes/results/**                 the 4B baselines, the mutation records
dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/**   run-1 baseline
dashboard/results/scores/run-…3d4d1ccb.container.json
dashboard/acceptance/t-621a2808720d755e, t-ac91abe93759dc0b
bakeoff/docker/scorer.Dockerfile + .dockerignore, playwright.config.mjs, node-test-reporter.mjs
docs/DESIGN-self-maintaining-pipeline.md (this file, once ratified) and the allowlist itself
tools/tier3/**                                     PROPOSED — the gate script
```

**EDITABLE — everything else.** Notably and deliberately: `bakeoff/src/spec-agent.ts`,
`spec-validate.ts`, `tickets.ts`, `report.ts`, `runner.ts`, `campaign.ts`, `ledger.ts`,
`analyze.ts`, `cli.ts`, `subscription/**`, `bakeoff/test/**`, and the whole dashboard
package minus the frozen paths.

Two properties worth stating:

- **The a913c871 repair is entirely inside EDITABLE.** The system can fix its own worst
  known bug at full autonomy without proposing a frozen-path write.
- **`bakeoff/test/**` is editable AND digest-free**: `grep -c "COPY test"
  bakeoff/docker/scorer.Dockerfile` → **0**. That is where cheap new coverage goes.
  `bakeoff/src/*.test.ts` costs a full rebuild cycle, because `COPY src ./src` takes test
  files too.

### 6.2 How FROZEN is enforced — and the honest ceiling, stated first

**The repair agent runs as the owner's UID on a single-user host, and the builder is not a
container — it is a host subprocess.** `STATE`'s §THIRTY-SECOND-ANSWER correction records
run 1's own `heldConstants.sandbox` as `"host-subprocess (no container: the dashboard
builder runs on the host)"`. Therefore **nothing on this machine is unwritable by the
agent.** `chmod -w`, a `pre-commit` hook, a `CODEOWNERS` file: all agent-writable, all
documentation wearing an enforcement costume. **The property being bought is
detectability, not prevention.** Four layers, each labelled by what it actually does:

**L1 — PREVENTION (the only real one).** The repair agent is spawned with a write allowlist
equal to EDITABLE, enforced by the harness that spawns it, in code, not in its prompt.
**This layer needs its own negative control** — an arm that attempts a frozen-path write
and is observed refused, run at start when the answer is known. A write allowlist whose
only evidence is "no violation was seen" is instance twenty-one.

**L2 — DETECTION (digest manifest).** Before the agent is spawned, `sha256` every path in
FROZEN-GRADER ∪ FROZEN-CONTROLS ∪ FROZEN-DATA into a run-stamped manifest written
**outside the working tree** (`/private/tmp/claude-501/<session>/tier3/<runStamp>/frozen.manifest`).
The gate recomputes and compares before it trusts any of its own verdicts. Mismatch → hard
refuse, alarm, no patch, entry in the trail.

**L3 — ISOLATION (the gate runs from a copy the agent cannot reach).** Not
`git archive HEAD` — the tree has 40 uncommitted modifications, so HEAD is not what is on
disk and archiving it would grade away the patch under test. The construction is:

```
FROZEN closure ← checked out from the LAST GATE-VERIFIED COMMIT
EDITABLE set   ← overlaid from the working tree (the patch)
                 into a scratchpad build root
```

That is literally what *"test the patch against an unmovable grader"* means. `STATE`
Appendix A's `rescore.mjs` already refuses by construction to write outside
`/private/tmp/claude-501/`; reuse that discipline.

**L4 — APPLY-TIME TOKEN, and this is the layer the other three need.** If the orchestrator
invokes the gate, the invoker is in the EDITABLE dashboard package: a patch that simply
skips the gate passes trivially. So enforcement is at **apply**, not at invoke. The frozen
gate emits a record whose digest covers `(frozen.manifest digest ‖ patch diff digest ‖ the
verdicts)`, and the frozen apply script refuses any patch without a matching record. *"The
caller skipped the gate"* then becomes indistinguishable from *"the gate refused"*, which
is the correct fail-safe direction.

### 6.3 The gate sequence — PROPOSED, real commands, UNMEASURED here

Two corrections to the brief first.

- **The `pre-manifest-shape` rollback tag does not exist.**
  `docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -i bakeoff` →
  `bakeoff-scorer:1 b7a9fd0a0f58`, `pre-specmode fae56a4e1374`, `pre-readmech c98bad3a762b`,
  `pre-lane4 bcd017714ba7`. The fourth is `pre-lane4`.
- **`git tag | wc -l` → 0.** A docker tag rolls back the *image*, not `bakeoff/src` on
  disk. The rollback record must carry the source sha (or a scratchpad bundle of the
  pre-patch editable set), or a rolled-back image runs against rolled-forward source.

> **BOTH BULLETS ABOVE ARE OVERTAKEN — RATIFIED 2026-08-10, and S2/S11 depend on the
> difference.** Left in place because they were true when written. Re-measured:
> ```
> docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -i bakeoff
> bakeoff-scorer:1  027bc2e2d3d2 | pre-repair-2026-08-10 ec79e1efbe81
> pre-never-stop    83b80ef56b67 | pre-manifest-shape    b7a9fd0a0f58
> pre-specmode      fae56a4e1374 | pre-readmech          c98bad3a762b | pre-lane4 bcd017714ba7
> git tag -l → gate-verified-2026-08-10        # ANNOTATED: resolve with ^{commit}
> ```
> `pre-manifest-shape` **does** exist (`b7a9fd0a…`) and there is now **one** git tag, so S2's
> two-part rollback identity is constructible for the first time. **The failure mode did not go
> away, it moved into the tag body:** `gate-verified-2026-08-10` names `d74a20aeb6bc…` as the
> image at that commit and `docker image inspect d74a20aeb6bc` → **`No such image`** — it
> transcribed an untagged intermediate rung as the final one. Two rungs are unreachable by name
> (`d74a20ae…`, `5ffdc20a…`). **A recorded rollback pointer that does not resolve is exactly what
> §6.3 S2 exists to prevent.** Full chain and the owner action: `STATE` §6.0 and §6.12.

```
S0.  ARM CHECK (§6.6). Refuse to proceed if the gate cannot be shown to fail.
S1.  Verify frozen.manifest. Mismatch → REFUSE, alarm, stop.
S2.  Record rollback identity:
       git rev-parse HEAD
       docker image inspect bakeoff-scorer:1 --format '{{.Id}}'
       docker tag bakeoff-scorer:1 bakeoff-scorer:pre-<change>
S3.  Rebuild. The flags are load-bearing, not cosmetic — with BuildKit defaults the
     digest moves on every rebuild regardless of input, so it certifies nothing:
       cd bakeoff && docker build -f docker/scorer.Dockerfile -t bakeoff-scorer:1 \
         --platform linux/arm64 --provenance=false --sbom=false .
     Build needs network (npm ci); running must not. Build fails if the harness does
     not typecheck — deliberately (scorer.Dockerfile:79 RUN tsc).
S4.  Re-resolve the digest:
       docker image inspect bakeoff-scorer:1 \
         --format '{{.Id}}{{"\t"}}{{json .RepoDigests}}{{"\t"}}{{json .RepoTags}}'
     If the digest did NOT move on a diff touching bakeoff/src, that is itself a
     failure: COPY src ./src + RUN tsc guarantees it must.
S5.  Compile the dashboard server into a PRIVATE dist — `npm run build` writes a shared
     dist/ that concurrent agents compile into:
       cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-tier3
S6.  RECALIBRATE — seven fixtures through the real sealed container:
       cd dashboard/server && CAL_DIST=../dist-tier3 CAL_LABEL=tier3-<change> \
         node probes/calibration-4a.mjs
     Exit 0 only on zero outcome mismatches AND zero tier mismatches.
S7.  The standing suite, which asserts more than the probe — per-fixture NAMED gate,
     NAMED tier, the MUST_FAIL re-derivation, heldOutPass === false on each:
       cd dashboard/server && node --test 'dist-tier3/**/calibration.test.js'
S8.  RE-SCORE RUN 1 — STATE Appendix A rescore.mjs verbatim, REPO pointed at the
     isolated build root:
       heldOutPass=true  falseFinish=false  agentDeclaredDone=true
       suiteExecution testsTotal=21 testsPassed=20 testsFailed=1
       exactly one failing criterion: REQ-013, tier QUALITY
       protectedPathViolations=[]
S9.  THE NEGATIVE CONTROLS (§6.4). ANY known-bad that starts passing → REFUSE.
S10. If the diff touched the AUTHORING closure, the authoring proxy (§6.5).
S11. On any deviation at S1-S10: AUTO-ROLLBACK
       docker rmi bakeoff-scorer:1 && docker tag bakeoff-scorer:pre-<change> bakeoff-scorer:1
       git checkout <recorded sha> -- <editable paths in the patch>
     then RE-RUN S8 and require the same 21/20/1. A rollback that is not re-verified
     is a check that can only observe success.
S12. On full pass: emit the apply token (L4), append to the trail (§6.7), apply.
```

**Cost.** S3 is a full image rebuild. S6 is seven container scores (the archived gutted
run records `totalWallClockMs: 32304` at concurrency 3). S8 is ~12.7 s of container time
and zero quota. **S3+S6+S8 is cheap enough to run per-patch. S10 is not** — §6.5.

> ### IMPLEMENTED 2026-08-10 — THE ROUTER AND THE TOKEN ARE BUILT; S3–S10 ARE NOT
>
> `tools/tier3/gate.mjs` is a library + CLI (`node tools/tier3/gate.mjs --proposal <file>`)
> with four exits, ordered: admission REFUSED → blind arm REFUSE-BLIND → frozen mismatch
> REFUSE → proposal refusals REFUSED → known-bad REFUSE/INCONCLUSIVE → OUTSIDE-CLOSURE APPLY
> → INSIDE-CLOSURE requires all four named proofs. `mintApplyToken` digests
> (frozen-manifest digest ‖ diff digest ‖ verdicts), and `decideApply` refuses a token minted
> over a different diff **and a missing one identically**. With no proposal the CLI answers
> `VERDICT REFUSED: … no proposal supplied` — absence is failure, not a default. **Nothing in
> the lane writes to the working tree**; S11's rollback, S3's rebuild and S6's container legs
> are not built.
>
> **VERIFIED BOTH DIRECTIONS, because a gate that only refuses is as useless as one that never
> does.** (A) a real grader softening — `bakeoff/src/scorer-container.ts`, replacing
> `ranPasses.every(pass => pass.exitCode === 0 || excused(pass))` with `const suiteGreen = true`,
> full evidence → `VERDICT SELF-PROPOSE`, `applyToken: null`. (B) moving the anchor —
> a diff against `imp-001` → `VERDICT REFUSED: the diff touches the admission set`. (C) the
> accept direction — an editable-only diff with full evidence → `VERDICT APPLY`, token minted.
>
> **THE NUANCE THAT MUST NOT BE SMOOTHED OVER: (A) was NOT refused for BEING a softening.
> There is no softening detector.** It parked because it is inside the frozen closure AND the
> container legs are UNARMED, so `proofsFor` (which counts ONLY container-mode evidence for
> the three artefact-grading proofs) can never reach 4/4. What is proven is *"nothing inside
> the closure can reach APPLY today"*, **not** *"grader softening is refused"*. The mechanism
> that would actually catch a softened `scorer-container.ts` is the container known-bad set —
> the 5 `MUST_FAIL` calibration fixtures would go green under it — and that set has **0
> executed container arms**. When someone writes those executors, re-run (A); do not let
> today's correct verdict be cited as evidence the detector works.
>
> ### AND THE ACCEPT PATH GRADED A PATCH ON THREE STRINGS THE PROPOSER WROTE — FOUND, THEN FIXED
>
> A proposal whose diff touched `dashboard/server/src/orchestrator.ts` and whose entire
> evidence bundle was `{redBefore:"x", greenAfter:"x", mutationRed:"x", noOpAblation:"x"}`
> returned `VERDICT APPLY` with a real `applyToken` and `humanReviewed: null`. Mechanism:
> the OUTSIDE-CLOSURE branch returned APPLY **before `proofs` was consulted at all**, and the
> only bar on it was a `nonEmptyString` check — while `RED_EQUALS_GREEN`,
> `EVIDENCE_EXIT_CODES_INCONSISTENT` and `SCOPE_UNIMPLICATED_FILE` already existed,
> mutation-proved, in `tools/repair/evidence.mjs`, with **zero cross-imports** between the two
> directories. **That door is the only one that authorises writing to the editable package
> where the orchestrator, the recovery classifier and the gate's own caller live.**
>
> **FIXED 2026-08-10:** `tools/tier3/proposal.mjs:29` now imports
> `tools/repair/evidence.mjs#validateProposal` and adopts a **named whitelist** of the four
> refusals decidable from the proposal alone — `RED_EQUALS_GREEN`,
> `MUTATION_RED_EQUALS_GREEN`, `EVIDENCE_EXIT_CODES_INCONSISTENT`, `DIFF_UNPARSEABLE` — and the
> OUTSIDE-CLOSURE branch now requires the no-op-ablation proof and returns SELF-PROPOSE
> without it. Pinned by a test whose input is that exact `"x"/"x"/"x"` proposal, with a
> negative half where the same diff carrying prover-shaped transcripts is NOT refused.
> **Wholesale delegation was REFUSED on measurement:** `evidence.mjs` unconditionally adds
> `NO_INDEPENDENT_CHECK` and `SCOPE_UNIMPLICATED_FILE` unless `ctx.independentCheck.ran` and
> `ctx.defect` are supplied, and `runGate` supplies neither — adopting every code would make
> **every** proposal refuse for ever, which is the mirror-image bug and the one direction that
> does stop the pipeline. **Those two codes are therefore still UNENFORCED at Tier 3**, with
> the precondition written into `proposal.mjs`'s docblock: make `defect` and `independentCheck`
> required inputs to `runGate`, which means the gate needs a caller that supplies a real defect
> record and an executed replay. Carried forward.
>
> **AND `noOpAblation` IS A STRING NOTHING EXECUTES.** `proofsFor` requires it non-empty;
> no code in the lane runs an ablation, so a Tier-2 agent that fabricates that string
> satisfies the proof. The three CONTAINER proofs cannot be fabricated this way, which is
> exactly why they are the ones with the mode gate.

### 6.4 The known-bad set. This is the part the whole design turns on

S8 proves the grader still passes good work. **Nothing in S3–S8 proves it still FAILS bad
work.** A grader returning `heldOutPass = true` unconditionally passes every step above.

**What exists, and it is stronger than the brief implies — credit it.**
`dashboard/server/src/calibration/fixtures.ts` (406 lines) + `calibration.test.ts` are a
real known-bad corpus, and the assertions are not merely "it failed":

- 7 fixtures; `MUST_FAIL = FIXTURES.filter(f => f.expected === "fail")` (`fixtures.ts:406`)
  → 5 members.
- `calibration.test.ts:278-286` **re-derives** `MUST_FAIL` and asserts length ≥ 5. Emptying
  it is mutation M4, and `fixtures.ts:33-38` records it *left the entire gate green at 7/7*
  under the outcome-only test — which is why the derivation assertion exists.
- `:290+` asserts `heldOutPass === false` per fixture — the bake-off's own co-primary
  metric, not the dashboard's tier arithmetic. A separate mutation (M5) proved this clause
  independently.
- Per-fixture NAMED gate at NAMED tier, **with the negative arm** (`assert.ok(!verdict
  .failedGates.includes(gate))` for gates that must NOT fire). "Fails for a different
  reason" is caught.
- The false-FAIL control: `correct-portfolio` must pass with `heldOutPass === true`.
- An archived proof the corpus CAN go red:
  `probes/results/calibration-4a.mutation-gutted.json` → `falsePasses:
  ["blank-page","missing-section","stub-markers"]`.

**The gate's rule:** the five `MUST_FAIL` fixtures must still fail, each by its named gate
at its named tier, with `heldOutPass === false`. Any that starts passing, or starts failing
for a different reason → REFUSE.

**THE FULL SET, and the three gaps:**

| | control | status |
|---|---|---|
| A | 5 × `MUST_FAIL` — named gate, named tier, `heldOutPass=false` | **EXISTS** |
| B | `correct-portfolio` passes; `stock-motion-only` = pass_with_notes/QUALITY | **EXISTS** |
| C | `MUST_FAIL` re-derivation + length ≥ 5 | **EXISTS** |
| D | `reward-hacked` trips all four planted exploit findings by id | **EXISTS** |
| E | **exfiltration** → `protectedPathViolations` non-empty | **MISSING, cheap.** `STATE` cites a probe that caught a byte-identical copy of a holdout spec; `find . -name '*exfil*'` → nothing, the scratchpad is reaped, and Appendix A reproduces the *runner*, not the planting step. ~15 lines on top of it: stage run 1's artefact, drop a holdout spec in as `stolen-suite.mjs`, re-score, assert non-empty. **It is the only control that covers suite integrity — the thing that makes `heldOutPass` mean anything.** |
| F | `collectManifestProblems` must-reject corpus, one field per case | **EXISTS in `scorer-protocol.test.ts` (8 refs), UNCOMMITTED.** Freeze it there. Extend to all seven required fields plus the two cross-field rules, each asserted rejected **with that field named**, plus a valid manifest of each `kind` asserted accepted (`:345` already does the accept arm). |
| G | **a populated-`dataExpectations` fixture, and its restored control** | **MISSING, HIGHEST VALUE.** §2.3 point 2. A ninth artefact `persistence-hollow`: SERVER mode, boots, serves 200, answers `POST /api/contact` with 201 and **writes nothing**; frozen suite carries a real `dataExpectations` entry of the shape at `bakeoff/docker/README.md:391`. Expected FAIL, carried by the data-expectation result labelled `db-query-7`. **Paired control, as one mutation not a second directory:** the same artefact with the INSERT restored must PASS. Plus an `http`-kind sibling, because only one of the two `kind` branches would otherwise ever execute. **Digest-free** — the artefact is dashboard-side, the e2e half is `bakeoff/test/`. |
| H | `hollow-section` — the standing proof the visual gate's calibration is not vacuous | **EXISTS, UNWIRED.** Assert `expectedWithoutVisualGate` so it is a live row rather than a comment. |

**Land G and F before arming Tier 3.**

> ### IMPLEMENTED 2026-08-10 — 22 REGISTERED, 17 ARMED, 5 UNARMED, AND ZERO CONTAINER ARMS
>
> `tools/tier3/known-bad.mjs`. **Armed arms execute REAL frozen code** imported from an
> isolated copy of `bakeoff/dist`: `scorer.stageArtifact` (forbidden-prefix plant AND control
> **E**, a byte-identical copy of a frozen suite file at the innocuous path
> `src/stolen-suite.mjs` → `protectedPathViolations`), `tier0.evaluateSqliteExpectation`
> (Fixture **G**, both sides), `scorer-protocol.collectManifestProblems` (`a913c871`'s real
> attempt-1 and attempt-3 shapes), `contracts.computeHeldOutPass` (empty gate never passes;
> one violation is an instant fail; an honest artefact still passes).
>
> **`aggregateKnownBad` checks the FLOOR FIRST**, because an emptied registry has no
> deviations — the exact mutation `calibration/fixtures.ts:33-38` records as having left the
> gate green at 7/7. Mutation-proved: deleting the floor produced
> `✖ an emptied known-bad registry REFUSES rather than reporting no failures … actual: 'PASS'`.
> An executor that throws or returns no boolean is **INCONCLUSIVE**, never "no failure found".
> Container legs are **REGISTERED as UNARMED, not omitted** — omitting them is what makes a
> gate lie — and UNARMED degrades any proof that depends on it to INCONCLUSIVE.
>
> **G IS BUILT AND IS THE FIRST POPULATED `dataExpectations` IN THIS REPOSITORY**, as one
> mutation rather than two directories: `bakeoff/test/tier3-fixtures/persistence/schema.sql`
> (table exists, zero rows — so it fails for the RIGHT reason, not "database missing") vs
> `schema.sql + insert.sql`, plus `server.mjs.template` with one `__PERSIST_HUNK__` and a
> `suite.manifest.json` carrying BOTH a `sqlite` and an `http` expectation, accepted by the
> real `parseSuiteManifest`/`collectManifestProblems` with `[]` problems. The sqlite side runs
> LIVE against the exported frozen `tier0.evaluateSqliteExpectation`: hollow →
> `observed 0 row(s), required >= 1` unsatisfied; restored → `observed 1 row(s)` satisfied.
> **The `http` leg and the end-to-end persistence gate need the container and are UNARMED.**
>
> **The impossible-ticket set** is 4 anchors on disk
> (`bakeoff/test/tier3-fixtures/impossible/`), 2 armed (`imp-002` a table no artefact has,
> `imp-003` `minRows 9999`) and 2 UNARMED — and the 2 UNARMED are the only real
> ImpossibleBench-shaped ones (spec forbids persistence vs sealed suite requires a row; spec
> says single page vs suite requires `/checkout/step-2`). The armed pair contradicts the
> ARTEFACT, not the spec, and says so in its own files. The directory is in
> `ADMISSION_PREFIXES`, so **any diff touching it is REFUSED at any tier** (`RESEARCH` R10 — a
> movable anchor is not an anchor); mutation-proved by dropping the admission branch.
>
> **THE HONEST CEILING: 17 arms held, 0 container arms executed.** A host import proves the
> function on disk still rejects bad input; it does not prove the SEALED scorer still fails
> bad work. The aggregator refuses to let host evidence satisfy a closure proof, so this is
> honest rather than dangerous — but the gate's negative arm for the sealed grader is
> **unarmed**, and says so in every trail record.
>
> **CARRY-FORWARD FINDING, cheap and easy to repeat:** `bakeoff/src/scorer.ts:494` reads
> `suiteFileDigests` as **digest→path**. The first exfiltration fixture built it path→digest
> and the arm found no violation — it reported DEVIATED rather than passing, which is the
> negative arm working, but anyone building that map the intuitive way gets a suite-integrity
> check that can never fire.

### 6.5 WHAT THE GATE CANNOT CATCH — stated as construction, not as oversight

**A prompt edit is invisible to S3–S8 by construction.** Those steps grade **frozen
artefacts against frozen suites**. The spec seat never runs. So the exact repair
`a913c871` needs passes the entire gate without the gate having observed anything about it.

**The sharpest instance, with a file name.** `bakeoff/src/spec-validate.ts` is EDITABLE (it
imports `collectManifestProblems` at `:44` but is not in the closure) and it **is** the
bad-test audit — the checker for the very artefact class the first repair touches.
Softening it moves no `heldOutPass` on a frozen artefact. What it changes is which suites
get frozen *next*: weaker criteria, authored honestly, passed honestly. **That is a
criterion-generation change producing weaker criteria which then pass honestly, and the
sealed gate cannot see it.**

**The best available proxy already exists.** `dashboard/server/probes/calibration-authoring.mjs`
(Task 4B) authors a suite from `PORTFOLIO_TICKET` with the real spec seat and no fixture
knowledge, audits it with the real `spec-validate` plus the adversarial judge, then scores
all seven fixtures against it and computes a discrimination check that does not look at
outcomes. Three committed baselines (grounding agent's measurement, not re-run here):

| record | criteria | attempts | tiers B/F/Q | correct | falsePasses | discriminating |
|---|---|---|---|---|---|---|
| 4b | 11 | 2 | 4/3/4 | 7/7 | `[]` | 7 |
| 4b-run2 | 10 | 1 | 3/3/4 | 5/7 | `[]` | 6 |
| 4b-run3 | 10 | 1 | 3/3/4 | 5/7 | `[]` | 5 |

`correctCount` varies 7/7 → 5/7 → 5/7 between runs. **Gating on correctness is gating on
noise.** What is stable is `falsePasses == []` and `discrimination.measured == true`.

```
HARD GATE:    falsePasses == []  AND  discrimination.measured == true  AND  auditPassed
DRIFT ALARM:  criteriaCount outside 10-11; tier distribution outside B 3-4 / F 3 / Q 4;
              discriminatingCriteria below 5; attempts above 2.
              → alarm to the trail and the dashboard; require a human eye before the
                NEXT self-apply. Not a rollback of this one.
```

**Cost, and it is the dominant expense in the loop.** 4B spawns a real spec seat at
`effort: xhigh, maxTurns: 16` plus seven container scores. Run per-patch it costs more than
everything else combined. **Batched:** unconditionally on any diff touching
`spec-validate.ts` or the criterion-generation path; otherwise on a rolling budget (every
Nth authoring-closure patch or once per K hours, whichever first), with the queue of
unproxied patches visible on the dashboard. **An unattended system that cannot afford its
own proxy does not run it, and then the proxy is a document.**

**Even with 4B, three things are not covered.** §10.

### 6.6 THE GATE'S OWN ARM CHECK — run at S0, before every cycle

A gate that always passes is indistinguishable from a healthy system. The canonical
instance is `RUN-a913c871-observations.md:100-133`: *"the watcher I built to catch Finding
1 had Finding 1's defect"* — it printed `0.0% cpu, 38 MB`, an idle HTTP server, and *"would
have printed a healthy seat forever after the seat died."* The rule from that finding is
the rule here: **a probe whose failure mode is "prints nothing" needs a control at start,
when the answer is known.**

| arm | what it does | cost |
|---|---|---|
| **A1 frozen-manifest** | flip one byte of a frozen file in the isolated copy; the verifier must report mismatch. Restore. Reports OK → the verifier is blind → REFUSE | free |
| **A2 manifest-reject** | feed the §6.4-F corpus through `collectManifestProblems`; every case must be rejected **naming its field**, and the valid manifest must return `[]`. Any acceptance → REFUSE | milliseconds |
| **A3 rescore** | re-score run 1 with a `run.json` naming a nonexistent artefact; the gate must throw or return `heldOutPass=false`. Returns true → the re-score step is inert | one container |
| **A4 calibration** | replay the archived gutted suite and require the harness to report `blank-page` as a false pass. **Schedule this, not every cycle** — it costs container time | ~32 s |
| **A5 write-allowlist** | attempt one frozen-path write from inside the repair agent's own tool surface and observe the refusal. Succeeds, or the harness cannot tell whether it was attempted → the only prevention layer is inert → REFUSE | free |

Each arm prints in the first lines of the cycle log, in the a913c871 idiom:

```
ARM CHECK A1 frozen-manifest: mismatch detected on 1 planted byte (must be 1)
ARM CHECK A2 manifest-reject: 9/9 rejected, 1/1 valid accepted (must be 9/9 and 1/1)
ARM CHECK A5 write-allowlist: 1 refusal observed on 1 attempt (must be >=1)
```

**A cycle whose arm-check block is absent is a cycle whose gate is unproven, and the apply
step treats absence exactly like failure.**

**The all-green detector.** After K consecutive all-green cycles (start K = 10), require a
fresh A4 before the next apply and badge the dashboard. **A long green streak is a prompt
to re-arm, not a reassurance.**

**When the gate is broken, fail closed and be loud.** Tier 3 self-apply is DISABLED (state
persisted, not in memory). **Tier 2 continues** — the repair agent still diagnoses and
queues; the patches simply do not apply. **Tier 1 continues unaffected; the run does not
stop.** The dashboard shows a red autonomy banner naming the failing arm. This satisfies
the owner's constraint: the system degrades from self-applying to self-proposing, and says
so.

> ### IMPLEMENTED 2026-08-10 — FIVE ARMS LIVE, TWO REGISTERED UNARMED
>
> `tools/tier3/armcheck.mjs`. Each arm is exercised while the answer is known, and each prints
> its MEASUREMENT rather than its conclusion:
>
> ```
> ARM CHECK A1 frozen-manifest: mismatch detected on 1 planted byte (must be 1); clean before true, clean after restore true — OK
> ARM CHECK A2 manifest-reject: 5/5 rejected naming their field, 1/1 valid accepted (must be 5/5 and 1/1) — OK
> ARM CHECK A3 data-expectation: hollow satisfied=false (must be false), restored satisfied=true (must be true) — OK
> ARM CHECK A4 classifier: scorer.ts→INSIDE-CLOSURE impossible-set→REFUSED bakeoff/test→OUTSIDE-CLOSURE — OK
> ARM CHECK A5 trail-append: 1 write accepted, 1 overwrite refused on 1 attempt (must be >=1) — OK
> ARM CHECK A6 rescore: UNARMED — needs the sealed image
> ARM CHECK A7 calibration: UNARMED — needs ~32 s of container time
> ```
>
> `runArmChecks` asserts `armed === 5` **as well as** `blind === 0`, because `blind.length === 0`
> is green on an empty arm list. A4 fails if the three routes are not all DISTINCT — the arm
> that catches a router stuck on one answer. Blinding A1 or A3 independently drove the gate's
> own verdict to `REFUSE-BLIND`, and neutering the blind-arm branch produced
> `✖ a blind gate applied a patch. actual: 'APPLY', expected: 'REFUSE-BLIND'`. **The fail-closed
> behaviour this section specifies is implemented and mutation-proved; the red autonomy banner
> is not built** (the gate is a CLI with no dashboard surface).

### 6.7 The audit trail

**Reuse, don't invent.** `dashboard/server/probes/README.md` already specifies the shape and
names the anti-pattern: `results/<probe>.json` mutable pointer,
`results/history/<probe>-<runStamp>.json` immutable, `history/index.jsonl` append-only,
`PROBE_RESULTS_DIR` redirect — with its own confession that before 2026-07-28 the writer
silently overwrote, so *"re-run until it goes green" was frictionless and invisible*.

**MEASURED GAP, and fix it before Tier 3 is armed.** `calibration-4a.mjs` does **not** use
that mechanism:

```
grep -an "outFile\|history\|index.jsonl" dashboard/server/probes/calibration-4a.mjs
→ 204: const outFile = join(RESULTS, …)   273: readFileSync(outFile)   292: writeFileSync(outFile, …)
```

No history file, no superseded copy, no index line. **Today, re-running calibration until
it goes green is frictionless and invisible for the single most important measurement in
the gate.** ~10 lines, load-bearing.

**The trail itself (PROPOSED):** `probes/results/tier3/history/<runStamp>-<change>.json`
immutable, `tier3/index.jsonl` append-only, `tier3/latest.json` pointer. One record per
self-applied patch:

```
runStamp, change slug, defectId
WHY        the failure_reason / finding that triggered it, verbatim
WHAT       diff by path + per-file sha256 before and after; the EDITABLE-set
           assertion and its result
frozen.manifest digest + verify result
rollback   { imageTag: "pre-<change>", imageId, sourceSha, bundlePath }
gate       one field per S1-S10, each carrying the ACTUAL NUMBERS:
             rescore     { heldOutPass, testsTotal, testsPassed, testsFailed, failingCriteria }
             calib4a     { outcomeMismatches, tierMismatches, falsePasses, exitCode }
             calibTest   { pass, fail }
             knownBad    { exfil, manifestReject, dataExpectations } per item
             proxy       { ran, why, falsePasses, discrimination, driftAlarms[] }
evidence   the three mutation transcripts from §5.3, verbatim
applyToken the L4 digest
armCheck   the §6.6 result for this cycle
humanReviewed  null | { by, at, verdict }    ← starts null, only a human sets it
```

`humanReviewed` exists so that *"has anyone ever looked at this?"* is a field and not a
memory.

> ### IMPLEMENTED 2026-08-10 — AND THE LOCATION THIS SECTION SPECIFIES IS DELIBERATELY NOT USED
>
> `tools/tier3/trail.mjs`: immutable `history/<stamp>-<change>.json`, append-only
> `index.jsonl`, `latest.json` pointer, `humanReviewed: null`, `unreviewed()` answering
> *"has anyone ever looked at this?"* from the index. `appendTrail` **refuses** (returns
> `{ok:false, reason}`, does not throw) if the history record already exists — the mechanism
> `probes/README.md` specifies and which this section measures as MISSING in
> `calibration-4a.mjs`. Mutation-proved: deleting the `existsSync` refusal reddened 5 tests
> including arm A5, i.e. blinding the trail also takes the arm down, which is the coupling that
> makes *"re-run until green"* detectable.
>
> **CORRECTION TO THIS SECTION, and it needs the owner to ratify one of the two.** §6.7 puts
> the trail at `dashboard/server/probes/results/tier3/`, which is **inside the FROZEN-DATA
> prefix `dashboard/server/probes/results/`**. Writing there means the gate's own output moves
> the frozen manifest on every cycle, so the gate's integrity check would invalidate itself.
> The implementation therefore defaults to `dashboard/data/tier3/` (`TIER3_TRAIL_DIR`
> overrides), documented in `trail.mjs`. **That directory is gitignored** — 4 records exist
> there today from the verification runs and `git status --short` shows none of them. So the
> append-only audit trail the gate depends on is invisible to git and nobody has said where it
> is backed up. **Ratify one:** amend this section to the implemented location, or move
> FROZEN-DATA's boundary.
>
> **Two fields the shipped record adds:** every known-bad result carries its `mode`
> (`host-import` vs `container`), and the evidence bundle is filed under `negativeControl`
> rather than a name implying correctness (`RESEARCH` W5 — it is a vacuity control, never a
> correctness proof). `rollback.imageTag` is `null` with the reason stated, because the lane
> built no image.

---

## 7. THE SUPERVISOR

### 7.1 It cannot be a second process

`cron/cron-tick.ts:4-12` states the constraint in its own words: a tick *"DOES NOT
CONSTRUCT AN `Orchestrator` OR OPEN `runs.db`… Two `Orchestrator`s against one `runs.db` is
the corruption case (both would `pump()`, both would claim the same queued row, two
builders would run in one workspace), and it is designed out rather than discouraged."*

**Therefore the supervisor is a class inside the dashboard server process**, constructed in
`index.ts` beside the orchestrator, sharing the `RunStore`. `node:sqlite`'s `DatabaseSync`
is synchronous single-threaded, so it needs no locking beyond a re-entrancy flag and
conditional `UPDATE`s. The existing `cron/` subsystem is untouched; it keeps submitting over
loopback into the same queue.

**Nothing named supervisor exists today.** `sqlite3 … ".tables"` → `criteria events
messages metered_spend run_attempts runs screenshots seat_spend`. And the `/start`|`/stop`
routes at `http.ts:943` are the **published-project preview controls**
(`POST /api/projects/:slug/start`), not an autonomy switch. The owner's switch is new
surface.

### 7.2 Durable state — three new tables

New tables are free on the existing database (`db.ts:586`: *"A NEW TABLE IS FREE ON AN
EXISTING DATABASE — `CREATE TABLE IF NOT EXISTS` creates it empty… which is why this needs
no entry in `ADDED_RUN_COLUMNS`"*).

```sql
CREATE TABLE IF NOT EXISTS supervisor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  desired    TEXT NOT NULL,   -- 'running' | 'draining' | 'stopped'
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,   -- 'owner' | 'boot' | 'guard'
  reason     TEXT NOT NULL    -- never blank
);

CREATE TABLE IF NOT EXISTS supervisor_tickets (
  ticket_key   TEXT PRIMARY KEY,
  ticket_text  TEXT NOT NULL,       -- the FULL brief
  model_id     TEXT NOT NULL,
  design_lock  TEXT NOT NULL DEFAULT 'auto',   -- the never-park lever, §7.4
  state        TEXT NOT NULL,       -- queued|claimed|running|repairing|waiting|blocked|done|abandoned
  attempt_no   INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  class_counts TEXT NOT NULL DEFAULT '{}',     -- the per-class budgets of §3.5, JSON
  current_run_id TEXT, last_run_id TEXT, last_class TEXT,
  last_defect_id TEXT, patch_id TEXT,
  graded_suite_sha256 TEXT, graded_scorer_digest TEXT,
  enqueued_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  next_action TEXT NOT NULL,        -- ALWAYS a sentence. Never ''
  next_action_at TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS supervisor_log (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL,
  ticket_key TEXT, run_id TEXT,
  decision TEXT NOT NULL,  -- claimed|submitted|settled|routed|patched|rerun|waiting|blocked|drained|aborted|refused
  reason   TEXT NOT NULL
);
```

`next_action TEXT NOT NULL` **with no default** is the anti-signature-defect measure at the
schema level: a ticket cannot be written into a state that has nothing to say about itself.

`supervisor_log` follows `cron-tick.ts:14-20` verbatim in intent — *"Six of the seven ways a
tick can end produce the identical observable… so EVERY terminal path appends exactly one
journal outcome row naming the decision and why."*

### 7.3 The loop

`SupervisorLoop.tick()` — synchronous decision, one `void`ed submission, re-entrancy-guarded
as `pump()` is. Called from four places, never recursively: after
`orchestrator.reconcileOnBoot()` in `index.ts`; a 30 s `setInterval`, `unref()`ed and
cleared in `shutdown()`; a **wrapped** hook at the end of `Orchestrator#finish`; and
`POST /api/supervisor/start`.

```
0. state = readState()
1. RECONCILE  for every ticket in claimed|running|waiting:
     run row null            → ticket back to 'queued', log settled/vanished
     isTerminal(row.status)  → settle(ticket, row)                       §7.5
     rate_limited|awaiting_input → 'waiting', next_action from the row,
                                   next_action_at = resume instant or now+15m
     else                    → leave alone; the run is live
2. WAKE       for 'waiting' tickets past next_action_at:
     resume(runId) if !isTerminal   -- legal and CHEAP; try first
     else re-submit                 -- §7.4
3. if state !== 'running':
     if nothing in flight and state === 'draining':
        setState('stopped', by 'guard', 'the drain finished'); log drained
     return
4. CLAIM      if nothing in flight:
     UPDATE supervisor_tickets SET state='claimed' WHERE ticket_key=? AND state='queued'
       -- conditional; check changes() === 1
     submit(ticket)
```

Step 1 is what makes the loop survive its own restart: **nothing about which ticket is in
flight lives in memory.** A crash mid-submission leaves a ticket `claimed` with a null
`current_run_id`; the next tick logs `settled/orphan-claim` and returns it to `queued`.

**One ticket in flight at a time**, matching the orchestrator's single active slot. "In
flight" is *any run named by a `current_run_id` whose status is non-terminal* — not
`activeRunId` — because a rate-limited run is parked with no active slot and the supervisor
must not claim a second ticket on top of it.

> ### IMPLEMENTED 2026-08-10 — WITH A CAP THIS STEP LIST OMITS, AND THE OMISSION WAS A SPIN
>
> `dashboard/server/src/supervisor.ts` (`SupervisorLoop`, re-entrancy-guarded `tick()` at
> `:367`), the three tables + typed accessors in `db.ts`, 22 tests in `supervisor.test.ts`.
> `settle()` reads the retry budget from `recovery.ts#boundFor` rather than restating it, and
> an unknown class (`boundFor` has no default arm) is treated as no-retry;
> `next_action TEXT NOT NULL` with no default is the schema-level rule that a ticket cannot be
> filed mute. **Crash recovery was verified with a real `kill -9`**, not read: SIGKILL from
> inside `submit` after the claim, then a NEW loop over the SAME db file → `desired='running'`
> survived, health BEFORE any tick read `stuck-orphan-claim` with
> *"ticket t-verify-1 is claimed but names no run — the submission was lost between the claim
> and the run row"*, and the next tick requeued and submitted exactly once.
>
> **THE STEP LIST ABOVE HAS NO ATTEMPT CAP IN STEP 4, AND THAT WAS A REAL DEFECT.** The cap
> lived only in `settle()`, which runs only when a run reaches a TERMINAL status. Two paths
> walked past it: (a) the submission-throw catch returned the ticket to `queued` **without
> incrementing `attemptNo`**, so a deterministically throwing `submit` (bad model id, missing
> directory, full disk) re-claimed every 30 s **for ever** — no increment, no backoff, no cap,
> while reporting progress; (b) step 2's wake re-queues a non-resumable run for a fresh
> submission, and a ticket whose runs keep landing non-terminal could exceed `maxAttempts`
> without bound. **FIXED:** step 4 now reads `attemptNo >= maxAttempts` **before** submitting
> and settles the ticket to `blocked` (never `queued` — §7.6's one rule) at ~~`supervisor.ts:455`~~
> **`:926`**, which closes the wake path too because a woken ticket arrives at that same line; and the
> throw path now counts the attempt at ~~`:518`~~ **`:989`**, so the spin is bounded by `maxAttempts`
> ticks. Two tests, each with a negative half (a ticket one attempt below the cap IS submitted).
>
> > **RE-MEASURED 2026-08-10 (strip-crash round) — two corrections and one addition.**
> > **(a) THE LINE NUMBERS ABOVE WERE WRONG** and were being reused by later reports: the cap read is
> > at **926** and the throw-path increment at **989**. Struck through rather than silently swapped,
> > because a stale citation that looks precise costs more than an absent one.
> > **(b) THE WAKE PATH WAS PROVED BY A TEST THAT COULD NOT SEE IT.** Both pre-existing cap tests
> > built the post-wake row by calling `updateSupervisorTicket({state:'queued', attemptNo:1})`
> > **directly**, so they proved the guard handles that row and **nothing** about whether `#wake`
> > produces it. Under a mutation that makes the wake branch forget the attempts already spent
> > (`attemptNo: 0`), **both of them stay GREEN.** A new test drives the real documented loop end to
> > end — submit → `rate_limited` → `waiting` → clock past the wake instant → `#wake` re-queues → … →
> > `blocked` — and asserts every run in the sequence is still non-terminal, so `settle()`, the cap's
> > old sole reader, provably never runs. **The guard was right; the proof was pointed at a hand-built
> > row.**
> > **(c) THE STEP LIST NOW HAS A REPAIR STEP**, between reconcile/wake and step 3's early return.
> > §5.2's dated block is the mechanism, and the placement is load-bearing for the reason given there.
>
> **STILL MISSING, and it is not pretended otherwise:** exponential backoff on consecutive
> submission failures, and any per-ticket wall-clock or spend ceiling
> (`grep -c "wall\|deadline\|budgetMs" dashboard/server/src/supervisor.ts` → **0**). The only
> spend brake is `budget_exceeded → owner_action → blocked`, which depends on the provider
> reporting it. Note the constraint found while measuring: the claim step reads
> `listSupervisorTickets(['queued'])[0]` with **no time filter**, so `nextActionAt` on a
> `queued` ticket does not delay a claim — `waiting` + `nextActionAt` is the viable backoff
> state.
>
> **AND ONE ORPHAN THE RECONCILE CANNOT SEE (reasoned from the code, not measured):** a
> submission that creates the run row and *then* throws leaves the ticket `queued` with
> `currentRunId` still null, while `#inFlight()` (`:567`) decides in-flight purely by walking
> TICKETS and reading the run each one names. A run row named by no ticket is therefore
> invisible to the claim guard and to `GET /api/supervisor`, and the next tick submits a
> second run. Fix is either minting and persisting the run id as `submitRun`'s first act, or
> reconciling by scanning `runs` for non-terminal supervisor-owned rows named by no ticket.

### 7.4 Submission, and the never-park policy

**Submission goes through `createRun`'s logic, not around it.** That is where ticket
identity is minted, reference images and documents are hashed into that identity, the
capture and motion reads happen, and `designLockInteractive` is evaluated. Bypassing it
mints a *different* ticket id, which finds no frozen suite and pays to author another one
— with no throw and no compile error. **Recommendation:** extract `createRun`'s body below
the parsing into `submitRun(deps, spec)` and call it from both the HTTP route and the
supervisor. **Zero-refactor fallback:** a loopback `fetch` to `http://127.0.0.1:<port>/api/runs`
with no `Referer`, which is exactly what `cron-tick.ts` already does and is proven.

**The never-park lever already exists as one field.** Measured:

```
grep -an "export function planPolicy" -A 3 dashboard/server/src/plan-record.ts
→ 111: return interactive ? "ask" : "skip";
grep -an "export function designLockPolicy" -A 6 dashboard/server/src/design-lock.ts
→ 48-51: if (requested === "ask") return "ask"; if (requested === "auto") return "auto"; …
```

So the body is `{ ticketText, modelId, designLock: "auto", deploy: false }` with no
`Referer`, and both parks are **unreachable, not defaulted**.

| park | supervisor run | the record |
|---|---|---|
| plan questions | **unreachable** — `planPolicy(false)="skip"`, no seat call | `plan.json`, `folded:true`, and the skip sentence *"this run was not submitted from the dashboard, so there was nobody to answer a question; the planning seat was not called and the criteria are authored from the ticket alone"*. **That record already exists. Do not add a second one.** |
| design lock | **unreachable** — `designLockPolicy("auto",…)="auto"` before `interactive` is consulted | `design-lock.json` never written with `awaiting:true` |
| rate limit | **reachable and correct. Keep it** | the `runs.rate_limited*` columns |
| **`awaiting_input` past the ceiling** | **the real hole** — `RECOVERY_MAX_AUTO_WAIT_MS = 12h` (`recovery.ts:227`) and `AUTO_CONTINUE_MAX = 3` both end here, and *"`awaiting_input` has no other exit"* (`orchestrator.ts:1810-1819`) | supervisor `waiting` state |

For the fourth, the supervisor **polls rather than holds a timer**: the ticket goes
`waiting` with `next_action_at` in the table and step 2 re-checks every 30 s. A seven-day
wait then costs nothing, survives every restart, and needs no change to
`RECOVERY_MAX_AUTO_WAIT_MS`. That ceiling's own objection — *a run silently holding a timer
for three and a half days LOOKS like the twelve-hour death of 2026-07-30 from outside* — is
answered by the surface in §7.6 showing the wake instant, not by shortening the wait.
PROPOSED, not measured: the wait path has never executed (every refusal recorded on this
machine is `seven_day` with `limited:false`).

> ### MEASURED 2026-08-10 (strip-crash round) — A FIFTH PARK THIS TABLE DOES NOT LIST: ILLEGAL INPUT ACCEPTED AT THE DOOR
>
> The never-park policy was written about what a RUN does. It said nothing about what the QUEUE
> accepts, and that was a park: **`POST /api/supervisor/tickets` answered `201` for
> `{"modelId":"no-such-model"}`.** The catalog check existed, at SUBMIT time — so the typo cost one
> full attempt and a terminal `blocked` ticket two ticks later (`supervisor_log`: *"the submission
> threw and the ticket was returned to the queue: no-such-model is not in the catalog"*). Bounded,
> ~10 s, no orphan run row, no spin — **and a brief filed at midnight that never runs, discovered in
> the morning.** Fixed at filing time: **`400 invalid_model`**, live-verified.
>
> **THE GUARD IS THREE-ARMED ON PURPOSE, AND THE TWO-ARMED VERSION WAS FALSIFIED BY THE LIVE CLI
> INSIDE THE HOUR.** An id that IS in the catalog is filed whatever `available` says (auth can come
> back before the loop claims it); an absent id is refused **when the catalog enumerated**; an absent
> id is **FILED when the catalog could not enumerate**, because *losing a brief to a failed probe is
> the worse error* — which is this section's own never-park reasoning applied to the door. The first
> version inferred the degraded state from the absence of a fallback row's id, and this machine's
> `GET /api/models` answers `['default','opus[1m]','claude-fable-5[1m]','sonnet','haiku']`: **a
> healthy catalog contains a model whose id is literally `default`**, so a healthy catalog read as
> degraded, the live server still answered 201, and the unit test was green against a fixture that
> had no such row. **The catalog now reports what only it knows (`ModelCatalog.enumerated()`) and the
> fixture carries the real CLI's row, so the test can fail the way production did.**

### 7.5 START and STOP semantics — STOP means DRAIN

**STOP sets `desired='draining'`.** The loop stops **claiming**; the in-flight run runs to
its own verdict; when nothing is in flight the state becomes `stopped`. The reasoning is in
the code, not in taste:

- `cancel()` aborts the active run, `#finish` writes a terminal status, and `resume()`
  refuses a terminal row (`db.ts:496`: `passed|failed|cancelled` are terminal).
- The classifier then gives `intentional`, and `boundFor("intentional") → 0`
  (`recovery.ts:144-145`), so nothing will ever continue it automatically.
- **So abort-now converts a resumable run into an unresumable one and throws the workspace
  away** — the precise loss `reconcileOnBoot`'s own docblock exists to end: *"that is how
  52 minutes and 12 hours of real work came to be waiting on a click."*

A drain-stop needs no new terminal status, no new abort path and no change to `isTerminal`.

**ABORT NOW is a second, differently-labelled, confirm-required control** calling the
existing `cancel()`. Its record: `supervisor_log` decision `aborted`, and the ticket goes to
**`blocked`, not `queued`** — otherwise the next START immediately re-spends on the run the
owner just killed.

**STOP is the supervisor's control, not the orchestrator's.** `pump()` is untouched, so an
owner-submitted run from the page still starts. **Say so on the control, or it lies about
its scope.**

**START:**

- from `stopped`, nothing in flight → `desired='running'`, claim the oldest `queued`.
- after a drain → the ticket already settled; move to the next.
- **after an abort or any `failed` run → `resume()` CANNOT be used** (terminal;
  `409 not_resumable`). START **re-submits `supervisor_tickets.ticket_text` as a new run.**
- on `rate_limited` or `awaiting_input` → `resume()` **is** legal and is the cheap path.
  Try it first.

**A re-run's cost is decided by ticket identity, not by luck.** `#specPhase` opens with
`assertSuiteIntact(ticket.id, …)` and on success reuses the frozen suite with no seat call.
Same brief bytes plus same reference digests → same id → reuse. `a913c871`'s
`ticket_text` is **13,714 chars** carrying both rounds of folded Q&A, and its `suite_sha256`
is `''` with no `dashboard/acceptance/t-b79ff5e2a1b314e4`, so its re-run correctly pays a
fresh spec phase — which is right, because the defect was in authoring.

### 7.6 Settling, routing, and what the owner sees

`settle(ticket, row)` reads `status`, `recoveryClass`, `failureReason`, `heldOutPass`:

| observed | ticket → | why |
|---|---|---|
| `passed` | `done`, or `done-under-changed-grader` if the suite sha or scorer digest moved | §7.6.1 |
| `failed`, `structural` | `repairing` + defect record | `boundFor("structural") → 0`: the layer that still had the evidence declared a byte-identical retry futile. **This was `a913c871`'s measured class.** |
| `failed`, `intentional` | `blocked` | a human said stop |
| `failed`, `unclassified` | `repairing`, record marked *cause unknown* | the evidence channel; it must reach a readable record, not a retry |
| `failed`, other, `attempt_no < max` | `queued`, `attempt_no += 1`, backoff | — |
| `failed`, at `max` | `blocked`, all defect records attached | never loop |
| `cancelled` | `blocked` | — |

**The ticket's `attempt_no` is a different counter from `runs.auto_continue_count` and must
stay that way.** `recovery.ts:112-118` is explicit that mixing counters is how a bound stops
working. Two questions, two numbers.

> ### SUPERSEDED 2026-08-10 (strip-crash round) — THE `repairing` ROWS NOW HAVE AN EXIT, AND A THIRD COUNTER
>
> **Both `repairing` rows in the table above were, as shipped, a park:** `settle()` was the only
> producer and nothing read the state back. A repair step in `tick()` now routes every repairing
> ticket to one of six named outcomes, five terminal, bounded by a 30-minute per-ticket deadline and
> 2 cycles per signature — **§5.2's dated block is the mechanism.** With no driver wired, which is
> today's state, the row's real behaviour is: `failed, structural` → `repairing` for exactly one
> visible tick → **`blocked` with `NO_REPAIR_DRIVER` and a sentence naming the signature and the
> class.** Measured live, not reasoned.
>
> **AND THIS SECTION'S COUNTER RULE FORCED A THIRD COLUMN.** The per-signature cycle bound could not
> live in `attempt_no` (a repair is not an attempt) and could not live in `class_counts` (a different
> question), so it is a new `supervisor_tickets.repair_counts`, with an additive migration and a
> DROP-COLUMN test because the owner's `runs.db` already has that table without the column. **Three
> questions, three numbers — and two JSON blobs on one row is now a convention that will rot if a
> fourth arrives; if per-class budgets ever get a real reader, both should become a table.**
>
> **ONE CONSEQUENCE THAT WILL READ ODDLY AND IS DELIBERATE:** an applied patch on a ticket already at
> `maxAttempts` is re-queued and then immediately blocked by the claim guard, so `patch_id` is set on
> a ticket that never re-ran — **a patch with no run behind it.** Letting a repair mint an extra
> attempt is exactly the counter-mixing this section forbids, so the odd-looking row is the correct
> one; it is now documented in the router rather than discovered on the strip.

#### 7.6.1 A ticket may not be marked `done` by a run whose grader moved

On every settle, record `runs.suite_sha256` and the scorer image digest (from
`dashboard/results/scores/<runId>.container.json` → `gate.scorerImageDigest`). If a re-run
passes under a different suite sha **or** a different scorer digest than the run it
replaces, the state is **`done-under-changed-grader`**, carrying both pairs. Measured
precedent: the project's one PASS was scored by `c98bad3a762b` (now tagged `pre-readmech`)
while the installed image is `b7a9fd0a0f58`. And **any Tier-3 patch to `bakeoff/src` moves
the digest by construction**, so this state will be common, not exotic.

#### 7.6.2 The surface — the five-second test

`RunSummary` is a frozen contract, so nothing goes on it. New additive route
`GET /api/supervisor` plus one always-mounted strip in `app-shell.tsx`. Seven fields, every
one non-empty by construction:

1. `desired` + since — `RUNNING since 03:14` / `STOPPED since 09:02 (owner)`.
2. current ticket — key, title, `attempt N of M`.
3. current run — runId, phase, the run's own status.
4. `attemptNo` — **from `supervisor_tickets`, not `run_attempts`.** That table files a
   failure as a completion: `#finish` writes `endClass: status === "cancelled" ?
   "intentional" : "completed"`, so `a913c871`'s attempt 2 reads `end_class=completed` on a
   run whose row says `status=failed, recovery_class=structural`.
5. `lastRepair` — patch id, the paths it touched, when, whether the re-run passed. Blank is
   not legal; the string is `"no patch has been applied"`.
6. `nextAction` + `nextActionAt` — the field that can never be blank.
7. `quietFor` — seconds since the last event on the current run **excluding `rate_limit`
   payloads**. That filter is the point: seven `rate_limit` frames chopped `a913c871`'s
   84m31s working silence into a largest real gap of 25.2 min, and both are under
   `DEFAULT_SILENCE_WARN_MIN = 90`.

**Arm check on the surface itself.** The endpoint returns `probe: { ticketsSeen, runsSeen,
eventsSeen }` and the panel renders **three visually distinct states** — stopped with
tickets queued, stopped with an empty queue, endpoint unreachable. A test asserts all three
differ. A status panel whose failure mode is "shows nothing" is the signature defect.

> ### IMPLEMENTED 2026-08-10 — FOUR OF THE SEVEN FIELDS ARE LIVE, THREE HAVE NO PRODUCER, AND THE a913c871 DETECTOR IS DORMANT
>
> `GET /api/supervisor` (`http.ts`, `api-types.ts`, `supervisor-route.test.ts`) reads
> `supervisor_state` and `supervisor_tickets` through the SAME `deps.store` that
> `SupervisorLoop.snapshot()` decides from, so a panel that says "idle" and a loop that is
> stuck **cannot disagree — there is no second copy of the answer to drift**.
> `composeSupervisorState()` is a pure function over a gathered input so the boot arm check can
> drive it with known answers. Two queue numbers, not one: `queueDepth` is the supervisor's
> backlog and `queuedRuns` is `runs.status='queued'`, because STOP does not touch `pump()`.
> Field 7's rate-limit filter is implemented (`supervisorQuietMs` skips `rate_limit` frames) and
> is the sharpest mutation proof in the round:
> `AssertionError: this run has produced nothing but telemetry since it started 90 minutes ago,
> so the clock must read ~5,400,000 ms, not ~0 (read 3)`.
>
> **THREE FIELDS ARE EMITTED AS `[]`/`null` AND NAMED ON THE WIRE IN `probe.unsourced`:**
> `attempts[]`, `lastDefect`, `lastRepair`. They were deliberately NOT synthesised from
> `run_attempts` — field 4 above exists precisely because that table files `a913c871`'s failed
> attempt as `end_class=completed`. Naming them on the wire is what makes an empty attempts list
> read as *nobody writes one yet* rather than *nothing happened*. The durable half ships as the
> server-only `lastDefectId`/`lastPatchId` read from `supervisor_tickets`.
>
> **CONSEQUENCE, and it is the single most important gap in the surface:** the strip's
> `attemptProgress` comparator — 11 liveness arms, the oscillation detector, mutation-proved
> both directions — is fed a named constant `ATTEMPTS_NOT_ON_THE_WIRE = []`
> (`supervisor-strip.tsx:71`, consumed `:164`), so it returns `unknown` with
> `escalatesAtAttempt: null` and **can never fire**. The only `stuck` arm reachable from a
> spec-phase loop is a 40-minute quiet wall — and `a913c871` emitted attempt boundaries every
> ~25 min, each resetting the quiet clock. **If that failure recurred tonight the strip would
> show a calm `running` for the full 87 minutes, exactly as before.** It is a one-field server
> change (`attempts: readonly {n, at, problems}[]` sourced from `results/authoring-trail.json`)
> **and it is inert until the writer carries STRUCTURED per-attempt paths** — see §3.4's dated
> block. Wiring it on prose-only `problems` would put a detector on the wire that escalates on
> attempt 2 of every ticket, and for an unattended machine a false stop costs the same as a miss.
>
> **A FOURTH STATE THE SURFACE MUST RENDER, learned the hard way:** `probe.wired:false` — the
> GET answers **200**, not 503, precisely so *"no supervisor behind the button"* cannot look like
> *"the dashboard is down"*. And an eleven-arm ladder that can observe no-answer, failed-answer
> and stale-answer **could not observe a MALFORMED answer**: a 200 carrying a body that is not a
> `SupervisorState` made `classifySupervisor` throw `Cannot read properties of undefined
> (reading 'wired')` out of `RootLayout`, blanking the whole page. Fixed by a shape-validating
> arm above it (`supervisor.ts:296 malformedReasons`, `:421`) that names every failing field.
> **The eighth field this section should have specified is "the body is not the contract".**
>
> > ### MEASURED 2026-08-10 (strip-crash round) — THAT WAS ONE ARM OF A THREE-STATE CHECK, AND THE SURFACE WAS STILL BLIND FOR A DIFFERENT REASON
> >
> > **FIVE THINGS THIS SECTION NOW HAS TO SAY, and the first two are the same lesson twice.**
> >
> > **1. A NAMED STATE, NOT A REUSED ONE.** The fix above answered *"the body is not the contract"*
> > with `unreachable`'s badge word, so *"the route did not answer"* and *"the route answered with
> > something else"* shared one word and one sentence. `SupervisorLiveness` now carries
> > **`malformed`**: amber, deliberately the SAME colour as `unreachable` (amber = *this page cannot
> > see*; red = *the loop is wedged, act on the run*) and a **different word and a different
> > sentence**. Painting it red would be the preview-card lie again. Five words, five sentences,
> > **four** colours — and a test asserts the fifth colour is absent.
> >
> > **2. THE ARM CHECK MUST GROW WITH THE STATE, OR THE STATE IS UNREACHABLE CODE.** Shipping a fifth
> > liveness under a four-probe arm would have printed *"4 distinct"* for ever while the newest state
> > was dead. The arm now pushes **five** inputs with five known answers through the real classifier
> > and requires `distinct === 5`. **The general rule this section should have carried from the start:
> > a surface's arm check has one probe per state it claims to distinguish, and adding a state without
> > adding a probe is this repository's signature defect wearing a feature's clothes.**
> >
> > **3. VALIDATION IS A PROMISE ABOUT DATA; A BOUNDARY IS A PROMISE ABOUT CODE. This section needs
> > both and specified neither.** Exhaustive validation makes *"a body that clears it cannot make any
> > consumer throw"* true, and covers none of: a field the contract grows and nobody validates, an
> > `Intl` option a future browser rejects, tomorrow's edit to the component. The strip is now wrapped
> > in the application's **first error boundary**, which wraps the strip **and nothing else** — a
> > boundary around `{children}` would swallow page-level throws the dev overlay reports, and a
> > boundary that hides a bug is worse than a blank page. **Its limit belongs in the design rather
> > than in a lane's memory: client boundaries do not catch server-render throws, so an arm check that
> > runs in a render body — a `useState` initialiser, module scope, anything not in an effect — sits
> > OUTSIDE the boundary, and a throw there is a blank page nothing can save.** Each probe therefore
> > catches and answers `threw: <message>`, which matches no expected value, so the probe fails loudly
> > instead of killing the render.
> >
> > **4. AND THE SURFACE WAS STILL BLIND, FOR A REASON NO ARM COULD SEE.** Against the OWNER'S OWN
> > BACKEND the strip read amber `MALFORMED` on every route, because the client mirror and the shipped
> > wire disagreed in **fifteen fields**. The two declarations never meet under any typechecker
> > (`dashboard/src/lib/api-types.ts` declares its own `SupervisorState` and never imports
> > `ApiSupervisorState`), and **no test could see it because `dashboard/tests/fixtures/` serves no
> > `/api/supervisor` at all** — every spec reaches `unreachable`, never `malformed`. **So the
> > instrument built to tell a working loop from a wedged one showed the same amber for both, and
> > would have done so all night.** Closed by rewriting the mirror onto the wire and pinning it with a
> > golden fixture GENERATED by running the server's own `composeSupervisorState`, asserted **from
> > both ends**: server drift reddens in `supervisor-route.test.ts`, client drift reddens in the
> > strip's unit spec. **The design rule this yields: a mirrored contract needs a fixture generated by
> > the producer, because "both sides typecheck" is not a statement about the wire.**
> >
> > **5. THE SIXTH STATE THIS SECTION STILL DOES NOT SPECIFY.** `idle` covers *"the queue finished"*
> > and *"the queue is exhausted with blocked tickets"* with one word and one sentence, and
> > `GET /api/supervisor/tickets` is a measured **404** — so a terminal ticket's reason lives only in
> > `supervisor_tickets.next_action`, `supervisor_log` and stdout. **Same defect as items 1 and 2, one
> > layer up, and it is the one the owner meets at breakfast rather than at 3am.**

### 7.7 Crash recovery, and the localhost exception costed

**Crash recovery already exists at the run level and is already unattended.** The boot sweep
requeues an interrupted run and increments the brake (`orchestrator.ts:1774-1778`,
*"nobody has to press anything"*). It has **never fired in production**:
`auto_continue_count` is `0` on all five runs. The supervisor's step 1 is the ticket-level
equivalent and is what makes the loop restart-safe.

**The localhost exception — costed, not built.** Nothing is installed:
`ls -1 ~/Library/LaunchAgents` returns four plists, none this project's. The pieces are in
place: the API binds `127.0.0.1` only, SIGINT/SIGTERM run a graceful
`orchestrator.shutdown()` that deliberately leaves the active run `running` for
`reconcileOnBoot`, and `cron-tick.ts` already assumes a launchd context. Removing the
exception is **one plist** with `RunAtLoad`, `KeepAlive`, `WorkingDirectory` and both log
paths — an hour to write and load.

**The real cost is not the plist.** `KeepAlive` restarts a crash loop as fast as it can
crash, and the only brake in the tree is `AUTO_CONTINUE_MAX = 3`, which is **per run** and
does not bound the process. It needs a `ThrottleInterval` **plus** a boot counter in
`supervisor_state` that refuses `desired='running'` after N boots in M minutes. It also
needs a decision about a machine that reboots with the Claude CLI's auth expired
(`GET /api/health` `ok:false`; cron already journals that) — the supervisor must go
`blocked` with that sentence rather than burn the queue into `failed`. And it still does not
cover a logged-out session or a sleeping laptop. **Half a day including the crash-loop
brake and one deliberate `kill -9` test.**

---

## 8. THE LEARNING CORPUS

### 8.0 REQUIREMENT ZERO — the harvest source is success-only today, and this blocks everything

```
grep -an "authoringTrail" bakeoff/src/spec-agent.ts bakeoff/src/spec-freeze.ts
→ spec-agent.ts:1613:      authoringTrail: authored.attempts,
  spec-freeze.ts:205, :370, :381
```

`freezeSuite` is reached only **after** `generateAuditedSuite` returns successfully. On the
exhaustion path the function throws, and `BakeoffError` carries three fields
(`contracts.ts:73-86`). **`attempts` is dropped on the floor.**

On disk right now (grounding agent's scan of `dashboard/acceptance/*/AUDIT.json`, consistent
with the two ticket directories I confirmed exist): two tickets, both `auditPassed`, trail
length 2 each, attempt-1 blockers trivial (a `vacuous` "not implemented" marker; credential-
shaped `SECRET_ASSIGNMENT` literals). **Zero terminal failures.** The single most valuable
failure→repair sequence this project has produced — `a913c871`'s `id → kind → id` — is in
**no harness artefact**; the post-mortem recovered it from Claude Code CLI session
transcripts, which `RUN-a913c871-observations.md:639-643` itself records as an unreliable
channel.

**A corpus built by reading `AUDIT.json` would therefore have learned nothing from the
worked example this design must beat. The first requirement is a write, not a read.**

- **(a) digest-moving, ~10 lines.** Give the authoring failure a typed carrier — widen
  `BakeoffError` with `readonly attempts?: readonly AuthoringAttempt[]`, or add
  `class SuiteAuthoringError extends BakeoffError` thrown at the exhaustion site.
  `AuthoringAttempt` already carries what is needed (`attempt`, `promptSha256`, `parsed`,
  `problems`, `findings`, `judgeRan`, `accepted`, `costUsd`, `maxOutputTokens`,
  `truncationRetried` — `spec-agent.ts:724` and neighbours).
- **(b) free.** One write inside the `finally` that already exists at
  `orchestrator.ts:3181-3197`: `dashboard/runs/<runId>/results/authoring-trail.json`, on
  **both** paths. The **run** directory, not the ticket directory — a failed run freezes no
  ticket dir at all.

**If only one thing in §8 gets done, it is (b).** Without the trail on the throw path,
every future death is as unlearnable as `a913c871` was.

### 8.1 What is harvested

| stream | source | what exists today | verdict |
|---|---|---|---|
| **A — validated manifest/suite exemplars** | `dashboard/acceptance/<t>/FROZEN.json` | 2 tickets, both `auditPassed` | **usable.** The only stream with a machine oracle |
| **B — failure→repair pairs** | `authoringTrail[]`: attempt N's blocking findings paired with N+1's accepted output | 2 pairs, both trivial; **0 terminal-failure pairs** | **thin.** §8.0 must land first |
| **C — criteria that discriminated** | `runs.db` `criteria(run_id, criterion_id, tier, result)` | `3d4d1ccb` **12 pass / 1 fail** (REQ-013 QUALITY); `052c6e02` **0/16** | **population of ONE.** `052c6e02` contributes nothing — an all-fail run says the artefact never booted, and `STATE` §3-B1 records its verdict is unreproducible |
| **D — owner overrides of `ifUnanswered`** | `results/plan.json` `state.questions[]` | `a913c871`: PQ-1 declined, PQ-3 declined, **PQ-2 answered AGAINST the default** (`ifUnanswered: "It scrolls away with the content."` vs *"it stays pinned"*) | **usable, and the override subset is the highest-value plan corpus.** n=1 |

Storage: `dashboard/data/corpus/` — `index.json` (the selected set), `entries/<bodySha256>.json`,
`watermark.json`. New `DashboardPaths` member, **fenced with `assertOutsideBakeoff`** exactly
as the other four are. The harvester runs on the terminal transition, success or failure; it
is a pure read of run artefacts and a write of the corpus directory.

### 8.2 Where it is injected

**Not the system prompt.** `AUTHORING_SYSTEM_PROMPT` is a module-level const in
`bakeoff/src/spec-agent.ts`, so baking exemplars into it costs **one image rebuild + one
recalibration + one re-score of run 1 per lesson**. A learning loop that costs a container
rebuild per lesson is not a learning loop.

**A third user turn, content supplied through `SpecAgentOptions`.** That interface has no
field that could carry exemplars today, so the plumbing is one new optional field:

```ts
/** Prompt-resident exemplars harvested from THIS installation's own runs. */
readonly exemplars?: readonly string[];
```

and the turn list becomes `[ticketTurn, exemplarTurn?, feedbackTurn?]`.

**Ordering is load-bearing: exemplars BEFORE feedback.** `a913c871` attempt 3 was told *"add
`kind`"*, added `kind`, and **threw away the `id` it had gotten right on attempt 2** — the
last thing it read was a single-field instruction and it rewrote the whole vocabulary around
it. The rejection may be the last thing read only when a complete exemplar precedes it.

**Cost: one digest move for the plumbing, free for every corpus update thereafter.**

**The bound, and the arm check.** The spec seat runs at a 64k output ceiling with an
80,102 B PDF and a 559,692 B image (746,256 base64 chars) on **every** call. So:
`CORPUS_MAX_CHARS = 6000`, `CORPUS_MAX_ENTRIES = 8`, `CORPUS_MAX_ENTRY_CHARS = 1200`;
overflow **drops the lowest-ranked and says so inside the turn**. And one log row per spec
phase, unconditionally, on both paths:

```
corpus — N of M exemplars injected (K omitted for budget), corpus <sha256[0:12]>
```

**`N = 0` on an empty corpus is a legitimate value and must be printed, not skipped.** The
corpus's failure mode is *"no exemplars injected"*, which is byte-identical to *"the corpus
is empty"* and to *"the wiring is broken"*. A silent feature here is a feature nobody can
prove ran.

**Does a varying corpus break the HELD-CONSTANT premise?** Grounding agent's measurement:
15 `authoringPromptSha256` references, and the only equality assertion is a **within-record**
self-consistency check (`spec-agent.smoke.mjs:483`), not a cross-configuration one. So
nothing breaks mechanically. But the premise is real for a bake-off, so: **the corpus is
resolved ONCE at campaign start and advances only between campaigns**, and the resolved
`corpusSha256` is recorded in the frozen record beside `authoringPromptSha256`. That field
addition is digest-moving; batch it.

### 8.3 Selection and eviction — three gates, in order

**GATE 1 — an oracle independent of the thing the exemplar will improve.** An exemplar for
the spec seat may not be selected by the spec seat. Legal oracles: `audit-accepted` (the
**machine** `deterministicAudit`, which is why it is admissible), `scored-discriminating`,
`owner-override`.

**GATE 2 — discrimination, not just success.** "It passed once" is the signature defect
wearing a corpus. A criterion exemplar qualifies only if the criterion has been observed
**both `pass` and `fail`** across scored runs. **Measured: the number of criteria ever
observed both ways is ZERO** (12/1 and 0/16). So criterion exemplars are admitted today on
the weaker oracle and stamped `status: "provisional"`, promoting to `"proven"` only with ≥5
authoring attempts on each side of the introduction date.

**GATE 3 — non-redundancy.** One slot per key; a challenger must beat the incumbent at
harvest time or be **rejected, not stored**. A corpus that stores everything and ranks later
is an accumulator.

**The eviction key is a FAILURE CLASS, not a run.** `AUDIT_KINDS` has 7 members; `other` is
too coarse for the structural findings (`criterionId === null`) that killed `a913c871`, so
sub-key on the manifest field named — the extractor already exists as `manifestFieldsNamed`
inside `remediationForFailedAuthoring` (`spec-agent.ts:~1527`). Keys look like
`other/dataExpectations[0].id`. **Eviction is newest-of-class replaces oldest-of-class**, so
the ceiling is the number of classes ever *observed*, not the number of runs.

**The measurement, installed now, not invented later.** Primary `firstAttemptAccepted` —
**baseline 0/2**, both frozen tickets needed attempt 2 and `a913c871` exhausted three.
Secondary `attemptsToAccept` — 2, 2, 3-and-died. **Confounder that must be recorded
alongside: `fieldsNamedPerRejection`** — baseline 1 before N3, and while it is 1 you cannot
distinguish *"the exemplar helped"* from *"the hint happened to name the field the model was
missing."* **N3 has landed, which is what makes the corpus measurable at all.**

**The negative control for the corpus itself, and it is free because injection is a
parameter:** withhold one class per campaign (`heldOutClass`, recorded in the corpus
manifest). If withheld classes recur at the same rate as injected ones, the corpus is doing
nothing and the counters say so. Without this arm, *"the corpus is working"* is a check that
can only observe success.

**The honest statement, and it goes on the dashboard:** with 2 frozen suites and 1
discriminating run, *"this exemplar raised the pass rate"* is **not computable and will not
be for many runs.** Install the counters, hold entries provisional, print `n=2` until it is
not.

### 8.4 Promoting real verdicts into frozen regression fixtures

**This is the counterweight to autonomous Tier 3 and it is the most important part of §8.**

`fixtures.ts:65-67` already states the governing rule: *"A fixture that grades wrong is a
grader defect, not a fixture defect. Fix the grader. Editing a fixture to make calibration
pass defeats the entire point of having one."*

**The trap: if promotion records `expected` from the verdict the grader produced, the
calibration set can never catch grader drift. It becomes a mirror.** That would be the
signature defect in the one artefact whose entire job is preventing it, under autonomous
Tier 3, which is the worst possible place for it.

> **`expected` is set by an oracle that is not the scorer.** In order of strength:
> 1. **`owner-accepted` / `owner-rejected`** — the owner's disposition of the run.
> 2. **`post-hoc-defect`** — published and later found broken. A **known false pass**, and
>    the most valuable fixture the set can acquire.
> 3. **`structural`** — checkable without the scorer: the build does not compile under
>    `tsc`, a required route 404s under `curl`, a test file contains `test.skip`.
>
> **A run whose only evidence is "the scorer said pass" is NOT promotable.** It teaches the
> grader its own opinion.

**Six qualification checks:**

- **Q1 reproducible.** Content-addressed, complete, re-scorable. *Measured disqualification:*
  `052c6e02` cannot be promoted — the re-scored tree is 2 files / 1,123,061 B different from
  the tree that was gated. **A control you cannot reproduce is not a control.**
- **Q2 discriminated.** Not all-pass, not all-fail. `3d4d1ccb` (12/1) qualifies; `052c6e02`
  (0/16) does not.
- **Q3** an independent oracle set `expected`.
- **Q4 small and self-contained.** The seven existing artefacts are hand-sized. A 40 MB
  workspace with `node_modules` is not a fixture.
- **Q5 adds a discrimination the set does not have.** Run the candidate through the existing
  gate first: same outcome, same failing tier, same failed-criteria list as an incumbent →
  **duplicate, rejected.** This inverts `correct-portfolio`'s 2026-07-29 re-implementation
  test (*"NOT ONE CRITERION RESULT MOVED"*) from a safety property into an admission
  criterion.
- **Q6** a `discriminates` paragraph, written at promotion, naming *what a grader would have
  to get wrong to grade this wrong.* No paragraph, no promotion.

**What is recorded**, beyond `CalibrationFixture`'s `{name, ticket, expected, failingTier,
discriminates}`: `provenance {runId, suiteSha256, artefactSha256, fileCount, bytes, oracle,
oracleEvidence, promotedAt}` and **`firstGradedAs {outcome, failingTier, failedCriteria}`**.

**`firstGradedAs` is what makes this an instrument rather than a mirror.** If the grader's
verdict at promotion **disagreed** with the oracle, that fixture is a recorded false pass or
false fail — the most valuable entry in the set — and **it MUST fail calibration on the day
it is added**, with calibration going green on it later being the proof the grader fix
worked. A promotion green on arrival and green forever is a fixture that can only observe
success; reject it under Q5.

**Four rules that keep the set trustworthy:**

1. **Promotion is the one thing Tier 3 may not do autonomously in the FROZEN set.** The
   repair agent may *propose* a record. Applying it writes `fixtures.ts`, which is frozen.
   Route it through a single-purpose applier whose only legal diff is **appending** a
   fixture and **adding** an artefact directory — never modifying an existing entry's
   `expected`/`failingTier`/`discriminates`, never deleting one. **Enforced by parsing the
   diff, not by asking nicely.**
2. **Monotonic `MUST_FAIL`.** `MUST_FAIL.length >= 5` is asserted today
   (`calibration.test.ts:285`); add `>= watermark.mustFailCount`, bumped only by the
   applier. The mutation that proves it: delete one `fail` fixture and watch the watermark
   check go red — distinct from M4, which proved the ≥5 clause.
3. **Every promoted fixture is watched disagreeing at least once** (Q5 + `firstGradedAs`).
4. **Evict by REDUNDANCY, never by age and never by "it always passes."** A fixture that
   always passes is the false-pass control; `correct-portfolio` is exactly that and must
   never be evicted.

**Promote on COVERAGE GAPS, not only on verdicts.** `a913c871` died before a build, so there
was **no artefact to promote** — verdict-driven promotion contributes nothing to that case.
What would have contributed generalises further: at freeze time, record which manifest
features the suite used (`dataExpectations` populated? `execution.start` non-null?
`uiFlows.length > 1`? a `build` step declared?) and diff against the feature set the seven
fixtures exercise. Each unexercised feature files a fixture request. **On run 1, 2026-07-29,
that check would have said *"no fixture exercises a populated `dataExpectations`"* — three
runs before it killed one.** This is a check that can observe *absence*, which is the whole
of what this repository keeps failing to build.

Both new fixtures are **digest-free**: `grep -c "COPY test" bakeoff/docker/scorer.Dockerfile`
→ **0**, and `portfolio-suite.ts` is dashboard-side.

### 8.5 The drift measurement — detecting the system optimising for the wrong thing

The failure mode: the corpus teaches the seat to write suites that are **easy to validate
and useless to grade**. It would look like success on every counter in §8.3 —
`firstAttemptAccepted` rises, `attemptsToAccept` falls — while `heldOutPass` quietly stops
meaning anything. **The reward-hacking shape, arriving through the door marked *learning*.**

**D1 — grade the SUITE against the seven known artefacts. Strongest, and computable from
parts that exist.** Invert the usual direction: hold the artefacts constant and vary the
suite. A freshly authored suite is good iff it reproduces the known verdicts. At minimum
two: **a suite grading `blank-page` as PASS is provably bad** (`fixtures.ts:44-48`: *"If
exactly one fixture is ever kept, keep that one"*); **a suite grading `correct-portfolio` as
FAIL is over-specified** and will burn fix rounds it cannot win. That is a **number**
separating *"the audit passed"* from *"the suite is good."*
**Blocker, stated honestly:** `gradeFixture(fixture)` builds the suite from the hardcoded
`portfolioDraft(...)` — **the suite is not a parameter today.** Making it one is
dashboard-side and free. It costs two extra `--network=none` containers per authored suite,
~20 s each by the 72.6 s / 7-fixture / concurrency-3 figure. Cheap next to an 87-minute spec
phase.
**Its limit:** all seven artefacts are portfolio-shaped and graded against
`PORTFOLIO_TICKET`. This is a **fidelity FLOOR, not a fidelity test** — it catches a vacuous
suite, not a suite merely wrong about *this* ticket. §8.4's promotion is what widens the
floor, **which is the synergy: the same growing frozen set that stops the repair agent
softening the grader is what stops the corpus softening the suite.**

**D2 — the audit's own NON-BLOCKING findings, as a rate.** Baseline measured by the
grounding agent from the two `AUDIT.json` files: `t-621a…` accepted with 5 non-blocking
findings (`trivially_satisfiable` ×1), `t-ac91…` with 8 (`trivially_satisfiable` ×2). These
are findings the judge raised and did not block on — precisely the signal that a suite is
passing while being weak.

> **THE DRIFT SIGNATURE: `firstAttemptAccepted` RISING while `trivially_satisfiable +
> tautological` per accepted suite RISES.** Either alone is misleading; together they are
> the anti-goal arriving.

Trip when both exceed their trailing-5 medians. The thresholds need N runs before they are
anything but a guess and must be labelled as such on the dashboard.

**D3 — variance collapse in the criteria pass rate.** Per scored run, `passed/total`.
Measured: 12/13 and 0/16. The alarm is not a single run's number — it is the distribution
**tightening toward 1.0 across runs while `heldOutPass` stays green.** Needs many runs; say
`n=2` until it is not.

**THE STRUCTURAL GUARD — stronger than all three, because it does not depend on a
measurement:**

> **The exemplar corpus is injected into the SPEC seat only. Accepted-suite exemplars must
> NEVER reach `AUDIT_SYSTEM_PROMPT`, and neither seat may ever read the calibration
> fixtures.**

If both seats learn from the same accepted suites, the auditor learns to accept what the
author learned to write, and the adversarial pass — the only independent check between the
seat and the frozen suite — collapses into agreement. **That is the integrity constraint
arriving through shared context rather than file permissions. No permission model catches
it; only this rule does.**

---

## 9. BUILD ORDER — cheapest first, each step independently useful and shippable

**The digest rule, measured.** `bakeoff/docker/scorer.Dockerfile:78-79` is `COPY src ./src`
then `RUN node_modules/.bin/tsc -p tsconfig.json`, and `:127` copies the resulting `dist`
into the runtime layer. The dockerignore excludes `node_modules`, `dist`, `*.tsbuildinfo`,
`.env*`, `acceptance`, `results`, `.git`, `*.log` and both READMEs — **`src` is not
excluded.** So **any** `bakeoff/src` edit, including pure prompt text and including
`*.test.ts`, moves the scorer image digest and costs **one rebuild + one Appendix-A
recalibration + one re-score of run 1**. `grep -c "COPY test" …` → **0**, so
`bakeoff/test/**` is free. Everything outside `bakeoff/src` is free.

> ### STEP 0 IS A PREREQUISITE, OWNER-ONLY, AND NOT A BUILD STEP
>
> N1, N3, N4, R1 and R3 exist only as **uncommitted modifications by a concurrent
> workflow**; HEAD has none of them (`git show HEAD:… | grep -c` → 0 for each, table at the
> top of this document). §6.2 L3 needs a *last gate-verified commit* to overlay the
> EDITABLE set onto, and the repo has **zero git tags**, so there is nothing to seed that
> pointer with.
>
> **This design does not recommend committing that tree, and must not.** Another workflow
> is editing `bakeoff/src` and `orchestrator.ts` right now; a commit taken at this moment
> captures a half-finished state of someone else's in-flight work. Whoever lands and tags
> that round is the owner or the workflow that authored it — **not the Tier-3 pipeline, and
> not this document.**
>
> **Nothing in §6 can be built until that round lands and is tagged.** Steps 1-7 below do
> not depend on it; steps 8-15 do. Carried into §10.5 as owner-only decision 0.
>
> > **FALSIFIED 2026-08-10 (later the same day). THE ROUND LANDED AND WAS TAGGED.**
> > `git rev-parse --short HEAD` → `d32ad85`; `git tag -l` → `gate-verified-2026-08-10`;
> > `git rev-parse gate-verified-2026-08-10^{commit}` → `d32ad858…` = HEAD. **Steps 8–15 are
> > unblocked by this document's own rule** and owner-only decision 0 is discharged.
> > **The gotcha, because it will otherwise read as a moved tag:** it is an ANNOTATED tag
> > (object `50a99fdf…`), so resolve it with `^{commit}` — `git rev-parse
> > gate-verified-2026-08-10` alone returns the tag object, not the commit.

| # | step | why here | digest? |
|---|---|---|---|
| **1** | **Fix `calibration-4a.mjs`'s journaling** — history file, superseded copy, `index.jsonl` line, per `probes/README.md`. ~10 lines. Until this lands, the gate's most important measurement can be re-run until green with no trace. | the gate is worthless if its record is | **free** |
| **2** | **Write `authoring-trail.json` on both paths**, in the `finally` at `orchestrator.ts:3181-3197`. | §8.0(b). Without it every future death is unlearnable. Highest value per line in the document. | **free** |
| **3** | **Fixture G — populated `dataExpectations`, with its restored-INSERT control.** Plus the `http` sibling. | §2.3 point 2, §6.4-G. The gate's negative arm is vacuous in exactly the area the first repair touches. **Precondition for arming Tier 3.** | **free** (artefact dashboard-side, e2e in `bakeoff/test/`) |
| **4** | **Known-bad E — the exfiltration control.** ~15 lines on Appendix A's `rescore.mjs`. | the only control covering suite integrity | **free** |
| **5** | **Freeze and extend the `collectManifestProblems` corpus** in `scorer-protocol.test.ts` — all seven fields plus the two cross-field rules, each rejected *naming its field*, plus the valid-manifest accept arm. | §6.4-F. The first patch the system attempts is here, and collect-all is one keystroke from collect-nothing | **YES** — `bakeoff/src/*.test.ts` is under `COPY src` |
| **6** | **The defect record + the terminal-transition write.** §5.1, minus the `authoringTrail`/`detail` fields that need step 8. | Tier 2's input. Useful alone: it turns a nine-hour post-mortem into a row | **free** |
| **7** | **The supervisor: tables, loop, `submitRun`, `GET /api/supervisor`, the strip, start/stop.** §7. | this is the owner's start/stop button and the never-park policy. Useful with **no** repair pipeline at all — it re-runs, waits, drains and reports | **free** |
| **8** | **The digest-moving batch, paid once.** (a) `DefectDetail` on `BakeoffError`/`AuditFinding`/`PhaseFailureSignals` (§3.2); (b) `attempts` on the thrown authoring error (§8.0a); (c) `SpecAgentOptions.exemplars` + `exemplarTurn` + turn ordering (§8.2); (d) `corpusSha256` in the frozen record; (e) the truncation rung per-attempt + an event when it fires (§4.2); (f) the turn-cap rung (B7). ~150 lines total. | one rebuild, one recalibration, one re-score of run 1 for all six | **YES — batch or pay six times** |
| **9** | **The taxonomy and the fingerprint rule.** §3.3, §3.4, with the two-armed comparator fixture (escalate on `a913c871`'s three real manifests; do **not** escalate on a shrinking sequence). | needs step 8's `DefectDetail`. **Per-class N shipped without the fingerprint is strictly worse than today** | **free** (dashboard-side classifier) |
| **10** | **Tier 2: the repair agent + the evidence bar.** §5.2, §5.3. Both the agent and its verifier need Bash. | needs 6 and 9 | **free** |
| **11** | **`gradeFixture` takes a suite parameter (D1).** §8.5. | the only instrument that can see a criterion-generation change; also the corpus's anti-goal detector | **free** |
| **12** | **The corpus: harvest, select, evict, resolve, the `N of M` arm row.** §8.1-8.3. | needs 2 and 8(c) | **free** |
| **13** | **The Tier 3 gate: `tools/tier3/gate.mjs`, the frozen manifest, the isolated build root, the apply token, the arm checks, the trail.** §6. | **last, and only after 3, 4 and 5.** The gate's value is entirely in its failing arm | **free** (the script is new; the rebuilds it runs are the cost) |
| **14** | **`PromotedFixture` + the append-only applier + `watermark.json` + the coverage-gap check.** §8.4. | the backward loop. Independent of 13 and useful without it | **free** |
| **15** | **The launchd plist + the process-level crash-loop brake.** §7.7. | removes the last owner touch. Half a day | **free** |

**Steps 1–7 ship a system that never parks, re-runs itself, drains on STOP and reports in
one sentence — with no repair pipeline and no self-application at all.** That is the
cheapest useful stopping point and it is a real one.

> ### STATUS 2026-08-10 — THE ORDER WAS NOT FOLLOWED, AND ONE STEP WAS BUILT BEFORE ITS PRECONDITIONS
>
> Five lanes ran in parallel rather than in this order. Per-step, measured:
>
> | # | status 2026-08-10 |
> |---|---|
> | 1 | **NOT DONE.** `calibration-4a.mjs`'s journaling is untouched. The gate's own trail (§6.7) got the mechanism instead, so *"re-run until green"* is still frictionless in `calibration-4a.mjs` specifically. |
> | 2 | **LANDED.** `results/authoring-trail.json` on BOTH paths, in the existing `finally`. On the failure path it can only report `attemptsAvailable:false` with an `UNAVAILABLE:` sentence — which is the honest answer and is asserted, so the day §8.0a lands the test goes red deliberately and somebody has to look. **Never written for real** (no file exists under `dashboard/runs`). |
> | 3 | **LANDED for the sqlite kind, UNARMED for `http` and end-to-end.** §6.4's dated block. |
> | 4 | **LANDED as a host-import arm** (`kb-exfil-byte-identical-copy`), not on `rescore.mjs`. |
> | 5 | **NOT DONE.** The corpus was not frozen or extended in `scorer-protocol.test.ts`. What exists instead is `tools/replay/` — a free, zero-quota, ~150 ms regression corpus over `a913c871`'s three real manifests **plus two must-accept cases**, one of which reads `MANIFEST_DATA_EXPECTATION_EXAMPLES` out of the BUILT spec-agent and parses it with the real validator, so a prompt that documents a shape the validator rejects goes red the same second. That is the standing guard this step wanted, outside the digest. |
> | 6 | **LANDED, never fired.** §5.1's dated block. |
> | 7 | **LANDED, including the wiring the step list implies and the lane could not reach**: `index.ts:86-112` constructs the loop, `:159` arms and starts it, a 30 s `setInterval(...).unref()` cleared in shutdown, `onRunSettled` wired through a late-bound holder. **Plus one route the design never specified and without which the whole thing is inert: `POST /api/supervisor/tickets`** (`http.ts:1277`) — `enqueueSupervisorTicket` previously had callers only in two test files, so the queue could never be non-empty and START answered its own message. `submitRun` was NOT extracted; `createSupervisorSubmit` (`supervisor-boot.ts`) is a second implementation, and it has **never executed against a real `RunStore`/`Orchestrator`**. |
> | 8 | **NOT DONE.** The whole digest-moving batch is unpaid, which is why (a) `violations` is `null`, (b) `attempts` is not on the thrown error, (c)–(f) untouched. **This is the single unpaid step most other gaps trace back to.** |
> | 9 | **PARTIAL.** The comparator is built and mutation-proved (§3.4) and **BLIND on the production record shape**, because it needs step 8(a). |
> | 10 | **PARTIAL.** The evidence bar and the prover are built and proved (§5.3); the patch AUTHOR is not, and nothing calls the cycle. |
> | 11–12 | **NOT DONE.** `gradeFixture`'s suite parameter and the corpus harvest/select/evict were not started. |
> | 13 | **BUILT, OUT OF ORDER, AND ITS PRECONDITIONS ARE ONLY HALF MET.** This step says *"last, and only after 3, 4 and 5"*; 5 was never done and 3 is armed for one of its two kinds. The consequence is exactly what the step warns about — **the gate's value is entirely in its failing arm, and its failing arm is entirely host-import** (17 arms held, 0 container arms executed). |
> | 14–15 | **NOT DONE.** No `PromotedFixture`, no launchd plist, no crash-loop brake. |
>
> **What steps 1–7 were supposed to buy — "a system that never parks, re-runs itself, drains
> on STOP and reports in one sentence" — is now MOSTLY TRUE and NOT YET PROVEN.** The never-park
> guard is enforced at the submission boundary (`assertNeverParks`, both parks made unreachable
> rather than defaulted), STOP drains and cancels nothing, the loop survives `kill -9`. What has
> never happened is one real supervisor-submitted run reaching a verdict. See
> `STATE-2026-08-09-where-we-are.md` §7 for the operator's page and the complete stop list.

---

## 10. WHAT THIS DESIGN DOES NOT SOLVE

### 10.1 The gate cannot see a prompt or criterion-generation edit

Stated in §6.5 as construction, not oversight. S3–S8 grade frozen artefacts against frozen
suites; the spec seat never runs. `spec-validate.ts` — the bad-test audit itself — is
EDITABLE, and softening it moves no `heldOutPass` on a frozen artefact. **The only
instrument is 4B, it is noisy on correctness (7/7, 5/7, 5/7 across three committed runs),
and it is the most expensive step in the loop.** Batched, there is a window in which
authoring-closure patches self-apply unproxied.

### 10.2 Three residuals even with 4B

- **Ticket-shaped overfitting.** 4B has one ticket. A prompt edit that makes authoring
  easier for the portfolio ticket specifically is invisible.
- **Every ticket class no fixture represents** — which today is **every SERVER-mode ticket**,
  because all eight artefacts are portfolio-shaped. `a913c871`'s own ticket class has no
  fixture at all, even after step 3.
- **Slow drift in judge/adversary behaviour.** No committed baseline tracks it.

### 10.3 The residual risk the owner is knowingly accepting on Tier 3

Named plainly, because the owner has decided and should hold the accurate version:

1. **Frozen is tamper-EVIDENT, not tamper-PROOF.** The repair agent runs as the owner's UID
   on a single-user host and the builder is a host subprocess. The only real prevention is
   the harness-level write allowlist (L1), and **that allowlist has never been measured** —
   no repair agent exists yet, so `probe-g-tool-surface.mjs`'s cousin for this surface has
   never run. Everything else in §6.2 is detection after the fact.
2. **Every Tier-1 mechanism in the taxonomy is unexercised in production.** The 64k→128k
   rung never fired. `auto_continue_count = 0` on all five runs, so the interrupted
   auto-requeue has never fired. `rate_limited` has never been observed. `transient` is
   structurally unreachable on the CLI subprocess path. **A taxonomy built on these is a
   taxonomy of fixtures.**
3. **Every `bakeoff/src` patch moves the scorer digest and therefore invalidates the
   calibration and the run-1 baseline until they are re-run.** The supervisor's
   `done-under-changed-grader` state *records* this; it does not resolve it. Whether the
   supervisor may run the rebuild and recalibration itself is §10.5.
4. **Rollback is image-only as the brief specifies it.** Zero git tags; restoring
   `bakeoff-scorer:pre-<change>` while `bakeoff/src` stays rolled forward produces a scorer
   image that does not match its source. Mitigated by recording the source sha (§6.3 S2) and
   re-verifying (S11), both of which are proposals nobody has executed.
5. **The evidence base is five runs, 1,816 events and one `passed`.** Two sources are
   unusable and are named so nobody builds on them: `run_attempts` holds rows for one run
   out of five and recorded `end_class = completed` on the attempt that killed `a913c871`;
   `seat_spend` and `metered_spend` are empty across all five runs, so **cost-per-failure-class
   cannot be computed** and a budget policy that cannot see spend is a policy nobody can tune.
6. **Raising `AUTO_CONTINUE_MAX` would weaken a documented crash-loop brake.** This design
   keeps it at 3 for that reason (§3.5). If per-class headroom proves too tight in practice,
   raising it is the owner's call, not the system's.

### 10.4 Two known holes this design creates rather than closes

- **The supervisor's `#finish` hook runs inside the terminal-transition path**, which already
  does a lot (`closeAttempt`, `announceAttemptHistory`, `writeVerdict`, `publishProject`). A
  throw there would corrupt the run's own finish. It must be wrapped and must never re-enter
  the orchestrator synchronously.
- **Two queues that can both start runs** — `supervisor_tickets` and the existing file-based
  cron queue — is a smaller version of the two-`Orchestrator` hazard. Either cron seeds the
  supervisor, or the supervisor treats cron submissions as foreign runs it does not own.
  Unsettled (§10.5).

### 10.5 The genuinely owner-only decisions — short, and none of them is a bug report

0. **Landing and tagging the in-flight round.** §9's step-0 note. N1/N3/N4/R1/R3 are
   uncommitted work by a concurrent workflow, there are zero git tags, and §6.2 L3's
   frozen-overlay pointer has nothing to seed it with. **The Tier-3 pipeline cannot create
   its own first gate-verified commit** — that would be the system deciding what its own
   baseline is, which is the integrity constraint in its purest form. Steps 1-7 do not
   wait on this; §6 cannot start without it.
1. **Spend authorisation** (`budget_exceeded`), **credentials** (`missing_credential`, and
   never through the chat), and **anything publishing personal data**. §3.6.
2. **Any patch whose minimal diff reaches the FROZEN closure** — detected from the diff, not
   from the class. The standing example: `spec-freeze.ts` and `scorer-protocol.ts` are frozen,
   so a *future* widening of the manifest parser is owner-approved even though N3's
   already-landed collect-all was not.
3. **Whether `done-under-changed-grader` closes a ticket or blocks it.** Closing it accepts a
   pass that cannot be compared to the failure it replaces; blocking it means every
   `bakeoff/src` repair needs an owner glance, which partly defeats Tier 3.
4. **Whether the supervisor may run the rebuild and recalibration itself** after a
   digest-moving self-patch, or must queue them for the owner.
5. **The 4B batching budget and the all-green re-arm K.** Placeholders here (K = 10; 4B
   unconditionally on `spec-validate.ts`, otherwise every 5th patch or 24 h) are policy
   numbers, not measurements.
6. **Whether ABORT NOW exists on the dashboard at all**, given that its only effect is to
   convert a resumable run into an unresumable one. The argument for it is a runaway build;
   there is no measured instance of one on this machine.

> ### ADDED 2026-08-10 — FOUR NEW OWNER-ONLY DECISIONS, AND ONE DISCHARGED
>
> **Decision 0 is DISCHARGED** — the round landed and `gate-verified-2026-08-10` exists (§9).
> **Decision 6 is now half-answered by construction:** `POST /api/supervisor/abort-now` exists
> and answers **501 `abort_not_wired`** (`http.ts:1520`), plus 400 `confirm_required` without
> `{"confirm":true}`; the strip has START and STOP (drain) only. It refuses honestly rather than
> cancelling a run and leaving its ticket `queued`, which would let the next START re-spend on
> the run the owner just killed. Four new ones:
>
> 7. **§3.4 vs `RESEARCH` R5 on a shrinking violation set** — continue (§3.4, implemented) or
>    escalate (R5). A strict shrink is a subset, so R5's rule makes the comparator escalate on
>    every sequence and makes §3.4's own mandatory negative control unbuildable. Someone has to
>    pick, or the comparator is "always escalate" with extra steps.
> 8. **§6.7's trail location.** The implementation deliberately writes outside the location this
>    document specifies, because §6.7's path is inside FROZEN-DATA and the gate would invalidate
>    its own integrity check every cycle. Ratify the implemented location, or move the boundary —
>    and say where a gitignored append-only audit trail is backed up.
> 9. **Who mints an out-of-loop approval token while the owner is asleep.** `RESEARCH` §5 item 4,
>    still open and now load-bearing: every trail record carries `humanReviewed: null`, and every
>    inside-closure patch parks as SELF-PROPOSE. There is no path from "the machine found a real
>    repair to a frozen file at 3am" to "it is applied by breakfast", and there should not be one
>    until this is answered.
> 10. **Whether a repair driver may run at all before the container known-bad arms exist.**
>     Today nothing calls `tools/repair` or `tools/tier3`
>     (`grep -rn 'tools/repair\|tools/tier3\|tools/replay' dashboard/server/src dashboard/src
>     bakeoff/src | wc -l` → **0**). Wiring one turns the gate's host-import-only negative arm
>     into the thing standing between an agent and the editable package.
