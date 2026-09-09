---
document_status: brief
written: 2026-09-09
verified_at_commit: 602121a
source: docs/FINDINGS-2026-09-09-higgsfield-scaffold-comparison.md
consumed_by: Codex, one task per session
---

# Codex brief: the built page is compared to its contract (T27, T28)

## Why this brief exists

Read [FINDINGS-2026-09-09-higgsfield-scaffold-comparison.md](FINDINGS-2026-09-09-higgsfield-scaffold-comparison.md)
in full first. This brief is orientation; the findings document is the specification.

The short version: `creative-contract.ts:1150-1170` already implements the craft floor an
external scaffold uses to keep its pages from reading templated, down to the identical
`Math.ceil(n / 3)` eyebrow formula. Every one of those predicates validates the contract JSON.
On `run-cont-e22fa17f9b7972c79641` the contract declared **one** eyebrow and the delivered
`index.html` rendered **three**, along with five further divergences, including a contracted
section that is simply absent. None was observed.

## Corrections to the first draft of this brief, from Codex's measurement pass at 602121a

Three prerequisites in the first draft were false. They are corrected below and recorded here
so the wrong versions are not re-derived. Codex was right to stop rather than build on them.

1. **"No non-test file reads the built page for structure" is false.**
   `creative-recovery.ts:386` `hasLegacyDeterministicMarkerConflict` already reads
   `workspace/index.html`, extracts `data-creative-route` / `data-creative-section` /
   `data-motion-id` bindings from the contract, and reports whether any is absent from the
   workspace text (`:410-417`). It is a recovery-admission boolean, not a conformance report,
   and it is reachable only when `reviewStopReason === "critic_unavailable"` — but it is prior
   art for the extraction T27 needs, and T27 should generalise it rather than write a second
   one.
2. **The eyebrow ration is not violated; the contract-vs-DOM count is.** The delivered
   `index.html` carries **eight** `data-creative-section` markers (`s.hero`, `s.nav`,
   `s.services`, `s.work`, `s.process`, `s.standard`, `s.contact`, `s.footer`), and the
   contract's route is eight sections. Applying our own `routeSections.length` consistently
   gives `ceil(8 / 3) = 3`, so three rendered eyebrows **pass** the ration. The first draft's
   "observed 3, allowed 2" came from counting six rendered `<section class="sec">` elements on
   one side and the full route on the other, which is an inconsistent basis. The real and
   undeniable divergence is **contract 1 versus DOM 3**. Assert that; do not assert the ration.
3. **`domFindings` is the wrong seam and is not ours to extend.** It is produced inside the
   sealed scorer at `bakeoff/src/scorer-container.ts:727`, validated against a closed
   `DomFindingKind` union (`bakeoff/src/scorer-protocol.ts:1509-1517`) by an allowlist parser
   at `:2015`; the orchestrator only reads the archived result via
   `orchestrator.ts:7389` `#readContainerResult`. Adding kinds to `gate-report.ts`'s
   `VISUAL_DOM_KINDS` would not establish the path, and producing them properly would mean
   putting the creative contract inside the seal. **Do not do that.** Also note `visual` there
   is a routing class, not a tier: scorer DOM findings become QUALITY criteria and cannot
   directly fail `heldOutPass`, though their gate-report entries do keep the repair loop from
   going green and can trigger repairs.

The task number is **T27**. The plan defines T15 to T26, so T27 and T28 are free; T23 is the
decorative-control probe and is untouched here.

**You are not writing new rules. Do not port a ban list.** T27 is an input adapter that lets
the predicates we already own read a second artifact. T28 removes the seam that generated
these particular divergences.

Do T27 before T28. T27 is T28's negative control: land the fix first and the divergence stops
happening for reasons nothing can demonstrate.

## Standing rules

Wave 2's, unchanged, from [PLAN-wave2-taste-and-copy-2026-09-05.md](PLAN-wave2-taste-and-copy-2026-09-05.md)
§0. In particular: every check names the input that must go red; line numbers below were read
at `602121a` and will drift, so the file and the symbol are the anchor; one change per commit;
bare `type: summary`, 60 characters, no dash punctuation, no AI attribution. Nothing here
touches the held-out suite, its hash or the sealed scorer.

---

## T27 — The built page is checked against the contract it was compiled from

**Goal.** After a build produces a workspace and before the run can finish clean, extract the
page's realised structure from the built HTML and compare it to the frozen contract. Emit each
mismatch as a mechanical `domFindings` entry through the seam that already exists. No new
thresholds, no judgement, no renderer.

**Why here.** It is the cheapest change with the largest measured surface: six catches on one
page, all of them string or count comparisons against an already-hashed artifact. It needs no
browser, so it is unaffected by the sandbox and by `critic_unavailable`. And it converts the
project's signature defect — a probe that can only observe the artifact that was already
correct — into a probe with a second input.

**Touches.**
- `dashboard/server/src/creative-render.ts:41` — `CREATIVE_SECTION_ATTRIBUTE`, the marker the
  extractor keys on. Read-only; do not change it.
- `dashboard/server/src/creative-recovery.ts:386-417` — `hasLegacyDeterministicMarkerConflict`.
  The extraction already exists here. Lift the binding walk into the new module and have this
  function call it, so there is one marker reader and its behaviour is pinned by this task's
  tests. Its existing callers must keep their current results; that is criterion 5.
- `dashboard/server/src/render-manifest.ts:16-22` — `RENDER_ISSUE_CODES` and
  `RENDER_ISSUE_SEVERITIES`. This is the **vocabulary precedent**: a `code` plus
  `"blocking" | "warning"`, with `SECTION_NOT_FOUND` already in the list and
  `creative-render.ts:1630` `isFatalIssue` refusing on `blocking`. Follow this shape.
- new `dashboard/server/src/contract-conformance.ts` — the extractor and the comparison. Pure:
  `(html: string, contract: CreativeContractV1) => readonly ConformanceIssue[]`. No filesystem,
  no network, no Playwright, no headless browser. It is a static text comparison and must stay
  one. Do not add a DOM parsing library without justifying it in your report.
- new `dashboard/server/src/contract-conformance.test.ts`.
- a persisted artifact, `results/contract-conformance.json`, written wherever the run already
  writes its creative results.

**The integration point is an open question, and answering it is part of T27.** Two of my
attempts to name this seam were wrong, so it is specified as a measurement, not an assertion.
Do not wire the check into a refusal path this session. Write the pure function, persist the
artifact, and report which of these is correct, with the evidence:

- Does `creative-render.ts`'s issue path reach a run where the renderer never started? On the
  study run `results/creative-status.json` records `renderManifestHash: null` and
  `reviewStopReason: "critic_unavailable"`, so a check that rides the render manifest inherits a
  dead path. Confirm or refute that.
- Is there a seat that already reads `results/` after the build and before the run is called
  clean, which could read this artifact without a renderer?
- Would a `blocking` conformance issue on this study run have been correct, or would it have
  burned a fix round the run could not win? That is the objection recorded at
  `visual-criteria.ts:14` and it applies here; answer it with this run's six divergences, not in
  the abstract.

**What to compare, and nothing else.** Five kinds, all mechanical:

| kind | compares |
|---|---|
| `contract_section_missing` | a contract section id with no `data-creative-section` node |
| `contract_section_unknown` | a `data-creative-section` node with no contract section |
| `contract_eyebrow_count` | count of eyebrow-position labels in the DOM vs count of contract sections with `eyebrow !== null`. **Contract versus DOM only.** Do not re-check the `ceil(n / 3)` ration here: `creative-contract.ts:1157` already owns it, and on the study run it passes on both artifacts (8 marked sections, `ceil(8/3) = 3`, three rendered) |
| `contract_eyebrow_text` | a contract `eyebrow` string absent from its section's rendered text |
| `contract_headline_text` | a contract `headline` absent from its section's rendered heading |

**Namespace drift is a first-class case, not a bug to work around.** The delivered run's
contract ids are `hero`, `nav`, `positioning`, … and its DOM carries `s.hero`, `s.nav`, …
Decide one rule, write it down in the module docblock, and test it: either the comparison
normalises a single leading `s.` prefix, or it does not and every section reports
`contract_section_missing`. Do not silently strip more than you documented. If you normalise,
`positioning` must still report missing, because it is absent under either spelling.

**Acceptance criteria.**

1. Given the real artifacts of `run-cont-e22fa17f9b7972c79641`
   (`dashboard/runs/run-cont-e22fa17f9b7972c79641/workspace/index.html` and
   `results/creative-contract.json`, copied into a test fixture, not read from `dashboard/runs`
   at test time), the extractor reports, at minimum: `contract_section_missing` for
   `positioning`; `contract_section_unknown` for `s.standard`; `contract_eyebrow_count` with
   **contract 1 and DOM 3**; `contract_eyebrow_text` for `Engagements`; and
   `contract_headline_text` for the hero.
2. Each issue's `detail` names the observed value and the expected value. A detail that says
   only "eyebrow count wrong" fails review.
3. Every issue carries a `code` and a `severity` from a closed set declared in the new module,
   in the shape of `render-manifest.ts:16-22`. Nothing in `bakeoff/` changes, the
   `DomFindingKind` union is untouched, and `VISUAL_DOM_KINDS` is untouched. A diff that
   touches `bakeoff/` fails review.
4. **NEGATIVE CONTROL, three, all required.**
   (a) A conforming fixture — contract and HTML that agree — returns `[]`. Build it by editing
   the real fixture until it agrees, so it is a page the extractor could have passed. A
   comparison that always finds something is not a comparison.
   (b) Mutate the extractor so `contract_eyebrow_count` counts contract eyebrows on both sides
   instead of DOM on one. Criterion 1's eyebrow assertion must go red. This is the exact defect
   being fixed, so it must be demonstrably detectable.
   (c) Delete one contract section from the fixture contract while leaving the HTML alone. The
   run must report `contract_section_unknown`, not silence. This proves the comparison is
   two-directional; a one-directional check passes (a) and (b) and still misses `s.standard`.
5. `hasLegacyDeterministicMarkerConflict`'s existing behaviour is unchanged after it is
   rewired onto the shared extractor. Pin it first: capture a golden of its current result on
   the study run's workspace in a separate commit, per wave 2 standing rule 3, then refactor.
6. `dist/` is rebuilt and the new module is exercised through the built output at least once,
   as the repo's prompt-shape tests do; a `.ts`-only test can pass against code the run never
   loads.

**Out of scope, explicitly.** Whether these issues can *refuse* a run. T27 computes and
persists them; wiring them to a refusal is a later task with its own negative control and its
own owner decision. Answer the three integration questions above with evidence instead.

**Reversibility.** R-additive: one new module, one new test, one set addition. Revert the
commit and the tree is byte-identical.

**Survives abandonment.** Yes. It is independent of the design lane, of
`taste-frontend-expert`, and of whether the creative critic ever runs.

**Commit.** `fix: check the built page against its contract`

---

## T28 — A continuation carries its creative contract forward

**Goal.** `createTerminalContinuation` copies the resolved creative contract into the
continuation, and the contract phase amends the inherited contract for the follow-up brief
instead of authoring a new one from scratch.

**Why here.** It is the seam that produced T27's divergences. `run-continuation.ts:70` copies
`source.workspace` to `target.workspace` and nothing else, so the continuation inherits the
art and re-decides the copy: `direction.md` was written against one contract and the page was
built against another. `creative-recovery.ts:49` already does the right thing —
`COPY_RESULTS = [CREATIVE_CONTRACT_FILE, CREATIVE_AUTHOR_FILE, CREATIVE_COMPILE_FILE,
ENVIRONMENT_FILE]` — so this is an existing pattern applied to a second caller, not a new idea.

**Touches.**
- `dashboard/server/src/run-continuation.ts:60-76` — the `copyTree(source.workspace,
  target.workspace, 0)` block.
- `dashboard/server/src/creative-recovery.ts:49` — `COPY_RESULTS`, the pattern to follow. If
  the same list serves both, export it from one place rather than duplicating the array.
- the contract phase entry in `dashboard/server/src/orchestrator.ts` — `#creativeContractPhase`.
  It must take an amend arm when an inherited contract is present. Find its current line;
  `FINDINGS-2026-09-02` cites `:2512` at an older commit.
- `dashboard/server/src/orchestrator.test.ts` — the continuation tests.

**Acceptance criteria.**

1. A continuation of a run whose results carry a creative contract finds that contract in its
   own results tree before the contract phase runs.
2. With an inherited contract present, the contract phase amends rather than re-authors: the
   section ids and the frozen headline strings that the follow-up brief does not mention
   survive byte-identical. Assert on specific strings, not on a hash of the whole file.
3. With no inherited contract, behaviour is byte-identical to today. Capture a golden of the
   unchanged branch in a separate first commit, per wave 2 standing rule 3.
4. **NEGATIVE CONTROL, two, both required.**
   (a) Remove the contract from the copy list. Criterion 1 goes red. If every continuation test
   stays green with the copy removed, the test is asserting on the new run's freshly authored
   contract and proves nothing.
   (b) A continuation whose follow-up brief *does* ask for a different headline must change
   that headline. Otherwise "amend" has silently become "freeze", and the owner loses the
   ability to revise copy on a continuation, which is most of what a continuation is for.
5. Re-run T27's extractor over a continuation built after this change and record the finding
   count in your report. It is evidence, not an assertion; do not gate T28 on it.

**Reversibility.** R for the copy list. The contract phase's amend arm is R-flag: one boolean
restores re-authoring.

**Survives abandonment.** Yes. Continuations are the owner's main working loop regardless of
which design lane survives.

**Commit.** `fix: carry the creative contract into a continuation`

---

## Not in this brief

Two mechanisms the comparison confirmed and this brief deliberately leaves out, so they are
not re-derived:

- **Palette bans.** The external scaffold names banned palette families by literal hex,
  including the family of the previous build. We have no palette rule at any layer. This is
  real work with a real design decision inside it; it needs the owner, not a Codex session.
  Carry as `PALETTE-BAN-001`.
- **A cross-run identity ledger.** They require the next build to differ from the last on ≥4
  of 6 identity axes. We persist nothing between runs, so cross-run sameness is undetectable
  by construction. Carry as `IDENTITY-LEDGER-001`.

Neither is a prerequisite for T27 or T28.
