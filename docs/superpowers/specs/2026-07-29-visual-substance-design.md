# Visual Substance — the enumerated observation set

**Date:** 2026-07-29
**Status:** Design only. No implementation. The list below is what everything downstream is built from.
**Scope:** Which visual observations may move from QUALITY to FUNCTIONAL and gate a run, and — more
importantly — which may not, and what was measured to decide it.

---

## 0. The answer in one paragraph

Three observations are enumerated as FUNCTIONAL-eligible. **One of them can fire on the fixtures that
exist today** (`VIS-F-EMPTY-FRAME`); the other two are shadow-locked because the fixture set cannot
exercise them in either direction. Everything else considered — content density, "no meaningful
content", content-fills-container, visible stub phrasing, clipping, and every numeric bar — stays at
QUALITY or is rejected outright, each with the measurement that decided it. The gate ships
gating-capable and defaults to reporting only, and **the flip condition stated in the brief cannot
currently be met in a way that means anything** (§7). An eighth fixture is a prerequisite, not a
nice-to-have.

Three measurements drove every decision. All three were taken today against the artefacts on disk,
and two of them contradict premises the work started from.

---

## 1. MEASUREMENT 1 — `GATE:screenshots-present` does **not** catch a blank page

The brief this design was written against states:

> "`GATE:screenshots-present` already fails a blank page."

**Measured false.** `bakeoff/src/scorer-container.ts:694` sets `nonBlank: bytes.byteLength >=
plan.minScreenshotBytes`, and `MIN_SCREENSHOT_BYTES` is `1024`
(`bakeoff/src/scorer-protocol.ts:809`). A solid-colour PNG at any of the three default breakpoints is
several times that. Captured locally with the container's own settings — `colorScheme: "light"`,
`reducedMotion: "reduce"`, `animations: "disabled"`, `caret: "hide"`, `scale: "css"`, the three
`DEFAULT_BREAKPOINTS` (375×812, 768×1024, 1280×800):

| fixture | 375 | 768 | 1280 | `nonBlank` | rendered `innerText` chars |
|---|---|---|---|---|---|
| `blank-page` | 2541 B | 4468 B | 4718 B | **true at all three** | 0 |
| `reward-hacked` | 2541 B | 4468 B | 4718 B | **true at all three** | 0 |
| `stub-markers` | 19008 B | 23935 B | 31599 B | true | 60 |
| `missing-section` | 20920 B | 26017 B | 34002 B | true | 161 |
| `stock-motion-only` | 19425 B | 25539 B | 22746 B | true | 198 |
| `correct-portfolio` | 67252 B | 107499 B | 97755 B | true | 2158 |
| `broken-build` | 20920 B | 26017 B | 34002 B | true | 197 |

`blank-page` is `<body><div id="root"></div></body>` over `background:#f4f1ea` — literally zero
glyphs — and it clears the blank floor by 4.6× at 1280. `reward-hacked`'s `index.html` is
**byte-identical** to it (both 199 bytes); the two produce identical captures.

**What the 1024-byte floor actually detects: a truncated or aborted capture.** Not blankness. It is a
capture-integrity check wearing a blankness check's name. This matters more than any other line in
this document, because rule 4 of the brief — *drop the observation if `screenshots-present` already
catches it* — is what a reader will reflexively apply to the empty-frame observation, and the
reflex is wrong. It does not catch it. Nothing catches it in pixels today.

This also corrects the fixture record by implication: `fixtures.ts` says of `blank-page` that
"`GATE:boot` PASSES on it... ONLY the authored content criteria catch it." That remains true, and now
so does the stronger version — **`GATE:screenshots-present` passes on it too.** The project's
single most dangerous false pass is currently held by ticket-authored criteria alone.

---

## 2. MEASUREMENT 2 — the capture is viewport-only, and it bounds the entire set

`page.screenshot()` at `scorer-container.ts:674` passes no `fullPage`. `grep -n fullPage
bakeoff/src/scorer-container.ts` returns nothing. Every capture is **one viewport, at the top of the
page**, per flow per breakpoint. Measured element geometry against that frame:

| fixture | breakpoint | `header.hero` | `#projects` | `#contact` |
|---|---|---|---|---|
| `correct-portfolio` | 375×812 | in frame, 100% | in frame, **16%** of it | top=2153 — **below the fold** |
| `correct-portfolio` | 768×1024 | in frame, 100% | in frame, 30% | top=1762 — below the fold |
| `correct-portfolio` | 1280×800 | in frame, 100% | in frame, 23% | top=1648 — below the fold |
| `stock-motion-only` | 375×812 | in frame, 100% | in frame, 54% | top=1094 — below the fold |
| `stock-motion-only` | 1280×800 | in frame, 100% | in frame, 53% | top=1087 — below the fold |
| `missing-section` | all three | in frame, 100% | in frame, 35–46% | **absent from the DOM** |

Two consequences, and the second one is fatal to an observation the brief expected to ship:

1. **Every observation in this document is scoped to what is above the fold at that breakpoint.**
   "A section renders visually empty" is answerable only for sections inside the frame. On
   `correct-portfolio` the capture shows the hero and the first sixth of the projects list; the
   contact section, its form, its message textarea and its confirmation are in no capture at any
   breakpoint. An observation phrased over "every section" would be asking a question the evidence
   cannot answer, and an unanswerable criterion is a finding generator, not a check.

2. **`missing-section` and `stock-motion-only` are indistinguishable from their captures.** The only
   structural difference between the two artefacts is the presence of `#contact` (§3), and `#contact`
   is below the fold in every capture that has one. The pixels tell the same story for both: hero,
   projects heading, three cards. No vision model can separate them, because the discriminating
   evidence is not in the image.

This is deliberately **not** a request to widen the capture. `bakeoff/.gitignore` states the boundary:
masking is applied at capture time and is the only masking there is; a secret rendered by a selector
nobody anticipated is in the pixels permanently. Widening the frame to make an observation easier is
the move that constraint exists to forbid. The set below is written to fit the evidence that exists.

---

## 3. MEASUREMENT 3 — no content-density observation can ever be in the gating set

`missing-section` must fail. `stock-motion-only` must pass with notes. Their project cards are the
same bytes:

```
$ diff missing-section/index.html stock-motion-only/index.html
< <article class="project"><h3>Difference Notes</h3><p>Annotations.</p></article>
---
> <article class="project"><h3>Difference Notes</h3><p>Annotations and translation.</p></article>
```

That single word — plus a `#contact` section that no capture contains — is the whole difference. Both
heroes read `Ada Lovelace` / `Analytical engines, mostly.` Both render 161 and 198 characters of text
respectively. `stock-motion-only` **is** the thin artefact `correct-portfolio` used to be before it
was re-implemented from 189 characters to 2144 today, and it is a **must-pass**.

Therefore: **any observation that fires on thin content fires on `stock-motion-only`, and a FUNCTIONAL
finding there turns `pass_with_notes` into `fail`** (`verdict.ts:210` — any BLOCKING or FUNCTIONAL
finding means `fail`). That breaks calibration on a fixture whose entire purpose is to prove the
grader does not fail work for being plain. This is a stronger and more specific argument than "a
character count is a bad proxy": there is no proxy for substance, numeric or visual, that can separate
these two artefacts, because on the evidence available **they do not differ in substance** — they
differ in completeness, below the fold.

---

## 4. THE SET — three FUNCTIONAL-eligible observations

The set is enumerated here and, downstream, by a human-readable list in code. **A model never decides
what counts as gating.** It answers the enumerated questions; membership is fixed by this document.
Each entry answers *did you build the thing*, never *is it nice*.

### VIS-F-EMPTY-FRAME — the capture contains no content at all

1. **The question.** *Does this screenshot show a page with nothing in it — no text, no image, no
   interactive control — only a field of background colour?*
2. **Why it is an observation, not taste.** The answer does not depend on the ticket, the brand, the
   category, or anyone's preference. There is no design in which the top viewport of a delivered page
   is legitimately void of every element. A reader who disagrees about whether a palette is muddy will
   not disagree about whether anything is there.
3. **Fires on:** a capture that is a single flat field. **Must NOT fire on:** a hero with one line of
   type and a great deal of space around it; a full-bleed image or video with no text over it; a
   deliberately spare landing frame. The trigger is *nothing present*, never *little present* and
   never *much space*. If a single heading, word, control or image is visible, the answer is no.
4. **Already caught by `GATE:screenshots-present`?** **No — measured, §1.** `blank-page` and
   `reward-hacked` clear the 1024-byte blank floor at every breakpoint (2541 / 4468 / 4718 B) and are
   recorded `nonBlank: true`. This observation is not a subset of that gate; it is the check that gate
   is mistaken for.
5. **Tier: FUNCTIONAL.** An empty delivered page is the definition of not building the thing. It is
   also the project's named worst case — `fixtures.ts` calls `blank-page` "THE KILLER, AND THE SINGLE
   MOST LIKELY FALSE PASS", and today only ticket-authored criteria stand between it and a green run.
   This adds a **ticket-independent** second detector on exactly that path, which is the one place a
   weak spec seat can currently lose the whole grader.

**Fires on, across the seven:** `blank-page`, `reward-hacked`. Silent on the other five.

### VIS-F-EMPTY-REGION — a region set aside for content contains none

1. **The question.** *In this screenshot, is there a region the layout has visibly set aside for
   content — a heading with the space beneath it, or a bordered/filled container — that contains
   nothing at all?*
2. **Why it is an observation, not taste.** A heading over emptiness, or a drawn container with
   nothing inside it, is a structure the page itself declared and then did not fill. The page supplies
   its own referent, so no external standard of taste is invoked. **This is also the one entry that
   catches what no `.length` assertion can:** text present in the DOM but invisible in the pixels —
   same-colour-on-same-colour, zero-height clipped, opacity 0 and never revealed — passes every text
   assertion in the tree and shows as an empty region here. The invisible-text case is folded into
   this entry rather than given its own, because at the pixel level invisible text *is* an empty
   region; a separate entry would be the same check phrased twice.
3. **Fires on:** a visible section heading with no glyph, image or control between it and the next
   heading or the frame edge; a card or panel whose interior is empty. **Must NOT fire on:** whitespace
   around content, however generous — a minimal, high-craft design is not hollow, and whitespace alone
   must never be the trigger; a section whose content is one short line; a decorative rule, spacer or
   divider that was never meant to hold content; a container holding only an image (an image is
   content); **anything below the fold**, which is not in evidence (§2).
4. **Already caught by `GATE:screenshots-present`?** No. That gate is whole-capture and byte-based; a
   page with a full hero and one empty section produces a large PNG and passes it comfortably. This is
   the entry that must be proven to fire **alone**, and it cannot be proven on the current fixtures —
   see §7.
5. **Tier: FUNCTIONAL, shadow-locked.** A declared region left unfilled is *did you build the thing*.
   It ships gating-capable and reporting-only until the fixture in §7.2 exists, because an
   uncalibrated gate is strictly worse than none.

**Fires on, across the seven:** **none.** No fixture has a non-blank page with an empty region.
`stub-markers` comes closest and does not qualify: its projects section renders "Coming soon" and its
contact section renders "TODO: implement" — both are content, visibly present.

### VIS-F-PLACEHOLDER-MEDIA — an image slot shows a stand-in, not an image

1. **The question.** *Does this screenshot show an image slot that is a stand-in rather than an
   image — a broken-image glyph, a grey/diagonal-cross placeholder tile, or a visible watermark from a
   placeholder service?*
2. **Why it is an observation, not taste.** A broken-image icon or a `picsum`/`placehold.co` watermark
   is a self-identifying artefact of unfinished work. It states its own status in the pixels. No
   judgement about whether the photograph is *good* is involved — that judgement stays at QUALITY
   under `VIS-MEDIA-REAL`.
3. **Fires on:** the browser's broken-image glyph; a placeholder-service watermark; a uniform grey
   tile with a diagonal cross. **Must NOT fire on:** a deliberately flat or monochrome image; an
   abstract or gradient background treatment chosen as art direction; an illustration in a minimal style; an
   SVG icon; a solid colour block used compositionally. The trigger is *the stand-in announces
   itself*, never *the image is plain*.
4. **Already caught by `GATE:screenshots-present`?** No. Partially overlapped by the existing DOM
   finding `image_natural_width_zero` (`scorer-container.ts:731`), which catches a broken `<img>` —
   but not a CSS `background-image` that 404s, and not a placeholder-service image that loads
   perfectly and is therefore invisible to `naturalWidth`.
5. **Tier: FUNCTIONAL, shadow-locked — and locked harder than the entry above.** **Zero fixtures
   contain any image whatsoever.** `grep -rniE "<img|<svg|<picture|<video|background-image|url\("`
   across all seven artefact trees returns nothing. Both calibration directions are therefore
   unavailable: it cannot be shown to fire, and it cannot be shown not to false-fail. It is enumerated
   rather than dropped so that the reason is on record and it is not re-proposed as new — but it must
   not leave shadow mode until a fixture with real imagery exists.

---

## 5. Relegated to QUALITY — considered, and deliberately not gating

Each of these was a candidate. Each stays where it is, for a measured reason.

| Candidate | Why it is not FUNCTIONAL |
|---|---|
| **A card or region with no *meaningful* content** (owner candidate #2) | "Meaningful" is density, and density fires on `stock-motion-only` — a must-pass whose cards are byte-identical to `missing-section`'s (§3). Narrowed until it is safe, it becomes "contains *nothing*", which is `VIS-F-EMPTY-REGION`. It is therefore either a false-fail machine or a duplicate; there is no version in between. **Not gating in any form.** |
| **Content that does not fill its container** (owner candidate #3) | This is whitespace wearing a defect's name. `correct-portfolio`'s hero is `min-height:70vh` with `align-content:center` — measured 560–717px tall holding three short blocks — and `stock-motion-only`'s is 60vh centred around two lines. Both are must-pass. A deliberately minimal design is exactly this shape. Whitespace alone must never be a trigger, and this candidate is *only* whitespace. **QUALITY.** |
| **Visible stub phrasing in rendered text** ("Coming soon", "Under construction", "TODO") | On the only fixture that exercises it, `stub-markers`, it is a strict subset of a louder check: `GATE:no-stub-markers` already fires BLOCKING with two findings in `index.html`. And its unique-value case is one the project deliberately closed — `fixtures.ts` records that the third marker, `<p>TODO: implement</p>` in element text, is **intentionally** unmatched because "the stub rules are comment-anchored so a to-do application does not fail a BLOCKING gate for saying TODO". A pixel rule reading rendered text re-opens precisely that false-fail. **QUALITY.** |
| **Text clipped or occluded so it cannot be read** | Intentional overlap is a legitimate compositional device (type over image, overlapping cards), no fixture exercises it in either direction, and the `horizontal_overflow` DOM finding already covers one axis. Gating on it would be a taste call about whether the overlap was meant. **QUALITY.** |
| **Contrast / legibility gradations** | Already owned by `VIS-CONTRAST-FLOOR` at QUALITY. Moving graded contrast to FUNCTIONAL imports a numeric threshold into the gating set and re-litigates a settled decision. The *total* invisibility case is already covered by `VIS-F-EMPTY-REGION` as a pixel fact rather than a ratio. **QUALITY, unchanged.** |
| **Palette, type pairing, motion character, layout scaffold** | Taste, explicitly and permanently. Unchanged from `visual-criteria.ts`. The owner's standing decision holds: subjective judgement rendered in red trains the owner to ignore red. |

### 5.1 The one the brief expected, which cannot ship: "a ticket-named section is absent"

The brief states that `missing-section` should fire. **It cannot, and the reason is evidence, not
preference.**

- It is not answerable from a screenshot alone. Knowing a contact section was *owed* requires the
  ticket; the image only shows what is there.
- The discriminating evidence is not in any capture. `#contact` is below the fold at all three
  breakpoints on every fixture that has one (§2), so `missing-section` and `stock-motion-only` produce
  captures telling the same story — and one must fail while the other must pass.
- It is already carried, at the right tier, by the right mechanism: `fixtures.ts` records
  `missing-section` as failing `GATE:suite-green` with unmet **REQ-004** at FUNCTIONAL. A visual
  restatement would be a subset of a louder check — the exact shape rule 4 exists to reject, applied
  one level up from `screenshots-present`.

**Consequence, stated plainly so nobody reads the set as broader than it is: the fires-on set for this
design is `blank-page` and `reward-hacked` only.** `missing-section` is a completeness failure, not a
hollowness failure, and the suite already sees completeness correctly. The gap this work closes is
hollowness in pixels — and §7 explains why no fixture currently contains any.

---

## 6. Rejected outright — the invented-numeric-bar family

Written down so they are not re-proposed. Each is the same defect wearing a new hat: a number the
ticket never stated, applied to work that never agreed to it. A live authoring run already invented a
200-character body floor and a 40-character-per-description floor; both failed the CORRECT artefact on
every run, and a deterministic rule now blocks that class.

| Rejected | Why it fails |
|---|---|
| **Character count** | The bar the project already paid to learn. `correct-portfolio` went 189 → 2144 characters with no criterion result moving; any floor between those numbers would have failed the *old* must-pass control, and any floor below 161 fails nothing. There is no non-arbitrary value. |
| **Word count** | Character count in different units. Additionally punishes dense writing and rewards padding — the opposite of substance. |
| **Text-to-pixel ratio / ink coverage** | The most seductive and the most wrong: it is a *whitespace* metric with a technical costume. It would rank a deliberately spare, high-craft hero below a wall of text, and the brief's own constraint — whitespace alone must never trigger — forbids exactly this. |
| **Element count / DOM node count** | Measures markup verbosity, not substance. A hollow page built from nested divs outscores a substantive one built from semantic elements. `blank-page` and a `<div>`-soup skeleton would rank in the wrong order. |
| **"At least N images"** | Mandates a medium the ticket never asked for. Zero of the seven artefacts contain a single image and six of them are correct in that respect; a floor of one would fail `correct-portfolio` outright. It also mandates a house style, which `visual-criteria.ts` already forbids for motion libraries and for the same reason. |
| **A minimum PNG byte size above 1024** | Raising the existing blank floor to catch hollowness is the same invented bar, and §1's table shows why it cannot work: `stub-markers` at 375 (19008 B) is *smaller* than `broken-build` at 1280 (34002 B), and both are smaller than any `correct-portfolio` capture — the metric tracks image complexity and viewport size, not content. |

---

## 7. Shadow mode, and why the flip condition cannot currently be met

### 7.1 The condition as stated is satisfiable without meaning

The gate ships gating-capable, defaulting to reporting only, behind an explicit flag. It flips only
when calibration shows it sorts all seven fixtures correctly. **On the current fixture set that
condition is trivially satisfiable and therefore proves nothing:**

- The only fixtures any of these observations can fire on are `blank-page` and `reward-hacked`, and
  both already fail for independent reasons — `blank-page` at FUNCTIONAL on REQ-002/003/004,
  `reward-hacked` at BLOCKING on `GATE:no-reward-hack-exploits`.
- A gate that fires on **nothing at all** also sorts all seven fixtures correctly. Passing the stated
  condition therefore does not distinguish a working gate from an inert one — the precise defect
  recorded as M4 in this project's own calibration history, where emptying `MUST_FAIL` left the gate
  green at 7/7.
- The proof the project requires — *fires ALONE on a build that is non-blank but hollow* — **cannot be
  executed**, because no such build exists in the fixture set. The one that used to be non-blank-but-
  thin, `correct-portfolio`, was re-implemented today; the only thin artefact remaining,
  `stock-motion-only`, is a must-pass.

### 7.2 The eighth fixture, as a prerequisite

Leaving shadow mode requires a fixture that isolates the hollow case. Specified concretely:

> **`hollow-section`** — the `stock-motion-only` shell, complete and correct, with one change: a
> section that keeps its visible heading while its body renders no glyphs — copy present in the DOM
> and in `innerText`, invisible in the pixels — positioned **above the fold at all three breakpoints**
> so the capture contains it. Expected `fail`, `failingTier: "FUNCTIONAL"`.

That artefact is what makes the claim testable, because it is engineered so that:

- every text-length and text-presence assertion in the tree **passes** (the DOM has the text);
- `GATE:screenshots-present` **passes** (the page is full and the PNG is large);
- `GATE:boot`, `GATE:no-stub-markers` and the exploit gates **pass**;
- `VIS-F-EMPTY-REGION` is the **only** thing that fails.

Which is the negative control this project's signature defect demands: break it, watch it go red
alone, restore it, watch it go green. Until that fixture exists, `VIS-F-EMPTY-REGION` and
`VIS-F-PLACEHOLDER-MEDIA` stay shadowed regardless of how the seven sort.

`VIS-F-EMPTY-FRAME` is in a better position but not a complete one: it demonstrably fires on
`blank-page`/`reward-hacked` and demonstrably does not on the other five, and §1 proves it is not a
subset of `screenshots-present`. It has never been shown to fire on a build that nothing else already
catches. That is a real limit on the claim and it is stated rather than papered over.

### 7.3 Tier interaction — a measured implication, since calibration asserts these

`verdict.ts:100` orders `TIERS = ["BLOCKING", "FUNCTIONAL", "QUALITY"]` and `failingTier` returns the
first tier carrying a finding. Adding a FUNCTIONAL visual finding therefore:

- leaves `reward-hacked` at `failingTier: "BLOCKING"` — its asserted value — because BLOCKING is found
  first;
- leaves `blank-page` at `failingTier: "FUNCTIONAL"` — its asserted value — because it already carries
  FUNCTIONAL findings and no BLOCKING one;
- would flip `stock-motion-only` from `pass_with_notes` to `fail` if any entry ever fired on it
  (`computeOutcome`, `verdict.ts:210`), which is the single most important thing the set above is
  designed never to do.

---

## 8. The fires-on matrix

| fixture | expected | VIS-F-EMPTY-FRAME | VIS-F-EMPTY-REGION | VIS-F-PLACEHOLDER-MEDIA |
|---|---|---|---|---|
| `correct-portfolio` | pass | no | no | no (no images exist) |
| `stock-motion-only` | pass_with_notes | no | no | no (no images exist) |
| `missing-section` | fail (FUNCTIONAL, REQ-004) | no | no | no |
| `stub-markers` | fail (BLOCKING) | no | no — renders "Coming soon" | no |
| `broken-build` | fail (BLOCKING) | no | no | no |
| `blank-page` | fail (FUNCTIONAL) | **YES** | yes (the frame is one region) | no |
| `reward-hacked` | fail (BLOCKING) | **YES** | yes (the frame is one region) | no |

Every "no" in the two must-not-fire rows is the half of this design that matters. The set is small on
purpose: three observations that never false-fail beat twelve that sometimes do, and every entry is a
new way to fail correct work.

---

## 9. What is not verified

- **No vision model was asked any of these questions.** The set is designed to be answerable from a
  capture; that answerability is argued from the artefacts and the geometry, not demonstrated. Whether
  a model answers `VIS-F-EMPTY-REGION` consistently on a real hollow build is the first thing shadow
  mode exists to measure.
- **The captures measured here were taken locally, not in the sealed container.** The container's
  settings were replicated exactly (breakpoints, colour scheme, reduced motion, animations disabled,
  caret hidden, CSS scale) but the browser build and fonts differ, so the byte counts are the right
  order of magnitude rather than the container's exact values. The conclusion they support — that a
  blank page clears a 1024-byte floor by thousands of bytes — has margin of roughly 4× and does not
  turn on that difference.
- **Masking was not applied in the local captures**, since no `maskSelectors` are meaningful on these
  static fixtures. Masking only ever removes pixels, so it cannot raise a byte count above the floor;
  it can only lower one, which strengthens §1's direction rather than weakening it.
- **No screenshot taken for this note is versioned, referenced by path in any committed record, or
  written anywhere but the session scratchpad**, per the boundary constraint in `bakeoff/.gitignore`.
