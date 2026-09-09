---
document_status: authoritative-navigation
last_verified: 2026-08-26
verified_at_commit: c4c9f37
---

# Documentation map

For a new Claude or Codex session, read in this order:

1. [STATE.md](STATE.md) — authoritative current repository and latest-run state.
2. [CAPABILITIES.md](CAPABILITIES.md) — evidence-based implementation status.
3. [BACKLOG.md](BACKLOG.md) — unfinished work that must survive handoffs.
4. [HANDOVER.md](HANDOVER.md) — historical map and hard-won operational facts.
5. Follow links to the relevant run report or design document only when needed.

## Authority classes

### Living and authoritative

- [STATE.md](STATE.md)
- [CAPABILITIES.md](CAPABILITIES.md)
- [BACKLOG.md](BACKLOG.md)
- This navigation file

These files must be verified against the repository and persisted run artifacts at
every handoff. Their stable filenames are deliberate.

### Historical reports

Run, session, finding, and dated state reports describe what was measured at a
particular time. They are not current-state authorities. The latest evidence is the
[Progression Labs source-and-continuation report](RUN-3c0e92be-and-continuation-2026-08-26.md).
The earlier [gate-recovery report](RUN-d728ab79-gate-recovery-2026-08-26.md) and
[creative-park report](RUN-d728ab79-creative-park-2026-08-25.md) retain their
original run history.

### Historical evidence index

| Run | Outcome at the time | Why it is retained |
|---|---|---|
| [`3c0e92be` + `e22fa17f`](RUN-3c0e92be-and-continuation-2026-08-26.md) | source failed 29/31 twice; linked continuation passed 32/32, but critic unavailable | First live green linked continuation over the failed workspace. It also proves that sealed green did not imply rendered-critic, Context7, adversary, or publication completion. |
| [`d728ab79` recovery child](RUN-d728ab79-gate-recovery-2026-08-26.md) | failed; `heldOutPass: false`, false finish | First live immutable gate-only recovery. It proves the terminal-red recovery path and identifies the STATIC delivery-contract failure. |
| [`d728ab79` source](RUN-d728ab79-creative-park-2026-08-25.md) | **NO VERDICT**; scorer not reached | Original creative-park/repair evidence. The child does not mutate or retroactively score it. |
| [`b1219c2d`](RUN-b1219c2d-breakdown-2026-08-18.md) | failed; `held_out_pass=0`, false finish | Pre-fix forensic ledger used by the capability/continuation design and included in this documentation checkpoint. |

### Design intent

Files beginning with `DESIGN-`, plus plans and specs under `superpowers/`, describe
proposals or intended behavior. They are not proof of implementation. The current
status of the capability, continuation, and creative-quality proposals is recorded in
[CAPABILITIES.md](CAPABILITIES.md).

## Maintenance contract

- After a commit: update affected capability rows and architecture/operations docs
  in the same change when behavior changed.
- After every terminal run, successful or failed: close its historical report and
  update `STATE.md` with the actual verdict boundary.
- Do not overwrite historical reports with later outcomes; add a dated correction
  at the top and link the newer evidence.
- Link to evidence rather than duplicating long narratives.
- Record every deferred or blocked item in `BACKLOG.md` before ending a handoff.
- A model's self-report, a design, or a recovered prerequisite is never sufficient
  to promote a capability to verified.
