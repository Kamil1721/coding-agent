---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: c4c9f37
---

# Current repository state

This is the stable starting point for a new Claude or Codex session. Dated run
reports are evidence, not substitutes for this file.

## Repository checkpoint

- Repository: `/Users/kamilborzecki/Projects/coding-agent`
- Clean pushed code baseline: `c4c9f37` (`fix(dashboard): allow long run intake through proxy`).
- Immediate predecessor: `9bacc0f` (`feat(orchestrator): enforce frozen artifact execution`).
- `HEAD`, `main`, and `origin/main` were equal before this documentation update.

Recheck the branch, upstream divergence, worktree, and live processes directly;
do not carry this checkpoint forward as an assumption.

## Latest linked run pair

Source: `run-2026-08-26T16-56-51-065Z-3c0e92be`

- Terminal **failed / done**, `heldOutPass: false`, `falseFinish: true`, and
  `gateStopReason: not-converging`.
- Two sealed attempts each passed 29/31 tests. REQ-009 remained red because the
  skip link's unfocused box was outside the viewport.
- Creative-contract attempt 1 was rejected for `CONTENT_PROOF_UNUSED`; attempt 2
  compiled. Stage A produced six stills, `ui-designer` chose **Dark Reel**, and
  Stage B expanded it to eight stills after `taste-frontend-expert` authored the
  directions.
- The plan correctly skipped questions for the automatic policy but falsely
  described that as “not submitted from the dashboard.”

Linked continuation: `run-cont-e22fa17f9b7972c79641`

- Terminal **passed / done**, `heldOutPass: true`, `falseFinish: false`, and
  `gateStopReason: green`.
- It used `claude-opus-5[1m]`, preserved the work-reveal change, changed only
  skip-link CSS, and passed one sealed attempt: 32/32 tests and all 19 persisted
  requirements.
- The sealed 375/768/1280 captures and manual Safari inspection were visually
  coherent.
- This is not complete creative closure. Render capture refused on inherited
  namespace drift; the rendered critic never ran, creative review remains
  required with `critic_unavailable`, and publication was suppressed.
- Context7 was discovered as a plugin but not supplied as an MCP server; its
  review record is `unsatisfied / scope_unavailable / not_applicable`.
- The adversary was source-only. Whole-workspace preview exposure is now
  resolver-confirmed for selected internal paths, not live-HTTP-confirmed.

Primary evidence:

- [Two-run report](RUN-3c0e92be-and-continuation-2026-08-26.md)
- [Continuation score](../dashboard/results/scores/run-cont-e22fa17f9b7972c79641.json)
- [Continuation creative status](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/creative-status.json)

## Shipped at this checkpoint

Commit `9bacc0f` projects the frozen STATIC/SERVER execution contract into fresh
and resumed build prompts, enforces STATIC root readiness before constructing a
sealed scorer, and invalidates stale scores after mutations. The linked green
continuation provides live evidence that the declared STATIC artifact reached
and passed the sealed gate. SERVER preflight intentionally does not duplicate
the scorer's real boot.

Commit `c4c9f37` raises Next's external-rewrite proxy timeout from its 30-second
default to six minutes. A real integration test holds `POST /api/runs` beyond
30 seconds and requires a persisted 201 response. This is a narrow recovery:
the timeout applies to every external rewrite, an accepted-but-silent request
can take six minutes to fail, and serialized readiness queue time can exceed the
configured ceiling.

## Decisive remaining boundary

The sealed continuation is green, but the requested full pipeline is not. The
rendered critic and Context7 review did not execute, the adversary could not
drive the live preview, and the preview resolver exposes internal workspace
paths. At `c4c9f37` no safe post-terminal critic-only retry existed; an ordinary
continuation would author a new contract and suite and is not equivalent.

Source recovery implementation is **in progress**. It is not shipped and must
not be represented as a capability until code, controls, and a persisted recovery
result exist.

## Active next step

Close the safety and evidence gaps in [BACKLOG.md](BACKLOG.md), beginning with
`PREVIEW-EXPOSURE-001` and `CRITIC-ROUTE-001`. Then prove the recovered rendered
critic path and Context7 lifecycle without weakening the frozen suite boundary.

## Maintenance rule

Update this file after every repository-state handoff and terminal run. Promote
[CAPABILITIES.md](CAPABILITIES.md) only with code plus tests or persisted run
evidence, and carry every unfinished item in [BACKLOG.md](BACKLOG.md).
