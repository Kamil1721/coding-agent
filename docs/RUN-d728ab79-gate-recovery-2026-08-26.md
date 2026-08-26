# RUN `d728ab79` gate recovery — sealed scoring reached a real red verdict

2026-08-26. Commit `56aa163` shipped the isolated no-verdict recovery path and
the first live child exercised it. The recovery succeeded as a recovery: it
preserved the source and produced a correctly attributed boolean acceptance
result. The artifact did not pass.

## Terminal result

| Record | Outcome |
|---|---|
| Source `run-2026-08-25T10-30-39-122Z-d728ab79` | failed / done; `heldOutPass: null`; `falseFinish: null`; `gateStopReason: infra`; immutable **NO VERDICT** |
| Child `run-gate-recovery-5ffc96e73d39737f4b2bb197` | failed / done; `heldOutPass: false`; `falseFinish: true`; `gateStopReason: not-converging` |
| Frozen suite | `b2f55a56882ec439b988ece9c4a368f7c0ac1aebe11aae8b1e3e50b4fe9c60b2` |
| Scorer image | `sha256:5c7a112cbea76741ea375bd32486d4d7fea25275e8cf8bc325b26067df62a18b` |
| Recovery-time scorer-visible snapshots | source = child = `ec59faea05d546f71e82785b328bf2cc72b22ae2cc818d96743f40fa2f96829b` |

The child persisted 16 frozen criterion failures, 12 machine gate records, and
0 screenshots. [`recovery.json`](../dashboard/runs/run-gate-recovery-5ffc96e73d39737f4b2bb197/results/recovery.json)
records `state: completed` and terminal error “the frozen held-out suite did not
go green in gate-only recovery.” The
[sealed score](../dashboard/results/scores/run-gate-recovery-5ffc96e73d39737f4b2bb197.json)
contains the boolean verdict.

## Why the red result is real

`GATE:boot` is the decisive failure. The frozen manifest intentionally selected
STATIC mode from the ticket's requested behavior: `execution.start` is `null`.
The spec seat authors this contract before any implementation exists and is
explicitly forbidden to infer mode from whatever the builder later ships.

The builder nevertheless delivered a Node server-only artifact. Its
`package.json` says `start: node server.mjs`, and the artifact has no root
`index.html`. The sealed scorer correctly followed the frozen contract and
served the artifact directory statically. `/` returned HTTP 404 for approximately
30 seconds across 118 attempts, so routes and screenshots were not reached and
the suite did not execute. All 16 REQs are therefore **unasserted**, not 16
independently observed product defects.

This is a static delivery-contract and builder-handoff enforcement failure. It
is not an infrastructure failure, not missing manifest discovery, and not a
scorer-mode error.

## Immutability and isolation

Before and after recovery, the whole source run tree had 213 entries and logical
content-plus-metadata hash
`e9e86c5276d296670d6c08b97f66b106ec328a2e09f0a13c862b6837e4d67edf`.
Source-owned database counts were unchanged:

| Table | Count |
|---|---:|
| runs | 1 |
| criteria | 16 |
| events | 1004 |
| messages | 21 |
| message_requests | 4 |
| screenshots | 13 |
| run_attempts | 6 |
| seat_spend | 4 |
| metered_spend | 2 |
| run_continuations | 0 |

Their logical hash remained
`9b085d2adf581f9f957f70ed1d1b6145440bde543d096729c5690e5378f14935`.

The child had 0 messages, run attempts, seat-spend rows, and metered-spend rows.
Its events contain only phase/log/status, 16 criterion results, the verdict, and
terminal status. Both its
[`run.log`](../dashboard/runs/run-gate-recovery-5ffc96e73d39737f4b2bb197/results/run.log)
and recovery metadata state that builder, fixer, model, critic, Context7, judge,
adversary, and publisher did not run. Taste Critic is explicitly `not-run`
because gate-only recovery makes no model calls. Design files copied into the
child belong to the source snapshot; they do not show that recovery design work
ran.

## Verification and boundary

Targeted server and client typechecks were green. Recovery, contract, security,
and store coverage passed `56/56`; final code, security, and debug reviews
approved. The last full server run before the final focused fix was 2485 total /
2479 pass / 3 fail / 3 skip. The feature parity failure was then fixed and
targeted verification passed, leaving two known pre-existing live-fixture
failures: the source continuation-count hardcode and a malformed live design
manifest. The full suite was not rerun after that focused fix.

The accepted residual is a same-OS-user pathname-swap TOCTOU, not a static
precreated-path vulnerability. The live result verifies terminal-red recovery.
Green recovery, crash/boot reconciliation, and the full Taste chain remain
unproven.

## Next action

`ARTIFACT-BOOT-001` must propagate and enforce the frozen execution contract
before and during build, require a root document for static tickets, and add a
pre-gate contract check with a negative control. After that, run a normal
end-to-end replacement or continuation that reaches the suite, screenshots, and
Taste chain. Track it in [BACKLOG.md](BACKLOG.md).
