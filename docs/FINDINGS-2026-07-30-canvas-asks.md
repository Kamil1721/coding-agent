# Findings — the four canvas asks, 2026-07-30

Measured this session against the running dashboard and the real Coglane run
(`run-2026-07-29T23-28-46-665Z-3d4d1ccb`). Every claim below has the command that
produced it. Two of them correct HANDOVER.md.

---

## 0. BASELINE, before any edit — the client suite is NOT green

`cd dashboard && npx playwright test` → **13 failed / 73 passed**.

HANDOVER §8 OPERATIONAL says "client — 53 unit, 73 with the browser project",
which reads as green. The 73 pass; it does not mention the 13.

All 13 are the same root cause — **the canvas redesign moved the components and
the specs were never moved with them**:

| Spec | Failures | Why |
|---|---|---|
| `run-layout.browser.spec.ts` | 3 | asserts the deleted three-column grid |
| `canvas-edges.browser.spec.ts` | 6 | selector drift from the same redesign |
| `code-browser.browser.spec.ts` | 4 | `CodeBrowser` moved into `RunSheet`'s Code tab; the spec expects it inline |

**These are pre-existing.** Any later claim that a change "broke 13 tests" is
reading this baseline, not the change.

---

## 1. HANDOVER §6 is wrong about `run-layout.browser.spec.ts`

It says the spec "still asserts *'the rail sits beside it'* and **still passes**."

It asserts that, and it **fails**:

```
Locator: locator('section:has(.react-flow)')
Expected: 1   Received: 0
```

The canvas root is a `<div>` (`orchestration-canvas.tsx:778`), not a `<section>`,
so the locator matches nothing and every test in the file errors in its shared
`orchestrationRow()` helper. Not a fixture problem — the tag simply changed.

**Consequence for the fullscreen work:** this file is the natural home for the new
guard. Rewrite it to assert the full-bleed contract; do not delete it.

## 2. The guard the run page's docblock claims does not exist

`src/app/runs/[runId]/page.tsx:57` says:

> That number is defended rather than trusted: `run-canvas.browser.spec.ts` fails
> if this page ever acquires a vertical scrollbar

```
$ ls tests/run-canvas.browser.spec.ts
No such file or directory
```

The `--run-chrome` subtraction is **unguarded**. Signature defect, in the comment
claiming protection rather than in code.

---

## 3. Why the canvas is cut off at the sides — root cause

`app-shell.tsx:105`:

```tsx
<main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4">{children}</main>
```

The run page cancels `main`'s **padding** (`-mx-4 -mt-4`) but nothing cancels the
**1440px cap**. On a ~2000px window the canvas is 1440px centred, leaving ~280px
of dead gutter each side — exactly what the screenshot shows.

Two constraints on the fix:

- `max-w-[1440px]` is shared with the header and footer, and `/` (new ticket)
  **wants** the cap — a 2000px-wide textarea is worse. The escape must be scoped
  to `/runs/[runId]`.
- `--run-chrome` encodes `main`'s bottom padding. Change main's box for this route
  and that arithmetic moves with it, or the page gains a scrollbar — with no spec
  to catch it (see §2).

**Still open:** whether the clipped DESIGN node is a *second* cause in the fitView
/ 360px left-reserve logic (`orchestration-canvas.tsx`, `layout.ts`). A wider pane
does not fix a fit that never included the rightmost node. Verify separately.

---

## 4. `ui-designer` on the canvas is CORRECT. The real gap is the author seat.

The owner asked whether the design node should be the taste agent. The node they
pointed at reads "Score and choose Coglane design reference" — that is the
**auto-chooser**, doing its own job, and the split is already deliberate:

```
server/src/build-prompt.ts:175  design/taste-frontend-expert  "owns the art direction"
server/src/build-prompt.ts:176  design/ui-designer            "tokens only; it must not author what it later grades"
server/src/design-prompt.ts:360 VISUAL_GATE_AGENT  = "ui-designer"
server/src/design-prompt.ts:361 VISUAL_GATE_AUTHOR = "taste-frontend-expert"
```

That matches HANDOVER §7 and the owner's own rule: `ui-designer` is the visual
gate and the design-lock chooser and must never grade art direction it authored.

**But `taste-frontend-expert` never ran in this run.** Full `graph_agent` census
from the DB — 13 events, and only three carry an agent name at all:

```
00:48:19 n1   orchestrator      -       exact
00:49:16 n2   (null)            -       inferred  Generate hero section design reference image
00:49:44 n3   (null)            -       inferred  Generate services section design reference image
00:50:18 n4   (null)            -       inferred  Regenerate services section with cleaner short copy
00:50:49 n5   (null)            -       inferred  Generate opening hours section design reference image
00:51:21 n6   (null)            -       inferred  Generate booking modal section design reference image
00:51:55 n7   (null)            -       inferred  Generate booking confirmation state design reference
00:53:27 n8   context-manager   spec    exact     Gather design context for ui-designer
00:54:00 n9   ui-designer       design  exact     Score and choose Coglane design reference
00:55:46 n1   orchestrator      -       exact
01:00:12 n10  (null)            -       inferred  Start local static server on port 3000 (background)
01:08:11 n11  (null)            -       inferred  Search filesystem for any self-report schema/template
01:11:11 n12  (null)            -       inferred  Locate the bakeoff runner.js source defining WORKSPACE
```

- `graph_agent` events naming `taste-frontend-expert`: **0**
- Agent-tool calls in the entire run: **2** — `context-manager`, `ui-designer`
- The only mentions of `taste-frontend-expert` are in `graph_inventory.allowedAgents`
  — it was **permitted and never spawned**

The art direction was authored by the **orchestrator inline** on `n1`: its node
carries the `imagegen-frontend-web` and `image-to-code-skill` skill chips, and the
six `gemini-image.sh` calls are its own Bash calls. `n2`–`n7` are hook-attributed
children with no agent identity, which is why they render as UNMAPPED.

So the canvas is telling the truth. The routing is what is off: the seat that is
supposed to own art direction was never used, so `ui-designer` scored images the
orchestrator made.

**Absence-claim discipline:** `events.txt` **does contain NUL bytes** — verified —
so the first pass with plain `grep` could have silently skipped it. Every count
above was re-taken with `grep -a` or read straight from SQLite.

---

## 5. Timestamps for the timeline already exist — and are dropped at the SSE boundary

```sql
CREATE TABLE events (
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      TEXT NOT NULL,   -- <-- already recorded, every event
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID
```

388 events for the Coglane run, `at` populated from `23:28:46.666Z` to
`01:13:39.767Z`. But **no event payload on the wire carries a time field** —
`grep -o '"\(at\|ts\|time\|timestamp\)":'` over the SSE stream returns nothing.
The column is written and never served.

The raw material for "what it was looking at, in order" is already good:

```
00:48:18 log   the DESIGN lane runs in FULL mode: stills, a manifest, and a locked reference
00:49:13 tool  Bash  gemini-image.sh "A premium website design comp — hero section for 'Coglane'…"
00:49:22 tool  Read  design-refs/01-hero.png
00:49:41 tool  Bash  gemini-image.sh "A premium website design comp — services section…"
00:49:56 tool  Read  design-refs/02-services.png
00:50:15 tool  Bash  gemini-image.sh "…services section…"   (the regenerate)
00:50:28 tool  Read  design-refs/02-services.png
```

That is readable as "generating the hero reference → looking at it → generating
services → looking at it → regenerating services" with real clock times.

**The trap:** timestamping on client receipt looks perfect on a live run and is
silently wrong on replay, where all 388 events arrive in one burst and every row
gets the same time. **Carry `at` through the payload; never synthesize it.** The
discriminating test is the historical Coglane run, not a live one.

**Second gap:** `GraphNode` has no ordered activity. `tools` is
`GraphToolPill[]` — aggregated `{name, count}` — so per-node chronology does not
survive the reducer. A new ordered field is required; it is not a pure UI change.

---

## 6. There is no owner→run message channel today

The only channel is `POST /api/runs/:id/resume` with an optional `chosenMockup`
string. No message table, no free-text intake, no image intake for a run.
`interactive` on `runs` is **design-lock policy only** (`design-lock.ts:48`), not
a chat flag.

`secret-intake.ts` is the precedent for multipart file intake.

So the orchestrator chat is a new subsystem, not a UI surface over existing
plumbing. Its scope turns on one question: does it steer a run **mid-flight**, or
**the next run**?

---

# DELIVERED — 2026-07-30

## Test movement, against the baseline in §0

| | Before | After |
|---|---|---|
| client browser+unit | 13 failed / 73 passed | **10 failed / 94 passed** |
| server | 907 / 905 (per HANDOVER §8) | **911 tests / 901 pass / 0 fail / 2 skipped** |

- `run-layout.browser.spec.ts`'s 3 failures are **fixed** — rewritten as the
  full-bleed guard, 5 tests, all green.
- +21 client tests (16 `activity.unit.spec.ts`, 5 `run-layout.browser.spec.ts`),
  +4 server tests (the `ACTIVITY:` block in `graph.test.ts`).
- **The 10 remaining client failures are the pre-existing drift from §0** —
  `canvas-edges` (6), `code-browser` (4). Untouched, root-caused below.
- The 8 `calibration.test.js` errors are **Docker being down**, not a regression.
  That suite deliberately fails rather than report a green it did not earn.

## 1 + 2 — the canvas is full-bleed, and the guard is real

`AppShell.isFullBleed` drops the cap and padding for `/runs/<id>` only. Measured at
a 2000px window: gutters **280 → 0**, and the fit went **scale 0.63 → 0.98**, so the
recovered 560px is spent on the graph rather than left empty.

`--run-chrome` is **deleted**. A measured constant defended by a spec that did not
exist; the shell flex-fills now, so there is no number left to drift.

A resize re-fit was needed alongside it: the fit ran **once** on mount, so a
full-bleed pane that changed size kept a transform computed for the old one. It now
re-fits on a material resize and **latches off permanently** the first time the
reader pans, zooms or drags — `onMoveEnd` with a non-null event is what distinguishes
a user gesture from our own `fitView` (confirmed against the API reference).

**Negative control executed.** Mutating `isFullBleed` to `return false` turned the
two assertions red for the intended reasons —
`dead space on the left  Expected: 0  Received: 280` and
`scale  Expected: > 0.7  Received: 0.610837` — while the 1440px control stayed
green, because at exactly 1440px a cap and no cap are the same box. Restored, green,
mutation string confirmed absent with `grep -a`.

**Also executed:** a real wheel gesture then a resize, proving the latch — transform
unchanged after the resize, and the pan confirmed to have moved it first, so the
test could have failed.

## 4 — the taste routing

`ui-designer` on the canvas is **correct** and doing its own job. The real gap is
that `taste-frontend-expert` was allowed and never spawned. Owner chose to fix the
routing; carried below.

## 5 — the timeline

- `bus.ts` writes `{...stored.event, at: stored.at}`; `SseWireEvent` is the type.
- `graphSnapshot` passes `{...row.event, at: row.at}` — it had been dropping the
  column two expressions after reading it.
- `GraphNode.activity` / `activityDropped`, capped at 400 with the overflow counted.
- `src/lib/activity.ts` humanises a call into `generating hero section reference` /
  `looking at 01-hero.png`, and **prints unknown tools as themselves** rather than
  dressing them in a plausible verb.
- `AgentInspector` opens on the timeline; SDK ids, the inferred-attribution caveat
  and the not-reported rows sit in a **shut `<details>`** — demoted, not deleted.

**Verified on the historical run, the only case that discriminates:** 388/388 events
carry `at`, **304 distinct timestamps spanning 104.9 minutes**. A client-side arrival
stamp — the shortcut this deliberately avoids — would have collapsed all of them to
one value and looked perfect on a live run.

**Verified in the browser:** the orchestrator panel reads
`02:49:13 generating hero section reference` → `02:49:22 looking at 01-hero.png` →
`02:49:41 generating services section reference`; and the SDK note is **not visible
until the disclosure is opened, then is** — demote-not-delete proven both ways.

**A defect found by looking at the render, not by a test.** The panel showed
`loading skill imagegen-frontend-web ×2`: the CLI reports one skill load down two
channels 3ms apart (`seq 25 …27.829Z` tool, `seq 27 …27.832Z` graph_skill), so exact
timestamp equality missed it. `SAME_ACT_MS = 250` catches it, chosen against the
measured other side of the gap — the closest two genuinely distinct steps in that run
are **9 seconds** apart, because every real step waits on a subprocess. Both-null is
explicitly NOT "the same instant", or every real repeat on every pre-timestamp run
would be silently swallowed.

## A trap re-created and recorded

Putting `ACTIVITY_CAP` in `server/api-types.ts` turned an erased `import type` in
`graph.ts` into a real runtime import, and the run page 500'd with
`Module not found: Can't resolve './api-types.js'` while `tsc` stayed **green**. This
is the exact hazard `src/lib/graph.ts` documents at length. The caps live in
`graph.ts` beside `PILL_KINDS_CAP` — which is why that constant was there already.

---

## 6 — the design routing, fixed at the prompt (READ-VERIFIED, NEVER EXECUTED)

**The cause, found by reading rather than inferred from the symptom.**
`VISUAL_GATE_AUTHOR = "taste-frontend-expert"` was exported and **never placed in
any prompt**. Its only non-declaration reader was `design-prompt.test.ts:402`,
asserting it differs from `VISUAL_GATE_AGENT` — an assertion that passed for the
whole life of the file while the production path ignored the constant.

Meanwhile the `IMAGE GENERATION` block addresses the orchestrator in the **second
person** throughout — "Use the local tool", "you never need one", "After each
generation, Read the image file and critique it", "the aspect is decided when *you*
generate the still". The only delegation the prompt asks for is the CHOOSING step
("Delegate to `ui-designer` — not to yourself"), which the run performed correctly.

So the pipeline was doing exactly what it was told. The author/grader split held in
the letter and failed in fact: **HANDOVER §3's "the assertion and the production
path were never connected", verbatim.**

**The fix** is a `WHO AUTHORS THIS` block in the non-degraded branch that delegates
authoring to `VISUAL_GATE_AUTHOR`, mirrors the wording of the choosing instruction
the orchestrator already obeys, and states that `VISUAL_GATE_AGENT` must not be the
author. Four tests added; the degraded branch is asserted NOT to ask for it, because
a degraded lane has no stills to author.

**Mutation executed:** removing the block turned exactly the 3 new tests red and
left the other 34 green. Restored, 37/37, probe string confirmed absent with
`grep -a`.

**THE CEILING, STATED PLAINLY: these tests assert the prompt ASKS.** Whether the
model then delegates can only be established by a real run, which spends
subscription quota and needs a Docker daemon for the gate (currently down). This is
read-verified and never executed — the same honesty STATUS §7 applies to
`orchestrator.ts:1663-1665`. **The first real run after this change should be checked
for a `graph_agent` event naming `taste-frontend-expert`;** if none appears, suspect
HANDOVER §4's "`Options.agents` does not bind for any name that exists on disk"
rather than the prompt.

---

# STILL OPEN

1. **The mid-flight orchestrator chat.** Owner chose park-and-inject: message +
   images into the running session at a safe boundary between agents, orchestrator
   re-plans the remaining agents, canvas redraws. Needs a messages table, image
   intake (`secret-intake.ts` is the multipart precedent), a park boundary and an
   injection point. New subsystem — nothing to extend.

   **THE DESIGN DECISION IT BLOCKS ON, and it is not a wiring detail.** The
   acceptance suite is authored before any code exists and **frozen by content
   digest**; `heldOutPass` means "the suite it never saw went green". If the owner
   changes the brief mid-run — "make the hero warmer", "drop the booking modal" —
   the frozen suite may no longer describe what was asked for, and then:

   - grading against the ORIGINAL suite can fail a run for correctly doing what it
     was newly told, and
   - re-authoring the suite mid-run destroys the property the whole tool exists for,
     because a suite written after the redirection is no longer one the builder
     never saw.

   Neither is obviously right. This is the same shape as HANDOVER §5's open question
   ("someone must decide what `heldOutPass` should mean when a test needs the
   internet") and it needs the same kind of answer before the chat is built.
   Candidates worth weighing: freeze a NEW suite and record the run as
   two-phase; restrict mid-flight chat to changes the suite is agnostic about
   (art direction, copy tone) and refuse ones that touch a criterion; or let the
   verdict carry "brief amended at T, suite frozen at T-1" and stop claiming a
   single boolean.

2. **The 10 pre-existing client failures**, now root-caused:
   - `canvas-edges` (6) — the redesign renamed every edge class to `conduit-*`
     (`conduit-rim`, `conduit-casing`, `conduit-core`, `conduit-comet`); the spec
     still waits on `path.edge-core--flowing`, which **matches nothing**.
   - `code-browser` (4) — `CodeBrowser` moved into `RunSheet`'s Code tab; the spec
     still expects it inline on the run page.
   Neither is a product defect; both are specs the redesign left behind.
4. **HANDOVER.md needs two corrections** — §6's claim that
   `run-layout.browser.spec.ts` "still passes", and §8's implication that the client
   suite is green.

---

# ITERATION 2 — 2026-07-30, second round of owner feedback

Client **10 failed / 95 passed** (same 10 pre-existing). Server **915 / 905 / 0 fail
/ 2 skipped**. Both typecheck clean.

## The design-lock wall of text

`Recorded reason:` was a `<span>` inside the SAME `<p>` as the host's own sentence,
and on the real run that string is **480 characters** of semicolon-joined clauses.
Run together and then clipped by the dock's 132px cap, it ended mid-word.

Now its own bordered block, labelled `ui-designer's recorded reason`, clamped to
three lines with **`unfold the whole reason (N sentences)`**. Open state splits on
sentence ends only — `. ` followed by a capital — which is the one break that cannot
invent structure the author did not write; a semicolon split would be the component
deciding where the argument turns. Dock cap raised 132/200 → 200/380, which it can
afford now that the panel is short by default.

## The timeline folds

111 steps → 97 rows was a wall. Folded to the **last 12** with
`show 85 earlier steps`. The TAIL, not the head: the owner asked for "what he is
looking at right now", and on a running agent that is the last row. **Known
trade-off:** on a FINISHED run the tail is the least interesting part (the recorded
run ends in `cd`/`grep`/`sed`), so the interesting design work is behind the fold.
Worth revisiting — a "jump to the design work" affordance, or head-and-tail with the
middle folded.

## The footer is gone

"Bound to 127.0.0.1. Single user. Not reachable off-machine. · Work is produced by an
autonomous AI agent, not a human." — disclosure a PUBLISHED tool owes strangers, on
every screen of a tool with no strangers. The bind is still enforced in code (exit 2
on any other host) and stated in the README.

**Swept for the same class and cut two more:** the auth panel's "Claude runs from
your own plan login. No API key is involved.", its "Claude Agent SDK, driven as a
subprocess" row detail, and the model picker's "A subscription consumes quota, so no
run here carries a dollar cost." — that was the THIRD restatement of the same fact on
one screen. Kept, trimmed: the ticket field's "how you will know it works", because
that sentence is what the acceptance suite is authored from, so it changes the output
rather than describing the input.

## The orchestrator chat — BUILT

- `messages` table. **`delivered_at` is the design**: NULL while queued, stamped when
  folded into a prompt. Keeps *queued*, *taken up at T*, and *never seen because the
  run ended* apart — a boolean would collapse the third into the first and the owner
  would believe a redirection landed that no builder read.
- `GET|POST /api/runs/:id/messages`. Images as base64 data URLs → written under
  `runs/<id>/chat/`, and the ROW STORES PATHS (the builder needs a path to `Read`; a
  2MB PNG has no business in SQLite). Caps: 6 images, 8MB each, 8k chars.
  **POST to a terminal run is refused 409** rather than queued into the void.
- Text goes through `redactForPersistence` — an owner pasting a key into a chat box
  is exactly the mistake `secret-intake.ts` exists to prevent, and this text reaches
  both SQLite and a subprocess prompt.
- Drained in `orchestrator.ts` **at the segment boundary**, where the prompt is
  composed from durable rows anyway. Marked delivered only AFTER the prompt is
  written to disk: losing a stamp re-injects an instruction (visible, harmless);
  losing an instruction is not.
- UI at the TOP of the node panel, on the ROOT session only — a sub-agent is spawned
  with a prompt and ends, so a chat box on one would be a control that cannot act.
  Verified in the browser: order is `STEER THIS RUN` → `TIMELINE` → `TECHNICAL
  DETAILS`, chat absent on `context-manager`, and a finished run shows "no next agent
  to brief" with no composer.

**Why "at the next boundary" and not truly mid-step:** there is no supported way to
push a turn into a running Claude Agent SDK session from outside it, and killing the
subprocess to restart it with more text would discard the session the two build
segments share (proved by token totals that SUM rather than max). The UI says exactly
this rather than implying a live conversation.

**THE FROZEN-SUITE QUESTION, ANSWERED WITH A CONSERVATIVE DEFAULT.** The owner did
not pick from the three options, so `owner-message.ts` takes the safest: the prompt
tells the builder the suite is frozen and unseeable, to apply the instruction wherever
the suite is indifferent (art direction, palette, copy, layout), and — where an
instruction contradicts an original requirement — to do what it safely can, keep the
requirement working, and **name the conflict in its summary**. Never to weaken a test
to fit. This keeps `heldOutPass` meaning exactly what it always meant. **It is a
default, not a decision** — the three options stand and the owner should still pick.

**Tests:** 3 new store tests prove the at-most-once guarantee (pending → stamped →
never pending again), that a `run`-authored message is never re-injected into the
run's own prompt, and that re-stamping does not move a delivery time.

**NOT EXECUTED END TO END.** No live run has been steered — that needs quota and a
Docker daemon for the gate. The queue, the refusals, the drain ordering and the
prompt block are unit- and curl-verified; the model actually obeying a mid-run
instruction is not. First real run should check the trace for
`owner message(s) folded into the … segment prompt`.

---

# ITERATION 3 — the streaming-input switch, and a claim I got wrong

Server **925 tests / 915 pass / 0 fail / 2 skipped**. Client **10 failed / 95 passed**
(same 10 pre-existing). Both typecheck clean.

## THE CORRECTION

I wrote, in code comments and to the owner: *"there is no supported way to push a turn
into a running Claude Agent SDK session from outside it."* **That was false, and I
asserted it without testing it** — the exact thing CLAUDE.md rule 2 forbids.

From the installed `@anthropic-ai/claude-agent-sdk@0.3.220` `sdk.d.ts`:

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;   // streaming input
  options?: Options;
}): Query;

// SDKUserMessage:
priority?: 'now' | 'next' | 'later';
shouldQuery?: boolean;  // "appended to the transcript without triggering an assistant
                        //  turn. It will be merged into the next user message that
                        //  does query."
```

There is a whole documented queue behind it: `interrupt()` returns `still_queued` —
"uuids of async user messages that WILL still run unless cancelled first" — plus
`cancel_async_message`, batch coalescing, and `interrupt_receipt_v1` /
`interrupt_cancel_queued_v1` capability flags on `system/init`.

**The limitation was OURS**: `SessionFactory` narrowed `prompt` to `string`
(`claude-builder.ts:1255`), so a single-shot string had nowhere to put a second
message.

## The switch

- `SessionFactory.prompt` widened to `string | AsyncIterable<SDKUserMessage>`.
- `live-input.ts` — `LiveInput`, a queue whose async iterator **parks** rather than
  completing. Default delivery is `shouldQuery: false` (`merge`), the terminal's
  behaviour: the message lands between steps and **cannot arrive mid-tool-call**.
  `priority: 'next'` is offered, not assumed.
- `BuildRequest.liveInput?` — present only for a dashboard run. Absent means the old
  single-shot call, byte-identical, which is what every test and the bake-off want.
- The builder closes the channel in its `finally` — the SDK ends a session when its
  input iterable completes, so this is what lets the subprocess exit, on the abort and
  throw paths too.
- `Orchestrator.pushLiveMessage(runId, …)` over a per-segment channel map;
  `POST /api/runs/:id/messages` tries it first and stamps `delivered_at` **only if it
  landed**, falling back to the boundary drain otherwise.

**BOTH PATHS STAY, and that is not redundancy.** Live covers a message sent while a
segment runs. A message sent while the run is PARKED (`awaiting_input`,
`rate_limited`) or between segments has no open session, so the boundary drain carries
it. Exactly one path stamps `delivered_at` → at-most-once across both.

## The failure mode this was built around

A generator that RETURNS after the first prompt ends the session — producing a run
that **stops after one turn with no error anywhere**. The log looks like a short run,
not a broken one. So `live-input.test.ts` asserts **pending-ness**, not output: after
the first `next()`, the second must not settle.

**Mutation executed:** replacing the park with `return` turned exactly the two park
tests red (`the iterator completed on an empty queue — the SDK would end the session
here`) and left the other five green. Restored, 7/7, probe absent via `grep -a`.

## Chat discoverability — two real UI misses

1. **"i dont see any chat anywhere."** The chat was rendering, but on a TERMINAL run I
   had replaced the composer with a single sentence. The owner's only run is finished,
   so the feature was invisible in the one state he could look at. **A feature
   invisible in the state the reader happens to be in is not tidy, it is missing.** The
   box is now always rendered, `disabled` with the reason on it.
2. **Named "Steer this run".** He could not find it under the clever name. It is now
   **"CHAT"**. A section heading is a label, not a statement of intent.

## Images — yes, and how

Paste, drag-drop, or `attach images`. Up to 6 per message, 8MB each, png/jpeg/webp/gif.
Written to `runs/<id>/chat/`, and the row stores **paths**. The prompt names each
absolute path with an explicit "Read each one before acting" — the §7.3 mechanism-2
rule, because naming a file without telling the agent to open it produces a run that
acknowledges an attachment it never looked at.

## Still open

- **Not executed end to end.** No live run has been steered — needs quota and Docker.
  Unit-, mutation- and curl-verified only. First real run: check the trace for
  `owner message delivered into the running session`.
- The timeline fold shows the TAIL, which is wrong-ended on a finished run.
- The 10 pre-existing `canvas-edges` / `code-browser` spec failures.

---

# ITERATION 4 — two asks, and a stale field that matters

## FINDING: `previewUrl` IS RECORDED AND DEAD

`RunDetail.previewUrl` for the recorded run is `"http://127.0.0.1:4321"`. Nothing is
listening there:

```
$ lsof -nP -iTCP:4321 -sTCP:LISTEN     → nothing
$ curl http://127.0.0.1:4321           → Failed to connect
```

The process that served it was started by the run and **died with it**. The field is a
HISTORICAL RECORD of an address that was once live, not a live address — and nothing in
the type or the name says so. Any UI that links to `previewUrl` links to nothing, which
is this repo's signature defect wearing a new hat: a value that looks like a capability
and is a memory.

**The artefact itself is intact on disk**:
`runs/<id>/workspace/{index.html,styles.css,script.js,assets/}`.

**So the result node must NOT link to `previewUrl`.** It should link to a route the
DASHBOARD serves from the workspace, which is always available because the dashboard is
the thing being asked. `GET /api/runs/:id/files` already reads that tree through
`code-files.ts`'s containment refusals, but it serves file TEXT for the code browser —
a browsable site needs correct content types and relative-asset resolution, i.e. a
sibling route (`GET /api/runs/:id/preview/*`), reusing the same path-containment module
rather than a second one.

## ASK: a terminal "result" node

After the last agent, a node carrying the outcome (`passed` / `heldOutPass` /
`falseFinish`), clickable to open the built site. Design notes:

- It is NOT a `graph_agent` — no agent produced it, and minting a fake node id would
  put a non-agent into a graph whose every invariant is keyed on `graph_agent` arriving
  first. It should be a synthetic node the LAYOUT adds from `RunDetail`, in the same way
  the folded group is a layout construct rather than an event.
- It must distinguish "the site is servable" from "the gate could not run"
  (`heldOutPass: null`) — the existing `null ≠ false` rule.
- On a run whose workspace has been deleted it must say so rather than 404 on click.

## ASK: adjustments to a FINISHED run

The owner's question: *"what if I want to make some adjustment? How would I do that if I
can't talk to the orchestrator?"*

A finished run genuinely cannot be reopened: the builder session is gone, the verdict is
written, and the suite is frozen and already graded. Resuming it would either regrade
against a suite that no longer describes the ask, or re-author the suite after the fact
— the two outcomes the frozen-digest design exists to prevent.

**So the answer is a FOLLOW-UP RUN, and it should be one click from this chat**:

1. The composer on a finished run stays enabled, and `send` becomes
   **"start a follow-up run"**.
2. It creates a NEW run whose ticket is the original brief + this instruction (+ the
   attached images), and whose workspace is **seeded from the finished artefact**, so
   the agent adjusts rather than rebuilds.
3. A fresh suite is authored and frozen for the new brief — which keeps `heldOutPass`
   meaning exactly what it means today, because the builder still never sees it.
4. The new run records its parent, so the canvas can show a chain rather than an
   unrelated second run.

Step 2 is the only real unknown: `createRun` starts from an empty git-initialised
workspace, so seeding needs a copy step and a decision about whether the follow-up
inherits the parent's design lock (it should — otherwise "make the hero warmer" reopens
art direction that was already settled).

**Not built. Out of session room; documented rather than half-wired.**

---

# ITERATION 5 — lightbox, and the wall of text

Client **10 failed / 99 passed** (same 10 pre-existing; +4 tests). Server unchanged at
**925 / 915 / 0 fail**. Both typecheck clean.

## Lightbox — and a stacking-context bug I asserted away

`Lightbox` in `ui.tsx`: click a settled mockup → full-screen, `object-contain`,
dismissed by **×, backdrop click, or Escape** (Escape wasn't asked for; a modal that
traps the keyboard is broken regardless). Enlarges 156px → **1376×768**.

Only shown when the deck is NOT asking for a choice: while `pending`, an invisible
full-card button means "build to this one", and two overlapping targets is how an owner
locks a design when they meant to look at it.

**THE BUG, found by measuring rather than by the spot check that passed.** My first
version's docblock said *"not a portal, and that is a deliberate limit: `fixed inset-0`
with a high z-index escapes the canvas without one."* **`z-50` does not escape a
STACKING CONTEXT.** The lightbox renders from a card inside the run page's HUD wrapper
(`absolute … z-10`), so its `z-50` resolved *within* z-10 and lost to the shell's
`sticky top-0 z-20` header:

```
elementFromPoint(15, 15) → the header's div, not the backdrop
```

So a click on the top strip never reached the backdrop, and the image was painted
*under* the nav. Clicks lower down closed it correctly — exactly the kind of
half-working a single check passes. Fixed with `createPortal(…, document.body)`, guarded
for SSR. Verified: `elementFromPoint(15,15)` is now the dialog, and all three dismiss
paths close it.

## "What it reported" and the SDK ids

`readableSummary()` in `activity.ts` — a SUBSTITUTION, never a paraphrase, so the label
"what it reported" stays true. Absolute paths → basenames, markdown emphasis/bullets/ATX
headings stripped, whitespace collapsed. Clamped to two lines with `more`.

**SDK REFERENCE section deleted.** `task a775113161fe8998e` / `toolu_01Br5g…` existed for
cross-referencing a raw transcript by eye. Distinguished from the `inferred` attribution
note, which STAYS: that one is a claim about how much the graph knows ("a considered
guess, not a fact"), and removing it would let an inferred edge read as measured. These
ids assert nothing about correctness.

**A SECOND BUG I INTRODUCED AND CAUGHT IN THE BROWSER.** The first path regex was
unanchored, so it ate any slashed text:

```
"plain HTML/CSS/JS, no build step"  →  "plain HTMLJS, no build step"
```

Silent CONTENT CORRUPTION — worse than the wall of text it was cleaning, because it
reads as something the agent wrote. The slash must now START the token (string start,
whitespace, or an opening quote/paren), so `HTML/CSS/JS` survives and
`/Users/…/choice.json` still collapses. Two tests pin it, including the mixed case.

## Gap audit

Workflow `wf_d6f6bf9e-4fd` launched — 5 surfaces mapped, 6 lenses (first-run,
finished-run, design-quality, stuck-states, noise, journey), each gap adversarially
verified against "already built" and "already known open", then deduped and ranked.
Writes `docs/UX-GAPS-2026-07-30.md`. **Still running at time of writing.**

---

# ITERATION 6 — tidy up, and why a new run's canvas is empty

## "why is there no orchestrator showing?" — ANSWERED, and the message was wrong

Measured on the live run `run-2026-07-30T13-31-38-076Z-c228e63b` while it was in the
SPEC phase, 57s old:

```
status running | phase spec
graph_agent events: 0  of 6 total events
```

**The orchestrator node is minted by the BUILD segment.** While the acceptance suite is
being authored, audited and frozen there is no builder session, so no `graph_*` events
exist to fold. Nothing is broken — the graph has not started.

**But the empty state claimed otherwise**: "This run emitted no graph events. Runs
recorded before the canvas existed, and runs on the Codex provider, contain none."
Every clause of that is FALSE about a 57-second-old Claude run, which is why it read as
a bug. One message was serving three different facts.

Now three states, keyed on a new `runIsActive` prop (the canvas is handed a
`GraphState` and cannot tell a live empty graph from a dead one — same value, different
facts):

- **live + empty** → "The agents have not started yet — the acceptance suite is being
  written and frozen first… The graph appears as soon as the build starts."
- **only housekeeping** → unchanged.
- **terminal + empty** → the historical explanation, which is now only shown when true.

**Worth revisiting:** the canvas is blank for the ENTIRE spec phase, which on the
recorded run was ~80 minutes of a 104-minute run. Explaining the blank is the honest
minimum; showing the spec/audit seats as nodes would be better, and is a candidate for
the gap audit's list.

## Auto-organise

`tidy` in `orchestration-canvas.tsx` + a **`tidy up`** button in the top-right cluster.
Clears `draggedRef`, releases the `viewAdjusted` latch, and re-fits.

**WHY AN EPOCH WAS NEEDED.** `draggedRef` is a REF on purpose — React Flow emits a
position change per pointer move, and putting them in state would re-run the node
builder sixty times a second. The cost is that emptying the map changes nothing on
screen: React never subscribed to it, so the node memo keeps returning cards at their
dragged positions. `layoutEpoch` is in that memo's dependency list and is the only
thing that forces the rebuild.

The button appears only once something has been moved (`moved > 0`, mirrored from the
ref's size on drag-stop) — a control that does nothing teaches the reader to distrust
the others.

**NOT VERIFIED IN THE BROWSER.** The Playwright MCP browser hit a
`Browser is already in use` lock and I could not reacquire it. Typecheck is clean and
the client suite is unchanged at **99 passed / 10 pre-existing failures**, but the
drag → tidy → back-to-layout cycle has NOT been executed. That check should be the first
thing run next session:

```
drag a card >100px, assert the tidy button appears, click it,
assert the card is within ~40px of its layout position and the button is gone.
```

---

# ITERATION 7 — the gap audit, and the bug it found in my own work

Client **10 failed / 103 passed** (same 10 pre-existing). Server unchanged.

## THE AUDIT'S #1 FINDING WAS A DEFECT I SHIPPED, and it is fixed

`parseRunEvent` — the CLIENT's SSE parser — rebuilds `graph_tool` and `graph_skill`
field by field and **did not carry `at`** (`use-run-stream.ts:383-403`). So every step
that arrived WHILE WATCHING A RUN folded to `at: null` and the timeline printed an em
dash. Only steps already durable at page load had times, because those come from
`graphSnapshot`'s server-side fold.

**Why my verification could not catch it.** ITERATION 2 recorded: "388/388 events carry
`at`, 304 distinct timestamps spanning 104.9 minutes — PASS". That was a REPLAY of a
finished run, which exercises `graphSnapshot`. There are TWO paths into the graph and I
proved the property on one of them, then wrote it up as though it held generally.

**This is this repository's signature defect, committed by the person correcting it.**
Not a check that could only observe success — a check aimed at the wrong path.

Fixed: `atOf(record)` spread into both cases; spread rather than assigned so a frame
with no `at` yields a MISSING key (what `exactOptionalPropertyTypes` and `instantOf`'s
`"at" in event` both require), and a non-string `at` is refused rather than reaching
`new Date()`.

`parseRunEvent` is now **exported and tested directly** — `tests/live-parse.unit.spec.ts`,
4 tests. Nothing could reach that function from a test before, which is why nothing did.

**Mutation executed:** removing the spread turned exactly the two timestamp tests red
("the live parser dropped `at`, so every step arriving during a run showed no time")
and left the two structural tests green. Restored, 4/4, probes absent via `grep -a`.

## The audit itself

`wf_d6f6bf9e-4fd`: 47 agents, 5 surfaces mapped, 6 lenses, every gap adversarially
verified against "already built" / "already known open" before counting. **29 confirmed,
deduped to 20.** Full ranked report at `docs/UX-GAPS-2026-07-30.md`.

FIX NEXT (its ranking, minus #1 which is now done):

2. `Resume` is dead on `failed` runs and DESTRUCTIVE during a design park — a click
   there resumes with no body and locks the first mockup as "no judgement applied",
   silently discarding the only creative decision the tool asks for. One edit.
3. Four shipped strings say the chat does not exist ("The dashboard API exposes no
   channel to answer"). Sequencing matters: for a parked run it is "answer, THEN
   resume", never "or".
4. The Verdict tab opens on five AI mockups; the three captures of the actual site come
   last, small, and open by dumping a raw PNG into a new tab — while the mockups get the
   in-app Lightbox.
5. No way to say anything to a run for its first ~80 minutes: the composer needs a
   selected node, and no node exists until the build segment.
6. Nothing checks Docker or the scorer image until AFTER the build — with Docker down
   you lose ~1h45 and get `unscored`, and `failureReason` is not on `RunDetail` so the
   cause is only in the raw trace.

THEN: queued-run empty state, live "what it is doing now" on the card, design-park
disclosure on the ticket form, offline-grading disclosure.

---

# ITERATION 8 — WHY THE TICKET FAILED. Diagnosis, not yet fixed.

Run `run-2026-07-30T13-31-38-076Z-c228e63b`, ticket "make an identical copy of
https://kamilborzecki.dev". **Failed after 9m 37s, still in the SPEC phase.**

```
status : failed | phase spec
failure_reason:
  the spec seat (default) call "suite-authoring t-c3c28b7f043e91fe attempt 1"
  failed: Claude Code process aborted by user
```

## The sequence, from the events table

```
13:31:38  status running
13:31:38  log    authoring the held-out acceptance suite…
13:31:40  rate_limit  {"retryAfterSec": 253699}      <-- 2 SECONDS IN. 70.5 HOURS.
13:41:15  log    …failed: Claude Code process aborted by user
13:41:15  status failed
```

## Four things are wrong, and three of them are lies to the reader

1. **`retryAfterSec: 253699` = 70.5 hours, emitted 2 seconds into the run.** A weekly
   cap signal. **The subscription is NOT capped** — probed directly this session:
   `claude -p 'reply with exactly: OK'` → `OK`. So either the value is misparsed, or a
   stale/whole-window figure is being read as "retry after".
2. **"aborted by user" — no user aborted anything.** The owner watched it die. Whatever
   killed the subprocess is inside this program, and the message blames the operator.
3. **The status is `failed`, not `rate_limited`.** If a rate limit is the cause, the run
   took the wrong terminal branch — `rate_limited` is resumable and carries a countdown;
   `failed` is neither.
4. **NONE of this reaches the screen.** `failureReason` is written to the `runs` row and
   is NOT on `RunDetail` (audit gap #6), so the UI showed: a dead `Resume` button (audit
   gap #2 — `orchestrator.ts:560` refuses resume on `failed` 100% of the time), and the
   canvas's historical empty-state copy about "runs recorded before the canvas existed,
   and runs on the Codex provider" — false about a 9-minute-old Claude run.

The owner's verdict is exactly right: **"make sure when i start a ticket it works, not
lies to me."** The failure may or may not be the dashboard's fault; the SILENCE about it
definitely is.

## Where to look next — narrowed, not guessed

- `orchestrator.ts:2585-2605` is the only emitter of `rate_limit`/`retryAfterSec`.
  Find what feeds `state.retryAfterSec` and whether 253699 is a *retry-after* or a
  *window length* being misread as one.
- `bakeoff/src/anthropic-seat.ts` runs the spec seat
  (`spec-agent.ts:877` sets the `suite-authoring …` purpose). "Claude Code process
  aborted by user" is the SDK's abort message — find which AbortController fires, and
  whether the rate-limit handler is what trips it after ~9.5 minutes.
- Then decide the terminal branch: a rate-limited spec seat should land `rate_limited`
  (resumable, countdown), never `failed`.

## Ranked work remaining (audit list + this)

0. **THIS.** A ticket that dies in spec with a false reason and a dead button is the
   whole product failing. Ahead of every cosmetic item.
1. ~~live timestamps dropped at the parser~~ — DONE, iteration 7.
2. `Resume` dead on `failed` / destructive during a design park.
3. Four strings claiming the chat does not exist.
4. Verdict tab opens on mockups, not the product.
5. No chat entry point for the first ~80 minutes.
6. No Docker/scorer preflight; `failureReason` not on `RunDetail`.
7-20. See `docs/UX-GAPS-2026-07-30.md`.

**NOT STARTED. Out of context this session — recorded so the next one starts here
rather than re-deriving it.**

## Abort investigation — where it stopped

Narrowed, not solved. Facts established:

- `"Claude Code process aborted by user"` does **not** appear in `bakeoff/src` or
  `dashboard/server/src` — `grep -rn` over both is empty. It is the **CLI's own**
  message, so the subprocess was terminated, not our code throwing.
- `bakeoff/src/anthropic-seat.ts` imports `@anthropic-ai/sdk` (the API SDK) and
  contains **no** abort, AbortController, signal, or rate-limit handling.
- But the dashboard runs on SUBSCRIPTION auth with no API key, so it cannot be using
  that seat directly — there must be a subscription seat adapter between
  `spec-agent.ts:877` (which sets the `suite-authoring …` purpose) and the CLI.

**NEXT STEP, precisely:** find the subscription spec-seat adapter — the thing that
turns `spec-agent`'s seat call into a Claude Code CLI invocation — and look for what
terminates it. The 9m37s gap between the rate-limit event and the abort is the shape of
a timeout, not an immediate refusal. Then check whether `retryAfterSec: 253699` is a
retry-after or a window length being misread (`orchestrator.ts:2585-2605` is the only
emitter).

**Then fix the terminal branch:** a rate-limited spec seat must land `rate_limited`
(resumable, with a countdown), never `failed` with a dead Resume button.

---

# ITERATION 9 — THE SPEC-SEAT ABORT (item 0), ROOT-CAUSED AND FIXED

Server **929 tests / 927 pass / 0 fail / 2 skipped** (+4). Client **10 failed /
108 passed** (+5; the same 10 pre-existing `canvas-edges`/`code-browser`). Both
typecheck clean.

Iteration 8 left two questions. Both are answered below **from the run's own row
and event table**, not inferred from the symptom — and one of them had the wrong
shape entirely.

## 1. `retryAfterSec: 253699` WAS NEVER A MISPARSE. THE EVENT WAS THE LIE.

Iteration 8 guessed "either the value is misparsed, or a stale/whole-window
figure is being read as a retry-after". **Neither.** The row says so:

```sql
sqlite> SELECT status, rate_limited, rate_limit_retry_after_sec, rate_limit_kind
        FROM runs WHERE run_id='run-2026-07-30T13-31-38-076Z-c228e63b';
failed | 0 | 253699 | seven_day
```

`rate_limited = 0`. **The provider refused nothing.** 253,699s is a correct
decode of when the *seven-day window* rolls over — ordinary telemetry the Agent
SDK emits at session start with `status: 'allowed' | 'allowed_warning'`. Only
`status: 'rejected'` is a refusal, and `claude-common.ts:209` already had that
right (`limited: rejected`).

Corroborating proof it was never limited: `#noteRateLimit` logs a `warn` **only
when `state.limited` is true**, and no such log exists in the run's 10 events.

**Three surfaces turned a true reading into a false claim:**

| Where | What it did |
|---|---|
| `orchestrator.ts` `#noteRateLimit` | emitted `rate_limit` **unconditionally**, with no `limited` on the wire |
| `use-run-stream.ts` reducer | **hard-coded `limited: true`** for every `rate_limit` frame |
| `use-run-stream.ts` `traceRowFor` | printed `rate limited; retry after 253699s` at **warn** |

`limited` now goes on the wire and the client reads it. `retryAfterSec` is still
carried when not limited — a window filling up is worth showing, which is what
`rate-limit.ts`'s own docblock argues; it just may not be called a refusal.

**The banner never fired.** `RateLimitNotice` is gated on
`status === "rate_limited"` and the status was `failed`. What the owner actually
saw was the **trace row**, live, two seconds in.

## 2. THE ABORT: `#specPhase` THROWS, SO THE ABORT CHECK BELOW IT WAS DEAD CODE

`"Claude Code process aborted by user"` is the CLI's own wording (absent from
both `bakeoff/src` and `dashboard/server/src` — iteration 8 established that).
Something called `abort()`. There are exactly two callers, and they were
**indistinguishable**:

- `cancel(runId)` — the owner asked. Terminal is correct.
- `shutdown()` — the server is stopping. The stop banner promises, verbatim,
  *"In-flight builds are aborted and stay resumable."*

The build phase returns a `{kind: "cancelled"}` discriminant and was handled.
**`#specPhase` throws**, so it sailed past `if (signal.aborted)` on the next line
and landed in `#start`'s generic catch as a harness fault:

```
#specPhase throws → #execute's abort check skipped → #start catch
  → #finish(runId, "failed", failureReason: "…aborted by user")
```

`failed` is terminal → `resume()` refuses it (`isTerminal`) → **the dead Resume
button**. And `reconcileOnBoot` only scans `running`, so the terminal write beat
the one mechanism built to recover exactly this. The recovery machinery was
correct all along and was defeated by ordering.

**THE FIX — discriminate at the SIGNAL, never at the message.** The CLI's wording
is identical whoever aborted, and matching on a vendor string would be a guess.
`abort(ABORT_CANCELLED | ABORT_SHUTDOWN)` now carries the reason:

- **cancel** → `#cancelled`, terminal, unchanged.
- **shutdown** → `#abandonedForShutdown`, which writes **no terminal state at
  all**. The row stays `running`, which is the exact set `reconcileOnBoot`
  scans, so the next boot offers it back. That makes the banner's promise true
  with no new state machinery.

Applied to the build phase too — a shutdown mid-build was writing terminal
`cancelled`, non-resumable, for the same reason.

## VERIFICATION

**Four mutations executed, each restored, every probe string confirmed absent
with `grep -a`:**

| Mutation | Result |
|---|---|
| drop the spec-phase abort check | both abort tests red, `actual: 'failed'` — the original defect, exactly |
| `limited: true` in `#noteRateLimit` | server test red, `actual: true / expected: false` (type-checks perfectly — a compiler cannot catch this one) |
| `limited: true` in the client parser | 2 of 3 parse tests red; the "is a refusal" test correctly stayed green |
| revert `traceRowFor` to the old wording | the trace-text test red on `rate limited` |
| flip `abortReasonOf`'s default to `shutdown` | the default test red — the unsafe direction leaves a row `running` that nothing revisits |

**A weak red was found and fixed.** The first abort test waited on a log line
that only exists when the fix is present, so a regression failed it by **timing
out at 30,069ms** saying nothing. Rewritten to wait on "the run stopped, however
it went": the same mutation now fails in **911ms** with
`actual: 'failed' / expected: 'running'`. A slow, vague red is a red nobody reads.

**`resume()` was exercised, not assumed.** The advisor's catch: "resumable" is a
claim about `resume()`, not about the button being clickable. The test drives the
whole chain — shutdown → row still `running` → `reconcileOnBoot` →
`awaiting_input` → `resume()` returns **true** → status `queued`. An enabled
button that refuses is the same defect in a new hat.

**Two tests were rewritten because they did not reach what they claimed.** The
first named the recorded run in its docblock while driving the BUILD-phase
callback — the run it named never reached a builder. Both callbacks close over
the same `#noteRateLimit`, which is genuinely what is under test, so the docblock
now says that instead of implying the spec-phase wiring is covered; it is not,
and driving it needs a live seat call. The second claimed to test
`abortReasonOf`'s unreasoned default while calling `cancel()`, which always
passes a reason — so it asserted the default and never reached it. Now driven on
the function directly. Both are the same failure this repo keeps finding: a check
aimed at the wrong path.

**No quota was spent.** The harness environment is `{}`, so the spec seat cannot
reach a CLI and fails in under a second. That failure is not what is tested —
what is tested is that an abort *outranks* whatever was thrown.

## WHAT I COULD NOT VERIFY, AND WHY

- **Which trigger actually fired on that run is UNPROVEN.** A SIGINT during the
  editing session fits the 9m37s gap, but the stop banner goes to the server's
  stdout, not to a file. The fix is correct for both triggers; that is why this
  says "an abort during spec" rather than asserting a restart.
- **The trace is LIVE-ONLY.** Opening the recorded run in a real browser this
  session shows *"This run finished before the page was opened, so there is no
  live trace to replay."* The row the owner saw existed only while the run was in
  flight, so there is **no finished-run render that can be inspected after the
  fact**. `traceRowFor` was therefore exported and unit-tested directly — the
  same move, for the same reason, as `parseRunEvent` in iteration 7. Not a
  shortcut; the only reachable check.
- **No live run has been steered through this.** Needs quota. The first real run
  after this change should be checked for the abort path landing
  `awaiting_input`, not `failed`.

## SEEN IN THE BROWSER, NOT FIXED — still open, and NOT closed by this

1. **`Resume` is still enabled on a genuinely `failed` run** (audit gap #2).
   This removes one *cause* of a bogus `failed`; it does not touch the button's
   behaviour on a run that really did fail. Confirmed still enabled this session.
2. **`failureReason` is still not on `RunDetail`** (audit gap #6), so a real
   failure still shows the owner nothing.
3. **NEW, observed on the render:** the canvas empty state on this run reads
   *"Runs recorded before the canvas existed, and runs on the Codex provider,
   contain none."* Iteration 6 gated that on terminal-and-empty, which this run
   is — but every clause is still **false** about a 9-minute-old Claude run that
   died before the build segment minted a node. The terminal branch needs a
   fourth case: *terminal, and the build never started*.
