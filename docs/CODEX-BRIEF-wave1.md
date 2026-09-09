# Codex brief: learning-loop wave 1 (T1 to T5)

## Mission

This repository turns a plain-English ticket into a built website, then grades it with an
acceptance suite the builder never sees. It works, but the sites it delivers are worse than
what the same model produces in an interactive chat. Research is finished and the cause is
known. Your job is wave 1 of the fix: **build the measurement instruments first.** No
learning, no prompt changes, no critic tuning in this wave. We cannot detect an improvement
we cannot measure, and today there is no baseline at all.

## Read first, in this order

Do not read these end to end. They are large. Read the sections named.

| File | Read |
|---|---|
| `docs/PLAN-learning-loop-tasks-2026-09-04.md` | **All of it.** This is your specification. Tasks T1 to T14 and owner gates G1, G2 |
| `docs/RESEARCH-learning-loop-2026-09-04.md` | Sections 5 (the arithmetic), 6 (regression control), 7 (what to build) |
| `docs/FINDINGS-2026-09-02-pipeline-vs-chat.md` | All of it. 3,000 words. The five measured causes |
| `docs/COMPARISON-2026-09-03-prior-art-vs-internal-findings.md` | Section 6 (combined priority list) and 7A (cross-session findings) |
| `docs/STATE.md`, `docs/CAPABILITIES.md`, `docs/BACKLOG.md` | All. Short. Current state and what is unproven |
| `docs/RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md` | Only if a task cites it. 20,000 words, reference only |

## Ground rules, non-negotiable

1. **Every check needs a negative control.** This repository's signature defect is a check
   that can only observe success. For each test you write, break the thing it watches,
   confirm it goes red *for the reason you intended*, restore, confirm green. A test that
   survives its mutation is a finding: report it, never quietly fix it.
2. **Verify, never relay.** Do not state a behaviour, API shape or number from a document.
   Confirm it against the code or the database yourself. The docs above are correct as of
   their dates, and line numbers drift.
3. **Nothing may promote itself on evidence measured only on the runs that produced it.**
4. **No fine-tuning, no weight updates.** Every seat is a CLI subprocess.
5. **One change per commit.** Subject line 60 chars max, no dash punctuation, no AI
   attribution of any kind. Types: feat, fix, refactor, chore, docs, note, test. Read
   `~/.claude/COMMIT-CONVENTION.md` if a call is unclear.
6. **Do not touch** the frozen acceptance suites under `dashboard/acceptance/`, the sealed
   scorer, or any prompt file in this wave.

## The tasks

Take them in order. Each is one session. Full acceptance criteria are in the plan document
under the matching heading; the summary here is orientation, not a substitute.

**T1, the baseline instrument.** A read-only CLI printing every rate with its denominator
and a Wilson interval. It must key off `held_out_pass IS NOT NULL`, never `status`. This
matters: the database has 30 runs but only 16 gate verdicts, 7 pass and 9 fail. A rate over
30 is wrong. Ships `requiredRuns(baseRate, delta)`, which refuses under a gated denominator
of 10, and writes a timestamped baseline file under `docs/baseline/`. New files in
`dashboard/server/src/`. Reuse `wilsonInterval` from `bakeoff/dist/analyze.js`; the server
already imports nine bakeoff modules, so no vendoring. Negative controls are specified in
the plan, including one trap: do not assert `(0,30) != [0,0]`, which passes against a stub.

**T2, the clustering estimator.** One-way ANOVA intracluster correlation, design effect and
effective sample size. Criteria within a run are not independent observations, so a naive n
overstates our evidence. Pinned values to reproduce are in the plan. Needs two negative
controls in opposite directions, because a constant-returning stub passes a single one.

**T3, split accept from no-evidence in the taste critic.** This is a live bug, not
learning-tier work. The critic returns `accept` when its findings array is empty, the prompt
tells the model an empty array is correct when evidence is insufficient, and `accept`
publishes. So insufficient evidence publishes. Add a required `evidenceSufficient` boolean,
widen the disposition type, bump the schema version. Six consumer files are named in the
plan. Both negative controls are required: empty findings with insufficient evidence must
not publish, and empty findings with sufficient evidence must still publish.

**T4, version the defect signature** so unlike failures stop colliding in the ledger.

**T5, probe the sealed-seat auto-memory channel.** A canary. If a sealed seat can read or
write memory across runs, that is a leak in the held-out boundary and it matters whether or
not we ever build the learning tier.

Stop after T5 and report. T6 onwards depends on an owner decision that has not been made.

## Running and testing

Work in three stages. Do not skip to stage 3.

**Stage 1, offline.** Everything in wave 1 can be built and tested against artefacts already
on disk: 30 runs under `dashboard/runs/`, the database at `dashboard/data/runs.db`, and
14 `results/design-lock.json` files. Prefer fixture databases you construct over the live
one. Never write to `dashboard/data/runs.db`.

```
cd dashboard/server && npm run typecheck && npm test     # tsc, then node --test over dist
cd dashboard && npm run typecheck && npm run lint
```

The server test script builds first, so a stale `dist/` is a common cause of a confusing
pass. Run `npm run clean` if a result looks impossible.

**Stage 2, the live surfaces.** Two processes, both loopback only.

```
cd dashboard/server && npm start          # API on 127.0.0.1:4176
cd dashboard && npm run dev               # Next on 127.0.0.1:4319, proxies /api to 4176
```

Browser tests are Playwright from `dashboard/`. `npm test` there runs them and the pretest
step installs Chromium.

**Stage 3, a real pipeline run.** A run takes between one and twelve hours and spends real
model budget, so this is gated.

- Do not start one to satisfy curiosity or to "check nothing broke". Stages 1 and 2 cover
  wave 1 in full.
- Start one only when a task's acceptance criteria cannot be met any other way, and say so
  explicitly in your report before you do it.
- A run is submitted by POST to `/api/runs`. Read the intake handler before calling it. The
  proxy carries a six-minute timeout, and an accepted request can take that long to fail.
- If you do start one, watch it rather than blocking: runs write to `dashboard/runs/<run-id>/`
  and events land in the `events` table keyed by `run_id`. In that table a `{"type":"tool"}`
  row is an **attempt**; the adjacent `{"type":"graph_hook","event":"PreToolUse"}` row carries
  the **outcome**. Never cite the first without the second.
- Never kill a run that is mid-build without saying so.

## What to report back

For each task: what you changed, the negative control you ran and what it did when mutated,
the commands you ran with their real output, and anything the plan document got wrong. If a
document contradicts the code, the code wins and the contradiction is a finding worth
recording.

If you disagree with a task's design, say so before implementing it, not after.
