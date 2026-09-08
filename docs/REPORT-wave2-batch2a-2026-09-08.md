---
document_status: complete
written: 2026-09-08
scope: wave 2 Batch 2A, T15 to T20
completed_through: T20
remaining: T21 to T26 after owner review; documented deferred findings and controlled API activation
---

# Wave 2 Batch 2A report, 2026-09-08

T15 through T20 are implemented, tested and committed. Final checks found only the three pre-existing server-test failures; the protected-file comparison found no changes. No control run was started. Batch 2B, T21 through T26, remains behind the owner's review of the completed Batch 2A report.

The specification is [the wave 2 plan](PLAN-wave2-taste-and-copy-2026-09-05.md), narrowed by [the wave 2 brief](CODEX-BRIEF-wave2.md). All twelve default decisions in that brief are accepted. G3 must never be started by Codex.

## Commits

| Work | Commit |
|---|---|
| Prompt baselines, before production prompt edits | `d4f4dbe87331256f059132f17e0d2a2c750c56f0` |
| T15, canvas role titles | `3f331f7cd32807f5a611c136a5c43aed76f63a58` |
| T16, judged choice and fallback attribution | `e496b88745430e9d723d1b54cc82da583e277964` |
| T17, judge findings in the verdict | `13ca41838eed4d65dbc03be914b217748a750610` |
| T18, internal paths refused by the static resolver | `3ccc6f1c17ce9e7f3c4a7ab134556f39727d1aef` |
| T19, contract and direction video policy | `6b69e62dd793b638fc2d0130152d0818b8218c82` |
| T20, contract motions at low intensity | `677512e61dc7d8752cdacdc6dddc1a895de56e6c` |
| T16 parity-test expectation follow-up | `a55a28971fb92f2bcb1896a497d9de3fdb308eb1` |

## Prompt evidence captured first

Runtime prompt bytes were captured from `759d1be`. The committed [golden hashes](../dashboard/server/src/test-fixtures/wave2-prompt-goldens.ts), [inputs](../dashboard/server/src/test-fixtures/wave2-prompt-inputs.ts) and [tests](../dashboard/server/src/wave2-prompt-goldens.test.ts) cover available/no-video expansion, available canvass, original video consumption and its exact remainder, the visual motion statement, three motion refusal variants, and author motion guidance.

From `dashboard/server`, `npm run build --silent` exited 0 and `node --test dist/wave2-prompt-goldens.test.js` passed 21 tests. XOR-changing the first ASCII byte of each actual prompt at the compiled test's `assertGolden` call produced 10 failures and 11 passes, exit 1. Restoring and rebuilding returned 21 passes, zero failures. The failure was `runtime bytes must match the captured hash`.

## T15: role titles with agent identity retained

`titleOf` now supplies all four canvas title sites: card, detail sheet, inspector and roster. Known roles become the title; the agent name remains secondary and in the accessible name. Unmapped named agents keep their name, and nameless sessions remain `session`. The new `debug` role covers `debug`, `debugger`, `debugfix` and `troubleshoot`. The `gate` lane still falls back to `review`; only the debug color was added.

| Deliberate mutation | Observed failure |
|---|---|
| Card h3 uses `node.agent` instead of `titleOf(node)` | Scoped browser test: expected `design`, received `taste-frontend-expert`; 1 failed, exit 1 |
| Nameless fallback becomes `unmapped` | Expected `session`, received `unmapped`; 1 failed, exit 1 |
| Every unmapped identity becomes `session` | Expected `some-agent-nobody-has-named`, received `session`; 1 failed, exit 1 |

After restoration, from `dashboard`:

| Command | Result |
|---|---|
| `npx playwright test -c tests/no-server.config.ts canvas-roles.unit.spec.ts` | 22 passed, exit 0 |
| `npx playwright test --project=browser canvas-titles.browser.spec.ts` | 3 passed, exit 0 |
| `npx eslint src/components/canvas/{roles.ts,agent-node.tsx,sheet.tsx,inspector.tsx,roster.tsx} tests/{canvas-roles.unit.spec.ts,canvas-titles.browser.spec.ts}` | Exit 0 |
| `npm run typecheck` | Exit 0 |

The standalone inspector header has no current UI caller: the sheet passes `header={false}`. Its title was checked in source; browser tests cover the reachable sheet and retained identity line. Root Computer Use on the current-source dashboard at port 4323 also observed role headings and secondary agent names on the clinic run.

## T16: show the recorded chooser and reason

Judged choices show `judged by ui-designer` and quote the recorded direction reason. A fallback mentions timeout only when its reason contains `before the timeout`; a missing-choice-file fallback says the chooser wrote no usable choice. Owner wording stays unchanged. Direction attribution takes precedence over mockup-lock attribution.

The plan omitted a required connection: the persisted record had `chosenDirectionReason`, but the API did not expose it. An optional field was added to both API type mirrors and the read-only HTTP projection. Persisted record shapes and writers were not changed. An absent optional field supports older servers; explicit null means no direction reason and does not borrow a different mockup reason.

| Deliberate mutation | Observed failure |
|---|---|
| Judged pick falsely says no choice arrived | Judged-reason browser test rejected `No choice arrived`; 1 failed, exit 1 |
| Timeout fallback loses its timeout sentence | Timeout browser test could not find the required explanation; 1 failed, exit 1 |
| Every non-null fallback reason becomes a timeout | No-file browser test lost the usable-choice explanation; 1 failed, exit 1 |

After restoration:

| Cwd | Command | Result |
|---|---|---|
| `dashboard` | `npx playwright test --project=browser design-lock.browser.spec.ts` | 24 passed, exit 0 |
| `dashboard` | `npx playwright test -c tests/no-server.config.ts design-lock.unit.spec.ts` | 15 passed, exit 0 |
| `dashboard/server` | `node --test dist/cron/cron-report.test.js` | 18 passed, exit 0 |
| `dashboard/server` | `node --test --test-name-pattern='THE FOUR STAGES ON THE WIRE' dist/api.test.js` | 1 passed, exit 0 |
| `dashboard` | `npx eslint src/components/run/design-lock.tsx src/lib/api-types.ts tests/design-lock.browser.spec.ts` | Exit 0 |
| `dashboard` | `npm run typecheck` | Exit 0 |
| `dashboard/server` | `npm run build --silent` | Exit 0 |

Root's combined unit/browser verification recorded 39 passes. Computer Use on port 4323 confirmed the judged badge and the full recorded clinic reason in accessibility text; the unfold button remained present.

A later broad-suite check exposed two stale API-parity test expectations: they still required 14 fields and omitted the new optional reason. The test-only follow-up preserves the closed field list and type checks, updates the count to 15, and asserts `chosenDirectionReason?: string | null`. Before correction, parity reported 18 passes and 2 failures; afterward, 20 passed. Removing the field from a temporary source view reproduced 18 passes and 2 failures; restoration returned 20 passes. Production API code did not change in this follow-up, which also completed simplification and three review lenses without findings.

## T17: persist and render the code-reading judge

The full `JudgeReport` passes through `redactForPersistence` before entering the per-run report map and `results/judge.json`. The verdict contains a `Code-reading judge (non-gating)` section. It prints the clean claim only for a passing outcome with a judge that ran, was available and returned no findings. Missing, skipped and unavailable reports are named explicitly.

The plan also omitted `run-report.ts`, which connects the orchestrator to the verdict renderer. Optional report plumbing was added there. Gate outcome computation and criterion rendering were left unchanged. The judge's injectable test query remains tool-less.

Report authority is cleared at attempt entry, including recovery entry. This matters when an owner message causes a terminal transition to requeue. Terminal creative recovery records that it does not run this judge. A disk-write failure preserves the redacted in-memory findings for the verdict and logs the failure without failing a green run. No old report is restored from disk.

The [clinic judge fixture](../dashboard/server/src/test-fixtures/clinic-judge-report.ts) reconstructs finding/summary bytes from events 908 through 910. Existing parser truncation is retained. Its null token and rate-limit fields are fixture data, not recovered original accounting.

Restoring the unconditional clean sentence caused both T17 verdict and run-report tests to fail: 0 passed, 2 failed, exit 1. The verdict contained both concerns and the forbidden `nothing was noted against it` sentence. Root independently passed the following checks before the mutation; the implementer passed the same 83 report checks and 7 orchestration checks after restoration:

| Cwd | Command | Result |
|---|---|---|
| `dashboard/server` | `npm run build --silent` | Exit 0 |
| `dashboard/server` | `node --test dist/verdict.test.js dist/run-report.test.js dist/judge-ceiling.test.js dist/wave2-prompt-goldens.test.js` | 83 passed, zero failed/skipped |
| `dashboard/server` | Focused orchestration command below | 7 passed, zero failed/skipped |

```sh
node --test --test-name-pattern='T17|terminal creative recovery keeps' dist/orchestrator.test.js
```

Those orchestration checks cover persistence, unavailable output, nested redaction, clean-then-auth-skip on the same run, disk failure, cancellation before judging, and stale-report replacement during terminal recovery.

## T18: refuse harness files through the shared static resolver

`resolveStaticFile` rejects dot-prefixed segments after decoding and before normalization. Root names `TICKET.md`, `design-refs`, `visible-acceptance` and `tests` are denied case-insensitively. The same policy checks the relative real target after the existing containment check, so a public symlink cannot expose a private file. Exact-file, directory-index and `.html` fallback ordering remains unchanged. README, node_modules, nested product paths and public product symlinks remain servable; `.well-known` is denied as specified.

Two improvements were necessary to prove the behavior. `startStaticServer(root, 0)` previously reported port 0, so it now returns the actual bound port from `server.address()`. This correction preceded the old-resolver negative test. On this Mac, `ticket.md` resolves the existing `TICKET.md` while `realpathSync` retains the requested case, so an exact-case deny list was insufficient. A separate negative run reproduced that bypass before the case-insensitive correction.

| Evidence | Result |
|---|---|
| New exposure tests against old resolver, with only port reporting corrected | 2 passed, 20 failed; actual `GET /.git/config` was 200 rather than 404 |
| First exact-case guard, request `/ticket.md` | Returned the file path instead of null; negative test failed |
| Restored final `npm test`, cwd `bakeoff` | 286 passed, zero failed/skipped; root independently repeated |
| `node --test dist/execution-contract.test.js`, cwd `dashboard/server` | 10 passed, zero failed/skipped; root independently repeated |

The tests send raw HTTP paths to avoid URL normalization hiding encoded traversal. GET and HEAD check product responses before denials. Symlink tests include inside-private, outside-root and allowed product targets. The acceptance-source guard reads existing suite sources without editing them, asserts that files were inspected, and has planted denied URLs plus allowed URLs to defeat a detector that returns nothing.

Root confirmed that port 4321 was an ad hoc Python server, PID 9413, serving the clinic workspace. That process alone was replaced by a direct `startStaticServer` listener, PID 71532, session 91571. The live API at 4176 was deliberately not restarted: its boot path can migrate the DB, reconcile runs and start the supervisor.

The direct server was launched from the repository root using `node --input-type=module`, importing `startStaticServer` from `./bakeoff/dist/tier0.js` and passing the clinic workspace with port 4321. This does not initialize the dashboard database.

Root's raw HTTP probe recorded 10 requests before replacement and 28 after:

| Path | Before GET | After GET / HEAD |
|---|---:|---:|
| `/`, `/index.html`, `/app/styles.css`, `/app/main.mjs` | 200 | 200 / 200 |
| `/README.md` | Not probed | 200 / 200 |
| `/.git/config`, `/TICKET.md`, `/design-refs/manifest.json`, `/tests/`, `/%2e%2e/` | 200 | 404 / 404 |
| `/ticket.md`, `/DESIGN-REFS/manifest.json`, `/app/%2e%2e/index.html` | Not probed | 404 / 404 |
| `/visible-acceptance/x.spec.mjs` | 404, nonexistent fixture path | 404 / 404 |

After replacement, denied GET bodies were `not found\n` (10 bytes), and HEAD bodies were empty. Computer Use confirmed the clinic form still loaded. The browser client blocked its attempted TICKET navigation, so the raw HTTP 404 is the independent proof for that path.

Root also checked every local asset directly referenced by the clinic's `index.html`: `app/main.mjs`, `app/styles.css`, `assets/responsive-comparison.jpg`, `assets/world/leg-1-poster.webp` and `assets/world/leg-2-poster.webp` all returned 200 on the corrected listener.

## T19: contract and direction video policy

Video legs require contract motion intensity of at least 8 and, when declared, direction intensity of at least 8. The shared threshold also supplies compiler and author guidance without changing their captured prompt bytes. The policy explicitly excludes `app`, including when a future page-kind vocabulary admits that value.

A missing contract preserves legacy behavior and records exactly `no contract; policy not applied`. An existing malformed contract declines video. The first anchored direction declaration governs: a malformed first declaration declines video, duplicates are counted in the reason, and a genuinely absent declaration lets the contract decide. Reasons record the numeric dials or `unknown`. The reader admits only bounded regular files up to 1 MiB and projects schema, page kind, intensity and bounded unique motion IDs; it does not compile evidence or read referenced evidence files.

Before expansion, the orchestrator reads the selected canvass note; before spend, it reads the expanded `direction.md`. Denied full, degraded and unavailable-capability expansion paths explain the denial, and the full template cannot request animation. Allowed and omitted-policy prompt bytes remain unchanged. The plan's universal dial-format rewrite was omitted because it contradicts that golden requirement; parsing the measured and legacy forms supplies the required decision without changing allowed prompts. Video consumption removes only the unsupported reference-site claim, proven against the frozen remainder; the original capture remains an immutable historical hash check.

Denied marks are counted even when video capability is unavailable. Capability facts and existing caps remain unchanged. A denied resume neither advertises existing legs nor overwrites the old spend record nor invokes a new leg.

| Deliberate compiled-JavaScript mutation | Observed failure |
|---|---|
| Policy always allows | 2 failed: low contract accepted and low-motion orchestration spawned 2 legs instead of 0 |
| Policy always denies | 2 failed: high contract refused and high-motion orchestration spawned 0 legs instead of 2 |
| Omit lane policy wire | 1 failed: low-motion orchestration spawned 2 legs instead of 0 |
| Omit expansion policy wire | 1 failed: denied expansion still advertised available motion |

Each mutation exited 1. Original compiled bytes were restored; TypeScript and frozen fixtures were unchanged during mutations. Root independently passed 195 policy/prompt/compiler/author/pilot/golden checks, 4 parser checks and 2 orchestration checks. The restored implementation checks repeated all 201 passes. Commands ran from `dashboard/server` after a successful build:

```sh
node --test dist/design/video-policy.test.js dist/creative-motion-policy.test.js dist/design/video-legs.test.js dist/design/video-lane.test.js dist/wave2-prompt-goldens.test.js dist/creative-contract.test.js dist/creative-contract-author.test.js dist/creative-pilot.test.js dist/design-prompt.test.js
node --test --test-name-pattern='motion intensity' dist/design-manifest.test.js
node --test --test-name-pattern=T19 dist/orchestrator.test.js
```

The first new orchestration checks passed but took 123 seconds to exit. Temporary async-hooks instrumentation identified eight referenced 121-second native spawn timers in the existing absent-Docker scorer path. The new T19 helper now reuses the existing fake green gate, preserving the temporary-HOME video script stubs; its two tests exit in about 2.5 seconds. Scorer code was not changed, and no metered call was made.

Root also read the actual clinic contract and direction files without running the video lane. The contract projected `saas_landing`, intensity 3, and IDs `m.step`, `m.error`, `m.confirm`. The selected note declared intensity 2 once; the expanded note declared intensity 3 once. Planning the real manifest without policy produced 2 legs. Both new policies produced 0 legs and 2 declined marks, with reasons recording 3/2 and 3/3 respectively. This check called no spawn/provider and wrote no fixture.

## T20: contract motions satisfy the low-intensity floor

At intensities 1 through 4 with a nonempty motion list, the motion stop-hook accepts source containing every exact contract `data-motion-id` marker. A missing marker refuses completion and names the missing IDs. The four existing authored-motion satisfiers remain effective. Mid/high intensity, absent or invalid policy, and empty motion lists retain the previous behavior; frozen goldens check the unchanged refusal and visual-statement bytes.

The low-intensity `VIS-MOTION-AUTHORED` statement names the declared IDs and requires their implemented behavior. It explicitly says markers alone are not visual proof and unrelated fades cannot replace missing motions. Criterion identity and all other criteria remain unchanged. With no captures, the visual report still records unknown outcomes rather than inventing observations.

The host reads T19's bounded projection afresh for all four artifact builder request paths: regular build, gate repair, creative artifact repair and terminal creative recovery. It also fills visual-gate input. `BuildRequest` passes the policy through the Claude builder to both Stop and SubagentStop callbacks; the hook does not read protected results from its sandbox. The separate adversary builder works in its scratch workspace and does not receive this artifact policy. The existing motion-bar environment flag remains required.

Review found one acceptance gap before completion: the successful low-motion reason named the contract but omitted its actual IDs. The fix now reports `all low-motion creative contract markers: m.fade, m:focus` for that two-ID input, protected by an exact assertion. The corrected source completed simplification plus security, logic and runtime review without further findings.

Root independently passed 232 rule/hook/builder/reader/golden/visual checks and 4 actual orchestration checks after that fix: 236 passes, zero failures or skips. The orchestration checks cover all repair/recovery wires and policy freshness after a contract changes. Server build, final client typecheck and scoped client lint exited 0. The corrected implementation was committed as `677512e61dc7d8752cdacdc6dddc1a895de56e6c`.

Eleven compiled-code mutations were rejected: remove the low-marker shortcut; accept any supplied contract; let high intensity use the shortcut; omit policy forwarding in the hook or builder options; omit each of the four artifact builder wires; omit host visual input; and omit visual-runner forwarding. All exited 1. The first attempt at the eleventh mutation used a `T20` selector that did not select its test; the verification script errored instead of counting it as a success. The corrected visual-runner check ran 18 tests, with 17 passes and the expected failure. The first ten mutations were repeated during that corrected run.

Original compiled bytes were restored and compared for equality. A fresh build then passed all 232 targeted checks plus 4 orchestration checks again. No source or frozen golden bytes changed during these mutations. From `dashboard/server`:

```sh
npm run build --silent
node --test dist/builders/antislop-rules.test.js dist/builders/antislop-hook.test.js dist/builders/claude-builder.test.js dist/wave2-prompt-goldens.test.js dist/creative-motion-policy.test.js dist/visual-criteria.test.js dist/visual-gate-run.test.js
node --test --test-name-pattern='T20|CREATIVE-ARTIFACT: one deterministic refusal|terminal creative recovery keeps' dist/orchestrator.test.js
```

**Activation remains separate.** Backend changes are compiled and tested, but the existing API process at port 4176 was not restarted because startup can reconcile state and pump runs. A controlled activation is required before a future real run uses these backend changes. This batch starts no such run.

## Baseline limitations and deferred work

The initial full server suite was already red: 2,629 tests, 2,623 passes, 3 failures and 3 skips. The failures were the historical DB-copy assertion (`run-2026-08-25T10-30-39-122Z-d728ab79` continues count 1, expected 0), the legacy defect ledger count 25, expected 24, and parsing `run-cont-86f1ba81c2d280d23d07`'s old continuation manifest. These remain deferred; protected historical state was not rewritten to satisfy tests.

The first final full server run exited 1 after 291,013 ms: 2,671 tests, 2,663 passes, 5 failures and 3 skips. Three failures matched the baseline above; two were the stale T16 parity expectations subsequently corrected in the test-only follow-up. All eight calibration tests passed in that run. The final rerun excluded only calibration and exited 1 after 174,120.494917 ms: 2,663 tests, 2,657 passes, 3 failures, 3 skips and zero cancellations. Its three failure identities and values exactly match the baseline; there were no others. Calibration source was unchanged after its eight passing tests. These are two actual runs, not a synthesized full-suite total.

Both broad checks ran from `dashboard/server`. Live smoke was disabled; the earlier full run used an isolated calibration root and serial calibration:

```sh
wave2_final_calibration_dir="$(mktemp -d /tmp/wave2-final-calibration.XXXXXX)"
DASHBOARD_LIVE_SMOKE=0 DASHBOARD_CALIBRATION_ROOT="$wave2_final_calibration_dir" CALIBRATION_CONCURRENCY=1 npm test > /tmp/wave2-server-final.log 2>&1
```

The final non-calibration check used:

```sh
npm run build --silent && rg --files dist -g '*.test.js' -g '!calibration.test.js' -0 | DASHBOARD_LIVE_SMOKE=0 xargs -0 node --test > /tmp/wave2-server-final-without-calibration.log 2>&1
```

The initial full dashboard lint reported 10,452 issues: 1,130 errors and 9,322 warnings. Generated `.next-audit24` output and pre-existing source findings contributed. Scoped changed-client lint and typechecks passed. The initial bakeoff suite passed 257 tests.

Full server tests need `DASHBOARD_LIVE_SMOKE=0` and an isolated `DASHBOARD_CALIBRATION_ROOT`; calibration executes local Docker scorer fixtures and resets its output directory. Existing historical DB tests either copy the DB before writes or open it read-only. No Gemini/Veo calls or live model runs were used for this batch's tests.

**Separate API-preview exposure remains open.** On the unchanged API at 4176, `/api/runs/<clinic-id>/preview/.git/config` returned 403, `/TICKET.md` returned 200 and `/app/main.mjs` returned 200. This route uses `code-files.resolvePreviewTarget` / `resolveWorkspacePath`, independently of the shared static resolver. Apply an equivalent internal-path policy specifically to API preview while preserving the owner's code browser, which intentionally permits inspection of visible acceptance files. T18 does not close this separate route.

T15 through T19 each received a report-only simplification pass followed by separate security, logic and runtime debugfix lenses, with no findings. T20 received the same passes, with its missing-ID reason finding fixed before final dry convergence. Runtime limits prevented fresh specialist sessions, so the existing review session applied those definitions serially; this was not independent agent fan-out. Root separately checked code, tests and the applicable live surfaces.

The clinic workspace, `dashboard/data/runs.db`, frozen suites and scorer/container assets remain protected. Root's comparison of the 240-file baseline snapshot at `/tmp/wave2-protected-baseline.json` found zero differences after T18's live server replacement. The final SHA-256 comparison after the server rerun and parity correction again checked 240 files and recorded `differences: []` in `/tmp/wave2-protected-final.json`. `git diff --check` exited 0, and the frozen prompt-fixture diff against `d4f4dbe87331256f059132f17e0d2a2c750c56f0` was empty. Existing user documentation changes were preserved. G3 was never started. Batch 2B stays deferred until the owner checkpoint.

## Local evidence index

These logs are temporary local artifacts. The commands and decisive outputs above are copied into this durable report so the conclusions do not depend on keeping `/tmp` indefinitely.

| Evidence | Local file |
|---|---|
| Golden capture and mutation | `/tmp/wave2-prompt-baseline-evidence.txt` |
| T15 mutations and restoration | `/tmp/wave2-t15-evidence.txt` |
| T16 mutations and restoration | `/tmp/wave2-t16-evidence.txt` |
| Root T16 39-check repeat | `/tmp/wave2-t16-root-browser.log` |
| T17 mutation and restoration | `/tmp/wave2-t17-evidence.txt` |
| Root T17 repeats | `/tmp/wave2-t17-root-report-tests.log`, `/tmp/wave2-t17-root-orchestrator-tests.log` |
| T18 old resolver, case bypass and restoration | `/tmp/wave2-t18-evidence.txt`, `/tmp/wave2-t18-case-red.log` |
| Root T18 repeats | `/tmp/wave2-t18-root-bakeoff.log`, `/tmp/wave2-t18-root-execution.log` |
| Root T18 raw live requests | `/tmp/wave2-t18-root-live-before.txt`, `/tmp/wave2-t18-root-live-after.txt` |
| Clinic's five local assets | `/tmp/wave2-t18-root-assets.json` |
| T19 mutations and restored 201 checks | `/tmp/wave2-t19-evidence.txt` |
| T19 prompt and parser checks | `/tmp/wave2-t19-prompts-evidence.txt` |
| Root T19 repeats | `/tmp/wave2-t19-root-tests.log`, `/tmp/wave2-t19-root-orchestrator.log`, `/tmp/wave2-t19-root-parser.log` |
| T19 actual clinic projection and planning | `/tmp/wave2-t19-root-clinic.json` |
| T20 eleven mutations and restored 236 checks | `/tmp/wave2-t20-evidence.txt` |
| Root T20 targeted checks | `/tmp/wave2-t20-root-tests.log`, `/tmp/wave2-t20-root-orchestrator.log` |
| Final client checks | `/tmp/wave2-dashboard-final-typecheck.log`, `/tmp/wave2-dashboard-final-lint.log` |
| T16 parity correction and negative control | `/tmp/wave2-t16-parity-evidence.txt` |
| First final full server run | `/tmp/wave2-server-final.log` |
| Final server rerun without calibration | `/tmp/wave2-server-final-without-calibration.log` |
| Final protected-file comparison | `/tmp/wave2-protected-final.json` |
| Initial broad checks | `/tmp/wave2-server-baseline.log`, `/tmp/wave2-bakeoff-baseline.log` |
