# WHERE THIS STANDS — measured 2026-08-02

Written to answer one question: *how close is this to making something end to end?*

**Every number below was measured in this session, with a shell.** Nothing is
transcribed from `dashboard/STATUS.md`, which says of itself that it lags its own
tree. Where a claim could not be measured, it says so.

---

## 1. THE THREE RUNS ON DISK — one completed and was judged; two were interrupted

**Not a 1-in-3 hit rate.** Only one of the three ever got a fair trial. Run 2 died
on an external `aborted by user` inside spec; run 3 was aborted twice by dashboard
shutdown and its gate stopped `cancelled`. Neither result is a statement about
whether the pipeline works.

Read out of `dashboard/data/runs.db` (events + runs + criteria tables), each run's
`results/verdict.md`, and the score records under `dashboard/results/scores/`.

| run | ticket | wall clock | reached | outcome |
|---|---|---|---|---|
| `…3d4d1ccb` | bike shop (detailed ticket, sonnet) | 1 h 44 m | spec→build→gate→judge→done | **PASSED WITH NOTES** |
| `…c228e63b` | `https://kamilborzecki.dev` | 9 m 37 s | spec only | **died in spec** — `Claude Code process aborted by user`, 0 gate attempts |
| `…052c6e02` | copy kamilborzecki.dev | **12 h 02 m** | spec→build→gate→judge→done | **DID NOT PASS** — and see §2 |

**The one that passed is the one worth keeping.** Verdict `# PASSED WITH NOTES`;
4 BLOCKING pass, 5 FUNCTIONAL pass, 3 QUALITY pass, 1 QUALITY fail. The QUALITY
fail is the useful part: the sealed half caught *an empty booking submission
produces no confirmation* — a defect the builder did not know it had. `gate_stop_reason
= green`, `held_out_pass = 1`, `resume_count = 0`, no abort anywhere in its 388 events.

## 2. THE LAST RUN IS A VERDICT ABOUT NOTHING, AND THAT IS THE HEADLINE

`…052c6e02` published `# DID NOT PASS — 13 things the ticket asked for are not
there — 3 BLOCKING, 10 FUNCTIONAL`. **Nothing was tested.** From its own score
record:

```
suiteExecution   exitCode -1   durationMs 0   testsTotal null   testsPassed null
agentDeclaredDone  false        heldOutPass  false
scorerImageDigest  sha256:fae56a4e1374ee215bb1d23c20b2c55519f8c071bdb6c283d77ef29288e33770
```

The held-out suite never executed. `GATE:boot` failed first, and everything
downstream reads *"the app never booted, so no route could be probed."* The 16
"unmet criteria" are unmet by default, not by measurement.

### Why GATE:boot failed, and why this is the top item

`…052c6e02.container.json`, verbatim:

> the artefact directory was served over `http://127.0.0.1:3000` by the scorer's
> own pre-baked static server … The root document `/` did not answer HTTP 200
> with a non-empty body after 119 attempt(s) in 30026 ms. Problem:
> `http://127.0.0.1:3000/` answered **HTTP 404**, expected 200.

**But the root document was there.** Same record: `filesCopied: 39`,
`bytesCopied: 11407715`, `protectedPathViolations: []`, and `GATE:no-stub-markers`
reports *"6 source file(s) of 39 walked"*, so the artefact staged fine.
`workspace/index.html` has mtime `2026-07-31T08:09:36Z`; the gate ran
`08:15:06Z → 08:15:36Z`. It existed six minutes before the gate opened.

And a 404 is not the blank-body path. `bakeoff/src/tier0.ts:1291-1293` — for a
request path ending in `/` the only candidate is `join(rootDir, "index.html")`.
A 404 there means **`rootDir` is not the directory holding `index.html`**, not
that the document was empty.

### Two competing explanations, and the cheap way to tell them apart

**(a) The workspace was still being written when the gate opened.** `server.mjs`
has mtime `2026-07-31T08:16:27Z` — **51 seconds after the gate finished** at
`08:15:36Z`. `styles.css` lands `08:13:37Z`, ninety seconds before it started. The
build was still moving files while it was being scored, which is consistent with a
run that was cancelled rather than finished (`agentDeclaredDone: false`,
`gate_stop_reason: cancelled`). On this reading nothing is broken in the scorer and
the run simply never should have been gated.

**(b) `GATE:boot`'s static arm regressed in the fix wave.** That wave edited it —
`fe06b4f fix(tier0): GATE:boot's static arm called a one-byte HTML body
"non-blank"` — and that edit is what moved the scorer image to `fae56a4e…`. The
bike-shop run passed under the *previous* image, `c98bad3a…`. `…052c6e02` is the
only static-site run ever scored under the current one, and its boot gate 404'd.

**Discriminate in two steps, cheapest first.** All three images are still on disk:

```
bakeoff-scorer:1              fae56a4e1374   <- current, resolved this session
bakeoff-scorer:pre-readmech   c98bad3a762b   <- what the passing run used
bakeoff-scorer:pre-lane4      bcd017714ba7
```

1. Re-score `…052c6e02`'s workspace **as it sits now, under `bakeoff-scorer:1`.**
   If `GATE:boot` passes, explanation (a) holds and there is no regression to chase.
2. Only if it still 404s: re-score under `BAKEOFF_SCORER_IMAGE=bakeoff-scorer:pre-readmech`.
   Boot passing there and failing on `:1` makes it (b).

Cost: minutes either way. Skipping it risks spending another 12 hours on a gate
that cannot open.

## 3. THE UNEXERCISED SURFACE — this is the answer to "can it do it today"

The only run that ever reached a real verdict was scored `2026-07-30T01:12:52Z`,
at commit `e65a293`. Since then, to `f194539` (HEAD):

```
29 commits    122 files    +43,581 / -2,822
code only (excl. docs)   117 files   +40,083 / -1,526
   of which production     69 files   +25,249 / -1,269
   of which tests          46 files   +14,598 /   -181
```

**Nine of those areas are on the unconditional path** — a run cannot avoid them:
orchestrator sequencing and the new abort classification (`+1,897/-47`, the
largest single delta), the spec phase and ticket identity (`ticket.ts` +204,
`ticket-refs.ts` +599, `spec-pipeline.ts` +491 — all new files), build completion
and timeout, gate attempts and cancelled-vs-failed, silence detection, the run
record and DB schema, the SSE surface (`http.ts` +1,567), and model resolution.

Three more are conditional on getting far enough: the preview route, project
publishing, owner chat replies.

So: *the pipeline has produced one good result, and essentially none of the code
that would produce the next one has been exercised by a successful run.*

## 4. TEST BASELINE — measured, not reported

```
dashboard/server   npm run clean && npm test    1152 tests  1150 pass  0 fail  2 skipped (quota)
dashboard client   playwright --project=unit     128 tests   125 pass  3 fail
dashboard client   playwright --project=browser    56 tests    46 pass 10 fail
dashboard client   npx tsc --noEmit               exit 0
```

The 10 browser failures are the known `canvas-edges` (6) and `code-browser` (4)
spec drift. **The 3 unit failures are not in any handover** — all three are
`tests/ticket-title.unit.spec.ts`, all three die on the same negative control:
`Error: RunHud rendered no <h1>`. The component stopped rendering the heading the
title-summariser tests measure. The test caught it; nobody read it.

## 5. THE PREVIEW LINK IS BROKEN TWO WAYS — measured this session

The canvas preview node points at `/api/runs/:id/preview/` (`src/lib/spec-pipeline.ts:388`).

**Through the dashboard (`:4319`) it is an infinite redirect loop.** Next strips
the trailing slash, the server 302s it back:

```
GET /api/runs/…/preview/  -> 308  location: …/preview
GET /api/runs/…/preview   -> 302  location: …/preview/
GET /api/runs/…/preview/  -> 308  location: …/preview
… (does not terminate)
```

A browser shows `ERR_TOO_MANY_REDIRECTS`. Next's default `trailingSlash: false`
runs before the rewrite; the server's own redirect restores the slash the handler
needs (`http.ts:866-877` documents exactly why it needs it).

**Bypassing the client (`:4176`) the page loads but renders unstyled.** The
artefact's document is root-absolute — `href="/styles.css"`, `src="/main.js"` — so
the browser asks the API root, which 404s, while the same files answer 200 at
`/api/runs/:id/preview/styles.css`. Measured: page 200, title correct,
`requestfailed` on both assets, screenshot is raw Times New Roman.

The builder knew and wrote it down. `projects/…/server.mjs`, verbatim: *"every
reference in the document is root-absolute. Serving anything deeper would 404 the
root document."* The preview route serves it one level deeper.

Served from its own root (`node server.mjs`), the artefact renders correctly — 0
page errors, 0 failed requests.

## 6. THE VERIFIED GAPS — all six still true, checked against source

| gap | status | evidence | weight |
|---|---|---|---|
| Spend is never recorded | **STILL TRUE** | `recordSeatSpend`/`recordMeteredSpend` are *defined* at `db.ts:1205` / `db.ts:1282` and have **0** non-test call sites. 21 hits total: 2 definitions, 13 test invocations, 5 docblock/prose, 1 error-message literal. No SQL bypass — the only `INSERT INTO seat_spend` is `db.ts:1220`. Token *totals* do land (the last run records 434,084 in / 111,936 out / 16.2 M cache read); `costUsd` is `null`. | degrades trust |
| The visible acceptance half is never executed | **STILL TRUE, mechanism corrected** | Not the sandbox. *Nothing runs it at all.* `materialiseVisibleSubset` (`bakeoff/src/spec-freeze.ts:791`) is `mkdirSync` + `writeFileSync` + `return`. The orchestrator's only child process is git (`orchestrator.ts:3976`). No `node --test` / `playwright test` invocation exists in `dashboard/server/src`. On this path the visible half is a read-only hint. | degrades trust |
| The plan phase is unbuilt | **STILL TRUE** | `api-types.ts:90` — `ApiPhase = "spec" \| "build" \| "gate" \| "judge" \| "done"`. `#execute` opens straight at `spec` (`orchestrator.ts:1305-1307`). Design at `docs/FINDINGS-2026-07-30-canvas-asks.md:1079`. | see §7 |
| Codex has zero held-out enforcement | **STILL TRUE** | `codex-builder.ts:135-145` is the whole isolation config: `sandboxMode: "workspace-write"`, `networkAccessEnabled: true`, no read deny, no hook. Against the Claude driver's two layers (`claude-builder.ts:965`, `:1033`). Codex is never offered in the picker today, so it is latent. | degrades trust |
| No dry run against the current image | **STILL TRUE** | Current: `fae56a4e…` (resolved this session). Newest dry run `bakeoff/dry-run/scores/dryrun-A-DRYRUN-r0.json` records `c98bad3a…`. Same-field comparison, genuine mismatch. Note the current image *has* been exercised by a real run — `…052c6e02` — and that run's boot gate failed (§2). | blocking-adjacent |
| Preview route | **NEW, §5** | redirect loop + unstyled | blocking for "show me what it made" |

## 7. THE STRATEGIC GAP — `inferredCriteria`

The measure already exists and predates the feature:

```
…3d4d1ccb (detailed ticket, PASSED)     inferredCriteria = 2
…052c6e02 (one sentence, two typos)     inferredCriteria = 16
```

`…052c6e02/results/assumptions.md`, verbatim: *"Of 16 criteria: 15 inferred by the
grader, 1 house defaults, **0 traced to words you wrote**."*

A run graded against 16 guesses cannot pass except by luck. The plan phase —
designed at `FINDINGS…:1079`, ahead of `spec`, questions ranked by how much the
answer changes the build — is the fix, and its success condition is a number that
already exists. The chat reply channel that shipped last week is its transport.

---

## WHAT TO DO, IN ORDER

1. **Re-score `…052c6e02`'s workspace under the current image, then under
   `pre-readmech` only if it still fails** (§2). Minutes. Tells you whether
   `GATE:boot` regressed or whether the run was simply gated mid-write. Everything
   else is guesswork until this is answered — a gate that cannot open makes every
   run a verdict about nothing.
2. **Fix the preview route** (rewrite root-absolute asset paths, or serve the
   preview at an origin root, and settle the trailing slash with Next). Small, and
   it is the difference between "it built something" and "show me".
3. **Then one uninterrupted run to verdict** — and do not restart the dashboard
   during it. `…052c6e02` was aborted and resumed twice by dashboard shutdown
   (`resume_count = 2`) and re-entered spec→build each time. Cost: 2–12 h of
   subscription quota.
4. **Then the plan phase.** It is the only item whose value is measurable before
   it is built.

Deferred, carried forward, not dropped: the 3 `ticket-title` unit failures, the 10
`canvas-edges`/`code-browser` browser failures, spend call sites, the visible-half
execution gap, Codex read enforcement.

---

## BACKLOG FROM THE ATTACHMENT-DISPLAY WORK (2026-08-02) — none blocking, none dropped

Shipped and verified independently in this session: image thumbnails and document rows
on the ticket form and chat composer, an attachments panel on the run page, and
`GET /api/runs/:id/{references,documents}/:file`. Server suite **1165 / 1163 pass /
0 fail / 2 skipped** (from 1152/1150). Client unchanged from baseline, same three
pre-existing `ticket-title` failures. Traversal refused on every spelling I tried, and
the membership check is provably load-bearing: `references/capture-1280.png` exists on
disk in the served directory and is still 404, because it is not in the manifest.

**One thing found that was worse than the brief described.** `run-attachments.ts` arrived
with a header claiming *"FOUR REFUSALS, IN THIS ORDER, AND EACH ONE IS SUFFICIENT
ALONE"* while `resolveAttachment` implemented exactly one — the allowlist disabled by
`void isSafeAttachmentFile;`, membership degraded to `listAttachments(...)[0]` (serves
the run's FIRST attachment under any spelling), and the containment check voided out
with `void sep; void rootReal;`. §6's defect at full size: the name claimed four, the
mechanism did one. All four are now real and read directly off the file.

Carried forward, from the adversarial review (7 should-fix, 3 nits):

1. **`orchestrator-chat.tsx` releases blob URLs against a stale closure.** `send`'s
   `.then()` calls `releaseAttachments(attachments)` over the list captured at send
   time, so anything attached while the request is in flight is revoked wrongly or
   leaked. Real bug, real leak — up to 6×8 MB pinned.
2. **`run-attachments.ts`'s header still overclaims.** It says removing any single
   refusal leaves the route safe. That is the same class of statement this file exists
   to catch; the four are not independently sufficient and the docblock should say what
   each one actually covers.
3. **No `contract-parity` test for the new `RunDetail` fields.** `contract-parity.test.ts`
   documents this exact hole at :195-198 — it cross-checks the SSE event union as text
   and not `RunDetail` shapes — so the client mirror can lag silently.
4. **The client type mirror was deliberately not updated** (`dashboard/src/lib/api-types.ts`)
   to avoid a concurrent-edit collision. It is a pure type mirror; `ApiAttachment` and
   the two `RunDetail` fields still need adding there.
5. **`api-types.ts`'s `documents` docblock is now stale** — it says a document never
   reaches an agent, and `orchestrator.ts:1500` says the spec seat sees every one.
6. Two `formatBytes` implementations on the client; `attachmentUrl` percent-encodes
   neither segment; `toDetail` reads the manifest twice per request.

---

## BACKLOG FROM THE HANDOVER WORK AND ITS FIX PASS (2026-08-02)

Handover shipped **PARTIAL** with three blocking defects; a fix pass re-verified all
five as **WORKS** against real reproductions on a real dashboard. Server suite
**1309 / 1307 pass / 0 fail / 0 cancelled / 2 skipped**, `tsc` exit 0.

**The defect worth remembering.** `git add -A -- . :(exclude,literal)app.db` exits 1
whenever a path named by an exclude pathspec is also matched by the `.gitignore` in
effect — and the handover's own `.gitignore` (`*.db`, `node_modules/`) created that
intersection with itself. Every project carrying a database published with an empty
`.git`. It survived 1186 green tests because every fixture in both test files used the
one `.gitignore` shape (`tmp/`) that avoids the intersection. **The fixture was the
bug's hiding place, not the code.**

The fix rejected the obvious `--force` for a measured reason: `--force` overrides
*every* builder rule, verified by staging `dist/bundle.js` with `dist/` in the
builder's `.gitignore` — so anything a builder deliberately ignored (`secrets/`,
`*.pem`) would be committed. Exclusions moved into `<git dir>/info/exclude` instead,
which is never committed, never replaces the builder's file, and holds whether or not
one was shipped. Bonus property: because the rules live in the repository's own exclude
file rather than a one-shot pathspec, the owner's own later `git add -A` cannot put a
key into history either.

`.env` resolution: **copied to disk, never committed**, `.env.example` committed. On
disk because it is the only place the values the build agent used exist and the README's
run instructions are useless without them; out of history because the README tells the
owner the folder is his to push.

Carried forward, from the second adversarial review (5 should-fix, 1 nit):

1. **The exclude-file guarantee is overclaimed in the docblock.** A working-tree
   `.gitignore` OUTRANKS `$GIT_DIR/info/exclude` in git's precedence order, so a
   builder `.gitignore` containing a negation (`!app.db`) defeats it. The mechanism is
   right for every realistic case and the docblock claims more than it does — §6's
   defect, recurring.
2. **The fixture-shape false negative recurred** in the NEW fixtures for the database
   and node_modules cases. The lesson did not stick on the first pass.
3. `discoverStartCommand` copies the builder's `start` script verbatim into the README —
   a start script containing a credential would print it.
4. `HANDOVER_EXCLUDE_RULES` force-includes `.env.example`/`.sample`/`.template` past its
   own `.env.*` sweep; a builder who puts real values in `.env.example` is committed.
5. `schemaBasename` lowercases and collapses non-alphanumerics, so two databases whose
   names differ only by case or punctuation collide on one schema file.
6. **Still unwired:** `run: row` at the `publishProject({…})` call in `orchestrator.ts`.
   Without it every NEW run's README prints "not recorded" for run id, ticket id,
   verdict and model. Blocked on the plan-phase fleet releasing that file.
7. Three orphaned `node -e` processes (pids 4099, 12490, 77834) predate all of this and
   are not from the fixed code — the fix pass proved its own fixtures leak nothing by
   comparing PIDs rather than counts. Clear with
   `ps -eo pid,ppid,command | awk '$2==1 && /node -e/ {print $1}' | xargs kill`.

---

## OPEN, HANDED TO A LATER SESSION (2026-08-03)

### 21 of 34 agent spawns lose their parent, and it is not the hooks

Found while answering "is the guessed-parent edge even needed, since the orchestrator
calls the agents?" — a fair question, and the measurement contradicts the reassuring
answer. On `run-2026-07-30T20-16-40-242Z-052c6e02`:

```
graph_agent          exact  13     inferred  21
graph_hook           exact   0     inferred  13
graph_tool           exact 482     inferred   0
graph_result          exact 27     inferred   0
graph_agent_status    exact 54     inferred   0
```

**`graph_hook` being inferred is by design** — hook messages carry no task identity, so
attributing one to an agent is always a deduction (`graph-emit.ts:403`, parented to root
unconditionally). That is the honest half.

**`graph_agent` at 21 inferred against 13 exact is NOT explained.** It should be rare.
`graph-emit.ts:278` marks a `task_started` exact whenever
`#spawnOrigin.get(tool_use_id)` resolves — i.e. whenever the Agent block that spawned
the task was seen and recorded. Three candidate causes, none yet distinguished:

1. `task_started.tool_use_id` arriving `null`.
2. The spawning Agent block never recorded, because `#spawnOrigin.set` (`:359`) is
   gated on `canSpawn(use) && this.#spawnOrigin.size < SPAWN_MEMORY`. `SPAWN_MEMORY`
   is **512** and its comment reads *"Far above any real run's count"* — that claim
   is worth measuring rather than trusting, but 34 spawns is nowhere near 512, so the
   cap is probably NOT the cause on this run.
3. `canSpawn` refusing the block: it matches `Agent`/`Task` by name, else requires
   `subagent_type` or `isolation` in the input. A delegation shaped some other way is
   never recorded, and every task it spawns is then a guess. **This is the most likely
   one and the cheapest to check** — dump the tool-use names and input keys for the 21
   and see what shape they actually had.

WHY IT MATTERS BEYOND THE LABEL: an inferred edge is parented to the ROOT, so a
subagent that delegates further is drawn hanging off the orchestrator instead of off its
real parent. The canvas then under-reports the depth of the agent tree — it shows a flat
fan where there was a chain. The edge treatment is honest about the uncertainty; the
SHAPE is still wrong, and no amount of relabelling fixes that.

FIRST STEP FOR WHOEVER PICKS THIS UP: for each of the 21, print the `task_started`
payload's `tool_use_id` and, where it is non-null, whether any earlier assistant turn
carried a tool use with that id. That separates cause 1 from causes 2 and 3 in one query.

#### ANSWERED 2026-08-04 — it is none of the three, and the headline above is wrong

Measured while running Step 1 of Task 3 of `plans/2026-08-04-motion-capture-plan-a.md`,
whose whole task was to widen `canSpawn` for cause 3. **The widening was not shipped:
it would have fixed 0 of the 21.** `graph-emit.ts` is untouched.

**The query the plan shipped to separate the causes cannot separate anything.** It reads
`payload.toolUseId`; the field is `payload.sdk.toolUseId` (`graph-emit.ts:296`). So
`!p.toolUseId` is true for every event and the query returns "cause 1" whatever the data
says. Run verbatim it gives `{total:34, nullId:21, unseen:0}`. Corrected, the same run
gives `{total:34, exact:13, nullId:1, unseen:20}` — the opposite reading. A probe that
can only return one answer, which is this repository's recurring defect and the reason
the number above went 24 hours unexplained.

**What the 20 non-null ids actually point at: `Bash`, not a delegation.** All 20 carry
`agent: null` — the CLI sent no `subagent_type`, so it did not describe them as
delegations — and 14 of the 20 carry a raw shell string where an agent's description
would be:

```
n4…n13  /Users/kamilborzecki/.claude/scripts/gemini-image.sh "FAITHFUL RECONSTRUCTION…
n21     node "$TMPDIR/harness.mjs" && node "$TMPDIR/harness2.mjs" && …
n28     cd $TMPDIR && python3 -m venv ftenv >/dev/null 2>&1 && ./ftenv/bin/pip -q …
n17/n18 "Retry headless shell in single-process mode" / "Launch headless screenshot in background"
```

The remaining six are Bash `description` strings. In every one of the 20 the nearest
preceding `graph_tool` is `Bash`. These are BACKGROUND SHELLS — `run_in_background`
Bash calls, which the CLI reports as `task_started` — and `canSpawn` refuses `Bash`
correctly. The second run agrees: `…3d4d1ccb` is 9 inferred, all 9 `agent: null`, all 9
behind a Bash call.

**Why the proposed widening reaches none of them.** It added the names
`Dispatch`/`SendMessage`/`Workflow` and the input keys `agent_type`/`agentType`.
`Bash` is not among the names, and Bash's input keys (`command`, `description`,
`run_in_background`, `timeout`) intersect the key list nowhere. 20 Bash-origin + 1
null-id = 21, and the change reaches neither group.

**The one genuine delegation that was inferred is n29** (`human-factors-adversary`) and
its `tool_use_id` is null — cause 1, which widening also cannot reach.

**So the headline is wrong and so is commit `7045d05`'s.** 34 is a count of EVENTS: the
root re-announces itself 5 times across the two resume points, leaving 29 distinct nodes.
Genuine agent delegations drawn as guesses: **one**. The canvas is not showing a flat fan
of orphaned subagents — it is showing background shells as agent nodes, parented to root
and dashed. The depth of the real agent tree was never the thing being under-reported.

LEFT OPEN DELIBERATELY, BECAUSE IT IS A DESIGN CALL AND NOT A BUG FIX: a background
Bash block IS the true origin of the task it starts, so recording `Bash` +
`run_in_background: true` in `#spawnOrigin` would make 20 of these `exact` and parent
them to the agent that ran the shell rather than to the root. That changes what `exact`
means for a task that is not a delegation, and it presumes a background shell should be
an agent node at all. Neither question is one to settle inside a task whose instruction
was to stop.
