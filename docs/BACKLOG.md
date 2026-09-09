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


## Deferred findings from the Batch 2A review

The [independent review](REVIEW-wave2-batch2a-2026-09-08.md) and [corrective report](REPORT-wave2-batch2a-fixes-2026-09-08.md) carry these items beyond T17b, T16b and T18b. They do not authorize Batch 2B implementation or activation.

- **L5, Unicode filesystem folding:** measure on this Mac whether APFS resolves spellings such as U+017F long s or U+212A Kelvin to protected ASCII names while the current lowercase predicate does not. This remains an unmeasured hypothesis; choose a folding or native-realpath change only after evidence. Do not claim Linux behavior from that Mac measurement.
- **L9, direction dial format:** address the universal format with T26, which edits the same prompt block and requires fresh design-prompt captures. Until then, an invalid-first-declaration reason may reflect unsupported punctuation rather than an intended motion-policy denial.
- **L9, video-policy semantics:** decide whether video legs require an explicitly declared `scroll_progress` motion, and reconcile the lane with compiler-admitted `DIAL_DEVIATION` exceptions. The current projection omits trigger/exception semantics: it can deny an admitted low-dial exception or permit a high-dial contract containing only `enter_view` motion. Keep this a separate policy task; no new lane-specific threshold or implementation is included here.
- **L2, unmapped accessible name:** with the next T15 touch, remove the repeated agent name and restore “unmapped role”; bind it with an accessible-name browser assertion.
- **L10, role hue comment:** with the next T15 touch, include debug hue 300 and remove the near-grey unmapped 258 from the hue-wheel list. This is a comment correction, not a color change.

- **PREVIEW-EXPOSURE-001 implementation update:** corrective API preview code completed in `57b74d691904c768d982a56b9789fa605a0801af`; see the [corrective report](REPORT-wave2-batch2a-fixes-2026-09-08.md). Activation remains pending owner review and a controlled API restart. The unchanged process on 4176 still serves the previously exposed clinic paths; this implementation status does not close the live exposure.

## Batch 2B prerequisites, 2026-09-08

See [the prerequisite report](REPORT-wave2-batch2b-prerequisites-2026-09-08.md). Batch 2B remains incomplete; the new T21 fixture decision is pending owner reply.

- **Required carried item 1:** missing internal preview-name refusals are implemented in `aa724165d435c9a1174f59f2150520e0c2a8f4b4`. Live activation remains separate.
- **T21:** choose between preserving the historical fixture plus an explicitly sentence-rebound derived fixture (recommended), or retaining only the original fixture and accepting rejection of `p.reset` too. Identical evidence references prevent the original resolver from meeting the exact-six expectation. No option is approved.
- **T22 through T26:** not started. Include `app/wizard.mjs` in T23's future clinic fixture because `app/main.mjs` imports it. Retain the earlier T26 dial-format item.
- **Carried item 2:** remove stale `results/judge.json` on the orchestrator's no-attempt path when `#judgeReports` has no entry.
- **Carried item 3:** wrap `controller.recover(...)` in `assert.doesNotReject` in the gate-recovery cleanup-failure test.
- **Carried item 4:** move the design-lock borrow assertion before the absence assertion.
- **Carried item 5:** make `chosenDirectionReason` required in server and client API type mirrors.
- **G3:** owner-only run, not started. Prompt producer mutations passed and baselines are committed in `b88359b1a510e3b9ce3c1282fcc6d87897f06433`; the final protected-file comparison found 440 files unchanged and this backlog's original 11,166-byte prefix preserved.


## Batch 2B checkpoint, 2026-09-08

This update supersedes the prerequisite status above; see the [checkpoint report](REPORT-wave2-batch2b-2026-09-08.md) for commits, negative controls and limits. D13 and D14 are accepted. T21, T22 and carried items 2 and 3 are committed. The T23 warning persistence/API/UI prerequisite is committed in `41e97f7472a9dfcc87b871f8e55cbb155a689bb4`; T23 remains incomplete.

- **D15 / T23:** owner answer pending on the literal Shape A classification of the decorative confirmation checkmark. The narrow aria-hidden symbol-only exclusion is a proposal, not an accepted decision. Keep the named literal browser test red and pause probe/classifier integration until the answer; then complete the report's remaining acceptance checks.
- **T24 through T26:** unstarted. Retain T26's deferred dial-format work and the other earlier deferred findings. `CRITIC-001` remains open.
- **Carried items 4 and 5:** with T25, move the design-lock borrow assertion before the absence assertion and require `chosenDirectionReason` in both API type mirrors.
- **G3:** owner-only, not run. Batch 2B completion is not established by this checkpoint.


## T27 carry-forward findings, 2026-09-09

Scope: [T27 brief](CODEX-BRIEF-wave2-dom-conformance.md) and [study findings](FINDINGS-2026-09-09-higgsfield-scaffold-comparison.md). These observations do not establish T27 completion or authorize refusal wiring, T23, T28 or changes to `bakeoff/`.

- **Legacy recovery admission:** the public `critic_unavailable` arm cannot reach `hasLegacyDeterministicMarkerConflict`: `readCreativePilotStatus` rejects that stop reason with a null critic disposition, while `eligibleSource` rejects a non-null disposition. Pin the unchanged compiled helper through a test-only export for T27's golden. Any admission repair needs separate scope.
- **Artifact integration, owner decision pending:** no current post-build seat directly consumes `results/contract-conformance.json`. Context7 review receives supplied workspace scope/source; the judge receives bounded diff and evidence. On `run-cont-e22fa17f9b7972c79641`, immutable SQLite events record render invocation followed by route-marker refusal (seq 558), `scope_unavailable` review (561), and a non-gating clean judge result that expressly could not read the actual HTML/CSS/JS beyond the 120k diff truncation (564). A null render-manifest hash does not prove the renderer never ran. T27 computes and persists the standalone comparison; future consumption and refusal remain owner decisions.
- **Conflicting creative instructions:** blocking every study finding would be unsafe. The inherited direction prescribes the shipped hero, Standard section and `s.*` ids, while the new contract differs; the owner follow-up asks for a narrow skip-link repair and preservation of the existing work reveal. The one-eyebrow count and literal `Engagements` agree with the direction and are mechanically fixable. Resolve the conflicting instructions before turning all conformance findings into repair obligations.
