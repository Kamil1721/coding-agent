---
document_status: review
written: 2026-09-08
reviews: docs/REPORT-wave2-corrective-2026-09-08.md
at_commit: 4bb9a31
---

# Review: wave 2 corrective (T17b, T16b, T18b)

The report path above is the one the task named. The file Codex wrote and commit 4bb9a31 refers to is `docs/REPORT-wave2-batch2a-fixes-2026-09-08.md`; `docs/REPORT-wave2-corrective-2026-09-08.md` does not exist (`ls docs/REPORT-wave2-*`). Commits reviewed: d7016bb, 55ae6e2, 57b74d6 on top of ecb4787. Method: both packages built (`npm run build --silent` in `bakeoff` then `dashboard/server`, exit 0), compiled dist mutated, restored with `cp`, checked with `cmp`, rebuilt and `cmp`'d again. Tests ran with `DASHBOARD_LIVE_SMOKE=0 node --test` over dist. Nothing committed, `git status --short -- dashboard bakeoff` empty, `dashboard/data/runs.db` mtime still 2026-09-04 22:07:27, pid 918 on 4176 untouched, no Docker, no pipeline run, no metered call.

## 1. Verdict

Go with fixes. Every one of the twenty controls below went red with an assertion message that names the mutated behaviour, and every restore `cmp`'d byte-identical, so the three defects the batch 2A review raised are closed at the mechanism level and the API can be restarted on this dist and Batch 2B can start. Two things ride into 2B as tickets rather than blockers: the preview's refusal code reveals whether a harness-internal file exists (`dashboard/server/src/code-files.ts:760-762`, section 3, item 1), and the requeue crash path can leave a stale `results/judge.json` beside a verdict that says no judge ran (`dashboard/server/src/orchestrator.ts:7569-7571`, item 2). Neither serves bytes and neither changes a gate outcome.

## 2. Controls

| # | Claim | Mutation (dist only) | Decisive assertion message | Names mutated behaviour | Verdict |
|---|---|---|---|---|---|
| T17b-0 | Baseline green at HEAD | none | verdict 1/0, orchestrator 2/0, gate-recovery 5/0 plus boot 1/0, exit 0 | yes | confirmed |
| T17b-1 | Clean sentence follows `judge.verdict` | `dist/verdict.js:551` condition reverted to `findings.length === 0` | `a concerns verdict cannot claim clean even when every finding row was dropped` (exit 1) | yes | confirmed |
| T17b-2a | Orchestrator redaction sits on the auth-skip path | `dist/orchestrator.js:6288` `redacted = report` | `judge.json: auth-skip report must redact before persistence without the judge parser` (exit 1) | yes | confirmed |
| T17b-2b | Parser-only strip leaves auth-skip green | `dist/judge.js:273-274` redaction removed | no assertion fired, 1 pass (exit 0); test also pins `h.calls() === 0` | no (green by design) | confirmed |
| T17b-2b-live | Parser mutation is real | orchestrator strip alone: green; both stripped: red | `assert.ok(!raw.includes(secret))` at `dist/orchestrator.test.js:7400` (exit 1) | yes | confirmed |
| T17b-3 | In-memory delete blocks a borrowed clean report | `dist/orchestrator.js:6279` `#judgeReports.delete` removed | `the requeued attempt must not borrow the previous clean judge report` (exit 1) | yes | confirmed |
| T17b-4a | Entry cleanup bound on its own | `#ownedWritableTarget` entry call skips `rmSync` | `T17b gate-only scorer-entry cleanup must remove stale judge.json before scoring passed` (and failed, infra_failed), 1 pass 4 fail | yes | confirmed |
| T17b-4b | Finalizer cleanup bound on its own | both finalizer calls skip `rmSync` | `T17b gate-only owned-target judge cleanup must remove stale judge.json at passed finalization` (and failed, infra_failed, boot), 0 pass 5 fail | yes | confirmed |
| T17b-5 | Failing unlink cannot fail a green gate | `dist/gate-recovery.js:911-915` try/catch removed | `SystemError [ERR_FS_EISDIR]` thrown at `dist/gate-recovery.js:913` inside `#ownedWritableTarget` (exit 1) | yes, by stack not prose | confirmed |
| T17b-6 | Rebuild reproduces dist, all green | none | both builds exit 0, four files `cmp` 0, 1/0, 3/0, 6/0 | yes | confirmed |
| T16b-1a | Direction writer uses the constant | `dist/orchestrator.js:1288` literal `"the owner did not choose in time"` | `direction timeout writer must persist the shared reason` (exit 1) | yes | confirmed |
| T16b-1b | Legacy mockup writer uses the constant | `dist/orchestrator.js:1300` same literal | `legacy timeout writer must persist the shared reason` (exit 1) | yes | confirmed |
| T16b-2 | Wire text pinned exactly | `dist/direction-timeout-reason.js:2` `timeout` to `deadline` | `legacy timeout wire text must remain exact` and `direction timeout wire text must remain exact` (exit 1) | yes | confirmed |
| T16b-3 | Cron report stops borrowing `lock.reason` | `dist/cron/cron-report.js:82` pre-fix predicate | `an absent direction reason must not borrow the mockup-lock reason`, 17 pass 1 fail | yes | confirmed |
| T16b-4 | Client panel stops borrowing `lock.reason` | `src/components/run/design-lock.tsx:533` pre-fix predicate, served on 4322/4177 | `omitted direction reason is reported as absent`, received the borrowed text, 27 pass 1 fail | yes | confirmed |
| T18b-1 | Preview matrix green at HEAD | none | 16 pass 0 fail, 12 internal cases 404, `/.git/config` `/%2egit/config` `/.env` 403 | yes | confirmed |
| T18b-2 | Requested-path guard bound | `dist/code-files.js:691` `relPath` check removed | `T18b requested-path guard must refuse GET /.claude/product-alias.js`, `200 !== 404` | yes | confirmed |
| T18b-3 | Real-target guard bound | `dist/code-files.js:691` `realPath` check removed | `T18b real-target guard must refuse GET /ticket-alias.txt` and `/refs-alias/manifest.json`, `200 !== 404` | yes | confirmed |
| T18b-4 | Case folds bound on this Mac | `bakeoff/dist/tier0.js:1071,1073` `toLowerCase` removed | `shared predicate must fold the ticket name` and `mixed-case internal file must be refused: /Tests/x.txt`, 2 pass 2 fail | yes | confirmed |
| T18b-4L | Same on Linux (Codex evidence, not re-run) | same, in a `node:22` container | same two messages, `# pass 0 # fail 2`, from `/tmp/wave2-fixes-t18b-linux-case-evidence.txt` | yes | confirmed from file |
| T18b-5 | Code browser still lists `.claude`, `design-refs`, `visible-acceptance` | none | `dist/code-files.test.js` 11 pass 0 fail | yes | confirmed |

## 3. Findings

1. Medium. `dashboard/server/src/code-files.ts:760-762`. The `path_internal` guard runs after `resolveWorkspacePath` has realpath'd the target (`:317`), so an internal name that exists answers `404 path_internal` and one that does not answers `404 not_found` with `no such file in this run's workspace: <path>`. Measured against the clinic workspace read-only: `visible-acceptance/booking-wizard.spec.mjs` gives `path_internal`, `visible-acceptance/zz-does-not-exist.spec.mjs` gives `not_found`; same pair for `TICKET.md` vs `ticket-2.md` and `design-refs/manifest.json` vs `design-refs/zz-missing.json`. The static server refuses on the name before touching the filesystem, which is the "existence is not revealed" rule in the batch 2A review's AC1. The matrix test plants every internal file so it cannot see this. Fix for 2B: when `resolveWorkspacePath` returns `not_found` and `isInternalStaticPath(relPath)` is true, answer `path_internal`; add a matrix case for a missing internal name. Loopback and owner-only today, and no bytes leak.
2. Low. `dashboard/server/src/orchestrator.ts:7569-7571`. The requeue branch of `#finish` (`:8862-8877`) clears nothing; `#resetJudgeReport` clears memory (`:7569`) then disk (`:7571`) at the next attempt's entry. A crash between the two, followed by `reconcileOnBoot` finishing the run without a new attempt, leaves a `judge.json` saying clean beside a `verdict.md` saying no report was recorded. No server code reads `judge.json` from disk (grep: `:7571` rm, `:7581` write, `gate-recovery.ts:1127` rm), so authority is unaffected. Mitigation: remove `results/judge.json` on the no-attempt path when `#judgeReports` has no entry.
3. Low. `dashboard/server/src/gate-recovery.test.ts:216`. The "cleanup failure cannot fail a green sealed gate" test discriminates by an escaped `ERR_FS_EISDIR`, not by its named `judge cleanup failure is non-gating` assertion. Wrap `controller.recover(...)` in `assert.doesNotReject(..., 'judge cleanup failure must not throw out of recovery')`.
4. Low. `dashboard/tests/design-lock.browser.spec.ts:385-386`. The absence assertion runs before the borrow assertion, so a borrow regression always reports through `omitted direction reason is reported as absent`. Swap the two lines or use `expect.soft`.
5. Low. `dashboard/server/src/api-types.ts:534` and `dashboard/src/lib/api-types.ts:421` still declare `chosenDirectionReason` optional while `http.ts:742-743` always emits the key. Tightening to required makes the wire type match the server.

## 4. The .git 403 deviation

Sound. `denyReason` (`code-files.ts:193`, applied at `:285-296`) refuses `.git` and every `SECRET_NAME_RULES` name on the name alone, before any filesystem call, so `/.git/config` and `/%2egit/config` answer `403 path_forbidden` and AC5's `404 path_internal` is unreachable while AC3 (guard only after `resolveWorkspacePath` returns ok) and AC4 (`.env` stays 403) hold. That 403 serves no bytes and fires whether or not the file exists, so it reveals nothing; the code browser gives the same answer for the same names. Moving the guard ahead of `denyReason` would recode `..` shapes and secret names as `path_internal` (`isInternalStaticPath('../x')` is true) and break the `.env` test at `preview-route.test.ts:545-548`. The only cost is a status mismatch with the static server (403 vs 404) for `.git`, and both refuse.

## 5. Could not check

- T18b-4L on Linux was read from Codex's evidence file, not re-executed; Docker was not started per the rules.
- The Vite client build for `design-lock.tsx:85` (a value import of `../../../server/src/direction-timeout-reason`) was not run. The Next dev bundle compiled and served all 28 browser tests on 4322, which covers the import resolving but not the production bundle.
- The full `dist/orchestrator.test.js` and full server suite were not run; sibling agents were mutating the shared dist concurrently, so only the named selectors were exercised.
- The crash window in finding 2 cannot be tested with a process kill; a unit check that `reconcileOnBoot` leaves `results/judge.json` in place for a parked run would show the residue.
- HEAD on the preview route was confirmed from source only (`http.ts:3347` requires GET, `:3380` answers `no route for HEAD`); no filesystem is consulted, so no leak.
