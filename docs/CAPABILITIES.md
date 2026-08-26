---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: ba8ae81
---

# Capability status

This matrix separates verified behavior from local implementation, design intent,
and unverified recovery. A design document or an agent declaration is not evidence
that a capability works.

Status vocabulary:

- **shipped at baseline** — present in the verified code baseline; check Git live for
  current branch/upstream placement.
- **verified** — exercised by a persisted test or run result.
- **unimplemented** — no supported production path exists yet.
- **unproven** — pieces may exist, but the claimed end-to-end chain has no evidence.
- **not reached** — the latest run stopped before this stage produced a result.
- **design only** — proposed; do not describe as implemented.

| Capability | Status | Evidence and limit |
|---|---|---|
| Owner clarification and frozen planning record | verified | Run `d728ab79` persisted its answered/declined questions in [`results/plan.json`](../dashboard/runs/run-2026-08-25T10-30-39-122Z-d728ab79/results/plan.json). |
| Bounded creative-contract author retries and partial safe repairs | shipped at baseline; verified in tests | Commit `259130f` and the [run report](RUN-d728ab79-creative-park-2026-08-25.md) record the bounded retries, mutation controls, and suite results. This is not a held-out verdict. |
| Park-aware notice/chat and machine-check result surfaces | shipped at baseline; verified | Commits `7abd149` and `e53f9f1`; the result-surface browser verification passed `8/8`. |
| Plan, design, and build execution | verified for stage execution; quality unknown | Run `d728ab79` reached and persisted plan/design/build artifacts, but the sealed scorer did not run. Builder completion is not an acceptance verdict. |
| Pre-spend executable-scorer readiness | shipped at baseline; verified in tests and live smoke | Commit `ba8ae81`; scorer-runtime `9/9`, dashboard readiness/pre-spend `14/14`, and live Chromium launch/close under the scoring seal at the recorded exact digest. Unavailable/unknown fails closed before direct POST writes, capture, or spend, with a fresh queue-entry recheck. |
| Intake and disconnect admission safety | shipped at baseline; verified | JSON and exact present-Origin checks are enforced; originless loopback automation is retained. Disconnects through reference/motion capture create no row/files/pump. The underlying Playwright capture is bounded but is not actively terminated on HTTP abort. |
| Sealed held-out scoring | not reached on latest run | [`results/verdict.md`](../dashboard/runs/run-2026-08-25T10-30-39-122Z-d728ab79/results/verdict.md) records the Docker image-inspection failure and **NO VERDICT**; `heldOutPass` is `null`. Docker inspection now works, but no successful scoring attempt has followed. |
| Gate-only recovery/rescore of an already-built run | unimplemented | No supported production path or successful recovery exists. A future child/replacement must preserve source and frozen-suite attribution and spend no builder/model/fixer tokens. |
| Taste Critic chain | unproven | No Taste Critic result exists for the latest run, and no persisted end-to-end capture→critic→revision→verdict chain establishes the capability. |
| Routed capability supply for agents, skills, and MCP | design only | Proposed in [DESIGN-capability-and-continuation-2026-08-19.md](DESIGN-capability-and-continuation-2026-08-19.md). No implementation claim is made here. |
| Durable project continuation across runs | design only | Proposed in the same design document. Existing historical measurements describe greenfield run workspaces; no implemented continuation capability is established here. |
| Enhancement Scout | design only | The observation/card schema and rollout plan are design intent only; no shadow dataset or production Scout capability is established. |

## Promotion rule

Move a row to **verified** only when the relevant implementation is identified and
a persisted test, negative control, or run artifact demonstrates the claimed
behavior. Link that evidence in the row and update `last_verified` and
`verified_at_commit`. A recovered prerequisite alone does not verify the stage it
previously blocked.
