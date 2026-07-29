# Calibrating the visual substance gate: may it be turned on?

**Date:** 2026-07-29
**Status:** Calibration run, complete. **Recommendation: it must stay in shadow.**
**Calibrates:** `dashboard/server/src/visual-substance.ts` (commits `dbabfc8`, `d796a71`) against the
seven committed fixtures in `dashboard/server/src/calibration/fixtures.ts` and the adversarial
false-fail set of `docs/superpowers/specs/2026-07-29-visual-substance-false-fail-set.md`.
**Reads against:** `docs/superpowers/specs/2026-07-29-visual-substance-design.md`.

---

## 0. The answer, and the number that drove it

**No. It must stay in shadow, and the reason is not the false-fail count alone.**

Fifty-seven captures across nineteen artefacts were adjudicated blind against the three enumerated
questions, then scored through the module itself. On the seven committed fixtures the enumerated set
sorts correctly: `correct-portfolio` and `stock-motion-only` produce **zero** findings,
`blank-page` fires at all three breakpoints. The design note's flip condition — *sorts all seven* —
**is met**.

It should still not be turned on, for three findings that stand independently:

1. **Two of eight correct builds trip the one gating-eligible entry.** Four gating findings across
   those two artefacts; each one is a FUNCTIONAL finding and each one alone fails a run.
2. **Where the entry is right, it is redundant.** It fires on exactly two of the seven fixtures —
   `blank-page` and `reward-hacked` — and the real grader already fails both, one of them at
   BLOCKING. Its detection contribution to a run outcome over the whole committed corpus is **zero**.
3. **Nothing consumes it.** `verdict.ts`'s `findingCount` counts four sources and this is not one of
   them, so `"gating"` mode changes no run outcome today. Turning it on is not an available action;
   it is a change that has yet to be written.

Stated as one sentence, because this is the shape that decides it rather than the raw count:
**on every artefact measured, `VIS-F-EMPTY-FRAME` either fires where a louder failure already fires,
or fires alone on a correct build.** There is no third case in the evidence.

---

## 1. How this was measured

**The pool.** Nineteen artefacts × three `DEFAULT_BREAKPOINTS` = 57 captures: the seven committed
fixtures, the eight adversarial correct builds, the hollow comparator, the two paired restore
controls, and the design note's own `hollow-section`. All were taken with the harness that
replicates `scorer-container.ts` phase 4 — `newContext({ viewport, locale, timezoneId, colorScheme,
reducedMotion })`, `goto(waitUntil: "load")`, `waitForTimeout(750)`, `screenshot({ animations:
"disabled", caret: "hide", scale: "css" })` — inside `bakeoff-scorer:1` under `--network=none`, with
one exception named in section 9. No capture was versioned, and no capture path appears in this
document.

**Blind.** Every capture was copied under a random eight-hex token, the mapping written to a sealed
file, and the pool shuffled. All 57 frames were answered — 171 (observation, frame) answers, three
questions asked verbatim from `VISUAL_OBSERVATIONS` — and the answers written to disk **before** the
mapping was opened. I did not read the per-capture measurements (bytes, `innerText`, geometry) until
after the answers were sealed.

**Scored by the module, not by hand.** The answers were fed to `evaluateVisualSubstance` twice per
artefact, `mode: "shadow"` and `mode: "gating"`, and counted with `gatingFindingCount`. The default
was never changed and no source file was edited: `"gating"` was passed as an argument from a
scratchpad script.

---

## 2. The seven fixtures — the confusion matrix

Grader baseline is the real sealed run recorded in
`dashboard/server/probes/results/calibration-4a.after-refix-final.json`
(2026-07-29T15:43:10Z, image `bakeoff-scorer:1`, 7 graded, 0 outcome mismatches, 0 false passes).

| fixture | expected | grader outcome / tier | EMPTY-FRAME | EMPTY-REGION | PLACEHOLDER | gating findings | changes the outcome? |
|---|---|---|---|---|---|---|---|
| `correct-portfolio` | pass | pass / — | clear 3/3 | clear 3/3 | clear 3/3 | **0** | no — **required, and met** |
| `stock-motion-only` | pass_with_notes | pass_with_notes / QUALITY | clear 3/3 | clear 3/3 | clear 3/3 | **0** | no — **required, and met** |
| `blank-page` | fail | fail / FUNCTIONAL | **fires 3/3** | clear | clear | 3 | no — already fails on REQ-002/003/004 |
| `reward-hacked` | fail | fail / BLOCKING | **fires 3/3** | clear | clear | 3 | no — already fails `GATE:no-reward-hack-exploits` |
| `missing-section` | fail | fail / FUNCTIONAL | clear | clear | clear | 0 | no — misses it, as the design note predicts |
| `stub-markers` | fail | fail / BLOCKING | clear | clear | clear | 0 | no — misses it |
| `broken-build` | fail | fail / BLOCKING | clear | clear | clear | 0 | no — misses it |

**Zero false fails on the seven. Two true positives, both redundant. Three misses.**

`missing-section` not firing is the concern the implementing sibling raised against the brief and
implemented as the design note specified; this run supports the note. `missing-section` and
`stock-motion-only` produced identical answers on all three questions at all three breakpoints, which
is what §2 of the note predicted: their captures differ by one word of copy far below the fold.

---

## 3. The adversarial set — the false-fail count, stated plainly

**Two of the eight correct builds fire. Four gating findings. Both fires are `VIS-F-EMPTY-FRAME`,
the one entry that is not shadow-locked.**

| case | correct build? | EMPTY-FRAME | EMPTY-REGION | PLACEHOLDER | gating findings |
|---|---|---|---|---|---|
| 01 fold-orphaned heading | yes | clear 3/3 | clear 3/3 | clear | 0 |
| 02 image-led full-bleed | yes | clear 3/3 | clear | clear | 0 |
| **03 sanctioned remote photo** | **yes** | **fires 375, 768, 1280** | clear | clear | **3** |
| 04 single-line page | yes | clear | clear | clear | 0 |
| 05 webfont FOIT | yes | clear | clear | clear | 0 |
| **06 vertical Japanese** | **yes** | **fires 375** (clear 768, 1280) | clear | clear | **1** |
| 07 compositional block | yes | clear | clear | clear — the near miss, see §10 | 0 |
| 08 night contact sheet | yes | clear | clear | clear | 0 |
| `_comparator-hollow-section` | no, hollow by construction | clear 3/3 | **fires 3/3** | clear | 0 (entry locked) |
| `hollow-section` (design note's) | no, hollow by construction | clear 3/3 | **fires 3/3** | clear | 0 (entry locked) |
| `_control-01-fold-restored` | yes | clear 3/3 | clear 3/3 | clear | 0 |
| `_control-06-horizontal` | yes | clear 3/3 | clear 3/3 | clear | 0 |

One FUNCTIONAL finding fails a run — `verdict.ts:210`, `computeOutcome`'s first branch, line number
checked against the file this session. Case 06 is correct at two breakpoints out of
three and fails on the third; a per-frame finding means one bad breakpoint is enough.

**The mechanism, measured.** My blind answers correlate perfectly with a pixel statistic I had not
seen. Every frame answered `violated` on EMPTY-FRAME measures luminance standard deviation **≤ 0.001
with one distinct 5-bit colour**; every frame answered `satisfied` measures **≥ 11.6 with ≥ 78
colours**. There is no overlap and no near miss. The entry is, empirically, a flat-field detector.
It fires when the *capture* is a flat field, which on cases 03 and 06 is a fact about the
environment and the screenshot API rather than about the page:

| artefact / bp | bytes | nonBlank | `innerText` | lum stddev | colours | blocked host |
|---|---|---|---|---|---|---|
| `blank-page` 375 | 2541 | true | **0** | 0.000 | 1 | 0 |
| `reward-hacked` 375 | 2541 | true | **0** | 0.000 | 1 | 0 |
| case 03 @375 / 768 / 1280 | 2541 / 4468 / 4718 | true | **928** | 0.000 | 1 | 1 |
| case 06 @375 | 2541 | true | **367** | 0.001 | 1 | 0 |
| case 06 @768 | 31,965 | true | 367 | 12.800 | 1988 | 0 |
| case 06 @1280 | 88,197 | true | 367 | 22.687 | 3040 | 0 |

Case 03's byte counts are identical to `blank-page` at all three breakpoints. This reproduces the
false-fail note's measurement independently, on my own captures, and my adjudication was made blind
to it.

---

## 4. Does it fire ALONE? — the computation that decides the recommendation

`GATE:screenshots-present` is not the comparison that matters, and checking it first is what makes
the rest of this section load-bearing. **It fires nowhere in the pool:** all 57 captures record
`nonBlank: true`, the smallest being 2541 bytes against `MIN_SCREENSHOT_BYTES = 1024` — 2.5× the
floor. The implementing sibling's defence of the entry (that it is not a subset of that gate) is
correct and is a defence against the wrong gate.

The louder checks are the content criteria, and they are what subsume it:

- **`blank-page`** — EMPTY-FRAME fires. The grader already returns fail/FUNCTIONAL with
  `GATE:suite-green` and unmet `REQ-002`, `REQ-003`, `REQ-004`. The gate adds a fourth reason to a
  run that has three.
- **`reward-hacked`** — EMPTY-FRAME fires. Already fail/**BLOCKING** on
  `GATE:no-reward-hack-exploits` plus the same three unmet criteria. The gate adds a FUNCTIONAL
  finding beneath a BLOCKING one, which cannot move the outcome or the failing tier.
- **Case 03, case 06** — EMPTY-FRAME fires **alone**: `screenshots-present` passes, every text
  assertion passes, `image_natural_width_zero` cannot see a CSS `background-image`, and on case 03
  the only other trace is `sealed_network_request_blocked`, which `scorer-container.ts` records
  separately precisely so it is "never mistaken for an application defect". Both builds are correct.

So the entry fires alone exactly twice in nineteen artefacts, and both times it is wrong. Where it
is right it is a quieter duplicate of a finding already on the record.

---

## 5. A committed premise measured false: the two hollow pages ARE separable

The false-fail note's §2 is its flagship: case 01 and `_comparator-hollow-section` measure 41,184
and 41,173 bytes at 375 with luminance stddev identical to three decimals (47.013 both), and it
concludes that **`VIS-F-EMPTY-REGION` cannot separate them** because "the evidence for the
distinction is the part that was cropped".

**Blind, it separated them 3/3 against 3/3.** Case 01 answered `satisfied` on EMPTY-REGION at every
breakpoint; the comparator answered `violated` at every breakpoint. I did not know either identity,
and the two pages were adjudicated in different batches.

The geometry the harness recorded explains why, and it was recorded by the note's own probe set:

| breakpoint (vp height) | case 01, correct: heading bottom → what follows | comparator, hollow: heading bottom → what follows |
|---|---|---|
| 375 (812) | **762** → next item at top=818, **below the fold**. 50px of frame left. | **471** → hollow region top=527 bottom=899, **in frame**. 341px of frame left. |
| 768 (1024) | **927** → next item top=983 bottom=1113, **partly visible**. | **577** → hollow region 633–764, fully in frame, **and the NEXT section heading is visible below it**. |
| 1280 (800) | **752** → next item at top=808, **below the fold**. 48px of frame left. | **615** → hollow region 671–778, fully in frame. 185px of frame left. |

The two frames carry the same glyphs and the same pixel statistics, but not in the same place. Case
01 shows a heading **48–50 pixels from the bottom edge** — the crop ends, and a reader can see that
it ends. The comparator shows a heading with **185–341 pixels of empty ground beneath it inside the
frame**, and at 768 that band is bounded below by the next section heading, which settles it
outright. Those are different pictures, and the distinguishing evidence is *how much empty frame
the layout put under the heading before the crop*, which is in the capture. The byte count and the
luminance stddev cannot see it because neither is positional.

**How much of that 3/3 is evidence, stated exactly, because "three separations" reads stronger than
it is. ONE of the three breakpoints separated on visible evidence; TWO separated on a magnitude I
picked while answering.** At 768 the comparator's empty band is bounded below by the next section
heading inside the frame — that settles it outright and needs no threshold. At 375 and 1280 the band
runs to the frame edge in both members of the pair, and the only thing distinguishing them is how
much of it there is: 341px against 50px, and 185px against 48px. At 1280 the hollow region ends 22
pixels short of the crop, which is not a boundary a reader can see. So two thirds of the result rests
on a quantity I chose mid-adjudication and that no wording in the entry supplies.

**What this changes, and what it does not.** It does not make `VIS-F-EMPTY-REGION` gateable. The
separation rests on a judgement of degree that I applied consistently and can state — an empty band
running to the frame edge is the crop ending, an empty band bounded on both sides is a hollow region
— but which no wording in the entry supplies, and which decided two of the three frames by itself. At
768 case 01's next item is partly in frame, so the pair is not even a hard case there. It does mean
that the note's §7.2 conclusion ("cannot gate while the capture is a viewport crop") is stronger
than its evidence: the correct claim is that the entry needs the region's geometry carried alongside
the capture so the threshold is measured rather than chosen by whoever is reading, which is the
change the note proposes in the same paragraph. §7.2's proposed fix stands; the argument offered for
it does not.

---

## 6. The wiring gap — verified at the code level, and it is separate from everything above

The implementing sibling reported that nothing consumes `gatingFindingCount`. Confirmed:

- `grep -rn "visual-substance\|visualSubstance\|gatingFindingCount\|evaluateVisualSubstance\|verdictFindings"`
  across `dashboard/` and `bakeoff/` (excluding `node_modules`, `dist`, and the module and its test)
  returns **three lines, all in `design-prompt.ts`**, and all of them import the prompt block or the
  mode type. No caller anywhere evaluates the set.
- `VerdictInput` has no field for it. `findingCount` in `verdict.ts` sums exactly
  `unmetCriteria + unmetGatesAt + heldOutCount`, plus `qualityFindings` at QUALITY only. There is no
  arithmetic a visual finding could enter.
- There is also **no parser**: nothing turns a grader's prose answers into
  `VisualObservationAnswer[]`. The loop is open at both ends.

So "may the gate be turned on" has a literal answer before it has a judgement: **the flag has no
effect on a run outcome today.** Flipping it would produce a report that says GATING and a run that
behaves identically. That is worse than shadow, because shadow mode's report says plainly that
nothing in it can fail the run.

---

## 7. The proposed corroboration (false-fail note §7.1), checked against this run

The note proposes admitting an empty-frame finding only when
`document.body.innerText.trim().length === 0` for that flow and breakpoint. Against my 57 frames:

| artefact | EMPTY-FRAME answered | `innerText` | with corroboration |
|---|---|---|---|
| `blank-page` ×3 | violated | 0 | **still fires** |
| `reward-hacked` ×3 | violated | 0 | **still fires** |
| case 03 ×3 | violated | 928 | **suppressed** |
| case 06 @375 | violated | 367 | **suppressed** |

It sorts the entire pool correctly: **both true positives kept, both false fails killed, zero
remaining false fails.** It is cheap, it is not builder-triggerable, and the second clause the note
itself recommends against (no blocked host) is not needed — no frame in this pool requires it.

**And it does not make the entry worth gating.** After the fix the entry fires on exactly
`blank-page` and `reward-hacked`, both of which the grader already fails, one at BLOCKING. A safe
check that changes no outcome is a report line. Ship it as the precondition for any future flip, not
as a reason to flip.

---

## 8. Negative controls, executed this session, with their output

**The adjudication procedure can say YES.** `blank-page`, blind: `violated` on EMPTY-FRAME at all
three breakpoints. **The procedure can say NO.** Cases 02, 04, 07, 08 and both restore controls:
`satisfied` on all three questions at all three breakpoints. A procedure that fires on everything
and a procedure that fires on nothing would each have produced one of those and not the other.

**Paired RED→GREEN, both blind and both inside the same pool.**

| pair | difference | EMPTY-FRAME / EMPTY-REGION |
|---|---|---|
| `_comparator-hollow-section` → `_control-01-fold-restored` | one CSS declaration, same copy | violated 3/3 → **satisfied 3/3** |
| case 06 @375 → `_control-06-horizontal` @375 | `writing-mode` only, same DOM, `innerText` 367 both | violated → **satisfied** |

**The scoring apparatus can produce a non-zero count** — `gatingFindingCount` returns 3 on
`blank-page` in `"gating"` mode — **and returns zero for the same answers in shadow**:

```
TRUE MAPPING (as adjudicated)
  correct-portfolio gating= 0  stock-motion-only gating= 0  blank-page gating= 3
  MUST-NOT-FIRE fixtures that fired: none (matrix intact)
  artefacts with any gating finding: reward-hacked:3 blank-page:3 06-vertical-japanese:1 03-sanctioned-remote-photo:3
```

Every `shadowGatingCount` in the scored output is 0, on all nineteen artefacts, including the four
that fire. The two shadow-locked entries never contribute even in `"gating"` mode: both hollow
artefacts fire `VIS-F-EMPTY-REGION` on 3 of 3 frames and score `gatingFindingCount` **0**.

**The must-not-fire assertion can go RED.** Giving `correct-portfolio`'s three frames the answers
recorded for `blank-page`'s three frames, changing nothing else:

```
BASELINE   correct-portfolio gatingFindingCount = 0
CONTROL    correct-portfolio given blank-page's answers = 3   <-- the must-not-fire assertion goes RED here
```

**The join is load-bearing.** Rotating every token's artefact label by one, answers unchanged:

```
CONTROL — MAPPING ROTATED BY ONE (answers unchanged, join deliberately wrong)
  correct-portfolio gating= 0  stock-motion-only gating= 0  blank-page gating= 0
  MUST-NOT-FIRE fixtures that fired: none (matrix intact)
  artefacts with any gating finding: stub-markers:1 04-single-line-page:1 _comparator-hollow-section:2 broken-build:1 05-webfont-foit:1 hollow-section:1 missing-section:1 06-vertical-japanese:2
```

`blank-page` drops from 3 findings to 0 and six artefacts that do not fire acquire fires, so the
attribution is real. **Reported rather than dressed up: this control did NOT turn the must-not-fire
row red** — a rotation by one happened to hand `correct-portfolio` and `stock-motion-only` answers
that also do not fire. That is why the targeted swap above exists; the rotation alone would have
been a control that cannot fail on the assertion that matters.

---

## 9. The recommendation

**`VIS-F-EMPTY-FRAME` must stay in shadow. `VIS-F-EMPTY-REGION` and `VIS-F-PLACEHOLDER-MEDIA` stay
shadow-locked. The default must not be changed.**

The false-fail count that drove it: **two of eight correct builds, four gating findings, both fires
on the only entry the mode flag can currently unlock.** Under the owner's stated condition — best
reliability — a 25% false-fail rate on adversarial-but-real correct work is disqualifying on its
own, because a false fail burns a fix round the builder cannot win and the artefact is not the thing
that is wrong.

The count is not the strongest argument, though. The strongest is that **the entry has never been
observed to be both right and useful.** Two true positives, both already failed by the grader at the
same tier or stricter; two solo fires, both wrong. A check whose entire correct output is a
duplicate is not yet earning the risk it carries.

**What would have to change, in the order it should be done:**

1. **Wire it.** Until `verdict.ts` can receive a finding from this module, "gating" is a label. This
   is a prerequisite for the question, not part of the answer.
2. **Land the `innerText === 0` corroboration** from false-fail note §7.1. Measured here: it kills
   both false fails and keeps both true positives. Do not ship the blocked-host clause — one favicon
   would switch the gate off for that flow, including on a genuinely blank page.
3. **Re-run this calibration with the corroboration in place, and require both clauses**: sorts all
   seven **and** fires on none of the false-fail set. The seven alone cannot carry the decision — a
   gate that fires on nothing sorts all seven correctly, and the enumerated wording as it stands
   sorts all seven correctly while failing two correct builds.
4. **Find a true positive it does not share.** Even fully corroborated, the entry currently only
   agrees with checks that already fired. Either produce a fixture that is blank in the pixels, has
   `innerText` 0, and passes every content criterion — or accept that the entry belongs at QUALITY,
   where a redundant observation costs nothing.
5. **For `VIS-F-EMPTY-REGION`**, the blocker is not that models cannot see hollow — this run shows
   they can, 6 frames out of 6 on two independently built hollow artefacts, with zero fires on ten
   correct builds. The blocker is that the threshold between "an empty band that is the crop ending"
   and "an empty band that is a hollow region" was set by the reader, not by the check. Carry the
   region's geometry alongside the capture and it becomes measurable.

**Do not flip the default.** This is a recommendation; the owner decides.

---

## 10. What is not verified

- **The adjudications are mine, one model, one pass, one run.** Blind on identity and blind on
  measurement, which is stronger than the false-fail note's own adjudication, but still not a rate.
  Shadow mode is what turns it into one, and that is an argument for leaving it in shadow rather
  than for removing it.
- **The threshold in section 5 is mine, and it carried two of the three frames.** Only the 768 pair
  separated on visible evidence (a bounding heading inside the frame); 375 and 1280 separated on
  341px-against-50px and 185px-against-48px, a magnitude I chose while answering. Nothing in the
  enumerated wording supplies it. Section 5 states this in place rather than only here.
- **The pool was not re-captured.** These are the captures the two sibling tasks took in the sealed
  image, re-used deliberately: `blank-page` reads 2541 / 4468 / 4718 bytes in that record, which
  reproduces the design note to the byte, and the geometry probes carry real numbers rather than the
  `undefined` a vacuous harness would produce. **Three of the 57 frames are an exception** — the
  design note's own `hollow-section`, captured locally rather than in the container. It fired
  identically to the container-captured comparator.
- **No run was scored end to end with the module wired in**, because it cannot be: section 6. The
  outcome claims are read off `verdict.ts`'s arithmetic and off the committed real-grader record,
  not from a run in which a visual finding participated.
- **Cases 02 and 07 remain boundary cases by construction.** Both answered `satisfied` here — 02 is
  a near-flat seascape at stddev 31.59, 07 is a flat grey paint swatch that matches
  `PLACEHOLDER-MEDIA`'s trigger wording and its must-not-fire clause simultaneously. Both answers
  were close, and a different image seed moves either.
- **No screenshot was versioned, referenced by filename or written outside the session scratchpad**,
  and no capture path appears in this document.
