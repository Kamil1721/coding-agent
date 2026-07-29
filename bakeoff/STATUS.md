# STATUS — what actually works, what does not, what to do before spending

Written by the integrator on 2026-07-27, after wiring five independently-built
modules together and running the pipeline end to end.

**Both section-1 blockers are RESOLVED as of 2026-07-27 (owner decisions D1 and
D2) and each is proved by execution; section 1 now records what was decided, why,
and what residual risk each fix leaves. Read it before anything else — one of
these defects would have presented in the final report as "every model failed".
The scorer image was rebuilt for both fixes, so its digest moved. IT HAS MOVED
AGAIN SINCE: `sha256:c7f5e1a4…` before 2026-07-27, `sha256:1c06aa11…` on
2026-07-27, and `sha256:bcd01771…` on 2026-07-29 when the QUALITY-gate fix landed
in `scorer-container.ts` / `scorer-protocol.ts`. **Every digest written into this
file is a dated record of what ran, never a statement about what is installed
now — including the ones below, which still say `1c06aa11…` because that is the
image those measurements were taken on.** The dated chain, and what each move
means for the calibration records, is in `dashboard/STATUS.md` §1.3.
RE-RESOLVE IT YOURSELF with `docker image inspect bakeoff-scorer:1 --format
'{{.Id}}'` immediately before the campaign, pin that value, and do not rebuild
again: the digest is held-constant variable 3, and score records taken either
side of a move are not comparable with each other.**

Nothing in this file is aspirational. Where something is untested, it says so.

---

## 1. BLOCKERS — the campaign must not start until these are decided

### 1.1 RESOLVED — `node --test` now runs as a second pass in the sealed scorer

**Status: fixed on 2026-07-27 by owner decision (a), and confirmed by execution.
The dry run is GREEN.** The account below is kept because it is the reasoning
that produced the fix, not history to be deleted. What changed:

1. **`docker/playwright.config.mjs` now pins `testMatch: "**/*.spec.mjs"`.**
   Playwright no longer collects the node:test half. Measured against the
   fixture: Playwright collects **1** spec (`ui.spec.mjs`) from a suite that also
   contains `api.test.mjs`.
2. **`src/scorer-container.ts` runs a second pass:**
   `node --test --test-concurrency=1` over the frozen `*.test.mjs` files, **named
   explicitly** (a directory argument would make "what ran" a property of node's
   own globs), reported through `docker/node-test-reporter.mjs` to
   `--test-reporter-destination=/scorer/out/node-test-report.ndjson`, with `spec`
   to stdout for a triageable tail. Its outcomes are merged with Playwright's
   into ONE outcome set, and `attributeCriteria` applies the **unchanged** REQ
   token rule to that merged set.
   node:test runs first and Playwright gets the remainder of the suite budget.
3. **Why that reporter.** Node ships no structured reporter (`spec|tap|dot|junit|lcov`).
   `tap` expresses sub-tests as indentation and escapes test names into the line,
   so an ancestor title path has to be re-derived from whitespace and un-escaped —
   every step of which can mis-attribute a title to the wrong REQ. `junit` is XML
   and Node ships no parser. The custom reporter consumes the event stream
   (`data.name`, `data.nesting`, `data.file`, `data.details.type`, `data.skip`,
   plus an authoritative per-file `test:summary`) and emits NDJSON, so the parse
   is `JSON.parse` per line. It lives in the IMAGE, like `playwright.config.mjs`,
   so artefact-side reporter tampering patches something never loaded.
4. **A frozen file that NEITHER runner collects is a loud, named failure** — the
   BLOCKING `GATE:suite-green` fails AND the file is listed in
   `infrastructureErrors` so the host reads it as a scorer fault rather than a
   model result. Both are needed: `infrastructureErrors` alone surfaces only as
   `QUALITY:scorer_infrastructure`, and QUALITY never gates. This covers a
   suffix no runner claims, an import that does not resolve, and a file with no
   tests in it — the three ways "collected nothing" used to look like "the model
   failed".
5. **Both runners always run; a pass with no files is not a failure.** The
   MERGED report must contain at least one test, and both exit codes must be 0.
6. **A skipped test is not evidence, under either runner.** Playwright sets
   `spec.ok` on a skipped spec and node reports a skipped test as a pass; both
   are now rejected explicitly. This is the one change here that goes beyond the
   stated task, so it was exercised rather than reasoned: a criterion asserted
   only by a `test.skip` Playwright spec comes back `failed`, not `passed`.
   The bad-test audit already rejects `.skip` before the freeze; this is the
   runtime backstop for a suite that somehow carries one.
7. **`APP_BASE_URL` is set alongside `BAKEOFF_APP_ORIGIN`** for both passes. The
   spec seat is told to read the base URL from an environment variable, and every
   node:test fixture in this tree uses that name; nothing was plumbing it, so a
   node:test suite could only ever have reached an app on the hardcoded default
   port. Proved with a fixture app on **4173** and a test with no default.
8. **The scorer image was rebuilt.** Held-constant variable 3 is now
   `sha256:1c06aa11c425044af4a5dc8cd0b3ff6b7f78e185fd54204c0a8fd810d8074353`
   (`linux/arm64`, `--provenance=false --sbom=false`, identical across two
   consecutive builds), recorded in `docker/README.md` §2.2. Stage 1 of the
   Dockerfile compiles `src/`, so **any** source edit moves it: it moved from
   `sha256:bc20df9e…` for a one-line comment change during this very fix.
   **Blocker 1.2's static-artefact change has since landed and is included in
   the digest above** — verified by running `startStaticServer` out of
   `/opt/bakeoff-scorer/dist/tier0.js` inside that image, and by
   `test/scorer-modes.e2e.mjs` scoring three artefacts against it.
   Re-resolve and re-record it immediately before the campaign starts, never
   during one. Prose files (`STATUS.md`, both READMEs) are never `COPY`ed into
   any layer, so editing this file does not move it.

Observed, against a fixture whose criteria are one node:test PASS, one node:test
FAIL, one Playwright PASS and one criterion no test mentions:

```
REQ-001 -> passed      1 test(s) asserted this criterion and all passed
REQ-002 -> failed      1 of 1 asserting test(s) failed:
                       holdout/api.test.mjs › greeting api › [REQ-002] T-2 … [failed]
REQ-003 -> passed      1 test(s) asserted this criterion and all passed
REQ-004 -> unasserted  no test … carries the token "REQ-004" … For triage: the merged
                       outcome set holds 3 test(s): 1 from Playwright, 2 from node:test
suiteExecution: {"testsTotal":3,"testsPassed":2,"testsFailed":1,"reportProblem":null}
GATE:suite-green: fail — node-test: 1 file(s), exit 1, 1/2 passed |
                         playwright: 1 file(s), exit 0, 1/1 passed
```

REQ-002 comes back **`failed`, not `unasserted` and not `passed`** — the negative
control that separates "attribution works" from "everything marks passed".

And with two uncollectable files planted (`holdout/helpers.mjs`, a suffix no
runner claims, and `holdout/broken.test.mjs`, whose import does not resolve):

```
GATE:suite-green = fail
infrastructureErrors:
  2 frozen suite file(s) were collected by NEITHER runner and therefore asserted
  NOTHING: holdout/broken.test.mjs (handed to node --test and never reported back
  …); holdout/helpers.mjs (matches neither ".test.mjs" nor ".spec.mjs", so no
  runner claims it). THIS IS A SCORER FAULT, NOT A MODEL RESULT …
```

---

**The original account, which remains the reason the fix looks the way it does:**

The scorer container (`src/scorer-container.ts`) invokes exactly one test
runner:

```
node ${SCORER_HOME}/node_modules/@playwright/test/cli.js test --config=...
```

There is no `node --test` invocation anywhere in the container. Consequences:

- A criterion whose only evidence is a `*.test.mjs` file **can never pass**. The
  scorer reports it as `unasserted`, which fails.
- `assertSuiteUsable` and the bad-test audit both happily accept such a suite,
  so nothing upstream catches it.
- Both `spec-types.ts` (`RUNNER_SUFFIX["node-test"]`) and the spec agent's own
  prompts actively instruct the spec seat to author `node-test` files.

Measured in the dry run: a suite with two node:test criteria and one Playwright
criterion scored `heldOutPass: false`, with

```
FAILED REQ-002 :: no test in the frozen suite carries the token "REQ-002"
                  in its title path.
```

while the artefact was correct and the Playwright criterion passed.

**Why this is expensive.** It does not error. It produces a complete, plausible
`ScoreRecord` with `heldOutPass: false` and `falseFinish: true`. Across 5
configs x 6 tickets it yields a uniform ~0% held-out pass and a ~100% false
finish rate, which reads as "every model shipped broken apps" and is in fact the
harness failing to run half its own suite.

**It is worse than "a runner is missing": the wrong runner is collecting the
files.** Playwright's default `testMatch` is
`**/*.@(spec|test).?(c|m)[jt]s?(x)`, which matches `*.test.mjs`. So the
node:test files *are* collected — by Playwright, where an imported `node:test`
`test()` means nothing. They emit output (the dry run showed `✔ T-1`, `✔ T-2`)
but produce no attributable outcome, which is why the failure reads as
"unasserted criterion" rather than as a missing runner.

**Owner decision required.** Either:

- (a) add a `node --test` pass in the container with a machine-readable reporter
  (`--test-reporter=tap` or the JSON reporter to an explicit `outputFile`),
  merge its outcomes with Playwright's, **and narrow the `testMatch` in
  `docker/playwright.config.mjs` to `*.spec.mjs`** so the two runners stop
  fighting over the same files — then rebuild the scorer image. Note the rebuild
  moves the image digest, which is held-constant variable 3, so it must happen
  before any scoring; or
- (b) constrain the spec seat to Playwright-only suites and remove `node-test`
  from `TEST_RUNNERS`, accepting that API/logic criteria must be asserted
  through a browser context.

(a) is the better answer. (b) is cheaper and is defensible for six web tickets.

**DECIDED: (a). Implemented, executed and recorded at the top of this section.**
One deviation from the wording above, and it is deliberate: neither `tap` nor a
"JSON reporter" was used, because **Node ships no JSON reporter** and `tap`
carries sub-test structure in indentation and escapes test names. The image now
carries `docker/node-test-reporter.mjs`, which emits NDJSON straight from the
reporter event stream. Reasoning in item 3 above.

### 1.2 RESOLVED — a static artefact is served by the scorer and scores normally

**Status: fixed on 2026-07-27 by owner decision D2, and confirmed by execution.**
What changed:

- `execution.start`, `port`, `healthPath`, `bootTimeoutMs` and
  `commandTimeoutMs` are now `T | null`. `start === null` selects **static
  mode**; a `start` with no `port`/`healthPath` is rejected, because a start
  command with nothing to probe is a boot gate that cannot decide anything.
- In static mode the scorer serves `/artifact` itself over
  `http://127.0.0.1:3000` with a dependency-free `node:http` server compiled
  into the image (`startStaticServer` in `src/tier0.ts`). Nothing is fetched at
  scoring time; egress is still denied. No SPA fallback: a 404 stays a 404.
- `GATE:boot` keeps its id in both modes and can **never** report
  `not_applicable` (which `gateToCriterion` would map to `passed: true`). In
  static mode it asserts the root document answers **HTTP 200 with a non-empty
  body** — stricter than the server-mode probe, which accepts anything below
  500. A blank page is not a pass.
- The manifest is now parsed by `parseSuiteManifest` at **authoring** time as
  well (`src/spec-validate.ts`), so a suite the container could not execute is
  regenerated instead of frozen. This closes the other half of §6 item 3: the
  path allowlist made the file authorable, but nothing checked its contents
  until scoring.
- The authoring prompt now documents both modes and names static as the common
  case. The **builder prompt** now says plain HTML/CSS is a complete answer and
  to put `index.html` at the workspace root — a change to **held-constant
  variable 2**, made before any run, recorded here and written per run to
  `<resultsDir>/sandbox/prompt.txt`.

Proved by execution — `node test/scorer-modes.e2e.mjs`, 29 checks, against
scorer image `sha256:1c06aa11…` in real `--network=none` containers:

```
static  GATE:boot pass — "/ answered HTTP 200 with 543 non-blank byte(s) after 13 ms"
        heldOutPass=true  falseFinish=false   suite 4/4
server  GATE:boot pass — "http://127.0.0.1:3000/health answered HTTP 200 after 520 ms"
        heldOutPass=true  falseFinish=false   suite 4/4
blank   GATE:boot FAIL — "answered HTTP 200 with an empty body (8 byte(s)).
                          A blank document is not a pass."
        heldOutPass=false falseFinish=true    ← the negative control
```

**Residual, and it is a real one.** The mode is chosen from ticket text before
the builder exists, so a mismatch is still possible in both directions: a static
manifest against a builder that ships a server, or a server manifest against a
builder that ships static. Both fail `GATE:boot` for a guess, not for ability.
The concrete trigger to watch for is **an entry document that lands in `dist/`,
`build/`, `out/`, `public/` or `_site/` instead of at the artefact root** — the
static server serves the root and does not infer a document root, deliberately
(inferring one is the same class of silent degradation as an SPA fallback).
Review T1's and T2's manifests against this before the campaign.

**The original account, which remains the reason the fix looks the way it does:**

`parseSuiteManifest` (`src/scorer-protocol.ts`) required
`execution.start`, `execution.port`, `execution.healthPath`,
`execution.bootTimeoutMs` and `execution.commandTimeoutMs`. None was nullable.
`target` must be `"web"` or `"native"`, and `"native"` throws
`not implemented`.

**T1 (photographer portfolio) and T2 (grooming one-pager) are static marketing
pages.** A builder may reasonably ship plain HTML/CSS with no server at all. The
spec seat, authoring from ticket text alone before any implementation exists,
has no server to declare — and cannot know whether one will exist.

Egress is denied at scoring time, so the container cannot fetch a static server
at scoring time either; anything used to serve a static artefact must be baked
into the scorer image.

The decision was: make the fields nullable and add a pre-baked static-file
serving path to the scorer. It moves the image digest, which is why it had to
happen before any scoring.

**Severity narrowed by the dry run.** A workaround exists and was demonstrated:
a builder that ships a static page *plus* a ~20-line dependency-free
`server.mjs` satisfies the manifest, and the sealed container booted it and
served it over loopback with egress denied. So this is **not** "static tickets
cannot be scored". It is: *the spec seat must author a manifest that presumes a
server, and the builder prompt must tell the builder to provide one.* If the
prompt does not say so, a builder that ships correct static HTML fails a
BLOCKING boot gate for a reason that has nothing to do with its ability.

That workaround is no longer needed, but the reasoning is why the builder prompt
now names the simple case explicitly rather than leaving it implied.

### 1.4 RESOLVED — an authored suite's test titles carried no REQ-id, so every criterion scored `unasserted`

**Found by EXECUTION on 2026-07-27, not by review, while wiring the local
dashboard onto this harness. Fixed the same day. It is the same class as 1.1
and would have produced the same headline: "every model shipped broken apps."**

What was measured. A suite authored by the real spec seat (Opus-class, `xhigh`)
from a three-bullet static-page ticket, audited, frozen, built against, and
scored in the sealed container:

```
GATE:build/typecheck/lint    not_applicable   (static manifest)
GATE:boot                    pass             static mode, HTTP 200, 543 bytes
GATE:routes                  pass             1 declared route answered non-5xx
GATE:screenshots-present     pass             3 usable of 3 captured
GATE:no-stub-markers         pass
GATE:no-reward-hack-exploits pass
GATE:suite-green             pass             24 of 24 test(s) passed
REQ-001 .. REQ-012           ALL unasserted   heldOutPass=false falseFinish=true
```

Every gate green, every test green, every criterion failed.

**Cause.** `attributeCriteria` (`src/scorer-container.ts`) attributes a
criterion to a test by finding the criterion's **REQ-id in the test's title
path**, and nothing else. `AUTHORING_SYSTEM_PROMPT` told the spec seat the
opposite: *"Every test's name STARTS with its test id: `test("T-14 ...")`"* —
**T**-ids, never REQ-ids. The seat complied exactly. Every authored title
therefore carried a T-id and no REQ-id, and every criterion came back
`unasserted`, which fails.

**Why nothing caught it.** The dry run's canned draft (`dryRunDraft` in
`src/dryrun.ts`) writes `test("[REQ-001] T-1 ...")`, hand-matched to the scorer.
The spec-agent smoke test's fixture wrote `test("T-1 ...")`, matching the
prompt. So the two halves of the tree each tested a different convention and
both passed. Nothing compared a *model-authored* suite against the *scorer's*
attribution rule until one actually ran.

**Fixed in two places, because a prompt instruction is not sufficient — this
tree's own standard:**

1. `AUTHORING_SYSTEM_PROMPT` now requires the REQ-ids in the title
   (`test("[REQ-004] T-14 ...")`), states that a `describe()` title counts, and
   says plainly what happens otherwise: *"A suite whose titles carry only T-ids
   scores zero with every test green."*
2. **`deterministicAudit` now enforces it.** For every draft test file, every id
   in `criterionIds` must appear in a `test`/`it`/`describe` TITLE literal in
   that file's source, matched with the **same** boundary regex the scorer uses
   (`criterionTokenIn` in `src/spec-validate.ts` copies it deliberately — two
   different notions of "carries the token" would pass a suite the scorer scores
   as unasserted). The finding is `mustRegenerate`, so such a suite is
   re-authored rather than frozen.

Exercised, not just reasoned: `test/spec-agent.smoke.mjs` is now **107**
assertions, including a negative control (strip the REQ-ids from a clean draft's
titles → blocking finding) and a positive one (a `describe()` wrapper satisfies
it). The reference fixture was updated to the correct convention — it is the
same fixture that would have scored zero.

**No image rebuild.** `spec-agent.ts` and `spec-validate.ts` run host-side; the
scorer container only executes tests. Held-constant variable 3 is unmoved and
`sha256:1c06aa11…` remains valid. `npm run bakeoff -- dry-run` is still green
against it, and `test/scorer-modes.e2e.mjs` is still 29/29.

**`authoringPromptSha256` has moved again.** Harmless for the same reason D2 was
harmless — no campaign suite has been authored yet. Author every suite after
this change, not before.

### 1.3 Config E cannot run — ONE reason now, not two

1. ~~**Unpriced.**~~ **CLEARED 2026-07-27 by owner decision D3.** `PRICE_TABLE`
   carries verified per-MTok prices for `openai/gpt-5.6-luna` ($1.00 input /
   $0.10 cache read / $6.00 output, cache write at 1.25x input), plus
   `gpt-5.6-sol` and `gpt-5.6-terra` so neither can be added later unpriced,
   i.e. uncapped. `preflight` no longer reports `unpriced_model` for any seat.
   Provenance is split by field in the entry's own `notes`: input, cache read
   and output are double-confirmed in
   `docs/research/01-verification-corrections.md`; the 1.25x **write** rate is
   not in that summary line and rests on D3's live check of the pricing page.
   **Follow-on exposure, recorded in `src/adapters.ts`:** OpenAI reports no
   cache-write count, so the adapter records `cacheWriteTokens: 0` and costs
   those tokens at the 1.00x input rate. Now that the model is priced, that
   understates the bill by 25% of whatever share of a run is cache writes.
   Check one real response for a write field before config E ever runs.
2. **Wrong wire protocol.** OpenAI does not speak the Anthropic Messages API,
   which is the only protocol the budget proxy implements. `proxy.ts` refuses
   the seat with `not_implemented`. A translator would be a second harness, and
   the harness is held-constant variable 2. **This still blocks config E**, as
   does the fact that the API model id `gpt-5.6-luna` is a display name that
   has never been confirmed against the vendor's model list.

`screen` over all five configs therefore still **refuses to start**. That
refusal is correct and is the first thing you will see. Run four arms
deliberately (`--configs A,B,C,D`) and record in the write-up that the matrix
was reduced.

---

## 2. What is implemented AND tested

Tested means: executed in this environment, in this session, with the result
observed — not reviewed.

| Area | Evidence |
|---|---|
| Typecheck | `npx tsc --noEmit` exits 0 across the whole tree |
| Ticket freeze + drift detection | `node test/tickets.smoke.mjs` — 45 assertions |
| Spec authoring, 28-check bad-test audit, freeze, 4 tamper modes | `node test/spec-agent.smoke.mjs` — 105 assertions |
| Ledger, pre-call ceiling, per-vendor usage, adapters | `node test/ledger.smoke.mjs` — 104 assertions |
| Statistics, aggregation, decision rule, report rendering | `npm test` — 32 tests |
| **Sealed gate over a STATIC artefact, a SERVER artefact and a blank page** | `node test/scorer-modes.e2e.mjs` — 29 checks, real `--network=none` containers (see 1.2) |
| **Whole pipeline, stages 1-5** | `npm run bakeoff -- dry-run` (see section 3) |

Specifically proved by the dry run, against real containers:

- **Egress is denied**, verified from *inside* the build container on that run:
  `http 1.1.1.1 unreachable; https registry.npmjs.org unreachable`.
- **The only route out is that run's own budget proxy**, and it answers `401` to
  an unauthenticated probe carrying the proxy's identity header.
- **The hard ceiling is checked BEFORE the call.** A request whose worst case
  breached the ceiling returned `403` and the stub upstream's call counter did
  **not move**. This is the check that distinguishes a real ceiling from a
  post-hoc one.
- **A vendor payload that cannot be priced kills the run** rather than being
  recorded as $0. (Anthropic reports cache-write tokens without a 5m/1h split;
  the two rates differ; the adapter refuses to guess.)
- **`agentDeclaredDone` comes from `.bakeoff/self-report.json`**, a structured
  two-field JSON file. No prose is parsed anywhere.
- **The freeze detects a one-byte edit** to a held-out test file.
- **The sealed gate runs `--network=none` from an image pinned by content
  digest**, and re-resolves that digest on every score.
- **The visible half reaches the workspace; the held-out half does not.**

---

## 3. The dry run — GREEN as of the 1.1 fix

```
npm run bakeoff -- dry-run
```

Runs the entire pipeline for $0. Stubs exactly three things: the model
responses, the builder binary, and the spec seat's authoring call. Everything
else is the real code path — the real proxy, ceiling, freeze, audit, sealed
build container, `--network=none` gate, aggregation and decision rule.

**It was RED for a real reason, and that reason is blocker 1.1.** The check that
failed was:

```
FAIL  the gate PASSES an honest artefact (a gate that can never pass is not a gate)
```

It now passes, executed 2026-07-27 against the rebuilt scorer image:

```
PASS  the gate PASSES an honest artefact (a gate that can never pass is not a gate)
      heldOutPass=true, falseFinish=false on a correct artefact
GATE:suite-green: pass | 4 of 4 test(s) passed in 952 ms —
                  node-test: 2 file(s), exit 0, 3/3 passed |
                  playwright: 1 file(s), exit 0, 1/1 passed
REQ-001 -> passed  (asserted by 2 node:test files AND 1 Playwright spec)
REQ-002 -> passed  (asserted by node:test alone — impossible before the fix)
```

The dry run did its job: it caught, for $0, a defect that would otherwise have
been discovered after the campaign.

Do not "fix" the dry run by deleting that assertion. It is the assertion that
makes the other twenty-odd meaningful — a gate that fails every artefact is
indistinguishable, in the final report, from five models that all failed.

`--no-docker` runs stages 1, 2 and 5 only and **leaves the seal unproved**.

---

## 4. Implemented but UNTESTED — no credentials exist in this environment

Nothing below has ever executed against a vendor. It typechecks and it is
reviewed; that is all. **Do not describe any of it as working.**

- **Every real API call.** `src/anthropic-seat.ts`, and the whole upstream half
  of `src/proxy.ts`. The proxy has only ever spoken to a local stub.
- **The spec agent's authoring and audit calls.** The deterministic half of the
  audit is heavily tested; the model-call half is not. The spec-agent author
  flagged one combination as unverifiable without a key:
  `output_config.format` + `thinking: {type: "adaptive"}` + `stream`. If every
  authoring call returns HTTP 400, the escape hatch is
  `structuredOutput: false`, which is named in the 400's remediation text.
- **Every non-Anthropic vendor.** Moonshot and DeepSeek usage-payload shapes are
  implemented from documentation and have never seen a real response. They throw
  `invalid_usage_shape` (naming keys, never values) rather than recording an
  unreported field as 0 — so a shape surprise costs a run, not a wrong number.
- **The DeepSeek model-substitution guard.** Doc 03 §6.4 records that DeepSeek's
  Anthropic-format endpoint maps `claude-sonnet*` to **deepseek-v4-flash**, and
  config B is only meaningful on **v4-pro**. The proxy rewrites `model` and
  asserts the response agrees. Verified against a stub that echoes the model
  back; never against DeepSeek.
- **`DEFAULT_BUILDER_COMMAND`.** Its flags were read from `claude --help` on the
  **host** CLI 2.1.220, not from the pinned sandbox image. `modelAliasFor`
  (`claude-opus-4-5`, `claude-sonnet-4-5`) has never been checked against a real
  Claude Code client. **Re-verify before the first dollar** — a wrong alias
  silently measures a different model.
- **The Claude Code CLI as builder.** The dry run substitutes a node script. The
  real CLI has never run inside the sandbox image here.

---

## 5. Environment-specific and unexercised

- **`host.docker.internal` + loopback binding is verified on Docker
  Desktop/macOS only.** On native Linux, `host-gateway` resolves to the docker0
  address, which a 127.0.0.1-bound proxy will not answer. Commented in
  `src/runner.ts`. Do not "fix" it by binding `0.0.0.0`.
- **Only `linux/arm64` has been exercised.** The scorer image's `linux/amd64`
  layer is built but unrun.
- **`.gitignore` had never been exercised before this session** — this directory
  is not a git repository. It is now verified in a throwaway repo: `.env`,
  `.env.local`, everything under `acceptance/`, `results/raw/`,
  `results/screenshots/` and `dry-run/` are ignored, while `.env.example`,
  `results/scores/`, `results/tamper/` and `results/REPORT.md` remain tracked.
- **The scorer's Python scanner branches and the `http` data-expectation kind**
  are implemented and never executed.
- **`target: "native"`** throws `not implemented` by design.
- **`GATE:typecheck` and `GATE:lint` run artefact-resolved binaries.** A patched
  `node_modules/typescript` defeats them. Deliberate: pinning a scorer-side
  TypeScript would fail honest artefacts more often than it catches dishonest
  ones, and `build`/`boot`/`suite-green` are all downstream of real execution.

---

## 6. What I changed while integrating, and why it matters

These were cross-module contradictions. All of them typechecked cleanly, which
is why none was caught before the modules were run together.

1. **The sealed-suite path had three different spellings.** The spec agent wrote
   to `acceptance/generated/<id>/FROZEN.json`; the campaign looked in
   `acceptance/<id>/FROZEN.json`; the scorer looked for the test files one
   directory level above where the freeze puts them. `freeze` would have
   reported six tickets BLOCKED with the suites on disk, and the first real
   `score` would have raised `suite_hash_mismatch` — a **tampering** verdict —
   against an untampered suite. All four consumers now derive paths from
   `spec-freeze`/`spec-types`.
2. **The campaign's default suite root fell outside `.gitignore`.** One flag and
   every held-out test file lands in a committed path. `acceptance/` is now
   ignored wholesale, verified.
3. **No suite could contain the file the scorer requires.** The scorer refuses
   any suite whose freeze lacks `suite.manifest.json`; the authoring validator
   required every path to be `<holdout|visible>/<name>.{test,spec}.mjs`. No
   string satisfied both. `pathProblems` now allowlists that one exact path
   (verified exact: `x/suite.manifest.json` and `suite.manifest.jsonx` are still
   rejected), and `assertSuiteManifestPathAgrees` fails loudly if the two
   spellings ever drift.
4. **The scorer flagged the harness's own visible-half copy as tampering.** The
   runner deliberately copies the visible suite into the workspace; the scorer
   matched it by digest and raised a BLOCKING protected-path violation. Effect:
   `heldOutPass: false` and `falseFinish: true` on **every run of every
   configuration** — the whole ~$2,100 campaign spent measuring a harness bug.
   Only held-out files are protected content now.
5. **`score` never scored.** It validated the gate seam and returned. Nothing
   turned run records into score records, so the co-primary metrics could not be
   produced at all. Added `src/score-run.ts` and wired it in.
6. **No module exported `createGate`**, so `--gate` could never be satisfied.
   Added `src/gate.ts`, constructing the real `SealedScorerGate`. The seam also
   required a synchronous factory, which forced a gate to either lie about the
   image digest or not check it; it is now awaited.
7. **`src/runner.ts` contained a raw NUL byte** (an argv separator written
   literally). `git`, `grep` and most editors treated the file as binary — it
   was invisible to the seal audit until fixed. The digest is unchanged.
8. **Key-shaped literals in test fixtures** were replaced with runtime-assembled
   equivalents. Same values, same assertions, no credential shape anywhere in
   the tree.

---

## 7. Secrets — audited

- No key-shaped literal exists anywhere in the tree (checked for `sk-ant-*`,
  `sk-*`, `ghp_*`, `AKIA*`, JWTs, PEM headers).
- `.env.example` contains variable **names** with empty values only.
- `.env` and `.env.*` (except `.env.example`) are gitignored — verified.
- Credentials are read by environment-variable **name**, at run time, and never
  written to disk. The real key never enters the sandbox: the builder holds a
  random per-run token and the proxy substitutes the real credential.
- Every persistence path routes through `redactForPersistence`. Container stdout
  goes through a `ReassemblingRedactor`, so a credential split across two reads
  still matches. The report additionally calls `assertRedacted` and **refuses to
  write** if anything still matches.
- Frozen suite bytes are deliberately **not** rewritten by the redactor — that
  would break the freeze digest permanently. The manifest is `assertRedacted`
  instead, i.e. it refuses to freeze rather than silently altering.
- The dry run replaces every vendor credential with a non-secret placeholder, so
  a dry run launched from a shell holding a live key never hands that key to the
  stub.

One residual, by design: **screenshot masking is applied at capture time and is
the only masking there is.** A secret rendered by a selector nobody anticipated
is in the pixels permanently. `results/screenshots/` is gitignored.

---

## 8. Before the first real run — checklist

1. ~~Decide blocker 1.1 and blocker 1.2.~~ **Both decided and fixed
   (D1, D2), and the scorer image rebuilt for both.** Re-resolve the digest with
   `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'`, pin that value,
   and do not rebuild until the campaign finishes. The last build of this tree
   resolved to `sha256:1c06aa11…`, and both `dry-run` and
   `test/scorer-modes.e2e.mjs` were green against it.
2. Re-verify `DEFAULT_BUILDER_COMMAND` flags and `modelAliasFor` against the
   Claude Code CLI **in the pinned sandbox image**.
3. Replace the six reference tickets in `tickets/` with your own, then
   `rm tickets/FROZEN.json` and re-freeze. The shipped briefs are
   harness-authored reference material, not your tickets.
4. **Confirm every price in `PRICE_TABLE` on the vendor's own pricing page.**
   They were sourced from a secondary retrieval. Moonshot's cache-write rate is
   an explicit assumption; the report states when that assumption decides the
   verdict. The three OpenAI entries added by D3 carry a per-field provenance
   note: input/cacheRead/output are double-confirmed, the 1.25x cache-WRITE rate
   is single-sourced to D3's live check — re-confirm that line specifically.
5. Build the scorer image with `--provenance=false --sbom=false` (without them
   BuildKit's attestation moves the digest on every rebuild from an identical
   context, and the digest in every `ScoreRecord` certifies nothing). Pin it by
   digest.
6. Run `npm run bakeoff -- dry-run` until it is **green**. It is currently red
   for a real reason.
7. Set credentials. Run `preflight`. Expect config E blocked; decide
   deliberately whether to proceed with four arms and record it.
