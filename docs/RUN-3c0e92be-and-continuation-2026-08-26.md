---
document_status: historical-run-evidence
verified_at_commit: c4c9f37
verified_on: 2026-08-26
---

# Progression Labs variation: source run and green continuation

This report records two linked runs. It is evidence for their exact paths, not a
claim that every orchestrator path is reliable.

## Result in one view

| Run | Outcome | Gate | Creative closure |
|---|---|---|---|
| `run-2026-08-26T16-56-51-065Z-3c0e92be` | failed / done; `heldOutPass: false`; `falseFinish: true` | two attempts, both 29/31; `not-converging` | stopped while functionally red |
| `run-cont-e22fa17f9b7972c79641` | passed / done; `heldOutPass: true`; `falseFinish: false` | one attempt, 32/32; all 19 requirements passed; `green` | **not complete**: rendered critic unavailable |

The continuation used `claude-opus-5[1m]`. Its frozen suite hash is
`f706c90fd79f2225172d4e5b9bdee3479711231313fbe10a52c5f89f380778e7`.
Its sealed screenshots are
[`home__375.png`](../dashboard/results/screenshots/run-cont-e22fa17f9b7972c79641/home__375.png),
[`home__768.png`](../dashboard/results/screenshots/run-cont-e22fa17f9b7972c79641/home__768.png), and
[`home__1280.png`](../dashboard/results/screenshots/run-cont-e22fa17f9b7972c79641/home__1280.png).

## Source run

The ticket requested a distinctive studio site inspired by Progression Labs,
with deliberate motion, verified content, responsive behavior, Context7 review,
and a rendered Taste Critic pass.

The planning fold recorded no questions and said the run was not submitted from
the dashboard. That provenance sentence was false: the owner submitted it from
the dashboard but chose automatic design selection. The server intentionally
stored that policy as `interactive=0`, which made skipping planning valid; it did
not make the provenance claim valid. See
[`plan.json`](../dashboard/runs/run-2026-08-26T16-56-51-065Z-3c0e92be/results/plan.json).

Creative-contract author attempt 1 was rejected for
`CONTENT_PROOF_UNUSED` at `/contentProof/8`. Attempt 2 compiled and froze
contract hash
`f3eaf63a659ca2cf596cda6ee810d7f621d5b8d0052dee6bd7f1382fd2e59421`.

The design lane produced six Stage A stills across three directions. The
independent `ui-designer` chose **Dark Reel**, after `taste-frontend-expert`
authored the directions. Stage B expanded Dark Reel to eight stills. The final
functional blocker was REQ-009: the skip link existed but its unfocused box was
outside the viewport, so the forced click could not exercise it. Both sealed
gate attempts ended 29/31, and the loop correctly stopped `not-converging`.

Primary evidence:

- [source verdict](../dashboard/runs/run-2026-08-26T16-56-51-065Z-3c0e92be/results/verdict.md)
- [source sealed score](../dashboard/results/scores/run-2026-08-26T16-56-51-065Z-3c0e92be.json)
- [design lock](../dashboard/runs/run-2026-08-26T16-56-51-065Z-3c0e92be/results/design-lock.json)
- [creative status](../dashboard/runs/run-2026-08-26T16-56-51-065Z-3c0e92be/results/creative-status.json)

## Linked continuation

[`continuation.json`](../dashboard/runs/run-cont-e22fa17f9b7972c79641/continuation.json)
links the child to source run `3c0e92be` and owner message 1. The continuation
copied the existing workspace, preserved the already-implemented work-reveal
change, and changed only the skip-link CSS. One sealed gate attempt passed all
32 tests and all 19 persisted requirements. The result was
`heldOutPass: true`, `falseFinish: false`, and `gateStopReason: green`.

Manual Safari inspection and the sealed 375/768/1280 captures were visually
coherent. That manual observation is separate from the automated critic and
does not substitute for it.

Primary evidence:

- [continuation verdict](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/verdict.md)
- [continuation sealed score](../dashboard/results/scores/run-cont-e22fa17f9b7972c79641.json)
- [continuation creative status](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/creative-status.json)
- [continuation design lock](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/design-lock.json)

## What did not complete

The rendered critic did **not** run. Capture refused because the newly frozen
continuation contract used route `home`, unprefixed section IDs, and hyphenated
motion IDs, while the inherited source workspace, direction, and tests used
`r.home`, `s.*`, and dotted IDs. The final creative record therefore has:

- `reviewState: creative_review_required`;
- `reviewStopReason: critic_unavailable`;
- no render manifest hash, freshness record, profiles, critic attempt, or
  disposition.

Publication was suppressed. At `c4c9f37` there was no safe post-terminal
critic-only retry. An ordinary continuation would author another contract and
suite and is not equivalent to recovering this failed review step. Source-only
recovery work is now in progress, but is not shipped.

Context7 also did not run. The record is `unsatisfied / scope_unavailable /
not_applicable`, with an empty package set and no lifecycle or evidence. The run
inventory discovered the Context7 plugin, but `mcpServers` was `[]`; discovery
was not use. See
[`context7-review.json`](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/context7-review.json)
and [`environment.json`](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/environment.json).

The human-factors adversary was source-only. Its sandbox could neither reach
loopback nor launch a usable browser, so dynamic attacks were unmeasured. It
raised a high-severity plausible whole-workspace preview exposure. A later
read-only check against the exact exported `resolveStaticFile` function confirmed,
without reading secret contents, that `/.git/config`, `/TICKET.md`,
`/.bakeoff/self-report.json`, and `/design-refs/direction.md` resolve, while
`/../etc/passwd` does not. This is **resolver-confirmed**, not live-HTTP-confirmed.
See [adversary evidence](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/adversary.json).

## Capability boundary

This pair proves that a linked continuation can preserve a workspace, accept a
narrow owner amendment, and reach a green frozen suite after the source stopped
red. It does not prove rendered-critic reliability, Context7 use, dynamic
adversarial access, safe preview publication, critic-only recovery, or general
full-pipeline reliability.
