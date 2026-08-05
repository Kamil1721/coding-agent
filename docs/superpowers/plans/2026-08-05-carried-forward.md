# Carried forward — 2026-08-05

Deferred at the owner's instruction ("save the scorer protocol change for later"), plus everything
else found today and not closed. Nothing here is speculative; each item has the evidence that found it.

---

## 1. THE ONE THAT UNBLOCKS EVERYTHING ELSE — the scorer protocol change

**Deferred by the owner, 2026-08-05.** This is the single item standing between the visual gate and
"AI slop cannot pass".

The gate cannot fail a run today, and the reason is not the gate. It is that **no observation is both
unlocked and computable**:

| observation | state | why it cannot fire |
|---|---|---|
| `VIS-F-EMPTY-FRAME` | unlocked | needs `innerTextLength`, which `PageObservations` does not carry (`bakeoff/src/scorer-container.ts:560-565`) |
| `VIS-F-EMPTY-REGION` | shadow-locked | uncalibrated |
| `VIS-F-PLACEHOLDER-MEDIA` | shadow-locked | uncalibrated |
| `VIS-F-REF-GROUND-INVERTED` | shadow-locked | locked for a MEASURED reason: `scorer-container.ts:632` pins every capture to `colorScheme: "light"`, so a *correct* dark-mode build is indistinguishable from a deliberate inversion. Do not unlock without solving that first. |

**The work:** add `innerTextLength` (and whatever else the remaining observations need) to
`PageObservations`. That is a scorer protocol bump, which per a previous investigation makes
calibration **FAIL rather than skip**, and requires a container image rebuild and full recalibration.
It is the same Plan A / Plan B split identified for motion capture on 2026-08-04 and deferred then too.

**Why it kept getting skipped:** every workflow brief told agents to stay out of `bakeoff/` to avoid
collisions. That constraint is what made the gate unbuildable, and it was self-imposed.

## 2. The gating tap is shut

`visualGateInputFor` (`dashboard/server/src/orchestrator.ts:6734-6746`) returns exactly five fields —
`runId`, `runsRoot`, `workspace`, `screenshotDir`, `captures`. **`mode` is not one of them**, so
`visual-gate-run.ts` falls back to `DEFAULT_VISUAL_SUBSTANCE_MODE = "shadow"`
(`visual-substance.ts:692`), and `isGatingObservation` requires `mode === "gating"` (`:703`).

A repo-wide grep for a production expression yielding `"gating"` returns **nothing** — no env var, no
config, no call site. `visualFindingsAt()` (`verdict.ts:260`) therefore returns 0 forever.

Opening the tap alone changes nothing until item 1 lands. Do them together, tap second.

## 3. `transient` is discarded after being classified

`orchestrator.ts:5824` — `if (klass !== "throttled") return false;` inside `#recoverFrom`. The
classifier now derives `transient` correctly from `SeatCallError.retryable`, and the recovery path
throws the class away. The label reaches the `recoveryClass` column and nothing else.

Also: no dashboard producer emits a non-null `status`, so a `SubscriptionSeatCaller` throw derives
`throttled` regardless.

## 4. The rate-limit wait ceiling does not match reality

`RECOVERY_MAX_AUTO_WAIT_MS` covers an overnight window. Every wait this machine has actually recorded
is **2.2–5.0 days** (29 `rate_limit` frames in `runs.db`; sample `retryAfterSec: 304272` = 84.5 h), and
**0 of 29 carry `limited: true`** — so the throttled arm's production trigger has never fired here.
Whether the SDK emits `limited: true` before a refusal-driven throw is unverified and needs a live run.

## 5. Test-integrity defects found by mutation audit

These are the reason to keep auditing: in each case the conclusion was right and the recorded
justification was false.

- **Race-vacuous count-0 guards.** `dashboard/tests/design-lock.browser.spec.ts:833` forbids a
  sentence. Painting that sentence unconditionally and running six times gave **1 red, 5 green** — the
  assertion resolves against an un-hydrated document because it is the first after `serve()` with no
  paint gate. The sibling guard at `:805-810`, mutated identically, went 6/6 red. Fix: gate on paint,
  then sweep every other count-0 guard in the file.
- **`getByRole({ name })` matches by SUBSTRING.** Renaming the rail's `aria-label` to
  `"Run panels (mutated)"` left all nine tests green. Every negative control in this suite that pins an
  accessible name without `exact: true` is weaker than it reads. Repo-wide property, pre-existing.
- **The `openRun` retry hides intermittent-mount regressions.** With a production regression where the
  rail renders nothing on the first document load of a session, the repaired helper is 9/9 green — the
  only trace is 250 ms → 11.5 s per test. Trade was made deliberately to fix three order-dependent
  flakes; the underlying race is the real fix.
- **`ticket-redundancy.browser.spec.ts:255-260`** — a replacement assertion exists and is falsifiable:
  `toHaveCount(1)` plus `paintedArea < 4` after removal. Measured: count is 1 before attach, after
  attach, and after removal, with `paintedArea = 1px²`.

## 6. Environment and harness hazards

- **`DASHBOARD_CALIBRATION_ROOT` is set by nothing.** `grade-fixture.ts` `rm -rf`s fixtures at a shared
  root, so concurrent calibration runs produce false reds. Pre-existing.
- **Audit agents corrupt `dashboard/tsconfig.json`.** Next rewrites its `include` list when a private
  `.next-auditNN` dir is used; the file had to be reverted twice on 2026-08-05. The scaffolding is now
  gitignored, but the tsconfig write is not prevented — audit briefs must use a copied config.
- **A poisoned Turbopack cache took the whole app to HTTP 500**, reporting corrupted bytes in a
  generated `h-[…]` Tailwind class while `globals.css` was clean. `rm -rf .next` fixed it. It also
  silently invalidated a running workflow's browser results, because every spec was hitting the 500.
  Worth a preflight check that 4319 returns 200 before any browser wave.

## 7. Known failing test, not a regression

`dashboard/server/src/plan-phase.test.ts` — *"the three runs already on disk still read, still render,
and still name their suites"*. It asserts every run on disk predates the plan phase; run
`run-2026-08-04T11-08-10-487Z-162b186d` has a real `results/plan.json` because it genuinely went
through that phase. The test's premise is stale against the owner's own data. Fix: scope the loop to
runs predating the phase, or re-baseline. Untouched since `b1d5158`.

## 8. Older items still open

- **Motion capture under-reports.** On `kamilborzecki.dev` it found 1 span, missing the 5-animation
  load entrance and 3 of 5 hover transitions. Suspected `safeRole` collapsing roles to "an element"
  plus `normaliseMotion` grouping by `family + role`.
- **Motion Plan B** — the enforcement gate. Parked until a human reads a real captured spec.
- **Item C1** — the verdict page's "N of M inferred" line disagrees with the record.
- **Move `runs.db` to Neon.** Correction on the original framing: it is a SQLite file at
  `dashboard/data/runs.db`, not in OrbStack, so this is a SQLite→Postgres migration of `db.ts` and its
  call sites.
- **Background `run_in_background` Bash shells are drawn as agent nodes** on the canvas. The dashed
  "guessed parent" edges the owner asked about were a symptom; this is the cause.
- **`434928s` in the quota line** should be formatted as days/hours.

## 9. Standing decision recorded today

**Assets are generated, never taken from a library** (owner, 2026-08-05: "designs are always made using
gemini connection rather than pulled from some library"). This REVERSED a considered position in
`builders/antislop-rules.ts`, which previously told the builder a chosen `images.unsplash.com/photo-…`
URL was fine. The reversal is recorded at the call site with its date.

Note the honest split: "no library assets" is checkable from the artefact; "this asset came from
Gemini" is **not visible in the artefact at all** and needs recording at generation time.
`design-manifest.ts` is the candidate carrier. Not built.
