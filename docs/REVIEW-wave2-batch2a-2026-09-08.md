---
document_status: review
written: 2026-09-08
reviews: docs/REPORT-wave2-batch2a-2026-09-08.md
at_commit: ecb4787
---

# Review of wave 2 batch 2A (T15 to T20), 2026-09-08

Reviewed: the nine commits `759d1be..ecb4787` (`git diff --stat`: 54 files, 1983 insertions,
118 deletions) against [the plan](PLAN-wave2-taste-and-copy-2026-09-05.md), [the brief](CODEX-BRIEF-wave2.md)
and [Codex's report](REPORT-wave2-batch2a-2026-09-08.md). Method: both packages rebuilt from HEAD
(`npm run build --silent`, exit 0 in `bakeoff` and `dashboard/server`; 0 source files newer than
`dashboard/server/dist/index.js` and 0 newer than `bakeoff/dist/tier0.js` at the time of writing),
suites re-run over `dist/` with `DASHBOARD_LIVE_SMOKE=0`, every negative control repeated by
mutating compiled `dist/` files or client source, each mutation copied aside first, restored with
`cp`, checked with `cmp`, and the tree rebuilt at the end with `cmp` identical. Nothing under
`dashboard/acceptance/`, `dashboard/data/runs.db` (mtime Sep 4 22:07:27, sha256
`3d4c793c43e6f62c87548e7e1147ed977d8426ea9f3cd74a314f9e2afde18771`, `runs.db-wal` 0 bytes) or the
clinic run directory (mtime Sep 4 17:54:10) was modified; pids 918 (4176), 1887 (4319) and 71532
(4321) were left running; no pipeline run was started; no metered call was made; `git status
--short` at the end matches the starting snapshot. Line numbers are as read at `ecb4787`.

## 1. Verdict

**Go with fixes.** The six tasks are in the tree as the report describes them, the four plan
deviations are sound (section 5), and every negative control the reviewers repeated for T15,
T16, T18, T19 and T20 went red for the intended reason and green again after a byte-for-byte
restore (section 2). Two things keep this from a plain go. First, T17's clean sentence is gated
on `judge.findings.length === 0` rather than on the judge's verdict
(`dashboard/server/src/verdict.ts:659`), so a `concerns` verdict whose finding rows the parser
dropped (`judge.ts:231` skips any row whose `detail` is not a string; `judge.ts:240` keeps the
verdict) still prints "nothing was noted against it", the sentence T17 exists to stop; this was
reproduced against the built `dist/run-report.js`. Second, three checks the report presents as
negative controls survive the mutation they are supposed to catch: the nested-redaction
orchestration test passes with `redactForPersistence` removed from `#recordJudgeReport`
(`orchestrator.ts:7577`), the seven T17 orchestration tests pass with the in-memory
`#judgeReports.delete` removed (`orchestrator.ts:7568`), and 53 design-lock, cron and orchestrator
tests stay green when the "before the timeout" reason the orchestrator writes
(`orchestrator.ts:1887`, `:1898`) is reworded, because only the reader end of that classifier is
bound. Under this repository's first standing rule each of those is a finding. Separately, the
API preview route on 4176 still serves `TICKET.md`, `design-refs/manifest.json` and
`visible-acceptance/booking-wizard.spec.mjs` (200 today; the same three paths are 404 on the
static server at 4321), which Codex flagged itself and which is T18b in section 7. Nothing needs
reverting. The fixes are one conditional in `verdict.ts`, one shared constant and five tests,
and they should land before batch 2B starts: T25 and T26 build on T16's wire and T17's verdict
plumbing, and a control that survives its mutation is worth nothing to the next reviewer.

## 2. What was independently confirmed

Every row names the command or the file and line that was read, and the decisive output. Server
commands ran from `dashboard/server`, bakeoff commands from `bakeoff`, Playwright commands from
`dashboard`, all with `DASHBOARD_LIVE_SMOKE=0`. "Restored" means `cp` back from the pre-mutation
copy and `cmp` exit 0.

### Batch level

| Report claim | How it was checked | Result |
|---|---|---|
| Nine commits on `759d1be`; subjects within the 60/3/5 rule | `git log --oneline 759d1be..HEAD`; subjects measured inline by the reviewer on 2026-09-08 | 9 commits; 9 subjects of 60 characters or fewer; 0 dash punctuation; 0 attribution trailers |
| The diff | `git diff 759d1be..HEAD --stat` | 54 files, 1983 insertions, 118 deletions |
| `npm run build --silent` exits 0 in both packages | run at HEAD by each reviewer; `find src -name '*.ts' -newer dist/index.js` | exit 0 in both; 0 source files newer than `dist/index.js`; 0 newer than `bakeoff/dist/tier0.js` |
| Prompt goldens captured first at `d4f4dbe`; 21 golden tests at capture | `node --test dist/wave2-prompt-goldens.test.js` at HEAD | 22 tests, 22 pass; the extra one is `T20 mid high and empty policy preserve frozen legacy motion bytes` (`wave2-prompt-goldens.test.ts:52`) |
| Golden failure text is `runtime bytes must match the captured hash` | XOR of byte 7692 of `dist/design-prompt.js`, the first byte of the `DESIGN LANE` heading (`design-prompt.ts:178`); a production-side mutation, stronger than the report's test-side one | exit 1; 22 tests, 19 pass, 3 fail (`design-expansion-available`, `design-expansion-no-video`, `design-canvass-available`), each `runtime bytes must match the captured hash` (`wave2-prompt-goldens.test.ts:17`); restored |
| The fixture hash guard fires first | XOR of byte 376 of `dist/test-fixtures/wave2-prompt-goldens.js` | exit 1; 2 fail, `stored bytes must match the immutable capture hash` (test line 16); restored |
| Protected state untouched | `ls -laT dashboard/data/runs.db`; `shasum -a 256 dashboard/data/runs.db`; `git status --short dashboard/acceptance dashboard/runs/run-2026-09-04T15-54-06-323Z-131fd85f`; `lsof -nP -iTCP:4176 -iTCP:4319 -iTCP:4321 -sTCP:LISTEN` | mtime Sep 4 22:07:27; sha256 `3d4c793c…e18771`; status empty; pids 918, 1887, 71532 listening; 0 differences in the working tree after every pass |
| Full server suite: 2,663 tests, 3 baseline failures | not re-run | section 8 |

### T15, canvas titles by role (`3f331f7`)

| Report claim | How it was checked | Result |
|---|---|---|
| `titleOf` supplies all four title sites; known roles become the title; the agent name is secondary | `dashboard/src/components/canvas/roles.ts:366-370` read; `titleOf` call sites in `agent-node.tsx`, `sheet.tsx`, `inspector.tsx`, `roster.tsx`; `npm run typecheck --silent` | 4 call sites; typecheck exit 0 |
| Card `<h3>` using `node.agent` goes red | source mutation of the `<h3>` in `agent-node.tsx` to `node.agent`; `npx playwright test --project=browser canvas-titles.browser.spec.ts design-lock.browser.spec.ts` | exit 1; 3 canvas-titles failures, `Received "frontend-developer"` and `Received "taste-frontend-expert"`; 23 passed; restored |
| Nameless fallback is `session`, not `unmapped` | `titleOf` mutated to `node.agent ?? ROLE_LABEL[role]`; `npx playwright test -c tests/no-server.config.ts canvas-roles.unit.spec.ts` | 2 failed, `Expected "session" Received "unmapped"`; restored |
| `titleOf` returning the agent name goes red | `titleOf` mutated to return `node.agent`; same suite | 1 failed, `Expected "design" Received "taste-frontend-expert"`; 21 passed; restored |
| The accessible name leads with the role and keeps the agent name | `agent-node.tsx:632-640` read; `canvas-titles.browser.spec.ts` asserts a name beginning `frontend, frontend-developer, ` | 27 browser tests pass (canvas-titles 3, design-lock 24) on ports 4322 and 4177, not 4319 and 4176 |
| `gate` still maps to `review`; `debugger` on `gate` is `debug`; `code-reviewer` on `review` stays `review` | `roles.ts` `LANE_ROLE` and craft tokens read; `canvas-roles.unit.spec.ts` with its pre-existing assertions untouched | 22 tests, 22 pass |
| Only the debug colour was added; server, events and `api-types.ts` untouched | `globals.css:206` `--role-debug: oklch(0.76 0.09 300)`; `git show 3f331f7 --stat` | chroma 0.09 inside the 0.07 to 0.11 constraint from the `roles.ts` header; lightness 0.76 inside the 0.745 to 0.8 band; hue 300 is 28 degrees from spec (272) and 30 from design (330); 0 server files in the commit |

### T16, judged choice versus timeout fallback (`e496b88`, `a55a289`)

| Report claim | How it was checked | Result |
|---|---|---|
| `chosenDirectionReason` is an optional field on both API mirrors and the projection | `dashboard/server/src/api-types.ts:534`, `dashboard/src/lib/api-types.ts:421`, `dashboard/server/src/http.ts:743` read | the only `?:` in `ApiDesignLock`; the server always emits the key |
| The wire field is tested | delete the projection line in `dist/http.js`; `node --test --test-name-pattern='THE FOUR STAGES ON THE WIRE' dist/api.test.js` | 1 failed, `actual: undefined, expected: 'the quieter grid suits the brief'`; restored; 1 pass |
| Parity pins 15 fields including the new one | `contract-parity.test.ts:258-260`, `:277` read; `node --test dist/verdict.test.js dist/run-report.test.js dist/cron/cron-report.test.js dist/contract-parity.test.js` | 97 tests, 97 pass |
| No record shape or writer changed | `git show --stat e496b88`; `design-lock.ts:457`, `:565`, `:604` | 0 changes to `design-lock.ts` or `orchestrator.ts`; `readRecordString` yields null for an absent key |
| A judged choice quotes the recorded reason; explicit null renders "No reason was recorded." without borrowing the mockup reason | `design-lock.tsx:531-534` read; browser test `missing direction reason does not borrow a mockup-lock reason` | passes within the 24 design-lock browser tests |
| The cron line drops "automatically" for `ui-designer` and keeps it for `fallback` | `cron-report.ts:112-128` read; `ui-designer` branch in `dist/cron/cron-report.js` reverted to "chosen automatically"; `node --test dist/cron/cron-report.test.js` | 1 failed (`a judged pick is not a fallback`), 17 passed; restored |
| A fallback names the timeout only when its reason contains "before the timeout" | `design-lock.tsx:182` and `:465` widened to any non-null reason; browser suite | `fallback no-file reason never claims timeout or judgement` failed, `Expected substring "The chooser wrote no usable choice"`; restored. Reader end only: section 3 item 5 |
| Unit and browser suites green | `npx playwright test -c tests/no-server.config.ts canvas-roles.unit.spec.ts design-lock.unit.spec.ts`; the browser run above | 37 unit pass; 27 browser pass; typecheck exit 0 |

### T17, judge findings in the verdict (`13ca418`)

| Report claim | How it was checked | Result |
|---|---|---|
| The report flows from the judge into `results/judge.json`, the per-run map and the verdict | `orchestrator.ts:7576-7587` (`#recordJudgeReport`), `:8905` (`#writeVerdict` runs before the map delete at `:8921`), `:9186-9190`, `:9955` (`verdictSourceFor`); `run-report.ts:230`, `:360`; `verdict.ts:664-676` read | one write path; `results/judge.json` is touched only at `:7570` (remove) and `:7580` (write) |
| The clean sentence needs a judge that ran, was available and had zero findings | `verdict.ts:658-661` read; `summaryLine` in `dist/verdict.js` made unconditional; `node --test --test-name-pattern='T17' dist/verdict.test.js dist/run-report.test.js` (repeated independently by two reviewers) | exit 1; 2 tests, 0 pass, 2 fail (`verdict.test.ts:748`, `run-report.test.ts:1040`), operator `doesNotMatch`; the rendered page held the sentence directly above `[unasked_scope/medium] general:` and `[swallowed_failure/low] REQ-003:`; restored; 59 pass. Not the honest gate: section 3 item 4 |
| Attempt entry clears the on-disk report | `rmSync` removed from `#resetJudgeReport` (`orchestrator.ts:7570`) in `dist/orchestrator.js`; `node --test --test-name-pattern='T17\|terminal creative recovery keeps' dist/orchestrator.test.js` | exit 1; `T17 a cancelled attempt clears a stale judge file before reaching the judge phase` failed (`actual: true, expected: false`); 6 passed; restored |
| A disk-write failure keeps the redacted findings and cannot fail a green run | `orchestrator.ts:7580-7586` read; `T17 judge report disk failure retains findings and cannot fail a green run` (`orchestrator.test.ts:8620`) | passes; status `passed`, `heldOutPass` true |
| `computeOutcome` and the criteria section untouched | `git show 13ca418 -- dashboard/server/src/verdict.ts` piped to `grep -c computeOutcome` | 0; `computeOutcome` at `verdict.ts:288` unchanged |
| `redactForPersistence` sits on the path | `orchestrator.ts:7577` read; direct probe of `redactForPersistence({summary, findings:[{detail, evidence}]})` with `ghp_` plus 25 characters | `[REDACTED:GITHUB_TOKEN_SHAPE]` in all three strings. The test meant to guard the wire does not: section 3 item 1 |
| 83 report checks and 7 orchestration checks | `node --test dist/verdict.test.js dist/run-report.test.js dist/judge-ceiling.test.js dist/wave2-prompt-goldens.test.js`; `node --test --test-name-pattern='T17\|T20\|terminal creative recovery keeps' dist/orchestrator.test.js`; the report's own T17 pattern | 84 tests, 84 pass (83 plus the T20 golden); 9 tests, 9 pass (6 T17, 2 T20, 1 recovery); 7 tests, 7 pass |

### T18, internal paths refused by the static resolver (`3ccc6f1`)

| Report claim | How it was checked | Result |
|---|---|---|
| Dot segments refused after decoding and before normalisation; named roots refused; the same rule again after realpath | `bakeoff/src/tier0.ts:1299` (decode), `:1303` (NUL), `:1305` (first deny), `:1307-1308` (normalise), `:1323` (realpath), `:1334` (containment), `:1336` (second deny), `:1338` (`isFile`) read | order as claimed; the `..` string check at `:1308` is now unreachable because `:1305` refuses every dot segment first |
| The deny rule is live | `dist/tier0.js` line 1072 (`tier0.ts:1281`): `segments.some((segment) => segment.startsWith("."))` replaced by `false`; `node --test dist/tier0.test.js` | exit 1; 63 tests, 50 pass, 13 fail; `GET /.git/config` actual 200 expected 404 (`tier0.test.ts:169`); the 13 are exactly the dot-path cases since the named-root clause at `:1282` was left intact; restored; 63 pass |
| Named roots are denied case-insensitively | both `toLowerCase()` calls removed in `dist/tier0.js`; `node --test --test-name-pattern='resolveStaticFile exposure\|acceptance source\|held-out acceptance' dist/tier0.test.js` | 29 pass before; 7 fail under the mutation on this Mac (the 5 mixed-case URLs, the symlink test, the HTTP test); green after restore. Vacuous on Linux: section 4 L4 |
| `startStaticServer(root, 0)` reports the bound port | `tier0.ts:1411-1412` reverted in dist to the requested port; an independent script importing `bakeoff/dist/tier0.js` and comparing with `lsof` | 1 fail, `the assigned ephemeral port is reported` (`tier0.test.ts:156`); script: returned port 62077, present in the process's LISTEN list, `GET /index.html` 200 |
| The list matches what the harness writes | `runner.ts:113` (`TICKET.md`), `:119` (`visible-acceptance`), `design-manifest.ts:40` (`design-refs`), `spec-freeze.ts:865` (`tests`); `ls` of the clinic workspace root | 4 names match; the clinic root holds `.bakeoff .claude .design-tmp .git .gitignore .tmp app assets design-refs index.html README.md tests TICKET.md visible-acceptance`, every non-product name covered by the dot rule or the list |
| A public symlink cannot expose a private target | fixture symlinks `tier0.test.ts:81-86`; assertions `:141-150`, `:166-171`; positive control `product-alias.mjs` served | within the 63 pass run |
| HEAD behaves as GET; the denied body is `not found` | `tier0.ts:1360-1369`, `:1393-1396`; tests `:158-172` send raw `node:http` requests | within the 63 pass run |
| The live 4321 listener answers 404 for internal paths and 200 for product paths | `curl -s -o /dev/null -w '%{http_code}'` against `127.0.0.1:4321` on 2026-09-08 | `/.git/config` 404, `/TICKET.md` 404, `/ticket.md` 404, `/design-refs/manifest.json` 404, `/visible-acceptance/booking-wizard.spec.mjs` 404 (a file that exists), `/app/main.mjs` 200, `/README.md` 200 |
| `execution-contract.ts:79` still resolves `/` | `node --test dist/execution-contract.test.js` | 10 tests, 10 pass, 0 fail |
| The bakeoff suite | `DASHBOARD_LIVE_SMOKE=0 npm test` | 286 tests, 286 pass, before and after the mutations; the rebuilt `dist/tier0.js` sha256 `993400f6…1724` matches the pre-mutation copy |
| Consumers reach the rule through the symlink | `ls -la dashboard/server/node_modules/bakeoff` | symlink to `../../../bakeoff`; `preview.ts:23`, `:87` call `startStaticServer`; `execution-contract.ts:79` calls `resolveStaticFile` |

### T19, video legs gated by contract and direction (`6b69e62`)

| Report claim | How it was checked | Result |
|---|---|---|
| `videoLegPolicy` is pure; allowed only when the page kind is not `app`, the contract dial is at least 8 and the direction dial is absent or at least 8 | `design/video-policy.ts:25-40` read; `node --test dist/design/video-policy.test.js` | 6 tests, 6 pass; the grid test covers every page kind by contract dial 0 to 10 by direction dial |
| A missing contract keeps legacy behaviour with reason `no contract; policy not applied` | `video-policy.ts:27` | as claimed (decision D3 default) |
| An always-allow stub fails the low case; an always-deny stub fails the high case | `return { allowed: true, ... }` then `return { allowed: false, ... }` inserted as the first statement of `videoLegPolicy` in `dist/design/video-policy.js`; `node --test --test-name-pattern=T19 dist/orchestrator.test.js` | allow: exit 1, 0 of 2, low case `actual: 2, expected: 0` legs (`orchestrator.test.ts:8678`); deny: exit 1, 0 of 2, high case `actual: 0, expected: 2`, expansion test `did not match /direction dial 2/`; `video-policy.test.js` 0 of 6 and 2 of 6 respectively; restored |
| The mutated module is the one the orchestrator uses | `grep -rn 'videoLegPolicy(' dist` excluding tests | 1 runtime caller, `dist/orchestrator.js:4037` (`orchestrator.ts:4984`); the other 4 imports are type-only |
| The parser reads both measured forms, rejects a malformed first declaration, counts duplicates | `design-manifest.ts:700-717` read; `node --test --test-name-pattern='motion intensity' dist/design-manifest.test.js`; dist mutations `parsed <= 100` and removal of the `occurrences !== 1` guard | 4 pass; mutation A 1 fail, `actual: { motionIntensity: 11, occurrences: 2 }`; mutation B 2 fail; restored |
| Allowed and omitted-policy prompt bytes unchanged; the consumption prompt loses only the reference-site sentence | `node --test dist/wave2-prompt-goldens.test.js` | 22 pass, including the 3 design prompts and the video-consumption remainder |
| The orchestration checks exit in about 2.5 s | `node --test --test-name-pattern=T19 dist/orchestrator.test.js` | 2 pass in 2279 ms; 2251 ms after the rebuild |
| Unit suites | `node --test dist/design/video-policy.test.js dist/creative-motion-policy.test.js dist/design/video-legs.test.js dist/design/video-lane.test.js` | 37 tests, 37 pass |
| The clinic's own declarations parse | `direction.md:13` and the canvass note `:58` fed through the built parser | 3 and 2, 1 occurrence each |

### T20, contract motions at low intensity (`677512e`)

| Report claim | How it was checked | Result |
|---|---|---|
| At intensity 1 to 4 with a non-empty motion list, every exact `data-motion-id` marker satisfies the hook and the reason names the ids | `builders/antislop-rules.ts:1114-1123` read (`:1121` `all low-motion creative contract markers: ...`) | as claimed |
| Removing the low-marker shortcut goes red | compiled lines 941-950 of `dist/builders/antislop-rules.js` deleted; `node --test --test-name-pattern='T20' dist/builders/antislop-rules.test.js dist/builders/antislop-hook.test.js dist/wave2-prompt-goldens.test.js dist/visual-criteria.test.js dist/visual-gate-run.test.js dist/builders/claude-builder.test.js` | exit 1; 8 tests, 5 pass, 3 fail: `antislop-hook.test.ts:430` (`Stop dial 3 ids m.fade / true !== false`), `antislop-rules.test.ts:480`, `:495`; restored |
| The two orchestrator T20 tests cover wiring and freshness, not the decision | same mutation; `node --test --test-name-pattern='T20' dist/orchestrator.test.js` | 2 pass under the mutation; the decision is guarded by the unit tests alone |
| Mid, high and empty policy keep the frozen legacy bytes | `wave2-prompt-goldens.test.ts:52` within the 22-test golden run | pass |
| Targeted checks green | the 84-test report run and the 9-test orchestrator run above | 84 pass; 9 pass |
| 232 targeted checks and eleven mutations | 1 of the 11 repeated (above) | section 8 |

## 3. Report claims that did not hold

1. **T17, "The full `JudgeReport` passes through `redactForPersistence` before entering the
   per-run report map and `results/judge.json`", with "nested redaction" listed among the
   orchestration checks.** The call exists (`orchestrator.ts:7577`). The check does not observe
   it. With `const redacted = report;` substituted in `#recordJudgeReport` in
   `dist/orchestrator.js`, `T17 persisted report and verdict redact nested judge text`
   (`orchestrator.test.ts:8581`) still passes, 1 of 1, exit 0. It fails only when
   `judge.ts:342-343` (`findings: redactForPersistence(parsed.findings)`,
   `summary: redactForPersistence(parsed.summary)`, present at `759d1be` and tracked to
   `b05ebee`) is stripped as well: 0 of 1, `assert.ok(!raw.includes(secret))`. Restoring
   `judge.js` alone with the orchestrator still mutated returns it to green. The test proves the
   judge-produced path is redacted somewhere; it proves nothing about the orchestrator wire. The
   two reports that never pass through `judge.ts`, the skipped report whose summary is
   `auth.claudeDetail` (`orchestrator.ts:7598`, `:7610`) and the terminal recovery report
   (`:9262`), have only the orchestrator-level call between them and disk.

2. **T17, "Report authority is cleared at attempt entry, including recovery entry."** True for
   `#execute` (`orchestrator.ts:2406`) and terminal creative recovery (`:9261`). False for
   gate-only recovery: `gate-recovery.ts:1030` and `:1081` call `writeRunVerdict` with no
   `judgeReport` and never touch `results/judge.json`; the module declares no judge dependency
   (`gate-recovery.ts:2-6`, `:897`).

3. **T17, "stale-report replacement during terminal recovery" listed as covered.** The on-disk
   half is bound (section 2). The in-memory half is not: with `this.#judgeReports.delete(runId)`
   removed from `#resetJudgeReport` (`orchestrator.ts:7568`), all 7 tests under
   `--test-name-pattern='T17|terminal creative recovery keeps'` pass, exit 0. The one path where
   that delete is load-bearing, the requeue return in `#finish` (`orchestrator.ts:8864-8877`,
   which exits before the delete at `:8921`), has no test.

4. **T17, "prints the clean claim only for a passing outcome with a judge that ran, was
   available and returned no findings."** Literally true, and not the honest gate. `judge.ts:240`
   sets `verdict` to `concerns` whenever the model says so, even when `judge.ts:231` dropped every
   finding row. `renderRunVerdict` from `dist/run-report.js` with
   `{ran: true, verdict: "concerns", findings: [], summary: "the handler is a stub"}` under a
   green gate produced `# PASSED`, the sentence "nothing was noted against it", and a judge
   section reading "the handler is a stub". Section 4, M1.

5. **T16, the mutation table implies the timeout classifier is proven at both ends.** Only the
   reader end is. Rewording `orchestrator.ts:1887` and `:1898` in dist to "no owner choice
   arrived in time" left `dist/design-lock.test.js` plus `dist/cron/cron-report.test.js` at 42 of
   42 and the `timeout|timer|fallback|automatic|FOUR STAGES|design lock|direction|RULE` subset of
   the orchestrator, api and http tests at 11 of 11, exit 0. The browser spec cannot catch it
   either: `design-lock.browser.spec.ts:358` feeds its own copy of the literal into the fixture.

6. **T16, "An absent optional field supports older servers."** Absent does not degrade to "no
   reason", it borrows: `design-lock.tsx:532-534` and `cron-report.ts:113-115` substitute
   `lock.reason` when `chosenDirectionReason` is `undefined`. The only older server is the one on
   4176 now: `GET /api/runs/run-2026-09-04T15-54-06-323Z-131fd85f` from pid 918 returns a
   `designLock` with 14 keys and no `chosenDirectionReason`, and the clinic record's `reason`
   (`results/design-lock.json`) is the direction name, a dash, and then the direction reason
   (`reason.endsWith(chosenDirectionReason)` true, equality false). Section 4, L1.

7. **T18, the live-probe row `/visible-acceptance/x.spec.mjs` 404.** That path does not exist in
   the clinic workspace (its `visible-acceptance/` holds `app-boot.test.mjs`,
   `booking-validation.spec.mjs`, `booking-wizard.spec.mjs`), so the row is non-discriminating;
   the old resolver would also have answered 404. The discriminating live probe is
   `/visible-acceptance/booking-wizard.spec.mjs`, measured 404 on 4321 today; the unit fixture at
   `tier0.test.ts:60` is the proof the report should have cited.

8. **Plan, not report: T18's Touches list (plan line 270) names `preview.ts:23`, `:87` as
   consumers of `resolveStaticFile`.** Both lines call `startStaticServer`; the only dashboard
   caller of `resolveStaticFile` is `execution-contract.ts:79`. The rule reaches `preview.ts`
   through `startStaticServer` (`tier0.ts:1360-1369`), so the effect holds and the citation is
   what is wrong.

## 4. Findings from the code review

Ranked. No critical finding. Five medium, ten low.

### M1. `dashboard/server/src/verdict.ts:659`: the clean claim gates on the finding count, not the verdict

`judge?.ran === true && judge.verdict !== "unavailable" && judge.findings.length === 0` prints
"Everything the ticket asked for is there, and nothing was noted against it."

**Failure scenario.** The judge model returns
`{"verdict":"concerns","findings":[{"kind":"stub","detail":123}],"summary":"the handler is a stub"}`.
`judge.ts:231` skips the row (`detail` is not a string) and `judge.ts:240` keeps `concerns`.
`verdict.md` then opens `# PASSED` and the clean sentence while its own "Code-reading judge
(non-gating)" section two paragraphs down reads "the handler is a stub". Reproduced with
`renderRunVerdict` from `dist/run-report.js`.

**Fix.** Condition on `judge.verdict === "clean"` (`judge.ts:240` already guarantees `clean`
implies zero findings) and add the `{verdict: "concerns", findings: []}` fixture to
`verdict.test.ts` asserting `doesNotMatch(/nothing was noted against it/)`. T17b, criteria 1 and 2.

### M2. `dashboard/server/src/orchestrator.ts:7577`: the orchestrator-level redaction has no negative control

`orchestrator.test.ts:8581` plants a secret in a judge-produced report, which `judge.ts:342-343`
already redacts before the orchestrator sees it.

**Failure scenario.** Someone simplifies `#recordJudgeReport` to store the report as received.
Every test stays green. The skipped report at `orchestrator.ts:7598`, whose summary is
`auth.claudeDetail` (`:7610`), and the terminal recovery report at `:9262` never pass through
`judge.ts`; they are written to `results/judge.json` and rendered into `verdict.md` unredacted.
Measured: `const redacted = report;` in dist, test 1 of 1 green; with `judge.js` redaction
stripped as well, 0 of 1.

**Fix.** A test that drives the `:7598` path with a `FixtureJudgeAuth` whose `claudeDetail`
carries `ghp_` plus 25 characters and `claude !== "ok"`, asserting `results/judge.json` and
`verdict.md` contain `[REDACTED:` and not the token; red under `const redacted = report;`, green
at HEAD. T17b, criteria 3 and 4.

### M3. `dashboard/server/src/orchestrator.ts:7568`: the in-memory attempt-entry clear has no negative control

**Failure scenario.** A run passes with a clean judge. An owner message arrives at the terminal
boundary, `#finish` takes the requeued branch (`:8864-8877`) and returns before the delete at
`:8921`, leaving the clean report in `#judgeReports`. The requeued attempt's build fails and
`#finish("failed")` writes `verdict.md` before `#judgePhase` runs. Without the `:7568` delete the
verdict's judge section describes the previous tree for an artefact that no longer exists. HEAD
prevents it; a refactor that drops the line ships silently (measured: 7 of 7 green with the line
removed).

**Fix.** An orchestrator test that reaches a clean judge, drives
`finishUnlessOwnerMessagePending` into the requeue branch, fails the next attempt's build, and
asserts `verdict.md` matches `/code-reading judge did not run: no report was recorded/` and not
the prior summary. T17b, criteria 5 and 6.

### M4. `dashboard/server/src/orchestrator.ts:1887` and `:1898`: the "before the timeout" literal has two writers and two prose-substring readers with no shared source

Writers: `orchestrator.ts:1887`, `:1898` (composed through `design-lock.ts:257` and `:376`).
Readers: `design-lock.tsx:182`, `:465`. A third copy in `design-lock.browser.spec.ts:358`.

**Failure scenario.** Someone rewords `:1887`. 53 tests stay green (42 plus 11, section 3 item
5). From then on every real timeout fallback renders "The chooser wrote no usable choice, so the
first mockup in the list was taken.", the exact misattribution T16 was raised to remove.

**Fix.** One exported constant (`DIRECTION_TIMEOUT_REASON` in `server/src/design-lock.ts`,
importable by the client the way `src/lib/graph.ts` imports `../../server/src/graph`), used at
both writers and both readers, plus a test that drives the timer path and pins the persisted
`chosenDirectionReason`. Longer term a structured cause on the wire, once the record-shape freeze
lifts after T25. T16b.

### M5. `dashboard/server/src/code-files.ts:732`: the API preview route has no internal-path policy (T18b)

`resolvePreviewTarget` goes through `resolveWorkspacePath` (`:281`), whose only name rules are
`pathRefusal` (`:219`) and `denyReason` (`:193`: `.git`, `node_modules`, secret-shaped names).
`code-files.ts` is unchanged in `759d1be..HEAD`.

**Failure scenario.** Measured on 2026-09-08 against pid 918 on 4176 with `curl -s -o /dev/null
-w '%{http_code}'`: `/api/runs/run-2026-09-04T15-54-06-323Z-131fd85f/preview/TICKET.md` 200
(body begins "Build a polished, responsive web app for booking a fictional clinic
appointment."), `.../preview/design-refs/manifest.json` 200,
`.../preview/visible-acceptance/booking-wizard.spec.mjs` 200, `.../preview/.git/config` 403,
`.../preview/app/main.mjs` 200. The same three internal paths are 404 on 4321. Anything given a
route to the preview (ADVERSARY-ACCESS-001, `docs/BACKLOG.md`, P1 open) reads the ticket, the
design manifest, the visible acceptance subset and the frozen test sources through the browsable
site. Today the exposure is loopback and owner-only, and the code browser shows the same files
on purpose (`code-files.ts:143-147`).

**Fix.** Section 7, T18b.

### L1. `dashboard/src/components/run/design-lock.tsx:532` and `dashboard/server/src/cron/cron-report.ts:113`: an absent `chosenDirectionReason` borrows `lock.reason`

**Failure scenario.** The Next client is rebuilt before the API is restarted, which is the
pairing Codex used on port 4323. `GET /api/runs/<clinic>` from 4176 has no
`chosenDirectionReason`. The panel prints the direction name twice and quotes the mockup-lock
reason under the heading "ui-designer's recorded reason", and the same borrowed text feeds the
timeout classifier at `:182` and `:465`.

**Fix.** Treat `undefined` like `null` when `chosenDirectionBy` is non-null, or drop the
optional marker (the server always sends the key, `http.ts:743`) and let contract-parity pin it as
required. T16b, criterion 4.

### L2. `dashboard/src/components/canvas/agent-node.tsx:635`: an unmapped named agent's accessible name repeats the name and loses "unmapped"

`[titleOf(node), node.agent, look.label]` for `{agent: "some-agent-nobody-has-named", lane: null}`
yields "some-agent-nobody-has-named, some-agent-nobody-has-named, done"; before `3f331f7` it was
"some-agent-nobody-has-named, unmapped role, done". The sighted card still shows the chip
(`:443`).

**Fix.** Dedupe and restore the role word for the unmapped case; extend
`canvas-titles.browser.spec.ts` to assert the reviewer node's accessible name begins
`some-agent-nobody-has-named, unmapped role, `.

### L3. `dashboard/server/src/gate-recovery.ts:1030` and `:1081`: gate-only recovery rewrites `verdict.md` with no judge report and never clears `results/judge.json`

**Failure scenario.** The original execution persisted the two clinic findings in
`results/judge.json`; gate-only recovery re-scores and writes a `verdict.md` whose judge section
says "did not run: no report was recorded for this execution" beside a `judge.json` with two
findings. No false clean claim (that needs `ran: true`), but two incompatible accounts in the
same directory.

**Fix.** T17b, criterion 7.

### L4. `bakeoff/src/tier0.test.ts:63`: the case-insensitive deny is only tested on a case-insensitive host, and the predicate is not exported

The fixture holds only canonical spellings. On Linux `/ticket.md`, `/TiCkEt.Md`,
`/DeSiGn-ReFs/manifest.json`, `/VISIBLE-ACCEPTANCE/x.spec.mjs` and `/TeStS/x.test.mjs` resolve
null even with an exact-case compare because `statSync` fails at `tier0.ts:1338`, and the
`case-alias.txt` symlink dangles. The sealed gate runs on Linux (`scorer-container.ts:402`,
`docker/scorer.Dockerfile:127`). Also missing from `STATIC_DENIED_URLS`: uppercase `%2E%2E`,
overlong UTF-8 (`%C0%AE`), double-encoded `%252e%252e`, `%5c`.

**Failure scenario.** A regression that drops `toLowerCase()` at `tier0.ts:1280-1282` stays
green in a Linux container and is caught only on a developer Mac (measured: 7 failures here).

**Fix.** T18b, criterion 7.

### L5. `bakeoff/src/tier0.ts:1280`: the deny fold is `toLowerCase`, the filesystem's fold is not

`realpathSync` keeps the requested spelling (the report measured this for `ticket.md`). A spelling
APFS folds but `toLowerCase` does not (U+017F long s to `s`, U+212A Kelvin to `k`) would pass
both predicates; `tests`, `visible-acceptance` and `design-refs` all contain `s`. Hypothesis,
not measured (section 8); the Linux gate is unaffected.

**Fix.** Fold with `toUpperCase().toLowerCase()` or decide the post-realpath check on
`fs.realpathSync.native`; add `/te%C5%BFts/x.test.mjs` to `STATIC_DENIED_URLS` with a comment that
it discriminates only on a case-insensitive host.

### L6. `bakeoff/src/tier0.ts:1303`: no backslash refusal

`code-files.ts:238` refuses `\`; the static resolver does not. On POSIX it is an ordinary
filename byte; on win32 `path.join` at `:1311` would treat it as a separator and bypass `:1305`
and `:1308`. The realpath-stage checks still hold, so this is defence in depth and a test gap.

**Fix.** `if (decoded.includes("\\")) return null;` beside the NUL check, plus
`/app%5c..%5cTICKET.md` in `STATIC_DENIED_URLS`. Rides with T18b.

### L7. `bakeoff/src/tier0.test.ts:184`: the acceptance-source guard decodes with no `try`

A literal such as `"/x%"` anywhere under `dashboard/acceptance` throws `URIError` and errors the
test instead of reporting a violation with the file and literal named.

**Fix.** Wrap the decode; treat a malformed escape as a violation. Rides with T18b.

### L8. `dashboard/server/src/http.ts:3347`: `HEAD` on the preview route is not parity

The branch is GET-only; a `HEAD` falls to the generic `no route` 404 at `:3380` for every path,
served or not. Not a leak. A T18b test that copies the static server's HEAD matrix would go green
for the wrong reason.

**Fix.** T18b tests assert GET only, or HEAD support is added deliberately first.

### L9. `dashboard/server/src/design/video-policy.ts:26`: the policy ignores `DIAL_DEVIATION` and never checks that a `scroll_progress` motion is declared; the parser's false denials are silent to the lane

The compiler admits scroll-progress motion below 8 with a `DIAL_DEVIATION` exception
(`creative-contract.ts:1150`), but `readCreativeMotionPolicy` projects only `schemaVersion`,
`pageKind`, `motionIntensity` and motion ids, so a compiler-valid contract at 6 with the
exception is declined; and a contract at 9 with only `enter_view` motions receives a
scroll-scrubbed world layer nobody asked for. Separately, `parseMotionIntensity`
(`design-manifest.ts:707`) rejects plausible forms: `- **MOTION_INTENSITY 8** (scroll world)`,
`MOTION_INTENSITY 8/10` and `MOTION_INTENSITY: 8. Scroll world.` all yield
`{motionIntensity: null, occurrences: 1}` and so decline video with "first direction dial
declaration is invalid", while the prompt gives the lane no format.

**Failure scenario.** A legitimately high direction is declined on punctuation alone. A false
denial, never an exposure, and `results/video.json` records the reason.

**Fix.** Backlog, not this wave: the principled rule is "legs only when the contract declares a
`scroll_progress` motion", which subsumes the constant. Fold the dial-format rewrite into T26,
which must edit the same dial block (`design-prompt.ts:527-541`) and recapture the three design
goldens anyway. Until then treat a `video.json` reason ending "first direction dial declaration
is invalid" as a format miss, not a policy decision.

### L10. `dashboard/src/app/globals.css:218`: the hue-wheel comment omits 300 and counts the unmapped grey as a hue

"The eight role hues in use are 32, 78, 120, 168, 212, 258, 272 and 330." After `--role-debug`
at `:206` the list should read 32, 78, 120, 168, 212, 272, 300 and 330 (258 is unmapped's
near-zero-chroma grey). The 242 conclusion still holds.

**Fix.** Amend the list. Rides with any T15 follow-up.

Recorded without a change: hard links are invisible to both the name rule and realpath
(`tier0.ts:1336`). A builder that can hard-link `TICKET.md` to `public/notes.md` could equally
copy it; the deny list guards accidental exposure of harness-written names, not deliberate
republication. Worth a sentence in the docblock at `:1291-1294`.

## 5. The four deviations

### T19: omit the universal dial-format rewrite; parse both measured and legacy forms

**Sound with caveat.** The plan contradicts itself: T19 criterion 4 demands that when policy
allows, the expansion prompt is byte-identical to today's golden, and the dial lines
(`design-prompt.ts:540`) sit inside all three hashed design prompts captured at `d4f4dbe`
(`wave2-prompt-inputs.ts:67-69`). A universal rewrite has no unchanged branch, so standing rule 3
cannot be met either. Codex took the conservative arm and the parser fails closed: an anchored
`MOTION_INTENSITY` line it cannot read yields null with occurrences 1, and `videoLegPolicy`
declines with "first direction dial declaration is invalid" (`video-policy.ts:33-35`). Evidence:
`design-manifest.ts:700-717`; `design-manifest.test.ts:59-95` (4 parser tests including the
malformed-first-declaration case with 12 bad values); mutation A (`parsed <= 100`) 1 fail,
mutation B (occurrence guard) 2 fail; goldens 22 of 22 at HEAD. Caveat: L9 above. T26 must edit the
same dial block and recapture the goldens; do the format rewrite there.

### T16: expose `chosenDirectionReason` as an optional field on both mirrors and the projection, no writer changes

**Sound.** Necessary, not optional: criterion 1 requires the panel to quote the recorded reason
and the wire carried no such field; the plan's Touches list missed `http.ts` and the two mirrors.
One line per mirror (`api-types.ts:534`, `src/lib/api-types.ts:421`), one projection line
(`http.ts:743`), parity 14 to 15 (`contract-parity.test.ts:258-260`, `:277`). `git show --stat
e496b88` touches no `design-lock.ts` and no orchestrator writer. Older records are safe:
`readDesignLock` has defaulted the field to null through `readRecordString` (`design-lock.ts:565`)
since 2026-08-03. Negative control: deleting the projection turns `THE FOUR STAGES ON THE WIRE`
red. The `?` exists only for the client-newer-than-server window, which is L1.

### T17: add optional `judgeReport` plumbing to `run-report.ts`

**Sound.** `run-report.ts` is the only path between the two ends the plan named: `#writeVerdict`
(`orchestrator.ts:9186`) builds a `RunVerdictSource` via `verdictSourceFor` (`:9955-9966`) and
calls `writeRunVerdict` (`run-report.ts:498`), which goes through `verdictInputFor` (`:357`,
spread at `:360`) to `renderVerdict`. There is no direct call from the orchestrator to
`renderVerdict`, so the four-line addition (import, optional field at `:230`, one spread) is the
necessary seam. `computeOutcome` (`verdict.ts:288`) does not appear in the `13ca418` diff. Negative
control: the unconditional clean sentence turns 2 tests red. One nit: gate-only recovery builds
`RunVerdictSource` twice without a `judgeReport` (`gate-recovery.ts:1030-1035`, `:1081-1086`),
which is truthful ("did not run: no report was recorded") but less explicit than terminal creative
recovery's named reason. L3, T17b criterion 7.

### T18: case-insensitive deny of the harness root names

**Sound with caveat.** Right on Linux as well, for an architectural reason: the same resolver
serves the Mac preview (`preview.ts:87`) and the sealed gate inside the Linux scorer container
(`scorer-container.ts:402` calls `startStaticServer`; `docker/scorer.Dockerfile:127` ships the
bakeoff dist). A deny list is a policy about harness names and must not vary by host, or
`/ticket.md` is a 200 on the preview and a 404 on the gate. The cost on Linux, a product file at
the root spelled `Tests/` or `ticket.md` becoming unservable, is acceptable: the names are single
harness-owned words and the plan already denies `tests` outright. Evidence: `tier0.ts:1277-1284`,
`:1305`, `:1336`; the mutation removing both `toLowerCase()` calls fails 7 tests on this Mac. The
caveat is L4: the fixture proves the rule only on a case-insensitive host. T18b criterion 7.

### The shared threshold: `SCROLL_PROGRESS_MIN_MOTION_INTENSITY` (8) from `creative-contract.ts:8`, not a lane constant

**Sound with caveat.** Eight is the right floor for this lane as it exists, because the lane is
the motion class the constant already governs: `videoConsumptionPrompt` is unconditionally a
scroll-scrubbed world layer (`video-lane.ts:173-183`: scrub on scrollProgress, no `play()`, no
`loop`), and the compiler gates `scroll_progress` motion with the same constant
(`creative-contract.ts:1150`). One exported number is a single source of truth; the plan itself
specified sharing (section 4: "T20 and T19 share the exported threshold"). If a non-scrubbed
mount is ever added, the seam is a mount-mode input to `videoLegPolicy`, not a second number.
Caveat: L9, the two rules already diverge in shape (exceptions, and whether any `scroll_progress`
motion is declared). Do not add a lane-specific constant now.

## 6. The activation decision

The API on `127.0.0.1:4176` is pid 918, the LaunchAgent `com.kamilborzecki.coding-agent.server`
(`~/Library/LaunchAgents/`, `ProgramArguments` `/opt/homebrew/bin/node .../dashboard/server/dist/index.js`,
`KeepAlive` `SuccessfulExit` false), started 2026-09-05 00:25:25 (`ps -o lstart -p 918`), before
every wave 2 commit. `launchctl print gui/501/com.kamilborzecki.coding-agent.server`: `state =
running`, `pid = 918`, `runs = 1`, `last exit code = (never exited)`, `exit timeout = 5`. It has no
dynamic imports of repository code (the only `await import(` calls in non-test source are
Playwright and node builtins), so it is coherently old; `dist/index.js` on disk is 14:41:28 today
and carries `chosenDirectionReason` (`grep -c` in `dist/http.js` gives 1). Codex's reason for not
restarting, that the boot path "can migrate the DB, reconcile runs and start the supervisor", is
correct about what the code can do and, on this database, every one of those steps is a measured
no-op.

### What a restart does

Boot order from `dashboard/server/src/index.ts`; preconditions read with
`sqlite3 'file:dashboard/data/runs.db?immutable=1'` on 2026-09-08 (writes nothing; mtime and
sha256 unchanged afterwards).

| Step | Code | What it can do | Measured precondition | Effect on this restart |
|---|---|---|---|---|
| 1 | `resolvePaths` and `ensureDirs`, `paths.ts:135-188` | `mkdir -p` on `data`, `runs`, `acceptance`, `results` | all 4 exist | none |
| 2 | `RunStore.open`, `index.ts:61`, `db.ts:1291-1308` | WAL pragma, 14 `CREATE TABLE IF NOT EXISTS`, 3 `CREATE INDEX IF NOT EXISTS`, `addMissingColumns` after `PRAGMA table_info` | 14 tables present; every added column present; 0 `INSERT` in `SCHEMA`; `db.ts` unchanged in `759d1be..HEAD` | none |
| 3 | `armRepairDriver`, `index.ts:158`, `supervisor-boot.ts:427-460` | spawns `tools/repair/supervisor-cycle.mjs --armcheck` under a 30 s `SIGKILL` cap; its git round trip lives in `mkdtemp` under `os.tmpdir()` and is removed in `finally` (`supervisor-cycle.mjs:1091`, `:1301-1302`) | 0 leftover `supervisor-cycle-arm-*` dirs; 0 `supervisor_tickets` | tmpdir only |
| 4 | `gateRecovery.reconcileOnBoot`, `index.ts:227`, `gate-recovery.ts:448-456` | stages and scores incomplete recoveries (`db.ts:1411-1419` excludes `completed` and `infra_failed`) | 1 `gate_recoveries` row, state `completed` | none |
| 5 | `server.listen`, `index.ts:250`; `auth.status()`, `:256` | binds 4176; spawns `claude auth status --json` and `codex login status`, 20 s each | only pid 918 holds 4176 | `EADDRINUSE` if 918 is still alive, then exit 2 and a launchd relaunch loop under `SuccessfulExit` false; never start it by hand |
| 6 | `orchestrator.reconcileOnBoot`, `index.ts:270`, `orchestrator.ts:2018-2216` | requeues or parks `running`, re-arms `awaiting_input` and `rate_limited`, then `this.pump()` at `:2215`: the one step that can start a build and spend quota | `SELECT status, count(*) FROM runs GROUP BY status`: cancelled 6, failed 19, passed 6; 0 rows outside `passed`, `failed`, `cancelled` (`db.ts:748` `isTerminal`) | none; re-run the query in the same minute as the restart |
| 7 | `projects.reconcileOnBoot`, `index.ts:276`, `project-runner.ts:912` | rewrites `data/project-runner.json` | `{"writtenAt":"2026-09-04T22:25:56.443Z","children":[]}` | one file rewritten with a new `writtenAt`; the only write under `dashboard/data` |
| 8 | `startSupervisor`, `index.ts:290`, `supervisor-boot.ts:109-160` | in-memory arm check, an `unref`'d 30 s interval, one boot tick that reads 4 tables | `supervisor_state` `running` since 2026-08-26T15:39:18.165Z; `supervisor_log` 2 rows across weeks of ticks; 0 tickets | reads only; standing caveat: any ticket that ever lands is claimed by whichever process is up |
| stop | `SIGTERM`, `index.ts:316`, `:293-313` | `supervisor.stop()`, `orchestrator.shutdown()` (`orchestrator.ts:2218`, 0 active runs), `projects.stopAll()` (0 children), `server.close`, `store.close`, `process.exit(0)` with a 3 s fallback | launchd exit timeout 5 s | exit 0 is a successful exit, so launchd does not relaunch; an explicit `kickstart` is required |

The cron LaunchAgent (`com.kamilborzecki.coding-agent.tick`, every 1800 s) never opens `runs.db`
(`cron/cron-tick.ts:4-12`); a tick during the window journals `unreachable` (exit 5) into
`dashboard/cron/journal.jsonl` and nothing else. `dashboard/cron/queue` holds 0 entries. Each tick
is a fresh process already running the new `dist/cron/cron-tick.js`; its only channel is HTTP.

### Procedure

Pre-flight, read-only: `git rev-parse --short HEAD` (`ecb4787`); `find dashboard/server/src -name
'*.ts' -newer dashboard/server/dist/index.js | wc -l` and the same for `bakeoff/src` against
`bakeoff/dist/tier0.js` (both 0 today; if not, `npm run build --silent` in that package; a server
build does not rebuild bakeoff); the non-terminal query in step 6 (0); `SELECT count(*) FROM
supervisor_tickets` (0); `ls dashboard/cron/queue | wc -l` (0).

Restart, through launchd only:

```sh
launchctl kill SIGTERM gui/501/com.kamilborzecki.coding-agent.server
while kill -0 918 2>/dev/null; do sleep 0.5; done
launchctl kickstart -p gui/501/com.kamilborzecki.coding-agent.server
```

Two steps rather than `kickstart -kp` because the man page does not say which signal `-k` sends,
and the graceful path is the one that aborts nothing.

Confirm: `launchctl print ... | grep -E '^\s+(pid|runs|last exit) ='` shows a new pid and `runs =
2`; `tail -30 ~/Library/Logs/coding-agent/server.out.log` shows `SIGTERM: stopping.`, then
`dashboard listening on http://127.0.0.1:4176`, `claude authenticated`, `codex authenticated`, no
`project` lines, and ends with `ARM CHECK: supervisor loop armed; ticking every 30s, desired reads
'running'` (the last line of the current log) with no `ARM CHECK FAILED`; `tail -4
server.err.log` shows four `ARM CHECK` lines with `desired='running'`, 0 tickets;
`curl -s http://127.0.0.1:4176/api/runs/run-2026-09-04T15-54-06-323Z-131fd85f | grep -c
chosenDirectionReason` is 1 (0 today against pid 918, the behavioural proof that the new dist is
serving; `/api/health` carries no build identity, `api-types.ts:2459-2474`); `shasum -a 256
dashboard/data/runs.db` still `3d4c793c…e18771` and `runs.db-wal` still 0 bytes; the counts above
unchanged (runs 31, events 17178, run_attempts 53, supervisor_log 2, supervisor_tickets 0);
`dashboard/data/project-runner.json` has a new `writtenAt` and `children []`; `ls dashboard/runs |
wc -l` is 31; 0 leftover `supervisor-cycle-arm-*` dirs in `$TMPDIR`; the next
`journal.jsonl` row reads `skipped`.

### Rollback

`dist/` is gitignored and the old build is gone, so rollback is a rebuild in place:
`git switch --detach 759d1be` (the dirty docs do not intersect the range, whose only docs change
is the new REPORT file; `package.json`, `package-lock.json` and `tools/` are unchanged in the range,
so no install), `(cd bakeoff && npm run build --silent)`, `(cd dashboard/server && npm run build
--silent)`, the same kill and kickstart, and `grep -c chosenDirectionReason` back to 0. Return with
`git switch main` and the same three steps. Do not `git stash` (sibling agents). A worktree is not
a faithful alternative: `dashboardProjectId` is the checkout's basename (`paths.ts:63`), which would
switch off the exact-project pilots (`index.ts:93-96`) unless the worktree is named identically.

### Adjacent state a restart does not fix

The Next UI on 4319 (LaunchAgent `com.kamilborzecki.coding-agent.ui`, pid 1887, `next start`)
serves `dashboard/.next/BUILD_ID` from 2026-09-04 17:26:17, before T15 and T16's client changes;
canvas titles and the judged-choice copy will not appear until `next build` and a ui-agent
restart. Port 4321 is Codex's ad hoc listener, pid 71532, a child of the ChatGPT app's codex
app-server (pid 18648), not the API's `PreviewHost`; the clinic row's `preview_url` is
`http://127.0.0.1:4321` and goes dark when that Codex session ends. A restarted API's
`PreviewHost` skips a busy 4321 (`preview.ts:27`, `:82`). Per the plan, G3 depends on T19, T21,
T22 and T24, so a restart now activates T15 to T20 only and must be repeated after batch 2B.

### Recommendation

Do not restart for batch 2A alone. Restart once, after batch 2B and the section 7 fixes land,
and in the same window rebuild and restart the Next UI, never one without the other (L1 is
exactly the mismatch a client-only rebuild produces). The procedure above is safe today and will
be safe then provided the step 6 query still returns 0; it is a two-minute operation with a
measured no-op profile. If the owner wants to look at T15 and T16 in the browser before 2B, do
both restarts now with the same procedure; nothing about the timing changes the risk.

## 7. Follow-up tasks for the plan

Written in the plan's format. T18b is the route Codex flagged; T17b and T16b are what this review
surfaced. Line numbers as read at `ecb4787`.

### T18b. PREVIEW-EXPOSURE-001, the API preview route: `resolvePreviewTarget` refuses harness-internal paths

**Goal.** `GET /api/runs/:id/preview/*` refuses the same internal names the static server refuses,
with a named refusal code, while the code browser (`GET /api/runs/:id/files`) keeps listing and
reading them.

**Why here.** Measured 2026-09-08 against the API at 4176:
`/api/runs/run-2026-09-04T15-54-06-323Z-131fd85f/preview/TICKET.md` 200 (body begins "Build a
polished, responsive web app for booking a fictional clinic appointment."),
`.../preview/design-refs/manifest.json` 200, `.../preview/visible-acceptance/booking-wizard.spec.mjs`
200, `.../preview/.git/config` 403; the same three names are 404 on the static server at 4321. The
route dispatches at `http.ts:3347` to `servePreview` (`:5526`), decodes per segment
(`code-files.ts:682-706`), prefixes the document root (`http.ts:5555-5556`) and calls
`resolvePreviewTarget` (`code-files.ts:732`), which goes through `resolveWorkspacePath` (`:281`),
whose only name rules are `pathRefusal` (`:219`) and `denyReason` (`:193`: `.git`, `node_modules`,
`SECRET_NAME_RULES`). `code-files.ts` is unchanged in `759d1be..HEAD`. PREVIEW-EXPOSURE-001
(`docs/BACKLOG.md`, P0) stays open until this lands; ADVERSARY-ACCESS-001 (P1) plans to give the
adversary a route to this preview.

**Touches.**
- `bakeoff/src/tier0.ts:1277`: export `isInternalStaticPath` (module-private today;
  `STATIC_INTERNAL_ROOTS` at `:1265` is already exported and `code-files.ts:98` already imports
  from `bakeoff/dist/tier0.js`); `bakeoff/src/tier0.test.ts:181-188` carries a second copy of the
  predicate that then imports the real one
- `dashboard/server/src/code-files.ts:732` (`resolvePreviewTarget`), after `resolveWorkspacePath`
  returns ok and only there; the header sentence at `:17-20`
- `dashboard/server/src/api-types.ts:2927` (`PreviewOwnRefusalCode`: add `path_internal`) and its
  docblock at `:2905-2926`
- `dashboard/server/src/http.ts:5356-5362` (the comment that repeats the fence promise). The
  directory-index lookup (`:5592`) and `previewRootPrefix` (`:5406`) go through
  `resolvePreviewTarget` and inherit the rule with no edit
- `dashboard/server/src/preview-route.test.ts` (today the only name case is `.env`, `:545-548`)
- `bakeoff/src/tier0.test.ts`: a second fixture root for criterion 7

**Acceptance criteria.**
1. `resolvePreviewTarget` refuses, with code `path_internal` and status 404 (the static server's
   answer; existence is not revealed), any request whose workspace-relative path has a
   dot-prefixed segment or whose first segment is a `STATIC_INTERNAL_ROOTS` name,
   case-insensitively, evaluated on the previewRoot-prefixed path so a site under `site/` keeps
   serving `site/tests/...`.
2. The same predicate is evaluated a second time on
   `relative(realpathSync(workspace), target)` so a public symlink to a private target is
   refused, mirroring `tier0.ts:1336`.
3. `pathRefusal`, `denyReason`, `resolveWorkspacePath`, `walk`, `readWorkspaceTree` and
   `readWorkspaceFile` are untouched; `code-files.test.ts:225` (`.claude/x` accepted),
   `:255-260` (`visible-acceptance/coglane-page.spec.mjs`, `.claude/settings.json`,
   `design-refs/manifest.json` allowed) and `:324` (`?path=visible-acceptance/...` answers 200)
   pass unchanged. These three are the placement control: a rule that lands in
   `resolveWorkspacePath` turns them red.
4. Existing preview refusals keep their codes: `.env` stays 403 `path_forbidden`
   (`preview-route.test.ts:545-548`); a missing index stays 409 `no_index_html`.
5. **NEGATIVE CONTROL.** Fixture workspace with `index.html`, `script.js`, `TICKET.md`,
   `design-refs/manifest.json`, `visible-acceptance/x.spec.mjs`, `tests/x.test.mjs`,
   `.claude/settings.json`, `.bakeoff/state.json`, plus symlinks `ticket-alias.txt` to
   `TICKET.md` and `refs-alias` to `design-refs`, every internal file carrying a planted marker
   string. Positive controls first: `/` and `/script.js` answer 200. Then each internal path,
   each alias, and the per-segment encodings the URL parser does not normalise (`/%2egit/config`,
   `/visible-acceptance%2fx.spec.mjs`, which `decodePreviewPath` at `code-files.ts:689-703` turns
   into `.git/config` and `visible-acceptance/x.spec.mjs`) answer 404 with
   `error: "path_internal"` and a body that does not contain the marker. Run the internal half
   once against the pre-change dist and record the 200s. GET only: the route is GET-only
   (`http.ts:3347`) and a HEAD falls to the generic 404 at `:3380` for every path, so a HEAD
   assertion would pass for the wrong reason.
6. `code-files.ts:17-20` and `http.ts:5356-5362` no longer say the preview and the browser cannot
   disagree about the fence; they say the browser shows the harness files on purpose and the
   preview refuses them on purpose.
7. In `bakeoff/src/tier0.test.ts`, a second fixture root holding `Tests/x.txt` and `Ticket.md`
   (creatable on this Mac because no same-name sibling exists) with `resolveStaticFile` asserted
   null for `/tests/x.txt`, `/Tests/x.txt`, `/TICKET.md` and `/Ticket.md`, and
   `isInternalStaticPath("/ticket.md")` and `("/TeStS/x")` asserted directly through the new
   export. Today the five mixed-case cases at `tier0.test.ts:67-69` pass vacuously on a
   case-sensitive host (`statSync` on `ticket.md` fails at `tier0.ts:1338`), and the sealed gate
   runs on Linux (`scorer-container.ts:402`, `docker/scorer.Dockerfile:127`). Remove both
   `toLowerCase()` calls at `tier0.ts:1280-1282` and the new assertions must go red on any host.
   L6 and L7 ride along here: a backslash refusal beside the NUL check with
   `/app%5c..%5cTICKET.md` in `STATIC_DENIED_URLS`, and a `try` around the decode at `:184`.

**Must not.** Must not change what `GET /api/runs/:id/files` lists or reads. Must not add a
configuration knob. Must not touch `dashboard/src` (`spec-pipeline.ts:545` links only to
`/preview/`). Must not restart 4176 in the session; the route is exercised through the test
harness.

**Depends on.** T18 (landed). **Reversible: R.** **Survives abandonment: yes.**

---

### T17b. The clean claim follows the judge's verdict, and every T17 wire has a control

**Goal.** The clean sentence follows `judge.verdict`, not the length of the finding list; the
orchestrator's own redaction is provably on the path for reports that never pass through the
judge parser; the in-memory report cannot outlive its attempt; gate-only recovery leaves
`results/judge.json` consistent with `verdict.md`.

**Why here.** Four measured gaps in T17 (section 3 items 1 to 4; section 4 M1 to M3, L3). One is
shipped behaviour (M1); three are controls that survive their mutation, which this repository's
first standing rule counts as findings. T25 and T26 will read the verdict plumbing next.

**Touches.**
- `dashboard/server/src/verdict.ts:658-661` (`summaryLine`); `verdict.test.ts:748`
- `dashboard/server/src/orchestrator.ts:7568` (`#resetJudgeReport`), `:7577`
  (`#recordJudgeReport`), `:7598-7612` (the skipped report), `:8864-8877` (the requeue branch of
  `#finish`), `:9261-9266`; `orchestrator.test.ts:8549-8668` (the T17 block; the fixture judge at
  `:8519`, the harness at `:8533`)
- `dashboard/server/src/gate-recovery.ts:1030-1035`, `:1081-1086`, and its tests
- `dashboard/server/src/judge.ts:229-240`, read only: the parser's row-dropping is the input to M1

**Acceptance criteria.**
1. `summaryLine` prints the clean sentence only when `judge.ran === true && judge.verdict ===
   "clean"` (`judge.ts:240` guarantees `clean` implies zero findings, so the current fixtures
   still pass).
2. **NEGATIVE CONTROL for 1.** `renderVerdict` with
   `{ran: true, verdict: "concerns", findings: [], summary: "the handler is a stub"}` under a
   green gate: the page contains "the handler is a stub" in the judge section and does not match
   `/nothing was noted against it/`. Revert the condition to `findings.length === 0` and this is
   red. The existing `{ran: true, findings: []}` clean case stays green.
3. An orchestrator test drives `#judgePhase` with a `FixtureJudgeAuth` whose `claude` is not
   `ok` and whose `claudeDetail` contains `ghp_` plus 25 characters; `results/judge.json` and
   `verdict.md` contain `[REDACTED:` and not the token.
4. **NEGATIVE CONTROL for 3.** With `const redacted = report;` in `#recordJudgeReport` (dist) the
   test is red; with `judge.ts:342-343` stripped instead it stays green, because the skipped path
   never passes through the judge parser. The existing test at `:8581` stays as the judge-path
   control.
5. An orchestrator test reaches a clean judge, makes `finishUnlessOwnerMessagePending` take the
   requeued branch (`:8864-8877`), and fails the next attempt's build so `#finish("failed")`
   writes the verdict before `#judgePhase` runs; `verdict.md` matches
   `/code-reading judge did not run: no report was recorded/` and does not contain the prior
   summary.
6. **NEGATIVE CONTROL for 5.** Remove `this.#judgeReports.delete(runId)` at `:7568` and the test
   is red. Measured today: the seven existing tests stay green under that removal.
7. Gate-only recovery either removes `results/judge.json` at entry (mirroring `:9261`) or records
   `{ran: false, verdict: "unavailable", findings: [], summary: "gate-only recovery does not run
   the code-reading judge"}` and passes it to both `writeRunVerdict` calls; a test plants a
   two-finding `judge.json` before recovery and asserts the two artefacts agree afterwards.

**Must not.** Must not make the judge gating or touch `heldOutPass`. Must not change the parser's
truncation or row rules (`judge.ts:229-240`): the parser dropping a row is the input, the
verdict's honesty is the output. Must not alter the criteria section.

**Depends on.** T17 (landed). **Reversible: R.** **Survives abandonment: yes.**

---

### T16b. One source for the timeout reason, and an absent reason is not dressed in the mockup lock's

**Goal.** The timeout fallback reason has one exported source shared by the two orchestrator
writers and the two client readers, and a direction choice with an absent reason renders as "no
reason recorded" instead of borrowing `lock.reason`.

**Why here.** Section 3 items 5 and 6. The literal lives at `orchestrator.ts:1887` and `:1898`
(composed through `design-lock.ts:257` and `:376`), the readers at `design-lock.tsx:182` and
`:465`, and the browser spec carries a third copy at `design-lock.browser.spec.ts:358`. Rewording
the writers keeps 53 tests green, after which every real timeout renders as "The chooser wrote no
usable choice", the misattribution T16 was raised to remove. The plan's one-area rule keeps this
out of T17b.

**Touches.**
- `dashboard/server/src/design-lock.ts`: export `DIRECTION_TIMEOUT_REASON` (the client already
  imports server modules the way `src/lib/graph.ts` imports `../../server/src/graph`)
- `dashboard/server/src/orchestrator.ts:1887`, `:1898`
- `dashboard/src/components/run/design-lock.tsx:182`, `:465`, `:532-534`;
  `dashboard/server/src/cron/cron-report.ts:113-115`
- `dashboard/tests/design-lock.browser.spec.ts:358`; a writer-side test in
  `dashboard/server/src/orchestrator.test.ts` beside the existing timer tests

**Acceptance criteria.**
1. Both writers and both readers reference the constant;
   `grep -rn 'before the timeout' dashboard/server/src dashboard/src dashboard/tests` finds only
   the constant's definition.
2. A server test drives the direction timer path and asserts the persisted
   `chosenDirectionReason` contains `DIRECTION_TIMEOUT_REASON`, and separately pins the exact
   recorded string against a literal in the test so a silent change of the wire text is red.
3. **NEGATIVE CONTROL.** Reword the writer at `:1887` to a literal that bypasses the constant and
   criterion 2 is red; today the same rewording leaves 42 plus 11 tests green.
4. When `chosenDirectionBy` is non-null and `chosenDirectionReason` is `undefined`, the panel and
   the cron line render as they do for `null` ("No reason was recorded.", no timeout
   classification) instead of borrowing `lock.reason`; a browser test feeds a `ui-designer` lock
   with the key absent and asserts the mockup-lock reason is not quoted under the direction
   heading.

**Must not.** Must not change the record shape (the freeze holds until T25). Must not touch the
owner wording.

**Depends on.** T16 (landed). **Reversible: R.** **Survives abandonment: yes.**

---

**Ride along, no session of their own.** L2 (`agent-node.tsx:635`, the unmapped accessible name)
and L10 (`globals.css:218`, the hue list) with the next T15 touch; L9's format rewrite with T26;
L9's `scroll_progress` declaration rule and `DIAL_DEVIATION` reading to the backlog under
`docs/BACKLOG.md` as a video-policy item; L5 (unicode folding) to the backlog pending one
measurement on this Mac.

## 8. What this review could not check

- Anything on a Linux host. No Linux machine and no CI workflow in the repository
  (`.github/workflows` absent), so the T18 Linux claims (L4, section 5) are reasoned from
  `tier0.ts:1337-1341` and the fixture, not measured.
- The report's own "old resolver with only port reporting corrected" figure (2 passed, 20
  failed) was not reproduced as such; the control repeated here disabled only the dot-segment
  predicate (13 red, all dot-path cases) and is narrower by design.
- Whether V8's `decodeURIComponent` throws on overlong UTF-8 (`%C0%AE`), whether APFS folds
  U+017F or U+212A onto ASCII (L5), and whether Node's `realpathSync` preserves request casing on
  this build (the report says it does; `tier0.ts:1279` relies on it). Each needs one execution.
- Whether `auth.claudeDetail` (`orchestrator.ts:7610`) or the terminal-recovery summary can
  carry a secret-shaped token in production; only measured that on those paths the
  orchestrator-level `redactForPersistence` is the sole redaction and no test plants a secret
  there.
- The report's T15 mutation "every unmapped identity becomes `session`", its T16 mutations
  "judged pick falsely says no choice arrived" and "timeout fallback loses its timeout sentence",
  its two remaining T19 mutations ("omit lane policy wire", "omit expansion policy wire"), and 10
  of its 11 T20 mutations. Each reviewer repeated the controls in scope and added others; those
  rows were not repeated.
- The report's 195-check T19 set, 232-check T20 set, and the full server suite (2,663 tests, 3
  baseline failures: the `d728ab79` continues-count assertion, the legacy defect ledger count, and
  `run-cont-86f1ba81c2d280d23d07`'s manifest). Only the named suites were re-run.
- Codex's Computer Use observations on port 4323 (no server exists there now) and which API that
  instance was pointed at; if 4176, the "full recorded clinic reason" it saw was the borrowed
  `lock.reason` with the direction-name prefix, not `chosenDirectionReason`.
- Rendering on the live 4319 client (a Sep 4 build; it cannot show T15 or T16 either way) and
  which exact commit pid 918 loaded (`dist/` is gitignored; the reflog puts HEAD at `759d1be`
  from 2026-09-04 17:32 to 2026-09-08 12:17, spanning the boot).
- What signal `launchctl kickstart -k` sends (the man page is silent), hence the two-step restart
  in section 6.
- Windows behaviour of the static resolver (L6) was reasoned from `node:path`; no supported
  deployment runs on Windows.
