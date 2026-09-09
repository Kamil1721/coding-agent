# Codex brief: wave 2, taste and copy (T15 to T26)

## Mission

Wave 1 gave the pipeline measurement. Wave 2 closes the four mechanisms that produced the
clinic page the owner rejected on 2026-09-05, and unblocks the one judge that could have
caught them. The run is `run-2026-09-04T15-54-06-323Z-131fd85f`; it passed 21 of 21 gated
criteria and the owner called the result generic, purposeless and partly broken. The wizard
itself works. Everything around it came from the pipeline.

The four mechanisms, each verified against the run artefacts by an independent refuter:

- The creative contract turned the ticket into a landing page and its delivery requirements
  into marketing copy, because it has no page kind for an app and no rule that a requirement
  is not copy.
- The host mounted two Veo clips of the design mockups as a scroll-scrubbed background,
  against a direction that said no scroll motion, because the video lane reads nothing from
  the contract.
- Four accessibility "specimens" shipped as controls that are pictures: a div styled as a
  button, a fake error box, a fake field, fake progress bars.
- The chooser picked the most templated direction on purpose, on accessibility grounds, and
  deferred "character" to a builder it knew could not see the page.

And the blind spot: four rendered-quality judges exist in code and none has ever produced a
gating verdict. The `no_evidence` critic state you shipped in `5a7cf77` was never reached
because the critic never ran.

## Read first, in this order

| File | Read |
|---|---|
| `docs/PLAN-wave2-taste-and-copy-2026-09-05.md` | **All of it.** T15 to T26, G3, the dependency table, and the twelve owner decisions in section 5 |
| `docs/FINDINGS-2026-09-05-clinic-run-131fd85f.md` | Sections 2 (ranked causes C1 to C5) and 4 (the taste lane as actually wired). Skip the research tables unless a task cites one |
| `docs/CODEX-BRIEF-wave1.md` | The ground rules and the run-and-test stages. They apply unchanged |
| `docs/FINDINGS-2026-09-02-pipeline-vs-chat.md` | Only if you need the earlier run's context; the mechanisms overlap |

Both 2026-09-05 documents were fact-checked against the repository at `759d1be` on
2026-09-05. Line numbers are hints; the file and the symbol are the anchor.

## Decisions already taken

Section 5 of the plan lists twelve decisions that belong to the owner. He has taken all
twelve at their stated defaults. Do not re-open them and do not ask about them; implement the
default. In particular:

- D1: `debug` gets its own hue, inside the constraints `roles.ts` documents.
- D4: the code-reading judge never gates; render only.
- D5: requirement-kind proofs may be used as `alt` only.
- D6: `taste-frontend-expert` takes an `app` canvass, on the form brief, with the skill's own
  out-of-scope sentence in the prompt.
- D7: `DECORATIVE_CONTROL` is `warning`, critic fact only, until it has fired on three runs.
- D8: the critic is not handed `index.html` and `styles.css` in this wave.
- D9: a refused chooser pick falls back, honestly recorded; no re-canvass.
- D10: the hero layout family is amended after the choice, not re-sequenced.
- D11: **the control run G3 is never started by you, under any circumstance.**
- D12: `taste-frontend-expert` stays the author for landing and marketing tickets.
- D13 (taken 2026-09-08, for T21): **preserve the historical clinic contract unchanged and add a
  derived fixture whose evidence references are rebound to sentence-level locators.** The
  derived fixture is the oracle for the exact-six requirement errors; the historical fixture
  asserts, as its own named test, that a frozen pre-T21 contract still compiles, because
  continuations and gate-only recoveries re-read frozen contracts and must not start failing.
  Do not amend the expectation to reject `p.reset`; a product sentence in a mixed paragraph is
  exactly the case T21 exists to get right, and encoding its rejection as expected teaches the
  wrong rule. The derivation must be reproducible from `TICKET.md` by the sentence splitter T21
  adds, not hand-written; a test pins that the derived fixture equals the splitter's output.
- D15 (taken 2026-09-09, for T23): **approve the narrow exclusion, defined exactly.** Shape A
  does not fire on an element that is (a) `aria-hidden="true"`, (b) glyph-only, meaning its
  trimmed text is exactly one character in a Unicode symbol or punctuation category, and (c) has
  no element children, or exactly one child that is itself glyph-only with the same text. All
  three together; any one alone is not an exclusion. This spares the clinic's `.done-mark`
  (`<p aria-hidden="true">✓</p>`) and nothing else on that page: the "Continue" specimen has word
  text and is not hidden, the error and field specimens carry sentences, and the progress
  specimen's `.bars` is hidden but has three `<i>` children and no text, so it is not glyph-only.
  Required negative controls, each red under the named mutation: (1) `.done-mark` stays green,
  red when the exclusion is removed; (2) an `aria-hidden` control-styled element whose text is a
  word ("Continue") is still flagged, red when the exclusion widens to any hidden element; (3) an
  `aria-hidden` control-sized box with bar children and no text is still flagged, red when the
  glyph-only clause is dropped. Plus one pinned known gap, named as such: an `aria-hidden`
  glyph-only ACTION glyph ("→" in a 48 px round cobalt box, no role, no handler) is NOT flagged
  under this rule; assert the current behaviour so a later refinement flips the test on purpose
  rather than silently. D7 stands: the finding is `warning`, critic fact only.
- D14 (taken 2026-09-08, for T23): the clinic `app/main.mjs` imports `./wizard.mjs`; the plan's
  fixture copy list omits it. Copy the dependency into the isolated fixture. Never alter the
  historical run directory.

## Ground rules, non-negotiable

The five rules in `docs/CODEX-BRIEF-wave1.md` still hold: negative control on every check,
verify never relay, no self-promotion on same-run evidence, no fine-tuning, one change per
commit with no dash punctuation and no AI attribution. Two additions for this wave, from the
plan's section 0:

1. **Prompt changes are allowed, and every one ships with a golden hash.** Capture the
   unchanged branch's prompt bytes in a separate first commit, so "byte-identical when the new
   condition is off" is a test that can fail. A prompt change without that commit is not done.
2. **No metered call in any test.** Gemini image and Veo video calls cost money. Tests hand the
   orchestrator a temporary `DASHBOARD_HOME`; the only `gemini-video.sh` findable there is a
   stub that spends nothing (`orchestrator.test.ts:1134-1160`, :1433-1440). Follow that shape.

Do not touch the frozen acceptance suites under `dashboard/acceptance/`, their hashes, or the
sealed scorer. This wave does not go near the held-out boundary.

## The tasks, in two batches

Take them in order within a batch. Each is one session. Full acceptance criteria, files and
negative controls are in the plan under the matching heading; this is orientation.

**Batch 2A, visible and safe. Stop after T20 and report.**

- **T15** Canvas cards titled by task role (`orchestration`, `spec`, `design`, `frontend`,
  `backend`, `build`, `review`, `debug`), agent name demoted to the secondary line. The
  derivation exists: `roleOf(agent, lane)` in `roles.ts` already colours the card.
- **T16** The design-lock panel reads the record instead of asserting a timeout. A
  `ui-designer` lock shows as a judged pick with its recorded reason.
- **T17** The code-reading judge's findings are persisted and rendered into `verdict.md`.
  Render only, never gating (D4).
- **T18** PREVIEW-EXPOSURE-001. The static server returns null for any dot-prefixed path
  segment and for harness-internal files. `GET /.git/config` and `GET /TICKET.md` on the
  clinic preview both return 200 today; they must return 404 after, and a real product file
  must still return 200.
- **T19** The video lane reads the contract. A marked ref becomes a Veo leg only when
  `motionIntensity` and the page kind permit scroll motion. Negative control: a landing-page
  ticket at high intensity still gets its legs.
- **T20** The motion floor reads the contract too, so a css fade cannot be forced into a
  scroll world by the builder's stop-hook. Depends on T19.

**Batch 2B, contract and judge.** Batch 2A and its corrective pass (T17b, T16b, T18b) are reviewed and accepted at `4bb9a31`; see `docs/REVIEW-wave2-batch2a-2026-09-08.md` and `docs/REVIEW-wave2-corrective-2026-09-08.md`. Start here.

- **T21** Brief sentences are classified at sentence level; a fact of kind `constraint`,
  `accessibility` or `technical_constraint` can be licensed as `alt` at most (D5) and can never
  become a section. Negative control: the clinic ticket's accessibility paragraph must fail to
  reach a headline; a product sentence must still reach one.
- **T22** An `app` page kind. An app route is bounded to at most one feature or editorial
  section, and app tickets carry the taste skill's own out-of-scope sentence into the canvass
  prompt (D6). Depends on T21.
- **T23** A decorative-control probe in the creative render: an element styled as a control
  with no role, no tabindex and no handler is a `DECORATIVE_CONTROL` finding at `warning`
  (D7). It must fire on the clinic run's four specimens and stay silent on the real wizard.
- **T24** The critic runs on the captures that exist, so it can reach a disposition,
  including the `no_evidence` state from `5a7cf77`. Note that `creative-pilot.ts:1008-1016`
  also publishes on `revise` with a reasoned waiver, not only on `accept`; the plan records
  this.
- **T25** The chooser must have the contract in hand, must have read every still, and must
  name the departure it is choosing. A refused pick falls back and is recorded as such (D9).
  Depends on T16.
- **T26** After the direction is chosen, one bounded author turn may amend the contract's hero
  layout family (D10). Depends on T25.

## Carried from the corrective review, do these inside Batch 2B

The corrective review (`docs/REVIEW-wave2-corrective-2026-09-08.md`, section 3) found five
items. None blocks 2B. The first is required and comes first; the rest land when you touch
the file they name.

1. **Required, first.** `code-files.ts:760-762`: the preview refusal code reveals whether a
   harness-internal file exists, because `path_internal` fires only after `resolveWorkspacePath`
   has found the target, while a missing internal name answers `not_found`. When
   `resolveWorkspacePath` returns `not_found` and `isInternalStaticPath(relPath)` is true,
   answer `path_internal`. Add a matrix case for a missing internal name; it must go red on the
   current code.
2. `orchestrator.ts:7569-7571`: on the no-attempt path after a requeue, remove
   `results/judge.json` when `#judgeReports` has no entry, so a crash between the memory delete
   and the disk delete cannot leave a clean-looking file beside a verdict that says no judge ran.
3. `gate-recovery.test.ts:216`: the cleanup-failure test discriminates by an escaped
   `ERR_FS_EISDIR`, not by its named assertion. Wrap `controller.recover(...)` in
   `assert.doesNotReject`.
4. `design-lock.browser.spec.ts:385-386`: the absence assertion runs before the borrow assertion,
   so a borrow regression reports through the wrong message. Swap them.
5. `api-types.ts:534` (server) and `:421` (client): `chosenDirectionReason` is declared optional
   while `http.ts:742-743` always emits it. Tighten to required.

## Running and testing

The three stages in the wave 1 brief apply unchanged. Two notes specific to this wave.

**The clinic run is your fixture.** Its workspace, contract, design lock, events and captures
are all on disk under `dashboard/runs/run-2026-09-04T15-54-06-323Z-131fd85f/` and in
`dashboard/data/runs.db`. T18, T19, T21 and T23 can all be proven against it without starting
anything. Never write to that directory or to the database.

**When you read the events table**, filter counts with
`json_extract(payload,'$.type')='tool'`; every tool call has a `graph_tool` twin that doubles a
naive count. A tool row is an attempt; the adjacent `graph_hook` row is the outcome. Skill
calls have no hook row at all.

The preview for that run is served at `http://127.0.0.1:4321` while the API is up. That is how
you prove T18 live: the two 200s above become 404s, and `/app/main.mjs` stays 200.

## What to report back

After T20, and again after T26: for each task, what you changed, the negative control you ran
and what it did when mutated, the commands with their real output, the commit hashes, and
anything the plan got wrong. If a document contradicts the code, the code wins and the
contradiction is a finding.

If you disagree with a task's design, say so before implementing it. If a task turns out to
need a decision that is not among D1 to D12, stop and name it rather than choosing.
