---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: 56aa163
---

# Current repository state

This is the stable starting point for a new Claude or Codex session. Dated run
reports are evidence, not substitutes for this file.

## Repository checkpoint

- Repository: `/Users/kamilborzecki/Projects/coding-agent`
- Clean pushed baseline: `56aa163` (`feat(gate): add isolated no-verdict recovery`).
- `HEAD`, `main`, and `origin/main` were equal when this state was verified.
- Immediate predecessor: `55d426e`.

Recheck the branch, upstream divergence, and worktree directly after every commit
or push; do not carry this checkpoint forward as an assumption.

## Latest source and recovery runs

Source: `run-2026-08-25T10-30-39-122Z-d728ab79`

- The original remains immutable at **failed / done**, `heldOutPass: null`,
  `falseFinish: null`, and `gateStopReason: infra`: its terminal outcome is still
  **NO VERDICT**.
- Before and after recovery, its whole run tree had 213 entries and logical
  content-plus-metadata hash
  `e9e86c5276d296670d6c08b97f66b106ec328a2e09f0a13c862b6837e4d67edf`.
- Its database-owned records were unchanged: runs 1, criteria 16, events 1004,
  messages 21, message requests 4, screenshots 13, run attempts 6, seat spend 4,
  metered spend 2, continuations 0. Their logical hash remained
  `9b085d2adf581f9f957f70ed1d1b6145440bde543d096729c5690e5378f14935`.

Recovery child: `run-gate-recovery-5ffc96e73d39737f4b2bb197`

- The child completed a real sealed score at **failed / done** with
  `heldOutPass: false`, `falseFinish: true`, and
  `gateStopReason: not-converging`.
- It used the exact frozen suite
  `b2f55a56882ec439b988ece9c4a368f7c0ac1aebe11aae8b1e3e50b4fe9c60b2`
  and scorer image
  `sha256:5c7a112cbea76741ea375bd32486d4d7fea25275e8cf8bc325b26067df62a18b`.
  The recovery-time scorer-visible source and child snapshot digests both equal
  `ec59faea05d546f71e82785b328bf2cc72b22ae2cc818d96743f40fa2f96829b`.
- The child persisted 16 frozen criterion failures, 12 machine gate records, and
  0 screenshots. It had 0 messages, run attempts, seat-spend rows, or
  metered-spend rows. Its events are limited to phase/log/status, the 16 criterion
  results, the verdict, and terminal status.
- Builder, fixer, model, critic, Context7, judge, adversary, and publisher did not
  run. Taste Critic is explicitly `not-run` because gate-only recovery makes no
  model calls. Copied source design files are snapshot evidence, not recovery
  design work.

Primary evidence:

- [Gate-recovery report](RUN-d728ab79-gate-recovery-2026-08-26.md)
- [Original run report](RUN-d728ab79-creative-park-2026-08-25.md)
- [Recovery metadata](../dashboard/runs/run-gate-recovery-5ffc96e73d39737f4b2bb197/results/recovery.json)
- [Sealed score](../dashboard/results/scores/run-gate-recovery-5ffc96e73d39737f4b2bb197.json)

## Decisive result

The real red is `GATE:boot`. The suite manifest intentionally chose STATIC mode
from ticket behavior (`execution.start: null`) before the build; the authoring
contract forbids choosing mode from whatever the builder later ships. The builder
nevertheless delivered a Node server-only artifact (`start: node server.mjs`) and
no root `index.html`. The scorer correctly served the artifact root statically;
`/` returned 404 for about 30 seconds across 118 attempts. Routes, screenshots,
and the suite therefore did not run, and all 16 requirements were unasserted.

This is a static delivery-contract and handoff-enforcement failure. It is not an
infrastructure failure, not a manifest-discovery bug, and not evidence of 16
independently observed product defects.

## Shipped and verified at this checkpoint

Commit `56aa163` ships an isolated no-verdict recovery child with source
immutability, exact suite/snapshot attribution, no build or model path, negative
controls, and terminal result persistence. Targeted server and client typechecks
were green; recovery, contract, security, and store coverage passed `56/56`.
Final code, security, and debug reviews approved the feature.

The last full server run before the final focused fix was 2485 total / 2479 pass /
3 fail / 3 skip. The feature parity failure was then fixed and targeted
verification passed, leaving two known pre-existing live-fixture failures: a
hard-coded source continuation count and a malformed live design manifest. The
full suite was not rerun after that focused fix.

The accepted residual is a same-OS-user pathname-swap TOCTOU. This is not the
precreated-path vulnerability covered by the security controls.

Gate-only recovery is verified for this terminal-red path. A green recovery and
crash/boot reconciliation remain unproven; this does not establish full-pipeline
or Taste-chain reliability. See [CAPABILITIES.md](CAPABILITIES.md).

## Active next step

Implement `ARTIFACT-BOOT-001`: propagate and enforce the frozen execution contract
before and during build, require a root document for static tickets, and add a
pre-gate contract check with a negative control. Then run a normal end-to-end
replacement or continuation that reaches the held-out suite, screenshots, and
Taste chain. See [BACKLOG.md](BACKLOG.md).

## Maintenance rule

Update this file after every repository-state handoff and terminal run. Verify
HEAD, upstream divergence, the dirty tree, run artifacts, and blockers directly.
Promote [CAPABILITIES.md](CAPABILITIES.md) only with code plus test or run evidence,
and carry unfinished work in [BACKLOG.md](BACKLOG.md).
