# Codex brief: Batch 2A fixes (T17b, T16b, T18b)

## Why this brief exists

Batch 2A was independently reviewed at `ecb4787`. Verdict: go with fixes. T15, T16, T18, T19
and T20 hold under mutation and all four of your plan deviations were judged sound. Three
things did not hold, and one is the defect this repository exists to catch: a check that
survives its own mutation. Fix these before starting Batch 2B.

Read `docs/REVIEW-wave2-batch2a-2026-09-08.md` in full first. Section 7 contains the three
tasks below in the plan's own format, with files, line anchors, acceptance criteria and negative
controls. This brief is orientation; the review is the specification.

## The tasks, in this order

**T17b. The clean claim follows the judge's verdict, and every T17 wire has a control.**

The bug: `dashboard/server/src/verdict.ts:659` prints "nothing was noted against it" when
`judge.findings.length === 0`. A `concerns` verdict whose finding rows the parser dropped
(`judge.ts:231` skips rows whose `detail` is not a string; `judge.ts:240` keeps the verdict)
still prints the sentence T17 exists to stop. Reproduced against `dist/run-report.js`: a
`{ran: true, verdict: "concerns", findings: []}` report yields `# PASSED` plus the clean sentence
above a judge section reading "the handler is a stub". Gate on `judge.verdict === "clean"`.

Three of your claimed negative controls survive their mutation. Each needs a test that goes red:

- `orchestrator.ts:7577`: the nested-redaction test at `orchestrator.test.ts:8581` stays green
  with `const redacted = report;` because `judge.ts:342-343` already redacted. Drive the auth-skip
  path (`:7598`, summary from `auth.claudeDetail` at `:7610`) with a secret-shaped detail and
  assert `results/judge.json` and `verdict.md` carry `[REDACTED:` and not the token.
- `orchestrator.ts:7568`: all seven T17 tests stay green with the in-memory
  `#judgeReports.delete` removed. Test the `#finish` requeue branch (`:8864-8877`, which returns
  before the map delete at `:8921`): fail the next attempt's build and assert the verdict reads
  "code-reading judge did not run: no report was recorded".
- Confirm each new test goes red under the named mutation, then green after restore. Quote the
  assertion message in your report.

**T16b. One source for the timeout reason.**

`orchestrator.ts:1887` and `:1898` both write the literal "no owner choice arrived before the
timeout"; `design-lock.tsx:182` and `:465` classify by `includes("before the timeout")`;
`design-lock.browser.spec.ts:358` pins only the reader. Rewording the writers leaves 53 tests
green. Export one `DIRECTION_TIMEOUT_REASON`, use it at both writers and both readers, and add a
writer-side test that pins the persisted `chosenDirectionReason`. In the same task, treat an
undefined `chosenDirectionReason` like null at `design-lock.tsx:532` and
`cron/cron-report.ts:113`, so a newer client on an older API does not quote the mockup-lock
reason as the direction reason.

**T18b. The API preview route refuses the same internal paths.**

`dashboard/server/src/code-files.ts:732` `resolvePreviewTarget` is a separate resolver from the
static server. Measured on 4176 today: `/api/runs/<clinic-id>/preview/TICKET.md`,
`/preview/design-refs/manifest.json` and `/preview/visible-acceptance/booking-wizard.spec.mjs`
all return 200; the same three are 404 on 4321. Apply the static server's policy (dot segments
and `STATIC_INTERNAL_ROOTS`, case-insensitive, checked again after realpath) with a new
`PreviewOwnRefusalCode` `"path_internal"` (`api-types.ts:2927`), placed after
`resolveWorkspacePath` returns ok so the owner's code browser keeps listing those files
(`code-files.test.ts:225`, `:255-260`, `:324` must stay green). GET only; HEAD already falls to
the generic 404 at `http.ts:3380`.

Also in T18b: the case-insensitive deny in `bakeoff/src/tier0.ts` passes vacuously on a
case-sensitive host, which is where the sealed gate actually runs (`scorer-container.ts:402`,
`docker/scorer.Dockerfile:127`), because `statSync` fails at `tier0.ts:1338` before the rule is
exercised. Export `isInternalStaticPath` from `tier0.ts:1277` and add a fixture root whose
on-disk case differs from the deny entry (`Tests/x.txt`, `Ticket.md`) so the rule goes red on
Linux.

## Rules

Everything in `docs/CODEX-BRIEF-wave2.md` still applies: negative control on every check,
verify never relay, golden hash before any prompt change, no metered calls, no restart of the
API on 4176, no pipeline run, G3 never. One change per commit, bare `type: summary`, 60
characters, no dash punctuation, no AI attribution.

The review found that three of your reported negative controls passed because a mutation upstream
had already done the work the test attributed to the code under test. Before reporting any
control as red, confirm the assertion message names the mutated behaviour, not a neighbour.

## Report back

After T18b: per task, the change, the mutation, the assertion message when red, the commands
with output, and the commit hashes. Then stop. Batch 2B starts after the owner reads that
report and restarts the API.
