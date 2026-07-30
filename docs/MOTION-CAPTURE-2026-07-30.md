# Detecting animation on a site we are asked to copy — measured, not designed

Written against the real target, `https://kamilborzecki.dev`, on 2026-07-30, with
Playwright driving a real Chromium. Every number below came out of a probe, not a
guess. Probes kept at
`/private/tmp/.../scratchpad/motion-probe{,2,3}.mjs` (ephemeral — the technique is
reproduced here so it survives them).

---

## THE HEADLINE: THE OBVIOUS PROBE IS THE WRONG PROBE

`server/src/builders/antislop-rules.ts:659` states, in `decideMotion`'s docblock:

> the owner's own reference, kamilborzecki.dev, runs `document.getAnimations() === 0`
> with no GSAP, no Framer and no Lenis

**That measurement is correct.** I reproduced it: `document.getAnimations()` returns
`0` on load, after 2.5s idle, at six scroll positions, and under
`prefers-reduced-motion`. No GSAP, no ScrollTrigger, no Framer, no Lenis, no AOS,
no Lottie, no `<canvas>`, no SVG `<animate>`.

**And the site is full of motion.** Measured on the same page:

| # | What | Evidence |
|---|---|---|
| 1 | **Scroll-scrubbed video journey** | 2 `<video>`, 4.04s each. `currentTime` goes **0 → 4.032** as scroll goes 0 → 15%, while `paused` stays `true` at every sample. A paused video whose `currentTime` tracks scroll is scrubbing, by definition. |
| 2 | **Parallax float** | 5 × `.scroll-float`, computed transform sweeps `translateY(-42px)` → `translateY(+42px)` across the page. |
| 3 | **Modal entrance** | `@keyframes md-fade` on `.md-scrim` (0.16s ease) and `md-rise` on `.md-panel` (0.18s `cubic-bezier(.22,1,.36,1)`). Never running on load — they fire when a modal opens. |
| 4 | **Interaction transitions** | **11 distinct signatures over ~59 elements**: `transform .22s ease` ×15, `color,border-color,background .16s` ×10, `transform .18s ease` ×4, `transform .09s linear` ×5, `background .22s ease` ×5… |
| 5 | **A real reduced-motion strategy** | `*,::before,::after { transition-duration:.01ms!important; animation:none!important }`, `.scroll-journey__stage{display:none}`, and chapters fall back to static `leg-1-poster.webp` / `leg-2-poster.webp`. |

So a capture that asks `getAnimations()` and stops would report **"this site has no
animation"** about a site with a scroll-scrubbed film, a parallax layer, and 59
transitioning elements. It would then hand the builder a brief to copy a static page.

**Why it fails is structural, not a bug:** `getAnimations()` returns animations
*running at the instant you ask*. Entrance animations have already finished. Hover
transitions have not started. Scroll-scrubbing never creates an `Animation` object at
all — it assigns `currentTime` and inline transforms directly. The one thing the API
is blind to is precisely the thing this site is built out of.

---

## THE SIX MECHANISMS, AND WHAT EACH ONE CANNOT SEE

No single probe is sufficient. Each line names its own blind spot, because a probe
whose limits are undocumented gets trusted past them.

1. **`document.getAnimations()`** — running CSS animations, CSS transitions, and
   WAAPI (`element.animate()`, which Framer Motion uses underneath).
   *Blind to:* anything not animating at the sampled instant, and all rAF/scrub work.
2. **`@keyframes` inventory + the rules that use them** — walk `document.styleSheets`
   for `CSSRule.KEYFRAMES_RULE`, then for `STYLE_RULE`s whose `animationName` is set.
   Gives name, selector, duration, easing, fill — *whether or not it is running*.
   This is what found `md-fade`/`md-rise`. *Blind to:* cross-origin sheets (guard
   `sheet.cssRules` in try/catch), and JS-injected styles.
3. **Computed `transition-*` census** — walk the DOM, bucket
   `transitionProperty/Duration/TimingFunction`. This is what found the 11 signatures.
   *Blind to:* whether any of them ever actually fire.
4. **Library fingerprint** — `window.gsap`, `window.ScrollTrigger`, `window.Lenis`,
   `[data-framer-name]`, `[data-aos]`, `lottie-player`, `<canvas>`, `<animate>`.
   Tells you the *system* even when individual tweens are unreadable.
   *Blind to:* bespoke rAF code, which is exactly what this site uses.
5. **Scroll-position sampling — THE ONE THAT FOUND THE JOURNEY.** Step scroll through
   the page and, at each stop, record `video.currentTime`/`paused`, computed
   transforms of candidate elements, and opacity. A paused video whose `currentTime`
   advances is scrubbing; a transform that tracks scroll is parallax. *Blind to:*
   nothing much — this is the catch-all, and it is the one worth paying for.
6. **`prefers-reduced-motion` differential** — load twice, once with the media feature
   emulated. The diff *is* the motion inventory, stated by the author. On this site
   the reduced-motion block alone named `.scroll-journey`, `.scroll-float`,
   `.md-scrim` and `.md-panel` — every mechanism above, without running anything.
   **Cheapest high-yield probe of the six.** *Blind to:* sites with no such block.

Also worth capturing because they are hostile to a screenshot: `<video>` attributes
(`autoplay`/`loop`/`muted`/`playsInline`/`paused`) — the combination
`muted + playsInline + !autoplay + paused` is the scroll-scrub fingerprint, and it is
how #1 was recognised before the scroll sampling confirmed it.

---

## WHY THIS IS GRADEABLE AT ALL, WHICH IS THE PART THAT USUALLY BREAKS

The gate runs `docker run --network none`. It can never fetch the original. But it
does run a real Chromium against the **built** artefact — `scorer-container.ts:678`
already drives `page.screenshot(...)`.

So the inventory above is capturable at **ticket time on the host, where the network
exists**, frozen as a durable artefact, and then re-derived from the built site by the
**same six probes offline**. Both sides are introspected identically, so the
comparison is real rather than a vibe. Nothing needs to give the gate a network.

**One thing must change for this to work.** `scorer-container.ts:678` passes
`animations: "disabled"` to every screenshot — deliberately, for deterministic pixels.
That is right for layout diffing and fatal for motion grading: it freezes the exact
thing under test. Motion evidence has to come from the DOM/scroll probes above, or
from a separate capture pass that does not disable animation. **Do not simply turn
that flag off** — the existing screenshots depend on it being on.

---

## THE TRAP IN `decideMotion`, WHICH THIS ALSO CLEARS UP

`decideMotion` (`antislop-rules.ts:673`) requires a build to carry one authored motion
moment, satisfied by any of: scroll-scrubbed video, a GSAP/ScrollTrigger timeline,
rAF-driven scrubbing, or a Framer `useScroll`/`useTransform` drive.

It is gated on `DASHBOARD_MOTION_BAR=1` and is **off by default**.

The measurement above says the reference site **satisfies satisfier #1** — it is a
scroll-scrubbed video journey. The docblock's argument (do not mandate a library) is
right, but its evidence reads as though the site were motion-less. It is not; it is
motion-rich by a mechanism `getAnimations()` cannot see. Worth correcting in place so
the next reader does not build the wrong probe from it.

**Open, and a real conflict to settle before it bites:** a faithful copy of a
*genuinely* static site would fail the motion bar if it were ever switched on, because
the bar asks for authored motion the original does not have. "Copy this site" and
"every build must have a motion moment" are different instructions. Today it is off,
so nothing breaks — but turning it on without resolving that will fail correct work.
