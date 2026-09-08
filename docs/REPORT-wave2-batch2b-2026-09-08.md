# Batch 2B checkpoint, 2026-09-08

**Blocked on D15; Batch 2B is incomplete.** D13 and D14 are accepted in [the brief](CODEX-BRIEF-wave2.md). T21, T22 and carried corrective items 2 and 3 are committed. T23's warning persistence, API projection and display are committed as a partial prerequisite; its probe and classifier integration are paused on an unanswered owner decision. T24 through T26 and carried items 4 and 5 have not started. G3 has not run and remains owner-only.

| Work | Current behavior | Remaining work |
|---|---|---|
| Required carried item 1 and prompt captures | Previously accepted in `aa724165d435c9a1174f59f2150520e0c2a8f4b4` and `b88359b1a510e3b9ce3c1282fcc6d87897f06433` | Preserve the accepted prerequisite evidence |
| T21: sentence facts and requirement-copy checks | Complete in `0c27915f0ca361c8af040c9e2d5a139709d00d9a` under D13 | Final Batch 2B verification |
| T22: app page kind and routing | Complete in `e58bcb571424426b869295131a68a7aa9fd71daf` | Final Batch 2B verification |
| T23: decorative-control probe | Warning persistence/API/UI prerequisite committed in `41e97f7472a9dfcc87b871f8e55cbb155a689bb4`; literal clinic test remains red | D15 owner decision, then probe/classifier integration and acceptance evidence |
| T24: critic with available captures | Not started | Available-capture and no-evidence checks |
| T25: chooser evidence and departures | Not started | Chooser checks and carried items 4 and 5 |
| T26: hero amendment after choice | Not started | Follows T25; retain deferred dial-format work |
| Carried item 2: no-attempt judge cleanup | Complete in `142fc0698de646a6420fb7074624f3fba2ac3f63` | Final Batch 2B verification |
| Carried item 3: named cleanup-failure assertion | Complete in `f43cfd26586953e399943c5da1ffed8c1bd01c2f` | Final Batch 2B verification |
| G3 | Owner-only run, not started | Remains outside agent execution |

## Accepted decisions and starting evidence

D13 preserves the historical clinic contract unchanged and requires a separate derived fixture with sentence-level evidence locators. The derived fixture must be reproducible using T21's splitter and must produce exactly the six requirement errors. A named legacy test must prove that the frozen pre-T21 contract still compiles for continuations and gate-only recovery. Product reset text must remain a goal; `must` alone cannot turn a product sentence into a requirement. D13 supersedes the plan's T21 AC6 consequence that older contracts become stale and re-author.

D14 approves copying `app/wizard.mjs` into T23's isolated fixture because `app/main.mjs` imports it. The historical clinic directory remains read-only.

Root independently read the current API on port 4176: the missing internal `design-refs` and `visible-acceptance` paths returned `404 path_internal`, and clinic `/app/main.mjs` returned 200. This matches the owner's activation report. The agent did not restart the API. The prior prerequisite work and its negative controls remain recorded in [the prerequisite report](REPORT-wave2-batch2b-prerequisites-2026-09-08.md).

Before T21 changes, root reconstructed the legacy input through `ticketFromStoredReferences(TICKETtext, null)` and `authorInputFor`, using the actual compiled baseline. The exact input hash was `ed974f41fe8b01e882ada21fc11cf67bc7b1cb100c54ae4f129091ee343da0ef`. The original contract compiled successfully with hash `201a2aee2ebd2e2d0b9a92068c9f46a8be90d4c4d272cdedec9a8f9e3689448f`.

From `dashboard/server`, the initial T21 check was:

```sh
node --test dist/creative-contract.test.js dist/creative-contract-author.test.js dist/creative-pilot.test.js
```

`/tmp/wave2b-t21-baseline.log` reports **72 tests, 72 passed, 0 failed**. This is baseline evidence, not evidence for the unfinished implementation.

## Carried items 2 and 3

When `#writeVerdict` has no in-memory judge report, it now calls the existing best-effort `#resetJudgeReport`. This removes stale `results/judge.json` on no-attempt finalization while preserving verdict creation when cleanup fails. The recovery test now wraps `controller.recover(...)` in `assert.doesNotReject` and keeps its result assertions, so a cleanup regression identifies the recovery contract through a named failure.

Root's pre-fix command, from `dashboard/server`, was:

```sh
npm run build --silent && node --test --test-name-pattern='T17b no-attempt finalization|T17b gate-only judge cleanup failure' dist/orchestrator.test.js dist/gate-recovery.test.js
```

The build exited 0. `/tmp/wave2b-carried23-red.log` reports **3 tests, 1 passed, 2 failed** through the stale-file-removal and cleanup-failure-logging assertions.

Root then ran `python3 /tmp/wave2b-judge-mutations.py`. `/tmp/wave2b-judge-mutations.log` records these reversible compiled-module controls:

| Mutation | Observed failure | Restored module SHA-256 |
|---|---|---|
| Remove the no-attempt cleanup call | Node exited 1: `no-attempt finalization must remove stale judge.json when no judge report is in memory` | `e4cca21b92c4806ceae45ed3bf17fe9f42f7b468083f1329f4b32203eb694ecd` |
| Rethrow gate-only cleanup failure | Node exited 1: `Got unwanted rejection: judge cleanup failure must not throw out of recovery` | `e4591ce8846a7df283fbb32f65f64089bddc77b7b823ace338727f1625619343` |

Both modules were restored byte for byte. The second mutation failed through the named assertion rather than an unwrapped `ERR_FS_EISDIR`.

The first restored run passed 16 of 17 tests because a new test incorrectly expected a cancelled verdict to say the judge did not run. The implementing agent corrected that expectation after root identified the mismatch, preserving the existing `# NO VERDICT WAS REACHED` behavior, rebuilt and reran:

```sh
node --test --test-name-pattern='T17|terminal creative recovery keeps|RULE 1: a parked run' dist/orchestrator.test.js dist/gate-recovery.test.js
```

`/tmp/wave2b-carried23-root-restored.log` reports **17 tests, 17 passed, 0 failed**. That build included unfinished T21 imports which were inactive for these cases; it is not a final Batch 2B check.

Read-only simplify review found no issues. Low-depth debugfix security and logic passes found no issues; root's runtime check found the incorrect test expectation above. After correction, the runtime-edge and repeated logic passes found no further issues. These backend changes required no UI test.

## T21: sentence facts and requirement-copy checks

Commit: `0c27915f0ca361c8af040c9e2d5a139709d00d9a` (`fix: prevent requirement facts from becoming page copy`).

The host splits the owner brief into sentences, retains their original indexes and classifies each fact before authoring. The bounded projection retains nine sentences from each end when the brief exceeds eighteen sentences. Accessibility and implementation cues classify requirements; product transitions such as Back and Reset remain goals even when they contain `must`. Every resolved fact carries its host kind. Missing kinds fail closed, including before an author query.

The compiler rejects requirement proofs that authorize non-alt copy, non-alt content references and actions backed by requirements. A section whose proof references are all requirements fails with `REQUIREMENT_SECTION`, including when its references use only alt text. A rejected author contract consumes the attempt. New author records carry projection version 2; unknown versions fail closed.

D13's compatibility path requires an absent projection marker, the matching legacy input hash and the matching frozen contract hash. It reuses the historical projection only for that qualified record. Missing or changed hashes, current or unknown projection markers and changed contracts cannot enable compatibility. This implements D13's exception to the original AC6 stale-contract rule.

The derived clinic fixture changes evidence references only. Its named regeneration test compares it with output from the actual sentence splitter. The exact-six oracle names `p.a11y`, `p.focus`, `p.local`, `p.markers`, `p.responsive` and `p.run`; no product proof, including `p.reset`, belongs in that list. These are six errors at content-proof paths, not six total compiler findings: the test separately expects requirement sections `s.a11y`, `s.local`, `s.responsive` and `s.run`, and checks the host web-surface body reference. A separate named test compiles the frozen clinic through the actual legacy fresh-read path.

Root compared the historical ticket and contract with the fixture copies byte for byte:

| Fixture | Bytes | SHA-256 |
|---|---:|---|
| `clinic-t21-ticket.md` | 1405 | `822f12c1ba07308c9ff1496ec32adbe38f6e4a048840777e3fe4bb2cd8b26a20` |
| `clinic-t21-contract.json` | 22509 | `732310eaaea7249bf5c5ace36136a72d787443694ebf5d27e3a2dac75dcd350f` |

The author fixture is a four-key metadata projection with exact source values, not a full-file copy. The historical contract's canonical hash remains `201a2aee2ebd2e2d0b9a92068c9f46a8be90d4c4d272cdedec9a8f9e3689448f`.

Root ran this command from the repository root before mutations and again after restoration:

```sh
npm run build --silent --prefix dashboard/server && node --test dashboard/server/dist/creative-contract.test.js dashboard/server/dist/creative-contract-author.test.js dashboard/server/dist/creative-pilot.test.js dashboard/server/dist/creative-requirements.test.js dashboard/server/dist/creative-render.test.js dashboard/server/dist/render-manifest.test.js dashboard/server/dist/wave2-prompt-goldens.test.js dashboard/server/dist/wave2b-prompt-goldens.test.js
```

Both builds exited 0. `/tmp/wave2-t21-root-final.log` and `/tmp/wave2-t21-root-restored.log` each report **154 tests, 154 passed, 0 failed, 0 skipped**. The mutation command was:

```sh
python3 .tmp/wave2-fixes/t21-mutations.py
```

`/tmp/wave2-t21-mutations.log` records all nineteen compiled mutations failing their named assertions. Each mutation restored its module byte for byte before the next case.

| Mutation | Named assertion that failed |
|---|---|
| `bare-contrast-cue` | T21 bare contrast cue must classify accessibility |
| `standalone-deterministic-cue` | T21 standalone deterministic cue must classify a constraint |
| `classifier-goals` | T21 layout sentence must be a constraint |
| `resolver-goals` | T21 exact-six requirement oracle must exclude every product proof, including p.reset |
| `authorization-bypass` | T21 constraint headline authorization must reject requirement copy |
| `reference-bypass` | T21 non-alt reference must reject requirement copy independently |
| `action-bypass` | T21 action must reject requirement copy independently |
| `section-bypass` | T21 all-requirement alt section must fail only the section invariant |
| `legacy-invariant-applied` | T21 unchanged frozen clinic must compile via matched legacy packet, including its host-surface proof |
| `legacy-input-hash-bypass` | T21 missing input hash must not enable frozen compatibility |
| `legacy-version-qualification-bypass` | T21 new projection marker must not enable frozen compatibility |
| `legacy-contract-hash-bypass` | T21 changed contract bytes must use strict evidence, never the legacy resolver |
| `unknown-version-bypass` | T21 unknown projection version must fail closed even with otherwise valid evidence |
| `writer-version-omitted` | T21 canonical author writer must stamp the current host projection version |
| `compiler-default-legacy` | T21 requirement headline must consume a rejected attempt, never proceed |
| `compiler-kind-omitted` | T21 evidence without a host fact kind must fail closed |
| `author-kind-omitted` | T21 missing resolver kind must be refused before the author query |
| `head-only-budget` | T21 bounded projection must retain original sentence indexes at both ends |
| `author-prompt-byte` | runtime Batch 2B bytes must match the captured hash |

The runner's final restoration hashes were:

| Compiled module | SHA-256 |
|---|---|
| `creative-brief-facts.js` | `9e61746005e258ba62ccb7e0cb2bbc6788a0390bcf77544c79ee81a7427197bb` |
| `creative-pilot.js` | `ce813f3c3d723386840ead850154d93dac9c52d7b15d228541b6c18bfcce5550` |
| `creative-contract.js` | `6468ca91cdbf2667a4741a0b3f8e4b7da63f745acd1bbe962f556ffb71f1ec1b` |
| `creative-contract-author.js` | `1876741f7e7756e2189c805ff919044c5d43d08f08ae224ce24f30199c308523` |

The runtime prompt checks pin both the complete author captures and recovery of the immutable prior bytes after removing exactly the two planned additions. Initial author output is 8008 bytes with SHA-256 `ac1f6206c6503e1c1b09ab2df25a6a3754e998e39fd07eed75940f3508879a54`; repair output is 8360 bytes with SHA-256 `db3188ef4d4fadb7f2ec55eb30da76b4c7e3c8b7eafd43fbf51c4ca55cc7ae81`.

Review added separate bare-contrast and standalone-deterministic classification tests and mutation controls, increasing the earlier 152-test, seventeen-mutation evidence to the final counts above. Simplify reused resolved evidence instead of resolving it twice, and the private legacy projection reuses the existing reference and plan-answer logic. Final security, logic and runtime-edge reviews reported no remaining findings. T21 did not require a provider run, G3, an API restart or a historical-run write.

## T22: app page kind and routing

Commit: `e58bcb571424426b869295131a68a7aa9fd71daf` (`fix: give app tickets a form-focused design contract`).

The compiler adds `app` to the existing page-kind vocabulary. Each app route requires a form and permits at most one feature or editorial section combined. These checks run per route; a form on another route cannot satisfy the requirement. App routes permit a centered hero without an intentional exception. Landing routes retain their existing rules.

Author guidance offers `app` for pages the visitor operates, such as forms, tools and workflows. The test verifies that the author receives this choice; it does not claim a model selected it. App canvass prompts compare the same header and form task across directions, with explicit form guidance in full and degraded modes. Dispatch obtains `pageKind` from the freshly checked creative contract after the earlier motion read. Existing landing and marketing prompts retain their seven design captures. Four app captures, two author captures and the motion-guidance capture pin the new output, with exact-delta checks against prior author and motion bytes.

Root ran the preimplementation baseline from the repository root:

```sh
npm run build --silent --prefix dashboard/server && node --test --test-name-pattern=T22 dashboard/server/dist/creative-contract.test.js dashboard/server/dist/creative-contract-author.test.js dashboard/server/dist/design-prompt.test.js
```

The meaningful preimplementation baseline, `/tmp/wave2-t22-red-final.log`, reports **12 tests, 4 passed, 8 failed**. An earlier landing fixture had four features with an invalid mobile `preserve` strategy. The test was corrected to explicit `stack` before this baseline. Another fixture initially rewrote only the contract and failed the frozen author-hash check; the corrected test canonically persists both temporary files. The canonical-JSON fixture assertion was also corrected.

The final and restored suite command was:

```sh
npm run build --silent --prefix dashboard/server && node --test dashboard/server/dist/creative-contract.test.js dashboard/server/dist/creative-contract-author.test.js dashboard/server/dist/creative-requirements.test.js dashboard/server/dist/design-prompt.test.js dashboard/server/dist/t22-app-prompt.test.js dashboard/server/dist/wave2-prompt-goldens.test.js dashboard/server/dist/wave2b-prompt-goldens.test.js
```

Root's build exited 0. The seven-file suite in `/tmp/wave2-t22-root-final.log` reports **196 tests, 196 passed, 0 failed, 0 skipped**. After final assertion labels, build and mutations, `/tmp/wave2-t22-root-restored.log` reports the same counts. The full and degraded dispatch cases in `/tmp/wave2-t22-root-dispatch.log` report **2 tests, 2 passed, 0 failed**. The full orchestrator run, `node --test dashboard/server/dist/orchestrator.test.js`, exited 0. `/tmp/wave2-t22-root-orchestrator.log` reports **161 tests, 161 passed, 0 failed, 0 skipped**, in 170729.719209 ms.

Root ran the mutation controls serially:

```sh
python3 .tmp/wave2-fixes/t22-compiler-mutations.py
python3 /tmp/t22-root-prompt-mutations.py --run-root
```

The compiler log `/tmp/wave2-t22-compiler-mutations.log` records eleven mutations failing their named assertions:

| Mutation | Named assertion that failed |
|---|---|
| `app-vocabulary-removed` | T22 app must preserve every existing page kind |
| `app-limit-bypassed` | T22 combined app feature/editorial limit must reject excess sections |
| `editorial-not-counted` | T22 combined app feature/editorial limit must reject excess sections |
| `landing-app-rules` | T22 app section and form rules must not restrict landing routes |
| `missing-form-bypassed` | T22 app without a form must be rejected |
| `global-feature-count` | T22 two app routes may each contain one feature and one form |
| `global-form-presence` | T22 a form on one app route must not satisfy another route |
| `centered-app-exemption-removed` | T22 app form route must compile without a centered-hero exception |
| `operate-rule-removed` | T22 author must receive the operate-page rule |
| `centered-guidance-drift` | runtime bytes must match the captured hash |
| `author-prompt-byte` | runtime Batch 2B bytes must match the captured hash |

The prompt log `/tmp/wave2-t22-prompt-mutations.log` and its four `/tmp/t22-mutation-*.log` outputs record:

| Mutation | Named assertion | Failed tests |
|---|---|---:|
| `app-branch-disabled` | `APP_FORM_SCOPE_SENTENCE_REQUIRED` | 4 |
| `stale-page-kind-dispatch` | `APP_FORM_BRIEF_FROM_FRESH_CONTRACT_REQUIRED` | 2 |
| `app-branch-leaks-to-landing` | `runtime Batch 2B bytes must match the captured hash` | 1 |
| `landing-one-byte-regression` | `runtime Batch 2B bytes must match the captured hash` | 1 |

All fifteen mutation processes exited 1 through the expected assertions. Their runners restored exact bytes and checked SHA-256 after every case:

| Compiled module | Restored SHA-256 |
|---|---|
| `creative-contract.js` | `ca89d5a79faff1797b17c9d036a78dea68e7f1a7ff4abeea2b0b5d66d7f3141a` |
| `creative-contract-author.js` | `931943ff6079a3d12e5e70338ebe1aeb999706145b712fa7474d3f98b0593692` |
| `design-prompt.js` | `3252dd93d1a3f8e2af8e62002321e80bcc41634ba1c89f8ae7c923536c7899c8` |
| `orchestrator.js` | `65638694321b4f3c8cfa989d4ecbc733a66eb7ee0d19ea4ce6e7249a21b5aa82` |

Simplify, security, logic and runtime-edge reviews reported no remaining findings. A transient agent usage error resolved on retry; no usage reset was spent.

T23 preparation found a plan discrepancy: `creativeReviewPanel` currently exposes compile and critic findings but has no render-warning status field. T23 AC4 therefore needs a small projection and display addition within the authorized scope, alongside D14's isolated wizard dependency.

## T23: warning display prerequisite completed; probe blocked on D15

Commit: `41e97f7472a9dfcc87b871f8e55cbb155a689bb4` (`fix: show fresh render warnings in creative review`). Its ten files cover warning persistence, recovery clearing, API type mirrors and projection, the review disclosure, and their tests. This does not complete T23 or add the decorative-control classifier to the renderer.

Legacy status records default to an empty warning list; malformed warning records fail closed. Capture replaces warnings, builder mutation and contract change clear them, recovery starts without inherited warnings, and the API suppresses stale warnings. The client validates warning records and shows fresh warnings in a keyboard-operable “Render warnings” disclosure. Each observation includes its evidence hash. The four review authorities remain separate.

### Negative controls and restored checks

Root ran the red and green checks from the repository root:

```sh
npm run build --silent --prefix dashboard/server && node --test --test-name-pattern='render warning|seeds closed publication state|creative decision is closed' dashboard/server/dist/creative-pilot.test.js dashboard/server/dist/creative-recovery.test.js dashboard/server/dist/api.test.js
```

`/tmp/wave2-t23-status-red2.log` records **4 failed, 0 passed** before the warning implementation. Two failures reached named assertions: `legacy status defaults to no warnings` and `only warnings reach status`. The API test instead failed its enabled-status equality assertion (`undefined` versus `true`), and recovery refused with `creative_recovery_not_applicable`: the old closed reader rejected the new status field. Those two failures are compatibility evidence, not successful execution of the later stale-warning and recovery-clearing assertions. `/tmp/wave2-t23-status-green.log` then records **4 passed, 0 failed**.

Root ran `node /tmp/t23-warning-mutations.mjs`. Its log, `/tmp/wave2-t23-status-mutations.log`, records four single-test failures through the intended assertions:

| Mutation | Named assertion |
|---|---|
| `drop-render-warnings` | only warnings reach status |
| `retain-mutation-warnings` | builder mutation clears warnings |
| `inherit-recovery-warnings` | recovery never inherits source render warnings |
| `expose-stale-warnings` | stale render warnings are not exposed |

The runner restored compiled bytes in `finally` and checked SHA-256 after every case. Restored hashes were `fa4c18489b82b7836db45e365cfa8c77995a64fed1234f282ca7f2f92fb68cfe` for `creative-pilot.js`, `89396d94a447c7b3bc0f1fec4aa7e8591225e47f9a5d2aea382bfb9ce21e2ac5` for `creative-recovery.js`, and `027392a91ae2c0978297b077f7310b9f02a80ceccf39822b1d8cea237b9fb216` for `http.js`. The restored command was `node --test dashboard/server/dist/creative-pilot.test.js dashboard/server/dist/creative-recovery.test.js dashboard/server/dist/api.test.js`. `/tmp/wave2-t23-status-restored.log` records **88 passed, 0 failed, 0 skipped**.

From `dashboard`, the initial UI command was:

```sh
npx playwright test tests/creative-review.browser.spec.ts --project=browser --grep 'T23 shows a fresh render warning|T23 fails malformed render warnings closed: blocking severity'
```

The full green and restored command was `npx playwright test tests/creative-review.browser.spec.ts --project=browser`.

The initial UI checks in `/tmp/wave2-t23-ui-red.log` record **2 failed**: the disclosure was absent and malformed blocking warnings did not produce the unavailable result. `/tmp/wave2-t23-ui-green.log` records **29 passed**. Root ran:

```sh
python3 /tmp/t23-root-ui-mutations.py --run-root
```

`/tmp/wave2-t23-ui-mutations.log` records `hide-warning-disclosure` failing `T23_FRESH_RENDER_WARNING_DISCLOSURE_REQUIRED` and `admit-blocking-warning` failing `T23_MALFORMED_RENDER_WARNING_MUST_FAIL_CLOSED`. An initial anchored selector selected zero tests and is excluded from the evidence. The corrected runner escapes the unanchored test title and requires exactly one test in its selection preflight. Each mutation then failed exactly one test, and the source was restored byte for byte with SHA-256 `5eed9f8462d2ee7ba52639e8fbb6379b5f329b02fbce03581882818858407e46`. `/tmp/wave2-t23-ui-restored.log` records **29 passed** after restoration. At the checkpoint, root ran `npm run typecheck --silent` and `npx eslint src/components/run/creative-review.tsx src/lib/api-types.ts tests/creative-review.browser.spec.ts` from `dashboard`. Both exited 0 without diagnostics; logs are `/tmp/wave2-t23-checkpoint-typecheck.log` and `/tmp/wave2-t23-checkpoint-eslint.log`.

Root also ran:

```sh
node --test dashboard/server/dist/orchestrator.test.js dashboard/server/dist/contract-parity.test.js
```

`/tmp/wave2-t23-transport-orchestrator.log` records **181 passed, 0 failed, 0 skipped**, in 165929.373292 ms. Simplify, security, logic and runtime-edge reviews reported no findings for the warning slice only.

The temporary fixture verified the actual API response and Next proxy before reporting READY. Root inspected that READY log, then used CUA to open `http://127.0.0.1:44322/runs/harness-canvas-run`, selected Result, and expanded “Render warnings (1)”. The screenshot showed a compact panel, the full wrapping hash and all four unchanged authority rows. No approval button was clicked. The temporary API used port 44178; preview evidence is `/tmp/wave2-t23-cua-preview-r2.log`. Root closed the tab and stopped the owned preview, which exited 0. Root checked that neither owned port, 44178 nor 44322, was still listening. An earlier attempt on occupied port 4323 reached a different app and is excluded from visual evidence; the unowned server was left untouched. The two Next-generated `tsconfig.json` include additions were removed, and root compared that file with HEAD exactly.

### D15 requires an owner answer

The literal Shape A rule conflicts with T23 AC2a's requirement that every functional confirmation element remain green. Real Chromium measured `.done-mark` as a `P` containing `✓`, with `aria-hidden="true"`, height 48, background `rgb(29, 78, 216)`, radius `50%`, and no role/ARIA ancestor. The literal classifier returns `[{ selector: ".done-mark", kind: "control", text: "✓" }]` where the test requires `[]`.

Root ran the built `dashboard/server/dist/decorative-controls.browser.test.js`. `/tmp/wave2-t23-root-literal-d15-red.log` records **1 failed, 0 cancelled**, through `T23 every confirmation element, including the completion glyph, must remain green`. This remains intentionally red and uncommitted. The earlier browser attempt timed out because the radio input has `pointer-events: none`; the corrected test clicks its visible `.slot` label, asserts the radio is checked, and uses no forced click.

D15 has not been taken. The pending proposal is a narrow exclusion for an aria-hidden, symbol-only decorative glyph. It does not approve excluding every aria-hidden element, which could hide a text control such as Continue. The brief is unchanged. Probe/classifier integration remains paused until the owner answers.

The isolated fixture includes D14's wizard dependency. Root compared all four copies with the historical files byte for byte:

| Fixture path | Bytes | SHA-256 |
|---|---:|---|
| `index.html` | 12711 | `076c04eb6d7dfaa139054d823085aa3872bf2bf5510d43b0414b702e7759d635` |
| `app/styles.css` | 19335 | `41d75c3dc84661396bc01419446bdfe23328350fc9cbc70d92e053ac93b55084` |
| `app/main.mjs` | 8720 | `00139ad62df6d735aea7190a9899c613ac59b2dbc271134b3ca98622dd2694df` |
| `app/wizard.mjs` | 5791 | `1e8f790249e639765886998110bd51b86394db6e28ac1645811d21b84ca4ce17` |

The probe, literal test and fixture remain untracked, unfinished work. A green full `npm test` run is not claimed while the D15 test is intentionally red. The renderer, render manifest and `stateIsRepresented` remain unchanged by this probe work.

## Remaining work and protection boundary

After D15, T23 still needs the exact-three-section classifier oracle; functional wizard green assertions; role, label and focusability mutation controls; actual route snapshot/parser wiring; missing-measurement handling; warning-only `DECORATIVE_CONTROL` output with screenshot evidence; manifest validation; and critic measured facts with numeric pointer admission, profile deduplication and the deterministic 48-warning-fact cap. Complete the associated named negative controls and restored checks before claiming T23 complete. The detailed continuation checklist is `/tmp/wave2-t23-handoff.txt`.

T24 through T26 are unstarted. T25 must include carried item 4, borrow assertion ordering in `design-lock.browser.spec.ts`, and item 5, required `chosenDirectionReason` in both API type mirrors. Retain T26's dial-format work. The video-policy decision, Unicode filesystem folding, unmapped accessible-name text and hue comment remain deferred. `CRITIC-001` remains open. G3 remains owner-only and has not run.

The protected baseline is `/tmp/wave2-batch2b-d13-protected-baseline.json`, with 442 files. Original backlog and capability bytes were saved under `/tmp/wave2-batch2b-d13-{name}.before`. The final checkpoint comparison covered all 442 paths. Only `docs/BACKLOG.md` and `docs/CAPABILITIES.md` changed; their original working prefixes remain byte-identical, with append-only additions of 1164 and 1311 bytes respectively. All other 440 paths are byte-identical, including the historical clinic, database, frozen acceptance and scorer files. No provider run, G3 run, protected-directory or database write, or API 4176 restart was performed as part of this checkpoint.
