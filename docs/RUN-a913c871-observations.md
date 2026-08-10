# RUN `a913c871` — LIVE OBSERVATION LOG

`run-2026-08-09T21-04-00-713Z-a913c871`, started 2026-08-09 21:04:00Z.
A deliberate replica of `run-2026-08-04T11-08-10-487Z-162b186d` (run 4), which died in
the spec seat on the 64k output-token cap.

**This file is written AS IT HAPPENS.** Anything recorded after the fact says so. It
exists because run 4's post-mortem had to be reconstructed from a record that did not
collect the field that mattered, and the reconstruction cost more than the run.

---

## CLOSED OUT 2026-08-10 — THE THREE QUESTIONS, ANSWERED FIRST

> **A REPAIR ROUND RAN ON 2026-08-10. See §WHAT WAS FIXED, 2026-08-10 near the end of this
> file.** Nothing above it has been rewritten. One headline correction and one caution:
> the root-cause command `grep -ac minRows bakeoff/src/spec-agent.ts` now returns **5**
> (it was **0**, and that zero is this file's central measurement); and **no run has been
> made since**, so the evidence that the fix works is a **validator probe, not a live
> seat**. `FINDING 5`'s corollary about the 128k ladder is **half refuted** — see the
> correction in that section.

The run **FAILED** at `2026-08-09T22:31:04.532Z`, 1h26m54s in, in phase `spec`.

> `sqlite3 -header dashboard/data/runs.db "select status, phase, resume_count, gate_attempts, agent_declared_done, held_out_pass, input_tokens, output_tokens, recovery_class, auto_continue_count, started_at, ended_at from runs where run_id='run-2026-08-09T21-04-00-713Z-a913c871';"`
> → `failed|spec|1|0|0||||structural|0|2026-08-09T21:04:17.760Z|2026-08-09T22:31:04.532Z`

**Q1 — did the spec seat survive run 4's death? YES, and it died a different one.**
Run 4 died on *"exceeded the 64000 output token maximum"* in authoring attempt 1. This run
returned **three complete, parseable authoring responses** and died on the third one's
manifest failing schema validation. **But the fix under test was never asked a question:**
no truncation occurred at any point, so the 64k→128k ladder did not fire and remains
completely unexercised. See §HOW IT DIED and the correction under FINDING 5.

**Q2 — did the gate open? NO. It was never reached.**
`gate_attempts 0`, `agent_declared_done 0`, `held_out_pass NULL`, `suite_sha256 ''`,
`builder_session_id ''`. The run stopped at the second of roughly ten stations. The 5b
gate-refusal guard keys on a builder self-report file in a workspace that stayed empty,
so it is still unexercised in production, along with everything downstream of it.

**Q3 — did `seat_spend` acquire rows? NO — and that is the most expensive finding tonight.**
> `sqlite3 dashboard/data/runs.db "select 'seat_spend',count(*) from seat_spend union all select 'metered_spend',count(*) from metered_spend;"`
> → `seat_spend|0`  `metered_spend|0`

Zero rows for this run, and zero rows across **all five runs that have ever existed on
this machine**. Not a merge regression — a structural one. Both `#recordSpend` calls for
the spec and audit seats sit **six lines below an `await` that threw**, with no `try/finally`:

> `grep -an "#recordSpend(" dashboard/server/src/orchestrator.ts` → `3036` (spec), `3037` (audit)
> `grep -an "finally" dashboard/server/src/orchestrator.ts | awk -F: '$1>2880 && $1<3070'` → **no matches**

The empirical proof it never ran, independent of which revision was loaded: the phase
emitted **no `spec seat —` line** (`orchestrator.ts:3030`, six lines *above* the ledger
write), only seven `rate_limit` frames and then the error. The spend the run actually
incurred is recoverable, but only from outside the harness — see §HOW IT DIED.

> **FIXED 2026-08-10, AND Q3'S EXPECTATION IS NOW INVERTED.** Both `#recordSpend` calls are
> inside a `finally` (`orchestrator.ts:3196-3197`; `assertUnused()` stayed **outside** it, as
> this file's own §THE NEXT MOVE required). **Spec and audit rows must now land even when
> the phase dies.** After the next run, `seat_spend` still holding 0 rows on a spec-phase
> death is a regression, not the status quo. The line numbers quoted above are the
> pre-fix tree's and are stale by design — re-grep before citing them.
> **Not fixed:** `plan` is still not a member of `ApiSpendSeat` (N6), so the plan seat's
> tokens still reach no table, on a failing run or a successful one.

---

## WHAT WAS HELD CONSTANT, AND WHAT COULD NOT BE

| | run 4 | this run | same? |
|---|---|---|---|
| brief prose | 173 lines, `sha256 dfe9350d…` | same 173 lines resubmitted | **yes**, byte-identical |
| brief as stored | 173 lines | 190 lines | **no** — motion read now inlined (17 lines) |
| reference image | `56c0c61c…` 559,692 B | `56c0c61c…` 559,692 B | **yes**, byte-identical |
| CV document | `afc90b1f…` 80,102 B | `afc90b1f…` 80,102 B | **yes**, byte-identical |
| motion source | `kamilborzecki.dev`, span/transform/250ms | same reading, captured live | **yes** in content |
| run-4 plan answers | asked and answered live | **folded into the resubmitted brief**, lines 149-166 | **yes**, verbatim |
| model | `"default"`, unpinned | `"default"` → `claude-opus-5[1m]`, pinned + ceiling-guarded | **no — this is the fix under test** |
| interactive / designLock | `1` / `ask` | `1` / `ask` | yes |
| ticket id | `t-956f3bbea410c8c7` | `t-4aff531a8a4916ff` → `t-b79ff5e2a1b314e4` after fold | no, and expected |

The ticket id moves because identity is minted from the augmented brief. Run 4 never
froze a suite, so nothing is being reused and the difference costs nothing.

---

## TIMELINE, MEASURED

| at (UTC) | what | evidence |
|---|---|---|
| 21:04:00 | run created, `HTTP 201` | `POST /api/runs` → `{"runId":"run-2026-08-09T21-04-00-713Z-a913c871"}` |
| 21:04:17 | plan seat parks, 3 questions | `plan.json` `awaiting: true`, `parkedAt 21:04:17.766Z` |
| — | plan seat **did not re-ask run 4's questions**: *"PQ-1/PQ-2 settled (six cards, each illustrated); PQ-3 he left to us, not re-asking."* | `plan.json` `state.plan[2]` |
| ~21:06 | owner answered in the dashboard UI: PQ-1 declined (no phone number anywhere), PQ-2 answered *"it stays pinned"*, PQ-3 declined (cards reveal as one group) | `plan.json` per-question `status` |
| 21:06:29 | plan folded, ticket re-minted `t-4aff531a8a4916ff` → `t-b79ff5e2a1b314e4` | event seq 41 |
| 21:06:29 | **phase → `spec`** — the phase that killed run 4 | event seq 42 |
| 21:06:29 | spec seat told it will see 1 attached document on every call | event seq 44 |
| 21:06:32 | `{"type":"rate_limit","limited":false,"retryAfterSec":572007}` — 158.9 h, a **window horizon, not a refusal**, exactly as §3-A1 predicted | event seq 45 |
| 21:20:30 | **fourteen minutes, zero further events.** Seat alive: `pid 29197 … claude-agent-sdk-darwin-arm64, up 14:23, cpu 1.7%, rss 300 MB` | `ps -eo pid,ppid,etime,%cpu,rss,command \| awk '$2==20284'` |

### FINDING 1 — WATCH 1 does not fire while the model is thinking
Recorded in full at §6 of `docs/STATE-2026-08-09-where-we-are.md`. Short form: progress
rows are delta-driven, so a seat that reads before it writes emits nothing, and the
dashboard cannot tell that from a hang. The seat process was the only instrument that
could, and it is not on screen. **Not a run defect. A blindness defect, and it is the
same blindness that made run 4's 48m51s gap unreadable.**

> **SUPERSEDED IN PART 2026-08-10 — see §CORRECTIONS.** "Delta-driven, so a seat that reads
> before it writes emits nothing" is too kind. The channel has **never emitted a row on this
> machine** (0 across 1,816 events / 5 runs), and a negative control inside this very run
> refutes the reading-before-writing explanation. The filed fix also points at the wrong
> file.

| 21:27:54 | second `rate_limit` row, `limited:false`, `retryAfterSec 570725` — down from 572007, so it is a window countdown, not a refusal | event seq 46 |
| 21:31:20 | **twenty-five minutes in `spec`, still zero progress rows.** Seat alive: `pid 29197, up 24:47, cpu 1.1%, rss 194 MB` (down from 300 MB) | `ps … \| grep claude-agent-sdk-darwin` |

### FINDING 2 — THE WATCHER I BUILT TO CATCH FINDING 1 HAD FINDING 1's DEFECT

Recorded because it is the more useful of the two. The first liveness arm read:

```
API=$(pgrep -f "node dist/index.js" | head -1)
seat=$(ps -eo pid,ppid,etime,%cpu,rss,comm | awk -v a="$API" '$2==a && /claude|node/ {…}')
```

`pgrep -f` matches the **zsh wrapper** as well as the server, and `head -1` took the
wrapper (lower pid). So `$2==a` selected the wrapper's child — **the API server itself** —
and reported it as the seat. The evidence it emitted:

```
HEARTBEAT: spec | running | - — seat 20284 up 36:57 cpu 0.0% rss 38MB
```

`0.0% cpu, 38 MB` is an idle HTTP server. The actual seat at that moment was
`pid 29197, cpu 1.1%, rss 194 MB`. **The arm would have printed a healthy seat forever
after the seat died** — a check that can only observe success, built inside the same hour
as a report cataloguing eighteen of them, by the agent writing the catalogue.

Fixed by matching the SDK binary by name rather than by parent pid, and — the part that
matters — by giving the arm a **startup negative control** that runs while the seat is
known to be alive and prints its match count. If the matcher is blind, the monitor says
so in its first line instead of going quiet for hours:

```
ARM CHECK: seat matcher finds N process(es) right now (must be >=1, else this arm is blind)
```

**The general lesson, and it is not about pgrep:** a liveness probe whose failure mode is
"prints nothing" is indistinguishable from the condition it watches for. Every such probe
needs an arm check at start, when the answer is known.

| 22:02:36 | **56 minutes in `spec` — this run has now survived longer in the spec phase than run 4 did.** Run 4 "spent 51 minutes in the spec phase and died" (`subscription-caller.ts:1902`). Seat `44002` alive, `up 30:26`, ceiling still `64000`. Events 46-49 are `rate_limit` telemetry only. **Not yet proof of anything** — a longer call is not a successful one, and the ladder has not fired. | `sqlite3 … where seq>48`, `ps eww -p 44002` |

### FINDING 3 — "Reading the reference page" can never finish: the pattern has a reader and no writer

Spotted by the owner in the UI, not by any test: the pre-build lane shows
**"Reading the reference page — Waiting to see whether your ticket named a page"** while a
LATER stage ("Writing the tests") is already `WORKING`, and the panel reads `1 of 5 done`.

The stage settles only on a log row matching:
```
grep -arn 'no reference capture' dashboard/server/src dashboard/src | grep -av '\.test\.'
  dashboard/server/src/graph.ts:455        const NO_CAPTURE = /no reference capture/i;   <- reader
  dashboard/src/lib/spec-pipeline.ts:123   const NO_CAPTURE = /no reference capture/i;   <- client mirror
  dashboard/server/src/orchestrator.ts:7100  (docblock, naming it as an unanchored pattern)
  dashboard/server/src/graph.ts:437          (docblock)
```
**Two readers, two docblocks, and NO PRODUCTION EMITTER.** Nothing in the tree writes that
sentence, so the "skipped" state is unreachable and the stage waits forever on every run
whose ticket names no page. Instance nineteen: the display can observe the capture
happening and cannot observe it correctly not happening.

**No work was skipped.** Verified:
- the ticket names no page — `grep -nEo 'https?://[^ )"]+' <brief>` → zero hits in 173 lines,
  so `captureTargetIn(ticketText)` correctly finds nothing and `references.json` records
  `capture: null` (run 4 recorded the same);
- the reference IMAGE was read on every plan-seat call — events 9/15/21/27:
  `plan seat — 1 attached image(s): reference-1.png (image/png): sent as an image block,
  746256 base64 chars`;
- the motion read DID happen — event 5: `read how https://kamilborzecki.dev/ MOVES and
  found 1 thing(s) in motion`, and it is the 17 lines added to the brief.

Fix is a one-line emit at the no-target branch. NOT DONE — a run is in flight.

### FINDING 4 — a seat call ended and another began, and the record cannot say which

At `21:31:52` and `21:31:55` two `rate_limit` rows land three seconds apart, and the SDK
subprocess changes identity: `pid 29197 (up 24:47)` → `pid 44002`. That is one call
finishing and the next starting. **No log row marks it.** The events between seq 45 and 48
are three `rate_limit` telemetry rows and nothing else.

So the record cannot distinguish, without guessing:
- spec attempt 1 failed and the ladder started attempt 2 — the run-4 failure region, now
  survivable; from
- authoring finished and the AUDIT call began — the normal path (event 43 says the seat
  will "author … then audit it").

Discriminator available on disk, and it is negative so far: no suite directory exists for
this run's ticket — `find dashboard/acceptance/t-b79ff5e2a1b314e4` → nothing, and
`dashboard/acceptance/` still holds only the two July ticket dirs. `results/` holds
`plan.json` and an empty `build.log`.

**This compounds Finding 1.** A phase that emits no progress AND no step boundaries is
opaque for its whole duration; the only two instruments that work are the subprocess table
and the filesystem, neither of which is in the product.

> **ANSWERED 2026-08-10 — it was authoring attempt 1 handing over to attempt 2**, not
> author→audit. Settled from the CLI transcripts, which are outside the product; the record
> the product keeps still cannot distinguish the two. See §CORRECTIONS.

### FINDING 5 — the run-4 fix is AHEAD of us, not behind, and the seat's own environment is the instrument

Measured on the live seat at 21:52Z, reading ONE variable rather than dumping an
environment that is a subtraction and not an allowlist:

```
ps eww -p 44002 | tr ' ' '\n' | grep -a '^CLAUDE_CODE_MAX_OUTPUT_TOKENS='
  CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000
```

**64000 is correct here, and that took reading the code to know.** It is the starting
rung, not a regression. Two source docblocks settle it:

`subscription-caller.ts:1891-1906` — run 4's real cause, stated by the people who fixed it:
> `maxOutputTokens` HAS NO SDK OPTION AND IS SENT ANYWAY, as
> `CLAUDE_CODE_MAX_OUTPUT_TOKENS` … This docblock previously said it was "enforced after
> the fact by the caller's own truncation check", which was an accurate description of a
> check that could never run: over-length came back as a THROWN error, so the truncation
> check downstream never saw a result to check. Both halves are fixed — the number now
> governs the call, and exceeding it now RETURNS with `stopReason: "max_tokens"`.
> … Run `…162b186d` spent 51 minutes in the spec phase and died on "Claude's response
> exceeded the 64000 output token maximum", **three feet from a repair ladder in
> `spec-agent.ts` that detects exactly this, raises the budget and retries for free. It
> never fired, because the ladder reads a returned `SeatCallResult` and this method
> handed it an exception.**

`spec-agent.ts:1174-1197` — the ladder, and why it had never executed:
> raise the cap to the streamable ceiling and retry ONCE without consuming an attempt …
> **THE RUNG BELOW THE CEILING IS WHAT MAKES THIS EXECUTABLE, and it did not exist until
> 2026-08-04:** `DEFAULT_MAX_OUTPUT_TOKENS` was defined AS `MAX_STREAMABLE_OUTPUT_TOKENS`,
> so the guard below was false on the very first attempt and this branch had never run.

So the fix is two independent repairs — a throw became a return, and a one-rung ladder
became a two-rung one — and **neither has executed yet on this run.** The spec seat is
sitting on rung 1.

**THE PREDICTION, and it is falsifiable.** If this suite overflows 64k:
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` on the next seat process becomes **128000**, once, without
  consuming an authoring attempt → **the fix executed**, and run 4's death is repaired;
- if instead the run dies on *"exceeded the 64000 output token maximum"* → the return-path
  repair did not take and the ladder still cannot see the truncation;
- if it dies on *"did not fit in a single response at the streamable ceiling"* → the fix
  worked and the suite genuinely does not fit, which is a ticket-size problem and not a
  harness one. The remediation is in the error: split the ticket.
- If the suite fits at 64k, none of this fires and the fix stays unexercised — a green run
  that proves less than it looks like it proves. **Say so if that happens.**

The monitor now reads that variable every 30 s and announces any change, because
**nothing in the product logs the escalation.** A jump from 64000 to 128000 is the single
most informative event this run can produce, and it would otherwise be invisible.

> ### FINDING 5, RESOLVED 2026-08-10 — the prediction came true in its least informative branch
>
> The falsifiable prediction above has four branches. **The fourth one happened: the suite
> fit at 64k, nothing fired, and the fix stays unexercised.** The file demanded *"Say so if
> that happens"*, so: **it happened.** The ceiling was `64000` for the whole life of all
> three seat processes; it never rose to `128000`; no truncation occurred; the ladder was
> never asked a question. Tonight says **nothing whatsoever** about whether run 4's repair
> works.
>
> The strongest evidence is not the absence of an event — that would be a check that can
> only observe success, which this file exists to catalogue. It is the **shape of the error**:
> the manifest was *parsed and field-validated*. A truncated response cannot produce a
> `dataExpectations[0].id must be a non-empty string` complaint, because a truncated
> response never reaches the field. `wasTruncated(generated.call)` was therefore false on
> every attempt.
>
> **A LIMIT OF THE FIX NOBODY HAD STATED, measured here** —
> `sed -n '1156,1200p' bakeoff/src/spec-agent.ts`:
> ```
> let outputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
> let truncationRetried = false;                  <- OUTSIDE the loop
> for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
> ```
> `truncationRetried` is declared **outside** the attempt loop, so the free 128k retry is
> **once per RUN, not once per attempt**. A suite that overflows on attempts 2 and 3 gets no
> ladder at all. The docblock reads as a per-attempt guarantee and the code is not one.

---

## TIMELINE, CONTINUED — the last 29 minutes, and the attempt boundaries recovered

The three authoring attempts left **no harness artefact**. They were recovered after the
fact from the Claude Code CLI's own session transcripts, keyed by the seat's cwd
(`paths.home` = `.../dashboard`), and content-attributed to this run by grepping for the
ticket id. **This is forensics outside the product, not observability inside it.**

> `python3` scan of `~/.claude/projects/-Users-kamilborzecki-Projects-coding-agent-dashboard/{cfdffda9,60fcb909,e327a0fb}-*.jsonl`
> for `timestamp`, `message.usage`, and `tool_use` inputs containing `suite.manifest.json`

| at (UTC) | what | evidence |
|---|---|---|
| 21:06:30 → 21:31:52 | **authoring attempt 1**, 25m23s. Seat `pid 29197`. Ends with one `tool_use` carrying a complete manifest. | transcript `cfdffda9…`, first/last timestamp |
| 21:27:54 | `rate_limit`, `limited:false`, countdown | event seq 46 |
| 21:31:52 / 21:31:55 | two `rate_limit` rows 3 s apart, seat `29197 → 44002` | events seq 47, 48 |
| 21:31:54 → 22:07:19 | **authoring attempt 2**, 35m25s. Seat `pid 44002`. Its prompt carries attempt 1's blocking findings verbatim. | transcript `60fcb909…` |
| 21:57:05 | `rate_limit` | event seq 49 |
| 22:07:20 → 22:31:03 | **authoring attempt 3**, 23m43s. Seat `pid 59039`. Its prompt carries attempt 2's findings verbatim. | transcript `e327a0fb…` |
| 22:07:22 | `rate_limit` | event seq 50 |
| 22:31:03.670 | last assistant message of attempt 3 | transcript `e327a0fb…`, last timestamp |
| 22:31:03.674 | last `rate_limit` — **0.86 s before the failure** | event seq 51 |
| 22:31:04.530 | `log level=error` — `[suite_not_audited]` | event seq 52 |
| 22:31:04.531 | backlog written | event seq 53 |
| 22:31:04.533 | `verdict` — `NO VERDICT WAS REACHED` | event seq 54 |
| 22:31:04.534 | `warn` — the finished code was NOT copied (workspace empty; **publish correctly skipped**) | event seq 55 |
| 22:31:04.535 | `status failed` | event seq 56 |

**Independent cross-check, and it is the reason these boundaries can be trusted:** the
three transcript spans were derived from session logs; the three seat pids were derived
from a live 30-second `ps` sampler running outside the product. **Neither knew about the
other, and they agree to within two seconds at both handovers.**

Between `21:06:32Z` and `22:31:03Z` — **84 minutes 31 seconds** — the events table
acquired **six rows, all `rate_limit` telemetry**, carrying no seat, no attempt, no
liveness. The canvas said **"Writing the tests — working"** for the entire period.

---

## HOW IT DIED

### The failure, verbatim

> `sqlite3 dashboard/data/runs.db "select failure_reason from runs where run_id='run-2026-08-09T21-04-00-713Z-a913c871';"`

```
[suite_not_audited] could not author an acceptance suite for ticket t-b79ff5e2a1b314e4
that passes the bad-test audit in 3 attempt(s). Last attempt's blocking problems:
  - [other] the suite manifest "suite.manifest.json" is not executable by the sealed
    scorer: dataExpectations[0].id must be a non-empty string :: Set dataExpectations[0].id.
fix: Do NOT start builds. doc 03 section 7.4: a suite that fails the audit must be
regenerated, not used. Read the blocking findings above — repeated failures on the same
criterion usually mean the TICKET is ambiguous rather than the model incapable, and the
fix is to sharpen the ticket text (then re-record its digest and re-run every
configuration). Raising maxAttempts spends more money on the same ambiguity.
```

### LINE 1 — THE ROOT CAUSE, AND THE HARNESS'S OWN DIAGNOSIS IS WRONG

**The spec seat was ordered to emit an object whose shape it has never been shown.**

The authoring prompt mentions `dataExpectations` exactly twice, and neither mention
contains a single field name:

> `grep -an "dataExpectations" bakeoff/src/spec-agent.ts`
> ```
> 300:      "dataExpectations": []
> 340:and starts with "/". "dataExpectations" is [] ONLY when the ticket asks for no stored data at all: if
> ```

Line 300 is the entire manifest template — an **empty array**. Lines 340-343 then
*mandate* a populated one: *"if you chose SERVER for a persistence trigger, declare at
least one expectation here"*. The sealed scorer's parser requires **seven fields**
(`id`, `kind` ∈ {sqlite,http}, `file`, `table`, `sql`, `path`, `minRows`) plus cross-field
rules, and **not one of them appears anywhere the seat can read**:

> `grep -ac "minRows" bakeoff/src/spec-agent.ts` → **0**
> `grep -a -rn "minRows" --exclude-dir=node_modules --exclude-dir=dist --include='*.ts' --include='*.md' .`
> → only `scorer-protocol.ts`, `tier0.ts`, `scorer-container.ts`, and **`bakeoff/docker/README.md:391`**
> — the one correct populated example in the entire repository, in a file the seat never reads:
> `{ "id":"db-query-7", "kind":"sqlite", "file":"data/app.db", "table":"bookings", "sql":null, "path":null, "minRows":1 }`

The ticket forced SERVER mode (SQLite named, `POST /api/contact` stores, `GET /api/messages`
behind a bearer token, `GET /api/projects` served from the database), so `[]` was not a
legal exit either. **The model was in a box with no correct door it could see.**

Nor can the structured-output schema rescue it: `AUTHORING_JSON_SCHEMA` types the manifest
as `testFiles[].source: { type: "string" }` (`spec-agent.ts:508`). The manifest travels as
**opaque text**; `outputFormat.json_schema` constrains the envelope and nothing inside it.

### The three attempts — id → kind → id

This is the headline measurement, and it was made from the transcripts' own bytes: the
inbound prompt of each attempt, and the manifest each attempt emitted.

| attempt | what its prompt TOLD it | what its manifest EMITTED | fields present |
|---|---|---|---|
| 1 | *(no feedback — first attempt)* | `{ entity, source, expectation }` | **no `id`, no `kind`, no `minRows`** |
| 2 | `dataExpectations[0].id must be a non-empty string :: Set dataExpectations[0].id.` | `{ id, description, entity, minRowCount, readBack }` | **`id` added**, no `kind`, no `minRows` |
| 3 | `dataExpectations[0].kind must be "sqlite" or "http", got undefined :: Use "sqlite" to read a database file inside the …` | `{ kind, method, path, expectStatus, description }` | **`kind` added**, **`id` LOST**, no `minRows` |

All three chose SERVER mode correctly (`execution.start = "npm start"` every time). All
three returned complete, parseable JSON. **Not one of the three emitted `minRows`, and
none was ever told it exists.**

**Why it could not converge.** The authoring-time validator is `parseSuiteManifest`, whose
`fail()` is typed `never` — it **throws at the first offending field**, so the feedback
turn can only ever name one field per attempt:

> `sed -n '506,530p' bakeoff/src/scorer-protocol.ts`
> `function fail(message, remediation): never { throw new BakeoffError("invalid_usage_shape", …); }`

Three attempts, three single-field hints, over a seven-field object. **Discovery one field
at a time in three tries is arithmetically impossible.** The hints are not bare — each
carries a remediation clause, and attempt 3's even enumerated the legal `kind` values — so
this is a one-field-plus-a-sentence channel, not a one-bit one. It still could not work.

**The strongest single observation is attempt 3.** Told to add `kind`, it added `kind` and
**threw away the `id` it had gotten right on attempt 2**, replacing the whole vocabulary a
third time. A model that is accumulating fields does not do that. A model that has never
been shown the object, and is reading each rejection as *"your shape is wrong, try another
one"*, does exactly that.

### The remediation text is self-refuting, and it aimed this post-mortem at the wrong target

The failure tells the owner *"repeated failures on the same criterion usually mean the
TICKET is ambiguous… sharpen the ticket text (then re-record its digest and re-run every
configuration)"*. But the manifest finding is constructed with **`criterionId = null`**
(`spec-validate.ts:1309-1316`, `blocking("other", null, …)`). There is no criterion to be
ambiguous about. Sharpening the ticket would have bought a new digest and another 87
minutes and changed nothing. **This is a harness defect wearing a ticket-quality
accusation**, and the first hour of this post-mortem was spent auditing the ticket because
of it.

### The audit was RIGHT to block

This is not a case of an over-strict gate. The manifest is parsed **unconditionally, five
lines into the scorer container's `main()`** (`scorer-container.ts:1758-1766`). An
unscorable manifest aborts scoring for every configuration at once. And `id` is genuinely
load-bearing container-side, not a field only the validator wants: it labels every
data-expectation result and is what a criterion's `evidenceRequired` resolves against
(`checkDataExpectations`, `scorer-container.ts`). **Blocking was correct. Blocking three
times without ever showing the shape is the defect.**

### Why no fixture ever caught this

> `grep -a -rn "dataExpectations" bakeoff/test/quality-gating.e2e.mjs dashboard/server/src/calibration/suites/portfolio-suite.ts`
> → `quality-gating.e2e.mjs:149  dataExpectations: []` ; `portfolio-suite.ts:237  dataExpectations: []`

**No fixture anywhere in the repository has ever populated `dataExpectations`.** Every one
of them takes the branch that trivially passes. The persistence gate — `tier0.ts:1519-1625`,
`scorer-container.ts:815-827` — has therefore **never executed with a real expectation, end
to end, in the history of this project.** The signature defect again, and this is instance
twenty.

### What the 87 minutes cost, and where the number had to come from

Not in the harness. Recovered by summing `message.usage` across the three CLI transcripts:

> `python3` sum over `~/.claude/projects/-Users-kamilborzecki-Projects-coding-agent-dashboard/{cfdffda9,60fcb909,e327a0fb}-*.jsonl`
> ```
> cfdffda9  out 201,492 | 60fcb909  out 238,518 | e327a0fb  out 181,862
> TOTAL over 12 assistant messages:  input 24 · output 621,872 · cache read 163,640 · cache write 314,481
> ```

Plus the plan seat, which **did** log its tokens and still reached no table, because `plan`
is not a member of `ApiSpendSeat`:

> `sqlite3 … "select seq||' '||substr(payload,1,130) from events where … payload like '%seat — anthropic%';"`
> → seq 11/17/23/32, output `5046 + 575 + 499 + 449` = **6,569**
> `grep -an "ApiSpendSeat" dashboard/server/src/api-types.ts` → `165: "spec" | "audit" | "builder" | "fix" | "judge"` — **no `plan`**

**≈628,441 output tokens, recorded in no product artefact.** `runs.output_tokens` is NULL
because its only writers are on the build/fix/adversary paths, which a spec death never
reaches. Caveat: these are `message.usage` figures from local session logs, **not a
vendor-billed reconciliation**. The audit/judge seat's spend is **UNMEASURED** — three
transcripts for three authoring attempts is consistent with the judge never being
dispatched (the deterministic manifest check blocks before it), but *"never dispatched"*
was not proven. It does not change the fix: `#recordSpend` already no-ops on
`callCount <= 0`.

---

## CORRECTIONS TO THE FINDINGS ABOVE, dated 2026-08-10

Nothing above is deleted. These are the places where the finished record can say more, or
differently, than the live one could.

**FINDING 1 / R1 — the diagnosis was too kind. The progress channel is not slow; it is
dead, and it has never emitted a row on this machine.** The live entry said progress rows
are delta-driven and therefore silent while a seat reads. True, but the measurement is
worse than that:

> `sqlite3 dashboard/data/runs.db "select count(*) from events where payload like '%still working%';"` → **0**
> `sqlite3 dashboard/data/runs.db "select count(*) from events where payload like '%characters streamed%';"` → **0**
> ARM CHECK, so this absence is not a vacuous query on an empty table:
> `… like '%seat —%'` → **26** ; `select count(*), count(distinct run_id) from events;` → **1816|5**

Zero progress rows across **1,816 events / 5 runs**. And the "reading before writing"
explanation is refuted by a negative control *inside this run*: plan call 1 ran **72.75 s**
and reported **5,046 output tokens** (~20k characters), crossing both coalescer thresholds
many times over, and produced **zero** rows.

**Therefore R1's filed fix points at the wrong file and would change nothing.** It names
`SEAT_PROGRESS_INTERVAL_MS` (`subscription-caller.ts:396`) — a constant inside
`SeatProgressCoalescer`, whose only entry point is `push(delta)` guarded by
`if (delta.length === 0) return`, and which **contains no timer at all**:

> `grep -an "setInterval\|setTimeout" dashboard/server/src/subscription-caller.ts` → **no matches in the whole file**

The interval is only consulted *when a delta arrives*. No deltas, no interval, no row —
at any value. The heartbeat has to live in the orchestrator, armed when a seat call starts
and cleared in a `finally`, so that its existence depends on the call being in flight
rather than on the model streaming. **Leading hypothesis for why deltas never arrive, and
it is a hypothesis, not a measurement:** every seat that has ever run with `onProgress`
wired also runs with `outputFormat: {type:"json_schema"}`; the only `jsonSchema: null` seat
(`judge.ts:298`) has never run on an observed run. The discriminator is one spec call with
`structuredOutput: false`, which is already an option at `spec-agent.ts:917`.

**FINDING 4 — ANSWERED. It was attempt 1 handing over to attempt 2, and the record still
cannot say so.** The live entry listed two indistinguishable possibilities at the
`21:31:52 → 21:31:55` boundary. The transcripts settle it: `cfdffda9` ends `21:31:52.892Z`
and `60fcb909` begins `21:31:54.456Z` — **one authoring attempt ending and the next
beginning.** The compounding claim stands unchanged and is now measured: the only two
instruments that worked were the subprocess table and the CLI's session logs, and
**neither is in the product**.

**FINDING 3 / R3 — RE-CONFIRMED on the finished tree, still no emitter.**
> `grep -arn "no reference capture" --include='*.ts' --include='*.tsx' . | grep -av node_modules | grep -av '/dist/'`
> → `orchestrator.ts:7100` (docblock), `graph.ts:437` (docblock), `graph.ts:455` (reader),
> `spec-pipeline.ts:123` (client mirror), and four **test-supplied** sentences. **No production writer.**

Two further measurements the live entry could not make. First, folding this run's 56
stored events through the exact reducer that serves a finished run's canvas
(`graph.foldGraphAll`, the one `http.ts:1631` uses) leaves `capture` at **`pending`** after
death, because the terminal rule only converts `running` → `unresolved`. Second, the
`audit` stage **has no `running` writer anywhere**:

> `grep -an 'settleStage(next, "audit"' dashboard/server/src/graph.ts` → `719:` **`"done"` only**

So the seat that produced tonight's failure was **never once shown as active**, on this run
or any run. And what the owner's screen said after death about the stage that killed the
run — *"stopped … Not a failure. Nobody was watching by then."* — is false; it **was** the
failure, and the reason is recorded three rows later.

**FINDING 2 — the lesson held, and the product broke it in three more places tonight.** The
arm-check rule ("a probe whose failure mode is *prints nothing* needs a control at start,
when the answer is known") is exactly what the progress channel, the silence watch and the
spend ledger all lack. Recorded here rather than restated as new findings.

**THE SILENCE THE OWNER SAT THROUGH COULD NOT HAVE BEEN CAUGHT.**
`DEFAULT_SILENCE_WARN_MIN = 90` (`orchestrator.ts:895`), and the watch reads
`lastRunEventAt`, which **any** event resets — including the `rate_limit` telemetry that
landed every 20-25 minutes. Largest real gap 25.2 min; the whole spec phase 84.6 min. Both
under 90 either way. The watch did not fail tonight; **it cannot succeed on this shape**,
and it performs no status write, no requeue and no abort by design.

**THE ATTEMPT LEDGER FILED THIS AS A COMPLETION.**
> `sqlite3 -header dashboard/data/runs.db "select attempt_no,phase_reached,end_class,waited_sec,suite_source from run_attempts where run_id='…a913c871';"`
> → `1|plan|parked||` and `2|spec|completed|56|authored`

`end_class = completed` on a run whose own row says `status=failed, recovery_class=structural`
and whose verdict opens `NO VERDICT WAS REACHED`. Because `#announceAttemptHistory` filters
`completed` out, the ledger's only reader stayed silent. `suite_source = 'authored'` on a
run that froze no suite — it records the branch entered, not the outcome.

**THE NO-VERDICT FOOTER TELLS THE OWNER FOUR THINGS THAT ARE FALSE, AND HAS DONE SO THREE
TIMES.** `run-report.ts:407` emits *"The workspace and the frozen acceptance suite are both
intact"* and points at `assumptions.md`. **It is unconditional, and that is read off the
branch rather than inferred from three-for-three:** `renderNoVerdict` (`:391`) builds a
single flat `lines: string[]` array literal and returns `lines.join("\n")` — **no
conditional appears anywhere in the function body.** Measured: `suite_sha256` is empty,
`find dashboard/acceptance -maxdepth 1 -name 't-b79ff5e2a1b314e4'` returns nothing, the
workspace is empty (its own sibling `project-publish.json` says `"reason":"workspace-empty"`),
and `assumptions.md` is not in the directory —
`ls -1 dashboard/runs/run-2026-08-09*/results/` → `backlog.md build.log plan.json
project-publish.json verdict.md`. The same sentence is in the verdict of `162b186d` and
`c228e63b`: **every no-verdict run ever.** The *header* of that page is a model of honesty.
The footer is a template. And `backlog.md` opens *"**Stopped:** `infra` after 0 attempts"*
four lines above a message saying **3 attempts**.

**WHAT WAS ACTUALLY NEW TONIGHT — one thing, not the list the brief implies.** Run 4
already folded a plan on a real ticket, already took interactive answers, already wrote a
no-verdict page, already skipped publish on an empty workspace with the identical JSON;
`resume_count` incrementing is older still. Exactly **one** behaviour ran tonight that had
never run before: **the audit rejection ladder to exhaustion (3 attempts)**. Both prior
spec deaths were call-level failures at attempt 1. One genuinely good new arm: the failure
classifier ran for the first time, wrote `recovery_class = structural`, and correctly
refused to self-continue (`boundFor("structural")` → 0, `auto_continue_count = 0`) — so the
owner's "a run can restart itself three times unattended" fear does not apply to this
class.

---

## WHAT TO CAPTURE IF IT FAILS

Collected automatically by the forensic snapshot armed at 21:2xZ — output under the
session scratchpad, path reported when it fires. It takes, at the moment of the terminal
transition and before anything can be cleaned up:

- the `runs` row in full (esp. `failure_reason`, `output_tokens`, `gate_stop_reason`,
  `resume_count`, `held_out_pass`, `agent_declared_done`)
- the last 60 events with payloads
- `seat_spend` and `metered_spend` rows — **the first live exercise of those tables ever**
- `results/` in full: `plan.json`, `verdict.md`, `backlog.md`, `build.log`
- the score record and `*.container.json` if the gate ran
- a `find` of the workspace with mtimes — the thing §3-B1 needed and did not have
- whether the seat subprocess was alive at the moment of death

## THE THREE QUESTIONS THIS RUN ANSWERS

**Answered at the top of this file, 2026-08-10.** Short form: **yes (a different death) /
no (never reached) / no (zero rows, and that is a finding, not a merge regression).**

1. **Does the spec seat survive the suite that killed run 4?** The pin plus the 128k rung
   is the fix under test. A second 64k death means the rung is a no-op on the resolved
   model.
   → **Survived it and died elsewhere. The rung was never asked.** No truncation occurred,
   so the fix is *neither confirmed nor refuted* — it is still unexercised in production.
2. **Does the gate open on a workspace that was actually finished?** 5b now refuses a run
   whose builder never declared done. A legitimate finish must still be scored — a guard
   that refuses everything is worse than no guard.
   → **UNANSWERED. `gate_attempts = 0`.** The guard, the sealed scorer, `held_out_pass`,
   the persistence gate, the design lane, the judge seat, `false_finish`, capture,
   `run.json`, `environment.json`, `spend.md`, the fix seat and publish-on-success are all
   still unexercised.
3. **Does `seat_spend` acquire rows?** Expect `spec`, `audit`, `builder`, `judge`. A
   single `builder` row carrying everything means B5's merge fix regressed.
   → **NO ROWS AT ALL, on this or any run.** Not the merge fix — the writes are on the
   success path below a throw, and `plan` is not even a member of the seat enum. B5's merge
   question stays open, unmeasured, and cannot be measured until a run survives the spec
   phase.

---

## WHAT TONIGHT DID NOT ESTABLISH

The run failed in phase one of roughly ten. **Most of today's work is still untested, and
the honest summary is that 1h27m bought one fact.**

- **The 64k→128k ladder: unexercised.** Never fired, could not have fired. Worse: even if
  it *had* fired, this run could not have told you — the escalation emits no event
  (`spec-agent.ts:1188-1198`), so the only instrument was a `ps` sampler outside the
  product that covered 2 of the 3 seat pids. The one thing standing behind it is a fixture:
  `cd dashboard/server && node --test dist/spec-ladder-e2e.test.js` → **1 test, 1 pass**,
  driving the real caller through the real ladder across the package seam, with two
  watched-red mutations documented in its header, built 20:53Z (11 min before the run
  started). **Fixture coverage with negative controls, zero production evidence.**
- **The gate refusal: never reached.** `gate_attempts = 0`.
- **The spend wiring: produced nothing**, and the five internal call sites exist **only in
  the uncommitted working tree** — a fresh `git checkout` of HEAD has no spend wiring at
  all. Nothing here establishes the fix survives whatever happens to that diff.
- **The B5 mutation proof cannot observe either spend defect.** Its fixture pre-seals the
  suite (`freezeFor(...)`), so `#specPhase` returns at the reuse branch **before any seat
  caller is constructed**; every assertion is `seatOf("builder")` / `seatOf("fix")`, and
  `seatOf("spec")` has **no matches** in `orchestrator.test.ts`. That is precisely why
  zero-rows-on-failure shipped undetected.
- **The mutation for the ledger claim was NOT performed.** Hard Rule 1 forbids editing
  source, so nobody deleted the spec `#recordSpend` and re-ran B5 to watch it stay green.
  The assertion-gap claim is a read of the fixture, not a red run.
- **It is not proven a seat WOULD emit a valid manifest if shown the shape.** No re-run was
  made. The evidence is that each attempt correctly adopted the single field it was named —
  **suggestive, not conclusive.**
- **The `movesScorerDigest` verdicts are read off the Dockerfile's COPY/RUN graph**
  (`COPY src ./src` → `RUN tsc` → `COPY --from=build /build/dist`). The image was **not**
  built twice and the digests were **not** diffed.
- **The CLI transcripts are not a reliable forensic channel.** They are the Claude Code
  CLI's own session logs, keyed by the seat's cwd, not a harness artefact. A different cwd,
  or transcript retention off, and attempts 1-3 would be unrecoverable. The harness itself
  persisted nothing: `attempts[]` reaches disk only via `freezeSuite`'s `authoringTrail`,
  **which is only called on success.**
- **The suites were not audited beyond their manifests.** Attempts 1 and 2 also carried
  other blocking findings (a "not implemented" marker; credential-shaped
  `AUTHORIZATION_HEADER` literals). By attempt 3 the manifest was the **only** blocker left,
  which is why the manifest is what killed the run — but nothing here says the criteria or
  test files were any good.
- **The plan phase, the builder and the scorer are unmeasured tonight.** Only the spec
  phase's failure and its observability were examined.

---

## WHAT WAS FIXED, 2026-08-10

Written the day after, against the tree, not the plan. Ranked fix list and the digest chain
live in `docs/STATE-2026-08-09-where-we-are.md` §6.0-6.5; this section closes the loop on
the post-mortem above and says what the round did **not** buy.

### The root cause is closed at the source, and the closure is greppable

The post-mortem's measured root cause was *"the seat is ordered to emit `dataExpectations`
and is never shown its shape"*, evidenced by `grep -ac minRows bakeoff/src/spec-agent.ts`
→ **0**. That command now returns **5**. The manifest template that read
`"dataExpectations": []` — the shape the seat was shown for the whole life of this run —
now interpolates two populated entries, one `sqlite` (copied verbatim from
`bakeoff/docker/README.md:391`, the one correct example in the repository, which the seat
never read) and one `http`, beside a block stating only the rules `parseSuiteManifest`
actually enforces.

**Verified by parsing the SHIPPED prompt, not by reading the source.** Extractor written
fresh for this record: brace-match every `{…}` in the rendered `AUTHORING_SYSTEM_PROMPT`,
keep the ones mentioning `dataExpectations` (exactly **1**, offset 10675, 727 bytes), parse
it **whole** with zero substitution, hand it to the real parser:

```
dataExpectations entries: 2   ->  parseSuiteManifest: ACCEPTED
NEG drop minRows    -> dataExpectations[0].minRows must be a finite number >= 1
NEG drop id         -> dataExpectations[0].id must be a non-empty string
NEG kind=postgres   -> dataExpectations[0].kind must be "sqlite" or "http", got "postgres"
NEG absolute file   -> dataExpectations[0].file must be a relative path inside the artefact
NEG dup id          -> duplicate dataExpectations id "db-query-7"
```

Five negative controls, each rejected **and named**. Repeated inside the sealed image
against `/opt/bakeoff-scorer/dist` with the same result, so the copy that actually grades
was made to parse it.

### The feedback loop that made self-correction arithmetically impossible

`§HOW IT DIED` measured the whack-a-mole: `fail()` is typed `never`, so each rejection names
one field, and *"discovering a seven-field object one field per try in three tries is
arithmetically impossible."* `collectManifestProblems` now surveys the whole document by
substituting one candidate field at a time into a document the real parser accepts and
re-parsing — it **restates zero rules**, so every message it returns is the sealed parser's
own. Run against **this run's real attempt-3 manifest**, from the shipped `bakeoff/dist`:

```
fail-fast   : dataExpectations[0].id must be a non-empty string                (1 field)
collect-all : id | file | minRows | sql | table                                (5 fields)
```

Obedient-seat simulation (repair each named field with a legal value for the entry's own
kind, loop until the parser accepts), re-measured for this record:

| this run's shape | fail-fast rounds | collect-all rounds |
|---|---|---|
| attempt 1 `{entity, source, expectation}` | **7** | **2** |
| attempt 2 `{id, description, entity, minRowCount, readBack}` | **6** | **2** |
| attempt 3 `{kind, method, path, expectStatus, description}` | **5** | **1** |

Budget is **3**. `sql` appears in that list only because a repair pass added a single-field
probe; before it the collector could never name `sql` at all, and an obedient seat that
repaired all the other fields would have been rejected again for it — one more round out of
three, in the round that exists because rounds ran out.

**`parseSuiteManifest` itself is unchanged.** `git diff -U0 -- bakeoff/src/scorer-protocol.ts`
was one purely additive hunk at the time of the four lanes; the fail-fast contract the
container depends on (`scorer-container.ts:1765`, `secret-intake.ts:425`) is intact.

### The sentence that aimed this post-mortem at the wrong target

`§The remediation text is self-refuting` measured that `suite_not_audited` told the owner to
sharpen a ticket when the blocking finding carried `criterionId = null`. That literal is
gone. `remediationForFailedAuthoring(findings)` now branches **three** ways: null-criterion
findings say the suite is **structurally unexecutable** and name the manifest fields;
criterion-bearing findings keep the ambiguity advice and name the criteria; **no** blocking
findings say *"Neither the ticket nor the suite has been shown to be at fault"*. The third
branch is not padding — *"every blocking finding has `criterionId === null`"* is vacuously
true over the empty list, and the list **is** empty on the commonest failure of all (a
response that never parsed), so a two-way branch would have shipped a structural-manifest
accusation on runs where no manifest was ever audited.

### The 84 minutes of silence, and the boundaries this file had to recover by hand

`§FINDING 4` and `§TIMELINE, CONTINUED` recovered the attempt boundaries from the Claude
Code CLI's own session transcripts, keyed by the seat's cwd. Four channels now exist that
did not:

- **a heartbeat row roughly every 60 s** while a spec seat call is open (grep
  `has not come back yet`) — a clock in the run service, explicitly *not* a report from the
  model. It exists because the delta channel this file's `FINDING 1` blamed is not slow, it
  is **dead**, and R1 did **not** repair it.
- **one row per authoring dispatch** (grep `of this phase:`) — *"draft 2 … so draft 1 was
  refused"*. Three drafts would now be three rows. **The row cannot name the refused field**;
  that requires attaching `attempts[]` to the thrown error and was not done.
- **the rung history on the failure itself** (grep `Output-token ceiling by attempt`),
  landing in `runs.failure_reason` — the channel this run had to substitute `ps eww` for,
  covering two of its three seats.
- **the spec/audit ledger writes moved into a `finally`**, so `Q3`'s answer inverts: spec and
  audit rows must now appear **even when the phase dies**. `seat_spend` empty after a
  spec-phase death is now a regression rather than the expected state.

### CORRECTION TO FINDING 5's COROLLARY, 2026-08-10 — the ladder claim was half wrong

`§WHAT TONIGHT DID NOT ESTABLISH` and the N10 row in the state doc both assert *"a suite that
overflows on attempts 2 or 3 gets no ladder at all"*, from `truncationRetried` being declared
outside the attempt loop. **That is refuted on the call sequence and it was measured
refuted.** The flag is set immediately *before* the rung guard, and the guarded branch
assigns `outputTokens = MAX`; `outputTokens` never decreases, so whenever the guard could
pass the flag is already false. The flag can never be the reason an escalation is skipped.
Restoring the pre-fix declaration leaves all four call-sequence tests **green**. **What was
real is the RECORD:** the flag is sticky at run scope, so attempt 3 reported an escalation it
never earned — on the very channel built to stop a run guessing about its own ceiling. That
is the half that was fixed.

---

## STILL UNPROVEN AFTER THE FIXES, 2026-08-10

Everything under `§WHAT TONIGHT DID NOT ESTABLISH` above still stands unless listed here.
These are the ones the fixes touched without closing.

- **NO RUN HAS PRODUCED A VALID MANIFEST. The evidence is a validator probe, not a live
  seat.** This is the single most important line in this section. What is proven: the shipped
  prompt's example parses under the real parser, and five malformations are each rejected and
  named. What is **not** proven: that a seat shown the shape emits it. **No run has been made
  since the fix.** The post-mortem's own honest limit is unchanged — *"showing the shape is
  not proven to produce a valid manifest; it is the cheapest action that could."*
- **The persistence gate has still never executed with a real expectation, and it now has a
  named way to fail wrongly.** Every leg of the re-established trust chain — calibration
  8/8, dry run 24 PASS, run-1 re-score — printed
  `GATE:data-present :: NOT APPLICABLE: the frozen suite declares no data expectations`.
  Worse than untested: `checkDataExpectations` runs at `scorer-container.ts:1969`, **before**
  `runFrozenSuite` at `:1997`, and `minRows >= 1` makes *"the table exists and the suite will
  write to it"* inexpressible — so an expectation on a table nothing seeds is a **BLOCKING
  false fail on the co-primary metric**, with `falseFinish=true` if the builder declared
  done. A one-sentence prose remedy was **refused as unsafe**: the SERVER mandate says you
  must declare one, `minRows >= 1` says it must be non-empty, and adding "at boot" leaves a
  user-written-persistence ticket with no legal exit. **Triage rule for the next run: a
  failing persistence gate is the gate's own first bug until proven otherwise.**
- **The 64k→128k ladder is still unexercised.** N10 made the rung **visible**; it did not
  make it fire. If the next failure says `did NOT fire`, the ladder remains at fixture
  coverage with zero production evidence, exactly as this file recorded.
- **The dead progress channel is unexplained.** 0 rows matching `%still working%` across
  1,816 events / 5 runs. The heartbeat makes the phase observable **without** repairing or
  explaining the delta channel. R1's leading hypothesis — that every seat with `onProgress`
  also runs with `outputFormat: json_schema` — was **not tested**; the discriminator is still
  one spec call with `structuredOutput: false` (`spec-agent.ts:917`).
- **The `audit` stage still has no `running` writer.** `settleStage(next, "audit", …)`
  appears once, as `"done"`. The seat that produced this run's failure has never once been
  shown as active, on any run.
- **The heartbeat brackets `authorAndFreezeSuite` only.** Plan, builder, fix rounds and
  judge still have no pulse, so a silence there is still indistinguishable from a hang.
- **N3 changes the FEEDBACK VOLUME and nothing has measured how a seat responds to it.**
  Three or four simultaneous field corrections instead of one. The only observed behaviour is
  of a seat handed one at a time — and it replaced its whole vocabulary each time.
- **Nothing here says the criteria or the test files were any good.** Attempts 1 and 2 also
  carried other blocking findings. By attempt 3 the manifest was the only blocker left, which
  is why the manifest killed the run; the rest of the suite was never audited beyond it.
- **The CLI transcripts remain the only record of attempts 1-3**, and they are still not a
  harness artefact. N5's fix produces a row per *dispatch* going forward; it does not
  retroactively persist anything, and it still cannot name the field a draft was refused for.

---


## THE NEXT MOVE

> **EXECUTED 2026-08-10 — this section is now a record of what was recommended, kept
> unedited so the recommendation can be judged against the outcome.** All three numbered
> steps below were done, plus the heartbeat in the closing paragraph. Two departures from
> the estimate, both worth knowing: (1) it was **not** a ten-line prompt edit — the prompt
> half was, but binding the prose to the validator, the collect-all pass and the three-way
> remediation branch came to ~400 lines across four `bakeoff/src` files plus 22 new tests;
> (2) **the digest moved TWICE, not once** — a repair pass then had to add a single-field
> `sql` probe, so the chain (calibration, dry run, run-1 re-score) was re-established a
> second time. The cost model in *"What it costs"* was right per rebuild and wrong about
> the count. See **§WHAT WAS FIXED, 2026-08-10** above and `STATE` §6.0.
>
> **The closing paragraph's heartbeat shipped with one deliberate change:** it says *"this
> phase started N ago and has not returned"*, **not** *"(attempt K)"*. A timer in the
> orchestrator cannot know the attempt — the attempt ordinal comes from a separate ladder
> row off the seat caller's ceiling events. Merging them would have been the run service
> asserting something it does not observe.

**The cheapest action that gets further than tonight is to show the model the shape, and
it is a ten-line prompt edit.**

Not *"sharpen the ticket"* — the ticket is the most explicit one in the repo (it names
SQLite, the routes, the status codes and the token) and the finding that killed the run
carries `criterionId = null`, so there is no criterion to sharpen. Not *"the ticket is too
big for a single-response suite"* — that branch is dead on the evidence: **no truncation
occurred and all three attempts returned complete, parseable JSON**. Splitting the ticket
would cost a new digest and buy nothing.

**Do this:**

1. Replace `"dataExpectations": []` in the manifest template (`bakeoff/src/spec-agent.ts:300`)
   with the populated entry that already exists verbatim at `bakeoff/docker/README.md:391`,
   plus an `http` variant, and state the two cross-field rules next to the `:340-343`
   mandate (sqlite needs `file` plus one of `table`/`sql`; http needs `path`). Mirror how
   `uiFlows` already shows all four of its fields inline on the very next line.
2. In the **same** edit round, because they are all `bakeoff/src` text and the digest is
   paid once either way: branch the `suite_not_audited` remediation so `criterionId === null`
   findings stop blaming the ticket, and give `deterministicAudit` a collect-all pass so one
   rejection names **every** offending field instead of the first.
3. Land the **free** one alongside it, in the dashboard package: `try/finally` around
   `authorAndFreezeSuite` (`orchestrator.ts:3015-3037`) so the two `describeTokens` lines
   and the two `#recordSpend` calls run on the throw path. `assertUnused()` **must stay
   outside the finally** — calling it while unwinding would replace the real failure with a
   guard throw. Without this, the next failure is as uncosted as this one.

**What it costs.** Steps 1-2 touch `bakeoff/src`, which is copied into the scorer image and
recompiled there (`scorer.Dockerfile:78-79 COPY src ./src` + `RUN tsc`; the dockerignore
excludes `node_modules`, `dist`, `acceptance`, `results` — **`src` is not excluded**). So
even a pure prompt-text edit **moves the image digest** and costs **one image rebuild + one
Appendix-A re-calibration + a re-score of run 1**. Batch them: paid once for all three, or
three times if dripped. Step 3 is free — no digest, no rebuild, dashboard-side only.

**The honest limit on the recommendation:** showing the shape is not *proven* to produce a
valid manifest. It is the cheapest action that could, and every attempt tonight correctly
adopted the exact field it was named. **The next run is also the first real test of the
persistence gate, which has never executed with a populated `dataExpectations` in the
history of this project.**

**And one thing to add before the re-run, or the next 87 minutes are as blind as these
were:** an orchestrator-level heartbeat (`setInterval`, armed at seat-call start, cleared in
a `finally`, emitting *"the spec seat has been working for N minutes (attempt K)"*). It is
free, it does not depend on deltas, and with per-attempt findings surfaced it would have let
the owner kill this run at **21:31** instead of **22:31**.
