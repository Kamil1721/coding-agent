---
document_status: findings
verified_at_commit: 602121a
verified_on: 2026-09-09
subject: why an external scaffold's pages read less templated than ours
external_source: github.com/higgsfield-ai/skills, higgsfield-websites/ (13,261 lines)
artifact_under_study: run-cont-e22fa17f9b7972c79641
---

# The rules are ours already. They grade the blueprint, not the building.

The owner asked on 2026-09-09 why Higgsfield's chat produces web pages that look far less
generic than this pipeline's, and pointed at `higgsfield-ai/skills` and at
`kamilborzecki.dev`, a site that product generated for him with no human design pass.

Method: six readers over the external skill, four over our own pixel path at `602121a`, one
rendered-artifact retrieval, one synthesis, three adversarial refuters per candidate
difference. Four differences survived, two were refuted. Every number below was re-measured
by the session author against the files named; nothing here is relayed from the agents.

## The finding, in one line

We already implement their craft floor. Every one of our checks validates the contract JSON;
none reads the page that shipped. The delivered page therefore violated rules our own code
encodes, and passed.

## The measured instance

`run-cont-e22fa17f9b7972c79641`. `workspace/design-refs/direction.md:9` is unambiguous, and
numbered:

> **Eyebrows: exactly ONE on the whole page.** The contract sets `eyebrow: null` on every
> section except `services`, whose eyebrow is the literal string **"Engagements"**. […]
> **Do not build those four.** Ship one eyebrow — "Engagements" on services — and drop the
> hero, work and standard meta labels entirely.

Six divergences between what was decided and what shipped:

| Decided | Shipped | Where measured |
|---|---|---|
| 1 eyebrow | **3** (`Design and build`, `Services`, `The standard`) | `index.html:32`, `:49`, `:113` |
| eyebrow string `Engagements` | `Services` | `grep -c Engagements index.html` → `0` |
| headline `Websites and apps designed and built by one person who ships them` | `Websites and apps, designed and built by Kamil Borzecki` | `creative-contract.json` §hero vs `index.html:33` |
| section `positioning` (`editorial_manifesto`) | absent | contract ids vs `data-creative-section` in DOM |
| — | `s.standard`, not in the contract | same |
| ids `hero`, `nav`, … | `s.hero`, `s.nav`, … | same (the known namespace drift) |

Zero were caught.

## Why zero were caught

`dashboard/server/src/creative-contract.ts:1150-1170` already carries the external craft
floor almost item for item:

| Ours | Theirs (`references/design-recipe.md`, `references/review-rubric.md`) |
|---|---|
| `EYEBROW_LIMIT`, `> Math.ceil(routeSections.length / 3)` (`:1157`) | rubric item 4, the identical formula |
| `EYEBROW_SPACING` (`:1158`), `EYEBROW_NUMBERED` (`:1159`) | eyebrow ration, no section numbering |
| `LAYOUT_FAMILY_REPEATED` (`:1162`) | each layout family at most once per page |
| `LAYOUT_FAMILY_COVERAGE`, 8 sections → ≥4 families (`:1163`) | ≥4 families for 6+ sections |
| `ZIGZAG_LIMIT`, ≤2 consecutive splits (`:1167`) | max 2 consecutive image/text zigzags |
| `HERO_HEADLINE_TOO_LONG`, ≤2 authored lines (`:1150`) | headline max 2 lines desktop |
| `HERO_BODY_TOO_LONG`, ≤20 words (`:1151`) | subtext max 20 words |
| `HERO_ACTION_LIMIT` + exactly one primary (`:1152-1153`) | 1 primary + max 1 secondary |
| `CENTERED_HERO` scoped exception (`:1154`) | anti-centre bias |
| `VISUAL_REQUIRED` (`:1170`) | the hero needs a real visual |

Every one raises `error(ctx, …)` against a JSON pointer (`/routes/N/sectionIds`). The
contract declared one eyebrow; the page rendered three. `EYEBROW_LIMIT` never saw the three.

**Correction, from Codex's measurement pass at `602121a` on 2026-09-09.** Two claims in this
document's first draft were wrong.

- The eyebrow *ration* is not violated. The delivered `index.html` carries eight
  `data-creative-section` markers, matching the contract's eight-section route, so
  `ceil(8 / 3) = 3` and three rendered eyebrows pass. The first draft's "`3 > 2`" counted six
  `<section class="sec">` elements on one side and the full route on the other. The real
  divergence is **contract 1 versus DOM 3**, which is a conformance failure, not a ration
  failure.
- The negative search was too strong. `creative-recovery.ts:386`
  `hasLegacyDeterministicMarkerConflict` does read `workspace/index.html` and does compare
  `data-creative-route` / `data-creative-section` / `data-motion-id` bindings against the
  contract (`:410-417`). It is an admission boolean for creative recovery, reachable only when
  `reviewStopReason === "critic_unavailable"`, and it produces no report and gates no build —
  but the accurate claim is narrower: **no check compares the built page to its contract on the
  path a normal run takes**, not that nothing reads the page.

A third first-draft claim, that these findings should ride the gate report's `domFindings`
seam, was also wrong and is corrected in the brief: `domFindings` is produced inside the sealed
scorer (`bakeoff/src/scorer-container.ts:727`) against a closed union
(`bakeoff/src/scorer-protocol.ts:1509-1517`), and the orchestrator only reads the archived
result.

The one structural DOM check we do own never ran. `creative-render.ts:41` exports
`CREATIVE_SECTION_ATTRIBUTE = "data-creative-section"`, and `render-manifest.ts` raises
`SECTION_NOT_FOUND` from it. On this run `results/creative-status.json` records
`renderManifestHash: null` and `reviewStopReason: "critic_unavailable"`. Even had it run,
`results/visual-gate.md:3` reads "MODE: SHADOW — every observation below was evaluated and
recorded, and NONE of them can fail this run."

## What the comparison does *not* support

- **Builder blindness is not the differentiator.** `references/website-flow.md` Phase 6:
  "Do NOT navigate to, screenshot, or run image analysis on the deployed site — the
  mechanical gate is the only verification." Their builder cannot see the page either. It
  compensates by designing in images first and by converting screenshot-catchable defects
  into greps (`opacity-0` + `whileInView`, pin-spacer dead bands, white-on-white CTAs,
  missing video posters). This contradicts cause 1 of
  [FINDINGS-2026-09-02](FINDINGS-2026-09-02-pipeline-vs-chat.md), which ranks blindness
  dominant.
- **Webfonts are not the differentiator.** `kamilborzecki.dev` declares
  `--font-display:"Barlow Condensed"` with zero `@font-face` and no font link, exactly as our
  page declares `"IBM Plex Sans"`. Both fall back. An earlier draft of this document claimed
  the opposite and was wrong.
- **We do have a craft floor.** A candidate finding asserting that our aesthetic fields have
  no readers was refuted at HEAD: the negative grep behind it was constructed so it could not
  find the consumers.
- **They do not transcribe final copy off the design image.** Refuted on scope; that governs
  their opt-out path, not their default.

## What is separately true and unfixed by the above

Our boards are good. `workspace/design-refs/dark-reel-01-hero.png` is a competent dark
editorial hero and the shipped hero largely matches it. The gap is not a missing design step.

We have no palette ban. Theirs names banned families by literal hex, including "the palette
family of your previous build in this chat". The clinic page the owner rejected
(`run-2026-09-04T15-54-06-323Z-131fd85f`) ships a cream ground, a default blue pill and zero
images; `VISUAL_REQUIRED` would fire on its DOM, the palette rule does not exist to fire.

Their app path (`--type app`) makes no taste decisions at all: `references/app-flow.md:9`
"There is no independent brand and no wow/marketing pipeline here", because the agent gets a
vendored design system and six app layouts shipped as real code
(`references/app-layouts.md:3`, "you do NOT invent app chrome"). One of the six, `shots.tsx`,
is a step-rail wizard, which is the clinic ticket's own shape.

## Carried forward

- `T27` and `T28` in [CODEX-BRIEF-wave2-dom-conformance.md](CODEX-BRIEF-wave2-dom-conformance.md).
- Palette bans and a cross-run identity ledger are not scheduled. They belong in
  [BACKLOG.md](BACKLOG.md) as `PALETTE-BAN-001` and `IDENTITY-LEDGER-001`.
