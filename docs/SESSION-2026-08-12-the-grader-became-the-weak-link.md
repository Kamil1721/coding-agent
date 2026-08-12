# 2026-08-12 — THE DAY THE GRADER BECAME THE WEAK LINK

Two runs reached a verdict. The pipeline built working software, unattended, and the
suite said it had not. That is a better problem than the one this day started with, and
the whole day is the story of how it moved.

---

## 1. THE HEADLINE — THE ARTEFACT WAS RIGHT AND THE VERDICT WAS WRONG

Run `6ec44b2f` scored **20/25, DID NOT PASS**. Adjudicated against the owner's own
fifteen acceptance signals by booting the artefact rather than by reading the verdict:

```
npm start boots, serves every page and API route        200 × 5
blank message -> field error, stores nothing            400, count unchanged 1 -> 1
valid message -> 201, appears in /api/messages          201, present
no token / wrong token -> 401                           401 / 401
/work/nonsense -> styled 404                            404
six project URLs load directly                          200 × 6
KILL THE SERVER AND RESTART -> messages survive         2 before, 2 after, newest first
images at true proportions (33 measured, 3 widths)      16 off by 1.2-1.8% vs 1%
```

**Four of the five failures were the grader.** REQ-004, REQ-008 and REQ-009 are one
defect: the held-out tests locate files carrying the *SQLite header* and grep them for
bytes just POSTed. The builder used `PRAGMA journal_mode = WAL` — correct, conventional,
durable — so the row lives in `portfolio.db-wal`, which carries the WAL magic
`377f0682`, not the SQLite header. Proven three ways: the data reads back through the
API, it survives a real kill-and-restart, and `grep -ac` finds the probe tag in the WAL
and not in the 4096-byte main file. REQ-007 is the same scan.

**One failure was real and it is small**: image ratios 1.2-1.8% against a 1% tolerance.
The previous run shipped those same posters at **×0.69 and ×0.28**.

True score ≈ **24/25**. `heldOutPass` is all-or-nothing, so it still reads `failed`.

---

## 2. WHY THE SUITE MISJUDGED IT — AND IT IS NOT RESTRICTION

The owner asked the sharpest question of the day: *is the model being restricted too
much?* The answer splits, and the two halves want opposite fixes.

| failure | cause | direction |
|---|---|---|
| EARS refused *"Each project page shall…"* | regex doing a judgement's job | **less** restriction |
| intake refused *"Each attached video shall be transcoded"* | regex doing a judgement's job | **less** |
| `proofsFor` accepted any non-empty string as proof | check not mechanical enough | **more** |
| repair cleared a finding it could not fix | naming ≠ fixability | move it to judgement |
| WAL byte-grep instead of a restart test | seat free, preferred provable to faithful | aim the audit |

The spec seat was not restricted. Its ticket said, in the owner's own words,
*"Killing the server and starting it again still returns messages submitted before."*
**Zero of 25 criteria tested a restart.** It invented a structural proxy because a
byte-grep is easier to assert than a restart — it optimised for provability over
fidelity, and nothing in the prompt told it that was a trade it was making.

> The rule is not "trust the model more" or "constrain it harder".
> **Put each decision where the evidence for it is.** A regex cannot read English. A
> model writing a suite before any code exists cannot foresee an implementation, which
> is why it should be pushed toward BEHAVIOURAL checks — behaviour is the only thing it
> can know in advance.

---

## 3. WHAT SHIPPED, AND THE MEASUREMENT THAT FORCED EACH

| # | change | forced by |
|---|---|---|
| 1 | `AuditFinding.remedy` — the judge declares `edit` vs `add`; repair attempts only `edit` | `d143e52d`: a finding naming five real artefacts was handed to a round that could not add the criterion it demanded |
| 2 | no-op repair guard — an echoed-back artefact is refused | a response identical to the audited draft went to a fresh judge as a coin flip |
| 3 | acceptance-signal coverage — the owner's bullets are extracted, declared and enforced | §1's WAL failure: the right check was in the ticket and unused |
| 4 | intake deixis fix | seven legitimate sentences refused at the submit button |
| 5 | `UNARMED is not PASS`, route-aware | two green tests: `containerExecuted 0` AND "self-applies and gets a token" |
| 6 | ablation proof reads its transcript | a hand-typed string reached APPLY and rewrote a file on disk |
| 7 | evidence bar wired in front of the gate; `isolate.mjs` | `runRepairCycle` was dead code outside its own arm check |
| 8 | patch author | the cycle's honest answer was `NO_PATCH_AUTHOR`, and that human was the assistant |
| 9 | design-asset reuse | 11 images × 5 calls per run, two thirds discarded after the lock |

Gate at the close: **bakeoff 234/234 · server 2088/2085/0/3 · tier3 28/28 · repair
109/109 · three typechecks clean.**

---

## 4. THE PATTERN INSIDE THE DAY, WHICH IS THE LESSON

Three times, a fix shipped whose tests could not observe the thing it fixed. Every one
was caught by mutation, none by reading:

- the repair tests: every fixture had findings that ALL localised or NONE did, so
  deleting the `unlocalised` guard left 19 tests green. The mixed case — one finding
  names a file, another names nothing — was the whole reason the predicate existed.
- the `remedy` fix: **no test anywhere made the judge return a finding.** The only judge
  fixture was `{verdict:"usable", findings:[]}`, so hardcoding the remedy to `"edit"` —
  restoring the exact defect it was written to fix — left all 212 tests green.
- `brief-shape.ts`: a docblock claimed its test file asserted
  `brief.includes(finding.sentence)`. It did not. The claim was true and untested, which
  is worse than false and tested.

> **A record that reports what the harness did is not a record of whether it worked.**
> `d143e52d`'s trail said `accepted: true`, `repairRounds: 1`, no problems. Every field
> was accurate and the suite it froze gated nothing on persistence.

The habit that would have collapsed all three: **mutate before shipping, not after.**

---

## 5. THE SELF-REPAIR CHAIN — BUILT, SAFE, AND NEVER ONCE RUN

Every piece now exists: author → reproduce → prove → replay → survive mutation → gate →
apply with a rollback point → re-queue. Two adversarial passes found nothing that
reaches the tree without an APPLY token.

It has never completed unattended, and the blocker is named rather than closed: **no
defect class that can fire today has a runnable reproduction.** The three
suite-authoring records need the run's own rejected manifest, which lives under
gitignored `dashboard/runs` and reaches the record as nothing. Closing it needs a
producer at the throw site copying that manifest into `results/` while the failing tree
still exists.

The mechanism IS proven on an injected defect — `aa6e721e`'s own regex narrowing,
red 1046ms → green 1050ms → red-on-revert 1049ms, PROVEN in 4.16s with the ablation
holding. That is a simulation, not a run.

---

## 6. WHAT IS OPEN, RANKED

1. **The manifest producer.** One edit at the throw site turns three real defect records
   from a named absence into a runnable reproduction, and makes the chain reachable.
2. **Record what a repair CHANGED.** `repairedProblems` says what a round was asked to
   clear; nothing says which artefacts came back or how they differed. Diagnosing
   `d143e52d` required reading the frozen suite by hand.
3. **The WAL blind spot belongs in `dashboard/STATUS.md`**, where this repo keeps known
   grader limitations and where the verdict itself points readers.
4. **Image ratios at 1.2-1.8%.** The one genuine build defect left, untouched by
   anything shipped today.
5. **`reuseDesignFrom` is server-side only** — the client's `CreateRunRequest` mirror
   does not declare it, and `contract-parity.test.ts` does not whole-shape that type.
6. **`COPY_NOT_BUILDABLE` cannot fire on this machine** — four real isolations answered
   `buildable: true`. A bound placed before the capability it bounds.

---

## 7. THE TWO RUNS LEFT EXECUTING

```
A  run-2026-08-12T13-20-15-745Z-e1c15359   design lane FULL     ~11 images
B  run-2026-08-12T15-21-03-226Z-047f9872   design lane REUSED   0 images, 0 Veo legs
   both on ticket t-855f41701dd1e908 — identical brief, identical frozen suite
   concurrency 2, auto-resume on throttle armed
```

The suite they are graded against contains, for the first time:

```
REQ-009 — "When the server process is killed and started again, the site shall still
           return, from GET /api/messages, a message submitted before the restart."
```

That is acceptance signal 5, in the owner's words, now binding on the grader — and a
check no storage layout can defeat.

---

## 8. HOW THE TWO RUNS ENDED — MEASURED AFTER THE FACT

```
A  e1c15359  design lane FULL      242m  gate 3 (retry-cap)      20/25  falseFinish 1
B  047f9872  design lane REUSED    112m  gate 2 (not-converging) 21/25  falseFinish 1
```

**DESIGN REUSE WORKED, AND IT IS THE UNAMBIGUOUS WIN.**

```
A  mode full     images 11  imageCalls 7  reusedFrom —
B  mode reused   images 11  imageCalls 0  reusedFrom 6ec44b2f
```

Zero image calls, zero Veo legs, the same eleven stills, the source recorded, and the
run finished in **less than half the wall-clock**. Repeat runs no longer cost art.

**BOTH FAILED, AND THE FAILURE IS ALMOST CERTAINLY A THIRD GRADER ARTEFACT.**

Failing criteria, run A: REQ-006, REQ-007, REQ-009, REQ-010, REQ-022. Run B: the same
minus REQ-022. The signature is the tell — **every test in the two files that SPAWN
their own server failed, 6 of 6, and files that do not spawn passed**:

```
holdout/messages-persistence.test.mjs   T-108 T-109 T-110 T-111   all failed
visible/inbox-token.test.mjs            T-207 T-208 T-209         all failed
```

That is a file-level failure, not six independent build defects. Adjudicated by booting
run A's artefact by hand:

```
POST /api/contact                 201
GET /api/messages (token)         200, message present
kill the process, start it again
GET /api/messages (token)         200, SAME message returned
portfolio.db                      28672 bytes, checkpointed
```

**REQ-009 — the restart criterion this whole day was spent producing — is correctly
written and the artefact satisfies it.** It still scored `fail`, because the seat
implemented it by spawning a second server instance inside the sealed container, and
that pattern does not survive there. The criterion is behavioural and right; its
EXECUTION is what breaks.

Note what this means for §2's argument: forcing the seat to bind to the owner's words
produced the right REQUIREMENT and did not constrain HOW it was checked. The seat chose
`spawn` — a mechanism that works on the developer's machine and not in the sealed
container — for the same reason it previously chose a byte-grep: it optimised for what
was easy to write.

## 9. THE FIRST THING TO DO TOMORROW

**Find out why a spawned server fails inside the sealed container, and teach the seat
not to need one.** The ticket itself says the BUILD sandbox denies `listen()` on every
port with EPERM; if the scorer container shares that restriction, then every criterion
the seat implements by spawning is unpassable by construction, and three of today's five
failures — plus REQ-004/008/009 of the previous run — are one root cause with two
disguises.

Candidates, cheapest first:
1. Read the scorer's raw stderr for `messages-persistence.test.mjs`. It was not in
   `results/`; find where the container's per-file output lands.
2. If `listen()` is denied: the suite must exercise the ALREADY-RUNNING app (the scorer
   boots it on `execution.port` and health-checks it) instead of spawning its own, and
   the authoring prompt must say so — the same "use what is there" lesson as §2.
3. A restart criterion then needs the harness to restart the app under test, which is a
   capability the manifest does not currently express.
