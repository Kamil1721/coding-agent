---
document_status: findings
verified_at_commit: 759d1be
verified_on: 2026-09-05
run: run-2026-09-04T15-54-06-323Z-131fd85f
---

# Findings: the clinic booking run, verified 2026-09-05

## How to read this

This records what the pipeline did on run-2026-09-04T15-54-06-323Z-131fd85f (ticket: a three-step clinic booking wizard, 21 of 21 criteria passed, 2h34m), why the owner rejected the delivered page, and which of the eight inline findings from 2026-09-05 survived independent refutation. Each finding was refuted by a separate seat. Every load-bearing claim below was then re-verified at commit 759d1be by opening the file, running the query, or driving the page.

Roots used below:

- RUN = /Users/kamilborzecki/Projects/coding-agent/dashboard/runs/run-2026-09-04T15-54-06-323Z-131fd85f
- SRC = /Users/kamilborzecki/Projects/coding-agent/dashboard/server/src
- DB = /Users/kamilborzecki/Projects/coding-agent/dashboard/data/runs.db, table events (run_id, seq, at, payload). "seq N" means `select payload from events where run_id='run-2026-09-04T15-54-06-323Z-131fd85f' and seq=N`.
- SKILLS = /Users/kamilborzecki/.claude/skills

Labels:

- measured: I opened the file, ran the query, or drove the page on 2026-09-05.
- refuter: the refuting seat measured it on 2026-09-05 and I did not repeat it.
- inferred: reasoning from measured facts, said so where it occurs.

One caveat scopes every live number in this document. The preview at http://127.0.0.1:4321 today is `python -m http.server 4321 --bind 127.0.0.1`, PID 9413, parent PID 1, started Sat Sep 5 09:32:31 2026, serving RUN/workspace (measured: `lsof -nP -iTCP:4321 -sTCP:LISTEN`; `ps -o lstart -p 9413`). The pipeline's own preview is stopped when a run finishes (SRC/orchestrator.ts:8820, `void this.#deps.preview.stop(runId)`). Page behaviour measured against 4321 is the page's. Server behaviour measured against 4321 is Python's.

Run record (measured): `select status, preview_url, failure_reason from runs where run_id='run-2026-09-04T15-54-06-323Z-131fd85f'` returns `passed`, `http://127.0.0.1:4321`, and an empty failure reason. RUN/results/creative-status.json:23 `heldOutPass: true`. seq 901 records the held-out suite GREEN at 34 of 34 tests. RUN/results/run.json `heldConstants.harness.commit` is `unversioned`, so the commit the run executed is not on the record; /Users/kamilborzecki/Projects/coding-agent/dashboard/server/dist/orchestrator.js was built 2026-09-04 17:26 local, 28 minutes before the run started (run.json startedAt 2026-09-04T15:54:06.340Z).

## 1. The delivered page, looked at

| The owner's words | What is on the page | Where it comes from | Measured |
|---|---|---|---|
| "weird scrolling animation in the background" | Two Veo 3.1 clips of the design mockups, mounted as `<video class="world__layer" data-world-leg="1">` and `data-world-leg="2"` inside a fixed `.world` at 118% scale behind a cream veil at opacity 0.9 (RUN/workspace/index.html:12-16; RUN/workspace/app/styles.css:56-85). `startWorld()` in RUN/workspace/app/main.mjs:200-263 sets `video.currentTime` from `scrollY / (scrollHeight - innerHeight)` on each frame (:233-246) unless prefers-reduced-motion (:258). | Cause C2, the video lane | Playwright headless 1280x800 against 4321: scroll span 3251; leg 1 currentTime 0, 2.95, 4.0 at scrollY 0, 1200, 2600; leg 2 opacity 0 to 1 and currentTime 2.4 at 2600, 4.0 at the bottom; veil opacity 0.9; `.world` position fixed; layer width 1510.39 px (118% of 1280); document width 1280, no horizontal overflow. RUN/results/video.json: legsProduced 2, veo-3.1-generate-preview, 720p, 4 s each, meteredSeconds 8. |
| "generic Claude vibe with the cream background" | Field #f5efe1, card #fdfbf6, cobalt #1d4ed8, a system sans stack (styles.css:6-18). styles.css:1-2 says the palette is from direction-soft-clinic-card.md, whose palette table gives #F5EFE1 "warm oat cream, the only background" (RUN/workspace/design-refs/direction-soft-clinic-card.md:37). The wrapper is a landing page: hero, the wizard, four feature or editorial sections, a footer. | Cause C1 (paletteFamily and pageKind frozen in the contract) and C4 (the chooser) | RUN/results/creative-contract.json designRead: pageKind `saas_landing`, paletteFamily `cobalt_cream`; frozen at seq 13, before the first design-lane spawn at seq 91. Viewed: /Users/kamilborzecki/Projects/coding-agent/dashboard/results/screenshots/run-2026-09-04T15-54-06-323Z-131fd85f/wizard-step-1__1280.png shows a pale "Step 1 of 3" in the mockup's type above the real card, bleeding through the veil from the leg-1 poster. |
| "some buttons don't work" | Four specimens under s.a11y: h3 "Visible focus ring" over a cobalt "Continue" pill with a permanent 3 px outline (index.html:179-180; styles.css:515-528); "Never color alone" over a red-bordered box and a "Choose a date" message (:183-187; :536); "Label above the field" over a 44 px field (:190-194; :529-535); "Progress is text too" over three 6 px bars (:197-201; :547-549). All are `<p>`, `<div>` and `<span>`; styles.css:514 says "non-interactive specimens: spans and divs only, never real controls". A hover rule makes the cards react to the pointer (styles.css:484-488). | Cause C3 | The four `.spec__demo` wrappers are P, DIV, DIV, DIV; role null; tabindex null; cursor auto. Focusable elements inside s.a11y: 0. The chip is 105x44 px, background rgb(29,78,216), outline solid 3 px, cursor auto. Clicking `.chip`, `.box--bad`, `.spec__label` and `.bars` in turn left the wizard unchanged (step-1 panel display block, progress "Step 1 of 3: appointment type", no shown error, activeElement BODY). |
| "I don't see the purpose of this form" | Below the wizard, four sections whose headings restate the ticket: "Keyboard first, labelled, and never color alone" (index.html:173), "Works at 375px without horizontal scroll" (:209), "Everything stays on your machine" (:223), "Run it locally from a fresh start" (:231), and the body sentence "The page exposes deterministic route, section, and motion data markers for rendered capture" (:232). Compare RUN/workspace/TICKET.md:7-13. | Cause C1 | Sections carry data-creative-section s.a11y, s.responsive, s.local, s.run at :171, :207, :220, :229. Whether "purpose of this form" means the wizard or these sections is not recoverable from the artefacts (inferred pairing). |
| "no taste in any of it" | The sum of the above: a direction its own chooser called "the most templated artifact of the three" (RUN/results/design-lock.json:50), character deferred to a builder that "never saw this page render" (RUN/results/build.log:226), a background the direction forbade (direction-soft-clinic-card.md:58), copy that is the spec, controls that are pictures. | C1 to C4, let through by C5 | No seat that sees pixels reached the verdict (section 3). |

What works. The wizard the ticket asked for works end to end. Measured at viewport 375x740 against 4321:

| Check | Result |
|---|---|
| innerWidth, documentElement.scrollWidth, body.scrollWidth | 375, 375, 375 |
| Empty Continue on step 1 | #type-error shows "Choose an appointment type before continuing."; aria-invalid="true" on all three type radios; focus moves to #type-general-consultation |
| Choose a type, Continue | focus #step-2-heading; 4 slot inputs; `.slots` grid 2 columns (139.5 px each) |
| Date 2026-09-10, afternoon, Continue | focus #step-3-heading |
| Back from step 3 | date still 2026-09-10; #slot-afternoon still checked |
| Smallest interactive target height | 56 px (buttons and text links; the radio tiles are 67 px; the skip link, hidden until focused, is 53 px) |
| Console messages and failed requests after the flow | 0 and 0 |

Refuter, not repeated by me: the step-3 review rows read "Follow up visit", "Thursday 10 September 2026", "Afternoon, 13:00 to 16:00"; Confirm reaches the confirmation with focus on #confirm-heading; "Book another appointment" returns to step 1 with no type checked, the date cleared and no error shown. The sealed gate agrees (seq 901, 34 of 34).

So "some buttons don't work" means the four specimens. The buttons of the wizard work.

## 2. Ranked causes

Ordered by how much of the owner's five complaints each explains. Each cause has Mechanism, Effect, Evidence and Fix shape.

### C1. The contract turned the ticket into a landing page and its requirements into copy

Explains: "purpose of this form", the four spec sections and the harness sentence as copy, the existence of s.a11y (the specimens' home, C3), the cream (paletteFamily), and the hero mismatch. Largest share.

Mechanism (measured):

1. SRC/creative-pilot.ts:522-531 pushes every chunk of the owner brief into the author packet with kind `goal` (ids `ticket.goal.N`, locators `ticket:<id>:brief:N`). Kind `constraint` is used only for plan answers (:533-541). The harness then adds its own fact `host.web-surface`, kind `technical_constraint`: "The delivered page must expose deterministic route, section, and motion data markers for rendered capture." (:543-550).
2. SRC/creative-contract-author.ts:525: "Turn supported claims into contentProof entries and authorize only their actual uses. Every section needs one focused job and evidence-linked content." Nothing in the rule block (:521-532) says a requirement is not copy.
3. SRC/creative-contract.ts:478-484, invariant content-proof-coverage: every contentProof id must be referenced by a section or an action; "omit every unreferenced contentProof entry". The compiler never reads fact kind (refuter: its contentProof checks are digest at :1018, banned copy at :1019, allowedUses at :1063 and :1079, unused at :1095).
4. SRC/creative-contract.ts:11, PAGE_KINDS: saas_landing, consumer_landing, agency_landing, event_landing, portfolio, editorial. No app, tool or form kind. The contract chose saas_landing on both author attempts (RUN/results/creative-contract-author-attempt-1.txt contains `"pageKind":"saas_landing"`; attempt 1 was COMPILE_REJECTED per attempt-1.json; attempt 2 compiled, seq 13).
5. SRC/creative-pilot.ts:828-829 puts "Every contracted section MUST carry data-creative-section" into the build prompt; SRC/creative-render.ts:1204 raises blocking SECTION_NOT_FOUND when a route section is absent.
6. The contract compiled and froze at seq 13 ("author attempt 2 of 3"). The first design-lane Agent spawn is seq 91. The design lane was then handed the frozen contract (orchestrator.ts:5103 appends the contract projection to the phase prompt).

Effect (measured):

| Item | Count | Source |
|---|---|---|
| Sections in the route | 11 | creative-contract.json routes[0].sectionIds |
| Sections that exist to restate requirements | 4 | s.a11y, s.responsive, s.local, s.run; index.html:171-241 |
| contentProof entries | 12 | creative-contract.json |
| Proofs backed by a requirement paragraph or the harness note, licensed for headline or body | 6 | p.local, p.a11y, p.focus, p.responsive, p.run (brief locators); p.markers (harness fact, allowedUses body and alt) |
| Page kinds available | 6 | creative-contract.ts:11 |
| Page kinds that describe an app or a form | 0 | same |
| Stills the design lane drew for the requirement sections | 4 | build.log:103-105 (07-a11y, 08-responsive, 09-local, 10-run); design-prompt.ts:716-717 demands one per section |

The pipeline's own render-instrumentation note became patient-facing copy at index.html:232. The contract's s.hero is layoutFamily asymmetric_split while the chosen direction says "Where the asymmetry lives: nowhere. This direction is deliberately symmetric." (direction-soft-clinic-card.md:22); the author offered, and the chooser picked, a direction that contradicts the contract both had (C4).

Fix shape:

- Classify at sentence level in creative-pilot.ts:522-531. TICKET.md:7 mixes a product sentence and a "do not use" constraint in one paragraph, so paragraph granularity cannot separate p.local from p.reset. Requirement sentences get constraint, accessibility or technical_constraint; product sentences stay goal.
- Carry `kind` on the evidence resolution (refuter: CreativeEvidenceResolution at creative-contract.ts:85-88, set at creative-pilot.ts:512) and add a compiler invariant: a proof of kind constraint, accessibility or technical_constraint may be used at most as alt, never headline, body, eyebrow, metric, quote or action.
- Add an app page kind and a route-level rule that an app route carries at most one feature or editorial section.
- Never feed the harness's own capture note as a copy fact.
- creative-contract-author.test.ts has no requirement-shaped goal fact (refuter: fixture at :74-81); add one and assert it cannot reach a headline.

Correction recorded (section 5): the fact-kind allow-list as first proposed would have blocked one proof of six, because the brief arrives tagged goal.

### C2. The host mounts any produced video leg as a scroll-scrubbed background, whatever the direction says

Explains: "weird scrolling animation" wholly; part of "no taste" (mockup type through the veil).

Mechanism (measured):

1. Legs are opt-in at the design lane. SRC/design-prompt.ts:480-486: `"animate": true` on a ref "is the ONLY thing that asks for one"; "mark none where the motion does not earn it". The canvass branch (:470-477) forbids marks. The mark is a design-lane decision. (This corrects F1 as first stated; see section 5.)
2. The expansion agent marked two stills, soft-clinic-card-04-step1.png and 06-confirm.png (RUN/workspace/design-refs/manifest.json, origin expansion), for contract motions m.error ("the inline validation message fading in") and m.confirm ("a single settle on the confirmation summary"), RUN/workspace/design-refs/direction.md:52-55. In the contract those motions are css, opacity-only, triggers interaction and enter_view; intentionalExceptions is empty; dials.motionIntensity is 3 (creative-contract.json).
3. The host generated the legs itself: seq 623 and 624 are graph_tool rows on node n1 (the orchestrator's own session, seq 70) calling gemini-video.sh for leg-1 (step1) and leg-2 (confirm). SRC/design/video-lane.ts:149-154 prompts Veo for "A slow, continuous camera move through this exact scene ... No cuts, no new subjects, no text. The first frame is the supplied still." The supplied still is a text-only UI mockup, so the clip is a drift over mockup type.
4. SRC/design/video-lane.ts:165-185 `videoConsumptionPrompt` emits, for any produced leg, the heading "SCROLL-SCRUBBED WORLD LAYER" followed by "implement exactly this pattern. It is measured from the reference site's runtime behaviour, not invented" and the rAF `currentTime = f(scrollProgress)` recipe. SRC/orchestrator.ts:5087-5101 splices it into the build prompt under the comment "APPENDED UNCONDITIONALLY". It landed at RUN/results/prompt.txt:217-233. This ticket has no reference site; the sentence is false for this run.
5. Nothing on that path reads the contract dial. `grep -rln motionIntensity SRC` (non-test) returns creative-contract.ts only. The contract's rule MOTION_DIAL_CONFLICT at creative-contract.ts:1149 (scroll_progress needs intensity 8 or an exception) and the author rule at creative-contract-author.ts:531 cannot fire, because the world layer is never a contract motion entry.
6. The quality floor rewards the outcome. SRC/visual-criteria.ts:133-137, printed at RUN/results/visual-gate.md:37-38 (VIS-MOTION-AUTHORED): "Satisfied by ANY of: a scroll-scrubbed video ... Not satisfied by hover lifts, opacity fades or transition-all alone". SRC/builders/antislop-rules.ts:1123-1132 tells the builder it "may not declare done without one authored motion moment" of the same kinds. The contract's three motions are css fades (m.error and m.confirm opacity-only; m.step opacity plus a transform slide) and fail both texts.

Effect (measured, section 1). The chosen direction says "exactly one motion, a cross-fade with 4px of travel, and no scroll-driven or continuous animation anywhere" (direction-soft-clinic-card.md:58); the expansion repeats "no scroll-driven or continuous animation anywhere" (direction.md:13). The design agent asked for two small on-card fades and received a full-bleed background world with the mockup's own text in it.

| Number | Value | Source |
|---|---|---|
| Legs attempted, produced | 2, 2 | RUN/results/video.json |
| Clip length, resolution | 4 s, 720p | video.json; refuter ffprobe: h264 1280x720, plus an aac track |
| Contract motionIntensity | 3 | creative-contract.json dials |
| Direction motion intensity | 2 (canvass), 3 (expansion) | direction-soft-clinic-card.md:58; direction.md:13 |
| Intensity the author rule demands for scroll-progress motion | 8 to 10 | creative-contract-author.ts:531 |
| Non-test source files that read motionIntensity | 1 | grep, creative-contract.ts |
| Plan criteria about motion | 0 | RUN/results/plan.json (refuter; re-read: plan.json holds no criteria at all, state.plan is empty and closed with "nothing to ask"; the 21 graded criteria are the sealed suite's, seq 60) |

Fix shape:

- In video-lane.ts, carry the marked ref's contract motion trigger into leg planning (video-lane.ts:219 `planVideoLegs`) and refuse a leg whose trigger is not scroll_progress or whose contract intensity is below 8; or mount interaction and enter_view legs as state-triggered clips inside their section, never as a page world.
- Delete the "measured from the reference site's runtime behaviour" sentence; it describes kamilborzecki.dev (refuter: visual-criteria.ts:31, :47).
- Make VIS-MOTION-AUTHORED and the antislop motion rule read the dial and the contract motion list: a css fade the contract declares is authored motion.
- Give the plan a motion criterion so a contradiction between direction and build can be graded.

### C3. Four controls that are pictures

Explains: "some buttons don't work" directly; a secondary part of "purpose of this form" (fragments of the form drawn below the form).

Mechanism, three seats (measured):

1. Contract. s.a11y is kind feature, visualKind real_component, requiredStates [default, interaction], actions [] (creative-contract.json sections). s.nav and s.responsive have the same shape; s.run differs only in declaring one secondary action, a.run. No compiler invariant links requiredStates to actions: creative-contract.ts:1147 checks only motion triggers, and creative-render.ts:1484-1486 `stateIsRepresented` returns true for "interaction" unconditionally. The author prompt carries no guidance on requiredStates (refuter: zero occurrences of "requiredStates" or "interaction" in creative-contract-author.ts).
2. Design lane. design-prompt.ts:716-717 demands one PNG per section, so the expansion drew soft-clinic-card-07-a11y.png of miniature controls (manifest.json lists it with origin expansion; refuter quotes its intent "Proves each accessibility behaviour with a real miniature control rather than iconography").
3. Builder. It read the held-out suite and shaped the markup to it. build.log:217-221: `findButton` scans button and role=button (RUN/workspace/visible-acceptance/booking-wizard.spec.mjs:40-44); the progress reader takes the first "Step N of 3" match in body.innerText (:246-247); `dateInput` is a broad `.first()` locator (:113-114). Hence "Every a11y specimen is a `<span>`/`<div>`" (build.log:221) and styles.css:514. The builder's own tests enforce it: RUN/workspace/tests/markup.test.mjs:178-183 forbids any input, button or role below `</main>`; :199-212 only guards that the specimen text differs from the live messages. Then, because s.nav, s.a11y and s.responsive require an interaction state but declare no actions, and stripping controls "left them with nothing to hover", the builder added CSS-only hover rules (build.log:228; styles.css:484-488) and a test that they exist (markup.test.mjs:266-273).
4. Renderer. For a section with no primary action the capture hovers the section itself (creative-render.ts:1231-1246), and the only check is that the interaction capture is not pixel-identical to default (creative-render.ts:884-903). A hover colour change on an inert div passes.
5. Nobody looked. build.log:226; the adversary was static (section 3); RUN/results/adversary.json's only inertness finding is about main.mjs failing to load.

Effect (measured, section 1): a pill that reads "Continue", painted as the focused state of a button, inside a card that reacts to hover, that does nothing on click. The "Visible focus ring" panel demonstrates focus using an element that can never receive focus (styles.css:526-527 paints the outline permanently).

Refuter reading, not verified by me: the builder's two stated traps (build.log:220-221) do not hold in DOM order, because the real "Step 1 of 3" text and the real date input both precede the a11y section, so the first-match helpers would have bound to the real controls. The hazard is a builder misreading the suite rather than the suite rewarding fakes. Inferred from index.html order; not executed.

Fix shape:

- Remove the section by C1; without s.a11y the specimens have no home. (The responsive figure and the run instructions have real homes: the README and, if kept, one editorial section.)
- Compiler invariant near creative-contract.ts:1050: requiredStates may include interaction only when actions is non-empty or kind is form or navigation; fix stateIsRepresented.
- Remove the section-level page.hover fallback (creative-render.ts:1241-1246) or turn it into a blocking issue.
- Any decorative-control probe needs a negative control: the shipped `.chip` (44 px, filled, radiused, permanent outline, not focusable) and the 6 px `.bars` are the positives; `.spec` cards (styles.css:505-510), `.figure img` (:552-558) and `.steps-list` rows are the negatives a naive "44 px bordered block" rule would flag.

### C4. The chooser picked the safest direction on purpose and deferred character to a builder that could not see

Explains: part of "generic" and "no taste". Not the cream (frozen by C1 before any direction existed; all three directions sat on cream per the refuter: #F5EFE1, #FAF8F2, #F4F2ED). Not the video (C2). Not the dead buttons (C3).

Mechanism (measured):

1. SRC/design-prompt.ts:537-539 tells the lane to delegate to ui-designer to "score the DIRECTIONS against the brief and the taste rules, pick ONE". "This run selects automatically" (:537) means unattended, not timed out.
2. ui-designer ran as node n13: seq 232 Agent "Score directions and choose one", allowed at seq 234; it Read manifest.json, the three direction notes, six canvass stills, taste-skill and minimalist-skill (seq 238-268); wrote direction-choice.json at seq 267; completed at seq 269; reported scores at seq 270. It never read creative-contract.json (0 event rows for node n13 mention creative-contract). RUN/results/context.jsonl line 2: taskId a62b38a13029c75e3, agent ui-designer, model claude-opus-5[1m], 94,599 tokens.
3. Its reason (design-lock.json:50; manifest.json directionChoice): "It takes the three heaviest criteria: the largest patient-facing type in the set (18px body, 15px sentence-case labels, nothing under 13px, 56px targets), an error carried by glyph, weight and position as well as colour, and a single-column idea that is width-independent so no part of its signature depends on desktop. The cost is that it is the most templated artifact of the three and it retreats from the 4/3/5 dials rather than earning distance from them, so the build has to supply the character the scaffold does not."
4. The expansion relabelled the variance rather than changing the design: direction.md:12, "the scaffold is a deliberately symmetric centred card, which on its own would sit at 3. It reaches 4 because the character has to come from execution rather than from layout". prompt.txt:107 relayed that to the builder under "Build to these values" (design-prompt.ts:1082).
5. The builder never rendered: build.log:177 and :226 ("the sandbox blocks Chrome's Mach port bootstrap, so no browser starts").
6. Nothing enforces the contracted hero layout (refuter: creative-render.ts:1524-1526 records layoutFamily only as an observation pointer), and the visual gate ran in shadow (section 3).

| Dial | Contract | Chosen direction (canvass) | Expansion label | Alternatives |
|---|---|---|---|---|
| DESIGN_VARIANCE | 4 | 3 | 4 | 5 (ledger), 5 (rail split) |
| MOTION_INTENSITY | 3 | 2 | 3 | 3, 4 |
| VISUAL_DENSITY | 5 | 4 | 5 | 6, 5 |

Sources: creative-contract.json dials; direction-soft-clinic-card.md:57-59; direction.md:12-14; build.log:47-49 and seq 322 for the alternatives.

Correction recorded (section 5): the dashboard's "chosen automatically" badge and "No choice arrived in time" sentence are fixed copy for every ui-designer lock (/Users/kamilborzecki/Projects/coding-agent/dashboard/src/components/run/design-lock.tsx:172-173 and :457; SRC/cron/cron-report.ts:119). This run had a judged pick; the timeout path (SRC/design-lock.ts:251-260, `by: "fallback"`) did not fire; design-lock.json has awaiting false, turnsUsed 0, requests [].

Fix shape:

- Give the chooser the contract and make reading every still mandatory. Require the reason to name, per direction, the generic default for a similar brief and the departure from it; refuse a pick whose departure is empty. The validation site is SRC/design-lock.ts:221-241 (`readDirectionChoiceFile`), applied at SRC/orchestrator.ts:5542-5544.
- Fix the dashboard copy. It misled F4.
- Record owner picks. Across /Users/kamilborzecki/Projects/coding-agent/dashboard/runs there are 15 design-lock.json files: 12 lockedBy ui-designer (10 with chosenDirectionBy ui-designer, 2 older files without that field), 3 fallback, 0 owner (measured).

### C5. No judge of rendered pixels reached the verdict

Not a generator of the defects. The reason C1 to C4 reached the owner as PASSED, 21 of 21, with a verdict that says "Everything the ticket asked for is there, and nothing was noted against it." (RUN/results/verdict.md:3).

Mechanism (measured):

1. The rendered taste critic sits behind the capture renderer. The renderer captured 72 PNGs (RUN/results/creative-render/0/captures, three profiles of 24: desktop, mobile, reduced_motion) and then refused. RUN/results/creative-render/artifact-repair.json: refusalReason "motion m.step was not observed on an active render profile"; three MOTION_NOT_OBSERVED issues (m.step on s.step2, m.error on s.step1, m.confirm on s.confirm, profile desktop); claimed 2026-09-04T18:09:30.336Z. seq 823 logs the refusal. SRC/creative-render.ts:1210-1215 classes any non-CAPTURE_FAILED issue as artifact_contract; SRC/orchestrator.ts:4380-4414 takes the one-repair branch; the builder was resumed with the repair prompt; the sealed gate re-ran GREEN (seq 901); the second capture was refused, "motion m.step remained active under reduced motion" (seq 902; REDUCED_MOTION_ACTIVE at creative-render.ts:1053); orchestrator.ts:4496-4500 returns with stopReason artifact_contract before the critic call at :4523. RUN/results/creative-status.json:15-19: criticDisposition null, criticAttempt null, reviewState creative_review_required, reviewStopReason artifact_contract.
2. The insufficient-evidence critic state from commit 5a7cf77 (2026-09-04 15:41:28 +0200) was live code and unreachable on this path.
3. Visual gate. RUN/results/visual-gate.md:3 "MODE: SHADOW" and "NONE of them can fail this run"; :4 "Observations that can fail this run: none"; three of four observations UNKNOWN not_answered on every frame (:9-20); the fourth, VIS-F-REF-GROUND-INVERTED, clear on 3 frames (:21-22). The UNKNOWNs are structural: SRC/visual-gate-run.ts:391-393 "no grader seat exists on this path yet", and `visualGatePrompt` (SRC/design-prompt.ts:1123) has no non-test caller (grep). seq 817 and 900: "12 observation row(s), 0 of them counting toward the verdict".
4. Adversary. RUN/results/adversary.json: ran true, gating false, wallClockMs 720000; finding 4 "Zero live browser attempts were possible: no browser tool and Bash network sandbox blocks 127.0.0.1:4321"; findings 1 to 3 prefixed PLAUSIBLE. Its attempts exist as tool rows (seq 925 and 927 curl; 939 WebFetch), but the run's seven graph_hook rows (seq 93, 234, 286, 290, 349, 459, 922) are all for Agent or SendMessage, so the blocked outcome rests on the agent's own report. It is the only debugfix pass in the run (seq 912: "the /debugfix --web --max human-factors pass"; SRC/orchestrator.ts:7685), QUALITY tier (seq 1024).
5. Context7 review. RUN/results/context7-review.json outcome: status unsatisfied, capabilityApplicability not_applicable, code scope_unavailable, verdict null, evidence [] (seq 905).
6. The code-reading judge did run (seq 907 to 910; SRC/orchestrator.ts:2906-2908 and :7550-7562), tool-less and non-gating (:2899). It wrote two findings: [unasked_scope/medium], a capture-mode CSS block keyed on the renderer's data-creative-state lever; and [swallowed_failure/low] REQ-003, "The background video layer (itself scope the ticket did not ask for) discards every failure". Neither appears in verdict.md.
7. seq 1029: "WEB pilot publication is suppressed until functional and compiler gates are green, the critic accepts and the owner approves". The run is status passed and publication-suppressed at once; the owner viewed the workspace over the ad hoc server regardless.

Fix shape:

- Convert render refusal issues into critic facts and run the critic on the captures that exist. Its motion family already covers "undeclared motion, purpose mismatch" (SRC/taste-policy.ts:829).
- Route the code-reading judge's findings into verdict.md.
- Give the critic a full-page capture per profile and the source (section 4, WebDevJudge).
- ADVERSARY-ACCESS-001 for loopback (docs/BACKLOG.md:28, uncommitted).

### Findings that are not causes

| Finding | Status | Why it is not a cause | Where recorded |
|---|---|---|---|
| F6, which skill ran | refuted | taste-skill/SKILL.md was Read 11 times by design-lane seats, the builder is the same session, and the cream is a palette taste-skill sanctions | section 4 |
| F7, preview leaks | confirmed, coincidental | /.git/config and /TICKET.md answer 200 on loopback; no effect on what renders | section 5; docs/BACKLOG.md:20 |
| F8, SendMessage denied | confirmed, coincidental | 6 of 6 across 31 runs; the remediation worked in 19 s and the corrected notes carried the motion rule the video lane then ignored | section 5 |

## 3. What did run and what did not

| Seat | Ran | Could fail the run | Live browser | Proof |
|---|---|---|---|---|
| Held-out suite in the sealed Docker gate | yes | yes | yes, Playwright in the container, reducedMotion "reduce" (/Users/kamilborzecki/Projects/coding-agent/bakeoff/src/scorer-container.ts:642) | seq 901 GREEN 34 of 34; runs.status passed |
| Visual gate (visual substance) | yes, shadow | no | host screenshots only; no grader seat | visual-gate.md:3-4, :9-22; seq 817, 900; visual-gate-run.ts:391-393 |
| Creative render capture (feeds the critic) | yes, then refused twice | it stopped the review | yes, Playwright on the host | 72 PNGs under creative-render/0/captures; artifact-repair.json; seq 823, 902 |
| Rendered taste critic | no | no | not reached | creative-status.json:15-19 criticDisposition null, criticAttempt null |
| Code-reading judge | yes | no (non-gating) | none, tool-less | seq 907-910; orchestrator.ts:2899, :7550-7562 |
| Context7 independent review | ran, unsatisfied | no | none | context7-review.json scope_unavailable; seq 905 |
| Human-factors adversary (the only /debugfix pass) | yes, static | no (QUALITY tier) | 0 successful attempts; 3 attempts recorded (seq 925, 927, 939) | adversary.json finding 4; seq 912, 1010, 1015, 1024 |
| ui-designer direction chooser | yes | it gated the design lane | none; read six canvass stills and three notes | seq 232-270; context.jsonl line 2 |
| Builder self-check | attempted | n/a | none: "the sandbox blocks Chrome's Mach port bootstrap" | build.log:177, :226 |
| Fix and repair seat | yes (one artifact repair) | n/a | none: "YOU CANNOT SEE THE PAGE" | SRC/fix-prompt.ts:145-147; build.log:273 |
| Owner | no pick | n/a | n/a | 0 owner locks in 15 design-lock.json files |

Only Agent and SendMessage calls have PreToolUse rows in this run (7 graph_hook rows: seq 93, 234, 286, 290, 349, 459, 922). Bash, WebFetch and Skill outcomes are inferred from the narration that follows them.

## 4. The taste lane as actually wired

### Wiring on this run (measured)

- The design lane is the run's own session (node n1, seq 70, agent orchestrator), resumed for the DESIGN segment at seq 334 and for the BUILD segment at seq 626, both "Default (recommended) (claude-opus-5[1m]) at effort high". The builder is the same Claude session that ran the design lane, so the direction notes and every subagent report were in its context when it wrote styles.css.
- Agents spawned from it: taste-frontend-expert as n3 (seq 91 "Author 3 art directions, 6 stills", completed seq 204), n14 (seq 288 "Correct winning direction notes"), n15 (seq 350 "Expand soft-clinic-card, stills 03-07") and n25 (seq 460 "Expand soft-clinic-card, stills 08-11"); ui-designer as n13 (seq 232, the chooser). build.log:9: "Delegating art direction to `taste-frontend-expert` (the designated author for this stage" and "routed through the taste-skill system". /Users/kamilborzecki/.claude/agents/taste-frontend-expert.md:5 pins `model: claude-opus-5`; context.jsonl line 2 records claude-opus-5[1m] for ui-designer.
- Skill files read: SKILLS/taste-skill/SKILL.md by n3 (seq 101, 103, 105), n13 (260, 266), n15 (363, 365, 367), n25 (477, 479, 481); SKILLS/minimalist-skill/SKILL.md by n3 (107), n13 (262), n15 (361) and n25 (475). Those reads come from the agent's own registry (taste-frontend-expert.md:13 "you MUST Read the relevant SKILL.md"; :19 lists taste-skill as the default), not from any pipeline prompt: SRC/design-prompt.ts:928-935 names taste-skill only in a comment, and the runtime text at :955-960 (RUN/results/prompt.txt:209-214) only overrides its picsum, unsplash, simpleicons and icon-library advice.
- The one Skill tool call in the run: seq 639 `{"skill":"image-to-code-skill"}` on node n1, mirrored at seq 640 (graph_tool) and 641 (graph_skill, source invoked). Skill tool rows in the run: 1. SRC/design-prompt.ts:795 `IMAGE_TO_CODE_SKILL = "image-to-code"`; prompt.txt:90 asks for it. The builder then set aside that skill's own dials (SKILLS/image-to-code-skill/SKILL.md:75 variance 8, :77 density 3) for the contract's 4/3/5, as the prompt instructs (build.log:141).
- What reached the builder: prompt.txt (art direction binding at :99, dials at :107, the slop list from :195, the video block at :217-233), the compiled contract JSON (orchestrator.ts:5103), the direction files in the workspace, and the held-out suite in workspace/visible-acceptance (build.log:217). The palette reached CSS verbatim: styles.css:6-7 `#f5efe1`, `#fdfbf6` equal the direction table at :37-38.
- What did not reach the builder: taste-skill/SKILL.md itself (refuter: no Read of it in the build segment, seq 629-778), a rendered view of the page (build.log:226), any critic output (none ran), and the Anthropic frontend-design skill, which is installed but disabled (/Users/kamilborzecki/.claude/settings.json:298 `"frontend-design@claude-plugins-official": false`).
- The impeccable preflight entry in RUN/results/design-lane.json (id npx-impeccable, ok false, blocking false) concerns a skill nothing invoked; no events row calls impeccable. It says nothing about which skill ran.

### What taste-skill says about this ticket (measured)

- SKILLS/taste-skill/SKILL.md:8: "Landing pages, portfolios, and redesigns. Not dashboards, not data tables, not multi-step product UI." :901: "Multi-step forms / wizards (use Form-specific patterns; this skill won't make them better)." :906: if the brief is one of those, "say so explicitly, point to the right tool". taste-frontend-expert.md:19 repeats the exclusion; :86 routes product UI to redesign-skill, which needs an existing codebase (refuter: redesign-skill/SKILL.md:10-14).
- :60 maps "trust-first / public-sector / regulated / accessibility-critical" to variance 3 to 4, motion 2 to 3, density 4 to 5. The chosen direction is 3/2/4.
- :192-207 bans the warm-cream family as a default only for premium-consumer briefs (:194 lists #f5f1ea, #efeae0 and five others) and offers "Cobalt + Cream: saturated blue against a single neutral" (:202) as an approved rotation. SRC/creative-contract.ts:23 carries cobalt_cream in its palette enum. The delivered #f5efe1 is inside the banned hue family and licensed by the rotation rule. The owner's "cream background" verdict is a verdict on the skill's own palette vocabulary.
- :360 "MOTION MUST BE MOTIVATED" was read by the seats that wrote the direction (which obeyed: intensity 2, no scroll motion) and not by the prompt that ordered the world layer (prompt.txt:217).

Conclusion on the lane: the page is what the taste-skill system produces when its files are read as intended, on a ticket the skill says it cannot help, inside a contract that could only describe a landing page, with a background the host ordered afterwards. The lane did not malfunction. It was applied out of its stated scope and then overridden downstream.

### What the research says

Seventeen candidates were profiled and every profile was refuted in part. What follows is the corrected residue, only where the evidence held. Grouping is relative to the taste-frontend-expert lane. External numbers are the papers' own unless stated; URLs were read on 2026-09-05 by the refuting seats; every local line was re-read by me.

Replaces: none. No candidate produces a design. Each is a judge, a benchmark, a prompt or a renderer. The replacement the evidence does support is a routing change: for app and form tickets, do not route through taste-skill, as the skill asks (SKILL.md:8, :901, :906). Give the contract an app page kind, pick a design-system direction the contract already knows (SRC/creative-contract.ts:17 lists native, govuk, uswds among others), and let the design lane spend on the specific parts of a form: type scale, spacing, states, error treatment. Keep taste-frontend-expert for landing and marketing tickets, after C1 to C4 are fixed.

Augments:

| Candidate | Measurement that held | Limit | Recommendation |
|---|---|---|---|
| Vision-guided iterative refinement, Amazon, arXiv 2604.05839 (ICLR 2026 RSI workshop) | Sonnet 4.5 as generator, critic and improver: overall 7.584 to 8.048 at cycle 3 (+6.1%), aesthetic +5.6%, tokens 6,446 to 131,550; best-of-4 8.402 (+10.8%); its VLM judge agrees with human pairwise preference 69.5% | No code, no replication, the same model judges itself; desktop single screenshot | The loop already exists locally (SRC/rendered-taste-critic.ts:46 MAX_CREATIVE_REVIEW_ATTEMPTS = 3; revise path per refuter at orchestrator.ts:4303-4308) and never ran. Unblock its entry (C5) first; expect the cycle-3 number, not best-of-4 |
| WebDevJudge, arXiv 2510.18560 v3 (ICLR 2026 oral) | Human pairwise agreement with rubric labels 84.56%; best vanilla judge GPT-4.1 70.34% pairwise; Claude-4-Sonnet pairwise: both 70.18, code-only 67.58, screenshot-only 59.48; single-answer: code-only 61.77, image-only 55.66, both 59.17; agentic single-answer 60.55 vs vanilla single-answer 60.86; Claude-4-Sonnet positional consistency 89.6 and 87.9 | Labels by two of the authors; Next.js arena apps; function ranked over aesthetics; no confidence intervals | Our critic is forbidden source (SRC/taste-policy.ts:209 "Never source code, HTML, CSS or image bytes"; :850) and is single-answer. Hand it index.html and styles.css; if it compares, swap order and keep a disagreement path |
| ArtifactsBench, arXiv 2507.04952 | 94.4% ranking consistency with WebDev Arena and 90.95% pairwise agreement with engineers (Gemini-2.5-Pro judge; 71.34% with Qwen2.5-VL-72B), self-reported | Released capture is goto, networkidle, three full-page screenshots one second apart, no interaction, Playwright default 1280x720; a wizard is judged on step 1 | Take one idea: capture unconditionally and judge whatever rendered. Its checklists are per task and would pass F2 |
| WebGen-Agent, arXiv 2509.22644 (ICLR 2026 poster) | Ablation on DeepSeek-V3: execution-only 45.9 / 3.0; plus screenshot 46.6 / 3.6; plus GUI agent 49.9 / 3.4; plus backtrack 51.2 / 3.7; plus select-best 52.6 / 3.8 | The 26.4 to 51.9 headline compares against a Bolt.diy row copied from the earlier paper; one 1024x768 Selenium shot after 3 s; rubric never sees the instruction; error detection is the substring "error"; backtrack also fires on screenshot grade 2 or below; 24 stars, no licence | Take the wiring (critic text into the fix seat, per-attempt snapshots, select-best), not the rubric. Per-attempt workspace snapshots do not exist today (refuter: no snapshot call in gate-fix-loop.ts) |
| WebGen-V Bench, arXiv 2510.15306 (code at github.com/sony/web_gen_v_bench per refuter, MIT) | Structured section-wise refine vs zero-shot, win/loss/tie: SPC 55/39/8, ALN 53/39/8; non-structured SPC 45/49/8; Claude-Opus-4.1 low-scoring sections per page ALN 3.82 to 3.80; degradation-detection F1 0.46 to 0.78 | No n for the headline figures; GPT-5 judges its own feedback; video elements excluded; text-accuracy metric rewards spec-as-copy | Our render already writes 72 section captures. Add computed colour, font and size per section to the snapshot (refuter: creative-render.ts:247-277) and decouple critic entry; do not adopt the scores as the disposition (taste-policy.ts:844 forbids scores) |
| MLLM as a UI Judge, Adobe, arXiv 2510.08783 v1 | Claude 3.5 pairwise agreement with 500 MTurk raters: overall 59.98%; Interesting 78.49; Aesthetic 68.53; Ease of Use 47.01; Comfort 47.81 | n=30 static email layouts; Claude 3.5 only; authors advise against end-of-process validation | Do not import per-factor numbers (the chooser ran claude-opus-5[1m]); calibrate the chooser against the owner's own picks |
| Efficient Personalization of Generative UIs, CMU/Purdue, arXiv 2604.09876; DesignPref, arXiv 2511.20513 | Designers agree at kappa 0.248 (binary); personalised retrieval model 0.610 to 0.620 after 8 picks; arena win rate: adaptive preference model 60.35%, profile-conditioned LMM judge 50.9%, zero-shot 41.25%; DesignPref personalised RAG into GPT-5 57.70 to 58.89 binary | No data, code or models released; GPT-5.2 zero-shot 0.591 declines with onboarding pairs; pretrained UIClip alone scores 0.565 | 0 owner picks exist in 15 locks. Record pairwise owner picks at the design park; nothing can be personalised until that store exists |
| Anthropic frontend-design skill, anthropics/skills PR #1713 (2026-09-03) | No outcome evidence in the PR. The only numbers anywhere are Wetch's A/B of a fork that never merged: n=10 per model, Haiku 8 of 10, Sonnet 7 of 10, Opus 6 of 10 (p=0.377 for Opus alone) | Self-review inside the author; its screenshot loop is conditional and false in the sealed builder; disabled locally (settings.json:298) | Import its pass-2 sentence ("if any part of it reads like the generic default ... revise") into the chooser's required reason and into creative-contract-author.ts:525, not as another builder skill |
| impeccable, pbakaus (local copy SKILLS/impeccable, SKILL.md:4 version 4.0.2) | 65.7k stars; README claims 61 rules, the shipped registry has 59 `id:` entries (measured); Operate mode makes "No orchestrated page-load sequences" (reference/operate.md:43) and "Decorative motion that doesn't convey state" (:47) constraints; reference/new-work.md:63 names "warm cream ground" as the AI cluster; 4 of 10 local antislop rules already come from its craft-floor (SRC/builders/antislop-rules.ts:16-22) | No outcome evidence (one case study, no metric); new-work.md:59 makes neutrals plus one accent the Operate default, so it would not refuse cream here; the per-edit hook installs into project settings the sealed builder does not load (SRC/builders/claude-builder.ts:925 settingSources ["user"]) | Adopt the mode classifier in the contract author (an Operate surface has no hero to freeze). Run `node detect.mjs --json <workspace>` host-side after the build, with a known-clean page as the negative control before trusting a zero |
| Calò, Gurita, De Russis, CHI EA '26 (DOI 10.1145/3772363.3799364) | Source-reading judge; recall on 721 single-fault variants: Claude 83.7%, Gemini 91.7%, GPT 79.9%; heading mismatch 68%; human-human kappa about 0.24 | No code or prompts published; isolated HTML only; would not fire on the specimens (they carry only aria-hidden, index.html:186 and :200) except as heading mismatch | Take the calibration discipline (single-fault variants plus clean controls) for any new judge seat. SRC/calibration/fixtures.ts already runs seeded-defect fixtures for the grader and can be extended |
| design-slop-cop, adriankrebs.ch (2026-04-20) | n=1,590 Show HN sites binned 22/32/46% by a scorer no longer in the repo; 14 patterns today; run.js scrolls in 900 px steps then evaluates at scroll 0; no pattern reads a video | Desktop 1440x900 only; vocabulary is purple, dark, glass, stat rows; inferred score for this page 0 of 14 | Low value here. Its patterns cannot see cream, a video world, spec-as-copy or inert specimens |

Orthogonal:

| Candidate | Measurement that held | Why it changes no seat |
|---|---|---|
| GEBench, StepFun, arXiv 2602.09007 | Nano Banana Pro GE-Score 69.62 (zh) and 61.20 (en); 700 samples; VLM panel judge | Scores image models as GUI simulators; emits no design; does not cover gemini-3.1-flash-image-preview (RUN/results/design-lane.json imageModel; released 2026-02-26). The run's stills show none of its named bottlenecks |
| Renderer outside the seal (Playwright run-server in Docker; chrome-devtools-mcp --browser-url) | Both routes are vendor-documented; both need an outbound loopback connect from the sealed seat, and the one recorded measurement failed (docs/DESIGN-capability-and-continuation-2026-08-19.md:63, MCP-2); Playwright major.minor lock-step (repo 1.62.0 at dashboard/package-lock.json:5807-5808; vendor image v1.63.0); allowedMcpServers [] policy (SRC/builders/claude-builder.ts:1007-1008) | Would have changed the builder's self-check only. On this run the critic path had a browser and refused on contract grounds. Before any build: measure loopback CONNECT with a negative control (a live port and a dead port); consider sandbox.network.allowMachLookup |
| taste-skill itself | Already the incumbent; out of scope for this ticket by its own text | See above |
| Local candidates (contract author vocabulary; builder specimens) | Folded into C1 and C3 after correction | See section 2 |

Plain recommendation:

1. The lane is not the first problem. Four pipeline mechanisms (C1 to C4) produced the page. No research candidate fixes any of them, and every judge candidate tops out near 60 to 70% agreement with humans.
2. Route app and form tickets away from taste-skill, as the skill itself asks. Give the contract an app page kind. Stop turning requirements into copy.
3. Fix the video lane so a mark for a css fade cannot become a scroll world, and make the motion floor read the contract.
4. Unblock the rendered critic, give it source and a full-page capture, and route the code-reading judge's findings into the verdict. Measure the effect on the next run before adding loops.
5. Start collecting owner picks. The dashboard label fix and a pairwise park are the same change.

## 5. Rejected and corrected

Sub-claims the refuters overturned, with the corrected statement, so nobody re-derives them.

| Original sub-claim | Verdict | Corrected statement | Evidence |
|---|---|---|---|
| F1: "The video lane is mandated by design-prompt.ts:452-490 on any video-capable canvass regardless of ticket" | wrong | :470-477 forbids marks on a canvass; :480-486 makes legs opt-in ("mark none where the motion does not earn it"). The unconditional part is consumption: video-lane.ts:165-185 and orchestrator.ts:5087-5101 append the world-layer order for any produced leg | measured |
| F1: line references :530 and :55-80 | off by a little | creative-contract-author.ts:531; styles.css:56-85 | measured |
| F1: leg 1 currentTime 1.59 at scrollY 0 | not load-bearing | On a fresh load paint() seeks to 0 at y=0 (measured 0 at scrollY 0); the 1.59 came from a non-zero start | measured |
| F2: the author's fact vocabulary includes constraint and accessibility "with no rule excluding them from copy" | true but not the operative gap | Brief chunks arrive tagged goal (creative-pilot.ts:522-531); constraint is only for plan answers. A kind allow-list would have blocked p.markers alone (1 of 6). p.markers is not a ticket requirement but the harness's own fact (creative-pilot.ts:543-550) | measured |
| F4: the direction was "chosen automatically" because "No choice arrived in time" | wrong | Those strings are dashboard copy printed for every ui-designer lock (dashboard/src/components/run/design-lock.tsx:172-173, :457; cron-report.ts:119). A judged pick happened (seq 232-270, 94,599 tokens); the fallback path (design-lock.ts:251-260) did not fire; design-lock.json awaiting false, turnsUsed 0 | measured |
| F4: the asymmetric/symmetric mismatch is because "the contract froze before any design existed" | true in order, misleading as cause | The design lane was given the frozen contract (orchestrator.ts:5103); seq 322 calls all three directions "readings of the same frozen contract". The author offered a contradicting direction knowingly and the chooser never read the contract (0 rows) | measured |
| F5: "NO QUALITY JUDGE RAN" | overstated | The code-reading judge ran (seq 907-910), non-gating, and flagged the video as unasked scope. What did not run is any judge of rendered pixels | measured |
| F5: "every observation UNKNOWN not_answered" | wrong for one of four | VIS-F-REF-GROUND-INVERTED is clear on 3 frames (visual-gate.md:21-22). The other three are UNKNOWN on every run: no grader is ever invoked (visual-gate-run.ts:391-393; visualGatePrompt has no non-test caller) | measured |
| F5: "0 live HTTP attempts" | the adversary's own wording | Three attempts are recorded (seq 925, 927, 939); no hook rows exist for them; the blocked outcome is the agent's report. Zero successful attempts | measured |
| F6: "Skill tool invoked twice" | wrong | One Skill call (seq 639); seq 640 and 641 are its graph_tool and graph_skill mirrors | measured |
| F6: "no evidence taste-skill's rules reached the builder" | wrong as stated | taste-skill/SKILL.md was Read 11 times by n3, n13, n15, n25; the builder is the same session (seq 334, 626); the direction's palette is in styles.css verbatim. Only the builder segment's own Read of the file is absent | measured |
| F6: "the taste agent in practice is taste-frontend-expert plus image-to-code-skill" | conflates two seats | image-to-code-skill was invoked by node n1 (the orchestrator and builder session); taste-frontend-expert read taste-skill, imagegen and minimalist skills | measured |
| F7: the live 200s were measured against the pipeline's preview | wrong server | 4321 today is python http.server (PID 9413, started 2026-09-05 09:32:31). The resolver test holds for the pipeline server too: `resolveStaticFile(workspace, '/.git/config')` and `'/TICKET.md'` return real paths, `'/tests/'` and `'/nope'` return null (dashboard/server/node_modules/bakeoff/dist/tier0.js:1068). Directory listings are Python-only | measured |
| F7: "predicted by static trace" | understated | The adversary attempted curl and WebFetch and was blocked by its sandbox (seq 925, 927, 939) | measured |
| F7: PREVIEW-EXPOSURE-001 "still open" | open only in the working tree | `git show HEAD:docs/BACKLOG.md` has 0 hits for PREVIEW-EXPOSURE and 0 for ADVERSARY-ACCESS; both rows are in the uncommitted diff of docs/BACKLOG.md | measured |
| F7: "leaks" | needs scoping | Both servers bind 127.0.0.1; .git/config carries the dashboard's scaffolding identity and no remote or credential | measured (curl body 191 bytes) |
| F8: "by delegation-hook.ts:225" | one line off, wrong site for the decision | The file is SRC/builders/delegation-hook.ts. :224-227 is the reason string; the name predicate is :190 (set at :198); the deny is emitted at :400-411 | measured |
| F8: the denial text | inaccurate on this run | Target n3 completed at seq 204 (16:52:19Z), 8m11s before the attempt (17:00:30Z), yet the model was told it "resumes an agent that is already running" | measured; also docs/RUN-b1219c2d-breakdown-2026-08-18.md:155 |

Research profiles, corrections that matter to any reuse:

| Profile | Corrected point |
|---|---|
| ArtifactsBench | Capture viewport is Playwright's default 1280x720 (src/utils.py sets none), not the paper's 1024x768; the aesthetics rules are an example checklist (Appendix A.8), not the judge prompt; score extraction lives in src/extract_ans.py |
| WebDevJudge | The agentic judge's 60.55 is against vanilla single-answer 60.86, not pairwise 70.34; labels come from two of the authors; dataset split 269/276/109 in v3; Claude-4-Sonnet's positional consistency is about one flip in ten, GPT-4.1's one in six |
| WebGen-Agent | webvoyager_grade is assigned by a separate fb_model on a text-only trajectory, not by the coding session; backtracking also fires on screenshot grade 2 or below and on crashes; 72 local captures, not 69; CriticDisposition has four values (rendered-taste-critic.ts:63) |
| Vision-guided refinement | Reachability needs creative-render.ts to return a partial manifest on MOTION_NOT_OBSERVED; the loop cannot fix F1, F2 or F4 |
| MLLM as a UI Judge | Claude MAE for Interesting is 0.62, not 0.68; the direction chooser is readDirectionChoiceFile (design-lock.ts:221-241), not readChoiceFile (:344-360); design-lock.ts:240 writes by "ui-designer" for any valid file, so provenance is asserted, not observed |
| DesignPref | "UIClip fine-tuning is out" is false: the labels are unreleased, the UIClip weights are public (huggingface.co/biglab); pretrained UIClip alone scores 55.07% binary and could rank the 39 existing hero stills today |
| Efficient Personalization | "GPT-5.2-chat 8-shot 0.591" is the zero-shot figure and it declines with onboarding pairs; prompts are Screen2Words descriptions; held-out evaluation is leave-one-designer-out |
| impeccable | Var resolution is css-cascade.mjs:1081-1094; the version check is cached, not per session; cream-palette would fire by arithmetic only (not executed) |
| design-slop-cop | run.js does scroll (900 px steps, max 12) before evaluating; only the pattern files lack scroll or video logic; no "none" tier exists in code |
| Calò et al. | The specimens carry aria-hidden; the paper's judge could fire on heading mismatch; the adversary seat (SRC/adversary.ts:12-13 "IT NEEDS A RUNNING URL") is the wrong carrier for a source-reading judge |
| Renderer outside the seal | Cite orchestrator.test.ts:3601 for the no-network assertion; the second refusal text "remained active under reduced motion" is in runs.db (seq 902), not under results/ |
| frontend-design skill | Wetch's A/B is n=10 per model with wins only, no loss counts; the F1 attribution to design-prompt.ts:478-501 is wrong for the same reason as F1 above |
| taste-skill profile | The world layer was ordered by the host (prompt.txt:217-231), not written by the seat that read the skill; the skill was Read at the timestamps above, so "inferred" becomes measured; README lists one showcase (Floria), not two |

## 6. Still unmeasured

- Loopback CONNECT from a sealed seat, with a negative control (one live port, one dead port), under the exact buildOptions. Every "give the seat a browser" route depends on it; the only recorded measurement (DESIGN doc :63) is a failure without a control.
- Whether the pipeline's bakeoff preview returns 404 for a directory: the resolver returns null for `/tests/`, but the request handler's response to null was not executed here.
- Whether the held-out suite would have failed real controls in the a11y section (the refuter's DOM-order reading of build.log:220-221); not executed.
- The rendered taste critic on any run where the render is not refused. CRITIC-001 in docs/BACKLOG.md:26 is still "unproven".
- A Claude seat's detection rate on injected defects (the calibration any new judge needs; SRC/calibration/fixtures.ts covers the grader only).
- Owner preference data: 0 picks in 15 design locks. Nothing personalised can be evaluated.
- Recurrence of the s.a11y shape (real_component, interaction, actions []) across contracts: the refuter reports 7 of 7 creative-contract.json files by loose regex. Re-counted 2026-09-05: a section that requires interaction and declares no actions appears in 6 of 7 (one section in each of five others, kind feature or proof, visualKind type_only or generated_image; d728ab79 has none); the full shape with visualKind real_component appears only in this run's contract, on s.nav, s.a11y and s.responsive.
- What the chooser weighted: its Read rows show six PNGs and three notes (seq 240-258); the reason cites 18px/15px/56px from the notes; whether the stills moved the decision is not recorded.
- ffprobe of the two legs (refuter: h264 1280x720, 4.000 s, aac track); not repeated.
- The step-3 review row text: my selector returned nothing; the refuter's run reported the three rows; not re-measured.
- Whether frontend-design was ever invoked on the 18 earlier runs where it was registered.
- Whether `type: "sdk"` MCP servers bypass `allowedMcpServers: []` (relayed from the DESIGN doc :215, whose pointer to claude-builder.ts:1004 is stale).
- Which harness commit the run executed: run.json says "unversioned"; the dist mtime is the only provenance.
- A control run: the same ticket through a form or design-system direction with no video lane and an app page kind, so that "no taste" can be compared against something.

Carried forward, not findings:

- Owner ask (2026-09-05): rename dashboard nodes from agent names to task roles (frontend, backend, debug, design, review). Not started. The design-lock.tsx copy defect (C4) sits in the same component tree.
- PREVIEW-EXPOSURE-001 (docs/BACKLOG.md:20) and ADVERSARY-ACCESS-001 (:28) exist only in the uncommitted working tree.
- RUN/results/backlog.md:11 assigns the preview fix to "refactoring-specialist" as a no-behaviour-change lint; it is a behaviour change in tier0.js `resolveStaticFile` or SRC/preview.ts, and tier0.js lives in node_modules/bakeoff.
