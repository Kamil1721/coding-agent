---
document_status: final
written: 2026-09-08
baseline: ecb4787
scope: T17b, T16b, T18b in that order
completed: corrective code and evidence for T17b, T16b, T18b
remaining: owner review and activation; documented deferred findings
---

# Wave 2 Batch 2A corrective report, 2026-09-08

This report records the three corrective tasks specified in the full [independent review](REVIEW-wave2-batch2a-2026-09-08.md), following [the corrective brief](CODEX-BRIEF-wave2-fixes.md). Work completed in order: T17b, T16b, then T18b. It stops before Batch 2B. No API restart, pipeline run, G3 or metered provider call is part of this work.

The [original Batch 2A report](REPORT-wave2-batch2a-2026-09-08.md) remains an unchanged historical record. This report corrects the evidentiary claims below rather than rewriting that record.

## Corrections to the earlier evidence

- The original nested-redaction orchestration test proved that judge-produced text was redacted somewhere. It did not prove that the orchestrator's own redaction was necessary: the judge parser had already redacted its input. The new T17b auth-skip report bypasses that parser.
- The original attempt-reset checks did not bind the in-memory map deletion. They stayed green when that deletion was removed. The new T17b control reaches the owner-message requeue return and fails the next build before judging.
- The port 4323 observation did not establish that the client received the direction-reason field. With the older API, it borrowed the mockup-lock reason. T16b now treats the absent field as no recorded reason.
- The earlier live 404 for `visible-acceptance/x.spec.mjs` was non-discriminating because that clinic file did not exist. Exposure controls need planted, existing files, exact refusal codes and positive product responses.

## Starting state and isolation

Root confirmed source-clean state at `ecb4787` before corrective edits. Existing modified and untracked user documentation remains in place. The initial build exited 0; 134 selected baseline checks passed with zero failures, skips or cancellations in `/tmp/wave2-fixes-baseline.log`. These are selected checks, not a new full-suite result.

The fresh snapshot `/tmp/wave2-fixes-protected-baseline.json` covers 243 protected and existing-document files. The final comparison checked all 243 snapshot files: 242 were byte-identical, and only `BACKLOG.md` differed. Its original 8,998-byte prefix was preserved exactly; the owned append is 2,168 bytes. Tests must use temporary harness roots and injected providers/gates; mutations must be restored and must fail with an assertion that names the mutated behavior. A nonzero exit caused by a selector, startup error or neighboring assertion is not a successful control.

## T17b: truthful judge summary and attempt-scoped evidence

Completed in `d7016bba82e8a686dab0e75529194f130a5fabe6`.

The clean sentence now requires a judge that ran and returned `clean`. A `concerns` verdict remains visible even when the unchanged parser drops all finding rows. Gate outcome, criteria and `heldOutPass` were not changed. New orchestration controls isolate auth-skip redaction from the judge parser and exercise owner-message requeue followed by a failed build before judging.

Gate-only recovery removes stale judge JSON after target ownership is established, both before scoring and at finalization. Cleanup is best effort: an unremovable judge path does not fail a green sealed outcome. A directory fixture verifies this limitation explicitly; agreement of artifacts cannot be promised when cleanup itself cannot remove the path.

| Mutation or independence control | Result and decisive assertion |
|---|---|
| Restore finding-count clean condition | 0 pass, 1 fail: `a concerns verdict cannot claim clean even when every finding row was dropped` |
| Remove orchestrator report redaction | 0 pass, 1 fail: `judge.json: auth-skip report must redact before persistence without the judge parser` |
| Remove only judge-parser redaction | 1 pass, 0 fail; the auth-skip test bypasses that parser |
| Remove attempt-entry in-memory deletion | 0 pass, 1 fail: `the requeued attempt must not borrow the previous clean judge report` |
| Remove recovery entry cleanup, retain finalizers | 1 pass, 4 failures including parent aggregation; three decisive assertions: `T17b gate-only scorer-entry cleanup must remove stale judge.json before scoring passed`, `T17b gate-only scorer-entry cleanup must remove stale judge.json before scoring failed`, `T17b gate-only scorer-entry cleanup must remove stale judge.json before scoring infra_failed` |
| Remove recovery finalizer cleanup, retain entry | 0 pass, 5 failures including parent aggregation; four decisive assertions: `T17b gate-only owned-target judge cleanup must remove stale judge.json at passed finalization`, `T17b gate-only owned-target judge cleanup must remove stale judge.json at failed finalization`, `T17b gate-only owned-target judge cleanup must remove stale judge.json at infra_failed finalization`, `T17b gate-only owned-target judge cleanup must remove stale judge.json at boot scoring-state finalization` |

Each negative mutation exited 1. Compiled bytes were restored and checked for equality. Restored report checks passed 60/60, orchestration 9/9, and recovery/security/store 41/41, with zero skips or cancellations. Root also passed the initial combined 123 checks plus 9 orchestration checks. These overlapping selections are not summed into a full-suite total.

Build from `dashboard/server`: `npm run build --silent`, exit 0. Mutation selectors and restored commands below ran from `dashboard/server`:

```sh
node --test --test-name-pattern='T17b concerns' dist/verdict.test.js
node --test --test-name-pattern='T17b auth-skip' dist/orchestrator.test.js
node --test --test-name-pattern='T17b finish requeue' dist/orchestrator.test.js
DASHBOARD_LIVE_SMOKE=0 node --test --test-name-pattern='T17b gate-only replay|boot finalizes a valid scoring-state score' dist/gate-recovery.test.js
node --test dist/verdict.test.js dist/run-report.test.js
node --test --test-name-pattern='T17|terminal creative recovery keeps' dist/orchestrator.test.js
DASHBOARD_LIVE_SMOKE=0 node --test dist/gate-recovery.test.js dist/gate-recovery-security.test.js dist/gate-recovery-store.test.js
```

Simplification, security and logic review were dry. Runtime review caught an assertion placed inside a fake scorer where production error handling could swallow it. The test was corrected to assert observations outside that boundary, then separate entry-only and finalizer-only mutations bound the intended behavior. Final logic/runtime review was dry. Root's post-task comparison found all 243 protected and existing-document files unchanged.

Evidence: `/tmp/wave2-fixes-t17b-core-evidence.txt` and `/tmp/wave2-fixes-t17b-recovery-mutations-root.log`; root directly ran the corresponding `verify-wave2-fixes-t17b-*-mutations.py` scripts.

## T16b: shared timeout reason and absent-field behavior

Completed in `55ae6e272e728c97b6515ee59c365560d482f50b` (nine source/test files).

Both timeout writers and both classifiers use one reason constant. Because `design-lock.ts` imports Node filesystem modules, the constant lives in a browser-safe leaf and is re-exported by that server module. The client imports the safe leaf. This preserves the requested server export without bundling server-only dependencies into the client.

A writer-side test independently pins the exact persisted wire text as well as its relationship to the constant. That intentional test literal takes precedence over the review's conflicting request that a grep find the phrase only at its definition. Unchanged owner-facing timeout sentences and log prose also retain the phrase. Preserving their wording takes priority over a literal-only grep result; the enforced requirement is one constant for both writers and both classifiers, with the independent wire-text pin.

An absent `chosenDirectionReason` behaves like null when a direction chooser is recorded, without borrowing the mockup-lock reason. Record shape and owner wording remain unchanged.

Root executed four backend and three browser mutations. Each failed at its intended assertion:

| Mutation | Decisive red assertion |
|---|---|
| Direction writer bypasses constant | `direction timeout writer must persist the shared reason` (1 failed) |
| Legacy writer bypasses constant | `legacy timeout writer must persist the shared reason` (1 failed) |
| Constant's wire text changes | `direction timeout wire text must remain exact` (1 failed) |
| Cron borrows absent direction reason | `an absent direction reason must not borrow the mockup-lock reason` (17 passed, 1 failed) |
| UI borrows absent direction reason | `omitted direction reason is reported as absent` (1 failed; received mockup sentinel) |
| Direction classifier accepts incidental timeout phrase | `direction reader rejects incidental timeout wording` (1 failed) |
| Mockup classifier accepts incidental timeout phrase | `mockup reader rejects incidental timeout wording` (1 failed) |

Restored bytes matched their originals. Root's restored checks passed 42 server unit checks, 2 actual timer checks and 28 browser checks. Client typecheck and scoped lint exited 0. Commands from `dashboard/server`: `npm run build --silent`, `node --test dist/design-lock.test.js dist/cron/cron-report.test.js` and `node --test --test-name-pattern='RULE 1: a parked run|T16b direction timer' dist/orchestrator.test.js`; from `dashboard`, `npx playwright test tests/design-lock.browser.spec.ts --project=browser`.

Computer Use observed the fixture on 4322 with `chosenDirectionBy: ui-designer`, the reason key actually absent, and a distinct mockup-reason sentinel. The panel showed “ui-designer chose Terminal grid. No reason was recorded.” without the sentinel. This replaces the earlier non-discriminating observation. Root stopped the temporary fixture API on 4177 and Next server on 4322; API pid 918 on 4176 stayed unchanged. All 243 protected files still matched.

Evidence: `/tmp/wave2-fixes-t16b-backend-evidence.txt`, `/tmp/wave2-fixes-t16b-client-mutations-root.log`, `/tmp/wave2-fixes-t16b-client-restored-root.log`, and the three `/tmp/wave2-t16b-*-control.log` assertion logs.

## T18b: API preview exposure and portable static controls

Completed in `57b74d691904c768d982a56b9789fa605a0801af`.

The review requires preview-only checks after `resolveWorkspacePath` succeeds, preserving existing refusal codes, but also asks encoded `.git` to return the new 404 `path_internal`. The existing resolver refuses `.git` before that success point. Both requirements cannot hold simultaneously. Root resolved the conflict by preserving the existing resolver contract: `.git` and `.env` retain 403 `path_forbidden`; newly denied internal paths receive 404 `path_internal`. This is an explicit deviation from the blanket encoded-`.git` expectation in AC5, preserving the mandated guard placement and existing refusals.

The API preview now uses the shared static predicate after existing workspace resolution succeeds, once on the requested workspace-relative path and again on its real target. Owner code-browser functions remain unchanged. Existing resolver refusals precede the new rule, so this is not a universal existence-nondisclosure guarantee. The name policy prevents accidental exposure of harness paths; it does not prevent deliberate copying or hard-link republication of their contents.

Root exercised GET through temporary API fixtures. Against the exact pre-change compiled resolver, eleven existing internal-file requests returned 200 with their planted markers, and the internal-name alias to public script also returned 200. With the new resolver they return 404 `path_internal`; product root/script responses remain 200. Site-root-prefixed product paths and the owner's code-browser access remain covered.

The two API guards have independent controls. Removing only the requested-path guard failed `T18b requested-path guard must refuse GET /.claude/product-alias.js`: the internal alias served its public target with 200 while the public alias to an internal target remained 404. Removing only the real-target guard failed `T18b real-target guard must refuse GET /ticket-alias.txt` and `T18b real-target guard must refuse GET /refs-alias/manifest.json`: both served internal markers with 200 while the requested internal alias remained 404. Restored API/code-browser/execution-contract checks passed 51/51.

Four static mutations bound six decisive assertions (one assertion is shared across two mutations):

| Mutation | Decisive assertion(s) |
|---|---|
| Remove both case folds | `shared predicate must fold the ticket name`; `mixed-case internal file must be refused: /Tests/x.txt` |
| Remove decoded-backslash refusal | `backslash guard must refuse the existing POSIX file, not rely on a stat miss` |
| Remove malformed-literal decode catch | `malformed acceptance URL literals must be reported instead of throwing` |
| Make shared predicate allow internal paths | `shared predicate must fold the ticket name`; `acceptance source guard must use the shared internal-path policy` |

The backslash fixture is an existing POSIX filename, not a missing path; it proves the lexical refusal on that platform. The malformed-literal check identifies the assertion rather than counting a bare URIError as success. Restored static checks passed 68/68; compiled bytes matched their originals.

Root also ran actual Linux checks in exactly three existing generic `node:22` containers: original 2 passed; one mutation removing both case folds produced 2 named failures; restored 2 passed. Fixtures lived on Linux `/tmp` tmpfs, the copied modules were mounted read-only, and networking/pulls were disabled. The failures were `shared predicate must fold the ticket name` and `mixed-case internal file must be refused: /Tests/x.txt`. Host compiled bytes remained unchanged. This closes the Linux case-control gap; it does not measure L5 Unicode folding.

Commands from `dashboard/server` and `bakeoff`, respectively:

```sh
DASHBOARD_LIVE_SMOKE=0 node --test --test-name-pattern='T18b preview internal-path matrix' dist/preview-route.test.js
DASHBOARD_LIVE_SMOKE=0 node --test dist/preview-route.test.js dist/code-files.test.js dist/execution-contract.test.js
node --test dist/tier0.test.js
```

The Linux invocation used the temporary copied-module directory shown in its evidence log:

```sh
docker run --rm --pull=never --network none --read-only --tmpfs /tmp:rw,nosuid,nodev --mount type=bind,src=/var/folders/7t/1svm6vyx47d4fcys1gpxf5m80000gn/T/t18b-linux-case-1ve63gpb,dst=/app,readonly --entrypoint=node node:22 --test --test-name-pattern='T18b shared predicate|T18b mixed-case' /app/dist/tier0.test.js
```

Simplification, security, logic and runtime reviews returned no production findings. Root caught a mutation-script check that initially searched for a test title, which could also appear on a passing run; it was corrected to require the explicit failing assertion before execution. Final logic/runtime review was dry. Production changes are limited to the exported predicate, backslash refusal, preview guards and associated comments/type. API pid 918 remains on 4176 without restart.

Evidence: `/tmp/wave2-fixes-t18b-api-mutations-root.log`, `/tmp/wave2-fixes-t18b-static-evidence.txt`, `/tmp/wave2-fixes-t18b-linux-case-evidence.txt`. Root's current comparison preserves 242 files unchanged and the backlog's original 8,998-byte prefix, with the separately owned deferred section and implementation-status note appended. Final integration passed as recorded below.

## Final integration and activation state

Both package builds exited 0. The full bakeoff package passed 291/291 tests. The selected twelve server suites passed 216/216, and the selected orchestration pattern passed 11/11. All had zero failures, skips and cancellations. This corrective pass did not run the entire server suite; the earlier broad-suite baseline remains in the original report. The restored 28 browser tests, client typecheck and scoped lint also passed.

From `bakeoff`:

```sh
npm run build --silent
DASHBOARD_LIVE_SMOKE=0 node --test dist/*.test.js
```

From `dashboard/server`:

```sh
npm run build --silent
DASHBOARD_LIVE_SMOKE=0 node --test dist/verdict.test.js dist/run-report.test.js dist/gate-recovery.test.js dist/gate-recovery-security.test.js dist/gate-recovery-store.test.js dist/cron/cron-report.test.js dist/code-files.test.js dist/preview-route.test.js dist/execution-contract.test.js dist/design-lock.test.js dist/wave2-prompt-goldens.test.js dist/judge.test.js
DASHBOARD_LIVE_SMOKE=0 node --test --test-name-pattern='T17|terminal creative recovery keeps|RULE 1: a parked run|T16b direction timer' dist/orchestrator.test.js
```

From `dashboard`, root also ran these client checks; both exited 0:

```sh
npm run typecheck --silent
npx eslint src/components/run/design-lock.tsx tests/design-lock.browser.spec.ts
```

Evidence: `/tmp/wave2-fixes-final-bakeoff.log`, `/tmp/wave2-fixes-final-server.log`, `/tmp/wave2-fixes-final-orchestrator.log`.

**The corrective backend is not activated.** Root's last read-only GETs on the unchanged API pid 918 at 4176 still returned 200 for the clinic preview's `TICKET.md`, `design-refs/manifest.json` and existing `visible-acceptance/booking-wizard.spec.mjs`. The code fix and isolated route tests do not claim that this old process serves it. Owner review and a later controlled restart remain necessary. No restart, pipeline run, G3 or Batch 2B work occurred; no push was performed.

## Deferred work and boundaries

L2, the unmapped accessible-name duplication, and L10, the hue comment, wait for the next T15 touch. L5, Unicode filesystem folding, remains unmeasured and needs a Mac measurement before a policy change. L9's dial-format rewrite belongs with T26 and new prompt captures; its scroll-progress declaration and `DIAL_DEVIATION` semantics need a separate video-policy backlog item. These deferred entries were appended to the backlog without overwriting existing changes.

The API on 4176 is not restarted in this session. Activation guidance in the review is reference material, not an action in this scope. Batch 2B and G3 are not started. Task commits, exact negative assertions and restored verification are recorded above. The final post-integration comparison preserved all 242 non-backlog files and the backlog's exact original 8,998-byte prefix; its 2,168-byte addition contains only the owned deferred/status entries.
