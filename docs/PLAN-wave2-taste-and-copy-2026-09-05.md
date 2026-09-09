---
document_status: plan
written: 2026-09-05
verified_at_commit: 759d1be
source: docs/FINDINGS-2026-09-05-clinic-run-131fd85f.md
run_under_study: run-2026-09-04T15-54-06-323Z-131fd85f
consumed_by: Codex, one task per session
continues: docs/PLAN-learning-loop-tasks-2026-09-04.md (T1 to T14, G1, G2)
---

# Wave 2: taste, copy and the seats that never looked

## 0. How to read this

Twelve code tasks, T15 to T26, and one owner gate, G3. Each code task is one Codex session:
one goal, one area, one test file, one commit type. They are ordered so the cheapest and most
owner-visible land first; the dependency table in section 4 is the only place order is relaxed.

Wave 1 (T1 to T5) is committed: 761c81a, 08a8609, 5a7cf77, 362597c, 759d1be. Nothing here
re-opens those. T3's `no_evidence` disposition (5a7cf77) is the state T24 makes reachable.

**What this wave is.** The findings document ranks five causes for the owner's rejection of
the clinic page. Four are pipeline mechanisms (C1 the contract turned requirements into copy,
C2 the host mounted a scroll world the direction forbade, C3 controls that are pictures, C4 a
chooser that picked the most templated direction on purpose) and one is the absence of any
judge of rendered pixels (C5). Every task below closes one mechanism or one blind spot. None
of them is learning-tier work; none touches the held-out suite, its hash or the sealed scorer.

**What this wave is not.** It does not replace `taste-frontend-expert`. The research residue in
FINDINGS §4 is explicit: no candidate produces a design, every judge candidate tops out near
60 to 70 percent agreement with humans, and the one change the evidence supports is routing
app and form tickets away from a skill that says in its own first line it is "Not dashboards,
not data tables, not multi-step product UI" (`~/.claude/skills/taste-skill/SKILL.md:8`, and
:901 "Multi-step forms / wizards ... this skill won't make them better"). T22 is that routing
change. G3 is the control run that measures it. Whether the lane stays for landing tickets is
decision D12, the owner's.

**Standing rules, inherited from wave 1 and applied to every task.**

1. Every check needs a negative control. Each task names the input that must go red and, where
   the usual stub would pass, the stub it must defeat.
2. Verify, never relay. Line numbers below were read at 759d1be on 2026-09-05 and will drift;
   the file and the symbol are the anchor, the number is a hint.
3. Prompt changes are allowed in this wave (they were not in wave 1), but every prompt change
   ships with a golden hash of the unchanged branch captured in a separate first commit, so
   "byte-identical when the new condition is off" is a test that can fail.
4. One change per commit. Bare `type: summary`, 60 characters, no dash punctuation, no AI
   attribution. This repository has no `## Commit areas` list, so no area token.
5. Nothing may spend a metered call (Gemini image, Veo video) in a test. The existing
   convention holds: tests hand the orchestrator a temporary home (`DASHBOARD_HOME`) in which
   the only `gemini-video.sh` that can be found, when one is written at all, is a stub that
   spends nothing (`orchestrator.test.ts:1134-1160`, :1433-1440).

**Labels.** *measured* means I opened the file, ran the query or drove the page on 2026-09-05.
*relayed* means the findings document measured it and I did not repeat it; each relayed item
names its section. Where a task rests on a relayed fact, the task's first step is to re-measure
it.

**Reversibility legend** is wave 1's: **R** revert the commit and the tree is byte-identical;
**R-flag** one boolean restores the prior behaviour at runtime; **R-additive** new file or new
table only; **NOT-R** something outside the repository changes.

**Survives abandonment** answers one question per task: if the owner drops the
`taste-frontend-expert` lane entirely after this run (the question he asked on 2026-09-05), is
the task still worth its session?

---

## 1. The measured starting position

| Quantity | Value | How (measured unless marked) |
|---|---|---|
| `graph_agent` events by (lane, agent) across `dashboard/data/runs.db` | design/taste-frontend-expert 46, design/ui-designer 16, review/human-factors-adversary 16, gate/debugger 4, review/code-reviewer 4, build/backend-developer 3, build/frontend-developer 3, review/accessibility-tester 2, review/ai-writing-auditor 2, gate/test-automator 1, spec/context-manager 1, (null lane)/orchestrator 72, (null)/(null) 360 | `select json_extract(payload,'$.lane'), json_extract(payload,'$.agent'), count(*) from events where json_extract(payload,'$.type')='graph_agent' group by 1,2` |
| Where a canvas card gets its title | `node.agent ?? "session"` | `dashboard/src/components/canvas/agent-node.tsx:437-439`; also `sheet.tsx:227`, `inspector.tsx:482`, `roster.tsx:107` |
| Role derivation that already exists | `roleOf(agent, lane)` over craft tokens then lane, eight roles incl. `unmapped` | `dashboard/src/components/canvas/roles.ts:340`, `ROLE_LABEL` :70, `ROLE_TOKENS` :113 (`"debug"` :251 and `"debugger"` :252 are **review** tokens), `LANE_ROLE` :270 |
| Design-lock copy printed for every `ui-designer` lock | "chosen automatically" / "No choice arrived in time, so ui-designer picked." | `dashboard/src/components/run/design-lock.tsx:172-173`, :457; `dashboard/server/src/cron/cron-report.ts:119` |
| Contract on the run | pageKind `saas_landing`, designSystem `native`, aestheticFamily `trust_first`, dials 4/3/5; 11 sections; 12 proofs; s.hero `asymmetric_split`; s.nav, s.a11y, s.responsive are `real_component` with `requiredStates [default, interaction]` and `actions []` | `RUN/results/creative-contract.json` |
| Proofs backed by requirement text and licensed for headline or body | p.a11y, p.responsive, p.local, p.run, p.focus (brief:2/3/4) and p.markers (locator `ticket:…:surface`, uses body and alt) | same file |
| Video legs | 2 marks (`step1`, `confirm`, origin `expansion`), 2 produced, contract motionIntensity 3, direction MOTION_INTENSITY 2 (canvass) and 3 (expansion) | `RUN/workspace/design-refs/manifest.json`; `direction-soft-clinic-card.md:58`; `direction.md:13` |
| Non-test source files that read `motionIntensity` | 1, `creative-contract.ts` | `grep -rln motionIntensity dashboard/server/src` |
| The sentence the video lane appends to every build prompt with a produced leg | "It is measured from the reference site's runtime behaviour, not invented" | `dashboard/server/src/design/video-lane.ts:171-172` |
| Render issue severities | `"blocking"`, `"warning"`; only `blocking` refuses | `dashboard/server/src/render-manifest.ts:21`; `creative-render.ts:1630-1632` |
| Motion issues that refused this run's render | `MOTION_NOT_OBSERVED` and `REDUCED_MOTION_ACTIVE`, both emitted `"blocking"` | `creative-render.ts:1051-1075`, :1085-1095 |
| Static file resolver | dot-directories and harness files resolve like any other path; no test covers `resolveStaticFile` | `bakeoff/src/tier0.ts:1276`; `grep resolveStaticFile bakeoff/src/tier0.test.ts` returns nothing |
| Acceptance suites that request an internal path | 0 | `grep -rl 'TICKET.md\|design-refs\|visible-acceptance' dashboard/acceptance` |
| `dashboard/runs/` is git-ignored | yes | `.gitignore:25` |
| Chooser file validation | accepts `{chosen, reason}`; a blank reason becomes `"no reason given"` and is filed `by: "ui-designer"` | `dashboard/server/src/design-lock.ts:221-241` (:239, :240) |
| Interactive timeout with no owner pick | first direction in manifest order, `by: "fallback"` | `orchestrator.ts:1871-1884`; `design-lock.ts:251-260` |
| Code-reading judge findings | logged, never persisted, never rendered into `verdict.md` | `orchestrator.ts:7570-7588`; `verdict.ts:119-149` has no judge field; `RUN/results/verdict.md:3` reads "nothing was noted against it", generated at `verdict.ts:655` |

Two side observations that are not tasks:

- `dashboard/server/src/visual-gate-run.ts` is valid UTF-8 (`iconv` passes) but `file` reports
  `data` and plain `grep` prints nothing for it; `LC_ALL=C grep -naP '[\x00-\x08\x0e-\x1f]'`
  hits line 367 (`const key = \`${capture.flowId} ${capture.breakpoint}\``). Something
  non-printing sits in that template literal. Anyone grepping this repository for anchors will
  miss this file. Worth one `chore` outside the wave; not load-bearing here.
- The `SendMessage` denial text at `dashboard/server/src/builders/delegation-hook.ts:224-227`
  says the tool "resumes an agent that is already running"; on this run the target had
  completed eight minutes earlier (FINDINGS §5, F8 row, relayed). Six denials in six attempts
  across all runs. A one-line `fix` to the string; not in this wave's critical path.

---

## 2. The tasks

### T15 — Canvas cards are titled by role, with the agent name demoted

**Goal.** Every place the canvas prints `node.agent ?? "session"` as a title prints the task
role instead (`orchestration`, `spec`, `design`, `frontend`, `backend`, `build`, `review`, and
a new `debug`), with the agent name on the secondary line.

**Why here.** The owner asked for it by name on 2026-09-05, it is the cheapest task in the
wave, and it is the one change he will see on the next page load. The derivation already
exists: `roleOf(agent, lane)` (`roles.ts:340`) is what colours the card today, so the title is
a one-symbol swap plus the places that echo it. It also gives the design-lock corrections (T16)
and the pairwise park (wave 1 T8) a canvas that reads in the owner's vocabulary.

**Touches.**
- `dashboard/src/components/canvas/agent-node.tsx:437-439` (the `<h3>`), :441-443 (`RoleChip`,
  which becomes redundant once the title is the role; keep the chip for `unmapped` only or
  drop it, Codex's call), :630-639 (`agentLabel`, the screen-reader string)
- `dashboard/src/components/canvas/sheet.tsx:223-228` (`title={node.agent ?? "session"}`)
- `dashboard/src/components/canvas/inspector.tsx:480-483`
- `dashboard/src/components/canvas/roster.tsx:106-108` (the name) and :113-116 (the secondary
  line, today `{node.lane ?? "no lane"} · delegated by …`)
- `dashboard/src/components/canvas/roles.ts:70-79` (`ROLE_LABEL`), :113 (`ROLE_TOKENS`),
  :234-262 (the `review` list; move `"debug"` :251 and `"debugger"` :252 into a new `debug`
  role, add `"debugfix"` and `"troubleshoot"`), :270-276 (`LANE_ROLE`, unchanged: `gate`
  stays `review`), one new exported `titleOf(node)` beside `roleOf`
- `dashboard/src/app/globals.css:199-206` (one new `--role-debug` hue; the header comment in
  `roles.ts` fixes the constraints: chroma 0.07 to 0.11, distinct from the three state hues)
- `dashboard/tests/canvas-roles.unit.spec.ts:33-40` (add the `debug` cases; every existing
  assertion stays as written)
- new `dashboard/tests/canvas-titles.browser.spec.ts`, driven by the existing fixtures
  `dashboard/tests/fixtures/run-fixture.ts:52` (agent null), :79 (`frontend-developer`), :90
  (`code-reviewer`), :101 (`antislop-hook`) and `build-run-fixture.ts:89-92`, :145-148,
  :210-213

**Acceptance criteria.**
1. `titleOf(node)` is a pure function: `ROLE_LABEL[roleOf(agent, lane)]` when the role is not
   `unmapped`; the agent name when the role is `unmapped` and the agent is named; `"session"`
   when the agent is null. The secondary line carries the agent name whenever it exists.
2. All four title sites use `titleOf`. `agentLabel` leads with the role and still contains the
   agent name, so a screen reader hears both.
3. `debug` is a real role: `roleOf("debugger", "gate")` is `debug`, `roleOf("debugfix", null)`
   is `debug`, and the four `gate/debugger` nodes in the live DB (section 1) would now read
   `debug`. `roleOf("code-reviewer", "review")` is still `review`.
4. **NEGATIVE CONTROL, three, all required.**
   (a) `titleOf({agent: "taste-frontend-expert", lane: "design"})` is `"design"` and is
   **not** `"taste-frontend-expert"`; the browser spec asserts no `<h3>` on the canvas reads
   `taste-frontend-expert` or `frontend-developer`. Revert the `<h3>` at
   `agent-node.tsx:438` to `node.agent` and this goes red.
   (b) `titleOf({agent: null, lane: null})` is `"session"`, **not** `"unmapped"`. A blanket
   `ROLE_LABEL[roleOf(...)]` passes (a) and fails this: 360 nameless nodes in the DB would
   otherwise be retitled `unmapped`.
   (c) `titleOf({agent: "some-agent-nobody-has-named", lane: null})` keeps the agent name. This
   is the control that the rename is not a relabel of everything.
5. `canvas-roles.unit.spec.ts` passes with its existing assertions untouched (the `debug` cases
   are additions), which proves no other agent changed role as a side effect of moving two
   tokens.

**Must not.** Must not read `node.description` to derive a role (the header of `roles.ts`
explains why). Must not touch the server, the events, or `api-types.ts`. Must not remove the
`unmapped` grey. Must not change any colour other than adding one.

**Depends on.** Nothing. **Reversible: R.** **Survives abandonment: yes.**

---

### T16 — The design-lock copy reads the record instead of asserting a timeout

**Goal.** A `ui-designer` lock reads as a judged pick with its recorded reason; only a
`fallback` lock whose reason names the timeout says a choice failed to arrive.

**Why here.** Cheap, owner-visible, and it misled the inline finding F4 on 2026-09-05: the
dashboard printed "No choice arrived in time, so ui-designer picked" over a lock whose
`design-lock.json` records a 94,599-token judged choice, `awaiting false`, `turnsUsed 0`
(FINDINGS §2 C4, §5 F4 row, relayed). The record already carries everything the copy needs.

**Touches.**
- `dashboard/src/components/run/design-lock.tsx:168-176` (`chooserOf`, the `ui-designer`
  branch) and :452-462 (`directionSentence`)
- `dashboard/server/src/cron/cron-report.ts:112-122` ("chosen automatically by")
- `dashboard/server/src/design-lock.ts:443-458` (`DesignLockRecord`: `chosenDirectionBy`,
  `chosenDirectionReason` are the inputs), :255-258 (the fallback reason text), and the two
  fallback reasons the orchestrator writes: `orchestrator.ts:1879` "no owner choice arrived
  before the timeout" and :5544 "ui-designer wrote no direction-choice.json"
- `dashboard/tests/design-lock.browser.spec.ts`, `dashboard/tests/design-lock.unit.spec.ts`
  (neither pins the current strings; `grep 'No choice arrived' dashboard/tests` is empty)

**Acceptance criteria.**
1. `ui-designer` lock: badge "judged by ui-designer", sentence quotes the recorded reason.
   `fallback` lock: the existing warn tone; the sentence says a choice failed to arrive
   **only when** `chosenDirectionReason` contains "before the timeout"; otherwise it says the
   chooser wrote no usable choice. `owner` lock unchanged.
2. The cron line drops "automatically" for `ui-designer` and keeps it for `fallback`.
3. **NEGATIVE CONTROL.** A record fixture with `chosenDirectionBy: "ui-designer"` and this
   run's reason (`RUN/results/design-lock.json:50`) renders **without** the substring
   "No choice arrived"; a `fallback` record with the timeout reason renders **with** it; a
   `fallback` record with the no-file reason renders neither the timeout sentence nor the
   judged badge. A change that just deletes the timeout sentence passes the first and fails
   the second.

**Must not.** Must not change the record shape or any server write path. Must not infer the
chooser from `lockedBy` when `chosenDirectionBy` is present.

**Depends on.** Nothing. **Reversible: R.** **Survives abandonment: yes.**

---

### T17 — The code-reading judge's findings reach `verdict.md`

**Goal.** Persist the judge report and render its findings into the verdict, so a run cannot
say "nothing was noted against it" while its own judge noted two things.

**Why here.** On this run the judge wrote `[unasked_scope/medium]` against the capture-mode CSS
and `[swallowed_failure/low]` against the background video layer, "itself scope the ticket
did not ask for" (FINDINGS §2 C5 item 6, seq 907 to 910, relayed). `verdict.md:3` says
"Everything the ticket asked for is there, and nothing was noted against it." The findings
exist only as log lines (`orchestrator.ts:7570-7588`). One of them names the owner's
"weird scrolling animation". This is the cheapest seat that already looked and was ignored.

**Touches.**
- `dashboard/server/src/orchestrator.ts:7551-7563` (`judgeArtifact` call), :7570-7588 (the
  log loop; keep it), :8838 (`#writeVerdict` call site) and `#writeVerdict` itself
- `dashboard/server/src/verdict.ts:119-149` (`VerdictInput`; follow the optional-field
  precedent documented at :137-149), :655 (the clean sentence), :665 (`renderVerdict`)
- `dashboard/server/src/judge.ts:148-157` (`JudgeReport`: `ran`, `verdict`, `findings`,
  `summary`, `judgedBy`), :268 (`judgeArtifact`)
- new `results/judge.json` written beside `verdict.md`
- `dashboard/server/src/verdict.test.ts` (if present; otherwise the existing verdict tests
  under `run-report`), `orchestrator.test.ts`

**Acceptance criteria.**
1. `results/judge.json` persists the whole `JudgeReport` (redacted through the existing
   persistence chokepoint like every other string that reaches disk).
2. `verdict.md` gains a section "Code-reading judge (non-gating)" listing each finding as
   `[kind/severity] criterionId: detail`, and the clean sentence at `verdict.ts:655` is
   printed only when the held-out suite is green **and** the judge ran with zero findings.
3. A judge that did not run (`ran: false`) or returned `unavailable` renders "the code-reading
   judge did not run: <summary>", never a clean sentence.
4. **NEGATIVE CONTROL.** Fixture report with two findings (use the two from this run) → the
   verdict contains both lines and does **not** contain "nothing was noted against it".
   Fixture with `ran: false` → the verdict contains "did not run" and not the clean sentence.
   Fixture with `ran: true, findings: []` → the clean sentence is present. A change that
   renders the section but leaves the clean sentence unconditional passes the third and
   fails the first.

**Must not.** Must not make the judge gating or change `heldOutPass`. Must not give the judge
tools. Must not alter the criteria section of the verdict.

**Depends on.** Nothing. **Reversible: R** (code) **/ R-additive** (`judge.json`).
**Survives abandonment: yes.**

---

### T18 — PREVIEW-EXPOSURE-001: the static server refuses harness-internal paths

**Goal.** `resolveStaticFile` returns null for any path with a dot-prefixed segment and for the
harness's own workspace files, on the preview and in the sealed gate alike.

**Why here.** Backlog P0 (`docs/BACKLOG.md:20`, uncommitted), resolver-confirmed, predicted by
the adversary on two runs, and fixed in one function with no design question. Confirmed today:
`GET /.git/config` and `GET /TICKET.md` answer 200 over the ad hoc Python server; the
pipeline's own resolver returns real paths for both (FINDINGS §5 F7 rows, relayed; the
resolver source is measured at `tier0.ts:1276-1329` and contains no such rule).

**Touches.**
- `bakeoff/src/tier0.ts:1276-1329` (`resolveStaticFile`), :1330-1375 (`startStaticServer`;
  the resolver is called at :1345 and a null is already a 404)
- `bakeoff/src/tier0.test.ts` (no `resolveStaticFile` test exists; add a `describe`)
- consumers that must keep working unchanged: `dashboard/server/src/preview.ts:23`, :87;
  `dashboard/server/src/execution-contract.ts:19`, :79 (resolves `"/"`);
  `bakeoff/src/scorer-container.ts:402` (the sealed gate's server)
- `dashboard/server/node_modules/bakeoff` is a symlink to `../../../bakeoff` (measured), so
  `npm run build` in `bakeoff/` is what refreshes `dist/tier0.js`
- internal names measured on this run's workspace: `.git/`, `TICKET.md`, `design-refs/`,
  `visible-acceptance/`, `tests/`; plus `.bakeoff/` (`project-publish.ts:135` calls it
  "harness state; the scorer strips it too"; `gate-recovery.ts:704` creates it)

**Acceptance criteria.**
1. Any path segment beginning with `.` resolves to null (covers `.git`, `.bakeoff`, `.tmp`,
   `.DS_Store`, `.design-tmp`). A named root-level list also resolves to null: `TICKET.md`,
   `design-refs`, `visible-acceptance`, `tests`. The list is one exported constant with a
   comment per entry naming what writes it.
2. The order exact file → `index.html` → `.html` is unchanged; traversal after percent-decoding
   is unchanged; the realpath containment check is unchanged.
3. Denied paths answer 404 with the existing "not found" body, never 403 (existence is not
   revealed). `HEAD` behaves as `GET`.
4. **NEGATIVE CONTROL, live and unit, both required.** Build a temporary root with this run's
   real shape (`index.html`, `app/styles.css`, `app/main.mjs`, `.git/config`, `TICKET.md`,
   `design-refs/manifest.json`, `visible-acceptance/x.spec.mjs`, `tests/x.test.mjs`). Start
   `startStaticServer` on an ephemeral port. Positive control first: `/`, `/index.html`,
   `/app/styles.css`, `/app/main.mjs` → 200. Then each internal path → 404, `/tests/` (a
   directory) → 404, `/%2e%2e/` → 404. **Run the negative half once against the pre-change
   resolver and record that it goes red** (`/.git/config` → 200 today) before the change lands;
   a deny rule that matches nothing passes the positive half and this is the only thing that
   catches it.
5. `execution-contract.ts:79` still resolves `"/"` to the workspace `index.html`.
6. The held-out suites request none of the denied paths (measured 0 today); the test asserts
   the same over `dashboard/acceptance/` so a future suite cannot depend on one silently.

**Must not.** Must not add a configuration knob. Must not touch the scorer's suite mount or
the container. Must not deny `README.md` (the ticket asks for run instructions and the README
is a product file). Decision D2 covers `.well-known` and `node_modules`.

**Depends on.** Nothing. **Reversible: R.** **Survives abandonment: yes.**

---

### T19 — The video lane is gated by the contract dial and the page kind

**Goal.** A marked ref becomes a Veo leg only when the contract's `motionIntensity` and the
chosen direction's `MOTION_INTENSITY` both meet the contract author's own scroll-progress
threshold and the page kind is a landing kind; otherwise the marks are declined, recorded, and
the expansion is told not to mark.

**Why here.** Cause C2 in full: the owner's "weird scrolling animation" is two Veo clips of the
mockups mounted as a scroll-scrubbed world behind a veil, on a run whose contract dial is 3,
whose chosen direction says "no scroll-driven or continuous animation anywhere"
(`direction-soft-clinic-card.md:58`, measured), and whose author rule says scroll-progress
motion needs intensity 8 to 10 (`creative-contract-author.ts:531`, measured). Nothing on the
video path reads any of that: `grep -rln motionIntensity dashboard/server/src` returns
`creative-contract.ts` alone. The consumption prompt then tells the builder the pattern "is
measured from the reference site's runtime behaviour, not invented"
(`video-lane.ts:171-172`), which is false on a run with no reference site.

**Touches.**
- `dashboard/server/src/design/video-lane.ts:165-185` (`videoConsumptionPrompt`; delete the
  reference-site sentence), :208-261 (`runVideoLane`; the plan at :218-219 gains a policy
  input), `VideoLaneDeps` :38-62
- `dashboard/server/src/design/video-legs.ts:100-135` (`planVideoLegs`; the `animate !== true`
  skip at :117 is where a declined mark is recorded as `rejected` with a reason), :32
  (`DEFAULT_VIDEO_LEG_CAP`), :78-85 (`resolveLegCap`; the cap stays)
- `dashboard/server/src/orchestrator.ts:4965-4980` (the call; read the policy inputs here)
- `dashboard/server/src/creative-contract.ts:1149` (the literal `8` becomes an exported
  `SCROLL_PROGRESS_MIN_MOTION_INTENSITY`), :520 (the guidance text "below 8" reads the
  constant), `creative-contract-author.ts:531` (same)
- `dashboard/server/src/creative-pilot.ts:36` (`CREATIVE_CONTRACT_FILE`): a small reader that
  JSON-parses `results/creative-contract.json` for `dials.motionIntensity` and
  `designRead.pageKind` only, without the evidence resolver
- `dashboard/server/src/design-manifest.ts:709-717` (`readDesignDirection`, the chosen
  direction's `direction.md` text) plus a parser for the `MOTION_INTENSITY` line; both measured
  forms must parse: `- **MOTION_INTENSITY 2** —` (canvass note :58) and
  `- **MOTION_INTENSITY 3** —` (expansion :13)
- `dashboard/server/src/design-prompt.ts:440-500` (the three arms: no capability :440-458,
  canvass :459-476, expansion :477-500). Add a fourth arm for "legs declined by policy" so the
  expansion is not invited to mark refs the host will refuse; :510-522 fixes the dial line
  format so the parser has one form to read going forward
- tests: `design/video-lane.test.ts`, `design/video-legs.test.ts`, `design-prompt.test.ts`,
  the design-run helpers in `orchestrator.test.ts`

**Acceptance criteria.**
1. `videoLegPolicy(input)` is pure: `{ allowed, reason }` from `{ pageKind, contractDial,
   directionDial }`. Allowed only when `pageKind` is not `app` (T22; until then every kind
   passes this clause), `contractDial >= SCROLL_PROGRESS_MIN_MOTION_INTENSITY`, and
   `directionDial` is either absent or also at or above it. The reason names every number it
   read and every one it could not.
2. `results/video.json` records the policy: `{ allowed, reason, marksDeclined }`. A declined run
   reads as declined, not as `degraded`.
3. The reference-site sentence is gone from `videoConsumptionPrompt`. Nothing else in that
   prompt changes (golden hash of the rest, captured first).
4. When policy denies, the expansion prompt says so in its own arm and does not carry the
   "MOTION LEGS ARE AVAILABLE" paragraph; when policy allows, the expansion prompt is
   byte-identical to today's (golden hash).
5. **NEGATIVE CONTROL, four, all required.**
   (a) Manifest with two `animate: true` refs, contract dial 3, direction dial 2 (this run) →
   zero legs planned, `spawnLeg` invoked zero times (count it, as `video-legs.test.ts`
   already does), record says declined with a reason naming 3 and 2.
   (b) Same manifest, contract dial 8, direction dial 8, pageKind `consumer_landing` → two
   legs planned, `spawnLeg` invoked twice. A policy stub that always denies passes (a) and
   fails this; a stub that always allows fails (a).
   (c) No `direction.md` → the direction dial is `null`, recorded as unknown, and the contract
   dial alone decides; never guessed.
   (d) No `creative-contract.json` (a run outside the creative pilot) → behaviour unchanged
   from today, recorded as "no contract; policy not applied". Decision D3 is whether that
   default should flip.
6. The parser: both measured line forms yield the integer; a note without the line yields
   `null`; a note with two lines yields the first and records that it did.

**Must not.** Must not touch the sealed gate, the held-out suite, or `video-capability.ts`.
Must not remove the cap or the resume guard. Must not spend a metered call in any test. Must
not read the direction note for anything but the one dial.

**Depends on.** Nothing (T22 strengthens clause 1). **Reversible: R.**
**Survives abandonment: yes.**

---

### T20 — The motion floor reads the contract

**Goal.** `VIS-MOTION-AUTHORED` and the builder's motion stop-hook accept the contract's own
declared motions at low intensity, instead of demanding a scroll-scrubbed world regardless.

**Why here.** The second half of C2. Even with T19 in place, two texts still reward the world
layer: `visual-criteria.ts:130-138` ("Satisfied by ANY of: a scroll-scrubbed video ... Not
satisfied by hover lifts, opacity fades or transition-all alone") and
`antislop-rules.ts:1123-1132` ("This build may not declare done without one authored motion
moment ... a scroll-scrubbed video or world-journey ..."). The contract declared three css
motions at intensity 3, two on opacity alone and one (`m.step`) on opacity and transform
(measured in `RUN/results/creative-contract.json`; the dial is measured) and both texts call
that stock. A builder held to the contract and to this floor at once is
told to violate one of them.

**Touches.**
- `dashboard/server/src/visual-criteria.ts:130-138` (the seed statement), :321-327
  (`visualCriteriaFor(manifest, ownerReference)`; add an optional third argument carrying
  `{ motionIntensity, motionIds }` or null)
- `dashboard/server/src/visual-gate-run.ts:319-330` (`VisualGateRunInput`; add the same field),
  :404 (the call); `orchestrator.ts:9841` (`visualGateInputFor` fills it from
  `results/creative-contract.json` via T19's reader)
- `dashboard/server/src/builders/antislop-rules.ts:1077-1132` (`decideMotion(files)`; add a
  second parameter), :1090-1110 (the four satisfiers stay), :1116 (`stockOnly`)
- `dashboard/server/src/builders/antislop-hook.ts:374` (`makeMotionStopHook(readWorkspace,
  options)`), :301 (`makeWorkspaceReader`); `builders/claude-builder.ts:755` (the one non-test
  call site; the hook reads the workspace only, and `results/` is outside it, so the policy is
  injected as an option at construction, not read from disk by the hook)
- tests: `visual-criteria.test.ts`, `antislop-rules.test.ts`, `antislop-hook.test.ts`

**Acceptance criteria.**
1. With a contract whose `motionIntensity` is at most 4 and whose motion list is non-empty,
   `decideMotion` is satisfied when the source carries a `data-motion-id="<id>"` marker for
   every contract motion id (the marker `creative-render.ts` already observes), with a reason
   that names the contract and the ids. The four existing satisfiers still satisfy.
2. With a contract at intensity 8 or above, behaviour is unchanged: no marker shortcut.
3. `VIS-MOTION-AUTHORED`'s statement is parameterised: at low intensity it reads "the contract's
   declared motions, implemented"; at high intensity it reads as today. The criterion id does
   not change (verdicts and dashboards reference it).
4. **NEGATIVE CONTROL, four.**
   (a) Intensity 3, three motion ids, all three markers in source, no scroll code → satisfied.
   (b) Intensity 8, no scroll code → unsatisfied, reason unchanged from today.
   (c) Intensity 3, three ids, only two markers → unsatisfied, reason names the missing id.
   A stub that returns satisfied whenever a contract exists passes (a) and fails (c).
   (d) No contract → every existing `antislop-rules.test.ts` and `visual-criteria.test.ts`
   assertion passes unchanged. This is the control that runs outside the pilot are untouched.

**Must not.** Must not delete any satisfier. Must not weaken the floor for runs without a
contract. Must not let the hook read `results/` (it runs with the builder's sandbox rules).
Must not change the criterion id or tier.

**Depends on.** T19 (the contract reader and the exported threshold). **Reversible: R.**
**Survives abandonment: yes.**

---

### T21 — Delivery requirements can never be licensed as copy or become sections

**Goal.** Brief sentences are classified at sentence level; a fact of kind `constraint`,
`accessibility`, `technical_constraint` or `avoid` can back a proof only for `alt`, and a
section cannot be built from requirement proofs alone.

**Why here.** Cause C1, the largest share of the owner's five complaints. The mechanism is
measured end to end: `creative-pilot.ts:518-531` tags every brief paragraph `goal` via
`boundedFactStatements("Owner brief", ownerProse, 18)`; `constraint` is reserved for plan
answers (:532-541); the harness adds its own capture note as `technical_constraint` (:542-550);
`creative-contract-author.ts:525` says "Turn supported claims into contentProof entries";
the compiler's proof checks read digests, banned phrases, allowed uses and usage
(`creative-contract.ts:1017-1020`, :1055-1066, :1095) and never the fact's kind, which the
resolver does not even carry (`CreativeEvidenceResolution` :85-88 is `{sha256, excerptSha256}`).
Result on this run: six of twelve proofs are requirement text licensed for headline or body,
four sections restate the ticket, and the harness's "deterministic route, section, and motion
data markers for rendered capture" is patient-facing body copy.

`TICKET.md:7` is why paragraph granularity cannot work: one paragraph holds "Include Back and
Continue controls ... reset action" (product) and "Keep all data local and deterministic; do
not use authentication, payments, databases, maps, email, calendars, analytics, or external
APIs" (constraint), and both p.reset and p.local cite `brief:2`.

**Touches.**
- `dashboard/server/src/creative-pilot.ts:505-513` (the `add` closure; :512 sets the
  resolution), :518-531 (goal facts), :542-550 (`host.web-surface`)
- `dashboard/server/src/creative-contract.ts:85-92` (`CreativeEvidenceResolution` gains
  `factKind`), :31-32 (`CONTENT_USES`), :95-101 (`ContentProofV1`, unchanged shape),
  :462-471 (error code union: add `REQUIREMENT_AS_COPY`, `REQUIREMENT_SECTION`), :478-675
  (author invariants list, so the prompt states the rule in the compiler's words), :1017-1020
  and :1055-1066 (where the checks land)
- `dashboard/server/src/creative-contract-author.ts:143-146` (`CREATIVE_AUTHOR_FACT_KINDS`,
  unchanged), :521-532 (one rule line: requirement facts are never copy)
- `dashboard/server/src/creative-contract-author.test.ts:67-88` (the fixture's ticket facts
  are `goal`, `audience` and `content_claim` only; its one requirement-kind fact is the
  `accessibility` design fact at :82; add a requirement-shaped ticket fact),
  `creative-contract.test.ts`, `creative-pilot.test.ts`
- test fixture: a copy of `RUN/results/creative-contract.json` (12 proofs) committed under
  `dashboard/server/src/test-fixtures/`, because `dashboard/runs/` is ignored

**Acceptance criteria.**
1. Sentence-level classification: a bounded deterministic detector (modal verbs, "must",
   "do not", "no horizontal", "keyboard", "screen reader", "focus", "contrast", "375px",
   "run instructions", "fresh start", "local", "deterministic") sends a sentence to
   `constraint`, `accessibility` or `technical_constraint`; everything else stays `goal`.
   Ids become `ticket.goal.N` and `ticket.req.N`; locators keep the `ticket:<id>:brief:N`
   form with N now a sentence index. The 18-slot bound and the ten reserved plan-answer slots
   are unchanged.
2. The resolver reports the fact's kind on every resolution. The compiler raises
   `REQUIREMENT_AS_COPY` when a proof resolved to a requirement kind carries any allowed use
   other than `alt`, or is referenced by any `contentRefs[].use` other than `alt`, or by any
   action. It raises `REQUIREMENT_SECTION` when every proof a section references is
   requirement-kind.
3. `host.web-surface` stays `technical_constraint` and therefore can never be body copy; the
   test states that in as many words.
4. The author prompt carries the rule in the invariants block (:478-675 renders into
   `creative-contract-author.ts:518-520`), so a rejection is a finding the author can repair.
5. **NEGATIVE CONTROL, five.**
   (a) The committed copy of this run's contract, compiled with a resolver that reports
   requirement kinds for the six brief:2/3/4 and surface proofs, fails with
   `REQUIREMENT_AS_COPY` at exactly `/contentProof/{p.a11y,p.responsive,p.local,p.run,p.focus,p.markers}`
   and at no product proof (p.wizard, p.types, p.slots, p.controls, p.reset, p.confirm). A
   resolver stub that reports `goal` for everything must make this test **fail**; that proves
   the kind is read from the resolution and not sniffed from the claim text.
   (b) Positive control: a product proof used as headline still compiles.
   (c) The classifier on `TICKET.md:7` yields at least one `goal` sentence and at least one
   `constraint` sentence; "Choose one of exactly three appointment types." is `goal`;
   "The layout must work at 375px and desktop widths with no horizontal scrolling or clipped
   controls." is `constraint`; the harness sentence is `technical_constraint`.
   (d) A section whose only refs are requirement proofs (this run's s.local shape) fails
   `REQUIREMENT_SECTION`; the same section with one product proof added compiles.
   (e) The author test fixture gains a requirement-shaped fact; an author output that licenses
   it for headline is `consume` (compile-rejected), not `proceed`.
6. Recorded consequence, not hidden: `freshCreativeContract` (`creative-pilot.ts:778-820`)
   recompiles the on-disk contract against a resolver rebuilt from the ticket, so an older
   run resumed after this change will find its contract not fresh and re-author. Seven
   contracts exist on disk today (FINDINGS §6, relayed). The task records this in the commit
   body and in `docs/CAPABILITIES.md`.

**Must not.** Must not add a page kind (T22). Must not touch `PAGE_KINDS`, `SECTION_KINDS` or
`CONTENT_USES`. Must not classify plan answers differently. Must not let a requirement proof
be used as `metric` or `quote` under any exception; there is no exception rule for this.

**Depends on.** Nothing. **Reversible: R** for the code; a run authored under the new
classifier is not byte-comparable to one authored before it, and that is the point.
**Survives abandonment: yes.**

---

### T22 — An `app` page kind, and app tickets do not go through the landing-page skill

**Goal.** The contract can describe a tool or form, an app route is bounded to at most one
feature or editorial section, and the design lane's canvass for an app anchors its three
directions on a design system with a form-specific brief instead of the landing-page canvass.

**Why here.** This is the taste-lane change the research supports, and the only one that
survived refutation (FINDINGS §4 "Replaces: none"; "Route app and form tickets away from
taste-skill, as the skill itself asks"). `PAGE_KINDS` is six landing and editorial kinds with
nothing for an app (`creative-contract.ts:11`), so the author chose `saas_landing` on both
attempts and the compiler then required a hero, a visual and a section grammar written for
persuasion. The skill's own scope line excludes wizards (`taste-skill/SKILL.md:8`, :901,
:906). Ordered after T21 because an app route with one feature section is only useful once
that section cannot be a requirement restated.

**Touches.**
- `dashboard/server/src/creative-contract.ts:11` (`PAGE_KINDS` gains `"app"`), :17
  (`DESIGN_SYSTEMS`, unchanged: `native`, `govuk`, `uswds` and ten others already exist), :38
  (`SECTION_KINDS` already has `form`), :378 and :861 (enum sites follow the constant), :520
  (the `CENTERED_HERO` predicate text: add `app` to the exempt kinds), :1120 (the rule
  itself), :1107-1140 (route rules: add `APP_SECTION_LIMIT`, at most one `feature` or
  `editorial` section on an `app` route, and `APP_FORM_REQUIRED`, at least one `form`)
- `dashboard/server/src/creative-contract-author.ts:487` (vocabulary follows the constant),
  :521-532 (one rule line: choose `app` when the visitor operates the page rather than reads it)
- `dashboard/server/src/design-prompt.ts` `designSegmentPrompt` (called at
  `orchestrator.ts:5069-5081` with `stage: expandSegment ? "expand" : "canvass"`): the canvass
  arm gains an `app` branch. It asks for three directions each anchored on one named design
  system from `DESIGN_SYSTEMS`, briefed on type scale, spacing, control states, error
  treatment and 375px behaviour, and states that the taste-skill's landing-page parts are out
  of scope for this ticket in the skill's own words. The delegation target stays the file's
  existing author constant (`VISUAL_GATE_AUTHOR` at :1099 names `taste-frontend-expert`);
  which agent takes an app canvass is decision D6 and the prompt must read the choice from
  one place
- `dashboard/server/src/creative-contract.test.ts`, `creative-contract-author.test.ts`,
  `design-prompt.test.ts`

**Acceptance criteria.**
1. An `app` contract with one `form` section, one `feature` section, a hero and a footer
   compiles; the hero may be `centered_hero` without an exception.
2. **NEGATIVE CONTROL, four.**
   (a) An `app` contract with two `feature` sections fails `APP_SECTION_LIMIT` at the route.
   (b) A `saas_landing` contract with four `feature` sections still compiles: the rule is
   scoped to `app`. A rule that limits every route passes (a) and fails this.
   (c) An `app` contract with no `form` section fails `APP_FORM_REQUIRED`.
   (d) `designSegmentPrompt` with pageKind `saas_landing` is byte-identical to the golden hash
   captured at HEAD in a separate first commit; with pageKind `app` it contains the
   design-system anchoring sentence and does **not** contain a sentence that exists only in the
   landing canvass (pick one and pin it).
3. The author prompt's vocabulary line lists `app`, and the rule line is present.
4. This run's ticket, re-run through the author (fixture facts from T21's classifier), is
   expected to choose `app`; the test asserts only that `app` is offered, never what the
   model picks.

**Must not.** Must not remove or rename an existing page kind. Must not turn the design lane
off for app tickets. Must not choose the design system for the author. Must not touch the
video lane (T19 reads `pageKind` and picks the new value up on its own).

**Depends on.** T21. **Reversible: R.** **Survives abandonment: partly.** The page kind and
route rules are useful under any design lane; the canvass branch is specific to keeping one.

---

### T23 — A decorative-control probe in the creative render

**Goal.** A section that the contract says must have an interaction state but that contains
no focusable element is a `DECORATIVE_CONTROL` warning, naming every control-lookalike block
it painted, and the same fact reaches the critic.

**Why here.** Cause C3, "some buttons don't work". The four specimens (`RUN/workspace/index.html:180`
the `.chip` "Continue", :184-187 the `.box--bad` and its message, :191-194 the label over a
`.box`, :198-201 the muted line over `.bars`) are `<p>`, `<div>` and `<span>`; styles.css:514
says so in a comment ("non-interactive specimens: spans and divs only, never real controls").
The contract made it possible: s.nav, s.a11y and s.responsive are `real_component` with
`requiredStates [default, interaction]` and `actions []` (measured), `stateIsRepresented`
returns true for `interaction` unconditionally (`creative-render.ts:1484-1486`), and the
renderer's only interaction check is that the hover capture is not pixel-identical
(`creative-render.ts:884-903`). The render already holds a page with `evaluate`
(`CreativeRenderPage`, :85-108) and already injects a probe script (:240-290), so the DOM
measurement costs no new browser. The visual gate cannot host it: it receives PNG files only
(`visual-gate-run.ts:319-330`).

**Touches.**
- new `dashboard/server/src/decorative-controls.ts`: the in-page expression and a pure
  `classifyDecorativeControls(snapshot, section)`
- `dashboard/server/src/creative-render.ts:204-212` (`SectionSnapshot` gains
  `focusableCount` and `lookalikes[]`), :240-290 (the in-page probe; extend), :600-612 (add a
  fact per finding with the `contract` pointer evidence for `/sections/<i>/requiredStates`),
  the capture loop around :884-903 (emit the issue)
- `dashboard/server/src/render-manifest.ts:16-19` (`RENDER_ISSUE_CODES` gains
  `"DECORATIVE_CONTROL"`; severity `"warning"` already exists at :21 and is non-fatal at
  `creative-render.ts:1630-1632`)
- new `dashboard/server/src/decorative-controls.browser.test.ts` on the pattern of
  `motion-capture.browser.test.ts:3-19` (one chromium, fixtures under `src/test-fixtures/`)
- new fixture `dashboard/server/src/test-fixtures/clinic-131fd85f/{index.html, app/styles.css,
  app/main.mjs}` copied from `RUN/workspace` (12,711 + 19,335 + 8,720 bytes; `dashboard/runs/`
  is ignored so the copy must be committed)
- `dashboard/server/src/creative-render.test.ts:300` (`FakePage`) for the wiring test

**Definition, in the probe's terms (measured against the fixture).**
- Focusable: `a[href]`, `button`, `input`, `select`, `textarea`, `summary`, `[tabindex]`,
  `[contenteditable]`, and anything with a `role` that names a widget.
- Control-lookalike (shape A): an element that is not focusable, has no focusable descendant,
  no focusable or `label` ancestor, no ancestor with `role`, `aria-label` or
  `aria-labelledby`; whose computed style has a non-transparent background, a border or an
  outline, and a border-radius above zero; whose rendered height is 20 to 80 px; and whose
  text is at most four words. Catches `.chip` (44 px, cobalt, radius 10, outline 3 px,
  "Continue"; styles.css:515-528), `.box--bad` (:536) and `.box` (:529-535).
- Indicator-lookalike (shape B): an `aria-hidden="true"` block with two or more empty children
  that each have a background and a radius, and no ancestor with `role`, `aria-label` or
  `aria-labelledby`. Catches `.bars` (:547-549) and excludes the real progress bars, which sit
  inside `<nav aria-label="Booking progress">` (index.html:28).
- Section finding: a contract section with `visualKind real_component`, `requiredStates`
  including `interaction`, and `focusableCount === 0`.

**Acceptance criteria.**
1. On the fixture, `DECORATIVE_CONTROL` fires for `s.a11y` naming `.chip`, `.box--bad`, `.box`
   and `.bars`; for `s.nav` and `s.responsive` as section findings (both are the same contract
   shape and both received CSS-only hover rules for the same reason, FINDINGS §2 C3 item 3,
   relayed); and for no other section.
2. **NEGATIVE CONTROL, four.**
   (a) Green set, asserted element by element: every element inside `s.step1`, `s.step2`,
   `s.step3`, `s.confirm`, `s.hero` and `s.footer`, including the `.warn` glyph inside
   `<p role="status">` (index.html:79-82), the `.option` rows (:66-77, they contain an `input`),
   the `.slot` tiles (:108-126, `div.slot > input + label`), the `.spec` cards themselves
   (styles.css:505-510: border and radius but taller than 80 px), `.figure img` (:552) and
   the `.steps-list` rows (:561-562).
   (b) Mutate the fixture in the test: give `.chip` `role="button"` and `tabindex="0"`. The
   chip leaves the lookalike list and the `s.a11y` section finding clears (one focusable now
   exists). This proves interactivity is read from the DOM, not from class names.
   (c) A control-lookalike placed inside a `<label for>` is not flagged.
   (d) `FakePage` unit test: a snapshot with `focusableCount 0` on an interaction section
   yields the issue; `focusableCount 1` yields none; a probe stub that reports no lookalikes
   anywhere fails criterion 1.
3. The render stays `ok` with the warning in `manifest.issues`; the critic receives one fact
   per finding whose evidence is the contract pointer, so it can pair it with a region.
4. The issue is visible in the run's creative-review surface the way other warnings are.

**Must not.** Must not be `blocking` (decision D7 is whether it ever becomes so). Must not
add a taste category (wave 1 T10 owns the vocabulary). Must not scan source. Must not need
CDP or `getEventListeners`. Must not change `stateIsRepresented` (T24 territory, and the
section finding above is the honest replacement for it).

**Depends on.** Nothing. **Reversible: R.** **Survives abandonment: yes.**

---

### T24 — The critic runs on the captures that exist

**Goal.** A declared motion that was not observed, or that stayed active under reduced
motion, is a warning and a critic fact instead of a render refusal, so the rendered taste
critic reaches its first verdict and the `no_evidence` state from 5a7cf77 becomes reachable.

**CORRECTION, 2026-09-09, after T24 landed.** This section described a two-severity change and
was wrong. Demoting the two motion codes alone unblocks nothing: measured across every persisted
run that reached the renderer, two further mechanisms stop the manifest before the critic can be
called. (1) `render-manifest.ts` rejects an unobserved motion at **two** gates, not one, at what
were `:364` (a trace present with zero `observedProperties` on an active profile) and `:366` (no
trace at all for a declared motion and profile). (2) `creative-render.ts:1626` hashed each issue's
own explanatory text into `evidenceSha256`, while `render-manifest.ts:377-382` requires that digest
to resolve to a capture at the named profile, route and section, so every motion issue also failed
`ISSUE_REFERENCE_INVALID`. All three had to land together. They did, in `0f73cde`, `8ce8314`,
`536410c` and `fb6c277`, and the critic returned its first verdict in the project's history.
`SECTION_NOT_FOUND` and `CAPTURE_FAILED` stay blocking: a missing route identity and an empty
capture are not uncertainty about whether an animation ran.

**Why here.** Cause C5. The renderer captured 72 PNGs and then refused twice on
`MOTION_NOT_OBSERVED` and `REDUCED_MOTION_ACTIVE` (FINDINGS §2 C5 item 1, relayed; the
`"blocking"` severity of both is measured at `creative-render.ts:1051-1075` and :1085-1095).
The critic call at `orchestrator.ts:4517-4530` was never reached; `creative-status.json`
records `criticDisposition null`. Both refusals are questions the critic's own vocabulary
already asks (`taste-policy.ts:829` motion "undeclared motion, purpose mismatch"; :833
`reduced_motion` "animation remains active"). The renderer pre-empted the seat built to
judge them. "Host captures or single-process Chromium" is not a choice to make: the host
route exists and ran (`RUN/results/creative-render/0/captures`); what blocked the critic was
the refusal policy. A builder-side browser (BLIND-001) is a separate decision and stays one.

**Touches.**
- `dashboard/server/src/creative-render.ts:1045-1095` (the two issue sites become
  `"warning"`), :441-447 (unchanged: only `blocking` refuses), :475-485
  (`buildCreativeTastePromptInput`), :536-548 (motion traces with no observed property are
  skipped as evidence; keep that, and add the fact instead), :600-612 (facts: one per warning,
  evidence = the `contract` pointer for `/motion/<index>`, observation = profile, section, what
  was and was not observed), :1210-1215 (`creativeRenderRefusalClass`, unchanged)
- `dashboard/server/src/orchestrator.ts:4380-4414` (the one-repair branch stays for
  `blocking`), :4490-4500 (post-repair refusal), :4517-4530 (the critic call; the injectable
  `runRenderedTasteCritic` dep is the test seam)
- `dashboard/server/src/rendered-taste-critic.ts:46` (`MAX_CREATIVE_REVIEW_ATTEMPTS = 3`,
  unchanged), :63 (`CriticDisposition` incl. `no_evidence`)
- `dashboard/server/src/taste-policy.ts:516` (`motion_trace` evidence requires at least one
  observed property; unchanged, which is why the fact carries the contract pointer instead),
  :834-838 (`evidenceSufficient` rules)
- `dashboard/server/src/creative-pilot.ts:149-153` (`critic_no_evidence` stop reason),
  :1008-1016 (publish only on `accept` plus owner approval, or `revise` plus a reasoned
  owner waiver)
- tests: `creative-render.test.ts` (`FakePage`), `orchestrator.test.ts` (the critic-path tests
  5a7cf77 added), `rendered-taste-critic.test.ts`

**Acceptance criteria.**
1. `MOTION_NOT_OBSERVED` and `REDUCED_MOTION_ACTIVE` are emitted with severity `warning`;
   `SECTION_NOT_FOUND`, `PAGE_ERROR`, `BROKEN_NAVIGATION`, `CAPTURE_FAILED` and
   `HORIZONTAL_OVERFLOW` keep their severities.
2. Each such warning produces one `TastePromptFact` with the contract pointer evidence for its
   motion and a bounded observation naming the profile and section.
3. The render returns `ok` with the warnings in the manifest; the orchestrator proceeds to the
   critic; the review loop stays bounded at three.
4. **NEGATIVE CONTROL, four.**
   (a) A `FakePage` fixture reproducing this run's first refusal (`m.step` declared on
   `s.step2`, not observed on `desktop`) → render `ok`, one warning, and the injected critic
   seat receives a fact whose observation names `m.step` and `desktop`. A change that
   downgrades the severity and forgets the fact passes everything but this.
   (b) A fixture with `SECTION_NOT_FOUND` → still refused, critic **not** invoked. This is the
   control that the downgrade is scoped.
   (c) Critic output with empty findings and `evidenceSufficient: false` → disposition
   `no_evidence`, `reviewStopReason critic_no_evidence`, nothing published. This is the
   5a7cf77 state, now reached on the path this run took.
   (d) Critic output with one `reduced_motion` finding citing the contract pointer plus a
   region → disposition `revise`, and the builder's revision prompt carries the finding.
5. `docs/BACKLOG.md:26` CRITIC-001 moves from "unproven" to "reachable; first live verdict
   pending" with the test names as evidence, not to "resolved".

**Must not.** Must not give the critic source, HTML, CSS or image bytes (`taste-policy.ts:209`;
decision D8 is separate and not in this wave). Must not change the critic schema (T3 shipped
v2). Must not raise the attempt cap. Must not remove the one-repair branch for blocking
issues. Must not touch the sealed gate.

**Depends on.** T23 is not required, but its facts only reach the critic once this lands.
**Reversible: R.** **Survives abandonment: yes.**

---

### T25 — The chooser reads the contract, reads every still, and must name a departure

**Goal.** A direction choice is valid only when the chooser has the contract in hand, has
read every canvass still, and states for each direction the generic default a similar brief
would get and how the direction departs from it; a pick whose own departure is empty is
refused; and on an interactive run that times out, a judged recommendation is applied before
the first-in-manifest fallback.

**Why here.** Cause C4. The chooser's recorded reason picks "the most templated artifact of the
three" and defers character to a builder that "never saw this page render"
(`RUN/results/design-lock.json:50`, `build.log:226`, relayed). It never read
`creative-contract.json` (0 event rows for node n13 mention it, FINDINGS §2 C4 item 2,
relayed). The host validates only `chosen` and `reason`, substitutes `"no reason given"` for a
blank reason (`design-lock.ts:239`) although `chooseDirection` refuses a blank one forty lines
earlier (:199-201), and on an interactive timeout applies the first direction in manifest
order (`orchestrator.ts:1879`, `design-lock.ts:251-260`). Fifteen locks on disk, zero by the
owner (FINDINGS §2 C4 fix shape, relayed). Wave 1's T8 wires the owner's own pick; this task
makes the machine's pick worth comparing against.

**Touches.**
- `dashboard/server/src/design-prompt.ts:526-546` (the chooser delegation; the JSON shape at
  :541 becomes v2; the condition `input.autoChoose && canvass` at :526 becomes `canvass`, with
  the wording switching between "select" and "recommend"), :124
  (`DESIGN_DIRECTION_CHOICE_FILE`)
- `dashboard/server/src/design-lock.ts:221-241` (`readDirectionChoiceFile`: validate v2, refuse
  a blank reason, refuse an empty departure for the chosen slug), :184-211 (`chooseDirection`,
  unchanged), :251-260 (`fallbackDirectionChoice`, unchanged), :162-167 (`DirectionAttempt`
  gains the per-direction block so the record keeps it)
- `dashboard/server/src/orchestrator.ts:1871-1884` (timeout path: recommendation file first,
  then fallback), :5536-5550 (auto path: unchanged order, v2 validation), :6168-6205
  (`#applyDirectionChoice`: log the departure)
- `dashboard/server/src/design-manifest.ts:98-106` (`DesignDirection`) and the lock record
  (`design-lock.ts:443-458`) gain `directionDepartures` so the dashboard and the wave 1 deck
  builder (T6) can show them
- `dashboard/src/components/run/design-directions.tsx` (show the recommendation on the park;
  optional, small)
- tests: `design-lock.test.ts`, `design-prompt.test.ts`, the design-run tests in
  `orchestrator.test.ts`

**Acceptance criteria.**
1. Choice file v2: `{ chosen, reason, directions: { <slug>: { genericDefault, departure } } }`
   for every slug in the manifest. The prompt lists the absolute path of the contract and of
   every canvass still and says both must be read before writing the file.
2. `readDirectionChoiceFile` refuses (returns null with a logged reason) when: the file is v1;
   any manifest slug is missing from `directions`; the chosen slug's `departure` is blank; the
   `reason` is blank. A refusal is logged with the exact field.
3. Interactive run: the design lane always writes the file as a recommendation. On timeout,
   the host applies it with `by: "ui-designer"` and the recorded reason; only when it is absent
   or refused does `fallbackDirectionChoice` fire, and the record says which. An owner pick
   always wins over the recommendation.
4. **NEGATIVE CONTROL, five.**
   (a) A v1 file `{chosen, reason}` → refused; the run records the refusal and falls back
   honestly (`by: "fallback"`).
   (b) A v2 file whose chosen slug has `departure: ""` → refused.
   (c) A v2 file with a blank `reason` → refused. **Run this against the pre-change code
   first and record that it passes today** (`"no reason given"` is accepted and filed as a
   judgement); that is the red-before this task needs.
   (d) A complete v2 file → accepted, `by: "ui-designer"`, departures on the record.
   (e) Timeout path: recommendation present → `by: "ui-designer"`; absent → `by: "fallback"`
   with the timeout reason; owner pick present alongside a recommendation → `by: "owner"` and
   the recommendation is recorded, not applied. A change that applies the recommendation over
   the owner passes (a) to (d) and fails this.

**Must not.** Must not extend the park timeout (wave 1 rule). Must not spend a metered call on
refusal (decision D9 is whether a refused pick may re-canvass). Must not let the design lane
choose for itself: the delegation target stays `ui-designer`. Must not remove
`fallbackDirectionChoice`: an honest arbitrary pick is better than no expansion.

**Depends on.** T16 (so the dashboard copy can print the departure). **Reversible: R.**
**Survives abandonment: yes** (the chooser exists under any lane that offers directions).

---

### T26 — The hero layout family is settled by the chosen direction, not before it

**Goal.** After the direction is chosen, one bounded author turn may amend the contract's hero
`layoutFamily` and its mobile plan to match the direction; anything else in the amendment is
refused and the original stays frozen.

**Why here.** The remaining piece of C4 and the order problem behind C1: the contract froze at
seq 13 with s.hero `asymmetric_split`; the first design-lane spawn is seq 91; the chosen
direction says "Where the asymmetry lives: nowhere. This direction is deliberately symmetric."
(`direction-soft-clinic-card.md:22`, measured). The design lane was handed the frozen
contract (`orchestrator.ts:5103`, measured) and offered a contradicting direction anyway;
nothing enforces the contracted hero layout downstream (FINDINGS §2 C4 item 6, relayed). Two
fixes exist: author the contract after the choice, or let the choice amend the one field the
direction owns. This task is the second, because the author's bounded repair loop already
exists (`creative-contract-author.ts:204` `repairFindings`, :470-485; `orchestrator.ts:4095-4160`)
and the first re-sequences three phases. Decision D10 records the alternative.

**Touches.**
- `dashboard/server/src/design-prompt.ts:510-522` (the per-direction dial lines gain a required
  `HERO_LAYOUT_FAMILY: <one of LAYOUT_FAMILIES>` line, drawn from `creative-contract.ts:41`)
- `dashboard/server/src/design-manifest.ts:709-717` (`readDesignDirection`) plus a parser for
  the new line
- `dashboard/server/src/orchestrator.ts:6168-6205` (`#applyDirectionChoice`: after the lock,
  compare and amend), :4095-4160 (the author loop; :4098 reuses a fresh contract, :4108
  selects the author, :4152 passes `repairFindings`)
- `dashboard/server/src/creative-contract-author.ts:297-308` (`creativeAuthorStep` outcomes
  `proceed | stop | consume`), :470-485 (`repairFindingsBlock`, `buildPrompt`)
- `dashboard/server/src/creative-pilot.ts:778-820` (`freshCreativeContract`: freshness is the
  frozen `contractHash` in `creative-contract-author.json` (`status: "compiled"`, measured
  fields) against a recompile of `creative-contract.json`; an accepted amendment must update
  both and append `amendments: [{ from, to, at, changedPaths, reason }]`)
- `dashboard/server/src/creative-contract.ts:41` (`LAYOUT_FAMILIES`), :1120 (`CENTERED_HERO`
  needs an exception outside editorial, event_landing and, after T22, app), :1092-1093
  (`MOBILE_COLLAPSE_REQUIRED` for multi-column families, which is why the mobile plan is in
  the allowed diff)
- `orchestrator.ts:4219` (`#freshCreativePrompt` reads the contract at build time, after the
  design lane, so the amended contract reaches the builder without further wiring)
- tests: `creative-contract-author.test.ts`, `creative-pilot.test.ts`, `orchestrator.test.ts`

**Acceptance criteria.**
1. If the chosen direction's `HERO_LAYOUT_FAMILY` equals the contract hero's `layoutFamily`,
   nothing runs and nothing is written.
2. Otherwise exactly one author call runs with one repair finding at
   `/sections/<hero>/layoutFamily` stating the direction's family and that only the hero's
   layout family, its mobile plan and a `CENTERED_HERO` exception for that hero may change.
3. The amendment is accepted only when the canonical JSON diff against the frozen contract is
   confined to `/sections/<hero>/layoutFamily`, `/sections/<hero>/mobile/*` and
   `/intentionalExceptions/*` entries whose rule is `CENTERED_HERO` scoped to the hero, and it
   compiles. On acceptance both files are rewritten, the new hash is frozen, and the amendment
   record is appended. On refusal the original hash stands and the refusal is recorded with the
   offending paths.
4. **NEGATIVE CONTROL, five.**
   (a) Same family → zero author invocations (count them), `creative-contract.json`
   byte-identical, hash unchanged.
   (b) Different family, author output also changes a headline → refused; hash unchanged;
   refusal names `/sections/<i>/headline`. A diff checker that ignores paths passes (c) and
   fails this.
   (c) Different family, confined change → accepted; `freshCreativeContract` reports fresh
   against the new hash and not fresh against the old.
   (d) Direction note without the line → no amendment, recorded as unknown, never guessed.
   (e) The author call returns `stop` or `unavailable` → no amendment, original stands, the
   attempt is recorded; the run continues to the build.
5. The dial prompt change ships with a golden hash of the unchanged branches, captured first.

**Must not.** Must not run more than one author call. Must not change dials, proofs, copy or
any section other than the hero. Must not re-sequence the phases. Must not amend on a
`fallback` pick (an arbitrary pick should not rewrite the contract; record that it was
skipped for that reason).

**Depends on.** T25 (the direction note format and the chooser's validation). **Reversible:
R** for the code; an amended contract is a new frozen artefact, recorded as such.
**Survives abandonment: partly.** Only useful while directions are authored at all.

---

### G3 — OWNER GATE: the control run *(not a Codex task)*

**Goal.** The same clinic ticket, once more, after T19 to T24 have landed: `app` page kind, a
design-system-anchored canvass, no video legs, the critic reached. Compared against
run-2026-09-04T15-54-06-323Z-131fd85f by the owner's own verdict and, once wave 1's T6 exists,
by one pairwise pick between the two hero captures.

**Why here.** FINDINGS §6 names this as the single unmeasured comparison: without a control,
"no taste" cannot be compared against anything. A run costs one to twelve hours and real model
budget (CODEX-BRIEF-wave1 stage 3), so it is the owner's to start, never Codex's.

**Acceptance.** `results/video.json` records `allowed: false` with the reason; the contract's
`pageKind` is `app`; `creative-status.json` has a non-null `criticDisposition`; the owner's
verdict is recorded beside the previous one, in the owner's words, in a `note` commit.

**Depends on.** T19, T21, T22, T24. **Reversible: NOT-R** (budget spent, and the owner's
first impression of the control cannot be re-taken). **Decision D11.**

---

## 3. Non-goals for this wave

| Excluded | Why |
|---|---|
| Replacing `taste-frontend-expert` with a judge, benchmark or renderer from the research pack | None produces a design; every judge candidate sits near 60 to 70 percent agreement with humans (FINDINGS §4). The lane was applied out of its stated scope; T22 fixes the routing |
| Giving the sealed builder a browser (BLIND-001) | Every route needs a loopback CONNECT from the sealed seat, and the only recorded measurement is a failure without a control (FINDINGS §6). Measure first; it is not on the critic's path (T24) |
| Handing the critic source (WebDevJudge's code-only 67.58 against screenshot-only 59.48) | It contradicts `taste-policy.ts:209` by design and changes what the critic is. Decision D8, after the first verdict exists |
| Personalising anything | 0 owner picks in 15 locks; wave 1 T6 to T8 own that supply |
| Making `DECORATIVE_CONTROL` or the judge gating | Both unproven on more than one run; decisions D4 and D7 |

---

## 4. Order, dependencies and what survives abandonment

```
T15 canvas titles ─────────────────────────────────────────────┐
T16 lock copy ── T25 chooser ── T26 hero deferral               │
T17 judge → verdict                                             │
T18 preview exposure                                            ├── G3 CONTROL RUN
T19 video gate ── T20 motion floor                              │
T21 claim taxonomy ── T22 app page kind                         │
T23 decorative probe ─┐                                         │
T24 critic route ─────┴─ (T23's facts reach the critic here) ───┘
```

| Task | Depends on | Reversible | Survives dropping the taste lane? |
|---|---|---|---|
| T15 canvas titles | — | R | **Yes** |
| T16 lock copy | — | R | **Yes** |
| T17 judge → verdict | — | R / R-additive | **Yes** |
| T18 preview exposure | — | R | **Yes** |
| T19 video gate | — | R | **Yes** |
| T20 motion floor | T19 | R | **Yes** |
| T21 claim taxonomy | — | R | **Yes** |
| T22 app page kind | T21 | R | Partly (rules yes, canvass branch no) |
| T23 decorative probe | — | R | **Yes** |
| T24 critic route | — (T23 soft) | R | **Yes** |
| T25 chooser | T16 | R | **Yes** |
| T26 hero deferral | T25 | R | Partly |
| **G3 control run** | T19, T21, T22, T24 | **NOT-R** | it is the measurement |

Wave 1 cross-links: T25's departures feed T6's deck; T24 is what makes T3's `no_evidence`
observable; T20 and T19 share the exported threshold; nothing here touches T13's flag or
T14's promotion rule.

---

## 5. Decisions that are the owner's, not Codex's

| # | Decision | Default if unanswered | Task |
|---|---|---|---|
| D1 | Does `debug` get its own hue, or does a debugger node read `review` with `debugger` on the secondary line? | Own hue, chosen inside the constraints `roles.ts` documents | T15 |
| D2 | The preview deny list: is `.well-known` exempt from the dot rule, and is `node_modules` denied? | `.well-known` denied like any dot segment; `node_modules` served (some static apps reference it) | T18 |
| D3 | On a run with no creative contract, does the video lane keep today's behaviour or switch off? | Keep, recorded as "policy not applied" | T19 |
| D4 | Should the code-reading judge ever gate? | No; render only | T17 |
| D5 | Requirement-kind proofs: `alt` only, or no copy use at all? | `alt` only | T21 |
| D6 | Which agent takes an `app` canvass: `taste-frontend-expert` on a form brief, or `ui-designer`? The agent files live in `~/.claude/agents/`, outside this repository | `taste-frontend-expert`, on the form brief, with the skill's own out-of-scope sentence in the prompt | T22 |
| D7 | Should `DECORATIVE_CONTROL` become `blocking`, and should the fix seat consume it? | `warning`, critic fact only, until it has fired on three runs | T23 |
| D8 | Give the critic `index.html` and `styles.css` (WebDevJudge's code-only result), reversing `taste-policy.ts:209`? | Not in this wave | T24 |
| D9 | A refused chooser pick: re-canvass (metered spend) or fall back? | Fall back, honestly recorded | T25 |
| D10 | Hero layout: amend after the choice (T26) or re-sequence the author to run after the choice? | Amend | T26 |
| D11 | Start the control run, when, and at what budget? | Not started by Codex under any circumstance | G3 |
| D12 | Does `taste-frontend-expert` stay the author for landing and marketing tickets? The research supports keeping it there after C1 to C4 are fixed; the owner's verdict on this run is on a ticket it excludes itself from | Keep, pending G3 | T22 |
