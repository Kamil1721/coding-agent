---
document_status: plan
written: 2026-09-04
source: docs/RESEARCH-learning-loop-2026-09-04.md
decision: branch B (owner as judge), with branch A kept only in its deterministic reproduce-then-clear carve-out
consumed_by: Codex, one task per session
---

# Learning loop: the implementation plan, as Codex-sized tasks

## 0. How to read this

Fourteen code tasks and two owner gates. Each code task is one Codex session: one goal, one
area, one flag, one test file. Hand them over in the order given; the two gates (G1, G2) are
owner actions, not Codex sessions. Nothing here needs
fine-tuning, weight updates, logprobs or thousands of scored programmatic calls; every seat
stays a CLI subprocess.

**The order is measurement first, learning second, and that is not a style choice.** Today
there is no baseline at all: no rate in this repository is printed with its denominator or its
interval, the intracluster correlation that decides whether per-criterion scoring is worth
anything has never been computed by any code we own, and the taste critic publishes when it has
no evidence. T1 to T5 fix that. If the owner gate at G1 fires and branch B is killed on the
spot, T1 to T5 are still worth their sessions — they are instruments and one live bug fix, and
none of them mentions learning.

**Standing rules this plan inherits, and every task is written to obey.**

1. **Every probe needs a negative control.** A check that can only observe success is this
   repository's signature defect. Each task below names the specific thing that must FAIL, and
   several name the stub implementation that must not be able to pass.
2. **Nothing promotes itself on evidence measured only on the runs that produced it.** T14 is
   where that becomes code; until T14 exists, nothing is promoted at all.
3. **The owner's judgement is the scarce resource.** The whole plan asks for one sitting of
   about fifteen minutes, then about thirty seconds per canvassed run and about ten minutes a
   week. No task may raise that.
4. **Rules are advisory to the design and critic seats only.** The held-out suite, its hash and
   the sealed scorer are untouched by every task here. Nothing owner-derived may edit a
   criterion.

**Reversibility legend.**

| Mark | Meaning |
|---|---|
| **R** | Reversible. Revert the commit and the system is byte-identical. |
| **R-flag** | Reversible at runtime. One boolean off restores the prior prompt exactly. |
| **R-additive** | New table or new file only. Nothing existing is altered; dropping the table restores the prior state. |
| **NOT-R** | Something outside the repository changes and cannot be undone. |

Only one item in this plan is **NOT-R**, and it is the owner gate G1: once the owner has seen
those twenty-four direction pairs, the blind condition is destroyed permanently. There is no
second first sitting. That is why T6 ships the harness *and* its pre-registered analysis before
G1 runs. G2, the re-sitting at ≥2 weeks, is a repeat of an already-seen deck and destroys
nothing.

---

## 1. The measured starting position, reproduced today

Every figure below was re-measured against the repository on 2026-09-04 for this plan, not read
from the research document. Where the research and my own query disagree, the disagreement is
noted rather than smoothed.

| Quantity | Value | How |
|---|---|---|
| Runs in total | 30 | `select count(*) from runs` |
| `status` | 19 failed, 6 cancelled, 5 passed | `group by status` |
| `held_out_pass` | 7 true, 9 false, **14 NULL** | `group by held_out_pass` |
| Real heldOutPass rate | 7/16 = 43.75% | computed |
| Crosstab (hop, ff, declared) | (NULL,NULL,0)=12, (NULL,NULL,1)=2, (0,0,0)=2, (0,1,1)=7, (1,0,1)=7 | `group by 1,2,3` |
| Distinct tickets | 21 | `count(distinct ticket_id)` |
| Owner messages | 99 | `count(*) from messages` |
| Criteria rows | 342 over 19 runs; 236 pass, 61 fail, 45 pending | `criteria` |
| Criteria by tier | BLOCKING 60, FUNCTIONAL 226, QUALITY 56 | `group by tier` |
| Scored gating rows (BLOCKING+FUNCTIONAL, pass/fail) | **N=248, K=16 runs, m̄=15.50, mean pass 0.7823** | computed |
| One-way ANOVA ICC on those | **0.4675** (m₀=15.352, MSB=1.3615, MSW=0.0941) → DEFF 7.78, ESS 31.9 | computed, reproduces the research figure exactly |
| `design-lock.json` files | 14; **12 carry three directions**; 2 carry none | `find dashboard/runs -name design-lock.json` |
| `chosenDirectionBy` | `ui-designer` ×9, `fallback` ×3, null ×2, **`owner` ×0** | read from the records |
| Winner-versus-loser pairs | **24 total: 18 with a `ui-designer` incumbent, 6 with a `fallback` incumbent** | 12 records × 2 losers |
| Section common to all three directions in every one of the 12 | **`hero`**, in all 12; the second common section varies (`work`, `pricing`, `prices`, `project`, `services`) | computed |
| Mockups referenced by direction records | 131, **all 131 present on disk** | verified with `existsSync` |
| All `design mockup — *` screenshot rows / `design-*.png` files on disk | 143 / 143 | the extra 12 are per-section mockups from pre-direction runs; both numbers are correct in their own frame |
| Screenshots | 257 rows across 16 runs | `screenshots` |
| Defect ledger | 24 lines over 6 shards; largest shard 11 lines, all under site `done/failed/no-code` | `wc -l dashboard/data/defects/*.jsonl` |
| Tier-3 apply index | 4 records, all synthetic, all `applied:false` | `dashboard/data/tier3/index.jsonl` |

**Two corrections to the research that this plan acts on.**

**The kill-criterion denominator was wrong.** `fallbackDirectionChoice`
(`dashboard/server/src/design-lock.ts:251`) selects **the first direction in manifest order**
and records `by: "fallback"` precisely so an arbitrary pick is not filed as a judgement. Six of
the twenty-four pairs therefore have no incumbent judgement to agree with. The decision
statistic is agreement on the **18 `ui-designer` pairs**, and the 6 `fallback` pairs become a
free control arm that already exists on disk: agreement with `fallback` is by construction
agreement with *first in manifest order*. Recomputed thresholds on n=18:

| Outcome on the 18 `ui-designer` pairs | P(X≥k \| p=0.5) | Wilson 95% | Action |
|---|---|---|---|
| ≥16 of 18 | 0.00066 | [0.672, 0.969] | **Stop.** No taste gap in this seat |
| 13 to 15 of 18 | — | — | Proceed |
| ≤12 of 18 | — | — | Proceed; true agreement of 85% ruled out (P(X≤12 \| p=0.85) = 0.042) |

The 6 fallback pairs have power to decide nothing on their own and must be reported
descriptively, never as a test. What they can do is undercut the headline: if agreement with
`fallback` is about as high as agreement with `ui-designer`, then the statistic is tracking
manifest order rather than judgement, and the `ui-designer` number means less than it looks.

**Every one of the 12 records has `hero` common to all three directions.** So the pick in T6 is
made on like against like at a fixed section, not on whichever stills happen to exist. Direction
mockup counts are unequal (5, 2, 2 in one record) and a harness that ignored that would compare
a five-still direction against a two-still one.

---

## 2. The tasks

### T1 — The baseline instrument

**Goal.** A read-only script that prints every rate this repository quotes, with its
denominator and a Wilson interval, refuses to print when the denominator is too small, and
writes a timestamped baseline file.

**Why here.** There is no baseline. We cannot detect an improvement we cannot measure, and every
later comparison in this plan needs a number that was recorded *before* anything changed. This
task is also where `requiredRuns` lands, so every later proposal is priced before it is built
rather than after.

**Touches.**
- new `dashboard/server/src/baseline.ts` (pure functions), `dashboard/server/src/baseline.test.ts`
- new `dashboard/server/src/baseline-cli.ts` (thin entry, reads the DB, writes the file)
- `dashboard/server/package.json` — one new script, `"baseline": "npm run build --silent && node dist/baseline-cli.js"`
- reads `dashboard/data/runs.db` (the live DB; `dashboard/data/dashboard.sqlite` is empty and
  `dashboard/runs.db` is a 0-byte stray — do not touch either)
- imports `wilsonInterval`, `estimateProportion`, `compareProportions` from
  `bakeoff/dist/analyze.js`. `bakeoff` is already a `file:` dependency of `dashboard/server`,
  its `package.json` declares no `exports` map, and the server already imports nine other
  `bakeoff/dist/*.js` modules including `contracts.js` and `gate.js` — so **no vendoring and no
  parity test is needed**; import it directly. (`bakeoff/dist/analyze.js` is present in the
  tree; if it is stale, run `npm run build` in `bakeoff/` first — the server's build does not
  build it.)
- writes `docs/baseline/baseline-<ISO date>.json` and `.md`

**Acceptance criteria.**
1. Denominators come from `held_out_pass IS NOT NULL`. Never from `status`.
2. Reproduces today's figures on the live DB: gated denominator 16, 7 passes, rate 0.4375,
   Wilson [0.2310, 0.6682]; and separately reports the 14 NULL runs as *no verdict*, never as
   failures.
3. `requiredRuns(baseRate, delta)` reproduces the published table: from 0.4375, +10pp → 388 per
   arm, +15pp → 170, +20pp → 94, +30pp → 38. Two-sided α=0.05, power 0.80,
   (1.95996+0.84162)² = 7.8489.
4. `requiredRuns` **throws** when the gated denominator is under 10, with a message naming the
   denominator. It returns a range derived from the Wilson bounds on the base rate, not a point
   estimate.
5. Pinned Wilson values: `(5,30)→[0.0734, 0.3356]`, `(7,16)→[0.2310, 0.6682]`,
   `(0,30)→[0, 0.1135]` asserting `high > 0`, `(30,30)→[0.8865, 1]` asserting `low < 1`.
6. **NEGATIVE CONTROL, three of them, all required.**
   (a) A fixture DB in which every row has `held_out_pass IS NULL` must make the script
   **refuse**, not print `0%` or `0/0`. Assert the throw.
   (b) A fixture DB with a row where `status='passed'` **and** `held_out_pass IS NULL` must not
   increment the pass count — this is the control that proves the script keys off the right
   column, and it fails against the obvious wrong implementation.
   (c) A stub `wilsonInterval` returning `[0,1]` for every input must fail the pinned-value
   test. Do **not** write `assert(wilson(0,30) !== [0,0])`: at p=0 the lower bound is exactly 0,
   so that assertion fails against a correct implementation and passes against the stub.

**Must not.** Must not write to the database. Must not print a dollar figure (`db.ts` rule 2
gives no cost column, and a baseline that invented one would be the same fabrication). Must not
compute anything from `status` counts and call it heldOutPass. Must not add a column to `runs`.

**Depends on.** Nothing. **Reversible: R.**

---

### T2 — The intracluster-correlation estimator

**Goal.** A function that computes one-way ANOVA ICC, design effect and effective sample size
over clustered binary observations, pinned to the 248 gating criteria we already have.

**Why here.** The single number that decides whether per-item owner labels are worth more than
run outcomes is ρ, and no code we own computes it. Building the estimator now — against data
that already exists — makes the 0.4675 figure independently reproducible instead of read from a
document, and makes re-running it on the first thirty owner labels free. Kill criterion 3 needs
this and cannot wait to build it.

**Touches.**
- new `dashboard/server/src/cluster-stats.ts`, `dashboard/server/src/cluster-stats.test.ts`
- consumed by `baseline-cli.ts` from T1 (add one section to the baseline report)
- reads `criteria` and `runs` in `dashboard/data/runs.db`

**Acceptance criteria.**
1. On the scored gating rows (`result IN ('pass','fail') AND tier IN ('BLOCKING','FUNCTIONAL')`)
   it reproduces, to four decimals: N=248, K=16, m̄=15.50, mean pass 0.7823, m₀=15.352,
   MSB=1.3615, MSW=0.0941, **ICC=0.4675**, DEFF=7.78, ESS=31.9.
2. Handles unequal cluster sizes with the m₀ correction, `m₀ = (N − Σnᵢ²/N)/(K−1)`. The 16
   clusters here run from 6 to 23 items, so an equal-size formula gives a different answer and
   must not be used.
3. Emits the DEFF-by-m table at the measured ρ: m=2→1.47, m=3→1.94, m=6→3.34, m=10→5.21,
   m=16→8.01.
4. **Refuses** with a named error under 8 clusters, and refuses when any cluster has fewer than
   2 items.
5. **NEGATIVE CONTROL, both directions.**
   (a) A fixture where every cluster has an identical pass rate (zero between-cluster variance)
   must return ICC ≤ 0 and must **not** be reported as a positive correlation.
   (b) A fixture of perfectly separated clusters (some all-pass, some all-fail) must return ICC
   ≈ 1. A stub that always returns 0.4675, or always returns 0, fails one of these two.
6. The QUALITY-tier figure is reported separately (49 observations, ICC 0.8253, ESS 18.1) and
   labelled as never gating.

**Must not.** Must not silently fall back to an equal-cluster formula. Must not quote any
branch B power figure — this task builds the instrument, it does not apply it to taste labels
(there are none yet).

**Depends on.** T1 (for the report surface; the estimator itself is independent).
**Reversible: R.**

---

### T3 — Split `accept` from `no-evidence` in the rendered taste critic

**Goal.** Insufficient evidence must stop publishing as acceptance.

**Why here.** This is a live bug, not learning-tier work, and it is the exact defect this
repository is named for. `rendered-taste-critic.ts:161` sets
`criticDisposition: output.findings.length === 0 ? "accept" : "revise"`, while the prompt at
`taste-policy.ts:810` tells the model *"An empty findings array is correct when evidence is
insufficient."* The two together mean a critic that could see nothing returns `accept`, and
`creative-pilot.ts:982` publishes on `accept`. Fix it before any owner-derived rule is fed to
this seat, or every later measurement of that seat is taken through a broken instrument.

**Touches.**
- `dashboard/server/src/rendered-taste-critic.ts` (`CriticDisposition` at :28, the verdict at
  :161–166, the invariant checks at :278 and :292)
- `dashboard/server/src/taste-policy.ts` (`TasteCriticOutputV1` at :142, the closed schema in
  the prompt tail, `TASTE_POLICY_SCHEMA_VERSION`)
- `dashboard/server/src/creative-pilot.ts` (:345–348 the record validator, :982 the publish
  condition, `CRITIC_DISPOSITIONS`)
- `dashboard/server/src/creative-review-loop.ts` (:35, :43)
- `dashboard/server/src/creative-recovery.ts` (:74, :184, :704)
- `dashboard/server/src/api-types.ts:750`
- existing tests: `rendered-taste-critic.test.ts`, `taste-policy.test.ts`,
  `creative-pilot.test.ts`, `creative-review-loop.test.ts`

**Two code paths, named up front, because criteria 1 and 6 below coexist only if they are
separate.** The **live parse** (`parseTasteCriticOutput`, fed by a model call in this session)
accepts **v2 only**; an output missing `evidenceSufficient` fails parse. The **stored-record
reader** (the `creative-critic/` files and `creative-recovery.ts`'s validators) accepts
`v1 | v2` as a discriminated union and does **not** reinterpret a v1 record into either
disposition. Note also that there are two version constants —
`TASTE_POLICY_SCHEMA_VERSION` (taste-policy.ts:8) and `RENDERED_TASTE_CRITIC_SCHEMA_VERSION`
(rendered-taste-critic.ts:23) — and `schemaVersion` is typed as `typeof` the constant, so
bumping one retypes every parsed object in that file. Bump the taste-policy one; leave the
record one alone.

**Acceptance criteria.**
1. `TasteCriticOutputV1` gains one required boolean — `evidenceSufficient` — and
   `TASTE_POLICY_SCHEMA_VERSION` goes to 2. The prompt's exact-keys line and the closed live
   parser both carry it; an object missing the key fails the **live** parse, as every other
   schema violation does.
2. `CriticDisposition` becomes `"accept" | "no_evidence" | "revise" | "unavailable"`.
   `findings.length === 0 && evidenceSufficient === false` → `no_evidence`.
   `findings.length === 0 && evidenceSufficient === true` → `accept`.
3. Every consumer treats `no_evidence` as **not accept**. In particular `creative-pilot.ts:982`
   must not publish on it.
4. The prompt sentence changes from "An empty findings array is correct when evidence is
   insufficient" to language that separates the two: empty findings **with**
   `evidenceSufficient: false` is the insufficient case; empty findings with
   `evidenceSufficient: true` is a genuine pass.
5. **NEGATIVE CONTROL, both directions, both required.**
   (a) A fixture output with empty findings and `evidenceSufficient: false` must yield
   `no_evidence` and must **not** publish. This is the direction that proves the bug is gone.
   (b) A fixture output with empty findings and `evidenceSufficient: true` must still yield
   `accept` and must still publish. This is the direction that proves the lane was not simply
   broken shut — an implementation that returns `no_evidence` unconditionally passes (a) and
   fails (b).
6. Records already on disk at schema 1 continue to read back through the **stored-record
   reader** without throwing. They are historical and are **not** reinterpreted as either
   disposition. A test loads a v1 fixture and asserts both: it parses, and its disposition is
   left as recorded.

**Must not.** Must not add a score, severity or prose verdict to the critic output — the closed
schema forbids all four by name and that refusal is load-bearing. Must not widen
`TASTE_CATEGORIES` or `TASTE_FINDING_CODES` (that is T10). Must not change what the critic gates.

**Depends on.** Nothing. **Reversible: R.**

---

### T4 — Version the defect signature so unlike failures stop colliding

**Goal.** Two different causes at the same site must produce two signatures; the same cause must
still produce one.

**Why here.** `defectSignature(site, fieldPaths)` at `defect-record.ts:238` hashes a site
(`phase/status/code`) plus sorted field paths. Because `fieldPaths` is empty on almost every
real record, eleven records spanning four distinct causes sit in one shard under
`done/failed/no-code`. Per-defect learning is impossible on that ledger even after something
reads it, and the branch A carve-out at T-none depends on being able to name a defect. Cheap,
self-contained, and useful whether or not the learning tier ships.

**Touches.**
- `dashboard/server/src/defect-record.ts` (`defectSignature` :238, `buildDefectRecord` :603,
  `writeDefectRecord` :684 and the `data/defects/<signature>.jsonl` shard name)
- `dashboard/server/src/defect-record.reproduction.test.ts`,
  `dashboard/server/src/defect-record.trail.test.ts`
- `dashboard/server/src/orchestrator.defect-record.test.ts`
- reads, does not rewrite, `dashboard/data/defects/*.jsonl`

**Acceptance criteria.**
1. The signature gains a **cause class** derived from `failureReason` — a normalised,
   bounded classifier over the reason string (strip run ids, timestamps, paths and digits), not
   the raw string. Record the classifier's input and output beside the digest, as `site` and
   `fieldPaths` already are.
2. The signature is **versioned**: records carry `signatureVersion: 2`, and the shard filename
   incorporates the version so v1 and v2 shards never merge.
3. Replayed against the 24 lines already on disk, the 11-line shard splits into more than one
   group, and the split is reported in the test with the group sizes named.
4. **NEGATIVE CONTROL.** A fixture pair of records with genuinely the same cause — same site,
   same normalised reason, differing only in run id and timestamp — must still produce **one**
   signature. Without this, a change that simply hashes the raw `failureReason` passes criterion
   3 by making every record unique, which is exactly as useless as one bucket and harder to
   notice.
5. A second negative control: a record with `failureReason: null` must not throw and must not
   collapse into the same bucket as a record with a reason.

**Must not.** Must not rewrite, re-shard or delete any existing `.jsonl` file. History stays as
written; the change is not retroactive and the acceptance criteria must not imply a migration.
Must not add a read path — the ledger stays write-only (see §3).

**Depends on.** Nothing. **Reversible: R** for the code; the new shard files it later writes are
additive.

---

### T5 — Probe the sealed-seat auto-memory channel

**Goal.** Find out whether the spec, plan, judge and fix seats are already reading a cross-run
memory file, and close the channel if they are.

**Why here.** `subscription-caller.ts:1992` sets `settingSources: []` for the sealed seats
deliberately, but auto memory is loaded regardless of that setting and those seats run with
`cwd` inside this repository. If that channel is open, the store this plan builds is not the
only cross-run signal in the pipeline, and every ON/OFF comparison later is confounded by a
channel nobody controls. Cheap to answer and it must be answered before injection is measured.

**Touches.**
- new `dashboard/server/probes/auto-memory-canary.mjs` (matches the existing probe convention:
  `probe-e-agent-hook.mjs`, `probe-f-audit-isolation.mjs`, results under `probes/results/`)
- reads `dashboard/server/src/subscription-caller.ts` (:1943 the seat options, :1987 `cwd`,
  :1992 `settingSources`)
- possibly `dashboard/server/src/subprocess-env.ts` (`STRIPPED_ENV_NAMES` is the existing
  one-place-for-every-subprocess list, and is where an added variable belongs)

**Acceptance criteria.**
1. The probe points `autoMemoryDirectory` at a scratch path, seeds it with a unique canary
   string, and dumps the assembled prompt actually sent to a sealed seat.
2. **The result is recorded either way**, as a committed JSON file under `probes/results/`, with
   the exact seat options used.
3. **NEGATIVE CONTROL, and it is the whole probe: present-under-default AND absent-under-flag.**
   Assert the canary IS in the prompt with default settings, and IS NOT with
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. A present-only assertion cannot tell "the flag works"
   from "the canary was never loaded in the first place", and a search that finds nothing proves
   nothing about the channel.
4. If and only if the canary is present by default, add `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to
   the sealed seats' environment and re-run the probe to show it absent. If the canary was
   absent by default, **change nothing** and record that.

**Must not.** Must not change `settingSources`, `tools`, `cwd` or the prompt for any seat. Must
not add the environment variable speculatively before the probe has shown the channel is open —
an unmeasured guard is the thing this repository keeps having to unpick.

**Depends on.** Nothing. **Reversible: R.**

---

### T6 — The pairwise-pick harness, with its first deck and its analysis pre-registered

**Goal.** A **generic** offline harness that reads a deck file, presents each pair of images
blind and order-randomised, records a pick and a free-text reason — plus the first deck builder
(the 24 stored winner-versus-loser direction pairs) and, written in the same session before any
owner sees it, the stratified verdict.

**Why here.** This is the kill instrument for the entire branch. It must exist and be correct
before the sitting, because the sitting cannot be repeated. The analysis ships with the harness
so the thresholds are pre-committed rather than chosen after the picks are in.

**Generic, deliberately, and this is the load-bearing scoping decision.** The plan later needs
three decks off the same machinery: direction pairs (here), screenshot pairs for weekly label
supply (T9), and rule-on-against-rule-off artefact pairs for the paired promotion test (T14).
Building `probe.mjs` against a **deck file** now makes those two deck builders rather than two
new harnesses. Building it against the direction corpus and generalising later is a refactor
this plan cannot afford.

**Not a dashboard view.** The research proposed one; that is a new route inside a 5,556-line
`http.ts`, plus API types, plus a Next page, and it does not fit one session. The repository
already has the right precedent in `dashboard/server/probes/*.mjs` and `tools/`. Output is flat
JSONL, not `owner_pref` — which keeps the kill criterion independent of a schema it may never
need.

**Touches.**
- new `tools/taste/probe.mjs` (deck-driven: present and record), `tools/taste/analyse.mjs`
  (the verdict), `tools/taste/probe.test.mjs`
- new `tools/taste/deck-directions.mjs` — the first deck builder
- reads the 14 `dashboard/runs/*/results/design-lock.json` files and the PNGs under
  `dashboard/results/screenshots/<runId>/design-*.png`
- writes `dashboard/data/taste/premise-probe-<ISO>.jsonl`
- serves images from a local static server or opens the files directly; either is fine, but the
  two images in a pair must be shown at the same size

**Acceptance criteria.**
1. `probe.mjs` takes a **deck file path** as its input and knows nothing about directions. A
   deck entry is `{pair_id, kind, run_id, left_candidate, right_candidate, image_a, image_b,
   metadata}`; the harness randomises the sides, presents, records, and writes JSONL. A test
   drives it with a two-entry synthetic deck of coloured squares and no design-lock data
   anywhere, proving the coupling is gone.
2. `deck-directions.mjs` emits exactly 24 pairs from the 12 records that carry three directions:
   the incumbent against each of the other two. Every pair is compared **on the `hero` section**,
   which all 12 records have in common across all three directions. Direction mockup counts are
   unequal (5, 2, 2 in one record) and the deck builder must not pair a five-still direction
   against a two-still one.
3. **Blind.** No slug, name, `distinction` text, incumbent marker or run id is visible while the
   pick is being made. Two images and one question.
4. Each row records: pair id, run id, both direction slugs, which side each was shown on, the
   pick, the free-text reason, the incumbent slug, the incumbent's authority
   (`ui-designer` | `fallback`), and a timestamp.
5. `analyse.mjs` reports the two strata **separately** and names the decision statistic as the
   18 `ui-designer` pairs: ≥16/18 → stop (P=0.00066, Wilson [0.672, 0.969]); 13–15/18 →
   proceed; ≤12/18 → proceed, 85% agreement ruled out (P(X≤12 | p=0.85) = 0.042). The 6
   `fallback` pairs are reported descriptively with an explicit statement that n=6 decides
   nothing, plus the direct comparison of the two agreement rates as the order-bias reading.
6. **NEGATIVE CONTROL, two, both required.**
   (a) Run the randomiser 1,000 times over the fixed deck and assert winner-on-left falls inside
   a binomial tolerance of 50%. A harness that always places the incumbent on the left can only
   ever observe agreement, and this is the test that fails against it.
   (b) Plant one pair twice in the deck, order-swapped, and feed the analyser a synthetic
   response file in which the two copies are answered inconsistently. The analyser must **report
   the contradiction**. If it cannot see a contradiction it also cannot measure self-consistency
   later (kill criterion 5), and a harness that silently de-duplicates the repeat passes every
   other test here.
7. No numeric score anywhere. Forced A/B plus free text, about ten seconds per pair. The
   measured reason to refuse a score: the same annotator's numeric scores contradict their own
   direct comparisons about half the time (top-1 self-consistency 45.5%, Kendall τ 0.188), while
   pick-based agreement runs 90.8% against 39.5% (https://arxiv.org/abs/2605.12684, 2026-05-12).
8. Re-running `probe.mjs` on the **same deck file** produces a second, separately-named JSONL and
   `analyse.mjs` can compare the two. This is what kill criterion 5 (test–retest at ≥2 weeks)
   later needs, and it costs nothing to support now.

**Must not.** Must not write to `runs.db`. Must not add a route to `http.ts` or a page to
`dashboard/src`. Must not show the incumbent, the seat that chose it, or the reason it gave.
Must not ask for a rating, a confidence or a 1–10. Must not hard-code the direction corpus into
`probe.mjs`.

**Depends on.** Nothing. **Reversible: R** for the code. Note what it enables: **G1 is NOT-R.**

---

### G1 — OWNER GATE: the sitting *(not a Codex task)*

**Goal.** Fifteen minutes, one sitting, 24 pairs, blind, order randomised.

**Why here.** Everything from T7 onwards is taste-store-shaped and gets built only if this gate
does not fire. Front-loading T1–T5 means that if it does fire, five useful instruments and one
bug fix have already shipped.

**Acceptance.** The JSONL exists with 24 rows plus the planted repeat; `analyse.mjs` prints both
strata; the verdict is appended to the baseline file from T1 with the date.

**Kill.** Agreement on ≥16 of the 18 `ui-designer` pairs → **stop**, and take the complaint
somewhere other than the direction-picking seat.

**Honest limitation to record with the result.** The owner has previously seen some of these
mockups live, during the runs that produced them. The condition is blind to slug and incumbent,
not to memory. Record the run ids so familiarity can be modelled later; do not add a
"did you recognise this?" question, because owner attention is the scarce resource.

**Depends on.** T6. **Reversible: NOT-R.**

---

### T7 — The `owner_pref` table and the importer

**Goal.** A durable home for pairwise owner picks, plus a one-shot importer for the T6 JSONL.

**Why here.** First task after the gate. Nothing accumulates until there is somewhere to put it,
and the schema is decided by what T6 already recorded rather than guessed in advance.

**Touches.**
- `dashboard/server/src/db.ts` (a new `CREATE TABLE IF NOT EXISTS` beside the existing ones, one
  write path, `redactForPersistence` on every persisted string as rule 1 requires)
- `dashboard/server/src/db.test.ts`
- new `tools/taste/import-prefs.mjs`
- writes to `dashboard/data/runs.db` — the live DB, WAL active. New table only.

**Acceptance criteria.**
1. `owner_pref(pref_id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT NOT NULL, item_a TEXT
   NOT NULL, item_b TEXT NOT NULL, chosen TEXT NOT NULL, reason TEXT, rated_at TEXT NOT NULL,
   rater TEXT NOT NULL)`, `kind IN ('direction','screenshot','section')`.
2. `rater` is a **closed set**, declared as an exported constant in `db.ts` and enforced on
   write: `'owner'` for a human pick, `'ui-designer'` and `'fallback'` for an imported incumbent
   choice recorded for comparison. A value outside the set throws. T12 refuses to induce rules
   from any row whose rater is not `'owner'`, and it needs something to check against.
3. `CREATE TABLE IF NOT EXISTS` only. **No `ALTER TABLE` on `runs`, `criteria`, `screenshots` or
   any existing table.**
4. Strings go through `redactForPersistence` on the way in, via the single write path, exactly
   as every other table in `db.ts` does.
5. The importer is idempotent: running it twice over the same JSONL leaves the same row count.
6. **NEGATIVE CONTROL, three guards, each proven to fire.**
   (a) A row whose `chosen` is neither `item_a` nor `item_b` must **throw**.
   (b) A duplicate `(kind, run_id, item_a, item_b, rater)` must **throw** — assert on the second
   insert, not just the first.
   (c) A test reads `PRAGMA table_info(owner_pref)` and asserts **no column matches
   `/score|rating|stars|rank/`**. The measured reason: the same annotator's numeric scores
   contradict their own direct comparisons about half the time, so there must be nothing to
   write a score into.
7. A positive control alongside: a well-formed row inserts and reads back with its reason
   intact.

**Must not.** Must not alter an existing table. Must not add a score column "for later". Must not
touch `dashboard/data/dashboard.sqlite` (empty) or `dashboard/runs.db` (0 bytes, stray). Must not
read `owner_pref` into any prompt — that is T12, behind a flag.

**Depends on.** T6, G1. **Reversible: R-additive.**

---

### T8 — Write `chosenDirectionBy = "owner"` for real

**Goal.** A live run's three-direction pick lands as an `owner_pref` row and as an
owner-authored direction choice.

**Why here.** This is the ongoing label supply, and kill criterion 2 (fewer than 40 new rows in
any 14-day window) cannot even be evaluated until it exists. It is wiring, not design:
`designLockPolicy` (`design-lock.ts:48`) already returns `"ask"` when the run is interactive,
`chooseDirection` (:184) already accepts a `by` and refuses a blank reason, and
`DesignLockRecord` (:443) already carries `chosenDirectionBy` and the losing directions with
their published mockups. The type is complete and the path has executed zero times in 30 runs.

**Touches.**
- `dashboard/server/src/design-lock.ts` (:48, :184, :443 — no signature changes expected)
- `dashboard/server/src/http.ts` — the design-lock decision route; model it on the existing
  `/api/runs/:id/creative-decision` POST at :2973
- `dashboard/server/src/orchestrator.ts` (the design park and the `#parkForDesignLock` path)
- `dashboard/src/components/run/design-directions.tsx` (the deck already renders three
  directions and lifts zoom state; the pick already exists as a click)
- `dashboard/server/src/db.ts` (`owner_pref` write from T7)
- `dashboard/server/src/design-lock.test.ts`, `dashboard/server/src/api.test.ts`

**Acceptance criteria.**
1. An owner pick on an interactive run writes `chosenDirectionBy: "owner"` into
   `results/design-lock.json` **and** two `owner_pref` rows of `kind: 'direction'` (chosen
   against each loser).
2. The reason field is carried through; `chooseDirection` already refuses a blank one, and that
   refusal must still fire.
3. Total owner cost: one click plus one short sentence, about thirty seconds. No new question,
   no new screen.
4. **NEGATIVE CONTROL.** A **non-interactive** run must still take the `auto` path and must
   write **zero** `owner_pref` rows and `chosenDirectionBy: "fallback"` or `"ui-designer"` as
   before. Assert the zero. Without it, a change that writes an `owner_pref` row on every run
   regardless of who picked would pass every other criterion here and quietly poison the store
   with model taste labelled as owner taste.
5. A second negative control: a POST naming a slug the manifest never declared must be refused
   by the existing `chooseDirection` guard, and must write no row.

**Must not.** Must not make a cron or unattended run park waiting for a click —
`designLockPolicy` returns `auto` for non-interactive precisely so unattended operation
finishes. Must not extend the design park's timeout. Must not ask the owner for anything beyond
the pick and one sentence.

**Depends on.** T7. **Reversible: R** (the code) **/ R-additive** (the rows).

---

### T9 — The screenshot deck, and the weekly label supply

**Goal.** A second deck builder over the 257 stored screenshots, so the store grows at a rate
its own kill criterion can pass.

**Why here.** Without it the plan measures a supply it never builds. T8 yields about two rows per
canvassed run; kill criterion 2 requires 40 rows per 14 days, so the criterion would fire
mechanically — not because branch B failed, but because nobody built the supply. T14's paired
test needs about 56 owner judgements at δ=0.20, and the "ESS ~54/week against branch A's 15"
argument rests entirely on this deck existing. It is a deck builder, not a new harness, because
T6 made `probe.mjs` deck-driven.

**Touches.**
- new `tools/taste/deck-screenshots.mjs`
- new `tools/taste/import-prefs.mjs` extension (or a second importer) writing `kind: 'screenshot'`
- reads the `screenshots` table in `dashboard/data/runs.db` (257 rows over 16 runs, labelled
  `home @ 375|768|1280`, `work @ …`, `design mockup — …`) and the files those rows point at
- writes `dashboard/data/taste/screenshots-<ISO>.jsonl`, then `owner_pref` rows

**Acceptance criteria.**
1. Pairs are built **like against like**: same label, therefore same route and same viewport.
   A `home @ 375` is never paired against a `home @ 1280`, and a gate capture is never paired
   against a design mockup.
2. The builder takes a target pair count (default 60, the ~10 minutes-a-week figure) and emits a
   deck that size or explains why it cannot.
3. Rows import into `owner_pref` with `kind: 'screenshot'`, `rater: 'owner'`, and the same
   duplicate and `chosen ∈ {item_a, item_b}` guards from T7 firing.
4. `rated_at` is written from the sitting, so kill criterion 2's 14-day window is readable
   straight off the column.
5. **NEGATIVE CONTROL, two.**
   (a) A deck request that would pair two screenshots with different labels must be **refused**,
   not silently emitted. Feed the builder a corpus where only cross-label pairs are possible and
   assert it explains rather than produces.
   (b) Order randomisation is inherited from `probe.mjs`, and the T6 randomiser test must be
   re-run against this deck — a deck builder that emits pairs already ordered by run recency
   would reintroduce a position confound the harness cannot see.
6. Presentation order across the whole deck is randomised, so consecutive pairs are not all from
   one run.

**Must not.** Must not exceed the ten-minutes-a-week budget by default. Must not ask for a score.
Must not pair a screenshot against a mockup of the same run and call it a preference about the
built site. Must not write to any existing table.

**Depends on.** T6, T7. **Reversible: R** (the code) **/ R-additive** (the rows).

---

### T10 — Extend the taste vocabulary with typography and colour

**Goal.** Make it possible to express an owner rule about type or palette at all.

**Why here.** `taste-policy.ts` defines 7 categories and 21 codes with no typography and no
colour category, and the parser rejects unknown codes at parse time. Of 342 gating criteria,
`palette`, `typograph`, `hierarch`, `composition`, `font`, `spacing` and `grid` appear zero
times each. Until the vocabulary widens, a rule induced from the owner's picks has nowhere to
land. Strictly additive.

**Touches.**
- `dashboard/server/src/taste-policy.ts` (`TASTE_CATEGORIES` :17, `TASTE_FINDING_CODES` :27,
  `TASTE_CODE_CATEGORY` :52, the prompt's category list and its code-to-category map)
- `dashboard/server/src/taste-policy.test.ts`
- `dashboard/server/src/rendered-taste-critic.test.ts`

**Acceptance criteria.**
1. Two new categories, `typography` and `colour`, each with codes, added to all three of
   `TASTE_CATEGORIES`, `TASTE_FINDING_CODES` and `TASTE_CODE_CATEGORY`, and to the prompt's
   own list — the map is serialised into the prompt, so a code missing from any one of them is
   a code the model is told about but the parser rejects, or vice versa.
2. The import is justified for typography, colour and hierarchy only, from the one external
   criteria set with above-chance designer agreement — nine dimensions covering typography,
   colour harmony, colour accuracy, visual hierarchy, mood and tone, and spatial accuracy
   (https://arxiv.org/abs/2605.20731, v2 2026-06-02). It is not a warrant to revisit the seven
   categories already there.
3. `MAX_TASTE_FINDINGS` (10) and `MAX_TASTE_FINDINGS_PER_CATEGORY` (2) are unchanged. Two new
   categories raise the theoretical ceiling; the total cap of 10 still binds.
4. **NEGATIVE CONTROL, three, all required — the extension must be additive, not a loosening.**
   (a) An **unknown** code must still fail at parse time. Adding categories must not turn the
   closed vocabulary into an open one.
   (b) A typography finding with **one** evidence object must still fail
   `MIN_TASTE_EVIDENCE_PER_FINDING = 2`. The new categories inherit every existing constraint.
   (c) A third typography finding in one output must still fail the per-category cap of 2.
5. Positive control alongside: a well-formed typography finding with two canonical evidence
   objects parses and is categorised correctly.

**Must not.** Must not remove or rename an existing category or code. Must not relax any cap or
minimum. Must not add a severity, score or weight to a finding. Must not change what the critic
gates.

**Depends on.** T3 (same file and same schema version; sequencing them avoids a collision).
**Reversible: R.**

---

### T11 — The withheld-rule harness

**Goal.** Before a rule is kept, prove the defect comes back when that rule is withheld.

**Why here.** This is the negative control for the learning tier itself, and it has to exist
before the store, or the store's first entries have no control attached. A rule the builder
would have obeyed anyway carries no information; without this harness there is no way to tell
those apart, and the store fills with descriptions of behaviour the system already had. This is
ours to build, not a port: the nearest published system's zero-injection control covers only
44.1% of its own against-prior denominator, 46.5% of its labels are hand-curated, and the clean
per-rule paired version was never run (https://arxiv.org/abs/2608.11727, 2026-08-12).

**Touches.**
- new `dashboard/server/src/withheld-rule.ts`, `dashboard/server/src/withheld-rule.test.ts`
- new `tools/taste/withhold.mjs` (the runner)
- reads the frozen spec and execution contract path already used by the build lane
  (`dashboard/server/src/execution-contract.ts`, `dashboard/server/src/build-prompt.ts`)
- writes results under `dashboard/data/taste/withheld/`

**Acceptance criteria.**
1. Given a rule pack and one frozen spec, it runs the same spec twice — full pack injected, and
   target rule withheld — and records, per rule: whether the withheld run reproduced the defect,
   the two prompts' hashes, and both artefacts.
2. `keepRule(result)` is a pure function and returns **false** unless a withheld run exists and
   reproduced the defect. There is no "assume it would have" branch.
3. **NEGATIVE CONTROL, and it must be shipped as a self-test.** Seed the harness with a rule the
   builder obeys anyway — something like "emit valid HTML" — and assert the harness **deletes**
   it rather than filing it. A harness that keeps every rule it is given is the failure mode
   this task exists to prevent, and only a rule that should be deleted can detect it.
4. Second negative control: a rule with **no** withheld run recorded must be refused by
   `keepRule`, not defaulted to kept. Assert the refusal explicitly (fail closed).
5. The pair of runs uses the same frozen spec, the same suite hash and the same seed inputs.
   Anything that differs between the two beyond the one withheld rule is recorded in the result
   and makes the comparison `unavailable`, not `kept`.

**Must not.** Must not modify the frozen spec, the held-out suite or its hash. Must not run
against a spec authored after the rule was written. Must not promote anything — this task
produces evidence, T14 decides on it.

**Depends on.** T7. **Reversible: R.**

---

### T12 — The derived, versioned rule pack

**Goal.** An append-only store of rules induced from owner picks, each carrying its provenance,
its withheld-run result, its version and an enabled flag.

**Why here.** After the harness, because a rule cannot be enabled without a control result and
the store must be unable to represent one that is. Retrieval is keyed to artefact or section
type, never concatenated globally: the measured failure mode of one accumulated global
preference string is that it scored **worse than no memory at all** — 65,218 and 57,915 edits
against 48,269 for no learning (https://arxiv.org/abs/2404.15269, v3 2024-11-23) — and unbounded
growth is the documented context-collapse path.

**Touches.**
- new `dashboard/server/src/taste-rules.ts`, `dashboard/server/src/taste-rules.test.ts`
- reads `owner_pref` (T7) and the withheld results (T11)
- writes `dashboard/data/taste/rules/v<N>.jsonl` — append-only files, one per version

**Acceptance criteria.**
1. Each rule carries: `rule_id`, rule text, `pref_ids[]` it was induced from, `artefact_kind`
   and `section` it applies to, `withheld_result`, `version`, `created_at`, `enabled`,
   `selected_at` (the selection timestamp, for T14's fresh-sample rule).
2. `enable(rule)` **throws** unless `withheld_result` shows the defect reproduced.
3. Versions are append-only. Rewriting or deleting a rule inside an earlier version **throws**.
4. `retrieve(artefactKind, section, budget)` returns rules for that artefact and section only,
   bounded by a hard maximum count and a token budget, de-duplicated.
5. **NEGATIVE CONTROL, four, each proving a guard fires.**
   (a) A rule without a passing withheld result must fail to enable — assert the throw.
   (b) An attempt to rewrite version N−1 must throw.
   (c) `retrieve` for section X must **not** return a rule scoped to section Y. A function that
   returns everything satisfies every other criterion here; this is the one it fails.
   (d) A pack of `cap + 1` eligible rules must return exactly `cap`. Assert the truncation
   happens, and assert which rules survived is deterministic.
6. No rule may reference or edit a criterion, a suite path or a suite hash. A test asserts the
   absence.

**Must not.** Must not concatenate all rules into one global string. Must not rewrite history.
Must not induce rules from picks authored by `ui-designer` or `fallback` — the store takes
**owner-authored picks only**; inducing from the incumbent's own past choices and feeding them
back to that seat is model taste laundered as owner taste. A test must assert that a pref row
whose rater is not the owner is refused.

**Depends on.** T7, T11. **Reversible: R-additive.**

---

### T13 — Injection behind one flag, with a per-run snapshot

**Goal.** Retrieved rules reach the design lane and the taste critic, behind a single boolean,
with an exact record of what was injected.

**Why here.** Last of the build tasks, because everything before it is what makes the effect
attributable: without the snapshot a movement cannot be told from a changed prompt, and without
the flag there is no revert.

**Touches.**
- `dashboard/server/src/design-prompt.ts` (`designSegmentPrompt` :154, stages `canvass` and
  `expand`)
- `dashboard/server/src/taste-policy.ts` (`buildTasteCriticPrompt`, the prompt tail)
- `dashboard/server/src/paths.ts` (`DASHBOARD_ENV`, one new name)
- `dashboard/server/src/design-prompt.test.ts`, `dashboard/server/src/taste-policy.test.ts`
- writes a snapshot into the run's `results/` directory

**Acceptance criteria.**
1. One boolean, one environment name, default **off**.
2. Rules reach only `designSegmentPrompt` and `buildTasteCriticPrompt`. Nothing else.
3. Each run writes `results/taste-injection.json`: the pack version, the exact rule ids
   injected, the retrieval key, and the resulting prompt hash.
4. The injected block is capped by both a rule count and a token budget, and
   `MAX_TASTE_PROMPT_CHARS` (40,000) still binds — the prompt builder already throws over it
   and must continue to.
5. **NEGATIVE CONTROL, three, and criterion (b) is the one that catches the usual bug.**
   (a) Flag **off** → the prompt is byte-identical to a golden hash. **Generate and commit that
   fixture from the build at HEAD, in a separate first commit, before touching
   `designSegmentPrompt` or `buildTasteCriticPrompt`.** A hash captured from post-edit code with
   the flag off passes tautologically even if the flag-off path drifted, which is exactly the
   check-that-can-only-succeed this repository keeps rebuilding.
   (b) Flag **on** with an **empty** pack → also byte-identical to the same golden hash. A
   naive implementation adds a header, a blank line or a "no rules apply" sentence and fails
   here; that difference would silently confound every later ON/OFF comparison.
   (c) Flag **on** with a known pack → the prompt contains exactly those rules, and
   `taste-injection.json` names exactly those ids. Assert both directions of the correspondence.
6. Flipping the flag off at runtime restores the byte-identical prompt with no rebuild and no
   migration.

**Must not.** Must not inject into the spec, plan, judge, fix or builder seats. Must not inject
into the sealed gate, the held-out suite or the scorer. Must not inject the defect ledger (§3).
Must not let the injected block grow without a cap. Must not read `owner_pref` directly — read
the rule pack, which has the withheld control attached.

**Depends on.** T12, T5 (the auto-memory channel must be known-closed before a prompt-content
comparison means anything). **Reversible: R-flag.**

---

### T14 — The promotion rule: tie goes to the incumbent, and fresh samples only

**Goal.** One decision function that says whether a rule or a pack version may be promoted, and
refuses in every case where the evidence cannot bear it.

**Why here.** Last, because it decides on everything before it, and because no promotion rule
for a quality change exists anywhere in this repository today. `applyDecisionRule`
(`bakeoff/src/contracts.ts:1547`) is a cost switch for a model bake-off: its second condition
hard-requires a ≥30% cut in dollars per held-out pass, and `dollarsPerHeldOutPass` is null at
zero passes, so it fails closed and structurally cannot promote a quality-only change. There is
no unsafe-promotion bug to patch; there is an absence.

**Touches.**
- new `dashboard/server/src/taste-promotion.ts`,
  `dashboard/server/src/taste-promotion.test.ts`
- imports `compareProportions` and `wilsonInterval` from `bakeoff/dist/analyze.js`
- reads `owner_pref` (T7), the rule pack (T12), `results/taste-injection.json` (T13)

**Acceptance criteria.**
1. **Tie goes to the incumbent.** Any difference whose interval straddles zero → do not promote.
   At our sample sizes this is the default outcome and the code must read as such, not as an
   exception branch.
2. **Paired McNemar** on the same artefact with the rule on and off, keyed on discordance, not
   on the marginals: `n = [z₀.₀₂₅√π_d + z₀.₂₀√(π_d − δ²)]²/δ²`. Reproduce the published table —
   at π_d=0.30: δ=0.30 → 24 pairs, δ=0.20 → 56, δ=0.15 → 102, δ=0.10 → 233; at π_d=0.20:
   δ=0.30 → 15, δ=0.20 → 37. π_d is **not** estimable from current data and the function must
   report it as measured from the batch in hand, never assumed.
3. **Fresh-sample confirmation** (https://arxiv.org/abs/1506.02629, v2 2015-09-25, taken as the
   principle, not as the Thresholdout algorithm — that needs an i.i.d. query object we do not
   have and a holdout orders of magnitude larger than our whole history). A change selected by
   inspecting past runs is re-measured only on runs created after its `selected_at`. Run ids are ISO-8601 prefixed, so this is a string
   comparison. A confirmation whose runs all predate `selected_at` returns **not confirmed**.
4. **Declare k.** The number of candidates compared before a winner was named is a required
   input, and the interval widens at α/k (https://www.jmlr.org/papers/v11/cawley10a.html, JMLR
   11:2079, 2010). Missing k → refuse, do not default to 1.
5. **Regression trip.** If the rules-ON arm is *below* rules-OFF with the interval excluding
   zero, the function returns `revert` — not `hold`, not `tune`. The pack version is kept for
   the record.
6. **NEGATIVE CONTROL, four, each proving the refusal fires.**
   (a) A straddling interval must return **not promoted**. A function that promotes on a point
   difference passes nothing else here.
   (b) A change confirmed only on the same runs it was selected from must return **not
   confirmed**. This is the standing rule made executable.
   (c) `k` omitted must throw.
   (d) A rules-ON arm below rules-OFF with an interval excluding zero must return `revert`.
   Assert all four; a stub returning `not promoted` for everything passes (a), (b), (c) and
   fails the positive control below.
7. Positive control: a genuinely large, fresh-sample, k-declared, non-straddling improvement
   returns `promote`. Without it, criterion 6 is satisfied by a function that never promotes
   anything.
8. **No LLM verdict gates on a single call.** Where the function consumes a model judgement it
   requires order-swapped agreement, and treats disagreement as `unavailable`, never `accept`.
   Judge-swap agreement on the nearest measured instrument is κ=0.163 against human agreement
   κ=0.515 (https://arxiv.org/abs/2608.11727, 2026-08-12), and order-swap consistency for a
   frontier pairwise judge is 65.0% (https://arxiv.org/abs/2306.05685, NeurIPS 2023 D&B, v4
   2023-12-24).

**Must not.** Must not touch `applyDecisionRule` — it fails closed, and reparameterising it
after seeing results is the reinterpretation its own comments forbid. Must not build an
aggregate-rate promotion path on `heldOutPass`: at 16 gated runs per arm the minimum detectable
effect is +42.4pp, so a promise to roll back if heldOutPass drops costs hundreds of runs to make
credible and is not a real guard (§3). Must not promote on any rate printed without its
denominator and interval.

**Depends on.** T1, T12, T13. **Reversible: R.**

---

## 3. Non-goals — these are NO, not future work

Each is excluded on measured grounds, with the source. A helpful session will otherwise add one,
and an uncited exclusion is an exclusion the next session overrides.

| Excluded | Why NO |
|---|---|
| **Injecting `dashboard/data/defects/*.jsonl` into a builder prompt** | The exact channel two independent groups measured. No pass-rate movement across three strategies and two agent families (https://arxiv.org/abs/2607.27250, 2026-07-28); context files do not generally improve task success while adding >20% inference cost (https://arxiv.org/abs/2602.11988, v2 2026-06-23). Note the honest bound: the first study's unit of analysis is the task, effective n is 15 and 17 clusters, and its own Monte Carlo puts the MDE above 30pp — so the claim is "no detectable effect and zero positive evidence", not "proven no-op". Our ledger is worse placed than theirs: 24 lines, 6 shards, one shard spanning four causes. It stays write-only. T4 fixes the signature so it *could* one day be read; it does not make it read. |
| **ICAI / ICAI+ as published** | Roughly 7,000 scored calls per constitution at the reduced setting, more at maintainer defaults; smallest split 520 train pairs (https://arxiv.org/abs/2406.06560, ICLR 2025; https://arxiv.org/abs/2606.30116, 2026-06-29). Inside the thousands-of-scored-calls exclusion. Separately, `inverse-cai` ingests text strings with **no image path at all** (https://github.com/rdnfn/icai, read 2026-09-04), so feeding it direction descriptions would induce rules about the writing rather than about the pixels the owner judged. |
| **Inducing rules from the picks already on disk** | Measured here, 2026-09-04: all 12 stored picks were authored by `ui-designer` (9) or `fallback` (3); `chosenDirectionBy` has never once read `owner`. Rules induced from them and injected back into `ui-designer` are that seat's own past choices laundered as owner taste. Owner-authored picks are a hard precondition, which is what T8 exists for. |
| **Any aggregate-rate promotion path for branch A** | 16 gated runs; MDE +42.4pp from 43.75%; detecting +10pp needs 388 per arm, 777 runs, about 194 days of continuous serial running with the pipeline frozen throughout (computed from measured, formula validated against https://cran.r-project.org/web/packages/pwr/vignettes/pwr-vignette.html, read 2026-09-04). We edit the pipeline weekly, so the arms would not be comparable. Unrunnable, not expensive. Selection inflation compounds it: best-of-k on a fixed history manufactures apparent gains with no real effect (https://www.jmlr.org/papers/v11/cawley10a.html, JMLR 11:2079, 2010). |
| **Any self-generated fitness signal for branch A** | A null model with no trainable parameters, returning one constant hand-written string, scored 76.8 LC on AlpacaEval 2.0 against a verified SOTA of 57.5; all three defences failed, and length control — built to reduce gameability — *rewarded* the attack (86.5 LC against 76.9 raw) (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral). Content-free "master keys" elicit false positive rewards from Claude-4-class judges (https://arxiv.org/abs/2507.08794, 2025-07). Boundary, stated plainly: every one of those results is text with pairwise or scalar scoring, with no image, render or DOM input anywhere — so our four rendered-quality judges are **unknown**, not known-broken, and the correct action is not to gate on them, not to declare them safe. |
| **Per-designer fine-tune (DesignPref headline arm), TASTE scoring heads, VAB's remedy, PrefEval's mitigation, FormatSpread's bandit** | All require weight updates or thousands of scored calls (https://arxiv.org/abs/2511.20513, 2025-11-25; https://arxiv.org/abs/2605.20731, v2 2026-06-02; https://arxiv.org/abs/2605.12684, 2026-05-12; https://arxiv.org/abs/2502.09597, ICLR 2025 Oral; https://arxiv.org/abs/2310.11324, ICLR 2024). Out by standing constraint. |
| **Targeting "the judge agrees with the owner more often" as the endpoint** | The runnable, no-weight-update arm gains +1.19 to +2.88pp over 2,400 held-out judgements resting on at most 600 unique pairs (https://arxiv.org/abs/2511.20513, 2025-11-25), against a ceiling where professional designers agree binary at 62.4% with Krippendorff α = 0.248 (same source) and the best off-the-shelf judge reaches 0.539 macro agreement against a 0.500 chance floor (https://arxiv.org/abs/2605.20731, v2 2026-06-02). Single-digit gains against that ceiling are undetectable at any n we can reach. The endpoint is owner accept/reject on the artefact. |
| **One global accumulated preference string** | Measured worse than no memory at all in the paper that proposes the method: a context-agnostic accumulated preference gave 65,218 and 57,915 edits against 48,269 for no learning; retrieval of raw past edits also lost, 32,405 against 31,103 (https://arxiv.org/abs/2404.15269, v3 2024-11-23). Corroborated in a preregistered human study where user-written preference text went net-negative against no elicitation in the emails domain (https://arxiv.org/abs/2310.11589, 2023-10-17). T12 keys retrieval to artefact and section for this reason. |
| **A surface-placement rule imported from the instruction-following literature** | The pilot ran nine older model builds over four synthetic conflict pairs, 6 of 9 per-build fits reproduced the ordering, and its own authors state the three leading surfaces are not statistically distinguished (https://arxiv.org/abs/2608.11727, 2026-08-12). Placement is an empirical question for T11. |
| **Design2Code's "self-revision degrades the model" result as a reason to gate** | That claim was a baseline artefact and is withdrawn; the correct comparison is up or flat (https://arxiv.org/abs/2403.03163, v3 2025-02-09). Gate revision on keep-if-better anyway, but justify it by the absence of confidence intervals and the single generation per model per method — not by a degradation that was not measured. |

**Recorded, not built:** re-emitting the creative contract mid-session.
`creativeContractPrompt` (`creative-pilot.ts:792`) has three call sites, all at the top of a
session that then runs for hours, with no mid-segment re-emission. Restating a preference next
to the generating turn was the best non-fine-tuning mitigation in the one place it was measured
(https://arxiv.org/abs/2502.09597, ICLR 2025 Oral) — but that evidence is text-only
conversational recommendation over 20 lifestyle topics and bounds nothing about a multi-hour
code-writing agent. Plausible and unevidenced for our domain. Do not spend the first weeks on it.

---

## 4. Kill criteria, mapped to what observes them

| # | Condition | Observed by | Action |
|---|---|---|---|
| 1 | Owner agrees with the incumbent on ≥16 of the 18 `ui-designer` pairs | T6 / **G1** | **Stop.** No taste gap in that seat |
| 1b | Agreement with `fallback` ≈ agreement with `ui-designer` | T6 / **G1** | The statistic tracks manifest order, not judgement. Report it; treat the headline as weaker |
| 2 | Fewer than 40 new `owner_pref` rows in any 14-day window, read off `rated_at` | T7 (column), T8 + **T9** (supply) | Kill, or renegotiate cadence explicitly |
| 3 | ρ on the first 30 owner labels > 0.8 | T2 estimator, re-run on `owner_pref` | Density argument dies; six labels per run buy about two. **Quote no branch B power figure before this is measured** |
| 4 | More than half of the first 10 rules have a clean withheld run | T11 | The rules describe behaviour the builder already had; the store is recording noise |
| 5 | Owner test–retest below ~70% on ~15 pairs re-presented at ≥2 weeks | **G2** (re-run `probe.mjs` on the same deck; T6 criterion 8 makes this possible) | Endpoint ceiling too low. Kill |
| 6 | Two consecutive ON/OFF batches whose interval straddles zero, or π_d < 0.10 | T14 | Kill the injection path; keep the store as an owner-facing record with no prompt injection |
| 7 | Rules-ON accept rate below rules-OFF with the interval excluding zero | T14 | Revert the flag immediately. Keep the pack version. **Do not tune** |
| 8 | After 10 attempts, no defect signature produces a red-before / green-after / mutation-red triple clearing `decide()` on a non-synthetic proposal | `tools/tier3/gate.mjs:245`, `dashboard/data/tier3/index.jsonl` | Close the branch A carve-out |

**G2 — OWNER GATE: the re-sitting *(not a Codex task)*.** At least two weeks after G1, re-run
`probe.mjs` on about fifteen pairs from the same deck file and compare the two JSONL files. This
is **not** what T6's planted order-swapped repeat measures: that repeat catches within-sitting
order bias, which is a different construct from test–retest at distance. Nobody builds this if
the table pretends criterion 5 is already covered, so it is named here as its own gate.
Reversible: the deck and both response files are kept; nothing is destroyed.

---

## 5. Order, dependencies and what survives abandonment

```
T1 baseline ──┬── T2 ICC
              └──────────────────────────────────────────────── T14 promotion
T3 critic split ── T10 vocabulary ──────────────────────────────┐
T4 defect signature (independent)                               │
T5 auto-memory canary ──────────────────────────────┐           │
T6 pick harness ── G1 SITTING ── T7 owner_pref ──┬── T8 live pick
                       │                         ├── T9 screenshot deck ── G2 RE-SITTING
                       └─────────────────────────┴── T11 withheld ── T12 pack ── T13 injection
```

| Task | Depends on | Reversible | Survives branch B being killed at G1? |
|---|---|---|---|
| T1 baseline | — | R | **Yes** — instrument |
| T2 ICC | T1 | R | **Yes** — instrument |
| T3 critic split | — | R | **Yes** — live bug fix |
| T4 defect signature | — | R | **Yes** — needed by the branch A carve-out |
| T5 auto-memory canary | — | R | **Yes** — a sealed-seat leak matters either way |
| T6 pick harness | — | R | **Yes** — it is the kill instrument |
| **G1 the sitting** | T6 | **NOT-R** | it is the gate |
| T7 `owner_pref` | T6, G1 | R-additive | No |
| T8 live owner pick | T7 | R / R-additive | No |
| T9 screenshot deck | T6, T7 | R / R-additive | No |
| T10 vocabulary | T3 | R | Partly — a wider critic vocabulary is useful alone |
| T11 withheld harness | T7 | R | No |
| T12 rule pack | T7, T11 | R-additive | No |
| T13 injection | T12, T5 | R-flag | No |
| **G2 the re-sitting** | T9, G1, +14 days | R | No |
| T14 promotion rule | T1, T12, T13 | R | Partly — the fresh-sample and tie rules generalise |

**Cadence the plan assumes, and it must not grow.** One sitting of about fifteen minutes for
G1; about thirty seconds per canvassed run for T8; about ten minutes a week of pairwise picks
over stored screenshots for T9. Below roughly ten minutes a week the store grows at about one
item per run — branch A's rate — and the only structural advantage this branch has disappears.

**What to expect, said plainly.** No primary source in the research pack shows a persisted
preference store improving a *generator*. ICAI and EvalGen improve evaluators
(https://arxiv.org/abs/2406.06560, ICLR 2025; https://arxiv.org/abs/2404.12272, UIST 2024, doi
10.1145/3654777.3676450); CIPHER's authors state there is no distinction between training and
testing in their setting (https://arxiv.org/abs/2404.15269, v3 2024-11-23); DesignPref and TASTE
produce scorers (https://arxiv.org/abs/2511.20513, 2025-11-25; https://arxiv.org/abs/2605.20731,
v2 2026-06-02). The case for building this is falsifiability and marginal cost per observation,
not demonstrated efficacy: a branch A observation costs six to twelve machine hours and has a
measured 47% chance of yielding no verdict at all (14 of 30 runs, measured 2026-09-04), while a
branch B observation costs about ten seconds of owner attention and cannot fail to yield one.
Expect **no measurable `heldOutPass` movement** and do not claim any — 0 of 342 criteria say
anything about palette, typography, hierarchy or composition, so `heldOutPass` is the wrong
instrument for what this plan changes.

One calibration to carry into T14 and never forget: judge fidelity does not predict judge
gameability, and in the one place both were measured the correlation ran the wrong way — the
annotator agreeing with humans at 69.2 was the one the attack scored 76.8 against, while the
annotator at 68.8 scored it 0.4 (https://arxiv.org/abs/2410.07137, ICLR 2025 Oral). **Showing
that a taste rule agrees with the owner on a sample is not evidence it is safe to optimise
against on unreviewed runs.** Those are two different properties.
