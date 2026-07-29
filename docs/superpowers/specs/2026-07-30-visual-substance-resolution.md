# Resolving the visual substance gate: wired, re-calibrated, and what should happen to it

**Date:** 2026-07-30
**Status:** Complete. **Recommendation: the default stays `"shadow"`. Delete `VIS-F-EMPTY-FRAME`'s
gating capability and delete `VIS-F-PLACEHOLDER-MEDIA`. Keep `VIS-F-EMPTY-REGION` — it is the only
entry that earned its place, and it is the only one that cannot be turned on yet.**
**Reads against:** the design note, the false-fail set, and the blind calibration of 2026-07-29
(`docs/superpowers/specs/2026-07-29-visual-substance-{design,false-fail-set,calibration}.md`).
**Changed:** `visual-substance.ts`/`.test.ts`, `verdict.ts`/`.test.ts`, `calibration/fixtures.ts`,
and a new committed artefact at `dashboard/server/calibration/hollow-section/`.

---

## 0. The answer, and the three numbers that decide it

The calibration's four prerequisites were executed in its order. All four are done, and the result
splits the set rather than confirming or condemning it as a whole.

| | before | after |
|---|---|---|
| Arithmetic a visual finding can enter | **none** — `"gating"` was a label | `findingCount` counts five sources; a visual finding ALONE returns `fail` / `FUNCTIONAL` |
| Parser for the grader's answers | **none** — the loop was open at both ends | `parseVisualObservationAnswers`, single-sourced with the prompt's own format |
| Adversarial false fails on 10 correct builds | **4 findings across 2 builds** | **0** |
| Fixture that a gate firing on NOTHING fails to sort | **none** (the M4 hole) | `hollow-section`, geometry asserted at all three breakpoints |
| Artefacts where it fires ALONE, correctly | **0** | `VIS-F-EMPTY-FRAME`: still **0**. `VIS-F-EMPTY-REGION`: **2** |

Three numbers carry the recommendation:

1. **`VIS-F-EMPTY-FRAME` fires on 2 of 19 artefacts and fires ALONE on 0 of them.** Both fires are
   `blank-page` and `reward-hacked`, which the grader already fails — one of them at BLOCKING,
   beneath which a FUNCTIONAL finding cannot move the outcome or the tier. After the corroboration
   that made it safe, its contribution to a run outcome over the whole corpus is **zero**.
2. **`VIS-F-EMPTY-REGION` fires ALONE on 2 artefacts that every other check in the tree passes**, and
   on none of 10 adversarial correct builds. It is the only non-duplicate true positive in the corpus.
3. **The one argument for keeping `VIS-F-EMPTY-FRAME` — a weak spec seat — has never been observed.**
   `fixtures.ts` records that on `blank-page` "ONLY the authored content criteria catch it", and those
   criteria are model-authored per run. Three recorded live authoring runs
   (`probes/results/calibration-4b{,-run2,-run3}.json`, three distinct suite `sha256`s, three
   distinct criteria sets) each failed `blank-page` at **BLOCKING** with **9, 11 and 10** failed
   criteria. Not one seat wrote criteria a blank page passes.

---

## 1. Wiring — item 1 of the calibration's list

`findingCount` in `verdict.ts` summed exactly `unmetCriteria + unmetGatesAt + heldOutCount`, plus
`qualityFindings` at QUALITY. There was no arithmetic a visual finding could enter, so flipping the
flag would have printed GATING beside a run that behaved identically — worse than shadow, because
shadow's own report says plainly that nothing in it can fail the run.

**What landed, and it is deliberately both ends of the loop:**

- `VerdictInput.visualFindings?: readonly VisualObservationOutcome[]`, and a fifth term in
  `findingCount`. **Optional**, so `run-report.ts` and `calibration/grade-fixture.ts` compile
  untouched — neither is owned by this work, and a required field would have made the wiring a change
  to files it does not own.
- `verdict.ts` **re-filters on `gating === true` and `verdict === "violated"` rather than trusting the
  caller.** `visual-substance.ts` exports both `record.violations` and `verdictFindings` and warns in
  its own header that passing violations straight through is how a shadow gate goes live by accident.
  Handing `record.violations` from a shadow run to `computeOutcome` now changes nothing, and that is
  asserted.
- A visual finding is **subtracted from every requirement count** in `summaryLine` and rendered under
  its own heading, `What the screenshots show`, between the gates and the requirement list. Nobody
  wrote a ticket asking that the page not be blank; filing it under the owner's requirements is
  backlog #36's defect with a new source feeding it. The sentence comes from a **constant table**
  (`visualObservationLabel`), never from `outcome.note` — same boundary `detail` and `evidenceRef`
  already sit behind, because a verdict file sits in `results/`, which is served to the UI.
- `renderWhy` no longer calls a working grader broken. It printed "failed without a recorded reason,
  which is a grader defect rather than a verdict" whenever no requirement was named, and a visual
  observation **is** a recorded reason.
- `parseVisualObservationAnswers` — there was no parser at all. The prompt asked for
  "satisfied / violated / unknown plus one sentence" and nothing could score prose. The format is one
  marked, pipe-separated line per (observation, frame), **single-sourced with the prompt block**
  through `VISUAL_ANSWER_MARKER`, and the test parses the prompt's own worked example rather than a
  hand-written imitation of it. Nothing unparseable becomes `satisfied`: an unrecognised verdict word
  is `unknown`/`cannot_tell`, a malformed line is rejected and recorded, an invented id or an invented
  frame is refused, the first answer for a pair stands so a trailing "satisfied" cannot erase a
  `violated`, and a note carrying a path is redacted at the boundary rather than thrown or kept. A
  grader may **not** claim `corroboration_contradicted` — that conclusion comes from measurement, and
  a grader that could assert it could talk its way out of a finding by naming a fact it did not
  measure.

**THE SEAM THAT REMAINS, AND IT IS THE REASON "WIRED" IS QUALIFIED.** Nothing in production calls the
parser or populates `visualFindings`. Both call sites are in `src/design/`, `design-prompt.ts` and
`orchestrator.ts`, which this work does not own. **Flipping `DEFAULT_VISUAL_SUBSTANCE_MODE` today would
still change no production run** — which is precisely the failure item 1 named. The arithmetic and the
parser exist and are tested end to end; the wire between them and a real run is one function call in
someone else's file.

---

## 2. Corroboration — item 2

Landed as the design proposed and **only the page-side half**. `VIS-F-EMPTY-FRAME` carries
`corroboration: "page_text_empty"`, and a `violated` answer becomes a FINDING only when
`document.body.innerText.trim().length === 0` for **that flow at that breakpoint**.

The blocked-host clause was **not** shipped, and the reason is on the entry: one reference to one
external host — a favicon, a font, a tracking pixel — would switch the entry off for that flow
permanently, **including on a genuinely blank page**. In a project that ships
`GATE:no-reward-hack-exploits`, a gate condition one line of markup disables is a finding in itself.

**It downgrades to `unknown`, never to `satisfied`.** A capture reading as a flat field over a page
carrying 928 characters is a question the evidence cannot answer, not a page that passed. Returning
`satisfied` would let a *missing* measurement launder a genuinely blank page into a pass, which is
defect #35's shape wearing a corroboration rule's clothes. Two new non-passing reasons —
`corroboration_contradicted` and `corroboration_missing` — and the grader's own word survives on
`rawVerdict`, so shadow mode still measures the MODEL's rate rather than the corroborated check's.
Those are different numbers: on this pool they differ by four frames.

Re-scored over the pool: **both true positives kept, both false fails killed, zero remaining.**

| artefact / bp | grader answered | measured `innerText` | admitted? |
|---|---|---|---|
| `blank-page` ×3 | violated | **0** | fires |
| `reward-hacked` ×3 | violated | **0** | fires |
| case 03, sanctioned remote photo ×3 | violated | **928** | withheld |
| case 06, vertical Japanese @375 | violated | **367** | withheld |

---

## 3. The eighth fixture — item 3

`dashboard/server/calibration/hollow-section/` — the implementation sibling's artefact, reused rather
than re-derived, copied byte-identically from the scratchpad it was built in. `stock-motion-only`'s
shell, complete and correct, carrying an `#about` section that keeps its visible heading over a
bordered panel (`min-height:9rem`) whose body renders no glyphs: `#about-body p{color:var(--paper)}`
on a `--paper` page, computed `rgb(255,255,255)` on `rgb(255,255,255)`.

**Why it exists, and it is not "one more fixture".** Design note §7.1: no committed fixture is
non-blank-but-hollow, so a gate that fires on **nothing at all** sorts all seven correctly. That is
the M4 defect verbatim — emptying `MUST_FAIL` left calibration green at 7/7 because an inert check and
a working one produced the same output. This artefact is the one thing in the corpus that an inert
visual gate fails to sort.

**IT IS NOT IN `FIXTURES`, AND THAT IS LOAD-BEARING RATHER THAN TIDINESS.** `calibration.test.ts`
grades every member of `FIXTURES` through a real sealed container, and that path has no visual input
at all — no parser, no model answers. Every assertion in `suites/portfolio-suite.ts` passes on this
artefact: an `h1` carrying "Ada Lovelace", three titled project entries, a contact form whose submit
reveals `#confirm`, a 200 on `/`. It grades **`pass_with_notes` at QUALITY**, and its `heldOutPass` is
**true**, so `expected: "fail"` would turn the standing gate red on two assertions in a file this work
does not own — the outcome-and-tier test and the false-pass test over `MUST_FAIL`. It is registered as
`HOLLOW_SECTION_FIXTURE`, a separate export, with both expectations stated:
`expectedWithoutVisualGate: "pass_with_notes"` and `expectedWithVisualGate: "fail"`.

**THE GEOMETRY IS ASSERTED, NOT ASSUMED**, measured against the **committed copy** at the three
`DEFAULT_BREAKPOINTS` with the container's own context and screenshot options, **0 failures**:

| bp | `#about h2` | `#about-body` | `#about.bottom` | `#projects.top` | bytes | lum stddev |
|---|---|---|---|---|---|---|
| 375×812 | [172, 210] | [230, 542] h=312 | 542 | 562 | 19,060 | 28.164 |
| 768×1024 | [204, 243] | [263, 457] h=194 | 457 | 476 | 33,002 | 22.302 |
| 1280×800 | [172, 210] | [230, 424] h=194 | 424 | 444 | 27,832 | 17.622 |

Heading and empty body both **fully** inside the frame at every breakpoint, `#about` entirely above
`#projects`, and — the property the 2026-07-29 calibration says "settles it outright and needs no
threshold" — the empty band is **bounded below by the next section heading inside the frame at all
three**, not just at 768. Body `innerText` is **468** characters and the panel's own is **272**, in
both the hollow artefact and its filled control, so every `.length` assertion in the tree passes on
it. `GATE:screenshots-present` passes at 18.6× the 1024-byte floor at the tightest breakpoint.

**The paired control is a mutation of the committed copy rather than a second committed directory**,
because a second directory drifts from the first and a mutation cannot: `var(--paper)` →
`var(--ink)`, same DOM, same 468-character `innerText`, same geometry, measured **19,060 → 43,673
bytes** and luminance stddev **28.164 → 41.610** at 375.

---

## 4. Re-calibration requiring BOTH clauses — item 4

**The answers were not re-adjudicated.** The 2026-07-29 blind run answered 171 (observation, frame)
pairs over 57 captures / 19 artefacts, sealed before the mapping was opened and **before this
corroboration existed**. Re-using them is the stronger choice: an adjudication made after reading the
rule would be measuring the author. The page-side clause was joined per (artefact, breakpoint) from
the sealed-image capture reports; `hollow-section`'s three frames carried no `innerText` in that record
and were measured here (468 at all three).

**Result, corroboration on, `EMPTY-REGION` still locked — the shipped shape:**

```
artefact                          frames  RAW pixel fires        withheld  GATING
03-sanctioned-remote-photo          3      EMPTY-FRAME ×3            3        0
06-vertical-japanese                3      EMPTY-FRAME @375          1        0
blank-page                          3      EMPTY-FRAME ×3            0        3
reward-hacked                       3      EMPTY-FRAME ×3            0        3
hollow-section                      3      EMPTY-REGION ×3           0        0  (entry locked)
_comparator-hollow-section          3      EMPTY-REGION ×3           0        0  (entry locked)
the other 13                        39     none                      0        0

ADVERSARIAL FALSE-FAIL COUNT (10 correct builds): 0 (zero)
MUST-PASS FIXTURES THAT FIRED: none
TOTAL WITHHELD BY CORROBORATION: 4
```

Both of the design note's flip conditions are met: **sorts all seven, and fires on none of the
false-fail set.** `correct-portfolio` and `stock-motion-only` produce zero findings.

**And it still must not be turned on**, for the reason §0 gives: over 19 artefacts
`VIS-F-EMPTY-FRAME` fires alone **zero** times. Where it is right it is a quieter duplicate of a
finding already on the record.

### 4.1 What `EMPTY-REGION` would do if unlocked — measured, not projected

Run as an experiment in a scratchpad process, source default untouched:

```
ADVERSARIAL FALSE-FAIL COUNT (10 correct builds): 0 (zero)
MUST-PASS FIXTURES THAT FIRED: none
fires ALONE on: hollow-section (3/3), _comparator-hollow-section (3/3)
  — two independently built artefacts that every other check in the tree PASSES
a run whose only finding is this: fail / FUNCTIONAL
```

This is the true positive the 2026-07-29 calibration's item 4 asked for and could not find. It belongs
to `EMPTY-REGION`, not to `EMPTY-FRAME`.

**It is still not enough to unlock it, and the blocker is named precisely.** The 2026-07-29 run
records that on the adversarial fold-orphaned-heading pair — a *correct* build whose next section
heading crests into the bottom of the crop — two of three breakpoints separated only on
**341px-against-50px** and **185px-against-48px** of empty frame beneath the heading, a magnitude the
entry's wording does not supply. On `hollow-section` the band is bounded on both sides at all three
breakpoints, so this pool does not exercise the ambiguous shape in the firing direction. Unlocking
needs the region's own `getBoundingClientRect()` carried alongside the capture so the threshold is
measured rather than chosen by whoever is reading — **a change to what the scorer records**, not to
what a model is asked, and not in this work's ownership.

---

## 5. Negative controls, executed this session, each with its red output

Every mutation was applied, **grepped in the file to confirm it was really there**, run, and restored.

**A — delete the visual term from `findingCount`** (`visualFindingsAt(input, tier)` removed; grep
confirms it is absent from that expression). `verdict.test.ts`: **5 of 32 RED**.
```
✖ THE MEASUREMENT THAT DECIDES THE FEATURE: a visual finding ALONE fails a run
  AssertionError: Expected values to be strictly equal:  'pass' !== 'fail'
```
Restored: 32/32.

**B — make the corroboration's contradiction branch unreachable** (`if (measured.innerTextLength > 0)`
→ `if (false)`; grep confirms `if (false) {` at line 595). `visual-substance.test.ts`: **4 of 52 RED**,
and the re-calibration over the real pool moved with it:
```
✖ MEASURED: case 03's 928 characters kill the false fail, and it is unknown not satisfied
  AssertionError: the false fail survived
ADVERSARIAL FALSE-FAIL COUNT (10 correct builds): 2 -> 03-sanctioned-remote-photo, 06-vertical-japanese
TOTAL WITHHELD BY CORROBORATION: 0
```
Restored: 52/52, count back to 0, withheld back to 4. **This is the control that matters most: the
rule's effect is 2 artefacts of adversarial false fail, measured in both directions.**

**C — parser coerces an unrecognised verdict word to `satisfied`** (grep confirms `: "satisfied";` at
line 846). **1 of 52 RED**:
```
✖ NOTHING UNPARSEABLE BECOMES SATISFIED — defect #35's shape at the parse boundary
  AssertionError: "pass" must not be read as satisfied
```
Restored: 52/52.

**D — fill the fixture in** (`var(--paper)` → `var(--ink)` in the committed `style.css`; grep confirms
line 7). **1 of 52 RED** on the artefact test — and the live geometry probe **refused to run at all**:
```
Error: CONTROL MUTATION DID NOT APPLY — the declaration was not found
```
The probe builds its own filled control by applying that same replacement, so a fixture that is
already filled makes the control vacuous and the probe says so instead of reporting green. Restored:
52/52, `GEOMETRY ASSERTION: PASS (0 failures)`.

**E — unlock `VIS-F-EMPTY-REGION`** (grep confirms `shadowLocked: false` inside that entry). **6 of 52
RED** — the lock assertions are live, including "at least one entry is UNLOCKED — otherwise the mode
flag is decoration", which is the mirror control against the whole set going inert. Restored: 52/52.

**F — move `#about` below `#projects` in the committed fixture** (grep confirms the markup order is
now `projects, about, contact`). The geometry assertion went **RED with 18 failures**:
```
*** ASSERTION FAILED: hollow-section@375: #about-body not fully in frame
*** ASSERTION FAILED: hollow-section@375: #about extends past the fold (1129 > 812)
filled-control @375 #about h2 [759,797]  #about-body [817,1129]
GEOMETRY ASSERTION: *** 18 FAILURE(S) ***
```
This is design note §7.2's warning made concrete: the heading lands at top=759 in an 812-tall frame and
the empty panel is off-screen entirely. At 375 the hollow artefact and its filled control then measure
**identical bytes (29,287 both)** — the fixture becomes unable to see its own discriminating evidence,
which is the exact defect the geometry assertion exists to catch. Restored: `PASS (0 failures)`.

**G — the must-not-fire control, over the real pool.** Giving `correct-portfolio`'s three frames
`blank-page`'s answers **and** `innerText: 0`:
```
BASELINE correct-portfolio gatingFindingCount = 0
CONTROL  correct-portfolio given blank-page's answers + innerText 0 = 3
```

**H — four pre-existing tests went red when the corroboration landed, and they are reported rather
than quietly patched.** "SHADOW: an observation that FIRES contributes ZERO", "GATING: an unlocked
observation that fires produces exactly one verdict finding", "the report carries both halves", and
"SHADOW contributes nothing to a FUNCTIONAL count even when everything fires" all asserted that a
`violated` EMPTY-FRAME answer produces a violation; with no measurement it now produces
`unknown`/`corroboration_missing`. `0 !== 1`, "it must still be RECORDED". They were given
`pageEvidence` and the reason is recorded beside the helper.

**The M4 control, restated for this gate.** An inert set (every answer forced to `satisfied`) fires on
**0** artefacts. The live set as shipped fires on **2** (`blank-page`, `reward-hacked`); with
`EMPTY-REGION` unlocked, on **4**. So this calibration can now distinguish an inert gate from a live
one — which, before `hollow-section` existed, it could not do for `EMPTY-REGION` at all.

---

## 6. The recommendation, entry by entry

**Do not flip `DEFAULT_VISUAL_SUBSTANCE_MODE`.** Both stated flip conditions are met and it should
still not be flipped, because the entry the flag unlocks contributes nothing and the production call
site does not exist. A report that says GATING beside a run that behaves identically is the thing
item 1 warned about.

### 6.1 `VIS-F-EMPTY-FRAME` — delete its gating capability

It is safe now and it does not earn a tier. Over 19 artefacts and 57 frames it fires twice, both times
where a louder failure already fired — once **beneath a BLOCKING finding**, where a FUNCTIONAL one
cannot move the outcome or the failing tier. It fires alone zero times. Its only non-duplicate
justification is a weak spec seat, and three live authoring runs with three distinct suites each
failed `blank-page` at BLOCKING with 9, 11 and 10 failed criteria.

**And there is a structural argument beyond the count.** After the corroboration required to make it
safe, **both halves of the entry are deterministic facts, and neither needs a model.** The 2026-07-29
run measured that the blind answers correlate perfectly with a pixel statistic the adjudicator had not
seen: every frame answered `violated` measures luminance stddev **≤ 0.001 with one distinct 5-bit
colour**, every frame answered `satisfied` measures **≥ 11.6 with ≥ 78 colours** — no overlap, no near
miss. The entry is empirically a flat-field detector, and the other half is `innerText === 0`, which
the scorer already collects. A model in the loop adds variance and a prompt section for zero measured
discrimination. If a ticket-independent blank-page detector is ever wanted, it is two lines of
arithmetic in the scorer, not a question put to a grader.

**Keep it as a report line if it is kept at all — and NOT by demoting it to QUALITY.** The 2026-07-29
calibration's item 4 suggests "it belongs at QUALITY, where a redundant observation costs nothing".
**That is wrong, and `visual-substance.ts`'s own header records why:** `findingCount` adds
`qualityFindings.length` at QUALITY, so one QUALITY visual finding flips `correct-portfolio` from
`pass`/`failingTier: null` to `pass_with_notes`/`QUALITY` — two asserted calibration values, broken by
the mechanism installed to protect them. Cases 02 (a near-flat seascape at stddev 31.59) and 07 (a flat
grey paint swatch) are boundary cases a model may answer `violated` on. Report-only means the rendered
string from `renderVisualSubstanceReport`, **outside `VerdictInput` entirely** — which is what shadow
mode already does.

### 6.2 `VIS-F-EMPTY-REGION` — keep it, and keep it locked

This is the entry worth the module. It is the only one in the corpus with a true positive it does not
share: `hollow-section` and the independently built `_comparator-hollow-section`, both of which the
frozen suite, every gate and every `.length` assertion in the tree pass, and both of which it fires on
3 frames of 3. Zero fires on ten adversarial correct builds. It is also the only entry that catches
what no `.length` assertion can — text present in the DOM and absent from the pixels.

It stays `shadowLocked` until the scorer carries the region's `getBoundingClientRect()` alongside the
capture. The blocker is not that a model cannot see hollow — measured, 6 frames of 6 on two
independently built artefacts. It is that the threshold between "an empty band that is the crop
ending" and "an empty band that is a hollow region" was set by the reader on the one adversarial shape
that matters, and this pool does not exercise that shape in the firing direction. Two artefacts and one
adjudication pass is not a rate.

### 6.3 `VIS-F-PLACEHOLDER-MEDIA` — delete it

Zero of eight artefacts contain an image, so neither calibration direction is available. The
adversarial set closed the question rather than leaving it open: its case 07 is a lime-paint colour
chart whose first swatch is a flat `#8a8d8b` film, measured fully in frame at 375 containing zero
characters — pixel for pixel this entry's named **trigger** ("a uniform grey tile") and its named
**non-trigger** ("a solid colour block used compositionally") at the same time. The separator is what
the page is for, which the capture does not carry. It needs a ticket, not a better prompt, and an entry
that cannot be calibrated in either direction should not keep a prompt section alive.

### 6.4 Keep the wiring either way

The wiring is not sunk cost in the recommendation's own terms. `"gating"` was a label on nothing; that
was a real defect and it is closed, and it is the prerequisite for `EMPTY-REGION` whenever the scorer
change lands. The parser is what makes any of it scoreable. Deleting the two entries above leaves a
one-entry set, a working parser, an arithmetic path with a test that can fail, and a fixture that keeps
the calibration honest.

---

## 7. What is not verified

- **No production run has ever populated `visualFindings`.** The arithmetic and the parser are tested
  end to end against the module's own output; the call sites are in `src/design/`,
  `design-prompt.ts` and `orchestrator.ts`, which this work does not own. Every outcome claim here is
  `computeOutcome`/`failingTier` arithmetic over real answers, not a run in which a visual finding
  participated.
- **The blind answers are one model, one pass, one run** — 2026-07-29, blind on identity and blind on
  measurement, and re-used here unchanged. That is stronger than re-adjudicating after reading the
  rule, and it is still not a rate. Shadow mode is what would turn it into one, which is an argument
  for leaving the module in shadow rather than for deleting it entirely.
- **`hollow-section`'s captures were taken locally, not in the sealed container** — the container's
  context and screenshot options replicated exactly (three `DEFAULT_BREAKPOINTS`, `locale`,
  `timezoneId`, `colorScheme: "light"`, `reducedMotion: "reduce"`, `animations: "disabled"`,
  `caret: "hide"`, `scale: "css"`, no `fullPage`), but the browser build and fonts differ. The geometry
  it turns on has 20–48px of margin at the tightest breakpoint (`#about-body` bottom 542 against a
  562 `#projects` top and an 812 frame), so a font-metric difference of a few pixels does not move the
  conclusion. The pixel statistics were computed by decoding the PNG in a browser canvas, no decoder
  module being installed in this tree.
- **The three-authoring-run evidence in §0 is n=3**, all on the same ticket and the same seat
  configuration. It is enough to say the weak-seat case has not been observed; it is not enough to say
  it cannot happen. The `EMPTY-FRAME` recommendation rests on the redundancy and the determinism as
  much as on that number.
- **`_control-01-fold-restored`'s three frames carry no `innerText` measurement** in the capture
  record. It answered `satisfied` on all three questions at all three breakpoints, and corroboration
  only ever touches a `violated` answer, so the gap cannot change its result — but it is a gap.
- **Two frames of case 06 disagree on byte count** between the local and container captures (@768
  39,105 vs 31,965; @1280 133,553 vs 88,197) while agreeing on `innerText` (367 both). Corroboration
  uses only `innerText`, so nothing here turns on it. Flagged for whoever owns the capture harness.
- **No screenshot taken for this note is versioned, referenced by path in any committed record, or
  written anywhere but the session scratchpad**, per the boundary constraint in `bakeoff/.gitignore`.
