# HANDOVER — read this first

> **CURRENT SOURCE OF TRUTH — 2026-08-26:** start with
> **[`STATE.md`](STATE.md)**, then [CAPABILITIES.md](CAPABILITIES.md) and
> [BACKLOG.md](BACKLOG.md). This handover is retained for historical measurements and
> operational lessons; it is not the authority for the current commit, dirty tree,
> latest run outcome, or implementation status.

> **VERIFIED CODE BASELINE `56aa163`:** gate-only recovery is shipped and verified
> for a terminal-red path. Source `d728ab79` remains immutable **NO VERDICT** with
> `heldOutPass: null`; child `run-gate-recovery-5ffc96e73d39737f4b2bb197`
> completed a sealed result with `heldOutPass: false`, `falseFinish: true`, and
> Taste Critic explicitly `not-run`. The decisive failure is the builder's STATIC
> delivery-contract mismatch, not infrastructure. The next step is
> `ARTIFACT-BOOT-001`, followed by a normal full-pipeline run. Green recovery,
> crash/boot reconciliation, the Taste chain, and Enhancement Scout remain
> unproven. See the [recovery report](RUN-d728ab79-gate-recovery-2026-08-26.md).

> **HISTORICAL ROUTE, 2026-08-16; SUPERSEDED FOR CURRENT WORK.** This file is the map of the
> 2026-07-30 session and is kept for its measurements, not for its state — its
> test counts and its open list are both stale by two weeks. The live handoff is
> **[`HANDOFF-2026-08-16-repair-lane.md`](HANDOFF-2026-08-16-repair-lane.md)**.
> That dated handoff is also historical; use it only for measurements not repeated
> in the living documents above.


Written 2026-07-30 at the end of a three-day session. **Its job is to stop the next
session re-deriving what this one measured, and to stop it trusting what this one did not
verify.** Both STATUS files are longer and more precise; this is the map.

---

## 1. WHAT THIS IS

A dashboard that takes an English ticket, builds the software unattended, and grades the
result against an acceptance suite the builder never sees. The point is not the building —
it is that **the verdict can be trusted without re-reviewing the work**. If the grader can
be fooled, the tool saves nothing, because you would have to check everything anyway.
That is why the grader has had the most effort.

Two co-primary metrics, and neither is a score:

- **`heldOutPass`** — boolean. All BLOCKING + FUNCTIONAL criteria pass. QUALITY never
  gates. An empty criteria set is never a pass.
- **`falseFinish` = `agentDeclaredDone && !heldOutPass`** — the builder's self-report
  checked against a suite it could not read.

There is no numeric score anywhere and adding one would be a regression.

---

## 2. IT WORKS — one real ticket, end to end

`run-2026-07-29T23-28-46-665Z-3d4d1ccb`. A one-page bike-repair site, "Coglane". **1 h
44 m 53 s, every stage ran, none skipped.**

```
spec authored (2 attempts — the audit rejected the first) -> suite frozen, 13 criteria
  -> DESIGN lane, 5 images -> ui-designer locked 01-hero
  -> build, 2 segments, ONE session -> sealed gate --network=none
  -> heldOutPass: true, falseFinish: false, 20/21 tests
  -> verdict.md: PASSED WITH NOTES
```

**Three documented unknowns this run settled:**

1. **The two build segments genuinely resume one session** — four independent ways,
   including token totals that *sum* exactly rather than max, which is a check that could
   have shown the opposite.
2. **The dry run is green against a real installed image** — both pre-spend checklists had
   said no such run was recorded.
3. **The held-out half discriminated.** It caught a defect the builder did not know about
   — an empty booking submission still confirms "You're booked" — reproduced with a
   before/after control, and the code-reading judge found it independently.

**Two limits it was honest about:** no sealed read was attempted, so no enforcement layer
fired in this run (trust in the boundary is inherited from the removal proofs of
2026-07-29, not re-derived); and the visible acceptance half **cannot execute** on the
dashboard path, because the OS sandbox refuses `listen` on 127.0.0.1.

---

## 3. THE ONE THING TO INTERNALISE

**This repository's signature defect is a check that can only observe success.**
`dashboard/STATUS.md` §6 catalogues **seventeen instances** with mechanisms. Read the
table before writing any test. The shapes that recur:

| Shape | Example from this project |
|---|---|
| The name promises more than the code measures | `GATE:screenshots-present` says "non-blank screenshot"; `nonBlank` is `bytes >= 1024`, and a zero-glyph page clears it by 4.6x |
| A filename stands in for content | `countDesignPngs` counted `.png` suffixes; five empty files scored five, and the real stills were JPEG |
| The assertion and the production path were never connected | `auditSuite` never passed the `ticketBrief` its own docblock told it to pass |
| A check whose failure mode is a subset of a louder one | it can fail — but only when something else already went red |
| A fake is the only witness | every test passed a request body that returned two HTTP 400s on the first real call |

**The rule: every claim needs a negative control executed in the same session.** Break it,
`grep -a` to confirm the mutation landed, watch it go RED *for the reason you intended*,
restore, watch GREEN. **A test that survives its mutation is data — report it, never
quietly fix it.** Five of eight "fixes" in one wave were decoration when checked this way.

---

## 4. HARD-WON FACTS. Do not re-derive these.

- **`mktemp -d` on macOS ignores `TMPDIR`.** It behaves as `-t tmp` and builds from
  `_CS_DARWIN_USER_TEMP_DIR`. Under a workspace-only sandbox the bare form is denied, so
  `gemini-image.sh` died before its first request. Both scripts now use
  `mktemp -d "${TMPDIR:-/tmp}/…XXXXXXXX"`. **Never "simplify" that back.**
- **Veo 3.1 request body:** `image.bytesBase64Encoded` + `mimeType`, and `durationSeconds`
  as a **number**. `inlineData` is rejected; the string `"4"` is rejected. Settled by a
  live call, and the plan's "verified from Google's docs" body was wrong on both.
- **`durationSeconds: 4` + `720p` + an image is accepted.** The "8 s required for
  reference images" note attaches to `config.referenceImages`, a *different* field from
  `source.image`. Cost does not double.
- **`Options.agents` does not bind** for any name that exists on disk, so
  `AgentDefinition.skills` preloads nothing. Skill instructions must ride the Agent call's
  `prompt`.
- **`redactForPersistence` maps every 40+ char mixed-case-and-digit token to the same
  literal.** Node identity must never be built on a raw SDK id or two agents merge.
- **`test.use({ reducedMotion })` is not a top-level Playwright 1.62 option.** It belongs
  in `contextOptions`; the bare form emulates nothing while appearing to work. Two agents
  hit this on separate days.
- **The scorer image digest is held-constant variable 3 and has moved five times.**
  `dashboard/STATUS.md` has the dated chain. **Re-resolve it, never transcribe it** —
  `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'`.
- **Concurrent agents must never `git commit --amend`.** It commits the whole index and
  rewrites whichever sibling committed in the gap; explicit `git add` paths do not protect
  you. Happened twice.
- **`grep` silently skips a file containing NUL bytes.** Use `grep -a` for any absence
  claim.

---

## 5. THE ENVELOPE — what a ticket may currently ask for

**Things testable offline.** That is the whole envelope, and it follows from the gate
running `--network=none`.

A static site works — demonstrated. A ticket needing Stripe or a hosted database does
**not**: the builder holds no such key, cannot obtain one, and the gate could not verify
it if it had. It would stub the integration and `GATE:no-stub-markers` would likely fail
the run, which is the right outcome by an unobvious route.

**Before any ticket assumes a real service, someone must decide what `heldOutPass` should
mean when a test needs the internet.** That is a design decision, not a wiring job.

**And a live property to know:** `subscriptionSubprocessEnv` is *"a subtraction, never an
allowlist"*. It strips model credentials only — `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*`,
`MOONSHOT_*`, `DEEPSEEK_*`. It does **not** strip `STRIPE_SECRET_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `GITHUB_TOKEN` or `AWS_*`, and build egress is
unrestricted. The owner's environment currently holds none of those (checked by name,
never by value). **Do not launch the dashboard from a shell carrying production secrets.**

---

## 6. OPEN — nothing here is blocking, all of it is real

**CRITICAL, and the reason it is critical is the feature's own purpose.**
`secret-intake.ts` (679 lines) and `code-files.ts` (554) were **rescued** in `384463d`
after their authors died on API errors before reporting. The tree is green. **Not one of
their security claims has been verified by anyone.** The secret box exists so a key never
reaches a chat transcript; if it leaks elsewhere it is worse than absent, because it will
be trusted. Re-run every control: never logged, echoed or returned; never in a prompt,
record, canvas node or error; never rendered back (screenshot masking is capture-time only
and permanent); mode 0600; genuinely gitignored — verified with `git check-ignore -v`
against a **real** file, because a missing path returns nothing and reads exactly like a
broken rule. Same for `code-files.ts`'s traversal refusals and its sealed-root exclusions.

**The canvas redesign is half done.** `roles.ts`, `run-hud.tsx`, `sheet.tsx` and the role
test are in.

> **CORRECTION, 2026-07-30.** This section said the fullscreen restructure was not done and
> that `tests/run-layout.browser.spec.ts` "still asserts *the rail sits beside it* and still
> passes". **It did not pass** — all three of its tests failed on
> `locator('section:has(.react-flow)')  Expected: 1  Received: 0`, because the canvas root
> became a `<div>`. A dead spec that fails loudly is recoverable; the belief that something
> there was still being checked was the actual hazard.
>
> The fullscreen page structure *was* in place, but `AppShell` capped `main` at
> `max-w-[1440px]`, and **no child can cancel a parent's `max-width`** — so on a 2000px
> window the "fullscreen canvas" was 1440px with 280px of dead gutter each side. Fixed via
> `AppShell.isFullBleed` (scoped to `/runs/<id>`; the list and the ticket form keep the cap),
> `--run-chrome` deleted in favour of flex fill, and a resize re-fit that latches off once
> the reader pans. `run-layout.browser.spec.ts` is rewritten as that guard and is green.
> See `docs/FINDINGS-2026-07-30-canvas-asks.md`. Also outstanding: draggable nodes,
fit-to-view on load, collapsing the ten sibling `session` nodes into one group, and the
edge-quality raise. **The owner's words on that last one, which matter:** a sliding
stroke-dash is not the deliverable — *"they look mega basic"*. The bar is layered strokes,
real SVG filters (`feGaussianBlur`+`feMerge`, low-amplitude `feTurbulence`) and animated
gradient stops, or an honest recommendation to move to canvas/WebGL. (They asked for
"the higgsfield mcp": none is connected, and it generates video files, so it is the wrong
tool for SVG paths that change per run and per drag.)

**Three items `STATUS` §7 names.** `orchestrator.ts:1663-1665` assigns where it should
merge, so a run's reported tokens **go down** at the first fix round — read-verified,
never executed. `http.ts` serves JPEG bytes as `image/png`. And the green dry run belongs
to image `c98bad3a…` while `fae56a4e…` is installed.

**Spend visibility.** The run reports the builder's 88,529 output tokens; the spec, audit
and judge seats spent a further **436,942 that are logged and never accumulated**. The UI
is honest that no dollar figure exists (`costUsd: null` is a deliberate invariant — there
is no price table and inventing one is forbidden), but the number shown is 16.8% of what
the ticket cost.

**Fixture labels.** `A-quality-only` means *"the only failing criterion is QUALITY-tier"*
and reads as a verdict; the owner reasonably read it as one. Rename, and check its three
siblings. That same near-blank page is also the **non-blank-but-hollow fixture the
visual-substance gate needs** — without it, a gate firing on nothing still sorts all seven,
which is why that gate is correctly still in shadow.

Plus `#24` (three delegation residuals), `#27` (`AgentDefinition.background` is inert),
`#45` (the seven-fixture calibration has never run with no env set, and the `rm -rf`
override has no `assertOutsideBakeoff` guard — the previous author left it out on purpose,
because an unverified guard is the defect that commit was fixing).

---

## 7. TWO PROCESS RULES THE OWNER SET

**Use `taste-frontend-expert`, not `ui-designer`, for the dashboard and the canvas.**
`ui-designer` keeps a separate, load-bearing job: it is the visual gate and the
design-lock auto-chooser, and it must never grade art direction it authored.

**Look at the output.** Across three days of grader work, records, test counts and rendered
markdown were read and **not one screenshot was opened**. The owner opened one PNG and
immediately found the substance gap that had only been described in the abstract. For
anything with a visual result, view the artefact — or have a vision model view it — before
claiming anything about quality.

---

## 8. OPERATIONAL

```
dashboard/server   911 tests / 901 pass / 0 fail / 2 skipped   (2 are DASHBOARD_LIVE_SMOKE)
bakeoff            112 / 112
client             10 FAILED / 94 passed          <-- see the correction below
npm run test:harness   22 / 22   (NOT in npm test — spawns bash, binds a port)
tsc --noEmit       clean, both packages
```

> **CORRECTION, 2026-07-30. THE CLIENT SUITE IS NOT GREEN AND WAS NOT GREEN.** This block
> read "client — 53 unit, 73 with the browser project", which states what passes and omits
> what fails. Measured before any edit this session: **13 failed / 73 passed.** Now 10 failed
> / 94 passed — the 3 `run-layout` failures are fixed and 21 tests were added.
>
> The remaining 10 are **specs the canvas redesign left behind**, not product defects:
>
> - `canvas-edges.browser.spec.ts` (6) — the redesign renamed every edge class to the
>   `conduit-*` vocabulary (`conduit-rim`, `conduit-casing`, `conduit-core`,
>   `conduit-comet`). The spec still waits on `path.edge-core--flowing`, which **matches
>   nothing in the source**.
> - `code-browser.browser.spec.ts` (4) — `CodeBrowser` moved into `RunSheet`'s Code tab; the
>   spec still expects it inline on the run page.
>
> Also: the 8 errors from `calibration.test.js` are the **Docker daemon being down**, not a
> regression. That suite fails deliberately rather than report a green it did not earn.
>
> **When quoting a suite, quote the failures too.** A count of passes is not a status.

Build to a **private outDir** when agents share the tree: `--outDir dist-<label>`, a
**sibling** of `dist` at `dashboard/server/<outDir>` — `contract-parity.test.ts` resolves
the client package from `import.meta.dirname` and a nested outDir breaks it. `dist-*/` is
gitignored.

**The API was saturated at the end of this session — nine agents lost to 529s.** Five had
finished their work and lost only the report; the work survived because it had been
committed. **Instruct agents to commit incrementally, never once at the end.**
