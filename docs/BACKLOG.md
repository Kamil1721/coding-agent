---
document_status: authoritative
last_verified: 2026-08-26
verified_at_commit: c4c9f37
---

# Durable backlog

This is the carry-forward list for unfinished or not-yet-verified work. Never
delete an item merely because a session ends.

| ID | Priority | Status | Work | Done when | Evidence |
|---|---|---|---|---|---|
| BLIND-001 | P0 | open; owner decision pending | Give the build seat sight of its own page. Cheapest arm: hand it the host's sealed captures at segment boundaries, needing no sandbox change. The sandbox knobs alone cannot launch default Chromium — `bootstrap_check_in` registers a service, `allowMachLookup` only grants lookup, and the SDK exposes no registration key. | A build segment receives rendered evidence of its own output and a later segment acts on it; negative control shows the evidence is fresh, not inherited. | [Findings §1](FINDINGS-2026-09-02-pipeline-vs-chat.md) |
| FIXPROMPT-001 | P1 | open; one string, design question inside | `WITHHELD_VISUAL_DETAIL` (`fix-prompt.ts:62-67`) ends "render that flow at that breakpoint yourself and look at it", contradicting `VISUAL_INSTRUCTIONS` (`:145`) in the same generated prompt. Proven by execution against `dist/fix-prompt.js`. Both halves are pinned green by tests that cannot observe each other (`fix-prompt.test.ts:131` and `:198`). | The withheld string names an action the seat can perform, still does not read as "nothing was found", and one test pins the pair so the contradiction cannot return. | [Findings, fix-prompt section](FINDINGS-2026-09-02-pipeline-vs-chat.md) |
| DOC-001 | P0 | open | Reconcile stale current-state claims in `dashboard/README.md` and `dashboard/STATUS.md` with the living docs. | They contain current facts or point here; no competing editable state remains. | [STATE.md](STATE.md) |
| SCORE-001 | P0 | resolved | Controlled gate-only recovery child for `d728ab79`. | Source preserved; isolated child produced an attributable sealed result. | [Recovery report](RUN-d728ab79-gate-recovery-2026-08-26.md) |
| SCORE-002 | P0 | resolved | Produce a real terminal acceptance result after recovery. | Recovery child has boolean `heldOutPass: false`; source remains no-verdict. | [Recovery report](RUN-d728ab79-gate-recovery-2026-08-26.md) |
| ARTIFACT-BOOT-001 | P0 | resolved for implementation and one live STATIC path | Propagate and enforce the frozen execution contract. | `9bacc0f` ships projection/precheck; continuation `e22fa17f` reached a green sealed STATIC gate. | [Latest report](RUN-3c0e92be-and-continuation-2026-08-26.md) |
| PREVIEW-EXPOSURE-001 | P0 | open; resolver-confirmed | Stop static preview/scoring from serving internal workspace files such as `.git`, `TICKET.md`, `.bakeoff`, design notes, and test sources. | Public routes serve only declared product files; exact internal-path negatives fail closed; traversal remains refused; live HTTP and resolver controls pass. | [Adversary record](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/adversary.json) |
| CRITIC-ROUTE-001 | P0 | implementation in progress; not shipped | Preserve or reconcile the source creative route/section/motion namespace when a continuation is reviewed, and provide a safe recovery for a green terminal run whose critic capture failed. | Recovery reuses the frozen source/continuation authority without silently authoring an ordinary new suite; capture, critic, disposition, and publication decision persist with negative controls. | [Latest creative status](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/creative-status.json) |
| READY-001 | P0 | open | Add the direct first scorer-readiness barrier to supervisor/cron intake. | Those paths fail closed before first write or spend; queue-entry recheck remains the second barrier. | [Capability boundary](CAPABILITIES.md) |
| TEST-001 | P0 | resolved | Result-surface coverage is committed and verified. | Commit `e53f9f1`; browser result-surface suite passed 8/8. | [Capability matrix](CAPABILITIES.md) |
| GIT-001 | P0 | resolved | Owner-authorized code checkpoint committed and pushed. | `main` and `origin/main` contain `c4c9f37`. | [STATE.md](STATE.md#repository-checkpoint) |
| INTAKE-ACK-001 | P1 | open | Replace the global six-minute rewrite workaround with bounded intake acknowledgement before optional capture/readiness, or otherwise include readiness queue wait in admission. | Client receives durable acceptance promptly; capture can continue safely; one active plus queued readiness cannot outlive an unaccounted proxy ceiling; unrelated rewrites keep narrow timeouts. | Commit `c4c9f37`; `gate-readiness.ts` defaults to 1 active and 8 queued |
| CRITIC-001 | P1 | unproven | Prove the rendered Taste Critic capture/review/revision chain. | Fresh desktop/phone evidence reaches an independent critic, bounded revision, disposition, and explicit terminal handling in one persisted run. | [Latest report](RUN-3c0e92be-and-continuation-2026-08-26.md#what-did-not-complete) |
| CONTEXT7-EVIDENCE-001 | P1 | open | Supply Context7 to the independent review seat and persist actual package/document lifecycle evidence. | Applicable libraries resolve through Context7; the record names packages, calls, evidence, and verdict. Plugin inventory without MCP supply cannot pass. | [Context7 record](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/context7-review.json) |
| ADVERSARY-ACCESS-001 | P1 | open | Give the isolated human-factors adversary a safe, measured browser/loopback route to the preview. | Dynamic attack classes have attempted evidence or an explicit product-level N/A; source-only review is labelled separately. | [Adversary record](../dashboard/runs/run-cont-e22fa17f9b7972c79641/results/adversary.json) |
| CAPTURE-001 | P1 | open | Actively terminate the browser capture when its HTTP request aborts. | Abort promptly closes Playwright while preserving no-row/no-files/no-pump behavior. | [Capability boundary](CAPABILITIES.md) |
| ARCH-001 | P1 | design only | Evaluate and sequence capability supply. | An approved slice has acceptance criteria and code/test evidence. | [Capability design](DESIGN-capability-and-continuation-2026-08-19.md) |
| CONT-001 | P1 | partially evidenced; broader design open | Prove durable project continuation across runs. | Multiple amendments prove workspace lineage, compatible acceptance attribution, rollback, and negative controls. One narrow green child is insufficient. | [Latest report](RUN-3c0e92be-and-continuation-2026-08-26.md) |
| SCOUT-001 | P1 | design only | Evaluate Enhancement Scout as shadow-only continuation. | Approved shadow pilot has exact-HEAD evidence, provenance/uncertainty controls, no mutation path, and an evaluation record. | [Capability design](DESIGN-capability-and-continuation-2026-08-19.md) |
| DOC-002 | P1 | resolved | Preserve the `b1219c2d` historical ledger. | Linked from the documentation map and design evidence chain. | [Historical report](RUN-b1219c2d-breakdown-2026-08-18.md) |
| PLAN-COPY-001 | P2 | open | Stop equating automatic/non-interactive policy with “not submitted from the dashboard.” | Plan record names the actual policy and provenance independently; dashboard-auto and cron controls distinguish them. | [Source plan](../dashboard/runs/run-2026-08-26T16-56-51-065Z-3c0e92be/results/plan.json) |
| ARTIFACT-SERVER-001 | P2 | accepted boundary; document and guard | Keep SERVER precheck's intentional no-op distinct from a claim that SERVER boot was prevalidated. | UI/log/backlog wording names scorer-owned boot; tests keep the precheck from becoming a speculative duplicate server. | Commit `9bacc0f`, `execution-contract.test.ts` |
| ARTIFACT-MANIFEST-001 | P2 | open | Make malformed and mismatched frozen execution-manifest failures operator-readable without leaking sealed contents. | Persisted run wording distinguishes missing, malformed, identity mismatch, and unsupported execution shape with redaction controls. | `execution-contract.ts`; unit parser tests at `9bacc0f` |
| ARTIFACT-MANIFEST-TEST-001 | P2 | open | Add an orchestration-path negative control for a missing frozen execution manifest. | No gate is constructed; run terminalizes with attributable non-verdict/backlog wording; mutation proves the test observes the missing file. | `execution-contract.test.ts` currently covers malformed/mismatch but not missing-file orchestration |
| AUTH-001 | P2 | hardening, not blocker | Add per-session authentication for originless local clients. | Loopback automation has an authenticated boundary without weakening exact-Origin checks. | [Capability boundary](CAPABILITIES.md) |
| REFACTOR-001 | P2 | open | Refactor `ScorerProcessRunner` construction to an options object. | Call sites use named options and readiness/runtime controls remain green. | Commit `ba8ae81` |

## Update rule

Change status, link evidence, and move verified behavior into
[CAPABILITIES.md](CAPABILITIES.md). If an item is rejected, retain it with status
`rejected` and a decision link.


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

- **D15 / T23:** **taken 2026-09-09, recorded in [CODEX-BRIEF-wave2.md](CODEX-BRIEF-wave2.md) line 66.** Shape A does not fire on an element that is (a) `aria-hidden="true"`, (b) glyph-only, meaning its trimmed text is exactly one character in a Unicode symbol or punctuation category, and (c) has no element children, or exactly one child that is itself glyph-only with the same text. All three together; any one alone is not an exclusion. This spares the clinic's `.done-mark` without excluding a text control such as Continue. T23's probe and classifier integration are unblocked; complete the report's remaining acceptance checks. This line previously read "owner answer pending" and was stale.
- **T24 through T26:** unstarted. Retain T26's deferred dial-format work and the other earlier deferred findings. `CRITIC-001` remains open.
- **Carried items 4 and 5:** with T25, move the design-lock borrow assertion before the absence assertion and require `chosenDirectionReason` in both API type mirrors.
- **G3:** owner-only, not run. Batch 2B completion is not established by this checkpoint.


## T27 carry-forward findings, 2026-09-09

Scope: [T27 brief](CODEX-BRIEF-wave2-dom-conformance.md) and [study findings](FINDINGS-2026-09-09-higgsfield-scaffold-comparison.md). These observations do not establish T27 completion or authorize refusal wiring, T23, T28 or changes to `bakeoff/`.

- **Legacy recovery admission:** the public `critic_unavailable` arm cannot reach `hasLegacyDeterministicMarkerConflict`: `readCreativePilotStatus` rejects that stop reason with a null critic disposition, while `eligibleSource` rejects a non-null disposition. Pin the unchanged compiled helper through a test-only export for T27's golden. Any admission repair needs separate scope.
- **Artifact integration, owner decision pending:** no current post-build seat directly consumes `results/contract-conformance.json`. Context7 review receives supplied workspace scope/source; the judge receives bounded diff and evidence. On `run-cont-e22fa17f9b7972c79641`, immutable SQLite events record render invocation followed by route-marker refusal (seq 558), `scope_unavailable` review (561), and a non-gating clean judge result that expressly could not read the actual HTML/CSS/JS beyond the 120k diff truncation (564). A null render-manifest hash does not prove the renderer never ran. T27 computes and persists the standalone comparison; future consumption and refusal remain owner decisions.
- **Conflicting creative instructions:** blocking every study finding would be unsafe. The inherited direction prescribes the shipped hero, Standard section and `s.*` ids, while the new contract differs; the owner follow-up asks for a narrow skip-link repair and preservation of the existing work reveal. The one-eyebrow count and literal `Engagements` agree with the direction and are mechanically fixable. Resolve the conflicting instructions before turning all conformance findings into repair obligations.

## T24 audit findings, 2026-09-09 — G3 MUST NOT RUN UNTIL THESE CLOSE

Five adversarial lenses attacked the T24 demotion; two findings survived independent
refutation and were re-measured by the session author. Both are the signature defect:
a check that was moved into a seat which cannot act on it.

- **T24-A / high: `MOTION_NOT_OBSERVED` has no observer.** T24 demoted it from `blocking`
  to `warning` and hands it to the rendered critic. The critic's vocabulary is closed:
  `TASTE_FINDING_CODES` (`taste-policy.ts`) holds 21 codes and none expresses "a declared
  motion was not delivered". `MOTION_UNDECLARED` is the inverse case. `REDUCED_MOTION_ACTIVE`
  *is* in the list, so this is scoped to `MOTION_NOT_OBSERVED` alone. Consequence: a build
  that ships none of its declared motion produces a valid manifest, `ok: true`, no blocking
  issue so no repair round, and a critic that can only return `evidenceSufficient: true,
  findings: []`. The page is accepted. Before T24 the render refused. **The check did not
  move, it evaporated.** Fix: either add a critic code for an undelivered declared motion, or
  keep `MOTION_NOT_OBSERVED` blocking when every declared motion on an active profile is
  unobserved, since a total miss is not uncertainty about whether an animation ran.

- **T24-B / high: warning facts evict the critic's page evidence one for one.**
  `creative-render.ts:691` builds the prompt as
  `motionWarningFacts(contract, manifest).slice(0, MAX_CREATIVE_FACTS)` and only then fills the
  remainder from the capture buckets. Warnings therefore displace `dom_text`, `region`, `asset`
  and `motion_trace` facts 1:1 out of the 48-fact cap. Measured: 2 motions unimplemented on
  desktop and mobile evict 4 page facts including the only DOM text for `home-footer` at mobile,
  reduced_motion and no_media. At 24 declared motions the prompt is 46 warning facts plus 2
  contract facts and carries no page evidence at all, while the render still returns `ok: true`.
  Five of the seven failure families the prompt asks about become structurally unjudgeable.
  `MAX_CREATIVE_ISSUES = 64` is declared at `creative-render.ts:51` and referenced nowhere, so
  nothing caps the flood below the manifest's 400. **The commit's own test cannot see this:**
  `creative-render.test.ts:899` builds 60 duplicate warnings and asserts only
  `bounded.length === 48`. The missing control is an assertion that any non-warning fact
  survives. Fix: bound warning facts to a small share of the cap and assert page facts remain.

Both were found by mutation and probe, not by reading. The T24 commits are otherwise sound and
the first real critic verdict stands.
