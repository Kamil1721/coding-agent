---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: 56aa163
---

# Capability status

This matrix separates verified behavior from design intent and unproven chains.
A design document or agent declaration is not evidence that a capability works.

| Capability | Status | Evidence and limit |
|---|---|---|
| Owner clarification and frozen planning record | verified | Run `d728ab79` persisted its answered and declined questions in [`results/plan.json`](../dashboard/runs/run-2026-08-25T10-30-39-122Z-d728ab79/results/plan.json). |
| Bounded creative-contract author retries and partial safe repairs | shipped; verified in tests | Commit `259130f` and the [source run report](RUN-d728ab79-creative-park-2026-08-25.md). This is not held-out acceptance evidence. |
| Park-aware notice/chat and machine-check result surfaces | shipped; verified | Commits `7abd149` and `e53f9f1`; result-surface browser verification passed `8/8`. |
| Plan, design, and build execution | verified for source-stage execution; quality unknown | Source run `d728ab79` persisted these artifacts, but its original scorer did not run. Copied design files in the recovery child do not mean recovery design work ran. |
| Pre-spend executable-scorer readiness | shipped; verified in tests and live smoke | Commit `ba8ae81`; scorer-runtime `9/9`, dashboard readiness/pre-spend `14/14`, and live Chromium launch/close under the exact scorer digest. |
| Intake and disconnect admission safety | shipped; verified | JSON and exact present-Origin checks are enforced; originless loopback automation remains supported. Aborted capture creates no row/files/pump, although the bounded Playwright operation is not actively terminated. |
| Sealed scorer invocation and terminalization | verified on the recovery child's real boot-red path | The [sealed score](../dashboard/results/scores/run-gate-recovery-5ffc96e73d39737f4b2bb197.json) records `heldOutPass: false`, `falseFinish: true`, exact suite/image attribution, and no infrastructure errors. This verifies scorer invocation and terminalization, not held-out test execution. The source remains **NO VERDICT**. |
| Held-out suite execution | not reached on the recovery child | `GATE:boot` failed before routes, screenshots, or the frozen tests could run; all 16 REQs were unasserted. The child's boolean red result does not imply that the held-out tests executed. The source remains **NO VERDICT**. |
| Gate-only recovery of an already-built no-verdict run | shipped; verified for terminal red | Commit `56aa163`, targeted recovery/contract/security/store coverage `56/56`, negative controls, and the [live immutable child](RUN-d728ab79-gate-recovery-2026-08-26.md). Green recovery and crash/boot reconciliation remain unproven. |
| Frozen execution-contract propagation into build | unimplemented | The manifest correctly selected STATIC, but the builder shipped a server-only artifact without a root document. See `ARTIFACT-BOOT-001` in [BACKLOG.md](BACKLOG.md). |
| Taste Critic chain | unproven | Recovery metadata explicitly records Taste `not-run` because gate-only recovery makes no model calls. No persisted end-to-end capture→critic→revision→verdict chain establishes reliability. |
| Routed capability supply for agents, skills, and MCP | design only | Proposed in [DESIGN-capability-and-continuation-2026-08-19.md](DESIGN-capability-and-continuation-2026-08-19.md). |
| Durable project continuation across runs | design only | Proposed in the same design document; current evidence does not establish it. |
| Enhancement Scout | design only | No shadow dataset or production Scout capability is established. |

## Promotion rule

Move a row to verified only when identified implementation plus a persisted test,
negative control, or run artifact demonstrates the stated boundary. A terminal-red
recovery verifies that path; it does not prove green recovery, the full pipeline,
or the Taste chain.
