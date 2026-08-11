# PHASE 1 — THE SELF-REPORT CONTRACT IS BOUND; ITEMS 2 AND 3 SHARE ONE PRICE

Session of 2026-08-10, following `RUN-54927ebc-postmortem.md`. Baseline measured before
the first edit, not read from a handover: bakeoff 164/164, server 1975/1972/0 fail,
client unit 224, tsc exit 0 ×3.

---

## 1. LANDED — `falseFinish` CAN FIRE AGAIN (postmortem §1, plan item 1)

**The cause was not the missing description. It was which function held it.**

`dashboardBuilderPrompt` has described the self-report shape since `ad185c2`. It was never
sent on the run that failed. `#buildSegmentPrompt` (`orchestrator.ts:4643`) has two
branches and keys on `builderSessionId`, so a design-lane run — segment 1
`designSegmentPrompt`, segment 2 resumes it — takes the resume branch on its **first build
turn**. `resumeBuilderPrompt` said *"as described earlier"*, and there is no earlier.

Measured on the run's own artefact, not reasoned:

```
runs/…-54927ebc/results/prompt.txt:1  "Your previous turn ended early: the design was locked…"
                                :4  "…write .bakeoff/self-report.json as described earlier."
grep -c "exactly this shape" …/prompt.txt   ->  0
```

Worse than the postmortem recorded: on a design-lane run the builder is pointed at the
self-report **three times** (`resumeBuilderPrompt:534`, and twice via `designHandoffSection`
→ `design-prompt.ts:870`, `:905`) and told its shape **zero** times.

### The fix, following this file's own precedent

`harnessEnvironmentSection()` was moved to a shared section on 2026-08-02 for the identical
reason, with the drift argument written on it. `selfReportSection()` is the third section to
move there, called from both `dashboardBuilderPrompt` and `resumeBuilderPrompt`.

The status words are now rendered from one runtime constant, `SELF_REPORT_STATUSES`, bound
to the reader **in both directions at compile time**:

- `satisfies readonly SelfReportStatus[]` — every word offered is a word the reader accepts;
- `Exclude<SelfReportStatus, …>` resolving to `never` — every word the reader accepts is offered.

Before this there were four unbound copies of the triple across two packages:
`runner.ts:125` (type), `runner.ts:1227` (the guard, hand-written, not derived from the
type), `build-prompt.ts:491`, and `build-prompt.test.ts:515` — a regex mirror that checked
the prompt against a fourth copy rather than against the reader.

### The probe that could only observe success, and its replacement

The one test guarding the contract ran against `dashboardBuilderPrompt` only, and its
companion assertion `/self-report\.json/` **would have passed against the broken resume
prompt too**, because line 534 interpolated the same path. It could not see the failure that
shipped. Instance twenty-four of the signature defect, in the check built to prevent
instance twenty-three.

It is replaced by a round trip: the status words are parsed back **out of the rendered
prompt** and each is put through the **real `readSelfReport`** via a real file on disk. The
extractor throws in three distinct places rather than returning `[]`.

**Both ends measured live, by mutation:**

| # | mutation | end | result |
|---|---|---|---|
| 1 | restore `"as described earlier"` (the actual 54927ebc bug) | prompt | **4 tests fail** |
| 2 | prompt offers `"complete"` | prompt | **2 tsc errors + 2 tests fail** |
| 3 | reader accepts only `"done"` | validator | **1 test fails** |
| 3b | reader drops only `"incomplete"` (single-word drift) | validator | **1 test fails** |

Restored after each; 34/34 green, and `bakeoff/dist` rebuilt from source to undo mutation 3.

**Digest-safe.** Both edited files are under `dashboard/server/src`, outside the
`bakeoff/` docker build context. bakeoff stayed 164/164, which is the check.

**Checked for the `885663d` failure mode** — *"green on a clean checkout, red on a machine
that had done work"*, and its mirror. The new test imports `readSelfReport` from
`bakeoff/dist/runner.js`, which is gitignored, so it was measured with `bakeoff/dist` moved
aside: the server package fails to typecheck without it. **That is pre-existing and
pervasive, not introduced here** — `dashboard/server/src` already holds **135** other
`bakeoff/dist` imports, including `orchestrator.ts:68`, which is where the production
`readSelfReport` comes from. A clean checkout must build `bakeoff` before the server either
way; this test is import 136 of the same kind, and binding to the *same* compiled reader the
orchestrator uses is the point.

At this point in the session `bakeoff/src` was untouched and bakeoff stayed 164/164. Rule 4
(§4) later changed that deliberately; the whole-session gate is at the foot of this file.

---

## 2. STOP — THE SEVEN FAILURES WERE NOT AN ENV-VAR MISMATCH

**This refutes postmortem §2, and §2 is the entire justification for plan item 2.**

The postmortem records the fix agent's diagnosis — *"the bearer token env var name … I was
matching six names … every criterion that reads messages back fails together"* — and treats
it as the cause. It is a hypothesis from inside a sandbox where the agent could not run
anything end to end, and it is **wrong on every checkable particular**.

Measured, from the frozen suite and the shipped verdict:

| the claim | what is actually there |
|---|---|
| the 7 unmet are REQ 003, 004, 011, 014, 018, 020, (021) | the 7 unmet are **REQ-010, 011, 015, 016, 017, 021, 022** — only REQ-011 is in both |
| a token env-var mismatch 401s every read-back criterion | **REQ-012 and REQ-013, the two bearer-token criteria, both PASSED** |
| the held-out half grades against an invented env-var name | the held-out half reads **`APP_BASE_URL` and `APP_ROOT` only** — no token variable anywhere |

(There IS an env-var defect in this suite, but it is `APP_ROOT`, not a token, and its
mechanism is nothing like the one claimed. See §8.)

Row 1 compares like with like: the agent derived its set as "REQ numbers in 1–20 with no
visible coverage", and that derivation reproduces exactly —
`REQ-003, 004, 011, 014, 018, 020`. Same suite, same ids. Its *conclusion* is what fails: of
those six, **only REQ-011 is actually unmet**, and the other five all passed.

`holdout/messages-auth.test.mjs` never needs the name: it tests only the **negative** cases —
no header (`T-20`) and a deliberately wrong token (`const WRONG = "this-is-not-the-token"`).
There is no test anywhere in the suite that presents a *correct* token, so no correct token
name was ever required, so no mismatch was possible.

What the seven actually are: contact-form validation storing no row (REQ-010), an accepted
POST storing exactly one row with a timestamp (REQ-011), `/work` naming all six CV projects
with stack and role (REQ-015), illustrations with alt text in each of the six cards
(REQ-016), the home page's name/role/selected-work strip (REQ-017), the contact form posting
for real and rendering the 201 confirmation (REQ-021), and reduced-motion opacity (REQ-022).
**SUPERSEDED BY §8 — read that instead.** At this point in the session these looked like
artefact gaps and the verdict looked earned. Adjudicating all seven against the scorer's own
`result.json` showed otherwise: **three of the seven are grader defects** and two more turn
on a probe heuristic. The paragraph is kept because the correction is the point, not the
first guess.

**Consequence for the plan.** Item 2 — publish the suite's literals to the builder — would
have changed nothing about this run. It should not be built to fix these seven, and it should
not be the thing a scorer-digest move is spent on. The generalisation in postmortem §3
("two sides must agree on a string and nothing binds them") remains true and is worth
holding; the *third row of its table* is not an instance of it.

**How this got two seats deep.** The fix agent's prose was careful and plausible, it was
recorded verbatim, and nobody re-derived it against the suite. Instance twenty-five, in the
document written to catalogue the pattern.

### A second hypothesis, also wrong — kept because §8 kills it too

**SUPERSEDED BY §8.** The visible-twin counts below are real, but the inference from them is
not: the scorer's `result.json` records REQ-015 and REQ-017 as `2 of 2 asserting test(s)
failed`, so the visible twins **failed as well**. Only REQ-016 has the visible-pass /
holdout-fail shape. The builder did not overfit to the visible half — it could not execute
the visible half, because Chromium would not launch. Two hypotheses in one session, both
plausible, both refuted by the same file nobody had opened.

### The superseded reasoning

The agent's second claim — *"every held-out criterion is failing, which points at systemic
causes"* — is also false, and its inverse is the interesting finding:

```
REQ-010  visible twin: YES   unmet
REQ-015  visible twin: YES   unmet
REQ-016  visible twin: YES   unmet
REQ-017  visible twin: YES   unmet
REQ-011  visible twin: no    unmet
REQ-021  visible twin: no    unmet
REQ-022  visible twin: no    unmet
```

**Four of the seven have a visible twin, and the builder passed all ten visible assertions.**
So for those four the builder satisfied the fixture it could see and failed the held-out
fixture for the *same criterion*. That is overfitting to the visible half — the single
behaviour the visible/holdout split exists to detect — and it means **the split worked.**

Corroborating, and it rules out the simplest alternative: all six CV project names
(`Teewise, Trade Assistant, JobSilver, Kori, Parts Agent, CrewFlow`) ARE present in the
artefact, four files each. REQ-015 and REQ-017 did not fail because the content is missing;
they failed on where or how it is rendered. "The builder never did the work" is not the
explanation.

## 3. THE PLAN'S OTHER PREMISE FOR ITEM 2 IS ALSO REFUTED

> *"the frozen manifest already travels to the builder, which is how the judge and the
> artefact agree on port 3000 — an env-var contract could ride the same channel."*

**No manifest field reaches the builder's prompt or the builder's environment.** Negative
control: `grep -n "SUITE_MANIFEST|suite\.manifest|parseSuiteManifest|resolveExecutionPlan|
execution\.port|STATIC_SERVE_PORT" dashboard/server/src/orchestrator.ts` returns nothing.
`harnessEnvironmentSection()` takes **zero parameters** — it is structurally incapable of
carrying a manifest value, and prints `STATIC_SERVE_PORT`, a compile-time constant
(`scorer-protocol.ts:377`).

The port agreement is itself two unbound literals that happen to match: the prompt prints the
constant, and the spec seat writes `"port": 3000` because `spec-agent.ts:385` asks for it
**in prose**. On the real server-mode suite the fallback `?? STATIC_SERVE_PORT` never even
executes — `execution.start` is `"npm start"`, so the scorer takes the server branch and
probes a model-authored literal. **The port is instance four of the same defect, sitting
unnoticed inside the example cited as the working channel.**

A suite→workspace file channel does exist (`materialiseVisibleSubset`, `spec-freeze.ts:822`)
but filters to `visibility === "visible"`, and the manifest's plan entry is empirically
`holdout`. It is also worth stating plainly: **the manifest has no env-var field at all** —
`execution` is `{install, build, typecheck, lint, start, port, healthPath, bootTimeoutMs,
commandTimeoutMs}`. The literal that failed the run lives only inside the holdout test source.

So item 2 is **construct a channel**, not ride one. Two routes, and they differ in price:

- **(i) Declared contract.** The spec seat authors an explicit "literals I will grade
  against" block in the manifest; the orchestrator publishes it into the workspace. Correct,
  and the only version that is a *contract* rather than a scrape. Touches
  `bakeoff/src/spec-types.ts` and the authoring prompt → **moves the scorer digest.**
- **(ii) Scrape.** Dashboard-side: read the frozen holdout sources, extract
  `process.env.X` names, write them into the workspace via `#prepareWorkspace`
  (`orchestrator.ts:5397`, which already writes `TICKET.md` and already has both inputs in
  scope). **Digest-safe**, but it publishes a projection of the holdout to the graded agent
  and is fragile to how a test happens to spell the read.

---

## 4. THE CLASS GUARD (RULE 4) — LANDED, ADVISORY, AND THE MACHINERY IS ALREADY THERE

Freeze time is the wrong place *mechanically*: `FreezeSuiteInput` (`spec-freeze.ts:205-225`)
carries no ticket brief, only a digest of it, so it cannot compare a criterion against the
owner's words. The check belongs in `deterministicAudit`'s existing section
**"bars the ticket never asked for"** (`spec-validate.ts:1628-1631`), beside
`proseLengthFloorFindings` — where `ticketBrief` is already plumbed in unconditionally
(`spec-agent.ts:1719-1727`).

**No new refusal site is needed and no new `AuditFindingKind`.** A finding with
`mustRegenerate: true` already sets `auditPassed: false` (`spec-agent.ts:1842`), and
`freezeSuite` already refuses on it at `spec-freeze.ts:274` → `contracts.ts:373-384`,
kind-agnostically. "Refuses to freeze" comes free; only the detector is missing.

### What landed

`unstatedEnvContractFindings` + `statesToken` in `spec-validate.ts`, pushed from
`deterministicAudit` beside the two existing ticket-relative rules. Eight tests, of which
five are negative controls, because a conjunction can be satisfied by one half while the
other half is dead:

| control | what is held constant | must be |
|---|---|---|
| A | the suite; only the BRIEF now names `API_TOKEN` | silent |
| B | prose spelling — "api token" states `API_TOKEN` | silent |
| C | the harness's own `APP_ROOT` in the firing fixture's place | silent |
| D | the same name published by the VISIBLE half | silent |
| — | no brief at all | **a finding saying the rule DID NOT RUN**, never `[]` |

Control D is the asymmetry's justification, asserted rather than assumed: the visible half is
copied into the builder's workspace, so a name that appears there has been published and the
two sides can agree by reading. Only the held-out half is graded on a guess.

**Measured fire rate: 0 of 3 frozen suites on disk**, each against its own real ticket brief
from `runs.ticket_text` (803 b / 14,442 b / 1,455 b). Every env read in all three is
`APP_BASE_URL` or `APP_ROOT`. Without the allowlist a blocking version destroys all three.
Note this is a *weak* zero — three suites — which is exactly why it is advisory. Promotion to
blocking is one word (`advisory` → `blocking`) and should wait for a real fire rate.

**It correctly does NOT fire on `54927ebc`.** Given §2, that is the right answer, not a miss.

---

## 5. THE DECISION THIS LEAVES THE OWNER

The owner chose, this session: *2(i) + 3 together, one digest move, item 3 advisory-first.*
**§2 was found after that choice and undercuts half of it.** Item 3 is landed. Item 2 was
**not built**, and should not be until someone answers §2.

**On the digest.** Any `bakeoff/src` edit moves the scorer image digest — the build context
is `bakeoff/` with `COPY src ./src` and no `src` exclusion, so pure prompt text and
`*.test.ts` count. Rule 4 has therefore already spent it: **the image must be rebuilt and the
calibration and run-1 baseline re-scored before the next graded run is comparable to the
old ones.** That is the cost of this change, stated plainly, and it is now sunk — so anything
else wanted in `bakeoff/src` should ride along before the rebuild rather than pay again.

Open, and genuinely not decidable from here:

1. ~~**Why did REQ-010/011/015/016/017/021/022 actually fail?**~~ **CLOSED — see §8.** Three
   are grader defects, two more turn on a probe heuristic, and the browser-side failures all
   trace to one systemic cause: the builder could not launch Chromium and never saw the site
   rendered. The pre-run list is at the end of §8.
2. **Is item 2 worth anything at all?** The class it belongs to is real (the port is a live
   instance — see §3), but the run cited to justify it is not. If it is built, build it for
   the port, which is measurably unbound, and not for a token nothing graded.
3. **The gate is not implemented.** `graded_scorer_digest` exists only as proposed schema in
   `DESIGN-self-maintaining-pipeline.md:1649`; the digest is enforced today only by
   `SealedScorerGate` re-resolving the image at score time.

## 6. TWO THINGS FOUND IN PASSING, NOT FIXED

- **A design-only outcome blames the builder for a turn it never got.**
  `orchestrator.ts:4379` and `:4533` return a design-segment outcome with no build turn run;
  both then hit the `!selfReportWritten` guard at `:2378` and report *"the builder never
  wrote its self-report"*. The repair is a distinct failure sentence at each, **not** a
  self-report written by the design seat — a `done` from a segment that wrote no application
  code would clear the guard and let the gate score an unbuilt workspace.
- **`runner.ts:417` still hand-types the status triple** for the bakeoff harness's own
  builder prompt. Harmless today (that prompt is single-turn and carries the shape), but it
  is the fifth copy. Deduplicating it is a `bakeoff/src` edit — bundle it with the digest
  move above rather than spending one on it.

---

## 7. GATE, MEASURED AFTER EVERY CHANGE IN THIS SESSION

| leg | baseline (before first edit) | after |
|---|---|---|
| bakeoff | 164 / 164 | **181 / 181** (+17: rules 4 and 5, the env-name binding, falseFinish truth table) |
| server | 1975 / 1972 pass / 0 fail / 3 skip | **1982 / 1979 / 0 fail / 3 skip** (+7: self-report contract, agentDeclaredDone arm check) |
| client unit | 224 | **224** |
| client browser | 280 | **280, twice consecutively** |
| tsc | exit 0 ×3 | **exit 0 ×3** |

Both suites and both client projects were re-run *after* the `bakeoff/src` edit, not only
after the dashboard one.

**Scorer digest: MOVED, deliberately.** `spec-validate.ts` and `spec-validate.test.ts` are
inside `COPY src ./src`. The image must be rebuilt and the calibration and run-1 baseline
re-scored before the next graded run is comparable to the old ones. Item 1 alone would have
left it untouched; rule 4 spends it.

**Not attempted:** plan item 4, the re-run. It is a 3 h 18 m spend and it should follow the
answer to §5's first open question, not precede it.

**Files changed**

```
dashboard/server/src/build-prompt.ts        selfReportSection(), SELF_REPORT_STATUSES, both call sites
dashboard/server/src/build-prompt.test.ts   the round trip, 5 new tests + 1 arm check
dashboard/server/src/orchestrator.test.ts   agentDeclaredDone exposed + the first test that it reaches TRUE
bakeoff/src/spec-validate.ts                RULE 4: unstatedEnvContractFindings(), statesToken()
bakeoff/src/spec-validate.test.ts           9 new tests, 5 negative controls + the APP_ROOT regression
bakeoff/src/report.test.ts                  deriveFalseFinish truth table — the firing row was never asserted
```

---

## 8. THE SEVEN, ADJUDICATED — DO NOT RE-RUN YET

Seven agents, one per unmet criterion, reading the artefact, the frozen suite and the
scorer's own `result.json`. **Three of the seven are grader defects. The verdict was not
earned, and a re-run today reproduces all three.**

| criterion | verdict | mechanism |
|---|---|---|
| REQ-010 | **GRADER** | `APP_ROOT` unset → test searched `/opt/bakeoff-scorer`, died before its first request |
| REQ-011 | **GRADER** | same test, same line, same cause |
| REQ-022 | **GRADER** | `leafFor` needs a childless element; the heading carries the SVG underline the ticket asked for |
| REQ-016 | grader-ish | same `children.length === 0` heuristic, different assertion |
| REQ-015 | genuine | `text-transform: uppercase` → `innerText` is `TEEWISE`; `toContain("Teewise")` is case-sensitive |
| REQ-017 | genuine | same mechanism |
| REQ-021 | genuine (medium) | artefact's own 6/min absolute-window limiter; the node pass spent the quota, the browser pass got 429 |

### REQ-010 / REQ-011 — no artefact could have passed

`holdout/contact-storage.test.mjs` resolves `process.env.APP_ROOT ?? <walk up from cwd for a
package.json>`. **Nothing in the harness sets `APP_ROOT`** — after this session's correction
the only matches in `bakeoff/src`, `bakeoff/docker` and `dashboard/server/src` are in
`spec-validate.ts`. The node pass runs with cwd `/opt/bakeoff-scorer`, which has its own
`package.json`, so the walk stopped in the scorer's install directory. From the scorer's
recorded output:

```
no SQLite database holding a contact-message table was found under /opt/bakeoff-scorer;
0 database file(s) were examined
    at locate (file:///scorer/suite/holdout/contact-storage.test.mjs:58:10)
```

Both tests died on their **first statement**. The artefact's contact handler was never
invoked. Its rejection path and its SQLite table are both present and correct.
**Fix: set `APP_ROOT=/artifact` in `suiteEnv`** (`scorer-container.ts`), one line.

### And this rule shipped with the same blind spot for one draft

`APP_ROOT` was in rule 4's `HARNESS_ENV_NAMES` allowlist, on the strength of a comment
asserting the container injected it. It does not. **The allowlist exempted precisely the
variable whose use cost two criteria** — the rule would have been silent on the one suite it
had something to say about. Corrected, and pinned by a test named for the run.

Fire rate before the correction: 0/3, and meaningless. **After: 1/3, and the one it fires on
is the mis-graded suite.**

### The systemic cause behind the four browser-side failures

From the builder's own `build.log`:

> **Chromium cannot launch in this sandbox** (mach port permission denied), so I never saw
> the site rendered.

It verified the 10 node/API visible assertions through a `fetch` shim and could not execute
either of the two `.spec.mjs` files it had been handed. So **every browser-side criterion was
built blind** — and the scorer's coverage confirms the consequence: REQ-015 and REQ-017 are
`2 of 2 asserting test(s) failed`, i.e. the **visible twin failed too**.

That kills the overfitting hypothesis in §2 — only REQ-016 has the visible-pass/holdout-fail
shape. The builder did not overfit to the visible half; it could not run the visible half.
**This, not an env-var contract, is the real "one cause behind the browser failures"** the
fix agent was reaching for.

### What this means for the plan

Item 2 remains unjustified. The pre-run list is now concrete and cheap:

1. `APP_ROOT=/artifact` in `suiteEnv` — recovers REQ-010 and REQ-011.
2. Decide on the `children.length === 0` probes (REQ-016, REQ-022) — they fail a correct
   artefact for having a decorative child the ticket asked for.
3. Give the builder a way to see a rendered page, or stop grading rendered text it cannot
   check. Four of seven criteria turn on this.

Only after those is a re-run measuring the builder rather than the harness.

---

## 9. THE PRE-RUN WORK, DONE — AND THE ONE THING THAT IS NOT MINE TO DO

### 9.1 `APP_ROOT` is now set (recovers REQ-010, REQ-011)

`suiteEnv` sets `APP_ROOT = /artifact`. The fixture's `?? <walk up from cwd>` fallback is
left alone deliberately: the fix makes the documented name TRUE rather than making the suite
depend on it.

### 9.2 The allowlist is asked, not copied

Rule 4's exemption list was hand-maintained, and that is how it came to excuse `APP_ROOT`.
It is now derived from **one declaration, `SUITE_ENV_NAMES` in `scorer-protocol.ts`**, which
`suiteEnv` asserts itself against at run time (`assertSuiteEnvNamesAgree`) — the same shape
as the existing `assertSuiteManifestPathAgrees`.

**It lives in `scorer-protocol.ts` because of a measured constraint, not taste.** The first
attempt had `spec-validate.ts` import `scorer-container.ts` and ask it directly. That broke
three test files: importing the container module outside the seal throws
`assertRunningInsideSealedContainer` — *"the Tier-0 gates were invoked outside the sealed
scorer container"*. The authoring path structurally cannot ask the container anything. The
declaration moved to the module both already share.

Rule 4's fire rate is **0/3 again, and now that is the true answer**: `APP_ROOT` is exempt
because it became real, not because it was re-listed. The arm that survives is
`A NAME THE CONTAINER DOES NOT SET IS NEVER EXEMPT`, which fires on a harness-shaped name
nothing supplies.

### 9.3 RULE 5 — the shape-heuristic probe (REQ-016, REQ-022)

A held-out browser test that locates its subject with `children.length === 0` and then
reports the property it was going to measure as failed, having never measured it. Advisory,
four negative controls (locate-by-text, visible half, node-test, comment-only).

**Fire rate 1/3, and it names exactly the two files that cost the two criteria:**
`holdout/motion-a11y.spec.mjs` and `holdout/site-content.spec.mjs`.

### 9.4 THE BUILDER'S BLINDNESS IS A POLICY, NOT A BUG — OWNER'S CALL

Four of the seven failures are browser-side, and the builder never saw a rendered page. That
is not an accident to repair. `claude-builder.ts:1005`:

> *"A BUILD KEEPS NONE OF THIS. It writes code in a workspace; it has no business deploying,
> **driving a browser**, or spawning a remote agent."*

`allowedMcpServers: []`, `allowManagedMcpServersOnly: true`, and the OS sandbox denies the
mach ports Chromium needs.

**CORRECTION, and it is mine.** An earlier draft of this section said "the seal exists so a
prompt-injected builder cannot reach the network". **That is false, and the repo had already
measured it false.** `buildOptions` sets no `sandbox.network` clause at all
(`claude-builder.ts:1010-1035`), and `orchestrator.ts:701-712` records the disproof *by
execution* — six `gemini-image.sh` calls from inside a sandboxed build reached
`generativelanguage.googleapis.com` — which is why the run record's own label is
`"unrestricted-host-network (NOT a measured denial)"`. The seal that is real is the
filesystem (`allowWrite` / `denyRead`), the managed-settings locks and MCP removal. **A
renderer fix trades none of that away**, so the security objection I raised does not apply. Three options, none free:

1. **Leave it.** Accept that rendered-text criteria grade something the builder could not
   check. This run's REQ-015 / REQ-017 are what that costs — `text-transform: uppercase`
   makes `innerText` `TEEWISE`, and the builder had no way to discover it.
2. **Stop grading what the builder cannot see.** An audit rule refusing to freeze a
   rendered-text criterion while the build lane is browser-less. Keeps the seal; weakens the
   grader; arguably the honest pairing with (1).
3. **Give the builder a sealed renderer.** A screenshot-only service with no egress, inside
   the existing network boundary. Most work, and the only option that lets a build satisfy
   the ticket's visual half on purpose rather than by luck.

Until one is chosen, a re-run still cannot pass REQ-015 or REQ-017 for any reason the builder
controls.

---

## 10. FINAL GATE

bakeoff **181 / 181** · server **1982 / 1979 / 0 fail / 3 skip** · client unit **224** ·
client browser **280, twice consecutively** · tsc **exit 0 ×3**.

Re-run in full after the last `bakeoff/src` edit, not only after the dashboard ones.

**Scorer image: still not rebuilt, and that is deliberate.** The source has changed, so the
next `docker build` will produce a new digest — but nothing in the run path rebuilds, the
drift check only fires mid-campaign, rule 4/5 run in-process via `bakeoff/dist`, and
`falseFinish` is derived in the scorer from a value the orchestrator supplies. **Both fixes
take effect on the next run with the image untouched, so the calibration and the run-1
baseline stay valid.** Rebuild only when something in the scorer's own execution path needs
it, and re-score the baseline when you do.

---

## 11. THE RENDERER: MEASURED, NOT SHIPPED

The owner chose option 3 (a sealed renderer). Scoping found the SDK knob that is meant for
exactly this — `sandbox.network.allowMachLookup`, documented verbatim as *"Needed for tools
that communicate via XPC such as the iOS Simulator or **Playwright**"* (SDK 0.3.220,
`sdk.d.ts:6169-6171`) — and, importantly, `restrictsEgress` (`orchestrator.ts:760`) reads only
`deniedDomains` / `allowedDomains` / `strictAllowlist`, so adding it would leave the run
record's honest `unrestricted-host-network` label untouched. It looked like a four-line change.

**It was probed rather than shipped, and it does not work yet.** Two arms, same sandbox
config as `buildOptions`, a real `chromium.launchPersistentContext` inside the workspace:

| arm | `allowMachLookup` | Chromium |
|---|---|---|
| control | absent (today's config) | **fails** |
| fix | present, 10 service prefixes | **fails** |

The control failing is the negative control working — it confirms the premise. The fix
failing means the service set is wrong or the blocker is not mach lookup. Chromium emitted no
browser log, which points at it dying before it could write one.

Two probe defects were caught and fixed on the way, both the catalogued shape: an ESM import
error made both arms die before reaching `chromium.launch` while the verdict logic reported
"NOT SOLVED", and a `--user-data-dir` arg Playwright rejects outright. A probe that reports a
conclusion it did not measure is the thing this project exists to stop, so the verdict now has
an explicit INCONCLUSIVE state.

**Not shipped, deliberately.** A `network` clause added on a guess would be
`restriction-configured-but-unmeasured` — the exact label the codebase already keeps for that
situation. Next step is to capture Chromium's stderr from inside the sandbox and widen the
service set from the real denial, not from a plausible list.

### What was done instead, and it is not nothing

`fix-prompt.ts` told the fix seat, on **every** visual failure, that *"the way to check a fix
is to serve the build, open the flow named above at the breakpoint named above, and look at
it."* Both halves are impossible: `listen()` is denied and Chromium will not start. A seat
that follows it spends a round discovering the environment forbids its instructions.

It now says so plainly, offers the technique that does work (the `global.fetch` shim over the
real router, which is what the last run's fix seat actually used), and names the two defect
classes a source-only review misses unless told to look for them — **image geometry**
(`height: auto`) and **`text-transform` changing what `innerText` returns**. Those are the two
mechanisms behind REQ-015, REQ-017 and the owner's stretched illustrations.

## 12. DEFERRED, WITH THE SCOPE MEASURED

**Visual gate out of shadow.** Shadow is the fallback constant
`DEFAULT_VISUAL_SUBSTANCE_MODE = "shadow"` (`visual-substance.ts:692`), reached because
`visualGateInputFor` builds its input without a mode. Flipping it alone would print
"MODE: GATING" over a check that still cannot fire — the exact failure `verdict.ts:64-72`
already records for 2026-07-30. And **no existing observation could detect a stretched
image**, so un-shadowing would not have caught the owner's defect. A new aspect observation
needs a scorer-protocol bump, a container rebuild, a full recalibration, and a formulation
that returns a sign rather than a distance (the module rejects invented thresholds by policy).

**Chat-iterate.** Already specified and deliberately unbuilt —
`FINDINGS-2026-07-30-canvas-asks.md:607-634`, closing *"Not built. Out of session room."* The
correct shape is a **follow-up run**, not a reopened one: re-entering a terminal run would
overwrite `heldOutPass`, `falseFinish`, the scorer-out archive and the screenshots, all keyed
by run id. The one real gap is that `POST /api/runs` cannot seed a workspace from a finished
run — no parent argument, no lineage column. Scope: one new `run-seed.ts`, a `parent_run_id`
column, three touched files and a composer change. **Flagged so it is not discovered late:**
the follow-up publishes to `projects/<slug>-<suffix>`, so the folder the owner has open keeps
serving the *parent* artefact after a revision lands.

---

## 13. AND I SHIPPED THE SAME DEFECT INTO A TICKET, 90 MINUTES IN

Composing the follow-up run's brief, I reused the owner's original words and deliberately cut
the dashboard-generated appendix — a motion reading and a planning exchange — because
resubmitting a system's own output as a fresh brief is feeding it its own tail.

The brief referred to that appendix twice:

```
line  29  "A reading of a reference page's motion is attached to this ticket. Match it…"
line 111  "The motion matches the attached reading…"
```

Nothing was attached. **A forward reference to nothing — the same shape as
`resumeBuilderPrompt`'s "as described earlier", in the artefact I had just written.** The
spec seat authors criteria from the ticket alone, so it was on course to freeze a criterion
no artefact could satisfy and no grader could fairly check: exactly the class of grader
defect §8 spent its time removing, manufactured fresh.

`run-…-dfd5a050` was cancelled at 93 minutes, mid-audit, and resubmitted as
`run-…-0629aa6c` with the measured values inlined so the requirement stands on its own.
Ninety minutes of night is cheaper than a verdict contaminated by an unpassable criterion,
and the night had hours left.

**The composer now refuses rather than trusting me.** It throws if the motion clause is not
found verbatim before substituting, and it walks every remaining `attached…` reference,
throwing on any that does not resolve to something actually in the request. Two attachments
survive that check — the CV and the design reference — and both are really sent.

**The lesson generalises past this ticket.** Every mechanism in this repo that binds two
seats to one literal exists because prose drifted from reality. The ticket is prose, it is
the input every other seat is derived from, and it had no such check at all. A brief that
promises an attachment should not be submittable without it.

---

## 14. THE BOTTLENECK IS NOT THE GRADER — HALF THE RUNS NEVER REACH ONE

Measured over every run this machine has recorded, not sampled:

| run | outcome | died in | cause |
|---|---|---|---|
| 07-29 23:28 | **passed** | — | — |
| 07-30 13:31 | failed | spec | operator abort ("aborted by user") — not a defect |
| 07-30 20:16 | failed | gate | suite did not go green |
| 08-04 11:08 | failed | spec | output ceiling: "exceeded the 64000 output token maximum" |
| 08-09 21:04 | failed | spec | `suite_not_audited` — `dataExpectations[0].id must be a non-e…` |
| 08-10 13:11 | failed | gate | suite did not go green |
| 08-10 20:38 | cancelled | spec | my ticket bug (§13) |
| 08-10 22:10 | failed | spec | `suite_not_audited` — `[vacuous] … contains a "not implemented" marker` |

**Four of eight completed runs died in the spec phase. Only three ever produced a verdict.**

### But two of those four are already answered, and saying otherwise would overstate it

- **08-04** is the 64,000-token ceiling. The ceiling is now 128,000 with a free truncation
  retry, and tonight's failure log confirms both are live: *"Output-token ceiling by attempt:
  1:128000 2:128000 3:128000. The free truncation retry fired on attempt(s) 1, without
  consuming an attempt."*
- **08-09** is the `dataExpectations` shape — postmortem §3's instance one. The fix (show the
  seat the manifest shape in its prompt) worked by prevention on 08-10: *"not one
  `dataExpectations` error in either draft."*

So the honest count of live, unexplained authoring failures is **one — tonight's.**

### What tonight's actually is, and why "try again" was the right call and not a shrug

Three checks, each of which could have changed the answer:

1. **Suite size?** No. The run that SUCCEEDED emitted a *larger* suite — 25 criteria across 13
   files — than the one that failed (24 across 8). Capacity was not the constraint.
2. **Was the seat told?** Yes, twice over. `spec-agent.ts:304` forbids `"not implemented"`
   anywhere in a test file, and `blockingFindingSummary` feeds the finding back into every
   regeneration prompt.
3. **Did my new rules cause it?** No. All three are `advisory`, so they cannot set
   `mustRegenerate`, and the same summary filters them out before the seat sees them.

### The hypothesis worth testing next, stated as a hypothesis

The prohibition tells the seat what **not** to write and never what to do **instead**. A seat
that cannot finish its last file has two options — stub it, or author fewer files — and only
one of them is forbidden. `dataExpectations` was fixed by *showing the seat the right shape*
rather than by forbidding the wrong one, and that is the same move available here: "if you
cannot complete every file you planned, plan fewer files; a stub is the one thing that
guarantees the suite is thrown away."

**Not implemented tonight, deliberately, for a reason that matters more than the fix:** a run
is in flight and the spec seat loads `AUTHORING_SYSTEM_PROMPT` from `bakeoff/dist` at call
time. Rebuilding the harness mid-run would change the instructions between one attempt and
the next — mutating the experiment while it is running. It waits for a quiet tree.

### What this means for the plan

The plan's phases 1–3 all assume a run reaches a verdict and argue about whether that verdict
is right. **Half of them do not get there.** Phase 1's work stands — `falseFinish` was
genuinely disarmed and is now armed — but the next measurement worth having is not a better
grader. It is a spec phase that freezes on the first or second attempt rather than the third.
