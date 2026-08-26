---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: ba8ae81
---

# Current repository state

This is the stable starting point for a new Claude or Codex session. It records
what is true now; dated run reports and design documents are evidence and intent,
not substitutes for this file.

## Repository checkpoint

- Repository: `/Users/kamilborzecki/Projects/coding-agent`
- Verified code baseline: `ba8ae81` on `main`.
- Immediate predecessor: `e53f9f1`.
- Code-baseline commit chain, newest first:
  - `ba8ae81` — `fix(runtime): gate spend on executable scorer readiness`
  - `e53f9f1` — `test(dashboard): cover machine-check result surfaces`
  - `624e564` — `docs: record run d728ab79 creative-park breakdown and fixes`
  - `7abd149` — `fix(dashboard): park-aware waiting notice and parked chat copy`
  - `259130f` — `feat(creative): bounded author retries and partial safe repairs`

Before the documentation checkpoint was committed, `main` was measured five commits
ahead of `origin/main`. That is provenance, not a durable current-state claim. After
every commit or push, verify the live branch, divergence, and worktree directly with
`git status --short --branch` and `git log --oneline --decorate -8`.

## Latest run

Run: `run-2026-08-25T10-30-39-122Z-d728ab79`

- Final pipeline outcome: **failed before the sealed scorer ran**. The terminal
  failure was the scorer prerequisite inspection of `bakeoff-scorer:1`:
  `docker image inspect` returned an invalid usage shape / exit `-1`.
- Acceptance outcome: **NO VERDICT**.
- `heldOutPass`: `null`.
- The builder artifact records `status: "completed"` and
  `agentDeclaredDone: true`; those fields describe the build session, not a held-out
  acceptance result.
- No sealed score was produced and no Taste Critic result exists for this run.
- Executable scorer readiness is now verified in tests and by a live smoke against
  digest `sha256:5c7a112cbea76741ea375bd32486d4d7fea25275e8cf8bc325b26067df62a18b`.
  That prevents a repeat of this pre-spend prerequisite failure; it does not
  retroactively score this run. No gate-only recovery or controlled replacement
  run has been recorded.

Primary evidence:

- [Final run report](RUN-d728ab79-creative-park-2026-08-25.md)
- [`results/verdict.md`](../dashboard/runs/run-2026-08-25T10-30-39-122Z-d728ab79/results/verdict.md)
- [`results/creative-status.json`](../dashboard/runs/run-2026-08-25T10-30-39-122Z-d728ab79/results/creative-status.json)
- [`results/run.json`](../dashboard/runs/run-2026-08-25T10-30-39-122Z-d728ab79/results/run.json)

## Shipped and verified at this checkpoint

Commit `ba8ae81` adds a fail-closed, uncached executable-scorer readiness barrier
before direct POST writes, captures, and model spend, plus a second fresh check at
queue entry. Unavailable or unknown readiness parks queued runs without attempts or
model spend; cancellation and shutdown are supported. Shared admission defaults to
one active smoke and eight queued.

Runtime smoke v2 dynamically imports the runner/config, validates Playwright and
the sealed environment, launches and closes Chromium under the scoring Docker seal,
resolves the mutable image tag to an exact digest, and runs with sanitized env, no
mounts, bounded time/output, and named-container cleanup. The seal parser validates
the actual first image operand and has negative controls. A live smoke passed with
Node `v24.18.0`, Playwright `1.62.0`, and Chromium `151.0.7922.34`.

Direct intake now requires JSON and, when `Origin` is present, the exact dashboard
origin. Originless loopback automation remains intentionally supported. A disconnect
during reference or motion capture cannot create a run row, files, or pump work. The
HTTP handler stops awaiting the capture; the underlying Playwright operation is not
force-cancelled, but remains bounded and cleans up.

Verification recorded for this checkpoint: scorer runtime `9/9`, dashboard
readiness/pre-spend `14/14`, machine-check result surfaces `8/8`, and a broad
affected-dashboard run at `188/189`. Its sole capture-race failure was fixed; only the
affected 14-test suite was then rerun and it passed `14/14`. Security and code review
reported no remaining P1/P2 blocker.

Do not infer implementation from
[the capability and continuation design](DESIGN-capability-and-continuation-2026-08-19.md).
In particular, the proposed capability-supply system, durable project
continuation, and a proven scorer rescore path are not established as implemented.
See [CAPABILITIES.md](CAPABILITIES.md) for the evidence-based matrix.

## Active next step

Implement a strict gate-recovery child run or controlled replacement for `d728ab79`:
keep the source immutable, use the exact frozen suite and snapshot, and permit no
builder, model, or fixer spend. Only then execute it. Completion requires a new,
correctly attributed verdict artifact and boolean `heldOutPass`; the original run
must remain **NO VERDICT**. See `SCORE-001` in [BACKLOG.md](BACKLOG.md).

## Maintenance rule

Update this file after every repository-state handoff and after every terminal
run. Verify HEAD, upstream divergence, the dirty tree, the latest run artifacts,
and blockers directly. Update [CAPABILITIES.md](CAPABILITIES.md) only when code plus
test or run evidence changes a capability's status; append new work that cannot be
finished to [BACKLOG.md](BACKLOG.md).
