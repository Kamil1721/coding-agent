# RUN `54927ebc` — THE FIRST COMPLETE RUN ON THIS CODE, AND WHAT IT COST TO LEARN

`run-2026-08-10T13-11-12-836Z-54927ebc`. Submitted 13:11:29Z, ended 16:29:47Z.
**3 h 18 m 18 s. spec → build → gate ×2 (+1 fix round) → judge → done, with no human
intervention after submission.** The first run to reach `done` since 2026-07-29, and the
first ever on the code as it stands.

**Verdict: `# DID NOT PASS` — 7 things the ticket asked for are not there, 0 BLOCKING,
7 FUNCTIONAL.** `heldOutPass = false`. The verdict is earned: the gate opened, the frozen
suite executed (37 tests, 28 passed, 9 failed, 193.7 s), and every criterion was traced to
the owner's words.

---

## 1. THE HEADLINE IS NOT THE VERDICT — IT IS THAT `falseFinish` LIED

```
sqlite3 dashboard/data/runs.db "select held_out_pass, false_finish, agent_declared_done
  from runs where run_id='run-2026-08-10T13-11-12-836Z-54927ebc';"
  -> 0 | 0 | 0
```

The builder wrote `.bakeoff/self-report.json` — 14,740 bytes, valid JSON, 13 keys including
`honest_gaps` and `conflicts_with_the_ticket` — with **`"status": "complete"`**. The sealed
suite then disagreed with it. **That is the definition of a false finish**, and the metric
built to catch it reported `false`.

Cause, measured:

```
bakeoff/src/dryrun.ts:1019    outcome.selfReport?.status === "done"      <- one literal
<run>/results/prompt.txt:4    "write .bakeoff/self-report.json as described earlier"
```

**"As described earlier" is on line 4. There is no earlier.** The prompt names the file
twice more (:37, :140) and never describes its shape or its status vocabulary. The builder
guessed a reasonable synonym. The orchestrator logged *"the builder's self-report could not
be read (absent status, or not JSON)"* — wrong on both counts — and recorded
`agentDeclaredDone = false`.

**Consequence:** `falseFinish = agentDeclaredDone && !heldOutPass` can only ever be `false`
while this holds. One of the project's two co-primary metrics is disarmed, and it is
disarmed in the direction that reads as good news. Instance twenty-three of the signature
defect, in the number the system exists to produce.

FIX, and it is the pattern that already worked this morning for N1: describe the file in the
prompt, and add a test that parses the accepted literal OUT of the shipped prompt and
asserts the reader accepts it, so the two cannot drift. Accepting `done|complete|finished`
is the five-minute mitigation; binding them is the fix.

---

## 2. THE SEVEN FAILURES HAVE ONE CAUSE, AND IT IS A HOLE IN THE HELD-OUT DESIGN

All seven are FUNCTIONAL; all five BLOCKING criteria passed, so the artefact boots, serves
and clears every sealed gate. The fix agent's diagnosis, verbatim from the run log, and it
is better than the one this session would have reached:

> `listen()` is denied for TCP *and* unix sockets, and Chromium won't launch, so I couldn't
> run anything end to end. Instead I replaced `global fetch` with a shim that drives the
> real router directly and ran **the actual `visible-acceptance/*.mjs` files** under it. All
> 10 assertions pass against the real assertions — which ruled out the API contract as the
> cause and narrowed the search.
>
> The visible REQ numbers have exactly 6 gaps in 1–20 (003, 004, 011, 014, 018, 020) plus
> likely 021 — matching the 7 unmet exactly. So *every* held-out criterion is failing, which
> points at systemic causes, not seven separate bugs.
>
> **The bearer token env var name.** The ticket requires the token to come from "an
> environment variable" but never names it, and the suite was written from the ticket before
> this build existed — so it cannot know my name either. I was matching six names. If the
> harness picked anything else, the route silently 401s and *every* criterion that reads
> messages back fails together.

**This is not a builder defect and not a suite defect.** The ticket under-specifies a
literal; the suite is authored from the ticket alone, before any code exists, so it must
invent one; the builder must invent one; nothing in the pipeline makes the two agree. One
401 then fails every read-back criterion at once.

---

## 3. THREE DEFECTS IN ONE DAY, ONE SHAPE

| the literal | demanded by | never shown to | cost |
|---|---|---|---|
| `dataExpectations`' seven fields | `parseSuiteManifest` | the spec seat | run `a913c871`, 1 h 27 m, dead |
| self-report `status: "done"` | `dryrun.ts:1019` | the builder | `falseFinish` disarmed, silently |
| the token env-var name | the frozen suite | the builder | 7 of 7 FUNCTIONAL failures |

**Two sides must agree on a string and nothing binds them.** Worth generalising into a rule
before a fourth instance: any literal that two independently-prompted seats must match is a
contract, and a contract needs one source and a test that binds both readers to it. N1 is
the worked example — it parses its own example out of the rendered prompt and runs it
through the real validator, and two of its four mutations weaken the prompt while two weaken
the validator, because the binding has two ends.

---

## 4. THE TENSION THE OWNER SHOULD SEE, BECAUSE IT IS A REAL TRADE AND NOT A BUG

The plan phase is exactly what would have caught §2. *"What should the bearer token's
environment variable be called?"* is the class of question it exists to ask — a literal the
build needs, that the ticket does not state, whose answer changes a criterion.

It was skipped, deliberately, by us: `designLock: "auto"` → `interactive: false` →
`planPolicy → "skip"`, so no plan seat was called at all
(`plan.json`: `turnsUsed: 0`, `closed.reason: "nothing to ask"`).

**Never-park bought an unattended night and cost the negotiation that would have made the
run passable.** Both halves of that sentence are measured. The options are not obviously
ranked:

- keep never-park, and make the SUITE publish the literals it will grade against (the
  frozen manifest already travels to the builder — an env-var contract could ride it);
- let the plan seat run unattended with `ifUnanswered` defaults, accepting a plan-seat call
  and its output-cap risk on every run;
- keep both, and treat an under-specified literal as an audit finding at freeze time, so the
  suite refuses to freeze a criterion it cannot fairly grade.

The third is the only one that fixes the class rather than this instance.

---

## 5. WHAT RAN FOR THE FIRST TIME, AND HELD

Everything built 2026-08-10 that had never executed on a real run:

| | evidence |
|---|---|
| minute heartbeat | 30 log rows, *"…has been running for 21m00s and has not come back yet"*. Zero rows across 1,816 events and five runs before today. |
| seat-boundary rows | *"seat call 2 of this phase: draft 2 … so draft 1 was refused"* — last night this was inferred from a changed PID. |
| `rate_limit` carries `seat` | `{"type":"rate_limit","limited":false,"retryAfterSec":1558,"seat":"spec"}` |
| no-capture emitter | *"no reference capture for this ticket: it names no page to copy"* — the stage settles. Found by the owner looking at the screen. |
| spend ledger | five seats, 143 calls, 905,122 output, 49,413,847 cache read. Zero rows on any previous run, ever. |
| authoring trail | attempt 1's 11 findings and attempt 2's 17, from the frozen `AUDIT.json`. |
| ceiling guard | *"every seat runs on claude-opus-5[1m] (measured output ceiling 128000 tokens…)"* |
| plan skip, not park | `turnsUsed: 0`, `closed.reason: "nothing to ask"` |
| gate → fix → gate | attempt 1: 1 failure / 7 unmet → fix round 1 → attempt 2: same → **stopped as `not-converging` rather than spending attempt 3.** |
| zero inferred criteria | `inferred_criteria = 0`, against run 1's 2 and run 3's 16. The best value recorded on this machine. |

**The manifest fix worked by prevention, not repair:** not one `dataExpectations` error in
either draft. Shown the shape, the seat never made the mistake, and the recovery machinery
built for it never fired. Weaker claim than "the retry fixed it", and the better outcome.

---

## 6. FIX LIST, RANKED BY WHAT IT COSTS TO LEAVE

1. **Bind the self-report contract** (§1). `falseFinish` is a co-primary metric and is
   currently unable to fire. Prompt description + a test parsing the literal out of the
   prompt. Small. **Do this first.**
2. **Decide how the suite and the builder agree on an under-specified literal** (§2, §4).
   The class fix is an audit finding at freeze time: refuse to freeze a criterion that turns
   on a string the ticket never states. Days, and it is the one that stops this recurring.
3. **`gate_attempts` read 0 in the `runs` row while the log said "gate attempt 1"** — the
   column lags the event. A reader trusting the row under-reports the loop.
4. **The visual gate is still shadow**: *"48 observation row(s), 0 of them counting toward
   the verdict"*. The owner's animation bar is measured and cannot fail a run (B4, carried).
5. **`design-prompt.ts` is a hand transcription of `~/.claude/agents/taste-frontend-expert.md`**
   with nothing binding them; `0 skills` on the canvas node is the SDK limitation
   (`AgentDefinition.skills` preloads nothing), not a missing wire. Add a drift test.
6. **The design lane attaches no hooks** — `grep -an hooks design-lane.ts design-prompt.ts`
   is empty, while `antislop-hook.ts` has three hook sites wired at
   `claude-builder.ts:804`. The lane that authors the art direction is the one lane the
   anti-slop guardrails do not cover.
7. **The preview route cannot show a server artefact.** It opens `index.html` and this
   artefact is a Node server (`server.mjs`, `public/` holds only `styles.css` and `app.js`),
   so the preview 409s permanently for exactly the kind of ticket the owner wrote. It should
   detect a server artefact and offer to boot it.
8. **The authoring trail records findings without marking which were blocking**, so draft 2
   (17 findings, frozen) reads worse than draft 1 (11 findings, regenerated). It misled this
   session for a minute; it will mislead someone at 3 a.m.
9. **"0 of 5 done"** on the pre-build panel while two stages are resolved as SKIPPED. After
   45 minutes a reader concludes nothing happened.

---

## 7. AND THREE INSTRUMENT BUGS OF MY OWN, RECORDED BECAUSE THE PATTERN IS THE LESSON

Every watcher I built during this run was confidently wrong about something it was not
actually measuring:

1. the liveness arm matched the API server instead of the seat (`pgrep -f` matched the zsh
   wrapper, `head -1` took it) — it would have reported a healthy seat forever after the
   seat died;
2. the ceiling arm matched every SDK process on the machine, so a concurrent workflow's test
   spawning a 16000-cap plan seat produced two *"the truncation ladder fired"* alarms;
3. a `find -newermt '-25 minutes'` returned nothing because BSD `find` would not parse the
   relative form, and I read the silence as "the builder has stopped writing files" while it
   was writing six files a minute.

All three are the catalogued defect: a probe whose failure mode is silence, or whose label
assumes the only cause its author thought of. The fix that worked each time was a **start-up
arm check that runs while the answer is known** and prints BLIND when the matcher finds
nothing.
