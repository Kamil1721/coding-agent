---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: c4c9f37
---

# Capability status

This matrix separates verified behavior from design intent and unproven chains.
A green sealed suite is not evidence that optional review seats ran.

| Capability | Status | Evidence and limit |
|---|---|---|
| Owner clarification and frozen planning record | verified, with provenance-copy defect | Continuation `e22fa17f` persisted one owner answer. Source `3c0e92be` correctly skipped questions for automatic mode but falsely said it was not submitted from the dashboard. |
| Bounded creative-contract author retries | verified live | Source attempt 1 failed `CONTENT_PROOF_UNUSED`; attempt 2 compiled. The continuation also produced a compiled contract. This is compiler evidence, not rendered-quality closure. |
| Park-aware notice/chat and machine-check result surfaces | shipped and verified | Commits `7abd149` and `e53f9f1`; result-surface browser verification passed 8/8. |
| Frozen execution-contract propagation into build | shipped and verified | Commit `9bacc0f`; fresh/resumed prompts receive the narrow frozen STATIC/SERVER projection. The continuation's STATIC artifact reached a green sealed gate. |
| STATIC artifact pre-gate readiness | shipped and verified | Commit `9bacc0f` rejects missing, empty, symlink, and non-regular root documents before sealed scorer construction, including post-mutation invalidation. |
| SERVER artifact pre-gate readiness | intentionally deferred to scorer | The precheck is a deliberate no-op for SERVER and does not perform a speculative duplicate boot. The sealed scorer remains the only real boot authority. |
| Long synchronous run intake through Next | shipped and test-verified | Commit `c4c9f37`; a real rewrite test waits more than 30 seconds and requires persisted `201`. The six-minute value is global and does not include serialized readiness queue delay. |
| Pre-spend executable-scorer readiness | shipped and verified | Commit `ba8ae81`; fresh runtime checks guard direct intake and queue entry. Supervisor/cron's direct first barrier remains backlog work. |
| Intake and disconnect admission safety | shipped, bounded limitation | Aborted capture creates no row/files/pump. The underlying Playwright operation is not actively terminated. A silent external rewrite can now take six minutes to fail. |
| Plan, design, and build execution | verified on latest pair | Source produced six Stage A stills and eight Dark Reel Stage B stills; `taste-frontend-expert` authored and `ui-designer` independently chose. Continuation preserved the workspace and applied a narrow CSS repair. |
| Linked continuation over an existing workspace | verified for one narrow green path | `continuation.json` links `e22fa17f` to source `3c0e92be`; it preserved the work-reveal fix, changed only skip-link CSS, and passed 32/32. This is not general durable-project reliability. |
| Sealed scorer and held-out suite execution | verified green on latest continuation | One attempt, all 19 requirements and 32/32 tests, `heldOutPass: true`, `falseFinish: false`, `gateStopReason: green`. Source correctly stopped red after two 29/31 attempts. |
| Frozen score after mutation | verified on continuation | The child received its own frozen suite and produced a new attributable score. An ordinary continuation is not a critic-only recovery of the source contract. |
| Rendered Taste Critic chain | **not completed** | Capture refused on inherited namespace drift. Final state is `creative_review_required / critic_unavailable`, with no render manifest, profiles, attempt, or disposition. Manual Safari review does not substitute. |
| Context7 review | **not executed** | The continuation record is `unsatisfied / scope_unavailable / not_applicable`; packages and evidence are empty. Context7 was in plugin inventory but `mcpServers` was `[]`. |
| Human-factors adversary | source-only; live behavior unmeasured | The adversary wrote findings but could not reach loopback or launch a usable browser. Dynamic attacks did not run. |
| Safe preview serving | failed boundary | Exact exported resolver checks confirm selected internal workspace paths resolve. This is resolver-confirmed, not live-HTTP-confirmed. |
| Publication after creative closure | correctly suppressed | The continuation was sealed-green but the critic was unavailable, so publication did not occur. |
| Gate-only recovery of an already-built no-verdict run | shipped; verified terminal red | Commit `56aa163` and recovery child `5ffc96e7`. Green recovery and crash/boot reconciliation remain unproven. |
| Post-terminal critic-only recovery | implementation in progress; not shipped | At `c4c9f37` no safe path existed. Do not promote until source recovery has controls and persisted evidence. |
| Routed capability supply for agents, skills, and MCP | design only | Proposed in [the capability design](DESIGN-capability-and-continuation-2026-08-19.md). Plugin discovery is not MCP supply or use. |
| Enhancement Scout | design only | No shadow dataset or production Scout capability is established. |

Primary latest evidence is the
[source-and-continuation report](RUN-3c0e92be-and-continuation-2026-08-26.md).

## Promotion rule

Move a row to verified only when identified implementation plus a persisted test,
negative control, or run artifact demonstrates the stated boundary. One green
continuation verifies that path; it does not prove general full-pipeline,
rendered-critic, Context7, or adversarial reliability.

### T21 requirement evidence boundary (2026-09-08)

New author packets split owner prose into sentences. Product transitions such as Back and
Reset remain goals; accessibility, layout, local-data and delivery requirements carry their
own kinds. The 18 brief slots retain nine opening and nine closing sentences when needed,
using original sentence indexes, with ten separate slots still reserved for plan answers.
Requirement proofs may authorize only alt text, cannot support actions, and cannot supply
every proof in a section. The host capture-marker requirement is subject to the same rule.

D13 supersedes T21's original expectation that historical contracts must be re-authored.
Frozen pre-T21 reads retain the old projection only when the canonical record has no new
projection marker, its input hash matches the reconstructed legacy packet, and its contract
hash still matches the unchanged contract. New records carry a host-written version;
unknown versions fail closed, and authoring never retries with the legacy compiler option.
The unchanged clinic fixture exercises that frozen read separately from a reproducible
sentence-rebound fixture whose six requirement proofs are rejected without rejecting Reset.
This is a compiler and continuation-read boundary, not evidence from a new pipeline run.
