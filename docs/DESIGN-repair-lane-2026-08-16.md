# DESIGN — THE REPAIR LANE

Written 2026-08-16. **Every claim about the current tree carries the command or `file:line`
that produced it in this session. Everything else is marked PROPOSED.**

This supersedes nothing. `DESIGN-self-maintaining-pipeline.md` is still the Tier 1/2/3
design; this file is the lane that consumes it, and it CORRECTS three of that document's
own corrections — see §7.

---

## 1. THE ASK

The owner, across four messages on 2026-08-16, verbatim in substance:

> *"Can we not make it so that it reasons on its own and uses its own judgment to pass the
> failed tests?"*
>
> *"On Canvas, have an entirely separate node which focuses purely on the repairs. Should the
> orchestrator flow fail at any point, by any of the agents or the planning or whatever, that
> repair node sends out repair agents from its own repair orchestrator. Its sole purpose is to
> improve the main orchestrator, find out what went wrong, and repair it. It would be nice if
> it sent an email to me on what went wrong and what it's done to fix it, as a summary with
> natural human language that's easy to understand."*
>
> *"The repair flow's main and only focus is to repair the main orchestrator flow when
> something breaks. As I am going for it self maintaining when I'm not there. The repair
> workflow should not be as restricted as the main one and the model it is running should use
> its judgment more without it actually causing any regressions in the process. It should
> function a little bit like the /goal skill."*
>
> *"The idea is that the websites get one shot and they pass, not fail."*
>
> *"The only purpose of the new workflow node is to only fire when there is a regression or
> error or capability or otherwise something that stops the main one from finishing the task
> causing false finishes. Its job is not to handle the main task. That is always done by the
> main workflow."*
>
> *"The repairs it does should also persist between runs, as eventually the goal is that it
> won't need to fire at all. I would also suggest that the repair node uses /codex:review and
> other codex skills, to get a fresh pair of eyes on the problem. This should be used from my
> codex limit like the claude one is using from its own."*

### 1.1 The one clause that had to be refused, and what replaced it

*"Use its own judgment to pass the failed tests"* — taken literally, this is the model
grading itself, which deletes `falseFinish` as a measurement and with it the only thing this
repo has that the demos it was built to refute do not have. `supervisor.ts:1367` already
names the trap in code: *"whose cheapest repair is re-freezing — which is grader-softening
wearing the word autonomy."*

**Replaced with ablation.** A red test may be overturned, never by an opinion, only by two
runs:

```
1. change the TEST, touch nothing in the artefact → it goes green  ⇒ the test was broken
2. run the fixed test against a stub that BOOTS AND SERVES but
   violates that specific criterion                → it stays red  ⇒ it still tests something
```

Control 2 is stated in that shape deliberately. A stub that 404s everything fails the fixed
test for the wrong reason (nothing listening) and the control passes vacuously — which is
this repo's own signature defect, [[probe-needs-negative-control]], one level up. **OPEN:
whether `bakeoff`'s seven calibration fixtures (STATUS.md §1.4) contain per-criterion
violating stubs, or whether the adjudicator must author them. If it authors them, a model is
back in the loop and that needs its own argument.**

### 1.2 What "one shot and they pass" actually costs — measured, not estimated

Re-derived this session from the `criteria` table and `FROZEN.json`. `6ec44b2f` has its own
freeze; `e1c15359` and `047f9872` share a second one (`suite_sha256` 2e5a43a9…).

| run | grader-defect failures | real defects | perfect grader → |
|---|---|---|---|
| `047f9872` | 4 — `APP_DIR` | 0 | **25/25 PASS** |
| `e1c15359` | 4 — `APP_DIR` | 1 — REQ-022 background luminance / uppercase nav | 24/25 fail |
| `6ec44b2f` | 4 — WAL byte-grep | 1 — REQ-020 image aspect ratio 1.2–1.8% vs 1% tol | 24/25 fail |

**A perfect grader buys one-shot pass on one run in three, not three in three.** Both
surviving defects are visual/geometric; there were zero logic defects across all three runs.
`e1c15359` and `047f9872` are the same ticket, same frozen suite, same builder, differing
only in the design lane — A generated its own art and failed REQ-022, B reused
`6ec44b2f`'s and passed it. So that defect is design-lane nondeterminism, not a capability
gap.

Consequence for planning: the repair lane addresses the grader column. **The real-defect
column needs the builder to measure its own rendered output before declaring done, which is a
separate increment and is NOT in this design.** Recorded so it is not discovered in phase 3.

---

## 2. `/goal`, MEASURED

`/goal` is not a user skill on this machine (`~/.claude/skills` has no `goal`; the only
filesystem hit is an unrelated memory file in another project). It is a **built-in Claude Code
command**, extracted from the 2.1.233 binary at offset 280759338:

```
name: "goal"
description: "Set a goal Claude checks before stopping"
description: "Set a goal — keep working until the condition is met"
argumentHint: "[<condition> | clear]"
isHidden: () => !xn()          // feature-gated, which is why it is absent from the skill list
```

So the semantics the owner is pointing at are: **a stop condition, re-checked before every
stop, that keeps the agent working until it is met.**

### 2.1 The one adaptation, and why it is not optional

`/goal` lets the MODEL evaluate its own condition. The repair lane may not. A model that
decides it has finished repairing itself is the same self-report this repo removes from the
build lane, reintroduced one level up where nothing is watching.

> **Judgment is free in HOW it diagnoses and WHAT it tries.
> The stop condition is a command that exits 0.**

The repair lane's goal predicate, in full:

```
defect <sig> no longer reproduces          reproduction command exits 0 where it exited 1
  AND the patch is the reason              revert it → the reproduction exits 1 again
  AND nothing else moved                   bakeoff + server + tier3 + repair suites all green
```

Third conjunct is new in this design and is the whole of *"without causing any regressions"*.

---

## 3. THE ASYMMETRY — LOOSE IN DIAGNOSIS, STRICT AT THE BOUNDARY

This is the owner's *"should not be as restricted as the main one"*, made specific. The build
lane and the repair lane are restricted for different reasons and must not inherit each
other's rules.

| | build lane | repair lane |
|---|---|---|
| why it is restricted | it is being MEASURED; a builder that reads the held-out suite makes the number meaningless | it is not being measured. There is no held-out suite for "fix the orchestrator" |
| held-out sealing | four layers (STATUS.md §0.1) | **none. There is nothing to seal** |
| seat turn cap | `DASHBOARD_SEAT_MAX_TURNS`, default 8 | **none — a goal loop with a budget, not a turn count** |
| tool surface | narrowed; MCP removed outright | **the whole repo, any command, any test** |
| may iterate on failure | gate/fix loop, capped | **yes, that is the entire design** |
| what stops it being dangerous | the sandbox | **the APPLY gate, and only the APPLY gate** |

Every restriction removed from the left column is a restriction the right column never needed.
Nothing is removed from the gate.

---

## 3A. THE FIRING BOUNDARY — WHAT WAKES THE LANE, AND WHAT MUST NOT

The owner's scoping clause, made enforceable: **the repair lane fires only on something that
stopped the MAIN workflow from finishing.** It never performs the main task.

| event | who owns it |
|---|---|
| a phase threw · a seat timed out · a park with no exit · a harness crash | **repair lane** |
| a gate failure caused by a GRADER or HARNESS defect (`APP_DIR`, the WAL grep) | **repair lane** |
| a gate failure caused by the ARTEFACT (REQ-020's image ratios, REQ-022's luminance) | **main workflow** — its fix loop, its re-queue |
| an earned `DID NOT PASS` | **main workflow, and it SUCCEEDED.** The lane stays asleep |

**This makes adjudication the ROUTER, not an optional extra.** Gate goes red → is any failure
attributable to the pipeline or to the artefact? That question decides whether the lane wakes
at all, so it cannot be deferred to a later increment than the trigger itself.

**RESOLVES OPEN ITEM 2 of the first draft.** *"An earned `DID NOT PASS` routes to `repairing`"*
was recorded as needing owner arbitration. It is arbitrated: that routing is wrong, and the
unknown-class arm at `supervisor.ts:1409` must not be what a gate failure lands on.

### 3A.1 The hard boundary, which must be a path denial and not a guideline

**The repair lane may never write inside `dashboard/runs/<id>/workspace`.** A repair agent that
"fixes" the artefact is performing the main task, and worse, it is editing the very thing under
measurement — every number that run produced becomes meaningless, with no tripwire. The APPLY
gate's protected-path check must deny that tree exactly as the builder's permission layer
denies the sealed suite. PROPOSED; the existing `protectedPathViolations` machinery is the
place it goes.

Its writable scope is the PIPELINE: `bakeoff/src`, `dashboard/server/src`, `dashboard/src`,
`tools/`, and the suite-authoring prompts. Nothing else.

---

## 3B. PERSISTENCE — THE LANE'S SUCCESS CONDITION IS ITS OWN SILENCE

> *"Eventually the goal is that it won't need to fire at all."*

That is a real engineering requirement, and it fails quietly if repairs live only in a working
tree. Three things must outlive the run:

1. **The patch is COMMITTED, not just applied.** An APPLY that mutates files without a commit
   is undone by the next `git checkout`, and the same defect fires again next week having
   taught the system nothing. The gate already writes a rollback point; the commit is what
   makes the fix durable. **VERIFY before building: does `tools/tier3/gate.mjs`'s APPLY commit,
   or only write?**
2. **The defect ledger persists and is consulted BEFORE diagnosis.** A defect whose signature
   has been seen and fixed must be recognised, not re-diagnosed from scratch — and one that
   RECURS after a fix is a different and more serious event than a first occurrence, because it
   means the previous patch was wrong. `supervisor_log` and the per-signature cycle bound are
   the existing hooks.
3. **A regression test ships WITH every patch.** This is what actually drives the firing rate
   to zero. The repair cycle already demands a red reproduction that goes green; that
   reproduction, kept, is the test that stops the defect returning. A patch with no retained
   test is a fix that expires.

**The measurable goal, therefore: repair-lane firings per run, trending to zero.** If that
number is flat, the lane is treating symptoms.

---

## 3C. CODEX AS THE SECOND PAIR OF EYES

> *"Use /codex:review and other codex skills… from my codex limit like the claude one is using
> from its own."*

**Available, measured 2026-08-16:** `/api/health` → `codexAuth: "ok"`; `codex-cli 0.146.1` on
PATH; `@openai/codex-sdk@0.145.0` already a dependency of `dashboard/server`;
`src/builders/codex-builder.ts` still in the tree; codex plugin 1.0.6 installed.

### 3C.1 Why Codex is disqualified from the build lane and QUALIFIED for this one

STATUS.md §0.1, last row, on the held-out boundary under Codex: **"NONE. `ThreadOptions`
exposes no read restriction… A Codex build can `cat` the held-out suite."** That is why
`GET /api/models` serves Anthropic rows only and `POST /api/runs` refuses a Codex builder.

**The repair lane has no held-out suite.** §3 already establishes there is nothing to seal when
the target is the orchestrator itself. The single reason for the exclusion does not obtain
here, so the exclusion does not carry over — and what remains is the reason to WANT it: a model
with different training and different blind spots, reviewing a diagnosis a Claude seat
produced. Redundant reviewers catch less than diverse ones.

**Quota separation is automatic and already enforced.** The dashboard strips `OPENAI_API_KEY`,
`CODEX_API_KEY` and nine relatives from every subprocess it spawns, so the Codex CLI
authenticates against the owner's own subscription exactly as the Claude CLI does. Neither
lane can silently become a billed API client.

### 3C.2 Where it sits in the loop — advisory, never authoritative

Codex reviews; it does not decide. **A `/codex:review` verdict is not a gate arm**, because a
second model approving a patch is still two models approving themselves, and `heldOutPass` was
never allowed to rest on that. It feeds the diagnosis, and the ablation still decides.

**SUPERSEDED 2026-08-16 by §10.5 — Codex moves to BOTH ends of the loop, not just the back.**
The table below is kept because the back half of it is unchanged and still correct.

| step | who |
|---|---|
| triage, hypothesis, patch | Claude seat (subscription) |
| **adversarial second read of the diagnosis and the patch** | **Codex** (`/codex:review`, `/codex:adversarial-review`) |
| stuck — two attempts on one signature with no red reproduction | **Codex** (`codex-rescue`) as an independent attempt |
| reproduce · prove · ablate · regress · APPLY | **the runner. No model.** |

---

## 4. WHAT EXISTS, MEASURED THIS SESSION

| piece | state | evidence |
|---|---|---|
| reproduce → patch → prove → ablate cycle | **exists** | `tools/repair/cycle.mjs#runRepairCycle`, called at `tools/repair/supervisor-cycle.mjs:735` |
| patch author seat | **exists, wired at boot** | `repair-author.ts`; `index.ts:177-188` constructs it |
| APPLY gate + rollback point | **exists** | `tools/tier3/gate.mjs` |
| `UNARMED is not PASS` | **shipped** | `tools/tier3/gate.mjs:274-350` |
| supervisor retry budgets, per-class | **exists** | `supervisor.ts:1395-1465`, `recovery.ts` owns the table |
| supervisor loop wired + armed | **exists, never used** | `GET /api/supervisor` → `wired:true armed:true`; `supervisor_tickets` **0 rows**, `supervisor_log` **1 row** |
| defect record | **exists, cannot reproduce** | `defect-record.ts:474-518` — *"THIS RUN'S MANIFEST IS NOT IN THE COPY"* |
| fires on ANY orchestrator failure | **MISSING** | `recovery_class` written only at `orchestrator.ts:2082`, on a phase THROW. All 6 gate-failed runs carry NULL |
| its own orchestrator / fan-out | **MISSING** | one cycle, one author, serial |
| canvas repair node | **MISSING** | `NODE_TYPES` = `agent, group, column, stage, preview` (`orchestration-canvas.tsx:137`) |
| email | **MISSING ENTIRELY** | zero mailers, notifiers or webhooks in `bakeoff/src`, `dashboard/server/src`, `dashboard/src`, `tools` |

**So the machinery is real and the orchestration around it is not.** That is the good case.

### 4.1 The trigger gap, stated exactly

A gate failure is not a throw, so `classifyPhaseFailure` never runs and `recovery_class`
stays NULL. `boundFor(null)` returns `undefined`, so `supervisor.ts#settle` takes the
unknown-class arm and routes the ticket to `repairing`. Two consequences:

1. The single most common outcome in the archive — 6 of 16 runs, *"the frozen held-out suite
   did not go green in the sealed container"* — produces **no defect record at all**.
2. When it does route, it routes an EARNED `DID NOT PASS` to *"repair the harness"*, which is
   the wrong lane for a build that genuinely failed.

Both are unexecuted, because no supervisor ticket has ever existed.

---

## 5. THE ARCHITECTURE

```
MAIN ORCHESTRATOR                             REPAIR LANE  (own node, own budget, own loop)
plan → spec → audit → freeze → build
   → gate ⇄ fix → judge → verdict
        │
        │  any throw · any red gate · any park · any timeout
        ▼
   defect record ────────────────────────▶  GOAL SET: "<sig> no longer reproduces
   (structured, with a RUNNABLE repro)         ∧ ablation holds ∧ 4 suites green"
                                                      │
                                              ┌───────┴────────┐   loop until goal or bound
                                              │  triage        │   ← judgment, unrestricted
                                              │  reproduce     │   ← must go RED first
                                              │  patch         │
                                              │  prove         │   ← RED → GREEN
                                              │  ablate        │   ← revert → RED again
                                              │  regress       │   ← all four suites
                                              └───────┬────────┘
                                                      ▼
                                              APPLY gate → rollback point → re-queue ticket
                                                      │
                                                      ▼
                                              plain-English report
                                              → file ALWAYS · → SMTP when configured
```

### 5.1 Decisions already taken by the owner

- **Apply unattended, then report.** Chosen 2026-08-16 over "email first, apply on reply" and
  "apply to a branch". Matches *"does not wait for me to put out a fix"*.
- **Mail.** The owner asked whether the Gmail MCP could be used. It cannot: that server is
  authenticated interactively to a chat session and is absent from headless runs — the
  Workflow tool's own documentation says so. A capability that only exists while a human is in
  the chat is not a capability the unattended lane has ([[capability-belongs-in-the-system]]).
  **Resolution: always write the report to disk; additionally send over SMTP when
  `REPAIR_SMTP_URL` is set.** Scaffolded empty; filled via `~/.claude/scripts/set-secret.sh`,
  never through the chat. Mail failure must never kill a repair.

---

## 6. THE INCREMENTS

| # | increment | why it is in this position | status |
|---|---|---|---|
| 1 | **structured per-test failure records** | triage's entire input. Today the reason a test failed exists only inside a human-readable transcript in one string field | **PURE LOGIC DONE + MUTATION-VERIFIED.** Image rebuild and archived re-score outstanding |
| 2 | **defect record on every failure path** | *"fails at any point"* is false until gate-red produces a record and `recovery_class` is populated. Includes the manifest producer at the throw site | not started |
| 3 | **repair orchestrator** — goal loop, own budget, fan-out | the node's brain | not started |
| 4 | **canvas repair node** | the node's face | not started |
| 5 | **plain-English report → file, then SMTP** | the thing the owner reads | not started |

### 6.1 Increment 1, as built

- `bakeoff/docker/node-test-reporter.mjs` — emits `failure{name,message,stack,operator,code,
  expected,actual,cause}` on `test:fail`, every string capped at source, defensive against
  circular/throwing `expected`/`actual`, and against a thrown non-Error.
- `bakeoff/src/scorer-protocol.ts` — `TestFailure`, `SuiteRunnerName`,
  `MAX_PERSISTED_FAILURES = 60`, `SuiteExecutionRaw.failures`, and `parseTestFailures`, which
  **tolerates the key's absence** (every archived record predates it) and is **loud on a
  malformed entry** (only our own writer emits it).
- `ParsedSpec.failure` on both parsers; Playwright reads the FIRST non-passing result's error
  (under retries the last is the one that gave up, the first shows the original cause).
- Six `SuiteExecutionRaw` construction sites, found by making the field REQUIRED rather than
  optional-with-a-default. Five write `[]` and every one of them also writes a non-null
  `reportProblem`; that pairing is what separates "nothing failed" from "nothing ran".
- **`readParsedFailure`, `criterionToken` and `collectFailures` were LIFTED into
  `scorer-protocol.ts`.** They were written inside `scorer-container.ts`, which exports nothing
  and throws on import outside the sealed container — so they were unreachable by any test.
  Code the repair lane reasons from cannot be code no test can reach; that is this repo's §6
  defect pointed at the thing doing the observing.
- **Two attribution rules exist in that file and they are deliberately different.**
  `criterionToken` matches the whole title path, filename included (scoring — generous is safe,
  a false positive fails the run). `criterionNamedInTestTitle` strips the file segment first
  (QUALITY excusal — generous is a gate that stops gating). `collectFailures` uses the SCORING
  rule so a `TestFailure`'s `criterionIds` can never disagree with `criterionCoverage` about the
  same event. Documented at the declaration so it is not "tidied" into one.
- 8 new tests, **each mutated and each caught by its own test**, run mechanically rather than
  claimed: drop the failure object · collect passing specs · drop untagged failures · remove the
  token boundaries · skip reasonless failures · raise the cap · keep non-string reporter fields ·
  tolerate a malformed key. All RED, baseline and restore GREEN. `bakeoff` **242/242**.
- REMAINING: rebuild the scorer image, re-resolve its digest, and re-score the archived
  `047f9872` artefact to prove `Missing script: "start"` arrives as a FIELD end to end.

### 6.2 The held-out constraint on increment 1

`TestFailure` strings can quote held-out assertion text verbatim. They are written **only**
under `results/scorer-out`, which the builder's permission layer denies as a sealed root
(STATUS.md §0.1). **Copying a `TestFailure` anywhere a build can read is a held-out leak with
no tripwire.** Noted at the type. Separately observed and NOT addressed here: `runs.db`'s
`criteria.detail` column already stores held-out test TITLES outside the sealed store.

---

## 7. THREE CORRECTIONS TO `DESIGN-self-maintaining-pipeline.md`

That file's *"CORRECTED 2026-08-10 (REPAIR-DRIVER ROUND)"* block is stale in three places.
Re-measured 2026-08-16 against HEAD `ea80328`:

1. *"`cycle.mjs#runRepairCycle` is invoked by nothing"* — **false.**
   `tools/repair/supervisor-cycle.mjs:735` invokes it.
2. *"the running system has none of this"* — **false.** `dist/index.js` was rebuilt
   2026-08-16 14:47 with 0 `.ts` sources newer, and the live server is running it.
3. *"§6.6 — the fail-closed claim is false for A6/A7 … `arm.ok` never reads the `unarmed`
   list"* — **superseded.** `UNARMED is not PASS` shipped at `tools/tier3/gate.mjs:274-350`.

Baseline at the time of writing: `dashboard/server` **2088 tests, 2085 pass, 0 fail, 3
skipped**, exit 0.

---

## 8. OPEN, CARRIED FORWARD

1. **Negative-control stubs for §1.1's control 2** — do they exist in the fixture set, or must
   they be authored? Blocks the adjudicator, not increments 1–2.
2. ~~An earned `DID NOT PASS` routes to `repairing`.~~ **ARBITRATED 2026-08-16 — see §3A.**
   The lane must not fire on it at all.
3. **The builder never measures its own rendered output.** Both surviving real defects would
   have been caught by it. Not in this design.
4. **Nothing boots the two processes** — no LaunchAgent, no crontab, checked in
   `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`. *"No point
   where it stops on its own and requires me to boot it up"* is false until this exists.
5. **Does APPLY commit, or only write?** §3B.1 depends on it. Read `tools/tier3/gate.mjs`
   before designing persistence around an assumption.
6. **`APP_DIR` alias is a stopgap, not the fix.** The fix is that a suite may not hand-roll
   artefact-root resolution at all; the harness injects the helper and an audit rule refuses
   anything else. **That rule needs its own negative control: it must reject the real
   `dashboard/acceptance/t-855f41701dd1e908/suite/holdout/messages-persistence.test.mjs`, AND
   accept a suite that uses the injected helper.** Confirm first that a read-only suite mount
   can import an injected module without breaking the deliberate isolation described at
   `CONTAINER_PATHS` (`scorer-protocol.ts:47-57`).

---

## 9. THE ACCEPTANCE TEST — REPLAY THE LATEST FALSE FINISH

Owner, 2026-08-16: *"after it is finished perhaps you can try running the repair node on an
existing run maybe the latest one that had a false finish. to see if it can work."*

Adopted as **the** acceptance test for the repair lane. Target: `047f9872` — the newest
`falseFinish: 1` in the archive, whose four FUNCTIONAL failures are all one `APP_DIR` grader
defect. It is the ideal case: a PIPELINE defect (so the lane must wake), an artefact already
proven correct by hand, and a re-score that costs no model quota.

### 9.1 The fair-test rule, which is the whole value of the exercise

The diagnosis is already written down — §1.2, §6.2, and the memory note. **None of it may reach
the repair lane.** Its input is the defect record and the repo, exactly as it would be at 3am.
A lane handed the answer proves nothing, and grading our own homework is the practice this
repository exists to refuse.

### 9.2 Where the fix is allowed to land

| target | allowed | why |
|---|---|---|
| `bakeoff/src` harness — export the var, inject the helper, add the audit rule | **yes** | the pipeline is the lane's scope |
| the frozen suite under `dashboard/acceptance/<ticket>/` | **no** | editing a sealed suite retroactively is grader-softening, whatever it is called |
| `dashboard/runs/<id>/workspace` | **no** | that is the product, and the thing under measurement (§3A.1) |

Fixing the HARNESS is what makes the replay honest: the seal is never rewritten, and the
archived run can be re-scored against the suite it was always graded by.

### 9.3 Pass condition — mechanical, every conjunct

```
1  the lane WAKES on 047f9872, classifying it pipeline rather than artefact
2  its reproduction runs RED before any patch
3  patch applied      -> reproduction GREEN
4  patch reverted     -> reproduction RED again          (the ablation)
5  bakeoff + server + tier3 + repair suites ALL GREEN     (the regression conjunct)
6  re-score of the archived artefact -> 25/25, heldOutPass true, falseFinish 0
```

### 9.4 THE NEGATIVE CONTROLS, AND THEY ARE THE POINT

A "fix" that makes every archived run green has not repaired the grader, it has blinded it.
Three runs, three REQUIRED and DIFFERENT outcomes:

| run | composition | required after the fix |
|---|---|---|
| `047f9872` | 4 grader, 0 real | **25/25 — goes green** |
| `e1c15359` | 4 grader, 1 real (REQ-022 luminance/nav) | **24/25 — REQ-022 STAYS RED** |
| `6ec44b2f` | 4 grader (WAL), 1 real (REQ-020 ratios) | **REQ-020 STAYS RED** |

`e1c15359` shares `047f9872`'s frozen suite (`suite_sha256` 2e5a43a9…), so it is the sharpest
control available: the same suite, the same harness fix, and it must still fail — because its
artefact really is defective. `6ec44b2f` is a different freeze and a different grader defect,
so it also tests that the fix did not generalise into a blanket.

**Two of the three must stay red. A three-for-three green is a FAILED acceptance test.**

---

## 10. SELF-INTERROGATION — BRAINSTORMING WITHOUT A HUMAN IN THE ROOM

Owner, 2026-08-16: *"it would be good if it asked himself questions at points where i would
normally ask something or tell it something. it should probably use something like
/superpowers:brainstorming skill when it is asking itself a question."*

Read at `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/brainstorming/SKILL.md`.

### 10.1 Why it cannot be invoked as written

The skill's spine is a hard human-approval gate, stated in its own `<HARD-GATE>` block and
repeated on every path: *"the ceremony scales with the task; the approval gate never does."*
The repair lane exists so that no human is present. **Invoking it unmodified deadlocks at step
4 of every path, every time.** The parts to keep are the classification and the questioning;
the part to repoint is the gate.

### 10.2 The classification IS the routing rule, and it was already written

| skill's path | its own definition | repair lane routing |
|---|---|---|
| **spike** | a feasibility question whose output is an answer, not kept code | probe it alone, cheaply |
| **bounded** | *"the flow you are changing is already here to read"* | fix it alone; the APPLY gate enforces |
| **architectural** | *"changes that restructure how components fit together or alter interfaces others depend on"* | **NOT the lane's call.** Park and email the owner |

This is exactly the measurable/unmeasurable split of §3A, arrived at independently. Two of the
skill's own rules come along for free and both are safety properties:

- *"When in doubt between two paths, take the heavier one."*
- *"The ratchet is one-way: hidden complexity discovered mid-task upgrades the path."*

A lane that discovers mid-repair that it is restructuring an interface must therefore STOP and
escalate, not finish. That rule is worth more here than it is in a chat.

**The gate is repointed, not removed:**

```
skill:        design → HUMAN APPROVES        → implement
repair lane:  design → is the question MEASURABLE?
                       yes → the ablation gate decides
                       no  → the owner's inbox decides
```

### 10.3 THE TRAP: a question you also answer yourself is not a question

If the lane asks itself something and answers from its own priors, it has held a conversation
with itself and agreed. That is the self-grading defect wearing a new costume, and it is
exactly what §1.1 refused for test verdicts.

**RULE: every self-asked question must name its evidence source BEFORE it is answered.**

| source | the answer is |
|---|---|
| `CODE` | a `file:line` |
| `DATA` | a query against `dashboard/data/runs.db` or `results/` |
| `EXPERIMENT` | an exit code from something actually run |
| `CODEX` | an independent read from the other model (§3C) |
| `OWNER` | none of the above apply — park and email |

**A question that cannot be assigned one of the first four IS the fifth.** No exceptions: that
single rule is what stops "asked itself a question" from becoming "guessed with extra steps".

### 10.4 The question corpus is the owner's, not invented

The checklist is seeded from things the owner actually asked or volunteered — none of which
were derivable from the code:

- *"only fire when there is … something that stops the main one from finishing"*
- *"its job is not to handle the main task"*
- *"the repairs it does should also persist between runs"*
- *"use /codex:review … from my codex limit"*
- *"continues from where it left off?"*
- *"should not be as restricted as the main one"*
- *"is the model being restricted too much?"* — 2026-08-12, which that day's session doc calls
  the sharpest question of the day and which reversed the direction of two fixes.

PROPOSED: these live in a versioned checklist the triage step walks before proposing a patch,
each answered from a named source. A checklist entry answered `OWNER` is what populates the
email, so the report says what the lane *could not decide* as well as what it did.


---

## 10.5 THE ASKER, NOT THE REVIEWER — CODEX GOES FIRST

Owner, 2026-08-16: *"what if you had codex ask the questions so a different model?"*

**This supersedes §10's self-interrogation and §3C.2's placement of Codex.** §10 had the lane
asking itself, which leaves one set of priors generating both the question and the answer —
the self-grading defect at one remove. An independent model generating the QUESTIONS breaks it
at the source rather than checking it at the end.

### 10.5.1 Why the asker matters more than the reviewer

Evidence from this session, which is the reason the correction is being made rather than
merely argued:

| defect shipped 2026-08-16 | was it a wrong answer? | was it a missing question? |
|---|---|---|
| reporter read `details.error`, the runner's wrapper, so every assertion in every frozen suite would report a nameless `Error` with null `expected`/`actual` | no | **yes** — "is `details.error` the thrown error?" was never asked |
| a message fallback written with a confident rationale, reached by nothing | no | **yes** — "is this branch reachable?" was never asked |

Neither was caught by review. The end-to-end re-score of `047f9872` **passed with the reporter
defect present**, because that one failure's message happened to survive the wrapper — a
general defect wearing the face of a working feature. A reviewer looking at a green
end-to-end has little to object to. A questioner asking *"how do you know that field is the
thrown error?"* ends it in one line.

> **Review catches wrong answers. Questioning catches missing questions.** The second class is
> the one that has actually shipped defects in this repo, twice today and seventeen times in
> STATUS.md section 6.

### 10.5.2 The asymmetry that makes it cheap

A bad question costs one evidence lookup. A missing question ships a defect. **Questions can
only add**, so an independent model is worth more at the front of the loop than at the back —
which is NOT true of review, where a mistaken "looks fine" actively licenses a bad patch.

### 10.5.3 The revised loop

```
defect record
      |
CODEX  ask: "what must be known before anyone claims to understand this?"
      |     -> questions, each tagged CODE / DATA / EXPERIMENT / OWNER
CLAUDE answer each from its named source. Never from priors.
      |
      diagnosis -> patch
      |
CODEX  adversarial read: try to refute the diagnosis AND the patch
      |
      reproduce -> prove -> ablate -> regress -> APPLY      (the runner. no model.)
```

Codex bookends: it asks at the front and attacks at the back. Claude does the middle. The gate
still decides, and neither model may substitute for it.

### 10.5.4 The bound, and it is the same rule as the mutations

An unbounded asker produces forty questions and the lane drowns. The filter is not a count:

> **Keep only questions whose surprising answer would CHANGE the diagnosis.**

*"What does line 400 do?"* — the answer changes nothing. Drop it.
*"Is `details.error` the thrown error?"* — if the answer is no, the diagnosis dies. Keep it.

This is `probe-needs-negative-control` applied to enquiry: a question that cannot change the
outcome observes nothing, exactly as a test that cannot go red observes nothing.

### 10.5.5 What does NOT change

Codex asking does not license Claude answering from its priors. §10.3 stands unaltered: every
answer names its source, and a question that fits none of `CODE`/`DATA`/`EXPERIMENT`/`CODEX` is
an `OWNER` question and goes in the email. **Two models agreeing is still two models agreeing**
— it is not evidence, and it never reaches the gate as if it were.

---

## 11. THE QUESTIONS PANEL — MAKING THE LANE'S REASONING VISIBLE

Owner, 2026-08-16: *"I want the review orchestrator to have a section where I can see the
questions that where asked."*

This is the owner's window into a lane that runs while they are asleep. It replaces the thing
it is displacing: sitting in a chat watching the reasoning happen.

### 11.1 Placement

A section of the repair node (§5), beside what broke, the patch and the report:

```
REPAIR NODE
  |- what broke
  |- QUESTIONS        <- this section
  |- patch + proof
  |- report
```

### 11.2 Grouped by OUTCOME, never by order

Chronological order is close to useless: most questions confirm what was already assumed, and
burying the two that did not inside eighteen that did is how a panel becomes wallpaper.

| group | contents | default |
|---|---|---|
| **NEEDS YOU** | tagged `OWNER` (§10.3) — the lane could not answer it from any evidence source | pinned, always open |
| **CHANGED THE DIAGNOSIS** | the answer was NOT what was assumed | open |
| **CONFIRMED** | assumption held | collapsed, count only |

Each row carries: **asker · question · source tag · answer · citation.**

```
CODEX   "is details.error the thrown error?"
        CODE -> no. node wraps it in ERR_TEST_FAILURE; the real error is on .cause
        scorer-container.ts:1218
        => CHANGED THE DIAGNOSIS
```

The `NEEDS YOU` group is the same set that populates the second half of the email (§10.4), so
the panel and the report cannot drift: one source, two renderings.

### 11.3 TWO METRICS FALL OUT OF IT, AND THE SECOND ONE CAN KILL THE FEATURE

| metric | reads |
|---|---|
| `OWNER`-tagged questions per run, over time | is the lane becoming more autonomous? Trending to zero is the goal, and it is the same trend §3B asks of the firing rate |
| questions that CHANGED the diagnosis | **is Codex-as-asker earning its cost?** |

The second is deliberately self-refuting. §10.5 argues that an independent asker catches the
class of defect a reviewer misses, and cites two from this session. **If that argument is
wrong, this panel is where it shows: a Codex asker whose questions never change a diagnosis is
ceremony, and the honest response is to delete the step rather than keep paying for it.**

A feature that cannot display its own failure is the defect this repo is named for. This one
displays it as a column.

### 11.4 One caution

Question and answer text can quote held-out assertion content, since it is derived from
`TestFailure` (§6.2). Display-only, rendered to the owner, never inside a build sandbox — so it
is safe as specified. **Recorded so that nobody later feeds this panel's contents into a seat
prompt, which would be a held-out leak with no tripwire.** Related and already true of the
existing tree: `runs.db`'s `criteria.detail` stores held-out test TITLES outside the sealed
store.

---

## 12. CORRECTIONS FROM THE TRIGGER-MAP WORKFLOW (2026-08-16, run `wf_61bfe061-8a6`)

36 agents: five parallel read-only investigations, every claim then handed to an adversarial
reviewer instructed to refute by default. **12 claims survived, 18 were corrected.** The three
load-bearing ones were then re-verified by hand in this session rather than relayed
([[postmortems-relay-agent-hypotheses]]).

Corrections are recorded here and the original text above is left standing, per this repo's
rule that corrections are dated in place and never silently overwritten.

### 12.1 What this document got WRONG

| § | claim | measured truth |
|---|---|---|
| §4.1 | a gate failure "produces **no defect record at all**" | **False.** 11 `defect.json` files exist under `dashboard/runs/*/results/`, including all four gate-red runs. Verified by hand: `find dashboard -name "defect*.json"`. Records exist; they are too COARSE to route on, which is a different and smaller problem |
| §4 table | `recovery_class` "written only at `orchestrator.ts:2082`" | **False.** Five writers — `:1883`, `:1899`, `:2082`, `:7146`, `:7289`. `:2082` is only the sole `classifyPhaseFailure` writer. The NULL-on-the-gate-path conclusion survives |
| §3A / §8.2 | populating `recovery_class` fixes the routing | **No.** `boundFor("unclassified") = 0`, and the arm is `typeof bound !== "number" \|\| bound === 0` — so a classified value lands exactly where NULL lands. 8 of 11 class words take that arm. Fixing it needs a NEW ARM AND A NEW STATE, not a class word |
| §6.2 / §8.5 | "the manifest producer at the throw site" | **Names the wrong artefact for 3 of 4 known instances** — two are test-file SOURCE, one is a CRITERION STATEMENT, one is the manifest |
| §4 table, `defect-record.ts:474-528` | the rejected manifest "lives under gitignored `dashboard/runs`" | **False.** It lives NOWHERE — `freezeSuite` writes a suite to disk on the SUCCESS path only |
| §8.5 | "does APPLY commit, or only write?" | **ANSWERED: only writes.** Verified by hand: `tools/repair/supervisor-gate.mjs` contains `git apply` and no `git commit`; the only `git commit` in `tools/` is inside `armCheck`'s throwaway repo. `revertGatedPatch` has no production caller |
| §1.1 / §8.1 | negative-control stubs — do they exist? | **ANSWERED: no, and worse.** 4a yields 1 isolating violator across 4 criteria, 4b yields 0 across 11, and there is NO visual/geometric stub — which is where both surviving real defects live. §1.1's control 2 is **unsatisfiable as written** for pure-reachability criteria under static mode; those need an explicit "non-adjudicable" carve-out |
| §6.1 | `bakeoff` "242/242" | **246/246.** This document was stale within hours of being written, which is the defect it exists to prevent |

### 12.2 THREE BLOCKERS THAT WERE NOT IN THE PLAN

1. **Nothing can wake the lane.** `supervisor_tickets` rows are minted only by
   `enqueueSupervisorTicket`, whose sole production caller is `http.ts:2016`
   (`POST /api/supervisor/tickets`). **A run created by `POST /api/runs` is structurally
   invisible to the supervisor.** Verified by hand. Zero rows have ever existed. Every other
   increment is downstream of this.
2. **Nothing persists.** §3B's requirement is 0% built, not 80%: the patch is applied to the
   working tree and never committed, so the next `git checkout` erases it and the same defect
   fires again having taught the system nothing.
3. **A RESTART RE-RUNS THE TICKET — a live bug, not a design gap.** `reconcileOnBoot` stamps
   `recovery_class: "interrupted"` (`:1879-1884`); nothing ever clears it; the gate path writes
   no class, so a terminal gate-red row still reads `interrupted`; `boundFor("interrupted") = 3`
   → `supervisor.ts:1462` re-submits the whole ticket. **A dashboard restart converts an earned
   DID NOT PASS into an automatic rebuild of the main task** — precisely the wake §3A forbids.

### 12.3 THE ACCEPTANCE TEST'S REAL BLOCKER, AND WHY IT VINDICATES THE ORDERING

`047f9872` carries `gate_stop_reason: not-converging` and `false_finish: 1`. Read through §3A's
table that is "artefact-caused ⇒ main workflow" — **yet §9 requires the lane to WAKE on it**,
because all four failures are one `APP_DIR` grader defect.

So the cheap discriminators — stop reason, stop cause, `false_finish` — **cannot settle §9.3
conjunct 1.** `criteria.detail` carries test TITLES only. The only evidence in the system that
can distinguish a grader defect from an artefact defect is the **per-test failure reason**,
which is what increment 1 built and which no archived record has.

**§9 is therefore blocked on increment 1's remaining step** — rebuilding the scorer image and
pointing `BAKEOFF_SCORER_IMAGE` at it — and not on increment 2. The first thing built turns out
to be the only thing that can answer the first conjunct of the acceptance test.

### 12.4 The increment boundary, restated after the workflow

`settle()` never reads a defect record: `supervisor.ts:1386` and `:1409` route on
`recovery_class` alone, and `defectSignatureOf` is called at `:1432` INSIDE the branch, after
the route is already chosen. **Increment 2 therefore changes ZERO wake decisions.** It enriches
the diagnosis input that increment 3's router will read. Anyone reviewing increment 2 as "the
trigger fix" will judge it against the wrong bar, and that sentence belongs in its commit
message.

The full 11-step plan with per-step mutations is in the workflow result at
`wf_61bfe061-8a6`; §A of it records where the five lanes disagreed and how each was resolved.

---

## 13. THE LANE IS A CHILD, NOT A SIBLING — AND §5's DIAGRAM IS WRONG

Owner, 2026-08-16: *"The repair workflow should spawn under the other workflow when
necessary."*

**§5's diagram is corrected by this.** It draws the repair lane as a permanent column beside the
main orchestrator, always present. It is not. It is a CHILD that is spawned at the point of
failure, by the run that failed, and it does not exist at all when nothing has broken.

```
                    MAIN
                     |- plan
                     |- spec
                     |- build
                     |- gate  X ----- REPAIR  (spawned HERE, and only now)
                     |                  |- triage
                     |                  |- codex asks
                     |                  |- patch + prove + ablate
                     |                  '- report
                     '- (the ticket continues once the repair lands)
```

This does NOT contradict *"an entirely separate node… its own repair orchestrator"* (§1). Both
are true: it keeps its own agents, its own budget, its own goal loop and its own gate. What
changes is its PLACEMENT and its LIFECYCLE — nested under the run that surfaced it, and absent
until one does. *"When necessary"* is the firing rule of §3A restated as a visual property: no
qualifying failure, no node.

### 13.1 Nested display, GLOBAL effect — do not let the nesting scope the fix

| | |
|---|---|
| spawned under | the run that surfaced the defect |
| repairs | **the pipeline**, for every future run |

The nesting records PROVENANCE — where the defect was found — and must not be read as scope. A
patch scoped to the run that triggered it would fix nothing durable, and would contradict §3B,
whose whole requirement is that a repair outlives the run and drives the firing rate to zero.
The node is a child; its effect is not.

### 13.2 Two runs, one defect, one repair

Nesting makes concurrency visible and therefore makes it a design question rather than an
accident:

```
run A  gate X --- REPAIR  signature abc123    running
run B  gate X --- REPAIR  signature abc123    "already being repaired under run A"
```

**Dedup is by DEFECT SIGNATURE, never by run.** Two children may point at one repair. The
mechanism already exists — `SUPERVISOR_REPAIR_MAX_PER_SIGNATURE = 2` (`supervisor.ts:175`), a
per-signature and deliberately not per-ticket bound, whose own docblock says mixing counters is
how a bound stops working. Nesting does not add the bound; it makes its absence from the UI
visible.

**Consequence for §6's plan:** the canvas work is no longer "add a node type". It is "add a
child lane that a run can spawn, that dedups by signature, and that renders nothing when the
run is healthy". The questions panel of §11 lives inside that child.

**Consequence for the acceptance test (§9):** `047f9872`'s repair child is spawned by a run
that has already terminated. A child of a finished run is a real case and not a degenerate one
— the archive is where the lane will most often be exercised — so the lifecycle must permit
attaching a repair child to a terminal run, not only to a live one.
