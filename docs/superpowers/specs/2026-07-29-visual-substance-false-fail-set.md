# The false-fail control set for the visual substance gate

**Date:** 2026-07-29
**Status:** Adversarial control set. Eight correct builds plus one hollow comparator and two paired
restore controls, all built and measured in this session.
**Reads against:** `docs/superpowers/specs/2026-07-29-visual-substance-design.md` (the enumerated set:
`VIS-F-EMPTY-FRAME`, `VIS-F-EMPTY-REGION`, `VIS-F-PLACEHOLDER-MEDIA`).
**Where the artefacts live:** the session scratchpad, under `false-fail-set/`, one directory per case
with an `index.html` that renders standalone, a `probe.json` naming the geometry each case asserts,
and a `WHY.md` defending the build. Nothing from this work is versioned. No capture is committed,
referenced by filename, or written anywhere but the scratchpad, per the boundary constraint in
`bakeoff/.gitignore`.

---

## 0. The result in one paragraph

**Three of the eight correct builds trip a FUNCTIONAL-eligible entry, and two of them trip
`VIS-F-EMPTY-FRAME`, the entry the design note calls the one that can fire today and the one it is
most confident in.** One produces captures with the same byte count as `blank-page` at all three
breakpoints because a photo host is unreachable under `--network=none`. One produces a
single-colour capture at 375 because Playwright's viewport screenshot does not correspond to the
layout viewport on a `writing-mode: vertical-rl` document. The third is a correct page whose section
heading lands at the bottom of the crop, which is pixel-for-pixel the design note's own section 7.2
hollow fixture: measured at 375, the correct page is 41,184 bytes and the hollow page is 41,173
bytes, at identical luminance standard deviation. Two further cases sit on the boundary of a
must-not-fire clause that is decided by degree rather than by evidence. Two cases correctly do not
fire, and one case that was expected to fire was killed by measurement. On this evidence
**`VIS-F-EMPTY-FRAME` must not gate without DOM corroboration, and `VIS-F-EMPTY-REGION` cannot gate
at all while the capture is a viewport crop.** Section 7 proposes the corroboration, which is cheap
and preserves every true positive the design note claims.

---

## 1. How the set was measured

Captures were taken **inside the sealed scorer image**, `bakeoff-scorer:1`, built from
`mcr.microsoft.com/playwright:v1.62.0-noble` pinned by digest, run with `--network=none` and the case
directories mounted read only. The harness replicates `scorer-container.ts` phase 4 exactly:
`newContext({ viewport, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion:
"reduce" })`, `goto(..., { waitUntil: "load" })`, `waitForTimeout(750)`, then
`screenshot({ animations: "disabled", caret: "hide", scale: "css" })`, at the three
`DEFAULT_BREAKPOINTS`. `nonBlank` is recomputed against `MIN_SCREENSHOT_BYTES = 1024`.

This is one fidelity step beyond the design note, which measured on a local browser and said so. The
seven calibration fixtures were run through the same harness in the same image on the same run, as a
baseline: `blank-page` and `reward-hacked` measure **2541 / 4468 / 4718 bytes**, which reproduces the
design note's local numbers to the byte.

Three things are recorded per capture beyond bytes: `document.body.innerText.trim().length`,
`getBoundingClientRect()` for the elements each case's claim depends on, and two pixel statistics
computed from the PNG itself, **luminance standard deviation** and **count of distinct 5-bit
quantised colours**, so that "reads as a flat field" is a number rather than an impression. A flat
field measures stddev 0.000 and 1 colour. Every geometric claim below is asserted from measurement,
not from markup order.

**Deviations from the container, stated rather than hidden.** Masking was not applied, because no
`maskSelectors` are meaningful on static fixtures and masking only ever removes pixels. The sealed
network was enforced by the container itself for the runs quoted here; a local `route.abort(
"connectionrefused")` simulation was used only while developing the cases, and agreed with the
container.

---

## 2. The flagship: the fold orphans a heading, and the hollow fixture is indistinguishable from it

**Case 01, `01-fold-orphaned-heading`.** A letterpress works in Leipzig. Hero, four presses, a rate
table with four rows, an address and a working email. 1072 characters. Nothing is a stub. The hero
holds the first screen and the next section's heading crests into view under it, which is an ordinary
way to tell a reader the page continues.

Measured at 375x812 in the sealed image: the heading "The four presses" is at top=724, bottom=762,
**fully inside the frame**, and the first item it introduces is at top=818, **below the fold**. At
1280x800: 715 / 752 and 808. So at two of three breakpoints the capture shows a heading with nothing
between it and the frame edge.

`VIS-F-EMPTY-REGION` asks: *is there a region the layout has visibly set aside for content, a heading
with the space beneath it, that contains nothing at all?* From the capture, the answer is yes.

**The comparator.** `_comparator-hollow-section` is case 01 with exactly two changes: an ordinary hero
height, and one CSS rule that renders the section body transparent. This is the design note's section
7.2 fixture: text present in the DOM and in `innerText` (1072 characters, the same as case 01),
absent from the pixels, region position asserted from geometry. At 768 the hollow region is fully in
frame, top=633 bottom=764. At 375, 285 of its 372 pixels are in frame.

| at 375x812 | bytes | luminance stddev | innerText | what the frame shows |
|---|---|---|---|---|
| case 01, correct | 41,184 | 47.013 | 1072 | heading, then paper to the frame edge |
| comparator, hollow | 41,173 | 47.013 | 1072 | heading, then paper to the frame edge |

Eleven bytes apart, identical to three decimals on the pixel statistic, because the two frames
contain the **same rendered glyphs at different vertical positions**. One must fail and one must
pass.

The design note's escape hatch for this entry is "anything below the fold, which is not in evidence".
That protects the content. It does not protect the heading, which is in evidence, and whose emptiness
is an artefact of where the crop landed. **A model looking at one viewport cannot distinguish "the
page did not fill this region" from "the crop ended before the region did", because the evidence for
the distinction is the part that was cropped.**

---

## 3. The environment cases: two correct builds that capture as blank

### 3.1 Case 03, the sanctioned asset strategy renders as a void frame

A sixteen seat wine bar in Lisbon. 928 characters of specific copy, a working phone link and email,
opening hours including the days it is closed, six wines with region and price. The cover is a
photograph of the room, full bleed, no type over it, sourced from a photo host, which is priority 2
of the taste skill's asset strategy and **the only priority available inside a sandbox that has no
network and no image generation tool**. The author also declared a background colour under the image,
which is what you do so the page has a floor while the photograph loads.

Measured in the sealed image with the container enforcing `--network=none`:

| breakpoint | bytes | luminance stddev | distinct colours | innerText | blocked host |
|---|---|---|---|---|---|
| 375 | 2541 | 0.000 | 1 | 928 | `picsum.photos` |
| 768 | 4468 | 0.000 | 1 | 928 | `picsum.photos` |
| 1280 | 4718 | 0.000 | 1 | 928 | `picsum.photos` |

**Those byte counts are identical, at all three breakpoints, to `blank-page` and `reward-hacked`**
measured in the same image on the same run. The captures differ from the killer fixture only in the
colour of the field: mean luminance 30.37 against 241.13.

`VIS-F-EMPTY-FRAME` fires, and it fires **alone**. `GATE:screenshots-present` passes at 2.5x the
floor. `image_natural_width_zero` cannot see a CSS `background-image`, which the design note itself
notes at entry 3 point 4. Every text assertion passes. The only other trace is
`sealed_network_request_blocked`, and `scorer-container.ts` says of it, in the code that emits it,
that it is "Expected under `--network=none` and recorded separately so it is never mistaken for an
application defect". A FUNCTIONAL visual finding converts exactly that excused event into a failed
run.

This is not contrived. Ticket T1 is a photographer portfolio whose customer asks for "my best
photos", and `runner.ts` seals the **build** sandbox with `--network none` as well, so a builder can
neither fetch nor generate an image. On that ticket every available asset strategy leads somewhere
bad: a remote URL gives this, a rendered placeholder tile gives section 5.2, and shipping no images
at all is the option the taste skill calls incomplete work.

### 3.2 Case 06, a correct vertical Japanese page captures as a blank frame

The contents page of a Japanese quarterly, set vertically, which is how such periodicals are set.
Masthead at the right where the reading starts, two lead paragraphs, three contents sections with six
pieces and their authors and page numbers set with `text-combine-upright`, and a colophon with
publisher, address, price and subscription contact. 367 characters of Japanese, all real.

Measured in the sealed image at 375x812: **2541 bytes, luminance standard deviation 0.001, one
distinct colour.** The same byte count as `blank-page`. In the same session,
`getBoundingClientRect()` puts the masthead at viewport x 256 to 349 and the lead at 161 to 224,
inside the frame, and `innerText` returns 367 characters. `screenshot({ fullPage: true })` on the same
page returns 129,976 bytes with every column present and correct, and the container renders the
Japanese properly (the image carries IPAGothic and IPAPGothic; no tofu).

**Mechanism, measured rather than assumed.** For a `vertical-rl` document that overflows leftward the
scroll range is negative: `document.scrollingElement.scrollLeft` reads 0 at the start of the text and
cannot be set higher (assignments of 333, 666 and 1041 all read back 0). The viewport screenshot does
not correspond to the layout viewport: at 768 the capture is a band shifted left of what the viewport
shows, so the masthead and lead are missing and the contents are cropped in; at 1280, where the
document does not overflow, the capture is correct. `clip: { x: -666 }` is rejected as "outside the
resulting image" while `clip: { x: 0 }` returns the same blank 2541 bytes, so the blankness is in the
viewport image itself and not in how it was cropped afterwards.

This is the shape recorded as instance 10: an external tool accepting a request it does not honour
the way the caller assumes. The design note states that "every capture is one viewport, at the top of
the page". For this page that is false, in a direction nobody would look for.

Related, and worth a separate look by whoever owns the DOM findings: the same page overflows
horizontally by design, `scrollWidth` 1041 against `clientWidth` 375. The existing `horizontal_overflow`
finding tests `document.body.scrollWidth > body.clientWidth + 1`. I measured the scrolling element
rather than `body`, so treat that as indicative rather than measured, but any vertical setting will
be near it.

---

## 4. The boundary cases: the must-not-fire clause decided by degree

### 4.1 Case 02, image led, and the image is nearly flat

A photographer's page for a series of long exposure sea studies. Opening plate full bleed, no type,
which is how the series hangs in a room. Two further plates with place, date and exposure, a method
note, a colophon. The images are real files served from the same origin.

`VIS-F-EMPTY-FRAME` must not fire on "a full bleed image or video with no text over it". Measured at
375x812: 296,823 bytes, luminance stddev 31.59, 101 distinct colours. A careful reading answers no,
and I answered no. It is in the set because the answer is a judgement of degree: the frame is one
horizon line and two large areas of even middle grey, and the entire photographic tradition it
belongs to is built out of near-flatness. The gate's safest entry has a must-not-fire clause whose
boundary is "how much tonal separation counts as an image".

### 4.2 Case 07, the placeholder tile is the product

A lime paint maker's colour chart. Eight colours, each a flat film of the actual paint inside a
hairline that is the edge of the sample, with name, behaviour in daylight, use and range number.
1396 characters.

The first swatch is `#8a8d8b`: measured at 375x812 as top=368, bottom=527, fully in frame, containing
zero characters. That is, pixel for pixel, `VIS-F-PLACEHOLDER-MEDIA`'s named trigger, "a uniform grey
tile", and simultaneously `VIS-F-EMPTY-REGION`'s "a drawn container whose interior is empty". The
clause that saves it is "a solid colour block used compositionally". **The distinction between a
compositional colour block and a placeholder tile is not in the pixels. It is in knowing what the
page sells.** The entry is shadow locked because no fixture contains an image; this is what the
calibration set will look like when one does.

---

## 5. The honest negatives, including one case killed by measurement

### 5.1 Case 04, one sentence is the whole content

The page a small ferry keeps so a reader can find out in one glance whether the boat is running.
Answer, time checked, the condition that changes it, a phone number that dials. 224 characters, a
great deal of empty space, and the accent carries a 7:1 contrast ratio.

Measured at 375x812: 28,940 bytes, stddev 26.35, 1269 colours. Adjudicated no, no and no. **The
entries tolerate exactly what they say they tolerate.** This case is also the one that a whitespace
metric, an ink coverage ratio or any character floor would kill instantly, which is the family the
design note rejects outright in its section 6, and this is the artefact that shows why.

### 5.2 Case 08, plates that are meant to be almost black

Four night photographs in a contact sheet, hairline round each print, caption outside the print. 1030
characters. Built to trip `VIS-F-EMPTY-REGION` through "a card or panel whose interior is empty".
Measured at 375x812: 245,479 bytes, stddev 115.06. It does not trip: the plates retain visible
structure in the shadows and read as photographs. The case marks the boundary rather than crossing
it. A series printed one stop lower would sit on the other side of it and nothing in the enumerated
wording says where the line is.

### 5.3 Case 05, killed: a blocked webfont does not hide the text

Built to test whether a page whose `@font-face` `src` points at a CDN, with no `font-display`
declared (so `auto`, which in Chromium means a block period), would paint no glyphs inside the
container's 750ms settle. If it did, `innerText` would return 631 characters against a frame with no
text in it, which is `VIS-F-EMPTY-REGION`'s advertised unique catch.

**Measured false.** When the request fails fast, which is what a container with no network interface
produces, Chromium abandons the block period and paints the fallback immediately. Sealed image,
375x812: 42,958 bytes, stddev 48.10, 1555 colours, all text visible. The failure mode needs a network
that black holes packets rather than refusing them, and that is not this container's policy. Reported
rather than deleted: a case that was expected to fire and does not is evidence about the gate being
safer than feared, and suppressing it is this project's signature defect in reverse.

---

## 6. Negative controls, executed in this session

Every claim above is paired with a control that moves the measurement in the opposite direction. All
numbers are from the sealed image.

**Control on the adjudication procedure, positive direction.** `blank-page` at 375x812: 2541 bytes,
stddev 0.000, one colour, `innerText` 0. Adjudicated against `VIS-F-EMPTY-FRAME`: **yes**. The
procedure can say yes on the artefact the design note intends it to catch, so a "no" elsewhere means
something.

**Control on the adjudication procedure, negative direction.** Cases 04 and 08 adjudicated **no** on
all three entries. A control set in which every case fires is a set chosen to fire.

**Control A, case 01: break and restore.** `_control-01-fold-restored` is case 01 with the hero
returned to an ordinary height. One CSS declaration changes; the DOM, the copy and the 1072-character
`innerText` are identical.

| at 375x812 | section heading | first item it introduces | bytes | verdict |
|---|---|---|---|---|
| case 01 (RED) | top=724 bottom=762, in frame | **top=818, below the fold** | 41,184 | heading over nothing |
| control (GREEN) | top=510 bottom=547, in frame | top=603 bottom=710, **in frame** | 61,138 | heading over its content |

The finding is produced by where the crop landed, not by anything about the page.

**Control B, case 06: break and restore.** `_control-06-horizontal` is case 06 with
`writing-mode: horizontal-tb` on the root and nothing else changed.

| at 375x812 | bytes | luminance stddev | distinct colours | innerText |
|---|---|---|---|---|
| case 06, vertical (RED) | 2541 | 0.001 | 1 | 367 |
| control, horizontal (GREEN) | 36,576 | 25.715 | 1537 | 367 |

Same DOM, same text, same fonts, same container. The blank capture is produced by the writing mode
meeting the capture, not by the content.

---

## 7. What this means for the gate, and the cheapest fix that keeps its true positives

**7.1 `VIS-F-EMPTY-FRAME` must not gate on the pixels alone.** Two of eight correct builds produce a
single-colour capture, both for environmental reasons invisible to a reader of the image. The fix is
not to drop the entry. It is to require **DOM corroboration from data the scorer already collects**:
admit an empty-frame finding only when, for that flow and breakpoint,

- `document.body.innerText.trim().length === 0`, **and**
- no `sealed_network_request_blocked` was recorded for that flow.

Checked against every artefact measured here: `blank-page` and `reward-hacked` have `innerText` 0 and
no blocked host, so both still fire. Case 03 has 928 characters and a blocked host, so it does not.
Case 06 has 367 characters, so it does not. **The conjunction is strictly stronger than either half**
and so is not the subset shape rule 4 rejects: `innerText === 0` alone would fail a legitimately
image-only page, and the pixel test alone fails cases 03 and 06. Neither half is sufficient; together
they separate every artefact in this set correctly.

**7.2 `VIS-F-EMPTY-REGION` cannot gate while the capture is a viewport crop.** Section 2 is the whole
argument: the correct page and the note's own hollow fixture differ by eleven bytes and zero on the
pixel statistic. If the entry is to gate later, it needs the same treatment: refuse the finding
unless the region's own geometry says the region is fully inside the frame, measured in the page and
carried alongside the capture. That is a change to what the scorer records, not to what a model is
asked, and until it exists the entry should stay at QUALITY rather than shadow-locked FUNCTIONAL,
because shadow mode measures agreement between a model and an unanswerable question.

**7.3 `VIS-F-PLACEHOLDER-MEDIA` needs a ticket, not a better prompt.** Case 07 shows the trigger and
the must-not-fire clause resolving to the same pixels. Any wording that fires on a grey tile fires on
a grey paint swatch. The only separator is what the page is for, which the capture does not carry.

**7.4 Against the implementation as it landed.** `dashboard/server/src/visual-substance.ts` (commits
`dbabfc8`, `d796a71`) carries the three entries as a const, defaults to
`DEFAULT_VISUAL_SUBSTANCE_MODE = "shadow"`, and locks two of the three with `shadowLocked: true`.
`VIS-F-EMPTY-FRAME` carries `shadowLocked: false`, which means it is the one entry that becomes live
the moment a run is started in `"gating"` mode. There is no corroboration on it: the model's answer to
the question is the finding. Cases 03 and 06 are therefore live false fails against the code as
committed, not against a hypothetical version of it, and the blind run's disjointness result
("EMPTY-FRAME fires on `blank-page` only") holds only over the seven fixtures. Section 7.1 is the
change I would make before the flag is ever set to `"gating"`, and it can be made without touching
the model's question, because both facts it needs are already in the scorer's output.

**7.5 The flip condition should add a second clause.** The design note is right that a gate firing on
nothing sorts all seven fixtures correctly. It is also true that a gate sorting all seven correctly
can fail correct work that is not in the seven. The condition should be: **sorts all seven, and fires
on none of the false-fail set.** As measured today the set costs one command to run and the current
enumerated wording fails it three times.

---

## 8. What is not verified

- **The adjudications are mine, made by reading each capture and answering the questions quoted from
  section 4 of the design note.** They are one model's answers on one run, not a distribution. I had
  seen several of these pages rendered before adjudicating their captures, so my "no" answers on
  cases 02 and 08 are less blind than the "yes" answers, which were produced by looking at a frame
  that turned out to be a flat field. Shadow mode is what turns this into a rate.
- **The set was not run through the real scorer**, only through a faithful reproduction of its phase 4
  inside its own image. No `plan.json`, no manifest, no acceptance suite, no verdict computation. The
  claim "the run would fail" is an inference from `verdict.ts:210`, which the design note quotes and I
  did not re-execute.
- **Case 02 and case 08 are boundary cases by construction**, and a different generation seed would
  put either on the other side of the line. They are evidence that the line exists, not measurements
  of where it is.
- **No fix in section 7 has been implemented or tested.** The corroboration rule was checked by hand
  against the twelve artefacts measured here and against the seven fixtures; it has not been written
  into code by me.
- **No screenshot taken for this note is versioned, referenced by filename, or written anywhere but
  the session scratchpad.**
