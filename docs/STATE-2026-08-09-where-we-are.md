# WHERE WE ARE — measured 2026-08-09, HEAD `3d01c2c`, clean tree

Written to answer one question, verbatim from the owner: *"I want you to tell me
where we are now. What is still left to do before we go give it a task and it
successfully does it in the background. animations and all."*

**"Successfully does it in the background" is read here as two things, not one:**
the run reaches a verdict unattended, AND the verdict can be trusted without
re-reviewing the work by hand. The second half is not a nicety — it is the whole
stated purpose (`docs/HANDOVER.md` §1: if the grader can be fooled, the tool saves
nothing). A run that finishes and hands you a number you have to go check yourself
has not succeeded. Both halves are graded below, separately.

**Every number carries the shell command that produced it.** Where something could
not be measured it says UNMEASURED and why. Nothing is transcribed from
`docs/HANDOVER.md` (2026-07-30), `docs/STATE-2026-08-02-end-to-end.md` or
`dashboard/STATUS.md` — all three lag the tree by 104 commits and are corrected in
place below.

> ### CORRECTION PASS, 2026-08-09 — read this before quoting anything
>
> This document was reviewed by two independent critics after it was first written.
> **Their findings are applied in place, each at the section it touches, in a dated
> `CORRECTED 2026-08-09` block.** Nothing was silently overwritten and no finding was
> deleted for being inconvenient. Three of the corrections reverse a headline claim:
>
> 1. **§3-B's ranking is inverted from the first draft.** The old B1 (held-out
>    contamination) claimed the *direction of harm* backwards. Merging the visible half
>    into the scored set can only ADD failures — it makes the gate **harsher**, never
>    more lenient — and the one channel that could be lenient is refused at freeze time
>    and is empirically absent on both tickets on this machine. It is a real
>    labelling/reporting defect, not the thing that can make a green verdict false, and
>    it is demoted. **Renumbering, so old references still resolve: old B2 (gate on a
>    moving workspace) is now B1; old B1 (held-out labelling) is now B2; old A3
>    (criteria provenance) moves out of section A and becomes B3; old B3→B4, B4→B5,
>    B5→B6, B6→B7, B7→B8.**
> 2. **The flagship "28/28 held-out green" was itself the merged number** — the exact
>    thing the old B1 complained about, applied to this report's own headline. Measured
>    from the scorer's own report rather than by grep, it is **28 total = 17 held-out +
>    11 visible**. Restated everywhere below.
> 3. **The re-scored workspace is NOT the workspace that was gated.** 2 files and
>    1,123,061 bytes were staged on 2026-07-31 and are absent today. The first draft
>    called that tree "untouched" and said "the bytes are the same ones". Both were
>    wrong. The published DID-NOT-PASS is *unreproducible*, which is a stronger argument
>    for the same fix — but it is not the "inverted verdict" the first draft asserted.
>
> A fourth class of correction is worth naming on its own: **two of the critics' hits
> are this repository's signature defect — "a check that can only observe success" —
> occurring inside this report rather than in the tree.** §2.2's motion "negative
> control" varied the fixture as well as the status, and §5-8 declined to prove the
> client unit suite could go red for a reason that §2.1 had already disproved. Both are
> corrected below and both are the report's own fault.

> ### FIX PASS, 2026-08-09 — written after the correction pass, by four lanes, a verifier, two reviewers and a repair pass
>
> **The tree is no longer the tree this document measured.** Twenty-nine tracked files
> are modified and nine are new, in the working tree, uncommitted (`git status --short`
> → 29 `M` + 9 `??`; `git log --oneline -1` → `3d01c2c`, unchanged).
> *(Grew to **35 `M` + 10 `??`** in the second pass — see the size line at the end of the
> SECOND FIX PASS note below. `3d01c2c` is still HEAD; nothing has been committed.)* **Every item below
> that closed carries a dated `FIXED 2026-08-09` note at its own heading, with the file
> changed and the test that now covers it. Nothing above was deleted** — the history of
> what was wrong is the point of the document, and an item's original text is still the
> best description of the defect.
>
> **THE ONE RULE THAT SHAPED EVERYTHING: `bakeoff/src` WAS NOT TOUCHED. NOT ONE BYTE.**
> `git status --short -- bakeoff/src` → **empty**. Any edit there — including an edit the
> scorer never executes — moves the scorer image digest, and the digest is the trust
> chain: it is what makes the calibration, the dry run and the one reproducible PASS
> mean anything. Confirmed intact at the end of the round:
> `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` →
> `sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8`, inspected
> three times including immediately after a harness run that starts four scorer
> containers, identical every time; and run 1 re-scores `heldOutPass=true`, 21 total /
> 20 passed / 1 failed, sole failure `REQ-013` QUALITY — the published numbers exactly.
>
> **THEREFORE CARRIED FORWARD, DELIBERATELY, NOT DROPPED — all four:**
>
> | Carried | Why it was not fixed |
> |---|---|
> | **B2** — held-out labelling | The metric lives in `bakeoff/src`. Frozen. |
> | **B4** — the visual gate cannot fail a run | All four blockers live in `bakeoff/src`. Frozen. |
> | **B3** — the plan seat on the background path | Not frozen, but **more load-bearing after this round, not less**: the unattended submission now genuinely SKIPS the plan phase (Appendix R2), so the criteria come from the raw ticket alone. This was a decision to take, and the decision taken is "write the ticket like it is the only input". |
> | **The quiescence walk** (B1's expensive half) | Only the cheap half (5b) landed. The 5b guard is **file-presence only and would not have refused `…052c6e02`**, whose `self-report.json` is stamped 10:14 against a `server.mjs` at 10:16:27. |
>
> **What landed, in one line each.** A1 (a refusal is parsed for a reset, and a refusal
> that names none is HELD for a bounded chosen 5 h instead of parking forever), A2 (the
> spec/judge model is pinned to a literal with a measured 128k ceiling), 5b (the sealed
> gate refuses to score a builder that never wrote a self-report), B5 (five seat call
> sites now write the spend ledger, and the fix round MERGES instead of overwriting),
> B6 (`npm test` can signal again), B7 (the blank run page), C1+C2+C3 (the preview link
> answers in zero hops and renders styled, with a test that can observe both failures),
> C4 (the conduit is legible at the default zoom), C5-1/2/3/5.
>
> **What did NOT land, and is not claimed to have:** **B8** is not closed — B8a and B8b
> landed, B8c is PARTIAL (its fixture is fixed and the harness now runs 31/31, but it
> is reachable from no documented command), and **B8d produced zero edits**: nine
> ordering-vacuous browser guards remain. **C5-4 and C5-6** were not attempted and are
> declared NOT-DONE by their author. See each item.
> *(All three of those sentences were falsified by the second pass: B8d's nine were
> examined and eight fixed, C5-4 landed, C5-6 landed by half and was refused by half with a
> measurement. B8c is unchanged. Dated corrections sit at each item.)*
>
> **ONE THING THE OWNER MUST RATIFY, NOT A DEFECT.**
> `dashboard/tests/run-layout.browser.spec.ts` **inverts a contract** rather than
> renaming a test: `"/runs is still capped and centred at 2000px"` became `"/runs uses
> the whole window at 2000px"`. No test was lost and the composer's measure is now
> asserted directly on the route that has the composer — but the product behaviour
> asserted is the opposite of `3d01c2c`'s. That is a taste call and it is the owner's.
>
> **A LANE'S SELF-REPORT IS NOT A MEASUREMENT.** Where a number appears below it is
> attributed: the verifier's and the final check's figures are the measured ones, and a
> lane's own claim is marked as the lane's claim.
>
> **HOW TO FIND TODAY'S CHANGES IN THIS FILE.** This document is itself **one of the ten
> untracked files**, so `git diff` shows you nothing and the review UI presents all ~3,530
> lines as new. What the two fix passes added is findable by marker string, and nothing else
> was altered:
> ```
> grep -n 'FIX PASS, 2026-08-09\|FIXED 2026-08-09\|PARTLY FIXED 2026-08-09\|HALF FIXED 2026-08-09\|RENUMBERED 2026-08-09\|CORRECTED 2026-08-09 (fix pass)\|(second pass)' docs/STATE-2026-08-09-where-we-are.md
> ```
> **`(second pass)` is the marker for today's later round** and every one of its edits
> carries it. New sections across the two passes: **§4's RUN RECIPE**, **§4b WHAT A GREEN
> VERDICT WILL AND WILL NOT MEAN**, **§6's CARRIED FORWARD BY THE FIX PASS** and **§6's
> CARRIED FORWARD BY THE SECOND FIX PASS**. Everything bearing a plain `CORRECTED 2026-08-09`
> marker (without "(fix pass)" or "(second pass)") is this morning's correction pass and was
> not touched.

> ### THE REPAIR-DRIVER ROUND, 2026-08-10 — NEWEST ROUND. IT IS ALL IN §9, AND IT IS NOT COMMITTED
>
> A fourth round ran on 2026-08-10 **beside a live run** (`run-2026-08-10T13-11-12-836Z-54927ebc`,
> unharmed and progressing throughout): three lanes, a verifier, a reviewer and a repair pass. It
> wired the repair driver into the boot path, gave the boot line four honest states instead of two,
> built the gate-verdict seam that is the only thing in the tree that writes a patch, added the
> morning readout route and a sixth strip liveness, and carried the owner's attachments onto a
> ticket. **Everything it produced is in §9; §9.3 is the checklist and §9.4 is what needs you.**
>
> **THREE SENTENCES BEFORE YOU QUOTE ANY OF IT.**
> 1. **`HEAD` IS STILL `70a91cf` AND NOTHING WAS COMMITTED.** The live run forbade docker, both
>    dev ports, `npm run build` in `dashboard/server` and `bakeoff`, and any write to `runs.db`.
>    **So the entire client half — client unit and the full browser suite — was NOT RUN**, and
>    `dashboard/src/components/supervisor-strip.tsx` has zero executed tests. §9.3 names exactly
>    what must run first. **Nothing here may be committed on the strength of this round.**
> 2. **THE RUNNING SERVER TONIGHT DOES NOT HAVE THE DRIVER.** It is `node dist/index.js` and
>    `dist/` was not rebuilt (`grep -c armRepairDriver dashboard/server/dist/index.js` → **0**).
>    Tonight still prints `NO REPAIR DRIVER is wired`. The driver arms at the next rebuild — which
>    is a decision (§9.4 item 2), because of the next sentence.
> 3. **THE GATE CAN SAY `APPLY` WITH ITS CONTAINER ARMS UNABLE TO RUN.** Measured on the real
>    `runGate()`, `containerExecuted 0`, real 64-hex token. Bounded tonight only because `dist/` is
>    pre-round and `dashboard/data/repair-proposals` does not exist. **Keep that directory empty
>    and do not rebuild `dist` until §9.4 item 1 is settled** — and it is a policy question, not a
>    bug fix, because a green test pins the current behaviour.
>
> **THE HONEST HEADLINE, unchanged from the round before it in the one place that matters:** the
> repair cycle **still has never fixed a real defect**, and the container arms of the Tier 3 gate
> **have never run during a repair**. What changed is that a structural failure now terminates with
> the cycle's own reason (`NO_PATCH_AUTHOR`, naming the path a diff must be written to) instead of
> *"nobody wired a driver"*. §9.5 is unflinching about the rest.

> ### THE STRIP-CRASH / STILL-PARKS ROUND, 2026-08-10 — SUPERSEDED AS NEWEST BY §9; IT REWRITES §7.2
>
> A fourth round ran on 2026-08-10, after the tag: **two lanes (`strip-crash`, `still-parks`), a
> final gate, a repair pass and a final go/no-go.** It exists because the owner wants to start a
> run that survives eight hours unattended, and two things blocked it — the dashboard was
> reported crashed, and the supervisor still parked in ways that need a human.
>
> **THE FOUR STAGES DISAGREED WITH EACH OTHER, AND THE ORDER IS THE POINT.** A lane's
> self-report is a claim; the gate's and the final check's figures are the measured ones.
>
> | stage | verdict | what it measured |
> |---|---|---|
> | the two lanes | LANDED / one PARTIAL | their own suites. `strip-crash`'s first act was to falsify its own brief: the crash was already gone and the browser project was already **267 passed / 1 skipped**, not 80 failed / 186 passed. |
> | the final gate | **`gatePassed: false`** | one blocking item, and it was real. Against the **owner's own backend** the strip read amber `MALFORMED` on every route, because the client mirror and the shipped wire disagreed in **fifteen fields**. Three green typecheckers could not see it: `dashboard/src/lib/api-types.ts` declares its own `SupervisorState` and never imports the server's `ApiSupervisorState`. |
> | the repair pass | closed it, and found three more | rewrote the client mirror onto the wire and **pinned it from both ends** with a generated golden fixture, then closed a second blank-page path, a newly-live rendering path with no probe, and the model-id refusal. |
> | the final go/no-go | **GO, and it re-measured the gate's blocker as CLOSED** | live `idle` on four routes against a real server, and live **`running`** — green pill, `spec · attempt 1 of 1`, `QUIET 38.8s` — with a real run in flight. |
>
> **So the gate's blocking item is STALE, and the owner is reading both reports: it was measured,
> it was real, and it is fixed.** Read **§7.2** (rewritten from the final go/no-go) before you
> leave the machine, **§8** for the round, and **§6.14-§6.16** for what is carried forward.
>
> **THE MEASURED NUMBERS, which are the ones to commit on — the brief's were wrong in both
> directions:** bakeoff **164 / 164**; server **1961 tests / 1958 pass / 0 fail / 3 skipped**;
> client unit **199**; client browser **273 passed / 1 skipped, TWICE CONSECUTIVELY, identical
> leaf-name sets, 33 spec files**; `tsc --noEmit` **exit 0 with zero diagnostic lines in all
> three packages**. Baseline chain: **259 (tag) → 271 (gate) → 273 (now), ZERO leaf names
> removed** anywhere. The re-score reproduces exactly (`heldOutPass=true`, `falseFinish=false`,
> 21 total / 20 passed / 1 failed, sole failure `REQ-013` QUALITY) under a **re-resolved**
> `bakeoff-scorer:1` = `sha256:027bc2e2d3d27eeee8d050995995959d834575441a8aaeafe50565a388cfe8a0`.
> **The brief's `ec79e1efbe81…` is a stale transcription, not a deviation** — that image is now
> tagged `bakeoff-scorer:pre-repair-2026-08-10`, a fourth rollback rung. **The brief's other
> baselines were also wrong** (bakeoff 143 → measured 146 at the tag; client unit 168 → 171; and
> its "one known pre-existing server failure", *"THE OWNER'S OWN runs.db OPENS AND KEEPS ITS
> RUNS"*, **passes**).
>
> **THE HONEST HEADLINE:** the strip can now tell a working loop from a wedged one against the
> real backend, and a ticket whose failure has no automatic repair reaches a **named terminal
> state in one tick** instead of parking for ever. **Nothing here has yet run during a real
> build-to-verdict, and the repair cycle has never fixed a real defect in production** — no
> driver is wired into `index.ts`, nothing authors a patch, and there is no sandbox. §8.4 and
> §7.3 are unflinching about which is which.
> *(**CORRECTED 2026-08-10, repair-driver round:** a driver IS now wired into `index.ts` in source —
> the running `dist/` still is not. The other two clauses stand: **nothing authors a patch and there
> is no sandbox**, so the repair cycle still has never fixed a real defect. §9.1, §9.5.)*
>
> **Marker for this round's edits, and nothing else in this file was altered:**
> ```
> grep -c 'strip-crash round\|STRIP-CRASH / STILL-PARKS ROUND\|^## 8\.\|^### 8\.[1-6]\|^#### 6\.1[456]' \
>   docs/STATE-2026-08-09-where-we-are.md
> → 29   # this pointer, §6.14-6.16 and their parent heading, the twelve dated blocks and corrected
> #        rows inside §7.2 and §7.3, §8 and §8.1-8.6, and this line. MEASURED, not predicted: the
> #        first pattern written here matched 11 of these 29, because the round's name is
> #        "STRIP-CRASH / STILL-PARKS" and its in-place markers are lower-case. A marker is itself a
> #        check that can only observe success until you run it.
> ```
> **AND THE TWO RECORDED MARKER COUNTS WERE RE-RUN, because a count nobody re-runs is a claim.**
> This file's own count below is **still 13**: this round's headings match none of that pattern's
> alternatives and this block avoids its literals, deliberately. **The DESIGN file's count was
> ALREADY WRONG BEFORE THIS ROUND — recorded as 14 below, measured 15**, so a reader who trusted
> it would have concluded a block went missing. This round's DESIGN blocks are headed `MEASURED
> 2026-08-10 (strip-crash round)` / `SUPERSEDED 2026-08-10 (strip-crash round)`, neither of which
> is one of the five literals that count matches, so **15 is still the number after this round.**

> ### THE NEVER-STOP ROUND, 2026-08-10 — START HERE IF YOU ARE ABOUT TO LEAVE IT RUNNING
>
> A third round ran on 2026-08-10 against `docs/DESIGN-self-maintaining-pipeline.md`: five
> parallel lanes, a verifier, a reviewer and a repair pass. It built the supervisor, the
> defect record, the free replay harness, the repair-evidence bar and the Tier 3 gate.
>
> **Everything it produced is in the new §7, and §7.2 is the thing to read.** §7.2 is the
> OPERATOR'S PAGE — how to start it, what appears on screen, what STOP does, and **the
> complete list of ways it can still stop and need you**. If you are about to leave the
> machine for eight hours, read §7.2 and nothing else.
>
> `HEAD` is now **`d32ad85`**, and the repo has its first tag:
> ```
> git rev-parse --short HEAD                      → d32ad85
> git tag -l                                      → gate-verified-2026-08-10
> git rev-parse gate-verified-2026-08-10^{commit}  → d32ad858…   # ANNOTATED tag: use ^{commit}
> ```
> **New marker for this round's edits, and nothing else in this file was altered. The pattern
> was MEASURED against its own output rather than written and hoped for — §R5 is this
> document's own precedent for a locator that matches nothing:**
> ```
> grep -cn 'NEVER-STOP\|never-stop round\|^#### 6\.[678]\|^## 7\.\|^### 7\.[123]' docs/STATE-2026-08-09-where-we-are.md
> → 13    # every block this round added: the pointer above, §6's N5/N7 status, §6.0's third
> #        digest, §6.6, §6.7, §6.8 and their parent heading, §7 and §7.1-7.3, plus this line.
> ```
> The DESIGN file's own marker is different, because its edits are dated corrections rather than
> new sections: `grep -c 'IMPLEMENTED 2026-08-10\|CORRECTED 2026-08-10\|FALSIFIED 2026-08-10\|STATUS
> 2026-08-10\|ADDED 2026-08-10' docs/DESIGN-self-maintaining-pipeline.md` → **14**.
> **The honest headline, before anything else in this document is quoted:** the supervisor is
> now constructed, armed and ticking, the queue can be filled, and the loop survives `kill -9`.
> **No supervisor-submitted run has ever reached a verdict, no defect record has ever been
> written for real, and no repair patch has ever been applied to this repository.** §7.3 is
> unflinching about which is which.

> ### SECOND FIX PASS, 2026-08-09 — three lanes, a verifier, a reviewer, a repair pass and a final gate
>
> **This round closed what the first one left open. It did not close everything, and the one
> item the owner is most likely to want is the one that is refused with a number rather than
> shipped.**
>
> **`bakeoff/src` WAS AGAIN NOT TOUCHED.** `git status --short -- bakeoff/src` → **0 files**.
> `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` →
> `sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8`, inspected three
> times by the final gate including immediately after a harness started four sealed
> `--network=none` containers — identical every time. Run 1 re-scores **21 total / 20 passed
> / 1 failed, sole failure `REQ-013` QUALITY**, and the frozen suite sha in the re-score
> equals `run.heldConstants.acceptanceSuiteSha256` exactly. **The trust chain is intact.**
> **B2 and B4 are still carried, still for the same reason.**
>
> **SUITES — the final gate's numbers, which are the measured ones. A lane's own figure is
> labelled as a lane's.**
>
> | Suite | Final gate | Brief's target |
> |---|---|---|
> | server | **1878 / 1875 pass / 0 fail / 3 skip** | 1870 (predates the repair pass) |
> | bakeoff | **121 / 121** | 121 ✓ |
> | client unit | **168 / 168** | 168 ✓ |
> | client browser | **259 passed / 1 skipped, TWICE CONSECUTIVELY, identical leaf-name sets** | 252 (predates most of the round) |
>
> `tsc --noEmit` **exit 0** in all three packages — and the dashboard one was checked
> **non-vacuous**, because `dashboard/tsconfig.json` now excludes `results`:
> `npx tsc --noEmit --listFiles | grep '/dashboard/tests/'` → 50 files, `comm` against every
> `tests/**/*.spec.ts` on disk shows **zero** spec outside the program. The 3 server skips are
> the live-smoke trio (quota-gated). The 1 browser skip is
> `finished-run.browser.spec.ts:304`'s `test.fixme` and is carried forward, not fixed.
> **NAME LEDGER, because counts hide deletions:** the verifier and the gate each diffed
> extracted leaf-test titles per file against `git show 3d01c2c:<path>`. **ZERO test names
> deleted anywhere.** Seven names absent from the working tree, every one with a same-file
> replacement, every rename justified by a product change (a null retry-after is now held for
> a bounded length; `/runs` is now full-bleed; the rail test's dead `tablist` locator; a
> `refused` that became `warns`).
>
> **1. THE CEILING GUARD IS WIRED — and its first wiring was wrong, which is the more useful
> half of this entry.** `specModelCeilingWarning()` had 7 tests and no caller; it now has
> callers at `orchestrator.ts:6174` and `:6207`, a preflight at `#execute`'s first statement
> (`:2065`), and a chokepoint at `#seat`. A measured-too-small model **refuses at zero
> spend**; an unknown id **proceeds loudly**, keeping the escape hatch open. **Then a reviewer
> found the threshold was the recovery rung (128,000) rather than the start budget** — which
> made eight of the sixteen ids in the table, every Sonnet and Haiku among them, unusable as
> seat models over a rung only a free truncation retry ever asks for. Corrected to
> `ceiling < CLI_DEFAULT_MAX_OUTPUT_TOKENS` (64,000), imported and not retyped. Full account,
> four mutation transcripts and the survived-then-closed M6 at **§A2's second-pass block**;
> the operational consequence is in the **RUN RECIPE**, which used to instruct the owner to
> pick a 128,000 id and to be his own guard. Both sentences were false and are corrected.
>
> **2. THE ANIMATION BAR — TWO OF THREE MECHANISMS SHIP, AND THE BAR IS NOT MET. The reason
> is measured, not asserted.** C5-4 landed (every settled conduit now carries light: bloom 4
> == body 4, primitives exactly `[feGaussianBlur]`, comets 0, animations 0 — light added
> without motion coming with it). C5-6a landed (animated gradient stops; **162 distinct
> `stop-color` values over 301 frames energised, 1 over 30 frames settled** — the negative
> control is what makes it a measurement). **C5-6b, `feTurbulence`, was built in the live DOM,
> measured, and REFUSED**: 216.8 ms against 135.5 at rest, 1497.4 against 703.5 live, with the
> four-arm table and a `stdDeviation`-200 control left **in the tree** at
> `globals.css:585-655`. Three reasons the bar is not met, all from the final gate's own
> instruments: **(a)** `feTurbulence` count is 0 in the production bundle, so criterion 6(b)
> is not met as literally worded; **(b)** the flux is at the **naked-eye threshold at the
> default fit** — a 700 ms mid-sweep frame and a settled frame at 0.51 zoom were
> indistinguishable to two independent readers, and it is the **bloom** (4.81 px effective
> screen width, pinned across the compensated zoom range) that carries liveness there; **(c)**
> the flux has **no isolating cost arm** — the only instrument shown to discriminate here has
> never been pointed at the animation. §2.2 is corrected in place; §3-C5 items 4 and 6 carry
> the full transcripts.
>
> **3. INSTANCE EIGHTEEN IS DEAD — AND ITS REPLACEMENT WAS ITSELF VACUOUS IN A SECOND WAY,
> WHICH IS THE PART THAT MATTERS.** The original defect: `rail.browser.spec.ts` asserted
> `getByRole("tablist", { name: "Run detail" })` and `grep -ran "tablist" dashboard/src`
> returns **nothing** — a locator matching nothing, which no reordering could ever catch.
> The rewrite was verified by reproducing all three of its claimed mutations (verbatim RED for
> each). **Then the reviewer caught the second half:** the replacement was titled *"neither
> one can vanish"* over a docblock claiming *"exactly one of the two surfaces is on screen at a
> time"*, while the mount condition is
> `openPanel === null && notices === undefined` — a **three-state rule asserted as
> two-state**, on a fixture that never reaches the third state. And the third state was a real
> product defect: with the rail shut and a notice up, **there was no Cancel on screen at all**
> — `RateLimitNotice` took no `onCancel` and the action-error path was a bare `<p>`, which is
> verbatim the defect the run chip was reintroduced to close. **The repair fixed the product
> first** (Cancel on `RateLimitNotice`; Cancel on the action-error notice, gated on
> non-terminal status; the false comment at the `hudMounted` site rewritten), **then** narrowed
> the title and added two arms — a rate-limited arm and an action-error arm reached by pressing
> the chip's own Cancel and having it fail. Mutations `M-RL-CANCEL`, `M-AE-CANCEL` and
> `M-HUD-NOTICES` each produced verbatim RED. **Nineteen was not produced; eighteen took two
> passes to actually kill.**
>
> **4. THE VACUITY SWEEP, WITH ITS DENOMINATOR — how many guards were EXAMINED, not just how
> many were bad.** This is a lane's own mechanical sweep; the verifier reproduced six of its
> mutation proofs but did **not** re-run the counts.
>
> - **AXIS 1, ORDERING.** Pattern:
>   `toHaveCount(0)|toHaveLength(0)|not.toBeVisible|toBeHidden()|.not.toContain|toEqual([])`
>   on non-comment lines. **DENOMINATOR: 145 negative assertions across 31 spec files, 125 of
>   them in browser specs.** Final tree: **POS-BEFORE 120 / POS-AFTER-ONLY 20 / NO-POSITIVE 5**
>   (browser-only 109 / 15 / 1).
> - **AXIS 2, DEAD LOCATORS — the axis the ordering taxonomy cannot see, and the one that
>   produced instance eighteen.** For every browser-spec negative, the literal or regex was
>   extracted and grepped against `dashboard/src`, splitting code hits from comment-only hits.
>   **114 examined → 89 helper/testid-based, 14 LIVE-IN-CODE, 6 COMMENT-ONLY, 5
>   ABSENT-FROM-SRC.** Separately the **19 testid-bearing negatives** were checked: 3 flagged,
>   all 3 false positives (template-generated ids). **Zero dead testids.**
> - **THE NINE CITED GUARDS: nine examined, 8 real ordering defects, 7 closed by a reorder or
>   an inserted control, 1 left documented, ZERO vacuous at test level.** Every one of those
>   tests carries a positive control *somewhere*, so the vacuity is **per-assertion**, not
>   per-test. Two of the nine do not reproduce as described: `design-lock:835` went **RED** (its
>   vacuity was a pre-2026-08-05 string, already repaired), and `motion-readout:466` already had
>   its paint assertion first. **A catalogue that says "18 instances" may be counting
>   historical, already-repaired instances alongside live ones.**
> - **PROVEN-CAN-FAIL, verbatim RED captured: 6.** VACUOUS-FIXED: 7. **VACUOUS-LEFT /
>   REGRESSION-ONLY: 8** — guards whose forbidden string exists nowhere in `src` code, so only a
>   human retyping deleted copy can redden them; flagged, not deleted, because deleting loses the
>   tripwire. **NOT EXAMINED TO DEPTH: 4** (`prebuild-lane` `:508`, `:795`, `:842`, `:843`).
>   **OUT OF LANE, counted but untouched: 22** of the 145. The sweep's own first regex was
>   wrong and mis-scored two entries; the numbers above are the corrected run.
> - **Two assertions were ADDED that no brief asked for** (`ticket-redundancy`'s `heading
>   Options` control and `rail`'s `rail-overview` control). Both proven live; both are new
>   commitments the product must now keep.
>
> **5. A PIPELINE GAP THIS ROUND MADE VISIBLE, and it is worth more than any single fix.**
> Mutation proof in the browser suite requires **temporarily editing production source**, which
> collides head-on with "do not touch another lane's file" when lanes run concurrently against
> one uncommitted tree. It worked only because every mutator hashed and `cmp`-restored, and the
> whole-tree `find dashboard/src -type f -exec shasum` figure `11e5e8165f…` was used as a common
> instrument that three independent passes agreed on. **As a standing arrangement it is a
> race.** §6's second-pass subsection (E).
>
> **THREE LANES EACH VOLUNTEERED A FACT THAT MADE THEIR OWN WORK LOOK WORSE, and all three
> reproduced.** The ceiling lane reported a mutation that **survived** rather than quietly
> patching it. The animation lane declared its own first instrument dead and threw out an
> oversized-region measurement before quoting it. The sweep lane contradicted its own brief's
> "vacuous" classification with a measurement. In a document whose recurring subject is checks
> that can only observe success, that is worth recording as the counterweight.
>
> **THE SIZE OF WHAT THE OWNER IS BEING ASKED TO REVIEW, because none of it is committed.**
> ```
> git diff --stat | tail -1
>   35 files changed, 4039 insertions(+), 266 deletions(-)
> git status --short | grep '^??'
>   dashboard/server/src/orchestrator.spec-model.test.ts
>   dashboard/server/src/preview-through-next.test.ts
>   dashboard/server/src/subscription-caller.retry-after.test.ts
>   dashboard/tests/blank-cache.browser.spec.ts
>   dashboard/tests/canvas-presence.browser.spec.ts
>   dashboard/tests/conduit-zoom.browser.spec.ts
>   dashboard/tests/refit-growth.browser.spec.ts
>   dashboard/tests/relative-time.unit.spec.ts
>   dashboard/tests/run-chip.browser.spec.ts
>   docs/STATE-2026-08-09-where-we-are.md
> ```
> **HEAD is still `3d01c2c`. Nothing has been committed, pushed, amended, stashed or reset.**
> The 35 modified files include four test files whose leaf-test **titles changed**; a reviewer
> diffing test names will see churn that is **accounted for, not drift** — the name ledger
> above justifies all seven renames and confirms **zero deletions**.
> Read that stat correctly: **the 4,039 insertions do NOT include the ten untracked files'
> contents at all** — `git diff --stat` never sees an untracked file — and this document is one
> of the ten, so the true review surface is those 35 modified files **plus ~6,120 lines of new
> file** (`git status --short | grep '^??' | awk '{print $2}' | xargs wc -l | tail -1` → 6,123
> at the moment this line was written), of which **~3,530 are this document** — deliberately
> approximate, because the exact figure moves every time this sentence is edited. Editing this
> document does not move the 4,039.
> Also in the tree and **deliberately left alone** (rule 2 forbade tree-wide operations): 33
> gitignored `dist-*` siblings under `dashboard/server`, 9 under `bakeoff`, and **one `git
> stash` entry that predates this session** and belongs to nobody in it.

---

## THE THIRTY-SECOND ANSWER

1. **The machine works better than any document in this repo says.** The sealed
   gate opens, the plan phase is built and has run, and the 64k crash that killed the
   last run is fixed and mutation-proven. **And the one PASS reproduces on the
   currently-installed scorer image, measured today** — see the correction immediately
   below, which also states what "sealed" does and does not cover.
2. **But it has not been driven since 2026-08-04, and nothing has reached a verdict
   since 2026-07-31.** Every phase after `spec` is unexercised at HEAD.
3. **The one published "DID NOT PASS" cannot be reproduced — because the artefact
   changed under it.** Today's tree passes GATE:boot and 28/28 (17 held-out, 11
   visible). But the gate on 2026-07-31 staged 39 files / 11,407,715 B and today's
   staging walk finds 37 / 10,284,654 B, so this is **not** a re-score of the same
   bytes and the first draft's "inverted verdict" claim is withdrawn. A verdict you
   cannot reproduce is the trust problem in its own right, and nothing on the gate path
   checks that the tree has stopped moving. **UNMEASURED: what the original 404
   actually was.** Leading hypothesis, from the run's own events: a `site/` subtree that
   no longer exists.
4. **The number called "held-out" is computed over the visible half too.** Corrected
   from the first draft: this is a **labelling and reporting** defect, not a leniency
   one. Merging the halves can only add failures, so it makes the gate harsher; the
   leniency path is sealed at freeze time and is absent on both tickets here. It still
   needs fixing — every "28/28 held-out" in this repo's artefacts is really 17 held-out
   + 11 visible — but it is not what can make a green verdict false.
5. **One thing will stop an unattended run cold, and one thing might.** The 128k spec
   rung is unproven on a model that is not pinned — that is the demonstrated killer, it
   is how run 4 died. The rate limit is **conditional**: `rate_limited` is `0` on all
   four rows and no refusal has ever been recorded, so the 51.7–120.0 h figures are
   `seven_day` window-reset countdowns from routine telemetry, **not** measured refusal
   waits. If a refusal happens, the run parks past the 12 h ceiling; whether it will is
   UNMEASURED.

> **CORRECTED 2026-08-09 — "the container is genuinely sealed" is deleted from point 1.**
> The first draft carried that phrase with no command behind it, in a document whose own
> rule is that every claim carries one, and it reads as covering the builder. Stated
> precisely, with commands:
>
> ```
> grep -an 'network=none' bakeoff/src/scorer-container.ts
>   10: * WHAT IT CANNOT SEE, BY CONSTRUCTION: the network (`--network=none`), the build
>   596:      // The CONTAINER is the sandbox: --network=none, --read-only rootfs, all
> python3 -c "import json;print(json.load(open('dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/results/run.json'))['heldConstants']['sandbox'])"
>   {'imageRef': 'host-subprocess (no container: the dashboard builder runs on the host)',
>    'imageDigest': 'not-a-container-digest',
>    'networkPolicy': {'egress': 'denied', 'allowedHosts': []}}
> python3 -c "…same for …052c6e02…"
>   {'imageRef': 'host-subprocess (no container: the dashboard builder runs on the host)',
>    'networkPolicy': {'egress': 'unrestricted-host-network (NOT a measured denial)',
>                      'allowedHosts': ['<no allow-list: the build reaches any host the host machine can reach>']}}
> ```
>
> So: **the scorer is a container and is `--network=none`. The builder is not a
> container at all** — it is a host subprocess — and the two runs' own records disagree
> about its egress, with the later one saying in as many words that the denial was never
> measured. Builder isolation is therefore **UNMEASURED** and is filed as its own item
> in §5. What *was* measured this session is a different seal, and it held: an
> exfiltration probe that copied a frozen held-out file into the workspace was caught —
> `GATE:no-protected-path-writes` FAILED with *"stolen-suite.mjs — byte-identical copy of
> frozen suite file \"holdout/motion-and-background.spec.mjs\""* (full log:
> `res-exfil`/`exfil.log`, reproduced in Appendix A). That is suite integrity, not
> network sealing, and the first draft conflated them.

> **CORRECTED 2026-08-09 — the one PASS was scored by an image that is not the installed
> scorer, and the first draft never said so.** The published run-1 artefact carries
> `sha256:c98bad3a762b` = `bakeoff-scorer:pre-readmech` (built 2026-07-29 16:43), while
> the installed `bakeoff-scorer:1` is `b7a9fd0a0f58` (built 2026-08-02 18:53). The
> document's most load-bearing "it works" claim rested on a verdict produced by an image
> nobody re-checked. **Measured today, and it reproduces:**
>
> ```
> grep -ao 'sha256:[0-9a-f]\{12\}' dashboard/results/scores/*.json | sort -u
>   run-…3d4d1ccb.container.json:sha256:c98bad3a762b     ← the PASS
>   run-…052c6e02.container.json:sha256:fae56a4e1374     ← the DID NOT PASS
> docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep bakeoff
>   bakeoff-scorer:1            b7a9fd0a0f58  2026-08-02 18:53:20
>   bakeoff-scorer:pre-specmode fae56a4e1374  2026-07-30 04:39:27
>   bakeoff-scorer:pre-readmech c98bad3a762b  2026-07-29 16:43:42
> node <Appendix A> --run …3d4d1ccb/results/run.json --out <scratch> --image bakeoff-scorer:1
>   gate.scorerImageDigest=sha256:b7a9fd0a0f58…
>   heldOutPass=true  falseFinish=false  agentDeclaredDone=true
>   suiteExecution={"exitCode":1,"durationMs":8771,"testsTotal":21,"testsPassed":20,"testsFailed":1}
>   FAIL  QUALITY  REQ-013 :: holdout/coglane-presentation.spec.mjs › [REQ-013] T-14 an empty
>                             booking submission produces no confirmation
>   (every other criterion PASS; 12 GATE:* + REQ-001..REQ-012 + REQ-014..016)
> ```
>
> Identical to the published artefact — same `20/21`, same sole failing criterion
> `REQ-013 QUALITY`, same `heldOutPass=true`. Cost: 12.7 s of container time, zero quota.
> **This is the check that should have been in the first draft and was not.**

### Run history — 4 runs, all measured

```
sqlite3 -header -column dashboard/data/runs.db \
  "select run_id, phase, status, held_out_pass, interactive, resume_count from runs order by started_at;"
```

| run | reached | outcome | held_out | interactive | resumes | scorer image |
|---|---|---|---|---|---|---|
| `…3d4d1ccb` 2026-07-29 | spec→build→gate→judge→done | **PASSED WITH NOTES** — *20/21, sole failure `REQ-013` QUALITY, excused by design* | 1 | 0 | 0 | `c98bad3a762b` `pre-readmech` |
| `…c228e63b` 2026-07-30 | spec only | died — `aborted by user` | — | 1 | 0 | — |
| `…052c6e02` 2026-07-30 | spec→build→gate→judge→done | **DID NOT PASS** — *unreproducible; the artefact changed under it, see §3-B1* | 0 | 1 | 2 | `fae56a4e1374` `pre-specmode` |
| `…162b186d` 2026-08-04 | plan→spec | died — `exceeded the 64000 output token maximum` | — | 1 | 1 | — |

> **CORRECTED 2026-08-09 — the project's one green verdict has never been described
> accurately in any document, including the first draft of this one.** "PASSED WITH
> NOTES" was printed with no mention that its suite exited **non-zero** with a failing
> held-out test:
> `python3 -c "import json;d=json.load(open('dashboard/results/scores/run-2026-07-29T23-28-46-665Z-3d4d1ccb.container.json'))['container'];print(d['suiteExecution']);print([(x['criterionId'],x['tier'],x['outcome']) for x in d['criterionCoverage'] if x['outcome']!='passed'])"`
> → `{'exitCode': 1, 'testsTotal': 21, 'testsPassed': 20, 'testsFailed': 1}` and
> `[('REQ-013', 'QUALITY', 'failed')]`.
> **`GATE:suite-green` passing over a non-zero exit is deliberate, not the signature
> defect** — `bakeoff/src/scorer-container.ts:1674-1691` computes
> `ranPasses.every((pass) => pass.exitCode === 0 || excused(pass))`, where `excused`
> means every failing test in that pass is bound SOLELY to QUALITY criteria, and it
> prints the excusal in the detail an owner reads ("*A gate that went green over a red
> test says so… An unexplained green is indistinguishable from a broken gate*"). Filed
> here so a future reader does not mis-file correct behaviour as a defect — and so the
> one PASS is never again quoted as a clean sweep.

Phases read from the event stream, not from the `phase` column:
`sqlite3 dashboard/data/runs.db "select run_id, group_concat(distinct
json_extract(payload,'$.phase')) from events where
json_extract(payload,'$.type')='phase' group by run_id;"` → run 1 and run 3
`spec,build,gate,judge,done`; run 2 `spec`; run 4 `spec,plan`. Runs 1–3 predate the
plan phase. **Only run 1 was unattended** (`interactive=0`).
The three most recent all had a human in them. **No unattended run has ever reached
a verdict at HEAD's code.** Run 4 is the only run to use the plan phase, and it is
also the only run whose code is 75 commits behind HEAD
(`git log --oneline --since=2026-08-04 | wc -l` → `75`).

### Test baseline — measured today

```
cd dashboard/server && npm run clean && npm test
  ℹ tests 1835 / pass 1830 / fail 1 / skipped 3 / todo 1 / duration_ms 73952.675   EXIT=1
cd bakeoff && npm run clean && npm test
  ℹ tests 121 / pass 121 / fail 0 / skipped 0                                       EXIT=0
cd dashboard && npx playwright test --project=unit
  164 passed (5.6s)                                                                 EXIT=0
cd dashboard && npx playwright test --project=browser        (run twice)
  run 1: 5 failed / 1 skipped / 234 passed (2.8m)                                   EXIT=1
  run 2: 2 failed / 1 skipped / 237 passed (2.1m)  — DIFFERENT tests                EXIT=1
cd dashboard && npx tsc --noEmit ; cd server && npx tsc -p tsconfig.json --noEmit ; cd ../../bakeoff && npx tsc -p tsconfig.json --noEmit
  all three EXIT=0
cd dashboard/server && npm run test:harness
  ℹ tests 22 / pass 22 / fail 0                                                     EXIT=0
```

Two suites are red. Neither red is a product defect in the thing being tested — one
is a test bound to the owner's own run history, one is a harness race over a real
product bug. Both are in §3-B. **There is no CI** (`ls -la .github/workflows` → *No
such file or directory*), so a red suite blocks no pipeline.

> **CORRECTED 2026-08-09 — the second half of that sentence had no command behind it.**
> The first draft asserted "nothing in the unattended run path invokes it" as an absence
> claim with nothing measured. Measured now:
> `grep -arn 'npm test\|node --test\|npm run test' dashboard/server/src --include='*.ts' | grep -av '\.test\.ts'`
> → 8 hits, **every one a docblock or a prompt string**, none an invocation:
> `build-prompt.ts:115,:337` (text handed to the builder), `container-fixture.ts:5`,
> `calibration/fixtures.ts:288`, `calibration/grade-fixture.ts:139,:183,:184,:252`
> (comments). So the claim survives, but it is measured now rather than asserted.
>
> **Also corrected: the baseline command in the block above is destructive to concurrent
> work.** `npm run clean && npm test` deletes the shared `dashboard/server/dist/` that
> other agents depend on. A critic declined to re-run it for that reason and recorded
> the `1835 / fail 1` figure as UNMEASURED-BY-THEM; that is a fair objection to the
> command, not to the number. The non-destructive reproduction is
> `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-<yourlabel> && node --test 'dist-<yourlabel>/**/*.test.js'`,
> which touches no shared output.

No suite shrank. `find dashboard/server/src -name '*.test.ts' | wc -l` → `104`, and
`find dashboard/server/dist -name '*.test.js' | wc -l` → `104` — full parity, no
file silently excluded by a glob. (One agent reported a denominator of 86; the
correct count is 104. That agent had excluded 12 port-binding files.)

---

## 2. WHAT CHANGED SINCE 2026-08-02 — 104 commits, and they earned real credit

```
git log --since=2026-08-02 --format='%s' | sed 's/[(:].*//' | sort | uniq -c | sort -rn
  29 feat / 23 fix / 21 test / 15 docs / 6 refactor / 5 copy / 4 design / 1 chore
```

By area (`git diff --shortstat $(git rev-list -1 --before=2026-08-02 main)..HEAD -- <area>`):

```
dashboard/server/src   48 commits   113 files  +50498 / -794
dashboard/tests        40 commits    32 files  +12644 / -149
dashboard/src          38 commits    44 files  +12983 / -1338
docs/                  11 commits    10 files   +5785
bakeoff/                3 commits     4 files    +690 / -39
```

### Items these commits measurably CLOSED

| was open | closed by | evidence |
|---|---|---|
| **"The plan phase is unbuilt"** (STATE §6, WHAT-TO-DO item 4) | `b1d5158` 2026-08-03 | `grep -an 'export type ApiPhase' dashboard/server/src/api-types.ts` → `:100 export type ApiPhase = "plan" \| "spec" \| "build" \| "gate" \| "judge" \| "done";`. 4,344 lines across 6 dedicated modules. **It ran in production**: run 4 emitted two `phase:plan` events and wrote a real 5,184-byte `results/plan.json` — 3 questions proposed, 2 answered by the owner in his own words, 1 declined and recorded as an assumption. |
| **The 64k overflow that killed run 4** | `c72650c` 2026-08-04 15:49 | `grep -arn 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' dashboard/server/src/subscription-caller.ts` → `:231` the env name, `:246 seatCallEnv(...)`, applied at `:1906 env: seatCallEnv(this.#env, request.maxOutputTokens)`. At run-4 time it was set **nowhere** — not in code, not in a `.env`, not in the ambient shell. `git merge-base --is-ancestor c72650c HEAD` → ancestor. |
| **The repair ladder that had never executed, for two independent reasons** | same commit | `bakeoff/src/spec-types.ts:230 MAX_STREAMABLE=128_000`, `:249 CLI_DEFAULT=64_000`, `:309 DEFAULT_MAX_OUTPUT_TOKENS = CLI_DEFAULT` — the guard is no longer false on every attempt. And the overflow now RETURNS `stopReason: "max_tokens"` instead of throwing past the detector. **Mutation-proven, not assumed** — see §2.1. |
| **"No dry run against the current image"** (STATE §6, blocking-adjacent) | 2026-08-02 | `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` → `sha256:b7a9fd0a0f58…`; `bakeoff/dry-run/scores/dryrun-A-DRYRUN-r0.json` `scorerImageDigest` → **the identical string**, `scoredAt 2026-08-02T17:44:12.118Z`, i.e. 51 minutes after the image was built (`{{.Created}}` → `2026-08-02T18:53:20+02:00` CEST). Ordering checks out — the dry run followed the build, the digests did not coincide by a later rebuild. Full `dry-run` re-run today: EXIT=0, all five stages green. |
| **Preview served an unstyled page because the build put its site in a subdirectory** | `ca8961e` 2026-07-31 | `http.ts:2616 PREVIEW_ROOT_CANDIDATES = ["", "site", "dist", "public", "build", "out"]`. Closed *before* STATE was written and never reflected in it. The other half of STATE §5 is still open — see §3-C2. |
| **Auto-recovery was an opt-in feature nothing turned on** | `d06ac74` 2026-08-05 | `recovery.ts:710` docblock: *"DEFAULT **ON** SINCE 2026-08-05; the variable is now an OFF SWITCH."* Bounded to 3 continuations (`AUTO_CONTINUE_MAX = 3` at `recovery.ts:120`). **Note this does NOT close the overnight wait item** — the 12 h ceiling caps it independently (§3-A1). **And note the direction nobody costed: because it is ON by default, an unattended run can restart itself up to three times with no human present, which is what makes B1 reachable on the very path §4 recommends** (see the correction under §4 step 6). |
| All six **UX-GAPS-2026-07-30** "FIX NEXT" gaps | across the window | Live timestamps carried through the parser (`use-run-stream.ts:470`); Resume no longer offered on `failed` (`run-hud.tsx:180`); the four shipped strings saying the chat does not exist are gone; screenshots partitioned so the product is not buried under AI mockups (`screenshots.tsx:202`); the composer no longer gated on node selection; `/api/health` now probes the real gate via `createGate(gateEnv(...))` rather than a hardcoded `docker image inspect` (`health-gate.ts:44`). |
| All four **canvas items HANDOVER.md:162-163 lists as outstanding** | 2026-07-29 → 2026-08-04 | Draggable nodes (`orchestration-canvas.tsx:1871`, drag moved a node `translate(0px,207px)` → `translate(239.061px,366.374px)`); fit-to-view as a real mount effect (`:1579-1586`, once-latched on `nodesInitialized`); sibling collapse into real group nodes (`layout.ts:181-188`, rendering "14 identical tasks" with an "unfold 24" control); the edge-quality raise (§2.2). |
| **STATE backlog items 1, 3, 4, 5, 6** (attachments/handover) | `b1d5158` and the contract-parity growth | Blob URLs now released through a ref mirror, not a stale closure (`orchestrator-chat.tsx:537-541`); `contract-parity.test.ts` now does whole-shape field-set parity on `RunDetail` and twelve nested shapes (18 tests, 17 pass, 0 fail, 1 todo); the client type mirror carries `publishedProject` **and renders it** (`sheet.tsx:1125`); the stale `documents` docblock is corrected; `run: row` is wired at `orchestrator.ts:6317`. |

### 2.1 The overflow fix is not a success-only check — it was watched going red

This matters because seventeen instances of "a check that can only observe success"
are catalogued in this repo. The end-to-end seam test was mutated and failed with
the predicted symptom:

```
perl -pi -e 's/OVERFLOW_STOP_REASON = "max_tokens"/OVERFLOW_STOP_REASON = "max_output_tokens"/' \
  dist-runhist/subscription-caller.js && node --test dist-runhist/spec-ladder-e2e.test.js
✖ the real caller's truncation reaches the real ladder, and the raised budget travels
  actual:   [ '64000', '64000', '64000' ]
  expected: [ '64000', '128000', '128000', '128000' ]
(restored from backup; re-ran: ℹ pass 1 / fail 0)
```

Source untouched; the mutation was applied to a private compiled build and reverted.
The ladder tests are green at HEAD: bakeoff 4/4, dashboard overflow + ceiling 10/10.

### 2.2 The edge treatment cleared the owner's bar — two thirds of it

The owner's recorded bar (`HANDOVER.md:165-167`) named three mechanisms:
`feGaussianBlur`+`feMerge`, low-amplitude `feTurbulence`, and animated gradient
stops. Measured in the **rendered DOM**, not in source:

```
getComputedStyle on the rendered paths:
  .conduit-rim    13px    .conduit-casing 10.5px
  .conduit-body   4.5px  stroke: url("#n1-_group_1-grad")
  .conduit-core   1.35px
filter primitives on an energised edge: ["feGaussianBlur","feGaussianBlur","feMerge"]
pathsReferencingFilter: 3, filterRefsResolving: 3
grep -ran 'feTurbulence' dashboard/src              → exit 1, no output
grep -ran -E '<animate|animateTransform' dashboard/src --include='*.tsx' → empty
```

So: the bloom shipped and is real. `feTurbulence` and animated gradient stops are
absent everywhere. **This is not a silent drop** — the owner's ask was an OR, and
the alternate branch was declined on the record with an argument
(`specs/2026-07-28-orchestration-canvas-design.md:484`: *"Canvas/WebGL rejected on
category: its only advantage is node-count headroom the measurements prove
unnecessary, and it forfeits the DOM needed for skill/MCP/hook pills and
click-to-inspect."*). Filed as a taste call, not a defect (§3-C5).

> **CORRECTED 2026-08-09 (second pass) — THIS SECTION IS NOW STALE IN THE OWNER'S FAVOUR,
> and a section that undersells the tree is as wrong as one that oversells it.** The
> sentence *"`feTurbulence` and animated gradient stops are absent everywhere"* was true
> when it was written and is **half false** now. The two halves ended differently and the
> difference matters:
>
> **ANIMATED GRADIENT STOPS EXIST.** `grep -an 'conduit-flux' dashboard/src/app/globals.css
> dashboard/src/components/canvas/flow-edge.tsx` → `@keyframes conduit-flux` at
> `globals.css:594`, `.conduit-flux-stop { animation: conduit-flux 2400ms ease-in-out
> infinite }` at `:605`, a reduced-motion override at `:737`, and the two interior stops
> tagged in `flow-edge.tsx:292,301`. **RENDERED-DOM MEASUREMENT, taken by the final gate
> against the PRODUCTION BUNDLE and a real run's graph** — not the harness fixtures every
> other number in this section came from:
> ```
> ENERGISED (fresh load, mid arrival sweep)
>   document.getAnimations() names conduit-flux and conduit-travel, running
>   stop-color sampled per rAF: 162 DISTINCT values over 301 frames
> SETTLED (finished run, sweep over) — the negative control
>   document.getAnimations() → 0
>   stop-color sampled per rAF: 1 DISTINCT value over 30 frames
> ```
> **Both directions.** It runs when it should and it stops when it should, which is what
> makes this a measurement rather than a sighting. Amplitude, read by freezing the cycle
> (`animation-play-state: paused` + a negative delay, because Chromium freezes the animation
> clock during a screenshot and the banned pixel-diff cannot see motion): trough
> `oklab(0.630 …)` → peak `oklab(0.818 …)`, **ΔL ≈ 0.19 with `a` and `b` essentially
> unchanged** — a lightness breath, not a hue strobe. Correctly low-amplitude, as the owner
> asked.
>
> **`feTurbulence` DOES NOT EXIST, and that is now a REFUSAL rather than an omission.**
> `document.querySelectorAll("feTurbulence").length === 0` at every viewport and zoom the
> gate measured; `grep -ran feTurbulence dashboard/src` hits **only comment lines** at
> `globals.css:586-655`. It was **built in the live DOM and measured**: `+feTurbulence`
> **216.8 ms** against as-shipped **135.5 ms** on a settled five-edge graph and **1497.4 ms**
> against **703.5 ms** on a live six-edge one — 1.6× to 2.3× the whole canvas's raster, i.e.
> **+6.8 ms per zoom step at rest and +66 to +93 ms per zoom step while the run is live**.
> The four-arm table and its `stdDeviation`-200 negative control are **in the tree** at
> `globals.css:585-655`, not only in a report. Two of the table's sixteen cells are marked
> `(not recorded here)` rather than invented.
>
> **THE FRAME COST OF WHAT DID SHIP, stated the way the numbers support it and not one word
> stronger.** As-shipped **135.5 ms** against bloom-off **135.4 ms** (1440×900 finished) and
> **909.2** against **885.7** (2000×1200 live). **Those deltas are inside the instrument's
> own noise** — the arm-to-arm spread is roughly **±15–20 ms** and the sign flips between
> viewports. So: **not distinguishable from free at four to six edges**, against an
> instrument with that spread. The word *"free"* was written into `flow-edge.tsx` by the
> lane and **struck out by the repair pass**; it is not restored here. Thirty edges is
> extrapolation. The turbulence refusal is unaffected — its deltas are five to eighty times
> the band.
>
> **WHAT THIS DOES NOT CHANGE.** The Canvas/WebGL argument quoted above is about a
> **rendering substrate**, not about `feTurbulence`; the new refusal does not absorb it and
> it still stands on its own. And the owner's bar is **still not met** — see §3-C5 item 6 and
> the SECOND FIX PASS note: two of the three named mechanisms ship, the third is refused with
> a number, and **the flux is at the naked-eye threshold at the default fit** (two independent
> readers compared a mid-sweep frame against a settled frame at 0.51 zoom and called them
> indistinguishable; the oklab numbers, not anyone's eye, are the evidence that it animates).
> The **bloom**, not the flux, is what carries liveness at the zoom the canvas chooses for
> itself — its effective screen width is pinned at **4.81 px** across the compensated range
> by `--conduit-scale`, measured 4.813 px at the 0.6927 default fit and exactly 6.5 px at
> 1.4363.

The motion is real and was verified with a control that could have shown it was not:

```
rAF sampling of getComputedStyle(path.conduit-comet--hot).strokeDashoffset
  frames: 73, distinctOffsets: 73, animCurrentTime 683ms → 1283ms, playState running
CONTROL — a different, FINISHED run:
  live (harness-build-run):     comets 6, blooms 2, feGaussianBlur 4, animationsTotal 20
  finished (harness-finished-run): comets 0, blooms 0, feGaussianBlur 0, animationsTotal 0
```

> **CORRECTED 2026-08-09 — this is this repository's signature defect appearing inside
> this report, and a critic caught it.** The first draft labelled the second block
> **"NEGATIVE CONTROL — same event list, terminal status"**. It was not the same event
> list. The probe navigates to two *different* fixtures, and its own artefact records
> the difference: `facts-live.json` has `liveSettled.nodes 12 / edges 6` against
> `finished.nodes 10 / edges 5`. Fixture identity is confounded with terminal status, so
> the comparison cannot isolate "the motion stops because the run finished" from "this
> other graph never had it". The words "same event list" are withdrawn; what was
> actually measured is **"a different, finished run shows none of it"**, which is
> weaker but true. The rAF sampling above is unaffected — it is a single-arm
> measurement of 73 distinct offsets over 600 ms of animation clock and stands on its
> own. **The control that would settle it** (one fixture, status flipped to terminal, so
> status is the only variable) was not run.
>
> **Second, undisclosed in the first draft anywhere: every motion and canvas measurement
> in this document is on Playwright harness fixtures, never on a real run's event
> stream.**
> `grep -arn 'harness-build-run' --include='*.ts' dashboard` →
> `dashboard/tests/fixtures/config.ts:58 export const BUILD_RUN_ID = "harness-build-run"`
> (and `:59 FINISHED_RUN_ID = "harness-finished-run"`). Runs 1 and 3 have complete event
> streams on disk and neither was used. Added to §5 as its own UNMEASURED item.

> **An instrument that was thrown out, recorded so nobody re-runs it.** A pixel-diff
> of two screenshots 250ms apart returned *byte-identical* for BOTH the moving case
> and the reduced-motion case — Chromium's `captureScreenshot` freezes the animation
> clock. A method that gives the same answer for both arms cannot discriminate and is
> not cited anywhere in this document. The rAF sampling and the live-vs-finished
> control above are the load-bearing evidence.

> **CORRECTED 2026-08-09 — the owner asked "animations and all" and this document
> contains zero pictures. That is a real gap and it is only half-fixable here.**
> A critic counted 37 PNGs behind the visual claims — `energised-closeup.png`,
> `closeup-edge.png`, `zoomed-1440x900.png`, `normal-motion-full.png` /
> `reduced-motion-full.png`, `big-2000x1200.png`, `finished-control.png` and others —
> all of them under `…/scratchpad/shots/` in a session directory that is reaped
> (`find <scratchpad> -name '*.png' | wc -l` → `102`, 40 MB total). **I did not copy
> them into the repository**, and the reason is not laziness: this pass was permitted to
> write one file, and moving 40 MB of untracked binaries into `docs/` would not make
> them durable for the owner anyway — it relocates the ephemerality and grants a
> permission nobody gave. So the honest fix is labelling:
>
> **Every appearance judgement in this document is UNMEASURED-BY-THE-READER.** That
> covers, specifically: *"the bloom shipped and is real"*, *"the four-layer stack
> collapses to a hairline"*, *"the per-edge gradient reads as a flat tint"*, and *"the
> reference the code was built against is only legible at ~0.9–1.5 zoom"*. Each was
> judged by looking at a frame that the reader cannot now open. The **numbers** behind
> them survive independently and are in the JSON artefacts quoted inline (zoom
> 0.363924, 0.566502, 0.621387; stroke widths 13 / 10.5 / 4.5 / 1.35 px; 20-vs-0
> animations) — a critic re-checked those against `facts-live.json`,
> `facts-probe3.json` and `facts-big-1440x900.json` and they match to the digit.
> **To regenerate the frames**, the probes are `probe1.mjs`…`probe8.mjs`,
> `live-canvas.spec.ts` and `live.config.ts`; they bind host ports, which is why they
> are not re-run here. If the owner wants the visual half checkable, the cheap ask is:
> re-run probe1 and probe3 and keep four frames — the energised edge at 1.0 zoom, the
> same edge at the 0.363924 default fit (that pair *is* the whole of C4's argument, and
> it is currently only a number), live vs finished canvas, and the 2000px gutter on
> `/runs`.

---

## 3. WHAT IS LEFT — ranked, in three lists

### A. BLOCKS THE RUN — it will not reach a verdict unattended

> **RANKING CORRECTED 2026-08-09, and the section shrank from three items to two.**
> **A2 is the top blocks-run item, not A1** — A2 has a corpse (run 4 died of it on
> 2026-08-04) while A1's mechanism has never fired on this machine. The numbering is left
> as A1/A2 so existing references still resolve; read A2 first. **A3 has moved out of
> this section entirely** — see the note below A2.

#### A1. IF a rate limit refuses a call, the run parks past the unattended ceiling — but no refusal has ever been recorded here

> **FIXED 2026-08-09 — the leg that parked a run forever is closed, and it was NOT the
> ceiling.** Two files, split so the invention stays where it is documented.
> `subscription-caller.ts` gained `parseRetryAfterSeconds()` (five patterns taken from
> the bundled CLI's own templates, rounding UP) and `#asCallError`'s hardcoded
> `retryAfterSec: null` now calls it. `recovery.ts`'s `planThrottledWait` no longer
> returns stop `no_retry_after` when nothing was reported: it substitutes
> `REFUSAL_BLIND_WAIT_MS` (5 h, **CHOSEN, not measured**) and flows through every
> existing ceiling, carrying a `source` string so no sentence presents the length as
> something the provider said. `no_retry_after` was deleted from `RecoveryStopCode`,
> because a stop code nothing can produce reads like an untested arm.
> **Tests:** `subscription-caller.retry-after.test.ts` (new, 7 — including two
> negative controls, one of which pins that *the other numbers in a refusal are not
> mistaken for a wait*, and two WIRING tests that drive the real caller, which is what
> proves the parser is CALLED and not merely sitting beside a hardcoded null);
> `recovery.test.ts` and `rate-limit-resume.test.ts` gained eight between them.
> **The 12 h ceiling is unchanged, deliberately** — §3-A1's own correction is why: the
> 51.7–120.0 h figures are `seven_day` window horizons, not refusal waits.
>
> **THE MUTATION FOUND A REAL WEAKNESS AND IT WAS REPORTED, NOT HIDDEN.** Halving the
> constant first turned only ONE test red, because every other assertion computed its
> expectation *from* `REFUSAL_BLIND_WAIT_MS` and moved with it — this repository's
> signature defect in miniature. A hard-literal anchor (*"the chosen hold … is FIVE
> HOURS, written out as a literal"*) was added and the mutation re-run; the verifier
> independently reproduced **two** red, confirming the anchor holds.
>
> **RESIDUE, AND IT IS THE NEW HOUR-11 SHAPE.** `RECOVERY_MAX_AUTO_WAIT_MS` (12 h) is a
> **per-wait** ceiling, not a cumulative one, and `boundFor("throttled")` allows 3 — so
> **three blind holds can total 15 hours inside a 2–12 h budget**, each announced only
> as a line on the run's own log. This is a new unattended behaviour: the same case
> previously stopped for a human. And **no refusal has ever been recorded on this
> machine** (`rate_limited = 0` on all four rows), so the parser is fitted to CLI
> templates, not to an observed refusal — which makes the 5 h fallback the likeliest
> path, not the exceptional one. Mitigation is in §4's recipe, not in code.

> **CORRECTED 2026-08-09 — the heading and the ranking of this item were both wrong, and
> the field that would have shown it was never printed.** The first draft's heading read
> *"A real rate limit stops the run dead: every window this machine records is 4–10× the
> unattended ceiling"*, and §1 point 5 listed it flatly as one of "two things that will
> stop an unattended run cold". The first draft then supplied, inside this very section,
> the negative control that contradicts its own heading — 0 `limited:true` events,
> `rate_limited = 0` on every row — and used the routine numbers as refusal waits
> anyway. The missing column settles it:
>
> ```
> sqlite3 -header -column dashboard/data/runs.db \
>   "select run_id, rate_limited, rate_limit_kind, rate_limit_retry_after_sec, rate_limited_at from runs order by started_at;"
>   …3d4d1ccb  0  seven_day  299048  (empty)
>   …c228e63b  0  seven_day  253699  (empty)
>   …052c6e02  0  seven_day  186234  (empty)
>   …162b186d  0  seven_day  431997  (empty)
> ```
>
> **`rate_limit_kind` is `seven_day` on all four rows and `rate_limited_at` is empty on
> all four.** These are seven-day-window reset countdowns from routine telemetry —
> 431,997 s is simply about a week — not measured refusal waits. The code distinguishes
> the two in as many words: `sed -n '5698,5712p' dashboard/server/src/orchestrator.ts`
> (`#noteRateLimit` writing `rateLimitRetryAfterSec` from telemetry that separates *"the
> provider refused this call"* from *"the window you are in reopens at T"*) and
> `:5874-5880` (*"`#noteRateLimit` also writes `rateLimited`, from routine
> `limited: false` telemetry, so THAT boolean is not the refusal and nothing arms off
> it"*). **What `retryAfterSec` a real refusal would produce on this machine is
> UNMEASURED**, because `subscription-caller.ts:2123` hardcodes it to `null`.
>
> The recommendation below is unchanged and still worth taking — but as **cheap
> insurance against an unobserved failure mode**, not as the fix for a demonstrated
> blocker. A1 is no longer the top blocks-run item; A2 is, because A2 has a corpse.

**Evidence.**
```
grep -an 'RECOVERY_MAX_AUTO_WAIT_MS = ' dashboard/server/src/recovery.ts
  227:export const RECOVERY_MAX_AUTO_WAIT_MS = 12 * 60 * 60 * 1_000;
sqlite3 -header -column dashboard/data/runs.db "select rate_limit_kind, rate_limit_retry_after_sec, round(rate_limit_retry_after_sec/3600.0,1) hours from runs order by started_at;"
  seven_day 299048 → 83.1 h   seven_day 253699 → 70.5 h
  seven_day 186234 → 51.7 h   seven_day 431997 → 120.0 h
  ← all four are WINDOW-RESET horizons from routine telemetry, not refusal waits
```
Both arms a real refusal can reach end in a human pressing Resume: `recovery.ts:996
code: "wait_too_long"` and `recovery.ts:919 code: "no_retry_after"`. The second is
the one that actually fires, because the dashboard's only seat hardcodes no reset
instant: `subscription-caller.ts:2123 #noteRateLimit({ limited: true,
retryAfterSec: null, kind: null, utilization: null })`. Nothing raises the ceiling:
`grep -arl 'DASHBOARD_RECOVERY_MAX_WAIT_MIN' . | grep -av 'node_modules\|/dist'` →
only `recovery.ts`, its test and a spec doc; `ls -a dashboard/.env*` → *no matches*.

**Negative control.** An arm that *would* hold the wait does exist —
`orchestrator.ts:1712` and `:5922` both thread a `retryAfterSec` from an SDK frame.
But it has never fired here: `sqlite3 … "select count(*) from events where payload
like '%\"limited\":true%';"` → `0`, and every run's `rate_limited` column is `0`.

**What closes it.** Two independent changes. (a) `DASHBOARD_RECOVERY_MAX_WAIT_MIN=10080`
— the escape hatch exists and is tested. (b) Make the CLI-throw path carry a reset
instant, or `no_retry_after` still parks the run with the ceiling raised. **(a) alone
may not be sufficient.**
**Effort.** (a) minutes. (b) hours — `recovery.ts:901` documents on purpose why
substituting row telemetry is refused today, so the fallback needs its own argument
and test.
**Cost of leaving it.** *If* a refusal lands, the overnight run you start on a Friday is
sitting parked on Saturday morning having burned the window, with no verdict. Four runs
have produced no refusal, so the probability is unquantified — this is insurance.

#### A2. The 128k rung is unproven on both legs, and the model it depends on is not pinned

> **FIXED 2026-08-09 — the pin landed. The GUARD is tested but is NOT IN FORCE, and
> those are different sentences.**
> *(Superseded in part: the guard IS in force as of the second pass — see the block at the
> end of this item. The pin's account below is unchanged and still accurate.)*
> `grep -an 'DEFAULT_SPEC_MODEL = ' dashboard/server/src/orchestrator.ts` →
> `446:export const DEFAULT_SPEC_MODEL = "claude-opus-5[1m]";` — moved from `"default"` to the literal
> `"claude-opus-5[1m]"`, which is the id the probe measured `"default"` resolving to,
> **so the behavioural delta is zero and only the guarantee is new**. Added
> `MODEL_OUTPUT_CEILINGS` (the bundled CLI's own `max_output_tokens.upper` registry, 16
> ids, transcribed 2026-08-09), `canonicalModelId()` to strip the `[1m]` suffix before
> lookup, and `outputCeilingFor()` / `specModelCeilingWarning()`. The rung is imported
> from `bakeoff/dist/spec-types.js` rather than restated. **An id nobody measured —
> including the literal `"default"` — is treated as UNSAFE, not as unconstrained.**
> **Test:** `orchestrator.spec-model.test.ts` (new, 7): the default clears the rung; the
> default is not a runtime-resolved name; the suffix does not hide a model; 32k refused;
> 64k refused (`claude-haiku-4-5`, the id the probe caught being capped); unknown ids
> refused; **and a not-a-blanket-refusal control** so the guard cannot pass by refusing
> everything. Mutation (`→ claude-opus-4-1`, registry upper 32000) reproduced by the
> verifier: *"which caps output at 32000 tokens — below the 128000-token rung"*, i.e.
> the ceiling branch fired, not the unknown-id branch.
>
> **THE PIN MOVES THE JUDGE SEAT TOO** — `#seat()` builds all of them. Delta is zero
> because both already resolved to this id.
>
> **NOT IN FORCE, AND STATED PLAINLY:** `specModelCeilingWarning()` has **no production
> call site**. `grep -an "specModelCeilingWarning" dashboard/server/src/orchestrator.ts`
> → `376` (a docblock reference) and `394` (the definition). Nothing else. `#seat()`
> applies `DASHBOARD_SPEC_MODEL` without consulting it, so **the guarantee is exactly as
> strong as the literal default and no stronger**: set the env var to a 64k model and the
> 128k rung silently becomes a no-op again, which is how run 4 died. Threading a `runId`
> into `#seat()` was timeboxed out and declared rather than implied.
>
> ---
>
> #### FIXED 2026-08-09 (second pass) — THE GUARD IS IN FORCE. The paragraph directly above is now false and is kept because it is the defect's best description.
>
> **The finding was verified before it was fixed:** `grep -an 'specModelCeilingWarning' -r .
> --include='*.ts' | grep -v /dist` returned only the definition, its own docblock, the 7
> tests and two lines of this document. **Zero production call sites.** Today the same grep
> returns live callers at `orchestrator.ts:6174` and `:6207`.
>
> **WHAT IT DOES NOW — three outcomes, and the third is the one a hasty wiring gets wrong.**
> `#seat(base)` became `#seat(runId, base)` and resolves through a new
> `#usableSpecModel(runId)`; a new `#reportSpecModel(runId)` preflight is the **first
> statement inside `#execute`'s try** (`:2065`), before phase 0, so the refusal lands at
> **zero quota on every path**.
>
> | `outputCeilingFor(id)` | Outcome |
> |---|---|
> | **`null`** (unknown id) | `warn` + **PROCEED** — refusing here would close the escape hatch this very docblock names, since a model shipped after the table was transcribed is unknown BY DEFINITION. |
> | **below `CLI_DEFAULT_MAX_OUTPUT_TOKENS` (64,000)** | `error` + **THROW**. |
> | **at or above it** | one `info` line naming the model and the measured ceiling; below the 128,000 retry rung it is a `warn` that names the rung the truncation retry cannot reach. |
>
> **REFUSE, NOT WARN, and the reason is the use case:** these runs are unattended for 2–12
> hours, so a warning nobody reads buys nothing against 49 minutes of quota and a dead run.
> The throw reaches `#start`'s catch, is classified `unclassified` (no refusal is carried —
> `#execute` clears `#lastRefusal` first), so it fails cleanly rather than auto-continuing
> into a loop that would refuse identically forever. **The preflight, not `#seat` alone:** on
> a run reusing a frozen suite the first `#seat()` call is `#judgePhase` — *after* the build
> — so a `#seat`-only guard would destroy a built, gated artefact over a variable that was
> wrong before the run started.
>
> **THE THRESHOLD WAS WRONG ON ITS FIRST WIRING, AND A REVIEWER CAUGHT IT BEFORE THE OWNER
> DID.** The first cut refused whenever `ceiling < MAX_STREAMABLE_OUTPUT_TOKENS` (128,000).
> **128,000 is not what any seat asks for.** Verified read-only in `bakeoff/src`: plan seat
> 16,000 (`plan-seat.ts:141`), judge seat 32,000 (`judge.ts:86`), spec/audit **starts** at
> `DEFAULT_MAX_OUTPUT_TOKENS = CLI_DEFAULT_MAX_OUTPUT_TOKENS = 64,000`
> (`spec-types.ts:249,309`) and reaches 128,000 only on a truncation retry that its own
> docblock says does **not** consume an attempt. So on a 64,000-ceiling model **three of the
> four seats are unaffected and the fourth runs at exactly its ceiling** — what is lost is a
> recovery rung. The first wiring converted that degradation into a **hard outage at zero
> spend**, making **eight of the sixteen ids unusable as seat models** — `claude-sonnet-4-5`,
> `claude-opus-4-5`, `claude-haiku-4-5` among them — with no override, so an owner whose Opus
> quota was exhausted could not fall back to Sonnet at all. The threshold is now
> `ceiling < CLI_DEFAULT_MAX_OUTPUT_TOKENS`, **imported from `bakeoff/dist/spec-types.js`,
> not retyped** (`orchestrator.ts:6160`). **No acknowledgement env was added** — the split
> makes one unnecessary.
>
> **A FALSEHOOD INTRODUCED AND WITHDRAWN INSIDE THE SAME PASS, recorded because it is the
> kind that survives review.** The repair's first draft passed `CLI_DEFAULT_MAX_OUTPUT_TOKENS`
> as the `rung` argument to `specModelCeilingWarning()`, whose prose is *"below the N-token
> rung the spec agent retries at. That retry is a no-op"* — at N = 64,000 **both clauses are
> false of every model**. Reverted to the default 128,000 rung (true of anything reaching the
> refusal branch) with the first-call reason moved into its own clause, and three new
> assertions pin every clause including `assert.doesNotMatch(reason, /64000-token rung/)`.
>
> **THE PIN GOVERNS ALL FOUR SEATS, verified by reading and now by a test that goes red when
> one stops.** plan `:2815`, spec `:2959`, audit `:2960`, judge `:5679` — all through
> `#seat`, which is the only reader of `env[SPEC_MODEL_ENV]`. Two holes named rather than
> left implied: the `makePlanSeat` injection at `:2801` is a **test-only seam** (nothing in
> production sets it), and the **BUILDER and FIX seats take `row.modelId`** (`:3841`,
> `:5290`) — a separate lever the pin deliberately does not govern.
>
> **Files:** `dashboard/server/src/orchestrator.ts`,
> `dashboard/server/src/orchestrator.test.ts`,
> `dashboard/server/src/orchestrator.spec-model.test.ts` (new).
> **Tests:** *"a run whose seat model MEASURES below the START budget is refused BEFORE
> anything is spent"*, *"a 64k model BUILDS and warns — it loses the retry rung, not the
> run"*, *"an UNKNOWN model id PROCEEDS, loudly — the escape hatch stays open"*, and a
> **negative control** *"the same run on the pinned model builds, and says which model it is
> on"*; plus two structural tests, *"every seat in the orchestrator takes its model from
> `#seat` — all four of them"* and *"`#seat` is the only place the seat model is spelled, and
> it consults the ceiling"*.
>
> **MUTATION PROOFS — reproduced by the verifier, not taken from the lane.** All applied
> **by line number**, because `:2960` and `:5679` are **byte-identical** and a slurp-mode
> regex hits the wrong one.
> - **M1** (preflight removed, i.e. the pre-fix state) → *"the refusal must land before the
>   builder starts — a run stopped after the build has already spent the hours the guard
>   exists to save. actual: 2, expected: 0"*. The verifier found it reddens **three** tests,
>   one more than the lane reported.
> - **M4** (judge seat only, `this.#seat(runId, JUDGE_SEAT)` → `JUDGE_SEAT`) → *"orchestrator.ts:5679
>   builds a seat WITHOUT the pin … DASHBOARD_SPEC_MODEL governs three seats out of four."*
>   It **compiles clean**, which is why the type system could never have caught it.
> - **M-CEIL** (the threshold back on the recovery rung) → *"a model that serves every seat's
>   first call was refused anyway — the threshold is back on the recovery rung, and half the
>   ceiling table is unusable again."*
> - **M-LITERAL** (a second reader written `this.#deps.env["DASHBOARD_SPEC_MODEL"]`, real
>   code that compiles and survives the comment strip) → *"the override variable's NAME is
>   spelled more than once … 2 !== 1."*
>
> **A MUTATION THAT SURVIVED, DISCLOSED BY ITS OWN LANE AND CONFIRMED BY THE VERIFIER — this
> is the part worth reading.** **M6** cut the ceiling check out of the chokepoint itself
> (`#seat` back to applying `DASHBOARD_SPEC_MODEL` verbatim) and **106/106 stayed green**,
> because the `#execute` preflight still threw and no structural test looked inside `#seat`'s
> body. A guard with a caller and no test, sitting inside the fix for a guard with tests and
> no caller. Closed with one more assertion; re-applied, it now reads *"`#seat` resolves the
> seat model WITHOUT consulting the ceiling … the chokepoint every seat is built at — including
> a fifth one added later, or a path that never reaches the preflight — no longer checks
> anything."* **The lane flagged this itself rather than quietly patching it.**
>
> **STILL RESIDUE, and it is not the same residue as before.** The preflight fires on **every**
> `#execute` entry — rate-limit resume and `reconcileOnBoot` included — and `failed` is
> terminal, so a resume under a genuinely-below-64k id terminally fails a run holding a frozen
> suite and a built artefact. Narrowed by the threshold split, not closed. See §6's second-pass
> subsection (C).
>
> **`DASHBOARD_SPEC_MODEL` HAS INVERTED ITS ROLE.** It was "opt in to a pin"; it is now
> the **escape hatch if the pin is retired** — you must **SET** it to a live id, because
> unsetting now lands back on the literal. `dashboard/README.md:126` was updated to say
> so. **The pin's failure mode was never exercised** (only valid ids were probed) and it
> would throw at seat construction minutes into an unattended run — hence the zero-quota
> pre-flight probe in §4.
>
> **RESIDUE:** the table is stamped to `@anthropic-ai/claude-agent-sdk` **0.3.220** and
> nothing re-derives it at runtime, so an SDK bump makes it a confident stale claim. It
> also **omits `claude-3-5-sonnet` (upper 8192)**, which is present in the binary — it
> fails safe (unknown → refused) but the table is presented as *the* registry and is not.

**Leg A — the model is a string the CLI resolves at runtime.**
```
grep -an 'DEFAULT_SPEC_MODEL = ' dashboard/server/src/orchestrator.ts
  309:export const DEFAULT_SPEC_MODEL = "default";   ← NO LONGER TRUE, see below
bakeoff/src/spec-types.ts:227-230 — "The streamable max_tokens ceiling on every current
  Claude model except Haiku 4.5, which caps at 64K."
grep -ao 'claude-haiku-[a-z0-9._-]*' /opt/homebrew/bin/claude | sort -u      (CLI 2.1.226)
  claude-haiku-4-5-20251001
```

> **CORRECTED 2026-08-09 — the grep above was written as `<claude CLI binary>`, which is
> not a runnable command; the absolute path is `/opt/homebrew/bin/claude`.** More
> importantly, note what these two lines are and are not. The "64K cap" is **an in-repo
> code comment**, and the model id is **a string found inside a binary**. Neither is a
> measured model capability, and this document should not have presented them as one.
> The lever itself is real and wired —
> `grep -arn 'SPEC_MODEL_ENV' dashboard/server/src/*.ts | grep -av '\.test\.'` →
> `orchestrator.ts:298 export const SPEC_MODEL_ENV = "DASHBOARD_SPEC_MODEL"` and
> `:5694 const model = (this.#deps.env[SPEC_MODEL_ENV] ?? "").trim();` — so pinning
> works. What is unproven is the premise that `"default"` is dangerous.
If `default` resolves to a 64k model, the 128k rung is a no-op and the run dies
exactly the way run 4 died. **Every ladder test replays stubbed frames** — the e2e
asserts on `options.env`, i.e. what was *sent*, never what was *accepted*.

**Leg B — the one-shot constraint is unchanged.**
```
grep -arnE 'chunk|split the suite|multi-part|continuation' bakeoff/src/spec-agent.ts \
  bakeoff/src/spec-freeze.ts bakeoff/src/spec-validate.ts   → exit 1, zero hits
spec-agent.ts:141  "A JSON object with exactly two keys … No prose outside the JSON."
subscription-caller.ts:1894  tools: []      ← no Write to spill into
```
The ceiling was raised 64k→128k; the requirement that the whole suite fit in one
assistant turn was not removed. At the ceiling it throws terminally
(`spec-agent.ts:1200`). Run 4's inputs were the largest of any run — ticket text
10,645 chars against run 3's 1,455, plus an 80 KB PDF re-sent on **every** spec call.

**What closes it.** Pin the seat (`DASHBOARD_SPEC_MODEL=<a 128k-capable id>`) so
`default` cannot silently resolve to a 64k model, then re-run run 4's exact ticket
and read the dispatch sequence out of the event log. If it still overflows at
128000, the fix is structural: emit `testFiles` one per call and assemble host-side.
**Effort.** Hours to discriminate. Days if leg B fails — per-file emission changes
the draft contract, the freeze digest and `spec-validate`.
**Cost of leaving it.** You spend 49 minutes of quota to find out, which is what run
4 cost.

> **A3 MOVED, 2026-08-09.** The item that stood here — *"the background path skips the
> plan phase entirely"* — is **not** a blocks-the-run item and has been moved to **§3-B3**.
> A critic ran the category audit in both directions and this was the one misfile found.
> The reason in one line: the report's own evidence shows the run *proceeds*
> (`plan-record.ts:112 return interactive ? "ask" : "skip"`, and the quoted test asserts
> *"an unattended run never parks AND never calls the seat"*), so nothing there prevents
> a verdict — what changes is **which criteria the verdict is graded against**, which is
> this document's own definition of BLOCKS THE VERDICT. The cost of the misfile was not
> cosmetic: an owner reading section B to learn when a green is soft would not have found
> the criteria-provenance problem there.

---

### B. BLOCKS THE VERDICT — it reaches one, but you would have to check the work anyway

> **Ranking principle, REVISED 2026-08-09.** Ranked by how much of the verdict you have
> to re-derive by hand. B1 is first because it is the only item where a **published
> verdict cannot be reproduced at all**. B2 and B3 are about the verdict being graded
> against the wrong thing — B2 the wrong test half (a labelling error), B3 the wrong
> criteria. B4 fails **open**: it can only make a green verdict *incomplete*, never
> false.
>
> **What changed from the first draft.** The old B1 (held-out contamination) was ranked
> first on the claim that it "can make a green verdict false". That claim was wrong in
> its direction of harm and is corrected in full under B2 below. Old B2 → B1,
> old B1 → B2, old A3 → B3, and everything after shifts by one (old B3→B4 … old B7→B8).
>
> **A category audit was run in both directions** and is worth recording so a reader can
> tell "checked and clean" from "not looked at": no trust defect was found filed as
> cosmetic (C1/C2 never touch the scorer; C3 is test blindness about the preview only;
> C4/C5 are canvas and layout; the verdict path never reads the preview's servability),
> and exactly one cheap-direction misfile was found — A3, moved to B3.

#### B1. A published verdict that cannot be reproduced, because the artefact changed under it — and nothing on the gate path checks that the tree has stopped moving

> **HALF FIXED 2026-08-09 — the cheap half (step 5b) landed; the quiescence walk is
> CARRIED FORWARD and it is the half that would have caught this run.**
>
> **What landed.** `orchestrator.ts:#execute` — after `declaredDone` is computed and
> **before** `#setPhase(runId, "gate")`, a guard on the presence of
> `.bakeoff/self-report.json` refuses to enter `#gateFixLoop`. The run gets the
> **existing** honest outcome, not a new one: `#recordUnmeasuredBacklog` +
> `#finish("failed", { heldOutPass: null, falseFinish: null, … })`, which `run-report.ts`
> already renders as its no-verdict page. No new failure mode, no new `StopReason`.
> `grep -an "#gateFixLoop(" dashboard/server/src/orchestrator.ts` → **two** lines, and only
> one of them is a call: `2332` (the call, immediately below the guard) and `5125` (the
> definition). **There is no path to the gate that does not pass the guard** — and it holds
> across an auto-continue structurally rather than by a flag, because `#execute` is
> re-entered on every continuation and the workspace is re-read from disk each time.
>
> **THE PREDICATE IS FILE-PRESENCE, NOT `declaredDone`, AND THAT CHANGED MID-TASK ON
> EVIDENCE.** The first draft of the fix keyed on `!declaredDone`. Then the corpse was
> read: `…052c6e02`'s `self-report.json` is **7,930 bytes** and says `"status":
> "complete"` — a word the build prompt does not offer (`build-prompt.ts:491` lists
> `done|blocked|incomplete`) and `readSelfReport` does not accept, so it returns `null`,
> indistinguishable from no file at all. **Of the two runs on this machine that reached
> the end of a build, ONE used a word the reader knows.** A `declaredDone` guard would
> have denied a verdict to roughly half the owner's runs, including runs whose artefact
> was finished. So: no file → refuse; any file → gate.
> **Tests:** three arms over one harness in `orchestrator.test.ts`, differing only in
> what the builder writes, with an injected gate that WOULD score green and a call
> counter — plus a NEGATIVE CONTROL. The verifier independently reproduced the
> discriminating mutation (`!selfReportWritten` → `!declaredDone`): *"a builder that
> wrote a report reached the end of its turn and must be scored"*. That is literally the
> version that would have shipped without reading the corpse.
> **A fourth arm was added by the repair pass** because the guard's log line told the
> owner to *"Resume this run"* — which the server answers `409 not_resumable`. See
> Appendix R3; the test now pins the state and the sentence **together**.
>
> **FIXTURE CHANGE, AND IT IS PART OF THE FIX:** `FakeBuilder` now writes a
> self-report by default. It never did, so **every** orchestrator test was silently
> driving the not-declared-done path while looking like a normal build — which is why
> nothing noticed the gate opening on a run that had declared nothing.
>
> **WHAT THIS DOES NOT COVER, AND IT IS MOST OF THE PROBLEM.** File-presence does not
> establish quiescence. **This guard would NOT have refused `…052c6e02`** (report
> stamped 10:14, `server.mjs` 10:16:27). What it refuses is the narrower case where
> nothing was ever written. Note the mtime/quiescence walk could not have caught it
> either — the change was a *deletion*, and deletions leave surviving mtimes intact.
>
> **AND THE DOCBLOCK'S JUSTIFICATION WAS WRONG, CORRECTED IN PLACE (Appendix R3).** It
> claimed to catch "the run killed mid-build". It cannot: a killed build returns
> `{ kind: "cancelled" }` and is handled at `orchestrator.ts:2129` by `#aborted`, before
> the guard; a refusal returns at `:2147`, also before it. **The only shape that reaches
> the guard is a builder that RETURNED without writing its report** — turn/budget
> exhaustion, or a crash with no signal. That is a tree that has *stopped*, which is the
> opposite of the "still being written" hazard the guard argues from, and it is a
> materially weaker reason to withhold a verdict. The trade is still accepted; it should
> be judged on the reachable case.
>
> **RESIDUE.** The stop is recorded on the attempt ledger as a normal completion —
> `#finish` derives `endClass: status === "cancelled" ? "intentional" : "completed"`
> (`grep -an 'endClass: status ===' …/orchestrator.ts` → **`6709`**), so a run that never
> opened the gate closes as `"completed"` and is filtered OUT of the recovered-attempts
> announcement (`grep -an 'endClass !== null' …` → **`6508`**). The backlog page
> also prints the coarse heading *"the run was cancelled"* above a run that was not
> cancelled (the truthful sentence is underneath, under *"Why nothing was measured"*).
> **The machine-readable record of this new outcome is wrong in two places while only the
> prose is right.** `endClass` is a free string (`db.ts:274`) so a third literal is cheap;
> the backlog heading is a total `Record<StopReason, …>` and is not. Fix them together.

> **CORRECTED 2026-08-09 — THE FIRST DRAFT OVERCLAIMED THIS, AND IT WAS THE DOCUMENT'S
> CENTREPIECE.** The first draft said the re-score was run on `…052c6e02`'s
> **"untouched workspace"**, that **"the bytes are the same ones"**, and concluded the
> published verdict was **"an inverted verdict"**. A critic refuted that from the
> artefacts, and I reproduced the refutation:
>
> ```
> python3 -c "import json;print(json.load(open('dashboard/results/scores/run-2026-07-30T20-16-40-242Z-052c6e02.container.json'))['staging'])"
>   {'filesCopied': 39, 'bytesCopied': 11407715, 'excludedSample': ['.bakeoff', '.git'], …}
> # today's staging set, reproduced with a walk that excludes only .bakeoff/.git:
> python3 -c "import os
> root='dashboard/runs/run-2026-07-30T20-16-40-242Z-052c6e02/workspace'
> n=b=0
> for dp,dn,fn in os.walk(root):
>     dn[:]=[d for d in dn if d not in ('.bakeoff','.git')]
>     for f in fn: n+=1; b+=os.path.getsize(os.path.join(dp,f))
> print('stageable files now:',n,'bytes:',b)"
>   stageable files now: 37 bytes: 10284654
> ```
>
> **2 files and 1,123,061 bytes were staged on 2026-07-31 and are gone today.** It is not
> a staging-rule artefact — `git log --oneline --since=2026-07-31 -- bakeoff/src/gate.ts
> bakeoff/src/scorer.ts` → **no commits** — and no pair of surviving files accounts for
> it (exhaustive 2-subset search over all 37 files for a sum of 1,123,061 → `[]`).
> Crucially, **the first draft's mtime check could not have detected this**: the change
> was a *deletion*, and deletions leave surviving mtimes intact. The newest file in the
> tree is still `server.mjs 2026-07-31T10:16:27`, exactly as reported — and that fact
> proves nothing about the two files that left.
>
> **The hypothesis the first draft deleted is the one the evidence supports.** The run's
> own event stream shows the builder creating a `site/` subtree that no longer exists:
> `sqlite3 dashboard/data/runs.db "select count(*) from events where run_id='run-2026-07-30T20-16-40-242Z-052c6e02' and payload like '%site/%';"`
> → **152**, including `command: mkdir -p site/assets/fonts site/assets/world` and
> `cd site/assets/fonts`; `ls -1 …/workspace` today shows `index.html` at the root and
> **no `site/`**. The first draft's §6 doc-drift bullet retracting `http.ts:2601-2606`'s
> `site/` justification argued from today's tree against a claim about the run-time tree.
> **That retraction is itself retracted** — see §6.
>
> **What survives, and it is enough.** Today's 37-file tree passes GATE:boot and scores
> 28/28 (17 held-out + 11 visible). The published record says the app never booted. Those cannot both describe the
> same bytes, and **there is no surviving file list to reconcile them**:
> `ls -la dashboard/results/staging/` → empty. That is the finding. It is a strictly
> stronger argument for a quiescence guard than the inversion story was, because it does
> not depend on a claim the artefacts cannot support.

**The measurement.** Re-scoring today's `…052c6e02` workspace (which is **not** the tree
that was gated — see the correction above):

```
node <Appendix A> --run …052c6e02/results/run.json --out <scratch> --image bakeoff-scorer:1
  heldOutPass=true  falseFinish=false
  suiteExecution={"exitCode":0,"durationMs":32968,"testsTotal":28,"testsPassed":28,"testsFailed":0}
     ← 28 TOTAL = 17 held-out + 11 visible.  See B2; the split is measured below.
  PASS BLOCKING GATE:boot  (static mode: / answered HTTP 200 with 31373 non-blank bytes after 11 ms)
  All 12 GATE:* and REQ-001..REQ-016 PASS
```
against what it published on 2026-07-31:
```
python3 -c "import json;d=json.load(open('dashboard/results/scores/run-…-052c6e02.container.json'));print(d['container']['suiteExecution'])"
  {'exitCode': -1, 'durationMs': 0, 'testsTotal': None, …,
   'reportProblem': 'the app never booted, so the frozen suite was not executed'}
head -4 …052c6e02/results/verdict.md
  # DID NOT PASS
  13 things the ticket asked for are not there — 3 BLOCKING, 10 FUNCTIONAL.
```

**Negative controls, both directions.** Deleting only `index.html` from a scratch
copy reproduces the 2026-07-31 failure almost exactly (`FAIL BLOCKING GATE:boot …
answered HTTP 404 … 118 attempt(s) in 30012 ms` vs the original's 119/30026), so the
passing re-score is not a gate that passes on anything. And the **exact image that
produced the 404** — `fae56a4e…`, still on disk as `bakeoff-scorer:pre-specmode` —
also passes on today's tree: `heldOutPass=true`, 28/28 (17 held-out + 11 visible —
measured per-file from that image's own suite report, identical split to `bakeoff-scorer:1`).
The image is not the variable.
**What neither control tests is the hypothesis itself** — see the confidence note below.

**No quiescence guard exists.**
```
grep -rani "quiesc|mid-write|still being written|settle|stable for|mtime" \
  dashboard/server/src/orchestrator.ts dashboard/server/src/gate-attempts.ts bakeoff/src/scorer.ts
  → 19 hits, ALL the design-manifest sense of "settled". Zero for quiesc/mid-write/mtime.
  … (19 lines total, 0 shown — see the elision note below)
```

> **CORRECTED 2026-08-09 — evidence transcription in this document elides output without
> saying so, and a critic caught two instances.** (i) The `grep` above **summarises** 19
> hits into a classification instead of showing them, so a reader cannot check the
> classification; the honest form is to narrow the pattern until the real output *is* the
> quoted output. (ii) In the first draft's old B1, a `find dashboard/acceptance -type f
> -name '*.mjs'` was shown returning **two** lines when it actually returns **13** across
> two tickets — including a second same-basename pair,
> `t-621a2808720d755e/suite/{visible,holdout}/coglane-delivery.test.mjs`. Nothing signalled
> the truncation, so re-running the printed command gave a different result from the
> printed output. That block has been replaced in B2 with per-ticket commands whose full
> output is quoted. **Elisions elsewhere in this document are now marked `… (N total, M
> shown)`.**
`server.mjs` has mtime `10:16:27` local — **51 seconds after the gate finished**. The
build was still moving files while it was being scored.

> **CONFIDENCE, STATED HONESTLY — 2026-08-09.** The first draft's summary asserted flatly
> that *"the gate was opened on a workspace that was still being written"* while its own
> §5-11 conceded the staging counts do not fit. Both cannot stand. **The published
> verdict is refuted — it is not reproducible. Its cause is narrowed but not
> reconstructed, and the staging counts run the wrong way**: a workspace still being
> written should have had *fewer* files at gate time, not two more and 1.1 MB more.
> **No experiment was run that could have shown "mid-write" false.** The one that would:
> re-score after removing the two extra files the old record counted, or diff the old
> `filesCopied` against a fresh staging walk — neither is possible today because the
> staging directory is empty and stores counts, not a file list. The `site/` subtree is
> the leading hypothesis and it is consistent with both the byte delta and the event
> stream, but it is a hypothesis.

> **ONE DOCUMENT IS CORRECTED HERE, dated 2026-08-09** (the first draft claimed two;
> the second correction is withdrawn).
>
> **(i) STANDS.** `d19e7e8`'s commit body states:
> *"run-2026-07-30T20-16-40-242Z-052c6e02 failed GATE:boot in exactly that
> configuration"* — i.e. frozen STATIC when it needed SERVER. **Static mode boots
> today's artefact fine**, measured twice on two different images, 200 with 31,373
> non-blank bytes in 11 ms. The mode-selection change `d19e7e8` makes is good on its own
> merits and should stay; its diagnosis of *this run* is not supported. (Caveat now
> attached: this is today's tree, not the gated tree.)
>
> **(ii) WITHDRAWN.** The first draft declared `STATE-2026-08-02` §2's explanation (b)
> *"GATE:boot's static arm regressed"* **refuted**, on the grounds that "the failing
> image passes today on the same bytes". They are **not** the same bytes. Explanations
> (a) and (b) both remain open, exactly as `STATE-2026-08-02` left them, and
> discriminating them is still open work — it just cannot be done from the artefacts on
> disk.

**What closes it.** Require the artefact tree to be quiescent before staging — two
walks (max mtime + file count + total bytes) N seconds apart that agree — and refuse
to score with a named harness error rather than emitting a verdict when they do not.
The staging walk already exists in `stageArtifact` and already returns
`filesCopied`/`bytesCopied`. **Second, and independently: record the staged file
list, not just its count.** Had the 2026-07-31 record stored 39 paths, this section
would be a finding instead of a hypothesis.
**Cheaper interim, and it now sits ahead of the expensive run in §4:** the run was
`agentDeclaredDone: false` with `gate_stop_reason: cancelled`, so refusing to gate a
run that did not declare done would have caught this one.
**Effort.** Hours. The judgement call — how long quiescence must hold — needs the owner.
**Cost of leaving it.** A verdict you cannot reproduce is a verdict you have to re-derive
by hand, which is the entire thing this tool exists to avoid.

#### B2. The number called "held-out" is computed over the visible half too — a labelling defect, not a leniency one

> **CORRECTED 2026-08-09 — THIS WAS THE FIRST DRAFT'S #1 TRUST DEFECT AND ITS DIRECTION
> OF HARM WAS BACKWARDS.** The first draft called this *"the one that can make a green
> verdict false"* and ranked it above everything else. Three pieces of code it never
> opened, plus the data on disk, say otherwise. All four checks below were re-run by me,
> not taken on report.
>
> **(a) Merging is monotone in the direction of HARSHNESS.** `sed -n '1212,1250p'
> bakeoff/src/scorer-container.ts` — attribution is
> `const failing = matching.filter((spec) => !spec.ok);` then
> `outcome: failing.length === 0 ? "passed" : "failed"`. Adding visible specs to
> `matching` can only **add** failures. A criterion that would pass on the held-out half
> alone can be dragged to `failed` by a visible test; it can never be dragged the other
> way. **Including the visible half makes the gate strictly harsher.**
>
> **(b) The one leniency channel is sealed at freeze time.** The only way merging could
> be lenient is a criterion whose *only* evidence is visible — it would go
> `unasserted → passed` on visible tests the builder could read. That suite is refused
> before a build ever starts: `sed -n '1195,1204p' bakeoff/src/spec-validate.ts` pushes a
> **blocking** finding, *"criterion is bound to no HELD-OUT test. Every criterion is
> decided by the held-out half; a criterion with only visible evidence is decided by
> tests the builder can read"*; `sed -n '68,74p'` shows `blocking()` sets
> `mustRegenerate: true`; `sed -n '372,383p' bakeoff/src/contracts.ts` shows
> `assertSuiteUsable` **throws** `suite_not_audited` on any such finding; and
> `grep -an 'suite_not_audited' bakeoff/src/spec-agent.ts` → `:1283`, `:1523` throw when
> the regeneration cap is hit.
>
> **(c) It is empirically absent on this machine, for both tickets.**
> ```
> comm -23 <(grep -aoh 'REQ-[0-9]*' dashboard/acceptance/<ticket>/suite/visible/*.mjs|sort -u) \
>          <(grep -aoh 'REQ-[0-9]*' dashboard/acceptance/<ticket>/suite/holdout/*.mjs|sort -u)
>   t-ac91abe93759dc0b → EMPTY   (visible {001,003-009,011-014} ⊂ holdout {001-016})
>   t-621a2808720d755e → EMPTY   (visible {001,003,005-009}     ⊂ holdout {001-013})
> ```
> **Zero visible-only criteria exist.** Every criterion is bound to at least one
> held-out test, which is exactly what (b) guarantees.
>
> **(d) The "same basename in both halves" evidence was misleading.**
> `diff -q dashboard/acceptance/t-ac91abe93759dc0b/suite/{visible,holdout}/document-delivery.test.mjs`
> → **"differ"**. They are not the same file, so the first draft's conclusion — *"a
> builder that read `visible/document-delivery.test.mjs` and coded to it is scored on
> that same file under the name held-out"* — is **false**. It is scored on a
> *different* file that happens to share a basename.
>
> **What remains is real and still worth fixing**, which is why this section is not
> deleted: the merged count is **mislabelled**. `criterionCoverage` conflates the halves
> and `grep -acn 'visibility\|visible' bakeoff/src/contracts.ts` → `0`. Every
> "N/N held-out" this system has ever printed is really "held-out + visible". The remedy
> is cheap, not a protocol redesign — see below. **Demoted below B1.**

**The mechanism, restated correctly.** The scorer walks the whole frozen suite and both
halves execute; nothing downstream separates them again.

```
# the scorer walks the WHOLE frozen suite — no visibility filter
sed -n '1278,1302p' bakeoff/src/scorer-container.ts
  function inventorySuiteFiles(suiteDir) { … walk(suiteDir) }   ← recursive, no filter
# the co-primary metric filters by TIER ONLY
sed -n '1433,1441p' bakeoff/src/contracts.ts
  const gating = criteriaResults.filter((c) => c.tier === "BLOCKING" || c.tier === "FUNCTIONAL");
  return gating.every((c) => c.passed);
grep -acn 'visibility\|visible' bakeoff/src/contracts.ts   → 0
```

> **CORRECTED 2026-08-09 — THE FIRST DRAFT'S OWN FLAGSHIP NUMBER IS THE CONTAMINATED
> ONE, AND IT NEVER SAID SO.** "28/28 held-out green" appears in the thirty-second
> answer, in B1's re-score and in the negative-control comparison. It is the **merged**
> figure — the exact thing this section complains about, applied to this report's
> headline. Measured **from the scorer's own report**, which is better evidence than the
> `grep -c 'test('` a critic used, since it counts what actually executed:
>
> ```
> # per-file spec counts out of the container's own suite-report.json + node-test ndjson
> run 3  (t-ac91abe93759dc0b, bakeoff-scorer:1)  total=28  holdout=17  visible=11
>          playwright: holdout 14 / visible 10   node-test: holdout 3 / visible 1
> run 3  (same, bakeoff-scorer:pre-specmode)     total=28  holdout=17  visible=11   ← identical
> run 1  (t-621a2808720d755e, bakeoff-scorer:1)  total=21  holdout=14  visible=7
>          playwright: holdout 11 / visible 6    node-test: holdout 3 / visible 1
> ```
>
> **So: "28/28" is "28/28 total — 17/17 held-out, 11/11 visible", and run 1's "21" is
> "14 held-out + 7 visible".** Restated at every occurrence in this document. Note that
> once split, it *still* supports B1's conclusion — 17/17 held-out green on a tree the
> published record says never booted. And note the direction: because merging can only
> add failures, the true held-out-only result cannot be worse than the merged one.
>
> Also confirmed from an artefact rather than by reading: both halves execute.
> `grep -ao 'visible/[a-z0-9.-]*\|holdout/[a-z0-9.-]*' bakeoff/dry-run/runs/dryrun-A-DRYRUN-r0/score.jsonl`
> → both `visible/greeting.test.mjs` and `holdout/greeting.test.mjs`.

**What closes it — and it is not the days-long protocol trip the first draft claimed.**
Two changes, both cheap:
1. **Carry `visibleUnmet` / `heldOutUnmet` as separate REPORTED counts.** The join
   already exists — `ScorerPlan.criteria` knows the tier and
   `record.plan.files[].visibility` knows the half — it is simply not made. This is a
   reporting change; it does not alter any pass/fail decision, because (a) above means
   the merged decision is already the conservative one.
2. **Add a freeze-time assertion that no criterion's token appears only in `visible/`.**
   This makes (b)'s guarantee checkable at the artefact level rather than trusting the
   audit path, and it is the negative control this defect currently lacks.

**Effort.** Hours, not days. **The first draft said "Days… calibration FAILS rather than
skips across a protocol bump", and that citation is a misquote** — see the sequencing
note under B4.
**Cost of leaving it.** Every "held-out" number in every artefact and every document is
over-counted and silently includes tests the builder was handed. Nobody reading a score
can tell what the sealed half actually said. That is a reporting failure, not a false
green.

#### B3. The background path skips the plan phase entirely — the clarifying questions the owner watched will not happen

> **MOVED HERE FROM §3-A3 ON 2026-08-09.** Filed as BLOCKS THE RUN in the first draft;
> it does not block a run. It changes which criteria the verdict is graded against,
> which is a verdict problem. Sits next to B2 because both are "the verdict is graded
> against the wrong thing" — B2 the wrong test half, B3 the wrong criteria.

**Evidence.**
```
grep -an 'export function planPolicy' -A3 dashboard/server/src/plan-record.ts
  111:export function planPolicy(interactive: boolean): PlanPolicy {
  112:  return interactive ? "ask" : "skip";
plan-record.ts:104 — "A `skip` RUN MAKES NO SEAT CALL AT ALL, which is stronger than
  not parking and is the point."
✔ an unattended run never parks AND never calls the seat, and says why (834ms)
```
Run 4 was `interactive=1` and the owner personally answered PQ-1/2/3 (events seq
13/25/34/40). **This is a deliberate design choice, not a bug** — but the owner does not
currently know it. It also means run 4's plan artefacts are not evidence about the
unattended path, and that `inferredCriteria` — the plan phase's whole success
measure — remains unmeasured for background mode.

**Why this bites.** `inferredCriteria` is the difference between a run graded against
your words and a run graded against the grader's guesses:
`…3d4d1ccb` (detailed ticket, PASSED) = 2; `…052c6e02` (one sentence, two typos) = 16.
In background mode the ticket carries the entire load.

**What closes it.** A decision, then possibly hours of work: either accept it and
write tickets accordingly, or let an unattended run make the plan call and
auto-answer with `ifUnanswered` defaults so the assumptions at least land in
`plan.json` and `assumptions.md`. The machinery exists — the question objects already
carry `ifUnanswered` and `criterionIfDefault`, and the expiry path already does
exactly this (`✔ when nobody answers, the run PROCEEDS and the unanswered question
becomes a recorded assumption`).
**Cost of leaving it.** Silent. The run finishes and you never learn it invented 16
criteria until you read `assumptions.md`.

#### B4. The visual gate cannot fail a run, for four independent reasons — closing any one changes nothing

Files under BLOCKS-THE-VERDICT because it means the verdict is silent on visual
quality, but ranked last of the graded-against-the-wrong-thing group because it fails
**open**: it can only make a green verdict incomplete, never false.

```
sed -n '6734,6748p' dashboard/server/src/orchestrator.ts
  visualGateInputFor returns { runId, runsRoot, workspace, screenshotDir, captures }
  ← five fields. `mode` is absent.
grep -an 'DEFAULT_VISUAL_SUBSTANCE_MODE' dashboard/server/src/visual-substance.ts
  692:export const DEFAULT_VISUAL_SUBSTANCE_MODE: VisualSubstanceMode = "shadow";
  1036:  const mode = input.mode ?? DEFAULT_VISUAL_SUBSTANCE_MODE;
grep -arn 'mode: *"gating"' --include='*.ts' dashboard/server/src bakeoff/src | grep -av '\.test\.'
  → exit 1, zero hits    (positive control without the exclude: 23 hits, all in tests)
grep -arn 'innerTextLength' bakeoff/src bakeoff/docker
  → exit 1, zero hits    (positive control: 4 hits in visual-substance.ts)
```
Four independent blockers, each sufficient alone: **(A)** `PageObservations`
(`scorer-container.ts:560-565`) carries 4 fields and no `innerTextLength`, so the one
unlocked observation cannot compute. **(B)** `pageEvidence` has zero production
producers, so EMPTY-FRAME withholds as `corroboration_missing`. **(C)** EMPTY-FRAME
has no answer producer at all — the only one on the path hardcodes the id of the
shadow-*locked* observation, and `visualGatePrompt` has zero non-test callers.
**(D)** the tap is shut. HEAD's own doc names A and D; B and C are not in it.

**The sink is live**, which is what makes this a trust defect and not dead code:
```
sed -n '272,290p' dashboard/server/src/verdict.ts
  272:function findingCount(input: VerdictInput, tier: ApiCriterionTier): number {
  276:    visualFindingsAt(input, tier);        ← visual findings enter the count here
  284:export function computeOutcome(input: VerdictInput): VerdictOutcome {
  285:  if (findingCount(input, "BLOCKING") > 0 || findingCount(input, "FUNCTIONAL") > 0) return "fail";
```

> **CORRECTED 2026-08-09 — the first draft cited the wrong line as "the sink", and it was
> the load-bearing sentence for "this is a trust defect and not dead code".** It named
> `verdict.ts:462`. `sed -n '450,470p' dashboard/server/src/verdict.ts` shows `:462` is
> inside `renderWhy()`, a branch that returns `[]` to *suppress* the "no requirement
> could be named" paragraph when a visual observation is the recorded reason — a
> rendering guard that decides nothing. The real sink is `findingCount` at `:276`
> feeding `computeOutcome` at `:284-285`, as quoted above. **The conclusion survives
> intact; the citation did not.** `:462` remains worth knowing as a secondary note: it
> is why a run failed by a visual finding alone is not additionally reported as a
> grader defect.

**What could have shown it works, and did not.** The module's own tests assert
`result.findings` deepEqual `[]` at `:173`, `:201`, `:309` and `:575` — *including*
the case that synthesises `mode: "gating"` and the loop that runs both modes. No test
anywhere expects a non-empty findings array. And `find . -name 'visual-gate.md' -not
-path '*/node_modules/*'` returns nothing: the gate has never produced a report from
a real run.

**What closes it.** All four in order — `innerTextLength` into `PageObservations` and
emitted from the container capture; thread it on as `pageEvidence`; give EMPTY-FRAME
a producer; *then* pass `mode`. Opening the tap first is worse than useless — it would
flip `gating` true on rows that are still `unknown`.
**Effort.** Days — justified by the edit surface, not by a recalibration cost: it touches
observation collection in `scorer-container.ts`, the co-primary in `contracts.ts`, the
protocol types, and it needs an image rebuild.

> **CORRECTED 2026-08-09 — the sequencing note here was built on a misquote, and the
> misquote was doing the work.** The first draft read: *"B1 and B3 are the same trip into
> `bakeoff/`. Both are protocol bumps requiring an image rebuild and full recalibration
> (**calibration FAILS rather than skips across a protocol change**). Two days of work
> land together or neither does."*
>
> The parenthetical is not what the source says.
> `grep -arn -i 'fails rather than skip' --include='*.ts' dashboard bakeoff | grep -av dist`
> → `dashboard/server/src/calibration.test.ts:16` — *"IT FAILS RATHER THAN SKIPS. There
> is no `docker` probe here that turns green when the daemon is absent, and no
> `test.skip`."* **That is scoped to a missing Docker daemon, not to a protocol
> version.** The protocol machinery says nothing about calibration at all:
> `bakeoff/src/scorer-protocol.ts:38 SCORER_PROTOCOL_VERSION = 1 as const`, with version
> checks only in the plan/result parse guards at `:935` and `:1176`. And recalibration
> is **not** a days-scale cost — the measured figure in
> `dashboard/server/src/calibration/grade-fixture.ts:135-150` is *"seven real
> `--network=none` containers at concurrency 3: 8 tests, 8 pass, 0 fail, 72.6 s"*.
> **Seconds, not days.**
>
> **What actually survives of the sequencing note:** B2 and B4 both live in `bakeoff/`
> and both want an image rebuild, so batching them is still sensible. But B2 is now
> hours, not days (it is a reporting change — see B2), so **"two days land together or
> neither does" is withdrawn**: B2 no longer needs to wait for B4. The only days-scale
> item in `bakeoff/` is B4. HEAD's own doc records the self-imposed cause of the
> avoidance: every workflow brief told agents to stay out of `bakeoff/`.
>
> Note the scope of this correction: it applies to the **Days**-scale estimates only.
> The Minutes estimates elsewhere in this document are countable edits and stand as
> written — B5's "five call sites plus the metered pair", B6's three run ids, C5's one
> formatter branch.

#### B5. No run records what it spent — the writer has zero production callers and has never written a row

> **FIXED 2026-08-09 — and there were TWO defects here, not one. The second was worse
> than the missing callers.**
>
> **(1) THE MERGE BUG, FOUND AND FIXED.** `#sink` — the fix round's event sink —
> **ASSIGNED** the token total onto the run row: `store.updateRun(runId, { tokens:
> toApiTokens(totals) })`. The total is cumulative only *within the call*, so **the first
> token event of the first fix round overwrote everything spec, design and build had
> accumulated** — a run's reported spend went DOWN when it started fixing. `#sink` now
> takes a `carried` total captured before `builder.build()`, exactly as `#buildPhase`
> already did, and merges. This is HANDOVER's `orchestrator.ts:1663` item, whose citation
> §6 records as stale and whose verdict §6 records as UNMEASURED — it is now measured,
> confirmed real, and closed.
>
> **(2) THE LEDGER, WIRED.** `#recordSpend` and `#recordMetered` added and called from
> the **five** `describeTokens` sites that already had the numbers and threw them at a
> log line: spec, audit, builder (once per segment), fix (once per round), and judge —
> the judge call placed **above** the `report.ran` guard, because a judge that ran and
> returned "unavailable" still spent what it spent. Metered: the design lane's own image
> counter, and the video lane's returned record. **Never from a `BuildEventSink.tokens`
> callback** (`db.ts`'s docblock says adding from that inflates by a multiple). Both
> skip a zero contribution; neither can throw a run down. **No money anywhere** —
> `costUsd` stays the documented `null` invariant.
> **Tests:** four in `orchestrator.test.ts`, incl. *"a fix round ADDS to the run's tokens
> — it does not replace them"* and *"the ledger ADDS across rounds rather than
> overwriting"*. The verifier reproduced the attribution mutation (`"fix"` → `"builder"`)
> → `500007 !== 500000`, which is exactly the shape of a ledger whose seats are merged
> rather than separated. `db.ts` was **not** modified: the writers were already correct
> and already tested; the defect was purely the absence of callers.
>
> **THE FIXTURE WAS WRONG TWICE AND THE DEBUGGING IS WRITTEN INTO THE TEST** — the lane's
> first harness used a web-ui ticket (two build segments) with `maxAttempts=1` (so no fix
> round ever ran and a `fixRounds === 1` assertion passed spuriously). Both faults are
> recorded verbatim in the fixture's comment.
>
> **RESIDUE.** (a) `ApiSpendSeat` (`api-types.ts:165`) has **no member** for the PLAN
> seat (`orchestrator.ts:2759`) or the ADVERSARY pass (`:5858`); both compute real totals
> and both still go only to a log line, so `spend.md` understates any run that ran a plan
> dialogue or a debugfix pass. On an unattended run the plan seat is now skipped, so this
> will not bite *this* run. (b) The **video** metered leg is wired but **undriven by any
> test** — without `gemini-video.sh` on this machine `legsAttempted` is 0 and the
> zero-guard skips it. The image leg is proven by test and mutation. Reported as data,
> not patched. (c) `seat_spend` and `metered_spend` have held **0 rows since they were
> created**, so the next run is their first live exercise ever — treat the first rows as
> data to check, not as a report to trust.

```
grep -arn 'recordSeatSpend\|recordMeteredSpend' --include='*.ts' dashboard/server/src dashboard/src bakeoff/src | grep -av '\.test\.ts'
  api-types.ts:957, :961   (docblocks)
  run-report.ts:598        (error-message literal)
  db.ts:1554  recordSeatSpend(runId, entry)     ← definition
  db.ts:1631  recordMeteredSpend(runId, entry)  ← definition
  — no production caller
sqlite3 dashboard/data/runs.db "select 'seat_spend',count(*) from seat_spend union all select 'metered_spend',count(*) from metered_spend;"
  seat_spend|0     metered_spend|0
```
The writer landed `2026-07-30 04:45` — **before** runs 3 and 4, both of which should
have populated it. Run 4 additionally has `runs.output_tokens = NULL`, so a
51-minute run that burned a full Opus-class authoring turn reports no spend at all.
`costUsd: null` is a deliberate, documented invariant and should stay; the defect is
that the *token and call ledger the invariant points you to instead* is never written.

> **CORRECTED 2026-08-09 — "Zero of the 104 commits touched it" carried no command.**
> A critic flagged it as an unmeasured absence claim in a document whose own rule is
> that a claim without a command is worthless. Measured now:
> `git log --oneline --since=2026-08-02 -- dashboard/server/src/db.ts` → **3 commits**
> (`3ef4cb1`, `2941bf3`, `b1d5158`), so the file *was* touched — but none added a caller,
> which is the actual claim and which the `grep` block above already proves
> independently (`recordSeatSpend|recordMeteredSpend` outside tests → definitions only).
> **The sentence is corrected to: three commits touched `db.ts` in the window and none
> of them gave either writer a production caller.** The `seat_spend|0 metered_spend|0`
> row counts are the end-to-end confirmation.

**What closes it.** Call `store.recordSeatSpend(...)` from the seat-report path that
already formats the numbers into a log line and throws them away
(`orchestrator.ts:2713-2714` and its four siblings). The schema, the writer, the
`spend.md` renderer and the client mirror all exist and are tested from
`recordSeatSpend` outward.
**Effort.** Hours — five call sites plus the metered pair.
**Cost of leaving it.** You cannot answer "what did that cost" for any run, ever, and
quota planning for unattended operation is guesswork.

#### B6. `npm test` is red on the owner's machine, and the failing test degrades with every run he does

> **FIXED 2026-08-09 — and the fix was NOT to weaken the assertion, which is the failure
> mode a scoping fix invites.**
> `plan-phase.test.ts` — the plan-record loop ran over **every** row of the live
> `runs.db`, so run 4's real `plan.json` failed it and **every future run the owner does
> would add another**. The loop is scoped to a new module constant
> `PRE_PLAN_PHASE_RUN_IDS` holding the three ids that existed before the phase shipped —
> **a set that cannot grow**. Two things were added so the scoping cannot become
> vacuity: **(1)** a non-vacuity guard (`assert.ok(preserved.length > 0, …)`) that names
> every row present, so a filter matching nothing goes red instead of silently passing;
> **(2)** a real **negative control** — a `PlanRecord` is written into a temp dir and read
> back through the *same* `readPlanRecord` call before any of the nulls above are
> believed, because `readPlanRecord` returns `null` for a missing dir, a missing file and
> an unparseable file alike. The file's read/render/re-score loops still run over every
> row, so they get **stronger** as the owner uses the product; only the plan-record claim
> is scoped.
> Both guards fired live in the final run's TAP diagnostics: `# 3/3 pre-plan-phase run(s)
> checked for a back-filled plan record; 1 later run(s) are exempt by design`.
> Three mutations, all restored: adding the plan-carrying run to the constant, scoping it
> into vacuity (the guard fires), and breaking `readPlanRecord` outright in the lane's
> private build (the control fires).
> **Measured by the final check, not by the lane:** the server suite is `tests 1872 /
> pass 1869 / fail 0 / skipped 3 / todo 0`, **EXIT 0**, against a re-measured baseline of
> `1835 / 1830 / fail 1 / skipped 3 / todo 1`, **EXIT 1**. The `todo 1 → 0` is B8a.

```
cd dashboard/server && npm run clean && npm test    → ℹ fail 1, EXIT=1
✖ the three runs already on disk still read, still render, and still name their suites
  actual: { awaiting: false, parkedAt: '2026-08-04T11:08:26.813Z', folded: true, … }
  expected: null
```
`plan-phase.test.ts:988-994` asserts `readPlanRecord(...) === null` for **every row**
in the live `dashboard/data/runs.db`, with the message *"<runId> predates the plan
phase and must stay that way"*. Run 4 has a real `plan.json`, so it fails — and every
future run writes one, so it never recovers. Its own diagnostic already contradicts
its name: `ℹ 4 historical run(s) read back`. Deterministic: 2/2 full runs, 2/2
targeted.

**Worse than a normal red.** Lines 944-950 return early when the DB is absent, so the
test is **green on a clean checkout and red only where there is state to check** —
the gate is weakest exactly where it has something to measure.

**What closes it.** Pin the loop to the three pre-plan-phase run ids the test is named
for. **Effort.** Minutes.
**Cost of leaving it.** The owner's "suite green" quality gate cannot signal at all,
so the next real regression lands invisibly behind a red that everyone has learned
to ignore.

#### B7. The browser suite is red twice in a row on different tests, over a real product race

> **FIXED 2026-08-09 — in the PRODUCT first and the harness second, which is the order
> this item asked for.**
> `dashboard/src/lib/use-run-stream.ts` — ingest now refuses to fold a stream event into
> an **empty** SWR cache (`if (detailRef.current === undefined) { missedEvent.current =
> true; return; }`), placed after graph/trace ingest so the canvas and the trace still get
> every event, with a second effect firing one catch-up `mutate()` so a status that
> changed between snapshot and replay is not left stale. **The mechanism was measured,
> not deduced:** SWR discards the response of any request that started before a mutation,
> so writing `undefined` into the cache also throws away the detail already in flight, and
> `pollIntervalFor(undefined) === 0` then seals it. `pollIntervalFor` was deliberately
> **not** widened — `status === undefined` is equally true of a deleted run, and a
> non-zero interval there polls a 404 forever. Only then was the `e839d51` harness shape
> (pre-fetch the body once, serve from memory) ported to the three remaining specs;
> `grep -a -rn 'route.fetch()' dashboard/tests` now returns only comments.
> **Test:** `blank-cache.browser.spec.ts` — the failing arm plus a matched control that
> differs only in the injected delay.
> **The verifier reproduced the mutation 5-of-5, not 1-of-5**, which is the point: a race
> that passes once is not fixed. Dropping the `return;` failed all five repeats at 15.2 s
> each on `getByRole('toolbar', { name: 'Run panels' })`, while all five control arms
> stayed green.
> **Measured by the final check:** the browser project ran **twice consecutively, 252
> passed / 1 skipped / 0 failed, EXIT 0 both times, with byte-identical 253-title sets**
> — against a baseline that was red twice on *different* tests. The flake did not
> reproduce.
> **RESIDUE:** `detailRef` is written in an effect rather than during render, so there is
> a sub-frame window in which an event is still skipped from the fold. The catch-up read
> covers it; if that second effect is ever removed the window reopens silently.

Two consecutive full runs, different failures each time (5 then 2) — nondeterministic,
not ordering. All seven are the same assertion timing out. The tests pass 6/6 in
isolation and 28/28 with their own file alone.

The captured failure snapshot is `- main: - heading "Run" [level=2]` and nothing else
— which is `page.tsx:727`, the branch for `run===undefined && error===undefined &&
!isLoading`. **Not an error page: a blanked cache.** The mechanism is self-sealing:
`use-run-stream.ts:592-596` returns `undefined` when the detail has not landed,
`:944-955` writes that `undefined` into the SWR cache with `{ revalidate: false }`,
and `:839 if (status === undefined) return 0;` means it then never polls again.

A fix for this exact flake shipped three commits ago (`e839d51`) to **one** spec file
and was not propagated: `grep -a -rn 'route.fetch()' dashboard/tests` still finds the
pre-fix shape in `prose-guard.browser.spec.ts:517`, `:853`,
`result-surfaces.browser.spec.ts:63`, `panel-copy.browser.spec.ts:418`.

**What closes it — and the order matters.** Fix the *product* first (make the blank
cache non-final: drop `{ revalidate: false }` when `previous===undefined`, or let
`pollIntervalFor` retry on an empty cache), **then** port the harness helper to the
three sibling specs. Doing the test-side change first makes the product defect
unobservable — that is this repository's signature defect being manufactured on
purpose.
**Effort.** Hours for the product fix plus a regression test that deliberately loses
the race; hours for the three mechanical harness edits.

#### B8. Five smaller trust holes, none blocking on its own

> **PARTLY FIXED 2026-08-09 — B8 IS NOT CLOSED. Per sub-item, because three of the five
> moved and two did not:**
>
> - **B8a, the expired `todo`** — **FIXED.** The `{ todo: … }` option is deleted from
>   `contract-parity.test.ts:1367`. **There was no RED before, and that is the finding:**
>   the blocker had genuinely shipped (`use-run-graph.ts:225` reads `stages: data.stages
>   ?? []`), so the test went green immediately. The green was not accepted on its own —
>   it was proved still *able* to fail by pointing the test's `CLIENT_GRAPH_HOOK` at a
>   scratch copy of the hook with that line deleted (no other lane's file was written to),
>   which produced `fail 1` where the pre-fix run could only ever have produced `todo 1`.
>   Observable proof in the final check: `todo 0`, and the eighteenth test now counts.
> - **B8b, the typecheck compiling calibration's broken fixtures** — **FIXED, AND THE
>   FINAL CHECK MEASURED IT INERT TODAY.** `"results"` added to
>   `dashboard/tsconfig.json`'s `exclude`. The report's stated path needed correcting: the
>   artefact *sources* live under `server/` and were already safe; the hazard is the
>   **staged copy** the gate makes under `<run-root>/staging/`. The condition was
>   *engineered* rather than waited for — the real broken fixture was copied where the
>   gate stages it — giving `TSC_EXIT=2` before and `0` after, with `--listFiles | grep -c
>   /dashboard/results/` going `1 → 0`, which rests on tsc's own program construction
>   rather than on the fixture happening to be broken. **But `dashboard/results` holds 0
>   `*.ts` today, so the final check's `EXIT=0` did not exercise the entry.** The claim is
>   sound and currently unexercised.
> - **B8c, the eleven-day-old 0/4 e2e** — **PARTIAL.** The fixture is fixed: `T-2`'s
>   `expect(rendered.length).toBeGreaterThan(20)` tripped the harness's own
>   `proseLengthFloorFindings` rule (BLOCKING at exactly 20), so `deterministicAudit`
>   rejected the e2e's own draft and **no scorer container was ever started in any of the
>   four cases**. It now asserts what the rule's remedy asks for. **Lowering the floor
>   under 20 to slip past the rule was available and was deliberately NOT done** — it
>   would have left the fixture asserting the very thing the harness exists to condemn,
>   while reporting green. Measured **0/4 → 31/31, exit 0**, four real sealed
>   `--network=none` containers, image digest unchanged. **The other half is a HANDOFF:**
>   `npm test` globs `dist/*.test.js` and the harness is `test/*.mjs`, so this 31/31 is
>   invisible to anyone running the documented command — and `runner.e2e.mjs` and
>   `scorer-modes.e2e.mjs` are unreachable the same way. Adding a `test:e2e` script moves
>   the scorer digest (`package.json` **is** COPYed in the Dockerfile's stage 1) and was
>   correctly declined. See Appendix R4 for the hand invocation.
> - **B8d, the race-vacuous `count-0` sweep** — **NOT FIXED. Zero edits.** Audit only:
>   those files are `.spec.ts` and mutation-proving a browser guard needs Playwright,
>   whose `webServer` binds ports the lane did not own. **The report's own heuristic could
>   not be found in the tree, so the denominator below is a different one and the two
>   numbers are NOT comparable:** 77 raw occurrences, 9 inside comments, **68 real guards
>   checked → 9 race-vacuous + 1 dead-role**. (11 more were rescued by one level of helper
>   resolution — the blind spot §5 names — and 5 by treating non-literal positive counts
>   as paint gates.) The 9: `design-lock:579, :835`, `motion-readout:477, :489`,
>   `ticket-redundancy:340, :366, :370, :372, :375`. `design-lock:835` is the one this
>   document already mutation-proved, which is a point of agreement between the two
>   heuristics. Each fix is a one-line reorder with zero semantic change. **The dead-role
>   finding is worse and is now instance eighteen — see below.**
> - **Codex held-out read enforcement** — unchanged, still scoped out, nothing to do.
>
> **AND THIS ROUND CREATED INSTANCE EIGHTEEN, WHICH IS RECORDED AS A DEFECT AND THEN
> FIXED.** `rail.browser.spec.ts:390-397` asserted the absence of a `run detail` button
> **and** of a `role="tablist"`, under a docblock claiming a reproduced mutation. Neither
> could fail: `grep -arn "tablist" dashboard/src` → **0**, and C5-1 renamed the chip's
> button to the literal `overview`. Worse, C5-1 **mounted `RunHud` into the product for
> real** — so the exact mutation the docblock claimed to have reproduced became the
> shipped product and the test stayed green. The tablist assertion is deleted outright
> (nothing has ever rendered that role); the pair is replaced by the rule that is
> actually true and actually breakable — the chip and the Overview panel are
> **complements, asserted in both directions**, so a product that dropped either surface
> goes red. Proved by three product mutations, in each of which the **old** version was
> run side by side from a temporary spec file and stayed green. That side-by-side is the
> technique worth reusing; see Appendix R5.

- **A contract test is still `todo` after the edit it was waiting for landed.**
  `contract-parity.test.ts:1367` carries `{ todo: "wave 4 owns use-run-graph.ts; flip
  the field to required in the same commit" }`; `use-run-graph.ts:225` now reads
  `stages: data.stages ?? [],`. Node reports it under `ℹ todo 1`, separate from pass
  and fail — **a failure there cannot fail the suite.** The signature defect in its
  purest form: a check that cannot go red, left standing after its reason expired.
  Minutes to delete the option.
- **`bakeoff/test/quality-gating.e2e.mjs` has been 0/4 since 2026-07-29** — the
  harness's own bad-test audit now rejects the e2e's fixture
  (`expect(rendered.length).toBeGreaterThan(20)` at `:179`), so it fails at step 1 and
  **no scorer container is ever started**. `bakeoff`'s `npm test` globs `dist/*.test.js`
  and cannot reach either e2e file, which is why an eleven-day-old red went unnoticed
  behind a green 121/121. One line to fix, minutes; add a `test:e2e` script so it
  cannot hide again.
- **`dashboard` typecheck compiles calibration's deliberately-broken fixtures.**
  `dashboard/tsconfig.json` excludes `node_modules, server, dist, .next, .next-test`
  — not `results`, where `grade-fixture.ts:157` points the calibration run root. Run
  during a calibration it exits 2 on a file that is broken on purpose. One array
  entry.
- **Twelve of the 22 race-vacuous `count-0` browser guards sit in specs added since
  2026-08-02**, and the sweep HEAD's own doc called for was never done. Only
  `design-lock:833` was mutation-proven vacuous (1 red / 5 green); the other 21 are
  a heuristic match, marked UNMEASURED in §5. Related: 73 of 88
  `getByRole({ name })` matchers lack `exact: true`, so they match by substring —
  including the one inside the `openRun` retry helper.
- **Codex has no held-out read enforcement** (`codex-builder.ts:137
  sandboxMode: "workspace-write"`, `:143 networkAccessEnabled: true`, no `denyRead`)
  against the Claude driver's two layers. **Latent, and the scope-out is genuinely
  enforced** — and unusually for this repo the guard has a real negative control:
  `api.test.ts:246-250` POSTs the Codex model id and asserts the 409. Nothing to do
  while it stays scoped out.

---

### C. BLOCKS THE WATCHING — canvas, animations, preview, the experience

#### C1. The preview link is still an infinite redirect loop, and the card blames the backend for it

> **FIXED 2026-08-09 — the ROUTING half. The card that blames the backend is a HANDOFF
> and is still open.**
> **It took BOTH lines, and this item's own prescription was insufficient** — see the
> repair-pass correction further down, which is now measured twice over.
> `next.config.ts`: `skipTrailingSlashRedirect: true`, **and** the rewrite source moved
> from `/api/:path*` to `/api/:path(.*)`. `:path*` compiles to a regex where the trailing
> slash sits OUTSIDE the capture, so the rewrite itself strips it and the backend 302s it
> back forever; `:path(.*)` keeps it.
> **Measured on the real system**, backend on 4176 and a real `next build` + `next start`
> on 4319: the slash form answers **`200` in ZERO hops**, the no-slash form costs exactly
> one, and the full blast radius (`/api/health`, `/api/models`, `/api/runs`, the CSS and
> JS assets, both page routes with and without slashes, and `/nope`) is unchanged —
> including a `409 no_index_html` refusal that keeps its status and its body.
> Re-confirmed at the final check on the built client, and the preview screenshot shows
> the artefact rendering fully styled.
> Two mutations, each producing a **different** diagnostic chain: removing the flag gives
> a 308/302 alternation; reverting the rewrite source gives **302-to-itself**, nine hops
> — which is precisely the failure this item's prescription would have shipped.
> **RESIDUE, DECLARED:** `skipTrailingSlashRedirect` is wider than `/api/*` — Next no
> longer canonicalises PAGE urls either, so `/runs` and `/runs/` both answer 200 with no
> redirect between them. Harmless for a loopback tool that already sends
> `X-Robots-Tag: noindex`, but it is a real behaviour change.
> **THE HANDOFF (second half of C1, NOT DONE):** `previewSiteFrom`
> (`src/lib/spec-pipeline.ts:615`) still renders `PREVIEW_UNREACHABLE` — *"Is the backend
> process running?"* — for any 3xx, which would now be a **lie about a healthy backend**.
> The routing fix removes the symptom for the reachable case (the probe's `fetch` gets a
> 200 instead of throwing on the redirect cap), which is why C1 is marked fixed rather
> than partial. **Do NOT "fix" it with `redirect: "manual"` alone** — that was measured to
> return `{status: 0, type: "opaqueredirect"}`, so `previewSiteFrom(0, null)` renders kind
> `refused` with code `"0"` and hides the iframe and the link: a *different* wrong
> sentence. The fix that works is `redirect: "manual"` **plus** a new `PreviewSite`
> member for `response.type === "opaqueredirect"` whose copy blames the client's route,
> not the backend.

Reproduced statically from three shipped artefacts, without binding a port:
```
git show HEAD:dashboard/next.config.ts | grep -c "trailingSlash"          → 0
grep -ran "skipTrailingSlashRedirect" … .                                  → exit 1, 0 lines
python3 -c "…json.load(open('dashboard/.next/dev/routes-manifest.json'))['redirects']"
  [{"source":"/:path+/","destination":"/:path+","permanent":true,"internal":true,"priority":true, …}]
sed -n '2674,2682p' dashboard/server/src/http.ts
  if (resolved.kind === "directory") { if (!url.pathname.endsWith("/")) {
      response.writeHead(302, { Location: `${url.pathname}/${url.search}`, …
```
`/api/runs/<id>/preview/` → Next 308 → slashless → rewrite to `:4176` → server 302
back to the slash form. Loop. The client target is same-origin by default
(`spec-pipeline.ts:545` builds the path, `api.ts:25` leaves `API_BASE` empty, and
there is no `.env` under `dashboard/`).

**Worse than STATE described.** The servability probe uses `fetch()` with the default
`redirect: "follow"`, so it throws on the redirect cap and lands on
`PREVIEW_UNREACHABLE`. Both the iframe and the "open this site in a new tab" link are
gated on `site?.kind === "servable"`, so the owner gets no thumbnail, **no link at
all**, and the sentence *"Could not reach the dashboard API… Is the backend process
running?"* — while the backend is running fine. The card misdiagnoses its own routing
bug and sends him to restart a healthy server.
**What closes it.** `skipTrailingSlashRedirect: true` in `next.config.ts` — the
documented flag that suppresses exactly that manifest entry and leaves every other
route alone. Needs a rebuild (the manifest is baked at build time). Separately, make
the probe `redirect: "manual"` so a routing bug can never again present as "your
server is off".
**Effort.** Minutes for the config line; ~1 hour with the probe wording and a check
that actually traverses Next.

> **CORRECTED 2026-08-09 (repair pass) — THE PRESCRIPTION ABOVE IS INSUFFICIENT, AND
> MEASURED TO BE.** `skipTrailingSlashRedirect: true` ALONE does not close C1. The
> rewrite `source: "/api/:path*"` itself strips the trailing slash, so the backend
> keeps 302-ing the slash form back and the loop survives the flag. The rewrite source
> must ALSO become `"/api/:path(.*)"`, which preserves it.
>
> Not argued — mutated. With the flag on and only the rewrite reverted, the verifier's
> M2 produced: `DID NOT TERMINATE after 9 hop(s): 302 …/preview/ -> /api/runs/…/preview/`
> repeating, i.e. a 302 to itself. Both halves shipped together in
> `dashboard/next.config.ts` this round and the preview now answers in ZERO hops
> through the client origin. The probe-wording half of the prescription is still open.

#### C2. The page you do reach renders unstyled, because the owner's artefact is root-absolute

> **FIXED 2026-08-09 — by re-pointing the served document, and the two alternatives were
> rejected for stated reasons rather than for taste.**
> `http.ts#sendPreviewFile` now buffers a served `text/html` or `text/css` (up to
> `PREVIEW_REWRITE_MAX_BYTES` = 4 MiB) and prefixes the **preview mount** onto every
> root-absolute reference: quoted `href|src|poster|action|formaction`, `srcset`/
> `imagesrcset` per candidate with descriptors preserved, and `url(/…)` in inline
> `<style>`, `style=""` and served stylesheets. The mount is taken from the client's own
> spelling, so a nested document is re-pointed at the preview ROOT rather than at its own
> directory and the run id is not re-encoded a second way. Function replacers throughout,
> so a `$` in a run id cannot become a substitution pattern. **No CSP change was needed.**
> **Tests:** three in `preview-through-next.test.ts` and two in `preview-route.test.ts`
> (the latter needing no Next, incl. one proving the nested-document mount). Mutation
> (the content-type discriminator neutered, compiling clean) reproduced by the verifier:
> **five** failures across both files, each naming the address that escaped the mount —
> and **C1's hop-count tests stayed green**, so the two fixes are independently
> observable.
> **Measured on the real artefact through the client origin**: 7 responses, all 200
> (document, stylesheet, image, script, three fonts), 0 failed requests, 245 CSS rules,
> `bodyFont "Figtree…"`. Before: 0 rules, `Times`, 404 on `/styles.css` and `/main.js`.
> **The negative control is the other artefact**: run 1's relative document still goes out
> with `href="styles.css"` untouched and renders identically to before.
> **WHY NOT `<base href>` — and this item's stated trap is right for the WRONG REASON.**
> `base-uri 'none'` does block it (measured in Chromium, console error and all), so that
> half is confirmed and no longer UNMEASURED. **But even with the CSP relaxed a `<base>`
> could not have fixed C2**, because a root-absolute URL resolves against the base URL's
> **ORIGIN, not its path** — `/styles.css` stays `/styles.css`. Measured in the same
> probe: the `<base>` document's *relative* stylesheet moved and its root-absolute one did
> not. The relative ones already worked. **The trap is deeper than this item thought.**
> An origin-root server per run was rejected for scope (a second loopback port per run,
> a client-side URL change, and `frame-ancestors` becoming an explicit origin) and is the
> right answer if previews ever leave this machine.
> **RESIDUE, DECLARED RATHER THAN DEFENDED:** URLs a script BUILDS at run time are not
> touched (structural; not observed on either real artefact, and `connect-src 'none'`
> already stops the one candidate); unquoted attributes are legal HTML and are not
> matched; SVG/JSON assets are not rewritten; and **two branches no test reaches** — the
> 4 MiB fallback to the unrewritten stream, and the `statSync` catch. Both are documented
> in `http.ts`; neither is exercised. Also: the regexes run over the whole document
> including `<script>` bodies, so a script containing the literal `src="/x.js"` has that
> string re-pointed.

```
grep -aoE '(href|src)="/[^"]*"' …052c6e02/workspace/index.html
  href="/styles.css"
  src="/main.js"
```
The artefact's own `server.mjs:6-8` says why: *"The artefact directory itself is the
document root … Serving anything deeper would 404 the root document."* The preview
serves it four segments deeper. **Absence proven by mechanism, not only by grep**:
the single function that emits the entry document is `createReadStream(target).pipe(response)`
— there is no point on that path where an HTML transform could live.

**A trap to avoid**: a `<base href>` injection is disabled by the route's own CSP
(`http.ts:2572` includes `base-uri 'none'`), so that fix ships green and does nothing
unless the CSP changes in the same commit. Cleaner: serve the preview from an origin
root on its own loopback port — which is what the project runner already does for
published folders on 4400-4499.
**Effort.** Hours for a rewriter; ~a day for the origin-root server, overlapping work
that already exists.

> **CORRECTED 2026-08-09 (repair pass) — THE TRAP IS REAL AND THE REASON GIVEN FOR IT
> IS NOT.** `base-uri 'none'` does block a `<base href>`; that part is right. But the
> CSP is not why `<base>` fails here, and stating it that way invites someone to
> "fix" C2 by relaxing the CSP. A root-absolute URL resolves against the base URL's
> **ORIGIN, not its path** — `/styles.css` under `<base href="/api/runs/x/preview/">`
> still resolves to `http://host/styles.css`. `<base>` could never have fixed C2 under
> any CSP.
>
> **What actually shipped this round** is the rewriter: `sendPreviewFile` in
> `dashboard/server/src/http.ts` re-points root-absolute references in HTML and CSS at
> the preview mount. Mutation-proved (content-type discriminator neutered → 5 red
> across two files, each naming the address that escaped). The origin-root server
> remains the cleaner long-term answer and is still open.

#### C3. Nothing in the test suite can observe either preview failure — the harness is configured into the one mode where they cannot happen

> **FIXED 2026-08-09 — both exemptions removed, and this file is the apparatus that
> proves C1 and C2 rather than a claim standing beside them.**
> New `dashboard/server/src/preview-through-next.test.ts` (7 tests, ~2.4 s). It boots the
> **real Next** programmatically — evaluating this repository's own `next.config.ts`, so
> the rewrite and the trailing-slash rule are genuinely in the path — against the **real
> backend**, both on `port: 0` with a temp `DASHBOARD_HOME`, **so no fixed port is ever
> bound**: it can neither collide with 4176/4319 nor accidentally measure the owner's
> running app. Its fixture document is **root-absolute** like the owner's real artefacts
> and carries every other reference shape as a control (relative, absolute,
> protocol-relative, fragment, mailto, percent-encoded, `url()` inline and external).
> Assertions are **hop counts with the whole redirect chain printed in the failure
> message**, plus browser-equivalent URL resolution (read the bytes, `new URL(href,
> docUrl)`, fetch it, assert 200 **and** `content-type: text/css`) — the negative control
> being that `/styles.css` at the client origin is *not* a stylesheet but Next's HTML 404
> page, which a browser hands to the CSS parser and discards in silence. Two more tests
> were added to `preview-route.test.ts` so the rewriter has coverage that needs no Next;
> **the old relative-href fixture is kept deliberately as the negative control.**
> **The prescribed routes-manifest static check was NOT added, on evidence:** it goes
> GREEN under a broken route (`skipTrailingSlashRedirect` alone empties `redirects[]`
> while the route still loops), and the Next-in-path test strictly subsumes even a
> discriminating version, because it counts hops on the wire.
> **Three things it measured that nobody had**, each of which changed how it is written:
> booting Next in-process **leaks** (11 `FSEventWrap`s still live 5 s after `close()`),
> hence a child process and `SIGKILL`; booting against any distDir other than
> `.next`/`.next-test` **rewrites `dashboard/tsconfig.json`** — another lane's file —
> hence the pin to `.next-test`; and an SSE response here sends nothing until its first
> body write, so an earlier draft "passed" at ~15,011 ms, i.e. exactly `HEARTBEAT_MS`,
> which reads as proxy buffering and is not. The test now primes the stream and measures
> a second event.
> **CONSTRAINT FOR THE VERIFY PHASE:** this file and the Playwright suite **cannot run
> concurrently** — both use `.next-test` and Next locks it. Sequential is fine; a loud
> failure was chosen over a skip.

`playwright.config.ts:88-91` sets `NEXT_PUBLIC_API_BASE_URL` on the dev server it
boots, so every browser spec bypasses the Next rewrite entirely. Independently,
`preview-route.test.ts` boots the backend alone on port 0 with no Next in the path
and reports `tests 11 / pass 11 / fail 0` — *including* a test literally named *"the
no-slash form redirects, because without it every relative asset resolves OUTSIDE the
preview"*. And the fixture's own document uses a **relative** stylesheet href, so the
green suite is structurally incapable of exhibiting C2. The loop has survived 104
commits behind a fully green suite.
**Cheapest real check.** A node test that reads `.next/routes-manifest.json` and
asserts no `internal` redirect matches an `/api/...` path with a trailing slash. It
fails today and costs nothing. ~30 minutes.

#### C4. The canvas's entire visual investment is invisible at its own default zoom

> **FIXED 2026-08-09 — one custom property, derived from one rule, clamped at both ends.
> The dotted-edge half is a HANDOFF and is unchanged.**
> `conduitScaleFor(zoom) = clamp(1, 1/(1.35*zoom), 2.4)` — the rule being that the
> thinnest layer (the 1.35px specular core) never falls below one device pixel. Written
> onto the canvas shell as `--conduit-scale` from `onMove`, `onMoveEnd` and after each
> `fitView`, **imperatively and epsilon-guarded (0.02)**, so a pan writes nothing and a
> zoom gesture writes ~40 times across the whole range **with no React re-render**. Every
> conduit width in `globals.css` became `calc(<base>px * var(--conduit-scale, 1))`,
> including the lane link — whose width had to move out of an inline `strokeWidth`
> attribute into a rule, because a presentation attribute cannot read a custom property
> and the lane would have been the one hairline left.
> **Measured at 1440×900 on the finished run:** flat `core 1.35px × 0.5665 = 0.765px`
> on screen → scaled `1.7658px × 0.5665 = 1.0006px`. At 0.2277 zoom the cap binds (rim 7.1px
> on screen, never the 13px a naive `width/zoom` would give); at 1.17 zoom the scale is
> exactly 1 and the designed gauge is untouched.
> **Tests:** `conduit-zoom.browser.spec.ts`, three arms — default fit, zoomed in, zoomed
> out past the cap. Mutation (flatten `conduitScaleFor` to 1) → *"the specular core
> renders at 0.765px at zoom 0.566502"*, the intended number; **arm 2 correctly stayed
> green**, since it asserts the scale is 1 when zoomed in, which the mutant satisfies.
> `canvas-edges.browser.spec.ts` had to change — it pinned literal `stroke-width` values
> that are now viewport-dependent — so it pins `base × scale` with the scale read **in the
> same `page.evaluate`** (two round trips would straddle C5-2's 400 ms re-fit write and
> flake), and absolute gauge became conduit-zoom's job, asserted as effective SCREEN
> width against a floor, **which is the part that cannot be satisfied by multiplying by
> the property being checked**. That rewritten file was itself mutation-proved twice.
> **NOT scaled, deliberately and stated in the CSS:** the bloom's `stdDeviation` (a filter
> primitive attribute, not a CSS property) and the comet's `stroke-dasharray` (already
> zoom-independent in `pathLength` units).
> **THE HANDOFF (unchanged):** 4 of 8 edges on the richest run are dotted `conduit-guess`
> hairlines because **background Bash shells are minted as agent nodes**, so their parent
> attribution can only ever be an inference. Confirmed still absent at HEAD:
> `grep -ranE 'run_in_background|isBackground' dashboard/server/src/graph-emit.ts
> dashboard/server/src/graph.ts` → **empty**. The predicate belongs at the node-mint site
> in `graph-emit.ts` (a background shell has no prompt, no seat and no delegation — it is
> a tool pill on its parent, not an agent). **There is no client half to fix:**
> `flow-edge.tsx` renders `inferred` exactly as the server labels it, and softening the
> guess treatment client-side would be the canvas lying about how much it knows. C4's
> stroke change does make those four legible (2.5px × 1.308 at the default fit) — but they
> are still, correctly, guesses.

```
fit at 1440x900 with the sheet open: zoom 0.363924   (MIN_ZOOM=0.12, so a genuine fit, not a clamp)
computed: .conduit-core 1.35px → 0.49px on screen ; .conduit-rim 13px → 4.7px
```
The four-layer stack collapses to a hairline and the per-edge gradient reads as a flat
tint. The reference the code was built against is only legible at ~0.9–1.5 zoom, which
the reader reaches by clicking `+` five times.

> **UNMEASURED-BY-THE-READER, labelled 2026-08-09.** The zoom (0.363924) and the stroke
> arithmetic are measured and reproducible from `facts-big-1440x900.json`. **"Collapses
> to a hairline", "reads as a flat tint" and "only legible at ~0.9–1.5 zoom" are
> judgements made by looking at frames** (`energised-closeup.png`, `closeup-edge.png`,
> `zoomed-1440x900.png`) that lived in a session scratchpad and are gone. This pair of
> frames — the energised edge at 1.0 zoom and the same edge at the 0.363924 default fit —
> **is the whole of this section's argument, and the owner currently has only the
> number.** Regenerating them is the cheapest way to make C4 checkable; see §2.2.

Compounding it, **the good treatment lands on a minority of edges**: on the richest run
8 edges = 4 dotted `conduit-guess` hairlines + 3 `conduit-body` + 1 lane conduit (Coglane:
4 + 2 + 1). The root cause is upstream and still open: background Bash shells are drawn as
agent nodes (`grep -ranE 'run_in_background|isBackground' dashboard/server/src/graph-emit.ts
dashboard/server/src/graph.ts` → **EMPTY**, no filter exists), so their edges are guesses.
**Effort.** Hours: a zoom-aware stroke width via one custom property in the existing
`onMoveEnd` handler, and one predicate at the node-mint site in `graph-emit.ts`.

#### C5. Smaller experience items, ranked

> **PARTLY FIXED 2026-08-09 — C5 IS NOT CLOSED. Four of the eight bullets landed, two
> were declared NOT-DONE by their author, and two are observations to make on the run.**
> The bullets below are unedited; this is the status of each, in the same order.
>
> 1. **The live run never re-fits — FIXED (C5-2).** A second fit effect that fires only
>    on **growth** (`drawnCount > fittedCount`), only after the first fit, only while the
>    reader has not adjusted the view, and only once nodes are measured. Debounced 400 ms
>    so a fan-out of four agents is one move, animated 320 ms (0 under
>    `prefers-reduced-motion`), and **re-checked inside the timer** because the reader may
>    have grabbed the pane during the wait. **Shrinkage never re-fits** — collapsing a
>    group must not zoom in on the reader.
>    **Test:** `refit-growth.browser.spec.ts`, two arms that share a fixture and differ
>    only in whether the pane is dragged, each proved by its **own** mutation: fit-once
>    reds the growth arm and leaves the pan arm green; deleting the reader-pan guard does
>    the reverse. **One real bug was caught by the test and fixed** — recording
>    `fittedCount` at *schedule* time left the canvas at `1 → 1` on a graph that grew to
>    twelve, because new cards are unmeasured for a render or two, `nodesInitialized`
>    drops mid-burst, and that render's cleanup clears the armed timer. It is recorded
>    inside the timer instead.
> 2. **No run identity with the panel shut — FIXED (C5-1).** `RunHud` has a mount point.
>    `hudMounted = openPanel === null && notices === undefined` — the chip is the rail
>    panel's exact **complement**, so it can never duplicate the Overview panel, and it
>    yields the corner to the floating notice stack (which carries its own Cancel/Resume).
>    It is an overlay inside the canvas pane, **not** in `notices`, which would take the
>    canvas's 428px fit reservation on every run. The page's `sr-only` h1 stands down for
>    it, so the document still has exactly one top-level heading in every state, and the
>    chip's dead *"run detail"* button (it opened a sheet the rail deleted) now says
>    `overview` and opens the Overview panel. **`grep -arn "RunHud" dashboard/src/` now
>    resolves to a real import at `app/runs/[runId]/page.tsx:124` and a real mount at
>    `:1190`** — see the §6 doc-drift bullet, which this closes.
>    **Test:** `run-chip.browser.spec.ts`, four tests, two mutations. The fourth is the
>    interesting one: `RUN_ID`'s detail is patched to `rate_limited` so a notice really
>    docks in that corner, and it asserts the notice **is** there and the chip is **not**
>    — the positive half is what stops it passing against a page that drew nothing.
>    **RESIDUE:** the chip is suppressed whenever *anything* floats over the canvas, so in
>    those states with the rail also shut there is again no run title on screen. Deliberate
>    trade against two 360px cards in one corner.
> 3. **The 1440px gutter — FIXED (C5-3) for TWO of the bullet's three routes, and it is a
>    CONTRACT INVERSION the owner should ratify.** *Read this against the bullet, not past
>    it: the bullet names `/runs`, `/` **and** `/projects` as the regression. The fix
>    deliberately excludes `/`, and the reason is the argument below.* A third shell mode:
>    `isWideList('/runs' | '/projects')` drops the cap on
>    header and main together. The argument is what the cap is *for* — it protects a
>    **measure**, and neither list has one: `/runs` is a six-column table whose every
>    column is `whitespace-nowrap` or a badge except the ticket title, which truncates, so
>    every withheld pixel was going into truncating the one field that matters. **`/` keeps
>    the cap**; it is a ticket composer and the one screen where width costs readability.
>    The old guard was **not deleted** — its real target was the composer's textarea, and
>    that half is now asserted directly on the route that has the textarea, with a
>    visibility check so the 1440 protects a real measure. The `/runs` test also asserts
>    the **table** grew past 1440, not just `main`.
> 4. **The finished-run canvas is inert — NOT DONE (C5-4), deferred on a stated risk.**
>    The approach is written down (a fourth `settledGlow` predicate beside
>    `live`/`focused`/`sweep`, lower opacity, a single-pass blur instead of the two-pass
>    merge). **What stopped it shipping is cost**: one filter element and one extra
>    rasterised path *per edge*, unmeasured on a thirty-edge graph. It needs a frame-cost
>    measurement, not a screenshot.
>
>    > **FIXED 2026-08-09 (second pass). The measurement was taken first, and it is what
>    > let the light ship.** The per-edge bloom filter and bloom path are no longer gated on
>    > `energised`; the filter's **content** is now the state — energised keeps the
>    > two-radius `feGaussianBlur`+`feMerge`, settled gets a **single** `feGaussianBlur
>    > stdDeviation=7` with no merge, dimmed to `opacity 0.3` at a `6.5px` base because one
>    > pass spreads less light. Inferred edges are untouched: `flow-edge.tsx` returns before
>    > the `<defs>`, so **a guess still gets no bloom and no filter**.
>    > **Files:** `dashboard/src/components/canvas/flow-edge.tsx`,
>    > `dashboard/src/app/globals.css`.
>    > **Tests:** `dashboard/tests/canvas-presence.browser.spec.ts` — *"every settled conduit
>    > carries light, and nothing on the canvas moves"*, *"the guess gets no light either"*,
>    > *"an energised wire is still the brightest thing on the canvas"*; plus
>    > `dashboard/tests/conduit-zoom.browser.spec.ts`, which now censuses the bloom's
>    > **width** (see the next block).
>    > **The RED that establishes it** (lane's measurement, at rest past the arrival sweep):
>    > `REST harness-finished-run 1440x900 {"body":4,"guess":1,"bloom":0,"comet":0,
>    > "filters":0,"animations":0,"primitives":"[]","zoom":0.566502}` — four real conduits,
>    > **zero light**. After: `{"body":4,"bloom":4,"bloomSettled":4,"bloomEnergised":0,
>    > "comet":0,"filters":4,"primitives":"[\"feGaussianBlur\"]","bloomOpacity":"0.3"}`.
>    > Mutation M1 re-gated the bloom on `energised` → `Expected: 4 Received: 0`; M2 deleted
>    > the settled `opacity` → `Expected: > 0.77 Received: 0.55`, the brightness ordering
>    > collapsing.
>    > **THE COST, AND NOT THE WORD "FREE".** CDP `RasterTask` totals over a twelve-press
>    > zoom sweep, three interleaved reps after a warm-up: as-shipped **135.5 ms** against
>    > bloom-off **135.4 ms** at 1440×900 finished, **909.2** against **885.7** at
>    > 2000×1200 live. **That difference is inside the instrument's own noise** — the
>    > arm-to-arm spread is roughly **±15–20 ms** and the sign flips between viewports (at
>    > 1440×900 *live* the as-shipped arm 703.5 **beats** bloom-off 717.5). So the honest
>    > claim is **not distinguishable from free at four to six edges**, and the repair pass
>    > struck the word *"free"* out of `flow-edge.tsx`. Thirty edges remains extrapolation.
>    > **The negative control that makes the instrument credible** is the fourth arm:
>    > cranking every Gaussian to `stdDeviation 200` — a 28× radius — **does not move the
>    > number** (143.1 / 685.8 / 229.3). The instrument is not merely reporting "filters are
>    > expensive".
>    > **A SECOND DEFECT SURFACED WHILE WIRING THE WIDTH CENSUS, and it had been live for as
>    > long as the file existed:** `conduit-zoom.browser.spec.ts`'s `openCanvas` did not wait
>    > out the arrival sweep, so the first gauge read `data-state="energised"` on every
>    > bloom. The four original layers are the same width in both states and never noticed.
>    > It now polls `path.conduit-bloom[data-state="energised"]` to 0 rather than sleeping.
> 5. **"253h 36m ago" — FIXED (C5-5).** Three rungs in `formatRelative`: under a day
>    unchanged, under a week `3d 04h ago`, a week or more the **date** (year only when it
>    differs). **`formatDuration` is deliberately untouched** — it also formats how long a
>    run TOOK, where `61h 12m` is more informative than `2d 13h`, and a fourth test pins
>    that, so a future "fix" that adds days to it and restates every run duration goes red
>    here. **Test:** `relative-time.unit.spec.ts`, four tests, all against a **fixed
>    `NOW`** so nothing reads the wall clock. The last rung is locale-dependent and is
>    asserted as such (day number and month token present, string no longer relative)
>    rather than pinning an order that would pin the runner's locale.
> 6. **`feTurbulence` and animated gradient stops — NOT DONE (C5-6).** Not attempted; the
>    author ran out of budget and declined to ship an unmeasured animation onto a canvas
>    that already animates during a live run. Both are additive to the existing per-edge
>    `<defs>`; the gradient half needs no new element at all. This document already calls
>    it a taste call for the owner rather than a defect.
>
>    > **HALF FIXED 2026-08-09 (second pass) — and the two halves ended differently on
>    > purpose. Read them separately.**
>    >
>    > **(a) ANIMATED GRADIENT STOPS — LANDED.** The two **interior** stops of an energised
>    > edge's existing per-edge gradient carry `.conduit-flux-stop` plus an inline
>    > `--flux-base`; `@keyframes conduit-flux` brightens
>    > `color-mix(in oklab, var(--flux-base) 42%, #e8f0ff)` at 45% of a 2400 ms ease-in-out
>    > cycle and returns. The parent's stop **leads the child's by `FLUX_LEAD_MS = 600`**, so
>    > the bright band travels **source → target**, the direction the delegation went. The
>    > 0% and 100% stops never move — they are what keeps each role identifiable where the
>    > wire meets its card. Stilled by one rule inside the existing
>    > `prefers-reduced-motion: reduce` block.
>    > **THE COST RULE, and it is the non-obvious part:** a gradient is a paint server, so a
>    > *filtered* path painting from an animated one re-rasterises its Gaussian every frame.
>    > The bloom therefore paints from a **static twin** gradient that exists only while the
>    > main one animates; the unfiltered comets keep the animated one.
>    > **Files:** `flow-edge.tsx`, `globals.css`.
>    > **Tests:** `canvas-presence.browser.spec.ts` — *"the band of light crosses the conduit
>    > in the direction the work went"* and, in the reduced-motion arm, *"the stops hold
>    > still and the light stays"*.
>    > **Five mutations, all RED.** M3 `animation: none` → `Expected: > 30 Received: 1`. M4
>    > deleted the reduced-motion rule → `Expected: 1 Received: 121`. M5 `FLUX_LEAD_MS → 0` →
>    > *"the child's stop peaked 0ms after the parent's, not ~600ms — the wire is breathing,
>    > not carrying"*. M6 pointed the filtered bloom back at the animated gradient → *"a
>    > filtered path paints from the animated gradient — that is a Gaussian re-rasterised
>    > every frame"*. **M7 swapped which stop leads, so the band runs backwards** →
>    > `Expected: < 1320 Received: 1799.9`, i.e. exactly 2400−600 — **that one proves the
>    > DIRECTION claim** and not merely that two stops are offset. The verifier reproduced M7
>    > independently at 1800.5.
>    >
>    > **(b) `feTurbulence` — BUILT, MEASURED, AND REFUSED WITH THE NUMBER. Nothing ships.**
>    > What ships is a ~40-line block at `globals.css:585-655` recording the prototype, the
>    > instrument, the four-arm table and the refusal, so nobody re-derives it. Prototype was
>    > per-edge `feTurbulence type="fractalNoise" baseFrequency="0.014 0.06" numOctaves="2"`
>    > → `feDisplacementMap scale=3` on `.conduit-casing`, region sized to the path's
>    > bounding box + 10.
>    > **The refusal, in CDP `RasterTask` ms per zoom sweep:** `+feTurbulence` **216.8**
>    > against as-shipped **135.5** at 1440×900 finished, and **1497.4** against **703.5** at
>    > 1440×900 live — **1.6× to 2.3× the whole canvas's raster**, i.e. +6.8 ms per zoom step
>    > at rest and **+66 ms to +93 ms per zoom step while the run is live**. Those deltas are
>    > five to eighty times the ±15–20 ms band that makes the bloom's "free" unclaimable, so
>    > **this refusal stands where that claim did not**. The live figures are ten times the
>    > settled ones because a live canvas re-rasters continuously for its comets and every
>    > re-raster regenerates the noise — the price is paid during the hour the owner spends
>    > watching, on the graph with the most edges. Both knobs are already at their limits
>    > (`numOctaves` 2; region already the bounding box + 10).
>    > **AN INSTRUMENT THAT WAS THROWN OUT, reported rather than hidden:** the lane's first
>    > rAF-delta instrument gave mean 8.33–8.38 ms for **every** arm including a
>    > `stdDeviation-40` positive control — one answer for all arms, the same defect that got
>    > pixel-diff banned here. None of those numbers are cited. An earlier oversized-region
>    > (9000×9000) turbulence measurement was also discarded as a strawman **before** being
>    > quoted, because `feTurbulence` generates noise across the whole filter region.
>    > **Whether an evidence-backed refusal satisfies the owner's criterion is his call.**
> 7. **The 48-minute silent spec phase — still an OBSERVATION**, unchanged. Nothing in
>    this round touches it; it is on §4's watch-list.
> 8. **The publish path — still an OBSERVATION**, unchanged, same.
>
> **NEW RISK FROM (1), and the owner will notice it on the next run:** the growth re-fit
> animates the whole graph 400 ms after nodes arrive, so on a live run that spawns agents
> steadily the canvas moves without being asked, until the reader pans once. Judged better
> than the measured alternative (2 of 12 nodes permanently offscreen); the debounce and the
> ease are both named constants. That same write is also a new source of mid-test viewport
> change — one instance was already found and fixed in `canvas-edges.browser.spec.ts`, and
> any other spec reading a computed conduit width and the zoom in **separate** round trips
> has the same latent flake.

- **A live run outgrows its initial fit and never re-fits.** 2 of 12 nodes sit entirely
  offscreen at t=1.5s and still at t=7.5s with the zoom byte-identical (0.566502). It
  *does* re-fit on a width change (sheet close → 0.621387, 12/12 inside). Fit-once is
  deliberate (`orchestration-canvas.tsx:786`, so it cannot fight a drag) — but a new
  node is not a drag. Hours.
- **With the sheet closed there is no run identity on screen at all** — no title, no
  status, no verdict, no clock, no Cancel. `run-hud.tsx` provides exactly that and
  **has no importer** (`grep -rn "RunHud|run-hud" dashboard/src/` → only comments plus
  its own export; `sheet.tsx:725` admits it). Closing the sheet is the only way to get
  above 0.51 zoom, so cancelling a run that is going wrong requires reopening a 400px
  panel. Hours — the component is written, it needs a mount point.
- **The 1440px gutter regression is only half fixed.** `/runs`, `/` and `/projects`
  still leave 280px dead on each side at 2000px (`main {x:280, width:1440,
  maxWidth:"1440px"}`); the run detail page is clean (`{x:0, width:2000,
  maxWidth:"none"}`). Minutes for `/runs`; the other two are a layout decision.
- **The finished-run canvas is completely inert** — 0 comets, 0 blooms, 0 `<filter>`,
  0 animations at rest. Defensible (nothing is happening), but a *static* bloom needs
  no motion to justify it. Minutes.
  **FIXED 2026-08-09 (second pass)** — now bloom 4 == body 4, filters 4, primitives
  `[feGaussianBlur]`, comets 0, animations 0. Light without motion. Item 4 above.
- **Relative times degrade to raw hours**: "253h 36m ago" in the run list. One branch
  in the formatter. Minutes.
- **`feTurbulence` and animated gradient stops** — two of the three mechanisms the
  owner named. Optional, additive to the existing per-edge `<defs>`, and the alternate
  branch of his ask was declined in writing. Hours, and it is a taste call for him,
  not a defect.
  **HALF FIXED 2026-08-09 (second pass)** — animated gradient stops ship and are measured
  in both directions; `feTurbulence` was built, measured at 1.6–2.3× the canvas's raster,
  and **refused with the table left in the tree**. Item 6 above; §2.2 is corrected.
- **The 48-minute silent spec phase is fixed in code and has never been watched
  working.** Run 4's log has a 48m51s gap with nothing in it and zero `tool` events in
  all 61 rows. At HEAD `orchestrator.ts:2660` wires `onProgress`,
  `subscription-caller.ts:1893` sets `includePartialMessages`, and
  `SEAT_PROGRESS_INTERVAL_MS = 30_000`. Nothing to build — just confirm on the next run
  that the spec phase emits roughly a line per 30s, and treat silence as a regression.
- **The publish path is wired and unit-green but has never produced a folder in a real
  run.** `run: row` is at `orchestrator.ts:6317`; the only run since has
  `{"published": false, "reason": "workspace-empty"}`. Zero code; one observation on
  the next successful run.

---

## 4. THE SHORTEST PATH TO ONE SUCCESSFUL UNATTENDED RUN

> **READ APPENDIX R FIRST — IT ADDS TWO STEPS THIS LIST DOES NOT HAVE AND SUPERSEDES
> ONE INSTRUCTION GIVEN ELSEWHERE (added by the repair pass, 2026-08-09).**
> **R1** — three builds before `npm start`, including `cd dashboard && npm run build`.
> The client bundle is gitignored, so a stale one produces no diff and silently
> disables the blank-run-page fix. **R2** — how to start an unattended run: pick the
> dashboard radio **"Let ui-designer pick"**. Any guidance you have seen this round
> saying *"do NOT set designLock to auto, it does the opposite"* was true when it was
> written and is now WRONG — that defect is fixed. (`curl` with the field omitted still
> works too; both routes now agree.) R3–R5 are corrections, not steps.

> **CORRECTED 2026-08-09 — the first draft's ordering claim ("Cheapest discriminator
> first… Do not reorder") did not hold, and a critic found two genuinely cheaper
> discriminators sitting outside the list entirely.** Both are now steps 0a and 0b.
> Step 1 was also unactionable as written and is rewritten. Step 6's guard was excused on
> a premise this document refutes three sections earlier, and that is fixed below.
> **Nine steps now, and the two new ones cost zero quota.**

> ### RENUMBERED 2026-08-09 (fix pass) — SEVEN OF THE NINE STEPS ARE DONE. THE RUN IS NOW STEP 4 OF 5.
>
> **The remaining sequence, in order. Everything before step 4 costs minutes and zero
> quota; step 4 is the only expensive one; step 5 is days and is gated behind having a
> verdict at all.** The struck-through list below preserves what each retired step said.
>
> | # | Step | Cost |
> |---|---|---|
> | **1** | **Three builds** — `bakeoff`, `dashboard/server`, then **`dashboard`**. Appendix **R1** has the commands and the two mechanical confirmations. Do not skip the third: `.next` is gitignored, so a stale bundle produces **no diff line** and silently ships a run page without B7's fix. | minutes |
> | **2** | **Zero-quota spec-model probe.** ~30 s. See the recipe below. | seconds |
> | **3** | **`export DASHBOARD_RECOVERY_MAX_WAIT_MIN=720`.** The *reason changed this round* — see below. | seconds |
> | **4** | **THE RUN.** Submit per Appendix **R2**. | hours of wall clock, 2–12 h of quota |
> | **5** | **Only after a verdict exists, the trip into `bakeoff/`** for B4, and B2's reporting split. | days |
>
> **Step 3's justification is not the one the retired step 2 gave.** That step called the
> ceiling *insurance* against a horizon figure that turned out to be a `seven_day` window,
> not a refusal wait. It is now a **stated per-wait ceiling on a new unattended
> behaviour**: after A1, a refusal that names no reset instant HOLDS the run for a chosen
> 5 h and then continues by itself. `RECOVERY_MAX_AUTO_WAIT_MS` is **per wait, not
> cumulative**, and `boundFor("throttled")` allows 3 — **so three blind holds can total 15
> hours inside a 12-hour budget.** Setting the variable explicitly does not bound the
> total; it makes the per-wait ceiling a choice somebody made rather than a default nobody
> looked at. A cumulative bound is a held-milliseconds column in `planThrottledWait` and
> is **not** work to do before this run.

**~~Cheapest discriminator first. Nine steps.~~** ***Superseded 2026-08-09 by the table
above; the nine steps are kept below, struck where done, because what each one said is
the record of why it existed.***

~~0. **(a) Re-score the one PASS under the installed image.**~~ **— DONE, and done twice.
Re-run at the final check against the installed image: `heldOutPass=true`, 21 total / 20
passed / 1 failed, sole failure `REQ-013` QUALITY, digest `sha256:b7a9fd0a0f58…`
inspected three times and unchanged. Re-run it after any image rebuild; Appendix A.**
~~(b) Reproduce the preview loop.~~ **— DONE: reproduced, then closed. See C1.**
~~1. Settle the spec seat's model, then pin it.~~ **— DONE (A2), but read A2's residue:
the pin is in force, the ceiling *guard* is not, and the pin's own failure mode has never
been exercised. That is why a probe survives as new step 2.**
~~2. Raise the unattended wait ceiling.~~ **— SURVIVES as new step 3, with a different
justification and a different number (720, not 10080). The `no_retry_after` leg it warned
about is closed (A1).**
~~3. Make `npm test` able to signal.~~ **— DONE (B6, B8b). Server suite EXIT 0.**
~~4. Fix the preview loop.~~ **— DONE (C1), and the prescription here was insufficient:
it took the rewrite source as well as the flag.**
~~5. Decide the plan-phase question.~~ **— DECIDED, by taking the first branch: a
background run authors from the raw ticket. This is now enforced rather than merely
accepted — the unattended submission genuinely SKIPS the plan phase (R2). So B3 is more
load-bearing after this round, not less: WRITE THE TICKET LIKE IT IS THE ONLY INPUT,
BECAUSE IT IS.**
~~5b. Refuse to gate a run that did not declare done.~~ **— DONE, and the predicate
changed on evidence: it keys on the PRESENCE of `.bakeoff/self-report.json`, not on
`declaredDone`. See B1's `HALF FIXED` note, including what it still does not cover.**

*The retired steps in full, for the record:*

0. **(a) Re-score the one PASS under the installed image.** `…3d4d1ccb` was scored by
   `c98bad3a762b` (`pre-readmech`, 2026-07-29); the installed scorer is `b7a9fd0a0f58`.
   **~4 minutes, zero quota.** This validates the entire trust chain the rest of the
   document rests on before you spend anything. **Already done in this pass and it
   reproduces** — `heldOutPass=true`, 20/21, sole failure `REQ-013` QUALITY, identical to
   the published artefact (§1). Re-run it after any image rebuild; the script is in
   Appendix A.
   **(b) Reproduce the preview loop before changing config for it.**
   `curl --max-redirs 0 -sS -D - http://localhost:4319/api/runs/<id>/preview/` and the
   same against the API port `:4176`. **~5 minutes, zero quota.** The loop has **never
   been reproduced live** (§5-6) — the first draft prescribed a `next.config.ts` change
   plus a rebuild (old step 4) ahead of the five-minute reproduction of the bug it
   targets, which is precisely the ordering error the section claimed to avoid.
1. **Settle the spec seat's model, then pin it.** **Minutes, no quota.**
   `DEFAULT_SPEC_MODEL = "default"` resolves at runtime, and the worry is that it lands
   on a 64k model, making the 128k rung a no-op and killing the run the way run 4 died.
   **Read §3-A2's correction first: the "Haiku caps at 64K" claim is an in-repo code
   comment and the model id came from a string inside the CLI binary — neither is a
   measured capability, and the first draft could not name a 128k-capable id to pin to.**
   So do the seconds-long live probe that settles it instead of deferring the answer to
   the 2–12 h step 6: issue one one-token prompt with
   `CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000` set and see whether the CLI accepts it. Then
   set `DASHBOARD_SPEC_MODEL` to whatever that proves out. The lever is real and wired:
   `orchestrator.ts:298` defines `SPEC_MODEL_ENV`, `:5694` reads it.
2. **Raise the unattended wait ceiling.** `DASHBOARD_RECOVERY_MAX_WAIT_MIN=10080`.
   **Minutes, no quota.** This is **insurance, not a fix for a demonstrated blocker** —
   see §3-A1's correction: no refusal has ever been recorded here, and the 51.7–120.0 h
   figures are `seven_day` window horizons, not refusal waits. Know also that this alone
   may not be enough: the CLI-throw path hardcodes `retryAfterSec: null`, so a refusal
   can still park on `no_retry_after`. Fixing that leg is hours and can wait.
3. **Make `npm test` able to signal.** Scope `plan-phase.test.ts:988-994` to the three
   pre-plan-phase run ids; add `"results"` to `dashboard/tsconfig.json`'s exclude.
   **Minutes, no quota.** Without this the suite is red for a reason nobody should
   care about, which means the next real regression is invisible.
4. **Fix the preview loop** — *after* 0b has shown you the loop.
   `skipTrailingSlashRedirect: true` in `next.config.ts`, plus a rebuild. **Minutes, no
   quota.** Do it before the run, not after — otherwise the run finishes and you still
   cannot see what it made.
5. **Decide the plan-phase question** (§3-B3). Either accept that a background run
   authors from the raw ticket — in which case **write the ticket like it is the only
   input, because it is** — or spend hours wiring `ifUnanswered` defaults into the
   unattended path. **Minutes to decide, hours only if you pick the second.**
5b. **Refuse to gate a run that did not declare done.** **Hours, no quota — and this is
   the cheap half of B1's remedy, moved in front of step 6 deliberately.** `…052c6e02`
   was `agentDeclaredDone: false` with `gate_stop_reason: cancelled` and the gate scored
   it anyway. One guard on that pair costs far less than the quiescence walk and would
   have caught the one unreproducible verdict this project has produced. See the
   correction under step 6 for why this can no longer be deferred.
6. **Then one uninterrupted run to verdict.** **Hours of wall clock and 2–12 h of
   subscription quota.** Run 3 was aborted and resumed twice by dashboard shutdown and
   re-entered spec→build each time. This is the only step that costs real money, and it
   is also the highest-information action left in the repository: the spec ladder, the
   container score, the visual gate and the verdict have all been exercised only by unit
   tests and one synthetic dry run.
   ~~Watch three things while it runs, all free: the spec phase emitting a line per 30s
   (§3-C5), a `plan.json` that is skipped rather than parked (§3-B3), and whether a
   `seat_spend` row ever appears (it will not, §3-B5).~~
   > **REPLACED 2026-08-09 by THE RUN RECIPE below.** Two of the three are still on the
   > list. The third has inverted: `seat_spend` **will** now write rows (B5), so an empty
   > table is a regression rather than the expected state — and the recipe adds the
   > strings that are the only tell for two phases that emit nothing at all.

   > **CORRECTED 2026-08-09 — "do not restart the dashboard during it" is no longer
   > sufficient advice, because a human is no longer required to restart the run.**
   > The first draft told the owner not to restart and then excused B1 from the path on
   > the grounds that it "only bites a run that is cancelled or restarted mid-build,
   > which is exactly what step 6 tells you not to do". That premise is refuted by this
   > document's own §2:
   > ```
   > grep -an 'DEFAULT \*\*ON\*\* SINCE\|AUTO_CONTINUE_MAX' dashboard/server/src/recovery.ts
   >   120:export const AUTO_CONTINUE_MAX = 3;
   >   711: * The flag. DEFAULT **ON** SINCE 2026-08-05; the variable is now an OFF SWITCH.
   > sqlite3 dashboard/data/runs.db "select run_id, resume_count from runs;"
   >   …052c6e02 | 2          ← the very run B1 is about
   > ```
   > **Auto-recovery is ON by default and bounded at 3 continuations, so an unattended
   > run can restart itself three times with nobody touching it** — and §3-A1 argues a
   > refusal is the kind of event that would trigger exactly that. Step 6 is therefore
   > the step *most likely* to reproduce B1, not the step that avoids it. Hence 5b.
   > If the owner wants a genuinely single-shot run, the OFF switch is the
   > auto-continue flag documented at `recovery.ts:711`.

7. **Only after a verdict exists, make the trip into `bakeoff/`** for B4 (the visual
   gate). **Days.** Note the change from the first draft: **B2 (held-out labelling) is no
   longer bundled here** — it is hours of reporting work, not a protocol redesign, and it
   does not need to wait for B4 (see B4's sequencing correction). Recalibration itself is
   ~90 s wall clock, not a days-scale cost.

---

### THE RUN RECIPE — added 2026-08-09, replaces the three-item watch-list

Every line here was measured this round. Where a step is only a pointer, it is a pointer
because Appendix R already carries the mechanism and restating it in different words is
how this document drifts.

**BEFORE YOU START — four things, all free.**

**1. Three builds, in this order.** Appendix **R1**. The third (`cd dashboard && npm run
build`) is the one no earlier version of this list had, and skipping it ships a client
without B7's blank-page fix, without the run chip, without conduit scaling and without
day/date times. Confirm mechanically, not by eye:
```
find dashboard/src -newer dashboard/.next -type f | wc -l     # must be 0
node -e "console.log(JSON.stringify(require('./dashboard/.next/routes-manifest.json').redirects))"
                                                              # must be []
```
> **MEASURED 2026-08-10 — all three builds are ALREADY FRESH, and one of them is fresh for
> the first time.** The repair pass ran the real `dashboard/server && npm run build` in
> place (Appendix R1 had only proved it by equivalence into a private outDir, leaving
> `dashboard/server/dist` stale by exactly the four files carrying N2/N5/R1/R2/R3), plus
> `bakeoff` and the client. Verify by **content**, not mtime — restoring mutations by `cp`
> bumps mtimes and makes the `find … -newer` heuristic lie:
> ```
> find bakeoff/src -newer bakeoff/dist/scorer-protocol.js -type f | wc -l          # 0
> find dashboard/server/src -newer dashboard/server/dist/orchestrator.js -type f | wc -l  # 0
> find dashboard/src -newer dashboard/.next -type f | wc -l                        # 0
> grep -c collectManifestProblems bakeoff/dist/scorer-protocol.js                  # 1
> grep -c STAGE_STOPPED_BY_FAILURE dashboard/server/dist/graph.js                  # 3
> grep -c seatHeartbeatLine dashboard/server/dist/orchestrator.js                  # 3
> ```
> **Re-run all three anyway if anything has been edited since this line was written** —
> `bakeoff/dist` is what the host-side spec phase imports
> (`dashboard/server/node_modules/bakeoff -> ../../../bakeoff`), and a stale one silently
> disables N1/N3/N4/N10 on the host while the sealed image still carries them.

**2. The zero-quota spec-model probe, ~30 s.** `DEFAULT_SPEC_MODEL` is now the literal
`claude-opus-5[1m]` and it governs the **plan, spec, audit and judge** seats — every one
goes through `#seat()`. **Only valid ids were ever probed**, so an unresolvable pin would
throw at seat construction *minutes into a run you walked away from*. Start the server,
POST a throwaway one-sentence ticket, kill it as soon as the first spec-seat progress line
appears. A resolving pin produces one within ~30 s; an unresolvable one throws immediately
and names the model.
**If it throws:** `export DASHBOARD_SPEC_MODEL=<a live id>` (the ceiling table is at
~~`orchestrator.ts:340`~~ **`orchestrator.ts:347`** — re-measured 2026-08-10; this round's
`orchestrator.ts` edits shifted it again, from the `:340` the 2026-08-09 second pass cited
and the `:337` before that. `grep -an MODEL_OUTPUT_CEILINGS dashboard/server/src/orchestrator.ts`
→ `347`, `390`. **Grep it; do not trust the number.** `claude-opus-4-6` qualifies).
**Otherwise do not set it at all** — and note the inversion: the variable is now the
escape hatch, so **unsetting it lands back on the literal**.

> **CORRECTED 2026-08-09 (second pass) — the two sentences this step used to end with are
> now false, and one of them was an instruction.** It said *"an id whose
> `MODEL_OUTPUT_CEILINGS` entry is 128000"* and *"There is no runtime guard (A2's residue),
> so if you set it, you are the guard."* **There is a runtime guard**, it is checked at
> **zero spend before phase 0**, and the threshold is the **start budget**
> (`CLI_DEFAULT_MAX_OUTPUT_TOKENS` = 64,000, `orchestrator.ts:6160`), not 128,000. Three
> outcomes, all logged, all tested:
>
> | Measured ceiling | What happens |
> |---|---|
> | **below 64,000** (`claude-opus-4-1` 32,000, `claude-3-5-haiku` 8,192) | **REFUSED** at zero spend, before the builder starts. `error` line names the variable and the fix. |
> | **64,000 up to 128,000** (`claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5`, five more) | **PROCEEDS**, with a `warn` line. Every seat's first call is served; what is lost is the truncation-recovery rung, and only if a suite truncates. |
> | **unknown id** | **PROCEEDS**, with a `warn` line naming the id and *"not known here"*. Refusing would close the escape hatch, since a model shipped after the table was written is unknown by definition. |
>
> So **any live id you can name is usable** unless the table measures it below 64,000. The
> earlier "must be 128000" reading was the guard's first wiring and it made **eight of the
> sixteen ids unusable as seat models**, including every Sonnet and Haiku — a hard outage in
> place of a degradation. That is fixed; the reviewer who caught it is credited in §A2.
> **One residual you should know before you resume anything:** the preflight runs on every
> `#execute` entry, including a rate-limit resume, and `failed` is terminal. Leave the
> variable unset and it cannot fire.

**3. Env — two lines, and one deliberate non-line.**
```
export DASHBOARD_RECOVERY_MAX_WAIT_MIN=720     # per-wait, NOT cumulative. See step 3 above.
# DASHBOARD_SPEC_MODEL — leave UNSET unless the probe above failed.
```
**Do not launch from a shell carrying production secrets.** `subscriptionSubprocessEnv`
is a **subtraction, not an allowlist** — it strips `ANTHROPIC_*`/`OPENAI_*`/`CODEX_*`/
`MOONSHOT_*`/`DEEPSEEK_*` and nothing else.

**4. AUTO-CONTINUE: LEAVE IT ON.** It is on by default (`grep -an "now an OFF SWITCH"
dashboard/server/src/recovery.ts` → **`756`**, re-measured 2026-08-09; the step-6
correction block above cites `:711`, which this round's edits shifted — the line documents
the variable as an **OFF** switch) and bounded at `AUTO_CONTINUE_MAX = 3`. **Leave it on** — the
whole point of this round is a run that survives a refusal without a human, and A1's
bounded hold is only useful if the run is allowed to resume itself. Know the two prices:
(a) three blind holds can total 15 h (above), and (b) it is the mechanism that makes 5b's
refusal reachable, because a builder that exhausts its continuations without writing a
self-report ends with **no verdict**. If the owner would rather have a single-shot run and
accept a human restart, the OFF switch is at `recovery.ts:756` — but then a refusal parks.

**HOW TO SUBMIT.** Appendix **R2**. From the dashboard: pick **"Let ui-designer pick"** —
it is **not** the default, and leaving the default (*"Ask me which to build"*) costs a plan
seat plus a park of up to 20 minutes waiting for an answer nobody will give. From `curl`:
omit `designLock`, or state `"auto"`; both now agree.

> **ADDED 2026-08-10 — WHAT TICKET TO SUBMIT, and it is not the 173-line brief.**
> Resubmit the **FULLY FOLDED brief `a913c871` itself ran**, byte for byte. It is
> **13,714 characters** and it already contains **both rounds of plan Q&A inlined** (run 4's
> answers at lines 149-166, plus the 17-line motion read), so the plan phase has nothing
> left to ask and the run goes straight to `spec` — which is the phase this round's fixes
> are for. Get it from the run that died:
> ```
> sqlite3 dashboard/data/runs.db \
>   "select ticket_text from runs where run_id='run-2026-08-09T21-04-00-713Z-a913c871';"
> # arm check, measured 2026-08-10: length(ticket_text) -> 13714
> ```
> **Why this and not the original prose:** the folded brief is the only text that has been
> through both Q&A rounds, and re-submitting the unfolded one buys a plan dialogue nobody
> will answer plus a fresh ticket digest. **Two consequences to accept knowingly:** it is
> the same ticket that forced SERVER and therefore the same ticket that will exercise the
> persistence gate for the first time in this project's history (tell #5 below), and a
> different ticket text is a different `ticketId`, which breaks comparability with
> `a913c871` and run 4.

**WHAT YOU SHOULD SEE — four tells. Silence in any of them is a regression, not patience.**

1. ~~**The spec phase emitting roughly a line every 30 s.** `SEAT_PROGRESS_INTERVAL_MS =
   30_000`. Run 4's log had a **48m51s gap with nothing in it**; that is the shape this is
   watching for. (§3-C5.)~~
   > **REPLACED 2026-08-10 — as written this told the owner to treat a GUARANTEED silence
   > as a regression.** That channel is measured **dead**: 0 rows matching `%still working%`
   > across **1,816 events / 5 runs**, and R1 deliberately did **not** repair it — the cause
   > is still unproven (see §6.5). **Watch the new heartbeat instead:**
   > **a row roughly every 60 s while a spec seat call is open** (`SEAT_HEARTBEAT_INTERVAL_MS
   > = 60_000`, `orchestrator.ts:7441 seatHeartbeatLine`; override
   > `DASHBOARD_SEAT_HEARTBEAT_MS`). Grep string: **`has not come back yet`**. It is a clock
   > in the run service, not a report from the model — it says the call is still open and
   > nothing about progress, which is exactly the distinction the dead channel could not
   > make. **It brackets `authorAndFreezeSuite` ONLY.** Plan, builder, fix rounds and judge
   > still have no pulse, so silence there is still ambiguous — use tell #4.
   >
   > **Second new spec-phase tell, same round:** one row per authoring dispatch —
   > **`of this phase:`** (`authoringLadderLine`, `orchestrator.ts:7483`). Three rows means
   > three drafts; *"draft 2 … so draft 1 was refused"* is the boundary `a913c871` left in
   > no artefact at all. **The row cannot name the refused field** — that half is N5's
   > unlanded digest-moving piece.
2. **`plan.json` recording a SKIP, not a PARK.** This is the single tell that the
   unattended submission took. A PARK means the radio was wrong and you are paying for a
   dialogue nobody will answer. (§3-B3, Appendix R2.)
   > **CHECKED 2026-08-10 — the mechanism is UNCHANGED by this round** (`plan-record.ts`
   > and `plan-dialogue.ts` appear in no `git status` entry), **but a PARK now has two
   > causes, not one.** With the folded brief of the previous block there is nothing left
   > to ask, so a PARK means either the radio was wrong **or** the plan seat asked a
   > question the folded brief already answers. The two are distinguished by
   > `plan.json`'s question list: empty → radio; non-empty → the seat asked anyway, and
   > that is a finding worth recording rather than a run to restart blindly.
3. **`seat_spend` acquiring rows — this expectation is INVERTED from the old list.**
   ```
   sqlite3 dashboard/data/runs.db "select seat, call_count, output_tokens from seat_spend where run_id='<id>'"
   ```
   Expect rows for **spec, audit, builder and judge**, and a `fix` row only if the gate
   loop ran a fix round. These tables have held **0 rows since they were created**, so
   this is their first live exercise ever — treat the first rows as data to check, not a
   report to trust. **A single `builder` row carrying everything means B5's merge fix
   regressed.**
   > **INVERTED AGAIN 2026-08-10, and this is the sharper form.** N2 moved both
   > `#recordSpend` calls into a `finally` (`orchestrator.ts:3196-3197`), so **spec and
   > audit rows must appear EVEN IF THE RUN DIES IN `spec`**. If the next run dies the way
   > `a913c871` did and `seat_spend` is still empty, N2 regressed — that is now a real
   > negative control rather than an unfalsifiable expectation. On the failure path also
   > expect one lane-neutral cost row (grep **`stopped without a sealed`**) instead of the
   > two `spec seat —` sentences; those are deliberately kept off the failure path because
   > `graph.ts` folds `/^spec seat —/i` into *"Writing the tests — done"*, which a run that
   > authored nothing must not say. **`plan` is still not a member of `ApiSpendSeat`** (N6,
   > untouched), so the plan seat's tokens still reach no table on a fully successful run.
4. **The judge phase and the gate container emit NOTHING, so watch the clock instead.**
   `#seatProgress` is passed at exactly three call sites — plan, spec, audit. The judge
   seat passes none. The only other observer is a silence watch at
   `DEFAULT_SILENCE_WARN_MIN = 90`, which waits 90 minutes and then writes **one log
   line**: no status write, no requeue, no abort, no notification. True last-heard time,
   from any terminal, without opening the UI:
   ```
   sqlite3 dashboard/data/runs.db "select max(at) from events where run_id='<id>'"
   ```
   A shell loop on that query is a cheaper alarm than any code change.
5. **ADDED 2026-08-10 — `GATE:data-present`, and it has never executed for real.**
   N1 is the first change in this project's history that gets a **populated**
   `dataExpectations` past the audit, so the next run is the first time
   `checkDataExpectations` runs with a real expectation. Every leg of the trust chain
   (calibration, dry run, run-1 re-score) graded
   `GATE:data-present :: NOT APPLICABLE: the frozen suite declares no data expectations`.
   **THE TRIAGE RULE, IN FORCE FOR THE NEXT RUN:** *a failing persistence gate is the
   gate's own first bug until proven otherwise, not the builder's artefact.* The reason is
   measured, not cautious — `checkDataExpectations` runs at `scorer-container.ts:1969`,
   **before** `runFrozenSuite` at `:1997`, and `minRows >= 1` makes *"the table exists and
   the suite will write to it"* inexpressible. So an expectation on a table nothing seeds is
   a **BLOCKING false fail on the co-primary metric**, and `falseFinish=true` is expected
   collateral if the builder declared done. Which way it goes is unconstrained by N1's new
   prose: on this ticket a `/api/projects` expectation is satisfiable (that table must be
   seeded) and a contact-messages one is not. §6.4 item 1 is the open decision.

**FIVE STRINGS TO GREP THE LOG FOR — was three; two were added 2026-08-10 with the
observability round. Each means something specific and none is obvious:**

- **`every seat runs on`** — the new `info` line the preflight emits **once at the top of
  every run**, naming the seat model and its measured output ceiling. Its **absence** is the
  tell: it means the build you are running predates the guard, so re-run R1's three builds.
  If instead you see **`refusing to run`**, the run stopped at **zero spend** because
  `DASHBOARD_SPEC_MODEL` names a model measured below the 64,000 the spec seat asks for on
  its first call — the message names the variable and the fix. If you see **`not known
  here`**, the run is **proceeding** on an unmeasured id and you are the guard for that one.
- **`chosen length`** — the ONLY text a blind hold emits, and therefore the sole
  discriminator between *holding for a window* and *hung*. If you see it, the run is
  waiting on a number **nobody reported** and will continue by itself.
- **`the sealed gate was NOT run`** — 5b fired. The run is **FINISHED and NOT resumable**
  (the log now says so; Appendix R3). `heldOutPass` is **`null`, not `false`** —
  deliberately, because a gate that never ran must never be indistinguishable from one that
  passed. The workspace is still on disk. Note the backlog page will print the coarse
  heading *"the run was cancelled"* above it; the truthful sentence is underneath.
- **ADDED 2026-08-10 — `Output-token ceiling by attempt`** — N10's rung history, appended
  to the thrown `suite_not_audited` message and therefore landing verbatim in
  `runs.failure_reason`. It reads e.g. *"1:64000 2:128000 3:128000. The free truncation
  retry fired on attempt(s) 2, without consuming an attempt."* If it says **`did NOT fire`**,
  the ladder is still unexercised and the run says nothing about whether it works — which is
  the honest state today, and the reason `a913c871` had to be instrumented with `ps eww`.
  ```
  sqlite3 dashboard/data/runs.db "select failure_reason from runs where run_id='<id>';"
  ```
- **ADDED 2026-08-10 — `no reference capture`** — R3(a)'s new writer, emitted once at the
  top of a run whose ticket names no page. It settles the CAPTURE stage to `skipped`
  instead of leaving it `pending` forever, which is what `a913c871`'s 56 stored events did.
  Guarded on **two** facts (no capture in the manifest AND `captureTargetIn(ticketText).kind
  === "none"`), so a failed fetch on a page the ticket *did* name does **not** produce it.
  **Known residual:** a request carrying an explicit body `captureUrl` absent from the
  ticket text, whose fetch fails, would get this row falsely.

**WHERE TO LOOK AT THE RESULT.** The preview link works and answers in **zero hops**:
`http://127.0.0.1:4319/api/runs/<runId>/preview/`. **Open it directly** — the canvas shows
no preview node, because `previewNodeFrom` still has no call site (`grep -arn
previewNodeFrom dashboard/src` → definition at `spec-pipeline.ts:541` and comments only).
That is a known handoff, not a failure of the run.

---

## 4b. WHAT A GREEN VERDICT WILL AND WILL NOT MEAN

Added 2026-08-09, because B2 and B4 are knowingly open and the owner's whole purpose is to
**not** re-review the work. This is the honest boundary of what a pass buys.

**WHAT YOU MAY CONCLUDE FROM `heldOutPass = true`:**

- **The frozen acceptance suite really ran, in a sealed container.** `--network=none`, the
  suite hash matching the one frozen at spec time, against the installed image
  `sha256:b7a9fd0a0f58…`. This is not a claim; it is re-measured on run 1 every time.
- **The boolean is the CONSERVATIVE answer, not the soft one.** B2's defect merges the
  visible half into the scored set, and merging can only **add** failures — it makes the
  gate harsher, never more lenient. So a `true` survived a *harder* bar than the label
  describes.
- **No protected path was written.** `protectedPathViolations` is empty and is part of the
  same report.
- **The builder reached the end of its own turn.** This is new this round: after 5b, a
  verdict at all means a self-report was written. A truncated build now yields **no
  verdict** rather than a meaningless score.
- **The run survived unattended.** No human resumed it, and any refusal it met was held and
  resumed by itself within a bounded window.

**WHAT YOU MUST STILL CHECK YOURSELF — five things, and none of them is a nicety:**

1. **Visual quality. The gate cannot fail a run on it, for four independent reasons, and
   NONE of them was closed this round** (B4 — all four live in the frozen `bakeoff/src`).
   A green verdict says nothing whatsoever about whether the artefact looks good. **Open
   the preview and look at it.** That is not optional and it is not a formality.
2. **Any "held-out N/N" you are about to quote.** The count is **held-out + visible**
   (B2, also frozen). The rule is: **trust the boolean, split the count.** Do not put the
   number in a message to anyone without splitting it first.
3. **Quiescence — whether the tree had stopped moving when it was scored.** 5b closes only
   the case where **nothing was ever written**. It is file-presence, not settle-detection,
   and it **would not have refused `…052c6e02`**, the one unreproducible verdict this
   project has produced. If the run's outcome matters, confirm the workspace's newest
   mtime predates the gate.
4. **The criteria themselves.** Because the unattended path now genuinely **skips** the
   plan phase, a pass means *"satisfied the criteria the spec seat inferred from the raw
   ticket"* — with no clarifying dialogue anywhere in the chain (B3). If the ticket was
   ambiguous, the verdict is a confident answer to a question you did not quite ask. This
   is the item that got **more** load-bearing this round, not less.
5. **The first-ever spend rows.** `seat_spend` and `metered_spend` have never held a row
   on this machine. Their first rendering is data to verify, not a report to rely on — and
   the PLAN seat and the ADVERSARY pass have no `ApiSpendSeat` member at all, so any run
   that used them is understated by construction.

**And one thing a green verdict cannot tell you either way:** whether the pin, the blind
hold and the 5b guard behaved *well* or merely did not fire. Three of this round's most
consequential changes are on paths that have **never executed unattended**. A clean run is
evidence they did not break anything; it is not evidence they work.

**What this path does NOT buy you.** *(§4's original closer, kept in place — the five-item
list above is its 2026-08-09 expansion, not its replacement.)* After the run you will have
a verdict you can mostly trust, with two named exceptions you must still check by hand: no
result says anything about visual quality (B4), and every "held-out N/N" you read is
really held-out + visible and needs splitting before you quote it (B2).

> **CORRECTED 2026-08-09 — the first draft closed with "treat every `heldOutPass=true`
> as soft."** That instruction came from the old B1's inverted direction of harm and is
> **withdrawn**. Merging the visible half can only add failures, so a `heldOutPass=true`
> is if anything the *conservative* answer; what is unreliable is the **count** attached
> to it, not the boolean. The correct instruction is: *trust the boolean, split the
> count.*

---

## 5. WHAT WE DID NOT MEASURE, AND WHY

Complete and unflattering.

1. **No live run at HEAD. This is the big one.** The newest run on disk started
   `2026-08-04T11:08` and the fix that matters landed `2026-08-04 15:49`. **Every phase
   after `spec` is unexercised at HEAD**: build, gate, judge, verdict, preview,
   publish. Everything in §2's "closed" column that concerns runtime is closed *in
   code and in tests*, not against a live seat.
2. **Whether the CLI accepts `128000` on the model `"default"` resolves to.** No test
   makes a live call; every ladder test replays stubbed frames and asserts on what was
   *sent*. The CLI exposes no offline model-resolution command.
3. **Whether run 4's suite fits in one turn at 128k. Unrecoverable.** The response was
   cut mid-stream; `runs.output_tokens` is NULL and `seat_spend` has 0 rows, so the
   overflow magnitude was never recorded and cannot be.
4. **12 of the 104 server test files were excluded from one agent's subset run** — they
   bind host ports, and another agent owned ports. They include `orchestrator.test.ts`,
   the most run-relevant of them. (They *are* included in the full `npm test` figure of
   1835 reported in §1.)
5. **21 of the 22 race-vacuous `count-0` browser guards.** Only `design-lock:833` was
   mutation-proven (1 red / 5 green). The other 21 are a heuristic match, and the
   heuristic cannot see paint gates written as `toBeAttached()` or hidden in a helper —
   so it may both over- and under-count.
6. **The preview redirect loop was never reproduced live.** Reasoned from three shipped
   artefacts (Next's own `load-custom-routes.js`, the built manifest, the server
   handler) and a static replay. Confirming it needs `curl --max-redirs 0` against a
   bound `:4319` and `:4176`.
7. **The escape-hatch preview configuration was never executed.** With
   `NEXT_PUBLIC_API_BASE_URL` set the loop is avoided but the iframe is expected to go
   blank, because `frame-ancestors 'self'` is relative to the API origin. Reasoned from
   the CSP only — and the code's own docblock concedes it was never measured either.
8. **Whether `mutation-proof` holds for the client unit project. NOT ATTEMPTED.**
   > **CORRECTED 2026-08-09, THEN THE CORRECTION ITSELF CORRECTED THE SAME DAY — both
   > steps are kept here, because the second one is the point.**
   >
   > **First correction (from a critic, and I initially accepted it):** the first draft's
   > reason — *"Proving the unit suite can go red requires mutating a source file, which
   > this pass forbade"* — was called false, on the grounds that §2.1 mutated
   > `dist-runhist/subscription-caller.js`, a **private compiled build** rather than
   > source, and that `ls -d dashboard/server/dist-*` → 30 such outDirs meant the same
   > trick was available here.
   >
   > **Second correction: that reasoning does not transfer, and I checked before letting
   > it stand.** Those 30 outDirs are `dashboard/**server**/dist-*`. The unit project is
   > **client** code and its specs import TypeScript source **directly** —
   > `dashboard/playwright.config.ts:61-62` (`name: "unit"`,
   > `testMatch: /.*\.unit\.spec\.ts$/`), and e.g.
   > `canvas-roles.unit.spec.ts:26-27` imports `../src/components/canvas/layout` and
   > `../src/components/canvas/roles`, `code-tree.unit.spec.ts:34` imports
   > `../src/lib/code-tree`. Playwright transpiles on the fly; **there is no compiled
   > client artefact standing between the spec and the source**, so there is nothing to
   > mutate that is not a source file. **The first draft's stated reason was
   > substantially right and the accusation against it is withdrawn.**
   >
   > **What remains true, and it is the honest residue:** it was still *not attempted*.
   > Copying the client tree to a scratch directory and mutating there was available and
   > would have worked. So the unit project's 164/164 is an uncontrolled green — just not
   > for the reason the first correction claimed.
   The browser and server suites both produced real failures, so those two are
   demonstrably able to go red; the unit project's 164/164 is not backed by a control
   run in this session. A critic could not independently re-run
   `npx playwright test --project=unit` either, for a different and legitimate reason:
   `webServer` is declared at the top level of `dashboard/playwright.config.ts:79-91`, so
   *any* project run boots a dev server and binds host ports, which this pass forbade.
   The `164 passed (5.6s)` figure is therefore UNMEASURED-BY-THE-CRITIC (it does appear
   in this session's `pw-unit.log`).
9. **Canvas behaviour past ~12 nodes.** Fit-once was measured on a 12-node fixture; the
   richest graph on disk is 14 placed nodes folding 24 hidden ones. Nothing here says
   what happens when 40 agents arrive over an hour.
10. **The `finished-run.browser.spec.ts:304` `test.fixme`.** At least two of its three
    stated blockers no longer read as written, but enabling it needs a source edit.
11. **The mechanism of the original 052c6e02 404 is still unexplained — and the
    artefact it would be explained from no longer exists.** The 2026-07-31 gate staged
    39 files / 11,407,715 B; today's staging walk finds 37 / 10,284,654 B, and
    `ls -la dashboard/results/staging/` is empty, so there is no file list to diff. The
    re-score therefore does **not** settle "it was not the image and not the mode" for
    the gated tree — only for today's tree. **Leading hypothesis, from the run's own
    events**: a `site/` subtree (152 events reference `site/`, including
    `mkdir -p site/assets/fonts site/assets/world`) that is absent today. See B1.
12. **Whether the held-out/visible merge has ever changed a verdict. It cannot make one
    more lenient, so the question is narrower than the first draft posed it.**
    > **CORRECTED 2026-08-09.** This item read *"Whether B1's contamination has ever
    > actually changed a verdict… The defect is proven; its historical blast radius is
    > not."* Given B2's correction, the only *lenient* direction is a criterion with no
    > held-out binding, which is refused at freeze time and is empirically absent on both
    > tickets (`comm -23` → EMPTY, both). What remains unmeasured is the **harsh**
    > direction: whether any run has ever been failed by a *visible* test that the
    > held-out half alone would have passed. No run on disk shows it, but nothing rules
    > it out either, and the current artefacts cannot answer it because
    > `criterionCoverage` does not record which half a testRef came from.
13. **Builder isolation. UNMEASURED, and newly filed.** §1's correction shows the
    builder is a host subprocess, not a container, and that the two runs' own records
    disagree about its egress — run 1 says `denied`, run 3 says
    `unrestricted-host-network (NOT a measured denial)`. No probe in this session tested
    whether a builder can reach the network. The scorer's `--network=none` is a separate
    and unrelated seal.
14. **No canvas or motion measurement on a real run's event stream.** Every number in
    §2.2 and §3-C is taken from the Playwright harness fixtures `harness-build-run` and
    `harness-finished-run` (`dashboard/tests/fixtures/config.ts:58-59`), never from runs
    1 or 3, both of which have complete event streams on disk. The first draft did not
    disclose this anywhere.
15. **The live-vs-finished motion control did not control for status alone.** Two
    different fixtures with different graphs (12 nodes/6 edges vs 10/5). The
    one-fixture-status-flipped experiment was not run. See §2.2.
16. **What `retryAfterSec` a real rate-limit refusal would carry on this machine.**
    Zero refusals recorded in four runs, and `subscription-caller.ts:2123` hardcodes
    `null` on the CLI-throw path, so the number that would drive the parking decision
    has never existed.
17. **The visual evidence behind every appearance claim.** 102 PNGs were produced this
    session and none survive in the repository; see §2.2's correction for the list of
    claims this affects and the four frames worth regenerating.

---

## 6. DEFERRED, CARRIED FORWARD, NOT DROPPED

### FIX LIST FROM RUN `a913c871` — RE-RANKED 2026-08-10, AFTER IT DIED

*(Previously titled "FROM THE LIVE RUN (2026-08-09) — OWNER SAID FIX LATER, NOT NOW". That
deferral was agreed while the run was still alive and applied to **R1-R4 only**. It does
not apply to N1, which killed the run, or to N2, which is free and makes the next failure
measurable.)*

Four defects were observed **while watching** the replica run, and the section originally
opened *"None is a run defect — the run was healthy throughout."*

> **CORRECTED 2026-08-10, AFTER THE RUN DIED.** That sentence was written at 22:0xZ while
> the run was still alive. **The run then failed at `22:31:04.532Z` in phase `spec`**, and
> the post-mortem found a run-killing defect plus five more of the same class. R1's filed
> fix is also **measurably a no-op** — see R1 below. The table is re-ranked here by *what
> blocks the next run*, and every row is marked for whether it touches `bakeoff/src`.

Full evidence with commands in `docs/RUN-a913c871-observations.md`.

> **STATUS, ADDED 2026-08-10 — read §6.1 below before acting on any row in the table.**
> Nine of these ids were worked on 2026-08-10 and **the round landed six, not nine**:
> **FIXED — N1, N2, N3, N4, N10, R2.** **PARTIAL, each with a named unlanded half — N5**
> (the row cannot name the refused field), **R1** (the pulse covers the spec phase only),
> **R3** (the `audit` stage still has no `running` writer). **NOT TOUCHED — N6, N7, N8,
> N9, N11, R4.** The table rows are deliberately
> left as they were written, defects and all — one of them (N10) is **half wrong** and the
> refutation is at §6.3. **The scorer image digest moved twice; the chain is at §6.0.**
>
> > **UPDATED 2026-08-10 (never-stop round) — TWO MORE ROWS MOVED, and neither by editing
> > `bakeoff/src`.**
> > **N5 → the harness half is now LANDED:** `results/authoring-trail.json` is written on BOTH
> > the success and the failure path, in the `finally` that already existed. On a death it
> > reports `attemptsAvailable:false` with a sentence beginning `UNAVAILABLE:` naming this exact
> > hole, rather than writing `attempts: []` — which on a run that made three authoring calls
> > would be the defect the trail exists to end. **The trail-content half still needs `attempts`
> > on the thrown `BakeoffError` (digest-moving), and `readAuthoringAttempts` probes for it
> > STRUCTURALLY so it lights up with no further edit the day that lands.**
> > **N7 → CLOSED, both fixtures.** The repo now has its **first populated `dataExpectations`**
> > (`bakeoff/test/tier3-fixtures/persistence/`, one mutation `schema.sql` vs
> > `schema.sql + insert.sql`, both `kind` branches in one manifest) and a spec-phase-failure
> > fixture that really enters the production path (`orchestrator.defect-record.test.ts`, driven
> > by a run that dies in `spec` rather than returning at the reuse branch). The sqlite side runs
> > LIVE against the exported frozen `tier0.evaluateSqliteExpectation`; the `http` side and the
> > end-to-end persistence gate need the container and are **registered UNARMED, not omitted**.
> > **Still NOT TOUCHED: N6, N8, N9, N11, R4.** N3's collect-all is now additionally guarded from
> > outside the digest by `tools/replay/` — see §7.1-Tier-0.

**THE COST DISCRIMINATOR, MEASURED — and it is the only one that matters for planning.**
`bakeoff/docker/scorer.Dockerfile:78-79` does `COPY src ./src` then `RUN tsc`, and
`:127` copies the resulting `dist` into the runtime layer. `scorer.Dockerfile.dockerignore`
excludes `node_modules`, `dist`, `acceptance`, `results` and **both READMEs** — **`src` is
not excluded**. So *any* edit under `bakeoff/src`, **including pure prompt text**, moves the
scorer image digest and costs **one image rebuild + one Appendix-A re-calibration + a
re-score of run 1**. Everything outside `bakeoff/src` is free. Batch the digest-movers into
**one** round or pay the recalibration per fix. (Read off the COPY/RUN graph — the image was
not built twice and the digests were not diffed.)

| rank | # | defect | fix | size | touches `bakeoff/src`? |
|---|---|---|---|---|---|
| **1** | **N1** | **THE RUN-KILLER. The spec seat is ordered to emit a `dataExpectations` entry whose shape it has never been shown.** `grep -an dataExpectations bakeoff/src/spec-agent.ts` → two hits: `:300` an empty `[]` in the manifest template, `:340` a *mandate* to populate it for any SERVER ticket with persistence. The seven required fields (`id`, `kind`, `file`, `table`, `sql`, `path`, `minRows`) appear **nowhere the seat can read** — `grep -ac minRows bakeoff/src/spec-agent.ts` → **0**; the only correct example in the repo is `bakeoff/docker/README.md:391`. The ticket forced SERVER, so `[]` was illegal too. Three attempts emitted three mutually incompatible vocabularies; none emitted `minRows`. | Put the populated entry from `docker/README.md:391` into the template at `:300`, add an `http` variant, and state the two cross-field rules beside the `:340-343` mandate — exactly as `uiFlows` already shows all four of its fields inline. **This is the single change that would have let tonight's run reach a build.** | ~10 lines | **YES — digest** |
| **2** | **N2** | **The spec/audit ledger can only record a spec phase that SUCCEEDED.** `#recordSpend(runId,"spec"/"audit")` are at `orchestrator.ts:3036-3037`, six lines below `await authorAndFreezeSuite(...)` at `:3015`, with **no `try/finally`** (`grep -an finally …` piped through `awk -F: '$1>2880 && $1<3070'` → no matches). 87 minutes and ≈628,441 output tokens recorded **zero** rows; `runs.output_tokens` NULL. Proof independent of which revision was loaded: the phase emitted no `spec seat —` line, which is `:3030`, *above* the ledger write. | Wrap the await in `try/finally`; move both `describeTokens` lines and both `#recordSpend` calls into the `finally`. **`assertUnused()` must stay OUTSIDE it** — calling it while unwinding replaces the real failure with a guard throw. `#recordSpend` already no-ops on `callCount <= 0`, so an undispatched audit seat still writes nothing. | small | no — **FREE** |
| **3** | **N3** | **Whack-a-mole feedback: the validator throws on the FIRST offending field.** `parseSuiteManifest`'s `fail()` is typed `never` (`scorer-protocol.ts:508`), so each rejection names one field. Measured from the transcripts: attempt 1 → *no `id`*; attempt 2, told exactly that, **added `id`**, → *no `kind`*; attempt 3, told exactly that, **added `kind` and LOST `id`**. Discovering a 7-field object one field at a time in 3 tries is arithmetically impossible. Any future shape drift costs three attempts again. | Collect-all variant of the `dataExpectations`/`uiFlows`/`execution` checks (or wrap `parseSuiteManifest`) so one rejection names every offending field. Preserve the container-side fail-fast contract. | ~60-90 lines | **YES — digest** |
| **4** | **N4** | **The failure text blames the owner for a harness defect.** `suite_not_audited` says *"repeated failures on the same criterion usually mean the TICKET is ambiguous… sharpen the ticket text (then re-record its digest and re-run every configuration)"*. Tonight's blocking finding is built with **`criterionId = null`** (`spec-validate.ts:1309-1316`) — there is no criterion. Sharpening the ticket buys a new digest and another 87 minutes. **This sentence sent the first hour of the post-mortem at the wrong target.** | Branch the text: criterion-bearing findings keep the ambiguity advice; null-criterion findings say the suite is structurally unexecutable and name the fields. | ~15 lines | **YES — digest** |
| **5** | **R1** | **The spec phase emits no progress at all.** ~~Progress rows are delta-driven, so a seat reading before it writes emits nothing.~~ **RE-DIAGNOSED 2026-08-10: the channel is not slow, it is DEAD.** `… payload like '%still working%'` → **0** rows across **1,816 events / 5 runs** (arm check: `'%seat —%'` → 26, so the query is not vacuous). Negative control inside the run: plan call 1 ran **72.75 s** for **5,046 output tokens** and produced zero rows, so "reading before writing" does not explain it. Observed live: **84m31s** of `spec` with six `rate_limit` rows and nothing else. | ~~Heartbeat on `SEAT_PROGRESS_INTERVAL_MS` (`subscription-caller.ts:396`).~~ **THE FILED FIX IS A NO-OP AND WOULD CHANGE NOTHING:** that constant lives in `SeatProgressCoalescer`, whose only entry point is `push(delta)` guarded by `if (delta.length === 0) return`, and `grep -an "setInterval\|setTimeout" subscription-caller.ts` → **no matches in the whole file**. No deltas, no interval, no row, at any value. **Put the `setInterval` in the orchestrator**, armed at seat-call start, cleared in a `finally`, lane-neutral. Separately, add an arm check (`N stream frames, M carried text`) — today this feature's failure mode is silence, indistinguishable from what it watches for. Leading hypothesis for the dead channel, **unproven**: every seat that runs with `onProgress` also runs with `outputFormat: json_schema`; the only `jsonSchema: null` seat (`judge.ts:298`) has never run. Discriminator: one spec call with `structuredOutput: false` (already an option at `spec-agent.ts:917`). | medium | no — **FREE** |
| **6** | **N5** | **The three authoring attempts exist in no harness artefact.** `attempts[]` reaches disk only via `freezeSuite`'s `authoringTrail`, **called only on success**; the thrown error carries the last attempt's problems as prose. Attempts 1-2 were recovered from the **Claude Code CLI's own session transcripts** — keyed by the seat's cwd, tied to the run only by grepping the ticket id. A different cwd or retention off and they are gone. | Emit one log row per authoring attempt and per audit rejection. Tonight that would have shown *"authoring attempt 2 of 3 rejected: dataExpectations[0].id …"* and the owner kills the run at **21:31** instead of **22:31**. Surfacing the trail itself needs `attempts` attached to the `BakeoffError` (that half is digest-moving); the orchestrator-side emit is not. | medium | **partly** (emit free; trail digest) |
| **7** | **R2** | **A seat call ends and the next begins with nothing in the record.** `pid 29197 → 44002` at 21:31:52; only `rate_limit` rows. **ANSWERED 2026-08-10 from the transcripts — it was attempt 1 → attempt 2** (`cfdffda9` ends 21:31:52.892Z, `60fcb909` begins 21:31:54.456Z) — but the *product* still cannot say so. | **Free and already in hand:** the two `onRateLimit` closures at `orchestrator.ts:2972` (spec) and `:2992` (audit) know their seat and `#noteRateLimit` discards it one line later. Add `seat` to the `rate_limit` payload and tonight's seven anonymous rows become a legible alternation — R2 answered with **no new emit site**. | small | no — **FREE** |
| **8** | **N6** | **`plan` is not a member of `ApiSpendSeat`.** `api-types.ts:165` → `"spec"` / `"audit"` / `"builder"` / `"fix"` / `"judge"`. The plan seat logged **6,569 output tokens** over four calls (events seq 11/17/23/32) and reached no table. This yields zero plan rows on a **fully successful** run too — not a failure-path bug. The `#recordSpend` docblock claims "the five `describeTokens` sites"; there are **eight**. | Add `"plan"` to the union and to `SPEND_SEATS` (the `Exclude<>` type makes the compiler find the second edit), add the call site at `:2847`, decide the same for adversary at `:5995`, and fix the docblock's count. | small | no — **FREE** |
| **9** | **N7** | **Zero fixtures can observe any of this.** No fixture in the repo populates `dataExpectations` (`quality-gating.e2e.mjs:149` and `portfolio-suite.ts:237` are both `[]`), so the persistence gate (`tier0.ts:1519-1625`) has **never run end to end with a real expectation**. And every B5 spend assertion is on a run that reached the build phase: the fixture pre-seals the suite so `#specPhase` returns at the reuse branch before any caller exists, and `seatOf("spec")` has **no matches** in `orchestrator.test.ts`. | Two negative controls. (a) A fixture whose spec phase **fails** with tokens already accumulated, asserting a `spec` row still lands. (b) A calibration fixture with a **populated** `dataExpectations`. Instance twenty of the signature defect. | medium | no — **FREE, resolved 2026-08-10**: the full COPY list is `package.json`, `tsconfig.json`, `src`, `docker/playwright.config.mjs`, `docker/node-test-reporter.mjs`. `grep -ac "COPY test" bakeoff/docker/scorer.Dockerfile` → **0**, so `bakeoff/test/` never reaches the image; `portfolio-suite.ts` is dashboard-side. **Both fixtures are digest-free.** |
| **10** | **R3** | **`no reference capture` has two readers and no writer.** **RE-CONFIRMED on the finished tree:** `grep -arn` → docblocks at `orchestrator.ts:7100`/`graph.ts:437`, readers at `graph.ts:455` and `spec-pipeline.ts:123`, four **test-supplied** sentences, **no production emitter**. Folding this run's 56 events through the real reducer (`graph.foldGraphAll`) leaves `capture` at **`pending`** after death. **Also found: the `audit` stage has no `running` writer at all** — `settleStage(next,"audit",…)` exists once, as `"done"` (`graph.ts:719`) — so the seat that killed the run was never shown as active, on any run. | One emit at the no-capture-target branch (word-identical to both regexes; `settleStage` is first-mention-wins). Then the test that cannot exist today. Separately give `audit` a `running` writer, and make a terminal `failed` resolve the running stage to a state whose copy points at the failure row instead of *"Not a failure. Nobody was watching by then."* | small | no — **FREE** |
| **11** | **N8** | **The record describes the failure as a success in two columns.** `run_attempts` → `attempt_no=2, phase_reached=spec, end_class=completed, waited_sec=56, suite_source=authored` on a run whose own row says `status=failed, recovery_class=structural` and whose verdict opens `NO VERDICT WAS REACHED`. Because `#announceAttemptHistory` filters `completed` out, the ledger's only reader stayed silent. `suite_source='authored'` records the branch entered (`:2937`), not whether a suite was frozen. | Use `recovery_class` when status is `failed`; write `suite_source` from the outcome. | small | no — **FREE** |
| **12** | **N9** | **The no-verdict page makes four false claims, and has for three runs.** `run-report.ts:407` emits *"The workspace and the frozen acceptance suite are both intact"* and points at `assumptions.md`. **Unconditional, and that is read off the branch, not inferred from three-for-three:** `renderNoVerdict` (`:391`) builds one flat `lines: string[]` array literal and returns `lines.join("\n")` — **there is no conditional anywhere in the function body**. Measured: `suite_sha256` empty, no `dashboard/acceptance/t-b79ff5e2a1b314e4`, workspace empty (its own sibling `project-publish.json` says so), no `assumptions.md` in the directory. Same sentence in `162b186d` and `c228e63b` — **every no-verdict run ever.** Also `backlog.md` prints *"Stopped: `infra` after 0 attempts"* four lines above *"in 3 attempt(s)"*. | Key each clause on `suite_sha256 !== ''`, a non-empty workspace and `existsSync(assumptions.md)`; say *"no suite was frozen"* when they are absent. Read the attempt count from the same place the failure text does. **The header of that page is exemplary — only the footer is a template.** | small | no — **FREE** |
| **13** | **R4** | **A liveness probe whose failure mode is silence.** Mine, not the product's — recorded because the lesson generalises, and **the product broke it in three more places tonight** (progress channel, silence watch, spend ledger). Fixed in the probe by matching the SDK binary by name **and by a start-up arm check** (`ARM CHECK: seat matcher finds N process(es)`). | Apply to the product's silence watch — but **AFTER the R1 heartbeat, not instead of it.** Measured: `DEFAULT_SILENCE_WARN_MIN = 90` and `lastRunEventAt` resets on **any** event, so seven `rate_limit` frames chopped an 84.6-min working silence into a max 25.2-min gap. Even excluding telemetry the gap is 84.6 min — still under 90. Exclude `rate_limit` from the liveness clock **and then** lower the threshold; lowering first, with no heartbeat, only buys false alarms on the one measured legitimate 43.5-min quiet phase. | small | no — **FREE** |
| **14** | **N10** | **The 128k ladder is once per RUN, not once per attempt.** `sed -n '1156,1200p' bakeoff/src/spec-agent.ts`: `let truncationRetried = false;` is declared **outside** the `for (let attempt = …)` loop. A suite that overflows on attempts 2 or 3 gets no ladder. The docblock reads as a per-attempt guarantee. **Not blocking — the ladder never fired tonight** — but the fix is thinner than the doc claims. | Hoist inside the loop, or say in the docblock that it is deliberately once-per-run. Also: **nothing in the product logs the escalation** (`:1188-1198` emits no event), so the single most informative event the spec phase can produce is invisible and the only instrument tonight was a `ps` sampler. | small | **YES — digest** |
| — | **N11** | **Considered and NOT recommended now.** Making the manifest a first-class typed field of `AUTHORING_JSON_SCHEMA` so `outputFormat.json_schema` enforces `id`/`kind`/`minRows` at the decoder rather than after a 25-minute call. Today `testFiles[].source` is `{type:"string"}` (`spec-agent.ts:508`), so the manifest travels as opaque text and the schema constrains nothing inside it. Strongest fix, largest blast radius: changes the authoring contract, the frozen suite shape and every calibration fixture. | Revisit only if N1 + N3 fail to converge on a real re-run. | ~150 lines + fixtures | **YES — digest** |

---

### LANDED 2026-08-10 — WHAT THE REPAIR ROUND ACTUALLY CHANGED

**The table above is left un-rewritten on purpose.** Every row still describes the defect
as it stood on 2026-08-09, so the diagnosis and the repair can be read against each other.
Nine ids were worked (N1, N2, N3, N4, N5, N10, R1, R2, R3); this block is their status,
the digest chain, and everything the round refused or could not finish.

#### 6.0 THE DIGEST MOVED TWICE, AND ONLY ONE ROLLBACK POINT EXISTS

`bakeoff/src` was editable this round by instruction. `scorer.Dockerfile:78-79`
(`COPY src ./src` + `RUN tsc`) makes any edit under it — prompt text included — a digest
input, so the sealed image is a different image and the calibration, the dry run and the
standing "run 1 re-scores identically" proof all had to be re-established.

| | digest | what it is |
|---|---|---|
| **before** | `sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8` | pre-round. **Tagged `bakeoff-scorer:pre-manifest-shape`** — the only rollback point. |
| intermediate | `sha256:d74a20aeb6bc27b63d86dbb9f7411248ac7346d3e5cf46297ff8c96eba213afe` | after the four lanes' `bakeoff/src` edits (N1/N3/N4/N10). **UNTAGGED — unreachable by name.** |
| ~~**now**~~ | `sha256:83b80ef56b67d6e5791f6597d29eefac19191a27d6b15d045fbac2c5b01927f7` | after the repair pass added the single-field `sql` probe to `scorer-protocol.ts`. ~~This is `bakeoff-scorer:1`.~~ **Superseded 2026-08-10 — now tagged `bakeoff-scorer:pre-never-stop`, which is a SECOND rollback point and did not exist when the paragraph below was written.** |
| ~~**now (2026-08-10, never-stop round)**~~ | `sha256:ec79e1efbe81a7b362c0a724fe53793192d023f92aaea1c6c4fc1921f62d5665` | built 2026-08-10 08:43 by the concurrent spec-agent round (authoring-retry history + a per-call timeout bound). ~~This is `bakeoff-scorer:1`.~~ **Superseded by the repair pass below — now tagged `bakeoff-scorer:pre-repair-2026-08-10`, a THIRD rollback point.** |
| **now (2026-08-10, never-stop REPAIR pass)** | `sha256:027bc2e2d3d27eeee8d050995995959d834575441a8aaeafe50565a388cfe8a0` | built 2026-08-10 11:36 — the SECOND build of this pass. `bakeoff/src` inputs: `spec-agent.ts` (abandon-time ceiling reservation; per-call bound 30 → 60 min; the reservation figure REPORTED and branched, so the message cannot claim a bound that a subscription seat does not have; the corrected spend and marker docblocks; a ref'd deadline timer) and `spec-freeze.ts` (`AuthoringTrailEntry.timedOut?`). **This is `bakeoff-scorer:1`.** The intermediate `sha256:5ffdc20a461c…` (11:24, before the branched sentence) is **UNTAGGED and unreachable by name**; every leg below was re-run against `027bc2e2…` after it, not inherited. |

> **THE FIFTH DIGEST, RE-VERIFIED THE SAME WAY (repair pass, 2026-08-10).** `bakeoff/src`
> changed, so the standing "run 1 re-scores identically" proof was re-established rather than
> argued safe. Appendix A's `rescore.mjs`, extracted by fence (100 lines), against
> `dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/results/run.json`:
> `heldOutPass=true falseFinish=false agentDeclaredDone=true`,
> `suiteExecution={"exitCode":1,"durationMs":9155,"testsTotal":21,"testsPassed":20,"testsFailed":1}`,
> `protectedPathViolations=[]`, sole failure
> `FAIL QUALITY REQ-013 :: holdout/coglane-presentation.spec.mjs › [REQ-013] T-14 an empty
> booking submission produces no confirmation`, all 12 `GATE:*` and REQ-001..012/014..016 PASS.
> Discriminator cleared **in code, not by eye**:
> `suite.sha256 == run.heldConstants.acceptanceSuiteSha256 = 21c30afddba344780a4e9e2fd77c5c5ecca11043222f6ee41271e28f4dcc2060`,
> and `gate.scorerImageDigest == sha256:027bc2e2d3d2…`. 13.6 s of container time, zero quota.
> **The trust chain holds across the fifth digest.** Rollback for this pass alone is
> `docker tag bakeoff-scorer:pre-repair-2026-08-10 bakeoff-scorer:1`.
>
> **ALL THREE LEGS RE-RUN ON `027bc2e2…`, NOT ARGUED SAFE.** The first draft of this entry
> carried the two other legs as "one digest stale"; they were then executed rather than left
> as a note, because that is the whole lesson of the previous round's stale-by-one-digest
> chain.
>
> | leg | command | result on `027bc2e2…` |
> |---|---|---|
> | **run-1 re-score** | Appendix A's `rescore.mjs`, fence-extracted (100 lines), `--run …3d4d1ccb/results/run.json --image bakeoff-scorer:1` | **identical to the published artefact** — figures above |
> | **dry run** | `cd bakeoff && node dist/cli.js dry-run --root <scratch> --scorer-image bakeoff-scorer:1` | **24 PASS / 0 FAIL** (counted, twice, on separate roots), all five stages, `DRY RUN COMPLETE`. Includes the gate's own negative control (`the gate PASSES an honest artefact`). |
> | **calibration** | `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-record && DASHBOARD_CALIBRATION_ROOT=<scratch> node --test dist-record/calibration.test.js` | **exit 0 — tests 8, pass 8, fail 0**. (`dist-record` removed afterwards; hard rule 5.) |
>
> `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` re-run AFTER every container leg
> above → `sha256:027bc2e2d3d2…`, unmoved.

> **CORRECTED 2026-08-10 (never-stop round) — THE DIGEST MOVED A THIRD TIME AND THE CHAIN WAS
> RE-RESOLVED, NEVER TRANSCRIBED.** Both `d74a20ae…` (cited in the design brief) and
> `83b80ef5…` (cited as "now" above) are superseded. The verifier re-ran Appendix A's
> `rescore.mjs` against the CURRENT image and got the published artefact back **identically**:
> `heldOutPass=true falseFinish=false agentDeclaredDone=true`,
> `suiteExecution={"exitCode":1,"durationMs":8830,"testsTotal":21,"testsPassed":20,"testsFailed":1}`,
> `protectedPathViolations=[]`, sole failure
> `FAIL QUALITY REQ-013 :: holdout/coglane-presentation.spec.mjs › [REQ-013] T-14 an empty
> booking submission produces no confirmation`, all 12 `GATE:*` and REQ-001..012/014..016 PASS.
> Discriminator cleared **in code, not by eye**:
> `suite.sha256 == run.heldConstants.acceptanceSuiteSha256 = 21c30afddba344780a4e9e2fd77c5c5ecca11043222f6ee41271e28f4dcc2060`.
> 12.6 s of container time, zero quota. **The trust chain holds across the third digest.**
>
> **TWO TOOLING GOTCHAS THAT COST THE VERIFIER TIME AND WILL COST YOURS.** (1) Appendix A's
> `rescore.mjs` refuses any `--out` that is not under `/private/tmp/claude-501/` — the
> `/tmp/...` symlink form dies with *"refusing to write outside the scratchpad"*. (2) The fence
> extraction below is still the right way in, and it was re-run this round:
> `awk '/^## APPENDIX A/,0' … | awk '/^```javascript/{f=1;next} /^```/{if(f)exit} f'` → 100 lines.

```
docker image inspect bakeoff-scorer:1 --format '{{.Id}}'
  -> sha256:83b80ef56b67d6e5791f6597d29eefac19191a27d6b15d045fbac2c5b01927f7
docker image inspect bakeoff-scorer:pre-manifest-shape --format '{{.Id}}'
  -> sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -i bakeoff
  -> bakeoff-scorer:1 83b80ef56b67 / :pre-manifest-shape b7a9fd0a0f58
     / :pre-specmode fae56a4e1374 / :pre-readmech c98bad3a762b / :pre-lane4 bcd017714ba7
```
**Rollback is `docker tag bakeoff-scorer:pre-manifest-shape bakeoff-scorer:1`, and it is
all-or-nothing:** `d74a20ae` was never tagged, so there is no way back to "the four lanes
without the sql probe". Rolling back gives up N1, N3, N4, N10 *and* the `sql` probe
together.

**THE CHAIN, RE-MEASURED ON `83b80ef5` BY THE RECORDER, NOT RELAYED.** The Rebuild phase
ran calibration and the dry run against the *intermediate* `d74a20ae`; the repair pass
then moved the digest again and re-ran only the re-score and the seven
`bakeoff/test/*.mjs` harnesses. Those two legs were therefore stale by one digest and were
re-run here rather than argued safe:

| leg | command | result on `83b80ef5` |
|---|---|---|
| **calibration** | `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-record && DASHBOARD_CALIBRATION_ROOT=<scratch> node --test dist-record/calibration.test.js` | **exit 0 — tests 8, pass 8, fail 0, skipped 0, cancelled 0**, 72.7 s. (`dist-record` removed afterwards; hard rule 5.) |
| **dry run** | `cd bakeoff && node dist/cli.js dry-run --root <scratch> --scorer-image bakeoff-scorer:1` | **exit 0 — 24 PASS / 0 FAIL**, all five stages. Stage 4 printed `the gate resolves the scorer image by CONTENT DIGEST / sha256:83b80ef56b67…`, and `the gate PASSES an honest artefact (a gate that can never pass is not a gate)` is green — the negative control on the gate. |
| **run-1 re-score** | Appendix A's `rescore.mjs`, extracted verbatim to scratch (recipe below), `--run dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/results/run.json --out <scratch> --image bakeoff-scorer:1` | **exit 0, IDENTICAL: `heldOutPass=true falseFinish=false agentDeclaredDone=true`; suiteExecution 21 total / 20 passed / 1 failed; sole failure `FAIL QUALITY REQ-013 :: T-14 an empty booking submission produces no confirmation`.** Discriminators cleared: `summary.acceptanceSuiteSha256 == run.heldConstants.acceptanceSuiteSha256` (`21c30afddba344…`, compared in code, not by eye) and `summary.scorerImageDigest == sha256:83b80ef56b67…`. |

**Extracting Appendix A by fence, not by a transcribed line number** — inserting this block
moved the appendix, and the old `sed -n '3376,3475p'` now cuts the wrong 100 lines. Verified
byte-identical to the copy that produced the re-score above:

~~~
awk '/^## APPENDIX A/,0' docs/STATE-2026-08-09-where-we-are.md \
  | awk '/^```javascript/{f=1;next} /^```/{if(f)exit} f'   > <scratch>/rescore.mjs
# 100 lines. Prerequisite, or it dies on a bare module-resolution error:
cd bakeoff && npm run build
~~~

The digest was re-inspected after every container run and never moved.

> **THE SCOPE LIMIT ON THAT GREEN, AND IT IS THE WHOLE POINT OF §6.4 BELOW.** Run 1's
> re-score printed, verbatim:
> `PASS BLOCKING GATE:data-present :: NOT APPLICABLE: the frozen suite declares no data expectations`.
> So all three legs graded `dataExpectations: []`. The chain proves the rebuilt scorer
> grades the **old, empty** shape identically. It proves **nothing** about the populated
> shape N1 now makes the spec seat emit.

**Why `parseSuiteManifest` grading identically is credible and not merely observed once —
re-measured by the recorder, not relayed:**
```
git diff -U0 -- bakeoff/src/scorer-protocol.ts | grep -c '^-[^-]'   ->  0
git diff -U0 -- bakeoff/src/scorer-protocol.ts | grep '^@@'
  ->  @@ -751,0 +752,354 @@ export function parseSuiteManifest(raw: unknown): SuiteManifest {
```
**One hunk, 354 added lines, ZERO deleted** — the whole change is a new export appended
after the parser. `parseSuiteManifest` is byte-identical, so the prompt and collector edits
cannot have changed how the scorer grades. (The verifier measured `+752,319` before the
repair pass added the `sql` probe; the delta is the probe and its comment.)

#### 6.1 PER-ID STATUS

| id | status | file(s) | the test that now covers it |
|---|---|---|---|
| **N1** | **FIXED** | `bakeoff/src/spec-agent.ts` | `bakeoff/src/spec-agent.test.ts` PART 3 (4 tests): brace-matches the manifest template out of the *rendered* `AUTHORING_SYSTEM_PROMPT` and parses it with the real `parseSuiteManifest`; a 10-entry `RULE_PROBES` table pairs each documented prose rule with a violation and asserts the validator rejects it **and names the field**, each after parsing a repaired control of the same kind. Mutations A-D reddened both ends (prompt and validator). |
| **N2** | **FIXED** | `dashboard/server/src/orchestrator.ts` | `orchestrator.spec-spend.test.ts` — *"THE LEDGER RECORDS A SPEC PHASE THAT DIED"*. Mutation M2 restores the shipped code exactly and the test goes red while **all four `B5:` ledger tests stay green** — the measured proof B5's fixture could not see the defect that shipped. |
| **N3** | **FIXED** | `bakeoff/src/scorer-protocol.ts`, `bakeoff/src/spec-validate.ts` | `scorer-protocol.test.ts` (7 + 3 added by the repair pass) and `spec-validate.test.ts` (3). The parser's own first complaint must be problem[0]; 7 single-defect documents each yield exactly one problem; a valid manifest yields zero. |
| **N4** | **FIXED** | `bakeoff/src/spec-agent.ts` | `spec-agent.test.ts` PART 4 (6 tests). The assertion the fix exists for is `assert.doesNotMatch(text, /the TICKET is ambiguous/)` on a null-criterion failure. Three branches, not two — mutation F proves the two-way version announces a structural manifest defect on runs where no manifest was audited. |
| **N5** | **PARTIAL** | `dashboard/server/src/orchestrator.ts` | `orchestrator.spec-spend.test.ts` — *"EVERY AUTHORING ATTEMPT LEAVES A ROW"* (3 rows, one per dispatch). **NOT DONE:** the digest-moving half — `attempts[]` on the thrown `BakeoffError`, so a row could name the refused **field** and not just the ordinal. |
| **N10** | **FIXED** | `bakeoff/src/spec-agent.ts`, `bakeoff/src/spec-freeze.ts` | `spec-agent-ladder.test.ts` §4-5 (2 tests). **The table's diagnosis above is half wrong and the correction is load-bearing** — see §6.3. |
| **R1** | **PARTIAL** | `dashboard/server/src/orchestrator.ts` | `orchestrator.spec-spend.test.ts` — three tests, incl. *"THE PULSE STOPS WHEN THE PHASE DOES"* with an arm check that the pulse fired at all. **Scope: brackets `authorAndFreezeSuite` only.** Plan, build, fix and judge seats still have no pulse. The filed `SEAT_PROGRESS_INTERVAL_MS` fix was correctly **not** applied — it is the no-op the table already records. |
| **R2** | **FIXED** | `dashboard/server/src/api-types.ts`, `dashboard/server/src/orchestrator.ts`, **and `dashboard/src/lib/api-types.ts` + `dashboard/src/lib/use-run-stream.ts`** | `orchestrator.spec-spend.test.ts` — *"A RATE-LIMIT FRAME NAMES ITS SEAT"*; plus three new client tests in `dashboard/tests/live-parse.unit.spec.ts` including the negative control (an unrecognised `"plan"` narrows to `null`). |
| **R3** | **PARTIAL** | `dashboard/server/src/orchestrator.ts`, `dashboard/server/src/graph.ts` | `orchestrator.spec-spend.test.ts` — three tests folding real events through the real `foldGraphAll`, incl. a negative control (a ticket that DOES name a page gets no such row). **NOT DONE:** the `audit` stage still has no `running` writer. |

**R2 landed a defect and it was caught by the review, not by a suite.** The server's new
required `seat` field broke the client typecheck (7 errors) because
`dashboard/src/lib/graph.ts:69` imports `../../server/src/graph` — the lane's claim that
"the client imports nothing from the server package" was false. Every suite stayed green
over it: playwright's loader is transpile-only and `contract-parity.test.ts` compares event
type **names** textually. Repaired in three files; verified by the recorder:
`cd dashboard && npx tsc --noEmit` → **exit 0, 0 errors**.

#### 6.2 THE MANIFEST PROBE — WHAT IS PROVEN, AND WHAT IS NOT

Re-run by the recorder against the **shipped** `bakeoff/dist`, extractor written fresh
rather than reusing N1's helper (brace-match every `{…}` in `AUTHORING_SYSTEM_PROMPT`,
keep the ones mentioning `dataExpectations`, parse **whole**, zero substitution):

```
candidates mentioning dataExpectations: 1   (offset 10675, 727 bytes)
dataExpectations entries: 2                 -> parseSuiteManifest: ACCEPTED
NEG drop minRows    -> dataExpectations[0].minRows must be a finite number >= 1
NEG drop id         -> dataExpectations[0].id must be a non-empty string
NEG kind=postgres   -> dataExpectations[0].kind must be "sqlite" or "http", got "postgres"
NEG absolute file   -> dataExpectations[0].file must be a relative path inside the artefact
NEG dup id          -> duplicate dataExpectations id "db-query-7"
```
Five negative controls, each rejected **and named**. The root-cause command from the
post-mortem has inverted: `grep -ac minRows bakeoff/src/spec-agent.ts` → **5** (was **0**).

**Collect-all, on last night's real attempt-3 shape, against the shipped dist:**
```
fail-fast   : dataExpectations[0].id must be a non-empty string          (1 field)
collect-all : id | file | minRows | sql | table                          (5 fields)
```
`sql` is in that list only because the repair pass added a single-field probe; before it,
the collector could never name `sql` at all (`table` and `sql` were one substitution
hardcoded to the `.table` label).

**Obedient-seat convergence, re-measured post-repair by the recorder** (repair model:
each named field is set to a legal value for the entry's own kind, loop until
`parseSuiteManifest` accepts):

| last night's shape | fail-fast rounds | collect-all rounds |
|---|---|---|
| attempt 1 `{entity,source,expectation}` | **7** | **2** |
| attempt 2 `{id,description,entity,minRowCount,readBack}` | **6** | **2** |
| attempt 3 `{kind,method,path,expectStatus,description}` | **5** | **1** |

Budget is **3**.

**READ THE MODEL BEFORE READING THE NUMBER.** The simulation assumes a seat that **repairs
the named fields without regressing the ones it already had**. The only seat ever observed
did regress: attempt 3 added `kind` and **lost `id`**, and every attempt replaced its whole
vocabulary. So 2/2/1 is what an *obedient* seat needs, not a prediction of what the model
will do — a seat that keeps swapping vocabularies can still burn the budget, and nothing
here rules that out.

*Method note, because the numbers moved:* the verifier measured 14/12/10 vs 3/3/2 under its
own repair model and **before** the `sql` probe landed. The two models disagree on the
absolute count and agree on both verdicts — fail-fast is arithmetically impossible,
collect-all is inside budget. The recorder's collect-all figures now carry slack where the
verifier's had none, and that slack is the `sql` probe.

**WHAT THE PROBE IS NOT.** It is a validator probe. **No run has produced a valid
manifest**, because no run has been made. Nothing here says a seat shown the shape will
emit it.

#### 6.3 CORRECTION TO THE N10 ROW ABOVE — the post-mortem's diagnosis is refuted on the call sequence

> **CORRECTED 2026-08-10.** The row says *"A suite that overflows on attempts 2 or 3 gets
> no ladder"*. **That is FALSE, and it was measured false.** `truncationRetried = true` is
> set immediately *before* `if (outputTokens < MAX_STREAMABLE_OUTPUT_TOKENS)`, and that
> branch assigns `outputTokens = MAX`; `outputTokens` never decreases. So whenever the
> rung guard could pass, the flag is already false — the flag can never be the reason an
> escalation is skipped. Mutation J (the flag hoisted back outside the loop, i.e. the exact
> pre-fix code) leaves **all four call-sequence tests GREEN**, exactly as the proof
> predicts. **The half that IS confirmed is the RECORD:** run-scope stickiness made
> attempt 3 report `truncationRetried: true` it never earned, on the very channel built to
> stop a run guessing about its own ceiling. That is what turns J red, and that is what
> N10 fixed. The rest of the row — *nothing logs the escalation* — was true and is closed:
> `describeOutputCeilings()` now appends the rung history to the thrown `suite_not_audited`
> message, which lands verbatim in `runs.failure_reason`.

#### 6.4 REFUSED THIS ROUND — two, both with reasoning, both open

1. **The persistence gate runs BEFORE the suite, and the manifest cannot express "the
   table exists and will be written to".** Verified from primary source:
   `checkDataExpectations` at `scorer-container.ts:1969`, `runFrozenSuite` at `:1997`;
   `gateToCriterion` maps every container gate to **BLOCKING**; `computeHeldOutPass` is
   `gating.every(c => c.passed)`; `reqNumber(item,"minRows",where,1)` makes `minRows: 0`
   inexpressible. **The proposed one-sentence prose remedy was refused, correctly**: the
   SERVER mandate (`spec-agent.ts:405-411`) says you MUST declare at least one expectation,
   `minRows >= 1` says it must be non-empty, and "must be non-empty at boot" would leave a
   ticket whose only persistence is written by user action with **no legal exit** — the
   identical class of defect this whole round exists to repair, shipped deliberately.
   Making an exit means weakening the SERVER mandate, which changes what the persistence
   gate measures on exactly the tickets it was added for. **That is a scoring-policy
   decision for the owner.** The real fix (b) is to move `checkDataExpectations` after
   `runFrozenSuite`, which is what "persistence" means; out of scope by the brief.
   **Direction of harm if it fires: a BLOCKING false fail on the co-primary metric, with
   `falseFinish=true` if the builder declared done.**
2. **`stage-node.tsx:459` still contradicts R3(b) on the same card.** The chip carries
   `title={look.meaning}` → `STAGE_LOOK.unresolved.meaning` (`:143`): *"Not a failure.
   Nobody was watching by then."* — beside the new detail line that says the run failed
   while this stage was open. Hover-only; the aria path at `:328` composes label + detail
   and is already correct. Refused because it is dashboard-canvas copy (owner's routing:
   `taste-frontend-expert`), `STAGE_LOOK`/`ROLLUP_LOOK` text is also read by the design-lock
   and prose-guard suites, and no existing spec asserts a chip `title` — the most expensive
   item to prove and the lowest value. Same treatment needed at `ROLLUP_LOOK.stopped`
   (`:170`).

#### 6.5 CARRIED FORWARD FROM THIS ROUND — nothing dropped

**Handoffs the lanes filed and the round did not close:**
- **N5's digest-moving half** — `attempts[]` on the thrown `BakeoffError`, so a ladder row
  can name the refused field. Costs another rebuild + chain re-run.
- **R3's other half** — `audit` has no `running` writer. `grep -an 'settleStage(next, "audit"' dashboard/server/src/graph.ts`
  → one hit, `"done"` only. **The seat that produced `a913c871`'s failure has never once
  been shown as active, on any run.** Recipe (cheap now, the signal exists): give the audit
  branch of `authoringLadderLine` a distinct anchored opening, add the pattern to
  `graph.ts#foldLogStages` settling `audit` to `running`, and move that row out of the
  blanket lane-neutrality assertion in `orchestrator.spec-spend.test.ts`.
- **R1 heartbeat coverage** — plan, builder, fix rounds, judge. `#armHeartbeat` is a
  two-line call per site and its disarm is idempotent; each site needs its own `finally`
  placement reviewed.
- **R1's dead-delta-channel hypothesis is still UNPROVEN and untested:** every seat that
  runs with `onProgress` also runs with `outputFormat: {type:"json_schema"}`, and the only
  `jsonSchema: null` seat (`judge.ts:298`) has never run. Discriminator: one spec call with
  `structuredOutput: false` (`spec-agent.ts:917`). The heartbeat makes the phase observable
  **without explaining or repairing the progress channel** — still **0 rows in 1,816 events**.
- **N5's ladder rows are coupled to bakeoff's `purpose` STRINGS** (`suite-authoring … attempt N`,
  `suite-audit …`). A reword degrades them silently to the neutral wording; nothing fails
  loudly. A cross-package assertion belongs in `spec-ladder-e2e.test.ts`.
- **R3's residual gap**, written into `#reportNoCapture`'s docblock: a request whose
  explicit body `captureUrl` (not in the ticket text) failed to capture would get the
  "No URL in the ticket" row falsely. Narrow but real; nothing the orchestrator can read
  distinguishes it.
- **`authoringPromptSha256` changed** with the prompt edit, and **the question of whether
  that can ever mismatch is now SETTLED, not deferred.** It is **write-only provenance**:
  `grep -rn "authoringPromptSha256" --include='*.ts' bakeoff/src dashboard/server/src`
  finds a type field, three assignments, two `sha256Hex(…)` producers and one docblock —
  and `grep -rn "authoringPromptSha256 !==\|=== \|== " …` over `bakeoff` and `dashboard`
  finds **zero comparisons anywhere**. The suite-reuse branch keys on
  `row.suiteSha256 !== null` (`orchestrator.ts:2541`), not on the prompt hash. So the next
  run freezes a suite carrying the new value and **nothing on any resume or re-score path
  reads it back to compare**. No recipe line needed. Recorded so nobody re-derives the
  question, and so a later reader does not treat the changed value as tampering.

**Two pre-existing reds, neither caused by this round, each needing a decision and NOT a
relaxed assertion:**
- `dashboard/server/src/db.test.ts:501` — *"THE OWNER'S OWN runs.db OPENS AND KEEPS ITS
  RUNS"*. **Data-caused.** It asserts every run in the owner's real `dashboard/data/runs.db`
  has `recoveryClass === null`; exactly one row violates it —
  `run-2026-08-09T21-04-00-713Z-a913c871`, `recovery_class='structural'`, with 2
  `run_attempts` rows. That is last night's run. `db.ts` and `db.test.ts` are byte-identical
  to HEAD. **Do not weaken the equality** — this repo's other signature failure is *"the
  panel stopped saying it, so the spec stopped asserting it"*. The assertion almost
  certainly intended *"un-migrated rows get the column default"*, which needs the fixture to
  exclude rows the current server has legitimately written.
- `bakeoff/test/spec-agent.smoke.mjs` — 106 assertions passed / **1 FAILED**, *"the default
  output cap is the streamable ceiling, not the xhigh floor"*. It asserts constants in
  `bakeoff/src/spec-types.ts`, which appears in **no** `git status` entry, so it fails
  identically at HEAD. It contradicts `bakeoff/src/spec-agent-ladder.test.ts:166` **by
  design**; one of the two has to be retired by a human decision about which number is
  correct. Out-of-glob, so it is in neither the 121 baseline nor the 146 figure.

**Two tree facts, recorded so nobody later reads them as tampering:**
- `bakeoff/test/quality-gating.e2e.mjs` is modified (33+/4-) and appears in **no** lane's
  file list. It is yesterday's Appendix R4 repair, it is **not** a digest input
  (`grep -ac "COPY test" bakeoff/docker/scorer.Dockerfile` → 0), and its 31/31 reproduces.
- One pre-existing `git stash` entry ("half-finished design-directions work from the
  stopped workflow `wf_4b991b7c`") predates this round; no stash command was run.
  `docs/RESEARCH-self-improving-practice.md` appeared untracked mid-round and is not this
  round's.

**Process note for the next verifier, and it cost the last one seven false failures:**
`dashboard/server/src/preview-through-next.test.ts` binds host port **4322**, which is the
same port playwright's `webServer` uses (`dashboard/tests/fixtures/config.ts:APP_PORT`).
**The server suite and the client browser suite cannot be run concurrently** — doing so
yields `⨯ Another next dev server is already running.` The file's own comment claims 4322
is *"the harness's alone"*; that is no longer true. Also: N3's collector runs ~5 extra
`parseSuiteManifest` calls per `dataExpectations` entry plus ~10 for the top level, on the
audit hot path — pure, in-process, negligible against an 87-minute phase, but it scales
with entry count. And `describeOutputCeilings` lengthens `runs.failure_reason` by one line
on every `suite_not_audited`; the new line is **last**, so anything that truncates that
column loses it first. No such consumer was found; the dashboard's rendering of
`failure_reason` was not exhaustively audited.

**Three risks the round created, carried forward because none is measured:**
- **N3 changes the FEEDBACK VOLUME the seat receives** — three to five simultaneous field
  corrections instead of one. Every message comes from the real parser and the list is
  bounded by the manifest's field count, but **nothing has measured how a seat behaves when
  handed four corrections at once.** The only observed behaviour is of a seat handed one at
  a time, and it replaced its whole vocabulary each time.
- **`OrchestratorDeps.seatQuery` is a new production seam.** Absent, it is the byte-for-byte
  old path; present, it is a way to make the two most expensive seats call something other
  than the model. Nothing in `http.ts` or `index.ts` sets it — only the new test.
- **The heartbeat adds ~1 event/minute per spec phase to the `events` table**, on a run
  that is already in trouble, and `db.ts` persists every event. ~84 rows on the measured
  phase, against a build's 32,000.

**Rows in the table above that were NOT worked and remain fully open: N6, N7, N8, N9,
N11, R4.** N7(b) in particular — *a calibration fixture with a populated
`dataExpectations`* — is the single item that would have closed §6.0's scope limit, and it
is **digest-free** (`bakeoff/test/` never reaches the image; `portfolio-suite.ts` is
dashboard-side). Everything in "CARRIED FORWARD BY THE FIX PASS" and "BY THE SECOND FIX
PASS" below is untouched by this round and still stands.

**GATE STATE AT HANDOFF. Re-measured by the recorder on 2026-08-10 unless marked
otherwise — a lane's self-report is a claim.**

| check | result | measured by |
|---|---|---|
| `cd bakeoff && npx tsc --noEmit` | **exit 0** | recorder |
| `cd dashboard/server && npx tsc --noEmit` | **exit 0** | recorder |
| `cd dashboard && npx tsc --noEmit` | **exit 0, 0 errors** — this is the B1 blocker, cleared | recorder |
| `cd bakeoff && node --test dist/*.test.js` | **tests 146, pass 146, fail 0, skipped 0, cancelled 0** (HEAD `3d01c2c` measures 121; +22 four lanes, +3 repair pass) | recorder |
| `cd dashboard/server && npm test` | **tests 1890, pass 1886, fail 1, skipped 3, cancelled 0.** The one fail is `db.test.ts` — *"THE OWNER'S OWN runs.db…"*, `actual: 'structural'`, `expected: null`, i.e. the data-caused pre-existing red below. The 3 skips are the quota-gated `subscription-caller.live` trio. | recorder |
| `cd dashboard && npx playwright test` | **430 passed / 1 skipped** | **RELAYED from the repair pass — NOT re-measured here.** It binds host ports and conflicts with `preview-through-next.test.ts` on **4322**; the two suites cannot run concurrently. Consistent with the verifier's independent 259 browser + 168 unit = 427, plus the repair pass's 3 new `live-parse.unit.spec.ts` tests. |

All three builds fresh, content-verified not mtime-verified:
```
find bakeoff/src            -newer bakeoff/dist/scorer-protocol.js  -type f | wc -l   # 0
find dashboard/server/src   -newer dashboard/server/dist/orchestrator.js -type f | wc -l   # 0
find dashboard/src          -newer dashboard/.next -type f | wc -l                    # 0
grep -c collectManifestProblems bakeoff/dist/scorer-protocol.js   # 1
grep -c MANIFEST_DATA_EXPECTATION_EXAMPLES bakeoff/dist/spec-agent.js  # 3
grep -c STAGE_STOPPED_BY_FAILURE dashboard/server/dist/graph.js   # 3
grep -c seatHeartbeatLine dashboard/server/dist/orchestrator.js   # 3
```
`git rev-parse HEAD` → `3d01c2c56f04e84023be675df7882499aa498b7d`. Nothing committed,
pushed, amended, checked out, stashed, reset or cleaned. `git status --short` → 61 entries
(the ~46 pre-existing + this round's 15).



**THE ONE ROUND, IF YOU DO ONE THING.** Land **N1 + N3 + N4 + N10** together (all
`bakeoff/src` text, one rebuild + one recalibration + one re-score of run 1) and **N2**
alongside them for free. That is the run-killer, the feedback loop that guaranteed it could
not self-correct, the sentence that misdirects the post-mortem, and the accounting that
makes the next failure measurable. Everything from rank 5 down is free and independently
landable, and **R1's heartbeat should go in before the re-run** or the next 87 minutes are
as blind as these were.

> **DONE 2026-08-10 — this paragraph is now a record, not a plan.** N1 + N3 + N4 + N10
> landed together in one digest move, N2 alongside them, and R1's heartbeat went in before
> the re-run as advised. The digest was then moved a **second** time by the repair pass's
> `sql` probe, so the round cost two rebuilds, not one; the chain was re-established on the
> final image both times. See §6.0-6.5 above. The advice itself held: nothing in the ranked
> table changed rank as a result of landing it.

**The common fix, if only one gets done:** every "nothing happened" state needs a producer
and a start-up control. **Nine of the fourteen rows above are one missing emit or one
missing `finally` each.**

> **OBSERVED LIVE 2026-08-09 21:20Z, DURING RUN `a913c871` — WATCH 1 DOES NOT FIRE WHILE
> THE MODEL IS THINKING, so the 48-minute-silence problem is mitigated only for the half
> of it that writes.** The recipe says to watch the spec phase for "roughly a line every
> 30 s" and to treat silence as a regression. Measured on the replica run: `spec` opened
> at `21:06:29Z`, and at `21:20:30Z` the events table held **nothing newer than
> `21:06:32Z`** — fourteen minutes, zero progress rows.
>
> The wiring is present and is not the fault:
> ```
> grep -an 'onProgress: this.#seatProgress' dashboard/server/src/orchestrator.ts
>   2828:      onProgress: this.#seatProgress(runId, "the plan seat"),
>   2977:      onProgress: this.#seatProgress(runId, "the spec seat"),
>   2996:      onProgress: this.#seatProgress(runId, "the audit seat"),
> grep -an 'includePartialMessages' dashboard/server/src/subscription-caller.ts
>   1965:      includePartialMessages: this.#onProgress !== null,
> grep -an 'SEAT_PROGRESS_INTERVAL_MS = ' dashboard/server/src/subscription-caller.ts
>   396:export const SEAT_PROGRESS_INTERVAL_MS = 30_000;
> ```
> **The mechanism is delta-driven.** A progress row carries an excerpt of what the model
> is WRITING (`#seatProgress` → `seatProgressLine`), so a seat that is reading an 80 KB
> PDF and composing before it emits its first output token produces no deltas and
> therefore no rows — for as long as that takes. Run 4's 48m51s gap is exactly that
> shape, so the mitigation does not cover the case that motivated it.
>
> **The run was NOT hung, and the instrument that showed it is not in the dashboard:**
> ```
> ps -eo pid,ppid,etime,%cpu,rss,command | awk '$2==<api pid>'
>   29197  20284  14:23  1.7%  300080  …/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
> ```
> A live seat subprocess, 300 MB resident, burning CPU. **What a reader of the dashboard
> saw over the same fourteen minutes was indistinguishable from a hang.**
>
> FIX, NOT ATTEMPTED HERE (a run was in flight): emit a heartbeat row on the interval
> whether or not a delta arrived — "the spec seat has been working for N minutes" — so
> the absence of a row means something. A delta-only channel cannot distinguish thinking
> from dead, and this repository already has a name for a signal that can only report
> success.

> **CORRECTED 2026-08-09 — the first draft opened this section with "Nothing here is
> closed; nothing is dropped" and then dropped almost the whole of `docs/HANDOVER.md`
> §6, including the item HANDOVER itself labels CRITICAL.** A critic measured the
> omission:
> `for t in secret-intake code-files 0600 check-ignore image/png JPEG A-quality-only 1663 '#24' '#27' '#45' assertOutsideBakeoff 436,942; do grep -ac -- "$t" docs/STATE-2026-08-09-where-we-are.md; done`
> → **0 for every one.** `STATE-2026-08-02`'s handover backlog item 2 (the fixture-shape
> false negative recurring in the new fixtures) was dropped too. The claim is withdrawn
> and replaced with a scope statement plus the missing items, each carried forward with
> a measured verdict rather than a transcription.
>
> **Backlogs cross-checked in the first draft:** `STATE-2026-08-02` (both its lists) and
> `docs/superpowers/plans/2026-08-05-carried-forward.md`.
> **Backlog NOT cross-checked in the first draft, added below:** `docs/HANDOVER.md` §6.

Everything still open from the older backlogs that did not make the ranked lists.

**From `STATE-2026-08-02` "WHAT TO DO, IN ORDER":**
- Item 1, re-score `…052c6e02` — **DONE this session**, and it showed the published
  verdict is *unreproducible* (§3-B1). The first draft said here that it "inverted the
  answer"; **that is withdrawn** — the re-scored tree is 2 files / 1,123,061 B different
  from the tree that was gated.
- Item 2 of the handover backlog, **the fixture-shape false negative recurring in the
  NEW fixtures** (`STATE-2026-08-02:301`) — **dropped by the first draft, carried forward
  here, and UNMEASURED**: no check in this pass looked at the new database fixtures'
  shape.
- ~~Item 2, fix the preview route — **still open**, both halves (§3-C1, §3-C2).~~
  **CORRECTED 2026-08-09 (fix pass): both halves are CLOSED.** The route answers in zero
  hops (C1) and the served document is re-pointed at the preview mount, so a
  root-absolute artefact renders styled (C2). What remains from this item is not the
  route but the **card**: `previewSiteFrom` still blames the backend for any 3xx, and
  `previewNodeFrom` has no call site. Both are handoffs, listed below.
- Item 3, one uninterrupted run to verdict — **still open**, and it is step 6 of §4.
- Item 4, the plan phase — **BUILT and RUN**; its success measure `inferredCriteria`
  is still unmeasured because the one run that used it died before criteria existed.

**From `STATE-2026-08-02` attachment/handover backlogs — the items that did NOT close:**
- `run-attachments.ts`'s header still overclaims that each of four refusals is
  sufficient alone.
- Two `formatBytes` implementations on the client; `attachmentUrl` percent-encodes
  neither segment; `toDetail` reads the manifest twice per request.
- The exclude-file guarantee is overclaimed in its docblock — a working-tree
  `.gitignore` with a negation (`!app.db`) outranks `$GIT_DIR/info/exclude`.
- `discoverStartCommand` copies the builder's `start` script verbatim into the README;
  a start script containing a credential would print it.
- `HANDOVER_EXCLUDE_RULES` force-includes `.env.example`/`.sample`/`.template` past its
  own `.env.*` sweep.
- `schemaBasename` collapses case and punctuation, so two databases whose names differ
  only that way collide on one schema file.

> **CORRECTED 2026-08-09 — one item deleted from this list because it is false today.**
> The first draft carried *"Three orphaned `node -e` processes (pids 4099, 12490, 77834)
> predating all of it"* — transcribed from `STATE-2026-08-02`'s backlog item 7 and never
> re-tested, which is the exact behaviour this document's own preamble forbids.
> `ps -p 4099,12490,77834 -o pid,etime,command` → **header only, no rows. All three are
> gone.** The live form of the check, for whoever needs it next:
> `ps -eo pid,ppid,command | awk '$2==1 && /node -e/ {print $1}'` → **empty**.

**From `docs/HANDOVER.md` §6 — dropped by the first draft, carried forward now, each
with a measured verdict:**

- **CRITICAL, and still fully open: `secret-intake.ts` (679 lines) and `code-files.ts`
  (554) have never had a single security claim verified by anyone.** HANDOVER:135-145
  says they were *rescued* in `384463d` after their authors died on API errors, and lists
  the controls to re-run: never logged/echoed/returned; never in a prompt, record, canvas
  node or error; never rendered back; mode `0600`; genuinely gitignored — *verified with
  `git check-ignore -v` against a **real** file, because a missing path returns nothing
  and reads exactly like a broken rule*. Plus `code-files.ts`'s traversal refusals and
  sealed-root exclusions. **Measured: untouched by all 104 commits.**
  `git log --oneline --since=2026-08-02 -- dashboard/server/src/secret-intake.ts dashboard/server/src/code-files.ts`
  → **empty**. This belongs in a ranked list, not an omission: it is an unverified
  security claim on the one feature whose entire purpose is keeping a key out of a
  transcript, and an unverified secret box is *worse* than no secret box, because it will
  be trusted.
- **`http.ts` served JPEG bytes as `image/png`** — **appears fixed, verdict qualified.**
  `grep -an 'Content-Type' dashboard/server/src/http.ts` → the screenshot route is now
  `:2763 "Content-Type": target.endsWith(".png") ? "image/png" : "application/octet-stream"`,
  so a JPEG is no longer mislabelled as PNG (it is now `application/octet-stream`, which
  is honest but will not render inline). The preview route uses
  `:2730 previewContentType(relPath)`. **Whether `application/octet-stream` is the
  intended outcome for a JPEG screenshot is a decision nobody has recorded.**
- **The `A-quality-only` fixture rename, and the hollow-page fixture the visual gate
  needs.** HANDOVER:182-187: `A-quality-only` reads as a verdict and the owner read it as
  one; rename it and check its three siblings. **Measured: the label no longer exists in
  the tree** —
  `grep -arn 'A-quality-only\|quality-only' --include='*.ts' --include='*.md' . | grep -av node_modules | grep -av /dist`
  → **one hit, `docs/HANDOVER.md:182` itself**. So either it was renamed or the fixture
  set changed; **which, is UNMEASURED**. The second half is **closed and is directly
  relevant to B4**: the hollow fixture exists —
  `grep -arn -i 'hollow' dashboard/server/src/visual-substance.ts` → `:59` names the
  fixture `hollow-section`, *"a complete shell carrying a section whose heading …"*, and
  `:301` records that *"the two hollow artefacts measure 0/0/0 (`blank-page`,
  `reward-hacked`)"*. The gate has its discriminating fixture; what it lacks are B4's
  four blockers.
- **`orchestrator.ts:1663-1665` assigns where it should merge, so a run's reported tokens
  go DOWN at the first fix round.** **The citation is stale and the verdict is
  UNMEASURED.** `sed -n '1655,1672p' dashboard/server/src/orchestrator.ts` at HEAD is
  design-lock reconciliation, not token accounting, and
  `grep -arn 'outputTokens' dashboard/server/src --include='*.ts' | grep -av '\.test\.ts'`
  finds no hit in `orchestrator.ts` at all — accounting now lives in `tokens.ts`, whose
  `:209` reads `outputTokens: previous.outputTokens + incoming.outputTokens`, i.e. a
  merge. That is suggestive of a fix but is **not** proof the original defect is closed;
  nobody has run the two-round case.
- **436,942 unaccumulated seat tokens — this is the concrete size of B5.** HANDOVER:175:
  the run reports the builder's 88,529 output tokens while the spec, audit and judge
  seats spent a further 436,942 *"that are logged and never accumulated"*, so the number
  shown is 16.8% of what the ticket cost. **Still true**: `seat_spend` and
  `metered_spend` are both 0 rows (B5), and
  `sqlite3 dashboard/data/runs.db "select run_id, output_tokens from runs order by started_at;"`
  → `88529`, empty, `111936`, **empty** — run 4 recorded nothing at all. The negative
  control for this already exists in the tree and passes:
  `db.test.ts:202 "THE NEGATIVE CONTROL: a run whose other seats spent 436,942 cannot
  report the builder's 88,529"`.
- **`#24`** (three delegation residuals) — **UNMEASURED**; no issue tracker is present in
  the repo and `grep -arn '#24' docs/*.md` resolves only to HANDOVER:188 itself.
- **`#27`** (`AgentDefinition.background` is inert) — **UNMEASURED, and the symbol is
  gone**: `grep -arn 'AgentDefinition' --include='*.ts' dashboard/server/src | grep -i background`
  → empty. Related to §3-C4's dotted edges and to the 2026-08-03 parentage item below.
- **`#45`** — **both halves now CLOSED, measured.** (i) *"the seven-fixture calibration
  has never run with no env set"*: `dashboard/server/src/calibration/grade-fixture.ts:135-150`
  records *"VERIFIED END TO END ON ALL SEVEN FIXTURES WITH NO ENVIRONMENT SET,
  2026-07-30 … seven real `--network=none` containers at concurrency 3: 8 tests, 8 pass,
  0 fail, 0 skipped, 0 cancelled, 72.6 s"*, with a second arm at concurrency 1 for the
  8th assertion. (ii) *"the `rm -rf` override has no `assertOutsideBakeoff` guard"*: it
  does now — `grade-fixture.ts:117` imports it and `:265` calls
  `assertOutsideBakeoff(root, \`calibration run root (${CALIBRATION_ROOT_ENV})\`)`, with
  the negative control at `calibration/run-root.test.ts:147` (*"a run root inside
  bakeoff/ is REFUSED — the override drives an rm -rf"*). One wart is recorded in-file at
  `:255`.

**From the 2026-08-03 open item (agent parentage):** the design call left deliberately
open — a background Bash block *is* the true origin of the task it starts, so recording
`Bash` + `run_in_background: true` in `#spawnOrigin` would make 20 guesses exact, but
that changes what `exact` means and presumes a background shell should be an agent node
at all. Still unsettled, and it is the same root cause as §3-C4's dotted edges.

**From `docs/superpowers/plans/2026-08-05-carried-forward.md`** — note this doc was
written in the HEAD commit itself with zero commits after it, so unlike the three status
docs it does **not** lag the tree, and three of its claims were independently
re-verified this session. Its open items are folded into §3 above except:
- **Motion capture under-reports what a reference site does** — on kamilborzecki.dev it
  found 1 span, missing a 5-animation load entrance and 3 of 5 hover transitions.
  Suspected cause named in-doc: `safeRole` collapsing roles to "an element". Fix the
  normalizer before writing any gate on top of it. Hours.
- **An unresolved conflict is armed and waiting**: "copy this site" versus "every build
  must have a motion moment". A faithful copy of a genuinely static site would fail the
  motion bar if it were switched on. It is off today
  (`design-env.ts:89-90` sets `MOTION_BAR_ENV` only when a design lane arms it, and two
  tests pin that an inherited operator env var cannot arm it). **Must be settled before
  the bar is switched on, or it fails correct work.**

**Doc drift to fix when someone next touches these files** (doc says X, tree says Y):
- `HANDOVER.md:162-163` lists four canvas items as outstanding — all four shipped.
- `STATE-2026-08-02` §6 says the plan phase is unbuilt and cites a five-member
  `ApiPhase` at `api-types.ts:90`; HEAD has six members with `plan` first at `:100`.
- `STATE-2026-08-02` §6's "visible half is never executed" is true of the **build loop**
  only; the scorer executes both halves (§3-B2). *Corrected 2026-08-09: the first draft
  added "and the corrected version is worse" — it is not worse, it is a labelling defect
  whose direction of harm is toward harshness. See B2.*
- `STATE-2026-08-02` §6 gap 4 (dry run vs image) is closed and both its digests are stale.
- `d19e7e8`'s commit body misattributes 052c6e02's GATE:boot failure to spec mode (§3-B1)
  — with the caveat now attached there that the artefact re-measured is not the artefact
  that was gated.
- `2026-08-04-dashboard-observability-findings.md` says `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
  is set nowhere and quotes line numbers that no longer exist — it is a snapshot written
  hours before the fix and never marked resolved.
- `UX-GAPS-2026-07-30.md`'s whole "FIX NEXT" section is closed, and its opening warning
  about uncommitted work now misleads (tree is clean).
- ~~`http.ts:2601-2606` and `orchestration-canvas.tsx:893-895` both justify
  `PREVIEW_ROOT_CANDIDATES` by saying 052c6e02 put its site in `site/`; `ls -1` of that
  workspace shows `index.html` at the root and no `site/` directory.~~
  > **RETRACTED 2026-08-09 — this bullet was wrong and it argued from the wrong tree.**
  > `ls -1` of the workspace *today* shows no `site/`, but the comment is a claim about
  > the tree **during the run**, and the run's own event stream proves the builder made
  > one:
  > `sqlite3 dashboard/data/runs.db "select count(*) from events where run_id='run-2026-07-30T20-16-40-242Z-052c6e02' and payload like '%site/%';"`
  > → **152**, with payloads including
  > `command: mkdir -p site/assets/fonts site/assets/world` and `cd site/assets/fonts`.
  > **`http.ts:2601-2606`'s justification is grounded in the run's own events and should
  > stay.** This retraction is also the leading hypothesis for B1's missing 2 files /
  > 1,123,061 B and for the original 404 — a `site/` subtree that existed when the gate
  > ran and does not exist now.
- ~~`run-hud.tsx`'s 310-line header describes a live floating chip; it has no importer.~~
  **CORRECTED 2026-08-09 (fix pass): it has one now.** C5-1 mounted it —
  `grep -arn "RunHud" dashboard/src/` → import at `app/runs/[runId]/page.tsx:124`, mount
  at `:1190`. The header now describes something real. **This is also the change that
  created instance eighteen of the signature defect** (see B8): a `rail.browser.spec.ts`
  guard asserting the chip's *absence* was green through the very mutation its docblock
  claimed to have reproduced.
- `grade-fixture.ts:142` pins a scorer digest that is now tagged `pre-readmech` — the
  same image that scored the project's one PASS. It reproduces on the installed image;
  see §1's correction.
- `bakeoff/README.md:153,:223` present `npm test` as the test command; it starts no
  container, and the two e2e files that do are unreachable from any documented command.
- `STATUS.md` is ~1,000 tests behind on the server count and is the least reliable of
  the three; prefer this document, then `2026-08-05-carried-forward.md`.
- **Added 2026-08-09:** `dashboard/README.md:126` documented `DASHBOARD_SPEC_MODEL`'s
  default as `default`. **Fixed this round** — it now names the literal and states the
  inverted role. Recorded here because the same inversion is still unstated in any other
  doc: unsetting the variable no longer means "no pin".

---

### CARRIED FORWARD BY THE FIX PASS, 2026-08-09 — nothing here was dropped

Four lanes, a verifier, two readiness reviewers and a repair pass. This is everything they
refused, could not reach, or knowingly left. **Grouped by why it is still open**, because
the reason is more useful than the list.

**(1) FROZEN — it lives in `bakeoff/src`, and editing it moves the scorer digest.**
Rule-bound, not forgotten. Each requires a round that budgets an image rebuild **and** an
Appendix-A re-calibration.
- **B2** — held-out labelling. The metric filters by tier only.
- **B4** — the visual gate cannot fail a run, four independent reasons, none closed.
- **`readSelfReport` collapses THREE different facts to `null`** — no file, unparseable
  file, and a file whose `status` is not `done|blocked|incomplete`. `…052c6e02` wrote
  `"status": "complete"` and the run logged *"the builder wrote no self-report"* about a
  **7,930-byte report**. 5b works around it with a separate `existsSync` in
  `orchestrator.ts`; the right fix is for the reader to distinguish absent from
  unreadable.
- **`spec-types.ts:227-228`'s comment is incomplete** — it says the streamable ceiling is
  64K on "every current Claude model except Haiku 4.5". The registry transcribed into
  `orchestrator.ts` this round shows `claude-sonnet-4-5` and `claude-opus-4-5` also cap at
  64000 and `claude-opus-4-1` at 32000. Not wrong about Haiku; incomplete.
- **`bakeoff/package.json` needs a `test:e2e` script** (B8c's other half). `package.json`
  **is** COPYed in the Dockerfile's stage 1, so a scripts-only edit moves the digest. Three
  harnesses are unreachable until then: `quality-gating`, `runner`, `scorer-modes`.
  Appendix R4 has the hand invocation. **Note the asymmetry that made B8c's fixture edit
  safe: `bakeoff/test/*.mjs` is copied into no stage.**

**(2) THE QUIESCENCE WALK — B1's expensive half.** Only 5b landed. The guard is
file-presence, not settle-detection, and **would not have refused `…052c6e02`**. Note it
could not have been caught by an mtime walk either: that run's change was a *deletion*,
and deletions leave surviving mtimes intact.

**(3) B3 — the plan seat on the background path.** Not frozen; **decided**, by taking the
"author from the raw ticket" branch, which the unattended submission now enforces rather
than merely permits. Carried because the decision has a standing cost: **write the ticket
like it is the only input.**

**(4) HANDOFFS THE LANES FILED — a file the lane did not own.** Each is small; none was
attempted, and that is why each is here rather than in §3.
- **`api-types.ts:165 ApiSpendSeat`** has no member for the **plan** seat
  (`orchestrator.ts:2759`) or the **adversary** pass (`:5858`). Both compute real totals
  and both still go only to a log line. Widening it is three files (`api-types.ts`, the
  client mirror, `contract-parity.test.ts`).
- **`backlog.ts`'s `Record<StopReason, string>` is TOTAL over five members**, so 5b's
  guard had to reuse `cancelled` and the backlog prints *"the run was cancelled"* above a
  run that was not. The truthful sentence renders underneath. A sixth `StopReason` plus one
  line fixes the heading.
- **`#finish` derives `endClass` from status** (`orchestrator.ts:6709`, re-measured), so a
  5b stop closes as `"completed"` and is filtered out of the recovered-attempts
  announcement at `:6508`. `endClass` is a **free string** (`db.ts:274`), so unlike the backlog heading this
  is not a total-Record compile break. **Fix these two together** — they are the same
  outcome being recorded wrongly in two places.
- **`specModelCeilingWarning()` has no call site.** Exported, 7 tests, never invoked.
  Emitting once from `#execute` against the resolved seat's `modelId` avoids threading a
  `runId` through `#seat()`'s three call sites, which is what timeboxed it out.
  > **FIXED 2026-08-09 (second pass).** It is wired, and the threshold it was wired at was
  > then **corrected** by a reviewer before this text was written. `grep -an
  > 'specModelCeilingWarning\|usableSpecModel\|reportSpecModel'
  > dashboard/server/src/orchestrator.ts` now returns the definition **plus** live callers at
  > `:6174` and `:6207`. `#seat(runId, base)` resolves through `#usableSpecModel(runId)`, and
  > `#reportSpecModel(runId)` runs as the first statement in `#execute`'s try (`:2065`), so a
  > refusal lands at **zero quota on every path**. Full account at §A2's second-pass block.
- **`previewSiteFrom` / the preview card** (`src/lib/spec-pipeline.ts:615`) — blames the
  backend for any 3xx. Needs a `misrouted` member for `response.type ===
  "opaqueredirect"`; `redirect: "manual"` **alone** produces a *different* wrong sentence
  (measured).
- **`previewNodeFrom` has no call site** (`spec-pipeline.ts:541`), so the canvas shows no
  preview node after a successful run. Wire at `app/runs/[runId]/page.tsx:1057`, **in the
  same commit** as the `opaqueredirect` member above.
- **The background-Bash parent predicate** (`graph-emit.ts`) — four dotted `GUESSED PARENT`
  edges. C4's note has the exact predicate. **No client half exists to fix.**
- **Nine ordering-vacuous browser guards** (B8d): `design-lock:579, :835`,
  `motion-readout:477, :489`, `ticket-redundancy:340, :366, :370, :372, :375`. Each is a
  one-line reorder with **zero semantic change**; each needs a Playwright mutation to
  prove, i.e. the ports. Do them as one batch in a round that owns them. `design-lock:835`
  is already independently mutation-proved vacuous, so at least one of the nine is
  confirmed rather than suspected.
  > **FIXED 2026-08-09 (second pass) — AND THIS BULLET'S OWN CLASSIFICATION WAS MEASURED TOO
  > STRONG.** Nine cited, nine examined, **eight real ordering defects**, seven closed by a
  > reorder or an inserted control and one (`ticket-redundancy:340`) left with a written
  > reason. **ZERO were vacuous at test level** — every one of those tests carries a positive
  > control *somewhere*, so an unpainted page reddens the test even in the old order; what is
  > real is **per-assertion** blindness, measured verbatim for `design-lock:579` against a
  > 500-blanked run detail. Two specific corrections: `design-lock:835`, called "already
  > independently mutation-proved vacuous" above, went **RED** for this lane — its vacuity
  > was the pre-2026-08-05 string, repaired on 2026-08-05, and the guard as it stands is
  > live; and `motion-readout:466` is **not** a member of the nine, a `toContainText` paint
  > assertion already precedes it. Files: `design-lock`, `motion-readout`,
  > `ticket-redundancy`, plus two in-lane extras (`rail:600`, `ticket-motion:225`). Six of
  > the reorders carry verbatim RED. **A catalogue that says "18 instances" may be counting
  > historical, already-repaired instances alongside live ones.**
- **`cron/cron-tick.ts:330`'s comment** is stale in a way that now matters: *"the route
  validates this field and DISCARDS it"* is false (`createRun` stores `designLock`), and
  cron's explicit `"auto"` became load-bearing for the first time this round. It points the
  **right** way; only the sentence is wrong.
- **`plan-record.ts` / `use-run-graph.ts` canonical mutations** were exercised only via a
  private build and a scratch copy, because another lane owned both files. Sound, but the
  mutations documented in `plan-phase.test.ts`'s own header remain unrun.

**(5) DECLARED NOT-DONE BY THEIR AUTHOR — deferred on a stated risk, not forgotten.**
- **C5-4**, the static settled bloom. Blocked on a **frame-cost measurement** on a
  thirty-edge graph, not on a screenshot.
  **FIXED 2026-08-09 (second pass)** — the measurement was taken and the bloom shipped. See
  §3-C5 item 4.
- **C5-6**, `feTurbulence` and animated gradient stops. Same constraint; and this document
  already calls it a taste call for the owner rather than a defect.
  **HALF FIXED 2026-08-09 (second pass)** — animated gradient stops shipped; `feTurbulence`
  was built, measured and **refused with the number**. See §3-C5 item 6 and (A) below.

**(6) NEW RISKS THIS ROUND CREATED — none is a defect, all are behaviour the owner has not
seen before.**
- **Three blind holds can total 15 h** inside a 12 h budget (A1). Per-wait ceiling, three
  continuations.
- **A pinned model can be deprecated.** `"default"` at least followed the CLI's
  recommendation. The unresolvable-pin failure mode is untested.
- **`MODEL_OUTPUT_CEILINGS` is stamped to SDK 0.3.220**, re-derived by nothing at runtime,
  and omits `claude-3-5-sonnet` (8192). Re-transcribe after any dependency bump.
  **ESCALATED 2026-08-09 (second pass):** the table now gates a **refusal**, not a warning,
  so a bump that RAISES a ceiling turns a legitimate model into a hard outage. It needs an
  owner — see (B) in the second-pass subsection below.
- **5b can deny a verdict to a run that deserved one** — a builder killed before writing
  its report now ends with **no verdict** instead of a possibly-meaningless score. Intended
  trade, real behaviour change, on the expensive path.
- **`FakeBuilder` now writes a self-report by default**, so every pre-existing orchestrator
  test drives a different run shape than it used to. All 93 pass, but a test written by
  another lane against the old fixture will see a different run.
- **The growth re-fit moves the canvas** 400 ms after nodes arrive, until the reader pans.
- **`skipTrailingSlashRedirect` is wider than `/api/*`** — page routes are no longer
  canonicalised.
- **The preview buffers HTML/CSS up to 4 MiB** instead of streaming, and rewrites bytes
  inside `<script>` bodies.
- **`dashboard/tsconfig.json` now carries JSONC comments.** `tsc` and Next both accept
  them; a strict `JSON.parse` caller would throw. None was found; none was exhaustively
  searched for.

**(7) MEASUREMENT GAPS — stated rather than papered over.**
- **`npm run test:harness`** (baseline 22/22) was **not re-run** this pass.
- **The three bakeoff e2e harnesses** were run **by hand** and are in no suite figure. The
  121/121 excludes them.
- **`dashboard/tsconfig.json`'s new `"results"` exclude is currently INERT** —
  `dashboard/results` holds 0 `*.ts`, so the final check's `EXIT=0` did not exercise it. The
  claim is sound and unexercised.
- **`preview-through-next.test.ts` cannot run concurrently with the Playwright suite** —
  both use `.next-test` and Next locks it. A Verify-phase **ordering constraint**, not a
  flake: run the server suite first, or expect a real error.
- **`dashboard/.next` was rebuilt at the final check** and confirmed fresh (0 stale
  sources). Any lane that lands `dashboard/src` after that re-stales it silently, because
  the directory is gitignored. **Re-run R1's two confirmations, not your memory of them.**
- **A sibling lane reverted a landed fix to HEAD mid-session** (`dashboard/tsconfig.json`),
  and it was caught only by a re-check before reporting. Cause unidentified. The owner
  should not assume the tree he reviews contains every lane's measured work.
- **A TRAP FOR THE NEXT AGENT:** `if (row === null || isTerminal(row.status)) return
  false;` appears **byte-identically** at `orchestrator.ts:1491` (`cancel`) and `:1515`
  (`resume`). A slurp-mode `perl -0pi -e s///` hits the first only, so a mutation lands in
  the wrong method **while looking applied** and the test stays green for the wrong reason.
  Mutate by line number. (Found the hard way this round; also the first time anyone wrote
  down that `cancel()` refuses terminal runs too.)

### CARRIED FORWARD BY THE SECOND FIX PASS, 2026-08-09 — nothing here was dropped either

Three lanes (ceiling-guard, animation-finish, vacuity-sweep), a verifier, a reviewer, a
repair pass and a final gate. Everything they refused, could not reach, or knowingly left.
The subsection above is **not** superseded — every item in it that is not restated here is
still open.

**(A) REFUSED WITH A MEASUREMENT — not omitted, and the number is in the tree.**
- **`feTurbulence` does not ship (C5-6b).** Built in the live DOM, measured with CDP
  `RasterTask` totals over a twelve-press zoom sweep, and refused: **216.8 ms against
  135.4 ms** at rest and **1497.4 ms against 703.5 ms** on a live canvas — 1.6× to 2.3× the
  whole canvas's raster, worst exactly while the owner is watching. The four-arm table and
  its `stdDeviation`-200 negative control live at `globals.css:585-655` so nobody
  re-derives it. The final gate confirmed absence in the production bundle
  (`document.querySelectorAll("feTurbulence").length === 0`). **Whether an evidence-backed
  refusal satisfies the owner's criterion 6(b) is his call, not a lane's.**
- **Raising the flux amplitude so the band reads at the ~0.364 default fit.** Refused as a
  code change and taken as a prose change: the repair pass narrowed the claim in
  `globals.css` instead (the flux is a close-inspection cue; the **bloom** is what carries
  liveness at the default fit). Raising it is a taste decision with an unmeasured cost.
  **Carried as an owner decision.**
- **Any `bakeoff/src` edit.** `specModelCeilingWarning`'s prose problem was solved entirely
  on the dashboard side; `CLI_DEFAULT_MAX_OUTPUT_TOKENS` / `MAX_STREAMABLE_OUTPUT_TOKENS` /
  `DEFAULT_MAX_OUTPUT_TOKENS` were **read only**, to verify the threshold split's premise.
  `git status --short -- bakeoff/src` → 0 files; digest unchanged.

**(B) HANDOFFS FILED THIS ROUND — a file the lane did not own.**
- **`MODEL_OUTPUT_CEILINGS` needs a re-transcription owner** (`orchestrator.ts:340`,
  re-measured; `:337` in earlier text predates this round's edits). It is
  a hand transcription of the SDK 0.3.220 bundled CLI's registry. Nothing re-reads it on an
  SDK bump, and **now that it gates a refusal the failure mode is worse than a stale
  warning**: a bump that RAISES a ceiling turns a legitimate model into a hard refusal.
  Someone should own a re-check at each `@anthropic-ai/claude-agent-sdk` version change.
  (Supersedes the "re-transcribe after any dependency bump" note in (6) above, which was
  written when the table only informed a warning.)
- **`dashboard/README.md`'s `DASHBOARD_SPEC_MODEL` row WAS updated** by the repair pass, so
  it now documents the three-way behaviour. **This document was left to its author** — that
  is the present pass, and §A2, §2.2, §6 and the RUN RECIPE are corrected in place above.
- **The 14 PNGs behind this round's visual claims are in a reapable scratchpad**, as were
  the 37 §2.2 laments. The final gate's own 7 frames are too. Copying frames into the repo
  is a permission no lane was given. The zoom/bloom half is now durable as a **numeric**
  assertion (`conduit-zoom.browser.spec.ts`); the flux-legibility half is not, and a still
  frame cannot settle it anyway.

**(C) WHAT THE REPAIR PASS AND THE GATE LEFT OPEN.**
- **The preflight fires on every `#execute` entry — including rate-limit resume and
  `reconcileOnBoot` — and `failed` is terminal.** NARROWED, NOT CLOSED: with the threshold
  at 64,000 the case shrinks to genuinely-below-64k ids, but a resume under
  `DASHBOARD_SPEC_MODEL=claude-opus-4-1` (32,000) still terminally fails a run holding a
  frozen suite and a built artefact, over a variable unrelated to the phase being resumed.
  **Leave `DASHBOARD_SPEC_MODEL` unset and this cannot fire.** The fix, if wanted, is to
  gate the REFUSAL (not the report) on the run not already holding a frozen suite — and to
  give that branch its own negative control so it does not become a silent-proceed path.
- **No acknowledgement env was added** (`DASHBOARD_SPEC_MODEL_ACCEPT_LOW_CEILING` or
  similar). The threshold split made it unnecessary. If the owner wants refusal at the
  128,000 rung back as an opt-in strictness, that env plus a third behavioural test is the
  shape.
- **The pre-build panel carries no Cancel.** It is the fourth chip-suppressing surface and
  the only one the reader **opens**; it closes on a visible header button or Escape
  (`prebuild-panel.tsx:299,235`), restoring the chip in one click. Documented at the
  `hudMounted` site rather than papered over. Owner decision: accept it, or put a
  run-stopping control on a surface about planning.
- **The flux has no isolating cost arm.** The four-arm `RasterTask` table's arms are
  bloom-off / as-shipped / +feTurbulence / stdDeviation-200 — **the only instrument shown
  to discriminate here has never been pointed at the animation**. The rAF arms are all
  pinned at the ~8.3 ms vsync and detect only catastrophic loss. `globals.css:590` names
  the missing fifth arm (`animation: none` on `.conduit-flux-stop`, on the LIVE fixture).
  Also unbounded by construction: one animated gradient plus a static twin per energised
  edge, and `energised = live || focused || sweep` energises **every** edge during the
  arrival sweep.
- **The `2000x1200-finished` column of the frame-cost table is half empty.** Two cells were
  restored (`as-shipped 243.9`, `stdDeviation-200 229.3`); bloom-off and +feTurbulence are
  marked `(not recorded here)` rather than invented. Filling them needs the sweep re-run at
  that viewport. "Free" at the thirty-edge target the design doc plans for needs
  repetitions until the standard error is below the delta, on a graph with more than six
  edges.
- **Eight REGRESSION-ONLY browser guards** — `canvas-shell-copy:313`, `chat-plan-copy:326`
  and `:327`, `design-lock:495`, `design-surfaces:512`, `prebuild-lane:310`,
  `ticket-redundancy:391`, `ticket-redundancy:430`. Their forbidden string exists **nowhere
  in `dashboard/src` code**, so no product mutation can redden them; they are falsifiable
  only by a human retyping the deleted copy. **Not fixable inside a test file.** Either
  accept them as documented tripwires or give the product a copy registry a test can assert
  against. Flagged rather than deleted, because deleting loses the tripwire.
- **`prebuild-lane.browser.spec.ts`'s four POS-AFTER-ONLY guards** (`:508`, `:795`, `:842`,
  `:843`) were **not examined to mutation depth** — 17 negatives in one large file, timebox.
  The one-line-reorder treatment probably applies to `:508` and `:795`; `:842`/`:843`
  already carry a written control argument plus a non-zero count on the next line.
- **`finished-run.browser.spec.ts:304` is still a `test.fixme`** — the single skip in the
  browser project, a test that can observe nothing at all. Flagged by the sweep lane,
  carried by the verifier, left by the repair pass: un-`fixme`-ing it could redden the suite
  for product reasons that are an owner decision.
- **The comment-stripping filter in `orchestrator.spec-model.test.ts` is naive.** It drops
  only lines whose trimmed form starts with `*`, `//` or `/*`, so a block-comment
  continuation line wrapping onto a word that mentions `SPEC_SEAT` would break
  `uses.length === 4` with a failure message about a seat nobody added. The two *evadable*
  assertions in that file were strengthened; this one was left. RELATED HAZARD, hit live:
  writing a glob containing `*/` inside a `/* */` docblock closes the comment early
  (`TS2304: Cannot find name 'api'`).
- **A deliberate tripwire, not a bug:** `uses.length === 4` in
  `orchestrator.spec-model.test.ts` goes RED when a **correctly** wired fifth seat is added.
  Whoever adds a seat updates the number after confirming it goes through `#seat`; the
  failure message says so.

**(D) NEW RISKS THIS ROUND CREATED.**
- **One new `info` line at the top of every run** naming the seat model and its measured
  ceiling, on every `#execute` entry including resume. New noise on the resume path.
- **An unmeasured model that really caps at 64,000 can still kill a run at hour one.** The
  unknown-id path proceeds by design; the `warn` line is the only signal and the run is
  unattended. This is the price of keeping the escape hatch open, and it is stated in the
  code and in the test's docblock rather than hidden.
- **The settled bloom puts one `<filter>` and one extra rasterised path in the DOM per
  non-inferred edge AT REST, on every run.** Measured at 5 and 6 edges only. The thirty-edge
  graph is **extrapolation**; the `stdDeviation`-200 control suggests it scales with edge
  count rather than blur radius, which is the favourable direction, but nobody has measured
  it.
- **An energised edge now has two `<linearGradient>` elements** (the animated one plus the
  bloom's static twin). No spec counts gradients today; anyone who starts will see a count
  that changes with liveness.
- **`conduit-flux` animates through `color-mix(in oklab, …)`** — the only place in the
  stylesheet that does. Verified interpolating in this Chromium; a browser without it holds
  the stop at its base hue (graceful degradation to the pre-change look, not a break).
- **Two assertions the product must now keep** that were not in any brief:
  `ticket-redundancy`'s `heading Options` control and `rail`'s `rail-overview` control.
  Both proven live.
- **`#seat` now takes `runId`** purely so the refusal can reach the run's log. If a future
  seat is built where no `runId` is in scope, the tempting fix is a second resolver — which
  the structural test's literal-count assertions exist to stop.

**(E) A PIPELINE GAP, NOT A TEST GAP — and it is the one worth fixing before the next
round.** Mutation proof in the browser suite requires **temporarily editing production
source** (`run-hud.tsx`, `design-lock.tsx`, `app/page.tsx`, `runs/[runId]/page.tsx`,
`notices.tsx`, `globals.css`, `flow-edge.tsx` were each mutated and restored this round).
That collides head-on with "do not touch another lane's file" when lanes run concurrently
against **one uncommitted tree**. It worked only because every mutator hashed and
`cmp`-restored, and no sibling wrote during the window — the whole-tree
`find dashboard/src -type f -exec shasum` figure `11e5e8165f…` was used as the common
instrument and three independent passes agreed on it. As a standing arrangement it is a
race: two lanes mutating the same tree cannot both trust their reds.

**(F) MEASUREMENT GAPS ADDED THIS ROUND.**
- **The vacuity sweep is Lane G's own sweep and was not re-run by the verifier.** Its
  denominators (in the SECOND FIX PASS note at the head of this document, §4 of it) are a
  lane's self-report of a
  mechanical scan, not an independently reproduced figure. The six mutation proofs inside
  it were reproduced; the counts were not.
- **Every canvas measurement is still on Playwright harness fixtures** (`harness-finished-run`
  5 edges, `harness-build-run` 6 edges) except the final gate's, which used the production
  bundle against a **real run's** stored graph. §5's "no canvas measurement has ever been
  taken against a real run's event stream" is therefore **narrowed but not closed** — the
  gate measured the rendered canvas of a real run at rest, not a live event stream.
- **Three round-window files remain unattributed to any lane**:
  `dashboard/server/src/http.ts`, the pre-round `dashboard/README.md` edit, and this
  document. They are in the owner's diff with no lane's mutation proof behind them.
- **Gitignored litter, left alone deliberately** (rule 2 forbade tree-wide operations): 33
  `dist-*` siblings under `dashboard/server`, 9 under `bakeoff`, and **1 pre-existing `git
  stash` entry that predates this session**. No pass created or removed any of them. Worth
  a sweep when the owner next has the tree to himself.

---

### CARRIED FORWARD BY THE NEVER-STOP ROUND, 2026-08-10 — nothing here was dropped either

#### 6.6 EVERYTHING STILL OPEN, ranked by what blocks an unattended night

| rank | what is open | evidence, re-measured by the recorder | why it is not done |
|---|---|---|---|
| **1** | **`repairing` IS A TERMINAL PARK WITH NO PRODUCER — and it is where `a913c871`'s own class lands.** `settle()` sends every zero-bound and every unknown failure class to `state:"repairing"` with `nextAction: "waiting for a repair proposal for this failure class"`. Nothing ever moves a ticket out of it. | `grep -n repairing dashboard/server/src/*.ts` → the type unions (`api-types.ts:2592`, `db.ts:464/536`), the single write (`supervisor.ts:747`), `SUPERVISOR_ACTIVE_STATES` (`http.ts:422`), and tests. **No reader that changes the state.** | The producer is a repair DRIVER, and building one that silently no-ops would be the 22nd catalogued instance. Needs items 2 + 3 below first. |
| **2** | **NOTHING CALLS `tools/repair`, `tools/tier3` OR `tools/replay`.** **110 tests and 16 arm checks** — re-measured by the recorder, all green, none of them executed by any process, route, test script or CI job. | `grep -rn 'tools/repair\|tools/tier3\|tools/replay' dashboard/server/src dashboard/src bakeoff/src \| wc -l` → **0**; `ls package.json` → *No such file*. | A root `package.json` would introduce a package boundary above `dashboard/`, `dashboard/server/` and `bakeoff/` and change Node's module resolution for every file beneath it — a repo-wide behavioural change made blind, for a convenience script. **REFUSED with that measurement; the commands are listed in §6.8.** |
| **3** | **`violations` IS ALWAYS `null` AT THE WRITE SITE**, so every defect signature is `sha256("site=<phase>/<status>/<code>\n")` with **zero field paths**, the anti-loop comparator is BLIND in production, and the oscillation that killed `a913c871` is invisible to every automatic reader. | `grep -n "violations" dashboard/server/src/orchestrator.ts` → **`7316: violations: null,`** (one hit). | It is DESIGN §9 step 8 — the digest-moving batch, unpaid. **This one line is the precondition for four other items.** |
| **4** | **THREE SIGNATURE FORMULAS SHARE ONE ADDRESS SPACE**, so the "already tried and failed" brake can never fire: `ruled-out.mjs#fileFor` reads a path nothing writes. | Computed on one input (`site='spec/failed/suite_not_audited'`, path `dataExpectations[0].id`): `defect-record.ts:112` → `ad220a03e411…`; `tools/repair/signature.mjs` → `cd3e4a3880795d5b…`; `tools/replay/signature.mjs` → `spec/suite.manifest.json#…` (16-hex). **AGREE: false.** The writer also KEEPS array subscripts, so `[3]` buckets apart from `[0]`. | Worthless to unify until a repair driver exists (item 2) and until `violations` is non-null (item 3). **Adopt the reader's index-collapsing formula; add the cross-side test neither lane has.** |
| **5** | **THE CLIENT HALF OF THE ENQUEUE PATH.** The route exists and is curl-able; the owner cannot file a ticket from the page. | `grep -n supervisor dashboard/src/lib/api.ts` → `supervisor`, `supervisorStart`, `supervisorStop` only. The strip has three buttons: `start`, `stop (drain)`, `detail`. | `dashboard/src/lib/api.ts` was modified in the working tree by another lane, and a strip control is a taste-surface change with no test runnable in a build phase. |
| **6** | **`createSupervisorSubmit` HAS NEVER EXECUTED AGAINST A REAL `RunStore`, `RunEventBus` OR `Orchestrator`** — only against four fakes whose `createRun` returns `{runId} as unknown as RunRow`. A `NewRun` column mismatch or a `bus.emit` signature drift would compile and pass. | `dashboard/server/src/supervisor-boot.ts`; `find dashboard/runs -name defect.json` → nothing, so no supervisor-created run exists. | It needs a live server, which a build phase may not start. **This is the first thing to exercise.** |
| **7** | **NO BACKOFF AND NO CEILING.** The claim-step cap makes the submission-throw spin bounded (≤ `maxAttempts` ticks), but each failure costs a real attempt, and there is no per-ticket wall-clock or spend ceiling. | `grep -c "wall\|deadline\|budgetMs" dashboard/server/src/supervisor.ts` → **0**. The only spend brake is `budget_exceeded → owner_action → blocked`. | Timeboxed out. Note the constraint found while measuring: the claim step reads `listSupervisorTickets(['queued'])[0]` with **no time filter**, so `nextActionAt` on a `queued` ticket does not delay a claim — `waiting` + `nextActionAt` is the viable backoff state. |
| **8** | **THE ORPHAN RUN.** A submission that creates the run row and *then* throws leaves a run named by no ticket, invisible to `#inFlight()` (which walks tickets only) and to `GET /api/supervisor`. | `supervisor.ts:567 #inFlight()` walks tickets only; the submission catch at `:496` leaves `currentRunId` null. | **Reasoned from the code, NOT measured** — nobody confirmed `pump()` picks up such a row, so no quota-loss claim is made. |
| **9** | **`POST /api/supervisor/abort-now` ANSWERS 501 AND THE STRIP HAS NO ABORT CONTROL.** | `http.ts:1520` → `501 abort_not_wired`; 400 `confirm_required` without `{"confirm":true}`. | It refuses honestly rather than cancelling a run and leaving its ticket `queued`, which would let the next START re-spend on the run the owner just killed. Needs `abortNow(reason)` on the loop. |
| **10** | **TIER 3 DOES NOT ENFORCE `NO_INDEPENDENT_CHECK` OR `SCOPE_UNIMPLICATED_FILE`**, both of which exist mutation-proved in `tools/repair/evidence.mjs`. | `runGate` calls `validateProposal(proposal, closure)` with **no defect record and no replay result**, so adopting those two codes would refuse every proposal for ever. Written into `tools/tier3/proposal.mjs`'s docblock. | Precondition: make `defect` and `independentCheck` required inputs to `runGate` — which means the gate needs a caller that supplies a real defect record and an executed replay (items 2 + 3). |
| **11** | **`noOpAblation` IS A STRING NOTHING EXECUTES.** A Tier-2 agent that fabricates it satisfies that proof. | `tools/tier3/gate.mjs:114` — non-empty-string test only. | The three CONTAINER proofs cannot be fabricated this way, which is why they carry the mode gate. The ablation runner is unbuilt. |
| **12** | **ZERO CONTAINER KNOWN-BAD ARMS.** Five entries and two §6.6 arms are registered UNARMED, so every inside-closure patch parks as SELF-PROPOSE and the sealed grader's negative arm is entirely absent. | The gate prints `17 arm(s) held; 5 UNARMED (kb-rescore-run1-21-20-1, kb-calibration-must-fail-five, kb-fixture-g-container-leg, imp-001-forbidden-persistence, imp-004-contradicted-flow)`. | Needs docker executors (`rescore.mjs` + `probes/calibration-4a.mjs`). **Do NOT flip `armed:true` without an executor** — an armed entry with no `run()` is the 22nd instance. |
| **13** | **`calibration-4a.mjs`'s JOURNALING IS STILL UNFIXED** — DESIGN §9 step 1, the cheapest item in the whole build order. "Re-run until it goes green" is still frictionless and invisible **in the one probe the gate turns on**. | `probes/README.md` specifies the mechanism; `tools/tier3/trail.mjs` implements it for the gate's own trail and nothing else. | Not in any lane's file list. |
| **14** | **`humanReviewed` IS `null` ON EVERY TRAIL RECORD AND NOBODY HAS DESIGNED WHO APPROVES OUT OF LOOP.** | `RESEARCH` §5 item 4. 4 records exist in `dashboard/data/tier3/history/` (gitignored, absent from `git status`). | Owner-only decision. Now DESIGN §10.5 item 9. |
| **15** | **STILL NOT TOUCHED FROM THE `a913c871` TABLE: N6, N8, N9, N11, R4.** Plus **B2** and **B4**, carried since 2026-08-09 for the same reason (they live in `bakeoff/src`). | The table at the head of §6. | Out of scope for a round aimed at not stopping. |
| **16** | **THE TIER 3 TRAIL LOCATION DEPARTS FROM DESIGN §6.7, DELIBERATELY, AND IS UNRATIFIED.** §6.7's path is inside the FROZEN-DATA prefix, so the gate's own output would invalidate its own integrity check every cycle. | `tools/tier3/trail.mjs:34-38` defaults to `dashboard/data/tier3` (`TIER3_TRAIL_DIR` overrides). That directory is **gitignored**. | The reasoning is right and written in the file; the design still says otherwise, and nobody has said where a gitignored append-only audit trail is backed up. |
| **17** | **HOUSEKEEPING.** `dashboard/server/dist-repair/` is a private outDir left in place for a Verify phase (gitignored, absent from `git status`); 4 gate trail records were written into `dashboard/data/tier3/history/`. | `ls -d dashboard/server/dist-repair` → exists. | Left deliberately; delete or ignore. Nothing reads either but the targeted `node --test` invocations in §6.8. |

#### 6.7 EVERY HANDOFF FILED BY THE FIVE LANES, AND ITS STATUS AFTER THE REPAIR PASS

**Five of the eighteen were CLOSED by the repair pass. The rest are open, and three of them
were filed against facts that had already changed by the time the verifier read them.**

| lane → owner | handoff | status 2026-08-10 |
|---|---|---|
| supervisor-core → `index.ts` | construct `SupervisorLoop`, call `armCheck()` once at boot and refuse `desired='running'` if blind, 30 s `setInterval(...).unref()` cleared in shutdown, `onRunSettled` | **CLOSED.** `index.ts:37-38, :86-112, :159`, `supervisor-boot.ts`. The arm gate is implemented AND called; a BLIND loop installs no interval, takes no boot tick, and is forced to `stopped` **with the reason written to the row** so `GET /api/supervisor` reports the refusal rather than only stdout. |
| control-surface → supervisor-core | *"`SupervisorLoop` has NO `tick()` method"* | **STALE WHEN FILED.** `tick()` is at `supervisor.ts:367` and is what the verifier drove. |
| control-surface → supervisor-core | *"nothing constructs a `SupervisorLoop`; `grep -in supervisor index.ts` → ZERO hits"* | **CLOSED** by the repair pass, as above. |
| supervisor-core → control-surface | `submitRun` extraction out of `createRun` in `http.ts`, with the two hard requirements (`interactive:false`/`designLock:"auto"` straight through; keep the capture ordering because the outline is folded into `ticket.id`) | **OPEN, and worked around rather than done.** `createSupervisorSubmit` is a SECOND implementation that deliberately does not capture — a capture is a live network read folded into ticket identity, and two attempts at one ticket would mint different ids, find no frozen suite and pay for a second spec phase. **Two implementations of run creation now exist and nothing keeps them in sync.** |
| control-surface → supervisor-core | `abortNow(reason)` that cancels AND parks the ticket `blocked`, so the 501 can be replaced | **OPEN.** §6.6 item 9. |
| control-surface → Tier 2 | three wire fields have no producer: `attempts[]`, `lastDefect`, `lastRepair`, named on the wire in `probe.unsourced` with a test asserting the exact array | **OPEN.** The test goes red the moment a name is removed without a producer landing — but a name removed *with* no producer would go green wrongly. |
| control-ui → server | add `attempts: readonly {n,at,problems}[]` to `ApiSupervisorState` from `results/authoring-trail.json`; the client change is ONE line | **OPEN AND DELIBERATELY DEFERRED.** Inert until §6.6 item 3 lands: on prose-only `problems` the comparator degenerates to always-escalate-at-2, and for an unattended machine a false stop costs the same as a miss. |
| control-ui → server | `ApiSupervisorState` has no timestamp, so the strip ages readings against its own fetch and cannot catch a server answering instantly with an hour-old body | **OPEN.** One field (`at`), one isolated arm in the classifier. |
| control-ui → Verify | run `supervisor-strip.browser.spec.ts` (6 tests, unexecuted), `run-layout.browser.spec.ts` (the `scale > 0.7` at 2000×1200 the 30 px strip threatens), `prose-guard.browser.spec.ts`, `rail.browser.spec.ts` | **OPEN.** The verifier aborted the browser suite at 64 of 267 and none of these four had run. |
| control-ui → a human | four screenshots (`screenshots/supervisor-strip-{running,idle,stuck,unreachable}.png`) must be looked at | **OPEN — never taken.** The spec that writes them never reached a passing state. **No visual claim about the strip is verified.** |
| replay → whoever owns a `package.json` | four script entries, with the note that `node --test tools/replay/` MODULE_NOT_FOUNDs on Node 25.9 and the glob form works | **REFUSED with a measurement** — §6.6 item 2. Commands in §6.8. |
| replay → the defect writer | import `defectSignature` from `tools/replay/signature.mjs` rather than reimplementing, or the defect stream and the corpus bucket the same defect two ways | **OPEN, and now three-way** — §6.6 item 4. |
| replay → `docs/RUN-a913c871-observations.md` | **A CORRECTION TO A DOC THIS ROUND DOES NOT OWN.** That post-mortem's cost model implies the 559,692-byte reference PNG (746,256 base64 chars) reaches every seat call. Counting every image and document block across all three authoring transcripts gives `{('user','document','application/pdf'): 1}` per transcript and **no image block at all** — events 9/15/21/27 are the PLAN seat. **The spec seat was shown the CV and not the reference image**, so a per-authoring-call budget including 560 KB of PNG is over by that much. | **OPEN — filed here because the file is not editable this round.** |
| replay → CI | `node tools/replay/replay.mjs` exits 1 on any blind arm or any case disagreeing with its record, in ~150 ms with zero model calls. **It is the cheapest possible guard on a `bakeoff/src` prompt edit and should run before any digest-moving change is accepted.** | **OPEN** — no CI file exists. |
| repair-agent → the defect writer | per-attempt structured paths, or item D is inert | **OPEN** — §6.6 item 3, and asserted rather than assumed by `loop-guard.test.mjs`'s *"THE PRODUCTION SHAPE: a contract-exact `DefectRecord` makes this rule BLIND"*. |
| repair-agent → Tier 3 | wire the real §6.1 closure list; defaulting it to `[]` makes the check inert | **CLOSED** — now a required argument with a named `NO_FROZEN_CLOSURE` refusal on absent OR empty, in both `evidence.mjs` and at `cycle.mjs` entry, with the negative control being a `scorer.ts` diff with the closure omitted. |
| repair-agent → the supervisor | production wiring needs a ledger directory and an isolated build root **outside** the repository | **OPEN.** `PRODUCTION_LEDGER_DIR` names `dashboard/data/defects/ruled-out` and nothing creates it. |
| repair-agent → nobody | **NOT BUILT, named rather than silently omitted: the patch AUTHOR**, and the blind-second-seat overfitting gate (`RESEARCH` R7a) with a recorded known-bad corpus from `a913c871` / `162b186d` / `c228e63b` (R7b). `independentReplay` is the mechanism and is proven working; it has no real corpus, only synthetic sandbox cases. | **OPEN. Building that corpus is the cheapest remaining strengthening of the accept path.** |
| tier3-gate → Verify | the container legs, and the `--exec=container` mode that does not exist | **OPEN** — §6.6 item 12. |

#### 6.8 WHAT THE REPAIR PASS REFUSED, and the measurement behind each refusal

Three refusals, all recorded rather than quietly skipped. **In each case the reviewer's fix
as literally written would have made something worse, and the measurement is what shows it.**

1. **"`tools/tier3/proposal.mjs` must call `tools/repair/evidence.mjs#validateProposal` and
   ADOPT ITS REFUSALS."** Refused as written, **adopted as a named four-code whitelist.**
   Measurement: `evidence.mjs` unconditionally adds `NO_INDEPENDENT_CHECK` unless
   `ctx.independentCheck.ran === true` and `SCOPE_UNIMPLICATED_FILE` unless `ctx.defect` names
   the paths; `runGate` supplies **neither**. Wholesale delegation would refuse **every**
   proposal for ever, including the honest `a913c871` repair the suite pins as APPLY — the
   mirror-image bug, and the one direction that *does* stop the pipeline. The four codes that
   ARE decidable from the proposal alone were adopted, and the two that are not are carried
   forward with their precondition (§6.6 item 10).
2. **"Add the `tools/**` commands to whatever the Verify phase runs"** — which requires a root
   `package.json`. Refused: there is none (`ls package.json` → *No such file*), and creating
   one introduces a package boundary above three existing packages that changes Node's module
   resolution for every file beneath it. **The commands, all run green this round, all needing
   no new package:**
   ```
   node --test tools/repair/*.test.mjs        # 72 tests, 8.7 s
   node --test tools/replay/replay.test.mjs   # 14 tests, 0.2 s  (the DIRECTORY form MODULE_NOT_FOUNDs on Node 25.9)
   node --test tools/tier3/gate.test.mjs      # 24 tests, 0.8 s
   node tools/repair/arm.mjs                  # 7/7 arms live, exit 0
   node tools/replay/replay.mjs --rounds      # 5 cases, 4 arms ARMED, ~150 ms, zero model calls
   node tools/tier3/gate.mjs --proposal <f>   # 5 arms + 17 known-bad arms
   ```
   Where they belong — a Verify runner, a Makefile, or CI — is a pipeline choice, not a build-lane one.
3. **"Wire `attempts` onto the wire and replace the client constant."** Refused as INERT, not
   on merit — see §6.7 and §6.6 item 3. The ordering is: structured `violations` first, then
   the wire field. Wiring it now ships a detector that fires on attempt 2 of every ticket.

---

### THE CONCURRENT CLASSIFIER / SPEC-AGENT ROUND, 2026-08-10 — recorded here because §7's five lanes are not these two

**Two lanes ran in parallel with §7's five, against the same DESIGN document, on a
disjoint file list: `dashboard/server/src/recovery{,.test}.ts` (lane `classifier`) and
`bakeoff/src/spec-agent{,.test}.ts` (lane `authoring-loop`).** §7 records the supervisor,
the defect record, the replay harness and the Tier 3 gate; this block records the failure
vocabulary those lanes route on, plus the two authoring changes. §7.3 already refers to
this round twice (*"the concurrent round is splitting the class right now"*, and the two
renamed `recovery.test.ts` leaves) — this is that round.

**MARKER FOR THIS BLOCK'S EDITS, measured against its own output rather than written and
hoped for (§R5 is this document's own precedent for a locator that matches nothing):**

```
grep -cn 'CLASSIFIER / SPEC-AGENT ROUND\|^#### 6\.9\|^#### 6\.1[0-3]' docs/STATE-2026-08-09-where-we-are.md
→ 7    # this heading, §6.9-6.13, and this line
```

§7's own marker (`^#### 6\.[678]`, measured at 13) is unaffected: `6.9`–`6.13` do not match
its character class. Neither count is wrong.

#### 6.9 THE CLASS SPLIT — twelve codes, six classes, and EVERY bound still 0

`classifyPhaseFailure` no longer maps every non-null `bakeoffCode` to `structural` on one
line. It calls a new exported pure function `classOfBakeoffCode(code)`
(`dashboard/server/src/recovery.ts`, list constants at `:832-850`).

**THE TABLE IS THE VERIFIER'S, EXERCISED END-TO-END** — a real `BakeoffError` →
`signalsFor` → `classifyPhaseFailure` → `boundFor` → `planRecovery`, with the twelve codes
**parsed from `bakeoff/src/contracts.ts:57-69`** (12 confirmed) rather than from
`recovery.test.ts`'s own copy of them:

| code | class | bound | decision |
|---|---|---|---|
| `missing_credential` | `owner_action` | 0 | STOP `class_terminal` |
| `budget_exceeded` | `owner_action` | 0 | STOP `class_terminal` |
| `suite_hash_mismatch` | `integrity` | 0 | STOP `class_terminal` |
| `unknown_model_price` | `accounting` | 0 | STOP `class_terminal` |
| `unpriced_usage` | `accounting` | 0 | STOP `class_terminal` |
| `ambiguous_price_window` | `accounting` | 0 | STOP `class_terminal` |
| `invalid_effort` | `accounting` | 0 | STOP `class_terminal` |
| `duplicate_usage_row` | `accounting` | 0 | STOP `class_terminal` |
| `not_implemented` | `harness_defect` | 0 | STOP `class_terminal` |
| `unknown_config` | `harness_defect` | 0 | STOP `class_terminal` |
| `suite_not_audited` | `suite_authoring` | 0 | STOP `class_terminal` |
| `invalid_usage_shape` | `structural` | 0 | STOP `class_terminal` |
| *`a_code_added_in_2027`* | `structural` | 0 | STOP `class_terminal` — the unknown-code default |

Six distinct classes, six **distinct** terminal sentences, **all bounds 0, every decision a
stop.** `classOfBakeoffCode(code)` agreed with the class reached through `signalsFor` on all
13 rows. Re-readable today:

```
sed -n '/export function boundFor/,/^}/p' dashboard/server/src/recovery.ts | grep -c 'return 0;'   → 6 arms at 0
grep -n 'AUTO_CONTINUE_MAX\|TRANSIENT_MAX' dashboard/server/src/recovery.ts                        # throttled/interrupted/transient only
```

**WHAT THE SPLIT BUYS, BOTH HALVES — reading one half gives the wrong verdict.**

- **Nothing retries in-run, and this round did not change that.** `#recoverFrom`
  (`orchestrator.ts:6801`) still reads `if (klass !== "throttled") return false`, so a
  `BakeoffError` never reaches `planRecovery` at all — it is classified for the record and
  the run is failed. Re-grepped by the verifier on the dirty tree *after* a sibling edited
  that file. **The split is a LABEL and a SENTENCE, not a budget.**
- **But the names are load-bearing, and Lane A's own handoff understated this.**
  `supervisor.ts:37` imports `boundFor, isRepairable` from `./recovery.js`; `:732` reads
  `isRepairable(recoveryClass)` to route `blocked` vs `repairing`, and
  `orchestrator.ts:7307` writes `repairable` into every defect record from the same
  predicate. **Net: two of the twelve codes (`missing_credential`, `budget_exceeded`) are
  refused an automated repair BY NAME; the other ten are handed to a repair proposer that
  does not exist** (§6.6 items 1 and 2).
- `isRepairable` (`recovery.ts:289`) is the single answer both consumers read — `intentional`,
  `owner_action`, `integrity` → false; the rest → true. It exists because the two consumers
  had disagreed: the defect record derived `repairable` from `boundFor(...) > 0`, which with
  this round's deliberate all-zero bounds is `false` for **every** `BakeoffError` code, while
  the supervisor routed the same ticket to `repairing`. **That disagreement reached the
  owner** and is now pinned from both ends (`supervisor.test.ts` asserts
  `blocked === !isRepairable(klass)` over all eleven classes; `orchestrator.defect-record.test.ts`
  asserts the written record agrees with `isRepairable` of its own class).

**WHY NO CLASS GOT A NONZERO BUDGET — three measurements, not caution.** (i) the re-entry
gate above; (ii) the phase boundary carries nothing — `grep -arn authoringTrail bakeoff/src
dashboard/server/src` finds one writer for the frozen-suite trail, on the success path
(`spec-agent.ts:2401`), so a PHASE-level retry re-runs three authoring attempts knowing
nothing about the three that just failed; (iii) DESIGN §3.5: *"Per-class N shipped WITHOUT
the fingerprint is strictly worse than today"*, and §3.4's fingerprint gate does not exist.
**A budget written into `recovery.ts` today would spend nothing, and everything on the day
`orchestrator.ts:6801` changes.**

**THE MUTATION DISCLOSURE, AND IT IS THE POINT OF THIS ENTRY.** The test named
*"EVERY BakeoffError code stops, including one this file has never heard of"* **stays GREEN
under the collapse mutation** (`return classOfBakeoffCode(...)` → `return "structural"`).
That is arithmetic, not an oversight: every bound is 0, so `0 === 0` whichever class a code
lands in, and **a bound assertion structurally cannot detect a split whose bounds are all
equal.** The red therefore comes only from the paired tests that assert the class NAMES and
the pairwise distinctness of the six sentences (`1 !== 6` on the collapse). Lane A reported
this rather than presenting the bound test as the proof; the verifier reproduced the collapse
independently (52 tests / 46 pass / 6 fail, same leaf names) and confirmed the green.
**Reporting the bound assertions alone would have been instance twenty-two.**

**LANE A'S DISAGREEMENT WITH THE ROUND'S OWN BRIEF — recorded so nobody re-proposes it.**
The brief named four codes as repairable; three are not.

1. `invalid_usage_shape` stays on the bound-0 **default**. Its throw sites span
   `mergeSeatUsage was given no rows` (`anthropic-seat.ts:366`), `maxOutputTokens must be a
   positive integer` (`:605`), `config A has no orchestrator seat` (`dryrun.ts:625`) — all
   programmer faults — the 2026-08-04 overflow death whose own remediation says regenerating
   cannot fix it, **and** the one genuinely repairable member, the manifest parser's `fail()`.
   **From the code alone these are indistinguishable.** Splitting it needs the structured
   `detail` carrier of DESIGN §3.2, written at the throw site.
2. `not_implemented` / `unknown_config` are `harness_defect` at 0, per DESIGN §3.3 B3 (Tier 2,
   offline, *"**0** in-run"*). Nothing a run can do to itself implements a seam.
3. `invalid_effort` has **zero** `new BakeoffError` sites anywhere:
   `grep -arn invalid_effort bakeoff/src dashboard/server/src | grep 'new BakeoffError'` →
   **one hit, and it is `recovery.ts:813`, the docblock recording the absence.** It exists
   only as an `env.ts:299` blocker `kind`. Classified into `accounting` anyway, deliberately:
   *a class that exists only once it fires is a class nobody has ever read.*

**CARRIED FORWARD FROM THE SPLIT.** (a) `recovery.test.ts`'s twelve-code list is an
**unguarded copy** of `contracts.ts:57-69` — `recovery.ts` may not import the harness and
there is no runtime array of the codes to import, so a thirteenth code will NOT turn it red;
the cost is a missing name, not a wrong decision (the `a_code_added_in_2027` row pins the
default), but it drifts silently. This is why the verifier parsed `contracts.ts` instead.
(b) `boundFor` and `planRecovery` are coupled in a way the compiler cannot enforce: raising
any of the five new bounds without adding a `planRecovery` arm produces a stop whose sentence
claims a rate limit that never happened — **measured**, not predicted, under the mutation that
gave `owner_action` a budget: the owner's SPEND REFUSAL was reported as *"reported as a rate
limit but arrived with no reading of the refusal itself."* Recorded in both docblocks; a test
asserting *"a class with a nonzero bound has an arm in `planRecovery`"* would close it and
does not exist. (c) Five new strings can enter `runs.recovery_class`; the verifier confirmed
the absence of any consumer rather than relaying it (`grep -arn
'recoveryClass|recovery_class|owner_action|suite_authoring|harness_defect'` over
`dashboard/src` → **0**; `backlog.ts`'s `NEXT_ACTION` Record is over `gate-report.ts`'s
unrelated `FailureClass`). The risk is interpretive: a reader who pattern-matches
`recovery_class = 'structural'` to mean *"a BakeoffError killed it"* now misses five sixths
of them. (d) `unclassified` reads `repairable: true` while its own terminal sentence says
nothing here can say a retry would help — true because `isRepairable`'s contract is to BE the
supervisor's routing rather than second-guess it; verified inert (nothing branches on the
field). (e) `recovery.ts:176-177` cites the trail writer at `spec-agent.ts:1614`; it is now
`:2401`. **The line number is stale, the claim is not** — one writer, success path.

#### 6.10 THE AUTHORING RETRY NOW CARRIES ITS OWN HISTORY — the sentence that made `a913c871` unconvergeable is deleted

**Deleted, verbatim, from `bakeoff/src/spec-agent.ts`:** *"Your previous suite for this
ticket was rejected by the bad-test audit and has been discarded. … Do not try to patch the
old one — you no longer have it."* `feedbackTurn` is gone
(`grep -c feedbackTurn bakeoff/src/spec-agent.ts` → **0**); the sentence survives only inside
the JSDoc that documents what was replaced, which is why an in-image `grep -ac` for it
returns 1 and **the naked count misleads** — the Rebuild phase re-ran the greps against a
comment-stripped copy of the image's own `dist` and got `raw=1 code=0` for all three
sentences, with `feedbackTurn` at `raw=0`. The stripper returned three distinct verdicts
(COMMENT-ONLY, LIVE CODE, ABSENT) in one run, so it is not a probe that can only observe one
outcome.

Three ordered turns replace it, exported so a test can name them:

```
grep -n 'TURN_MARKER_\w* =' bakeoff/src/spec-agent.ts
1026: TURN_MARKER_TICKET      = "TURN 1 OF 3 — THE TICKET"
1027: TURN_MARKER_PRIOR       = "TURN 2 OF 3 — YOUR OWN PREVIOUS EXECUTION MANIFEST"
1028: TURN_MARKER_CONSTRAINTS = "TURN 3 OF 3 — EVERY CONSTRAINT FROM EVERY ATTEMPT SO FAR"
```

- **MANIFEST ECHO.** The most recent `suite.manifest.json` any attempt produced, verbatim
  inside `<<<PREVIOUS_MANIFEST … PREVIOUS_MANIFEST>>>`, attributed by attempt number, with
  *"EVERY PART OF IT THE CONSTRAINTS BELOW DO NOT NAME WAS ACCEPTED. Keep those parts as they
  are — re-deriving a field that was already correct is how a field that was already correct
  gets lost."* When no manifest exists the turn **says so and says why** rather than being
  omitted.
- **ACCUMULATION.** `let feedback` (overwritten in three places) became a `const
  constraints[]` that is only appended to, grouped under `FROM ATTEMPT N:` headings, with
  *"A defect listed under an early attempt and NOT listed again under a later one was FIXED
  by that later attempt. Do not undo it."* No dedup across attempts — deliberate, so
  recurrence is visible.
- **ATTEMPT 1 IS UNCHANGED BYTE-FOR-BYTE** (single unlabelled ticket turn), so
  `authoringPromptSha256` on a first-attempt success is identical to before and frozen suites
  stay comparable.
- **SCOPE: the manifest only, not the suite.** `a913c871`'s three structured outputs were
  63,957 / 50,125 / 63,258 bytes against manifests of **1,467 and 1,417 bytes** (~2%) on a
  call with a 64k output ceiling that already carries an 80,102-byte PDF. Attempt 3's manifest
  is reported as 1,326 bytes by the lane and is **NOT verified** — it is not in the repo and
  was not in the two transcripts the verifier searched.

**THE PROOF IS A REPLAY OF `a913c871`'s OWN BYTES, AND THE VERIFIER BUILT ITS OWN.** The
verifier re-extracted the two manifests from the Claude Code CLI transcripts
(`cfdffda9…`, `60fcb909…`) by brace-balancing, byte-compared them to the lane's fixtures —
**1,467 vs 1,467 and 1,417 vs 1,417, IDENTICAL** (both the lane's handoff and its docblock
report 1,468/1,418; **off by one, a reporting nit, corrected here**) — then drove the real
exported `generateAuditedSuite` with its own recording caller. **Arm check first:** 3 spec
calls made, failed with `suite_not_audited`, so the audit really rejected and the
prompt-building code really ran. Turn counts 1 / 3 / 3; prompt bytes 351 / 5,584 / 7,473.

- attempt 2's prompt contains attempt 1's 1,467 transcript bytes **verbatim** inside the
  fence; `you no longer have it` **ABSENT**. Attempt 3 holds attempt 2's manifest and **not**
  attempt 1's.
- attempt 3 carries `FROM ATTEMPT 1:` items 1-9 **and** `FROM ATTEMPT 2:` items 10-15. A
  constraint attempt 1 was given, **repaired on attempt 2 and absent from attempt 2's own
  list**, is present in attempt 3's prompt — so it can only be there by accumulation.
- attempt 2's prompt names **all six** manifest defects in one pass
  (`dataExpectations[0].id must be a non-empty string`, `[0].kind must be "sqlite" or "http",
  got undefined`, `[0].minRows must be a finite number >= 1`, and the same three for `[1]`).
  `.id must be a non-empty string` appears **twice** in attempt 3's prompt — **the
  requirement whose violation killed attempt 3 is on the page at the moment it would be
  violated.**

**THE ANSWER, PLAINLY, AS THE VERIFIER PUT IT:** a seat given the new attempt-3 prompt could
not lose `id` the way attempt 3 did — not because it is forced to converge, but because
losing `id` would require deleting a field printed verbatim in its own prompt whose
requirement is restated in the same prompt. **What attempt 3 lacked is present. Convergence
is NOT proven and is not claimed** — the only evidence is a replay, not a live seat. The
verifier's replay carries its own negative control: re-pointed at the mutation build that
returns `previousManifest: null`, all four manifest claims flip to NO and the prompt bytes
fall 5,584 → 3,942 and 7,473 → 5,881.

**SEALED BOUNDARY.** Every field of the retry context is either the seat's own prior output
on the same ticket in the same job, or a harness rejection sentence it already received one
attempt at a time. The guard test was **narrowed during the repair pass**, on a measurement:
its bare-word regexes (`/workspace/i`, `/builder/i`, `/\bimplementation\b/i`,
`/package\.json/`) would have fired on legitimate audit prose — **the audit finding kind is
literally `leaks_implementation`** — and a guard that reds on a benign word gets deleted.
Replaced by shapes that cannot come from inside the seal (absolute POSIX roots,
`node_modules/`, `git diff|log|status|show|apply`, diff hunk headers) **plus a real
provenance assertion**: every constraint bullet's file-shaped tokens must appear in the
ticket or in the seat's own responses, and the fenced block must be **byte-equal** to a
manifest the seat emitted (a re-serialisation is the harness putting words in the seat's
mouth). Both halves fire independently under mutation — including a path-shapeless foreign
file name that only provenance can see.

**RISK CARRIED FORWARD: feedback VOLUME goes up again and nothing has measured how a seat
responds to it.** N3's collect-all already turned one complaint into five; attempt 3 now
carries all three attempts' complaints plus a ~1.4 KB manifest (~11 KB regeneration prompt
in the fixture). **The cheapest next measurement is one real run.** Also: `ATTEMPT_1_MANIFEST`
/ `ATTEMPT_2_MANIFEST` in `spec-agent.test.ts` are the **only copies of `a913c871`'s
authoring output in version control**; attempt 3's manifest, the prompts and the token counts
still exist only under `~/.claude/projects/…`, which is not a harness artefact and is not
backed up.

#### 6.11 A PER-CALL WALL-CLOCK BOUND — 60 MINUTES, NOT 30, AND WHAT IT COSTS

```
grep -n 'DEFAULT_ATTEMPT_TIMEOUT_MS =\|TIMEOUT_FAILURE_MARKER =' bakeoff/src/spec-agent.ts
1309: export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60 * 60 * 1000;
1378: export const TIMEOUT_FAILURE_MARKER = "were abandoned on the per-call wall-clock bound";
```

**THE LANE SHIPPED 30 MINUTES; THE REPAIR PASS RAISED IT TO 60, AND THE REASON MATTERS MORE
THAN THE NUMBER.** `a913c871`'s attempts ran **25m23s / 35m25s / 23m43s**. A 30-minute bound
fires on **attempt 2** — the attempt whose manifest carries `"id": "contact-messages-stored"`,
i.e. the exact field whose loss defines this round, and the document §6.10's echo feeds
forward. Under 30 minutes attempt 2 produces nothing, `lastManifest` stays on attempt 1's
`{entity, source, expectation}` vocabulary (no `id`), and attempt 3 is shown the **worse** of
the two documents plus *"write less"*. The lane's own docblock had attributed that harm to
the tighter bound it rejected rather than to the one it shipped. 60 min is derived from the
measured distribution instead of from `AUTHORING_BUDGET.maxWallClockMs` — a policy **not in
force in production**, which passes `DASHBOARD_BUDGET` (4 h) — and is 1.7× the slowest
progressing attempt ever measured here. **Judge the number; do not inherit it.**

- **Per CALL, not per attempt** — the free truncation retry is a second call inside one
  attempt, and a per-attempt budget would hand it the remainder and silently kill the ladder.
- **Default-ON**, because `orchestrator.ts` passes nine options to `authorAndFreezeSuite` and
  would never set an opt-in one (the `onEvent`-with-no-reader failure this file already
  documents). Env override **`BAKEOFF_SPEC_ATTEMPT_TIMEOUT_MIN`** (minutes; `0` disables;
  malformed values THROW rather than reverting silently). It is an env var precisely so
  tightening the bound **does not move the scorer image digest**.
- **First-class outcome, not a convention.** `GenerateSuiteResult` is a three-way
  discriminated union, so `wasTruncated(generated.call)` and `generated.call.usage.costUsd`
  are compile errors on the timeout path. `AuthoringTrailEntry` gained `timedOut?`
  (`bakeoff/src/spec-freeze.ts`) — it had been reaching AUDIT.json **undeclared**, because
  `authoringTrail: authored.attempts` is a variable and not a fresh object literal, so no
  excess-property check ran and every reader of the trail type was blind to abandonment.
  `readAuthoringAttempts` now puts the abandonment FIRST on the row's problems, using
  `=== true` and never truthiness, so a pre-2026-08-10 trail claims nothing.
- **The bound now actually fires.** `timer.unref?.()` was removed: an unref'd deadline timer
  does not hold the event loop open, so a CLI invocation whose only pending work is a
  handle-less hung promise — **exactly the hang the bound exists for** — drained and exited 0
  instead of abandoning. Measured by hand in scratch in both directions before the test was
  written: ref'd → stdout `ABANDONED`, exit 0; unref'd → **no stdout**, exit 13 *"Detected
  unsettled top-level await"*. So `assert.notEqual(status, 0)` would have been GREEN on the
  broken version — the check inverted — and the assertion is on stdout.

**THE SPEND HOLE THE BOUND OPENED, AND THE SENTENCE THAT DENIED IT.** The bound **abandons,
it does not cancel** (`SeatCallRequest` carries no `AbortSignal`), so attempt N+1 is
dispatched while attempt N's call is still in flight — the first concurrency this phase has
ever had. `SpendCeiling.checkBeforeCall` projects from `#spentUsd`, which an abandoned call
reaches only **if it returns**, and `collectUsage(specCaller, judgeCaller)` runs synchronously
at the return and at the throw — so a late-returning abandoned call's usage row is **lost,
not late**, and `callWithDeadline`'s docblock claim that *"its spend is accounted late rather
than lost"* was **false, not imprecise.** Both halves were fixed: a new
`reserveAbandonedCall` charges the ceiling the worst case off the abandoned call's **own**
pre-call decision at the moment of abandonment (found by index, because `PreCallDecision`
carries no `purpose`), and the false sentence is replaced by the measured one. Arithmetic
proof in the test: ceiling $2.50, worst case $1.00/call, refusal lands **exactly on dispatch
3** with `budget_exceeded`; without the reservation all three are authorised for $3.00.

**AND THE HALF THAT CANNOT BE FIXED HERE, refused rather than sold.** On the dashboard's own
`SubscriptionSeatCaller` the pre-call check is `checkBeforeCall(0, …)` — a subscription call
has no dollar cost — so **the reservation is $0 and the cost ceiling cannot fire on the only
path this failure has ever been observed on.** The quota those orphaned `claude-agent-sdk`
subprocesses consume is **not dollars**, and no `SpendCeiling` reservation can bound it; only
cancellation can, and that needs an `AbortSignal` on `SeatCallRequest` — a different file.
The owner-facing failure sentence therefore **branches on the actual figure**, reports it
(`$X.XXXX across N abandonments`) and makes the zero case the loud one. A mutation that
restored the unconditional claim goes red.

**HANDOFF NOT TAKEN, and it is the one new failure mode this round introduces.**
`TIMEOUT_FAILURE_MARKER` has three occurrences repo-wide and **no consumer in
`dashboard/server/src`** — so an all-timeout authoring phase throws `suite_not_audited`,
classifies as `suite_authoring`, and the owner-facing sentence pointed him at *"the blocking
findings on the error"* when `last.findings` is `[]`. **The sentence was fixed** (it now
points at the channel that is always populated — the thrown message: the last attempt's
problems, the output-token rung per attempt, and the wall-clock bound in both directions —
and says explicitly that a blocking finding is not guaranteed). **The class was not built**,
deliberately: it needs a `message` field on `PhaseFailureSignals` (whose absence is
deliberate), a duplicated marker in a module that argues for not importing `bakeoff/`, arms
in `boundFor`/`terminalClassReason`/`isRepairable`, and — for any nonzero bound — a
`planRecovery` arm plus the §3.4 fingerprint gate. **Filed as DESIGN §3.7 with the marker's
exact text and *"do not delete the constant to close this."***

#### 6.12 THE DIGEST, THE CALIBRATION AND THE RUN-1 RE-SCORE — cross-reference, not a second record

**§6.0's table is the authority and is already correct for this round.** Do not read this
round's lane reports for digests: **`newDigest: ec79e1efbe81…` is stale.** It was the image
at 08:43 (authoring-retry history + the per-call bound) and is now the **rollback tag
`bakeoff-scorer:pre-repair-2026-08-10`**; the repair pass rebuilt twice more and the live
image is `027bc2e2…`. Re-measured while writing this block:

```
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -i bakeoff
bakeoff-scorer:1                      027bc2e2d3d2
bakeoff-scorer:pre-repair-2026-08-10  ec79e1efbe81
bakeoff-scorer:pre-never-stop         83b80ef56b67
bakeoff-scorer:pre-manifest-shape     b7a9fd0a0f58
```

**FOUR ROLLBACK POINTS NOW EXIST BY NAME, and two intermediate rungs do not:**
`d74a20aeb6bc…` (which the `gate-verified-2026-08-10` **annotated tag body names as the image
at that commit** — `docker image inspect d74a20aeb6bc` → *No such image*, confirmed
independently by the Rebuild phase and the verifier) and `5ffdc20a461c…` (11:24, before the
branched reservation sentence). **The tag body transcribed the intermediate rung as the final
one; it also reports bakeoff 143/143 where the archive tree measures 146/146 and client unit
168/168 where `--list` enumerates 171 leaves.** The rollback digests it records
(`b7a9fd0a…`) and the run-1 constants (`21c30afd…`, 20/1, REQ-013) do check out, so this is
transcription drift, not fabrication — **but a recorded rollback pointer that does not resolve
is precisely the failure this document post-mortems. OWNER ACTION: correct the tag body.**

**Calibration and the run-1 re-score were re-established, not argued safe, and the verifier
re-ran the re-score itself rather than reading the numbers:** `heldOutPass=true`,
`falseFinish=false`, `agentDeclaredDone=true`, `21/20/1`, sole failure
`FAIL QUALITY REQ-013 :: holdout/coglane-presentation.spec.mjs › [REQ-013] T-14 an empty
booking submission produces no confirmation`, `protectedPathViolations=[]`, 24 criteria PASS,
both discriminators cleared in code (`suite.sha256 ==
run.heldConstants.acceptanceSuiteSha256 == 21c30afd…`; `gate.scorerImageDigest ==
score.scorerImageDigest`). Calibration **8/8 both directions** with the two named leaves
carrying them (*"no fixture produces a FALSE PASS"* and *"the correct artefact is not failed"*),
and the third leg — the dry run — was run too rather than claiming an intact chain on two
thirds of it (24 PASS / 0 FAIL, five stages, the gate resolving the image by content digest).

**THE SCOPE LIMIT ON THAT GREEN, restated because `chainIntact: true` invites over-reading.**
Every leg printed `PASS BLOCKING GATE:data-present :: NOT APPLICABLE: the frozen suite
declares no data expectations`. **All three legs graded `dataExpectations: []`.** The chain
proves the rebuilt scorer grades the OLD, EMPTY shape identically. It proves **nothing** about
the populated shape N1 makes the spec seat emit — which is exactly the shape §6.10's replay
now shows the seat being told to produce. **§6.2's standing limit — *"no run has produced a
valid manifest, because no run has been made"* — is unchanged by this round.** (The lane's
rebuild report cites this as *"§6.4's standing limit"*; §6.4 is REFUSED THIS ROUND. The
limit is §6.2's closing paragraph.)

#### 6.13 WHAT THIS ROUND DOES NOT MAKE TRUE

**THE ROUND'S OWN PAIRING CLAUSE WAS ASSESSED AND DID NOT BIND.** The brief said a nonzero
budget without an informed retry buys identical failures, so Fix A and Fix B ship together or
neither ships. **Lane A shipped no nonzero budget** — all six classes exercised at 0 — so
there was nothing for Fix B to be paired *with*, and both stand on independent
mutation-proven evidence. The one blocking red in the tree (**80 failed browser tests**, 77
carrying `Cannot read properties of undefined (reading 'wired')` at
`supervisor-strip.tsx:205` → `app-shell.tsx:244` → `RootLayout`, so every page rendered
blank) was in files in **neither lane's list**, and reverting either lane would not have
cleared a single one of them. It was fixed at the root — a malformed 200 now yields
`snapshot: null` rather than a type lie on a field declared `SupervisorState | null`.

**WHAT THIS ROUND ADDS:** a failure vocabulary, one routing predicate two consumers agree on,
an authoring retry that can see its own previous manifest and every constraint so far, and a
wall-clock bound on a call that could previously hang for ever. **WHAT IT DOES NOT ADD:
any retry, and any repair.**

- **NOTHING RE-ENTERS A NON-THROTTLED PHASE.** `orchestrator.ts:6801`. Unchanged by this
  round, re-grepped on the dirty tree.
- **THE REPAIR AGENT DOES NOT EXIST**, and the patch AUTHOR is named as unbuilt rather than
  silently omitted (§6.7). `repairing` — where `a913c871`'s own class now lands — is a
  **terminal park with one writer and no reader that moves a ticket out of it** (§6.6 item 1).
- **THE SUPERVISOR IS BUILT AND UNWIRED.** §7 records it constructed, armed and ticking, and
  §7.3 is the honest half: `grep -rn 'tools/repair\|tools/tier3\|tools/replay' dashboard/server/src
  dashboard/src bakeoff/src | wc -l` → **0**; no supervisor-submitted run has ever reached a
  verdict; no defect record has ever been written for real; no repair patch has ever been
  applied to this repository.
- **TIER 3 IS A LIBRARY WITH AN UNARMED NEGATIVE ARM.** 17 arms held, **0 container arms
  executed**, so every inside-closure diff parks SELF-PROPOSE and the gate's refusal of a
  real grader softening was correct **for the wrong reason** (§7.3 item 2).
- **AND THE ROUND'S OWN HEADLINE FIX IS INVISIBLE TO THAT GATE.** Fix B is an authoring-prompt
  change inside `bakeoff/src`; S3–S8 grade frozen artefacts against frozen suites and the spec
  seat never runs, so the sealed gate observed nothing about it (DESIGN §6.5, §10.1, and §6.0
  of that document).

**SUITE FIGURES — ATTRIBUTED, NOT RECONCILED.** The verifier measured, and carries its own
caveat that **a third lane was editing throughout** (its own three server runs read 1927 →
1935 → 1938): bakeoff **160/160** (baseline 146/146, zero leaf names dropped); server final
clean run **1938 / 1935 pass / 0 fail / 3 skip, exit 0**; client unit **190**; `tsc --noEmit`
**exit 0 with zero output lines in all three packages**, with `bakeoff/dist` verified current
before trusting the server result. Two server leaf names were dropped — both
`recovery.test.ts` **renames with verified same-file replacements**, both red under the
collapse mutation.

**THE BROWSER SUITE — READ THE CAVEAT BEFORE THE NUMBERS.** **§7.3 states that no browser spec
in ITS round was executed by any lane, the verifier or the repair pass**, and **this recorder
did not run the suite either.** Different actors are reporting different things, and nobody
reconciled them. Against that: the verifier measured **80 failed / 186 passed / 1 skipped**
(267), and the repair pass reports **267 passed / 1 skipped** after the root fix, with wall
clock 39.1 min → 2.4 min because 77 tests had been burning their timeouts. **Re-measure before
quoting any of it. No green browser suite is claimed as a property of this round.**

---

### CARRIED FORWARD BY THE STRIP-CRASH / STILL-PARKS ROUND, 2026-08-10 — nothing here was dropped either

#### 6.14 §6.6's SEVENTEEN OPEN ITEMS, RE-MEASURED — FOUR MOVED, THIRTEEN DID NOT, FIVE ARE NEW

**Movement is stated against §6.6's own numbering so the two lists can be read against each other.
Everything below was re-measured on this tree, not carried from a report.**

| §6.6 item | movement |
|---|---|
| **1** `repairing` is a terminal park with no producer | **CLOSED as a park.** Six named outcomes, five terminal; measured live (§8.3). **The stop remains** — with no driver, every structural failure ends at `blocked` in one tick. |
| **2** nothing calls `tools/repair` / `tools/tier3` / `tools/replay` | **HALF CLOSED.** The seam and the CLI exist (`tools/repair/supervisor-cycle.mjs`, `createRepairDriver`, `createDefectSignatureReader`, each arm-checked); `index.ts` still passes no `repair` dep. Still no root `package.json`, still refused for the same measured reason. |
| **3** `violations` is always `null` at the write site | **UNMOVED, and now with a measured refutation of the cheap fix** (§8.3, last row). Still the precondition for four other items. |
| **4** three signature formulas share one address space | **UNMOVED.** The new CLI writes and reads ledger rows keyed by the production record's own `signature`, so its `ALREADY_RULED_OUT` brake demonstrably fires **within itself** — and a row written by `tools/repair/cycle.mjs`, which keys on `computeSignature`, will not be found by it. **Two ledgers that look like one.** |
| **5** the client half of the enqueue path | **UNMOVED.** Still curl-only. |
| **6** `createSupervisorSubmit` has never run against a real store | **CLOSED** (§7.2-D stop 4). |
| **7** no backoff, no per-ticket wall clock | **HALF CLOSED, for repairing tickets only.** `SUPERVISOR_REPAIR_DEADLINE_MS` is the first wall-clock bound in this file; the submission path still has none. |
| **8** the orphan run | **UNMOVED, still reasoned rather than measured.** |
| **9** `abort-now` answers 501 | **UNMOVED.** |
| **10** Tier 3 does not enforce two available codes | **UNMOVED.** |
| **11** `noOpAblation` is a string nothing executes | **UNMOVED.** |
| **12** zero container known-bad arms | **UNMOVED.** |
| **13** `calibration-4a.mjs` journaling | **UNMOVED.** |
| **14** `humanReviewed` is `null` on every record | **UNMOVED — owner-only.** |
| **15** N6, N8, N9, N11, R4, B2, B4 | **UNMOVED.** |
| **16** the Tier 3 trail location departs from DESIGN §6.7 | **UNMOVED — still unratified.** |
| **17** housekeeping | **GREW, and every new artefact is gitignored:** private outDirs `dashboard/server/dist-still-parks/`, `dist-strip-crash/`, `dist-gate/` (the last deleted), `dashboard/screenshots/strip-1440-*.png`, and everything under the round's scratchpad. `dashboard/.next-gate` / `.next-final` and `test-results` were deleted. **The owner's `dashboard/data/runs.db` sha256 is unchanged (`ae47de75…`) and `dashboard/runs` still holds exactly 5 runs** — every server boot in this round ran against an APFS clone. **AND ONE THING NEITHER `git status --short` NOR `git diff --stat` SHOWS, so it is recorded here before the commit rather than discovered after it: there is ONE stash entry, and it PREDATES this round by a week** — `git stash list --date=iso --format='%gd %ci %s'` → `2026-08-03 08:31:43 +0200  On main: half-finished design-directions work from the stopped workflow wf_4b991b7c (recoverable, not expected to be needed)`. **No round since has stashed anything**; the check is written out because "the tree is untouched" is not a claim `git status` alone can support. |

**FIVE NEW OPEN ITEMS, ranked by what they cost tonight.**

1. **NO REPAIR DRIVER IS WIRED — ~4 lines in `index.ts`.** Pass `repair: createRepairDriver({…})`
   and `defectSignatureOf: createDefectSignatureReader(runsDir)` into the `new SupervisorLoop({…})`
   at `:86`. Absence measured: **0 grep hits**. Until then the boot arm check says so out loud, and
   the behaviour is bounded rather than broken.
2. **THE MORNING READOUT CANNOT DISTINGUISH A FINISHED QUEUE FROM AN ALL-BLOCKED ONE**, and
   `GET /api/supervisor/tickets` is a measured **404** (§7.2-D stop 17). **Instance twenty-four.**
3. **THE CLASSIFIER STILL AGES READINGS AGAINST THIS CLIENT'S CLOCK**, not against the wire's `at`
   — which is now on the wire, declared, validated and rendered. Deferred deliberately in a repair
   pass, with the reason written into the type: ageing against `at` catches a stale-computation
   server and makes two machines' clock skew a new false alarm.
4. **`dashboard/tests/fixtures/` STILL SERVES NO `/api/supervisor`.** On 31 of 33 spec files the
   strip only ever reaches `unreachable`, so the live wire shape is exercised only through the
   golden via `page.route`. **This is where a future mirror drift would be caught even without the
   golden**, and it was deliberately not bet on this round: a shared fixture route flips the strip's
   prose on every route and puts the green browser suite in front of `prose-guard`'s 40-word budget,
   `panel-copy`, `pages-prose` and `readout-copy`. **The next structural improvement.**
5. **NO SANDBOX, so `tools/repair/prover.mjs` IS UNREACHABLE FROM THE SUPERVISOR.** Nothing makes an
   isolated copy of the repo; a `git worktree`-based sandbox factory is the missing piece and is
   named in the CLI's docblock. This is why a hand-authored diff returns `NO_SANDBOX` rather than
   being graded.

**AND ONE COSMETIC ITEM, left alone deliberately rather than fixed with an untested edit in a repair
pass:** on a database that has never been started the server sends `changedAt: ""`, and
`formatClock("")` returns `""`, so the detail pane reads *"stopped since  (boot) — the supervisor has
never been started on this database"* — a blank gap where a time goes, with the truth in the sentence
beside it. Non-crashing, fresh-DB only.

#### 6.15 EVERY HANDOFF FILED BY THIS ROUND, WITH ITS OWNER

**Consolidated from the two lanes' fourteen handoffs and the repair pass's eight carried-forward
items, deduplicated against §6.14 so nothing appears twice. Each row names the file that has to
change and the measurement behind it.** **Four of the fourteen are NOT here because they are
CLOSED** — the lanes' four "wire detail" handoffs (`lastRepair` nullable, the ticket's missing
`currentRunId`, `attempts` being on the wire after all, and the server's `at` stamp) were all
answered by the mirror rewrite; they are recorded as closed in §8.2, and the one residual — that
nothing AGES against `at` — is §6.14 item 3.

| filed by → owner | handoff |
|---|---|
| `still-parks` → `index.ts` | the ~4-line repair-driver wiring. §6.14 item 1. |
| `still-parks` → `bakeoff/src/spec-validate.ts:1331-1336` **(digest-moving; forbidden this round)** | `blocking("other", null, …)` drops `problem.field`. Needs a `field` slot on `AuditFinding` (`contracts.ts:308`) **plus** this call site — **and that is only half:** the manifest DOCUMENT is not on disk at defect time (`spec-agent.ts`'s `lastManifest` is in-memory; `grep -n 'writeFileSync\|mkdirSync' bakeoff/src/spec-agent.ts` → **0 hits**) and the thrown `BakeoffError` carries no attempts, so the paths must travel on the error or on the authoring trail as well. `tools/repair/manifest-paths.mjs#attemptsFromManifests` is the derivation to call once they do; it is landed and arm-checked. |
| `still-parks` → the defect writer | **three signature formulas must converge on the reader's index-collapsing one** before the cycle and the supervisor can share a ledger. §6.14 item 4. |
| `still-parks` → whoever owns the sandbox | a `git worktree` sandbox factory. §6.14 item 5. |
| `strip-crash` → `dashboard/src/lib/api.ts` | a 200 whose body is literal `null` or is not JSON **cannot be told apart from an empty body**, because `request()` swallows the `JSON.parse` failure and returns null. Both render *"this page has never had a reading from it"* — legible and non-throwing (asserted), imprecise about what happened. The fix is a fetcher that keeps the raw body; **not taken, because it changes the error path of every other panel for one sentence.** |
| `strip-crash` → `dashboard/tests/supervisor-strip.browser.spec.ts:526` | the pre-existing run-detail test still uses `getByRole("link", { name: "Runs" })`, **proved to resolve TWO elements** once the home page's *"all runs"* link loads — a strict-mode failure that reads exactly like the blank page under test. **It is passing today on timing alone.** New tests use `{ exact: true }`. |
| `strip-crash` → whoever owns lint | `npx eslint src tests` reports **11-13 errors** in `src/app/runs/[runId]/page.tsx`, `src/components/canvas/orchestration-canvas.tsx` and `src/components/ui.tsx` (`react-hooks/purity`, `react-hooks/refs`, `no-img-element`). Out of lane, untouched; the round's own six files lint clean. |
| repair pass → the owner, **before committing** | **`dashboard/server/src/models.ts` is now modified (+54)** — `ModelCatalog.enumerated()` and a named `CATALOG_FALLBACK_MODEL_ID`, forced by the live-CLI finding. **The diff is 19 files, not the 18 the round started with**, and two more tracked files got **docstring-only** corrections whose claims had gone false (`src/lib/api.ts` on the command response shape; `src/lib/hooks.ts` on whether the wire carries a server stamp). **Review those four deliberately.** |
| repair pass → the owner, **before committing** | **run `git diff dashboard/tsconfig.json`.** §7.2-D stop 19. |
| repair pass → whoever regenerates the golden | the exact command, and the ordering that gives the pin its value. §7.3's falsified bullet. |
| repair pass → Tier 2 | the route still has **no producer** for `attempts`, `lastDefect` or `lastRepair`; `probe.unsourced` names all three on every poll and **the client now reads that list**. Arm 7 is armed, rendered and browser-tested and still cannot fire on live data. |

#### 6.16 WHAT THIS ROUND REFUSED, AND THE MEASUREMENT BEHIND EACH REFUSAL

**Four refusals. In each case the fix as literally briefed would have made something worse, and the
measurement is what shows it.**

1. **"Fix the crash at `supervisor-strip.tsx:205`."** Refused as **already fixed** — and the round
   did not stop there. The line is historical; the browser suite was **267 green before any edit**.
   What was left of the class — the arm ordering, the residual unguarded fields, the SSR-reachable
   arm — was found, fixed and mutation-proved instead (§8.1). **A round that had trusted its brief
   would have "fixed" a fixed line and shipped three live crash paths.**
2. **"Populate `violations` by consuming what `bakeoff/src` already emits."** Refused **on the
   measured chain**: the only structured field path is dropped at `spec-validate.ts:1331-1336`, and
   the surviving copy lives in prose that `signature.mjs:81` explicitly bans regexing. Also refused:
   wrapping the spec seat caller to recover the manifest — `attemptPaths` returns null for any
   attempt without structure, null means BLIND, and BLIND escalates, so a
   `[structured, BLIND, structured]` sequence would **escalate at attempt 2 on every ticket with one
   bad attempt.** That is the false stop DESIGN §7.6.2 names — **instance twenty-three while fixing
   twenty-two.**
3. **"The exhaustive validator is too strict; loosen it."** Refused for `absent`, and the half that
   was true is now **asserted** rather than argued (§8.2, last paragraph). The steady state is no
   longer amber because the mirror matches the wire — **not because the validator was relaxed.**
4. **"`next build` rewrites a tracked file — fix it."** Refused as **not this repo's code**. Recorded
   as an owner-facing trap with the one-line check instead (§7.2-A, §7.2-D stop 19).

---

## 7. THE NEVER-STOP ROUND — BUILT AND MEASURED 2026-08-10

Five parallel lanes against `docs/DESIGN-self-maintaining-pipeline.md`, then a verifier, a
reviewer and a repair pass. **The verifier's numbers are measured; a lane's own figure is
labelled as the lane's claim; anything the recorder re-measured says so.**

**THE GATE DID NOT PASS.** `gatePassed: false`, and the reason was a real product defect the
repair pass then fixed — see §7.3.

### 7.1 WHAT WAS BUILT, PER TIER, WITH THE TEST AND THE ARM CHECK THAT COVERS EACH

#### TIER 0 — the free instrument nobody asked for, and the best value in the round

**`tools/replay/` — stored artefacts × candidate checker, ~150 ms, zero model calls.**
`checker.mjs` imports the LIVE built validator at runtime (never vendored — *"a vendored
checker becomes a fossil that tests history"*) and runs a manifest through BOTH
`parseSuiteManifest` (the fail-fast sentence the container actually saw) and
`collectManifestProblems` (the whole survey). **The gap between them is the measurement that
explains the death.**

- **THE FIXTURES ARE NOW IN THE REPO.** `a913c871`'s three real manifests and prompts existed
  only in a reapable CLI session directory. `extract-fixtures.mjs` walks the three transcripts
  (`cfdffda9`, `60fcb909`, `e327a0fb`), and `--check` re-extracts into memory and diffs against
  disk. **Re-measured by the recorder:** `node tools/replay/extract-fixtures.mjs --check` →
  `all 9 fixture file(s) match the CLI transcripts byte for byte`, exit 0;
  `git check-ignore -v` over all nine → exit 1, no output; `git add -An tools/` → 42 files.
  The owner's real CV PDF is NOT copied — only `{mediaType, base64Chars, sha256OfBase64}`.
  **THE EXTRACTION IS SELF-CONFIRMING:** the three shapes it produced are the ones the
  post-mortem's own table records — attempt1 `{entity, source, expectation}`, attempt2
  `{id, description, entity, minRowCount, readBack}`, attempt3
  `{kind, method, path, expectStatus, description}` — the `id → kind → id` oscillation,
  recovered by a different reader on a different day.
- **ARM CHECKS — four, printed before any case runs, each printing its measurement:** corpus
  size (`0` is a hard failure); `checker is not blind` (known-good → ACCEPTED, known-bad with
  `minRows` dropped → REJECTED **naming the field**); fixture integrity (3 sha256s recorded at
  extraction time); fixtures are distinct (three copies of one manifest reads as BLIND). Any
  blind arm forces exit 1 with `REFUSING TO REPORT A PASS: an arm check is blind, so this run
  measured nothing.`
- **THE CORPUS HAS TWO MUST-ACCEPT CASES, and that is why it is not instance twenty-two.** One
  reads `MANIFEST_DATA_EXPECTATION_EXAMPLES` out of the BUILT spec-agent and parses it with the
  real validator — **N1's root cause turned into a standing check**, so a prompt documenting a
  shape the validator rejects is red the same second. Deleting both must-accept cases produced
  `✖ … the corpus MUST contain at least one must-accept case or it passes on a
  reject-everything checker`.
- **VERIFIER-MEASURED, RUN FOR REAL:** `node tools/replay/replay.mjs --rounds` → exit 0,
  `5 case(s); 0 failing/unarmed; 0 blind arm(s). PASS`. All three historical rejections
  reproduce against the current validator naming the same fields; rounds-to-accept
  collect-all **2/2/1, reproducing the post-mortem exactly**. The must-accept prompt case still
  accepts **across a spec-agent rebuild** (`dist/spec-agent.js` moved from `9a2d0986…` to
  `93c5b1e0…` under the concurrent round).
- **`seat-replay.mjs` is PARTIAL and deliberately spends nothing.** `--spend` refuses with
  exit 2, naming what is missing (the CV attachment, and a dispatcher living in another lane's
  packages). It prints the price it would pay, measured not estimated: **~181,862 output tokens
  and ~23m43s** for attempt 3, against the 1h26m54s / ~628,441 tokens the real run cost to
  reach phase two of ten. Its own arm check is the thing that killed the run:
  `mentions "minRows": YES` — or, on a regression, `NO — this is the a913c871 root cause`.

#### TIER 1 — never park, and record what happened

- **NEVER PARK, enforced at the submission boundary, not watched for.**
  `assertNeverParks(spec)` throws on `designLock !== "auto"` or `interactive !== false`, and
  both parks are made **unreachable** rather than defaulted (`planPolicy(false)` → `"skip"`, so
  there is no plan-seat question to park on; `designLockPolicy("auto", …)` → `"auto"` before
  `interactive` is consulted). **Two-armed test**, so a guard that refuses everything fails the
  same test as one that refuses nothing. Mutation: disabling the `designLock` guard →
  `✖ a submission that could park is refused at the boundary, not watched for …
  Missing expected exception.`
- **THE DEFECT RECORD** (`defect-record.ts` + `#writeDefectRecord` off `#finish`) → both
  `runs/<runId>/results/defect.json` and the append-only `data/defects/<signature>.jsonl`.
  3 integration tests driven by a run that **really dies in `spec`** — not a pre-frozen fixture,
  which is the trap `orchestrator.spec-spend.test.ts` documents. **Its own arm is the
  `unavailable[]` list:** a record that knows nothing says so in the file and in the run's log
  line, so a defect channel that has gone blind cannot present as a clean row of zeroes.
  Mutations: deleting the call (`✖ the terminal transition must write …/defect.json`), forcing
  `violationsAvailable:true` (`true !== false`), `appendFileSync → writeFileSync` (`1 !== 2`).
- **`results/authoring-trail.json` ON BOTH PATHS** — the fix for N5's harness half. Three
  sources tried in order and never a fourth: the thrown error probed **structurally** for an
  `attempts` array (never the message), the frozen `AUDIT.json`, then `attemptsAvailable:false`
  with an `UNAVAILABLE:` sentence. **The RED was `a913c871`'s exact state:**
  `AssertionError: the spec phase must leave a trail even when it dies: …/results/authoring-trail.json`.

#### TIER 1.5 — the supervisor, and it is now actually running

- **`supervisor.ts` — three tables, typed accessors, and a tick loop that takes every decision
  from the tables on the tick that makes it.** 22 tests. **VERIFIER-MEASURED IN ISOLATION over
  a FILE-BACKED sqlite db:** a fresh db answers
  `{"desired":"stopped","changedBy":"boot","reason":"the supervisor has never been started on
  this database"}` — an unwired supervisor is an answer, not an error; a submission that throws
  logs *"submission of t-verify-1 threw and the ticket went back to the queue"* and
  **CONTINUES**; and **a real `kill -9` from inside `submit` after the claim**, followed by a NEW
  loop over the SAME db file, read `stuck-orphan-claim` BEFORE any tick — *"ticket t-verify-1 is
  claimed but names no run — the submission was lost between the claim and the run row"* — then
  requeued and submitted **exactly once**.
- **ARM CHECK:** `SupervisorLoop.armCheck()` feeds `classifySupervisorHealth` three snapshots
  whose answers are known in the source and requires three **distinct, correctly-matched**
  verdicts, because `return "idle"` gets one of three right:
  `ARM CHECK: supervisor discriminator returns 3 distinct verdict(s) on 3 known inputs; 0
  misread` / `sees N ticket(s) — queued A, in flight B, waiting C; desired='…'` /
  `armed — idle and stuck are distinguishable`. **It is now CALLED at boot** (`index.ts:146`
  — **re-measured 2026-08-10, repair-driver round; the published `:159` is stale**),
  which it was not when the lane filed it.
- **THE ATTEMPT CAP MOVED TO THE CLAIM STEP** (`:455`) and a failed submission now counts as an
  attempt (`:518`). Before that, a deterministically throwing `submit` re-claimed every 30 s
  **for ever** while reporting progress. Two tests, each with a negative half.
- **`GET /api/supervisor`** reads the **same** `deps.store` the loop decides from, so a panel
  that says "idle" and a loop that is stuck cannot disagree. `composeSupervisorState()` is pure
  so the boot arm check can drive it with known answers. **ARM ONE** requires three different
  bodies with the `probe` block STRIPPED (probe counters differ even when everything the owner
  reads has collapsed); **ARM TWO** prints measured live values and `loop=wired` vs
  `loop=NOT WIRED — nothing will claim a ticket and START will refuse`. Blindness travels on the
  wire as `probe.armed:false`. The sharpest mutation in the round: deleting the `rate_limit`
  skip from the quiet clock →
  `AssertionError: this run has produced nothing but telemetry since it started 90 minutes ago,
  so the clock must read ~5,400,000 ms, not ~0 (read 3)`.
- **START / STOP / ABORT-NOW.** STOP writes `draining` and **cancels nothing**; the four measured
  reasons are at the route (`cancel()` → a terminal status → `resume()` refuses → the classifier
  answers `intentional` → `boundFor('intentional')` is 0, so abort-now converts a resumable run
  into an unresumable one and throws the workspace away). START nudges one tick; **a GET never
  ticks** — mutation `AssertionError: two polls, no extra ticks 3 !== 1`. All three POSTs carry
  the cross-origin refusal with an absent `Origin` allowed. Mutation on STOP: making it also
  cancel produced `AssertionError: STOP must not cancel anything + [ 'run-1' ] - []` **while the
  desired-state assertion still PASSED** — that is the arm that tells drain from abort.
- **`POST /api/supervisor/tickets`** — added by the repair pass, and without it the whole thing
  is inert: `enqueueSupervisorTicket` previously had callers only in two test files. Branched
  **before** the command dispatch, deliberately: a command that cannot be carried out answers
  503, but a FILING is a durable row claimed by the next boot's first tick. The key is minted
  server-side from the brief digest, which makes the duplicate case decidable (409, and a retried
  POST is idempotent). Validation reuses `briefHasContent`, **not** `.trim()` — a brief of
  zero-width characters trims non-empty and renders empty on the queue that spends money.
  **`modelId` is NOT validated against the live catalog, deliberately:** the catalog is a live
  probe of two CLIs, and a ticket filed at 2am against a lapsed provider should still be filed.
  **Its test is the end-to-end arm nothing else in the round has:** file a ticket over the wire,
  then `await loop.tick()` with a recording submit, and assert the submit was called. Mutation
  (route answers but files nothing) → `0 !== 1`.
- **THE BOOT SEQUENCE** (`supervisor-boot.ts`): `armCheck()` runs FIRST; a BLIND loop gets **no
  interval, no boot tick, and `desired` forced to `stopped` with the reason on the row**, so the
  refusal is readable on the wire and not only in stdout. Tick rejections — sync and async — are
  absorbed and named, because an unhandled rejection from a 30 s interval kills the process.
  Mutation A (delete the boot call) → `AssertionError: startSupervisor is never called, so there
  is no interval and no arm gate`; mutation B (neuter the arm gate) → `AssertionError: … the
  interval was installed for a blind discriminator`.

#### TIER 2 — the repair machinery, and the bar it must clear

- **`tools/repair/` — 72 tests across 7 files, `node tools/repair/arm.mjs` → 7/7 arms live** (both
  re-measured by the recorder, exit 0).
  The signature is structural (index-collapsed, sorted, prose never an input, and `attemptPaths()`
  returns `null` rather than regexing a field name out of prose). The evidence bar has **15 named
  refusal codes** and the tests assert the **exact code set with `deepEqual`**, so one over-broad
  predicate cannot mask five others. The prover runs everything through `spawnSync`; a transcript
  is the process's own bytes framed by the command line and `# exit code: N`, and the mutant is
  `git apply -R` of the patch so **the agent cannot choose its own exam**. The ruled-out ledger
  writes a row on EVERY verdict, because *a refusal with no row is indistinguishable from a
  refusal that never ran*.
- **THE ARM CHECK IS ITSELF FALSIFIABLE — 8 injected blindings**, each a component blinded the
  way it would really go blind: a signature that never moves, a comparator that never escalates,
  a comparator that ALWAYS escalates, a bar that accepts everything, a bar that refuses
  everything, a prover that reports success without executing, an isolation guard that accepts
  the repo, a ledger that writes nothing. **And it caught a real defect before any test did:**
  `ARM CHECK FAILED: cycle-end-to-end — a provable repair was not accepted end to end:
  [{"code":"NO_INDEPENDENT_CHECK"…}]`, exit 1 — the prover leaves the patch applied, so
  `independentReplay`'s own apply failed and reported `ran:false`.
- **THE STRONGEST SINGLE AUDIT RESULT IN THE ROUND.** The verifier re-applied the ledger no-op
  mutation and the **start-up arm check caught it loudly and by name**, which is what hard rule 4
  exists for: `ARM CHECK FAILED: ledger-writes — a refusal wrote no row: a refusal nobody can
  read is a refusal that never ran` / `ARM CHECK FAILED: cycle-end-to-end — the could-not-reproduce
  outcome left no row` / `ARM CHECK: REPAIR AGENT IS BLIND — ledger-writes, cycle-end-to-end`.
- **RUN ON `a913c871`'s REAL DEFECT DATA:** `VERDICT: ACCEPTED`, `prove outcome: PROVEN`, all
  three transcripts present **with exit-code trailers** (`redBefore` 73 chars, `greenAfter` 76,
  `mutationRed` 73), `filesChanged: ['src/prompt.mjs']`, `touchesFrozenClosure: false`. **The
  patch was NOT applied** — everything ran in a scratch sandbox, and the prover refuses the
  working tree (arm-checked both ways).

#### TIER 3 — the gate

- **THE FROZEN CLOSURE IS COMPUTED, NOT HAND-LISTED.** A transitive local-import walk of the four
  verdict-producing entry points → 11 files, exactly the design's list, plus the 7 FROZEN-CONTROLS
  files derived the same way. `CLOSURE_FLOOR` is a **membership** floor, not a count: a missing
  member fails (that is the softening direction), an added member is logged and does not fail
  (monotone ratchet, `RESEARCH` R13). Mutation (stop enqueueing transitive imports) →
  `AssertionError: the derived closure lost config.ts, contracts.ts, hash.ts, redact.ts,
  scorer-protocol.ts, spec-freeze.ts, spec-types.ts. Losing spec-freeze.ts makes "which half is
  held out" editable without touching a scorer file.`
- **FROZEN IS ENFORCED, TAMPER-EVIDENT, AND SAYS SO:** a sha256 manifest of **223 frozen paths**
  written OUTSIDE the tree, an isolated copy the gate runs from, split verification (isolated code
  vs in-place data, each mismatch labelled), per-module dist freshness driving arms to UNARMED
  rather than to a silent pass. **ABSENT is a mismatch, never a skip** — mutation:
  `AssertionError: a deleted frozen file was read as intact.`
- **FIVE ARM CHECKS, all five exercised while the answer is known** (A1 plants exactly one byte and
  requires exactly one mismatch on exactly that path, then restores and requires silence; A4 fails
  if the three routes are not all DISTINCT). `runArmChecks` asserts `armed === 5` **as well as**
  `blind === 0`, because `blind.length === 0` is green on an empty arm list. Blinding the trail
  reddened 5 tests **including A5** — that coupling is what makes "re-run until green" detectable.
- **VERIFIER-MEASURED, THREE PROPOSALS, THREE VERDICTS:** a real grader softening → SELF-PROPOSE,
  `applyToken: null`; a diff against the impossible-ticket anchor → REFUSED (*"the admission
  predicate is the objective function and is not self-editable at any tier"*); an editable-only
  diff with full evidence → **APPLY**, token minted. **So it is not wired shut** — and read §7.3
  for what that APPLY actually proved.

### 7.2 THE OPERATOR'S PAGE — READ THIS BEFORE YOU LEAVE IT FOR EIGHT HOURS

> **REWRITTEN 2026-08-10 (strip-crash round) FROM THE FINAL GO/NO-GO, not from a lane's claim.**
> Every state, sentence, refusal and terminal transition below was driven against a real server
> booted on an **APFS clone of the owner's home** (`dashboard/data/runs.db` sha256 still
> `ae47de75…`, `dashboard/runs` still 5 runs) and read in a real browser at 1440×900, with the
> screenshots opened and looked at. **What changed since the version this replaces:** there are
> now **five** named strip states, not four (`malformed` is its own word); there is an error
> boundary under the strip; the ticket route refuses a bad model id at filing instead of at
> submit; `repairing` is **no longer a park** — the old stop 1 text is stale and is corrected in
> place below; and there is a new subsection **C2** that says what the night actually looks like,
> which is the most useful thing this round measured and was absent from the page entirely.

#### A. HOW YOU START IT

Everything in §4's RUN RECIPE still applies — **three builds first**, and verify them by
CONTENT, not mtime. **Then run one command the recipe does not have**, because `next build`
silently appends `.next/types/**/*.ts` and `.next/dev/types/**/*.ts` to the tracked
`dashboard/tsconfig.json`'s `include` and prints only *"include was updated to add…"*:

```
git diff dashboard/tsconfig.json     # must be EMPTY before you commit anything
```

Measured twice this round (once under `next build`, once under `next dev`), restored from
`git show HEAD:dashboard/tsconfig.json` both times. With `.next` unset the added globs look
plausible enough to survive review. Then:

```
# 1. the API. Binds 127.0.0.1:4176 (DEFAULT_PORT, dashboard-url.ts:33). Leave it running.
cd dashboard/server && npm run start

# 2. the page. 127.0.0.1:4319 (dashboard/package.json:8). /api/* is rewritten to 4176
#    unconditionally, so nothing needs configuring.
cd dashboard && npm run start
```

**WATCH THE SERVER'S FIRST FIVE LINES. This is the arm check, and it is the only moment you
can tell a working supervisor from a blind one:**

```
ARM CHECK: supervisor discriminator returns 3 distinct verdict(s) on 3 known inputs; 0 misread
ARM CHECK: supervisor sees N ticket(s) — queued A, in flight B, waiting C; desired='…'
ARM CHECK: armed — idle and stuck are distinguishable. …
ARM CHECK: repair router returns 7 distinct code(s) and 7 distinct sentence(s) on 7 known inputs; 0 misread
ARM CHECK: NO REPAIR DRIVER is wired. Every ticket that reaches 'repairing' terminates at
           'blocked' with NO_REPAIR_DRIVER and the loop carries on to the next ticket.
ARM CHECK: supervisor route reads desired='…' since …, N ticket(s), 0 queued, active=…, loop=wired
ARM CHECK: supervisor loop armed; ticking every 30s, desired reads '…'
```

**The two repair lines are new this round and the second one is not a failure** — the loop still
ticks with no driver wired, which was verified live rather than reasoned (`index.ts:86` passes
`store`, `submit` and `resume`, and `grep -an 'repair\|defectSignatureOf' index.ts` → **0 hits**).
**But a repair-router sentence collision now refuses the WHOLE boot**, not just the repair step,
because `armCheck().armed` includes it. That is the fail-safe direction and it is deliberate.

> ### CORRECTED 2026-08-10 (repair-driver round) — THE BLOCK ABOVE IS SUPERSEDED, AND SO IS ITS GREP
>
> **THE PUBLISHED GREP IS NOW FALSE AND THAT MATTERS MORE THAN THE BOOT LINE.** *"`grep -an
> 'repair\|defectSignatureOf' index.ts` → **0 hits**"* was true when it was written and is
> **re-measured today at ELEVEN hits** — `index.ts:40,42,43` (the imports), `:143` (`await
> armRepairDriver(...)`), `:144` (its lines printed), `:160` (the conditional `repair` dep),
> `:161` (`repairArm`), `:170` (`defectSignatureOf: createDefectSignatureReader(paths.runs)`). A
> reader who trusts a published grep result is exactly the harm this document exists to prevent,
> so the old result stays visible above and is corrected here rather than edited away. The same
> **0 hits** claim is repeated in stop 2 below and is corrected there too.
>
> **THE REPAIR LINE NOW HAS FOUR STATES, NOT TWO, and each one is a different fact:**
>
> ```
> ARM CHECK: repair router returns 7 distinct code(s) and 7 distinct sentence(s) on 7 known inputs; 0 misread
> ARM CHECK: a repair driver is wired AND MEASURED — it told 8 known cycle answers apart, 0 misread,
>            and only a gate-authorised patch with a rollback point reads as applied. CONFIGURED,
>            NOT OBSERVED: at most 2 cycle(s) per defect signature and a 30-minute bound on
>            'repairing' are constants read out of this build — nothing here has watched either one
>            fire. N ticket(s) are repairing now.
> ARM CHECK: (cycle) supervisor repair entry point returns 9 distinct code(s) and 9 distinct sentence(s)
>            on 9 known inputs, exactly 1 of them applied; 0 misread
> ARM CHECK: (cycle) gate-verdict router returns 8 distinct code(s) … exactly 1 of them APPLY; 0 misread
> ARM CHECK: (cycle) armed — an APPLY is only reachable with a token that verifies, and an applied
>            patch was reverted from its own record
> ```
>
> The other three states, all reachable and all mutation-proved to read differently:
>
> | what happened | the line you get |
> |---|---|
> | no driver was constructed at all | `ARM CHECK: NO REPAIR DRIVER is wired. …` — **the line the old block quotes, still reachable and still a distinct fact** |
> | a driver exists and its arm check found it blind | `ARM CHECK: BLIND — a repair driver EXISTS and was NOT wired, because it could not be shown to tell its own outcomes apart (<the reasons>). … This is the fail-safe direction and it is NOT the same as having no driver: fix the driver, do not read this as an idle machine.` |
> | the cycle script is not at `cyclePath` | its own `wrong[]` reason — *"nobody installed one, not we refused a blind one"* — because a missing file used to wear the refused-a-blind-driver sentence |
> | measured armed and then **not passed** to the loop | `ARM CHECK: BLIND BY WIRING — a repair driver was MEASURED ARMED … AND THEN NOT PASSED to the loop. Nothing is wrong with the driver … Look at the \`repair\` dep in index.ts, not at tools/repair.` |
>
> **THE WORD `MEASURED` NOW COVERS ONLY WHAT WAS DRIVEN.** The two bounds it used to recite in
> the same breath are relabelled **CONFIGURED, NOT OBSERVED**, because they are constants read out
> of the build and nothing at boot watches either one fire.
>
> **AND THE ONE SENTENCE A READER MUST NOT SKIP: THE RUNNING PROCESS TONIGHT IS NOT THIS BUILD.**
> All of the above is wired **in source and in a private sibling outDir** (`dist-repair`,
> `dist-gate`). The live server is `node dist/index.js`, `dist/` was deliberately **not** rebuilt
> while the run was live, and `grep -c armRepairDriver dashboard/server/dist/index.js` → **0**
> (measured, `dist/index.js` mtime Aug 10 15:10). **Tonight's supervisor still prints `NO REPAIR
> DRIVER is wired` and still has no `repair` dep.** The driver arms at the next rebuild, and that
> rebuild is one of the owner decisions in §9.4 — not a housekeeping step.

**If instead you see `ARM CHECK FAILED: the supervisor is BLIND and was NOT started`, stop.**
No interval was installed, no tick was taken, and `desired` was forced to `stopped` with the
reason written to the database — so `GET /api/supervisor` will tell you the same thing. **Do
not press start; the button will refuse.** `loop=NOT WIRED` in line 4 means the same class of
problem one layer up.

**THEN FILE A TICKET. This is the step with no button** (§6.6 item 5), so it is curl:

```
curl -sS -X POST http://127.0.0.1:4176/api/supervisor/tickets \
  -H 'content-type: application/json' \
  -d '{"ticketText":"<your brief, exactly as you would type it into the page>",
       "modelId":"<an id from GET /api/models>",
       "maxAttempts":3}'
```

`201` returns `{ticketKey, title, state, maxAttempts, nextAction, queuedTickets, desired}`.
**Every refusal was exercised against the live route this round, not read off the code:**

```
{"modelId":"no-such-model"}  → 400 invalid_model      "no-such-model is not in the catalog, so this
                                                       ticket could never be submitted" / "GET /api/models
                                                       lists every id that can actually run. Nothing was queued."
{"ticketText":"   "}         → 400 invalid_ticket
{"maxAttempts":99}           → 400 invalid_body
the same brief, twice        → 409 ticket_already_queued  "this exact brief is already filed as t-…"
{"modelId":"haiku"}          → 201
```

> ### EXTENDED 2026-08-10 (repair-driver round) — THE TICKET NOW CARRIES ATTACHMENTS, AND THERE IS A GET
>
> **FOUR NEW REQUEST FIELDS**, with the same caps, codes and refusal sentences `POST /api/runs`
> already uses (the validators are the same functions, not a second copy): `references`
> (base64 image data URLs, cap 6), `documents` (base64 data URLs, cap 4), `captureUrl`
> (`string | null`), `motionUrl` (`string | null`). Bytes land under
> `dashboard/runs/tickets/<ticketKey>/{references,documents}` with a `references.json` manifest.
> **The single line that decided whether the ticket could be filed at all** was the 1 MiB default
> body envelope: a 573 KB image + an 81 KB PDF answered `400 invalid_body / "request body too
> large (over 1048576 bytes)"`. It is now `MAX_ATTACHMENT_BODY_BYTES`, and the envelope refusal has
> its own code:
>
> ```
> over the attachment envelope   → 400 body_too_large        (NEW code on this route)
> the same brief AND same bytes  → 409 ticket_already_queued  "this exact brief with these exact
>                                                             attachments is already filed as t-…"
> the same brief, a DIFFERENT CV → 201 with a DIFFERENT key   (a 409 there would discard the
>                                                             corrected CV — decided, not incidental)
> ```
>
> **`GET /api/supervisor/tickets` EXISTS — it is the morning readout, and it replaces opening
> `runs.db` in a SQL client.** Every ticket with its state, model, `attempt N of M`, its own
> `next_action` sentence, `nextActionAt`, run id (current or last), `lastClass`, `lastDefectId`,
> `patchId`, timestamps, and an `attachments` block. Plus a response `probe` —
> `ticketsSeen / manifestsUnreadable / attachmentsDropped / armed / armNote / at` — so **an empty
> queue and a blind reader are different bodies.** `attachments.carriedIntoRun` is three-valued
> and compares sha256s, not counts: `null` = nothing to carry / no run yet / manifest unreadable;
> `false` = a run exists and its manifest does not name what the ticket filed — **which is what
> today's `createSupervisorSubmit` produces, because it still passes `images: []` and
> `documents: []`**; `true` = every filed digest is in the run. **Capture and motion need no
> submit-path change** (they are composed into `ticket_text` at filing time and the
> re-composition is pinned as a no-op); **images and documents do.**

**`400 invalid_model` is new this round and it used to be a lie.** §7.2 has promised it since it
was written; `http.ts` only checked for a non-empty string, so `no-such-model` was **queued with
a 201** and the typo cost one full attempt and a terminal `blocked` ticket two ticks later. The
check is now at filing time (`http.ts:1387`) and it is deliberately **three-armed, not two**: an
id that IS in the catalog is filed whatever `available` says (auth can come back before the loop
claims it); an absent id is refused when the catalog **enumerated**; an absent id is **filed**
when the catalog could not enumerate, because losing a brief to a failed probe is the worse
error. The naive one-armed version was falsified by the live CLI inside the hour — this machine's
`GET /api/models` answers `['default','opus[1m]','claude-fable-5[1m]','sonnet','haiku']`, so a
**healthy** catalog contains a model whose id is literally `default`.

The key is minted from the brief's digest, so **the same brief is the same ticket** and a retried
POST cannot file the work twice. `maxAttempts` is the ceiling on how many RUNS this one brief may
cost; absent means 3.

**WRITE THE BRIEF LIKE IT IS THE ONLY INPUT.** A supervisor submission SKIPS the plan phase by
construction — that is how the plan-seat park is made unreachable rather than defaulted — so the
acceptance criteria come from the raw ticket text alone. This is the same decision recorded for
B3 on 2026-08-09, now enforced in code.

```
curl -sS -X POST http://127.0.0.1:4176/api/supervisor/start     # then go to bed
```

`start` returns the whole state plus `changed` and `note`, is idempotent, and reports
`changed:false` with a sentence rather than flashing a change that did not happen. It writes
`desired='running'` and nudges exactly one tick so you do not wait out the 30 s interval.

#### B. WHAT YOU SEE

**A 30 px strip across the top of every route**, always mounted, polling `/api/supervisor` every
5 s. Left to right: a state pill, one sentence, the ticket and `attempt N of M`, the quiet clock,
the defect signature, the last repair, both queue depths, and `start` / `stop (drain)` / `detail`.

**FIVE STATES — five WORDS, five SENTENCES, and deliberately only FOUR COLOURS.** All of them
are machine-distinguishable via `data-liveness` / `data-stale` / `data-armed`, and all five were
photographed at 1440×900 and looked at:

| pill | colour | it means | the sentence you get |
|---|---|---|---|
| `running` | green | **what is LEFT when nothing else fires** — never asserted | `<phase> · attempt N of M` |
| `idle` | grey | nothing queued, nothing in flight | **two sentences, and the second one is the morning readout:** `stopped, nothing in flight` (never started, with *"boot set it to stopped: the supervisor has never been started on this database"*) · **`idle, queue empty`** — which is what you see after a successful night **AND** after a night of blocked tickets. That string is stop 17 and §8.6. |
| `stuck` | **red** | one of the arms fired — **the loop is wedged and you must act on the RUN** | `running, claiming nothing` · `looping, not converging` · `claimed, no run` · `no progress clock` · `silent too long` · `supervisor arm check failed` |
| `unreachable` | amber | the route did not answer, or the last answer is now history | `GET /api/supervisor did not answer: …` · `the reading below is Ns old and is history, not state` |
| **`malformed`** | amber | **the route answered 200 with a body this page cannot read** | *"…so nothing here is state — the supervisor itself may be fine. Check what is serving `/api/supervisor`: an old build, a proxy or a test fixture answers exactly like this."* then the failing fields, last |
| red banner across the strip | red | **the classifier itself is blind** — **not a pill and not a sixth state; it REPLACES the row** | `ARM CHECK FAILED, THE SUPERVISOR STRIP IS BLIND: …` |

**AMBER AND RED MEAN DIFFERENT THINGS, AND `malformed` IS AMBER ON PURPOSE.** Amber = *this page
cannot see*. Red = *the loop is wedged, act on the run*. A malformed body says nothing whatever
about the run, so painting it red would be yesterday's preview-card lie again — the word carries
the difference and the sentence carries the action. There is a test asserting the fifth colour is
**missing**, that `malformed`'s colour equals `unreachable`'s and differs from `stuck`'s, and that
all five words and all five sentences are distinct. **`malformed` renders NO data cells**, because
the reading carries no snapshot; `unreachable` keeps the last cells beside it, as history, by
design.

> ### SIX IN SOURCE, FIVE MEASURED — 2026-08-10 (repair-driver round)
>
> **A sixth liveness `blocked` (red, sharing `stuck`'s tone) landed in `dashboard/src/lib/supervisor.ts`
> this round, and with it the distinction stop 17 names:** a queue that FINISHED reads
> `idle · queue finished · N done`; a queue where every ticket died reads `blocked · queue ended ·
> N blocked`; a queue that was never given anything reads `idle · idle, no tickets filed`; and **no
> census at all** still reads `idle · idle, queue empty` with the reason appended, so today's build
> stops claiming more than it can see. The classifier half is mutation-proved (blinding the sixth
> probe takes the boot line to `ARM CHECK FAILED — THE SUPERVISOR STRIP IS BLIND: only 5 of 6
> states are distinguishable`). **THE RENDERING HALF IS SOURCE-ONLY.** No browser project could be
> run this round — `dashboard/playwright.config.ts` declares `webServer` at top level, so every
> project run boots a server on the live run's ports — so the table above, its colour claims and
> the extended *"all six states"* spec are **unverified by browser**, and
> `dashboard/src/components/supervisor-strip.tsx` has **zero executed tests**. Read the table as
> five measured states plus one that compiles. §9.3 is the checklist that closes this.

**THE ARM LINE NOW READS `5 distinct`, not 4** (`unreachable · idle · running · stuck ·
malformed`), and it is rendered in the detail pane **pass or fail** — *a report that only appears
when it failed is a report nobody has ever seen working*. **(In source it now reads `6 distinct`
and names what it can tell apart; browser-unverified — see the block above.)** `stuck` after silence fires at
**40 minutes**, and that threshold is **calibrated on one run** (`a913c871`'s largest real
inter-event gap was 25.2 min, and `DEFAULT_SILENCE_WARN_MIN = 90` never fired). The quiet clock
**skips `rate_limit` frames**, which is the whole reason `a913c871` looked alive.

**A SIXTH THING ON THE ROW, AND YOU WILL ONLY EVER SEE IT IF SOMETHING BREAKS: `PANEL FAILED`.**
The strip is now wrapped in `RenderGuard` (`dashboard/src/components/render-guard.tsx`) — the
**first error boundary this application has ever had**; `grep` confirms `src/` had zero before.
It wraps `<SupervisorStrip />` and **nothing else** on purpose: wrapping `{children}` would
swallow page-level throws that other specs provoke and that Next's dev overlay reports, and a
boundary that hides a bug is worse than a blank page. A throw inside the strip therefore costs
**30 px of header, not the application**, and the row prints the real error plus: *"Nothing on
this row is a reading. The rest of the page is unaffected; reload, and if it returns, the fault is
in this panel and not in the run."* **Its limit, stated rather than assumed:** client boundaries
do not catch server-render throws, so the strip's own start-up arm check — which runs in the
render body — is the one place a throw still blanks the page, and that is why each of its probes
now catches and reports `threw: <message>` as a FAILED probe instead of propagating.

**AND ONE HONEST BLANK IN AMBER, in the detail pane** — now driven by the wire's own
`probe.unsourced` rather than by a client constant, so it disappears by itself the day a producer
lands: *"the supervisor does not report the authoring trail yet…"*. There are **two** such
sentences, because they are two different facts: `unsourced` naming `attempts` → *"does not report
the authoring trail yet"*; sourced and empty → *"an empty list, not a missing one"*. Believe them.
§8.4.

#### C. WHAT STOP DOES

**`stop (drain)` MEANS DRAIN. It cancels nothing.**

- It writes `desired='draining'`. The run in flight **keeps running to its verdict**; when
  nothing is in flight the state becomes `stopped`.
- **It does not touch `pump()`**, so a run you submitted from the page yourself still starts.
  That is why the strip shows TWO queue numbers: `queueDepth` is the supervisor's backlog,
  `queuedRuns` is `runs.status='queued'`.
- **There is deliberately no "kill it now" button.** `POST /api/supervisor/abort-now` exists and
  answers **501**, because cancelling a run writes a terminal status, a terminal row refuses
  `resume()`, the classifier then answers `intentional`, and `boundFor('intentional')` is **0** —
  so abort-now converts a resumable run into an unresumable one and throws the workspace away.
  **To stop right now anyway:** `POST /api/runs/:id/cancel` and accept that cost. The ticket will
  be inconsistent until someone looks.

> **NOT EXERCISED, 2026-08-10 (strip-crash round).** Everything in C is still code plus unit
> tests. `start`, filing, claiming, submitting, a real run row, `kill -9` recovery and two
> terminal settles were all driven for real this round; **`stop (drain)` was not.** A cancel WAS
> observed end to end and behaved as this section says (`supervisor_log` seq 5 `settled / run
> …36f87c2b was cancelled`, ticket → `blocked` with *"nothing: a human cancelled this run"*), so
> the cancel half of the reasoning is measured; the drain half is not.

#### C2. WHAT TONIGHT ACTUALLY LOOKS LIKE — MEASURED ON A LIVE LOOP, NOT REASONED FROM THE DESIGN

**This subsection is new, and it is the answer to the question the rest of the page does not
answer: what will have happened by morning.** It was driven on a real loop against the clone.

1. **You file the ticket by curl** (still no button — stop 3) and it is **claimed on the next
   tick**, ≤ 30 s. Watched: `supervisor_log` seq 2 `claimed` → 3 `claimed` → 4 `submitted /
   attempt 1 of 1`, then a real run row in `phase=spec, status=running` driven by a real
   Agent-SDK child. **That is stop 4 exercised on this tree** — no `NewRun` column mismatch, no
   `bus.emit` drift.
2. **The spec phase is BOUNDED:** 3 authoring attempts, each abandoned on a 60-minute per-call
   wall clock (§6.11), so the run resolves one way or the other inside roughly **three hours**.
3. **If the spec phase fails again — the class that killed `a913c871`, and 3 of the 5 runs on this
   machine died in `spec` — NOTHING AUTOMATIC REPAIRS IT.** `boundFor("structural")` is **0**, so
   the failure is not retried and `maxAttempts` is never spent again. `settle()` writes `repairing`
   with a 30-minute deadline for exactly **one visible tick**, and the next tick terminates it.
   Measured by inserting a `repairing` ticket and pressing start: one tick later the row read
   `state=blocked`, `next_action="nothing automatic: no repair driver is wired into this
   supervisor, so no proposal for defect sig-spec-oscillation (class 'structural') can ever be
   produced. Run tools/repair/cycle.mjs by hand and re-enqueue the ticket."`

   > **CORRECTED 2026-08-10 (repair-driver round) — SAME OUTCOME, DIFFERENT SENTENCE, AND THE
   > SENTENCE IS THE POINT.** With the driver wired **in source**, the ticket still leaves
   > `repairing` in one tick and still lands `blocked` — deterministically, measured twice on a
   > `.backup` snapshot of the live database with the real defect writer producing the record — but
   > the reason is no longer *"no repair driver is wired"*. It is now
   > `REPAIR_INCONCLUSIVE / NO_PATCH_AUTHOR`: *"nothing automatic: the repair cycle for defect
   > 02d2e44b… reached NO verdict (NO_PATCH_AUTHOR) — no candidate diff exists at
   > `<proposals>/02d2e44b….diff`, and nothing in this build authors one — design §5.3 records that
   > the patch author is deliberately not built… Write a diff to that path (or run
   > tools/repair/cycle.mjs against an isolated copy by hand) and re-enqueue the ticket."` **And
   > `last_defect_id` is now populated with the real 64-hex signature — the column had no writer
   > that reached it before this round, so it was permanently null.** Two side measurements kept
   > because they are separately named: a hand-written `repairing` row with no `nextActionAt`
   > terminates at `REPAIR_DEADLINE_EXCEEDED` (the documented fail-safe — a repairing ticket with no
   > deadline is EXPIRED, not IMMORTAL), and a defect record with no `signature` field answers
   > `NO_DEFECT_SIGNATURE`. **In no configuration did a ticket stay in `repairing`.** Tonight's
   > live process still answers `NO_REPAIR_DRIVER`, because `dist/` was not rebuilt.
4. **THEREFORE THE REALISTIC NIGHT IS ONE ATTEMPT, NOT EIGHT HOURS OF ITERATION.** Within ~1-3
   hours the ticket is either `done` (the gate scores it; run 1 proves that path reproduces) or
   `blocked` with a named sentence — and then the loop ticks every 30 s over an empty queue until
   morning. **Rate limits are the exception that does keep working:** `throttled`, `interrupted`
   and `transient` have non-zero bounds and prefer `resume()` over a fresh spec phase.
5. **AND THE MORNING READOUT IS THE WEAK POINT.** With everything terminated the strip reads
   `IDLE / idle, queue empty` — **byte-identical to the readout for a queue that finished
   successfully** — and `GET /api/supervisor/tickets` is a **measured 404** (only `POST` exists),
   so the blocked ticket's sentence lives **only** in `supervisor_tickets.next_action`,
   `supervisor_log` and the server's stdout. **What to do at breakfast:** look at `/runs` for the
   run's own verdict (that page does show `failed`/`passed`), then read the ticket sentence out of
   the database:
   ```
   sqlite3 dashboard/data/runs.db \
     "select ticket_key, state, attempt_no, max_attempts, next_action from supervisor_tickets;"
   sqlite3 dashboard/data/runs.db \
     "select seq, at, ticket_key, run_id, decision, reason from supervisor_log order by seq;"
   ```
   (There is **no `supervisor_decisions` table** — the audit trail is `supervisor_log`.)

   > **CORRECTED 2026-08-10 (repair-driver round) — THE 404 IS CLOSED; THE READOUT IS A ROUTE NOW.**
   > `GET /api/supervisor/tickets` exists and answers every ticket, its state, its `attempt N of M`,
   > its own `next_action` sentence and its attachment block, plus a `probe` that reports how much
   > it looked at — so the two SQL queries above are the fallback, not the procedure. And the strip
   > has a sixth liveness that tells a FINISHED queue from an ALL-BLOCKED one. **Both halves carry
   > the same qualification and it is not a small one:** the route is measured (its own suite, and
   > the empty-store case asserted separately so *"no tickets"* and *"the reader is blind"* are
   > different bodies), the strip's classifier is measured, and **the strip's RENDERING is
   > unverified — no browser project could run beside the live run.** §9.3.

**Nothing spins, nothing double-spends, no owner byte is at risk, and nothing restarts the node
process if it dies.**

#### D. THE COMPLETE LIST OF WAYS IT CAN STILL STOP AND NEED YOU

**Reconciled against the tree as it stands, 2026-08-10, after the repair pass. Four of the
reviewer's thirteen stops were closed and are recorded as closed rather than quietly dropped;
three new ones the repair pass created or left are added.**

> **RE-RECONCILED 2026-08-10 (strip-crash round), and the corrections are in the rows themselves.**
> **Stop 1 is no longer a park** — the single most important change on this page. **Stop 4 is now
> exercised.** **Stop 5's own example (a bad model id) is refused before it costs anything.**
> **Stop 15 is half-changed** — the detector is armed, rendered and browser-tested, and still
> cannot fire on live data. **Three stops are added (17-19), and two of them are about the morning
> rather than the night.** Stale line citations from the previous round are corrected here as
> well: `supervisor.ts:455`/`:518` are **actually 926 / 989**, and `supervisor-strip.tsx:205` is
> **historical** — the guarded read is now ~226 and the shape gate sits above every arm.

| # | it stops when | why, with the evidence |
|---|---|---|
| **1** | ~~**A STRUCTURAL FAILURE HAPPENS** … the ticket settles to `repairing` … **and nothing ever moves it out.**~~ **CORRECTED 2026-08-10 (strip-crash round): `repairing` IS NO LONGER A PARK, AND IT IS STILL A STOP.** A repair step now runs inside `tick()` and routes every repairing ticket to **one of six named outcomes, five of them terminal** — `REPAIR_DEADLINE_EXCEEDED`, `NO_REPAIR_DRIVER`, `REPAIR_CYCLES_EXHAUSTED`, `REPAIR_APPLIED`, `REPAIR_REFUSED`, `REPAIR_INCONCLUSIVE`, plus the one non-terminal `REPAIR_DEFERRED`. With no driver wired — today's state — the ticket reaches `blocked` **on the next tick** with a sentence naming the signature and the class, and the loop moves on. **It still needs you in the morning; it no longer reads like progress and no longer waits for ever.** **RE-CORRECTED 2026-08-10 (repair-driver round): `NO_REPAIR_DRIVER` IS NO LONGER THE ANSWER IN SOURCE — `NO_PATCH_AUTHOR` IS, AND IT IS STILL A STOP.** A driver is wired in source; the ticket still leaves `repairing` in one tick and still lands `blocked`, now with the cycle's own reason (`REPAIR_INCONCLUSIVE / NO_PATCH_AUTHOR`, naming the exact path a diff must be written to) and with `last_defect_id` populated. **Tonight's running process is not this build** — `dist/` was not rebuilt, so live it is still `NO_REPAIR_DRIVER`. The stop moves from *"nobody wired a driver"* to *"nothing authors a patch"*; it does not close. | Measured live, not reasoned: a `repairing` ticket inserted, start pressed, one tick later `state=blocked`. The router is `routeRepairOutcome()`; deadline is checked FIRST so no queue can starve a ticket into permanence; `SUPERVISOR_REPAIR_DEADLINE_MS` = 30 min, `SUPERVISOR_REPAIR_MAX_PER_SIGNATURE` = 2 counted in a NEW `supervisor_tickets.repair_counts` column (never `attempt_no` — DESIGN §7.6 forbids mixing counters). **The old sentence *"waiting for a repair proposal for this failure class"* is gone from the product; wherever this document still quotes it, that quotation is history.** |
| **2** | ~~**A REPAIR IS NEEDED AT ALL — still true, and now for a smaller reason.** … **`index.ts` does not give it one.** ~4 lines.~~ **CLOSED AS A WIRING GAP 2026-08-10 (repair-driver round), AND THE STOP SURVIVES ONE LAYER DOWN.** `index.ts` now awaits `armRepairDriver` **before** constructing the loop and passes `repair` **only if the arm armed** (a spread, not a ternary, so a blind driver is not wired at all), plus `defectSignatureOf`. **The prediction in the old evidence cell was right and is now the live answer: the cycle answers `NO_PATCH_AUTHOR`.** Nothing authors a patch, and `tools/repair/cycle.mjs` — the prover-backed cycle that would need an isolated copy — is still invoked by nothing. | **THE PUBLISHED GREP IS SUPERSEDED:** `grep -an 'repair\|defectSignatureOf\|createRepairDriver' dashboard/server/src/index.ts` → **0 hits** was true when written and re-measures today at **11 hits** (`:40,42,43,143,144,160,161,170`). The old result is left in the strikethrough above deliberately, because a stale grep quoted as evidence is worse than a stale sentence. **And the construction site moved too, re-measured rather than interpolated:** `grep -n "new SupervisorLoop" dashboard/server/src/index.ts` → **`:146`** — so the previously published `:86` and `:159` are both stale (`:159` appears twice more in this file, at §7.1 and in the CLOSED-SINCE paragraph below, and is corrected there). |
| **3** | **A TICKET NEEDS FILING AND YOU ARE NOT AT A TERMINAL.** There is no button and no client API function; the queue can only be filled by curl. | `api.ts` declares `supervisor`, `supervisorStart`, `supervisorStop` and nothing else. |
| ~~**4**~~ | ~~**THE FIRST SUPERVISOR SUBMISSION HITS A SHAPE MISMATCH.**~~ **CLOSED 2026-08-10 (strip-crash round) — EXERCISED, AND CLEAN.** A real ticket was filed, claimed in the nudged tick, `submitted / attempt 1 of 1` written to `supervisor_log`, and a real run row (`run-2026-08-10T11-19-00-192Z-36f87c2b`) created and driven to `phase=spec, status=running` by the real orchestrator with a real Agent-SDK subprocess. **No `NewRun` column mismatch, no `bus.emit` drift.** Repeated in the final check with a second run. | The stop that used to say *"exercise it once before you rely on it"* has been exercised twice, on two different days' binaries. **Crash recovery too, with a real `kill -9` mid-`spec`:** the restarted binary resumed **from the DB** — `attemptNo` stayed 1, the quiet clock reset when the resumed seat wrote an event, and process accounting showed exactly ONE Agent-SDK child. |
| **5** | **A SUBMISSION FAILS DETERMINISTICALLY** (missing directory, full disk, an auth failure). It is BOUNDED — the claim step reads the cap before spending and the throw path counts the attempt — but there is **no backoff**, so the ticket burns all `maxAttempts` in `maxAttempts` ticks (~90 s at the default 3) and lands `blocked`. You come back to a blocked ticket, not a spinning one. **The example this row used to lead with — a bad model id — no longer reaches here: it is refused at filing with `400 invalid_model`.** | `supervisor.ts:926` (the cap read, before the spend) and `:989` (the throw path counting an attempt) — **the previously published `:455`/`:518` are wrong and both were re-measured.** Both are mutation-proved, and the cap mutation reddens THREE tests, not one. |
| **6** | **A TICKET EXHAUSTS `maxAttempts`.** `blocked` is terminal by design and no ticket is ever returned to `queued` from it. | §7.1. This is a correct stop, and it is the one you want. |
| **7** | **A CLASS THAT MUST ALWAYS STOP FIRES:** `budget_exceeded` and `missing_credential` → `owner_action`; anything touching integrity. | Named separately in `settle()` as owner-only → `blocked`. DESIGN §3.6. |
| **8** | **A RUN KEEPS LANDING NON-TERMINAL** (`rate_limited` / `awaiting_input`) past its attempts. The ticket parks `waiting` with a `next_action_at` instant and polls — it never holds a timer — but each wake that must re-submit spends an attempt, and the cap now catches it at the claim step. | §7.1. There is **no per-ticket wall-clock or spend ceiling at all** (`grep -c "wall\|deadline\|budgetMs"` → **0**). |
| **9** | **A SUBMISSION CREATES THE RUN ROW AND THEN THROWS.** The run is named by no ticket, invisible to `#inFlight()` and to the strip, and the next tick submits a second run. **Reasoned from the code, not measured.** | `supervisor.ts:567`, catch at `:496`. §6.6 item 8. |
| **10** | **A REPAIR CYCLE REFUSES AND SOMETHING RETRIES IT** — closed for the tree-state half, still open for the caller. `cycle.mjs:143` now reverts on every non-ACCEPTED exit, so the old trap (second attempt reports `COULD_NOT_REPRODUCE`, a clean plausible wrong answer) is gone. **ACCEPTED deliberately KEEPS the patch applied**, because that root is the artefact the gate reads — so a caller that reuses an ACCEPTED root will misread it. | Verifier-measured before the fix: cycle 1 REFUSED → `node check.mjs` exits 0 → cycle 2 `COULD_NOT_REPRODUCE`. |
| **11** | **THE REPAIR AGENT ASKS "HAVE I ALREADY TRIED THIS?"** The answer is always "no": the ruled-out ledger is addressed by a digest the defect writer does not produce, and the writer hashes **no field paths at all** today. The same failed patch can be re-proposed until the cap. | §6.6 items 3 and 4. **CORRECTED 2026-08-10 (repair-driver round): THE ADDRESSING HALF IS CLOSED ON THE LIVE PATH; THE LEDGER IS NOW READ BEFORE EVERY GATE RUN.** `createDefectSignatureReader` reads the `signature` FIELD off `defect.json` verbatim, and both the `<signature>.diff` lookup and `ruledOutFingerprints(signature)` key off that same string — the writer's digest end to end. The feared second formula is **not on any lookup**: `grep` for `computeSignature` outside tests returns exactly two callers, `arm.mjs` (its own arm check) and `loop-guard.mjs:97` (comparing attempts to **each other**, self-consistent). `ALREADY_RULED_OUT` is a real arm, spent **before** the gate. **What survives:** the writer's signature still carries no field paths (nothing writes `violations`), so it discriminates by site and not by what failed; and a future lookup that computes its own digest would reintroduce the mismatch as a silent ledger miss. |
| **12** | **AN INSIDE-CLOSURE PATCH IS PROPOSED.** Zero container arms execute, so 4/4 proofs is unreachable and every such patch parks as SELF-PROPOSE. **Correct behaviour** — and it means grader-adjacent repairs always wait for you. | `17 arm(s) held; 5 UNARMED`. **RE-MEASURED 2026-08-10 (repair-driver round): TRUE, AND ITS CONVERSE IS NOT.** An identical bundle placed INSIDE the closure did park as SELF-PROPOSE with a null token, on all three container proofs — so this row holds. **But the same bundle OUTSIDE the closure reached APPLY with zero container arms executed**, which is stop 20. The row is not the protection it reads like: the arm that parks inside-closure patches never runs on the editable arm, and the EDITABLE package holds the orchestrator, the recovery classifier and the gate's own caller (`gate.mjs:253-254`). |
| **13** | **A PATCH LEGITIMATELY NEEDS A HUMAN.** Every trail record carries `humanReviewed: null` and nobody has designed who mints an out-of-loop approval token while you are asleep. | `RESEARCH` §5 item 4; DESIGN §10.5 item 9. |
| **14** | **YOU WANT TO KILL A RUN WITHOUT LOSING THE QUEUE.** abort-now answers 501 and the strip has no abort control; the options are drain (wait) or cancel the run directly and leave the ticket inconsistent. | `http.ts:1520`. |
| **15** | **THE PIPELINE FAILS IN A WAY WITH NO STRUCTURED DETAIL** — which is all of them today. `violations` is still `null` at the write site, so the signature carries zero field paths and nothing writes the authoring trail. **HALF-CHANGED 2026-08-10 (strip-crash round):** the client no longer hardcodes the blank. It reads the wire's `probe.unsourced`, renders the real `snapshot.attempts` when they arrive, and the whole `stuck / looping, not converging` path — the ONLY arm that catches `a913c871` — is now **armed, rendered and browser-tested against that run's three real rejection sets**, with a healthy 15 s quiet clock so it cannot pass via the 40-minute ceiling. **It still cannot fire on live data**, because nothing produces the trail. The day a producer lands, the name leaves `unsourced`, the list renders, and **no client code changes.** | `orchestrator.ts:7316` (`violations: null`, one hit). `ATTEMPTS_NOT_ON_THE_WIRE` survives only inside a docblock at `supervisor-strip.tsx:74` recording that it used to be a value. **And it was measured that wiring the trail on PROSE-ONLY `problems` would be worse than the gap:** on `a913c871`'s own data that shape gives `blind:true, arm:BLIND, escalateAtAttempt:2` — a false stop on attempt 2 of every ticket. |
| **16** | **THE PROCESS ITSELF DIES.** There is no launchd plist and no crash-loop brake (DESIGN §9 step 15, not built). The loop survives its own restart — **verified with a real `kill -9`, twice now** — but nothing restarts the process. | §7.1, §6.6. |
| **17** | ~~**THE MORNING READOUT CANNOT TELL "THE QUEUE FINISHED" FROM "THE QUEUE IS ALL BLOCKED".** … **`GET /api/supervisor/tickets` is a measured 404** …~~ **HALF CLOSED 2026-08-10 (repair-driver round): THE ROUTE AND THE SIXTH LIVENESS BOTH EXIST; THE PAINT IS UNVERIFIED.** `GET /api/supervisor/tickets` is routed and measured (its own suite; an empty store answers `200 {tickets:[], probe:{ticketsSeen:0…}}` so a blind reader is a different body from an empty queue). The strip gained a sixth liveness `blocked` and now reads `blocked · queue ended · N blocked` versus `idle · queue finished · N done` versus `idle · idle, no tickets filed` versus `idle · idle, queue empty` + the reason it cannot see a census. **What is NOT closed:** no browser project could run beside the live run, so `supervisor-strip.tsx` has **zero executed tests** — the four `censusCell` branches, the failed-row list, the absent-column paragraph and `data-cycle` have no runnable check and therefore no mutation coverage. **A readout whose rendering has never been executed is not yet a readout.** | Route: measured. Classifier: mutation-proved (blinding the sixth probe reddens 8 unit tests and the boot line reads `only 5 of 6 states are distinguishable`). Rendering: §9.3 items 2-5. |
| **18** | **A REPAIRING TICKET NEVER GETS A CYCLE ON A BUSY NIGHT.** The repair step runs at most one cycle per repairing ticket per tick and **declines entirely while a run is in flight** — never patch a tree under a live build. On a permanently busy queue the ticket therefore reaches its 30-minute deadline with `REPAIR_DEADLINE_EXCEEDED` **without a cycle ever running**. The sentence says so. | Designed trade. The deadline is the number to raise once a sandbox exists — not before, or a ticket waits longer for the same nothing. |
| **19** | **`next build` REWRITES A TRACKED FILE UNDER YOU.** It appends `.next/types/**/*.ts` globs to `dashboard/tsconfig.json`'s `include` and prints only *"include was updated to add…"*. Not a run-stopper; a **commit**-stopper, and it is why §7.2-A now opens with a `git diff`. | Observed twice this round, restored byte-exactly from `git show HEAD:dashboard/tsconfig.json` both times. Next's own behaviour; nothing in this repo calls it. |
| **20** | **THE GATE CAN SAY `APPLY` WITH ITS CONTAINER ARMS UNABLE TO RUN — added 2026-08-10 (repair-driver round), and this is the round's BLOCKING finding.** An OUTSIDE-CLOSURE diff plus a hand-typed evidence bundle got **`VERDICT APPLY` and a real 64-hex `applyToken`** on this dockerless machine, `containerExecuted 0`. With the driver wired that token is exactly what `applyGatedPatch` accepts to `git apply` against the owner's real working tree, unattended, on the 30 s tick. **It is not armed tonight** (live `dist/` is pre-round and `dashboard/data/repair-proposals` does not exist — both re-measured), and it arms at the next rebuild. | Measured on the real `tools/tier3/gate.mjs#runGate()`; both negative controls park with a null token. Mechanism, all three re-verified from source by the recorder: `ok: arms.length === 5 && blind.length === 0` (`armcheck.mjs:213`) — the container arms A6/A7 live in a separate `unarmed` list `ok` never reads; `aggregateKnownBad` returns `PASS-WITH-UNARMED` (`known-bad.mjs:466`) whose own reason promises *"UNARMED is not PASS: it degrades any proof that depends on it to INCONCLUSIVE"* and **`decide()` has no branch that reads that word** (`grep PASS-WITH-UNARMED` → one hit, the producer); the sole proof consulted on the editable arm is satisfied by a non-empty string (`gate.mjs:114`). **§9.4 item 1 — owner arbitration, because `gate.test.mjs:553` PINS this behaviour and passes.** |
| **21** | **AN APPLIED PATCH CANNOT AFFECT THE ATTEMPT IT WAS APPLIED FOR — added 2026-08-10.** `git apply` writes to `src`; **nothing on the path rebuilds.** The live server runs `node dist/index.js` and the scorer resolves its own compiled output, so `REPAIR_APPLIED` re-queues the ticket, the re-run executes byte-identical behaviour, the same defect reproduces, an attempt is spent — and the tree has silently diverged from `dist`. | `grep` for a builder in `tools/repair`, `tools/tier3/gate.mjs`, `dashboard/server/src/supervisor*.ts` and `index.ts` → nothing. The staleness is **known and unenforced**: `gate.mjs:142` computes `distFreshness(...)` and records it in the trail at `:201`; `decide()` never reads it. **Catalogued instance candidate — see §9.5 for the numbering.** |
| **22** | **NOTHING REVERTS AN APPLIED PATCH ON ITS OWN — added 2026-08-10.** `revertGatedPatch` has **no production caller**; the rollback record is written before `git apply` and the round trip is exercised at every boot in a throwaway repo, so the mechanism works — but a human runs it. What changed this round is that the sentence the owner reads at 3 a.m. now names a command that **exists**: `node tools/repair/supervisor-gate.mjs --revert <rollbackPath>`. Before, that sentence pointed at a script whose CLI ran the arm check and exited 0 — *a paste that printed `ARM CHECK: armed` and looked like a successful revert*. | `grep -rn revertGatedPatch tools dashboard/server/src dashboard/src` → callers only inside `armCheck()` and the test. `git apply -R` is the whole mechanism, so a line touched since is a **named** `REVERT_NOT_APPLIED` refusal, not a silent failure — honest, and it leaves a patched tree plus a refusal. |
| **23** | **A HANGING GATE IS ORPHANED — added 2026-08-10, and it is the one finding with a live blast radius.** `spawnSync` with `killSignal: SIGKILL` signals the **child**, not the process group; there is no `detached: true` and no group kill anywhere on this path, so the gate the cycle spawned survives its parent's death and can keep writing `dashboard/data/tier3` (and, with docker, running containers) after the ticket has been filed as `REPAIR_CYCLE_TIMED_OUT`. **Half fixed:** `GATE_TIMEOUT_MS` is now **8 min**, strictly shorter than the supervisor's 10 min, so the inner clock fires first inside the gate's real parent and the outer kill is the fail-safe rather than the normal path — pinned by a test that reads the outer bound out of `supervisor-boot.ts` source. **That pins an inequality between two constants; it does not prove the reaping.** | The false comment that asserted a polite signal *"leaves the grandchildren holding the clock"* is corrected in place. The real fix needs `detached: true` + `process.kill(-pid)`, which converts `RepairDriverDeps["run"]` from sync to async across the driver, the arm and every injected test runner. **The negative control to write with it:** a child that spawns a sleeping grandchild, parent timed out, grandchild asserted gone. |
| **24** | **THE APPLY TOKEN IS A SELF-CONSISTENCY DIGEST, NOT AN AUTHORITY — added 2026-08-10.** `tokenInputs` reads `frozen.digest`, `knownBad.verdict`, `proofs` and `armCheck.ok` **out of the same record it is validating**, and `mintApplyToken` is an **unkeyed** sha256 over them. So the seam checks that a record is internally consistent and bound to THIS diff — not that a gate ran, that the known-bad set passed, or that any proof was satisfied. Today the record comes from the real gate's trail file, so the live exposure is the gate's bar (stop 20), not forgery. | The proof is in the file: `armApplyRecord()` fabricates a record and mints a verifying token for it in five lines. The docblock's old claim — *"the token is the only authority this file accepts"* — is corrected in place to what it does: **it binds one gate record to one diff and one frozen manifest.** Closing it needs **provenance** (a key the gate holds, or binding to the trail the gate wrote), not more guards over self-supplied fields — see §9.4 and §9.5. |

**CLOSED SINCE THE REVIEWER WROTE THEIR LIST, and recorded so the fix is not re-reported as a
gap:** *"the supervisor is never constructed"* (now `index.ts:146`, arm-gated — **`:159` re-measured 2026-08-10, repair-driver round**); *"there is no way
to file a ticket"* (now `POST /api/supervisor/tickets`, though still curl-only — stop 3);
*"a throwing submit spins for ever"* and *"`#wake` exceeds `maxAttempts` without bound"* (claim-step
cap); *"a REFUSED cycle leaves the patch applied"* (`cycle.mjs:143`); *"a 200 with the wrong body
blanks the whole page"* (shape arm at `supervisor.ts:296`/`:421` — ~~**closed at unit level
only**~~ **now closed at BROWSER level with an error boundary behind it, twice re-measured
live — §8.1**).

> **AND TWO MORE CLOSED 2026-08-10 (strip-crash round), recorded here so they are not
> re-reported as gaps:** *"the first supervisor submission may hit a shape mismatch"* (stop 4,
> exercised twice against a real orchestrator) and *"`POST /api/supervisor/tickets` accepts a
> model id that cannot run"* (never on the reviewer's list — found by the gate, fixed in the
> repair pass, verified live).

### 7.3 WHAT IS STILL NOT BUILT, OR NOT PROVEN — UNFLINCHING

> **RE-MEASURED 2026-08-10 (strip-crash round). Six of this section's claims moved; the three
> answers below did NOT, and that is the important half.** What moved: **the browser suite has now
> been run** (273 passed / 1 skipped, twice, identical leaf sets, 33 files) so *"no browser spec in
> this round was ever executed, by any lane"* is history; **screenshots were taken AND looked at**
> with the Read tool, so *"no visual claim about the strip is verified"* is history — and looking
> at them found a copy defect no textContent assertion could see; **the client-unit baseline diff
> was measured** (199, zero removals); **the suite figures are all superseded** — see the pointer
> at the head of this file, and treat every count in the bullets below as pre-repair; **the
> `a913c871` detector is no longer fed a client constant** (stop 15); and **`probe.unsourced` now
> has a consumer**. What did NOT move: **no supervisor-submitted run has ever reached a verdict**,
> **no defect record has ever been written by a real failing run**, and **no patch has ever been
> applied to this repository.** §8.4 is this round's own version of the three answers.

**The three questions asked directly, each with its measurement:**

1. **HAS THE REPAIR AGENT EVER PRODUCED AN ACCEPTED PATCH?** **Yes — and not in production.**
   `VERDICT: ACCEPTED`, `prove outcome: PROVEN`, three verbatim transcripts with exit-code
   trailers. But there was **no real defect record to hand it** — `find dashboard/runs -name
   defect.json` → nothing, `ls -d dashboard/data/defects` → *No such file or directory* — so the
   record was hand-built from the run's `runs.db` row plus the three extracted manifests, the
   defect was reproduced in a scratch sandbox, and **the patch was never applied to this
   repository.** The patch AUTHOR does not exist; the candidate diff was an input.
2. **HAS THE TIER 3 GATE EVER REFUSED A REAL ONE?** **It refused a real grader softening —
   `bakeoff/src/scorer-container.ts` with `const suiteGreen = true` and a full evidence bundle —
   and it refused it for the wrong reason.** The printed reason was *"3 of 4 required proofs are
   not satisfied"*: inside-closure plus UNARMED container legs. **There is no softening
   detector.** What is proven is *"nothing inside the closure can reach APPLY today"*, a
   mechanical property, correct and vacuous as a detector. The mechanism that would actually
   catch it — the 5 `MUST_FAIL` calibration fixtures going green under the softened scorer — has
   **0 executed container arms**. When someone writes those executors, **re-run this test**; do
   not let today's correct verdict be cited as evidence the detector works.
   **And the accept path was worse than the refuse path.** A proposal whose entire evidence
   bundle was `{redBefore:"x", greenAfter:"x", mutationRed:"x", noOpAblation:"x"}` returned
   `VERDICT APPLY` with a real token, because the OUTSIDE-CLOSURE branch returned APPLY before
   `proofs` was consulted and the only bar was a non-empty-string check — **while
   `RED_EQUALS_GREEN`, `EVIDENCE_EXIT_CODES_INCONSISTENT` and `SCOPE_UNIMPLICATED_FILE` already
   existed, mutation-proved, twelve directories away, with zero cross-imports.** That door is
   the only one authorising writes to the package containing the orchestrator, the recovery
   classifier and the gate's own caller. **Fixed** (`proposal.mjs:29` + the ablation requirement),
   pinned by a test whose input is that exact proposal — **but two of the six available checks
   are still unenforced at Tier 3** and `noOpAblation` remains a string nothing executes.
3. **HAS ANY OF THIS RUN DURING AN ACTUAL BUILD-TO-VERDICT?** **No. Not once.** Zero defect
   records on disk, zero authoring trails on disk, zero real supervisor submissions, zero
   patches applied. `createSupervisorSubmit` has never touched a real `RunStore`. The gate's
   4 trail records and the repair agent's ACCEPTED proposal are the only artefacts this round
   produced, and both came from hand-driven harnesses.

**AND THE COMPONENT-BY-COMPONENT HONESTY:**

- **THE `a913c871` DETECTOR IS DORMANT ON LIVE DATA.** The comparator is built, armed and
  mutation-proved in both directions, and is fed `ATTEMPTS_NOT_ON_THE_WIRE = []`. It is a one-field
  server change **that is inert until `violations` is non-null**.
  > **HALF-CORRECTED 2026-08-10 (strip-crash round).** The constant is gone: the strip reads
  > `snapshot.attempts` and takes its honest blank from `probe.unsourced`, and the whole `stuck /
  > looping, not converging` rendering path is now exercised in a real browser on that run's three
  > real rejection sets. **Still dormant on LIVE data** — nothing writes the trail. The comparator
  > itself was additionally proved against the run's three REAL manifests (attempt 1→2 is a genuine
  > SHRINK that must NOT escalate; attempt 3 brings `dataExpectations[].id` back and escalates with
  > arm `OSCILLATION`), with the SHRINK arm holding green under the mutation that killed the
  > OSCILLATION arm — so the two halves are independent rather than one lucky assertion.
- **THE 40-MINUTE THRESHOLD IS CALIBRATED ON ONE RUN.** Nothing establishes that a healthy build
  phase never exceeds 40 minutes of quiet. A false `stuck` costs a trip to the machine, which is
  cheap, and costs the indicator its credibility, which is not.
- ~~**THE BROWSER SUITE IS INCOMPLETE AND ITS FAILURE COUNT IS A FLOOR.**~~ **SUPERSEDED
  2026-08-10 (strip-crash round): the project was run to completion four times across the round
  and never failed once — 267 (untouched tree, **the lane's own figure**) → 271 (gate) → 273
  (final check, twice consecutively, identical leaf-name sets, 33 spec files, 2.4 m). The ten catch-all
  `page.route("**/api/**")` files pass because the component now SURVIVES their bodies, which was
  the brief's actual constraint. `Cannot read properties of undefined (reading 'wired')` appears
  nowhere in either final transcript.** The paragraph below is kept for the record of what was
  believed:
  **64 of 267 tests: 40 passed, 24 FAILED**, all 24 in the 10 of 32 spec files that install a
  catch-all `page.route("**/api/**")` fulfilling any unmatched path with a 200 — which is what
  found the blank-page defect. The shape arm is proved at **unit level only** — the repair pass's
  own figure, client unit 189 → 190 with zero regressions in the existing 18 arm tests, **not**
  independently re-measured because that project binds 4322. **No browser spec in this round was
  ever executed, by any lane, the verifier or the repair pass.** `run-layout`'s
  `scale > 0.7` at 2000×1200 — the assertion the 30 px strip actually threatens — and
  `prose-guard`'s 40-word budget were both satisfied **by reading, not by running**.
- ~~**NO SCREENSHOT WAS TAKEN OR VIEWED.**~~ **SUPERSEDED 2026-08-10 (strip-crash round): shots were
  taken at 1440×900 and OPENED WITH THE READ TOOL at all three stages of the round** — the five
  states, the guard fallback, four malformed-wire cases, and the live pages against a real backend
  (the round's own report lists the files). **Looking at them found a defect
  every existing test was blind to**, because they all read `textContent`: the malformed row led with
  its field list, so truncation ate both clauses the owner can act on. The sentence was reordered so
  the action comes first and the field list last.
- ~~**THE CLIENT-UNIT BASELINE DIFF IS UNMEASURED**~~ — **MEASURED 2026-08-10 (strip-crash round):
  171 at the tag → 199 now, zero leaf names removed.**
- **SUITE NUMBERS, ATTRIBUTED AND PRE-REPAIR.** The verifier measured: bakeoff **160/160** (baseline
  146/146, zero leaf names dropped, +14 from the concurrent round); server **1927 tests / 1923 pass /
  1 fail / 3 skip**; client unit **189**; browser aborted. `tsc --noEmit` **exit 0, zero output
  lines, in all three packages** — the client mirror typechecks clean against the server, which is
  the check Playwright's transpile-only loader cannot substitute for. **The sole server failure was
  `db.test.js` *"THE OWNER'S OWN runs.db OPENS AND KEEPS ITS RUNS"*, PROVEN pre-existing** by
  building the tree from `git archive gate-verified-2026-08-10` in scratch against the same live
  database and getting the byte-identical assertion; **the repair pass then fixed the fixture** —
  `recoveryClass` is now asserted null-or-a-non-blank-word (deliberately NOT against a whitelist,
  because `runs.recovery_class` is read with `strOrNull` and the concurrent round is splitting the
  class right now) and `listAttempts` is asserted numbered `1..n` with no gaps. **So the server
  count has moved since the verifier measured it; re-measure before quoting.**
- **TWO SERVER LEAF NAMES WERE DROPPED, both benign renames** by the concurrent recovery split
  (`recovery.test.ts:233`, `:318`), where `budget_exceeded` was reclassified structural →
  `owner_action` and the ordering property was retained AND strengthened. Flagged only so a future
  leaf-name diff against the tag does not re-raise it.
- **THREE LANE SELF-REPORTS WERE STALE AND MUST NOT BE CARRIED FORWARD:** *"supervisor.ts does not
  typecheck (TS7027/TS18048)"* — both fixed, compiles clean; *"http.ts:992 carries a literal
  `@@COMPOSER@@` marker"* — `grep -an "@@COMPOSER@@" dashboard/server/src/http.ts` returns nothing;
  *"`SupervisorLoop` has no `tick()`"* — it is at `supervisor.ts:367`.
- **THE MUTATION AUDIT REPRODUCED SIX OF SIX**, one per lane plus the TypeScript target, each
  restored and verified by `shasum -a 256 -c`. **The restore proof matters:** `git diff` is
  worthless as a restore check for most of these targets, because `tools/**` and `supervisor.ts`
  are **untracked** — a diff would show nothing whether or not the file was restored, which is a
  check that can only observe success.
- **`#lastSignals` / `#lastAuthoringError` ARE IN-MEMORY MAPS** cleared only in
  `#writeDefectRecord`'s `finally`. A run that is rate-limited and never reaches `#finish` leaks an
  entry per park on a long-lived process — bounded by the single active slot, but worth a line here
  rather than a discovery later.
- **THE DEFECT SIGNATURE IS COARSE, AND IT IS STABLE.** With no structured violations, every failure
  sharing a `phase/status/bakeoffCode` triple collapses into one shard. Stable is what the anti-loop
  rule needs; low-resolution means a fingerprint rule built on it **today** would over-group. The
  record says so in `unavailable[]`.
- **THE FIXTURES' PROVABILITY HAS A CLOCK ON IT.** `extract-fixtures.mjs --check` passes today
  because the three CLI transcripts still exist. When that session directory is reaped the committed
  fixtures become the only copy and `--check` becomes an error rather than a verification. **The
  fixtures themselves are durable; the re-derivation is not.**
- **A LOADER BEHAVIOUR WORTH KNOWING BEFORE ANYONE EDITS `corpus.json`:** renaming a case's `id`
  disables nothing, because `from: "literal-known-good"` and `from: "shipped-prompt"` resolve their
  manifest from the source kind, not the id. The first attempt at that mutation SURVIVED for exactly
  that reason.
- **`bakeoff/dist` IS A SINGLE POINT OF SILENT FAILURE FOR EVERY ARMED TIER 3 ARM.** Freshness is
  per-module and drives arms to UNARMED rather than to a silent pass, but a concurrent rebuild
  between the freshness read and the import is not covered; the recorded dist sha256 in the trail is
  the only after-the-fact evidence.
- **`MUTATION_SURVIVED` IS ONLY REACHABLE WHEN THE CHECK IS STATEFUL OR NONDETERMINISTIC.** With an
  exact apply/revert the mutant restores the pre-state, which was RED by construction — so in the
  common case that arm can only pass. `UNPROVEN_HUNKS` is the arm doing real work on multi-hunk
  diffs. **Do not read a clean `MUTATION_SURVIVED` record as strong evidence.**
- **SCOPE ENFORCEMENT IS PARTLY AGENT-SERVICEABLE.** `implicatedFiles` scrapes path-like tokens out
  of the `redBefore` transcript, so an agent that writes its own reproduction test can implicate any
  file by naming it in a failure message. The structured fields (`defect.artefacts`,
  `defect.candidatePaths`) are the trustworthy half.
- **`git apply` IS THE PATCH ENGINE AND ONLY IN-PLACE HUNKS ARE TESTED.** A patch adding, deleting or
  renaming a file is untested; `splitHunks()` throws on anything that is not `git diff`/`diff -u`
  output rather than guessing. **And there is no timeout above the 120 s per-command default** — a
  hanging reproduction command stalls the cycle (`RESEARCH` R3 argues for a per-stage wall-clock bound).
- **SWR's `keepPreviousData` IS LOAD-BEARING AND SILENT.** The whole `unreachable` + `stale` behaviour
  depends on `data` surviving a failed poll while `error` is set. Turning it off degrades the strip to
  blanking (the safe direction); turning `shouldRetryOnError` back on hides a dead backend behind the
  retry ladder. Both are one-word edits in `hooks.ts` with no test pinning them.
- **`supervisorQuietMs` READS ALL OF THE CURRENT RUN'S EVENTS ON EVERY POLL.** At 1,816 events across
  5 runs that is nothing; a 12-hour run polled every 5 s is an O(events) scan per poll. The cheap fix
  is a `lastNonTelemetryEventAt(runId)` reader in `db.ts`.
- **`probe.unsourced` IS A HAND-MAINTAINED ARRAY.** A test asserts its exact contents, so a producer
  landing without the name being removed goes red — but a name removed without a producer landing
  would go green wrongly. **It now has a CONSUMER too (2026-08-10, strip-crash round): the strip's
  honest blank is chosen from this list rather than from a client constant, which is what makes the
  detector light up with no client edit — and raises the cost of a name removed carelessly from
  "one wrong test" to "one wrong sentence on the operator's screen".**
- **SWR's `keepPreviousData` HAS A SECOND CONSEQUENCE NOBODY HAD FOLLOWED (found 2026-08-10,
  strip-crash round).** Because a failed poll keeps the last body, the shape check had to move
  ABOVE every arm: it used to live inside the `probe.wired` arm, below the error and stale arms,
  both of which keep the body and publish it on `reading.snapshot` — so **a malformed 200 followed
  by one dropped poll returned `unreachable` WITH the malformed body attached, and the component
  threw on it.** That is a second blank-`RootLayout` path inside the fix for the first. §8.1.
- **THE SERVER'S CONTRACT FILE IS NOW DOWNSTREAM OF A CLIENT FILE IN PROVENANCE**, because the wire
  shape was converged onto a mirror another lane had already shipped. It remains authoritative in
  fact, and ~~`cd dashboard && npx tsc --noEmit` is the **only** thing that catches a divergence~~ —
  the browser suite will not.
  > **FALSIFIED 2026-08-10 (strip-crash round), and this is the sentence that cost the round its
  > gate.** `tsc` catches **nothing** here: `dashboard/src/lib/api-types.ts` declares its OWN
  > `SupervisorState` and never imports `ApiSupervisorState`, so the two declarations never meet
  > under any typechecker. Three green `tsc --noEmit` runs sat over a wire contract that disagreed
  > in **fifteen fields**. What catches it now is `dashboard/tests/fixtures/supervisor-wire.golden.json`
  > — GENERATED by running the server's own `composeSupervisorState`, and asserted **from both
  > ends**: `dashboard/server/src/supervisor-route.test.ts` deep-equals the composer against it, so
  > SERVER drift reddens there, and `dashboard/tests/supervisor-strip.unit.spec.ts` classifies it
  > and diffs its key set against the mirror, so CLIENT drift reddens here. **Regenerate, never
  > hand-edit:** `cd dashboard/server && npm run build --silent && node
  > ../tests/fixtures/supervisor-wire.golden.mjs > ../tests/fixtures/supervisor-wire.golden.json`.
  > If the server test reddens, regenerate — then the client test tells you whether the mirror has
  > caught up. **That ordering is the whole value of the pin, and a hand-edited golden destroys it.**

---

## 8. THE STRIP-CRASH / STILL-PARKS ROUND — MEASURED 2026-08-10, AFTER THE TAG

Two lanes on a disjoint file list, a final gate, a repair pass and a final go/no-go. §7 built the
supervisor; this round made its instrument readable and stopped its parks. **Nothing was committed:
`HEAD` is still `d32ad858…`, `gate-verified-2026-08-10` still resolves to `50a99fdf…`, `git status
--short` is the same **36** lines it was at session start, and `git diff --stat` is 19 files /
6,745 insertions / 63 deletions.**

### 8.1 THE CRASH — INSTANCE TWENTY-TWO, HOW IT SHIPPED, AND THE THREE MORE THAT WERE STILL THERE

**THE REPORTED CRASH DID NOT REPRODUCE, AND THE FIRST ACT OF THE ROUND WAS TO MEASURE THAT.** The
brief described 80 FAILED / 186 passed with 77 copies of `Uncaught TypeError: Cannot read properties
of undefined (reading 'wired')` out of `RootLayout`. On the untouched tree the browser project was
**267 passed / 1 skipped, exit 0** — an earlier pass had already added the shape arm, so the
malformed body could not reach the component. **That 267 is the LANE's figure and no other stage
could take it**, because the tree had already changed by the time the gate ran; what the gate and
the final check independently confirmed is the part that matters — **no tree that can be built
produces 80 failed / 186 passed**, and `Cannot read properties of undefined (reading 'wired')`
appears in neither final transcript. The crash CLASS was real; the numbers were
history.

**THE ROOT CAUSE IS WORTH MORE THAN THE CRASH: A THREE-STATE ARM CHECK THAT WAS ONLY GIVEN TWO ARMS.**
The design specified an instrument that can say *unreachable*, *reachable and readable*, and
*reachable but malformed*. The component shipped with an arm for the first, an arm for the second and
**no arm for the third** — so a 200 whose body was not a `SupervisorState` reached
`snapshot.probe.wired`, threw out of `RootLayout`, and blanked **every route**: no strip, no canvas,
no error text, nothing to read at 3am. **This is instance twenty-two of this repository's signature
defect, and the aggravating fact is that it was introduced by the same session that catalogued the
first twenty-one.** Cataloguing the defect does not immunise you against it; only a probe per state
does.

**FOUR THINGS LANDED, AND EACH ONE ANSWERS A DIFFERENT PROMISE.**

1. **THE STATE IS NAMED.** `SupervisorLiveness` gains `malformed`, so *"the route did not answer"*
   and *"the route answered with something else"* stop sharing one badge word. Amber, shared with
   `unreachable` on purpose (§7.2-B).
2. **THE VALIDATION IS EXHAUSTIVE, AND IT IS A PROMISE ABOUT DATA.** `malformedReasons`
   (`dashboard/src/lib/supervisor.ts:470` — **not the `:445` a previous report published**) checks
   **every declared field** across `SupervisorState`, `SupervisorTicket`, `SupervisorRepair` and
   `SupervisorProbe`, with `absent` distinguished from `null` per api-types' own `T | null, never
   T?` rule, and with `runStatus` / `phase` / `ticket.state` **deliberately NOT narrowed to their
   unions** — a healthy server that grows a tenth phase must not be reported unreadable. The
   invariant is now statable: *a body that clears this function cannot make any consumer of
   `reading.snapshot` throw.* **Behaviour change recorded rather than hidden:** `probe: {}` used to
   render *"no supervisor wired"* — a claim about the supervisor invented from an absent field — and
   now reads `malformed`, which is a claim about the body.
3. **`RenderGuard` IS A PROMISE ABOUT CODE**, and choosing only one of the two promises is how both
   blank pages happened. No amount of data validation covers a field the contract grows and nobody
   validates, an `Intl` option a future browser rejects, or tomorrow's edit to this component.
   `grep` confirmed `dashboard/src/` had **zero** error boundaries before this one; it still has
   exactly one, and it wraps the strip and nothing else. §7.2-B has the fallback copy and the SSR
   limit.
4. **THE ARM CHECK GREW A FIFTH PROBE FOR THE FIFTH STATE.** Shipping `malformed` under a
   four-probe arm would have been instance twenty-three by construction: the line would print
   *"4 distinct"* for ever while the newest state was unreachable code. `armSupervisorStrip` now
   pushes **five** inputs with five known answers through the real classifier and requires
   `distinct === 5`.

**AND THREE MORE CRASH PATHS WERE FOUND THAT THE BRIEF DID NOT NAME. Two of them were inside the
fix.**

- **A NATURAL RED on the tree that had already been declared fixed.** Serving
  `{...RUNNING(), lastDefectSignature: {signature:"a1b2…"}}` produced `Uncaught TypeError:
  signature.slice is not a function at shortSignature (supervisor-strip.tsx:74) … at RootLayout` and
  the strip element was gone — **the same blank page as the `probe.wired` crash, one field to the
  left.** No mutation was needed to see it; the five fields the arms happened to read were not the
  nineteen fields the component dereferences.
- **THE ARM ORDERING** — the shape check lived inside the `probe.wired` arm, below the error and
  stale arms, which keep the previous body. One malformed 200 plus one dropped poll returned
  `unreachable` **with the malformed body published on `reading.snapshot`**, and the component threw
  on it. The shape is now checked **once, above every arm** (`readable = shape === null ? snapshot :
  null`), which is what makes the invariant true for all five livenesses rather than for one.
- **THE ARM CHECK ITSELF COULD BLANK THE PAGE, AND `RenderGuard` CANNOT SAVE IT.** It runs inside a
  `useState` initialiser — i.e. **in the render body, on the server** — and React error boundaries
  do not catch server-render throws. Under one mutation that is exactly what happened: the arm threw
  during SSR and the whole suite died on `Timed out waiting 180000ms from config.webServer`, **a
  message naming neither the strip nor the field.** Each probe now catches and answers `threw:
  <message>`, which matches no expected value, so the probe FAILS and the strip renders the BLIND
  alarm naming the input. **The structural fact stands for every future always-on component: an arm
  check in a render body is outside the boundary.**

### 8.2 THE ROUND'S REAL BLOCKER — THE INSTRUMENT WAS BLIND AGAINST THE OWNER'S OWN BACKEND

**Measured by the gate, at runtime, against a real server — not inferred.** With the browser suite
green and every state photographed, the strip read **amber `MALFORMED` on `/`, `/runs`, `/projects`
and a run page against the real backend**, naming eight fields. `data-liveness="malformed"`,
`data-stale="true"`, page intact, zero `pageerror`. **The page was fine. The instrument was blind.**

**Why nothing could see it.** The client mirror and the shipped wire disagreed in **fifteen fields**
— mirror-only: `since`, `runId`, `runStatus`, `phase`, `lastDefectSignature`, `queuedTickets`,
`quietForSeconds`; wire-only: `changedAt`, `at`, `run`, `attempts`, `lastDefect`, `lastDefectId`,
`lastPatchId`, `queueDepth`; plus `lastRepair` NULL on a healthy run against a non-nullable mirror
type. Three typecheckers were green because the two declarations never meet (§7.3, falsified
bullet), and **no test in either suite could see it because `dashboard/tests/fixtures/` serves no
`/api/supervisor` at all** — every spec reaches `unreachable`, never `malformed`.

**The consequence, stated the way it matters:** if the loop wedged at 3am the strip would not have
said `STUCK`. It would have said `MALFORMED` — exactly what it says when nothing is wrong. **An
owner who learns to read amber as background noise also misses amber `UNREACHABLE`.**

**CLOSED IN THE REPAIR PASS, AND RE-MEASURED BY THE FINAL CHECK.** The mirror was rewritten onto the
wire field for field, followed through the validator, the classifier arms, `stubState` and the
strip's cells, and **pinned from both ends by a generated golden fixture** (§7.3). The final check
then booted the real server on a clone and drove the real client: live **`idle`** on four routes
(*"stopped, nothing in flight"* / *"boot set it to stopped: the supervisor has never been started on
this database"*), and — the thing the gate said was impossible — live **`running`** with a real run
in flight: `RUNNING / spec · attempt 1 of 1`, `TICKET t-f53cb8b5427dca44 · 1/1`, `QUIET 38.8s`.
**Amber is gone.** The browser spec case whose own docblock read *"THE DAY SOMEBODY ALIGNS THE TWO,
THIS CASE FLIPS"* was flipped rather than deleted.

**ONE MAJOR FINDING WAS HALF FALSE AND IS NOW ASSERTED RATHER THAN ARGUED.** The gate warned that an
exhaustive validator makes the strip stricter than the server, so *any* field the server adds flips
a healthy supervisor to amber. **Measured false for ADDED fields** — `malformedReasons` inspects only
the keys the contract declares, and a test adds a scalar, an object, an array and a nested `probe`
field to the golden body and requires `running`/`idle`. **True, and deliberately kept, for a field
the server DROPS, renames, or leaves `undefined` for `JSON.stringify` to delete** — that arrives
absent, and accepting absent where the contract says `| null` would re-create the exact blindness
the arm exists for. *"The supervisor says there is no run"* and *"the field is missing"* are
different facts.

### 8.3 EACH PARKING GAP — CLOSED, OR NOT, WITH THE MECHANISM

| gap | status | what is actually true now |
|---|---|---|
| **THE SPIN** — a submit that throws deterministically re-claims every 30 s for ever | **CLOSED, and it was closed BEFORE this round; verified, not re-fixed** | `supervisor.ts:989` counts the attempt on the throw path, `:926` reads the cap at claim time, `blocked` (never `queued`) is the terminal. Proved load-bearing by mutation rather than trusted: reverting the increment reddens *"a submit that ALWAYS throws reaches blocked in bounded ticks"* with `a failed submission did not count as an attempt / 0 !== 1`. |
| **THE CAP BYPASS via `#wake`** | **CLOSED — the guard existed, the PROOF did not** | The two pre-existing cap tests built the post-wake row by calling `updateSupervisorTicket({state:'queued', attemptNo:1})` **directly**, so they proved the guard handles that row and nothing about whether `#wake` produces it. A new test drives the real documented loop end to end — submit → `rate_limited` → `waiting` → clock advanced past the wake instant → `#wake` re-queues → … → `blocked` — and asserts every run stays non-terminal so `settle()` provably never ran. **The seam is measured, not asserted: under `attemptNo: 0` in the wake branch, BOTH pre-existing cap tests stay GREEN and only the new one reddens.** |
| **`repairing` IS A DEAD END** — the most likely way the night ended | **CLOSED as a park, STILL A STOP** | Verified dead first (`settle()` was the only producer; `#tickOnce` step 1 listed only `claimed`/`running`/`waiting`; zero references to `tools/repair` from the server). Now: a pure `routeRepairOutcome()` with **six named outcomes, five terminal**; the repair step sits **before** the in-flight early return (a repairing ticket has a null `currentRunId`, so `#inFlight()` cannot see it and a later placement would starve it) and reads a list snapshotted **before** reconcile, so `repairing` stays observable for one tick; an absent `repair?` dep is a **named terminal outcome, not a wait**; bounds are 30 min per ticket and 2 cycles per signature counted in a new `repair_counts` column with an additive, DROP-COLUMN-tested migration; `settle()` now also stamps `last_defect_id`, **a column that previously had no writer at all**. |
| **THE SIGNATURE IS BLIND** — `violations: null`, so the anti-loop comparator has no field paths | **PARTIAL, and the unlanded half is a HANDOFF because the brief's premise does not hold** | The brief said the paths "exist upstream". Measured chain: `scorer-protocol.ts:762`'s `ManifestProblem` **does** carry `field`, but `spec-validate.ts:1331-1336` calls `blocking("other", null, …message :: remediation)` and **drops it**; `contracts.ts:308`'s `AuditFinding` has no field slot; `BakeoffError` carries no attempts. **The only surviving copy of the path is inside prose, and `signature.mjs:81` explicitly bans regexing it out.** So it cannot be done by consuming what `bakeoff/src` emits — which is forbidden to edit this round anyway. **Landed instead, the half that is real:** `tools/repair/manifest-paths.mjs` derives field paths the honest way, from a manifest DOCUMENT through the **live sealed parser** loaded off disk (never vendored), dropping document-level labels because a constant present in every set makes the OSCILLATION and NON_MONOTONE arms unreachable — plus the proof on `a913c871`'s three real manifests (§7.3's corrected detector bullet). |
| **`POST /api/supervisor/tickets` ACCEPTS A MODEL ID THAT CANNOT RUN** — found by the gate, not by a lane | **CLOSED** | §7.2-A. Three-armed on purpose, and the naive version was falsified by the live CLI within the hour. |

**AND THE PARK THAT IS NOT CLOSED, because closing it needs a decision nobody has made:** a
repairing ticket still gets **no cycle at all** while a run is in flight, and terminates at its
deadline (§7.2-D stop 18).

### 8.4 WHAT IS STILL NOT PROVEN — THE TWO SENTENCES THAT MATTER MOST

1. **NOTHING HERE HAS RUN DURING A REAL BUILD-TO-VERDICT. Not once.** The strongest thing this round
   can say is that a real ticket was filed, claimed, submitted, and reached `phase=spec` with a real
   Agent-SDK subprocess — and was then cancelled. **Whether the spec phase now CONVERGES is
   unmeasured, and it is the failure mode that killed three of the five runs on this machine.** Every
   claim about the manifest-shape and authoring-retry fixes still rests on tests and fixtures.
2. **THE REPAIR CYCLE HAS NEVER FIXED A REAL DEFECT IN PRODUCTION**, and there are three independent
   reasons, each of which alone is sufficient: **no driver is wired** into `index.ts` (~4 lines);
   **nothing authors a patch** (DESIGN §5.3 — the candidate diff is an INPUT); and **there is no
   sandbox**, so `tools/repair/prover.mjs`, which correctly refuses the working tree, is unreachable
   from the supervisor and a hand-written diff returns `NO_SANDBOX`. The cycle's honest answer today
   is `NO_PATCH_AUTHOR`, which the loop turns into `blocked` with that sentence — **an honest
   inconclusive, never a park.**
**Those two are the whole of it, and they are deliberately not padded** — everything else in this
round is either measured or is a named gap with a sentence, and putting a display gap third would
dilute the two the owner has to read. The display gap is real and is recorded twice, as §7.2-D stop
17 and as §8.6's instance twenty-four: **the morning readout cannot distinguish success from
exhaustion.** The instrument this round exists to sharpen is sharp about the run and blunt about the
queue.

**And three smaller things that are also not proven, stated so they are not read as proven:**
`stop (drain)` was not exercised live this round; **ageing against the wire's own `at` stamp is
declared, validated and rendered but NOT used by the classifier**, which still measures freshness
from when this client received the body (so a route answering instantly with an hour-old computation
still reads live — deliberately deferred, because ageing against `at` makes clock skew between two
machines a new false alarm); and the **40-minute** `stuck` threshold is still calibrated on one run.

### 8.5 THE MUTATION LEDGER — ATTRIBUTED PER MUTATION, BECAUSE "EVERY FIX WAS MUTATION-PROVED" IS A ROUND-LEVEL CLAIM

**The gate independently reproduced six of six** mutations it selected, each restored **byte-exactly
and proved so by sha256** — and the proof method matters: `git diff` is worthless for most of these
targets, because `dashboard/src/lib/supervisor.ts`, `render-guard.tsx`, `supervisor.ts` and
`tools/**` are **untracked**, so a diff shows nothing whether or not the file was restored.

| mutation | who reproduced it | the RED |
|---|---|---|
| the throw path stops counting an attempt (`supervisor.ts:989`) | **gate, independently** | `a failed submission did not count as an attempt / 0 !== 1`; 29 pass / 1 fail |
| the claim-time cap becomes `if (false)` (`:926`) | **gate, independently** | **THREE** tests red, not the one the lane reported, including *"a ticket at its cap was submitted anyway — this is the spend the cap exists to stop"* |
| `RenderGuard` loses `static getDerivedStateFromError` | **gate, independently** | the guard **named its own blindness first**: `ARM CHECK FAILED — THE RENDER GUARD CANNOT CATCH: … so React will not route a throw to it`, then both guard tests |
| the exhaustive validator returns `null` | **gate, independently** | six unit tests, and the arm printing `ARM CHECK FAILED — THE SUPERVISOR STRIP IS BLIND: malformed expected malformed, got threw: Cannot read properties of undefined (reading 'wired')` — **the brief's original crash message, produced on demand** |
| the loop-guard `OSCILLATION` arm deleted | **gate, independently** | the real oscillation stops escalating **while the SHRINK negative control stays green** |
| the arm between a malformed body and a blank `RootLayout` (`snapshot: readable` → `snapshot`) | **final check, independently** | exactly one test: `arm 2 published a body no consumer can dereference — this is the blank RootLayout`, `Expected: null / Received: {…}` |
| M1, M3-M5, M7 (unguarded read restored; validator asking a stale field name; the naive model-id guard; the dead attempts constant put back) | **the repair pass's own claims, RELAYED** | each carries a verbatim RED in its report; **none was re-run by the gate or the final check** |

**One mutation SURVIVED and it is recorded as data, not as a pass:** a first attempt at collapsing
two repair-router sentences copied a sentence but dropped its last clause, and the arm check —
which compares sentences for **equality** — correctly, and uselessly, stayed armed. **It catches a
copied sentence, not a nearly-copied one**, and that limit is now in the function's docblock.

### 8.6 THE INSTANCE COUNT — TWENTY-TWO CLOSED, TWENTY-THREE CLOSED, TWENTY-FOUR OPEN

The count is kept honestly because it is the only thing that has ever predicted this repository's
next defect.

- **TWENTY-TWO — CLOSED.** The three-state arm check with two arms (§8.1). Closed by a named state,
  an exhaustive validator, an error boundary and a fifth probe.
- **TWENTY-THREE — CLOSED IN THE SAME PASS THAT CREATED IT.** Reading the trail off
  `probe.unsourced` made the `<ol data-testid="supervisor-attempts">` branch, `formatClock`, the
  `key` prop and the *"rejected, fixed, rejected again"* highlight **reachable from live data for
  the first time — and nothing had ever rendered them.** A newly live rendering path with no probe
  is the defect. Closed by a browser test that serves the run's three real rejection sets with a
  **healthy 15 s quiet clock** so it cannot pass through the 40-minute ceiling, asserting the
  oscillating heading, three attempt `<li>` **as direct children** (a bare `li` locator resolves six,
  because problems nest — it would have passed for the wrong reason), and zero `pageerror`.
- **TWENTY-FOUR — OPEN.** `IDLE / idle, queue empty` for both a finished queue and a queue of
  blocked tickets (§7.2-D stop 17, §8.4 item 3). **A display that cannot distinguish success from
  exhaustion is the same defect wearing different clothes**, and it is the one the owner meets at
  breakfast rather than at 3am. **HALF CLOSED 2026-08-10 (repair-driver round) — §9.5's numbering
  note carries the update and adds TWENTY-FIVE and TWENTY-SIX.**

---

## 9. THE REPAIR-DRIVER ROUND — BUILT AND MEASURED 2026-08-10, AFTER §8

> **WHY THIS ROUND EXISTED, in the system's own words.** The boot line quoted at §7.2-A said:
> *"ARM CHECK: NO REPAIR DRIVER is wired. Every ticket that reaches 'repairing' terminates at
> 'blocked' with NO_REPAIR_DRIVER and the loop carries on to the next ticket."* `tools/repair`
> (16 files) and `tools/tier3` (9 files) existed and **no process invoked either**. A structural
> failure was classified correctly, filed with a sentence, terminated in one tick, and the loop
> moved on. Bounded and named — **not repaired.**
>
> **THE BINDING CONSTRAINT, and it shaped what can be claimed below.** A real run,
> `run-2026-08-10T13-11-12-836Z-54927ebc`, was live throughout on ports 4176/4319 with a real
> Agent-SDK subprocess. It was **unharmed and progressing** (`spec` → `build`; re-read read-only at
> the end of the round: `build`, `running`). Nothing bound those ports, nothing ran docker, nothing
> ran `npm run build` in `dashboard/server` or `bakeoff` (every compile went to a private sibling
> `dist-<lane>`), nothing opened `runs.db` for write, and no commit, push, amend or tag happened —
> **HEAD is still `70a91cf`.** The price is stated rather than hidden: **half the tree could not be
> measured.** §9.3 is that debt written down.
>
> **THE ROUND'S GATE DID NOT PASS.** One blocking finding is a policy question only the owner can
> settle (§9.4 item 1) and one is the unmeasured client half (§9.3).

### 9.1 WHAT IS WIRED — AND THE LIVE/SOURCE SPLIT, WHICH COMES FIRST

**THE RUNNING PROCESS TONIGHT DOES NOT HAVE ANY OF THIS.** The live server is
`node dist/index.js`; `dist/` was deliberately not rebuilt while a run was live.
`grep -c armRepairDriver dashboard/server/dist/index.js` → **0** (measured; `dist/index.js` mtime
Aug 10 15:10, PID 55866 still up). **Tonight's supervisor still prints `NO REPAIR DRIVER is wired`
and still has no `repair` dep.** Everything below is wired **in source** and observed from
`dist-repair` / `dist-gate`. It **arms at the next rebuild of `dashboard/server/dist`** — and that
rebuild is §9.4 item 2, not housekeeping. A reader must not infer that tonight has repair.

| what | where | what it does | how it is covered |
|---|---|---|---|
| **The boot wiring** | `index.ts:143,160,161,170` | `armRepairDriver` is **awaited before the loop is constructed** (with its own 30 s runner, so a wedged git cannot stop `server.listen`), and `repair` is passed **through a spread, only if the arm armed**. `repairArm` is passed unconditionally, so *"nobody wired one"* and *"one exists and we refused it"* stay different facts. `defectSignatureOf` is wired for the first time — before this, `last_defect_id` was permanently null, the per-signature budget keyed on `class:<class>`, and the `<signature>.diff` lookup could never hit. | Mutation: passing the driver unconditionally → `AssertionError: the driver is passed unconditionally: a blind driver would be wired anyway and the arm check would be decoration` |
| **The boot line, with four states** | `supervisor.ts:805-848` | unwired · **wired AND MEASURED** · **BLIND** (a driver exists and was refused, reasons printed) · **BLIND BY WIRING** (measured armed, then not passed — *"look at the `repair` dep in index.ts, not at tools/repair"*). The word MEASURED covers only the eight driven answers; the two bounds are relabelled **CONFIGURED, NOT OBSERVED**. | Four boots asserted mutually distinct. Mutations: `: true` for the measurement → the blind boot printed the healthy sentence; deleting the fourth branch → an armed-but-unpassed driver got the blind driver's explanation |
| **The driver's own arm check** | `supervisor-boot.ts#armRepairDriver` | Drives the **real** driver with 8 known cycle answers requiring 8 distinct codes, 8 distinct sentences and **exactly one `applied`**; then spawns `tools/repair/supervisor-cycle.mjs --armcheck` (9 routing inputs + the gate seam's 8 verdict records) and **reads its OUTPUT, not only its exit code** — five named arms: no `ARM CHECK: (armed\|BLIND)` line, the verdict line not last, exit code disagreeing with the printed word, no mention of the gate seam, silence. A missing `cyclePath` is its own sentence (*"nobody installed one, not we refused a blind one"*) and the cycle is not spawned. | Six-case test with a negative control; each sub-arm mutated in isolation, each with its own verbatim RED |
| **The gate decides, and only the gate** | `tools/repair/supervisor-gate.mjs` (new) | The **only place in the tree that writes a patch.** Reads the Tier 3 gate's **trail record** (not its stdout verdict line — the token is minted over fields only the trail carries), maps it to one of 8 codes and 3 intents, and refuses to apply anything whose intent is not APPLY. A caller wanting to apply on its own judgement must **forge an intent** — a visible source edit, not an omission. | 8 gate records driven through the real cycle against a throwaway git repo, asserting **the tree** and the ledger row, not the return value. Mutation replacing `decideApply` with `{apply:true}` → `2 of 8 gate records were read as APPLY; exactly one may be` |
| **Rollback without a human** | same file | The rollback record `{patchId, signature, appliedAt, root, sourceSha, gateTrail, applyToken, diff}` is written **before** `git apply` runs; a second revert is a **named** `REVERT_NOT_APPLIED`, never a silent second success; an `applied` answer naming no rollback path is downgraded to `inconclusive / APPLIED_WITHOUT_ROLLBACK_POINT`. The boot arm performs a real apply/revert/revert-again round trip in a throwaway repo. **New:** `--revert <rollbackPath>` exists as a CLI, so the 3 a.m. sentence names a command that runs. | Mutations: a no-op revert reporting success → `the revert reported success and the bytes did not come back 'new\n' !== 'old\n'`; `if (false)` on the rollback check → `+ 'applied' - 'inconclusive'`; `revertAt = -1` → the CLI printed an arm check and exited 0 instead of reverting |
| **Three bounds, all spent before the gate** | `supervisor-cycle.mjs`, `supervisor-boot.ts` | The ticket's own deadline forwarded as `--deadline`; attempts per **signature** (now reachable); the ruled-out ledger consulted before any gate run. Plus a spawn timeout with `timedOut` reported as a **separate field from `ok`** — the clock is read **before** the output, because a killed cycle's flushed stdout can be a complete-looking JSON line from an earlier stage. This matters because the driver is awaited **inside `tick()`** behind the re-entrancy flag: a hanging cycle would stop every later tick and the queue would die silently. | `if (false && result.timedOut)` → `+ 'GATE_APPLY' - 'REPAIR_CYCLE_TIMED_OUT'`, i.e. the flushed stdout of a killed cycle read as an applied patch; plus a real 60 s process against a 300 ms budget |
| **The anti-loop rule is comparison, not counting** | `supervisor-cycle.mjs` | `evaluateAttempts`/`shouldEscalate` run **before** any gate run and record an `ESCALATED` ledger row with **no fingerprint** — the escalation is about the SEQUENCE and must not rule out a diff nobody graded. The `a913c871` shape escalates as `ANTI_LOOP_NON_MONOTONE` at attempt **2**, 87 minutes earlier than the oscillation arm. | `if (false && shouldEscalate(loop))` → a non-convergent sequence spent a gate run **and got its patch applied**. Negative control: a **shrinking** sequence must reach the gate |
| **A parked patch is not blacklisted** | `supervisor-gate.mjs`, `supervisor-cycle.mjs` | PARK outcomes — and, after review, `GATE_APPLY_UNTOKENED` — write a ledger row with `proposalFingerprint: null`. Otherwise the pre-existing rule (*every non-ACCEPTED row carrying a fingerprint is ruled out*) would blacklist a docker-parked patch **for ever** on a machine that later has docker. | Mutation writing the fingerprint on a PARK → `+ '71f9f64b…' - null`. The untokened-APPLY case was shipped wrong and caught in review: one wrong field path in `tokenInputs` would otherwise have blacklisted **every gate-approved patch for ever** |
| **The morning readout** | `http.ts` (`GET /api/supervisor/tickets`), `supervisor.ts` client lib | Every ticket, its state, `attempt N of M`, its own `next_action`, run ids, `lastDefectId`, `patchId`, and an attachment block with three-valued `carriedIntoRun`; plus a response `probe` so an empty queue and a blind reader are different bodies. The strip gained a sixth liveness `blocked` that tells a FINISHED queue from an ALL-BLOCKED one. | Route + classifier measured and mutation-proved. **`supervisor-strip.tsx` has ZERO executed tests** — §9.3 |
| **The ticket carries the owner's attachments** | `http.ts`, `api-types.ts` | `references` / `documents` / `captureUrl` / `motionUrl` through the **same functions** `POST /api/runs` uses; the ticket key now folds the attached bytes (same brief + same bytes = 409; same brief + a **different** CV = a new ticket, because a 409 there would silently discard the corrected CV); capture and motion are read once at filing and **frozen into `ticket_text`**, so every attempt submits byte-identical text. | Baseline probe against the already-built `dist/`: the owner's real ticket (573,440-byte image + 81,920-byte PDF) was **accepted and both attachments silently dropped**. 8 refusal cases plus a positive control; digests read **back off disk** |

### 9.2 WHAT EACH GATE VERDICT NOW DOES TO A TICKET

**MOST REPAIRING TICKETS NEVER REACH A GATE VERDICT, AND THAT IS BY DESIGN.** The cycle's arms are
spent in order and each one is spent **before** the gate: **window → anti-loop → no-patch-author →
ruled-out ledger → gate.** On today's tree the answer is almost always the third
(`NO_PATCH_AUTHOR`), and on a busy night it is none of them, because the repair step **declines
entirely while a run is in flight** and the ticket reaches its 30-minute deadline with
`REPAIR_DEADLINE_EXCEEDED` without a cycle ever running (§7.2-D stop 18).

| the gate's trail record | cycle code | driver kind | ticket goes to | ruled-out ledger |
|---|---|---|---|---|
| `APPLY` **with a token that re-mints** | `GATE_APPLY` | `applied` | **`queued`** — re-run, `patch_id` set, rollback path in the sentence | row `ACCEPTED`, **fingerprint recorded** |
| `APPLY` **with no / a wrong token** | `GATE_APPLY_UNTOKENED` | `refused` | `blocked` | row written, **fingerprint `null`** — the bar said yes and the plumbing disagreed, so nothing is blacklisted |
| `SELF-PROPOSE` | `GATE_SELF_PROPOSE` | `inconclusive` | `blocked` | row written, **fingerprint `null`** |
| `REFUSE-BLIND` (an arm did not report) | `GATE_BLIND` | `inconclusive` | `blocked` | row written, **fingerprint `null`** — *a gate that cannot see does not become a gate that agrees* |
| `REFUSE` (the known-bad set did not hold) | `GATE_REFUSE` | `refused` | `blocked` | row `REFUSED`, **fingerprint recorded** — this patch is ruled out |
| `REFUSED` (the diff touches the admission set) | `GATE_REFUSED_ADMISSION` | `refused` | `blocked` | row `REFUSED`, **fingerprint recorded** |
| a verdict word this build does not know | `GATE_VERDICT_UNRECOGNISED_<word>` | `inconclusive` | `blocked` | row written, **fingerprint `null`** |
| **no trail record at all** | `NO_GATE_RECORD` | `inconclusive` | `blocked` | row written, **fingerprint `null`** |

**THE APPLY ROW CARRIES THREE QUALIFICATIONS AND EACH IS A REAL COST.** (1) An `applied` answer
that names no rollback path is **downgraded** to `inconclusive` — a run on a tree that cannot be
restored is worse than a failure that stopped. (2) `applyGatedPatch` runs `git apply` against
**`REPO_ROOT`, the owner's real working tree**, unattended, on the 30 s tick; the trigger is a diff
at `dashboard/data/repair-proposals/<signature>.diff` (§9.4 item 3 is who may write there).
(3) **Nothing rebuilds afterwards**, so the re-queued run executes byte-identical behaviour —
§7.2-D stop 21.

The three intents were chosen so the driver can never reach the gate's effect by another path:
`APPLY → applied`, `REFUSE → refused`, `PARK → inconclusive`. **No driver-side veto was added on
purpose:** a driver that refuses an APPLY the gate passed is the same violation mirrored.

### 9.3 THE PRE-COMMIT CHECKLIST — NOTHING FROM THIS ROUND MAY BE COMMITTED ON THE STRENGTH OF IT

**This round could not measure half the tree.** These are not suggestions; each names the number a
re-run must reproduce, and each is labelled **baseline** (previously measured here) or **claim**
(a lane's self-report, not yet independent).

0. **DECIDE ON BOTH UNTRACKED FILES EXPLICITLY, BEFORE `git add` OF ANY KIND.** `git status` shows
   two: **`tools/repair/supervisor-gate.mjs`** — the only file in the tree that writes a patch — and
   **`dashboard/tests/no-server.config.ts`**. **A commit made with `git add -u` lands the driver
   wiring and the new boot line and leaves the gate seam behind.** The arm check would catch that
   (BLIND, the fail-safe direction, `repair` not passed), which is the right failure and still a
   state nobody should reach by accident. Name both paths, decide both.
1. **Review or discard `dashboard/tests/no-server.config.ts`.** It is **untracked** and unreviewed,
   and it is the harness Lane 3's client numbers came through. Track it or delete it — do not
   commit on its output.
2. **CLIENT UNIT.** Baseline **199** (measured here 2026-08-10, zero removals). Lane 3 claims
   **224** through the untracked config: that is a **claim**, not a baseline.
3. **CLIENT BROWSER, the full suite.** Baseline **273 passed / 1 skipped**, twice, identical leaf
   sets, 33 files — **as measured and recorded in §7.3.** **Reconcile the tail digit on the re-run
   rather than raising an alarm on it:** this round's own reports quote the same baseline as
   *"273 pass / 1 fail"* and as *"273/1"*. One skipped and one failing are not the same tree, and
   nobody has re-measured which it is. Nine specs in `supervisor-strip.browser.spec.ts` were **authored and never
   executed**, and the pre-existing *"all five states"* describe was extended to six. **A first
   failure there may be an authoring error in the spec rather than a product defect — check the
   spec before filing a bug**, and do not report the suite as broken without that check.
4. **`prose-guard.browser.spec.ts`** specifically. Neither run nor modified; the risk was reasoned
   *by construction* (the new prose lives in the detail pane, no new `title` on the 30 px row) and
   reasoning is not the measurement this file exists to be.
5. **THEN MUTATE `dashboard/src/components/supervisor-strip.tsx`.** `censusCell`'s four branches,
   the failed-row list, the absent-column paragraph and `data-cycle` have **zero executed tests**
   and therefore zero mutation coverage. A mutation with no runnable check is a code review.
6. **A DOCKER-ARMED TIER 3 GATE RUN, end to end, exercising `spawnGate`.** Every gate test injects
   the `gate` seam, so the production spawn **plus the trail read** has zero coverage.
   `tools/tier3/gate.mjs` was never executed this round in tests or otherwise. Run it once, watched,
   against an **isolated copy** of the repository (`prover.mjs#assertSandbox` throws for any path
   inside this one, by design) and keep the trail.
7. **RE-RUN THE HALVES THAT WERE MEASURED, from a private outDir, and match them:** server
   **1972 tests / 1969 pass / 0 fail / 3 skipped** (from `dist-gate`; reference was 1961/1958/0/3,
   so +11 and +11), tools **115 / 115 / 0** (re-measured by the recorder today, exit 0; it was 113
   before the repair pass added two), bakeoff **164 / 164**, `tsc --noEmit` clean in all three
   packages.
8. **`git diff dashboard/tsconfig.json` must be EMPTY.** `next build` appends
   `.next/types/**/*.ts` globs to a tracked file and prints only *"include was updated to add…"* —
   §7.2-D stop 19. A commit-stopper, observed twice.
9. **Sweep the sibling outDirs.** `dashboard/server` now carries **42** `dist-*` directories (counted today) from
   previous rounds. Gitignored and harmless — except that a build from a **mutated** tree in one of
   them is live ammunition for anyone who runs `node --test dist-<something>`.
10. **And the two items that are decisions, not tests: §9.4 items 1 and 2 must be settled before
    `dashboard/server/dist` is rebuilt**, because the rebuild is what arms the APPLY path.

### 9.4 WHAT STILL NEEDS THE OWNER — IN FULL

1. **THE ITEM-6 ARBITRATION: may a gate whose container arms cannot run say `APPLY`?** Measured
   answer today: **yes** (§7.2-D stop 20). This is a **decision, not a bug fix**, because
   `tools/tier3/gate.test.mjs:553` — *"an editable-only patch with full evidence self-applies and
   gets a token"* — **pins** the current behaviour on this dockerless machine and is green (verified
   by the recorder in the 115). Its docblock names mutation M11 and argues *"a gate that can never
   pass is not a gate"*, and `gate.mjs:264-267` states the intent that the three container proofs
   must **not** be required on the editable arm. Against that: the EDITABLE package holds the
   orchestrator, the recovery classifier and the gate's own caller, so **grader softening is
   reachable one level up from the closure** — and `noOpAblation`, the sole proof consulted on that
   arm, has **zero producers** anywhere in `tools/` or `dashboard/server/src` outside
   `gate.test.mjs` (`prover.mjs#proveRepair` emits only `{redBefore, greenAfter, mutationRed}`), so
   it can only ever arrive **hand-typed** in a `<signature>.evidence.json` sidecar. The gate-side
   prescription if you close it: one branch in `decide()` reading
   `aggregate.verdict === "PASS-WITH-UNARMED"` (or folding `arm.unarmed.length > 0` into `arm.ok`'s
   consumer) plus an **executed** proof for the editable arm. **Do not close it with a driver-side
   veto, and do not edit the pinned test unilaterally.**
2. **KEEP `dashboard/data/repair-proposals/` EMPTY AND DO NOT REBUILD `dashboard/server/dist` UNTIL
   ITEM 1 LANDS.** Those two facts are the only reason tonight is safe, and both were re-measured:
   the directory does not exist, and the live `dist/index.js` contains no `armRepairDriver`. Either
   one changing arms the APPLY path.
3. **WHO MAY WRITE INTO `dashboard/data/repair-proposals/`.** The supervised Agent-SDK subprocess
   has write access to this repository, so **as built, the graded agent can author both its own
   patch and its own evidence bundle** and have it applied. If that is not intended, the directory
   must move outside the agent's reach, or the proposal needs a provenance the agent cannot mint,
   **before** autonomous repair is switched on.
4. **WHO REBUILDS `dist` AND RESTARTS THE SERVER AFTER AN APPLIED PATCH — and whether the ticket may
   be re-queued before that happens.** As built, an applied patch cannot affect the attempt it was
   applied for, and nothing enforces the `distFreshness` the gate already computes and records
   (stop 21). Both prescriptions are yours to pick: the cycle rebuilds the affected package
   (which means the unattended loop runs `npm run build` over the tree a live process resolves
   against), or `decide()` refuses to mint a token for a patch whose effect cannot reach the running
   system (which on this machine refuses every patch while a run is live).
5. **THE APPLY TOKEN'S PROVENANCE.** It is an **unkeyed** sha256 over inputs read out of the record
   it validates (stop 24). Closing it needs a key the gate holds, or binding the record to the
   append-only trail the gate wrote — **not** more guards over self-supplied fields. The docblock
   now states the token's true size; the mechanism is unchanged.
6. **WRITER/READER SIGNATURE CONVERGENCE**, before any proposal is placed on disk. Not reachable
   today (both sides read the `signature` field verbatim — verified), but two formulas for one
   question remain in `signature.mjs:88-102`, and the day a lookup computes its own digest the
   symptom is `NO_PATCH_AUTHOR` — **indistinguishable from "no proposal exists"**.
7. **THE TWO UNENFORCEABLE CHECKS IN `tools/tier3/proposal.mjs`** — `NO_INDEPENDENT_CHECK` and
   `SCOPE_UNIMPLICATED_FILE`. `runGate` is given neither a defect record nor an executed replay, and
   `spawnGate` does not supply them, so **an inside-closure repair clears a LOWER bar than
   `cycle.mjs` would impose.** Whether the gate grows those inputs is your call.
8. **THE END-TO-END REPAIR THAT HAS NEVER HAPPENED ONCE**, watched, against an isolated copy, before
   any of this runs unattended — and with it the never-executed `spawnGate` seam.
9. **THE FULL CLIENT SUITE RUN (§9.3), including reviewing or discarding the untracked
   `no-server.config.ts`, before anything from this round is committed.**

### 9.5 WHAT REMAINS UNPROVEN

**THE TWO SENTENCES THAT MATTER MOST, and neither moved this round:**

1. **THE REPAIR CYCLE HAS NEVER FIXED A REAL DEFECT — not once, in production or anywhere else.**
   No `defect → diff → gate → APPLY → re-run` has ever happened. What was measured is the
   **routing**: a real defect record written by the real writer, driven through the real driver
   against a snapshot of the live database, terminating deterministically at
   `REPAIR_INCONCLUSIVE / NO_PATCH_AUTHOR` with an actionable sentence. **That is a repair machine
   that has never repaired anything**, and the reason is stated rather than implied: nothing authors
   a patch (§5.3 of DESIGN records the patch author as deliberately not built), the evidence bundle
   is read from a hand-authored sidecar rather than synthesised by a prover, and
   `tools/repair/cycle.mjs#runRepairCycle` — the prover-backed cycle the design's own step list
   names — **is still invoked by nothing.**
2. **THE CONTAINER ARMS OF THE TIER 3 GATE HAVE NEVER RUN DURING A REPAIR.** A6 (re-score) and A7
   (calibration) are registered **UNARMED**, docker was not invoked once this round, and
   `containerExecuted` was **0** in the one real `runGate()` measurement taken. Every gate test
   injects the seam. So the gate's verdict on any repair to date has been reached with **five of
   seven arms** — and, per stop 20, that does not degrade it to self-proposing on the editable arm.

**AND THE REST, so nothing reads as resolved:**

- **`spawnGate` has never executed** — the production spawn plus trail read has zero coverage. Treat
  the 115 green tools tests as covering the **router**, not the plumbing.
- **`REPAIR_WINDOW_CLOSED` is nearly unreachable in production.** The router already blocks a ticket
  whose deadline has passed, so the cycle normally sees an open window; the arm exists for a
  hand-invoked cycle. It is proved end to end through the real spawn, and that is all.
- **The gate seam's arm check cannot see a wrong field path.** It mints and verifies through the
  same `tokenInputs`, so it is self-consistent by construction: a mutation moving `frozen.digest`
  to `frozenDigest` left it **ARMED at exit 0** while production would have answered
  `GATE_APPLY_UNTOKENED` for every approved patch. A source-pinning regex test is the only cover,
  and a refactor changing both sides consistently would pass it.
- **The grandchild reaping is not proved** — only an inequality between two constants is (stop 23).
- **`revertGatedPatch` has no production caller** (stop 22). Nothing reverts on its own.
- **The strip's rendering is unexecuted** (stop 17, §9.3 items 3-5), and with it the colour claims,
  the six-state table and the census panel.
- **`stop (drain)` is still not exercised** — unchanged from §7.2-C.
- **The client/server census pair has never been exercised together.** There is no golden fixture
  for `GET /api/supervisor/tickets` the way `tests/fixtures/supervisor-wire.golden.json` exists for
  `/api/supervisor`; the drift detector is a **hand-transcribed row**, which the api-types docblock
  itself calls the weaker form. Generate the golden from the server's own composer and assert it
  from both ends.
- **The client validator is deliberately LOOSER than the wire.** Every census column is
  `?: T | null`, so a server that stops sending one is reported **on screen** in
  `census.absentFields` rather than reddening a test. If you want a dropped column to be a red test,
  the golden fixture above is the mechanism — not a tighter validator.

> **THE MUTATION LEDGER, ATTRIBUTED — because "the round was mutation-proved" is a round-level claim
> this project does not accept.** The verifier **independently reproduced three** with byte-exact
> restoration proved by **per-file sha256** (`git diff` is worthless here: much of the mutated
> surface is untracked, so a clean diff proves nothing): Lane 2's `attachmentsCarriedIntoRun` digest
> comparison (**the fix took** — the one mutation in the whole report that had survived first pass),
> Lane 1's token field path (documented to leave the arm check ARMED at exit 0 — **reproduced
> exactly**, and the suite caught it with 5 red tests, not the 1 predicted: **under**-claimed), and
> the cycle-timeout guard (2 red, including the arm check going blind about itself). The remainder
> are lane self-reports with verbatim RED quoted but not independently re-driven.
>
> **AND ONE MUTATION SURVIVED, IN THE REPAIR PASS'S OWN PATCH, and it is reported rather than
> patched quietly:** a `try/catch` added around the driver's eight arm probes was deleted and
> **every test stayed green (18/18)**. Diagnosis, not a re-patch: the probe loop overrides `run`
> with fixed answers, so no injected seam can make it throw and the guard was **unreachable**. It
> was **deleted**, the docblock records why, and the replacement guard — around the real spawn — has
> its own RED (`Error: spawn EAGAIN … at armRepairDriver`, i.e. the exception escaping the boot path
> exactly as it did in production).

> **THE INSTANCE COUNT, AND A NUMBERING COLLISION RESOLVED SO THE NEXT ROUND DOES NOT INHERIT TWO
> OF THEM.** §8.6 already used **22, 23 and 24**. This round's own reports each nominated a fresh
> "twenty-three" and a fresh "twenty-four" for two different defects; both numbers were taken.
> The catalogue as it now stands:
> - **TWENTY-FOUR — HALF CLOSED.** `IDLE / idle, queue empty` for both a finished and an
>   all-blocked queue. The sixth liveness and the census route exist in source; **the rendering has
>   never been executed**, so the display half of the defect is not yet measured shut.
> - **TWENTY-FIVE — CLOSED IN THE PASS THAT CREATED IT** (the repair pass called this
>   "twenty-three"). A guard whose mutation left every test green because **no injected seam could
>   reach it.** Closed by deleting the unreachable guard rather than keeping it as decoration.
> - **TWENTY-SIX — OPEN** (the reviewer called this "twenty-three", the repair pass's carry-forward
>   called it "twenty-four"). **`REPAIR_APPLIED` is success-shaped with no measurable effect:**
>   `git apply` writes to `src`, nothing rebuilds, the live process and the scorer resolve compiled
>   output, so the success path is **indistinguishable from doing nothing** — while
>   `distFreshness` is computed, recorded in the trail, and never read. Whichever fix the owner
>   picks (§9.4 item 4), the arm check needs a probe that tells *"applied and the behaviour changed"*
>   from *"applied and nothing changed"* — one accepting check re-run against the **built artefact**,
>   not the source.

### 9.6 WHERE THIS ROUND MADE THE RECORD STALE — AND WHERE IT IS CORRECTED

Every correction is **in place**, dated, with the superseded text left visible. This is the index:

| what went stale | corrected at |
|---|---|
| the boot block, and its `grep … → 0 hits` for `repair` in `index.ts` (**re-measured at 11 hits**) | §7.2-A, dated block after the arm-check listing |
| the same `0 hits` grep, repeated as evidence | §7.2-D stop 2 |
| `repairing` terminates at `NO_REPAIR_DRIVER` | §7.2-C2 item 3 and §7.2-D stop 1 — in source it is now `NO_PATCH_AUTHOR`; **live it is still `NO_REPAIR_DRIVER`** |
| *"`GET /api/supervisor/tickets` is a measured 404"* | §7.2-C2 item 5 and §7.2-D stop 17 |
| the ticket route's refusal list, and the ticket key | §7.2-A, the `EXTENDED` block (adds `400 body_too_large`, the extended 409, four request fields, and the GET as the morning readout) |
| *"FIVE STATES … THE ARM LINE NOW READS `5 distinct`"* | §7.2-B — six in source, five measured, rendering unverified |
| *"the ruled-out ledger is addressed by a digest the defect writer does not produce"* | §7.2-D stop 11 — closed on the live path, with the two remaining formulas named |
| *"every inside-closure patch parks … correct behaviour"* read as protection | §7.2-D stop 12 — true, and its converse (stop 20) is not |
| DESIGN §5.2's *"steps 3-7 still cannot run … `index.ts` passes no `repair` dep"* | DESIGN §5.2, dated block |
| DESIGN §6.6's *"the apply step treats absence exactly like failure"* and *"fail-closed … implemented and mutation-proved"* | DESIGN §6.6, dated block — **false for A6/A7** |
| DESIGN §7.6's *"With no driver wired, which is today's state"* | DESIGN §7.6, dated block |

---

## APPENDIX A — `rescore.mjs`, verbatim

> **ADDED 2026-08-09.** A critic's blocking finding: the single most consequential
> measurement in this document — the re-score that grounds §1 point 3, all of §3-B1, the
> `d19e7e8` correction and the run-1 provenance check in §1 — carried a command the owner
> **cannot run**. `find . -name '*rescore*' -not -path '*/node_modules/*'` inside the repo
> returns **nothing**; the script existed only in a session scratchpad that is reaped.
> This pass was permitted to write one file, so the script is reproduced here in full
> rather than committed. **To use it:**
>
> ```
> # 1. the script imports bakeoff/dist/{gate,campaign,scorer}.js — build them first,
> #    or it fails with a bare module-resolution error rather than a useful one:
> cd bakeoff && npm run build
> # 2. then, from the repo root:
> node <path>/rescore.mjs --run dashboard/runs/<runId>/results/run.json \
>      --out /private/tmp/claude-501/.../scratch --image bakeoff-scorer:1
> ```
>
> It refuses by construction to write outside a `/private/tmp/claude-501/` path (line 34),
> which is why it is safe to keep. Note the `REPO` constant at line 16 is absolute and
> will need editing if the checkout moves.
>
> The same defect at lower stakes applies to every browser number in §3-C and the rAF
> sampling in §2.2: `probe1.mjs`…`probe8.mjs`, `live-canvas.spec.ts` and `live.config.ts`
> are scratchpad-only too. Those are **not** reproduced here (they are long and they bind
> host ports); the numbers they produced are labelled **UNMEASURED-BY-THE-READER** in
> §2.2's correction and in §5-17.

```javascript
/**
 * rescore.mjs — MEASUREMENT ONLY. Re-open the sealed gate on an existing
 * artefact, exactly the way dashboard/server/src/orchestrator.ts:5061 does:
 *
 *     await (this.#deps.makeGate ?? createGate)(gateEnv(this.#deps.paths, env))
 *
 * Nothing is written outside RESULTS_DIR (a scratchpad path).
 *
 * usage: node rescore.mjs --run <run.json> --out <resultsDir>
 *                         [--image <ref>] [--artifact <dir>] [--run-id <id>]
 *                         [--keep-staged]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/Users/kamilborzecki/Projects/coding-agent";
const ACCEPTANCE = `${REPO}/dashboard/acceptance`;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
}
const has = (name) => process.argv.includes(`--${name}`);

const runJsonPath = resolve(arg("run"));
const resultsDir = resolve(arg("out"));
const image = arg("image", "bakeoff-scorer:1");
const artifactOverride = arg("artifact");
const runIdOverride = arg("run-id");

if (!resultsDir.startsWith("/private/tmp/claude-501/")) {
  throw new Error(`refusing to write outside the scratchpad: ${resultsDir}`);
}
mkdirSync(resultsDir, { recursive: true });

const { createGate } = await import(`${REPO}/bakeoff/dist/gate.js`);
const { readFrozenSuite } = await import(`${REPO}/bakeoff/dist/campaign.js`);
const { SealedScorerGate, defaultScorerGateOptions } = await import(`${REPO}/bakeoff/dist/scorer.js`);

const run = JSON.parse(readFileSync(runJsonPath, "utf8"));
if (artifactOverride) run.artifactPath = resolve(artifactOverride);
if (runIdOverride) run.runId = runIdOverride;

const suite = readFrozenSuite(ACCEPTANCE, run.ticketId);
if (suite === null) throw new Error(`no frozen suite for ticket ${run.ticketId} under ${ACCEPTANCE}`);

// EXACTLY dashboard gateEnv(): allowlist + two path overrides, nothing else.
const env = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  BAKEOFF_RESULTS_DIR: resultsDir,
  BAKEOFF_ACCEPTANCE_ROOT: ACCEPTANCE,
  BAKEOFF_SCORER_IMAGE: image,
};

console.log(`# rescore  runId=${run.runId}`);
console.log(`# artefact=${run.artifactPath}`);
console.log(`# image=${image}  results=${resultsDir}  keepStaged=${has("keep-staged")}`);
console.log(`# suite.sha256=${suite.sha256}  run.heldConstants.acceptanceSuiteSha256=${run.heldConstants.acceptanceSuiteSha256}`);

let gate;
if (has("keep-staged")) {
  // Diagnostic arm only: identical options to createGate() except the staged
  // tree survives so it can be inspected. Deviation is printed, not hidden.
  const base = defaultScorerGateOptions(resultsDir, ACCEPTANCE, image);
  gate = await SealedScorerGate.create(
    { ...base, stagingRoot: `${resultsDir}/staging`, keepStagedArtifact: true },
    env,
  );
  console.log("# DEVIATION: keepStagedArtifact=true (createGate() default is false)");
} else {
  gate = await createGate(env);
}
console.log(`# gate.scorerImageDigest=${gate.scorerImageDigest}`);

const t0 = Date.now();
let score;
try {
  score = await gate.score(run, suite);
} catch (error) {
  console.log(`# score() THREW after ${Date.now() - t0} ms`);
  console.log(String(error && error.stack ? error.stack : error));
  process.exitCode = 3;
  throw error;
}
console.log(`# score() returned after ${Date.now() - t0} ms`);
console.log(`heldOutPass=${score.heldOutPass}  falseFinish=${score.falseFinish}  agentDeclaredDone=${score.agentDeclaredDone}`);
console.log(`scorerImageDigest=${score.scorerImageDigest}`);
console.log(`suiteExecution=${JSON.stringify(score.suiteExecution)}`);
console.log(`protectedPathViolations=${JSON.stringify(score.protectedPathViolations)}`);
console.log("--- criteriaResults ---");
for (const c of score.criteriaResults) {
  const detail = c.detail === null || c.detail === undefined ? "" : ` :: ${String(c.detail).replace(/\s+/g, " ").slice(0, 400)}`;
  console.log(`${c.passed ? "PASS" : "FAIL"}  ${c.tier.padEnd(10)} ${c.criterionId}${detail}`);
}
writeFileSync(`${resultsDir}/rescore-summary.json`, JSON.stringify(score, null, 1));
console.log(`# wrote ${resultsDir}/rescore-summary.json`);
```

---

## APPENDIX B — INDEPENDENT SPOT-CHECK OF THIS DOCUMENT, 2026-08-09

> **ADDED 2026-08-09, at a critic's request, so the next reader knows which half of this
> report is arithmetic and which half is interpretation.**

A critic independently re-ran **23 of this document's quantitative claims. 22 reproduced
exactly.** The one that did not is the three orphan `node -e` pids, now deleted from §6.

**Reproduced:** `cd dashboard/server && npm run clean && npm test` → tests 1835 / pass
1830 / fail 1 / skipped 3 / todo 1, 73749 ms, EXIT=1, the single failure being *"the three
runs already on disk still read, still render, and still name their suites"* — identical
to §3-B6. **Do not take that command as endorsed**: `npm run clean` deletes the shared
`dashboard/server/dist/` that concurrent agents depend on. The non-destructive equivalent
is in §1's test-baseline correction —
`npx tsc -p tsconfig.json --outDir dist-<yourlabel> && node --test 'dist-<yourlabel>/**/*.test.js'`. `cd bakeoff && npm run clean && npm test` → 121/121/0. Plus: every `runs.db` row
value; the four retry-after seconds and their hour conversions; phases-per-run from the
event stream; `seat_spend`/`metered_spend` = 0/0; `limited:true` events = 0; the 104 and 75
commit counts; the commit-type histogram (29/23/21/15/6/5/4/1); 104/104 test-file parity;
absent `.github/workflows`; `api-types.ts:100`; `plan-record.ts:111-112`; `recovery.ts:227`;
`orchestrator.ts:309`; `contract-parity.test.ts:1367`; `use-run-graph.ts:225`; the B4 grep
triple (0 / 0 / 4); `scorer-container.ts:1278-1302`; `contracts.ts:1433-1441`;
`next.config.ts` + the routes-manifest redirect; the root-absolute hrefs; both docker
digests; and `scoredAt 2026-08-02T17:44:12.118Z`.

**Not re-measured by the critic, with reason:** every §3-C browser number and the §2.2 rAF
numbers — running Playwright binds host ports, which another agent owned this session.
They were instead cross-checked against this session's own `facts-*.json` artefacts and
**match to the digit** (`facts-live.json`: zoom 0.566502, offscreen 2, sheet-closed
0.621387, animationsTotal 20-vs-0; `facts-probe3.json`: frames 73, distinctOffsets 73,
animCurrentTime 683→1283, playState running; `facts-big-1440x900.json`: 0.363924).

**Read this as the boundary line.** The arithmetic in this document is reliable — it was
re-run. **Every correction block dated 2026-08-09 is in the other half: interpretation,
categorisation, and direction of harm.** That is where every one of the critics'
substantive findings landed — not one of them was an arithmetic error — and it is where a
future reader should aim their scepticism.

---

## Appendix R — the repair pass, 2026-08-09 (added after the four lanes, the verifier and two reviewers)

Everything in this appendix is either a correction to something above or a step the
recipe above does not contain. Nothing here is a plan; it all happened.

### R1. THE BUILD STEP THE RECIPE DOES NOT HAVE, and it silently disables four fixes

`dashboard/.next` is gitignored, so a stale client bundle produces **no diff line** and
nothing above tells the owner to refresh it. It was last built mid-round, before eight
`dashboard/src` files changed — including `lib/use-run-stream.ts`, which carries B7's
blank-run-page fix (a race reproduced 5-of-5 under mutation). Starting with `npm start`
against that bundle means the run page can go blank at hour 0 and stay blank.

**Run all three builds, in this order, before `npm start`:**

```
cd bakeoff          && npm run build     # server imports MAX_STREAMABLE_OUTPUT_TOKENS from bakeoff/dist
cd ../dashboard/server && npm run build
cd ..               && npm run build     # this is the one the recipe omits
```

**Confirm the rebuild took**, mechanically rather than by eye:

```
find dashboard/src -newer dashboard/.next -type f | wc -l     # must be 0
node -e "console.log(JSON.stringify(require('./dashboard/.next/routes-manifest.json').redirects))"
                                                              # must be []
```

Measured after this pass: **0 stale files**, `redirects []`, rewrite
`/api/:path(.*)` → `http://127.0.0.1:4176/api/:path`. The visual equivalent, if you
want it, is a run page with every rail panel shut: the run chip must be at the canvas's
top-left.

**On the server build, stated as the equivalence it is:** `dashboard/server`'s `build`
script is plain `tsc -p tsconfig.json`. This pass compiled those exact sources with that
exact compiler to a private `--outDir` and got exit 0 with no diagnostics, then removed
the directory. `dashboard/server/dist` itself was deliberately left untouched, so the
step above is proven by equivalence and not by having been run in place.

### R2. STARTING AN UNATTENDED RUN — the dashboard radio now does what it says

Earlier guidance in this round said to submit with `curl` and OMIT `designLock`,
because the radio labelled "Let ui-designer pick" still produced `interactive = 1`.
**That defect is fixed** (`http.ts#designLockInteractive`): an explicit `designLock:
"auto"` is now an opt-out and is answered before the `Referer` rule.

- **From the dashboard:** pick **"Let ui-designer pick"**. The plan phase SKIPS (no
  seat call at all) and the mockup auto-selects.
- **From `curl`:** either omit the field or state `"auto"` — both now give the same
  answer.
- Picking "Ask me which to build", or submitting from the page while stating nothing,
  still asks. That is unchanged and is asserted in both directions.

Half of the original report was wrong and is corrected here for the record: the
**design lock never parked** on `"auto"`. `designLockPolicy` compares `requested ===
"auto"` before it consults `interactive` (`design-lock.ts:48-51`), so the 30-minute
design-lock park was never reachable from that radio. The cost was the PLAN phase
alone — a seat call plus up to `DEFAULT_PLAN_TIMEOUT_MIN` = 20 minutes, not ~50.

**The watch-list tell is unchanged:** `plan.json` recording a PARK rather than a SKIP.

One consequence worth knowing because it runs unattended: `cron/cron-tick.ts:336` has
always stated `designLock: "auto"` explicitly, and its own comment gave the reason — *"a
future edit to the server's interactive classifier would silently flip cron to ask"*.
That field is now load-bearing for the first time and it points the right way. The
comment beside it is stale in a second respect (*"the route validates this field and
DISCARDS it"* — `createRun` stores it now) and was left alone as another lane's file.

### R3. IF THE SEALED GATE REFUSES — what the log now says, and why it changed

The refusal used to end *"Resume this run to let the builder carry on"*. The same block
finishes the run `failed`, which is terminal, and `resume()` refuses a terminal row —
`409 not_resumable`. The sentence was an instruction the server rejects. It now reads:

> …This run is finished and cannot be resumed — the tree it built is still on disk in
> its workspace. Read the build log for why the builder stopped, then start a new run
> from the same ticket.

Pinned by a test that asserts the state and the sentence **together**, so whichever of
the two moves next, it fails. The park-instead-of-finish alternative was deliberately
NOT taken this round: it changes `isTerminal` on a path that has never run unattended.

Also corrected, in the guard's own docblock: it claimed to catch "the run killed
mid-build". It cannot — a killed build returns `{ kind: "cancelled" }` and is handled at
`orchestrator.ts:2129` by `#aborted`, before the guard; a refusal returns at `:2147`,
also before it. The only shape that reaches the guard is **a builder that RETURNED
without writing its self-report** (turn/budget exhaustion, or a crash with no signal).
That is a tree that has stopped, not one still being written — a materially weaker
reason to withhold a verdict, and the one the trade should be judged on.

### R4. THE BAKEOFF E2E HARNESS IS REAL AND IS NOT IN ANY SUITE FIGURE

`bakeoff/package.json`'s `npm test` globs `dist/*.test.js`; the three harnesses are
`test/*.mjs` and are in no glob, so the 121/121 bakeoff figure **excludes them**. Adding
a `test:e2e` script would move the scorer image digest (`package.json` is COPYed in the
Dockerfile's stage 1) and was correctly declined. Until a round budgets a rebuild and a
re-calibration, run it by hand:

```
cd bakeoff && npm run build && node test/quality-gating.e2e.mjs --root <a scratch dir>
```

Measured this round: **31/31 check(s) passed, exit 0** (up from the 0/4 recorded above).
It starts four sealed `--network=none` scorer containers; the image digest was
re-inspected immediately afterwards and was unchanged at `sha256:b7a9fd0a0f58…`.
`runner.e2e.mjs` and `scorer-modes.e2e.mjs` are unreachable the same way.

### R5. AN OLD GUARD THAT COULD NOT FAIL, AND HOW IT WAS CAUGHT

`rail.browser.spec.ts`'s "the run chip and the run-detail sheet are gone" asserted two
strings that no longer exist anywhere in `dashboard/src` — `role="tablist"` has **never**
been rendered by this product, and the chip's button says `overview`. It was green
through the exact mutation its own docblock claimed to have reproduced. Rewritten to the
rule that is actually true and actually breakable (the chip and the Overview panel are
complements, both directions), and proved by three product mutations. **In all three the
old version stayed green**, run side by side from a temporary spec file — that side-by-
side is the technique worth reusing whenever a guard is suspected of being dead.

> **CORRECTED 2026-08-09 (second pass) — THE REWRITE WAS ITSELF VACUOUS, IN A SECOND WAY,
> AND IT TOOK A REVIEWER TO SEE IT.** The three mutation claims above are real and were
> independently reproduced. But the replacement was titled *"…and neither one can vanish"*
> over a docblock claiming *"exactly one of the two surfaces is on screen at a time"*, and
> the mount condition is `openPanel === null && notices === undefined`
> (`runs/[runId]/page.tsx`). `notices` is non-`undefined` on **four** conditions —
> `preBuildOpen`, `actionError !== null`, `run.status === "rate_limited"`, and the
> awaiting-input branch — and in every one of them with the panel shut **neither** surface is
> on screen. A three-state rule asserted as a two-state one, on a fixture that never reaches
> the third state. All three mutations only move `hudMounted` between true and false, so the
> false half of the docblock was **untested by construction**.
>
> **And the third state hid a product defect of exactly the kind the chip exists to close.**
> `page.tsx`'s own comment justified suppressing the chip with *"AwaitingInputNotice and
> RateLimitNotice carry their own Cancel and Resume"* — `RateLimitNotice` took `{ run,
> onResume, busy }` and had **no Cancel**; the action-error path was a bare `<p>`;
> `PreBuildPanel` contains the string `Cancel` **zero** times (`grep -c` → 0). So on a
> rate-limited run, or after any failed action, with the rail shut, **there was no way to stop
> the run on screen at all**.
>
> **Fixed in the right order: product first, then the test.** `RateLimitNotice` gained an
> `onCancel` and a `danger` Cancel beside Resume; the action-error notice gained one, gated on
> `!isTerminalStatus(run.status)` because offering to cancel a finished run is a button that
> can only produce a second error; the false comment was replaced with a table naming all four
> suppressing surfaces and which of them carries Cancel. Then the test was renamed to *"with no
> notice up, the run chip and the Overview panel are exact complements"* — **claim narrowed,
> not deleted** — and **two arms were added**: a rate-limited arm (driven by a `page.route`
> intercept of `GET /api/runs/:id` only, so canvas, rail and panels stay the ones every other
> test measures, with a precondition assertion that fails loudly if the intercept stops
> taking) and an action-error arm reached the way a reader reaches it, by pressing the chip's
> own Cancel and having it 500. `M-RL-CANCEL`, `M-AE-CANCEL` and `M-HUD-NOTICES` each produced
> verbatim RED. **The pre-build panel still carries no Cancel** — deliberate, documented at the
> `hudMounted` site, carried forward in §6.
>
> **THE LESSON THAT GENERALISES, and it is not the side-by-side technique.** The ordering
> taxonomy every vacuity audit in this repo has used **cannot see either defect**. The dead
> `tablist` locator was POS-BEFORE-clean and still matched nothing; the three-state-as-two-state
> rewrite had a live locator, a real positive control and a correct order. **A vacuity audit
> needs a second axis** — extract the literal, grep `dashboard/src`, split code hits from
> comment hits — **and a third**: check that the fixture can actually reach every state the
> test's own name claims.
