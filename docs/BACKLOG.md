---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: 56aa163
---

# Durable backlog

This is the carry-forward list for work that is unfinished or not yet verified.
It records outcomes, not speculative implementation instructions.

| ID | Priority | Status | Work | Done when | Evidence |
|---|---|---|---|---|---|
| DOC-001 | P0 | open | Reconcile the stale state claims in `dashboard/README.md` and `dashboard/STATUS.md` with the stable living state document. | Both files either contain current verified facts or explicitly point to `docs/STATE.md`; no second editable source of current state remains. | [STATE.md](STATE.md) |
| SCORE-001 | P0 | resolved | Implement a controlled replacement or strict gate-recovery child run for `d728ab79`. | The live child preserved the source, attributed the exact frozen suite and recovery-time snapshot, ran no builder/model/fixer path, and passed code plus negative controls. | [Recovery evidence](RUN-d728ab79-gate-recovery-2026-08-26.md#immutability-and-isolation) |
| SCORE-002 | P0 | resolved | Produce a real terminal acceptance result after recovery. | The child has boolean `heldOutPass: false`; the source remains **NO VERDICT**. Taste Critic is explicitly `not-run`, which is correct for a no-model gate-only recovery. The goal was a boolean result, not a green result. | [Terminal result](RUN-d728ab79-gate-recovery-2026-08-26.md#terminal-result) |
| ARTIFACT-BOOT-001 | P0 | open | Propagate and enforce the frozen execution contract before and during build so a STATIC ticket must deliver a root document. Add a pre-gate contract check and negative control. | A normal end-to-end replacement or continuation delivers the declared mode, reaches the held-out suite and screenshots, and records the Taste-chain outcome. | [Decisive recovery finding](RUN-d728ab79-gate-recovery-2026-08-26.md#why-the-red-result-is-real) |
| READY-001 | P0 | open | Add the direct first scorer-readiness barrier to supervisor/cron intake. | Those intake paths fail closed before their first write or spend; the existing queue-entry recheck remains the second barrier. | [Capability boundary](CAPABILITIES.md) |
| TEST-001 | P0 | resolved | Result-surface coverage is committed and verified. | Commit `e53f9f1` exists and the browser result-surface suite passes `8/8`. | [Capability matrix](CAPABILITIES.md) |
| GIT-001 | P0 | resolved | The owner-authorized code and documentation checkpoint was committed and pushed. | `origin/main` contains checkpoint `31ea136`; post-push divergence was `0 0` before this closure commit. | [Repository checkpoint](STATE.md#repository-checkpoint) |
| DOC-002 | P1 | resolved by checkpoint | Include `RUN-b1219c2d-breakdown-2026-08-18.md` as historical evidence. | The file is linked from the documentation map and design evidence chain and included in the owner-authorized documentation checkpoint. | [Historical evidence index](README.md#historical-evidence-index) |
| CAPTURE-001 | P1 | open | Actively terminate the underlying browser capture when its HTTP request aborts. | Abort closes the live Playwright operation promptly, while preserving the verified no-row/no-files/no-pump and bounded-cleanup behavior. | [Capability boundary](CAPABILITIES.md) |
| AUTH-001 | P2 | hardening, not blocker | Add per-session authentication for originless local clients. | Loopback automation has an authenticated session boundary without weakening exact-Origin checks. | [Capability boundary](CAPABILITIES.md) |
| REFACTOR-001 | P2 | open | Refactor `ScorerProcessRunner` construction to an options object. | Call sites use a named options object and readiness/runtime behavior remains covered by the existing negative controls. | Commit `ba8ae81` |
| ARCH-001 | P1 | design only | Evaluate and sequence the capability-supply proposal. | An approved slice has acceptance criteria and code/test evidence; the design document alone never changes capability status. | [Capability design](DESIGN-capability-and-continuation-2026-08-19.md) |
| CONT-001 | P1 | design only | Evaluate and sequence durable project continuation across runs. | An approved slice proves workspace lineage and compatible acceptance attribution with negative controls. | [Capability design](DESIGN-capability-and-continuation-2026-08-19.md) |
| CRITIC-001 | P1 | unproven | Prove the Taste Critic capture/review/revision chain. | A persisted run demonstrates fresh rendered evidence, independent critic disposition, bounded revision, and explicit terminal handling. | [Capability design](DESIGN-capability-and-continuation-2026-08-19.md) |
| SCOUT-001 | P1 | design only | Evaluate Enhancement Scout as a shadow-only continuation slice. | An approved shadow pilot has exact-HEAD evidence, provenance/uncertainty controls, no mutation path, and an evaluation record. | [Capability design](DESIGN-capability-and-continuation-2026-08-19.md) |

## Update rule

Never delete an unfinished item merely because a session ends. Change its status,
link the evidence, and move verified behavior into [CAPABILITIES.md](CAPABILITIES.md).
If an item is rejected, retain it with status `rejected` and the decision link.
